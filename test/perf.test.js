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

test('PERF: 目安は設計書の値（開く 0.5 秒・検索 0.3 秒）と、この回で決めた天井', { timeout: 5000 }, () => {
  assert.deepStrictEqual(PF.BUDGETS, { 'store-init': 500, 'open-page': 500, 'searchIndex-typical': 300, 'searchIndex-all': 600, 'searchFullText': 2000,
    'write-256k-fsync': 50, 'write-1m-fsync': 150, 'write-10m-fsync': 1500 });
});

test('PERF: Windows だけの目安は、最初の Windows の CI で越えた名前（searchIndex-all: 中央値 729.43ms）だけを、測った中央値の 2 倍にする。ほかの OS と、ほかの名前は BUDGETS のまま', { timeout: 5000 }, () => {
  assert.deepStrictEqual(PF.BUDGETS_WIN, { 'searchIndex-all': 1460 });
  assert.deepStrictEqual(PF.budgetsFor('linux'), PF.BUDGETS);
  assert.deepStrictEqual(PF.budgetsFor('win32'), { ...PF.BUDGETS, 'searchIndex-all': 1460 });
  assert.deepStrictEqual(PF.judge([{ name: 'searchIndex-all', ms: 729.43 }], PF.budgetsFor('win32')).map((x) => x.ok), [true]);
  assert.deepStrictEqual(PF.judge([{ name: 'searchIndex-all', ms: 729.43 }], PF.budgetsFor('linux')).map((x) => x.ok), [false]);
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

test('PERF: 小さな見本（20 ページ）で、計りが最後まで走り、目安の名前が全部そろう', { timeout: 5000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-perf-'));
  const s = await PF.measureStore({ pages: 20, segments: 5, bigBlocks: 50, bigSegments: 100, dir });
  assert.deepStrictEqual(s.map((x) => x.name).sort(), ['open-page', 'searchFullText', 'searchIndex-all', 'searchIndex-typical', 'store-init']);
  // 書く時間は書いたファイルの fsync まで含めて計る（fsync の無い時間では決め方の答えが変わる）。Linux はフォルダの fsync もするので、
  // 一時ファイル（'wx' で開いたもの）の fsync だけを数える
  const tmpFds = new Set();
  let fileFsyncs = 0;
  const countingFs = { ...fs,
    openSync(p, flags, ...rest) { const fd = fs.openSync(p, flags, ...rest); if (flags === 'wx') tmpFds.add(fd); return fd; },
    fsyncSync(fd) { if (tmpFds.has(fd)) fileFsyncs++; return fs.fsyncSync(fd); },
    closeSync(fd) { tmpFds.delete(fd); return fs.closeSync(fd); } };
  const w = PF.measureWrites({ reps: 2, dir, fs: countingFs });
  assert.strictEqual(fileFsyncs, 2 * 5, '書いたファイルを fsync していない');
  for (const n of ['write-256k-fsync', 'write-1m-fsync', 'write-10m-fsync']) assert.ok(w.some((x) => x.name === n), n);
  for (const x of [...s, ...w]) assert.ok(Number.isFinite(x.ms) && x.ms >= 0, x.name);
  assert.deepStrictEqual(fs.readdirSync(dir), [], '見本を消していない');
  fs.rmdirSync(dir);
});

test('ci.yml の test: npm test の後に node tools/perf.js を回す（Linux と Windows）', { timeout: 5000 }, () => {
  const st = stepsOf(jobsOf(fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'ci.yml'), 'utf8')).test);
  const iTest = st.findIndex((s) => /^\s*npm test/m.test(s));
  const iPerf = st.findIndex((s) => /^\s*run: node tools\/perf\.js$/m.test(s));
  assert.ok(iTest >= 0 && iPerf > iTest, `${iTest},${iPerf}`);
  assert.ok(!/if: runner\.os/.test(st[iPerf]), '片方の OS だけで計っている');
});
