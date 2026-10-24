// NaTsu ヘルプセンターの門の Worker（ヘルプセンター H-9。HF1・RF50・RF42・R3・R4。実装計画 docs/plans/2026-10-20-help.md）。
// Worker 単位の Access の後ろに置き、run_worker_first で、どの要求でも資産より先にこの門が走る。中継と同じ relay/access.mjs の
// requireAccess で Access の JWT を確かめてから、静的な資産（env.ASSETS）を返す。確かめられない要求には記事の文字を1字も返さない。
//
//   export default { fetch(request, env, ctx) }
//     GET と HEAD だけ（ほかは 405。OPTIONS も 405）。
//     設定（readConfig）の ready.access と ready.domains のどちらかが偽なら、requireAccess を呼ばずに 503 の準備中
//       （requireAccess は会社のドメインの欠けを JWT の確かめの後で見るので、JWT の無い要求が 401 になる。門が先に見る）。
//       理由の符号は、欠けた欄（cfg の teamDomain・policyAud・domains の数。値は見ない）を cfg- の後に team・aud・domains の順でつなぐ
//       （cfg-team・cfg-aud・cfg-domains・cfg-team-aud・…・cfg-team-aud-domains）。
//     requireAccess は need: 'user'（サービストークンでは中身を見せない）。D1 は readOnlyDb で包んだものだけを渡す（R4）。
//     通れば ASSETS の答えを写し（ASSETS の答えの見出しは書き換えられない）、helpHeaders の見出しを set で上書きする。
//     ASSETS の転送の Location は、/ で始まる同じサイトの道（// と /\ で始まらない）のときだけ残し、ほかは 503 の門のページ。
//     思わぬ誤りは 503 の門のページ（中身を返さない側に倒す）。HEAD の答えには本文を付けない。
//     門が自分で返す 503・405 は、どれも1行 logEvent('help', { st, r }) を残す（r: cfg-…・no-assets・assets-redirect・error・method。
//       error は例外の型の名前が英字だけ 32 字までのときだけ、それを小文字で v に。例外の文は残さない）。503 のページにも同じ r を出す。
//     requireAccess の断り（401・403・503）は requireAccess が記録するので門は重ねない。503 のときだけ、その符号（aud・iss・certs・
//       not-ready）をページに出す。
//   readOnlyDb(db) → { prepare(sql) }。sql が requireAccess の止めたメールの SELECT の文とちょうど同じときだけ db.prepare(sql) を返し、
//     ほかは投げる（batch・exec などの口は持たない。D1 のバインドに「読むだけ」が無いので、門のコードの誤りで中継の表を書き換えない）
//   helpHeaders(pathname, status) → 見出しの組（CSP・nosniff・no-referrer・noindex・Cache-Control）。Cache-Control は、200 で
//     道が /assets/ の下の決まった形（css・js・svg・woff2）にちょうど合うときだけ private, max-age=3600、ほかは全部 private, no-store
//     （決めかねたら no-store。会社の通信の検査の写しに残させない）
//   gatePage(st, { head, why }) → 門のページ（401・403・503 は決まった短い HTML、405 は本文なし）。/assets/ も外の物も読まない（門の後ろなので届かない）
//     503 で why が決まった短い符号（小文字・数字・ハイフンの 32 字まで）のときだけ、準備中の文の後に小さな灰色の行「（理由: <why>）」を足す。
//     401・403 のページは why を見ない（変えない）
// 記録は requireAccess の記録と、上の門の1行だけ（メール・JWT・チームの名前・AUD・ドメインは書かない）。読むのは ./access.mjs・./config.mjs・
// ./log.mjs だけ（R3。log.mjs は access.mjs がもう読むので、上げるファイルの組は変わらない）。

import { requireAccess } from './access.mjs';
import { readConfig } from './config.mjs';
import { logEvent } from './log.mjs';

const BLOCKED_SQL = 'SELECT 1 AS b FROM blocked_emails WHERE email = ?1';
const HELP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const GATE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'";
const KEEP_PATH = /^\/assets\/(?:(?:icons|fonts)\/)?[a-z0-9-]{1,40}\.(?:css|js|svg|woff2)$/;
const SAME_SITE = /^\/(?![/\\])[^\s\\]*$/;
const WHY = /^[a-z0-9-]{1,32}$/;
const ERR_NAME = /^[A-Za-z]{1,32}$/;
const DROP = ['set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-headers',
  'access-control-allow-methods', 'access-control-expose-headers', 'access-control-max-age'];

