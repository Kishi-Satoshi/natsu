/*
 * stage131.nest.app.test.js — 0.13.1「入れ子とトグル」の画面（計画 docs/plans/2026-10-27-131.md の Task NE-3・NE-4a・NE-4b）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。命令は一時の DB（helpers/dbtmp.js）を本当に通す。
 * カーソルは simrun の caret の継ぎ目（l.caret）で置く（偽の DOM に getSelection・Range が無い）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { titleAt } = require('./helpers/titles');
const { tmpDb, samplePage } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const lib = require('../src/mainlib');
const M = require('../src/memoTypes');
const E = require('../src/blockEdit');
const BT = require('../src/blockTree');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const HTML = fs.readFileSync(APP, 'utf8');
const T = { timeout: 8000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const T1 = titleAt('2026-10-27T01:00:00.000Z');
const fnFromApp = (name) => {
  const at = HTML.indexOf(`  function ${name}(`);
  assert.ok(at > 0, `app.html に ${name} が無い`);
  return HTML.slice(at, HTML.indexOf('\n  }\n', at) + 4);
};

// 一時の DB を本当に通す画面（stage130.edit.app の openReal と同じ形に、0.13.1 の命令と足した引数を足した）
const NOW = () => new Date('2026-10-27T01:02:03.000Z');
let txn = 0;
const CMDS = {
  blockUpdate: (pageId, blockId, patch) => ['block.update', { pageId, blockId, patch }],
  blockInsert: (pageId, afterBlockId, type, level, parentId, toggle) => ['block.insert', { pageId, afterBlockId, type, ...(level === undefined ? {} : { level }), ...(parentId === undefined ? {} : { parentId }), ...(toggle === true ? { toggle } : {}) }],
  blockRemove: (pageId, blockId) => ['block.remove', { pageId, blockId }],
  blockSplit: (pageId, blockId, text, at, afterId, inside) => ['block.split', { pageId, blockId, text, at, ...(afterId === undefined ? {} : { afterId }), ...(inside === true ? { inside } : {}) }],
  blockMerge: (pageId, blockId, text, intoId) => ['block.merge', intoId === undefined ? { pageId, blockId, text } : { pageId, blockId, text, intoId }],
  blockTurnInto: (pageId, blockId, type, level, toggle) => ['block.turnInto', { pageId, blockId, type, ...(level === undefined ? {} : { level }), ...(toggle === true ? { toggle } : {}) }],
  blockSetAction: (pageId, blockId, assignee, dueRaw) => ['block.setAction', { pageId, blockId, assignee, dueRaw }],
  blockDuplicate: (pageId, blockId, afterId, parentId) => ['block.duplicate', { pageId, blockId, ...(afterId === undefined ? {} : { afterId }), ...(parentId === undefined ? {} : { parentId }) }],
  blockMove: (pageId, blockId, to) => ['block.move', to && typeof to === 'object' ? { pageId, blockId, afterId: to.afterId, ...(to.parentId === undefined ? {} : { parentId: to.parentId }) } : { pageId, blockId, toIndex: to }],
  blockIndent: (pageId, blockId, dir) => ['block.indent', { pageId, blockId, dir }],
  blockSetOpen: (pageId, blockId, open) => ['block.setOpen', { pageId, blockId, open }],
  blockSetOpenAll: (pageId, open) => ['block.setOpenAll', { pageId, open }],
};
async function openReal(pages, o = {}) {
  const t = tmpDb();
  const { db } = t.open();
  for (const [id, v] of Object.entries(pages)) {
    const { page, segments } = samplePage(id);
    const o2 = Array.isArray(v) ? { blocks: v } : v;
    t.seed({ ...page, ...o2, title: o2.title || T1, blocks: o2.blocks }, segments);
  }
  const call = (cmd, args) => {
    const r = core.call(db, { role: 'app', cmd, args, tx: `a:ne-${String(++txn).padStart(6, '0')}` }, { now: NOW, labels: {} });
    if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code });
    return r.result;
  };
  const held = [];
  const wrap = (name, fn) => (...a) => {
    const run = () => { try { return fn(...a); } catch (e) { return Promise.reject(e); } };
    if (o.hold && o.hold.includes(name)) return new Promise((res) => { held.push(() => res(run())); });
    return run();
  };
  const returns = {
    meetingTypes: () => lib.typesForView(), memoTypes: () => M.listMemoTypes(),
    pagesSearch: wrap('pagesSearch', () => call('pages.list', { q: '' })), pageGet: wrap('pageGet', (id) => call('page.get', { id })),
    copy: () => true,
    ...(o.returns || {}),
  };
  for (const [name, f] of Object.entries(CMDS)) returns[name] = wrap(name, (...a) => call(...f(...a)));
  const l = await load(APP, { caret: true, returns, ...(o.load || {}) });
  l.t = t; l.db = db; l.call = call;
  l.release = () => { for (const f of held.splice(0)) f(); };
  l.page = (id = 'pa1') => call('page.get', { id }).page;
  l.done = () => t.done();
  await l.drain();
  l.fire('onPageOpen', o.open || Object.keys(pages)[0]);
  await l.drain();
  return l;
}
const rowsOf = (l) => $(l, 'pNote').querySelectorAll('.blk');
const rowOf = (l, id) => rowsOf(l).find((e) => e.dataset.id === id);
const txtOf = (l, id) => rowOf(l, id).querySelector('.txt');
const ED_CALLS = Object.keys(CMDS);
const sent = (l) => l.calls.filter((c) => ED_CALLS.includes(c.method)).map((c) => [c.method, ...c.args]);
const shape = (blocks) => blocks.map((b) => (b.children && b.children.length ? [b.id, shape(b.children)] : b.id));
function typeIn(l, id, text, at = text.length, end = at) {
  const t = txtOf(l, id);
  t.focus();
  t.textContent = text;
  l.caret.set(t, at, end);
  return t;
}
const kid = (id, type = 'bullet', o = {}) => ({ id, type, text: `${id}の文`, citeState: 'manual', cites: [], ...o });

// ---------------------------------------------------------------- NE-3: ［コピー］と humanEdited（決めたこと 22・33）
test('NE-3: 画面の写し（app.html の flattenBlocks・blocksMarkdown）は src/blockTree.js・src/blockEdit.js と同じ答え（子を2つの空白で下げる・閉じたトグルの子も・トグルは「- 」）', () => {
  const src = ['headingLevel', 'numberLabels', 'blocksMarkdown', 'flattenBlocks'].map(fnFromApp).join('\n');
  const app = new Function(`const CALLOUT_ICON = '💡';\n${src}\nreturn { blocksMarkdown, flattenBlocks };`)();   // eslint-disable-line no-new-func
  const tree = [{ id: 'h', type: 'heading', level: 2, text: '決定事項' }, { id: 'b', type: 'bullet', text: '親', children: [kid('c'), kid('n1', 'numbered', { children: [kid('g', 'todo', { checked: true })] }), kid('n2', 'numbered')] },
    { id: 't', type: 'toggle', text: '閉じた', open: false, children: [kid('k', 'paragraph', { text: '中\n二行目' })] }, { id: 'th', type: 'heading', toggle: true, level: 1, text: 'トグル見出し', children: [kid('m')] }];
  for (const tb of [[], undefined, tree, samplePage('pa1').page.blocks]) {
    assert.strictEqual(app.blocksMarkdown(tb), E.blocksMarkdown(tb), JSON.stringify(tb));
    assert.deepStrictEqual(app.flattenBlocks(tb).map((b) => b.id), BT.flattenBlocks(tb).map((b) => b.id));
  }
  const flat = app.flattenBlocks(tree);
  assert.strictEqual(flat[2], tree[1].children[0], '画面の写しの平らにした並びが写し');
});

test('NE-3・決めたこと 22: ［コピー］に子が2つの空白で下げて出る（閉じたトグルの子も・トグルは『- 』）。子の無い要約は今の表のまま', T, async () => {
  const blocks = [{ id: 'h1', type: 'heading', level: 2, text: '決定事項' },
    { id: 'a', type: 'bullet', text: '親の行の要点を書いた長めの文です', cites: ['s2'], citeState: 'linked', children: [kid('a1'), kid('a2', 'numbered')] },
    { id: 't', type: 'toggle', text: 'たたんだ話', citeState: 'manual', open: false, children: [kid('t1', 'todo', { checked: false })] }];
  const copies = [];
  const l = await openReal({ pa1: blocks }, { returns: { copy: (x) => { copies.push(x); return true; } } });
  try {
    const btn = $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === 'コピー');
    await btn.onclick();
    await l.drain();
    assert.deepStrictEqual(copies, ['## 決定事項\n- 親の行の要点を書いた長めの文です\n  - a1の文\n  1. a2の文\n- たたんだ話\n  - [ ] t1の文']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-3・決めたこと 33: humanEdited は子の行も見る（AI の平らな行の要約に人が子を足したら［要約を再生成］の前に確かめる）', () => {
  const app = new Function(`${fnFromApp('flattenBlocks')}\nconst AI_TYPES = ['heading', 'bullet', 'todo', 'paragraph'];\n${fnFromApp('humanEdited')}\nreturn humanEdited;`)();   // eslint-disable-line no-new-func
  const ai = [{ id: 'h', type: 'heading', text: '決定事項' }, { id: 'b', type: 'bullet', text: '要点', citeState: 'linked' }];
  assert.strictEqual(app(ai), false);
  assert.strictEqual(app([ai[0], { ...ai[1], children: [{ id: 'k', type: 'bullet', text: '子', citeState: 'manual' }] }]), true, '子の人の行を見ない');
  assert.strictEqual(app([ai[0], { ...ai[1], children: [{ id: 'k', type: 'toggle', text: '子' }] }]), true, '子のトグル（AI の型でない）を見ない');
});

// ---------------------------------------------------------------- NE-4a: 入れ子の行（字下げ・Esc・Enter と Backspace・動かす）
const NEST = () => [
  { id: 'h1', type: 'heading', level: 2, text: '決定事項' },
  { id: 'a', type: 'bullet', text: '親の行の要点を書いた長めの文です', cites: [], citeState: 'manual', children: [kid('a1'), kid('a2', 'bullet', { children: [kid('a21', 'todo', { checked: false })] }), kid('a3')] },
  { id: 'n1', type: 'numbered', text: '一つ目', citeState: 'manual', children: [kid('m1', 'numbered'), kid('m2', 'numbered')] },
  kid('n2', 'numbered'),
  { id: 'p', type: 'paragraph', text: '本文の行です', citeState: 'manual' },
  { id: 'v', type: 'divider', text: '', citeState: 'manual' },
  kid('q'),
];
const NEST_ROWS = [['h1', '0'], ['a', '0'], ['a1', '1'], ['a2', '1'], ['a21', '2'], ['a3', '1'], ['n1', '0'], ['m1', '1'], ['m2', '1'], ['n2', '0'], ['p', '0'], ['v', '0'], ['q', '0']];
const press = (l, el, key, o = {}) => l.key({ key, ...o }, el);
const at = (l, id) => { const t = txtOf(l, id); t.focus(); l.caret.set(t, 0); return t; };
const atEnd = (l, id) => { const t = txtOf(l, id); t.focus(); l.caret.set(t, t.textContent.length); return t; };

test('NE-4a: 画面の写し（canIndent・locate・kidsCan・isOpenStored・visibleOrder）は src/blockTree.js と同じ答え', () => {
  const src = ['flattenBlocks', 'kidsCanView', 'isToggleView', 'isOpenStored', 'aiSectionHead', 'locate', 'canIndent', 'visibleOrder'].map(fnFromApp).join('\n');
  const app = new Function(`${src}\nreturn { kidsCanView, isOpenStored, aiSectionHead, locate, canIndent, visibleOrder };`)();   // eslint-disable-line no-new-func
  const blocks = NEST();
  blocks.push({ id: 't', type: 'toggle', text: 't', open: false, children: [kid('tk')] }, { id: 'th', type: 'heading', toggle: true, level: 1, text: 'th', children: [kid('thk')] }, { id: 'ai', type: 'heading', text: 'AI' });
  for (const b of BT.flattenBlocks(blocks).concat([{ type: 'video' }, { type: 'heading', toggle: true }, { type: 'divider' }, { type: 'toggle', open: true }])) {
    assert.strictEqual(app.kidsCanView(b), BT.kidsCan(b), JSON.stringify(b));
    assert.strictEqual(app.isOpenStored(b), BT.isOpenStored(b), JSON.stringify(b));
    assert.strictEqual(app.aiSectionHead(b), BT.aiSectionHead(b), JSON.stringify(b));
    if (b.id) {
      assert.strictEqual(app.canIndent(blocks, b.id), BT.canIndent(blocks, b.id), b.id);
      const x = app.locate(blocks, b.id); const y = BT.locate(blocks, b.id);
      assert.deepStrictEqual([x.b.id, x.index, x.depth, x.parent && x.parent.id], [y.b.id, y.index, y.depth, y.parent && y.parent.id], b.id);
    }
  }
  assert.strictEqual(app.locate(blocks, 'zz'), null);
  const V = (f) => (bs) => f(bs).map((r) => [r.b.id, r.depth, r.parentId]);
  assert.deepStrictEqual(V((bs) => app.visibleOrder(bs, app.isOpenStored))(blocks), V((bs) => BT.visibleOrder(bs))(blocks));
});

test('NE-4a: 子のある要約を開くと、子は親のすぐ後ろに data-depth つきで描かれ、段ごとに左へずれる。番号付きは親ごとに数える', T, async () => {
  const l = await openReal({ pa1: NEST() });
  try {
    assert.deepStrictEqual(rowsOf(l).map((e) => [e.dataset.id, e.dataset.depth]), NEST_ROWS);
    assert.strictEqual(rowOf(l, 'a21').dataset.parent, 'a2');
    assert.strictEqual(rowOf(l, 'a').dataset.parent, '');
    assert.strictEqual(rowOf(l, 'a21').style.getPropertyValue('--depth'), '2');
    assert.strictEqual(rowOf(l, 'a').style.getPropertyValue('--depth'), '0');
    assert.match(HTML, /\.blk \{[^}]*margin-left: calc\(var\(--depth, 0\) \* 24px\)/, '段ごとの左の余白（24px）が無い');
    const num = (id) => rowOf(l, id).querySelector('.num').textContent;
    assert.deepStrictEqual(['n1', 'm1', 'm2', 'n2'].map(num), ['1.', '1.', '2.', '2.'], '番号を親ごとに数えない（F50）');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a・EQ17 (a): Tab → blockIndent in の1回・Shift+Tab → out の1回。字下げできないとき（前に兄弟が無い・前が区切り線）は何も呼ばず、フォーカスは行のまま、既定の Tab は止まる', T, async () => {
  const l = await openReal({ pa1: NEST() });
  try {
    let t = atEnd(l, 'a3');
    let ev = press(l, t, 'Tab');
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    assert.deepStrictEqual(sent(l), [['blockIndent', 'pa1', 'a3', 'in']]);
    assert.deepStrictEqual(shape(l.page().blocks)[1], ['a', ['a1', ['a2', ['a21', 'a3']]]]);
    l.calls.length = 0;
    t = atEnd(l, 'a1');
    ev = press(l, t, 'Tab', { shiftKey: true });
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    assert.deepStrictEqual(sent(l), [['blockIndent', 'pa1', 'a1', 'out']]);
    l.calls.length = 0;
    for (const id of ['a2', 'q', 'h1', 'a']) {
      t = atEnd(l, id);
      ev = press(l, t, 'Tab');
      await l.drain();
      assert.strictEqual(ev.defaultPrevented, true, `${id}: 既定の Tab が止まらない`);
      assert.strictEqual(l.document.activeElement, txtOf(l, id), `${id}: フォーカスが行から離れた`);
    }
    t = atEnd(l, 'p');
    ev = press(l, t, 'Tab', { shiftKey: true });
    assert.strictEqual(ev.defaultPrevented, true);
    await l.drain();
    assert.deepStrictEqual(sent(l), [], '字下げできないのに呼んだ');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a: Tab の後、欄を描き直しても同じ行にフォーカスとカーソルがある。打っていた文は blockIndent の前に保存される', T, async () => {
  const l = await openReal({ pa1: NEST() });
  try {
    const t = typeIn(l, 'a3', 'a3を書き直した文', 3);
    press(l, t, 'Tab');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockUpdate', 'pa1', 'a3', { text: 'a3を書き直した文' }], ['blockIndent', 'pa1', 'a3', 'in']]);
    assert.strictEqual(rowOf(l, 'a3').dataset.depth, '2');
    assert.strictEqual(l.document.activeElement, txtOf(l, 'a3'));
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'a3')), [3, 3]);
    assert.strictEqual(txtOf(l, 'a3').textContent, 'a3を書き直した文');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a・NR17・決めたこと 25: 行で Esc → ⠿ にフォーカス（見える）・一覧の選択は外れない。⠿ で Tab → フォーカスは要約の欄の外（次の行の文に入らない）。Shift+Tab →［AI 要約］のタブ。⠿ で Esc → 行の文へ戻る。/ メニューを開いている間の Esc は今どおりメニューだけを閉じる', T, async () => {
  const l = await openReal({ pa1: NEST() });
  try {
    // 欄の外の次の部品（要約の欄の後ろの［次へ］）
    const after = l.document.createElement('button'); after.textContent = '欄の外';
    $(l, 'pNote').parentNode.insertBefore(after, $(l, 'pNote').nextSibling);
    let t = atEnd(l, 'a1');
    let ev = press(l, t, 'Escape');
    assert.strictEqual(ev.defaultPrevented, true, '一覧の選択の Esc まで届く');
    const grip = rowOf(l, 'a1').querySelector('.grip');
    assert.strictEqual(l.document.activeElement, grip, 'Esc で ⠿ へ移らない');
    assert.match(HTML, /\.blk \.grip:focus-visible \{[^}]*opacity: \.55/, '⠿ のフォーカスが見えない');
    ev = press(l, grip, 'Tab');
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(l.document.activeElement, after, '⠿ から Tab で欄の外へ出ない（edn-tab-exit）');
    t = atEnd(l, 'a1'); press(l, t, 'Escape');
    ev = press(l, grip, 'Tab', { shiftKey: true });
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(l.document.activeElement, $(l, 'paneBtnNote'), 'Shift+Tab で［AI 要約］のタブへ行かない');
    t = atEnd(l, 'a1'); press(l, t, 'Escape');
    press(l, grip, 'Escape');
    assert.strictEqual(l.document.activeElement, txtOf(l, 'a1'), '⠿ の Esc で行へ戻らない');
    // / メニューが開いている間の Esc はメニューだけを閉じる（⠿ へ移らない）
    t = typeIn(l, 'q', '/');
    t.dispatchEvent({ type: 'input' });
    assert.ok($(l, 'pNote').querySelector('.slashmenu'));
    press(l, t, 'Escape');
    assert.strictEqual($(l, 'pNote').querySelector('.slashmenu'), null);
    assert.strictEqual(l.document.activeElement, t);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a・EQ5 (a)・EQ6 (a): 字下げされた空の箇条書きで Enter → blockIndent out の1回。字下げされた行の頭で Backspace → blockIndent out の1回（型も文も変えない）', T, async () => {
  const blocks = NEST();
  blocks[1].children.push(kid('e1', 'bullet', { text: '' }));
  const l = await openReal({ pa1: blocks });
  try {
    let t = at(l, 'e1');
    let ev = press(l, t, 'Enter');
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    assert.deepStrictEqual(sent(l), [['blockIndent', 'pa1', 'e1', 'out']], '空の子の箇条書きの Enter が字下げを先に戻さない（edn-enter-outdent）');
    assert.strictEqual(rowOf(l, 'e1').dataset.depth, '0');
    assert.strictEqual(l.page().blocks.find((b) => b.id === 'e1').type, 'bullet');
    l.calls.length = 0;
    t = at(l, 'a21');
    press(l, t, 'Backspace');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockIndent', 'pa1', 'a21', 'out']], '字下げされた行の頭の Backspace が字下げを先に戻さない（edn-bs-outdent）');
    const a21 = BT.locate(l.page().blocks, 'a21');
    assert.deepStrictEqual([a21.b.type, a21.b.text, a21.depth], ['todo', 'a21の文', 1]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a・NR8: 子の2つ目の行の頭で Enter（文あり）→ blockSplit の afterId は同じ親の1つ上の兄弟（その兄弟の子でない）。最初の子の頭では afterId は \'\'。最上位の行は 0.13.0 のまま（並べ替えて見せる要約でも上に見えている最上位の行）', T, async () => {
  const l = await openReal({ pa1: NEST() });
  try {
    let t = at(l, 'a3');
    press(l, t, 'Enter');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'a3', 'a3の文', 0, 'a2']], 'afterId が画面で1つ上の孫（a21）になった（edn-split-sibling）');
    const a = BT.locate(l.page().blocks, 'a').b;
    assert.deepStrictEqual(a.children.map((x) => x.id).slice(0, 2), ['a1', 'a2']);
    assert.strictEqual(a.children[3].id, 'a3');
    l.calls.length = 0;
    t = at(l, 'a1');
    press(l, t, 'Enter');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'a1', 'a1の文', 0, '']]);
    l.calls.length = 0;
    t = at(l, 'n2');
    press(l, t, 'Enter');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'n2', 'n2の文', 0, 'n1']], '最上位の行の afterId が上に見えている最上位の行でない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a・TQ3: 子が見えている行の終わりで Enter → blockSplit の inside が真で、新しい行は最初の子にフォーカス。閉じたトグルの終わりで Enter → 兄弟のトグル', T, async () => {
  const blocks = NEST();
  blocks.push({ id: 't', type: 'toggle', text: 'たたんだ話', citeState: 'manual', open: false, children: [kid('tk')] });
  const l = await openReal({ pa1: blocks });
  try {
    let t = atEnd(l, 'a2');
    press(l, t, 'Enter');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'a2', 'a2の文', 4, undefined, true]]);
    const a2 = BT.locate(l.page().blocks, 'a2').b;
    assert.strictEqual(a2.children.length, 2);
    assert.strictEqual(l.document.activeElement, txtOf(l, a2.children[0].id), '新しい最初の子にフォーカスが無い');
    assert.strictEqual(rowOf(l, a2.children[0].id).dataset.depth, '2');
    l.calls.length = 0;
    t = atEnd(l, 't');
    press(l, t, 'Enter');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 't', 'たたんだ話', 5]]);
    const top = l.page().blocks;
    assert.strictEqual(top.at(-1).type, 'toggle', '閉じたトグルの後ろが兄弟のトグルでない');
    assert.strictEqual(l.document.activeElement, txtOf(l, top.at(-1).id));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a・TQ1: 前の兄弟が子を持つ最上位のテキストの行の頭で Backspace → blockMerge の intoId は画面で上に見えている孫の行で、カーソルはつないだ所', T, async () => {
  const blocks = [NEST()[0], { id: 'a', type: 'bullet', text: '親の行の要点を書いた長めの文です', citeState: 'manual', children: [kid('a1', 'bullet', { children: [kid('g1')] })] },
    { id: 'x', type: 'paragraph', text: '下の行', citeState: 'manual' }];
  const l = await openReal({ pa1: blocks });
  try {
    const t = at(l, 'x');
    press(l, t, 'Backspace');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMerge', 'pa1', 'x', '下の行', 'g1']]);
    assert.strictEqual(BT.locate(l.page().blocks, 'g1').b.text, 'g1の文下の行');
    assert.strictEqual(l.document.activeElement, txtOf(l, 'g1'));
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'g1')), ['g1の文'.length, 'g1の文'.length]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a・NR13: 子の行で Ctrl+Shift+↑ → 同じ親の中で1つ上（afterId は2つ上の兄弟か \'\'）。親の最初の子では何も呼ばない。最上位は 0.13.0 のまま', T, async () => {
  const l = await openReal({ pa1: NEST() });
  try {
    const up = (id) => press(l, atEnd(l, id), 'ArrowUp', { ctrlKey: true, shiftKey: true, code: 'ArrowUp' });
    up('a3');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'a3', { afterId: 'a1' }]], '前の兄弟の子の中へ入った（edn-move-sibling）');
    l.calls.length = 0;
    // 並びは a1・a3・a2
    up('a3');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'a3', { afterId: '', parentId: 'a' }]]);
    l.calls.length = 0;
    up('a3');
    await l.drain();
    assert.deepStrictEqual(sent(l), [], '親の最初の子で呼んだ');
    // 並びは a3・a1・a2
    press(l, atEnd(l, 'a1'), 'ArrowDown', { ctrlKey: true, shiftKey: true, code: 'ArrowDown' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'a1', { afterId: 'a2' }]]);
    l.calls.length = 0;
    press(l, atEnd(l, 'a1'), 'ArrowDown', { ctrlKey: true, shiftKey: true, code: 'ArrowDown' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [], '親の最後の子で呼んだ');
    assert.deepStrictEqual(BT.locate(l.page().blocks, 'a').b.children.map((x) => x.id), ['a3', 'a2', 'a1']);
    l.calls.length = 0;
    up('n2');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'n2', { afterId: 'a' }]], '最上位は画面の最上位の並びで1つ上');
    assert.deepStrictEqual(shape(l.page().blocks).map((x) => (Array.isArray(x) ? x[0] : x)), ['h1', 'a', 'n2', 'n1', 'p', 'v', 'q']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a: Ctrl+D・⠿ の［複製］→ blockDuplicate の1回で、写しは子ごと元の行の後ろに描かれる。⠿ の［削除］は子ごと消え、フォーカスは上の行へ', T, async () => {
  const l = await openReal({ pa1: NEST() });
  try {
    press(l, atEnd(l, 'a2'), 'd', { ctrlKey: true, code: 'KeyD' });
    await l.drain();
    assert.deepStrictEqual(sent(l).map((c) => c.slice(0, 3)), [['blockDuplicate', 'pa1', 'a2']]);
    const ids = rowsOf(l).map((e) => [e.dataset.id, e.dataset.depth]);
    const at2 = ids.findIndex((x) => x[0] === 'a21');
    assert.strictEqual(ids[at2 + 1][1], '1', '写しが元の子の後ろの兄弟でない');
    assert.strictEqual(ids[at2 + 2][1], '2', '写しの子が描かれない');
    l.calls.length = 0;
    const t = atEnd(l, 'a');
    press(l, t, '/', { ctrlKey: true, code: 'Slash' });
    const m = $(l, 'pNote').querySelectorAll('.blockmenu').find((x) => !x.classList.contains('sub'));
    m.querySelectorAll('.mitem')[0].onclick();
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockRemove', 'pa1', 'a']]);
    assert.ok(!rowsOf(l).some((e) => ['a', 'a1', 'a2', 'a21', 'a3'].includes(e.dataset.id)), '子が残った');
    assert.strictEqual(l.document.activeElement, txtOf(l, 'h1'));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a・決めたこと 26: 文字起こしの行・メモ・題名で Tab・Shift+Tab を押しても何も呼ばれず、Tab は今どおり次の部品へ（既定を止めない）', T, async () => {
  const l = await openReal({ pa1: NEST() });
  try {
    for (const el of [$(l, 'pTitle'), $(l, 'pMemo').querySelector('textarea'), $(l, 'pScript').querySelector('.txt, [contenteditable]')].filter(Boolean)) {
      for (const shiftKey of [false, true]) {
        const ev = press(l, el, 'Tab', { shiftKey });
        assert.strictEqual(ev.defaultPrevented, false, `${el.id || el.className}: 既定の Tab を止めた`);
      }
    }
    await l.drain();
    assert.deepStrictEqual(sent(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a: 変換中（isComposing・keyCode 229）の Tab・Shift+Tab では何も呼ばれない', T, async () => {
  const l = await openReal({ pa1: NEST() });
  try {
    for (const o of [{ isComposing: true }, { keyCode: 229 }, { isComposing: true, shiftKey: true }]) press(l, atEnd(l, 'a3'), 'Tab', o);
    await l.drain();
    assert.deepStrictEqual(sent(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4a・F53 のまま: blockIndent の答えを待つ間に印の無い page:open で別のページが前に出ても、答えは描かない', T, async () => {
  const l = await openReal({ pa1: NEST(), pb2: [kid('z1')] }, { hold: ['blockIndent'] });
  try {
    press(l, atEnd(l, 'a3'), 'Tab');
    await l.drain();
    l.fire('onPageOpen', 'pb2');
    await l.drain();
    l.release();
    await l.drain();
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['z1'], '前のページの答えで描いた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- NE-4b: トグル・Ctrl+Alt+T・中へのドラッグ・覗き開き
test('NE-4b: 画面の写し（dropSpot）は src/blockTree.js と同じ答え', () => {
  const app = new Function(`${fnFromApp('dropSpot')}\nreturn dropSpot;`)();   // eslint-disable-line no-new-func
  const rows = [{ id: 'a', depth: 0, parentId: null, kids: true }, { id: 'a1', depth: 1, parentId: 'a', kids: true }, { id: 'a2', depth: 1, parentId: 'a', kids: true },
    { id: 'h', depth: 0, parentId: null, kids: false }, { id: 'b', depth: 0, parentId: null, kids: true }];
  for (let idx = 0; idx <= rows.length; idx++) {
    for (const shift of [-3, -1, 0, 1, 2, 0.6]) for (const o of [{}, { top: true }]) assert.deepStrictEqual(app(rows, idx, shift, o), BT.dropSpot(rows, idx, shift, o), `${idx} ${shift} ${JSON.stringify(o)}`);
  }
  assert.deepStrictEqual(app([], 0, 1), BT.dropSpot([], 0, 1));
});
const TOG = () => [
  { id: 'h1', type: 'heading', level: 2, text: '決定事項' },
  { id: 't', type: 'toggle', text: 'たたんだ話', citeState: 'manual', open: false, children: [kid('t1', 'todo', { checked: false }), kid('t2')] },
  { id: 'u', type: 'toggle', text: '開いた話', citeState: 'manual', children: [kid('u1')] },
  kid('x'),
  kid('e', 'paragraph', { text: '' }),
];
const caretBtn = (l, id) => rowOf(l, id).querySelector('.tog');
const ids = (l) => rowsOf(l).map((e) => e.dataset.id);

test('NE-4b・EQ10 (a): 空の行の頭で『> 』と打つと blockTurnInto（toggle）の1回で『> 』は消える。Ctrl+Shift+7 でトグル。/ メニューの『とぐる』でトグル、『とぐるみだし』でトグル見出し1〜3', T, async () => {
  const l = await openReal({ pa1: TOG() });
  try {
    let t = typeIn(l, 'e', '> ');
    t.dispatchEvent({ type: 'input' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 'e', 'toggle']]);
    assert.strictEqual(txtOf(l, 'e').textContent, '');
    assert.ok(rowOf(l, 'e').classList.contains('toggle'));
    l.calls.length = 0;
    press(l, atEnd(l, 'x'), "'", { ctrlKey: true, shiftKey: true, code: 'Digit7' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 'x', 'toggle']]);
    l.calls.length = 0;
    t = typeIn(l, 'u1', '/とぐる');
    t.dispatchEvent({ type: 'input' });
    assert.deepStrictEqual($(l, 'pNote').querySelector('.slashmenu').querySelectorAll('.sopt').map((o) => o.dataset.key), ['toggle', 'th1', 'th2', 'th3']);
    t = typeIn(l, 'u1', 'u1の文 /とぐるみだし');
    t.dispatchEvent({ type: 'input' });
    assert.deepStrictEqual($(l, 'pNote').querySelector('.slashmenu').querySelectorAll('.sopt').map((o) => o.dataset.key), ['th1', 'th2', 'th3']);
    press(l, t, 'ArrowDown');
    press(l, t, 'Enter');
    await l.drain();
    // 文のある行（u1の文）なので下に足す。トグル見出し2（段 2・toggle）。行の文は変わっていないので blockUpdate は送らない
    assert.deepStrictEqual(sent(l).map((c) => c.slice(0, 1).concat(c.slice(3))), [['blockInsert', 'heading', 2, undefined, true]]);
    const added = BT.flattenBlocks(l.page().blocks).find((b) => b.type === 'heading' && b.toggle === true);
    assert.ok(added && added.level === 2, 'トグル見出し2 を足せない');
    // 最近使ったものに覚えた th2 は、次に起動したときの照らし（winstate.normalize が使う blockEdit.recentCheck）でも残る（NR5・edn-menu-keys）
    const saved = l.called('uiSave').map((c) => c.args[0]).filter((x) => x && x.slashRecent !== undefined).map((x) => x.slashRecent);
    assert.deepStrictEqual(saved, [['th2']]);
    assert.deepStrictEqual(E.recentCheck(saved[0]), ['th2'], '覚えたトグル見出しが次の起動で落ちる');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4b: トグルの行に ▸（aria-expanded）。押すと blockSetOpen の1回で子が隠れ・出る。Ctrl+Enter も同じ（決めたこと 28）。閉じたトグルの子は DOM に無く、↓ は閉じたトグルの次の兄弟へ（visibleOrder）', T, async () => {
  const l = await openReal({ pa1: TOG() });
  try {
    assert.deepStrictEqual(ids(l), ['h1', 't', 'u', 'u1', 'x', 'e'], '閉じたトグルの子を描いた');
    const bt = caretBtn(l, 't');
    assert.ok(bt, 'トグルに ▸ が無い');
    assert.deepStrictEqual([bt.getAttribute('aria-expanded'), bt.title, bt.getAttribute('aria-label')], ['false', '開く', '開く']);
    assert.strictEqual(caretBtn(l, 'u').getAttribute('aria-expanded'), 'true');
    assert.strictEqual(caretBtn(l, 'u').title, '閉じる');
    assert.strictEqual(caretBtn(l, 'x'), null, 'トグルでない行に ▸');
    bt.onclick();
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSetOpen', 'pa1', 't', true]]);
    assert.deepStrictEqual(ids(l), ['h1', 't', 't1', 't2', 'u', 'u1', 'x', 'e']);
    assert.strictEqual(caretBtn(l, 't').getAttribute('aria-expanded'), 'true');
    l.calls.length = 0;
    press(l, atEnd(l, 'u'), 'Enter', { ctrlKey: true, code: 'Enter' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSetOpen', 'pa1', 'u', false]]);
    assert.ok(!ids(l).includes('u1'));
    assert.strictEqual(l.document.activeElement, txtOf(l, 'u'), 'Ctrl+Enter の後に行のフォーカスが無い');
    // ↓ は閉じたトグルの次の兄弟へ
    const t = atEnd(l, 'u');
    press(l, t, 'ArrowDown');
    assert.strictEqual(l.document.activeElement, txtOf(l, 'x'));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4b・EQ19 (a): Ctrl+Alt+T → blockSetOpenAll の1回（1つでも閉じていれば open: true、全部開いていれば false）。トグルが無ければ何も呼ばない', T, async () => {
  const l = await openReal({ pa1: TOG(), pb2: [kid('z1')] });
  try {
    const ct = (id) => press(l, atEnd(l, id), 't', { ctrlKey: true, altKey: true, code: 'KeyT' });
    let ev = ct('x');
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    assert.deepStrictEqual(sent(l), [['blockSetOpenAll', 'pa1', true]]);
    assert.deepStrictEqual(ids(l), ['h1', 't', 't1', 't2', 'u', 'u1', 'x', 'e']);
    l.calls.length = 0;
    ct('x');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSetOpenAll', 'pa1', false]]);
    assert.deepStrictEqual(ids(l), ['h1', 't', 'u', 'x', 'e']);
    l.calls.length = 0;
    l.fire('onPageOpen', 'pb2');
    await l.drain();
    ev = ct('z1');
    await l.drain();
    assert.deepStrictEqual(sent(l), [], 'トグルが無いのに呼んだ');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4b・NR14: ▸ を押しても curPage.summaryEdited は付かず、［要約を再生成］で確かめが出ない（ほかに直していない要約のとき）', T, async () => {
  const ai = [{ id: 'h1', type: 'heading', level: 2, text: '決定事項', toggle: true, open: false, children: [{ id: 'b1', type: 'bullet', text: '来週に出す', cites: ['s2'], citeState: 'linked' }] }];
  const l = await openReal({ pa1: ai }, { returns: { pageSummarize: () => ({ ok: true, stat: { linked: 1, total: 1 } }) } });
  try {
    caretBtn(l, 'h1').onclick();
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSetOpen', 'pa1', 'h1', true]]);
    assert.strictEqual(l.page().summaryEdited, undefined, '開け閉めが手直しの印を付けた');
    const btn = $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === '要約を再生成');
    const run = btn.onclick();
    await l.drain();
    assert.strictEqual(l.document.querySelector('.askbox'), null, '開け閉めだけで確かめが出た');
    await run;
    assert.strictEqual(l.called('pageSummarize').length, 1);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4b・NR16: 鍵の間の ▸ は画面だけで開け閉めし、blockSetOpen を呼ばない。ページを替えると戻る', T, async () => {
  const l = await openReal({ pa1: { blocks: TOG(), summaryWait: true, summaryError: '要約待ち（つながったら作ります）' }, pb2: [kid('z1')] });
  try {
    assert.ok($(l, 'sumLock'), '鍵の一言が無い');
    assert.ok(caretBtn(l, 't'), '鍵の間に ▸ が無い');
    caretBtn(l, 't').onclick();
    await l.drain();
    assert.deepStrictEqual(sent(l), [], '鍵の間に blockSetOpen を呼んだ（edn-open-lock）');
    assert.deepStrictEqual(ids(l), ['h1', 't', 't1', 't2', 'u', 'u1', 'x', 'e']);
    l.fire('onPageOpen', 'pb2');
    await l.drain();
    l.fire('onPageOpen', 'pa1');
    await l.drain();
    assert.deepStrictEqual(ids(l), ['h1', 't', 'u', 'u1', 'x', 'e'], 'ページを替えても画面だけの開け閉めが残った');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4b・NR18: リンクの印 b:<閉じたトグルの中の行> で開くと、親のトグルが画面だけで開き、その行が光る（blockSetOpen は呼ばない）。Tab で閉じたトグルの中へ入れた行も見える。覗き開きのトグルの ▸ を押すと blockSetOpen(false)', T, async () => {
  const l = await openReal({ pa1: TOG() });
  try {
    l.fire('onOpenLink', { id: 'pa1', anchor: 'b:t2' });
    await l.drain();
    assert.ok(ids(l).includes('t2'), '閉じたトグルの中の行が見えない（edn-peek）');
    assert.ok(rowOf(l, 't2').classList.contains('linkhit'));
    assert.deepStrictEqual(sent(l), []);
    assert.strictEqual(caretBtn(l, 't').getAttribute('aria-expanded'), 'true');
    caretBtn(l, 't').onclick();
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSetOpen', 'pa1', 't', false]], '覗き開きの ▸ が見えている形の逆を書かない');
    assert.ok(!ids(l).includes('t2'));
    l.calls.length = 0;
    // x を閉じたトグル u の中へ（u を閉じてから Tab）
    caretBtn(l, 'u').onclick();
    await l.drain();
    l.calls.length = 0;
    press(l, atEnd(l, 'x'), 'Tab');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockIndent', 'pa1', 'x', 'in']]);
    assert.ok(ids(l).includes('x'), '閉じたトグルの中へ入れた行が見えない');
    assert.strictEqual(rowOf(l, 'x').dataset.parent, 'u');
    assert.strictEqual(l.document.activeElement, txtOf(l, 'x'));
    assert.strictEqual(BT.locate(l.page().blocks, 'u').b.open, false, '覗き開きを DB に書いた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ⠿ で引っ張って落とす（行の高さ 10・左の位置を clientX で。dragstart の clientX が掴んだ所）
function dragTo(l, id, clientY, clientX, o = {}) {
  const box = $(l, 'pNote');
  const els = box.querySelectorAll('.blk');
  els.forEach((e, i) => { e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: 0, right: 100, width: 100 }); });
  els.find((e) => e.dataset.id === id).ondragstart({ dataTransfer: { setData() {}, effectAllowed: '' }, clientX: 100 });
  box.ondragover({ preventDefault() {}, clientY, clientX, dataTransfer: {} });
  const line = box.querySelectorAll('.dropmark, .dropmark-after')[0] || null;
  const shift = line ? line.style.getPropertyValue('--dropx') : null;
  return { done: box.ondrop({ preventDefault() {}, clientY, clientX, ...o }), line, shift };
}

test('NE-4b・NR12: ⠿ で引っ張って右へずらして落とすと blockMove の { afterId: \'\', parentId: 上の行 }。ずらさなければ上の行と同じ段（afterId は上の行）。子の後ろで左へずらすと親の段（afterId は親）。いちばん上へ落とすと { afterId: \'\' }（R28）。落とす線は選んだ段から', T, async () => {
  const blocks = [kid('a', 'bullet', { children: [kid('a1'), kid('a2')] }), kid('b'), kid('c'), kid('d')];
  const l = await openReal({ pa1: blocks });
  try {
    // 見えている行: a a1 a2 b c d。d を c の下（位置 5 の上半分 → idx 4 の後ろ）へ、右へ 24px ずらす → c の子の頭
    let r = dragTo(l, 'd', 4 * 10 + 8, 124);
    await r.done; await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'd', { afterId: '', parentId: 'c' }]]);
    assert.strictEqual(rowOf(l, 'd').dataset.parent, 'c');
    l.calls.length = 0;
    // b を a2 の下へ、ずらさずに → a2 と同じ段（afterId a2）
    r = dragTo(l, 'b', 2 * 10 + 8, 100);
    assert.strictEqual(r.line.dataset.id, 'c', '印は落とす所の下の行');
    assert.strictEqual(r.shift, '24px', '落とす線が選んだ段（a2 と同じ段 1）から引かれない（c は段 0）');
    await r.done; await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'b', { afterId: 'a2' }]]);
    l.calls.length = 0;
    // 見えている行: a a1 a2 b c d。c（と子 d）を外して a a1 a2 b。c を b（a の最後の子）の下へ左へ 24px → 親 a の段（afterId a）
    r = dragTo(l, 'c', 3 * 10 + 8, 76);
    await r.done; await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'c', { afterId: 'a' }]], '子の後ろに親の段で落とせない（edn-drop-depth）');
    assert.deepStrictEqual(shape(l.page().blocks), [['a', ['a1', 'a2', 'b']], ['c', ['d']]]);
    assert.deepStrictEqual(ids(l), ['a', 'a1', 'a2', 'b', 'c', 'd']);
    l.calls.length = 0;
    r = dragTo(l, 'c', 0, 150);
    await r.done; await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'c', { afterId: '' }]], 'いちばん上へ落とせない（R28）');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4b・TQ2: AI の節の見出しを右へずらして落としても子にならない（同じ段）', T, async () => {
  const blocks = [kid('a'), kid('b'), { id: 'h', type: 'heading', level: 2, text: 'その他の話' }];
  const l = await openReal({ pa1: blocks });
  try {
    const r = dragTo(l, 'h', 1 * 10 + 8, 124);
    await r.done; await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'h', { afterId: 'b' }]]);
    assert.strictEqual(rowOf(l, 'h').dataset.depth, '0');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4b・TQ4: 『> 』で作ったトグルは開いていて、終わりで Enter → 最初の子', T, async () => {
  const l = await openReal({ pa1: TOG() });
  try {
    const t = typeIn(l, 'e', '> 議題');
    l.caret.set(t, 2);
    t.dispatchEvent({ type: 'input' });
    await l.drain();
    assert.strictEqual(caretBtn(l, 'e').getAttribute('aria-expanded'), 'true', '新しいトグルが閉じている（edn-toggle-default）');
    l.calls.length = 0;
    press(l, atEnd(l, 'e'), 'Enter');
    await l.drain();
    assert.deepStrictEqual(sent(l).map((c) => c.slice(0, 2).concat(c.slice(6))), [['blockSplit', 'pa1', true]]);
    const e = BT.locate(l.page().blocks, 'e').b;
    assert.strictEqual(e.children.length, 1);
    assert.strictEqual(e.children[0].type, 'paragraph');
    assert.strictEqual(l.document.activeElement, txtOf(l, e.children[0].id));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('NE-4b・NR7: 子のある行の ⠿ の［変換 ▸］で区切り線は灰色（title『中に行のある行は区切り線にできません』）', T, async () => {
  const l = await openReal({ pa1: [kid('p', 'bullet', { text: '', children: [kid('k')] }), kid('q', 'bullet', { text: '' })] });
  try {
    const sub = (id) => {
      press(l, atEnd(l, id), '/', { ctrlKey: true, code: 'Slash' });
      const m = $(l, 'pNote').querySelectorAll('.blockmenu').find((x) => !x.classList.contains('sub'));
      m.querySelectorAll('.mitem')[2].onclick();
      const s = $(l, 'pNote').querySelectorAll('.blockmenu').find((x) => x.classList.contains('sub'));
      return s.querySelectorAll('.mitem').find((x) => x.dataset.key === 'divider');
    };
    let d = sub('p');
    assert.deepStrictEqual([d.getAttribute('aria-disabled'), d.title], ['true', '中に行のある行は区切り線にできません']);
    l.key({ key: 'Escape' }, l.document.activeElement); l.key({ key: 'Escape' }, l.document.activeElement);
    d = sub('q');
    assert.strictEqual(d.getAttribute('aria-disabled'), null, '文も子も無い行の区切り線が灰色');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
