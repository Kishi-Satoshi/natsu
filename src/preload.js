'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// ---- 議事録の DB の口（第2a1回 ST5・ST7）
// 口（MessagePort）は main から 'db:port' で受け取り、この preload の中だけに持つ。ページ（contextBridge）には関数だけを出し、
// 口も口を返す関数も出さない。命令の名前はここでも照らし（DB の役 app の命令と同じ集まり。DB の側でも役で照らす）、
// 書く頼みには 'a:' + crypto.randomUUID() の tx を付ける（sandbox の preload は Node のモジュールを読まないので Web の crypto）。
// 口が来る前の頼みは待たせて、口が来たら送る。口が閉じるか main から 'db:lost' が来たら、送った読む頼みはすぐ retry で返し、
// 書く頼みは新しい口で同じ tx のまま送り直す（DB が (役, tx) で1回だけ効かせる）。口が無いまま 30 秒たてば retry で返す。
// 0.13.0 ED-2（計画 docs/plans/2026-10-24-130.md の決めたこと 14）: 要約の編集の命令（分割・結合・型の変換・複製）を足した（18）
// 0.13.1（計画 docs/plans/2026-10-27-131.md の決めたこと 10）: 字下げとトグルの開け閉めの3つを足した（21）
// 0.14.0 EB-2（計画 docs/plans/2026-10-26-140.md の決めたこと 2・6・21）: 元に戻す edit.revert と行の色 blocks.setColor を足した（23）
// 0.14.0 EK-2（決めたこと 25・30）: 貼り付け block.paste と、選んだ行の blocks.remove・blocks.move・blocks.duplicate・blocks.turnInto を足した（28）
const APP_COMMANDS = new Set(['pages.list', 'pages.searchFull', 'pages.actionView', 'page.get', 'page.setTitle', 'page.setMemo', 'page.setType', 'page.delete', 'block.update', 'block.insert', 'block.remove', 'block.move', 'block.setAction', 'segment.update',
  'block.split', 'block.merge', 'block.turnInto', 'block.duplicate', 'block.indent', 'block.setOpen', 'block.setOpenAll', 'edit.revert', 'blocks.setColor',
  'block.paste', 'blocks.remove', 'blocks.move', 'blocks.duplicate', 'blocks.turnInto']);
