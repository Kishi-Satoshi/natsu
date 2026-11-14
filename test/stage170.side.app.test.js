/* stage170.side.app.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の第2部の画面
 *  PD-2（決めたこと 30・33・35・RQ1・F189）: 空の白紙のページのいちばん下の［データベース］（押すとそのページがデータベースになる・Ctrl+Z で戻る）
 *  SV-2（決めたこと 38〜43・F190・F191）: サイドバーで開いたデータベースの下のビューの行（頭の•と名前。押すとそのビューで開く）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせ、DB の命令は一時の DB に本当に通す（helpers/realapp.js）。
 * 題名は作った物（白紙のページ・データベースの題名で、会議の題名でない: D77 の外）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { realApp } = require('./helpers/realapp');
const { samplePage } = require('./helpers/dbtmp');

const T = { timeout: 60000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const TBL = 'ic:table_chart';
const ico = (el) => { if (!el) return null; const g = el.classList && el.classList.contains('pgi') ? el : el.querySelector('.pgi'); return g ? g.getAttribute('data-icon') : null; };
const open = async (l, id) => { l.fire('onPageOpen', id); await l.drain(80); };
const shown = (l) => $(l, 'emptyDb').hidden === false;
const noteRows = (l) => $(l, 'pNote').querySelectorAll('.blk');
const typeRow = async (l, el, text) => { const t = el._txt; t.focus(); t.textContent = text; t.dispatchEvent({ type: 'input' }); await l.drain(); };
const sideRow = (l, id) => $(l, 'plist').querySelectorAll('.pitem').find((r) => r.dataset.pid === id);

// ---------------------------------------------------------------- PD-2
test('PD-2・F189: ［＋］で作ったページのいちばん下（本文の手引きの下）に灰色の文と［データベース］（前に表のアイコン・読み上げは「このページをデータベースにする」）。題名を打っている間も出たまま・本文に書くと消え、空に戻すとまた出る。議事録・行のページ・録音の前のページ・データベースのページには出ない', T, async () => {
  let prep = false;
  const l = await realApp({
    returns: {
      meetingPrepare: () => { prep = true; return { ok: true }; },
      meetingStatus: () => ({ active: false, finalizing: false, memo: '', segments: [], pending: 0, prep: prep ? { memo: '', meetingType: null } : null }),
    },
    seed: (t) => { const { page, segments } = samplePage('pa1'); t.seed({ ...page, title: '定例の記録' }, segments); },   // 利用者が付け直した題名（D77）
    before: (call) => {
      const P = call('page.create', {}).id;
      const d = call('db.create', {}).id;
      call('page.setTitle', { id: d, title: '案件' });   // データベースの題名（D77 の外）
      const r = call('row.add', { db: d, title: '見積もり' }).id;   // 行の題名（D77 の外）
      return { P, d, r };
    } });
  try {
    const { P, d, r } = l.made;
    $(l, 'newPageBtn').dispatchEvent({ type: 'click' }); await l.drain(80);   // ［＋］で白紙のページを作って開く
    const made = l.called('pageCreate').length ? l.document.activeElement : null;
    assert.ok(made === $(l, 'pTitle'), '［＋］で作ったページの題名にフォーカスが無い');
    assert.ok(shown(l), '［＋］で作った空のページに［データベース］が出ない');
    const box = $(l, 'emptyDb');
    assert.strictEqual(box.querySelector('.emptydb-t').textContent, '空のページは、次の形にできます');
    const btn = $(l, 'emptyDbBtn');
    assert.deepStrictEqual([btn.textContent, btn.getAttribute('aria-label'), ico(btn)], ['データベース', 'このページをデータベースにする', TBL]);
    // ページのいちばん下（本文と本文の後ろの「このページの中のページ」の下）
    const kids = [...box.parentNode.children];
    assert.ok(kids.indexOf(box) > kids.indexOf($(l, 'pNote')) && kids.indexOf(box) > kids.indexOf($(l, 'bodyKids')), '本文の下に無い');
    assert.strictEqual($(l, 'pNote').querySelector('.bodyph').textContent, 'ここに書く（/ で行の型を選べます）', '本文の手引きが変わった');
    // 題名を打っている間も出たまま
    $(l, 'pTitle').textContent = '下書き'; $(l, 'pTitle').dispatchEvent({ type: 'input' }); await l.drain();
    assert.ok(shown(l), '題名を打つと消えた');
    // 手引きを押してできる空のテキストの行は空のまま（出たまま）。1字書くと消え、消すとまた出る
    $(l, 'pNote').querySelector('.bodyph').dispatchEvent({ type: 'click' }); await l.drain(80);
    assert.strictEqual(noteRows(l).length, 1);
    assert.ok(shown(l), '空のテキストの行で消えた');
    await typeRow(l, noteRows(l)[0], 'あ');
    assert.ok(!shown(l), '本文に書いても消えない');
    await typeRow(l, noteRows(l)[0], '');
    assert.ok(shown(l), '空に戻しても出ない');
    // 出ない所: 議事録・データベース・行のページ・録音の前のページ
    await open(l, 'pa1');
    assert.ok(!shown(l), '議事録に出た');
    await open(l, d);
    assert.ok(!shown(l), 'データベースのページに出た');
    await open(l, r);
    assert.ok(!shown(l), '行のページに出た');
    await open(l, P);
    assert.ok(shown(l), '別の白紙のページに出ない');
    $(l, 'mtToggleBtn').dispatchEvent({ type: 'click' }); await l.drain(80);
    assert.strictEqual(l.document.querySelector('.tabitem.active').dataset.key, 'live', '前提: 録音の前のページが開かない');
    assert.ok(!shown(l), '録音の前のページに出た');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PD-2・F189: 押す・Enter・Space で pageToDb の1回（変換中の Enter では押さない）。押した後はデータベースのページを開き直して表にフォーカス・サイドバーの行のアイコンが表になる。断られたら知らせ', T, async () => {
  const l = await realApp({ before: (call) => {
    const ids = [0, 1, 2].map(() => call('page.create', {}).id);
    const trashKid = call('page.create', {}).id;
    call('page.delete', { id: call('page.create', { parentId: trashKid }).id });   // ゴミ箱の子だけ（画面は見えないので押せるが、DB が断る）
    return { ids, trashKid };
  } });
  try {
    const { ids, trashKid } = l.made;
    const btn = () => $(l, 'emptyDbBtn');
    await open(l, ids[0]);
    l.key({ key: 'Enter', isComposing: true, keyCode: 229 }, btn()); await l.drain(80);
    assert.deepStrictEqual(l.called('pageToDb'), [], '変換中の Enter で押した');
    l.key({ key: 'Enter' }, btn()); await l.drain(200);
    assert.deepStrictEqual(l.called('pageToDb').map((c) => c.args), [[ids[0]]]);
    assert.ok($(l, 'pageWrap').classList.contains('db'), 'データベースのページを開き直さない');
    assert.ok(!shown(l), 'データベースにした後も出ている');
    const grid = $(l, 'pDb').querySelector('.dbgrid');
    assert.ok(grid && l.document.activeElement === grid, '表にフォーカスが無い');
    assert.strictEqual(ico(sideRow(l, ids[0]).querySelector('.pi')), TBL, 'サイドバーの行のアイコンが表でない');
    await open(l, ids[1]);
    l.key({ key: ' ' }, btn()); await l.drain(200);
    await open(l, ids[2]);
    btn().dispatchEvent({ type: 'click' }); await l.drain(200);
    assert.deepStrictEqual(l.called('pageToDb').map((c) => c.args), [[ids[0]], [ids[1]], [ids[2]]], 'Space か押すで1回ずつでない');
    // 断られたら知らせ（ページはそのまま）
    await open(l, trashKid);
    assert.ok(shown(l), '前提: ゴミ箱の子は画面に見えないので［データベース］が出る');
    btn().dispatchEvent({ type: 'click' }); await l.drain(200);
    assert.strictEqual($(l, 'toast').textContent, '中身のあるページはデータベースにできません。');
    assert.ok(!$(l, 'pageWrap').classList.contains('db'));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PD-2: Ctrl+Z（表の中）で白紙のページに戻ると、本文の手引きと［データベース］が戻る。行のあるデータベースは戻さず「行のあるデータベースは白紙のページに戻せません。」', T, async () => {
  const l = await realApp({ before: (call) => ({ P: call('page.create', {}).id, Q: call('page.create', {}).id }) });
  try {
    const { P, Q } = l.made;
    await open(l, P);
    $(l, 'emptyDbBtn').dispatchEvent({ type: 'click' }); await l.drain(200);
    const grid = $(l, 'pDb').querySelector('.dbgrid');
    l.key({ key: 'z', code: 'KeyZ', ctrlKey: true }, grid); await l.drain(200);
    assert.deepStrictEqual(l.called('editRevert').map((c) => c.args[0]), [P]);
    assert.ok(!$(l, 'pageWrap').classList.contains('db'), '白紙のページに戻らない');
    assert.ok($(l, 'pNote').querySelector('.bodyph'), '本文の手引きが戻らない');
    assert.ok(shown(l), '［データベース］が戻らない');
    // 行のあるデータベース（ほかの所で行を足した）は戻さない
    await open(l, Q);
    $(l, 'emptyDbBtn').dispatchEvent({ type: 'click' }); await l.drain(200);
    l.call('row.add', { db: Q, title: '行' });   // データベースの行の題名（D77 の外）
    const g2 = $(l, 'pDb').querySelector('.dbgrid');
    l.key({ key: 'z', code: 'KeyZ', ctrlKey: true }, g2); await l.drain(200);
    assert.strictEqual($(l, 'toast').textContent, '行のあるデータベースは白紙のページに戻せません。');
    assert.ok($(l, 'pageWrap').classList.contains('db'), '行のあるデータベースを戻した');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- SV-2
const views = (l) => $(l, 'plist').querySelectorAll('.pview');
const viewNamed = (l, name) => views(l).find((e) => e.querySelector('.t').textContent === name);
const treeSaves = (l) => l.called('uiSave').map((c) => c.args[0]).filter((x) => x && x.tree).map((x) => x.tree.open);
const tabOn = (l) => $(l, 'pDb').querySelectorAll('.dbtab').find((b) => b.getAttribute('aria-selected') === 'true');
const twist = async (l, id) => { sideRow(l, id).querySelector('.pi').dispatchEvent({ type: 'click', stopPropagation() {} }); await l.drain(80); };
const sideKeys = (l) => [...$(l, 'plist').children].map((e) => e.dataset.vkey || e.dataset.pid);
// データベース「案件」（ビュー: 表・週の見通し（リスト））・白紙のページ「計画」とその中のインラインのデータベース（ビュー: 表）・議事録
// （サイドバーの並びは新しい順: 案件・計画）
function seedViews(call) {
  const P = call('page.create', {}).id;
  call('page.setTitle', { id: P, title: '計画' });   // 白紙のページの題名（D77 の外）
  const d2 = call('db.create', { parentId: P }).id;
  const d = call('db.create', {}).id;
  call('page.setTitle', { id: d, title: '案件' });   // データベースの題名（D77 の外）
  const v2 = call('view.add', { db: d, layout: 'list', name: '週の見通し' }).view.id;
  return { d, v2, P, d2 };
}

test('SV-2・F190: データベースの行に ▸（乗せる・フォーカスで）・押すと開け閉めし tree.open にデータベースの ID だけ・ビューの行は role="treeitem"・aria-level・頭の小さな点（•。読み上げには出さない）と名前（textContent）', T, async () => {
  let M = null;
  const l = await realApp({ before: (call) => (M = seedViews(call)), returns: { uiState: () => ({ tree: { open: [`${M.d}/v1`] } }) } });   // 前の版の覚え書きに紛れたビューの鍵
  try {
    const { d, v2, P, d2 } = l.made;
    assert.deepStrictEqual(views(l), [], '閉じているのにビューの行がある');
    const row = sideRow(l, d);
    assert.ok(row.classList.contains('kids') && row.querySelector('.tw'), 'データベースの行に ▸ が無い');
    assert.deepStrictEqual([row.querySelector('.tw').textContent, row.querySelector('.pi').title, row.getAttribute('aria-expanded')], ['▸', '開く', 'false']);
    await twist(l, d);
    assert.deepStrictEqual(sideKeys(l).slice(sideKeys(l).indexOf(d), sideKeys(l).indexOf(d) + 3), [d, `${d}/v1`, `${d}/${v2}`], 'データベースの行のすぐ下にビューの行が無い');
    assert.deepStrictEqual([sideRow(l, d).getAttribute('aria-expanded'), sideRow(l, d).querySelector('.pi').title], ['true', '閉じる']);
    const vs = views(l);
    assert.deepStrictEqual(vs.map((e) => [e.getAttribute('role'), e.getAttribute('aria-level'), e.querySelector('.pdot').textContent, e.querySelector('.pdot').getAttribute('aria-hidden'), e.querySelector('.t').textContent]),
      [['treeitem', '2', '•', 'true', '表'], ['treeitem', '2', '•', 'true', '週の見通し']]);
    assert.deepStrictEqual(vs.map((e) => [e.querySelectorAll('.pmore').length, e.querySelectorAll('.padd').length, e.querySelectorAll('.pi').length]), [[0, 0, 0], [0, 0, 0]], 'ビューの行にメニュー・［＋］・アイコンがある');
    assert.deepStrictEqual(treeSaves(l).at(-1), [d], 'tree.open にデータベースの ID だけでない');
    // 閉じる・もう一度開く
    await twist(l, d);
    assert.deepStrictEqual(views(l), []);
    assert.deepStrictEqual(treeSaves(l).at(-1), []);
    await twist(l, d);
    // インラインのデータベース（白紙のページの子の木）も同じ。段は1つ深い
    await twist(l, P); await twist(l, d2);
    const inl = views(l).filter((e) => e.dataset.vkey.startsWith(`${d2}/`));
    assert.deepStrictEqual(inl.map((e) => [e.getAttribute('aria-level'), e.querySelector('.t').textContent]), [['3', '表']]);
    for (const open of treeSaves(l)) assert.deepStrictEqual(open.filter((k) => k.includes('/')), [], 'tree.open にビューの行の鍵が入った');
    assert.deepStrictEqual(new Set(treeSaves(l).at(-1)), new Set([d, P, d2]));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('SV-2・F191: 押す・Enter・Space でそのビューで開く（開いていればビューだけ替える）・Ctrl+クリックと Ctrl+Enter は新しいタブ・開いているビューの行に選んでいる印・ビューを消すとその行が消え、フォーカスはデータベースの行へ', T, async () => {
  const l = await realApp({ before: (call) => seedViews(call), returns: { uiState: () => ({}) } });
  try {
    const { d, v2 } = l.made;
    await twist(l, d);
    const tabKeys = () => l.document.querySelectorAll('.tabitem').map((e) => e.dataset.key);
    const activeKey = () => l.document.querySelector('.tabitem.active').dataset.key;
    const marks = () => views(l).map((e) => [e.classList.contains('sel'), e.getAttribute('aria-selected')]);
    // Ctrl+Enter・Ctrl+クリックは新しいタブ（今のタブの白紙のページは残る）
    await open(l, l.made.P);
    const n0 = tabKeys().length;
    l.key({ key: 'Enter', ctrlKey: true }, viewNamed(l, '週の見通し')); await l.drain(200);
    assert.strictEqual(tabKeys().length, n0 + 1, 'Ctrl+Enter で新しいタブにならない');
    assert.ok(tabKeys().includes(`page:${l.made.P}`) && activeKey() === `page:${d}`);
    assert.strictEqual(tabOn(l).textContent, '週の見通し', 'そのビューで開かない');
    assert.deepStrictEqual(marks(), [[false, 'false'], [true, 'true']], '開いているビューの行に印が無い');
    await open(l, l.made.P);
    assert.deepStrictEqual(marks(), [[false, 'false'], [false, 'false']], 'ほかのページなのに印がある');
    viewNamed(l, '表').dispatchEvent({ type: 'click', ctrlKey: true }); await l.drain(200);
    assert.ok(tabKeys().includes(`page:${l.made.P}`) && activeKey() === `page:${d}`, 'Ctrl+クリックで新しいタブにならない');
    assert.strictEqual(tabOn(l).textContent, '表');
    // 開いていれば、押す・Enter・Space でビューだけ替える（ページを読み直さない）。表のタブで替えても印が付いてくる
    const gets = l.called('pageGet').length;
    viewNamed(l, '週の見通し').dispatchEvent({ type: 'click' }); await l.drain(200);
    assert.strictEqual(tabOn(l).textContent, '週の見通し');
    assert.deepStrictEqual(marks().map((x) => x[0]), [false, true], '印が替わらない');
    l.key({ key: 'Enter' }, viewNamed(l, '表')); await l.drain(200);
    assert.strictEqual(tabOn(l).textContent, '表');
    $(l, 'pDb').querySelectorAll('.dbtab').find((b) => b.textContent === '週の見通し').dispatchEvent({ type: 'click' }); await l.drain(200);
    assert.deepStrictEqual(marks().map((x) => x[0]), [false, true], '表のタブで替えたビューに印が付かない');
    l.key({ key: ' ' }, viewNamed(l, '表')); await l.drain(200);
    assert.strictEqual(tabOn(l).textContent, '表');
    assert.strictEqual(l.called('pageGet').length, gets, '開いているのにページを開き直した');
    // 開いていなければ、押すとそのビューで開く（最初のビューでなく）
    await open(l, l.made.P);
    viewNamed(l, '週の見通し').dispatchEvent({ type: 'click' }); await l.drain(200);
    assert.strictEqual(activeKey(), `page:${d}`, 'データベースを開かない');
    assert.strictEqual(tabOn(l).textContent, '週の見通し', '押したビューで開かない');
    // 表のタブのメニューで名前を変える・足すと、ビューの行も今の名前（一覧を読み直す）
    tabOn(l).dispatchEvent({ type: 'click' }); await l.drain(60);
    l.document.querySelectorAll('.mitem').find((b) => b.textContent === '名前を変える').dispatchEvent({ type: 'click' }); await l.drain(60);
    const inp = l.document.querySelector('.dbmenuinput');
    inp.value = '今週の見通し';
    l.key({ key: 'Enter' }, inp); await l.drain(200);
    assert.deepStrictEqual(views(l).map((e) => e.querySelector('.t').textContent), ['表', '今週の見通し'], '名前を変えてもビューの行が古い');
    // ビューを消すと行が消え、フォーカスしていたらデータベースの行へ（ほかの所で消して、一覧の知らせが来た）
    viewNamed(l, '今週の見通し').focus();
    l.call('view.remove', { db: d, viewId: v2 });
    l.fire('onPagesUpdated'); await l.drain(200);
    assert.deepStrictEqual(views(l).map((e) => e.querySelector('.t').textContent), ['表'], '消したビューの行が残る');
    assert.ok(l.document.activeElement === sideRow(l, d), '消したビューの行のフォーカスがデータベースの行へ移らない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('SV-2・F190: ↑↓・Home・End がビューの行も通る・← でデータベースの行へ・→ と Shift+F10 は何もしない・引っ張れない・落とす先にならない・選ぶ形でチェックが出ない・ライブラリ・検索・ゴミ箱・［移動先…］に出ない', T, async () => {
  const l = await realApp({ before: (call) => seedViews(call), returns: { uiState: () => ({}) } });
  try {
    const { d, v2, P } = l.made;
    await twist(l, d);
    const keys = sideKeys(l);
    const at = keys.indexOf(d);
    const focused = () => { const a = l.document.activeElement; return a && a.dataset ? a.dataset.vkey || a.dataset.pid : ''; };
    sideRow(l, d).focus();
    l.key({ key: 'ArrowDown' }, sideRow(l, d)); await l.drain();
    assert.strictEqual(focused(), `${d}/v1`, '↓ でビューの行へ行かない');
    l.key({ key: 'ArrowDown' }, l.document.activeElement); await l.drain();
    assert.strictEqual(focused(), `${d}/${v2}`);
    l.key({ key: 'ArrowDown' }, l.document.activeElement); await l.drain();
    assert.strictEqual(focused(), keys[at + 3], '↓ で次のページの行へ行かない');
    l.key({ key: 'ArrowUp' }, l.document.activeElement); await l.drain();
    assert.strictEqual(focused(), `${d}/${v2}`, '↑ でビューの行へ戻らない');
    // → と Shift+F10 は何もしない（開け閉めも覚え書きも変えない）・← でデータベースの行へ
    const saves0 = treeSaves(l).length;
    const keys0 = sideKeys(l);
    for (const ev of [{ key: 'ArrowRight' }, { key: 'F10', shiftKey: true }, { key: 'ContextMenu' }]) { l.key(ev, l.document.activeElement); await l.drain(); }
    assert.strictEqual(focused(), `${d}/${v2}`, '→ でフォーカスが動いた');
    assert.deepStrictEqual([sideKeys(l), treeSaves(l).length], [keys0, saves0], '→ で開け閉めした');
    assert.ok(!l.document.querySelector('.treemenu'), 'Shift+F10 でメニューが出た');
    l.key({ key: 'ArrowLeft' }, l.document.activeElement); await l.drain();
    assert.strictEqual(focused(), d, '← でデータベースの行へ行かない');
    // Home・End（いちばん下がビューの行）
    l.key({ key: 'End' }, sideRow(l, d)); await l.drain();
    const last = sideKeys(l).at(-1);
    assert.strictEqual(focused(), last);
    l.key({ key: 'Home' }, l.document.activeElement); await l.drain();
    assert.strictEqual(focused(), sideKeys(l)[0]);
    // 引っ張れない・落とす先にならない（ページの行を引っ張ってビューの行に落としても動かさない）
    const vr = viewNamed(l, '週の見通し');
    assert.strictEqual(vr.draggable, false, 'ビューの行を引っ張れる');
    const dt = { types: ['application/x-natsu-page'], setData() {}, effectAllowed: '' };
    sideRow(l, P).dispatchEvent({ type: 'dragstart', dataTransfer: dt });
    let stopped = false;
    vr.dispatchEvent({ type: 'dragover', dataTransfer: dt, clientY: 15, preventDefault() { stopped = true; } });
    assert.ok(!stopped && !vr.classList.contains('dropin') && !vr.classList.contains('dropbefore') && !vr.classList.contains('dropafter'), 'ビューの行が落とす先になった');
    vr.dispatchEvent({ type: 'drop', dataTransfer: dt, clientY: 15, preventDefault() {} }); await l.drain(80);
    assert.deepStrictEqual(l.called('pageMove'), [], 'ビューの行に落として動かした');
    // 選ぶ形: ビューの行にチェックが出ず、押しても選ばない（ページも開かない）
    $(l, 'listSelect').dispatchEvent({ type: 'click' }); await l.drain();
    assert.ok(sideRow(l, P).querySelector('.pchk'), '前提: 選ぶ形にならない');
    assert.deepStrictEqual(views(l).map((e) => e.querySelectorAll('.pchk').length), [0, 0], '選ぶ形でビューの行にチェックが出た');
    const gets = l.called('pageGet').length;
    viewNamed(l, '表').dispatchEvent({ type: 'click' }); await l.drain(80);
    assert.strictEqual($(l, 'selCount').textContent, '', 'ビューの行を押して選んだ');
    sideRow(l, P).dispatchEvent({ type: 'click' }); await l.drain();
    assert.strictEqual($(l, 'selCount').textContent, '1 件を選んでいます', '前提: ページの行を選べない');
    viewNamed(l, '週の見通し').dispatchEvent({ type: 'click', shiftKey: true }); await l.drain(80);
    assert.strictEqual($(l, 'selCount').textContent, '1 件を選んでいます', 'Shift でビューの行を押して選んだ');
    const lastPage = sideKeys(l).filter((k) => !k.includes('/')).find((k) => k !== P);   // ビューの行を挟んだ向こうのページの行
    sideRow(l, lastPage).dispatchEvent({ type: 'click', shiftKey: true }); await l.drain();
    const span = sideKeys(l).filter((k) => !k.includes('/'));
    const want = Math.abs(span.indexOf(lastPage) - span.indexOf(P)) + 1;
    assert.ok(Math.abs(sideKeys(l).indexOf(lastPage) - sideKeys(l).indexOf(P)) + 1 > want, '前提: 範囲にビューの行が無い');
    assert.strictEqual($(l, 'selCount').textContent, `${want} 件を選んでいます`, 'Shift の範囲にビューの行を数えた');
    assert.strictEqual(l.called('pageGet').length, gets, '選ぶ形でビューの行を押して開いた');
    $(l, 'selCancel').dispatchEvent({ type: 'click' }); await l.drain();
    // ライブラリ・検索・移動先・ゴミ箱にビューの名前が出ない
    $(l, 'privLib').dispatchEvent({ type: 'click' }); await l.drain(80);
    assert.ok($(l, 'libRows').children.length > 0 && !$(l, 'libRows').textContent.includes('週の見通し'), 'ライブラリにビューの行が出た');
    $(l, 'sideSearch').dispatchEvent({ type: 'click' }); await l.drain(80);
    assert.ok($(l, 'palList').querySelectorAll('.pitem').some((e) => e.dataset.pid === d) && !$(l, 'palList').textContent.includes('週の見通し'), '検索にビューの行が出た');
    l.key({ key: 'Escape' }); await l.drain();
    await open(l, P);
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain();
    $(l, 'pMenu').querySelectorAll('.mitem').find((b) => b.textContent === '移動先…').dispatchEvent({ type: 'click' }); await l.drain();
    assert.ok($(l, 'moveList').children.length > 0 && !$(l, 'moveList').textContent.includes('週の見通し'), '移動先にビューの行が出た');
    l.key({ key: 'Escape' }, $(l, 'moveSearch')); await l.drain();
    l.call('page.delete', { id: d });
    l.fire('onPagesUpdated'); await l.drain(200);
    $(l, 'tabBtnTrash').dispatchEvent({ type: 'click' }); await l.drain(80);
    assert.ok($(l, 'trashList').textContent.includes('案件') && !$(l, 'trashList').textContent.includes('週の見通し'), 'ゴミ箱にビューの行が出た');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
