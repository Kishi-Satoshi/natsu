/* stage170.rv61.app.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の点検 4（rv61）の直しの画面
 *  重要 1（R98。持ち主の答え「Enter と同じく中に作る（おすすめ）」）: コールアウトの貼り付け・/ の挿入・＋ も Enter と同じくコールアウトの中に作る
 *  重要 2（R99）: セルの Esc で行を選んだ後（フォーカスは行の頭のチェック）も、Ctrl+Z・↑↓・Enter が効く
 *  軽い 1（R100）: 残った変異を殺すテスト（表の上の Esc・全部のチェックの印・ビューから外れた行の Tab）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせ、命令は本物の preload から一時の DB に本当に通す（helpers/realapp.js）。
 * Notion の動きは docs/plans/notion-behavior.md の項目番号（X-25・X-31・V-T44）で指す。データベースの題名・列の名前・行の題名は作った物（D77 の外）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { realApp } = require('./helpers/realapp');
const { samplePage } = require('./helpers/dbtmp');
const BT = require('../src/blockTree');

const T = { timeout: 60000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const kid = (id, o = {}) => ({ id, type: 'paragraph', text: `${id}の文`, citeState: 'manual', cites: [], ...o });
const callout = (id, text, o = {}) => ({ id, type: 'callout', icon: '💡', text, citeState: 'manual', cites: [], ...o });
// 議事録のページ（要約の欄）を種にして開く
async function openNote(blocks) {
  const l = await realApp({ seed: (t) => { const { page, segments } = samplePage('pa1'); t.seed({ ...page, blocks }, segments); } });
  l.fire('onPageOpen', 'pa1'); await l.drain(120);
  return l;
}
const rowsOf = (l) => $(l, 'pNote').querySelectorAll('.blk');
const rowOf = (l, id) => rowsOf(l).find((e) => e.dataset.id === id);
const txtOf = (l, id) => rowOf(l, id).querySelector('.txt');
const pageOf = (l) => l.call('page.get', { id: 'pa1' }).page;
const kidsOf = (l, id) => BT.locate(pageOf(l).blocks, id).b.children || [];
function typeIn(l, id, text, at = text.length) {
  const t = txtOf(l, id);
  t.focus();
  t.textContent = text;
  l.caret.set(t, at);
  return t;
}
const press = async (l, el, key, o = {}) => { const ev = l.key({ key, ...o }, el); await l.drain(80); return ev; };
function pasteIn(t, text) {
  t.dispatchEvent({ type: 'paste', clipboardData: { getData: (k) => (k === 'text/plain' ? text : '') }, preventDefault() {} });
}

// ---------------------------------------------------------------- 重要 1（R98）
test('rv61 重要 1・貼り付け（R98・BQ31・決めたこと 78・X-31）: コールアウトの文の途中・末尾で何行かを貼る → blockPaste の inside が真で、貼った行と後ろの文の行はコールアウトの中（最初の子から）。子のあるコールアウトも前からの子の前', T, async () => {
  const l = await openNote([kid('x'), callout('c', 'お知らせ'), callout('ck', '子あり', { children: [kid('k1')] }), kid('y')]);
  try {
    let t = typeIn(l, 'c', 'お知らせ', 2);
    pasteIn(t, '貼一\n貼二');
    await l.drain();
    let a = l.called('blockPaste').at(-1).args;
    assert.deepStrictEqual([a[1], a[3], a[5], a[6]], ['c', 2, undefined, true], 'コールアウトの文の途中で inside が真でない');
    assert.deepStrictEqual(pageOf(l).blocks.map((b) => b.id), ['x', 'c', 'ck', 'y'], '貼った行がコールアウトの外に出た');
    // 0.18.0 XE-2（計画 docs/plans/2026-11-18-180.md の決めたこと 58・「意図して変えるテスト」）で意図して直した: 改行1つの素の文は1つの行（行の中の改行）。
    // コールアウトは今の block.paste の決まりのまま（カーソルの所で分ける: CR28）
    assert.deepStrictEqual([BT.locate(pageOf(l).blocks, 'c').b.text, ...kidsOf(l, 'c').map((b) => `${b.type}:${b.text}`)], ['お知', 'paragraph:貼一\n貼二', 'paragraph:らせ']);
    assert.ok(rowsOf(l).filter((e) => e.dataset.parent === 'c').length === 2, '貼った行と後ろの文の行がコールアウトの中に見えない');
    // 末尾
    t = typeIn(l, 'ck', '子あり');
    pasteIn(t, '末一\n末二');
    await l.drain();
    a = l.called('blockPaste').at(-1).args;
    assert.deepStrictEqual([a[1], a[6]], ['ck', true], 'コールアウトの文の末尾で inside が真でない');
    assert.deepStrictEqual(kidsOf(l, 'ck').map((b) => b.text).filter((s) => s !== ''), ['末一\n末二', 'k1の文'], '子のあるコールアウトの末尾で貼った行が前からの子の前に無い');   // 0.18.0 XE-2: 1つの行
    assert.deepStrictEqual(pageOf(l).blocks.map((b) => b.id), ['x', 'c', 'ck', 'y']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('rv61 重要 1・/ の挿入（R98・NR22・決めたこと 78）: コールアウトの文のある行で / から型を選ぶ → blockInsert の1回で、足した行はコールアウトの最初の子', T, async () => {
  const l = await openNote([kid('x'), callout('c', 'お知らせ'), kid('y')]);
  try {
    const t = typeIn(l, 'c', 'お知らせ /todo');
    t.dispatchEvent({ type: 'input' });
    await l.drain(40);
    const menu = $(l, 'pNote').querySelector('.slashmenu');
    assert.ok(menu && menu.querySelectorAll('.sopt')[0].dataset.key === 'todo', '前提: / のメニューの先頭が ToDo でない');
    await press(l, t, 'Enter');
    const ins = l.called('blockInsert').map((c) => c.args);
    assert.deepStrictEqual(ins, [['pa1', '', 'todo', undefined, 'c']], '/ で足す行がコールアウトの最初の子でない');
    const kids = kidsOf(l, 'c');
    assert.deepStrictEqual(kids.map((b) => b.type), ['todo']);
    assert.deepStrictEqual(pageOf(l).blocks.map((b) => b.id), ['x', 'c', 'y'], '足した行がコールアウトの外に出た');
    assert.strictEqual(l.document.activeElement, txtOf(l, kids[0].id), '足した行にフォーカスが無い');
    assert.strictEqual(rowOf(l, kids[0].id).dataset.depth, '1');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('rv61 重要 1・＋（R98・NR22・決めたこと 78）: コールアウトの ＋ → blockInsert の1回でコールアウトの最初の子にテキストの行を足し、その行で / のメニューを開く。子のあるコールアウトも前からの子の前', T, async () => {
  const l = await openNote([kid('x'), callout('c', 'お知らせ'), callout('ck', '子あり', { children: [kid('k1')] }), kid('y')]);
  try {
    rowOf(l, 'c').querySelector('.plus').dispatchEvent({ type: 'click' });
    await l.drain();
    assert.deepStrictEqual(l.called('blockInsert').map((c) => c.args), [['pa1', '', 'paragraph', undefined, 'c']], '＋ で足す行がコールアウトの最初の子でない');
    const nk = kidsOf(l, 'c');
    assert.deepStrictEqual(nk.map((b) => b.type), ['paragraph']);
    assert.ok($(l, 'pNote').querySelector('.slashmenu'), '足した行で / のメニューが開かない');
    assert.strictEqual(rowOf(l, nk[0].id).dataset.depth, '1', '足した行がコールアウトの中に描かれない');
    rowOf(l, 'ck').querySelector('.plus').dispatchEvent({ type: 'click' });
    await l.drain();
    assert.deepStrictEqual(l.called('blockInsert').at(-1).args, ['pa1', '', 'paragraph', undefined, 'ck']);
    assert.deepStrictEqual(kidsOf(l, 'ck').map((b) => b.id).slice(1), ['k1'], '子のあるコールアウトの ＋ が前からの子の前に足さない');
    assert.deepStrictEqual(pageOf(l).blocks.map((b) => b.id), ['x', 'c', 'ck', 'y']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 重要 2（R99）・軽い 1（R100）: データベースの表
async function openTable(filter) {
  const l = await realApp({ before: (call) => {
    const id = call('db.create', {}).id;
    const c1 = call('col.add', { db: id, type: 'text', name: 'メモ' }).col.id;
    const rows = ['見積もり', '発注', '検収'].map((ti, i) => call('row.add', { db: id, title: ti, cells: { [c1]: `メモ ${i}` } }).id);
    if (filter) call('view.update', { db: id, viewId: 'v1', patch: { filter: { op: 'and', items: [{ col: c1, cmp: 'contains', value: 'メモ' }] } } });
    return { id, c1, rows };
  } });
  l.fire('onPageOpen', l.made.id); await l.drain(120);
  return l;
}
const tbox = (l) => $(l, 'pDb');
const tgrid = (l) => tbox(l).querySelector('.dbgrid');
const trows = (l) => tbox(l).querySelectorAll('.dbrow').filter((r) => r.dataset.id);
const cellAt = (l, rowId, col) => trows(l).find((r) => r.dataset.id === rowId).querySelectorAll('.dbcell').find((c) => c.dataset.col === col);
const checkOf = (l, rowId) => trows(l).find((r) => r.dataset.id === rowId).querySelector('.dbcheck');
const allOf = (l) => tbox(l).querySelector('.dbcheckall');
const editorOf = (l) => tbox(l).querySelector('.dbedit');
const act = (l) => l.document.activeElement;
const k = async (l, el, o, n = 80) => { const ev = l.key(o, el); await l.drain(n); return ev; };
const click = async (l, el, n = 80) => { el.dispatchEvent({ type: 'click' }); await l.drain(n); };
const at = (l) => { const a = act(l); return a && a.dataset && a.dataset.col ? [a.parentNode.dataset.id, a.dataset.col] : null; };
const checked = (l) => trows(l).filter((r) => r.querySelector('.dbcheck').checked).map((r) => r.dataset.id);
const titleOf = (l, id) => l.call('db.view', { id: l.made.id, viewId: 'v1', from: 0, count: 50 }).rows.find((r) => r.id === id).title;
const selCells = (l) => tbox(l).querySelectorAll('.dbcell').filter((c) => c.getAttribute('aria-selected') === 'true');
// 書いている → Esc（決める）→ Esc（行を選ぶ。フォーカスは行の頭のチェック）
async function escToRow(l, rowId) {
  await k(l, act(l), { key: 'Escape' });
  assert.ok(act(l) === checkOf(l, rowId), '前提: セルの Esc の後のフォーカスがその行のチェックでない');
}

test('rv61 重要 2・行の頭のチェック（R99・決めたこと 85・86・X-25・V-T44）: 題名を書いて Esc を2回（行を選ぶ）→ そのチェックの上の Ctrl+Z で書いた字が戻り、Ctrl+Y でやり直す。↓・↑ は下・上の行の頭のセル、Enter はその行の頭のセルを選ぶ（書き手は開かない）', T, async () => {
  const l = await openTable();
  try {
    const { rows: [r0, r1, r2] } = l.made;
    await click(l, cellAt(l, r1, 'title'));
    editorOf(l).value = '発注した';
    await k(l, editorOf(l), { key: 'Escape' });
    assert.deepStrictEqual(at(l), [r1, 'title'], '前提: 書いている間の Esc でそのセルを選んだ形にならない');
    assert.strictEqual(titleOf(l, r1), '発注した');
    await escToRow(l, r1);
    let ev = await k(l, act(l), { key: 'z', code: 'KeyZ', ctrlKey: true }, 200);
    assert.strictEqual(ev.defaultPrevented, true, 'チェックの上の Ctrl+Z を止めない');
    assert.strictEqual(titleOf(l, r1), '発注', 'チェックの上の Ctrl+Z で書いた字が戻らない');
    ev = await k(l, act(l), { key: 'y', code: 'KeyY', ctrlKey: true }, 200);
    assert.strictEqual(titleOf(l, r1), '発注した', 'チェックの上の Ctrl+Y でやり直さない');
    // ↓ は下の行の頭のセル
    let ck = checkOf(l, r1);
    ck.focus();
    ev = await k(l, ck, { key: 'ArrowDown' });
    assert.strictEqual(ev.defaultPrevented, true);
    assert.deepStrictEqual(at(l), [r2, 'title'], 'チェックの上の ↓ が下の行の頭のセルを選ばない');
    // ↑ は上の行の頭のセル
    await escToRow(l, r2);
    await k(l, act(l), { key: 'ArrowUp' });
    assert.deepStrictEqual(at(l), [r1, 'title'], 'チェックの上の ↑ が上の行の頭のセルを選ばない');
    // Enter はその行の頭のセル（選ぶだけ）
    await escToRow(l, r1);
    await k(l, act(l), { key: 'Enter' });
    assert.deepStrictEqual(at(l), [r1, 'title'], 'チェックの上の Enter がその行の頭のセルを選ばない');
    assert.strictEqual(editorOf(l), null, 'チェックの上の Enter で書き手が開いた');
    // いちばん上の行の ↑・いちばん下の行の ↓ はその行の頭のセル
    ck = checkOf(l, r0); ck.focus();
    await k(l, ck, { key: 'ArrowUp' });
    assert.deepStrictEqual(at(l), [r0, 'title']);
    ck = checkOf(l, r2); ck.focus();
    await k(l, ck, { key: 'ArrowDown' });
    assert.deepStrictEqual(at(l), [r2, 'title']);
    // 変換中の Enter・飾りのキーの ↓ は何もしない
    ck = checkOf(l, r1); ck.focus();
    ev = await k(l, ck, { key: 'Enter', isComposing: true });
    assert.ok(act(l) === ck && ev.defaultPrevented === false, '変換中の Enter で動いた');
    ev = await k(l, ck, { key: 'ArrowDown', shiftKey: true });
    assert.ok(act(l) === ck && ev.defaultPrevented === false, 'Shift+↓ で動いた');
    // Esc は今どおり（チェックを全部外し、フォーカスは表）
    await click(l, cellAt(l, r0, 'title'));
    await k(l, editorOf(l), { key: 'Escape' });
    await escToRow(l, r0);
    await k(l, act(l), { key: 'Escape' });
    assert.deepStrictEqual(checked(l), []);
    assert.ok(act(l) === tgrid(l));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('rv61 軽い 1・表の上の Esc（R100・決めたこと 86）: 行にチェックを入れて表にフォーカスがあるときの Esc → チェックを全部外し、帯も消え、フォーカスは表のまま', T, async () => {
  const l = await openTable();
  try {
    const { rows: [r0, r1] } = l.made;
    for (const r of [r0, r1]) { const ck = checkOf(l, r); ck.checked = true; ck.onchange(); }
    await l.drain(20);
    assert.deepStrictEqual(checked(l), [r0, r1]);
    tgrid(l).focus();
    const ev = await k(l, tgrid(l), { key: 'Escape' });
    assert.strictEqual(ev.defaultPrevented, true, '表の上の Esc を止めない');
    assert.deepStrictEqual(checked(l), [], '表の上の Esc でチェックが残った');
    assert.ok(act(l) === tgrid(l), '表の上の Esc の後のフォーカスが表でない');
    assert.strictEqual(selCells(l).length, 0);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('rv61 軽い 1・全部のチェック（R100・決めたこと 86）: 見出しの全部のチェックで選んだ後、セルを押す → 全部のチェックの印も外れる。もう一度全部を選んでセルの Esc（その行だけ）→ 全部のチェックの印は外れる', T, async () => {
  const l = await openTable();
  try {
    const { c1, rows: [r0, r1, r2] } = l.made;
    allOf(l).checked = true; await allOf(l).onchange(); await l.drain(40);
    assert.deepStrictEqual(checked(l), [r0, r1, r2], '前提: 全部のチェックで全部の行を選ばない');
    await click(l, cellAt(l, r1, c1));
    assert.deepStrictEqual(checked(l), []);
    assert.strictEqual(allOf(l).checked, false, 'セルを押しても全部のチェックの印が残った');
    await k(l, editorOf(l), { key: 'Escape' });
    allOf(l).checked = true; await allOf(l).onchange(); await l.drain(40);
    assert.deepStrictEqual(checked(l), [r0, r1, r2]);
    cellAt(l, r1, c1).focus();
    await k(l, cellAt(l, r1, c1), { key: 'Escape' });
    assert.deepStrictEqual(checked(l), [r1]);
    assert.strictEqual(allOf(l).checked, false, 'セルの Esc でその行だけにしても全部のチェックの印が残った');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('rv61 軽い 1・ビューから外れた行の Tab（R100・決めたこと 87）: 行の末のセルを書いて、絞り込みから外れる値にして Tab → 書いた値を決め、ほかの行のセルへ飛ばない（何も選ばない形で、フォーカスは表）', T, async () => {
  const l = await openTable(true);
  try {
    const { id, c1, rows: [r0, r1, r2] } = l.made;
    await click(l, cellAt(l, r1, c1));
    editorOf(l).value = '済み';
    await k(l, editorOf(l), { key: 'Tab' }, 200);
    assert.deepStrictEqual(l.called('rowSetCell').map((c) => c.args), [[id, r1, c1, '済み']]);
    assert.deepStrictEqual(trows(l).map((r) => r.dataset.id), [r0, r2], '前提: 書いた行が絞り込みから外れない');
    assert.strictEqual(at(l), null, `ビューから外れた行の Tab でほかの行のセル（${JSON.stringify(at(l))}）へ飛んだ`);
    assert.strictEqual(selCells(l).length, 0);
    assert.ok(act(l) === tgrid(l), 'ビューから外れた行の Tab の後のフォーカスが表でない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