// 0.14.0 EB-2（決めたこと 6・R1）: 元に戻すの1歩にする命令（src/undoBook.js の UNDO_CMDS と同じ表。sandbox の preload は src を読めないので写す:
// test/stage140.db.test.js が同じ表かを見る）。答えが ok で changed のときだけ、答えより先に画面の受け口へ { cmd, pageId, step: tx } を渡す
const UNDO_CMDS = new Set([
  'block.update', 'block.insert', 'block.remove', 'block.move', 'block.setAction', 'block.split', 'block.merge', 'block.turnInto', 'block.duplicate',
  'block.indent', 'block.paste', 'blocks.remove', 'blocks.move', 'blocks.duplicate', 'blocks.turnInto', 'blocks.setColor', 'page.setMemoDoc', 'edit.revert',
]);
const editSteps = [];
function editStep(req) {
  const a = req.args || {};
  const step = { cmd: req.cmd, pageId: typeof a.pageId === 'string' ? a.pageId : a.id, step: req.tx };
  for (const cb of editSteps) { try { cb(step); } catch (_) { /* 画面の受け口の誤りで答えを止めない */ } }
}
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
    if (m.ok && m.changed === true && UNDO_CMDS.has(req.cmd)) editStep(req);   // 何も変えなかった命令は歩みにしない（R59）
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
  // 0.12.0 SP-2（決めたこと 134）: 2つの流れの議事録では4つ目 { src, seg, t0, last }（main が checkSegMeta で照らす）。1本の会議と音声入力は4つ目なし
  sendSegment: (buffer, durationMs, final, meta) => ipcRenderer.send('audio:segment', meta === undefined ? { buffer, durationMs, final } : { buffer, durationMs, final, meta }),
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
  // 0.9.3 M-5: 録音中のページの音の波のために main が聞く・答える（{ mic, sys, warn }。main が levelMsg で照らす）
  onLevelAsk: (cb) => ipcRenderer.on('overlay:level-ask', () => cb()),
  reportLevel: (level) => ipcRenderer.send('overlay:level', level),
  // 0.12.0 SP-2（決めたこと 123）: main が声の切れ目で、この流れ（src）のこの番号（seg）の区間を切ると言う
  onCut: (cb) => ipcRenderer.on('overlay:cut', (_e, v) => cb(v)),
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
  // 0.11.0 V-1・V-5: { types, selectable }（types の各項目に memo＝種類から決まるメモの型の鍵）。memoTypes はメモの型の表（名前・見出しとヒント・雛形）
  meetingTypes: () => ipcRenderer.invoke('meta:types'),
  memoTypes: () => ipcRenderer.invoke('meta:memo-types'),
  // 0.11.0 V-4: 題名を直した自動のページで、今の題名から判定した種類を聞く（答えは { type }。'' は決まらない）
  metaDetectType: (id, title) => ipcRenderer.invoke('meta:detect-type', id, title),
  // 0.11.0 M-4: preset が真なら、DB にある今のメモが手を付けていないときだけ新しい型の雛形に替える（type は鍵か auto）
  pageSetType: (id, type, preset) => dbCall('page.setType', preset === true ? { id, type, preset: true } : { id, type }),
  blockSetAction: (pageId, blockId, assignee, dueRaw) => dbCall('block.setAction', { pageId, blockId, assignee, dueRaw }),
  pageGet: (id) => dbCall('page.get', { id }),
  pageDelete: (id) => dbCall('page.delete', { id }),
  pageSetTitle: (id, title) => dbCall('page.setTitle', { id, title }),
  pageSetMemo: (id, memo) => dbCall('page.setMemo', { id, memo }),
  pageSummarize: (id) => ipcRenderer.invoke('page:summarize', id),
  blockUpdate: (pageId, blockId, patch) => dbCall('block.update', { pageId, blockId, patch }),
  // 0.13.1: 5つ目の parentId は置き場の親（NR6）・6つ目の toggle はトグル見出し。足した引数が無ければ今の形を送る
  blockInsert: (pageId, afterBlockId, type, level, parentId, toggle) => dbCall('block.insert', {
    pageId, afterBlockId, type, ...(level === undefined ? {} : { level }), ...(parentId === undefined ? {} : { parentId }), ...(toggle === true ? { toggle } : {}) }),
  blockRemove: (pageId, blockId) => dbCall('block.remove', { pageId, blockId }),
  // 0.13.0 ED-2: 3つ目が { afterId } なら「その行の後ろへ」（'' は頭）、数なら今の toIndex
  // 0.13.1: { afterId, parentId } の parentId は '' の afterId と一緒にその親の子の頭へ（NR6）
  blockMove: (pageId, blockId, to) => dbCall('block.move', to && typeof to === 'object'
    ? { pageId, blockId, afterId: to.afterId, ...(to.parentId === undefined ? {} : { parentId: to.parentId }) } : { pageId, blockId, toIndex: to }),
  // 0.13.0 ED-2: 分割（text は画面の今の文・at は分ける位置）・結合（text は今の行の文）・型の変換（level は見出しの段）・複製（afterId は Alt で落とした所）
  // （点検8）5つ目の afterId は文のある行の頭で上に足す行の置き場（画面で上に見えている行。'' は頭）
  // 0.13.1: 6つ目の inside は新しい行を今の行の最初の子に（TQ3）・merge の4つ目の intoId は画面で上に見えている行（TQ1）・turnInto の5つ目の toggle はトグル見出し
  // 0.14.0 EB-2（R58）: 最後の rich は画面の今の飾り（無ければ送らない）
  blockSplit: (pageId, blockId, text, at, afterId, inside, rich) => dbCall('block.split', {
    pageId, blockId, text, at, ...(afterId === undefined ? {} : { afterId }), ...(inside === true ? { inside } : {}), ...(rich === undefined ? {} : { rich }) }),
  blockMerge: (pageId, blockId, text, intoId, rich) => dbCall('block.merge', {
    pageId, blockId, text, ...(intoId === undefined ? {} : { intoId }), ...(rich === undefined ? {} : { rich }) }),
  blockTurnInto: (pageId, blockId, type, level, toggle) => dbCall('block.turnInto', {
    pageId, blockId, type, ...(level === undefined ? {} : { level }), ...(toggle === true ? { toggle } : {}) }),
  blockDuplicate: (pageId, blockId, afterId, parentId) => dbCall('block.duplicate', {
    pageId, blockId, ...(afterId === undefined ? {} : { afterId }), ...(parentId === undefined ? {} : { parentId }) }),
  // 0.13.1（決めたこと 10）: 字下げ（dir は 'in'・'out'）・トグルの開け閉め（1つ・ページの全部）。答えは { page }
  blockIndent: (pageId, blockId, dir) => dbCall('block.indent', { pageId, blockId, dir }),
  blockSetOpen: (pageId, blockId, open) => dbCall('block.setOpen', { pageId, blockId, open }),
  blockSetOpenAll: (pageId, open) => dbCall('block.setOpenAll', { pageId, open }),
  // 0.14.0 EB-2（決めたこと 2・6・21）: 元に戻すの歩みの受け口（cb({ cmd, pageId, step })）・自分の歩みを戻す（steps は tx の並び）・行の色（'' で外す）
  onEditStep: (cb) => { if (typeof cb === 'function') editSteps.push(cb); },
  editRevert: (pageId, steps) => dbCall('edit.revert', { pageId, steps }),
  blocksSetColor: (pageId, ids, color) => dbCall('blocks.setColor', { pageId, ids, color }),
  // 0.14.0 EK-2（決めたこと 25・30）: 貼り付けは1つの命令（afterId は文のある行の頭のときの、画面で上に見えている行・inside は子の見えている行の文の終わり）。
  // 選んだ行の操作も1つの命令（ids は画面の順）。無い引数は送らない（block.* と同じ形）
  blockPaste: (pageId, blockId, rich, at, blocks, afterId, inside) => dbCall('block.paste', {
    pageId, blockId, rich, at, blocks, ...(afterId === undefined ? {} : { afterId }), ...(inside === true ? { inside } : {}) }),
  blocksRemove: (pageId, ids) => dbCall('blocks.remove', { pageId, ids }),
  blocksMove: (pageId, ids, afterId, parentId) => dbCall('blocks.move', { pageId, ids, afterId, ...(parentId === undefined ? {} : { parentId }) }),
  blocksDuplicate: (pageId, ids, afterId, parentId) => dbCall('blocks.duplicate', {
    pageId, ids, ...(afterId === undefined ? {} : { afterId }), ...(parentId === undefined ? {} : { parentId }) }),
  blocksTurnInto: (pageId, ids, type, level, toggle) => dbCall('blocks.turnInto', {
    pageId, ids, type, ...(level === undefined ? {} : { level }), ...(toggle === true ? { toggle } : {}) }),
  hotkeyState: () => ipcRenderer.invoke('hotkey:state'),
  segmentUpdate: (pageId, segId, patch) => dbCall('segment.update', { pageId, segId, patch }),

  // 議事録セッション
  meetingToggle: () => ipcRenderer.invoke('meeting:toggle'),
  // 0.13.0 RDY-2（計画 docs/plans/2026-10-24-130.md の第2部 RD1・RD2・RD14）: 録音の前のページを開く・閉じる・始めるだけ（DB の命令でないので APP_COMMANDS に入れない）。
  // 始める口は { pcOnly: true } のほかを渡さない（きっかけの符号は main が決める）
  meetingPrepare: () => ipcRenderer.invoke('meeting:prepare'),
  meetingUnprepare: () => ipcRenderer.invoke('meeting:unprepare'),
  meetingStart: (o) => ipcRenderer.invoke('meeting:start', o && o.pcOnly === true ? { pcOnly: true } : {}),
  meetingDiscard: () => ipcRenderer.invoke('meeting:discard'),
  meetingStatus: () => ipcRenderer.invoke('meeting:status'),
  meetingSetMemo: (memo) => ipcRenderer.invoke('meeting:set-memo', memo),
  // 0.11.0 V-1（決めたこと 10）: 録音中のページで種類を選ぶ（key は選べる鍵か auto）。答えは { ok, memo, inserted, meetingType }
  meetingSetType: (key) => ipcRenderer.invoke('meeting:set-type', key),
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
  // 0.13.2 LN-4（計画 docs/plans/2026-10-28-132.md の LR20）: 自動で開いたログインの窓でログインできた（中身なし。画面は accountStatus を読み直す）
  onAccountChanged: (cb) => ipcRenderer.on('account:changed', () => cb()),
  accountLogout: () => ipcRenderer.invoke('account:logout'),
  claudeStatus: () => ipcRenderer.invoke('claude:status'),
  claudeTest: () => ipcRenderer.invoke('claude:test'),
  // 第1b回の続き Lane F-c・F-d: 見える窓を開き、閉じたら確かめ直した答え（{ ok, status } か { ok: false, code, message }）を返す
  claudeLogin: () => ipcRenderer.invoke('claude:login'),
  claudeInstall: () => ipcRenderer.invoke('claude:install'),
  // 0.10.0 C-3: Claude デスクトップへの MCP の登録（引数なし。設定ファイルの場所は main が決める）。答えは { desktop: { state, files, running } } と { ok, state, code?, running? }
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),
  mcpRegister: () => ipcRenderer.invoke('mcp:register'),
  mcpUnregister: () => ipcRenderer.invoke('mcp:unregister'),
  // 0.10.0 L-1: 議事録のリンクの住所の頭（https://…/open#p=。住所は main だけが持つ）
  linkBase: () => ipcRenderer.invoke('app:link-base'),
  // 0.10.0 LN-4: 検索の窓に貼ったリンクの照らし（main で。→ { id, anchor } か null）と、リンクで起こされたときに開くページ（{ id, anchor }）
  parseLink: (s) => ipcRenderer.invoke('app:parse-link', s),
  onOpenLink: (cb) => ipcRenderer.on('page:open-link', (_e, p) => cb(p)),
  // 0.14.0 EB-5（計画 docs/plans/2026-10-26-140.md の決めたこと 20・33）: 行の飾りのリンクを開く（Ctrl+クリック）。main が照らし直す。答えは開いたか
  openLink: (url) => ipcRenderer.invoke('app:open-link', typeof url === 'string' ? url : ''),
  // 0.10.0 LS-2: main が今作っている要約のページの ID の並び（要約の欄の鍵の making）
  onSummaryRunning: (cb) => ipcRenderer.on('summary:running', (_e, ids) => cb(ids)),

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
  // 0.9.3 M-5・M-6: 録音中のページの音の波（main が録音バーに聞いて照らした { mic, sys, warn }。10 回／秒）
  onMeetingLevel: (cb) => ipcRenderer.on('meeting:level', (_e, p) => cb(p)),
  onMeetingProgress: (cb) => ipcRenderer.on('meeting:progress', (_e, p) => cb(p)),
  onPagesUpdated: (cb) => ipcRenderer.on('pages:updated', (_e, p) => cb(p)),
  // 0.13.0 ED-5（EQ22 (a)）: ID の文字（前に出す）か { id, saved }（締めの保存の印）。2つ目は照らした真偽の1つだけ。形の違う値は渡さない
  onPageOpen: (cb) => ipcRenderer.on('page:open', (_e, v) => {
    if (typeof v === 'string') cb(v, { saved: false });
    else if (v && typeof v === 'object' && typeof v.id === 'string') cb(v.id, { saved: v.saved === true });
  }),
  onPageUpdated: (cb) => ipcRenderer.on('page:updated', (_e, p) => cb(p)),
  // 0.13.2 LN-2（計画 docs/plans/2026-10-28-132.md の LR10）: 文字起こし待ちの残りの区間の数（main が区間を1つ片付けるたびに送る { id, left, running }）
  onPagePending: (cb) => ipcRenderer.on('page:pending', (_e, p) => cb(p)),
  // 0.13.2 LN-5（計画 docs/plans/2026-10-28-132.md の LA4・PQ4）: 議事録のページの「残り n 区間」（{ left, running, busy }）と［もう一度文字起こし］（{ ok, left } | { ok: false, code }）。
  // DB の命令でないので APP_COMMANDS に入れない
  pagePending: (id) => ipcRenderer.invoke('page:pending', { id }),
  pageRetranscribe: (id) => ipcRenderer.invoke('page:retranscribe', { id }),
  onEngineFetchProgress: (cb) => ipcRenderer.on('engine:fetch-progress', (_e, s) => cb(s)),
});
