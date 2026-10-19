/*
 * perf.test.js — 速さの道具（第1a回 PERF・JS7。tools/perf.js）の決め方
 * 5,000 ページの本番の計りは CI の「速さを計る」の段。ここでは決め方と、小さな見本で計りが最後まで走ることを見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PF = require('../tools/perf');
const { jobsOf, stepsOf } = require('./helpers/yml');

test('PERF: 目安は設計書の値（開く 0.5 秒・検索 0.3 秒）。第2a1回で DB の目安にした（全文検索も 0.3 秒）', { timeout: 5000 }, () => {
  assert.deepStrictEqual(PF.BUDGETS, { 'db-open': 500, 'list': 300, 'searchIndex-typical': 300, 'searchIndex-all': 600,
    'searchFull-trigram': 300, 'searchFull-short': 300, 'open-page': 500, 'write-commit': 50, 'migrate-500': 10000,
    'write-256k-fsync': 50, 'write-1m-fsync': 150, 'write-10m-fsync': 1500 });
});

test('PERF・RF12: DB の目安がある（検索は 0.3 秒）。JSON の保存の目安は外した', { timeout: 5000 }, () => {
  const P = require('../tools/perf');
  for (const k of ['db-open', 'list', 'searchIndex-typical', 'searchIndex-all', 'searchFull-trigram', 'searchFull-short', 'open-page', 'write-commit', 'migrate-500']) assert.ok(k in P.BUDGETS, k);
  assert.strictEqual(P.BUDGETS['searchFull-trigram'], 300);
  assert.strictEqual(P.BUDGETS['searchFull-short'], 300);
  assert.ok(!('store-init' in P.BUDGETS) && !('searchFullText' in P.BUDGETS));
  assert.strictEqual(typeof P.measureStore, 'undefined', 'JSON の保存の計り（measureStore）が残っている');
});

test('PERF: Windows だけの目安は、Windows の CI で越えた名前だけを測った中央値の 2 倍にする（DB にしたので JSON の保存で決めた値は外した）。ほかの OS と、ほかの名前は BUDGETS のまま', { timeout: 5000 }, () => {
  for (const [k, v] of Object.entries(PF.BUDGETS_WIN)) assert.ok(k in PF.BUDGETS && v > PF.BUDGETS[k], k);
  assert.deepStrictEqual(PF.budgetsFor('linux'), PF.BUDGETS);
  assert.deepStrictEqual(PF.budgetsFor('win32'), { ...PF.BUDGETS, ...PF.BUDGETS_WIN });
  // 本番の計り（main）は動いている OS の目安で決める
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'perf.js'), 'utf8');
  assert.match(src, /judge\(\[[^\n]*\], budgetsFor\(process\.platform\)\)/);
});

test('PERF: p95 は並べて 95% の位置の値。目安と比べる median は真ん中の値', { timeout: 5000 }, () => {
  assert.strictEqual(PF.p95(Array.from({ length: 20 }, (_, i) => 20 - i)), 19);
  assert.strictEqual(PF.p95([5]), 5);
  assert.strictEqual(PF.median([30, 10, 900]), 30);
});

test('PERF: 目安を越えたものだけ NG。目安の無い名前は投げる。NG があれば終了コードは 1', { timeout: 5000 }, () => {
  const r = PF.judge([{ name: 'searchIndex-typical', ms: 120 }, { name: 'open-page', ms: 700 }]);
  assert.deepStrictEqual(r.map((x) => [x.name, x.ok]), [['searchIndex-typical', true], ['open-page', false]]);
  assert.strictEqual(PF.exitCodeOf(r), 1);
  assert.strictEqual(PF.exitCodeOf(r.filter((x) => x.ok)), 0);
  assert.throws(() => PF.judge([{ name: 'no-such', ms: 1 }]), /目安が無い/);
});

test('JS7: 決め方 — まとめ書きは p95 が 100ms までなら今の 350ms、越えたら 1000ms。draft.json の fsync は 512KB の p95 が 20ms までなら足す', { timeout: 5000 }, () => {
  assert.deepStrictEqual([PF.suggestBatchMs(12), PF.suggestBatchMs(100), PF.suggestBatchMs(101)], [350, 350, 1000]);
  assert.deepStrictEqual([PF.suggestDraftFsync(3), PF.suggestDraftFsync(20), PF.suggestDraftFsync(21)], [true, true, false]);
});

// 見本のフォルダの名前には日本語と 𠮷（サロゲートの対）を入れる（RF1）
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-perf-日本語𠮷-'));

test('PERF: 小さな DB の見本で measureDb が全部の名前を返す', { timeout: 5000 }, async () => {
  const P = require('../tools/perf');
  const dir = tmpDir();
  try {
    const r = await P.measureDb({ pages: 20, segments: 10, bigBlocks: 50, bigSegments: 100, dir });
    // 移行は measureMigrate が別に測る（JSON を作るので小さな見本でも時間がかかる）
    assert.deepStrictEqual(r.map((x) => x.name).sort(), Object.keys(P.BUDGETS).filter((k) => (!k.startsWith('write-') || k === 'write-commit') && !k.startsWith('migrate-')).sort());
    for (const x of r) assert.ok(Number.isFinite(x.ms) && x.ms >= 0, x.name);
    assert.deepStrictEqual(fs.readdirSync(dir), [], '見本を消していない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PERF: 見本は SQL で直に入れるが、命令で書いたページと同じ形に読める（形がずれたら計る前に投げる）', { timeout: 5000 }, () => {
  const sqlite = require('node:sqlite');
  const core = require('../src/db/core');
  const C = require('../src/db/commands');
  const dir = tmpDir();
  const opened = [];
  try {
    const open = (name) => { const o = core.open({ sqlite, file: path.join(dir, name) }); opened.push(o.db); return o.db; };
    const a = open('a.db');
    const b = open('b.db');
    const { page, segments } = PF.sampleDbPage(3, { rare: true, segments: 4 });
    PF.insertSample(a, [{ page, segments }]);
    C.putPageRows(b, page, segments);
    const strip = (db) => db.prepare('select id, type, page_id, parent_id, ord, text, rich, attrs, fold, rev, created_at, updated_at, trashed_at from blocks order by id').all();
    assert.deepStrictEqual(strip(a), strip(b), 'ブロックの行が putPageRows と違う');
    const segs = (db) => db.prepare('select page_id, id, n, at_ms, duration_ms, text, fold, failed, extra from segments order by page_id, n').all();
    assert.deepStrictEqual(segs(a), segs(b), '発言の行が putPageRows と違う');
    assert.deepStrictEqual(C.readSegments(a, page.id), segments);
    // 全文検索の索引にも入っている（trigger を通る）
    assert.strictEqual(a.prepare('select count(*) c from segments_fts where segments_fts match ?').get('"ゆずりは"').c, 1);
  } finally {
    for (const db of opened) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PERF: 移行の時間（migrate-500）は JSON の見本を移して確かめるまで。元の JSON は変えず、見本は消す', { timeout: 5000 }, async () => {
  const dir = tmpDir();
  try {
    let seen = null;
    const r = await PF.measureMigrate({ pages: 5, segments: 4, blocks: 6, rounds: 1, dir, onDone: (x) => { seen = x; } });
    assert.deepStrictEqual(r.map((x) => x.name), ['migrate-500']);
    assert.ok(Number.isFinite(r[0].ms) && r[0].ms >= 0);
    assert.strictEqual(seen.ok, true);
    assert.deepStrictEqual([seen.counts.pages, seen.counts.segments, seen.counts.broken, seen.counts.badShape], [5, 20, 0, 0]);
    assert.strictEqual(seen.sourceSame, true, '移行で元の JSON が変わった');
    assert.deepStrictEqual(fs.readdirSync(dir), [], '見本を消していない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ST12: DB が書き続けている間の下書き（512KB＋fsync）の書き込みは参考の値（目安なし）。計っている間に DB が本当に書いている', { timeout: 5000 }, async () => {
  const dir = tmpDir();
  try {
    const r = await PF.measureDraftWhileBusy({ reps: 3, dir });
    assert.strictEqual(r.name, 'draft-write-while-db-busy');
    assert.ok(!(r.name in PF.BUDGETS), '参考の値に目安を付けた');
    assert.ok(Number.isFinite(r.ms) && Number.isFinite(r.p95));
    assert.ok(r.dbWritesDuring > 0, `計っている間に DB が書いていない（${r.dbWritesDuring}）`);
    assert.strictEqual(r.stillWriting, true, '計り終えたときに DB が書き続けていない（書き終えた後に計った）');
    assert.deepStrictEqual(fs.readdirSync(dir), [], '見本を消していない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PERF: 書く時間は書いたファイルの fsync まで含めて計る', { timeout: 5000 }, () => {
  const dir = tmpDir();
  try {
    // fsync の無い時間では決め方の答えが変わる。Linux はフォルダの fsync もするので、一時ファイル（'wx' で開いたもの）の fsync だけを数える
    const tmpFds = new Set();
    let fileFsyncs = 0;
    const countingFs = { ...fs,
      openSync(p, flags, ...rest) { const fd = fs.openSync(p, flags, ...rest); if (flags === 'wx') tmpFds.add(fd); return fd; },
      fsyncSync(fd) { if (tmpFds.has(fd)) fileFsyncs++; return fs.fsyncSync(fd); },
      closeSync(fd) { tmpFds.delete(fd); return fs.closeSync(fd); } };
    const w = PF.measureWrites({ reps: 2, dir, fs: countingFs });
    assert.strictEqual(fileFsyncs, 2 * 5, '書いたファイルを fsync していない');
    for (const n of ['write-256k-fsync', 'write-1m-fsync', 'write-10m-fsync']) assert.ok(w.some((x) => x.name === n), n);
    for (const x of w) assert.ok(Number.isFinite(x.ms) && x.ms >= 0, x.name);
    assert.deepStrictEqual(fs.readdirSync(dir), [], '見本を消していない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ci.yml の test: npm test の後に node tools/perf.js を回す（Linux と Windows）', { timeout: 5000 }, () => {
  const st = stepsOf(jobsOf(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8')).test);
  const iTest = st.findIndex((s) => /^\s*npm test/m.test(s));
  const iPerf = st.findIndex((s) => /^\s*run: node tools\/perf\.js$/m.test(s));
  assert.ok(iTest >= 0 && iPerf > iTest, `${iTest},${iPerf}`);
  assert.ok(!/if: runner\.os/.test(st[iPerf]), '片方の OS だけで計っている');
});

test('JS7・Task 5-1: Windows の CI の計りで決めた2つの値が main にある（まとめ書き 350ms・draft.json の fsync を足す）', { timeout: 5000 }, () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  // 決めた値（計画 docs/plans/2026-10-18-1a.md の Task 5-1 に測った値と一緒に書いた）。変えるなら計画とこのテストを一緒に直す
  assert.ok(main.includes('\nconst BATCH_MS = 350;\n'), 'まとめ書きの間隔は 350ms（設定の大きさの p95 は 4 回とも 100ms まで）');
  assert.ok(main.includes('\nconst DRAFT_FSYNC = true;\n'), 'draft.json の fsync を足す（512KB の p95 の中央値が 20ms まで）');
  assert.ok(main.includes('}, meeting.draftName, { fsync: DRAFT_FSYNC });'), '下書きを書くときに DRAFT_FSYNC を渡していない');
  assert.deepStrictEqual([PF.suggestBatchMs(32.69), PF.suggestDraftFsync(16.22)], [350, true]);
});
