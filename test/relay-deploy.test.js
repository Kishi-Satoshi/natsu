/* relay-deploy.test.js — 第1d回 RL8・F6・F10: 中継の出し方（tools/relay-deploy.js と .github/workflows/relay-deploy.yml）
 *
 * 偽の Cloudflare の API と偽の /health を 127.0.0.1 に開き、台本の deploy() を「127.0.0.1 のほかは断る fetch」で呼ぶ
 * （本物の Cloudflare へは決して出ない）。秘密の無いときの終わり方（0／1）だけは、子のプロセスで台本そのものを走らせて見る
 * （そのときは要求を1つも出さずに終わる）。
 * GitHub Actions は手元で回せないので、ワークフローは文字列として読む（test/helpers/yml.js）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const R = require('./helpers/relay-run');
const { makeFakeD1 } = require('./helpers/fake-d1');
const { jobsOf, stepsOf, nameOf } = require('./helpers/yml');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SCRIPT = path.join(ROOT, 'tools', 'relay-deploy.js');
const WF = '.github/workflows/relay-deploy.yml';
let CFG = {};
try { CFG = JSON.parse(read('relay/deploy-config.json')); } catch (_) { /* 無ければ、使うテストが落ちる */ }
// ヘルプセンター H-10 で意図して変えた: 中継の Worker に上げるのは relay/ の help- で始まらない .mjs だけ（門の help-gate.mjs は
// ヘルプの出し方 help-deploy が natsu-help に上げる。中継の Worker には上げない）
const MJS = fs.readdirSync(path.join(ROOT, 'relay')).filter((f) => f.endsWith('.mjs') && !f.startsWith('help-')).sort();
const READY_ALL = { db: true, openai: true, access: true, domains: true };   // W-5 の /health の ready（mail は外れた）

// ---------------------------------------------------------------- 偽の Cloudflare の API（127.0.0.1）
// opts: subdomain（'' なら無い）・dbExists・scriptExists・health（'ok'｜'partial'｜'no-db'｜'503'｜'redirect'｜D-2 の下の形）・
//       svc（{ id, secret }。health が 'svc' のとき、/health はこの2つの見出しがちょうど合うときだけ 200、ほかは中継の 401 login）・
//       fail（{ method, re }。当たった要求に 403 と、トークン・アカウントの ID・本文の印を入れた答えを返す）・
//       redirect（{ method, re }。当たった要求に 302 で同じ偽物の /client/v4/moved を返す。/moved は 200 の整った答え）
// D-2 の health: 'no-access'（ready.access がまだ）・'login'（中継の JSON の 401 login）・'denied'（中継の JSON の 403 denied）・
//   'access-302'（Access の前の 302。行き先は同じ偽物の /cdn-cgi/access/login/…。そこへ来た要求は reqs に残る）・
//   'access-401'／'access-403'（中継の形でない HTML の 401／403）・'not-ready'（中継の JSON の 503 not-ready）・'svc'（上の svc）
async function fakeCf({ token, acct, subdomain = 'team-a', dbExists = false, scriptExists = false, health = 'ok', fail = null, redirect = null, svc = null } = {}) {
  const st = { reqs: [], dbs: dbExists ? [{ uuid: crypto.randomUUID(), name: CFG.dbName }] : [], scriptExists, created: null, sql: [], put: null, sub: null, d1: makeFakeD1() };
  const A = `/client/v4/accounts/${acct}`;
  let base = '';
  const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
  const ok = (res, result) => send(res, 200, { success: true, errors: [], messages: [], result });
  const nf = (res, code = 7003) => send(res, 404, { success: false, errors: [{ code, message: 'Could not route' }], result: null });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://127.0.0.1');
      const p = u.pathname;
      st.reqs.push({ method: req.method, path: (p + u.search).split(acct).join(':acct'), auth: req.headers.authorization || '', body: raw.toString('latin1'),
        svcId: req.headers['cf-access-client-id'], svcSecret: req.headers['cf-access-client-secret'] });
      try {
        if (fail && fail.method === req.method && fail.re.test(p)) {
          return send(res, 403, { success: false, errors: [{ code: 10000, message: `Authentication error ${token} ${acct}` }], messages: [`body-mark-zz ${token}`], result: { note: `body-mark-zz ${acct}` } });
        }
        if (redirect && redirect.method === req.method && redirect.re.test(p)) {
          res.writeHead(302, { location: '/client/v4/moved' }); return res.end();
        }
        if (p === '/client/v4/moved') return ok(res, { subdomain: 'team-a' });
        if (p === '/relay/health-moved') return send(res, 200, { ok: true, relay: 2, ready: READY_ALL });
        if (p.startsWith('/cdn-cgi/access/login')) return send(res, 200, { ok: true, relay: 2, ready: READY_ALL });   // ここへ来たら転送を追った
        if (p === '/relay/health' && req.method === 'GET') {
          if (health === 'redirect') { res.writeHead(302, { location: '/relay/health-moved' }); return res.end(); }
          if (health === '503') return send(res, 503, { ok: true, relay: 2, ready: READY_ALL });   // 本文が整っていても 200 でなければ数えない
          if (health === 'access-302') { res.writeHead(302, { location: `${base}/cdn-cgi/access/login/natsu-relay?redirect_url=%2Fhealth` }); return res.end(); }
          if (health === 'access-401') return send(res, 401, '<html><body>Unauthorized</body></html>', 'text/html');
          if (health === 'access-403') return send(res, 403, '<html><body>Forbidden</body></html>', 'text/html');
          if (health === 'login') return send(res, 401, { error: 'login' });
          if (health === 'denied') return send(res, 403, { error: 'denied' });
          if (health === 'not-ready') return send(res, 503, { error: 'not-ready' });
          if (health === 'svc' && !(svc && req.headers['cf-access-client-id'] === svc.id && req.headers['cf-access-client-secret'] === svc.secret)) {
            return send(res, 401, { error: 'login' });
          }
          const ready = health === 'partial' ? { db: true, openai: false, access: false, domains: false }
            : health === 'no-db' ? { ...READY_ALL, db: false }
              : health === 'no-access' ? { ...READY_ALL, access: false } : READY_ALL;
          return send(res, 200, { ok: true, relay: 2, ready });
        }
        if (req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { success: false, errors: [{ code: 10001 }] });
        if (req.method === 'GET' && p === `${A}/workers/subdomain`) {
          return subdomain ? ok(res, { subdomain }) : nf(res, 10007);
        }
        if (req.method === 'GET' && p === `${A}/d1/database`) return ok(res, st.dbs.filter((d) => d.name.includes(u.searchParams.get('name') || '')));
        if (req.method === 'POST' && p === `${A}/d1/database`) {
          st.created = JSON.parse(raw.toString('utf8'));
          const d = { uuid: crypto.randomUUID(), name: st.created.name };
          st.dbs.push(d);
          return ok(res, d);
        }
        const q = new RegExp(`^${A}/d1/database/([0-9a-f-]{36})/query$`).exec(p);
        if (req.method === 'POST' && q && st.dbs.some((d) => d.uuid === q[1])) {
          const { sql } = JSON.parse(raw.toString('utf8'));
          st.sql.push({ uuid: q[1], sql });
          await st.d1.exec(sql);   // 本当に SQLite で流せる形か
          return ok(res, [{ success: true, results: [] }]);
        }
        const S = `${A}/workers/scripts/${CFG.scriptName}`;
        if (req.method === 'GET' && p === S) return st.scriptExists ? send(res, 200, 'export default {}', 'application/javascript') : nf(res, 10007);
        if (req.method === 'PUT' && p === S) {
          const fd = await new Response(raw, { headers: { 'content-type': req.headers['content-type'] } }).formData();
          const parts = {};
          for (const [k, v] of fd.entries()) parts[k] = typeof v === 'string' ? { text: v } : { type: v.type, filename: v.name, text: await v.text() };
          st.put = { contentType: req.headers['content-type'], parts, metadata: JSON.parse(parts.metadata.text) };
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
  base = `http://127.0.0.1:${server.address().port}`;
  return { st, base, close: () => { st.d1.close(); return new Promise((r) => server.close(r)); } };
}

// 台本の deploy() を、偽物へだけ向けて呼ぶ。out の行と console に出たものを全部まとめて返す
async function runDeploy(cf, { token, acct, env = {}, attempts } = {}) {
  const { deploy } = require(SCRIPT);
  const e = {
    CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: acct,
    CF_API_BASE: `${cf.base}/client/v4`, RELAY_HEALTH_BASE: `${cf.base}/relay`, GITHUB_EVENT_NAME: 'workflow_dispatch',
  };
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete e[k]; else e[k] = v; }
  const out = [];
  const tried = [];
  const calls = [];   // { url, headers（小文字の名前）, redirect }。外へ出なかった要求（127.0.0.1 のほか）も残る
  const guarded = R.loopbackOnlyFetch(globalThis.fetch);
  const fetch = (input, init) => {
    const url = String(input && input.url ? input.url : input);
    tried.push(url);
    const headers = {};
    for (const [k, v] of new Headers((init && init.headers) || {}).entries()) headers[k] = v;
    calls.push({ url, headers, redirect: init && init.redirect });
    return guarded(input, init);
  };
  const realErr = console.error, realWarn = console.warn;
  const errs = [];
  console.error = (...a) => errs.push(a.join(' ')); console.warn = console.error;
  let code;
  try {
    const logged = await R.captureConsole(async () => { code = await deploy({ env: e, fetch, out: (l) => out.push(String(l)), sleep: async () => {} }); });
    return { code, text: [...out, ...logged, ...errs].join('\n'), out, tried, calls };
  } finally { console.error = realErr; console.warn = realWarn; }
}

const secrets = () => ({ token: 'cf-test-token-' + crypto.randomBytes(12).toString('hex'), acct: crypto.randomBytes(16).toString('hex') });
const seq = (st) => st.reqs.map((r) => `${r.method} ${r.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, ':db')}`);

// ---------------------------------------------------------------- 台本の動き
test('R3: relay/ に help-gate.mjs があっても、中継の Worker には上げない（上げるのは help- で始まらない .mjs だけ）', { timeout: 5000 }, async () => {
  const all = fs.readdirSync(path.join(ROOT, 'relay')).filter((f) => f.endsWith('.mjs'));
  assert.ok(all.includes('help-gate.mjs'), 'relay/help-gate.mjs が無い（この照らしが空振りする）');
  const s = secrets();
  const cf = await fakeCf({ ...s, dbExists: true, scriptExists: true });
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 0, r.text);
    const up = Object.keys(cf.st.put.parts).filter((k) => k !== 'metadata').sort();
    assert.ok(!up.some((f) => f.startsWith('help-')), `中継に門を上げた: ${up.join(',')}`);
    assert.deepStrictEqual(up, all.filter((f) => !f.startsWith('help-')).sort());
    assert.match(r.text, new RegExp(`5/7 Worker を上げる（${up.length} ファイル）`));
  } finally { await cf.close(); }
});

