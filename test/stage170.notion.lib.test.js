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

// ---------------------------------------------------------------- NX-2（決めたこと 80・81・F206・F207）
test('NX-2・F206: backspaceAtStart の表（型 × 段 0・1・2 × last × inCallout。決めたこと 80・違いの行 X-17・X-18・X-31・D-09〜D-11・T-06・B-24）', () => {
  const B = (b, depth, last, inCallout) => E.backspaceAtStart(b, { depth, last, inCallout });
  const all = (fn) => { for (const depth of [0, 1, 2]) for (const last of [true, false]) for (const inCallout of [true, false]) fn(depth, last, inCallout); };
  // 箇条書き・ToDo・番号付き・トグル・引用は、段にかかわらず先にテキストに戻す
  for (const type of ['bullet', 'todo', 'numbered', 'toggle', 'quote']) all((d, l, c) => assert.strictEqual(B({ type }, d, l, c), 'revert', `${type} ${d} ${l} ${c}`));
  // トグル見出しは段・開け閉めにかかわらず、ふつうの見出しへ（S2・U1・U7）
  for (const level of [1, 2, 3]) for (const open of [true, false]) all((d, l, c) => assert.strictEqual(B({ type: 'heading', level, toggle: true, open }, d, l, c), 'untoggle', `th${level} ${open} ${d} ${l} ${c}`));
  // 見出し（トグルでない・段の無い古い見出しも）・コールアウト・テキスト（知らない型はテキストの見た目）
  for (const b of [{ type: 'heading', level: 1 }, { type: 'heading', level: 3 }, { type: 'heading' }, { type: 'callout' }, { type: 'paragraph' }, {}, { type: 'video' }]) {
    all((d, l, c) => {
      const want = d > 0 && l && !c ? 'outdent' : 'merge';   // 最上位はつなぐ・字下げした最後の子は1段戻す・後ろに兄弟があればつなぐ・コールアウトの中はつなぐ
      assert.strictEqual(B(b, d, l, c), want, `${JSON.stringify(b)} ${d} ${l} ${c}`);
    });
  }
  // 渡さなければ最上位（今の呼び方の形）
  assert.strictEqual(E.backspaceAtStart({ type: 'heading', level: 2 }), 'merge');
  assert.strictEqual(E.backspaceAtStart({ type: 'bullet' }, { depth: 1 }), 'revert');
  assert.strictEqual(E.backspaceAtStart({ type: 'divider' }), 'revert', '区切り線は今のまま');
});

test('NX-2・F207: liftOut は行を外し、その子を同じ所に元の順で並べる（子の欄は1字も変えない）。mergeKids は無い', () => {
  const kids = [{ id: 'k1', type: 'todo', text: 'やる', task: 'r1', cites: ['s1'], assignee: '担当A', due: '2026-11-30', checked: true }, { id: 'k2', type: 'toggle', text: '開', open: false, children: [{ id: 'g', type: 'paragraph', text: '孫' }] }];
  const list = [{ id: 'a', type: 'paragraph', text: 'a' }, { id: 'b', type: 'paragraph', text: 'b', children: structuredClone(kids) }, { id: 'c', type: 'paragraph', text: 'c' }];
  const out = BT.liftOut(list, 1);
  assert.deepStrictEqual(list.map((x) => x.id), ['a', 'k1', 'k2', 'c']);
  assert.deepStrictEqual(list.slice(1, 3), kids, '子の欄が変わった');
  assert.deepStrictEqual(out.map((x) => x.id), ['k1', 'k2']);
  const one = [{ id: 'x', type: 'paragraph', text: '' }];
  assert.deepStrictEqual(BT.liftOut(one, 0), []);
  assert.deepStrictEqual(one, [], '子の無い行も外す');
  assert.strictEqual(BT.mergeKids, undefined, 'mergeKids が残っている（決めたこと 81）');
});

