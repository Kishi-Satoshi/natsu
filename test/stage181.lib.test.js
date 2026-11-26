/*
 * stage181.lib.test.js — 0.18.1（計画 docs/plans/2026-11-25-181.md）の純粋な部分。
 *  PF-1: 文字起こしのスレッドの既定（lib.defaultThreads。settings.js の defaultSettings も同じ数）・前の版の既定（lib.oldDefaultThreads）と移し（lib.oldDefaultsPatch）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/mainlib');
const S = require('../src/settings');

const T = { timeout: 5000 };

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
