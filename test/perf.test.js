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

// ---------------------------------------------------------------- 0.9.0 G-1（PG1・F17）: 目安を越えた名前だけを計り直す
// 共用の機械のディスクの一瞬の遅れ（main の run の write-commit 157.42ms・write-256k-fsync 125.84ms）で赤にしない。
// はじめの1回と計り直しの2回の中央値で決める。本当に遅くなれば3回とも越えるので赤のまま。目安の値は変えない
test('PG1: recheck は NG の名前だけを again で2回計り直し、3回の中央値で決める: [157, 12, 11] → OK、[157, 12, 140] → NG、[157, 151, 149] → NG。OK の名前は again を呼ばない。log に3回の値と中央値の1行', { timeout: 5000 }, async () => {
  const run = async (first, rest) => {
    const calls = [];
    const lines = [];
    const queue = [...rest];
    const judged = PF.judge([{ name: 'write-commit', ms: first }, { name: 'list', ms: 20 }]);
    const r = await PF.recheck(judged, (name) => { calls.push(name); return queue.shift(); }, { log: (s) => lines.push(s) });
    return { r, calls, lines };
  };
  const a = await run(157, [12, 11]);
  assert.deepStrictEqual(a.r.map((x) => [x.name, x.ms, x.ok]), [['write-commit', 12, true], ['list', 20, true]]);
  assert.deepStrictEqual(a.r[0].tries, [157, 12, 11]);
  assert.strictEqual(a.r[0].budget, 50);
  assert.deepStrictEqual(a.calls, ['write-commit', 'write-commit'], 'OK の名前（list）まで計り直した');
  assert.ok(!('tries' in a.r[1]), 'OK の名前に tries を付けた');
  assert.deepStrictEqual(a.lines, ['計り直し write-commit: 157ms・12ms・11ms → 中央値 12ms（目安 50ms）OK']);
  const b = await run(157, [12, 140]);
  assert.deepStrictEqual([b.r[0].ms, b.r[0].ok, b.r[0].tries], [140, false, [157, 12, 140]], '1回でも目安に入れば OK にしている');
  assert.deepStrictEqual(b.lines, ['計り直し write-commit: 157ms・12ms・140ms → 中央値 140ms（目安 50ms）NG']);
  const c = await run(157, [151, 149]);
  assert.deepStrictEqual([c.r[0].ms, c.r[0].ok], [151, false]);
  assert.strictEqual(PF.exitCodeOf(c.r), 1);
  assert.strictEqual(PF.exitCodeOf(a.r), 0);
  // NG が無ければ again も log も呼ばない（出力に計り直しの行が出ない）
  const d = await run(30, []);
  assert.deepStrictEqual([d.calls, d.lines], [[], []]);
});

test('PG1・F17: 目安の 2 倍の時間がかかる偽の計り（中で Atomics.wait で 100ms 待つ）は、計り直しても NG', { timeout: 5000 }, async () => {
  const slow = () => {
    const t0 = performance.now();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    return performance.now() - t0;
  };
  const judged = PF.judge([{ name: 'write-commit', ms: slow() }]);
  assert.strictEqual(judged[0].ok, false);
  const r = await PF.recheck(judged, async () => slow(), { log: () => {} });
  assert.strictEqual(r[0].ok, false, '本当に遅い操作が計り直しで OK になった');
  assert.strictEqual(r[0].tries.length, 3);
  for (const t of r[0].tries) assert.ok(t >= 90, `計り直しが待っていない: ${t}`);
  assert.strictEqual(PF.exitCodeOf(r), 1);
});

