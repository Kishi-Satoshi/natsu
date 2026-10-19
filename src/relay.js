/*
 * relay.js — 文字起こしの中継（relay/。Cloudflare Workers）の住所と、アプリのログインの口（第1d回 RL9）
 *
 *  - RELAY_BASE      中継の住所（workers.dev。会社名を含まない名前: 問い Q7）
 *  - relayProvider   文字起こしの送り先の形 { id, label, base, host, reachUrl }。id は文字起こしをした相手の名前のまま 'openai'
 *                    （ページの route.stt.provider と「クラウド（OpenAI）」の行は今と同じ）。届くかは中継の GET /health で見る
 *  - makeAccountApi  ログインの口（start・verify・logout）。どれも投げない。
 *                    /auth/me は持たない（設定を開いただけで外へ通信しないため。ログインしているかは PC にしまった札で決める）
 *
 * 決まり:
 *  - Electron のモジュールは読み込まない。通信は呼ぶ側から request（本番は net.request）をもらう（RF2）。
 *    送り方は stt-cloud.postForm（redirect: 'error'・時間切れ・返事の大きさの上限）。
 *  - 札は Authorization: Bearer の見出しにだけ入れる（logout のとき）。URL・本文・ほかの見出し・答え・例外には入れない。
 *  - 中継の答えの符号は、中継の JSON の { error: '<符号>' } だけを読む（relayErrorCode）。中継の形でない答え
 *    （会社の通信の検査やログインの画面が返した HTML など）は 'server'。
 *  - HTTP の約束は計画 docs/plans/2026-10-19-1d.md の「受け渡す名前と形」（relay/ と同じ）。
 */
'use strict';

const { postForm, CloudSttError, relayErrorCode } = require('./stt-cloud');

// 中継の住所。**まだ仮の値**（2026-10-19 の時点で実機の 0a（会社の PC から workers.dev に届くか）が済んでおらず、
// 利用者の workers.dev のサブドメインが決まっていない）。'-unset-' は Cloudflare のサブドメインには付けられない形
// （頭と終わりが「-」）なので、だれの Worker にも届かず、どの PC でも名前が引けずに手元の文字起こしに落ちる
// （ほかの人の Worker へ音声と札を送らない）。実機の 0a で開いた住所（https://natsu-relay.<サブドメイン>.workers.dev）に
// 替えるまで 0.8.0 を出さない（計画「リリース手順」の 1）。
const RELAY_BASE = 'https://natsu-relay.-unset-.workers.dev';

const ACCOUNT_TIMEOUT_MS = 15000;
const TOKEN = /^nt1_[A-Za-z0-9_-]{43}$/;

function relayProvider() {
  return { id: 'openai', label: 'OpenAI', base: RELAY_BASE, host: new URL(RELAY_BASE).hostname, reachUrl: `${RELAY_BASE}/health` };
}

const posInt = (v) => (Number.isInteger(v) && v > 0 ? v : undefined);

/**
 * makeAccountApi({ request, base = RELAY_BASE, timeoutMs }) → {
 *   start(email)        → { ok: true } | { ok: false, code, retryAfter? }
 *   verify(email, code) → { ok: true, token, email, expiresAt } | { ok: false, code, left?, retryAfter? }
 *   logout(token)       → { ok: boolean }
 * }
 * code は中継の error の符号（bad-email・domain・rate・mail・mail-cap・not-ready・code・code-expired・blocked・bad-request・
 * too-large など）か、通信の符号（offline・cert・proxy・timeout・net）、中継の形でない答えなら 'server'、
 * 200 なのに形が違えば 'bad-reply'。
 */
function makeAccountApi({ request, base = RELAY_BASE, timeoutMs = ACCOUNT_TIMEOUT_MS } = {}) {
  async function send(path, { json, token } = {}) {
    const headers = {};
    let body = null;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = Buffer.from(JSON.stringify(json), 'utf8');
    }
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await postForm({ request, url: `${base}${path}`, headers, body, timeoutMs });
      let j = null;
      try { j = JSON.parse(res.body.toString('utf8')); } catch (_) { j = null; }
      if (!j || typeof j !== 'object' || Array.isArray(j)) j = null;
      return { status: res.status, j, code: relayErrorCode(res.body) };
    } catch (e) {
      return { status: 0, j: null, code: e instanceof CloudSttError ? e.code : 'net' };
    }
  }

  // 断りの答え → { ok: false, code, left?, retryAfter? }
  function refusal(r) {
    if (r.status === 0) return { ok: false, code: r.code };
    if (r.status >= 200 && r.status <= 299) return { ok: false, code: 'bad-reply' };
    if (!r.code) return { ok: false, code: 'server' };
    const out = { ok: false, code: r.code };
    if (Number.isInteger(r.j.left) && r.j.left >= 0) out.left = r.j.left;
    const ra = posInt(r.j.retryAfter);
    if (ra !== undefined) out.retryAfter = ra;
    return out;
  }

  return {
    async start(email) {
      const r = await send('/auth/start', { json: { email: String(email == null ? '' : email) } });
      if (r.status === 200 && r.j && r.j.ok === true) return { ok: true };
      return refusal(r);
    },
    async verify(email, code) {
      const r = await send('/auth/verify', { json: { email: String(email == null ? '' : email), code: String(code == null ? '' : code) } });
      if (r.status === 200 && r.j && r.j.ok === true) {
        const { token, email: e, expiresAt } = r.j;
        if (typeof token !== 'string' || !TOKEN.test(token) || typeof e !== 'string' || !Number.isInteger(expiresAt)) return { ok: false, code: 'bad-reply' };
        return { ok: true, token, email: e, expiresAt };
      }
      return refusal(r);
    },
    async logout(token) {
      const r = await send('/auth/logout', { token: String(token == null ? '' : token) });
      return { ok: r.status === 200 };
    },
  };
}

module.exports = { RELAY_BASE, relayProvider, makeAccountApi };
