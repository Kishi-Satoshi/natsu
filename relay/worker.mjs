// 文字起こしの中継の入口（第1d回 RL1）。npm の依存の無い、素の JS のモジュールの Worker。
// 道と方法で分け、例外は外に投げない（投げたら 500 { error: 'internal' } と記録 1 行。例外の文は記録に写さない）。
//   makeHandler({ now }) → { fetch(request, env, ctx) }。テストは試しの時計を渡す（環境の値で時計を替える道は作らない）
//   export default makeHandler()（本番の時計）
// 道（W-2〜W-5 で足す）。どの道も Cloudflare Access（Worker 単位）の後ろで、Access の JWT は access.mjs の requireAccess が確かめる:
//   GET /health → 200 { ok: true, relay: 2, ready: { db, openai, access, domains } }（秘密があるか・D1 の表があるかだけ。値は出さない）
//     access（TEAM_DOMAIN・POLICY_AUD）がそろったら、確かめた JWT（人かサービストークン。見出しも cookie も無いときは ctx.access の aud）の
//     ときだけ答え、ほかは requireAccess の 401 login・403 denied・503 not-ready（W-5。中継の様子をだれにでも見せない）
//   GET /auth/done → 人の JWT で 200 の小さな HTML（ログインの窓が着くページ。script なし・外の物を読まない・クエリを読まない）（W-5）
//   GET /v1/me → 人の JWT で 200 { email, exp, via }（email は小文字・exp は JWT の exp・via は 'hdr'|'cookie'）（W-5）
//   POST /auth/start → auth.mjs の handleStart（W-2。確認コードを頼む）
//   POST /auth/verify・POST /auth/logout・GET /auth/me → auth.mjs の handleVerify・handleLogout・handleMe（W-3。札）
//   POST /v1/audio/transcriptions → stt.mjs の handleTranscribe（W-4。ログインした人の WAV を送り、文字だけを返す。W-5 から Access の JWT。
//     W-6 までは JWT が無いときだけ今の札も見る）
// どの道も Location の見出しと Access-Control-Allow-* を返さない（OPTIONS は道に無いので 405）。

import { json } from './http.mjs';
import { readConfig } from './config.mjs';
import { logEvent } from './log.mjs';
import { SCHEMA_VERSION } from './schema.mjs';
import { handleStart, handleVerify, handleLogout, handleMe } from './auth.mjs';
import { handleTranscribe } from './stt.mjs';
import { requireAccess, accessError } from './access.mjs';

const DONE_HTML = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>NaTsu</title>'
  + '<style>body{font-family:sans-serif;margin:2em;line-height:1.6}</style></head>'
  + '<body><p>ログインできました。この窓は自動で閉じます。</p></body></html>';
const DONE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";

async function health(request, env, { cfg, now, ctx }) {
  if (cfg.ready.access) {
    const a = await requireAccess(request, env, cfg, { now, need: 'any', ctx });
    if (!a.ok) {
      logEvent('health', { st: a.st });
      return json(a.st, { error: accessError(a.st) });
    }
  }
  let db = false;
  try {
    const v = await env.DB.prepare("SELECT value FROM meta WHERE key = 'schema'").first('value');
    db = Number(v) >= SCHEMA_VERSION;
  } catch (_) {
    db = false;   // D1 が無い・表が無い・つながらない。例外の文は出さない
  }
  logEvent('health', { st: 200 });
  const { openai, access, domains } = cfg.ready;
  return json(200, { ok: true, relay: 2, ready: { db, openai, access, domains } });
}

// ログインの窓が着くページ（人の JWT だけ）。クエリは読まない（/auth/done?… も同じ本文）
async function authDone(request, env, { cfg, now, ctx }) {
  const a = await requireAccess(request, env, cfg, { now, ctx });   // ctx.access は need: 'any'（/health）のほかでは見ない
  logEvent('auth.done', { st: a.ok ? 200 : a.st });
  if (!a.ok) return json(a.st, { error: accessError(a.st) });
  return new Response(DONE_HTML, {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': DONE_CSP,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}

// 確かめたメールと JWT の期限（アプリがログインの直後と「M 月 D 日まで」に使う。人の JWT だけ）
async function me(request, env, { cfg, now, ctx }) {
  const a = await requireAccess(request, env, cfg, { now, ctx });   // ctx.access は need: 'any'（/health）のほかでは見ない
  logEvent('me', { st: a.ok ? 200 : a.st });
  if (!a.ok) return json(a.st, { error: accessError(a.st) });
  return json(200, { email: a.email, exp: a.exp, via: a.via });
}

const ROUTES = new Map([
  ['/health', { GET: health }],
  ['/auth/start', { POST: handleStart }],
  ['/auth/verify', { POST: handleVerify }],
  ['/auth/logout', { POST: handleLogout }],
  ['/auth/me', { GET: handleMe }],
  ['/auth/done', { GET: authDone }],
  ['/v1/me', { GET: me }],
  ['/v1/audio/transcriptions', { POST: handleTranscribe }],
]);

export function makeHandler({ now = () => Date.now() } = {}) {
  return {
    async fetch(request, env, ctx) {
      try {
        const e = env || {};
        const route = ROUTES.get(new URL(request.url).pathname);
        if (!route) return json(404, { error: 'not-found' });
        if (!Object.prototype.hasOwnProperty.call(route, request.method)) {
          return json(405, { error: 'method' }, { allow: Object.keys(route).join(', ') });
        }
        return await route[request.method](request, e, { cfg: readConfig(e), now, ctx });
      } catch (_) {
        logEvent('error', { r: 'internal' });
        return json(500, { error: 'internal' });
      }
    },
  };
}

export default makeHandler();
