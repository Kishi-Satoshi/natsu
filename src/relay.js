/*
 * relay.js — 文字起こしの中継（relay/。Cloudflare Workers）の住所と、アプリのログインの口（第1d回 RL9）
 *
 *  - RELAY_BASE      中継の住所（workers.dev。会社名を含まない名前: 問い Q7）
 *  - relayProvider   文字起こしの送り先の形 { id, label, base, host, reachUrl }。id は文字起こしをした相手の名前のまま 'openai'
 *                    （ページの route.stt.provider と「クラウド（OpenAI）」の行は今と同じ）。届くかは中継の GET /health で見る
 *  （前の自前のログインの口 makeAccountApi（start・verify・logout。確認コードと札）は第1d回 A-12 で消した。ログインは Cloudflare Access の窓）
 *  第1d回 A-10（RL9・F19・F21。Cloudflare Access のログイン）:
 *  - ACCESS_PARTITION  ログインの窓と中継への要求が使う session の partition（persist: を付けない = メモリの中だけ。cookie を
 *                    ディスクに平文で置かない。しまうのは safeStorage の secrets だけ: 計画「作り替え」の要約の 2）
 *  - LOGIN_URL・LOGOUT_URL  ログインの窓が読む中継の /auth/done・Access のログアウト（中継の住所の /cdn-cgi/access/logout）
 *  - isAccessHost・classifyAuth  stt-cloud.js と同じ関数（Access の答えの分け方。F19）
 *  - loginNavAllowed  ログインの窓が行ってよい所か（https の中継のホストか <チーム>.cloudflareaccess.com。窓の間は最初の Access のホストに留められる）
 *  - makeAccessApi    me()（cookie で GET /v1/me。ログインの直後の確かめと期限）。投げない
 *  - packCookies・unpackCookies  中継のホストちょうどの CF_Authorization（と CF_Binding）だけを、secrets にしまう文字にする・戻す
 *
 * 決まり:
 *  - Electron のモジュールは読み込まない。通信は呼ぶ側から request（本番は net.request）と session をもらう（RF2）。
 *    送り方は stt-cloud.postForm（Access の口は session・redirect: 'manual'。時間切れ・返事の大きさの上限）。
 *  - cookie の値は、記録・答え・例外に出さない（packCookies の文字は secrets.js（safeStorage）にだけしまう）。
 *  - 中継の答えの符号は、中継の JSON の { error: '<符号>' } だけを読む（relayErrorCode）。中継の形でない答え
 *    （会社の通信の検査やログインの画面が返した HTML など）は 'server'。
 *  - HTTP の約束は計画 docs/plans/2026-10-19-1d.md の「受け渡す名前と形」（relay/ と同じ）。
 */
'use strict';

const { postForm, CloudSttError, relayErrorCode, isAccessHost, classifyAuth } = require('./stt-cloud');

// 中継の住所（第1d回 A-10。利用者が、会社の PC から Zscaler を通って届くことを確かめた workers.dev の住所。会社名を含まない）。
// 仮の値のまま版を上げると test/relay-base.test.js が赤になる
const RELAY_BASE = 'https://natsu-relay.natsu-code.workers.dev';
const RELAY_HOST = new URL(RELAY_BASE).hostname;
const ACCESS_PARTITION = 'natsu-access';
const LOGIN_URL = `${RELAY_BASE}/auth/done`;
const LOGOUT_URL = `${RELAY_BASE}/cdn-cgi/access/logout`;

const ACCOUNT_TIMEOUT_MS = 15000;

function relayProvider() {
  return { id: 'openai', label: 'OpenAI', base: RELAY_BASE, host: new URL(RELAY_BASE).hostname, reachUrl: `${RELAY_BASE}/health` };
}

// ================= Cloudflare Access（第1d回 A-10） =================

/**
 * ログインの窓が行ってよい所か: https・既定のポート・名前とパスワードなしで、ホストが中継のホストちょうどか <チーム>.cloudflareaccess.com。
 * pinnedAccessHost を渡すと、Access のホストはそれだけ（窓が最初に着いた Access のホストに、その窓の間は留める）
 */
