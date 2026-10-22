'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ---- 議事録の DB の口（第2a1回 ST5・ST7）
// 口（MessagePort）は main から 'db:port' で受け取り、この preload の中だけに持つ。ページ（contextBridge）には関数だけを出し、
// 口も口を返す関数も出さない。命令の名前はここでも照らし（DB の役 app の命令と同じ集まり。DB の側でも役で照らす）、
// 書く頼みには 'a:' + crypto.randomUUID() の tx を付ける（sandbox の preload は Node のモジュールを読まないので Web の crypto）。
// 口が来る前の頼みは待たせて、口が来たら送る。口が閉じるか main から 'db:lost' が来たら、送った読む頼みはすぐ retry で返し、
// 書く頼みは新しい口で同じ tx のまま送り直す（DB が (役, tx) で1回だけ効かせる）。口が無いまま 30 秒たてば retry で返す。
const APP_COMMANDS = new Set(['pages.list', 'pages.searchFull', 'pages.actionView', 'page.get', 'page.setTitle', 'page.setMemo', 'page.setType', 'page.delete', 'block.update', 'block.insert', 'block.remove', 'block.move', 'block.setAction', 'segment.update']);
const DB_READS = new Set(['pages.list', 'pages.searchFull', 'pages.actionView', 'page.get']);
const DB_WAIT_MS = 30000;
let dbPort = null;
let dbSeq = 0;
const dbGone = new WeakSet();   // 失って閉じた口（閉じたことで 'close' がまた来ても、2回は扱わない）
const dbWaiting = new Map();   // id → { id, cmd, args, tx, port（送った口。まだなら null）, timer, resolve, reject }

function dbError(code, retry) {
  const e = new Error(code);
  e.code = code;
  e.retry = Boolean(retry);
  return e;
}

function dbSettle(req, fn, value) {
  if (!dbWaiting.has(req.id)) return;
  dbWaiting.delete(req.id);
  if (req.timer) clearTimeout(req.timer);
  fn(value);
}

// 口が無い間は待たせる。30 秒で諦める（時計は待たせた頼みごとに1つ。送ったら止める）
function dbHold(req) {
  req.port = null;
  if (!req.timer) req.timer = setTimeout(() => { req.timer = null; dbSettle(req, req.reject, dbError('retry', true)); }, DB_WAIT_MS);
}

function dbSend(req) {
  if (req.timer) { clearTimeout(req.timer); req.timer = null; }
  req.port = dbPort;
  const msg = { id: req.id, cmd: req.cmd, args: req.args };
  if (req.tx) msg.tx = req.tx;
  try { dbPort.postMessage(msg); }
  catch (_) { dbSettle(req, req.reject, dbError('bad-args', false)); }   // 口に写せない引数（関数など）。この頼みだけ返し、残りは送る
}

function dbCall(cmd, args) {
  if (!APP_COMMANDS.has(cmd)) return Promise.reject(dbError('forbidden', false));
  return new Promise((resolve, reject) => {
    const req = { id: ++dbSeq, cmd, args: args || {}, tx: DB_READS.has(cmd) ? undefined : 'a:' + crypto.randomUUID(), port: null, timer: null, resolve, reject };
    dbWaiting.set(req.id, req);
    if (dbPort) dbSend(req); else dbHold(req);
  });
}

// 口を失った: その口に送った読む頼みは retry で返し、書く頼みは次の口を待つ。口は閉じる
function dbLost(port) {
  if (!port || dbGone.has(port)) return;
  dbGone.add(port);
  if (dbPort === port) dbPort = null;
  for (const req of [...dbWaiting.values()]) {
    if (req.port !== port) continue;
    if (DB_READS.has(req.cmd)) dbSettle(req, req.reject, dbError('retry', true));
    else dbHold(req);
  }
  port.onmessage = null;   // 失った口は閉じて返事の受け口を外す
  try { port.close(); } catch (_) { /* 閉じ済み */ }
}

