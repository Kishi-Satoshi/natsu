/* relay-health.test.js — 第1d回 RL1・RL2・RL7: 中継の骨組み（node --test で Worker を起こさずに呼ぶ） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('./helpers/relay-run');

test('RL1: GET /health は 200 で、秘密の有無と D1 の表だけを真偽で返す（値は出さない）', { timeout: 5000 }, async () => {
  await R.withRelay({}, async ({ call, env, logs }) => {
    const res = await call('GET', '/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('cache-control'), 'no-store');
    const j = await res.json();
    assert.deepStrictEqual(j, { ok: true, relay: 1, ready: { db: true, openai: true, mail: true, domains: true } });
    const all = JSON.stringify(j) + logs.join('\n');
    for (const s of [env.OPENAI_API_KEY, env.RESEND_API_KEY, 'example.com']) assert.ok(!all.includes(s), `答えか記録に ${s}`);
  });
  await R.withRelay({ env: { OPENAI_API_KEY: undefined, ALLOWED_EMAIL_DOMAINS: ' , ' } }, async ({ call }) => {
    const j = await (await call('GET', '/health')).json();
    assert.deepStrictEqual(j.ready, { db: true, openai: false, mail: true, domains: false });
  });
  await R.withRelay({ noSchema: true }, async ({ call }) => {
    assert.strictEqual((await (await call('GET', '/health')).json()).ready.db, false);
  });
  // 表はあっても、表の形の印（meta.schema）が無い・古ければ false（表を流しきっていない D1）
  await R.withRelay({}, async ({ call, db }) => {
    await db.prepare("UPDATE meta SET value = '0' WHERE key = 'schema'").run();
    assert.strictEqual((await (await call('GET', '/health')).json()).ready.db, false, "meta.schema が '0'");
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
  const base = { OPENAI_API_KEY: 'k', RESEND_API_KEY: 'k', ALLOWED_EMAIL_DOMAINS: 'Example.com, example.org ', MAIL_FROM: `NaTsu <${R.mail('a')}>` };
  assert.strictEqual(readConfig({ ...base, OPENAI_BASE: 'http://127.0.0.1:4010/openai/v1' }).openaiBase, 'http://127.0.0.1:4010/openai/v1');
  assert.strictEqual(readConfig({ ...base, RESEND_BASE: 'http://127.0.0.1:4011' }).resendBase, 'http://127.0.0.1:4011');
  for (const v of ['https://evil.example/v1', 'http://localhost:1/v1', 'http://127.0.0.1.example.com:1/v1', '',
    'http://evil.example:8080/v1', 'http://localhost:4010/v1', 'http://127.0.0.1.example.com:4010/v1', 'http://' + R.mail('127.0.0.1:4010', 'evil.example:80') + '/v1',
    'https://127.0.0.1:4010/v1', 'http://127.0.0.1:4010/v1?x=1', ' http://127.0.0.1:4010/v1', undefined, 4010]) {
    assert.strictEqual(readConfig({ ...base, OPENAI_BASE: v }).openaiBase, 'https://api.openai.com/v1', String(v));
    assert.strictEqual(readConfig({ ...base, RESEND_BASE: v }).resendBase, 'https://api.resend.com', String(v));
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

test('RL2: 表の形 v1 を偽の D1 に2回流しても同じ（IF NOT EXISTS）で、meta.schema は 1', { timeout: 5000 }, async () => {
  const { SCHEMA_SQL, SCHEMA_VERSION } = await R.load('schema.mjs');
  const db = require('./helpers/fake-d1').makeFakeD1();
  try {
    await db.exec(SCHEMA_SQL); await db.exec(SCHEMA_SQL);
    assert.strictEqual(SCHEMA_VERSION, 1);
    assert.strictEqual(await db.prepare("SELECT value FROM meta WHERE key = 'schema'").first('value'), '1');
  } finally { db.close(); }
});

// ---- ここから下は計画の W-1 の手順 1 に足したもの（W-2〜W-4 が使う部品と、テストの台そのものを先に固める）

test('RL1: http の部品 — json は no-store・readCapped は上限を越えたら null（流れの本文でも）・readJson は 2KB を越えれば too-large', { timeout: 5000 }, async () => {
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
  assert.deepStrictEqual(await H.readJson(req('{"email":"x"}'), 2048), { ok: true, value: { email: 'x' } });
  assert.deepStrictEqual(await H.readJson(req('{"a":"' + 'x'.repeat(2100) + '"}', true), 2048), { ok: false, error: 'too-large' });
  for (const bad of ['{', '[1]', 'null', '"s"', '']) assert.deepStrictEqual(await H.readJson(req(bad), 2048), { ok: false, error: 'bad-request' }, bad);
});

test('RL1: http の部品 — sha256hex・札（nt1_ と base64url 43 字）・6 けたのコード・IP の鍵（ハッシュだけ。無ければ ip:unknown）', { timeout: 5000 }, async () => {
  const H = await R.load('http.mjs');
  assert.strictEqual(await H.sha256hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const toks = new Set();
  for (let i = 0; i < 50; i++) {
    const t = H.randomToken();
    assert.match(t, /^nt1_[A-Za-z0-9_-]{43}$/);
    toks.add(t);
    assert.match(H.randomCode(), /^[0-9]{6}$/);
  }
  assert.strictEqual(toks.size, 50);
  // 棄却: 2^32 を 100 万で割った余りの分（4,294,000,000 以上）が出たら捨てて引き直す（そのまま割ると 0〜967295 が出やすくなる）
  const seq = [4294967295, 4294000000, 123];
  const draws = [];
  globalThis.crypto.getRandomValues = (a) => { const v = seq.shift(); draws.push(v); a[0] = v; return a; };
  try { assert.strictEqual(H.randomCode(), '000123'); } finally { delete globalThis.crypto.getRandomValues; }
  assert.deepStrictEqual(draws, [4294967295, 4294000000, 123]);
  assert.match(H.randomCode(), /^[0-9]{6}$/, '本物の getRandomValues に戻していない');
  const ipReq = (ip) => new Request('https://relay.test/x', { headers: ip === undefined ? {} : { 'cf-connecting-ip': ip, 'x-forwarded-for': '198.51.100.7' } });
  const k = await H.clientIpKey(ipReq('192.0.2.1'));
  assert.strictEqual(k, 'ip:' + await H.sha256hex('192.0.2.1'));
  assert.ok(!k.includes('192.0.2.1'));
  assert.strictEqual(await H.clientIpKey(ipReq(undefined)), 'ip:unknown');
  assert.strictEqual(await H.clientIpKey(ipReq('  ')), 'ip:unknown');
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
