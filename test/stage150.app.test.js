/*
 * stage150.app.test.js — 0.15.0「ページの階層」の画面（計画 docs/plans/2026-11-03-150.md の Task PH-3〜）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。
 * PH-3（H2・F115・F117・F118）: サイドバーを木に（子のある行は閉じて描く・▸ で開け閉めして覚える・↑↓←→ で歩く・行の［＋］とメニュー・
 *       引っ張って中へ・前後へ動かす・選ぶ形の Shift の範囲は見えている行の順）。画面の pageTree の写しは src/pageTree.js と字も答えも同じ。
 * 題名は作った物（titleAt か D77 の注）。実在の人名・社名は使わない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { titleAt } = require('./helpers/titles');
const { parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');
const PT = require('../src/pageTree');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const HTML = fs.readFileSync(APP, 'utf8');
const T = { timeout: 15000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);

// ---------------------------------------------------------------- 見本の木（DB の pages.list と同じ並び: 作った新しい順。子は親より後に作った）
// 最上位 pa3・pa2・pa1（新しい順）。pa2 の中に k1・k2（並びの鍵の順）、k1 の中に g1（3 段）
const AT = (d) => `2026-10-${d}.000Z`;
const ROW = (id, createdAt, o = {}) => ({ id, title: titleAt(createdAt), date: createdAt.slice(0, 10), durationSec: 600, hasSummary: true, createdAt, parentId: null, ord: 'i', ...o });
const LIST = () => [
  ROW('pa3', AT('22T00:00:00')),
  ROW('g1', AT('21T08:00:00'), { parentId: 'k1', ord: 'i', kind: 'blank' }),
  ROW('k2', AT('21T07:00:00'), { parentId: 'pa2', ord: 'r', kind: 'blank' }),
  ROW('k1', AT('21T06:00:00'), { parentId: 'pa2', ord: 'i', kind: 'blank' }),
  ROW('pa2', AT('21T00:00:00')),
  ROW('pa1', AT('20T00:00:00')),
];
const PAGE = (id) => {
  const p = LIST().find((x) => x.id === id);
  return p ? { page: { id, title: p.title, date: p.date, createdAt: p.createdAt, durationSec: 600, blocks: [], memo: '', meetingType: 'general', ...(p.kind ? { kind: p.kind } : {}) }, segments: [] } : null;
};
// page.create の答え（白紙のページ。題名は空）
const NEWPAGE = () => ({ page: { id: 'pnew1', kind: 'blank', title: '', date: '2026-11-03', createdAt: '2026-11-03T01:00:00.000Z', durationSec: 0, blocks: [], memo: '' }, segments: [] });
async function boot(o = {}) {
  const l = await load(APP, { returns: {
    pagesSearch: () => LIST(), pageGet: (id) => PAGE(id) || (id === 'pnew1' ? NEWPAGE() : null), pageCreate: () => ({ id: 'pnew1', page: NEWPAGE().page }),
    pageMove: () => LIST(), pageDelete: () => LIST(), ...(o.returns || {}) } });
  await l.drain();
  return l;
}
const rows = (l) => $(l, 'plist').querySelectorAll('.pitem');
const ids = (l) => rows(l).map((r) => r.dataset.pid);
const rowOf = (l, id) => rows(l).find((r) => r.dataset.pid === id);
const key = async (l, id, o) => { const ev = l.key(o, rowOf(l, id)); await l.drain(); return ev; };
// 今描いている行のうちフォーカスのある行（偽 DOM は textContent で外した子の parentNode を残すので、描き直す前の行は今の行と比べて外す）
const focused = (l) => { const a = l.document.activeElement; return a && rows(l).includes(a) ? a.dataset.pid : ''; };
const saves = (l) => l.called('uiSave').map((c) => c.args[0]).filter((p) => p && p.tree);

// ---------------------------------------------------------------- 写し
test('PH-3: 画面の写し（app.html の pageTreeView）は src/pageTree.js と字も答えも同じ', () => {
  const at = HTML.indexOf('  // ---- pageTree の写し');
  const end = HTML.indexOf('  // ---- pageTree の写しはここまで');
  assert.ok(at > 0 && end > at, 'app.html に pageTree の写しが無い');
  const seg = HTML.slice(at, end);
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'pageTree.js'), 'utf8');
  const body = SRC.slice(SRC.indexOf('const TOP_ORD'), SRC.indexOf('\nmodule.exports')).replace(/\s+$/, '');
  assert.ok(seg.includes(body.split('\n').map((x) => (x ? `    ${x}` : x)).join('\n')), 'app.html の写しの字が src/pageTree.js と違う');
  const app = new Function(`${seg}\nreturn pageTreeView;`)();   // eslint-disable-line no-new-func
  const rs = [...LIST(), { id: 'lost', parentId: 'nope', ord: 'i', createdAt: AT('19T00:00:00') }, { id: 'c1', parentId: 'c2', ord: 'i' }, { id: 'c2', parentId: 'c1', ord: 'i' }];
  const a = app.pageTree(rs); const b = PT.pageTree(rs);
  assert.deepStrictEqual([a.roots, [...a.kids], [...a.parent], a.orphans], [b.roots, [...b.kids], [...b.parent], b.orphans]);
  const open = new Set(['pa2', 'k1']);
  assert.deepStrictEqual(app.visibleRows(a, open), PT.visibleRows(b, open));
  for (const id of ['g1', 'pa2', 'c1']) {
    assert.deepStrictEqual(app.descendants(a, id), PT.descendants(b, id));
    assert.deepStrictEqual(app.crumbsOf(a, id), PT.crumbsOf(b, id));
    assert.deepStrictEqual(app.placeText(a, (x) => x, id), PT.placeText(b, (x) => x, id));
  }
  for (const [id, p] of [['pa2', 'g1'], ['g1', 'pa1'], ['pa2', null]]) assert.strictEqual(app.canMoveUnder(a, id, p), PT.canMoveUnder(b, id, p));
  const vis = PT.visibleRows(b, open);
  for (const [idx, y, drag] of [[1, 15, 'pa1'], [2, 2, 'pa1'], [2, 28, 'pa3'], [2, 15, 'pa2']]) assert.deepStrictEqual(app.pageDropSpot(vis, idx, y, 30, drag, a), PT.pageDropSpot(vis, idx, y, 30, drag, b));
});

// ---------------------------------------------------------------- PH-3
test('PH-3・F115: 子のある行は閉じて描く（3 段の木で描いた行は最上位の数だけ）。→ で開くと子が出る。閉じた子の行は DOM に無い', T, async () => {
  const l = await boot();
  assert.strictEqual($(l, 'plist').getAttribute('role'), 'tree');
  assert.deepStrictEqual(ids(l), ['pa3', 'pa2', 'pa1'], '閉じた子の行も描いた');
  assert.ok(!$(l, 'plist').querySelectorAll('[data-pid]').some((e) => ['k1', 'k2', 'g1'].includes(e.dataset.pid)), '閉じた子の行が DOM にある');
  await key(l, 'pa2', { key: 'ArrowRight' });
  assert.deepStrictEqual(ids(l), ['pa3', 'pa2', 'k1', 'k2', 'pa1'], '→ で子が出ない（子は並びの鍵の順）');
  assert.strictEqual(rowOf(l, 'pa2').getAttribute('aria-expanded'), 'true');
  assert.strictEqual(rowOf(l, 'k1').getAttribute('aria-expanded'), 'false', '閉じた k1 の印');
  assert.ok(!ids(l).includes('g1'), '閉じた k1 の子を描いた');
  assert.deepStrictEqual(rows(l).map((r) => r.getAttribute('aria-level')), ['1', '1', '2', '2', '1']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PH-3: 子の無い最上位の行は今と同じ形（▸ の場所が無い）。子のある行は乗せる・フォーカスでアイコンの所が ▸（開いていれば ▾）。子の行は段ごとに 14px 字下げ（8 段で止める）', T, async () => {
  const l = await boot();
  const flat = rowOf(l, 'pa3');
  // PH-3 直し（R28 (5)）: 比べの値に偽の DOM の要素を入れない（外れたときに要素を書き出して答えが返らない: stage131.nest.app の注）
  assert.deepStrictEqual([flat.className, flat.querySelector('.pi').textContent, flat.querySelector('.tw') === null, flat.style.paddingLeft, flat.getAttribute('aria-expanded')],
    ['pitem', '🎙️', true, undefined, null], '子の無い行の形が変わった');
  const kid = rowOf(l, 'pa2');
  assert.ok(kid.classList.contains('kids'));
  assert.deepStrictEqual([kid.querySelector('.pe').textContent, kid.querySelector('.tw').textContent, kid.getAttribute('aria-expanded')], ['🎙️', '▸', 'false']);
  // 見た目（CSS）: ▸ はふだん隠れ、乗せる・フォーカスで出て、絵文字の場所に重なる（場所を空けない）
  const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
  const at = (sel) => S.declsFor(rules, sel, { at: '' });
  assert.strictEqual(at('.pitem .tw').display, 'none');
  assert.strictEqual(at('.pitem .tw').position, 'absolute');
  assert.strictEqual(at('.pitem.kids:focus .tw').display, 'flex');
  assert.strictEqual(at('.pitem.kids:hover .tw').display, 'flex');
  assert.strictEqual(at('.pitem.kids:focus .pe').visibility, 'hidden');
  // 押すと開け閉め（行は開かない）
  const n0 = l.called('pageGet').length;
  kid.querySelector('.pi').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.called('pageGet').length, n0, '▸ を押したらページが開いた');
  assert.deepStrictEqual([rowOf(l, 'pa2').querySelector('.tw').textContent, rowOf(l, 'pa2').getAttribute('aria-expanded')], ['▾', 'true']);
  assert.deepStrictEqual([rowOf(l, 'k1').style.paddingLeft, rowOf(l, 'k2').style.paddingLeft], ['22px', '22px']);
  rowOf(l, 'k1').querySelector('.pi').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(rowOf(l, 'g1').style.paddingLeft, '36px');
  // 深い木: 8 段で字下げを止める（aria-level は本当の段）
  const deep = [ROW('d0', AT('10T00:00:00')), ...Array.from({ length: 11 }, (_, i) => ROW(`d${i + 1}`, AT(`10T0${Math.min(9, i)}:${String(i).padStart(2, '0')}:01`), { parentId: `d${i}` }))];
  const l2 = await boot({ returns: { pagesSearch: () => deep, uiState: () => ({ tree: { open: deep.map((r) => r.id) } }) } });
  assert.deepStrictEqual(rows(l2).map((r) => [r.getAttribute('aria-level'), r.style.paddingLeft || '']),
    deep.map((_, i) => [String(i + 1), i === 0 ? '' : `${8 + 14 * Math.min(i, 8)}px`]));
  assert.deepStrictEqual([...l.errors, ...l2.errors].map(fmt), []);
});

test('PH-3・F117: 木のキー（↑↓・→ で開く／最初の子・← で閉じる／親・Home／End・Enter で今のタブ・Ctrl+Enter で新しいタブ・変換中の Enter は抜ける）。描き直してもフォーカスが同じ行', T, async () => {
  const l = await boot();
  // Tab で届くのは1つの行だけ（はじめは1行目）
  assert.deepStrictEqual(rows(l).map((r) => r.tabIndex), [0, -1, -1]);
  rowOf(l, 'pa3').focus();
  await key(l, 'pa3', { key: 'ArrowDown' });
  assert.strictEqual(focused(l), 'pa2');
  assert.deepStrictEqual(rows(l).map((r) => r.tabIndex), [-1, 0, -1], '移った行に Tab で届かない');
  await key(l, 'pa2', { key: 'ArrowRight' });
  assert.deepStrictEqual([focused(l), rowOf(l, 'pa2').getAttribute('aria-expanded')], ['pa2', 'true'], '→ で開かない・描き直してフォーカスが消えた');
  await key(l, 'pa2', { key: 'ArrowRight' });
  assert.strictEqual(focused(l), 'k1', '開いた行の → で最初の子へ移らない');
  await key(l, 'k1', { key: 'ArrowRight' });
  assert.ok(ids(l).includes('g1'));
  await key(l, 'k1', { key: 'ArrowDown' });
  assert.strictEqual(focused(l), 'g1');
  await key(l, 'g1', { key: 'ArrowLeft' });
  assert.strictEqual(focused(l), 'k1', '子の無い行の ← で親へ移らない');
  await key(l, 'k1', { key: 'ArrowLeft' });
  assert.deepStrictEqual([focused(l), ids(l).includes('g1')], ['k1', false], '開いた行の ← で閉じない');
  await key(l, 'k1', { key: 'ArrowLeft' });
  assert.strictEqual(focused(l), 'pa2', '閉じた行の ← で親へ移らない');
  await key(l, 'pa2', { key: 'End' });
  assert.strictEqual(focused(l), 'pa1');
  await key(l, 'pa1', { key: 'Home' });
  assert.strictEqual(focused(l), 'pa3');
  await key(l, 'pa3', { key: 'ArrowUp' });
  assert.strictEqual(focused(l), 'pa3', '頭の ↑ でフォーカスが外れた');
  // Enter は今のタブ・変換中は抜ける・Ctrl+Enter は新しいタブ
  const n0 = l.called('pageGet').length;
  const ime = await key(l, 'k2', { key: 'Enter', isComposing: true });
  assert.strictEqual(l.called('pageGet').length, n0, '変換確定の Enter で開いた');
  assert.strictEqual(ime.defaultPrevented, false);
  rowOf(l, 'k2').focus();
  await key(l, 'k2', { key: 'Enter' });
  assert.deepStrictEqual(l.called('pageGet').slice(n0).map((c) => c.args[0]), ['k2']);
  assert.strictEqual(focused(l), 'k2', 'ページを開いて描き直したらフォーカスが消えた');
  assert.strictEqual($(l, 'tabbar').querySelectorAll('.tabitem').length, 1);
  await key(l, 'pa1', { key: 'Enter', ctrlKey: true });
  assert.deepStrictEqual($(l, 'tabbar').querySelectorAll('.tabitem').map((t) => t.dataset.key), ['page:k2', 'page:pa1'], 'Ctrl+Enter で新しいタブに開かない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PH-3・F118: 開け閉めを uiSave({ tree }) で覚え、uiState の tree で戻す。開いたページ（main・リンク・タブ）の祖先が開く', T, async () => {
  const l = await boot();
  rowOf(l, 'pa2').querySelector('.pi').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(saves(l).pop(), { tree: { open: ['pa2'] } }, '開いたのを覚えない');
  await key(l, 'pa2', { key: 'ArrowLeft' });
  assert.deepStrictEqual(saves(l).pop(), { tree: { open: [] } }, '閉じたのを覚えない');
  // 起動し直すと戻る（形の悪い値は落ちる）
  const l2 = await boot({ returns: { uiState: () => ({ tree: { open: ['pa2', 'k1', 3] } }) } });
  assert.deepStrictEqual(ids(l2), ['pa3', 'pa2', 'k1', 'g1', 'k2', 'pa1'], '覚えた開け閉めが戻らない');
  // main から開いた孫のページ（閉じた親の下）は、祖先を開いて行を見せる（HR5）
  const l3 = await boot();
  l3.fire('onPageOpen', 'g1');
  await l3.drain();
  assert.deepStrictEqual(ids(l3), ['pa3', 'pa2', 'k1', 'g1', 'k2', 'pa1'], '開いたページの祖先を開かない');
  assert.ok(rowOf(l3, 'g1').classList.contains('sel'));
  assert.deepStrictEqual(saves(l3).pop(), { tree: { open: ['pa2', 'k1'] } }, '開いた祖先を覚えない');
  assert.deepStrictEqual([...l.errors, ...l2.errors, ...l3.errors].map(fmt), []);
});

test('PH-3: 行の［＋］→ pageCreate(行の id) の1回で、作ったページを今のタブで開き、親の行は開く。行のメニュー（右クリック・Shift+F10）は［中にページを作る］［新しいタブで開く］［削除］', T, async () => {
  // PH-3 直し（R28 (2)）で意図して変えた: 覚えるのは子のある行だけなので、作った後の一覧（DB の pages.list と同じ）に作った子を入れる
  let made = '';
  const l = await boot({ returns: {
    pagesSearch: () => (made ? [...LIST(), ROW('pnew1', AT('23T00:00:00'), { parentId: made, kind: 'blank' })] : LIST()),
    pageCreate: (parentId) => { made = parentId || ''; return { id: 'pnew1', page: NEWPAGE().page }; } } });
  const add = rowOf(l, 'pa1').querySelector('.padd');
  assert.ok(add, '行の［＋］が無い');
  assert.deepStrictEqual([add.textContent, add.title, add.getAttribute('aria-label'), add.tabIndex], ['＋', 'この中にページを作る', 'この中にページを作る', -1]);
  const n0 = l.called('pageGet').length;
  add.dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('pageCreate').map((c) => c.args), [['pa1']], '行の［＋］が行の中に作らない');
  assert.deepStrictEqual(l.called('pageGet').slice(n0).map((c) => c.args[0]), ['pnew1'], '作ったページを開かない');
  assert.deepStrictEqual(saves(l).pop(), { tree: { open: ['pa1'] } }, '作った親の行を開かない');
  // 行のメニュー
  const menuOf = () => l.document.querySelector('.treemenu');
  rowOf(l, 'pa2').dispatchEvent({ type: 'contextmenu', preventDefault() {} });
  await l.drain();
  assert.ok(menuOf(), '右クリックで行のメニューが出ない');
  assert.strictEqual(menuOf().getAttribute('role'), 'menu');
  assert.deepStrictEqual(menuOf().querySelectorAll('.mitem').map((b) => [b.textContent, b.getAttribute('role')]),
    [['中にページを作る', 'menuitem'], ['新しいタブで開く', 'menuitem'], ['削除', 'menuitem']]);
  assert.ok(l.document.activeElement === menuOf().querySelectorAll('.mitem')[0], 'メニューの1つ目にフォーカスが無い');
  l.key({ key: 'ArrowDown' }, menuOf());
  assert.strictEqual(l.document.activeElement.textContent, '新しいタブで開く');
  l.key({ key: 'Escape' }, menuOf());
  await l.drain();
  assert.deepStrictEqual([menuOf() === null, focused(l)], [true, 'pa2'], 'Esc で閉じて行へ戻らない');
  await key(l, 'pa2', { key: 'F10', shiftKey: true });
  assert.ok(menuOf(), 'Shift+F10 で行のメニューが出ない');
  menuOf().querySelectorAll('.mitem')[0].dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('pageCreate').map((c) => c.args), [['pa1'], ['pa2']], '［中にページを作る］が行の中に作らない');
  assert.ok(menuOf() === null, '［中にページを作る］の後もメニューが残る');
  await key(l, 'pa3', { key: 'ContextMenu' });
  menuOf().querySelectorAll('.mitem')[1].dispatchEvent({ type: 'click' });
  await l.drain();
  assert.ok($(l, 'tabbar').querySelectorAll('.tabitem').some((t) => t.dataset.key === 'page:pa3'), '［新しいタブで開く］で開かない');
  assert.strictEqual($(l, 'tabbar').querySelectorAll('.tabitem').length, 2, '新しいタブで開かない');
  // ［削除］は確かめる（この台の confirm は［キャンセル］なので消さない）
  await key(l, 'pa3', { key: 'ContextMenu' });
  menuOf().querySelectorAll('.mitem')[2].dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('pageDelete'), [], '確かめずに消した');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PH-3: 引っ張る（真ん中へ落とす → pageMove(id, 行の id)・下の4分の1 → pageMove(id, 親, 行の id)・自分の子孫の上では印が出ず呼ばない・Esc でやめる）', T, async () => {
  const l = await boot({ returns: { uiState: () => ({ tree: { open: ['pa2'] } }) } });
  assert.deepStrictEqual(ids(l), ['pa3', 'pa2', 'k1', 'k2', 'pa1']);
  for (const r of rows(l)) r._rect = { top: 0, height: 30 };
  const dt = () => ({ effectAllowed: '', setData() {} });
  const drag = (id) => rowOf(l, id).dispatchEvent({ type: 'dragstart', target: rowOf(l, id), dataTransfer: dt() });
  // PH-3 直し（R28 (1)）で意図して変えた: dragover・drop の事象にアプリのページの印（dataTransfer.types）を持たせる（本物の窓でも引っ張っている間は types が読める）
  const over = (id, y) => { let prevented = false; rowOf(l, id).dispatchEvent({ type: 'dragover', clientY: y, dataTransfer: { types: ['application/x-natsu-page'] }, preventDefault() { prevented = true; } }); return prevented; };
  const drop = (id, y) => rowOf(l, id).dispatchEvent({ type: 'drop', clientY: y, dataTransfer: { types: ['application/x-natsu-page'] }, preventDefault() {} });
  assert.ok(rows(l).every((r) => r.draggable === true));
  drag('k2');
  assert.strictEqual(over('pa1', 15), true, '真ん中に落とす所が無い');
  assert.ok(rowOf(l, 'pa1').classList.contains('dropin'), '中へ落とす印が無い');
  drop('pa1', 15);
  await l.drain();
  assert.deepStrictEqual(l.called('pageMove').map((c) => c.args), [['k2', 'pa1', undefined]]);
  for (const r of rows(l)) r._rect = { top: 0, height: 30 };
  drag('pa1');
  assert.strictEqual(over('k1', 28), true);
  assert.ok(rowOf(l, 'k1').classList.contains('dropafter'), '後ろへ落とす印が無い');
  drop('k1', 28);
  await l.drain();
  assert.deepStrictEqual(l.called('pageMove').map((c) => c.args)[1], ['pa1', 'pa2', 'k1'], '下の4分の1で兄弟の後ろへ動かさない');
  // 自分の子孫の上: 印を出さず、落としても呼ばない
  for (const r of rows(l)) r._rect = { top: 0, height: 30 };
  drag('pa2');
  assert.strictEqual(over('k1', 15), false, '自分の子の上で落とす所を出した');
  assert.ok(!rows(l).some((r) => /drop(in|before|after)/.test(r.className)), '自分の子の上で印を出した');
  drop('k1', 15);
  await l.drain();
  assert.strictEqual(l.called('pageMove').length, 2, '自分の子の中へ動かした');
  rowOf(l, 'pa2').dispatchEvent({ type: 'dragend' });
  // Esc でやめる（その後に落としても動かさない）
  drag('k2');
  assert.strictEqual(over('pa1', 15), true);
  l.key({ key: 'Escape' });
  assert.ok(!rows(l).some((r) => /drop(in|before|after)/.test(r.className)), 'Esc で印が消えない');
  assert.strictEqual(over('pa1', 15), false, 'Esc の後も落とす所を出す');
  drop('pa1', 15);
  await l.drain();
  assert.strictEqual(l.called('pageMove').length, 2, 'Esc でやめた後に動かした');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PH-3・F117: 選ぶ形（0.10.0 L-2）も木のまま。Shift の範囲は見えている行の順で、閉じた子は入らない', T, async () => {
  const l = await boot();
  $(l, 'listSelect').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(ids(l), ['pa3', 'pa2', 'pa1'], '選ぶ形で木が崩れた');
  assert.ok(rows(l).every((r) => r.querySelector('.pchk') && r.getAttribute('role') === 'treeitem'));
  rowOf(l, 'pa3').dispatchEvent({ type: 'click' });
  await l.drain();
  rowOf(l, 'pa1').dispatchEvent({ type: 'click', shiftKey: true });
  await l.drain();
  assert.deepStrictEqual(rows(l).map((r) => r.querySelector('.pchk').getAttribute('aria-checked')), ['true', 'true', 'true']);
  assert.strictEqual($(l, 'selCount').textContent, '3 件を選んでいます', '閉じた子が範囲に入った');
  // 開いた子は範囲に入る（選び直す）
  await key(l, 'pa2', { key: 'ArrowRight' });
  $(l, 'selCancel').dispatchEvent({ type: 'click' });
  $(l, 'listSelect').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(ids(l), ['pa3', 'pa2', 'k1', 'k2', 'pa1']);
  rowOf(l, 'pa3').dispatchEvent({ type: 'click' });
  await l.drain();
  rowOf(l, 'k2').dispatchEvent({ type: 'click', shiftKey: true });
  await l.drain();
  assert.deepStrictEqual(rows(l).filter((r) => r.querySelector('.pchk').getAttribute('aria-checked') === 'true').map((r) => r.dataset.pid), ['pa3', 'pa2', 'k1', 'k2']);
  assert.deepStrictEqual(l.called('pageGet'), [], '選ぶ形で押した行を開いた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- 0.15.0 PH-3 直し・PH-4 直し（2026-11-03 の点検の Minor。計画の R28・R29）
const PAGE_TYPE = 'application/x-natsu-page';
test('PH-3 直し・R28 (1): 木の落とす所はアプリのページの印（application/x-natsu-page）のある引っ張りだけ。一覧を描き直して元の行が替わっても、本文から引っ張った文字（text/plain だけ）を行に落とすと何もしない。document の dragend・dragstart で引っ張りを忘れる', T, async () => {
  const l = await boot({ returns: { uiState: () => ({ tree: { open: ['pa2'] } }) } });
  const rect = () => { for (const r of rows(l)) r._rect = { top: 0, height: 30 }; };
  rect();
  const dt = () => ({ effectAllowed: '', setData() {} });
  const drag = (id) => rowOf(l, id).dispatchEvent({ type: 'dragstart', target: rowOf(l, id), dataTransfer: dt() });
  const over = (id, types) => { let prevented = false; rowOf(l, id).dispatchEvent({ type: 'dragover', clientY: 15, dataTransfer: { types }, preventDefault() { prevented = true; } }); return prevented; };
  const drop = (id, types) => rowOf(l, id).dispatchEvent({ type: 'drop', clientY: 15, dataTransfer: { types }, preventDefault() {} });
  drag('k2');
  // 引っ張っている間に一覧を描き直す（pa2 を閉じて開く: 元の行 k2 は替わり、その行の dragend は来ない）
  rowOf(l, 'pa2').querySelector('.pi').dispatchEvent({ type: 'click' });
  await l.drain();
  rowOf(l, 'pa2').querySelector('.pi').dispatchEvent({ type: 'click' });
  await l.drain();
  rect();
  assert.strictEqual(over('pa1', ['text/plain']), false, '文字だけの引っ張りに落とす所を出した');
  assert.ok(!rows(l).some((r) => /drop(in|before|after)/.test(r.className)), '文字だけの引っ張りに印を出した');
  assert.strictEqual(over('pa1', [PAGE_TYPE]), true, 'ページの印のある引っ張りに落とす所が無い');
  drop('pa1', ['text/plain']);
  await l.drain();
  assert.deepStrictEqual(l.called('pageMove'), [], '文字だけの引っ張りで前のページを動かした');
  // document の dragend（元の行が外れていても、窓の外へ落としても）で忘れる
  drag('k2');
  assert.strictEqual(over('pa1', [PAGE_TYPE]), true);
  l.key({ type: 'dragend' });
  assert.ok(!rows(l).some((r) => /drop(in|before|after)/.test(r.className)), 'dragend で印が消えない');
  assert.strictEqual(over('pa1', [PAGE_TYPE]), false, 'dragend の後も落とす所を出す');
  // document の dragstart（ほかの所から引っ張り始めた）でも忘れる
  drag('k2');
  l.key({ type: 'dragstart' });
  assert.strictEqual(over('pa1', [PAGE_TYPE]), false, 'ほかの引っ張りが始まった後も前のページの落とす所を出す');
  drop('pa1', [PAGE_TYPE]);
  await l.drain();
  assert.deepStrictEqual(l.called('pageMove'), []);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PH-3 直し・R28 (2): 開け閉めの覚え書きは子のある行だけを、新しく開いた順の新しい 500 個まで（501 個目に開いた行も覚える）', T, async () => {
  const many = [];
  for (let i = 0; i < 501; i++) {
    many.push(ROW(`q${i}`, `2026-09-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`));
    many.push(ROW(`c${i}`, `2026-09-02T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`, { parentId: `q${i}` }));
  }
  many.push(ROW('leaf', '2026-09-03T00:00:00.000Z'));
  const open = ['leaf', ...Array.from({ length: 500 }, (_, i) => `q${i}`)];
  const l = await boot({ returns: { pagesSearch: () => many, uiState: () => ({ tree: { open } }) } });
  assert.ok(ids(l).includes('c0') && ids(l).includes('c499'), '覚えた 500 個の開け閉めが戻らない');
  rowOf(l, 'q500').querySelector('.pi').dispatchEvent({ type: 'click' });
  await l.drain();
  const saved = saves(l).pop().tree.open;
  assert.strictEqual(saved.length, 500);
  assert.ok(saved.includes('q500'), '501 個目に開いた行を覚えない');
  assert.ok(!saved.includes('q0'), 'いちばん古い行を落とさない');
  assert.ok(!saved.includes('leaf'), '子の無い行を覚えた');
  assert.strictEqual(saved[saved.length - 1], 'q500', '開いた行が新しい側に無い');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PH-3 直し・R28 (3): 選ぶ形でも子のある行はチェックボックスの隣の ▸ で開け閉めできる（選びは変わらず、ページは開かない）。子の無い行には ▸ が無い', T, async () => {
  const l = await boot();
  $(l, 'listSelect').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(rowOf(l, 'pa3').querySelector('.ptw') === null, true, '子の無い行に ▸ がある');
  const tw = rowOf(l, 'pa2').querySelector('.ptw');
  assert.ok(tw, '選ぶ形で子のある行に ▸ が無い');
  assert.deepStrictEqual([tw.textContent, tw.title, tw.getAttribute('aria-hidden')], ['▸', '開く', 'true']);
  assert.ok(rowOf(l, 'pa2').querySelector('.pchk'), 'チェックボックスが消えた');
  tw.dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(ids(l), ['pa3', 'pa2', 'k1', 'k2', 'pa1'], '選ぶ形の ▸ で開かない');
  assert.strictEqual(rowOf(l, 'pa2').querySelector('.ptw').textContent, '▾');
  assert.ok(rows(l).every((r) => r.querySelector('.pchk').getAttribute('aria-checked') === 'false'), '▸ で選びが変わった');
  assert.deepStrictEqual(l.called('pageGet'), [], '▸ でページを開いた');
  assert.deepStrictEqual(saves(l).pop(), { tree: { open: ['pa2'] } });
  rowOf(l, 'pa2').querySelector('.ptw').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(ids(l), ['pa3', 'pa2', 'pa1'], '選ぶ形の ▾ で閉じない');
  const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
  assert.strictEqual(S.declsFor(rules, '.pitem .ptw', { at: '' }).flex, 'none');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PH-3 直し・R28 (4): 行のメニューは窓の下に入らなければ行の上に開く（入れば行の下）', T, async () => {
  const l = await boot();
  l.window.innerHeight = 300;
  const top = () => Number.parseInt(l.document.querySelector('.treemenu').style.top, 10);
  rowOf(l, 'pa3')._rect = { top: 40, height: 30 };
  rowOf(l, 'pa3').dispatchEvent({ type: 'contextmenu', preventDefault() {} });
  await l.drain();
  assert.strictEqual(top(), 70, '入るのに行の下に開かない');
  l.key({ key: 'Escape' }, l.document.querySelector('.treemenu'));
  await l.drain();
  rowOf(l, 'pa1')._rect = { top: 270, height: 30 };
  rowOf(l, 'pa1').dispatchEvent({ type: 'contextmenu', preventDefault() {} });
  await l.drain();
  const t = top();
  assert.ok(t >= 0 && t < 270, `窓の下に入らないのに行の上に開かない（top ${t}）`);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- PH-4 の台（命令は一時の DB を本当に通す。stage140.app の openReal と同じ形）
const { tmpDb, samplePage } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const U = require('../src/undoBook');
const NOW = () => new Date('2026-11-03T01:02:03.000Z');
let txn = 0;
const CMDS = {
  blockUpdate: (pageId, blockId, patch) => ['block.update', { pageId, blockId, patch }],
  blockInsert: (pageId, afterBlockId, type, level, parentId, toggle) => ['block.insert', { pageId, afterBlockId, type, ...(level === undefined ? {} : { level }), ...(parentId === undefined ? {} : { parentId }), ...(toggle === true ? { toggle } : {}) }],
  blockRemove: (pageId, blockId) => ['block.remove', { pageId, blockId }],
  blockSplit: (pageId, blockId, text, at, afterId, inside, rich) => ['block.split', { pageId, blockId, text, at, ...(afterId === undefined ? {} : { afterId }), ...(inside === true ? { inside } : {}), ...(rich === undefined ? {} : { rich }) }],
  blockMerge: (pageId, blockId, text, intoId, rich) => ['block.merge', { pageId, blockId, text, ...(intoId === undefined ? {} : { intoId }), ...(rich === undefined ? {} : { rich }) }],
  blockTurnInto: (pageId, blockId, type, level, toggle) => ['block.turnInto', { pageId, blockId, type, ...(level === undefined ? {} : { level }), ...(toggle === true ? { toggle } : {}) }],
  editRevert: (pageId, steps) => ['edit.revert', { pageId, steps }],
  blockPaste: (pageId, blockId, rich, at, blocks, afterId, inside) => ['block.paste', { pageId, blockId, rich, at, blocks, ...(afterId === undefined ? {} : { afterId }), ...(inside === true ? { inside } : {}) }],
  pageSetTitle: (id, title) => ['page.setTitle', { id, title }],
  pageCreate: (parentId, placeAt) => ['page.create', { ...(parentId ? { parentId } : {}), ...(placeAt ? { placeAt } : {}) }],   // 0.15.0 PR-2: preload と同じ形（R6・R30）
  pageMove: (id, parentId, afterId, row) => ['page.move', { id, parentId: parentId || '', ...(afterId === undefined ? {} : { afterId }),
    ...(row && row.afterId !== undefined ? { rowAfter: row.afterId } : {}), ...(row && row.parentId ? { rowParent: row.parentId } : {}) }],   // PR-2 直し（R44）: preload と同じ形
  pageDelete: (id) => ['page.delete', { id }],
  // 0.15.0 PR-2: 子ページの行の場面で使う行の命令も DB を本当に通す（preload と同じ形）
  blockMove: (pageId, blockId, to) => ['block.move', to && typeof to === 'object' ? { pageId, blockId, afterId: to.afterId, ...(to.parentId === undefined ? {} : { parentId: to.parentId }) } : { pageId, blockId, toIndex: to }],
  blockDuplicate: (pageId, blockId, afterId, parentId) => ['block.duplicate', { pageId, blockId, ...(afterId === undefined ? {} : { afterId }), ...(parentId === undefined ? {} : { parentId }) }],
  blockIndent: (pageId, blockId, dir) => ['block.indent', { pageId, blockId, dir }],
  blocksRemove: (pageId, ids) => ['blocks.remove', { pageId, ids }],
  blocksMove: (pageId, ids, afterId, parentId) => ['blocks.move', { pageId, ids, afterId, ...(parentId === undefined ? {} : { parentId }) }],
  blocksDuplicate: (pageId, ids, afterId, parentId) => ['blocks.duplicate', { pageId, ids, ...(afterId === undefined ? {} : { afterId }), ...(parentId === undefined ? {} : { parentId }) }],
  blocksSetColor: (pageId, ids, color) => ['blocks.setColor', { pageId, ids, color }],   // PR-2 直し（R40）: 行の色も DB を通す
};
// 白紙のページの見本（page.create と同じ欄。本文の見出しは型の見出しと締めの見出し・出典の無い箇条書き。人が足した印 citeState は付けない＝要約の並べ替えと札が効く形）
const BLANK = (id, title, blocks) => ({ page: { id, title, kind: 'blank', date: '2026-11-02', memo: '', blocks, createdAt: '2026-11-02T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z' }, segments: [] });
const BODY = () => [
  { id: 'q1', type: 'heading', level: 2, text: '目的' }, { id: 'q2', type: 'bullet', text: '見積もりを出す日を決める。' },
  { id: 'q3', type: 'heading', level: 2, text: '論点ごとの要点' }, { id: 'q4', type: 'bullet', text: '予算は先月の案のまま進める。' },
  { id: 'q5', type: 'heading', level: 2, text: '決定事項' }, { id: 'q6', type: 'todo', text: '案を送る', checked: false }];
async function openDb(o = {}) {
  const t = tmpDb();
  const { db } = t.open();
  const { page, segments } = samplePage('pa1');
  t.seed({ ...page, title: titleAt('2026-10-29T01:00:00.000Z') }, segments);
  for (const b of o.blanks || []) t.seed(b.page, b.segments);
  let L = null;
  const call = (cmd, args, role = 'app') => {
    const tx = `${role[0]}:ph4-${String(++txn).padStart(6, '0')}`;
    const r = core.call(db, { role, cmd, args, tx }, { now: NOW, labels: {} });
    if (!r.ok) throw new Error(r.code);   // contextBridge を越えた Error は message だけが残る
    if (role === 'app' && (r.changed || r.dupChanged) && U.UNDO_CMDS.has(cmd)) { const s = { cmd, pageId: typeof args.pageId === 'string' ? args.pageId : args.id, step: tx }; if (L) L.fire('onEditStep', s); }
    return r.result;
  };
  const made = typeof o.before === 'function' ? o.before(call) : null;   // 0.15.0 PR-2: 画面を開く前に DB の命令で種を作る（作ったページの ID を返す）
  const wrap = (fn) => (...a) => { try { return fn(...a); } catch (e) { return Promise.reject(e); } };
  const returns = { pagesSearch: wrap((q) => call('pages.list', { q: q || '' })), pageGet: wrap((id) => call('page.get', { id })), copy: () => true, ...(o.returns || {}) };
  for (const [name, f] of Object.entries(CMDS)) if (!returns[name]) returns[name] = wrap((...a) => call(...f(...a)));
  const l = await load(APP, { caret: true, returns });
  L = l;
  l.t = t; l.db = db; l.call = call; l.made = made;
  l.page = (id) => call('page.get', { id }).page;
  l.done = () => t.done();
  await l.drain();
  if (o.open) { l.fire('onPageOpen', o.open); await l.drain(); }
  return l;
}
const noteRows = (l) => $(l, 'pNote').querySelectorAll('.blk');
const noteTxt = (l, id) => noteRows(l).find((e) => e.dataset.id === id).querySelector('.txt');
const menuLabels = (l) => { $(l, 'pMore').dispatchEvent({ type: 'click' }); const r = $(l, 'pMenu').querySelectorAll('.mitem').map((b) => b.textContent); $(l, 'pMore').dispatchEvent({ type: 'click' }); return r; };

// ---------------------------------------------------------------- PH-4
test('PH-4・BQ2 (a)・F116: 白紙のページの形（会議の種類の行・プロパティ・3つのタブ・［要約を生成］が無い・本文の行がある・「···」は［コピー］［リンクを写す］［削除］・アイコンは 📄）。議事録は今の形のまま', T, async () => {
  const l = await openDb({ blanks: [BLANK('pb1', '', BODY())], open: 'pb1' });
  try {
    assert.ok($(l, 'pageWrap').classList.contains('blank'), '白紙のページの印が無い');
    const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
    assert.strictEqual(S.declsFor(rules, '#pageWrap.blank .ptabs', { at: '' }).display, 'none', '白紙のページに3つのタブが出る');
    assert.strictEqual($(l, 'pTypeRow').style.display, 'none', '白紙のページに会議の種類の行が出る');
    assert.strictEqual($(l, 'pProps').textContent, '', '白紙のページにプロパティが出る');
    assert.deepStrictEqual([...$(l, 'pActs').children].map((b) => b.id), ['pMore', 'pMenu'], '白紙のページに［要約を生成］が出る');
    assert.deepStrictEqual(menuLabels(l), ['コピー', 'リンクを写す', '削除']);
    assert.strictEqual($(l, 'pIcon').textContent, '📄');
    assert.deepStrictEqual([$(l, 'pTitle').textContent, $(l, 'pTitle').getAttribute('data-ph')], ['', '無題のページ']);
    assert.deepStrictEqual(noteRows(l).map((e) => e.dataset.id), ['q1', 'q2', 'q3', 'q4', 'q5', 'q6'], '本文の行が無いか、書いた順でない');
    assert.strictEqual($(l, 'pNote').classList.contains('active'), true);
    assert.ok($(l, 'sumLock') === null, '白紙のページの本文に要約の鍵の一言が出る');
    // 議事録は今の形のまま
    l.fire('onPageOpen', 'pa1');
    await l.drain();
    assert.ok(!$(l, 'pageWrap').classList.contains('blank'));
    assert.strictEqual($(l, 'pTypeRow').style.display, '');
    assert.strictEqual($(l, 'pIcon').textContent, '🎙️');
    assert.ok(menuLabels(l).includes('要約を再生成'), '議事録の「···」から［要約を再生成］が消えた');
    assert.strictEqual($(l, 'pTitle').getAttribute('data-ph'), null);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PH-4・P3・F116: 白紙のページの本文は書いた順のまま（「目的」「論点ごとの要点」の後ろの「決定事項」を前に出さない）・「根拠なし」「手書き」の札が無い。Enter・Ctrl+B・貼り付け・Ctrl+Z は要約の欄と同じ命令（DB が受ける）', T, async () => {
  const l = await openDb({ blanks: [BLANK('pb1', '', BODY())], open: 'pb1' });
  try {
    assert.deepStrictEqual(noteRows(l).map((e) => e.querySelector('.txt').textContent), ['目的', '見積もりを出す日を決める。', '論点ごとの要点', '予算は先月の案のまま進める。', '決定事項', '案を送る']);
    assert.strictEqual($(l, 'pNote').querySelectorAll('.cites, .cbadge').length, 0, '白紙のページの行に出典の札がある');
    assert.ok(!/根拠なし|手書き/.test($(l, 'pNote').textContent), '白紙のページに出典の札の文がある');
    // Enter → block.split（DB が受ける: 鍵を掛けない）
    const t = noteTxt(l, 'q2');
    t.focus(); l.caret.set(t, 3);
    l.key({ key: 'Enter', code: 'Enter' }, t);
    await l.drain();
    assert.deepStrictEqual(l.called('blockSplit').map((c) => c.args.slice(0, 2)), [['pb1', 'q2']]);
    assert.strictEqual(l.page('pb1').blocks.length, 7, 'DB が白紙のページの本文の分割を受けない');
    // Ctrl+Z → edit.revert の1回で戻る
    l.key({ key: 'z', code: 'KeyZ', ctrlKey: true }, l.document.activeElement);
    await l.drain(); await l.drain();
    assert.strictEqual(l.called('editRevert').length, 1, 'Ctrl+Z で戻さない');
    assert.strictEqual(l.page('pb1').blocks.length, 6);
    // Ctrl+B → 選んだ所を太字にして、区切りで rich を1回保存
    const t2 = noteTxt(l, 'q4');
    t2.focus(); l.caret.set(t2, 0, 2);
    assert.strictEqual(l.key({ key: 'b', code: 'KeyB', ctrlKey: true }, t2).defaultPrevented, true);
    t2.blur(); if (typeof t2.onblur === 'function') t2.onblur({});
    await l.drain();
    assert.ok(l.called('blockUpdate').some((c) => c.args[0] === 'pb1' && c.args[1] === 'q4' && Array.isArray(c.args[2].rich)), 'Ctrl+B の太字を保存しない');
    // 貼り付け → block.paste の1回
    const t3 = noteTxt(l, 'q2');
    t3.focus(); l.caret.set(t3, t3.textContent.length);
    let prevented = false;
    t3.dispatchEvent({ type: 'paste', clipboardData: { getData: (k) => (k === 'text/plain' ? '- 一つ目\n- 二つ目' : '') }, preventDefault() { prevented = true; } });
    await l.drain();
    assert.ok(prevented);
    assert.deepStrictEqual(l.called('blockPaste').map((c) => c.args[0]), ['pb1'], '貼り付けが block.paste にならない');
    assert.ok(l.page('pb1').blocks.some((b) => b.text === '二つ目'), 'DB が貼り付けを受けない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PH-4: 空の白紙のページの本文は「ここに書く（/ で行の型を選べます）」の手引きで、押すと最初の行（テキスト）を足してフォーカスする（DB は空の白紙のページの本文を断らない）', T, async () => {
  const l = await openDb({ blanks: [BLANK('pb2', '', [])], open: 'pb2' });
  try {
    const ph = $(l, 'pNote').querySelector('.bodyph');
    assert.ok(ph, '空の本文の手引きが無い');
    assert.deepStrictEqual([ph.textContent, ph.tabIndex, ph.getAttribute('role')], ['ここに書く（/ で行の型を選べます）', 0, 'button']);
    // PH-4 直し（R29 (3)）: 押す・Enter の前は何も書かない（開いただけでは書かない: R25）
    assert.deepStrictEqual(Object.keys(CMDS).filter((name) => l.called(name).length), [], '空の白紙のページを開いただけで書く命令を送った');
    assert.deepStrictEqual([l.page('pb2').blocks, l.page('pb2').updatedAt], [[], '2026-11-02T00:00:00.000Z'], '空の白紙のページを開いただけで書いた');
    ph.dispatchEvent({ type: 'click' });
    await l.drain();
    assert.deepStrictEqual(l.called('blockInsert').map((c) => c.args.slice(0, 3)), [['pb2', '', 'paragraph']]);
    assert.strictEqual(l.page('pb2').blocks.length, 1, 'DB が空の白紙のページの本文に行を足さない（要約の鍵）');
    assert.strictEqual(noteRows(l).length, 1);
    assert.ok(l.document.activeElement === noteRows(l)[0].querySelector('.txt'), '足した行にフォーカスが無い');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PH-4: 見出し「議事録」の行の［＋］・行の［＋］・/ページ → pageCreate（最上位・行の中・開いているページの中）→ 作ったページを今のタブで開いて題名にフォーカス。/ページ の文字は消える', T, async () => {
  const l = await openDb({ blanks: [BLANK('pb1', '', BODY())], open: 'pa1' });
  try {
    const head = $(l, 'newPageBtn');
    assert.ok(head, '見出しの［＋］が無い');
    assert.deepStrictEqual([head.textContent, head.getAttribute('title'), head.getAttribute('aria-label')], ['＋', 'ページを作る', 'ページを作る']);
    head.dispatchEvent({ type: 'click' });
    await l.drain();
    const made = l.called('pageCreate');
    assert.deepStrictEqual(made.map((c) => c.args), [[]], '見出しの［＋］が最上位に作らない');
    const id1 = l.called('pageGet').pop().args[0];
    assert.match(id1, /^p[a-z0-9]+$/);
    assert.strictEqual(l.page(id1).kind, 'blank');
    assert.ok(l.document.activeElement === $(l, 'pTitle'), '作ったページの題名にフォーカスが無い');
    assert.deepStrictEqual([$(l, 'pTitle').textContent, $(l, 'pTitle').getAttribute('data-ph')], ['', '無題のページ']);
    // 行の［＋］（議事録 pa1 の中）
    rowOf(l, 'pa1').querySelector('.padd').dispatchEvent({ type: 'click' });
    await l.drain();
    assert.deepStrictEqual(l.called('pageCreate').map((c) => c.args)[1], ['pa1']);
    assert.ok(l.document.activeElement === $(l, 'pTitle'), '行の［＋］で作ったページの題名にフォーカスが無い');
    // /ページ（議事録の［AI 要約］の欄）→ 打った /ページ の文字は消えて保存され、pa1 の中に作る
    l.fire('onPageOpen', 'pa1');
    await l.drain();
    const t = noteTxt(l, 'b2');
    const was = t.textContent;
    t.focus();
    t.textContent = `${was} /ぺーじ`;
    l.caret.set(t, t.textContent.length);
    t.dispatchEvent({ type: 'input' });
    await l.drain();
    const menu = $(l, 'pNote').querySelector('.slashmenu');
    assert.ok(menu, '/ メニューが開かない');
    assert.deepStrictEqual(menu.querySelectorAll('.sopt').map((o) => o.textContent), ['ページ'], '/ぺーじ で［ページ］が出ない');
    l.key({ key: 'Enter', code: 'Enter' }, t);
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('pageCreate').map((c) => c.args)[2], ['pa1'], '/ページ が開いているページの中に作らない');
    assert.strictEqual(l.page('pa1').blocks.find((b) => b.id === 'b2').text, was, '/ページ の文字が消えない');
    assert.ok(l.document.activeElement === $(l, 'pTitle'), '/ページ で作ったページの題名にフォーカスが無い');
    // 白紙のページの本文の /ページ も開いているページの中
    l.fire('onPageOpen', 'pb1');
    await l.drain();
    const t2 = noteTxt(l, 'q2');
    t2.focus();
    t2.textContent = `${t2.textContent} /page`;
    l.caret.set(t2, t2.textContent.length);
    t2.dispatchEvent({ type: 'input' });
    await l.drain();
    l.key({ key: 'Enter', code: 'Enter' }, t2);
    await l.drain(); await l.drain();
    // PR-2 で意図して変えた: 白紙のページの本文の /ページ は打った行も渡す（placeAt。そこに子ページの行を置く: 決めたこと 25・45）
    assert.deepStrictEqual(l.called('pageCreate').map((c) => c.args)[3], ['pb1', 'q2']);
    assert.ok(l.page('pb1').blocks.findIndex((b) => b.type === 'subpage') === l.page('pb1').blocks.findIndex((b) => b.id === 'q2') + 1, '/ページ を打った行のすぐ下に子ページの行が無い');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PH-4・F116: 無題の白紙のページはサイドバー・タブ・検索で「無題のページ」、無題の議事録は今の「(無題の議事録)」', T, async () => {
  const l = await openDb({ blanks: [BLANK('pb1', '', BODY())], open: 'pb1' });
  try {
    assert.strictEqual(rowOf(l, 'pb1').querySelector('.t').textContent, '無題のページ');
    assert.strictEqual(rowOf(l, 'pb1').querySelector('.pi').textContent, '📄', '白紙のページの行のアイコン');
    assert.strictEqual($(l, 'tabbar').querySelector('.tabitem .tt').textContent, '無題のページ');
    assert.strictEqual($(l, 'crumb').querySelector('.ci').textContent, '📄');
    assert.deepStrictEqual(l.call('pages.list', { q: '無題のページ' }).map((p) => p.id), ['pb1'], '検索で「無題のページ」が当たらない');
    l.call('page.setTitle', { id: 'pa1', title: '' }, 'main');
    assert.strictEqual(l.call('pages.list', { q: '' }).find((p) => p.id === 'pa1').title, '(無題の議事録)');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 0.15.0 PH-4 直し（2026-11-03 の点検の Minor。計画の R29）
test('PH-4 直し・R29 (1): ［ページ］はメモの欄の / メニューに出ない（ページの本文の欄だけ）。選んでも「最近使ったもの」に入れない', T, async () => {
  const l = await openDb({ open: 'pa1' });
  try {
    const m = $(l, 'pMemo').querySelector('.memorows .blk .txt');
    assert.ok(m, 'メモの行が無い');
    m.focus();
    m.textContent = '/';
    l.caret.set(m, 1);
    m.dispatchEvent({ type: 'input' });
    await l.drain();
    const menu = $(l, 'pMemo').querySelector('.slashmenu');
    assert.ok(menu, 'メモの欄の / メニューが開かない');
    const opts = menu.querySelectorAll('.sopt').map((o) => o.textContent);
    assert.ok(opts.length > 0 && !opts.includes('ページ'), `メモの欄の / メニューに［ページ］がある: ${opts.join('・')}`);
    l.key({ key: 'Escape' }, m);
    await l.drain();
    // ページの本文の欄で［ページ］を選んでも、uiSave の slashRecent に page を入れない
    const t = noteTxt(l, 'b2');
    t.focus();
    t.textContent = `${t.textContent} /ぺーじ`;
    l.caret.set(t, t.textContent.length);
    t.dispatchEvent({ type: 'input' });
    await l.drain();
    l.key({ key: 'Enter', code: 'Enter' }, t);
    await l.drain(); await l.drain();
    assert.strictEqual(l.called('pageCreate').length, 1, '［ページ］を選べない');
    const recents = l.called('uiSave').map((c) => c.args[0]).filter((x) => x && Array.isArray(x.slashRecent));
    assert.ok(!recents.some((x) => x.slashRecent.includes('page')), '［ページ］を「最近使ったもの」に入れた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PH-4 直し・R29 (2): 白紙のページの題名を直しても、会議の種類の判定（metaDetectType）を聞かない。題名は保存する', T, async () => {
  const asked = [];
  const l = await openDb({ blanks: [BLANK('pb1', '', BODY())], open: 'pb1', returns: { metaDetectType: (...a) => { asked.push(a); return { type: 'sales' }; } } });
  try {
    const el = $(l, 'pTitle');
    el.textContent = '週の予定';
    el.onblur();
    await l.drain();
    assert.deepStrictEqual(l.called('pageSetTitle').map((c) => c.args), [['pb1', '週の予定']], '白紙のページの題名を保存しない');
    assert.deepStrictEqual(asked, [], '白紙のページで会議の種類の判定を聞いた');
    assert.strictEqual($(l, 'pTitleTypeHint').hidden, true);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 0.15.0 PR-2（決めたこと 43〜60・BQ10〜BQ13・HR16・HR18・F123）: 画面の本文の子ページの行
// 白紙のページ pb1（BODY の6行）の中に子ページ k1（「週の予定」・q1 の下）と k2（「見積もり」・q2 の下）。q2 の下の k2 の後ろにテキストの行 tp
function rowsDb(o = {}) {
  return openDb({ ...o, blanks: [BLANK('pb1', '計画', BODY())], open: 'pb1', before: (call) => {
    const k1 = call('page.create', { parentId: 'pb1', placeAt: 'q1' }).id;
    call('page.setTitle', { id: k1, title: '週の予定' });   // 利用者が付け直した題名（D77）
    const k2 = call('page.create', { parentId: 'pb1', placeAt: 'q2' }).id;
    call('page.setTitle', { id: k2, title: '見積もり' });   // 利用者が付け直した題名（D77）
    const r2 = call('page.get', { id: 'pb1' }).page.blocks.find((b) => b.type === 'subpage' && b.page === k2).id;
    const tp = call('block.insert', { pageId: 'pb1', afterBlockId: r2, type: 'paragraph' }).blockId;
    call('block.update', { pageId: 'pb1', blockId: tp, patch: { text: '下の文' } });
    const extra = typeof o.more === 'function' ? o.more(call) : {};
    return { k1, k2, tp, ...extra };
  } });
}
const subEls = (l) => noteRows(l).filter((e) => e.classList.contains('subpage'));
const subEl = (l, page) => subEls(l).find((e) => e._b && e._b.page === page);
const rowIdOf = (l, page) => l.page('pb1').blocks.flatMap((b) => [b, ...(b.children || [])]).find((b) => b.type === 'subpage' && b.page === page).id;
const toastText = (l) => $(l, 'toast').textContent;
const listNow = (l) => l.call('pages.list', { q: '' });

test('PR-2・F123: 白紙のページの本文に「アイコン 題名」の行（textContent）・題名を変えるとすぐ変わる・押すと開く・Ctrl+クリックで新しいタブ・Enter で開く・↑↓ で隣の行・行は文を直せない', T, async () => {
  const l = await rowsDb();
  try {
    const { k1, k2 } = l.made;
    assert.deepStrictEqual(subEls(l).map((e) => e._txt.textContent), ['📄 週の予定', '📄 見積もり']);
    assert.deepStrictEqual(noteRows(l).map((e) => e.dataset.id).indexOf(rowIdOf(l, k1)), 1, 'q1 のすぐ下に無い');
    const t1 = subEl(l, k1)._txt;
    assert.deepStrictEqual([t1.contentEditable, t1.tabIndex, t1.getAttribute('role'), t1.title], ['false', 0, 'link', '開く（Ctrl+クリックで新しいタブ）']);
    // 題名を変えると一覧を読み直してすぐ変わる（保存した文 text は空のまま）
    l.call('page.setTitle', { id: k1, title: '週の予定（改）' });   // 利用者が付け直した題名（D77）
    l.fire('onPagesUpdated');
    await l.drain();
    assert.strictEqual(subEl(l, k1)._txt.textContent, '📄 週の予定（改）', '題名を変えても行が古い題名のまま');
    assert.strictEqual(l.page('pb1').blocks.find((b) => b.page === k1).text, '');
    // 文を直さない（打っても保存の命令を送らない）
    const n0 = l.called('blockUpdate').length;
    subEl(l, k1)._txt.focus();
    subEl(l, k1)._txt.onblur();
    await l.drain();
    assert.strictEqual(l.called('blockUpdate').length, n0, '子ページの行の文を保存した');
    // ↑↓ で隣の行
    subEl(l, k1)._txt.focus();
    l.key({ key: 'ArrowDown' }, subEl(l, k1)._txt);
    assert.ok(l.document.activeElement === noteTxt(l, 'q2'), '↓ で下の行へ移らない');
    noteTxt(l, 'q2').focus(); l.caret.set(noteTxt(l, 'q2'), 0);
    l.key({ key: 'ArrowUp' }, noteTxt(l, 'q2'));
    assert.ok(l.document.activeElement === subEl(l, k1)._txt, '↑ で子ページの行へ移らない');
    // Enter で開く・押すと開く・Ctrl+クリックで新しいタブ
    l.key({ key: 'Enter', code: 'Enter' }, subEl(l, k1)._txt);
    await l.drain();
    assert.strictEqual(l.called('pageGet').slice(-1)[0].args[0], k1, 'Enter で開かない');
    l.fire('onPageOpen', 'pb1');
    await l.drain();
    subEl(l, k2)._txt.dispatchEvent({ type: 'click' });
    await l.drain();
    assert.strictEqual(l.called('pageGet').slice(-1)[0].args[0], k2, '押しても開かない');
    assert.strictEqual($(l, 'tabbar').querySelectorAll('.tabitem').length, 1, '押すと新しいタブで開いた');
    l.fire('onPageOpen', 'pb1');
    await l.drain();
    subEl(l, k2)._txt.dispatchEvent({ type: 'click', ctrlKey: true });
    await l.drain();
    assert.strictEqual($(l, 'tabbar').querySelectorAll('.tabitem').length, 2, 'Ctrl+クリックで新しいタブに開かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2・F123: 行を Ctrl+Shift+↓ で並べ替えると blockMove の1回で、サイドバーの子の並びも替わる。Tab で字下げしてもページの親は替わらない', T, async () => {
  const l = await rowsDb();
  try {
    const { k1, k2 } = l.made;
    rowOf(l, 'pb1').querySelector('.pi').dispatchEvent({ type: 'click' });
    await l.drain();
    assert.deepStrictEqual(ids(l).filter((id) => id === k1 || id === k2), [k1, k2]);
    const n0 = l.called('blockMove').length;
    for (let i = 0; i < 2; i++) {
      subEl(l, k1)._txt.focus();
      l.key({ key: 'ArrowDown', code: 'ArrowDown', ctrlKey: true, shiftKey: true }, subEl(l, k1)._txt);
      await l.drain();
    }
    assert.strictEqual(l.called('blockMove').length, n0 + 2, '1回ごとに blockMove の1回でない');
    assert.deepStrictEqual(ids(l).filter((id) => id === k1 || id === k2), [k2, k1], '本文で並べ替えてもサイドバーの子の並びが替わらない');
    // Tab で字下げ（k2 の行を q2 の子へ）してもページの親は pb1 のまま
    subEl(l, k2)._txt.focus();
    l.key({ key: 'Tab', code: 'Tab' }, subEl(l, k2)._txt);
    await l.drain();
    assert.strictEqual(l.called('blockIndent').length, 1);
    assert.strictEqual(l.page('pb1').blocks.find((b) => b.id === 'q2').children.some((b) => b.page === k2), true, '字下げしない');
    assert.strictEqual(listNow(l).find((p) => p.id === k2).parentId, 'pb1', '字下げでページの親が替わった');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2・BQ10 (a)・BQ12 (a)・HR21: 行を選んで Backspace → blocksRemove の1回・知らせ「ページ n 件をゴミ箱に入れました（Ctrl+Z で戻せます）」・Ctrl+Z で editRevert の1回・行とサイドバーの行が戻る', T, async () => {
  const l = await rowsDb({ more: (call) => ({ g1: call('page.create', { parentId: call('pages.list', {}).find((p) => p.title === '週の予定').id }).id }) });
  try {
    const { k1 } = l.made;
    const rid = rowIdOf(l, k1);
    subEl(l, k1)._txt.focus();
    l.key({ key: 'Escape' }, subEl(l, k1)._txt);
    assert.deepStrictEqual($(l, 'pNote').querySelectorAll('.blk.sel').map((e) => e.dataset.id), [rid], 'Esc で子ページの行を選ばない');
    l.key({ key: 'Backspace' }, $(l, 'pNote'));
    await l.drain();
    assert.deepStrictEqual(l.called('blocksRemove').map((c) => c.args[1]), [[rid]], '選んだ行の Backspace が blocksRemove の1回でない');
    assert.strictEqual(toastText(l), 'ページ 2 件をゴミ箱に入れました（Ctrl+Z で戻せます）', '知らせが無いか、中のページを数えない');
    assert.ok(!subEl(l, k1), '行が残る');
    assert.ok(!ids(l).includes(k1), 'サイドバーに消したページが残る');
    l.key({ key: 'z', code: 'KeyZ', ctrlKey: true }, l.document.activeElement || $(l, 'pNote'));
    await l.drain(); await l.drain();
    assert.strictEqual(l.called('editRevert').length, 1, 'Ctrl+Z で editRevert の1回でない');
    assert.ok(subEl(l, k1), 'Ctrl+Z で行が戻らない');
    assert.ok(listNow(l).some((p) => p.id === k1), 'Ctrl+Z でページが戻らない');
    rowOf(l, 'pb1').querySelector('.pi').dispatchEvent({ type: 'click' });
    await l.drain();
    assert.ok(ids(l).includes(k1), 'Ctrl+Z でサイドバーの行が戻らない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2・HR18: 子ページの行のすぐ下の行の頭の Backspace は blockMerge を呼ばず、子ページの行を選ぶ（もう一度 Backspace で消す）', T, async () => {
  const l = await rowsDb();
  try {
    const { k2, tp } = l.made;
    const t = noteTxt(l, tp);
    t.focus(); l.caret.set(t, 0);
    l.key({ key: 'Backspace' }, t);
    await l.drain();
    assert.deepStrictEqual(l.called('blockMerge'), [], '子ページの行とつないだ');
    assert.deepStrictEqual(l.called('blockRemove'), []);
    assert.deepStrictEqual($(l, 'pNote').querySelectorAll('.blk.sel').map((e) => e.dataset.id), [rowIdOf(l, k2)], '子ページの行を選ばない');
    assert.strictEqual(l.page('pb1').blocks.find((b) => b.id === tp).text, '下の文');
    l.key({ key: 'Backspace' }, $(l, 'pNote'));
    await l.drain();
    assert.strictEqual(l.called('blocksRemove').length, 1);
    assert.ok(!listNow(l).some((p) => p.id === k2), 'もう一度の Backspace でページがゴミ箱に入らない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2・BQ11 (a): 子ページの行を選んで写す → text/plain が「📄 題名」・text/html が NaTsu のリンクの文。貼るとリンクの付いた文の行（blockPaste の行に subpage が無い）。切り取りは写してから blocksRemove', T, async () => {
  const l = await rowsDb({ more: (call) => ({ ep: call('block.insert', { pageId: 'pb1', afterBlockId: 'q6', type: 'paragraph' }).blockId }) });
  try {
    const { k1, k2, ep } = l.made;
    subEl(l, k1)._txt.focus();
    l.key({ key: 'Escape' }, subEl(l, k1)._txt);
    const data = {};
    l.key({ type: 'copy', clipboardData: { setData: (k, v) => { data[k] = v; } } });   // document の copy の受け口（選んだ行の写し）
    assert.strictEqual(data['text/plain'], '📄 週の予定');
    assert.ok(data['text/html'].includes(`<a href="natsu://page/${k1}">📄 週の予定</a>`), data['text/html']);
    // 貼る（空のテキストの行に: 1行の文は行の中に飾りつきで入る。0.14.0 の決めたこと 24）→ リンクの付いた文の行
    const t = noteTxt(l, ep);
    t.focus(); l.caret.set(t, 0);
    t.dispatchEvent({ type: 'paste', clipboardData: { getData: (k) => data[k] || '' }, preventDefault() {} });
    t.onblur();
    await l.drain();
    assert.ok(!l.called('blockPaste').some((c) => JSON.stringify(c.args[4]).includes('subpage')), '貼る行に subpage がある');
    const got = l.page('pb1').blocks.find((b) => b.text === '📄 週の予定' && b.type !== 'subpage');
    assert.ok(got, '貼った文の行が無い');
    assert.ok(JSON.stringify(got.rich).includes(`natsu://page/${k1}`), '貼った行にリンクが無い');
    assert.strictEqual(listNow(l).filter((p) => p.parentId === 'pb1').length, 2, '貼るとページが増えた');
    // 切り取り
    subEl(l, k2)._txt.focus();
    l.key({ key: 'Escape' }, subEl(l, k2)._txt);
    const cut = {};
    l.key({ type: 'cut', clipboardData: { setData: (k, v) => { cut[k] = v; } } });
    await l.drain();
    assert.strictEqual(cut['text/plain'], '📄 見積もり');
    assert.strictEqual(l.called('blocksRemove').length, 1, '切り取りが blocksRemove の1回でない');
    assert.ok(!listNow(l).some((p) => p.id === k2), '切り取ってもページがゴミ箱に入らない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2・BQ13 (a): 子ページの行の Ctrl+D は写さず「ページの行は複製できません」。ほかの行と一緒に選んで Ctrl+D なら、ほかの行だけ', T, async () => {
  const l = await rowsDb();
  try {
    const { k1 } = l.made;
    subEl(l, k1)._txt.focus();
    l.key({ key: 'd', code: 'KeyD', ctrlKey: true }, subEl(l, k1)._txt);
    await l.drain();
    assert.deepStrictEqual([l.called('blockDuplicate').length, l.called('blocksDuplicate').length], [0, 0], '子ページの行を写そうとした');
    assert.strictEqual(toastText(l), 'ページの行は複製できません');
    // ⠿ の［複製］も同じ
    l.key({ key: '/', code: 'Slash', ctrlKey: true }, subEl(l, k1)._txt);
    await l.drain();
    const m = $(l, 'pNote').querySelector('.blockmenu');
    assert.ok(m, '子ページの行の ⠿ のメニューが開かない');
    m.querySelectorAll('.mitem').find((b) => b.textContent === '複製').dispatchEvent({ type: 'click' });
    await l.drain();
    assert.strictEqual(l.called('blockDuplicate').length, 0);
    // 選んだ q1 と子ページの行 → q1 だけ
    noteTxt(l, 'q1').focus();
    l.key({ key: 'Escape' }, noteTxt(l, 'q1'));
    l.key({ key: 'ArrowDown', shiftKey: true }, $(l, 'pNote'));
    assert.strictEqual($(l, 'pNote').querySelectorAll('.blk.sel').length, 2);
    l.key({ key: 'd', code: 'KeyD', ctrlKey: true }, $(l, 'pNote'));
    await l.drain();
    assert.deepStrictEqual(l.called('blocksDuplicate').map((c) => c.args[1]), [['q1']], 'ほかの行だけを写さない');
    assert.deepStrictEqual(l.page('pb1').blocks.filter((b) => b.type === 'subpage').length, 2, '同じページを指す行が増えた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2・HR16・決めたこと 55: 今の子でないページを指す行は灰色「（このページはここにありません）」・押せない・消せる（消してもページの命令は呼ばない）。行の無い子は本文の最後の「このページの中のページ」の一覧', T, async () => {
  const l = await rowsDb({ more: (call) => {
    const k3 = call('page.create', { parentId: 'pb1' }).id;
    call('page.setTitle', { id: k3, title: '行の無い子' });   // 利用者が付け直した題名（D77）
    return { k3 };
  } });
  try {
    const { k3 } = l.made;
    // 前の版・壊れた行: 子でないページ pa1 を指す行と、行を消された子 k3（素の SQL で）
    applyOpsRaw(l.db, 'pb1', 'bgone1', 'pa1');
    l.db.prepare('delete from blocks where id = ?').run(rowIdOf(l, k3));
    l.fire('onPageOpen', 'pa1'); await l.drain();
    l.fire('onPageOpen', 'pb1'); await l.drain();
    const g = noteRows(l).find((e) => e.dataset.id === 'bgone1');
    assert.ok(g && g.classList.contains('gone'), '灰色の行が無い');
    assert.deepStrictEqual([g._txt.textContent, g._txt.getAttribute('aria-disabled')], ['（このページはここにありません）', 'true']);
    const n0 = l.called('pageGet').length;
    g._txt.dispatchEvent({ type: 'click' });
    await l.drain();
    assert.strictEqual(l.called('pageGet').length, n0, '灰色の行を押して開いた');
    const kids = $(l, 'bodyKids');
    assert.ok(kids && !kids.hidden, '行の無い子の一覧が無い');
    assert.strictEqual(kids.querySelector('.kidshead').textContent, 'このページの中のページ');
    assert.deepStrictEqual(kids.querySelectorAll('.kidrow').map((e) => e.textContent), ['📄 行の無い子']);
    kids.querySelectorAll('.kidrow')[0].dispatchEvent({ type: 'click' });
    await l.drain();
    assert.strictEqual(l.called('pageGet').slice(-1)[0].args[0], k3, '一覧の子を押しても開かない');
    l.fire('onPageOpen', 'pb1'); await l.drain();
    // 灰色の行を消してもページは何もされない
    const g2 = noteRows(l).find((e) => e.dataset.id === 'bgone1');
    g2._txt.focus();
    l.key({ key: 'Delete' }, g2._txt);
    await l.drain();
    assert.ok(!noteRows(l).some((e) => e.dataset.id === 'bgone1'), '灰色の行を消せない');
    assert.ok(listNow(l).some((p) => p.id === 'pa1'), '灰色の行を消すとページがゴミ箱に入った');
    assert.deepStrictEqual(l.called('pageDelete'), []);
    // 議事録のページには一覧が出ない
    l.fire('onPageOpen', 'pa1'); await l.drain();
    assert.strictEqual($(l, 'bodyKids').hidden, true, '議事録に白紙のページの子の一覧が出た');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
function applyOpsRaw(db, pageId, id, page) {
  const O = require('../src/db/ops');
  O.applyOps(db, [{ op: 'add', id, row: { ...O.blockRow({ id, type: 'subpage', text: '' }, pageId, 'zz'), attrs: { page } } }]);
}

test('PR-2・決めたこと 57: 白紙のページの［コピー］で子ページの行は「📄 題名」（行の文 text は空でも題名で写す）', T, async () => {
  const l = await rowsDb();
  try {
    $(l, 'pMore').dispatchEvent({ type: 'click' });
    $(l, 'pMenu').querySelectorAll('.mitem').find((b) => b.textContent === 'コピー').dispatchEvent({ type: 'click' });
    await l.drain();
    const text = l.called('copy').slice(-1)[0].args[0];
    assert.ok(text.includes('📄 週の予定') && text.includes('📄 見積もり'), text);
    assert.ok(text.indexOf('目的') < text.indexOf('📄 週の予定'), '子ページの行が書いた順に無い');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2・決めたこと 8: 前の版（0.14.0）の画面は知らない型の子ページの行を空のテキストの行として描く（落ちない）。そこで打った文の保存は今の DB が断り、行は子ページの行のまま（ページを失わない）。今の画面の型の写しには subpage がある', T, async () => {
  // 0.14.0（a3f0925）の app.html の描き方の写し（TYPED_VIEW と dress の vt の1行）
  const OLD_TYPED_VIEW = ['heading', 'todo', 'bullet', 'numbered', 'toggle', 'quote', 'divider', 'callout'];
  const oldVt = (b) => (b.type === 'paragraph' || OLD_TYPED_VIEW.includes(b.type) ? b.type : 'paragraph');
  assert.strictEqual(oldVt({ type: 'subpage', text: '', page: 'pk1' }), 'paragraph');
  assert.ok(HTML.includes("const TYPED_VIEW = ['heading', 'todo', 'bullet', 'numbered', 'toggle', 'quote', 'divider', 'callout', 'subpage'];"), '今の画面の型の写しに subpage が無い');
  const l = await rowsDb();
  try {
    const { k1 } = l.made;
    const id = rowIdOf(l, k1);
    assert.throws(() => l.call('block.update', { pageId: 'pb1', blockId: id, patch: { text: '前の版で打った文' } }), /bad-args/);
    assert.deepStrictEqual([l.page('pb1').blocks.find((b) => b.id === id).type, l.page('pb1').blocks.find((b) => b.id === id).page], ['subpage', k1]);
  } finally { l.done(); }
});

test('PR-2・決めたこと 46: 開いている白紙のページの子をサイドバーで外へ動かすと、本文の行も消えて描き直す（DB が同じ命令で行を消す）', T, async () => {
  const l = await rowsDb();
  try {
    const { k1 } = l.made;
    rowOf(l, 'pb1').querySelector('.pi').dispatchEvent({ type: 'click' });
    await l.drain();
    for (const r of rows(l)) r._rect = { top: 0, height: 30 };
    rowOf(l, k1).dispatchEvent({ type: 'dragstart', target: rowOf(l, k1), dataTransfer: { effectAllowed: '', setData() {} } });
    rowOf(l, 'pa1').dispatchEvent({ type: 'drop', clientY: 15, dataTransfer: { types: ['application/x-natsu-page'] }, preventDefault() {} });
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('pageMove').map((c) => c.args.slice(0, 2)), [[k1, 'pa1']]);
    assert.ok(!subEl(l, k1), '動かした子の行が開いている本文に残る');
    assert.strictEqual($(l, 'bodyKids').hidden, true);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 0.15.0 PR-2 直し（2026-11-03 の 76fb1c4..0828257 の点検。計画の R38〜）
test('PR-2 直し・R38（F123）: 白紙のページを開いたまま、サイドバーの行のメニューの［削除］で子を消すと、本文の行も消えて描き直す（灰色の行を残さない）。孫を消しても本文はそのまま', T, async () => {
  const l = await rowsDb({ more: (call) => ({ g1: call('page.create', { parentId: call('pages.list', {}).find((p) => p.title === '週の予定').id }).id }) });
  try {
    const { k1, k2, g1 } = l.made;
    l.window.confirm = () => true;
    rowOf(l, 'pb1').querySelector('.pi').dispatchEvent({ type: 'click' });
    await l.drain();
    const menuDelete = async (id) => {
      rowOf(l, id).dispatchEvent({ type: 'contextmenu', preventDefault() {} });
      await l.drain();
      const items = l.document.querySelector('.treemenu').querySelectorAll('.mitem');
      items.find((b) => b.textContent === '削除').dispatchEvent({ type: 'click' });
      await l.drain(); await l.drain();
    };
    // 孫 g1（k1 の中）: 開いている pb1 の本文は変わらない
    rowOf(l, k1).querySelector('.pi').dispatchEvent({ type: 'click' });
    await l.drain();
    await menuDelete(g1);
    assert.deepStrictEqual(l.called('pageDelete').map((c) => c.args[0]), [g1]);
    assert.deepStrictEqual(subEls(l).map((e) => [e._b.page, e.classList.contains('gone')]), [[k1, false], [k2, false]]);
    // 子 k2: DB が同じ命令で本文の行を消したので、開いている本文からも消える
    await menuDelete(k2);
    assert.deepStrictEqual(l.called('pageDelete').map((c) => c.args[0]), [g1, k2]);
    assert.deepStrictEqual(l.page('pb1').blocks.filter((b) => b.type === 'subpage').map((b) => b.page), [k1]);
    assert.deepStrictEqual(subEls(l).map((e) => [e._b.page, e.classList.contains('gone')]), [[k1, false]], '消した子の行が灰色で残る');
    assert.strictEqual(l.document.querySelectorAll('.blk.subpage.gone').length, 0);
    assert.strictEqual(curTitle(l), '計画', '開いているページが替わった');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
const curTitle = (l) => $(l, 'pTitle').textContent;

test('PR-2 直し・R39: 子が無くて覚え書きから外れた「開いた行」に［＋］で子を作ると、開いた行として覚える（新しい側に入れ直す）', T, async () => {
  let made = '';
  const l = await boot({ returns: {
    uiState: () => ({ tree: { open: ['pa1'] } }),
    pagesSearch: () => (made ? [...LIST(), ROW('pnew1', AT('23T00:00:00'), { parentId: made, kind: 'blank' })] : LIST()),
    pageCreate: (parentId) => { made = parentId || ''; return { id: 'pnew1', page: NEWPAGE().page }; } } });
  rowOf(l, 'pa2').querySelector('.pi').dispatchEvent({ type: 'click' });   // pa2 を開く（覚え書きは子のある pa2 だけ。pa1 は子が無いので外れる）
  await l.drain();
  assert.deepStrictEqual(saves(l).pop(), { tree: { open: ['pa2'] } });
  rowOf(l, 'pa1').querySelector('.padd').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(saves(l).pop(), { tree: { open: ['pa2', 'pa1'] } }, '子を作った開いた行を覚えない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PR-2 直し・R40（決めたこと 43・53）: 子ページの行の上の Shift+Enter・Alt+Enter・飾り（Ctrl+B・I・U）・リンク・型の近道は何もしない（題名の描き方も保存も変えない）。⠿ のメニューは［削除］［複製］だけ。子ページの行と一緒に選んだ行のメニューは［変換 ▸］を出さず、色はほかの行だけに付く', T, async () => {
  const l = await rowsDb();
  try {
    const { k1 } = l.made;
    const t1 = subEl(l, k1)._txt;
    const was = l.page('pb1');
    const sent = () => ['blockSplit', 'blockUpdate', 'blockTurnInto', 'blocksTurnInto', 'blocksSetColor', 'blockInsert'].map((n) => l.called(n).length);
    const n0 = sent();
    t1.focus(); l.caret.set(t1, 0, 3);
    const keys = [{ key: 'Enter', code: 'Enter', shiftKey: true }, { key: 'Enter', code: 'Enter', altKey: true }, { key: 'Enter', code: 'Enter', ctrlKey: true, shiftKey: true },
      { key: 'b', code: 'KeyB', ctrlKey: true }, { key: 'i', code: 'KeyI', ctrlKey: true }, { key: 'u', code: 'KeyU', ctrlKey: true }, { key: 'S', code: 'KeyS', ctrlKey: true, shiftKey: true },
      { key: 'e', code: 'KeyE', ctrlKey: true }, { key: 'k', code: 'KeyK', ctrlKey: true }, { key: 'H', code: 'KeyH', ctrlKey: true, shiftKey: true },
      { key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true }, { key: '7', code: 'Digit7', ctrlKey: true, shiftKey: true }];
    for (const k of keys) {
      const ev = l.key(k, t1);
      await l.drain();
      assert.strictEqual(ev.defaultPrevented, true, `${JSON.stringify(k)} の既定の動きを止めない`);
      assert.deepStrictEqual([subEl(l, k1)._txt.textContent, subEl(l, k1)._txt.children.length], ['📄 週の予定', 0], `${JSON.stringify(k)} で題名の描き方が変わった`);
    }
    await new Promise((r) => setTimeout(r, 700)); await l.drain();   // 打つ手の止まりの保存（TYPE_PAUSE_MS）も来ない
    assert.deepStrictEqual(sent(), n0, '子ページの行の上のキーで書く命令を送った');
    assert.deepStrictEqual(l.page('pb1').blocks, was.blocks);
    assert.strictEqual(l.document.querySelector('.linkpop'), null, 'リンクの欄が開いた');
    assert.strictEqual(toastText(l), '', '断られた知らせが出た');
    // ⠿ のメニュー（1つの子ページの行）は［削除］［複製］だけ
    l.key({ key: '/', code: 'Slash', ctrlKey: true }, t1);
    await l.drain();
    assert.deepStrictEqual($(l, 'pNote').querySelector('.blockmenu').querySelectorAll('.mitem').map((b) => b.textContent), ['削除', '複製']);
    l.key({ key: 'Escape' }, $(l, 'pNote').querySelector('.blockmenu'));
    await l.drain();
    // 選んだ q1 と子ページの行: ［変換 ▸］は無く、［色 ▸］は → で開いて q1 だけに付く
    noteTxt(l, 'q1').focus();
    l.key({ key: 'Escape' }, noteTxt(l, 'q1'));
    l.key({ key: 'ArrowDown', shiftKey: true }, $(l, 'pNote'));
    l.key({ key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true }, $(l, 'pNote'));   // 選んだ行の型の近道も送らない（DB が全部を断る）
    await l.drain();
    assert.deepStrictEqual(l.called('blocksTurnInto'), [], '子ページの行を含む選んだ行の型を変えようとした');
    l.key({ key: '/', code: 'Slash', ctrlKey: true }, $(l, 'pNote'));
    await l.drain();
    const m = $(l, 'pNote').querySelector('.blockmenu');
    assert.deepStrictEqual(m.querySelectorAll('.mitem').map((b) => b.textContent), ['削除', '複製', '色 ▸']);
    m.querySelectorAll('.mitem')[2].focus();
    l.key({ key: 'ArrowRight' }, m);
    await l.drain();
    const sub = m.querySelector('.blockmenu.sub');
    assert.ok(sub && sub.getAttribute('aria-label') === '色', '→ で色の中が開かない');
    sub.querySelectorAll('.mitem').find((b) => b.dataset.key === 'red').dispatchEvent({ type: 'click' });
    await l.drain();
    assert.strictEqual(l.called('blocksSetColor').length, 1);
    assert.deepStrictEqual(l.page('pb1').blocks.filter((b) => b.color).map((b) => b.id), ['q1'], '色が q1 だけに付かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2 直し・R41（決めたこと 52）: 子ページの行の入ったトグルを複製すると「ページの行は複製できません」を一度出し、トグルと中のほかの行だけを写す（Ctrl+D・⠿ の［複製］・選んだ行・Alt で落とす）', T, async () => {
  const l = await rowsDb({ more: (call) => {
    const tg = call('block.insert', { pageId: 'pb1', afterBlockId: 'q6', type: 'toggle' }).blockId;
    call('block.update', { pageId: 'pb1', blockId: tg, patch: { text: 'まとめ' } });
    const k1 = call('pages.list', {}).find((p) => p.title === '週の予定').id;
    const r1 = call('page.get', { id: 'pb1' }).page.blocks.find((b) => b.type === 'subpage' && b.page === k1).id;
    call('block.move', { pageId: 'pb1', blockId: r1, afterId: '', parentId: tg });
    return { tg };
  } });
  try {
    const { tg } = l.made;
    const toggles = () => l.page('pb1').blocks.filter((b) => b.type === 'toggle' && b.text === 'まとめ');
    const subCount = () => flatB(l.page('pb1').blocks).filter((b) => b.type === 'subpage').length;
    const tryDup = async (what, fn) => {
      $(l, 'toast').textContent = '';
      const n = toggles().length;
      await fn();
      await l.drain(); await l.drain();
      assert.strictEqual(toastText(l), 'ページの行は複製できません', `${what}: 知らせが無い`);
      assert.strictEqual(toggles().length, n + 1, `${what}: トグルを写さない`);
      assert.strictEqual(subCount(), 2, `${what}: 子ページの行を写した`);
    };
    await tryDup('Ctrl+D', async () => { const t = noteTxt(l, tg); t.focus(); l.caret.set(t, 0); l.key({ key: 'd', code: 'KeyD', ctrlKey: true }, t); });
    await tryDup('⠿ の［複製］', async () => {
      const t = noteTxt(l, tg); t.focus();
      l.key({ key: '/', code: 'Slash', ctrlKey: true }, t);
      await l.drain();
      $(l, 'pNote').querySelector('.blockmenu').querySelectorAll('.mitem').find((b) => b.textContent === '複製').dispatchEvent({ type: 'click' });
    });
    await tryDup('選んだ行の Ctrl+D', async () => { const t = noteTxt(l, tg); t.focus(); l.key({ key: 'Escape' }, t); l.key({ key: 'd', code: 'KeyD', ctrlKey: true }, $(l, 'pNote')); });
    await tryDup('Alt で落とす', async () => {
      const box = $(l, 'pNote');
      noteRows(l).forEach((e, i) => { e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: 0, right: 100, width: 100 }); });
      const row = noteRows(l).find((e) => e.dataset.id === tg);
      row.ondragstart({ target: row, dataTransfer: { setData() {}, effectAllowed: '' }, clientX: 100 });
      await box.ondrop({ preventDefault() {}, clientY: 0, clientX: 100, altKey: true, dataTransfer: {} });
    });
    // 選んだ行（トグルと子ページの行）を Alt で落とすと、子ページの行を除いて blocksDuplicate の1回
    $(l, 'toast').textContent = '';
    const tgt = noteTxt(l, tg); tgt.focus(); l.key({ key: 'Escape' }, tgt);
    l.key({ key: 'ArrowDown', shiftKey: true }, $(l, 'pNote'));   // トグルの中の子ページの行（開いて見えている）まで
    const picked = $(l, 'pNote').querySelectorAll('.blk.sel').map((e) => e.dataset.id);
    assert.ok(picked.length >= 1 && picked[0] === tg, `選び: ${JSON.stringify(picked)}`);
    const nd = l.called('blocksDuplicate').length;
    noteRows(l).forEach((e, i) => { e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: 0, right: 100, width: 100 }); });
    const tgRow = noteRows(l).find((e) => e.dataset.id === tg);
    tgRow.ondragstart({ target: tgRow, dataTransfer: { setData() {}, effectAllowed: '' }, clientX: 100 });
    await $(l, 'pNote').ondrop({ preventDefault() {}, clientY: 0, clientX: 100, altKey: true, dataTransfer: {} });
    await l.drain(); await l.drain();
    assert.strictEqual(l.called('blocksDuplicate').length, nd + 1);
    assert.ok(!l.called('blocksDuplicate').slice(-1)[0].args[1].some((id) => subEls(l).some((e) => e.dataset.id === id)), '子ページの行を写す行に入れた');
    assert.strictEqual(toastText(l), 'ページの行は複製できません', '選んだ行の Alt で落とす: 知らせが無い');
    assert.strictEqual(subCount(), 2);
    // 子ページの行そのものを Alt で落としても写さない（知らせだけ）
    $(l, 'toast').textContent = '';
    const k2row = subEls(l).find((e) => e._b.page === l.made.k2);
    const n = l.called('blockDuplicate').length;
    noteRows(l).forEach((e, i) => { e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: 0, right: 100, width: 100 }); });
    k2row.ondragstart({ target: k2row, dataTransfer: { setData() {}, effectAllowed: '' }, clientX: 100 });
    await $(l, 'pNote').ondrop({ preventDefault() {}, clientY: 0, clientX: 100, altKey: true, dataTransfer: {} });
    await l.drain();
    assert.strictEqual(l.called('blockDuplicate').length, n, '子ページの行を Alt で落として写そうとした');
    assert.strictEqual(toastText(l), 'ページの行は複製できません');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
const flatB = (list) => (list || []).flatMap((b) => [b, ...flatB(b.children)]);

test('PR-2 直し・R42（F123）: 子ページの行を ⠿ で引っ張って本文の中で並べ替えると blockMove の1回で、サイドバーの子の並びも替わる', T, async () => {
  const l = await rowsDb();
  try {
    const { k1, k2 } = l.made;
    rowOf(l, 'pb1').querySelector('.pi').dispatchEvent({ type: 'click' });
    await l.drain();
    assert.deepStrictEqual(ids(l).filter((id) => id === k1 || id === k2), [k1, k2]);
    // 見えている行: q1 k1 q2 k2 下の文 q3 q4 q5 q6（上端 0・10・20…）。k1 の行を「下の文」の下（q3 の上半分: 上端 50）へ
    const box = $(l, 'pNote');
    noteRows(l).forEach((e, i) => { e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: 0, right: 100, width: 100 }); });
    const row = subEl(l, k1);
    row.ondragstart({ target: row, dataTransfer: { setData() {}, effectAllowed: '' }, clientX: 100 });
    box.ondragover({ preventDefault() {}, clientY: 5 * 10 + 2, clientX: 100, dataTransfer: {} });
    await box.ondrop({ preventDefault() {}, clientY: 5 * 10 + 2, clientX: 100, dataTransfer: {} });
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('blockMove').map((c) => [c.args[1], c.args[2]]), [[rowIdOf(l, k1), { afterId: l.made.tp }]], '引っ張っても blockMove の1回でない');
    assert.deepStrictEqual(l.page('pb1').blocks.filter((b) => b.type === 'subpage').map((b) => b.page), [k2, k1]);
    assert.deepStrictEqual(ids(l).filter((id) => id === k1 || id === k2), [k2, k1], '本文で引っ張って並べ替えてもサイドバーの子の並びが替わらない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2 直し・R44（決めたこと 55）: 「このページの中のページ」の行の無い子は、引っ張って本文に置ける（pageMove(id, 今のページ, undefined, { afterId }) の1回・落とす印・置いた所に行・一覧から消える）。Ctrl+Shift+↑ で本文の最後に置く（キーボード）', T, async () => {
  const l = await rowsDb({ more: (call) => {
    const out = {};
    for (const [k, title] of [['k3', '行の無い子'], ['k4', 'もう一つの子']]) {   // 利用者が付け直した題名（D77）
      out[k] = call('page.create', { parentId: 'pb1' }).id;
      call('page.setTitle', { id: out[k], title });
    }
    return out;
  } });
  try {
    const { k1, k2, k3, k4 } = l.made;
    for (const k of [k3, k4]) l.db.prepare('delete from blocks where id = ?').run(rowIdOf(l, k));   // 前の版で行を消された子
    l.fire('onPageOpen', 'pa1'); await l.drain();
    l.fire('onPageOpen', 'pb1'); await l.drain();
    const kidRows = () => $(l, 'bodyKids').querySelectorAll('.kidrow');
    assert.deepStrictEqual(kidRows().map((e) => e.textContent), ['📄 行の無い子', '📄 もう一つの子']);
    const kr = kidRows()[0];
    assert.strictEqual(kr.draggable, true, '行の無い子を引っ張れない');
    assert.strictEqual(kr.title, '開く（Ctrl+クリックで新しいタブ）・引っ張るか Ctrl+Shift+↑ で本文に置く');
    // 引っ張る: アプリのページの印を置く
    const data = {};
    const dt = { effectAllowed: '', setData: (k, v) => { data[k] = v; }, types: [PAGE_TYPE] };
    kr.dispatchEvent({ type: 'dragstart', target: kr, clientX: 100, dataTransfer: dt });
    assert.strictEqual(data[PAGE_TYPE], k3, 'ページの印を置かない');
    // 本文の上: 見えている行 q1 k1 q2 k2 下の文…（上端 0・10・20・30…）。k2 の行の上半分（q2 の下）へ
    const box = $(l, 'pNote');
    // PR-2 直し 3（R45）で意図して変えた: 行の左の端を 100 に置く（本文の外から引っ張ったページの段は、上の行の左の端からのずれで選ぶ。前は 0 で、掴んだ所 100 からのずれを見ていた）
    noteRows(l).forEach((e, i) => { e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: 100, right: 200, width: 100 }); });
    const over = { preventDefault() { this.defaultPrevented = true; }, clientY: 32, clientX: 100, dataTransfer: dt };
    box.ondragover(over);
    assert.strictEqual(over.defaultPrevented, true, '本文に落とせない形');
    assert.deepStrictEqual(box.querySelectorAll('.dropmark').map((e) => e.dataset.id), [rowIdOf(l, k2)], '落とす印が無い');
    await box.ondrop({ preventDefault() {}, clientY: 32, clientX: 100, dataTransfer: dt });
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('pageMove').map((c) => c.args), [[k3, 'pb1', undefined, { afterId: 'q2' }]], 'pageMove の1回で置かない');
    assert.deepStrictEqual(l.page('pb1').blocks.filter((b) => b.type === 'subpage').map((b) => b.page), [k1, k3, k2], 'q2 の下に置かない');
    assert.ok(subEl(l, k3) && !subEl(l, k3).classList.contains('gone'), '置いた行が本文に無い');
    assert.deepStrictEqual(kidRows().map((e) => e.textContent), ['📄 もう一つの子'], '置いた子が一覧に残る');
    assert.strictEqual(box.querySelectorAll('.dropmark, .dropmark-after').length, 0, '落とす印が残る');
    assert.strictEqual(listNow(l).find((p) => p.id === k3).parentId, 'pb1');
    // 素の文字（ページの印の無い引っ張り）は行の無い子を置かない（行の無い子の引っ張りの終わりが届かず、覚えた引っ張りが残っていても: R28 (1) と同じ）
    const n = l.called('pageMove').length;
    kidRows()[0].ondragstart({ target: kidRows()[0], clientX: 100, dataTransfer: { effectAllowed: '', setData() {} } });   // dragend は来ない
    const plain = { preventDefault() {}, clientY: 32, clientX: 100, dataTransfer: { types: ['text/plain'], getData: () => '' } };
    box.ondragover(plain);
    await box.ondrop(plain);
    await l.drain();
    assert.strictEqual(l.called('pageMove').length, n, 'ページの印の無い引っ張りで置いた');
    kidRows()[0].ondragend();
    // キーボード: Ctrl+Shift+↑ で本文の最後（最上位の並びの末尾）に置き、置いた行へフォーカス
    const k4row = kidRows()[0];
    k4row.focus();
    l.key({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, shiftKey: true }, k4row);
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('pageMove').slice(-1)[0].args, [k4, 'pb1', undefined, { afterId: 'q6' }]);
    assert.deepStrictEqual(l.page('pb1').blocks.slice(-1)[0].page, k4, '本文の最後に置かない');
    assert.strictEqual($(l, 'bodyKids').hidden, true, '置いても一覧が残る');
    assert.ok(l.document.activeElement === subEl(l, k4)._txt, '置いた行へフォーカスしない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 0.15.0 PR-2 直し 3（2026-11-04 の 0828257..a812237 の点検。計画の R45〜）
// 行の無い子 k3・k4 を作る（rowsDb の more）。作った後で本文の行を消す（前の版で行を消された子）
const lostTwo = (call) => {
  const out = {};
  for (const [k, title] of [['k3', '行の無い子'], ['k4', 'もう一つの子']]) {   // 利用者が付け直した題名（D77）
    out[k] = call('page.create', { parentId: 'pb1' }).id;
    call('page.setTitle', { id: out[k], title });
  }
  return out;
};
async function openLost(l, kids) {
  for (const k of kids) l.db.prepare('delete from blocks where id = ?').run(rowIdOf(l, k));
  l.fire('onPageOpen', 'pa1'); await l.drain();
  l.fire('onPageOpen', 'pb1'); await l.drain();
  rowOf(l, 'pb1').querySelector('.pi').dispatchEvent({ type: 'click' });   // サイドバーで pb1 を開いて子の行を出す
  await l.drain();
}
// 本文の行の箱（上端 0・10・20…・高さ 10）。左の端は本文の左 320 に段の字下げ（24px）を足した所（#pNote .blk の margin-left）
const bodyRects = (l, left = 320) => noteRows(l).forEach((e, i) => {
  const x = left + (Number(e.dataset.depth) || 0) * 24;
  e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: x, right: x + 400, width: 400 });
});
const pageDt = () => ({ effectAllowed: '', setData() {}, getData: () => '', types: [PAGE_TYPE] });
const sideDrag = (l, id, x) => rowOf(l, id).dispatchEvent({ type: 'dragstart', target: rowOf(l, id), clientX: x, dataTransfer: pageDt() });
const pageEv = (y, x) => ({ preventDefault() { this.defaultPrevented = true; }, clientY: y, clientX: x, dataTransfer: pageDt() });
const marks = (l) => $(l, 'pNote').querySelectorAll('.dropmark, .dropmark-after').map((e) => [e.dataset.id, e.classList.contains('dropshift')]);
const subsIn = (l) => flatB(l.page('pb1').blocks).filter((b) => b.type === 'subpage').map((b) => b.page);

test('PR-2 直し 3・R45: サイドバーから今の白紙のページの子を本文へ落とすと、段は上の行の ⠿（測れなければ行の左の端）からの横のずれで選ぶ（サイドバーで掴んだ所は見ない）。真下なら上の箇条書きの後ろ（最上位）・24px ほど右へ入れたときだけ上の行の子の頭', T, async () => {
  const l = await rowsDb({ more: lostTwo });
  try {
    const { k1, k2, k3, k4 } = l.made;
    await openLost(l, [k3, k4]);
    const box = $(l, 'pNote');
    // 点検の再現: サイドバーで x=40 で掴み、本文の箇条書き q2 の下（k2 の行の上半分）の x=320（q2 の行の左の端）へ
    sideDrag(l, k3, 40);
    bodyRects(l);
    const o1 = pageEv(32, 320);
    box.ondragover(o1);
    assert.strictEqual(o1.defaultPrevented, true, '本文に落とせない形');
    assert.deepStrictEqual(marks(l), [[rowIdOf(l, k2), false]], '段をずらした印を出した（サイドバーで掴んだ所からのずれを見た）');
    await box.ondrop(pageEv(32, 320));
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('pageMove').map((c) => c.args), [[k3, 'pb1', undefined, { afterId: 'q2' }]], 'q2 の後ろでなく子にした');
    assert.deepStrictEqual(subsIn(l), [k1, k3, k2]);
    assert.deepStrictEqual(l.page('pb1').blocks.find((b) => b.id === 'q2').children || [], [], 'q2 の子になった');
    // 上の行の左の端から 30px 右へ入れると、q2 の子の頭（印は字下げして出る）
    sideDrag(l, k4, 40);
    bodyRects(l);
    box.ondragover(pageEv(32, 350));
    assert.deepStrictEqual(marks(l), [[rowIdOf(l, k3), true]], '右へ入れても段をずらした印が無い');
    // ⠿ を測れれば ⠿ の真ん中から（⠿ が 346〜358 なら、350 は上の行の後ろ・376 で上の行の子）
    const grip = noteRows(l).find((e) => e.dataset.id === 'q2').querySelector('.grip');
    grip._rect = { left: 346, width: 12, top: 20, height: 10 };
    box.ondragover(pageEv(32, 350));
    assert.deepStrictEqual(marks(l), [[rowIdOf(l, k3), false]], '⠿ の上なのに段をずらした');
    box.ondragover(pageEv(32, 376));
    assert.deepStrictEqual(marks(l), [[rowIdOf(l, k3), true]]);
    await box.ondrop(pageEv(32, 376));
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('pageMove').map((c) => c.args)[1], [k4, 'pb1', undefined, { afterId: '', parentId: 'q2' }], 'q2 の子の頭に置かない');
    assert.deepStrictEqual(l.page('pb1').blocks.find((b) => b.id === 'q2').children.map((b) => b.page), [k4]);
    assert.strictEqual(subEl(l, k4).dataset.parent, 'q2');
    assert.strictEqual(listNow(l).find((p) => p.id === k4).parentId, 'pb1', 'ページの親が替わった');
    assert.deepStrictEqual(marks(l), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2 直し 3・R46: サイドバーから本文にもう行のある子を引っ張ると、落とす所はその子の行を除いて数える（自分の行に印を出さない・自分の行の後ろを送らない）。今の所に落としても「ページの行を置けませんでした。」を出さない', T, async () => {
  const l = await rowsDb();
  try {
    const { k1, k2, tp } = l.made;
    rowOf(l, 'pb1').querySelector('.pi').dispatchEvent({ type: 'click' });
    await l.drain();
    const box = $(l, 'pNote');
    sideDrag(l, k2, 40);
    bodyRects(l);
    // 見えている行 q1 k1 q2 k2 下の文…。k2 の行（上端 30）の上半分: 自分の行は数えないので、印は次の行（下の文）
    box.ondragover(pageEv(32, 320));
    assert.deepStrictEqual(marks(l), [[tp, false]], '引っ張っている子の行に印を出した');
    // k2 の行の下半分（今の所）: 自分の行の後ろでなく、上に見えている q2 の後ろ
    await box.ondrop(pageEv(38, 320));
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('pageMove').map((c) => c.args), [[k2, 'pb1', undefined, { afterId: 'q2' }]], '自分の行の後ろを送った');
    assert.notStrictEqual(toastText(l), 'ページの行を置けませんでした。');
    assert.deepStrictEqual(subsIn(l), [k1, k2]);
    assert.ok(subEl(l, k2) && !subEl(l, k2).classList.contains('gone'));
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2 直し 3・R47: サイドバーや「このページの中のページ」からの引っ張りを本文の上でやめる（dragend・Esc）と、本文の落とす印も消える。やめた後は落としても置かない', T, async () => {
  const l = await rowsDb({ more: lostTwo });
  try {
    const { k3 } = l.made;
    await openLost(l, [k3]);
    const box = $(l, 'pNote');
    const overBody = () => { bodyRects(l); box.ondragover(pageEv(32, 320)); return marks(l).length; };
    // サイドバーの行の dragend
    sideDrag(l, k3, 40);
    assert.strictEqual(overBody(), 1);
    rowOf(l, k3).dispatchEvent({ type: 'dragend' });
    assert.deepStrictEqual(marks(l), [], 'サイドバーの引っ張りの dragend で本文の印が残る');
    // サイドバーの引っ張りの Esc
    sideDrag(l, k3, 40);
    assert.strictEqual(overBody(), 1);
    l.key({ key: 'Escape' });
    assert.deepStrictEqual(marks(l), [], 'Esc で本文の印が残る');
    assert.strictEqual(overBody(), 0, 'Esc の後も落とす印を出す');
    await box.ondrop(pageEv(32, 320));
    await l.drain();
    // 「このページの中のページ」の行の引っ張りの Esc
    const kr = $(l, 'bodyKids').querySelectorAll('.kidrow')[0];
    kr.dispatchEvent({ type: 'dragstart', target: kr, clientX: 100, dataTransfer: pageDt() });
    assert.strictEqual(overBody(), 1);
    l.key({ key: 'Escape' });
    assert.deepStrictEqual(marks(l), [], '一覧の行の引っ張りの Esc で本文の印が残る');
    kr.dispatchEvent({ type: 'dragend' });
    assert.deepStrictEqual(l.called('pageMove'), [], 'やめた引っ張りで置いた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2 直し 3・R48 (1): 今の白紙のページの子でないページ（最上位の議事録・ほかのページの子）をサイドバーから本文の上へ引っ張っても、落とす印を出さず、落としても page.move を呼ばない', T, async () => {
  const l = await rowsDb({ more: (call) => ({ g1: call('page.create', { parentId: call('pages.list', {}).find((p) => p.title === '週の予定').id }).id }) });
  try {
    const { k1, g1 } = l.made;
    rowOf(l, 'pb1').querySelector('.pi').dispatchEvent({ type: 'click' });
    await l.drain();
    rowOf(l, k1).querySelector('.pi').dispatchEvent({ type: 'click' });   // 孫 g1 を出す
    await l.drain();
    const box = $(l, 'pNote');
    for (const id of ['pa1', g1]) {
      sideDrag(l, id, 40);
      bodyRects(l);
      box.ondragover(pageEv(32, 320));
      assert.deepStrictEqual(marks(l), [], `${id} の引っ張りに落とす印を出した`);
      await box.ondrop(pageEv(32, 320));
      await l.drain(); await l.drain();
      rowOf(l, id).dispatchEvent({ type: 'dragend' });
    }
    assert.deepStrictEqual(l.called('pageMove'), [], '今のページの子でないページを本文に置いた');
    assert.deepStrictEqual(subsIn(l), [k1, l.made.k2]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2 直し 3・R48 (2): 本文が 2,000 行の白紙のページで行の無い子を置こうとすると「本文が 2,000 行に達しているので、ページの行を置けません。」（本文も「このページの中のページ」も変わらない）', T, async () => {
  const N = 2000;
  const big = Array.from({ length: N }, (_, i) => ({ id: `fz${i}`, type: 'paragraph', text: `行${i}` }));
  const l = await openDb({ blanks: [BLANK('pf1', '大きな本文', big)], open: 'pf1', before: (call) => {
    const k = call('page.create', { parentId: 'pf1' }).id;   // 行は置かない（R33）
    call('page.setTitle', { id: k, title: '行の無い子' });   // 利用者が付け直した題名（D77）
    return { k };
  } });
  try {
    const { k } = l.made;
    const kr = $(l, 'bodyKids').querySelectorAll('.kidrow')[0];
    assert.strictEqual(kr.textContent, '📄 行の無い子');
    kr.focus();
    l.key({ key: 'ArrowUp', code: 'ArrowUp', ctrlKey: true, shiftKey: true }, kr);
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('pageMove').map((c) => c.args), [[k, 'pf1', undefined, { afterId: `fz${N - 1}` }]]);
    assert.strictEqual(toastText(l), '本文が 2,000 行に達しているので、ページの行を置けません。');
    assert.strictEqual(l.page('pf1').blocks.length, N, '本文が変わった');
    assert.deepStrictEqual($(l, 'bodyKids').querySelectorAll('.kidrow').map((e) => e.textContent), ['📄 行の無い子'], '一覧から消えた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('PR-2 直し 3・R48 (3): 「このページの中のページ」の行をトグルの下へ右へずらして落とすと、トグルの子の頭に置く（pageMove の row の parentId・rowParent）', T, async () => {
  const l = await rowsDb({ more: (call) => {
    const out = lostTwo(call);
    const tp = call('page.get', { id: 'pb1' }).page.blocks.find((b) => b.text === '下の文').id;
    out.tg = call('block.insert', { pageId: 'pb1', afterBlockId: tp, type: 'toggle' }).blockId;
    call('block.update', { pageId: 'pb1', blockId: out.tg, patch: { text: 'まとめ' } });
    return out;
  } });
  try {
    const { k3, k4, tg } = l.made;
    await openLost(l, [k3, k4]);
    const box = $(l, 'pNote');
    assert.deepStrictEqual(noteRows(l).map((e) => e.dataset.id).slice(4, 7), [l.made.tp, tg, 'q3']);
    const kr = $(l, 'bodyKids').querySelectorAll('.kidrow')[0];
    kr.dispatchEvent({ type: 'dragstart', target: kr, clientX: 100, dataTransfer: pageDt() });
    bodyRects(l);
    // q3 の行（上端 60）の上半分・トグルの行の左の端から 30px 右
    box.ondragover(pageEv(62, 350));
    assert.deepStrictEqual(marks(l), [['q3', true]]);
    await box.ondrop(pageEv(62, 350));
    await l.drain(); await l.drain();
    assert.deepStrictEqual(l.called('pageMove').map((c) => c.args), [[k3, 'pb1', undefined, { afterId: '', parentId: tg }]]);
    assert.deepStrictEqual(l.page('pb1').blocks.find((b) => b.id === tg).children.map((b) => b.page), [k3], 'トグルの子の頭に置かない');
    assert.strictEqual(subEl(l, k3).dataset.parent, tg);
    assert.strictEqual(subEl(l, k3).dataset.depth, '1');
    assert.ok(l.document.activeElement === subEl(l, k3)._txt, '置いた行へフォーカスしない');
    assert.deepStrictEqual($(l, 'bodyKids').querySelectorAll('.kidrow').map((e) => e.textContent), ['📄 もう一つの子']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
