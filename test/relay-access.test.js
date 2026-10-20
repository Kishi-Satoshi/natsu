/* relay-access.test.js — 第1d回 W-5（RL1・RL2・RL5・RL6・RL7・RF42・F17・F18・F24・F28）: 中継が Cloudflare Access の JWT を自分で確かめる
   （node --test で Worker を起こさずに呼ぶ。偽の Access は test/helpers/fake-access.js（偽の鍵で署名した JWT と、127.0.0.1 の鍵の口）。
    偽の OpenAI は test/helpers/fake-stt.js。どの JWT の失敗も OpenAI に送らないことを、偽の OpenAI の受けた数で見る） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const R = require('./helpers/relay-run');
const { startFakeAccess } = require('./helpers/fake-access');
const { startFakeStt } = require('./helpers/fake-stt');

const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const PATH = '/v1/audio/transcriptions';
const SAID = '本日の議題は進捗の確認です。';
const DONE_TEXT = 'ログインできました。この窓は自動で閉じます。';
const KEYS = new Set(['ev', 'st', 'r', 'ms', 'sec', 'n', 'left', 'scope', 'v']);

// どの場面の記録・答えの見出しと本文も合わせて見る（F9）
const ALL = { logs: [], heads: [], bodies: [], secrets: new Set(), scenes: 0, rs: new Set() };

const rowsOf = async (db, sql, ...v) => (await db.prepare(sql).bind(...v).all()).results;
const userKey = async (email) => 'a:u:' + (await (await R.load('http.mjs')).sha256hex(email)).slice(0, 32);

// 止めたメールの SQL は README の管理者の節に書いた文字を、そのまま D1 に流す（relay-session の adminSql と同じ形）
const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const ADMIN = README.includes('## 管理者の手順') ? README.slice(README.indexOf('## 管理者の手順')) : '';
function adminSql(head) {
  const m = new RegExp('`(' + head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "[^`]*'<[^>]+>'[^`]*;)`").exec(ADMIN);
  assert.ok(m, `README の管理者の節に「${head}」の SQL が無い`);
  return (email) => m[1].replace(/'<[^>]+>'/, `'${email}'`);
}

// 中継の場面: 偽の Access と偽の OpenAI を 127.0.0.1 に立て、中継の env を合わせる
async function scene({ env = {}, start } = {}, fn) {
  const fa = await startFakeAccess();
  const key = 'sk-test-' + crypto.randomBytes(12).toString('hex');
  const stt = await startFakeStt({ mode: 'text', key, text: SAID });
  try {
    await R.withRelay({ access: fa, env: { OPENAI_API_KEY: key, OPENAI_BASE: stt.base, ...env }, start }, async (ctx) => {
      const secrets = new Set([key, fa.teamDomain, 'natsu-test', fa.aud, ...fa.kids()]);
      const heads = [];
      const bodies = [];
      const keep = (s) => { if (typeof s === 'string' && s.length > 3) { secrets.add(s); secrets.add(s.toLowerCase()); } };
      const now = () => ctx.clock.now();
      // JWT を作る（試しの時計で。作った JWT とメールは記録に出てはいけない秘密に足す）
      const sign = async (claims = {}, opts = {}) => {
        const t = await fa.sign(claims, { now: now(), ...opts });
        keep(t); keep(t.split('.')[2] || '');
        if (typeof claims.email === 'string') keep(claims.email);
        if (opts.kid) keep(opts.kid);
        return t;
      };
      const service = async (claims = {}, opts = {}) => { const t = await fa.service(claims, { now: now(), ...opts }); keep(t); return t; };
      async function hit(method, p, opts = {}) {
        const res = await ctx.call(method, p, opts);
        const text = await res.text();
        for (const [k, v] of res.headers) heads.push(k + ': ' + v);
        bodies.push(text);
        let body = null;
        try { body = JSON.parse(text); } catch (_) { body = null; }
        return { status: res.status, body, text, headers: res.headers };
      }
      const me = (opts) => hit('GET', '/v1/me', opts);
      const done = (opts, q = '') => hit('GET', '/auth/done' + q, opts);
      const health = (opts) => hit('GET', '/health', opts);
      const stt1 = (opts = {}) => hit('POST', PATH, {
        ...opts, headers: { 'content-type': 'audio/wav', 'x-natsu-language': 'ja', ...(opts.headers || {}) }, body: R.wav(1),
      });
      // 記録の access の行の r（この場面で書かれた順）
      const accessRs = () => ctx.logs.map((l) => JSON.parse(l)).filter((p) => p.ev === 'access').map((p) => p.r);
      await fn({ ...ctx, fa, stt, sign, service, me, done, health, stt1, hit, accessRs, keep });
      for (const l of ctx.logs) {
        const p = JSON.parse(l);
        for (const k of Object.keys(p)) assert.ok(KEYS.has(k), `記録に決まりの外の欄 ${k}`);
        if (p.ev === 'access') ALL.rs.add(p.r);
      }
      ALL.scenes += 1;
      ALL.logs.push(...ctx.logs);
      ALL.heads.push(...heads);
      ALL.bodies.push(...bodies);
      for (const s of secrets) ALL.secrets.add(s);
    });
  } finally {
    await stt.close();
    await fa.close();
  }
}

test('RL5・RF42: 正しい JWT のメールで /v1/me は 200 { email, exp, via }。メールは小文字。答えにも記録にも JWT とメールが無い', { timeout: 5000 }, async () => {
  await scene({}, async ({ sign, me, logs, clock }) => {
    const email = R.mail('Test.User', 'Example.COM');
    const exp = Math.floor(clock.now() / 1000) + 1800;
    const jwt = await sign({ email, exp });
    const r = await me({ jwt });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body, { email: email.toLowerCase(), exp, via: 'hdr' });
    assert.strictEqual(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    // aud の無い JWT は通さない（署名は合うので 503 not-ready: F28）
    assert.strictEqual((await me({ jwt: await sign({ email, aud: undefined }) })).status, 503, 'aud が無い JWT');
    const text = logs.join('\n');
    for (const s of [jwt, email, email.toLowerCase(), jwt.split('.')[2]]) assert.ok(!text.includes(s), `記録に ${s.slice(0, 12)}…`);
  });
  // aud は文字1つでも通る（Access は配列で書くが、文字の形も受ける）
  await scene({}, async ({ sign, me, fa }) => {
    const r = await me({ jwt: await sign({ aud: fa.aud }) });
    assert.strictEqual(r.status, 200, 'aud が文字1つ: ' + r.text);
    assert.strictEqual(r.body.email, R.mail('test.user'));
  });
});

test('RF42: 署名の違う・alg が none／HS256・知らない kid・切れた exp・未来の nbf・type が org・3つでない文字の JWT は 401 login、ほかの iss・ほかの aud は 503 not-ready（記録の r が符号ごと。どれも OpenAI に送らない）', { timeout: 5000 }, async () => {
  await scene({}, async ({ sign, me, stt1, stt, accessRs, clock, keep }) => {
    const t = Math.floor(clock.now() / 1000);
    const good = await sign();
    const [h, p] = good.split('.');
    const cases = [
      ['sig', await sign({}, { key: 'stray' }), 401],
      ['sig', h + '.' + p + '.' + 'A'.repeat(342), 401],
      ['alg', await sign({}, { alg: 'none' }), 401],
      ['alg', await sign({}, { alg: 'HS256' }), 401],
      ['alg', await sign({}, { alg: 'RS512' }), 401],
      ['kid', await sign({}, { kid: 'no-such-kid' }), 401],
      ['kid', await sign({}, { kid: null }), 401],
      ['exp', await sign({ exp: t - 1 }), 401],
      ['exp', await sign({ exp: t }), 401],   // exp > 今（ちょうど今の秒は切れている）
      ['exp', await sign({ exp: undefined }), 401],
      ['exp', await sign({ exp: String(t + 3600) }), 401],
      ['nbf', await sign({ nbf: t + 3600 }), 401],
      ['type', await sign({ type: 'org' }), 401],
      ['type', await sign({ type: undefined }), 401],
      ['bad-jwt', h + '.' + p, 401],
      ['bad-jwt', good + '.x', 401],
      ['bad-jwt', 'not-a-jwt', 401],
      ['bad-jwt', h + '.' + p + '.' + 'A'.repeat(9000), 401],
      ['bad-jwt', '%%%.' + p + '.abc', 401],
      ['alg', 'e30.' + p + '.abc', 401],
      ['iss', await sign({ iss: 'https://other-team.cloudflareaccess.com' }), 503],
      ['iss', await sign({ iss: undefined }), 503],
      ['aud', await sign({ aud: ['0'.repeat(64)] }), 503],
      ['aud', await sign({ aud: 'f'.repeat(64) }), 503],
    ];
    for (const [r, jwt] of cases) keep(jwt);
    for (const [r, jwt, st] of cases) {
      const before = accessRs().length;
      const a = await me({ jwt });
      assert.strictEqual(a.status, st, `${r}: ${a.text}`);
      assert.deepStrictEqual(a.body, { error: st === 401 ? 'login' : 'not-ready' }, r);
      assert.deepStrictEqual(accessRs().slice(before), [r], `記録の r（${r}）`);
      const b = await stt1({ jwt });
      assert.strictEqual(b.status, st, `文字起こしの口 ${r}`);
      assert.deepStrictEqual(b.body, { error: st === 401 ? 'login' : 'not-ready' }, r);
    }
    // exp が今の次の秒なら通る（境目は exp > 今）
    assert.strictEqual((await me({ jwt: await sign({ exp: t + 1 }) })).status, 200, 'exp が今の次の秒');
    // 未来の nbf でも 60 秒の内（時計のずれ）は通る
    assert.strictEqual((await me({ jwt: await sign({ nbf: t + 60 }) })).status, 200, 'nbf が 60 秒の内');
    assert.strictEqual(stt.requests.length, 0, 'OpenAI へ送った');
  });
});

test('RF42: JWT が無ければ /v1/me・/auth/done・文字起こしの口は 401 login で、偽の OpenAI に1回も送らない（Access が外れたときの守り）', { timeout: 5000 }, async () => {
  await scene({}, async ({ me, done, stt1, stt, db, accessRs }) => {
    for (const [name, r] of [['/v1/me', await me()], ['/auth/done', await done()], [PATH, await stt1()]]) {
      assert.strictEqual(r.status, 401, name);
      assert.deepStrictEqual(r.body, { error: 'login' }, name);
    }
    // 空の見出し・空の cookie も無いのと同じ
    assert.strictEqual((await me({ jwt: '' })).status, 401);
    assert.strictEqual((await me({ cookie: '' })).status, 401);
    assert.strictEqual(stt.requests.length, 0, 'OpenAI へ送った');
    assert.deepStrictEqual(await rowsOf(db, "SELECT key FROM counters WHERE key LIKE 'a:%'"), []);
    assert.ok(accessRs().includes('no-jwt'), '記録に no-jwt が無い');
  });
});

test('RF42: サービストークンの JWT（email なし・common_name）は /health だけで通り、/v1/me と文字起こしの口は 403 denied', { timeout: 5000 }, async () => {
  await scene({}, async ({ service, health, me, done, stt1, stt, accessRs }) => {
    const jwt = await service();
    const h = await health({ jwt });
    assert.strictEqual(h.status, 200, h.text);
    assert.deepStrictEqual(h.body, { ok: true, relay: 2, ready: { db: true, openai: true, access: true, domains: true } });
    for (const [name, r] of [['/v1/me', await me({ jwt })], ['/auth/done', await done({ jwt })], [PATH, await stt1({ jwt })]]) {
      assert.strictEqual(r.status, 403, name);
      assert.deepStrictEqual(r.body, { error: 'denied' }, name);
    }
    assert.ok(accessRs().includes('service'), '記録に service が無い');
    assert.strictEqual(stt.requests.length, 0, 'OpenAI へ送った');
  });
});

test('K13: 会社のドメインでないメール（サブドメインも）は Access を通っても 403 denied。ALLOWED_EMAIL_DOMAINS とちょうど同じだけ通す', { timeout: 5000 }, async () => {
  await scene({}, async ({ sign, me, stt1, stt, accessRs }) => {
    for (const domain of ['sub.example.com', 'example.org', 'example.com.evil.test', 'evil-example.com', 'xexample.com']) {
      const jwt = await sign({ email: R.mail('test.user', domain) });
      const r = await me({ jwt });
      assert.strictEqual(r.status, 403, domain);
      assert.deepStrictEqual(r.body, { error: 'denied' }, domain);
      assert.strictEqual((await stt1({ jwt })).status, 403, domain);
    }
    assert.ok(accessRs().every((r) => r === 'domain'), accessRs().join(','));
    assert.strictEqual(stt.requests.length, 0, 'OpenAI へ送った');
    // メールの形でない email も通さない
    for (const email of ['test.user', R.mail('', 'example.com'), R.mail('a b', 'example.com'), R.mail('test.user', '')]) {
      assert.strictEqual((await me({ jwt: await sign({ email }) })).status, 403, String(email));
    }
    // 小文字にすると ASCII になる字（KELVIN SIGN U+212A → k）も、小文字にする前に断る（Unicode の畳み込みで別のメールにしない）
    for (const email of [R.mail('test.\u212Aate'), R.mail('\u212A')]) {
      const before = accessRs().length;
      const r = await me({ jwt: await sign({ email }) });
      assert.strictEqual(r.status, 403, 'U+212A');
      assert.deepStrictEqual(accessRs().slice(before), ['domain'], 'U+212A の r');
      assert.strictEqual((await stt1({ jwt: await sign({ email }) })).status, 403, 'U+212A 文字起こしの口');
    }
    assert.strictEqual(stt.requests.length, 0, 'OpenAI へ送った');
  });
  await scene({ env: { ALLOWED_EMAIL_DOMAINS: 'example.com, Example.org' } }, async ({ sign, me }) => {
    for (const domain of ['example.com', 'example.org', 'EXAMPLE.ORG']) {
      assert.strictEqual((await me({ jwt: await sign({ email: R.mail('test.user', domain) }) })).status, 200, domain);
    }
    assert.strictEqual((await me({ jwt: await sign({ email: R.mail('test.user', 'example.net') }) })).status, 403);
  });
  // 会社のドメインを入れていない（用意の途中）ときは、全員を 403 denied にしない（アプリがログインを消すため）。503 not-ready
  await scene({ env: { ALLOWED_EMAIL_DOMAINS: undefined } }, async ({ sign, me }) => {
    const r = await me({ jwt: await sign() });
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(r.body, { error: 'not-ready' });
  });
});

test('RL6: blocked_emails に入れたメールは 403 denied（README の SQL をそのまま流す）', { timeout: 5000 }, async () => {
  const block = adminSql('INSERT INTO blocked_emails');
  const unblock = adminSql('DELETE FROM blocked_emails');
  await scene({}, async ({ sign, me, stt1, stt, db, accessRs }) => {
    const email = R.mail('blocked.user');
    const jwt = await sign({ email: R.mail('Blocked.User') });
    assert.strictEqual((await me({ jwt })).status, 200);
    await db.exec(block(email));
    const r = await me({ jwt });
    assert.strictEqual(r.status, 403);
    assert.deepStrictEqual(r.body, { error: 'denied' });
    assert.strictEqual((await stt1({ jwt })).status, 403);
    assert.strictEqual(stt.requests.length, 0, 'OpenAI へ送った');
    assert.ok(accessRs().includes('blocked'));
    // ほかの人は通る
    assert.strictEqual((await me({ jwt: await sign({ email: R.mail('other.user') }) })).status, 200);
    await db.exec(unblock(email));
    assert.strictEqual((await me({ jwt })).status, 200, '戻す SQL の後');
  });
  // D1 が読めなければ 503 not-ready（止めたかを確かめずに通さない）
  await scene({}, async ({ sign, me, db }) => {
    const jwt = await sign();
    await db.exec('DROP TABLE blocked_emails');
    const r = await me({ jwt });
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(r.body, { error: 'not-ready' });
  });
});

test('F18: 鍵は1時間写しを使い（2回目から取りに行かない）、知らない kid のときだけ1回取り直す（替わり目の新しい鍵で通る）。30 秒の内に知らない kid が続いても取り直しは1回', { timeout: 5000 }, async () => {
  await scene({}, async ({ sign, me, fa, clock }) => {
    assert.strictEqual((await me({ jwt: await sign() })).status, 200);
    assert.strictEqual(fa.certHits, 1);
    for (let i = 0; i < 3; i++) assert.strictEqual((await me({ jwt: await sign() })).status, 200);
    assert.strictEqual(fa.certHits, 1, '写しを使っていない');
    clock.advance(59 * MIN);
    assert.strictEqual((await me({ jwt: await sign() })).status, 200);
    assert.strictEqual(fa.certHits, 1, '1時間の内に取りに行った');
    clock.advance(2 * MIN);
    assert.strictEqual((await me({ jwt: await sign() })).status, 200);
    assert.strictEqual(fa.certHits, 2, '1時間を過ぎても取り直さない');
    // 鍵の替わり目: 新しい kid。取ったばかり（30 秒の内）なら取り直さずに 401 kid
    await fa.rotate();
    const fresh = await sign();
    assert.strictEqual((await me({ jwt: fresh })).status, 401, '30 秒の内に取り直した');
    assert.strictEqual(fa.certHits, 2);
    clock.advance(31 * S);
    assert.strictEqual((await me({ jwt: await sign() })).status, 200, '替わり目の新しい鍵で通らない');
    assert.strictEqual(fa.certHits, 3);
    // 前の鍵（替わった後も 7 日使える）は取り直さずに通る
    assert.strictEqual((await me({ jwt: await sign({}, { key: 'prev' }) })).status, 200, '前の鍵で通らない');
    assert.strictEqual(fa.certHits, 3);
    // 知らない kid が続いても、30 秒に1回だけ取りに行く
    assert.strictEqual((await me({ jwt: await sign({}, { kid: 'unknown-1' }) })).status, 401);
    assert.strictEqual(fa.certHits, 3, '取ったばかりなのに知らない kid で取り直した');
    clock.advance(31 * S);
    assert.strictEqual((await me({ jwt: await sign({}, { kid: 'unknown-2' }) })).status, 401);
    assert.strictEqual(fa.certHits, 4, '30 秒の後の知らない kid で取り直さない');
    for (const k of ['unknown-3', 'unknown-4', 'unknown-5']) assert.strictEqual((await me({ jwt: await sign({}, { kid: k }) })).status, 401);
    assert.strictEqual(fa.certHits, 4, '30 秒の内に何度も取りに行った');
  });
});

test('F18: 鍵の口が 500・答えない・転送する → 401 でなく 503 not-ready（r: certs）。5 秒で切る（AbortSignal.timeout に渡した長さを見る）', { timeout: 5000 }, async () => {
  const realTimeout = AbortSignal.timeout;
  const seen = [];
  AbortSignal.timeout = (ms) => { seen.push(ms); return realTimeout.call(AbortSignal, Math.min(ms, 150)); };
  try {
    for (const mode of ['500', 'hang', 'redirect']) {
      await scene({}, async ({ sign, me, fa, accessRs, stt1, stt }) => {
        fa.setCerts(mode);
        const jwt = await sign();
        const r = await me({ jwt });
        assert.strictEqual(r.status, 503, `${mode}: ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'not-ready' }, mode);
        assert.deepStrictEqual(accessRs(), ['certs'], mode);
        assert.strictEqual(fa.certHits, 1, mode);
        assert.strictEqual((await stt1({ jwt })).status, 503, mode);
        assert.strictEqual(stt.requests.length, 0, mode);
      });
    }
  } finally {
    AbortSignal.timeout = realTimeout;
  }
  assert.ok(seen.includes(5000), `鍵の口の時間切れが 5 秒でない: ${seen.join(',')}`);
});

test('RL2: TEAM_DOMAIN は https の <名前>.cloudflareaccess.com だけ・POLICY_AUD は 64 字の16進だけ。ACCESS_CERTS_BASE は 127.0.0.1 の http のときだけ効き、ほかは TEAM_DOMAIN（鍵をほかのホストから読まない）', { timeout: 5000 }, async () => {
  const { readConfig } = await R.load('config.mjs');
  const TEAM = 'https://natsu-test.cloudflareaccess.com';
  const AUD = 'ab'.repeat(32);
  const ok = readConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD: AUD });
  assert.strictEqual(ok.teamDomain, TEAM);
  assert.strictEqual(ok.policyAud, AUD);
  assert.strictEqual(ok.certsBase, TEAM);
  assert.strictEqual(ok.ready.access, true);
  assert.strictEqual(readConfig({ TEAM_DOMAIN: ' ' + TEAM + ' ', POLICY_AUD: AUD }).teamDomain, TEAM, '前後の空白は落とす');
  for (const v of ['http://natsu-test.cloudflareaccess.com', TEAM + '/', TEAM + '/cdn-cgi/access/certs', TEAM + '.evil.example',
    'https://a.b.cloudflareaccess.com', 'https://-x.cloudflareaccess.com', 'https://x-.cloudflareaccess.com', 'https://.cloudflareaccess.com',
    'https://NATSU-TEST.cloudflareaccess.com', 'https://natsu_test.cloudflareaccess.com', 'https://evil.example', 'natsu-test.cloudflareaccess.com',
    'https://natsu-test.cloudflareaccess.com:8443', 'https://' + R.mail('x', 'natsu-test.cloudflareaccess.com'), '', undefined, 42]) {
    const c = readConfig({ TEAM_DOMAIN: v, POLICY_AUD: AUD });
    assert.strictEqual(c.teamDomain, '', String(v));
    assert.strictEqual(c.certsBase, '', String(v));
    assert.strictEqual(c.ready.access, false, String(v));
  }
  for (const v of ['ab'.repeat(31), 'ab'.repeat(33), 'AB'.repeat(32), 'g'.repeat(64), ' ', undefined]) {
    const c = readConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD: v });
    assert.strictEqual(c.policyAud, '', String(v));
    assert.strictEqual(c.ready.access, false, String(v));
  }
  assert.strictEqual(readConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ACCESS_CERTS_BASE: 'http://127.0.0.1:4010' }).certsBase, 'http://127.0.0.1:4010');
  for (const v of ['https://evil.example', 'http://localhost:4010', 'http://127.0.0.1.example.com:4010', 'https://127.0.0.1:4010',
    'http://127.0.0.1:4010/x', 'http://127.0.0.1:4010?x=1', 'http://evil.example:8443', 'http://' + R.mail('127.0.0.1:4010', 'evil.example'), '', undefined]) {
    assert.strictEqual(readConfig({ TEAM_DOMAIN: TEAM, POLICY_AUD: AUD, ACCESS_CERTS_BASE: v }).certsBase, TEAM, String(v));
  }
  // ほかのホストの ACCESS_CERTS_BASE は効かず、鍵は TEAM_DOMAIN（試験では外へ出られないので 503 certs）から読もうとする。偽の鍵の口には来ない
  await scene({ env: { ACCESS_CERTS_BASE: 'http://evil.example:8443' } }, async ({ sign, me, fa, accessRs }) => {
    const r = await me({ jwt: await sign() });
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(accessRs(), ['certs']);
    assert.strictEqual(fa.certHits, 0, 'ほかのホストの鍵の口の値を使った');
  });
});

test('RL1: /health は access がそろっていなければだれにでも ready（access: false）を返し、そろったら確かめた JWT（人かサービストークン）のときだけ 200、ほかは 401', { timeout: 5000 }, async () => {
  await R.withRelay({}, async ({ call }) => {
    const r = await call('GET', '/health');
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(await r.json(), { ok: true, relay: 2, ready: { db: true, openai: true, access: false, domains: true } });
  });
  await scene({ env: { POLICY_AUD: 'zz' } }, async ({ health }) => {
    const r = await health();
    assert.strictEqual(r.status, 200, 'POLICY_AUD の形が違えば、そろっていない');
    assert.strictEqual(r.body.ready.access, false);
  });
  await scene({}, async ({ health, sign, service }) => {
    for (const [why, opts] of [['JWT なし', {}], ['偽の JWT', { jwt: await sign({}, { key: 'stray' }) }], ['偽の cookie', { cookie: await sign({}, { key: 'stray' }) }]]) {
      const r = await health(opts);
      assert.strictEqual(r.status, 401, why);
      assert.deepStrictEqual(r.body, { error: 'login' }, why);
    }
    const want = { ok: true, relay: 2, ready: { db: true, openai: true, access: true, domains: true } };
    for (const [why, opts] of [['人', { jwt: await sign() }], ['サービストークン', { jwt: await service() }], ['人の cookie', { cookie: await sign() }]]) {
      const r = await health(opts);
      assert.strictEqual(r.status, 200, why);
      assert.deepStrictEqual(r.body, want, why);
    }
    const bad = await health({ jwt: await sign({ aud: ['0'.repeat(64)] }) });
    assert.strictEqual(bad.status, 503, 'aud の食い違い');
  });
});

test('RL5: /auth/done は人の JWT で 200 の HTML（「ログインできました。この窓は自動で閉じます。」・script なし・CSP default-src \'none\'・no-store）', { timeout: 5000 }, async () => {
  await scene({}, async ({ done, sign }) => {
    const r = await done({ jwt: await sign() });
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-security-policy') || '', /^default-src 'none'; style-src 'unsafe-inline'(;|$)/);
    assert.strictEqual(r.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(r.text.includes(DONE_TEXT), r.text);
    assert.match(r.text, /<title>NaTsu<\/title>/);
    assert.ok(!/<script|<link|<img|<iframe|src=|href=|https?:/i.test(r.text), '外の物を読む・script がある: ' + r.text);
    const c = await done({ cookie: await sign() });
    assert.strictEqual(c.status, 200, 'cookie の JWT');
    assert.strictEqual(c.text, r.text);
  });
});

test('RL7: 文字起こしの口は正しい JWT のメールで通り、1日の秒は a:u:<そのメールの sha256 の先頭 32 字> に数える（W-6 まで Bearer の札も通る）', { timeout: 5000 }, async () => {
  await scene({}, async ({ sign, stt1, stt, db, env, clock }) => {
    const email = R.mail('stt.user');
    const r = await stt1({ jwt: await sign({ email: R.mail('STT.User') }) });
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(r.body, { text: SAID + '区間1' });
    assert.strictEqual(stt.requests.length, 1);
    assert.strictEqual(stt.requests[0].authOk, true);
    const rows = await rowsOf(db, "SELECT key, n FROM counters WHERE key LIKE 'a:u:%'");
    assert.deepStrictEqual(rows, [{ key: await userKey(email), n: 1 }]);
    // cookie の JWT でも同じ
    assert.strictEqual((await stt1({ cookie: await sign({ email }) })).status, 200);
    assert.deepStrictEqual(await rowsOf(db, "SELECT key, n FROM counters WHERE key LIKE 'a:u:%'"), [{ key: await userKey(email), n: 2 }]);
    // W-6 までは、JWT が無ければ今の Bearer の札も通る（アプリの移り目）
    const { issueSession } = await R.load('auth.mjs');
    const { readConfig } = await R.load('config.mjs');
    const s = await issueSession(env, readConfig(env), { email: R.mail('bearer.user'), now: clock.now });
    const b = await stt1({ headers: { authorization: 'Bearer ' + s.token } });
    assert.strictEqual(b.status, 200, b.text);
    // JWT があれば JWT だけで決める（偽の JWT と正しい札を一緒に送っても通さない）
    const both = await stt1({ jwt: await sign({}, { key: 'stray' }), headers: { authorization: 'Bearer ' + s.token } });
    assert.strictEqual(both.status, 401);
    assert.strictEqual(stt.requests.length, 3);
  });
});

test('RL5: JWT は見出し Cf-Access-Jwt-Assertion → 無ければ Cookie の CF_Authorization の順に取る（見出しを優先・どちらも同じ確かめ）。/v1/me の via は hdr／cookie。cookie の偽の JWT も 401', { timeout: 5000 }, async () => {
  await scene({}, async ({ sign, me, hit }) => {
    const good = await sign();
    const forged = await sign({}, { key: 'stray' });
    const c = await me({ cookie: good });
    assert.strictEqual(c.status, 200, c.text);
    assert.strictEqual(c.body.via, 'cookie');
    const h = await me({ jwt: good, cookie: forged });
    assert.strictEqual(h.status, 200, '見出しを優先していない');
    assert.strictEqual(h.body.via, 'hdr');
    assert.strictEqual((await me({ jwt: forged, cookie: good })).status, 401, '見出しの偽の JWT を cookie で上書きした');
    assert.strictEqual((await me({ cookie: forged })).status, 401, 'cookie の偽の JWT');
    assert.strictEqual((await me({ cookie: await sign({ exp: 1 }) })).status, 401, 'cookie の切れた JWT');
    // ほかの cookie と並んでいても取る。名前はちょうど CF_Authorization だけ
    const mixed = await hit('GET', '/v1/me', { headers: { cookie: 'CF_AppSession=abc; CF_Authorization=' + good + '; theme=dark' } });
    assert.strictEqual(mixed.status, 200, mixed.text);
    assert.strictEqual(mixed.body.via, 'cookie');
    for (const cookie of ['XCF_Authorization=' + good, 'cf_authorization=' + good, 'CF_Authorization_x=' + good]) {
      assert.strictEqual((await hit('GET', '/v1/me', { headers: { cookie } })).status, 401, cookie.split('=')[0]);
    }
  });
});

test('RL1: /health は、見出しも cookie も無くても ctx.access.aud が POLICY_AUD と同じなら（サービスとして）200。ctx.access が無い・aud が違う・/v1/me と文字起こしの口では ctx.access を見ない（401）', { timeout: 5000 }, async () => {
  await scene({}, async ({ fa, health, me, done, stt1, stt }) => {
    for (const aud of [fa.aud, [fa.aud], ['0'.repeat(64), fa.aud]]) {
      const r = await health({ ctx: { access: { aud } } });
      assert.strictEqual(r.status, 200, JSON.stringify(aud));
      assert.strictEqual(r.body.ready.access, true);
    }
    for (const [why, ctx] of [['ctx.access なし', {}], ['aud 違い', { access: { aud: '0'.repeat(64) } }], ['aud なし', { access: {} }],
      ['aud が空の配列', { access: { aud: [] } }], ['access が文字', { access: fa.aud }]]) {
      assert.strictEqual((await health({ ctx })).status, 401, why);
    }
    const ctx = { access: { aud: fa.aud } };
    for (const [name, r] of [['/v1/me', await me({ ctx })], ['/auth/done', await done({ ctx })], [PATH, await stt1({ ctx })]]) {
      assert.strictEqual(r.status, 401, name);
      assert.deepStrictEqual(r.body, { error: 'login' }, name);
    }
    assert.strictEqual(stt.requests.length, 0);
  });
});

test('F28: 署名の合う JWT で aud か iss が違えば 503 not-ready（r: aud／iss）で、401 にしない。切れた exp は 401', { timeout: 5000 }, async () => {
  await scene({}, async ({ sign, me, accessRs, clock }) => {
    const before = accessRs().length;
    assert.strictEqual((await me({ jwt: await sign({ aud: ['1'.repeat(64)] }) })).status, 503);
    assert.strictEqual((await me({ jwt: await sign({ iss: 'https://natsu-other.cloudflareaccess.com' }) })).status, 503);
    assert.strictEqual((await me({ jwt: await sign({ exp: Math.floor(clock.now() / 1000) - 5 }) })).status, 401);
    // 署名が合わなければ、aud が違っても 401（503 は「チームの鍵で確かめられた」ときだけ）
    assert.strictEqual((await me({ jwt: await sign({ aud: ['1'.repeat(64)] }, { key: 'stray' }) })).status, 401);
    assert.deepStrictEqual(accessRs().slice(before), ['aud', 'iss', 'exp', 'sig']);
  });
  // POLICY_AUD の1字の入れ間違い: 正しい JWT でも全員 503（401 にするとアプリが全員の cookie を消す）
  await scene({}, async ({ sign, me, env }) => {
    const jwt = await sign();
    env.POLICY_AUD = (env.POLICY_AUD[0] === 'a' ? 'b' : 'a') + env.POLICY_AUD.slice(1);
    const r = await me({ jwt });
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(r.body, { error: 'not-ready' });
  });
});

test('RF42: email と空でない sub の無い JWT・sub が空で common_name の無い JWT・email と common_name の両方がある JWT は 401 bad-jwt', { timeout: 5000 }, async () => {
  await scene({}, async ({ sign, service, me, health, accessRs }) => {
    const cases = [
      ['sub が無い人', await sign({ sub: undefined })],
      ['sub が空の人', await sign({ sub: '' })],
      ['sub が数の人', await sign({ sub: 7 })],
      ['email も common_name も無い', await sign({ email: undefined, sub: '' })],
      ['email と common_name', await sign({ common_name: 'x.access' })],
      ['common_name のサービスに email', await service({ email: R.mail('svc') })],
      ['サービスの sub が空でない', await service({ sub: 'svc' })],
      ['サービスの common_name が数', await service({ common_name: 5 })],
    ];
    for (const [why, jwt] of cases) {
      const before = accessRs().length;
      const r = await me({ jwt });
      assert.strictEqual(r.status, 401, why);
      assert.deepStrictEqual(accessRs().slice(before), ['bad-jwt'], why);
      assert.strictEqual((await health({ jwt })).status, 401, '/health ' + why);
    }
  });
});

test('F24: @ より前に + のあるメール（会社のドメインでも）は 403 denied（r: alias）で、偽の OpenAI に送らず、1日の秒を数えない', { timeout: 5000 }, async () => {
  await scene({}, async ({ sign, me, stt1, stt, db, accessRs }) => {
    for (const local of ['test.user+x', 'test.user+', '+test.user', 'a+b+c']) {
      const jwt = await sign({ email: R.mail(local) });
      const r = await me({ jwt });
      assert.strictEqual(r.status, 403, local);
      assert.deepStrictEqual(r.body, { error: 'denied' }, local);
      const s = await stt1({ jwt });
      assert.strictEqual(s.status, 403, local);
      assert.deepStrictEqual(s.body, { error: 'denied' }, local);
    }
    assert.ok(accessRs().length > 0 && accessRs().every((r) => r === 'alias'), accessRs().join(','));
    assert.strictEqual(stt.requests.length, 0, 'OpenAI へ送った');
    assert.deepStrictEqual(await rowsOf(db, "SELECT key FROM counters WHERE key LIKE 'a:%'"), []);
  });
});

test('RL5: どの道の答えにも Location と Access-Control-Allow-* が無い。OPTIONS は 405。/auth/done?next=https://evil.example は同じ本文（クエリを読まない）・CSP に frame-ancestors \'none\'', { timeout: 5000 }, async () => {
  await scene({}, async ({ sign, hit, done }) => {
    const jwt = await sign();
    const answers = [];
    for (const [m, p, o] of [['GET', '/health', {}], ['GET', '/health', { jwt }], ['GET', '/v1/me', {}], ['GET', '/v1/me', { jwt }],
      ['GET', '/auth/done', {}], ['GET', '/auth/done', { jwt }], ['GET', '/auth/done?next=https://evil.example', { jwt }],
      ['POST', PATH, { jwt, headers: { 'content-type': 'audio/wav', origin: 'https://evil.example' }, body: R.wav(1) }],
      ['GET', '/nope', { jwt }], ['POST', '/v1/me', { jwt }], ['POST', '/auth/done', { jwt }]]) {
      answers.push([m + ' ' + p, await hit(m, p, { ...o, headers: { origin: 'https://evil.example', ...(o.headers || {}) } })]);
    }
    for (const p of ['/health', '/v1/me', '/auth/done', PATH]) {
      const r = await hit('OPTIONS', p, { jwt, headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
      assert.strictEqual(r.status, 405, 'OPTIONS ' + p);
      answers.push(['OPTIONS ' + p, r]);
    }
    for (const [name, r] of answers) {
      assert.strictEqual(r.headers.get('location'), null, name);
      for (const [k] of r.headers) assert.ok(!k.startsWith('access-control-'), `${name} に ${k}`);
    }
    const plain = await done({ jwt });
    const q = await done({ jwt }, '?next=https://evil.example&redirect=%2F%2Fevil.example');
    assert.strictEqual(q.status, 200);
    assert.strictEqual(q.text, plain.text, 'クエリで本文が変わった');
    assert.ok(!q.text.includes('evil'), 'クエリを本文に写した');
    const csp = q.headers.get('content-security-policy') || '';
    assert.ok(csp.split(';').map((x) => x.trim()).includes("frame-ancestors 'none'"), csp);
  });
});

test('F18: 知らない kid の要求が同時に 5 本来ても鍵の口へは1回（同じ Promise を待つ）。鍵の口が落ちた後 30 秒は取りに行かず 503', { timeout: 5000 }, async () => {
  await scene({}, async ({ sign, me, fa, clock }) => {
    fa.setDelay(80);
    const first = await Promise.all([1, 2, 3, 4, 5].map(async () => me({ jwt: await sign() })));
    assert.deepStrictEqual(first.map((r) => r.status), [200, 200, 200, 200, 200]);
    assert.strictEqual(fa.certHits, 1, '写しの無いときの同時の要求で何本も取りに行った');
    await fa.rotate();
    clock.advance(31 * S);
    const jwts = await Promise.all([1, 2, 3, 4, 5].map(() => sign()));
    const second = await Promise.all(jwts.map((jwt) => me({ jwt })));
    assert.deepStrictEqual(second.map((r) => r.status), [200, 200, 200, 200, 200]);
    assert.strictEqual(fa.certHits, 2, '同時の知らない kid で何本も取りに行った');
    fa.setDelay(0);
    // 鍵の口が落ちた: 写しが古く（1時間の後）取りに行って失敗 → 503。30 秒は取りに行かない
    fa.setCerts('500');
    clock.advance(61 * MIN);
    const down = await me({ jwt: await sign() });
    assert.strictEqual(down.status, 503);
    assert.strictEqual(fa.certHits, 3);
    fa.setCerts('ok');
    assert.strictEqual((await me({ jwt: await sign() })).status, 503, '落ちた後 30 秒の内に取りに行った');
    assert.strictEqual(fa.certHits, 3);
    clock.advance(31 * S);
    assert.strictEqual((await me({ jwt: await sign() })).status, 200, '30 秒の後に取り直さない');
    assert.strictEqual(fa.certHits, 4);
  });
});

test('RL2・RF42: TEAM_DOMAIN か POLICY_AUD がそろっていない（用意の途中）ときは、署名の合う JWT でも /v1/me・/auth/done・文字起こしの口は 503 not-ready（r: not-ready）。鍵の口に行かず、OpenAI に送らず、JWT があれば Bearer の札に回らない', { timeout: 5000 }, async () => {
  for (const [why, env] of [['POLICY_AUD が無い', { POLICY_AUD: undefined }], ['TEAM_DOMAIN が無い', { TEAM_DOMAIN: undefined }],
    ['POLICY_AUD の形が違う', { POLICY_AUD: 'zz' }]]) {
    await scene({ env }, async ({ sign, me, done, stt1, stt, fa, accessRs, env: e, clock }) => {
      assert.strictEqual(e.ACCESS_CERTS_BASE, fa.certsBase, why);
      const jwt = await sign();
      for (const [name, r] of [['/v1/me', await me({ jwt })], ['/auth/done', await done({ jwt })], [PATH, await stt1({ jwt })],
        ['cookie', await me({ cookie: jwt })]]) {
        assert.strictEqual(r.status, 503, `${why} ${name}: ${r.text}`);
        assert.deepStrictEqual(r.body, { error: 'not-ready' }, `${why} ${name}`);
      }
      // JWT があれば、正しい Bearer の札を一緒に送っても札に回らない
      const { issueSession } = await R.load('auth.mjs');
      const { readConfig } = await R.load('config.mjs');
      const s = await issueSession(e, readConfig(e), { email: R.mail('bearer.user'), now: clock.now });
      const both = await stt1({ jwt, headers: { authorization: 'Bearer ' + s.token } });
      assert.strictEqual(both.status, 503, `${why} JWT と札: ${both.text}`);
      assert.deepStrictEqual(accessRs(), ['not-ready', 'not-ready', 'not-ready', 'not-ready', 'not-ready'], why);
      assert.strictEqual(fa.certHits, 0, `${why}: そろっていないのに鍵の口へ行った`);
      assert.strictEqual(stt.requests.length, 0, `${why}: OpenAI へ送った`);
    });
  }
});

test('F9: どの場面の記録にも JWT・メール・チームの名前・kid が無い', { timeout: 5000 }, () => {
  assert.ok(ALL.scenes >= 20, `場面が少ない（${ALL.scenes}）。このテストはファイルの最後に置く`);
  for (const r of ['ok', 'no-jwt', 'bad-jwt', 'alg', 'kid', 'sig', 'iss', 'aud', 'exp', 'nbf', 'type', 'certs', 'domain', 'alias', 'blocked', 'service', 'not-ready']) {
    assert.ok(ALL.rs.has(r), `記録に access の ${r} の行が無い`);
  }
  const logs = ALL.logs.map((l) => JSON.parse(l));
  for (const p of logs.filter((x) => x.ev === 'access' && x.r === 'ok')) assert.ok(['hdr', 'cookie', 'ctx'].includes(p.v), JSON.stringify(p));
  const text = ALL.logs.join('\n') + '\n' + ALL.heads.join('\n');
  for (const s of ALL.secrets) assert.ok(!text.includes(s), `記録・見出しに ${s.slice(0, 12)}…`);
  assert.ok(!/example\.|cloudflareaccess|eyJ|natsu-test/i.test(text), '記録・見出しにメールのドメイン・チームの名前・JWT');
  // 答えの本文にも JWT とチームの名前は無い（/v1/me の email だけがメールを返す）
  const bodies = ALL.bodies.join('\n');
  assert.ok(!/eyJ|cloudflareaccess|natsu-test/.test(bodies), '答えの本文に JWT かチームの名前');
});
