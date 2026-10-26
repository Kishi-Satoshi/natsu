/*
 * stage130.edit.app.test.js — 0.13.0 第1部「編集の動き その1」の画面（計画 docs/plans/2026-10-24-130.md の Task ED-3〜ED-7）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { titleAt } = require('./helpers/titles');
const lib = require('../src/mainlib');
const M = require('../src/memoTypes');
const E = require('../src/blockEdit');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const HTML = fs.readFileSync(APP, 'utf8');
const T = { timeout: 8000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const T1 = titleAt('2026-10-26T01:00:00.000Z');
const SEGS = [{ id: 's1', atMs: 0, durationMs: 5000, text: '来月の予算案は担当Aさんが進めます' }];
const fnFromApp = (name) => {
  const at = HTML.indexOf(`  function ${name}(`);
  assert.ok(at > 0, `app.html に ${name} が無い`);
  return HTML.slice(at, HTML.indexOf('\n  }\n', at) + 4);
};

// 保存したページを開く。cur は DB の今のページ（命令の答えで直す）。calls に IPC の呼び出し（[名前, ...引数]）
async function openPage(page, o = {}) {
  const calls = [];
  let cur = { id: 'pa1', title: T1, date: '2026-10-26', createdAt: '2026-10-26T01:00:00.000Z', durationSec: 1800, memo: '', summaryError: '', meetingType: 'general', typeAuto: false,
    route: { stt: { cloud: 1, local: 0, provider: 'openai' }, summary: { by: 'claude-code' } }, ...page };
  const list = () => [{ id: cur.id, title: cur.title, date: cur.date, durationSec: cur.durationSec, hasSummary: true, meetingType: cur.meetingType }];
  const l = await load(APP, {
    returns: {
      meetingTypes: () => lib.typesForView(), memoTypes: () => M.listMemoTypes(), pagesSearch: list, pagesList: list,
      pageGet: () => ({ page: JSON.parse(JSON.stringify(cur)), segments: SEGS }),
      copy: (t) => { calls.push(['copy', t]); return true; },
      ...(o.returns ? o.returns(() => cur, (p) => { cur = p; }, calls) : {}),
    },
    ...(o.load || {}),
  });
  await l.drain();
  l.byId.get('plist').querySelectorAll('.pitem')[0].dispatchEvent({ type: 'click' });
  await l.drain();
  l.calls130 = calls;
  return l;
}

// ---------------------------------------------------------------- ED-3（決めたこと 22）
test('ED-3: ［コピー］の Markdown は blocksMarkdown の写し（app.html）で、src/blockEdit.js と同じ答え（段 1〜3・番号付き・引用・区切り線・コールアウト・今の4つの型）', () => {
  const app = new Function(`const CALLOUT_ICON = '💡';\n${fnFromApp('headingLevel')}\n${fnFromApp('numberLabels')}\n${fnFromApp('blocksMarkdown')}\nreturn { blocksMarkdown, numberLabels };`)();   // eslint-disable-line no-new-func
  const tables = [[], undefined, [{ id: 'a', type: 'heading', text: '決定事項' }, { id: 'b', type: 'bullet', text: '行' }, { id: 'c', type: 'todo', text: 'やる', checked: true }, { id: 'd', type: 'paragraph', text: '本文' }],
    [{ id: 'h1', type: 'heading', level: 1, text: '一' }, { id: 'h3', type: 'heading', level: 3, text: '三' }, { id: 'n1', type: 'numbered', text: 'a' }, { id: 'n2', type: 'numbered', text: 'b' },
      { id: 'x', type: 'bullet', text: 'c\nd' }, { id: 'n3', type: 'numbered', text: 'e' }, { id: 'q', type: 'quote', text: 'f' }, { id: 'v', type: 'divider', text: '' }, { id: 'c', type: 'callout', text: 'g' }, { id: 'z', type: 'video', text: 'h' }]];
  for (const t of tables) assert.strictEqual(app.blocksMarkdown(t), E.blocksMarkdown(t), JSON.stringify(t));
  for (const t of tables.slice(2)) assert.deepStrictEqual([...app.numberLabels(t)], [...E.numberLabels(t)]);
});

test('ED-3: 要約の欄の［コピー］が見出しを段の数の # で写す（画面の順・今の型は前と同じ）', T, async () => {
  const blocks = [{ id: 'h1', type: 'heading', level: 1, text: '全体の結論' }, { id: 'b1', type: 'bullet', text: '来週に出す', cites: ['s1'], citeState: 'linked' },
    { id: 'h2', type: 'heading', level: 2, text: '決定事項' }, { id: 'n1', type: 'numbered', text: '一つ目' }, { id: 'h3', type: 'heading', level: 3, text: '細かい決めごと' },
    { id: 'p1', type: 'paragraph', text: '本文' }];
  const l = await openPage({ blocks });
  const btn = $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === 'コピー');
  await btn.onclick();
  await l.drain();
  const want = E.blocksMarkdown(M.orderForView(blocks).map((i) => blocks[i])).trim();
  assert.deepStrictEqual(l.calls130.filter((c) => c[0] === 'copy').map((c) => c[1]), [want]);
  assert.ok(want.includes('\n### 細かい決めごと') && want.includes('\n# 全体の結論') && want.includes('1. 一つ目'), want);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- ED-4（決めたこと 15〜19・21・41。F40〜F43・F47・F53）
// 一時の DB（helpers/dbtmp.js）を本当に通す画面。pages は { ID: ブロックの並び }。hold の名前の命令は l.release() まで答えを止める。
// カーソルは simrun の caret の継ぎ目（l.caret）で置く
const { tmpDb, samplePage } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const NOW4 = () => new Date('2026-10-26T01:02:03.000Z');
let tx4 = 0;
const ED4_CMDS = {
  blockUpdate: (pageId, blockId, patch) => ['block.update', { pageId, blockId, patch }],
  blockInsert: (pageId, afterBlockId, type, level) => ['block.insert', level === undefined ? { pageId, afterBlockId, type } : { pageId, afterBlockId, type, level }],
  blockRemove: (pageId, blockId) => ['block.remove', { pageId, blockId }],
  blockSplit: (pageId, blockId, text, at) => ['block.split', { pageId, blockId, text, at }],
  blockMerge: (pageId, blockId, text) => ['block.merge', { pageId, blockId, text }],
  blockTurnInto: (pageId, blockId, type, level) => ['block.turnInto', level === undefined ? { pageId, blockId, type } : { pageId, blockId, type, level }],
  blockSetAction: (pageId, blockId, assignee, dueRaw) => ['block.setAction', { pageId, blockId, assignee, dueRaw }],
};
async function openReal(pages, o = {}) {
  const t = tmpDb();
  const { db } = t.open();
  for (const [id, v] of Object.entries(pages)) {
    const { page, segments } = samplePage(id);
    const o2 = Array.isArray(v) ? { blocks: v } : v;
    t.seed({ ...page, title: o2.title || T1, blocks: o2.blocks }, segments);
  }
  const call = (cmd, args) => {
    const r = core.call(db, { role: 'app', cmd, args, tx: `a:ed4-${String(++tx4).padStart(6, '0')}` }, { now: NOW4, labels: {} });
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
    pagesSearch: () => call('pages.list', { q: '' }), pageGet: (id) => call('page.get', { id }),
    ...(o.returns || {}),
  };
  for (const [name, f] of Object.entries(ED4_CMDS)) returns[name] = wrap(name, (...a) => call(...f(...a)));
  const l = await load(APP, { caret: true, returns });
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
const ED4_CALLS = ['blockSplit', 'blockMerge', 'blockTurnInto', 'blockInsert', 'blockRemove', 'blockUpdate', 'blockMove'];
const sent = (l) => l.calls.filter((c) => ED4_CALLS.includes(c.method)).map((c) => [c.method, ...c.args]);
const BASE = (x = '') => [{ id: `h1${x}`, type: 'heading', level: 2, text: '決定事項' }, { id: `b1${x}`, type: 'bullet', text: '来週に出す', cites: ['s2'], citeState: 'linked' },
  { id: `p1${x}`, type: 'paragraph', text: 'あいうえお' }, { id: `e1${x}`, type: 'paragraph', text: '' }];
// 文を打った形にする（blur は来ない）。カーソルを置く
function typeIn(l, id, text, at = text.length, end = at) {
  const t = txtOf(l, id);
  t.focus();
  t.textContent = text;
  l.caret.set(t, at, end);
  return t;
}

test('ED-4: 行の編集の写し（app.html の graphemeEnds・safeOffset・shortcutFor・isTypedView・patchPlan・lisIndexes）は src/blockEdit.js と同じ答え', () => {
  const src = ['graphemeEnds', 'safeOffset', 'shortcutFor', 'isTypedView', 'patchPlan', 'lisIndexes'].map(fnFromApp).join('\n');
  const head = HTML.slice(HTML.indexOf('  const MD_ZEN = '), HTML.indexOf('\n', HTML.indexOf('  const MD_ROWS = ')) + 1);
  const typed = HTML.slice(HTML.indexOf('  const TYPED_VIEW = '), HTML.indexOf('\n', HTML.indexOf('  const TYPED_VIEW = ')) + 1);
  const app = new Function(`${head}${typed}${src}\nreturn { safeOffset, shortcutFor, isTypedView, patchPlan };`)();   // eslint-disable-line no-new-func
  for (const [s, at] of [['a𠮷b', 2], ['a𠮷b', 3], ['👨‍👩‍👧x', 3], ['が', 1], ['', 5], ['abc', -1], ['abc', 9], ['abc', 1.7], ['がき', 1]]) {
    assert.strictEqual(app.safeOffset(s, at), E.safeOffset(s, at), `${s} ${at}`);
  }
  for (const before of ['- ', '* ', '+ ', '[] ', '1. ', '" ', '# ', '## ', '### ', '#### ', '---', '－　', '＃　', '［］　', '１．　', '”　', 'あ- ', '-', '1.5', 'ー ', '・ ', '> ', '-- ', '- a', '']) {
    for (const full of [undefined, before, `${before}x`]) assert.deepStrictEqual(app.shortcutFor(before, { full }), E.shortcutFor(before, { full }), `${before}|${full}`);
  }
  for (const b of [null, {}, { type: 'paragraph' }, { type: 'heading' }, { type: 'heading', level: 3 }, { type: 'todo' }, { type: 'bullet' }, { type: 'numbered' },
    { type: 'quote' }, { type: 'divider' }, { type: 'callout' }, { type: 'toggle' }, { type: 'video' }]) assert.strictEqual(app.isTypedView(b), E.isTyped(b), JSON.stringify(b));
  const a = { id: 'a', text: '1' }, b = { id: 'b', text: '2' }, c = { id: 'c', text: '3' }, d = { id: 'd', text: '4' };
  for (const [x, y] of [[[a, b, c], [a, b, c]], [[a, b, c], [a, { ...b, text: 'x' }, d, c]], [[a, b, c], [c, a, b]], [[a, b, c, d], [b, a, d, c]], [[], [a]], [[a], []]]) {
    assert.deepStrictEqual(app.patchPlan(x, y), E.patchPlan(x, y));
  }
});

test('ED-4・F40・F41: 行に打って blur せず、カーソルを途中に置いて Enter → blockSplit が1回だけ（text は今の文・at はカーソル）。blockUpdate・blockInsert は呼ばれない', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const before = rowsOf(l);
    const t = typeIn(l, 'b1', '来週の月曜に出す', 3);
    const ev = l.key({ key: 'Enter' }, t);
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'b1', '来週の月曜に出す', 3]]);
    const blocks = l.page().blocks;
    const nb = blocks[2];
    assert.deepStrictEqual(blocks.slice(0, 3).map((b) => [b.id === nb.id ? 'new' : b.id, b.type, b.text]), [['h1', 'heading', '決定事項'], ['b1', 'bullet', '来週の'], ['new', 'bullet', '月曜に出す']]);
    // 分割の後、新しい行にフォーカスがあり、カーソルは頭。ほかの行の要素は前と同じもの（作り直さない: E4・F47）
    const after = rowsOf(l);
    assert.deepStrictEqual(after.map((e) => e.dataset.id), ['h1', 'b1', nb.id, 'p1', 'e1']);
    for (const e of before) assert.ok(after.includes(e), `${e.dataset.id} の行が作り直された`);
    assert.strictEqual(l.document.activeElement, txtOf(l, nb.id));
    assert.deepStrictEqual(l.caret.get(txtOf(l, nb.id)), [0, 0]);
    assert.strictEqual(txtOf(l, 'b1').textContent, '来週の');
    assert.strictEqual(txtOf(l, nb.id).textContent, '月曜に出す');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-4・F40: カーソルが「𠮷」の途中なら書記素の境に寄せて分ける（文字化けしない）', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'p1', 'a𠮷b', 2);
    l.key({ key: 'Enter' }, t);
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'p1', 'a𠮷b', 3]]);
    assert.deepStrictEqual(l.page().blocks.slice(2, 4).map((b) => b.text), ['a𠮷', 'b']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-4: Shift+Enter は命令を送らず、文に改行が入る。blur で blockUpdate の text に \\n がある', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'p1', 'あいうえお', 2);
    const ev = l.key({ key: 'Enter', shiftKey: true }, t);
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    assert.deepStrictEqual(sent(l), []);
    assert.strictEqual(t.textContent, 'あい\nうえお');
    assert.deepStrictEqual(l.caret.get(t), [3, 3]);
    t.dispatchEvent({ type: 'blur' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockUpdate', 'pa1', 'p1', { text: 'あい\nうえお' }]]);
    assert.strictEqual(l.page().blocks[2].text, 'あい\nうえお');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-4: テキストの行の頭で Backspace → blockMerge の1回（前の行の終わりへ）。型の付いた行の頭なら blockTurnInto（paragraph）の1回（EQ6 (a)）。途中の Backspace は何もしない', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    // 途中: 何もしない（文字を消すのは本物の動き）
    let t = typeIn(l, 'p1', 'あいうえおか', 2);
    let ev = l.key({ key: 'Backspace' }, t);
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, false);
    assert.deepStrictEqual(sent(l), []);
    // テキストの行の頭: 打った文ごと前の行につなぐ
    l.caret.set(t, 0);
    ev = l.key({ key: 'Backspace' }, t);
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    assert.deepStrictEqual(sent(l), [['blockMerge', 'pa1', 'p1', 'あいうえおか']]);
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['h1', 'b1', 'e1']);
    assert.strictEqual(txtOf(l, 'b1').textContent, '来週に出すあいうえおか');
    assert.strictEqual(l.document.activeElement, txtOf(l, 'b1'));
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'b1')), [5, 5]);
    // 型の付いた行（箇条書き）の頭: テキストに戻すだけ（つながない）
    l.calls.length = 0;
    t = txtOf(l, 'b1');
    l.caret.set(t, 0);
    l.key({ key: 'Backspace' }, t);
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 'b1', 'paragraph']]);
    assert.strictEqual(l.page().blocks[1].type, 'paragraph');
    assert.ok(rowOf(l, 'b1').classList.contains('paragraph'));
    assert.strictEqual(l.document.activeElement, txtOf(l, 'b1'));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-4: ↑ を行の頭で押すと上の行の終わりへ、↓ を終わりで押すと下の行の頭へ（EQ14 (a)）。途中では本物の動きのまま', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'p1', 'あいうえお', 2);
    let ev = l.key({ key: 'ArrowUp' }, t);
    assert.strictEqual(ev.defaultPrevented, false);
    assert.strictEqual(l.document.activeElement, t);
    l.caret.set(t, 0);
    ev = l.key({ key: 'ArrowUp' }, t);
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(l.document.activeElement, txtOf(l, 'b1'));
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'b1')), [5, 5]);
    ev = l.key({ key: 'ArrowDown' }, txtOf(l, 'b1'));
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(l.document.activeElement, t);
    assert.deepStrictEqual(l.caret.get(t), [0, 0]);
    await l.drain();
    assert.deepStrictEqual(sent(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-4・F43: 空の行の頭で「- 」と打つと blockTurnInto（bullet）の1回で、打った「- 」は消える。「あ- 」では変わらない', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    let t = typeIn(l, 'e1', 'あ- ', 3);
    t.dispatchEvent({ type: 'input' });
    await l.drain();
    assert.deepStrictEqual(sent(l), []);
    assert.strictEqual(t.textContent, 'あ- ');
    t = typeIn(l, 'e1', '- ', 2);
    t.dispatchEvent({ type: 'input' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 'e1', 'bullet']]);
    assert.strictEqual(txtOf(l, 'e1').textContent, '');
    assert.ok(rowOf(l, 'e1').classList.contains('bullet'));
    assert.strictEqual(l.page().blocks[3].type, 'bullet');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-4・F43: 変換中（compositionstart の後の input）は記法で変わらず、compositionend の後に決める', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = txtOf(l, 'e1');
    t.focus();
    t.dispatchEvent({ type: 'compositionstart' });
    t.textContent = '－　';
    l.caret.set(t, 2);
    t.dispatchEvent({ type: 'input', isComposing: true });
    await l.drain();
    assert.deepStrictEqual(sent(l), []);
    assert.strictEqual(t.textContent, '－　');
    t.dispatchEvent({ type: 'compositionend' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 'e1', 'bullet']]);
    assert.strictEqual(t.textContent, '');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-4: 変換確定の Enter（isComposing・keyCode 229）と変換中の Backspace では、どの命令も呼ばれない', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'p1', 'あいうえお', 0);
    for (const ev of [{ key: 'Enter', isComposing: true }, { key: 'Enter', keyCode: 229 }, { key: 'Backspace', keyCode: 229 }, { key: 'Backspace', isComposing: true }]) {
      const e = l.key(ev, t);
      assert.strictEqual(e.defaultPrevented, false, JSON.stringify(ev));
    }
    await l.drain();
    assert.deepStrictEqual(sent(l), []);
    assert.strictEqual(t.textContent, 'あいうえお');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-4・F43: 貼り付けは text/plain だけを入れ（改行は行の中の改行）、HTML の要素は行に入らず、記法でも変わらない', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'e1', '', 0);
    const data = { 'text/plain': '- a\r\nb', 'text/html': '<b>- a</b><br>b' };
    let prevented = false;
    t.dispatchEvent({ type: 'paste', clipboardData: { getData: (k) => data[k] || '' }, preventDefault() { prevented = true; } });
    await l.drain();
    assert.strictEqual(prevented, true);
    assert.strictEqual(t.textContent, '- a\nb');
    assert.strictEqual(t.children.length, 0);
    assert.deepStrictEqual(l.caret.get(t), [5, 5]);
    assert.deepStrictEqual(sent(l), []);
    // 選んだ所は置き換える
    l.caret.set(t, 0, 3);
    t.dispatchEvent({ type: 'paste', clipboardData: { getData: (k) => (k === 'text/plain' ? 'X' : '<i>X</i>') }, preventDefault() {} });
    assert.strictEqual(t.textContent, 'X\nb');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-4: 要約の行に打っている途中にページを替える・［＋ 新しい議事録］を押すと、移る前に文が保存される（flushEdits）', T, async () => {
  let status = { active: false };
  const l = await openReal({ pa1: BASE(), pb2: BASE('x') }, {
    returns: {
      meetingStatus: () => status,
      meetingPrepare: () => { status = { active: false, prep: { memo: '', meetingType: null } }; return { ok: true }; },
    },
  });
  try {
    typeIn(l, 'p1', 'ページを替える前の文', 3);
    l.fire('onPageOpen', 'pb2');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockUpdate', 'pa1', 'p1', { text: 'ページを替える前の文' }]]);
    assert.strictEqual(l.page('pa1').blocks[2].text, 'ページを替える前の文');
    l.calls.length = 0;
    typeIn(l, 'p1x', '新しい議事録の前の文', 1);
    await $(l, 'mtToggleBtn').onclick();
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockUpdate', 'pb2', 'p1x', { text: '新しい議事録の前の文' }]]);
    assert.strictEqual(l.page('pb2').blocks[2].text, '新しい議事録の前の文');
    assert.strictEqual(rowsOf(l).length, 0);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-4・F53: blockSplit の答えを待つ間に印の無い page:open（知らせを押した形）で別のページが前に出ると、答えが来ても新しいページの行は前のまま・フォーカスは動かない（決めたこと 41）', T, async () => {
  const other = [{ id: 'q1', type: 'bullet', text: '別のページの行' }, { id: 'q2', type: 'paragraph', text: '二つ目' }];
  const l = await openReal({ pa1: BASE(), pb2: other }, { hold: ['blockSplit'] });
  try {
    const t = typeIn(l, 'b1', '来週の月曜に出す', 3);
    l.key({ key: 'Enter' }, t);
    await l.drain();
    l.fire('onPageOpen', 'pb2');
    await l.drain();
    const rows = rowsOf(l);
    assert.deepStrictEqual(rows.map((e) => e.dataset.id), ['q1', 'q2']);
    const focus = l.document.activeElement;
    l.release();
    await l.drain();
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['q1', 'q2']);
    for (const e of rows) assert.ok(rowsOf(l).includes(e), '新しいページの行が作り直された');
    assert.strictEqual(l.document.activeElement, focus);
    assert.deepStrictEqual(rowsOf(l).map((e) => e.querySelector('.txt').textContent), ['別のページの行', '二つ目']);
    // 前のページの文は blockSplit の text で送られて保存されている（blur の保存は重ねない）
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'b1', '来週の月曜に出す', 3]]);
    assert.deepStrictEqual(l.page('pa1').blocks.slice(1, 3).map((b) => b.text), ['来週の', '月曜に出す']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- ED-5（E1・E2・決めたこと 23・30・37〜42。EQ7・EQ8・EQ22 (a)。F42・F52・F53）
const T2 = titleAt('2026-10-26T02:00:00.000Z');
const slashBoxOf = (l) => $(l, 'pNote').querySelector('.slashmenu');
const optsOf = (l) => (slashBoxOf(l) ? slashBoxOf(l).querySelectorAll('.sopt') : []);
const keysOf = (l) => optsOf(l).map((o) => o.dataset.key);
const headsOf = (l) => (slashBoxOf(l) ? slashBoxOf(l).querySelectorAll('.shead').map((h) => h.textContent) : []);
// 行に打って input を起こす（カーソルは終わり）
function typeInput(l, id, text, at = text.length) {
  const t = typeIn(l, id, text, at);
  t.dispatchEvent({ type: 'input' });
  return t;
}
const recentSaves = (l) => l.called('uiSave').map((c) => c.args[0]).filter((x) => x && x.slashRecent !== undefined);

test('ED-5: / メニューの写し（app.html の SLASH_ROWS・slashQuery・slashFilter・recentAdd・recentCheck）は src/blockEdit.js の VERSION_ROWS と部品と同じ答え', () => {
  const at = HTML.indexOf('  const SLASH_ROWS = [');
  const rowsSrc = HTML.slice(at, HTML.indexOf('\n  ];\n', at) + 6) + HTML.slice(HTML.indexOf('  const MENU_KEYS_VIEW = '), HTML.indexOf('\n', HTML.indexOf('  const MENU_KEYS_VIEW = ')) + 1);
  const src = ['slashQuery', 'slashHit', 'slashFilter', 'recentAdd', 'recentCheck'].map(fnFromApp).join('\n');
  const app = new Function(`${rowsSrc}${src}\nreturn { SLASH_ROWS, MENU_KEYS_VIEW, slashQuery, slashFilter, recentAdd, recentCheck };`)();   // eslint-disable-line no-new-func
  assert.deepStrictEqual(app.SLASH_ROWS, E.VERSION_ROWS.map((r) => ({ id: r.id, key: r.key, ...(r.level ? { level: r.level } : {}), label: r.label, words: [...r.words], md: [...r.md] })));
  assert.deepStrictEqual(app.MENU_KEYS_VIEW, [...E.MENU_KEYS]);
  for (const b of ['/', 'a /', 'a/b', '/みだし', '／', '・', 'x /h a', '/to', '', ' /', 'a  /x']) assert.deepStrictEqual(app.slashQuery(b), E.slashQuery(b), b);
  for (const q of ['', 'みだし', 'h', 'todo', 'とぐる', 'zz', 'zzz', 'リスト', '#', 'TEXT']) {
    for (const rec of [[], ['h2'], ['bullet', 'h1', 'x'], 'x']) assert.deepStrictEqual(app.slashFilter(q, rec), E.slashFilter(q, rec), `${q}|${JSON.stringify(rec)}`);
  }
  for (const [r, k] of [[[], 'h2'], [['h2', 'todo', 'text'], 'quote'], [['h2'], 'h2'], [['h1'], 'toggle'], ['x', 'h1']]) assert.deepStrictEqual(app.recentAdd(r, k), E.recentAdd(r, k));
  for (const v of [null, 'h2', ['x', 1], ['h2', 'h2', 'todo', 'bullet', 'text'], ['toggle', 'callout']]) assert.deepStrictEqual(app.recentCheck(v), E.recentCheck(v));
});

test('ED-5: 行頭で / を打つと listbox が出て項目は型の表の順（覚えたものが無ければ「最近使ったもの」の見出しは無い）。『みだし』で見出し1〜3、↓↓ Enter で / と語が消えて blockTurnInto の1回', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    let t = typeInput(l, 'e1', '/');
    assert.ok(slashBoxOf(l), '/ でメニューが出ない');
    assert.strictEqual(slashBoxOf(l).getAttribute('role'), 'listbox');
    assert.ok(optsOf(l).every((o) => o.getAttribute('role') === 'option'));
    assert.deepStrictEqual(keysOf(l), [...E.MENU_KEYS]);
    assert.deepStrictEqual(headsOf(l), ['ブロックの型']);
    assert.strictEqual(l.document.activeElement, t, 'フォーカスが行から離れた');
    t = typeInput(l, 'e1', '/みだし');
    assert.deepStrictEqual(keysOf(l), ['h1', 'h2', 'h3']);
    assert.deepStrictEqual(headsOf(l), []);
    for (const k of ['ArrowDown', 'ArrowDown']) assert.strictEqual(l.key({ key: k }, t).defaultPrevented, true);
    const ev = l.key({ key: 'Enter' }, t);
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(slashBoxOf(l), null, '選んだのにメニューが残った');
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 'e1', 'heading', 3]]);
    assert.strictEqual(txtOf(l, 'e1').textContent, '');
    assert.deepStrictEqual(l.page().blocks[3].type === 'heading' && l.page().blocks[3].level, 3);
    assert.deepStrictEqual(recentSaves(l), [{ slashRecent: ['h3'] }]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-5: 文のある行の / で選ぶと、/ と語を消して下に足す（blockInsert の1回・段も送る）。足した行にフォーカス', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeInput(l, 'p1', 'あいうえお /h1');
    assert.deepStrictEqual(keysOf(l), ['h1']);
    l.key({ key: 'Enter' }, t);
    await l.drain();
    const blocks = l.page().blocks;
    assert.deepStrictEqual(sent(l), [['blockInsert', 'pa1', 'p1', 'heading', 1]]);
    assert.strictEqual(t.textContent, 'あいうえお ');
    assert.deepStrictEqual([blocks[3].type, blocks[3].level, blocks[3].text], ['heading', 1, '']);
    assert.strictEqual(l.document.activeElement, txtOf(l, blocks[3].id));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-5: a/b の / では出ない。全角の「／」と「・」でも出ない（EQ7）。空白の後の / では出る', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    for (const s2 of ['a/', 'a/b', '／', '・', 'あ／']) { typeInput(l, 'e1', s2); assert.strictEqual(slashBoxOf(l), null, s2); }
    typeInput(l, 'e1', 'あ /');
    assert.ok(slashBoxOf(l));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-5・F52: 見出し2を選ぶと uiSave が { slashRecent: [\'h2\'] } の1回で、次に / を開くと頭に「最近使ったもの」と見出し2。行頭の記法では uiSave を呼ばない', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeInput(l, 'e1', '/');
    l.key({ key: 'ArrowDown' }, t); l.key({ key: 'ArrowDown' }, t);
    assert.strictEqual(optsOf(l).find((o) => o.getAttribute('aria-selected') === 'true').dataset.key, 'h2');
    l.key({ key: 'Enter' }, t);
    await l.drain();
    assert.deepStrictEqual(recentSaves(l), [{ slashRecent: ['h2'] }]);
    typeInput(l, 'p1', 'あいうえお /');
    assert.deepStrictEqual(headsOf(l), ['最近使ったもの', 'ブロックの型']);
    assert.deepStrictEqual(keysOf(l), ['h2', ...E.MENU_KEYS]);
    l.key({ key: 'Escape' }, txtOf(l, 'p1'));
    // 行頭の記法で変えても覚えない
    l.calls.length = 0;
    const b1 = typeInput(l, 'b1', '- ', 2);
    void b1;
    typeInput(l, 'b1', '1. ', 3);
    await l.drain();
    assert.ok(sent(l).some((c) => c[0] === 'blockTurnInto'), '記法で変わらない');
    assert.deepStrictEqual(recentSaves(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-5・F52: uiState の slashRecent を頭に出す。壊れていても（[\'x\', 1]）メニューは開き、見出しは出ない', T, async () => {
  for (const [rec, heads, first] of [[['h3', 'quote'], ['最近使ったもの', 'ブロックの型'], 'h3'], [['x', 1], ['ブロックの型'], 'text'], ['h2', ['ブロックの型'], 'text']]) {
    const l = await openReal({ pa1: BASE() }, { returns: { uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' }, slashRecent: rec }) } });
    try {
      typeInput(l, 'e1', '/');
      assert.deepStrictEqual(headsOf(l), heads, JSON.stringify(rec));
      assert.strictEqual(keysOf(l)[0], first);
      assert.deepStrictEqual(l.errors.map(fmt), []);
    } finally { l.done(); }
  }
});

test('ED-5・F42: メニューを開いて Esc → メニューが閉じ、ev.defaultPrevented が真、/ と語は残る、一覧の選択は外れない、録音の口は呼ばれない。続けて打っても開き直さない', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    $(l, 'listSelect').dispatchEvent({ type: 'click' });
    await l.drain();
    assert.strictEqual($(l, 'listSelect').getAttribute('aria-pressed'), 'true');
    const t = typeInput(l, 'e1', '/みだ');
    assert.ok(slashBoxOf(l));
    const ev = l.key({ key: 'Escape' }, t);
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(slashBoxOf(l), null);
    assert.strictEqual(t.textContent, '/みだ');
    assert.strictEqual($(l, 'listSelect').getAttribute('aria-pressed'), 'true', 'メニューの Esc で一覧の選択が外れた');
    typeInput(l, 'e1', '/みだし');
    assert.strictEqual(slashBoxOf(l), null, 'Esc で閉じたのに開き直した');
    const rec = l.calls.filter((c) => /^(meeting(Toggle|Start|Discard|SetPaused|Stop)|toggleRecording|cancel)/.test(c.method));
    assert.deepStrictEqual(rec.map((c) => c.method), []);
    assert.deepStrictEqual(sent(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-5: ＋ を押すと下に行が足され（blockInsert の1回）、その行で / メニューが開いている', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const plus = rowOf(l, 'p1').querySelector('.plus');
    assert.strictEqual(plus.title, '下に行を足す（/ で型を選べます）');
    plus.dispatchEvent({ type: 'click' });
    await l.drain();
    const blocks = l.page().blocks;
    assert.deepStrictEqual(sent(l), [['blockInsert', 'pa1', 'p1', 'paragraph']]);
    const nt = txtOf(l, blocks[3].id);
    assert.strictEqual(l.document.activeElement, nt);
    assert.strictEqual(nt.textContent, '/');
    assert.ok(slashBoxOf(l), '＋ で / メニューが開かない');
    assert.strictEqual(nt.getAttribute('aria-activedescendant'), optsOf(l)[0].id);
    // そのまま選ぶと足した行の型が変わる
    l.key({ key: 'ArrowDown' }, nt);
    l.key({ key: 'Enter' }, nt);
    await l.drain();
    assert.strictEqual(l.page().blocks[3].type, 'heading');
    assert.strictEqual(nt.textContent, '');
    // 鍵の間は ＋ を出さない
    assert.ok(rowsOf(l).every((e) => e.querySelector('.plus')));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-5: aria-activedescendant が選んでいる項目を指す・当たりなしで「当てはまる型がありません」・3文字当たりなしで閉じる', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    let t = typeInput(l, 'e1', '/');
    const sel = () => optsOf(l).find((o) => o.getAttribute('aria-selected') === 'true');
    assert.strictEqual(t.getAttribute('aria-activedescendant'), sel().id);
    l.key({ key: 'ArrowDown' }, t);
    assert.strictEqual(sel().dataset.key, 'h1');
    assert.strictEqual(t.getAttribute('aria-activedescendant'), sel().id);
    l.key({ key: 'ArrowUp' }, t); l.key({ key: 'ArrowUp' }, t);
    assert.strictEqual(sel().dataset.key, 'callout', '↑ が頭から最後へ回らない');
    t = typeInput(l, 'e1', '/zz');
    assert.strictEqual(slashBoxOf(l).querySelector('.snone').textContent, '当てはまる型がありません');
    assert.strictEqual(t.getAttribute('aria-activedescendant'), null);
    typeInput(l, 'e1', '/zzz');
    assert.strictEqual(slashBoxOf(l), null);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// EQ22 (a): 録音中のタブがある形を作る（記録が始まった知らせ → 一覧の pa1 を押す）
async function liveThenPage(o = {}) {
  const l = await openReal({ pa1: BASE(), pb2: { blocks: BASE('x'), title: T2 } }, { ...o, open: o.open || 'pa1' });
  l.fire('onMeetingUpdate', { active: true, startedAt: Date.now(), segments: [] });
  await l.drain();
  const it = $(l, 'plist').querySelectorAll('.pitem').find((e) => e.dataset.pid === 'pa1');
  it.dispatchEvent({ type: 'click' });
  await l.drain();
  l.fire('onPagesUpdated', []);
  await l.drain();
  l.calls.length = 0;
  return l;
}
const tabKeys = (l) => $(l, 'tabbar').querySelectorAll('.tabitem').map((e) => e.getAttribute('data-key'));
const activeKey = (l) => { const a = $(l, 'tabbar').querySelector('.tabitem.active'); return a ? a.getAttribute('data-key') : ''; };
const gets = (l) => l.called('pageGet').map((c) => c.args[0]);

test('ED-5・EQ22 (a): 要約の行に打っている間に onPageOpen(\'pb2\', { saved: true }) → 前は pa1 のまま（フォーカス・打った文もそのまま・保存も pageGet も走らない）、録音中のタブが pb2 のタブに替わり題名は一覧の題名', T, async () => {
  const l = await liveThenPage();
  try {
    assert.deepStrictEqual(tabKeys(l), ['page:pa1', 'live']);
    const t = typeIn(l, 'p1', '打っている途中の文', 3);
    l.fire('onPageOpen', 'pb2', { saved: true });
    await l.drain();
    assert.deepStrictEqual(tabKeys(l), ['page:pa1', 'page:pb2']);
    assert.strictEqual(activeKey(l), 'page:pa1');
    assert.strictEqual($(l, 'tabbar').querySelectorAll('.tabitem')[1].querySelector('.tt').textContent, T2);
    assert.strictEqual(l.document.activeElement, t);
    assert.strictEqual(t.textContent, '打っている途中の文');
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['h1', 'b1', 'p1', 'e1']);
    assert.deepStrictEqual(sent(l), []);
    assert.deepStrictEqual(gets(l).filter((id) => id === 'pb2'), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-5・EQ22 (a): / メニューを開いているだけ・blockSplit の答えを待っているだけでも前に出さない。答えが来たら pa1 の行に当たる', T, async () => {
  const l = await liveThenPage({ hold: ['blockSplit'] });
  try {
    const t = typeInput(l, 'e1', '/');
    t.blur();
    assert.ok(slashBoxOf(l));
    l.fire('onPageOpen', 'pb2', { saved: true });
    await l.drain();
    assert.strictEqual(activeKey(l), 'page:pa1');
    assert.ok(slashBoxOf(l), 'メニューが閉じた');
    l.key({ key: 'Escape' }, t);
    const t2 = typeIn(l, 'p1', 'あいうえお', 2);
    l.key({ key: 'Enter' }, t2);
    await l.drain();
    t2.blur();
    l.fire('onPageOpen', 'pb2', { saved: true });
    await l.drain();
    assert.strictEqual(activeKey(l), 'page:pa1');
    l.release();
    await l.drain();
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id).length, 5);
    assert.deepStrictEqual(l.page('pa1').blocks.slice(2, 4).map((b) => b.text), ['あい', 'うえお']);
    assert.deepStrictEqual(gets(l).filter((id) => id === 'pb2'), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-5・EQ22 (a): 何も直していなければ onPageOpen(\'pb2\', { saved: true }) で今どおり pb2 が前に出る。メモの欄を直している間も前に出る', T, async () => {
  for (const memo of [false, true]) {
    const l = await liveThenPage();
    try {
      if (memo) { const ta = $(l, 'pMemo').querySelector('textarea'); ta.focus(); }
      l.fire('onPageOpen', 'pb2', { saved: true });
      await l.drain();
      assert.strictEqual(activeKey(l), 'page:pb2', `memo=${memo}`);
      assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['h1x', 'b1x', 'p1x', 'e1x']);
      assert.deepStrictEqual(l.errors.map(fmt), []);
    } finally { l.done(); }
  }
});

test('ED-5・EQ22 (a): 打っている間でも、印の無い onPageOpen(\'pb2\')（知らせを押した形）と { saved: false } は今どおり前に出る（打った文は保存される）', T, async () => {
  for (const args of [['pb2'], ['pb2', { saved: false }]]) {
    const l = await liveThenPage();
    try {
      typeIn(l, 'p1', '知らせの前の文', 1);
      l.fire('onPageOpen', ...args);
      await l.drain();
      assert.strictEqual(activeKey(l), 'page:pb2', JSON.stringify(args));
      assert.deepStrictEqual(sent(l), [['blockUpdate', 'pa1', 'p1', { text: '知らせの前の文' }]]);
      assert.deepStrictEqual(l.errors.map(fmt), []);
    } finally { l.done(); }
  }
});

test('ED-5・EQ22 (a)（第2部との重なり）: 録音の前のページがあり、pa1 の要約の行に打っている間の onPageOpen(\'pb2\', { saved: true }) → 前は pa1 のまま・録音の前のタブもそのまま・pb2 のタブが末尾に足される。打っていなければ pb2 が新しいタブで前に出る', T, async () => {
  for (const busy of [true, false]) {
    let status = { active: false };
    const l = await openReal({ pa1: BASE(), pb2: { blocks: BASE('x'), title: T2 } }, {
      returns: { meetingStatus: () => status, meetingPrepare: () => { status = { active: false, prep: { memo: '', meetingType: null } }; return { ok: true }; } },
    });
    try {
      await $(l, 'mtToggleBtn').onclick();
      await l.drain();
      const it = $(l, 'plist').querySelectorAll('.pitem').find((e) => e.dataset.pid === 'pa1');
      it.dispatchEvent({ type: 'click' });
      await l.drain();
      assert.deepStrictEqual(tabKeys(l), ['page:pa1', 'live']);
      if (busy) typeIn(l, 'p1', '書き直し中', 2);
      l.fire('onPageOpen', 'pb2', { saved: true });
      await l.drain();
      assert.deepStrictEqual(tabKeys(l), ['page:pa1', 'live', 'page:pb2'], `busy=${busy}`);
      assert.strictEqual(activeKey(l), busy ? 'page:pa1' : 'page:pb2', `busy=${busy}`);
      assert.deepStrictEqual(l.errors.map(fmt), []);
    } finally { l.done(); }
  }
});

test('ED-5・EQ22 (a)（preload）: page:open の値 → onPageOpen の cb の引数（ID の文字は saved: false・{ id, saved: true }・形の違う値は渡さない）', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const exposed = {}; const on = {};
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async () => ({}), send: () => {} } };
  require('node:vm').runInNewContext(SRC, { require: () => electron, crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000001' }, setTimeout, clearTimeout, console, Promise });
  const got = [];
  exposed.koeApp.onPageOpen((id, o) => got.push([id, JSON.parse(JSON.stringify(o))]));
  for (const v of ['p2', { id: 'p2', saved: true }, { id: 'p2', saved: 'yes' }, { id: 'p2' }, { id: 3 }, null, undefined, 5, ['p2']]) on['page:open']({}, v);
  assert.deepStrictEqual(got, [['p2', { saved: false }], ['p2', { saved: true }], ['p2', { saved: false }], ['p2', { saved: false }]]);
});

test('ED-5（E1）: 行の左の ＋ は行の外の左の余白に置き（行の並びを変えない: 位置は absolute）、乗せたときだけ見え、描くのを省く切る線（overflow-clip-margin）の内側に収まる。狭い画面は .mblock の余白に収まる幅', () => {
  const S = require('./helpers/simcss');
  const { parseHTML } = require('./helpers/simdom');
  const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
  const px = (v) => Number(/^(-?\d+(?:\.\d+)?)px$/.exec(String(v || '').trim())?.[1]);
  const plus = S.declsFor(rules, '.blk .plus', { at: '' });
  assert.strictEqual(plus.position, 'absolute');
  assert.strictEqual(plus.right, '100%');
  assert.strictEqual(plus.opacity, '0');
  assert.strictEqual(S.declsFor(rules, '.blk:hover .plus', { at: '' }).opacity, '.55');
  assert.ok(px(S.declsFor(rules, '.blk', { at: '' })['overflow-clip-margin']) >= px(plus.width), '＋ が描くのを省く切る線で切れる');
  const narrowAt = rules.map((r) => r.at).find((a) => /max-width: 760px/.test(a));
  const narrow = S.declsFor(rules, '.blk .plus', { at: narrowAt });
  const mpad = S.declsFor(rules, '.mblock', { at: narrowAt }).padding.split(/\s+/)[1];
  assert.ok(px(narrow.width) <= px(mpad), `狭い画面の ＋（${narrow.width}）が .mblock の左の余白（${mpad}）からはみ出す`);
  assert.ok(px(plus.width) <= px(S.declsFor(rules, '.mblock', { at: '' }).padding.split(/\s+/)[1]));
});

test('ED-5（決めたこと 41・R19）: / メニューはページを替える前に閉じる（印の無い page:open・［＋ 新しい議事録］）。打っていた文は保存される', T, async () => {
  for (const how of ['open', 'ready']) {
    let status = { active: false };
    const l = await openReal({ pa1: BASE(), pb2: BASE('x') }, {
      returns: { meetingStatus: () => status, meetingPrepare: () => { status = { active: false, prep: { memo: '', meetingType: null } }; return { ok: true }; } },
    });
    try {
      const t = typeInput(l, 'p1', 'あいうえお /みだ');
      assert.ok(slashBoxOf(l));
      if (how === 'open') l.fire('onPageOpen', 'pb2'); else await $(l, 'mtToggleBtn').onclick();
      await l.drain();
      assert.strictEqual(l.document.querySelectorAll('.slashmenu').length, 0, how);
      assert.strictEqual(t.getAttribute('aria-activedescendant'), null);
      assert.deepStrictEqual(sent(l), [['blockUpdate', 'pa1', 'p1', { text: 'あいうえお /みだ' }]], how);
      assert.deepStrictEqual(l.errors.map(fmt), []);
    } finally { l.done(); }
  }
});
