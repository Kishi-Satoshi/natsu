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
