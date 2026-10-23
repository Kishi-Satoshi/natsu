/*
 * stage1b.app.test.js — 第1b回の画面（サイドバー・上のタブ・ページ・録音中のページ・一時停止・キーボード）を、最小 DOM の上で本当に走らせて確かめる
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
const preloadWith = (...names) => names.reduce((src, n) => (new RegExp(`^\\s+${n}\\s*:`, 'm').test(src) ? src
  : src.replace("exposeInMainWorld('koeApp', {", `exposeInMainWorld('koeApp', {\n  ${n}: (...a) => ipcRenderer.invoke('test:${n}', ...a),`)), PRELOAD);
const P1B = preloadWith('uiState', 'uiSave', 'meetingSetPaused');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const LIST = [{ id: 'pa1', title: titleAt('2026-10-16T01:00:00.000Z'), date: '10/16', durationSec: 1800, hasSummary: true }, { id: 'pb2', title: titleAt('2026-10-09T05:00:00.000Z'), date: '10/15', durationSec: 900, hasSummary: false },
  { id: 'pc3', title: titleAt('2026-10-02T08:00:00.000Z'), date: '10/14', durationSec: 600, hasSummary: false }];
const PAGE = (id) => ({ page: { id, title: LIST.find((p) => p.id === id).title, createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
const open = (o = {}) => load(APP, { preloadSrc: P1B, returns: { pagesSearch: () => LIST, pageGet: PAGE, uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' } }), ...o } });
const saves = (l) => l.called('uiSave').map((c) => c.args[0]);

test('N2: サイドバーは議事録のタブの外にいて、上から NaTsu・検索・記録開始・議事録の一覧、下に音声入力と設定', async () => {
  const l = await open();
  await l.drain();
  const side = l.byId.get('side');
  assert.ok(side && !side.closest('#tabNotes'), 'サイドバーが議事録のタブの中にある（ほかのタブで消える）');
  // 第1b2回 L-2: 検索の欄は検索の窓へ移り、サイドバーには窓を開く［🔍 検索］（#sideSearch）がある
  assert.ok(!side.querySelector('#searchBox'), '検索の欄がサイドバーに残っている');
  const order = ['wordmark', 'sideSearch', 'mtToggleBtn', 'tabBtnNotes', 'plist', 'tabBtnDictation', 'tabBtnSettings'];
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

// 0.9.0 U-1（SP1・D24）で意図して変えた: 設定はタブでなく、今のページの上に開くポップアップ（上の帯に足さない・今のタブを替えない）。
// 1つずつ開くことと閉じ方は、音声入力とページのタブで見る
test('N3・0.9.0 U-1: 音声入力はタブで開き（1つずつ）、設定はタブにしない。× と中クリックで閉じる。選んでいたタブを閉じたら隣へ移り、全部閉じたら空のページ', async () => {
  const l = await open();
  await l.drain();
  l.byId.get('tabBtnDictation').dispatchEvent({ type: 'click' });
  await l.drain();
  row(l, 0).dispatchEvent({ type: 'click' });
  await l.drain();
  l.byId.get('tabBtnDictation').dispatchEvent({ type: 'click' });
  l.byId.get('tabBtnSettings').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['dictation', 'page:pa1'], '音声入力のタブを2つ作った・設定のタブを足した');
  assert.ok(l.byId.get('tabSettings').className.includes('active'));
  assert.ok(l.byId.get('tabDictation').className.includes('active'), '設定を開いたら後ろのタブが替わった');
  l.key({ key: 'Escape' });
  await l.drain();
  tabs(l)[0].querySelector('button').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pa1']);
  assert.ok(l.byId.get('tabNotes').className.includes('active'), '隣のタブへ移っていない');
  tabs(l)[0].dispatchEvent({ type: 'auxclick', button: 1 });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), []);
  assert.match(l.byId.get('pNote').textContent, /左の一覧から議事録を選んでください/);
});

// 0.9.0 U-1（SP3）で意図して変えた: 覚えたタブの settings は受けない（下の stage090.settings の SP3）。固定のタブは音声入力で見る
test('N3・N6・F7: 起動のときに覚えたタブを開いて選んでいたタブに移り、変わるたびに覚える', async () => {
  const l = await open({ uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: ['page:pa1', 'page:pb2'], active: 'page:pa1' } }) });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pa1', 'page:pb2']);
  assert.strictEqual(tabs(l)[0].textContent.includes(titleAt('2026-10-16T01:00:00.000Z')), true, 'タブの名前がページの題名でない');
  assert.deepStrictEqual(l.called('pageGet').map((c) => c.args[0]), ['pa1']);
  l.byId.get('tabBtnDictation').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(saves(l).pop(), { tabs: { open: ['page:pa1', 'page:pb2', 'dictation'], active: 'dictation' } });
});

test('N3・F8: タブを替える前に書きかけの題名を元のページへ保存する（blur は来ない）', async () => {
  const l = await open();
  await l.drain();
  row(l, 0).dispatchEvent({ type: 'click' });
  await l.drain();
  l.byId.get('pTitle').textContent = '直した題名';
  // 0.9.0 U-1 で意図して変えた: 設定はタブを替えない（ポップアップ）ので、音声入力のタブへ替える
  l.byId.get('tabBtnDictation').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('pageSetTitle').map((c) => c.args), [['pa1', '直した題名']]);
});

// 0.9.0 U-1（SP1・SP3）で意図して変えた: 設定のタブは無いので、3つ目は2つ目のページのタブ（End で移り、Ctrl+Tab で最初のページへ回る）
test('N3・画面の使いやすさ: タブの帯は ←／→／Home／End で移り（選んでいるタブだけ Tab で届く）、Ctrl+Tab で次のタブ', async () => {
  const l = await open({ uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: ['page:pa1', 'dictation', 'page:pb2'], active: 'page:pa1' } }) });
  await l.drain();
  assert.deepStrictEqual(tabs(l).map((t) => t.tabIndex), [0, -1, -1]);
  tabs(l)[0].dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
  await l.drain();
  assert.strictEqual(l.document.activeElement, tabs(l)[1]);
  assert.ok(l.byId.get('tabDictation').className.includes('active'));
  tabs(l)[1].dispatchEvent({ type: 'keydown', key: 'End' });
  await l.drain();
  assert.ok(l.byId.get('tabNotes').className.includes('active'));
  assert.strictEqual(tabs(l)[2].getAttribute('aria-selected'), 'true', 'End で最後のタブへ移らない');
  l.key({ key: 'Tab', ctrlKey: true });
  await l.drain();
  assert.strictEqual(tabs(l)[0].getAttribute('aria-selected'), 'true', 'Ctrl+Tab で最初へ回らない');
  assert.ok(l.byId.get('tabNotes').className.includes('active'));
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
  assert.strictEqual(l.byId.get('pTitle').textContent, titleAt('2026-10-09T05:00:00.000Z'), '開いていたページが消えた');
  l.window.confirm = () => true;
  l.byId.get('pActs').querySelectorAll('button').find((b) => b.textContent === '削除').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('pageDelete').map((c) => c.args[0]), ['pb2']);
  assert.deepStrictEqual(keysOf(l), ['page:pa1'], '消したページのタブが残った');
  assert.strictEqual(l.byId.get('pTitle').textContent, titleAt('2026-10-16T01:00:00.000Z'));
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
  // 名前の欄のアイコンは灰色の .ic に包む（文字は今のまま。第1b2回 P-2）
  assert.ok(l.byId.get('pageWrap').querySelectorAll('.prop .k').every((k) => k.querySelector('.ic')), 'アイコンが .ic に包まれていない');
});

test('N4: 要約・文字起こし・メモは細いタブ（role=tab・aria-selected）。操作は主ボタン1つと「…」の中のコピーと削除', async () => {
  const l = await openPa1();
  assert.strictEqual(l.byId.get('paneBtnNote').textContent, 'AI 要約');
  assert.deepStrictEqual(l.root.querySelectorAll('.ptabrow [role="tab"]').map((b) => b.id), ['paneBtnNote', 'paneBtnMemo', 'paneBtnScript'], '並びは AI 要約・メモ・文字起こし（第1b2回 P-2）');
  assert.strictEqual(l.byId.get('paneBtnScript').getAttribute('aria-selected'), 'true', '要点の無いページは文字起こしで開く（今と同じ）');
  const acts = l.byId.get('pActs');
  assert.ok(acts.closest('.pagebar'), '操作が上の帯（.pagebar）の中に無い（第1b2回 P-1）');
  const visible = acts.querySelectorAll('button').filter((b) => !b.closest('#pMenu'));
  assert.deepStrictEqual(visible.map((b) => b.id || b.textContent), ['要約を生成', 'pMore']);
  // 0.10.0 L-1（D58）で意図して変えた: コピーと削除の間に［リンクを写す］
  assert.deepStrictEqual(l.byId.get('pMenu').querySelectorAll('[role="menuitem"]').map((b) => b.textContent), ['コピー', 'リンクを写す', '削除']);
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
  // 0.9.3 M-6 で意図して変えた: 録音中は一番下に「聞き取り中…」の行（.livetail。.seg でない）
  assert.deepStrictEqual(kids, ['seg', 'pausemark', 'seg', 'livetail']);
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
  l.fire('onMeetingUpdate', st);   // 本物では区間ごとに届く。ほかのページを見ている間に届いても、記録中のバーは出さない
  await l.drain();
  assert.strictEqual(l.document.getElementById('liveBar').hidden, true, '次の meeting:update で、ほかのページに記録中のバーが出た');
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

// 覚え書きが遅れて届く場面（uiState の返事を手で返す）
const lateUi = () => { let give; const p = new Promise((r) => { give = r; }); return { uiState: () => p, give: (v) => give(v) }; };

test('N3・N6（足した守り）: 覚えたタブが届く前に記録が始まっていたら、記録中のタブを消さずに選んだまま、覚えたタブを並べる', async () => {
  const ui = lateUi();
  const l = await open({ uiState: ui.uiState });
  await l.drain();
  l.fire('onMeetingUpdate', ST());
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['live'], '前提: 記録中のタブが開いている');
  ui.give({ sidebar: { width: 260, collapsed: false }, tabs: { open: ['page:pa1', 'dictation'], active: 'page:pa1' } });   // 0.9.0 U-1: 設定のタブは無い（音声入力にした）
  await l.drain();
  assert.ok(keysOf(l).includes('live'), '遅れて届いた覚え書きが記録中のタブを消した（次の会議まで戻れない）');
  assert.strictEqual(tabs(l).find((t) => t.dataset.key === 'live').getAttribute('aria-selected'), 'true', '記録中のタブから移された');
  assert.strictEqual(l.document.getElementById('liveBar').hidden, false);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('N2・N3（足した守り）: 覚え書きが届く前に利用者がサイドバーの幅やタブを変えていたら、遅れて届いた値で上書きしない', async () => {
  const ui = lateUi();
  const l = await open({ uiState: ui.uiState });
  await l.drain();
  l.byId.get('sideGrip').dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
  row(l, 0).dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.byId.get('side').style.width, '276px', '前提: ← → で幅が変わる');
  ui.give({ sidebar: { width: 400, collapsed: true }, tabs: { open: ['dictation'], active: 'dictation' } });   // 0.9.0 U-1: 設定のタブは無い（落とすので上書きの見張りが空振りする）。音声入力にした
  await l.drain();
  assert.strictEqual(l.byId.get('side').style.width, '276px', '遅れて届いた幅で利用者の幅を上書きした');
  assert.ok(!l.byId.get('side').closest('.app').className.includes('side-collapsed'), '遅れて届いた畳みで畳んだ');
  assert.deepStrictEqual(keysOf(l), ['page:pa1'], '遅れて届いたタブで利用者のタブを上書きした');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('N4c（足した守り）: 一時停止の口（meetingSetPaused）が無い古い preload では、ページの［一時停止］を出さず、Ctrl+Shift+P でも落ちない', async () => {
  const OLD = preloadWith('uiState', 'uiSave').replace(/^\s+meetingSetPaused\s*:.*\n/m, '');
  assert.ok(!/meetingSetPaused/.test(OLD), '前提: 口を外せていない');
  const l = await load(APP, { preloadSrc: OLD, returns: { pagesSearch: () => LIST } });
  await l.drain();
  l.fire('onMeetingUpdate', ST());
  await l.drain();
  assert.strictEqual(l.document.getElementById('livePauseBtn').hidden, true, '押しても何も起きない［一時停止］を出した');
  l.key({ key: 'P', ctrlKey: true, shiftKey: true });
  await l.drain();
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// Tab で届く順（偽 DOM には配置が無いので、木の順と tabindex と hidden で数える。正の tabindex を禁じるので木の順＝Tab の順）
const tabbables = (l) => l.root._walk([]).filter((e) => {
  for (let n = e; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) {
    const cls = (n.className || '').split(' ');
    if (n.hidden || (cls.includes('tab') && !cls.includes('active')) || n.id === 'pMenu' || (n.style && n.style.display === 'none')) return false;
  }
  if (e.disabled) return false;
  const attr = e.getAttribute('tabindex');
  const ti = e.tabIndex !== undefined ? e.tabIndex : (attr == null ? null : Number(attr));
  if (ti > 0) throw new Error(`正の tabindex: ${e.id || e.className}`);
  if (ti === -1) return false;
  return ['button', 'input', 'select', 'textarea'].includes(e.tagName) || ti === 0 || e.getAttribute('contenteditable') === 'true';
}).map((e) => e.id || e.dataset.key || e.className);

test('画面の使いやすさ・F12: キーボードだけで、サイドバー → タブの帯 → ページの順に一周できる（正の tabindex を使わない）', async () => {
  const l = await openPa1();
  const order = tabbables(l);
  const at = (k) => order.indexOf(k);
  // 第1b2回 L-2: 検索の欄は閉じた検索の窓（hidden）の中なので届かない。サイドバーは［🔍 検索］から
  for (const k of ['sideSearch', 'mtToggleBtn', 'tabBtnDictation', 'tabBtnSettings', 'sideCollapse', 'sideGrip', 'page:pa1', 'pMore', 'pTitle', 'pType', 'paneBtnScript']) assert.ok(at(k) >= 0, `${k} に Tab で届かない`);
  assert.ok(!order.includes('searchBox'), '閉じた検索の窓の中に Tab で届く');
  const want = ['sideSearch', 'mtToggleBtn', 'sideGrip', 'page:pa1', 'pMore', 'pTitle', 'pType', 'paneBtnScript'];
  assert.deepStrictEqual(want.map(at), [...want.map(at)].sort((a, b) => a - b), order.join(' → '));
  assert.ok(!order.includes('paneBtnNote'), '選んでいない細いタブまで Tab で届く（矢印で移る形にする）');
});

test('画面の使いやすさ: つまみの Enter は畳む・出すだが、変換確定の Enter（isComposing・229）では何もしない', async () => {
  const l = await openPa1();
  const n0 = saves(l).length;
  for (const ev of [{ isComposing: true }, { keyCode: 229 }]) l.byId.get('sideGrip').dispatchEvent({ type: 'keydown', key: 'Enter', ...ev });
  await l.drain();
  assert.strictEqual(saves(l).length, n0, '変換確定の Enter で畳んだ');
  l.byId.get('sideGrip').dispatchEvent({ type: 'keydown', key: 'Enter' });
  await l.drain();
  assert.deepStrictEqual(saves(l).pop(), { sidebar: { width: 260, collapsed: true } });
});

test('画面の使いやすさ・F12（足した守り）: 選んでいるタブの × にも Tab で届き（ほかのタブの × は届かない）、× で閉じたらフォーカスは隣のタブへ移る', async () => {
  // 0.9.0 U-1（SP3）で意図して変えた: 設定のタブは無いので、3つ目は2つ目のページのタブ
  const l = await open({ uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: ['page:pa1', 'dictation', 'page:pb2'], active: 'dictation' } }) });
  await l.drain();
  const xs = () => tabs(l).map((t) => t.querySelector('.tx').tabIndex);
  assert.deepStrictEqual(xs(), [-1, 0, -1]);
  const order = tabbables(l);
  assert.strictEqual(order[order.indexOf('dictation') + 1], 'tx', order.join(' → '));
  const x = tabs(l)[1].querySelector('.tx');
  x.focus();
  x.dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pa1', 'page:pb2']);
  assert.strictEqual(l.document.activeElement, tabs(l)[1], '× で閉じた後、フォーカスがどこにも無い');
  assert.deepStrictEqual(xs(), [-1, 0]);
});

test('画面の使いやすさ・F12（足した守り）: タブの × にフォーカスがあるまま帯が描き直されても（一覧の更新など）、フォーカスは同じタブの × に残る', async () => {
  const l = await open({ uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: ['page:pa1', 'dictation'], active: 'dictation' } }) });
  await l.drain();
  tabs(l)[1].querySelector('.tx').focus();
  l.fire('onPagesUpdated');
  await l.drain();
  assert.ok(l.called('pagesSearch').length >= 2, '前提: 一覧を読み直した');
  assert.strictEqual(l.document.activeElement, tabs(l)[1].querySelector('.tx'), '帯を描き直したら × のフォーカスが消えた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('N3・N4b（足した守り）: ページを読み込んでいる間に記録が始まったら、読み終えたページを記録中のタブの下に描かない', async () => {
  let give;
  const held = new Promise((r) => { give = r; });
  const l = await open({ pageGet: (id) => (id === 'pa1' && give ? held : PAGE(id)) });
  await l.drain();
  row(l, 0).dispatchEvent({ type: 'click' });
  await l.drain();
  l.fire('onMeetingUpdate', ST());
  await l.drain();
  const g = give; give = null;
  g(PAGE('pa1'));
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pa1', 'live']);
  assert.strictEqual(tabs(l)[1].getAttribute('aria-selected'), 'true');
  assert.notStrictEqual(l.byId.get('pTitle').textContent, titleAt('2026-10-16T01:00:00.000Z'), '記録中のタブの下に、読み終えたページを描いた');
  l.fire('onMeetingUpdate', ST());
  await l.drain();
  assert.strictEqual(l.byId.get('pScript').querySelectorAll('.seg').length, 2, '記録中の文字起こしが流れない');
  assert.strictEqual(l.document.getElementById('liveBar').hidden, false);
  tabs(l)[0].dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual(l.byId.get('pTitle').textContent, titleAt('2026-10-16T01:00:00.000Z'), 'ページのタブに戻っても開けない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
