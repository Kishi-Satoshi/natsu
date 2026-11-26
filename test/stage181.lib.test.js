/*
 * stage181.lib.test.js — 0.18.1（計画 docs/plans/2026-11-25-181.md）の純粋な部分。
 *  PF-1: 文字起こしのスレッドの既定（lib.defaultThreads。settings.js の defaultSettings も同じ数）・前の版の既定（lib.oldDefaultThreads）と移し（lib.oldDefaultsPatch）
 *  PF-2: 文字起こしの間隔の既定 30 秒（settings.js・lib.segmentBaseMs）・前の版の 75 秒の移し（lib.oldDefaultsPatch）・録音中は変えない（F260）
 *  PF-3: 「遅い」の覚えの印（lib.paceStamp・lib.sameStamp。印の違う覚えは無いのと同じ）と覚える条件（lib.paceSaved。速さの数 3 つ以上で理由 two・big だけ）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/mainlib');
const S = require('../src/settings');

const T = { timeout: 5000 };
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// ---------------------------------------------------------------- PF-1（決めたこと 1〜3）
test('PF-1 既定のスレッドの表: 論理 CPU が 4 より多ければ 4、4 以下なら max(2, floor(n / 2))。settings.js の既定も同じ数', T, () => {
  const table = [[1, 2], [2, 2], [3, 2], [4, 2], [5, 4], [6, 4], [8, 4], [12, 4], [16, 4], [20, 4], [64, 4]];
  for (const [n, t] of table) {
    assert.strictEqual(L.defaultThreads(n), t, `論理 CPU ${n}`);
    assert.strictEqual(S.defaultSettings(n).localThreads, t, `settings.js の既定（論理 CPU ${n}）`);
  }
  // 数でない・0 以下は論理 CPU 1 とみる（os.cpus() が空の PC）
  for (const n of [0, -1, NaN, undefined, null, '8']) assert.strictEqual(L.defaultThreads(n), 2, String(n));
});

test('PF-1 前の版の設定: 前の既定（max(4, n − 2)・max(4, floor(n / 2))）と同じスレッドの数だけを新しい既定へ移す。選んだ数・新しい既定と同じ数・ほかのキーは触らない', T, () => {
  assert.deepStrictEqual(L.oldDefaultThreads(12), [10, 6]);
  assert.deepStrictEqual(L.oldDefaultThreads(8), [6]);   // max(4, 6)・max(4, 4)
  assert.deepStrictEqual(L.oldDefaultThreads(4), [4]);   // CI の機械（論理 CPU 4）: 前の既定 4 → 新しい既定 2
  assert.deepStrictEqual(L.oldDefaultThreads(6), []);    // 前の既定はどちらも 4 で、新しい既定と同じ
  const patch = (localThreads, n) => L.oldDefaultsPatch({ localThreads, language: 'ja' }, n);
  assert.deepStrictEqual(patch(10, 12), { localThreads: 4 });
  assert.deepStrictEqual(patch(6, 12), { localThreads: 4 });
  assert.deepStrictEqual(patch(4, 4), { localThreads: 2 });
  assert.deepStrictEqual(patch(6, 8), { localThreads: 4 });
  // 持ち主の PC（論理 CPU 12）の 4 は前の既定と違う（新しい既定と同じ）ので移さない。自分で選んだ 8・3 も残す
  for (const [t, n] of [[4, 12], [8, 12], [3, 4], [2, 4], [4, 6], [12, 12]]) assert.deepStrictEqual(patch(t, n), {}, `${t} スレッド・論理 CPU ${n}`);
  assert.deepStrictEqual(L.oldDefaultsPatch(null, 12), {});
  assert.deepStrictEqual(L.oldDefaultsPatch({ localThreads: '10' }, 12), {});   // 数でない（読み込みの決まりを通る前の形）は触らない
});

// ---------------------------------------------------------------- PF-2（決めたこと 4）
test('PF-2 間隔の既定: 設定の既定は 30 秒。読み直しの既定も 30 秒。PC の中の会議の区切りは設定が無ければ 30 秒（90 秒まで）。クラウドの会議は 15 秒のまま', T, () => {
  for (const n of [2, 4, 12]) assert.strictEqual(S.defaultSettings(n).segmentSec, 30, `論理 CPU ${n}`);
  for (const v of ['abc', null, undefined]) assert.strictEqual(S.normalizeSettings({ segmentSec: v }, {}).segmentSec, 30, String(v));
  assert.strictEqual(S.normalizeSettings({ segmentSec: 'abc' }, S.defaultSettings(8)).segmentSec, 30);
  assert.strictEqual(S.readSettings({ segmentSec: 'x' }, S.defaultSettings(8)).settings.segmentSec, 30);
  for (const v of [undefined, null, 0, '', 'x']) assert.strictEqual(L.segmentBaseMs('long', v), 30000, String(v));
  assert.strictEqual(L.segmentBaseMs('long', 45), 45000);
  assert.strictEqual(L.segmentBaseMs('long', 75), 75000);   // 自分で選んだ 75 は読み込みの後なら使う（移すのは起動のときだけ）
  assert.strictEqual(L.segmentBaseMs('long', 120), 90000);
  for (const v of [undefined, 30, 75]) assert.strictEqual(L.segmentBaseMs('short', v), 15000, String(v));
});

test('PF-2 前の版の間隔: 前の版の既定のままの 75 秒だけを 30 秒へ移す。ほかの秒・スレッドとの組み合わせ', T, () => {
  assert.deepStrictEqual(L.oldDefaultsPatch({ segmentSec: 75 }, 12), { segmentSec: 30 });
  assert.deepStrictEqual(L.oldDefaultsPatch({ segmentSec: 75, localThreads: 10 }, 12), { localThreads: 4, segmentSec: 30 });
  for (const v of [30, 20, 60, 74, 76, 90, 150, '75']) assert.deepStrictEqual(L.oldDefaultsPatch({ segmentSec: v, localThreads: 8 }, 12), {}, String(v));
});

test('PF-2・F260: 録音中に保存した文字起こしの間隔は前の値に留める（会議の区切りは会議の初めの設定のまま）', T, () => {
  const g = L.guardEngineSettings({ segmentSec: 30, language: 'ja' }, { segmentSec: 60, language: 'ja' }, true);
  assert.strictEqual(g.settings.segmentSec, 30);
  assert.deepStrictEqual(g.kept, ['segmentSec']);
  assert.strictEqual(L.guardEngineSettings({ segmentSec: 30 }, { segmentSec: 60 }, false).settings.segmentSec, 60);
});

test('PF-2 字（決めたこと 5）: 設定の説明・ヘルプ・README の既定の区切りは 30 秒。kotoba-whisper の案内は「長い区切りの文字起こし」。75 秒の既定を言う字は残らない', T, () => {
  assert.ok(read('src', 'renderer', 'app.html').includes('文の切れ目が増えます（既定30秒。最初の1回は20秒）。'), '設定の説明');
  const stops = read('help', 'articles', 'trouble', 'transcription-stops.md');
  assert.ok(stops.includes('PC の中で文字起こしする間は区切りが長い（既定 30 秒）ので、'), 'transcription-stops.md');
  assert.ok(read('help', 'articles', 'settings', 'offline.md').includes('区切りが設定の長さ（既定 30 秒）なので、クラウド（15 秒）より'), 'offline.md');
  assert.ok(read('help', 'articles', 'record', 'status-line.md').includes('設定の長さ（既定 30 秒。最初の1回は 20 秒。長くても 90 秒）ずつです。'), 'status-line.md');
  const readme = read('README.md');
  assert.ok(readme.includes('- 録音 → 約30秒ごと（PC の中で文字起こしする会議。クラウドは 15 秒ごと）にリアルタイム文字起こし（最初の1回は20秒で早く結果を出す）'), 'README の機能の行');
  assert.ok(readme.includes('PC の中で文字起こしする会議は今までどおり設定の長さ（既定 30 秒）です。'), 'README の区切りの行');
  assert.ok(readme.includes('NaTsu の長い区切りの文字起こしでは'), 'README の kotoba の行');
  assert.ok(read('src', 'main.js').includes("const KOTOBA_NOTE = '文字起こしのモデルが kotoba-whisper です。長い区切りの文字起こしでは文の抜け落ちが多いため、'"), 'KOTOBA_NOTE');
  for (const [f, t] of [['README.md', readme], ['help/articles/trouble/transcription-stops.md', stops], ['src/main.js', read('src', 'main.js')]]) {
    assert.ok(!/既定 ?75 ?秒|約75秒ごと|75 秒ずつの文字起こし/.test(t), `${f} に 75 秒の既定の字が残っている`);
  }
});

// ---------------------------------------------------------------- PF-3（決めたこと 6）
const DAY = 24 * 3600 * 1000;
const MODEL = { name: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195 };
const NOW = 1_800_000_000_000;
test('PF-3 前の版の覚え: 印（エンジンの組・スレッドの数・優先度の版 2）が無い・違う「遅い」の覚えは会議の始めに使わない。印が同じなら今どおり使う。前の覚えの rtf は印が違えば混ぜない', T, () => {
  const STAMP = L.paceStamp({ set: 'manual', threads: 4 });
  assert.deepStrictEqual(STAMP, { set: 'manual', threads: 4, prio: 2 });
  for (const x of [{}, { set: '', threads: 4 }, { set: 'manual', threads: 0 }, { set: 'manual', threads: '4' }, { set: 5, threads: 4 }]) assert.strictEqual(L.paceStamp(x), null, JSON.stringify(x));
  const saved = (stamp) => ({ schema: 1, model: MODEL, rtf: 1.6, slow: true, at: NOW - DAY, from: 'live', ...(stamp === undefined ? {} : { stamp }) });
  const start = (sv) => L.paceStep(undefined, { kind: 'start', saved: sv, model: MODEL, stamp: STAMP, now: NOW });
  // 0.18.0 までの覚え（印が無い）・スレッドの数が違う・組が違う・優先度の版が違う・形の違う印は、無いのと同じ
  for (const st of [undefined, null, { set: 'manual', threads: 8, prio: 2 }, { set: 'whisper-1.9.5-vk', threads: 4, prio: 2 }, { set: 'manual', threads: 4, prio: 1 }, { set: 'manual', threads: 4 }, 'manual']) {
    const r = start(saved(st));
    assert.ok(r.slow === false && r.why === '', JSON.stringify(st));
  }
  const same = start(saved({ set: 'manual', threads: 4, prio: 2 }));
  assert.ok(same.slow === true && same.why === 'saved');
  // 会議に印が無い（モデルが分からない形と同じ）なら使わない
  assert.strictEqual(L.paceStep(undefined, { kind: 'start', saved: saved(STAMP), model: MODEL, stamp: null, now: NOW }).slow, false);
  assert.ok(L.sameStamp(STAMP, { set: 'manual', threads: 4, prio: 2 }) && !L.sameStamp(STAMP, null) && !L.sameStamp(null, null));
  // 書く覚えには印を書く。印の違う前の覚えの rtf は混ぜない（印が同じなら今どおり混ぜる）
  const st = { slow: false, why: '', run: 0, rtf: 0.5, samples: 3 };
  const w = L.paceSaved(st, { schema: 1, model: MODEL, rtf: 3, slow: false, at: NOW - DAY, from: 'live' }, { model: MODEL, stamp: STAMP, now: NOW, from: 'live' });
  assert.deepStrictEqual(w, { schema: 1, model: MODEL, stamp: STAMP, rtf: 0.5, slow: false, at: NOW, from: 'live' });
  const mixed = L.paceSaved(st, { schema: 1, model: MODEL, stamp: STAMP, rtf: 1.5, slow: false, at: NOW - DAY, from: 'live' }, { model: MODEL, stamp: STAMP, now: NOW, from: 'live' });
  assert.strictEqual(mixed.rtf, 1);
  // 印が分からない会議は書かない
  assert.strictEqual(L.paceSaved(st, null, { model: MODEL, stamp: null, now: NOW, from: 'live' }), null);
});

test('PF-3 覚える条件: 「遅い」と覚えるのは、その会議で速さの数が 3 つ以上あり、理由が two・big のときだけ。時間切れ1回・待ちだけ・数の少ない会議の「遅い」は、その会議の中だけ（覚えは遅くない）', T, () => {
  const STAMP = L.paceStamp({ set: 'manual', threads: 4 });
  const save = (st) => L.paceSaved(st, null, { model: MODEL, stamp: STAMP, now: NOW, from: 'live' });
  const run = (evs) => evs.reduce((st, ev) => L.paceStep(st, ev).st, L.paceStep(undefined, { kind: 'start', saved: null, model: MODEL, stamp: STAMP, now: NOW }).st);
  const S = (procMs) => ({ kind: 'sample', audioMs: 30000, procMs });
  // 時間切れ1回（速さの数なし）: その会議は遅いが、覚えない（書かない）
  const late = run([{ kind: 'late' }]);
  assert.ok(late.slow && late.why === 'late');
  assert.strictEqual(save(late), null);
  // 速さの数がある会議の時間切れ・待ち: 覚えは遅くない（rtf だけ）
  const late1 = run([S(24000), { kind: 'late' }]);
  assert.deepStrictEqual([late1.slow, save(late1).slow, save(late1).rtf], [true, false, 0.8]);
  const backlog = run([S(24000), S(24000), S(24000), { kind: 'backlog', audioMs: 300000 }]);
  assert.deepStrictEqual([backlog.slow, backlog.why, save(backlog).slow], [true, 'backlog', false]);
  // two・big でも速さの数が 3 つに満たなければ覚えない
  const two2 = run([S(36000), S(36000)]);
  assert.deepStrictEqual([two2.slow, two2.why, two2.samples, save(two2).slow], [true, 'two', 2, false]);
  const big1 = run([S(60000)]);
  assert.deepStrictEqual([big1.slow, big1.why, save(big1).slow], [true, 'big', false]);
  // 3 つ以上で two・big は覚える
  const two3 = run([S(24000), S(36000), S(36000)]);
  assert.deepStrictEqual([two3.slow, two3.why, two3.samples, save(two3).slow], [true, 'two', 3, true]);
  const big3 = run([S(24000), S(24000), S(60000)]);
  assert.deepStrictEqual([big3.why, save(big3).slow], ['big', true]);
  // 遅くない会議は今どおり遅くないと書く
  assert.strictEqual(save(run([S(15000), S(15000), S(15000)])).slow, false);
});
