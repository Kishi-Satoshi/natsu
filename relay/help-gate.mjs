// NaTsu ヘルプセンターの門の Worker（ヘルプセンター H-9。HF1・RF50・RF42・R3・R4。実装計画 docs/plans/2026-10-20-help.md）。
// Worker 単位の Access の後ろに置き、run_worker_first で、どの要求でも資産より先にこの門が走る。中継と同じ relay/access.mjs の
// requireAccess で Access の JWT を確かめてから、静的な資産（env.ASSETS）を返す。確かめられない要求には記事の文字を1字も返さない。
//
//   export default { fetch(request, env, ctx) }
//     GET と HEAD だけ（ほかは 405。OPTIONS も 405）。
//     設定（readConfig）の ready.access と ready.domains のどちらかが偽なら、requireAccess を呼ばずに 503 の準備中
//       （requireAccess は会社のドメインの欠けを JWT の確かめの後で見るので、JWT の無い要求が 401 になる。門が先に見る）。
//     requireAccess は need: 'user'（サービストークンでは中身を見せない）。D1 は readOnlyDb で包んだものだけを渡す（R4）。
//     通れば ASSETS の答えを写し（ASSETS の答えの見出しは書き換えられない）、helpHeaders の見出しを set で上書きする。
//     ASSETS の転送の Location は、/ で始まる同じサイトの道（// と /\ で始まらない）のときだけ残し、ほかは 503 の門のページ。
//     思わぬ誤りは 503 の門のページ（中身を返さない側に倒す）。HEAD の答えには本文を付けない。
//   readOnlyDb(db) → { prepare(sql) }。sql が requireAccess の止めたメールの SELECT の文とちょうど同じときだけ db.prepare(sql) を返し、
//     ほかは投げる（batch・exec などの口は持たない。D1 のバインドに「読むだけ」が無いので、門のコードの誤りで中継の表を書き換えない）
//   helpHeaders(pathname, status) → 見出しの組（CSP・nosniff・no-referrer・noindex・Cache-Control）。Cache-Control は、200 で
//     道が /assets/ の下の決まった形（css・js・svg・woff2）にちょうど合うときだけ private, max-age=3600、ほかは全部 private, no-store
//     （決めかねたら no-store。会社の通信の検査の写しに残させない）
//   gatePage(st) → 門のページ（401・403・503 は決まった短い HTML、405 は本文なし）。/assets/ も外の物も読まない（門の後ろなので届かない）
// 記録は requireAccess の記録だけ（メール・JWT・チームの名前は書かない）。読むのは ./access.mjs と ./config.mjs だけ（R3）。

import { requireAccess } from './access.mjs';
import { readConfig } from './config.mjs';

const BLOCKED_SQL = 'SELECT 1 AS b FROM blocked_emails WHERE email = ?1';
const HELP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const GATE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
const KEEP_PATH = /^\/assets\/(?:(?:icons|fonts)\/)?[a-z0-9-]{1,40}\.(?:css|js|svg|woff2)$/;
const SAME_SITE = /^\/(?![/\\])[^\s\\]*$/;
const DROP = ['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-headers',
  'access-control-allow-methods', 'access-control-expose-headers', 'access-control-max-age'];

const GATE_TEXT = {
  401: '<p>ログインが必要です。このページを開き直すと、ログインの画面が出ます。</p>',
  403: '<p>このアカウントではヘルプセンターを開けません。会社のメールアドレスでログインし直すか、管理者に知らせてください。</p>'
    + '<p><a href="/cdn-cgi/access/logout">ログアウト</a></p>'
    + '<p>ログアウトすると、NaTsu アプリの文字起こしのログインも、ほかの PC を含めて切れます。</p>',
  503: '<p>NaTsu ヘルプセンターは準備中です。少し待ってから開き直してください。</p>',
};
const GATE_STYLE = 'body{font-family:system-ui,sans-serif;margin:2em auto;padding:0 1em;max-width:40em;line-height:1.7;color:#191919;background:#fff}'
  + 'a{color:#191919}@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#191919}a{color:#e6e6e6}}';

export function readOnlyDb(db) {
  return {
    prepare(sql) {
      if (typeof sql !== 'string' || sql !== BLOCKED_SQL) throw new TypeError('help-gate: この文は通さない');
      if (!db || typeof db.prepare !== 'function') throw new TypeError('help-gate: D1 が無い');
      return db.prepare(sql);
    },
  };
}

export function helpHeaders(pathname, status) {
  return {
    'content-security-policy': HELP_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex',
    'cache-control': status === 200 && typeof pathname === 'string' && KEEP_PATH.test(pathname) ? 'private, max-age=3600' : 'private, no-store',
  };
}

export function gatePage(st, { head = false } = {}) {
  const headers = new Headers(helpHeaders('', st));
  headers.set('content-security-policy', GATE_CSP);
  if (st === 405 || !GATE_TEXT[st]) {
    headers.set('allow', 'GET, HEAD');
    return new Response(null, { status: 405, headers });
  }
  headers.set('content-type', 'text/html; charset=utf-8');
  const body = '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="natsu-help" content="gate">'
    + `<title>NaTsu ヘルプセンター</title><style>${GATE_STYLE}</style></head><body>${GATE_TEXT[st]}</body></html>`;
  return new Response(head ? null : body, { status: st, headers });
}

async function serve(request, env, ctx) {
  const head = request.method === 'HEAD';
  if (request.method !== 'GET' && !head) return gatePage(405);
  const cfg = readConfig(env);
  if (!cfg.ready.access || !cfg.ready.domains) return gatePage(503, { head });
  const a = await requireAccess(request, { DB: readOnlyDb(env.DB) }, cfg, { need: 'user', ctx });
  if (!a.ok) return gatePage(a.st, { head });
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return gatePage(503, { head });
  const res = await env.ASSETS.fetch(request);
  const loc = res.headers.get('location');
  if (loc !== null && !SAME_SITE.test(loc)) {
    try { if (res.body) await res.body.cancel(); } catch (_) { /* 捨てるだけ */ }
    return gatePage(503, { head });
  }
  const headers = new Headers(res.headers);
  for (const h of DROP) headers.delete(h);
  for (const [k, v] of Object.entries(helpHeaders(new URL(request.url).pathname, res.status))) headers.set(k, v);
  if (head && res.body) {
    try { await res.body.cancel(); } catch (_) { /* 捨てるだけ */ }
  }
  return new Response(head ? null : res.body, { status: res.status, statusText: res.statusText, headers });
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await serve(request, env || {}, ctx);
    } catch (_) {
      return gatePage(503, { head: request && request.method === 'HEAD' });
    }
  },
};