test('PG1: benchDb の again(\'write-commit\') は同じ見本で数を返し、close の後は見本のフォルダが無い。measureDb の答えの名前と順は今と同じ', { timeout: 5000 }, async () => {
  const dir = tmpDir();
  try {
    const NAMES = ['db-open', 'list', 'searchIndex-typical', 'searchIndex-all', 'searchFull-trigram', 'searchFull-short', 'open-page', 'write-commit'];
    const b = await PF.benchDb({ pages: 10, segments: 5, bigBlocks: 20, bigSegments: 40, dir });
    try {
      assert.deepStrictEqual(b.results.map((x) => x.name), NAMES);
      assert.strictEqual(fs.readdirSync(dir).length, 1, '見本のフォルダが1つ無い');
      for (const name of NAMES) {
        const ms = await b.again(name);
        assert.ok(Number.isFinite(ms) && ms >= 0, `${name}: ${ms}`);
      }
      assert.throws(() => b.again('no-such'), /計り直せない/);
    } finally { b.close(); }
    assert.deepStrictEqual(fs.readdirSync(dir), [], '見本を消していない');
    const r = await PF.measureDb({ pages: 10, segments: 5, bigBlocks: 20, bigSegments: 40, dir });
    assert.deepStrictEqual(r.map((x) => x.name), NAMES);
    for (const x of r) assert.ok(Number.isFinite(x.ms) && Number.isFinite(x.first), x.name);
    assert.deepStrictEqual(fs.readdirSync(dir), [], '見本を消していない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PG1・F17: again(\'write-commit\') を2回呼んでも、書いた題名は毎回新しい値で、core.call の答えに dup が無い（小さな見本 pages: 3 で）', { timeout: 5000 }, async () => {
  const core = require('../src/db/core');
  const dir = tmpDir();
  const orig = core.call;
  const writes = [];
  core.call = (db, req, ctx) => {
    const r = orig(db, req, ctx);
    if (req && req.cmd === 'page.setTitle') writes.push({ tx: req.tx, title: req.args.title, dup: r.dup === true, ok: r.ok });
    return r;
  };
  try {
    const b = await PF.benchDb({ pages: 3, segments: 2, bigBlocks: 6, bigSegments: 6, dir });
    try {
      const first = writes.length;
      assert.ok(first > 0, 'はじめの計りで題名を書いていない');
      await b.again('write-commit');
      await b.again('write-commit');
      assert.ok(writes.length >= first * 3, `計り直しが同じ数だけ書いていない: ${writes.length}`);
    } finally { b.close(); }
    assert.deepStrictEqual(writes.filter((w) => w.dup || !w.ok), [], '計り直しが dup（書かない速い道）を計った');
    assert.strictEqual(new Set(writes.map((w) => w.tx)).size, writes.length, 'tx が重なった');
    assert.strictEqual(new Set(writes.map((w) => w.title)).size, writes.length, '題名が重なった（新しい値を書いていない）');
  } finally {
    core.call = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PG1: measureWrites({ only: \'write-256k-fsync\' }) はその名前だけを返す（fsync まで含めて計る: 今の『書く時間は fsync まで』のテストの形）', { timeout: 5000 }, () => {
  const dir = tmpDir();
  try {
    const tmpFds = new Set();
    let fileFsyncs = 0;
    const countingFs = { ...fs,
      openSync(p, flags, ...rest) { const fd = fs.openSync(p, flags, ...rest); if (flags === 'wx') tmpFds.add(fd); return fd; },
      fsyncSync(fd) { if (tmpFds.has(fd)) fileFsyncs++; return fs.fsyncSync(fd); },
      closeSync(fd) { tmpFds.delete(fd); return fs.closeSync(fd); } };
    const w = PF.measureWrites({ reps: 2, dir, fs: countingFs, only: 'write-256k-fsync' });
    assert.deepStrictEqual(w.map((x) => x.name), ['write-256k-fsync']);
    assert.strictEqual(fileFsyncs, 2, '書いたファイルを fsync していない');
    assert.ok(Number.isFinite(w[0].ms) && w[0].ms >= 0);
    assert.throws(() => PF.measureWrites({ reps: 1, dir, only: 'no-such' }), /計れない/);
    assert.deepStrictEqual(fs.readdirSync(dir), [], '見本を消していない');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PG1: 本番の計り（main）は NG の名前だけを同じ見本で計り直し、PERF_JSON の judged に3回の値（tries）を書く', { timeout: 5000 }, () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'perf.js'), 'utf8');
  const body = src.slice(src.indexOf('async function main()'));
  assert.match(body, /await recheck\(judge\(\[[^\n]*\], budgetsFor\(process\.platform\)\), again, \{ log: \(s\) => console\.log\(s\) \}\)/);
  // 計り直しは名前で振り分ける（DB は benchDb の again・書く時間は measureWrites({ only })・移行は measureMigrate）
  assert.match(body, /bench\.again\(name\)/);
  assert.match(body, /measureWrites\(\{ dir, only: name \}\)/);
  assert.match(body, /measureMigrate\(\{ dir \}\)/);
});
