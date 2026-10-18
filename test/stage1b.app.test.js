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

// ---- Task B-4（N4・F13）: ページの見た目 ----
const openPa1 = async (o = {}) => { const l = await open(o); await l.drain(); row(l, 0).dispatchEvent({ type: 'click' }); await l.drain(); return l; };
const propRows = (l) => l.byId.get('pageWrap').querySelectorAll('.prop').map((r) => [r.querySelector('.k').textContent, r.querySelector('.v').textContent]);

test('N4: プロパティは「アイコン・名前・値」の行。要約タイプの選び方もこの行にあり、第1c回の経路の行は名前と値に分ける', async () => {
  const l = await openPa1({ pageGet: (id) => ({ ...PAGE(id), page: { ...PAGE(id).page, citeStat: { linked: 2, total: 2 }, routeText: ['☁ 文字起こし: クラウド（Groq（無料枠））2', '✨ 要約: Claude Code'] } }) });
  const rows = propRows(l);
  assert.match(rows.find((r) => r[0] === '🔗 出典')[1], /✔ 2\/2/, '出典がそろったことを色だけで伝えている');
  assert.ok(rows.map((r) => r[0]).filter((k) => /作成日時|長さ|区間|要約タイプ|文字起こし|要約$/.test(k)).length >= 6, JSON.stringify(rows));
  assert.deepStrictEqual(rows.find((r) => r[0] === '☁ 文字起こし'), ['☁ 文字起こし', 'クラウド（Groq（無料枠））2']);
  assert.ok(l.byId.get('pType').closest('.prop'), '要約タイプがプロパティの行に無い');
});

test('N4: 要約・文字起こし・メモは細いタブ（role=tab・aria-selected）。操作は主ボタン1つと「…」の中のコピーと削除', async () => {
  const l = await openPa1();
  assert.strictEqual(l.byId.get('paneBtnNote').textContent, '要約');
  assert.strictEqual(l.byId.get('paneBtnScript').getAttribute('aria-selected'), 'true', '要点の無いページは文字起こしで開く（今と同じ）');
  const acts = l.byId.get('pActs');
  const visible = acts.querySelectorAll('button').filter((b) => !b.closest('#pMenu'));
  assert.deepStrictEqual(visible.map((b) => b.id || b.textContent), ['要約を生成', 'pMore']);
  assert.deepStrictEqual(l.byId.get('pMenu').querySelectorAll('[role="menuitem"]').map((b) => b.textContent), ['コピー', '削除']);
  assert.strictEqual(l.byId.get('pMenu').hidden, true);
});

test('N4・画面の使いやすさ: 「…」は Enter で開いて最初の項目へ、↓で次、Esc で閉じて「…」へ戻る。コピーは今までどおり開いているタブの中身', async () => {
  const l = await openPa1();
  const more = l.byId.get('pMore');
  more.dispatchEvent({ type: 'keydown', key: 'Enter' });
  await l.drain();
  const items = l.byId.get('pMenu').querySelectorAll('[role="menuitem"]');
  assert.strictEqual(more.getAttribute('aria-expanded'), 'true');
  assert.strictEqual(l.document.activeElement, items[0]);
  items[0].dispatchEvent({ type: 'keydown', key: 'ArrowDown' });
  assert.strictEqual(l.document.activeElement, items[1]);
  items[1].dispatchEvent({ type: 'keydown', key: 'Escape' });
  await l.drain();
  assert.strictEqual(l.byId.get('pMenu').hidden, true);
  assert.strictEqual(l.document.activeElement, more);
  more.dispatchEvent({ type: 'keydown', key: 'Enter', isComposing: true });
  await l.drain();
  assert.strictEqual(l.byId.get('pMenu').hidden, true, '変換確定の Enter で開いた（imeEnter）');
});

// ---- Task B-5（N4b・N4c の画面・RF4 の画面・F6・F13）: 録音中のページと一時停止 ----
const ST = (o = {}) => ({ active: true, finalizing: false, startedAt: Date.now() - 60000, segments: [{ id: 's1', atMs: 0, text: '始めます。' }, { id: 's2', atMs: 3000, text: '続けます。' }], pending: 0, paused: false, pausedMs: 0, pauses: [], cloud: false, localOnly: false, ...o });

test('N4b: 記録を始めると記録中のタブが開いて移り（開いていたページのタブは残る）、経過時間・一時停止・停止・流れる文字起こし・メモがある', async () => {
  const l = await openPa1();
  l.fire('onMeetingUpdate', ST());
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pa1', 'live']);
  assert.strictEqual(tabs(l)[1].getAttribute('aria-selected'), 'true');
  for (const id of ['liveTm', 'livePauseBtn', 'liveStopBtn']) assert.ok(l.document.getElementById(id), id);
  assert.strictEqual(l.byId.get('pScript').querySelectorAll('.seg').length, 2);
  assert.ok(l.byId.get('pMemo').querySelector('textarea'), 'メモが無い');
  assert.match(l.byId.get('pNote').textContent, /会議を終えると、ここに要約が入ります。/);
  for (const s of saves(l)) if (s.tabs) assert.ok(!s.tabs.open.includes('live') && s.tabs.active !== 'live', '録音中のタブを覚えさせた（N6）');
  assert.ok(saves(l).some((s) => s.tabs && s.tabs.active === 'page:pa1'), '前提: タブの覚え書きを送っている');
  // 足した確かめ: 記録中のタブを選んでいる間に覚えるのは、live を除いた並びと、その前に選んでいたタブ
  assert.deepStrictEqual(saves(l).pop(), { tabs: { open: ['page:pa1'], active: 'page:pa1' } });
});

