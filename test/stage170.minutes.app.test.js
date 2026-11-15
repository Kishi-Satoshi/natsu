/* stage170.minutes.app.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の第3部の画面
 *  LK-1（決めたこと 55・73〜77・F204）: データベースのロック（「···」の切り替え・題名の右の「ロック中」・灰色の［削除］と吹き出し・メニューの項目・表の右端の［＋］）
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

// ---------------------------------------------------------------- MG-3（決めたこと 54〜57・F197・F198）
const palLines = (l) => $(l, 'palList').querySelectorAll('.pitem').map((e) => [e.dataset.pid, e.querySelector('.m').textContent]);
const MEET = (id, at, date) => ({ title: titleAt(at), date, createdAt: at, blocks: [{ id: `${id}h`, type: 'heading', text: '要点' }, { id: `${id}b`, type: 'bullet', text: '予算の案を作る' }] });
function minutesSeed(call) {
  call('meeting.finalize', { pageId: 'pm1', page: MEET('pm1', '2026-11-10T01:30:00.000Z', '2026-11-10'), segments: [] }, 'main');
  call('meeting.finalize', { pageId: 'pm2', page: MEET('pm2', '2026-11-11T02:00:00.000Z', '2026-11-11'), segments: [] }, 'main');
  const M = call('pages.list', {}).find((p) => p.minutes).id;
  const kid = call('page.create', { parentId: 'pm1' }).id;
  call('page.setTitle', { id: kid, title: '会議の宿題' });   // 白紙のページの題名（D77 の外）
  const blank = call('page.create', {}).id;
  call('page.setTitle', { id: blank, title: '計画' });   // 白紙のページの題名（D77 の外）
  return { M, kid, blank };
}

test('MG-3・F198: 議事録と議事録の子ページはサイドバーの木とライブラリに出ず、「議事録」データベースの行がいちばん上（後で作ったページより上）。中の議事録の「···」に［移動先…］が無い（議事録の子ページにはある）', T, async () => {
  const l = await realApp({ before: (call) => minutesSeed(call) });
  try {
    const { M, kid, blank } = l.made;
    const ids = () => $(l, 'plist').querySelectorAll('.pitem').map((r) => r.dataset.pid).filter(Boolean);
    assert.strictEqual(ids()[0], M, '「議事録」の行がいちばん上でない');
    assert.ok(ids().includes(blank));
    for (const id of ['pm1', 'pm2', kid]) assert.ok(!ids().includes(id), `${id} がサイドバーの木に出た`);
    sideRow(l, M).querySelector('.pi').dispatchEvent({ type: 'click' }); await l.drain(80);   // 「議事録」の ▸ を開く（下はビューの行だけ）
    assert.ok($(l, 'plist').querySelectorAll('.pview').length >= 1, '前提: 「議事録」の ▸ を開けない');
    for (const id of ['pm1', 'pm2', kid]) assert.ok(!ids().includes(id), `${id} が「議事録」の ▸ の下に出た`);
    $(l, 'privLib').dispatchEvent({ type: 'click' }); await l.drain(80);
    const lib = $(l, 'libRows') ? $(l, 'libRows').querySelectorAll('[data-pid]').map((r) => r.dataset.pid) : [];
    for (const id of ['pm1', 'pm2', kid]) assert.ok(!lib.includes(id), `${id} がライブラリに出た`);
    await open(l, 'pm1');
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    assert.ok(!moreItem(l, '移動先…'), '中の議事録に［移動先…］が出た');
    await open(l, kid);
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    assert.ok(moreItem(l, '移動先…'), '議事録の子ページに［移動先…］が無い');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('MG-3・F197: 検索の窓の2行目は、議事録は今と同じ文（場所を付けない）・議事録の子ページは「場所: 議事録の題名」（「議事録」を付けない）', T, async () => {
  const l = await realApp({ before: (call) => minutesSeed(call) });
  try {
    const { kid } = l.made;
    $(l, 'sideSearch').dispatchEvent({ type: 'click' }); await l.drain(80);
    const got = new Map(palLines(l));
    const t1 = l.call('page.get', { id: 'pm1' }).page.title;
    assert.ok(got.has('pm1') && !got.get('pm1').includes('場所:'), `議事録に場所を付けた: ${got.get('pm1')}`);
    assert.ok(String(got.get(kid)).startsWith(`場所: ${t1} ・ `), `議事録の子ページの場所: ${got.get(kid)}`);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('MG-3（決めたこと 56）: sideSection.sectionRows の pin（「議事録」）は、手動・最終更新のどちらの並べ替えでも、表示の数を絞っても、いちばん上の段の頭。画面の写しも同じ答え', () => {
  const SS = require('../src/sideSection');
  const fs = require('node:fs');
  const path = require('node:path');
  const PT = require('../src/pageTree');
  const at = (d) => `2026-11-${d}T00:00:00.000Z`;
  const tree = PT.pageTree([{ id: 'pa', parentId: null, ord: 'i', createdAt: at(10), updatedAt: at(10) }, { id: 'pM', parentId: null, ord: 'i', createdAt: at('01'), updatedAt: at('01') },
    { id: 'pb', parentId: null, ord: 'i', createdAt: at(12), updatedAt: at(12) }]);
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.html'), 'utf8');
  const seg = html.slice(html.indexOf('  // ---- sideSection の写し'), html.indexOf('  // ---- sideSection の写しはここまで'));
  const app = new Function(`${seg}\nreturn sideSectionView;`)();   // eslint-disable-line no-new-func
  for (const o of [{}, { sort: 'edited' }, { show: 5 }]) {
    for (const S of [SS, app]) {
      assert.deepStrictEqual(S.sectionRows(tree, new Set(), { ...o, pin: 'pM' }).rows.map((r) => r.id), ['pM', 'pb', 'pa'], JSON.stringify(o));
      assert.deepStrictEqual(S.sectionRows(tree, new Set(), o).rows.map((r) => r.id), ['pb', 'pa', 'pM'], '前提: pin が無ければ今の並び');
    }
  }
});

// ---------------------------------------------------------------- MG-4（決めたこと 52・53・56・F198）: 「議事録」データベースの画面
const dbRowIds = (l) => $(l, 'pDb').querySelectorAll('.dbrow').map((r) => r.dataset.id);
const cellIn = (l, rowId, colId) => $(l, 'pDb').querySelectorAll('.dbrow').find((r) => r.dataset.id === rowId).querySelectorAll('.dbcell').find((c) => c.dataset.col === colId);
const AUTO = '議事録から自動で入ります';

test('MG-4・F198: 「議事録」の表に議事録の行（日時の新しい順）・日付と作成者と要約のセルは灰色で「議事録から自動で入ります」・［＋ 新しい議事録］で録音の前のページ・「···」の［サブアイテム］は灰色・行を押すと議事録のページ（［AI 要約］の形）とパンくず「議事録 / 題名」', T, async () => {
  let prepared = 0;
  const l = await realApp({ before: (call) => minutesSeed(call), returns: { meetingPrepare: () => { prepared += 1; return { ok: false }; }, meetingStatus: () => ({ active: false }) } });
  try {
    const { M } = l.made;
    await open(l, M);
    assert.deepStrictEqual(dbRowIds(l), ['pm2', 'pm1'], '議事録の行が日時の新しい順でない');
    const cols = l.call('db.get', { id: M }).cols;
    for (const c of cols) {
      const cell = cellIn(l, 'pm1', c.id);
      const auto = ['mdate', 'cby', 'msum'].includes(c.type);
      assert.strictEqual(cell.classList.contains('dbauto'), auto, `${c.name} の灰色`);
      assert.strictEqual(cell.title === AUTO, auto, `${c.name} の吹き出し`);
    }
    const add = $(l, 'pDb').querySelector('.dbadd');
    assert.strictEqual(add.textContent, '＋ 新しい議事録');
    await clickEl(l, add);
    assert.strictEqual(prepared, 1, '［＋ 新しい議事録］で録音の前のページを開かない');
    assert.deepStrictEqual(l.called('rowAdd'), [], '［＋ 新しい議事録］でふつうの行を作った');
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    const sub = moreItem(l, 'サブアイテム');
    assert.ok(sub && sub.getAttribute('aria-disabled') === 'true', '「議事録」の［サブアイテム］が灰色でない');
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    // 行のメニューの［開く］で議事録のページ（今のタブ）
    $(l, 'pDb').querySelectorAll('.dbrow').find((r) => r.dataset.id === 'pm1').dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(20);
    await clickEl(l, l.document.querySelector('.dbrowmenu').querySelectorAll('.mitem').find((b) => b.textContent === '開く'), 200);
    assert.ok(!$(l, 'pageWrap').classList.contains('blank') && !$(l, 'pageWrap').classList.contains('row') && !$(l, 'pageWrap').classList.contains('db'), '議事録のページの形でない');
    assert.ok(!$(l, 'paneBtnNote').hidden && $(l, 'paneBtnNote').textContent === 'AI 要約');
    const crumbs = $(l, 'crumb').children.filter((e) => e.dataset && e.dataset.crumb === 'up').map((e) => e.dataset.pid);
    assert.deepStrictEqual(crumbs, [M], 'パンくずが「議事録 / 題名」でない');
    const ti = l.document.querySelector('.tabitem.active .ti');
    assert.strictEqual(ti && ti.getAttribute('data-icon'), 'ic:mic', 'タブのアイコンが議事録の既定（マイク）でない（行のページの扱い）');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('MG-4（決めたこと 56）: 議事録の無い「議事録」の表には、空のときの文（「議事録はありません」と［＋ 新しい議事録］の案内）', T, async () => {
  const l = await realApp({ before: (call) => {
    call('meeting.finalize', { pageId: 'pm1', page: MEET('pm1', '2026-11-10T01:30:00.000Z', '2026-11-10'), segments: [] }, 'main');
    const M = call('pages.list', {}).find((p) => p.minutes).id;
    call('page.delete', { id: 'pm1' });
    return { M };
  } });
  try {
    await open(l, l.made.M);
    const e = $(l, 'pDb').querySelector('.dbempty');
    assert.ok(e, '空のときの文が無い');
    assert.strictEqual(e.textContent, '議事録はありません［＋ 新しい議事録］で会議を録音すると、要約と文字起こしが作られます。');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- TK-1（決めたこと 60〜62・65・F200）
test('TK-1・F200: サイドバーは「議事録」の下に「タスク管理」・▸ を開くとビューの行「すべて」「マイタスク」「期限順」・「マイタスク」の行で開く・担当の候補の先頭が「自分」', T, async () => {
  const l = await realApp({ before: (call) => {
    minutesSeed(call);
    const g = call('minutes.gather', { first: true }, 'main');
    call('row.add', { db: g.tasks, title: '見積もり' });   // タスクの題名（D77 の外）
    call('page.create', {});   // 「タスク管理」より後に作った白紙のページ（固定が無ければ上に並ぶ）
    return { M: g.db, K: g.tasks };
  } });
  try {
    const { M, K } = l.made;
    const ids = $(l, 'plist').querySelectorAll('.pitem').map((r) => r.dataset.pid).filter(Boolean);
    assert.deepStrictEqual(ids.slice(0, 2), [M, K], '「タスク管理」が「議事録」の下でない');
    sideRow(l, K).querySelector('.pi').dispatchEvent({ type: 'click' }); await l.drain(80);
    const views = $(l, 'plist').querySelectorAll('.pview').filter((v) => String(v.dataset.vkey).startsWith(`${K}/`));
    assert.deepStrictEqual(views.map((v) => v.textContent), ['•すべて', '•マイタスク', '•期限順']);
    await clickEl(l, views[1], 300);
    const tab = $(l, 'pDb').querySelectorAll('.dbtab').find((b) => b.getAttribute('aria-selected') === 'true');
    assert.ok(tab && tab.textContent.includes('マイタスク'), '「マイタスク」で開かない');
    // 担当の候補（「すべて」のビューで担当のセルを書く）
    await clickEl(l, $(l, 'pDb').querySelectorAll('.dbtab').find((b) => b.textContent.includes('すべて')), 200);
    const who = l.call('db.get', { id: K }).cols.find((c) => c.name === '担当').id;
    const cell = $(l, 'pDb').querySelectorAll('.dbrow')[0].querySelectorAll('.dbcell').find((c) => c.dataset.col === who);
    await clickEl(l, cell, 40); await clickEl(l, cell, 80);
    const opts = $(l, 'pDb').querySelectorAll('.dbpicklist .dbopt');
    assert.ok(opts.length && opts[0].textContent.includes('自分'), `担当の候補の先頭が「自分」でない: ${opts.map((o) => o.textContent)}`);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
