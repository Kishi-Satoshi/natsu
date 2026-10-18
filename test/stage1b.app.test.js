/*
 * stage1b.app.test.js — 第1b回の画面（サイドバー・上のタブ・ページ・録音中のページ・一時停止・キーボード）を、最小 DOM の上で本当に走らせて確かめる
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const preloadWith = (...names) => names.reduce((src, n) => (new RegExp(`^\\s+${n}\\s*:`, 'm').test(src) ? src
  : src.replace("exposeInMainWorld('koeApp', {", `exposeInMainWorld('koeApp', {\n  ${n}: (...a) => ipcRenderer.invoke('test:${n}', ...a),`)), PRELOAD);
const P1B = preloadWith('uiState', 'uiSave', 'meetingSetPaused');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const LIST = [{ id: 'pa1', title: '定例（見本）', date: '10/16', durationSec: 1800, hasSummary: true }, { id: 'pb2', title: '設計の打ち合わせ（見本）', date: '10/15', durationSec: 900, hasSummary: false },
  { id: 'pc3', title: '週の振り返り（見本）', date: '10/14', durationSec: 600, hasSummary: false }];
const PAGE = (id) => ({ page: { id, title: LIST.find((p) => p.id === id).title, createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
const open = (o = {}) => load(APP, { preloadSrc: P1B, returns: { pagesSearch: () => LIST, pageGet: PAGE, uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' } }), ...o } });
const saves = (l) => l.called('uiSave').map((c) => c.args[0]);

test('N2: サイドバーは議事録のタブの外にいて、上から NaTsu・検索・記録開始・議事録の一覧、下に音声入力と設定', async () => {
  const l = await open();
  await l.drain();
  const side = l.byId.get('side');
  assert.ok(side && !side.closest('#tabNotes'), 'サイドバーが議事録のタブの中にある（ほかのタブで消える）');
  const order = ['wordmark', 'searchBox', 'mtToggleBtn', 'tabBtnNotes', 'plist', 'tabBtnDictation', 'tabBtnSettings'];
  const all = side._walk([]);
  const at = (k) => all.findIndex((e) => e.id === k || e.className === k);
  assert.deepStrictEqual(order.map(at).filter((i) => i < 0), [], '足りない部品がある');
  assert.deepStrictEqual(order.map(at), [...order.map(at)].sort((a, b) => a - b), '並びが違う');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('N2: 幅はつまみのドラッグで 200〜480 に寄せて変え、離したときに覚える。←／→ でも 16px ずつ', async () => {
  const l = await open();
  await l.drain();
  const g = l.byId.get('sideGrip');
  g.dispatchEvent({ type: 'pointerdown', clientX: 260, pointerId: 1 });
  g.dispatchEvent({ type: 'pointermove', clientX: 900, pointerId: 1 });
  g.dispatchEvent({ type: 'pointerup', clientX: 900, pointerId: 1 });
  await l.drain();
  assert.strictEqual(l.byId.get('side').style.width, '480px');
  assert.deepStrictEqual(saves(l).pop(), { sidebar: { width: 480, collapsed: false } });
  g.dispatchEvent({ type: 'keydown', key: 'ArrowLeft' });
  await l.drain();
  assert.strictEqual(l.byId.get('side').style.width, '464px');
  assert.strictEqual(g.getAttribute('aria-valuenow'), '464');
});

test('N2: « で畳み、» と Ctrl+\\ で出す。畳みも覚え、起動のときに覚えた幅と畳みで出る', async () => {
  const l = await open({ uiState: () => ({ sidebar: { width: 320, collapsed: true }, tabs: { open: [], active: '' } }) });
  await l.drain();
  assert.ok(l.byId.get('side').closest('.app').className.includes('side-collapsed'), '覚えた畳みで出ていない');
  assert.strictEqual(l.byId.get('sideExpand').hidden, false);
  l.key({ key: '\\', ctrlKey: true });
  await l.drain();
  assert.ok(!l.byId.get('side').closest('.app').className.includes('side-collapsed'));
  assert.strictEqual(l.byId.get('side').style.width, '320px');
  l.byId.get('sideCollapse').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(saves(l).pop(), { sidebar: { width: 320, collapsed: true } });
});

test('N2: uiState の無い古い preload でも、サイドバーは既定の幅で出て落ちない', async () => {
  const OLD = PRELOAD.replace(/^\s+ui(State|Save)\s*:.*\n/gm, '');   // A-2 の後も「無い」形で見る
  const l = await load(APP, { preloadSrc: OLD, returns: { pagesSearch: () => LIST } });
  await l.drain();
  assert.strictEqual(l.byId.get('side').style.width, '260px');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

const tabs = (l) => l.byId.get('tabbar').querySelectorAll('[role="tab"]');
const keysOf = (l) => tabs(l).map((t) => t.dataset.key);
const row = (l, i) => l.byId.get('plist').querySelectorAll('.pitem')[i];

test('N3: 一覧を押すと今のページのタブで開き、Ctrl+クリックと中クリックは新しいタブで開いて移る。中身は showTab と openPage（pageGet）', async () => {
  const l = await open();
  await l.drain();
  row(l, 0).dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pa1']);
  row(l, 1).dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pb2'], '普通のクリックでタブが増えた');
  row(l, 0).dispatchEvent({ type: 'click', ctrlKey: true });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pb2', 'page:pa1']);
  assert.strictEqual(tabs(l)[1].getAttribute('aria-selected'), 'true');
  assert.ok(l.byId.get('tabNotes').className.includes('active'));
  assert.deepStrictEqual(l.called('pageGet').map((c) => c.args[0]), ['pa1', 'pb2', 'pa1']);
  row(l, 2).dispatchEvent({ type: 'auxclick', button: 1 });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pb2', 'page:pa1', 'page:pc3'], '中クリックで新しいタブにならない');
  assert.strictEqual(tabs(l)[2].getAttribute('aria-selected'), 'true');
  row(l, 1).dispatchEvent({ type: 'auxclick', button: 1 });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pb2', 'page:pa1', 'page:pc3'], '同じページのタブを2つ作った（そのタブに移るはず）');
  assert.strictEqual(tabs(l)[0].getAttribute('aria-selected'), 'true');
});

test('N3: 音声入力と設定もタブで開き（1つずつ）、× と中クリックで閉じる。選んでいたタブを閉じたら隣へ移り、全部閉じたら空のページ', async () => {
  const l = await open();
  await l.drain();
  l.byId.get('tabBtnSettings').dispatchEvent({ type: 'click' });
  l.byId.get('tabBtnDictation').dispatchEvent({ type: 'click' });
  l.byId.get('tabBtnSettings').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['settings', 'dictation']);
  assert.ok(l.byId.get('tabSettings').className.includes('active'));
  tabs(l)[0].querySelector('button').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['dictation']);
  assert.ok(l.byId.get('tabDictation').className.includes('active'), '隣のタブへ移っていない');
  tabs(l)[0].dispatchEvent({ type: 'auxclick', button: 1 });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), []);
  assert.match(l.byId.get('pNote').textContent, /左の一覧から議事録を選んでください/);
});

test('N3・N6・F7: 起動のときに覚えたタブを開いて選んでいたタブに移り、変わるたびに覚える', async () => {
  const l = await open({ uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: ['page:pa1', 'settings'], active: 'page:pa1' } }) });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pa1', 'settings']);
  assert.strictEqual(tabs(l)[0].textContent.includes('定例（見本）'), true, 'タブの名前がページの題名でない');
  assert.deepStrictEqual(l.called('pageGet').map((c) => c.args[0]), ['pa1']);
  l.byId.get('tabBtnDictation').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(saves(l).pop(), { tabs: { open: ['page:pa1', 'settings', 'dictation'], active: 'dictation' } });
});

test('N3・F8: タブを替える前に書きかけの題名を元のページへ保存する（blur は来ない）', async () => {
  const l = await open();
  await l.drain();
  row(l, 0).dispatchEvent({ type: 'click' });
  await l.drain();
  l.byId.get('pTitle').textContent = '直した題名';
  l.byId.get('tabBtnSettings').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('pageSetTitle').map((c) => c.args), [['pa1', '直した題名']]);
});

test('N3・画面の使いやすさ: タブの帯は ←／→／Home／End で移り（選んでいるタブだけ Tab で届く）、Ctrl+Tab で次のタブ', async () => {
  const l = await open({ uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: ['page:pa1', 'dictation', 'settings'], active: 'page:pa1' } }) });
  await l.drain();
  assert.deepStrictEqual(tabs(l).map((t) => t.tabIndex), [0, -1, -1]);
  tabs(l)[0].dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
  await l.drain();
  assert.strictEqual(l.document.activeElement, tabs(l)[1]);
  assert.ok(l.byId.get('tabDictation').className.includes('active'));
  tabs(l)[1].dispatchEvent({ type: 'keydown', key: 'End' });
  await l.drain();
  assert.ok(l.byId.get('tabSettings').className.includes('active'));
  l.key({ key: 'Tab', ctrlKey: true });
  await l.drain();
  assert.ok(l.byId.get('tabNotes').className.includes('active'), 'Ctrl+Tab で最初へ回らない');
});

test('N3・F7（足した守り）: 消したページのタブを残さず隣へ移り、開けないページ（幽霊行）のタブは作らずに今のページのまま', async () => {
  const l = await open({ pageGet: (id) => (id === 'pc3' ? null : PAGE(id)) });
  await l.drain();
  row(l, 0).dispatchEvent({ type: 'click' });
  await l.drain();
  row(l, 1).dispatchEvent({ type: 'click', ctrlKey: true });
  await l.drain();
  row(l, 2).dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pa1', 'page:pb2'], '開けないページのタブが残った');
  assert.strictEqual(tabs(l)[1].getAttribute('aria-selected'), 'true');
  assert.strictEqual(l.byId.get('pTitle').textContent, '設計の打ち合わせ（見本）', '開いていたページが消えた');
  l.window.confirm = () => true;
  l.byId.get('pActs').querySelectorAll('button').find((b) => b.textContent === '削除').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('pageDelete').map((c) => c.args[0]), ['pb2']);
  assert.deepStrictEqual(keysOf(l), ['page:pa1'], '消したページのタブが残った');
  assert.strictEqual(l.byId.get('pTitle').textContent, '定例（見本）');
  assert.deepStrictEqual(saves(l).pop(), { tabs: { open: ['page:pa1'], active: 'page:pa1' } });
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
