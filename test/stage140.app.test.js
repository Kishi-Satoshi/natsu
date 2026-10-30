/*
 * stage140.app.test.js — 0.14.0 の画面（計画 docs/plans/2026-10-26-140.md の Task EB-3〜）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。命令は一時の DB（helpers/dbtmp.js）を本当に通す。
 * preload の onEditStep は、この台の命令の口が preload と同じ決まり（戻せる命令が ok で changed のときだけ・答えより先に { cmd, pageId, step: tx }）で起こす。
 * カーソルは simrun の caret の継ぎ目（l.caret）で置く（偽の DOM に getSelection・Range が無い）。
 * EK-4（E9）: 要約の行を Esc・Shift+↑↓・Shift+クリック・Alt+Shift+クリック・余白から引っ張って選び、まとめて消す・動かす・複製する・型を変える・色を付ける・写す・貼る
 *       （どれも1つの命令＝1歩。選んでいる間は打っても何もしない・保存した議事録を前に出さない。Esc の順は R64）。
 * EK-3（E8・F102）: 要約の行に貼ると行と飾りに変える（blockPaste の1回・1歩）。1行の型の無い文は行の中に飾りつきで入れる。Ctrl+Shift+V は素の文字だけ・
 *       選んだ文字に URL を貼るとリンク・大きすぎる貼り付けは知らせだけ・変換中は変換しない。画面の pasteConvert の写しは src/pasteConvert.js と字も答えも同じ。
 * EB-5（E6・SEC2）: 文字を選ぶと出る道具の帯（飾り・リンク・色）・Ctrl+K のリンクの欄（開けるのは決まった頭だけ・Ctrl+クリックで開く）・行の色（⠿・Ctrl+/・/ の色）。
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
  blocksSetColor: (pageId, ids, color) => ['blocks.setColor', { pageId, ids, color }],   // 0.14.0 EB-5: 行の色
  // 0.14.0 EK-3: 貼り付け（preload と同じく、afterId・inside は無ければ送らない）
  blockPaste: (pageId, blockId, rich, at, blocks, afterId, inside) => ['block.paste', { pageId, blockId, rich, at, blocks, ...(afterId === undefined ? {} : { afterId }), ...(inside === true ? { inside } : {}) }],
  // 0.14.0 EK-4: 選んだ行の命令（preload と同じく、無い引数は送らない）
  blocksRemove: (pageId, ids) => ['blocks.remove', { pageId, ids }],
  blocksMove: (pageId, ids, afterId, parentId) => ['blocks.move', { pageId, ids, afterId, ...(parentId === undefined ? {} : { parentId }) }],
  blocksDuplicate: (pageId, ids, afterId, parentId) => ['blocks.duplicate', { pageId, ids, ...(afterId === undefined ? {} : { afterId }), ...(parentId === undefined ? {} : { parentId }) }],
  blocksTurnInto: (pageId, ids, type, level, toggle) => ['blocks.turnInto', { pageId, ids, type, ...(level === undefined ? {} : { level }), ...(toggle === true ? { toggle } : {}) }],
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
    [r4('a', 'code', LINK), r4('b', ['link', 'javascript:x'])], [], null, [r4('')],
    // EB-4 直し（M2・R114）: 隣の区切りの同じ飾り・記号の逃がし・コードの ` の囲み
    [r4('ab', 'b'), r4('cd', 'b', 'i')], [r4('a]b*', LINK), r4('_x_', 'b')], [r4('a`b', 'code'), r4(' 2*3 ')], [r4('`x', 'code'), r4('~y~', 's')],
    // EB-5 直し（R117）: 下線だけ・色だけの行は記号を逃がさない
    [r4('a*b_[c]', 'u')], [r4('~x~', ['color', 'red']), r4('\\`')], [r4('a*b', 'u'), r4('x', 'i')]];
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
    // EB-4 直し（R113）: 重なった地も計る（フォーカスした行のホバーの上のホバー・コールアウトの薄い強調の上のホバー・行の色の背景の上の文字の色）
    const hover = C.color(t['--hover']); const tint = C.color(t['--tint']);
    const grounds = [{ g: bg, why: '地' }, { g: C.over(hover, bg), why: 'ホバー' }, { g: C.over(tint, bg), why: '薄い強調' },
      { g: C.over(tint, C.over(hover, bg)), why: 'ホバーの上の薄い強調' }, { g: C.over(hover, C.over(hover, bg)), why: 'ホバーの上のホバー' },
      ...R.COLORS.map((m) => ({ g: C.over(C.color(t[`--mkbg-${m}`]), bg), why: `--mkbg-${m}` }))];
    for (const n of R.COLORS) {
      for (const { g, why } of grounds) {
        const c = C.contrast(C.color(t[`--mk-${n}`]), g);
        assert.ok(c >= 4.5, `${name}: --mk-${n}（${t[`--mk-${n}`]}）が${why}の上で ${c.toFixed(2)}`);
      }
      const ground = C.over(C.color(t[`--mkbg-${n}`]), bg);
      // 背景の色の上の文字（ふつうの文字・リンク・済んだ ToDo の灰色の文字）
      for (const k of ['--text', '--accent-text', '--muted']) {
        const c = C.contrast(C.color(t[k]), ground);
        assert.ok(c >= 4.5, `${name}: ${k} が --mkbg-${n}（${t[`--mkbg-${n}`]}）の上で ${c.toFixed(2)}`);
      }
    }
  }
  // 行の背景の色の行は、文の欄のホバーとフォーカスの地を重ねない（背景の色の上にホバーを重ねるとリンクと灰色の文字が 4.5:1 を割る: R113）
  for (const sel of ['.blk[data-bbg] > .txt:hover', '.blk[data-bbg] > .txt:focus']) {
    const r = rules.find((x) => x.sel.split(',').map((y) => y.trim()).includes(sel) && !x.at);
    assert.ok(r && r.decls.background.trim() === 'transparent', `${sel} が背景の色の上にホバーを重ねる`);
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

// ---------------------------------------------------------------- EB-5（決めたこと 19〜21・33・44・R11・R12・R37・R64。E6・SEC2）
const barOf = (l) => $(l, 'pNote').querySelector('#markBar');
const popOf = (l) => $(l, 'pNote').querySelector('#linkPop');
const cmenuOf = (l) => $(l, 'pNote').querySelector('#colorMenu');
const BAR_TITLES = ['太字（Ctrl+B）', '斜体（Ctrl+I）', '下線（Ctrl+U）', '取り消し線（Ctrl+Shift+S）', 'コード（Ctrl+E）', 'リンク（Ctrl+K）', '色'];
const COLOR_NAMES = ['既定', '灰', '茶', '橙', '黄', '緑', '青', '紫', '桃', '赤'];
const barBtn = (l, title) => {
  const b = barOf(l).querySelectorAll('button').find((x) => x.title === title);
  assert.ok(b, `帯に ${title} が無い`);
  return b;
};
// 帯・色の項目を押す（本物は mousedown → click）。mousedown の既定を止めたか（フォーカスと選んだ所を行に残すか）を返す
function pushBtn(b) {
  let stopped = false;
  b.dispatchEvent({ type: 'mousedown', preventDefault: () => { stopped = true; } });
  b.dispatchEvent({ type: 'click' });
  return stopped;
}
// 行の文字を選ぶ（本物はマウスを離した時・キーを離した時・selectionchange で帯を出す）
function selectIn(l, id, s, e) {
  const t = txtOf(l, id);
  t.focus();
  l.caret.set(t, s, e);
  t.dispatchEvent({ type: 'mouseup' });
  return t;
}
const colorItem = (l, key) => {
  const b = cmenuOf(l).querySelectorAll('button').find((x) => x.dataset.key === key);
  assert.ok(b, `色のメニューに ${key} が無い`);
  return b;
};

test('EB-5（決めたこと 19・R64）: 行の文字を選ぶと #markBar（role="toolbar"）が出て、押してもフォーカスと選んだ所は行に残る。選びを外す・行から出ると消える。AI の項目は無い', T, async () => {
  const l = await openReal({ pa1: [{ id: 'p1', type: 'paragraph', text: 'あいうえお' }, { id: 'p2', type: 'paragraph', text: 'かきく' }] });
  try {
    // カーソルだけ（選んでいない）では出ない
    let t = selectIn(l, 'p1', 2, 2);
    assert.strictEqual(barOf(l), null, '選んでいないのに帯が出た');
    t = selectIn(l, 'p1', 1, 3);
    const bar = barOf(l);
    assert.ok(bar, '文字を選んでも帯が出ない');
    assert.strictEqual(bar.getAttribute('role'), 'toolbar');
    assert.strictEqual(bar.getAttribute('aria-label'), '文字の飾り');
    const btns = bar.querySelectorAll('button');
    assert.deepStrictEqual(btns.map((b) => b.title), BAR_TITLES);
    assert.deepStrictEqual(btns.map((b) => b.getAttribute('aria-keyshortcuts')), ['Control+B', 'Control+I', 'Control+U', 'Control+Shift+S', 'Control+E', 'Control+K', null]);
    assert.ok(!btns.some((b) => /AI|整え/.test(b.textContent + b.title)), '帯に AI の項目がある（BQ4 (a)）');
    // 押す: mousedown の既定を止め（フォーカスと選んだ所は行に残る）、選んだ所が太字になり、帯は残る
    assert.strictEqual(pushBtn(barBtn(l, '太字（Ctrl+B）')), true, '帯を押すとフォーカスが行から外れる');
    assert.strictEqual(l.document.activeElement, t);
    assert.deepStrictEqual(l.caret.get(t), [1, 3]);
    assert.deepStrictEqual(viewOf(t), ['あ', { tag: 'span', m: 'b', t: 'いう' }, 'えお']);
    assert.ok(barOf(l), '押した後に帯が消えた');
    pushBtn(barBtn(l, 'コード（Ctrl+E）'));
    assert.deepStrictEqual(viewOf(t), ['あ', { tag: 'span', m: 'b code', t: 'いう' }, 'えお']);
    // 保存は次の区切り（手が 2 秒止まる）で1回
    await l.drain();
    assert.deepStrictEqual(updates(l), []);
    await l.clock.advance(2000);
    await l.drain();
    assert.deepStrictEqual(updates(l), [['pa1', 'p1', { rich: [r4('あ'), r4('いう', 'b', 'code'), r4('えお')] }]]);
    // 選びを外す（カーソルだけにする）と消える
    l.caret.set(t, 2);
    t.dispatchEvent({ type: 'keyup', key: 'ArrowLeft' });
    assert.strictEqual(barOf(l), null, '選びを外しても帯が残る');
    // もう一度選ぶと出て、Esc は帯だけを閉じる（R64。行の ⠿ へは行かない）。もう一度 Esc でその行を選ぶ（EK-4 で意図して直した: 前は ⠿ へ。R64 (5)）
    t = selectIn(l, 'p1', 0, 2);
    assert.ok(barOf(l));
    const esc = l.key({ key: 'Escape' }, t);
    assert.strictEqual(esc.defaultPrevented, true);
    assert.strictEqual(barOf(l), null, 'Esc で帯が閉じない');
    assert.strictEqual(l.document.activeElement, t, 'Esc で帯と一緒に行から出た');
    t.dispatchEvent({ type: 'keyup', key: 'Escape' });
    assert.strictEqual(barOf(l), null, '閉じた帯が同じ選びでまた出た');
    l.key({ key: 'Escape' }, t);
    assert.strictEqual(rowOf(l, 'p1').getAttribute('aria-selected'), 'true', '帯を閉じた後の Esc で行を選ばない');
    l.key({ key: 'Escape' }, $(l, 'pNote'));   // 選びを外して ⠿ へ（R64 (4)）
    assert.ok(l.document.activeElement === rowOf(l, 'p1').querySelector('.grip'));
    // 行から出ると消える
    t = selectIn(l, 'p1', 0, 2);
    assert.ok(barOf(l));
    txtOf(l, 'p2').focus();
    t.onblur();
    assert.strictEqual(barOf(l), null, '行から出ても帯が残る');
    // 文字起こしの行・区切り線では出ない（行をまたいだ選びは R22: EK-4）
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-5（決めたこと 20・R12・K-25・SEC2）: Ctrl+K → #linkPop。https://example.invalid/ で Enter → rich に link。javascript:alert(1) → 断りの文・rich は変わらない。選んだ所に URL を貼るとリンク', T, async () => {
  const l = await openReal({ pa1: [{ id: 'p1', type: 'paragraph', text: 'あいうえお' }], pb2: [{ id: 'q1', type: 'paragraph', text: 'べつ' }] });
  try {
    // 選んでいないときの Ctrl+K は何もしない（既定の動きは止める: R12・R104）
    let t = selectIn(l, 'p1', 2, 2);
    assert.strictEqual(l.key({ key: 'k', code: 'KeyK', ctrlKey: true }, t).defaultPrevented, true);
    assert.strictEqual(popOf(l), null, '選んでいないのにリンクの欄が出た');
    // 変換中の Ctrl+K も何もしない
    t = selectIn(l, 'p1', 0, 2);
    assert.strictEqual(l.key({ key: 'k', code: 'KeyK', ctrlKey: true, isComposing: true }, t).defaultPrevented, false);
    assert.strictEqual(popOf(l), null);
    assert.strictEqual(l.key({ key: 'k', code: 'KeyK', ctrlKey: true }, t).defaultPrevented, true);
    const pop = popOf(l);
    assert.ok(pop, 'Ctrl+K でリンクの欄が出ない');
    const inp = pop.querySelector('input');
    assert.strictEqual(inp.getAttribute('placeholder'), 'https://… を貼る');
    assert.strictEqual(l.document.activeElement, inp, 'リンクの欄にフォーカスが無い');
    assert.deepStrictEqual(pop.querySelectorAll('button').map((b) => b.textContent), ['リンクを付ける', '外す']);
    // 書いている途中（EQ22 (a)・決めたこと 44）: リンクの欄に打っている間は、保存した議事録を前に出さない
    l.fire('onPageOpen', 'pb2', { saved: true });
    await l.drain();
    assert.ok(rowOf(l, 'p1'), 'リンクの欄に打っている間に保存した議事録が前に出た');
    // 開けない頭 → 断りの文・欄は開いたまま・rich は変わらない
    inp.value = 'javascript:alert(1)';
    l.key({ key: 'Enter' }, inp);
    assert.strictEqual(pop.querySelector('.lmsg').textContent, '開けるのは https・http・mailto と NaTsu のリンクだけです');
    assert.ok(popOf(l));
    assert.deepStrictEqual(viewOf(t), ['あいうえお']);
    // 変換確定の Enter は決めない（IME）
    inp.value = 'https://example.invalid/';
    l.key({ key: 'Enter', isComposing: true }, inp);
    assert.ok(popOf(l), '変換確定の Enter でリンクを付けた');
    l.key({ key: 'Enter' }, inp);
    assert.strictEqual(popOf(l), null, 'Enter で欄が閉じない');
    assert.deepStrictEqual(viewOf(t), [{ tag: 'span', link: 'https://example.invalid/', t: 'あい' }, 'うえお']);
    assert.strictEqual(t.childNodes[0].getAttribute('title'), 'Ctrl+クリックで開く: https://example.invalid/');
    assert.strictEqual(l.document.activeElement, t, 'リンクを付けた後にフォーカスが行に戻らない');
    assert.deepStrictEqual(l.caret.get(t), [0, 2]);
    t.onblur();
    await l.drain();
    assert.deepStrictEqual(updates(l), [['pa1', 'p1', { rich: [r4('あい', ['link', 'https://example.invalid/']), r4('うえお')] }]]);
    // 帯の［リンク］でも同じ欄。今のリンクの住所が入っていて、［外す］で外す
    t = selectIn(l, 'p1', 0, 2);
    pushBtn(barBtn(l, 'リンク（Ctrl+K）'));
    assert.strictEqual(popOf(l).querySelector('input').value, 'https://example.invalid/');
    popOf(l).querySelectorAll('button').find((b) => b.textContent === '外す').onclick();
    assert.strictEqual(popOf(l), null);
    assert.deepStrictEqual(viewOf(t), ['あいうえお']);
    // Esc は欄だけを閉じて行へ戻る（R64）
    t = selectIn(l, 'p1', 1, 2);
    l.key({ key: 'k', code: 'KeyK', ctrlKey: true }, t);
    l.key({ key: 'Escape' }, popOf(l).querySelector('input'));
    assert.strictEqual(popOf(l), null);
    assert.strictEqual(l.document.activeElement, t);
    // 選んだ所に URL を貼るとリンク（文字は変わらない: K-25）。URL でない文字は今どおり置き換える
    t = selectIn(l, 'p1', 3, 5);
    t.onpaste({ preventDefault() {}, clipboardData: { getData: (k) => (k === 'text/plain' ? 'https://example.com/x\n' : '') } });
    assert.deepStrictEqual(viewOf(t), ['あいう', { tag: 'span', link: 'https://example.com/x', t: 'えお' }]);
    l.caret.set(t, 0, 1);
    t.onpaste({ preventDefault() {}, clipboardData: { getData: (k) => (k === 'text/plain' ? 'javascript:x' : '') } });
    assert.strictEqual(t.textContent, 'javascript:xいうえお', '開けない頭の文字をリンクにした');
    assert.ok(!viewOf(t).some((x) => x.link === 'javascript:x'));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-5（決めたこと 20・R11）: リンクの文字をふつうにクリック → openLink は呼ばれない。Ctrl+クリック → openLink の1回', T, async () => {
  const RICH = [r4('資料', ['link', 'https://example.com/a']), r4('を見る')];
  const l = await openReal({ pa1: [{ id: 'p1', type: 'paragraph', text: '資料を見る', rich: RICH, citeState: 'manual', cites: [] }] });
  try {
    const t = txtOf(l, 'p1');
    const span = t.childNodes[0];
    assert.strictEqual(span.getAttribute('title'), 'Ctrl+クリックで開く: https://example.com/a');
    t.focus();
    t.dispatchEvent({ type: 'click', target: span, ctrlKey: false });
    assert.deepStrictEqual(l.called('openLink'), [], 'ふつうのクリックでリンクを開いた');
    let prevented = false;
    t.dispatchEvent({ type: 'click', target: span, ctrlKey: true, preventDefault: () => { prevented = true; } });
    assert.deepStrictEqual(l.called('openLink').map((c) => c.args), [['https://example.com/a']]);
    assert.strictEqual(prevented, true);
    // リンクでない文字の Ctrl+クリックは何もしない
    t.dispatchEvent({ type: 'click', target: t.childNodes[1], ctrlKey: true });
    t.dispatchEvent({ type: 'click', target: t, ctrlKey: true });
    assert.strictEqual(l.called('openLink').length, 1);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-5（決めたこと 21・BQ3・R37）: 帯の［色］で文字の色・背景の色（既定と9色の2列）。選ぶと置き換え、既定で外す。Ctrl+Shift+H は最後の色', T, async () => {
  const l = await openReal({ pa1: [{ id: 'p1', type: 'paragraph', text: 'あいうえお' }] });
  try {
    // まだ色を使っていない: Ctrl+Shift+H は何もしない
    let t = selectIn(l, 'p1', 0, 5);
    assert.strictEqual(l.key({ key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true }, t).defaultPrevented, true);
    assert.deepStrictEqual(viewOf(t), ['あいうえお']);
    t = selectIn(l, 'p1', 1, 3);
    assert.strictEqual(pushBtn(barBtn(l, '色')), true);
    const menu = cmenuOf(l);
    assert.ok(menu, '［色］でメニューが出ない');
    assert.deepStrictEqual(menu.querySelectorAll('.chead').map((h) => h.textContent), ['文字の色', '背景の色']);
    for (const kind of ['color', 'bg']) {
      assert.deepStrictEqual(menu.querySelectorAll('button').filter((b) => b.dataset.key.startsWith(`${kind}:`)).map((b) => b.textContent), COLOR_NAMES);
    }
    // 文字の色の赤 → 選んだ所が赤。メニューは閉じ、フォーカスと選んだ所は行に残る
    assert.strictEqual(pushBtn(colorItem(l, 'color:red')), true, '色の項目を押すとフォーカスが行から外れる');
    assert.strictEqual(cmenuOf(l), null);
    assert.strictEqual(l.document.activeElement, t);
    assert.deepStrictEqual(l.caret.get(t), [1, 3]);
    assert.deepStrictEqual(viewOf(t), ['あ', { tag: 'span', color: 'red', t: 'いう' }, 'えお']);
    // 背景の色の黄を一部赤い所に → その所は黄の背景だけ（赤い字は外れる: BQ3）
    t = selectIn(l, 'p1', 2, 4);
    pushBtn(barBtn(l, '色'));
    pushBtn(colorItem(l, 'bg:yellow'));
    assert.deepStrictEqual(viewOf(t), ['あ', { tag: 'span', color: 'red', t: 'い' }, { tag: 'span', bg: 'yellow', t: 'うえ' }, 'お']);
    // Ctrl+Shift+H は最後の色（黄の背景）をもう一度付ける
    t = selectIn(l, 'p1', 0, 1);
    l.key({ key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true }, t);
    assert.deepStrictEqual(viewOf(t), [{ tag: 'span', bg: 'yellow', t: 'あ' }, { tag: 'span', color: 'red', t: 'い' }, { tag: 'span', bg: 'yellow', t: 'うえ' }, 'お']);
    // 既定 → その範囲の色を全部外す（最後の色は替えない）
    t = selectIn(l, 'p1', 0, 3);
    pushBtn(barBtn(l, '色'));
    pushBtn(colorItem(l, 'color:'));
    assert.deepStrictEqual(viewOf(t), ['あいう', { tag: 'span', bg: 'yellow', t: 'え' }, 'お']);
    t = selectIn(l, 'p1', 4, 5);
    l.key({ key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true }, t);
    assert.deepStrictEqual(viewOf(t), ['あいう', { tag: 'span', bg: 'yellow', t: 'えお' }]);
    // Esc は色のメニューだけを閉じる（帯は残る: R64）
    t = selectIn(l, 'p1', 0, 1);
    pushBtn(barBtn(l, '色'));
    l.key({ key: 'Escape' }, t);
    assert.strictEqual(cmenuOf(l), null);
    assert.ok(barOf(l), '色のメニューの Esc で帯まで閉じた');
    t.onblur();
    await l.drain();
    assert.deepStrictEqual(updates(l), [['pa1', 'p1', { rich: [r4('あいう'), r4('えお', ['bg', 'yellow'])] }]]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-5（決めたこと 21・S-03）: ⠿ のメニューの［色 ▸］・Ctrl+/・/あか で blocksSetColor の1回（1歩）。行は色で描く', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    // ⠿ → ［色 ▸］ → 背景の色の赤
    rowOf(l, 'p1').querySelector('.grip').onclick();
    const m = $(l, 'pNote').querySelector('.blockmenu');
    const items = m.querySelectorAll('.mitem').filter((x) => x.parentNode === m);
    assert.deepStrictEqual(items.map((x) => x.textContent), ['削除', '複製', '変換 ▸', '色 ▸']);
    items[3].onclick();
    const sub = $(l, 'pNote').querySelectorAll('.blockmenu').find((x) => x.classList.contains('sub'));
    assert.ok(sub, '［色 ▸］の中が開かない');
    assert.deepStrictEqual(sub.querySelectorAll('.chead').map((h) => h.textContent), ['文字の色', '背景の色']);
    const subItems = sub.querySelectorAll('.mitem');
    assert.deepStrictEqual(subItems.map((x) => x.textContent), [...COLOR_NAMES, ...COLOR_NAMES]);
    assert.strictEqual(l.document.activeElement, subItems[0]);
    subItems.find((x) => x.dataset.key === 'red_bg').onclick();
    await l.drain();
    assert.deepStrictEqual(l.called('blocksSetColor').map((c) => c.args), [['pa1', ['p1'], 'red_bg']]);
    assert.strictEqual(l.page().blocks.find((b) => b.id === 'p1').color, 'red_bg');
    assert.strictEqual(rowOf(l, 'p1').getAttribute('data-bbg'), 'red');
    assert.strictEqual(rowOf(l, 'p1').getAttribute('data-bcolor'), null);
    assert.strictEqual(l.steps.length, 1);
    // Ctrl+/ → ↓↓↓ で［色 ▸］ → Enter → 中の ↓ で灰 → Enter
    const t = typeIn(l, 'b1', '来週に出す', 1);
    l.key({ key: '/', code: 'Slash', ctrlKey: true }, t);
    const box = $(l, 'pNote').querySelector('.blockmenu');
    for (let i = 0; i < 3; i++) l.key({ key: 'ArrowDown' }, box);
    assert.strictEqual(l.document.activeElement.textContent, '色 ▸');
    l.key({ key: 'Enter' }, box);
    l.key({ key: 'ArrowDown' }, box);
    assert.strictEqual(l.document.activeElement.dataset.key, 'gray');
    l.key({ key: 'Enter' }, box);
    await l.drain();
    assert.deepStrictEqual(l.called('blocksSetColor').map((c) => c.args).slice(1), [['pa1', ['b1'], 'gray']]);
    assert.strictEqual(rowOf(l, 'b1').getAttribute('data-bcolor'), 'gray');
    // 既定で外す
    rowOf(l, 'p1').querySelector('.grip').onclick();
    $(l, 'pNote').querySelector('.blockmenu').querySelectorAll('.mitem')[3].onclick();
    $(l, 'pNote').querySelectorAll('.blockmenu').find((x) => x.classList.contains('sub')).querySelectorAll('.mitem')[0].onclick();
    await l.drain();
    assert.deepStrictEqual(l.called('blocksSetColor').map((c) => c.args).slice(2), [['pa1', ['p1'], '']]);
    assert.strictEqual(rowOf(l, 'p1').getAttribute('data-bbg'), null);
    // / メニューの色: 空の行で「/あか」→ 文字の色と背景の色の赤が出て、Enter（文字の色の赤）で blocksSetColor の1回・打った語は消える・1歩
    const n = l.steps.length;
    const e = typeIn(l, 'e1', '/あか');
    e.dispatchEvent({ type: 'input' });
    const sm = $(l, 'pNote').querySelector('#slashMenu');
    assert.ok(sm, '「/あか」で / メニューが出ない');
    assert.deepStrictEqual(sm.querySelectorAll('.shead').map((h) => h.textContent), ['文字の色', '背景の色']);
    assert.deepStrictEqual(sm.querySelectorAll('.sopt').map((o) => [o.dataset.key, o.textContent]), [['color:red', '赤'], ['bg:red', '赤']]);
    l.key({ key: 'Enter' }, e);
    await l.drain();
    assert.deepStrictEqual(l.called('blocksSetColor').map((c) => c.args).slice(3), [['pa1', ['e1'], 'red']]);
    assert.strictEqual(txtOf(l, 'e1').textContent, '');
    assert.strictEqual(rowOf(l, 'e1').getAttribute('data-bcolor'), 'red');
    assert.strictEqual(l.steps.length, n + 1);
    // 文のある行で「/あかいはいけい」→ 背景の色の赤だけ。打った語を除いた文を保存してから色（2つの命令で1歩）
    const p = typeIn(l, 'p1', 'あいうえお /あかいはいけい');
    p.dispatchEvent({ type: 'input' });
    assert.deepStrictEqual($(l, 'pNote').querySelector('#slashMenu').querySelectorAll('.sopt').map((o) => o.dataset.key), ['bg:red']);
    l.key({ key: 'Enter' }, p);
    await l.drain();
    assert.deepStrictEqual(l.called('blocksSetColor').map((c) => c.args).slice(4), [['pa1', ['p1'], 'red_bg']]);
    assert.strictEqual(l.page().blocks.find((b) => b.id === 'p1').text, 'あいうえお');
    // Ctrl+Z の1回で文と色の両方が戻る
    press(l, Z);
    await l.drain();
    const back = l.page().blocks.find((b) => b.id === 'p1');
    assert.deepStrictEqual([back.text, back.color], ['あいうえお', undefined]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-5（決めたこと 21・COLOR-02〜05）: 行の色の CSS は明暗の両方にある9色の語だけを使い、CSS の入れ子は無い。帯・リンクの欄・色のメニューの CSS も決まった語だけ', () => {
  const { parseHTML } = require('./helpers/simdom');
  const S = require('./helpers/simcss');
  const styles = parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n');
  const rules = S.parse(styles);
  for (const n of R.COLORS) {
    const fg = rules.find((r) => r.sel === `.blk[data-bcolor="${n}"] > .txt` && !r.at);
    const bg = rules.find((r) => r.sel === `.blk[data-bbg="${n}"]` && !r.at);
    assert.ok(fg && bg, `行の色 ${n} の CSS が無い`);
    assert.strictEqual(fg.decls.color.trim(), `var(--mk-${n})`);
    assert.strictEqual(bg.decls.background.trim(), `var(--mkbg-${n})`);
    for (const k of ['data-color', 'data-bg']) assert.ok(rules.some((r) => r.sel === `.colorlist .sw[${k}="${n}"]` && !r.at), `色の見本 ${k}=${n} の CSS が無い`);
  }
  const mine = rules.filter((r) => /markbar|linkpop|colorlist|data-bcolor|data-bbg/.test(r.sel));
  assert.ok(mine.length > 0);
  for (const r of mine) {
    assert.ok(!r.nested && !r.sel.includes('&'), `CSS の入れ子: ${r.sel}`);
    for (const [k, v] of Object.entries(r.decls)) if (/color|background|border/.test(k)) assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(v), `${r.sel} の ${k} が語でない色: ${v}`);
  }
});

// ---------------------------------------------------------------- EB-4 直し（2026-10-29 の点検。R113〜R115）
test('EB-4 直し・I1（決めたこと 10・R96・R107・R115）: 記法の直後の印は、ほかの行の Ctrl+Z を横取りしない（押したのがその行のときだけ・行から出ると消える）', T, async () => {
  const l = await openReal({ pa1: [{ id: 'p1', type: 'paragraph', text: '' }, { id: 'p2', type: 'paragraph', text: 'かき' }, { id: 'p3', type: 'paragraph', text: '' }] });
  try {
    // 文中の記法: p1 で「**a**」→ 太字。行から出て保存 → p2 で直して保存 → p2 の Ctrl+Z は p2 の歩みを戻す（p1 の記号は戻さない）
    const t = txtOf(l, 'p1');
    t.focus(); t.textContent = '**a**'; l.caret.set(t, 5);
    t.dispatchEvent({ type: 'input', inputType: 'insertText' });
    assert.deepStrictEqual(viewOf(t), [{ tag: 'span', m: 'b', t: 'a' }]);
    t.onblur();
    await l.drain();
    const t2 = typeIn(l, 'p2', 'かきく');
    t2.dispatchEvent({ type: 'input', inputType: 'insertText' });
    t2.onblur();
    await l.drain();
    t2.focus();
    l.key(Z, t2);
    await l.drain();
    assert.deepStrictEqual(revs(l), [['pa1', [l.steps[1].step]]], 'p2 の Ctrl+Z で p2 を戻さない');
    assert.deepStrictEqual(viewOf(txtOf(l, 'p1')), [{ tag: 'span', m: 'b', t: 'a' }], 'p2 の Ctrl+Z で p1 の記号を戻した');
    // 行から出ていなくても（偽の DOM の focus は blur を起こさない）、押したのがその行でなければ横取りしない
    const t3 = txtOf(l, 'p3');
    t3.focus(); t3.textContent = '*b*'; l.caret.set(t3, 3);
    t3.dispatchEvent({ type: 'input', inputType: 'insertText' });
    assert.deepStrictEqual(viewOf(t3), [{ tag: 'span', m: 'i', t: 'b' }]);
    txtOf(l, 'p2').focus();
    let n = l.called('editRevert').length;
    l.key(Z, txtOf(l, 'p2'));
    await l.drain();
    // p3 の記号を画面だけで戻さない。p3 の打った文は決めたこと 9 のとおり保存してからその歩みを戻す（DB を通る）
    assert.strictEqual(l.called('editRevert').length, n + 1, 'p2 の Ctrl+Z が p3 の記号を画面だけで戻した');
    assert.deepStrictEqual(viewOf(txtOf(l, 'p3')), []);
    assert.strictEqual(l.page().blocks.find((b) => b.id === 'p3').text, '');
    // 行から出て保存した後に戻ってきた Ctrl+Z も、記号を画面だけで戻さず、保存の歩みを戻す（行から出ると印は消える）
    const t4 = txtOf(l, 'p3');
    t4.focus(); t4.textContent = '*c*'; l.caret.set(t4, 3);
    t4.dispatchEvent({ type: 'input', inputType: 'insertText' });
    assert.deepStrictEqual(viewOf(t4), [{ tag: 'span', m: 'i', t: 'c' }]);
    t4.onblur();
    await l.drain();
    t4.focus();
    n = l.called('editRevert').length;
    l.key(Z, t4);
    await l.drain();
    assert.strictEqual(l.called('editRevert').length, n + 1, '行から出た後の Ctrl+Z が記号を画面だけで戻した');
    assert.strictEqual(l.page().blocks.find((b) => b.id === 'p3').text, '');
    // 記法で変えた後にほかの行で打ったら、その行に戻った Ctrl+Z も記号を画面だけで戻さない
    const t5 = txtOf(l, 'p3');
    t5.focus(); t5.textContent = '`d`'; l.caret.set(t5, 3);
    t5.dispatchEvent({ type: 'input', inputType: 'insertText' });
    assert.deepStrictEqual(viewOf(t5), [{ tag: 'span', m: 'code', t: 'd' }]);
    const t6 = txtOf(l, 'p2');
    t6.focus(); t6.textContent = 'かきくけ'; l.caret.set(t6, 4);
    t6.dispatchEvent({ type: 'input', inputType: 'insertText' });
    t5.focus();
    n = l.called('editRevert').length;
    l.key(Z, t5);
    await l.drain();
    assert.strictEqual(l.called('editRevert').length, n + 1, 'ほかの行で打った後の Ctrl+Z が記号を画面だけで戻した');
    // 行頭の記法の記号（R96）も同じ: p3 を「- 」で箇条書き → Ctrl+Z で記号が戻る → p2 へ移って Ctrl+Z → p3 の記号は残る
    const l2 = await openReal({ pa1: [{ id: 'q1', type: 'paragraph', text: '' }, { id: 'q2', type: 'paragraph', text: 'さし' }] });
    try {
      const q = typeIn(l2, 'q1', '- ');
      q.dispatchEvent({ type: 'input', inputType: 'insertText' });
      await l2.drain();
      assert.strictEqual(l2.page().blocks[0].type, 'bullet');
      l2.key(Z, txtOf(l2, 'q1'));
      await l2.drain();
      assert.strictEqual(txtOf(l2, 'q1').textContent, '- ');
      txtOf(l2, 'q2').focus();
      const n = l2.called('editRevert').length;
      l2.key(Z, txtOf(l2, 'q2'));
      await l2.drain();
      // q2 の Ctrl+Z は q1 の記号を画面だけで消さない。戻した記号は打った文なので、決めたこと 9 のとおり保存してからその歩みを戻す（DB を通る）
      assert.strictEqual(l2.called('editRevert').length, n + 1, 'q2 の Ctrl+Z が q1 の記号を画面だけで消した（DB に送らない）');
      assert.deepStrictEqual(l2.steps.slice(-2).map((x) => x.cmd), ['block.update', 'edit.revert']);
      assert.deepStrictEqual(l2.errors.map(fmt), []);
    } finally { l2.done(); }
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-4 直し・I2（決めたこと 17・F101・R115）: 欄に Chromium の既定の飾り（<b>・style の span）が入ったら描き直し、画面の見た目を保存する形にそろえる', T, async () => {
  const l = await openReal({ pa1: [{ id: 'p1', type: 'paragraph', text: 'あいう' }, { id: 'p2', type: 'paragraph', text: 'かき', rich: [r4('かき', 'b')], citeState: 'manual', cites: [] }] });
  try {
    const t = txtOf(l, 'p1');
    t.focus();
    const b = l.document.createElement('b');
    b.appendChild(l.document.createTextNode('え'));
    t.appendChild(b);
    l.caret.set(t, 4);
    t.dispatchEvent({ type: 'input', inputType: 'insertText' });
    assert.deepStrictEqual(viewOf(t), ['あいうえ'], '<b> が欄に残った（画面は太字・保存は素の文字）');
    // 自分の span でも、決まった印のほかの属性（style）があれば描き直す
    const t2 = txtOf(l, 'p2');
    t2.focus();
    const sp = l.document.createElement('span');
    sp.setAttribute('style', 'font-weight: 700; color: rgb(255, 0, 0)');
    sp.appendChild(l.document.createTextNode('く'));
    t2.appendChild(sp);
    l.caret.set(t2, 3);
    t2.dispatchEvent({ type: 'input', inputType: 'insertText' });
    assert.deepStrictEqual(viewOf(t2), [{ tag: 'span', m: 'b', t: 'かきく' }]);
    assert.ok(!t2.childNodes.some((n) => n.getAttribute && n.getAttribute('style') !== null), 'style の span が欄に残った');
    assert.deepStrictEqual(l.caret.get(t2), [3, 3]);
    t.onblur(); t2.onblur();
    await l.drain();
    assert.deepStrictEqual(updates(l), [['pa1', 'p1', { text: 'あいうえ' }], ['pa1', 'p2', { rich: [r4('かきく', 'b')] }]]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-4 直し・M1・M4（決めたこと 18・R115）: 文中の記法は文字を足したときだけ変える（消して「**a**」になっても変えない）。コードの中では変えない', T, async () => {
  const l = await openReal({ pa1: [{ id: 'p1', type: 'paragraph', text: '' }, { id: 'p2', type: 'paragraph', text: 'x *b y', rich: [r4('x *b y', 'code')], citeState: 'manual', cites: [] }] });
  try {
    const t = txtOf(l, 'p1');
    t.focus(); t.textContent = '**a**x'; l.caret.set(t, 6);
    t.dispatchEvent({ type: 'input', inputType: 'insertText' });
    assert.deepStrictEqual(viewOf(t), ['**a**x']);
    t.textContent = '**a**'; l.caret.set(t, 5);
    t.dispatchEvent({ type: 'input', inputType: 'deleteContentBackward' });
    assert.deepStrictEqual(viewOf(t), ['**a**'], 'Backspace で太字に変えた');
    // コードの中で「*」を打っても斜体にしない
    const t2 = txtOf(l, 'p2');
    t2.focus();
    t2.childNodes[0].textContent = 'x *b* y';
    l.caret.set(t2, 5);
    t2.dispatchEvent({ type: 'input', inputType: 'insertText' });
    assert.deepStrictEqual(viewOf(t2), [{ tag: 'span', m: 'code', t: 'x *b* y' }], 'コードの中の記号を斜体に変えた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-4 直し・M3（R115。EB-5 直しで R117）: 行の文の外に落としたものは入れない（Chromium が HTML のまま入れる。行の文の上の素の文字は R117 の場面）。行の中で選んだ文字を引っ張っても行の並べ替えにしない', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const box = $(l, 'pNote');
    let over = false;
    const dt = { dropEffect: 'copy', getData: () => '<b>太字</b>' };
    box.ondragover({ preventDefault: () => { over = true; }, dataTransfer: dt, clientY: 5 });
    assert.strictEqual(over, true, '落とせる形のまま');
    assert.strictEqual(dt.dropEffect, 'none');
    let dropped = false;
    await box.ondrop({ preventDefault: () => { dropped = true; }, dataTransfer: dt, clientY: 5 });
    assert.strictEqual(dropped, true, '行の欄に文字を落とした（Chromium が HTML のまま入れる）');
    // 文の欄から始めた引っ張り（選んだ文字）は止め、行の並べ替えを始めない
    const row = rowOf(l, 'p1');
    let stopped = false;
    row.ondragstart({ target: row._txt, preventDefault: () => { stopped = true; }, dataTransfer: { setData() {}, effectAllowed: '' } });
    assert.strictEqual(stopped, true);
    await box.ondrop({ preventDefault() {}, clientY: 5 });
    await l.drain();
    assert.deepStrictEqual(l.called('blockMove'), [], '文字を引っ張っただけで行を動かした');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- EB-6（SEC2・F102・決めたこと 32・R68）: 画面の HTML に入れるのは決まった文字だけ
// 要素の形（名前と文字の並び）。前の innerHTML の文を偽の DOM で読んだ形と比べて、見た目が同じことを見る
const shape = (n) => (n.tagName === '#text' ? ['#text', n.textContent] : [n.tagName.toLowerCase(), n.className || '', ...n.childNodes.map(shape)]);
test('EB-6・SEC2: 音声入力の履歴が空のとき、設定のホットキーの文字は <kbd> の文字として入る（HTML にならない）', T, async () => {
  const { RETURNS } = require('./helpers/simrun.js');
  const { parseHTML } = require('./helpers/simdom');
  const hotkey = '<img src=x onerror="alert(1)">Ctrl+<b>Q</b>';
  const l = await load(APP, { returns: { getSettings: () => ({ ...RETURNS.getSettings(), hotkey }), getHistory: () => [] } });
  try {
    await l.drain();
    const box = $(l, 'histList');
    assert.deepStrictEqual(box.querySelectorAll('img').length + box.querySelectorAll('b').length, 0, 'ホットキーの文字が要素になった');
    const kbd = box.querySelectorAll('kbd');
    assert.strictEqual(kbd.length, 1);
    assert.strictEqual(kbd[0].textContent, hotkey, 'ホットキーの文字がそのまま出ない');
    const d = box.querySelectorAll('.empty')[0];
    assert.ok(d && d._html === undefined, 'innerHTML で入れた');
    // 見た目は前と同じ（ふつうのホットキーなら前の文と同じ形）
    const l2 = await load(APP, { returns: { getHistory: () => [] } });
    try {
      await l2.drain();
      const d2 = $(l2, 'histList').querySelectorAll('.empty')[0];
      const want = parseHTML('<div class="big">まだ履歴がありません</div>どのアプリでも <kbd>Control+Shift+Space</kbd> を押して話しかけてください。').root;
      assert.deepStrictEqual(d2.childNodes.map(shape), want.childNodes.map(shape));
      assert.deepStrictEqual(l2.errors.map(fmt), []);
    } finally { if (l2.done) l2.done(); }
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { if (l.done) l.done(); }
});

test('EB-6・R68: 音声入力の数の欄（今日・累計・節約時間）は数と単位の small を要素で組む（innerHTML を使わない・見た目は前と同じ）', T, async () => {
  const { parseHTML } = require('./helpers/simdom');
  const now = new Date().toISOString();
  const old = '2020-01-01T00:00:00.000Z';
  const cases = [
    // [履歴, 今日, 累計, 節約]（前の文: `${tc}<small>回</small> ${fmtChars(tch)}<small>字</small>` と `${(saved/60).toFixed(1)}<small>時間</small>`・`${Math.round(saved)}<small>分</small>`）
    [[{ id: 'h1', text: 'あ', createdAt: now, durationSec: 6, chars: 140 }, { id: 'h2', text: 'い', createdAt: old, durationSec: 0, chars: 70 }],
      '1<small>回</small> 140<small>字</small>', '2<small>回</small> 210<small>字</small>', '3<small>分</small>'],
    [[{ id: 'h1', text: 'う', createdAt: now, durationSec: 0, chars: 12345 }, { id: 'h2', text: 'え', createdAt: now, durationSec: 0, chars: 0 }],
      '2<small>回</small> 1.2万<small>字</small>', '2<small>回</small> 1.2万<small>字</small>', '2.9<small>時間</small>'],
    [[], '0<small>回</small> 0<small>字</small>', '0<small>回</small> 0<small>字</small>', '0<small>分</small>'],
  ];
  for (const [hist, today, total, saved] of cases) {
    const l = await load(APP, { returns: { getHistory: () => hist } });
    try {
      await l.drain();
      for (const [id, html] of [['stToday', today], ['stTotal', total], ['stSaved', saved]]) {
        const el = $(l, id);
        assert.strictEqual(el._html, undefined, `${id} を innerHTML で入れた`);
        assert.deepStrictEqual(el.childNodes.map(shape), parseHTML(html).root.childNodes.map(shape), `${id} の形が前と違う（${JSON.stringify(hist.map((h) => h.chars))}）`);
      }
      assert.deepStrictEqual(l.errors.map(fmt), []);
    } finally { if (l.done) l.done(); }
  }
});

// ---------------------------------------------------------------- EB-5 直し（2026-10-29 の点検。R117）
test('EB-5 直し（R117。R115 で止めた落とす動きを戻した）: ほかのアプリ・文字起こしの欄から行の文に落とした文字は、素の文字だけを落とした所へ入れ、1歩で保存する。ファイル・文字の無いもの・行の外は入れない', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const box = $(l, 'pNote');
    const t = txtOf(l, 'p1');
    const dt = (o = {}) => ({ dropEffect: 'copy', types: o.types || ['text/html', 'text/plain'], files: o.files || [],
      getData: (k) => (k === 'text/plain' ? (o.plain ?? 'X<b>Y</b>\r\nZ') : '<b>太字</b><script>x()</script>') });
    // 行の文の上: 落とせる（copy）
    let over = false;
    const d1 = dt();
    box.ondragover({ preventDefault: () => { over = true; }, dataTransfer: d1, target: t, clientX: 5, clientY: 25 });
    assert.strictEqual(over, true);
    assert.strictEqual(d1.dropEffect, 'copy', '行の文の上で落とせない');
    // 落とした所（2文字目の後ろ）へ素の文字だけ・改行は行の中の改行
    l.caret.point(t, 2);
    let stopped = false;
    await box.ondrop({ preventDefault: () => { stopped = true; }, dataTransfer: d1, target: t, clientX: 5, clientY: 25 });
    await l.drain();
    assert.strictEqual(stopped, true, '既定の落とし（Chromium が HTML のまま入れる）を止めない');
    assert.strictEqual(t.textContent, 'あいX<b>Y</b>\nZうえお');
    assert.deepStrictEqual(t.querySelectorAll('b').length + t.querySelectorAll('script').length, 0, 'HTML が要素になった');
    assert.strictEqual(l.page().blocks.find((b) => b.id === 'p1').text, 'あいX<b>Y</b>\nZうえお', '落とした文字を保存しない');
    assert.strictEqual(updates(l).length, 1);
    assert.strictEqual(l.steps.length, 1, '1歩にならない');
    // Ctrl+Z の1回で戻る
    press(l, Z);
    await l.drain();
    assert.strictEqual(l.page().blocks.find((b) => b.id === 'p1').text, 'あいうえお');
    // ファイル・文字の無いもの・行の外・区切り線は落とさない（落とせない形にし、既定の落としも止める）
    const t2 = txtOf(l, 'b1');
    for (const [d, target, why] of [[dt({ types: ['Files'], files: [{ name: 'a.png' }] }), t2, 'ファイル'], [dt({ plain: '' }), t2, '文字の無いもの'],
      [dt(), box, '行の外']]) {
      over = false; stopped = false;
      box.ondragover({ preventDefault: () => { over = true; }, dataTransfer: d, target, clientY: 5 });
      assert.strictEqual(over, true, why);
      assert.strictEqual(d.dropEffect, 'none', `${why}を落とせる形`);
      await box.ondrop({ preventDefault: () => { stopped = true; }, dataTransfer: d, target, clientY: 5 });
      await l.drain();
      assert.strictEqual(stopped, true, why);
      assert.strictEqual(t2.textContent, '来週に出す', `${why}を入れた`);
    }
    assert.strictEqual(updates(l).length, 1);
    // 行の並べ替えは今どおり（⠿ から引っ張る）
    await dragTo(l, 'p1', 0);
    await l.drain();
    assert.strictEqual(l.called('blockMove').length, 1, '行の並べ替えができない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// 浮いた箱の大きさ（偽の DOM は大きさを持たないので、組の名前ごとに置く）
function withSizes(sizes, fn) {
  const { Element } = require('./helpers/simdom');
  const old = { w: Object.getOwnPropertyDescriptor(Element.prototype, 'offsetWidth'), h: Object.getOwnPropertyDescriptor(Element.prototype, 'offsetHeight') };
  const of = (e) => sizes[String(e.className || '').split(' ')[0]] || [0, 0];
  Object.defineProperty(Element.prototype, 'offsetWidth', { configurable: true, get() { return of(this)[0]; } });
  Object.defineProperty(Element.prototype, 'offsetHeight', { configurable: true, get() { return of(this)[1]; } });
  const back = () => {
    if (old.w) Object.defineProperty(Element.prototype, 'offsetWidth', old.w); else delete Element.prototype.offsetWidth;
    Object.defineProperty(Element.prototype, 'offsetHeight', old.h);
  };
  return Promise.resolve().then(fn).finally(back);
}
test('EB-5 直し: 道具の帯・リンクの欄・色のメニューは要約の欄の幅に収め（拡大 200% で右へはみ出さない）、上か下かは見えている所で決める（捲った欄のいちばん上の行の選びでも見える）', T, async () => {
  const l = await openReal({ pa1: [{ id: 'p1', type: 'paragraph', text: 'あいうえおかきくけこ' }] });
  try {
    await withSizes({ markbar: [220, 36], linkpop: [380, 80], colormenu: [200, 300] }, async () => {
      const note = $(l, 'pNote');
      // 窓（.page）は画面の 100〜500px。欄は 200px 捲られて頭が -200px・幅 400px
      $(l, 'pageWrap')._rect = { top: 100, left: 0, width: 600, height: 400 };
      note._rect = { top: -200, left: 20, width: 400, height: 2000 };
      note.clientWidth = 400;
      let sel = { top: 110, bottom: 130, left: 350, right: 380, width: 30, height: 20 };
      l.window.__natsuCaret.rect = () => sel;
      // 見えている所のいちばん上の選び: 上（110 - 36 - 6 = 68）は窓の外なので下へ。右の端は欄の幅 - 帯の幅（400 - 220）
      selectIn(l, 'p1', 6, 8);
      const bar = barOf(l);
      assert.ok(bar);
      assert.strictEqual(bar.style.top, `${130 + 6 + 200}px`, '見えている所の上へ置いた');
      assert.strictEqual(bar.style.left, '180px', '帯が欄の右へはみ出す');
      // 窓の中ほどの選び: 上へ・選んだ所の左
      sel = { top: 300, bottom: 320, left: 60, right: 90, width: 30, height: 20 };
      selectIn(l, 'p1', 1, 3);
      assert.strictEqual(barOf(l).style.top, `${300 - 36 - 6 + 200}px`);
      assert.strictEqual(barOf(l).style.left, '40px');
      // 色のメニュー: 帯の［色］の下。下が窓の外（帯は 450 - 42 + 200 = 608。608 + 36 + 4 + 300 - 200 > 500）で帯の上に入るなら上へ。右の端は欄の幅 - メニューの幅
      sel = { top: 450, bottom: 470, left: 390, right: 395, width: 5, height: 20 };
      selectIn(l, 'p1', 1, 3);
      pushBtn(barBtn(l, '色'));
      const cm = cmenuOf(l);
      assert.ok(cm, '色のメニューが出ない');
      assert.ok(parseFloat(cm.style.left) <= 200 && parseFloat(cm.style.left) >= 0, `色のメニューが欄の右へはみ出す（${cm.style.left}）`);
      assert.strictEqual(cm.style.top, `${608 - 4 - 300}px`, '色のメニューが窓の下へはみ出す');
      // リンクの欄: 選んだ所の下・右の端は 400 - 380
      l.key({ key: 'k', code: 'KeyK', ctrlKey: true }, txtOf(l, 'p1'));
      const pop = popOf(l);
      assert.ok(pop);
      assert.strictEqual(pop.style.left, '20px', 'リンクの欄が欄の右へはみ出す');
      assert.strictEqual(pop.style.top, `${470 + 6 + 200}px`);
    });
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-5 直し: 変換中は道具の帯を出さない。帯を出した行が命令の答えで消えたら帯も消す（書いている途中のまま残さない）', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    // 変換中の選び（変換の文字を選んでいる）では出さず、出ていた帯は隠す
    let t = selectIn(l, 'p1', 1, 3);
    assert.ok(barOf(l));
    t.dispatchEvent({ type: 'compositionstart' });
    t.dispatchEvent({ type: 'keyup' });
    assert.ok(!barOf(l), '変換中に帯が残る');
    t.dispatchEvent({ type: 'compositionend' });
    t = selectIn(l, 'p1', 1, 3);
    assert.ok(barOf(l), '変換が終わっても帯が出ない');
    t.dispatchEvent({ type: 'compositionstart' });
    l.caret.set(t, 0, 2);
    t.dispatchEvent({ type: 'mouseup' });
    assert.ok(!barOf(l), '変換中に帯が出た');
    t.dispatchEvent({ type: 'compositionend' });
    // 帯を出した行（b1）を ⠿ の［削除］で消す → 答えの描き直しで帯も消え、書いている途中でなくなる
    selectIn(l, 'b1', 0, 2);
    assert.ok(barOf(l));
    rowOf(l, 'b1').querySelector('.grip').onclick();
    const m = $(l, 'pNote').querySelector('.blockmenu');
    m.querySelectorAll('.mitem').find((x) => x.textContent === '削除').onclick();
    await l.drain();
    assert.ok(!rowOf(l, 'b1'), '前提: 行が消えない');
    assert.ok(!barOf(l), '消えた行の帯が残る');
    // 書いている途中でないので、保存した議事録を前に出せる
    l.document.activeElement && l.document.activeElement.blur();
    l.fire('onPageOpen', 'pa1', { saved: true });
    await l.drain();
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-5 直し: リンクの欄を開いている間に行が描き直されても、同じ id の行に付ける（黙って閉じてフォーカスを失わない）', T, async () => {
  const l = await openReal({ pa1: BASE() });
  try {
    const t = selectIn(l, 'p1', 1, 3);
    l.key({ key: 'k', code: 'KeyK', ctrlKey: true }, t);
    const pop = popOf(l);
    assert.ok(pop);
    // 開いている間に、⠿ の［色 ▸］で行の色を変える（答えで p1 の行の要素が替わる。フォーカスはリンクの欄）
    rowOf(l, 'p1').querySelector('.grip').onclick();
    const m = $(l, 'pNote').querySelector('.blockmenu');
    m.querySelectorAll('.mitem').filter((x) => x.parentNode === m)[3].onclick();
    $(l, 'pNote').querySelectorAll('.blockmenu').find((x) => x.classList.contains('sub')).querySelectorAll('.mitem').find((x) => x.dataset.key === 'red').onclick();
    await l.drain();
    assert.ok(txtOf(l, 'p1') !== t, '前提: 行の要素が替わらない');
    pop.querySelector('input').value = 'https://example.invalid/';
    l.key({ key: 'Enter' }, pop.querySelector('input'));
    await l.drain();
    const t2 = txtOf(l, 'p1');
    assert.deepStrictEqual(viewOf(t2), ['あ', { tag: 'span', link: 'https://example.invalid/', t: 'いう' }, 'えお'], '描き直した行にリンクが付かない');
    assert.ok(l.document.activeElement === t2, 'フォーカスが行に戻らない');
    assert.ok(!popOf(l));
    // 行の文が変わっていたら付けずに閉じ、行へフォーカスを戻す
    selectIn(l, 'p1', 0, 1);
    l.key({ key: 'k', code: 'KeyK', ctrlKey: true }, txtOf(l, 'p1'));
    const pop2 = popOf(l);
    l.call('page.put', { page: { ...l.page(), blocks: l.page().blocks.map((b) => (b.id === 'p1' ? { ...b, text: '別の文', rich: undefined } : b)) }, baseRev: l.page().rev }, 'main');
    rowOf(l, 't1').querySelector('.grip').onclick();
    const m2 = $(l, 'pNote').querySelector('.blockmenu');
    m2.querySelectorAll('.mitem').find((x) => x.textContent === '複製').onclick();
    await l.drain();
    pop2.querySelector('input').value = 'https://example.invalid/b';
    l.key({ key: 'Enter' }, pop2.querySelector('input'));
    await l.drain();
    assert.ok(!popOf(l));
    assert.ok(l.document.activeElement === txtOf(l, 'p1'), 'フォーカスを失った');
    assert.ok(!JSON.stringify(l.page().blocks.find((b) => b.id === 'p1').rich || null).includes('example.invalid/b'), '変わった文にリンクを付けた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EB-5 直し（R117）: リンクで飛んだ先の印（.blk.linkhit）は背景の色の行でも見える（地は変えず内側の線。線は背景の色の上で 3:1 以上・その上の文字は今の 4.5:1 のまま）', () => {
  const { parseHTML } = require('./helpers/simdom');
  const S = require('./helpers/simcss');
  const C = require('./helpers/css');
  const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
  const at = (sel) => rules.findIndex((r) => r.sel.split(',').map((x) => x.trim()).includes(sel) && !r.at);
  const hit = at('.blk.linkhit[data-bbg]');
  assert.ok(hit >= 0, '背景の色の行の .linkhit の CSS が無い（.blk[data-bbg=…] の地に負けて見えない）');
  assert.strictEqual(rules[hit].decls.outline.trim(), '2px solid var(--accent-text)');
  assert.strictEqual(rules[hit].decls['outline-offset'].trim(), '-2px');
  assert.strictEqual(rules[hit].decls.background, undefined, '背景の色の行の地を変えた（文字が 4.5:1 を割る）');
  const light = S.tokens(rules, '');
  const dark = { ...light, ...S.tokens(rules, '@media (prefers-color-scheme: dark)') };
  for (const [name, t] of [['明', light], ['暗', dark]]) {
    const bg = C.color(t['--bg']);
    for (const m of R.COLORS) {
      const c = C.contrast(C.color(t['--accent-text']), C.over(C.color(t[`--mkbg-${m}`]), bg));
      assert.ok(c >= 3, `${name}: 印の線が --mkbg-${m} の上で ${c.toFixed(2)}`);
    }
  }
});

// ---------------------------------------------------------------- EK-3（決めたこと 23〜27・R18・R66・BQ5 (a)・BQ30 (a)。E8・F102）: 画面の貼り付け
const PC = require('../src/pasteConvert');
const FIX = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', 'paste', `${n}.html`), 'utf8');
const pastes = (l) => l.called('blockPaste').map((c) => c.args);
const WRITES = ['blockPaste', 'blockInsert', 'blockSplit', 'blockUpdate', 'blockMerge', 'blockTurnInto', 'blockRemove', 'blockMove', 'blocksSetColor'];
const writes = (l) => WRITES.flatMap((n) => l.called(n).map(() => n));
// 行に貼る（本物の paste の事象の形。既定を止めたかを返す）
function pasteIn(t, data) {
  let prevented = false;
  t.dispatchEvent({ type: 'paste', clipboardData: { getData: (k) => (Object.hasOwn(data, k) ? data[k] : '') }, preventDefault() { prevented = true; } });
  return prevented;
}
const PLAIN_V = { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true };
const MANUAL = (id, text, o = {}) => ({ id, type: 'paragraph', text, citeState: 'manual', cites: [], ...o });
const PG3 = () => [MANUAL('q1', '前の文'), MANUAL('q2', 'あいうえお'), MANUAL('q3', '後の文')];
// 欄の行の要素が、自分の span（決まった印だけ・中は文字だけ）と文字のほかを持たないか（要素は assert の値に渡さない: R117）
const OWN_ATTRS = ['data-m', 'data-color', 'data-bg', 'data-link', 'title'];
function foreignIn(l) {
  const out = [];
  for (const t of $(l, 'pNote').querySelectorAll('.txt')) {
    for (const n of t.childNodes) {
      if (n.tagName === '#text') continue;
      if (n.tagName !== 'span') { out.push(`<${n.tagName}>`); continue; }
      const names = typeof n.getAttributeNames === 'function' ? n.getAttributeNames() : Object.keys(n.attributes || {});
      for (const k of names) if (!OWN_ATTRS.includes(k)) out.push(`span[${k}]`);
      if (n.childNodes.some((k) => k.tagName !== '#text')) out.push('span の中の要素');
    }
  }
  return out;
}
const PASTE_TOO_BIG = '貼り付けが大きすぎます（2,000 行・1MB まで）。分けて貼ってください。';

test('EK-3（R120）: 画面の写し（app.html の pasteConvert）は src/pasteConvert.js と字も答えも同じ。画面の <script> の中に HTML のコメントの頭と script の印が無い', () => {
  const at = HTML.indexOf('  // ---- pasteConvert の写し');
  const end = HTML.indexOf('  // ---- pasteConvert の写しはここまで');
  assert.ok(at > 0 && end > at, 'app.html に pasteConvert の写しが無い');
  const seg = HTML.slice(at, end);
  // 字: PASTE_ROWS から pasteBlocks の終わりまで。行の頭に4つの空白・「<」+「!--」と「<」+「script」の「<」は \x3c（同じ文字の値）
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'pasteConvert.js'), 'utf8');
  const body = SRC.slice(SRC.indexOf('const PASTE_ROWS'), SRC.indexOf('\nmodule.exports')).replace(/\s+$/, '');
  const want = body.replace(/<!--/g, '\\x3c!--').replace(/<script/gi, '\\x3cscript').split('\n').map((x) => (x ? `    ${x}` : x)).join('\n');
  assert.ok(seg.includes(want), 'app.html の写しの字が src/pasteConvert.js と違う');
  // 答え（上の richText の写しの MARKS・linkOk と、木の kidsCanView を使う）
  const rt = HTML.slice(HTML.indexOf('  // ---- richText の写し'), HTML.indexOf('  // ---- richText の写しはここまで'));
  const app = new Function(`${fnApp('kidsCanView')}\n${fnApp('graphemeEnds')}\n${fnApp('safeOffset')}\n${rt}\n${seg}\nreturn pasteConvert;`)();   // eslint-disable-line no-new-func
  assert.deepStrictEqual([app.PASTE_ROWS, app.PASTE_BYTES], [PC.PASTE_ROWS, PC.PASTE_BYTES]);
  const many = Array.from({ length: 2001 }, (_, i) => `行${i}`).join('\n');
  const deep = ['- 親', ...Array.from({ length: 2000 }, (_, i) => `  - 子${i}`)].join('\n');
  const inputs = [...['word', 'edge', 'teams', 'gdocs', 'excel'].map((n) => ({ html: FIX(n), text: 'x' })),
    { html: '<p>あ<img src="x" onerror="y()"><b onclick="z()">太</b><script>秘</script><a href="javascript:alert(1)">リンク</a></p>', text: '' },
    { html: '<h4>四</h4><ul><li>a<ul><li>b</li></ul></li></ul><table><tr><th>項目</th><td>担当</td></tr></table>', text: '' },
    { html: '<img src="x">', text: '画像だけ' }, { text: '# 見出し\n- a\n  - b\n1. c\n- [x] 済み\n> 引用\n---\n```\n# 中\n```\n**太字**と[住所](https://example.com/)' },
    { text: '**強い**語' }, { text: '一行\n二行\n\n三行' }, { text: 'ただの文' }, { text: '' }, { text: many }, { text: deep }, { html: '', text: '|a|b|\n|---|---|\n|c|d|' }];
  for (const x of inputs) assert.deepStrictEqual(app.pasteBlocks(x), PC.pasteBlocks(x), JSON.stringify(x).slice(0, 80));
  for (const n of ['word', 'teams']) assert.deepStrictEqual(app.fromHtml(FIX(n)), PC.fromHtml(FIX(n)));
  assert.deepStrictEqual(app.fromMarkdown('- a\n\t- b'), PC.fromMarkdown('- a\n\t- b'));
  assert.deepStrictEqual(app.fromPlain('a\r\nb'), PC.fromPlain('a\r\nb'));
  // HTML の決まり: <script> の中の「<」+「!--」と「<」+「script」は、閉じる </script> の読み方を変える（後ろの画面が script の文になる）
  const script = HTML.slice(HTML.indexOf('<script>') + '<script>'.length, HTML.lastIndexOf('</script>'));
  assert.ok(!/<!--|<\/?script/i.test(script), '画面の <script> の中に HTML のコメントの頭か script の印がある');
});

test('EK-3（決めたこと 23・25・BQ5 (a)・E8）: Word の形の HTML を貼る → blockPaste の1回（見出し・箇条書き・太字。色は落ちる）で今の行の後ろに入り、カーソルは最後に貼った行の終わり。Ctrl+Z の1回で戻る', T, async () => {
  const l = await openReal({ pa1: PG3() });
  try {
    const before = body(l.page());
    const t = typeIn(l, 'q2', 'あいうえお');
    assert.strictEqual(pasteIn(t, { 'text/html': FIX('word'), 'text/plain': '議題の整理\n太字の文と色の文' }), true, '既定の貼り付けを止めない（HTML のまま入る）');
    await l.drain();
    const want = PC.pasteBlocks({ html: FIX('word'), text: '' }).blocks;
    assert.deepStrictEqual(writes(l), ['blockPaste'], '貼り付けを1つの命令で送らない');
    const [args] = pastes(l);
    assert.deepStrictEqual([args[0], args[1], args[3], args.length], ['pa1', 'q2', 5, 5]);
    assert.strictEqual(R.plainOf(args[2]), 'あいうえお');
    assert.deepStrictEqual(args[4], want);
    const p = l.page();
    assert.deepStrictEqual(p.blocks.map((b) => b.id).slice(0, 2), ['q1', 'q2']);
    assert.strictEqual(p.blocks[p.blocks.length - 1].id, 'q3');
    const got = p.blocks.slice(2, -1);
    assert.deepStrictEqual(got.slice(0, 4).map((b) => [b.type, b.level || 0, b.text]), [['heading', 1, '議題の整理'], ['paragraph', 0, '太字の文と色の文'], ['bullet', 0, '一つ目の項目'], ['bullet', 0, '二つ目の項目']]);
    assert.deepStrictEqual(got[1].rich, [r4('太字の文', 'b'), r4('と色の文')]);
    assert.deepStrictEqual(got[2].children.map((b) => [b.type, b.text]), [['bullet', '子の項目']]);
    assert.ok(!/"(color|bg)"/.test(JSON.stringify(p.blocks)), '色を残した（BQ5 (a)）');
    // 画面: 貼った行が見えて、飾りは span。カーソルは最後に貼った行の終わり
    const ids = rowsOf(l).map((e) => e.dataset.id);
    assert.strictEqual(ids.length, 2 + 10 + 1);
    assert.deepStrictEqual(viewOf(txtOf(l, got[1].id)), [{ tag: 'span', m: 'b', t: '太字の文' }, 'と色の文']);
    const last = got[got.length - 1];
    assert.ok(l.document.activeElement === txtOf(l, last.id), 'カーソルが最後に貼った行に無い');
    assert.deepStrictEqual(l.caret.get(txtOf(l, last.id)), [last.text.length, last.text.length]);
    assert.deepStrictEqual(foreignIn(l), []);
    // Ctrl+Z の1回で、貼る前に戻る
    press(l, Z);
    await l.drain();
    assert.strictEqual(revs(l).length, 1);
    assert.deepStrictEqual(body(l.page()), before);
    assert.deepStrictEqual(rowsOf(l).map((e) => e.dataset.id), ['q1', 'q2', 'q3']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3（決めたこと 24・R66）: Markdown の文（HTML が無い）→ 行に（見出し・箇条書き・太字・字下げは子・番号）。空のテキストの行に貼ると、最初の行がその行になる（R18）', T, async () => {
  const l = await openReal({ pa1: [MANUAL('q1', '前の文'), MANUAL('q2', '')] });
  try {
    const md = '# 決めた事\n- 一つ目\n- **二つ目**\n  - 子\n1. 番号';
    const t = typeIn(l, 'q2', '', 0);
    pasteIn(t, { 'text/plain': md });
    await l.drain();
    assert.deepStrictEqual(writes(l), ['blockPaste']);
    assert.deepStrictEqual(pastes(l)[0][4], PC.fromMarkdown(md).blocks);
    const p = l.page();
    assert.deepStrictEqual(p.blocks.map((b) => [b.type, b.text]), [['paragraph', '前の文'], ['heading', '決めた事'], ['bullet', '一つ目'], ['bullet', '二つ目'], ['numbered', '番号']]);
    assert.strictEqual(p.blocks[1].id, 'q2', '空の行が最初の貼った行にならない（R18）');
    assert.deepStrictEqual(p.blocks[3].rich, [r4('二つ目', 'b')]);
    assert.deepStrictEqual(p.blocks[3].children.map((b) => [b.type, b.text]), [['bullet', '子']]);
    const kid = rowOf(l, p.blocks[3].children[0].id);
    assert.ok(kid && kid.dataset.parent === p.blocks[3].id, '字下げした箇条が子に見えない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3（決めたこと 24）: 1行の型の無い文 → 命令を送らず、行の中のカーソルの所に飾りつきで入る（選んだ所は置き換える）。保存は次の区切りの { rich } の1回', T, async () => {
  const l = await openReal({ pa1: PG3() });
  try {
    const t = typeIn(l, 'q2', 'あいうえお', 2);
    pasteIn(t, { 'text/html': '<meta charset="utf-8"><b style="color:red">大事</b>', 'text/plain': '大事' });
    await l.drain();
    assert.deepStrictEqual(writes(l), [], '1行の文で命令を送った');
    assert.deepStrictEqual(viewOf(t), ['あい', { tag: 'span', m: 'b', t: '大事' }, 'うえお']);
    assert.deepStrictEqual(l.caret.get(t), [4, 4]);
    // Markdown の1行（文中の飾り）も行の中へ。選んだ所は置き換える
    l.caret.set(t, 6, 7);
    pasteIn(t, { 'text/plain': '**強い**語' });
    await l.drain();
    assert.deepStrictEqual(writes(l), []);
    assert.deepStrictEqual(viewOf(t), ['あい', { tag: 'span', m: 'b', t: '大事' }, 'うえ', { tag: 'span', m: 'b', t: '強い' }, '語']);
    assert.deepStrictEqual(l.caret.get(t), [9, 9]);
    // 素の1行は打った文字と同じ（前の文字の飾りを引き継ぐ）
    pasteIn(t, { 'text/plain': 'ん' });
    assert.strictEqual(t.textContent, 'あい大事うえ強い語ん');
    t.onblur();
    await l.drain();
    assert.deepStrictEqual(updates(l), [['pa1', 'q2', { rich: [r4('あい'), r4('大事', 'b'), r4('うえ'), r4('強い', 'b'), r4('語ん')] }]]);
    assert.deepStrictEqual(writes(l), ['blockUpdate']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3（決めたこと 26）: Ctrl+Shift+V → 変換せず素の文字だけ（改行は行の中・HTML と Markdown の印はそのまま）。次のふつうの貼り付けは変換する', T, async () => {
  const l = await openReal({ pa1: PG3() });
  try {
    const t = typeIn(l, 'q2', 'あいうえお');
    assert.strictEqual(l.key(PLAIN_V, t).defaultPrevented, false, 'Ctrl+Shift+V の既定（貼り付け）を止めた');
    assert.strictEqual(pasteIn(t, { 'text/plain': '# 見\r\n- a', 'text/html': '<h1>見</h1><ul><li>a</li></ul>' }), true);
    await l.drain();
    assert.deepStrictEqual(writes(l), []);
    assert.strictEqual(t.textContent, 'あいうえお# 見\n- a');
    assert.deepStrictEqual(viewOf(t), ['あいうえお# 見\n- a']);
    // 次の Ctrl+V はふつうの貼り付け（変換する）
    l.key({ key: 'v', code: 'KeyV', ctrlKey: true }, t);
    pasteIn(t, { 'text/plain': '# 見\n- a' });
    await l.drain();
    assert.deepStrictEqual(writes(l), ['blockPaste']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3（K-25・R111 (3)）: 選んだ文字の上に URL を貼る → 文字は置き換わらずリンク（HTML のリンクがあっても）。命令は送らない', T, async () => {
  const l = await openReal({ pa1: PG3() });
  try {
    const t = selectIn(l, 'q2', 1, 3);
    pasteIn(t, { 'text/plain': 'https://example.com/a', 'text/html': '<a href="https://example.com/a">https://example.com/a</a>' });
    await l.drain();
    assert.strictEqual(t.textContent, 'あいうえお');
    assert.deepStrictEqual(viewOf(t), ['あ', { tag: 'span', link: 'https://example.com/a', t: 'いう' }, 'えお']);
    assert.deepStrictEqual(writes(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3（決めたこと 25・F102）: 大きすぎる貼り付け（2,001 行・子孫で 2,001 行）→ 知らせだけで、命令は0・行の文は変わらない', T, async () => {
  const l = await openReal({ pa1: PG3() });
  try {
    const t = typeIn(l, 'q2', 'あいうえお');
    pasteIn(t, { 'text/plain': Array.from({ length: 2001 }, (_, i) => `行${i}`).join('\n') });
    await l.drain();
    assert.strictEqual(toastOf(l), PASTE_TOO_BIG);
    $(l, 'toast').textContent = '';
    pasteIn(t, { 'text/plain': ['- 親', ...Array.from({ length: 2000 }, (_, i) => `  - 子${i}`)].join('\n') });
    await l.drain();
    assert.strictEqual(toastOf(l), PASTE_TOO_BIG);
    assert.deepStrictEqual(writes(l), []);
    assert.strictEqual(t.textContent, 'あいうえお');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3（決めたこと 24・R126）: 変換中（compositionstart の後）の貼り付けは変換を決めない（命令を送らず、素の文字を行の中に）', T, async () => {
  const l = await openReal({ pa1: PG3() });
  try {
    const t = typeIn(l, 'q2', 'あいうえお');
    t.dispatchEvent({ type: 'compositionstart' });
    assert.strictEqual(pasteIn(t, { 'text/plain': '# 見\n- a', 'text/html': '<h1>見</h1><ul><li>a</li></ul>' }), true);
    await l.drain();
    assert.deepStrictEqual(writes(l), []);
    assert.strictEqual(t.textContent, 'あいうえお# 見\n- a');
    assert.deepStrictEqual(viewOf(t), ['あいうえお# 見\n- a']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3・SEC2（F102）: 行の DOM に貼った HTML の要素が無い（img・onerror・onclick・script・iframe・javascript: のリンク。行にしても、1行で行の中に入れても）', T, async () => {
  const l = await openReal({ pa1: PG3() });
  try {
    const bad = '<p>あ<img src="x" onerror="steal()"><b onclick="x()">太</b><script>秘</script><a href="javascript:alert(1)">リンク</a></p><p>二行目<iframe src="https://example.com/f">秘</iframe><svg><circle/></svg><font color="red">赤</font></p>';
    const t = typeIn(l, 'q2', 'あいうえお');
    pasteIn(t, { 'text/html': bad, 'text/plain': 'あ太リンク\n二行目赤' });
    await l.drain();
    assert.deepStrictEqual(writes(l), ['blockPaste']);
    assert.deepStrictEqual(foreignIn(l), []);
    const p = l.page();
    assert.deepStrictEqual(p.blocks.slice(2, 4).map((b) => b.text), ['あ太リンク', '二行目赤']);
    assert.ok(!JSON.stringify(p.blocks).includes('秘') && !JSON.stringify(p.blocks).includes('javascript'), '捨てる中身か危ないリンクが入った');
    assert.ok(!rowsOf(l).some((e) => e.textContent.includes('秘')));
    // 1行（行の中に入れる）でも
    const t1 = typeIn(l, 'q1', '前の文');
    pasteIn(t1, { 'text/html': '<span onclick="x()"><img src="x" onerror="y()">安<b>全</b><a href="javascript:z()">字</a></span>', 'text/plain': '安全字' });
    await l.drain();
    assert.deepStrictEqual(writes(l), ['blockPaste']);
    assert.deepStrictEqual(viewOf(t1), ['前の文安', { tag: 'span', m: 'b', t: '全' }, '字']);
    assert.deepStrictEqual(foreignIn(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3・R66・BQ30 (a)（第4版）: 開いたトグルの文の終わりで Markdown の3行を貼る → blockPaste の inside が真で、貼った行はトグルの中（最初の子）に見える。文のある行の頭で貼る → afterId は画面で上に見えている行で、今の行はそのまま', T, async () => {
  const l = await openReal({ pa1: [MANUAL('q1', '前の文'), { id: 'tg', type: 'toggle', text: 'トグル', citeState: 'manual', cites: [], children: [MANUAL('k1', '子の文')] }, MANUAL('q2', 'あいうえお')] });
  try {
    const t = typeIn(l, 'tg', 'トグル');
    pasteIn(t, { 'text/plain': '- 一\n- 二\n- 三' });
    await l.drain();
    const [a1] = pastes(l);
    assert.deepStrictEqual([a1[1], a1[3], a1[5], a1[6]], ['tg', 3, undefined, true], 'inside が真でない');
    const tg = l.page().blocks.find((b) => b.id === 'tg');
    assert.deepStrictEqual(tg.children.map((b) => b.text), ['一', '二', '三', '子の文']);
    const kids = rowsOf(l).filter((e) => e.dataset.parent === 'tg').map((e) => e.querySelector('.txt').textContent);
    assert.deepStrictEqual(kids, ['一', '二', '三', '子の文'], '貼った行がトグルの中に見えない');
    // 文のある行の頭（BQ30 (a)）
    const t2 = typeIn(l, 'q2', 'あいうえお', 0);
    pasteIn(t2, { 'text/plain': '上一\n上二' });
    await l.drain();
    const a2 = pastes(l)[1];
    assert.deepStrictEqual([a2[1], a2[3], a2[5], a2.length], ['q2', 0, 'tg', 6], 'afterId が画面で上に見えている最上位の行でない');
    const p = l.page();
    assert.deepStrictEqual(p.blocks.map((b) => b.text), ['前の文', 'トグル', '上一', '上二', 'あいうえお']);
    assert.strictEqual(p.blocks[4].id, 'q2', '今の行の ID が替わった');
    // いちばん上の行の頭なら頭（''）
    const t3 = typeIn(l, 'q1', '前の文', 0);
    pasteIn(t3, { 'text/plain': '頭一\n頭二' });
    await l.drain();
    assert.strictEqual(pastes(l)[2][5], '');
    assert.deepStrictEqual(l.page().blocks.map((b) => b.text).slice(0, 3), ['頭一', '頭二', '前の文']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3・BQ31・BQ32（2026-10-30 の持ち主の答え）: 開いたトグルの文の途中で Markdown の2行を貼る → blockPaste の inside が真で、貼った行と後ろの文の行（テキスト）がトグルの最初の子に見える。子のある箇条書きの途中も子の頭。見出しの文の途中で貼る → 後ろの文の行は箇条書き（Enter と同じ）', T, async () => {
  const l = await openReal({ pa1: [MANUAL('q1', '前の文'), { id: 'tg', type: 'toggle', text: 'トグル文', citeState: 'manual', cites: [], children: [MANUAL('k1', '子の文')] }, MANUAL('hd', '見出しの文', { type: 'heading', level: 2 }), MANUAL('bp', '親の文', { type: 'bullet', children: [MANUAL('k2', '孫の文')] })] });
  try {
    const t = typeIn(l, 'tg', 'トグル文', 3);
    pasteIn(t, { 'text/plain': '- 一\n- 二' });
    await l.drain();
    const [a1] = pastes(l);
    assert.deepStrictEqual([a1[1], a1[3], a1[5], a1[6]], ['tg', 3, undefined, true], '文の途中で inside が真でない');
    const tg = l.page().blocks.find((b) => b.id === 'tg');
    assert.deepStrictEqual([tg.text, ...tg.children.map((b) => `${b.type}:${b.text}`)], ['トグル', 'bullet:一', 'bullet:二', 'paragraph:文', 'paragraph:子の文']);
    const kids = rowsOf(l).filter((e) => e.dataset.parent === 'tg').map((e) => e.querySelector('.txt').textContent);
    assert.deepStrictEqual(kids, ['一', '二', '文', '子の文'], '貼った行と後ろの文の行がトグルの中に見えない');
    // 子のある箇条書きの文の途中: 貼った行と後ろの文の行（箇条書き）が子の頭
    const c = typeIn(l, 'bp', '親の文', 1);
    pasteIn(c, { 'text/plain': '貼一\n貼二' });
    await l.drain();
    assert.deepStrictEqual([pastes(l)[1][1], pastes(l)[1][6]], ['bp', true], '子のある行の文の途中で inside が真でない');
    const bp = l.page().blocks.find((b) => b.id === 'bp');
    assert.deepStrictEqual([bp.text, ...bp.children.map((b) => `${b.type}:${b.text}`)], ['親', 'paragraph:貼一', 'paragraph:貼二', 'bullet:の文', 'paragraph:孫の文']);
    const h = typeIn(l, 'hd', '見出しの文', 3);
    pasteIn(h, { 'text/plain': '上一\n上二' });
    await l.drain();
    const a2 = pastes(l)[2];
    assert.deepStrictEqual([a2[1], a2[3], a2.length], ['hd', 3, 5], '子の無い見出しで afterId か inside を送った');
    assert.deepStrictEqual(l.page().blocks.slice(2, 6).map((b) => `${b.type}:${b.text}`), ['heading:見出し', 'paragraph:上一', 'paragraph:上二', 'bullet:の文']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- EK-2 直し（2026-10-29 の点検。R129）
test('EK-2 直し（I2・R129）: 貼った後のページが上限を越えて DB が too-big で断ると、画面は貼り付けの大きすぎる知らせを出し、行の文は元のまま', T, async () => {
  const l = await openReal({ pa1: PG3() }, { returns: { blockPaste: () => Promise.reject(new Error('too-big')) } });
  try {
    const t = typeIn(l, 'q2', 'あいうえお', 2);
    pasteIn(t, { 'text/plain': '一\n二' });
    await l.drain();
    assert.strictEqual(l.called('blockPaste').length, 1);
    assert.strictEqual(toastOf(l), PASTE_TOO_BIG);
    assert.strictEqual(t.textContent, 'あいうえお', '断られた貼り付けで行の文が欠けたまま');
    t.onblur();
    await l.drain();
    assert.deepStrictEqual(updates(l), [], '断られた後に同じ文を保存し直した');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- EK-4（決めたこと 28〜31・R19〜R22・R64・R65・G2・G4。E9）: 複数の行の選択
const selIds = (l) => rowsOf(l).filter((e) => e.getAttribute('aria-selected') === 'true').map((e) => e.dataset.id);
const boxKey = (l, o) => l.key(o, $(l, 'pNote'));
const isBox = (l) => l.document.activeElement === $(l, 'pNote');
const rowEsc = (l, id) => { const t = txtOf(l, id); t.focus(); l.caret.set(t, t.textContent.length); return l.key({ key: 'Escape' }, t); };
const ids = (l) => rowsOf(l).map((e) => e.dataset.id);
const MANYW = ['blocksRemove', 'blocksMove', 'blocksDuplicate', 'blocksTurnInto', 'blocksSetColor', 'blockPaste', 'blockRemove', 'blockMove', 'blockDuplicate', 'blockTurnInto', 'blockUpdate', 'blockInsert'];
const manyW = (l) => MANYW.flatMap((n) => l.called(n).map(() => n));
const PG5 = () => [MANUAL('p1', '一の行'), MANUAL('p2', '二の行'), MANUAL('p3', '三の行'),
  { id: 'tg', type: 'toggle', text: '閉じたトグル', citeState: 'manual', cites: [], open: false, children: [MANUAL('k1', '隠れた子')] }, MANUAL('p4', '四の行')];

test('EK-4（決めたこと 28・29・R19・R64）: 行で Esc → その行が選ばれ（aria-selected・フォーカスは欄の箱）、Shift+↓ で広がる（閉じたトグルの中は飛ばす）・↑↓ で替える・Esc で外れて ⠿ へ・Enter で編集に戻る・Tab で欄の外の次の部品へ・Shift+Tab で［AI 要約］のタブ', T, async () => {
  const l = await openReal({ pa1: PG5() });
  try {
    const after = l.document.createElement('button'); after.textContent = '欄の外';
    $(l, 'pNote').parentNode.insertBefore(after, $(l, 'pNote').nextSibling);
    const e1 = rowEsc(l, 'p2');
    assert.strictEqual(e1.defaultPrevented, true);
    assert.deepStrictEqual(selIds(l), ['p2'], '行の Esc で行が選ばれない（ek-sel-esc）');
    assert.ok(isBox(l), '選んだときのフォーカスが欄の箱でない');
    for (let i = 0; i < 3; i++) assert.strictEqual(boxKey(l, { key: 'ArrowDown', shiftKey: true }).defaultPrevented, true);
    assert.deepStrictEqual(selIds(l), ['p2', 'p3', 'tg', 'p4'], 'Shift+↓ で閉じたトグルの中を飛ばして広がらない');
    boxKey(l, { key: 'ArrowUp', shiftKey: true });
    assert.deepStrictEqual(selIds(l), ['p2', 'p3', 'tg']);
    boxKey(l, { key: 'ArrowUp' });
    assert.deepStrictEqual(selIds(l), ['p3'], '↑ で選ぶ行が替わらない');
    boxKey(l, { key: 'Enter' });
    assert.deepStrictEqual(selIds(l), []);
    assert.ok(l.document.activeElement === txtOf(l, 'p3'), 'Enter で行の編集に戻らない');
    assert.deepStrictEqual(l.caret.get(txtOf(l, 'p3')), [3, 3]);
    rowEsc(l, 'p1');
    boxKey(l, { key: 'ArrowDown', shiftKey: true });
    const e2 = boxKey(l, { key: 'Escape' });
    assert.strictEqual(e2.defaultPrevented, true, '一覧の選択の Esc まで届く');
    assert.deepStrictEqual(selIds(l), [], 'Esc で選びが外れない');
    assert.ok(l.document.activeElement === rowOf(l, 'p1').querySelector('.grip'), 'Esc で選んでいた最初の行の ⠿ へ移らない（R64 (4)）');
    rowEsc(l, 'p2');
    const tab = boxKey(l, { key: 'Tab' });
    assert.strictEqual(tab.defaultPrevented, true);
    assert.ok(l.document.activeElement === after, '選んでいるときの Tab で欄の外へ出ない（R19・ek-sel-exit）');
    assert.deepStrictEqual(selIds(l), []);
    rowEsc(l, 'p2');
    boxKey(l, { key: 'Tab', shiftKey: true });
    assert.ok(l.document.activeElement === $(l, 'paneBtnNote'), 'Shift+Tab で［AI 要約］のタブへ行かない');
    assert.deepStrictEqual(manyW(l), [], '選ぶだけで命令を送った');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-4（K-14）: Shift+クリックで編集していた行（選んでいれば anchor）から範囲を選ぶ・Alt+Shift+クリックで1つずつ足す・外す。同じ行の中の Shift+クリックは文字の選びのまま', T, async () => {
  const l = await openReal({ pa1: PG5() });
  try {
    const down = (id, o) => { const r = { defaultPrevented: false }; $(l, 'pNote').dispatchEvent({ type: 'mousedown', target: txtOf(l, id), shiftKey: true, preventDefault() { r.defaultPrevented = true; }, ...o }); return r; };
    typeIn(l, 'p1', '一の行を直した');
    assert.strictEqual(down('p1').defaultPrevented, false, '同じ行の中の Shift+クリックを止めた');
    assert.deepStrictEqual(selIds(l), []);
    assert.strictEqual(down('p3').defaultPrevented, true);
    assert.deepStrictEqual(selIds(l), ['p1', 'p2', 'p3']);
    await l.drain();
    assert.deepStrictEqual(updates(l), [['pa1', 'p1', { text: '一の行を直した' }]], '選ぶ前に打った文を保存しない');
    down('p2', { altKey: true });
    assert.deepStrictEqual(selIds(l), ['p1', 'p3'], 'Alt+Shift+クリックで外れない');
    down('p4', { altKey: true });
    assert.deepStrictEqual(selIds(l), ['p1', 'p3', 'p4'], 'Alt+Shift+クリックで足せない');
    down('tg');
    assert.deepStrictEqual(selIds(l), ['p1', 'p2', 'p3', 'tg'], 'Shift+クリックの範囲が anchor から');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-4（P-01・R22）: 行の外の余白から引っ張ると通った行を選ぶ（座標の継ぎ目）。行の文から引っ張っても同じ行の中は文字の選び、別の行へ出ると行の選びに替わる（打った文は保存）', T, async () => {
  const l = await openReal({ pa1: PG5() });
  try {
    const box = $(l, 'pNote');
    rowsOf(l).forEach((e, i) => { e._rect = { top: i * 10, height: 10, left: 40, width: 200 }; });
    const ptr = (type, target, y) => box.dispatchEvent({ type, target, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
    ptr('pointerdown', box, 15);
    assert.deepStrictEqual(selIds(l), [], '押しただけで選んだ');
    ptr('pointermove', box, 25);
    ptr('pointermove', box, 35);
    assert.deepStrictEqual(selIds(l), ['p2', 'p3', 'tg'], '余白から引っ張って通った行が選ばれない');
    ptr('pointerup', box, 35);
    ptr('pointermove', box, 45);
    assert.deepStrictEqual(selIds(l), ['p2', 'p3', 'tg'], '離した後も選びが動く');
    const t = typeIn(l, 'p1', '一の行に打った');
    ptr('pointerdown', t, 5);
    assert.deepStrictEqual(selIds(l), [], '行を押すと前の選びが外れない');
    ptr('pointermove', t, 8);
    assert.deepStrictEqual(selIds(l), [], '1つの行の中の引っ張りで行を選んだ');
    ptr('pointermove', t, 22);
    assert.deepStrictEqual(selIds(l), ['p1', 'p2', 'p3'], '別の行へ出ても行の選びに替わらない（R22）');
    await l.drain();
    assert.deepStrictEqual(updates(l), [['pa1', 'p1', { text: '一の行に打った' }]]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-4（決めたこと 30・BQ6 (a)）: 選んで Backspace → blocksRemove の1回（確かめない・blockRemove は0）。フォーカスは上の行の終わり。Ctrl+Z の1回で戻る。Delete も同じ', T, async () => {
  const l = await openReal({ pa1: PG5() });
  try {
    const before = l.page();
    rowEsc(l, 'p2');
    boxKey(l, { key: 'ArrowDown', shiftKey: true });
    const ev = boxKey(l, { key: 'Backspace' });
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    assert.deepStrictEqual(manyW(l), ['blocksRemove'], '1回の blocksRemove でない（ek-multi-cmd）');
    assert.deepStrictEqual(l.called('blocksRemove')[0].args, ['pa1', ['p2', 'p3']]);
    assert.deepStrictEqual(ids(l), ['p1', 'tg', 'p4']);
    assert.ok(l.document.activeElement === txtOf(l, 'p1'), 'フォーカスが上の行へ行かない');
    assert.deepStrictEqual(selIds(l), []);
    press(l, Z);
    await l.drain();
    assert.strictEqual(revs(l).length, 1, 'Ctrl+Z が1回の editRevert でない');
    assert.deepStrictEqual(body(l.page()), body(before), 'Ctrl+Z の1回で戻らない');
    rowEsc(l, 'p4');
    boxKey(l, { key: 'Delete' });
    await l.drain();
    assert.deepStrictEqual(ids(l), ['p1', 'p2', 'p3', 'tg']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-4（決めたこと 30・G4）: 選んで Ctrl+D・Ctrl+Shift+↓・Ctrl+Shift+2・Ctrl+Shift+7・Ctrl+/ の［色 ▸］がそれぞれ1つの命令（1歩）。答えの後も同じ行（複製は写し）を選んだまま', T, async () => {
  const l = await openReal({ pa1: PG5() });
  try {
    rowEsc(l, 'p2');
    boxKey(l, { key: 'ArrowDown', shiftKey: true });
    let n = l.steps.length;
    boxKey(l, { key: 'd', code: 'KeyD', ctrlKey: true });
    await l.drain();
    const dup = l.called('blocksDuplicate');
    assert.deepStrictEqual([dup.length, dup[0].args], [1, ['pa1', ['p2', 'p3']]]);
    const copies = ids(l).slice(3, 5);
    assert.deepStrictEqual(copies.map((id) => txtOf(l, id).textContent), ['二の行', '三の行'], '写しが選んだ行の後ろに無い');
    assert.deepStrictEqual(selIds(l), copies, '複製の後に写しを選んでいない');
    assert.strictEqual(l.steps.length, n + 1);
    boxKey(l, { key: 'Backspace' });
    await l.drain();
    rowEsc(l, 'p2');
    boxKey(l, { key: 'ArrowDown', shiftKey: true });
    n = l.steps.length;
    boxKey(l, { key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true, shiftKey: true });
    await l.drain();
    assert.deepStrictEqual(l.called('blocksMove').map((c) => c.args), [['pa1', ['p2', 'p3'], 'tg', undefined]]);
    assert.deepStrictEqual(l.page().blocks.map((b) => b.id), ['p1', 'tg', 'p2', 'p3', 'p4']);
    assert.deepStrictEqual(selIds(l), ['p2', 'p3'], '動かした後に選びが外れた');
    boxKey(l, { key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, shiftKey: true });
    await l.drain();
    assert.deepStrictEqual(l.page().blocks.map((b) => b.id), ['p1', 'p2', 'p3', 'tg', 'p4']);
    boxKey(l, { key: '"', code: 'Digit2', ctrlKey: true, shiftKey: true });
    await l.drain();
    assert.deepStrictEqual(l.called('blocksTurnInto').map((c) => c.args), [['pa1', ['p2', 'p3'], 'heading', 2, undefined]]);
    assert.deepStrictEqual(['p2', 'p3'].map((id) => [rowOf(l, id)._b.type, rowOf(l, id)._b.level]), [['heading', 2], ['heading', 2]]);
    boxKey(l, { key: "'", code: 'Digit7', ctrlKey: true, shiftKey: true });
    await l.drain();
    assert.deepStrictEqual(l.called('blocksTurnInto')[1].args, ['pa1', ['p2', 'p3'], 'toggle', undefined, undefined], 'Ctrl+Shift+7 でまとめてトグルにならない（G4）');
    // Ctrl+/ → 選んだ行のメニュー → ［色 ▸］ → 赤
    boxKey(l, { key: '/', code: 'Slash', ctrlKey: true });
    const menu = $(l, 'pNote').querySelector('.blockmenu');
    assert.ok(menu, 'Ctrl+/ で選んだ行のメニューが出ない');
    menu.querySelectorAll('.mitem').find((x) => x.textContent === '色 ▸').onclick();
    $(l, 'pNote').querySelectorAll('.blockmenu.sub .mitem').find((x) => x.dataset.key === 'red').onclick();
    await l.drain();
    assert.deepStrictEqual(l.called('blocksSetColor').map((c) => c.args), [['pa1', ['p2', 'p3'], 'red']]);
    assert.deepStrictEqual(['p2', 'p3', 'p1'].map((id) => rowOf(l, id).getAttribute('data-bcolor')), ['red', 'red', null]);
    assert.strictEqual(l.steps.length, n + 5, 'どの操作も1歩でない');
    // ［変換 ▸］の区切り線は、文のある行を選んでいれば灰色
    boxKey(l, { key: '/', code: 'Slash', ctrlKey: true });
    $(l, 'pNote').querySelector('.blockmenu').querySelectorAll('.mitem').find((x) => x.textContent === '変換 ▸').onclick();
    const d = $(l, 'pNote').querySelectorAll('.blockmenu.sub .mitem').find((x) => x.dataset.key === 'divider');
    assert.strictEqual(d.getAttribute('aria-disabled'), 'true');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-4（R20）: 選んでいる間に文字・空白を打っても何もしない（既定を止め、命令は0・行はそのまま）', T, async () => {
  const l = await openReal({ pa1: PG5() });
  try {
    rowEsc(l, 'p2');
    for (const key of ['a', 'あ', ' ', 'x']) assert.strictEqual(boxKey(l, { key, code: 'KeyA' === key ? 'KeyA' : '' }).defaultPrevented, true, key);
    await l.drain();
    assert.deepStrictEqual(manyW(l), [], '選んで打つと命令を送った（ek-sel-type）');
    assert.deepStrictEqual(ids(l), ['p1', 'p2', 'p3', 'tg', 'p4']);
    assert.deepStrictEqual(selIds(l), ['p2']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-4（決めたこと 30・SEC2）: 選んで Ctrl+C → text/plain は blocksMarkdown（子も）・text/html は決まった形で文字が逃がしてある。Ctrl+X は置いてから blocksRemove の1回。行の文の写しは今のまま', T, async () => {
  const blocks = [{ id: 'h', type: 'heading', level: 2, text: '見出し<b>&', citeState: 'manual', cites: [] },
    { id: 'u', type: 'bullet', text: '太字と<script>', rich: [{ t: '太字', m: ['b'] }, { t: 'と<script>', m: [] }], citeState: 'manual', cites: [], children: [MANUAL('c', '子の"行"')] }, MANUAL('z', '残る行')];
  const l = await openReal({ pa1: blocks });
  try {
    rowEsc(l, 'h');
    boxKey(l, { key: 'ArrowDown', shiftKey: true });
    assert.deepStrictEqual(selIds(l), ['h', 'u', 'c']);
    const put = {};
    const ev = l.key({ type: 'copy', clipboardData: { setData: (k, v) => { put[k] = v; } } }, $(l, 'pNote'));
    assert.strictEqual(ev.defaultPrevented, true);
    const page = l.page();
    assert.strictEqual(put['text/plain'], E.blocksMarkdown(page.blocks.slice(0, 2)).replace(/^\n+/, ''));
    assert.match(put['text/plain'], /^## 見出し<b>&\n- \*\*太字\*\*と<script>\n  子の"行"$/);
    assert.strictEqual(put['text/html'], '<h2>見出し&lt;b&gt;&amp;</h2><ul><li><b>太字</b>と&lt;script&gt;<p>子の&quot;行&quot;</p></li></ul>');
    assert.deepStrictEqual(manyW(l), [], '写すだけで命令を送った');
    // 貼り戻すと同じ形（pasteConvert の写しで読める）
    const back = PC.pasteBlocks({ html: put['text/html'], text: put['text/plain'] });
    assert.deepStrictEqual(back.blocks.map((b) => [b.type, (b.children || []).length]), [['heading', 0], ['bullet', 1]]);
    const cut = {};
    l.key({ type: 'cut', clipboardData: { setData: (k, v) => { cut[k] = v; } } }, $(l, 'pNote'));
    await l.drain();
    assert.strictEqual(cut['text/plain'], put['text/plain']);
    assert.deepStrictEqual(l.called('blocksRemove').map((c) => c.args), [['pa1', ['h', 'u']]]);
    assert.deepStrictEqual(ids(l), ['z']);
    // 行の文にフォーカスがあるときの写しは受けない（既定のまま）
    const t = typeIn(l, 'z', '残る行', 0, 2);
    const own = {};
    const e2 = l.key({ type: 'copy', clipboardData: { setData: (k, v) => { own[k] = v; } } }, t);
    assert.deepStrictEqual([e2.defaultPrevented, Object.keys(own)], [false, []]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-4（決めたこと 30・27）: 選んで Ctrl+V → 選んだ最後の行の後ろへ blockPaste の1回（文の終わり・子の中には入れない）。カーソルは最後に貼った行', T, async () => {
  const l = await openReal({ pa1: [MANUAL('p1', '一の行'), MANUAL('p2', '二の行', { children: [MANUAL('k', '子')] }), MANUAL('p3', '三の行')] });
  try {
    rowEsc(l, 'p1');
    boxKey(l, { key: 'ArrowDown', shiftKey: true });
    assert.deepStrictEqual(selIds(l), ['p1', 'p2', 'k']);
    const ev = l.key({ type: 'paste', clipboardData: { getData: (k) => (k === 'text/plain' ? '- 貼一\n- 貼二' : '') } }, $(l, 'pNote'));
    await l.drain();
    assert.strictEqual(ev.defaultPrevented, true);
    const [a] = pastes(l);
    assert.deepStrictEqual([pastes(l).length, a[1], a[3], a[5], a[6]], [1, 'p2', 3, undefined, undefined], '選んだ最後の行の文の終わりに、子の外へ貼らない');
    assert.deepStrictEqual(l.page().blocks.map((b) => b.text), ['一の行', '二の行', '貼一', '貼二', '三の行']);
    assert.ok(l.document.activeElement === txtOf(l, l.page().blocks[3].id), 'カーソルが最後に貼った行に無い');
    assert.deepStrictEqual(selIds(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-4（決めたこと 28・44・EQ22 (a)）: 選んでいる間の保存の page:open は前に出さない（ek-sel-busy）。ページを替えると選びが外れる', T, async () => {
  const l = await openReal({ pa1: PG5(), pb2: [MANUAL('x1', '別のページの行')] });
  try {
    rowEsc(l, 'p2');
    l.fire('onPageOpen', 'pb2', { saved: true });
    await l.drain();
    const active = $(l, 'tabbar').querySelector('.tabitem.active');
    assert.strictEqual(active ? active.getAttribute('data-key') : '', 'page:pa1', '選んでいる間に保存した議事録が前に出た');
    assert.deepStrictEqual(selIds(l), ['p2']);
    l.fire('onPageOpen', 'pb2');
    await l.drain();
    assert.deepStrictEqual(ids(l), ['x1']);
    l.fire('onPageOpen', 'pa1');
    await l.drain();
    assert.deepStrictEqual(selIds(l), [], 'ページを替えても選びが残った');
    boxKey(l, { key: 'Backspace' });
    await l.drain();
    assert.deepStrictEqual(manyW(l), [], '外れた選びで命令を送った');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-4（R21）: Ctrl+A は1回目は行の文字（既定のまま）・文字が全部選ばれている・空の行ではその行を選ぶ・もう1回でページの全部の行', T, async () => {
  const l = await openReal({ pa1: [...PG5(), MANUAL('e', '')] });
  try {
    const A = { key: 'a', code: 'KeyA', ctrlKey: true };
    let t = typeIn(l, 'p2', '二の行', 1);
    assert.strictEqual(l.key(A, t).defaultPrevented, false, '1回目の Ctrl+A を止めた');
    assert.deepStrictEqual(selIds(l), []);
    t = typeIn(l, 'p2', '二の行', 0, 3);
    assert.strictEqual(l.key(A, t).defaultPrevented, true);
    assert.deepStrictEqual(selIds(l), ['p2'], '文字が全部選ばれた行の Ctrl+A で行を選ばない');
    assert.strictEqual(boxKey(l, A).defaultPrevented, true);
    assert.deepStrictEqual(selIds(l), ['p1', 'p2', 'p3', 'tg', 'p4', 'e'], 'もう1回の Ctrl+A で全部の行を選ばない');
    boxKey(l, { key: 'Escape' });
    t = typeIn(l, 'e', '');
    l.key(A, t);
    assert.deepStrictEqual(selIds(l), ['e'], '空の行の Ctrl+A で行を選ばない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ⠿ で引っ張って落とす（stage131.nest.app の dragTo と同じ形: 行の高さ 10・掴んだ所の clientX は 100）
function dragRow(l, id, clientY, clientX, o = {}) {
  const box = $(l, 'pNote');
  rowsOf(l).forEach((e, i) => { e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: 0, right: 100, width: 100 }); });
  rowOf(l, id).ondragstart({ dataTransfer: { setData() {}, effectAllowed: '' }, clientX: 100 });
  box.ondragover({ preventDefault() {}, clientY, clientX, dataTransfer: {} });
  return box.ondrop({ preventDefault() {}, clientY, clientX, ...o });
}

test('EK-4（決めたこと 30・31・R65）: 選んだ行の ⠿ を引っ張ると blocksMove の1回（画面の順のまま・選んだまま）。Alt なら blocksDuplicate。AI の節の見出しを選んで子の所へ引っ張っても子にならない', T, async () => {
  const head = { id: 'h', type: 'heading', level: 2, text: 'その他の話', cites: [] };
  const l = await openReal({ pa1: [MANUAL('p1', '一の行'), MANUAL('p2', '二の行'), MANUAL('p3', '三の行'), MANUAL('p4', '四の行'), head] });
  try {
    rowEsc(l, 'p1');
    boxKey(l, { key: 'ArrowDown', shiftKey: true });
    // 見えている行: p1 p2 p3 p4 h（行の上端 0・10・20・30・40）。選んだ p1・p2 を外すと p3 p4 h。p4 の下（h の上半分）へ
    await dragRow(l, 'p1', 4 * 10 + 2, 100);
    await l.drain();
    assert.deepStrictEqual(l.called('blocksMove').map((c) => c.args), [['pa1', ['p1', 'p2'], 'p4', undefined]]);
    assert.deepStrictEqual(l.page().blocks.map((b) => b.id), ['p3', 'p4', 'p1', 'p2', 'h']);
    assert.deepStrictEqual(selIds(l), ['p1', 'p2']);
    await dragRow(l, 'p2', 0, 100, { altKey: true });
    await l.drain();
    assert.deepStrictEqual(l.called('blocksDuplicate').map((c) => c.args), [['pa1', ['p1', 'p2'], '', undefined]]);
    boxKey(l, { key: 'Escape' });
    // AI の節の見出し h を選び、p1 の下へ右へずらして落とす → 子にならない（afterId だけ）
    rowEsc(l, 'h');
    l.calls.length = 0;
    const at = ids(l).indexOf('p1');   // h を外した並びで p1 の次の行の上半分（その行の上端は at + 1 番目）
    await dragRow(l, 'h', (at + 1) * 10 + 2, 124);
    await l.drain();
    const mv = l.called('blocksMove').map((c) => c.args);
    assert.deepStrictEqual(mv, [['pa1', ['h'], 'p1', undefined]], 'AI の節の見出しを子にする置き場を送った');
    assert.strictEqual(rowOf(l, 'h').dataset.depth, '0');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- EK-3 直し（2026-10-30 の点検。R138・R139・R141・R142）
test('EK-3 直し（R138・決めたこと 26）: Ctrl+Shift+V は素の文字だけ。URL を選んだ文字に貼っても、リンクにせず文字を置き換える（ふつうの貼り付けは今どおりリンク）', T, async () => {
  const l = await openReal({ pa1: PG3() });
  try {
    let t = typeIn(l, 'q2', 'あいうえお', 0, 2);
    l.key(PLAIN_V, t);
    pasteIn(t, { 'text/plain': 'https://example.invalid/a' });
    assert.deepStrictEqual(viewOf(t), ['https://example.invalid/aうえお'], 'Ctrl+Shift+V で URL を選んだ文字に貼るとリンクになった');
    t = typeIn(l, 'q3', '後の文', 0, 1);
    pasteIn(t, { 'text/plain': 'https://example.invalid/b' });
    assert.deepStrictEqual(viewOf(t), [{ tag: 'span', link: 'https://example.invalid/b', t: '後' }, 'の文']);
    assert.deepStrictEqual(writes(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3 直し（R138・R126 (5)）: 区切り線の行で Ctrl+Shift+V → 下に素の文字の行（改行は行の中のまま）を blockPaste の1回で足す', T, async () => {
  const l = await openReal({ pa1: [MANUAL('q1', '前の文'), { id: 'dv', type: 'divider', text: '', citeState: 'manual', cites: [] }, MANUAL('q3', '後の文')] });
  try {
    const t = txtOf(l, 'dv');
    t.focus();
    l.key(PLAIN_V, t);
    pasteIn(t, { 'text/plain': '- 一\n二' });
    await l.drain();
    assert.deepStrictEqual(pastes(l).map((a) => [a[1], a[3], a[4]]), [['dv', 0, [{ type: 'paragraph', rich: [{ t: '- 一\n二', m: [] }] }]]]);
    assert.deepStrictEqual(l.page().blocks.map((b) => [b.type, b.text]), [['paragraph', '前の文'], ['divider', ''], ['paragraph', '- 一\n二'], ['paragraph', '後の文']]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3 直し（R139）: 素の文字・空白だけ・1行の飾りの文・変換中の貼り付けで、行の文が 10 万字を越えるなら入れずに大きすぎる知らせ（収まれば今どおり入る）', T, async () => {
  const big = 'あ'.repeat(99990);
  const l = await openReal({ pa1: [MANUAL('q1', big), MANUAL('q2', '短い文')] });
  try {
    let t = typeIn(l, 'q1', big, 5);
    l.key(PLAIN_V, t);
    pasteIn(t, { 'text/plain': 'x'.repeat(11) });
    assert.strictEqual(toastOf(l), PASTE_TOO_BIG, 'Ctrl+Shift+V で上限を越えた');
    assert.strictEqual(t.textContent.length, 99990);
    pasteIn(t, { 'text/plain': ' '.repeat(11) });   // 行にならない文（空白だけ）
    assert.strictEqual(t.textContent.length, 99990, '空白だけの貼り付けで上限を越えた');
    pasteIn(t, { 'text/plain': '**太字の文が入るところ**ですよ' });   // 1行の飾りの文（13 字）
    assert.strictEqual(t.textContent.length, 99990, '1行の飾りの文で上限を越えた');
    t._composing = true;
    pasteIn(t, { 'text/plain': 'y'.repeat(11) });
    t._composing = false;
    assert.strictEqual(t.textContent.length, 99990, '変換中の貼り付けで上限を越えた');
    l.caret.set(t, 0, 3);   // 選んだ所は置き換わるので、その分は入る
    l.key(PLAIN_V, t);
    pasteIn(t, { 'text/plain': 'z'.repeat(13) });
    assert.strictEqual(t.textContent.length, 100000, '収まる貼り付けが入らない');
    t = typeIn(l, 'q2', '短い文', 3);
    pasteIn(t, { 'text/plain': 'ふつうの文' });
    assert.strictEqual(t.textContent, '短い文ふつうの文');
    assert.deepStrictEqual(writes(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3 直し（R141）: 貼る行は 1MB に収まっても、今の行の飾りを含む頼みの全部が 1MB を越えるなら、送らずに大きすぎる知らせ（変更を保存できませんでした: bad-args にしない）', T, async () => {
  const cur = 'あ'.repeat(100000);
  const l = await openReal({ pa1: [MANUAL('q1', cur), MANUAL('q2', '後の文')] });
  try {
    const t = typeIn(l, 'q1', cur, 50000);
    const lines = Array.from({ length: 8 }, (_, i) => `${i}${'a'.repeat(99990)}`).join('\n');
    assert.strictEqual(PC.pasteBlocks({ text: lines }).tooBig, undefined, '貼る行だけで大きすぎる見本');
    pasteIn(t, { 'text/plain': lines });
    await l.drain();
    assert.deepStrictEqual(writes(l), [], '頼みの全部が 1MB を越える貼り付けを送った');
    assert.strictEqual(toastOf(l), PASTE_TOO_BIG);
    assert.strictEqual(t.textContent.length, 100000);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('EK-3 直し（R142）: 貼り付けが断られたら、行の文と押したときのカーソル（選んだ所）を戻す', T, async () => {
  const l = await openReal({ pa1: PG3() });
  try {
    l.hold('blockPaste');
    const t = typeIn(l, 'q2', 'あいうえお', 1, 3);
    pasteIn(t, { 'text/plain': '一\n二' });
    await l.drain();
    assert.strictEqual(t.textContent, 'あ', '答えを待つ間の行の文');
    l.caret.set(t, 1);   // 描き直しでカーソルが動いた形
    l.release('blockPaste', 'locked');
    await l.drain();
    assert.strictEqual(t.textContent, 'あいうえお');
    assert.deepStrictEqual(l.caret.get(t), [1, 3], '断られた後にカーソルと選んだ所が戻らない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