test('RL8: 1回目は D1 を作り（apac）、表の形を流し、keep_bindings なしで上げ、workers.dev を有効にし、/health を確かめる', { timeout: 5000 }, async () => {
  const s = secrets();
  const cf = await fakeCf(s);
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual(seq(cf.st), [
      'GET /client/v4/accounts/:acct/workers/subdomain',
      `GET /client/v4/accounts/:acct/d1/database?name=${CFG.dbName}`,
      'POST /client/v4/accounts/:acct/d1/database',
      'POST /client/v4/accounts/:acct/d1/database/:db/query',
      `GET /client/v4/accounts/:acct/workers/scripts/${CFG.scriptName}`,
      `PUT /client/v4/accounts/:acct/workers/scripts/${CFG.scriptName}`,
      `POST /client/v4/accounts/:acct/workers/scripts/${CFG.scriptName}/subdomain`,
      'GET /relay/health',
    ]);
    assert.deepStrictEqual(cf.st.created, { name: 'natsu-relay', primary_location_hint: 'apac' });
    const uuid = cf.st.dbs[0].uuid;
    const { SCHEMA_SQL } = await R.load('schema.mjs');
    assert.deepStrictEqual(cf.st.sql, [{ uuid, sql: SCHEMA_SQL }]);
    assert.strictEqual(await cf.st.d1.prepare("SELECT value FROM meta WHERE key = 'schema'").first('value'), '2');   // 第1d回 W-6: 表の形 v2
    const put = cf.st.put;
    assert.match(put.contentType, /^multipart\/form-data; boundary=/);
    assert.deepStrictEqual(put.metadata, {
      main_module: 'worker.mjs', compatibility_date: CFG.compatibilityDate,
      bindings: [{ type: 'd1', name: 'DB', database_id: uuid }],
      observability: { enabled: true, logs: { enabled: true, invocation_logs: false } },
    });
    assert.ok(MJS.includes('worker.mjs') && MJS.length >= 5, MJS.join(','));
    assert.deepStrictEqual(Object.keys(put.parts).filter((k) => k !== 'metadata').sort(), MJS, 'relay/*.mjs の全部を上げていない');
    for (const f of MJS) {
      assert.strictEqual(put.parts[f].type, 'application/javascript+module', f);
      assert.strictEqual(put.parts[f].filename, f);
      assert.strictEqual(put.parts[f].text, read(`relay/${f}`), f);
    }
    assert.deepStrictEqual(cf.st.sub, { enabled: true, previews_enabled: false });
    assert.match(r.text, /公開した URL: https:\/\/natsu-relay\.team-a\.workers\.dev$/m);
    assert.match(r.text, /ready: db はい・openai はい・access はい・domains はい$/m);
    assert.ok(!/秘密の欄を入れてください/.test(r.text));
  } finally { await cf.close(); }
});

