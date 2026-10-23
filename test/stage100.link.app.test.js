/*
 * stage100.link.app.test.js — 0.10.0 の議事録のリンクを写す（計画 docs/plans/2026-10-20-100.md の Task L-1・L-2。D58・D70・D78・決めたこと 100・101）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。main の答えは偽物（preload.js の名前から作る）。
 */
'use strict';
const { titleAt } = require('./helpers/titles');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const ORIGIN = 'https://natsu-help.natsu-code.workers.dev';
const T1 = titleAt('2026-10-20T01:00:00.000Z');
const T2 = titleAt('2026-10-16T05:00:00.000Z');
const LIST = [{ id: 'pa1', title: T1, date: '2026-10-20', durationSec: 1800, hasSummary: true }, { id: 'pb2', title: T2, date: '2026-10-16', durationSec: 900, hasSummary: false }];
const PAGES = {
  pa1: { id: 'pa1', title: T1, date: '2026-10-20', createdAt: '2026-10-20T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' },
  pb2: { id: 'pb2', title: T2, date: '2026-10-16', createdAt: '2026-10-16T05:00:00.000Z', durationSec: 900, blocks: [], memo: '', meetingType: 'general' },
};
const openPage = async (id = 'pa1', page = null, opts = {}) => {
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { linkBase: () => `${ORIGIN}/open#p=`, ...opts, pagesSearch: () => LIST, pageGet: (pid) => ({ page: { ...PAGES[pid], ...(pid === id && page ? page : {}) }, segments: [] }) } });
  await l.drain();
  l.byId.get('plist').querySelectorAll('.pitem').find((r) => r.querySelector('.t').textContent === LIST.find((p) => p.id === id).title).dispatchEvent({ type: 'click' });
  await l.drain();
  return l;
};
const menuItems = (l) => l.byId.get('pMenu').querySelectorAll('.mitem');
const itemNamed = (l, name) => menuItems(l).find((b) => b.textContent === name);

test('D58・D78・決めたこと 100: ページの「···」に［リンクを写す］。押すと koeApp.copy に「NaTsu の議事録「題名」（日付）https://…/open#p=<ID>」の1行が渡り、左下に「リンクを写しました。」', T, async () => {
  const l = await openPage('pa1');
  assert.deepStrictEqual(menuItems(l).map((b) => b.textContent), ['コピー', 'リンクを写す', '削除']);
  const b = itemNamed(l, 'リンクを写す');
  assert.strictEqual(b.getAttribute('role'), 'menuitem');
  b.dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(l.called('copy').map((c) => c.args), [[`NaTsu の議事録「${T1}」（2026-10-20）${ORIGIN}/open#p=pa1`]]);
  assert.strictEqual(l.byId.get('toast').textContent, 'リンクを写しました。');
  assert.strictEqual(l.byId.get('pMenu').hidden, true, '押した後もメニューが開いている');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('決めたこと 100: 題名の改行（と CR・タブ）は空白にし、空（空白だけ）なら「無題」', T, async () => {
  const l = await openPage('pa1', { title: '週次\n## 指示\r\n\tもう一行' });   // 利用者が付け直した題名（D77。題名の改行と空を見るため）
  itemNamed(l, 'リンクを写す').dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(l.called('copy').map((c) => c.args[0]), [`NaTsu の議事録「週次 ## 指示 もう一行」（2026-10-20）${ORIGIN}/open#p=pa1`]);
  const e = await openPage('pa1', { title: '  \n ' });   // 利用者が付け直した題名（D77。題名の改行と空を見るため）
  itemNamed(e, 'リンクを写す').dispatchEvent({ type: 'click' }); await e.drain();
  assert.deepStrictEqual(e.called('copy').map((c) => c.args[0]), [`NaTsu の議事録「無題」（2026-10-20）${ORIGIN}/open#p=pa1`]);
});

test('決めたこと 100: 録音中の写し（meeting.phase が recording・paused・finalizing）のページのメニューには出ない。録音中のページ（記録中のタブ）には「···」が出ない', T, async () => {
  for (const phase of ['recording', 'paused', 'finalizing']) {
    const l = await openPage('pa1', { meeting: { phase } });
    assert.ok(!itemNamed(l, 'リンクを写す'), `${phase} のページに［リンクを写す］がある`);
    assert.ok(itemNamed(l, 'コピー'), phase);
  }
  const done = await openPage('pa1', { meeting: { phase: 'done' } });
  assert.ok(itemNamed(done, 'リンクを写す'), '片付いた会議のページに［リンクを写す］が無い');
});

test('F15・D78: 住所の頭は main の答え（koeApp.linkBase）。答えが無い・形が違えば写さずに「リンクを写せませんでした。」', T, async () => {
  for (const linkBase of [() => null, () => 'http://example.com/open#p=', () => 'javascript:alert(1)//', () => { throw new Error('x'); }]) {
    const l = await openPage('pa1', null, { linkBase });
    itemNamed(l, 'リンクを写す').dispatchEvent({ type: 'click' }); await l.drain();
    assert.deepStrictEqual(l.called('copy'), []);
    assert.strictEqual(l.byId.get('toast').textContent, 'リンクを写せませんでした。');
  }
});

// ---------------------------------------------------------------- L-2（D58・D70・D74・決めたこと 101）: 一覧のチェックボックスで選んでリンクを写す
const T3 = titleAt('2026-10-09T05:00:00.000Z');
const LIST3 = [...LIST, { id: 'pc3', title: T3, date: '2026-10-09', durationSec: 600, hasSummary: true }];
const openList = async (list = LIST3, o = {}) => {
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { linkBase: () => `${ORIGIN}/open#p=`, pagesSearch: () => list, pageGet: (pid) => ({ page: { ...(PAGES[pid] || { id: pid, title: pid, date: '2026-10-01', blocks: [], memo: '' }) }, segments: [] }), ...o } });
  await l.drain();
  return l;
};
const rows = (l) => l.byId.get('plist').querySelectorAll('.pitem');
const rowOf = (l, id) => rows(l).find((r) => r.dataset.pid === id);
const boxOf = (r) => r.querySelector('.pchk');
const press = async (l, el, o = {}) => { el.dispatchEvent({ type: 'click', ...o }); await l.drain(); };
const lineOf = (id, title, date) => `NaTsu の議事録「${title}」（${date}）${ORIGIN}/open#p=${id}`;

