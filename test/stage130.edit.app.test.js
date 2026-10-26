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
  blockInsert: (pageId, afterBlockId, type) => ['block.insert', { pageId, afterBlockId, type }],
  blockRemove: (pageId, blockId) => ['block.remove', { pageId, blockId }],
  blockSplit: (pageId, blockId, text, at) => ['block.split', { pageId, blockId, text, at }],
  blockMerge: (pageId, blockId, text) => ['block.merge', { pageId, blockId, text }],
  blockTurnInto: (pageId, blockId, type, level) => ['block.turnInto', level === undefined ? { pageId, blockId, type } : { pageId, blockId, type, level }],
  blockSetAction: (pageId, blockId, assignee, dueRaw) => ['block.setAction', { pageId, blockId, assignee, dueRaw }],
};
async function openReal(pages, o = {}) {
  const t = tmpDb();
  const { db } = t.open();
  for (const [id, blocks] of Object.entries(pages)) {
    const { page, segments } = samplePage(id);
    t.seed({ ...page, title: T1, blocks }, segments);
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