test('RL8: 2回目からは D1 を作らず、keep_bindings: [secret_text] で上げる（画面で入れた秘密を残す）', { timeout: 5000 }, async () => {
  const s = secrets();
  const cf = await fakeCf({ ...s, dbExists: true, scriptExists: true });
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 0, r.text);
    assert.ok(!seq(cf.st).includes('POST /client/v4/accounts/:acct/d1/database'), 'D1 をもう一度作った');
    assert.deepStrictEqual(cf.st.put.metadata.keep_bindings, ['secret_text']);
    assert.deepStrictEqual(cf.st.put.metadata.bindings, [{ type: 'd1', name: 'DB', database_id: cf.st.dbs[0].uuid }]);
    assert.strictEqual(cf.st.sql.length, 1, '2回目も表の形を流す（足すだけの形）');
  } finally { await cf.close(); }
});

test('F6: 秘密の値・plain_text のバインドを送らない。トークンは API への Authorization にだけ入り、出力にトークンとアカウントの ID が無い', { timeout: 5000 }, async () => {
  const s = secrets();
  for (const exists of [false, true]) {
    const cf = await fakeCf({ ...s, dbExists: exists, scriptExists: exists });
    try {
      const r = await runDeploy(cf, { ...s, env: { OPENAI_API_KEY: 'sk-must-not-send-1', RESEND_API_KEY: 're-must-not-send-2' } });
      assert.strictEqual(r.code, 0, r.text);
      for (const q of cf.st.reqs) {
        const api = q.path.startsWith('/client/v4/');
        assert.strictEqual(q.auth, api ? `Bearer ${s.token}` : '', `${q.method} ${q.path}: Authorization`);
        assert.ok(!q.body.includes(s.token), `${q.method} ${q.path}: 本文にトークン`);
        assert.ok(!/must-not-send/.test(q.body), `${q.method} ${q.path}: 本文に秘密の値`);
        assert.ok(!q.path.includes(s.token), 'URL にトークン');
      }
      assert.ok(cf.st.put.metadata.bindings.every((b) => b.type === 'd1'), JSON.stringify(cf.st.put.metadata.bindings));
      assert.ok(!/plain_text|"text"\s*:/.test(cf.st.put.parts.metadata.text), cf.st.put.parts.metadata.text);
      assert.ok(!r.text.includes(s.token), '出力にトークン');
      assert.ok(!r.text.includes(s.acct), '出力にアカウントの ID');
    } finally { await cf.close(); }
  }
});

test('F6: 呼び出しごとの記録を止める（observability.logs.invocation_logs === false。記録そのものは有効）', { timeout: 5000 }, async () => {
  const s = secrets();
  const cf = await fakeCf({ ...s, scriptExists: true, dbExists: true });
  try {
    assert.strictEqual((await runDeploy(cf, s)).code, 0);
    assert.deepStrictEqual(cf.st.put.metadata.observability, { enabled: true, logs: { enabled: true, invocation_logs: false } });
  } finally { await cf.close(); }
});

test('F6: 失敗の答えの本文を出さない（Cloudflare が本文にトークンを入れて返しても）。出すのは手順・状態の番号・エラーの番号・本文の形・洗ったエラーの文だけ', { timeout: 5000 }, async () => {
  const s = secrets();
  for (const fail of [{ method: 'PUT', re: /\/workers\/scripts\/natsu-relay$/ }, { method: 'GET', re: /\/workers\/subdomain$/ }, { method: 'POST', re: /\/query$/ }]) {
    const cf = await fakeCf({ ...s, fail });
    try {
      const r = await runDeploy(cf, s);
      assert.strictEqual(r.code, 1, r.text);
      assert.match(r.text, /HTTP 403/);
      assert.match(r.text, /10000/);
      assert.match(r.text, /トークンの権限/);
      // ヘルプの 4/9 の 403 の調べ（run 39520207427）で意図して変えた: 本文の形と、洗った errors[].message（トークン・アカウントの ID は伏せる）を出す。
      // ほかの本文（messages・result）は今までどおり出さない
      assert.match(r.text, /（HTTP 403・本文 JSON・Cloudflare のエラー 10000・文「Authentication error \(redacted\) \(redacted\)」）/);
      for (const bad of [s.token, s.acct, 'body-mark-zz']) assert.ok(!r.text.includes(bad), `出力に ${bad}`);
      assert.ok(!seq(cf.st).some((x) => x.endsWith('/subdomain') && x.startsWith('POST')), '失敗の後も先へ進んだ');
    } finally { await cf.close(); }
  }
});

test('RL8: サブドメインが無い・トークンが無い・アカウントの ID の形が違う → 平易な文で 1 で終わり、何も上げない', { timeout: 5000 }, async () => {
  const s = secrets();
  let cf = await fakeCf({ ...s, subdomain: '' });
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 1);
    assert.match(r.text, /Cloudflare の画面の Workers & Pages で、workers\.dev のサブドメインを決めてください（会社名を含まない名前）/);
    assert.deepStrictEqual(seq(cf.st), ['GET /client/v4/accounts/:acct/workers/subdomain']);
  } finally { await cf.close(); }
  cf = await fakeCf(s);
  try {
    for (const env of [{ CLOUDFLARE_API_TOKEN: undefined }, { CLOUDFLARE_API_TOKEN: '' }, { CLOUDFLARE_ACCOUNT_ID: 'not-an-id' }, { CLOUDFLARE_ACCOUNT_ID: s.acct.toUpperCase() }, { CLOUDFLARE_API_TOKEN: 'two words' }]) {
      const r = await runDeploy(cf, { ...s, env });
      assert.strictEqual(r.code, 1, JSON.stringify(env));
      assert.match(r.text, /Settings → Environments → relay/, JSON.stringify(env));
      assert.ok(!r.text.includes(s.token) && !r.text.includes('two words') && !r.text.includes('not-an-id'), '値を出した');
    }
    assert.deepStrictEqual(cf.st.reqs, [], '秘密が足りないのに要求を出した');
  } finally { await cf.close(); }
});

