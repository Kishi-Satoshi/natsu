// 文字起こしの中継の入口（第1d回 RL1）。npm の依存の無い、素の JS のモジュールの Worker。
// 道と方法で分け、例外は外に投げない（投げたら 500 { error: 'internal' } と記録 1 行。例外の文は記録に写さない）。
//   makeHandler({ now }) → { fetch(request, env, ctx) }。テストは試しの時計を渡す（環境の値で時計を替える道は作らない）
//   export default makeHandler()（本番の時計）
// 道（W-2〜W-4 で足す）:
//   GET /health → 200 { ok: true, relay: 1, ready: { db, openai, mail, domains } }（秘密があるか・D1 の表があるかだけ。値は出さない）

import { json } from './http.mjs';
import { readConfig } from './config.mjs';
import { logEvent } from './log.mjs';
import { SCHEMA_VERSION } from './schema.mjs';

async function health(request, env, { cfg }) {
  let db = false;
  try {
    const v = await env.DB.prepare("SELECT value FROM meta WHERE key = 'schema'").first('value');
    db = Number(v) >= SCHEMA_VERSION;
  } catch (_) {
    db = false;   // D1 が無い・表が無い・つながらない。例外の文は出さない
  }
  logEvent('health', { st: 200 });
  return json(200, { ok: true, relay: 1, ready: { db, ...cfg.ready } });
}

const ROUTES = new Map([
  ['/health', { GET: health }],
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
