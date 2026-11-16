/* stage170.notion.lib.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の第4部（実機との違いの直し。決めたこと 78〜87・F205〜F214）の純粋な部品
 * Notion の動きは docs/plans/notion-behavior.md の項目番号（X-16〜X-34・B-24〜B-26・D-09〜D-11・T-06・P-08）で指す。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/blockEdit');
const BT = require('../src/blockTree');
const MD = require('../src/memoDoc');

// ---------------------------------------------------------------- NX-1（決めたこと 78・79・F205）
test('NX-1・F205: nextTypeOnEnter の表（見出しの後はテキスト: X-16。トグル見出し・リスト・引用・コールアウト・テキストは今のまま）', () => {
  const N = (b, o) => E.nextTypeOnEnter(b, o);
  for (const b of [{ type: 'heading', level: 1 }, { type: 'heading', level: 2 }, { type: 'heading', level: 3 }, { type: 'heading' }]) {
    for (const open of [true, false]) assert.deepStrictEqual(N(b, { open }), { type: 'paragraph' }, `${JSON.stringify(b)} open=${open}`);
    assert.deepStrictEqual(N(b, { empty: true }), { type: 'paragraph' }, `空の ${JSON.stringify(b)}`);
    assert.deepStrictEqual(N(b, { empty: true, depth: 2 }), { type: 'paragraph' }, `字下げした空の ${JSON.stringify(b)}`);
  }
  // トグル見出しは今のまま（開いていればテキスト・閉じていれば同じ段のトグル見出し: NR25）
  assert.deepStrictEqual(N({ type: 'heading', level: 2, toggle: true }, { open: true }), { type: 'paragraph' });
  assert.deepStrictEqual(N({ type: 'heading', level: 2, toggle: true }, { open: false }), { type: 'heading', level: 2, toggle: true });
  // リストは今のまま（同じ型・空ならテキストへ・字下げした空は1段戻す）
  for (const t of ['bullet', 'todo', 'numbered']) {
    assert.deepStrictEqual(N({ type: t }), { type: t }, t);
    assert.strictEqual(N({ type: t }, { empty: true }), 'revert', t);
    assert.strictEqual(N({ type: t }, { empty: true, depth: 1 }), 'outdent', t);
  }
  for (const t of ['quote', 'callout', 'paragraph']) assert.deepStrictEqual(N({ type: t }), { type: 'paragraph' }, t);
  assert.deepStrictEqual(N({ type: 'toggle' }, { open: false }), { type: 'toggle' });
});

test('NX-1・F205: メモの命令（src/memoDoc.js の memoEdit）の block.split も見出しの後はテキスト（末尾・途中・頭の上の行）。コールアウトの inside は最初の子のテキスト', () => {
  const doc = [{ id: 'm1', type: 'heading', level: 2, text: '目的', citeState: 'manual' }, { id: 'm2', type: 'callout', text: 'メモ', citeState: 'manual' }];
  const at = (d, id) => BT.locate(d, id);
  // 末尾
  let r = MD.memoEdit(doc, 'block.split', { blockId: 'm1', text: '目的', at: 2 }, { next: 10 });
  assert.deepStrictEqual(r.doc.map((b) => [b.type, b.text]), [['heading', '目的'], ['paragraph', ''], ['callout', 'メモ']]);
  // 途中: 前半は見出しのまま、後半はテキスト
  r = MD.memoEdit(doc, 'block.split', { blockId: 'm1', text: '目的です', at: 2 }, { next: 10 });
  assert.deepStrictEqual(r.doc.map((b) => [b.type, b.text]).slice(0, 2), [['heading', '目的'], ['paragraph', 'です']]);
  // 文のある見出しの頭: 上に空のテキスト、見出しはそのまま
  r = MD.memoEdit(doc, 'block.split', { blockId: 'm1', text: '目的', at: 0 }, { next: 10 });
  assert.deepStrictEqual(r.doc.map((b) => [b.id === 'm1' ? 'm1' : 'new', b.type, b.text]).slice(0, 2), [['new', 'paragraph', ''], ['m1', 'heading', '目的']]);
  // コールアウトの末尾（inside）: 最初の子に空のテキスト（S5・B-24）
  r = MD.memoEdit(doc, 'block.split', { blockId: 'm2', text: 'メモ', at: 2, inside: true }, { next: 10 });
  assert.deepStrictEqual(at(r.doc, 'm2').b.children.map((b) => [b.type, b.text]), [['paragraph', '']]);
});
