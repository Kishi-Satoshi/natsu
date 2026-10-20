/*
 * secrets.test.js — クラウドの文字起こしの鍵の保管（第1c回 OL3。RF30）
 * safeStorage は偽物（暗号の代わりに印を付けた hex）。ファイルは第1a回の src/jsonfile.js で読み書きする。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const J = require('../src/jsonfile');
const { makeSecrets } = require('../src/secrets');

const KEY = 'gsk_test_0123456789';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-sec-日本語𠮷-'));   // 利用者名が日本語の PC と同じ（第1d回 A-2 で名前を足した）
const fakeSafe = ({ avail = true, reEncrypt = false, backend = 'dpapi' } = {}) => ({
  calls: [],
  isAsyncEncryptionAvailable: async () => avail,
  encryptStringAsync: async function (s) { this.calls.push('enc'); return Buffer.from(`ENC1:${Buffer.from(s, 'utf8').toString('hex')}`); },
  decryptStringAsync: async function (b) { this.calls.push('dec'); return { result: Buffer.from(String(b).slice(5), 'hex').toString('utf8'), shouldReEncrypt: reEncrypt }; },
  getSelectedStorageBackend: () => backend,
});

test('OL3: 鍵は暗号にして secrets.json に入れ、読み戻せる。ファイルにも settings.json にも鍵の文字が無い', async () => {
  const d = dir(); const file = path.join(d, 'secrets.json');
  const s = makeSecrets({ file, safeStorage: fakeSafe(), J });
  assert.deepStrictEqual(await s.set('relay', KEY), { ok: true });
  assert.strictEqual(s.has('relay'), true);
  assert.strictEqual(s.has('openai'), false);
  assert.strictEqual(await s.get('relay'), KEY);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(KEY), '平文の鍵がファイルにある');
  assert.strictEqual(JSON.parse(raw).schema, 1);
  // 作り直しても読める（起動し直し）
  assert.strictEqual(await makeSecrets({ file, safeStorage: fakeSafe(), J }).get('relay'), KEY);
  assert.deepStrictEqual(s.remove('relay'), { ok: true });
  assert.strictEqual(s.has('relay'), false);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('ENC1'), '消した鍵の暗号が残っている');
});

test('RF30: 暗号にできない PC では保存を断り、ファイルを作らない（平文で置かない）。Linux の basic_text も断る', async () => {
  const d = dir(); const file = path.join(d, 'secrets.json');
  assert.deepStrictEqual(await makeSecrets({ file, safeStorage: fakeSafe({ avail: false }), J }).set('relay', KEY), { ok: false, code: 'unavailable' });
  assert.deepStrictEqual(await makeSecrets({ file, safeStorage: fakeSafe({ backend: 'basic_text' }), J, platform: 'linux' }).set('relay', KEY), { ok: false, code: 'unavailable' });
  assert.ok(!fs.existsSync(file));
  assert.strictEqual(await makeSecrets({ file, safeStorage: fakeSafe(), J, platform: 'linux' }).available(), true, 'Linux の本物の鍵の置き場所でも断った');
});

test('OL3: 見出しに入れられない鍵（空白・日本語・短すぎ）と知らない送り先は断る', async () => {
  const s = makeSecrets({ file: path.join(dir(), 'secrets.json'), safeStorage: fakeSafe(), J });
  // 第1d回 A-11 で意図して変えた: relay の値は cookie をしまう文字（packCookies）で 16KB まで（前は鍵の 512 字の上限で 604 字を断った）
  for (const bad of ['', 'abc', 'gsk test 0123', 'gsk_鍵_0123456', `gsk_${'x'.repeat(16381)}`]) assert.deepStrictEqual(await s.set('relay', bad), { ok: false, code: 'bad-key' }, bad);
  assert.deepStrictEqual(await s.set('__proto__', KEY), { ok: false, code: 'bad-id' });
});

test('OL3: shouldReEncrypt が来たら暗号にし直して書く', async () => {
  const d = dir(); const file = path.join(d, 'secrets.json');
  await makeSecrets({ file, safeStorage: fakeSafe(), J }).set('relay', KEY);
  const safe = fakeSafe({ reEncrypt: true });
  assert.strictEqual(await makeSecrets({ file, safeStorage: safe, J }).get('relay'), KEY);
  assert.deepStrictEqual(safe.calls, ['dec', 'enc']);
});

test('JS2: 壊れた secrets.json は退けて（消さずに）鍵が無いとして動き、記録に名前だけ書く', async () => {
  const d = dir(); const file = path.join(d, 'secrets.json');
  fs.writeFileSync(file, '{"schema":1,"keys":{"relay":"ENC1:');
  const lines = [];
  const s = makeSecrets({ file, safeStorage: fakeSafe(), J, log: (l) => lines.push(l) });
  assert.strictEqual(s.has('relay'), false);
  assert.ok(fs.readdirSync(d).some((n) => n.startsWith('secrets.json.broken-')));
  assert.ok(lines.some((l) => l.includes('secrets.json')) && !lines.some((l) => l.includes('ENC1')));
});

// 第1d回 A-4 で意図して変えた: しまえるのは relay の札だけになったので、「ほかの名前の鍵を残して書く」は「読めるようになったら読み直して
// 書く（読み直さずに、読めなかった間の空の覚えで決めない）」で見る
test('RF22: secrets.json が読めない（unreadable）間は set・remove が { ok: false, code: \'write\' } を返して書かない。読めるようになったら読み直してから書く', async () => {
  const OLD = Buffer.from('ENC1:6f6c64').toString('base64');
  let state = { state: 'unreadable', code: 'EBUSY' };
  const writes = [];
  const fakeJ = {
    SMALL_MAX: J.SMALL_MAX,
    loadJsonFile: () => state,
    writeJsonFile: (f, value) => { writes.push(JSON.parse(JSON.stringify(value))); },
  };
  const lines = [];
  const s = makeSecrets({ file: path.join(dir(), 'secrets.json'), safeStorage: fakeSafe(), J: fakeJ, log: (l) => lines.push(l) });
  assert.deepStrictEqual(await s.set('relay', KEY), { ok: false, code: 'write' });
  assert.deepStrictEqual(s.remove('relay'), { ok: false, code: 'write' });
  assert.strictEqual(writes.length, 0, '読めない間に書いた（しまってある札が消える）');
  assert.ok(lines.some((l) => l.includes('EBUSY')) && !lines.some((l) => l.includes(KEY)));
  state = { state: 'ok', value: { schema: 1, keys: { relay: OLD } } };
  assert.strictEqual(s.has('relay'), true, '読めるようになったのに読み直していない');
  assert.deepStrictEqual(s.remove('relay'), { ok: true });
  assert.deepStrictEqual(writes, [{ schema: 1, keys: {} }], '読み直さずに「札は無い」と決めて書かなかった');
  assert.deepStrictEqual(await s.set('relay', KEY), { ok: true });
  assert.ok(writes[1].keys.relay && !JSON.stringify(writes[1]).includes(KEY));
});

// ---------------------------------------------------------------- 第1d回 A-2（RL10・RF32・F1・K2）
// ログインの札（中継の nt1_ の札）を relay の名前でしまう。前の版の鍵（groq・openai・custom）を消す purgeOld。
// （2026-10-19、A-2 を作ったときに計画を直した: PROVIDER_IDS を relay だけに絞る（groq・openai・custom は bad-id）のと、起動のときに
//  purgeOld を呼ぶのは、OpenAI へ直に送る道と鍵の IPC・画面を消す A-4 と同じ commit にする。ここでは relay を足し、purgeOld を作るだけ）
const TOKEN = `nt1_${'A1b2_C3d4-'.repeat(4)}xyz`;   // 中継の札の形（nt1_ + base64url 43 字）
const OLD = { groq: Buffer.from('ENC1:6f6c64').toString('base64'), openai: Buffer.from('ENC1:6f6c6432').toString('base64'), custom: Buffer.from('ENC1:6f6c6433').toString('base64') };

test('RL10・RF32: ログインの札は relay の名前で暗号にしてしまい、読み戻せる。ファイルに札の文字が無い。消すと暗号も消える', async () => {
  assert.match(TOKEN, /^nt1_[A-Za-z0-9_-]{43}$/);
  const d = dir(); const file = path.join(d, 'secrets.json');
  const s = makeSecrets({ file, safeStorage: fakeSafe(), J });
  assert.deepStrictEqual(await s.set('relay', TOKEN), { ok: true });
  assert.strictEqual(s.has('relay'), true);
  assert.strictEqual(await makeSecrets({ file, safeStorage: fakeSafe(), J }).get('relay'), TOKEN);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(TOKEN) && JSON.parse(raw).keys.relay, '札が平文で入ったか、relay の名前でない');
  assert.deepStrictEqual(s.remove('relay'), { ok: true });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('ENC1'), '消した札の暗号が残っている');
});

// 第1d回 A-4（RL10・F11）: 0.7.0 までの鍵の名前（groq・openai・custom）はしまえず・読めず・消せない（鍵の IPC と画面を消した。残った鍵は
// 起動のときに purgeOld が消す）。しまえるのは中継のログインの札（relay）だけ
test('RL10・F11: しまえるのは relay の札だけ。groq・openai・custom は bad-id で、ファイルに残っていても読まない', async () => {
  const d = dir(); const file = path.join(d, 'secrets.json');
  const s = makeSecrets({ file, safeStorage: fakeSafe(), J });
  for (const id of ['groq', 'openai', 'custom']) {
    assert.deepStrictEqual(await s.set(id, KEY), { ok: false, code: 'bad-id' }, id);
    assert.deepStrictEqual(s.remove(id), { ok: false, code: 'bad-id' }, id);
  }
  assert.ok(!fs.existsSync(file), '断ったのにファイルを作った');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, keys: { ...OLD } }));
  const t = makeSecrets({ file, safeStorage: fakeSafe(), J });
  for (const id of ['groq', 'openai', 'custom']) {
    assert.strictEqual(t.has(id), false, `${id} の鍵を読んだ`);
    assert.strictEqual(await t.get(id), '', `${id} の鍵を復号した`);
  }
  assert.deepStrictEqual(await t.set('relay', TOKEN), { ok: true });
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).keys), ['relay'], 'relay のほかの名前を書いた');
});

test('K2・F11: purgeOld は前の版の groq・openai・custom の鍵と、退けた控え secrets.json.broken-* を消して数を返し、relay の札は残す。2回目は 0 で書かない', async () => {
  const d = dir(); const file = path.join(d, 'secrets.json');
  await makeSecrets({ file, safeStorage: fakeSafe(), J }).set('relay', TOKEN);
  const relay = JSON.parse(fs.readFileSync(file, 'utf8')).keys.relay;
  fs.writeFileSync(file, JSON.stringify({ schema: 1, keys: { ...OLD, relay } }));
  fs.writeFileSync(path.join(d, 'secrets.json.broken-2026-10-01T00-00-00-000Z'), `{"schema":1,"keys":{"openai":"${OLD.openai}"`);
  fs.writeFileSync(path.join(d, 'settings.json.broken-2026-10-01T00-00-00-000Z'), '{');   // ほかのファイルの控えには触れない
  const lines = [];
  const s = makeSecrets({ file, safeStorage: fakeSafe(), J, log: (l) => lines.push(l) });
  assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).keys.openai, '前の版の鍵が無い（試しの前提）');
  assert.deepStrictEqual(s.purgeOld(), { removed: 4 });
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { schema: 1, keys: { relay } });
  assert.deepStrictEqual(fs.readdirSync(d).sort(), ['secrets.json', 'settings.json.broken-2026-10-01T00-00-00-000Z']);
  assert.strictEqual(await s.get('relay'), TOKEN);
  assert.deepStrictEqual(lines, ['secrets: 前の鍵 4 個を消しました']);
  const st = fs.statSync(file).mtimeMs;
  assert.deepStrictEqual(s.purgeOld(), { removed: 0 });
  assert.strictEqual(fs.statSync(file).mtimeMs, st, '消すものが無いのに書いた');
  assert.strictEqual(lines.length, 1, '消すものが無いのに記録した');
  // ファイルが無い PC でも投げない
  assert.deepStrictEqual(makeSecrets({ file: path.join(dir(), 'secrets.json'), safeStorage: fakeSafe(), J }).purgeOld(), { removed: 0 });
});

test('K2: purgeOld は読めない secrets.json（unreadable）にも控えにも触れず 0 を返し、書けなければ控えも残す（次の起動でまたする）', async () => {
  const d = dir();
  fs.writeFileSync(path.join(d, 'secrets.json.broken-2026-10-01T00-00-00-000Z'), 'x');
  let state = { state: 'unreadable', code: 'EBUSY' };
  const writes = [];
  let failWrite = false;
  const fakeJ = {
    SMALL_MAX: J.SMALL_MAX,
    loadJsonFile: () => state,
    writeJsonFile: (f, value) => { if (failWrite) throw Object.assign(new Error('x'), { code: 'EPERM' }); writes.push(JSON.parse(JSON.stringify(value))); },
  };
  const lines = [];
  const s = makeSecrets({ file: path.join(d, 'secrets.json'), safeStorage: fakeSafe(), J: fakeJ, log: (l) => lines.push(l) });
  assert.deepStrictEqual(s.purgeOld(), { removed: 0 });
  assert.strictEqual(writes.length, 0);
  assert.strictEqual(fs.readdirSync(d).length, 1, '読めない間に控えを消した');
  state = { state: 'ok', value: { schema: 1, keys: { ...OLD } } };
  failWrite = true;
  assert.deepStrictEqual(s.purgeOld(), { removed: 0 });
  assert.strictEqual(fs.readdirSync(d).length, 1, '書けなかったのに控えを消した');
  assert.ok(lines.some((l) => l.includes('EPERM')) && !lines.some((l) => /ENC1|6f6c64/.test(l)), lines.join('\n'));
  failWrite = false;
  assert.deepStrictEqual(s.purgeOld(), { removed: 4 });
  assert.deepStrictEqual(writes, [{ schema: 1, keys: {} }]);
  assert.strictEqual(fs.readdirSync(d).length, 0);
});

// 第1d回 A-11（RL10・F21）: relay の値は、ログインの窓で取った Access の cookie を packCookies でまとめた文字（JSON。cookie の値の JWT は
// 数 KB になる）。印字できる ASCII（空白なし）の 16KB まで（src/relay.js の packCookies の上限と同じ）。鍵の形 KEY_RE（512 字）は変えない
test('RL10・F21: relay の値は印字できる ASCII（空白なし）の 16KB まで（packCookies の形）。ほかの名前の上限は今の KEY_RE の 512 字のまま', async () => {
  const { RELAY_RE, KEY_RE } = require('../src/secrets');
  const relay = require('../src/relay');
  const host = new URL(relay.RELAY_BASE).hostname;
  const jwt = `eyJ${'a'.repeat(3000)}.eyJ${'b'.repeat(2000)}.${'c'.repeat(342)}`;
  const pack = relay.packCookies([{ name: 'CF_Authorization', value: jwt, domain: host, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: 1900000000 }], { exp: 1900000000 });
  assert.ok(pack.length > 5000 && pack.length <= 16384, `packCookies の文字の長さ ${pack.length}`);
  const d = dir(); const file = path.join(d, 'secrets.json');
  const s = makeSecrets({ file, safeStorage: fakeSafe(), J });
  assert.deepStrictEqual(await s.set('relay', pack), { ok: true });
  assert.strictEqual(await makeSecrets({ file, safeStorage: fakeSafe(), J }).get('relay'), pack);
  assert.ok(!fs.readFileSync(file, 'utf8').includes(jwt.slice(0, 40)), 'cookie の値が平文で入った');
  assert.deepStrictEqual(await s.set('relay', 'x'.repeat(16384)), { ok: true });
  for (const bad of ['x'.repeat(16385), `${pack.slice(0, 20)}\n${pack.slice(20)}`, `${pack} `, `{"v":1,"鍵":1}`, 'short']) {
    assert.deepStrictEqual(await s.set('relay', bad), { ok: false, code: 'bad-key' }, bad.slice(0, 40));
  }
  assert.ok(RELAY_RE.test('x'.repeat(16384)) && !RELAY_RE.test('x'.repeat(16385)));
  assert.ok(KEY_RE.test('x'.repeat(512)) && !KEY_RE.test('x'.repeat(513)), '鍵の形の上限を変えた');
});
