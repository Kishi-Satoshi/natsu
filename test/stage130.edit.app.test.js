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
  blockDuplicate: (pageId, blockId, afterId) => ['block.duplicate', afterId === undefined ? { pageId, blockId } : { pageId, blockId, afterId }],
  blockMove: (pageId, blockId, to) => ['block.move', to && typeof to === 'object' ? { pageId, blockId, afterId: to.afterId } : { pageId, blockId, toIndex: to }],
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
    pagesSearch: wrap('pagesSearch', () => call('pages.list', { q: '' })), pageGet: wrap('pageGet', (id) => call('page.get', { id })),
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
const ED4_CALLS = ['blockSplit', 'blockMerge', 'blockTurnInto', 'blockInsert', 'blockRemove', 'blockUpdate', 'blockMove', 'blockDuplicate'];
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

// 2026-10-26 の持ち主の答え（点検1「上に空の行を足す（おすすめ）」）
test('ED-4・点検1: 文のある行の頭で Enter → blockSplit（at 0）の1回で上に空の行が入り、今の行は文も出典もそのまま、カーソルは今の行の頭に残る', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'b1', '来週に出す', 0);
    l.key({ key: 'Enter' }, t);
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'b1', '来週に出す', 0]]);
    const blocks = l.page().blocks;
    assert.deepStrictEqual(blocks.slice(0, 3).map((b) => [b.id === 'h1' || b.id === 'b1' ? b.id : 'new', b.type, b.text]),
      [['h1', 'heading', '決定事項'], ['new', 'bullet', ''], ['b1', 'bullet', '来週に出す']]);
    assert.deepStrictEqual([blocks[2].cites, blocks[2].citeState], [['s2'], 'linked']);
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['h1', blocks[1].id, 'b1', 'p1', 'e1']);
    assert.strictEqual(txtOf(l, 'b1').textContent, '来週に出す');
    assert.strictEqual(txtOf(l, blocks[1].id).textContent, '');
    assert.strictEqual(l.document.activeElement, txtOf(l, 'b1'));
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'b1')), [0, 0]);
    // blur しても今の行の文を書き直さない（命令は分割の1つだけ）
    txtOf(l, 'b1').dispatchEvent({ type: 'blur' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'b1', '来週に出す', 0]]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// 2026-10-26 の持ち主の答え（点検2「見出しに戻したら AI の見出しに戻す（おすすめ）」）
test('ED-4・点検2: AI の見出しの頭で Backspace（テキストに戻る）→ Ctrl+Shift+2 か「## 」で見出しに戻すと、画面の並びと［コピー］が前と同じ', T, async () => {
  const blocks = [{ id: 'h1', type: 'heading', level: 2, text: '議題' }, { id: 'b2', type: 'bullet', text: '予算の話', cites: ['s2'], citeState: 'linked' },
    { id: 'h2', type: 'heading', level: 2, text: '決定事項' }, { id: 'b4', type: 'bullet', text: '来月に出す', cites: ['s2'], citeState: 'linked' }];
  for (const how of ['ctrl', 'md']) {
    const l = await openReal({ pa1: blocks }, { returns: { copy: (t) => { l.copied = t; return true; } } });
    try {
      const copy = async () => {
        const btn = $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === 'コピー');
        await btn.onclick();
        await l.drain();
        return l.copied;
      };
      const order0 = rowsOf(l).map((e) => e.dataset.id);
      assert.deepStrictEqual(order0, ['h2', 'b4', 'h1', 'b2'], '締めの節が前に出ていない（見本の作りの誤り）');
      const copy0 = await copy();
      let t = txtOf(l, 'h2');
      t.focus();
      l.caret.set(t, 0);
      l.key({ key: 'Backspace' }, t);
      await l.drain();
      assert.deepStrictEqual([l.page().blocks[2].type, l.page().blocks[2].citeState], ['paragraph', 'manual']);
      assert.notDeepStrictEqual(rowsOf(l).map((e) => e.dataset.id), order0, 'テキストにしたのに並びが同じ（見本の作りの誤り）');
      t = txtOf(l, 'h2');
      t.focus();
      if (how === 'ctrl') {
        l.caret.set(t, 0);
        l.key({ key: '"', code: 'Digit2', ctrlKey: true, shiftKey: true }, t);
      } else {
        t.textContent = '## 決定事項';
        l.caret.set(t, 3);
        t.dispatchEvent({ type: 'input' });
      }
      await l.drain();
      const h2 = l.page().blocks[2];
      assert.deepStrictEqual([h2.id, h2.type, h2.text, h2.citeState], ['h2', 'heading', '決定事項', undefined], how);
      assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), order0, how);
      assert.strictEqual(await copy(), copy0, how);
      assert.deepStrictEqual(l.errors.map(fmt), []);
    } finally { l.done(); }
  }
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