const GATE_TEXT = {
  401: '<p>ログインが必要です。このページを開き直すと、ログインの画面が出ます。</p>',
  403: '<p>このアカウントではヘルプセンターを開けません。会社のメールアドレスでログインし直すか、管理者に知らせてください。</p>'
    + '<p><a href="/cdn-cgi/access/logout">ログアウト</a></p>'
    + '<p>ログアウトすると、NaTsu アプリの文字起こしのログインも、ほかの PC を含めて切れます。</p>',
  503: '<p>NaTsu ヘルプセンターは準備中です。少し待ってから開き直してください。</p>',
};
// help-dads HD-6（Q7）: 門のページの色はヘルプと同じ値（DADS の札と DADS-PROTECT.md のブランド色）。リンクは青と下線、輪は DADS の形。
// /assets/ は門の後ろで読めないので、インラインの style の中だけに書く（GATE_CSP は変えない）
const GATE_STYLE = 'body{font-family:system-ui,sans-serif;margin:2em auto;padding:0 1em;max-width:40em;line-height:1.7;color:#333333;background:#ffffff}'
  + 'h1{font-size:1.5rem;line-height:1.4;color:#000000;margin:0 0 .8em}'
  + 'a{color:#00118f;text-decoration:underline;text-decoration-thickness:calc(1 / 16 * 1rem);text-underline-offset:calc(3 / 16 * 1rem)}'
  + 'a:visited{color:#8b008b}'
  + '@media (hover:hover){a:hover{color:#0017c1;text-decoration-thickness:calc(3 / 16 * 1rem)}}'
  + 'a:active{color:#ac3e00;text-decoration-thickness:calc(1 / 16 * 1rem)}'
  + ':focus-visible{outline:calc(4 / 16 * 1rem) solid #000000;outline-offset:calc(2 / 16 * 1rem);border-radius:calc(4 / 16 * 1rem);box-shadow:0 0 0 calc(2 / 16 * 1rem) #ffd43d}'
  + 'a:focus-visible{background-color:#ffd43d;color:#000000}'
  + '.why{font-size:.875rem;color:#666666}'
  + '@media (prefers-color-scheme:dark){body{color:#d6d6d6;background:#111111}h1{color:#ffffff}a{color:#9db7f9}a:visited{color:#ff8eff}a:active{color:#ffa66d}'
  + ':focus-visible{outline:calc(4 / 16 * 1rem) solid #ffffff}a:focus-visible{background-color:#ffd43d;color:#000000}.why{color:#a3a3a3}}'
  + '@media (prefers-color-scheme:dark) and (hover:hover){a:hover{color:#7096f8}}';

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

export function gatePage(st, { head = false, why } = {}) {
  const headers = new Headers(helpHeaders('', st));
  headers.set('content-security-policy', GATE_CSP);
  if (st === 405 || !GATE_TEXT[st]) {
    headers.set('allow', 'GET, HEAD');
    return new Response(null, { status: 405, headers });
  }
  headers.set('content-type', 'text/html; charset=utf-8');
  const note = st === 503 && typeof why === 'string' && WHY.test(why) ? `<p class="why">（理由: ${why}）</p>` : '';
  const body = '<!doctype html><html lang="ja"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="natsu-help" content="gate">'
    + `<title>NaTsu ヘルプセンター</title><style>${GATE_STYLE}</style></head><body><main><h1>NaTsu ヘルプセンター</h1>${GATE_TEXT[st]}${note}</main></body></html>`;
  return new Response(head ? null : body, { status: st, headers });
}

// 欠けた欄だけを見て符号にする（値は記録にもページにも出さない）
function cfgWhy(cfg) {
  const miss = [];
  if (!cfg.teamDomain) miss.push('team');
  if (!cfg.policyAud) miss.push('aud');
  if (!(cfg.domains && cfg.domains.size > 0)) miss.push('domains');
  return miss.length ? 'cfg-' + miss.join('-') : 'cfg';
}

// 門が自分で返す 503・405: 1行残してから門のページ（記録が投げても門のページは返す）
function refuse(st, r, head, v) {
  try { logEvent('help', v ? { st, r, v } : { st, r }); } catch (_) { /* 記録できなくても答えは返す */ }
  return gatePage(st, { head, why: r });
}

function errName(e) {
  try {
    const n = e && typeof e === 'object' && e.constructor ? e.constructor.name : '';
    return typeof n === 'string' && ERR_NAME.test(n) ? n.toLowerCase() : '';
  } catch (_) { return ''; }
}

async function serve(request, env, ctx) {
  const head = request.method === 'HEAD';
  if (request.method !== 'GET' && !head) return refuse(405, 'method', false);
  const cfg = readConfig(env);
  if (!cfg.ready.access || !cfg.ready.domains) return refuse(503, cfgWhy(cfg), head);
  const a = await requireAccess(request, { DB: readOnlyDb(env.DB) }, cfg, { need: 'user', ctx });
  if (!a.ok) return gatePage(a.st, { head, why: a.r });
  if (!env.ASSETS || typeof env.ASSETS.fetch !== 'function') return refuse(503, 'no-assets', head);
  const res = await env.ASSETS.fetch(request);
  const loc = res.headers.get('location');
  if (loc !== null && !SAME_SITE.test(loc)) {
    try { if (res.body) await res.body.cancel(); } catch (_) { /* 捨てるだけ */ }
    return refuse(503, 'assets-redirect', head);
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
    } catch (e) {
      return refuse(503, 'error', Boolean(request && request.method === 'HEAD'), errName(e));
    }
  },
};
