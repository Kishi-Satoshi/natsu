/*
 * jsonfile.test.js — DB の外の JSON の読み書きの部品（第1a回 JS1〜JS4・JS7・JS8。RF20〜RF23）
 * 本物のファイル（一時フォルダ）と、決めた回数だけ失敗する fs（helpers/faulty-fs.js）で試す。待ちは sleep を差し替えて縮める。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const J = require('../src/jsonfile');
const { faultyFs } = require('./helpers/faulty-fs');

const dir = (tag = '') => fs.mkdtempSync(path.join(os.tmpdir(), `natsu-json取込𠮷${tag}-`));
const noSleep = () => {};
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const CP932_NIHONGO = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);   // 「日本語」を CP932（ANSI）で書いたバイト

// ---------------------------------------------------------------- JS1 文字コード
test('JS1: UTF-8・BOM 付き UTF-8・BOM 付き UTF-16LE／BE は同じ文字に読め、CP932 の日本語は化けさせずに断る', { timeout: 5000 }, () => {
  const s = '{"micId":"マイク（会議室）","n":1}';
  const cases = [
    Buffer.from(s, 'utf8'),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s, 'utf8')]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]),
    Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(s, 'utf16le').swap16()]),
  ];
  for (const b of cases) assert.deepStrictEqual(J.decodeJsonBytes(b), { ok: true, text: s });
  const ansi = Buffer.concat([Buffer.from('{"micId":"', 'ascii'), CP932_NIHONGO, Buffer.from('"}', 'ascii')]);
  assert.deepStrictEqual(J.decodeJsonBytes(ansi), { ok: false });
});

// ---------------------------------------------------------------- JS1 4つの結果
test('JS1: 無い・読めた・壊れている・読めない の4つで返し、決して投げない', { timeout: 5000 }, () => {
  const d = dir();
  const f = path.join(d, 'settings.json');
  assert.deepStrictEqual(J.readJsonFile(f), { state: 'missing' });
  fs.writeFileSync(f, '{"theme":"dark"}');
  assert.deepStrictEqual(J.readJsonFile(f, { shape: isObj }), { state: 'ok', value: { theme: 'dark' } });
  const broken = [['', 'json'], ['{"theme":"da', 'json'], ['{"a":1}\0\0\0', 'json'], ['null', 'shape'], ['"文字"', 'shape'], ['[1,2]', 'shape']];
  for (const [text, reason] of broken) {
    fs.writeFileSync(f, text);
    assert.deepStrictEqual(J.readJsonFile(f, { shape: isObj }), { state: 'broken', reason }, JSON.stringify(text));
  }
  fs.writeFileSync(f, Buffer.concat([Buffer.from('{"a":"'), CP932_NIHONGO, Buffer.from('"}')]));
  assert.deepStrictEqual(J.readJsonFile(f, { shape: isObj }), { state: 'broken', reason: 'encoding' });
  fs.writeFileSync(f, JSON.stringify({ dictionary: 'x'.repeat(300 * 1024) }));
  assert.deepStrictEqual(J.readJsonFile(f, { shape: isObj, maxBytes: J.SMALL_MAX }), { state: 'broken', reason: 'too-large' });
  // パスがフォルダ: 投げずに「読めない」
  assert.strictEqual(J.readJsonFile(d, { sleep: noSleep }).state, 'unreadable');
});

test('JS1: 壊れたときの結果に、ファイルの中身（JSON のエラーの文）を写さない', { timeout: 5000 }, () => {
  const f = path.join(dir(), 'history.json');
  fs.writeFileSync(f, '[{"text":"口述した秘密の文"');
  const r = J.readJsonFile(f);
  assert.strictEqual(r.state, 'broken');
  assert.ok(!JSON.stringify(r).includes('秘密'), JSON.stringify(r));
});

// ---------------------------------------------------------------- JS1・RF22 掴まれたとき
test('RF22: EBUSY が3回続いた後に読めれば値が残る。ずっと EACCES なら約1秒待って「読めない」で、ファイルは変わらない', { timeout: 5000 }, () => {
  const f = path.join(dir(), 'settings.json');
  fs.writeFileSync(f, '{"theme":"dark"}');
  const slept = [];
  const r1 = J.readJsonFile(f, { fs: faultyFs([{ op: 'read', match: /settings\.json$/, code: 'EBUSY', times: 3 }]), sleep: (ms) => slept.push(ms) });
  assert.deepStrictEqual(r1, { state: 'ok', value: { theme: 'dark' } });
  assert.deepStrictEqual(slept, J.READ_WAITS.slice(0, 3));
  const waits = [];
  const r2 = J.readJsonFile(f, { fs: faultyFs([{ op: 'read', match: /settings\.json$/, code: 'EACCES', times: Infinity }]), sleep: (ms) => waits.push(ms) });
  assert.deepStrictEqual(r2, { state: 'unreadable', code: 'EACCES' });
  const total = waits.reduce((a, b) => a + b, 0);
  assert.ok(total >= 900 && total <= 1100, `待ちの合計 ${total}ms`);
  assert.strictEqual(fs.readFileSync(f, 'utf8'), '{"theme":"dark"}');
});

// ---------------------------------------------------------------- JS2 退け方
test('JS2: 退けた名前は store.js と同じ形（.broken- の後に ISO の時刻の : と . を - に）。重なれば -2・-3', { timeout: 5000 }, () => {
  const at = new Date('2026-10-18T01:02:03.456Z');
  const f = path.join('x', 'settings.json');
  assert.strictEqual(J.brokenName(f, at, () => false), `${f}.broken-2026-10-18T01-02-03-456Z`);
  assert.strictEqual(J.brokenName(f, at, () => false), `${f}.broken-${at.toISOString().replace(/[:.]/g, '-')}`);
  const taken = new Set([`${f}.broken-2026-10-18T01-02-03-456Z`, `${f}.broken-2026-10-18T01-02-03-456Z-2`]);
  assert.strictEqual(J.brokenName(f, at, (p) => taken.has(p)), `${f}.broken-2026-10-18T01-02-03-456Z-3`);
});

test('JS2: loadJsonFile は壊れたファイルを写さずに名前を変えて退け、中身は1バイトも変えない。名前を変えられなければ「読めない」', { timeout: 5000 }, () => {
  const d = dir();
  const f = path.join(d, 'history.json');
  const bytes = Buffer.from('[{"text":"途中で切れ', 'utf8');
  fs.writeFileSync(f, bytes);
  const r = J.loadJsonFile(f, { shape: Array.isArray, sleep: noSleep });
  assert.strictEqual(r.state, 'broken');
  assert.ok(!fs.existsSync(f), '元の名前のまま残っている（次の保存で上書きされる）');
  assert.match(path.basename(r.movedTo), /^history\.json\.broken-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z$/);
  assert.ok(fs.readFileSync(r.movedTo).equals(bytes));
  // 退けられないとき: 書かせないため「読めない」として返し、元のファイルはそのまま
  fs.writeFileSync(f, bytes);
  const r2 = J.loadJsonFile(f, { shape: Array.isArray, sleep: noSleep, fs: faultyFs([{ op: 'rename', match: /broken/, code: 'EPERM', times: Infinity }]) });
  assert.deepStrictEqual({ state: r2.state, code: r2.code }, { state: 'unreadable', code: 'QUARANTINE_FAILED' });
  assert.ok(fs.readFileSync(f).equals(bytes));
});

test('JS1: 日本語と「𠮷」を含むフォルダでも読める（RF1 と同じ形）', { timeout: 5000 }, () => {
  const f = path.join(dir('-設定𠮷'), 'settings.json');
  fs.writeFileSync(f, '{"micId":"𠮷"}');
  assert.deepStrictEqual(J.readJsonFile(f), { state: 'ok', value: { micId: '𠮷' } });
});
