/* stage171.app.test.js — 0.17.1（計画 docs/plans/2026-11-18-171.md）の画面: 開いている浮く窓の帳面（popLayer）
 *  OD-1（決めたこと 1〜7・11・15〜22・F217・F219・F221・F223・F226〜F229）: 帳面と止める押し、データベースの窓と［ロックを外す］を外の押しで閉じるだけにする
 *  OD-5（決めたこと 23・F218。PQ171-11）: / メニューの外の押しは、閉じて押した所にも届ける（通す窓の印 pass）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせ、命令は本物の preload から一時の DB に本当に通す（helpers/realapp.js）。
 * 押しは helpers/simrun.js の l.press（本物の順: 捕まえる段の document の受け口 → 押した部品から根まで → 泡の段の document の受け口）。
 * データベースの題名・列の名前・行の題名は作った物（D77 の外）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { realApp } = require('./helpers/realapp');

const T = { timeout: 60000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const open = async (l, id) => { l.fire('onPageOpen', id); await l.drain(120); };
const clickEl = async (l, el, n = 60) => { el.dispatchEvent({ type: 'click' }); await l.drain(n); };
// 本物の順の押し。離した後の時限 0 まで進める（止める印を外す時: 決めたこと 16）
const pressEl = async (l, el, o = {}) => { const r = l.press(el, o); await l.clock.advance(0); await l.drain(60); return r; };
const box = (l) => $(l, 'pDb');
const head = (l, col, host = box(l)) => host.querySelectorAll('.dbcolh').find((h) => h.dataset.col === col).querySelector('.dbcolbtn');
const colMenu = (l) => l.document.querySelector('.dbcolmenu');
const lockMenu = (l) => l.document.querySelector('.lockmenu');
// 開いている浮く窓（データベースのメニュー・設定の窓・選びの窓と暦・［ロックを外す］）
const pops = (l) => l.document.querySelectorAll('.dbmenu, .dbpick, .lockmenu, .dbtplsub');
const itemIn = (el, label) => el.querySelectorAll('.mitem').find((b) => b.textContent === label);
const rowEl = (l, id, host = box(l)) => host.querySelectorAll('.dbrow').find((r) => r.dataset.id === id);
const cellAt = (l, id, col, host = box(l)) => rowEl(l, id, host).querySelectorAll('.dbcell').find((c) => c.dataset.col === col);
const selCells = (l, host = box(l)) => host.querySelectorAll('.dbcell').filter((c) => c.getAttribute('aria-selected') === 'true');
const sideRow = (l, id) => $(l, 'plist').querySelectorAll('.pitem').find((r) => r.dataset.pid === id);
const tabEl = (l, name) => box(l).querySelectorAll('.dbtab').find((b) => b.textContent === name);
const active = (l) => l.document.activeElement;

// 見本: データベース「名簿」（テキスト・選択・日付の列と行3つ・テンプレート1つ・ビュー2つ）と、サイドバーのほかのページ「別紙」
async function openDb(o = {}) {
  const l = await realApp({ before: (call) => {
    const D = call('db.create', {}).id;
    call('db.setTitle', { db: D, title: '名簿' });   // データベースの題名（D77 の外）
    const c1 = call('col.add', { db: D, type: 'text', name: '場所' }).col.id;   // 列の名前（試しの字）
    const c2 = call('col.add', { db: D, type: 'select', name: '区分' }).col.id;
    call('col.setOpts', { db: D, col: c2, opts: [{ id: 'o1', name: '甲', color: 'red' }, { id: 'o2', name: '乙', color: 'default' }] });
    const c3 = call('col.add', { db: D, type: 'date', name: '期日' }).col.id;
    const rows = ['一', '二', '三'].map((t) => call('row.add', { db: D, title: t, cells: { [c1]: `所${t}` } }).id);   // 行の題名（D77 の外）
    call('view.add', { db: D, layout: 'table', name: '別表' });   // ビューの名前（試しの字）
    call('tpl.add', { db: D, title: '見本' });   // テンプレートの題名（D77 の外）
    const Q = call('db.create', {}).id;
    call('db.setTitle', { db: Q, title: '別紙' });   // データベースの題名（D77 の外）
    if (o.lock) call('db.setLock', { db: D, on: true });
    return { D, c1, c2, c3, rows, Q };
  } });
  await open(l, l.made.D);
  return l;
}

// ---------------------------------------------------------------- OD-1
test('OD-1・F217: 持ち主の報告の形（2026-11-18）: ロック中の「議事録」で、列の見出しのメニューはページの頭を押すと閉じる。［ロックを外す］は題名を押すと閉じる', T, async () => {
  const l = await openDb({ lock: true });
  try {
    const { c1 } = l.made;
    await clickEl(l, head(l, c1));
    assert.ok(colMenu(l), '前提: 列のメニューが開かない');
    await pressEl(l, l.document.querySelector('.phead'));
    assert.strictEqual(colMenu(l) === null, true, 'ページの頭を押しても列のメニューが残る');
    await clickEl(l, $(l, 'pLock'));
    assert.ok(lockMenu(l), '前提: ［ロックを外す］が開かない');
    await pressEl(l, $(l, 'pTitle'));
    assert.strictEqual(lockMenu(l) === null, true, '題名を押しても［ロックを外す］が残る');
    assert.deepStrictEqual(l.called('dbSetLock'), [], '外の押しでロックを外した');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F217: 窓ごとの表（監査の表の 1〜17・19）: どの窓も、窓の中の押しでは閉じず、外（ページの頭）の押しで閉じる', T, async () => {
  const l = await openDb();
  try {
    const { D, c1, c2, c3, rows } = l.made;
    const outside = () => l.document.querySelector('.phead');
    const ck = (id) => rowEl(l, id).querySelector('.dbcheck');
    const cases = [
      ['列の見出しのメニュー', async () => clickEl(l, head(l, c1)), '.dbcolmenu'],
      ['列の［種類 ▸］', async () => { await clickEl(l, head(l, c1)); await clickEl(l, itemIn(colMenu(l), '種類 ▸')); }, '.dbcolmenu'],
      ['列の［名前を変える］の欄', async () => { await clickEl(l, head(l, c1)); await clickEl(l, itemIn(colMenu(l), '名前を変える')); }, '.dbcolmenu'],
      ['列の［集計 ▸］', async () => { await clickEl(l, head(l, c1)); await clickEl(l, itemIn(colMenu(l), '集計 ▸')); }, '.dbmenu'],
      ['ビューのタブのメニュー', async () => clickEl(l, tabEl(l, '表')), '.dbmenu'],
      ['タブの［＋］', async () => clickEl(l, box(l).querySelector('.dbviewadd')), '.dbmenu'],
      ['⚙ ビューの設定', async () => clickEl(l, box(l).querySelector('.dbsetbtn')), '.dbmenu'],
      ['設定の窓（並べ替え）', async () => { await clickEl(l, box(l).querySelector('.dbsetbtn')); await clickEl(l, itemIn(box(l).querySelector('.dbmenu'), '並べ替え')); }, '.dbpanel'],
      ['設定の窓（絞り込み）', async () => { await clickEl(l, box(l).querySelector('.dbsetbtn')); await clickEl(l, itemIn(box(l).querySelector('.dbmenu'), '絞り込み')); }, '.dbpanel'],
      ['表の右端の［＋］', async () => clickEl(l, box(l).querySelector('.dbcoladd')), '.dbmenu'],
      ['表の下の集計', async () => clickEl(l, box(l).querySelector('.dbaggbtn')), '.dbmenu'],
      ['行のメニュー（右の押し）', async () => { rowEl(l, rows[0]).dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(40); }, '.dbrowmenu'],
      ['［列の値を変える ▸］', async () => {
        ck(rows[0]).checked = true; ck(rows[0]).dispatchEvent({ type: 'change' }); await l.drain(20);
        await clickEl(l, box(l).querySelector('.dbselbar').querySelectorAll('button').find((b) => b.textContent === '列の値を変える ▸'));
      }, '.dbselbar .dbmenu'],
      ['［＋ 新しい行］の ▾', async () => clickEl(l, box(l).querySelector('.dbtplbtn')), '.dbtplmenu'],
      ['▾ の［···］', async () => { await clickEl(l, box(l).querySelector('.dbtplbtn')); await clickEl(l, l.document.querySelector('.dbtplmore')); }, '.dbtplsub'],
      ['［既定にする］の窓', async () => { await clickEl(l, box(l).querySelector('.dbtplbtn')); await clickEl(l, l.document.querySelector('.dbtplmore')); await clickEl(l, itemIn(l.document.querySelector('.dbtplsub'), '既定にする')); }, '.dbtplask'],
      ['セルの選びの窓（選択）', async () => clickEl(l, cellAt(l, rows[0], c2)), '.dbpick'],
      ['セルの暦（日付）', async () => clickEl(l, cellAt(l, rows[0], c3)), '.dbpick'],
    ];
    for (const [name, openIt, sel] of cases) {
      await openIt();
      const w = l.document.querySelector(sel);
      assert.ok(w, `${name}: 前提: 開かない`);
      // 閉じないはずの押し（窓の中の字の無い所）を先に混ぜる（持ち主の試作から参考にしたこと）
      const r = await pressEl(l, w);
      assert.ok(l.document.querySelector(sel), `${name}: 窓の中を押すと閉じた`);
      assert.ok(r.got.includes('mousedown'), `${name}: 窓の中の押しが止まった`);
      await pressEl(l, outside());
      assert.deepStrictEqual(pops(l).map((e) => e.className), [], `${name}: 外を押しても残る`);
    }
    // 行のページの選びの窓（監査の表の 19）
    await open(l, rows[0]);
    await clickEl(l, $(l, `rpv-${c2}`));
    const rp = $(l, 'pProps').querySelector('.dbpick');
    assert.ok(rp, '前提: 行のページの選びの窓が開かない');
    await pressEl(l, rp);
    assert.ok($(l, 'pProps').querySelector('.dbpick'), '行のページの選びの窓: 窓の中を押すと閉じた');
    await pressEl(l, l.document.querySelector('.phead'));
    assert.strictEqual($(l, 'pProps').querySelector('.dbpick') === null, true, '行のページの選びの窓: 外を押しても残る');
    assert.strictEqual(active(l) ? active(l).id : '', '', '行のページの選びの窓: 外の押しで閉じた後に値へフォーカスを戻した（決めたこと 18・R10。$() は描き直し前の要素を返すことがあるので id で見る: R24）');
    assert.ok(D);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F226: 閉じるだけ（MC-01）: 列のメニューを開いたまま押した所（別の行のセル・題名・サイドバーのページ・ビューのタブ・⚙）は、閉じるだけで動かない。もう一度押すと動く', T, async () => {
  const l = await openDb();
  try {
    const { c1, rows, Q } = l.made;
    const openMenu = async () => { await clickEl(l, head(l, c1)); assert.ok(colMenu(l), '前提: 列のメニューが開かない'); };
    const quiet = (r, name) => {
      assert.strictEqual(colMenu(l) === null, true, `${name}: 列のメニューが残る`);
      assert.deepStrictEqual(r.got.filter((t) => ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].includes(t)), [], `${name}: 押した部品に事象が届いた`);
      // 本物は pointerdown の既定を止めると mousedown を出さない（偽の DOM の l.press も同じ: R31）。出たときは既定を止めている
      assert.ok(r.events.pointerdown.defaultPrevented && (!r.events.mousedown || r.events.mousedown.defaultPrevented), `${name}: mousedown の既定（フォーカスの移り・字の選び）を止めない`);
    };
    // (a) 別の行のテキストのセル
    await openMenu();
    let r = await pressEl(l, cellAt(l, rows[1], c1));
    quiet(r, '別の行のセル');
    assert.deepStrictEqual(selCells(l), [], '別の行のセルが選ばれた');
    assert.ok(active(l) !== cellAt(l, rows[1], c1) && active(l) !== head(l, c1), 'フォーカスがセルか開いた部品へ動いた（決めたこと 18）');
    r = await pressEl(l, cellAt(l, rows[1], c1));
    assert.ok(r.got.includes('click'), 'もう一度押してもセルに届かない');
    assert.ok(box(l).querySelector('input.dbedit') || selCells(l).length === 1, 'もう一度押してもセルが選ばれない');
    l.key({ key: 'Escape' }, active(l)); await l.drain(40);
    l.key({ key: 'Escape' }, active(l)); await l.drain(40);
    // (b) 題名
    await openMenu();
    r = await pressEl(l, $(l, 'pTitle'));
    quiet(r, '題名');
    assert.ok(active(l) !== $(l, 'pTitle'), '題名にフォーカスが移った（打った字が入る）');
    const ev = l.key({ key: 'z' });
    assert.strictEqual(ev.target === $(l, 'pTitle'), false, '押した後のキーが題名へ行く');
    assert.strictEqual($(l, 'pTitle').textContent, '名簿');
    // (c) サイドバーの別のページ
    await openMenu();
    r = await pressEl(l, sideRow(l, Q));
    quiet(r, 'サイドバーのページ');
    assert.strictEqual($(l, 'pTitle').textContent, '名簿', 'サイドバーのページが開いた');
    // (d) ビューのタブ
    await openMenu();
    const vu = l.called('viewUpdate').length;
    r = await pressEl(l, tabEl(l, '別表'));
    quiet(r, 'ビューのタブ');
    assert.strictEqual(tabEl(l, '表').getAttribute('aria-selected'), 'true', 'ビューが替わった');
    assert.strictEqual(l.called('viewUpdate').length, vu);
    // (e) ⚙
    await openMenu();
    r = await pressEl(l, box(l).querySelector('.dbsetbtn'));
    quiet(r, '⚙');
    assert.deepStrictEqual(pops(l).map((e) => e.className), [], '⚙ の窓が開いた');
    // もう一度押すと動く
    await pressEl(l, tabEl(l, '別表'));
    assert.strictEqual(tabEl(l, '別表').getAttribute('aria-selected'), 'true', 'もう一度押してもビューが替わらない');
    await pressEl(l, sideRow(l, Q));
    assert.strictEqual($(l, 'pTitle').textContent, '別紙', 'もう一度押してもサイドバーのページが開かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F218: 開くのは1つ（MC-02）: 列のメニューを開いたまま「ロック中」を押すと閉じるだけ。もう一度で［ロックを外す］だけ。キーボードで列のメニューを開くと［ロックを外す］は閉じる。ページの2つの表でも1つ', T, async () => {
  const l = await openDb({ lock: true });
  try {
    const { D, c1 } = l.made;
    await clickEl(l, head(l, c1));
    let r = await pressEl(l, $(l, 'pLock'));
    assert.deepStrictEqual(pops(l).map((e) => e.className), [], '「ロック中」を押すと窓が残るか開く');
    assert.ok(!r.got.includes('click'), '「ロック中」の click が届いた');
    r = await pressEl(l, $(l, 'pLock'));
    assert.deepStrictEqual(pops(l).map((e) => e.className), ['blockmenu lockmenu'], 'もう一度押しても［ロックを外す］だけにならない');
    // キーボード（押しでない click）で列のメニューを開く
    await clickEl(l, head(l, c1));
    assert.deepStrictEqual(pops(l).map((e) => e.className), ['dbmenu dbcolmenu'], 'キーボードで開いた列のメニューと［ロックを外す］が並ぶ');
    l.key({ key: 'Escape' }, colMenu(l)); await l.drain(40);
    // ページの2つの表（同じデータベースのリンクドビュー2つ）
    const P = l.call('page.create', {}).id;
    l.call('page.setTitle', { id: P, title: 'まとめの頁' });   // 白紙のページの題名（D77 の外）
    const b1 = l.call('block.insert', { pageId: P, afterBlockId: '', type: 'paragraph' }).blockId;
    const v1 = l.call('block.insertDbView', { pageId: P, afterId: b1, db: D }).blockId;
    l.call('block.insertDbView', { pageId: P, afterId: v1, db: D });
    await open(l, P);
    await l.drain(200);
    const hosts = $(l, 'pNote').querySelectorAll('.dbhost');
    assert.strictEqual(hosts.length, 2, '前提: 表が2つ無い');
    await clickEl(l, head(l, c1, hosts[0]));
    assert.ok(hosts[0].querySelector('.dbcolmenu'), '前提: 1つ目の表の列のメニューが開かない');
    await pressEl(l, head(l, c1, hosts[1]));
    assert.deepStrictEqual(pops(l).map((e) => e.className), [], 'もう1つの表の見出しを押すと窓が残るか開く');
    await pressEl(l, head(l, c1, hosts[1]));
    assert.ok(hosts[1].querySelector('.dbcolmenu') && !hosts[0].querySelector('.dbcolmenu'), 'もう一度押しても、2つ目の表の列のメニューだけにならない');
    await clickEl(l, head(l, c1, hosts[0]));
    assert.ok(hosts[0].querySelector('.dbcolmenu') && !hosts[1].querySelector('.dbcolmenu'), 'キーボードで開くと2つの表の列のメニューが並ぶ');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F219: 開いた部品の押し: 列の見出しのボタン・⚙（設定の窓）を押すと閉じるだけで開き直さない（click は届かない）。中の押しでは閉じない', T, async () => {
  const l = await openDb();
  try {
    const { c1 } = l.made;
    await clickEl(l, head(l, c1));
    let r = await pressEl(l, head(l, c1));
    assert.strictEqual(colMenu(l) === null, true, '見出しを押すと閉じない（開き直した）');
    assert.ok(!r.got.includes('click'), '見出しの click が届いた');
    await clickEl(l, box(l).querySelector('.dbsetbtn'));
    await clickEl(l, itemIn(box(l).querySelector('.dbmenu'), '絞り込み'));
    assert.ok(box(l).querySelector('.dbpanel'), '前提: 設定の窓が開かない');
    r = await pressEl(l, box(l).querySelector('.dbsetbtn'));
    assert.deepStrictEqual(pops(l).map((e) => e.className), [], '⚙ を押すと設定の窓が残るか⚙の窓が開く');
    assert.ok(!r.got.includes('click'), '⚙ の click が届いた');
    // 中の押し（ボタン 1）
    await clickEl(l, head(l, c1));
    r = await pressEl(l, l.document.querySelector('.phead'), { button: 1 });
    assert.ok(colMenu(l), '中の押しで閉じた');
    assert.ok(r.got.includes('mousedown') && r.got.includes('auxclick'), '中の押しを止めた（自動の捲り・新しいタブで開くが効かない）');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F226: 押し方: 右の押しは閉じるだけ（行のメニューは開かない）・中の押しは閉じない・2回続けた押しの2回目も止める', T, async () => {
  const l = await openDb();
  try {
    const { c1, rows } = l.made;
    await clickEl(l, head(l, c1));
    let r = await pressEl(l, cellAt(l, rows[1], c1), { button: 2 });
    assert.deepStrictEqual(pops(l).map((e) => e.className), [], '右の押しで閉じないか、行のメニューが開いた');
    assert.ok(r.events.contextmenu && r.events.contextmenu.defaultPrevented && !r.got.includes('contextmenu'), '右の押しの contextmenu を止めない');
    // 中の押し
    await clickEl(l, head(l, c1));
    r = await pressEl(l, cellAt(l, rows[1], c1), { button: 1 });
    assert.ok(colMenu(l), '中の押しで閉じた');
    assert.ok(r.got.includes('mousedown'), '中の押しが届かない');
    l.key({ key: 'Escape' }, colMenu(l)); await l.drain(40);
    // 2回続けた押し: 1回目は閉じるだけ、2回目（detail 2）も届かない
    await clickEl(l, head(l, c1));
    await pressEl(l, $(l, 'pTitle'));
    r = await pressEl(l, $(l, 'pTitle'), { detail: 2 });
    assert.deepStrictEqual(r.got, [], '2回目の押し（detail 2）が届いた（pointerdown も: R25）');
    assert.ok(r.events.mousedown.defaultPrevented && r.events.dblclick && !r.got.includes('dblclick'), '2回目の押しの既定・dblclick を止めない');
    assert.ok(active(l) !== $(l, 'pTitle'), '2回目の押しで題名にフォーカスが移った');
    r = await pressEl(l, $(l, 'pTitle'));
    assert.ok(r.got.includes('mousedown') && r.got.includes('click'), 'その後の1回目の押しが届かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F226（R25）: 2回続けた押しの2回目は pointerdown から止める（同じ所・間が短い左の押し）。所が離れた・間が長い・右の押しは pointerdown で止めない。2回目に見えて detail が 1 なら pointerdown だけを止める', T, async () => {
  const l = await openDb();
  try {
    const { c1 } = l.made;
    const title = () => $(l, 'pTitle');
    // 同じ所の2回目（detail 2）: pointerdown から全部止まる
    await clickEl(l, head(l, c1));
    await pressEl(l, title(), { clientX: 300, clientY: 40 });
    assert.strictEqual(colMenu(l) === null, true, '前提: 1回目で閉じない');
    let r = await pressEl(l, title(), { detail: 2, clientX: 302, clientY: 41 });
    assert.deepStrictEqual(r.got, [], '2回目の押しの pointerdown が届いた（ブロックの選びを外す・範囲の選びを始める）');
    // pointerdown の既定は止めない（止めると本物は mousedown を出さず、detail で2回目かを見分けられない: R31）。mousedown（detail 2）から既定を止める
    assert.strictEqual(r.events.pointerdown.defaultPrevented, false, '2回目かもしれない pointerdown の既定を止めた（mousedown が来なくなる）');
    assert.ok(r.events.mousedown && r.events.mousedown.defaultPrevented, '2回目の mousedown の既定を止めない');
    // 間が長い（2回続けた押しの間より後）の押しは全部届く
    await l.clock.advance(600);
    r = await pressEl(l, title(), { clientX: 302, clientY: 41 });
    assert.deepStrictEqual(r.got.slice(0, 2), ['pointerdown', 'mousedown'], '間が長い押しが届かない');
    assert.ok(r.got.includes('click'), '間が長い押しの click が届かない');
    // 所が離れた2回目（OS の2回続けた押しの決めが広いとき）: pointerdown は届き、mousedown（detail 2）からは今までどおり止める
    await clickEl(l, head(l, c1));
    await pressEl(l, title(), { clientX: 300, clientY: 40 });
    r = await pressEl(l, title(), { detail: 2, clientX: 340, clientY: 40 });
    assert.deepStrictEqual(r.got, ['pointerdown'], '所が離れた2回目: pointerdown のほかが届いたか、pointerdown を止めた');
    await l.clock.advance(600);
    // 2回目に見えて detail が 1（OS は別の押しと数えた）: pointerdown だけを止め、mousedown から先は届ける
    await clickEl(l, head(l, c1));
    await pressEl(l, title(), { clientX: 300, clientY: 40 });
    r = await pressEl(l, title(), { clientX: 301, clientY: 40 });
    assert.deepStrictEqual(r.got, ['mousedown', 'pointerup', 'mouseup', 'click'], '2回目に見えた1回目の押し: mousedown から先が届かない');
    assert.ok(active(l) === title(), '2回目に見えた1回目の押しで題名にフォーカスが移らない');
    await l.clock.advance(600);
    // 右の押しの2回目は pointerdown で止めない（2回続けた押しは左だけ）
    await clickEl(l, head(l, c1));
    await pressEl(l, title(), { clientX: 300, clientY: 40 });
    r = await pressEl(l, title(), { button: 2, clientX: 300, clientY: 40 });
    assert.ok(r.got.includes('pointerdown'), '窓が無いときの右の押しを pointerdown で止めた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F227・F229: 止める印が残らない（click が来ない・pointercancel・窓のフォーカスが外れる・5 秒）。窓が無いときと、違う押しの番号は止めない', T, async () => {
  const l = await openDb();
  try {
    const { c1 } = l.made;
    const title = () => $(l, 'pTitle');
    const free = async (why) => {
      const r = l.press(title(), { clientX: 200 });   // 止めた押しから離れた所（2回続けた押しの2回目と見ない: R25）
      await l.drain(20);
      assert.deepStrictEqual(r.got, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'], `${why}: 次の押しが届かない（止める印が残った）`);
      assert.strictEqual(r.events.mousedown.defaultPrevented, false, `${why}: 窓が無いのに押しを止めた`);
      await l.clock.advance(0);
    };
    await free('始め');
    // 押したまま窓の外で離し、click が来ない（離した後の時限 0 で外す）
    await clickEl(l, head(l, c1));
    l.press(l.document.querySelector('.phead'), { types: ['pointerdown', 'mousedown'] });
    l.press(box(l), { types: ['pointerup', 'mouseup'] });
    await l.clock.advance(0); await l.drain(20);
    await free('click が来ない');
    // pointercancel
    await clickEl(l, head(l, c1));
    l.press(l.document.querySelector('.phead'), { types: ['pointerdown', 'mousedown', 'pointercancel'] });
    await l.drain(20);
    await free('pointercancel');
    // 窓のフォーカスが外れる（ほかのアプリ・タイトルバー）
    await clickEl(l, head(l, c1));
    l.press(l.document.querySelector('.phead'), { types: ['pointerdown', 'mousedown'] });
    l.blurWindow();
    await l.drain(20);
    await free('窓の blur');
    // 5 秒
    await clickEl(l, head(l, c1));
    l.press(l.document.querySelector('.phead'), { types: ['pointerdown', 'mousedown'] });
    await l.clock.advance(5000); await l.drain(20);
    await free('5 秒');
    // 止める印と違う押しの番号の事象は止めない（閉じない押しを混ぜる）
    await clickEl(l, head(l, c1));
    l.press(l.document.querySelector('.phead'), { types: ['pointerdown', 'mousedown'], pointerId: 1 });
    const other = l.press(title(), { types: ['pointerup', 'click'], pointerId: 7 });
    assert.deepStrictEqual(other.got, ['pointerup', 'click'], '違う押しの番号の事象を止めた');
    await l.clock.advance(5000); await l.drain(20);
    await free('違う番号の後');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F226（R27）: ペンとタッチの外の押しは、離した後も止める印を残し、その押しの click が来るか 350ms で外す（タップの click は離した後の時限 0 より後に来ることがある）。マウスは今どおり時限 0', T, async () => {
  const l = await openDb();
  try {
    const { c1, rows } = l.made;
    const cell = () => cellAt(l, rows[1], c1);
    for (const [kind, clickId] of [['touch', 5], ['touch', -1], ['pen', 6]]) {
      await clickEl(l, head(l, c1));
      // 指を下ろして離す（pointerdown・pointerup）。時限 0 が過ぎてから、タップの mousedown・mouseup・click が来る
      let r = l.press(cell(), { pointerType: kind, pointerId: 5, types: ['pointerdown', 'pointerup'], clientX: 120, clientY: 300 });
      assert.deepStrictEqual(r.got, [], `${kind}: 外のタップの pointerdown・pointerup が届いた`);
      assert.deepStrictEqual(pops(l).map((e) => e.className), [], `${kind}: 外のタップで閉じない`);
      await l.clock.advance(0); await l.drain(20);
      r = l.press(cell(), { pointerType: kind, pointerId: clickId, types: ['mousedown', 'mouseup', 'click'], clientX: 120, clientY: 300 });
      await l.clock.advance(0); await l.drain(40);
      assert.deepStrictEqual(r.got, [], `${kind}（click の番号 ${clickId}）: 時限 0 の後のタップの click が届いた（閉じて、押したセルも動く）`);
      assert.deepStrictEqual(selCells(l).map((c) => c.dataset.col), [], `${kind}: タップしたセルが選ばれた`);
      // click で印を外したので、次の押し（離れた所・マウス）は届く
      r = await pressEl(l, $(l, 'pTitle'), { clientX: 600 });
      assert.ok(r.got.includes('pointerdown') && r.got.includes('click'), `${kind}: タップの click の後の押しが届かない（印が残った）`);
      $(l, 'pTitle').blur();
      await l.clock.advance(600);
    }
    // click が来ないタップ（指を動かした・別の所で離した）: 350ms で外す
    await clickEl(l, head(l, c1));
    l.press(cell(), { pointerType: 'touch', pointerId: 5, types: ['pointerdown', 'pointerup'], clientX: 120, clientY: 300 });
    await l.clock.advance(300); await l.drain(20);
    let r = l.press($(l, 'pTitle'), { pointerType: 'touch', pointerId: 9, types: ['click'], clientX: 600 });
    assert.deepStrictEqual(r.got, [], '350ms の内の click が届いた');
    await l.clock.advance(400); await l.drain(20);
    r = l.press($(l, 'pTitle'), { clientX: 600 });
    await l.clock.advance(0); await l.drain(20);
    assert.ok(r.got.includes('pointerdown') && r.got.includes('click'), '350ms の後も印が残った');
    // マウスは今どおり: 離した後の時限 0 で外す（時限 0 の後の click は届く）
    await l.clock.advance(600);
    await clickEl(l, head(l, c1));
    l.press(cell(), { types: ['pointerdown', 'mousedown', 'pointerup', 'mouseup'], clientX: 120, clientY: 300 });
    await l.clock.advance(0); await l.drain(20);
    r = l.press($(l, 'pTitle'), { types: ['click'], clientX: 600 });
    assert.deepStrictEqual(r.got, ['click'], 'マウスの時限 0 の後の click を止めた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F227: 設定の窓の押しも止める（決めたこと 11。2026-11-21 の PQ171-6 の答え「ほかのメニューと同じ「閉じるだけ」」）: 絞り込みの窓を開いたまま別の行のセルを押すと、閉じるだけでセルは選ばれない', T, async () => {
  const l = await openDb();
  try {
    const { c1, rows } = l.made;
    await clickEl(l, box(l).querySelector('.dbsetbtn'));
    await clickEl(l, itemIn(box(l).querySelector('.dbmenu'), '絞り込み'));
    assert.ok(box(l).querySelector('.dbpanel'), '前提: 設定の窓が開かない');
    const r = await pressEl(l, cellAt(l, rows[2], c1));
    assert.strictEqual(box(l).querySelector('.dbpanel') === null, true, '外を押しても設定の窓が残る');
    assert.deepStrictEqual(r.got, [], '設定の窓を閉じた押しがセルに届いた');
    assert.deepStrictEqual(selCells(l), [], 'セルが選ばれた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F221: 閉じ方は Esc と同じ: 暦は打った日付を書く・選びの窓は何も送らない・列の名前は1回だけ決める（空・同じなら送らない）・タブの［＋］の欄ではビューを作らない・絞り込みの値の欄は打ちかけを書く', T, async () => {
  const l = await openDb();
  try {
    const { c1, c2, c3, rows } = l.made;
    const outside = () => l.document.querySelector('.phead');
    // 暦
    await clickEl(l, cellAt(l, rows[0], c3));
    const din = box(l).querySelector('.dbpick input');
    assert.ok(din, '前提: 暦の欄が無い');
    din.value = '2026-11-21';
    din.dispatchEvent({ type: 'input' }); await l.drain(20);
    const sc = l.called('rowSetCell').length;
    await pressEl(l, outside());
    assert.strictEqual(box(l).querySelector('.dbpick') === null, true, '暦が残る');
    assert.deepStrictEqual(l.called('rowSetCell').slice(sc).map((c) => [c.args[1], c.args[2], c.args[3] && c.args[3].start]), [[rows[0], c3, '2026-11-21']], '暦の打った日付を1回書かない');
    // 選びの窓
    await clickEl(l, cellAt(l, rows[0], c2));
    const before = l.calls.length;
    await pressEl(l, outside());
    assert.strictEqual(box(l).querySelector('.dbpick') === null, true, '選びの窓が残る');
    assert.deepStrictEqual(l.calls.slice(before).filter((c) => /^(rowSetCell|rowsSetCell|colSetOpts)$/.test(c.method)), [], '選びの窓を外の押しで閉じたときに書いた');
    // 列の名前（1行の欄）
    const rename = async (text) => { await clickEl(l, head(l, c1)); await clickEl(l, itemIn(colMenu(l), '名前を変える')); const inp = colMenu(l).querySelector('input'); inp.value = text; return inp; };
    let inp = await rename('置き場');
    await pressEl(l, outside());
    assert.strictEqual(colMenu(l) === null, true, '名前の欄が残る');
    assert.deepStrictEqual(l.called('colRename').map((c) => c.args.slice(1)), [[c1, '置き場']], '外の押しで打った名前を決めない');
    l.key({ key: 'Enter' }, inp); await l.drain(60);
    assert.strictEqual(l.called('colRename').length, 1, '外の押しの後の Enter で2回送った');
    inp = await rename('置き場');
    await pressEl(l, outside());
    inp = await rename('   ');
    await pressEl(l, outside());
    assert.strictEqual(l.called('colRename').length, 1, '同じ名前・空の名前を送った');
    // タブの［＋］の名前の欄
    await clickEl(l, box(l).querySelector('.dbviewadd'));
    box(l).querySelector('.dbmenu input').value = '今週';
    await pressEl(l, outside());
    assert.deepStrictEqual(l.called('viewAdd'), [], 'タブの［＋］の欄の外の押しでビューを作った');
    // 絞り込みの値の欄（change の前に外を押す）
    await clickEl(l, box(l).querySelector('.dbsetbtn'));
    await clickEl(l, itemIn(box(l).querySelector('.dbmenu'), '絞り込み'));
    const pn = box(l).querySelector('.dbpanel');
    const add = pn.querySelectorAll('button').find((b) => b.textContent.includes('条件を足す'));
    assert.ok(add, '前提: ［条件を足す］が無い');
    await clickEl(l, add, 160);
    const vu = l.called('viewUpdate').length;
    const val = box(l).querySelector('.dbpanel').querySelector('input.dbmenuinput');
    assert.ok(val, '前提: 値の欄が無い');
    val.focus();
    val.value = '所二';
    await pressEl(l, outside());
    await l.drain(160);
    assert.strictEqual(box(l).querySelector('.dbpanel') === null, true, '設定の窓が残る');
    const ups = l.called('viewUpdate').slice(vu);
    assert.strictEqual(ups.length, 1, `打ちかけの値を1回で書かない（${ups.length} 回）`);
    assert.strictEqual(JSON.stringify(ups[0].args[2].filter).includes('所二'), true, '打ちかけの値が書かれていない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F221（PQ171-10）: ［列の値を変える ▸］の1行の欄は、外の押しで打った字を捨てる（Esc と同じ。選んだ全部の行に書く欄なので、決めたこと 6 の1行の欄の例外）。押しは止める。Enter は今どおり書く', T, async () => {
  const l = await openDb();
  try {
    const { c1, rows } = l.made;
    const bar = () => box(l).querySelector('.dbselbar');
    const place = () => rows.map((id) => cellAt(l, id, c1).textContent);
    const was = place();
    for (const id of [rows[0], rows[2]]) { const ck = rowEl(l, id).querySelector('.dbcheck'); ck.checked = true; ck.dispatchEvent({ type: 'change' }); await l.drain(20); }
    assert.strictEqual(bar().hidden, false, '前提: 選んだ行の帯が出ない');
    const typeIn = async (text) => {
      await clickEl(l, bar().querySelectorAll('button').find((b) => b.textContent === '列の値を変える ▸'));
      const m = bar().querySelector('.dbmenu');
      assert.ok(m, '前提: ［列の値を変える ▸］のメニューが開かない');
      await clickEl(l, itemIn(m, '場所'));
      const inp = bar().querySelector('.dbmenu .dbedit');
      assert.ok(inp, '前提: 1行の欄が無い');
      assert.strictEqual(inp.getAttribute('aria-label'), '場所');
      inp.value = text;
      inp.dispatchEvent({ type: 'input' }); await l.drain(20);
      return inp;
    };
    // 打ちかけて外（ページの頭）を押す → 閉じるだけ。どの行の値も変わらない
    await typeIn('打ちかけ');
    const r = await pressEl(l, l.document.querySelector('.phead'));
    await l.drain(120);
    assert.strictEqual(bar().querySelector('.dbmenu') === null, true, '外を押しても［列の値を変える ▸］の欄が残る');
    assert.deepStrictEqual(l.called('rowsSetCell'), [], '外の押しで打った字を選んだ行に書いた（PQ171-10 の答え「捨てる」）');
    assert.deepStrictEqual(l.called('rowSetCell'), [], '外の押しで行に書いた');
    assert.deepStrictEqual(place(), was, '外の押しで行の値が変わった');
    assert.deepStrictEqual(r.got.filter((t) => ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].includes(t)), [], '外の押しが押した所に届いた（閉じるだけ: 決めたこと 7）');
    assert.ok(r.events.pointerdown.defaultPrevented, '外の押しの既定を止めない');
    assert.strictEqual(bar().hidden, false, '外の押しで行の選びが外れた');
    // Enter は今どおり、選んだ全部の行に1回で書く（捨てた字は残らない）
    const inp = await typeIn('まとめて');
    l.key({ key: 'Enter' }, inp); await l.drain(120);
    assert.deepStrictEqual(l.called('rowsSetCell').map((c) => c.args), [[l.made.D, [rows[0], rows[2]], c1, 'まとめて']], 'Enter で選んだ行に1回で書かない');
    assert.deepStrictEqual(place(), ['まとめて', was[1], 'まとめて'], 'Enter で書いた値が表に出ない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F228: 変換中の欄: 外の押しで閉じる前に欄の blur を呼び（変換中の字を確定させる）、送るのは1回', T, async () => {
  const l = await openDb();
  try {
    const { c1, c3, rows } = l.made;
    await clickEl(l, head(l, c1));
    await clickEl(l, itemIn(colMenu(l), '名前を変える'));
    const inp = colMenu(l).querySelector('input');
    assert.ok(active(l) === inp, '前提: 名前の欄にフォーカスが無い');
    inp.value = '置き場';
    const at = [];
    const blur = inp.blur;
    inp.blur = function () { at.push(l.called('colRename').length); return blur.call(this); };
    await pressEl(l, l.document.querySelector('.phead'));
    assert.deepStrictEqual(at, [0], '名前を送る前に欄の blur を呼ばない');
    assert.strictEqual(l.called('colRename').length, 1);
    // 暦の欄（blur で今の focusout が決めても、書くのは1回）
    await clickEl(l, cellAt(l, rows[1], c3));
    const din = box(l).querySelector('.dbpick input');
    din.focus();
    din.value = '2026-11-22';
    din.dispatchEvent({ type: 'input' }); await l.drain(20);
    const outs = [];
    box(l).querySelector('.dbpick').addEventListener('focusout', (ev) => outs.push(ev.relatedTarget === null));
    const sc = l.called('rowSetCell').length;
    await pressEl(l, l.document.querySelector('.phead'));
    assert.deepStrictEqual(outs, [true], '欄の blur で窓に focusout（行き先なし）が来ない（本物の Chromium の形）');
    assert.strictEqual(l.called('rowSetCell').length - sc, 1, '暦を2回書いたか書かない');
    // 行のページの暦（0.17.1 直し R23: 帳面が呼んだ blur の focusout で決めて、値へフォーカスを戻していた。決めたこと 18・R10）
    await open(l, rows[0]);
    await clickEl(l, $(l, `rpv-${c3}`));
    const rpin = $(l, 'pProps').querySelector('.dbpick input');
    assert.ok(rpin, '前提: 行のページの暦が開かない');
    rpin.focus();
    rpin.value = '2026-11-23';
    rpin.dispatchEvent({ type: 'input' }); await l.drain(20);
    const rpOuts = [];
    $(l, 'pProps').querySelector('.dbpick').addEventListener('focusout', (ev) => rpOuts.push(ev.relatedTarget === null));
    const rc = l.called('rowSetCell').length;
    await pressEl(l, l.document.querySelector('.phead'));
    await l.drain(160);
    assert.deepStrictEqual(rpOuts, [true], '行のページ: 欄の blur で窓に focusout（行き先なし）が来ない');
    assert.strictEqual($(l, 'pProps').querySelector('.dbpick') === null, true, '行のページの暦が残る');
    assert.strictEqual(l.called('rowSetCell').length - rc, 1, '行のページの暦を2回書いたか書かない');
    assert.strictEqual(active(l) ? active(l).id : '', '', '行のページの暦を外の押しで閉じた後に、値へフォーカスを戻した（決めたこと 18・R10。フォーカスは窓と一緒に外れる）');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F223（R28）: Esc で戻す開いた部品は Esc の時に引く: 書いて ⚙ や表のセルが描き直されても、設定の窓・選びの窓を Esc で閉じるとフォーカスは今の ⚙・セルへ戻る', T, async () => {
  const l = await realApp({ before: (call) => {
    const D = call('db.create', {}).id;
    call('db.setTitle', { db: D, title: '名簿' });   // データベースの題名（D77 の外）
    const cm = call('col.add', { db: D, type: 'multi', name: '札' }).col.id;   // 列の名前（試しの字）
    call('col.setOpts', { db: D, col: cm, opts: [{ id: 'o1', name: '甲', color: 'red' }, { id: 'o2', name: '乙', color: 'default' }] });
    const rows = ['一', '二'].map((t) => call('row.add', { db: D, title: t }).id);   // 行の題名（D77 の外）
    return { D, cm, rows };
  } });
  try {
    await open(l, l.made.D);
    const { cm, rows } = l.made;
    // 設定の窓: 条件を書くと表と ⚙ が描き直される（窓は残る）
    const g0 = box(l).querySelector('.dbsetbtn');
    await clickEl(l, g0);
    await clickEl(l, itemIn(box(l).querySelector('.dbmenu'), '絞り込み'));
    const add = box(l).querySelector('.dbpanel').querySelectorAll('button').find((b) => b.textContent.includes('条件を足す'));
    await clickEl(l, add, 160);
    const val = box(l).querySelector('.dbpanel').querySelector('input.dbmenuinput');
    assert.ok(val, '前提: 値の欄が無い');
    val.value = '一';
    val.dispatchEvent({ type: 'change' }); await l.drain(200);
    assert.ok(box(l).querySelector('.dbpanel'), '前提: 設定の窓が無い');
    assert.ok(box(l).querySelector('.dbsetbtn') !== g0, '前提: 書いても ⚙ が描き直されない（確かめにならない）');
    $(l, 'pTitle').focus();
    l.key({ key: 'Escape' }, $(l, 'pTitle')); await l.drain(40);
    assert.strictEqual(box(l).querySelector('.dbpanel') === null, true, '設定の窓が Esc で閉じない');
    assert.ok(active(l) === box(l).querySelector('.dbsetbtn'), `設定の窓の Esc の後、フォーカスが今の ⚙ に無い（${active(l) ? active(l).className : 'なし'}）`);
    // 選びの窓（複数選択）: 選ぶと書き、閉じるときに表のセルが描き直される
    const c0 = cellAt(l, rows[0], cm);
    await clickEl(l, c0);
    const opt = box(l).querySelector('.dbpick').querySelectorAll('.dbopt').find((b) => b.textContent.includes('甲'));
    assert.ok(opt, '前提: 選びの窓の「甲」が無い');
    await clickEl(l, opt, 160);
    assert.ok(box(l).querySelector('.dbpick'), '前提: 複数選択の選びの窓が選ぶと閉じた');
    $(l, 'pTitle').focus();
    l.key({ key: 'Escape' }, $(l, 'pTitle')); await l.drain(80);
    assert.strictEqual(box(l).querySelector('.dbpick') === null, true, '選びの窓が Esc で閉じない');
    assert.ok(cellAt(l, rows[0], cm) !== c0, '前提: 閉じても表のセルが描き直されない（確かめにならない）');
    assert.ok(active(l) === cellAt(l, rows[0], cm), `選びの窓の Esc の後、フォーカスが今のセルに無い（${active(l) ? active(l).className : 'なし'}）`);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-1・F223: Esc: フォーカスが窓の外でも閉じて開いた部品へ戻す。変換中の Esc では閉じない。窓が無いときの Esc は止めない（表の Esc の段のまま）', T, async () => {
  const l = await openDb();
  try {
    const { c1, rows } = l.made;
    await clickEl(l, head(l, c1));
    $(l, 'pTitle').focus();
    let ev = l.key({ key: 'Escape', isComposing: true }, $(l, 'pTitle')); await l.drain(20);
    assert.ok(colMenu(l), '変換中の Esc で閉じた');
    ev = l.key({ key: 'Escape' }, $(l, 'pTitle')); await l.drain(20);
    assert.strictEqual(colMenu(l) === null, true, 'フォーカスが外にあると Esc で閉じない');
    assert.ok(ev.defaultPrevented, '窓を閉じた Esc を止めない');
    assert.ok(active(l) === head(l, c1), 'Esc の後に開いた部品へフォーカスが戻らない');
    // 窓が無いときの Esc は帳面が止めない（document の受け口だけを呼ぶ形で、既定を止めない）
    assert.deepStrictEqual(pops(l).map((e) => e.className), []);
    ev = l.key({ key: 'Escape' }); await l.drain(20);
    assert.strictEqual(ev.defaultPrevented, false, '窓が無いのに Esc を止めた');
    // 窓が無いときのセルの Esc（0.17.0 NX-5 の段）は今のまま
    await clickEl(l, cellAt(l, rows[0], 'title'));
    l.key({ key: 'Escape' }, active(l)); await l.drain(40);
    const cell = selCells(l)[0];
    assert.ok(cell, '前提: セルが選ばれていない');
    ev = l.key({ key: 'Escape' }, cell); await l.drain(40);
    assert.deepStrictEqual(selCells(l), [], '窓が無いときの表の Esc の段（セル → 行）が効かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- OD-2（決めたこと 4・9・10・12・19・F218・F220・F224）
const { samplePage } = require('./helpers/dbtmp');
const kid = (id, text) => ({ id, type: 'paragraph', text, citeState: 'manual', cites: [] });
const bodyRow = (l, id) => $(l, 'pNote').querySelectorAll('.blk').find((e) => e.dataset.id === id);
const txtOf = (l, id) => bodyRow(l, id).querySelector('.txt');
const plusOf = (l, id) => bodyRow(l, id).querySelector('.plus');
// 見本: 議事録のページ pa1（要約の行 x・y）・データベース「名簿」・白紙のページ「まとめの頁」（行 b1）・6 段の入れ子（パンくずの「…」）・ゴミ箱のページ
async function openNote() {
  const l = await realApp({
    seed: (t) => {
      const a = samplePage('pa1'); t.seed({ ...a.page, blocks: [kid('x', 'あいうえお'), kid('y', 'かきくけこ')] }, a.segments);
      const b = samplePage('pb2'); t.seed({ ...b.page, blocks: [] }, b.segments);   // 要約の無い議事録（［要約を生成］が主ボタン）
    },
    before: (call) => {
      const D = call('db.create', {}).id;
      call('db.setTitle', { db: D, title: '名簿' });   // データベースの題名（D77 の外）
      call('tpl.add', { db: D, title: '見本' });   // テンプレートの題名（D77 の外）
      const P = call('page.create', {}).id;
      call('page.setTitle', { id: P, title: 'まとめの頁' });   // 白紙のページの題名（D77 の外）
      const b1 = call('block.insert', { pageId: P, afterBlockId: '', type: 'paragraph' }).blockId;
      let up = P; const deep = [];
      for (let i = 0; i < 6; i += 1) { up = call('page.create', { parentId: up }).id; call('page.setTitle', { id: up, title: `段${i + 1}` }); deep.push(up); }   // 白紙のページの題名（D77 の外）
      const nb = call('block.insert', { pageId: up, afterBlockId: '', type: 'paragraph' }).blockId;
      const G = call('page.create', {}).id;
      call('page.delete', { id: G });
      return { D, P, b1, deep, nb };
    },
  });
  await open(l, 'pa1');
  return l;
}
const slashIn = async (l, t, text) => { t.focus(); t.textContent = text; l.caret.set(t, text.length); t.dispatchEvent({ type: 'input' }); await l.drain(); };
const selectIn = (l, id, s, e) => { const t = txtOf(l, id); t.focus(); l.caret.set(t, s, e); t.dispatchEvent({ type: 'mouseup' }); return t; };

// 0.17.1 OD-5（決めたこと 23・PQ171-11）で意図して直した: / メニューを外した（/ メニューの外の押しは閉じて押した所にも届く。下の「OD-5・F218: / メニューの外の押しは通す」で見る）
// 0.18.0 XE-5（計画 docs/plans/2026-11-18-180.md の決めたこと 68・AQ31 (a)・「意図して変えるテスト」）で意図して直した: 文字の色を外した（OD-5 と同じ。文字の色のメニューの外の押しは
// 閉じて押した所にも届く。test/stage180.app.test.js の「XE-5・F253: 文字の色のメニューの外の押しは通す」で見る）
test('OD-2・F218: 今閉じる窓も帳面に載る（決めたこと 12。2026-11-21 の PQ171-7 の答え）: サイドバーの行のメニュー・⋮⋮・プライベートの［···］・パンくずの［…］・リンクの窓・/リンクドビュー を開いたまま本文の行の ＋（押してもフォーカスが動かない部品）を押すと、閉じるだけで ＋ は動かない', T, async () => {
  const l = await openNote();
  try {
    const { P, b1, deep, nb } = l.made;
    const shut = async (name, isOpen, rowId, pageId = 'pa1') => {
      assert.ok(isOpen(), `${name}: 前提: 開かない`);
      const ins = l.called('blockInsert').length;
      const r = await pressEl(l, plusOf(l, rowId));
      assert.strictEqual(Boolean(isOpen()), false, `${name}: 行の ＋ を押しても残る`);
      assert.ok(!r.got.includes('click'), `${name}: 行の ＋ の click が届いた`);
      assert.strictEqual(l.called('blockInsert').length, ins, `${name}: 行の ＋ が行を足した`);
      assert.ok(pageId);
    };
    // サイドバーの行のメニュー
    sideRow(l, 'pa1').dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(40);
    await shut('サイドバーの行のメニュー', () => l.document.querySelector('.treemenu'), 'x');
    // ⋮⋮ のメニュー
    await clickEl(l, bodyRow(l, 'x').querySelector('.grip'), 40);
    await shut('⋮⋮ のメニュー', () => $(l, 'pNote').querySelector('.blockmenu'), 'y');
    // プライベートの［···］
    await clickEl(l, $(l, 'privMore'), 40);
    await shut('プライベートの［···］', () => !$(l, 'privMenu').hidden, 'x');
    // リンクの窓（Ctrl+K）
    let t = selectIn(l, 'x', 0, 2);
    l.key({ key: 'k', code: 'KeyK', ctrlKey: true }, t); await l.drain(40);
    await shut('リンクの窓', () => $(l, 'pNote').querySelector('#linkPop'), 'y');
    // パンくずの［…］（6 段の入れ子のいちばん下）
    await open(l, deep[5]);
    await clickEl(l, $(l, 'crumb').children.find((e) => e.dataset && e.dataset.crumb === 'more'), 40);
    await shut('パンくずの［…］', () => l.document.querySelectorAll('.treemenu').find((m) => m.getAttribute('aria-label') === '隠れた段'), nb, deep[5]);
    // /リンクドビュー の窓（白紙のページ）
    await open(l, P);
    await slashIn(l, txtOf(l, b1), '/りんく');
    l.key({ key: 'Enter', code: 'Enter' }, txtOf(l, b1)); await l.drain(200);
    await shut('/リンクドビュー の窓', () => $(l, 'pNote').querySelector('.dbpickwin'), b1, P);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-2・F218（M6）: ページの［···］は帳面で閉じる（今の document の pointerdown は消した）。中の押しでは閉じない・［···］の押しで閉じて開き直さない・開いたまま［要約を生成］を押すと閉じるだけ', T, async () => {
  const l = await openNote();
  try {
    await open(l, 'pb2');
    const menuOn = () => !$(l, 'pMenu').hidden;
    await clickEl(l, $(l, 'pMore'));
    assert.ok(menuOn(), '前提: ［···］が開かない');
    let r = await pressEl(l, $(l, 'pMenu'));
    assert.ok(menuOn(), '［···］の中を押すと閉じた');
    assert.ok(r.got.includes('mousedown'));
    await pressEl(l, l.document.querySelector('.phead'));
    assert.strictEqual(menuOn(), false, '外を押しても閉じない');
    await clickEl(l, $(l, 'pMore'));
    r = await pressEl(l, $(l, 'pMore'));
    assert.strictEqual(menuOn(), false, '［···］を押すと開き直した');
    assert.ok(!r.got.includes('click'), '［···］の click が届いた');
    await clickEl(l, $(l, 'pMore'));
    const sum = $(l, 'pActs').querySelectorAll('button').find((b) => b.textContent === '要約を生成');
    assert.ok(sum, '前提: ［要約を生成］が無い');
    r = await pressEl(l, sum);
    assert.strictEqual(menuOn(), false, '［要約を生成］を押しても［···］が残る');
    assert.deepStrictEqual(l.called('pageSummarize'), [], '［···］を閉じる押しで要約を始めた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-2・F220: 子の窓（決めたこと 4・19）: ▾ の［···］・⋮⋮ の［変換 ▸］を開いても親は残る。親の窓の中の押しは子だけを閉じ、その押しは親の項目に届く', T, async () => {
  const l = await openNote();
  try {
    const { D } = l.made;
    // ⋮⋮ → ［変換 ▸］→ 親の［複製］
    await clickEl(l, bodyRow(l, 'x').querySelector('.grip'), 40);
    const menu = $(l, 'pNote').querySelectorAll('.blockmenu').find((x) => !x.classList.contains('sub'));
    await clickEl(l, itemIn(menu, '変換 ▸'), 40);
    assert.ok($(l, 'pNote').querySelector('.blockmenu.sub'), '前提: ［変換 ▸］が開かない');
    assert.ok(menu.parentNode, '［変換 ▸］を開くと親が閉じた');
    const r = await pressEl(l, itemIn(menu, '複製'));
    assert.ok(r.got.includes('mousedown') && r.got.includes('click'), '親の項目の押しが止まった');
    await l.drain(120);
    assert.strictEqual(l.called('blockDuplicate').length, 1, '親の［複製］が1回動かない');
    assert.strictEqual($(l, 'pNote').querySelector('.blockmenu.sub'), null);
    // ▾ → ［···］→ 親の見出しの押し
    await open(l, D);
    await clickEl(l, box(l).querySelector('.dbtplbtn'));
    await clickEl(l, l.document.querySelector('.dbtplmore'));
    assert.ok(l.document.querySelector('.dbtplsub'), '前提: ▾ の［···］が開かない');
    assert.ok(l.document.querySelector('.dbtplmenu'), '▾ の［···］を開くと ▾ の窓が閉じた');
    const h = await pressEl(l, l.document.querySelector('.dbtplmenu .dbmenuhead'));
    assert.ok(h.got.includes('mousedown'), '親の窓の中の押しが止まった');
    assert.strictEqual(l.document.querySelector('.dbtplsub'), null, '親の窓の中を押しても子が残る');
    assert.ok(l.document.querySelector('.dbtplmenu'), '親の窓の中を押すと親も閉じた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('OD-2・F224: 全面の窓（決めたこと 10）: 列のメニューを開いたまま Ctrl+P・設定を開くと浮く窓は閉じる。サイドバーの［ゴミ箱］の押しは閉じるだけ（もう一度でゴミ箱）。全面の窓の中の押しで全面の窓は閉じない', T, async () => {
  const l = await openNote();
  try {
    const { D } = l.made;
    await open(l, D);
    const c = l.call('db.get', { id: D }).cols.find((x) => x.type === 'title').id;
    await clickEl(l, head(l, c));
    assert.ok(colMenu(l), '前提: 列のメニューが開かない');
    l.key({ key: 'p', code: 'KeyP', ctrlKey: true }, colMenu(l).querySelector('.mitem')); await l.drain(40);
    assert.ok(!$(l, 'palette').hidden, '前提: 検索の窓が開かない');
    assert.deepStrictEqual(pops(l).map((e) => e.className), [], '検索の窓を開いても列のメニューが残る');
    const r = await pressEl(l, $(l, 'searchBox'));
    assert.ok(!$(l, 'palette').hidden && r.got.includes('mousedown'), '全面の窓の中の押しを帳面が止めたか閉じた');
    l.key({ key: 'Escape' }, $(l, 'searchBox')); await l.drain(40);
    await clickEl(l, head(l, c));
    l.fire('onOpenSettings'); await l.drain(60);
    assert.deepStrictEqual(pops(l).map((e) => e.className), [], '設定を開いても列のメニューが残る');
    l.key({ key: 'Escape' }, l.document.activeElement); await l.drain(40);
    await clickEl(l, head(l, c));
    await pressEl(l, $(l, 'tabBtnTrash'));
    assert.ok($(l, 'trashPop').hidden, '列のメニューを閉じる押しでゴミ箱が開いた');
    assert.deepStrictEqual(pops(l).map((e) => e.className), []);
    await pressEl(l, $(l, 'tabBtnTrash'));
    assert.ok(!$(l, 'trashPop').hidden, 'もう一度押してもゴミ箱が開かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- OD-5（第3版。決めたこと 23・F218。2026-11-22 の PQ171-11「/ だけ Notion に合わせる（おすすめ）」）
test('OD-5・F218: / メニューの外の押しは通す（N171-6・PQ171-11）: / メニューを開いたまま本文の別の行の字・サイドバーの別のページ・本文の行の ＋ を押すと、閉じて押した所も動く（止める印を立てない）。閉じた後に元の行で続けて打っても開き直さない（R12）。列のメニューの外の押しは今までどおり閉じるだけ', T, async () => {
  const l = await openNote();
  try {
    const { P, D, b1 } = l.made;
    const slashOn = () => $(l, 'pNote').querySelector('.slashmenu');
    const all = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
    // (a) 本文の別の行の字: 閉じて、押した行に押しが全部届き、フォーカス（カーソル）がその行へ移る
    await slashIn(l, txtOf(l, 'y'), '/');
    assert.ok(slashOn(), '前提: / メニューが開かない');
    let r = await pressEl(l, txtOf(l, 'x'));
    assert.strictEqual(Boolean(slashOn()), false, '(a) 本文の別の行を押しても / メニューが残る');
    assert.deepStrictEqual(all.filter((t) => !r.got.includes(t)), [], '(a) 押した行に届かない事象がある（閉じるだけになった）');
    assert.ok(!r.events.pointerdown.defaultPrevented && !r.events.mousedown.defaultPrevented, '(a) 押しの既定（フォーカスの移り・カーソル）を止めた');
    assert.ok(active(l) === txtOf(l, 'x'), '(a) フォーカス（カーソル）が押した行へ移らない');
    assert.strictEqual(txtOf(l, 'y').textContent, '/', '(a) 打った / が行に残らない');
    // 止める印が立たない: すぐ同じ所をもう一度押しても届く
    r = await pressEl(l, txtOf(l, 'x'));
    assert.deepStrictEqual(all.filter((t) => !r.got.includes(t)), [], '(a) 閉じた後の押しが止まる（止める印が残る）');
    // (d) 閉じた後に元の行で続けて打っても、その / では開き直さない（R12）
    await slashIn(l, txtOf(l, 'y'), '/み');
    assert.strictEqual(Boolean(slashOn()), false, '(d) 閉じた / の行で続けて打つと / メニューが開き直した');
    // 右の押しも通す（決めたこと 23）: 閉じて、押した行の右の押しのメニュー（⋮⋮ のメニュー）が開く
    await slashIn(l, txtOf(l, 'x'), 'あいうえお /');
    assert.ok(slashOn(), '前提: / メニューが開かない（x）');
    r = await pressEl(l, txtOf(l, 'y'), { button: 2 });
    assert.strictEqual(Boolean(slashOn()), false, '右の押しで / メニューが残る');
    assert.ok(r.got.includes('contextmenu'), '右の押しの contextmenu が届かない');
    assert.ok($(l, 'pNote').querySelector('.blockmenu'), '右の押しで押した行のメニューが開かない');
    l.key({ key: 'Escape' }, active(l)); await l.drain(40);
    // (c) 本文の行の ＋（押してもフォーカスが動かない部品）: 閉じて、＋ も動く（0.17.0 では / メニューが残った: 監査の表の 24）
    await open(l, 'pa1');
    await slashIn(l, txtOf(l, 'y'), '/');
    assert.ok(slashOn(), '前提: / メニューが開かない（＋）');
    const ins = l.called('blockInsert').length;
    r = await pressEl(l, plusOf(l, 'x'));
    assert.ok(r.got.includes('click'), '(c) 行の ＋ の click が届かない');
    await l.drain(120);
    assert.strictEqual(l.called('blockInsert').length, ins + 1, '(c) 行の ＋ が行を足さない');
    // 元の行（y）の / メニューは閉じ、開いているのは ＋ が足した行の / メニューだけ（＋ は足した行で / メニューを開く: E1）
    const opened = $(l, 'pNote').querySelectorAll('.blk').filter((e) => e.querySelector('.txt') && e.querySelector('.txt').getAttribute('aria-expanded') === 'true').map((e) => e.dataset.id);
    assert.strictEqual(opened.length, 1, `(c) / メニューの開いた行が1つでない（${opened.join(',')}）`);
    assert.ok(!['x', 'y'].includes(opened[0]), `(c) 元の行の / メニューが閉じない（${opened[0]}）`);
    l.key({ key: 'Escape' }, active(l)); await l.drain(40);
    // (b) サイドバーの別のページの行: 閉じて、そのページが開く
    await open(l, P);
    await slashIn(l, txtOf(l, b1), '/');
    assert.ok(slashOn(), '前提: / メニューが開かない（白紙のページ）');
    r = await pressEl(l, sideRow(l, 'pa1'));
    await l.drain(120);
    assert.strictEqual(Boolean(slashOn()), false, '(b) サイドバーのページを押しても / メニューが残る');
    assert.ok(r.got.includes('click'), '(b) サイドバーの行の click が届かない');
    assert.ok(bodyRow(l, 'x'), '(b) サイドバーのページが開かない');
    // (e) 通す印はほかの窓に広がらない: 列のメニューの外の押しは今までどおり閉じるだけ
    l.call('row.add', { db: D, title: '一' });   // 行の題名（D77 の外）
    await open(l, D);
    const c = l.call('db.get', { id: D }).cols.find((x) => x.type === 'title').id;
    await clickEl(l, head(l, c));
    assert.ok(colMenu(l), '前提: 列のメニューが開かない');
    const cell = box(l).querySelectorAll('.dbcell').find((e) => e.dataset.col === c);
    assert.ok(cell, '前提: セルが無い');
    r = await pressEl(l, cell);
    assert.strictEqual(Boolean(colMenu(l)), false, '(e) 列のメニューが残る');
    assert.deepStrictEqual(r.got.filter((t) => all.includes(t)), [], '(e) 列のメニューの外の押しが押したセルに届いた（通す印が広がった）');
    assert.deepStrictEqual(selCells(l), [], '(e) 押したセルが選ばれた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
