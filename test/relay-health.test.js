/* relay-health.test.js — 第1d回 RL1・RL2・RL7: 中継の骨組み（node --test で Worker を起こさずに呼ぶ） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('./helpers/relay-run');

// 第1d回 W-5 で意図して変えた: ready の名前は db・openai・access・domains（mail を外し、Access の秘密の欄 TEAM_DOMAIN・POLICY_AUD が
// そろったかの access を足した）・relay は 2。Access がそろった後の /health（確かめた JWT のときだけ）は test/relay-access.test.js が見る
test('RL1: GET /health は 200 で、秘密の有無と D1 の表だけを真偽で返す（値は出さない）', { timeout: 5000 }, async () => {
  await R.withRelay({}, async ({ call, env, logs }) => {
    const res = await call('GET', '/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    const j = await res.json();
    assert.deepStrictEqual(j, { ok: true, relay: 2, ready: { db: true, openai: true, access: false, domains: true } });
    const all = JSON.stringify(j) + logs.join('\n');
    for (const s of [env.OPENAI_API_KEY, 'example.com']) assert.ok(!all.includes(s), `答えか記録に ${s}`);
  });
  await R.withRelay({ env: { OPENAI_API_KEY: undefined, ALLOWED_EMAIL_DOMAINS: ' , ' } }, async ({ call }) => {
    const j = await (await call('GET', '/health')).json();
    assert.deepStrictEqual(j.ready, { db: true, openai: false, access: false, domains: false });
  });
  // （第1d回 W-6 で、Resend の秘密の欄の場面は下の「RL2: RESEND_API_KEY・MAIL_FROM・MAIL_DAILY_MAX を入れても…」に移した）
  await R.withRelay({ noSchema: true }, async ({ call }) => {
    assert.strictEqual((await (await call('GET', '/health')).json()).ready.db, false);
  });
  // 表はあっても、表の形の印（meta.schema）が無い・古ければ false（表を流しきっていない D1）
  await R.withRelay({}, async ({ call, db }) => {
    await db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema'").run();
    assert.strictEqual((await (await call('GET', '/health')).json()).ready.db, false, "meta.schema が '0'");
    // 第1d回 W-6: 表の形 v2。v1 の印のままの D1（v2 を流していない）は false
    await db.prepare("UPDATE meta SET value = '1' WHERE key = 'schema'").run();
    assert.strictEqual((await (await call('GET', '/health')).json()).ready.db, false, "meta.schema が '1'");
    await db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema'").run();
    assert.strictEqual((await (await call('GET', '/health')).json()).ready.db, true, "meta.schema が '3'（2 以上）");
    await db.prepare('DELETE FROM meta').run();
    assert.strictEqual((await (await call('GET', '/health')).json()).ready.db, false, 'meta.schema が無い');
  });
});

test('RL1: 知らない道は 404・合わない方法は 405・例外は外に投げず 500 と記録1行', { timeout: 5000 }, async () => {
  await R.withRelay({}, async ({ call, logs }) => {
    assert.strictEqual((await call('GET', '/nope')).status, 404);
    assert.strictEqual((await call('POST', '/health')).status, 405);
  });
  await R.withRelay({ env: { DB: { prepare() { throw new Error('壊れた D1 secret-xyz'); } } } }, async ({ call, logs }) => {
    const res = await call('GET', '/health');
    assert.strictEqual(res.status, 200);   // health は D1 の失敗を db: false にする
    assert.strictEqual((await res.json()).ready.db, false);
    assert.ok(!logs.join('\n').includes('secret-xyz'), '例外の文を記録に写した');
  });
});

test('RL1: 道の中で投げても外に投げず、500 { error: internal } と記録1行（例外の文・秘密を写さない）', { timeout: 5000 }, async () => {
  await R.withRelay({}, async ({ call, env, logs }) => {
    Object.defineProperty(env, 'OPENAI_API_KEY', { get() { throw new Error('読めない secret-abc'); }, enumerable: true });
    const res = await call('GET', '/health');
    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    assert.deepStrictEqual(await res.json(), { error: 'internal' });
    assert.deepStrictEqual(logs.map((l) => JSON.parse(l)), [{ ev: 'error', r: 'internal' }]);
  });
  await R.withRelay({}, async ({ call }) => {
    const res = await call('POST', '/health');
    assert.deepStrictEqual(await res.json(), { error: 'method' });
    assert.deepStrictEqual(await (await call('GET', '/nope')).json(), { error: 'not-found' });
    assert.strictEqual((await call('CONSTRUCTOR', '/health')).status, 405, '原型の名前を道の方法として呼んだ');
  });
});

test('RL7: logEvent は決まった欄と形の値だけを書く（メール・IP・文・札を写さない）', { timeout: 5000 }, async () => {
  const { logEvent } = await R.load('log.mjs');
  const lines = R.captureConsole(() => logEvent('stt', { st: 200, ms: 12, sec: 75, email: R.mail('a'), r: 'Hello World', text: '会議', token: 'nt1_x', ip: '192.0.2.1' }));
  assert.deepStrictEqual(lines.map((l) => JSON.parse(l)), [{ ev: 'stt', st: 200, ms: 12, sec: 75 }]);
  // 値の形が合っていても、決まった名前のほかの欄は捨てる（確認コード・ハッシュ・時刻は数や短い符号の形をしている）
  const more = R.captureConsole(() => logEvent('auth.verify', { r: 'ok', left: 4, code: '483920', emailHash: 'ab12cd', at: 1700, n2: 3, scope: 'user' }));
  assert.deepStrictEqual(more.map((l) => JSON.parse(l)), [{ ev: 'auth.verify', r: 'ok', left: 4, scope: 'user' }]);
});

test('RL2: 試しの宛先は 127.0.0.1 の http だけ。ほかの値は本物の固定の URL（鍵をほかのホストへ運ばない）', { timeout: 5000 }, async () => {
  const { readConfig } = await R.load('config.mjs');
  const base = { OPENAI_API_KEY: 'k', ALLOWED_EMAIL_DOMAINS: 'Example.com, example.org ' };
  assert.strictEqual(readConfig({ ...base, OPENAI_BASE: 'http://127.0.0.1:4010/openai/v1' }).openaiBase, 'http://127.0.0.1:4010/openai/v1');
  for (const v of ['https://evil.example/v1', 'http://localhost:1/v1', 'http://127.0.0.1.example.com:1/v1', '',
    'http://evil.example:8080/v1', 'http://localhost:4010/v1', 'http://127.0.0.1.example.com:4010/v1', 'http://' + R.mail('127.0.0.1:4010', 'evil.example:80') + '/v1',
    'https://127.0.0.1:4010/v1', 'http://127.0.0.1:4010/v1?x=1', ' http://127.0.0.1:4010/v1', undefined, 4010]) {
    assert.strictEqual(readConfig({ ...base, OPENAI_BASE: v }).openaiBase, 'https://api.openai.com/v1', String(v));
  }
  const c = readConfig({ ...base, STT_MODEL: 'gpt-4o-transcribe; drop' });
  assert.strictEqual(c.model, 'gpt-4o-transcribe');
  assert.deepStrictEqual([...c.domains].sort(), ['example.com', 'example.org']);
  assert.strictEqual(c.dailyUserSec, 14400);
  assert.strictEqual(readConfig({ ...base, DAILY_USER_SEC: '-5' }).dailyUserSec, 14400);
});

test('RL1: 中継のコードは node: を読まず Buffer も console も直に使わない（Workers と Node の両方で動く・記録は log.mjs だけ）', { timeout: 5000 }, () => {
  const dir = path.join(__dirname, '..', 'relay');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.mjs'))) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/from\s+['"]node:|require\(/.test(s), `${f} が node: か require を使う`);
    assert.ok(!/\bBuffer\b/.test(s), `${f} が Buffer を使う`);
    if (f !== 'log.mjs') assert.ok(!/\bconsole\./.test(s), `${f} が console を直に使う`);
  }
});

// 第1d回 W-6 で意図して変えた: 表の形は v2（自前のログインの login_codes と sessions を消し、1日の秒の数えと止めたメールは残す）。
// v1 の表のある D1（0.8.0 の前の試しの D1）に v2 を流したときの形を見る。V1_SQL は W-1 の relay/schema.mjs の SCHEMA_SQL の写し
const V1_SQL = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  idp TEXT NOT NULL DEFAULT 'email',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_email ON sessions (email);
CREATE TABLE IF NOT EXISTS blocked_emails (email TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, win INTEGER NOT NULL, n INTEGER NOT NULL);
INSERT INTO meta (key, value) VALUES ('schema', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value;
`;
const H32 = 'ab'.repeat(16);
const H64 = 'cd'.repeat(32);

// v1 の D1 に、どの表にも行を1つ以上置く（数えの鍵は W-2〜W-4 の全部の形）
async function seedV1(db) {
  await db.exec(V1_SQL);
  await db.prepare('INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?1, ?2, ?3, 0, ?4)').bind(R.mail('code.user'), H64, 2000, 1000).run();
  await db.prepare('INSERT INTO sessions (token_hash, email, idp, created_at, last_used_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?4, ?5)').bind(H64, R.mail('code.user'), 'email', 1000, 9000).run();
  await db.prepare('INSERT INTO blocked_emails (email, at) VALUES (?1, ?2)').bind(R.mail('blocked.user'), 1234).run();
  for (const [key, win, n] of [['a:u:' + H32, 86400 * 20000, 75], ['a:all', 86400 * 20000, 300], ['s:e:' + H32, 900, 2], ['s:d:' + H32, 86400, 3],
    ['s:ip:' + H64, 3600, 4], ['v:ip:unknown', 3600, 5], ['mail', 86400, 6]]) {
    await db.prepare('INSERT INTO counters (key, win, n) VALUES (?1, ?2, ?3)').bind(key, win, n).run();
  }
}

// 表と索引の名前（sqlite_ の内側のものを除く）と、残る表の全部の行
async function shapeOf(db) {
  const objs = (await db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).results;
  const rows = {};
  for (const { type, name } of objs) if (type === 'table') rows[name] = (await db.prepare(`SELECT * FROM ${name} ORDER BY 1`).all()).results;
  return { objs, rows };
}

const V2_SHAPE = () => ({
  objs: [{ type: 'table', name: 'blocked_emails' }, { type: 'table', name: 'counters' }, { type: 'table', name: 'meta' }],
  rows: {
    blocked_emails: [{ email: R.mail('blocked.user'), at: 1234 }],
    counters: [{ key: 'a:all', win: 86400 * 20000, n: 300 }, { key: 'a:u:' + H32, win: 86400 * 20000, n: 75 }],
    meta: [{ key: 'schema', value: '2' }],
  },
});

test('RL2: 表の形 v2 を v1 の D1 に流すと login_codes と sessions が無くなり、counters の a: の行と blocked_emails の行は残る。2回流しても同じ。meta.schema は 2', { timeout: 5000 }, async () => {
  const { SCHEMA_SQL, SCHEMA_VERSION } = await R.load('schema.mjs');
  assert.strictEqual(SCHEMA_VERSION, 2);
  const db = require('./helpers/fake-d1').makeFakeD1();
  try {
    await seedV1(db);
    await db.exec(SCHEMA_SQL);
    assert.deepStrictEqual(await shapeOf(db), V2_SHAPE(), '1回目');
    await db.exec(SCHEMA_SQL);
    assert.deepStrictEqual(await shapeOf(db), V2_SHAPE(), '2回目');
  } finally { db.close(); }
  // 空の D1 に流しても同じ表の形（行は meta だけ）。2回流しても同じ
  const fresh = require('./helpers/fake-d1').makeFakeD1();
  try {
    await fresh.exec(SCHEMA_SQL); await fresh.exec(SCHEMA_SQL);
    const sh = await shapeOf(fresh);
    assert.deepStrictEqual(sh.objs, V2_SHAPE().objs);
    assert.deepStrictEqual(sh.rows, { blocked_emails: [], counters: [], meta: [{ key: 'schema', value: '2' }] });
  } finally { fresh.close(); }
  // 注釈は SQL の中に書かない（D1 の問い合わせの API にそのまま渡す）。札・コード・Resend の語も無い
  assert.ok(!/--|\/\*|login_codes \(|sessions \(|token_hash|code_hash/.test(SCHEMA_SQL), SCHEMA_SQL);
});

test('RL2: v2 の SQL の途中まで（DROP の前で止めた形）を流した D1 に、もう一度全部を流すと v2 の形になる', { timeout: 5000 }, async () => {
  const { SCHEMA_SQL } = await R.load('schema.mjs');
  const cut = SCHEMA_SQL.indexOf('DROP TABLE');
  assert.ok(cut > 0, 'v2 の SQL に DROP TABLE が無い');
  const db = require('./helpers/fake-d1').makeFakeD1();
  try {
    await seedV1(db);
    await db.exec(SCHEMA_SQL.slice(0, cut));   // 出す台本が DROP の前で止まった（D1 の口の誤り・時間切れ）
    const half = await shapeOf(db);
    assert.ok(half.objs.some((o) => o.name === 'sessions'), 'DROP の前で止めたのに sessions が無い（途中の形を作れていない）');
    assert.strictEqual(half.rows.meta[0].value, '1', '途中までで meta.schema が 2 になった（/health の ready.db が早く真になる）');
    await db.exec(SCHEMA_SQL);   // 次の［Run workflow］
    assert.deepStrictEqual(await shapeOf(db), V2_SHAPE());
  } finally { db.close(); }
});

// ---- ここから下は計画の W-1 の手順 1 に足したもの（W-2〜W-4 が使う部品と、テストの台そのものを先に固める）

// 第1d回 W-6 で意図して変えた: readJson（/auth/start・/auth/verify の本文）は使う所が無くなったので消した（下の「札・確認コード・IP の鍵の部品は無い」）
test('RL1: http の部品 — json は no-store・readCapped は上限を越えたら null（流れの本文でも）', { timeout: 5000 }, async () => {
  const H = await R.load('http.mjs');
  const res = H.json(201, { a: 1 }, { 'retry-after': '3' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
  assert.strictEqual(res.headers.get('retry-after'), '3');
  assert.deepStrictEqual(await res.json(), { a: 1 });
  const req = (body, stream) => {
    const init = { method: 'POST', body };
    if (stream) {
      const bytes = new TextEncoder().encode(body);
      init.body = new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 3)); c.enqueue(bytes.slice(3)); c.close(); } });
      init.duplex = 'half';
    }
    return new Request('https://relay.test/x', init);
  };
  for (const stream of [false, true]) {
    assert.deepStrictEqual([...await H.readCapped(req('abcdef', stream), 6)], [...new TextEncoder().encode('abcdef')], `stream=${stream}`);
    assert.strictEqual(await H.readCapped(req('abcdefg', stream), 6), null, `stream=${stream}`);
  }
  assert.strictEqual((await H.readCapped(new Request('https://relay.test/x'), 6)).length, 0);
});

// 第1d回 W-6 で意図して変えた: 自前のログインを消したので、札（randomToken）・確認コード（randomCode）・IP の鍵（clientIpKey）・
// JSON の本文（readJson）と、窓の数え（hits・hit・windowStart・release）は中継に無い。sha256hex（1日の秒の鍵）は残す
test('RL1: http の部品 — sha256hex は残り、札・確認コード・IP の鍵・JSON の本文の部品と、/auth/start の窓の数えは無い', { timeout: 5000 }, async () => {
  const H = await R.load('http.mjs');
  assert.strictEqual(await H.sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.deepStrictEqual(Object.keys(H).sort(), ['json', 'readCapped', 'sha256hex']);
  const L = await R.load('limits.mjs');
  assert.deepStrictEqual(Object.keys(L).sort(), ['ALL_USAGE_KEY', 'dayNumber', 'refundUsage', 'reserveUsage', 'secondsToDayEnd', 'usage']);
});

test('テストの台: 中継の中の fetch は 127.0.0.1 のほかへ出られない・偽の D1 の batch は1つのトランザクション', { timeout: 5000 }, async () => {
  await R.withRelay({}, async ({ db }) => {
    for (const u of ['https://api.openai.com/v1/models', 'http://localhost:1/', 'http://127.0.0.1.example.com:1/']) {
      await assert.rejects(() => fetch(u), /外への通信（試験）/, u);
    }
    await assert.rejects(() => db.batch([
      db.prepare('INSERT INTO counters (key, win, n) VALUES (?1, ?2, 1)').bind('k', 1),
      db.prepare('INSERT INTO no_such_table VALUES (1)'),
    ]));
    assert.strictEqual(await db.prepare('SELECT n FROM counters WHERE key = ?1').bind('k').first('n'), null, 'ROLLBACK されていない');
    const r = await db.prepare('INSERT INTO counters (key, win, n) VALUES (?1, ?2, 1)').bind('k', 1).run();
    assert.strictEqual(r.meta.changes, 1);
    assert.deepStrictEqual((await db.prepare('SELECT key, n FROM counters').all()).results, [{ key: 'k', n: 1 }]);
  });
  assert.ok(!String(globalThis.fetch).includes('外への通信'), 'fetch を戻していない');
});

// ---- 第1d回 W-6（自前のログインを消す）
test('RL1: /auth/start・/auth/verify・/auth/logout・/auth/me は 404', { timeout: 5000 }, async () => {
  await R.withRelay({}, async ({ call, db, logs }) => {
    for (const [method, p, body] of [['POST', '/auth/start', { email: R.mail('a') }], ['POST', '/auth/verify', { email: R.mail('a'), code: '123456' }],
      ['POST', '/auth/logout'], ['GET', '/auth/me'], ['GET', '/auth/start'], ['DELETE', '/auth/me']]) {
      const r = await call(method, p, { body, headers: { authorization: 'Bearer nt1_' + 'A'.repeat(43) }, ip: '192.0.2.1' });
      assert.strictEqual(r.status, 404, `${method} ${p}`);
      assert.deepStrictEqual(await r.json(), { error: 'not-found' }, `${method} ${p}`);
    }
    assert.deepStrictEqual(db.ran, [], 'D1 に触れた');
    assert.deepStrictEqual(logs, [], '記録を書いた');
  });
  // 自前のログインのファイル（確認コード・札・Resend のメール）は中継に無い
  for (const f of ['auth.mjs', 'mail.mjs']) assert.ok(!fs.existsSync(path.join(R.RELAY_DIR, f)), `relay/${f} が残っている`);
  const src = fs.readdirSync(R.RELAY_DIR).filter((x) => x.endsWith('.mjs')).map((x) => fs.readFileSync(path.join(R.RELAY_DIR, x), 'utf8')).join('\n');
  assert.ok(!/\/auth\/(?:start|verify|logout|me)\b|requireSession|issueSession|resend|MAIL_FROM|nt1_|code_hash|token_hash/i.test(src.replace(/^\s*\/\/.*$/gm, '')),
    '中継のコード（注釈の外）に自前のログインの名前が残っている（表の形 v2 の DROP の行は上の RL2 の表の形のテストが見る）');
});

test('RL2: RESEND_API_KEY・MAIL_FROM・MAIL_DAILY_MAX を入れても ready にも答えにも出ない', { timeout: 5000 }, async () => {
  const { readConfig, DEFAULTS } = await R.load('config.mjs');
  const old = { RESEND_API_KEY: 're_test_must_not_show_1', MAIL_FROM: 'NaTsu <' + R.mail('login') + '>', MAIL_DAILY_MAX: '77', RESEND_BASE: 'http://127.0.0.1:4011' };
  const c = readConfig({ OPENAI_API_KEY: 'k', ALLOWED_EMAIL_DOMAINS: 'example.com', ...old });
  assert.deepStrictEqual(Object.keys(c).sort(), ['certsBase', 'dailyAllSec', 'dailyUserSec', 'dayOffsetMin', 'domains', 'maxAudioBytes', 'model',
    'openaiBase', 'openaiKey', 'policyAud', 'ready', 'teamDomain']);
  assert.deepStrictEqual(Object.keys(c.ready).sort(), ['access', 'domains', 'openai']);
  assert.deepStrictEqual(Object.keys(DEFAULTS).sort(), ['dailyAllSec', 'dailyUserSec', 'dayOffsetMin', 'maxAudioBytes', 'model', 'openaiBase']);
  assert.ok(!JSON.stringify(c, (k, v) => (v instanceof Set ? [...v] : v)).match(/re_test|login|4011|77/), '読んだ値に Resend とメールの欄');
  await R.withRelay({ env: old }, async ({ call, logs }) => {
    const res = await call('GET', '/health');
    const text = await res.text();
    assert.deepStrictEqual(JSON.parse(text), { ok: true, relay: 2, ready: { db: true, openai: true, access: false, domains: true } });
    for (const v of Object.values(old)) assert.ok(!(text + logs.join('\n')).includes(v), `答えか記録に ${v}`);
  });
});