test('N4c: ページの［一時停止］と Ctrl+Shift+P は main に頼むだけ（状態は meeting:update の paused）。作成中は出さない', async () => {
  const l = await open();
  await l.drain();
  l.fire('onMeetingUpdate', ST());
  await l.drain();
  l.document.getElementById('livePauseBtn').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('meetingSetPaused').map((c) => c.args[0]), [true]);
  assert.match(l.document.getElementById('livePauseBtn').textContent, /一時停止/, '返事の前に表示を変えた');
  l.fire('onMeetingUpdate', ST({ paused: true }));
  await l.drain();
  assert.match(l.document.getElementById('livePauseBtn').textContent, /再開/);
  assert.match(tabs(l)[0].textContent, /一時停止中/);
  const ev = l.key({ key: 'P', ctrlKey: true, shiftKey: true });
  await l.drain();
  assert.deepStrictEqual(l.called('meetingSetPaused').map((c) => c.args[0]), [true, false]);
  assert.ok(ev.defaultPrevented);
  l.fire('onMeetingUpdate', ST({ finalizing: true }));
  await l.drain();
  assert.strictEqual(l.document.getElementById('livePauseBtn').hidden, true);
  l.key({ key: 'P', ctrlKey: true, shiftKey: true });
  assert.strictEqual(l.called('meetingSetPaused').length, 2, '作成中に頼んだ');
});

test('RF4: スリープから戻って一時停止のままなら、録音中のページに再開を促す文が出る', async () => {
  const l = await open();
  await l.drain();
  l.fire('onMeetingUpdate', ST({ paused: true, resumeHint: true }));
  await l.drain();
  assert.match(l.document.getElementById('liveResumeNote').textContent, /スリープから戻りました。会議の録音は一時停止しています。/);
  assert.strictEqual(l.document.getElementById('liveResumeNote').hidden, false, '文を作っただけで隠したまま');   // 足した確かめ
  l.fire('onMeetingUpdate', ST({ paused: false, resumeHint: false }));
  await l.drain();
  assert.strictEqual(l.document.getElementById('liveResumeNote').hidden, true);
});

test('N4c・F6: 止めていた時間の印は区間の間に出て、区間の数・コピーに入らない（記録中も保存したページも）', async () => {
  const l = await open();
  await l.drain();
  l.fire('onMeetingUpdate', ST({ pauses: [{ atMs: 3000, ms: 130000, why: 'user' }] }));
  await l.drain();
  const kids = l.byId.get('pScript').children.map((e) => e.className.split(' ')[0]);
  assert.deepStrictEqual(kids, ['seg', 'pausemark', 'seg']);
  assert.match(l.byId.get('pScript').querySelector('.pausemark').textContent, /⏸ ここで 2分10秒 一時停止しました/);
  const saved = await openPa1({ pageGet: (id) => ({ page: { ...PAGE(id).page, pauses: [{ atMs: 5000, ms: 60000, why: 'suspend' }] }, segments: [{ id: 's1', atMs: 0, text: 'あ' }, { id: 's2', atMs: 5000, text: 'い' }] }) });
  assert.match(saved.byId.get('pScript').textContent, /💤 ここで 1分0秒 スリープで止まっていました/);
  assert.strictEqual(saved.byId.get('pScript').querySelectorAll('.seg').length, 2);
  saved.byId.get('pMenu').querySelectorAll('[role="menuitem"]')[0].dispatchEvent({ type: 'click' });
  await saved.drain();
  assert.ok(!String(saved.called('copy').pop().args[0]).includes('スリープ'), '印をコピーに入れた');
});

test('N4b・F13: 会議が終わって page:open が来たら記録中のタブをそのページのタブに替える。［この会議は PC の中だけ］は記録中のページにある', async () => {
  const l = await open();
  await l.drain();
  l.fire('onMeetingUpdate', ST({ cloud: true }));
  await l.drain();
  assert.strictEqual(l.document.getElementById('meetingLocalOnly').hidden, false);
  l.fire('onMeetingUpdate', { active: false, finalizing: false, segments: [], pending: 0 });
  l.fire('onPageOpen', 'pb2');
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pb2']);
});

test('N4b（足した守り）: 記録中に一覧から開いたページは別のタブで、記録中のバーは記録中のタブにだけ出る。戻るとメモの書きかけが残り、会議の間は記録中のタブを閉じられない。破棄したら閉じる', async () => {
  let st = ST();
  const l = await open({ meetingStatus: () => st });
  await l.drain();
  l.fire('onMeetingUpdate', st);
  await l.drain();
  const ta = l.byId.get('pMemo').querySelector('textarea');
  ta.value = '書きかけのメモ';
  ta.dispatchEvent({ type: 'input' });
  row(l, 0).dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['live', 'page:pa1'], '記録中のタブを一覧のページで置き換えた');
  assert.strictEqual(l.document.getElementById('liveBar').hidden, true, 'ほかのページに記録中のバーが出ている');
  tabs(l)[0].dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.document.getElementById('liveBar').hidden, false);
  assert.strictEqual(l.byId.get('pMemo').querySelector('textarea').value, '書きかけのメモ', 'タブを行き来したらメモの書きかけが消えた');
  assert.strictEqual(l.byId.get('pScript').querySelectorAll('.seg').length, 2);
  assert.strictEqual(tabs(l)[0].querySelector('button'), null, '会議の間に記録中のタブを閉じられる');
  tabs(l)[0].dispatchEvent({ type: 'auxclick', button: 1 });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['live', 'page:pa1']);
  l.window.confirm = () => true;
  st = { active: false, finalizing: false, segments: [], pending: 0 };
  l.byId.get('mtDiscardBtn').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.called('meetingDiscard').length, 1);
  assert.deepStrictEqual(keysOf(l), ['page:pa1'], '破棄した会議の記録中のタブが残った');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