test('RL8: /health が 200 にならなければ 1・ready に「まだ」があれば名前を出して 0・D1 の表が見えなければ 1', { timeout: 5000 }, async () => {
  const s = secrets();
  let cf = await fakeCf({ ...s, health: '503' });
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 1, r.text);
    assert.strictEqual(seq(cf.st).filter((x) => x === 'GET /relay/health').length, 12, '12 回まで試していない');
    assert.match(r.text, /\/health に届きませんでした（HTTP 503）/);
    assert.ok(!/公開した URL/.test(r.text), '届かないのに「公開した」と言った');
  } finally { await cf.close(); }
  cf = await fakeCf({ ...s, health: 'partial' });
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 0, r.text);
    assert.match(r.text, /ready: db はい・openai まだ・access まだ・domains まだ/);
    assert.match(r.text, /Cloudflare の画面で秘密の欄を入れてください: OPENAI_API_KEY・ALLOWED_EMAIL_DOMAINS（/);
    assert.match(r.text, /Cloudflare の画面で TEAM_DOMAIN と POLICY_AUD を入れてください（利用者の用意の 8/);
  } finally { await cf.close(); }
  cf = await fakeCf({ ...s, health: 'no-db' });
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 1, r.text);
    assert.match(r.text, /D1 の表が見えません/);
  } finally { await cf.close(); }
});

test('RF38: 試しの宛先（CF_API_BASE・RELAY_HEALTH_BASE）は 127.0.0.1 の http だけ。ほかの値なら本物の Cloudflare の URL（トークンをほかのホストへ運ばない）', { timeout: 5000 }, async () => {
  const s = secrets();
  const cf = await fakeCf(s);
  try {
    for (const v of ['https://evil.example/client/v4', 'http://localhost:1/client/v4', 'http://127.0.0.1.example.com:1/x',
      'http://evil.example:8443/client/v4', 'http://localhost:4010/client/v4', 'http://' + R.mail('127.0.0.1:4010', 'evil.example:80') + '/client/v4']) {
      const r = await runDeploy(cf, { ...s, env: { CF_API_BASE: v } });
      assert.strictEqual(r.code, 1, v);
      assert.deepStrictEqual(r.tried.map((u) => new URL(u).origin), ['https://api.cloudflare.com'], v);
      assert.match(r.tried[0], /^https:\/\/api\.cloudflare\.com\/client\/v4\/accounts\/[0-9a-f]{32}\/workers\/subdomain$/);
      assert.match(r.text, /届きません/);
    }
    assert.deepStrictEqual(cf.st.reqs, []);
    // /health の試しの宛先も同じ。127.0.0.1 の形でなければ、本物の workers.dev の住所を見る
    for (const v of ['http://evil.example:8443/relay', 'http://localhost:4010/relay']) {
      const r = await runDeploy(cf, { ...s, env: { RELAY_HEALTH_BASE: v } });
      assert.strictEqual(r.code, 1, v);
      const health = r.tried.filter((u) => /\/health$/.test(u));
      assert.strictEqual(health.length, 12, v);
      assert.ok(health.every((u) => u === 'https://natsu-relay.team-a.workers.dev/health'), health[0]);
    }
  } finally { await cf.close(); }
});

test('F6: 転送（3xx）を追わない。API の答えが転送なら止まり、/health の転送は「届いた」に数えない（トークンを付けたまま別の宛先へ行かない）', { timeout: 5000 }, async () => {
  const s = secrets();
  let cf = await fakeCf({ ...s, redirect: { method: 'GET', re: /\/workers\/subdomain$/ } });
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 1, r.text);
    assert.deepStrictEqual(seq(cf.st), ['GET /client/v4/accounts/:acct/workers/subdomain'], '転送の先へ行った');
    assert.ok(!r.text.includes(s.token) && !r.text.includes(s.acct));
  } finally { await cf.close(); }
  cf = await fakeCf({ ...s, health: 'redirect' });
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 1, r.text);
    assert.ok(!seq(cf.st).includes('GET /relay/health-moved'), '/health の転送の先へ行った');
    assert.ok(!/公開した URL/.test(r.text), '転送を「届いた」に数えた');
  } finally { await cf.close(); }
});

// ---------------------------------------------------------------- /health のサービストークン（D-2。RL8・F23・F28）
// サービストークンの形（Client ID は 32 けたの16進と .access・Client Secret は空白の無い字）。値は場面ごとに乱数で作る
const svcPair = () => ({ id: crypto.randomBytes(16).toString('hex') + '.access', secret: crypto.randomBytes(32).toString('hex') });
const svcEnv = (svc) => ({ CF_ACCESS_CLIENT_ID: svc.id, CF_ACCESS_CLIENT_SECRET: svc.secret });
const HEALTH = 'GET /relay/health';
const noSvcValues = (text, svc) => {
  for (const bad of [svc.id, svc.id.slice(0, 32), svc.secret, svc.secret.slice(0, 16)]) assert.ok(!text.includes(bad), `出力にサービストークンの値: ${bad.slice(0, 6)}…`);
};

test('RL8: 2つの秘密があれば /health の要求にだけ CF-Access-Client-Id と CF-Access-Client-Secret が付き、Cloudflare の API の要求には付かない', { timeout: 5000 }, async () => {
  const s = secrets();
  const svc = svcPair();
  const cf = await fakeCf({ ...s, health: 'svc', svc });
  try {
    const r = await runDeploy(cf, { ...s, env: svcEnv(svc) });
    assert.strictEqual(r.code, 0, r.text);
    assert.match(r.text, /ready: db はい・openai はい・access はい・domains はい$/m);
    const health = cf.st.reqs.filter((q) => `${q.method} ${q.path}` === HEALTH);
    assert.strictEqual(health.length, 1);
    assert.strictEqual(health[0].svcId, svc.id);
    assert.strictEqual(health[0].svcSecret, svc.secret);
    assert.strictEqual(health[0].auth, '', '/health に Cloudflare の API のトークン');
    const api = cf.st.reqs.filter((q) => q.path.startsWith('/client/v4/'));
    assert.ok(api.length >= 7, seq(cf.st).join(' / '));
    for (const q of api) {
      assert.strictEqual(q.svcId, undefined, `${q.method} ${q.path}: CF-Access-Client-Id`);
      assert.strictEqual(q.svcSecret, undefined, `${q.method} ${q.path}: CF-Access-Client-Secret`);
      assert.ok(!q.body.includes(svc.secret) && !q.body.includes(svc.id), `${q.method} ${q.path}: 本文にサービストークン`);
    }
    // 秘密が無ければ /health にも付けない（偽物は 401 login を返し、push でなければ 1）
    const cf2 = await fakeCf({ ...s, health: 'svc', svc });
    try {
      const r2 = await runDeploy(cf2, s);
      assert.strictEqual(r2.code, 1, r2.text);
      assert.ok(cf2.st.reqs.every((q) => q.svcId === undefined && q.svcSecret === undefined));
    } finally { await cf2.close(); }
  } finally { await cf.close(); }
});