// 2026-10-26 の持ち主の答え（問2「⠿ の左に並べる（Notion と同じ並び）」）で意図して変えた: ＋ は行の外の余白でなく、行の並びの中で ⠿ の左（Ruling R36。R21 を替えた）
test('ED-5（E1・問2）: 行の左の ＋ は行の並びの中で ⠿ の左（＋ → ⠿ → 文）。乗せたときだけ見え、押す所は拡大 150%・200% の狭い画面でも細くしない。文は約 22px 右へずれる', T, async () => {
  const S = require('./helpers/simcss');
  const { parseHTML } = require('./helpers/simdom');
  const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((x) => x._raw).join('\n'));
  const px = (v) => Number(/^(-?\d+(?:\.\d+)?)px$/.exec(String(v || '').trim())?.[1]);
  const plus = S.declsFor(rules, '.blk .plus', { at: '' });
  assert.notStrictEqual(plus.position, 'absolute', '＋ が行の並びの外にある');
  assert.strictEqual(plus.flex, 'none');
  assert.strictEqual(plus.opacity, '0');
  assert.strictEqual(S.declsFor(rules, '.blk:hover .plus', { at: '' }).opacity, '.55');
  assert.ok(px(plus.width) >= 18 && px(plus['line-height']) >= 24, `＋ の押す所が小さい（${plus.width}×${plus['line-height']}）`);
  const narrowAt = rules.map((r) => r.at).find((x) => /max-width: 760px/.test(x));
  const narrow = S.declsFor(rules, '.blk .plus', { at: narrowAt });
  assert.ok(narrow.width === undefined || px(narrow.width) >= 18, `狭い画面（拡大 150%・200%）で ＋ を細くした: ${narrow.width}`);
  const shift = px(plus.width) + px(S.declsFor(rules, '.blk', { at: '' }).gap) + (px(plus['margin-right']) || 0);
  assert.ok(shift >= 18 && shift <= 26, `文のずれ ${shift}px が約 22px でない`);
  const l = await openReal({ pa1: BASE() });
  try {
    for (const id of ['b1', 'p1']) {
      const kids = rowOf(l, id).children.map((e) => e.className.split(' ')[0]);
      assert.deepStrictEqual(kids.slice(0, 2), ['plus', 'grip'], `${id}: ${kids.join(',')}`);
      assert.ok(kids.indexOf('txt') > 1);
    }
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
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

// ---------------------------------------------------------------- ED-6（E1・決めたこと 18・24・EQ16 (a)。F46）
const menuOf = (l) => l.document.querySelector('#pNote .blockmenu:not(.sub)') || $(l, 'pNote').querySelectorAll('.blockmenu').find((m) => !m.classList.contains('sub')) || null;
const subOf = (l) => $(l, 'pNote').querySelectorAll('.blockmenu').find((m) => m.classList.contains('sub')) || null;
const itemsOf = (m) => (m ? m.querySelectorAll('.mitem').filter((x) => x.parentNode === m) : []);
const labelsOf = (m) => itemsOf(m).map((x) => x.textContent);
const press = (l, el, key, o = {}) => l.key({ key, ...o }, el);
// メニューの中のキー（本物は項目から箱へ泡立つ。偽の DOM は泡立たないので、箱の受け口へ送る。どの項目かは document.activeElement）
const menuKey = (l, key) => l.key({ key }, menuOf(l));

test('ED-6: ⠿ を押すとメニュー（削除・複製・変換 ▸）で最初の項目にフォーカス。削除 → blockRemove の1回で行が消え、フォーカスは上の行の終わり', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const grip = rowOf(l, 'p1').querySelector('.grip');
    assert.strictEqual(grip.title, 'ドラッグで並べ替え・押すとメニュー');
    grip.dispatchEvent({ type: 'click' });
    const m = menuOf(l);
    assert.ok(m, '⠿ でメニューが出ない');
    assert.strictEqual(m.getAttribute('role'), 'menu');
    assert.deepStrictEqual(labelsOf(m), ['削除', '複製', '変換 ▸']);
    assert.ok(itemsOf(m).every((x) => x.getAttribute('role') === 'menuitem'));
    assert.strictEqual(l.document.activeElement, itemsOf(m)[0]);
    assert.strictEqual(grip.getAttribute('aria-expanded'), 'true');
    itemsOf(m)[0].dispatchEvent({ type: 'click' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockRemove', 'pa1', 'p1']]);
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['h1', 'b1', 'e1']);
    assert.strictEqual(menuOf(l), null);
    assert.strictEqual(l.document.activeElement, txtOf(l, 'b1'));
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'b1')), [5, 5]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-6: 複製 → 打った文を保存してから blockDuplicate の1回（すぐ下に写し）。右クリックでも同じメニュー（既定のメニューは出さない）', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    typeIn(l, 'b1', '来週の月曜に出す', 2);
    let prevented = false;
    rowOf(l, 'b1').dispatchEvent({ type: 'contextmenu', preventDefault() { prevented = true; } });
    assert.strictEqual(prevented, true);
    const m = menuOf(l);
    assert.deepStrictEqual(labelsOf(m), ['削除', '複製', '変換 ▸']);
    itemsOf(m)[1].dispatchEvent({ type: 'click' });
    await l.drain();
    const blocks = l.page().blocks;
    assert.deepStrictEqual(sent(l), [['blockUpdate', 'pa1', 'b1', { text: '来週の月曜に出す' }], ['blockDuplicate', 'pa1', 'b1']]);
    assert.deepStrictEqual(blocks.slice(1, 3).map((b) => [b.type, b.text]), [['bullet', '来週の月曜に出す'], ['bullet', '来週の月曜に出す']]);
    assert.strictEqual(l.document.activeElement, txtOf(l, blocks[2].id));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-6: Ctrl+/ で今の行のメニュー。↓↓ Enter で「変換」の中（型の表の名前）が開き、↓↓ Enter（見出し2）で blockTurnInto の1回。文のある行では区切り線を選べない', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'b1', '来週に出す', 1);
    const ev = press(l, t, '/', { code: 'Slash', ctrlKey: true });
    assert.strictEqual(ev.defaultPrevented, true);
    const m = menuOf(l);
    assert.ok(m, 'Ctrl+/ でメニューが出ない');
    menuKey(l, 'ArrowDown'); menuKey(l, 'ArrowDown');
    assert.strictEqual(l.document.activeElement.textContent, '変換 ▸');
    menuKey(l, 'Enter');
    const sub = subOf(l);
    assert.ok(sub, '変換の中が開かない');
    assert.deepStrictEqual(labelsOf(sub), E.VERSION_ROWS.map((r) => r.label));
    const div = itemsOf(sub).find((x) => x.dataset.key === 'divider');
    assert.strictEqual(div.getAttribute('aria-disabled'), 'true');
    assert.strictEqual(div.title, '文のある行は区切り線にできません');
    assert.strictEqual(l.document.activeElement, itemsOf(sub)[0]);
    menuKey(l, 'ArrowDown'); menuKey(l, 'ArrowDown');
    assert.strictEqual(l.document.activeElement.dataset.key, 'h2');
    menuKey(l, 'Enter');
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 'b1', 'heading', 2]]);
    assert.strictEqual(menuOf(l), null);
    assert.ok(rowOf(l, 'b1').classList.contains('heading'));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-6: メニューは ↑↓（回る）・Home・End・Esc（変換の中から戻る・⠿ へ戻る）・Tab（閉じる）。空の行なら区切り線を選べる', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const grip = rowOf(l, 'e1').querySelector('.grip');
    grip.dispatchEvent({ type: 'click' });
    const m = menuOf(l);
    const it = itemsOf(m);
    const at = () => it.indexOf(l.document.activeElement);
    menuKey(l, 'ArrowUp'); assert.strictEqual(at(), 2);
    menuKey(l, 'ArrowDown'); assert.strictEqual(at(), 0);
    menuKey(l, 'End'); assert.strictEqual(at(), 2);
    menuKey(l, 'Home'); assert.strictEqual(at(), 0);
    menuKey(l, 'End');
    menuKey(l, 'ArrowRight');
    const sub = subOf(l);
    assert.ok(sub);
    assert.strictEqual(itemsOf(sub).find((x) => x.dataset.key === 'divider').getAttribute('aria-disabled'), null);
    menuKey(l, 'Escape');
    assert.strictEqual(subOf(l), null);
    assert.strictEqual(l.document.activeElement, it[2]);
    const ev = menuKey(l, 'Escape');
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(menuOf(l), null);
    assert.strictEqual(l.document.activeElement, grip, 'Esc で ⠿ へ戻らない');
    grip.dispatchEvent({ type: 'click' });
    menuKey(l, 'Tab');
    assert.strictEqual(menuOf(l), null);
    await l.drain();
    assert.deepStrictEqual(sent(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// 0.11.0 の並べ替えて見せる要約（保存の順と画面の順が違う）
const HB = (id, text) => ({ id, type: 'heading', text });
const BB = (id, text) => ({ id, type: 'bullet', text, cites: [], citeState: 'manual' });
const VIEWED = [HB('h1', '課題・要望（N）'), BB('n1', '在庫の管理を楽にしたい'), BB('n2', '発注を早めたい'), HB('h3', '決定事項'), BB('d1', '来月に試す'), HB('h4', '持ち越し'), BB('c1', '価格は次回')];
function dragTo(l, id, clientY, o = {}) {
  const box = $(l, 'pNote');
  const els = box.querySelectorAll('.blk');
  els.forEach((e, i) => { e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: 0, right: 100, width: 100 }); });
  els.find((e) => e.dataset.id === id).ondragstart({ dataTransfer: { setData() {}, effectAllowed: '' } });
  return box.ondrop({ preventDefault() {}, clientY, ...o });
}

