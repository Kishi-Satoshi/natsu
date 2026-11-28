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

// ---------------------------------------------------------------- 問い 5 の 1（M20・R85。2026-11-15 の持ち主の答え「ページと同じ 1 行にそろえる（おすすめ）」）
const selBtn = (l, label) => $(l, 'pDb').querySelector('.dbselbar').querySelectorAll('button').find((b) => b.textContent === label);
const rowEl = (l, id) => $(l, 'pDb').querySelectorAll('.dbrow').find((x) => x.dataset.id === id);
const checkRow = async (l, id) => { const ck = rowEl(l, id).querySelector('.dbcheck'); ck.checked = true; ck.dispatchEvent({ type: 'change' }); await l.drain(20); };
const rowMenuCopy = async (l, id) => {
  rowEl(l, id).dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(20);
  await clickEl(l, l.document.querySelector('.dbrowmenu').querySelectorAll('.mitem').find((b) => b.textContent === 'リンクを写す'), 100);
};
test('問い 5・M20（R85）: 「議事録」の表で選んだ行の［リンクを写す］と行のメニューの［リンクを写す］は、ページの「···」の［リンクを写す］と同じ1行（「NaTsu の議事録「題名」（日付）住所」）。ほかのデータベースの行は今どおり「NaTsu の「題名」 住所」', T, async () => {
  const B = 'https://example.invalid/open#p=';
  const l = await realApp({ before: (call) => {
    const s = minutesSeed(call);
    const D = call('db.create', {}).id;
    call('db.setTitle', { db: D, title: '名簿' });   // データベースの題名（D77 の外）
    const r = call('row.add', { db: D, title: '一' }).id;   // 行の題名（D77 の外）
    return { ...s, D, r };
  } });
  try {
    const { M, D, r } = l.made;
    const last = () => l.called('copy').map((c) => c.args[0]).slice(-1);
    // ページの「···」の［リンクを写す］（議事録の形）
    const pageLine = {};
    for (const id of ['pm1', 'pm2']) {
      await open(l, id);
      $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
      await clickEl(l, moreItem(l, 'リンクを写す'));
      [pageLine[id]] = last();
    }
    assert.strictEqual(pageLine.pm1, `NaTsu の議事録「${titleAt('2026-11-10T01:30:00.000Z')}」（2026-11-10）${B}pm1`, '前提: ページの「···」の1行が議事録の形でない');
    assert.strictEqual(pageLine.pm2, `NaTsu の議事録「${titleAt('2026-11-11T02:00:00.000Z')}」（2026-11-11）${B}pm2`);
    // 「議事録」の表で行の頭のチェックを入れて［リンクを写す］・行のメニューの［リンクを写す］
    await open(l, M);
    await checkRow(l, 'pm2'); await checkRow(l, 'pm1');
    await clickEl(l, selBtn(l, 'リンクを写す'));
    assert.deepStrictEqual(last(), [`${pageLine.pm2}\n${pageLine.pm1}`], '表で選んだ議事録の行の1行がページの「···」と違う');
    await rowMenuCopy(l, 'pm1');
    assert.deepStrictEqual(last(), [pageLine.pm1], '行のメニューの議事録の1行がページの「···」と違う');
    // ほかのデータベースの行は今どおり（R87）
    await open(l, D);
    await checkRow(l, r);
    await clickEl(l, selBtn(l, 'リンクを写す'));
    assert.deepStrictEqual(last(), [`NaTsu の「一」 ${B}${r}`]);
    await rowMenuCopy(l, r);
    assert.deepStrictEqual(last(), [`NaTsu の「一」 ${B}${r}`]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- TK-1（決めたこと 60〜62・65・F200）
// 0.18.2 TD-1（計画 docs/plans/2026-11-28-182.md の決めたこと 1・2・「意図して変えるテスト」）: 最初の移し替えは「タスク管理」を作らない。前の形（「タスク管理」がある）を、
// ToDo のある議事録を1つ足して［タスクにする］（todo.toTask の1回）で作り直す → { K（「タスク管理」）, row（作った行） }
function tasksDbVia(call) {
  const at = '2026-11-09T01:00:00.000Z';
  call('meeting.finalize', { pageId: 'pk0', page: { title: titleAt(at), date: '2026-11-09', createdAt: at, blocks: [{ id: 'pk0t0', type: 'todo', text: '段取りを決める', checked: false }] }, segments: [] }, 'main');
  const r = call('todo.toTask', { pageId: 'pk0', blockId: 'pk0t0' });
  return { K: r.db, row: r.id };
}
// 0.18.2 TD-1（計画 docs/plans/2026-11-28-182.md の「意図して変えるテスト」）で意図して変えた: 「タスク管理」を minutes.gather の答え（tasks）でなく tasksDbVia で作る
test('TK-1・F200: サイドバーは「議事録」の下に「タスク管理」・▸ を開くとビューの行「すべて」「マイタスク」「期限順」・「マイタスク」の行で開く・担当の候補の先頭が「自分」', T, async () => {
  const l = await realApp({ before: (call) => {
    minutesSeed(call);
    const g = call('minutes.gather', { first: true }, 'main');
    const { K } = tasksDbVia(call);
    call('row.add', { db: K, title: '見積もり' });   // タスクの題名（D77 の外）
    call('page.create', {});   // 「タスク管理」より後に作った白紙のページ（固定が無ければ上に並ぶ）
    return { M: g.db, K };
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

// ---------------------------------------------------------------- TK-2（決めたこと 63・F199）
const todoRow = (l, id) => $(l, 'pNote').querySelectorAll('.blk').find((e) => e._b && e._b.id === id);
const taskBtnOf = (l, id) => { const r = todoRow(l, id); return r ? r.querySelector('.totask') : null; };
test('TK-2・F199: 議事録の ToDo の行に［タスクにする］（aria-label「『文』をタスクにする」）。押す・Enter で1回（変換中の Enter では押さない）・知らせ・［タスクを開く］でその行のページ。Ctrl+Z で行と印が一緒に戻る', T, async () => {
  const l = await realApp({ before: (call) => {
    const at = '2026-11-12T01:00:00.000Z';
    call('meeting.finalize', { pageId: 'pw1', page: { title: titleAt(at), date: '2026-11-12', createdAt: at, blocks: [{ id: 'pw1h', type: 'heading', text: 'ToDo' },
      { id: 'pw1t0', type: 'todo', text: '見積もりを出す', checked: false, assignee: 'メンバー甲' }, { id: 'pw1t1', type: 'todo', text: '資料を集める', checked: false }] }, segments: [] }, 'main');
    call('minutes.gather', { first: true }, 'main');   // 0.18.2 TD-1（計画 docs/plans/2026-11-28-182.md の「意図して変えるテスト」）で意図して変えた: 答えの tasks（使っていない）を返さない
    // 0.18.2 TD-2（計画 docs/plans/2026-11-28-182.md の決めたこと 5・「意図して変えるテスト」）で意図して変えた: 「タスク管理」を先に作っておく（前の形。初めて作ったときの知らせは
    // stage182.app.test.js の F265 で見る）。ここで見る知らせは今の「タスクにしました（Ctrl+Z で戻せます）」のまま
    tasksDbVia(call);
    return {};
  } });
  try {
    await open(l, 'pw1');
    const b0 = taskBtnOf(l, 'pw1t0');
    assert.ok(b0 && b0.textContent === 'タスクにする' && b0.getAttribute('aria-label') === '『見積もりを出す』をタスクにする', '［タスクにする］が無い');
    l.key({ key: 'Enter', isComposing: true, keyCode: 229 }, b0); await l.drain(80);
    assert.deepStrictEqual(l.called('todoToTask'), [], '変換中の Enter で押した');
    l.key({ key: 'Enter' }, b0); await l.drain(300);
    assert.deepStrictEqual(l.called('todoToTask').map((c) => c.args), [['pw1', 'pw1t0']]);
    assert.strictEqual($(l, 'toast').textContent, 'タスクにしました（Ctrl+Z で戻せます）');
    const rowId = l.call('page.get', { id: 'pw1' }).page.blocks.find((b) => b.id === 'pw1t0').task;
    assert.ok(rowId, 'ToDo に印が無い');
    const b1 = taskBtnOf(l, 'pw1t0');
    assert.ok(b1 && b1.textContent === 'タスクを開く' && b1.getAttribute('aria-label') === '『見積もりを出す』のタスクを開く', '［タスクを開く］にならない');
    // Ctrl+Z（要約の欄）で行と印が一緒に戻る
    todoRow(l, 'pw1t1')._txt.focus();
    l.key({ key: 'z', ctrlKey: true }, todoRow(l, 'pw1t1')._txt); await l.drain(400);
    assert.strictEqual(l.call('page.get', { id: 'pw1' }).page.blocks.find((b) => b.id === 'pw1t0').task, undefined, 'Ctrl+Z で印が戻らない');
    assert.ok(l.db.prepare('select trashed_at from blocks where id = ?').get(rowId).trashed_at, 'Ctrl+Z で行が戻らない');
    // もう一度タスクにして、［タスクを開く］でその行のページ
    await clickEl(l, taskBtnOf(l, 'pw1t0'), 300);
    const row2 = l.call('page.get', { id: 'pw1' }).page.blocks.find((b) => b.id === 'pw1t0').task;
    await clickEl(l, taskBtnOf(l, 'pw1t0'), 300);
    assert.strictEqual(l.document.querySelector('.tabitem.active').dataset.key, `page:${row2}`, '［タスクを開く］でその行のページを開かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- TK-3（決めたこと 64・F201）
test('TK-3・F201: 検索の窓の［アクション］には、タスクにしていない ToDo も今どおり出て、タスクにした ToDo の行には［タスクを開く］（押すとその行のページ）', T, async () => {
  const l = await realApp({ before: (call) => {
    const at = '2026-11-12T01:00:00.000Z';
    call('meeting.finalize', { pageId: 'pw1', page: { title: titleAt(at), date: '2026-11-12', createdAt: at, blocks: [
      { id: 'pw1t0', type: 'todo', text: '見積もりを出す', checked: false }, { id: 'pw1t1', type: 'todo', text: '資料を集める', checked: false }] }, segments: [] }, 'main');
    call('minutes.gather', { first: true }, 'main');
    return { row: call('todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }).id };
  }, returns: { pagesActionView: (o) => l.call('pages.actionView', o || {}) } });
  try {
    $(l, 'sideSearch').dispatchEvent({ type: 'click' }); await l.drain();
    $(l, 'fltActions').dispatchEvent({ type: 'click' }); await l.drain();
    const rows = $(l, 'palList').querySelectorAll('.actrow');
    const texts = rows.map((r) => r.querySelector('.body').firstChild.textContent).sort();
    assert.deepStrictEqual(texts, ['見積もりを出す', '資料を集める'], 'タスクにしていない ToDo がアクション一覧から消えた');
    const tasked = rows.find((r) => r.textContent.includes('見積もりを出す'));
    const other = rows.find((r) => r.textContent.includes('資料を集める'));
    assert.ok(!other.querySelector('.totask'), 'タスクにしていない ToDo に［タスクを開く］');
    const b = tasked.querySelector('.totask');
    assert.ok(b && b.textContent === 'タスクを開く' && b.getAttribute('aria-label') === '『見積もりを出す』のタスクを開く');
    await clickEl(l, b, 300);
    assert.strictEqual(l.document.querySelector('.tabitem.active').dataset.key, `page:${l.made.row}`);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 点検 3 の後の問い 4（2026-11-15 の持ち主の答え「押したら作り直す（おすすめ）」・R81・R82）
const markOf = (l, pid, bid) => l.call('page.get', { id: pid }).page.blocks.find((b) => b.id === bid).task;
test('問い 4・R82: ゴミ箱に入ったタスクの［タスクを開く］は、行を開かずに［タスクにする］と同じに作り直す（todo.toTask の1回・知らせ「タスクにしました（Ctrl+Z で戻せます）」・新しい行に印）。生きているタスクは今どおり開く', T, async () => {
  const l = await realApp({ before: (call) => {
    const at = '2026-11-12T01:00:00.000Z';
    call('meeting.finalize', { pageId: 'pw1', page: { title: titleAt(at), date: '2026-11-12', createdAt: at, blocks: [
      { id: 'pw1t0', type: 'todo', text: '見積もりを出す', checked: false }, { id: 'pw1t1', type: 'todo', text: '資料を集める', checked: false }] }, segments: [] }, 'main');
    call('minutes.gather', { first: true }, 'main');
    // 0.18.2 TD-1（計画 docs/plans/2026-11-28-182.md の「意図して変えるテスト」）で意図して変えた: 「タスク管理」は最初の todo.toTask が作ったもの
    const first = call('todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' });
    const K = first.db; const gone = first.id;
    const live = call('todo.toTask', { pageId: 'pw1', blockId: 'pw1t1' }).id;
    call('rows.trash', { db: K, ids: [gone] });
    return { K, gone, live };
  } });
  try {
    const { gone, live } = l.made;
    await open(l, 'pw1');
    const b0 = taskBtnOf(l, 'pw1t0');
    assert.ok(b0 && b0.textContent === 'タスクを開く', '印のある ToDo が［タスクを開く］でない');
    await clickEl(l, b0, 400);
    assert.deepStrictEqual(l.called('todoToTask').map((c) => c.args), [['pw1', 'pw1t0']], 'ゴミ箱のタスクの［タスクを開く］で作り直さない');
    assert.strictEqual($(l, 'toast').textContent, 'タスクにしました（Ctrl+Z で戻せます）');
    const now = markOf(l, 'pw1', 'pw1t0');
    assert.ok(now && now !== gone, '印が新しい行を指さない');
    assert.strictEqual(l.db.prepare('select trashed_at from blocks where id = ?').get(now).trashed_at, null, '新しい行が生きていない');
    assert.strictEqual(l.document.querySelector('.tabitem.active').dataset.key, 'page:pw1', 'ゴミ箱の行のページへ移った');
    // 生きているタスクは今どおり開く（作り直さない）
    await clickEl(l, taskBtnOf(l, 'pw1t1'), 400);
    assert.strictEqual(l.called('todoToTask').length, 1, '生きているタスクを作り直した');
    assert.strictEqual(l.document.querySelector('.tabitem.active').dataset.key, `page:${live}`, '生きているタスクを開かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('問い 4・R82: 「タスク管理」データベースがゴミ箱なら、行が生きていても［タスクを開く］は作り直す（todo.toTask と同じ「生きている」の見方: R71）', T, async () => {
  const l = await realApp({ before: (call) => {
    const at = '2026-11-12T01:00:00.000Z';
    call('meeting.finalize', { pageId: 'pw1', page: { title: titleAt(at), date: '2026-11-12', createdAt: at, blocks: [
      { id: 'pw1t0', type: 'todo', text: '見積もりを出す', checked: false }] }, segments: [] }, 'main');
    call('minutes.gather', { first: true }, 'main');
    // 0.18.2 TD-1（計画 docs/plans/2026-11-28-182.md の「意図して変えるテスト」）で意図して変えた: 「タスク管理」は最初の todo.toTask が作ったもの
    const first = call('todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' });
    const K = first.db; const row = first.id;
    call('page.delete', { id: K });
    return { K, row };
  } });
  try {
    const { row } = l.made;
    assert.strictEqual(l.db.prepare('select trashed_at from blocks where id = ?').get(row).trashed_at, null, '前提: 行そのものは生きている');
    await open(l, 'pw1');
    await clickEl(l, taskBtnOf(l, 'pw1t0'), 400);
    assert.deepStrictEqual(l.called('todoToTask').map((c) => c.args), [['pw1', 'pw1t0']], 'ゴミ箱のデータベースの行の［タスクを開く］で作り直さない');
    // 0.18.2 TD-2（計画 docs/plans/2026-11-28-182.md の決めたこと 5・AQ182-5・「意図して変えるテスト」）で意図して変えた: 「タスク管理」がゴミ箱なので、この1回で「タスク管理」を
    // 作り直す（R7）。知らせは「作った」の字
    assert.strictEqual($(l, 'toast').textContent, '「タスク管理」を作って、タスクにしました（タスクは Ctrl+Z で戻せます）');
    assert.notStrictEqual(markOf(l, 'pw1', 'pw1t0'), row, '印が新しい行を指さない');
    assert.strictEqual(l.document.querySelector('.tabitem.active').dataset.key, 'page:pw1', 'ゴミ箱のデータベースの行のページへ移った');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('問い 4・R82: 検索の窓の［アクション］の［タスクを開く］も、消えたタスク（行が無い）なら同じに作り直す（todo.toTask の1回・同じ知らせ）', T, async () => {
  const l = await realApp({ before: (call) => {
    const at = '2026-11-12T01:00:00.000Z';
    call('meeting.finalize', { pageId: 'pw1', page: { title: titleAt(at), date: '2026-11-12', createdAt: at, blocks: [
      { id: 'pw1t0', type: 'todo', text: '見積もりを出す', checked: false }] }, segments: [] }, 'main');
    call('minutes.gather', { first: true }, 'main');
    return { row: call('todo.toTask', { pageId: 'pw1', blockId: 'pw1t0' }).id };
  }, returns: { pagesActionView: (o) => l.call('pages.actionView', o || {}) } });
  try {
    l.db.prepare('delete from blocks where id = ?').run(l.made.row);   // ゴミ箱から消えた行（完全に消した後）
    $(l, 'sideSearch').dispatchEvent({ type: 'click' }); await l.drain();
    $(l, 'fltActions').dispatchEvent({ type: 'click' }); await l.drain();
    const b = $(l, 'palList').querySelectorAll('.actrow').find((r) => r.textContent.includes('見積もりを出す')).querySelector('.totask');
    assert.ok(b && b.textContent === 'タスクを開く');
    await clickEl(l, b, 400);
    assert.deepStrictEqual(l.called('todoToTask').map((c) => c.args), [['pw1', 'pw1t0']], '消えたタスクの［タスクを開く］で作り直さない');
    assert.strictEqual($(l, 'toast').textContent, 'タスクにしました（Ctrl+Z で戻せます）');
    const now = markOf(l, 'pw1', 'pw1t0');
    assert.ok(now && now !== l.made.row && l.db.prepare('select trashed_at from blocks where id = ?').get(now).trashed_at === null, '印が生きている新しい行を指さない');
    assert.notStrictEqual((l.document.querySelector('.tabitem.active') || { dataset: {} }).dataset.key, `page:${l.made.row}`, '消えた行のページへ移った');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- RT-2（決めたこと 67・68・F202）: 行のテンプレートの画面
const tplMenu = (l) => l.document.querySelector('.dbtplmenu');
const tplRows = (l) => (tplMenu(l) ? tplMenu(l).querySelectorAll('.dbtplrow') : []);
const tplMain = (l, name) => tplRows(l).map((r) => r.querySelector('.dbtplpick')).find((b) => b && b.querySelector('.dbtplname').textContent === name);
const tplMoreOf = (l, name) => tplRows(l).find((r) => r.querySelector('.dbtplname').textContent === name).querySelector('.dbtplmore');
const openTpl = async (l) => { await clickEl(l, $(l, 'pDb').querySelector('.dbtplbtn'), 60); };
test('RT-2・F202: ［＋ 新しい行］の右の ▾（aria-label「テンプレートを選ぶ」）の窓: 見出し「テンプレート」・名前（無題は「無題のテンプレート」）・「空白のページ」と「既定」の札・［＋ 新しいテンプレート］・↑↓・Esc。［···］は［既定にする］［編集］［複製］［削除］（「空白のページ」は［既定にする］だけ）', T, async () => {
  const l = await realApp({ before: (call) => {
    const D = call('db.create', {}).id;
    const A = call('tpl.add', { db: D, title: '定例の見本' }).id;   // テンプレートの題名（D77 の外）
    call('tpl.add', { db: D });
    return { D, A };
  } });
  try {
    const { D } = l.made;
    await open(l, D);
    const btn = $(l, 'pDb').querySelector('.dbtplbtn');
    assert.ok(btn && btn.getAttribute('aria-label') === 'テンプレートを選ぶ' && btn.title === 'テンプレートを選ぶ', '▾ が無い');
    await openTpl(l);
    assert.strictEqual(tplMenu(l).querySelector('.dbmenuhead').textContent, 'テンプレート');
    assert.deepStrictEqual(tplRows(l).map((r) => r.querySelector('.dbtplname').textContent), ['定例の見本', '無題のテンプレート', '空白のページ']);
    assert.deepStrictEqual(tplRows(l).map((r) => Boolean(r.querySelector('.dbtpldef'))), [false, false, true], '「空白のページ」に「既定」の札が無い');
    assert.ok(tplMenu(l).querySelectorAll('.mitem').some((b) => b.textContent === '＋ 新しいテンプレート'));
    // ↑↓ で項目を移る
    const first = tplMain(l, '定例の見本');
    assert.ok(l.document.activeElement === first, '開いたときに最初の名前にフォーカスが無い');
    l.key({ key: 'ArrowDown' }, tplMenu(l)); await l.drain();
    assert.ok(l.document.activeElement === tplMain(l, '無題のテンプレート'), `↓ で次の名前へ移らない: ${l.document.activeElement && l.document.activeElement.textContent}`);
    // ［···］
    await clickEl(l, tplMoreOf(l, '定例の見本'), 40);
    assert.deepStrictEqual(l.document.querySelector('.dbtplsub').querySelectorAll('.mitem').map((b) => b.textContent), ['既定にする', '編集', '複製', '削除']);
    await clickEl(l, tplMoreOf(l, '空白のページ'), 40);
    assert.deepStrictEqual(l.document.querySelector('.dbtplsub').querySelectorAll('.mitem').map((b) => b.textContent), ['既定にする']);
    // Esc で閉じて ▾ へ
    l.key({ key: 'Escape' }, tplMenu(l)); await l.drain();
    assert.ok(!tplMenu(l), 'Esc で閉じない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('RT-2・F202: ［既定にする］は確かめの窓（「すべてのビュー」「このビューだけ」「やめる」）で tpl.setDefault の1回・既定があれば［＋ 新しい行］はそのテンプレートで作って今のタブで開く・［＋ 新しいテンプレート］と［編集］は今のタブで帯つき・「議事録」では ▾ が無い', T, async () => {
  const l = await realApp({ before: (call) => {
    const D = call('db.create', {}).id;
    const A = call('tpl.add', { db: D, title: '定例の見本' }).id;   // テンプレートの題名（D77 の外）
    call('meeting.finalize', { pageId: 'pm1', page: MEET('pm1', '2026-11-10T01:30:00.000Z', '2026-11-10'), segments: [] }, 'main');
    return { D, A, M: call('pages.list', {}).find((p) => p.minutes).id };
  } });
  try {
    const { D, A, M } = l.made;
    await open(l, D);
    await openTpl(l);
    await clickEl(l, tplMoreOf(l, '定例の見本'), 40);
    await clickEl(l, l.document.querySelector('.dbtplsub').querySelectorAll('.mitem').find((b) => b.textContent === '既定にする'), 40);
    const ask = l.document.querySelector('.dbtplask');
    assert.ok(ask && ask.textContent.includes('新しい行を作るときに『定例の見本』を既定のテンプレートにしますか？'), '確かめの窓が無い');
    assert.deepStrictEqual(ask.querySelectorAll('button').map((b) => b.textContent), ['すべてのビュー', 'このビューだけ', 'やめる']);
    await clickEl(l, ask.querySelectorAll('button').find((b) => b.textContent === 'このビューだけ'), 300);
    assert.deepStrictEqual(l.called('tplSetDefault').map((c) => c.args), [[D, A, 'v1']]);
    // 既定があれば［＋ 新しい行］はそのテンプレートから作り、今のタブで行のページを開く
    await open(l, D);
    await clickEl(l, $(l, 'pDb').querySelector('.dbadd'), 400);
    assert.strictEqual(l.called('rowFromTpl').length, 1, '既定のテンプレートで作らない');
    const made = l.called('rowFromTpl')[0];
    assert.deepStrictEqual(made.args.slice(0, 2), [D, A]);
    assert.ok(String(l.document.querySelector('.tabitem.active').dataset.key).startsWith('page:r'), '作った行のページを今のタブで開かない');
    assert.ok($(l, 'tplBanner').hidden, 'ふつうの行に帯が出た');
    // ［＋ 新しいテンプレート］: 今のタブで帯つき
    await open(l, D);
    await openTpl(l);
    await clickEl(l, tplMenu(l).querySelectorAll('.mitem').find((b) => b.textContent === '＋ 新しいテンプレート'), 400);
    assert.strictEqual(l.called('tplAdd').length, 1);
    const banner = $(l, 'tplBanner');
    assert.ok(!banner.hidden && banner.textContent === 'テンプレートを編集しています。ここで書いた物は、このテンプレートから作る行に写ります。', '帯が無い');
    // 「議事録」には ▾ が無い
    await open(l, M);
    assert.ok(!$(l, 'pDb').querySelector('.dbtplbtn'), '「議事録」に ▾ がある');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
