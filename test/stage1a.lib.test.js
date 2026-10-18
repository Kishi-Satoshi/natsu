/*
 * stage1a.lib.test.js — 第1a回で mainlib に足した純粋な関数（recordDictation・chooseDraftName）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const lib = require('../src/mainlib');

test('JS5: 履歴を保存できなくても（ok: false でも投げても）、口述した文字は必ず貼る。今の順（保存 → 画面へ → 貼る）のまま', { timeout: 5000 }, async () => {
  for (const save of [() => ({ ok: false }), () => { throw new Error('EBUSY'); }]) {
    const order = [];
    const history = [{ id: 'h0', text: '前' }];
    const r = await lib.recordDictation({ history, entry: { id: 'h1', text: '口述' }, max: 500,
      save: () => { order.push('save'); return save(); }, notify: (h) => order.push(`notify:${h.length}`), deliver: async (t) => { order.push(`deliver:${t}`); } });
    assert.deepStrictEqual(order, ['save', 'notify:2', 'deliver:口述']);
    assert.deepStrictEqual(history.map((h) => h.id), ['h1', 'h0']);
    assert.strictEqual(r.saved, false);
  }
  const ok = await lib.recordDictation({ history: [], entry: { id: 'h', text: 't' }, max: 500, save: () => ({ ok: true }), notify: () => {}, deliver: async () => {} });
  assert.strictEqual(ok.saved, true);
});

test('JS6・F8: max が 0〜10000 の整数でなくても落ちず、履歴を消さない（今は -1 や 1.5 で RangeError になり貼り付けまで止まる）', { timeout: 5000 }, async () => {
  for (const max of [-1, 1.5, 'abc', undefined]) {
    const history = Array.from({ length: 3 }, (_, i) => ({ id: `h${i}`, text: String(i) }));
    let pasted = '';
    await lib.recordDictation({ history, entry: { id: 'n', text: '新' }, max, save: () => ({ ok: true }), notify: () => {}, deliver: async (t) => { pasted = t; } });
    assert.strictEqual(pasted, '新', String(max));
    assert.strictEqual(history.length, 4, `${max}: 履歴を切った`);
  }
  const h2 = Array.from({ length: 5 }, (_, i) => ({ id: `h${i}` }));
  await lib.recordDictation({ history: h2, entry: { id: 'n' }, max: 3, save: () => ({ ok: true }), notify: () => {}, deliver: async () => {} });
  assert.strictEqual(h2.length, 3);
});
