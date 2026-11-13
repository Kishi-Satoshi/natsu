/*
 * stage160.app.test.js — 0.16.0「データベース」の画面（計画 docs/plans/2026-11-04-160.md の Task DV-1 から）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。DB の命令は一時の DB（helpers/dbtmp）に本当に通し、
 * 画面との口は本物の src/preload.js を vm で動かして使う（命令の引数の形・元に戻すの歩みの知らせ（データベースの命令は args.db の歩み: 決めたこと 47）が本物と同じ）。
 * DV-1（D1・D2・F139・F143・F144）: データベースのページはタブと表だけ・見える行だけを描く・同じ印では描き直さない・表のキー・行を足す・選ぶ・消す・並べる・Ctrl+Z。
 * データベース・列・行の名前は作った物で、実在の人名・社名は使わない。
 */
'use strict';
process.env.TZ = 'Asia/Tokyo';   // DV-2 直し（rv46 M8）: ［今日］をその PC の時刻の日で見る（UTC の CI でも、UTC の日と取り違えれば赤）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { load } = require('./helpers/simrun.js');
const { tmpDb } = require('./helpers/dbtmp');
const { parseHTML, Element } = require('./helpers/simdom');
const S = require('./helpers/simcss');
const core = require('../src/db/core');
const ops = require('../src/db/ops');
const DM = require('../src/dbModel');
const DV = require('../src/dbView');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
const HTML = fs.readFileSync(APP, 'utf8');
const PRE = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const T = { timeout: 60000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
let clock = Date.parse('2026-11-08T01:00:00.000Z');
const ctx = { now: () => new Date(clock), labels: {} };
let txn = 0;

// 本物の preload を vm で動かし、DB の口（MessagePort）の代わりに core.call へ送る（答えは次の番で返す: 本物と同じく非同期）
function realPreload(db, onStep) {
  const exposed = {}; const on = {}; let uuid = 0;
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async () => ({}), send: () => {} } };
  vm.runInNewContext(PRE, { require: () => electron, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, setTimeout, clearTimeout, console, Promise });
  const port = {
    onmessage: null, addEventListener() {}, start() {}, close() {},
    postMessage(m) {
      const msg = structuredClone(m);
      setImmediate(() => {
        clock += 1000;
        const r = core.call(db, { role: 'app', cmd: msg.cmd, args: msg.args, tx: msg.tx }, ctx);
        port.onmessage({ data: r.ok ? { id: msg.id, ok: true, result: r.result, changed: Boolean(r.changed || r.dupChanged) } : { id: msg.id, ok: false, code: r.code } });
      });
    },
  };
  on['db:port']({ ports: [port] });
  exposed.koeApp.onEditStep(onStep);
  return exposed.koeApp;
}
// preload の呼び口のうち DB へ送るもの（dbCall を呼ぶもの）
const DB_APIS = [...PRE.matchAll(/^ {2}(\w+): \([^)]*\) => dbCall\(/gm)].map((m) => m[1]);

// 見本のデータベース: 題名・テキスト・数値・チェック・作成日時の列と 3 行
async function openDb(o = {}) {
  const t = tmpDb();
  const { db } = t.open();
  const call = (cmd, args) => {
    clock += 1000;
    const r = core.call(db, { role: 'app', cmd, args, tx: `a:dv1-${String(++txn).padStart(6, '0')}` }, ctx);
    if (!r.ok) throw new Error(`${cmd}: ${r.code}`);
    return r.result;
  };
  const id = call('db.create', {}).id;
  const c1 = call('col.add', { db: id, type: 'text', name: 'メモ' }).col.id;
  const c2 = call('col.add', { db: id, type: 'number', name: '金額' }).col.id;
  const c3 = call('col.add', { db: id, type: 'check', name: '済み' }).col.id;
  const c4 = call('col.add', { db: id, type: 'ctime', name: '作った日' }).col.id;
  const rows = [];
  for (const [i, ti] of (o.titles || ['見積もり', '発注', '検収']).entries()) {
    rows.push(call('row.add', { db: id, title: ti, cells: { [c1]: `メモ ${i}`, [c2]: (i + 1) * 100, ...(i === 0 ? { [c3]: true } : {}) } }).id);
  }
  if (o.many) {
    // 1万行（命令を1万回送らずに、行の操作を1回で当てる。並びの鍵は番号の順）
    const list = [];
    // データベースの行の題名（D77 の会議の題名でない）
    for (let i = 0; i < o.many; i += 1) list.push({ op: 'add', id: `rz${i}`, row: ops.rowBlock({ id: `rz${i}`, db: id, ord: `z${String(i).padStart(5, '0')}`, title: `行 ${i}`, cells: { [c1]: `メモ ${i}`, ...(o.manyCells ? o.manyCells(i, { c3 }) : {}) }, by: { c: 'me', u: 'me' }, no: 10 + i, at: new Date(clock).toISOString() }) });
    db.exec('BEGIN'); ops.applyOps(db, list); db.exec('COMMIT');
  }
  const more = o.before ? o.before(call, { id, c1, c2, c3, c4, rows }) || {} : {};
  let L = null;
  const steps = [];
  const K = realPreload(db, (s) => { steps.push(s); if (L) L.fire('onEditStep', s); });
  const returns = { copy: () => true, linkBase: () => 'https://example.invalid/open#p=', openLink: () => true };
  for (const n of DB_APIS) returns[n] = (...a) => K[n](...a);
  Object.assign(returns, o.returns || {});
  const l = await load(APP, { caret: true, returns, ...(o.now !== undefined ? { now: o.now } : {}) });
  L = l;
  Object.assign(l, { K, returns, t, db, call, steps, id, c1, c2, c3, c4, rows, ...more, done: () => t.done() });
  await l.drain();
  l.fire('onPageOpen', id);
  await l.drain(60);
  return l;
}
const box = (l) => $(l, 'pDb');
const grid = (l) => box(l).querySelector('.dbgrid');
const scroller = (l) => box(l).querySelector('.dbscroll');
const domRows = (l) => box(l).querySelectorAll('.dbrow');
const dataRows = (l) => domRows(l).filter((r) => r.dataset.id);
const cellOf = (l, rowId, col) => dataRows(l).find((r) => r.dataset.id === rowId).querySelectorAll('.dbcell').find((c) => c.dataset.col === col);
const texts = (l) => dataRows(l).map((r) => r.querySelectorAll('.dbcell').map((c) => c.textContent));
const views = (l) => l.called('dbView').map((c) => c.args);
const active = (l) => l.document.activeElement;
const press = async (l, el, o) => { const ev = l.key(o, el); await l.drain(60); return ev; };
const editor = (l) => box(l).querySelector('.dbedit');
const height = (l, h) => Object.defineProperty(scroller(l), 'clientHeight', { configurable: true, get: () => h });
const scrollTo = async (l, y) => { scroller(l).scrollTop = y; scroller(l).dispatchEvent({ type: 'scroll' }); await l.drain(60); };
const cellsIn = (l, id) => l.call('db.view', { id: l.id, viewId: 'v1', from: 0, count: 200 }).rows.find((r) => r.id === id);

// ---------------------------------------------------------------- 写し
test('DV-1: 画面の写し（app.html の dbModelView・dbViewView）は src/dbModel.js・src/dbView.js と字も答えも同じ', () => {
  for (const [mark, file, from] of [['dbModel', 'dbModel.js', 'const TYPES'], ['dbView', 'dbView.js', 'const FILTER_DEPTH']]) {
    const at = HTML.indexOf(`  // ---- ${mark} の写し`);
    const end = HTML.indexOf(`  // ---- ${mark} の写しはここまで`);
    assert.ok(at > 0 && end > at, `app.html に ${mark} の写しが無い`);
    const SRC = fs.readFileSync(path.join(ROOT, 'src', file), 'utf8');
    const body = SRC.slice(SRC.indexOf(from), SRC.indexOf('\nmodule.exports')).replace(/\s+$/, '');
    assert.ok(HTML.slice(at, end).includes(body.split('\n').map((x) => (x ? `    ${x}` : x)).join('\n')), `app.html の ${mark} の写しの字が src/${file} と違う`);
  }
  const fold = HTML.slice(HTML.indexOf('  const fold = (s) =>'), HTML.indexOf('\n  function dueInfo'));
  const seg = HTML.slice(HTML.indexOf('  // ---- dbModel の写し'), HTML.indexOf('  // ---- dbView の写しはここまで'));
  const v = new Function(`${fold}\n${seg}\nreturn { m: dbModelView, v: dbViewView };`)();   // eslint-disable-line no-new-func
  const cols = [{ id: 'title', name: '名前', type: 'title' }, { id: 'c1', name: '金額', type: 'number', fmt: 'yen' }, { id: 'c2', name: '期日', type: 'date' }];
  for (const [col, x] of [[cols[1], -1200], [cols[2], { start: '2026-11-04', time: '10:00' }], [cols[0], null]]) assert.strictEqual(v.m.fmtCell(col, x, {}), DM.fmtCell(col, x, {}));
  // データベースの行の題名（D77 の会議の題名でない）
  const rows = [{ id: 'r1', ord: 'b', title: 'い', cells: { c1: 3 } }, { id: 'r2', ord: 'a', title: 'あ', cells: { c1: 1 } }];
  const view = { ...DV.defaultView('v1', 'table', cols), sort: [{ col: 'c1', dir: 'desc' }], agg: { c1: 'sum' } };
  assert.deepStrictEqual(JSON.parse(JSON.stringify(v.v.applyView(rows, view, cols, { now: 0 }))), JSON.parse(JSON.stringify(DV.applyView(rows, view, cols, { now: 0 }))));
  const w = { scrollTop: 3200, viewHeight: 640, heights: new Map(), defaultHeight: 32, pad: 50, total: 10000 };
  assert.deepStrictEqual(v.v.windowOf(w), DV.windowOf(w));
});