test('F23: 出力（標準出力と標準エラー）に Client ID と Secret が無い。宛先が本物の workers.dev か試しの 127.0.0.1 でないとき（RELAY_HEALTH_BASE: \'http://evil.example:8443\'）は見出しを付けない', { timeout: 5000 }, async () => {
  const s = secrets();
  const svc = svcPair();
  for (const health of ['svc', 'login', 'denied', 'not-ready', 'access-302', 'access-401', 'access-403', 'no-access', '503']) {
    const cf = await fakeCf({ ...s, health, svc });
    try {
      for (const ev of ['push', 'workflow_dispatch']) {
        const r = await runDeploy(cf, { ...s, env: { ...svcEnv(svc), GITHUB_EVENT_NAME: ev, GITHUB_ACTIONS: 'true' } });
        noSvcValues(r.text, svc);
        assert.ok(r.text.length > 0, health);
      }
    } finally { await cf.close(); }
  }
  // /health の宛先が試しの形でなければ、見る先は本物の workers.dev の住所だけ（evil.example へは見出しどころか要求も出さない）
  const cf = await fakeCf({ ...s, svc });
  try {
    for (const v of ['http://evil.example:8443', 'http://evil.example:8443/relay', 'https://natsu-relay.team-a.workers.dev.evil.example']) {
      const r = await runDeploy(cf, { ...s, env: { ...svcEnv(svc), RELAY_HEALTH_BASE: v } });
      assert.strictEqual(r.code, 1, v);
      noSvcValues(r.text, svc);
      assert.ok(!r.calls.some((c) => /evil\.example/.test(new URL(c.url).hostname)), `${v} へ要求を出した`);
      const withSvc = r.calls.filter((c) => 'cf-access-client-id' in c.headers || 'cf-access-client-secret' in c.headers);
      assert.strictEqual(withSvc.length, 12, v);
      assert.ok(withSvc.every((c) => c.url === 'https://natsu-relay.team-a.workers.dev/health'), withSvc.map((c) => c.url).join(' / '));
    }
  } finally { await cf.close(); }
});

test('RL8・F23: CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET の片方だけ・形が違う → 値を出さずに「確かめてください」で 1。要求を1つも出さない', { timeout: 5000 }, async () => {
  const s = secrets();
  const svc = svcPair();
  const cf = await fakeCf(s);
  try {
    for (const env of [
      { CF_ACCESS_CLIENT_ID: svc.id }, { CF_ACCESS_CLIENT_SECRET: svc.secret },
      { ...svcEnv(svc), CF_ACCESS_CLIENT_ID: svc.id.slice(0, 32) }, { ...svcEnv(svc), CF_ACCESS_CLIENT_ID: svc.id.toUpperCase() },
      { ...svcEnv(svc), CF_ACCESS_CLIENT_SECRET: svc.secret.slice(0, 19) }, { ...svcEnv(svc), CF_ACCESS_CLIENT_SECRET: `${svc.secret} ${svc.secret}` },
      { ...svcEnv(svc), CF_ACCESS_CLIENT_SECRET: `${svc.secret}\n${svc.secret}` }, { ...svcEnv(svc), CF_ACCESS_CLIENT_SECRET: svc.secret.repeat(4) },
    ]) {
      for (const ev of ['push', 'workflow_dispatch']) {
        const r = await runDeploy(cf, { ...s, env: { ...env, GITHUB_EVENT_NAME: ev } });
        assert.strictEqual(r.code, 1, Object.keys(env).join(','));
        assert.match(r.text, /CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET を確かめてください/);
        noSvcValues(r.text, svc);
        assert.deepStrictEqual(r.tried, [], '形の違う秘密のまま要求を出した');
      }
    }
    assert.deepStrictEqual(cf.st.reqs, []);
    // 前後の空白と改行は落として使う（秘密の欄に貼ったときの改行）
    const cf2 = await fakeCf({ ...s, health: 'svc', svc });
    try {
      const r = await runDeploy(cf2, { ...s, env: { CF_ACCESS_CLIENT_ID: ` ${svc.id}\n`, CF_ACCESS_CLIENT_SECRET: `${svc.secret}\n` } });
      assert.strictEqual(r.code, 0, r.text);
    } finally { await cf2.close(); }
  } finally { await cf.close(); }
});

test('RL8: ready の4つは db・openai・access・domains。access がまだなら TEAM_DOMAIN と POLICY_AUD の名前を出して 0、db がまだなら 1', { timeout: 5000 }, async () => {
  const s = secrets();
  let cf = await fakeCf({ ...s, health: 'no-access' });
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 0, r.text);
    assert.match(r.text, /^ready: db はい・openai はい・access まだ・domains はい$/m);
    assert.match(r.text, /Cloudflare の画面で TEAM_DOMAIN と POLICY_AUD を入れてください（利用者の用意の 8/);
    assert.ok(!/秘密の欄を入れてください: /.test(r.text), 'openai・domains はそろっているのに名前を出した');
    assert.ok(!/mail|RESEND/.test(r.text), r.text);
  } finally { await cf.close(); }
  cf = await fakeCf(s);
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 0, r.text);
    assert.ok(!/TEAM_DOMAIN|POLICY_AUD/.test(r.text), 'access がそろっているのに名前を出した');
  } finally { await cf.close(); }
  cf = await fakeCf({ ...s, health: 'no-db' });
  try {
    const r = await runDeploy(cf, s);
    assert.strictEqual(r.code, 1, r.text);
    assert.match(r.text, /^ready: db まだ・openai はい・access はい・domains はい$/m);
  } finally { await cf.close(); }
});