function loginNavAllowed(url, pinnedAccessHost = '') {
  let u;
  try { u = new URL(String(url)); } catch (_) { return false; }
  if (url == null || u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return false;
  const host = u.hostname.toLowerCase();
  if (host === RELAY_HOST) return true;
  if (!isAccessHost(host)) return false;
  return !pinnedAccessHost || host === String(pinnedAccessHost).toLowerCase();
}

const ME_EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

/**
 * makeAccessApi({ request, session, base = RELAY_BASE, timeoutMs }) → {
 *   me() → { ok: true, email, exp, via } | { ok: false, code }
 * }
 * cookie（session の partition）で GET {base}/v1/me を開く（redirect: 'manual'・X-Requested-With）。投げない。
 * code: classifyAuth の 'login'・'denied'・'server'（3xx・401・403）、中継の 503 not-ready → 'not-ready'、ほかの答え → 'server'、
 * 200 で形が違えば 'bad-reply'、届かなければ通信の符号（offline・cert・proxy・timeout・net）
 */
function makeAccessApi({ request, session, base = RELAY_BASE, timeoutMs = ACCOUNT_TIMEOUT_MS } = {}) {
  return {
    async me() {
      let res;
      try {
        res = await postForm({ request, session, method: 'GET', url: `${base}/v1/me`, redirect: 'manual', timeoutMs });
      } catch (e) {
        return { ok: false, code: e instanceof CloudSttError ? e.code : 'net' };
      }
      if (res.status === 200) {
        let j = null;
        try { j = JSON.parse(res.body.toString('utf8')); } catch (_) { j = null; }
        if (!j || typeof j !== 'object' || Array.isArray(j) || typeof j.email !== 'string' || !ME_EMAIL.test(j.email)
          || !Number.isInteger(j.exp) || (j.via !== 'hdr' && j.via !== 'cookie')) return { ok: false, code: 'bad-reply' };
        return { ok: true, email: j.email, exp: j.exp, via: j.via };
      }
      const auth = classifyAuth(res);
      if (auth) return { ok: false, code: auth };
      if (res.status === 503 && relayErrorCode(res.body) === 'not-ready') return { ok: false, code: 'not-ready' };
      return { ok: false, code: 'server' };
    },
  };
}

const COOKIE_NAMES = new Set(['CF_Authorization', 'CF_Binding']);
const COOKIE_MAX = 8192;
const PACK_MAX = 16384;
const COOKIE_VALUE = /^[\x21-\x2b\x2d-\x3a\x3c-\x7e]+$/;   // 印字できる ASCII（空白・, ・; を除く）
const SAME_SITE = new Set(['unspecified', 'no_restriction', 'lax', 'strict']);

// 中継のホストちょうど（host-only）か '.' ＋中継のホストの、CF_Authorization・CF_Binding だけ → しまう形。ほかは null
function keptCookie(c) {
  if (!c || typeof c !== 'object' || !COOKIE_NAMES.has(c.name)) return null;
  if (typeof c.value !== 'string' || c.value.length > COOKIE_MAX || !COOKIE_VALUE.test(c.value)) return null;
  const domain = typeof c.domain === 'string' ? c.domain.toLowerCase() : '';
  if (domain !== RELAY_HOST && domain !== '.' + RELAY_HOST) return null;
  const out = {
    name: c.name,
    value: c.value,
    path: typeof c.path === 'string' && c.path.startsWith('/') ? c.path : '/',
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    sameSite: SAME_SITE.has(c.sameSite) ? c.sameSite : 'unspecified',
    hostOnly: domain === RELAY_HOST,
    domain,
  };
  if (typeof c.expirationDate === 'number' && Number.isFinite(c.expirationDate)) out.expirationDate = c.expirationDate;
  return out;
}

/**
 * packCookies(cookies, { exp }) → secrets にしまう文字 | ''（しまう CF_Authorization が無い・大きすぎる）
 * { v: 1, until, c: [{ name, value, path, secure, httpOnly, sameSite, hostOnly, domain, expirationDate? }] }。
 * until は me() の exp（秒）。無ければしまう cookie のいちばん早い expirationDate（秒に切り捨て）、それも無ければ null
 */
function packCookies(cookies, { exp } = {}) {
  const c = (Array.isArray(cookies) ? cookies : []).map(keptCookie).filter(Boolean);
  if (!c.some((x) => x.name === 'CF_Authorization')) return '';
  let until = null;
  if (Number.isInteger(exp)) until = exp;
  else {
    const ds = c.map((x) => x.expirationDate).filter((d) => d !== undefined);
    if (ds.length) until = Math.floor(Math.min(...ds));
  }
  const text = JSON.stringify({ v: 1, until, c });
  return text.length <= PACK_MAX ? text : '';
}

/**
 * unpackCookies(text, nowSec) → { ok: true, until, cookies } | { ok: false, why: 'shape' | 'expired' | 'old' }
 * 'old' は 0.8.0 の前の試しの札（nt1_）。名前と domain の照らしは packCookies と同じものをもう一度かける（照らしに合わない cookie は捨てる）
 */
function unpackCookies(text, nowSec) {
  if (typeof text !== 'string') return { ok: false, why: 'shape' };
  if (text.startsWith('nt1_')) return { ok: false, why: 'old' };
  let j;
  try { j = JSON.parse(text); } catch (_) { return { ok: false, why: 'shape' }; }
  if (!j || typeof j !== 'object' || Array.isArray(j) || j.v !== 1 || !Array.isArray(j.c) || !(j.until === null || Number.isInteger(j.until))) {
    return { ok: false, why: 'shape' };
  }
  const cookies = j.c.map(keptCookie).filter(Boolean);
  if (!cookies.some((x) => x.name === 'CF_Authorization')) return { ok: false, why: 'shape' };
  if (j.until !== null && j.until <= nowSec) return { ok: false, why: 'expired' };
  return { ok: true, until: j.until, cookies };
}

module.exports = { RELAY_BASE, ACCESS_PARTITION, LOGIN_URL, LOGOUT_URL, relayProvider, makeAccessApi,
  isAccessHost, classifyAuth, loginNavAllowed, packCookies, unpackCookies };