// ---------------------------------------------------------------- 形
test('DV-1: データベースのページはタブと表（題名・列の見出し・行・［＋ 新しい行］）を描き、議事録のタブ・会議の種類・［要約を生成］が無い', T, async () => {
  const l = await openDb();
  try {
    assert.ok($(l, 'pageWrap').classList.contains('db'), 'データベースのページの印が無い');
    const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
    assert.strictEqual(S.declsFor(rules, '#pageWrap.db .ptabs', { at: '' }).display, 'none', '議事録の3つのタブが出る');
    assert.strictEqual($(l, 'pTypeRow').style.display, 'none', '会議の種類の行が出る');
    assert.strictEqual($(l, 'pProps').textContent, '', 'プロパティが出る');
    assert.deepStrictEqual([...$(l, 'pActs').children].map((b) => b.id), ['pMore', 'pMenu'], '［要約を生成］が出る');
    assert.strictEqual($(l, 'pNote').textContent, '', '本文の欄に何か描いた');
    assert.deepStrictEqual([$(l, 'pTitle').textContent, $(l, 'pTitle').getAttribute('data-ph')], ['', '無題のデータベース']);
    assert.strictEqual(box(l).hidden, false, '表が出ない');
    const tabs = box(l).querySelectorAll('.dbtab');
    assert.deepStrictEqual(tabs.map((b) => [b.getAttribute('role'), b.textContent, b.getAttribute('aria-selected')]), [['tab', '表', 'true']]);
    assert.strictEqual(grid(l).getAttribute('role'), 'grid');
    assert.strictEqual(grid(l).getAttribute('aria-label'), '無題のデータベース');
    assert.deepStrictEqual(box(l).querySelectorAll('.dbcolh').map((h) => h.textContent), ['名前', 'メモ', '金額', '済み', '作った日']);
    assert.deepStrictEqual(texts(l).map((r) => r.slice(0, 4)), [['見積もり', 'メモ 0', '100', '✓'], ['発注', 'メモ 1', '200', ''], ['検収', 'メモ 2', '300', '']]);
    assert.ok(texts(l).every((r) => /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/.test(r[4])), '作成日時の見せ方が違う');
    for (const r of dataRows(l)) {
      assert.strictEqual(r.getAttribute('role'), 'row');
      assert.deepStrictEqual(r.querySelectorAll('.dbcell').map((c) => [c.getAttribute('role'), c.getAttribute('aria-readonly')]),
        [['gridcell', null], ['gridcell', null], ['gridcell', null], ['gridcell', null], ['gridcell', 'true']], '書けない列の印が違う');
    }
    assert.strictEqual(box(l).querySelector('.dbadd').textContent, '＋ 新しい行');
    // 開いたら行は1回の読みで（db.get と db.view）
    assert.deepStrictEqual(l.called('dbGet').map((c) => c.args), [[l.id]]);
    assert.deepStrictEqual(views(l), [[l.id, 'v1', 0, 51]]);
    // 議事録に戻ると表を外す
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-1: 他人の文字（列の名前・セル・行の題名）は textContent で描く（HTML として読まない）', T, async () => {
  const l = await openDb({ titles: ['<img src=x onerror=alert(1)>'], before: (call, d) => call('col.rename', { db: d.id, col: d.c1, name: '<b>列</b>' }) });   // データベースの行の題名（D77 の会議の題名でない）
  try {
    // 0.16.0 DV-3 で意図して直した: 見出しに幅の取っ手（.dbresize）が入ったので、名前のボタンの中が文字1つかを見る
    assert.ok(box(l).querySelectorAll('.dbcolh .dbcolbtn').some((h) => h.textContent === '<b>列</b>' && h.childNodes.length === 1));
    const c = cellOf(l, l.rows[0], 'title');
    assert.strictEqual(c.textContent, '<img src=x onerror=alert(1)>');
    assert.strictEqual(box(l).querySelectorAll('img').length + box(l).querySelectorAll('b').length, 0, '他人の文字が要素になった');
    assert.ok(!/innerHTML/.test(HTML.slice(HTML.indexOf('0.16.0 DV-1: データベースのページ（表）'), HTML.indexOf('  let pendingEdits = 0;'))), '表の部品が innerHTML を使う');
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 1万行
test('DV-1・F139: 1万行の種で DOM の行は見える分と上下 50 だけ・捲ると dbView を from を変えて呼ぶ・同じ sig では描き直さない', T, async () => {
  const l = await openDb({ many: 10000 });
  try {
    assert.ok(dataRows(l).length <= 51, '開いたときに見込みより多くの行を描いた');
    height(l, 640);
    await scrollTo(l, 0);
    assert.strictEqual(dataRows(l).length, 70, '見えている 20 行と下の 50 行でない');
    assert.strictEqual(grid(l).getAttribute('aria-rowcount'), '10004');
    await scrollTo(l, 5000 * 32);
    assert.deepStrictEqual(views(l).slice(-1), [[l.id, 'v1', 4950, 120]], '捲った窓を読んでいない');
    assert.strictEqual(domRows(l).length, 120, 'DOM の行が見える分と上下 50 でない');
    assert.strictEqual(dataRows(l)[0].dataset.i, '4950');
    assert.strictEqual(box(l).querySelectorAll('.dbpad')[0].style.height, `${4950 * 32}px`, '上の余白が窓の上の行の高さでない');
    const before = dataRows(l);
    const n = views(l).length;
    l.fire('onPagesUpdated'); await l.drain(60);
    assert.ok(views(l).length > n, '知らせで読み直していない');
    assert.ok(dataRows(l).every((r, i) => r === before[i]), '同じ sig で描き直した');
    // 中身が変わった（印が違う）ら描き直す
    l.call('row.setCell', { db: l.id, id: 'rz4960', col: l.c1, value: '直した' });
    l.fire('onPagesUpdated'); await l.drain(60);
    assert.ok(dataRows(l)[0] !== before[0], '印が変わっても描き直さない');
    assert.ok(dataRows(l).find((r) => r.dataset.id === 'rz4960').textContent.includes('直した'));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- キー
test('DV-1・F144: 表のキー（決めたこと 51）・変換確定の Enter でセルを決めない・描き直してもフォーカスが同じセル・Delete で書けないセルは何もしない・Ctrl+D は何もしない', T, async () => {
  const l = await openDb();
  try {
    const [r0, r1, r2] = l.rows;
    cellOf(l, r0, l.c1).dispatchEvent({ type: 'click' }); await l.drain(60);
    assert.ok(editor(l) && active(l) === editor(l), 'セルを押しても書き手が出ない');
    assert.strictEqual(editor(l).value, 'メモ 0');
    // 変換中・変換確定の Enter は決めない
    editor(l).value = 'かな';
    await press(l, editor(l), { key: 'Enter', isComposing: true });
    await press(l, editor(l), { key: 'Enter', keyCode: 229 });
    assert.ok(editor(l), '変換確定の Enter で書き手を閉じた');
    assert.deepStrictEqual(l.called('rowSetCell'), [], '変換確定の Enter でセルを決めた');
    await press(l, editor(l), { key: 'Escape' });
    assert.ok(editor(l) === null, 'editor(l) が残っている');   // DOM を比べの答えに出さない（赤のとき大きな木を文字にしない: R28）
    assert.strictEqual(cellOf(l, r0, l.c1).textContent, 'メモ 0', 'Esc で戻らない');
    assert.ok(active(l) === cellOf(l, r0, l.c1), 'Esc の後にセルにフォーカスが無い');
    const at = () => { const a = active(l); return a && a.dataset ? [a.parentNode.dataset.id, a.dataset.col, a.getAttribute('aria-selected')] : null; };
    await press(l, active(l), { key: 'ArrowRight' }); assert.deepStrictEqual(at(), [r0, l.c2, 'true']);
    await press(l, active(l), { key: 'ArrowDown' }); assert.deepStrictEqual(at(), [r1, l.c2, 'true']);
    await press(l, active(l), { key: 'Tab' }); assert.deepStrictEqual(at(), [r1, l.c3, 'true']);
    await press(l, active(l), { key: 'Tab', shiftKey: true }); assert.deepStrictEqual(at(), [r1, l.c2, 'true']);
    await press(l, active(l), { key: 'End' }); assert.deepStrictEqual(at(), [r1, l.c4, 'true']);
    await press(l, active(l), { key: 'Home' }); assert.deepStrictEqual(at(), [r1, 'title', 'true']);
    await press(l, active(l), { key: 'ArrowLeft' }); assert.deepStrictEqual(at(), [r1, 'title', 'true'], '左端より左へ動いた');
    await press(l, active(l), { key: 'End', ctrlKey: true }); assert.deepStrictEqual(at(), [r2, l.c4, 'true']);
    assert.strictEqual(box(l).querySelectorAll('.dbcell').filter((c) => c.getAttribute('aria-selected') === 'true').length, 1, '選んだセルが1つでない');
    // 書けないセルの Delete は何もしない
    const del = await press(l, active(l), { key: 'Delete' });
    assert.ok(del.defaultPrevented);
    assert.deepStrictEqual(l.called('rowSetCell'), [], '書けないセルを空にする命令を送った');
    await press(l, active(l), { key: 'Home', ctrlKey: true }); assert.deepStrictEqual(at(), [r0, 'title', 'true']);
    // 表の中の Ctrl+D は何もしない（行を複製しない・既定の動きもしない）
    const d = await press(l, active(l), { key: 'd', code: 'KeyD', ctrlKey: true });
    assert.ok(d.defaultPrevented, 'Ctrl+D を表の中で止めない');
    assert.deepStrictEqual(['rowAdd', 'blockDuplicate', 'blocksDuplicate', 'rowSetCell'].map((m) => l.called(m).length), [0, 0, 0, 0]);
    // 書けるセルの Delete は空にする命令の1回
    await press(l, active(l), { key: 'ArrowRight' });
    await press(l, active(l), { key: 'Backspace' });
    assert.deepStrictEqual(l.called('rowSetCell').map((c) => c.args), [[l.id, r0, l.c1, null]]);
    assert.strictEqual(cellsIn(l, r0).cells[l.c1], undefined);
    assert.ok(active(l) === cellOf(l, r0, l.c1), '描き直した後にフォーカスが同じセルに無い');
    // ほかの所で変わって描き直しても、フォーカスは同じセル
    const was = cellOf(l, r0, l.c1);
    l.call('row.setCell', { db: l.id, id: r2, col: l.c1, value: 'ほか' });
    l.fire('onPagesUpdated'); await l.drain(60);
    assert.ok(cellOf(l, r0, l.c1) !== was, '描き直していない（このテストの前提）');
    assert.ok(active(l) === cellOf(l, r0, l.c1), '描き直すとフォーカスが消えた');
    // Esc で選びをやめる（フォーカスは表）
    await press(l, active(l), { key: 'Escape' });
    assert.ok(active(l) === grid(l));
    assert.strictEqual(box(l).querySelectorAll('.dbcell').filter((c) => c.getAttribute('aria-selected') === 'true').length, 0);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 行を足す
test('DV-1: ［＋ 新しい行］→ rowAdd の1回・題名のセルにフォーカス・最後の行の題名で Enter で次の行', T, async () => {
  const l = await openDb();
  try {
    box(l).querySelector('.dbadd').dispatchEvent({ type: 'click' }); await l.drain(80);
    assert.strictEqual(l.called('rowAdd').length, 1);
    assert.deepStrictEqual(l.called('rowAdd')[0].args, [l.id, {}]);
    const added = dataRows(l)[3];
    assert.ok(added && added.dataset.id !== l.rows[2], '足した行が出ない');
    assert.ok(editor(l) && active(l) === editor(l) && editor(l).parentNode === cellOf(l, added.dataset.id, 'title'), '足した行の題名のセルを書いていない');
    editor(l).value = '請求';
    await press(l, editor(l), { key: 'Enter' });
    assert.deepStrictEqual(l.called('rowSetCell').map((c) => c.args), [[l.id, added.dataset.id, 'title', '請求']]);
    assert.strictEqual(l.called('rowAdd').length, 2, '最後の行の題名で Enter で次の行を足さない');
    assert.deepStrictEqual(l.called('rowAdd')[1].args, [l.id, { afterId: added.dataset.id }]);
    assert.strictEqual(dataRows(l).length, 5);
    assert.ok(editor(l) && editor(l).parentNode === cellOf(l, dataRows(l)[4].dataset.id, 'title'), '次の行の題名を書いていない');
    await press(l, editor(l), { key: 'Escape' });
    // 最後でない行の題名の Enter は行を足さない
    cellOf(l, l.rows[0], 'title').dispatchEvent({ type: 'click' }); await l.drain(60);
    await press(l, editor(l), { key: 'Enter' });
    assert.strictEqual(l.called('rowAdd').length, 2);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-1: 絞り込みのあるビューの［＋ 新しい行］は絞り込みの値を入れる（決めたこと 24・R35）・行の上限は一言', T, async () => {
  const l = await openDb({ before: (call, d) => call('view.update', { db: d.id, viewId: 'v1', patch: { filter: { op: 'and', items: [{ col: d.c3, cmp: 'yes' }] } } }) });
  try {
    assert.strictEqual(dataRows(l).length, 1);
    box(l).querySelector('.dbadd').dispatchEvent({ type: 'click' }); await l.drain(80);
    assert.deepStrictEqual(l.called('rowAdd')[0].args, [l.id, { cells: { [l.c3]: true } }]);
    assert.strictEqual(dataRows(l).length, 2, '足した行がすぐ見えなくなった');
    assert.ok(HTML.includes("const DB_ROWS_FULL = '1つのデータベースの行は 10,000 までです。';"));
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 元に戻す
test('DV-1・F143: セルを書いて Ctrl+Z → editRevert の1回で、データベースの歩みから戻る。ビューの設定は歩みに積まれない', T, async () => {
  const l = await openDb();
  try {
    const r0 = l.rows[0];
    cellOf(l, r0, l.c1).dispatchEvent({ type: 'click' }); await l.drain(60);
    editor(l).value = '書き直した';
    await press(l, editor(l), { key: 'Enter' });
    assert.strictEqual(cellsIn(l, r0).cells[l.c1], '書き直した');
    assert.deepStrictEqual(l.steps.map((s) => [s.cmd, s.pageId]), [['row.setCell', l.id]], '歩みがデータベースの ID でない');
    const z = await press(l, active(l), { key: 'z', code: 'KeyZ', ctrlKey: true });
    assert.ok(z.defaultPrevented);
    assert.deepStrictEqual(l.called('editRevert').map((c) => c.args), [[l.id, [l.steps[0].step]]]);
    assert.strictEqual(cellsIn(l, r0).cells[l.c1], 'メモ 0', 'Ctrl+Z で戻らない');
    assert.strictEqual(cellOf(l, r0, l.c1).textContent, 'メモ 0', '戻した表を描き直さない');
    await press(l, active(l), { key: 'y', code: 'KeyY', ctrlKey: true });
    assert.strictEqual(cellsIn(l, r0).cells[l.c1], '書き直した', 'やり直せない');
    // ビューの設定の歩み（来ても）は積まない: Ctrl+Z はセルのやり直しを戻すだけ
    l.fire('onEditStep', { cmd: 'view.update', pageId: l.id, step: 'a:view-step' });
    await press(l, active(l), { key: 'z', code: 'KeyZ', ctrlKey: true });
    await press(l, active(l), { key: 'z', code: 'KeyZ', ctrlKey: true });
    assert.ok(l.called('editRevert').every((c) => !c.args[1].includes('a:view-step')), 'ビューの設定を戻した');
    assert.strictEqual($(l, 'toast').textContent, 'これ以上は戻せません');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 選ぶ・消す・列の値
test('DV-1: 行のチェックで選ぶ・全部を選ぶ・選んだ行の［削除］→ rowsTrash の1回と知らせ・Ctrl+Z で戻る・［列の値を変える ▸］→ rowsSetCell の1回', T, async () => {
  const l = await openDb();
  try {
    const bar = box(l).querySelector('.dbselbar');
    assert.strictEqual(bar.hidden, true);
    const checks = () => box(l).querySelectorAll('.dbcheck');
    assert.deepStrictEqual(checks().map((c) => c.getAttribute('aria-label')), ['見積もり', '発注', '検収']);
    for (const i of [0, 2]) { checks()[i].checked = true; checks()[i].dispatchEvent({ type: 'change' }); }
    await l.drain();
    assert.strictEqual(bar.hidden, false);
    assert.deepStrictEqual([...bar.childNodes].map((e) => e.textContent), ['2 行を選んでいます', '削除', 'リンクを写す', '列の値を変える ▸']);
    // ［列の値を変える ▸］→ 列 → 値 → Enter
    bar.querySelectorAll('button')[2].dispatchEvent({ type: 'click' }); await l.drain();
    const items = bar.querySelectorAll('.dbmenu .mitem');
    // 0.16.0 DV-2（R48 の「数値・…の書き手は DV-2 で足す」）で意図して直した: 書けるどの種類の列も並ぶ（前は文字の列 'メモ' だけ）。書けない列（作成日時）は並ばない
    assert.deepStrictEqual(items.map((b) => b.textContent), ['メモ', '金額', '済み'], '書ける列が並ばない');
    items[0].dispatchEvent({ type: 'click' }); await l.drain();
    const inp = bar.querySelector('.dbedit');
    assert.strictEqual(inp.getAttribute('aria-label'), 'メモ');
    inp.value = 'まとめて';
    await press(l, inp, { key: 'Enter', isComposing: true });
    assert.deepStrictEqual(l.called('rowsSetCell'), []);
    await press(l, inp, { key: 'Enter' });
    assert.deepStrictEqual(l.called('rowsSetCell').map((c) => c.args), [[l.id, [l.rows[0], l.rows[2]], l.c1, 'まとめて']]);
    assert.deepStrictEqual(texts(l).map((r) => r[1]), ['まとめて', 'メモ 1', 'まとめて']);
    // 全部を選ぶ → ［削除］
    const all = box(l).querySelector('.dbcheckall');
    assert.strictEqual(all.getAttribute('aria-label'), 'すべての行を選ぶ');
    all.checked = true; all.dispatchEvent({ type: 'change' }); await l.drain(60);
    assert.strictEqual(bar.querySelector('.dbselcount').textContent, '3 行を選んでいます');
    assert.ok(checks().every((c) => c.checked));
    bar.querySelectorAll('button')[0].dispatchEvent({ type: 'click' }); await l.drain(80);
    assert.deepStrictEqual(l.called('rowsTrash').map((c) => c.args), [[l.id, l.rows]]);
    assert.strictEqual($(l, 'toast').textContent, '行 3 件をゴミ箱に入れました（Ctrl+Z で戻せます）');
    assert.strictEqual(dataRows(l).length, 0);
    assert.strictEqual(bar.hidden, true);
    assert.ok(active(l) === grid(l));
    await press(l, grid(l), { key: 'z', code: 'KeyZ', ctrlKey: true });
    assert.deepStrictEqual(l.called('editRevert').length, 1);
    assert.deepStrictEqual(dataRows(l).map((r) => r.dataset.id), l.rows, 'Ctrl+Z で行が戻らない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 並べる
test('DV-1: 行の ⋮⋮ で上下に → rowMove・並べ替えのあるビューでは引っ張れず一言', T, async () => {
  const l = await openDb();
  try {
    const [r0, r1, r2] = l.rows;
    const rowEl = (id) => dataRows(l).find((r) => r.dataset.id === id);
    for (const r of dataRows(l)) r._rect = { top: 0, height: 32 };
    const types = ['application/x-natsu-row'];
    const grip = rowEl(r2).querySelector('.dbgrip');
    assert.strictEqual(grip.textContent, '⋮⋮');
    assert.strictEqual(grip.draggable, true);
    grip.dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData() {} } });
    let prevented = false;
    rowEl(r0).dispatchEvent({ type: 'dragover', clientY: 4, dataTransfer: { types }, preventDefault() { prevented = true; } });
    assert.ok(prevented && rowEl(r0).classList.contains('dropbefore'), '上半分に前へ落とす印が無い');
    rowEl(r0).dispatchEvent({ type: 'drop', clientY: 4, dataTransfer: { types }, preventDefault() {} }); await l.drain(60);
    assert.deepStrictEqual(l.called('rowMove').map((c) => c.args), [[l.id, r2, '']]);
    assert.deepStrictEqual(dataRows(l).map((r) => r.dataset.id), [r2, r0, r1]);
    for (const r of dataRows(l)) r._rect = { top: 0, height: 32 };
    rowEl(r2).querySelector('.dbgrip').dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData() {} } });
    rowEl(r1).dispatchEvent({ type: 'drop', clientY: 30, dataTransfer: { types }, preventDefault() {} }); await l.drain(60);
    assert.deepStrictEqual(l.called('rowMove').map((c) => c.args)[1], [l.id, r2, r1], '下半分で後ろへ動かさない');
    // 本文の文字（行の印の無い引っ張り）は落とせない
    rowEl(r0).dispatchEvent({ type: 'drop', clientY: 4, dataTransfer: { types: ['text/plain'] }, preventDefault() {} }); await l.drain();
    assert.strictEqual(l.called('rowMove').length, 2);
    // 並べ替えのあるビュー
    l.call('view.update', { db: l.id, viewId: 'v1', patch: { sort: [{ col: l.c2, dir: 'desc' }] } });
    l.fire('onPagesUpdated'); await l.drain(60);
    assert.deepStrictEqual(dataRows(l).map((r) => r.dataset.id), [r2, r1, r0]);
    let stop = false;
    rowEl(r0).querySelector('.dbgrip').dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData() {} }, preventDefault() { stop = true; } });
    assert.ok(stop, '並べ替えのあるビューで引っ張れた');
    assert.strictEqual($(l, 'toast').textContent, '並べ替えを外すと、手で並べられます');
    rowEl(r1).dispatchEvent({ type: 'drop', clientY: 30, dataTransfer: { types }, preventDefault() {} }); await l.drain();
    assert.strictEqual(l.called('rowMove').length, 2);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ================================================================ DV-2（決めたこと 10〜14・25・52・R63〜）: 列のメニューとセルの書き手
const MAIL = ['someone', 'example.invalid'].join('@');
// 見本: openDb の列に、選択・複数選択・ステータス・日付・ユーザー・URL・メール・電話・ID・作成者の列を足す（1行目に値）
const withTypes = (call, d) => {
  const add = (type, name) => call('col.add', { db: d.id, type, name }).col.id;
  const c5 = add('select', '優先度');
  const o5 = call('col.setOpts', { db: d.id, col: c5, opts: [{ id: 'o1', name: '高', color: 'red' }, { id: 'o2', name: '低', color: 'default' }] }).col.opts;
  const c6 = add('multi', 'タグ');
  const o6 = call('col.setOpts', { db: d.id, col: c6, opts: [{ id: 'o3', name: '見積', color: 'blue' }, { id: 'o4', name: '契約', color: 'green' }] }).col.opts;
  const c7 = add('status', '状態');
  const c8 = add('date', '期日'); const c9 = add('person', '担当'); const c10 = add('url', '資料'); const c11 = add('email', 'メール'); const c12 = add('phone', '電話');
  const c13 = add('no', '番号'); const c14 = add('cby', '作った人');
  call('row.setCell', { db: d.id, id: d.rows[0], col: c5, value: o5[0].id });
  call('row.setCell', { db: d.id, id: d.rows[0], col: c8, value: { start: '2026-11-04' } });
  call('row.setCell', { db: d.id, id: d.rows[0], col: c9, value: ['経理係'] });
  call('row.setCell', { db: d.id, id: d.rows[0], col: c10, value: 'https://example.com/a' });
  call('row.setCell', { db: d.id, id: d.rows[0], col: c11, value: MAIL });
  call('row.setCell', { db: d.id, id: d.rows[0], col: c12, value: '03-0000-0000' });
  return { c5, o5, c6, o6, c7, c8, c9, c10, c11, c12, c13, c14 };
};
const head = (l, col) => box(l).querySelectorAll('.dbcolh').find((h) => h.dataset.col === col).querySelector('.dbcolbtn');
const menu = (l) => box(l).querySelector('.dbmenu');
const items = (l) => (menu(l) ? menu(l).querySelectorAll('.mitem') : []);
const item = (l, label) => items(l).find((b) => b.textContent === label);
const clickEl = async (l, el, n = 80) => { el.dispatchEvent({ type: 'click' }); await l.drain(n); };
const heads = (l) => box(l).querySelectorAll('.dbcolh').map((h) => h.textContent);
const picker = (l) => box(l).querySelector('.dbpick');
const opts = (l) => picker(l).querySelectorAll('.dbopt');
const colIn = (l, id) => l.call('db.get', { id: l.id }).cols.find((c) => c.id === id);

test('DV-2: 列のメニューの項目（決めたこと 13・画面の文）・［左に入れる］［右に入れる］・右端の［＋］→ colAdd・名前の変更（imeEnter）・折り返す・集計・隠す → viewUpdate の1回', T, async () => {
  const l = await openDb({ before: withTypes });
  try {
    const BASE = ['名前を変える', '種類 ▸', '左に入れる', '右に入れる', '折り返す', '集計 ▸', '隠す', '削除'];
    const shape = () => items(l).map((b) => [b.textContent, b.disabled]);
    await clickEl(l, head(l, l.c1));
    assert.strictEqual(menu(l).getAttribute('role'), 'menu');
    assert.deepStrictEqual(shape(), BASE.map((x) => [x, false]));
    assert.ok(active(l) === items(l)[0], 'メニューの頭にフォーカスが無い');
    await press(l, menu(l), { key: 'Escape' });
    assert.ok(menu(l) === null && active(l) === head(l, l.c1), 'Esc で閉じて見出しに戻らない');
    // 題名の列: 種類・隠す・削除は灰色。数値は［見せ方 ▸］・選択は［選択肢を足す］［色 ▸］・ID は［接頭辞］
    await clickEl(l, head(l, 'title'));
    assert.deepStrictEqual(shape(), BASE.map((x) => [x, ['種類 ▸', '隠す', '削除'].includes(x)]));
    await clickEl(l, head(l, l.c2));
    assert.deepStrictEqual(items(l).map((b) => b.textContent).slice(0, 3), ['名前を変える', '種類 ▸', '見せ方 ▸']);
    await clickEl(l, head(l, l.c5));
    assert.deepStrictEqual(items(l).map((b) => b.textContent).slice(0, 4), ['名前を変える', '種類 ▸', '選択肢を足す', '色 ▸']);
    await clickEl(l, head(l, l.c13));
    assert.deepStrictEqual(items(l).map((b) => b.textContent).slice(0, 3), ['名前を変える', '種類 ▸', '接頭辞']);
    assert.strictEqual(item(l, '種類 ▸').disabled, true, '書けない種類の列の種類を変えられる');
    // 名前を変える（変換確定の Enter では決めない）
    await clickEl(l, head(l, l.c1));
    await clickEl(l, item(l, '名前を変える'));
    const inp = menu(l).querySelector('input');
    assert.ok(active(l) === inp && inp.value === 'メモ' && inp.getAttribute('aria-label') === 'メモ');
    inp.value = '覚え書き';
    await press(l, inp, { key: 'Enter', isComposing: true });
    assert.deepStrictEqual(l.called('colRename'), [], '変換確定の Enter で名前を決めた');
    await press(l, inp, { key: 'Enter' });
    assert.deepStrictEqual(l.called('colRename').map((c) => c.args), [[l.id, l.c1, '覚え書き']]);
    assert.strictEqual(heads(l)[1], '覚え書き');
    // ［右に入れる］: 列を足す1回と、ビューの並びのその列の右へ（viewUpdate の1回）
    await clickEl(l, head(l, l.c1));
    await clickEl(l, item(l, '右に入れる'), 120);
    assert.deepStrictEqual(l.called('colAdd').map((c) => c.args), [[l.id, 'text', undefined, l.c1]]);
    assert.deepStrictEqual(heads(l).slice(0, 4), ['名前', '覚え書き', 'テキスト', '金額']);
    await clickEl(l, head(l, l.c2));
    await clickEl(l, item(l, '左に入れる'), 120);
    assert.deepStrictEqual(heads(l).slice(0, 5), ['名前', '覚え書き', 'テキスト', 'テキスト 2', '金額']);
    assert.strictEqual(l.called('viewUpdate').length, 2);
    // 右端の［＋］→ 種類 → colAdd の1回 → 名前の欄
    const plus = box(l).querySelector('.dbcoladd');
    assert.deepStrictEqual([plus.textContent, plus.getAttribute('aria-label'), plus.title], ['＋', '列を足す', '列を足す']);
    await clickEl(l, plus);
    // 0.16.0 DR-1（R99）で意図して直した: 末に［リレーション］（つなぐデータベースを選んで足す）
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['テキスト', '数値', '選択', '複数選択', 'ステータス', '日付', 'ユーザー', 'チェック', 'URL', 'メール', '電話', 'リレーション']);
    await clickEl(l, item(l, '日付'), 120);
    assert.deepStrictEqual(l.called('colAdd').map((c) => c.args)[2], [l.id, 'date']);
    assert.strictEqual(heads(l).slice(-1)[0], '日付', '足した列が右端に出ない');
    const nm = menu(l).querySelector('input');
    assert.ok(nm && active(l) === nm && nm.value === '日付', '足した列の名前の欄が開かない');
    await press(l, nm, { key: 'Escape' });
    // 折り返す・集計・隠す: どれも viewUpdate の1回（元に戻すの歩みにしない）
    const vu = () => l.called('viewUpdate').length;
    await clickEl(l, head(l, l.c2)); await clickEl(l, item(l, '折り返す'));
    assert.strictEqual(vu(), 3);
    assert.ok(cellOf(l, l.rows[0], l.c2).classList.contains('wrap'));
    await clickEl(l, head(l, l.c2)); assert.strictEqual(item(l, '折り返す').getAttribute('aria-checked'), 'true');
    await clickEl(l, item(l, '集計 ▸'));
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['全件', '値のある件数', '異なる値の数', '空の数', '空でない数', '空の割合', '空でない割合', '合計', '平均', '中央値', '最小', '最大', '範囲']);
    await clickEl(l, item(l, '合計'));
    assert.strictEqual(vu(), 4);
    assert.ok(box(l).querySelectorAll('.dbagg').some((a) => a.textContent === '合計 600'), '下の集計が出ない');
    await clickEl(l, head(l, l.c2)); await clickEl(l, item(l, '隠す'));
    assert.strictEqual(vu(), 5);
    assert.ok(!heads(l).includes('金額'), '隠した列が出る');
    assert.ok(l.steps.every((s) => !/^view\./.test(s.cmd)), 'ビューの設定が歩みに積まれた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2・R63: 種類の変更の確かめ（読み替えで消える値の数）・断れば変えない・空になる値が無ければ確かめない・Ctrl+Z で戻る', T, async () => {
  const l = await openDb({ before: withTypes });
  try {
    const asked = [];
    let yes = false;
    l.window.confirm = (m) => { asked.push(m); return yes; };
    await clickEl(l, head(l, l.c1)); await clickEl(l, item(l, '種類 ▸'));
    assert.strictEqual(item(l, 'テキスト').getAttribute('aria-checked'), 'true');
    await clickEl(l, item(l, '数値'));
    assert.deepStrictEqual(asked, ['種類を変えると、3 個の値が読めずに空になります。よろしいですか？（Ctrl+Z で戻せます）']);
    assert.deepStrictEqual(l.called('colTypeCheck').map((c) => c.args), [[l.id, l.c1, 'number']]);
    assert.deepStrictEqual(l.called('colSetType'), [], '断ったのに種類を変えた');
    yes = true;
    await clickEl(l, head(l, l.c1)); await clickEl(l, item(l, '種類 ▸')); await clickEl(l, item(l, '数値'), 120);
    assert.deepStrictEqual(l.called('colSetType').map((c) => c.args), [[l.id, l.c1, 'number']]);
    assert.strictEqual(colIn(l, l.c1).type, 'number');
    assert.deepStrictEqual(texts(l).map((r) => r[1]), ['', '', '']);
    await press(l, grid(l), { key: 'z', code: 'KeyZ', ctrlKey: true });
    assert.strictEqual(colIn(l, l.c1).type, 'text', 'Ctrl+Z で種類が戻らない');
    assert.deepStrictEqual(texts(l).map((r) => r[1]), ['メモ 0', 'メモ 1', 'メモ 2']);
    // 空になる値の無い変え方（テキスト → 選択）は確かめない
    asked.length = 0;
    await clickEl(l, head(l, l.c1)); await clickEl(l, item(l, '種類 ▸')); await clickEl(l, item(l, '選択'), 120);
    assert.deepStrictEqual(asked, []);
    assert.strictEqual(colIn(l, l.c1).type, 'select');
    assert.deepStrictEqual(colIn(l, l.c1).opts.map((o) => o.name), ['メモ 0', 'メモ 1', 'メモ 2']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2・F137: 書き手: 数値（読めない文字は断って一言）・チェックは押すと切り替え・選択（探す・選ぶ・新しい選択肢）・複数選択・ステータス（3つのまとまりの見出し）・書けない種類は書き手を出さない・選択肢の色', T, async () => {
  const l = await openDb({ before: withTypes });
  try {
    const [r0, r1] = l.rows;
    // 数値
    await clickEl(l, cellOf(l, r1, l.c2), 60);
    assert.strictEqual(editor(l).value, '200');
    editor(l).value = '約 3';
    await press(l, editor(l), { key: 'Enter' });
    assert.strictEqual($(l, 'toast').textContent, 'この列の値として読めませんでした。');
    assert.deepStrictEqual(l.called('rowSetCell'), [], '読めない数を送った');
    assert.strictEqual(cellOf(l, r1, l.c2).textContent, '200');
    await clickEl(l, cellOf(l, r1, l.c2), 60);
    editor(l).value = '１，２００';
    await press(l, editor(l), { key: 'Enter' });
    assert.deepStrictEqual(l.called('rowSetCell').map((c) => c.args), [[l.id, r1, l.c2, 1200]]);
    // チェックは押すと切り替え（Enter でも）
    await clickEl(l, cellOf(l, r1, l.c3));
    assert.strictEqual(cellsIn(l, r1).cells[l.c3], true);
    await press(l, active(l), { key: 'Enter' });
    assert.strictEqual(cellsIn(l, r1).cells[l.c3], undefined);
    // 書けない種類（作成日時・ID・作成者）は書き手を出さない
    for (const c of [l.c4, l.c13, l.c14]) { await clickEl(l, cellOf(l, r1, c), 40); assert.ok(!picker(l) && !editor(l), `${c} に書き手が出た`); }
    // 選択: 探して選ぶ
    await clickEl(l, cellOf(l, r1, l.c5), 60);
    assert.ok(picker(l), '選択の書き手が出ない');
    const q = picker(l).querySelector('input');
    assert.ok(active(l) === q && q.getAttribute('aria-label') === '優先度');
    assert.deepStrictEqual(opts(l).map((b) => [b.textContent, b.getAttribute('aria-selected'), b.dataset.color]), [['高', 'false', 'red'], ['低', 'false', 'default']]);
    q.value = 'ひく'; q.dispatchEvent({ type: 'input' });
    assert.deepStrictEqual(opts(l).map((b) => b.textContent), ['選択肢を足すひく'], '探す語で絞らない');
    q.value = '低'; q.dispatchEvent({ type: 'input' });
    await press(l, q, { key: 'Enter', isComposing: true });
    assert.ok(picker(l), '変換確定の Enter で決めた');
    await press(l, q, { key: 'Enter' });
    assert.ok(picker(l) === null, 'picker(l) が残っている');   // DOM を比べの答えに出さない（赤のとき大きな木を文字にしない: R28）
    assert.strictEqual(cellsIn(l, r1).cells[l.c5], l.o5[1].id);
    assert.ok(active(l) === cellOf(l, r1, l.c5), '選んだ後にセルにフォーカスが無い');
    // 新しい選択肢（col.setOpts の答えの ID で書く）
    await clickEl(l, cellOf(l, r1, l.c5), 60);
    picker(l).querySelector('input').value = '急ぎ'; picker(l).querySelector('input').dispatchEvent({ type: 'input' });
    const nw = opts(l).find((b) => b.classList.contains('dbnew'));
    assert.deepStrictEqual(nw.querySelectorAll('span').map((x) => x.textContent), ['選択肢を足す', '急ぎ']);
    await clickEl(l, nw, 150);
    const made = colIn(l, l.c5).opts.find((o) => o.name === '急ぎ');
    assert.ok(made, '選択肢を足さない');
    assert.strictEqual(cellsIn(l, r1).cells[l.c5], made.id);
    assert.strictEqual(cellOf(l, r1, l.c5).textContent, '急ぎ');
    // 複数選択: 2つ選ぶ（窓は開いたまま）・Esc で閉じる
    await clickEl(l, cellOf(l, r1, l.c6), 60);
    await clickEl(l, opts(l)[1]); await clickEl(l, opts(l)[0]);
    assert.ok(picker(l), '複数選択の窓が閉じた');
    assert.deepStrictEqual(cellsIn(l, r1).cells[l.c6], [l.o6[1].id, l.o6[0].id]);
    assert.deepStrictEqual(opts(l).map((b) => b.getAttribute('aria-selected')), ['true', 'true']);
    // 複数選択の窓で新しい選択肢を足しても（列が変わって表を描き直しても）窓は開いたまま
    const mq = picker(l).querySelector('input');
    mq.value = '納品'; mq.dispatchEvent({ type: 'input' });
    await press(l, mq, { key: 'Enter' }); await l.drain(120);
    assert.ok(picker(l), '新しい選択肢を足すと複数選択の窓が消えた');
    const nouhin = colIn(l, l.c6).opts.find((o) => o.name === '納品');
    assert.deepStrictEqual(cellsIn(l, r1).cells[l.c6], [l.o6[1].id, l.o6[0].id, nouhin.id]);
    await clickEl(l, opts(l).find((b) => b.textContent === '納品'));
    await press(l, picker(l).querySelector('input'), { key: 'Escape' });
    assert.ok(picker(l) === null, 'picker(l) が残っている');   // DOM を比べの答えに出さない（赤のとき大きな木を文字にしない: R28）
    assert.strictEqual(cellOf(l, r1, l.c6).textContent, '契約, 見積');
    // ステータス: 3つのまとまりの見出し
    await clickEl(l, cellOf(l, r1, l.c7), 60);
    assert.deepStrictEqual(picker(l).querySelector('.dbpicklist').childNodes.map((e) => e.textContent), ['未着手', '未着手', '進行中', '進行中', '完了', '完了']);
    await clickEl(l, opts(l)[2]);
    assert.strictEqual(cellOf(l, r1, l.c7).textContent, '完了');
    // 選択肢の色（列のメニューの［色 ▸］→ 選択肢 → 色: col.setOpts の1回）
    await clickEl(l, head(l, l.c5)); await clickEl(l, item(l, '色 ▸'));
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['高', '低', '急ぎ']);
    await clickEl(l, item(l, '低'));
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['既定', '灰', '茶', '橙', '黄', '緑', '青', '紫', '桃', '赤']);
    assert.strictEqual(item(l, '既定').getAttribute('aria-checked'), 'true');
    await clickEl(l, item(l, '緑'), 120);
    assert.strictEqual(colIn(l, l.c5).opts.find((o) => o.name === '低').color, 'green');
    // ［選択肢を足す］（列のメニュー）
    const before = l.called('colSetOpts').length;
    await clickEl(l, head(l, l.c5)); await clickEl(l, item(l, '選択肢を足す'));
    const oi = menu(l).querySelector('input');
    assert.strictEqual(oi.getAttribute('aria-label'), '選択肢を足す');
    oi.value = '中'; await press(l, oi, { key: 'Enter' });
    assert.strictEqual(l.called('colSetOpts').length, before + 1);
    assert.deepStrictEqual(colIn(l, l.c5).opts.map((o) => o.name), ['高', '低', '急ぎ', '中']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2: 暦（日付の欄・終わりの日・時刻・今日）と日付の形・Esc でやめる', T, async () => {
  const l = await openDb({ before: withTypes });
  try {
    const r0 = l.rows[0];
    assert.strictEqual(cellOf(l, r0, l.c8).textContent, '2026/11/04');
    await clickEl(l, cellOf(l, r0, l.c8), 60);
    const ins = () => picker(l).querySelectorAll('input');
    const by = (label) => ins().find((i) => i.getAttribute('aria-label') === label);
    assert.deepStrictEqual(ins().map((i) => [i.type, i.getAttribute('aria-label')]), [['date', '期日'], ['time', '時刻'], ['date', '終わりの日'], ['time', '終わりの時刻'], ['checkbox', null], ['checkbox', null]]);
    assert.deepStrictEqual(picker(l).querySelectorAll('.dbdatecheck').map((x) => x.textContent), ['終わりの日', '時刻']);
    assert.ok(active(l) === by('期日') && by('期日').value === '2026-11-04');
    assert.ok(by('時刻').hidden && by('終わりの日').hidden, '時刻と終わりの日がはじめから出る');
    const [endBox, timeBox] = picker(l).querySelectorAll('.dbdatecheck input');
    endBox.checked = true; endBox.dispatchEvent({ type: 'change' });
    timeBox.checked = true; timeBox.dispatchEvent({ type: 'change' });
    assert.ok(!by('終わりの日').hidden && !by('時刻').hidden && !by('終わりの時刻').hidden);
    by('時刻').value = '10:00'; by('終わりの日').value = '2026-11-05'; by('終わりの時刻').value = '09:00';
    await press(l, by('終わりの時刻'), { key: 'Enter' });
    assert.deepStrictEqual(cellsIn(l, r0).cells[l.c8], { start: '2026-11-04', time: '10:00', end: '2026-11-05', endTime: '09:00' });
    assert.strictEqual(cellOf(l, r0, l.c8).textContent, '2026/11/04 10:00 → 2026/11/05 09:00');
    // 終わりが始まりより前は断って一言（書かない）
    await clickEl(l, cellOf(l, l.rows[1], l.c8), 60);
    by('期日').value = '2026-11-09';
    const [e2] = picker(l).querySelectorAll('.dbdatecheck input');
    e2.checked = true; e2.dispatchEvent({ type: 'change' });
    by('終わりの日').value = '2026-11-01';
    const n = l.called('rowSetCell').length;
    await press(l, by('期日'), { key: 'Enter' });
    assert.strictEqual($(l, 'toast').textContent, 'この列の値として読めませんでした。');
    assert.strictEqual(l.called('rowSetCell').length, n);
    await press(l, by('期日'), { key: 'Escape' });
    assert.ok(picker(l) === null, 'picker(l) が残っている');   // DOM を比べの答えに出さない（赤のとき大きな木を文字にしない: R28）
    // ［今日］
    await clickEl(l, cellOf(l, l.rows[1], l.c8), 60);
    const today = picker(l).querySelectorAll('button').find((b) => b.textContent === '今日');
    await clickEl(l, today, 20);
    const d = new l.window.Date();
    assert.strictEqual(by('期日').value, `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    const want = by('期日').value;
    await press(l, by('期日'), { key: 'Enter' });
    assert.deepStrictEqual(cellsIn(l, l.rows[1]).cells[l.c8], { start: want });
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2: ユーザーの書き手はそのデータベースの名前と ToDo の担当の名前を候補に出す・打った名前を足す・外す', T, async () => {
  const l = await openDb({ before: withTypes, returns: { pagesActionView: () => ({ actions: [], people: [{ name: '総務係', count: 2 }, { name: '経理係', count: 1 }], total: 3 }) } });
  try {
    const r1 = l.rows[1];
    await clickEl(l, cellOf(l, r1, l.c9), 80);
    assert.ok(l.called('pagesActionView').length >= 1, 'ToDo の担当を読まない');
    assert.deepStrictEqual(opts(l).map((b) => [b.textContent, b.getAttribute('aria-selected')]), [['経理係', 'false'], ['総務係', 'false']]);
    await clickEl(l, opts(l)[1]);
    assert.deepStrictEqual(cellsIn(l, r1).cells[l.c9], ['総務係']);
    const q = picker(l).querySelector('input');
    q.value = '新しい係'; q.dispatchEvent({ type: 'input' });
    await press(l, q, { key: 'Enter' }); await l.drain(60);
    assert.deepStrictEqual(cellsIn(l, r1).cells[l.c9], ['総務係', '新しい係']);
    await clickEl(l, opts(l).find((b) => b.textContent === '総務係'));
    assert.deepStrictEqual(cellsIn(l, r1).cells[l.c9], ['新しい係']);
    await press(l, picker(l).querySelector('input'), { key: 'Escape' });
    assert.strictEqual(cellOf(l, r1, l.c9).textContent, '新しい係');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2・F145: URL のセルの値を押すと http(s) だけ開く（javascript:・file: は開かない）・メールは mailto:・電話は写す・値の外を押すと書き手', T, async () => {
  const l = await openDb({ before: withTypes });
  try {
    const r0 = l.rows[0];
    const link = (c) => cellOf(l, r0, c).querySelector('.dblink');
    assert.strictEqual(link(l.c10).textContent, 'https://example.com/a');
    await clickEl(l, link(l.c10), 40);
    await clickEl(l, link(l.c11), 40);
    assert.deepStrictEqual(l.called('openLink').map((c) => c.args), [['https://example.com/a'], [`mailto:${MAIL}`]]);
    assert.ok(!editor(l), '値を押して書き手が出た');
    await clickEl(l, link(l.c12), 40);
    assert.deepStrictEqual(l.called('copy').map((c) => c.args), [['03-0000-0000']]);
    assert.strictEqual($(l, 'toast').textContent, 'コピーしました');
    // 照らしを通らずに入った値（壊れた DB）でも http(s) のほかは開かない
    for (const bad of ['javascript:alert(1)', 'file:///c:/windows/x']) {
      l.db.exec('BEGIN');
      ops.applyOps(l.db, [{ op: 'set', id: r0, key: `cell:${l.c10}`, value: bad, old: undefined }]);
      l.db.exec('COMMIT');
      l.fire('onPagesUpdated'); await l.drain(60);
      assert.strictEqual(link(l.c10).textContent, bad);
      await clickEl(l, link(l.c10), 40);
    }
    assert.strictEqual(l.called('openLink').length, 2, 'http(s) のほかを開いた');
    await clickEl(l, cellOf(l, r0, l.c11), 60);
    assert.ok(editor(l) && editor(l).value === MAIL, '値の外を押しても書き手が出ない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2: 消した列は［ビューの設定］の［消した列］に出て［戻す］→ colRestore・［完全に消す］は確かめの後 colPurge・列は 100 まで', T, async () => {
  const l = await openDb();
  try {
    const gear = box(l).querySelector('.dbsetbtn');
    assert.deepStrictEqual([gear.getAttribute('aria-label'), gear.title], ['ビューの設定', 'ビューの設定']);
    await clickEl(l, gear);
    assert.strictEqual(menu(l).querySelector('.dbmenuhead').textContent, 'ビューの設定');
    assert.strictEqual(item(l, '消した列').disabled, true, '消した列が無いのに押せる');
    await clickEl(l, head(l, l.c1)); await clickEl(l, item(l, '削除'), 120);
    assert.deepStrictEqual(l.called('colRemove').map((c) => c.args), [[l.id, l.c1]]);
    assert.ok(!heads(l).includes('メモ'));
    await clickEl(l, box(l).querySelector('.dbsetbtn')); await clickEl(l, item(l, '消した列'));
    assert.deepStrictEqual(menu(l).querySelectorAll('.dbgone').map((x) => x.querySelectorAll('span, button').map((e) => e.textContent)), [['メモ', '戻す', '完全に消す']]);
    assert.strictEqual(menu(l).querySelector('.dbmenuhead').textContent, '消した列');
    await clickEl(l, menu(l).querySelectorAll('button').find((b) => b.textContent === '戻す'), 120);
    assert.deepStrictEqual(l.called('colRestore').map((c) => c.args), [[l.id, l.c1]]);
    assert.ok(heads(l).includes('メモ'), '戻した列が出ない');
    assert.deepStrictEqual(texts(l).map((r) => r[heads(l).indexOf('メモ')]), ['メモ 0', 'メモ 1', 'メモ 2']);
    // 完全に消す（確かめで断れば消さない）
    await clickEl(l, head(l, l.c1)); await clickEl(l, item(l, '削除'), 120);
    const asked = [];
    let yes = false;
    l.window.confirm = (m) => { asked.push(m); return yes; };
    await clickEl(l, box(l).querySelector('.dbsetbtn')); await clickEl(l, item(l, '消した列'));
    const purge = () => menu(l).querySelectorAll('button').find((b) => b.textContent === '完全に消す');
    await clickEl(l, purge());
    assert.deepStrictEqual(asked, ['この列と、すべての行のこの列の値を完全に消します。元に戻せません。よろしいですか？']);
    assert.deepStrictEqual(l.called('colPurge'), []);
    yes = true;
    await clickEl(l, purge(), 120);
    assert.deepStrictEqual(l.called('colPurge').map((c) => c.args), [[l.id, l.c1]]);
    assert.ok(!colIn(l, l.c1), '完全に消えていない');
    assert.ok(l.steps.every((s) => s.cmd !== 'col.purge'), '完全に消すが歩みに積まれた');
    // 列は 100 まで（消した列も数える）
    for (let i = l.call('db.get', { id: l.id }).cols.length; i < 100; i += 1) l.call('col.add', { db: l.id, type: 'check', name: `印 ${i}` });
    l.fire('onPagesUpdated'); await l.drain(80);
    await clickEl(l, box(l).querySelector('.dbcoladd'));
    assert.strictEqual($(l, 'toast').textContent, '列は 100 までです。');
    assert.ok(menu(l) === null, 'menu(l) が残っている');   // DOM を比べの答えに出さない（赤のとき大きな木を文字にしない: R28）
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2: 数値の見せ方 ▸（数・3桁区切り・%・円・ドル）・作成者「自分」・ID の接頭辞', T, async () => {
  const l = await openDb({ before: (call, d) => { call('row.setCell', { db: d.id, id: d.rows[2], col: d.c2, value: 1234567 }); return withTypes(call, d); } });
  try {
    const r2 = l.rows[2];
    await clickEl(l, head(l, l.c2)); await clickEl(l, item(l, '見せ方 ▸'));
    assert.deepStrictEqual(items(l).map((b) => [b.textContent, b.getAttribute('aria-checked')]), [['数', 'true'], ['3桁区切り', 'false'], ['%', 'false'], ['円', 'false'], ['ドル', 'false']]);
    await clickEl(l, item(l, '円'), 120);
    assert.deepStrictEqual(l.called('colSetFmt').map((c) => c.args), [[l.id, l.c2, { fmt: 'yen' }]]);
    assert.strictEqual(cellOf(l, r2, l.c2).textContent, '¥1,234,567');
    assert.strictEqual(cellOf(l, r2, l.c14).textContent, '自分');
    assert.strictEqual(cellOf(l, r2, l.c13).textContent, '3');
    await clickEl(l, head(l, l.c13)); await clickEl(l, item(l, '接頭辞'));
    const p = menu(l).querySelector('input');
    assert.strictEqual(p.getAttribute('aria-label'), '接頭辞');
    p.value = 'TASK'; await press(l, p, { key: 'Enter' });
    assert.deepStrictEqual(l.called('colSetFmt').map((c) => c.args)[1], [l.id, l.c13, { prefix: 'TASK' }]);
    assert.strictEqual(cellOf(l, r2, l.c13).textContent, 'TASK-3');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2・F146: セルを選んで Ctrl+C → 値を写す。表計算の形（タブと改行）を Ctrl+V → rowsPaste の1回・知らせ・Ctrl+Z の1回で戻る。1つの値はそのセルに（読めなければ断る）・2,001 個は断る', T, async () => {
  let clip = { text: '' };
  const l = await openDb({ returns: { clipReadRows: () => clip } });
  try {
    const [r0, r1] = l.rows;
    await clickEl(l, cellOf(l, r1, l.c2), 60);
    await press(l, editor(l), { key: 'Escape' });
    const c = await press(l, active(l), { key: 'c', code: 'KeyC', ctrlKey: true });
    assert.ok(c.defaultPrevented);
    assert.deepStrictEqual(l.called('copy').map((x) => x.args), [['200']]);
    // 1つの値: 読めなければ断る・読めれば rowsPaste の 1×1
    clip = { text: 'たくさん' };
    await press(l, active(l), { key: 'v', code: 'KeyV', ctrlKey: true }); await l.drain(60);
    assert.strictEqual($(l, 'toast').textContent, 'この列の値として読めませんでした。');
    assert.deepStrictEqual(l.called('rowsPaste'), []);
    clip = { text: '450\r\n' };
    await press(l, active(l), { key: 'v', code: 'KeyV', ctrlKey: true }); await l.drain(60);
    assert.deepStrictEqual(l.called('rowsPaste').map((x) => x.args), [[l.id, 'v1', { row: r1, col: l.c2 }, [['450']]]]);
    assert.strictEqual(cellsIn(l, r1).cells[l.c2], 450);
    // 何行何列か（引用符の中の改行とタブも）: 選んだセルから右下へ・足りない行は足す
    await clickEl(l, cellOf(l, r1, l.c1), 60);
    await press(l, editor(l), { key: 'Escape' });
    clip = { text: 'あ\t10\r\n"い\tう"\tx\r\nえ\t30\r\n', html: '<table><tr><td>あ</td></tr></table>' };
    const steps = l.steps.length;
    await press(l, active(l), { key: 'v', code: 'KeyV', ctrlKey: true }); await l.drain(120);
    assert.deepStrictEqual(l.called('rowsPaste').map((x) => x.args)[1], [l.id, 'v1', { row: r1, col: l.c1 }, [['あ', '10'], ['い う', 'x'], ['え', '30']]]);
    assert.strictEqual($(l, 'toast').textContent, '1 行を足し、1 個の値は読めなかったので空にしました');
    assert.strictEqual(dataRows(l).length, 4);
    assert.deepStrictEqual(texts(l).map((r) => r.slice(1, 3)), [['メモ 0', '100'], ['あ', '10'], ['い う', ''], ['え', '30']]);
    assert.strictEqual(l.steps.length, steps + 1, '貼り付けが歩みの1つでない');
    await press(l, active(l), { key: 'z', code: 'KeyZ', ctrlKey: true });
    assert.deepStrictEqual(texts(l).map((r) => r.slice(1, 3)), [['メモ 0', '100'], ['メモ 1', '450'], ['メモ 2', '300']], 'Ctrl+Z の1回で戻らない');
    // 右にはみ出した値は数を知らせる
    await clickEl(l, cellOf(l, r0, l.c4), 60);
    clip = { text: 'a\tb\tc' };
    await press(l, active(l), { key: 'v', code: 'KeyV', ctrlKey: true }); await l.drain(80);
    assert.strictEqual($(l, 'toast').textContent, '0 行を足し、0 個の値は読めなかったので空にしました（貼れない列の 3 個の値は貼りませんでした）');
    // 2,001 個は断る（送らない）
    const n = l.called('rowsPaste').length;
    clip = { text: Array.from({ length: 1001 }, () => '1\t2').join('\n') };
    await press(l, active(l), { key: 'v', code: 'KeyV', ctrlKey: true }); await l.drain(60);
    assert.strictEqual($(l, 'toast').textContent, '1回に貼れるのは 2,000 個の値までです。');
    assert.strictEqual(l.called('rowsPaste').length, n);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ================================================================ DV-1 直し（2026-11-08 の e3981e3..6377ef8 の点検 rv44。R72〜）
test('DV-1 直し（rv44 F1）: 表の読みが一度断られても表は消えず、次の知らせで読み直す。開くときの db.get が断られても、次の知らせで表を描く', T, async () => {
  const l = await openDb();
  try {
    const real = l.returns.dbView;
    l.returns.dbView = () => Promise.reject(Object.assign(new Error('retry'), { code: 'retry' }));
    l.fire('onPagesUpdated'); await l.drain(60);
    assert.strictEqual(dataRows(l).length, 3, '一度の読みの断りで表が消えた');
    l.returns.dbView = real;
    l.call('row.setCell', { db: l.id, id: l.rows[1], col: l.c1, value: '直した' });
    l.fire('onPagesUpdated'); await l.drain(60);
    assert.strictEqual(dataRows(l).length, 3);
    assert.strictEqual(cellOf(l, l.rows[1], l.c1).textContent, '直した');
    l.returns.dbView = () => Promise.reject(Object.assign(new Error('retry'), { code: 'retry' }));
    l.fire('onPagesUpdated'); await l.drain(60);
    l.returns.dbView = real;
    l.fire('onPagesUpdated'); await l.drain(60);
    assert.strictEqual(dataRows(l).length, 3, '中身が同じまま読み直すと表が空のまま');
  } finally { l.done(); }
  // 開くときの db.get の断り
  let fail = true;
  const l2 = await openDb({ returns: { dbGet: (...a) => (fail ? Promise.reject(Object.assign(new Error('retry'), { code: 'retry' })) : l2.K.dbGet(...a)) } });
  try {
    assert.strictEqual(dataRows(l2).length, 0);
    fail = false;
    l2.fire('onPagesUpdated'); await l2.drain(80);
    assert.strictEqual(dataRows(l2).length, 3, 'db.get が一度断られると、知らせが来ても表を描かない');
  } finally { l2.done(); }
});

test('DV-1 直し（rv44 F2）: セルを書いている間に別のセルを押して書き始めても、前のセルに書き手が残らない', T, async () => {
  const l = await openDb();
  try {
    const [r0, r1] = l.rows;
    cellOf(l, r0, l.c1).dispatchEvent({ type: 'click' }); await l.drain(60);
    editor(l).value = 'X';
    editor(l).onblur();
    cellOf(l, r1, l.c1).dispatchEvent({ type: 'click' });
    await l.drain(80);
    const eb = cellOf(l, r1, l.c1).querySelector('.dbedit');
    assert.ok(eb, '前提: 2つ目のセルを書いている');
    await press(l, eb, { key: 'Escape' });
    assert.strictEqual(box(l).querySelectorAll('.dbedit').length, 0, '書き手が残った');
    assert.strictEqual(cellOf(l, r0, l.c1).textContent, 'X');
  } finally { l.done(); }
});

test('DV-1 直し（rv44 F7）: 書いた後の読み直しの間に捲っても、表は新しい値を描き、窓の行を空のまま残さない', T, async () => {
  const l = await openDb({ many: 300 });
  try {
    height(l, 640);
    await scrollTo(l, 0);
    const r0 = dataRows(l)[0].dataset.id;
    cellOf(l, r0, l.c1).dispatchEvent({ type: 'click' }); await l.drain(60);
    editor(l).value = '新しい値';
    l.key({ key: 'Enter' }, editor(l));
    await l.drain(1);
    scroller(l).scrollTop = 32 * 5; scroller(l).dispatchEvent({ type: 'scroll' });
    await l.drain(80);
    assert.strictEqual(box(l).querySelectorAll('.dbwait').length, 0, '読んでいない行が空のまま');
    assert.strictEqual(box(l).querySelectorAll('.dbedit').length, 0);
    assert.strictEqual(cellOf(l, r0, l.c1).textContent, '新しい値', '捲ると古い値のまま');
  } finally { l.done(); }
  const s = await openDb();
  try {
    height(s, 640);
    const r0 = s.rows[0];
    cellOf(s, r0, s.c1).dispatchEvent({ type: 'click' }); await s.drain(60);
    editor(s).value = '新しい値';
    s.key({ key: 'Enter' }, editor(s));
    await s.drain(6);
    scroller(s).dispatchEvent({ type: 'scroll' });
    await s.drain(80);
    assert.strictEqual(box(s).querySelectorAll('.dbedit').length, 0, '書き手が残った');
    assert.strictEqual(cellOf(s, r0, s.c1).textContent, '新しい値');
    // 確かめの読み（知らせ）が答える前に捲った: 確かめは捲った読みが引き継ぐ（窓の行は覚えているので、引き継がないと読まない）
    const real = s.returns.dbView;
    let hold = null;
    s.returns.dbView = (...a) => { if (!hold) return new Promise((res) => { hold = () => res(real(...a)); }); return real(...a); };
    s.call('row.setCell', { db: s.id, id: s.rows[2], col: s.c1, value: 'ほかで直した' });
    s.fire('onPagesUpdated'); await s.drain(20);
    assert.ok(hold, '前提: 確かめの読みが止まっている');
    scroller(s).dispatchEvent({ type: 'scroll' }); await s.drain(60);
    hold(); await s.drain(60);
    s.returns.dbView = real;
    assert.strictEqual(cellOf(s, s.rows[2], s.c1).textContent, 'ほかで直した', '捲ると確かめが捨てられた');
  } finally { s.done(); }
});

test('DV-1 直し（rv44 F3）: 描き直してセルにフォーカスを戻しても捲らない（preventScroll）・少し捲っただけでは描き直さない・書いている間に遠くへ捲ると書いた値を決めて行を描く', T, async () => {
  const seen = [];
  const was = Element.prototype.focus;
  Element.prototype.focus = function (o) { seen.push(o); return was.call(this, o); };
  const l = await openDb({ many: 1000 });
  try {
    height(l, 640);
    await scrollTo(l, 0);
    const r0 = dataRows(l)[0].dataset.id;
    cellOf(l, r0, l.c3).dispatchEvent({ type: 'click' }); await l.drain(60);   // チェックのセル（押すと切り替えて描き直す）
    seen.length = 0;
    l.fire('onPagesUpdated'); l.call('row.setCell', { db: l.id, id: 'rz10', col: l.c1, value: 'ほか' }); l.fire('onPagesUpdated'); await l.drain(60);
    assert.ok(seen.length > 0 && seen.every((o) => o && o.preventScroll === true), `描き直しのフォーカスが捲る: ${JSON.stringify(seen)}`);
    const before = dataRows(l);
    await scrollTo(l, 32 * 3);
    assert.ok(dataRows(l).every((r, i) => r === before[i]), '3 行捲っただけで描き直した');
    // 書いている間に遠くへ捲る
    const r1 = dataRows(l)[4].dataset.id;
    cellOf(l, r1, l.c1).dispatchEvent({ type: 'click' }); await l.drain(60);
    editor(l).value = '捲る前に書いた';
    await scrollTo(l, 32 * 400);
    assert.strictEqual(box(l).querySelectorAll('.dbwait').length, 0, '書いている間に捲った所が空');
    assert.ok(dataRows(l).length > 0 && Number(dataRows(l)[0].dataset.i) >= 300, '捲った所の行を描かない');
    assert.strictEqual(cellsIn(l, r1) ? cellsIn(l, r1).cells[l.c1] : l.call('db.view', { id: l.id, viewId: 'v1', from: 0, count: 200 }).rows.find((r) => r.id === r1).cells[l.c1], '捲る前に書いた');
  } finally { Element.prototype.focus = was; l.done(); }
});

test('DV-1 直し（rv44 F4）: 日付の列の下の集計の期間は「期間 n 日」（数値の範囲は「範囲」）', T, async () => {
  const l = await openDb({ before: (call, d) => { call('view.update', { db: d.id, viewId: 'v1', patch: { agg: { [d.c4]: 'range', [d.c2]: 'range' } } }); } });
  try {
    const aggs = box(l).querySelectorAll('.dbagg').map((a) => a.textContent).filter(Boolean);
    assert.ok(aggs.includes('範囲 200'), JSON.stringify(aggs));
    assert.ok(aggs.some((x) => /^期間 \d+ 日$/.test(x)), `日付の期間の名前が違う: ${JSON.stringify(aggs)}`);
    await clickEl(l, head(l, l.c4)); await clickEl(l, item(l, '集計 ▸'));
    assert.ok(items(l).some((b) => b.textContent === '期間') && !items(l).some((b) => b.textContent === '範囲'), '集計の選びの日付の期間の名前が違う');
  } finally { l.done(); }
});

test('DV-1 直し（rv44 F6）: データベースのページの「···」に［コピー］が無い（R54）・表の末のセルの Tab は表の外へ（R48）', T, async () => {
  const l = await openDb();
  try {
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    const labels = $(l, 'pMenu').querySelectorAll('.mitem').map((b) => b.textContent);
    assert.ok(labels.includes('リンクを写す') && !labels.includes('コピー'), JSON.stringify(labels));
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    cellOf(l, l.rows[0], 'title').dispatchEvent({ type: 'click' }); await l.drain(60);
    await press(l, editor(l), { key: 'Escape' });
    await press(l, active(l), { key: 'End', ctrlKey: true });
    const last = active(l);
    assert.strictEqual(last.dataset.col, l.c4);
    const ev = await press(l, last, { key: 'Tab' });
    assert.ok(!ev.defaultPrevented, '表の末のセルの Tab を止めた（表の外へ出ない）');
    assert.ok(active(l) === last);
  } finally { l.done(); }
});

test('DV-1 直し（rv44 F6・R47）: 全部を選ぶは窓の外の行も選び、2,000 を越えると［削除］［列の値を変える ▸］は押せない（［リンクを写す］は押せる）', T, async () => {
  const l = await openDb({ many: 2001 });
  try {
    const all = box(l).querySelector('.dbcheckall');
    all.checked = true; all.dispatchEvent({ type: 'change' }); await l.drain(120);
    const bar = box(l).querySelector('.dbselbar');
    assert.strictEqual(bar.querySelector('.dbselcount').textContent, '2004 行を選んでいます', '窓の外の行を選ばない');
    assert.deepStrictEqual(bar.querySelectorAll('button').map((b) => [b.textContent, b.disabled]), [['削除', true], ['リンクを写す', false], ['列の値を変える ▸', true]]);
  } finally { l.done(); }
});

test('DV-1 直し（rv44 F8・F9）: 表の中の Ctrl+Tab・Ctrl+Shift+Tab は止めない（窓のタブを替える）・行のチェックは Tab で止まらない・メニューは変換中のキーを先に抜ける', T, async () => {
  const l = await openDb();
  try {
    assert.ok(box(l).querySelectorAll('.dbcheck').every((c) => c.tabIndex === -1), '行のチェックが Tab で止まる');
    cellOf(l, l.rows[0], l.c2).dispatchEvent({ type: 'click' }); await l.drain(60);
    const ed = editor(l);
    assert.ok(ed, '前提: 書いている');
    // 窓の受け口（document の Ctrl+Tab: タブを替える）が受け、書き手は右のセルへ動かない（偽 DOM は泡立たないので、書き手の受け口の後に document の受け口を呼ぶ）
    const e1 = await press(l, ed, { key: 'Tab', ctrlKey: true });
    assert.ok(e1.defaultPrevented, '窓の Ctrl+Tab が受けない');
    assert.ok(!(cellOf(l, l.rows[0], l.c3).getAttribute('aria-selected') === 'true'), '書き手の Ctrl+Tab で右のセルへ動いた');
    cellOf(l, l.rows[0], l.c3).dispatchEvent({ type: 'click' }); await l.drain(60);   // チェックのセル（切り替えて選ぶ）
    const cell = active(l);
    for (const o of [{ key: 'Tab', ctrlKey: true }, { key: 'Tab', ctrlKey: true, shiftKey: true }, { key: 'Tab', altKey: true }]) {
      await press(l, cell, o);
      assert.ok(active(l) === cell, `セルが ${JSON.stringify(o)} を受けた`);
    }
    await clickEl(l, head(l, l.c1));
    await press(l, menu(l), { key: 'Escape', isComposing: true });
    assert.ok(menu(l), '変換中の Esc でメニューを閉じた');
  } finally { l.done(); }
});

// ================================================================ DV-3（決めたこと 15〜23・R74〜）: ビューのタブと設定・リスト・下の集計の選び・中の検索
const tabs = (l) => box(l).querySelectorAll('.dbtab');
const tabNames = (l) => tabs(l).filter((b) => !b.hidden).map((b) => b.textContent);
const tabOn = (l) => tabs(l).find((b) => b.getAttribute('aria-selected') === 'true');
const panel = (l) => box(l).querySelector('.dbpanel');
const btnIn = (el, label) => el.querySelectorAll('button').find((b) => b.textContent === label);
const openPanel = async (l, label) => { await clickEl(l, box(l).querySelector('.dbsetbtn')); await clickEl(l, item(l, label)); return panel(l); };
const change = async (l, el, value, n = 120) => { if (value !== undefined) el.value = value; el.dispatchEvent({ type: 'change' }); await l.drain(n); };
const vupd = (l) => l.called('viewUpdate').map((c) => c.args[2]);
const viewNow = (l, vid = 'v1') => l.call('db.get', { id: l.id }).views.find((v) => v.id === vid);
const order = (l) => dataRows(l).map((r) => ['見積もり', '発注', '検収'][l.rows.indexOf(r.dataset.id)]);
const optLabels = (sel) => sel.querySelectorAll('option').map((o) => o.textContent);
const typeIn = async (l, inp, text, o = {}) => { inp.value = text; await press(l, inp, { key: 'Enter', ...o }); await l.drain(80); };

test('DV-3: ビューのタブの［＋］（表・リスト・名前）→ viewAdd・タブのメニュー（名前を変える・複製・リンクを写す・削除の確かめ）・最後の1つの［削除］は灰色', T, async () => {
  const l = await openDb();
  try {
    const add = box(l).querySelector('.dbviewadd');
    assert.deepStrictEqual([add.textContent, add.getAttribute('aria-label'), add.title], ['＋', 'ビューを足す', 'ビューを足す']);
    // 最後の1つ: 今のタブを押すとメニュー・［削除］は灰色
    await clickEl(l, tabOn(l));
    assert.deepStrictEqual(items(l).map((b) => [b.textContent, b.disabled]), [['名前を変える', false], ['複製', false], ['リンクを写す', false], ['削除', true]]);
    await press(l, menu(l), { key: 'Escape' });
    // ［＋］: 見出し・名前の欄・［表］［リスト］
    await clickEl(l, add);
    assert.strictEqual(menu(l).querySelector('.dbmenuhead').textContent, 'ビューを足す');
    const nm = menu(l).querySelector('input');
    assert.deepStrictEqual([nm.getAttribute('aria-label'), nm.getAttribute('placeholder')], ['ビューの名前', 'ビューの名前']);
    assert.ok(active(l) === nm, '名前の欄にフォーカスが無い');
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['表', 'リスト']);
    nm.value = '今週';
    await press(l, nm, { key: 'Enter', isComposing: true });
    assert.deepStrictEqual(l.called('viewAdd'), [], '変換確定の Enter でビューを足した');
    await clickEl(l, item(l, 'リスト'), 160);
    assert.deepStrictEqual(l.called('viewAdd').map((c) => c.args), [[l.id, { layout: 'list', name: '今週' }]]);
    assert.deepStrictEqual(tabNames(l), ['表', '今週']);
    assert.strictEqual(tabOn(l).textContent, '今週', '足したビューを選ばない');
    assert.ok(grid(l).classList.contains('dblist'), 'リストの形で描かない');
    // 名前の欄で Enter は表（名前が空なら「表」）
    await clickEl(l, box(l).querySelector('.dbviewadd'));
    await press(l, menu(l).querySelector('input'), { key: 'Enter' }); await l.drain(160);
    assert.deepStrictEqual(l.called('viewAdd').map((c) => c.args)[1], [l.id, { layout: 'table' }]);
    assert.deepStrictEqual(tabNames(l), ['表', '今週', '表']);
    const v2 = l.call('db.get', { id: l.id }).views[1].id;
    // 名前を変える（今のタブでないタブは右クリックでメニュー）
    const t2 = () => tabs(l).find((b) => b.textContent === '今週' || b.textContent === '来週');
    let stopped = false;
    t2().dispatchEvent({ type: 'contextmenu', preventDefault() { stopped = true; } }); await l.drain(40);
    assert.ok(stopped && menu(l), '右クリックでメニューが出ない');
    await clickEl(l, item(l, '名前を変える'));
    const rn = menu(l).querySelector('input');
    assert.deepStrictEqual([rn.value, rn.getAttribute('aria-label')], ['今週', 'ビューの名前']);
    await typeIn(l, rn, '来週', { isComposing: true });
    assert.deepStrictEqual(vupd(l), [], '変換確定の Enter で名前を決めた');
    await typeIn(l, rn, '来週');
    assert.deepStrictEqual(l.called('viewUpdate').map((c) => c.args), [[l.id, v2, { name: '来週' }]]);
    assert.deepStrictEqual(tabNames(l), ['表', '来週', '表']);
    // 複製 → viewAdd の from・複製したタブを選ぶ
    t2().dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(40);
    await clickEl(l, item(l, '複製'), 160);
    assert.deepStrictEqual(l.called('viewAdd').map((c) => c.args)[2], [l.id, { from: v2 }]);
    assert.deepStrictEqual(tabNames(l), ['表', '来週', '表', '来週']);
    assert.ok(tabOn(l) === tabs(l)[3], '複製したタブを選ばない');
    // リンクを写す（ページの［リンクを写す］と同じ https の形に、ビューの印 #…&a=v:<ID>）
    t2().dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(40);
    await clickEl(l, item(l, 'リンクを写す'));
    const copied = l.called('copy').map((c) => c.args[0]);
    // R87（2026-11-09 の持ち主の答え）で意図して直した: データベースのビューは「NaTsu の「題名」 住所」（議事録と書かない・日付なし）
    assert.deepStrictEqual(copied, [`NaTsu の「無題のデータベース」 https://example.invalid/open#p=${l.id}&a=v:${v2}`]);
    assert.strictEqual($(l, 'toast').textContent, 'リンクを写しました。');
    // 削除: 確かめ（断れば消さない）
    const asked = [];
    let yes = false;
    l.window.confirm = (m) => { asked.push(m); return yes; };
    t2().dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(40);
    await clickEl(l, item(l, '削除'));
    assert.deepStrictEqual(asked, ['ビュー『来週』を削除します。並べ替えや絞り込みの設定も消えます。行は消えません。']);
    assert.deepStrictEqual(l.called('viewRemove'), []);
    yes = true;
    t2().dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(40);
    await clickEl(l, item(l, '削除'), 160);
    assert.deepStrictEqual(l.called('viewRemove').map((c) => c.args), [[l.id, v2]]);
    assert.deepStrictEqual(tabNames(l), ['表', '表', '来週']);
    // 今のビューを消すと、残りの最初のビューを選ぶ
    await clickEl(l, tabOn(l));
    await clickEl(l, item(l, '削除'), 160);
    assert.deepStrictEqual(tabNames(l), ['表', '表']);
    assert.ok(tabOn(l) === tabs(l)[0], '消した後に残りの最初のビューを選ばない');
    assert.strictEqual(dataRows(l).length, 3);
    assert.ok(l.steps.every((s) => !/^view\./.test(s.cmd)), 'ビューの命令が歩みに積まれた');
    // ビューは 20 まで
    for (let i = l.call('db.get', { id: l.id }).views.length; i < 20; i += 1) l.call('view.add', { db: l.id });
    l.fire('onPagesUpdated'); await l.drain(80);
    await clickEl(l, box(l).querySelector('.dbviewadd'));
    assert.strictEqual($(l, 'toast').textContent, 'ビューは 20 までです。');
    assert.ok(menu(l) === null, 'menu(l) が残っている');   // DOM を比べの答えに出さない（赤のとき大きな木を文字にしない: R28）
    await clickEl(l, tabOn(l));
    assert.strictEqual(item(l, '複製').disabled, true, '20 個目の後に複製できる');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-3: タブを引っ張って viewMove・入り切らないタブは「他 n 件」から選ぶ', T, async () => {
  const l = await openDb({ before: (call, d) => { for (const n of ['二', '三', '四', '五', '六']) call('view.add', { db: d.id, name: n }); } });
  const was = Element.prototype.getBoundingClientRect;
  try {
    assert.deepStrictEqual(tabNames(l), ['表', '二', '三', '四', '五', '六']);
    assert.ok(box(l).querySelector('.dbtabmore').hidden, '入り切るのに「他 n 件」が出る');
    // 引っ張る: 「三」を「表」の左半分へ → 先頭へ
    const types = ['application/x-natsu-view'];
    const tb = (name) => tabs(l).find((b) => b.textContent === name);
    for (const b of tabs(l)) b._rect = { left: 0, width: 100 };
    assert.strictEqual(tb('三').draggable, true);
    tb('三').dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData() {} } });
    let ok = false;
    tb('表').dispatchEvent({ type: 'dragover', clientX: 10, dataTransfer: { types }, preventDefault() { ok = true; } });
    assert.ok(ok, 'タブの上で落とせない');
    tb('表').dispatchEvent({ type: 'drop', clientX: 10, dataTransfer: { types }, preventDefault() {} }); await l.drain(160);
    assert.deepStrictEqual(l.called('viewMove').map((c) => c.args), [[l.id, 'v3', '']]);
    assert.deepStrictEqual(tabNames(l), ['三', '表', '二', '四', '五', '六']);
    for (const b of tabs(l)) b._rect = { left: 0, width: 100 };
    tb('四').dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData() {} } });
    tb('表').dispatchEvent({ type: 'drop', clientX: 80, dataTransfer: { types }, preventDefault() {} }); await l.drain(160);
    assert.deepStrictEqual(l.called('viewMove').map((c) => c.args)[1], [l.id, 'v4', 'v1'], '右半分で後ろへ動かさない');
    assert.ok(l.steps.every((s) => !/^view\./.test(s.cmd)));
    // 入り切らない: 幅 450 のタブの並びに幅 100 のタブ 6 つ → 今のタブと 2 つだけ・「他 3 件」
    Element.prototype.getBoundingClientRect = function rect() {
      if (this.classList.contains('dbtabs')) return { top: 0, left: 0, right: 450, bottom: 30, width: 450, height: 30 };
      if (this.classList.contains('dbtab')) return { top: 0, left: 0, right: 100, bottom: 30, width: 100, height: 30 };
      return was.call(this);
    };
    await clickEl(l, tb('二'), 160);
    assert.deepStrictEqual(tabNames(l), ['三', '表', '二']);
    const more = box(l).querySelector('.dbtabmore');
    assert.deepStrictEqual([more.hidden, more.textContent], [false, '他 3 件']);
    await clickEl(l, more);
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['四', '五', '六']);
    await clickEl(l, item(l, '六'), 160);
    assert.strictEqual(tabOn(l).textContent, '六', '「他 n 件」から選べない');
    assert.ok(!tabOn(l).hidden, '選んだタブが隠れている');
    assert.strictEqual(tabNames(l).length, 3);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { Element.prototype.getBoundingClientRect = was; l.done(); }
});

test('DV-3・F138: 並べ替え（重ねる・⋮⋮ で優先・外す）→ どれも viewUpdate の1回', T, async () => {
  const l = await openDb();
  try {
    await clickEl(l, box(l).querySelector('.dbsetbtn'));
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['並べ替え', '絞り込み', 'グループ', '列の表示', '消した列']);
    await clickEl(l, item(l, '並べ替え'));
    const p = panel(l);
    assert.strictEqual(p.querySelector('.dbmenuhead').textContent, '並べ替え');
    await clickEl(l, btnIn(p, '並べ替えを足す'), 160);
    assert.deepStrictEqual(vupd(l), [{ sort: [{ col: 'title', dir: 'asc' }] }]);
    const rule = () => panel(l).querySelectorAll('.dbsortrow');
    const sel = (i, k) => rule()[i].querySelectorAll('select')[k];
    assert.deepStrictEqual([sel(0, 0).getAttribute('aria-label'), sel(0, 1).getAttribute('aria-label')], ['列', '向き']);
    assert.deepStrictEqual(optLabels(sel(0, 1)), ['昇順', '降順']);
    await change(l, sel(0, 0), l.c2);
    await change(l, sel(0, 1), 'desc');
    assert.deepStrictEqual(vupd(l).slice(1), [{ sort: [{ col: l.c2, dir: 'asc' }] }, { sort: [{ col: l.c2, dir: 'desc' }] }]);
    assert.deepStrictEqual(order(l), ['検収', '発注', '見積もり']);
    assert.ok(panel(l), '並べ替えを変えると窓が閉じた');
    // 重ねる: 2つ目は使っていない列
    await clickEl(l, btnIn(panel(l), '並べ替えを足す'), 160);
    assert.deepStrictEqual(viewNow(l).sort, [{ col: l.c2, dir: 'desc' }, { col: 'title', dir: 'asc' }]);
    assert.ok(!optLabels(sel(1, 0)).includes('金額'), '使っている列を2つ目に選べる');
    // ⋮⋮ で優先を替える（2つ目を1つ目の上へ）
    const types = ['application/x-natsu-sort'];
    for (const r of rule()) r._rect = { top: 0, height: 30 };
    rule()[1].querySelector('.dbgrip').dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData() {} } });
    rule()[0].dispatchEvent({ type: 'dragover', clientY: 2, dataTransfer: { types }, preventDefault() {} });
    rule()[0].dispatchEvent({ type: 'drop', clientY: 2, dataTransfer: { types }, preventDefault() {} }); await l.drain(160);
    assert.deepStrictEqual(viewNow(l).sort, [{ col: 'title', dir: 'asc' }, { col: l.c2, dir: 'desc' }]);
    // 外す
    const x = rule()[0].querySelector('.dbx');
    assert.deepStrictEqual([x.textContent, x.getAttribute('aria-label'), x.title], ['✕', '外す', '外す']);
    await clickEl(l, x, 160);
    await clickEl(l, rule()[0].querySelector('.dbx'), 160);
    assert.deepStrictEqual(viewNow(l).sort, []);
    assert.strictEqual(l.called('viewUpdate').length, 7);
    assert.ok(l.steps.every((s) => !/^view\./.test(s.cmd)), 'ビューの設定が歩みに積まれた');
    await press(l, panel(l), { key: 'Escape' });
    assert.ok(panel(l) === null, 'Esc で閉じない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-3・F138: 絞り込み（条件・かつ／または・グループを足す・3 段まで）→ viewUpdate の1回。下の集計は絞り込んだ後の行で数える', T, async () => {
  const l = await openDb({ before: (call, d) => { call('view.update', { db: d.id, viewId: 'v1', patch: { agg: { [d.c2]: 'sum' } } }); return withTypes(call, d); } });
  try {
    const foot = () => box(l).querySelectorAll('.dbagg').map((a) => a.textContent).filter(Boolean);
    assert.deepStrictEqual(foot(), ['合計 600']);
    const p = await openPanel(l, '絞り込み');
    assert.strictEqual(p.querySelector('.dbmenuhead').textContent, '絞り込み');
    const top = () => panel(l).querySelector('.dbfgroup');
    assert.deepStrictEqual(top().querySelectorAll('.dbfop').map((b) => [b.textContent, b.getAttribute('aria-pressed')]), [['かつ', 'true'], ['または', 'false']]);
    await clickEl(l, btnIn(top(), '条件を足す'));
    assert.deepStrictEqual(vupd(l), [], '値の無い条件で絞り込みを書いた');
    const cond = (i = 0) => panel(l).querySelectorAll('.dbfcond')[i];
    const [cs, os] = cond().querySelectorAll('select');
    assert.deepStrictEqual([cs.getAttribute('aria-label'), os.getAttribute('aria-label')], ['列', '条件']);
    assert.deepStrictEqual(optLabels(os), ['含む', '含まない', '等しい', '始まる', '終わる', '空', '空でない']);
    const val = cond().querySelector('input');
    assert.strictEqual(val.getAttribute('aria-label'), '名前');
    await typeIn(l, val, '発', { isComposing: true });
    assert.deepStrictEqual(vupd(l), [], '変換確定の Enter で絞り込みを書いた');
    await typeIn(l, val, '発');
    assert.deepStrictEqual(vupd(l), [{ filter: { op: 'and', items: [{ col: 'title', cmp: 'contains', value: '発' }] } }]);
    assert.deepStrictEqual(order(l), ['発注']);
    assert.deepStrictEqual(foot(), ['合計 200'], '下の集計を絞り込む前の行で数えた');
    // 数値の列: 条件の名前・数の欄
    await change(l, cond().querySelectorAll('select')[0], l.c2);
    assert.deepStrictEqual(optLabels(cond().querySelectorAll('select')[1]), ['=', '≠', '>', '<', '≥', '≤', '空']);
    await change(l, cond().querySelectorAll('select')[1], 'gt');
    const num = cond().querySelector('input');
    assert.deepStrictEqual([num.type, num.getAttribute('aria-label')], ['number', '金額']);
    num.value = '150'; await change(l, num);
    assert.deepStrictEqual(viewNow(l).filter, { op: 'and', items: [{ col: l.c2, cmp: 'gt', value: 150 }] });
    assert.deepStrictEqual(order(l), ['発注', '検収']);
    assert.deepStrictEqual(foot(), ['合計 500']);
    // 選択の列: 選択肢のチェック（名前は列の選択肢）
    await clickEl(l, btnIn(top(), '条件を足す'));
    await change(l, cond(1).querySelectorAll('select')[0], l.c5);
    assert.deepStrictEqual(optLabels(cond(1).querySelectorAll('select')[1]), ['どれか', 'どれでもない', '空']);
    const boxes = cond(1).querySelectorAll('.dbfopt input');
    assert.deepStrictEqual(boxes.map((b) => b.getAttribute('aria-label')), ['高', '低']);
    boxes[0].checked = true; await change(l, boxes[0]);
    assert.deepStrictEqual(viewNow(l).filter.items[1], { col: l.c5, cmp: 'any', value: [l.o5[0].id] });
    assert.deepStrictEqual(order(l), [], '「かつ」で読まない');
    // または
    await clickEl(l, top().querySelectorAll('.dbfop')[1], 160);
    assert.strictEqual(viewNow(l).filter.op, 'or');
    assert.deepStrictEqual(order(l), ['見積もり', '発注', '検収']);
    // 日付・チェック・作成者の条件の名前
    await change(l, cond(1).querySelectorAll('select')[0], l.c8);
    assert.deepStrictEqual(optLabels(cond(1).querySelectorAll('select')[1]), ['前', '後', 'その日', '間', '今日', '過去 n 日', '次の n 日', '空']);
    await change(l, cond(1).querySelectorAll('select')[1], 'between');
    assert.deepStrictEqual(cond(1).querySelectorAll('input').map((i) => [i.type, i.getAttribute('aria-label')]), [['date', '期日'], ['date', '終わりの日']]);
    await change(l, cond(1).querySelectorAll('select')[1], 'pastDays');
    assert.deepStrictEqual(cond(1).querySelectorAll('input').map((i) => [i.type, i.getAttribute('aria-label'), i.value]), [['number', '期日', '7']]);
    await change(l, cond(1).querySelectorAll('select')[0], l.c3);
    assert.deepStrictEqual(optLabels(cond(1).querySelectorAll('select')[1]), ['はい', 'いいえ']);
    assert.strictEqual(cond(1).querySelectorAll('input').length, 0);
    await change(l, cond(1).querySelectorAll('select')[0], l.c14);
    assert.deepStrictEqual(optLabels(cond(1).querySelectorAll('select')[1]), ['どれか', 'どれでもない']);
    assert.deepStrictEqual(cond(1).querySelectorAll('input').map((b) => b.getAttribute('aria-label')), ['自分', 'Claude', 'NaTsu']);
    await change(l, cond(1).querySelectorAll('select')[0], l.c6);
    assert.deepStrictEqual(optLabels(cond(1).querySelectorAll('select')[1]), ['どれかを含む', '全部を含む', '空']);
    // グループを足す: 3 段まで（3 段目のグループに［グループを足す］は灰色）
    await clickEl(l, btnIn(top(), 'グループを足す'));
    const g2 = () => top().querySelectorAll('.dbfgroup')[0];
    assert.ok(g2(), '入れ子のグループが無い');
    await clickEl(l, btnIn(g2(), 'グループを足す'));
    const g3 = () => g2().querySelectorAll('.dbfgroup')[0];
    assert.strictEqual(btnIn(g3(), 'グループを足す').disabled, true, '4 段目のグループを足せる');
    await clickEl(l, btnIn(g3(), '条件を足す'));
    await change(l, g3().querySelector('.dbfcond select'), l.c3);
    assert.deepStrictEqual(viewNow(l).filter.items[1], { op: 'and', items: [{ op: 'and', items: [{ col: l.c3, cmp: 'yes' }] }] });   // 値の無い条件（複数選択）は書かない
    // 外す（条件・グループ）
    await clickEl(l, g2().querySelector('.dbx'), 160);
    assert.strictEqual(viewNow(l).filter.items.length, 1);
    await clickEl(l, cond(1).querySelector('.dbx'), 160);
    await clickEl(l, cond(0).querySelector('.dbx'), 160);
    assert.strictEqual(viewNow(l).filter, null);
    assert.deepStrictEqual(order(l), ['見積もり', '発注', '検収']);
    assert.ok(l.steps.every((s) => !/^view\./.test(s.cmd)), 'ビューの設定が歩みに積まれた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-3・F138: グループ（列を選ぶ・開け閉め・空のグループを隠す・出し入れ・手で並べる・昇順に並べる・グループの［＋］）→ viewUpdate の1回', T, async () => {
  const l = await openDb({ before: withTypes });
  try {
    const p = await openPanel(l, 'グループ');
    assert.strictEqual(p.querySelector('.dbmenuhead').textContent, 'グループ');
    const colSel = () => panel(l).querySelector('select');
    assert.strictEqual(colSel().getAttribute('aria-label'), '列');
    assert.strictEqual(optLabels(colSel())[0], 'なし');
    await change(l, colSel(), l.c3, 200);
    assert.deepStrictEqual(vupd(l), [{ group: { col: l.c3 } }]);
    const gheads = () => box(l).querySelectorAll('.dbghead');
    const ghead = (i) => [gheads()[i].querySelector('.dbgname').textContent, gheads()[i].querySelector('.dbgcount').textContent];
    assert.deepStrictEqual([ghead(0), ghead(1)], [['未チェック', '2'], ['チェック済み', '1']]);
    assert.deepStrictEqual(dataRows(l).map((r) => r.dataset.id), [l.rows[1], l.rows[2], l.rows[0]]);
    // 開け閉め（目のアイコンの出し入れと同じ hide）
    const tog = gheads()[0].querySelector('.dbgtoggle');
    assert.deepStrictEqual([tog.getAttribute('aria-expanded'), tog.getAttribute('aria-label')], ['true', '未チェック']);
    await clickEl(l, tog, 200);
    assert.deepStrictEqual(viewNow(l).group, { col: l.c3, hide: ['false'] });
    assert.deepStrictEqual(dataRows(l).map((r) => r.dataset.id), [l.rows[0]]);
    const seq = () => domRows(l).map((r) => (r.classList.contains('dbghead') ? r.querySelector('.dbgname').textContent : r.dataset.id));
    assert.deepStrictEqual(seq(), ['未チェック', 'チェック済み', l.rows[0]], '閉じたグループの下に行を描いた');
    assert.deepStrictEqual(ghead(0), ['未チェック', '2']);
    assert.strictEqual(gheads()[0].querySelector('.dbgtoggle').getAttribute('aria-expanded'), 'false');
    await clickEl(l, gheads()[0].querySelector('.dbgtoggle'), 200);
    assert.deepStrictEqual(viewNow(l).group, { col: l.c3 });
    // グループの［＋］: そのグループの値で行を足す
    const plus = gheads()[1].querySelector('.dbgadd');
    assert.deepStrictEqual([plus.textContent, plus.getAttribute('aria-label'), plus.title], ['＋', '＋ 新しい行', '＋ 新しい行']);
    await clickEl(l, plus, 200);
    assert.deepStrictEqual(l.called('rowAdd').map((c) => c.args), [[l.id, { cells: { [l.c3]: true } }]]);
    assert.deepStrictEqual(ghead(1), ['チェック済み', '2']);
    // 選択の列: 選択肢ごと・空のグループ「（空）」・空のグループを隠す
    await change(l, colSel(), l.c5, 200);
    assert.deepStrictEqual([0, 1, 2].map(ghead), [['高', '1'], ['低', '0'], ['（空）', '3']]);
    const hideEmpty = panel(l).querySelectorAll('input').find((b) => b.getAttribute('aria-label') === '空のグループを隠す');
    assert.ok(hideEmpty, '［空のグループを隠す］が無い');
    hideEmpty.checked = true; await change(l, hideEmpty, undefined, 200);
    assert.deepStrictEqual(viewNow(l).group, { col: l.c5, hideEmpty: true });
    assert.deepStrictEqual(gheads().map((h) => h.querySelector('.dbgname').textContent), ['高', '（空）']);
    // 出し入れ（グループの名前のチェック）と手で並べる・昇順に並べる
    const list = () => panel(l).querySelectorAll('.dbglist .dbgrow');
    assert.deepStrictEqual(list().map((r) => r.querySelector('input').getAttribute('aria-label')), ['高', '（空）']);
    const eye = list()[1].querySelector('input'); eye.checked = false; await change(l, eye, undefined, 200);
    assert.deepStrictEqual(viewNow(l).group.hide, ['']);
    const types = ['application/x-natsu-group'];
    for (const r of list()) r._rect = { top: 0, height: 30 };
    list()[1].querySelector('.dbgrip').dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData() {} } });
    list()[0].dispatchEvent({ type: 'drop', clientY: 2, dataTransfer: { types }, preventDefault() {} }); await l.drain(200);
    assert.deepStrictEqual(viewNow(l).group.order, ['', l.o5[0].id]);
    assert.deepStrictEqual(gheads().map((h) => h.querySelector('.dbgname').textContent), ['（空）', '高']);
    await clickEl(l, btnIn(panel(l), '昇順に並べる'), 200);
    assert.ok(!('order' in viewNow(l).group), '昇順に戻らない');
    assert.strictEqual(btnIn(panel(l), '昇順に並べる').disabled, true);
    // 日付の列: 日・週・月・年
    await change(l, colSel(), l.c8, 200);
    const by = panel(l).querySelectorAll('select')[1];
    assert.deepStrictEqual([by.getAttribute('aria-label'), optLabels(by)], ['グループ', ['日', '週', '月', '年']]);
    assert.strictEqual(gheads()[0].querySelector('.dbgname').textContent, '2026/11');
    await change(l, by, 'week', 200);
    assert.strictEqual(gheads()[0].querySelector('.dbgname').textContent, '2026/11/02 の週');
    await change(l, by, 'year', 200);
    assert.strictEqual(gheads()[0].querySelector('.dbgname').textContent, '2026');
    // ステータス: 3つのまとまり・選択肢ごと
    await change(l, colSel(), l.c7, 200);
    assert.deepStrictEqual(optLabels(panel(l).querySelectorAll('select')[1]), ['3つのまとまり', '選択肢ごと']);
    assert.deepStrictEqual(gheads().map((h) => h.querySelector('.dbgname').textContent), ['未着手', '進行中', '完了']);
    // なし
    await change(l, colSel(), '', 200);
    assert.strictEqual(viewNow(l).group, null);
    assert.strictEqual(gheads().length, 0);
    assert.ok(l.steps.every((s) => !/^view\./.test(s.cmd)), 'ビューの設定が歩みに積まれた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-3・F138: 列の表示（チェック・⋮⋮）・見出しを引っ張って並べる・幅を引っ張る → viewUpdate の1回（col.move は呼ばない・歩みにしない）', T, async () => {
  const l = await openDb();
  try {
    const p = await openPanel(l, '列の表示');
    assert.strictEqual(p.querySelector('.dbmenuhead').textContent, '列の表示');
    const rows = () => panel(l).querySelectorAll('.dbproprow');
    const cks = () => rows().map((r) => r.querySelector('input'));
    assert.deepStrictEqual(cks().map((c) => [c.getAttribute('aria-label'), c.checked, Boolean(c.disabled)]),
      [['名前', true, true], ['メモ', true, false], ['金額', true, false], ['済み', true, false], ['作った日', true, false]]);
    const memo = cks()[1]; memo.checked = false; await change(l, memo, undefined, 200);
    assert.deepStrictEqual(vupd(l).length, 1);
    assert.strictEqual(viewNow(l).props.find((x) => x.col === l.c1).show, false);
    assert.ok(!heads(l).includes('メモ'), '隠した列が出る');
    // ⋮⋮ で並べる: 金額を名前の上へ（題名の列も動かせる: V-T11）
    const types = ['application/x-natsu-prop'];
    for (const r of rows()) r._rect = { top: 0, height: 30 };
    rows()[2].querySelector('.dbgrip').dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData() {} } });
    rows()[0].dispatchEvent({ type: 'drop', clientY: 2, dataTransfer: { types }, preventDefault() {} }); await l.drain(200);
    assert.deepStrictEqual(viewNow(l).props.map((x) => x.col), [l.c2, 'title', l.c1, l.c3, l.c4]);
    assert.deepStrictEqual(heads(l), ['金額', '名前', '済み', '作った日']);
    await press(l, panel(l), { key: 'Escape' });
    // 見出しを引っ張る: 作った日を名前の左へ
    const h = (col) => box(l).querySelectorAll('.dbcolh').find((x) => x.dataset.col === col);
    for (const x of box(l).querySelectorAll('.dbcolh')) x._rect = { left: 0, width: 100 };
    const hb = h(l.c4).querySelector('.dbcolbtn');
    assert.strictEqual(hb.draggable, true);
    hb.dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData() {} } });
    let ok = false;
    h('title').dispatchEvent({ type: 'dragover', clientX: 10, dataTransfer: { types: ['application/x-natsu-col'] }, preventDefault() { ok = true; } });
    assert.ok(ok && h('title').classList.contains('dropbefore'), '見出しの上で落とせない');
    h('title').dispatchEvent({ type: 'drop', clientX: 10, dataTransfer: { types: ['application/x-natsu-col'] }, preventDefault() {} }); await l.drain(200);
    assert.deepStrictEqual(heads(l), ['金額', '作った日', '名前', '済み']);
    assert.deepStrictEqual(l.called('colMove'), [], '見出しの並べ替えで列の並び（col.move）を書いた');
    // 幅を引っ張る: 動かしている間は画面だけ、離したときに1回（80〜800px）
    const n = l.called('viewUpdate').length;
    const grip = h(l.c2).querySelector('.dbresize');
    assert.strictEqual(grip.getAttribute('aria-hidden'), 'true');
    grip.dispatchEvent({ type: 'mousedown', clientX: 500, button: 0, preventDefault() {}, stopPropagation() {} });
    l.key({ type: 'mousemove', clientX: 560 }); l.key({ type: 'mousemove', clientX: 620 });
    await l.drain(40);
    assert.strictEqual(h(l.c2).style.width, '300px');
    assert.strictEqual(cellOf(l, l.rows[0], l.c2).style.width, '300px');
    assert.strictEqual(l.called('viewUpdate').length, n, '引っ張っている間に書いた');
    l.key({ type: 'mouseup', clientX: 620 }); await l.drain(200);
    assert.strictEqual(l.called('viewUpdate').length, n + 1);
    assert.strictEqual(viewNow(l).props.find((x) => x.col === l.c2).width, 300);
    h('title').querySelector('.dbresize').dispatchEvent({ type: 'mousedown', clientX: 500, button: 0, preventDefault() {}, stopPropagation() {} });
    l.key({ type: 'mousemove', clientX: -900 }); l.key({ type: 'mouseup', clientX: -900 }); await l.drain(200);
    assert.strictEqual(viewNow(l).props.find((x) => x.col === 'title').width, 80, '幅が 80 より狭い');
    assert.ok(l.steps.every((s) => !/^(view|col)\./.test(s.cmd)), 'ビューの設定が歩みに積まれた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-3: リストの形（アイコン 題名・右端の値）・リストの［＋ 新しい行］', T, async () => {
  const l = await openDb({ before: (call, d) => {
    const v = call('view.add', { db: d.id, layout: 'list', name: '一覧' }).view;
    call('view.update', { db: d.id, viewId: v.id, patch: { props: v.props.map((x) => (x.col === d.c2 ? { ...x, show: true } : x)) } });
  } });
  try {
    await clickEl(l, tabs(l)[1], 200);
    assert.ok(grid(l).classList.contains('dblist'));
    assert.ok(box(l).querySelector('.dbrowh') === null, 'リストに列の見出しがある');   // DOM を比べの答えに出さない（赤のとき大きな木を文字にしない: R28）
    const r0 = dataRows(l)[0];
    assert.strictEqual(r0.querySelector('.dbicon').textContent, '📄');
    assert.deepStrictEqual(r0.querySelectorAll('.dbcell').map((c) => c.textContent), ['見積もり', '100']);
    assert.ok(box(l).querySelector('.dbfoot').hidden, 'リストに下の集計が出る');
    await clickEl(l, box(l).querySelector('.dbadd'), 200);
    assert.strictEqual(l.called('rowAdd').length, 1);
    assert.ok(editor(l) && active(l) === editor(l), '足した行の題名を書かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-3: 下の集計の選び（空の欄は「集計」）→ viewUpdate の1回・外す', T, async () => {
  const l = await openDb();
  try {
    const btn = (col) => box(l).querySelectorAll('.dbaggbtn').find((b) => b.dataset.col === col);
    assert.ok(!box(l).querySelector('.dbfoot').hidden, '下の集計の欄が無い');
    assert.deepStrictEqual([btn(l.c2).textContent, btn(l.c2).getAttribute('aria-label')], ['', '集計']);
    await clickEl(l, btn(l.c2));
    await clickEl(l, item(l, '平均'), 200);
    assert.deepStrictEqual(vupd(l), [{ agg: { [l.c2]: 'avg' } }]);
    assert.deepStrictEqual([btn(l.c2).textContent, btn(l.c2).getAttribute('aria-label')], ['平均 200', '平均 200']);
    await clickEl(l, btn(l.c2));
    await clickEl(l, item(l, '平均'), 200);
    assert.deepStrictEqual(viewNow(l).agg, {});
    assert.ok(l.steps.every((s) => !/^view\./.test(s.cmd)));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-3: 行が 3 以上で検索の欄・語で絞る（db.view の q）・語はビューに覚えない・Esc で消す', T, async () => {
  const l = await openDb();
  try {
    const q = () => box(l).querySelector('.dbsearch input');
    assert.deepStrictEqual([q().getAttribute('placeholder'), q().getAttribute('aria-label')], ['この中を探す', 'この中を探す']);
    q().value = '発'; q().dispatchEvent({ type: 'input', isComposing: true }); await l.drain(120);
    assert.deepStrictEqual(order(l), ['見積もり', '発注', '検収'], '変換中の語で探した');
    q().dispatchEvent({ type: 'input' }); await l.drain(160);
    assert.deepStrictEqual(order(l), ['発注']);
    assert.ok(views(l).some((a) => a[4] === '発'), 'db.view に語を渡さない');
    assert.deepStrictEqual(l.called('viewUpdate'), [], '語をビューに書いた');
    assert.ok(!('q' in viewNow(l)));
    // 描き直しても語と欄は残る
    l.call('row.setCell', { db: l.id, id: l.rows[1], col: l.c1, value: '直した' });
    l.fire('onPagesUpdated'); await l.drain(120);
    assert.strictEqual(q().value, '発');
    assert.deepStrictEqual(order(l), ['発注']);
    await press(l, q(), { key: 'Escape' }); await l.drain(120);
    assert.strictEqual(q().value, '');
    assert.deepStrictEqual(order(l), ['見積もり', '発注', '検収']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
  const s = await openDb({ titles: ['一', '二'] });
  try {
    assert.ok(box(s).querySelector('.dbsearch') === null, '行が 2 なのに検索の欄が出る');   // DOM を比べの答えに出さない（赤のとき大きな木を文字にしない: R28）
  } finally { s.done(); }
});

test('DV-3: ビューのリンク（#p=…&a=v:<ID>）で開くと、そのビューのタブを選ぶ', T, async () => {
  const l = await openDb({ before: (call, d) => { call('view.add', { db: d.id, name: '二' }); call('view.add', { db: d.id, name: '三' }); } });
  try {
    assert.strictEqual(tabOn(l).textContent, '表');
    l.fire('onOpenLink', { id: l.id, anchor: 'v:v3' }); await l.drain(200);
    assert.strictEqual(tabOn(l).textContent, '三');
    l.fire('onOpenLink', { id: l.id, anchor: 'v:v9' }); await l.drain(200);
    assert.strictEqual(tabOn(l).textContent, '三', '無いビューで今のタブを替えた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ================================================================ DV-2 直し（2026-11-08 の 6377ef8..6a9f0c5 の点検 rv46。R82〜）
const pasteKey = (l) => press(l, active(l), { key: 'v', code: 'KeyV', ctrlKey: true });
const selectOnly = async (l, rowId, col) => {
  await clickEl(l, cellOf(l, rowId, col), 60);
  if (editor(l)) await press(l, editor(l), { key: 'Escape' });
  if (picker(l)) await press(l, picker(l).querySelector('input'), { key: 'Escape' });
};

test('DV-2 直し（rv46 I1）: 1つの値の貼り付けで題名が 500 字を越えると断って一言（題名を空にしない）', T, async () => {
  let clip = { text: '' };
  const l = await openDb({ returns: { clipReadRows: () => clip } });
  try {
    await selectOnly(l, l.rows[0], 'title');
    clip = { text: 'あ'.repeat(501) };
    await pasteKey(l); await l.drain(60);
    assert.strictEqual($(l, 'toast').textContent, 'この列の値として読めませんでした。');
    assert.deepStrictEqual(l.called('rowsPaste'), []);
    assert.strictEqual(cellsIn(l, l.rows[0]).title, '見積もり', '題名が消えた');
    clip = { text: '新しい題名' };
    await pasteKey(l); await l.drain(60);
    assert.strictEqual(cellsIn(l, l.rows[0]).title, '新しい題名');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2 直し（rv46 I2・I3）: 暦は Enter でなくても決まる（ほかのセルを押す・暦の外へ動く・遠くへ捲る）。同じ日の時刻の期間（終わりの時刻だけ）を消さない', T, async () => {
  const l = await openDb({ before: withTypes });
  try {
    const [r0, r1, r2] = l.rows;
    const ins = () => picker(l).querySelectorAll('input');
    const by = (label) => ins().find((i) => i.getAttribute('aria-label') === label);
    // ほかのセルを押す → 打った日を書いて閉じる
    await clickEl(l, cellOf(l, r1, l.c8), 60);
    by('期日').value = '2026-11-10';
    await clickEl(l, cellOf(l, r2, l.c1), 80);
    assert.deepStrictEqual(cellsIn(l, r1).cells[l.c8], { start: '2026-11-10' });
    assert.ok(picker(l) === null, '暦が残っている');
    if (editor(l)) await press(l, editor(l), { key: 'Escape' });
    // 暦の外へフォーカスが動く（マウスで暦から日を選んで外を押す）→ 書く。暦の中の欄の間を動くのは書かない
    await clickEl(l, cellOf(l, r2, l.c8), 60);
    const pop = picker(l);
    by('期日').value = '2026-11-12';
    pop.dispatchEvent({ type: 'focusout', relatedTarget: by('時刻') }); await l.drain(60);
    assert.ok(picker(l) === pop, '暦の中で動いただけで閉じた');
    pop.dispatchEvent({ type: 'focusout', relatedTarget: null }); await l.drain(80);
    assert.deepStrictEqual(cellsIn(l, r2).cells[l.c8], { start: '2026-11-12' });
    assert.ok(picker(l) === null);
    // 読めない値は、外へ動いても書かずに一言
    await clickEl(l, cellOf(l, r2, l.c8), 60);
    const [endBox] = picker(l).querySelectorAll('.dbdatecheck input');
    endBox.checked = true; endBox.dispatchEvent({ type: 'change' });
    by('終わりの日').value = '2026-11-01';
    const n = l.called('rowSetCell').length;
    await clickEl(l, cellOf(l, r1, l.c1), 80);
    assert.strictEqual($(l, 'toast').textContent, 'この列の値として読めませんでした。');
    assert.strictEqual(l.called('rowSetCell').length, n);
    if (editor(l)) await press(l, editor(l), { key: 'Escape' });
    // 同じ日の時刻の期間: Enter で何も変えずに決めても、終わりの時刻が残る（書かない）
    l.call('row.setCell', { db: l.id, id: r0, col: l.c8, value: { start: '2026-11-04', time: '10:00', endTime: '11:00' } });
    l.fire('onPagesUpdated'); await l.drain(60);
    assert.strictEqual(cellOf(l, r0, l.c8).textContent, '2026/11/04 10:00 → 11:00');
    await clickEl(l, cellOf(l, r0, l.c8), 60);
    assert.deepStrictEqual([by('終わりの日').hidden, by('終わりの時刻').hidden, by('終わりの時刻').value], [false, false, '11:00']);
    const m = l.called('rowSetCell').length;
    await press(l, by('期日'), { key: 'Enter' });
    assert.strictEqual(l.called('rowSetCell').length, m, '変えていないのに書いた');
    assert.deepStrictEqual(cellsIn(l, r0).cells[l.c8], { start: '2026-11-04', time: '10:00', endTime: '11:00' });
    // 終わりの時刻を変えると、同じ日のまま（終わりの日を書かない）
    await clickEl(l, cellOf(l, r0, l.c8), 60);
    by('終わりの時刻').value = '12:00';
    await press(l, by('終わりの時刻'), { key: 'Enter' });
    assert.deepStrictEqual(cellsIn(l, r0).cells[l.c8], { start: '2026-11-04', time: '10:00', endTime: '12:00' });
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2 直し（rv46 I2）: 暦を開いたまま遠くへ捲ると、打った日を書いて閉じる', T, async () => {
  const l = await openDb({ many: 300, before: (call, d) => ({ c8: call('col.add', { db: d.id, type: 'date', name: '期日' }).col.id }) });
  try {
    height(l, 640);
    await clickEl(l, cellOf(l, l.rows[0], l.c8), 60);
    picker(l).querySelectorAll('input')[0].value = '2026-11-20';
    await scrollTo(l, 32 * 200);
    await l.drain(80);
    assert.deepStrictEqual(cellsIn(l, l.rows[0]).cells[l.c8], { start: '2026-11-20' }, '捲ると打った日が消えた');
    assert.ok(picker(l) === null, '暦が残っている');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2 直し（rv46 M1・M2）: 選びの窓の Tab は閉じて右（Shift+Tab は左）のセルへ。書けなかった選びは窓の印に残さない・51 字の名前は断る', T, async () => {
  const l = await openDb({ before: withTypes, returns: { pagesActionView: () => ({ actions: [], people: [], total: 0 }) } });
  try {
    const r1 = l.rows[1];
    const cols = () => box(l).querySelectorAll('.dbcolh').map((h) => h.dataset.col);
    await clickEl(l, cellOf(l, r1, l.c5), 60);
    await press(l, picker(l).querySelector('input'), { key: 'Tab' });
    assert.ok(picker(l) === null, 'Tab で窓が閉じない');
    const right = cols()[cols().indexOf(l.c5) + 1];
    assert.strictEqual(cellOf(l, r1, right).getAttribute('aria-selected'), 'true', 'Tab で右のセルへ動かない');
    await clickEl(l, cellOf(l, r1, l.c6), 60);
    await press(l, opts(l)[0], { key: 'Tab', shiftKey: true });
    assert.ok(picker(l) === null);
    assert.strictEqual(cellOf(l, r1, l.c5).getAttribute('aria-selected'), 'true', 'Shift+Tab で左のセルへ動かない');
    // ユーザー: 51 字の名前は書かずに一言・あとの選びは書ける
    await clickEl(l, cellOf(l, r1, l.c9), 60);
    const q = () => picker(l).querySelector('input');
    q().value = 'な'.repeat(51); q().dispatchEvent({ type: 'input' });
    const n = l.called('rowSetCell').length;
    await press(l, q(), { key: 'Enter' }); await l.drain(60);
    assert.strictEqual($(l, 'toast').textContent, 'この列の値として読めませんでした。');
    assert.strictEqual(l.called('rowSetCell').length, n);
    q().value = '総務係'; q().dispatchEvent({ type: 'input' });
    await press(l, q(), { key: 'Enter' }); await l.drain(60);
    assert.deepStrictEqual(cellsIn(l, r1).cells[l.c9], ['総務係']);
    // 書けなかった選び（DB が断った）は窓の印を戻す
    const was = l.returns.rowSetCell;
    l.returns.rowSetCell = () => Promise.reject(Object.assign(new Error('bad-args'), { code: 'bad-args' }));
    await clickEl(l, opts(l).find((b) => b.textContent === '経理係'), 80);
    assert.strictEqual(opts(l).find((b) => b.textContent === '経理係').getAttribute('aria-selected'), 'false', '書けなかった名前に印が付いた');
    l.returns.rowSetCell = was;
    await clickEl(l, opts(l).find((b) => b.textContent === '経理係'), 80);
    assert.deepStrictEqual(cellsIn(l, r1).cells[l.c9], ['総務係', '経理係'], '書けなかった名前が次の選びに混じった');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2 直し（rv46 M3・M4・M5）: ［列の値を変える ▸］のチェックは「チェック済み」「未チェック」・? や # のあるメールは開かない・ID の接頭辞は全角を半角に', T, async () => {
  const l = await openDb({ before: withTypes });
  try {
    for (const id of l.rows) { const ck = dataRows(l).find((r) => r.dataset.id === id).querySelector('.dbcheck'); ck.checked = true; ck.dispatchEvent({ type: 'change' }); }
    await l.drain(20);
    const bar = box(l).querySelector('.dbselbar');
    const setBtn = () => bar.querySelectorAll('button').find((b) => b.textContent === '列の値を変える ▸');
    await clickEl(l, setBtn());
    await clickEl(l, bar.querySelectorAll('.mitem').find((b) => b.textContent === '済み'));
    assert.deepStrictEqual(bar.querySelectorAll('.mitem').map((b) => b.textContent), ['チェック済み', '未チェック']);
    await clickEl(l, bar.querySelectorAll('.mitem').find((b) => b.textContent === '未チェック'), 120);
    assert.deepStrictEqual(l.called('rowsSetCell').map((c) => c.args.slice(2)), [[l.c3, null]]);
    assert.ok(l.rows.every((id) => cellsIn(l, id).cells[l.c3] === undefined), 'チェックを外せない');
    await clickEl(l, setBtn());
    await clickEl(l, bar.querySelectorAll('.mitem').find((b) => b.textContent === '済み'));
    await clickEl(l, bar.querySelectorAll('.mitem').find((b) => b.textContent === 'チェック済み'), 120);
    assert.ok(l.rows.every((id) => cellsIn(l, id).cells[l.c3] === true));
    // メールの値に ? # % & があれば開かない（mailto: の後ろに添付や本文を渡さない）
    l.call('row.setCell', { db: l.id, id: l.rows[1], col: l.c11, value: `${MAIL}?attach=/x` });
    l.fire('onPagesUpdated'); await l.drain(60);
    await clickEl(l, cellOf(l, l.rows[1], l.c11).querySelector('.dblink'));
    assert.deepStrictEqual(l.called('openLink'), [], '? のあるメールを開いた');
    await clickEl(l, cellOf(l, l.rows[0], l.c11).querySelector('.dblink'));
    assert.deepStrictEqual(l.called('openLink').map((c) => c.args), [[`mailto:${MAIL}`]]);
    // ID の接頭辞: 全角の英字は半角にして送る
    await clickEl(l, head(l, l.c13)); await clickEl(l, item(l, '接頭辞'));
    const inp = menu(l).querySelector('input');
    inp.value = 'ＴＡＳＫ';
    await press(l, inp, { key: 'Enter' }); await l.drain(60);
    assert.deepStrictEqual(l.called('colSetFmt').map((c) => c.args), [[l.id, l.c13, { prefix: 'TASK' }]]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2 直し（rv46 M6・M8）: 写した見せる文字（¥1,200・-$5.25・40%・日付の期間）を同じ列に貼り戻せる。引用符の "" と中の改行を読む', T, async () => {
  let clip = { text: '' };
  const l = await openDb({ before: withTypes, returns: { clipReadRows: () => clip } });
  try {
    const [r0, r1, r2] = l.rows;
    l.call('col.setFmt', { db: l.id, col: l.c2, fmt: 'yen' });
    l.call('row.setCell', { db: l.id, id: r0, col: l.c2, value: 1200 });
    l.call('row.setCell', { db: l.id, id: r0, col: l.c8, value: { start: '2026-11-04', time: '10:00', end: '2026-11-06', endTime: '09:30' } });
    l.fire('onPagesUpdated'); await l.drain(60);
    for (const [col, want] of [[l.c2, 1200], [l.c8, { start: '2026-11-04', time: '10:00', end: '2026-11-06', endTime: '09:30' }]]) {
      await selectOnly(l, r0, col);
      await press(l, active(l), { key: 'c', code: 'KeyC', ctrlKey: true });
      clip = { text: l.called('copy').slice(-1)[0].args[0] };
      await selectOnly(l, r1, col);
      await pasteKey(l); await l.drain(60);
      assert.deepStrictEqual(cellsIn(l, r1).cells[col], want, `${clip.text} を貼り戻せない`);
    }
    for (const [text, want] of [['-$5.25', -5.25], ['40%', 40], ['１，２３４', 1234]]) {
      clip = { text };
      await selectOnly(l, r2, l.c2);
      await pasteKey(l); await l.drain(60);
      assert.strictEqual(cellsIn(l, r2).cells[l.c2], want, text);
    }
    // 引用符の中の改行と "" は1つのセルの文字（改行は空白）
    await selectOnly(l, r0, l.c1);
    clip = { text: '"一行目\n二行目"\t"彼は""はい""と言った"\n' };
    await pasteKey(l); await l.drain(80);
    assert.deepStrictEqual(l.called('rowsPaste').map((c) => c.args[3]).slice(-1)[0], [['一行目 二行目', '彼は"はい"と言った']]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2 直し（rv46 M7・M8）: 種類の変更の確かめは読めなくなる値が 1 つでも出す（ゴミ箱の行は数えない）。［今日］はその PC の時刻の日。日付の列の下の集計は「期間」', T, async () => {
  const l = await openDb({ now: Date.parse('2026-11-08T20:30:00.000Z'), before: (call, d) => {
    call('row.setCell', { db: d.id, id: d.rows[0], col: d.c1, value: '12' });
    call('row.setCell', { db: d.id, id: d.rows[1], col: d.c1, value: '約 3' });
    call('row.setCell', { db: d.id, id: d.rows[2], col: d.c1, value: 'よみ' });
    call('rows.trash', { db: d.id, ids: [d.rows[2]] });
    const c8 = call('col.add', { db: d.id, type: 'date', name: '期日' }).col.id;
    call('row.setCell', { db: d.id, id: d.rows[0], col: c8, value: { start: '2026-11-01' } });
    call('row.setCell', { db: d.id, id: d.rows[1], col: c8, value: { start: '2026-11-05' } });
    call('view.update', { db: d.id, viewId: 'v1', patch: { agg: { [c8]: 'range' } } });
    return { c8 };
  } });
  try {
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); return false; };
    await clickEl(l, head(l, l.c1)); await clickEl(l, item(l, '種類 ▸')); await clickEl(l, item(l, '数値'), 80);
    assert.deepStrictEqual(asked, ['種類を変えると、1 個の値が読めずに空になります。よろしいですか？（Ctrl+Z で戻せます）']);
    assert.ok(box(l).querySelectorAll('.dbagg').some((a) => a.textContent === '期間 4 日'), '日付の列の範囲が「期間」でない');
    await clickEl(l, cellOf(l, l.rows[0], l.c8), 60);
    await clickEl(l, picker(l).querySelectorAll('button').find((b) => b.textContent === '今日'), 20);
    assert.strictEqual(picker(l).querySelectorAll('input')[0].value, '2026-11-09', '［今日］が UTC の日');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2 直し（rv46 M8）: 表の頭から遠い所でも、少し捲っただけでは描き直さず、窓が 10 行より多くずれたら描く', T, async () => {
  const l = await openDb({ many: 10000 });
  try {
    height(l, 640);
    await scrollTo(l, 32 * 5000);
    await l.drain(80);
    const first = () => dataRows(l)[0];
    const a = first();
    assert.ok(a && Number(a.dataset.i) > 4900, '前提: 遠くの窓を描いている');
    await scrollTo(l, 32 * 5005);
    assert.ok(first() === a, '5 行捲っただけで描き直した');
    await scrollTo(l, 32 * 5030);
    assert.ok(first() !== a, '30 行捲っても描き直さない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-2 直し（2026-11-08 の持ち主の答え）: ユーザーの候補は PC の中だけの会議の担当を出さない（pagesActionView の noPrivate）', T, async () => {
  const l = await openDb({ before: withTypes, returns: { pagesActionView: () => ({ actions: [], people: [], total: 0 }) } });
  try {
    await clickEl(l, cellOf(l, l.rows[1], l.c9), 80);
    assert.deepStrictEqual(l.called('pagesActionView').map((c) => c.args), [[{ q: '', assignee: '', noPrivate: true }]]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ================================================================ R87（2026-11-09 の持ち主の答え「議事録のときだけ「議事録」と書き、ほかは「NaTsu の「題名」」にする（おすすめ）」）
test('R87: 写すリンクの1行は、議事録だけ「NaTsu の議事録「題名」（日付）住所」、白紙のページ・データベース・行・ビューは「NaTsu の「題名」 住所」（無題はそれぞれの名前）', T, async () => {
  const at = HTML.indexOf('  const REF_UNTITLED = ');
  const end = HTML.indexOf('\n  }\n', HTML.indexOf('  function pageRefLine(', at)) + 4;
  const ref = new Function(`${HTML.slice(at, end)}\nreturn pageRefLine;`)();   // eslint-disable-line no-new-func
  const B = 'https://example.invalid/open#p=';
  // 利用者が付け直した題名（D77。1行に寄せるかだけを見る）
  assert.strictEqual(ref({ id: 'pm1', title: '週次\n定例', date: '2026-10-20' }, B), `NaTsu の議事録「週次 定例」（2026-10-20）${B}pm1`);
  assert.strictEqual(ref({ id: 'pm1', title: '', date: '2026-10-20' }, B), `NaTsu の議事録「無題」（2026-10-20）${B}pm1`);
  // 白紙のページの題名（D77 の会議の題名でない）
  assert.strictEqual(ref({ id: 'pb1', kind: 'blank', title: '資料', date: '2026-10-20' }, B), `NaTsu の「資料」 ${B}pb1`);
  // 白紙のページの題名（D77 の会議の題名でない）
  assert.strictEqual(ref({ id: 'pb1', kind: 'blank', title: ' ' }, B), `NaTsu の「無題のページ」 ${B}pb1`);
  assert.strictEqual(ref({ id: 'pd1', kind: 'database', title: '' }, B), `NaTsu の「無題のデータベース」 ${B}pd1`);
  assert.strictEqual(ref({ id: 'r1', kind: 'row', title: '' }, B), `NaTsu の「無題のページ」 ${B}r1`);
  // 画面: データベースのページの「···」の［リンクを写す］・選んだ行の［リンクを写す］
  const l = await openDb();
  try {
    // データベースの題名（D77 の会議の題名でない）
    l.call('page.setTitle', { id: l.id, title: '案件' });
    l.fire('onPageOpen', l.id); await l.drain(80);
    $(l, 'pMore').click(); await l.drain(20);
    await clickEl(l, $(l, 'pMenu').querySelectorAll('.mitem').find((b) => b.textContent === 'リンクを写す'));
    const ck = dataRows(l)[1].querySelector('.dbcheck'); ck.checked = true; ck.dispatchEvent({ type: 'change' }); await l.drain(20);
    await clickEl(l, box(l).querySelector('.dbselbar').querySelectorAll('button').find((b) => b.textContent === 'リンクを写す'));
    assert.deepStrictEqual(l.called('copy').map((c) => c.args[0]), [`NaTsu の「案件」 ${B}${l.id}`, `NaTsu の「発注」 ${B}${l.rows[1]}`]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ================================================================ DV-3 直し（2026-11-09 の 6a9f0c5..0b7cc16 の点検 rv48。R88〜）
test('DV-3 直し（rv48 F1）: 画面の部品は querySelectorAll の答え（NodeList）に配列の部品（find・map・filter など）を使わない（偽の DOM は配列を返すので字面で見る）', () => {
  const script = HTML.slice(HTML.indexOf('<script>'));
  // DV-3 直し2（rv49 M-d）で広げた: 選び方の中の括弧（:not(…)）・行をまたぐ鎖も見る（children は本文の行の木の配列と字で分けられないので見ない）
  const ARR = '(?:find|findIndex|map|filter|some|every|reduce|includes|indexOf|slice|flatMap|at)\\b';
  const RE = new RegExp(`querySelectorAll\\((?:[^()]|\\([^()]*\\))*\\)\\s*\\.${ARR}`, 'g');
  const bad = [...script.matchAll(RE)].map((m) => m[0].replace(/\s+/g, ' ').slice(0, 120));
  assert.deepStrictEqual(bad, []);
  const probe = 'x.querySelectorAll(\'.a:not(.b)\')\n    .find((y) => y); w.querySelectorAll(q).map(f);';
  assert.strictEqual([...probe.matchAll(RE)].length, 2, '照らしが括弧・行またぎを見ない');
});

test('DV-3 直し（rv48 F2・F10）: 複数選択とユーザーの窓は選んで描き直しても閉じず、続けて選べる。窓の押せない所を押してもフォーカスを動かさない（暦が閉じない）', T, async () => {
  const l = await openDb({ before: withTypes, returns: { pagesActionView: () => ({ actions: [], people: [], total: 0 }) } });
  try {
    const r1 = l.rows[1];
    await clickEl(l, cellOf(l, r1, l.c6), 60);
    const pop = picker(l);
    await clickEl(l, opts(l)[0], 80);
    pop.dispatchEvent({ type: 'focusout', relatedTarget: null }); await l.drain(60);   // 選び直しで押したボタンが消えた（本物では focusout が来る）
    assert.ok(picker(l) === pop, '複数選択の窓が1つ選んだだけで閉じた');
    await clickEl(l, opts(l)[1], 80);
    assert.deepStrictEqual(cellsIn(l, r1).cells[l.c6], [l.o6[0].id, l.o6[1].id]);
    await press(l, picker(l).querySelector('input'), { key: 'Escape' });
    // 暦: 欄の名前の文字を押しても mousedown を止める（フォーカスを外へ出さない）・欄は止めない
    await clickEl(l, cellOf(l, r1, l.c8), 60);
    const label = picker(l).querySelector('.dbdatecheck span');
    let stopped = false;
    picker(l).dispatchEvent({ type: 'mousedown', target: label, preventDefault() { stopped = true; } });
    assert.ok(stopped, '暦の文字を押すとフォーカスが外れる');
    stopped = false;
    picker(l).dispatchEvent({ type: 'mousedown', target: picker(l).querySelector('input'), preventDefault() { stopped = true; } });
    assert.ok(!stopped, '暦の欄を押せない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-3 直し（rv48 F3）: グループの［＋］で足した行へ捲って題名を書く（表の末へ飛ばない）・ステータスのまとまりとユーザーのグループの値', T, async () => {
  const l = await openDb({ many: 1200, manyCells: (i, d) => (i < 600 ? { [d.c3]: true } : {}), before: (call, d) => { call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: d.c3 } } }); } });
  try {
    height(l, 640);
    const head0 = box(l).querySelectorAll('.dbghead')[0];
    assert.strictEqual(head0.querySelector('.dbgname').textContent, '未チェック');
    await clickEl(l, head0.querySelector('.dbgadd'), 300);
    // 「未チェック」は 発注・検収・チェックの無い 600 行と足した行（その末: 番号 602）。後ろに「チェック済み」の 601 行
    const added = l.call('db.view', { id: l.id, viewId: 'v1', from: 602, count: 1 }).rows[0].id;
    assert.ok(!l.rows.includes(added) && !/^rz/.test(added), '前提: 602 番は足した行');
    assert.ok(editor(l) && active(l) === editor(l), '足した行の題名を書かない');
    const rowEl = editor(l).parentNode.parentNode;
    assert.deepStrictEqual([rowEl.dataset.id, rowEl.dataset.i], [added, '602'], '足した行を書いていない（表の末へ飛んだ）');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
  const s = await openDb({ before: (call, d) => {
    const w = withTypes(call, d);
    call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: w.c7 } } });
    return w;
  } });
  try {
    const heads = () => box(s).querySelectorAll('.dbghead');
    await clickEl(s, heads()[1].querySelector('.dbgadd'), 160);   // 進行中
    const status = s.call('db.get', { id: s.id }).cols.find((c) => c.id === s.c7);
    assert.deepStrictEqual(s.called('rowAdd').map((c) => c.args[1]), [{ cells: { [s.c7]: status.groups.doing[0] } }]);
    if (editor(s)) await press(s, editor(s), { key: 'Escape' });
    s.call('view.update', { db: s.id, viewId: 'v1', patch: { group: { col: s.c9 } } });
    s.fire('onPagesUpdated'); await s.drain(120);
    await clickEl(s, heads()[0].querySelector('.dbgadd'), 160);   // 経理係
    assert.deepStrictEqual(s.called('rowAdd').map((c) => c.args[1])[1], { cells: { [s.c9]: ['経理係'] } });
    assert.deepStrictEqual(s.errors.map(fmt), []);
  } finally { s.done(); }
});

test('DV-3 直し（rv48 F4・F6）: 設定の窓・タブ・グループの ▸／▾ は書いて描き直してもフォーカスを残す。タブは ←→・Home・End で替える', T, async () => {
  const l = await openDb({ before: (call, d) => { call('view.add', { db: d.id, name: '二' }); call('view.add', { db: d.id, name: '三' }); } });
  try {
    await openPanel(l, '並べ替え');
    const add = btnIn(panel(l), '並べ替えを足す');
    add.focus();
    await clickEl(l, add, 160);
    assert.strictEqual(l.called('viewUpdate').length, 1);
    assert.ok(active(l) && active(l).dataset.k === 'sadd', '並べ替えを足した後にフォーカスが窓に無い');
    await press(l, panel(l), { key: 'Escape' });
    // タブ: 押して選ぶ・←→・End・Home
    tabs(l)[1].focus();
    await clickEl(l, tabs(l)[1], 120);
    assert.ok(active(l) === tabOn(l) && tabOn(l).textContent === '二', 'タブを押すとフォーカスが外れる');
    await press(l, tabOn(l), { key: 'ArrowRight' }); await l.drain(80);
    assert.ok(active(l) === tabOn(l) && tabOn(l).textContent === '三', '→ で次のタブにならない');
    await press(l, tabOn(l), { key: 'Home' }); await l.drain(80);
    assert.strictEqual(tabOn(l).textContent, '表');
    await press(l, tabOn(l), { key: 'ArrowLeft' }); await l.drain(80);
    assert.ok(active(l) === tabOn(l) && tabOn(l).textContent === '三', '← で前（輪）のタブにならない');
    await press(l, tabOn(l), { key: 'End' }); await l.drain(80);
    assert.strictEqual(tabOn(l).textContent, '三');
    assert.ok(l.steps.every((s) => !/^view\./.test(s.cmd)));
    // グループの ▸／▾
    l.call('view.update', { db: l.id, viewId: 'v3', patch: { group: { col: l.c3 } } });
    l.fire('onPagesUpdated'); await l.drain(120);
    const tog = () => box(l).querySelectorAll('.dbgtoggle')[0];
    tog().focus();
    await clickEl(l, tog(), 160);
    assert.ok(active(l) === tog() && tog().getAttribute('aria-expanded') === 'false', '▸／▾ を押すとフォーカスが外れる');
    // ［グループ］の窓の出し入れ（dbPanelSave を通らない書き込み）でもフォーカスを窓に残す
    await openPanel(l, 'グループ');
    const eye = panel(l).querySelectorAll('.dbglist .dbgrow input')[1];
    eye.focus(); eye.checked = false; await change(l, eye, undefined, 200);
    assert.ok(active(l) && active(l).dataset.k === 'gh1', 'グループの出し入れでフォーカスが外れる');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-3 直し（rv48 F7・F8・F9）: タブは縮めず1行（CSS）・［グループ］の窓は 200 まで並べ、手の並びは並べていない鍵の前の並びを残す・複数選択でまとめても全部を選べば見出しのチェックが付く', T, async () => {
  assert.match(HTML, /\.dbtab \{ position: relative; flex: none; white-space: nowrap;/);
  const l = await openDb({ many: 300, before: (call, d) => { call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: d.c1, order: ['zz-見えない鍵'] } } }); } });
  try {
    const p = await openPanel(l, 'グループ');
    const list = () => panel(l).querySelectorAll('.dbglist .dbgrow');
    assert.strictEqual(list().length, 200, '窓のグループを全部描いた');
    for (const r of list()) r._rect = { top: 0, height: 30 };
    list()[1].querySelector('.dbgrip').dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData() {} } });
    list()[0].dispatchEvent({ type: 'drop', clientY: 2, dataTransfer: { types: ['application/x-natsu-group'] }, preventDefault() {} }); await l.drain(200);
    const order = viewNow(l).group.order;
    assert.ok(order.length <= 1000 && order.includes('zz-見えない鍵'), '並べていない鍵の手の並びを落とした');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
  const s = await openDb({ before: (call, d) => {
    const w = withTypes(call, d);
    call('row.setCell', { db: d.id, id: d.rows[0], col: w.c6, value: w.o6.map((o) => o.id) });
    call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: w.c6 } } });
    return w;
  } });
  try {
    const all = box(s).querySelector('.dbcheckall');
    all.checked = true; all.dispatchEvent({ type: 'change' }); await s.drain(120);
    s.call('row.setCell', { db: s.id, id: s.rows[1], col: s.c1, value: '描き直す' });   // 印を変えて描き直させる
    s.fire('onPagesUpdated'); await s.drain(80);
    assert.strictEqual(box(s).querySelector('.dbselbar .dbselcount').textContent, '3 行を選んでいます');
    assert.strictEqual(box(s).querySelector('.dbcheckall').checked, true, '全部を選んでも見出しのチェックが外れる');
    assert.deepStrictEqual(s.errors.map(fmt), []);
  } finally { s.done(); }
});

// ================================================================ DV-3 直し2（2026-11-09 の 0b7cc16..d2ead8d の点検 rv49。R95）
const gheadOf = (l, name) => box(l).querySelectorAll('.dbghead').find((h) => h.querySelector('.dbgname') && h.querySelector('.dbgname').textContent === name);
const selCells = (l) => box(l).querySelectorAll('.dbcell').filter((c) => c.getAttribute('aria-selected') === 'true');
const editRow = (l) => (editor(l) ? editor(l).parentNode.parentNode.dataset.id : '');

test('DV-3 直し2（rv49 I1・M-a）: タブの並びの「他 n 件」・［＋］・中の検索・⚙ は縮めず1行（CSS）。入り切るかはタブの間も数え、「他 n 件」の本当の幅で入り切るまで隠す。「他 n 件」から選ぶと選んだタブにフォーカス', T, async () => {
  const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
  for (const sel of ['.dbtabmore', '.dbviewadd', '.dbsearch', '.dbsetbtn']) {
    const d = S.declsFor(rules, sel, { at: '' });
    assert.deepStrictEqual([d.flex, d['white-space']], ['none', 'nowrap'], `${sel} が縮む・折り返す`);
  }
  const l = await openDb({ before: (call, d) => { for (const n of ['二', '三', '四', '五', '六']) call('view.add', { db: d.id, name: n }); } });
  const was = Element.prototype.getBoundingClientRect;
  try {
    // 幅 450 の並び・幅 100 のタブ・間 2px・「他 n 件」は本当の幅 150（［＋］・検索・⚙ は 0）→ 今のタブと 1 つだけ・「他 4 件」
    Element.prototype.getBoundingClientRect = function rect() {
      const w = this.classList.contains('dbtabs') ? 450 : this.classList.contains('dbtab') ? 100 : this.classList.contains('dbtabmore') && !this.hidden ? 150 : -1;
      return w < 0 ? was.call(this) : { top: 0, left: 0, right: w, bottom: 30, width: w, height: 30 };
    };
    await clickEl(l, tabs(l).find((b) => b.textContent === '二'), 160);
    assert.deepStrictEqual(tabNames(l), ['表', '二'], '「他 n 件」の幅とタブの間を数えずに並べた');
    const more = box(l).querySelector('.dbtabmore');
    assert.deepStrictEqual([more.hidden, more.textContent], [false, '他 4 件']);
    await clickEl(l, more);
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['三', '四', '五', '六'], '隠したタブがビューの順でない');
    await clickEl(l, item(l, '五'), 160);
    assert.strictEqual(tabOn(l).textContent, '五');
    assert.ok(active(l) === tabOn(l), '「他 n 件」から選んだタブにフォーカスが無い');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { Element.prototype.getBoundingClientRect = was; l.done(); }
});

test('DV-3 直し2（rv49 I2）: 閉じたグループがあっても、全部を選んだ見出しのチェックは描き直しても付いたまま・もう一度押すと外れる。行のチェックを外すと外れ、付け直すと付く', T, async () => {
  const l = await openDb({ before: (call, d) => { call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: d.c3 } } }); } });
  try {
    await clickEl(l, gheadOf(l, 'チェック済み').querySelector('.dbgtoggle'), 200);
    assert.ok(!dataRows(l).some((r) => r.dataset.id === l.rows[0]), 'グループが閉じない');
    const all = () => box(l).querySelector('.dbcheckall');
    all().checked = true; all().dispatchEvent({ type: 'change' }); await l.drain(120);
    assert.strictEqual(box(l).querySelector('.dbselbar .dbselcount').textContent, '2 行を選んでいます');
    l.call('row.setCell', { db: l.id, id: l.rows[1], col: l.c1, value: '描き直す' });   // 印を変えて描き直させる
    l.fire('onPagesUpdated'); await l.drain(120);
    assert.strictEqual(all().checked, true, '閉じたグループがあると、描き直したときに見出しのチェックが外れる');
    const ck = () => dataRows(l).find((r) => r.dataset.id === l.rows[1]).querySelector('.dbcheck');
    ck().checked = false; ck().dispatchEvent({ type: 'change' }); await l.drain(20);
    assert.strictEqual(all().checked, false, '行のチェックを外しても見出しのチェックが残る');
    ck().checked = true; ck().dispatchEvent({ type: 'change' }); await l.drain(20);
    assert.strictEqual(all().checked, true, '選び直しても見出しのチェックが付かない');
    all().checked = false; all().dispatchEvent({ type: 'change' }); await l.drain(120);
    assert.ok(box(l).querySelector('.dbselbar').hidden, '見出しをもう一度押しても選びが外れない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
  // 複数選択でまとめて同じ行が2度出ても、行のチェックを外して付け直すと見出しのチェックが付く（並ぶ行の数 shown でなく、行の数で見る: rv48 F9）
  const s = await openDb({ before: (call, d) => {
    const w = withTypes(call, d);
    call('row.setCell', { db: d.id, id: d.rows[0], col: w.c6, value: w.o6.map((o) => o.id) });
    call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: w.c6 } } });
    return w;
  } });
  try {
    const all = () => box(s).querySelector('.dbcheckall');
    all().checked = true; all().dispatchEvent({ type: 'change' }); await s.drain(120);
    const ck = () => dataRows(s).find((r) => r.dataset.id === s.rows[1]).querySelector('.dbcheck');
    ck().checked = false; ck().dispatchEvent({ type: 'change' }); await s.drain(20);
    assert.strictEqual(all().checked, false);
    ck().checked = true; ck().dispatchEvent({ type: 'change' }); await s.drain(20);
    assert.strictEqual(all().checked, true, '2度出る行があると、選び直しても見出しのチェックが付かない');
    assert.deepStrictEqual(s.errors.map(fmt), []);
  } finally { s.done(); }
});

test('DV-3 直し2（rv49 I3）: 値を書かないグループ（日付の月）の［＋］は、足した行（（空）のグループ）を書く（押したグループの行を選ばない）。探している間のグループの［＋］はほかの行を選ばない', T, async () => {
  // 日付の列は 5 番目に足す列（c5）。1万行の種と同じに、行の操作で月の値を入れる
  const l = await openDb({ many: 600, manyCells: (i) => ({ c5: { start: i < 300 ? '2026-10-05' : '2026-11-05' } }),
    before: (call, d) => { const c = call('col.add', { db: d.id, type: 'date', name: '期日' }).col.id; assert.strictEqual(c, 'c5'); call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: c } } }); } });
  try {
    height(l, 640); await scrollTo(l, 0);
    await clickEl(l, gheadOf(l, '2026/10').querySelector('.dbgadd'), 400);
    assert.deepStrictEqual(l.called('rowAdd').map((c) => c.args), [[l.id, {}]], '値を書かないグループに値を書いた');
    const added = editRow(l);
    assert.ok(added && !l.rows.includes(added) && !/^rz/.test(added), `足した行を書かない（${added || '書き手なし'}）`);
    assert.deepStrictEqual(selCells(l).map((c) => c.parentNode.dataset.id), [added], '押したグループの行を選んだ');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
  const s = await openDb({ before: (call, d) => { call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: d.c1 } } }); } });
  try {
    const q = box(s).querySelector('.dbsearchq');
    q.value = '見積'; q.dispatchEvent({ type: 'input' }); await s.drain(160);
    assert.deepStrictEqual(dataRows(s).map((r) => r.dataset.id), [s.rows[0]]);
    await clickEl(s, gheadOf(s, 'メモ 0').querySelector('.dbgadd'), 300);
    assert.strictEqual(s.called('rowAdd').length, 1);
    assert.deepStrictEqual(selCells(s).map((c) => c.parentNode.dataset.id), [], '探している語に当たらない行を足して、ほかの行を選んだ');
    assert.deepStrictEqual(s.errors.map(fmt), []);
  } finally { s.done(); }
});

test('DV-3 直し2（rv49 M-c f3）: 閉じたグループの［＋］は捲らずほかの行を選ばない・閉じたグループの後ろのグループの［＋］はそのグループの末（足した行）を書く', T, async () => {
  const l = await openDb({ many: 900, manyCells: (i) => ({ c1: i < 300 ? 'A' : i < 600 ? 'B' : 'C' }), before: (call, d) => { call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: d.c1 } } }); } });
  try {
    height(l, 640); await scrollTo(l, 0);
    await clickEl(l, gheadOf(l, 'A').querySelector('.dbgtoggle'), 300);
    await clickEl(l, gheadOf(l, 'B').querySelector('.dbgadd'), 400);
    assert.deepStrictEqual(l.called('rowAdd').map((c) => c.args), [[l.id, { cells: { c1: 'B' } }]]);
    const added = editRow(l);
    assert.ok(added && !/^rz/.test(added) && !l.rows.includes(added), `グループ B の末の足した行を書かない（${added || '書き手なし'}）`);
    await press(l, editor(l), { key: 'Escape' });
    await scrollTo(l, 0);
    await clickEl(l, gheadOf(l, 'A').querySelector('.dbgadd'), 400);
    assert.strictEqual(l.called('rowAdd').length, 2);
    assert.deepStrictEqual([selCells(l).length, editRow(l)], [0, ''], '閉じたグループの［＋］でほかの行を選んだ');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-3 直し2（rv49 M-b）: 選択の選びの窓は、窓の外の部品へフォーカスが動くと閉じる（描き直しで行き先の無い focusout では閉じない）', T, async () => {
  const l = await openDb({ before: withTypes });
  try {
    await clickEl(l, cellOf(l, l.rows[0], l.c5), 60);
    assert.ok(picker(l));
    picker(l).dispatchEvent({ type: 'focusout', relatedTarget: null }); await l.drain(40);
    assert.ok(picker(l), '行き先の無い focusout で閉じた（選ぶたびに描き直すので閉じてはいけない）');
    picker(l).dispatchEvent({ type: 'focusout', relatedTarget: picker(l).querySelector('input') }); await l.drain(40);
    assert.ok(picker(l), '窓の中へ動いて閉じた');
    picker(l).dispatchEvent({ type: 'focusout', relatedTarget: $(l, 'pTitle') }); await l.drain(80);
    assert.ok(picker(l) === null, '窓の外へフォーカスが動いても閉じない');
    assert.deepStrictEqual(l.called('rowSetCell'), [], '閉じるだけで書いた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-3 直し2（rv49 M-c f8）: ［グループ］の窓で並べると、前の手の並びが 1,000 あっても 1,000 までで書く（DB に断られない）', T, async () => {
  const old = Array.from({ length: 1000 }, (_, i) => `前の鍵 ${i}`);
  const l = await openDb({ many: 300, before: (call, d) => { call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: d.c1, order: old } } }); } });
  try {
    const p = await openPanel(l, 'グループ');
    assert.ok(p);
    const list = () => panel(l).querySelectorAll('.dbglist .dbgrow');
    for (const r of list()) r._rect = { top: 0, height: 30 };
    const second = list()[1].querySelector('.dbgname').textContent;
    list()[1].querySelector('.dbgrip').dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData() {} } });
    list()[0].dispatchEvent({ type: 'drop', clientY: 2, dataTransfer: { types: ['application/x-natsu-group'] }, preventDefault() {} }); await l.drain(200);
    const order = viewNow(l).group.order;
    assert.strictEqual(order.length, 1000, '手の並びを 1,000 までに切らない（DB が断る）');
    assert.strictEqual(order[0], second, '並べた鍵が先頭に無い');
    assert.ok(!/変更を保存できませんでした/.test($(l, 'toast').textContent), $(l, 'toast').textContent);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ================================================================ DV-4（決めたこと 26・51・R49・2026-11-09 の持ち主の承認 R90〜）
const openBtn = (l, rowId) => cellOf(l, rowId, 'title').querySelector('.dbopen');
const props = (l) => $(l, 'pProps').querySelectorAll('.dbprop');
const propOf = (l, name) => props(l).find((p) => p.querySelector('.k').textContent === name);
const propV = (l, name) => propOf(l, name).querySelector('.dbpropv');
const crumbUps = (l) => $(l, 'crumb').querySelectorAll('.cseg').map((b) => b.querySelector('.cst').textContent);
const crumbNow = (l) => [$(l, 'crumb').querySelector('.ci').textContent, $(l, 'crumb').querySelector('.ct').textContent];
const tabKeys = (l) => $(l, 'tabbar').querySelectorAll('.tabitem').map((t) => t.getAttribute('data-key'));
const tabOnKey = (l) => ($(l, 'tabbar').querySelector('.tabitem.active') || { getAttribute: () => '' }).getAttribute('data-key');
const backToDb = async (l) => { await clickEl(l, $(l, 'crumb').querySelector('.cseg'), 200); };

test('DV-4: 題名の［開く］で今のタブに行のページ（Ctrl+クリックで新しいタブ）。頭は 📄 と題名（無題は「無題のページ」）・パンくず「… / データベース / 📄 行」・会議の種類と3つのタブと表が無い', T, async () => {
  // データベースの題名（D77 の会議の題名でない）
  const l = await openDb({ before: (call, d) => { call('page.setTitle', { id: d.id, title: '案件' }); return { r3: call('row.add', { db: d.id }).id }; } });
  try {
    const [r0, r1] = l.rows;
    const b = openBtn(l, r0);
    assert.ok(b, '題名のセルに［開く］が無い');
    assert.deepStrictEqual([b.tagName.toLowerCase(), b.getAttribute('aria-label'), b.title], ['button', '開く', '開く']);
    assert.strictEqual(cellOf(l, r0, 'title').textContent, '見積もり', '［開く］の文字がセルの文字に混ざる（見せる文字は CSS の content）');
    const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
    assert.strictEqual(S.declsFor(rules, '.dbopen::before', { at: '' }).content, 'attr(aria-label)', '［開く］の見せる文字が「開く」でない');
    const n = tabKeys(l).length;
    await clickEl(l, b, 200);
    assert.deepStrictEqual([tabKeys(l).length, tabOnKey(l)], [n, `page:${r0}`], '今のタブで開かない');
    assert.ok(!tabKeys(l).includes(`page:${l.id}`), 'データベースのタブが残った（今のタブで開かない）');
    assert.deepStrictEqual(l.called('rowSetCell'), [], '［開く］で題名を書いた');
    assert.strictEqual(box(l).hidden, true, '行のページに表が出る');
    assert.ok($(l, 'pageWrap').classList.contains('blank') && !$(l, 'pageWrap').classList.contains('db'), '3つのタブを隠す印が無い');
    assert.strictEqual($(l, 'pTypeRow').style.display, 'none', '会議の種類の行が出る');
    assert.deepStrictEqual([$(l, 'pIcon').textContent, $(l, 'pTitle').textContent, $(l, 'pTitle').getAttribute('data-ph')], ['📄', '見積もり', '無題のページ']);
    assert.deepStrictEqual([...$(l, 'pActs').children].map((x) => x.id), ['pMore', 'pMenu'], '［要約を生成］が出る');
    assert.deepStrictEqual(crumbUps(l), ['案件']);
    assert.deepStrictEqual(crumbNow(l), ['📄', '見積もり']);
    // パンくずのデータベースの段で戻る
    await backToDb(l);
    assert.deepStrictEqual([box(l).hidden, tabOnKey(l), tabKeys(l).length], [false, `page:${l.id}`, n]);
    // Ctrl+クリックで新しいタブ
    openBtn(l, r1).dispatchEvent({ type: 'click', ctrlKey: true }); await l.drain(200);
    assert.deepStrictEqual([tabKeys(l).length, tabOnKey(l)], [n + 1, `page:${r1}`], 'Ctrl+クリックで新しいタブに開かない');
    assert.ok(tabKeys(l).includes(`page:${l.id}`));
    assert.strictEqual($(l, 'pTitle').textContent, '発注');
    // 無題の行はリンクから開いても「無題のページ」（タブも）
    l.fire('onOpenLink', { id: l.r3, anchor: '' }); await l.drain(200);
    assert.deepStrictEqual(crumbNow(l), ['📄', '無題のページ']);
    assert.strictEqual($(l, 'tabbar').querySelector('.tabitem.active .tt').textContent, '無題のページ');
    assert.strictEqual($(l, 'tabbar').querySelector('.tabitem.active .tt').getAttribute('data-icon'), '📄');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-4・vw-row-props: 行のページの列の値の並び（データベースの列の順に名前と値）。押すと表と同じ書き手（文字・数値・チェック・選択・選択肢を足す・暦）・書けない列は灰色で書き手が無い。題名を変えると表の題名も変わる', T, async () => {
  const l = await openDb({ before: withTypes });
  try {
    const r0 = l.rows[0];
    l.fire('onOpenLink', { id: r0, anchor: '' }); await l.drain(200);
    assert.deepStrictEqual(crumbUps(l), ['無題のデータベース'], '無題のデータベースの段の名前');
    assert.deepStrictEqual(props(l).map((p) => p.querySelector('.k').textContent),
      ['メモ', '金額', '済み', '作った日', '優先度', 'タグ', '状態', '期日', '担当', '資料', 'メール', '電話', '番号', '作った人'], '列の値の並びが無い・列の順でない');
    assert.deepStrictEqual(['メモ', '金額', '済み', '優先度', '期日', '担当', '資料', '電話', '作った人'].map((k) => propV(l, k).textContent),
      ['メモ 0', '100', '✓', '高', '2026/11/04', '経理係', 'https://example.com/a', '03-0000-0000', '自分']);
    assert.deepStrictEqual(props(l).filter((p) => p.querySelector('.dbpropv').classList.contains('ro')).map((p) => p.querySelector('.k').textContent), ['作った日', '番号', '作った人'], '書けない列の灰色の印');
    for (const p of props(l)) {
      const v = p.querySelector('.dbpropv');
      assert.strictEqual(v.tagName.toLowerCase() === 'button', !v.classList.contains('ro'), `${p.querySelector('.k').textContent} の値の部品`);
      if (v.tagName.toLowerCase() === 'button') assert.strictEqual(v.getAttribute('aria-labelledby'), `${p.querySelector('.k').id} ${v.id}`, '値のボタンの名前が列の名前と値でない');
    }
    const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
    assert.strictEqual(S.declsFor(rules, '.dbpropv.ro', { at: '' }).color, 'var(--muted)', '書けない列が灰色でない');
    // 書けない列は押しても書き手が無い
    await clickEl(l, propV(l, '作った日'), 60);
    assert.ok($(l, 'pProps').querySelector('.dbedit, .dbpick') === null, '書けない列に書き手が出た');
    // 文字（Esc でやめる・Enter で書く・フォーカスは値へ戻る）
    await clickEl(l, propV(l, 'メモ'), 60);
    let inp = $(l, 'pProps').querySelector('.dbedit');
    assert.ok(inp && active(l) === inp, '文字の書き手が出ない');
    assert.deepStrictEqual([inp.value, inp.getAttribute('aria-label')], ['メモ 0', 'メモ']);
    inp.value = 'やめた'; await press(l, inp, { key: 'Escape' });
    assert.deepStrictEqual([l.called('rowSetCell').length, propV(l, 'メモ').textContent], [0, 'メモ 0']);
    await clickEl(l, propV(l, 'メモ'), 60);
    inp = $(l, 'pProps').querySelector('.dbedit');
    inp.value = '書き直した';
    await press(l, inp, { key: 'Enter', isComposing: true });
    assert.strictEqual(l.called('rowSetCell').length, 0, '変換確定の Enter で書いた');
    await press(l, inp, { key: 'Enter' });
    assert.deepStrictEqual(l.called('rowSetCell').map((c) => c.args), [[l.id, r0, l.c1, '書き直した']]);
    assert.strictEqual(propV(l, 'メモ').textContent, '書き直した');
    assert.ok(active(l) === propV(l, 'メモ'), '書いた後のフォーカスが値に無い');
    // 数値: 読めない文字は断って一言
    await clickEl(l, propV(l, '金額'), 60);
    inp = $(l, 'pProps').querySelector('.dbedit'); inp.value = '約 3';
    await press(l, inp, { key: 'Enter' });
    assert.deepStrictEqual([$(l, 'toast').textContent, l.called('rowSetCell').length, propV(l, '金額').textContent], ['この列の値として読めませんでした。', 1, '100']);
    // チェックは押すと切り替え
    await clickEl(l, propV(l, '済み'), 100);
    assert.deepStrictEqual([cellsIn(l, r0).cells[l.c3], propV(l, '済み').textContent], [undefined, '']);
    // 選択（表と同じ選びの窓）
    await clickEl(l, propV(l, '優先度'), 60);
    assert.ok($(l, 'pProps').querySelector('.dbpick'), '選択の書き手が出ない');
    await clickEl(l, $(l, 'pProps').querySelectorAll('.dbpick .dbopt').find((x) => x.textContent === '低'), 120);
    assert.strictEqual(cellsIn(l, r0).cells[l.c5], l.o5[1].id);
    assert.ok($(l, 'pProps').querySelector('.dbpick') === null, '選んでも窓が閉じない');
    assert.strictEqual(propV(l, '優先度').textContent, '低');
    // 複数選択に新しい選択肢を足す（col.setOpts の答えの ID で書く）
    await clickEl(l, propV(l, 'タグ'), 60);
    const q = $(l, 'pProps').querySelector('.dbpick input');
    q.value = '急ぎ'; q.dispatchEvent({ type: 'input' });
    await clickEl(l, $(l, 'pProps').querySelector('.dbpick .dbnew'), 200);
    const made = colIn(l, l.c6).opts.find((o) => o.name === '急ぎ');
    assert.ok(made, '選択肢を足さない');
    assert.deepStrictEqual(cellsIn(l, r0).cells[l.c6], [made.id]);
    await press(l, $(l, 'pProps').querySelector('.dbpick input'), { key: 'Escape' });
    assert.ok($(l, 'pProps').querySelector('.dbpick') === null);
    assert.strictEqual(propV(l, 'タグ').textContent, '急ぎ');
    // 暦
    await clickEl(l, propV(l, '期日'), 60);
    const dt = $(l, 'pProps').querySelector('.dbdatein');
    assert.ok(dt, '暦が出ない');
    dt.value = '2026-11-20';
    await press(l, dt, { key: 'Enter' });
    assert.deepStrictEqual(cellsIn(l, r0).cells[l.c8], { start: '2026-11-20' });
    assert.strictEqual(propV(l, '期日').textContent, '2026/11/20');
    // セルの歩みはデータベースの歩み（表で書いたのと同じ）
    assert.ok(l.steps.length > 0 && l.steps.filter((s) => /^(row|col)\./.test(s.cmd)).every((s) => s.pageId === l.id), '列の値の歩みがデータベースの歩みでない');
    // 題名を変えると、パンくずと表の題名も変わる
    $(l, 'pTitle').textContent = '見積もりの改訂';
    $(l, 'pTitle').dispatchEvent({ type: 'blur' }); await l.drain(100);
    assert.deepStrictEqual(l.called('pageSetTitle').map((c) => c.args), [[r0, '見積もりの改訂']]);
    assert.strictEqual(cellsIn(l, r0).title, '見積もりの改訂');
    assert.deepStrictEqual(crumbNow(l), ['📄', '見積もりの改訂']);
    await backToDb(l);
    assert.strictEqual(cellOf(l, r0, 'title').textContent, '見積もりの改訂', '表の題名が変わらない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-4: 行のページの本文は白紙のページの部品（手引き・Enter で分ける）。本文の Ctrl+Z は行の要約の欄の歩み（edit.revert の pageId は行）。/ の選びに［ページ］を出す（R97 で意図して直した: 前は R92 で出さなかった）', T, async () => {
  const l = await openDb({ before: (call, d) => {
    const b = call('block.insert', { pageId: d.rows[1], afterBlockId: '', type: 'paragraph' }).blockId;
    call('block.update', { pageId: d.rows[1], blockId: b, patch: { text: '本文の一行' } });
    return { b };
  } });
  try {
    const [r0, r1] = l.rows;
    l.fire('onOpenLink', { id: r0, anchor: '' }); await l.drain(200);
    assert.strictEqual($(l, 'pNote').querySelector('.bodyph').textContent, 'ここに書く（/ で行の型を選べます）', '空の本文の手引きが無い');
    assert.strictEqual($(l, 'pNote').querySelectorAll('.cites, .cbadge').length, 0);
    l.fire('onOpenLink', { id: r1, anchor: '' }); await l.drain(200);
    const t = $(l, 'pNote').querySelectorAll('.blk').find((e) => e.dataset.id === l.b).querySelector('.txt');
    assert.strictEqual(t.textContent, '本文の一行');
    t.focus(); l.caret.set(t, 2);
    l.key({ key: 'Enter', code: 'Enter' }, t);
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('blockSplit').map((c) => c.args.slice(0, 2)), [[r1, l.b]]);
    assert.strictEqual(l.call('page.get', { id: r1 }).page.blocks.length, 2, 'DB が行の本文の分割を受けない');
    assert.deepStrictEqual(l.steps.map((s) => [s.cmd, s.pageId]), [['block.split', r1]], '本文の歩みが行の ID でない');
    l.key({ key: 'z', code: 'KeyZ', ctrlKey: true }, l.document.activeElement);
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('editRevert').map((c) => c.args), [[r1, [l.steps[0].step]]], '本文の Ctrl+Z が行の要約の欄の歩みでない');
    assert.strictEqual(l.call('page.get', { id: r1 }).page.blocks.length, 1, 'Ctrl+Z で戻らない');
    // R97 で意図して直した（2026-11-09 の持ち主の答え「使えるようにする…（おすすめ）」）: / の選びに［ページ］がある（前は R92 で出さなかった。作るのは R97 のテスト）
    const t2 = $(l, 'pNote').querySelector('.blk .txt');
    t2.focus(); t2.textContent = '/'; l.caret.set(t2, 1); t2.dispatchEvent({ type: 'input' }); await l.drain();
    const sm = $(l, 'pNote').querySelector('.slashmenu');
    assert.ok(sm, '/ の選びが開かない');
    assert.ok(sm.querySelectorAll('.sopt').some((o) => o.textContent === 'ページ'), '行の本文の / に［ページ］が無い');
    assert.deepStrictEqual(l.called('pageCreate'), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-4: 選んだセルの Space で行のページ（今のタブ）。Shift+F10・ContextMenu・行の右クリック・⋮⋮ で行のメニュー［開く］［新しいタブで開く］［リンクを写す］［削除］。近道の表に Space・Ctrl+C・Ctrl+V の行', T, async () => {
  const l = await openDb();
  try {
    const [r0, r1, r2] = l.rows;
    const n = tabKeys(l).length;
    await selectOnly(l, r1, l.c1);
    const sp = await press(l, active(l), { key: ' ', code: 'Space' });
    assert.ok(sp.defaultPrevented, 'Space を止めない');
    assert.deepStrictEqual([tabKeys(l).length, tabOnKey(l), $(l, 'pTitle').textContent], [n, `page:${r1}`, '発注'], 'Space で今のタブに行のページを開かない');
    await backToDb(l);
    // Shift+F10
    await selectOnly(l, r1, l.c1);
    const f10 = await press(l, active(l), { key: 'F10', code: 'F10', shiftKey: true });
    assert.ok(f10.defaultPrevented);
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['開く', '新しいタブで開く', 'リンクを写す', '削除']);
    assert.ok(active(l) === items(l)[0], 'メニューの最初の項目にフォーカスが無い');
    await press(l, menu(l), { key: 'Escape' });
    assert.ok(menu(l) === null && active(l) === cellOf(l, r1, l.c1), 'Esc で閉じてセルへ戻らない');
    // ContextMenu キー →［リンクを写す］
    await press(l, active(l), { key: 'ContextMenu', code: 'ContextMenu' });
    assert.ok(menu(l), 'ContextMenu キーで行のメニューが出ない');
    await clickEl(l, item(l, 'リンクを写す'), 100);
    assert.deepStrictEqual(l.called('copy').map((c) => c.args[0]).slice(-1), [`NaTsu の「発注」 https://example.invalid/open#p=${r1}`]);
    assert.ok(menu(l) === null);
    // 行の右クリック →［新しいタブで開く］
    let stopped = false;
    dataRows(l).find((r) => r.dataset.id === r2).dispatchEvent({ type: 'contextmenu', clientX: 4, clientY: 4, preventDefault: () => { stopped = true; } }); await l.drain(40);
    assert.ok(stopped && menu(l), '右クリックで行のメニューが出ない（本物のメニューを止めない）');
    await clickEl(l, item(l, '新しいタブで開く'), 200);
    assert.deepStrictEqual([tabKeys(l).length, tabOnKey(l), $(l, 'pTitle').textContent], [n + 1, `page:${r2}`, '検収']);
    await clickEl(l, $(l, 'tabbar').querySelectorAll('.tabitem').find((x) => x.getAttribute('data-key') === `page:${l.id}`), 200);
    // ⋮⋮ →［開く］（今のタブ）
    await clickEl(l, dataRows(l).find((r) => r.dataset.id === r0).querySelector('.dbgrip'), 40);
    assert.ok(menu(l), '⋮⋮ を押して行のメニューが出ない');
    await clickEl(l, item(l, '開く'), 200);
    assert.deepStrictEqual([tabKeys(l).length, tabOnKey(l)], [n + 1, `page:${r0}`]);
    await backToDb(l);
    // ⋮⋮ →［削除］: 確かめずに rowsTrash の1回と知らせ
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); return true; };
    await clickEl(l, dataRows(l).find((r) => r.dataset.id === r0).querySelector('.dbgrip'), 40);
    await clickEl(l, item(l, '削除'), 200);
    assert.deepStrictEqual([asked, l.called('rowsTrash').map((c) => c.args)], [[], [[l.id, [r0]]]]);
    assert.strictEqual($(l, 'toast').textContent, '行 1 件をゴミ箱に入れました（Ctrl+Z で戻せます）');
    assert.ok(!dataRows(l).some((r) => r.dataset.id === r0), '消した行が残る');
    // 近道の表（src/shortcuts.js と画面の写し）
    const SC = require('../src/shortcuts.js').SHORTCUTS;
    const where = 'データベースの表のセルを選んでいるとき';
    for (const [keys, what] of [['Space', '行のページを開く'], ['Ctrl+C', '選んだセルの値を写す'], ['Ctrl+V・Ctrl+Shift+V', '選んだセルに貼る（何行何列かは右下へ埋める）']]) {
      assert.ok(SC.some((r) => r.keys === keys && r.what === what && r.where === where), `近道の表に ${keys} の行が無い`);
    }
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DV-4: 行のページの「···」は［リンクを写す］・見た目・［削除］（［コピー］［移動先…］は無い）。［削除］は確かめずに rowsTrash の1回 → データベースのページへ戻って知らせ・Ctrl+Z で戻る', T, async () => {
  const l = await openDb();
  try {
    const r0 = l.rows[0];
    await clickEl(l, openBtn(l, r0), 200);
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    const labels = $(l, 'pMenu').querySelectorAll('.mitem').map((b) => b.textContent);
    assert.ok(labels[0] === 'リンクを写す' && labels[labels.length - 1] === '削除', JSON.stringify(labels));
    assert.ok(labels.includes('全幅') && !labels.includes('コピー') && !labels.includes('移動先…'), JSON.stringify(labels));
    await clickEl(l, $(l, 'pMenu').querySelectorAll('.mitem').find((b) => b.textContent === 'リンクを写す'), 100);
    assert.deepStrictEqual(l.called('copy').map((c) => c.args[0]).slice(-1), [`NaTsu の「見積もり」 https://example.invalid/open#p=${r0}`]);
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); return true; };
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    await clickEl(l, $(l, 'pMenu').querySelectorAll('.mitem').find((b) => b.textContent === '削除'), 300);
    assert.deepStrictEqual([asked, l.called('rowsTrash').map((c) => c.args), l.called('pageDelete')], [[], [[l.id, [r0]]], []]);
    assert.deepStrictEqual([tabOnKey(l), box(l).hidden], [`page:${l.id}`, false], 'データベースのページへ戻らない');
    assert.ok(!tabKeys(l).includes(`page:${r0}`), '消した行のタブが残る');
    assert.strictEqual($(l, 'toast').textContent, '行 1 件をゴミ箱に入れました（Ctrl+Z で戻せます）');
    assert.ok(!dataRows(l).some((r) => r.dataset.id === r0));
    await press(l, grid(l), { key: 'z', code: 'KeyZ', ctrlKey: true });
    assert.strictEqual(l.called('editRevert').length, 1, 'Ctrl+Z で戻さない');
    assert.ok(dataRows(l).some((r) => r.dataset.id === r0), 'Ctrl+Z で行が戻らない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ================================================================ R96（2026-11-09 の持ち主の答え: 近道の表のタブのキー・写す1行の無題の名前・［グループ］の窓の 200 の一言・切れたタブの名前）
test('R96 (1): 近道の表に「ビューのタブを選んでいるとき」の ←・→「となりのビューへ（端では反対の端へ）」と Home・End「最初・最後のビューへ」（src/shortcuts.js と画面の写し）', () => {
  const SC = require('../src/shortcuts.js').SHORTCUTS;
  const where = 'ビューのタブを選んでいるとき';
  assert.deepStrictEqual(SC.filter((r) => r.where === where).map((r) => [r.keys, r.what, r.codes.length]),
    [['←・→', 'となりのビューへ（端では反対の端へ）', 0], ['Home・End', '最初・最後のビューへ', 0]], '近道の表にビューのタブの行が無い');
  assert.ok(HTML.includes(`{ keys: '←・→', what: 'となりのビューへ（端では反対の端へ）', where: '${where}', codes: [] },`), '画面の写しに行が無い');
});

test('R96 (2): 写す1行の無題の名前は画面と同じ（データベースは「無題のデータベース」・行は「無題のページ」）。データベースの「···」・選んだ行の帯・行のメニュー', T, async () => {
  const B = 'https://example.invalid/open#p=';
  const l = await openDb({ titles: ['', '発注'] });
  try {
    const r0 = l.rows[0];
    $(l, 'pMore').click(); await l.drain(20);
    await clickEl(l, $(l, 'pMenu').querySelectorAll('.mitem').find((b) => b.textContent === 'リンクを写す'));
    const ck = dataRows(l).find((r) => r.dataset.id === r0).querySelector('.dbcheck'); ck.checked = true; ck.dispatchEvent({ type: 'change' }); await l.drain(20);
    await clickEl(l, box(l).querySelector('.dbselbar').querySelectorAll('button').find((b) => b.textContent === 'リンクを写す'));
    ck.checked = false; ck.dispatchEvent({ type: 'change' }); await l.drain(20);
    await clickEl(l, dataRows(l).find((r) => r.dataset.id === r0).querySelector('.dbgrip'), 40);
    await clickEl(l, item(l, 'リンクを写す'), 100);
    assert.deepStrictEqual(l.called('copy').map((c) => c.args[0]), [`NaTsu の「無題のデータベース」 ${B}${l.id}`, `NaTsu の「無題のページ」 ${B}${r0}`, `NaTsu の「無題のページ」 ${B}${r0}`]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('R96 (3): ［グループ］の窓は 200 を越えると一番下に「ほかに n 件あります（ここには最初の 200 件を出します）」（越えなければ出さない）', T, async () => {
  const l = await openDb({ many: 300, before: (call, d) => { call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: d.c1 } } }); } });
  try {
    await openPanel(l, 'グループ');
    const more = panel(l).querySelectorAll('.dbgmore');
    assert.strictEqual(more.length, 1, '200 を越えたのに一言が無い');
    assert.strictEqual(more[0].textContent, 'ほかに 100 件あります（ここには最初の 200 件を出します）');
    const kids = [...panel(l).querySelector('.dbglist').parentNode.childNodes];
    assert.ok(kids.indexOf(more[0]) === kids.indexOf(panel(l).querySelector('.dbglist')) + 1, '一言がグループの並びのすぐ下に無い');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
  const s = await openDb({ before: (call, d) => { call('view.update', { db: d.id, viewId: 'v1', patch: { group: { col: d.c1 } } }); } });
  try {
    await openPanel(s, 'グループ');
    assert.strictEqual(panel(s).querySelectorAll('.dbgmore').length, 0, '200 までなのに一言が出る');
  } finally { s.done(); }
});

test('R96 (4): 切れているタブ（240px で …）だけ、名前全体を吹き出し（title）で出す（切れていないタブには付けない・新しい言葉は無い）', T, async () => {
  const long = '今週のうちに終わらせたい見積もりと発注と検収のまとめ';
  const l = await openDb({ before: (call, d) => { call('view.add', { db: d.id, name: long }); } });
  const had = ['scrollWidth', 'clientWidth'].map((k) => Object.getOwnPropertyDescriptor(Element.prototype, k));
  try {
    // 名前の字の幅 20px・タブは 240px まで（本物の Chromium では .dbtab の max-width と text-overflow: ellipsis）
    Object.defineProperty(Element.prototype, 'scrollWidth', { configurable: true, get() { return this.classList && this.classList.contains('dbtab') ? this.textContent.length * 20 : 0; } });
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get() { return this.classList && this.classList.contains('dbtab') ? Math.min(this.textContent.length * 20, 240) : 0; } });
    await clickEl(l, tabs(l).find((b) => b.textContent === long), 160);
    const t = (name) => tabs(l).find((b) => b.textContent === name);
    assert.strictEqual(t(long).getAttribute('title'), long, '切れたタブに名前全体の吹き出しが無い');
    assert.ok(!t('表').hasAttribute('title'), '切れていないタブに吹き出しが付く');
    // 名前を短くすると外れる
    l.call('view.update', { db: l.id, viewId: 'v2', patch: { name: '短い' } });
    l.fire('onPagesUpdated'); await l.drain(120);
    assert.ok(!t('短い').hasAttribute('title'), '短くしても吹き出しが残る');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally {
    for (const [i, k] of ['scrollWidth', 'clientWidth'].entries()) { if (had[i]) Object.defineProperty(Element.prototype, k, had[i]); else delete Element.prototype[k]; }
    l.done();
  }
});

// ================================================================ R97（2026-11-09 の持ち主の答え・M14: 行の本文の /ページ）
test('R97: 行の本文の /ページ で行の中に白紙のページを作って開く（打った行に 📄 の行）。パンくず「… / データベース / 📄 行 / 子」・サイドバーには出さない・行の 📄 の行とパンくずから開く・Ctrl+Shift+U で行へ', T, async () => {
  // データベースの題名（D77 の会議の題名でない）
  const l = await openDb({ before: (call, d) => { call('page.setTitle', { id: d.id, title: '案件' }); } });
  try {
    const r0 = l.rows[0];
    l.fire('onOpenLink', { id: r0, anchor: '' }); await l.drain(200);
    // 空の本文の手引きの行を押して書き始める（行が無ければ作る）
    const b = l.call('block.insert', { pageId: r0, afterBlockId: '', type: 'paragraph' }).blockId;
    l.fire('onOpenLink', { id: r0, anchor: '' }); await l.drain(200);
    const t = $(l, 'pNote').querySelectorAll('.blk').find((e) => e.dataset.id === b).querySelector('.txt');
    t.focus(); t.textContent = '/ぺーじ'; l.caret.set(t, t.textContent.length); t.dispatchEvent({ type: 'input' }); await l.drain();
    const sm = $(l, 'pNote').querySelector('.slashmenu');
    assert.deepStrictEqual(sm.querySelectorAll('.sopt').map((o) => o.textContent), ['ページ']);
    l.key({ key: 'Enter', code: 'Enter' }, t);
    await l.drain(); await l.drain(200);
    assert.deepStrictEqual(l.called('pageCreate').map((c) => c.args), [[r0, b]], '行の中に打った行の所で作らない');
    const kid = l.called('pageCreate').length && l.call('page.get', { id: r0 }).page.blocks.find((x) => x.type === 'subpage').page;
    assert.ok(kid, '行の本文に 📄 の行が無い');
    assert.strictEqual(tabOnKey(l), `page:${kid}`, '作った子ページを開かない');
    assert.ok(l.document.activeElement === $(l, 'pTitle'), '作った子ページの題名にフォーカスが無い');
    assert.deepStrictEqual([crumbUps(l), crumbNow(l)], [['案件', '見積もり'], ['📄', '無題のページ']], 'パンくずが「… / データベース / 行 / 子」でない');
    assert.deepStrictEqual($(l, 'crumb').querySelectorAll('.cseg').map((x) => x.querySelector('.csi').textContent).slice(1), ['📄'], '行の段のアイコンが 📄 でない');
    const side = () => [...$(l, 'plist').children].map((e) => e.dataset && e.dataset.pid);
    assert.ok(side().includes(l.id) && !side().includes(kid), '行の中の子ページがサイドバーに出る（データベースが出ない）');
    // 子の中の孫もサイドバーに出ず、パンくずは行から
    // 白紙のページの題名（D77 の会議の題名でない）
    l.call('page.setTitle', { id: kid, title: '下見のメモ' });
    const g = l.call('page.create', { parentId: kid }).id;
    l.fire('onPagesUpdated'); await l.drain(120);
    l.fire('onOpenLink', { id: g, anchor: '' }); await l.drain(200);
    assert.deepStrictEqual(crumbUps(l), ['案件', '見積もり', '下見のメモ']);
    assert.ok(!side().includes(g) && !side().includes(kid), '孫がサイドバーに出る');
    // Ctrl+Shift+U は親のページへ（孫 → 子 → 行）
    await press(l, l.document.body, { key: 'U', code: 'KeyU', ctrlKey: true, shiftKey: true }); await l.drain(200);
    assert.strictEqual(tabOnKey(l), `page:${kid}`);
    await press(l, l.document.body, { key: 'U', code: 'KeyU', ctrlKey: true, shiftKey: true }); await l.drain(200);
    assert.strictEqual(tabOnKey(l), `page:${r0}`, 'Ctrl+Shift+U で行のページへ戻らない');
    // 行の本文の 📄 の行から子を開く・パンくずの行の段から行へ
    const sub = $(l, 'pNote').querySelectorAll('.blk.subpage').find((e) => e._b && e._b.page === kid);
    assert.ok(sub && !sub.classList.contains('gone'), '行の本文の 📄 の行が灰色');
    assert.strictEqual(sub.querySelector('.txt').textContent, '📄 下見のメモ');
    await clickEl(l, sub.querySelector('.txt'), 200);
    assert.strictEqual(tabOnKey(l), `page:${kid}`, '📄 の行から子を開かない');
    await clickEl(l, $(l, 'crumb').querySelectorAll('.cseg')[1], 200);
    assert.strictEqual(tabOnKey(l), `page:${r0}`, 'パンくずの行の段から行を開かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('R97・決めたこと 28: 行をゴミ箱へ入れると、行の中の子ページは一覧から外れる（行の本文も見えない）。Ctrl+Z で戻すとまた見える', T, async () => {
  const l = await openDb({ before: (call, d) => ({ kid: call('page.create', { parentId: d.rows[0] }).id }) });
  try {
    const has = () => l.call('pages.list', {}).some((e) => e.id === l.kid);
    assert.ok(has());
    const ck = dataRows(l).find((r) => r.dataset.id === l.rows[0]).querySelector('.dbcheck'); ck.checked = true; ck.dispatchEvent({ type: 'change' }); await l.drain(20);
    await clickEl(l, box(l).querySelector('.dbselbar').querySelectorAll('button').find((x) => x.textContent === '削除'), 200);
    assert.ok(!has(), '行をゴミ箱へ入れても子が一覧に残る');
    await press(l, grid(l), { key: 'z', code: 'KeyZ', ctrlKey: true }); await l.drain(200);
    assert.ok(has(), 'Ctrl+Z で行を戻しても子が見えない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ================================================================ DR-1: リレーションとサブアイテム（計画の Task DR-1・決めたこと 33〜38・R98）
// つなぐ先のデータベース（取引先）と両側のリレーションの列。データベース・行の名前は作った物
const relDb = (o = {}) => openDb({ ...o, before: (call, s) => {
  const d2 = call('db.create', {}).id;
  call('page.setTitle', { id: d2, title: '取引先' });   // D77 の会議の題名でない（データベースの行の題名）
  const b1 = call('row.add', { db: d2, title: '取引先 甲' }).id;   // D77 の会議の題名でない（データベースの行の題名）
  const b2 = call('row.add', { db: d2, title: '取引先 乙' }).id;   // D77 の会議の題名でない（データベースの行の題名）
  const b3 = call('row.add', { db: d2, title: 'カイギシツ' }).id;   // D77 の会議の題名でない（データベースの行の題名）
  const rc = o.noCol ? null : call('col.add', { db: s.id, type: 'rel', name: 'つなぐ', target: d2, both: true }).col.id;
  if (rc) call('rel.link', { db: s.id, id: s.rows[0], col: rc, ids: [b1, b2] });
  return { d2, b1, b2, b3, rc };
} });
const chips = (l, rowId, col) => cellOf(l, rowId, col).querySelectorAll('.dbrel').map((x) => x.textContent);
const pickOpts = (l) => (picker(l) ? picker(l).querySelectorAll('.dbopt') : []);

test('DR-1: 右端の［＋］の［リレーション］で「つなぐデータベース」の窓（相手のデータベースにも列を作るのチェック・データベースの名前の並び）→ colAdd の1回（target・both）', T, async () => {
  const l = await relDb({ noCol: true });
  try {
    await clickEl(l, box(l).querySelector('.dbcoladd'), 40);
    assert.ok(items(l).some((b) => b.textContent === 'リレーション'), '［＋］に［リレーション］が無い');
    await clickEl(l, item(l, 'リレーション'), 60);
    assert.strictEqual(menu(l).querySelector('.dbmenuhead').textContent, 'つなぐデータベース');
    const ck = menu(l).querySelector('input.dbrelboth');
    assert.ok(ck && ck.closest('label').textContent === '相手のデータベースにも列を作る', '相手のデータベースにも列を作るのチェックが無い');
    assert.deepStrictEqual(items(l).map((b) => b.textContent).sort(), ['取引先', '無題のデータベース'].sort());
    ck.checked = true;
    await clickEl(l, item(l, '取引先'), 200);
    assert.deepStrictEqual(l.called('colAdd').map((c) => c.args), [[l.id, 'rel', undefined, undefined, { target: l.d2, both: true }]]);
    const info = l.call('db.get', { id: l.id });
    const col = info.cols.find((c) => c.type === 'rel');
    assert.ok(col && col.db === l.d2 && col.back, '両側のリレーションの列ができない');
    assert.ok(box(l).querySelector('.dbcolh') && box(l).querySelectorAll('.dbcolh').some((h) => h.dataset.col === col.id), '足した列が表に出ない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DR-1: リレーションのセルは「📄 題名」の並び（押すと相手の行が今のタブで開く）・相手の行をゴミ箱へ入れると出ない（値は残る）', T, async () => {
  const l = await relDb();
  try {
    const [r0] = l.rows;
    assert.deepStrictEqual(chips(l, r0, l.rc), ['📄 取引先 甲', '📄 取引先 乙']);
    assert.strictEqual(cellOf(l, r0, l.rc).getAttribute('aria-readonly'), null, 'リレーションのセルが書けない印');
    const n = tabKeys(l).length;
    await clickEl(l, cellOf(l, r0, l.rc).querySelectorAll('.dbrel')[0], 200);
    assert.deepStrictEqual([tabKeys(l).length, tabOnKey(l), $(l, 'pTitle').textContent], [n, `page:${l.b1}`, '取引先 甲'], '押した行が開かない');
    assert.ok(picker(l) === null, '押して選びの窓が開いた');
    l.call('rows.trash', { db: l.d2, ids: [l.b2] });
    l.fire('onPageOpen', l.id); await l.drain(200);
    assert.deepStrictEqual(chips(l, r0, l.rc), ['📄 取引先 甲'], 'ゴミ箱の行がセルに出る');
    assert.deepStrictEqual(cellsIn(l, r0).cells[l.rc], [l.b1, l.b2], '値が消えた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DR-1: 選びの窓（「行を探す」・ひらがなとカタカナを寄せる・押すとつなぐ／もう一度で外す・［新しい行を作ってつなぐ］・Esc でセルへ）。行のページの列の値でも同じ窓', T, async () => {
  const l = await relDb();
  try {
    const r1 = l.rows[1];
    await clickEl(l, cellOf(l, r1, l.rc), 200);
    const q = picker(l) && picker(l).querySelector('input');
    assert.ok(q && q.getAttribute('aria-label') === '行を探す' && q.getAttribute('placeholder') === '行を探す', '「行を探す」の欄が無い');
    assert.deepStrictEqual(pickOpts(l).map((b) => [b.textContent, b.getAttribute('aria-selected')]), [
      ['📄 取引先 甲', 'false'], ['📄 取引先 乙', 'false'], ['📄 カイギシツ', 'false'], ['新しい行を作ってつなぐ', 'false']]);
    await clickEl(l, pickOpts(l)[0], 200);
    assert.deepStrictEqual(l.called('relLink').map((c) => c.args), [[l.id, r1, l.rc, [l.b1]]]);
    assert.strictEqual(pickOpts(l)[0].getAttribute('aria-selected'), 'true', '選んだ印が付かない');
    await clickEl(l, pickOpts(l)[0], 200);
    assert.deepStrictEqual(l.called('relUnlink').map((c) => c.args), [[l.id, r1, l.rc, [l.b1]]]);
    q.value = 'かいぎ'; q.dispatchEvent({ type: 'input' }); await l.drain(100);
    assert.deepStrictEqual(pickOpts(l).map((b) => b.textContent), ['📄 カイギシツ', '新しい行を作ってつなぐ']);
    q.value = '新しい取引先'; q.dispatchEvent({ type: 'input' }); await l.drain(100);
    await clickEl(l, pickOpts(l).find((b) => b.textContent === '新しい行を作ってつなぐ'), 300);
    assert.deepStrictEqual(l.called('relLink').map((c) => c.args).slice(-1), [[l.id, r1, l.rc, [], '新しい取引先']]);
    const made = cellsIn(l, r1).cells[l.rc];
    assert.strictEqual(made.length, 1);
    assert.strictEqual(l.call('page.get', { id: made[0] }).page.title, '新しい取引先');
    await press(l, picker(l).querySelector('input'), { key: 'Escape' });
    assert.ok(picker(l) === null && active(l) === cellOf(l, r1, l.rc), 'Esc で閉じてセルへ戻らない');
    assert.deepStrictEqual(chips(l, r1, l.rc), ['📄 新しい取引先']);
    // 行のページの列の値（📄 の並び・押すと同じ窓）
    await clickEl(l, openBtn(l, l.rows[0]), 200);
    const pv = $(l, 'pProps').querySelectorAll('.dbpropv').find((v) => v.dataset.col === l.rc);
    assert.deepStrictEqual(pv.querySelectorAll('.dbrel').map((x) => x.textContent), ['📄 取引先 甲', '📄 取引先 乙']);
    await clickEl(l, pv, 200);
    const pp = $(l, 'pProps').querySelector('.dbpick');
    assert.ok(pp && pp.querySelector('input').getAttribute('aria-label') === '行を探す', '行のページで選びの窓が出ない');
    await clickEl(l, pp.querySelectorAll('.dbopt')[1], 200);
    assert.deepStrictEqual(l.called('relUnlink').map((c) => c.args).slice(-1), [[l.id, l.rows[0], l.rc, [l.b2]]]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DR-1 直し2（MQ2・R108）: サブアイテムを入れている間は、2つの列の列のメニューの［削除］が灰色（ほかの列は押せる）・外すと押せる', T, async () => {
  const l = await openDb();
  try {
    const { sub } = l.call('db.setSub', { db: l.id, on: true });
    l.fire('onPageOpen', l.id); await l.drain(200);
    const del = async (colId) => { await clickEl(l, head(l, colId)); const b = item(l, '削除'); const off = b.disabled; await press(l, menu(l), { key: 'Escape' }); return off; };
    assert.deepStrictEqual([await del(sub.parent), await del(sub.kids), await del(l.c1)], [true, true, false], '入れている間の［削除］');
    l.call('db.setSub', { db: l.id, on: false });
    l.fire('onPageOpen', l.id); await l.drain(200);
    assert.deepStrictEqual([await del(sub.parent), await del(sub.kids)], [false, false], '外した後の［削除］');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DR-1: サブアイテム（データベースの「···」の［サブアイテム］・行のメニュー［サブアイテムを足す］・▸ で開け閉め・字下げ・輪は「その行の中へは入れられません」・子孫ごと消した数の知らせ・当たった子の親は灰色）', T, async () => {
  const l = await openDb();
  try {
    const [r0, r1] = l.rows;
    await clickEl(l, dataRows(l).find((r) => r.dataset.id === r0).querySelector('.dbgrip'), 40);
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['開く', '新しいタブで開く', 'リンクを写す', '削除'], '入れる前に［サブアイテムを足す］がある');
    await press(l, menu(l), { key: 'Escape' });
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    const subItem = () => $(l, 'pMenu').querySelectorAll('.mitem').find((b) => b.textContent === 'サブアイテム');
    assert.ok(subItem() && subItem().getAttribute('role') === 'menuitemcheckbox' && subItem().getAttribute('aria-checked') === 'false', '［サブアイテム］が無い');
    await clickEl(l, subItem(), 300);
    assert.deepStrictEqual(l.called('dbSetSub').map((c) => c.args), [[l.id, true]]);
    const sub = l.call('db.get', { id: l.id }).sub;
    assert.ok(sub, 'サブアイテムが入らない');
    assert.ok(['親アイテム', 'サブアイテム'].every((n) => box(l).querySelectorAll('.dbcolbtn').some((b) => b.textContent === n)), '2つの列が表に出ない');
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    assert.strictEqual(subItem().getAttribute('aria-checked'), 'true');
    $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain(20);
    // 行のメニュー［サブアイテムを足す］: 新しい子を作って親を開き、子の題名を書く
    await clickEl(l, dataRows(l).find((r) => r.dataset.id === r0).querySelector('.dbgrip'), 40);
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['開く', '新しいタブで開く', 'リンクを写す', 'サブアイテムを足す', '削除']);
    await clickEl(l, item(l, 'サブアイテムを足す'), 400);
    assert.deepStrictEqual(l.called('relLink').map((c) => c.args), [[l.id, r0, sub.kids, [], '']]);
    const kid = l.call('db.get', { id: l.id }) && cellsIn(l, r0).cells[sub.kids][0];
    assert.deepStrictEqual(dataRows(l).map((r) => r.dataset.id).slice(0, 2), [r0, kid], '子が親のすぐ後ろに出ない');
    const tog = cellOf(l, r0, 'title').querySelector('.dbsubtog');
    assert.ok(tog && tog.getAttribute('aria-label') === '見積もり' && tog.getAttribute('aria-expanded') === 'true', '親の ▾ が無い');
    assert.strictEqual(cellOf(l, r0, 'title').textContent, '見積もり', '▸ が題名の文字に混ざる');
    assert.strictEqual(dataRows(l).find((r) => r.dataset.id === kid).style.getPropertyValue('--dbdepth'), '1', '子が字下げされない');
    assert.ok(editor(l) && editor(l).closest('.dbrow').dataset.id === kid, '子の題名を書き始めない');
    editor(l).value = '子の行'; await press(l, editor(l), { key: 'Enter' });
    assert.strictEqual(l.call('page.get', { id: kid }).page.title, '子の行');
    // ▸ で閉じる（開いた行は画面のメモリ。db.view の open）
    await clickEl(l, cellOf(l, r0, 'title').querySelector('.dbsubtog'), 200);
    assert.ok(!dataRows(l).some((r) => r.dataset.id === kid), '閉じても子が出る');
    assert.strictEqual(cellOf(l, r0, 'title').querySelector('.dbsubtog').getAttribute('aria-expanded'), 'false');
    await clickEl(l, cellOf(l, r0, 'title').querySelector('.dbsubtog'), 200);
    assert.ok(dataRows(l).some((r) => r.dataset.id === kid));
    assert.deepStrictEqual(views(l).slice(-1)[0].slice(5), [[r0]], 'db.view に開いた行を渡さない');
    // 輪: 親の親アイテムに子を入れる → 一言
    await clickEl(l, cellOf(l, r0, sub.parent), 200);
    await clickEl(l, pickOpts(l).find((b) => b.textContent === '📄 子の行'), 300);
    assert.strictEqual($(l, 'toast').textContent, 'その行の中へは入れられません');
    await press(l, picker(l).querySelector('input'), { key: 'Escape' });
    // 絞り込みに当たった子の親は灰色
    l.call('view.update', { db: l.id, viewId: 'v1', patch: { filter: { op: 'and', items: [{ col: 'title', cmp: 'contains', value: '子の' }] } } });
    l.fire('onPageOpen', l.id); await l.drain(200);
    assert.deepStrictEqual(dataRows(l).map((r) => [r.dataset.id, r.classList.contains('dbdim')]), [[r0, true], [kid, false]], '当たった子の親が灰色で出ない');
    l.call('view.update', { db: l.id, viewId: 'v1', patch: { filter: null } });
    l.fire('onPageOpen', l.id); await l.drain(200);
    // 子孫ごとゴミ箱へ: 知らせの数に子も
    await clickEl(l, dataRows(l).find((r) => r.dataset.id === r0).querySelector('.dbgrip'), 40);
    await clickEl(l, item(l, '削除'), 300);
    assert.strictEqual($(l, 'toast').textContent, '行 2 件をゴミ箱に入れました（Ctrl+Z で戻せます）');
    assert.ok(!dataRows(l).some((r) => r.dataset.id === r0 || r.dataset.id === kid));
    assert.ok(dataRows(l).some((r) => r.dataset.id === r1));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 0.16.0 DX-1（決めたこと 42・43・44・45・R36・R101〜）
const sideRows = (l) => [...$(l, 'plist').children].filter((e) => e.dataset && e.dataset.pid);
const sideOf = (l, id) => sideRows(l).find((e) => e.dataset.pid === id);
const treeMenuItems = (l) => { const m = l.document.querySelector('.treemenu'); return m ? m.querySelectorAll('.mitem') : []; };
const openTreeMenuOf = async (l, id) => { sideOf(l, id).dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(); };
const CSN = { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true };
const newDbId = (l, not) => l.call('pages.list', {}).map((e) => e.id).find((x) => x !== l.id && !not.includes(x) && l.call('db.get', { id: x }));

test('DX-1・決めたこと 42: サイドバーのデータベースは 🗃️ の行で、▸ と［＋］が無い。データベースの行（kind: row）が一覧に混じっても出さない。ページをデータベースの真ん中へ落としても印が出ず中へ入らない（前後へは落とせる）。［移動先…］の候補にデータベースが無い', T, async () => {
  let me = null;
  const DB_ROW = (d) => ({ id: 'rfake01', title: '見積もり', kind: 'row', db: d, parentId: d, date: '2026-11-08', createdAt: '2026-11-08T00:00:00.000Z' });   // データベースの行の題名（D77 の会議の題名でない）
  const l = await openDb({
    before: (call) => ({ blank: call('page.create', {}).id }),
    returns: { pagesSearch: async (q) => (me ? [...(await me.K.pagesSearch(q)), DB_ROW(me.id)] : []) },
  });
  me = l;
  try {
    l.fire('onPagesUpdated'); await l.drain(120);
    const d = sideOf(l, l.id);
    assert.ok(d, 'データベースがサイドバーに無い');
    assert.strictEqual(d.querySelector('.pi').textContent, '🗃️', 'データベースのアイコンが 🗃️ でない');
    assert.strictEqual(d.querySelector('.t').textContent, '無題のデータベース');
    assert.ok(!d.classList.contains('kids') && d.getAttribute('aria-expanded') === null, 'データベースに ▸ がある');
    assert.ok(d.querySelector('.padd') === null, 'データベースの行に［＋］（中にページを作る）がある');
    assert.ok(sideOf(l, l.blank).querySelector('.padd'), '白紙のページの［＋］が無い');
    assert.deepStrictEqual(sideRows(l).map((e) => e.dataset.pid), [l.blank, l.id], 'データベースの行がサイドバーに出る');
    // 引っ張り: データベースの真ん中は印が出ず呼ばない・上の4分の1は前へ
    for (const r of sideRows(l)) r._rect = { top: 0, height: 30 };
    const TYPES = { types: ['application/x-natsu-page'] };
    const over = (id, y) => { let prevented = false; sideOf(l, id).dispatchEvent({ type: 'dragover', clientY: y, dataTransfer: TYPES, preventDefault() { prevented = true; } }); return prevented; };
    const drop = (id, y) => sideOf(l, id).dispatchEvent({ type: 'drop', clientY: y, dataTransfer: TYPES, preventDefault() {} });
    sideOf(l, l.blank).dispatchEvent({ type: 'dragstart', target: sideOf(l, l.blank), dataTransfer: { effectAllowed: '', setData() {} } });
    assert.strictEqual(over(l.id, 15), false, 'データベースの真ん中に落とす所を出した');
    assert.ok(!sideRows(l).some((r) => /drop(in|before|after)/.test(r.className)), 'データベースの真ん中で印を出した');
    drop(l.id, 15); await l.drain();
    assert.deepStrictEqual(l.called('pageMove'), [], 'ページをデータベースの中へ動かした');
    sideOf(l, l.blank).dispatchEvent({ type: 'dragstart', target: sideOf(l, l.blank), dataTransfer: { effectAllowed: '', setData() {} } });
    assert.strictEqual(over(l.id, 28), true, 'データベースの後ろに落とせない');
    assert.ok(sideOf(l, l.id).classList.contains('dropafter'));
    drop(l.id, 28); await l.drain(120);
    assert.deepStrictEqual(l.called('pageMove').map((c) => c.args), [[l.blank, null, l.id]], 'データベースの後ろへ動かさない');
    // ［移動先…］の候補（白紙のページから開く）にデータベースが無い
    await openTreeMenuOf(l, l.blank);
    treeMenuItems(l).find((b) => b.textContent === '移動先…').dispatchEvent({ type: 'click' }); await l.drain();
    assert.deepStrictEqual($(l, 'moveList').querySelectorAll('.mvopt').map((e) => e.dataset.pid), [''], '［移動先…］の候補にデータベースがある');
    l.key({ key: 'Escape' }, $(l, 'moveSearch')); await l.drain();
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DX-1・決めたこと 43: Ctrl+Shift+N の「新しいページ」の3つ目に［🗃️ データベース］→ dbCreate() の1回（最上位）で、作ったデータベースを今のタブで開き、題名にフォーカス（手引き「無題のデータベース」）', T, async () => {
  const l = await openDb();
  try {
    await press(l, l.document.body, CSN);
    const items = () => $(l, 'newList').querySelectorAll('.mitem');
    assert.deepStrictEqual(items().map((b) => b.textContent), ['📄 白紙のページ', '🎙️ 議事録（録音の前のページ）', '🗃️ データベース']);
    await clickEl(l, items()[2], 200);
    assert.deepStrictEqual(l.called('dbCreate').map((c) => c.args), [[]], '［データベース］が最上位の dbCreate() でない');
    assert.strictEqual($(l, 'newPop').hidden, true);
    const made = newDbId(l, []);
    assert.ok(made, 'データベースができない');
    assert.strictEqual(tabOnKey(l), `page:${made}`, '作ったデータベースを開かない');
    assert.ok(l.document.activeElement === $(l, 'pTitle'), '題名にフォーカスが無い');
    assert.strictEqual($(l, 'pTitle').getAttribute('data-ph'), '無題のデータベース');
    assert.strictEqual(sideOf(l, made).querySelector('.pi').textContent, '🗃️');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DX-1・決めたこと 43: サイドバーの行のメニューに［中にデータベースを作る］（［中にページを作る］の次）→ dbCreate(行の id) で、白紙のページの本文の最後に 🗃️ の行・開いて題名にフォーカス・親の行は開く。データベースの行のメニューは中に作る2つが無い', T, async () => {
  const l = await openDb({ before: (call) => ({ blank: call('page.create', {}).id }) });
  try {
    l.fire('onPagesUpdated'); await l.drain(120);
    await openTreeMenuOf(l, l.blank);
    assert.deepStrictEqual(treeMenuItems(l).map((b) => b.textContent), ['中にページを作る', '中にデータベースを作る', '移動先…', '新しいタブで開く', '削除']);
    await clickEl(l, treeMenuItems(l)[1], 300);
    assert.deepStrictEqual(l.called('dbCreate').map((c) => c.args), [[l.blank]], '行の中に作らない');
    const made = newDbId(l, []);
    assert.ok(made, 'データベースができない');
    assert.strictEqual(tabOnKey(l), `page:${made}`, '作ったデータベースを開かない');
    assert.ok(l.document.activeElement === $(l, 'pTitle'), '題名にフォーカスが無い');
    const body = l.call('page.get', { id: l.blank }).page.blocks;
    assert.deepStrictEqual(body.map((b) => [b.type, b.page, b.inline]), [['subpage', made, undefined]], '白紙のページの本文の最後に行が無い');
    assert.deepStrictEqual(sideRows(l).map((e) => [e.dataset.pid, e.getAttribute('aria-level')]).filter((x) => x[0] === made), [[made, '2']], '親の行が開かないか、子の段でない');
    await openTreeMenuOf(l, l.id);
    assert.deepStrictEqual(treeMenuItems(l).map((b) => b.textContent), ['移動先…', '新しいタブで開く', '削除'], 'データベースの行のメニューに中に作る項目がある');
    l.key({ key: 'Escape' }, l.document.querySelector('.treemenu')); await l.drain();
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DX-1・決めたこと 44・R36: データベースを消す確かめは「このデータベースと行 n 件をゴミ箱に入れます。よろしいですか？（ゴミ箱から戻せます）」（n はゴミ箱でない行。db.get の1回）。やめると消さない', T, async () => {
  const l = await openDb({ before: (call, d) => { call('rows.trash', { db: d.id, ids: [d.rows[2]] }); } });
  try {
    l.fire('onPagesUpdated'); await l.drain(120);
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); return false; };
    const n0 = l.called('dbGet').length;
    await openTreeMenuOf(l, l.id);
    await clickEl(l, treeMenuItems(l).find((b) => b.textContent === '削除'), 200);
    assert.deepStrictEqual(asked, ['このデータベースと行 2 件をゴミ箱に入れます。よろしいですか？（ゴミ箱から戻せます）']);
    assert.strictEqual(l.called('dbGet').length - n0, 1, '行の数を db.get の1回で読まない');
    assert.deepStrictEqual(l.called('pageDelete'), [], 'やめたのに消した');
    l.window.confirm = (m) => { asked.push(m); return true; };
    await clickEl(l, $(l, 'pMore'), 40);
    await clickEl(l, l.document.querySelectorAll('.mitem').find((b) => b.textContent === '削除'), 300);
    assert.strictEqual(asked[1], asked[0], '「···」の［削除］の確かめが違う');
    assert.deepStrictEqual(l.called('pageDelete').map((c) => c.args), [[l.id]]);
    assert.strictEqual(l.call('db.get', { id: l.id }), null, '消えない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DX-1・決めたこと 45: 起動のときに戻した行のページのタブ（選んでいないもの）は、行の題名と 📄 で出る（page.get で読む）', T, async () => {
  let d = null;
  const l = await openDb({
    before: (call, x) => { d = x; },
    returns: { uiState: () => ({ tabs: { open: [`page:${d.rows[1]}`, `page:${d.id}`], active: `page:${d.id}` } }) },
  });
  try {
    await l.drain(120);
    const tabs = $(l, 'tabbar').querySelectorAll('.tabitem');
    const t = tabs.find((x) => x.getAttribute('data-key') === `page:${l.rows[1]}`);
    assert.ok(t, '行のタブが戻らない');
    assert.deepStrictEqual([t.querySelector('.tt').getAttribute('data-icon'), t.querySelector('.tt').textContent], ['📄', '発注'], '行のタブが行の題名と 📄 でない');
    const dt = tabs.find((x) => x.getAttribute('data-key') === `page:${l.id}`);
    assert.deepStrictEqual([dt.querySelector('.tt').getAttribute('data-icon'), dt.querySelector('.tt').textContent], ['🗃️', '無題のデータベース'], 'データベースのタブが 🗃️ と「無題のデータベース」でない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 0.16.0 DX-2（決めたこと 44・46・R98 (1)・R102）
const palType = async (l, q) => { $(l, 'searchBox').value = q; $(l, 'searchBox').dispatchEvent({ type: 'input' }); await l.clock.advance(300); await l.drain(120); };   // 打つと 220 ミリ秒後に探す（偽の時計）
const palItems = (l) => $(l, 'palList').querySelectorAll('.pitem');

test('DX-2・決めたこと 46: 検索の窓に行の当たりが「📄 題名」・2行目「場所: 🗃️ データベース名 ・ 日付」と抜き出しで出て、押すと行のページを今のタブで開く。ゴミ箱の行は出ない', T, async () => {
  const l = await openDb({ before: (call, d) => { call('page.setTitle', { id: d.id, title: '案件' }); call('rows.trash', { db: d.id, ids: [d.rows[2]] }); } });   // データベースの題名（D77 の会議の題名でない）
  try {
    l.fire('onPagesUpdated'); await l.drain(120);
    $(l, 'sideSearch').dispatchEvent({ type: 'click' }); await l.drain();
    await palType(l, 'メモ');
    const date = l.call('pages.list', { q: 'メモ 0' }).find((e) => e.id === l.rows[0]).date;
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/);
    const got = palItems(l).map((e) => [e.dataset.pid, e.querySelector('.pi').textContent, e.querySelector('.t').textContent, e.querySelector('.m').textContent, (e.querySelector('.snip') || {}).textContent]);
    assert.deepStrictEqual(got, [[l.rows[0], '📄', '見積もり', `場所: 🗃️ 案件 ・ ${date}`, 'メモ 0'], [l.rows[1], '📄', '発注', `場所: 🗃️ 案件 ・ ${date}`, 'メモ 1']], 'ゴミ箱の行が出るか、行の当たりの形が違う');
    // データベースのページそのものは題名で当たり、2行目は日付だけ（長さ・要約なしを出さない）
    await palType(l, '案件');
    const dbDate = l.call('pages.list', {}).find((e) => e.id === l.id).date;
    assert.deepStrictEqual(palItems(l).map((e) => [e.dataset.pid, e.querySelector('.pi').textContent, e.querySelector('.m').textContent]), [[l.id, '🗃️', dbDate]], 'データベースの2行目が日付だけでない');
    await palType(l, 'メモ');
    await clickEl(l, palItems(l)[1], 200);
    assert.strictEqual(tabOnKey(l), `page:${l.rows[1]}`, '行のページを開かない');
    assert.strictEqual($(l, 'pTitle').textContent, '発注');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('DX-2・決めたこと 44・R98 (1): 行をゴミ箱へ入れると［ゴミ箱］の窓に「行 題名（データベース名）」・まとめて消した行は1つのまとまり（「ほかの行 n」）。［戻す］で元の並びに戻り、開いている表も描き直す。データベースを消して戻すと行も見える', T, async () => {
  const l = await openDb({ titles: ['見積もり', '発注', '検収', '請求'], before: (call, d) => { call('page.setTitle', { id: d.id, title: '案件' }); } });   // データベースの行の題名（D77 の会議の題名でない）
  try {
    const [r0, r1, r2] = l.rows;
    l.call('rows.trash', { db: l.id, ids: [r0, r1] });
    l.call('rows.trash', { db: l.id, ids: [r2] });
    l.fire('onPagesUpdated'); await l.drain(200);
    await l.K.pagesTrash(); l.fire('onPagesUpdated'); await l.drain(120);
    assert.strictEqual($(l, 'tabBtnTrash').hidden, false, '［ゴミ箱］が出ない');
    assert.deepStrictEqual(dataRows(l).map((r) => r.dataset.id), [l.rows[3]]);
    await clickEl(l, $(l, 'tabBtnTrash'), 80);
    const rowsOfTrash = () => $(l, 'trashList').querySelectorAll('.tprow').map((e) => [e.dataset.pid, e.querySelector('.tpt').textContent, e.querySelector('.tpm').textContent.replace(/^[^・]*/, ''), e.querySelector('button').getAttribute('aria-label')]);
    assert.deepStrictEqual(rowsOfTrash(), [[r2, '行 検収（案件）', '', '『検収』を戻す'], [r0, '行 見積もり（案件）', '・ほかの行 1', '『見積もり』を戻す']], '行のまとまりの形が違う');
    await clickEl(l, $(l, 'trashList').querySelectorAll('.tprow')[1].querySelector('button'), 300);
    assert.deepStrictEqual(l.called('pageRestore').map((c) => c.args), [[r0]]);
    assert.deepStrictEqual(dataRows(l).map((r) => r.dataset.id), [r0, r1, l.rows[3]], '戻した行が元の並びで表に出ない');
    assert.deepStrictEqual(rowsOfTrash().map((x) => x[0]), [r2]);
    // データベースを消して戻すと、行（ゴミ箱に入れていない行）も見える
    l.window.confirm = () => true;
    await l.K.pageDelete(l.id); l.fire('onPagesUpdated'); await l.drain(200);
    assert.deepStrictEqual(rowsOfTrash().map((x) => x[0]), [l.id], 'ゴミ箱のデータベースの行が窓に出る');
    await clickEl(l, $(l, 'trashList').querySelectorAll('.tprow')[0].querySelector('button'), 300);
    l.fire('onPageOpen', l.id); await l.drain(200);
    assert.deepStrictEqual(dataRows(l).map((r) => r.dataset.id), [r0, r1, l.rows[3]], 'データベースを戻しても行が見えない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---- DL-1 (2)（R111 の (2)・R115）: 白紙のページの本文の表（表ごとの状態）
const inlineOf = (l) => $(l, 'pNote').querySelectorAll('.dbhost');
const rowTitles = (host) => host.querySelectorAll('.dbrow').filter((r) => r.dataset.id).map((r) => r.querySelectorAll('.dbcell').find((c) => c.dataset.col === 'title').textContent);
const twoInline = (call) => {
  const P = call('page.create', {}).id;
  const b1 = call('block.insert', { pageId: P, afterBlockId: '', type: 'paragraph' }).blockId;
  const D1 = call('db.create', { parentId: P, inline: b1 }).id;
  call('db.setTitle', { db: D1, title: 'いちの表' });   // データベースの題名と行の題名（D77 の会議の題名でない）
  call('row.add', { db: D1, title: 'いちの行' });   // データベースの題名と行の題名（D77 の会議の題名でない）
  const b2 = call('block.insert', { pageId: P, afterBlockId: b1, type: 'paragraph' }).blockId;
  const D2 = call('db.create', { parentId: P, inline: b2 }).id;
  call('row.add', { db: D2, title: 'にの行' });   // データベースの題名と行の題名（D77 の会議の題名でない）
  return { P, D1, D2, r1: b1, r2: b2 };
};
test('DL-1 (2)・F141: 白紙のページの本文の inline の子ページの行は表を描く。2つの表はそれぞれの状態（行・［＋ 新しい行］はその表のデータベースへ・表のまとまりの aria-label「データベース『題名』」）', T, async () => {
  const l = await openDb({ before: twoInline });
  try {
    l.fire('onPageOpen', l.P); await l.drain(300);
    const hs = inlineOf(l);
    assert.strictEqual(hs.length, 2, '本文に表が2つ無い');
    assert.deepStrictEqual(hs.map(rowTitles), [['いちの行'], ['にの行']], '表ごとの行でない');
    assert.deepStrictEqual(hs.map((h) => h.querySelector('.dbgrid').getAttribute('aria-label')), ['データベース『いちの表』', 'データベース『無題のデータベース』']);
    const n = l.called('rowAdd').length;
    await clickEl(l, hs[1].querySelector('.dbadd'), 300);
    assert.deepStrictEqual(l.called('rowAdd').slice(n).map((c) => c.args[0]), [l.D2], '2つ目の表の［＋ 新しい行］が2つ目のデータベースに足さない');
    await clickEl(l, hs[0].querySelector('.dbadd'), 300);
    assert.deepStrictEqual(l.called('rowAdd').slice(n).map((c) => c.args[0]), [l.D2, l.D1], '1つ目の表の［＋ 新しい行］が1つ目のデータベースに足さない');
    assert.deepStrictEqual(inlineOf(l).map(rowTitles).map((t) => t.length), [2, 2], '足した行が表に出ない');
  } finally { l.done(); }
});
test('DL-1 (2)・F141: インラインの表の頭は 🗃️・題名の欄（手引き「無題のデータベース」・aria-label「データベースの題名」）・⤢（title「ページで開く」）。題名を変えて離れると dbSetTitle の1回で元のデータベースの題名・⤢ でデータベースのページ。データベースをゴミ箱へ入れると灰色の行', T, async () => {
  const l = await openDb({ before: twoInline });
  try {
    l.fire('onPageOpen', l.P); await l.drain(300);
    const [h1, h2] = inlineOf(l);
    const t1 = h1.querySelector('.dbtitle');
    assert.deepStrictEqual([h1.querySelector('.dbicon').textContent, t1.value, t1.getAttribute('placeholder'), t1.getAttribute('aria-label')], ['🗃️', 'いちの表', '無題のデータベース', 'データベースの題名']);
    assert.strictEqual(h2.querySelector('.dbtitle').value, '', '無題の題名の欄が空でない');
    const ex = h1.querySelector('.dbexpand');
    assert.strictEqual(ex.title, 'ページで開く');
    t1.value = 'あたらしい表';
    t1.dispatchEvent({ type: 'blur' }); await l.drain(200);
    assert.deepStrictEqual(l.called('dbSetTitle').map((c) => c.args), [[l.D1, 'あたらしい表']], '題名の欄が db.setTitle の1回でない');
    assert.strictEqual(l.call('db.get', { id: l.D1 }).title, 'あたらしい表');
    assert.strictEqual(inlineOf(l)[0].querySelector('.dbgrid').getAttribute('aria-label'), 'データベース『あたらしい表』', '表のまとまりの名前が替わらない');
    t1.dispatchEvent({ type: 'blur' }); await l.drain(100);
    assert.strictEqual(l.called('dbSetTitle').length, 1, '同じ題名をもう一度書いた');
    l.call('page.delete', { id: l.D2 });
    l.fire('onPagesUpdated'); await l.drain(300);
    const g = inlineOf(l)[1];
    assert.ok(g && g.querySelector('.dbgone') && g.querySelector('.dbgone').textContent === '（このデータベースは見られません）', '灰色の行が無い');
    assert.strictEqual(g.querySelector('.dbgrid'), null, 'ゴミ箱のデータベースの表を描いた');
    ex.dispatchEvent({ type: 'click' }); await l.drain(300);
    assert.strictEqual(tabOnKey(l), `page:${l.D1}`, '⤢ でデータベースのページを開かない');
  } finally { l.done(); }
});

// ---- DL-1 (2b)（R111 の (2)・R115 (a)・R116）: リンクドビュー・/データベース・/リンクドビュー・行のメニュー・知らせ2つ・データベースのページの題名
const bodyRow = (l, id) => $(l, 'pNote').querySelectorAll('.blk').find((e) => e.dataset.id === id);
const slashIn = async (l, t, text) => { t.focus(); t.textContent = text; l.caret.set(t, text.length); t.dispatchEvent({ type: 'input' }); await l.drain(); };
const slashOpts = (l) => { const m = $(l, 'pNote').querySelector('.slashmenu'); return m ? m.querySelectorAll('.sopt').map((o) => o.textContent) : []; };
const pickWin = (l) => $(l, 'pNote').querySelector('.dbpickwin');
const winOpts = (l) => (pickWin(l) ? pickWin(l).querySelectorAll('.dbopt') : []);
const blockMenuItems = (l) => { const m = $(l, 'pNote').querySelector('.blockmenu'); return m ? m.querySelectorAll('.mitem') : []; };
const hostOf = (l, rowId) => { const r = bodyRow(l, rowId); return r ? r.querySelector('.dbhost') : null; };
const hostMenu = (h) => h.querySelector('.dbmenu');
const hostItem = (h, label) => (hostMenu(h) ? hostMenu(h).querySelectorAll('.mitem') : []).find((b) => b.textContent === label);
// 白紙のページ P（段落 b1・b2）・元のデータベース（題名「ケース台帳」・ビュー「表」と「担当別」）・無題のデータベース・ゴミ箱のデータベース
const linkSetup = (call, d) => {
  const P = call('page.create', {}).id;
  call('page.setTitle', { id: P, title: 'まとめの頁' });   // 白紙のページの題名（D77 の会議の題名でない）
  const b1 = call('block.insert', { pageId: P, afterBlockId: '', type: 'paragraph' }).blockId;
  const b2 = call('block.insert', { pageId: P, afterBlockId: b1, type: 'paragraph' }).blockId;
  call('db.setTitle', { db: d.id, title: 'ケース台帳' });   // データベースの題名（D77 の会議の題名でない）
  const v2 = call('view.add', { db: d.id, layout: 'table', name: '担当別' }).view.id;
  const D2 = call('db.create', {}).id;
  const D3 = call('db.create', {}).id;
  call('page.delete', { id: D3 });
  return { P, b1, b2, v2, D2, D3 };
};
test('DL-1 (2b)・F141: 白紙のページの / メニューに［データベース］［リンクドビュー］（よみ・英語でも当たる。行のページの本文には出ない）。/データベース → dbCreate(ページ, 打った行) の1回で打った行がインラインの表', T, async () => {
  const l = await openDb({ before: linkSetup });
  try {
    l.fire('onPageOpen', l.P); await l.drain(300);
    const t = bodyRow(l, l.b1).querySelector('.txt');
    await slashIn(l, t, '/');
    assert.deepStrictEqual(slashOpts(l).slice(-3), ['ページ', 'データベース', 'リンクドビュー'], '語の無い / メニューの型の後ろに無い');
    for (const [q, want] of [['でーたべーす', ['データベース']], ['database', ['データベース']], ['りんくどびゅー', ['リンクドビュー']], ['linked', ['リンクドビュー']]]) {
      await slashIn(l, t, `/${q}`);
      assert.deepStrictEqual(slashOpts(l), want, `/${q}`);
    }
    await slashIn(l, t, '/でーたべーす');
    l.key({ key: 'Enter', code: 'Enter' }, t); await l.drain(); await l.drain(300);
    assert.deepStrictEqual(l.called('dbCreate').map((c) => c.args), [[l.P, l.b1]], '/データベース が打った行で dbCreate の1回でない');
    const b = l.call('page.get', { id: l.P }).page.blocks.find((x) => x.id === l.b1);
    assert.ok(b && b.type === 'subpage' && b.inline === true, '打った行がインラインの子ページの行でない');
    assert.ok(hostOf(l, l.b1), '打った行に表を描かない');
    // 行のページの本文には出さない（議事録の本文・メモの欄にも出さない: 白紙のページの本文だけ）
    const r0 = l.rows[0];
    const rb = l.call('block.insert', { pageId: r0, afterBlockId: '', type: 'paragraph' }).blockId;
    l.fire('onOpenLink', { id: r0, anchor: '' }); await l.drain(200);
    await slashIn(l, bodyRow(l, rb).querySelector('.txt'), '/');
    assert.ok(slashOpts(l).includes('ページ') && !slashOpts(l).includes('データベース') && !slashOpts(l).includes('リンクドビュー'), '行のページの本文に出る');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
test('DL-1 (2b)・F141（R107）: /リンクドビュー の窓。1手目「つなぐデータベース」・「データベースを探す」・名前（無題は「無題のデータベース」・ゴミ箱は出さない）・「当てはまるデータベースがありません」。2手目「元のビューを写す」・ビューの名前・区切りの下に［新しい表から始める］。Esc は何も置かない', T, async () => {
  const l = await openDb({ before: linkSetup });
  try {
    l.fire('onPageOpen', l.P); await l.drain(300);
    const t = bodyRow(l, l.b1).querySelector('.txt');
    await slashIn(l, t, '/りんく');
    l.key({ key: 'Enter', code: 'Enter' }, t); await l.drain(200);
    const w = pickWin(l);
    assert.ok(w, '窓が開かない');
    assert.strictEqual(w.querySelector('.dbpickhead').textContent, 'つなぐデータベース');
    const q = w.querySelector('input');
    assert.deepStrictEqual([q.getAttribute('placeholder'), q.getAttribute('aria-label')], ['データベースを探す', 'データベースを探す']);
    assert.ok(l.document.activeElement === q, '探す欄にフォーカスが無い');
    assert.deepStrictEqual(winOpts(l).map((o) => o.textContent).sort(), ['ケース台帳', '無題のデータベース'], 'データベースの並びが違う（ゴミ箱を出した）');
    q.value = 'けーす'; q.dispatchEvent({ type: 'input' }); await l.drain(60);
    assert.deepStrictEqual(winOpts(l).map((o) => o.textContent), ['ケース台帳'], 'ひらがなで片仮名の題名が当たらない');
    q.value = 'あてはまらない語'; q.dispatchEvent({ type: 'input' }); await l.drain(60);
    assert.deepStrictEqual([winOpts(l).length, w.querySelector('.snone').textContent], [0, '当てはまるデータベースがありません']);
    q.value = ''; q.dispatchEvent({ type: 'input' }); await l.drain(60);
    await clickEl(l, winOpts(l).find((o) => o.textContent === 'ケース台帳'), 200);
    assert.strictEqual(pickWin(l).querySelector('.dbpickhead').textContent, '元のビューを写す');
    assert.deepStrictEqual(winOpts(l).map((o) => o.textContent), ['表', '担当別', '新しい表から始める']);
    assert.ok(pickWin(l).querySelector('.dbpicksep'), '区切りの線が無い');
    l.key({ key: 'Escape' }, l.document.activeElement); await l.drain(100);
    assert.ok(!pickWin(l), 'Esc で閉じない');
    assert.deepStrictEqual(l.called('blockInsertDbView'), [], 'Esc で置いた');
    assert.ok(l.document.activeElement === t && t.textContent === '/りんく', 'Esc で打った行へ戻らない（打った文字は残す）');
    // もう一度（Esc で閉じた / ではもう開かないので、打ち直す）: 元のビュー「担当別」を写す → blockInsertDbView(ページ, 打った行, データベース, ビュー) の1回・打った文は消える
    await slashIn(l, t, '');
    await slashIn(l, t, '/りんく');
    l.key({ key: 'Enter', code: 'Enter' }, t); await l.drain(200);
    await clickEl(l, winOpts(l).find((o) => o.textContent === 'ケース台帳'), 200);
    await clickEl(l, winOpts(l).find((o) => o.textContent === '担当別'), 400);
    assert.deepStrictEqual(l.called('blockInsertDbView').map((c) => c.args), [[l.P, l.b1, l.id, l.v2]]);
    const row = l.call('page.get', { id: l.P }).page.blocks.find((x) => x.type === 'dbview');
    assert.ok(row && row.id === l.b1 && row.views.length === 1 && row.views[0].name === '担当別', '打った行が写したビューのリンクドビューでない');
    const h = hostOf(l, l.b1);
    assert.ok(h, 'リンクドビューを描かない');
    assert.strictEqual(h.querySelector('.dbgrid').getAttribute('aria-label'), 'データベース『ケース台帳』のリンクドビュー');
    assert.deepStrictEqual(h.querySelectorAll('.dbtab').map((x) => x.textContent), ['担当別']);
    assert.deepStrictEqual([h.querySelector('.dbtitle').value, h.querySelector('.dbexpand').title], ['ケース台帳', 'ページで開く']);
    // ［新しい表から始める］は from 無し（ビュー「表」）
    const t2 = bodyRow(l, l.b2).querySelector('.txt');
    await slashIn(l, t2, '/linked');
    l.key({ key: 'Enter', code: 'Enter' }, t2); await l.drain(200);
    await clickEl(l, winOpts(l).find((o) => o.textContent === 'ケース台帳'), 200);
    await clickEl(l, winOpts(l).find((o) => o.textContent === '新しい表から始める'), 400);
    assert.deepStrictEqual(l.called('blockInsertDbView').map((c) => c.args)[1], [l.P, l.b2, l.id]);
    assert.deepStrictEqual(hostOf(l, l.b2).querySelectorAll('.dbtab').map((x) => x.textContent), ['表']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
test('DL-1 (2b)・F141（R105）: リンクドビューのタブは自分の物（viewAdd・viewUpdate・viewRemove に linked。元のデータベースのビューは変わらない）・［リンクを写す］は置いたページのその行・列の［削除］は元のデータベースから消す', T, async () => {
  const l = await openDb({ before: (call, d) => { const s = linkSetup(call, d); return { ...s, L: call('block.insertDbView', { pageId: s.P, afterId: s.b1, db: d.id, from: 'v1' }).blockId }; } });
  try {
    l.fire('onPageOpen', l.P); await l.drain(300);
    const h = hostOf(l, l.L);
    const was = JSON.stringify(l.call('db.get', { id: l.id }).views);
    await clickEl(l, h.querySelector('.dbviewadd'));
    await clickEl(l, hostItem(h, 'リスト'), 300);
    assert.deepStrictEqual(l.called('viewAdd').map((c) => c.args), [[l.id, { layout: 'list', linked: l.L }]], 'リンクドビューのタブを linked で足さない');
    assert.deepStrictEqual(h.querySelectorAll('.dbtab').map((x) => x.textContent), ['表', 'リスト']);
    const lv = l.call('db.get', { id: l.id, linked: l.L }).views;
    const tabEl = (name) => h.querySelectorAll('.dbtab').find((x) => x.textContent === name);
    tabEl('リスト').dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(40);
    await clickEl(l, hostItem(h, '名前を変える'));
    const rn = hostMenu(h).querySelector('input'); rn.value = '一覧'; await press(l, rn, { key: 'Enter' }); await l.drain(200);
    assert.deepStrictEqual(l.called('viewUpdate').map((c) => c.args), [[l.id, lv[1].id, { name: '一覧' }, l.L]]);
    tabEl('一覧').dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(40);
    await clickEl(l, hostItem(h, 'リンクを写す'), 120);
    assert.ok(String(l.called('copy').map((c) => c.args[0]).pop()).endsWith(`${l.P}&a=b:${l.L}`), '［リンクを写す］が置いたページのその行へのリンクでない');
    l.window.confirm = () => true;
    tabEl('一覧').dispatchEvent({ type: 'contextmenu', preventDefault() {} }); await l.drain(40);
    await clickEl(l, hostItem(h, '削除'), 300);
    assert.deepStrictEqual(l.called('viewRemove').map((c) => c.args), [[l.id, lv[1].id, l.L]]);
    assert.strictEqual(JSON.stringify(l.call('db.get', { id: l.id }).views), was, '元のデータベースのビューが変わった');
    // 列の［削除］は元のデータベースの列（col.remove）
    const colBtn = h.querySelectorAll('.dbcolh').find((x) => x.dataset.col === l.c1).querySelector('.dbcolbtn');
    await clickEl(l, colBtn);
    await clickEl(l, hostItem(h, '削除'), 300);
    assert.deepStrictEqual(l.called('colRemove').map((c) => c.args.slice(0, 2)), [[l.id, l.c1]]);
    assert.ok(l.call('db.get', { id: l.id }).cols.find((c) => c.id === l.c1).gone, '元のデータベースの列が消えない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
test('DL-1 (2b)・F141（R113 (a)・DQ10・DQ11）: 行のメニュー［インラインにする］［ページの行に変える］→ blockUpdate の inline の1回。11 個目は「1つのページに置けるデータベースの表は 10 までです。」。リンクドビューの行の複製は「リンクドビューは複製できません」', T, async () => {
  const l = await openDb({ before: (call, d) => {
    const s = linkSetup(call, d);
    const S1 = call('db.create', { parentId: s.P }).id;   // 本文の最後の 🗃️ の行（inline 無し）
    const kid = call('page.create', { parentId: s.P }).id;   // 📄 の行
    const L = call('block.insertDbView', { pageId: s.P, afterId: s.b2, db: d.id }).blockId;
    const rowOf = (pg) => call('page.get', { id: s.P }).page.blocks.find((x) => x.type === 'subpage' && x.page === pg).id;
    return { ...s, S1, kid, L, s1: rowOf(S1), sk: rowOf(kid) };
  } });
  try {
    l.fire('onPageOpen', l.P); await l.drain(300);
    const menuOf = async (rowId) => { const e = bodyRow(l, rowId); e.querySelector('.grip').dispatchEvent({ type: 'click' }); await l.drain(40); return blockMenuItems(l).map((b) => b.textContent); };
    assert.ok((await menuOf(l.s1)).includes('インラインにする'), '🗃️ の行に［インラインにする］が無い');
    assert.ok(!blockMenuItems(l).some((b) => b.textContent === 'ページの行に変える'));
    l.key({ key: 'Escape' }, l.document.activeElement); await l.drain(40);
    const km = await menuOf(l.sk);
    assert.ok(!km.includes('インラインにする') && !km.includes('ページの行に変える'), '📄 の行に出る');
    l.key({ key: 'Escape' }, l.document.activeElement); await l.drain(40);
    await menuOf(l.s1);
    await clickEl(l, blockMenuItems(l).find((b) => b.textContent === 'インラインにする'), 300);
    assert.deepStrictEqual(l.called('blockUpdate').map((c) => c.args), [[l.P, l.s1, { inline: true }]]);
    assert.ok(hostOf(l, l.s1), 'インラインにしても表を描かない');
    await menuOf(l.s1);
    await clickEl(l, blockMenuItems(l).find((b) => b.textContent === 'ページの行に変える'), 300);
    assert.deepStrictEqual(l.called('blockUpdate').map((c) => c.args)[1], [l.P, l.s1, { inline: false }]);
    assert.ok(!hostOf(l, l.s1), 'ページの行に変えても表が残る');
    // リンクドビューの行の複製（⠿ のメニューの［複製］・Ctrl+D）は写さず知らせる
    await menuOf(l.L);
    await clickEl(l, blockMenuItems(l).find((b) => b.textContent === '複製'), 200);
    assert.strictEqual($(l, 'toast').textContent, 'リンクドビューは複製できません');
    $(l, 'toast').textContent = '';
    const lt = bodyRow(l, l.L).querySelector('.txt');
    l.key({ key: 'd', code: 'KeyD', ctrlKey: true }, lt); await l.drain(200);
    assert.strictEqual($(l, 'toast').textContent, 'リンクドビューは複製できません', 'Ctrl+D で知らせない');
    assert.deepStrictEqual(l.called('blockDuplicate'), [], 'リンクドビューの行を複製した');
    // 11 個目: 本文の表を 10 にしてから［インラインにする］・/データベース・/リンクドビュー
    for (let i = 0; i < 9; i += 1) l.call('db.create', { parentId: l.P, inline: l.b1 });   // リンクドビューと合わせて 10
    l.fire('onPageOpen', l.P); await l.drain(400);
    $(l, 'toast').textContent = '';
    await menuOf(l.s1);
    await clickEl(l, blockMenuItems(l).find((b) => b.textContent === 'インラインにする'), 300);
    assert.strictEqual($(l, 'toast').textContent, '1つのページに置けるデータベースの表は 10 までです。', '［インラインにする］の 11 個目');
    const nb = l.call('block.insert', { pageId: l.P, afterBlockId: '', type: 'paragraph' }).blockId;
    l.fire('onPageOpen', l.P); await l.drain(400);
    $(l, 'toast').textContent = '';
    const tn = bodyRow(l, nb).querySelector('.txt');
    await slashIn(l, tn, '/でーたべーす');
    l.key({ key: 'Enter', code: 'Enter' }, tn); await l.drain(); await l.drain(300);
    assert.strictEqual($(l, 'toast').textContent, '1つのページに置けるデータベースの表は 10 までです。', '/データベース の 11 個目');
    $(l, 'toast').textContent = '';
    const tn2 = bodyRow(l, nb).querySelector('.txt');
    await slashIn(l, tn2, '/りんく');
    l.key({ key: 'Enter', code: 'Enter' }, tn2); await l.drain(200);
    await clickEl(l, winOpts(l).find((o) => o.textContent === 'ケース台帳'), 200);
    await clickEl(l, winOpts(l).find((o) => o.textContent === '新しい表から始める'), 400);
    assert.strictEqual($(l, 'toast').textContent, '1つのページに置けるデータベースの表は 10 までです。', '/リンクドビュー の 11 個目');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
test('DL-1 (2b)（R105「1つの道」）: データベースのページの頭の題名を変えると dbSetTitle の1回（pageSetTitle でない）', T, async () => {
  const l = await openDb();
  try {
    const tt = $(l, 'pTitle');
    tt.focus(); tt.textContent = 'あたらしい台帳'; tt.dispatchEvent({ type: 'blur' }); await l.drain(300);
    assert.deepStrictEqual(l.called('dbSetTitle').map((c) => c.args), [[l.id, 'あたらしい台帳']]);
    assert.deepStrictEqual(l.called('pageSetTitle'), [], 'データベースの題名を pageSetTitle で書いた');
    assert.strictEqual(l.call('db.get', { id: l.id }).title, 'あたらしい台帳');
  } finally { l.done(); }
});

// ---- DL-1 (2b-2)（決めたこと 56・DQ4・DQ9・R116）: サイドバーと本文の間を引っ張る
const PG_TYPE = 'application/x-natsu-page';
const sideRow = (l, id) => [...$(l, 'plist').querySelectorAll('.pitem')].find((e) => e.dataset.pid === id);
const pageDt = () => { const data = {}; return { data, effectAllowed: '', setData: (k, v) => { data[k] = v; }, types: [PG_TYPE] }; };
test('DL-1 (2b)・F146（決めたこと 56 (1)・DQ9）: サイドバーの別の親のデータベースを白紙のページの本文へ落とす → pageMove(id, 開いているページ, undefined, { afterId }) の1回で落とした所に 🗃️ の行。開いているページとその祖先は落とせない（印を出さない）', T, async () => {
  const l = await openDb({ before: (call, d) => {
    const s = linkSetup(call, d);
    const Q = call('page.create', {}).id;
    call('page.setTitle', { id: Q, title: 'うえの頁' });   // 白紙のページの題名（D77 の会議の題名でない）
    call('page.move', { id: s.P, parentId: Q });
    return { ...s, Q };
  } });
  try {
    l.fire('onPageOpen', l.P); await l.drain(300);
    const box = $(l, 'pNote');
    box.querySelectorAll('.blk').forEach((e, i) => { e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: 100, right: 200, width: 100 }); });
    const tryDrop = async (id) => {
      const dt = pageDt();
      sideRow(l, id).dispatchEvent({ type: 'dragstart', target: sideRow(l, id), clientX: 100, dataTransfer: dt });
      const over = { preventDefault() { this.defaultPrevented = true; }, clientY: 12, clientX: 100, dataTransfer: dt };
      box.ondragover(over);
      const ok = over.defaultPrevented === true && box.querySelectorAll('.dropmark').length === 1;
      if (ok) { await box.ondrop({ preventDefault() {}, clientY: 12, clientX: 100, dataTransfer: dt }); await l.drain(); await l.drain(300); }
      else sideRow(l, id).dispatchEvent({ type: 'dragend' });
      return ok;
    };
    assert.strictEqual(await tryDrop(l.Q), false, '開いているページの祖先を本文に落とせる形');
    assert.deepStrictEqual(l.called('pageMove'), []);
    assert.strictEqual(await tryDrop(l.id), true, '別の親のデータベースを本文に落とせない');
    assert.deepStrictEqual(l.called('pageMove').map((c) => c.args), [[l.id, l.P, undefined, { afterId: l.b1 }]]);
    const blocks = l.call('page.get', { id: l.P }).page.blocks;
    assert.deepStrictEqual(blocks.map((b) => (b.type === 'subpage' ? b.page : b.id)), [l.b1, l.id, l.b2], '落とした所に行が無い');
    assert.strictEqual(l.call('pages.list', {}).find((p) => p.id === l.id).parentId, l.P, '親が開いているページにならない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
test('DL-1 (2b)・F146（決めたこと 56 (2)）: 本文のインラインの表の ⠿ をサイドバーのほかの白紙のページへ落とす → pageMove の1回・元の本文に行が無い・新しい親の本文の最後に inline の無い行', T, async () => {
  const l = await openDb({ before: (call, d) => {
    const s = linkSetup(call, d);
    const D = call('db.create', { parentId: s.P, inline: s.b1 }).id;
    const Q = call('page.create', {}).id;
    call('page.setTitle', { id: Q, title: 'となりの頁' });   // 白紙のページの題名（D77 の会議の題名でない）
    return { ...s, D, Q };
  } });
  try {
    l.fire('onPageOpen', l.P); await l.drain(300);
    const el = bodyRow(l, l.b1);
    const dt = pageDt();
    el.dispatchEvent({ type: 'dragstart', target: el, clientX: 10, dataTransfer: dt });
    assert.strictEqual(dt.data[PG_TYPE], l.D, '本文の子ページの行の引っ張りにページの印を置かない');
    let prevented = false;
    sideRow(l, l.Q).dispatchEvent({ type: 'dragover', clientY: 15, dataTransfer: dt, preventDefault() { prevented = true; } });
    assert.ok(prevented, 'サイドバーに落とせない形');
    sideRow(l, l.Q).dispatchEvent({ type: 'drop', clientY: 15, dataTransfer: dt, preventDefault() {} });
    await l.drain(); await l.drain(400);
    assert.deepStrictEqual(l.called('pageMove').map((c) => c.args), [[l.D, l.Q, undefined]]);
    assert.ok(!l.call('page.get', { id: l.P }).page.blocks.some((b) => b.type === 'subpage' && b.page === l.D), '元の本文に行が残る');
    const nb = l.call('page.get', { id: l.Q }).page.blocks;
    assert.ok(nb.length && nb[nb.length - 1].type === 'subpage' && nb[nb.length - 1].page === l.D && nb[nb.length - 1].inline !== true, '新しい親の本文の最後に inline の無い行が無い');
    assert.ok(!hostOf(l, l.b1), '元の本文に表が残る');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---- DL-1 (3)（R111 の (3)・R104 (3)(4)・MQ1）: 題名のセルの Alt+→・Alt+←・選びの窓の Ctrl+Enter・近道の表
test('DL-1 (3)・F147（R104 (3)）: 題名のセルを選んで Alt+→ で子のある閉じた行を開き、Alt+← で閉じる（子の無い行・題名でないセル・書いている間は何もしない）', T, async () => {
  const l = await openDb({ before: (call, d) => {
    call('db.setSub', { db: d.id, on: true });
    const sub = call('db.get', { id: d.id }).sub;
    call('rel.link', { db: d.id, id: d.rows[0], col: sub.kids, ids: [d.rows[1]] });
    return { sub };
  } });
  try {
    const [r0, r1, r2] = l.rows;
    const ids = () => dataRows(l).map((r) => r.dataset.id);
    assert.deepStrictEqual(ids(), [r0, r2], '閉じた親の子が出る');
    await selectOnly(l, r0, 'title');
    const n = views(l).length;
    await press(l, active(l), { key: 'ArrowRight', code: 'ArrowRight', altKey: true }); await l.drain(200);
    assert.deepStrictEqual(ids(), [r0, r1, r2], 'Alt+→ で子が出ない');
    assert.deepStrictEqual(l.called('dbView').slice(-1)[0].args[5], [r0], 'db.view の open に入らない');
    assert.strictEqual(cellOf(l, r0, 'title').querySelector('.dbsubtog').getAttribute('aria-expanded'), 'true');
    await press(l, cellOf(l, r0, 'title'), { key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }); await l.drain(200);
    assert.deepStrictEqual(ids(), [r0, r2], 'Alt+← で閉じない');
    // 子の無い行・題名でないセルでは何もしない（読み直さない・セルは動かない）
    await selectOnly(l, r2, 'title');
    const m = views(l).length;
    await press(l, active(l), { key: 'ArrowRight', code: 'ArrowRight', altKey: true }); await l.drain(200);
    await selectOnly(l, r0, l.c1);
    await press(l, active(l), { key: 'ArrowRight', code: 'ArrowRight', altKey: true }); await l.drain(200);
    assert.ok(active(l) && active(l).dataset.col === l.c1, '題名でないセルの Alt+→ でセルが動いた');
    // 書いている間（題名のセルの書き手）は Alt+→ で開かない
    await selectOnly(l, r0, 'title');
    await press(l, active(l), { key: 'Enter', code: 'Enter' });
    await press(l, editor(l), { key: 'ArrowRight', code: 'ArrowRight', altKey: true }); await l.drain(200);
    await press(l, editor(l), { key: 'Escape' });
    assert.strictEqual(views(l).length, m, '子の無い行・題名でないセル・書いている間に読み直した');
    assert.deepStrictEqual(ids(), [r0, r2]);
    assert.ok(n > 0);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
test('DL-1 (3)・F147（R104 (3)）: リレーションの選びの窓の行で Ctrl+Enter → その行のページが今のタブに開く（つなぐ・外すはしない）。［新しい行を作ってつなぐ］と探す欄の Ctrl+Enter は何もしない', T, async () => {
  const l = await relDb();
  try {
    const r1 = l.rows[1];
    await clickEl(l, cellOf(l, r1, l.rc), 200);
    const q = picker(l).querySelector('input');
    const n = tabKeys(l).length;
    await press(l, q, { key: 'Enter', code: 'Enter', ctrlKey: true }); await l.drain(100);
    const newOpt = pickOpts(l).find((b) => b.textContent === '新しい行を作ってつなぐ');
    await press(l, newOpt, { key: 'Enter', code: 'Enter', ctrlKey: true }); await l.drain(100);
    assert.deepStrictEqual([l.called('relLink').length, tabOnKey(l)], [0, `page:${l.id}`], '探す欄・［新しい行を作ってつなぐ］の Ctrl+Enter で何かした');
    await press(l, pickOpts(l)[0], { key: 'Enter', code: 'Enter', ctrlKey: true }); await l.drain(300);
    assert.deepStrictEqual([tabKeys(l).length, tabOnKey(l)], [n, `page:${l.b1}`], 'Ctrl+Enter でその行のページが今のタブに開かない');
    assert.deepStrictEqual([l.called('relLink'), l.called('relUnlink')], [[], []], 'Ctrl+Enter でつないだ・外した');
    assert.deepStrictEqual(cellsIn(l, r1).cells[l.rc] || [], [], 'セルが変わった');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
test('DL-1 (3)（MQ1・R104 (4)）: 近道の表に Alt+→・Alt+← と Ctrl+Enter（新しい効く所「リレーションの行を探す窓」）の2行・Shift+F10 の説明', () => {
  const { SHORTCUTS } = require('../src/shortcuts');
  const row = (keys) => SHORTCUTS.find((r) => r.keys === keys && r.where !== 'サイドバーのページの一覧' && r.where !== '要約の行を直しているとき');
  assert.deepStrictEqual(SHORTCUTS.filter((r) => r.keys === 'Alt+→・Alt+←').map((r) => [r.what, r.where]), [['サブアイテムを開く・閉じる（題名のセルで）', 'データベースの表のセルを選んでいるとき']]);
  assert.deepStrictEqual(SHORTCUTS.filter((r) => r.where === 'リレーションの行を探す窓').map((r) => [r.keys, r.what]), [['Ctrl+Enter', 'その行のページを開く（つなぐ・外すはしない）']]);
  assert.strictEqual(SHORTCUTS.find((r) => r.keys === 'Shift+F10' && r.where === 'サイドバーのページの一覧').what, '行のメニューを開く（中にページを作る・中にデータベースを作る・移動先・新しいタブで開く・削除）');
  assert.ok(row('Alt+→・Alt+←'));
});

// ---------------------------------------------------------------- R119 (a)（rv51 の点検の M4。R106・R117 (e) で残した軽微）
const fnOfApp = (name) => {
  const at = HTML.search(new RegExp(`\\n  (?:async )?function ${name}\\(`)) + 1;
  assert.ok(at > 0, `app.html に ${name} が無い`);
  return HTML.slice(at, HTML.indexOf('\n  }\n', at) + 4);
};
test('R119 (a)・M4: 開いたサブアイテムの行は 2,000 まで覚える（2,001 個目を開くと、いちばん古く開いた行から閉じる。開き直した行は新しい）', () => {
  const subOpenAdd = new Function(`${fnOfApp('subOpenAdd')}\nreturn subOpenAdd;`)();   // eslint-disable-line no-new-func
  const ids = Array.from({ length: 2001 }, (_, i) => `r${i}`);
  const set = new Set();
  for (const id of ids.slice(0, 2000)) subOpenAdd(set, id);
  assert.strictEqual(set.size, 2000, '2,000 までは閉じない');
  assert.ok(set.has('r0'));
  subOpenAdd(set, 'r0');   // 開き直すと新しい側へ
  subOpenAdd(set, ids[2000]);
  assert.strictEqual(set.size, 2000, '2,001 個目で 2,000 に戻らない（db.view の open は 2,000 まで: 越えると断られて表が止まる）');
  assert.ok(!set.has('r1'), 'いちばん古く開いた行（r1）が閉じていない');
  assert.ok(set.has('r0') && set.has('r2') && set.has(ids[2000]), '新しく開いた行・開き直した行が残っていない');
  assert.strictEqual([...set][set.size - 1], ids[2000], '最後に開いた行が並びの末でない');
});
test('R119 (a)・M4: ▸・Alt+→（dbSubKey は dbSubToggle を通る）・［サブアイテムを足す］の開く道は、どれも subOpenAdd で 2,000 までに抑える（字面で見る: 偽の DOM で 2,001 の親を開くのは重い）', () => {
  const toggle = fnOfApp('dbSubToggle');
  assert.match(toggle, /subOpenAdd\(set, rowId\)/, 'dbSubToggle が subOpenAdd を通らない');
  assert.match(fnOfApp('dbSubKey'), /return dbSubToggle\(rowId, on\);/, 'Alt+→（dbSubKey）が dbSubToggle を通らない');
  assert.match(fnOfApp('dbSubAdd'), /subOpenAdd\(dbSubOpen\(st\), rowId\)/, '［サブアイテムを足す］が subOpenAdd を通らない');
  const script = HTML.slice(HTML.indexOf('<script>'));
  assert.deepStrictEqual([...script.matchAll(/dbSubOpen\([^)]*\)\.add\(|\bset\.add\(rowId\)/g)].map((m) => m[0]), [], '開いた行の並びに subOpenAdd を通らずに足す所がある');
});
