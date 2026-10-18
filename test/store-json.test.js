/*
 * store-json.test.js — store の読み書きの守り（第1a回 JS1・JS2・JS5・JS9。P16）
 * store は jsonfile を J として呼ぶので、J の関数を差し替えて「何を頼んだか」も見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/store');
const J = require('../src/jsonfile');

const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-取込𠮷-store1a-')); store.init(d); return d; };
const data = (d, ...p) => path.join(d, 'data', ...p);
const mk = (title) => store.createPage({ title, segments: [{ id: 's1', atMs: 0, durationMs: 1000, text: '確認です' }], createdAt: '2026-10-01T00:00:00.000Z' });

test('JS1: 先頭に BOM の付いたページも読める（退けない・一覧から消えない）', () => {
  const d = fresh();
  const p = mk('BOM の会議');
  const f = data(d, 'pages', `${p.id}.json`);
  fs.writeFileSync(f, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(f)]));
  assert.strictEqual(store.getPage(p.id).title, 'BOM の会議');
  assert.deepStrictEqual(fs.readdirSync(data(d, 'pages')).filter((n) => n.includes('.broken-')), []);
});

test('JS2・P16: 末尾にゴミの付いたページは、中身を変えずに退けて、退けた先の名前を伝える（ページの控えは消さない）', () => {
  const d = fresh();
  const told = [];
  store.setReporter((ev) => told.push(ev));
  try {
    const p = mk('壊れる会議');
    const f = data(d, 'pages', `${p.id}.json`);
    for (let i = 1; i <= 4; i += 1) fs.writeFileSync(`${f}.broken-2026-09-0${i}T00-00-00-000Z`, 'old');
    const bytes = Buffer.concat([fs.readFileSync(f), Buffer.from('}}garbage')]);
    fs.writeFileSync(f, bytes);
    assert.strictEqual(store.getPage(p.id), null);
    const moved = fs.readdirSync(data(d, 'pages')).filter((n) => n.startsWith(`${p.id}.json.broken-`) && !n.includes('broken-2026-09-0'));
    assert.strictEqual(moved.length, 1);
    assert.ok(fs.readFileSync(data(d, 'pages', moved[0])).equals(bytes));
    assert.strictEqual(fs.readdirSync(data(d, 'pages')).filter((n) => n.includes('.broken-')).length, 5, 'ページの控えを消した');
    assert.deepStrictEqual(told, [{ kind: 'page', file: `${p.id}.json`, movedTo: moved[0], reason: 'json' }]);
  } finally { store.setReporter(null); }
});

test('JS2・P16: 壊れた文字起こしのファイルも、中身を変えずに退けて、退けた先の名前を伝える（議事録の中身なので知らせる）', () => {
  const d = fresh();
  const told = [];
  store.setReporter((ev) => told.push(ev));
  try {
    const p = mk('文字起こしが壊れる会議');
    const f = data(d, 'transcripts', `${p.id}.json`);
    const bytes = Buffer.from('{"id":"x","segments":[{"text":"途中');
    fs.writeFileSync(f, bytes);
    assert.deepStrictEqual(store.getTranscript(p.id), []);
    const moved = fs.readdirSync(data(d, 'transcripts')).filter((n) => n.startsWith(`${p.id}.json.broken-`));
    assert.strictEqual(moved.length, 1);
    assert.ok(fs.readFileSync(data(d, 'transcripts', moved[0])).equals(bytes));
    assert.deepStrictEqual(told, [{ kind: 'transcript', file: `${p.id}.json`, movedTo: moved[0], reason: 'json' }]);
  } finally { store.setReporter(null); }
});

test('JS2: 壊れた index.json は退けて作り直し、index.json の控えは新しい3つまで（ミリ秒の数の名前は消さない）', () => {
  const d = fresh();
  mk('a');
  const f = data(d, 'index.json');
  for (let i = 1; i <= 4; i += 1) fs.writeFileSync(`${f}.broken-2026-09-0${i}T00-00-00-000Z`, 'old');
  fs.writeFileSync(`${f}.broken-1700000000000`, 'old');
  fs.writeFileSync(f, '{"pages":');
  store.init(d);
  assert.strictEqual(store.listPages().length, 1);
  const left = fs.readdirSync(data(d)).filter((n) => n.startsWith('index.json.broken-'));
  assert.ok(left.includes('index.json.broken-1700000000000'));
  assert.strictEqual(left.filter((n) => /-\d\d-\d\dT/.test(n)).length, 3);
});

test('JS5: index.json は fsync を省き、ページと文字起こしは fsync する', () => {
  fresh();
  const calls = [];
  const orig = J.writeJsonFile;
  J.writeJsonFile = (file, v, o = {}) => { calls.push([path.basename(path.dirname(file)), path.basename(file), o.fsync !== false]); return orig(file, v, o); };
  try { mk('fsync の会議'); } finally { J.writeJsonFile = orig; }
  const kinds = Object.fromEntries(calls.map(([dirName, name, sync]) => [name === 'index.json' ? 'index' : dirName, sync]));
  assert.deepStrictEqual(kinds, { pages: true, transcripts: true, index: false });
});

test('JS5: 書いた後に .tmp で終わるファイルが data・pages・transcripts に残らない', () => {
  const d = fresh();
  const p = mk('一時ファイル');
  store.updateSegment(p.id, 's1', { text: '直した' });
  for (const sub of ['', 'pages', 'transcripts']) assert.deepStrictEqual(fs.readdirSync(data(d, sub)).filter((n) => n.endsWith('.tmp')), [], sub);
});

test('JS9: 下書きの一覧は draft.json・draft.pending-<時刻>.json・draft-<開始時刻>.json。退けた控えと一時ファイルは数えない', () => {
  const d = fresh();
  for (const n of ['draft.json', 'draft.pending-2026-10-18T01-02-03-456Z.json', 'draft-1760000000000.json', 'draft.json.broken-2026-10-01T00-00-00-000Z', 'draft.json.123-abc.tmp', 'drafts.json']) fs.writeFileSync(data(d, n), '{}');
  assert.deepStrictEqual(store.draftFiles(), ['draft-1760000000000.json', 'draft.json', 'draft.pending-2026-10-18T01-02-03-456Z.json']);
});

test('JS9: 読めない draft.json は消さず、名前も変えない（readDraftFile は unreadable を返す）', () => {
  const d = fresh();
  fs.writeFileSync(data(d, 'draft.json'), '{"startedAt":1,"segments":[{"id":"s1","text":"x"}]}');
  const orig = J.loadJsonFile;
  J.loadJsonFile = (f, o) => (path.basename(f) === 'draft.json' ? { state: 'unreadable', code: 'EBUSY' } : orig(f, o));
  try { assert.deepStrictEqual(store.readDraftFile('draft.json'), { state: 'unreadable', code: 'EBUSY' }); } finally { J.loadJsonFile = orig; }
  assert.ok(fs.existsSync(data(d, 'draft.json')));
});

test('JS9・JS2: 壊れた draft.json は退けて残し（消さない）、reporter に伝える', () => {
  const d = fresh();
  const told = [];
  store.setReporter((ev) => told.push(ev));
  try {
    fs.writeFileSync(data(d, 'draft.json'), '{"startedAt":1,"segme');
    assert.strictEqual(store.readDraftFile('draft.json').state, 'broken');
    const moved = fs.readdirSync(data(d)).filter((n) => n.startsWith('draft.json.broken-'));
    assert.strictEqual(moved.length, 1);
    assert.deepStrictEqual(told.map((e) => [e.kind, e.file, e.movedTo]), [['draft', 'draft.json', moved[0]]]);
  } finally { store.setReporter(null); }
});

test('JS9: parkDraft は draft.json を draft.pending-<時刻>.json に名前を変える。変えられなければ ok: false で何も動かさない', () => {
  const d = fresh();
  fs.writeFileSync(data(d, 'draft.json'), '{"startedAt":1}');
  const r = store.parkDraft();
  assert.ok(r.ok && /^draft\.pending-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/.test(r.name), JSON.stringify(r));
  assert.ok(!fs.existsSync(data(d, 'draft.json')) && fs.existsSync(data(d, r.name)));
  fs.writeFileSync(data(d, 'draft.json'), '{"startedAt":2}');
  const orig = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }); };
  try { assert.strictEqual(store.parkDraft().ok, false); } finally { fs.renameSync = orig; }
  assert.strictEqual(fs.readFileSync(data(d, 'draft.json'), 'utf8'), '{"startedAt":2}');
});

test('JS9: writeDraft と clearDraft は名前を受け取る（既定は draft.json）', () => {
  const d = fresh();
  store.writeDraft({ startedAt: 5, segments: [] }, 'draft-5.json');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(data(d, 'draft-5.json'), 'utf8')), { startedAt: 5, segments: [] });
  store.writeDraft({ startedAt: 6, segments: [] });
  assert.ok(fs.existsSync(data(d, 'draft.json')));
  store.clearDraft('draft-5.json');
  assert.deepStrictEqual(store.draftFiles(), ['draft.json']);
});
