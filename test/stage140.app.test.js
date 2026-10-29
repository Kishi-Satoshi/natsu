/*
 * stage140.app.test.js — 0.14.0 の画面（計画 docs/plans/2026-10-26-140.md の Task EB-3〜）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。命令は一時の DB（helpers/dbtmp.js）を本当に通す。
 * preload の onEditStep は、この台の命令の口が preload と同じ決まり（戻せる命令が ok で changed のときだけ・答えより先に { cmd, pageId, step: tx }）で起こす。
 * カーソルは simrun の caret の継ぎ目（l.caret）で置く（偽の DOM に getSelection・Range が無い）。
 * EB-3（E7・F100・F103）: 要約の欄の Ctrl+Z・Ctrl+Shift+Z・Ctrl+Y（ページごとの列・1つの動作は1歩・打った文字は手が止まる所で区切る・
 *       打っている途中の Ctrl+Z は保存してから戻す・記法の直後は記号を戻す・後から変わっていたら戻さない・再生成の後は列を空に・題名などは欄の中の戻し）。
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
const U = require('../src/undoBook');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const HTML = fs.readFileSync(APP, 'utf8');
const T = { timeout: 15000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const T1 = titleAt('2026-10-29T01:00:00.000Z');

// ---------------------------------------------------------------- 台（stage131.nest.app の openReal と同じ形に、edit.revert と onEditStep を足した）
const NOW = () => new Date('2026-10-29T01:02:03.000Z');
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
  editRevert: (pageId, steps) => ['edit.revert', { pageId, steps }],
};
async function openReal(pages, o = {}) {
  const t = tmpDb();
  const { db } = t.open();
  for (const [id, v] of Object.entries(pages)) {
    const { page, segments } = samplePage(id);
    const o2 = Array.isArray(v) ? { blocks: v } : v;
    t.seed({ ...page, ...o2, title: o2.title || T1, blocks: o2.blocks }, segments);
  }
  const steps = [];   // onEditStep に渡した歩み（{ cmd, pageId, step }）
  let L = null;
  const call = (cmd, args, role = 'app') => {
    const tx = `${role[0]}:eb3-${String(++txn).padStart(6, '0')}`;
    const r = core.call(db, { role, cmd, args, tx }, { now: NOW, labels: {} });
    if (!r.ok) throw Object.assign(new Error(r.code), { code: r.code, retry: Boolean(r.retry) });
    // preload と同じ: 戻せる命令が ok で changed のときだけ、答えより先に画面の受け口へ（R59・R75）
    if (role === 'app' && (r.changed || r.dupChanged) && U.UNDO_CMDS.has(cmd)) {
      const s = { cmd, pageId: typeof args.pageId === 'string' ? args.pageId : args.id, step: tx };
      steps.push(s);
      if (L) L.fire('onEditStep', s);
    }
    return r.result;
  };
  const wrap = (fn) => (...a) => { try { return fn(...a); } catch (e) { return Promise.reject(e); } };
  const returns = {
    meetingTypes: () => lib.typesForView(), memoTypes: () => M.listMemoTypes(),
    pagesSearch: wrap(() => call('pages.list', { q: '' })), pageGet: wrap((id) => call('page.get', { id })),
    copy: () => true,
    ...(o.returns || {}),
  };
  for (const [name, f] of Object.entries(CMDS)) if (!(o.returns && o.returns[name])) returns[name] = wrap((...a) => call(...f(...a)));
  const l = await load(APP, { caret: true, returns });
  L = l;
  l.t = t; l.db = db; l.call = call; l.steps = steps;
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
const revs = (l) => l.called('editRevert').map((c) => c.args);
const updates = (l) => l.called('blockUpdate').map((c) => c.args);
function typeIn(l, id, text, at = text.length, end = at) {
  const t = txtOf(l, id);
  t.focus();
  t.textContent = text;
  l.caret.set(t, at, end);
  return t;
}
// ページの中身（R60: 戻さない・作り直す欄と、画面に添える欄は比べない。行の citeSkip は書く読みが毎回付け直す短い行の印で、戻さない: 決めたこと 5）
const noSkip = (list) => (Array.isArray(list) ? list.map((b) => { const { citeSkip, ...x } = b; return Array.isArray(x.children) ? { ...x, children: noSkip(x.children) } : x; }) : list);   // eslint-disable-line no-unused-vars
const body = (p) => { const o = structuredClone(p); for (const k of ['updatedAt', 'citeStat', 'summaryEdited', 'rev', 'routeText', 'qualityView']) delete o[k]; o.blocks = noSkip(o.blocks); return o; };
const Z = { key: 'z', code: 'KeyZ', ctrlKey: true };
const SZ = { key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true };
const Y = { key: 'y', code: 'KeyY', ctrlKey: true };
// 要約の欄の行にフォーカスがあればそこで、無ければ見出しの行でキーを押す
function press(l, o) {
  const a = l.document.activeElement;
  const box = $(l, 'pNote');
  let inRows = false;
  for (let n = a; n; n = n.parentNode) if (n === box) inRows = true;
  const el = inRows ? a : txtOf(l, rowsOf(l)[0].dataset.id);
  if (!inRows) el.focus();
  return l.key(o, el);
}
const toastOf = (l) => $(l, 'toast').textContent;
const BASE = (x = '') => [{ id: `h1${x}`, type: 'heading', level: 2, text: '決定事項' }, { id: `b1${x}`, type: 'bullet', text: '来週に出す', cites: ['s2'], citeState: 'linked' },
  { id: `p1${x}`, type: 'paragraph', text: 'あいうえお' }, { id: `t1${x}`, type: 'todo', text: '見積もりを取る', checked: false, cites: [], citeState: 'manual' },
  { id: `e1${x}`, type: 'paragraph', text: '' }];
function dragTo(l, id, clientY) {
  const box = $(l, 'pNote');
  const els = box.querySelectorAll('.blk');
  els.forEach((e, i) => { e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: 0, right: 100, width: 100 }); });
  els.find((e) => e.dataset.id === id).ondragstart({ dataTransfer: { setData() {}, effectAllowed: '' } });
  return box.ondrop({ preventDefault() {}, clientY });
}
function menuPick(l, id, label) {
  rowOf(l, id).querySelector('.grip').onclick();
  const item = l.document.querySelector('.blockmenu').querySelectorAll('.mitem').find((b) => b.textContent === label);
  assert.ok(item, `⠿ のメニューに ${label} が無い`);
  item.onclick();
}

// ---------------------------------------------------------------- EB-3
test('EB-3: 画面の写し（app.html の undoBook）は src/undoBook.js と同じ答え（列の鍵・100 歩・新しい歩みでやり直しが空・戻した歩みを反対の列へ・欄ごとに空に）', () => {
  const at = HTML.indexOf('  // ---- undoBook の写し');
  const end = HTML.indexOf('  // ---- undoBook の写しはここまで');
  assert.ok(at > 0 && end > at, 'app.html に undoBook の写しが無い');
  const app = new Function(`${HTML.slice(at, end)}\nreturn { UNDO_MAX, TYPE_PAUSE_MS, bookKey, bookPush, bookTakeUndo, bookTakeRedo, bookDone, bookDrop };`)();   // eslint-disable-line no-new-func
  assert.strictEqual(app.UNDO_MAX, U.UNDO_MAX);
  assert.strictEqual(app.TYPE_PAUSE_MS, U.TYPE_PAUSE_MS);
  const k1 = U.bookKey('pa1', 'note'); const k2 = U.bookKey('pa1', 'memo'); const k3 = U.bookKey('pb2', 'note');
  assert.strictEqual(app.bookKey('pa1', 'note'), k1);
  const run = (B) => {
    let b = {};
    const log = [];
    for (let i = 0; i < 105; i++) b = B.bookPush(b, i % 3 ? k1 : k3, [`a:s${i}`]);
    b = B.bookPush(b, k2, [], { literal: { before: [], after: [{ id: 'm1' }] } });
    b = B.bookPush(b, k2, []);
    let r = B.bookTakeUndo(b, k1); log.push(r.entry); b = B.bookDone(r.book, k1, 'undo', 'a:r1');
    r = B.bookTakeRedo(b, k1); log.push(r.entry); b = B.bookDone(r.book, k1, 'redo', 'a:r2');
    r = B.bookTakeRedo(b, k1); log.push(r.entry); b = r.book;
    r = B.bookTakeUndo(b, k2); log.push(r.entry); b = B.bookDone(r.book, k2, 'undo', r.entry && { literal: r.entry.literal });
    b = B.bookPush(b, k1, ['a:new']);
    log.push(JSON.parse(JSON.stringify(b)));
    log.push(B.bookDrop(b, k1), B.bookDrop(b, 'pa1'), B.bookTakeUndo({}, k1));
    return JSON.parse(JSON.stringify(log));
  };
  assert.deepStrictEqual(run(app), run(U));
});

test('EB-3・F100: Enter・行頭の Backspace・記法の『---』・⠿ の複製・ドラッグ・消す・ToDo のチェック・担当の直しが、それぞれ Ctrl+Z の1回で戻り（editRevert の1回・歩みは全部）、Ctrl+Shift+Z と Ctrl+Y で戻る', T, async () => {
  const acts = [
    ['Enter', (l) => l.key({ key: 'Enter' }, typeIn(l, 'p1', 'あいうえお', 2))],
    ['行頭の Backspace', (l) => l.key({ key: 'Backspace' }, typeIn(l, 'p1', 'あいうえお', 0))],
    ['記法の ---', (l) => typeIn(l, 'e1', '---', 3).dispatchEvent({ type: 'input' })],
    ['⠿ の複製', (l) => menuPick(l, 'b1', '複製')],
    ['ドラッグ', (l) => dragTo(l, 'e1', 2)],
    ['消す', (l) => menuPick(l, 'p1', '削除')],
    ['ToDo のチェック', async (l) => { const cb = rowOf(l, 't1').querySelector('input'); cb.checked = true; await cb.onchange(); }],
    ['担当の直し', (l) => {
      // 最小 DOM に replaceWith が無いので、ここだけ本物と同じ動きを補う（runtime.app.test と同じ）
      const replaceWith = function (n) { this.parentNode.insertBefore(n, this); this.remove(); };
      const who = rowOf(l, 't1').querySelector('.atag');
      who.replaceWith = replaceWith;
      who.onclick();
      const inp = $(l, 'pNote').querySelector('.atag-edit');
      inp.replaceWith = replaceWith;
      inp.value = '担当B';
      l.key({ key: 'Enter' }, inp);
    }],
  ];
  for (const [name, act] of acts) {
    const l = await openReal({ pa1: BASE() });
    try {
      const before = body(l.page());
      await act(l);
      await l.drain();
      const mine = l.steps.map((s) => s.step);
      assert.ok(mine.length >= 1, `${name}: 歩みが無い`);
      if (name === '記法の ---') assert.strictEqual(mine.length, 2, '記法の --- は変換と下の行の2つの命令');
      const after = body(l.page());
      assert.notDeepStrictEqual(after, before, `${name}: 何も変わっていない（見本の作りの誤り）`);
      press(l, Z);
      await l.drain();
      assert.deepStrictEqual(revs(l), [['pa1', mine]], `${name}: 1回の Ctrl+Z で全部の歩みを1つの editRevert にしない`);
      assert.deepStrictEqual(body(l.page()), before, `${name}: 戻らない`);
      assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), l.page().blocks.map((b) => b.id), `${name}: 画面の行が DB と違う`);
      press(l, SZ);
      await l.drain();
      assert.strictEqual(revs(l).length, 2, `${name}: Ctrl+Shift+Z でやり直さない`);
      assert.deepStrictEqual(body(l.page()), after, `${name}: Ctrl+Shift+Z で前と同じにならない`);
      press(l, Z);
      await l.drain();
      assert.deepStrictEqual(body(l.page()), before, `${name}: やり直した後の Ctrl+Z で戻らない`);
      press(l, Y);
      await l.drain();
      assert.deepStrictEqual(body(l.page()), after, `${name}: Ctrl+Y でやり直さない`);
      assert.strictEqual(revs(l).length, 4);
      assert.deepStrictEqual(l.errors.map(fmt), [], name);
    } finally { l.done(); }
  }
});

test('EB-3（決めたこと 8）: 打って 2 秒止まると blockUpdate が1回（偽の時計）。変換中（compositionstart〜compositionend）は数えない', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'p1', 'あいうえおか');
    t.dispatchEvent({ type: 'input' });
    await l.clock.advance(1999);
    await l.drain();
    assert.deepStrictEqual(updates(l), []);
    await l.clock.advance(1);
    await l.drain();
    assert.deepStrictEqual(updates(l), [['pa1', 'p1', { text: 'あいうえおか' }]]);
    assert.strictEqual(l.steps.length, 1, '保存の1回が1歩');
    // 変換中は数えない（確定した後から数える）
    t.dispatchEvent({ type: 'compositionstart' });
    t.textContent = 'あいうえおかき';
    t.dispatchEvent({ type: 'input', isComposing: true });
    await l.clock.advance(5000);
    await l.drain();
    assert.strictEqual(updates(l).length, 1, '変換中に保存した');
    t.dispatchEvent({ type: 'compositionend' });
    await l.clock.advance(1999);
    await l.drain();
    assert.strictEqual(updates(l).length, 1);
    await l.clock.advance(1);
    await l.drain();
    assert.deepStrictEqual(updates(l).slice(1), [['pa1', 'p1', { text: 'あいうえおかき' }]]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3（決めたこと 9）: 打っている途中の Ctrl+Z は、先に保存してからその歩みを戻す（行は前に保存した文に戻る）', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    let t = typeIn(l, 'p1', 'あいうえおか');
    t.dispatchEvent({ type: 'input' });
    await l.clock.advance(2000);
    await l.drain();
    assert.strictEqual(l.page().blocks[2].text, 'あいうえおか');
    t = typeIn(l, 'p1', 'あいうえおかき');   // まだ保存していない
    l.key(Z, t);
    await l.drain();
    assert.deepStrictEqual(updates(l).map((u) => u[2].text), ['あいうえおか', 'あいうえおかき'], '打っていた文を先に保存しない');
    assert.deepStrictEqual(revs(l), [['pa1', [l.steps[1].step]]]);
    assert.strictEqual(l.page().blocks[2].text, 'あいうえおか', '前に保存した文に戻らない');
    assert.strictEqual(txtOf(l, 'p1').textContent, 'あいうえおか');
    assert.strictEqual(l.document.activeElement, txtOf(l, 'p1'));
    // もう1回で、その前の歩み（2 秒で保存した文）も戻る
    press(l, Z);
    await l.drain();
    assert.strictEqual(l.page().blocks[2].text, 'あいうえお');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3・R6（決めたこと 10）: 記法で箇条書きにした直後の Ctrl+Z → テキストの行に戻り、行の頭に『- 』がある（打った文として次の区切りで保存）', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'p1', '- あいうえお', 2);
    t.dispatchEvent({ type: 'input' });
    await l.drain();
    assert.strictEqual(l.page().blocks[2].type, 'bullet');
    assert.strictEqual(txtOf(l, 'p1').textContent, 'あいうえお');
    press(l, Z);
    await l.drain();
    assert.strictEqual(revs(l).length, 1);
    assert.deepStrictEqual([l.page().blocks[2].type, l.page().blocks[2].text], ['paragraph', 'あいうえお']);
    assert.strictEqual(txtOf(l, 'p1').textContent, '- あいうえお', '打った記号が行の頭に戻らない');
    assert.strictEqual(l.document.activeElement, txtOf(l, 'p1'));
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'p1')), [2, 2]);
    assert.ok(!rowOf(l, 'p1').classList.contains('bullet'));
    // 打った文として次の区切り（blur）で保存する
    txtOf(l, 'p1').dispatchEvent({ type: 'blur' });
    await l.drain();
    assert.strictEqual(l.page().blocks[2].text, '- あいうえお');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3・R96: 記法で戻した記号に手を付けずに Ctrl+Z → 記号だけを消す（DB に送らない）。手を付けずに Ctrl+Shift+Z → 記号を消してやり直す（もう一度箇条書き）', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'p1', '- あいうえお', 2);
    t.dispatchEvent({ type: 'input' });
    await l.drain();
    press(l, Z);
    await l.drain();
    assert.strictEqual(txtOf(l, 'p1').textContent, '- あいうえお');
    press(l, SZ);
    await l.drain();
    assert.deepStrictEqual(updates(l), [], '戻した記号を保存してからやり直した（やり直しの列が消える）');
    assert.strictEqual(revs(l).length, 2);
    assert.deepStrictEqual([l.page().blocks[2].type, l.page().blocks[2].text], ['bullet', 'あいうえお']);
    assert.strictEqual(txtOf(l, 'p1').textContent, 'あいうえお');
    press(l, Z);
    await l.drain();
    assert.strictEqual(txtOf(l, 'p1').textContent, '- あいうえお', 'やり直した後の Ctrl+Z でも記号が戻る');
    press(l, Z);
    await l.drain();
    assert.strictEqual(revs(l).length, 3, '記号を消すだけの Ctrl+Z で DB へ送った');
    assert.deepStrictEqual(updates(l), []);
    assert.strictEqual(txtOf(l, 'p1').textContent, 'あいうえお');
    assert.deepStrictEqual([l.page().blocks[2].type, l.page().blocks[2].text], ['paragraph', 'あいうえお']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3・BQ1 (a): 列はページごと。p1 で直して p2 へ移り、p1 に戻って Ctrl+Z → p1 の歩みだけ。p2 で Ctrl+Z → p2 の歩み', T, async () => {
  const l = await openReal({ pa1: BASE(), pb2: BASE('2') });
  try {
    l.key({ key: 'Enter' }, typeIn(l, 'p1', 'あいうえお', 2));
    await l.drain();
    const s1 = l.steps[0].step;
    l.fire('onPageOpen', 'pb2');
    await l.drain();
    l.key({ key: 'Enter' }, typeIn(l, 'p12', 'あいうえお', 3));
    await l.drain();
    const s2 = l.steps[1].step;
    assert.strictEqual(l.page('pb2').blocks.length, 6);
    l.fire('onPageOpen', 'pa1');
    await l.drain();
    press(l, Z);
    await l.drain();
    assert.deepStrictEqual(revs(l), [['pa1', [s1]]], 'ほかのページの歩みを戻した');
    assert.strictEqual(l.page('pa1').blocks.length, 5);
    assert.strictEqual(l.page('pb2').blocks.length, 6, 'ほかのページが戻った');
    press(l, Z);
    await l.drain();
    assert.strictEqual(revs(l).length, 1);
    assert.strictEqual(toastOf(l), 'これ以上は戻せません');
    l.fire('onPageOpen', 'pb2');
    await l.drain();
    press(l, Z);
    await l.drain();
    assert.deepStrictEqual(revs(l).slice(1), [['pb2', [s2]]]);
    assert.strictEqual(l.page('pb2').blocks.length, 5);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3（決めたこと 4・12）: stale が返る → そのページの要約の列が空になり「ほかの所で変わったので、元に戻せませんでした」。やり直しも空', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    l.key({ key: 'Enter' }, typeIn(l, 'p1', 'あいうえお', 2));
    await l.drain();
    const t = typeIn(l, 'b1', '来週の月曜に出す');
    t.dispatchEvent({ type: 'blur' });
    await l.drain();
    assert.strictEqual(l.steps.length, 2);
    // 後から main の書き戻し（再生成）が同じ行を変えた
    const p = l.page();
    l.call('page.put', { page: { ...p, blocks: p.blocks.map((b) => (b.id === 'b1' ? { ...b, text: '作り直した要点' } : b)) }, baseRev: p.rev }, 'main');
    const was = JSON.stringify(body(l.page()));
    press(l, Z);
    await l.drain();
    assert.deepStrictEqual(revs(l), [['pa1', [l.steps[1].step]]]);
    assert.strictEqual(toastOf(l), 'ほかの所で変わったので、元に戻せませんでした');
    assert.strictEqual(JSON.stringify(body(l.page())), was, '中途半端に戻した');
    press(l, Z);
    await l.drain();
    assert.strictEqual(revs(l).length, 1, 'stale の後も列に残った歩みを戻した');
    assert.strictEqual(toastOf(l), 'これ以上は戻せません');
    press(l, SZ);
    await l.drain();
    assert.strictEqual(revs(l).length, 1);
    assert.strictEqual(toastOf(l), 'やり直せるものはありません');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3・R97（決めたこと 12）: 戻す歩みの oplog の行が無い（控えを回して消えた: DB は bad-args）→ stale と同じに列を空にして同じ知らせ', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    l.key({ key: 'Enter' }, typeIn(l, 'p1', 'あいうえお', 2));
    await l.drain();
    const t = typeIn(l, 'b1', '来週の月曜に出す');
    t.dispatchEvent({ type: 'blur' });
    await l.drain();
    assert.strictEqual(l.steps.length, 2);
    l.db.prepare('delete from oplog where tx = ?').run(l.steps[1].step);
    press(l, Z);
    await l.drain();
    assert.strictEqual(revs(l).length, 1);
    assert.strictEqual(toastOf(l), 'ほかの所で変わったので、元に戻せませんでした');
    press(l, Z);
    await l.drain();
    assert.strictEqual(revs(l).length, 1, 'bad-args の後も列に残った歩みを戻した');
    assert.strictEqual(toastOf(l), 'これ以上は戻せません');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3（決めたこと 13）: ［要約を再生成］が済むと、そのページの要約の列が空（作り直しは戻せない）', T, async () => {
  const l = await openReal({ pa1: BASE() }, { returns: { pageSummarize: () => ({ ok: true, stat: { linked: 1, total: 1 } }) } });
  try {
    l.key({ key: 'Enter' }, typeIn(l, 'p1', 'あいうえお', 2));
    await l.drain();
    const t = typeIn(l, 'b1', '来週の月曜に出す');
    t.dispatchEvent({ type: 'blur' });
    await l.drain();
    const p = $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === '要約を再生成').onclick();
    await l.drain();
    l.document.querySelector('.askbox').querySelectorAll('button')[0].dispatchEvent({ type: 'click' });
    await p;
    await l.drain();
    assert.strictEqual(l.called('pageSummarize').length, 1);
    press(l, Z);
    await l.drain();
    assert.deepStrictEqual(revs(l), [], '再生成の後に前の歩みを戻した');
    assert.strictEqual(toastOf(l), 'これ以上は戻せません');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3・P4: 人の行を消しただけ・動かしただけ・型を変えただけ・飾りを付けただけ・Ctrl+Z で戻しただけの要約で［要約を再生成］→ 確かめが出る', T, async () => {
  const AI = [{ id: 'h1', type: 'heading', level: 2, text: '決定事項' }, { id: 'b1', type: 'bullet', text: '来月に出す', cites: ['s2'], citeState: 'linked' },
    { id: 'p1', type: 'paragraph', text: '本文の行' }, { id: 'b2', type: 'bullet', text: '見積もりを取る', cites: [], citeState: 'linked' }];
  const acts = [
    ['消す', async (l) => { menuPick(l, 'p1', '削除'); }],
    ['動かす', async (l) => { const t = txtOf(l, 'p1'); t.focus(); l.caret.set(t, 0); l.key({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true, shiftKey: true }, t); }],
    ['型を変える', async (l) => { const t = txtOf(l, 'p1'); t.focus(); l.caret.set(t, 0); l.key({ key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true }, t); }],
    ['飾りを付ける', async (l) => { l.call('block.update', { pageId: 'pa1', blockId: 'p1', patch: { rich: [{ t: '本文', m: ['b'] }, { t: 'の行', m: [] }] } }); }],
    ['Ctrl+Z で戻す', async (l) => { l.key({ key: 'Enter' }, typeIn(l, 'p1', '本文の行', 2)); await l.drain(); press(l, Z); }],
  ];
  for (const [name, act] of acts) {
    const l = await openReal({ pa1: AI }, { returns: { pageSummarize: () => ({ ok: true, stat: { linked: 1, total: 1 } }) } });
    try {
      await act(l);
      await l.drain();
      if (name === 'Ctrl+Z で戻す') {
        assert.strictEqual(revs(l).length, 1);
        assert.deepStrictEqual(l.page().blocks.map((b) => [b.id, b.type, b.text]), AI.map((b) => [b.id, b.type, b.text]), '戻らない（見本の作りの誤り）');
      }
      l.fire('onPageOpen', 'pa1');   // DB の今のページを読み直す
      await l.drain();
      const p = $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === '要約を再生成').onclick();
      await l.drain();
      const dlg = l.document.querySelector('.askbox');
      assert.ok(dlg, `${name}: 確かめが出ない`);
      dlg.querySelectorAll('button')[1].dispatchEvent({ type: 'click' });
      await p;
      assert.strictEqual(l.called('pageSummarize').length, 0, name);
      assert.deepStrictEqual(l.errors.map(fmt), [], name);
    } finally { l.done(); }
  }
});

test('EB-3・F103（決めたこと 11）: 題名・文字起こしの行・メモの欄・設定の窓での Ctrl+Z は editRevert を呼ばず、既定の戻しを止めない。変換中の Ctrl+Z も呼ばない。要約の行では呼ぶ', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    l.key({ key: 'Enter' }, typeIn(l, 'p1', 'あいうえお', 2));
    await l.drain();
    assert.strictEqual(l.steps.length, 1);
    const memo = $(l, 'pMemo').querySelector('textarea');
    const seg = $(l, 'pScript').querySelector('.txt');
    const places = [['題名', $(l, 'pTitle')], ['メモの欄', memo], ['文字起こしの行', seg], ['設定の検索', $(l, 'setSearch')]];
    for (const [name, el] of places) {
      assert.ok(el, `${name} が無い（見本の作りの誤り）`);
      el.focus();
      for (const k of [Z, SZ, Y]) {
        const ev = l.key(k, el);
        await l.drain();
        assert.strictEqual(ev.defaultPrevented, false, `${name}: 欄の中の戻しを止めた`);
      }
      assert.deepStrictEqual(revs(l), [], `${name}: 要約の歩みを戻した`);
    }
    // 変換中（isComposing・keyCode 229）は何もしない（IME の確定や候補の操作）
    const t = txtOf(l, 'p1');
    t.focus();
    for (const o of [{ isComposing: true }, { keyCode: 229 }]) {
      const ev = l.key({ ...Z, ...o }, t);
      await l.drain();
      assert.strictEqual(ev.defaultPrevented, false);
    }
    assert.deepStrictEqual(revs(l), [], '変換中の Ctrl+Z で戻した');
    const ev = l.key(Z, t);
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true, 'Chromium の行の中の戻しと二重に効く');
    assert.strictEqual(revs(l).length, 1);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

const kid = (id, type = 'bullet', o = {}) => ({ id, type, text: `${id}の文`, citeState: 'manual', cites: [], ...o });
const TOG = () => [
  { id: 'h1', type: 'heading', level: 2, text: '決定事項' },
  { id: 'u', type: 'toggle', text: '開いた話', citeState: 'manual', children: [kid('u1')] },
  kid('x'),
  kid('e', 'paragraph', { text: '' }),
];
test('EB-3・G1・P6（第4版）: トグルを開け閉めした後でも、その前に足した・型を変えた歩みが Ctrl+Z の1回で戻る（開け閉めは歩みにならない）。⠿ にフォーカスがあるときの Ctrl+Z も戻す', T, async () => {
  const l = await openReal({ pa1: TOG() });
  try {
    let t = txtOf(l, 'x'); t.focus(); l.caret.set(t, t.textContent.length);
    l.key({ key: 'Enter' }, t);   // 下に行を足す
    await l.drain();
    const added = l.page().blocks.find((b) => !['h1', 'u', 'x', 'e'].includes(b.id));
    assert.ok(added, '行が足されない');
    t = txtOf(l, 'x'); t.focus(); l.caret.set(t, 0);
    l.key({ key: '^', code: 'Digit6', ctrlKey: true, shiftKey: true }, t);   // 番号付きに
    await l.drain();
    assert.strictEqual(l.page().blocks.find((b) => b.id === 'x').type, 'numbered');
    assert.strictEqual(l.steps.length, 2);
    // 開け閉め（歩みにならない）
    rowOf(l, 'u').querySelector('.tog').onclick();
    await l.drain();
    rowOf(l, 'u').querySelector('.tog').onclick();
    await l.drain();
    assert.strictEqual(l.called('blockSetOpen').length, 2);
    assert.strictEqual(l.steps.length, 2, '開け閉めが歩みになった');
    t = txtOf(l, 'x'); t.focus();
    l.key(Z, t);
    await l.drain();
    assert.deepStrictEqual(revs(l), [['pa1', [l.steps[1].step]]]);
    assert.strictEqual(l.page().blocks.find((b) => b.id === 'x').type, 'bullet');
    // ⠿ にフォーカスがあるときも戻す
    const grip = rowOf(l, 'x').querySelector('.grip');
    grip.focus();
    const ev = l.key(Z, grip);
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    assert.deepStrictEqual(revs(l).slice(1), [['pa1', [l.steps[0].step]]]);
    assert.ok(!l.page().blocks.some((b) => b.id === added.id), '足した行が消えない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