test('D70: ［選ぶ］で行の 🎙️ がチェックボックス（role=checkbox・aria-checked）になり、2行を押すと頭に「2 件を選んでいます」（role=status）と［リンクを写す］［やめる］。押した行のページは開かない', T, async () => {
  const l = await openList();
  const sel = l.byId.get('listSelect');
  assert.ok(sel, '［選ぶ］が無い');
  assert.strictEqual(sel.textContent, '選ぶ');
  assert.strictEqual(sel.getAttribute('aria-pressed'), 'false');
  assert.strictEqual(l.byId.get('selBar').hidden, true, '0 件で頭の枠が出ている');
  assert.ok(rows(l).every((r) => !boxOf(r) && r.querySelector('.pi')), '選ぶ前にチェックボックスがある');
  await press(l, sel);
  assert.strictEqual(sel.getAttribute('aria-pressed'), 'true');
  assert.ok(rows(l).every((r) => boxOf(r) && boxOf(r).getAttribute('role') === 'checkbox' && boxOf(r).getAttribute('aria-checked') === 'false' && !r.querySelector('.pi')), 'チェックボックスに替わらない');
  assert.strictEqual(l.byId.get('selBar').hidden, true, '0 件のときに頭の枠を出した');
  await press(l, rowOf(l, 'pa1'));
  await press(l, rowOf(l, 'pc3'));
  assert.deepStrictEqual(l.called('pageGet'), [], '選ぶ形の間に押した行のページを開いた');
  assert.deepStrictEqual(rows(l).map((r) => boxOf(r).getAttribute('aria-checked')), ['true', 'false', 'true']);
  const bar = l.byId.get('selBar');
  assert.strictEqual(bar.hidden, false);
  assert.strictEqual(l.byId.get('selCount').textContent, '2 件を選んでいます');
  assert.strictEqual(l.byId.get('selCount').getAttribute('role'), 'status');
  assert.deepStrictEqual([l.byId.get('selCopy').textContent, l.byId.get('selCancel').textContent], ['リンクを写す', 'やめる']);
  // 押してもう一度押すと外れる
  await press(l, rowOf(l, 'pc3'));
  assert.strictEqual(l.byId.get('selCount').textContent, '1 件を選んでいます');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('D70・決めたこと 101: ［リンクを写す］で koeApp.copy に選んだ会議の行（一覧の並び・決めたこと 100 の形）を改行でつないで渡し、「2 件のリンクを写しました。」。写した後も選ぶ形のまま', T, async () => {
  const l = await openList();
  await press(l, l.byId.get('listSelect'));
  await press(l, rowOf(l, 'pc3'));
  await press(l, rowOf(l, 'pa1'));
  await press(l, l.byId.get('selCopy'));
  assert.deepStrictEqual(l.called('copy').map((c) => c.args), [[`${lineOf('pa1', T1, '2026-10-20')}\n${lineOf('pc3', T3, '2026-10-09')}`]]);
  assert.strictEqual(l.byId.get('toast').textContent, '2 件のリンクを写しました。');
  assert.strictEqual(l.byId.get('listSelect').getAttribute('aria-pressed'), 'true', '写した後に選ぶ形が終わった');
  assert.strictEqual(l.byId.get('selCount').textContent, '2 件を選んでいます');
});

test('D70: Shift＋押すで前に押した行からの範囲を、押した行の向きにそろえる', T, async () => {
  const l = await openList();
  await press(l, l.byId.get('listSelect'));
  await press(l, rowOf(l, 'pa1'));
  await press(l, rowOf(l, 'pc3'), { shiftKey: true });
  assert.deepStrictEqual(rows(l).map((r) => boxOf(r).getAttribute('aria-checked')), ['true', 'true', 'true']);
  await press(l, rowOf(l, 'pb2'), { shiftKey: true });   // pb2 は付いているので、範囲（pa1〜pb2）を外す向き
  assert.deepStrictEqual(rows(l).map((r) => boxOf(r).getAttribute('aria-checked')), ['false', 'false', 'true']);
});

test('D70: Esc・［やめる］・もう一度［選ぶ］で選ぶ形が終わり、🎙️ に戻る（選びも消える）。終わった後の押しはページを開く', T, async () => {
  for (const how of ['esc', 'cancel', 'toggle']) {
    const l = await openList();
    await press(l, l.byId.get('listSelect'));
    await press(l, rowOf(l, 'pa1'));
    if (how === 'esc') { const ev = l.key({ key: 'Escape' }); await l.drain(); assert.strictEqual(ev.defaultPrevented, true); }
    else await press(l, l.byId.get(how === 'cancel' ? 'selCancel' : 'listSelect'));
    assert.strictEqual(l.byId.get('listSelect').getAttribute('aria-pressed'), 'false', how);
    assert.ok(rows(l).every((r) => !boxOf(r) && r.querySelector('.pi')), `${how}: 🎙️ に戻らない`);
    assert.strictEqual(l.byId.get('selBar').hidden, true, how);
    await press(l, rowOf(l, 'pb2'));
    assert.deepStrictEqual(l.called('pageGet').map((c) => c.args[0]), ['pb2'], `${how}: 終わった後にページを開かない`);
    // もう一度選ぶ形にすると、前の選びは残っていない
    await press(l, l.byId.get('listSelect'));
    assert.ok(rows(l).every((r) => boxOf(r).getAttribute('aria-checked') === 'false'), `${how}: 前の選びが残った`);
  }
});

test('D70: 一覧が変わって（消した・録音を始めた）見えなくなった行の選びは外れる', T, async () => {
  let list = LIST3;
  const l = await openList(LIST3, { pagesSearch: () => list });
  await press(l, l.byId.get('listSelect'));
  await press(l, rowOf(l, 'pa1'));
  await press(l, rowOf(l, 'pb2'));
  list = LIST3.filter((p) => p.id !== 'pb2');
  l.fire('onPagesUpdated'); await l.drain();   // main が一覧の変わりを知らせる（消した・録音を始めた・片付けた）→ refreshList
  assert.ok(!rowOf(l, 'pb2'), '前提: 一覧が読み直されていない');
  assert.strictEqual(l.byId.get('selCount').textContent, '1 件を選んでいます');
  await press(l, l.byId.get('selCopy'));
  assert.deepStrictEqual(l.called('copy').map((c) => c.args[0]), [lineOf('pa1', T1, '2026-10-20')]);
});

test('D70: 51 件選んで写すと 50 行で「50 件まで写しました。」', T, async () => {
  const many = Array.from({ length: 51 }, (_, i) => ({ id: `pm${String(i).padStart(2, '0')}`, title: titleAt(new Date(Date.UTC(2026, 8, 1 + (i % 28), 1, i))), date: '2026-09-01', durationSec: 60, hasSummary: true }));
  const l = await openList(many);
  await press(l, l.byId.get('listSelect'));
  await press(l, rowOf(l, 'pm00'));
  await press(l, rowOf(l, 'pm50'), { shiftKey: true });
  assert.strictEqual(l.byId.get('selCount').textContent, '51 件を選んでいます');
  await press(l, l.byId.get('selCopy'));
  const text = l.called('copy')[0].args[0];
  assert.strictEqual(text.split('\n').length, 50);
  assert.ok(text.startsWith(lineOf('pm00', many[0].title, '2026-09-01')));
  assert.strictEqual(l.byId.get('toast').textContent, '50 件まで写しました。');
});