test('RL8: 中継の 401 で秘密が無い → push は 0・手で押したら 1、秘密がある → 1。302（Access の前）でも同じ', { timeout: 5000 }, async () => {
  const s = secrets();
  const svc = svcPair();
  const NEED = /GitHub の Environments → relay に CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET を入れてください（利用者の用意の 7）/;
  const POLICY = /Access の決まりに Service Auth（サービストークン）の決まりがあるかを確かめてください/;
  for (const health of ['login', 'denied', 'access-302', 'access-401', 'access-403', 'redirect']) {
    const cf = await fakeCf({ ...s, health, svc });
    try {
      const push = await runDeploy(cf, { ...s, env: { GITHUB_EVENT_NAME: 'push' } });
      assert.strictEqual(push.code, 0, `${health} push: ${push.text}`);
      assert.match(push.text, NEED, health);
      assert.ok(!POLICY.test(push.text), health);
      const manual = await runDeploy(cf, { ...s, env: { GITHUB_ACTIONS: 'true' } });
      assert.strictEqual(manual.code, 1, `${health} 手: ${manual.text}`);
      assert.match(manual.text, NEED, health);
      assert.match(manual.text, /^::error::/m, `${health}: Actions の要約に赤く出ない`);
      for (const ev of ['push', 'workflow_dispatch']) {
        const withSvc = await runDeploy(cf, { ...s, env: { ...svcEnv(svc), GITHUB_EVENT_NAME: ev } });
        assert.strictEqual(withSvc.code, 1, `${health} ${ev} 秘密あり: ${withSvc.text}`);
        assert.match(withSvc.text, POLICY, health);
        assert.ok(!NEED.test(withSvc.text), health);
        noSvcValues(withSvc.text, svc);
      }
      for (const r of [push, manual]) {
        assert.ok(!/公開した URL|^ready: /m.test(r.text), `${health}: 止められたのに ready を出した`);
        assert.match(r.text, /7\/7 \/health: HTTP (30[1278]|401|403)/, health);
      }
      // Access の決まりは数秒では変わらないので、何回も試さない（1回で分ける）
      assert.strictEqual(seq(cf.st).filter((x) => x === HEALTH).length, 4, `${health}: /health を何回も試した`);
    } finally { await cf.close(); }
  }
});

test('RL8・F28: /health が中継の JSON の 503 not-ready → TEAM_DOMAIN と POLICY_AUD の名前を出して 1（値は出さない）', { timeout: 5000 }, async () => {
  const s = secrets();
  const svc = svcPair();
  for (const ev of ['push', 'workflow_dispatch']) {
    const cf = await fakeCf({ ...s, health: 'not-ready', svc });
    try {
      const r = await runDeploy(cf, { ...s, env: { ...svcEnv(svc), GITHUB_EVENT_NAME: ev, TEAM_DOMAIN: 'https://team-value-zz.example', POLICY_AUD: 'aud-value-zz' } });
      assert.strictEqual(r.code, 1, r.text);
      assert.match(r.text, /Cloudflare の画面の TEAM_DOMAIN と POLICY_AUD が、natsu-relay の Access の app のものかを確かめてください（利用者の用意の 8）/);
      // 鍵の口の一時の失敗（r: certs）・D1 の失敗でも not-ready なので、値が合っていたときの次の1手も言う
      assert.match(r.text, /合っていれば、少し待ってからもう一度 Run workflow を押してください/);
      assert.ok(!/ready: |公開した URL|届きませんでした/.test(r.text), r.text);
      assert.ok(!/value-zz/.test(r.text), '値を出した');
      noSvcValues(r.text, svc);
      // 鍵の口の一時の失敗（r: certs）も 503 not-ready なので、ほかの 200 でない答えと同じく 12 回まで試してから分ける
      assert.strictEqual(seq(cf.st).filter((x) => x === HEALTH).length, 12);
    } finally { await cf.close(); }
  }
});

test('F23: /health は redirect: \'manual\' で、302 の行き先へサービストークンの見出しを運ばない（偽の口の 302 の先に要求が来ない）', { timeout: 5000 }, async () => {
  const s = secrets();
  const svc = svcPair();
  const cf = await fakeCf({ ...s, health: 'access-302', svc });
  try {
    const r = await runDeploy(cf, { ...s, env: svcEnv(svc) });
    assert.strictEqual(r.code, 1, r.text);
    assert.ok(!cf.st.reqs.some((q) => q.path.startsWith('/cdn-cgi/')), '302 の行き先へ行った');
    const health = r.calls.filter((c) => /\/health$/.test(c.url));
    assert.strictEqual(health.length, 1);
    assert.strictEqual(health[0].redirect, 'manual');
    // Cloudflare の API は今のまま転送で止まる（redirect: 'error'）
    for (const c of r.calls.filter((x) => x.url.includes('/client/v4/'))) assert.strictEqual(c.redirect, 'error', c.url);
  } finally { await cf.close(); }
});

// ---------------------------------------------------------------- 秘密の無いとき（子のプロセスで台本そのものを走らせる。要求は出さない）
function runChild(env) {
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (/^(CLOUDFLARE_|CF_|RELAY_|GITHUB_)|^NODE_TEST_CONTEXT$/.test(k)) delete e[k];
  Object.assign(e, env);
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SCRIPT], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, out }));
  });
}

test('RL8: main への push で秘密が2つとも無ければ、何も上げずに 0 で終わる。手で押したときは 1。片方だけなら 1', { timeout: 20000 }, async () => {
  const push = await runChild({ GITHUB_EVENT_NAME: 'push' });
  assert.strictEqual(push.code, 0, push.out);
  assert.match(push.out, /まだ用意されていないので出しません/);
  assert.match(push.out, /Settings → Environments → relay に CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を入れてください/);
  const manual = await runChild({ GITHUB_EVENT_NAME: 'workflow_dispatch' });
  assert.strictEqual(manual.code, 1, manual.out);
  assert.match(manual.out, /GitHub のリポジトリの Settings → Environments → relay に CLOUDFLARE_API_TOKEN と CLOUDFLARE_ACCOUNT_ID を入れてください/);
  assert.ok(!/まだ用意されていないので出しません/.test(manual.out));
  const half = await runChild({ GITHUB_EVENT_NAME: 'push', CLOUDFLARE_API_TOKEN: 'cf-half-only' });
  assert.strictEqual(half.code, 1, half.out);
  assert.ok(!half.out.includes('cf-half-only'));
  const local = await runChild({});
  assert.strictEqual(local.code, 1, local.out);
  const gh = await runChild({ GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_ACTIONS: 'true' });
  assert.strictEqual(gh.code, 1, gh.out);
  assert.match(gh.out, /^::error::中継を出せません: 秘密が足りません。GitHub のリポジトリの Settings → Environments → relay/m, 'Actions の要約に赤く出ない');
});

