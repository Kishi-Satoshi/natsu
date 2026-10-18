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