function dbAdopt(port) {
  if (!port) return;
  if (dbPort && dbPort !== port) dbLost(dbPort);
  dbPort = port;
  port.onmessage = (ev) => {
    const m = ev && ev.data;
    if (!m || typeof m.id !== 'number') return;   // changed の知らせ（2a1 の画面は pages:updated のまま）
    const req = dbWaiting.get(m.id);
    if (!req || req.port !== port) return;        // 古い口の遅い返事は使わない（送り直した頼みを二重に決めない）
    if (m.ok) dbSettle(req, req.resolve, m.result);
    else dbSettle(req, req.reject, dbError(String(m.code || 'internal'), m.retry));
  };
  port.addEventListener('close', () => dbLost(port));
  if (typeof port.start === 'function') port.start();
  for (const req of [...dbWaiting.values()]) if (req.port === null) dbSend(req);   // 待たせていた頼みを頼んだ順に
}

ipcRenderer.on('db:port', (e) => dbAdopt(e && e.ports && e.ports[0]));
ipcRenderer.on('db:lost', () => dbLost(dbPort));

// オーバーレイ（録音ピル）
contextBridge.exposeInMainWorld('koeOverlay', {
  onStart: (cb) => ipcRenderer.on('overlay:start', (_e, p) => cb(p)),
  onStop: (cb) => ipcRenderer.on('overlay:stop', (_e, p) => cb(p)),
  onCancel: (cb) => ipcRenderer.on('overlay:cancel', (_e, p) => cb(p)),
  onPhase: (cb) => ipcRenderer.on('overlay:phase', (_e, p) => cb(p)),
  onTick: (cb) => ipcRenderer.on('overlay:tick', () => cb()),
  onSegmentMs: (cb) => ipcRenderer.on('overlay:segment-ms', (_e, ms) => cb(ms)),
  sendAudio: (buffer, mimeType, durationMs) => ipcRenderer.send('audio:done', { buffer, mimeType, durationMs }),
  sendSegment: (buffer, durationMs, final) => ipcRenderer.send('audio:segment', { buffer, durationMs, final }),
  sendError: (message) => ipcRenderer.send('audio:error', { message }),
  reportSource: (systemAudio, wanted) => ipcRenderer.send('overlay:source', { systemAudio, wanted }),
  reportPause: (paused) => ipcRenderer.send('overlay:pause', { paused }),
  reportMic: (info) => ipcRenderer.send('overlay:mic', info),
  confirmStop: () => ipcRenderer.send('overlay:confirm'),
  requestCancel: () => ipcRenderer.send('overlay:cancel-request'),
  requestHide: () => ipcRenderer.send('overlay:hidden-request'),
  // 0.9.0 O-2（RP3・RP4）: 測ったピルの大きさ（CSS の px）を main に送り、main が窓の大きさを合わせる。形（横 h・縦 v）の替わりを受ける
  reportSize: (size) => ipcRenderer.send('overlay:size', size),
  onForm: (cb) => ipcRenderer.on('overlay:form', (_e, p) => cb(p)),
  // 0.9.0 O-4（RP8）: 縦の形の × で録音バーを隠す（録音は続ける）。カーソルがピルに乗ったか（main が見る: Windows のドラッグの領域に :hover は来ない）
  hidePanel: () => ipcRenderer.send('overlay:hide-panel'),
  onHover: (cb) => ipcRenderer.on('overlay:hover', (_e, on) => cb(on)),
});

// 0.9.3 M-3: 会議の検出のパネル（右上の小さな窓。計画 docs/plans/2026-10-22-093.md の決めたこと 9・10）。画面は id も文も送らない:
// 始めるは pcOnly（オフラインモードで始めるか）だけ、出さないは引数なし（main が今出しているアプリを使う）
contextBridge.exposeInMainWorld('koeNudge', {
  onShow: (cb) => ipcRenderer.on('nudge:show', (_e, p) => cb(p)),
  start: (pcOnly) => ipcRenderer.invoke('nudge:start', { pcOnly: pcOnly === true }),
  close: () => ipcRenderer.send('nudge:close'),
  mute: () => ipcRenderer.send('nudge:mute'),
  openSettings: () => ipcRenderer.send('nudge:settings'),
  reportSize: (size) => ipcRenderer.send('nudge:size', size),
  hover: (on) => ipcRenderer.send('nudge:hover', on === true),
});