test('RL8: push で秘密が無いときも要求を1つも出さない（deploy() の答えは 0）', { timeout: 5000 }, async () => {
  const s = secrets();
  const cf = await fakeCf(s);
  try {
    const r = await runDeploy(cf, { ...s, env: { CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_ACCOUNT_ID: undefined, GITHUB_EVENT_NAME: 'push' } });
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual(r.tried, []);
  } finally { await cf.close(); }
});

test('RL8: 出す台本は Node に入っている部品だけを使う（wrangler も npm の依存も無い）', { timeout: 5000 }, () => {
  const src = read('tools/relay-deploy.js');
  const mods = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(mods.length > 0);
  // ヘルプセンター H-10 で意図して変えた: 共通の部品 tools/lib/cf-api.js（これも Node に入っている部品だけ。test/help-deploy.test.js が見る）を読んでよい
  for (const m of mods) assert.match(m, /^(node:|\.\/lib\/cf-api$)/, m);
  assert.ok(!/wrangler/i.test(src.replace(/^\s*\/\/.*$/gm, '')), 'wrangler を使っている');
  assert.match(CFG.compatibilityDate, /^\d{4}-\d{2}-\d{2}$/);
  // Cloudflare の実行環境は数日おくれて新しい日付に追いつく。出す日と同じ日付だと「未来の日付」で上げを断られうるので、1週間より前にする
  assert.ok(Date.parse(CFG.compatibilityDate + 'T00:00:00Z') <= Date.now() - 7 * 86400e3, `compatibility_date ${CFG.compatibilityDate} が新しすぎる`);
  assert.deepStrictEqual({ scriptName: CFG.scriptName, dbName: CFG.dbName, locationHint: CFG.locationHint }, { scriptName: 'natsu-relay', dbName: 'natsu-relay', locationHint: 'apac' });
});

