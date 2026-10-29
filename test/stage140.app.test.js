/*
 * stage140.app.test.js — 0.14.0 の画面（計画 docs/plans/2026-10-26-140.md の Task EB-3〜）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。命令は一時の DB（helpers/dbtmp.js）を本当に通す。
 * preload の onEditStep は、この台の命令の口が preload と同じ決まり（戻せる命令が ok で changed のときだけ・答えより先に { cmd, pageId, step: tx }）で起こす。
 * カーソルは simrun の caret の継ぎ目（l.caret）で置く（偽の DOM に getSelection・Range が無い）。
 * EB-4（E6・F101）: 行の飾りを span で描いて { rich } で保存し、Ctrl+B・I・U・Ctrl+Shift+S・Ctrl+E と「**文字**」などの記法で付ける（変換中は決めない）。
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
  // 0.14.0 EB-4: 最後の rich は preload と同じく、無ければ送らない（R58）
  blockSplit: (pageId, blockId, text, at, afterId, inside, rich) => ['block.split', { pageId, blockId, text, at, ...(afterId === undefined ? {} : { afterId }), ...(inside === true ? { inside } : {}), ...(rich === undefined ? {} : { rich }) }],
  blockMerge: (pageId, blockId, text, intoId, rich) => ['block.merge', { pageId, blockId, text, ...(intoId === undefined ? {} : { intoId }), ...(rich === undefined ? {} : { rich }) }],
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
    // EB-3 直し（R109）: contextBridge を越えた Error は message だけが残る（preload の dbError の code・retry は画面に届かない）
    if (!r.ok) throw new Error(r.code);
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
  // EB-3 直し: l.hold(名前) の間、その命令の答えを l.release(名前, 断りの符号?) まで止める（DB へは release で送る）
  const holdOn = new Map();
  for (const [name, f] of Object.entries(CMDS)) {
    if (o.returns && o.returns[name]) continue;
    returns[name] = wrap((...a) => {
      const q = holdOn.get(name);
      if (!q) return call(...f(...a));
      return new Promise((res, rej) => q.push({ run: () => call(...f(...a)), res, rej }));
    });
  }
  const l = await load(APP, { caret: true, returns });
  L = l;
  l.t = t; l.db = db; l.call = call; l.steps = steps;
  l.hold = (name) => { holdOn.set(name, []); };
  l.release = (name, fail) => {
    const q = holdOn.get(name) || [];
    holdOn.delete(name);
    for (const it of q) { if (fail) it.rej(new Error(fail)); else { try { it.res(it.run()); } catch (e) { it.rej(e); } } }
    return q.length;
  };
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

// ---------------------------------------------------------------- EB-4（決めたこと 14・17・18・22・R10・R13。F101）
const r4 = (t, ...m) => ({ t, m });
const LINK = ['link', 'https://example.com/'];
// 行の欄の子の見え方（文字の節は文字、span は印と文字）
const viewOf = (t) => t.childNodes.map((n) => {
  if (n.tagName === '#text') return n.textContent;
  const o = {};
  for (const [k, a] of [['m', 'data-m'], ['color', 'data-color'], ['bg', 'data-bg'], ['link', 'data-link']]) if (n.getAttribute(a) !== null) o[k] = n.getAttribute(a);
  return { tag: n.tagName, ...o, t: n.textContent };
});
const fnApp = (name) => {
  const at = HTML.indexOf(`  function ${name}(`);
  assert.ok(at > 0, `app.html に ${name} が無い`);
  return HTML.slice(at, HTML.indexOf('\n  }\n', at) + 4);
};
const R = require('../src/richText');
const E = require('../src/blockEdit');

test('EB-4: 画面の写し（app.html の richText・keyAction・blocksMarkdown）は src/richText.js・src/blockEdit.js と同じ答え', () => {
  const at = HTML.indexOf('  // ---- richText の写し');
  const end = HTML.indexOf('  // ---- richText の写しはここまで');
  assert.ok(at > 0 && end > at, 'app.html に richText の写しが無い');
  const names = ['normalizeRich', 'plainOf', 'richOf', 'toggleMark', 'insertRich', 'sliceRich', 'marksAt', 'richTree', 'richFromNodes', 'inlineShortcut', 'linkOk', 'richMarkdown'];
  const app = new Function(`${fnApp('graphemeEnds')}\n${fnApp('safeOffset')}\n${HTML.slice(at, end)}\nreturn { ${names.join(', ')} };`)();   // eslint-disable-line no-new-func
  const rs = [[r4('あい'), r4('うえ', 'b'), r4('お')], [r4('𠮷野', 'i', ['color', 'red']), r4('家', 'code')], [r4('資料', LINK), r4(' と '), r4('x', 'u', 's', ['bg', 'yellow'])],
    [r4('a', 'code', LINK), r4('b', ['link', 'javascript:x'])], [], null, [r4('')]];
  for (const r of rs) {
    for (const n of ['normalizeRich', 'plainOf', 'richMarkdown', 'richTree']) assert.deepStrictEqual(app[n](r), R[n](r), `${n} ${JSON.stringify(r)}`);
    assert.deepStrictEqual(app.richOf({ text: 'x', rich: r }), R.richOf({ text: 'x', rich: r }));
    assert.deepStrictEqual(app.richFromNodes(R.richTree(r)), R.richFromNodes(R.richTree(r)));
    for (const [s, e] of [[0, 0], [0, 2], [1, 3], [2, 1], [0, 99]]) {
      for (const mk of ['b', 'i', 'code']) assert.deepStrictEqual(app.toggleMark(r, s, e, mk), R.toggleMark(r, s, e, mk), `toggleMark ${JSON.stringify([r, s, e, mk])}`);
      assert.deepStrictEqual(app.sliceRich(r, s, e), R.sliceRich(r, s, e));
      assert.deepStrictEqual(app.insertRich(r, s, 'ん'), R.insertRich(r, s, 'ん'));
      assert.deepStrictEqual(app.insertRich(r, s, [r4('ん', 'b')]), R.insertRich(r, s, [r4('ん', 'b')]));
      assert.deepStrictEqual(app.marksAt(r, s), R.marksAt(r, s));
    }
  }
  for (const s of ['これは**大事**', '*a*', '`x`', '~y~', '**a', '＊＊a＊＊', '1*2*3', '** a**', 'a~~b~~', '']) assert.deepStrictEqual(app.inlineShortcut(s), R.inlineShortcut(s), s);
  for (const u of ['https://example.com/', 'JavaScript:x', ' https://example.com/', 'natsu://page/p1', 'mailto:someone', 'file:///c', '']) assert.strictEqual(app.linkOk(u), R.linkOk(u), u);
  // 近道の写し（飾りのキーも）
  const ksrc = HTML.slice(HTML.indexOf('  const DIGIT_TURN_VIEW = '), HTML.indexOf('\n', HTML.indexOf('  const DIGIT_TURN_VIEW = ')) + 1)
    + fnApp('keyAction');
  const kapp = new Function(`${ksrc}\nreturn { keyAction };`)();   // eslint-disable-line no-new-func
  for (const code of ['KeyB', 'KeyI', 'KeyU', 'KeyS', 'KeyE', 'KeyK', 'KeyH', 'KeyD', 'KeyZ', 'Digit1', '']) {
    for (const [ctrlKey, shiftKey, altKey] of [[true, false, false], [true, true, false], [false, false, false], [true, false, true]]) {
      for (const isComposing of [false, true]) {
        const ev = { code, key: 'x', ctrlKey, shiftKey, altKey, metaKey: false, isComposing };
        assert.strictEqual(kapp.keyAction(ev), E.keyAction(ev), JSON.stringify(ev));
      }
    }
  }
  // ［コピー］の写し（飾りの行・子・見出し。飾りの無い行は今と同じ）
  const mapp = new Function(`const CALLOUT_ICON = '💡';\n${fnApp('graphemeEnds')}\n${fnApp('safeOffset')}\n${HTML.slice(at, end)}\n${fnApp('headingLevel')}\n${fnApp('numberLabels')}\n${fnApp('blocksMarkdown')}\nreturn { blocksMarkdown };`)();   // eslint-disable-line no-new-func
  const tb = [{ id: 'h', type: 'heading', level: 1, text: '大事', rich: [r4('大事', 'b')] }, { id: 'b', type: 'bullet', text: '資料と', rich: [r4('資料', LINK), r4('と')], children: [
    { id: 'c', type: 'numbered', text: '消し', rich: [r4('消し', 's')] }, { id: 'd', type: 'paragraph', text: '素の文' }] }, { id: 'q', type: 'quote', text: '引用', rich: null }];
  assert.strictEqual(mapp.blocksMarkdown(tb), E.blocksMarkdown(tb));
  assert.ok(E.blocksMarkdown(tb).includes('**大事**') && E.blocksMarkdown(tb).includes('[資料](https://example.com/)'), E.blocksMarkdown(tb));
});

test('EB-4（決めたこと 17）: rich の行は span で描かれ（innerHTML を使わない）、_commit は blockUpdate の { rich } を送る。飾りの無い行は今どおり { text }', T, async () => {
  const RICH = [r4('これは'), r4('大事', 'b'), r4('な'), r4('資料', LINK), r4('と'), r4('赤', ['color', 'red']), r4('黄', ['bg', 'yellow'])];
  const l = await openReal({ pa1: [{ id: 'p1', type: 'paragraph', text: 'これは大事な資料と赤黄', rich: RICH, citeState: 'manual', cites: [] }, { id: 'p2', type: 'paragraph', text: 'あいう' }] });
  try {
    const t = txtOf(l, 'p1');
    assert.deepStrictEqual(viewOf(t), ['これは', { tag: 'span', m: 'b', t: '大事' }, 'な', { tag: 'span', link: 'https://example.com/', t: '資料' }, 'と',
      { tag: 'span', color: 'red', t: '赤' }, { tag: 'span', bg: 'yellow', t: '黄' }]);
    assert.strictEqual(t.textContent, 'これは大事な資料と赤黄');
    for (const n of [t, ...t.childNodes]) assert.strictEqual(n._html, undefined, 'innerHTML で描いた');
    // 太字の終わりで打つ（打った文字は前の文字の飾りを引き継ぐ）→ blur で { rich } の1回
    t.focus();
    t.childNodes[1].appendChild(l.document.createTextNode('な話'));
    l.caret.set(t, 7);
    t.dispatchEvent({ type: 'input' });
    t.onblur();
    await l.drain();
    const want = [r4('これは'), r4('大事な話', 'b'), r4('な'), r4('資料', LINK), r4('と'), r4('赤', ['color', 'red']), r4('黄', ['bg', 'yellow'])];
    assert.deepStrictEqual(updates(l), [['pa1', 'p1', { rich: want }]]);
    const saved = l.page().blocks.find((b) => b.id === 'p1');
    assert.deepStrictEqual([saved.text, saved.rich], ['これは大事な話な資料と赤黄', want]);
    // もう一度 blur しても送らない（直していない）
    t.onblur();
    await l.drain();
    assert.strictEqual(updates(l).length, 1);
    // 飾りの無い行は今どおり { text }
    const t2 = typeIn(l, 'p2', 'あいうえ');
    t2.onblur();
    await l.drain();
    assert.deepStrictEqual(updates(l).slice(1), [['pa1', 'p2', { text: 'あいうえ' }]]);
    assert.strictEqual(l.page().blocks.find((b) => b.id === 'p2').rich, undefined);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-4・F101: 文字を選んで Ctrl+B → ev.defaultPrevented・行が太字・選んだ所は残り、次の区切りで1回保存。Ctrl+I・U・Ctrl+Shift+S・Ctrl+E も（key でなく code で見る: JIS）。全部太字なら外す', T, async () => {
  const l = await openReal({ pa1: [{ id: 'p1', type: 'paragraph', text: 'あいうえお' }] });
  try {
    const t = typeIn(l, 'p1', 'あいうえお', 1, 3);
    const ev = l.key({ key: 'b', code: 'KeyB', ctrlKey: true }, t);
    assert.strictEqual(ev.defaultPrevented, true, 'Chromium の既定の太字を止めない');
    assert.deepStrictEqual(viewOf(t), ['あ', { tag: 'span', m: 'b', t: 'いう' }, 'えお']);
    assert.deepStrictEqual(l.caret.get(t), [1, 3], '選んだ所が残らない');
    await l.drain();
    assert.deepStrictEqual(updates(l), [], 'Ctrl+B ですぐ保存した');
    for (const o of [{ key: '', code: 'KeyI', ctrlKey: true }, { key: 'な', code: 'KeyU', ctrlKey: true }, { key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true }, { key: 'い', code: 'KeyE', ctrlKey: true }]) {
      l.caret.set(t, 3, 5);
      assert.strictEqual(l.key(o, t).defaultPrevented, true, JSON.stringify(o));
    }
    assert.deepStrictEqual(viewOf(t), ['あ', { tag: 'span', m: 'b', t: 'いう' }, { tag: 'span', m: 'i u s code', t: 'えお' }]);
    // 全部太字の所でもう一度 Ctrl+B → 外す
    l.caret.set(t, 1, 3);
    l.key({ key: 'b', code: 'KeyB', ctrlKey: true }, t);
    assert.deepStrictEqual(viewOf(t), ['あいう', { tag: 'span', m: 'i u s code', t: 'えお' }]);
    assert.strictEqual(t.textContent, 'あいうえお');
    // 選んでいなければ何もしない（既定の太字は止める）
    l.caret.set(t, 2);
    assert.strictEqual(l.key({ key: 'b', code: 'KeyB', ctrlKey: true }, t).defaultPrevented, true);
    assert.deepStrictEqual(viewOf(t), ['あいう', { tag: 'span', m: 'i u s code', t: 'えお' }]);
    // 次の区切り（手が 2 秒止まる）で1回だけ保存
    await l.clock.advance(1999);
    await l.drain();
    assert.deepStrictEqual(updates(l), []);
    await l.clock.advance(1);
    await l.drain();
    assert.deepStrictEqual(updates(l), [['pa1', 'p1', { rich: [r4('あいう'), r4('えお', 'i', 'u', 's', 'code')] }]]);
    t.onblur();
    await l.drain();
    assert.strictEqual(updates(l).length, 1, '同じ飾りをもう一度送った');
    assert.strictEqual(l.steps.length, 1, '保存の1回が1歩');
    assert.deepStrictEqual(l.page().blocks[0].rich, [r4('あいう'), r4('えお', 'i', 'u', 's', 'code')]);
    // 変換中の Ctrl+B は何もしない
    l.caret.set(t, 0, 2);
    assert.strictEqual(l.key({ key: 'b', code: 'KeyB', ctrlKey: true, isComposing: true }, t).defaultPrevented, false);
    assert.deepStrictEqual(viewOf(t), ['あいう', { tag: 'span', m: 'i u s code', t: 'えお' }]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-4（決めたこと 18・R10・決めたこと 10）: 「**大事**」と打つと太字になり記号が消える。変換中（compositionstart の後）は決めず、compositionend の後に決める。変えた直後の Ctrl+Z は記号を戻す', T, async () => {
  const l = await openReal({ pa1: [{ id: 'p1', type: 'paragraph', text: 'これは' }, { id: 'p2', type: 'paragraph', text: '' }] });
  try {
    const t = txtOf(l, 'p1');
    t.focus();
    t.dispatchEvent({ type: 'compositionstart' });
    t.textContent = 'これは**大事**';
    l.caret.set(t, 9);
    t.dispatchEvent({ type: 'input', isComposing: true });
    assert.deepStrictEqual(viewOf(t), ['これは**大事**'], '変換中に記法を決めた');
    t.dispatchEvent({ type: 'compositionend' });
    assert.deepStrictEqual(viewOf(t), ['これは', { tag: 'span', m: 'b', t: '大事' }]);
    assert.deepStrictEqual(l.caret.get(t), [5, 5], 'カーソルが太字の終わりに無い');
    // 変えた直後の Ctrl+Z → 記号を戻す（DB に送らない）
    l.key(Z, t);
    await l.drain();
    assert.deepStrictEqual(viewOf(t), ['これは**大事**']);
    assert.deepStrictEqual(revs(l), []);
    assert.deepStrictEqual(updates(l), []);
    // 変換しないでふつうに打つ（input）でも変わる。閉じていない・全角・語の途中は変えない
    const t2 = txtOf(l, 'p2');
    t2.focus();
    for (const s of ['**a', '＊＊大事＊＊', '1*2*3', 'a~~b~~']) {
      t2.textContent = s; l.caret.set(t2, s.length);
      t2.dispatchEvent({ type: 'input' });
      assert.deepStrictEqual(viewOf(t2), [s], s);
    }
    t2.textContent = 'x `コード`'; l.caret.set(t2, 7);
    t2.dispatchEvent({ type: 'input' });
    assert.deepStrictEqual(viewOf(t2), ['x ', { tag: 'span', m: 'code', t: 'コード' }]);
    t2.onblur();
    await l.drain();
    assert.deepStrictEqual(updates(l), [['pa1', 'p2', { rich: [r4('x '), r4('コード', 'code')] }]]);
    // 打った文字はコードの終わりでは引き継がない（変換の文字が飾りの外に出ても、前の文字の飾りの決まりで決める: F101）
    t2.focus();
    t2.childNodes[1].appendChild(l.document.createTextNode('です'));
    l.caret.set(t2, 7);
    t2.dispatchEvent({ type: 'compositionend' });
    assert.deepStrictEqual(viewOf(t2), ['x ', { tag: 'span', m: 'code', t: 'コード' }, 'です']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-4・F101: 太字の行を Enter で分ける・Backspace でつなぐ → blockSplit・blockMerge に rich（飾りの境はずれない）。Shift+Enter の改行も飾りを保つ', T, async () => {
  const l = await openReal({ pa1: [{ id: 'p0', type: 'paragraph', text: '前の' }, { id: 'p1', type: 'paragraph', text: '大事な話', rich: [r4('大事', 'b'), r4('な話')], citeState: 'manual', cites: [] }] });
  try {
    let t = txtOf(l, 'p1');
    t.focus(); l.caret.set(t, 1);
    l.key({ key: 'Enter' }, t);
    await l.drain();
    const sp = l.called('blockSplit').map((c) => c.args);
    assert.strictEqual(sp.length, 1);
    assert.deepStrictEqual(sp[0][6], [r4('大事', 'b'), r4('な話')], 'blockSplit に rich が無い');
    const bs = l.page().blocks;
    assert.deepStrictEqual(bs.map((b) => [b.text, b.rich]), [['前の', undefined], ['大', [r4('大', 'b')]], ['事な話', [r4('事', 'b'), r4('な話')]]]);
    // 分けた後ろの行の頭で Backspace → 前の行（p0）とつなぐ（rich を送る）
    const tail = bs[2].id;
    t = txtOf(l, 'p1'); t.focus(); l.caret.set(t, 0);
    l.key({ key: 'Backspace' }, t);
    await l.drain();
    const mg = l.called('blockMerge').map((c) => c.args);
    assert.deepStrictEqual(mg, [['pa1', 'p1', '大', 'p0', [r4('大', 'b')]]]);
    assert.deepStrictEqual(l.page().blocks.map((b) => [b.text, b.rich]), [['前の大', [r4('前の'), r4('大', 'b')]], ['事な話', [r4('事', 'b'), r4('な話')]]]);
    // Shift+Enter の改行（行の中）も飾りを保つ
    t = txtOf(l, tail); t.focus(); l.caret.set(t, 1);
    l.key({ key: 'Enter', shiftKey: true }, t);
    assert.deepStrictEqual(viewOf(t), [{ tag: 'span', m: 'b', t: '事\n' }, 'な話']);
    // 飾りの無い行の Enter は今の引数のまま（rich を送らない）
    const t0 = txtOf(l, 'p0'); t0.focus();
    assert.strictEqual(l.called('blockSplit').length, 1);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-4（決めたこと 22・R13）: ［コピー］に「**」「[文字](住所)」が出る。飾りの無い要約は今と1文字も同じ（0.13.1 の型と子の字下げ・見出しは下げない）', T, async () => {
  const M2 = require('../src/memoTypes');
  const plain = [{ id: 'h1', type: 'heading', level: 2, text: '決定事項' }, { id: 'b1', type: 'bullet', text: '来週に出す', cites: ['s2'], citeState: 'linked', children: [
    { id: 'h3', type: 'heading', level: 3, text: '中の見出し', citeState: 'manual', cites: [] }, { id: 'n1', type: 'numbered', text: '一つ目', citeState: 'manual', cites: [] }] },
  { id: 't1', type: 'todo', text: '見積もりを取る', checked: false, cites: [], citeState: 'manual' }, { id: 'g1', type: 'toggle', text: '話', citeState: 'manual', cites: [] }];
  const rich = [{ id: 'h1', type: 'heading', level: 2, text: '決定事項' }, { id: 'b1', type: 'bullet', text: '大事な資料を見る', rich: [r4('大事', 'b'), r4('な'), r4('資料', LINK), r4('を見る')], cites: [], citeState: 'manual' }];
  for (const [blocks, check] of [[plain, null], [rich, '## 決定事項\n- **大事**な[資料](https://example.com/)を見る']]) {
    const l = await openReal({ pa1: blocks });
    try {
      const btn = $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === 'コピー');
      await btn.onclick();
      await l.drain();
      const got = l.called('copy').map((c) => c.args[0]);
      const page = l.page();
      assert.deepStrictEqual(got, [E.blocksMarkdown(M2.orderForView(page.blocks).map((i) => page.blocks[i])).trim()]);
      if (check) assert.strictEqual(got[0], check);
      else assert.strictEqual(got[0], '## 決定事項\n- 来週に出す\n\n### 中の見出し\n1. 一つ目\n- [ ] 見積もりを取る\n- 話');
      assert.deepStrictEqual(l.errors.map(fmt), []);
    } finally { l.done(); }
  }
});

test('EB-4（決めたこと 14・21）: 飾りの9色は明暗の両方にあり、文字の色は地・ホバー・薄い強調の上で、背景の色の上の文字（--text・--accent-text）も 4.5:1 以上。CSS は span の印だけで色を付ける', () => {
  const { parseHTML } = require('./helpers/simdom');
  const S = require('./helpers/simcss');
  const C = require('./helpers/css');
  const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
  const light = S.tokens(rules, '');
  const dark = { ...light, ...S.tokens(rules, '@media (prefers-color-scheme: dark)') };
  const darkOwn = S.tokens(rules, '@media (prefers-color-scheme: dark)');
  for (const n of R.COLORS) {
    for (const k of [`--mk-${n}`, `--mkbg-${n}`]) assert.ok(light[k] && darkOwn[k], `${k} が明暗の両方に無い`);
    const sel = (a) => rules.find((r) => r.sel === `.blk .txt span[${a}="${n}"]` && !r.at);
    assert.strictEqual(sel('data-color').decls.color.trim(), `var(--mk-${n})`);
    assert.strictEqual(sel('data-bg').decls.background.trim(), `var(--mkbg-${n})`);
  }
  for (const [name, t] of [['明', light], ['暗', dark]]) {
    const bg = C.color(t['--bg']);
    const grounds = [{ g: bg, why: '地' }, { g: C.over(C.color(t['--hover']), bg), why: 'ホバー' }, { g: C.over(C.color(t['--tint']), bg), why: '薄い強調' }];
    for (const n of R.COLORS) {
      for (const { g, why } of grounds) {
        const c = C.contrast(C.color(t[`--mk-${n}`]), g);
        assert.ok(c >= 4.5, `${name}: --mk-${n}（${t[`--mk-${n}`]}）が${why}の上で ${c.toFixed(2)}`);
      }
      const ground = C.over(C.color(t[`--mkbg-${n}`]), bg);
      for (const k of ['--text', '--accent-text']) {
        const c = C.contrast(C.color(t[k]), ground);
        assert.ok(c >= 4.5, `${name}: ${k} が --mkbg-${n}（${t[`--mkbg-${n}`]}）の上で ${c.toFixed(2)}`);
      }
    }
  }
});

// ---------------------------------------------------------------- EB-3 直し（2026-10-29 の点検。R109）
test('EB-3 直し・I1（決めたこと 2・R98）: 空の行の「/区切り線」（型の変換と下の行）は Ctrl+Z の1回で両方戻る', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'e1', '/くぎり');
    t.dispatchEvent({ type: 'input' });
    await l.drain();
    l.key({ key: 'Enter' }, t);
    await l.drain();
    assert.deepStrictEqual(l.steps.map((x) => x.cmd), ['block.turnInto', 'block.insert']);
    assert.strictEqual(l.page().blocks.find((b) => b.id === 'e1').type, 'divider');
    press(l, Z);
    await l.drain();
    assert.deepStrictEqual(revs(l), [['pa1', l.steps.slice(0, 2).map((x) => x.step)]], '2回の Ctrl+Z が要る');
    assert.deepStrictEqual(l.page().blocks.map((b) => [b.id, b.type]), BASE().map((b) => [b.id, b.type]));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3 直し・I2・M2(a): Enter のすぐ後の Ctrl+Z（分割の答えを待っている間）は、答えが来てから分割を戻す。戻している間は打たせない（beforeinput を止める）', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const before = l.page().blocks.map((b) => [b.id, b.text]);
    l.hold('blockSplit');
    l.key({ key: 'Enter' }, typeIn(l, 'p1', 'あいうえお', 2));
    await l.drain();
    press(l, Z);
    await l.drain();
    assert.deepStrictEqual(revs(l), [], '分割の歩みが届く前に列を取った');
    assert.strictEqual(toastOf(l).includes('これ以上は戻せません'), false);
    l.hold('editRevert');
    assert.strictEqual(l.release('blockSplit'), 1);
    await l.drain();
    assert.deepStrictEqual(revs(l), [['pa1', [l.steps[0].step]]]);
    // 戻している間（edit.revert の答えを待つ間）は打たせない
    const t = txtOf(l, 'p1');
    const ev = { type: 'beforeinput', cancelable: true, prevented: false, preventDefault() { this.prevented = true; } };
    for (const fn of t._listeners.beforeinput) fn.call(t, ev);
    assert.strictEqual(ev.prevented, true, '戻している間に打てる');
    l.release('editRevert');
    await l.drain();
    assert.deepStrictEqual(l.page().blocks.map((b) => [b.id, b.text]), before, '分割が戻らない');
    const ev2 = { type: 'beforeinput', cancelable: true, prevented: false, preventDefault() { this.prevented = true; } };
    for (const fn of txtOf(l, 'p1')._listeners.beforeinput) fn.call(txtOf(l, 'p1'), ev2);
    assert.strictEqual(ev2.prevented, false, '戻した後も打てない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3 直し・M2(b)・M3: 続けて押した Ctrl+Z は押した順に1つずつ（新しい歩みから）。待っている間にページを替えたら、前のページで押した Ctrl+Z はほかのページを戻さない', T, async () => {
  const l = await openReal({ pa1: BASE(), pb1: BASE('b') }, { open: 'pb1' });
  try {
    const turn = (id, d) => { const t = txtOf(l, id); t.focus(); l.caret.set(t, 0); l.key({ key: '', code: `Digit${d}`, ctrlKey: true, shiftKey: true }, t); };
    turn('p1b', 5);
    await l.drain();
    l.fire('onPageOpen', 'pa1');
    await l.drain();
    turn('p1', 5);
    await l.drain();
    turn('p1', 4);
    await l.drain();
    assert.strictEqual(l.steps.length, 3);
    // 続けて2回（間に何も進めない）→ 新しい歩みから順に
    press(l, Z); press(l, Z);
    await l.drain(80);
    assert.deepStrictEqual(revs(l), [['pa1', [l.steps[2].step]], ['pa1', [l.steps[1].step]]]);
    assert.strictEqual(l.page('pa1').blocks.find((b) => b.id === 'p1').type, 'paragraph');
    // やり直しと戻すを続けて。1回目の答えを待っている間にページを替える → 2回目は捨てる（pb1 の歩みを戻さない）
    l.hold('editRevert');
    press(l, Y); press(l, Z);
    await l.drain();
    l.fire('onPageOpen', 'pb1');
    await l.drain();
    l.release('editRevert');
    await l.drain(80);
    assert.strictEqual(revs(l).length, 3, '前のページで押した Ctrl+Z が今のページで動いた');
    assert.strictEqual(l.page('pb1').blocks.find((b) => b.id === 'p1b').type, 'bullet', 'ほかのページを戻した');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3 直し・M2(c)・M3: locked で断られた歩みは知らせずに取った所へ戻す（待つ間に積まれた歩みの下へ）', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = txtOf(l, 'p1'); t.focus(); l.caret.set(t, 0);
    l.key({ key: '', code: 'Digit5', ctrlKey: true, shiftKey: true }, t);   // 歩み A
    await l.drain();
    l.hold('editRevert');
    press(l, Z);
    await l.drain();
    assert.strictEqual(revs(l).length, 1);
    const cb = rowOf(l, 't1').querySelector('input');   // 待つ間に歩み B（ToDo のチェック）
    cb.checked = true; cb.onchange();
    await l.drain();
    assert.strictEqual(l.steps.length, 2);
    l.release('editRevert', 'locked');
    await l.drain();
    assert.ok(!/保存できませんでした|戻せませんでした/.test(toastOf(l)), `locked で知らせた: ${toastOf(l)}`);
    press(l, Z);
    await l.drain();
    press(l, Z);
    await l.drain();
    assert.deepStrictEqual(revs(l).slice(1), [['pa1', [l.steps[1].step]], ['pa1', [l.steps[0].step]]], '断られた歩みが消えた・順が違う');
    const p = l.page();
    assert.deepStrictEqual([p.blocks.find((b) => b.id === 'p1').type, p.blocks.find((b) => b.id === 't1').checked], ['paragraph', false]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3 直し・M3（R98・P3・R99）: 打った文の後の複製（Ctrl+D）・⠿ の複製・ドラッグは1歩。Enter の後の blur は歩みを増やさない。フォーカスの行が消えたら上の行の終わりへ', T, async () => {
  for (const [name, act] of [['Ctrl+D', (l, t) => l.key({ key: 'd', code: 'KeyD', ctrlKey: true }, t)], ['⠿ の複製', (l) => menuPick(l, 'p1', '複製')], ['ドラッグ', (l) => dragTo(l, 'p1', 45)]]) {
    const l = await openReal({ pa1: BASE() });
    try {
      const before = l.page().blocks.map((b) => [b.id, b.text]);
      const t = typeIn(l, 'p1', 'あいうえおか');
      await act(l, t);
      await l.drain();
      assert.strictEqual(l.steps.length, 2, `${name}: 打った文の保存と命令が無い`);
      const two = l.steps.map((x) => x.step);
      press(l, Z);
      await l.drain();
      assert.deepStrictEqual(revs(l), [['pa1', two]], `${name}: 1歩でない`);
      assert.deepStrictEqual(l.page().blocks.map((b) => [b.id, b.text]), before, name);
      assert.deepStrictEqual(l.errors.map(fmt), [], name);
    } finally { l.done(); }
  }
  const l = await openReal({ pa1: BASE() });
  try {
    const t = typeIn(l, 'p1', 'あいうえお', 5);
    l.key({ key: 'Enter' }, t);
    await l.drain();
    t.onblur();   // 偽の DOM は blur を起こさないので、ここで起こす（P3）
    await l.drain();
    assert.strictEqual(l.steps.length, 1, 'Enter の後の blur が歩みを足した');
    assert.deepStrictEqual(updates(l), []);
    // 足した行（フォーカスがある）を戻す → フォーカスは上の行の終わり
    const added = l.page().blocks.find((b) => !BASE().some((x) => x.id === b.id));
    assert.strictEqual(l.document.activeElement, txtOf(l, added.id));
    press(l, Z);
    await l.drain();
    assert.strictEqual(l.document.activeElement, txtOf(l, 'p1'), '消えた行のフォーカスが上の行へ行かない');
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'p1')), [5, 5]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-3 直し・M5: blur と手が 2 秒止まったときの保存が断られたら「変更を保存できませんでした」と知らせる（受け手の無い断りを残さない）', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    l.hold('blockUpdate');
    const t = typeIn(l, 'p1', 'あいうえおか');
    t.onblur();
    await l.drain();
    l.release('blockUpdate', 'internal');
    await l.drain(60);
    assert.strictEqual(toastOf(l), '変更を保存できませんでした: internal');
    $(l, 'toast').textContent = '';
    l.hold('blockUpdate');
    typeIn(l, 'p1', 'あいうえおかき');
    txtOf(l, 'p1').dispatchEvent({ type: 'input' });
    await l.clock.advance(2000);
    await l.drain();
    assert.strictEqual(l.release('blockUpdate', 'retry'), 1, '2 秒で保存しない');
    await l.drain(60);
    assert.strictEqual(toastOf(l), '変更を保存できませんでした: retry');
    assert.deepStrictEqual(l.errors.map(fmt), [], '受け手の無い断りが残った');
  } finally { l.done(); }
});
