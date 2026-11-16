/* stage170.notion.app.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の第4部（実機との違いの直し。決めたこと 78〜87・F205〜F214）の画面
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせ、命令は本物の preload から一時の DB に本当に通す（helpers/realapp.js）。
 * Notion の動きは docs/plans/notion-behavior.md の項目番号（X-16〜X-34・B-24〜B-26・D-09〜D-11・T-06・P-08）で指す。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { realApp, APP } = require('./helpers/realapp');
const { samplePage } = require('./helpers/dbtmp');
const BT = require('../src/blockTree');
const E = require('../src/blockEdit');
const MD = require('../src/memoDoc');

const HTML = fs.readFileSync(APP, 'utf8');
const T = { timeout: 60000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const fnApp = (name) => {
  const at = HTML.indexOf(`  function ${name}(`);
  assert.ok(at > 0, `app.html に ${name} が無い`);
  return HTML.slice(at, HTML.indexOf('\n  }\n', at) + 4);
};
const kid = (id, o = {}) => ({ id, type: 'paragraph', text: `${id}の文`, citeState: 'manual', cites: [], ...o });
// 議事録のページ（要約の欄）を種にして開く
async function openNote(blocks) {
  const l = await realApp({ seed: (t) => { const { page, segments } = samplePage('pa1'); t.seed({ ...page, blocks }, segments); } });
  l.fire('onPageOpen', 'pa1'); await l.drain(120);
  return l;
}
const rowsOf = (l) => $(l, 'pNote').querySelectorAll('.blk');
const rowOf = (l, id) => rowsOf(l).find((e) => e.dataset.id === id);
const txtOf = (l, id) => rowOf(l, id).querySelector('.txt');
const EDIT = ['blockSplit', 'blockMerge', 'blockTurnInto', 'blockInsert', 'blockRemove', 'blockUpdate', 'blockMove', 'blockIndent', 'blockPaste'];
const sent = (l) => l.calls.filter((c) => EDIT.includes(c.method)).map((c) => [c.method, ...c.args]);
const pageOf = (l, id = 'pa1') => l.call('page.get', { id }).page;
function typeIn(l, id, text, at = text.length) {
  const t = txtOf(l, id);
  t.focus();
  t.textContent = text;
  l.caret.set(t, at);
  return t;
}
const press = async (l, el, key, o = {}) => { const ev = l.key({ key, ...o }, el); await l.drain(80); return ev; };
// 画面のメモの欄の写し（app.html の memoDocView）を src/memoDoc.js と同じ形で組む（stage140.app の MB-4（R150）と同じ組み方）
function memoView() {
  const seg = HTML.slice(HTML.indexOf('  // ---- memoDoc の写し'), HTML.indexOf('  // ---- memoDoc の写しはここまで'));
  const rt = HTML.slice(HTML.indexOf('  // ---- richText の写し'), HTML.indexOf('  // ---- richText の写しはここまで'));
  const tree = ['kidsCanView', 'isToggleView', 'aiSectionHead', 'locate', 'canIndent', 'flattenBlocks', 'headingLevel', 'numberLabels'].map(fnApp).join('\n');
  return new Function(`const CALLOUT_ICON = '💡';\n${tree}\n${fnApp('graphemeEnds')}\n${fnApp('safeOffset')}\n${rt}\n${seg}\nreturn memoDocView;`)();   // eslint-disable-line no-new-func
}
const sameMemo = (app, doc, cmd, args) => {
  const run = (x) => { try { return { ok: x.memoEdit(doc, cmd, args, { next: 40 }) }; } catch (e) { return { code: e.code }; } };
  assert.deepStrictEqual(run(app), run(MD), `${cmd} ${JSON.stringify(args)}`);
};

// ---------------------------------------------------------------- NX-1（決めたこと 78・79・F205）
test('NX-1・F205: 要約の欄の見出しの末尾・途中で Enter → blockSplit の1回で、新しい行はテキストで描かれ、カーソルはその行の頭（X-16）', T, async () => {
  const l = await openNote([kid('x'), { id: 'h', type: 'heading', level: 2, text: '決めたこと', citeState: 'manual', cites: [] }, kid('y')]);
  try {
    let t = typeIn(l, 'h', '決めたこと');
    await press(l, t, 'Enter');
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'h', '決めたこと', 5]]);
    let p = pageOf(l);
    let nb = p.blocks[2];
    assert.deepStrictEqual([nb.type, nb.text], ['paragraph', '']);
    assert.ok(rowOf(l, nb.id).classList.contains('paragraph') && !rowOf(l, nb.id).classList.contains('bullet'), '新しい行がテキストで描かれない');
    assert.strictEqual(l.document.activeElement, txtOf(l, nb.id));
    assert.deepStrictEqual(l.caret.get(txtOf(l, nb.id)), [0, 0]);
    // 途中: 後半はテキスト
    t = typeIn(l, 'h', '決めたこと', 2);
    await press(l, t, 'Enter');
    p = pageOf(l);
    nb = p.blocks[2];
    assert.deepStrictEqual([p.blocks[1].type, p.blocks[1].text, nb.type, nb.text], ['heading', '決め', 'paragraph', 'たこと']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-1・F205: 画面のメモの欄の写し（memoDocView）は src/memoDoc.js と同じ答えで、見出しの block.split の後ろはテキスト（末尾・途中・頭の上の行）', () => {
  const app = memoView();
  const doc = [{ id: 'm1', type: 'heading', level: 2, text: '目的', citeState: 'manual' }, { id: 'm2', type: 'heading', text: '古い見出し', citeState: 'manual' },
    { id: 'm3', type: 'heading', level: 1, toggle: true, text: 'トグル見出し', citeState: 'manual' }, { id: 'm4', type: 'callout', text: 'メモ', citeState: 'manual' }];
  for (const [id, text] of [['m1', '目的'], ['m2', '古い見出し'], ['m3', 'トグル見出し']]) {
    for (const at of [0, 1, text.length]) for (const inside of [undefined, true]) sameMemo(app, doc, 'block.split', { blockId: id, text, at, ...(inside ? { inside } : {}) });
  }
  sameMemo(app, doc, 'block.split', { blockId: 'm4', text: 'メモ', at: 2, inside: true });
  const r = app.memoEdit(doc, 'block.split', { blockId: 'm1', text: '目的', at: 2 }, { next: 40 });
  assert.deepStrictEqual(r.doc.slice(0, 2).map((b) => b.type), ['heading', 'paragraph'], '写しの見出しの後ろがテキストでない');
  for (const b of doc) for (const open of [true, false]) sameMemo(app, [b], 'block.split', { blockId: b.id, text: b.text, at: b.text.length, ...(open ? { inside: true } : {}) });
  assert.deepStrictEqual(E.nextTypeOnEnter({ type: 'heading', level: 2 }), { type: 'paragraph' });
});

test('NX-1・F205（S5・B-24・X-31）: コールアウトの文の末尾・途中で Enter → blockSplit（inside）の1回で、コールアウトの最初の子にテキストの行・カーソルはその行の頭。子のあるコールアウトも最初の子（U6）', T, async () => {
  const l = await openNote([kid('x'), { id: 'c', type: 'callout', icon: '💡', text: 'お知らせ', citeState: 'manual', cites: [] },
    { id: 'ck', type: 'callout', icon: '💡', text: '子あり', citeState: 'manual', cites: [], children: [kid('k1')] }, kid('y')]);
  try {
    let t = typeIn(l, 'c', 'お知らせ');
    await press(l, t, 'Enter');
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'c', 'お知らせ', 4, undefined, true]], 'コールアウトの末尾の Enter が inside で送られない');
    let c = BT.locate(pageOf(l).blocks, 'c').b;
    assert.deepStrictEqual(c.children.map((b) => [b.type, b.text]), [['paragraph', '']]);
    const nid = c.children[0].id;
    assert.strictEqual(l.document.activeElement, txtOf(l, nid));
    assert.deepStrictEqual(l.caret.get(txtOf(l, nid)), [0, 0]);
    assert.strictEqual(rowOf(l, nid).dataset.depth, '1', '新しい行がコールアウトの中に描かれない');
    // 途中
    t = typeIn(l, 'c', 'お知らせ', 2);
    await press(l, t, 'Enter');
    c = BT.locate(pageOf(l).blocks, 'c').b;
    assert.deepStrictEqual([c.text, c.children.map((b) => [b.type, b.text])], ['お知', [['paragraph', 'らせ'], ['paragraph', '']]]);
    // 子のあるコールアウト
    t = typeIn(l, 'ck', '子あり');
    await press(l, t, 'Enter');
    assert.deepStrictEqual(BT.locate(pageOf(l).blocks, 'ck').b.children.map((b) => [b.type, b.text]), [['paragraph', ''], ['paragraph', 'k1の文']]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-1（S12・B-26・OQ3「今のままチェックなし（おすすめ）」）: 文のある ToDo・箇条書きの頭で Enter → 上に同じ型の空の行・カーソルは元の行の頭。上の空の ToDo はチェックなしで、担当・期限・出典・タスクの印を写さない', T, async () => {
  const blocks = samplePage('pa1').page.blocks.map((b) => (b.id === 'b4' ? { ...b, checked: true } : b));
  const l = await openNote(blocks);
  try {
    let t = typeIn(l, 'b4', '見積書を月末までに先方へ送る', 0);
    await press(l, t, 'Enter');
    let p = pageOf(l);
    let i = p.blocks.findIndex((b) => b.id === 'b4');
    const nb = p.blocks[i - 1];
    assert.deepStrictEqual([nb.type, nb.text, nb.checked, nb.assignee, nb.due, nb.cites, nb.task], ['todo', '', false, undefined, undefined, [], undefined]);
    assert.strictEqual(l.document.activeElement, txtOf(l, 'b4'));
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'b4')), [0, 0]);
    t = typeIn(l, 'b2', '来月の予算案の作成を担当Aが進める', 0);
    await press(l, t, 'Enter');
    p = pageOf(l);
    i = p.blocks.findIndex((b) => b.id === 'b2');
    assert.deepStrictEqual([p.blocks[i - 1].type, p.blocks[i - 1].text], ['bullet', '']);
    assert.strictEqual(l.document.activeElement, txtOf(l, 'b2'));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- NX-2（決めたこと 80・81・F206・F207）
test('NX-2・F206: 画面の写し backspaceAtStartView は src/blockEdit.js の backspaceAtStart と同じ答え（全部の型 × 段 × last × inCallout）', () => {
  const head = HTML.slice(HTML.indexOf('  const TYPED_VIEW = '), HTML.indexOf('\n', HTML.indexOf('  const TYPED_VIEW = ')) + 1);
  const app = new Function(`${head}${fnApp('isTypedView')}\n${fnApp('backspaceAtStartView')}\nreturn backspaceAtStartView;`)();   // eslint-disable-line no-new-func
  const blocks = [null, {}, { type: 'paragraph' }, { type: 'video' }, { type: 'divider' }, { type: 'subpage', page: 'pk1' }, { type: 'dbview' }, { type: 'callout' }, { type: 'quote' }, { type: 'toggle' },
    { type: 'bullet' }, { type: 'todo' }, { type: 'numbered' }, { type: 'heading' }, { type: 'heading', level: 1 }, { type: 'heading', level: 3, toggle: true }, { type: 'heading', level: 2, toggle: true, open: false }];
  for (const b of blocks) for (const depth of [0, 1, 2]) for (const last of [true, false]) for (const inCallout of [true, false]) {
    assert.strictEqual(app(b, { depth, last, inCallout }), E.backspaceAtStart(b, { depth, last, inCallout }), `${JSON.stringify(b)} ${depth} ${last} ${inCallout}`);
  }
  assert.strictEqual(app({ type: 'heading', level: 2 }), E.backspaceAtStart({ type: 'heading', level: 2 }), '引数を渡さないとき');
});

const H2 = (id, text, o = {}) => ({ id, type: 'heading', level: 2, text, citeState: 'manual', cites: [], ...o });
test('NX-2・F206（S1・S2・S5・X-17・D-09・T-06・B-24）: 見出し・トグル見出し・コールアウトの頭の Backspace', T, async () => {
  const l = await openNote([kid('x'), H2('h', '見出し'),
    { id: 't', type: 'toggle', text: 'トグル', open: true, citeState: 'manual', cites: [], children: [kid('t1'), H2('th', '中の見出し')] },
    H2('tg', 'トグル見出し', { toggle: true, open: true, children: [kid('g1'), kid('g2')] }),
    { id: 'c', type: 'callout', icon: '💡', text: 'お知らせ', citeState: 'manual', cites: [] }, kid('z')]);
  try {
    // 最上位の見出し: テキストに戻さず1回でつなぐ（blockTurnInto を送らない）
    await press(l, typeIn(l, 'h', '見出し', 0), 'Backspace');
    assert.deepStrictEqual(sent(l), [['blockMerge', 'pa1', 'h', '見出し', 'x']]);
    assert.strictEqual(BT.locate(pageOf(l).blocks, 'x').b.text, 'xの文見出し');
    assert.strictEqual(l.document.activeElement, txtOf(l, 'x'));
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'x')), [3, 3], 'カーソルが上の行のつないだ所でない');
    // トグルの最後の子の見出し: 1回目は見出しのまま1段戻り、2回目でつなぐ（S1）
    l.calls.length = 0;
    await press(l, typeIn(l, 'th', '中の見出し', 0), 'Backspace');
    assert.deepStrictEqual(sent(l), [['blockIndent', 'pa1', 'th', 'out']]);
    assert.deepStrictEqual([BT.locate(pageOf(l).blocks, 'th').b.type, BT.locate(pageOf(l).blocks, 'th').parent], ['heading', null], '見出しのまま1段戻らない');
    l.calls.length = 0;
    await press(l, typeIn(l, 'th', '中の見出し', 0), 'Backspace');
    assert.deepStrictEqual(sent(l).map((c) => c.slice(0, 3)), [['blockMerge', 'pa1', 'th']], '2回目でつながない');
    // 開いたトグル見出し: 1回目でふつうの見出しになり、中の行は後ろへ（S2）・2回目でつなぐ
    l.calls.length = 0;
    await press(l, typeIn(l, 'tg', 'トグル見出し', 0), 'Backspace');
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 'tg', 'heading', 2]]);
    let p = pageOf(l);
    const i = p.blocks.findIndex((b) => b.id === 'tg');
    assert.deepStrictEqual([p.blocks[i].toggle, p.blocks[i].children || [], p.blocks.slice(i + 1, i + 3).map((b) => b.id)], [undefined, [], ['g1', 'g2']], 'トグル見出しの中の行が後ろに並ばない');
    l.calls.length = 0;
    await press(l, typeIn(l, 'tg', 'トグル見出し', 0), 'Backspace');
    assert.deepStrictEqual(sent(l).map((c) => c.slice(0, 3)), [['blockMerge', 'pa1', 'tg']]);
    // コールアウトの頭: 1回でつなぐ（S5）
    l.calls.length = 0;
    await press(l, typeIn(l, 'c', 'お知らせ', 0), 'Backspace');
    assert.deepStrictEqual(sent(l).map((c) => c.slice(0, 3)), [['blockMerge', 'pa1', 'c']]);
    p = pageOf(l);
    assert.ok(!p.blocks.some((b) => b.id === 'c'), 'コールアウトが残った');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-2・F206（S5・B-24）: コールアウトの末尾の Enter でできた空の子の Backspace → blockMerge で行が消え、カーソルはコールアウトの字の末', T, async () => {
  const l = await openNote([kid('x'), { id: 'c', type: 'callout', icon: '💡', text: 'お知らせ', citeState: 'manual', cites: [] }, kid('z')]);
  try {
    await press(l, typeIn(l, 'c', 'お知らせ'), 'Enter');
    const nid = BT.locate(pageOf(l).blocks, 'c').b.children[0].id;
    l.calls.length = 0;
    await press(l, typeIn(l, nid, '', 0), 'Backspace');
    assert.deepStrictEqual(sent(l), [['blockMerge', 'pa1', nid, '', 'c']], '空の子が1段戻った・つながない');
    const c = BT.locate(pageOf(l).blocks, 'c').b;
    assert.deepStrictEqual([c.text, (c.children || []).length], ['お知らせ', 0]);
    assert.strictEqual(l.document.activeElement, txtOf(l, 'c'));
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'c')), [4, 4]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-2・F206（X-18・D-10・D-11）: 字下げした箇条書きはテキスト → 1段戻す → つなぐ の順。字下げしたテキストは、最後の子なら1段戻し、後ろに兄弟があれば上に見えている行につなぐ', T, async () => {
  const l = await openNote([kid('P', { children: [kid('a', { children: [kid('a1')] }), kid('m'), { id: 'lb', type: 'bullet', text: '最後', citeState: 'manual', cites: [] }] }), kid('z')]);
  try {
    // 真ん中の子のテキスト: 上に見えている行（a1）につなぐ（S4）
    await press(l, typeIn(l, 'm', 'mの文', 0), 'Backspace');
    assert.deepStrictEqual(sent(l), [['blockMerge', 'pa1', 'm', 'mの文', 'a1']]);
    // 最後の子の箇条書き: テキストに戻す → 1段戻す → つなぐ
    l.calls.length = 0;
    await press(l, typeIn(l, 'lb', '最後', 0), 'Backspace');
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 'lb', 'paragraph']]);
    l.calls.length = 0;
    await press(l, typeIn(l, 'lb', '最後', 0), 'Backspace');
    assert.deepStrictEqual(sent(l), [['blockIndent', 'pa1', 'lb', 'out']]);
    l.calls.length = 0;
    await press(l, typeIn(l, 'lb', '最後', 0), 'Backspace');
    assert.deepStrictEqual(sent(l).map((c) => c.slice(0, 3)), [['blockMerge', 'pa1', 'lb']]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-2・F207: 画面のメモの欄の写し（memoDocView）の block.merge は src/memoDoc.js と同じ答えで、消える行の子は消えた行の所に1段上がって並ぶ', () => {
  const app = memoView();
  const doc = [{ id: 'm1', type: 'toggle', text: '親', citeState: 'manual', children: [{ id: 'm2', type: 'paragraph', text: '中', citeState: 'manual' }] },
    { id: 'm3', type: 'paragraph', text: 'つなぐ', citeState: 'manual', children: [{ id: 'm4', type: 'todo', text: 'やる', checked: true, citeState: 'manual' }, { id: 'm5', type: 'paragraph', text: '二', citeState: 'manual', children: [{ id: 'm6', type: 'paragraph', text: '孫', citeState: 'manual' }] }] },
    { id: 'm7', type: 'heading', level: 2, text: '見出し', citeState: 'manual' }, { id: 'm8', type: 'paragraph', text: '下', citeState: 'manual', children: [{ id: 'm9', type: 'paragraph', text: '下の子', citeState: 'manual' }] }];
  for (const [blockId, text, intoId] of [['m3', 'つなぐ', 'm2'], ['m3', 'つなぐ', 'm1'], ['m8', '下', 'm7'], ['m8', '下', undefined], ['m5', '二', 'm4']]) {
    sameMemo(app, doc, 'block.merge', { blockId, text, ...(intoId ? { intoId } : {}) });
  }
  const r = app.memoEdit(doc, 'block.merge', { blockId: 'm3', text: 'つなぐ', intoId: 'm2' }, { next: 40 });
  assert.deepStrictEqual(r.doc.map((b) => b.id), ['m1', 'm4', 'm5', 'm7', 'm8'], '写しの子が消えた行の所に並ばない');
});

// ---------------------------------------------------------------- NX-3（決めたこと 82・F208・計画の違いの行 X-20・P-08）
const selIds = (l, box = 'pNote') => $(l, box).querySelectorAll('.blk').filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.dataset.id);
const CTRL_A = { key: 'a', code: 'KeyA', ctrlKey: true };
test('NX-3・F208: Ctrl+A の1回目は既定（止めない・行を選ばない）・文字が全部選ばれた行で押すと、その欄の全部の行・空の行は1回目で全部の行（S6）・選んでいる間は今どおり全部', T, async () => {
  const l = await openNote([kid('p1'), kid('p2'), { id: 't', type: 'toggle', text: 'トグル', open: true, citeState: 'manual', cites: [], children: [kid('t1')] }, kid('e', { text: '' })]);
  try {
    let t = typeIn(l, 'p2', 'p2の文', 1);
    assert.strictEqual(l.key(CTRL_A, t).defaultPrevented, false, '1回目の Ctrl+A を止めた');
    assert.deepStrictEqual(selIds(l), []);
    t = txtOf(l, 'p2'); t.focus(); l.caret.set(t, 0, 4);
    assert.strictEqual(l.key(CTRL_A, t).defaultPrevented, true);
    assert.deepStrictEqual(selIds(l), ['p1', 'p2', 't', 't1', 'e'], '文字が全部選ばれた行の Ctrl+A でページの行を全部選ばない（その行だけの段が残る）');
    assert.strictEqual(l.key(CTRL_A, $(l, 'pNote')).defaultPrevented, true);
    assert.deepStrictEqual(selIds(l), ['p1', 'p2', 't', 't1', 'e'], '選んでいる間の Ctrl+A');
    l.key({ key: 'Escape' }, $(l, 'pNote'));
    t = typeIn(l, 'e', '', 0);
    assert.strictEqual(l.key(CTRL_A, t).defaultPrevented, true);
    assert.deepStrictEqual(selIds(l), ['p1', 'p2', 't', 't1', 'e'], '空の行の Ctrl+A の1回目でページの行を全部選ばない（S6・P-08）');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-3・F208: メモの欄の行で Ctrl+A → メモの欄の行だけを全部選ぶ（要約の欄の行は選ばない）', T, async () => {
  const l = await realApp({ seed: (t) => { const { page, segments } = samplePage('pa1'); t.seed({ ...page, blocks: [kid('p1'), kid('p2')], memo: '■ 目的\n売上の確認\n' }, segments); } });
  try {
    l.fire('onPageOpen', 'pa1'); await l.drain(120);
    $(l, 'paneBtnMemo').onclick(); await l.drain();
    const box = $(l, 'pMemo').querySelector('.memorows');
    const rows = box.querySelectorAll('.blk');
    assert.ok(rows.length >= 2, '前提: メモの欄に行が無い');
    const t = rows[rows.length - 1].querySelector('.txt');
    t.focus(); l.caret.set(t, 0, t.textContent.length);
    assert.strictEqual(l.key(CTRL_A, t).defaultPrevented, true);
    assert.deepStrictEqual(box.querySelectorAll('.blk').filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.dataset.id), rows.map((e) => e.dataset.id), 'メモの欄の行を全部選ばない');
    assert.deepStrictEqual(selIds(l), [], '要約の欄の行まで選んだ');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-3・F208（KQ5・OQ7）: 近道の表の Ctrl+A の行は承認の字で、ヘルプの文は「2回目はページの行を全部」と空の行の1文', () => {
  const S = require('../src/shortcuts.js');
  const rows = (S.SHORTCUTS || S).filter((r) => r.keys === 'Ctrl+A' && r.where === '要約の行を直しているとき');
  assert.deepStrictEqual(rows.map((r) => r.what), ['行の文字を全部選ぶ（もう一度押すとページの行を全部選ぶ）']);
  const help = fs.readFileSync(path.join(__dirname, '..', 'help', 'articles', 'summary', 'edit-summary.md'), 'utf8');
  assert.ok(help.includes('- 行の中の [[Ctrl+A]] は、1回目は行の文字を全部、2回目はページの行を全部選びます。空の行では、1回目でページの行を全部選びます。'), 'ヘルプの Ctrl+A の文が承認の字でない');
  assert.ok(!help.includes('2回目はその行を'), 'ヘルプに前の Ctrl+A の字が残る');
});

// ---------------------------------------------------------------- NX-4（決めたこと 83・84・F209・F210）
const menuBox = (l) => $(l, 'pNote').querySelectorAll('.blockmenu').find((x) => !x.classList.contains('sub')) || null;
const subBox = (l) => $(l, 'pNote').querySelectorAll('.blockmenu').find((x) => x.classList.contains('sub')) || null;
test('NX-4・F209（X-21・B-22）: ［変換 ▸］（⠿・Ctrl+/・選んだ行の Ctrl+/）に区切り線が無い。ほかの項目と並びは今のまま。/ のメニューの区切り線は今どおり', T, async () => {
  const l = await openNote([kid('p', { type: 'bullet' }), kid('e', { text: '' }), kid('q')]);
  try {
    const want = E.MENU_ROWS.filter((r) => r.key !== 'divider').map((r) => r.label);
    // 1行（文のある行・空の行のどちらも）
    for (const id of ['p', 'e']) {
      const t = typeIn(l, id, id === 'e' ? '' : 'pの文');
      l.key({ key: '/', code: 'Slash', ctrlKey: true }, t);
      menuBox(l).querySelectorAll('.mitem')[2].onclick();
      const sub = subBox(l);
      assert.deepStrictEqual(sub.querySelectorAll('.mitem').map((x) => x.textContent), want, `${id}: ［変換 ▸］の並び`);
      assert.ok(!sub.querySelectorAll('.mitem').some((x) => x.dataset.key === 'divider'), `${id}: ［変換 ▸］に区切り線がある`);
      l.key({ key: 'Escape' }, l.document.activeElement); l.key({ key: 'Escape' }, l.document.activeElement);
    }
    // 選んだ行
    const t = typeIn(l, 'q', 'qの文');
    l.key({ key: 'Escape' }, t);
    l.key({ key: 'ArrowUp', shiftKey: true }, $(l, 'pNote'));
    l.key({ key: '/', code: 'Slash', ctrlKey: true }, $(l, 'pNote'));
    menuBox(l).querySelectorAll('.mitem')[2].onclick();
    assert.deepStrictEqual(subBox(l).querySelectorAll('.mitem').map((x) => x.textContent), want, '選んだ行の［変換 ▸］の並び');
    l.key({ key: 'Escape' }, l.document.activeElement); l.key({ key: 'Escape' }, l.document.activeElement);
    // / のメニューには今どおり区切り線がある
    const e = typeIn(l, 'e', '/');
    e.dispatchEvent({ type: 'input' });
    assert.ok($(l, 'pNote').querySelector('.slashmenu').querySelectorAll('.sopt').some((o) => o.dataset.key === 'divider'), '/ のメニューから区切り線が消えた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-4・F210（X-22）: 子のあるトグルを［変換 ▸］でテキストに → blockTurnInto の1回で子は中に残って描かれる', T, async () => {
  const l = await openNote([kid('x'), { id: 't', type: 'toggle', text: 'トグル', open: true, citeState: 'manual', cites: [], children: [kid('t1')] }, kid('z')]);
  try {
    const t = typeIn(l, 't', 'トグル');
    l.key({ key: '/', code: 'Slash', ctrlKey: true }, t);
    menuBox(l).querySelectorAll('.mitem')[2].onclick();
    subBox(l).querySelectorAll('.mitem').find((x) => x.dataset.key === 'text').onclick();
    await l.drain(80);
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 't', 'paragraph']]);
    const b = BT.locate(pageOf(l).blocks, 't').b;
    assert.deepStrictEqual([b.type, b.children.map((k) => k.id)], ['paragraph', ['t1']]);
    assert.strictEqual(rowOf(l, 't1').dataset.depth, '1', '子が中に描かれない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-4・F210: 画面のメモの欄の写し（memoDocView）の turnMovesKids も src/memoDoc.js と同じ答え（トグルをテキストにしても子は中に残る）', () => {
  const app = memoView();
  const doc = [{ id: 'm1', type: 'toggle', text: '親', citeState: 'manual', children: [{ id: 'm2', type: 'paragraph', text: '中', citeState: 'manual' }] },
    { id: 'm3', type: 'heading', level: 1, toggle: true, text: '見出し', citeState: 'manual', children: [{ id: 'm4', type: 'paragraph', text: '中二', citeState: 'manual' }] }];
  for (const [cmd, args] of [['block.turnInto', { blockId: 'm1', type: 'paragraph' }], ['block.turnInto', { blockId: 'm3', type: 'paragraph' }], ['block.turnInto', { blockId: 'm3', type: 'heading', level: 2 }],
    ['blocks.turnInto', { ids: ['m1', 'm3'], type: 'paragraph' }], ['block.turnInto', { blockId: 'm1', type: 'bullet' }]]) sameMemo(app, doc, cmd, args);
  assert.deepStrictEqual(app.memoEdit(doc, 'block.turnInto', { blockId: 'm1', type: 'paragraph' }, { next: 40 }).doc[0].children.map((b) => b.id), ['m2'], '写しのトグルの子が外へ出る');
});

// ---------------------------------------------------------------- NX-5（決めたこと 85〜87・F211〜F213・計画の違いの行 X-24〜X-26・X-32・X-33・V-T42〜V-T44・R-27）
// データベースの題名・列の名前・行の題名は作った物（会議の題名でない: D77 の外）
async function openTable() {
  const l = await realApp({ before: (call) => {
    const id = call('db.create', {}).id;
    const c1 = call('col.add', { db: id, type: 'text', name: 'メモ' }).col.id;
    const c2 = call('col.add', { db: id, type: 'number', name: '金額' }).col.id;
    const c3 = call('col.add', { db: id, type: 'date', name: '期日' }).col.id;
    const c4 = call('col.add', { db: id, type: 'select', name: '優先度' }).col.id;
    const rows = ['見積もり', '発注', '検収'].map((ti, i) => call('row.add', { db: id, title: ti, cells: { [c1]: `メモ ${i}`, [c2]: (i + 1) * 100, [c3]: { start: `2026-11-0${i + 1}` } } }).id);
    return { id, c1, c2, c3, c4, rows };
  } });
  l.fire('onPageOpen', l.made.id); await l.drain(120);
  return l;
}
const tbox = (l) => $(l, 'pDb');
const tgrid = (l) => tbox(l).querySelector('.dbgrid');
const trows = (l) => tbox(l).querySelectorAll('.dbrow').filter((r) => r.dataset.id);
const cellAt = (l, rowId, col) => trows(l).find((r) => r.dataset.id === rowId).querySelectorAll('.dbcell').find((c) => c.dataset.col === col);
const checkOf = (l, rowId) => trows(l).find((r) => r.dataset.id === rowId).querySelector('.dbcheck');
const editorOf = (l) => tbox(l).querySelector('.dbedit');
const pickerOf = (l) => tbox(l).querySelector('.dbpick');
const act = (l) => l.document.activeElement;
const k = async (l, el, o) => { const ev = l.key(o, el); await l.drain(80); return ev; };
const click = async (l, el, n = 80) => { el.dispatchEvent({ type: 'click' }); await l.drain(n); };
const cellsOf = (l, id) => l.call('db.view', { id: l.made.id, viewId: 'v1', from: 0, count: 50 }).rows.find((r) => r.id === id).cells;
const oplogN = (l) => l.db.prepare('select count(*) as c from oplog').get().c;
const at = (l) => { const a = act(l); return a && a.dataset && a.dataset.col ? [a.parentNode.dataset.id, a.dataset.col] : null; };
const bar = (l) => tbox(l).querySelector('.dbselcount');
const checked = (l) => trows(l).filter((r) => r.querySelector('.dbcheck').checked).map((r) => r.dataset.id);

test('NX-5・F211（X-24・S7）: 書いている間の Esc は rowSetCell の1回で書いた文字を決め、そのセルを選んだ形（最後の行の題名でも行を足さない）。同じ値は書かない・読めない数は一言で前の値・変換中の Esc は何もしない・blur でもう一度書かない', T, async () => {
  const l = await openTable();
  try {
    const { id, c1, c2, rows: [r0,, r2] } = l.made;
    await click(l, cellAt(l, r0, c1));
    editorOf(l).value = 'かな';
    await k(l, editorOf(l), { key: 'Escape', isComposing: true });
    assert.ok(editorOf(l), '変換中の Esc で書き手を閉じた');
    assert.deepStrictEqual(l.called('rowSetCell'), [], '変換中の Esc で書いた');
    editorOf(l).value = '直した';
    const n0 = oplogN(l);
    const inp = editorOf(l);
    await k(l, inp, { key: 'Escape' });
    inp.dispatchEvent({ type: 'blur' }); await l.drain(40);
    assert.deepStrictEqual(l.called('rowSetCell').map((c) => c.args), [[id, r0, c1, '直した']], 'Esc で書いた文字を決めない（一度だけ）');
    assert.strictEqual(oplogN(l), n0 + 1, 'Esc の後の blur で二度書いた');
    assert.strictEqual(cellsOf(l, r0)[c1], '直した');
    assert.ok(editorOf(l) === null, '書き手が残った');
    assert.deepStrictEqual(at(l), [r0, c1], 'Esc の後にそのセルを選んだ形でない');
    // 同じ値は書かない
    await k(l, act(l), { key: 'Enter' });
    await k(l, editorOf(l), { key: 'Escape' });
    assert.strictEqual(l.called('rowSetCell').length, 1, '同じ値を書いた');
    // 読めない数は一言で前の値のまま
    await click(l, cellAt(l, r0, c2));
    editorOf(l).value = '百';
    await k(l, editorOf(l), { key: 'Escape' });
    assert.strictEqual(l.called('rowSetCell').length, 1, '読めない数を書いた');
    assert.strictEqual($(l, 'toast').textContent, 'この列の値として読めませんでした。');
    assert.strictEqual(cellsOf(l, r0)[c2], 100);
    // 最後の行の題名の Esc は行を足さない
    await click(l, cellAt(l, r2, 'title'));
    editorOf(l).value = '検収した';
    await k(l, editorOf(l), { key: 'Escape' });
    assert.deepStrictEqual([l.called('rowAdd').length, cellsOf(l, r2) && l.call('db.view', { id, viewId: 'v1', from: 0, count: 50 }).rows.length], [0, 3], '最後の行の題名の Esc で行を足した');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-5・F211（KQ3・S7・V-T42）: 行のページの文字の列も、書いている間の Esc で書いた文字を決める（rowSetCell の1回・フォーカスは値へ戻る）', T, async () => {
  const l = await openTable();
  try {
    const { id, c1, rows: [r0] } = l.made;
    l.fire('onOpenLink', { id: r0, anchor: '' }); await l.drain(200);
    const propV = (name) => $(l, 'pProps').querySelectorAll('.dbprop').find((p) => p.querySelector('.k').textContent === name).querySelector('.dbpropv');
    await click(l, propV('メモ'));
    const inp = $(l, 'pProps').querySelector('.dbedit');
    inp.value = '行で直した';
    await k(l, inp, { key: 'Escape' });
    assert.deepStrictEqual(l.called('rowSetCell').map((c) => c.args), [[id, r0, c1, '行で直した']], '行のページの Esc で書いた文字を決めない');
    assert.strictEqual(propV('メモ').textContent, '行で直した');
    assert.ok(act(l) === propV('メモ'), 'Esc の後にフォーカスが値へ戻らない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-5・F211（OQ2「Notion と同じく打った日付を入れる（おすすめ）」・S10・X-33・R-27）: 暦の Esc は、読める日付が前と違えば rowSetCell の1回で書く。同じ・空・読めなければ書かずに前の値のまま', T, async () => {
  const l = await openTable();
  try {
    const { id, c3, rows: [r0, r1] } = l.made;
    const by = (label) => pickerOf(l).querySelectorAll('input').find((i) => i.getAttribute('aria-label') === label);
    await click(l, cellAt(l, r0, c3));
    by('期日').value = '2026-11-20';
    await k(l, by('期日'), { key: 'Escape' });
    assert.ok(pickerOf(l) === null, '暦が閉じない');
    assert.deepStrictEqual(l.called('rowSetCell').map((c) => c.args), [[id, r0, c3, { start: '2026-11-20' }]], '暦の Esc で打った日付を決めない');
    assert.deepStrictEqual(cellsOf(l, r0)[c3], { start: '2026-11-20' });
    // 同じ値・空の欄は書かない（Esc で値を消さない）
    await click(l, cellAt(l, r1, c3));
    await k(l, by('期日'), { key: 'Escape' });
    await click(l, cellAt(l, r1, c3));
    by('期日').value = '';
    await k(l, by('期日'), { key: 'Escape' });
    assert.strictEqual(l.called('rowSetCell').length, 1, '同じ値か空の欄の Esc で書いた');
    assert.deepStrictEqual(cellsOf(l, r1)[c3], { start: '2026-11-02' }, 'Esc で日付が消えた');
    // 読めない（終わりが始まりより前）は書かない
    await click(l, cellAt(l, r1, c3));
    const [endBox] = pickerOf(l).querySelectorAll('.dbdatecheck input');
    endBox.checked = true; endBox.dispatchEvent({ type: 'change' });
    by('終わりの日').value = '2026-10-01';
    await k(l, by('期日'), { key: 'Escape' });
    assert.strictEqual(l.called('rowSetCell').length, 1, '読めない日付を書いた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-5・F212（X-25・S11・V-T44）: セルの Esc はその行だけにチェック（帯「1 行を選んでいます」・フォーカスはその行のチェック）、もう一度でチェックを全部外しフォーカスは表。別の行のセルを押すとチェックが外れる', T, async () => {
  const l = await openTable();
  try {
    const { c1, rows: [r0, r1, r2] } = l.made;
    // チェックを2つ入れてから別の行のセルを押す → チェックが外れ、帯が消える（S11）
    for (const r of [r0, r1]) { const ck = checkOf(l, r); ck.checked = true; ck.onchange(); }
    await l.drain(20);
    assert.strictEqual(bar(l).textContent, '2 行を選んでいます');
    await click(l, cellAt(l, r2, c1));
    assert.deepStrictEqual(checked(l), [], '別の行のセルを押してもチェックが残った');
    assert.ok(!bar(l) || tbox(l).querySelector('.dbselbar, .dbbar') === null || bar(l).parentNode.hidden, '帯が残った');
    // 書いている → セル → その行 → 何も選ばない
    editorOf(l).value = 'メモ 2';
    await k(l, editorOf(l), { key: 'Escape' });
    assert.deepStrictEqual(at(l), [r2, c1]);
    await k(l, act(l), { key: 'Escape' });
    assert.deepStrictEqual(checked(l), [r2], 'セルの Esc でその行にチェックが入らない');
    assert.strictEqual(bar(l).textContent, '1 行を選んでいます');
    assert.ok(act(l) === checkOf(l, r2), 'セルの Esc の後のフォーカスがその行のチェックでない');
    assert.strictEqual(tbox(l).querySelectorAll('.dbcell').filter((c) => c.getAttribute('aria-selected') === 'true').length, 0, 'セルの選びが残った');
    await k(l, act(l), { key: 'Escape' });
    assert.deepStrictEqual(checked(l), [], '行を選んでいるときの Esc でチェックが残った');
    assert.ok(act(l) === tgrid(l), 'チェックを外した後のフォーカスが表でない');
    // キーボードでセルへ移ってチェックが残っているときのセルの Esc は、その行だけ（U8）
    for (const r of [r0, r1]) { const ck = checkOf(l, r); ck.checked = true; ck.onchange(); }
    await k(l, tgrid(l), { key: 'ArrowDown' });
    assert.deepStrictEqual(checked(l), [r0, r1], 'キーボードでセルへ移るとチェックが外れた');
    await k(l, act(l), { key: 'Escape' });
    assert.deepStrictEqual(checked(l), [r0], 'セルの Esc がその行だけにしない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-5・F213（X-26・X-32・S9・V-T43・OQ1「今のまま表の外へ（おすすめ）」）: 書いている間の Tab は書いた文字を決めて、行の末では次の行の頭のセル・Shift+Tab は行の頭で前の行の末へ。選びの窓の Tab も同じ。表のいちばん頭では決めてそのセル。選んでいるときの表の末の Tab は今のまま表の外へ', T, async () => {
  const l = await openTable();
  try {
    const { c2, c3, c4, rows: [r0, r1, r2] } = l.made;
    // 書いている間の Tab（行の途中）は右のセル
    await click(l, cellAt(l, r0, c2));
    editorOf(l).value = '150';
    await k(l, editorOf(l), { key: 'Tab' });
    assert.deepStrictEqual(at(l), [r0, c3]);
    // 行の末（優先度の選びの窓）の Tab → 次の行の頭
    await click(l, cellAt(l, r0, c4));
    assert.ok(pickerOf(l), '前提: 選びの窓が出ない');
    await k(l, act(l), { key: 'Tab' });
    assert.deepStrictEqual(at(l), [r1, 'title'], '選びの窓の行の末の Tab が次の行の頭へ行かない');
    // 書いている間の行の頭の Shift+Tab → 前の行の末
    await k(l, act(l), { key: 'Enter' });
    editorOf(l).value = '発注した';
    await k(l, editorOf(l), { key: 'Tab', shiftKey: true });
    assert.deepStrictEqual(at(l), [r0, c4], '書いている間の行の頭の Shift+Tab が前の行の末へ行かない');
    assert.deepStrictEqual(l.called('rowSetCell').map((c) => c.args.slice(1, 4)), [[r0, c2, 150], [r1, 'title', '発注した']], '移る前に書いた文字を決めない');
    // 書いている間の行の途中の Shift+Tab は左のセル（今のまま）
    await click(l, cellAt(l, r1, c2));
    editorOf(l).value = '250';
    await k(l, editorOf(l), { key: 'Tab', shiftKey: true });
    assert.deepStrictEqual(at(l), [r1, l.made.c1]);
    // 表のいちばん頭のセル: 書いている間の Shift+Tab は決めてそのセル
    await click(l, cellAt(l, r0, 'title'));
    editorOf(l).value = '見積もりした';
    await k(l, editorOf(l), { key: 'Tab', shiftKey: true });
    assert.deepStrictEqual(at(l), [r0, 'title'], '表のいちばん頭のセルの Shift+Tab がそのセルにとどまらない');
    assert.strictEqual(l.called('rowSetCell').at(-1).args[3], '見積もりした');
    // 選んでいるときの表の末の Tab は今のまま（既定を止めない: 表の外の次の部品へ）
    await k(l, act(l), { key: 'End', ctrlKey: true });
    assert.deepStrictEqual(at(l), [r2, c4]);
    const ev = await k(l, act(l), { key: 'Tab' });
    assert.strictEqual(ev.defaultPrevented, false, '選んでいるときの表の末の Tab を止めた（OQ1 の (a) は今のまま）');
    assert.strictEqual(l.called('rowAdd').length, 0);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-5・F213（S9）: 表のいちばん末のセルで書いている間の Tab は、書いた文字を決めてそのセルを選んだ形（行は増えない）', T, async () => {
  const l = await realApp({ before: (call) => {
    const id = call('db.create', {}).id;
    const c1 = call('col.add', { db: id, type: 'text', name: 'メモ' }).col.id;
    const rows = ['見積もり', '発注'].map((ti) => call('row.add', { db: id, title: ti }).id);
    return { id, c1, rows };
  } });
  try {
    l.fire('onPageOpen', l.made.id); await l.drain(120);
    const { id, c1, rows: [, r1] } = l.made;
    await click(l, cellAt(l, r1, c1));
    editorOf(l).value = '末';
    await k(l, editorOf(l), { key: 'Tab' });
    assert.deepStrictEqual(at(l), [r1, c1], '表のいちばん末のセルの書いている間の Tab がそのセルにとどまらない');
    assert.deepStrictEqual(l.called('rowSetCell').map((c) => c.args), [[id, r1, c1, '末']]);
    assert.strictEqual(l.called('rowAdd').length, 0, '行を足した');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NX-5・F214（KQ5・OQ8）: 近道の表の表の Esc・Tab の行は承認の字（src/shortcuts.js・設定の表・settings/hotkeys.md・find/database.md）', () => {
  const S = require('../src/shortcuts.js');
  const W = 'データベースの表のセルを選んでいるとき';
  const what = (keys) => S.SHORTCUTS.filter((r) => r.keys === keys && r.where === W).map((r) => r.what);
  assert.deepStrictEqual(what('Esc'), ['その行を選ぶ（もう一度押すと選びをやめる。書いている間は、書いた文字を決めてセルを選ぶ）']);
  assert.deepStrictEqual(what('Tab・Shift+Tab'), ['右・左のセルへ（行の末・頭では次・前の行へ。書いている間も）']);
  for (const f of ['settings/hotkeys.md', 'find/database.md']) {
    const t = fs.readFileSync(path.join(__dirname, '..', 'help', 'articles', f), 'utf8');
    assert.ok(t.includes('| [[Esc]] | その行を選ぶ（もう一度押すと選びをやめる。書いている間は、書いた文字を決めてセルを選ぶ） |') && t.includes('| [[Tab]]・[[Shift+Tab]] | 右・左のセルへ（行の末・頭では次・前の行へ。書いている間も） |'), `${f} の表が承認の字でない`);
    assert.ok(!t.includes('書いた文字を捨てる'), `${f} に前の字が残る`);
  }
});

test('NX-5・F211・F212・F213: 本文のインラインの表も同じ部品（書いている間の Esc で決める・セル → 行 → 選びなし・行の末の Tab で次の行の頭）', T, async () => {
  const l = await realApp({ before: (call) => {
    const P = call('page.create', {}).id;
    call('page.setTitle', { id: P, title: 'まとめの頁' });   // 白紙のページの題名（D77 の会議の題名でない）
    const t1 = call('block.insert', { pageId: P, afterBlockId: '', type: 'paragraph' }).blockId;
    const D = call('db.create', { parentId: P, inline: t1 }).id;
    const c1 = call('col.add', { db: D, type: 'text', name: 'メモ' }).col.id;
    const rows = ['見積もり', '発注'].map((ti) => call('row.add', { db: D, title: ti }).id);
    return { P, t1, D, c1, rows };
  } });
  try {
    const { P, D, c1, rows: [r0, r1] } = l.made;
    l.fire('onPageOpen', P); await l.drain(300);
    const host = $(l, 'pNote').querySelectorAll('.blk').find((e) => e.dataset.id === l.made.t1).querySelector('.dbhost');
    assert.ok(host, '前提: インラインの表が無い');
    const rowsIn = () => host.querySelectorAll('.dbrow').filter((r) => r.dataset.id);
    const cell = (rowId, col) => rowsIn().find((r) => r.dataset.id === rowId).querySelectorAll('.dbcell').find((c) => c.dataset.col === col);
    await click(l, cell(r0, c1));
    host.querySelector('.dbedit').value = 'インライン';
    await k(l, host.querySelector('.dbedit'), { key: 'Tab' });
    assert.deepStrictEqual(l.called('rowSetCell').map((c) => c.args), [[D, r0, c1, 'インライン']]);
    assert.ok(act(l) === cell(r1, 'title'), 'インラインの表で行の末の Tab が次の行の頭へ行かない');
    await k(l, act(l), { key: 'Enter' });
    host.querySelector('.dbedit').value = '発注した';
    await k(l, host.querySelector('.dbedit'), { key: 'Escape' });
    assert.deepStrictEqual(l.called('rowSetCell').at(-1).args, [D, r1, 'title', '発注した'], 'インラインの表で Esc が書いた文字を決めない');
    assert.ok(act(l) === cell(r1, 'title'));
    await k(l, act(l), { key: 'Escape' });
    assert.deepStrictEqual(rowsIn().filter((r) => r.querySelector('.dbcheck').checked).map((r) => r.dataset.id), [r1], 'インラインの表のセルの Esc でその行を選ばない');
    await k(l, act(l), { key: 'Escape' });
    assert.deepStrictEqual(rowsIn().filter((r) => r.querySelector('.dbcheck').checked).length, 0);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