// ---------------------------------------------------------------- ワークフローの形（F10）
test('F10: relay-deploy.yml は手で押すか main への push だけで走り（PR では走らない）、main の枝・環境 relay・中継のテストの後に出す', { timeout: 5000 }, () => {
  const y = read(WF);
  assert.ok(!/\t/.test(y), 'タブがある');
  assert.ok(!/pull_request/.test(y), 'pull_request か pull_request_target で走る');
  const on = y.slice(y.indexOf('\non:\n'), y.indexOf('\npermissions:\n'));
  assert.match(on, /^  workflow_dispatch:\s*$/m);
  assert.match(on, /^  push:\n    branches: \[main\]\n/m);
  assert.ok(!/^  (schedule|workflow_run|workflow_call|repository_dispatch|issue|release)/m.test(on), on);
  // 権限は contents: read だけ（ジョブの側で広げない）
  assert.match(y, /\npermissions:\n  contents: read\n(?! )/);
  assert.strictEqual((y.match(/permissions:/g) || []).length, 1, 'permissions がほかにもある');
  const jobs = jobsOf(y);
  assert.deepStrictEqual(Object.keys(jobs), ['deploy']);
  const job = jobs.deploy;
  assert.match(job, /^    if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(job, /^    environment: relay(\s+#.*)?$/m);
  const st = stepsOf(job);
  const co = st.find((s) => /uses: actions\/checkout@v4/.test(s));
  assert.ok(co && /^\s+persist-credentials: false$/m.test(co), 'checkout が persist-credentials: false でない');
  const names = st.map(nameOf);
  const iTest = names.indexOf('中継のテスト');
  const iDeploy = names.indexOf('中継を出す');
  assert.ok(iTest >= 0 && iDeploy > iTest, `中継のテストが中継を出すより前に無い: ${names.join(' / ')}`);
  assert.match(st[iTest], /^\s+run: node --test --test-reporter=tap "test\/relay-\*\.test\.js"$/m);
  assert.match(st[iDeploy], /^\s+run: node tools\/relay-deploy\.js$/m, 'トークンを引数で渡していないか');
  // 秘密を参照するのは「中継を出す」の env の4つだけ（Cloudflare の API の2つと、/health のサービストークンの2つ: D-2）
  const refs = y.match(/secrets\./g) || [];
  assert.strictEqual(refs.length, 4, `secrets. が ${refs.length} か所`);
  const env = st[iDeploy].slice(st[iDeploy].indexOf('env:'), st[iDeploy].indexOf('run:'));
  assert.match(env, /^\s+CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}$/m);
  assert.match(env, /^\s+CLOUDFLARE_ACCOUNT_ID: \$\{\{ secrets\.CLOUDFLARE_ACCOUNT_ID \}\}$/m);
  assert.ok(!/secrets: inherit|toJSON\(secrets\)/.test(y));
  // 記録に出す道を作らない
  const runs = y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/\becho\b/.test(runs), 'echo がある');
  assert.ok(!/set -x|set -o xtrace|ACTIONS_STEP_DEBUG/.test(runs), 'set -x がある');
  assert.match(y, /^concurrency:\n  group: relay-deploy\n  cancel-in-progress: false$/m);
  assert.deepStrictEqual([...y.matchAll(/node-version: '([^']+)'/g)].map((m) => m[1]), ['24']);
});

test('F10: relay-deploy.yml は GitHub の ubuntu-latest で走り、使う action は ci.yml と同じ固定の2つだけ。run の中に ${{ }} の式を書かない（式は env で渡す）', { timeout: 5000 }, () => {
  const y = read(WF);
  const ci = read('.github/workflows/ci.yml');
  const job = jobsOf(y).deploy;
  assert.match(job, /^    runs-on: ubuntu-latest$/m, 'GitHub の ubuntu-latest でない（self-hosted の機械にトークンを渡さない）');
  // トークンのある仕事で動く他人のコードを増やさない。固定の仕方はほかのワークフローと同じ
  const uses = [...y.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gm)].map((m) => m[1]);
  assert.deepStrictEqual(uses, ['actions/checkout@v4', 'actions/setup-node@v4']);
  for (const u of uses) assert.ok(ci.includes(`uses: ${u}`), `${u} が ci.yml と同じ固定でない`);
  // run の中の ${{ }} は、github.event の文字（commit の文など）をそのまま shell に差し込む道になる
  for (const st of stepsOf(job)) {
    const i = st.search(/^\s*run:/m);
    if (i >= 0) assert.ok(!/\$\{\{/.test(st.slice(i)), `run の中に式: ${nameOf(st)}`);
  }
  assert.ok(!/github\.event\.|inputs\./.test(y), 'github.event・inputs を読む');
});

test('F10: relay-deploy.yml の YAML の書き方（引用符の無い値に「: 」が無い・段の名前は 200 バイトまで）', { timeout: 5000 }, () => {
  const bad = [];
  read(WF).split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*(?:- )?[A-Za-z0-9_-]+:[ ]+(.+)$/.exec(line);
    if (!m) return;
    const v = m[1].replace(/\s+#.*$/, '');
    if (/^['"|>{[&*!#]/.test(v)) return;
    if (/: /.test(v) || /:$/.test(v)) bad.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepStrictEqual(bad, []);
  for (const m of read(WF).matchAll(/^\s*- name: (.+)$/gm)) assert.ok(Buffer.byteLength(m[1], 'utf8') <= 200, m[1]);
});

// ヘルプセンター H-10 で意図して変えた: CLOUDFLARE_ の秘密を参照し、環境 relay を使うのは relay-deploy.yml の『中継を出す』と
// help-deploy.yml の『ヘルプを出す』の2つだけ（help-deploy.yml の側の形は test/help-deploy.test.js が見る）
test('F6: ほかのワークフローは CLOUDFLARE_ の秘密を参照しない（秘密は relay-deploy と help-deploy の環境 relay だけ）', { timeout: 5000 }, () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const others = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && f !== 'relay-deploy.yml' && f !== 'help-deploy.yml');
  assert.ok(others.includes('ci.yml') && others.includes('release.yml'), others.join(','));
  for (const f of others) {
    const y = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/CLOUDFLARE_/.test(y), `${f} が CLOUDFLARE_ を参照する`);
    assert.ok(!/environment:\s*relay\b/.test(y), `${f} が環境 relay を使う`);
  }
});

test('F10・F23: ワークフローの形: CF_ACCESS_ の秘密を参照するのは『中継を出す』の env だけ。ci.yml・release.yml・ほかのワークフローは CF_ACCESS_ を参照しない', { timeout: 5000 }, () => {
  const y = read(WF);
  const st = stepsOf(jobsOf(y).deploy);
  const names = st.map(nameOf);
  const deployStep = st[names.indexOf('中継を出す')];
  assert.ok(deployStep, names.join(' / '));
  const env = deployStep.slice(deployStep.indexOf('env:'), deployStep.indexOf('run:'));
  assert.match(env, /^\s+CF_ACCESS_CLIENT_ID: \$\{\{ secrets\.CF_ACCESS_CLIENT_ID \}\}$/m);
  assert.match(env, /^\s+CF_ACCESS_CLIENT_SECRET: \$\{\{ secrets\.CF_ACCESS_CLIENT_SECRET \}\}$/m);
  // ほかの段（中継のテストなど）とジョブ・ワークフローの頭（env:）には渡さない
  const lines = y.split('\n').filter((l) => /CF_ACCESS_/.test(l) && !/^\s*#/.test(l));
  assert.strictEqual(lines.length, 2, lines.join(' / '));
  for (const l of lines) assert.ok(env.includes(l), `「中継を出す」の env の外で CF_ACCESS_: ${l.trim()}`);
  for (const s of st) if (s !== deployStep) assert.ok(!/CF_ACCESS_/.test(s.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')), `${nameOf(s)} が CF_ACCESS_ を参照する`);
  const dir = path.join(ROOT, '.github', 'workflows');
  const others = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && f !== 'relay-deploy.yml');
  assert.ok(others.includes('ci.yml') && others.includes('release.yml'), others.join(','));
  for (const f of others) assert.ok(!/CF_ACCESS_/.test(fs.readFileSync(path.join(dir, f), 'utf8')), `${f} が CF_ACCESS_ を参照する`);
});

// ---------------------------------------------------------------- アプリに入らない（F6・F10）
test('F6: 中継と出し方はアプリに入らない（インストーラーの build.files・自動更新の zip・make-release.ps1 は src と package.json だけ）', { timeout: 5000 }, () => {
  const pkg = JSON.parse(read('package.json'));
  const files = pkg.build.files;
  assert.ok(Array.isArray(files) && files.length > 0);
  for (const f of files) {
    assert.match(f, /^(src\/|assets\/[^*]+$|package\.json$)/, `build.files の ${f} は src・assets・package.json の外も拾いうる`);
    assert.ok(!/relay|tools|test|\.github/.test(f), f);
  }
  for (const k of ['extraResources', 'extraFiles', 'asarUnpack']) assert.ok(!(k in pkg.build) || !/relay|tools|test/.test(JSON.stringify(pkg.build[k])), k);
  // release.yml の配布 zip
  const st = stepsOf(jobsOf(read('.github/workflows/release.yml')).release);
  const zip = st.find((s) => nameOf(s) === '配布zipを作る');
  assert.ok(zip, 'release.yml に「配布zipを作る」が無い');
  const cps = [...zip.matchAll(/^\s*cp (?:-a )?(\S+) release\/_stage\//gm)].map((m) => m[1]);
  assert.deepStrictEqual(cps.sort(), ['package.json', 'src']);
  assert.match(zip, /zip -q -r -X "\.\.\/natsu-src-\$\{VER\}\.zip" src package\.json\)/);
  assert.ok(!/relay|tools\//.test(zip), zip);
  // make-release.ps1 も同じ
  const ps = read('make-release.ps1');
  const copies = [...ps.matchAll(/^Copy-Item (.+)$/gm)].map((m) => m[1].trim());
  assert.deepStrictEqual(copies, ['(Join-Path $root "src") (Join-Path $stage "src") -Recurse', '$pkgPath (Join-Path $stage "package.json")']);
  assert.ok(!/relay/i.test(ps));
  // アプリのコードは relay/ と出す台本を読まない（読めば、配った先で見つからずに落ちる）
  const srcFiles = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html|mjs)$/.test(e.name)) srcFiles.push(p); } };
  walk(path.join(ROOT, 'src'));
  for (const f of srcFiles) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/(require\(|import\(|from\s)\s*['"][./]*\/?(\.\.\/)+(relay|tools)\//.test(s), `${path.relative(ROOT, f)} が relay/ か tools/ を読む`);
  }
});
