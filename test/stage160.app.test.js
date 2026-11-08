/*
 * stage160.app.test.js — 0.16.0「データベース」の画面（計画 docs/plans/2026-11-04-160.md の Task DV-1 から）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。DB の命令は一時の DB（helpers/dbtmp）に本当に通し、
 * 画面との口は本物の src/preload.js を vm で動かして使う（命令の引数の形・元に戻すの歩みの知らせ（データベースの命令は args.db の歩み: 決めたこと 47）が本物と同じ）。
 * DV-1（D1・D2・F139・F143・F144）: データベースのページはタブと表だけ・見える行だけを描く・同じ印では描き直さない・表のキー・行を足す・選ぶ・消す・並べる・Ctrl+Z。
 * データベース・列・行の名前は作った物で、実在の人名・社名は使わない。
 */
'use strict';
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
    for (let i = 0; i < o.many; i += 1) list.push({ op: 'add', id: `rz${i}`, row: ops.rowBlock({ id: `rz${i}`, db: id, ord: `z${String(i).padStart(5, '0')}`, title: `行 ${i}`, cells: { [c1]: `メモ ${i}` }, by: { c: 'me', u: 'me' }, no: 10 + i, at: new Date(clock).toISOString() }) });
    db.exec('BEGIN'); ops.applyOps(db, list); db.exec('COMMIT');
  }
  const more = o.before ? o.before(call, { id, c1, c2, c3, c4, rows }) || {} : {};
  let L = null;
  const steps = [];
  const K = realPreload(db, (s) => { steps.push(s); if (L) L.fire('onEditStep', s); });
  const returns = { copy: () => true, linkBase: () => 'https://example.invalid/open#p=', openLink: () => true };
  for (const n of DB_APIS) returns[n] = (...a) => K[n](...a);
  Object.assign(returns, o.returns || {});
  const l = await load(APP, { caret: true, returns });
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
    assert.ok(box(l).querySelectorAll('.dbcolh').some((h) => h.textContent === '<b>列</b>' && h.childNodes.length === 1));
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
    assert.strictEqual(editor(l), null);
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
    assert.deepStrictEqual(items(l).map((b) => b.textContent), ['テキスト', '数値', '選択', '複数選択', 'ステータス', '日付', 'ユーザー', 'チェック', 'URL', 'メール', '電話']);
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
    assert.strictEqual(picker(l), null);
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
    assert.strictEqual(picker(l), null);
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
    assert.strictEqual(picker(l), null);
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
    assert.strictEqual(menu(l), null);
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
