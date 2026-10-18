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
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-sec-'));
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
  assert.deepStrictEqual(await s.set('groq', KEY), { ok: true });
  assert.strictEqual(s.has('groq'), true);
  assert.strictEqual(s.has('openai'), false);
  assert.strictEqual(await s.get('groq'), KEY);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes(KEY), '平文の鍵がファイルにある');
  assert.strictEqual(JSON.parse(raw).schema, 1);
  // 作り直しても読める（起動し直し）
  assert.strictEqual(await makeSecrets({ file, safeStorage: fakeSafe(), J }).get('groq'), KEY);
  assert.deepStrictEqual(s.remove('groq'), { ok: true });
  assert.strictEqual(s.has('groq'), false);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('ENC1'), '消した鍵の暗号が残っている');
});

test('RF30: 暗号にできない PC では保存を断り、ファイルを作らない（平文で置かない）。Linux の basic_text も断る', async () => {
  const d = dir(); const file = path.join(d, 'secrets.json');
  assert.deepStrictEqual(await makeSecrets({ file, safeStorage: fakeSafe({ avail: false }), J }).set('groq', KEY), { ok: false, code: 'unavailable' });
  assert.deepStrictEqual(await makeSecrets({ file, safeStorage: fakeSafe({ backend: 'basic_text' }), J, platform: 'linux' }).set('groq', KEY), { ok: false, code: 'unavailable' });
  assert.ok(!fs.existsSync(file));
  assert.strictEqual(await makeSecrets({ file, safeStorage: fakeSafe(), J, platform: 'linux' }).available(), true, 'Linux の本物の鍵の置き場所でも断った');
});

test('OL3: 見出しに入れられない鍵（空白・日本語・短すぎ）と知らない送り先は断る', async () => {
  const s = makeSecrets({ file: path.join(dir(), 'secrets.json'), safeStorage: fakeSafe(), J });
  for (const bad of ['', 'abc', 'gsk test 0123', 'gsk_鍵_0123456', `gsk_${'x'.repeat(600)}`]) assert.deepStrictEqual(await s.set('groq', bad), { ok: false, code: 'bad-key' }, bad);
  assert.deepStrictEqual(await s.set('__proto__', KEY), { ok: false, code: 'bad-id' });
});

test('OL3: shouldReEncrypt が来たら暗号にし直して書く', async () => {
  const d = dir(); const file = path.join(d, 'secrets.json');
  await makeSecrets({ file, safeStorage: fakeSafe(), J }).set('groq', KEY);
  const safe = fakeSafe({ reEncrypt: true });
  assert.strictEqual(await makeSecrets({ file, safeStorage: safe, J }).get('groq'), KEY);
  assert.deepStrictEqual(safe.calls, ['dec', 'enc']);
});

test('JS2: 壊れた secrets.json は退けて（消さずに）鍵が無いとして動き、記録に名前だけ書く', async () => {
  const d = dir(); const file = path.join(d, 'secrets.json');
  fs.writeFileSync(file, '{"schema":1,"keys":{"groq":"ENC1:');
  const lines = [];
  const s = makeSecrets({ file, safeStorage: fakeSafe(), J, log: (l) => lines.push(l) });
  assert.strictEqual(s.has('groq'), false);
  assert.ok(fs.readdirSync(d).some((n) => n.startsWith('secrets.json.broken-')));
  assert.ok(lines.some((l) => l.includes('secrets.json')) && !lines.some((l) => l.includes('ENC1')));
});

test('RF22: secrets.json が読めない（unreadable）間は set・remove が { ok: false, code: \'write\' } を返して書かない。読めるようになったら読み直し、ほかの鍵を残して書く', async () => {
  const OPENAI = Buffer.from('ENC1:6f6c64').toString('base64');
  let state = { state: 'unreadable', code: 'EBUSY' };
  const writes = [];
  const fakeJ = {
    SMALL_MAX: J.SMALL_MAX,
    loadJsonFile: () => state,
    writeJsonFile: (f, value) => { writes.push(JSON.parse(JSON.stringify(value))); },
  };
  const lines = [];
  const s = makeSecrets({ file: path.join(dir(), 'secrets.json'), safeStorage: fakeSafe(), J: fakeJ, log: (l) => lines.push(l) });
  assert.deepStrictEqual(await s.set('groq', KEY), { ok: false, code: 'write' });
  assert.deepStrictEqual(s.remove('openai'), { ok: false, code: 'write' });
  assert.strictEqual(writes.length, 0, '読めない間に書いた（ほかの鍵が消える）');
  assert.ok(lines.some((l) => l.includes('EBUSY')) && !lines.some((l) => l.includes(KEY)));
  state = { state: 'ok', value: { schema: 1, keys: { openai: OPENAI } } };
  assert.deepStrictEqual(await s.set('groq', KEY), { ok: true });
  assert.strictEqual(writes.length, 1);
  assert.strictEqual(writes[0].keys.openai, OPENAI, '読み直さずに書いて openai の鍵が消えた');
  assert.ok(writes[0].keys.groq && !JSON.stringify(writes[0]).includes(KEY));
});
