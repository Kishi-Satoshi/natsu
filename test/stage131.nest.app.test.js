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
