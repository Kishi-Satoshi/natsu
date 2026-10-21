/* help-deploy.test.js — ヘルプセンター H-10（HF1・HF5・RF50・R4・R5・R10）: ヘルプの出し方（tools/help-deploy.js・tools/lib/cf-api.js・
 * .github/workflows/help-deploy.yml）
 *
 * 偽の Cloudflare の API（資産の上げの session・バケットの上げ・Worker の上げ）と、偽のヘルプのサイト（漏れの確かめの相手）を
 * 127.0.0.1 に開き、台本の deploy() を「127.0.0.1 のほかは断る fetch」で呼ぶ（本物の Cloudflare へは決して出ない）。
 * サイトを作る道具（tools/help-build.js の build）の代わりに、写しのフォルダへ小さなサイトを書く偽の build を渡す。
 * GitHub Actions は手元で回せないので、ワークフローは文字列として読む（test/helpers/yml.js）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const R = require('./helpers/relay-run');
const { jobsOf, stepsOf, nameOf } = require('./helpers/yml');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCRIPT = path.join(ROOT, 'tools', 'help-deploy.js');
const WF = '.github/workflows/help-deploy.yml';
let CFG = {};
try { CFG = JSON.parse(read('help/deploy-config.json')); } catch (_) { /* 無ければ、使うテストが落ちる */ }
const RELAY_CFG = JSON.parse(read('relay/deploy-config.json'));
const GATE_FILES = ['access.mjs', 'config.mjs', 'help-gate.mjs', 'http.mjs', 'log.mjs'];
const PAGE = '<meta name="natsu-help" content="page">';
const GATE = '<meta name="natsu-help" content="gate">';
const ARTICLE = 'テスト用の記事の本文';
const ACCESS_LOGIN = 'https://natsu-test.cloudflareaccess.com/cdn-cgi/access/login/natsu-help?redirect_url=%2F';

