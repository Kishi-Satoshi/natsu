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
const { parseHTML } = require('./helpers/simdom');
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
  if (o.before) o.before(call, { id, c1, c2, c3, c4 });
  let L = null;
  const steps = [];
  const K = realPreload(db, (s) => { steps.push(s); if (L) L.fire('onEditStep', s); });
  const returns = { copy: () => true, linkBase: () => 'https://example.invalid/open#p=' };
  for (const n of DB_APIS) returns[n] = (...a) => K[n](...a);
  const l = await load(APP, { caret: true, returns });
  L = l;
  Object.assign(l, { t, db, call, steps, id, c1, c2, c3, c4, rows, done: () => t.done() });
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
    assert.deepStrictEqual(items.map((b) => b.textContent), ['メモ'], '書ける列が並ばない（DV-1 は文字の列）');
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
