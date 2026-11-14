/* stage170.icons.app.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）のアイコンの画面
 *  IV-1（決めたこと 7・19〜21・F180・F181・F185・F186）: 偽の DOM の createElementNS・描く部品 iconEl（SVG の線の絵・currentColor・同じ絵は写す）と、
 *        アイコンが出る所の全部（サイドバー・ライブラリ・タブ・パンくずと「…」・ページの頭・検索・ゴミ箱・移動先・新しいページ・子ページの行・行の無い子・
 *        議事録の子ページ・インラインの表の頭・リストの行・リレーションのセル・記録中のパンくず）が pageIconOf の値（data-icon）で同じ絵
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。データベースの所は一時の DB（helpers/dbtmp）に本当に通す（本物の preload を vm で）。
 * 題名は作った物（titleAt か D77 の注）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { load } = require('./helpers/simrun.js');
const { titleAt } = require('./helpers/titles');
const { tmpDb } = require('./helpers/dbtmp');
const { Element, parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');
const core = require('../src/db/core');
const P = require('../src/pageIcons');
const PATHS = require('../src/pageIconPaths');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
const HTML = fs.readFileSync(APP, 'utf8');
const PRE = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const SVG_NS = 'http://www.w3.org/2000/svg';
const T = { timeout: 60000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const MIC = 'ic:mic';
const DOC = 'ic:certification_with_seal';
const TBL = 'ic:table_chart';

// 描いたアイコン（.pgi）の値。el が .pgi ならそれ、でなければ中の最初の .pgi。無ければ null
const iconOf = (el) => {
  if (!el) return null;
  const g = el.classList && el.classList.contains('pgi') ? el : el.querySelector('.pgi');
  return g ? g.getAttribute('data-icon') : null;
};

// 見本（決まった返事）: 最上位の議事録 pa2（ic:groups）・その中の白紙のページ k1（🚀・本文に子 g1 の行）・白紙のページ g1（アイコン無し）・
// 議事録 pa1（アイコン無し）・白紙のページ q9（ic:star。子 z1 は本文に行が無い: 行の無い子）・データベース d1（アイコン無し）とその行のページ r1
const AT = (d) => `2026-10-${d}.000Z`;
const ROW = (id, createdAt, o = {}) => ({ id, title: titleAt(createdAt), date: createdAt.slice(0, 10), durationSec: 600, hasSummary: true, createdAt, parentId: null, ord: 'i', ...o });
const LIST = () => [
  ROW('g1', AT('21T08:00:00'), { parentId: 'k1', kind: 'blank' }),
  ROW('k1', AT('21T06:00:00'), { parentId: 'pa2', kind: 'blank', icon: '🚀' }),
  ROW('pa2', AT('21T00:00:00'), { icon: 'ic:groups' }),
  ROW('pa1', AT('20T00:00:00')),
  ROW('q9', AT('19T00:00:00'), { kind: 'blank', icon: 'ic:star' }),
  ROW('z1', AT('19T01:00:00'), { parentId: 'q9', kind: 'blank' }),
  ROW('d1', AT('18T00:00:00'), { kind: 'database' }),
];
const PAGE = (id, list) => {
  const p = list.find((x) => x.id === id);
  if (!p) return null;
  const blocks = id === 'k1' ? [{ id: 'b1', type: 'paragraph', text: '本文の行' }, { id: 'b2', type: 'subpage', text: '', page: 'g1' }] : [];
  return { page: { id, title: p.title, date: p.date, createdAt: p.createdAt, durationSec: 600, blocks, memo: '', meetingType: 'general', ...(p.parentId ? { parentId: p.parentId } : {}), ...(p.kind ? { kind: p.kind } : {}), ...(p.icon ? { icon: p.icon } : {}) }, segments: [] };
};
async function boot(o = {}) {
  let list = o.list || LIST();
  const l = await load(APP, { returns: {
    pagesSearch: () => list, pageGet: (id) => PAGE(id, list),
    pageSetIcon: (id, icon) => { list = list.map((p) => (p.id === id ? (icon ? { ...p, icon } : (({ icon: _i, ...rest }) => rest)(p)) : p)); return PAGE(id, list).page; },
    linkBase: () => 'https://example.invalid/open#p=',
    ...(o.returns || {}) } });
  await l.drain();
  return l;
}
const open = async (l, id) => { l.fire('onPageOpen', id); await l.drain(); };
const rowOf = (l, id) => $(l, 'plist').querySelectorAll('.pitem').find((r) => r.dataset.pid === id);
const tabOf = (l, id) => $(l, 'tabbar').querySelectorAll('.tabitem').find((t) => t.dataset.key === `page:${id}`);

// ---------------------------------------------------------------- IV-1・F185
test('IV-1・F185: 偽の DOM の createElementNS（名前空間・setAttribute・cloneNode(true) で子も写る・textContent は空）', async () => {
  const l = await boot();
  const dom = require('./helpers/dom');
  for (const make of [(ns, t) => l.document.createElementNS(ns, t), (ns, t) => new dom.Doc().createElementNS(ns, t)]) {
    const svg = make(SVG_NS, 'svg');
    assert.strictEqual(svg.namespaceURI, SVG_NS);
    svg.setAttribute('viewBox', '0 0 24 24');
    const p = make(SVG_NS, 'path');
    p.setAttribute('d', 'M0 0H24V24Z');
    svg.appendChild(p);
    const c = svg.cloneNode(true);
    assert.strictEqual(c.namespaceURI, SVG_NS);
    assert.strictEqual(c.getAttribute('viewBox'), '0 0 24 24');
    assert.strictEqual(c.childNodes.length, 1, '深い写しで子が写らない');
    assert.strictEqual(c.childNodes[0].getAttribute('d'), 'M0 0H24V24Z');
    assert.strictEqual(c.childNodes[0].namespaceURI, SVG_NS);
    assert.ok(c !== svg && c.childNodes[0] !== p, '写しが元と同じ要素');
    assert.strictEqual(c.textContent, '');
  }
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- IV-1・F181・F186
test('IV-1・F181・F186: iconEl（ic: は SVG の名前空間の svg と path・塗りは currentColor・viewBox は表の値・大きさは行 16 とページの頭 64・aria-hidden・focusable="false"・id が無い。絵文字は textContent。同じ絵は 2 回目から写す）', T, async () => {
  const many = Array.from({ length: 30 }, (_, i) => ROW(`m${i}`, AT(`1${i % 9}T0${i % 6}:00:00`), { kind: 'blank', title: `白紙の${i}` }));   // 白紙のページの題名（会議の題名でないので日付の形にしない: D77 の外）
  const l = await boot({ list: [...LIST(), ...many] });
  await open(l, 'g1');
  const head = $(l, 'pIcon').querySelector('.pgi');
  assert.ok(head, 'ページの頭に .pgi が無い');
  assert.deepStrictEqual([head.getAttribute('data-icon'), head.getAttribute('aria-hidden')], [DOC, 'true']);
  const svg = head.querySelector('svg');
  assert.ok(svg, 'ページの頭に svg が無い');
  assert.strictEqual(svg.namespaceURI, SVG_NS, 'svg を HTML の名前空間で作った');
  const want = PATHS.icons.certification_with_seal;
  assert.deepStrictEqual([svg.getAttribute('viewBox'), svg.getAttribute('fill'), svg.getAttribute('width'), svg.getAttribute('height'), svg.getAttribute('focusable'), svg.getAttribute('aria-hidden')],
    [want.vb, 'currentColor', '64', '64', 'false', 'true']);
  const paths = svg.querySelectorAll('path');
  assert.deepStrictEqual(paths.map((p) => [p.namespaceURI, p.getAttribute('d'), p.getAttribute('fill-rule')]), want.p.map(([d, eo]) => [SVG_NS, d, eo ? 'evenodd' : null]));
  assert.strictEqual(head.textContent, '', 'ic: のアイコンに字がある');
  // 行は 16
  const rowSvg = rowOf(l, 'pa1').querySelector('.pi svg');
  assert.deepStrictEqual([iconOf(rowOf(l, 'pa1').querySelector('.pi')), rowSvg.getAttribute('width'), rowSvg.getAttribute('height'), rowSvg.getAttribute('viewBox')], [MIC, '16', '16', PATHS.icons.mic.vb]);
  // id を持つ要素を作らない（同じ画面に何度も置いても重ならない）
  for (const s of l.document.querySelectorAll('.pgi')) assert.deepStrictEqual(s._walk([]).filter((e) => e.id), [], 'アイコンの中に id');
  // 絵文字は textContent（svg は無い）
  await open(l, 'k1');
  const emo = $(l, 'pIcon').querySelector('.pgi');
  assert.deepStrictEqual([emo.getAttribute('data-icon'), emo.textContent, emo.querySelector('svg')], ['🚀', '🚀', null]);
  // 同じ名前と大きさの svg は1回だけ組み、ほかは写す（30 の白紙のページの行で svg を 30 回作らない）
  const made = (l.createdNS || []).filter((e) => e.tagName === 'svg').length;
  const shown = l.document.querySelectorAll('svg').length;
  assert.ok(shown >= 30, `描いた svg が少ない（${shown}）`);
  assert.ok(made <= 8, `svg を ${made} 回組んだ（写していない）`);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- IV-1・F180
test('IV-1・F180: どこも同じ値（サイドバー・タブの .ti・パンくずの段と今のページ・ページの頭・子ページの行・行の無い子・議事録の子ページ・検索の結果・ライブラリ・移動先・新しいページ・ゴミ箱が pageIconOf の値。文字の所は字のまま）', T, async () => {
  const heads = [{ id: 'tr1', title: '捨てた白紙', kind: 'blank', trashedAt: '2026-10-22T00:00:00.000Z', count: 0 }, { id: 'tr2', title: titleAt('2026-10-23T00:00:00.000Z'), trashedAt: '2026-10-23T00:00:00.000Z', count: 0 }];   // 白紙のページの題名（D77 の外）
  const l = await boot({ returns: { uiState: () => ({ tree: { open: ['pa2', 'k1', 'q9'] } }), pagesTrash: () => heads } });
  await open(l, 'pa2');
  for (const id of ['g1', 'pa1', 'd1']) { rowOf(l, id).dispatchEvent({ type: 'click', ctrlKey: true }); await l.drain(); }
  await open(l, 'k1');
  const exp = (id) => P.pageIconOf(LIST().find((p) => p.id === id));
  // サイドバー（子のある行は ▸ の下の .pe・無い行は .pi）
  const rowIcon = (id) => { const r = rowOf(l, id); return iconOf(r.querySelector('.pe') || r.querySelector('.pi')); };
  assert.deepStrictEqual(['pa2', 'k1', 'g1', 'pa1', 'q9', 'z1', 'd1'].map(rowIcon), ['ic:groups', '🚀', DOC, MIC, 'ic:star', DOC, TBL], 'サイドバーの行');
  assert.deepStrictEqual(['pa2', 'k1', 'g1', 'pa1', 'q9', 'z1', 'd1'].map(rowIcon), ['pa2', 'k1', 'g1', 'pa1', 'q9', 'z1', 'd1'].map(exp));
  assert.strictEqual(rowOf(l, 'pa1').querySelector('.t').textContent, LIST().find((p) => p.id === 'pa1').title, '題名の字');
  // タブ（.tt の前の .ti。CSS の attr では描かない）
  const ptabs = $(l, 'tabbar').querySelectorAll('.tabitem').filter((t) => t.dataset.key.startsWith('page:'));
  assert.ok(['g1', 'k1', 'pa1'].every((id) => tabOf(l, id)), '前提: 開いたタブ');
  for (const t of ptabs) assert.strictEqual(iconOf(t.querySelector('.ti')), exp(t.dataset.key.slice(5)), `タブ ${t.dataset.key}`);
  assert.deepStrictEqual(['k1', 'g1', 'pa1'].map((id) => iconOf(tabOf(l, id).querySelector('.ti'))), ['🚀', DOC, MIC], 'タブ');
  assert.strictEqual(tabOf(l, 'pa1').querySelector('.tt').textContent, LIST().find((p) => p.id === 'pa1').title, 'タブの字');
  assert.strictEqual(tabOf(l, 'pa1').querySelector('.tt').getAttribute('data-icon'), null, 'タブの字に data-icon が残る');
  const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
  assert.ok(!S.declsFor(rules, '.tabitem[data-key^="page:"] .tt::before', { at: '' }).content, 'タブのアイコンを CSS の attr で描いている');
  // パンくず（祖先の段と今のページ）・ページの頭
  assert.deepStrictEqual($(l, 'crumb').querySelectorAll('.csi').map(iconOf), ['ic:groups'], 'パンくずの段');
  assert.strictEqual(iconOf($(l, 'crumb').querySelector('.ci')), '🚀', 'パンくずの今のページ');
  assert.strictEqual($(l, 'crumb').querySelector('.ct').textContent, LIST().find((p) => p.id === 'k1').title);
  assert.strictEqual(iconOf($(l, 'pIcon')), '🚀', 'ページの頭');
  // 白紙のページの本文の子ページの行（g1 はアイコン無し → 書類）。字は題名
  const sub = $(l, 'pNote').querySelectorAll('.blk').find((e) => e._b && e._b.type === 'subpage');
  assert.strictEqual(iconOf(sub._txt), DOC, '子ページの行');
  assert.strictEqual(sub._txt.textContent.trim(), LIST().find((p) => p.id === 'g1').title, '子ページの行の字');
  // 行の無い子（q9 の子 z1）
  await open(l, 'q9');
  assert.deepStrictEqual($(l, 'bodyKids').querySelectorAll('.kidrow').map(iconOf), [DOC], '行の無い子');
  assert.deepStrictEqual($(l, 'bodyKids').querySelectorAll('.kidrow').map((e) => e.textContent.trim()), [LIST().find((p) => p.id === 'z1').title]);
  // 議事録の子ページの一覧（pa2 の子 k1）
  await open(l, 'pa2');
  $(l, 'paneBtnNote').dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual($(l, 'pKids').querySelectorAll('.kidrow').map(iconOf), ['🚀'], '議事録の子ページの一覧');
  // 移動先（「···」の［移動先…］の候補）
  $(l, 'pMore').dispatchEvent({ type: 'click' }); await l.drain();
  $(l, 'pMenu').querySelectorAll('.mitem').find((b) => b.textContent === '移動先…').dispatchEvent({ type: 'click' }); await l.drain();
  const mv = $(l, 'moveList').querySelectorAll('.mvopt').filter((e) => e.dataset.pid);
  assert.ok(mv.length > 0, '移動先の候補が無い');
  for (const e of mv) assert.strictEqual(iconOf(e.querySelector('.mvi')), exp(e.dataset.pid), `移動先 ${e.dataset.pid}`);
  l.key({ key: 'Escape' }, $(l, 'moveSearch')); await l.drain();
  // 検索の結果の頭
  $(l, 'sideSearch').dispatchEvent({ type: 'click' }); await l.drain();
  const pal = new Map($(l, 'palList').querySelectorAll('.pitem').map((e) => [e.dataset.pid, iconOf(e.querySelector('.pi'))]));
  for (const id of ['pa2', 'k1', 'g1', 'pa1', 'q9', 'd1']) assert.strictEqual(pal.get(id), exp(id), `検索 ${id}`);
  l.key({ key: 'Escape' }); await l.drain();
  // 新しいページ（Ctrl+Shift+N）: 字は頭の絵文字を外した名前・前にアイコン
  l.key({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }); await l.drain();
  const nw = $(l, 'newList').querySelectorAll('.mitem');
  assert.deepStrictEqual(nw.map((b) => [b.textContent, iconOf(b)]), [['白紙のページ', DOC], ['議事録（録音の前のページ）', MIC], ['データベース', TBL]], '新しいページの項目');
  l.key({ key: 'Escape' }, $(l, 'newList')); await l.drain();
  // ゴミ箱の行
  $(l, 'tabBtnTrash').dispatchEvent({ type: 'click' }); await l.drain();
  const tr = $(l, 'trashList').querySelectorAll('.tprow');
  assert.deepStrictEqual(tr.map((r) => iconOf(r.querySelector('.tpt'))), [DOC, MIC], 'ゴミ箱の行');
  assert.deepStrictEqual(tr.map((r) => r.querySelector('.tpt').textContent.trim()), ['捨てた白紙', heads[1].title], 'ゴミ箱の行の字');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('IV-1・F180: パンくずの「…」の一覧と記録中のパンくずとライブラリのアイコン', T, async () => {
  // 6 段の白紙のページ（白紙のページの題名: D77 の外）
  const deep = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map((id, i) => ROW(id, AT(`1${i}T00:00:00`), { kind: 'blank', title: `段${i + 1}`, parentId: i ? `e${i}` : null, ...(i === 1 ? { icon: 'ic:star' } : {}) }));
  let prep = false;
  const l = await boot({ list: [...LIST(), ...deep], returns: {
    uiState: () => ({ tabs: { open: ['library', 'page:e6'], active: 'page:e6' } }),
    meetingPrepare: () => { prep = true; return { ok: true }; },
    meetingStatus: () => ({ active: false, finalizing: false, memo: '', segments: [], pending: 0, prep: prep ? { memo: '', meetingType: null } : null }),
  } });
  await open(l, 'e6');
  const more = $(l, 'crumb').querySelector('.cmore');
  assert.ok(more, '「…」が無い');
  more.dispatchEvent({ type: 'click' }); await l.drain();
  const box = l.document.querySelectorAll('.treemenu').find((b) => b.getAttribute('aria-label') === '隠れた段');
  assert.ok(box, '隠れた段の一覧が無い');
  const items = box.querySelectorAll('.mitem');
  assert.deepStrictEqual(items.map((b) => [iconOf(b), b.textContent]), [['ic:star', '段2'], [DOC, '段3'], [DOC, '段4']], '「…」の一覧（字は題名だけ）');
  l.key({ key: 'Escape' }, box); await l.drain();
  // ライブラリの行
  $(l, 'tabbar').querySelectorAll('.tabitem').find((t) => t.dataset.key === 'library').dispatchEvent({ type: 'click' }); await l.drain();
  const lib = $(l, 'libRows').querySelectorAll('.lib-row');
  assert.ok(lib.length > 0, 'ライブラリの行が無い');
  for (const r of lib) assert.strictEqual(iconOf(r.querySelector('.pi')), P.pageIconOf([...LIST(), ...deep].find((p) => p.id === r.dataset.pid)), `ライブラリ ${r.dataset.pid}`);
  // 記録中のタブ（録音の前のページ）のパンくずは議事録の既定（マイク）
  $(l, 'mtToggleBtn').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(iconOf($(l, 'crumb').querySelector('.ci')), MIC, '記録中のパンくず');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('IV-1: 描き直し（アイコンを変えると、サイドバー・タブ・パンくず・ページの頭がすぐ同じ値になる: A-09・L-13）', T, async () => {
  const l = await boot();
  await open(l, 'g1');
  rowOf(l, 'pa1').dispatchEvent({ type: 'click', ctrlKey: true }); await l.drain();
  await open(l, 'g1');
  assert.strictEqual(iconOf($(l, 'pIcon')), DOC);
  $(l, 'pIcon').dispatchEvent({ type: 'click' }); await l.drain();
  const pick = $(l, 'iconList').querySelectorAll('.icopt').find((b) => b.textContent === '🚀') || $(l, 'iconList').querySelectorAll('.icopt')[0];
  const v = pick.textContent;
  pick.dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual([iconOf($(l, 'pIcon')), iconOf($(l, 'crumb').querySelector('.ci')), iconOf(tabOf(l, 'g1').querySelector('.ti')), iconOf(rowOf(l, 'g1').querySelector('.pi'))], [v, v, v, v]);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- 本物の DB で（データベースの所・写し）
let clock = Date.parse('2026-11-14T01:00:00.000Z');
const ctx = { now: () => new Date(clock), labels: {} };
let txn = 0;
function realPreload(db) {
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
  exposed.koeApp.onEditStep(() => {});
  return exposed.koeApp;
}
const DB_APIS = [...PRE.matchAll(/^ {2}(\w+): \([^)]*\) => dbCall\(/gm)].map((m) => m[1]);
async function realApp(before) {
  const t = tmpDb();
  const { db } = t.open();
  const call = (cmd, args) => {
    clock += 1000;
    const r = core.call(db, { role: 'app', cmd, args, tx: `a:iv1-${String(++txn).padStart(6, '0')}` }, ctx);
    if (!r.ok) throw new Error(`${cmd}: ${r.code}`);
    return r.result;
  };
  const made = before(call);
  const K = realPreload(db);
  const copies = [];
  const returns = { copy: (s) => { copies.push(s); return true; }, linkBase: () => 'https://example.invalid/open#p=', openLink: () => true };
  for (const n of DB_APIS) returns[n] = (...a) => K[n](...a);
  const l = await load(APP, { caret: true, returns });
  Object.assign(l, { t, db, call, made, copies, done: () => t.done() });
  await l.drain();
  return l;
}

test('IV-1・F180: データベースの所（インラインの表の頭はそのデータベースのアイコン・リストの行とリレーションのセルは行のページの既定・検索の「場所:」の後ろはデータベースのアイコンで字は今のまま）', T, async () => {
  const l = await realApp((call) => {
    const top = call('page.create', {}).id;
    call('page.setTitle', { id: top, title: '計画の親' });   // 白紙のページの題名（D77 の外）
    const d1 = call('db.create', { parentId: top }).id;   // 本文の行（インライン）
    call('page.setTitle', { id: d1, title: '取引先' });   // データベースの題名（D77 の外）
    const d2 = call('db.create', { parentId: top }).id;
    call('page.setTitle', { id: d2, title: '案件' });   // データベースの題名（D77 の外）
    call('page.setIcon', { id: d2, icon: 'ic:star' });
    const r1 = call('row.add', { db: d1, title: '取引先 甲' }).id;   // 行の題名（D77 の外）
    const rel = call('col.add', { db: d2, type: 'rel', name: '相手', target: d1 }).col.id;
    const r2 = call('row.add', { db: d2, title: '案件 一' }).id;   // 行の題名（D77 の外）
    call('view.add', { db: d1, layout: 'list', name: '一覧' });
    call('rel.link', { db: d2, id: r2, col: rel, ids: [r1] });
    for (const id of [d1, d2]) {
      const page = call('page.get', { id: top }).page;
      const b = page.blocks.find((x) => x.type === 'subpage' && x.page === id);
      call('block.update', { pageId: top, blockId: b.id, patch: { inline: true } });
    }
    return { top, d1, d2, r1, r2, rel };
  });
  try {
    const { top, d1, d2, r1 } = l.made;
    l.fire('onPageOpen', top); await l.drain(80);
    const hosts = $(l, 'pNote').querySelectorAll('.dbinline');
    assert.strictEqual(hosts.length, 2, 'インラインの表が2つ無い');
    const headIcon = (db) => iconOf(hosts.find((h) => h._b && (h._b.page === db)).querySelector('.dbhead .dbicon'));
    assert.deepStrictEqual([headIcon(d1), headIcon(d2)], [TBL, 'ic:star'], 'インラインの表の頭');
    // リレーションのセル（相手の行のページの既定: 書類）。字は題名
    const chip = hosts.find((h) => h._b.page === d2).querySelectorAll('.dbrel')[0];
    assert.ok(chip, 'リレーションのセルが無い');
    assert.deepStrictEqual([iconOf(chip), chip.textContent.trim()], [DOC, '取引先 甲'], 'リレーションのセル');
    // リストの行（リストのビュー）
    l.fire('onPageOpen', d1); await l.drain(200);
    const vt = $(l, 'pDb').querySelectorAll('.dbtab');
    assert.strictEqual(vt.length, 2, '前提: ビューのタブが2つ無い');
    vt[1].dispatchEvent({ type: 'click' }); await l.drain(200);
    const listIcons = $(l, 'pDb').querySelectorAll('.dbrow').filter((r) => r.dataset.id === r1).map((r) => iconOf(r.querySelector('.dbicon')));
    assert.deepStrictEqual(listIcons, [DOC], 'リストの行');
    // 検索の「場所: <データベース名> ・ 」（行のページ）
    l.fire('onPagesUpdated'); await l.drain(120);
    $(l, 'sideSearch').dispatchEvent({ type: 'click' }); await l.drain(80);
    $(l, 'searchBox').value = '取引先 甲'; $(l, 'searchBox').dispatchEvent({ type: 'input' }); await l.clock.advance(300); await l.drain(120);
    const hit = $(l, 'palList').querySelectorAll('.pitem').find((e) => e.dataset.pid === r1);
    assert.ok(hit, '検索に行が無い');
    const s1 = hit.querySelector('.m span');
    assert.strictEqual(iconOf(s1), TBL, '場所: の後ろのデータベースのアイコン');
    assert.ok(s1.textContent.startsWith('場所: 取引先 ・ '), s1.textContent);
    assert.ok(!s1.textContent.includes('🗃️'), '場所: に 🗃️ の字が残る');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('IV-1・F179（R10）: 画面の写しに ic: の字が出ない（白紙のページの［コピー］の子ページの行は「📄 題名」・［リンクを写す］の1行・選んで写した text/plain と text/html）', T, async () => {
  const l = await realApp((call) => {
    const top = call('page.create', {}).id;
    call('page.setTitle', { id: top, title: '計画の親' });   // 白紙のページの題名（D77 の外）
    call('page.setIcon', { id: top, icon: MIC });
    const kid = call('page.create', { parentId: top }).id;
    call('page.setTitle', { id: kid, title: '週の予定' });   // 白紙のページの題名（D77 の外）
    call('page.setIcon', { id: kid, icon: 'ic:star' });
    return { top, kid };
  });
  try {
    const { top, kid } = l.made;
    l.fire('onPageOpen', top); await l.drain(80);
    const menu = () => { $(l, 'pMore').dispatchEvent({ type: 'click' }); return $(l, 'pMenu').querySelectorAll('.mitem'); };
    menu().find((b) => b.textContent === 'コピー').dispatchEvent({ type: 'click' }); await l.drain(80);
    menu().find((b) => b.textContent === 'リンクを写す').dispatchEvent({ type: 'click' }); await l.drain(80);
    const sub = $(l, 'pNote').querySelectorAll('.blk').find((e) => e._b && e._b.type === 'subpage' && e._b.page === kid);
    sub._txt.focus();
    l.key({ key: 'Escape' }, sub._txt);
    const data = {};
    l.key({ type: 'copy', clipboardData: { setData: (k, v) => { data[k] = v; } } });
    await l.drain();
    assert.strictEqual(l.copies.length, 2, '写していない');
    assert.ok(l.copies[0].includes('📄 週の予定'), l.copies[0]);
    assert.strictEqual(data['text/plain'], '📄 週の予定');
    for (const s of [...l.copies, data['text/plain'], data['text/html']]) {
      assert.ok(typeof s === 'string' && s.length > 0);
      for (const w of ['ic:', 'star', 'certification', 'mic']) assert.ok(!s.includes(w), `${w}: ${s}`);
    }
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
