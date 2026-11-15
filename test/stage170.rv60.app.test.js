/* stage170.rv60.app.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の点検 3（rv60）の直しの画面
 *  重要 1（R68）: ［リレーション］の窓で［相手のデータベースにも列を作る］にチェックがある間は、ロック中のデータベースの項目を灰色に
 *  軽い 5（R73）: ロック中はテンプレートの［···］に［複製］を出さない
 *  軽い 8（R52 の書き足し・R76）: ロック中は表の見出しを引っ張って列の並びを替えられない（draggable を外す）
 *  軽い 9（R77）: RT-2 の足りないテスト（［複製］［削除］［編集］・ロック中の文・上限の知らせ・Esc の後のフォーカス）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせ、DB の命令は一時の DB に本当に通す（helpers/realapp.js）。
 * データベースの題名・列の名前は作った物（会議の題名でない: D77 の外）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { realApp } = require('./helpers/realapp');
const { titleAt } = require('./helpers/titles');

const T = { timeout: 60000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const open = async (l, id) => { l.fire('onPageOpen', id); await l.drain(120); };
const clickEl = async (l, el, ms = 80) => { el.dispatchEvent({ type: 'click' }); await l.drain(ms); };
const box = (l) => $(l, 'pDb');
const menu = (l) => box(l).querySelector('.dbmenu');
const items = (l) => (menu(l) ? menu(l).querySelectorAll('.mitem') : []);
const item = (l, label) => items(l).find((b) => b.textContent === label);
const tplMenu = (l) => l.document.querySelector('.dbtplmenu');
const tplRows = (l) => (tplMenu(l) ? tplMenu(l).querySelectorAll('.dbtplrow') : []);
const tplMoreOf = (l, name) => tplRows(l).find((r) => r.querySelector('.dbtplname').textContent === name).querySelector('.dbtplmore');
const openTpl = async (l) => { await clickEl(l, box(l).querySelector('.dbtplbtn'), 60); };
const subItems = (l) => { const s = l.document.querySelector('.dbtplsub'); return s ? s.querySelectorAll('.mitem') : []; };

test('rv60 重要 1・決めたこと 74（R68）: ［リレーション］の窓で［相手のデータベースにも列を作る］にチェックを入れると、ロック中のデータベースの項目は灰色（押しても列を足さない）。チェックを外すと押せる（片側は足せる）', T, async () => {
  const l = await realApp({ before: (call) => {
    const A = call('db.create', {}).id;
    call('db.setTitle', { db: A, title: '案件' });   // データベースの題名（D77 の外）
    const B = call('db.create', {}).id;
    call('db.setTitle', { db: B, title: '名簿' });   // データベースの題名（D77 の外）
    call('db.setLock', { db: B, on: true });
    const C = call('db.create', {}).id;
    call('db.setTitle', { db: C, title: '取引先' });   // データベースの題名（D77 の外）
    return { A, B, C };
  } });
  try {
    const { A, B } = l.made;
    await open(l, A);
    await clickEl(l, box(l).querySelector('.dbcoladd'), 40);
    await clickEl(l, item(l, 'リレーション'), 60);
    const ck = menu(l).querySelector('input.dbrelboth');
    assert.ok(ck, '前提: チェックが無い');
    assert.deepStrictEqual(['名簿', '取引先'].map((n) => item(l, n).disabled), [false, false], 'チェックの前から灰色');
    ck.checked = true; ck.dispatchEvent({ type: 'change' }); await l.drain(20);
    assert.deepStrictEqual(['名簿', '取引先', '案件'].map((n) => item(l, n).disabled), [true, false, false], 'ロック中の相手が灰色でない');
    await clickEl(l, item(l, '名簿'), 100);
    assert.deepStrictEqual(l.called('colAdd'), [], 'ロック中の相手に両側の列を足そうとした');
    ck.checked = false; ck.dispatchEvent({ type: 'change' }); await l.drain(20);
    assert.strictEqual(item(l, '名簿').disabled, false, 'チェックを外しても灰色');
    await clickEl(l, item(l, '名簿'), 200);
    assert.deepStrictEqual(l.called('colAdd').map((c) => c.args), [[A, 'rel', undefined, undefined, { target: B, both: false }]]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('rv60 軽い 5・軽い 8・決めたこと 69・74（R73・R76）: ロック中は、テンプレートの［···］に［複製］が無い（［既定にする］［編集］［削除］）・表の見出しを引っ張れない（draggable が無い）。ロックを外すと出る・引っ張れる', T, async () => {
  const l = await realApp({ before: (call) => {
    const D = call('db.create', {}).id;
    call('db.setTitle', { db: D, title: '名簿' });   // データベースの題名（D77 の外）
    call('col.add', { db: D, type: 'text', name: '場所' });   // 列の名前（試しの字）
    call('tpl.add', { db: D, title: '定例の見本' });   // テンプレートの題名（D77 の外）
    call('db.setLock', { db: D, on: true });
    return { D };
  } });
  try {
    const { D } = l.made;
    await open(l, D);
    assert.ok(box(l).querySelectorAll('.dbcolbtn').every((b) => b.draggable === false), 'ロック中に見出しを引っ張れる');
    await openTpl(l);
    await clickEl(l, tplMoreOf(l, '定例の見本'), 40);
    assert.deepStrictEqual(subItems(l).map((b) => b.textContent), ['既定にする', '編集', '削除'], 'ロック中に［複製］が出る');
    l.key({ key: 'Escape' }, tplMenu(l)); await l.drain();
    l.call('db.setLock', { db: D, on: false });
    await open(l, D);
    assert.ok(box(l).querySelectorAll('.dbcolbtn').every((b) => b.draggable === true), 'ロックを外しても引っ張れない');
    await openTpl(l);
    await clickEl(l, tplMoreOf(l, '定例の見本'), 40);
    assert.deepStrictEqual(subItems(l).map((b) => b.textContent), ['既定にする', '編集', '複製', '削除']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('rv60 軽い 9・RT-2（R77）: テンプレートの［複製］は tpl.dup の1回・［削除］は tpl.remove の1回・［編集］は今のタブでテンプレートの行のページ（帯つき）。Esc で閉じると ▾ へフォーカスが戻る', T, async () => {
  const l = await realApp({ before: (call) => {
    const D = call('db.create', {}).id;
    const A = call('tpl.add', { db: D, title: '定例の見本' }).id;   // テンプレートの題名（D77 の外）
    return { D, A };
  } });
  try {
    const { D, A } = l.made;
    await open(l, D);
    await openTpl(l);
    await clickEl(l, tplMoreOf(l, '定例の見本'), 40);
    await clickEl(l, subItems(l).find((b) => b.textContent === '複製'), 300);
    assert.deepStrictEqual(l.called('tplDup').map((c) => c.args), [[D, A]]);
    await open(l, D);
    await openTpl(l);
    assert.strictEqual(tplRows(l).length, 3, '複製が窓に出ない（2つと「空白のページ」）');
    l.key({ key: 'Escape' }, tplMenu(l)); await l.drain();
    assert.ok(!tplMenu(l), '前提: Esc で閉じない');
    assert.ok(l.document.activeElement === box(l).querySelector('.dbtplbtn'), 'Esc の後に ▾ へフォーカスが戻らない');
    await openTpl(l);
    await clickEl(l, tplMoreOf(l, '定例の見本'), 40);
    await clickEl(l, subItems(l).find((b) => b.textContent === '削除'), 300);
    assert.deepStrictEqual(l.called('tplRemove').map((c) => c.args), [[D, A]]);
    await open(l, D);
    await openTpl(l);
    const left = tplRows(l).map((r) => r.querySelector('.dbtplname').textContent);
    assert.strictEqual(left.length, 2, `［削除］の後の窓: ${left}`);
    await clickEl(l, tplMoreOf(l, left[0]), 40);
    const tabs = l.document.querySelectorAll('.tabitem').length;
    const keep = l.call('db.get', { id: D }).tpls.list[0].id;
    await clickEl(l, subItems(l).find((b) => b.textContent === '編集'), 400);
    assert.deepStrictEqual([l.document.querySelectorAll('.tabitem').length, l.document.querySelector('.tabitem.active').dataset.key], [tabs, `page:${keep}`], '［編集］が今のタブでテンプレートの行のページを開かない');
    assert.ok(!$(l, 'tplBanner').hidden, '［編集］で帯が出ない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('rv60 軽い 9・RT-2（R77）: ロック中でテンプレートが無ければ「ロックを外すと、テンプレートを作れます。」（［＋ 新しいテンプレート］が無い）。21 個目は知らせ「テンプレートは 20 までです。」', T, async () => {
  const l = await realApp({ before: (call) => {
    const L = call('db.create', {}).id;
    call('db.setLock', { db: L, on: true });
    const D = call('db.create', {}).id;
    for (let i = 0; i < 20; i += 1) call('tpl.add', { db: D });
    return { L, D };
  } });
  try {
    const { L, D } = l.made;
    await open(l, L);
    await openTpl(l);
    const note = tplMenu(l).querySelector('.dbtplnote');
    assert.ok(note && note.textContent === 'ロックを外すと、テンプレートを作れます。', 'ロック中の文が無い');
    assert.ok(!tplMenu(l).querySelectorAll('.mitem').some((b) => b.textContent === '＋ 新しいテンプレート'), 'ロック中に［＋ 新しいテンプレート］');
    l.key({ key: 'Escape' }, tplMenu(l)); await l.drain();
    await open(l, D);
    await openTpl(l);
    await clickEl(l, tplMenu(l).querySelectorAll('.mitem').find((b) => b.textContent === '＋ 新しいテンプレート'), 300);
    assert.strictEqual($(l, 'toast').textContent, 'テンプレートは 20 までです。');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('rv60 重要 2（R69）: 「議事録」の表は、議事録が 3 つあれば中の検索の欄が出る。ロックを外して消す確かめは「このデータベースと行 3 件を…」（議事録の数。db.get の rowCount）', T, async () => {
  const MEET = (id, at, date) => ({ title: titleAt(at), date, createdAt: at, blocks: [{ id: `${id}h`, type: 'heading', text: '要点' }, { id: `${id}b`, type: 'bullet', text: '予算の案を作る' }] });
  const l = await realApp({ before: (call) => {
    call('meeting.finalize', { pageId: 'pm1', page: MEET('pm1', '2026-11-10T01:30:00.000Z', '2026-11-10'), segments: [] }, 'main');
    call('meeting.finalize', { pageId: 'pm2', page: MEET('pm2', '2026-11-11T02:00:00.000Z', '2026-11-11'), segments: [] }, 'main');
    call('meeting.finalize', { pageId: 'pm3', page: MEET('pm3', '2026-11-12T02:00:00.000Z', '2026-11-12'), segments: [] }, 'main');
    const M = call('pages.list', {}).find((p) => p.minutes).id;
    call('db.setLock', { db: M, on: false });
    return { M };
  } });
  try {
    const { M } = l.made;
    await open(l, M);
    assert.ok(box(l).querySelector('.dbsearch'), '「議事録」の表に中の検索の欄が無い');
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); return false; };
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    await clickEl(l, $(l, 'pMenu').querySelectorAll('.mitem').find((b) => b.textContent === '削除'), 200);
    assert.deepStrictEqual(asked, ['このデータベースと行 3 件をゴミ箱に入れます。よろしいですか？（ゴミ箱から戻せます）']);
    assert.deepStrictEqual(l.called('pageDelete'), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
