/*
 * online.js — オンラインかの判定と、文字起こし・要約の経路の決め方（第1c回 OL1・OL4。RF26・RF27・RF28・C10）
 *
 *  - reachWhy       届かなかった理由を「証明書・プロキシ・届かない」に分ける（第0b回の classifyNetError を借りる）
 *  - makeOnline     net.isOnline() と、送り先の URL に軽く届くかの確かめ（結果を覚える）
 *  - decideStt      文字起こしをクラウドで行うか、手元の whisper で行うか
 *  - decideSummary  要約を利用者の Claude Code で行うか、手元の llama で行うか
 *
 * 決まり:
 *  - Electron のモジュールは読み込まない。通信は呼ぶ側から request（本番は net.request）を、
 *    判定は isOnline（本番は net.isOnline）をもらう。Node のグローバルの通信の関数は使わない（RF2）。
 *  - net.isOnline() について、Electron の資料
 *    （https://github.com/electron/electron/blob/44-x-y/docs/api/net.md）は「false はつながらない強い印、
 *    true は確かではない（つながっているとは限らない）」と言う。だから false なら送り先へ要求を出さずに
 *    「オフライン」とし（覚えもしない。戻ったらすぐ気づく）、true なら送り先の URL に GET を1つ出して確かめる。
 *    何かの HTTP の返事（401 でも 404 でも、転送でも）があれば届く。3 秒で返事が無ければ諦める。
 *  - 覚える長さ: 区間は 75 秒ごとなので、届いた結果（60 秒）は1区間に1回ほど確かめ直す。届かない結果は
 *    15 秒だけ覚え、回線が戻ったらすぐ次の区間からクラウドに戻る（RF27）。
 *  - 届かない理由は classifyNetError で分ける。Zscaler などが送り先を止めたとき、黙って手元に落ち続けずに
 *    理由（証明書・プロキシ）を知らせられるように（RF26）。
 *  - 経路の決め方は、会議の印（［この会議は PC の中だけ］）・同意・鍵の有無を、届くかの確かめより先に見る。
 *    同意していない会議・PC の中だけの会議では、届くかの確かめの要求さえ出さない（RF28）。
 *    知らない同意の値は「使わない」と同じに扱う（外へ送らない側に倒す）。
 *  - 要約は、PC の中だけのページなら届くかを確かめずに手元（C10。文字起こしの文も PC の外へ出さない）。
 *    それ以外は、届けば Claude Code、届かなければ手元（D1）。
 */
'use strict';

const { classifyNetError } = require('./engine-fetch');

const REACH_OK_MS = 60000;      // 届いた結果を覚える長さ
const REACH_NG_MS = 15000;      // 届かない結果を覚える長さ（すぐ戻ったときに早く気づく）
const REACH_TIMEOUT_MS = 3000;

const DOWN_WHYS = new Set(['offline', 'unreachable', 'cert', 'proxy']);

/** 通信の失敗 → 'cert' | 'proxy' | 'unreachable'（classifyNetError の cert・proxy／proxy-auth・ほか全部） */
function reachWhy(err) {
  const k = classifyNetError(err);
  if (k === 'cert') return 'cert';
  if (k === 'proxy' || k === 'proxy-auth') return 'proxy';
  return 'unreachable';
}

function makeOnline({ request, isOnline, now = Date.now, timeoutMs = REACH_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const cache = new Map();     // url → { res, until }
  const inflight = new Map();  // url → Promise（同じ送り先への確かめは1つにまとめる）

  const online = () => {
    try { return isOnline() !== false; } catch (_) { return true; } // 分からなければ確かめる側に倒す
  };

  // GET url を1つ出し、何かの返事が来たら届く。'error' か時間切れ（abort）なら届かない
  const probe = (url) => new Promise((resolve) => {
    let done = false; let timer = null; let req = null;
    const finish = (res) => {
      if (done) return;
      done = true;
      if (timer !== null) { clearTimer(timer); timer = null; }
      resolve(res);
    };
    try {
      req = request({ method: 'GET', url, redirect: 'manual' });
    } catch (e) {
      finish({ up: false, why: reachWhy(e) });
      return;
    }
    req.on('response', (res) => {
      // 本文は読み捨てる（流れを止めたままにしない）
      if (res && typeof res.on === 'function') { res.on('data', () => {}); res.on('error', () => {}); }
      if (res && typeof res.resume === 'function') res.resume();
      finish({ up: true, why: 'ok' });
    });
    // 転送も返事のうち（鍵は送っていないが、先へは追わない）
    req.on('redirect', () => { finish({ up: true, why: 'ok' }); try { req.abort(); } catch (_) { /* もう閉じた */ } });
    // 認証を求められても名乗らない（取り消すと、401 はそのまま返事として届く）
    req.on('login', (_info, cb) => { try { cb(); } catch (_) { /* 取り消し済み */ } });
    req.on('error', (e) => finish({ up: false, why: reachWhy(e) }));
    req.on('abort', () => finish({ up: false, why: 'unreachable' }));
    timer = setTimer(() => {
      timer = null;
      finish({ up: false, why: 'unreachable' });
      try { req.abort(); } catch (_) { /* もう閉じた */ }
    }, timeoutMs);
    try { req.end(); } catch (e) { finish({ up: false, why: reachWhy(e) }); }
  });

  async function isUp(url) {
    if (!online()) return { up: false, why: 'offline' };
    const hit = cache.get(url);
    if (hit && now() < hit.until) return { ...hit.res };
    let p = inflight.get(url);
    if (!p) {
      p = probe(url).then((res) => {
        if (inflight.get(url) === p) {
          inflight.delete(url);
          cache.set(url, { res, until: now() + (res.up ? REACH_OK_MS : REACH_NG_MS) });
        }
        return res;
      });
      inflight.set(url, p);
    }
    return { ...(await p) };
  }

  function forget(url) {
    cache.delete(url);
    inflight.delete(url);
  }

  return { isUp, forget };
}

const downWhy = (r) => (r && DOWN_WHYS.has(r.why) ? r.why : 'unreachable');

/**
 * 文字起こしの経路。consent: 'ask'|'on'|'off'。up は「要るときだけ」呼ぶ関数（() => Promise<{up, why}>）。
 * 順: localOnly → consent（'on' のほかは外へ送らない）→ hasKey → up()
 */
async function decideStt({ consent, localOnly, hasKey, up }) {
  if (localOnly) return { route: 'local', why: 'local-only' };
  if (consent !== 'on') return { route: 'local', why: consent === 'ask' ? 'consent-ask' : 'consent-off' };
  if (!hasKey) return { route: 'local', why: 'no-key' };
  const r = await up();
  if (r && r.up === true) return { route: 'cloud', why: 'ok' };
  return { route: 'local', why: downWhy(r) };
}

/** 要約の経路。順: localOnly（届くかを確かめずに手元: C10）→ up()（真なら Claude Code） */
async function decideSummary({ localOnly = false, up }) {
  if (localOnly) return { route: 'local', why: 'local-only' };
  const r = await up();
  if (r && r.up === true) return { route: 'claude-code', why: 'ok' };
  return { route: 'local', why: downWhy(r) };
}

module.exports = { REACH_OK_MS, REACH_NG_MS, REACH_TIMEOUT_MS, reachWhy, makeOnline, decideStt, decideSummary };