test('NX-2・F207: メモの命令（memoEdit）の block.merge も、消える行の子は消えた行の所に1段上がって並ぶ（つないだ先の子にならない）', () => {
  const doc = [{ id: 'm1', type: 'toggle', text: '親', citeState: 'manual', children: [{ id: 'm2', type: 'paragraph', text: '中', citeState: 'manual' }] },
    { id: 'm3', type: 'paragraph', text: 'つなぐ', citeState: 'manual', children: [{ id: 'm4', type: 'todo', text: 'やる', checked: true, citeState: 'manual' }, { id: 'm5', type: 'paragraph', text: '二', citeState: 'manual' }] }];
  const r = MD.memoEdit(doc, 'block.merge', { blockId: 'm3', text: 'つなぐ', intoId: 'm2' }, { next: 10 });
  assert.deepStrictEqual(r.doc.map((b) => b.id), ['m1', 'm4', 'm5']);
  assert.deepStrictEqual(r.doc[0].children.map((b) => [b.id, b.text]), [['m2', '中つなぐ']]);
  assert.deepStrictEqual([r.doc[1].type, r.doc[1].checked], ['todo', true]);
});

// ---------------------------------------------------------------- NX-4（決めたこと 83・84・F210）
test('NX-4・F210: turnMovesKids の表（トグル・トグル見出し → テキストは子を残す・→ トグルでない見出しは外へ・ほかの子を持てる型は残す・区切り線は外へ: 計画の違いの行 X-22・B-25）', () => {
  const M = (b, to) => BT.turnMovesKids(b, to);
  const tog = { type: 'toggle' }; const th = { type: 'heading', level: 2, toggle: true };
  for (const b of [tog, th]) {
    assert.strictEqual(M(b, { type: 'paragraph' }), false, `${JSON.stringify(b)} → テキスト`);
    assert.strictEqual(M(b, { type: 'heading', level: 1 }), true, `${JSON.stringify(b)} → 見出し`);
    assert.strictEqual(M(b, { type: 'heading', level: 3, toggle: true }), false, `${JSON.stringify(b)} → トグル見出し`);
    for (const t of ['bullet', 'todo', 'numbered', 'quote', 'callout', 'toggle']) assert.strictEqual(M(b, { type: t }), false, `${JSON.stringify(b)} → ${t}`);
    assert.strictEqual(M(b, { type: 'divider' }), true);
  }
  assert.strictEqual(M({ type: 'bullet' }, { type: 'numbered' }), false);
  assert.strictEqual(M({ type: 'paragraph' }, { type: 'heading', level: 2 }), true);
});

test('NX-4・F210: メモの命令（memoEdit）の block.turnInto・blocks.turnInto も、トグルをテキストにすると子は中に残り、見出しにすると外へ', () => {
  const doc = [{ id: 'm1', type: 'toggle', text: '親', citeState: 'manual', children: [{ id: 'm2', type: 'paragraph', text: '中', citeState: 'manual' }] },
    { id: 'm3', type: 'heading', level: 1, toggle: true, text: '見出し', citeState: 'manual', children: [{ id: 'm4', type: 'paragraph', text: '中二', citeState: 'manual' }] }];
  let r = MD.memoEdit(doc, 'block.turnInto', { blockId: 'm1', type: 'paragraph' }, { next: 10 });
  assert.deepStrictEqual([r.doc[0].type, r.doc[0].children.map((b) => b.id), r.doc.map((b) => b.id)], ['paragraph', ['m2'], ['m1', 'm3']]);
  r = MD.memoEdit(doc, 'blocks.turnInto', { ids: ['m1', 'm3'], type: 'paragraph' }, { next: 10 });
  assert.deepStrictEqual(r.doc.map((b) => [b.id, b.type, (b.children || []).map((k) => k.id)]), [['m1', 'paragraph', ['m2']], ['m3', 'paragraph', ['m4']]]);
  r = MD.memoEdit(doc, 'block.turnInto', { blockId: 'm3', type: 'heading', level: 1 }, { next: 10 });
  assert.deepStrictEqual(r.doc.map((b) => b.id), ['m1', 'm3', 'm4'], 'トグル見出しを見出しにしても子が外へ出ない');
});