test('ED-6・F46: 並べ替えて見せる要約で、持ち越しの行を型の見出しの節の2行目の下へ落とすと、blockMove の引数は { afterId: 画面でその上に見えている行 }。描き直した後も同じ所に出る', T, async () => {
  const l = await openReal({ pa1: VIEWED });
  try {
    const view = () => rowsOf(l).map((e) => e.dataset.id);
    assert.deepStrictEqual(view(), ['h3', 'd1', 'h4', 'c1', 'h1', 'n1', 'n2']);
    // c1 を除いた画面の行: h3 d1 h4 h1 n1 n2。n2 の下半分（els の位置 6 の下の方）へ落とす → n2 の後ろ
    await dragTo(l, 'c1', 6 * 10 + 8);
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'c1', { afterId: 'n2' }]]);
    assert.deepStrictEqual(view(), ['h3', 'd1', 'h4', 'h1', 'n1', 'n2', 'c1'], '描き直した後に別の所へ跳んだ');
    assert.deepStrictEqual(l.page().blocks.map((b) => b.id), ['h1', 'n1', 'n2', 'c1', 'h3', 'd1', 'h4']);
    // 型の見出しの節の1行目と2行目の間（n2 の上半分）へ d1 を落とす → n1 の後ろ
    l.calls.length = 0;
    await dragTo(l, 'd1', 5 * 10 + 2);
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'd1', { afterId: 'n1' }]]);
    assert.deepStrictEqual(view(), ['h3', 'h4', 'h1', 'n1', 'd1', 'n2', 'c1']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-6: いちばん上へ落とすと afterId は \'\'。Alt を押しながら落とすと複製の命令1回（afterId つき。動かさない）', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    await dragTo(l, 'p1', 1);
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'p1', { afterId: '' }]]);
    assert.deepStrictEqual(l.page().blocks.map((b) => b.id), ['p1', 'h1', 'b1', 'e1']);
    // 保存の頭の行（見出しの前）は、0.11.0 の並べ替えでは締めの節（決定事項）の後に見える（Ruling R28）
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['h1', 'b1', 'e1', 'p1']);
    l.calls.length = 0;
    // 画面の e1（3 行目）の下半分へ Alt で落とす（b1 を除いた行: h1 e1 p1）→ e1 の後ろに写し
    await dragTo(l, 'b1', 2 * 10 + 8, { altKey: true });
    await l.drain();
    const blocks = l.page().blocks;
    assert.deepStrictEqual(sent(l), [['blockDuplicate', 'pa1', 'b1', 'e1']]);
    assert.deepStrictEqual(blocks.map((b) => (['p1', 'h1', 'b1', 'e1'].includes(b.id) ? b.id : `copy:${b.text}`)), ['p1', 'h1', 'b1', 'e1', 'copy:来週に出す']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-6・EQ22 (a): ⠿ のメニューを開いている間に onPageOpen(\'pb2\', { saved: true }) → 前に出さず、録音中のタブだけが替わる（summaryBusy に ⠿ のメニュー）。ページを替える前にメニューは閉じる', T, async () => {
  const l = await liveThenPage();
  try {
    rowOf(l, 'p1').querySelector('.grip').dispatchEvent({ type: 'click' });
    assert.ok(menuOf(l));
    l.fire('onPageOpen', 'pb2', { saved: true });
    await l.drain();
    assert.deepStrictEqual(tabKeys(l), ['page:pa1', 'page:pb2']);
    assert.strictEqual(activeKey(l), 'page:pa1');
    assert.ok(menuOf(l), 'メニューが閉じた');
    l.fire('onPageOpen', 'pb2');
    await l.drain();
    assert.strictEqual(activeKey(l), 'page:pb2');
    assert.strictEqual(l.document.querySelectorAll('.blockmenu').length, 0, 'ページを替えてもメニューが残った');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- ED-7（E5・E11・決めたこと 5・6・26〜29。F44・F45・F51）
test('ED-7: 近道の写し（app.html の keyAction）は src/blockEdit.js と同じ答え（数字は ev.code・JIS の Shift+数字・変換中は null）', () => {
  const src = HTML.slice(HTML.indexOf('  const DIGIT_TURN_VIEW = '), HTML.indexOf('\n', HTML.indexOf('  const DIGIT_TURN_VIEW = ')) + 1) + fnFromApp('keyAction');
  const app = new Function(`${src}\nreturn { keyAction };`)();   // eslint-disable-line no-new-func
  const evs = [];
  for (const code of ['Digit0', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'KeyD', 'KeyP', 'KeyL', 'KeyW', 'KeyN', 'KeyV', 'Slash', 'Enter', 'NumpadEnter', 'ArrowUp', 'ArrowDown', '']) {
    for (const [ctrlKey, shiftKey, altKey] of [[true, false, false], [true, true, false], [false, true, false], [true, false, true], [true, true, true]]) {
      evs.push({ code, key: code === 'Digit1' && shiftKey ? '!' : code.replace(/^(Digit|Key)/, '').toLowerCase(), ctrlKey, shiftKey, altKey, metaKey: false });
    }
  }
  evs.push({ code: 'KeyD', key: 'd', ctrlKey: true, isComposing: true }, { code: 'KeyD', key: 'd', ctrlKey: true, keyCode: 229 }, { code: '', key: '/', ctrlKey: true }, { code: '', key: 'Enter', ctrlKey: true }, null);
  for (const ev of evs) assert.strictEqual(app.keyAction(ev), E.keyAction(ev), JSON.stringify(ev));
});

const TYPES = () => [{ id: 't1', type: 'heading', level: 1, text: '全体の結論' }, { id: 't3', type: 'heading', level: 3, text: '細かい決めごと' }, { id: 't2', type: 'heading', text: '前の版の見出し' },
  { id: 'n1', type: 'numbered', text: '一つ目' }, { id: 'n2', type: 'numbered', text: '二つ目' }, { id: 'x1', type: 'bullet', text: '間の箇条書き' }, { id: 'n3', type: 'numbered', text: '数え直す' },
  { id: 'q1', type: 'quote', text: '引いた言葉' }, { id: 'v1', type: 'divider', text: '' }, { id: 'c1', type: 'callout', text: '目立たせたい一言', icon: '💡' },
  { id: 'z1', type: 'video', text: '知らない型の行' }];

test('ED-7・F51: 見出し1〜3（段の無い見出しは段 2）・番号付き（数えた番号）・引用・区切り線（文の欄が無い）・コールアウト（💡）が描かれ、知らない型はテキストの見た目で文が出て直せる', T, async () => {
  const l = await openReal({ pa1: TYPES() });
  try {
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), TYPES().map((b) => b.id));
    assert.ok(rowOf(l, 't1').classList.contains('heading') && rowOf(l, 't1').classList.contains('h1'));
    assert.ok(rowOf(l, 't3').classList.contains('h3'));
    assert.ok(rowOf(l, 't2').classList.contains('h2'), '段の無い見出しが段 2 でない');
    assert.deepStrictEqual(['n1', 'n2', 'n3'].map((id) => rowOf(l, id).querySelector('.num').textContent), ['1.', '2.', '1.']);
    assert.ok(rowOf(l, 'q1').classList.contains('quote'));
    const v = txtOf(l, 'v1');
    assert.strictEqual(v.contentEditable, 'false');
    assert.strictEqual(v.textContent, '');
    assert.strictEqual(v.getAttribute('role'), 'separator');
    assert.strictEqual(v.tabIndex, 0, '区切り線にフォーカスできない');
    assert.strictEqual(rowOf(l, 'c1').querySelector('.icon').textContent, '💡');
    const z = rowOf(l, 'z1');
    assert.ok(z.classList.contains('paragraph'), '知らない型がテキストの見た目でない');
    assert.strictEqual(z.querySelector('.txt').textContent, '知らない型の行');
    assert.strictEqual(z.querySelector('.txt').contentEditable, 'true');
    const t = typeIn(l, 'z1', '知らない型の行を直した', 3);
    t.dispatchEvent({ type: 'blur' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockUpdate', 'pa1', 'z1', { text: '知らない型の行を直した' }]]);
    assert.strictEqual(l.page().blocks[10].type, 'video', '知らない型が変わった');
    // 区切り線で Enter → 下にテキストの行
    l.calls.length = 0;
    v.focus();
    l.key({ key: 'Enter' }, v);
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockInsert', 'pa1', 'v1', 'paragraph']]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-7: Ctrl+Shift+1（code Digit1・key \'!\'）で見出し1、Ctrl+Shift+0 でテキスト（EQ12）、Ctrl+Shift+4 で ToDo。どれも blockTurnInto の1回', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    for (const [id, code, key, want] of [['p1', 'Digit1', '!', ['heading', 1]], ['b1', 'Digit0', '', ['paragraph']], ['e1', 'Digit4', '$', ['todo']]]) {
      l.calls.length = 0;
      const t = typeIn(l, id, txtOf(l, id).textContent, 0);
      const ev = l.key({ key, code, ctrlKey: true, shiftKey: true }, t);
      await l.drain();
      assert.strictEqual(ev.defaultPrevented, true, code);
      assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', id, ...want]], code);
    }
    assert.deepStrictEqual(l.page().blocks.map((b) => b.type), ['heading', 'paragraph', 'heading', 'todo']);
    assert.deepStrictEqual(recentSaves(l), [], '近道で最近使ったものを覚えた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-7: Ctrl+D → blockDuplicate、Ctrl+Shift+↑ → blockMove（afterId は2つ上の行）、Ctrl+Shift+↓ → 1つ下の行の後ろ、Ctrl+Enter（ToDo）→ blockUpdate の checked の1回（ToDo でなければ何もしない）', T, async () => {
  const blocks = [...BASE(), { id: 'd1', type: 'todo', text: '見積を送る', checked: false, cites: [] }];
  const l = await openReal({ pa1: blocks });
  try {
    // 画面の並びは h1 b1 p1 e1 d1（保存と同じ）
    let t = typeIn(l, 'p1', 'あいうえお', 1);
    l.key({ key: 'd', code: 'KeyD', ctrlKey: true }, t);
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockDuplicate', 'pa1', 'p1']]);
    const dup = rowsOf(l).map((e) => e.dataset.id)[3];
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['h1', 'b1', 'p1', dup, 'e1', 'd1']);
    l.calls.length = 0;
    // e1 の Ctrl+Shift+↑: 1つ上（写し）の前＝2つ上（p1）の後ろ
    t = typeIn(l, 'e1', '', 0);
    l.key({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, shiftKey: true }, t);
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'e1', { afterId: 'p1' }]]);
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['h1', 'b1', 'p1', 'e1', dup, 'd1']);
    assert.strictEqual(l.document.activeElement, txtOf(l, 'e1'));
    l.calls.length = 0;
    // b1 の Ctrl+Shift+↓: 1つ下（p1）の後ろ
    t = typeIn(l, 'b1', '来週に出す', 2);
    l.key({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true, shiftKey: true }, t);
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockMove', 'pa1', 'b1', { afterId: 'p1' }]]);
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['h1', 'p1', 'b1', 'e1', dup, 'd1']);
    assert.strictEqual(l.document.activeElement, txtOf(l, 'b1'));
    l.calls.length = 0;
    t = typeIn(l, 'd1', '見積を送る', 2);
    l.key({ key: 'Enter', code: 'Enter', ctrlKey: true }, t);
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockUpdate', 'pa1', 'd1', { checked: true }]]);
    assert.ok(rowOf(l, 'd1').classList.contains('done'));
    assert.strictEqual(rowOf(l, 'd1').querySelector('input').checked, true);
    l.calls.length = 0;
    l.key({ key: 'Enter', code: 'Enter', ctrlKey: true }, typeIn(l, 'p1', txtOf(l, 'p1').textContent, 0));
    await l.drain();
    assert.deepStrictEqual(sent(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-7・F45: 文字起こしの行・メモの欄・題名・会議の種類の行・録音の前のページの種類の行とメモ欄で Ctrl+D・Ctrl+Shift+1・Ctrl+/ を押しても何も呼ばれない', T, async () => {
  let status = { active: false };
  const l = await openReal({ pa1: BASE() }, {
    returns: { meetingStatus: () => status, meetingPrepare: () => { status = { active: false, prep: { memo: '', meetingType: null } }; return { ok: true }; } },
  });
  try {
    const keys = [{ key: 'd', code: 'KeyD', ctrlKey: true }, { key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }, { key: '/', code: 'Slash', ctrlKey: true }];
    const where = () => [$(l, 'pTitle'), $(l, 'pType'), $(l, 'pMemo').querySelector('textarea'), ...$(l, 'pScript').querySelectorAll('.seg .txt')].filter(Boolean);
    const page = where();
    assert.ok(page.length >= 4, `場所が足りない: ${page.length}`);
    for (const el of page) for (const k of keys) l.key(k, el);
    await $(l, 'mtToggleBtn').onclick();
    await l.drain();
    const ready = [$(l, 'pType'), $(l, 'pMemo').querySelector('textarea')].filter(Boolean);
    assert.strictEqual(ready.length, 2);
    for (const el of ready) for (const k of keys) l.key(k, el);
    await l.drain();
    assert.deepStrictEqual(sent(l).filter((c) => c[0] !== 'blockUpdate'), []);
    assert.deepStrictEqual(l.document.querySelectorAll('.blockmenu').length, 0);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('ED-7・F51（R14）: 段 2 の見出しの CSS は前の版の .blk.heading のまま（.h2 の規則は無い）。新しい型の色はトークン（明暗の両方）だけ', () => {
  const S = require('./helpers/simcss');
  const { parseHTML } = require('./helpers/simdom');
  const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
  assert.deepStrictEqual(S.declsFor(rules, '.blk.heading .txt', { at: '' }), { 'font-size': '20px', 'font-weight': '600', 'line-height': '26px' });
  assert.deepStrictEqual(S.declsFor(rules, '.blk.heading', { at: '' }), { 'margin-top': '22px' });
  assert.ok(!rules.some((r) => /\.h2\b/.test(r.sel)), '段 2 の見出しに規則がある（前の版の見出しの見た目が変わる）');
  const sels = ['.blk.heading.h1 .txt', '.blk.heading.h3 .txt', '.blk .num', '.blk.quote .txt', '.blk.divider .txt', '.blk.divider .txt:focus', '.blk.callout', '.blk .plus', '.slashmenu', '.blockmenu', '.blockmenu .mitem.off'];
  for (const sel of sels) {
    const d = rules.filter((r) => r.sel.split(',').map((x) => x.trim()).includes(sel));
    assert.ok(d.length, `${sel} の規則が無い`);
    for (const r of d) for (const [k, v] of Object.entries(r.decls)) {
      if (/color|background|border|outline|shadow/.test(k)) assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(v), `${sel} の ${k} が固定の色: ${v}`);
    }
  }
});

// ---------------------------------------------------------------- ED-8（HC2・EQ4 (a)・決めたこと 35・36）
test('ED-8: HELP_ARTICLES と site.json の分類 summary の並びが同じで、summary/citations の後に summary/edit-summary。how-summaries から1行のリンク', () => {
  const site = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'help', 'site.json'), 'utf8'));
  const sum = site.categories.find((c) => c.id === 'summary');
  assert.deepStrictEqual(sum.articles, ['how-summaries', 'summary-types', 'meeting-quality', 'citations', 'edit-summary']);
  assert.deepStrictEqual(lib.HELP_ARTICLES.filter((a) => a.startsWith('summary/')), sum.articles.map((a) => `summary/${a}`));
  const how = fs.readFileSync(path.join(__dirname, '..', 'help', 'articles', 'summary', 'how-summaries.md'), 'utf8');
  assert.strictEqual(how.split('(summary/edit-summary.md)').length - 1, 1);
});

test('ED-8: 記事「要約を書き直す」の近道の表の数字の行は、型の表（BLOCK_TYPES の近道）と同じ。/ メニュー・記法・Enter と Backspace・⠿ と ＋・［要約を再生成］の節がある', () => {
  const art = fs.readFileSync(path.join(__dirname, '..', 'help', 'articles', 'summary', 'edit-summary.md'), 'utf8');
  assert.match(art, /^title: 要約を書き直す$/m);
  const rows = [...art.matchAll(/^\| \[\[Ctrl\+Shift\+(\d)\]\] \| ([^|]+) \|$/gm)].map((m) => [`Digit${m[1]}`, m[2].trim()]);
  assert.deepStrictEqual(rows, E.VERSION_ROWS.filter((r) => r.code).map((r) => [r.code, r.label]));
  for (const id of ['rows', 'slash', 'markdown', 'handles', 'keys', 'regenerate']) assert.ok(art.includes(`{#${id}}`), id);
  for (const w of ['［要約を再生成］', '［削除］', '［複製］', '［変換 ▸］', '［作り直す］', '［やめる］', '最近使ったもの', '[[Shift+Enter]]', '[[Ctrl+/]]']) assert.ok(art.includes(w), w);
  assert.ok(!/<pre|```/.test(art), 'pre の要素を使った（引き継いだ (c)）');
});

test('ED-8（EQ4 (a)・決めたこと 35）: 人が直した行があるときだけ［要約を再生成］の前に確かめる（［作り直す］［やめる］）。0.11.0 の印の行は AI の行', T, async () => {
  const human = [{ id: 'a1', type: 'heading', text: '決定事項' }, { id: 'a2', type: 'bullet', text: '来月に試す', cites: ['s2'], citeState: 'linked' },
    { id: 'a3', type: 'bullet', text: '人が足した行', cites: [], citeState: 'manual' }];
  const ai = [{ id: 'k0', type: 'heading', level: 2, text: '抜け・重なりチェック' }, { id: 'k1', type: 'bullet', text: '未確認: 予算', cites: [], citeState: 'manual', mark: 'check', unconfirmed: true },
    { id: 'k2', type: 'paragraph', text: '本文' }];
  for (const [blocks, ask] of [[human, true], [ai, false], [[{ id: 'q1', type: 'quote', text: '型を変えた行' }], true], [[{ id: 's1', type: 'todo', text: '直した', citeState: 'stale' }], true]]) {
    const l = await openReal({ pa1: blocks }, { returns: { pageSummarize: () => ({ ok: true, stat: { linked: 1, total: 1 } }) } });
    try {
      const btn = () => $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === '要約を再生成');
      const dlg = () => l.document.querySelector('.askbox');
      const p = btn().onclick();
      await l.drain();
      if (!ask) {
        await p;
        assert.strictEqual(dlg(), null, JSON.stringify(blocks));
        assert.strictEqual(l.called('pageSummarize').length, 1);
        continue;
      }
      assert.ok(dlg(), `確かめが出ない: ${JSON.stringify(blocks)}`);
      assert.strictEqual(dlg().getAttribute('role'), 'alertdialog');
      assert.strictEqual(dlg().querySelector('.askmsg').textContent, '書き直した要約を作り直しますか？ 足した行や変えた型は元に戻ります。');
      const bs = dlg().querySelectorAll('button');
      assert.deepStrictEqual(bs.map((b) => b.textContent), ['作り直す', 'やめる']);
      assert.strictEqual(l.document.activeElement, bs[1], '初めのフォーカスが［やめる］でない');
      bs[1].dispatchEvent({ type: 'click' });
      await p;
      await l.drain();
      assert.strictEqual(dlg(), null);
      assert.strictEqual(l.called('pageSummarize').length, 0, '［やめる］で作り直した');
      const p2 = btn().onclick();
      await l.drain();
      dlg().querySelectorAll('button')[0].dispatchEvent({ type: 'click' });
      await p2;
      await l.drain();
      assert.strictEqual(l.called('pageSummarize').length, 1);
      // Esc は［やめる］
      const p3 = btn().onclick();
      await l.drain();
      const ev = l.key({ key: 'Escape' }, dlg());
      await p3;
      assert.strictEqual(ev.defaultPrevented, true);
      assert.strictEqual(l.called('pageSummarize').length, 1);
      assert.deepStrictEqual(l.errors.map(fmt), []);
    } finally { l.done(); }
  }
});

// 2026-10-26 の持ち主の答え（点検4「どんな手直しでも確かめる（おすすめ）」）
test('ED-8・点検4: AI の型だけの要約でも、行を消す・動かす・複製・見出しの段を変えた後は［要約を再生成］の前に確かめる。作り直した要約が届いた後は聞かない', T, async () => {
  const AI = [{ id: 'h1', type: 'heading', level: 2, text: '決定事項' }, { id: 'b1', type: 'bullet', text: '来月に出す', cites: ['s2'], citeState: 'linked' },
    { id: 'p1', type: 'paragraph', text: '本文の行' }, { id: 'b2', type: 'bullet', text: '見積もりを取る', cites: [], citeState: 'linked' }];
  const acts = {
    remove: (l) => { rowOf(l, 'p1').querySelector('.grip').dispatchEvent({ type: 'click' }); itemsOf(menuOf(l))[0].dispatchEvent({ type: 'click' }); },
    move: (l) => { const t = typeIn(l, 'b1', '来月に出す', 0); l.key({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true, shiftKey: true }, t); },
    duplicate: (l) => { const t = typeIn(l, 'b2', '見積もりを取る', 0); l.key({ key: 'd', code: 'KeyD', ctrlKey: true }, t); },
    level: (l) => { const t = typeIn(l, 'h1', '決定事項', 0); l.key({ key: '#', code: 'Digit3', ctrlKey: true, shiftKey: true }, t); },
  };
  for (const [name, act] of Object.entries(acts)) {
    const l = await openReal({ pa1: AI }, { returns: { pageSummarize: () => ({ ok: true, stat: { linked: 1, total: 1 } }) } });
    try {
      const btn = () => $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === '要約を再生成');
      const dlg = () => l.document.querySelector('.askbox');
      act(l);
      await l.drain();
      assert.strictEqual(l.page().summaryEdited, true, `${name}: DB に印が無い`);
      assert.ok(!l.page().blocks.some((b) => b.citeState === 'manual' || b.citeState === 'stale'), `${name}: 人の行ができた（見本の作りの誤り）`);
      const p = btn().onclick();
      await l.drain();
      assert.ok(dlg(), `${name}: 確かめが出ない`);
      dlg().querySelectorAll('button')[1].dispatchEvent({ type: 'click' });
      await p;
      await l.drain();
      assert.strictEqual(l.called('pageSummarize').length, 0, name);
      // 作り直した要約（印の無いページ）が届いたら、次は聞かない
      const fresh = l.page();
      delete fresh.summaryEdited;
      fresh.blocks = AI;
      l.fire('onPageUpdated', { page: fresh, segments: [] });
      await l.drain();
      const p2 = btn().onclick();
      await l.drain();
      assert.strictEqual(dlg(), null, `${name}: 作り直した後も聞いた`);
      await p2;
      assert.strictEqual(l.called('pageSummarize').length, 1, name);
      assert.deepStrictEqual(l.errors.map(fmt), []);
    } finally { l.done(); }
  }
});

// 点検5（作り手が決めた。独立した点検の後）: 分けた前の文の終わりに空白があっても、Enter の1回は oplog の1行（blur が同じ文を送り直さない）
test('ED-4・点検5: 空白の後ろで Enter（前の文が「来週の 」）→ 両方の行の blur の後も送るのは blockSplit の1回だけで oplog は1行。前の行は DB の文のまま', T, async () => {
  for (const [text, at] of [['来週の 月曜に出す', 4], ['来週に出す ', 6], [' 来週に出す', 1]]) {
    const l = await openReal({ pa1: BASE() });
    try {
      const n0 = l.db.prepare('select count(*) as c from oplog').get().c;
      const t = typeIn(l, 'b1', text, at);
      l.key({ key: 'Enter' }, t);
      await l.drain();
      const nb = l.page().blocks[2];
      // 本物ではフォーカスが新しい行へ移ると前の行に blur が来る（偽 DOM は起こさないので受け口を呼ぶ）。新しい行からも離れる
      txtOf(l, 'b1').onblur();
      txtOf(l, nb.id).onblur();
      await l.drain();
      assert.deepStrictEqual(sent(l), [['blockSplit', 'pa1', 'b1', text, at]], text);
      assert.strictEqual(l.db.prepare('select count(*) as c from oplog').get().c - n0, 1, `${text}: oplog`);
      assert.strictEqual(l.page().blocks[1].text, text.slice(0, at), text);
      assert.deepStrictEqual(l.errors.map(fmt), []);
    } finally { l.done(); }
  }
});

// 点検3（作り手が決めた。文書と作りの食い違い）: 行の頭の記法は、作り（mdCheck・shortcutFor）のとおり文のある行の頭でも変わる。区切り線だけ何も書いていない行
test('ED-8・点検3: 記事「要約を書き直す」の行の頭の記法は、後ろに文がある行でも変わると書き、区切り線だけ何も書いていない行と書く。画面も文のある行の頭の「- 」で箇条書きになり文は残り、「---」は文のある行では変わらない', T, async () => {
  const art = fs.readFileSync(path.join(__dirname, '..', 'help', 'articles', 'summary', 'edit-summary.md'), 'utf8');
  const sec = art.slice(art.indexOf('{#markdown}'), art.indexOf('{#handles}'));
  assert.ok(!sec.includes('何も書いていない行の頭'), '記法は何も書いていない行だけと書いている（作りは文のある行の頭でも変わる）');
  assert.ok(sec.includes('後ろに文がある行でも'), sec);
  assert.ok(sec.includes('| `---` | 区切り線（何も書いていない行だけ。'), sec);
  const l = await openReal({ pa1: BASE() });
  try {
    let t = typeIn(l, 'p1', '- あいうえお', 2);
    t.dispatchEvent({ type: 'input' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 'p1', 'bullet']]);
    assert.strictEqual(txtOf(l, 'p1').textContent, 'あいうえお');
    assert.deepStrictEqual([l.page().blocks[2].type, l.page().blocks[2].text], ['bullet', 'あいうえお']);
    t = typeIn(l, 'b1', '---来週に出す', 3);
    t.dispatchEvent({ type: 'input' });
    await l.drain();
    assert.deepStrictEqual(sent(l), [['blockTurnInto', 'pa1', 'p1', 'bullet']]);
    assert.strictEqual(t.textContent, '---来週に出す');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
