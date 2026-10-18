/*
 * stage1a.lib.test.js — 第1a回で mainlib に足した純粋な関数（recordDictation・mergeHistory・chooseDraftName）
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

// 計画の外で足した（Task 2-3 の「読めない間の履歴とファイルの履歴を id で合わせ、maxHistory で切る」を純粋な関数で押さえる）
test('RF22: 読めない間の履歴（新しい順）を先に、ファイルの履歴のうち同じ id の無いものを後ろに並べ、maxHistory で切る。ファイルと同じなら書かない', { timeout: 5000 }, () => {
  const file = [{ id: 'h2', text: 'ファイル2' }, { id: 'h1', text: 'ファイル1' }];
  const r = lib.mergeHistory([{ id: 'n2', text: '新2' }, { id: 'n1', text: '新1' }, { id: 'h2', text: '新しい方' }], file, 500);
  assert.deepStrictEqual(r.list.map((h) => h.id), ['n2', 'n1', 'h2', 'h1']);
  assert.strictEqual(r.list[2].text, '新しい方');
  assert.strictEqual(r.changed, true);
  assert.deepStrictEqual(lib.mergeHistory([{ id: 'n1' }, { id: 'n0' }], file, 3).list.map((h) => h.id), ['n1', 'n0', 'h2']);
  const same = lib.mergeHistory([], file, 500);
  assert.deepStrictEqual(same.list, file);
  assert.strictEqual(same.changed, false);
  // 壊れた max は recordDictation と同じく既定の 500（切らない）
  for (const max of [-1, 1.5, 'abc', undefined]) assert.strictEqual(lib.mergeHistory([{ id: 'n' }], file, max).list.length, 3, String(max));
  assert.strictEqual(lib.mergeHistory([], file, 1).changed, true, 'maxHistory で切ったのに書かない');
});
