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
  assert.deepStrictEqual([flat.className, flat.querySelector('.pi').textContent, flat.querySelector('.tw'), flat.style.paddingLeft, flat.getAttribute('aria-expanded')],
    ['pitem', '🎙️', null, undefined, null], '子の無い行の形が変わった');
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
  const l = await boot();
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
  assert.strictEqual(l.document.activeElement, menuOf().querySelectorAll('.mitem')[0], 'メニューの1つ目にフォーカスが無い');
  l.key({ key: 'ArrowDown' }, menuOf());
  assert.strictEqual(l.document.activeElement.textContent, '新しいタブで開く');
  l.key({ key: 'Escape' }, menuOf());
  await l.drain();
  assert.deepStrictEqual([menuOf(), focused(l)], [null, 'pa2'], 'Esc で閉じて行へ戻らない');
  await key(l, 'pa2', { key: 'F10', shiftKey: true });
  assert.ok(menuOf(), 'Shift+F10 で行のメニューが出ない');
  menuOf().querySelectorAll('.mitem')[0].dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('pageCreate').map((c) => c.args), [['pa1'], ['pa2']], '［中にページを作る］が行の中に作らない');
  assert.strictEqual(menuOf(), null);
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
  const over = (id, y) => { let prevented = false; rowOf(l, id).dispatchEvent({ type: 'dragover', clientY: y, preventDefault() { prevented = true; } }); return prevented; };
  const drop = (id, y) => rowOf(l, id).dispatchEvent({ type: 'drop', clientY: y, preventDefault() {} });
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
