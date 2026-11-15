/* stage170.minutes.app.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の第3部の画面
 *  LK-1（決めたこと 55・73〜77・F204）: データベースのロック（「···」の切り替え・題名の右の「ロック中」・灰色の［削除］と吹き出し・メニューの項目・表の右端の［＋］）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせ、DB の命令は一時の DB に本当に通す（helpers/realapp.js）。
 * データベースの題名・列の名前は作った物（会議の題名でない: D77 の外）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { realApp } = require('./helpers/realapp');

const T = { timeout: 60000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const open = async (l, id) => { l.fire('onPageOpen', id); await l.drain(120); };
const clickEl = async (l, el, ms = 80) => { el.dispatchEvent({ type: 'click' }); await l.drain(ms); };
const moreItems = (l) => $(l, 'pMenu').querySelectorAll('.mitem');
const moreItem = (l, label) => moreItems(l).find((b) => b.textContent === label);
const sideRow = (l, id) => $(l, 'plist').querySelectorAll('.pitem').find((r) => r.dataset.pid === id);
const treeItems = (l) => { const m = l.document.querySelector('.treemenu'); return m ? m.querySelectorAll('.mitem') : []; };
const LOCK_OFF = 'ロックを外すと、ゴミ箱に入れられます';

test('LK-1・F204: ロック中のデータベースは、題名の右に「ロック中」・「···」の［データベースをロック］に印・［削除］は灰色で吹き出し（押しても消さない）・［移動先…］が無い・表の右端の［＋］とビューの［＋］が無い・列のメニューの形を変える項目は灰色・サイドバーの行のメニューに［名前を変える］［移動先…］が無い', T, async () => {
  const l = await realApp({ before: (call) => {
    const D = call('db.create', {}).id;
    call('db.setTitle', { db: D, title: '名簿' });   // データベースの題名（D77 の外）
    const c = call('col.add', { db: D, type: 'text', name: '場所' }).col.id;   // 列の名前（試しの字）
    call('row.add', { db: D, title: '一' });   // 行の題名（D77 の外）
    call('db.setLock', { db: D, on: true });
    return { D, c };
  } });
  try {
    const { D, c } = l.made;
    await open(l, D);
    assert.ok($(l, 'pLock') && !$(l, 'pLock').hidden && $(l, 'pLock').textContent === 'ロック中', '題名の右に「ロック中」が無い');
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    const lockItem = moreItem(l, 'データベースをロック');
    assert.ok(lockItem && lockItem.getAttribute('role') === 'menuitemcheckbox' && lockItem.getAttribute('aria-checked') === 'true', '［データベースをロック］に印が無い');
    const del = moreItem(l, '削除');
    assert.ok(del && del.getAttribute('aria-disabled') === 'true' && del.title === LOCK_OFF, '［削除］が灰色でない・吹き出しが無い');
    assert.ok(!moreItem(l, '移動先…'), 'ロック中に［移動先…］が出る');
    await clickEl(l, del);
    assert.deepStrictEqual(l.called('pageDelete'), [], 'ロック中の［削除］で消した');
    const host = $(l, 'pDb');
    assert.ok(!host.querySelector('.dbcoladd'), 'ロック中に表の右端の［＋］が出る');
    assert.ok(!host.querySelector('.dbviewadd'), 'ロック中にビューの［＋］が出る');
    const hb = host.querySelectorAll('.dbcolbtn').find((b) => b.textContent === '場所');
    await clickEl(l, hb, 40);
    const colMenu = l.document.querySelector('.dbcolmenu');
    const off = colMenu.querySelectorAll('.mitem').filter((b) => b.disabled).map((b) => b.textContent);
    assert.deepStrictEqual(off, ['名前を変える', '種類 ▸', '左に入れる', '右に入れる', '削除'], '列のメニューの形を変える項目が灰色でない');
    assert.ok(colMenu.querySelectorAll('.mitem').some((b) => b.textContent === '隠す' && !b.disabled), 'ビューの設定（隠す）まで灰色');
    // サイドバーの行のメニュー
    sideRow(l, D).dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain();
    const names = treeItems(l).map((b) => b.textContent);
    assert.ok(!names.includes('名前を変える') && !names.includes('移動先…'), `サイドバーの行のメニュー: ${names}`);
    l.key({ key: 'Escape' }, l.document.querySelector('.treemenu')); await l.drain();
    sideRow(l, D).focus();
    l.key({ key: 'R', ctrlKey: true, shiftKey: true }, sideRow(l, D)); await l.drain();
    assert.ok(!sideRow(l, D).querySelector('input'), 'ロック中に Ctrl+Shift+R で名前の欄が出た');
    sideRow(l, D).dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain();
    const tdel = treeItems(l).find((b) => b.textContent === '削除');
    assert.ok(tdel && tdel.getAttribute('aria-disabled') === 'true' && tdel.title === LOCK_OFF);
    assert.ok(c);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('LK-1・F204: 「ロック中」を押すと［ロックを外す］→ 外すと消せる・列を足せる。「···」の［データベースをロック］でまたロック（db.setLock の1回。元に戻すの歩みにしない）', T, async () => {
  const l = await realApp({ before: (call) => {
    const D = call('db.create', {}).id;
    call('db.setLock', { db: D, on: true });
    return { D };
  } });
  try {
    const { D } = l.made;
    await open(l, D);
    await clickEl(l, $(l, 'pLock'), 40);
    const un = l.document.querySelectorAll('.lockmenu .mitem').find((b) => b.textContent === 'ロックを外す');
    assert.ok(un, '［ロックを外す］が無い');
    await clickEl(l, un, 300);
    assert.deepStrictEqual(l.called('dbSetLock').map((x) => x.args), [[D, false]]);
    assert.ok($(l, 'pLock').hidden, '外したのに「ロック中」が残る');
    assert.ok($(l, 'pDb').querySelector('.dbcoladd'), '外したのに表の右端の［＋］が無い');
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    assert.strictEqual(moreItem(l, '削除').getAttribute('aria-disabled'), null, '外したのに［削除］が灰色');
    assert.ok(moreItem(l, '移動先…'));
    const lockItem = moreItem(l, 'データベースをロック');
    assert.strictEqual(lockItem.getAttribute('aria-checked'), 'false');
    await clickEl(l, lockItem, 300);
    assert.deepStrictEqual(l.called('dbSetLock').map((x) => x.args), [[D, false], [D, true]]);
    assert.ok(!$(l, 'pLock').hidden, 'ロックしたのに「ロック中」が無い');
    assert.strictEqual(l.call('db.get', { id: D }).locked, true);
    assert.deepStrictEqual(l.called('editRevert'), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
