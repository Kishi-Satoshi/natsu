/* stage170.side.app.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の第2部の画面
 *  PD-2（決めたこと 30・33・35・RQ1・F189）: 空の白紙のページのいちばん下の［データベース］（押すとそのページがデータベースになる・Ctrl+Z で戻る）
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