// ---------------------------------------------------------------- 偽のサイト（作る道具の代わり）
// 写しのフォルダ（root）に help/site.json（featured だけ見る）を置き、dist に小さなサイトを書く
function fakeSite() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-help-deploy-'));
  const dist = path.join(root, 'help', 'dist');
  fs.mkdirSync(path.join(root, 'help'), { recursive: true });
  fs.writeFileSync(path.join(root, 'help', 'site.json'), JSON.stringify({ featured: ['start/first', 'record/pause'] }));
  const page = (t) => `<!doctype html><html lang="ja"><head>${PAGE}<title>${t}</title></head><body>${ARTICLE}</body></html>`;
  const files = {
    'index.html': page('ホーム'),
    '404.html': page('404'),
    'start/index.html': page('はじめに'),
    'start/first/index.html': page('はじめての方へ'),
    'record/pause/index.html': page('一時停止'),
    'search-index.json': JSON.stringify({ v: 1, items: [{ u: '/start/first/', t: 'はじめての方へ', x: ARTICLE }] }),
    'assets/help.css': 'body{color:#000}',
    'assets/search.js': 'var HelpSearch = {};',
    'assets/icons/start.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    'assets/fonts/plex-400.woff2': Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, 1, 2, 3, 255]),
    'assets/notes.unknownext': 'x',
  };
  const build = ({ root: r, out } = {}) => {
    assert.strictEqual(r, root, 'build に root を渡していない');
    assert.strictEqual(out, dist, 'build に dist を渡していない');
    fs.rmSync(dist, { recursive: true, force: true });
    let bytes = 0;
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dist, f)), { recursive: true });
      fs.writeFileSync(path.join(dist, f), c);
      bytes += Buffer.byteLength(c);
    }
    return { pages: Object.keys(files).filter((f) => f.endsWith('.html')), articles: [{ ref: 'start/first', url: '/start/first/', title: 'はじめての方へ' }, { ref: 'record/pause', url: '/record/pause/', title: '一時停止' }], bytes };
  };
  return { root, dist, files, build, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const ext = (f) => (path.extname(f) || '.').slice(1);
const hashOf = (bytes, f) => crypto.createHash('sha256').update(Buffer.from(bytes).toString('base64') + ext(f)).digest('hex').slice(0, 32);

// ---------------------------------------------------------------- 偽の Cloudflare の API と偽のサイト（127.0.0.1）
// opts: subdomain（'' なら無い）・dbExists（中継の D1）・scriptExists・buckets（'all'｜'none'｜'stray'。stray は manifest に無い指紋を混ぜる）・
//       noJwt（バケットの答えに jwt を付けない）・site（漏れの確かめの相手の答え方。下の SITE）・fail（{ method, re }。403 と、トークン・
//       アカウントの ID・札・本文の印を入れた答え）・redirect（{ method, re }。302 で同じ偽物の /client/v4/moved へ）
// site: 'gate-503'（既定）・'gate-401'・'gate-403'・'access-302'（Access のログインへ）・'open'（どの道も 200 の中身）・
//       'open-index'（/search-index.json だけ 200）・'open-article'（featured の最初の記事だけ 200）・'other-302'（ほかのホストへ）・
//       'same-302'（同じホストの道へ）・'not-found'（いつも 404）・'flaky'（はじめの 2 回は 404、その後は gate-503）・
//       'plain-503'（門の印の無い 503）・'plain-403'（門の印の無い 403。Access の前で止められた）
async function fakeCf({ token, acct, subdomain = 'team-a', dbExists = true, scriptExists = false, buckets = 'all', noJwt = false, site = 'gate-503', fail = null, redirect = null } = {}) {
  const sessionJwt = 'upl-session-' + crypto.randomBytes(12).toString('hex');
  const doneJwt = 'upl-done-' + crypto.randomBytes(12).toString('hex');
  const dbId = crypto.randomUUID();
  const st = { reqs: [], sessionJwt, doneJwt, dbId, scriptExists, manifest: null, asked: [], uploads: [], put: null, sub: null, created: null, siteHits: 0 };
  const A = `/client/v4/accounts/${acct}`;
  const S = `${A}/workers/scripts/${CFG.scriptName}`;
  const send = (res, code, body, type = 'application/json', extra = {}) => { res.writeHead(code, { 'content-type': type, ...extra }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const ok = (res, result, code = 200) => send(res, code, { success: true, errors: [], messages: [], result });
  const nf = (res, code = 7003) => send(res, 404, { success: false, errors: [{ code, message: 'Could not route' }], result: null });
  const page = (st2) => `<!doctype html><html lang="ja"><head>${GATE}</head><body>門 ${st2}</body></html>`;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://127.0.0.1');
      const p = u.pathname;
      st.reqs.push({ method: req.method, path: (p + u.search).split(acct).join(':acct'), auth: req.headers.authorization || '', cookie: req.headers.cookie || '', body: raw.toString('latin1') });
      try {
        if (fail && [].concat(fail.method).includes(req.method) && fail.re.test(p)) {
          // fail.method は1つか配列。fail.body: 'json'（既定。errors[].message にトークン・アカウントの ID・札・メール・HTML を混ぜる）・'html'（前に立つ守りの頁）・
          //            'empty'・'text'・'json-noerr'（errors の無い JSON）。fail.ray: 見出し cf-ray の値。fail.status: 既定 403
          const extra = fail.ray ? { 'cf-ray': fail.ray } : {};
          const code = fail.status || 403;
          if (fail.body === 'html') return send(res, code, `<!DOCTYPE html><html><head><title>Attention Required! body-mark-zz</title></head><body>${token} ${acct}</body></html>`, 'text/html; charset=UTF-8', extra);
          if (fail.body === 'empty') return send(res, code, '', 'text/plain', extra);
          if (fail.body === 'text') return send(res, code, `error code: 1020 body-mark-zz ${acct}`, 'text/plain', extra);
          if (fail.body === 'json-noerr') return send(res, code, { success: false, result: null, note: `body-mark-zz ${token}` }, 'application/json', extra);
          return send(res, code, { success: false, errors: [{ code: 10000, message: `Authentication error ${token} ${acct} ${sessionJwt} ${R.mail('owner.test', 'example.co.jp')} <b>x</b>`, documentation_url: 'https://developers.cloudflare.com/workers/authorization/' }],
            messages: [`body-mark-zz ${token}`], result: { jwt: doneJwt, note: `body-mark-zz ${acct}` } }, 'application/json', extra);
        }
        if (redirect && redirect.method === req.method && redirect.re.test(p)) { res.writeHead(302, { location: '/client/v4/moved' }); return res.end(); }
        if (p === '/client/v4/moved' || p.startsWith('/elsewhere')) return ok(res, { subdomain: 'team-a', note: ARTICLE });
        if (p.startsWith('/site/')) {
          st.siteHits += 1;
          const sp = p.slice('/site'.length);
          const content = () => send(res, 200, `<!doctype html>${PAGE}${ARTICLE}`, 'text/html; charset=utf-8');
          if (site === 'open') return content();
          if (site === 'open-index' && sp === '/search-index.json') return content();
          if (site === 'open-article' && sp === '/start/first/') return content();
          if (site === 'other-302') { res.writeHead(302, { location: 'https://evil.example/start/' }); return res.end(); }
          if (site === 'same-302') { res.writeHead(302, { location: '/elsewhere/' }); return res.end(); }
          if (site === 'access-302') { res.writeHead(302, { location: ACCESS_LOGIN }); return res.end(); }
          if (site === 'not-found' || (site === 'flaky' && st.siteHits <= 2)) return send(res, 404, 'not found', 'text/plain');
          if (site === 'plain-503') return send(res, 503, 'error 1101', 'text/plain');
          if (site === 'plain-403') return send(res, 403, 'Forbidden', 'text/plain');
          const code = site === 'gate-401' ? 401 : site === 'gate-403' ? 403 : 503;
          return send(res, code, page(code), 'text/html; charset=utf-8');
        }
        // 資産のバケットの上げ（上げの札だけで認める。API のトークンでは通さない）
        if (req.method === 'POST' && p === `${A}/workers/assets/upload`) {
          if (req.headers.authorization !== `Bearer ${sessionJwt}`) return send(res, 401, { success: false, errors: [{ code: 10001 }] });
          if (u.searchParams.get('base64') !== 'true') return send(res, 400, { success: false, errors: [{ code: 2 }] });
          const fd = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
          const parts = [];
          for (const [k, v] of fd.entries()) parts.push({ name: k, filename: v.name, type: v.type, text: await v.text() });
          st.uploads.push(parts);
          const all = st.asked.flat();
          const got = new Set(st.uploads.flat().map((x) => x.name));
          return ok(res, !noJwt && all.every((h) => got.has(h)) ? { jwt: doneJwt } : {}, 201);
        }
        if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { success: false, errors: [{ code: 10001 }] });
        if (req.method === 'GET' && p === `${A}/workers/subdomain`) return subdomain ? ok(res, { subdomain }) : nf(res, 10007);
        if (req.method === 'GET' && p === `${A}/d1/database`) {
          const name = u.searchParams.get('name') || '';
          return ok(res, dbExists ? [{ uuid: dbId, name: RELAY_CFG.dbName }].filter((d) => d.name.includes(name)) : []);
        }
        if (req.method === 'POST' && p === `${A}/d1/database`) { st.created = raw.toString('utf8'); return ok(res, { uuid: crypto.randomUUID() }); }
        if (req.method === 'POST' && p === `${S}/assets-upload-session`) {
          st.manifest = JSON.parse(raw.toString('utf8')).manifest;
          const hashes = Object.values(st.manifest).map((m) => m.hash);
          st.asked = buckets === 'none' ? [] : [];
          if (buckets !== 'none') for (let i = 0; i < hashes.length; i += 3) st.asked.push(hashes.slice(i, i + 3));
          if (buckets === 'stray') st.asked.push(['f'.repeat(32)]);
          return ok(res, { jwt: sessionJwt, buckets: st.asked });
        }
        if (req.method === 'GET' && p === S) return st.scriptExists ? send(res, 200, 'export default {}', 'application/javascript') : nf(res, 10007);
        if (req.method === 'PUT' && p === S) {
          const fd = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
          const parts = {};
          for (const [k, v] of fd.entries()) parts[k] = typeof v === 'string' ? { text: v } : { type: v.type, filename: v.name, text: await v.text() };
          st.put = { parts, metadata: JSON.parse(parts.metadata.text) };
          st.scriptExists = true;
          return ok(res, { id: CFG.scriptName });
        }
        if (req.method === 'POST' && p === `${S}/subdomain`) { st.sub = JSON.parse(raw.toString('utf8')); return ok(res, st.sub); }
        return nf(res);
      } catch (e) {
        return send(res, 500, { success: false, errors: [{ code: 1 }] });
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { st, base, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}

// 台本の deploy() を、偽物へだけ向けて呼ぶ。out の行と console に出たものを全部まとめて返す
async function runDeploy(cf, site, { token, acct, env = {}, build } = {}) {
  const { deploy } = require(SCRIPT);
  const e = {
    CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: acct,
    CF_API_BASE: `${cf.base}/client/v4`, HELP_CHECK_BASE: `${cf.base}/site`, GITHUB_EVENT_NAME: 'workflow_dispatch',
  };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete e[k]; else e[k] = v; }
  const out = [];
  const tried = [];
  const calls = [];
  const guarded = R.loopbackOnlyFetch(globalThis.fetch);
  const fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    tried.push(url);
    const headers = {};
    for (const [k, v] of new Headers((init && init.headers) || {}).entries()) headers[k] = v;
    calls.push({ url, headers, redirect: init && init.redirect, method: (init && init.method) || 'GET' });
    return guarded(input, init);
  };
  const realErr = console.error;
  const realWarn = console.warn;
  const errs = [];
  console.error = (...a) => errs.push(a.join(' '));
  console.warn = console.error;
  let code;
  try {
    const logged = await R.captureConsole(async () => {
      code = await deploy({ env: e, fetch, out: (l) => out.push(String(l)), sleep: async () => {}, root: site.root, build: build || site.build });
    });
    return { code, text: [...out, ...logged, ...errs].join('\n'), out, tried, calls };
  } finally { console.error = realErr; console.warn = realWarn; }
}

const secrets = () => ({ token: 'cf-test-token-' + crypto.randomBytes(12).toString('hex'), acct: crypto.randomBytes(16).toString('hex') });
const seq = (st) => st.reqs.map((r) => `${r.method} ${r.path}`);

async function withCf(opts, fn) {
  const s = secrets();
  const cf = await fakeCf({ ...s, ...opts });
  const site = fakeSite();
  try { return await fn({ s, cf, site, run: (o = {}) => runDeploy(cf, site, { ...s, ...o }) }); } finally { await cf.close(); site.close(); }
}

// ---------------------------------------------------------------- 台本の動き
test('H-10: 1回目は作る → サブドメイン → 中継の D1 を探す → 上げの session → バケット → keep_bindings なしで上げる → workers.dev → 漏れの確かめ（503 準備中）で 0', { timeout: 5000 }, async () => {
  await withCf({}, async ({ cf, run }) => {
    const r = await run();
    assert.strictEqual(r.code, 0, r.text);
    const S = `/client/v4/accounts/:acct/workers/scripts/${CFG.scriptName}`;
    const bucketCalls = cf.st.asked.length;
    assert.ok(bucketCalls >= 3, `バケットが少ない: ${bucketCalls}`);
    assert.deepStrictEqual(seq(cf.st), [
      'GET /client/v4/accounts/:acct/workers/subdomain',
      `GET /client/v4/accounts/:acct/d1/database?name=${RELAY_CFG.dbName}`,
      `POST ${S}/assets-upload-session`,
      ...Array(bucketCalls).fill('POST /client/v4/accounts/:acct/workers/assets/upload?base64=true'),
      `GET ${S}`,
      `PUT ${S}`,
      `POST ${S}/subdomain`,
      'GET /site/',
      'GET /site/search-index.json',
      'GET /site/start/first/',
    ]);
    const md = cf.st.put.metadata;
    assert.deepStrictEqual(md, {
      main_module: 'help-gate.mjs',
      compatibility_date: CFG.compatibilityDate,
      bindings: [{ type: 'assets', name: 'ASSETS' }, { type: 'd1', name: 'DB', database_id: cf.st.dbId }],
      assets: { jwt: cf.st.doneJwt, config: { run_worker_first: true, html_handling: 'auto-trailing-slash', not_found_handling: '404-page' } },
      observability: { enabled: true, logs: { enabled: true, invocation_logs: false } },
    });
    assert.deepStrictEqual(cf.st.sub, { enabled: true, previews_enabled: false });
    assert.strictEqual(cf.st.created, null, 'D1 を作った');
    assert.match(r.text, /公開した URL: https:\/\/natsu-help\.team-a\.workers\.dev$/m);
    assert.match(r.text, /準備中（Access の app と秘密の欄がまだ。利用者の用意の 1〜5）/);
    // 全部のバケットの指紋を1回ずつ上げた
    assert.deepStrictEqual(cf.st.uploads.map((b) => b.map((x) => x.name)), cf.st.asked);
  });
});

test('HF5: 2回目からは keep_bindings: [secret_text]。送るバインドは ASSETS と DB だけ（秘密の値・plain_text を送らない）。assets.config.run_worker_first は true', { timeout: 5000 }, async () => {
  await withCf({ scriptExists: true, site: 'access-302' }, async ({ cf, run }) => {
    const r = await run({ env: { OPENAI_API_KEY: 'sk-must-not-send-1', ALLOWED: 'must-not-send-2' } });
    assert.strictEqual(r.code, 0, r.text);
    const md = cf.st.put.metadata;
    assert.deepStrictEqual(md.keep_bindings, ['secret_text']);
    assert.deepStrictEqual(md.bindings.map((b) => `${b.type}:${b.name}`), ['assets:ASSETS', 'd1:DB']);
    assert.strictEqual(md.assets.config.run_worker_first, true);
    assert.ok(!/plain_text|secret_text"\s*,\s*"text|"text"\s*:/.test(cf.st.put.parts.metadata.text), cf.st.put.parts.metadata.text);
    for (const q of cf.st.reqs) assert.ok(!/must-not-send/.test(q.body), `${q.method} ${q.path}: 本文に秘密の値`);
    assert.match(r.text, /Access に守られています/);
  });
});

test('HF5: 出力にトークン・アカウントの ID・上げの札・済みの札・答えの本文が無い（偽の API が本文にトークンを入れて返しても）。トークンは API の要求にだけ・上げの札はバケットの要求にだけ付く', { timeout: 5000 }, async () => {
  await withCf({}, async ({ s, cf, run }) => {
    const r = await run();
    assert.strictEqual(r.code, 0, r.text);
    for (const bad of [s.token, s.acct, cf.st.sessionJwt, cf.st.doneJwt, ARTICLE]) assert.ok(!r.text.includes(bad), `出力に ${bad.slice(0, 12)}…`);
    for (const q of cf.st.reqs) {
      const where = `${q.method} ${q.path}`;
      if (q.path.startsWith('/client/v4/accounts/:acct/workers/assets/upload')) assert.strictEqual(q.auth, `Bearer ${cf.st.sessionJwt}`, where);
      else if (q.path.startsWith('/client/v4/')) assert.strictEqual(q.auth, `Bearer ${s.token}`, where);
      else assert.strictEqual(q.auth, '', `${where}: 漏れの確かめに見出し`);
      assert.strictEqual(q.cookie, '', `${where}: cookie`);
      assert.ok(!q.body.includes(s.token), `${where}: 本文にトークン`);
      assert.ok(!q.path.includes(s.token) && !q.path.includes(cf.st.sessionJwt), `${where}: URL に札`);
      if (!q.path.startsWith(`/client/v4/accounts/:acct/workers/scripts/${CFG.scriptName}`) || q.method !== 'PUT') assert.ok(!q.body.includes(cf.st.doneJwt), `${where}: 済みの札`);
    }
  });
  for (const fail of [{ method: 'PUT', re: /\/workers\/scripts\/natsu-help$/ }, { method: 'POST', re: /\/assets-upload-session$/ }, { method: 'POST', re: /\/workers\/assets\/upload$/ }, { method: 'GET', re: /\/d1\/database$/ }]) {
    await withCf({ fail }, async ({ s, cf, run }) => {
      const r = await run();
      assert.strictEqual(r.code, 1, r.text);
      assert.match(r.text, /HTTP 403/);
      assert.match(r.text, /10000/);
      // run 39520207427 の調べで意図して変えた: errors[].message は洗って出す（トークン・アカウントの ID・札・メール・HTML の字は伏せる・落とす）
      assert.match(r.text, /本文 JSON・Cloudflare のエラー 10000・文「Authentication error \(redacted\) \(redacted\) \(redacted\) \(email\) bx\/b」・資料 https:\/\/developers\.cloudflare\.com\/workers\/authorization\//);
      for (const bad of [s.token, s.acct, cf.st.sessionJwt, cf.st.doneJwt, 'body-mark-zz', 'example.co.jp', 'owner.test', '<b>']) assert.ok(!r.text.includes(bad), `出力に ${bad.slice(0, 12)}…`);
      assert.ok(!seq(cf.st).some((x) => x.endsWith('/subdomain') && x.startsWith('POST')), '失敗の後も先へ進んだ');
      assert.strictEqual(cf.st.siteHits, 0, '失敗の後に漏れの確かめをした');
    });
  }
});

test('H-10（run 39520207427 の調べ）: 失敗の答えの本文の形（JSON・HTML・空・ほか）と cf-ray を出す。本文の文字・トークン・アカウントの ID は出さない', { timeout: 5000 }, async () => {
  const RAY_OK = '0123456789abcdef-NRT';
  const want = [
    ['html', /失敗: 4\/9 資産の上げを始める（HTTP 403・本文 HTML（Cloudflare の API の JSON でない）・cf-ray 0123456789abcdef-NRT）/],
    ['empty', /失敗: 4\/9 資産の上げを始める（HTTP 403・本文 空・cf-ray 0123456789abcdef-NRT）/],
    ['text', /失敗: 4\/9 資産の上げを始める（HTTP 403・本文 JSON でも HTML でもない・cf-ray 0123456789abcdef-NRT）/],
    ['json-noerr', /失敗: 4\/9 資産の上げを始める（HTTP 403・本文 JSON・cf-ray 0123456789abcdef-NRT）/],
  ];
  for (const [body, re] of want) {
    await withCf({ fail: { method: 'POST', re: /\/assets-upload-session$/, body, ray: RAY_OK } }, async ({ s, cf, run }) => {
      const r = await run();
      assert.strictEqual(r.code, 1, r.text);
      assert.match(r.text, re, body);
      for (const bad of [s.token, s.acct, cf.st.sessionJwt, 'body-mark-zz', 'Attention', '1020']) assert.ok(!r.text.includes(bad), `${body}: 出力に ${bad.slice(0, 12)}…`);
      assert.strictEqual(cf.st.put, null, `${body}: 上げた`);
    });
  }
  // 形の違う cf-ray は出さない（見出しに混ぜた文字を記録に出さない）
  for (const ray of ['0123456789abcdef-nrt', '0123456789ABCDEF-NRT', '0123456789abcdef-NRT x', '0123456789abcdef', `0123456789abcdef-NRT${'a'.repeat(40)}`]) {
    await withCf({ fail: { method: 'GET', re: /\/d1\/database$/, body: 'html', ray } }, async ({ run }) => {
      const r = await run();
      assert.strictEqual(r.code, 1, r.text);
      assert.match(r.text, /失敗: 3\/9 中継の D1 を探す（HTTP 403・本文 HTML（Cloudflare の API の JSON でない））/, ray);
      assert.ok(!/cf-ray/.test(r.text), `${ray}: 形の違う cf-ray を出した`);
    });
  }
});

test('H-10（run 39520207427 の調べ）: 4/9 が 401・403 なら、natsu-help があるかを1回だけ見て、新しい Worker を作る権限の文を足す（状態の番号だけ。先へ進まない）', { timeout: 5000 }, async () => {
  const S = `/client/v4/accounts/:acct/workers/scripts/${CFG.scriptName}`;
  const want = [
    [false, 403, /4\/9 の調べ: natsu-help はまだありません（HTTP 404）。新しい Worker を作るには、トークンに Workers の Admin の権限が要ります/],
    [true, 403, /4\/9 の調べ: natsu-help はあります（HTTP 200）。トークンが中継（natsu-relay）だけに絞られていないかを確かめてください/],
    [false, 401, /4\/9 の調べ: natsu-help はまだありません（HTTP 404）/],
  ];
  for (const [scriptExists, status, re] of want) {
    await withCf({ scriptExists, fail: { method: 'POST', re: /\/assets-upload-session$/, status } }, async ({ s, cf, run }) => {
      const r = await run();
      assert.strictEqual(r.code, 1, r.text);
      assert.match(r.text, re);
      assert.match(r.text, new RegExp(`失敗: 4/9 資産の上げを始める（HTTP ${status}・`));
      assert.deepStrictEqual(seq(cf.st).slice(2), [`POST ${S}/assets-upload-session`, `GET ${S}`]);
      for (const bad of [s.token, s.acct]) assert.ok(!r.text.includes(bad));
    });
  }
  // 見るのも断られたら（Worker を1つに絞ったトークンなど）、その文。ほかの失敗（500）では見に行かない
  await withCf({ fail: { method: ['POST', 'GET'], re: /\/workers\/scripts\/natsu-help(\/assets-upload-session)?$/ } }, async ({ cf, run }) => {
    const r = await run();
    assert.strictEqual(r.code, 1, r.text);
    assert.match(r.text, /4\/9 の調べ: natsu-help を見られません（HTTP 403）。トークンが中継（natsu-relay）だけに絞られていないか、Workers の Admin の権限があるかを確かめてください/);
  });
  await withCf({ fail: { method: 'POST', re: /\/assets-upload-session$/, status: 500 } }, async ({ cf, run }) => {
    const r = await run();
    assert.strictEqual(r.code, 1, r.text);
    assert.ok(!/4\/9 の調べ/.test(r.text), r.text);
    assert.deepStrictEqual(seq(cf.st).slice(2), [`POST ${S}/assets-upload-session`]);
  });
});

test('H-10（run 39520207427 の調べ）: cleanMessage は決まった字（英数字・空白・. , : ; \' ( ) / _ -）だけを残し、メール・URL・長い英数字の並びを伏せ、160 字まで', { timeout: 5000 }, () => {
  const { cleanMessage, why } = require('../tools/lib/cf-api');
  const OK = /^[A-Za-z0-9 .,:;'()/_-]*$/;
  assert.strictEqual(cleanMessage('Authentication error'), 'Authentication error');
  assert.strictEqual(cleanMessage("workers.api.error.unauthorized: can't (yet) do a/b_c-d; ok,"), "workers.api.error.unauthorized: can't (yet) do a/b_c-d; ok,");
  const acct = crypto.randomBytes(16).toString('hex');
  const tok = 'cfut_' + crypto.randomBytes(30).toString('base64url');
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiJ4In0', crypto.randomBytes(32).toString('base64url')].join('.');
  const nasty = [
    `token ${tok} acct ${acct} jwt ${jwt}`, `mail ${R.mail('someone')} end`, 'see https://evil.example/?a=b&c=d end', 'x://y',
    '<script>alert(1)</script>"`$' + '{x}[]{}<>|&*?!#%^=+~\\', '日本語の文 と 全角（かっこ）', 'line1\nline2\r\n\tline3\u0000\u202e',
    'a'.repeat(500), 'short ' + 'ab12'.repeat(10), 'deadbeefdeadbeef0', 'secret-value-8', '',
  ];
  for (const m of nasty) {
    const c = cleanMessage(m, ['secret-value-8']);
    assert.match(c, OK, JSON.stringify(m));
    assert.ok(c.length <= 160, `${c.length}`);
    for (const bad of [acct, tok, jwt.split('.')[2], 'someone', 'example.com', 'evil.example', '<', '"', '`', '$', '{', '[', '\\', '日', '（', '\n', 'secret-value-8', 'deadbeefdeadbeef']) {
      assert.ok(!c.includes(bad), `${JSON.stringify(m)} → ${c}: ${bad}`);
    }
  }
  assert.strictEqual(cleanMessage(`mail ${R.mail('someone')} end`), 'mail (email) end');
  assert.strictEqual(cleanMessage('see https://evil.example/?a=b end'), 'see (url) end');
  assert.strictEqual(cleanMessage(`token ${tok}`), 'token (redacted)');
  assert.strictEqual(cleanMessage('日本語だけ'), '');
  for (const v of [undefined, null, 1, {}, []]) assert.strictEqual(cleanMessage(v), '');
  // why は文を 3 つまで・洗い直して出す（cf の外で作った r でも）。cf-ray と資料の URL も形が合うときだけ
  const w = why({ status: 403, kind: 'json', codes: [10000], messages: ['a1', 'b<2>', `c ${acct}`, 'd4'], doc: 'https://developers.cloudflare.com/x"y', ray: '0123456789abcdef-NRT' });
  assert.strictEqual(w, 'HTTP 403・本文 JSON・Cloudflare のエラー 10000・文「a1」「b2」「c (redacted)」・cf-ray 0123456789abcdef-NRT');
  assert.strictEqual(why({ status: 0, net: 'TypeError' }), '届きません: TypeError');
});

test('HF1: 漏れの確かめ: どれかの道が 2xx なら 1（「ログインせずに中身が見えます」）。Access への 302 なら 0。門の 401・403・503 なら 0 と文。ほかのホストへの 302 は 1。転送を追わない', { timeout: 5000 }, async () => {
  const want = [
    ['open', 1, /失敗: ログインせずに中身が見えます。すぐに Cloudflare の画面で natsu-help の Access を確かめてください/],
    ['open-index', 1, /ログインせずに中身が見えます/],
    ['open-article', 1, /ログインせずに中身が見えます/],
    ['other-302', 1, /ログインせずに中身が見えます/],
    ['same-302', 1, /ログインせずに中身が見えます/],
    ['access-302', 0, /Access に守られています/],
    ['gate-401', 0, /Worker が断りました。natsu-help の Access が有効かを確かめてください（利用者の用意の 1）/],
    ['gate-403', 0, /Worker が断りました。natsu-help の Access が有効かを確かめてください（利用者の用意の 1）/],
    ['gate-503', 0, /準備中（Access の app と秘密の欄がまだ。利用者の用意の 1〜5）/],
    ['flaky', 0, /準備中/],
    ['not-found', 1, /漏れの確かめ.*届きませんでした/],
    ['plain-503', 1, /漏れの確かめ.*届きませんでした/],
    ['plain-403', 0, /Access に守られています/],   // Access の前で止められた（門の印の無い 401・403。Worker まで来ていない）
  ];
  for (const [site, code, re] of want) {
    await withCf({ site, scriptExists: true }, async ({ cf, run }) => {
      const r = await run();
      assert.strictEqual(r.code, code, `${site}: ${r.text}`);
      assert.match(r.text, re, site);
      assert.ok(!r.text.includes(ARTICLE), `${site}: 出力に中身`);
      assert.ok(!seq(cf.st).some((x) => x.includes('/elsewhere')), `${site}: 転送を追った`);
      for (const c of r.calls.filter((x) => x.url.includes('/site'))) {
        assert.strictEqual(c.redirect, 'manual', c.url);
        assert.strictEqual(c.method, 'GET', c.url);
        assert.deepStrictEqual(c.headers, {}, `${c.url}: 見出しを付けた`);
      }
      if (site === 'not-found' || site === 'plain-503') assert.strictEqual(cf.st.siteHits, 12 * 3, `${site}: 12 回まで試していない`);
      if (code === 1 && /^open|302$/.test(site)) assert.ok(cf.st.siteHits <= 3, `${site}: 見えたのに試し続けた`);
    });
  }
  // leakCheck だけでも呼べる（道を選んで）
  const { leakCheck } = require(SCRIPT);
  const fake = (st, headers = {}, body = '') => async () => new Response(body, { status: st, headers });
  let c = await leakCheck({ base: 'https://natsu-help.team-a.workers.dev', paths: ['/'], fetch: fake(200, {}, PAGE), sleep: async () => {} });
  assert.strictEqual(c.ok, false);
  c = await leakCheck({ base: 'https://natsu-help.team-a.workers.dev', paths: ['/'], fetch: fake(302, { location: ACCESS_LOGIN }), sleep: async () => {} });
  assert.strictEqual(c.ok, true);
  c = await leakCheck({ base: 'https://natsu-help.team-a.workers.dev', paths: ['/'], fetch: fake(302, { location: 'https://cloudflareaccess.com.evil.example/' }), sleep: async () => {} });
  assert.strictEqual(c.ok, false, 'ほかのホストを Access に数えた');
  c = await leakCheck({ base: 'https://natsu-help.team-a.workers.dev', paths: ['/'], fetch: fake(204), sleep: async () => {} });
  assert.strictEqual(c.ok, false, '204 を守られているに数えた');
});

test('H-10: 中継の D1 が無い → 作らずに「先に relay-deploy」で 1。D1 を作る要求を出さない', { timeout: 5000 }, async () => {
  await withCf({ dbExists: false }, async ({ cf, run }) => {
    const r = await run();
    assert.strictEqual(r.code, 1, r.text);
    assert.match(r.text, /先に relay-deploy を走らせてください/);
    assert.ok(!seq(cf.st).includes('POST /client/v4/accounts/:acct/d1/database'), 'D1 を作ろうとした');
    assert.strictEqual(cf.st.created, null);
    assert.strictEqual(cf.st.put, null, '上げた');
    assert.strictEqual(cf.st.manifest, null, '資産を上げ始めた');
  });
});

test('HF5: スクリプトの名前は help/deploy-config.json の natsu-help で、relay/deploy-config.json の scriptName と違う。上げるファイルは help-gate.mjs・access.mjs・config.mjs・http.mjs・log.mjs ちょうど', { timeout: 5000 }, async () => {
  assert.deepStrictEqual(Object.keys(CFG).sort(), ['compatibilityDate', 'entry', 'scriptName']);
  assert.strictEqual(CFG.scriptName, 'natsu-help');
  assert.strictEqual(CFG.entry, 'help-gate.mjs');
  assert.notStrictEqual(CFG.scriptName, RELAY_CFG.scriptName);
  assert.match(CFG.compatibilityDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(Date.parse(CFG.compatibilityDate + 'T00:00:00Z') <= Date.now() - 7 * 86400e3, `compatibility_date ${CFG.compatibilityDate} が新しすぎる`);
  await withCf({}, async ({ cf, run }) => {
    const r = await run();
    assert.strictEqual(r.code, 0, r.text);
    assert.ok(seq(cf.st).every((x) => !x.includes(`/workers/scripts/${RELAY_CFG.scriptName}`)), '中継のスクリプトに触れた');
    const files = Object.keys(cf.st.put.parts).filter((k) => k !== 'metadata').sort();
    assert.deepStrictEqual(files, GATE_FILES);
    for (const f of files) {
      assert.strictEqual(cf.st.put.parts[f].type, 'application/javascript+module', f);
      assert.strictEqual(cf.st.put.parts[f].filename, f);
      assert.strictEqual(cf.st.put.parts[f].text, read(`relay/${f}`), f);
    }
  });
});

test('H-10: 資産の指紋は base64 と拡張子の SHA-256 の先頭 32 字。manifest の道は / から始まり、dist の全部のファイルがある', { timeout: 5000 }, async () => {
  await withCf({}, async ({ cf, site, run }) => {
    const r = await run();
    assert.strictEqual(r.code, 0, r.text);
    const want = {};
    for (const [f, c] of Object.entries(site.files)) want['/' + f] = { hash: hashOf(Buffer.from(c), f), size: Buffer.byteLength(c) };
    assert.deepStrictEqual(cf.st.manifest, want);
    // バケットの中身: 欄の名前もファイルの名前も指紋そのもの・中身は base64 の文字・型は拡張子の表（無ければ application/null）
    const byHash = new Map(Object.entries(want).map(([p, m]) => [m.hash, p]));
    const types = { html: 'text/html', json: 'application/json', css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml', woff2: 'font/woff2' };
    for (const part of cf.st.uploads.flat()) {
      const p = byHash.get(part.name);
      assert.ok(p, `知らない指紋 ${part.name}`);
      assert.strictEqual(part.filename, part.name);
      assert.strictEqual(part.text, Buffer.from(site.files[p.slice(1)]).toString('base64'), p);
      assert.strictEqual(part.type.split(';')[0], types[ext(p)] || 'application/null', p);
    }
  });
  // バケットが空なら session の札がそのまま済みの札。manifest に無い指紋を頼まれたら 1。済みの札が来なければ 1
  await withCf({ buckets: 'none' }, async ({ cf, run }) => {
    const r = await run();
    assert.strictEqual(r.code, 0, r.text);
    assert.strictEqual(cf.st.uploads.length, 0);
    assert.strictEqual(cf.st.put.metadata.assets.jwt, cf.st.sessionJwt);
  });
  await withCf({ buckets: 'stray' }, async ({ cf, run }) => {
    const r = await run();
    assert.strictEqual(r.code, 1, r.text);
    assert.strictEqual(cf.st.uploads.length, 0, '知らない指紋を頼まれたのに上げた');
    assert.strictEqual(cf.st.put, null);
  });
  await withCf({ noJwt: true }, async ({ cf, run }) => {
    const r = await run();
    assert.strictEqual(r.code, 1, r.text);
    assert.strictEqual(cf.st.put, null, '済みの札なしで上げた');
  });
});

test('H-10: 作るのに失敗すれば、ファイル・行・符号を出して 1（要求を1つも出さない）。ファイルの数と大きさの上限', { timeout: 5000 }, async () => {
  await withCf({}, async ({ cf, run }) => {
    const err = Object.assign(new Error('生の HTML は書けない'), { name: 'HelpBuildError', file: 'help/articles/start/first.md', line: 12, code: 'raw-html' });
    const r = await run({ build: () => { throw err; } });
    assert.strictEqual(r.code, 1, r.text);
    assert.match(r.text, /help\/articles\/start\/first\.md:12 raw-html/);
    assert.deepStrictEqual(r.tried, []);
  });
  await withCf({}, async ({ cf, site, run }) => {
    const big = () => { const out = site.build({ root: site.root, out: site.dist }); fs.writeFileSync(path.join(site.dist, 'assets', 'big.png'), Buffer.alloc(5 * 1024 * 1024 + 1)); return out; };
    const r = await run({ build: big });
    assert.strictEqual(r.code, 1, r.text);
    assert.match(r.text, /5 MB/);
    assert.deepStrictEqual(r.tried, []);
  });
  await withCf({}, async ({ cf, site, run }) => {
    const many = () => { const out = site.build({ root: site.root, out: site.dist }); for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(site.dist, 'assets', `m${i}.txt`), ''); return out; };
    const r = await run({ build: many });
    assert.strictEqual(r.code, 1, r.text);
    assert.match(r.text, /2000/);
    assert.deepStrictEqual(r.tried, []);
  });
});

test('H-10: 試しの宛先（CF_API_BASE・HELP_CHECK_BASE）は 127.0.0.1 の http だけ。ほかの値なら本物の URL', { timeout: 5000 }, async () => {
  await withCf({}, async ({ cf, run }) => {
    for (const v of ['https://evil.example/client/v4', 'http://localhost:4010/client/v4', 'http://127.0.0.1.example.com:1/x', 'http://' + R.mail('127.0.0.1:4010', 'evil.example:80') + '/client/v4']) {
      const r = await run({ env: { CF_API_BASE: v } });
      assert.strictEqual(r.code, 1, v);
      assert.deepStrictEqual(r.tried.map((u) => new URL(u).origin), ['https://api.cloudflare.com'], v);
      assert.match(r.tried[0], /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[0-9a-f]{32}\/workers\/subdomain$/);
      assert.match(r.text, /届きません/);
    }
    assert.deepStrictEqual(cf.st.reqs, []);
    for (const v of ['http://evil.example:8443/site', 'http://localhost:4010/site']) {
      const r = await run({ env: { HELP_CHECK_BASE: v } });
      assert.strictEqual(r.code, 1, v);
      const checks = r.calls.filter((c) => c.method === 'GET' && !c.url.includes('/client/v4/'));
      assert.strictEqual(checks.length, 12 * 3, v);
      assert.deepStrictEqual([...new Set(checks.map((c) => new URL(c.url).origin))], ['https://natsu-help.team-a.workers.dev'], v);
    }
  });
});

test('H-10: 秘密が足りない・形が違う → 平易な文で 1・要求を出さない。main への push で2つとも無ければ何もせず 0。サブドメインが無ければ 1', { timeout: 5000 }, async () => {
  await withCf({}, async ({ s, cf, run }) => {
    for (const env of [{ CLOUDFLARE_API_TOKEN: undefined }, { CLOUDFLARE_ACCOUNT_ID: 'not-an-id' }, { CLOUDFLARE_API_TOKEN: 'two words' }]) {
      const r = await run({ env });
      assert.strictEqual(r.code, 1, JSON.stringify(env));
      assert.match(r.text, /ヘルプを出せません: /);
      assert.match(r.text, /Settings → Environments → relay/);
      assert.ok(!r.text.includes(s.token) && !r.text.includes('two words') && !r.text.includes('not-an-id'), '値を出した');
    }
    const push = await run({ env: { CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_ACCOUNT_ID: undefined, GITHUB_EVENT_NAME: 'push' } });
    assert.strictEqual(push.code, 0, push.text);
    assert.match(push.text, /ヘルプの秘密がまだ用意されていないので出しません/);
    assert.deepStrictEqual(cf.st.reqs, []);
    const gh = await run({ env: { CLOUDFLARE_API_TOKEN: undefined, GITHUB_ACTIONS: 'true' } });
    assert.match(gh.text, /^::error::ヘルプを出せません: 秘密が足りません。/m);
  });
  await withCf({ subdomain: '' }, async ({ cf, run }) => {
    const r = await run();
    assert.strictEqual(r.code, 1, r.text);
    assert.match(r.text, /workers\.dev のサブドメインを決めてください/);
    assert.deepStrictEqual(seq(cf.st), ['GET /client/v4/accounts/:acct/workers/subdomain']);
  });
});

test('HF5: 転送（3xx）を追わない。API の答えが転送なら止まる（トークンを付けたまま別の宛先へ行かない）。どの要求も redirect: manual', { timeout: 5000 }, async () => {
  for (const redirect of [{ method: 'GET', re: /\/workers\/subdomain$/ }, { method: 'POST', re: /\/workers\/assets\/upload$/ }]) {
    await withCf({ redirect }, async ({ s, cf, run }) => {
      const r = await run();
      assert.strictEqual(r.code, 1, r.text);
      assert.ok(!seq(cf.st).includes('GET /client/v4/moved') && !seq(cf.st).includes('POST /client/v4/moved'), '転送の先へ行った');
      assert.ok(!r.text.includes(s.token) && !r.text.includes(s.acct));
      for (const c of r.calls) assert.strictEqual(c.redirect, 'manual', c.url);
    });
  }
});

test('H-10: help-deploy は Node に入っている部品だけを使う（wrangler も npm の依存も無い）', { timeout: 5000 }, () => {
  for (const f of ['tools/help-deploy.js', 'tools/lib/cf-api.js']) {
    const src = read(f);
    const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    if (f === 'tools/help-deploy.js') assert.ok(mods.length > 0, f);   // cf-api.js はグローバルの fetch・FormData だけで、何も読まない
    for (const m of mods) assert.match(m, /^(node:|\.\/lib\/cf-api$|\.\/help-build$)/, `${f}: ${m}`);
    const code = src.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/wrangler/i.test(code), `${f}: wrangler を使っている`);
    // Workers の fetch と同じ決まり: redirect は manual（error は Workers で TypeError・follow は札を運ぶ）。relay-deploy だけは今の 'error' を渡す
    for (const m of code.matchAll(/redirect\s*:\s*(['"`])([^'"`]*)\1/g)) assert.strictEqual(m[2], 'manual', `${f}: redirect: '${m[2]}'`);
    assert.ok(!/'follow'/.test(code), `${f}: follow`);
  }
  const pkg = JSON.parse(read('package.json'));
  assert.ok(!pkg.dependencies, 'dependencies がある');
  assert.deepStrictEqual(Object.keys(pkg.devDependencies).sort(), ['electron', 'electron-builder']);
});

// ---------------------------------------------------------------- ワークフローの形（HF5・R5）
test('H-10: help-deploy.yml は手で押すか main への push だけ・main の枝・環境 relay・ヘルプのテストの後に出す・CF_ACCESS_ を参照しない・run の中に ${{ }} の式を書かない', { timeout: 5000 }, () => {
  const y = read(WF);
  assert.ok(!/\t/.test(y), 'タブがある');
  assert.ok(!/pull_request/.test(y), 'pull_request で走る');
  const on = y.slice(y.indexOf('\non:\n'), y.indexOf('\npermissions:\n'));
  assert.match(on, /^  workflow_dispatch:\s*$/m);
  assert.match(on, /^  push:\n    branches: \[main\]\n/m);
  assert.ok(!/^  (schedule|workflow_run|workflow_call|repository_dispatch|issue|release)/m.test(on), on);
  const paths = /^    paths: \[(.+)\]$/m.exec(on);
  assert.ok(paths, 'paths が無い');
  assert.deepStrictEqual(paths[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')), ['help/**', 'relay/help-gate.mjs', 'relay/access.mjs', 'relay/config.mjs', 'relay/http.mjs', 'relay/log.mjs',
    'tools/help-build.js', 'tools/lib/help-*.js', 'tools/lib/cf-api.js', 'tools/help-deploy.js', '.github/workflows/help-deploy.yml']);
  assert.match(y, /\npermissions:\n  contents: read\n(?! )/);
  assert.strictEqual((y.match(/permissions:/g) || []).length, 1, 'permissions がほかにもある');
  assert.match(y, /^concurrency:\n  group: help-deploy\n  cancel-in-progress: false$/m);
  const jobs = jobsOf(y);
  assert.deepStrictEqual(Object.keys(jobs), ['deploy']);
  const job = jobs.deploy;
  assert.match(job, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(job, /^    environment: relay(\s+#.*)?$/m);
  assert.match(job, /^    runs-on: ubuntu-latest$/m);
  assert.match(job, /^    timeout-minutes: 10$/m);
  const st = stepsOf(job);
  const co = st.find((s) => /uses: actions\/checkout@v4/.test(s));
  assert.ok(co && /^\s+persist-credentials: false$/m.test(co), 'checkout が persist-credentials: false でない');
  const uses = [...y.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.deepStrictEqual(uses, ['actions/checkout@v4', 'actions/setup-node@v4']);
  assert.deepStrictEqual([...y.matchAll(/node-version: '([^']+)'/g)].map((m) => m[1]), ['24']);
  const names = st.map(nameOf);
  const iTest = names.indexOf('ヘルプのテスト');
  const iDeploy = names.indexOf('ヘルプを出す');
  assert.ok(iTest >= 0 && iDeploy > iTest, `ヘルプのテストがヘルプを出すより前に無い: ${names.join(' / ')}`);
  assert.match(st[iTest], /^\s+run: node --test --test-reporter=tap "test\/help-\*\.test\.js"$/m);
  assert.match(st[iDeploy], /^\s+run: node tools\/help-deploy\.js$/m);
  // 秘密を参照するのは「ヘルプを出す」の env の2つだけ（Access のサービストークンは渡さない: R5）
  const refs = y.match(/secrets\./g) || [];
  assert.strictEqual(refs.length, 2, `secrets. が ${refs.length} か所`);
  const env = st[iDeploy].slice(st[iDeploy].indexOf('env:'), st[iDeploy].indexOf('run:'));
  assert.match(env, /^\s+CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}$/m);
  assert.match(env, /^\s+CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}$/m);
  const cfLines = y.split('\n').filter((l) => /CLOUDFLARE_/.test(l) && !/^\s*#/.test(l));
  assert.strictEqual(cfLines.length, 2, cfLines.join(' / '));
  for (const l of cfLines) assert.ok(env.includes(l), `「ヘルプを出す」の env の外で CLOUDFLARE_: ${l.trim()}`);
  assert.ok(!/CF_ACCESS_/.test(y), 'CF_ACCESS_ を参照する');
  assert.ok(!/secrets: inherit|toJSON\(secrets\)/.test(y));
  for (const s of st) {
    const i = s.search(/^\s*run:/m);
    if (i >= 0) assert.ok(!/\$\{\{/.test(s.slice(i)), `run の中に式: ${nameOf(s)}`);
  }
  assert.ok(!/github\.event\.|inputs\./.test(y), 'github.event・inputs を読む');
  const runs = y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/\becho\b/.test(runs), 'echo がある');
  assert.ok(!/set -x|set -o xtrace|ACTIONS_STEP_DEBUG/.test(runs), 'set -x がある');
  // YAML の書き方（引用符の無い値に「: 」が無い・段の名前は 200 バイトまで）
  const bad = [];
  y.split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*(?:- )?[A-Za-z0-9_-]+:[ ]+(.+)$/.exec(line);
    if (!m) return;
    const v = m[1].replace(/\s+#.*$/, '');
    if (/^['"|>{[&*!#]/.test(v)) return;
    if (/: /.test(v) || /:$/.test(v)) bad.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepStrictEqual(bad, []);
  for (const m of y.matchAll(/^\s*- name: (.+)$/gm)) assert.ok(Buffer.byteLength(m[1], 'utf8') <= 200, m[1]);
});

test('H-10: ヘルプの出し方はアプリに入らない（build.files は src・assets・package.json だけ）', { timeout: 5000 }, () => {
  const pkg = JSON.parse(read('package.json'));
  for (const f of pkg.build.files) assert.ok(!/help|tools|relay/.test(f), f);
});
