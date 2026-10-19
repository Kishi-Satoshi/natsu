/* stage1d.lib.test.js — 第1d回 D16・D17 の mainlib の純粋な関数（区切りの長さ・止まりの見張り・帯の選び方・知らせの間引き・再起動を断る理由） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/mainlib');

// ---------------------------------------------------------------- A-9（RL16・F16・RF41）: 更新の再起動を断る理由
test('RF41: 録音中（会議・音声入力の録音と文字起こし）は recording、締めと残りの区間は finalizing、要約は summary、ほかは \'\'', { timeout: 5000 }, () => {
  const B = (o) => L.restartBlock({ state: 'idle', finalizing: 0, pendingSegs: 0, summarizing: false, ...o });
  assert.deepStrictEqual(['meeting', 'recording', 'processing'].map((state) => B({ state })), ['recording', 'recording', 'recording']);
  assert.deepStrictEqual([B({ state: 'meeting-finalizing' }), B({ finalizing: 1 }), B({ pendingSegs: 2 })], ['finalizing', 'finalizing', 'finalizing']);
  assert.strictEqual(B({ summarizing: true }), 'summary');
  assert.strictEqual(B({}), '');
  assert.strictEqual(B({ state: 'meeting', summarizing: true }), 'recording', '録音中を要約より先に言う');
});
