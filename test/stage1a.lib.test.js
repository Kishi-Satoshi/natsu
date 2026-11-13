/*
 * stage1a.lib.test.js — 第1a回で mainlib に足した純粋な関数（chooseDraftName。音声入力の履歴の recordDictation・mergeHistory は
 * 0.15.1 ND-1（計画 docs/plans/2026-11-04-151.md の「意図して変えるテスト」・D114）で履歴の読み書きと一緒に消し、そのテストも消した）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const lib = require('../src/mainlib');

test('JS9: 新しい会議の下書きの名前 — draft.json が無ければ draft.json、あれば退けてから draft.json、退けられなければ draft-<開始時刻>.json', { timeout: 5000 }, () => {
  const calls = [];
  const park = (ok) => () => { calls.push('park'); return { ok }; };
  assert.strictEqual(lib.chooseDraftName({ existing: [], startedAt: 7, park: park(true) }), 'draft.json');
  assert.deepStrictEqual(calls, []);
  assert.strictEqual(lib.chooseDraftName({ existing: ['draft.json'], startedAt: 7, park: park(true) }), 'draft.json');
  assert.strictEqual(lib.chooseDraftName({ existing: ['draft.json', 'draft-5.json'], startedAt: 7, park: park(false) }), 'draft-7.json');
  assert.strictEqual(lib.chooseDraftName({ existing: ['draft-5.json'], startedAt: 7, park: park(false) }), 'draft.json');
});

test('logReason: 記録に書く失敗の理由は、fs のエラーなら符号だけ、ほかは文の中のパスを最後の部分だけにする（engine.log にパス全体を書かない）', { timeout: 5000 }, () => {
  const fsErr = Object.assign(new Error("EACCES: permission denied, open 'C:\\Users\\example\\AppData\\Roaming\\natsu\\data\\segbuf\\1\\0001.wav'"), { code: 'EACCES' });
  assert.strictEqual(lib.logReason(fsErr), 'EACCES');
  assert.strictEqual(lib.logReason(new Error("読めません: 'C:\\Users\\example\\data\\segbuf\\1\\0001.wav'")), "読めません: '…0001.wav'");
  assert.strictEqual(lib.logReason(new Error('open /home/example/.config/natsu/data/pages/p1.json failed')), 'open …p1.json failed');
  assert.strictEqual(lib.logReason(new Error('文字起こしに失敗: HTTP 500')), '文字起こしに失敗: HTTP 500');
  assert.strictEqual(lib.logReason(new Error('fetch failed http://127.0.0.1:8990/inference')), 'fetch failed http://127.0.0.1:8990/inference');
  assert.strictEqual(lib.logReason(Object.assign(new Error('x'), { code: 'ERR_SOMETHING' })), 'ERR_SOMETHING');
  assert.strictEqual(lib.logReason(null), '不明なエラー');
  assert.strictEqual(lib.logReason('文字の理由'), '文字の理由');
});
