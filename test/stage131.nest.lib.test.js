/*
 * stage131.nest.lib.test.js — 0.13.1「入れ子とトグル」の純粋な部品（計画 docs/plans/2026-10-27-131.md の Task NE-1）
 * 木の組み立てと平らにする・字下げの決まり・置き場・見える順・親ごとの番号・結合と変換の子・落とす段（src/blockTree.js）と、
 * 型の表のトグルとトグル見出し1〜3・行頭の記法・近道・Enter の型・［コピー］の Markdown（src/blockEdit.js）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/blockEdit.js');
const BT = require('../src/blockTree.js');

const P = 'pg1';
const bk = (id, type = 'bullet', o = {}) => ({ id, type, text: id, ...o });
// rows（DB の pageBlocks の順の形）: [id, parent_id, 型, attrs]
const rowsOf = (list) => list.map(([id, parent, type = 'bullet', o = {}]) => ({ id, parent_id: parent, block: bk(id, type, o) }));
const shape = (blocks) => blocks.map((b) => (b.children && b.children.length ? [b.id, shape(b.children)] : b.id));
const ids = (list) => list.map((x) => (x.b ? x.b.id : x.id));
// 木を手で作る: [id, 型, attrs, 子]
function tree(spec) {
  return spec.map(([id, type = 'bullet', o = {}, kids = []]) => ({ ...bk(id, type, o), children: tree(kids) }));
}

// ---------------------------------------------------------------- 組み立てと平らにする（決めたこと 3・NR1・NR2・F48）
test('NE-1: buildTree と flattenBlocks は互いに戻る（深さ優先・親の後に子）。flattenBlocks は写しでなく同じ物を返す（出典を書くと木に見える）', () => {
  const rows = rowsOf([['a', P], ['b', 'a'], ['c', 'b'], ['d', P], ['e', 'a'], ['f', 'd']]);
  const { blocks, orphans } = BT.buildTree(rows, P);
  assert.strictEqual(orphans, 0);
  assert.deepStrictEqual(shape(blocks), [['a', [['b', ['c']], 'e']], ['d', ['f']]]);
  const flat = BT.flattenBlocks(blocks);
  assert.deepStrictEqual(flat.map((b) => b.id), ['a', 'b', 'c', 'e', 'd', 'f']);
  assert.strictEqual(flat[2], blocks[0].children[0].children[0], '平らにした並びが写し');
  flat[2].cites = ['s1'];
  assert.deepStrictEqual(blocks[0].children[0].children[0].cites, ['s1'], '平らにした並びに書いた出典が木に届かない');
  // 組んだ木を行に戻して組み直すと同じ形
  const back = BT.walk(blocks).map(({ b, parentId }) => ({ id: b.id, parent_id: parentId || P, block: { ...b, children: undefined } }));
  assert.deepStrictEqual(shape(BT.buildTree(back, P).blocks), shape(blocks));
  // 子の無い並びは今と同じ平らな並び（どの行も空の children）
  const flatRows = rowsOf([['x', P], ['y', P]]);
  const t = BT.buildTree(flatRows, P);
  assert.deepStrictEqual(t.blocks.map((b) => [b.id, b.children]), [['x', []], ['y', []]]);
  assert.deepStrictEqual(BT.flattenBlocks(undefined), []);
  assert.deepStrictEqual(BT.walk(blocks).map((w) => [w.b.id, w.depth, w.parentId, w.index]),
    [['a', 0, null, 0], ['b', 1, 'a', 0], ['c', 2, 'b', 0], ['e', 1, 'a', 1], ['d', 0, null, 1], ['f', 1, 'd', 0]]);
  const l = BT.locate(blocks, 'c');
  assert.strictEqual(l.b.id, 'c'); assert.strictEqual(l.parent.id, 'b'); assert.strictEqual(l.depth, 2); assert.strictEqual(l.index, 0);
  assert.strictEqual(l.list, blocks[0].children[0].children);
  assert.strictEqual(BT.locate(blocks, 'zz'), null);
});

test('NE-1・NR2: 親が無い・親が別のページ・輪になる行は最上位の末尾に ord の順で残る（数は orphans）', () => {
  const rows = rowsOf([['a', P], ['x', 'gone'], ['b', 'a'], ['y', 'other-page-block'], ['l1', 'l2'], ['l2', 'l1'], ['k', 'l1'], ['c', P]]);
  const { blocks, orphans } = BT.buildTree(rows, P);
  assert.deepStrictEqual(shape(blocks), [['a', ['b']], 'c', 'x', 'y', ['l1', ['k']], 'l2']);
  assert.strictEqual(orphans, 4);
  assert.strictEqual(BT.flattenBlocks(blocks).length, rows.length, '読み落とした行がある');
  const self = BT.buildTree(rowsOf([['s', 's'], ['t', P]]), P);
  assert.deepStrictEqual(shape(self.blocks), ['t', 's']);
  assert.strictEqual(self.orphans, 1);
});

// ---------------------------------------------------------------- 字下げ（E10・EQ17 (a)・TQ2）
test('NE-1・EQ17 (a): canIndent は前の兄弟が無い・前の兄弟が区切り線かトグルでない見出し → 偽。TQ2: AI の節の見出し（citeState の無い見出し。トグル見出しにしても）→ 偽、人の見出し・人のトグル見出しは真', () => {
  const b = tree([['a'], ['b'], ['v', 'divider'], ['c'], ['h', 'heading', { level: 2, citeState: 'manual' }], ['d'],
    ['th', 'heading', { level: 1, toggle: true }], ['e'], ['ai', 'heading', { level: 2 }], ['hm', 'heading', { level: 3, citeState: 'manual' }],
    ['tha', 'heading', { level: 2, toggle: true }], ['tg', 'toggle', {}, [['k1'], ['k2']]]]);
  const T = (id) => BT.canIndent(b, id);
  assert.strictEqual(T('a'), false, '前の兄弟が無い');
  assert.strictEqual(T('b'), true);
  assert.strictEqual(T('v'), true, '区切り線そのものは子になれる');
  assert.strictEqual(T('c'), false, '前が区切り線');
  assert.strictEqual(T('h'), true, '人の見出しは子になれる');
  assert.strictEqual(T('d'), false, '前がトグルでない見出し');
  assert.strictEqual(T('e'), true, '前がトグル見出し');
  assert.strictEqual(T('ai'), false, 'AI の節の見出し（TQ2）');
  assert.strictEqual(T('hm'), false, '前が AI の見出し（トグルでない見出し）');
  assert.strictEqual(T('tha'), false, '前がトグルでない見出し');
  assert.strictEqual(T('tg'), true, '前がトグル見出し');
  assert.strictEqual(T('k1'), false, '子の頭');
  assert.strictEqual(T('k2'), true);
  assert.strictEqual(T('zz'), false);
  // 2026-10-28 の点検 A（持ち主の答え「トグル見出しにしても字下げしない（おすすめ）」）: AI の節の見出しはトグル見出しに変えても子にしない。
  // 人が足したトグル見出し（citeState: 'manual'）は今までどおり子にできる
  const th = tree([['x'], ['ath', 'heading', { level: 2, toggle: true }], ['hth', 'heading', { level: 2, toggle: true, citeState: 'manual' }]]);
  assert.strictEqual(BT.canIndent(th, 'ath'), false, 'AI の節の見出しをトグル見出しにすると子にできる（節の行がまとめて別の節へ跳ぶ）');
  assert.strictEqual(BT.canIndent(th, 'hth'), true, '人が足したトグル見出しは子にできる');
  for (const [blk, want] of [[{ type: 'heading', level: 2 }, true], [{ type: 'heading', toggle: true }, true], [{ type: 'heading', toggle: true, citeState: 'manual' }, false],
    [{ type: 'heading', citeState: 'manual' }, false], [{ type: 'bullet' }, false]]) {
    assert.strictEqual(BT.aiSectionHead(blk), want, JSON.stringify(blk));
  }
  for (const [blk, want] of [[{ type: 'paragraph' }, true], [{ type: 'bullet' }, true], [{ type: 'todo' }, true], [{ type: 'numbered' }, true], [{ type: 'toggle' }, true],
    [{ type: 'heading', toggle: true, level: 2 }, true], [{ type: 'quote' }, true], [{ type: 'callout' }, true], [{ type: 'heading' }, false], [{ type: 'divider' }, false], [{ type: 'video' }, true]]) {
    assert.strictEqual(BT.kidsCan(blk), want, JSON.stringify(blk));
  }
});

test('NE-1: indentPlan の in は前の兄弟の子の末尾、out は親のすぐ後ろ（親の後ろの兄弟は付いてこない）。最上位の out・できない in は null', () => {
  const b = tree([['a', 'bullet', {}, [['a1'], ['a2', 'bullet', {}, [['a21']]]]], ['b'], ['c'], ['v', 'divider'], ['d']]);
  assert.deepStrictEqual(BT.indentPlan(b, 'b', 'in'), { parentId: 'a', afterId: 'a2' });
  assert.deepStrictEqual(BT.indentPlan(b, 'c', 'in'), { parentId: 'b', afterId: '' });
  assert.strictEqual(BT.indentPlan(b, 'a', 'in'), null);
  assert.strictEqual(BT.indentPlan(b, 'd', 'in'), null);
  assert.deepStrictEqual(BT.indentPlan(b, 'a1', 'out'), { parentId: null, afterId: 'a' });
  assert.deepStrictEqual(BT.indentPlan(b, 'a21', 'out'), { parentId: 'a', afterId: 'a2' });
  assert.strictEqual(BT.indentPlan(b, 'b', 'out'), null);
  assert.strictEqual(BT.indentPlan(b, 'zz', 'in'), null);
  assert.strictEqual(BT.indentPlan(b, 'b', 'up'), null);
});

test('NE-1・NR6: spotOf は afterId が行なら同じ親のすぐ後ろ、\'\' と parentId は親の子の頭、parentId が無ければ最上位の頭。違う親・子を持てない親・無い行は null', () => {
  const b = tree([['a', 'bullet', {}, [['a1'], ['a2']]], ['h', 'heading', { level: 2 }], ['c']]);
  const S = (after, parent) => { const s = BT.spotOf(b, after, parent); return s && [s.list === b ? 'top' : s.parent.id, s.index]; };
  assert.deepStrictEqual(S('a1'), ['a', 1]);
  assert.deepStrictEqual(S('a1', 'a'), ['a', 1]);
  assert.strictEqual(S('a1', 'c'), null, '違う親');
  assert.strictEqual(S('a', 'c'), null, '最上位の行に親を添えた');
  assert.deepStrictEqual(S('c'), ['top', 3]);
  assert.deepStrictEqual(S(''), ['top', 0]);
  assert.deepStrictEqual(S('', 'a'), ['a', 0]);
  assert.deepStrictEqual(S('', 'c'), ['c', 0], '子の無い行の頭（children を作る）');
  assert.strictEqual(S('', 'h'), null, '子を持てない型');
  assert.strictEqual(S('zz'), null);
  assert.strictEqual(S('', 'zz'), null);
  assert.strictEqual(BT.within(b[0], 'a2'), true);
  assert.strictEqual(BT.within(b[0], 'c'), false);
});

// ---------------------------------------------------------------- 番号・見える順（F50・決めたこと 29）
test('NE-1・F50: numberLabelsTree は親ごとに数える（字下げした番号付きは 1 から・親の後の番号付きは続き）', () => {
  const b = tree([['n1', 'numbered'], ['n2', 'numbered', {}, [['m1', 'numbered'], ['m2', 'numbered'], ['x', 'bullet'], ['m3', 'numbered']]], ['n3', 'numbered'],
    ['t', 'toggle', { open: false }, [['k1', 'numbered']]], ['n4', 'numbered']]);
  assert.deepStrictEqual([...BT.numberLabelsTree(b).entries()],
    [['n1', '1.'], ['n2', '2.'], ['n3', '3.'], ['n4', '1.'], ['m1', '1.'], ['m2', '2.'], ['m3', '1.'], ['k1', '1.']]);
  assert.deepStrictEqual([...BT.numberLabelsTree(undefined).entries()], []);
});

test('NE-1: visibleOrder は閉じたトグル（openView が偽）の子孫を飛ばす。開いたトグルの子は段つき', () => {
  const b = tree([['t1', 'toggle', { open: false }, [['k1', 'bullet', {}, [['g1']]]]], ['t2', 'toggle', {}, [['k2']]],
    ['th', 'heading', { level: 1, toggle: true, open: false }, [['k3']]], ['bl', 'bullet', { open: false }, [['k4']]]]);
  const V = (o) => BT.visibleOrder(b, o).map((x) => [x.b.id, x.depth, x.parentId]);
  assert.deepStrictEqual(V(), [['t1', 0, null], ['t2', 0, null], ['k2', 1, 't2'], ['th', 0, null], ['bl', 0, null], ['k4', 1, 'bl']]);
  assert.deepStrictEqual(V(() => true).map((x) => x[0]), ['t1', 'k1', 'g1', 't2', 'k2', 'th', 'k3', 'bl', 'k4']);
  assert.deepStrictEqual(V((x) => x.id !== 't2').map((x) => x[0]), ['t1', 'k1', 'g1', 't2', 'th', 'k3', 'bl', 'k4']);
});

test('NE-1・TQ4: isOpenStored は open の無いトグルを開いた形にする（新しいトグルは開いている）。open: false だけ閉じる。トグルでない行はいつも開く', () => {
  for (const [blk, want] of [[{ type: 'toggle' }, true], [{ type: 'toggle', open: true }, true], [{ type: 'toggle', open: false }, false],
    [{ type: 'heading', toggle: true }, true], [{ type: 'heading', toggle: true, open: false }, false], [{ type: 'heading', open: false }, true], [{ type: 'bullet', open: false }, true]]) {
    assert.strictEqual(BT.isOpenStored(blk), want, JSON.stringify(blk));
  }
  assert.strictEqual(BT.isToggle({ type: 'heading', toggle: true }), true);
  assert.strictEqual(BT.isToggle({ type: 'heading' }), false);
  assert.deepStrictEqual([...BT.VIEW_KEYS], ['open']);
});

// ---------------------------------------------------------------- 結合と変換の子（EQ6 (a)・EQ16 (a)・NR10）
test('NE-1・EQ6 (a): mergeKids は結合した行の子をつないだ先の子の末尾へ。つないだ先がトグルでない見出しなら後ろの兄弟へ', () => {
  let b = tree([['a', 'bullet', {}, [['a1']]], ['x', 'paragraph', {}, [['x1'], ['x2']]]]);
  let kids = b[1].children; b.splice(1, 1);
  BT.mergeKids(BT.locate(b, 'a1'), kids);
  assert.deepStrictEqual(shape(b), [['a', [['a1', ['x1', 'x2']]]]]);
  b = tree([['h', 'heading', { level: 2 }], ['y'], ['x', 'paragraph', {}, [['x1'], ['x2']]]]);
  kids = b[2].children; b.splice(2, 1);
  BT.mergeKids(BT.locate(b, 'h'), kids);
  assert.deepStrictEqual(shape(b), ['h', 'x1', 'x2', 'y']);
  b = tree([['p']]);
  BT.mergeKids(BT.locate(b, 'p'), []);
  assert.deepStrictEqual(shape(b), ['p']);
});

test('NE-1・EQ16 (a)・NR10: トグルをテキストに・トグル見出しを見出しに変えると kidsOut で子がすぐ後ろに元の順で並ぶ。箇条書き → 番号付きでは子が残る', () => {
  const M = (b, to) => BT.turnMovesKids(b, to);
  assert.strictEqual(M({ type: 'toggle' }, { type: 'paragraph' }), true, 'トグル → テキスト（EQ16 (a)）');
  assert.strictEqual(M({ type: 'heading', toggle: true, level: 1 }, { type: 'paragraph' }), true, 'トグル見出し → テキスト');
  assert.strictEqual(M({ type: 'heading', toggle: true, level: 1 }, { type: 'heading', level: 1 }), true, 'トグル見出し → 見出し（子を持てない: NR10）');
  assert.strictEqual(M({ type: 'bullet' }, { type: 'heading', level: 2 }), true, '見出しへ');
  assert.strictEqual(M({ type: 'bullet' }, { type: 'numbered' }), false, '箇条書き → 番号付き');
  assert.strictEqual(M({ type: 'toggle' }, { type: 'bullet' }), false, 'トグル → 箇条書き（子を持てる）');
  assert.strictEqual(M({ type: 'bullet' }, { type: 'toggle' }), false);
  assert.strictEqual(M({ type: 'heading', level: 2 }, { type: 'heading', level: 2, toggle: true }), false, '見出し → トグル見出し');
  assert.strictEqual(M({ type: 'paragraph' }, { type: 'quote' }), false);
  const b = tree([['t', 'toggle', {}, [['k1'], ['k2', 'bullet', {}, [['g']]]]], ['n']]);
  const out = BT.kidsOut(b, 0);
  assert.deepStrictEqual(out.map((x) => x.id), ['k1', 'k2']);
  assert.deepStrictEqual(shape(b), ['t', 'k1', ['k2', ['g']], 'n']);
  assert.deepStrictEqual(BT.kidsOut(b, 3), []);
});

// ---------------------------------------------------------------- 落とす段（NR12・TQ2）
test('NE-1・NR12: dropSpot の表（上の行と同じ段・右へずらして上の行の子の頭・子を持てない行の右は同じ段・左へずらして下の行の段まで浅く・いちばん上は最上位の頭）', () => {
  // 見えている行（動かす行を除く）: a(0) a1(1) a2(1) h(0・子を持てない) b(0)
  const rows = [{ id: 'a', depth: 0, parentId: null, kids: true }, { id: 'a1', depth: 1, parentId: 'a', kids: true }, { id: 'a2', depth: 1, parentId: 'a', kids: true },
    { id: 'h', depth: 0, parentId: null, kids: false }, { id: 'b', depth: 0, parentId: null, kids: true }];
  const D = (idx, shift, o) => BT.dropSpot(rows, idx, shift, o);
  assert.deepStrictEqual(D(0, 0), { parentId: null, afterId: '' }, 'いちばん上は最上位の頭（R28）');
  assert.deepStrictEqual(D(0, 3), { parentId: null, afterId: '' });
  assert.deepStrictEqual(D(1, 0), { parentId: 'a', afterId: '' }, '親と最初の子の間は子の頭だけ');
  assert.deepStrictEqual(D(1, -2), { parentId: 'a', afterId: '' });
  assert.deepStrictEqual(D(2, 0), { parentId: 'a', afterId: 'a1' }, '上の行と同じ段');
  assert.deepStrictEqual(D(2, 1), { parentId: 'a1', afterId: '' }, '右へずらすと上の行の子の頭');
  assert.deepStrictEqual(D(2, 5), { parentId: 'a1', afterId: '' }, 'ずらしすぎても1段だけ');
  assert.deepStrictEqual(D(3, 0), { parentId: 'a', afterId: 'a2' }, '子の後ろで同じ段');
  assert.deepStrictEqual(D(3, -1), { parentId: null, afterId: 'a' }, '子の後ろで左へずらすと親の段（edn-drop-depth）');
  assert.deepStrictEqual(D(3, -4), { parentId: null, afterId: 'a' }, '下の行の段より浅くはならない');
  assert.deepStrictEqual(D(4, 1), { parentId: null, afterId: 'h' }, '子を持てない行の右は同じ段');
  assert.deepStrictEqual(D(5, 1), { parentId: 'b', afterId: '' }, 'いちばん下で右へ');
  assert.deepStrictEqual(D(5, 0), { parentId: null, afterId: 'b' });
  // TQ2: AI の節の見出しは右へずらしても子にならない（最上位のまま）
  assert.deepStrictEqual(D(2, 1, { top: true }), { parentId: null, afterId: 'a' });
  assert.deepStrictEqual(D(5, 1, { top: true }), { parentId: null, afterId: 'b' });
  assert.deepStrictEqual(BT.dropSpot([], 0, 1), { parentId: null, afterId: '' });
});

// ---------------------------------------------------------------- 型の表のトグルとトグル見出し（E5・NR5・EQ10 (a)・NR21）
test('NE-1・NR5: MENU_ROWS は型の表の th から th1〜th3 を作る（段・toggle・名前・語）。MENU_KEYS は 14（toggle・th1〜th3 を足す）。TYPE_KEYS に toggle。recentCheck は toggle・th1 を残す', () => {
  assert.strictEqual(E.BLOCK_TYPES.length, 12, '型の表は 12 行のまま');
  assert.deepStrictEqual(E.VERSION_ROWS.map((r) => r.id), E.BLOCK_TYPES.map((r) => r.id), '0.13.1 は型の表の全部');
  assert.deepStrictEqual([...E.MENU_KEYS], ['text', 'h1', 'h2', 'h3', 'todo', 'bullet', 'numbered', 'toggle', 'th1', 'th2', 'th3', 'quote', 'divider', 'callout']);
  const th = E.BLOCK_TYPES.find((r) => r.id === 'th');
  for (const lv of [1, 2, 3]) {
    const r = E.MENU_ROWS.find((x) => x.id === `th${lv}`);
    assert.strictEqual(r.key, 'heading'); assert.strictEqual(r.level, lv); assert.strictEqual(r.toggle, true);
    assert.strictEqual(r.label, `トグル見出し${lv}`);
    assert.deepStrictEqual([...r.words], [...th.words]);
    assert.deepStrictEqual([...r.md], []);
    assert.strictEqual(r.kids, true);
  }
  assert.deepStrictEqual(E.MENU_ROWS.filter((r) => !/^th\d$/.test(r.id)).map((r) => r.id), E.BLOCK_TYPES.filter((r) => r.id !== 'th').map((r) => r.id));
  assert.deepStrictEqual([...E.TYPE_KEYS], ['paragraph', 'heading', 'todo', 'bullet', 'numbered', 'toggle', 'quote', 'divider', 'callout']);
  assert.deepStrictEqual(E.recentCheck(['toggle', 'th1', 'quote', 'th']), ['toggle', 'th1', 'quote'], '覚えた toggle・th1 が落ちる（edn-menu-keys）');
  assert.deepStrictEqual(E.recentAdd(['h2'], 'th3'), ['th3', 'h2']);
  const ids2 = (q) => E.slashFilter(q, []).map((i) => i.id);
  assert.deepStrictEqual(ids2('とぐる'), ['toggle', 'th1', 'th2', 'th3']);
  assert.deepStrictEqual(ids2('とぐるみだし'), ['th1', 'th2', 'th3']);
  assert.deepStrictEqual(ids2('みだし'), ['h1', 'h2', 'h3', 'th1', 'th2', 'th3'], '「みだし」は「とぐるみだし」にも当たる');
  assert.deepStrictEqual(ids2('toggle'), ['toggle', 'th1', 'th2', 'th3']);
  assert.deepStrictEqual(ids2(''), [...E.MENU_KEYS]);
});

test('NE-1・EQ10 (a): shortcutFor(\'> \') はトグル（全角の『＞　』も: EQ9 (a)）。typeOf はトグル・トグル見出しの段', () => {
  assert.deepStrictEqual(E.shortcutFor('> '), { type: 'toggle', strip: 2 });
  assert.deepStrictEqual(E.shortcutFor('＞　'), { type: 'toggle', strip: 2 });
  assert.deepStrictEqual(E.shortcutFor('＞ '), { type: 'toggle', strip: 2 });
  assert.strictEqual(E.shortcutFor('>'), null);
  assert.strictEqual(E.shortcutFor('>> '), null);
  assert.deepStrictEqual(E.shortcutFor('" '), { type: 'quote', strip: 2 }, '" は引用のまま');
  assert.strictEqual(E.typeOf({ type: 'toggle' }).id, 'toggle');
  assert.strictEqual(E.typeOf({ type: 'heading', toggle: true, level: 1 }).id, 'th1');
  assert.strictEqual(E.typeOf({ type: 'heading', toggle: true, level: 3 }).id, 'th3');
  assert.strictEqual(E.typeOf({ type: 'heading', toggle: true }).id, 'th2', '段の無いトグル見出しは段 2');
  assert.strictEqual(E.typeOf({ type: 'heading', level: 1 }).id, 'h1');
  assert.strictEqual(E.isTyped({ type: 'toggle' }), true);
});

test('NE-1・NR21: keyAction は Ctrl+Shift+7（code Digit7・key "\'"）→ turn:toggle、Ctrl+Alt+T（code KeyT）→ openAll、Ctrl+Alt+V・Ctrl+Alt+Shift+T・変換中 → null', () => {
  const K = (o) => E.keyAction({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, isComposing: false, key: '', code: '', ...o });
  assert.strictEqual(K({ ctrlKey: true, shiftKey: true, code: 'Digit7', key: "'" }), 'turn:toggle');
  assert.strictEqual(K({ ctrlKey: true, altKey: true, code: 'KeyT', key: 't' }), 'openAll');
  assert.strictEqual(K({ ctrlKey: true, altKey: true, code: 'KeyT', key: '†' }), 'openAll', 'key でなく code で見る');
  for (const o of [{ ctrlKey: true, altKey: true, code: 'KeyV', key: 'v' }, { ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyT', key: 'T' },
    { ctrlKey: true, altKey: true, code: 'KeyT', key: 't', isComposing: true }, { ctrlKey: true, altKey: true, code: 'KeyT', key: 't', keyCode: 229 },
    { ctrlKey: true, altKey: true, metaKey: true, code: 'KeyT', key: 't' }, { altKey: true, code: 'KeyT', key: 't' }, { ctrlKey: true, code: 'KeyT', key: 't' },
    { ctrlKey: true, altKey: true, shiftKey: true, code: 'Digit7', key: "'" }, { ctrlKey: true, code: 'Tab', key: 'Tab' }]) {
    assert.strictEqual(K(o), null, JSON.stringify(o));
  }
});

test('NE-1・EQ5 (a): nextTypeOnEnter は字下げされた空の箇条書き・ToDo・番号付きで \'outdent\'、最上位なら \'revert\'。TQ3: 開いたトグルの後はテキスト（最初の子）、閉じたトグルの後はトグル', () => {
  const N = (b, o) => E.nextTypeOnEnter(b, o);
  for (const t of ['bullet', 'todo', 'numbered']) {
    assert.strictEqual(N({ type: t }, { empty: true, depth: 1 }), 'outdent', t);
    assert.strictEqual(N({ type: t }, { empty: true, depth: 0 }), 'revert', t);
    assert.deepStrictEqual(N({ type: t }, { depth: 2 }), { type: t }, t);
  }
  assert.deepStrictEqual(N({ type: 'toggle' }, { open: true }), { type: 'paragraph' }, '開いたトグルの中はテキスト');
  assert.deepStrictEqual(N({ type: 'toggle' }), { type: 'paragraph' }, '開け閉めを渡さなければ開いている');
  assert.deepStrictEqual(N({ type: 'toggle' }, { open: false }), { type: 'toggle' }, '閉じたトグルの後はトグル');
  assert.deepStrictEqual(N({ type: 'heading', toggle: true, level: 1 }, { open: true }), { type: 'paragraph' });
  assert.deepStrictEqual(N({ type: 'heading', toggle: true, level: 3 }, { open: false }), { type: 'heading', level: 3, toggle: true }, '閉じたトグル見出しの後は同じ段のトグル見出し（NR25）');
  assert.deepStrictEqual(N({ type: 'heading', level: 1 }, { open: false }), { type: 'bullet' }, '見出しは EQ5 (a) のまま');
  assert.deepStrictEqual(N({ type: 'bullet' }, { open: true }), { type: 'bullet' }, '子の見える箇条書きの最初の子は箇条書き');
});

test('NE-1・決めたこと 22・NR20: blocksMarkdown は子を段ごとに2つの空白で下げ、閉じたトグルの子も写し、トグルは『- 』。子の無い並びは 0.13.0 の表と1文字も同じ', () => {
  const b = tree([['h', 'heading', { level: 2, text: '決定事項' }], ['b', 'bullet', { text: '親' }, [['c', 'bullet', { text: '子' }, [['g', 'todo', { text: '孫', checked: true }]]], ['n1', 'numbered', { text: '一' }], ['n2', 'numbered', { text: '二\n続き' }]]],
    ['t', 'toggle', { text: '閉じた', open: false }, [['k', 'paragraph', { text: '中' }]]], ['th', 'heading', { level: 3, toggle: true, text: 'トグル見出し' }, [['k2', 'bullet', { text: '下' }]]], ['n3', 'numbered', { text: '三' }]]);
  assert.strictEqual(E.blocksMarkdown(b), [
    '\n## 決定事項', '- 親', '  - 子', '    - [x] 孫', '  1. 一', '  2. 二\n    続き', '- 閉じた', '  中', '\n### トグル見出し', '  - 下', '1. 三'].join('\n'));
  // 子の無い並び（0.13.0 の表）は前と同じ
  const flat = [{ id: 'h1', type: 'heading', level: 1, text: '一' }, { id: 'n1', type: 'numbered', text: 'a' }, { id: 'x', type: 'bullet', text: 'c\nd' }, { id: 'q', type: 'quote', text: 'f' },
    { id: 'v', type: 'divider', text: '' }, { id: 'c', type: 'callout', text: 'g' }, { id: 'z', type: 'video', text: 'h' }, { id: 'e', type: 'todo', text: 'やる', checked: false }];
  assert.strictEqual(E.blocksMarkdown(flat), '\n# 一\n1. a\n- c\n  d\n> f\n---\n> 💡 g\nh\n- [ ] やる');
  assert.strictEqual(E.blocksMarkdown(flat.map((x) => ({ ...x, children: [] }))), E.blocksMarkdown(flat));
});
