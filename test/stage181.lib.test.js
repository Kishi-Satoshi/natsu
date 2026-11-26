/*
 * stage181.lib.test.js — 0.18.1（計画 docs/plans/2026-11-25-181.md）の純粋な部分。
 *  PF-1: 文字起こしのスレッドの既定（lib.defaultThreads。settings.js の defaultSettings も同じ数）・前の版の既定（lib.oldDefaultThreads）と移し（lib.oldDefaultsPatch）
 *  PF-2: 文字起こしの間隔の既定 30 秒（settings.js・lib.segmentBaseMs）・前の版の 75 秒の移し（lib.oldDefaultsPatch）・録音中は変えない（F260）
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