// メインウィンドウ（ノート）
contextBridge.exposeInMainWorld('koeApp', {
  // 設定
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  testApi: () => ipcRenderer.invoke('app:test'),
  testSum: () => ipcRenderer.invoke('app:test-sum'),
  engineStatus: () => ipcRenderer.invoke('engine:status'),
  engineFetchStatus: () => ipcRenderer.invoke('engine:fetch-status'),
  engineFetchStart: (o) => ipcRenderer.invoke('engine:fetch-start', o),
  engineFetchPause: () => ipcRenderer.invoke('engine:fetch-pause'),
  openEngineDir: () => ipcRenderer.invoke('engine:open-dir'),
  vadStatus: () => ipcRenderer.invoke('app:vad-status'),
  promptInfo: () => ipcRenderer.invoke('prompt:info'),
  pickFile: (kind, key) => ipcRenderer.invoke('dialog:pick', kind, key),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  openSoundSettings: () => ipcRenderer.invoke('app:open-sound-settings'),
  openReleases: () => ipcRenderer.invoke('app:open-releases'),
  // 0.9.2 I-1: ヘルプセンターを開く。渡すのは記事の名前（help/site.json の「<分類>/<記事>」）だけ。省けばホーム。住所は main だけが持つ
  openHelp: (article) => ipcRenderer.invoke('app:open-help', typeof article === 'string' ? article : ''),
  appVersion: () => ipcRenderer.invoke('app:version'),
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateApply: (url) => ipcRenderer.invoke('update:apply', url),
  restart: () => ipcRenderer.invoke('app:restart'),
  onUpdateAvailable: (cb) => ipcRenderer.on('update:available', (_e, r) => cb(r)),
  onUpdateProgress: (cb) => ipcRenderer.on('update:progress', (_e, p) => cb(p)),
  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),

  // 音声入力
  getHistory: () => ipcRenderer.invoke('history:get'),
  deleteHistory: (id) => ipcRenderer.invoke('history:delete', id),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  toggleRecording: () => ipcRenderer.invoke('app:toggle-recording'),

  // ページ（議事録）。14 の名前は DB の口へ（第2a1回 ST5。名前・引数・返す形は今の IPC と同じ）。要約と会議の型は今どおり main
  pagesSearch: (q) => dbCall('pages.list', { q: q || '' }),
  pagesSearchFull: (q) => dbCall('pages.searchFull', { q: q || '', limit: 60 }),
  pagesActionView: ({ q, assignee }) => dbCall('pages.actionView', { q, assignee }),
  meetingTypes: () => ipcRenderer.invoke('meta:types'),
  pageSetType: (id, type) => dbCall('page.setType', { id, type }),
  blockSetAction: (pageId, blockId, assignee, dueRaw) => dbCall('block.setAction', { pageId, blockId, assignee, dueRaw }),
  pageGet: (id) => dbCall('page.get', { id }),
  pageDelete: (id) => dbCall('page.delete', { id }),
  pageSetTitle: (id, title) => dbCall('page.setTitle', { id, title }),
  pageSetMemo: (id, memo) => dbCall('page.setMemo', { id, memo }),
  pageSummarize: (id) => ipcRenderer.invoke('page:summarize', id),
  blockUpdate: (pageId, blockId, patch) => dbCall('block.update', { pageId, blockId, patch }),
  blockInsert: (pageId, afterBlockId, type) => dbCall('block.insert', { pageId, afterBlockId, type }),
  blockRemove: (pageId, blockId) => dbCall('block.remove', { pageId, blockId }),
  blockMove: (pageId, blockId, toIndex) => dbCall('block.move', { pageId, blockId, toIndex }),
  hotkeyState: () => ipcRenderer.invoke('hotkey:state'),
  segmentUpdate: (pageId, segId, patch) => dbCall('segment.update', { pageId, segId, patch }),

  // 議事録セッション
  meetingToggle: () => ipcRenderer.invoke('meeting:toggle'),
  meetingDiscard: () => ipcRenderer.invoke('meeting:discard'),
  meetingStatus: () => ipcRenderer.invoke('meeting:status'),
  meetingSetMemo: (memo) => ipcRenderer.invoke('meeting:set-memo', memo),
  meetingSkipPending: () => ipcRenderer.invoke('meeting:skipPending'),
  meetingSetLocalOnly: (on) => ipcRenderer.invoke('meeting:set-local-only', on),
  // 第1d回 A-6（D17）: 帯の［もう一度］（失敗して音声を残した区間を送り直す）
  meetingRetry: () => ipcRenderer.invoke('meeting:retry'),
  meetingKeepGoing: () => ipcRenderer.invoke('meeting:keep-going'),   // 0.9.1 Q-4: 「会議は終わりましたか？」の帯の［続ける］ → { ok }
  // 第1d回 A-8（D17）: 録音中のページを開いていて窓が隠れていないか（変わったときだけ）。main は見えていないときだけ Windows の知らせを出す
  meetingLiveShown: (on) => ipcRenderer.send('meeting:live-shown', on === true),
  meetingSetPaused: (on) => ipcRenderer.invoke('meeting:set-paused', on),   // 第1b回 N4c: → { ok, pending, paused }

  // ログイン（第1d回 Task A-2・A-11・A-12。設定のカード「アカウント」が呼ぶ）。cookie と JWT は main から返らない
  // （返るのはログインしているか・メール・期限・文と符号だけ）。0.7.0 の鍵の口（cloudStatus・cloudSetKey・cloudClearKey・cloudTestKey）は A-4 で、
  // 前の自前のログインの口（accountStart・accountVerify。メールと確認コード）は A-12 で消した
  accountStatus: () => ipcRenderer.invoke('account:status'),
  // 第1d回 A-11: Cloudflare Access のログインの窓を開く（cookie も JWT も画面へ返さない。答えは { ok, email?, code?, message }）
  accountLogin: () => ipcRenderer.invoke('account:login'),
  accountLogout: () => ipcRenderer.invoke('account:logout'),
  claudeStatus: () => ipcRenderer.invoke('claude:status'),
  claudeTest: () => ipcRenderer.invoke('claude:test'),
  // 第1b回の続き Lane F-c・F-d: 見える窓を開き、閉じたら確かめ直した答え（{ ok, status } か { ok: false, code, message }）を返す
  claudeLogin: () => ipcRenderer.invoke('claude:login'),
  claudeInstall: () => ipcRenderer.invoke('claude:install'),

  // 画面の覚え書き（第1b回 N6）。サイドバーの幅と畳み・開いているタブ。main が照らしてから window-state.json に覚える
  uiState: () => ipcRenderer.invoke('ui:get'),
  uiSave: (patch) => ipcRenderer.invoke('ui:set', patch),

  // イベント
  onHistoryUpdated: (cb) => ipcRenderer.on('history:updated', (_e, h) => cb(h)),
  onNotice: (cb) => ipcRenderer.on('app:notice', (_e, m) => cb(m)),
  onMeetingUpdate: (cb) => ipcRenderer.on('meeting:update', (_e, s) => cb(s)),
  // 0.9.0 O-2・O-4 の点検の直し: main が画面の外で変えた設定（録音バーのドラッグで吸い付いた置き場所 pillSlot）を欄へ戻す
  onSettingsPatched: (cb) => ipcRenderer.on('settings:patched', (_e, p) => cb(p)),
  // 0.9.0 O-4（RP8）: 隠した録音バーを出し直す（録音中のページの［録音バーを出す］）
  showPanel: () => ipcRenderer.invoke('panel:show'),
  onShowLive: (cb) => ipcRenderer.on('meeting:show-live', () => cb()),   // 第1d回 A-8: Windows の知らせを押した → 録音中のタブへ
  // 0.9.3 M-3・M-4: 会議の検出のパネルの「会議の検出の通知の設定…」→ 設定のその項目を開く（{ sec, row }）
  onOpenSettings: (cb) => ipcRenderer.on('app:open-settings', (_e, p) => cb(p)),
  onMeetingProgress: (cb) => ipcRenderer.on('meeting:progress', (_e, p) => cb(p)),
  onPagesUpdated: (cb) => ipcRenderer.on('pages:updated', (_e, p) => cb(p)),
  onPageOpen: (cb) => ipcRenderer.on('page:open', (_e, id) => cb(id)),
  onPageUpdated: (cb) => ipcRenderer.on('page:updated', (_e, p) => cb(p)),
  onEngineFetchProgress: (cb) => ipcRenderer.on('engine:fetch-progress', (_e, s) => cb(s)),
});
