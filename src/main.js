/*
 * NaTsu — 音声入力・議事録ツール（オンラインはクラウドの文字起こし、オフラインは手元の whisper。要約は各自の Claude Code）
 *
 * 0.10.0（D59）で要約のローカル AI（llama.cpp）を外した。つながらないときの要約は「要約待ち」にし、つながったら作る。
 * 議事録はページとブロックの構造で保存し、
 * 要約の各要点には根拠となった発言へのリンク（出典）を機械的に付与する。
 */
'use strict';

const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, clipboard, nativeImage, screen, dialog, shell, session,
  nativeTheme, powerSaveBlocker, powerMonitor,
  // 議事録の DB のプロセス（第2a1回 ST2）と、main・画面それぞれの口
  utilityProcess, MessageChannelMain,
  // クラウドの文字起こしの鍵の暗号（第1c回 OL3。非同期の形だけを secrets.js が使う）
  safeStorage,
  // 録音中のページが見えないときの Windows の知らせ（第1d回 A-8・RL15・D17）
  Notification,
  // エンジンの取り込みの通信（第0b回 RF2。会社のプロキシ・PAC・証明書のストアを使う）。net の名前は下の Node の net が使う
  net: electronNet,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const net = require('net');
globalThis.fetch = require('./mainlib').loopbackOnlyFetch(globalThis.fetch);

const store = require('./store');
const cite = require('./cite');
const { attachCitations } = cite;
// 要約中に文字起こしが編集されていても、出典は「要約の材料にした配列」と「いまの配列」の
// 両方を見て付ける（cite.attachCitationsAcross。#4）。まだ無い版では従来どおり今の配列だけ。
const attachAcross = cite.attachCitationsAcross || ((b, f) => attachCitations(b, f.filter((s) => !s.failed)));
const mtype = require('./meetingType');
const memoTypes = require('./memoTypes');
const quality = require('./quality');
const { enrichActionBlocks, groundActionFields } = require('./actions');
const updater = require('./updater');
const { chooseDisplayMedia } = require('./loopback');
// オンラインの文字起こし（第1c回 OL1〜OL4）: オンラインかの判定と経路・OpenAI と同じ形の口・鍵の保管
const { makeOnline, decideStt, decideSummary } = require('./online');
const sttCloud = require('./stt-cloud');
const { classifyNetError } = require('./engine-fetch');   // ログインの窓の did-fail-load の分け方（第1d回 A-11）
// 議事録の保存（第2a1回 ST1・ST2）。main の議事録の読み書きは await db.call(cmd, args) を通る。中身は議事録の DB のプロセス
// （utilityProcess・NaTsu DB。src/db/server.js）で、main は客（src/db/client.js）と自分用の口（役 main）で頼む。
// 子は loadStores（whenReady の中。utilityProcess は ready の後でしか起こせない）で起こす。init の dataDir・network もそこで決める。
// page.get の経路の行は、子が送り先の表示の名前（labels）で添える
const { makeDbClient } = require('./db/client');
const { isNetworkPath } = require('./db/snapshot');
const DB_INIT = {
  dataDir: '',
  labels: Object.fromEntries(Object.entries(sttCloud.PRESETS).map(([id, p]) => [id, p && typeof p.label === 'string' ? p.label : ''])),
  network: false,
};
// 終わるとき・更新の前に DB を閉じる待ち（close の待ちはそれぞれこの長さまで）
const DB_CLOSE_MS = 3000;
const db = makeDbClient({
  fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
  Channel: MessageChannelMain,
  serverPath: path.join(__dirname, 'db', 'server.js'),
  init: DB_INIT,
  log: (line) => engineLog(line),
  onEvent: (ev) => onDbEvent(ev),
});
const { makeSecrets } = require('./secrets');
// 文字起こしの中継の住所とログインの口（第1d回 A-1・A-2。Electron を読まない。通信は net.request を渡す）
const relay = require('./relay');
const security = require('./security');
const RENDERER_PAGES = { app: path.join(__dirname, 'renderer', 'app.html'), overlay: path.join(__dirname, 'renderer', 'overlay.html'), nudge: path.join(__dirname, 'renderer', 'nudge.html') };
const minutes = require('./minutes');
// オンラインの要約（第1c回 OL5）: 利用者の Claude Code を子のプロセスで呼ぶ部品
const claudeCli = require('./claude-cli');
const { markdownToBlocks, dropRedundantEmpty } = minutes;
// テンプレートの写し（見出しだけ・雛形そのまま）を落とす。minutes.js 側に
// まだ無い版でも動くよう、無ければ素通しにする。
const dropTemplateEcho = minutes.dropTemplateEcho || ((b) => b);
const { defaultSettings, readSettings, pickSavable, isSettingsShape, isEmailShape, SETTING_RULES } = require('./settings');
// DB の外の JSON（設定・履歴）を読む・退ける・書く部品（第1a回 JS1〜JS3・JS6）
const J = require('./jsonfile');
// 画面の覚え書き（第1b回 N6）の照らし。純粋な関数だけ（Electron を読まない）。読み書きは上の J で行う
const W = require('./winstate');
// Claude デスクトップの設定に NaTsu の MCP の1項目を合わせる部品（0.10.0 C-1。純粋。読み書きはここで J を使う）
const MC = require('./mcp-config');
// 0.10.1 CD-2: 書いた後に読み直した中身が、書いた中身とちょうど同じかを見る（決めたこと 9）
const { isDeepStrictEqual } = require('util');
// エンジンの取り込み（第0b回 R7）。置き場所・記録・照らし（通信しない）とピン（版・URL・大きさ・SHA-256）
const engineInstall = require('./engine-install');
const { MANIFEST } = require('./engine-manifest');
// PC の中の文字起こしエンジンへの要求（0.9.4 S-2。Node の fetch の 300 秒の時間切れを通らない node:http の部品。127.0.0.1 だけ）
const localhttp = require('./localhttp');
const { localDateISO } = require('./dates');
const {
  saveIfExists, meetingDurationSec, promptTail,
  registerHotkeys, resolveStartupHotkeys, saveHotkeys, makeSummaryRunner, tickStep,
  pasterScript, parsePasterLine,
  engineFileIssue, engineIssueMessage, engineInAppDir, engineDirWarning, portInUseError, guardEngineSettings, keptDifferent, closeConfirm, restartBlock, logReason,
  engineSpawnPlan, vcRuntimeVersions, vcRuntimeIssue, runtimeGate, engineExitHint, spawnErrorHint, speedLine,
  truncationMessage, buildPromptParts,
  publicSegments, settledSegments, pendingDurationMs, recoverSegments, staleSegbufDirs, EtaTracker, chooseDraftName,
  skipPendingSegments, startSegmentMode, segmentModeNext, segmentBaseMs, nextLiveSegmentMs,
  stallAfter, stallStep, sttProblemOf, problemForRoute, notifyGate,
  idleEnginesToStop, silentWav, wavLevelDbfs, mergeSummaryType, memoEvidence, typesForView,
  sameShas, keepPrevious, candStamp, repairIdsOf, pathUsedBy, fetchMinutesLeft,
  pickDefaultPath,
  cloudLikely, offlineChosen, startPlan, dictationPlan, KEPT_CODES, keptCodeFor, KEPT_SUMMARY_TEXT, SUMMARY_WAIT_TEXT, summaryRetryPick,
  SILENT_DBFS, SPEECH_DBFS, wavLoudestDbfs, hintFold, hintEcho,
  localTimeoutMs,
} = require('./mainlib');
// クリップボードの読み書き（mainlib.copyPrivate・deliverText）は main.js の同じ名前の包みとぶつかるので、lib から呼ぶ
const lib = require('./mainlib');
// 議事録のリンクの形と照らし（0.10.0 LN-1。純粋。住所の頭 LINK_ORIGIN の1か所: 決めたこと 154）
const natsulink = require('./natsulink');
// 0.12.1 LV-2（計画 docs/plans/2026-10-24-121.md）: 会議を出たかの判断（純粋。leaveInit・leaveStep・LEAVE_IDS）
const ML = require('./meetleave');
// 0.9.2 I-1（ヘルプの計画の H-12）: NaTsu ヘルプセンター（Access の後ろ。中継と同じ natsu-code の workers.dev）。住所は main だけが持ち、
// 画面は記事の名前だけを渡す（app:open-help が lib.helpPath の決まった一覧で照らし、無ければホーム）。0.10.0 LN-1: 住所の頭は src/natsulink.js から
const HELP_URL = `${natsulink.LINK_ORIGIN}/`;

// package.json の build.appId の写し。配る package.json から build は消えるので、ここに持つ
// （identity.test.js が食い違いを見る）。インストーラーが付けるショートカットの AppUserModelID と同じ
const APP_ID = 'local.natsu.app';
// メッセージの窓の見出し。渡さないと Windows は app.name（小文字の natsu）を出す
const APP_TITLE = 'NaTsu';

const CPU_OLD_DEFAULT_THREADS = Math.max(4, Math.floor(os.cpus().length / 2));
const CPU_DEFAULT_THREADS = Math.max(4, os.cpus().length - 2);
const MIN_RECORD_MS = 400;
// メモはプロンプトにそのまま前置きされるので、文脈を食い潰さない範囲に収める
const MEMO_MAX = 1500;
const ENGINE_READY_TIMEOUT_MS = 90000;

// 既定の設定（31 のキー。第1c回で5つ足し、0.7.0 U-1 で送り先と同意の4つを外した）は settings.js の defaultSettings。スレッド数は CPU の数から決まる（第1a回 Task 2-2 で移した）
const DEFAULT_SETTINGS = defaultSettings(os.cpus().length);

// ---------------------------------------------------------------- 状態
let settings = { ...DEFAULT_SETTINGS };
let history = [];
let state = 'idle'; // idle | recording | processing | meeting | meeting-finalizing
let tray = null;
let trayIconIdle = null;
let trayIconRec = null;
let overlayWin = null;
let mainWin = null;
// 第1d回 A-8（D17）: 画面が最後に送った meeting:live-shown（録音中のページを開いていて、窓が隠れていない）。読み込み直すと false に戻す。
// lastWinNotice は出した Windows の知らせ（押したときの受け口が消えないよう、次を出すまで持つ）
let liveShownByUi = false;
let lastWinNotice = null;
let quitting = false;
// 終了のときの「要約が中断されました」の書き込みを1回だけ待つ（第2a1回 ST1。before-quit）。待つのは合わせて QUIT_MARK_MS まで
let quitMarkDone = false;
const QUIT_MARK_MS = 3000;
// 録音・文字起こし中は OS にアプリを眠らせない。省電力でプロセスが
// 絞られると、録音の区切りも文字起こしも静かに止まる。
let powerBlockId = null;
// 録音の区切りの見張り。レンダラーの setTimeout は画面が隠れると間引かれる
// （実機で1区間が9分になり、文字起こしが時間切れで失われた）。
// main のタイマーは間引かれないので、ここから5秒ごとに合図を送り、
// 録音側は期限を過ぎていたら区間を切る。
let meetingTickId = null;
function startMeetingTick() {
  if (meetingTickId) return;
  meetingTickId = setInterval(() => {
    // 送る／飛ばす／消す の判断は mainlib.tickStep（main.test.js で実行して固定）。
    // 見張りを消すのは議事録が無くなったときだけで、一時停止は送信を飛ばすだけにする。
    // 一時停止で消すと、再開しても誰も起こし直さず、以後の区切りが画面の
    // 間引かれるタイマー任せに戻る（1区間が9分になる元の不具合が再発する）。
    tickStep({ state, meeting },
      () => sendToOverlay('overlay:tick', {}),
      () => { clearInterval(meetingTickId); meetingTickId = null; });
  }, 5000);
}
function applyTheme() {
  // themeSource を切り替えると、レンダラー側の prefers-color-scheme が
  // 変わり、CSSのダーク定義がそのまま効く。画面側のJSは不要。
  try {
    nativeTheme.themeSource = settings.theme === 'light' || settings.theme === 'dark'
      ? settings.theme : 'system';
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff');
    }
  } catch (_) { /* noop */ }
}

function updatePowerBlock() {
  // 要約中も忙しい（#52）。省電力で絞られると、数分かかる要約が静かに止まる。
  // エンジンを実際に取っている間も眠らせない（第0b回 Task 14。数 GB の取り込みが止まる）。isBusy には数えない。
  // 回線を待っている（waiting。何日も続きうる）・記録中で止めている（held）・一時停止の間は眠らせてよい（Q14。2026-10-17 に了承）。
  // 起きた後は、係が待ちの時計（60 秒）と net.isOnline で自分で試し直す。
  // 締めの返事（議事録の DB）を待つ会議がある間も眠らせない（録音の状態は待機に戻っている。第2a1回 M-4 の残りを 0.7.0 の前に直した）
  const busy = state !== 'idle' || isSummarizing() || engineFetchDownloading() || finalizingPageIds.size > 0;
  if (busy && powerBlockId === null) {
    try { powerBlockId = powerSaveBlocker.start('prevent-app-suspension'); } catch (_) { powerBlockId = null; }
  } else if (!busy && powerBlockId !== null) {
    try { powerSaveBlocker.stop(powerBlockId); } catch (_) { /* noop */ }
    powerBlockId = null;
  }
}
let pasterProc = null;
// 常駐 PowerShell の応答を待っている人（送った順に受け取る。mainlib.parsePasterLine）
const pasterWaiters = [];
// 音声入力を始めたときの前面ウィンドウ（HWND）。貼り付け先が変わっていれば貼らない（#54）
let dictationFg = Promise.resolve('');
const FG_REPLY_MS = 300;      // fg の応答待ち。常駐が起動中なら間に合わず ''（従来どおり確認なしで貼る）
const PASTE_REPLY_MS = 1500;  // paste の応答待ち。無応答なら貼れたものとして扱う（unknown）
let programmaticMove = false;
let recoveredPageId = null;
// データフォルダ（<userData>/data）を開けなかった理由。画面が出てから1回知らせる（createMainWindow）
let storeError = '';

let meeting = null;
// 0.13.0 RDY-1（計画 docs/plans/2026-10-24-130.md の第2部 RD3）: 録音の前のページ（［＋ 新しい議事録］で開いた、まだ録音していないページ）。
// { memo, meetingType, openedAt }。メモリだけ（下書き・DB・画面の覚え書きに書かない）。同時に1つ。録音を始めたら takePrep が会議へ移して null にする
let prep = null;
// 締めの返事を裏で待っている会議のページの ID と下書きの名前（第2a1回 ST6・F9）。録音の状態は待たせない。復旧はこの下書きを飛ばし
// （同じ会議を2つ目の道から書かない）、新しい会議はこの下書きを脇へ退けない（返事の後に消すのは、この会議の下書き）
const finalizingPageIds = new Set();
const finalizingDrafts = new Set();
// 締めのときに DB の用意がまだ（移行中・起こし直し中）なら、録音バーにこの文（D9。overlay.html は変えず、main が送る文だけ）
const DB_WAIT_TEXT = '録音を保存しました。議事録は準備ができしだい作ります';
let segChain = Promise.resolve();
let pendingSegs = 0;
// 0.12.0 SP-3a（D66・決めたこと 126〜133）: 2つの流れの会議で、区間がどちらの流れか（'mic'・'loopback'）。下書き・DB には書かない（メモリの中だけ）
const segLane = new WeakMap();

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');
const historyPath = () => path.join(app.getPath('userData'), 'history.json');

// ---------------------------------------------------------------- 永続化
// 設定と履歴は src/jsonfile.js の部品で読み書きする（第1a回 JS1〜JS3・JS5・JS6・P16）。
// - 読む: BOM 付き・UTF-16 も読む。壊れていたら消さずに .broken-<時刻> へ退けて既定（設定）か空（履歴）で始める。
//   設定は項目ごとに読み（settings.js の readSettings）、壊れた項目だけ直したら、元を写しで残して直した設定を
//   すぐ1回書き戻す（次の起動ではもう知らせない）。知らないキーは残す。
// - 書く: 一時ファイルに全部書いて fsync してから名前を変える（writeJsonFile）。書き手は1つのファイルに1つ。
// - 知らせ: 起動の途中の知らせは startupNotices に貯め、画面が読み終えてから1回にまとめて送る（左下の知らせは
//   新しい文で前の文を置き換えるため）。どれも engine.log に1行書く（キーの名前・理由の符号・ファイルの名前だけ。値は書かない）。
const startupNotices = [];
const NOTICE = {
  settingsRepaired: (labels, name) => `設定の一部（${labels}）が読めない値だったので、その部分だけ既定に戻しました。元の設定は ${name} に残してあります。`,
  settingsBroken: (name) => `設定のファイルが壊れていたので、既定の設定で起動しました。壊れたファイルは ${name} として残してあります。`,
  settingsEncoding: (name) => `設定のファイルの文字の形式（Shift-JIS など）を読めなかったので、既定の設定で起動しました。元のファイルは ${name} として残してあります。メモ帳で「UTF-8」を選んで保存し直すと読めます。`,
  settingsFalseLike: (label, raw) => `設定の「${label}」は、ファイルに "${raw}" と書かれていたため、今までどおりオンのままにしました。オフにするときは設定の画面で切ってください。`,
  historyBroken: (name) => `音声入力の履歴のファイルが壊れていたので、空の履歴で始めました。元のファイルは ${name} として残してあります。`,
  historyNotSaved: '音声入力の履歴の変更を保存できませんでした。次の変更のときにもう一度保存します。',
  settingsBusy: '設定のファイルをほかのプログラムが使っていて読めませんでした。読めるまでは既定の設定で動き、設定は保存しません。少し後にもう一度読みます。',
  settingsReloaded: '設定のファイルを読めたので、保存してある設定に切り替えました。読めない間に画面で変えた設定は保存していません。',
  settingsReadOnly: '設定のファイルが読み取り専用になっているため、管理者が決めた設定として使います。画面で変えた設定は保存されません（次の起動で元に戻ります）。',
  settingsNotSaved: '設定を保存できませんでした。次の変更のときにもう一度保存します',   // 設計書の文のまま（N7）
  historyBusy: '音声入力の履歴のファイルをほかのプログラムが使っていて読めませんでした。読めるまでは新しい履歴を保存せずに持っておき、少し後にもう一度読みます。',
  // 録音の控え（第1a回 Task 2-5。N12・N13・N15・N16。議事録のファイルの N11・N17 は、第2a1回から起動で元の JSON に触れないので無い）
  draftBusy: '前回の会議の下書きを、ほかのプログラムが使っていて今は読めません。消さずに残してあり、少し後にもう一度復旧を試します。',
  recoveryBroken: (name) => `文字起こし待ちの記録が壊れていたので、${name} として残しました。残っていた音声は7日後に片付けます。`,
  draftBroken: (name) => `前回の会議の下書きのファイルが壊れていたので、${name} として残しました。`,
  recoveryNotSaved: '文字起こし待ちの記録を保存できませんでした。音声は残してあり、次の起動でもう一度試します。',
  // 議事録の DB を使えない（第2a1回 D1。開けない・自分の確かめが通らない・10分に5回落ちた）。録音は続く
  dbDown: '議事録の保存の仕組みを使えません。録音は音声と下書きとして保存を続けています。NaTsu を終了して、もう一度起動してください（理由の記録: %APPDATA%\\natsu\\engine.log）。',
  // 移行と取り込み・控え（第2a1回 M-4。計画「画面と知らせの文」の D2〜D8。D0 は窓の文: migratePlan）
  migrated: (n) => `議事録 ${n} 件を新しい保存の形に移しました。元のファイルは %APPDATA%\\natsu\\data\\pages に残しています。`,
  skipped: (n) => `壊れているか形が合わなかったため、${n} 件のファイルを移せませんでした（元の場所にそのまま残しています）。ほかの議事録はそのまま使えます。`,
  migrateFailed: '議事録を新しい保存の形に移せませんでした。元のファイルはそのまま残っています。録音は下書きとして保存を続けます。NaTsu を終了して、もう一度起動してください（起動のときにもう一度移します）。',
  reimported: (n) => `古い版で保存された議事録 ${n} 件を取り込みました。`,
  restored: (at) => `議事録の保存が壊れていたため、${at} の控えから戻しました。それより後の変更が抜けているかもしれません。壊れたファイルは natsu.db.broken-… として残しています。`,
  dbNewer: 'この議事録の保存は、新しい版の NaTsu で作られています。この版では読むだけにします（変更は保存されません）。新しい版の NaTsu を入れ直してください。',
  dbNetwork: '保存先がネットワークの場所にあるため、少し遅いが安全な書き方に切り替えました。',
  // 画面の覚え書き（第1b回 W1。P16）
  winStateBroken: (name) => `画面の覚え書き（窓の大きさ・開いていたタブ）のファイルが壊れていたため、脇へ退けて最初の大きさで開きました（退けた先: ${name}）。`,
  // Claude との連携（0.10.0 C-2。計画の「左下の知らせ（N）」と決めたこと 151。どちらも［設定を開く］で項目「要約」）
  mcpStale: 'NaTsu の置き場所が変わったため、Claude から議事録を読めなくなっています。設定の「要約」で［登録し直す］を押してください。',
  mcpGone: 'Claude デスクトップへの登録が消えています。［設定を開く］で［登録し直す］を押してください。',
  // 0.10.1 CD-4（D86・RN4）: 起動のときの書き直しが、Claude デスクトップが動いている（か分からない）ためにできなかった
  mcpFix: 'Claude との連携の登録を直します。Claude デスクトップを終了してから［登録し直す］を押してください（タスクトレイのアイコンからも終了してください）。',
};
// 起動の途中（本体の窓がまだ無い）なら startupNotices に貯め、窓ができた後なら画面へ（読み込み中なら読み終えてから）
function laterNotice(msg) {
  if (!mainWin) startupNotices.push(msg);
  else noticeMainWin(msg);
}
// store が壊れた下書きを退けたとき（P16。N15）。第2a1回から store は下書きだけを扱う（initDrafts）ので、ページと文字起こしは来ない
function onStoreReport(ev) {
  if (!ev) return;
  engineLog(`保存: 壊れたファイルを退けました（${ev.kind} ${ev.file} → ${ev.movedTo}、${ev.reason}）`);
  if (ev.kind === 'draft') laterNotice(NOTICE.draftBroken(ev.movedTo));
}
// 議事録の DB の客の知らせ（第2a1回 ST7）。子が落ちたら画面に db:lost（preload が待ちを返す）、起こし直したら口を配り直す（onReady）。
// 諦めた・使えないときは知らせ D1 を1回（録音は下書きと音声の控えに続く）。移すと答えた後に一度も用意ができずに使えなくなった
// （移行の確かめが合わなかった）ときは D1 の代わりに D4（第2a1回 M-4）。
// 子の移行の数（migrate-plan）が来たら窓 D0 で聞き（askMigrate）、進み具合（progress）は録音の進み具合と同じ帯に出す
let dbDownNoticed = false;
let migrateAsked = false;      // ［移す］と答えた（起こし直した子が auto で移すときも）
let dbEverReady = false;       // この起動で一度でも用意ができた
let migrateBand = false;       // 移行の進み具合を帯に出している（用意か使えないで消す）
// 起動は、DB が利用者を待つ（移行の窓）か、この長さを過ぎたら、起動の片付け（DB を待つ）を待たずに窓とホットキーを用意する（F9）
const STARTUP_DB_WAIT_MS = 3000;
let dbNeedsUserResolve = null;
const dbNeedsUser = new Promise((r) => { dbNeedsUserResolve = r; });
// 子が落ちた印。本体の窓に渡した口は落ちた子のもの（死んでいる）なので、次の ready（起こし直した子の用意）で配り直す。
// 「2回目からの ready」で決めると、最初の用意の前（起動・移行の途中）に落ちたとき、起こし直した子の ready がアプリで最初になり、配り直さない
let dbPortStale = false;
function onDbEvent(ev) {
  if (!ev) return;
  if (ev.type === 'lost') {
    dbPortStale = true;
    sendToMainWin('db:lost', {});
  }
  else if (ev.type === 'down') {
    clearMigrateBand();
    if (dbDownNoticed) return;
    dbDownNoticed = true;
    engineLog(`DB: 使えないので知らせた（${ev.why}）`);
    laterNotice(migrateAsked && !dbEverReady && ev.why === 'failed' ? NOTICE.migrateFailed : NOTICE.dbDown);
  } else if (ev.type === 'migrate-plan') {
    // 起こし直した子がもう一度数を送ってきた（客がもう go を送った: auto）なら聞き直さない
    if (ev.auto) migrateAsked = true;
    else askMigrate(ev.counts).catch((e) => engineLog(`DB: 移行の窓を出せませんでした（${errCode(e)}）`));
  } else if (ev.type === 'progress') {
    migrateBand = true;
    sendToMainWin('meeting:progress', { message: `議事録を移しています… ${ev.done}/${ev.total}` });
  }
}
function clearMigrateBand() {
  if (!migrateBand) return;
  migrateBand = false;
  sendToMainWin('meeting:progress', { message: '' });
}
// 窓 D0 の文（数は子が数えたもの。名前も題名も入れない）。壊れているか形が合わず移せないものは broken と badShape の数
function migratePlanText(c) {
  const n = (k) => (Number.isFinite(c && c[k]) ? c[k] : 0);
  const skip = n('broken') + n('badShape');
  return [
    '議事録の保存の形を新しくします（1回だけ）。',
    `移すもの: 議事録 ${n('pages')} 件・文字起こしの発言 ${n('segments')} 件`,
    ...(skip ? [`壊れているか形が合わず移せないファイル: ${skip} 件（元の場所にそのまま残します）`] : []),
    '元のファイルは消さずに残します。移している間も録音はできます。',
    'よければ［移す］を押してください。',
  ].join('\n');
}
// 初めての起動の移行を窓で聞く（第2a1回 ST10・Q1）。［移す］（既定）で移し、［今は移さずに終える］（Esc も）で終える（元の JSON と下書きに
// 何もしない。DB は閉じるだけで natsu.db を作らない。次の起動でまた聞く）。窓が出ている間も録音はできる（締めは裏で DB の用意を待つ）
async function askMigrate(counts) {
  dbNeedsUserResolve();
  if (quitting) return;
  const c = counts || {};
  engineLog(`DB: 移行の窓 ページ ${c.pages}・発言 ${c.segments}・壊れた ${c.broken}・形の合わない ${c.badShape}`);
  const r = await dialog.showMessageBox({
    title: APP_TITLE, type: 'question', message: migratePlanText(c),
    buttons: ['移す', '今は移さずに終える'], defaultId: 0, cancelId: 1, noLink: true,
  });
  if (quitting) return;
  if (r && r.response === 0) {
    migrateAsked = true;
    engineLog('DB: 移行を始める');
    db.migrate(true);
  } else {
    engineLog('DB: 今は移さずに終える');
    quitWhenRecordingEnds();
  }
}
// ［今は移さずに終える］の後（第2a1回 M-4 の残りを 0.7.0 の前に直した）。窓の間に始めた録音（会議・音声入力）があれば、途中で切らずに
// 続け、止めて区間を下書きに書き終えてから終える（締めは DB を待つので、議事録は下書きと音声の控えに残り、次の起動で復旧する）。
// 待つ間は平易な知らせを1回だけ出す。確かめの窓は出さない（録音中に押し間違えて録音を切る道を作らない）
const QUIT_AFTER_RECORDING_TEXT = '録音中なので、録音が終わるまで NaTsu を開いたままにします。議事録の保存の形を移すかは、次に起動したときにもう一度聞きます。終えるときは、録音を止めてください。';
const QUIT_AFTER_RECORDING_POLL_MS = 500;
let quitAfterRecordingNoticed = false;
function quitWhenRecordingEnds() {
  if (quitting) return;
  if (!meeting && state === 'idle' && pendingSegs === 0) { app.quit(); return; }
  if (!quitAfterRecordingNoticed) {
    quitAfterRecordingNoticed = true;
    engineLog('DB: 録音が終わってから終える');
    noticeMainWin(QUIT_AFTER_RECORDING_TEXT);
  }
  setTimeout(quitWhenRecordingEnds, QUIT_AFTER_RECORDING_POLL_MS);
}
// 最初の用意の後に1回: この起動で起きたこと（移した・取り込んだ・戻した・新しい版・ネットワークの場所）を知らせる（D2・D3・D5〜D8）。投げない
async function noticeDbStartup() {
  let s;
  try { s = await db.call('db.status', {}); } catch (e) { engineLog(`DB: 起動の様子を読めませんでした（${errCode(e)}）`); return; }
  if (!s) return;
  const st = s.startup || {};
  const n = (o, k) => (o && Number.isFinite(o[k]) ? o[k] : 0);
  if (st.restored) laterNotice(NOTICE.restored(localStamp(st.restored.from)));
  if (st.migrated) {
    laterNotice(NOTICE.migrated(n(st.migrated, 'pages')));
    const skip = n(st.migrated, 'broken') + n(st.migrated, 'badShape');
    if (skip) laterNotice(NOTICE.skipped(skip));
  }
  if (st.reimport) {
    const got = n(st.reimport, 'added') + n(st.reimport, 'replaced') + n(st.reimport, 'copied');
    if (got) laterNotice(NOTICE.reimported(got));
    const skip = n(st.reimport, 'broken') + n(st.reimport, 'badShape');
    if (st.reimport.skippedChanged && skip) laterNotice(NOTICE.skipped(skip));
  }
  if (s.state === 'newer') laterNotice(NOTICE.dbNewer);
  if (s.journal === 'delete') laterNotice(NOTICE.dbNetwork);
}
// ISO の時刻 → 「2026/10/19 09:05」（ローカル）。読めなければそのまま
function localStamp(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return String(iso || '');
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
// 本体の窓に、画面用の DB の口（役 app）を渡す（読み込みのたび・DB の子を起こし直したとき）。録音バーには渡さない
function sendDbPort() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const port = db.rendererPort();
  if (!port) return;   // 子が居ない（起こし直しの間・諦めた・閉じた）: 起こし直したら onReady で配る
  try { mainWin.webContents.postMessage('db:port', null, [port]); } catch (e) { engineLog(`DB: 画面に口を渡せませんでした（${errCode(e)}）`); }
}
// 子が落ちた後の ready（起こし直した子の用意）で口を配り直す。落ちていない子の最初の ready の前に配った口は、子が用意の前から受けている
db.onReady(() => {
  clearMigrateBand();
  if (!dbEverReady) {
    // 最初の用意（移行と取り込みの後）: 知らせと、毎日の控えの見回り（起動の後に1回見て、その後は 6 時間ごと）
    dbEverReady = true;
    noticeDbStartup().catch(() => {});
    setTimeout(checkDailySnapshot, DAILY_FIRST_MS);
  }
  if (!dbPortStale) return;
  dbPortStale = false;
  sendDbPort();
});
// 毎日の控え（第2a1回 ST9）。手が空いているとき（録音・締めの返事待ち・要約・復旧の文字起こしが無い）だけ、その日にまだ取っていなければ
// snapshot.take({ kind: 'daily' }) を1回頼む。忙しければ少し後に見直す。名前はこのまま（テストの台 mainrun が setTimeout の名前で捕まえる）
const DAILY_FIRST_MS = 60 * 1000;
const DAILY_EVERY_MS = 6 * 60 * 60 * 1000;
const DAILY_BUSY_MS = 5 * 60 * 1000;
let dailyDoneDay = '';
const handsBusy = () => isBusy() || finalizingPageIds.size > 0;
async function checkDailySnapshot() {
  if (quitting) return;
  if (db.state() !== 'ready') { setTimeout(checkDailySnapshot, DAILY_EVERY_MS); return; }
  const today = localDateISO(new Date());
  try {
    if (dailyDoneDay !== today) {
      const s = await db.call('db.status', {});
      const last = s && s.lastSnapshot;
      if (last && last.kind === 'daily' && localDateISO(new Date(last.at)) === today) dailyDoneDay = today;
      else if (handsBusy()) { setTimeout(checkDailySnapshot, DAILY_BUSY_MS); return; }   // 録音・締めの返事待ち・要約・復旧の間は取らない
      else {
        const r = await db.call('snapshot.take', { kind: 'daily' });
        if (r && r.ok) dailyDoneDay = today;
      }
    }
  } catch (e) {
    engineLog(`DB: 毎日の控えを取れませんでした（${errCode(e)}）`);
  }
  setTimeout(checkDailySnapshot, DAILY_EVERY_MS);
}
// 読めない・書けないときの状態（第1a回 Task 2-3。RF22・P14）
// - 'unreadable': 起動の瞬間にほかのプログラムが掴んでいて読めなかった。読み直せるまでは書かない（既定で上書きしない）。
//   読み直しは RETRY_READ_MS の間隔で（使い切ったら止め、設定の画面を開いたときだけ読み直す）
// - 'readonly': 読み取り専用の settings.json（管理者が決めた設定）。その起動で1回だけ知らせる
let settingsState = 'ok';     // 'ok' | 'unreadable' | 'readonly'
let historyState = 'ok';      // 'ok' | 'unreadable'
const RETRY_READ_MS = [3000, 10000, 30000];
const notWritable = () => Object.assign(new Error('読めない間は書かない'), { code: 'NOT_WRITABLE' });
// fsync が効かない場所（ネットワークのフォルダなど）。書くのは続け、記録はその起動で1回だけ
let fsyncNoted = false;
function noteFsyncOnce(code) {
  if (fsyncNoted) return;
  fsyncNoted = true;
  engineLog(`保存: この場所では fsync が使えません（${code}）。書き込みは続けます`);
}
function writeSettingsFile(value, { retry }) {
  if (settingsState === 'unreadable') throw notWritable();
  J.writeJsonFile(settingsPath(), value, { waits: retry ? J.RENAME_WAITS : [], onFsyncUnsupported: noteFsyncOnce });
}
function writeHistoryFile(value, { retry }) {
  if (historyState === 'unreadable') throw notWritable();
  J.writeJsonFile(historyPath(), value, { waits: retry ? J.RENAME_WAITS : [], onFsyncUnsupported: noteFsyncOnce });
}
// まとめ書きの間隔（第1a回 JS7）。今の録音バーの待ちと同じ 350ms のまま（Task 5-1。Windows の CI の 4 回の計りで、設定の大きさの
// 書き込み＋fsync の p95 が 7.53〜32.69ms で、決め方の 100ms まで）
const BATCH_MS = 350;
// 実機の確かめ用に、環境変数 NATSU_TEST_BATCH_MS で間隔を長くできる（設計書の「試し用の長い間隔」。シャットダウンの直前の
// 変更が書き出しの合図で書かれるのを、間隔の前に電源を切って確かめる）。BATCH_MS〜600000 に収め、使ったら engine.log に1行
function batchMs(env = process.env) {
  const raw = env ? env.NATSU_TEST_BATCH_MS : undefined;
  if (raw == null || String(raw).trim() === '') return BATCH_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return BATCH_MS;
  const ms = Math.min(600000, Math.max(BATCH_MS, Math.round(n)));
  engineLog(`まとめ書きの間隔: ${ms}ms（試し用）`);
  return ms;
}
const WRITE_DELAY_MS = batchMs();
// 書き手。1つのファイルに1つ。設定の画面の保存は now（すぐ同期で書く）、録音バーの位置は set（まとめ書き）で、
// 同じ書き手なので古い中身で互いを上書きしない
const settingsWriter = J.makeBatchWriter({ name: 'settings.json', write: writeSettingsFile, delayMs: WRITE_DELAY_MS, log: engineLog });
const historyWriter = J.makeBatchWriter({ name: 'history.json', write: writeHistoryFile, delayMs: WRITE_DELAY_MS, log: engineLog });
// 画面の覚え書き（第1b回 N6・P15・P16）。窓の大きさと位置・最大化・拡大の倍率・サイドバーの幅と畳み・開いているタブを
// %LOCALAPPDATA%\natsu\window-state.json に覚える（Roaming の userData に置かない。照らしは src/winstate.js）。
// 作り直せる小さなファイルなので、壊れていたら退けて既定で開き（控えは3つまで: JS2）、知らせ W1 を1回。読めなければ
// その起動では書かない（RF22。開いている窓が動いてしまうので、設定のような読み直しはしない: 計画「設計書と違えたところ」の 7）。
// 窓の動き・拡大・画面からの頼みは set でまとめ書きし、残りは書き出しの合図（flushAllWriters）で書く（RF21）
const winStatePath = () => W.statePath(process.env, app.getPath('userData')).file;
let winState = W.defaults();
let winStateState = 'ok';     // 'ok' | 'unreadable'
let winStateLastSet = '';     // 最後に読めた・頼んだ中身（同じなら書かない。起動の最大化の合図などで書き直さない）
let winTabsDropped = 0;       // 読んだときに照らしで外したタブの数（録音中のページ・形の悪い鍵。ui:get の記録に足す）
function writeWinStateFile(value, { retry }) {
  J.writeJsonFile(winStatePath(), value, { waits: retry ? J.RENAME_WAITS : [], onFsyncUnsupported: noteFsyncOnce });
}
const winStateWriter = J.makeBatchWriter({ name: 'window-state.json', write: writeWinStateFile, delayMs: WRITE_DELAY_MS, log: engineLog });
function saveWinState() {
  if (winStateState === 'unreadable') return;
  const text = JSON.stringify(winState);
  if (text === winStateLastSet) return;
  winStateLastSet = text;
  winStateWriter.set(JSON.parse(text));
}
// whenReady の中、loadStores() の後（screen は ready の後でしか使えない）。投げない
function loadWinState() {
  const r = J.loadJsonFile(winStatePath(), { shape: W.shapeOk, maxBytes: J.SMALL_MAX, keep: 3 });
  let raw;
  if (r.state === 'ok') {
    raw = r.value;
  } else if (r.state === 'broken') {
    engineLog(`画面の覚え書き: 壊れていたので退けた（${r.reason}）`);
    startupNotices.push(NOTICE.winStateBroken(path.basename(r.movedTo)));
  } else if (r.state === 'unreadable') {
    winStateState = 'unreadable';
    engineLog(`画面の覚え書き: 読めないので、この起動では書かない（${r.code}）`);
  }
  let displays = [];
  try { displays = screen.getAllDisplays(); } catch (_) { displays = []; }
  winState = W.normalize(raw, displays).state;
  const rawOpen = raw && raw.tabs && Array.isArray(raw.tabs.open) ? raw.tabs.open.length : 0;
  winTabsDropped = Math.max(0, rawOpen - winState.tabs.open.length);
  if (r.state === 'ok') winStateLastSet = JSON.stringify(winState);
}
// 窓の resize・move・maximize・unmaximize。覚えるのは getNormalBounds（最小化・最大化の間も元の位置と大きさ: F2）
function rememberWinBounds() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const b = W.boundsOf(mainWin);
  if (b) winState.bounds = b;
  winState.maximized = Boolean(mainWin.isMaximized());
  saveWinState();
}
// 拡大の段を1つ動かして当てる（Ctrl+＋／－／0・JIS の Ctrl+；・Ctrl+ホイール。200% で止まる: F4）
function stepWinZoom(dir) {
  if (!mainWin || mainWin.isDestroyed()) return;
  winState.zoom = W.stepZoom(winState.zoom, dir);
  try { mainWin.webContents.setZoomFactor(winState.zoom); } catch (_) { /* noop */ }
  saveWinState();
}
// 書き出しの合図（第1a回 JS8・RF21）。まとめ書きの残りを全部同期で書く。投げない。受け口はどれも最初にこれを呼ぶ:
// before-quit・will-quit・すべての窓の session-end・query-session-end・powerMonitor の suspend・lock-screen・shutdown・
// 本体の窓の close と hide・process の exit・再起動の直前（relaunchAndExit）。名前はこのまま（テストが文字で探す）
// 取り消しの控えを前に書けなかったら（purgeUnsaved）ここでも書き直す（第2a1回 M-3 の点検。1行のまま: 変異 mn-recovery-rewrite が字面で当てる）
function flushAllWriters() { try { retryUnsavedRecovery(); } catch (_) { /* 書き直せなくても設定などの書き出しは続ける */ } try { if (purgeUnsaved) savePurgePending(); } catch (_) { /* 同上 */ } return J.flushAll(); }
// 自動更新と再起動。app.exit は before-quit・will-quit を出さないので、その前に書き出す。app.exit( はここだけ
function relaunchAndExit() { flushAllWriters(); app.relaunch(); app.exit(0); }
// 起動のときに、強制終了で残った JSON の一時ファイルを消す（第1a回 JS4。WAV などほかの .tmp は残す）。
// 単一起動の鍵を取った後（ほかの NaTsu が書いている途中の一時ファイルを消さない）、whenReady の最初に呼ぶ。投げない
function cleanStartupTemps() {
  const ud = app.getPath('userData');
  const data = path.join(ud, 'data');
  const dirs = [ud, data, path.join(data, 'pages'), path.join(data, 'transcripts')];
  try {
    for (const e of fs.readdirSync(path.join(data, 'segbuf'), { withFileTypes: true })) if (e.isDirectory()) dirs.push(path.join(data, 'segbuf', e.name));
  } catch (_) { /* 無ければ飛ばす */ }
  if (ENGINE_HOME.root) dirs.push(ENGINE_HOME.root, path.join(ENGINE_HOME.root, '.download'));
  try { dirs.push(path.dirname(winStatePath())); } catch (_) { /* 置き場所が決まらなければ飛ばす */ }   // 画面の覚え書き（第1b回 N6）
  try { const appRoot = app.getAppPath(); if (typeof appRoot === 'string' && appRoot) dirs.push(appRoot); } catch (_) { /* noop */ }   // 自動更新の package.json
  let n = 0;
  for (const d of dirs) { try { n += J.cleanTemps(d).length; } catch (_) { /* noop */ } }
  if (n) engineLog(`保存: 前回残った一時ファイルを ${n} 個消しました`);
}
const errCode = (e) => (e && e.code) || 'error';

// → { state, settings, notices }（state は loadJsonFile の結果の state。notices は画面に出す知らせの文で、起動のときは
// startupNotices へ、読み直しのときはすぐ画面へ）。記録は engine.log へ。投げない。settingsState もここで決める
// （読めなければ 'unreadable'、ほかは 'ok'。直した設定の書き戻しは 'ok' にしてから）。起動のときと、読めなかった後の
// 読み直し（retrySettingsRead）の両方から呼ぶ
function loadSettingsFromDisk() {
  const file = settingsPath();
  const r = J.loadJsonFile(file, { shape: isSettingsShape, maxBytes: J.SMALL_MAX });
  settingsState = r.state === 'unreadable' ? 'unreadable' : 'ok';
  const notices = [];
  const notify = (m) => notices.push(m);
  // pillFrom（0.9.0 O-1・RP2）: 前の版の録音バーの位置の読み（settings.js の readSettings）。読めた設定だけ（壊れた・読めないときは null）
  const res = (v, pillFrom = null) => ({ state: r.state, settings: v, notices, pillFrom });
  if (r.state === 'missing') return res(readSettings({}, DEFAULT_SETTINGS).settings);
  if (r.state === 'ok') {
    // 読めない間に待っていた変更は捨てる（読めた値が勝つ）
    settingsWriter.discard();
    const rs = readSettings(r.value, DEFAULT_SETTINGS);
    if (rs.repaired.length || rs.falseLike.length) {
      // キーの並びは SETTING_KEYS の順（readSettings がその順に返す）。値は書かない
      engineLog(`設定: 一部を既定に戻しました（${rs.repaired.map((x) => `${x.key}: ${x.why}`).join('、')}）`);
      // 元の設定を写しで残してから書き戻す。写せなければ書き戻さない（元のファイルがそのまま元の設定）
      const c = J.quarantine(file, { copy: true });
      let kept = path.basename(file);
      if (c.ok) {
        kept = path.basename(c.to);
        const w = settingsWriter.now(rs.settings);
        if (!w.ok) engineLog(`設定: 直した設定を書き戻せませんでした（${errCode(w.error)}）`);
      } else {
        engineLog(`設定: 元の設定の写しを残せなかったので、書き戻しません（${c.code}）`);
      }
      const labels = rs.repaired.filter((x) => SETTING_RULES[x.key].kind !== 'bool').map((x) => SETTING_RULES[x.key].label);
      if (labels.length) notify(NOTICE.settingsRepaired(labels.join('・'), kept));
      for (const f of rs.falseLike) notify(NOTICE.settingsFalseLike(SETTING_RULES[f.key].label, f.raw));
    }
    return res(rs.settings, rs.pillFrom);
  }
  if (r.state === 'broken') {
    const name = path.basename(r.movedTo);
    engineLog(`設定: 壊れていたので退けて既定で起動しました（${r.reason}、${name}）`);
    notify(r.reason === 'encoding' ? NOTICE.settingsEncoding(name) : NOTICE.settingsBroken(name));
    return res(readSettings({}, DEFAULT_SETTINGS).settings);
  }
  // 読めない（ほかのプログラムが掴んでいる・退けられない）。読み直せるまで書かない（RF22）
  engineLog(`設定: 読めなかったので既定で動き、読めるまで保存しません（${r.code}）`);
  return res(readSettings({}, DEFAULT_SETTINGS).settings);
}

// 読み直しの予約（いつも1つまで）
let settingsRetryTimer = null;
let settingsRetryIdx = 0;
function scheduleSettingsRetry(ms) {
  if (settingsRetryTimer) clearTimeout(settingsRetryTimer);
  settingsRetryTimer = setTimeout(retrySettingsRead, ms);
}
// 読めなかった設定を読み直す（時計と settings:get から）。読めたら本当の値に切り替え、まだ読めなければ RETRY_READ_MS の
// 次を予約する（使い切ったら止める。設定の画面を開けばまた読み直す）。名前はこのまま（mainrun が時計を捕まえる）
function retrySettingsRead() {
  if (settingsRetryTimer) { clearTimeout(settingsRetryTimer); settingsRetryTimer = null; }
  if (settingsState !== 'unreadable') return;
  // 録音・議事録の最中は切り替えない（エンジンの設定が変わると再起動して、文字起こし中の区間を失う: #57）。
  // 読まずに、終わった後で読み直す
  if (meeting || state === 'recording') { scheduleSettingsRetry(RETRY_READ_MS[RETRY_READ_MS.length - 1]); return; }
  const prev = settings;
  const r = loadSettingsFromDisk();
  const notes = r.notices;
  if (r.state === 'unreadable') {
    if (settingsRetryIdx < RETRY_READ_MS.length) scheduleSettingsRetry(RETRY_READ_MS[settingsRetryIdx++]);
    return;
  }
  if (r.state === 'ok') {
    settings = r.settings;
    migrateOldThreads(settings);
    applyReloadedSettings(prev, settings);
    engineLog('設定: 読めたので、保存してある設定に切り替えました');
    notes.push(NOTICE.settingsReloaded);
  } else {
    // 無くなっていた・壊れていた（退けた）: 読めた値が無いので、今の設定のまま書けるようにする（待っていた変更は次の合図で書く）
    engineLog(`設定: 読み直したら${r.state === 'missing' ? '無くなっていた' : '壊れていた'}ので、今の設定のまま保存します`);
  }
  if (notes.length) noticeMainWin(notes.join('　'));
}

// → 履歴の配列。投げない
function loadHistoryFromDisk() {
  const r = J.loadJsonFile(historyPath(), { shape: Array.isArray });
  if (r.state === 'ok') return r.value;
  if (r.state === 'broken') {
    const name = path.basename(r.movedTo);
    engineLog(`履歴: 壊れていたので退けて空の履歴で始めました（${r.reason}、${name}）`);
    startupNotices.push(NOTICE.historyBroken(name));
    return [];
  }
  // 読めない: 読み直せるまで書かずに持っておく（RF22・N14）
  if (r.state === 'unreadable') {
    historyState = 'unreadable';
    engineLog(`履歴: 読めなかったので、読めるまで新しい履歴を保存せずに持っておきます（${r.code}）`);
    startupNotices.push(NOTICE.historyBusy);
  }
  return [];
}

// 読めなかった履歴を読み直す。読めたら、読めない間の履歴（新しい順）とファイルの履歴を id で合わせ、maxHistory で
// 切って書く。まだ読めなければ RETRY_READ_MS の次を予約する（使い切ったら止める）。名前はこのまま（mainrun が捕まえる）
let historyRetryTimer = null;
let historyRetryIdx = 0;
function retryHistoryRead() {
  if (historyRetryTimer) { clearTimeout(historyRetryTimer); historyRetryTimer = null; }
  if (historyState !== 'unreadable') return;
  const r = J.loadJsonFile(historyPath(), { shape: Array.isArray });
  if (r.state === 'unreadable') {
    if (historyRetryIdx < RETRY_READ_MS.length) historyRetryTimer = setTimeout(retryHistoryRead, RETRY_READ_MS[historyRetryIdx++]);
    return;
  }
  historyState = 'ok';
  const fromFile = r.state === 'ok' ? r.value : [];
  if (r.state === 'broken') {
    const name = path.basename(r.movedTo);
    engineLog(`履歴: 読み直したら壊れていたので退けました（${r.reason}、${name}）`);
    noticeMainWin(NOTICE.historyBroken(name));
  }
  const merged = lib.mergeHistory(history, fromFile, settings.maxHistory);
  history = merged.list;
  historyWriter.discard();
  engineLog('履歴: 読めたので、ファイルの履歴と合わせました');
  if (merged.changed) saveHistoryOrNotice();
  sendToMainWin('history:updated', history);
}

// 履歴の削除・全消しの保存。書けなければ知らせる（N10）
function saveHistoryOrNotice() {
  const w = historyWriter.now(history);
  // 読めない間（N14 で「保存せずに持っておく」と知らせ済み）は知らせを重ねない
  if (!w.ok && !(w.error && w.error.code === 'NOT_WRITABLE')) noticeMainWin(NOTICE.historyNotSaved);
}

// 古い既定のスレッド数の移し替えは、今どおりメモリの中だけ（直しに数えない。知らせも写しも書き戻しも無い）。
// 起動のときと、読めなかった設定を読み直して切り替えたとき（retrySettingsRead）に通す
function migrateOldThreads(s) {
  if (CPU_DEFAULT_THREADS > CPU_OLD_DEFAULT_THREADS) {
    if (s.localThreads === CPU_OLD_DEFAULT_THREADS) s.localThreads = CPU_DEFAULT_THREADS;
  }
}

function loadStores() {
  // 保存時と同じ決まり（settings.js の readSettings）を通す。手で編集された settings.json のポートが文字列や
  // 範囲外だと、起動直後だけ正規化をすり抜けてエンジンの起動待ちが静かに失敗する。
  const ls = loadSettingsFromDisk();
  settings = ls.settings;
  pillFromAtLoad = ls.pillFrom;
  startupNotices.push(...ls.notices);
  if (settingsState === 'unreadable') {
    startupNotices.push(NOTICE.settingsBusy);
    settingsRetryTimer = setTimeout(retrySettingsRead, RETRY_READ_MS[0]);
    settingsRetryIdx = 1;
  }
  migrateOldThreads(settings);
  history = loadHistoryFromDisk();
  if (historyState === 'unreadable') {
    historyRetryTimer = setTimeout(retryHistoryRead, RETRY_READ_MS[0]);
    historyRetryIdx = 1;
  }
  // 保存先は <userData>/data だけ。開けない（容量・権限など）と store.initDrafts は投げる。ここは
  // app.whenReady の中なので、投げると単一起動の鍵を持ったまま窓が出ず、次に起動しても何も
  // 起きない。だから受け止めて理由を持ち、画面が出てから知らせる（黙って続けると、議事録が
  // 保存されないまま録音できてしまう）
  // 第2a1回 M-2b: store は下書きだけを扱う（initDrafts。元の pages/・transcripts/・index.json に触れない: P11）。議事録は DB のプロセス
  // 退けた知らせの受け手は initDrafts より前に付ける（壊れた下書きを退けたら知らせる）
  store.setReporter(onStoreReport);
  try { store.initDrafts(app.getPath('userData')); } catch (e) { storeError = e.message; engineLog(`データフォルダを開けません: ${e.message}`); }
  // 議事録の DB のプロセスを起こす（第2a1回 ST2）。開けなければ子が「使えない」と答え、知らせ D1（onDbEvent）
  DB_INIT.dataDir = path.join(app.getPath('userData'), 'data');
  DB_INIT.network = isNetworkPath(DB_INIT.dataDir);
  db.start();
}
// いまのデータフォルダの絶対パス（「データ保存先を開く」）
const dataRoot = () => store.root();

// ---------------------------------------------------------------- テキスト整形
function removeFillersRule(text) {
  let t = text;
  const patterns = [
    /(?:えー+っ?と+|えっ?と+|ええと+|ええっと+)[、,。.\s]*/g,
    /(?:えー+|えぇ+ー*)[、,\s]*/g,
    /(?:あのー+|あのう+|そのー+|そのう+)[、,\s]*/g,
    /(?:うー+ん(?:と+)?|んー+と?)[、,\s]*/g,
    /\b(?:u+m+|u+h+|erm+|hm+)\b[,\s]*/gi,
  ];
  for (const p of patterns) t = t.replace(p, '');
  return t.replace(/、{2,}/g, '、').replace(/。{2,}/g, '。')
    .replace(/(^|。)、+/g, '$1').replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// 業務日本語でよく化ける語。固有名詞ではないのでユーザーに登録させる筋ではなく、
// 既定で渡す。実機で「不具合→風買い」「改修→回収」「今週→本週」が出たことによる。
// 数詞の聞き違い（12件→22件）には効かない。効くのはマイクとモデルの大きさ。
const BUILTIN_TERMS = [
  '不具合', '改修', '受注', '発注', '仕様', '要件', '結合テスト', '単体テスト', '検収', 'リリース',
  '課題', '懸案', '進捗', '稼働', '納期', '見積', '工数', '案件', '所感',
  '今週', '来週', '今月', '来月', '月末', '期末',
  '定例', '共有', '対応', '確認', '検討', '展開', '棚卸し',
];

// whisper.cpp の初期プロンプトは n_text_ctx/2（既定 224 トークン）で切られる。
// どちら側から切られるかはビルドで変わりうるので、そもそも溢れさせない。
// 日本語は最悪 1文字 1トークンとみて 200 文字。予算の単位は UTF-8 のバイト数でその 3 倍
// （日本語 1 文字 = 3 バイト。英数字の語を文字数で数えると実際の 3 倍に見積もられ、辞書が
// 不当に切られる。詳しくは mainlib.buildPromptParts）。
const PROMPT_MAX_CHARS = 200;
const PROMPT_LIMIT_BYTES = PROMPT_MAX_CHARS * 3;
// 文例。指示文ではなく「この後に続く文章の文例」。モデルは指示に従うのでは
// なく真似るだけで、実機では文例中の語がそのまま本文へ漏れた
// （「不具合の報告」が「句読報告」になった）。丸めの誘導は文例自体の
// 「、」「。」で行い、漏れても会議の発言として無害な語だけで書く。
// 語の接頭辞も付けない。「用語:」のような不自然な語も文例として漏れうる。
const PROMPT_SAMPLE = 'お疲れさまです。よろしくお願いします。';

// 優先順は 文例 → 辞書（先頭行から）→ 既定語彙 → 直前の発言の尻尾。予算を超えたら
// 後ろから落とす（判断は mainlib.buildPromptParts）。既定語彙は日本語のときだけ
// （英語や自動判定で日本語の語を渡すと、その語が出力に漏れ、言語の推定も日本語へ引っぱられる）。
// 戻り値の kept/total は prompt:info で画面へ返す（辞書が予算を超えていると伝えるため。#23）。
function promptParts(extraTail) {
  const ja = settings.language === 'ja';
  return buildPromptParts({
    ja, sample: PROMPT_SAMPLE,
    dictionary: settings.dictionary,
    useBuiltinTerms: settings.useBuiltinTerms, builtinTerms: BUILTIN_TERMS,
    tail: extraTail, limitBytes: PROMPT_LIMIT_BYTES,
  });
}
function buildPrompt(extraTail) { return promptParts(extraTail).prompt; }
// 0.9.1 Q-2（計画 docs/plans/2026-10-21-091.md の決めたこと 2）: 認識ヒントの材料（作り話の判定 mainlib.hintEcho に渡す）。promptParts と同じ設定から作る
// （予算で切った後でなく全部の語。切られた語を作り話として除いても、語1つだけの答えは議事録の中身にならない）
function hintOf(extraTail) {
  const ja = settings.language === 'ja';
  const words = Array.isArray(settings.dictionary) ? settings.dictionary : [];
  return { sample: ja ? PROMPT_SAMPLE : '', terms: [...words, ...(ja && settings.useBuiltinTerms !== false ? BUILTIN_TERMS : [])], tail: String(extraTail || '') };
}

// ---------------------------------------------------------------- エンジン管理
function makeEngine(name) {
  // lastUsed: 起動時と推論のたびの時刻。使われないまま engineIdleMin 分たったら止める（#58）
  return { name, proc: null, ready: false, lastError: '', readyPromise: null, startPromise: null, sig: '', stderrTail: '', stopping: false, lastUsed: 0 };
}
const whisperEng = makeEngine('文字起こしエンジン');
// 要約のエンジン（llama）は 0.10.0 LS-3（D59）で外した。要約は利用者の Claude Code（summarizeWithClaude）
// 取り込んだエンジン（第0b回 設計 B）。詳細設定の実行ファイルとモデルが両方空の側だけが使う。設定には書かない（RF7）。
// 取り込み先は %LOCALAPPDATA%\natsu\engine（Windows の x64 だけ。それ以外の PC では supported が偽で、今までどおり）
const ENGINE_HOME = engineInstall.engineRoot(process.env, process.platform, process.arch);
// 組は文字起こし（whisper）だけ（0.10.0 LS-3 で要約の組を外した）
let managed = { whisper: null };            // この起動の中で照らし終えた組だけ（RF3）。暇なときだけ入れ替える（Task 14）
let managedCands = { whisper: null };       // 記録から見た候補（まだ照らしていない）
let managedState = { whisper: 'none' };     // 'none' | 'checking' | 'ok' | 'broken'
let managedTried = { whisper: null };       // 照らし終えた候補の印（mainlib.candStamp）。合わなかった組を、変わるまで照らし直さない（Task 14）
let engineFetch = null;                                // 取り込みの係（初めて使うときに getEngineFetch が作る）
const touchEngine = (eng) => { eng.lastUsed = Date.now(); };
// 起動・終了・停止のたびにトレイ（「エンジンを停止」の有効／無効）を追随させる。終了中は触らない
function engineChanged() { if (!quitting) updateTray(); }

function engineLog(line) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'engine.log'),
      `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch (_) { /* noop */ }
}

function resolveVadModel() {
  if (settings.vadModelPath && fs.existsSync(settings.vadModelPath)) return settings.vadModelPath;
  try {
    const dir = path.dirname(engineModel(whisperEng) || '');
    if (!dir || !fs.existsSync(dir)) return '';
    const hits = fs.readdirSync(dir).filter((f) => /^ggml-silero-.*\.bin$/i.test(f)).sort().reverse();
    return hits.length ? path.join(dir, hits[0]) : '';
  } catch (_) { return ''; }
}

// エンジンは文字起こし（whisper）だけ（0.10.0 LS-3・D59 で要約の llama を外した）。eng を受ける形は今のまま
function engineSpawnArgs(eng) {
  const args = [
    '-m', engineModel(eng),
    '--host', '127.0.0.1',
    '--port', String(settings.localPort),
    '-t', String(settings.localThreads),
    '-l', settings.language === 'auto' ? 'auto' : settings.language,
  ];
  if (settings.suppressNst) args.push('-sns');
  const vad = settings.useVad ? resolveVadModel() : '';
  if (vad) args.push('--vad', '--vad-model', vad);
  return args;
}
// 詳細設定の実行ファイルとモデルが両方空なら、取り込んだエンジン（第0b回）。片方でも入っていれば今までどおり手の設定。
// 取り込んだ側は、照らし終えた組（managed）が無ければパスは空
const manualGroup = (_e) => Boolean(settings.localServerExe || settings.localModelPath);
const managedFile = (_e, k) => { const g = managed.whisper; return (g && g[k]) || ''; };
const engineExe = (e) => (manualGroup(e) ? settings.localServerExe : managedFile(e, 'exe'));
const engineModel = (e) => (manualGroup(e) ? settings.localModelPath : managedFile(e, 'model'));
const enginePort = (_e) => settings.localPort;
const engineConfigured = (e) => Boolean(engineExe(e) && engineModel(e));
// 実行ファイルとモデルは「あるか」だけでなく中身まで見る（#32。判断は mainlib.engineFileIssue）。
// 存在だけを見ると、OneDrive のプレースホルダ（大きさはあるが実体がこの PC に無い）や
// 途中で切れたダウンロードを「ある」と誤認し、起動して落ちるまで原因が分からない。
// 下限はどの配布物でも下回らない大きさ（exe は数 MB、whisper は tiny でも 75MB）。
// 床を置くのはモデルだけ。実行ファイルの大きさでは壊れているか判断しない——上流の配布構成は
// 変わる（前の要約のエンジンは exe を 9,216 バイトの薄いランチャにし、中身を DLL へ移した。床を置くと、その正常な exe を
// 「壊れている」と断じて製品を使えなくした: 実機で起きた）。本当の判定は起動して /health が応えるかどうかで、
// ここの検査は「より良い文を出すためのおまけ」に過ぎない。誤検知の害の方が桁違いに大きい。
const ENGINE_MIN_BYTES = { whisper: 50_000_000 };
const fileSize = (f) => { try { return fs.statSync(f).size; } catch (_) { return 0; } };
// 問題があれば利用者向けの一文、無ければ ''
function engineCheck(eng) {
  // 取り込んだ側は、確かめ中・壊れた・ランタイムで止める・まだ無い を先に伝える（第0b回 RF3・RF4）
  if (!manualGroup(eng) && ENGINE_HOME.supported) { const m = managedIssue(eng); if (m) return m; }
  if (!engineConfigured(eng)) return `${eng.name}の実行ファイルまたはモデルが見つかりません`;
  const stat = (f) => fs.statSync(f);
  // 実行し直すスクリプトを名指しする（名指ししないと利用者はどれか分からない）
  const ps = 'setup-local-engine.ps1';
  const exe = engineFileIssue(engineExe(eng), 0, stat);   // 大きさの床は置かない（0 バイトとプレースホルダだけ見る）
  if (exe !== 'ok') return `${eng.name}の${engineIssueMessage(exe, 'exe', fileSize(engineExe(eng)), engineExe(eng), ps)}`;
  const model = engineFileIssue(engineModel(eng), ENGINE_MIN_BYTES.whisper, stat);
  if (model !== 'ok') return `${eng.name}の${engineIssueMessage(model, 'model', fileSize(engineModel(eng)), engineModel(eng), ps)}`;
  // whisper は英数字以外のパスを読めずに落ちる（RF1）。相対にしても日本語が残るなら起動しない。
  // engine:status と起動テストにも同じ理由が出る（startEngine は先にここを見る）
  const plan = engineSpawnPlan(engineExe(eng), engineSpawnArgs(eng), { whisper: true });
  if (plan.problem) return plan.problem;
  return '';
}
// アプリのインストール先（NaTsu.exe のあるフォルダ）。開発中は Electron の実行ファイルの
// 場所になるが、その下にエンジンを置く人は居ないので誤検知しない
const appInstallDir = () => path.dirname(process.execPath);
// エンジンがインストール先の中にあれば移動を促す一文（更新のたびに消えうる。mainlib.engineDirWarning）
const engineDirNote = (eng) => engineDirWarning([engineExe(eng), engineModel(eng)], appInstallDir());
const engineValid = (e) => !engineCheck(e);
// 未設定なのか、設定はあるが中身に問題があるのかを分けて伝える
// 取り込める PC で手の設定が無い側は［PC の中の文字起こしを取り込む］（第1d回 A-13・D19 で前の［エンジンを取り込む］から名前を変えた）へ案内する。
// どちらの文も「未設定」の語を残す
// （画面はこの語で設定タブへ連れて行く）。取り込んだ組を確かめている間・壊れていたときは、その文（engineCheck の頭）
function whisperProblem() {
  const fetchable = ENGINE_HOME.supported && !manualGroup(whisperEng);
  if (fetchable && (managedState.whisper === 'checking' || managedState.whisper === 'broken')) return engineCheck(whisperEng);
  if (!engineConfigured(whisperEng)) {
    // 取り込みが動いているときは、そのことと、文字起こしの組のあと何分か（速さが分かれば）を添える（第0b回 Task 14）
    if (fetchable && engineFetchRunning()) {
      const min = fetchMinutesLeft(engineFetch.status(), 'whisper');
      return `文字起こしエンジンが未設定です（取り込み中${min ? `・あと約 ${min} 分` : ''}）。取り込みが済むと使えるようになります。`;
    }
    return fetchable ? '文字起こしエンジンが未設定です。設定タブの［PC の中の文字起こしを取り込む］から取り込んでください。'
      : '文字起こしエンジンが未設定です。設定タブでパスを指定してください。';
  }
  return engineCheck(whisperEng);
}
// 取り込んだ側の、使えない理由（無ければ ''）。engineCheck の頭で見る（engine:status と起動テストにも同じ文が出る）
function managedIssue(eng) {
  const g = 'whisper';
  if (managedState[g] === 'checking') return `${eng.name}を確かめています（数秒で終わります）`;
  if (managedState[g] === 'broken') {
    return `${eng.name}のファイルが消えたか変わっています。ウイルス対策が消した可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。取り直しています`;
  }
  // 取り込んだ組だけ、Visual C++ ランタイムが無い・古いなら起動しない（RF4。手で設定した組は記録だけ: Task 10）
  if (managed[g]) return runtimeGate(engineRuntimeIssue(eng), { managed: true }) === 'block' ? engineRuntimeIssue(eng).message : '';
  return `${eng.name}はまだ取り込んでいません。設定タブの［PC の中の文字起こしを取り込む］を押してください`;
}

// Visual C++ ランタイムの版（RF4。判断は mainlib.vcRuntimeIssue）。Windows のときだけ、exe のフォルダを先に、
// 無ければ System32 の DLL を読む。Electron は 64 ビットなので System32 はそのまま読める（WOW64 の付け替えは無い）。
// exe のパスごとに1回だけ読んで覚える（DLL は数百 KB。先頭の 4MB だけ読む）。
// ここでは止めない。止めるのは取り込んだ組だけで、Task 13 の managedIssue が runtimeGate で決める。
const RUNTIME_OK = Object.freeze({ level: 'ok', min: '', message: '', versions: {} });
const runtimeIssueCache = new Map();
// 版の行を書いた exe のパス（ok でも最初の1回は書く。startEngine）
const runtimeLogged = new Set();
const system32Dir = () => path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
function readFileHead(file, max = 4 * 1048576) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(Math.min(max, fs.fstatSync(fd).size));
    return buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, 0));
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch (_) { /* noop */ }
  }
}
function engineRuntimeIssue(eng) {
  if (process.platform !== 'win32') return RUNTIME_OK;
  const key = `whisper|${engineExe(eng)}`;
  if (!runtimeIssueCache.has(key)) {
    runtimeIssueCache.set(key, vcRuntimeIssue(vcRuntimeVersions(path.dirname(engineExe(eng)), system32Dir(), readFileHead), { whisper: true }));
  }
  return runtimeIssueCache.get(key);
}
// 覚えた版を忘れる。［起動テスト］（app:test）の最初に呼ぶ。担当がランタイムを入れた後、
// INSTALL の「入れてもらってから、もう一度お試しください」のとおり、NaTsu を起動し直さずに押せば読み直す（RF4）。
// engine:status・記録の開始・エンジンの起動は、今までどおり覚えた版を使う（そのたびに DLL を読まない）
function forgetRuntimeIssues() {
  runtimeIssueCache.clear();
}
// 取り込む組のランタイム。取り込む前の欄にも出す（数 GB を落としてから知らせない。RF4・Task 15）。
// whisper の置き場所 → System32 の順に読む（whisper は vcomp140 も要る）。覚え方は engineRuntimeIssue と同じ。
// Windows 以外・取り込めない PC は null
function managedRuntimeIssue() {
  if (process.platform !== 'win32' || !ENGINE_HOME.supported) return null;
  const exe = engineInstall.layout(ENGINE_HOME.root, MANIFEST).whisper.exe;
  const key = `whisper|${exe}`;
  if (!runtimeIssueCache.has(key)) runtimeIssueCache.set(key, vcRuntimeIssue(vcRuntimeVersions(path.dirname(exe), system32Dir(), readFileHead), { whisper: true }));
  return runtimeIssueCache.get(key);
}

function engineSignature(eng) {
  return [engineExe(eng), engineModel(eng), enginePort(eng), settings.localThreads, settings.language,
    `${settings.useVad ? resolveVadModel() : ''}|${settings.suppressNst}`].join('|');
}

// 127.0.0.1:port を一瞬だけ listen して空きを見る（#28/#31）。EADDRINUSE だけを「使用中」
// とし、それ以外（権限など）はエンジン自身の起動に任せる。直前に止めた自分のエンジンが
// まだ手放していないことがあるので、短い間隔で数回まで見直してから「使用中」と決める。
function portInUse(port, tries = 5) {
  const probe = () => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (e) => resolve(Boolean(e && e.code === 'EADDRINUSE')));
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => resolve(false)));
  });
  return (async () => {
    for (let i = 0; i < tries; i++) {
      if (!(await probe())) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return true;
  })();
}

// 起動は非同期（ポートの空きを見てから spawn する）。戻り値の Promise は spawn まで
// （準備完了までではない。それは ensureEngineReady）。同時に二度呼ばれても spawn は
// 一度だけ（startPromise で束ねる）。
function startEngine(eng) {
  if (eng.proc) return Promise.resolve();
  if (eng.startPromise) return eng.startPromise;
  eng.startPromise = (async () => {
    // 0.9.4 S-2: 時間切れで止めた前のプロセスが終わる（ポートを離す）のを待つ
    if (eng.exitWait) { const w = eng.exitWait; eng.exitWait = null; await w; }
    const issue = engineCheck(eng);
    if (issue) { eng.lastError = issue; return; }
    // ランタイムの版を記録するだけ（RF4）。手で入れたエンジンは今動いているので止めない。無い・古いときは起動のたびに、
    // ok でも exe のパスごとに最初の1回は書く（版を読めたことを engine.log で確かめられるように。実機の 13）。
    // Windows 以外は読まないので書かない
    const runtime = engineRuntimeIssue(eng);
    if (runtime !== RUNTIME_OK && (runtime.level !== 'ok' || !runtimeLogged.has(engineExe(eng)))) {
      runtimeLogged.add(engineExe(eng));
      engineLog(`${eng.name}: Visual C++ ランタイム ${runtime.level}（${Object.entries(runtime.versions || {}).map(([d, v]) => `${d} ${v || 'なし'}`).join('、')}）`);
    }
    eng.lastError = ''; eng.ready = false; eng.stopping = false; eng.stderrTail = '';
    // 塞がっているポートで spawn すると、エンジンはモデルを読み終えてから bind に失敗して
    // 落ちる。それまで「起動中」に見え、/health は塞いでいる別のプロセスに当たって
    // 「準備完了」と誤認することさえある。先に見て、塞がっていれば起動しない。
    const port = enginePort(eng);
    if (await portInUse(port)) {
      eng.lastError = portInUseError(port); engineLog(`${eng.name}: ${eng.lastError}`); return;
    }
    // 待っている間に終了が始まっていたら起動しない（孤児プロセスになる）
    if (quitting) return;
    if (eng.proc) return;
    eng.sig = engineSignature(eng);
    // cwd = exe のフォルダ。英数字以外のモデルのパスはそこからの相対で渡す（RF1）。
    // ggml が cwd の ggml-*.dll を読むので、別のエンジンのフォルダで起動しない（RF11）
    const plan = engineSpawnPlan(engineExe(eng), engineSpawnArgs(eng), { whisper: eng === whisperEng });
    engineLog(`${eng.name} 起動: ${engineExe(eng)} ${plan.args.join(' ')}（作業フォルダ: ${plan.cwd}）`);
    // 実行を止められたとき（EPERM・UNKNOWN）は spawn が投げ、消えている（ENOENT）・EACCES は 'error' で来る。
    // どちらにも、何をすればよいかの案内を足す（RF3。mainlib.spawnErrorHint）
    const spawnFailed = (e) => {
      const hint = spawnErrorHint(e && e.code, engineExe(eng));
      return `${eng.name}を起動できません: ${e.message}${hint ? `。${hint}` : ''}`;
    };
    const startedAt = Date.now();
    let p;
    try {
      p = spawn(engineExe(eng), plan.args, { cwd: plan.cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      eng.lastError = spawnFailed(e); engineLog(eng.lastError); return;
    }
    eng.proc = p;
    eng.lastUsed = Date.now();
    engineChanged();
    // 以下のハンドラは「自分が起動したプロセス」のときだけ状態を触る（#57）。
    // 再起動のあとに古いプロセスの exit が届き、新しいプロセスを null にしていた。
    p.stderr.on('data', (d) => {
      if (eng.proc !== p) return;
      eng.stderrTail = (eng.stderrTail + d.toString()).slice(-1500);
    });
    p.on('error', (e) => {
      if (eng.proc !== p) return;
      eng.lastError = spawnFailed(e); engineLog(eng.lastError);
      eng.proc = null; eng.ready = false;
    });
    p.on('exit', (code) => {
      if (eng.proc !== p) return;
      if (!quitting && !eng.stopping) {
        const tail = eng.stderrTail.split('\n').filter(Boolean).slice(-3).join(' / ');
        // 0xC0000135（ランタイムかファイルが無い）などは、何をすればよいかの案内を足す（RF3・RF4）
        const hint = engineExitHint(code, Date.now() - startedAt);
        eng.lastError = `${eng.name}が終了しました (code ${code})${tail ? `: ${tail}` : ''}${hint ? `。${hint}` : ''}`.trim();
        engineLog(eng.lastError);
        // 取り込んだエンジンが 0xC0000135（3221225781。DLL が見つからない）で落ちた: ウイルス対策が消したかもしれない。
        // 自分のファイルを照らし直す（RF3。第0b回 Task 14）。合えばランタイムの案内（上の hint）のまま
        if ((code >>> 0) === 3221225781 && !manualGroup(eng)) onManagedCrash(eng).catch((e) => engineLog(`${eng.name}: 落ちた後の照らし直しに失敗: ${e && e.message}`));
      }
      eng.proc = null; eng.ready = false; eng.readyPromise = null;
      engineChanged();
    });
  })().finally(() => { eng.startPromise = null; });
  return eng.startPromise;
}

function stopEngine(eng) {
  if (eng.proc) { eng.stopping = true; try { eng.proc.kill(); } catch (_) { /* noop */ } eng.proc = null; }
  eng.ready = false; eng.readyPromise = null;
  engineChanged();
}

// 使われないエンジンを止める（#58）。60 秒ごとに呼ぶ。判断は mainlib.idleEnginesToStop
// （手が空いていて、起動していて、engineIdleMin 分使われていない。0 = 止めない）。
// 次に使うときは ensureEngineReady が起動し直す
const ENGINE_IDLE_CHECK_MS = 60000;
function releaseIdleEngines() {
  // 記録や要約の後まで待たせた切り替えと、エンジンが止まった後の前の版の片付けも、ここで拾う（第0b回 Task 14。どちらも投げない）
  applyManagedWhenIdle(); cleanupManaged();
  for (const eng of idleEnginesToStop([whisperEng], Date.now(), settings.engineIdleMin, isBusy())) {
    engineLog(`${eng.name}: ${settings.engineIdleMin} 分使われていないため停止（メモリを解放）`);
    stopEngine(eng);
  }
}
// トレイの「エンジンを停止（メモリを解放）」。次に使うときは起動し直す
function stopEnginesFromTray() {
  if (isBusy()) return;
  engineLog('トレイからエンジンを停止（メモリを解放）');
  stopEngine(whisperEng);
}

function ensureEngineReady(eng) {
  if (eng.ready && eng.proc) return Promise.resolve(true);
  if (eng.readyPromise) return eng.readyPromise;
  const self = (async () => {
    if (!eng.proc) await startEngine(eng);
    let p = eng.proc;
    if (!p) return false;
    // 「/」は見ない。エンジンはモデル読み込み中でも「/」に 200 を
    // 返すことがあり、準備完了と誤認して直後の推論が 503 になる（実機で発生）。
    // /health は読み込み中 503・完了で 200 を返す。エンドポイントを持たない
    // 古いビルドは 404 を返すので、その場合だけ「応答した」ことで良しとする。
    const url = `http://127.0.0.1:${enginePort(eng)}/health`;
    const deadline = Date.now() + ENGINE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // 待っている間に再起動されていたら、新しいプロセスを待ち直す（#57）
      if (eng.proc !== p) { if (!eng.proc) return false; p = eng.proc; }
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
        // 応答を待つ間に再起動されていたら、その応答は古い（または他の）プロセスのもの
        if (eng.proc !== p) continue;
        if (res.ok || res.status === 404) { eng.ready = true; return true; }
      } catch (e) {
        // 接続先の URL 自体が組み立てられない（ポートが不正）なら、90秒待っても
        // 直らない。「起動中」と区別して設定の問題だと分かる文で返す。
        // 接続拒否も TypeError（fetch failed）で来るので、URL の解析失敗だけを見る。
        if (e instanceof TypeError && /URL/i.test(e.message)) {
          eng.lastError = `${eng.name}の接続先（ポート設定）が不正です`;
          engineLog(`${eng.lastError}: ${url}`);
          return false;
        }
        /* 起動中 */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!eng.lastError) {
      const tail = eng.stderrTail.split('\n').filter(Boolean).slice(-3).join(' / ');
      eng.lastError = `${eng.name}の起動がタイムアウトしました${tail ? `: ${tail}` : '（モデル読み込み中の可能性）'}`;
    }
    return false;
  })().finally(() => { if (eng.readyPromise === self) eng.readyPromise = null; });   // 再起動後の新しい待ちを消さない
  eng.readyPromise = self;
  return self;
}

function restartEnginesIfNeeded() {
  for (const eng of [whisperEng]) {
    if (eng.proc && eng.sig !== engineSignature(eng)) stopEngine(eng);
  }
  if (!whisperEng.proc && engineValid(whisperEng)) warmWhisper().catch((e) => engineLog(`文字起こしエンジンの先読みに失敗: ${logReason(e)}`));
}

// ---------------------------------------------------------------- 取り込んだエンジン（第0b回 設計 B・RF3）
// 取り込んだ exe と DLL を、この起動の中で SHA-256 で照らし終えてから使う（RF3。whisper 約 11.9MB）
async function verifyManagedAtStartup() {
  let v;
  try {
    v = await engineInstall.verifyCandidates(managedCands);
    managedTried = managedStamps(managedCands);   // 合わなかった組は、取り直されるか触られるまで照らし直さない（Task 14）
  } catch (e) {
    // 照らせなかった組は使わない（「確かめています」のまま残さない）
    engineLog(`取り込んだエンジンの照らしに失敗: ${e && e.message}`);
    v = { whisper: null, bad: [] };
  }
  managed = { whisper: v.whisper };
  for (const g of MANAGED_GROUPS) managedState[g] = !managedCands[g] ? 'none' : v[g] ? 'ok' : 'broken';
  if (v.bad.length) engineLog(`取り込んだエンジンの照らし: 合わない ${v.bad.map((b) => `${b.file}（${b.why}）`).join('、')}`);
  restartEnginesIfNeeded();
  // 起動のときの復旧の文字起こしは、照らし終わる前に「確かめています」で保留になる。使えるようになった今もう一度試す
  if (recoveryQueue && managed.whisper && !manualGroup(whisperEng)) transcribeRecovered().catch((e) => engineLog(`復旧の文字起こしに失敗: ${logReason(e)}`));
  onManagedVerified(v);   // 壊れていた組の案内と取り直し（Task 14）
  // 画面へ今の写しを送る。起動のときに「確かめています」を聞いた画面は、確かめ終えた（checking が偽の）この知らせで
  // エンジンの状態を聞き直す（送らないと「要確認」が残る。両方の組が使えるなら whisperReady は前から真で、変わり目が無い）
  try { sendToMainWin('engine:fetch-progress', await engineFetchStatus()); } catch (e) { engineLog(`取り込みの欄の写しを送れません: ${e && e.message}`); }
}
// 起動のときの照らしの続き（第0b回 Task 14）: 壊れていた組を知らせ、同意済みなら合わなかった項目を取り直す（RF3）
function onManagedVerified(v) {
  repairManaged(managedCands, v);
}

// 画面に「使える」と見せる組: main が切り替えた候補（managedCands）から、照らしで合わなかった組を外したもの（RF3）。
// 確かめている間は候補のまま（起動のたびに欄がちらつかない）。取り込みの係の記録（installed.json）だけでは決めない
//（係が組を置き終えても、main が照らして切り替えるまでは使っていない。画面はこれが真になったときエンジンの状態を聞き直す）。
// engine:fetch-status と、係の進み具合の知らせ（fetchView）が同じこの決まりを使う
const usableCand = (g) => (managedState[g] === 'broken' ? null : managedCands[g]);
// 取り込んだ側の組を、起動のときに照らしている途中か（画面は、これが偽に変わった知らせでエンジンの状態を聞き直す。Task 15）
const managedChecking = () => MANAGED_GROUPS.some((g) => managedState[g] === 'checking' && !manualGroup(engOf(g)));

// 取り込みの欄の写し（設定タブの画面が読む。Task 15）。読むだけ: 通信もフォルダ作りもしない
// 照らしで合わなかった組は候補から外す（using・whisperReady で「使える」と見せず、画面が取り込みの欄を隠さない。RF3）
async function engineFetchStatus() {
  const installed = engineInstall.readInstalled(engineInstall.layout(ENGINE_HOME.root, MANIFEST).installed);
  const plan = engineInstall.planInstall(MANIFEST, installed, fs.statSync, ENGINE_HOME.root);
  const checking = managedChecking();
  const s = engineInstall.statusOf({ home: ENGINE_HOME, manifest: MANIFEST, plan, candidates: { whisper: usableCand('whisper') }, runner: engineFetch && engineFetch.status(),
    manual: { whisper: manualGroup(whisperEng) }, freeBytes: await engineInstall.freeBytesOf(ENGINE_HOME.root),
    runtime: managedRuntimeIssue(), installed });
  return { ...s, checking };
}

// ---------------------------------------------------------------- 取り込みの係と切り替え（第0b回 Task 14・RF3・RF8・RF13）
const ENGINE_FETCH_AUTO_MS = 10000;   // 起動から、取り込みの続きを自動で始めるまで（窓とエンジンの起動を先に済ませる）
const MANAGED_GROUPS = ['whisper'];   // 取り込む組（0.10.0 LS-3 で要約の組を外した）
const MANAGED_NAMES = { whisper: '文字起こしエンジン' };
const engOf = (_g) => whisperEng;
const managedStamps = (cands) => ({ whisper: candStamp(cands.whisper, fs.statSync) });

// 取り込みの係。初めて使うときに作る（Electron の net.request は app の ready の後でしか使えない）。
// 通信は net.request（会社のプロキシ・PAC・証明書のストアを使う。RF2）。待ちは係の既定の本物の時計。
// 記録中（meeting）は係が止めて待つ（Web 会議の回線を守る）。組がそろうたびに、照らしてから暇なときに切り替える
function getEngineFetch() {
  if (engineFetch) return engineFetch;
  const r = engineInstall.makeRunner({ home: ENGINE_HOME, manifest: MANIFEST, request: (o) => electronNet.request(o),
    isOnline: () => electronNet.isOnline(), log: engineLog,
    onProgress: (s) => sendToMainWin('engine:fetch-progress', fetchView(s)), onState: onEngineFetchState,
    onGroupReady: () => { applyManagedWhenIdle(); },
    hold: () => Boolean(meeting), isManual: (g) => manualGroup(engOf(g)),
    userAgent: `NaTsu/${app.getVersion()}` });
  // 画面へ返す写し（start・pause の戻り）も、進み具合の知らせと同じ見え方にする
  engineFetch = { ...r, start: (o) => fetchView(r.start(o)), pause: (why) => fetchView(r.pause(why)) };
  return engineFetch;
}
// 取り込みが動いているか（待っている・記録中で止めている間も含む）。忙しさ（isBusy）には数えない
// （数えると、取り込みの間エンジンを止められなくなる）。未設定の文が見る
function engineFetchRunning() { return Boolean(engineFetch && engineFetch.running()); }
// 取り込みのボタンを押したか（installed.json の consent。第1d2回 M-1）。起動で1回読み、取り込みの係の状態の知らせ（onEngineFetchState）で
// 真にする（区間ごとにファイルを読まない）
let offlineConsent = false;
// オフラインの準備を選んだか（第1d2回 M-1・D21。判断は mainlib.offlineChosen）。選んだ人はエンジンの誤りの扱いを 0.8.0 のまま残す（RF49）
function isOfflineChosen() {
  return offlineChosen({ manual: manualGroup(whisperEng), managedCand: Boolean(managedCands.whisper), consent: offlineConsent, fetching: engineFetchRunning() });
}
// 実際に取っているか（係の state が running）。省電力の抑止が見る（待っている・止めている間は眠らせてよい。Q14）
function engineFetchDownloading() { return Boolean(engineFetch && engineFetch.downloading()); }

// 係の写しに、main だけが知っていることを入れる（engine:fetch-status と同じ見え方）: 使える組（using・whisperReady）は
// 係の記録ではなく main が切り替えた組で決め（usableCand。照らしで合わなかった組は「使える」と見せない: RF3）、
// 確かめている途中か（checking）と、取り込む組の Visual C++ ランタイムの案内を入れる（係は Electron もランタイムも知らない。RF4）
function fetchView(s) {
  if (!s || !Array.isArray(s.items)) return s;
  const c = { whisper: usableCand('whisper') };
  const usingOf = (x) => (x ? (x.current ? 'current' : 'previous') : null);   // statusOf の using と同じ形
  const rt = managedRuntimeIssue();
  return { ...s, using: { whisper: usingOf(c.whisper) }, whisperReady: Boolean(c.whisper),
    checking: managedChecking(), runtime: rt ? { level: rt.level, message: rt.message } : null };
}

// 係の状態が変わったとき。実際に取っている間だけ眠らせない（Q14）。起動のときの自動の開始が大きな新しい版を取らなかったら、起動の中で1回だけ知らせる
let updateNoticeSent = false;
function onEngineFetchState(s) {
  updatePowerBlock();
  // 取り込みのボタンを押したことが同意（係が installed.json に consent を書いてから、状態が替わったこの写しで知らせる）。第1d2回 M-1: 選んだ人になる
  if (s && s.consent === true) offlineConsent = true;
  if (!updateNoticeSent && s && s.state === 'update' && s.updateBytes > 100e6) {
    updateNoticeSent = true;
    noticeMainWin(`新しい版のエンジン（約 ${(s.updateBytes / 1e9).toFixed(1)} GB）があります。設定タブの［新しい版を取り込む］から取り込めます。今のエンジンはそのまま使えます。`);
  }
}

// 画面への知らせ。起動直後で画面がまだ読み込み中なら、読み終えてから送る（受け手が居ないと消える）
function noticeMainWin(msg) {
  if (mainWin && !mainWin.isDestroyed() && mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', () => sendToMainWin('app:notice', msg));
  else sendToMainWin('app:notice', msg);
}

// 照らしで合わなかった組（cands にあって checked に無い組。手で設定した組は使わないので除く）を知らせ、同意済みなら
// 合わなかった項目を取り直す（RF3。同じ起動の中で2回目は係が defender で止める）→ 取り直しを頼んだ項目の id
function repairManaged(cands, checked) {
  const groups = MANAGED_GROUPS.filter((g) => cands && cands[g] && !(checked && checked[g]) && !manualGroup(engOf(g)));
  if (!groups.length || !ENGINE_HOME.supported) return [];
  const repair = repairIdsOf(MANIFEST, cands, checked && checked.bad, groups);
  const consent = engineInstall.readInstalled(engineInstall.layout(ENGINE_HOME.root, MANIFEST).installed).consent === true;
  const go = consent && repair.length > 0;
  noticeMainWin(`${groups.map((g) => MANAGED_NAMES[g]).join('と')}のファイルが消えたか変わっていました。ウイルス対策が消した可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。`
    + (go ? '取り直しています。' : '設定タブの［PC の中の文字起こしを取り込む］から取り込み直してください。'));
  if (!go) return [];
  engineLog(`取り込んだエンジンの取り直しを頼みます: ${repair.join('、')}`);
  getEngineFetch().start({ repair });
  return repair;
}

// 片付け（cleanupOld）で消さないパス: 照らし終えた組と、記録から見た候補のフォルダ・ファイル（RF8）
function usedByManaged(p) {
  return pathUsedBy(p, [managed.whisper, managedCands.whisper]);
}
// 前の版の片付け（RF8）。エンジンが止まっていて、起動の途中でもなく、暇なときだけ消す（Windows は動いている exe・DLL と、
// メモリに写したモデルを消せない）。動いていれば何もせず、次の機会（60 秒ごとの releaseIdleEngines）に回す。投げない
function cleanupManaged() {
  if (!ENGINE_HOME.supported) return;
  const installed = engineInstall.readInstalled(engineInstall.layout(ENGINE_HOME.root, MANIFEST).installed);
  engineInstall.cleanupOld(ENGINE_HOME, MANIFEST, installed, { inUse: (p) => usedByManaged(p), canDelete: () => !whisperEng.proc && !whisperEng.startPromise && !isBusy() })
    .then((r) => { if (r.removed.length) engineLog(`取り込んだエンジンの前の版を片付けました: ${r.removed.join('、')}`); })
    .catch((e) => engineLog(`取り込んだエンジンの前の版を片付けられませんでした: ${e && e.message}`));
}

let managedApplying = false;   // 切り替えの照らしの途中（同時に 2 つ照らさない）
let managedAgain = false;      // 照らしている間にまた呼ばれた（組がそろうのが続いた）。終わってから、もう一度見る
// 取り込んだエンジンへの切り替えは、新しい組を照らし終え、手が空いていて記録中でないときだけ（#57 と同じ理由。区間を失わない）。
// 新しい組が照らしで合わなければ、照らし済みの前の組を使い続け（RF13。mainlib.keepPrevious）、合わなかった項目を取り直す（RF3）。
// 投げない（組がそろったときと、60 秒ごとの見回りから、待たずに呼ぶ）。起動のときの照らしの途中は、その結果を待つ（次の見回りで拾う）
async function applyManagedWhenIdle() {
  if (!ENGINE_HOME.supported || MANAGED_GROUPS.some((g) => managedState[g] === 'checking')) return false;
  if (managedApplying) { managedAgain = true; return false; }
  if (isBusy() || meeting) return false;
  managedApplying = true;
  try {
    const cands = engineInstall.managedCandidates(ENGINE_HOME, MANIFEST, engineInstall.readInstalled(engineInstall.layout(ENGINE_HOME.root, MANIFEST).installed), fs.statSync);
    if (sameShas(cands, managed)) return false;                       // 安い比べ（SHA-256 の並び）。同じなら何もしない
    // 照らして合わなかった組（壊れた組・前の組を使い続けている組）は、取り直されるか触られる（大きさか更新時刻が変わる）
    // まで照らし直さない（60 秒ごとに数十 MB を読まない・同じ知らせを繰り返さない）
    const stamps = managedStamps(cands);
    if (MANAGED_GROUPS.every((g) => sameShas(cands, managed, [g]) || stamps[g] === managedTried[g])) return false;
    const checked = await engineInstall.verifyCandidates(cands);      // 照らす（数十 MB。待つ間に記録が始まりうる）
    if (isBusy() || meeting) return false;                            // 照らしている間に忙しくなったら替えない（次の機会に）
    managedTried = stamps;
    const v = keepPrevious(cands, managed, checked);
    const gotWhisper = !managed.whisper && v.whisper;
    managedCands = { whisper: v.kept.includes('whisper') ? v.whisper : cands.whisper };
    managed = { whisper: v.whisper };
    for (const g of MANAGED_GROUPS) managedState[g] = managed[g] ? 'ok' : managedCands[g] ? 'broken' : 'none';
    if (checked.bad.length) engineLog(`取り込んだエンジンの照らし（切り替え）: 合わない ${checked.bad.map((b) => `${b.file}（${b.why}）`).join('、')}${v.kept.length ? `。前の組を使い続けます（${v.kept.join('・')}）` : ''}`);
    try {
      for (const g of MANAGED_GROUPS) if (v[g] && v[g].current) engineInstall.setActive(ENGINE_HOME, MANIFEST, g);
    } catch (e) { engineLog(`使っている組を installed.json に書けませんでした: ${e && (e.code || e.message)}`); }
    restartEnginesIfNeeded();
    updateTray();
    if (gotWhisper && !manualGroup(whisperEng)) {
      sendToMainWin('app:notice', '文字起こしが使えるようになりました。');
      // 前にエンジンが無くて残した文字起こし待ちの音声を、今のエンジンで片付ける
      if (recoveryQueue) transcribeRecovered().catch((e) => engineLog(`復旧の文字起こしに失敗: ${logReason(e)}`));
    }
    repairManaged(cands, checked);
    sendToMainWin('engine:fetch-progress', await engineFetchStatus());
    cleanupManaged();
    return true;
  } catch (e) {
    engineLog(`取り込んだエンジンへの切り替えに失敗: ${e && e.message}`);
    return false;
  } finally {
    managedApplying = false;
    if (managedAgain) { managedAgain = false; setImmediate(() => { applyManagedWhenIdle(); }); }
  }
}

// 取り込んだエンジンが 0xC0000135 で落ちた（RF3）: その組を照らし直す。合わなければ使うのをやめ（managed から外し、壊れた組に
// する）、合わなかった項目を取り直す（同じ起動の中で2回目は係が defender で止める）。合えば Visual C++ ランタイムの案内のまま
async function onManagedCrash(eng) {
  const g = 'whisper';
  const c = managed[g];
  if (!c) return;
  const checked = await engineInstall.verifyCandidates({ [g]: c });
  if (checked[g]) { engineLog(`${eng.name}: 落ちた後に取り込んだファイルを照らし直しました（合っています。Visual C++ ランタイムを確かめてください）`); return; }
  if (managed[g] !== c) return;   // 照らしている間に切り替わった
  managed = { ...managed, [g]: null };
  managedCands = { ...managedCands, [g]: c };
  managedState[g] = 'broken';
  managedTried = { ...managedTried, [g]: candStamp(c, fs.statSync) };   // 取り直されるまで、60 秒ごとの見回りで照らし直さない
  engineLog(`${eng.name}: 落ちた後の照らし直し: 合わない ${checked.bad.map((b) => `${b.file}（${b.why}）`).join('、')}`);
  updateTray();
  repairManaged({ [g]: c }, checked);
  sendToMainWin('engine:fetch-progress', await engineFetchStatus());
}

// ---------------------------------------------------------------- 文字起こし
// 議事録の区間で「認識ヒントを渡すと空、渡さないと文字が取れた」が続けて PROMPT_OFF_AFTER 回起きたら、
// 同じエンジン・同じヒントの間はヒントを渡さない。毎回 2 回送ると、遅い PC では文字起こしが録音に
// 追いつかなくなる。1 回では決めない（雑音の区間で、ヒントなしの方だけが作り話を返すことがある）。
// ヒント付きで文字が取れたら数え直す。音声入力と復旧の文字起こしでは数えない（短い 1 回で決めない）。
// エンジンの設定かヒントの中身（辞書・業務の言葉・言語）が変われば、もう一度ヒント付きで試す。
// 覚えるのはアプリが動いている間だけ
const PROMPT_OFF_AFTER = 2;
let promptOffSig = '';
let promptEmptyStreak = { sig: '', n: 0 };
const promptSig = () => [engineSignature(whisperEng), JSON.stringify(settings.dictionary || []),
  settings.useBuiltinTerms !== false, settings.language].join('|');
const promptOff = () => promptOffSig !== '' && promptOffSig === promptSig();
// kotoba-whisper（日本語の distil-large-v3。デコーダが 2 層）には認識ヒントを渡さない。
// 測った結果（whisper.cpp 1.9.5・-sns・VAD・4 スレッド、TV の会話を 65〜70 秒にまとめた 4 区間）:
// ヒントあり CER 67%（文の 54% が抜けた）、ヒントなし 57%。長いヒントでは話し声にも空を返す（0.1.0 の「0 区間」）。
// kotoba は 5 秒前後の短い音声で学習されていて、ヒント付きの学習例は少ない。large-v3-turbo は
// ヒントの有無で変わらない（どちらも 20%）ので、そちらには今までどおり渡す
const isKotobaModel = () => /kotoba/i.test(path.basename(engineModel(whisperEng) || ''));
// 設定のエンジン欄に出す、モデルの勧め。kotoba は同じ区間で large-v3-turbo の 3 倍ほど誤り、速さはほぼ同じ
// コマンドは文末に札を付けて置く（文の途中に置くと、後ろの語までひと続きのコマンドと読まれる。engineIssueMessage と同じ）。
// 前の版の setup-local-engine.ps1 は既定が kotoba なので、-Model を必ず付けて示す
const KOTOBA_NOTE = '文字起こしのモデルが kotoba-whisper です。75 秒ずつの文字起こしでは文の抜け落ちが多いため、'
  + 'large-v3-turbo に替えることをおすすめします。setup-local-engine.ps1 を置いたフォルダ（local-engine フォルダの一つ上）で'
  + ' PowerShell を開いて下のコマンドを実行し、表示されたモデルのパスを［詳細設定］の「文字起こし」にある'
  + '「モデルファイル（ggml-*.bin）のパス」に貼り付けてください（欄を離れると保存されます）。'
  + '実行するコマンド: powershell -ExecutionPolicy Bypass -File .\\setup-local-engine.ps1 -Model large-v3-turbo-q5';
// ヒントなしでのやり直しを省く音の小ささ。VAD が無いと、ほぼ無音の音声をヒントなしで送り直したとき、
// 作り話（「ご視聴ありがとうございました」など）が返りうる。話し声はふつう -40 dBFS より大きい
const RETRY_MIN_DBFS = -50;
// 区間の要求が返事の前に接続ごと切れた（使い回しの接続が閉じていたなど）ときの符号。手元のエンジンは動いているので、
// 同じ要求をもう 1 回だけ送る（CI run 39183232615: 起動テストが通った直後の区間が「fetch failed」で失敗した）。
// 拒まれた（ECONNREFUSED: エンジンが落ちている）・時間切れ・取り消し・HTTP の誤りは送り直さない
const droppedCode = (e) => {
  if (!e || e.name === 'AbortError' || e.name === 'TimeoutError') return '';
  const code = (e.cause && e.cause.code) || e.code || '';
  return /^(UND_ERR_SOCKET|ECONNRESET|EPIPE)$/.test(code) ? code : '';
};
// 手元の文字起こしの区間が失敗したときの記録の符号（第1d回 A-14・あとの直し (c)。Windows の CI の揺れの手がかり）。
// ECONNREFUSED・ECONNRESET・UND_ERR_SOCKET などの英大文字と _ だけを書き、ほか（文・数の符号・無し）は「なし」。文の本文・URL・ポートは書かない
const localFailCode = (e) => {
  const code = (e && e.cause && e.cause.code) || (e && e.code);
  return typeof code === 'string' && /^[A-Z_]{2,40}$/.test(code) ? code : 'なし';
};
// 試験だけ: PC への要求の待ち時間を縮める（数で 0〜1 のときだけ効き、ほかは 1。STT_SLEEP_SCALE と同じ形。実機の確かめの環境には置かない）
const LOCAL_TIME_SCALE = (() => {
  const raw = String(process.env.NATSU_TEST_LOCAL_TIME_SCALE || '').trim();
  const v = /^\d*\.?\d+$/.test(raw) ? Number(raw) : NaN;
  return v > 0 && v <= 1 ? v : 1;
})();
// ---- この PC の文字起こしの速さの覚え（0.9.4。計画の決めたこと 10。<userData>/data/local-pace.json。モデルごと）
// モデルはファイルの名前と大きさで見分ける（パスは覚えに書かない）。読めない・形の違う覚えは無いのと同じ
const pacePath = () => path.join(app.getPath('userData'), 'data', 'local-pace.json');
function paceModel() {
  const f = engineModel(whisperEng);
  if (!f) return null;
  try { return { name: path.basename(f), size: fs.statSync(f).size }; } catch (_) { return null; }
}
const isPaceShape = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v) && v.schema === 1 && v.model && typeof v.model === 'object');
function readLocalPace() {
  try {
    const r = J.loadJsonFile(pacePath(), { shape: isPaceShape, maxBytes: J.SMALL_MAX, keep: 3 });
    return r.state === 'ok' ? r.value : null;
  } catch (_) { return null; }
}
// 今のモデルの覚えの rtf（無ければ null。待ち時間は 1 として数える）
function pacedRtf() {
  const saved = readLocalPace();
  const model = paceModel();
  if (!saved || !model || !saved.model || saved.model.name !== model.name || saved.model.size !== model.size) return null;
  return Number.isFinite(saved.rtf) ? saved.rtf : null;
}
// 0.9.4 S-4（決めたこと 9・10・12）: 会議ごとの遅い PC の判断（mainlib.paceStep）。遅いになったときに記録を1行（数と符号だけ）
function paceRtfText(rtf) { return (Number.isFinite(rtf) ? rtf : 0).toFixed(2); }
function paceEvent(m, ev) {
  if (!m || !m.pace) return;
  const was = m.pace.slow;
  const r = lib.paceStep(m.pace, ev);
  m.pace = r.st;
  if (!was && r.slow) {
    engineLog(`文字起こしの速さ: この PC は録音に追いつかないため、会議中は音声を残します（${paceRtfText(r.st.rtf)} 倍・理由 ${r.why}）`);
    sendToMainWin('meeting:update', meetingStatus());
  }
}
// 会議の始め: 覚えが同じモデルで遅い・14 日の内なら始めから遅い
function paceStart(m) {
  const saved = readLocalPace();
  m.pace = lib.paceStep(undefined, { kind: 'start', saved, model: paceModel(), now: Date.now() }).st;
  if (m.pace.slow) engineLog(`文字起こしの速さ: この PC は録音に追いつかないため、会議中は音声を残します（${paceRtfText(saved && saved.rtf)} 倍・理由 saved）`);
}
// 会議の終わり: 覚えを書く（mainlib.paceSaved。書かない会議もある）。書けなくても投げない
function paceSave(m) {
  try {
    const saved = lib.paceSaved(m.pace, readLocalPace(), { model: paceModel(), now: Date.now(), from: 'live' });
    if (saved) J.writeJsonFile(pacePath(), saved, { onFsyncUnsupported: noteFsyncOnce });
  } catch (e) { engineLog(`文字起こしの速さ: 覚えを書けませんでした（${errCode(e)}）`); }
}
// 0.9.4 S-2（決めたこと 16）: 時間切れの後は whisper-server を止める（切った要求はサーバーの中で走り続け、次の区間がその後ろで待つ）。
// 次に使うとき ensureEngineReady が起こし直す（前のプロセスが終わってポートを離すのを待ってから: startEngine の exitWait）。
// 記録は区間の番号・秒・符号だけ
function restartWhisperAfterLate(seg, sec, planMs) {
  const id = typeof seg === 'string' && /^s\d+$/.test(seg) ? seg : '音声入力';
  engineLog(`手元の文字起こしの時間切れ: ${id}（音声 ${sec} 秒・待ち ${Math.round(planMs / 1000)} 秒）。エンジンを起こし直します`);
  const p = whisperEng.proc;
  stopEngine(whisperEng);
  if (p) {
    whisperEng.exitWait = new Promise((resolve) => {
      if (p.exitCode !== null && p.exitCode !== undefined) { resolve(); return; }
      const t = setTimeout(resolve, 5000);
      try { p.once('exit', () => { clearTimeout(t); resolve(); }); } catch (_) { clearTimeout(t); resolve(); }
    });
  }
}

// opts.isStale: やり直しの前に聞く。true なら（議事録の破棄・打ち切りの後）送り直さない。
// opts.learn: 議事録の区間のとき true。ヒントを止めるかの数え（promptEmptyStreak）に入れる
// 0.12.0 SP-3a（決めたこと 126）: PC のエンジンは1つずつしか処理しないので、2つの流れの会議の区間は1つの門を通して順に送る
// （門で待った時間は待ち時間に数えない: 待ち時間は門を通ってから決める）
let localGateTail = Promise.resolve();
function viaLocalGate(fn) {
  const run = localGateTail.then(fn, fn);
  localGateTail = run.catch(() => {});
  return run;
}
async function transcribeLocal(wavBuffer, extraPromptTail, durationMs, opts = {}) {
  const ok = await ensureEngineReady(whisperEng);
  if (!ok) throw new Error(whisperEng.lastError || '文字起こしエンジンが起動していません');
  // 処理時間は音声の長さにほぼ比例する。固定240秒だと、長くなった区間や
  // 長い音声入力が時間切れで丸ごと失われる（実機で9分の区間が消えた）。下のやり直しも含めてこの時間の内。
  // 0.9.4 S-2（決めたこと 16）: 待ち時間は音声の長さと、この PC のこのモデルで測った速さ（覚えの rtf）で決める（mainlib.localTimeoutMs）。
  // 時間切れになった区間の音声は残し（kept）、エンジンを起こし直す（restartWhisperAfterLate）
  const planMs = localTimeoutMs({ audioMs: Number(durationMs) || 0, rtf: pacedRtf() });
  const waitMs = Math.max(1, Math.round(planMs * LOCAL_TIME_SCALE));
  const deadline = Date.now() + waitMs;
  // ヒントを止めるかは、ヒントを組んだときの設定で決める（送っている間に辞書が変わっても、新しい辞書は試してから）
  const sig = promptSig();
  const prompt = (isKotobaModel() || promptOff()) ? '' : buildPrompt(extraPromptTail);
  // 認識ヒント（初期プロンプト）付きで空なら、ヒントなしでもう一度だけ送る。
  // kotoba-whisper は長いヒントを渡すと、話し声があっても {"text":""} を返すことがある
  // （既定の言葉を全部載せた 376 バイトで再現。実機で全区間が消えて「0 区間」になった。0.1.1）
  const tries = prompt ? [prompt, ''] : [''];
  const sec = Math.round((durationMs || 0) / 1000);
  let text = '';
  let retried = false;
  let resent = false;   // 接続が切れて送り直したか（区間につき 1 回まで）
  // 0.9.4 S-4（決めたこと 7）: 速さの処理の時間は PC への要求の時間だけ（送ってから答えを読み終えるまで。ヒントなしのやり直しは合計）。
  // 中継に断られた時間・エンジンの起動・待ち行列の待ちは入れない。試験は待ち時間と同じ尺度で割って数える
  let procMs = 0;
  for (let i = 0; i < tries.length; i++) {
    const p = tries[i];
    if (i > 0) {
      if (opts.isStale && opts.isStale()) break;
      if (deadline - Date.now() < 10000) break;   // 1 回目で時間をほぼ使い切った
      const vadOn = Boolean(settings.useVad && resolveVadModel());
      const level = vadOn ? 0 : wavLevelDbfs(wavBuffer);
      if (level < RETRY_MIN_DBFS) {
        engineLog(`文字起こし: 認識ヒント付きでは空。音がほとんど無いため（${level === -Infinity ? '無音' : `${Math.round(level)} dBFS`}）、ヒントなしでのやり直しは省きました（音声 ${sec} 秒）`);
        break;
      }
      retried = true;
    }
    // 本文は送ると使い切るので、接続が切れて送り直すときは組み直す
    const makeForm = () => {
      const form = new FormData();
      form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
      // 0.12.0 SP-3b（決めたこと 128）: 2つの流れの会議の区間は、文ごとの時刻（segments）も返してもらう（文ごとの行に分ける: partsOf）
      form.append('response_format', opts.verbose ? 'verbose_json' : 'json');
      // 0.12.0 SP-3b（R25）: verbose_json の言語の確率は頼まない。whisper-server 1.9.5 は VAD で声が1つも無い音声で、その計算（言語の自動判定）の
      // 答えの -2 を言語の名前に引いて落ちる（CI run 40171656089 の engine-smoke）。確率は使わず、計算もエンコーダを1回余分に回すだけ
      if (opts.verbose) form.append('no_language_probabilities', 'true');
      form.append('temperature', '0.0');
      // 前の要求の続きとして文字起こしさせない。1.7.6・1.8.0 などの whisper-server は既定で前の要求の
      // ヒントと文を次の要求に持ち越す（別の議事録や音声入力にまで漏れ、上の「ヒントなし」の
      // やり直しにも前のヒントが残る）。1.9.5 は常にこの扱いで、この欄は読まれない
      form.append('no_context', 'true');
      if (settings.language && settings.language !== 'auto') form.append('language', settings.language);
      if (p) {
        form.append('prompt', p);
        // これが無いと語彙のヒントが各リクエストの最初の30秒にしか効かない。
        // 1区間は75秒あるので、2/3が素の状態で書き起こされていた。
        // 古いビルドでは黙って無視されるだけで害は無い。
        form.append('carry_initial_prompt', 'true');
      }
      return form;
    };
    touchEngine(whisperEng);
    let res;
    for (;;) {
      try {
        const sent = Date.now();
        try {
          res = await localhttp.postInference({ port: settings.localPort, form: makeForm(), timeoutMs: Math.max(1, deadline - Date.now()) });
        } finally { procMs += Date.now() - sent; }
        break;
      } catch (e) {
        // 区間の失敗の文になる（議事録・音声入力・復旧）。英語の "fetch failed" をそのまま見せない
        const code = droppedCode(e);
        // 0.9.4 S-2（決めたこと 16）: 時間切れの要求は whisper-server の中で走り続け、次の区間がその後ろで待つ。エンジンを止め、次に使うときに起こし直す
        if (lib.localFailKind(e) === 'late') restartWhisperAfterLate(opts.seg, sec, planMs);
        // 失敗の符号を cause に持たせる（engine.log の「手元の文字起こしの失敗」の行が読む: 第1d回 A-14。文は 0.9.4 S-2 の localErrorText）
        if (!code || resent) throw new Error(localErrorText(e, { resent }), { cause: (e && e.cause) || e });
        resent = true;
        // 記録の頭は「文字起こし:」にしない（認識ヒントのやり直しの行だけが使う。transcribe.e2e.test.js がその頭で見る）
        engineLog(`文字起こしの接続: エンジンとの接続が切れたため、同じ区間をもう一度送りました（${code}・音声 ${sec} 秒）`);
      }
    }
    touchEngine(whisperEng);
    if (!(res.status >= 200 && res.status <= 299)) {
      let detail = '';
      try { detail = JSON.parse(res.body)?.error || ''; } catch (_) { /* noop */ }
      throw new Error(`文字起こしエンジンエラー (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    const data = JSON.parse(res.body);
    // 古い whisper-server（1.7.6・1.8.0）は WAV を読めないとき 200 のまま {"error": …} を返す。
    // 空の文として扱うと区間ごと黙って消えるので、失敗として残す（後で文字起こしし直せる）
    if (data?.error) throw new Error(`文字起こしエンジンエラー: ${data.error}`);
    text = cleanWhisperText(data?.text);
    if (opts.verbose && typeof opts.onSentences === 'function') opts.onSentences(Array.isArray(data?.segments) ? data.segments : null);
    if (text || !p) break;
  }
  // 空になった理由を後から追えるように残す（以前は何も書かず、engine.log からは何も分からなかった）
  if (retried) {
    engineLog(`文字起こし: 認識ヒント（${Buffer.byteLength(prompt, 'utf8')} バイト）付きでは空 → ヒントなしで${text ? ` ${text.length} 文字` : 'も空'}（音声 ${sec} 秒）`);
  }
  if (typeof opts.onTimed === 'function') opts.onTimed(Math.round(procMs / LOCAL_TIME_SCALE));
  if (prompt && opts.learn && text) {
    if (!retried) promptEmptyStreak = { sig, n: 0 };   // ヒント付きで取れた
    else {
      promptEmptyStreak = { sig, n: promptEmptyStreak.sig === sig ? promptEmptyStreak.n + 1 : 1 };
      if (promptEmptyStreak.n >= PROMPT_OFF_AFTER && promptOffSig !== sig) {
        promptOffSig = sig;
        engineLog('文字起こし: 以後、エンジンと認識ヒントの設定が変わるまで、認識ヒントを渡しません');
      }
    }
  }
  return text;
}

// ---------------------------------------------------------------- オンラインの文字起こし（第1c回 OL1・OL2・OL4・OL6。第1d回 RL11）
// 議事録の区間・音声入力・復旧の3か所は transcribeAuto を通す。経路は区間ごとに decideStt で決める
// （会議の印 → ログイン → しばらく手元の印（hold）→ 中継に届くか。PC の中だけの会議・ログインしていない・hold の間は、
// 届くかの確かめ（中継の /health）も出さない: RF28・RL11）。
// 第1d回 A-3（RL11・RF35）: 文字起こしは中継（relay/。会社の鍵は中継にだけある）へ送る。PC から OpenAI へ直に送る道は無い。
// 中継の失敗は、OpenAI の短い 429 を待ちきれなかったとき（rate・rate-long: RF29 のまま区間の失敗として WAV を残す）のほかは全部、
// その区間を手元でやり直す（録音と文字起こしは中継に頼らない: stt-cloud.redoLocally）。ログイン切れ（401 login）は札を消し、
// 1日の上限（daily-cap）は日の替わりまで、会社の鍵の誤り・残高なし（upstream-auth・quota）は 10 分の間、中継に送らない（hold）。
// 知らせは L1〜L10（計画「画面と知らせの文」）を会議ごとに1回（会議の外は起動ごとに1回）。
// 記録には経路・符号・秒数・区間の番号だけを書く（本文・札・メールは書かない）。
// 記録の行の頭は「文字起こしの経路:」（「文字起こし:」は手元の認識ヒントのやり直しの行だけが使う。transcribe.e2e.test.js がその頭で見る）
// 中継への届くかの確かめ（/health）は、ほかの中継への要求と同じ partition で送る（第1d回 A-11 の relayRequest）。要約の経路の確かめは今のまま
const online = makeOnline({ request: (o) => (String(o && o.url).startsWith(`${relay.RELAY_BASE}/`) ? relayRequest(o) : electronNet.request(o)),
  isOnline: () => electronNet.isOnline() });
// 鍵と札の保管。whenReady の後に作る（safeStorage の非同期の形は ready の後で用意される）
let secrets = null;
// 試験だけ: 429 の待ちを縮める（数で 0〜1 のときだけ効き、ほかは 1。実機の確かめの環境には置かない）
const STT_SLEEP_SCALE = (() => {
  const raw = String(process.env.NATSU_TEST_STT_SLEEP_SCALE || '').trim();
  const v = /^\d*\.?\d+$/.test(raw) ? Number(raw) : NaN;
  return v >= 0 && v <= 1 ? v : 1;
})();
// 知らせ（L1〜L10。計画「画面と知らせの文」）。{ホスト} は中継のホストの名前だけ（札・URL の道は入れない）。
// L3（ログイン切れ）だけは { text, action: 'account' }（画面は［ログインし直す］のボタンを付ける）
const STT_NOTICE = {
  // 0.10.0 LS-5（D62・決めたこと 112。0.9.4 から渡された一覧）: オフラインモードは守秘のボタンでない（要約は Claude Code）。ネットワークの向きで書く
  cloud: () => 'この会議の音声は OpenAI に送られます（文字起こしのため）。ネットワークが不安定なときは、議事録の画面の［オフラインモード］を押すと、この会議の文字起こしを PC の中で行います。',
  'signed-out': () => 'ログインしていないため、この PC で文字起こししています（精度が落ちます）。設定の「アカウント」でログインしてください。',
  login: () => ({ text: 'ログインが切れたため、この PC で文字起こししています（精度が落ちます）。設定の「アカウント」でもう一度ログインしてください。', action: 'account' }),
  unreachable: () => 'NaTsu のサーバーにつながらないため、この PC で文字起こしを続けますが、精度が落ちます。録音はそのまま続けてください。',
  cert: (p) => `文字起こしの中継につながりません（会社の通信の検査で証明書が差し替えられている可能性があります）。この PC で文字起こしを続けますが、精度が落ちます。続くときは情報システムに ${p.host} への通信の許可を頼んでください。`,
  'daily-cap': () => '今日のクラウドの文字起こしの上限に達したため、今日の残りはこの PC で文字起こしします。精度が落ちます。録音はそのまま続けてください。',
  'relay-off': () => '文字起こしの中継が今は使えません。この PC で文字起こしを続けますが、精度が落ちます。続くときは管理者に知らせてください。',
  // L11（第1d回 A-11）: 中継が 403 denied（会社のドメインでない・止めたメール）
  denied: () => 'このメールアドレスでは文字起こしの中継を使えないため、この PC で文字起こしを続けますが、精度が落ちます。管理者に知らせてください。',
  server: () => '文字起こしの中継が混み合っているか、止まっているため、この区間はこの PC で文字起こししました（精度が落ちます）。録音はそのまま続けてください。',
  wait: (_p, sec) => `OpenAI の利用の上限に近いため、${sec} 秒待ってから送り直しています。録音はそのまま続けてください。`,
  rate: () => 'OpenAI の利用の上限に達しました。文字起こしできなかった区間の音声は残してあり、議事録を閉じた後にもう一度試します。録音はそのまま続けてください。',
};
// 手元にした理由（経路の why か、中継の失敗の符号）→ 知らせの符号。オフライン・会議の印は知らせない（利用者が決めたこと・見て分かること）。
// 中継の失敗のうち表に無いもの（server・too-large・bad-request・bad-reply・知らない符号）は server（L8）
const LOCAL_NOTICE = {
  'signed-out': 'signed-out', login: 'login', cert: 'cert', proxy: 'cert', unreachable: 'unreachable', net: 'unreachable', timeout: 'unreachable',
  quota: 'relay-off', 'upstream-auth': 'relay-off',
};
const noticeFor = (why, scope) => {
  // key-unreadable（しまったログインを今は復号できない。第1d回 A-11・F26）は知らせない（記録1行だけ。次の判断で戻し直す）
  if (why === 'offline' || why === 'local-only' || why === 'key-unreadable') return '';
  if (why === 'daily-cap') return scope === 'all' ? 'relay-off' : 'daily-cap';
  return Object.prototype.hasOwnProperty.call(LOCAL_NOTICE, why) ? LOCAL_NOTICE[why] : 'server';
};
// 録音中のページの帯（第1d回 A-6・D17。計画「画面と知らせの文」の B1〜B10）。画面は文を作らず、この文をそのまま出す。
// d は帯の詳しさ（seg-failed の n・stall と wait の sec）、p は送り先（{ホスト} は中継のホストの名前だけ。札・URL の道は入れない）
const STT_BANNER = {
  'engine-down': () => 'PC の中の文字起こしエンジンが動いていません（音声は残してあります）。［エンジンを確かめる］を押してください。',
  stall: (d) => `文字起こしが止まっているかもしれません（音はあるのに、約 ${d.sec} 秒文字が出ていません）。［もう一度］で、その区間を送り直してください。`,
  login: () => 'ログインが切れたため、この PC で文字起こしを続けていますが、精度が落ちます。［ログインし直す］を押して、もう一度ログインしてください。',
  'seg-failed': (d) => `${d.n} 区間の文字起こしに失敗しました（音声は残してあります）。［もう一度］を押してください。`,
  'relay-off': () => '文字起こしの中継が今は使えないため、この PC で文字起こしを続けていますが、精度が落ちます。続くときは管理者に知らせてください。',
  'daily-cap': () => '今日のクラウドの文字起こしの上限に達したため、今日の残りはこの PC で文字起こしします。精度が落ちます。録音はそのまま続けてください。',
  'relay-blocked': (_d, p) => `文字起こしの中継につながりません（会社の通信の検査で止められている可能性があります）。この PC で文字起こしを続けていますが、精度が落ちます。続くときは情報システムに ${p.host} への通信の許可を頼んでください。`,
  'relay-down': () => 'NaTsu のサーバーにつながりません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。',
  'relay-busy': () => '文字起こしの中継が混み合っているため、この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。',
  wait: (d) => `OpenAI が混み合っているため、${d.sec} 秒待ってから送り直しています。録音はそのまま続けてください。`,
  // 第1d2回 M-2（D21。計画「画面と知らせの文」の B11〜B14）: 準備を選んでいない PC で、区間の音声を残している。Windows の知らせにはしない
  'kept-wait': () => 'PC の中の文字起こしが入っていないので、音声を残しています。オンラインに戻ると文字起こしします。録音はそのまま続けてください。',
  'kept-relay': () => '文字起こしの中継が今は使えないため、音声を残しています。使えるようになると自動で文字起こしします。録音はそのまま続けてください。',
  'kept-login': () => 'ログインしていないため、音声を残しています。［ログイン］を押してログインすると、文字起こしします。',
  'kept-local': () => 'この会議はオフラインモードです。PC の中の文字起こしが入っていないので、音声だけを PC に残しています。［ローカル AI の準備］から取り込むと、文字起こしします。',
  // 0.9.4 S-2（決めたこと 18）: PC の文字起こしが間に合わない（時間切れ）・遅い PC で音声を残している。ボタン無し。Windows の知らせにはしない
  'kept-late': (d) => (d && d.offline
    ? 'オフラインモードです。この PC の文字起こしが録音に追いつかないため、音声を残しています。会議が終わったら PC の中で文字起こしします。'   // 0.9.4 O-1: オフラインモードは外へ送らない約束でなくなる（0.10.0 の持ち主の決定）ので「（外には送りません）」を外した
    : 'この PC の文字起こしが録音に追いつかないため、音声を残しています。会議が終わったら文字起こしします。録音はそのまま続けてください。'),
  // B15（0.9.0 B-2・BN2・D26。利用者の文のまま。ボタン無し）: クラウドで文字起こししていた会議の途中でネットワークから外れた
  'net-offline': () => 'ネットワークにつながっていません。この PC で文字起こしを続けていますが、精度が落ちます。録音はそのまま続けてください。',
};
// 録音中のページが見えないときの Windows の知らせ（第1d回 A-8・D17。計画「画面と知らせの文」の WN1〜WN4）。題は「NaTsu」、本文はこの決まった文だけ
// （文字起こしの文・メール・ホスト・数を入れない）。符号は mainlib.WIN_NOTIFY_CODES と同じ4つ
const WIN_NOTIFY = {
  'engine-down': 'PC の中の文字起こしエンジンが動いていません。録音中のページを開いてください。',
  stall: '文字起こしが止まっているかもしれません。録音中のページを開いてください。',
  login: 'ログインが切れたため、この PC で文字起こししています（精度が落ちます）。録音中のページを開いてください。',
  'seg-failed': '文字起こしに失敗した区間があります（音声は残してあります）。録音中のページを開いてください。',
};
// 帯のボタン（画面が付ける。engine は設定の「文字起こし」、retry は meeting:retry、account は設定の「アカウント」）
// 第1d2回 M-2: signin は［ログイン］（設定の「アカウント」）、offline は［オフラインの準備］（カード「オフライン」の取り込みの欄）
const STT_BANNER_ACTION = { 'engine-down': 'engine', stall: 'retry', login: 'account', 'seg-failed': 'retry', 'kept-login': 'signin', 'kept-local': 'offline' };
// 中継の様子の帯。互いに替わる（新しい様子を立てたら前の様子は消す）。クラウドで答えが来た・オフライン・ログインしていない・
// PC の中だけになったら全部消す（オフラインなどは帯にしない: RF28）
const RELAY_PROBLEMS = ['relay-off', 'daily-cap', 'relay-blocked', 'relay-down', 'relay-busy'];
// 0.9.0 B-2（BN2・決めたこと 34）: ネットワークから外れた帯。中継の帯とは互いに替わるが RELAY_PROBLEMS には入れない（オフラインの区間ごとに
// noteSttRoute が RELAY_PROBLEMS を全部消すので、入れると出した次の区間で消える）。出し消しは自前の 1 秒の見張り（watchOffline）
const NET_PROBLEMS = ['net-offline'];
const OFFLINE_WATCH_MS = 1000;
let offlineWatchId = null;
// 議事録の録音の始めに回す（overlay:tick は 5 秒で、3 秒ずつの行き来を「続けて切れた」と拾い間違える）。録音が終わったら次の回で自分で止まる
function startOfflineWatch() {
  if (offlineWatchId) return;
  offlineWatchId = setInterval(watchOffline, OFFLINE_WATCH_MS);
}
// 出すのは、ログインしていて PC の中だけでない会議（クラウドで文字起こししていた会議）で、手元のエンジンが使えるときだけ
// （「この PC で文字起こしを続けています」が本当のときだけ）。「出ている」は毎回帯の様子から読む（ほかの道で消えたら見張りも知る）。
// Windows の知らせにはしない（WIN_NOTIFY_CODES は変えない）。記録は setSttProblem・clearSttProblem の1行ずつ
function watchOffline(now = Date.now()) {
  const m = meeting;
  if (!m || state !== 'meeting') {
    if (offlineWatchId) clearInterval(offlineWatchId);
    offlineWatchId = null;
    return;
  }
  const online = netOnline();
  const shown = m.problems.has('net-offline');
  // つながっていて出ていなければ、出す・消すは起きない（毎秒エンジンのファイルを stat しない）
  const eligible = (!online || shown) && !m.localOnly && hasRelayLogin() && engineValid(whisperEng);
  const r = lib.offlineBannerStep(m.offlineWatch, { online, now, eligible, shown });
  m.offlineWatch = r.st;
  if (r.act === 'show') {
    clearSttProblem(m, ...RELAY_PROBLEMS);
    setSttProblem(m, 'net-offline');
  } else if (r.act === 'clear') {
    clearSttProblem(m, ...NET_PROBLEMS);
  } else {
    return;
  }
  sendToMainWin('meeting:update', meetingStatus());
}
// 止まりの見張りで残した区間の文（音声は残し、［もう一度］と会議の後の送り直しに載せる）
const STALL_SEG_TEXT = '（音はありましたが、文字になりませんでした）';
// 第1d2回 M-2（D21）: 準備を選んでいない PC で、クラウドで文字起こしできなかった区間の文（音声は残し、戻ったら文字起こしする）
const KEPT_SEG_TEXT = '（文字起こし待ち: 音声は残してあります）';
// 0.9.4 S-2（決めたこと 2・18）: PC の時間切れ（late）・エンジンに届かない（down）区間の文（音声は残し、会議の後と見回りで文字起こしする）
const LATE_SEG_TEXT = '（文字起こし待ち: PC の文字起こしが間に合わなかったので、後で文字起こしします）';
const DOWN_SEG_TEXT = '（文字起こし待ち: PC の文字起こしエンジンにつながらなかったので、後で文字起こしします）';
// 0.9.4 S-4（決めたこと 11・12・18）: 遅い PC の会議で PC に落ちる区間の文と、遅くなったときの知らせ（会議ごとに1回）
const SLOW_SEG_TEXT = '（文字起こし待ち: 会議の後で文字起こしします）';
const SLOW_NOTICE = 'この PC の文字起こしが録音に追いつかないため、会議中は音声を残し、会議が終わってから文字起こしします（クラウドで文字起こしできるときはクラウドで続けます）。';
// その区間の Error の文（会議の区間は KEPT_SEG_TEXT にする。音声入力は M-5 が残す）
const KEPT_ERROR_TEXT = 'クラウドで文字起こしできず、PC の中の文字起こしも準備していないため、文字起こしできませんでした';
// ［この会議は PC の中だけ］を押したが PC の中の文字起こしが使えない（計画の P1。準備を選んでいない PC だけ。ボタン［オフラインの準備］: 第1d2回 M-4）
const LOCAL_SETUP_NOTICE = 'この会議をオフラインモードにしました。PC の中で文字起こしするには、設定の「ローカル AI」の準備（文字起こしのエンジンの取り込み）が要ります。今は音声だけをこの PC に残します。準備が済むと文字起こしします。';
// 会議の中の左下の知らせ（計画「画面と知らせの文」の K1〜K4。準備を選んでいない PC だけ。今の L2〜L8 の代わりに、残し始めたときの1回）
const KEPT_NOTICE = {
  // 0.10.0 LS-5（D62）: 「外に出したくない会議は［オフラインモード］」を外した（守秘のボタンでない）
  k1: '今はクラウドで文字起こしできないため、音声だけを残します。つながると、この会議の音声を OpenAI に送って文字起こしします。',
  k2: 'ログインしていないため、音声だけを残します。設定の「アカウント」でログインすると、この会議の音声を OpenAI に送って文字起こしします。',
  k3: '文字起こしの中継が使えないため、音声を残しています。使えるようになると自動で文字起こしします。録音はそのまま続けてください。',
  k4: 'ログインが切れたため、音声を残しています。設定の「アカウント」でもう一度ログインすると、文字起こしします。',
};
// 知らせを出した印。会議の中は meeting.notified（会議ごとに1回）、会議の外（音声入力・復旧）と L10 は起動ごとに1回
const bootNotified = new Set();
const noticeSeen = (scope) => (scope && scope.notified instanceof Set ? scope.notified : bootNotified);
// 同じ (scope, code) は1回だけ app:notice と engine.log（記録は符号だけ）→ 出したら true
function noticeOnce(scope, code, text) {
  const seen = noticeSeen(scope);
  if (seen.has(code)) return false;
  seen.add(code);
  engineLog(`文字起こしの経路: 知らせ ${code}`);
  noticeMainWin(text);
  return true;
}
const netOnline = () => { try { return electronNet.isOnline() !== false; } catch (_) { return true; } };
// 送り先は中継（第1d回 A-3・RL11）。id は文字起こしをした相手の名前のまま 'openai'（ページの「クラウド（OpenAI）」の行は今と同じ）。
// 前の版が保存した sttProvider・sttBaseUrl・sttModel と、secrets.json に残った OpenAI などの鍵は読まない
function sttProvider() {
  return relay.relayProvider();
}
// ---- Cloudflare Access のログイン（第1d回 A-11。RL10・F20・F21・F22・F26・F27。計画「作り替え」の要約の 1〜3）
// ログインの窓（Cloudflare のログインの画面。英語）で Access が中継の住所に付けた CF_Authorization（と CF_Binding）の cookie を、
// relay.packCookies でまとめて secrets（safeStorage。Windows では DPAPI）の relay の名前にしまい、起動のときにメモリの partition
// （relay.ACCESS_PARTITION。persist: なし = ディスクに cookie を置かない）へ戻す。中継への要求は全部 relayRequest（その partition）で送り、
// cookie は Chromium が付ける（アプリは見出しに札を入れない）。cookie・JWT は画面・記録・知らせ・IPC の答えに出さない。
// ログインしているかは PC の中だけで決める（accessState。外へ通信しない・毎回復号しない）
let accessSes = null;
// ログインの partition の session。初めて作るときに守りを付ける（権限の頼みと確かめは全部断る・ダウンロードは止める）
function accessSession() {
  if (accessSes) return accessSes;
  const ses = session.fromPartition(relay.ACCESS_PARTITION);
  try { ses.setPermissionRequestHandler((_wc, _permission, cb) => { cb(false); }); } catch (_) { /* 付けられなくても続ける */ }
  try { ses.setPermissionCheckHandler(() => false); } catch (_) { /* 同上 */ }
  try { ses.on('will-download', (e) => { e.preventDefault(); }); } catch (_) { /* 同上 */ }
  accessSes = ses;
  return ses;
}
// 中継への要求（文字起こし・/health・/v1/me・ログアウト）。cookie を付けるかは送り手（postForm の useSessionCookies）が決める
const relayRequest = (o) => electronNet.request({ ...o, session: accessSession() });
// しまったログインの今の様子（メモリ）。state: 'restored'（partition に戻した）| 'none' | 'unreadable'（safeStorage が今は使えない。消さない）。
// until は ログインの期限（秒）か null、pack は secrets にしまった文字（ログイン切れの後始末で「送ったときと同じログインか」を比べる）
let accessState = { state: 'none', until: null, pack: '' };
// しまったログインの期限が切れていた・中継の外で切れた印（次の経路の why を 'login' にして L3・B3 を出す。L2 にしない）。ログイン・ログアウトで下ろす
let loginExpired = false;
let accessReady = Promise.resolve();
const nowSec = () => Math.floor(Date.now() / 1000);
const ACCESS_NONE = Object.freeze({ state: 'none', until: null, pack: '' });
// partition の cookie を消す（取れなかったときの後始末）。しまったログインがあれば、それを戻し直す（前のログインを消さない）
async function resetAccessCookies() {
  try { await accessSession().clearStorageData({ storages: ['cookies'] }); } catch (e) { engineLog(`アカウント: ログインの入れ物を空にできません（${errCode(e)}）`); }
  if (accessState.state === 'restored' && accessState.pack) {
    const r = relay.unpackCookies(accessState.pack, nowSec());
    if (r.ok) await putAccessCookies(r.cookies);
  }
}
// cookie を partition に置く（host-only は domain を付けずに url だけ。資料: api/cookies.md）→ 置けた数
async function putAccessCookies(cookies) {
  const ses = accessSession();
  let n = 0;
  for (const c of cookies) {
    const d = { url: `${relay.RELAY_BASE}${c.path}`, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite };
    if (!c.hostOnly) d.domain = c.domain;
    if (c.expirationDate !== undefined) d.expirationDate = c.expirationDate;
    try { await ses.cookies.set(d); n += 1; } catch (e) { engineLog(`アカウント: cookie を戻せません（${errCode(e)}）`); }
  }
  return n;
}
// しまったログインを消す（ログイン切れ・止めたメール・期限切れ・形の違うもの）。secrets・partition・accountEmail・accessState
async function forgetAccessLogin() {
  const removed = secrets ? secrets.remove('relay') : { ok: true };
  accessState = ACCESS_NONE;
  try { await accessSession().clearStorageData({ storages: ['cookies'] }); } catch (_) { /* メモリの中だけ。次の起動で無くなる */ }
  if (settings.accountEmail) setAccountEmail('');
  return removed;
}
// 起動のとき（と、復号できなかった後の次の経路の判断のとき）に、しまったログインを partition へ戻す。投げない
async function restoreAccessCookies() {
  if (!secrets || !secrets.has('relay')) { accessState = ACCESS_NONE; return; }
  const text = await secrets.get('relay');
  if (!text) {
    // 復号できない（safeStorage が一時的に使えない: RF30・F26）。消さない（空の partition で送ると 401 でログイン切れと取り違える）
    if (accessState.state !== 'unreadable') engineLog('アカウント: しまったログインを復号できません（key-unreadable）。消さずに PC の中で文字起こしします');
    accessState = { state: 'unreadable', until: null, pack: '' };
    return;
  }
  const r = relay.unpackCookies(text, nowSec());
  if (!r.ok) {
    await forgetAccessLogin();
    if (r.why === 'expired') {
      loginExpired = true;
      engineLog('アカウント: しまったログインの期限が切れていた');
    } else engineLog(`アカウント: しまったログインの形が違うため消した（${r.why}）`);
    return;
  }
  const n = await putAccessCookies(r.cookies);
  accessState = { state: 'restored', until: r.until, pack: text };
  engineLog(`アカウント: しまったログインを戻した（cookie ${n} 個）`);
}
// ログインしているか（PC の中だけで決める。外へ通信しない・復号しない）
function hasRelayLogin() {
  return accessState.state === 'restored' && (accessState.until === null || accessState.until > nowSec());
}
// ---- ログインの窓（第1d回 A-11。RL10・F20・F27）
// 設定の［ログイン］（account:login）を押したときだけ開く（ログイン切れ・止めたメールでは開かない: F27）。本体の窓を parent にした小さな窓で、
// モーダルにしない（録音中のページの［■ 終了して作成］を押せなくしない）。中継の /auth/done を読み、Access が Cloudflare のログインの画面
// （英語）を出す。メールの 6 けたのコードを入れると、Access が中継の住所に cookie を付けて /auth/done に戻す。そこに着いたら窓を閉じ、
// cookie を読んで（packCookies）すぐ /v1/me で確かめ（通らなければログインにしない）、secrets にしまう。
// 行き先の守りは security.install の loginGuard（中継のホストと、最初に着いた <チーム>.cloudflareaccess.com だけ）
const LOGIN_WIN = { width: 480, height: 680 };
const LOGOUT_TIMEOUT_MS = 5000;
let loginOpen = null;   // { win, promise, pinned, stop(r) } 開いている窓（同時に1つだけ）
const hostKind = (url) => {
  let host = '';
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch (_) { return 'other'; }
  if (host === relay.relayProvider().host) return 'relay';
  return relay.isAccessHost(host) ? 'access' : 'other';
};
// security.install に渡す: ログインの窓（ログインの partition）の webContents か
const isLoginContents = (wc) => Boolean(wc) && accessSes !== null && wc.session === accessSes;
// security.install に渡す: ログインの窓の行き先の判断（本体の枠）と、止めたときの後始末
const loginGuard = {
  allow(url) {
    const pinned = loginOpen ? loginOpen.pinned : '';
    if (!relay.loginNavAllowed(url, pinned)) return false;
    // 窓が最初に着いた Access のホストに、その窓の間は留める
    if (loginOpen && !loginOpen.pinned && hostKind(url) === 'access') loginOpen.pinned = new URL(String(url)).hostname.toLowerCase();
    return true;
  },
  blocked(url, { isMainFrame } = {}) {
    engineLog(`アカウント: ログインの窓が許していない行き先（${hostKind(url)}）へ行こうとしたので止めた`);
    // 本体の枠なら窓を閉じる（会社の通信の検査の転送のことが多い: R14。{ホスト} は窓が着いた Access のホストか、まだなら中継のホスト）
    if (isMainFrame && loginOpen) loginOpen.stop({ ok: false, code: 'proxy', ...(loginOpen.pinned ? { host: loginOpen.pinned } : {}) });
  },
};
// did-fail-load の errorCode・説明 → 通信の符号（R13・R14 の分け方は classifyNetError と同じ）
function loadFailCode(errorCode, desc) {
  const text = `${String(desc || '')} ${errorCode}`;
  if (Number(errorCode) === -7 || /TIMED_OUT/.test(text)) return 'timeout';
  const k = classifyNetError({ message: `net::${String(desc || '')}` });
  if (k === 'cert' || (Number(errorCode) <= -200 && Number(errorCode) > -300)) return 'cert';
  if (k === 'proxy' || k === 'proxy-auth') return 'proxy';
  if (k === 'offline') return 'offline';
  return 'net';
}
// /auth/done に 200 で着いた: cookie を読み、/v1/me で確かめ、しまう → { ok, email } | { ok: false, code }
async function finishAccessLogin() {
  const ses = accessSession();
  let cookies = [];
  try { cookies = await ses.cookies.get({ url: relay.RELAY_BASE }); } catch (_) { cookies = []; }
  if (!relay.packCookies(cookies)) return { ok: false, code: 'no-cookie' };
  const me = await relay.makeAccessApi({ request: relayRequest, session: ses }).me();
  if (!me.ok) {
    engineLog(`アカウント: ログインの直後の確かめが通りませんでした（${me.code}）`);
    return { ok: false, code: me.code === 'denied' ? 'denied' : 'login' };
  }
  const pack = relay.packCookies(cookies, { exp: me.exp });
  if (!pack) return { ok: false, code: 'no-cookie' };
  const saved = secrets ? await secrets.set('relay', pack) : { ok: false, code: 'unavailable' };
  if (!saved.ok) {
    engineLog(`アカウント: ログインの情報をしまえません（${saved.code || 'write'}）`);
    return { ok: false, code: 'store' };
  }
  accessState = { state: 'restored', until: me.exp, pack };
  loginExpired = false;
  setAccountEmail(me.email);
  online.forget(relay.relayProvider().reachUrl);
  clearLoginProblem();
  retryKeptWhenBack();   // 第1d2回 M-3: ログインしたら、見回りを待たずに残した音声を文字起こしする（待たない。投げない）
  return { ok: true, email: me.email };
}
// 録音中の会議の帯 login は、区間を待たずに消す（第1d回 A-6。A-11 でログインの窓の成功から呼ぶ）
function clearLoginProblem() {
  if (meeting && (meeting.problems.has('login') || meeting.problems.has('kept-login'))) {
    clearSttProblem(meeting, 'login', 'kept-login');   // 第1d2回 M-2: ログインしていないため音声を残している帯（B13）も
    sendToMainWin('meeting:update', meetingStatus());
  }
}
// ログインの窓を開く → Promise<{ ok: true, email } | { ok: false, code, host? }>（投げない）。開いている間にもう一度呼ばれたら、
// 前の窓を前に出して同じ Promise を返す。オフライン（net.isOnline() が false）なら窓を作らずに offline
function openLoginWindow() {
  if (loginOpen) {
    try { if (!loginOpen.win.isDestroyed()) { loginOpen.win.show(); loginOpen.win.focus(); } } catch (_) { /* 閉じかけ */ }
    return loginOpen.promise;
  }
  if (!netOnline()) return Promise.resolve({ ok: false, code: 'offline' });
  const ses = accessSession();
  let win;
  try {
    win = new BrowserWindow({
      parent: mainWin && !mainWin.isDestroyed() ? mainWin : undefined, modal: false, ...LOGIN_WIN, title: 'NaTsu のログイン', autoHideMenuBar: true, show: false,
      webPreferences: { partition: relay.ACCESS_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false },
    });
  } catch (e) {
    engineLog(`アカウント: ログインの窓を開けません（${errCode(e)}）`);
    return Promise.resolve({ ok: false, code: 'server' });
  }
  let settle;
  const promise = new Promise((r) => { settle = r; });
  const st = { win, promise, pinned: '', done: false, busy: false };
  // 終える（1回だけ）。失敗なら partition を空にして前のログインを戻す。窓は閉じる
  st.stop = (r) => {
    if (st.done) return;
    st.done = true;
    if (loginOpen === st) loginOpen = null;
    try { if (!win.isDestroyed()) win.close(); } catch (_) { /* 閉じた */ }
    const fin = r.ok ? Promise.resolve() : resetAccessCookies();
    fin.catch(() => {}).then(() => {
      engineLog(r.ok ? 'アカウント: ログインした' : `アカウント: ログインできませんでした（${r.code}）`);
      settle(r);
    });
  };
  loginOpen = st;
  engineLog('アカウント: ログインの窓を開いた');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.once('ready-to-show', () => { try { if (!win.isDestroyed()) win.show(); } catch (_) { /* 閉じた */ } });
  win.on('closed', () => { if (!st.busy) st.stop({ ok: false, code: 'cancel' }); });
  win.webContents.on('did-navigate', (_e, url, httpResponseCode) => {
    let u;
    try { u = new URL(String(url)); } catch (_) { return; }
    if (st.done || st.busy || `${u.origin}${u.pathname}` !== relay.LOGIN_URL) return;
    const code = Number(httpResponseCode);
    if (code !== 200) {
      st.stop({ ok: false, code: code === 401 ? 'login' : code === 403 ? 'denied' : code === 503 ? 'not-ready' : 'server' });
      return;
    }
    // 確かめて・しまう間に窓を閉じても cancel にしない（busy）。終わったら閉じる
    st.busy = true;
    finishAccessLogin().catch((e) => { engineLog(`アカウント: ログインを確かめられません（${errCode(e)}）`); return { ok: false, code: 'login' }; })
      .then((r) => { st.busy = false; st.stop(r); });
  });
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (st.done || isMainFrame === false || Number(errorCode) === -3) return;   // -3 は取り消し（移動を止めた・閉じた）
    const code = loadFailCode(errorCode, errorDescription);
    engineLog(`アカウント: ログインの窓を読めませんでした（${code}）`);
    st.stop({ ok: false, code });
  });
  try {
    const p = win.loadURL(relay.LOGIN_URL);
    if (p && typeof p.catch === 'function') p.catch(() => { /* 失敗は did-fail-load で受ける */ });
  } catch (_) { st.stop({ ok: false, code: 'net' }); }
  return promise;
}
// しばらく手元の印（hold。第1d回 A-3・RL11）: 中継が 1日の上限（daily-cap）・会社の鍵の誤り（upstream-auth）・残高なし（quota）を
// 返したら、until まで中継へ送らない（/health も聞かない）。起動ごと（覚えない: 起動し直せばまた中継を試す）
const HOLD_MS = 10 * 60 * 1000;
const HOLD_MAX_MS = 24 * 3600 * 1000;
let sttHold = { until: 0, why: '', scope: '' };
// 0.9.4 S-5（決めたこと 31）: 中継の 5xx（server）が続いた数（mainlib.relayHoldStep）。2 回続いたら relay-hold で 60 秒から 10 分まで間を空ける
let relayHold = { run: 0 };
const holdNow = () => (Date.now() < sttHold.until ? sttHold : null);
// クラウド（中継）で文字起こしできそうか（第1d2回 M-1。mainlib.cloudLikely）→ { cloud, why }。通信しない・復号しない。
// why は cloud を偽にした理由（signed-out・login・hold の理由・offline・relay-down）。会議と音声入力の始め方が見る
function cloudNow() {
  const inNow = hasRelayLogin();
  const h = holdNow();
  const on = netOnline();
  const peekUp = online.peek(sttProvider().reachUrl);
  const cloud = cloudLikely({ signedIn: inNow, hold: h ? h.why : '', netOnline: on, peekUp });
  if (cloud) return { cloud, why: '' };
  return { cloud, why: !inNow ? (loginExpired ? 'login' : 'signed-out') : h ? h.why : !on ? 'offline' : 'relay-down' };
}
// ログイン中のメールアドレスを書く（'' はログインしていない）。書けなくても投げない（書き手が次の機会にやり直す）
function setAccountEmail(email) {
  settings = readSettings({ ...settings, accountEmail: email }, DEFAULT_SETTINGS).settings;
  const w = settingsWriter.now(settings);
  if (!w.ok) engineLog(`アカウント: 設定に書けませんでした（${errCode(w.error)}）`);
}
// ---------------------------------------------------------------- 0.9.x の要約の組を消す（0.10.0 Task LS-4。D59・決めたこと 107・108）
// 管理しているフォルダの下の、表（engine-install.RETIRED）の名前と大きさのものだけ消す。手の設定のパス（前の版の settings.sumServerExe・
// sumModelPath。0.10.0 から知らないキーとして残る）には触らない。使用中で残ったら印を書かず、次の起動でやり直す。全部消せたら印を書き、
// 消したものがあれば1回だけ知らせる（消すものが無い PC には出さない）。記録は数と符号だけ（パス・名前を書かない）
const RETIRED_SUM_TEXT = (gb) => `要約用の AI は使わなくなったので、PC から消しました（約 ${gb} GB 空きました）。文字起こし用はそのままです。`;
async function retireSummaryEngine() {
  if (!ENGINE_HOME.supported || settings.retiredSumNotified === true) return;
  const manual = [settings.sumServerExe, settings.sumModelPath].filter((x) => typeof x === 'string' && x);
  const r = await engineInstall.retireSum(ENGINE_HOME, { manual });
  if (r.left) { engineLog(`要約のエンジンを消す: 残り ${r.left}（${[...new Set(r.codes)].join('・')}）`); return; }
  // 消すものが無い PC は印を書かない（起動だけで settings.json を書き換えない: stage090 F12。次の起動も小さく探すだけ）
  if (!r.removed.length) return;
  engineLog(`要約のエンジンを消す: 消した ${r.removed.length}・残り 0`);
  settings = { ...settings, retiredSumNotified: true };
  const w = settingsWriter.now(settings);
  if (!w.ok) engineLog(`要約のエンジンを消す: 設定に書けませんでした（${errCode(w.error)}）`);
  noticeMainWin(RETIRED_SUM_TEXT((r.bytes / 1e9).toFixed(1)));
}
// ---------------------------------------------------------------- Claude との連携（MCP。0.10.0 Task C-2。計画の「受け渡す名前と形」の main の分）
// Claude デスクトップの設定ファイル（claude_desktop_config.json）に NaTsu の1項目を足す・外す。場所は main が決める（画面はパスを渡さない: 方針 7）。
//  - 読みは J.readJsonFile（1MB まで・根は物）。壊れている（broken）・読めない（busy）・同じ名前の別の登録（other）・読み取り専用（readonly）の
//    ファイルが1つでもあれば、どのファイルにも書かない（1バイトも変えない: F2）。
//  - 変わるファイルだけ、書く前に同じフォルダへ控え（.natsu-<時刻>.bak。COPYFILE_EXCL）を写し、NaTsu の控えは新しい3つだけ残す（決めたこと 18）。
//  - 書いた後に読み直して same を確かめる（違えば busy）。登録したら settings.mcpRegisteredFor（ファイルの数と版だけ。パスや中身は持たない:
//    決めたこと 151）を書き、外したら消す。mcpRegisteredFor は SETTING_RULES に入れない（画面の settings:save では書けない。pickSavable が落とす）。
//  - 記録は「MCP の登録: <足した|直した|外した|変えなかった|断った（符号）>（ファイル N・控え M）」だけ（パス・中身を書かない: 決めたこと 26）。
const MCP_MAX_BYTES = 1024 * 1024;
const MCP_WORSE = ['same', 'none', 'stale', 'other', 'readonly', 'busy', 'broken'];   // 後ろほど悪い（2つのファイルは悪い方を出す）
const MCP_REFUSE = new Set(['broken', 'busy', 'other', 'readonly']);
const isPlainObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const worseOf = (a, b) => (MCP_WORSE.indexOf(b) > MCP_WORSE.indexOf(a) ? b : a);
function mcpPaths() {
  return { exe: process.execPath, script: path.join(app.getAppPath(), 'src', 'mcp', 'server.js'), dbDir: DB_INIT.dataDir };
}
// 設定ファイルの場所 [{ file, kind }]（0.10.1 CD-1・CD-2: 新しい Store 版の場所 %LOCALAPPDATA%\Claude-Data\claude_<符号> も。決めたこと 1）
function mcpPlaces() {
  let appData = '';
  try { appData = app.getPath('appData'); } catch (_) { appData = ''; }
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
  const places = MC.configPlaces({ appData, localAppData: process.env.LOCALAPPDATA || '', readdir: (d) => fs.readdirSync(d), exists: (p) => fs.existsSync(p), isDir });
  // 0.10.1 2回目の点検の直し（Ruling R16）: 同じフォルダ（ジャンクション・シンボリックリンク）を指す場所は1つにまとめる（同じファイルに2回書いて R9 で断り続けない）。
  // 記録の場所の数の1行も、まとめた後（NaTsu が本当に書く場所）を数える
  const real = (dir) => { const r = fs.realpathSync.native(dir); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return MC.dedupePlaces(places, real);
}
function mcpFiles() {
  return mcpPlaces().map((p) => p.file);
}
// 場所の種類の数の1行（パス・フォルダの名前・符号を書かない: 決めたこと 13。頭を「MCP」にしない）
function mcpPlaceLine(places, boot) {
  const c = MC.placeCounts(places);
  return `${boot ? '起動のとき: ' : ''}Claude デスクトップの設定ファイルの場所: Roaming ${c.roaming}・Claude-Data ${c.data}・Packages ${c.packages}`;
}
// 前に登録した印（ファイルの数が 1 以上の整数のときだけ印とみなす）
const mcpRegisteredMark = () => { const m = settings && settings.mcpRegisteredFor; return isPlainObj(m) && Number.isInteger(m.files) && m.files > 0; };
// 1つのファイルを読んで、変えた後の形を決める（書かない）。fix は MC.mergeEntry か MC.removeEntry
// 0.10.1 点検の直し（Ruling R9）: 読んだバイト（before）も持つ。書く直前にもう一度読んで比べ、計画の後にほかのプログラム（Claude デスクトップ）が
// 書いていたら書かない（その書き込みを古い中身で消さない）。readJsonFile が読んだバイトそのものを、渡した fs の口で受け取る
function mcpPlanFile(file, fix) {
  let before = null;
  const capFs = { ...fs, readFileSync: (f, ...a) => { const b = fs.readFileSync(f, ...a); before = b; return b; } };
  const r = J.readJsonFile(file, { shape: isPlainObj, maxBytes: MCP_MAX_BYTES, fs: capFs });
  if (r.state === 'broken') return { file, refuse: 'broken' };
  if (r.state === 'unreadable') return { file, refuse: 'busy' };
  const had = r.state === 'ok';
  const m = fix(had ? r.value : { mcpServers: {} });
  if (!m.ok) return { file, refuse: m.code === 'shape' ? 'broken' : m.code };
  const changed = had ? m.changed : m.changed && Object.keys(m.config.mcpServers || {}).length > 0;
  if (changed && had && J.isReadOnly(file)) return { file, refuse: 'readonly' };
  return { file, had, changed, config: m.config, before: had ? before : null };
}
// 計画のときから変わっていないか（R9）。あったファイルはバイトが同じ、無かったファイルはまだ無い
function mcpUnchangedSincePlan(p) {
  if (!p.had) return !fs.existsSync(p.file);
  try { return Buffer.isBuffer(p.before) && fs.readFileSync(p.file).equals(p.before); } catch (_) { return false; }
}
// 0.10.1 点検の直し（Ruling R7。2回目の点検の直し R17 で、戻すバイトを計画のときのバイト（メモリ）にした）: 書く途中で失敗したら、この操作で書いたファイルを
// 後ろから順に元のバイトに戻す（もとから無かった、NaTsu が作ったファイルは消す）。今の中身が NaTsu の書いたとおりのときだけ戻す（その後にほかのプログラムが書いたなら、それを消さない）。
// 一時ファイル（<名前>.natsu-restore-<pid>.tmp）に写してから名前を変える。→ 戻せなかったファイルの数
function mcpRollback(written) {
  let unrestored = 0;
  for (const w of [...written].reverse()) {
    try {
      const mine = Buffer.from(JSON.stringify(w.p.config, null, 2), 'utf8');
      if (!fs.readFileSync(w.p.file).equals(mine)) { unrestored += 1; continue; }
      // 0.10.1 2回目の点検の直し（Ruling R17）: 戻すバイトは、計画のときに読み、書く直前にも同じと確かめた p.before（メモリ）。控えのファイルに頼らない。
      // 消すのは、もとから無かった（!had）ファイルだけ
      if (w.p.had) {
        const tmpFile = `${w.p.file}.natsu-restore-${process.pid}.tmp`;
        // 0.10.1 3回目の点検の直し（Ruling R21）: 書くのと名前を変えるのを同じ try に入れ、どちらで失敗しても一時ファイルを消す
        try { fs.writeFileSync(tmpFile, w.p.before); fs.renameSync(tmpFile, w.p.file); } catch (e) { try { fs.unlinkSync(tmpFile); } catch (_) { /* 残っても次に */ } throw e; }
      } else {
        fs.unlinkSync(w.p.file);
      }
    } catch (_) {
      unrestored += 1;
    }
  }
  return unrestored;
}
// 書く前の控え（同じ時刻の名前があれば 1 ミリ秒ずつずらす）と、NaTsu の控えを新しい BACKUP_KEEP 個だけ残す
// 写した控えの名前（0.10.1 点検の直し R7: 書く途中で失敗したときの戻しに使う）
let mcpLastBackup = '';
function mcpBackup(file) {
  let t = Date.now();
  mcpLastBackup = '';
  for (let i = 0; i < 20; i++, t++) {
    const name = MC.backupName(file, new Date(t));
    try { fs.copyFileSync(file, name, fs.constants.COPYFILE_EXCL); mcpLastBackup = name; break; } catch (e) { if (!(e && e.code === 'EEXIST')) throw e; }
  }
  // 0.10.1 2回目の点検の直し（Ruling R17）: 20 回続けて名前があって写せなければ投げる（控えの無いまま書かない。呼び手は busy で断る）
  if (!mcpLastBackup) { const e = new Error('控えを写せませんでした'); e.code = 'EEXIST'; throw e; }
  const dir = path.dirname(file);
  const base = path.basename(file);
  const mine = path.basename(mcpLastBackup);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => MC.isNatsuBackup(base, n) && n !== mine).sort(); } catch (_) { names = []; }
  // 今写した控えは消さない（時計が戻った PC で、名前の順で一番古くても）。ほかの NaTsu の控えは新しい BACKUP_KEEP - 1 個を残す
  for (const n of names.slice(0, Math.max(0, names.length - (MC.BACKUP_KEEP - 1)))) { try { fs.unlinkSync(path.join(dir, n)); } catch (_) { /* 消せなければ次に */ } }
}
// ファイルごとの状態（'same'・'none'・'stale'・'other'・'readonly'・'busy'・'broken'。読むだけ。0.10.1 CD-2 で mcpDesktopState から分けた）
function mcpFileStates(files, entry) {
  return files.map((file) => {
    const p = mcpPlanFile(file, (cfg) => MC.mergeEntry(cfg, entry));
    if (p.refuse) return p.refuse;
    if (!p.changed) return 'same';
    const r = J.readJsonFile(file, { shape: isPlainObj, maxBytes: MCP_MAX_BYTES });
    return r.state === 'ok' ? MC.entryState(r.value, entry) : 'none';
  });
}
// → { state, files }（読むだけ。書かない）
function mcpDesktopState() {
  const files = mcpFiles();
  if (!files.length) return { state: 'noclaude', files: 0, hasEntry: false };
  let entry;
  try { entry = MC.serverEntry(mcpPaths()); } catch (_) { return { state: 'busy', files: files.length, hasEntry: false }; }
  let state = 'same';
  const states = mcpFileStates(files, entry);
  for (const st of states) state = worseOf(state, st);
  // 0.10.1 点検の直し（Ruling R8）: どこかに NaTsu の印のある natsu がある（画面は［登録を外す］を出す。パスは渡さない）
  const hasEntry = states.some((st) => st === 'same' || st === 'stale');
  // 前に登録したのに、どのファイルにも NaTsu の項目が無い（決めたこと 151）
  if (state === 'none' && mcpRegisteredMark()) state = 'gone';
  return { state, files: files.length, hasEntry };
}
// Claude デスクトップ（claude.exe）が動いているか（決めたこと 149。tasklist.exe を決まった引数で1回。シェルを通さない）→ true・false・null
function claudeDesktopRunning() {
  return new Promise((resolve) => {
    try {
      execFile('tasklist.exe', [...MC.TASKLIST_ARGS], { windowsHide: true, timeout: 5000 },
        (err, stdout) => resolve(err ? null : MC.claudeRunningOf(String(stdout == null ? '' : stdout))));
    } catch (_) { resolve(null); }
  });
}
async function mcpStatus() {
  const desktop = mcpDesktopState();
  return { desktop: { ...desktop, running: await claudeDesktopRunning() } };
}
function mcpLogLine(word, files, backups) {
  engineLog(`MCP の登録: ${word}（ファイル ${files}・控え ${backups}）`);
}
// 0.10.1 2回目の点検の直し（Ruling R18）: 外したとき（一部だけ効いたときも）は「外した」印 mcpUnregistered を置き、次に登録が通ったら消す
// （起動のときに、外したかった人へ「登録し直す」を勧めない。mcpRegisteredFor と同じく SETTING_RULES に入れない）
function setMcpMark(mark) {
  const next = { ...settings };
  if (mark) { next.mcpRegisteredFor = mark; delete next.mcpUnregistered; }
  else { delete next.mcpRegisteredFor; next.mcpUnregistered = true; }
  settings = next;
  const w = settingsWriter.now(settings);
  if (!w.ok) engineLog(`MCP の登録: 設定に書けませんでした（${errCode(w.error)}）`);
}
// 足す（register）か外す（unregister）。→ { ok, state, code? }。boot は起動のときの書き直し（0.10.1 CD-4。記録の頭だけが変わる）
// noWrite（0.10.1 2回目の点検の直し R15）: 先に見た形で断る・何も変えないと決めた押し。計画し直して書くことになったら、書かずに busy で断る（tasklist を見ていないので）
function mcpApply(register, { boot = false, noWrite = false } = {}) {
  const places = mcpPlaces();
  const files = places.map((p) => p.file);
  if (!files.length) { mcpLogLine('断った（noclaude）', 0, 0); return { ok: false, state: 'noclaude', code: 'noclaude' }; }
  engineLog(mcpPlaceLine(places, boot));
  const entry = MC.serverEntry(mcpPaths());
  const plans = files.map((f) => mcpPlanFile(f, (cfg) => (register ? MC.mergeEntry(cfg, entry) : MC.removeEntry(cfg))));
  const refused = plans.filter((p) => p.refuse).reduce((a, p) => (a ? worseOf(a, p.refuse) : p.refuse), '');
  if (refused) { mcpLogLine(`断った（${refused}）`, files.length, 0); return { ok: false, state: refused, code: refused }; }
  if (noWrite && plans.some((p) => p.changed)) { mcpLogLine('断った（busy）', files.length, 0); return { ok: false, state: 'busy', code: 'busy' }; }
  const wasStale = register && plans.some((p) => p.had && p.changed && (() => {
    const r = J.readJsonFile(p.file, { shape: isPlainObj, maxBytes: MCP_MAX_BYTES });
    return r.state === 'ok' && MC.entryState(r.value, entry) === 'stale';
  })());
  let backups = 0;
  let failed = '';
  const written = [];
  // 0.10.1 点検の直し（Ruling R7・R9）: 全部か無しか。最初の失敗で止め、この操作で書いたファイルを戻す。書く直前（控えの前と後）に計画のときのバイトと比べる
  for (const p of plans.filter((x) => x.changed)) {
    try {
      if (!mcpUnchangedSincePlan(p)) { failed = 'busy'; break; }
      if (p.had) { mcpBackup(p.file); backups += 1; }
      if (!mcpUnchangedSincePlan(p)) { failed = 'busy'; break; }
      J.writeJsonFile(p.file, p.config);
      written.push({ p });
    } catch (e) {
      failed = e && e.readOnly ? 'readonly' : 'busy';
      break;
    }
  }
  let unrestored = 0;
  let leftChanged = false;
  if (failed) {
    unrestored = mcpRollback(written);
    leftChanged = unrestored > 0;
    if (unrestored) engineLog(`Claude デスクトップの設定ファイルを元に戻せませんでした: ${unrestored} 件`);
  } else {
    // 書いた後に読み直して確かめる（違えば busy）。0.10.1 CD-2（決めたこと 9）: 書いたファイルは中身がちょうど書いたとおりか（natsu の項目もほかの鍵も）、
    // 書かなかったファイルは natsu の項目が登録なら same・外すなら none か。外すときも確かめる。ここで違ったときは戻さない（書いた後に書いたほかのプログラムの中身を消さない）
    failed = mcpVerify(plans, entry, register);
    leftChanged = Boolean(failed) && written.length > 0;
  }
  if (failed) {
    mcpLogLine(`断った（${failed}）`, files.length, backups);
    // 0.10.1 点検の直し（Ruling R8）: 外すのが一部でも効いた（natsu を消したファイルが残った）なら印を消す。起動のときに黙って書き戻さない
    if (!register && leftChanged) setMcpMark(null);
    return unrestored ? { ok: false, state: failed, code: failed, unrestored } : { ok: false, state: failed, code: failed };
  }
  const changed = plans.some((p) => p.changed);
  mcpLogLine(!changed ? '変えなかった' : !register ? '外した' : wasStale ? '直した' : '足した', files.length, backups);
  if (register) setMcpMark({ files: files.length, version: app.getVersion() });
  else setMcpMark(null);
  return { ok: true, state: register ? 'same' : 'none' };
}
// 書いた後の確かめ → '' か 'busy'（ほかのプログラム（動いている Claude デスクトップなど）が書く間に書き換えた）
function mcpVerify(plans, entry, register) {
  for (const p of plans) {
    const r = J.readJsonFile(p.file, { shape: isPlainObj, maxBytes: MCP_MAX_BYTES });
    if (p.changed) {
      if (r.state !== 'ok' || !isDeepStrictEqual(r.value, p.config)) return 'busy';
    } else if (register ? (r.state !== 'ok' || MC.entryState(r.value, entry) !== 'same') : (r.state === 'ok' && MC.entryState(r.value, entry) !== 'none')) {
      return 'busy';
    }
  }
  return '';
}
// 0.10.1 CD-3（D84・D85・Ruling R1）: Claude デスクトップが動いている間は、登録・外す・登録し直すのどれも書かない（0.10.0 の決めたこと 149 を変えた）。
// 書く前に tasklist を1回見て、動いている → running で断る。分からない → 1回目は unknown で断り、同じボタンを続けて（60 秒以内・間にほかの押しが無い）
// 押したら書く（答えに unverified）。1回目の印は main のメモリだけ（mcp:status では変えない。起動し直すと消える）
let mcpUnknownPending = null;
function mcpStateNow() {
  try { return mcpDesktopState().state; } catch (_) { return 'busy'; }
}
async function mcpGuarded(register) {
  const action = register ? 'register' : 'unregister';
  const files = mcpFiles();
  const n = files.length;
  if (!n) { mcpUnknownPending = null; return { ...mcpApply(register), running: null }; }
  // 0.10.1 点検の直し（Ruling R11）: 先に書けないファイル（broken・busy・other・readonly）と、何も変えない押しを見る。そのときは tasklist を見ずに
  // mcpApply がその理由で断る・「変えなかった」と答える（Claude の終了を頼まない）。押しとして1回目の印は消す。tasklist を見るのは書くときだけ
  const entry = MC.serverEntry(mcpPaths());
  const dry = files.map((f) => mcpPlanFile(f, (cfg) => (register ? MC.mergeEntry(cfg, entry) : MC.removeEntry(cfg))));
  if (dry.some((p) => p.refuse) || !dry.some((p) => p.changed)) { mcpUnknownPending = null; return { ...mcpApply(register, { noWrite: true }), running: null }; }
  const running = await claudeDesktopRunning();
  if (running === true) {
    mcpUnknownPending = null;
    mcpLogLine('断った（running）', n, 0);
    return { ok: false, state: mcpStateNow(), code: 'running', running: true };
  }
  let unverified = false;
  if (running === null) {
    const step = MC.unknownStep({ pending: mcpUnknownPending, action, now: Date.now() });
    mcpUnknownPending = step.pending;
    if (!step.write) {
      mcpLogLine('断った（unknown）', n, 0);
      return { ok: false, state: mcpStateNow(), code: 'unknown', running: null };
    }
    engineLog('Claude デスクトップの確かめ: 動いているか分からないまま、2回目の押しで書きます');
    unverified = true;
  } else {
    mcpUnknownPending = null;
  }
  const r = mcpApply(register);
  return r.ok && unverified ? { ...r, running, unverified: true } : { ...r, running };
}
function mcpRegister() {
  return mcpGuarded(true);
}
function mcpUnregister() {
  return mcpGuarded(false);
}
// natsu:// を利用者ごとに登録する（0.10.0 LN-3。起動のたび。パックした NaTsu で、今の場所の登録でないときだけ。判断は lib.protocolPlan）。投げない
function registerNatsuProtocol() {
  try {
    if (!app.isPackaged) return;
    const args = [...lib.protocolPlan({}).args];
    const isDefault = app.isDefaultProtocolClient(lib.PROTOCOL, process.execPath, args);
    const plan = lib.protocolPlan({ packaged: app.isPackaged, execPath: process.execPath, isDefault });
    if (!plan.register) return;
    const ok = app.setAsDefaultProtocolClient(lib.PROTOCOL, process.execPath, plan.args);
    engineLog(`リンクの登録: ${ok ? '登録した' : '登録できなかった'}`);
  } catch (e) { engineLog(`リンクの登録: できなかった（${errCode(e)}）`); }
}

// ---------------------------------------------------------------- リンクで開く（0.10.0 LN-4。D72・決めたこと 145・146）
// 起動の引数と2つ目の起動の引数の -- より後ろの natsu:// だけを読み（lib.linkFromArgv）、窓を出して前に出し（最小化なら戻す）、
// 画面へ page:open-link { id, anchor } を送る（読み込み中なら読み終えてから）。できるのはページを開いて捲ることだけ（書く・消す・要約・
// 設定・登録・外へ送る道を持たない）。記録はリンクの文字も ID も書かない。2 秒に 5 回を越えたリンクは捨てる（lib.linkRate）
let linkTimes = [];
function openLinkFromArgv(argv) {
  const l = lib.linkFromArgv(argv);
  if (l === null) return;
  if (l === 'bad') { engineLog('リンク: 読めないリンクを捨てました'); return; }
  const r = lib.linkRate(linkTimes, Date.now());
  linkTimes = r.times;
  if (!r.ok) { engineLog('リンク: 2 秒に 5 回を越えたリンクを捨てました'); return; }
  createMainWindow();
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  const p = { id: l.id, anchor: l.anchor };
  if (mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', () => sendToMainWin('page:open-link', p));
  else sendToMainWin('page:open-link', p);
}

// 起動の後（窓が出てから）に1回。読めなければ何もしない。投げない。
// 0.10.1 CD-4（D83・D86。0.10.0 の決めたこと 151 の「黙って書き直さない」を持ち主の答えで変えた）: 前に登録した印があり、欠けた（none）か古い（stale）場所があって、
// どのファイルも書ける形なら、Claude デスクトップが動いていない（tasklist が false）ときだけ、［登録］と同じ書き方で黙って書き直し、知らせない。
// 動いている・分からない → RN4（mcpFix）。書けないファイルがある・書いてみて断った → 今の知らせ（stale があれば mcpStale、ほかは mcpGone）。
// 印が無いときは 0.10.0 のまま（全部の悪い方が stale なら mcpStale）。tasklist を見るのは書き直しが要るときだけ（判断は MC.autoPlan）
async function checkMcpRegistration() {
  let states;
  try {
    const files = mcpFiles();
    if (!files.length) return;
    states = mcpFileStates(files, MC.serverEntry(mcpPaths()));
  } catch (_) { return; }
  const notice = (text) => noticeMainWin({ text, action: 'settings-summary' });
  const fallback = () => notice(states.includes('stale') ? NOTICE.mcpStale : NOTICE.mcpGone);
  const plan = MC.autoPlan({ states, marked: mcpRegisteredMark(), unregistered: Boolean(settings && settings.mcpUnregistered === true) });
  if (plan === 'notice-stale') { notice(NOTICE.mcpStale); return; }
  if (plan === 'notice-gone') { notice(NOTICE.mcpGone); return; }
  if (plan !== 'rewrite') return;
  const running = await claudeDesktopRunning();
  if (running !== false) { notice(NOTICE.mcpFix); return; }
  let r;
  try { r = mcpApply(true, { boot: true }); } catch (_) { r = { ok: false }; }
  if (!r.ok) fallback();
}

// 経路を決める（送るときのログイン（pack）も返す: transcribeAuto だけが使い、ほかへは渡さない）。
// opts.scope: 知らせの係（会議。無ければ起動ごと）、opts.quiet: 知らせを出さない、
// opts.probe: false なら中継へ届くかを確かめず net.isOnline() だけで見る（先読みの判断。通信を出さない）
async function sttRoute(localOnly, { scope = null, quiet = false, probe = true } = {}) {
  const provider = sttProvider();
  // ［この会議は PC の中だけ］ならしまったログインを復号もしない（送らないのにキーリングの確かめを出さない）
  if (!localOnly) {
    await accessReady;
    // 起動のときに復号できなかった（F26）: 経路を決めるたびに、もう一度復号して戻す
    if (accessState.state === 'unreadable') await restoreAccessCookies();
    // 起動の後に期限が来た: ログイン切れとして消す（L3・B3。黙って「ログインしていない」にしない）
    if (accessState.state === 'restored' && accessState.until !== null && accessState.until <= nowSec()) {
      await forgetAccessLogin();
      loginExpired = true;
      engineLog('アカウント: しまったログインの期限が切れていた');
    }
  }
  const h = holdNow();
  const up = probe ? () => online.isUp(provider.reachUrl)
    : async () => (netOnline() ? { up: true, why: 'ok' } : { up: false, why: 'offline' });
  const signedIn = hasRelayLogin();
  const d0 = await decideStt({ localOnly: Boolean(localOnly), signedIn, hold: h ? h.why : '', up });
  // ログインしていない理由を分ける: 今は復号できない（key-unreadable。知らせなし）・期限切れ・ログイン切れ（login。L3・B3）
  let d = d0;
  if (d0.why === 'signed-out' && accessState.state === 'unreadable') d = { route: 'local', why: 'key-unreadable' };
  else if (d0.why === 'signed-out' && loginExpired) d = { route: 'local', why: 'login' };
  const scopeOf = d.why === 'daily-cap' && h ? h.scope : '';
  // 準備を選んでいない PC は PC で文字起こししない（L2〜L8 は本当でない）。会議の中は音声を残すときに K1〜K4（第1d2回 M-2）
  if (!quiet && d.route === 'local' && isOfflineChosen()) {
    const code = noticeFor(d.why, scopeOf);
    if (code) noticeOnce(scope, code, STT_NOTICE[code](provider));
  }
  const r = { route: d.route, why: d.why, provider, pack: d.route === 'cloud' ? accessState.pack : '' };
  if (scopeOf) r.scope = scopeOf;
  return r;
}
// → { route, why, provider, scope? }（送るときのログインは返さない）
async function chooseSttRoute(localOnly, opts = {}) {
  const { pack: _pack, ...r } = await sttRoute(localOnly, opts);
  return r;
}
// 中継の失敗（rate・rate-long の短い 429 を待ちきれなかった）→ 区間の失敗の文の Error。上限（L10）は起動ごとに1回知らせる。
// keepForRetry: 文字起こしまで届いていない（上限）。送り直しでは WAV と待ち行列を消さずに残す
function cloudFailure(e, provider) {
  const code = (e && e.code) || 'unknown';
  if (code === 'rate' || code === 'rate-long') noticeOnce(null, 'rate', STT_NOTICE.rate(provider));
  engineLog(`文字起こしの経路: 中継で失敗（${code}${e && e.status ? ` ${e.status}` : ''}）`);
  const err = new Error(sttCloud.cloudErrorText(e, provider.label));
  err.cloudCode = code;
  err.keepForRetry = code === 'rate' || code === 'rate-long';
  return err;
}
// 中継の答えの形（状態・cf-ray があるか・転送の行き先の種類）を1行（実機の R4 の手がかり。値・URL・メールは書かない）
function logAccessAnswer(e, code) {
  const h = e && e.hint && typeof e.hint === 'object' ? e.hint : {};
  engineLog(`アカウント: 中継の答え ${e && e.status ? e.status : '-'}（cf-ray ${h.cfRay ? 'あり' : 'なし'}・行き先 ${h.dest === 'access' || h.dest === 'other' ? h.dest : 'なし'}）→ ${code}`);
}
// 中継の失敗のうち、その区間を手元でやり直すもの（stt-cloud.redoLocally）の後始末 → 手元にした理由の符号。
// login（Access のログイン切れ・取り消し）・denied（止めたメール・会社のドメインでない）: 送ったときのログイン（pack）がまだ今のログインなら、
// しまったログイン（secrets・partition・accountEmail）を消す（送っている間にログアウト・ログインし直したなら今のログインは消さない）。
// L3（［ログインし直す］付き）・L11 は消したときだけ。どちらもログインの窓は開かない（F27）。同じ会議では L2 を重ねない。daily-cap: 日の替わりまで hold。
// quota・upstream-auth: 10 分の hold。通信の符号と server: 届いた結果の覚えを捨て、次の区間は届くかを確かめ直す
async function relayFallback(e, scope, provider, sentPack) {
  const code = e instanceof sttCloud.CloudSttError && typeof e.code === 'string' ? e.code : 'server';
  engineLog(`文字起こしの経路: 中継で失敗（${code}${e && e.status ? ` ${e.status}` : ''}）。この区間は PC で文字起こしします`);
  if (code === 'login' || code === 'denied') {
    logAccessAnswer(e, code);
    const current = accessState.state === 'restored' ? accessState.pack : '';
    // 送った後に自分でログアウトした・ログインし直したときは、今のログインを消さず L3・L11 も出さない（場面 relay-logout・relay-relogin）
    if (!current) {
      engineLog(`アカウント: 中継が ${code}。送った後にログアウトしていた`);
      return code;
    }
    if (current !== sentPack) {
      engineLog(`アカウント: 中継が ${code}。送った後にログインし直していたので、今のログインは消さない`);
      return code;
    }
    const removed = await forgetAccessLogin();
    engineLog(`アカウント: 中継が ${code}。ログインを消した${removed && removed.ok === false ? `（消せませんでした: ${removed.code || 'write'}）` : ''}`);
    if (isOfflineChosen()) noticeOnce(scope, code, STT_NOTICE[code](provider));   // 選んでいない PC は K4・K3（第1d2回 M-2）
    noticeSeen(scope).add('signed-out');
    return code;
  }
  let scopeOf = '';
  if (code === 'daily-cap') {
    scopeOf = e.scope === 'all' ? 'all' : 'user';
    const sec = Number.isInteger(e.retryAfter) && e.retryAfter > 0 ? e.retryAfter : HOLD_MS / 1000;
    sttHold = { until: Date.now() + Math.min(sec * 1000, HOLD_MAX_MS), why: 'daily-cap', scope: scopeOf };
  } else if (code === 'quota' || code === 'upstream-auth') {
    sttHold = { until: Date.now() + HOLD_MS, why: code, scope: '' };
  } else if (sttCloud.isOfflineError(e) || code === 'server') {
    online.forget(provider.reachUrl);
  }
  // 0.9.4 S-5（決めたこと 31）: 5xx が続いたら間を空ける（その間は中継へも /health へも送らない。cloudNow・見回りも hold として見る）
  {
    const r = lib.relayHoldStep(relayHold, { code, now: Date.now() });
    relayHold = r.st;
    if (r.holdMs > 0) {
      sttHold = { until: Date.now() + r.holdMs, why: 'relay-hold', scope: '' };
      engineLog(`文字起こしの経路: 中継の失敗が続いたため、${Math.round(r.holdMs / 1000)} 秒の間は中継へ送りません（${code}）`);
    }
  }
  if (sttHold.why === code && sttHold.until > Date.now()) engineLog(`文字起こしの経路: ${Math.round((sttHold.until - Date.now()) / 1000)} 秒の間は中継へ送りません（${code}${scopeOf ? ` ${scopeOf}` : ''}）`);
  const n = isOfflineChosen() ? noticeFor(code, scopeOf) : '';   // 選んでいない PC は K3（第1d2回 M-2）
  if (n) noticeOnce(scope, n, STT_NOTICE[n](provider));
  return code;
}
// opts: transcribeLocal と同じ（isStale・learn）＋ localOnly・notice（会議の知らせの係。無ければ起動ごと）・what（記録の名前）・
// cloudOnly（見回りから: 手元へ落ちる区間は手元のエンジンを起こさずに keepForRetry の Error を投げる。第1d2回 M-3 の点検・F5・RF49）・
// seg（区間の番号 s{n}。手元で失敗したら engine.log に番号と符号を1行: 第1d回 A-14）・
// onWait(sec)（OpenAI の短い 429 を待つとき。会議の帯 wait: 第1d回 A-6）・dictation（音声入力: 作り話の判定を小さな音の録音だけにする。0.9.1 Q-2）
// 0.9.1 Q-2: 無音の音声は { text: '', route: 'none', silent: true }、作り話の答えは { …, text: '', echo: true, echoFold } で返す。どの答えにも loudDbfs
// （一番大きい 0.5 秒の窓。読めない WAV は null）を付ける
// → { text, route: 'cloud'|'local', provider, why, scope? }（scope は why が daily-cap のときだけ 'user'|'all'。帯の分け方: A-6）。
// 手元のエンジンが用意できないときの Error は engineMissing を持つ。手元で文字起こしする区間の失敗の Error には sttRoute
// （{ route: 'local', why, scope? }。帯の符号を決める: A-6）を付ける
async function transcribeAuto(wav, tail, durationMs, opts = {}) {
  const scope = opts.notice || null;
  const what = opts.what || '音声入力';
  // 0.9.1 Q-2（決めたこと 1・13）: 音がほとんど無い（一番大きい 0.5 秒が SILENT_DBFS より小さい）音声は、経路を決める前に（中継へも手元へも）送らず、
  // 空の答えと同じに返す（呼び手は今の「空」の扱いで除く）。経路は 'none'（経路で数える所・帯に渡さない）。読めない WAV（null）は今どおり送る
  const loud = wavLoudestDbfs(wav);
  if (loud !== null && loud < SILENT_DBFS) {
    quietDrops += 1;
    engineLog(`音の無い区間: ${what} を送らずに除きました（${loud === -Infinity ? '無音' : `${Math.round(loud)} dBFS`}・起動から ${quietDrops} 回目）`);
    return { text: '', route: 'none', why: 'silent', provider: sttProvider(), silent: true, loudDbfs: loud };
  }
  const r = { ...(await transcribeRouted(wav, tail, durationMs, opts, scope, what)), loudDbfs: loud };
  // 0.9.1 Q-2（決めたこと 2・3）: 答えが認識ヒントの材料だけ（作り話）なら、空の答えと同じに返す（echo。会議の区間は止まりの見張りに数えない）
  if (r.text && hintEcho(r.text, hintOf(tail), { dictation: Boolean(opts.dictation), loudDbfs: loud })) {
    echoDrops += 1;
    engineLog(`認識ヒントの繰り返し: ${what} の答えを除きました（起動から ${echoDrops} 回目）`);
    return { ...r, text: '', echo: true, echoFold: hintFold(r.text) };
  }
  return r;
}
// 除いた数（起動ごと。記録の行に書く）
let quietDrops = 0;
let echoDrops = 0;
async function transcribeRouted(wav, tail, durationMs, opts, scope, what) {
  const d = await sttRoute(Boolean(opts.localOnly), { scope });
  const provider = d.provider;
  let why = d.why;
  let capScope = d.scope || '';
  let relayErr = null;   // 手元へ戻した中継の失敗（第1d2回 M-2: 断った区間の文）
  if (d.route === 'cloud') {
    const t0 = Date.now();
    try {
      const raw = await sttCloud.transcribeRelay(wav, {
        request: relayRequest, session: accessSession(), provider, language: settings.language, prompt: buildPrompt(tail),
        sleep: (ms) => sleepMs(ms * STT_SLEEP_SCALE),
        onWait: (sec) => {
          engineLog(`文字起こしの経路: 中継が 429（OpenAI の上限に近い）。${sec} 秒待つ`);
          noticeOnce(scope, 'wait', STT_NOTICE.wait(provider, sec));
          if (typeof opts.onWait === 'function') opts.onWait(sec);   // 会議の帯 wait（第1d回 A-6）
        },
        onPromptDropped: () => engineLog('文字起こしの経路: 中継が認識ヒント付きの要求を断ったため、ヒントを外して送り直しました'),
      });
      engineLog(`文字起こしの経路: ${what} → cloud(relay) ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
      relayHold = lib.relayHoldStep(relayHold, { code: 'ok', now: Date.now() }).st;   // 0.9.4 S-5: 中継が答えたら数えを 0 に戻す
      return { text: cleanWhisperText(raw), route: 'cloud', provider, why: 'ok' };
    } catch (e) {
      if (!sttCloud.redoLocally(e)) throw cloudFailure(e, provider);
      // この区間だけ手元でやり直す（録音と文字起こしは中継に頼らない: RF35）
      why = await relayFallback(e, scope, provider, d.pack);
      capScope = why === 'daily-cap' ? (e.scope === 'all' ? 'all' : 'user') : '';
      relayErr = e;
    }
  }
  engineLog(`文字起こしの経路: ${what} → local（理由: ${why}）`);
  const via = { route: 'local', why, ...(capScope ? { scope: capScope } : {}) };
  // 第1d2回 M-2（D21）: 準備を選んでいない PC は手元を待たない（起こすものが無い）。音声を残す Error（kept）を投げる。
  // 中継が音声を見て断った（bad-request・too-large: 待っても同じ答え）は残さず、今の失敗の Error（refused。決めたこと 12）
  if (!isOfflineChosen() && !engineValid(whisperEng)) {
    if (!keptCodeFor({ localOnly: false, why })) {
      const err = new Error(sttCloud.cloudErrorText(relayErr, provider.label));
      err.refused = true;
      err.sttRoute = via;
      throw err;
    }
    engineLog(`文字起こしの経路: ${what} → 音声を残した（${why}）`);
    const err = new Error(KEPT_ERROR_TEXT);
    err.engineMissing = true;
    err.kept = true;
    err.sttRoute = via;
    throw err;
  }
  // 第1d2回 M-3 の点検（F5・RF49）: 見回りは、/health に答えた中継が文字起こしで落ちても手元のエンジンを起こさない（壊れた組なら
  // 毎分起動して落ちる）。音声と待ち行列は残し、次の見回り・設定の保存・次の起動でやり直す
  if (opts.cloudOnly) {
    engineLog(`文字起こしの経路: ${what} → 見回りでは手元で文字起こししない（${why}）`);
    const err = new Error('今はクラウドで文字起こしできません');
    err.keepForRetry = true;
    err.cloudCode = why;
    err.sttRoute = via;
    throw err;
  }
  // 0.9.4 S-3（決めたこと 5）: 録音中（会議・音声入力）は会議の後の PC の文字起こしを止める（遅い PC で前の会議の後の文字起こしと次の会議が
  // PC を取り合わない）。音声と待ち行列は残し、録音が終わったら（締めの transcribeRecovered）続ける。クラウドで送れる区間は上で送った
  if (typeof opts.busyStop === 'function' && opts.busyStop()) {
    engineLog(`文字起こしの経路: ${what} → 録音中のため PC の文字起こしを止めた`);
    const err = new Error('録音中のため、会議の後の文字起こしを止めました');
    err.keepForRetry = true;
    err.cloudCode = 'busy';
    err.sttRoute = via;
    throw err;
  }
  // 0.9.4 S-4（決めたこと 11）: この PC の文字起こしが録音に追いつかない会議（paceSlow）は、PC へ送らずに音声を残す（会議の後で文字起こしする）。
  // クラウドで送れる区間は上で送った。音声入力・会議の後は paceSlow を渡さない（K5）
  if (typeof opts.paceSlow === 'function' && opts.paceSlow()) {
    engineLog(`文字起こしの経路: ${what} → 遅い PC のため音声を残した（${why}）`);
    const err = new Error('この PC の文字起こしが録音に追いつかないため、音声を残しました');
    err.slowKept = true;
    err.sttRoute = via;
    throw err;
  }
  try {
    if (!(await ensureEngineReady(whisperEng))) {
      const err = new Error(whisperEng.lastError || '文字起こしエンジンが起動していません');
      err.engineMissing = true;
      throw err;
    }
    // 0.12.0 SP-3a（決めたこと 126）: 2つの流れの会議の区間は門を通して1つずつ（待ち時間は transcribeLocal の中で門を通ってから決める）
    const text = opts.gate ? await viaLocalGate(() => transcribeLocal(wav, tail, durationMs, opts)) : await transcribeLocal(wav, tail, durationMs, opts);
    return { text, provider, ...via };
  } catch (e) {
    if (e && typeof e === 'object') e.sttRoute = via;
    // 区間の失敗は番号と符号だけを1行（頭は「文字起こし:」「文字起こしの経路:」にしない。送り直し・知らせ・区間の扱いは変えない）
    if (typeof opts.seg === 'string' && /^s\d+$/.test(opts.seg)) engineLog(`手元の文字起こしの失敗: ${opts.seg}（${localFailCode(e)}）`);
    throw e;
  }
}
// 復旧の前: q.localOnly でなく、クラウドで処理できるなら true（エンジンを起こさない。知らせは出さない）
// 0.9.4 S-4F（持ち主の答え Q14「PC で文字起こし」）: 遅い会議の待ち行列（slow）は、オフラインモードの会議と同じく PC だけで文字起こしする
const recoveryPcOnly = (q) => Boolean(q && (q.localOnly || q.slow));
async function recoveryCloudReady(q) {
  if (!q || recoveryPcOnly(q)) return false;
  try {
    return (await sttRoute(false, { quiet: true })).route === 'cloud';
  } catch (e) {
    engineLog(`文字起こしの経路: 復旧の経路を決められません: ${logReason(e)}`);
    return false;
  }
}
// 手元の whisper の先読み（起動・設定の保存・口述と会議の始め）。経路が手元のときだけ起こす（待たない）。
// 送り先へ届くかは確かめない（net.isOnline() だけで見る。先読みのために外へ通信しない）。クラウドの会議の途中で
// 手元に落ちた区間は、transcribeAuto の ensureEngineReady がその場で起こす（F14・D1）
async function warmWhisper() {
  const r = await chooseSttRoute(false, { quiet: true, probe: false });
  if (r.route !== 'local') return false;
  ensureEngineReady(whisperEng).catch((e) => engineLog(`文字起こしエンジンの先読みに失敗: ${logReason(e)}`));
  return true;
}
// 今の会議の［この会議は PC の中だけ］（第1c回 OL4・RF28）。下書きにも書く（落ちて復旧した会議の送り直しも手元）
// 第1d2回 M-4（OF4・D21・決めたこと 2）: PC の中の文字起こしが使えなくても断らずに受け（断ると音声がクラウドへ送られ続ける）、押した瞬間から
// 何も送らない（押す前に残した区間も: 並べ直し・会議の後の待ち行列・見回りは会議の印を見る）。答えの needsSetup は手元が使えないか（真のときだけ）。準備を選んで
// いない PC では、準備が要ることと仕方を知らせ P1（［オフラインの準備］）で1回伝え、音声を残している帯をその場で B14 にする
function setMeetingLocalOnly(on) {
  if (!meeting) return { ok: false };
  meeting.localOnly = Boolean(on);
  engineLog(`文字起こしの経路: この会議は PC の中だけ: ${meeting.localOnly ? 'on' : 'off'}`);
  // その場で設定の長さへ（次の区間から。手元の whisper を短い区間で細切れにしない。戻すボタンは無い: RF28。第1d回 A-5）
  if (meeting.localOnly) applySegmentLength(meeting, 0, 'local-only');
  writeDraft();
  const needsSetup = !engineValid(whisperEng);
  if (meeting.localOnly && needsSetup && !isOfflineChosen()) {
    noticeOnce(meeting, 'p1', { text: LOCAL_SETUP_NOTICE, action: 'offline' });
    if (meeting.segments.some((s) => s.kept && s.wav)) {
      clearSttProblem(meeting, ...KEPT_CODES.filter((c) => c !== 'kept-local'));
      setSttProblem(meeting, 'kept-local', {});
    }
  }
  // 0.9.3 持ち主の答え D55: 印が付いたことをいつも画面へ送る（パネルの「オフラインモードで始める」では、録音中のページを見せる前に札「オフラインモード中」と
  // 記録の行の「オフライン」が出る。前は準備の無い PC のときだけ送り、ほかは次の区間（オフラインモードは長い区間）まで画面が知らなかった）
  sendToMainWin('meeting:update', meetingStatus());
  // needsSetup は真のときだけ入れる（無ければ偽。手元が使える PC の答えの形は 0.8.0 のまま: stage1c のテストが形を固定している）
  return needsSetup ? { ok: true, localOnly: meeting.localOnly, needsSetup } : { ok: true, localOnly: meeting.localOnly };
}

// ---- ページからの一時停止とスリープ（第1b回 N4c・RF4）
// 録音バーへ流す文はこの2つだけ（利用者の文字も画面から来た値も入れない。録音バーの id と class だけに頼る: overlay.html:111・119・772）。
// 録音バーの［一時停止］は押すたびに止める・再開するの切り替えなので、今の印（#pill の class paused）を見てから押す。
// 同じ文を何回流しても・返事が遅れても逆には動かない（スリープの頼みの返事が復帰より遅れても、頼み直しで再開しない）
const PAUSE_ENSURE_ON = "(() => { const p = document.getElementById('pill'); if (p && !p.classList.contains('paused')) document.getElementById('pauseBtn').click(); })()";
const PAUSE_ENSURE_OFF = "(() => { const p = document.getElementById('pill'); if (p && p.classList.contains('paused')) document.getElementById('pauseBtn').click(); })()";
// 頼んだ印（pauseAsked）を下ろすまでの上限。返事（overlay:pause）が来たら、その時に下ろす
const PAUSE_ASK_MS = 3000;
const RESUME_NOTICE = 'スリープから戻りました。会議の録音は一時停止しています。続けるときは、録音中のページの［再開］を押してください。';
const pauseReply = () => ({ ok: true, pending: Boolean(meeting && meeting.pauseAsked), paused: Boolean(meeting && meeting.paused) });
function clearPauseAsk(m) {
  m.pauseAsked = false;
  if (m.pauseAskTimer) { clearTimeout(m.pauseAskTimer); m.pauseAskTimer = null; }
}
// 録音バーに一時停止（on = true）か再開（false）を頼む。正は録音バーが返す overlay:pause。会議中で、録音バーの今の状態と違い、
// 頼んでいる途中でないときだけ流す（force はスリープから戻ったときの頼み直し: 頼んでいる途中の印に関わらず流す。止める側だけ）
function requestOverlayPause(on, why, force) {
  const m = meeting;
  if (state !== 'meeting' || !m) return Promise.resolve({ ok: false, pending: false, paused: Boolean(m && m.paused) });
  if (m.paused === on || (m.pauseAsked && !force)) return Promise.resolve(pauseReply());
  if (!overlayWin || overlayWin.isDestroyed()) return Promise.resolve({ ok: false, pending: false, paused: m.paused });
  if (on) m.pauseWhy = why;
  clearPauseAsk(m);
  m.pauseAsked = true;
  m.pauseBy = why === 'suspend' ? 'app' : 'button';   // 0.10.0 K-1: 経過のきっかけ（頼んだ側。録音バーで押したら overlay）
  m.pauseAskTimer = setTimeout(() => { m.pauseAskTimer = null; m.pauseAsked = false; }, PAUSE_ASK_MS);
  if (m.pauseAskTimer && typeof m.pauseAskTimer.unref === 'function') m.pauseAskTimer.unref();
  return overlayWin.webContents.executeJavaScript(on ? PAUSE_ENSURE_ON : PAUSE_ENSURE_OFF, true)
    .then(() => (meeting === m ? pauseReply() : { ok: false, pending: false, paused: false }), (e) => {
      // 録音バーが無い・読み込み中。投げずに頼んだ印を下ろす（画面は今の状態のまま）
      clearPauseAsk(m);
      engineLog(`会議: 録音バーに一時停止を頼めませんでした（${logReason(e)}）`);
      return { ok: false, pending: false, paused: Boolean(m.paused) };
    });
}
// スリープから戻って一時停止のまま。再開を促す（知らせ R1 はトレイと画面に会議ごとに1回。録音中のページは resumeHint で残す）
function showResumeHint(m) {
  m.resumeHint = true;
  if (m.notified instanceof Set && !m.notified.has('resume')) {
    m.notified.add('resume');
    noticeMainWin(RESUME_NOTICE);
    try { if (tray && typeof tray.displayBalloon === 'function') tray.displayBalloon({ title: APP_TITLE, content: RESUME_NOTICE }); } catch (_) { /* Windows の外には無い */ }
  }
  sendToMainWin('meeting:update', meetingStatus());
}
// スリープの合図（書き出しの受け口の後ろに付ける）。会議中で止めていなければ、一時停止として頼む
function pauseForSuspend() {
  if (state !== 'meeting' || !meeting || meeting.paused) return;
  meeting.pauseWhy = 'suspend';
  meeting.suspendAsked = true;
  engineLog('会議: スリープで一時停止を頼んだ');
  requestOverlayPause(true, 'suspend');
}
// 復帰の合図。自動では再開しない（スリープの道からは PAUSE_ENSURE_OFF を決して流さない: 設計書 RF4「再開を促す」）。
// 止まっていれば再開を促し、止まっていなければ（眠る前に届かなかったか、返事がまだ）止める側の文を流し直し、R1 は返事が来てから出す
function promptAfterResume() {
  const m = meeting;
  if (!m || !m.suspendAsked) return;
  m.suspendAsked = false;
  if (state !== 'meeting') return;
  if (m.paused) { showResumeHint(m); return; }
  engineLog('会議: 復帰したが一時停止になっていないので頼み直した');
  m.hintOnPause = true;
  requestOverlayPause(true, 'suspend', true);
}
// 会議の始めに経路を1回聞き、クラウドなら L1（トレイの知らせと画面）。ログインしていない（L2）・届かない（L4・L5）・hold（L6・L7）は sttRoute が出す
function announceSttRoute(m) {
  // 第1d2回 M-2: 準備を選んでいない PC でクラウドが使えそうにない会議は、始めに K1（つながると OpenAI に送る）か K2（ログインが要る）。経路は聞かない
  if (m.keepAtStart) {
    if (m.localOnly) return;
    if (m.keepAtStart === 'login') noticeOnce(m, 'k2', { text: KEPT_NOTICE.k2, action: 'signin' });
    else announceK1(m);
    return;
  }
  sttRoute(Boolean(m.localOnly), { scope: m }).then((r) => {
    // 確かめの返事（最大 3 秒）を待つ間に［PC の中だけ］が押された・会議が終わったなら、送ると知らせない
    if (r.route !== 'cloud' || m.localOnly || meeting !== m) return;
    const text = STT_NOTICE.cloud(r.provider);
    if (!noticeOnce(m, 'cloud', text)) return;
    try { if (tray && typeof tray.displayBalloon === 'function') tray.displayBalloon({ title: APP_TITLE, content: text }); } catch (_) { /* Windows の外には無い */ }
  }).catch((e) => engineLog(`文字起こしの経路: 会議の始めの経路を決められません: ${logReason(e)}`));
}
// K1（第1d2回 M-2）: 左下とトレイの吹き出し（L1 と同じ）。会議ごとに1回
function announceK1(m) {
  if (!noticeOnce(m, 'k1', KEPT_NOTICE.k1)) return;
  try { if (tray && typeof tray.displayBalloon === 'function') tray.displayBalloon({ title: APP_TITLE, content: KEPT_NOTICE.k1 }); } catch (_) { /* Windows の外には無い */ }
}
// 音声を残し始めた（第1d2回 M-2）: 会議ごとに1回（決めたこと 8）。まだ L1・K1・K2 のどれも出していなければ、後で OpenAI に送ることを
// 先に知らせる K1（ログインが要る理由なら K2。決めたこと 13・RF28）。L1 だけを出した会議（クラウドで文字起こししていた）は、途中の中継は K3、
// 途中のログイン切れ（login・ログアウト）は K4（［ログインし直す］）。K1・K2 を出した会議は、もう残していると伝えたので重ねない
// （ログイン切れの K4 だけは、行動が要るので出す）。PC の中だけの会議は M-4 の P1
function noticeKept(m, why) {
  if (m.localOnly) return;
  const login = why === 'signed-out' || why === 'login';
  const keptTold = m.notified.has('k1') || m.notified.has('k2');
  if (!keptTold && !m.notified.has('cloud')) {
    if (login) noticeOnce(m, 'k2', { text: KEPT_NOTICE.k2, action: 'signin' });
    else announceK1(m);
    return;
  }
  if (why === 'login' || (why === 'signed-out' && !keptTold)) noticeOnce(m, 'k4', { text: KEPT_NOTICE.k4, action: 'account' });
  else if (!login && !keptTold && why !== 'key-unreadable') noticeOnce(m, 'k3', KEPT_NOTICE.k3);
}
// PC の文字起こしへの要求の失敗を、利用者に見せる一文にする（英語の "fetch failed" や時間切れの文をそのまま出さない）。
// 0.9.4 S-2（決めたこと 18）: 時間切れ（late）を「エンジンにつながりませんでした」と出さない。届かない（down）と分ける
function localErrorText(e, { resent = false } = {}) {
  const kind = lib.localFailKind(e);
  if (kind === 'late') return 'PC の文字起こしが時間内に終わりませんでした';
  if (kind === 'down') return resent ? 'PC の文字起こしエンジンとの接続が切れました' : 'PC の文字起こしエンジンにつながりませんでした';
  return (e && e.message) || '不明なエラー';
}
// 起動テストの仕上げ。/health に応えても、文字起こしができるとは限らない（古いビルドは
// /inference で WAV を読めないと 200 のまま {"error"} を返す）。2 秒の無音を実際に送り、
// 返事が JSON で、error を含まないことまで見る。問題があれば利用者向けの一文、無ければ ''
async function probeInference() {
  const form = new FormData();
  form.append('file', new Blob([silentWav(2)], { type: 'audio/wav' }), 'probe.wav');
  form.append('response_format', 'json');
  form.append('temperature', '0.0');
  form.append('no_context', 'true');
  if (settings.language && settings.language !== 'auto') form.append('language', settings.language);
  touchEngine(whisperEng);
  try {
    const res = await localhttp.postInference({ port: settings.localPort, form, timeoutMs: 120000 });
    let data = null;
    try { data = JSON.parse(res.body); } catch (_) { /* 下で扱う */ }
    if (!(res.status >= 200 && res.status <= 299)) return `文字起こしを試せませんでした（${res.status}${data?.error ? `: ${data.error}` : ''}）`;
    if (!data || typeof data !== 'object') return '文字起こしエンジンの返事を読めませんでした';
    if (data.error) return `文字起こしを試せませんでした: ${data.error}`;
    return '';
  } catch (e) {
    return `文字起こしを試せませんでした: ${localErrorText(e)}`;
  } finally {
    touchEngine(whisperEng);
  }
}
// whisper の文から、無音・音楽などの印を外して 1 行にする
// 0.12.0 SP-3b: whisper の文1つに区間の文と同じ直し（cleanWhisperText と、設定がオンならつなぎ言葉の除き）をかける（partsOf が区間の文の中を探す）
function cleanSentence(raw) {
  const t = cleanWhisperText(raw);
  return settings.removeFillers ? removeFillersRule(t) : t;
}
function cleanWhisperText(raw) {
  return String(raw || '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, (m) => (/BLANK|MUSIC|音楽|拍手/i.test(m) ? '' : m))
    .replace(/\n+/g, '').trim();
}

// 議事録を作る役割の文（手元の llama の system と、Claude Code の --system-prompt で同じ文を使う。F9）
const MINUTES_SYS = 'あなたは議事録作成の専門家です。会議の文字起こしを分析し、正確で実用的な議事録を日本語のMarkdownで作成します。'
  + '文体は報告文書の常体（だ・である調、体言止め）で、「です・ます」は使いません。'
  + '文字起こしに無い情報を創作せず、雑談は省いてください。';
// オンラインの要約（第1c回 OL5・D1）。Anthropic へ届くかの確かめに使う URL（何かの返事があれば届く: online.js）
const ANTHROPIC_REACH = 'https://api.anthropic.com/';
// Claude Code の作業フォルダ。NaTsu が作る空のフォルダで、NaTsu は中に何も書かない（利用者のフォルダの CLAUDE.md などを読ませない: RF31）
function claudeRunDir() {
  const dir = path.join(app.getPath('userData'), 'claude-run');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
// 利用者の Claude Code で要約する（探す → auth status で claude.ai を確かめる → -p。文字起こしは標準入力）。
// 指示文は手元の1回で要約する頼みと同じ（mainlib.buildClaudeInput。F9）。失敗は平易な文（claudeMessage）を投げ、
// doRunSummary の catch が要約の欄に書く（手元の llama へは行かない: D1）。engine.log には符号だけを書く（本文・利用者の環境は書かない）。
// 進み具合の文（「Claude Code で議事録を作成中…」）は doRunSummary が出す（claude -p は1回で返し、途中の段が無い）。
// 投げる誤りには符号（claudeCode）を添える（doRunSummary が、待てば直る混み合いなら要約待ちに戻す: 0.10.0 LS-2・決めたこと 105）
async function summarizeWithClaude(plain, memo, template) {
  const failWith = (r) => {
    // 符号と、-p の返事の副型・状態の番号だけ（claudeCli.runWhy。返事の文と本文は書かない: 第1b回の続き Lane F-a）
    engineLog(`要約: Claude Code → ${claudeCli.runWhy(r)}`);
    const e = new Error(claudeCli.claudeMessage(r));
    e.claudeCode = r && typeof r.code === 'string' ? r.code : '';
    throw e;
  };
  const found = claudeCli.findClaude({ configured: settings.claudeExe });
  if (!found.ok) failWith(found);
  let cwd;
  try { cwd = claudeRunDir(); } catch (e) { engineLog(`要約: Claude Code の作業フォルダを作れません: ${logReason(e)}`); failWith({ code: 'failed' }); }
  const auth = await claudeCli.claudeAuthStatus({ cmd: found.cmd, spawn, cwd });
  if (!auth.ok) failWith(auth);
  const memoText = String(memo || '').trim().slice(0, MEMO_MAX);
  const input = lib.buildClaudeInput({ memoText, plain, template });
  const r = await claudeCli.claudeSummarize({ cmd: found.cmd, spawn, cwd, input, systemPrompt: MINUTES_SYS });
  if (!r.ok) failWith(r);
  engineLog('要約: Claude Code → ok');
  return { md: r.text, truncatedParts: [], finalTruncated: false };
}

// ---------------------------------------------------------------- 要約
// 0.11.0 Q-3: 打ち合わせの質の注（要約の欄の summaryError の行として足す）
const QUALITY_NOTE_UNREAD = 'この要約には打ち合わせの質の点を付けていません（AI の答えの形を読み取れなかったため）。要約はそのまま使えます。［要約を再生成］でもう一度付けられます。';
const QUALITY_NOTE_SHORT = '文字起こしが短いため、打ち合わせの質の点は付けていません。';
// 0.10.0 LS-2（D59）: 要約は利用者の Claude Code だけ（summarizeWithClaude）。手元の llama の要約（llmChat・generateMinutes）は外した
// 0.11.0 M-2（決めたこと 14）: 要約の書式（型の見出し・決まり・締め・次に気をつけること・OUTPUT_RULE）は memoTypes.buildTemplate の1か所。
// doRunSummary が1回だけ作り、Claude Code に渡す文と、写しを落とす文（dropTemplateEcho）の両方に同じ文字列を渡す（別々に組み立てるとずれる）

// ---------------------------------------------------------------- 貼り付け
function ensurePaster() {
  if (process.platform !== 'win32') return null;
  if (pasterProc && pasterProc.stdin && pasterProc.stdin.writable) return pasterProc;
  // 貼り付け（paste / paste <hwnd>）、前面の問い合わせ（fg）、除外書式付きの置き直し（copy）を
  // 受ける（mainlib.pasterScript）。応答は標準出力に 1 行ずつ、命令を送った順に返る
  const script = pasterScript();
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    pasterProc = p;
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const r = parsePasterLine(line);
        if (!r) continue;   // エラー文などは応答ではない
        const w = pasterWaiters.shift();
        if (w) w.resolve(r);
      }
    });
    const gone = () => {
      if (pasterProc === p) pasterProc = null;
      while (pasterWaiters.length) { const w = pasterWaiters.shift(); w.resolve(null); }
    };
    p.on('exit', gone);
    p.on('error', gone);
  } catch (_) { pasterProc = null; }
  return pasterProc;
}
// 常駐 PowerShell に命令を 1 行送り、応答（parsePasterLine の結果）を待つ。常駐が居ない・
// 時間切れ・居なくなった、は null
function askPaster(cmd, timeoutMs) {
  const p = ensurePaster();
  if (!p || !p.stdin || !p.stdin.writable) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const w = { resolve: (r) => { if (done) return; done = true; const i = pasterWaiters.indexOf(w); if (i >= 0) pasterWaiters.splice(i, 1); resolve(r); } };
    pasterWaiters.push(w);
    setTimeout(() => w.resolve(null), timeoutMs);
    try { p.stdin.write(`${cmd}\n`); } catch (_) { w.resolve(null); }
  });
}
// トレイの「終了」も、閉じるボタンと同じく記録中・要約中は確かめる（mainlib.closeConfirm）。
// トレイからは会議の状態が見えないので、閉じるボタンより間違えやすい
function quitFromTray() {
  const confirm = closeConfirm(state === 'meeting' || state === 'meeting-finalizing', isSummarizing(), finalizingPageIds.size > 0);
  if (confirm) {
    const r = dialog.showMessageBoxSync({
      title: APP_TITLE, type: 'warning', buttons: ['終了する', 'キャンセル'], defaultId: 1, cancelId: 1,
      message: confirm.message, detail: confirm.detail,
    });
    if (r !== 0) return;
  }
  quitting = true;
  app.quit();
}
function stopPaster() {
  if (pasterProc) { try { pasterProc.stdin.end(); pasterProc.kill(); } catch (_) { /* noop */ } pasterProc = null; }
}
// Ctrl+V を送る。戻り値は 'ok' | 'mismatch'（前面が hwnd と違うので貼らなかった）| 'fail' |
// 'unknown'（確かめる手段が無い。従来どおり貼れたものとして扱う）
function simulatePaste(hwnd) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const p = ensurePaster();
      if (p && p.stdin.writable) {
        askPaster(hwnd ? `paste ${hwnd}` : 'paste', PASTE_REPLY_MS).then((r) => resolve(r && r.kind !== 'hwnd' ? r.kind : 'unknown'));
        return;
      }
      execFile('powershell.exe', ['-NoProfile', '-STA', '-NonInteractive', '-Command',
        "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"],
      { windowsHide: true }, (err) => resolve(err ? 'fail' : 'ok'));
    } else if (process.platform === 'darwin') {
      execFile('osascript', ['-e', 'tell application "System Events" to keystroke "v" using command down'], () => resolve('unknown'));
    } else {
      execFile('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], () => resolve('unknown'));
    }
  });
}
// クリップボードへ書く唯一の入口（#27）。Windows では常駐 PowerShell に頼んで、クリップボード
// 履歴（Win+V）とクラウド同期から除外する書式を付けて置く（書式は mainlib.pasterScript）。
// 置けたことをクリップボードを読み返して確かめ、置けていなければ（PowerShell が居ない・
// まだ起動中・失敗）Electron の clipboard で書く（履歴には入るが、何も残らないよりはよい）。
// 先に Electron で書くと、その最初の書き込みが履歴とクラウド同期に採られる。除外の印は
// 後から置き直しても、採られた分は消えない。'paste' と同じ標準入力に順に流すので、
// 置き直しが貼り付けより後になることはない。
// 本体は mainlib へ移した（第0c回 EL1。実行テストは clipboard.test.js）。ここは clipboard と常駐 PowerShell と時計を渡すだけ。
// 常駐 PowerShell の口（呼ぶたびに今の口を返す。居なければ null）
function pasterPort() {
  const p = process.platform === 'win32' ? ensurePaster() : null;
  if (!p || !p.stdin) return null;
  return { writable: () => Boolean(p.stdin && p.stdin.writable), write: (line) => p.stdin.write(line) };
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
function clipDeps() {
  return { clip: clipboard, paster: pasterPort, sleep: sleepMs, autoPaste: Boolean(settings.autoPaste), fg: dictationFg,
    simulatePaste, notice: (m) => sendToMainWin('app:notice', m), later: setTimeout };
}
// クリップボードへ書く唯一の入口（#27）。中身は mainlib.copyPrivate（44 では clipboard が Promise を返すので、全部待つ）
const copyPrivate = (text) => lib.copyPrivate(text, clipDeps());
const deliverText = (text) => lib.deliverText(text, clipDeps());

// ---------------------------------------------------------------- 会議の検出の見張り（0.9.3 M-2。計画 docs/plans/2026-10-22-093.md の決めたこと 3・4・12・13）
// Windows の「マイクを使っているアプリ」の記録を 2 秒ごとに読む常駐の PowerShell（mainlib.micWatchScript）。貼り付け係の PowerShell とは別のプロセス（K1）。
// 起こすのは Windows・設定「会議の検出の通知」がオン・録音していない（state が idle）ときだけ。録音が始まったら・設定を切ったら・終了で止める。
// 落ちたら MIC_RETRY_MS の後に起こし直し、それでも落ちたら次の起動か設定のオンオフまで起こさない。記録（engine.log）にはアプリの名前も id も
// 書かない（始めた・止めた・読めない符号・起こし直しだけ: K3）。NATSU_TEST_MIC_WATCH は試し用（テストの台が偽の見張りを返す。Windows の外でも起こす）
const MIC_RETRY_MS = [30000, 120000, 600000];
let micProc = null;
let micBuf = '';
let micFails = 0;
let micRetryTimer = null;
let micGaveUp = false;
let detectReady = false;   // 起動の窓とトレイができるまでは起こさない
let detectBusy = null;     // 会議の検出に最後に知らせた忙しさ（state の写し）
const micWatchSupported = () => process.platform === 'win32' || process.env.NATSU_TEST_MIC_WATCH === '1';
const micWatchWanted = () => detectReady && micWatchSupported() && !quitting && settings.meetingDetect !== false && state === 'idle' && !micGaveUp;
// 0.12.1 LV-2（計画 docs/plans/2026-10-24-121.md の決めたこと L16）: 設定「会議を出たら自動で止める」がオンなら、議事録の録音中（作成中も。録音の終わりで
// 起こし直さない）も読む。音声入力（recording・processing）の間は今どおり止める。上の micWatchWanted の行は変えない（0.9.3 の変異の from）
const micLeaveWanted = () => detectReady && micWatchSupported() && !quitting && settings.autoStopLeave !== false && (state === 'meeting' || state === 'meeting-finalizing') && !micGaveUp;
function syncMicWatch() {
  if (micWatchWanted() || micLeaveWanted()) startMicWatch();
  else stopMicWatch();
}
function startMicWatch() {
  if (micProc || micRetryTimer) return;
  const script = lib.micWatchScript({ self: process.execPath, parent: process.pid });
  let p = null;
  try {
    p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    engineLog(`会議の検出: 見張りを起こせません（${errCode(e)}）`);
    onMicWatchGone();
    return;
  }
  micProc = p;
  micBuf = '';
  micCount = null;
  engineLog('会議の検出: 見張りを始めた');
  p.stdout.on('data', (d) => {
    micBuf += d.toString();
    let i;
    while ((i = micBuf.indexOf('\n')) >= 0) {
      const line = micBuf.slice(0, i);
      micBuf = micBuf.slice(i + 1);
      onMicLine(line);
    }
    if (micBuf.length > 8192) micBuf = '';   // 改行の無い長い出力は読まない
  });
  const gone = () => { if (micProc !== p) return; micProc = null; onMicWatchGone(); };
  p.on('exit', gone);
  p.on('error', gone);
}
function stopMicWatch() {
  if (micRetryTimer) { clearTimeout(micRetryTimer); micRetryTimer = null; }
  if (!micProc) return;
  const p = micProc;
  micProc = null;   // 先に外す（止めた見張りの exit を「落ちた」と数えない）
  try { p.kill(); } catch (_) { /* noop */ }
  engineLog('会議の検出: 見張りを止めた');
}
// 見張りが思わず終わった（止めたのではない）
function onMicWatchGone() {
  leaveEvent({ type: 'lost' });   // 0.12.1 LV-2（決めたこと L7）: 見張りが落ちたら、会議を出たかの数えを戻す
  micFails += 1;
  if (micFails > MIC_RETRY_MS.length) {
    micGaveUp = true;
    engineLog('会議の検出: 見張りが続けて落ちたので、次の起動か設定のオンオフまで起こしません');
    return;
  }
  const ms = MIC_RETRY_MS[micFails - 1];
  engineLog(`会議の検出: 見張りが落ちたので ${ms / 1000} 秒後に起こし直します`);
  micRetryTimer = setTimeout(restartMicWatch, ms);
}
function restartMicWatch() {
  micRetryTimer = null;
  syncMicWatch();
}
// 見張りの1行（mainlib.parseMicLine で読む。一覧に無いもの・形の悪い行は捨てる）
function onMicLine(line) {
  const r = lib.parseMicLine(line);
  if (!r) return;
  if (r.kind === 'err') { engineLog(`会議の検出: マイクの記録を読めません（${r.code}）`); leaveEvent({ type: 'lost' }); return; }
  micFails = 0;
  // 0.9.4 D-1（診断の記録）: 一覧のアプリでマイクを使っている数が変わったときだけ1行（名前は書かない: 0.9.3 の K3）
  if (r.items.length !== micCount) { micCount = r.items.length; engineLog(`会議の検出: マイクの記録 ${micCount} 件`); }
  nudgeEvent({ type: 'sample', items: r.items });
  noteFinalizingUses();   // 0.12.1 点検の直し 1
  leaveEvent({ type: 'sample', items: r.items });   // 0.12.1 LV-2: 議事録の録音中だけ（leaveEvent が照らす）
}
// 会議の検出の判断（mainlib.nudgeStep）。答えのとおりにパネルの窓を出し入れするだけ（判断は純粋な関数）
let nudgeSt = lib.nudgeInit({ on: true, mute: [] });
let micCount = null;     // 0.9.4 D-1: 最後に記録に書いたマイクの記録の数
let nudgeWhyLast = '';   // 0.9.4 D-1: 最後に記録に書いた「出さない」の理由の符号（mainlib.nudgeWhy）
function nudgeEvent(ev) {
  const o = lib.nudgeStep(nudgeSt, { ...ev, now: Date.now() });
  nudgeSt = o.st;
  // 0.9.4 D-1（診断の記録）: 一覧のアプリがマイクを使っているのに出さない理由が変わったときだけ1行（wait・done・mute・busy・off・rejoin）
  if ((o.why || '') !== nudgeWhyLast) { nudgeWhyLast = o.why || ''; if (nudgeWhyLast) engineLog(`会議の検出: 出さない（${nudgeWhyLast}）`); }
  if (o.hide) hideNudge(ev.type);
  if (o.show) showNudge(o.show);
  return o;
}

// ---------------------------------------------------------------- 会議を出たら止める（0.12.1 LV-2・LV-3。計画 docs/plans/2026-10-24-121.md の決めたこと L1〜L21）
// 見張りの読み（2 秒ごとの行）を、議事録の録音中だけ meetleave.leaveStep に渡す（main に新しいタイマーを作らない: L6）。答えの act のとおりに、
// 決まった1行を記録する（アプリの名前・id は書かない: K3）。止めるのは LV-3
const LEAVE_LOG = Object.freeze({
  found: '会議を出たかの見張り: 会議のアプリがマイクを使っているのを見た（この録音で見張る）',
  stop: '会議を出たかの見張り: 会議のアプリがマイクを放したので、録音を止めた',
  blip: '会議を出たかの見張り: 少しだけ放して見えたので止めない',
  lost: '会議を出たかの見張り: 見張りの記録が読めないので数え直す',
  gap: '会議を出たかの見張り: 見張りの読みが途切れたので数え直す',
  notice: '会議を出たかの見張り: Windows の知らせ',
  noNotice: '会議を出たかの見張り: Windows の知らせを出せない',
});
// 録音を始めた（startMeetingBy）: 会議を出たかの判断の状態（会議ごとのメモリだけ。下書き・ページに書かない: L17）。パネルから始めたなら、そのアプリを
// 初めから見張る（L3）。leaveAt: 放した最初の読みの時刻（所要時間の終わり）・leaveStopped: 会議を出たので止めた・leaveOthers: 放した読みで見えた別のアプリの使い
function leaveStart(m, app) {
  m.leave = ML.leaveInit({ apps: ML.LEAVE_IDS, first: typeof app === 'string' ? app : null, off: settings.autoStopLeave === false });
  m.leaveAt = null; m.leaveStopped = false; m.leaveOthers = [];
  if (m.leave.phase === 'in') engineLog(LEAVE_LOG.found);
}
// 作成中（止めた後）も読みを渡し続け、止めるかは stopByLeave の1か所が決める（Ruling R6）。記録は録音中だけ
function leaveEvent(ev) {
  const m = meeting;
  if (!m || !m.leave) return null;
  const r = ML.leaveStep(m.leave, { ...ev, now: Date.now() });
  m.leave = r.st;
  if (r.act === 'stop') { stopByLeave(m, r.goneAt, r.others); return r; }
  if (state !== 'meeting') return r;
  if (r.act === 'found') engineLog(LEAVE_LOG.found);
  else if (r.act === 'blip') engineLog(LEAVE_LOG.blip);
  // 数え直し: 見張りの記録が読めない・見張りが落ちた（lost）・読みが途切れた（sample）。一時停止・設定で戻したときは書かない（R6）
  else if (r.act === 'reset' && (ev.type === 'lost' || ev.type === 'sample')) engineLog(ev.type === 'lost' ? LEAVE_LOG.lost : LEAVE_LOG.gap);
  return r;
}
// 会議を出たので止める（L10）: 録音中で止めていないときだけ、今の1つの道（stopMeetingBy）に auto-leave を渡す。本当に止めたときだけ LN4 を1回（L11）。
// 0.9.1 の autoStopped は付けない（quietDoneNotice を出さない: L12）。所要時間の終わりは放した最初の読みの時刻（L13）
let leaveForget = null;   // 会議を出て止めた会議の、放した読みで見えた別のアプリの使い（idle に戻ったらパネルの判断の印を外す: L18）
// 0.12.1 点検の直し 1: 0.9.3 は録音中と作成中に見張りを止めていたので、作成中に始まった会議の使いは idle で初めて見えてパネルになった。見張りを動かしたままに
// した 0.12.1 では、作成中の読みが「録った会議」の印を付けてしまうので、作成中に新しく見えた使い（finalNew）を覚えて idle で外す。作成中に入った時に使っていた
// 使い（finalBase。録音中に始まった使い）は今どおり出さない。つなぎ直し（0.9.3 の 60 秒）の印が付いた使いは外さない（R3）
let finalBase = null;
let finalNew = new Set();
const activeUseKeys = () => Object.entries(nudgeSt.active || {}).map(([id, start]) => `${id}:${start}`);
function noteFinalizingUses() {
  if (state !== 'meeting-finalizing' || !finalBase) return;
  for (const k of activeUseKeys()) if (!finalBase.has(k)) finalNew.add(k);
}
function idleForget() {
  const rejoin = Array.isArray(nudgeSt.rejoin) ? nudgeSt.rejoin : [];
  const late = [...finalNew].filter((k) => !rejoin.includes(k));
  const keys = [...new Set([...(leaveForget || []), ...late])];
  leaveForget = null; finalBase = null; finalNew = new Set();
  if (keys.length) nudgeEvent({ type: 'forget', keys });
}
let leaveNotice = null;   // 出した LN4（消えないように持つ）
function stopByLeave(m, goneAt, others) {
  if (meeting !== m || state !== 'meeting') return;
  engineLog(LEAVE_LOG.stop);
  m.leaveStopped = true;
  m.leaveAt = Number.isFinite(goneAt) ? goneAt : null;
  m.leaveOthers = Array.isArray(others) ? others.slice() : [];
  leaveForget = m.leaveOthers.length ? m.leaveOthers.slice() : null;
  const r = stopMeetingBy('auto-leave');
  if (r && r.ok) leaveStopNotice(m);
}
// 止めた直後の Windows の知らせ LN4（窓が前にあってもなくても1回: LQ13）。押すと、作成中なら録音中のページ、保存した後ならそのページ（main が覚えた会議から決める）
const LEAVE_NOTICE_TEXT = '会議を出たので録音を止めました。議事録を作っています。';
function leaveStopNotice(m) {
  let shown = false;
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: APP_TITLE, body: LEAVE_NOTICE_TEXT });
      n.on('click', () => leaveNoticeClick(m));
      n.show();
      leaveNotice = n;
      shown = true;
    }
  } catch (_) { /* 知らせが壊れていても、止めたことは続ける（記録だけ） */ shown = false; }
  engineLog(shown ? LEAVE_LOG.notice : LEAVE_LOG.noNotice);
}
function leaveNoticeClick(m) {
  if (meeting === m) { showLiveFromNotice(); return; }
  createMainWindow();
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  if (m.leavePageId) sendToMainWin('page:open', m.leavePageId);
}

// ---------------------------------------------------------------- 会議の検出のパネル（0.9.3 M-3。決めたこと 7〜10。持ち主の答え Q3・Q5）
// 録音バーと同じ作りの小さな透過の窓（nudge.html）。初めて出すときに作り、使い回す。出すのは showInactive だけ（会議のアプリの入力を奪わない）・
// 画面の共有と録画に写らない（setContentProtection: K4）・いつも前。置き場所は出す時のカーソルの画面の右上（mainlib.nudgeBounds）。
// 明暗は Windows の明暗（nativeTheme.shouldUseDarkColors。NaTsu の外観で明るい・暗いを選んでいればそれ）で、出している間に変われば送り直す（Q3）
let nudgeWin = null;
let nudgeShown = null;       // 出しているアプリ { id, label }（パネルの押した口はこれだけを使う。画面から id を受けない: M7）
let nudgeSize = null;        // パネルの画面が測った大きさ { w, h }
let nudgeDisplayId = null;   // 出している画面（出している間はカーソルを動かしても飛ばない）
let nudgeTicker = null;
const NUDGE_TICK_MS = 1000;
const nudgeTheme = () => { try { return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'; } catch (_) { return 'dark'; } };
function createNudge() {
  const first = lib.nudgeBounds({ size: null, workArea: screen.getPrimaryDisplay().workArea });
  nudgeWin = new BrowserWindow({
    width: first.width, height: first.height,
    frame: false, transparent: true, resizable: false, movable: false,
    minimizable: false, maximizable: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
    // 録音バーと同じく backgroundThrottling: false を入れてはいけない（透過が壊れる: 地雷の台帳）
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  nudgeWin.setAlwaysOnTop(true, 'screen-saver');
  nudgeWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  nudgeWin.setContentProtection(true);
  nudgeWin.loadFile(path.join(__dirname, 'renderer', 'nudge.html'));
  nudgeWin.on('closed', () => { nudgeWin = null; nudgeShown = null; stopNudgeTicker(); });
}
function sendToNudge(ch, p) {
  if (!nudgeWin || nudgeWin.isDestroyed()) return;
  const wc = nudgeWin.webContents;
  if (wc.isLoading()) wc.once('did-finish-load', () => { if (nudgeWin && !nudgeWin.isDestroyed()) nudgeWin.webContents.send(ch, p); });
  else wc.send(ch, p);
}
function placeNudge() {
  if (!nudgeWin || nudgeWin.isDestroyed()) return;
  let d = nudgeDisplayId == null ? null : screen.getAllDisplays().find((x) => x.id === nudgeDisplayId);
  if (!d) { d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); nudgeDisplayId = d.id; }
  nudgeWin.setBounds(lib.nudgeBounds({ size: nudgeSize, workArea: d.workArea }));
}
function showNudge(app) {
  if (!nudgeWin || nudgeWin.isDestroyed()) createNudge();
  nudgeShown = { id: app.id, label: app.label };
  nudgeDisplayId = null;
  sendToNudge('nudge:show', { label: app.label, theme: nudgeTheme() });
  placeNudge();
  nudgeWin.showInactive();
  if (!nudgeTicker) nudgeTicker = setInterval(nudgeTick, NUDGE_TICK_MS);
  engineLog('会議の検出: パネルを出した');   // アプリの名前は書かない（K3）
}
function hideNudge(why) {
  if (!nudgeShown) return;
  nudgeShown = null;
  stopNudgeTicker();
  if (nudgeWin && !nudgeWin.isDestroyed()) nudgeWin.hide();
  engineLog(`会議の検出: パネルを引っ込めた（${why}）`);
}
function nudgeTick() { nudgeEvent({ type: 'tick' }); }
function stopNudgeTicker() { if (nudgeTicker) { clearInterval(nudgeTicker); nudgeTicker = null; } }
// パネルの［文字起こしを始める］・「オフラインモードで始める」（Q5）: 出していて idle のときだけ。引っ込めてから今の［新しい議事録］と同じに始め
// （会議の種類は自動のまま: D50）、始められたら本体の窓を前に出して録音中のページを見せる（トレイに隠した窓も出す）。オフラインモードなら印を付ける
async function startFromNudge(o) {
  if (!nudgeShown || state !== 'idle') return { ok: false };
  const pcOnly = Boolean(o && typeof o === 'object' && o.pcOnly === true);
  const app = nudgeShown.id;   // 0.12.1 LV-2（決めたこと L3）: 引っ込める前に、出していたアプリを写す（画面から id を受けない）
  nudgeEvent({ type: 'closed' });
  const r = await startMeetingBy(pcOnly ? 'panel-offline' : 'panel', { app });
  if (!r.ok) {
    createMainWindow();
    sendToMainWin('app:notice', r.error || '議事録を開始できません');
    return { ok: false };
  }
  if (pcOnly) setMeetingLocalOnly(true);
  showLiveFromNotice();
  return { ok: true, localOnly: pcOnly };
}
// 「<アプリ> では出さない」: 画面の引数は読まず、今出しているアプリの id を通知を出さないアプリに足して保存し、本体の画面の欄にも知らせる（M7）
function muteFromNudge() {
  if (!nudgeShown) return;
  const id = nudgeShown.id;
  const mute = Array.isArray(settings.meetingDetectMute) ? settings.meetingDetectMute.filter((x) => x !== id) : [];
  settings.meetingDetectMute = [...mute, id];
  const w = settingsWriter.now(settings);
  if (!w.ok) engineLog(`会議の検出: 通知を出さないアプリを保存できませんでした（${errCode(w.error)}）`);
  sendToMainWin('settings:patched', { meetingDetectMute: settings.meetingDetectMute.slice() });
  nudgeEvent({ type: 'setting', on: settings.meetingDetect !== false, mute: settings.meetingDetectMute });
}
// 「会議の検出の通知の設定…」: 引っ込めて本体の窓を出し、［設定］→［録音］の「会議の検出」のカードを開く
function settingsFromNudge() {
  if (!nudgeShown) return;
  nudgeEvent({ type: 'closed' });
  createMainWindow();
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  const p = { sec: 'record', row: '会議の検出の通知' };
  if (mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', () => sendToMainWin('app:open-settings', p));
  else sendToMainWin('app:open-settings', p);
}
// パネルの画面が測った大きさ（CSS の px。有限の正の数でなければ捨てる）。出していれば置き直す
function onNudgeSize(p) {
  if (!p || typeof p !== 'object' || typeof p.w !== 'number' || typeof p.h !== 'number' || !Number.isFinite(p.w) || !Number.isFinite(p.h) || p.w <= 0 || p.h <= 0) return;
  if (nudgeSize && nudgeSize.w === p.w && nudgeSize.h === p.h) return;
  nudgeSize = { w: p.w, h: p.h };
  if (nudgeShown) placeNudge();
}
// Windows の明暗が変わった（出していれば明暗を送り直す: Q3）・画面の配置が変わった（置き直す）・出している画面が外れた（引っ込める）
function onNudgeTheme() { if (nudgeShown) sendToNudge('nudge:show', { label: nudgeShown.label, theme: nudgeTheme() }); }
function onNudgeDisplayChanged() { if (nudgeShown) placeNudge(); }
function onNudgeDisplayRemoved(_e, display) { if (nudgeShown && display && display.id === nudgeDisplayId) nudgeEvent({ type: 'closed' }); }
// 録音の状態が変わった（updateTray から毎回呼ぶ。変わったときだけ判断に知らせ、見張りを起こす・止める）
function noteDetectState() {
  if (!detectReady || state === detectBusy) return;
  detectBusy = state;
  nudgeEvent({ type: 'busy', busy: state !== 'idle', meeting: state === 'meeting' || state === 'meeting-finalizing' });
  // 0.12.1 点検の直し 1: 作成中（止めた後）に入ったら、その時に使っていたアプリの使いを覚える（作成中に新しく始まった使いだけを、idle でパネルに戻すため）
  if (state === 'meeting-finalizing') { finalBase = new Set(activeUseKeys()); finalNew = new Set(); }
  // 0.12.1 LV-3（決めたこと L18）: idle に戻ったら、会議を出て止めた会議の放した読みで見えた別のアプリの使いと、作成中に新しく始まった使いの印を外す
  if (state === 'idle') idleForget();
  syncMicWatch();
}
// 設定の「会議の検出の通知」「通知を出さないアプリ」が変わった。オンにし直したら、落ちて諦めた見張りも起こし直す
function applyDetectSettings(prev) {
  const on = settings.meetingDetect !== false;
  if (prev && prev.meetingDetect === false && on) { micGaveUp = false; micFails = 0; }
  nudgeEvent({ type: 'setting', on, mute: settings.meetingDetectMute });
  syncMicWatch();
}
// 0.12.1 LV-2（決めたこと L9・L16）: 設定「会議を出たら自動で止める」が変わった。録音中なら判断に知らせ（切ったら数えを戻す・入れ直したら次の読みから数える）、見張りを起こす・止める
function applyLeaveSetting() {
  const on = settings.autoStopLeave !== false;
  // 点検の直し 4: 入れ直したら、落ちて諦めた見張りも起こし直す（applyDetectSettings と同じ）
  if (on) { micGaveUp = false; micFails = 0; }
  leaveEvent({ type: 'setting', on });
  syncMicWatch();
}

// ---------------------------------------------------------------- 録音中のページの音の波（0.9.3 M-5。決めたこと 14・22）
// 聞くのは、議事録の録音中（止めている途中でない）・一時停止でない・本体の窓が見えていて最小化していない・録音中のページを開いている（meeting:live-shown）
// ときだけ（前にあることは求めない: 横に会議のアプリを並べて見ている人にも出す）。LEVEL_ASK_MS ごとに録音バーに聞き（隠した録音バーも IPC には答える）、
// 答え（overlay:level）を levelMsg で照らして本体の画面へ送る。見ていないときは聞かない（M9）
let levelTimer = null;
function levelWanted() {
  if (state !== 'meeting' || !meeting || meeting.stopping || meeting.paused) return false;
  if (!mainWin || mainWin.isDestroyed() || !mainWin.isVisible() || mainWin.isMinimized()) return false;
  return liveShownByUi;
}
// 0.12.0 SP-3a（決めたこと 123）: 2つの流れの議事録の間は、録音中のページが見えていなくても聞く（声の切れ目で区間を切るため）。一時停止・止める途中は聞かない
function vadWanted() {
  const m = meeting;
  return Boolean(m && state === 'meeting' && m.two && m.two.sysEver && !m.stopping && !m.paused);
}
function syncLevelAsk() {
  if (levelWanted() || vadWanted()) { if (!levelTimer) levelTimer = setInterval(askLevel, lib.LEVEL_ASK_MS); }
  else if (levelTimer) { clearInterval(levelTimer); levelTimer = null; }
}
function askLevel() {
  if (!levelWanted() && !vadWanted()) { syncLevelAsk(); return; }
  sendToOverlay('overlay:level-ask', {});
}
// 0.12.0 SP-2（決めたこと 123・134）: 録音バーに「この流れ（src）のこの番号（seg）の区間を声の切れ目で切る」と言う
function sendCut(src, seg) {
  sendToOverlay('overlay:cut', { src, seg });
}
// 0.12.0 SP-3a（決めたこと 123・134・135）: level-ask の答えを照らし（checkLevel。壊れていれば数えない）、流れごと・区間ごとに vadStep を回す。
// 切れ目・無音なら、その区間に1回だけ overlay:cut（区切りの側が short で、オフラインモードでない間だけ。PC の側は切らない: 決めたこと 128）
function noteVoice(p) {
  if (!vadWanted()) return;
  const m = meeting;
  const v = lib.checkLevel(p);
  if (!v) return;
  const now = Date.now();
  const cloud = !m.localOnly && m.segMode && m.segMode.mode === 'short';
  for (const [key, seg, level] of [['mic', v.segMic, v.vMic], ['loopback', v.segSys, v.vSys]]) {
    const L = m.two.streams[key];
    if (seg < 0) { L.askAt = 0; continue; }
    let rec = L.vad.get(seg);
    if (!rec) { rec = { st: lib.vadStart(), cut: '' }; L.vad.set(seg, rec); }
    const dtMs = L.askAt && L.askSeg === seg ? now - L.askAt : lib.LEVEL_ASK_MS;
    L.askAt = now; L.askSeg = seg;
    const r = lib.vadStep(rec.st, { voiced: level > lib.VOICE_LEVEL, dtMs });
    rec.st = r.st;
    if (r.cut && !rec.cut && cloud) { rec.cut = r.cut; sendCut(key, seg); }
  }
}
function onOverlayLevel(p) {
  noteVoice(p);   // 0.12.0 SP-3a: 声の切れ目（音の波とは別。見えていなくても数える）
  if (!levelWanted()) return;
  sendToMainWin('meeting:level', lib.levelMsg(p));
}

// ---------------------------------------------------------------- ウィンドウ
function sendToMainWin(ch, p) {
  if (!mainWin || mainWin.isDestroyed()) return;
  // 開いているページを描き直す知らせにも経路の行を添える（要約の後に描き直しても、プロパティの行から消えない。第1c回 OL6）
  mainWin.webContents.send(ch, ch === 'page:updated' && p && p.page ? { ...p, page: pageForView(p.page) } : p);
}
// 画面に渡すページ（第1c回 OL6）: 経路の行（mainlib.routeLabel）を routeText に添えた写し。ページのファイルには書かない。
// 送り先の名前は、そのページを文字起こしした送り先（page.route.stt.provider）のもの（今の設定の送り先ではない）
function pageForView(page) {
  if (!page || typeof page !== 'object') return page;
  const id = page.route && page.route.stt ? page.route.stt.provider : '';
  const preset = typeof id === 'string' && Object.prototype.hasOwnProperty.call(sttCloud.PRESETS, id) ? sttCloud.PRESETS[id] : null;
  // 0.11.0 Q-3（決めたこと 33）: 要約の直後の知らせにも、照らした点（qualityView）を添える（画面は qualityView だけを読む）
  return { ...page, routeText: lib.routeLabel(page.route, preset ? preset.label : ''), qualityView: quality.qualityView(page.quality) };
}
function sendToOverlay(ch, p) {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  // 0.9.0 O-4（RP8）: 録音バーを隠したままでも、エラーの文は出し直してから送る（マイクを開けない・保存できないを見落とさない）
  if (ch === 'overlay:phase' && p && p.phase === 'error' && panelHidden) showPanel();
  overlayWin.webContents.send(ch, p);
}

function createOverlay() {
  // 0.9.0 O-2（RP4）: 初めの大きさは置き場所の形の初めの大きさ（PANEL_FIRST）。大きさは main が setBounds で替える（panelBounds。
  // resizable: false のまま。透明で枠の無い窓なので外と中が同じで、useContentSize は付けない）
  overlayForm = lib.slotForm(settings.pillSlot || 'bottom-center');
  const first = lib.panelBounds({ slot: settings.pillSlot || 'bottom-center', size: null, workArea: screen.getPrimaryDisplay().workArea });
  overlayWin = new BrowserWindow({
    width: first.width, height: first.height,
    frame: false, transparent: true, resizable: false, movable: true,
    minimizable: false, maximizable: false, focusable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
    // backgroundThrottling: false をここに入れてはいけない。Windows では
    // 透過ウィンドウの透明が壊れ、ピルの角の外に不透明の矩形が出る（実機で発生）。
    // タイマーの間引き対策は、間引かれない main 側からの overlay:tick で行う。
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWin.on('closed', () => { overlayWin = null; });
  // 利用者のドラッグ（0.9.0 O-2・RP3・F18）: 自分で動かしていない move を受けたらドラッグの間（panelDragging）にし、OS のドラッグの終わり
  // （moved。Windows・macOS）か、moved の来ない Linux だけ最後の move から PANEL_QUIET_MS で吸い付く（snapOverlay）。位置を決めて動かした
  // （positionOverlay）ときの move・moved は数えない（programmaticMove と、最後に当てた四角と同じ位置か）
  overlayWin.on('move', () => {
    if (!userMovedOverlay()) return;
    panelDragging = true;
    if (panelQuietTimer) clearTimeout(panelQuietTimer);
    panelQuietTimer = lib.snapsOnQuiet(process.platform) ? setTimeout(snapOverlay, lib.PANEL_QUIET_MS) : null;
  });
  overlayWin.on('moved', () => { if (userMovedOverlay()) snapOverlay(); });
}
function userMovedOverlay() {
  if (programmaticMove || !overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return false;
  const [x, y] = overlayWin.getPosition();
  return !(panelLastBounds && panelLastBounds.x === x && panelLastBounds.y === y);
}

// 録音バーの窓の状態（0.9.0 O-2）。overlayForm は今の形（'h'・'v'）、panelSize は録音バーの画面が最後に送ったピルの大きさ（今の形の。
// 形が替われば捨てる）、overlayDisplayId は録音の始めと吸い付きのときだけ決める画面（その録音の間はその画面を使い続ける: カーソルを
// 別の画面へ動かしただけで録音バーが飛ばない。F18）、panelDragging はドラッグの間（置き直さない）
let overlayForm = 'h';
let panelSize = null;
let overlayDisplayId = null;
let panelDragging = false;
let panelQuietTimer = null;
let panelLastBounds = null;
// ドラッグを離したとき: 窓の中心の画面で一番近い置き場所に吸い付き、その画面を録音の画面にし、名前が替われば pillSlot にまとめ書きする
// （第1a回 JS7。前の自由な位置 pillCustom はもう書かない: 前の版が書いた値として残す）
function snapOverlay() {
  if (panelQuietTimer) { clearTimeout(panelQuietTimer); panelQuietTimer = null; }
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const b = overlayWin.getBounds();
  const c = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  const d = screen.getDisplayNearestPoint(c);
  const slot = lib.nearestSlot(c, d.workArea);
  overlayDisplayId = d.id;
  if (slot !== settings.pillSlot) {
    settings.pillSlot = slot;
    settingsWriter.set(settings);
    // 本体の画面の欄（#pillPos）も今の置き場所にする。古いままだと、無関係な自動保存（テーマの近道・試す・取り込みの切り替えも）が
    // 前の置き場所を送り、吸い付きを黙って元に戻す（0.9.0 O-2・O-4 の点検の直し）
    sendToMainWin('settings:patched', { pillSlot: slot });
  }
  panelDragging = false;
  positionOverlay();
}

// 0.9.0 O-1（設計書 D25・RP2・F12）: 前の版の録音バーの位置（pillCustom・pillPos）を、初めの1回だけ一番近い置き場所に直して pillSlot に書く。
// whenReady の中、loadStores の後で、窓と IPC の受け口を作る前に1回だけ呼ぶ。pillPos・pillCustom は消さない（0.8.0 に戻すと前の位置が戻る）。
// 前の値が何も無い（新しく入れた・壊れていて退けた）ときは、既定のままで書かない（起動だけで settings.json を作らない）。設定が読めない
// ときは直さない（読めたら次の起動で直す）。投げない
let pillFromAtLoad = null;
const PILL_OLD_SIZE = { w: 316, h: 72 };   // 0.8.0 の録音バーの窓（pillCustom はその左上）
function migratePillSlot() {
  const from = pillFromAtLoad;
  pillFromAtLoad = null;
  if (!from || settingsState === 'unreadable') return;
  let slot = '';
  let was = '';
  try {
    if (from.point) {
      const c = { x: from.point.x + PILL_OLD_SIZE.w / 2, y: from.point.y + PILL_OLD_SIZE.h / 2 };
      slot = lib.nearestSlot(c, screen.getDisplayNearestPoint(from.point).workArea);
      was = 'pillCustom';
    } else if (from.pos) {
      slot = from.pos;
      was = 'pillPos';
    }
  } catch (e) {
    engineLog(`録音バー: 前の位置を置き場所に直せませんでした（${errCode(e)}）`);
    return;
  }
  if (!slot) return;
  settings.pillSlot = slot;
  const w = settingsWriter.now(settings);
  if (!w.ok) engineLog(`録音バー: 直した置き場所を書けませんでした（${errCode(w.error)}）。次の保存でもう一度書きます`);
  engineLog(`録音バー: 置き場所を ${slot} にした（前の ${was} から）`);
}

// 0.9.0 O-1・O-2（RP1・RP4）: 置き場所の名前（pillSlot）と、録音の画面（overlayDisplayId。無い・外れたらカーソルの画面に決め直す）の
// 作業領域と、最後に受けたピルの大きさで窓の四角を決めて当てる（panelBounds。ピルの端は作業領域の端から 12px）。ドラッグの間は何もしない
// （吸い付きの後に1回で当てる: OS のドラッグと取り合わない）。形が替われば録音バーの画面に overlay:form を送る
function positionOverlay() {
  if (!overlayWin || overlayWin.isDestroyed() || panelDragging) return;
  const slot = settings.pillSlot || 'bottom-center';
  const form = lib.slotForm(slot);
  if (form !== overlayForm) {
    overlayForm = form;
    panelSize = null;   // 前の形の大きさは使わない（新しい形の大きさは録音バーの画面がすぐ送る）
    sendToOverlay('overlay:form', { form });
    syncPanelHover();   // 縦の形になったらカーソルを見始める（横の形になったら見張りが自分で止まる）
  }
  let d = overlayDisplayId == null ? null : screen.getAllDisplays().find((x) => x.id === overlayDisplayId);
  if (!d) { d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()); overlayDisplayId = d.id; }
  const b = lib.panelBounds({ slot, size: panelSize, workArea: d.workArea });
  programmaticMove = true;
  panelLastBounds = b;
  overlayWin.setBounds(b);
  setTimeout(() => { programmaticMove = false; }, 80);
}
// 録音バーのボタンの名前に入れるキー（0.9.0 O-3・RP7）。設定の値でなく実際に登録しているキー（退避中は既定のキー）を画面の書き方で。
// 登録できていない・空なら入れない（名前にキーを付けない）
function panelKeys(which) {
  const keys = { cancel: 'Esc' };
  const stop = lib.keyLabel(activeHotkeys && activeHotkeys[which]);
  if (stop) keys.stop = stop;
  return keys;
}
// 録音の始め: 録音の画面をカーソルの画面に決め直してから置く（ドラッグの途中の印は捨てる）。前の録音で隠していても、次の録音では出す（O-4）
function placeOverlayForRecording() {
  overlayDisplayId = null;
  panelDragging = false;
  if (panelQuietTimer) { clearTimeout(panelQuietTimer); panelQuietTimer = null; }
  panelHidden = false;
  positionOverlay();
  syncPanelHover();
}

// ---------------------------------------------------------------- 録音バーを隠す・出し直す（0.9.0 O-4・設計書 D25・RP8・決めたこと 23）
// 縦の形の × で隠す（録音は録音バーの画面が隠れた窓のまま続ける。区間を切るのは main の 5 秒の overlay:tick なので長さは変わらない）。
// 出し直すのは、録音中のページの［録音バーを出す］（panel:show）・トレイの［録音バーを表示］・エラーの文の前・次の録音の始め。
// 出し直しはフォーカスを取らない（showInactive: 貼り付け先の窓と会議のアプリの入力を替えない）
let panelHidden = false;
const panelRecording = () => state === 'recording' || state === 'meeting';
function hidePanel() {
  if (!panelRecording() || panelHidden || !overlayWin || overlayWin.isDestroyed()) return false;
  panelHidden = true;
  overlayWin.hide();
  syncPanelHover();
  updateTray();
  sendToMainWin('meeting:update', meetingStatus());
  return true;
}
function showPanel() {
  if (!panelHidden) return false;
  panelHidden = false;
  if (overlayWin && !overlayWin.isDestroyed()) {
    positionOverlay();
    overlayWin.showInactive();
  }
  syncPanelHover();
  updateTray();
  sendToMainWin('meeting:update', meetingStatus());
  return true;
}
// 縦の形の × を出すための「カーソルが乗っているか」（ピルはドラッグの領域で、Windows では :hover が来ない: 調べた結果の 37）。
// 縦の形で録音バーが出ている録音中だけ PANEL_HOVER_MS ごとにカーソルを窓の四角と比べ、変わったときだけ overlay:hover を送る。
// 横の形・隠した・録音が終わったら、次の見回りで自分で止まる（送らない）
const PANEL_HOVER_MS = 120;
let panelHoverTimer = null;
let panelHoverIn = false;
const panelHoverWanted = () => overlayForm === 'v' && !panelHidden && panelRecording() && Boolean(overlayWin) && !overlayWin.isDestroyed();
function syncPanelHover() {
  if (panelHoverWanted()) {
    if (!panelHoverTimer) { panelHoverIn = false; panelHoverTimer = setInterval(watchPanelHover, PANEL_HOVER_MS); }
  } else stopPanelHover();
}
function stopPanelHover() {
  if (panelHoverTimer) { clearInterval(panelHoverTimer); panelHoverTimer = null; }
  panelHoverIn = false;
}
function watchPanelHover() {
  if (!panelHoverWanted()) { stopPanelHover(); return; }
  const c = screen.getCursorScreenPoint();
  const b = overlayWin.getBounds();
  const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
  if (inside === panelHoverIn) return;
  panelHoverIn = inside;
  sendToOverlay('overlay:hover', inside);
}
// 画面の拡大率や作業領域が変わった・画面が外れた（録音中だけ置き直す。外れたのが録音の画面ならカーソルの画面で決め直す）
function onDisplayChanged() {
  if (overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible() && state !== 'idle') positionOverlay();
}
function onDisplayRemoved(_e, display) {
  if (display && display.id === overlayDisplayId) overlayDisplayId = null;
  onDisplayChanged();
}
// 録音バーの画面が測ったピルの大きさ（CSS の px。有限の正の数でなければ捨てる。form があれば今の形のものだけ）。同じ大きさなら何もしない
// （置き直し続けない）。ドラッグの間は覚えるだけ（吸い付きの positionOverlay で当てる）
function onPanelSize(p) {
  if (!p || typeof p !== 'object' || !Number.isFinite(p.w) || !Number.isFinite(p.h) || p.w <= 0 || p.h <= 0) return;
  if (p.form !== undefined && p.form !== overlayForm) return;
  if (panelSize && panelSize.w === p.w && panelSize.h === p.h) return;
  panelSize = { w: p.w, h: p.h };
  positionOverlay();
}

// 窓（題名の帯・タスクバー）のアイコン。Windows では ICO を渡す。ICO なら OS が画面に合う大きさを選び、
// 16px・24px では、その大きさで描いた絵（assets/icon.svg から描いたもの。0.11.1 で小さい版はやめた）が出る。
// PNG（256px）を渡すと、それを縮めて使うので、16px で形がぼやける。
// 置き場所は src/assets（中身は assets/icon.ico・icon.png と同じ）。アプリ内の更新は src/ だけを
// 入れ替えるので、src の外に置くと、描き直したアイコンがインストーラーを入れ直すまで届かない
const WINDOW_ICON = path.join(__dirname, 'assets', process.platform === 'win32' ? 'window.ico' : 'window.png');

function createMainWindow() {
  if (mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus(); return; }
  // 覚えた大きさ（照らし済み）。位置は覚えていて今の画面に見えるときだけ渡す（無ければ真ん中: N6・F1）
  const wb = winState.bounds;
  mainWin = new BrowserWindow({
    ...(Number.isInteger(wb.x) && Number.isInteger(wb.y) ? { x: wb.x, y: wb.y } : {}),
    width: wb.width, height: wb.height, minWidth: W.MIN_SIZE.width, minHeight: W.MIN_SIZE.height,
    title: 'NaTsu',
    icon: WINDOW_ICON,
    // 地色は CSS が効く前の一瞬に見える色。ライト固定だとダークで
    // 開くたび・リサイズのたびに白くまたたく。画面の地（N1 の #191919・#ffffff）と同じにする（第1b回）
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  mainWin.setMenuBarVisibility(false);
  if (winState.maximized) mainWin.maximize();
  mainWin.loadFile(path.join(__dirname, 'renderer', 'app.html'));
  if (recoveredPageId) {
    const id = recoveredPageId;
    recoveredPageId = null;
    mainWin.webContents.once('did-finish-load', () => {
      sendToMainWin('app:notice', '前回中断された議事録の文字起こしを復旧しました。「要約を生成」から議事録を作成できます。');
      sendToMainWin('page:open', id);
    });
  }
  // データフォルダを開けなかった知らせ。画面が出てから送る（起動直後は受け手が居ない）
  if (storeError) mainWin.webContents.once('did-finish-load', () => sendToMainWin('app:notice', `データフォルダを開けません。議事録は保存されません（${storeError}）`));
  // 起動の途中の知らせ（設定・履歴の直しと退け）。読み終えてから1回にまとめて送る（左下の知らせは前の文を置き換えるため）
  if (startupNotices.length) mainWin.webContents.once('did-finish-load', () => sendToMainWin('app:notice', startupNotices.splice(0).join('　')));
  // 画面の覚え書き（第1b回 N6）。窓の大きさと位置・最大化を覚え（まとめ書き）、拡大は main が受け持つ。拡大の近道は
  // preventDefault で既定のメニューに渡さない（メニューの段は 1.2 倍ずつで、覚えた倍率が段に無い値になる: F4）。
  // ホイールの拡大（zoom-changed）は Electron が自分では拡大しないので、同じ段で動かす。読み込むたびに覚えた倍率を当てる
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) mainWin.on(ev, rememberWinBounds);
  // 0.9.0 U-1（SP2・RF9）: 音声入力の録音中に本体の窓が前に来たら Esc の全体のホットキーを外し、離れたら付け直す
  mainWin.on('focus', syncEscapeHotkey);
  // 0.9.3 M-5: 最小化・隠す・出すで、録音中のページの音の波のために聞くかを決め直す
  for (const ev of ['minimize', 'restore', 'show', 'hide']) mainWin.on(ev, syncLevelAsk);
  mainWin.on('blur', syncEscapeHotkey);
  mainWin.webContents.on('before-input-event', (e, input) => {
    const dir = W.zoomDir(input);
    if (!dir) return;
    e.preventDefault();
    stepWinZoom(dir);
  });
  mainWin.webContents.on('zoom-changed', (_e, dir) => { if (dir === 'in' || dir === 'out') stepWinZoom(dir); });
  mainWin.webContents.on('did-finish-load', () => {
    if (winState.zoom !== 1 && mainWin && !mainWin.isDestroyed()) mainWin.webContents.setZoomFactor(winState.zoom);
  });
  // 議事録の DB の口は読み込みのたびに新しく渡す（読み込み直すと前の口は閉じる。第2a1回 ST7）
  mainWin.webContents.on('did-finish-load', sendDbPort);
  // 読み込み直した画面はまだ録音中のページを開いていない（開けば画面が meeting:live-shown で知らせ直す。第1d回 A-8）
  mainWin.webContents.on('did-start-loading', () => { liveShownByUi = false; });
  // 隠す・閉じるの前に、まとめ書きの残りを書き出す（第1a回 JS8。トレイ常駐で隠したまま電源を切られることがある）
  mainWin.on('hide', flushAllWriters);
  // 閉じるボタンの挙動。既定はそのまま終了。設定でトレイ常駐に切り替えられる。
  mainWin.on('close', (e) => {
    flushAllWriters();
    if (quitting) return;
    if (settings.stayInTray) { e.preventDefault(); mainWin.hide(); return; }
    // 記録中・要約中の閉じ間違いで会議や要約を失わせない（文は mainlib.closeConfirm）。
    // draft からの復旧はあるが要約前の状態に戻るので、一度は確認を挟む。
    const confirm = closeConfirm(state === 'meeting' || state === 'meeting-finalizing', isSummarizing(), finalizingPageIds.size > 0);
    if (confirm) {
      const r = dialog.showMessageBoxSync(mainWin, {
        title: APP_TITLE, type: 'warning', buttons: ['終了する', 'キャンセル'], defaultId: 1, cancelId: 1,
        message: confirm.message, detail: confirm.detail,
      });
      if (r !== 0) { e.preventDefault(); return; }
    }
    quitting = true;
    app.quit();
  });
}

// ---------------------------------------------------------------- 音声入力
function startRecording() {
  if (state !== 'idle' || quitting) return;   // 終了・再起動の途中は始めない（第1d回 A-9 の点検。startMeeting と同じ）
  // 第1d2回 M-1（D21）: 手元が使えるかクラウドが使えそうなら始める。選んだ人で両方だめなら今の文、選んでいない人は D1〜D3（mainlib.dictationPlan）
  const c = cloudNow();
  const plan = dictationPlan({ localUsable: engineValid(whisperEng), chosen: isOfflineChosen(), cloud: c.cloud, problem: whisperProblem(), why: c.why });
  if (!plan.ok) {
    createMainWindow();
    sendToMainWin('app:notice', plan.action ? { text: plan.error, action: plan.action } : plan.error);
    return;
  }
  // 第1d2回 M-5: 始めたときに手元が使えたか（使えずにクラウドで始めた音声入力は、選んだ人でも音声を残す: 決めたこと 14）と、始めた時刻（残す名前）
  dictLocalAtStart = engineValid(whisperEng);
  dictStartedAt = Date.now();
  warmWhisper().catch((e) => engineLog(`文字起こしエンジンの先読みに失敗: ${logReason(e)}`));
  state = 'recording';
  // いま前にある窓が貼り付け先。オーバーレイを出す前に控える（#54）
  dictationFg = askPaster('fg', FG_REPLY_MS).then((r) => (r && r.kind === 'hwnd' ? r.value : ''));
  placeOverlayForRecording();
  overlayWin.showInactive();
  sendToOverlay('overlay:start', { mode: 'dictation', micId: settings.micId || '', sound: Boolean(settings.soundFeedback), form: overlayForm, keys: panelKeys('hotkey') });
  syncEscapeHotkey();
  updateTray();
}
// 0.9.0 U-1（SP2・設計書 RF9・決めたこと 16）: 音声入力の録音中だけ Esc を全体のホットキーにして取り消しに使う。
// ただし本体の窓にフォーカスがある間は付けない（全体のホットキーは窓より先に取るので、設定のポップアップや検索の窓の Esc が
// 音声入力の取り消しになる）。本体の窓の focus・blur と、録音の始め・終わり（今の register・unregister の所）から呼ぶ。
// 議事録の録音中・録音していないときは Esc を取らない（付いていれば外す）。付いているかは自分の印でなく isRegistered で見る
//（ホットキーの登録し直し applyHotkeys の unregisterAll で外れても、次の呼び出しで付け直す）
function syncEscapeHotkey() {
  const mainFocused = Boolean(mainWin && !mainWin.isDestroyed() && mainWin.isFocused());
  const want = state === 'recording' && !mainFocused;
  const held = globalShortcut.isRegistered('Escape');
  if (want && !held) globalShortcut.register('Escape', cancelRecording);
  else if (!want && held) globalShortcut.unregister('Escape');
}
function stopRecording() {
  if (state !== 'recording') return;
  state = 'processing';
  syncEscapeHotkey();
  sendToOverlay('overlay:stop', {});
  updateTray();
}
function cancelRecording() {
  if (state !== 'recording') return;
  state = 'idle';
  syncEscapeHotkey();
  sendToOverlay('overlay:cancel', {});
  updateTray();
}
function toggleRecording() {
  if (state === 'idle') startRecording();
  else if (state === 'recording') stopRecording();
}

async function handleDictationAudio(buffer, durationMs) {
  // 取り消し後に届いた録音を処理しない。
  // Escape で取り消しても、録音側の停止処理が終わってから音声が届くことがあり、
  // そのまま進むと取り消したはずの文章が貼り付けられる。
  if (state !== 'recording' && state !== 'processing') return;
  state = 'processing'; syncEscapeHotkey(); updateTray();
  if (durationMs < MIN_RECORD_MS || buffer.byteLength < 1000) { finishWithError('録音が短すぎます'); return; }
  sendToOverlay('overlay:phase', { phase: 'processing', message: '文字起こし中…' });
  try {
    const t0 = Date.now();
    const { text: raw } = await transcribeAuto(buffer, '', durationMs, { dictation: true });
    if (!raw) throw new Error('音声を認識できませんでした');
    let text = settings.removeFillers ? removeFillersRule(raw) : raw;
    if (!text) text = raw;
    const procMs = Date.now() - t0;
    // 保存 → 画面へ → 貼る（判断は mainlib.recordDictation）。履歴を保存できなくても口述した文字は貼る（JS5）
    const rec = await lib.recordDictation({
      history,
      entry: {
        id: store.newId('h'), text, raw,
        createdAt: new Date().toISOString(),
        durationSec: Math.round(durationMs / 1000), procMs, chars: text.length,
      },
      max: settings.maxHistory,
      save: () => historyWriter.now(history),
      notify: (h) => sendToMainWin('history:updated', h),
      deliver: (t) => deliverText(t),
    });
    if (!rec.saved) engineLog('履歴: 口述の履歴を保存できませんでした（文字は貼り付けに回しました）');
    const preview = text.length > 24 ? `${text.slice(0, 24)}…` : text;
    sendToOverlay('overlay:phase', { phase: 'done', message: preview, procSec: (procMs / 1000).toFixed(1) });
    setTimeout(hideOverlayIfIdle, 1500);
    state = 'idle'; updateTray();
  } catch (e) {
    if (keepsDictation(e)) { await keepDictation(buffer, durationMs, e); return; }
    finishWithError(e.message || '不明なエラー');
  }
}

// ---------------------------------------------------------------- 音声入力の音声を残す（第1d2回 M-5・OF5・D21・決めたこと 5・14）
// 録った後でクラウドで文字起こしできず、PC の中の文字起こしも使えないとき、音声を <userData>/data/dictwait/<始めた時刻 ms>-<履歴の行の id>.wav に
// 残し、履歴に「文字起こし待ち」の行（wait にファイルの名前だけ）を足す。戻ったら見回りが文字起こしして行を文字に替える（貼り付けはしない:
// 貼る先の窓はもう分からず、後から急に文字が入ると困る）。残した音声は自動で消さない（利用者が行を消したときだけ）
const DICT_WAIT_TEXT = '（文字起こし待ち: 音声は残してあります）';
const DICT_KEPT_TEXT = '文字起こしできなかったので、音声を残しました。つながると文字起こしして、履歴に入れます。';
const DICT_WAIT_RE = /^(\d+)-([A-Za-z0-9]+)\.wav$/;
const dictwaitRoot = () => path.join(app.getPath('userData'), 'data', 'dictwait');
let dictLocalAtStart = true;
let dictStartedAt = 0;
let dictWaitRunning = false;
// 残すか: 準備を選んでいない PC で手元を待たなかった（kept）・選んでいない PC で中継の短い 429 を待ちきれなかった（keepForRetry）・始めたときに
// 手元が使えなかった（選んだ人で壊れている・確かめ中）の engineMissing。中継が音声を見て断った（refused）は残さない（決めたこと 12）
function keepsDictation(e) {
  if (!e || e.refused) return false;
  // 0.9.4 S-2（決めたこと 17）: PC の文字起こしの時間切れも残す（履歴に「文字起こし待ち」）
  return Boolean(e.kept || (e.keepForRetry && !isOfflineChosen()) || (e.engineMissing && !dictLocalAtStart) || lib.localFailKind(e) === 'late');
}
async function keepDictation(buffer, durationMs, e) {
  const id = store.newId('h');
  const at = dictStartedAt || Date.now();
  const name = `${at}-${id}.wav`;
  try {
    fs.mkdirSync(dictwaitRoot(), { recursive: true });
    const file = path.join(dictwaitRoot(), name);
    // 一時ファイルに書いてから置き換える（書き込み中に落ちても半端な wav を文字起こししない）。名前の変更がウイルス対策に掴まれたら
    // jsonfile と同じ待ち（RENAME_WAITS）でやり直す（RF20）。だめなら一時ファイルを消す
    fs.writeFileSync(`${file}.tmp`, Buffer.from(buffer));
    for (let i = 0; ; i++) {
      try {
        fs.renameSync(`${file}.tmp`, file);
        break;
      } catch (err) {
        if (!(err && J.BUSY.has(err.code)) || i >= J.RENAME_WAITS.length) { unlinkQuiet(`${file}.tmp`); throw err; }
        J.sleepSync(J.RENAME_WAITS[i]);
      }
    }
  } catch (err) {
    engineLog(`音声入力: 音声を残せませんでした（${errCode(err)}）`);
    finishWithError(`${(e && e.message) || '不明なエラー'}（音声を残せませんでした）`);
    return;
  }
  const sec = Math.round(durationMs / 1000);
  engineLog(`音声入力: 音声を残した（${sec} 秒）`);
  const rec = await lib.recordDictation({
    history,
    entry: { id, text: DICT_WAIT_TEXT, raw: '', createdAt: new Date(at).toISOString(), durationSec: sec, procMs: 0, chars: 0, wait: name },
    max: settings.maxHistory,
    save: () => historyWriter.now(history),
    notify: (h) => sendToMainWin('history:updated', h),
    deliver: () => {},   // 貼り付けない
  });
  if (!rec.saved) engineLog('履歴: 残した音声入力の行を保存できませんでした（音声は残してあります）');
  finishWithError(DICT_KEPT_TEXT);
}
// 残した音声入力を古い順に文字起こしする（見回りから。走っている間は重ねない）。行は名前の id で探す（文字を入れて保存した後・WAV を消す前に
// 落ちた・見回りが重なった、で行を二重にしない）。文字は行に入れ（行が上限で切れていれば、その時刻の順の所に足す。足すときは上限で切らない）、
// 履歴を保存してから WAV を消す（この順。逆だと落ちたときに文字を失う）。保存できなければ行を元に戻し（画面にも次の見回りにも「文字起こし待ち」の
// まま）、WAV を残して止める。空の答えは行と WAV を消す。まだ使えなければ止めて次の見回りへ。見回りからだけ呼ぶので手元のエンジンは起こさない
// （cloudOnly: RF49）。WAV を消して失敗の文にするのは中継が音声を見て断った（refused: 待っても同じ答え）ときだけ。ほかの失敗は残して次の見回りへ
async function transcribeDictWaits() {
  if (dictWaitRunning || historyState === 'unreadable') return;
  let names = [];
  try { names = fs.readdirSync(dictwaitRoot()).filter((n) => DICT_WAIT_RE.test(n)).sort(); } catch (_) { return; }
  if (!names.length) return;
  dictWaitRunning = true;
  let n = 0;
  let changed = false;
  try {
    for (const name of names) {
      const [, ms, id] = name.match(DICT_WAIT_RE);
      const file = path.join(dictwaitRoot(), name);
      const row0 = history.find((h) => h && h.id === id);
      if (row0 && !row0.wait) { unlinkQuiet(file); continue; }   // もう文字が入っている
      let buf;
      try { buf = fs.readFileSync(file); } catch (_) { continue; }
      const durationMs = row0 && Number(row0.durationSec) > 0 ? Number(row0.durationSec) * 1000 : Math.max(0, Math.round((buf.length - 44) / 32));
      let raw = '';
      let failText = '';
      try {
        ({ text: raw } = await transcribeAuto(buf, '', durationMs, { what: '音声入力（残した音声）', cloudOnly: true, dictation: true }));
      } catch (e) {
        if (!(e && e.refused)) break;   // まだ使えない・待てば変わりうる: 次の見回りで（音声は消さない）
        failText = `（この音声入力の文字起こしに失敗: ${(e && e.message) || '不明なエラー'}）`;   // 待っても同じ答え（中継が断った）
      }
      if (!fs.existsSync(file)) continue;   // 待つ間に利用者が行を消した（音声も消えた）
      const row = history.find((h) => h && h.id === id);
      const before = row ? { ...row } : null;
      const at = row ? history.indexOf(row) : -1;
      if (!raw && !failText) {
        // 無音だった: 行と音声を消す
        if (row) history.splice(at, 1);
        const w = historyWriter.now(history);
        if (!w.ok) {
          if (row) history.splice(at, 0, row);   // 保存できない: 行を戻して音声を残す
          engineLog('履歴: 残した音声入力の行を消せませんでした（音声は残します）');
          break;
        }
        if (row) changed = true;
        unlinkQuiet(file);
        continue;
      }
      let text = failText || (settings.removeFillers ? removeFillersRule(raw) : raw);
      if (!text) text = raw;
      let added = null;
      if (row) {
        row.text = text; row.raw = raw; row.chars = failText ? 0 : text.length;
        delete row.wait;
      } else {
        const createdAt = new Date(Number(ms)).toISOString();
        let i = history.findIndex((h) => h && String(h.createdAt) < createdAt);
        if (i < 0) i = history.length;
        added = { id, text, raw, createdAt, durationSec: Math.round(durationMs / 1000), procMs: 0, chars: failText ? 0 : text.length };
        history.splice(i, 0, added);
      }
      const w = historyWriter.now(history);
      if (!w.ok) {
        // 保存できない: 行を元に戻す（文字を入れたまま WAV を残すと、次の見回りが「もう文字が入っている」と WAV を消してしまう）
        if (row) { for (const k of Object.keys(row)) delete row[k]; Object.assign(row, before); }
        if (added) { const k = history.indexOf(added); if (k >= 0) history.splice(k, 1); }
        engineLog('履歴: 残した音声入力の文字を保存できませんでした（音声は残します）');
        break;
      }
      changed = true;
      unlinkQuiet(file);
      if (!failText) n += 1;
    }
  } finally {
    dictWaitRunning = false;
  }
  if (changed) sendToMainWin('history:updated', history);
  if (n) {
    engineLog(`音声入力: 残した音声を文字起こしした（${n} 件）`);
    noticeMainWin(`残しておいた音声入力を ${n} 件文字起こしして、履歴に入れました（貼り付けはしていません）。`);
  }
}
// 利用者が履歴の行を消した（全部消した）: その行の残した音声も消す（利用者の意思）。全部消すときは、上限で切れた行の音声も消す
function dropDictWaits(rows, all) {
  if (all) {
    let names = [];
    try { names = fs.readdirSync(dictwaitRoot()).filter((x) => DICT_WAIT_RE.test(x)); } catch (_) { names = []; }
    for (const x of names) unlinkQuiet(path.join(dictwaitRoot(), x));
    return;
  }
  for (const h of rows) if (h && typeof h.wait === 'string' && DICT_WAIT_RE.test(h.wait)) unlinkQuiet(path.join(dictwaitRoot(), h.wait));
}
const dictWaitCount = () => { try { return fs.readdirSync(dictwaitRoot()).filter((x) => DICT_WAIT_RE.test(x)).length; } catch (_) { return 0; } };

function finishWithError(message) {
  // 録音中に確保した Escape を必ず手放す。ここを抜かすと、以後アプリ以外の
  // 場所でも Escape が効かなくなる（録音中だけの横取りのはずが残り続ける）。
  state = 'idle'; syncEscapeHotkey(); updateTray();
  sendToOverlay('overlay:phase', { phase: 'error', message });
  setTimeout(hideOverlayIfIdle, 3000);
}
function hideOverlayIfIdle() {
  if (state === 'idle' && overlayWin && !overlayWin.isDestroyed()) overlayWin.hide();
}

// ---------------------------------------------------------------- 区間の音声の退避（#8/#42）
// 区間は音声が届いた時点で { id, atMs, durationMs, pending: true, wav, text: '' } として
// meeting.segments と draft.json に控え、音声そのものを <userData>/data/segbuf/<開始時刻>/<seq>.wav
// へ退避する。文字起こしが終わったら同じ要素を結果で置き換え、wav を消す。
// 以前は文字起こしが終わるまで draft に載らず、その間にアプリが落ちると音声ごと消えていた。
// 残った wav は次回起動時に文字起こしして復旧ページへ差し替える（recoverDraftIfAny）。
const segbufRoot = () => path.join(app.getPath('userData'), 'data', 'segbuf');
const segbufDir = (startedAt) => path.join(segbufRoot(), String(startedAt));
function spoolSegment(dir, seq, buffer) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${seq}.wav`);
    // 一時ファイルに書いてから置き換える（書き込み中に落ちても半端な wav を復旧しない）
    fs.writeFileSync(`${file}.tmp`, buffer);
    fs.renameSync(`${file}.tmp`, file);
    return file;
  } catch (e) {
    engineLog(`音声の退避に失敗: ${e.message}`);   // 退避できなくても文字起こしは続ける
    return '';
  }
}
function unlinkQuiet(file) { if (file) { try { fs.unlinkSync(file); } catch (_) { /* noop */ } } }
// 空のときだけ消す（rmdir は中身があれば失敗する）。中身が残っているなら復旧の材料
function removeDirIfEmpty(dir) { try { fs.rmdirSync(dir); } catch (_) { /* noop */ } }
// 破棄: 退避した音声は復旧の材料にしない（破棄は利用者の意思）
function cleanupSegbuf(m) {
  for (const s of m.segments) unlinkQuiet(s.wav);   // 待ちの区間も、失敗して残した区間も
  dropQuietKept(m);   // 止まりの見張りで控えた区間も（第1d回 A-6）
  removeDirIfEmpty(segbufDir(m.startedAt));
}
// 文字起こし待ちの区間を結果で置き換える（id/atMs はそのまま。pending/wav を外し、wav を消す）。
// patch が null なら区間ごと消す（空・直前の繰り返し。以前は push しなかったのと同じ）。
// 認識に失敗した区間（時間切れ・エンジンの落ち）は wav を残す: 議事録を締めるときに
// 復旧と同じ待ち行列に載せ、要約のあとでもう一度文字起こしする（maybeFinalizeMeeting）。
// 消してしまうと、その 75 秒は二度と戻らない
function settleSegment(m, seg, patch) {
  const keepWav = Boolean(patch && patch.failed && seg.wav);
  if (!keepWav) unlinkQuiet(seg.wav);
  if (patch) {
    const wav = seg.wav;
    delete seg.pending; delete seg.wav;
    Object.assign(seg, patch);
    if (keepWav) seg.wav = wav;
  } else {
    const i = m.segments.indexOf(seg);
    if (i >= 0) m.segments.splice(i, 1);
  }
  writeDraft();
  refreshSegFailed(m);
  // 確定した区間を DB の写しへ（第2a1回 ST6）。返事を待たない（失敗しても録音は続ける。下書きが正本）。送るたびに別の tx（客が作る）。
  // 下書きに書いてから送る（写しが下書きより先に進まない）。音声のパスは載せない
  if (patch && m.pageId) db.send('meeting.segment', { pageId: m.pageId, seg: settledSegments([seg])[0] });
  sendToMainWin('meeting:update', meetingStatus());
}

// 区切りの長さの唯一の入口（背圧と経路。第1d回 A-5・D16 で applyBackpressure を置き換えた）。
// 基準は今の側の長さ（中継で文字起こししている側は 15 秒、手元・PC の中だけの会議は設定の長さ: mainlib.segmentBaseMs）。
// 文字起こしが追いつかないとき（待ちが 3 区間を超える）は区間を倍に伸ばして送る回数を減らし、追いついたら（待ち 1 以下）基準に戻す
// （判断は mainlib.nextLiveSegmentMs。中で nextSegmentMs を使う。#42）。m.segmentMs は録音バーが今使っている長さで、途中の値は
// 録音バーと同じく 20〜300 秒に丸めた値。変わったときだけ録音バーへ送る（次の区切りから効く）
function applySegmentLength(m, delta, why) {
  const mode = m.localOnly ? 'long' : m.segMode.mode;
  const base = segmentBaseMs(mode, settings.segmentSec);
  // 0.9.4 S-5（決めたこと 29）: 背圧で伸ばすのは PC の側（long）だけ。クラウドの側（short）は基準のまま（mainlib.nextLiveSegmentMs の5つ目）
  // 0.12.0 SP-3a（決めたこと 133）: 2つの流れの会議は、待ちの数を流れの数で割って見る（1つの流れあたり 3）
  const next = m.two && m.two.on ? nextLiveSegmentMs(Math.ceil(pendingSegs / liveLanes(m)), m.segmentMs, base, delta, mode) : nextLiveSegmentMs(pendingSegs, m.segmentMs, base, delta, mode);
  if (next === m.segmentMs) return;
  m.segmentMs = next;
  sendToOverlay('overlay:segment-ms', next);
  engineLog(`文字起こしの状態: 区切り ${next / 1000} 秒（${mode}・理由 ${why}）`);
}
// 区間の後（文字になっても空でも失敗でも）: 今の経路で区切りの側を決め直す（同じ側が2区間続いてから替える。mainlib.segmentModeNext）
function segmentRouted(m, route, why) {
  m.segMode = segmentModeNext(m.segMode, { route, why });
  applySegmentLength(m, 0, why);
}

// ---- 会議ごとの文字起こしの状態（第1d回 A-6・RL14・D17）
// 帯の符号を立てる・消す。同じ符号は1つだけで、記録は立てたとき・消したときだけ（区間ごとに重ねない: F15）。符号と数だけを書く
function setSttProblem(m, code, detail = {}) {
  const fresh = !m.problems.has(code);
  if (fresh) engineLog(`文字起こしの状態: 帯 ${code}`);
  m.problems.set(code, detail);
  if (fresh) winNotifyProblem(m, code);
}
// 録音中のページが見えているか（第1d回 A-8・D17）: 本体の窓があり、隠れていない・最小化していない・前にあり、画面が最後に
// 「録音中のページを開いている」と知らせた（meeting:live-shown）
function liveVisible() {
  if (!mainWin || mainWin.isDestroyed()) return false;
  return mainWin.isVisible() && !mainWin.isMinimized() && mainWin.isFocused() && liveShownByUi;
}
// 帯の符号が新しく立った: 録音中のページが見えていなければ、止まる・行動が要る4つの符号だけを会議ごとに1回（違う符号でも 5 分は空ける）。
// 出せない PC（Notification.isSupported() が false）では記録だけ。記録は符号だけを書く
function winNotifyProblem(m, code) {
  if (m !== meeting || liveVisible()) return;
  const g = notifyGate(m.winNotify, code, Date.now());
  m.winNotify = g.st;
  if (!g.ok) return;
  let shown = false;
  try {
    if (Notification.isSupported()) {
      const n = new Notification({ title: APP_TITLE, body: WIN_NOTIFY[code] });
      n.on('click', showLiveFromNotice);
      n.show();
      lastWinNotice = n;
      shown = true;
    }
  } catch (_) { shown = false; }
  engineLog(shown ? `文字起こしの状態: Windows の知らせ ${code}` : `文字起こしの状態: Windows の知らせを出せない ${code}`);
}
// Windows の知らせを押した: 本体の窓を前に出し（無ければ作る）、画面に録音中のページを開かせる（読み込み中なら読み終えてから）
function showLiveFromNotice() {
  createMainWindow();
  if (!mainWin || mainWin.isDestroyed()) return;
  if (mainWin.isMinimized()) mainWin.restore();
  if (mainWin.webContents.isLoading()) mainWin.webContents.once('did-finish-load', () => sendToMainWin('meeting:show-live'));
  else sendToMainWin('meeting:show-live');
}
function clearSttProblem(m, ...codes) {
  for (const code of codes) if (m.problems.delete(code)) engineLog(`文字起こしの状態: 帯を消した ${code}`);
}
// 区間の経路（transcribeAuto の答えか、手元の失敗の Error の sttRoute）から中継の様子の帯を決める。クラウドで答えが来たら（空の文でも
// 中継は戻っている）中継の帯を全部消す。オフライン・ログインしていない・PC の中だけは帯にせず、立っている中継の帯も消す（RF28）
function noteSttRoute(m, { route, why, scope } = {}) {
  // 第1d2回 M-2: 区間が中継で文字になった（中継が戻った・ログインした）ら、音声を残している帯も消す（PC の中だけの B14 は残した区間が無くなるまで）
  if (route === 'cloud') clearSttProblem(m, 'kept-wait', 'kept-relay', 'kept-login');
  // 0.9.0 B-2: クラウドで文字になったらネットワークの帯も消す（オフライン・ログインしていない・PC の中だけの道では消さない: 消すのは見張り）
  if (route === 'cloud') clearSttProblem(m, ...NET_PROBLEMS);
  if (route === 'cloud' || why === 'offline' || why === 'signed-out' || why === 'local-only') {
    clearSttProblem(m, ...RELAY_PROBLEMS);
    return;
  }
  const code = problemForRoute({ route, why, scope });
  if (!code) return;
  if (RELAY_PROBLEMS.includes(code)) clearSttProblem(m, ...RELAY_PROBLEMS.filter((c) => c !== code), ...NET_PROBLEMS);
  setSttProblem(m, code, {});
}
// 区間が文字になった: 経路と時刻を覚え、エンジンと止まりの帯を消し、止まりの数えを戻して控えた WAV を消す
function noteSttText(m, route) {
  m.stt = { route, lastTextAt: Date.now() };
  m.stallRun = 0;
  if (m.two) for (const L of Object.values(m.two.streams)) L.stall = null;   // 0.12.0 SP-3a: 控えた WAV を消すので、流れごとの数えも戻す
  dropQuietKept(m);
  clearSttProblem(m, 'engine-down', 'stall');
}
function dropQuietKept(m) {
  for (const s of m.quietKept.splice(0)) unlinkQuiet(s.wav);
}
// 失敗して音声を残した区間の数（［もう一度］と会議の後の送り直しの材料）→ 帯 seg-failed
// 第1d2回 M-2: 音声を残した区間（kept）は数えない（B4 と B11〜B14 を重ねない）。残した区間が無くなったら kept の帯を消す
function refreshSegFailed(m) {
  const n = m.segments.filter((s) => s.failed && s.wav && !s.kept).length;
  if (n > 0) setSttProblem(m, 'seg-failed', { n });
  else clearSttProblem(m, 'seg-failed');
  if (!m.segments.some((s) => s.kept && s.wav)) clearSttProblem(m, ...KEPT_CODES, 'kept-late');
}
// 0.9.4 S-2（決めたこと 2）: 会議の区間の文字起こしの失敗の後始末 → 区間の文。PC の時間切れ（late）は音声を残して帯 kept-late（engine-down は
// 立てない）、エンジンに届かない（down）は音声を残して今の engine-down、エンジンが答えた誤り（error）は今の失敗（seg-failed）。
// 準備を選んでいない PC で残した区間（kept）・中継が断った区間（refused）は今のまま
function noteSegFailure(m, seg, e) {
  if (e && e.slowKept) {   // 0.9.4 S-4: 遅い PC の会議で PC に落ちる区間（PC へ送らずに音声を残した）
    seg.kept = true;
    noteSttRoute(m, e.sttRoute);
    setSttProblem(m, 'kept-late', { offline: Boolean(m.localOnly) });
    if (noticeOnce(m, 'slow', SLOW_NOTICE)) {
      try { if (tray && typeof tray.displayBalloon === 'function') tray.displayBalloon({ title: APP_TITLE, content: SLOW_NOTICE }); } catch (_) { /* Windows の外には無い */ }
    }
    return SLOW_SEG_TEXT;
  }
  if (e && e.kept) { seg.kept = true; noteKept(m, e); return KEPT_SEG_TEXT; }
  const kind = e && !e.refused && e.sttRoute && e.sttRoute.route === 'local' ? lib.localFailKind(e) : '';
  if (kind === 'late') {
    seg.kept = true;
    noteSttRoute(m, e.sttRoute);
    setSttProblem(m, 'kept-late', { offline: Boolean(m.localOnly) });
    return LATE_SEG_TEXT;
  }
  if (kind === 'down') { seg.kept = true; noteSttFailure(m, e); return DOWN_SEG_TEXT; }
  if (!(e && e.refused)) noteSttFailure(m, e);
  return `（この区間の認識に失敗: ${e && e.message}）`;
}
// 区間の音声を残した（第1d2回 M-2）: その理由の帯（mainlib.keptCodeFor）を立て、ほかの kept の帯と中継の帯を消し、残し始めの知らせ（noticeKept）
function noteKept(m, e) {
  const why = e && e.sttRoute ? e.sttRoute.why : '';
  const code = keptCodeFor({ localOnly: m.localOnly, why });
  if (!code) return;
  clearSttProblem(m, ...KEPT_CODES.filter((c) => c !== code), ...RELAY_PROBLEMS);
  setSttProblem(m, code, {});
  noticeKept(m, why);
}
// 文字が空だった区間（直前と同じ文で除いた区間は呼ばない）。音のある空は WAV を消さずに控え、stallAfter 個続いたら止まりとみなし、
// 控えた区間を失敗の区間として atMs の順にページへ戻す。音の無い空は今どおり消す（数えも戻しもしない）→ 控えたら true
function noteEmptySegment(m, seg, buffer) {
  const lane = segLane.get(seg);   // 0.12.0 SP-3a（決めたこと 141）: 2つの流れの会議は流れごと・声の時間で
  if (lane) return noteEmptyTwo(m, lane, seg, buffer);
  const run = stallStep(m.stallRun, { text: '', levelDbfs: wavLevelDbfs(buffer) });
  if (run === m.stallRun) return false;
  m.stallRun = run;
  const i = m.segments.indexOf(seg);
  if (i >= 0) m.segments.splice(i, 1);
  delete seg.pending;
  m.quietKept.push(seg);
  if (run >= stallAfter(m.segmentMs)) {
    m.stallRun = 0;
    stallReached(m);
  }
  refreshSegFailed(m);
  writeDraft();
  sendToMainWin('meeting:update', meetingStatus());
  return true;
}
// 止まりとみなした: 控えた区間を失敗の区間として atMs の順にページへ戻し、帯 stall を立てる（1本の会議と2つの流れの会議で同じ）
function stallReached(m) {
  const kept = m.quietKept.splice(0);
  const sec = Math.round(kept.reduce((a, x) => a + (Number(x.durationMs) || 0), 0) / 1000);
  for (const x of kept) {
    x.text = STALL_SEG_TEXT;
    x.failed = true;
    let at = m.segments.findIndex((y) => y.atMs > x.atMs);
    if (at < 0) at = m.segments.length;
    m.segments.splice(at, 0, x);
  }
  engineLog(`文字起こしの状態: 止まっているかもしれない（音のある空の区間 ${kept.length}）`);
  setSttProblem(m, 'stall', { sec });
  if (m.pageId) for (const x of kept) db.send('meeting.segment', { pageId: m.pageId, seg: settledSegments([x])[0] });
}
// ---- 話し声が無いときに聞いて止める（0.9.1 Q-4。計画 docs/plans/2026-10-21-091.md の決めたこと 7〜11・14）
// 区間の文字起こしが済むたびに「話し声あり（speech）」「なし（quiet）」を mainlib.quietStep に渡す。時計は会議の時計（区間の長さの和。一時停止の時間を
// 含まない）。聞く（ask）: 録音中のページの帯（meetingStatus().quiet）・録音バーの短い文（今の overlay:phase の口を 3 秒ごとに送り直す。overlay.html は
// 変えない）・録音中のページが見えないときの Windows の知らせ。止める（stop）: 今の stopMeeting だけを通す（録音中で、ほかに文字起こしを待つ区間が無いとき）
const QUIET_BAR_TEXT = '会議は終わりましたか？';
const QUIET_BAR_MS = 3000;
const quietAskText = (min) => `${min} 分ほど話し声がありません。会議は終わりましたか？ このままなら 5 分後に録音を止めて議事録を作ります。`;
const quietDoneText = (clock) => (clock ? `話し声が無かったので録音を止め、議事録を作りました（最後の発言 ${clock}）。`
  : '話し声が無かったので録音を止め、議事録を作りました（話し声はありませんでした）。');
const quietCfg = () => ({ on: settings.autoStopQuiet !== false, askMin: Number(settings.autoStopMin) || 10 });
// 区間を分けた（kind: 'speech' | 'quiet'）。区間の終わりは会議の時計（atMs + durationMs）
function noteHeard(m, seg, kind) {
  if (meeting !== m || !seg) return;
  const lane = segLane.get(seg);   // 0.12.0 SP-3a: 2つの流れの区間は合わせてから渡す
  if (lane) { feedQuietTwo(m, lane, kind, seg); return; }
  const r = lib.quietStep(m.quiet, { kind, endMs: seg.atMs + seg.durationMs }, quietCfg());
  if (r.act === 'withdraw') { m.quiet = r.st; hideQuietAsk(m, kind === 'speech' ? 'speech' : 'off'); return; }
  // 聞く・止めるのは録音中で一時停止していないときだけ（止めた後・作成中・破棄の後・一時停止中は何もしない: Q4・Q5）。一時停止中に聞く長さに
  // 達したら聞いた印を付けない（再開で数え直す: restartQuiet）
  if (state !== 'meeting' || m.paused) { m.quiet = r.act === 'ask' ? { ...r.st, askedAt: null } : r.st; return; }
  m.quiet = r.st;
  if (r.act === 'ask') showQuietAsk(m);
  else if (r.act === 'stop' && pendingSegs <= 1) autoStopQuiet(m);   // 文字起こしを待つ区間が残っていれば、その区間を分けたときに決め直す
}
function sendQuietBar(m) {
  if (!m.paused) sendToOverlay('overlay:phase', { phase: 'recording', message: QUIET_BAR_TEXT });   // 一時停止中は文を出さない（O-3）
}
function quietBarTick(m) {
  if (meeting !== m || state !== 'meeting' || m.quiet.askedAt === null) {
    if (m.quietBar) { clearInterval(m.quietBar); m.quietBar = null; }
    return;
  }
  sendQuietBar(m);
}
function quietNotify(body, onClick) {
  try {
    if (!Notification.isSupported()) { engineLog('話し声の見張り: Windows の知らせを出せない'); return null; }
    const n = new Notification({ title: APP_TITLE, body });
    n.on('click', onClick);
    n.show();
    engineLog('話し声の見張り: Windows の知らせ');
    return n;
  } catch (_) {
    engineLog('話し声の見張り: Windows の知らせを出せない');
    return null;
  }
}
function showQuietAsk(m) {
  engineLog(`話し声の見張り: 話し声の無い時間が ${m.quiet.askMin} 分になったので聞いた`);
  if (panelHidden) showPanel();   // × で隠した録音バーも出し直す（決めたこと 10）
  sendQuietBar(m);
  if (m.quietBar) clearInterval(m.quietBar);
  m.quietBar = setInterval(() => quietBarTick(m), QUIET_BAR_MS);
  if (typeof m.quietBar.unref === 'function') m.quietBar.unref();
  if (!liveVisible()) m.quietNote = quietNotify(quietAskText(m.quiet.askMin), showLiveFromNotice);
  sendToMainWin('meeting:update', meetingStatus());
}
// 聞いた知らせを閉じる（録音バーへは送らない: 止めるときは「議事録を作成中…」が続く）
function closeQuietAsk(m) {
  if (m.quietBar) { clearInterval(m.quietBar); m.quietBar = null; }
  if (m.quietNote) {
    try { if (typeof m.quietNote.close === 'function') m.quietNote.close(); } catch (_) { /* 閉じられなくても続ける */ }
    m.quietNote = null;
  }
}
// 聞くのをやめた（話し声が戻った・［続ける］・設定をオフにした）: 帯・録音バーの文・Windows の知らせを下げる
function hideQuietAsk(m, why) {
  closeQuietAsk(m);
  engineLog(why === 'keep' ? '話し声の見張り: ［続ける］が押されたので数え直す' : why === 'resume' ? '話し声の見張り: 再開したので数え直す'
    : why === 'speech' ? '話し声の見張り: 話し声が戻ったので聞くのをやめた' : '話し声の見張り: 設定がオフになったので聞くのをやめた');
  if (meeting !== m) return;
  if (state === 'meeting') sendToOverlay('overlay:phase', { phase: 'recording', message: '' });
  sendToMainWin('meeting:update', meetingStatus());
}
// ［続ける］（meeting:keep-going）と一時停止からの再開: 数えを、その時までに届いた音声の終わりから数え直す（聞いていれば聞くのをやめる）
function restartQuiet(m, why) {
  const r = lib.quietStep(m.quiet, { kind: 'keep-going', endMs: m.offsetMs }, quietCfg());
  m.quiet = r.st;
  if (r.act === 'withdraw') hideQuietAsk(m, why);
}
function keepGoingQuiet() {
  const m = meeting;
  if (!m || state !== 'meeting') return { ok: false };
  restartQuiet(m, 'keep');
  return { ok: true };
}
function autoStopQuiet(m) {
  engineLog('話し声の見張り: 聞いてから 5 分たっても話し声が無いので、録音を止めた');
  m.autoStopped = true;
  stopMeetingBy('auto-quiet');
}
// 自動で止めた会議の議事録を保存した後の知らせ（本体の窓が前にないときは Windows の知らせも。押すとそのページを開く）
function quietDoneNotice(m, pageId) {
  let last = null;
  for (const s of settledSegments(m.segments)) if (Number.isFinite(s.atMs) && (last === null || s.atMs > last)) last = s.atMs;
  const text = quietDoneText(last === null ? '' : lib.clockText(last));
  noticeMainWin(text);
  const front = mainWin && !mainWin.isDestroyed() && mainWin.isVisible() && mainWin.isFocused();
  if (!front) {
    quietNotify(text, () => {
      createMainWindow();
      if (!mainWin || mainWin.isDestroyed()) return;
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      sendToMainWin('page:open', pageId);
    });
  }
}
// 画面へ渡す状態（文字起こしの文・札・メール・URL の道は入れない）。まだ文字が無いときの経路は見込み（PC の中だけ・長い側なら 'local'）
function sttStatus(m) {
  const route = m.stt.route || (m.localOnly || !m.segMode || m.segMode.mode === 'long' ? 'local' : 'cloud');
  const p = sttProblemOf(m.problems);
  return {
    route, lastTextAt: m.stt.lastTextAt, segSec: m.segmentMs / 1000,
    problem: p ? { ...p, text: STT_BANNER[p.code](p, sttProvider()), action: STT_BANNER_ACTION[p.code] || '' } : null,
    ...(m.pace && m.pace.slow ? { slow: true } : {}),   // 0.9.4 S-4: 遅い会議（画面の「聞き取り中」の行が替わる）
  };
}
// 会議の区間の文字起こしの後始末で共通: 手元の失敗はその経路の帯とエンジンの帯（中継の失敗 rate・rate-long は区間の失敗だけ）
function noteSttFailure(m, e) {
  if (e && e.sttRoute) {
    noteSttRoute(m, e.sttRoute);
    setSttProblem(m, 'engine-down', {});
  }
}
// ［もう一度］（meeting:retry）: 失敗して音声を残した区間（止まりで残した区間も）を、今の経路で segChain の後ろに並べ直す。atMs はそのまま。
// 文字になればその区間を置き換え（WAV を消す）、失敗か空なら元の失敗のまま。並べ直した区間が返事を待つ間の2回目は n: 0。
// 第1d2回 M-3: only: 'kept' は、区間が中継で文字になったときの自動の並べ直し（音声を残した区間だけ、古い順に max 個まで）。
// 答えが空なら区間ごと消す（WAV も消す: 無音だった確かな結果。残すと同じ区間を送り続ける。決めたこと 6）。会議を止めた後・PC の中だけに
// した後は送らない（残した区間は会議の後の待ち行列が送る・PC の外へ出さない）
const KEPT_RETRY_MAX = 2;
function retryFailedSegments({ only = '', max = 0 } = {}) {
  const m = meeting;
  if (!m || m.skipAll) return { ok: false };
  const auto = only === 'kept';
  const segs = m.segments.filter((s) => s.failed && s.wav && !m.retrying.has(s.id)).filter((s) => !auto || s.kept)
    .sort((a, b) => a.atMs - b.atMs).slice(0, max > 0 ? max : undefined);
  if (!segs.length) return { ok: true, n: 0 };
  engineLog(auto ? `文字起こしの経路: 残した区間 ${segs.length} を並べ直した` : `文字起こしの状態: もう一度 ${segs.length} 区間`);
  for (const seg of segs) {
    m.retrying.add(seg.id);
    const gen = m.gen;
    const stale = () => meeting !== m || m.gen !== gen;
    pendingSegs++;
    segChain = segChain.then(async () => {
      if (stale() || !m.segments.includes(seg) || !seg.failed || !seg.wav) return;
      if (auto && (m.stopping || m.localOnly)) return;   // 第1d2回 M-3: 止めた後・PC の中だけにした後は送らない
      let buffer;
      try { buffer = fs.readFileSync(seg.wav); } catch (e) { engineLog(`区間 ${seg.id}: もう一度の音声を読めません（${errCode(e)}）`); return; }
      let r;
      try {
        r = await transcribeAuto(buffer, promptTail(m.segments), seg.durationMs, { isStale: stale, learn: true, localOnly: m.localOnly, notice: m,
          what: `区間 ${seg.id}（もう一度）`, seg: seg.id, onWait: (sec) => { if (!stale()) { setSttProblem(m, 'wait', { sec }); sendToMainWin('meeting:update', meetingStatus()); } },
          paceSlow: () => Boolean(m.pace && m.pace.slow) });
      } catch (e) {
        if (stale()) return;
        // 第1d2回 M-2: 音声を残した（kept）は区間に印を付けて kept の帯、中継が断った（refused）はエンジンの帯を立てない。0.9.4 S-2: PC の時間切れは kept-late
        noteSegFailure(m, seg, e);
        return;
      }
      if (stale()) return;
      clearSttProblem(m, 'wait');
      // 0.9.1 Q-2: 無音の答えの経路（none）は帯に渡さない（失敗・残した区間は無音の判定を通った音声なので、ふつうは来ない）
      if (!r.silent) noteSttRoute(m, r);
      const text = settings.removeFillers ? removeFillersRule(r.text) : r.text;
      if (!text) {
        // 第1d2回 M-3: 自動で並べ直した残した区間の空の答えは、区間ごと消す（人が押した［もう一度］の空は今どおり失敗のまま）
        if (auto && seg.kept) settleSegment(m, seg, null);
        return;
      }
      m.route[r.route] += 1;
      noteSttText(m, r.route);
      delete seg.failed;
      delete seg.kept;
      settleSegment(m, seg, { text });
    }).catch(() => {}).finally(() => {
      m.retrying.delete(seg.id);
      if (meeting !== m) return;
      pendingSegs = Math.max(0, pendingSegs - 1);
      clearSttProblem(m, 'wait');
      refreshSegFailed(m);
      sendToMainWin('meeting:update', meetingStatus());
      if (m.stopping && pendingSegs === 0) maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
    });
  }
  sendToMainWin('meeting:update', meetingStatus());
  return { ok: true, n: segs.length };
}

// 残りの待ち時間（秒）。待ちの区間の長さの合計に、区間ごとの処理時間の比（EMA。
// mainlib.EtaTracker）を掛ける。進行中の区間で既に経過した分は引く。待ちが無ければ null。
// 比はアプリの起動中は持ち越す（次の会議の最初の区間から見積もれる）。比は経路ごとで、この会議で最後に文字起こしできた経路（m.etaRoute）の比を使う
const eta = new EtaTracker();
function etaSecOf(m) {
  const remain = pendingDurationMs(m.segments);
  if (remain <= 0) return null;
  return eta.etaSec(remain, m.inFlightSince ? Date.now() - m.inFlightSince : 0, m.etaRoute || 'local');
}

// ---------------------------------------------------------------- 議事録
function meetingStatus() {
  return {
    active: state === 'meeting' || state === 'meeting-finalizing',
    finalizing: state === 'meeting-finalizing',
    startedAt: meeting ? meeting.startedAt : null,
    memo: meeting ? meeting.memo : '',
    meetingType: meeting && mtype.isSelectable(meeting.meetingType) ? meeting.meetingType : null,   // 0.11.0 M-4: 録音中のページの種類の欄を戻す
    // 0.13.0 RDY-1（RD15）: 録音の前のページ（会議が無いときだけ。画面を読み直したら戻す）
    prep: !meeting && prep ? { memo: prep.memo, meetingType: mtype.isSelectable(prep.meetingType) ? prep.meetingType : null } : null,
    segments: meeting ? publicSegments(meeting.segments) : [],   // wav（パス）は外す。待ちは pending: true
    pending: pendingSegs,
    stoppedAt: meeting && meeting.stoppedAt ? meeting.stoppedAt : null,
    // 終了を押した後（文字起こし待ち）。画面はこれを見て残り区間と打ち切りの導線を出す
    stopping: Boolean(meeting && meeting.stopping),
    paused: Boolean(meeting && meeting.paused),
    pausedMs: meeting ? meeting.pausedMs + (meeting.paused ? Date.now() - meeting.pausedAt : 0) : 0,
    systemAudio: Boolean(meeting && meeting.systemAudio),
    // 選んだマイクが見つからず既定のマイクで録っている（overlay:mic）。黙って
    // 別のマイクで録ると、会議が終わってから片側しか入っていないことに気づく
    micFallback: Boolean(meeting && meeting.micFallback),
    // 残りの待ち時間の見積もり（秒。材料が無い・待ちが無いときは null）と、打ち切った区間の数
    etaSec: meeting ? etaSecOf(meeting) : null,
    skipped: meeting ? meeting.skipped : 0,
    // 第1b回 A-3（N4c・RF4）: 再開した一時停止の印（止めた所 atMs は会議の時計・長さ ms・why は user か suspend）、
    // 録音バーに頼んで返事を待っている間（pausing）、スリープから戻って一時停止のまま（resumeHint: 再開を促す）
    pauses: meeting && Array.isArray(meeting.pauses) ? meeting.pauses.map((x) => ({ ...x })) : [],
    pausing: Boolean(meeting && meeting.pauseAsked),
    resumeHint: Boolean(meeting && meeting.resumeHint),
    // 第1c回 C-3（RF28）: ［この会議は PC の中だけ］の印と、いまクラウドで文字起こしする PC か（第1d回 A-3 から: ログインの札がしまってある）。
    // 画面は cloud のときだけ［この会議は PC の中だけ］を出し、押した後（localOnly）は戻すボタンを出さない
    localOnly: Boolean(meeting && meeting.localOnly),
    // 第1d2回 M-4: PC の中だけの会議で、PC の中の文字起こしが使えない（画面を読み直しても「文字起こししています」の文に戻らない）
    needsSetup: Boolean(meeting && meeting.localOnly && !engineValid(whisperEng)),
    // 第1d2回 M-1: 準備を選んでいない PC は、残した音声が後でクラウドへ行きうるので、ログインしていなくても出す（選んだ人は 0.8.0 のまま）
    cloud: hasRelayLogin() || !isOfflineChosen(),
    // 第1d回 A-6（RL14・D17）: 文字起こしの状態（経路・最後の文字の時刻・区切り・帯）。会議の外は null
    stt: meeting ? sttStatus(meeting) : null,
    // 0.9.0 O-4（RP8）: 録音バーを × で隠している（録音中のページは［録音バーを出す］を出す）
    panelHidden: panelHidden && panelRecording(),
    // 0.9.1 Q-4: 話し声が無いので聞いている（録音中のページの帯。文は main が作る）。止めた後・作成中は null
    quiet: meeting && state === 'meeting' && meeting.quiet && meeting.quiet.askedAt !== null ? { text: quietAskText(meeting.quiet.askMin) } : null,
  };
}

// 下書きの fsync は足す（第1a回 Task 5-1。Windows の CI の 4 回の計りで、512KB の書き込み＋fsync の p95 が 13.8・15.4・17.03・
// 35.79ms、中央値 16.22ms で、決め方の 20ms まで。録音バーとホットキーを遅らせない大きさで、電源断にも控えが残る）
const DRAFT_FSYNC = true;
// 書けなくても録音は止めない。記録はその会議で1回だけ（区間のたびに書くので、重ねると記録が埋まる）
function writeDraft() {
  if (!meeting) return;
  try {
    store.writeDraft({
      pageId: meeting.pageId,   // 会議のページの ID（締め・復旧が同じ ID に書く。第2a1回 ST6）
      startedAt: meeting.startedAt, memo: meeting.memo,
      segments: meeting.segments, offsetMs: meeting.offsetMs, savedAt: Date.now(),
      localOnly: Boolean(meeting.localOnly),   // ［この会議は PC の中だけ］（復旧した会議の送り直しも手元。第1c回 RF28）
      pauses: meeting.pauses || [],   // 止めていた時間の印（落ちて復旧したページにも残す。第1b回 N4c）
      stateLog: meeting.stateLog || [],   // 議事録の経過（0.10.0 K-1。落ちて戻したページにも残す）
      ...(mtype.isSelectable(meeting.meetingType) ? { meetingType: meeting.meetingType } : {}),   // 0.11.0 M-4: 録音中に選んだ種類（鍵のときだけ）
    }, meeting.draftName, { fsync: DRAFT_FSYNC });
  } catch (e) {
    if (!meeting.draftWriteFailed) {
      meeting.draftWriteFailed = true;
      engineLog(`下書き（${meeting.draftName}）を保存できませんでした（${errCode(e)}）。録音は続けます`);
    }
  }
}

// 落ちて戻した議事録の経過（0.10.0 K-1）: 下書きの経過の後に「戻した（アプリ）」を積み、記録に1行
function recoveredStateLog(list) {
  const item = { s: 'recover', by: 'app', at: new Date().toISOString() };
  engineLog(lib.stateLogLine(item));
  return lib.stateLogAdd(list, item);
}

// 復旧ページで文字起こし待ちのまま残った音声 { pageId, items: [{ id, wav, durationMs }], dir }。
// 起動が済んでエンジンが用意できてから順に文字起こしする
let recoveryQueue = null;
const RECOVERY_FILE = 'recovery.json';
// 復旧の待ち行列をフォルダに書いておく。エンジンが用意できずに終えられなかったとき、
// 次の起動や設定の直しで続きから文字起こしできる（wav は消さない）。いつも fsync して書く（部品の既定）。
// 書けなくても投げない（起動の途中で投げると窓が出ない）。記録と知らせ（N16）だけ。
// 書けなかった待ち行列は覚えておき、書き出しの合図（flushAllWriters）・復旧のやり直し・エンジンを待つときに書き直す
// （下書きはもう消したので、書けないまま終わると次の起動で続きから文字起こしできない）。知らせは1つの待ち行列に1回
const unsavedRecoveryQueues = new Map();   // dir → 待ち行列
function saveRecoveryQueue(q) {
  try {
    J.writeJsonFile(path.join(q.dir, RECOVERY_FILE), { pageId: q.pageId, items: q.items, retry: Boolean(q.retry), localOnly: Boolean(q.localOnly), ...(q.later ? { later: true } : {}), ...(q.slow ? { slow: true } : {}) }, { onFsyncUnsupported: noteFsyncOnce });
    if (unsavedRecoveryQueues.has(q.dir)) {
      unsavedRecoveryQueues.delete(q.dir);
      engineLog(`文字起こし待ちの記録を書き直しました（${path.basename(q.dir)}）`);
    }
    return true;
  } catch (e) {
    const again = unsavedRecoveryQueues.has(q.dir);
    unsavedRecoveryQueues.set(q.dir, q);
    if (!again) {
      engineLog(`文字起こし待ちの記録を保存できませんでした（${path.basename(q.dir)}、${errCode(e)}）`);
      laterNotice(NOTICE.recoveryNotSaved);
      scheduleRecoveryRetry();
    }
    return false;
  }
}
// 書けなかった待ち行列を書き直す。済んだ（recovery.json を消した）フォルダの分は書かない。投げない
function retryUnsavedRecovery() {
  for (const [dir, q] of Array.from(unsavedRecoveryQueues)) {
    if (!q.items.some((it) => it && it.wav && fs.existsSync(it.wav))) { unsavedRecoveryQueues.delete(dir); continue; }
    saveRecoveryQueue(q);
  }
}
const isRecoveryShape = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.items);
// この起動で recovery.json を退けたフォルダ。その起動では掃除しない（N13「7日後に片付けます」。次の起動から今の7日の掃除に任せる）
const quarantinedRecoveryDirs = new Set();
// 起動のときなどに読めなかった recovery.json がある（retryDraftRecovery が読み直す）
let recoveryUnreadable = false;
// 第1d2回 M-3: 復旧を回している間（transcribeRecovered）は、その回で進めなかった待ち行列のフォルダ（recoverySkip）を飛ばして次を探す
// （名前と引数の無い形は repo・stage2a1 のテストが字面で固定している）
let recoverySkip = null;
function loadSavedRecoveryQueue() {
  let names = [];
  try { names = fs.readdirSync(segbufRoot()); } catch (_) { return null; }
  let unreadable = false;
  let found = null;
  for (const name of names) {
    const dir = path.join(segbufRoot(), name);
    if (recoverySkip && recoverySkip.has(dir)) continue;
    const f = path.join(dir, RECOVERY_FILE);
    if (!fs.existsSync(f)) continue;
    const r = J.loadJsonFile(f, { shape: isRecoveryShape });
    if (r.state === 'unreadable') {
      // 掴まれている・権限: 何も消さない（フォルダも WAV も残す）。少し後に読み直す
      unreadable = true;
      engineLog(`文字起こし待ちの記録を読めませんでした（${name}、${r.code}）。消さずに残します`);
      continue;
    }
    if (r.state === 'broken') {
      // 消さずに退ける（N13）。名前が無くなるので、次の起動から7日の掃除が WAV ごとフォルダを片付ける
      const moved = path.basename(r.movedTo);
      quarantinedRecoveryDirs.add(dir);
      engineLog(`文字起こし待ちの記録が壊れていたので退けました（${name}、${r.reason}、${moved}）`);
      laterNotice(NOTICE.recoveryBroken(moved));
      continue;
    }
    if (r.state !== 'ok') continue;
    const j = r.value;
    const items = j.items.filter((it) => it && it.wav && fs.existsSync(it.wav));
    // ページがあるかは、ここでは見ない（同期で読むため。第2a1回 ST1）。transcribeRecovered がエンジンを待つ前に保存の側へ
    // 聞いて確かめ、「無い」（null）と答えたときだけ WAV と recovery.json を片付ける（読めなかったら何も消さない: F12）
    if (j.pageId && items.length) { found = { pageId: j.pageId, items, dir, retry: Boolean(j.retry), localOnly: Boolean(j.localOnly), ...(j.later === true ? { later: true } : {}), ...(j.slow === true ? { slow: true } : {}) }; break; }
    // 済んだ待ち行列（音声が無い）。今どおり片付ける
    unlinkQuiet(f);
    removeDirIfEmpty(dir);
  }
  if (unreadable) { recoveryUnreadable = true; scheduleRecoveryRetry(); }
  return found;
}

// 落ちた会議の控えの復旧（第1a回 JS9）。読めない控え（掴まれている・権限）は決して消さず上書きもしない。
// 少し後（RETRY_DRAFT_MS）と、次に録音を始める前と、録音が終わった後にやり直す。だめなら次の起動でやり直す
const RETRY_DRAFT_MS = [3000, 10000, 30000];
let draftRetryTimer = null;
let draftRetryIdx = 0;
let draftRetryAfterMeeting = false;
let draftBusyNoted = false;
// 下書きと recovery.json の読み直しは1つの予約にまとめる（使い切ったら、録音の前と次の起動に任せる）
function scheduleRecoveryRetry() {
  if (draftRetryTimer || draftRetryIdx >= RETRY_DRAFT_MS.length) return;
  draftRetryTimer = setTimeout(retryDraftRecovery, RETRY_DRAFT_MS[draftRetryIdx++]);
}
// 名前はこのまま（テストの台 mainrun が setTimeout の名前で捕まえる）
// setTimeout と runDraftRetryAfterMeeting から待たずに呼ばれるので、中身で投げても受け止めて記録に残す（unhandled にしない）
async function retryDraftRecovery() {
  try {
    if (draftRetryTimer) { try { clearTimeout(draftRetryTimer); } catch (_) { /* noop */ } draftRetryTimer = null; }
    // 録音中は始めない（議事録を締めた後か破棄した後に回す）。音声入力などの最中なら少し後に
    if (meeting || state === 'meeting' || state === 'meeting-finalizing') { draftRetryAfterMeeting = true; return; }
    if (state !== 'idle') { scheduleRecoveryRetry(); return; }
    retryUnsavedRecovery();
    await recoverDraftIfAny();   // 投げない（下書きごとに受け止める）
    // 起動のときに読めなかった recovery.json（設計書 JS9 の「やり直しで復旧され」）
    if (recoveryUnreadable && !recoveryQueue) {
      recoveryUnreadable = false;
      const q = loadSavedRecoveryQueue();
      if (q) {
        recoveryQueue = q;
        engineLog(`文字起こし待ちの記録を読み直しました（${q.items.length} 件）`);
      }
    }
    if (recoveryQueue) transcribeRecovered().catch((e) => engineLog(`復旧の文字起こしに失敗: ${logReason(e)}`));
  } catch (e) {
    engineLog(`下書きのやり直しに失敗: ${errCode(e)}`);
  }
}
// 議事録を締めた後・破棄した後に、録音中に来たやり直しを回す
function runDraftRetryAfterMeeting() {
  if (!draftRetryAfterMeeting || meeting || state !== 'idle') return;
  draftRetryAfterMeeting = false;
  retryDraftRecovery();
}
// 取り消した会議の ID の控え（第2a1回 RF16。<userData>/data/purge-pending.json を第1a回の J で読み書きする）。取り消しは、先に ID を
// ここへ足してから下書きを消し、DB が purge を「書けた」と返したら外す。返事の前に落ちても DB が止まっていても、次の起動で下書きの復旧と
// meeting.settle より前に送る（取り消した会議の写しが「下書きの無い写し」として復旧されない）。読めない間は上書きしない（中の ID を失わない）
const PURGE_FILE = 'purge-pending.json';
const purgePath = () => path.join(app.getPath('userData'), 'data', PURGE_FILE);
const isPurgeShape = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.pageIds) && v.pageIds.every((x) => typeof x === 'string');
const purgePending = new Set();
let purgeLoaded = false;
let purgeBusyNoted = false;
// 控えを書けなかった（読めない・掴まれている）。ID は purgePending に持ったまま、次に控えを書くときと、終わるとき・スリープなどの
// 書き出し（flushAllWriters）にもう一度書く（書けないまま DB も止まっていると、次の起動で取り消した会議が復旧される: RF16。M-3 の点検）
let purgeUnsaved = false;
function loadPurgePending() {
  if (purgeLoaded) return true;
  const r = J.loadJsonFile(purgePath(), { shape: isPurgeShape });
  if (r.state === 'unreadable') {
    if (!purgeBusyNoted) { purgeBusyNoted = true; engineLog(`取り消しの控えを読めませんでした（${r.code}）。消さずに残します`); }
    return false;
  }
  if (r.state === 'ok') for (const id of r.value.pageIds) purgePending.add(id);
  if (r.state === 'broken') engineLog(`取り消しの控えが壊れていたので退けました（${path.basename(r.movedTo)}、${r.reason}）`);
  purgeLoaded = true;
  return true;
}
// → 書けたか。投げない
function savePurgePending() {
  if (!loadPurgePending()) { purgeUnsaved = true; return false; }
  try {
    J.writeJsonFile(purgePath(), { pageIds: [...purgePending] }, { onFsyncUnsupported: noteFsyncOnce });
  } catch (e) {
    engineLog(`取り消しの控えを保存できませんでした（${errCode(e)}）`);
    purgeUnsaved = true;
    return false;
  }
  purgeUnsaved = false;
  return true;
}
// 取り消した会議の写しを DB から消す（meeting.discard。確定の後に DB がチェックポイントして文字を残さない: RF16）。「書けた」で控えから外す。投げない
async function purgeMeeting(pageId) {
  try {
    await db.call('meeting.discard', { pageId }, { tx: `m:discard:${pageId}` });
  } catch (e) {
    engineLog(`取り消した会議の写しを消せませんでした（${errCode(e)}）。次の起動でもう一度消します`);
    return false;
  }
  loadPurgePending();
  purgePending.delete(pageId);
  savePurgePending();
  return true;
}
// 取り消しの印を先に書いてから（下書きを消すのは呼び手）、裏で消す
function startPurge(pageId) {
  loadPurgePending();
  purgePending.add(pageId);
  savePurgePending();
  return purgeMeeting(pageId);
}
// 起動で、前に消しきれなかった取り消しを先に送る（下書きの復旧と meeting.settle より前）
async function flushPurgePending() {
  loadPurgePending();
  for (const id of [...purgePending]) await purgeMeeting(id);
}
// 起動で下書きの復旧が済んだ後、読めない下書きが1つも無ければ、下書きを失った録音の写しを recovered で残す（第2a1回 ST6。設計書「保存の土台」の 10）。
// keep は、読めた下書きの pageId 全部（復旧に失敗したものも）・今録音中の会議・締めの返事待ち・まだ消せていない取り消しの ID。
// keep は頼む前に同じ手番で決める（後から始めた会議の meeting.begin はこの頼みの後に届く）。投げない
async function settleCopies({ unreadable, keep }) {
  if (unreadable) return;
  const ids = new Set(keep);
  if (meeting && meeting.pageId) ids.add(meeting.pageId);
  for (const id of finalizingPageIds) ids.add(id);
  loadPurgePending();
  for (const id of purgePending) ids.add(id);
  try {
    const r = await db.call('meeting.settle', { keep: [...ids] });
    if (r && r.settled) engineLog(`下書きの無い録音の写し ${r.settled} 件を議事録（復旧）として残しました`);
  } catch (e) {
    engineLog(`録音の写しを片付けられませんでした（${errCode(e)}）`);
  }
}

// 控えは下書きのファイルを全部見る（draft.json・脇へ退けた draft.pending-<時刻>.json・会議ごとの draft-<開始時刻>.json）。
// ページは await db.call('meeting.recover') で、下書きの pageId（2a1 より前の下書きは新しい ID）に1回で作る（第2a1回 ST6。要約の欄の文もこの1回）。
// 答えが already（締めた後に下書きを消せなかった・取り消した）でも下書きを消し、復旧の知らせは出さない（DB は締め済みのページを上書きしない: F11）。
// 締めの返事を待っている会議の下書きは飛ばす。投げない（下書きごとに受け止める）。→ { unreadable, keep }（keep は読めた下書きの pageId）
// 復旧は1つずつ回す（第2a1回 M-4）。起動の復旧は DB の用意（移行の窓・移行）を待つので、その間に録音の前・やり直しの復旧が同じ下書きを
// 読むと、pageId の無い 0.6.0 の下書きが2つのページになる。回している間（draftRecoveryRuns）は、録音を始めるときに draft.json を脇へ退けない
let draftRecoveryChain = Promise.resolve();
let draftRecoveryRuns = 0;
function recoverDraftIfAny() {
  draftRecoveryRuns += 1;
  const run = draftRecoveryChain.then(() => recoverDraftsNow());
  draftRecoveryChain = run.then(() => {}, () => {}).then(() => { draftRecoveryRuns -= 1; });
  return run;
}
async function recoverDraftsNow() {
  let unreadable = false;
  let recovered = 0;
  const keep = [];
  for (const name of store.draftFiles()) {
    if (meeting && name === meeting.draftName) continue;   // 今の会議の控えは復旧しない
    if (finalizingDrafts.has(name)) continue;   // 締めの返事を待っている会議の控え（返事の後に締めの道が消す）
    const r = store.readDraftFile(name);
    if (r.state === 'unreadable') { unreadable = true; engineLog(`下書き（${name}）を読めませんでした（${r.code}）。消さずに残します`); continue; }
    if (r.state !== 'ok') continue;   // 無い・壊れている（store が退けて知らせた。N15）
    const d = r.value;
    const draftId = typeof d.pageId === 'string' && d.pageId ? d.pageId : '';
    if (draftId && finalizingPageIds.has(draftId)) continue;
    loadPurgePending();
    if (draftId && purgePending.has(draftId)) {
      // 取り消した会議の下書き（取り消しのときに消せなかった）。ページにしない。写しはもう一度消す
      await purgeMeeting(draftId);
      store.clearDraft(name);
      continue;
    }
    if (!Array.isArray(d.segments) || d.segments.length === 0) {
      // 発言の無い会議はページを作らない（今どおり）。始めたときに送った写し（空）は取り消しと同じに消す（印を先に書く。残すと meeting.settle が
      // 空の「（復旧）」のページにする）。返事は待たない（起動を DB の用意で止めない。控えの ID は settle の keep に入り、次の起動でも送る）
      if (draftId) startPurge(draftId).catch(() => {});   // purgeMeeting は投げない
      store.clearDraft(name);
      continue;
    }
    if (draftId) keep.push(draftId);
    try {
      const dt = new Date(d.startedAt || Date.now());
      // 文字起こしが終わっていなかった区間（pending）は失敗扱いでページに載せ、wav が残っていれば
      // あとで文字起こしして差し替える（mainlib.recoverSegments）。先にページを作るのは、
      // エンジンの起動を待たずに復旧した本文を開けるようにするため
      const rec = recoverSegments(d.segments, (f) => fs.existsSync(f));
      // 要約の欄の文（summaryError）も同じ1回の頼みで入れる（今の「作ってから保存し直す」と同じ中身）
      const { page, already } = await db.call('meeting.recover', { pageId: draftId || store.newId('p'), segments: rec.segments, page: {
        title: `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')} の議事録（復旧）`,
        // 日付はローカルの暦日（#51。UTC で作ると日本の朝の会議が前日になる）
        date: localDateISO(dt),
        durationSec: Math.round((d.offsetMs || 0) / 1000),
        memo: d.memo || '',
        blocks: [],
        createdAt: new Date(d.startedAt || Date.now()).toISOString(),
        recovered: true,
        // 送り直しで数え直す（transcribeRecoveredItems）。会議の印は下書きから写す（第1c回 RF28）
        route: { stt: { cloud: 0, local: 0, provider: sttProvider().id }, localOnly: Boolean(d.localOnly) },
        pauses: d.pauses,   // 止めていた時間の印（形の悪い印は store が捨てる。第1b回 N4c・F6）
        // 議事録の経過（0.10.0 K-1）: 下書きの経過（表に無い項目は落とす）の後に「戻した（アプリ）」
        stateLog: recoveredStateLog(d.stateLog),
        // 0.11.0 M-4: 下書きの種類（照らして、選べる鍵のときだけ。知らない値は自動）
        ...(mtype.isSelectable(d.meetingType) ? { meetingType: d.meetingType, typeAuto: false } : {}),
        summaryError: rec.todo.length
          ? '録音が中断されたため要約は未生成です。残っていた音声の文字起こしを続けています。終わったら「要約を生成」で作成できます。'
          : '録音が中断されたため要約は未生成です。「要約を生成」で作成できます。',
      } });
      store.clearDraft(name);
      if (already) {
        // 締め済みのページ（後からの要約と直しは DB が残した）か、取り消した会議。知らせない
        engineLog(`下書き（${name}）は締め済みか取り消した会議のものだったので片付けました`);
        removeDirIfEmpty(segbufDir(d.startedAt));
        continue;
      }
      recoveredPageId = page.id;
      recovered++;
      if (rec.todo.length) {
        const q = { pageId: page.id, items: rec.todo, dir: segbufDir(d.startedAt), localOnly: Boolean(d.localOnly) };
        // 別の待ち行列があれば、その後に拾う（transcribeRecovered が recovery.json を順に読む）
        if (!recoveryQueue) { recoveryQueue = q; saveRecoveryQueue(recoveryQueue); } else saveRecoveryQueue(q);
      } else removeDirIfEmpty(segbufDir(d.startedAt));
    } catch (e) {
      // ページを保存できなければ控えは消さない（次の機会にもう一度）。記録には理由の符号だけ（fs のエラーの文はパスを含む）
      engineLog(`下書き（${name}）の復旧に失敗: ${errCode(e)}`);
    }
  }
  if (unreadable) {
    if (!draftBusyNoted) { draftBusyNoted = true; laterNotice(NOTICE.draftBusy); }
    scheduleRecoveryRetry();
  }
  // 起動の後で復旧したら（やり直し・録音の前）、一覧を描き直して知らせる。起動の途中は createMainWindow が知らせる
  if (recovered && mainWin) {
    recoveredPageId = null;
    try { sendToMainWin('pages:updated', await db.call('pages.list', {})); } catch (e) { engineLog(`議事録の一覧を読めませんでした: ${errCode(e)}`); }
    noticeMainWin('前回中断された議事録の文字起こしを復旧しました。「要約を生成」から議事録を作成できます。');
  }
  return { unreadable, keep };
}

// 復旧ページの「文字起こし待ち」を、起動が済んでエンジンが用意できてから順に文字起こしし、
// segment.update（recite: false。区間だけを直す）で本文を差し替える（failed が外れて要約の材料に戻る）。
// 失敗した区間は失敗の文を残す。ページが消されていたら残りの wav を捨てて止める。
// 済んだ wav は消し、空になった退避フォルダも消す。
// 「ページが消された」と決めるのは、保存の側がページの読み（page.get）に null と答えたときだけ。読めなかった（投げた）ときは何も消さずに
// 止め、待ち行列を残して次の機会（設定の保存・次の起動）に回す（エンジンが無いときと同じ扱い。第2a1回 F12）
let recoveryRunning = false;
const recoveryEtaTold = new Set();   // 0.9.4 S-4: 目安を知らせた待ち行列（フォルダ）
// 「復旧の文字起こしを保留」を書いた (フォルダ → 理由)。同じ理由では書き直さない（見回りが毎分書かない。第1d2回 M-3）
const recoveryHoldNoted = new Map();
// 第1d2回 M-3: 見回りとログインの直後は、クラウドで送れる待ち行列だけを回す（手元のエンジンを起こさない: RF49）。transcribeRecovered は
// 始めに（await の前に）この頼みを読んで下ろす（引数の無い形は repo・stage2a1 のテストが字面で固定している）
let recoveryCloudOnlyAsk = false;
function transcribeRecoveredCloud() {
  if (recoveryRunning) return Promise.resolve();
  recoveryCloudOnlyAsk = true;
  return transcribeRecovered();
}
// 第1d2回 M-3: 進めない待ち行列（ページはあるが、クラウドも手元もだめ）は飛ばして次へ進み、最後に、進めなかった最初の待ち行列を recoveryQueue に戻す
async function transcribeRecovered() {
  const cloudOnly = recoveryCloudOnlyAsk;
  recoveryCloudOnlyAsk = false;
  if (recoveryRunning) return;
  let q = recoveryQueue;
  if (!q) return;
  recoveryRunning = true;
  updateTray();   // 復旧中は「手が塞がっている」（isBusy）。トレイの有効／無効を追随させる
  recoverySkip = new Set();
  let held = null;
  try {
    const seen = new Set();   // 同じ待ち行列を二度拾わない（recovery.json を消せなかったとき）
    while (q && !seen.has(q.dir)) {
      seen.add(q.dir);
      // エンジンを待つ前に、ページがまだあるかを確かめる（消されていればエンジンを起こさずに片付ける）
      let alive = null;
      try {
        alive = await db.call('page.get', { id: q.pageId });
      } catch (e) {
        engineLog(`復旧の文字起こしを保留: 議事録を読めません（${errCode(e)}）`);
        recoveryQueue = q;
        retryUnsavedRecovery();
        return;
      }
      if (!alive) {
        dropRecoveryQueue(q);
        q = recoveryQueue = loadSavedRecoveryQueue();
        continue;
      }
      // クラウドで処理できるなら手元のエンジンを起こさない（q.localOnly の待ち行列は今どおりエンジンを待つ。第1c回）。cloudOnly はエンジンを待たない
      const cloudReady = await recoveryCloudReady(q);
      const ready = cloudReady || (!cloudOnly && await ensureEngineReady(whisperEng));
      // 0.9.4 S-4（決めたこと 13）: 遅い会議の残した音声を PC で文字起こしするときは、かかる時間の目安を知らせる（待ち行列ごとに1回）
      if (ready && !cloudReady && q.slow && !recoveryEtaTold.has(q.dir)) {
        recoveryEtaTold.add(q.dir);
        const audioMs = q.items.filter((it) => it && it.held !== true).reduce((a, it) => a + (Number(it.durationMs) || 0), 0);
        sendToMainWin('app:notice', `残しておいた音声（約 ${Math.max(1, Math.round(audioMs / 60000))} 分）を文字起こししています。この PC では約 ${Math.max(1, lib.afterEtaMin({ audioMs, rtf: pacedRtf() }))} 分かかります。済むと自動で要約を作ります。`);
      }
      if (!ready) {
        // エンジンが未設定・未起動のときは何も消さない。wav と待ち行列（recovery.json）を残し、
        // 設定を直したとき（settings:save）や次の起動でもう一度ここへ来る。第1d2回 M-3: 飛ばして次の待ち行列へ進む
        const reason = whisperEng.lastError || 'エンジンが起動していません';
        if (recoveryHoldNoted.get(q.dir) !== reason) {
          recoveryHoldNoted.set(q.dir, reason);
          engineLog(`復旧の文字起こしを保留: ${reason}`);
        }
        retryUnsavedRecovery();
        recoverySkip.add(q.dir);
        if (!held) held = q;
        q = recoveryQueue = loadSavedRecoveryQueue();
        continue;
      }
      recoveryQueue = null;
      const kept = await transcribeRecoveredItems(q, { cloudOnly });
      // 0.9.4 S-3（決めたこと 3）: エンジンが誤りを返した区間（3 回まで）と held の区間は音声と待ち行列を残したまま、次の待ち行列へ進む
      // （止めない。残した待ち行列は次の引き金でやり直す: held の区間は送らない）
      if (kept && kept.parked) {
        recoverySkip.add(q.dir);
        if (!held) held = kept;
        q = recoveryQueue = loadSavedRecoveryQueue();
        continue;
      }
      if (kept) {
        // 文字起こしまで届かなかった（クラウドの鍵・上限、手元に落ちたがエンジンが無い）: WAV と待ち行列を残して止め、
        // 設定の保存か次の起動でやり直す（エンジンが未設定のときと同じ扱い）
        recoveryQueue = kept;
        retryUnsavedRecovery();
        return;
      }
      // 別の会議の分（議事録を締めたとき既に待ち行列があった失敗区間）が残っていれば続ける
      q = recoveryQueue = loadSavedRecoveryQueue();
    }
  } finally {
    recoverySkip = null;
    if (held && !recoveryQueue) recoveryQueue = held;   // 進めなかった待ち行列は、次の引き金（取り込んだ組の照らし・設定の保存・起動・見回り）で
    recoveryRunning = false;
    updateTray();
  }
}
// → null（済んだ）| 残した待ち行列（文字起こしまで届かなかった区間から先。WAV と recovery.json を消していない）
// 0.9.4 S-3（決めたこと 3・5・K1）: 音声を消すのは「文字になった」「無音だった」「ページが消えていた」ときだけ。PC の時間切れ（late）・エンジンに届かない
// （down）・録音中（busy。会議の後の PC の文字起こしを止める）は、その区間から先を残して止める。エンジンが答えた誤り（error）は区間ごとの回数
// tries（前の版の待ち行列は 0）を増やし、3 回目までは次の引き金でやり直し、3 回目の後は held（自動ではやり直さない）。どちらも WAV を残し、
// その区間を除いた待ち行列を先へ進めて、最後に { ...q, items: 残した区間, parked: true } を返す（recovery.json に残す）
const RECOVERY_TRIES_MAX = 3;
async function transcribeRecoveredItems(q, { cloudOnly = false } = {}) {
  let done = 0;
  const left = [];   // エンジンが誤りを返して残した区間と held の区間
  const stopAt = (i) => left.concat(q.items.slice(i)).filter((it) => it && it.wav && fs.existsSync(it.wav));
  for (let i = 0; i < q.items.length; i++) {
    const item = q.items[i];
    let alive = null;
    try {
      alive = await db.call('page.get', { id: q.pageId });
    } catch (e) {
      // 読めなかった: 「消された」にしない。この区間から先の音声と待ち行列を残して止める（F12）
      const rest = stopAt(i);
      engineLog(`復旧の文字起こしを止めました（理由: ${errCode(e)}）。残りの ${rest.length} 区間の音声と待ち行列は残します`);
      return { ...q, items: rest };
    }
    if (!alive) { unlinkQuiet(item.wav); continue; }   // ページが消された（DB が null と答えた）
    if (item.held === true) { left.push(item); continue; }   // 3 回失敗した区間は自動ではやり直さない（音声はページを消すまで残す: 問い Q10）
    let text = null;
    let err = '';
    let route = 'local';
    // 0.12.0 SP-3b（決めたこと 144）: 2つの流れの会議（入口のある発言がある）の区間は、会議の後と戻しでも文の頭（parts）を作る
    const twoPage = Boolean(alive.segments && alive.segments.some((s) => s && s.src));
    let sentences = null;
    if (!err) {
      try {
        ({ text, route } = await transcribeAuto(fs.readFileSync(item.wav), '', item.durationMs, { localOnly: recoveryPcOnly(q), cloudOnly, what: `復旧 ${item.id}`, seg: item.id,
          busyStop: () => state !== 'idle', verbose: twoPage, onSentences: (x) => { sentences = x; } }));
        if (settings.removeFillers) text = removeFillersRule(text);
      } catch (e) {
        const kind = e && !e.refused && e.sttRoute && e.sttRoute.route === 'local' ? lib.localFailKind(e) : '';
        if (e && (e.keepForRetry || e.engineMissing || kind === 'late' || kind === 'down')) {
          const rest = stopAt(i);
          engineLog(`復旧の文字起こしを止めました（理由: ${e.cloudCode || (kind === 'late' || kind === 'down' ? kind : 'engine')}）。残りの ${rest.length} 区間の音声と待ち行列は残します`);
          return { ...q, items: rest };
        }
        err = (e && e.message) || '不明なエラー';
      }
    }
    // 経路ごとの数え直し（ページの route.stt。第1c回 OL6）
    // 0.9.1 Q-2: 無音で送らなかった区間（経路 none）は数えない
    if (!err && route !== 'none') await saveIfExists(db, q.pageId, (p) => { if (p.route && p.route.stt) p.route.stt[route] = (Number(p.route.stt[route]) || 0) + 1; });
    if (err) {
      // 失敗の文を残す（segment.update は failed を外してしまうので、失敗の印を付ける命令で書く）。0.9.4 S-3: 音声は残す
      const tries = (Number.isInteger(item.tries) && item.tries > 0 ? item.tries : 0) + 1;
      const held = tries >= RECOVERY_TRIES_MAX;
      await db.call('segment.fail', { pageId: q.pageId, segId: item.id, text: held ? `（この区間の認識に失敗: ${err}。音声は残してあります）` : `（この区間の認識に失敗: ${err}）` });
      left.push(held ? { ...item, tries, held: true } : { ...item, tries });
      continue;
    } else if (text) {
      const parts = twoPage && route === 'local' && sentences ? lib.partsOf(sentences, { text, durationMs: item.durationMs, clean: cleanSentence }) : null;
      if (parts) await db.call('segment.update', { pageId: q.pageId, segId: item.id, patch: { text, parts }, recite: false });
      else await db.call('segment.update', { pageId: q.pageId, segId: item.id, patch: { text }, recite: false });
      done++;
    } else {
      await db.call('segment.remove', { pageId: q.pageId, segId: item.id });   // 無音: 区間ごと消す（記録中と同じ扱い）
      done++;
    }
    // 文字になった・無音だった区間の wav を消す
    unlinkQuiet(item.wav);
  }
  let parked = null;
  if (left.length) {
    parked = { ...q, items: left, parked: true };
    saveRecoveryQueue({ ...q, items: left });
    const heldN = left.filter((it) => it.held === true).length;
    const note = `復旧の文字起こしを保留: 失敗した区間の音声を残しました（${left.length} 区間・自動ではやり直さない ${heldN} 区間・やり直し ${left.map((it) => it.tries).join('・')} 回）`;
    if (recoveryHoldNoted.get(q.dir) !== note) { recoveryHoldNoted.set(q.dir, note); engineLog(note); }
  } else {
    try { fs.unlinkSync(path.join(q.dir, RECOVERY_FILE)); } catch (_) { /* noop */ }
    removeDirIfEmpty(q.dir);
  }
  const cur = await db.call('page.get', { id: q.pageId });
  if (!cur) return parked;
  // 第1d2回 M-3（決めたこと 7）: 締めで要約を待たせた会議（要約の欄が S3・S3'）は、文字になった区間があれば R1 を出して要約を作る（待たない。
  // 経路は runSummary が決める。0.10.0 LS-2: オフラインモードの会議も Claude Code。届かなければ要約待ち）
  const waitText = [KEPT_SUMMARY_TEXT.wait, KEPT_SUMMARY_TEXT.waitLocal];
  if (done > 0 && cur.page && waitText.includes(cur.page.summaryError)) {
    sendToMainWin('pages:updated', await db.call('pages.list', {}));
    const now = await db.call('page.get', { id: q.pageId });
    sendToMainWin('page:updated', { page: (now && now.page) || cur.page, segments: now ? now.segments : cur.segments });
    sendToMainWin('app:notice', `残しておいた音声を文字起こししました（${done}/${q.items.length} 区間）。続けて要約を作ります。`);
    runSummary(q.pageId).catch((e) => engineLog(`文字起こし待ちの後の要約に失敗: ${logReason(e)}`));
    return parked;
  }
  // 「続けています」の文を通常の復旧の文に戻す（別の要約が書いていれば触らない）
  const latest = await saveIfExists(db, q.pageId, (p) => {
    if (String(p.summaryError || '').includes('文字起こしを続けています')) {
      p.summaryError = '録音が中断されたため要約は未生成です。「要約を生成」で作成できます。';
    }
  });
  sendToMainWin('pages:updated', await db.call('pages.list', {}));
  const now = await db.call('page.get', { id: q.pageId });
  sendToMainWin('page:updated', { page: latest || cur.page, segments: now ? now.segments : cur.segments });
  // 0.9.4 S-3（決めたこと 4・問い Q5）: 後回しにした区間が文字になった。要約は自動で作り直さない（その間に直した要約を上書きしない）
  if (q.later) {
    sendToMainWin('app:notice', `残しておいた音声を文字起こししました（${done}/${q.items.length} 区間）。［要約を生成］で議事録を作り直せます。`);
    return parked;
  }
  sendToMainWin('app:notice', q.retry
    ? `認識に失敗していた区間の文字起こしをやり直しました（${done}/${q.items.length} 区間）。「要約を生成」で議事録を作り直せます。`
    : `中断されていた文字起こしの復旧が終わりました（${done}/${q.items.length} 区間）。「要約を生成」で議事録を作成できます。`);
  return parked;
}
// 文字起こし待ちの見回り（第1d2回 M-3・OF3）。60 秒ごとと、ログインの直後に呼ぶ（名前はこのまま: テストの台が setInterval の名前で拾う）。
// 終了の途中・録音中（会議・音声入力）・復旧の途中・オフライン・ログインしていない・hold の間は何もしない（通信もしない）。
// そのほかで待ち行列（recoveryQueue か保存した recovery.json）があれば、クラウドで送れる待ち行列だけを回す（手元のエンジンを起こさない。
// エンジンのある人の PC でも同じ: RF49）。記録は様子（待ち行列の数・理由）が変わったときだけ1行（毎分書かない）
const KEPT_CHECK_MS = 60000;
let keptWatchNote = '';
const savedQueueCount = () => {
  let names = [];
  try { names = fs.readdirSync(segbufRoot()); } catch (_) { return 0; }
  return names.filter((n) => fs.existsSync(path.join(segbufRoot(), n, RECOVERY_FILE))).length;
};
async function retryKeptWhenBack() {
  try { await retrySummaryWaits(); } catch (e) { engineLog(`要約待ちの見回りに失敗: ${logReason(e)}`); }
  try {
    let why = 'ok';
    if (quitting) why = 'quitting';
    else if (meeting || state !== 'idle') why = 'busy';
    else if (recoveryRunning) why = 'running';
    else if (!netOnline()) why = 'offline';
    else if (!hasRelayLogin()) why = 'signed-out';
    else if (holdNow()) why = 'hold';
    const queues = savedQueueCount() || (recoveryQueue ? 1 : 0);
    const dicts = dictWaitCount();   // 第1d2回 M-5: 残した音声入力
    if (queues > 0 || dicts > 0) {
      const note = `${queues}・${dicts}・${why}`;
      if (note !== keptWatchNote) { keptWatchNote = note; engineLog(`文字起こし待ち: 見回り（${note}）`); }
    }
    if (why !== 'ok') return;
    if (!recoveryQueue) recoveryQueue = loadSavedRecoveryQueue();
    if (recoveryQueue) await transcribeRecoveredCloud();
    if (dicts > 0) await transcribeDictWaits();
  } catch (e) {
    engineLog(`文字起こし待ちの見回りに失敗: ${logReason(e)}`);
  }
}
// 消されたページの待ち行列を片付ける（音声と recovery.json と、空になったフォルダ）。ページが null と答えたときだけ呼ぶ
function dropRecoveryQueue(q) {
  for (const it of q.items) if (it && it.wav) unlinkQuiet(it.wav);
  unlinkQuiet(path.join(q.dir, RECOVERY_FILE));
  removeDirIfEmpty(q.dir);
}

// 7 日より古い退避フォルダを消す（復旧されずに残った孤児。判断は mainlib.staleSegbufDirs）。
// 今回復旧中のフォルダ（keepDir）は残す
function cleanOrphanSegbuf(keepDir) {
  let names = [];
  try { names = fs.readdirSync(segbufRoot()); } catch (_) { return; }
  const entries = names.map((name) => {
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(path.join(segbufRoot(), name)).mtimeMs; } catch (_) { /* noop */ }
    return { name, mtimeMs };
  });
  for (const name of staleSegbufDirs(entries, Date.now())) {
    const dir = path.join(segbufRoot(), name);
    if (dir === keepDir) continue;
    // 待ち行列が残っている（エンジンが用意できず 7 日以上そのまま等）フォルダは復旧の材料。
    // 今回の復旧が終わったあと transcribeRecovered が順に拾う
    if (fs.existsSync(path.join(dir, RECOVERY_FILE))) continue;
    // この起動で壊れた recovery.json を退けたフォルダは、その起動では残す（次の起動から片付ける）
    if (quarantinedRecoveryDirs.has(dir)) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* noop */ }
  }
}

// 0.9.4 D-1（持ち主の試作の考え: 状態が変わるたびに、何が変えたかを残す）: 会議の始まりと終わりの引き金を engine.log に符号で1行
// （page・page-offline・panel・panel-offline・hotkey・tray／page・bar・hotkey・auto-quiet・auto-leave）。検出が出なかったときに、何で会議を始めたかが持ち主の記録で分かる
// 0.10.0 K-1（決めたこと 116）: 議事録の経過。引き金の符号 → 経過のきっかけ（表 lib.BY_NAMES の鍵）
// 0.13.0 RDY-1（RD11）: page-offline は録音の前のページの［オフラインモードで始める］
const START_BY = Object.freeze({ page: 'button', 'page-offline': 'button', panel: 'panel', 'panel-offline': 'panel', hotkey: 'hotkey', tray: 'tray' });
const STOP_BY = Object.freeze({ page: 'button', bar: 'overlay', hotkey: 'hotkey', 'auto-quiet': 'quiet', 'auto-leave': 'leave' });   // 0.12.1 LV-3: auto-leave（会議を出たので自動）
// 会議の経過に1つ積み、engine.log に「議事録: 開始（ホットキー）」の1行（題名・文は書かない）。下書きにも書く
function noteMeetingState(m, s, by) {
  if (!m) return;
  const item = { s, by, at: new Date().toISOString() };
  m.stateLog = lib.stateLogAdd(m.stateLog, item);
  const line = lib.stateLogLine(item);
  if (line) engineLog(line);
  if (meeting === m) writeDraft();
}
async function startMeetingBy(trigger, opts = {}) {
  const r = await startMeeting();
  if (r && r.ok) {
    leaveStart(meeting, opts.app);   // 0.12.1 LV-2
    engineLog(`会議: 始めた（${trigger}）`);
    if (meeting.prepAt) notePrep(meeting);   // 0.13.0 RDY-1（RD4）: 録音の前のページから始めた会議だけ、「開始」の前に「ページを開いた」
    noteMeetingState(meeting, 'start', START_BY[trigger] || 'app');
    if (meeting.prepType) noteMeetingState(meeting, 'type', 'live-page');   // 録音の前のページで種類を選んでいた
  }
  return r;
}
// 0.13.0 RDY-1（RD4・持ち主の試作の「履歴の頭は作った」）: 経過に「ページを開いた（画面のボタン）」を開いた時刻で積み、記録に2行（メモの文は書かない）
function notePrep(m) {
  const item = { s: 'prep', by: 'button', at: new Date(m.prepAt || Date.now()).toISOString() };
  m.stateLog = lib.stateLogAdd(m.stateLog, item);
  const line = lib.stateLogLine(item);
  if (line) engineLog(line);
  engineLog('会議: 録音の前のページで始めた');
}
// 0.13.0 RDY-1（RD8）: 録音の前のページのメモと種類を、始めた会議のものにする（startMeeting の中で、最初の下書きと最初の meeting:update より前）
function takePrep(m) {
  if (!prep) return;
  m.memo = prep.memo;
  if (mtype.isSelectable(prep.meetingType)) { m.meetingType = prep.meetingType; m.prepType = true; }
  m.prepAt = prep.openedAt;
  prep = null;
}
// 0.13.0 RDY-1（RD1・RD19）: ［＋ 新しい議事録］ → 録音の前のページを1つ作る（あればそのまま）。録音・下書き・DB の写し・録音バーは始めない。
// 録音中・作成中（会議がある）は断る
function prepareMeeting() {
  if (meeting) return { ok: false };
  if (!prep) {
    prep = { memo: '', meetingType: null, openedAt: Date.now() };
    engineLog('会議: 録音の前のページを開いた');
  }
  sendToMainWin('meeting:update', meetingStatus());
  return { ok: true };
}
// 0.13.0 RDY-1（RD14）: 録音の前のタブを閉じた → 何も残さない
function unprepareMeeting() {
  if (prep) {
    prep = null;
    engineLog('会議: 録音の前のページを閉じた');
  }
  sendToMainWin('meeting:update', meetingStatus());
  return { ok: true };
}
// 0.13.0 RDY-1（RD2・RD11・RD18）: 録音の前のページの［文字起こしを始める］・［オフラインモードで始める］。始めるだけ（録音中・作成中・音声入力の間は
// 止めずに断る: F81）。画面からは { pcOnly: true } だけを読み、きっかけの符号は main が決める
async function startMeetingFromPage(o) {
  const pcOnly = Boolean(o && typeof o === 'object' && o.pcOnly === true);
  if (state !== 'idle' || quitting) return { ok: false, error: '他の処理を実行中です' };
  const r = await startMeetingBy(pcOnly ? 'page-offline' : 'page');
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || '議事録を開始できません' };
  if (pcOnly) setMeetingLocalOnly(true);   // パネルの「オフラインモードで始める」と同じ順（経路の確かめより前なので、クラウドの知らせは出ない）
  return { ok: true, localOnly: pcOnly };
}
function stopMeetingBy(trigger) {
  const m = meeting;
  const r = stopMeeting();
  if (r && r.ok) {
    engineLog(`会議: 止めた（${trigger}）`);
    noteMeetingState(m, trigger === 'auto-quiet' || trigger === 'auto-leave' ? 'auto-stop' : 'stop', STOP_BY[trigger] || 'app');
  }
  return r;
}
async function startMeeting() {
  // 終了・再起動の途中（quitting。DB を閉じている間など）は始めない（始めると relaunch・終了で録音が切れる。第1d回 A-9 の点検）
  if (state !== 'idle' || quitting) return { ok: false, error: '他の処理を実行中です' };
  // 第1d2回 M-1（D21）: 手元が使えるかクラウドが使えそうなら始める。選んだ人で両方だめなら今の文で始めない。選んでいない人は始めて音声を残す
  // （mainlib.startPlan。keep は会議に覚える: M-2 が残し方と知らせに使う）
  const cloudAtStart = cloudNow();
  const plan = startPlan({ localUsable: engineValid(whisperEng), chosen: isOfflineChosen(), cloud: cloudAtStart.cloud, problem: whisperProblem(), why: cloudAtStart.why });
  if (!plan.ok) return { ok: false, error: plan.error };
  // 前の起動で読めなかった控えが残っていれば、始める前に1回だけ復旧を試す（第1a回 JS9）。復旧のページは
  // db.call で作るので待つ（待たずに進むと、復旧中の draft.json を下の chooseDraftName が脇へ退け、消しそこねて2つ目のページになる）。
  // 待つ間に別の処理が始まっていたら始めない（第2a1回 ST1）。DB の用意の前（移行の窓・移行・起こし直し）は待たない（録音は DB に頼らない:
  // F9）。そのときは回している復旧の下書きを脇へ退けない（下の park）ので、この会議の下書きは draft-<開始時刻>.json になる
  if (store.draftFiles().length && !['starting', 'migrating'].includes(db.state())) {
    await recoverDraftIfAny();
    if (state !== 'idle' || quitting) return { ok: false, error: '他の処理を実行中です' };
  }
  const startedAt = Date.now();
  // 会議のページの ID はここで作って下書きに書く。写し・締め・復旧・取り消しは同じ ID に書く（第2a1回 ST6。DB は同じ ID を上書きする）
  const pageId = store.newId('p');
  // 古い draft.json が残っていれば脇へ退けてから draft.json に、退けられなければ draft-<開始時刻>.json に書く。
  // 締めの返事を待っている会議の draft.json は退けない（返事の後に締めの道が消す名前が変わらないように）。復旧を回している間も退けない
  // （復旧が読んだ draft.json を消せずに、次の復旧がもう一度ページにする）
  const draftName = chooseDraftName({ existing: store.draftFiles(), startedAt, park: () => (finalizingDrafts.has('draft.json') || draftRecoveryRuns > 0 ? { ok: false } : store.parkDraft()) });
  if (draftName !== 'draft.json') engineLog(`前の下書きを退けられないので、この会議の下書きは ${draftName} に書きます`);
  // meetingType: 0.11.0 M-4（決めたこと 11）録音中のページで選んだ種類。null は自動（選んでいない）。新しい会議はいつも自動から（D50）
  meeting = { pageId, startedAt, draftName, memo: '', meetingType: null, segments: [], offsetMs: 0, stopping: false, seq: 0,
    systemAudio: false, paused: false, pausedMs: 0, pausedAt: 0,
    // gen: 打ち切り（meeting:skipPending）で進める世代。進行中の結果を捨てる判断に使う
    // segmentMs: いま録音側に頼んでいる区間の長さ（経路と背圧で伸縮する。第1d回 A-5: 下の segMode と segmentBaseMs で決めて上書きする）
    // inFlightSince: 文字起こし中の区間の開始時刻（残り時間の見積もりで経過分を引く）
    // finalSeen: 録音側の最後の区間が届いたか。skipAll: 打ち切り後に届く区間も文字起こしせず数だけ残す
    // emptySegs: 文字起こしが空で除いた区間の数（全部が空なら、締めるときに知らせる）
    gen: 0, skipped: 0, micFallback: false, segmentMs: 0, inFlightSince: 0,
    finalSeen: false, skipAll: false, emptySegs: 0,
    // 第1b回 A-3: pauses は再開した一時停止の印、pauseAsked は録音バーに頼んで返事を待つ間、pauseWhy は今の一時停止の理由、
    // suspendAsked はスリープで頼んだ、hintOnPause は復帰の頼み直しの返事で再開を促す、resumeHint は再開を促している
    pauses: [], pauseAsked: false, pauseAskTimer: null, pauseWhy: '', suspendAsked: false, hintOnPause: false, resumeHint: false,
    // 第1c回: localOnly は［この会議は PC の中だけ］、route は経路ごとの文字起こしできた区間の数、notified は会議ごとの知らせの印
    localOnly: false, route: { cloud: 0, local: 0 }, notified: new Set(),
    // 第1d回 A-6（D17）: stt は最後に文字になった区間の経路と時刻、problems は帯の符号 → 詳しさ、stallRun は続けて空だった音のある区間の数、
    // quietKept はその区間（WAV を消さずに控える。止まりとみなしたら失敗の区間としてページへ戻す）、retrying は［もう一度］で並べ直した区間の id
    stt: { route: '', lastTextAt: null }, problems: new Map(), stallRun: 0, quietKept: [], retrying: new Set(),
    // 第1d回 A-8（D17）: Windows の知らせの間引き（mainlib.notifyGate。出した符号と、最後に出した時刻）
    winNotify: { sent: [], lastAt: 0 },
    // 第1d2回 M-1: 始めたときの残し方（mainlib.startPlan の keep。'' | 'login' | 'wait'）
    keepAtStart: plan.keep,
    // 0.9.1 Q-2: この会議で認識ヒントの繰り返しとして除いた答え（畳んだ形。メモリの中だけ・20 まで）
    echoSeen: new Set(),
    // 0.9.1 Q-4: 話し声が無いときに聞いて止める見張り（mainlib.quietStep の st。会議の時計）・録音バーへの送り直しのタイマー・Windows の知らせ・
    // 聞いている間に止めた（所要時間の終わりを切る）・自動で止めた（保存の後に知らせる）
    quiet: { sinceMs: 0, untilMs: 0, askedAt: null, askMin: 0 }, quietBar: null, quietNote: null, quietTrim: false, autoStopped: false };
  // 第1d回 A-5（D16）: 始めの区切り。中継へ届くかは聞かない（録音の始まりを待たせない）。札があるか（復号しない）・hold・net.isOnline()・
  // 覚えている /health の答えだけで決め、外れたら区間の後で替わる（segmentRouted）
  const h0 = holdNow();
  const segMode = startSegmentMode({ localOnly: false, signedIn: hasRelayLogin(), hold: h0 ? h0.why : '', netOnline: netOnline(), peekUp: online.peek(sttProvider().reachUrl) });
  meeting.segMode = { mode: segMode, localRun: 0, cloudRun: 0 };
  meeting.two = twoInit();   // 0.12.0 SP-3a: 2つの流れ（相手の声を取り込めたら使う）
  takePrep(meeting);   // 0.13.0 RDY-1（RD8）: 録音の前のページのメモと種類（最初の下書きより前）
  meeting.segmentMs = segmentBaseMs(segMode, settings.segmentSec);
  engineLog(`文字起こしの状態: 区切り ${meeting.segmentMs / 1000} 秒（${segMode}・理由 start）`);
  paceStart(meeting);   // 0.9.4 S-4
  segChain = Promise.resolve(); pendingSegs = 0;
  state = 'meeting';
  writeDraft();
  // DB の写しを始める（返事を待たない。失敗しても録音は続け、締め・復旧が下書きから作る）
  db.send('meeting.begin', { pageId, startedAt, localOnly: false });
  warmWhisper().catch((e) => engineLog(`文字起こしエンジンの先読みに失敗: ${logReason(e)}`));
  // 経路を1回聞き、クラウドなら会議の始めの知らせ（M1）
  announceSttRoute(meeting);
  // 要約は利用者の Claude Code で作る（0.10.0 LS-2・D59）。手元の要約のエンジンは起こさない
  placeOverlayForRecording();
  overlayWin.showInactive();
  // 音声入力の開始（上の 'dictation'）には systemAudio を渡さない。
  // あちらは常にマイクだけで、今回の変更で挙動が変わってはいけない。
  const payload = {
    mode: 'meeting', segmentSec: meeting.segmentMs / 1000,
    micId: settings.micId || '', sound: Boolean(settings.soundFeedback),
    systemAudio: Boolean(settings.useSystemAudio),
    form: overlayForm,
    keys: panelKeys('meetingHotkey'),
  };
  if (payload.systemAudio && overlayWin && !overlayWin.isDestroyed()) {
    // 相手の声の取り込みは「ユーザー操作の直後」でないと拒まれることがある。
    // オーバーレイはホットキーで出る焦点の当たらない小窓なので、
    // executeJavaScript の第2引数でその扱いにして呼ぶ。
    // 失敗したら従来の IPC 経路へ落とす（マイクだけにはなるが録音は始まる）。
    overlayWin.webContents
      .executeJavaScript(`window.__koeStart(${JSON.stringify(payload)})`, true)
      .catch(() => sendToOverlay('overlay:start', payload));
  } else {
    sendToOverlay('overlay:start', payload);
  }
  startMeetingTick();
  startOfflineWatch();   // 0.9.0 B-2
  updateTray();
  sendToMainWin('meeting:update', meetingStatus());
  return { ok: true };
}

function stopMeeting() {
  if (state !== 'meeting') return { ok: false };
  state = 'meeting-finalizing';
  meeting.stopping = true;
  // 0.9.1 Q-4（決めたこと 11）: 聞いている間に止めたら（自動でも、帯の［終了して作成］・ホットキー・録音バー・トレイでも）、話し声の無い終わりを
  // 所要時間から外す。聞いた知らせを閉じる（録音バーへは送らない: この後の「議事録を作成中…」を消さない）
  if (meeting.quiet && meeting.quiet.askedAt !== null) meeting.quietTrim = true;
  closeQuietAsk(meeting);
  // 会議の長さはここまで。以降の文字起こし待ちを所要時間に混ぜると、
  // 実際の会議時間が分からなくなる（4分の会議が12分と記録されていた）。
  meeting.stoppedAt = Date.now();
  // 一時停止したまま停止したら、停止時刻で一時停止を締める。開けたままだと
  // 所要時間の計算が「今」まで一時停止として引き、文字起こし待ちの分だけ
  // 短くなる（待ちが長いと負になる）。
  if (meeting.paused) {
    meeting.pausedMs += meeting.stoppedAt - meeting.pausedAt;
    meeting.paused = false;
    meeting.pausedAt = 0;
  }
  sendToOverlay('overlay:stop', {});   // 0.9.4 P-1（F2）: 録音バーはその場で薄く消える（「議事録を作成中…」を送らない）
  if (twoMeeting(meeting) && !meeting.finalSeen) armTwoFinalWait(meeting);   // 点検の直し C1
  sendToMainWin('meeting:progress', { message: '録音を終了し、残りの文字起こしを処理しています…' });
  updateTray();
  // 開始・破棄と同じく状態を送る。これが無いと、ホットキーやトレイから
  // 終了したときにボタンが「■ 終了して作成」のまま残る。
  sendToMainWin('meeting:update', meetingStatus());
  return { ok: true };
}

function discardMeeting() {
  if (state !== 'meeting' && state !== 'meeting-finalizing') return { ok: false };
  sendToOverlay('overlay:cancel', {});
  const m = meeting;
  closeQuietAsk(m);   // 0.9.1 Q-4
  cleanupSegbuf(m);
  // 写しの発言を DB に残さない（第2a1回 RF16）。取り消しの印（purge-pending.json）を先に書いてから下書きを消し、DB の purge は裏で待つ
  const purging = startPurge(m.pageId);
  meeting = null; store.clearDraft(m.draftName);
  purging.catch(() => {});   // purgeMeeting は投げない（失敗は記録して次の起動に回す）
  segChain = Promise.resolve(); pendingSegs = 0;
  state = 'idle'; updateTray();
  sendToMainWin('meeting:update', meetingStatus());
  runDraftRetryAfterMeeting();
  return { ok: true };
}

async function toggleMeetingByHotkey() {
  if (state === 'idle') {
    const r = await startMeetingBy('hotkey');
    createMainWindow();
    if (!r.ok) sendToMainWin('app:notice', r.error || '議事録を開始できません');
  } else if (state === 'meeting') stopMeetingBy('hotkey');
}

function onMeetingSegment(buffer, durationMs, isFinal, metaIn) {
  if (!meeting) return;
  // 文字起こしは録音より遅れて終わる。その間に議事録が破棄されて次の記録が
  // 始まっていることがあるので、この区間が属する議事録を捕まえておき、
  // 「今も同じ議事録か」で判断する。単なる null 判定だと、破棄した議事録の
  // 発言が次の議事録に紛れ込む。
  const m = meeting;
  // 0.12.0 SP-3a（D66・決めたこと 124・125・135・147）: 2つの流れの区間（録音バーの4つ目）。照らせなければ今の1本の道
  const meta = metaIn === undefined || metaIn === null ? null : lib.checkSegMeta(metaIn, { sysEver: m.two.sysEver });
  if (metaIn !== undefined && metaIn !== null && !meta) noteBadMeta(m);
  const lane = meta ? (meta.src === 'loopback' ? 'loopback' : 'mic') : '';
  let segOffset;
  if (lane) {
    // 無音の区間は区間にしない（空の音声に替える）・頭の無音を切る・始まりの時刻は流れの時計から・会議の時計は終わりの遅い方
    const r = streamSegment(m, lane, meta, buffer, durationMs);
    buffer = r.buffer; durationMs = r.durationMs; segOffset = r.atMs;
  } else {
    segOffset = m.offsetMs;
    m.offsetMs += durationMs;
  }
  if (isFinal) m.finalSeen = true;
  // 打ち切り（meeting:skipPending）の後に届いた区間（録音側で変換中だった最後の区間）は
  // 文字起こしせず「打ち切り」として残す。黙って捨てると残り件数にも出ず、痕跡が無くなる
  if (m.skipAll) {
    if (buffer.byteLength >= 4000) {
      // 0.9.4 S-3: 後回しの後に届いた区間も、音声を残せれば「文字起こし待ち」（会議の後に文字起こしする）
      const wav = spoolSegment(segbufDir(m.startedAt), m.seq + 1, buffer);
      if (wav) m.segments.push({ id: `s${++m.seq}`, atMs: segOffset, durationMs, text: lib.SKIP_KEPT_TEXT, failed: true, kept: true, wav });
      else m.segments.push({ id: `s${++m.seq}`, atMs: segOffset, durationMs, text: '（文字起こしを打ち切り）', failed: true });
      m.skipped++;
      if (lane) tagSeg(m.segments[m.segments.length - 1], lane, meta);   // 0.12.0 SP-3a: 打ち切りの後の区間も入口を持つ
      writeDraft();
    }
    sendToMainWin('meeting:update', meetingStatus());
    if (isFinal) maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
    return;
  }
  // 短すぎる端切れ（無音の切れ端）は区間にしない。件数には数え、最後の区間なら締めの引き金にする
  let seg = null;
  if (buffer.byteLength >= 4000) {
    // 音声を先にディスクへ退避し、区間を「文字起こし待ち」として draft に控える（#8/#42）。
    // 文字起こしは録音より遅れて終わる。その間にアプリが落ちても、wav が残っていれば
    // 次回起動時に文字起こしして復旧できる
    seg = { id: `s${++m.seq}`, atMs: segOffset, durationMs, pending: true, wav: '', text: '' };
    if (lane) tagSeg(seg, lane, meta);   // 0.12.0 SP-3a（決めたこと 121）: 入口（src）は音の入口で決める。1本の会議には付けない
    seg.wav = spoolSegment(segbufDir(m.startedAt), m.seq, buffer);
    m.segments.push(seg);
    writeDraft();
  }
  // 打ち切り（meeting:skipPending）で世代が進んだら、進行中・待ち行列の結果は捨てる
  const gen = m.gen;
  pendingSegs++;
  applySegmentLength(m, 1, 'backpressure');
  // 0.9.4 S-4（決めたこと 9 の (d)）: PC で処理を待っている区間の音声の合計（PC の側の会議のとき）
  if (m.localOnly || (m.segMode && m.segMode.mode === 'long')) paceEvent(m, { kind: 'backlog', audioMs: pendingDurationMs(m.segments) });
  sendToMainWin('meeting:update', meetingStatus());
  const work = async () => {
    if (meeting !== m || m.gen !== gen || !seg) return;
    // 直近の「成功した」区間の末尾。失敗区間のエラー文を渡すと、次の区間が
    // それを文例として真似る（mainlib.promptTail。待ちの区間は飛ばす）。
    // 0.12.0 SP-3a（決めたこと 126）: 2つの流れの会議の認識ヒントは同じ流れの直前の済んだ区間から
    const tail = promptTail(lane ? laneSegs(m, lane) : m.segments);
    const t0 = Date.now();
    m.inFlightSince = t0;
    let text = '';
    let route = 'local';
    let why = 'engine';
    let scope = '';
    let silent = false;
    let echo = false;
    let echoFold = '';
    let loudDbfs = null;
    let procMs = null;   // 0.9.4 S-4: PC への要求の時間（transcribeLocal の onTimed）
    let sentences = null;   // 0.12.0 SP-3b: PC の whisper の文（verbose_json の segments）
    // 第1d回 A-6: OpenAI の短い 429 を待つ間の帯 wait（区間が終わったら消す）
    const onWait = (sec) => { if (meeting === m && m.gen === gen) { setSttProblem(m, 'wait', { sec }); sendToMainWin('meeting:update', meetingStatus()); } };
    try {
      ({ text, route, why, scope, silent, echo, echoFold, loudDbfs } = await transcribeAuto(buffer, tail, durationMs, { isStale: () => meeting !== m || m.gen !== gen, learn: true, localOnly: m.localOnly, notice: m, what: `区間 ${seg.id}`, seg: seg.id, onWait, gate: Boolean(lane), verbose: Boolean(lane), onSentences: (x) => { sentences = x; },
        paceSlow: () => Boolean(m.pace && m.pace.slow), onTimed: (ms) => { procMs = ms; } }));
    } catch (e) {
      if (meeting !== m || m.gen !== gen) return;
      m.inFlightSince = 0;
      clearSttProblem(m, 'wait');
      // 第1d2回 M-2（D21）: 準備を選んでいない PC で音声を残した区間（kept）は、エンジンの帯でなく kept の帯と残し始めの知らせ。
      // 中継が断った区間（refused）は今の失敗の区間で、帯は B4 だけ（B1・中継の帯を立てない）。0.9.4 S-2: PC の時間切れ・届かないも残す（noteSegFailure）
      const failText = noteSegFailure(m, seg, e);
      const lateNow = Boolean(e && !e.slowKept && e.sttRoute && e.sttRoute.route === 'local' && lib.localFailKind(e) === 'late');   // 0.9.4 S-4
      // 失敗は手元の側に数える。手元に落ちた区間でエンジンも失敗したら、落ちた理由（login・daily-cap などはすぐ長い側。A-5 の点検）、
      // 中継の失敗の符号があればその符号（rate-long など）、どちらも無ければ手元のエンジンの失敗 engine
      // 0.9.4 S-4: 遅い PC で音声を残した区間は slow（すぐ長い側。mainlib.segmentModeNext）
      const failWhy = (e && e.slowKept && 'slow') || (e && e.sttRoute && typeof e.sttRoute.why === 'string' && e.sttRoute.why) || (e && typeof e.cloudCode === 'string' && e.cloudCode) || 'engine';
      segmentRouted(m, 'local', failWhy);
      // 残した区間は「文字起こし待ち」の失敗の区間（WAV を残す: settleSegment。締めで待ち行列に載る）
      settleSegment(m, seg, { text: failText, failed: true });
      if (lateNow) paceEvent(m, { kind: 'late' });   // 0.9.4 S-4（決めたこと 9 の (c)）: 時間切れは遅い PC の印
      // 0.9.1 Q-4（決めたこと 7）: 文字起こしできていない区間は、無音の判定を通った音声なので話し声ありに数える（分からないときは止めない側）
      noteHeard(m, seg, 'speech');
      return;
    }
    if (meeting !== m || m.gen !== gen) return;
    m.inFlightSince = 0;
    clearSttProblem(m, 'wait');
    // 0.9.1 Q-2: 無音で送らなかった区間は、空の区間と同じに除く（経路・区切り・帯・止まりの見張りには渡さない。全部が空の知らせには数える）
    if (silent) {
      m.emptySegs++;
      settleSegment(m, seg, null);
      noteHeard(m, seg, 'quiet');   // 0.9.1 Q-4
      return;
    }
    noteSttRoute(m, { route, why, scope });
    segmentRouted(m, route, why);
    m.route[route] += 1;   // 経路ごとの、文字起こしできた区間の数（ページの route.stt。第1c回 OL6）
    eta.record(Date.now() - t0, durationMs, route);   // 成功した区間だけで、経路ごとに学習（失敗は時間の目安にならない。クラウドの速さを手元の見積もりに混ぜない）
    m.etaRoute = route;
    // 実際の速さを残す（第0b回 Task 16）。0.9.4 S-4（決めたこと 7・8）: 処理の時間は PC への要求の時間だけ。10 秒以上の区間を遅い PC の判断に数える
    if (route === 'local') {
      const pm = Number.isFinite(procMs) ? procMs : Date.now() - t0;
      const sp = speedLine('whisper', { audioMs: durationMs, procMs: pm }); if (sp) engineLog(sp);
      if (Number.isFinite(procMs) && durationMs >= 10000) paceEvent(m, { kind: 'sample', audioMs: durationMs, procMs });
    }
    if (settings.removeFillers) text = removeFillersRule(text);
    // 空・直前と同じ（繰り返しハルシネーション）は区間ごと消す
    // 0.9.1 Q-2（決めたこと 4）: 話し声の大きさより小さな区間（一番大きい窓が SPEECH_DBFS より小さい）では、直前の2つの済んだ区間のどちらかと同じ文
    // （交互の作り話 A・B・A・B）も消す。この会議で認識ヒントの繰り返しとして除いた答えと同じ文も消す
    if (echo && echoFold) { m.echoSeen.add(echoFold); if (m.echoSeen.size > 20) m.echoSeen.delete(m.echoSeen.values().next().value); }
    // 0.12.0 SP-3a（決めたこと 126）: 作り話の繰り返しの見張りも同じ流れの区間だけで見る（相手の行と同じ文のマイクの行は回り込みとして見る）
    const done = (lane ? laneSegs(m, lane) : m.segments).filter((s) => !s.pending);
    const recent = done.slice(Number.isFinite(loudDbfs) && loudDbfs < SPEECH_DBFS ? -2 : -1).map((s) => s.text);
    const repeat = Boolean(text) && ((text.length > 6 && recent.includes(text)) || m.echoSeen.has(hintFold(text)));
    if (!text || repeat) {
      if (!text) m.emptySegs++;
      engineLog(`区間 ${seg.id}（音声 ${Math.round(durationMs / 1000)} 秒）: ${repeat ? '直前と同じ文のため' : echo ? '認識ヒントの繰り返しのため' : '文字起こしが空のため'}除きました`);
      // 第1d回 A-6: 音のある空はページから除くが WAV は控える（止まりの見張り）。直前と同じ文で除いた区間は数えも戻しもしない
      // 0.9.1 Q-2（決めたこと 6）: 認識ヒントの繰り返しで除いた区間も止まりの見張りに渡さない（音のある作り話で帯 stall を出さない）
      // 0.9.1 Q-4（決めたこと 7）: 音のある空（止まりの見張りが控えた区間）は話し声ありに、無音の空・作り話・繰り返しは話し声なしに数える
      if (!text && !echo && noteEmptySegment(m, seg, buffer)) { noteHeard(m, seg, 'speech'); return; }
      settleSegment(m, seg, null);
      noteHeard(m, seg, 'quiet');
      return;
    }
    noteSttText(m, route);
    // 0.12.0 SP-3b（決めたこと 128）: PC の側の長い区間は、whisper の文の時刻で文の頭（parts）を作る。作れなければ1行（S5 (a)）
    const parts = lane && route === 'local' && sentences ? lib.partsOf(sentences, { text, durationMs, clean: cleanSentence }) : null;
    settleSegment(m, seg, parts ? { text, parts } : { text });
    // 0.12.0 SP-3a（決めたこと 129・S9 (a)）: 相手の声の回り込み（同じ言葉のマイクの行）を除く。後に文字起こしを終えた方の時に見る
    if (lane && bleedCheck(m, lane, seg)) { noteHeard(m, seg, 'quiet'); return; }
    noteHeard(m, seg, 'speech');   // 0.9.1 Q-4
    // 第1d2回 M-3（OF3）: 中継が戻った（この区間がクラウドで文字になった）。録音中で PC の中だけでなければ、残した区間を古い順に2つまで並べ直す
    if (route === 'cloud' && !m.stopping && !m.localOnly && m.segments.some((s) => s.kept)) retryFailedSegments({ only: 'kept', max: KEPT_RETRY_MAX });
  };
  const after = () => {
    // 破棄済みの議事録の区間は、破棄時に数え直した件数を減らさない
    if (meeting === m) { pendingSegs = Math.max(0, pendingSegs - 1); applySegmentLength(m, -1, 'backpressure'); clearSttProblem(m, 'wait'); }
    sendToMainWin('meeting:update', meetingStatus());
    if (meeting === m && (isFinal || (m.stopping && pendingSegs === 0))) {
      maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
    }
  };
  // 0.12.0 SP-3a（決めたこと 126）: 2つの流れの会議は流れごとの鎖（クラウドへは2つが同時に出る。マイクの行が相手の行の後ろで待たない）
  if (lane) m.two.streams[lane].chain = m.two.streams[lane].chain.then(work).catch(() => {}).finally(after);
  else segChain = segChain.then(work).catch(() => {}).finally(after);
}

// ---- 0.12.0 SP-3a: 2つの流れの区間（計画 docs/plans/2026-10-22-120.md の決めたこと 122〜141・147）
function twoStream() {
  return { offsetMs: 0, endMs: 0, vad: new Map(), askAt: 0, askSeg: -1, chain: Promise.resolve(), stall: null };
}
function twoInit() {
  // sysEver: この会議で一度でも相手の声を取り込めたか（決めたこと 147）・sysLog: 経過に積んだ取り込みの有無（'' | 'ok' | 'lost'）・
  // on: 2つの流れの区間を受けたか・quiet: 無音で止める見張りの合わせ（quietUnion）・counts: engine.log の数（決めたこと 136）
  return { sysEver: false, sysLog: '', on: false, streams: { mic: twoStream(), loopback: twoStream() }, quiet: null,
    counts: { mic: 0, loopback: 0, idle: 0, bleed: 0 }, badMeta: 0 };
}
// 2つの流れの会議か（2つの流れの区間を受けた・一度でも相手の声を取り込めた: 録音バーは取り込めたら2つの録音で録る）
const twoMeeting = (m) => Boolean(m && m.two && (m.two.on || m.two.sysEver));
// 点検の直し C1: 締めの待ちの見張り（止めてから TWO_FINAL_WAIT_MS。後回し（skipPending）の見張りと同じ 60 秒）。最後の区間が届かなければ締める
const TWO_FINAL_WAIT_MS = 60000;
function armTwoFinalWait(m) {
  setTimeout(function twoFinalWait() {
    if (meeting !== m || m.finalSeen) return;
    engineLog('締めの待ち: 録音バーの最後の区間が 60 秒届かなかったので締めました（2つの流れ）');
    m.finalSeen = true;
    if (pendingSegs === 0) maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
  }, TWO_FINAL_WAIT_MS);
}
// 相手の声の取り込みの移り変わりを経過に積む（決めたこと 137: 始めに取り込めなかったら sys-lost を1つ。取り込めたら積まない。変わったときだけ）
function noteSysSource(m, ok) {
  if (ok) {
    m.two.sysEver = true;
    if (m.two.sysLog === 'lost') noteMeetingState(m, 'sys-back', 'overlay');
    m.two.sysLog = 'ok';
  } else if (m.two.sysLog !== 'lost') {
    noteMeetingState(m, 'sys-lost', 'overlay');
    m.two.sysLog = 'lost';
  }
  syncLevelAsk();
}
function noteBadMeta(m) {
  if (!m.two.badMeta) engineLog('録音バーの区間の4つ目を読めませんでした（1本の区間として扱います）');
  m.two.badMeta += 1;
}
function tagSeg(seg, lane, meta) {
  if (meta.src) seg.src = meta.src;
  segLane.set(seg, lane);
}
// 今録っている流れの数（相手の声の流れが終わった後はマイクの流れだけ: 背圧の割り算。決めたこと 133）
function liveLanes(m) {
  return m.two.quiet && m.two.quiet.ended && m.two.quiet.ended.loopback ? 1 : 2;
}
function laneSegs(m, lane) {
  return m.segments.filter((s) => segLane.get(s) === lane);
}
// 区間の時刻・無音・頭を決める → { buffer, durationMs, atMs }（無音で捨てる区間は空の音声。決めたこと 124・125・140）
function streamSegment(m, lane, meta, buffer, durationMs) {
  const L = m.two.streams[lane];
  m.two.on = true;
  const now = Date.now();
  const activeMs = now - m.startedAt - (m.pausedMs || 0) - (m.paused && m.pausedAt ? now - m.pausedAt : 0);
  const origMs = Math.max(0, Number(durationMs) || 0);
  const baseAt = lib.segAtOf({ t0: meta.t0, prevEndMs: L.endMs, offsetMs: L.offsetMs, activeMs });
  L.offsetMs = baseAt + origMs;
  L.endMs = Math.max(L.endMs, baseAt + origMs);
  m.offsetMs = lib.clockOf(m.two.streams);
  if (lane === 'loopback' && m.two.quiet && m.two.quiet.ended && m.two.quiet.ended.loopback && !meta.last) {
    m.two.quiet = { ...m.two.quiet, ended: { ...m.two.quiet.ended, loopback: false } };   // 再開で取り込めた（相手の声の流れが戻った）
  }
  const rec = L.vad.get(meta.seg);
  for (const k of [...L.vad.keys()]) if (k <= meta.seg) L.vad.delete(k);
  const big = Buffer.isBuffer(buffer) && buffer.byteLength >= 4000;
  if (big) m.two.counts[lane] += 1;
  let out = { buffer, durationMs: origMs, atMs: baseAt };
  const cloud = !m.localOnly && m.segMode && m.segMode.mode === 'short';
  if (rec && cloud && big) {
    const v = lib.vadSummary(rec.st);
    if (v.voicedMs === 0) {
      // 声のフレームが1つも無く、WAV も話し声より小さい区間は送らず、音声も残さず、ページに出さない（小さな声を落とさないため両方のとき）
      const loud = wavLoudestDbfs(buffer);
      if (loud !== null && loud < SPEECH_DBFS) {
        m.two.counts.idle += 1;
        m.emptySegs++;
        out = { buffer: Buffer.alloc(0), durationMs: origMs, atMs: baseAt };
        const ghost = { atMs: baseAt, durationMs: origMs };
        segLane.set(ghost, lane);
        noteHeard(m, ghost, 'quiet');
      }
    } else if (v.firstVoiceMs > lib.PRE_ROLL_MS) {
      // 最初の声の PRE_ROLL_MS 前より前を切る。切った分を atMs に足す（決めたこと 125 (b)）
      const cut = v.firstVoiceMs - lib.PRE_ROLL_MS;
      const trimmed = lib.wavFrom(buffer, cut);
      if (trimmed !== buffer) out = { buffer: trimmed, durationMs: Math.max(0, origMs - cut), atMs: baseAt + cut };
    }
  }
  // 相手の声の流れが終わった（取り込みが切れた）。無音で止める見張りは以後マイクの流れだけで見る（決めたこと 133）
  if (lane === 'loopback' && meta.last && !m.stopping) {
    const ghost = { atMs: L.endMs, durationMs: 0 };
    segLane.set(ghost, lane);
    noteHeard(m, ghost, 'end');
  }
  return out;
}
// 回り込み（決めたこと 129）: マイクの行の文が、時刻の重なる（前後 BLEED_NEAR_MS）相手の行の文に BLEED_SHARE 以上含まれていれば、そのマイクの行を除く。
// 除いたら true（この区間がマイクの行のとき）。文は記録に書かない（数だけ）
function bleedCheck(m, lane, seg) {
  const near = (a, b) => a.atMs - lib.BLEED_NEAR_MS < b.atMs + (b.durationMs || 0) && b.atMs - lib.BLEED_NEAR_MS < a.atMs + (a.durationMs || 0);
  const textOf = (k) => m.segments.filter((s) => segLane.get(s) === k && !s.pending && !s.failed && s.text);
  const isBleed = (mic) => lib.bleedOf(mic.text, textOf('loopback').filter((l) => near(mic, l)).map((l) => l.text)) >= lib.BLEED_SHARE;
  const drop = (s) => {
    const i = m.segments.indexOf(s);
    if (i < 0) return;
    m.segments.splice(i, 1);
    m.two.counts.bleed += 1;
    writeDraft();
    sendToMainWin('meeting:update', meetingStatus());
  };
  if (lane === 'mic') {
    if (!isBleed(seg)) return false;
    drop(seg);
    return true;
  }
  for (const s of textOf('mic').filter((x) => near(x, seg))) if (isBleed(s)) drop(s);
  return false;
}
// 2つの流れの止まりの見張り（決めたこと 141）: 音のある空の区間の長さの和で決める（区間の数で決めない）。控えたら true
function noteEmptyTwo(m, lane, seg, buffer) {
  const L = m.two.streams[lane];
  const before = L.stall && L.stall.n ? L.stall.n : 0;
  const r = lib.stallStepMs(L.stall, { text: '', levelDbfs: wavLevelDbfs(buffer), durationMs: seg.durationMs });
  if (r.st.n === before) return false;
  L.stall = r.st;
  const i = m.segments.indexOf(seg);
  if (i >= 0) m.segments.splice(i, 1);
  delete seg.pending;
  m.quietKept.push(seg);
  if (r.stall) { L.stall = null; stallReached(m); }
  refreshSegFailed(m);
  writeDraft();
  sendToMainWin('meeting:update', meetingStatus());
  return true;
}
// 2つの流れの区間の話し声の有無を、どちらの流れにも話し声の無い時間だけにして quietStep に渡す（決めたこと 133）
function feedQuietTwo(m, lane, kind, seg) {
  const u = lib.quietUnion(m.two.quiet, { src: lane, kind, endMs: seg.atMs + seg.durationMs });
  m.two.quiet = u.st;
  for (const f of u.feed) noteHeard(m, { atMs: f.endMs, durationMs: 0 }, f.kind);
}

async function maybeFinalizeMeeting() {
  if (!meeting || !meeting.stopping || pendingSegs > 0) return;
  if (state !== 'meeting-finalizing') return;
  // 打ち切りで待ち件数を 0 にしても、録音側が変換中の最後の区間はこれから届く。
  // 先に締めると、その区間は議事録の無いところへ届いて消える（打ち切りの数にも入らない）
  if (meeting.skipAll && !meeting.finalSeen) return;
  // 点検の直し C1（決めたこと 130 の改め。持ち主 2026-10-25「両方の最後が届くまで待ってから締める（おすすめ）」）: 2つの流れの会議では、
  // 録音バーは後に送った方の最後の区間に final を付ける。片方の最後だけで待ちが 0 になっても締めない（もう片方の最後の 15〜20 秒が消える）
  if (twoMeeting(meeting) && !meeting.finalSeen) return;
  const m = meeting;
  meeting = null;
  // 0.12.0 SP-3a（決めたこと 136）: 2つの流れの会議は数だけを記録に（札の字・文は書かない）
  if (m.two && m.two.on) {
    const c = m.two.counts;
    engineLog(`2つの流れで録りました（マイク ${c.mic} 区間・相手の声 ${c.loopback} 区間・声の無い区間 ${c.idle}・回り込み ${c.bleed}）`);
  }
  dropQuietKept(m);   // 止まりの見張りで控えたまま会議が終わった区間の WAV（ページには無い。第1d回 A-6）
  paceSave(m);   // 0.9.4 S-4: この PC の速さの覚え（会議の後の文字起こしの目安と待ち時間が使う）

  // 一時停止していた時間は会議の長さに含めない。基準は停止時刻であって
  // 「今」ではない（今で計ると文字起こし待ちが混ざる。mainlib.meetingDurationSec）。
  const endAt = m.stoppedAt || Date.now();
  let durationSec = meetingDurationSec(m, endAt);
  let pauses = m.pauses;
  // 0.9.1 Q-4（決めたこと 11）: 聞いている間に止めた会議は、所要時間を残った区間の一番遅い終わり（会議の時計）までにし、その後の一時停止の印を外す
  // （区間が1つも無ければ切らない）
  const trimEnd = m.quietTrim ? lib.quietTrimEnd(m.segments) : null;
  if (trimEnd !== null) {
    durationSec = Math.round(trimEnd / 1000);
    pauses = (m.pauses || []).filter((x) => !(x && x.atMs >= trimEnd));
  }
  // 0.12.1 LV-3（決めたこと L13）: 会議を出たので止めた議事録は、所要時間を放した最初の読みの時刻（壁の時計）まで。0.9.1 の切り方と両方なら早い方。
  // その後の数秒の区間と文字起こしは消さない
  if (m.leaveStopped && Number.isFinite(m.leaveAt)) durationSec = Math.min(durationSec, meetingDurationSec(m, m.leaveAt));
  const dt = new Date(m.startedAt);
  const fallbackTitle = lib.meetingTitleAt(dt);   // 形は mainlib の1か所（0.10.0 SH-1・D71）

  // 会議のページの ID は録音を始めたときに作って下書きに書いた（第2a1回 ST6。写し・復旧と同じ ID）
  const pageId = m.pageId || store.newId('p');
  // 第1d2回 M-3（決めたこと 7）: 文字起こし待ちの区間（残した音声）がある会議は、一部だけの要約を作らない。要約の欄の S3（PC の中だけなら S3'）は
  // 締めの tx で書く（待ち行列を置いた後に別に書くと、その間に見回り・ログインの直後が待ち行列を済ませ、自動の要約が S3 を見つけられない）
  // 0.9.4 S-3（決めたこと 4・6）: ［文字起こしを後回しにして要約］を押した会議（m.later）は、利用者が頼んだので待たせずに今ある分で作る
  const keptWhy = !m.later && m.segments.some((s) => s.kept && s.wav && fs.existsSync(s.wav))
    ? (m.localOnly ? KEPT_SUMMARY_TEXT.waitLocal : KEPT_SUMMARY_TEXT.wait) : '';
  finalizingPageIds.add(pageId);
  finalizingDrafts.add(m.draftName);
  // 録音の状態は DB を待たせない（F9。「録音は DB に頼らない」）。すぐ待機に戻して次の録音を始められるようにし、締めの返事は裏で待つ。
  // DB の用意がまだ（移行中・起こし直し中）なら、録音バーに D9 の文を出す
  state = 'idle'; updateTray();
  setTimeout(hideOverlayIfIdle, 2000);
  sendToMainWin('meeting:update', meetingStatus());
  // 0.9.4 P-1: 録音バーは止めたら薄く消えるので、データベースを待つ文は本体の窓の知らせで出す
  if (['starting', 'migrating'].includes(db.state())) sendToMainWin('app:notice', DB_WAIT_TEXT);
  // 録音中に来た控えの復旧のやり直しを、ここで回す（第1a回 JS9。この会議の下書きは finalizingDrafts で飛ばす）
  runDraftRetryAfterMeeting();
  // 返事を待つ間に次の録音・音声入力が録音バーを使っていたら、締めの文で上書きしない
  const overlayFree = () => !meeting && state === 'idle';

  let page = null;
  try {
    // 議事録を締める（第2a1回 ST6: await db.call。中身は議事録の DB のプロセス）。「書けた」と返ってから下書きを消す。
    // 締めの tx は会議の開始時刻（送り直しても1回だけ効く）
    page = await db.call('meeting.finalize', {
      pageId,
      segments: settledSegments(m.segments),   // 待ちの区間（本文なし）と wav のパスは載せない
      page: {
        title: fallbackTitle,
        date: localDateISO(dt),   // ローカルの暦日（#51）
        durationSec, memo: m.memo, blocks: [],
        createdAt: dt.toISOString(),
        // 文字起こしの経路と、会議の印（要約の経路が見る: C10）
        route: { stt: { ...m.route, provider: sttProvider().id }, localOnly: Boolean(m.localOnly) },
        pauses,   // 止めていた時間の印（区間とは別の欄。第1b回 N4c・F6）
        stateLog: m.stateLog || [],   // 議事録の経過（0.10.0 K-1。決めたこと 116）
        ...(mtype.isSelectable(m.meetingType) ? { meetingType: m.meetingType, typeAuto: false } : {}),   // 0.11.0 M-4（決めたこと 11・F27）
        recovered: false, summaryError: keptWhy, meeting: { phase: 'done' },
      },
    }, { tx: `meeting:${m.startedAt}` });
    store.clearDraft(m.draftName);
    // 認識に失敗した区間の wav は残してある（settleSegment）。復旧と同じ待ち行列に載せ、
    // 要約のあとでもう一度文字起こしする。途中で落ちても recovery.json から次の起動で続く
    const retry = m.segments.filter((s) => s.failed && s.wav && fs.existsSync(s.wav))
      .map((s) => ({ id: s.id, wav: s.wav, durationMs: Number(s.durationMs) || 0 }));
    if (retry.length) {
      const q = { pageId: page.id, items: retry, dir: segbufDir(m.startedAt), retry: true, localOnly: Boolean(m.localOnly), ...(m.later ? { later: true } : {}), ...(m.pace && m.pace.slow ? { slow: true } : {}) };
      saveRecoveryQueue(q);
      if (!recoveryQueue) recoveryQueue = q;   // 別の復旧が待っていれば、その後に拾う（transcribeRecovered）
    }
    removeDirIfEmpty(segbufDir(m.startedAt));   // 全区間が片付いていれば空
  } catch (e) {
    // 保存に失敗しても（DB が止まっている・時間切れ）下書きは消さない（次回起動時に同じ ID のページを1つ復旧する）
    engineLog(`議事録の保存に失敗: ${logReason(e)}`);
    if (overlayFree()) sendToOverlay('overlay:phase', { phase: 'error', message: '議事録を保存できませんでした' });
    sendToMainWin('app:notice', `議事録を保存できませんでした: ${e.message}\n次回起動時に復旧を試みます。`);
  } finally {
    finalizingPageIds.delete(pageId);
    finalizingDrafts.delete(m.draftName);
    updateTray();   // 締めの返事を待つ間の省電力の抑止を外す（要約が続くなら要約の数で抑止が続く）
  }
  if (!page) return;
  // 0.12.1 LV-3（L11）・点検の直し 3: 止めた後の知らせを押したときに開くページ（保存した直後に覚える。この後の一覧の読みが投げても開ける）
  if (m.leaveStopped) m.leavePageId = page.id;

  if (overlayFree()) sendToOverlay('overlay:phase', { phase: 'done', message: '議事録を保存しました' });
  sendToMainWin('pages:updated', await db.call('pages.list', {}));
  sendToMainWin('page:open', { id: page.id, saved: true });   // 0.13.0 ED-5（EQ22 (a)）: 締めの保存の印。書き直している途中の画面は前に出さない
  if (m.autoStopped) quietDoneNotice(m, page.id);   // 0.9.1 Q-4
  // 音声は届いたのに、文字起こしが全部空だった。黙っていると「0 区間」の理由が分からない。
  // 知らせと engine.log に出す。要約の欄には書かない（0.10.0 LS-2・決めたこと 111 の 6: 文字起こしが空のページは欄の鍵のまま、頭の一言が伝える）
  // 止まりの見張りで音声ごと残した区間（第1d回 A-6。文字は無い）は「文字の残った区間」に数えない（全部が空なら、マイクの確かめ方も知らせる）
  const allEmpty = m.emptySegs > 0 && !settledSegments(m.segments).some((s) => s.text !== STALL_SEG_TEXT);
  const allEmptyText = `${m.emptySegs} 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした。`
    + '設定の「使用するマイク」が話している人の声を拾うマイクになっているか確かめてください。'
    + '続くときは、理由の記録を見てください。理由の記録: %APPDATA%\\natsu\\engine.log';
  if (allEmpty) {
    engineLog(`議事録を保存: 文字起こしが空の区間が ${m.emptySegs}、文字の残った区間は 0`);
    sendToMainWin('app:notice', allEmptyText);
  }

  // 第1d2回 M-3（決めたこと 7）: 文字起こし待ちの区間がある会議は要約を作らない（要約の欄の S3・S3' は締めで書いた）。
  // 待ち行列が済んだら自動で要約する（transcribeRecoveredItems）
  if (keptWhy) engineLog('議事録を保存: 文字起こし待ちの区間があるので、要約は文字起こしが済んでから作ります');
  else await runSummary(page.id);
  if (recoveryQueue) transcribeRecovered().catch((e) => engineLog(`retry failed: ${logReason(e)}`));
}

// 同じページの要約は同時に一つだけ（mainlib.makeSummaryRunner。main.test.js で
// 実行して固定）。走行中に「要約を生成」を連打されると、同じ文字起こしに対して
// 要約が二重に走り、後から終わった方が前の結果（とその間の編集）を上書きしていた。
// 走行中なら同じ Promise を返す。
// 走っているページの ID は画面へも渡す（0.10.0 LS-2: 要約の欄の鍵の making。自動の要約の最中も直せない）
const runSummary = makeSummaryRunner(doRunSummary, () => { updateTray(); sendToMainWin('summary:running', runSummary.running()); });
// 要約の書き戻しが続けてぶつかったときの知らせ（第2a1回 F6。mainlib.saveIfExists が conflict を投げた）
const SUMMARY_CONFLICT_TEXT = '要約を保存できませんでした。もう一度［要約を生成］を押してください。';
// 要約の書き戻し（page.put）が引数の照らしで断られた（bad-args）ときの知らせ（第2a1回 M-4 の点検）。DB に入った後で保存の決まりを超えた
// ページ（画面の［行を足す］は数を見ない）は、書き戻すたびに断られる。黙って投げると画面には何も出ないので、何をすればよいかを知らせる
const SUMMARY_TOO_BIG_TEXT = '要約を保存できませんでした。この議事録が保存できる大きさ（題名は 500 字まで・行は 2,000 個まで）を超えています。題名を短くするか行を減らしてから、もう一度［要約を生成］を押してください。';
// 要約が走っている間はアプリを「忙しい」として扱う（#52）: 省電力を止めない・終了前に
// 確かめる・更新と再起動を拒む。件数は mainlib.makeSummaryRunner が持つ。
const isSummarizing = () => runSummary.running().length > 0;
// 「手が塞がっている」: 記録・文字起こし・要約・復旧の文字起こしのどれかが動いている。
// 使われないエンジンの停止（#58）はこれが false のときだけ。締めの返事を待つ会議はここに入れない（エンジンを使わず、返事の後の要約は
// isSummarizing で数える。エンジンの切り替えの決まり「isBusy の中身は変えない」を守る）。閉じる確かめ・省電力・毎日の控えは
// finalizingPageIds を別に見る（第2a1回 M-4 の残りを 0.7.0 の前に直した）
const isBusy = () => state !== 'idle' || isSummarizing() || recoveryRunning || pendingSegs > 0;
// 更新の再起動を断る理由（第1d回 A-9。RL16・RF41）: 録音中（会議・音声入力）は 'recording'、議事録の保存の間は 'finalizing'、
// 要約中は 'summary'（文は今のまま、口ごとに出す）。設定の［更新して再起動］（app:restart・update:apply）とトレイの［更新を確認］が見る。
// 断っても何も止めない（エンジン・DB・貼り付け）。待って自動で再起動はしない（利用者が見ていない時に急に閉じない: K12）
const RESTART_BLOCK_TEXT = {
  recording: '録音中のため、更新と再起動をしませんでした。録音を終えてから、もう一度［更新して再起動］を押してください。',
  finalizing: '議事録を保存しています。保存が終わってから、もう一度［更新して再起動］を押してください。',
  late: '録音中のため、再起動しませんでした。更新は次に NaTsu を起動したときに使われます。録音を終えてから、NaTsu を終了して起動し直してください。',
};
function restartBlockNow() {
  const why = restartBlock({ state, finalizing: finalizingPageIds.size, pendingSegs, summarizing: isSummarizing() });
  if (why) engineLog(`更新の再起動: 断った（${why}）`);
  return why;
}

// 要約の生成 → ブロック化 → 出典付与 → 保存
async function doRunSummary(pageId) {
  // どの経路で抜けても進捗表示と録音状態を必ず解除する
  const clearUi = () => {
    sendToMainWin('meeting:progress', { message: '' });
    sendToMainWin('meeting:update', meetingStatus());
  };
  // 保存は必ず「いまディスクにあるページ」に対して行う。入口で読んだ page を
  // 書き戻すと、要約中に削除された議事録が復活する（mainlib.saveIfExists）。
  const gone = () => {
    engineLog('要約完了時にページが無い（削除済み）ため破棄');
    clearUi();
    return { ok: false, error: 'ページが削除されました' };
  };
  // 書き戻しが何度もぶつかった（その間ずっと画面で直されていた。第2a1回 F6）・保存の決まりを超えていて断られた（bad-args。M-4 の点検）。
  // 「削除された」にせず、要約を保存できなかったと理由ごとに知らせる。ほかの失敗は '' （呼び手が投げる）
  const unsaved = (e) => (e && e.code === 'conflict' ? SUMMARY_CONFLICT_TEXT : e && e.code === 'bad-args' ? SUMMARY_TOO_BIG_TEXT : '');
  const conflicted = (text) => {
    engineLog(text === SUMMARY_CONFLICT_TEXT ? '要約の書き戻しが続けてぶつかったため保存できませんでした' : '要約の書き戻しが保存の決まりで断られたため保存できませんでした');
    clearUi();
    sendToMainWin('app:notice', text);
    return { ok: false, error: text };
  };
  const opened = await db.call('page.get', { id: pageId });
  if (!opened) { clearUi(); return { ok: false, error: 'ページが見つかりません' }; }
  const { page } = opened;
  let segments = opened.segments;   // 出典付与の直前に読み直して差し替える（下記）
  const segmentsAtStart = segments;   // 要約の材料にした配列。出典付けで今の配列と突き合わせる（#4）
  const usable = segments.filter((s) => !s.failed && !s.pending);
  // 0.12.0 SP-4（決めたこと 143・R1）: 文字起こしはタイムラインの行の順。plain は札の無い文（種類の判定・点の長さ・担当と期限の照らし。
  // 札の無い会議は今と同じ文）、labeled は行の頭に「自分: 」「相手: 」を付けた文（Claude Code へ渡す。札が1つも無ければ plain と同じ）
  const rows = lib.timelineOf(usable);
  const plain = rows.map((r) => r.text).join('\n');
  const hasLabel = rows.some((r) => lib.srcLabel(r));
  const labeled = hasLabel ? rows.map(lib.labeledLine).join('\n') : plain;

  if (!plain.trim()) {
    // 0.10.0 LS-2（D69・決めたこと 111 の 6）: 文字起こしが空のページは要約の欄に理由を書かない（鍵のまま。欄の頭の一言が伝える）。
    // 要約待ちの印だけ外す（作れる日は来ない）
    const err = '文字起こしが空のため要約できません';
    let saved;
    try { saved = await saveIfExists(db, pageId, (p) => { if (p.summaryWait) { p.summaryWait = false; if (p.summaryError === SUMMARY_WAIT_TEXT) p.summaryError = ''; } }); } catch (e) { if (unsaved(e)) return conflicted(unsaved(e)); throw e; }
    if (!saved) return gone();
    clearUi();
    sendToMainWin('page:updated', { page: saved, segments });
    return { ok: false, error: err };
  }
  // 要約の経路を1回決める（0.10.0 LS-2・D59・決めたこと 103）。届けば利用者の Claude Code（オフラインモードの会議も）、届かなければ要約待ち:
  // 要約を作らずに summaryWait と「要約待ち（つながったら作ります）」を書き、つながったら見回りが自動で作る（retrySummaryWaits）
  const decided = await decideSummary({ up: () => online.isUp(ANTHROPIC_REACH) });
  if (decided.route !== 'claude-code') {
    summaryNet.up = false;
    engineLog(`要約: 要約待ち（${decided.why}）`);
    let saved;
    try { saved = await saveIfExists(db, pageId, (p) => { p.summaryWait = true; p.summaryError = SUMMARY_WAIT_TEXT; }); } catch (e) { if (unsaved(e)) return conflicted(unsaved(e)); throw e; }
    if (!saved) return gone();
    clearUi();
    sendToMainWin('pages:updated', await db.call('pages.list', {}));
    sendToMainWin('page:updated', { page: saved, segments });
    sendToMainWin('app:notice', SUMMARY_WAIT_TEXT);
    return { ok: false, error: SUMMARY_WAIT_TEXT, wait: true };
  }
  const route = 'claude-code';

  // 会議タイプ: 手動指定があればそれを尊重し、無ければタイトルと冒頭から推定。
  // 自動判定は手動指定があっても必ず走らせ、結果を別に残す。こうしないと
  // 「自動判定が当たっていたか」を後から誰も確かめられない
  // （手で選んだ議事録では detectType が一度も呼ばれていなかった）。
  const autoType = mtype.detectType(page.title, plain.slice(0, 1200));
  // 0.11.0 M-5（P14 (a)・決めたこと 13）: 自動のまま、題名と文字起こしで決まらないときだけ、前の同じ曜日・時刻の会議の人が選んだ種類（mtype.slotType）
  // 0.11.0 P-12（R4・P19 (a)）: 選べない種類（前の版の一般・その他・知らない値）は、手で選んだ印があっても判定し直す
  const redetect = !mtype.isSelectable(page.meetingType) || page.typeAuto !== false;
  let slot = '';
  if (redetect && !mtype.isSelectable(autoType)) {
    let rows = [];
    try { rows = await db.call('pages.typeSlots', { since: new Date(new Date(page.createdAt).getTime() - 36 * 86400000).toISOString() }); } catch (_) { rows = []; }
    slot = mtype.slotType(Array.isArray(rows) ? rows : [], page.createdAt);
  }
  page.autoSlot = Boolean(slot);
  page.autoType = slot || autoType;
  const typeBefore = page.meetingType;   // 0.11.0 M-4（P13）: 自動の判定で種類が変わったら経過に積む
  if (redetect) {
    // 判定材料が無いときは決まらない（''。メモの型は会議の要点: 0.11.0 P-12。0.1.2〜0.10.x は「一般・その他」）。0.1.1 までは「定例・進捗報告」に
    // していたが、定例の型（担当・案件ごとの報告、担当・期限つきのアクション）に合わせようとして、
    // 手元の小さいモデルが発言に無い担当と期限を作った（実機。一般・その他で作り直すと出なかった）。
    // タイトルに定例らしい言葉（朝会・定例・週次など）があれば（本文だけなら 5 語以上）、今までどおり自動で定例になる
    page.meetingType = page.autoType;
    page.typeAuto = true;
  }
  // タイトルは書かない。1on1・面談の議事録は機微で、engine.log は
  // 不具合報告に添付されうる。
  engineLog(`会議タイプ: 採用=${page.meetingType} 自動判定=${autoType}${slot ? '（前の同じ曜日・時刻の会議）' : ''}`
    + ` 手動=${page.typeAuto === false} 区間数=${usable.length}`);

  // 0.11.0 Q-3（決めたこと 32）: 点を付けるか。設定（既定はすべての会議: P11）と、文字起こしが短くないか（400 文字）
  const wantScore = quality.shouldScore(page.meetingType, settings.qualityScore);
  const score = wantScore && plain.length >= quality.MIN_SCORE_CHARS;
  // 0.11.0 M-2（決めたこと 14）: 書式は1回だけ作る（Claude Code に渡す文と写しを落とす文に同じ文字列）
  const template = memoTypes.buildTemplate({ meetingType: page.meetingType, score, labeled: hasLabel });
  const progress = (msg) => sendToMainWin('meeting:progress', { message: msg });
  // 決まらなかったときは「自動として」でなく型の名前で言う（0.11.0 P-12・R15）
  progress(`Claude Code で議事録を作成中…（${mtype.isSelectable(page.meetingType) ? `${mtype.getLabel(page.meetingType)}として` : '決まらなかったので会議の要点の型で'}要約します）`);
  try {
    // Claude Code が断った・失敗したら、理由を要約の欄に書いて終える（下の catch。手元の llama へは行かない: D1・D59）
    const { md: answer, truncatedParts, finalTruncated } = await summarizeWithClaude(labeled, page.memo, template);
    // 0.11.0 Q-3（決めたこと 30・32）: 採点の節はいつも本文から外す（頼まなかった採点の節も、2つ以上の節も、本文に残さない）
    const split = quality.splitScore(answer);
    const md = split.body;
    // 「特になし」の混入を先に落とす。ここで落とさないと
    // 「- [ ] 特になし」がアクション1件として数えられてしまう。
    // 続けて、テンプレートの見出し・雛形をそのまま写した行も落とす。
    // 0.11.0 M-3（決めたこと 17・18・22・23）: 写しを落とした後に印を付ける（見出しに直す・根拠の無い見出しを未確認へ畳む・チェックは 3 件まで・
    // 印の行は出典の照合から外す）。engine.log には数だけ（要約の文は書かない）
    const marked = memoTypes.markBlocks(dropTemplateEcho(dropRedundantEmpty(markdownToBlocks(md)), template), { meetingType: page.meetingType });
    const blocks = marked.blocks;
    if (marked.dropped || marked.folded) engineLog(`要約: 抜け・重なりチェック ${marked.dropped} 件を捨てた・未確認にまとめた見出し ${marked.folded} 個`);
    // 担当・期限を先に抜く。出典の突き合わせは
    // 「（担当: ○○ / 期限: ○○）」を落とした本文に対して行いたい。
    // 書式が残ったままだと、その語がクエリに混ざって一致がぶれる。
    enrichActionBlocks(blocks, new Date(page.createdAt));
    // 文字起こしとメモに出てこない担当・期限は外す（推測で埋めない。モデルが指示に反して書くことがある）。
    // engine.log には数だけを書く（名前は機微。engine.log は不具合報告に添付されうる）
    // メモのうち、要約タイプを選んだときに入るアジェンダの雛形の行は裏付けにしない（「次回までのアクション」で
    // 作り話の「期限: 次回」が通ってしまう）。mainlib.memoEvidence
    const grounded = groundActionFields(blocks, `${plain}\n${memoEvidence(page.memo, [...mtype.listTypes(), ...memoTypes.presetLines()])}`);
    const actStat = grounded.stat;
    if (grounded.droppedAssignee || grounded.droppedDue) {
      engineLog(`要約: 文字起こしに無い担当 ${grounded.droppedAssignee} 件・期限 ${grounded.droppedDue} 件を外しました`);
    }
    // 要約は数分かかる。その間に文字起こしが編集されているかもしれないので、
    // 出典は読み込み時の配列ではなく、いまディスクにある文字起こしに対して付ける。
    // 画面へ返す segments も同じもの（古い配列を返すと、編集した行が画面上で戻る）。
    const now = await db.call('page.get', { id: pageId });
    const fresh = now ? now.segments : [];   // ページが消えていれば下の saveIfExists が null を返して捨てる
    // 要約の材料にした配列（入口）と今の配列の両方を渡す（#4。cite.attachCitationsAcross）
    const stat = attachAcross(blocks, fresh, segmentsAtStart);
    segments = fresh;
    // 0.11.0 Q-3（決めたこと 29〜34）: 点（付けるときだけ）。AI の3つの軸を厳しく読み、ToDo の具体さと型の埋まり具合は数え、合計は数え直す。
    // AI の軸の理由は一時のブロックにして出典を付ける（ページのブロックと出典の数には入れない）。engine.log には点と符号だけ（理由の文は書かない）
    let q = null; let scoreNote = '';
    if (score) {
      const parsed = quality.parseScore(split.lines, quality.AI_AXES, { found: split.found });
      if (parsed.ok) {
        const cites = {};
        for (const a of quality.AI_AXES) {
          const tmp = [{ id: `q-${a.key}`, type: 'bullet', text: parsed.ai[a.key].reason, cites: [] }];
          attachAcross(tmp, fresh, segmentsAtStart);
          cites[a.key] = Array.isArray(tmp[0].cites) ? tmp[0].cites.filter((c) => typeof c === 'string') : [];
        }
        q = quality.buildQuality({ ai: parsed.ai, todo: quality.todoAxis(blocks), fill: quality.fillAxis(blocks, { headings: memoTypes.sectionsOf(page.meetingType), key: memoTypes.headingKey }), cites, at: new Date().toISOString() });
        engineLog(`打ち合わせの質: 付けた ${q.total}/25`);
      } else {
        scoreNote = QUALITY_NOTE_UNREAD;
        engineLog(`打ち合わせの質: 付けない（読めない（${parsed.code}））`);
      }
    } else if (wantScore) {
      scoreNote = QUALITY_NOTE_SHORT;
      engineLog('打ち合わせの質: 付けない（短い）');
    } else {
      engineLog(`打ち合わせの質: 付けない（${settings.qualityScore === 'off' ? '設定' : '1on1・面接'}）`);
    }

    // 同じ理由で、タイトルやメモも読み込み時のページを丸ごと書き戻さず、
    // 生成物だけを最新のページに載せる。ページが消えていれば生成物は捨てる。
    const latest = await saveIfExists(db, pageId, (saved) => {
      saved.blocks = blocks;
      delete saved.summaryEdited;   // 0.13.0 点検4: 作り直した要約は人の手直しを持たない（［要約を再生成］の確かめの印を消す）
      // 要約の途中で種類を手で選び直されていたら、その選択を残す（上書きすると、選んだ種類が黙って戻る。
      // mainlib.mergeSummaryType）。この要約は始めたときの種類で作ったものなので、そう書き添える
      const t = mergeSummaryType(saved, page);
      saved.meetingType = t.meetingType;
      saved.typeAuto = t.typeAuto;
      saved.autoType = page.autoType;
      if (page.autoSlot && t.typeAuto !== false) saved.autoSlot = true; else delete saved.autoSlot;   // 0.11.0 M-5: 前の会議の種類を使った印（画面の灰色の文）
      // 0.11.0 M-4（P13・決めたこと 12）: 自動のまま、要約のときの判定で種類が前と変わったら、経過に「種類を選んだ（要約のときの自動の判定）」
      if (t.typeAuto !== false && mtype.normalizeType(page.meetingType) !== mtype.normalizeType(typeBefore)) saved.stateLog = lib.stateLogAdd(saved.stateLog, { s: 'type', by: 'auto', at: new Date().toISOString() });
      saved.citeStat = stat;
      saved.actionStat = actStat;
      // 切れたパートと最終統合の打ち切りを名指しする（mainlib.truncationMessage。無ければ ''）
      const notes = [truncationMessage(truncatedParts, finalTruncated)];
      if (t.changed) {
        // 0.11.0 M-4: どの型で作ったかも書く（書式の文と画面の文の「作っている間に種類を替えたときの注」）
        notes.push(`この要約は「${mtype.getLabel(page.meetingType)}」（メモの型: ${memoTypes.MEMO_TYPES[memoTypes.memoTypeOf(page.meetingType)].label}）として作りました。途中で選んだ「${mtype.getLabel(t.meetingType)}」で作り直すには［要約を再生成］を押してください。`);
      }
      if (scoreNote) notes.push(scoreNote);   // 0.11.0 Q-3: QN1・QN2
      saved.summaryError = notes.filter(Boolean).join('\n');
      // 0.11.0 Q-3（決めたこと 33）: 点はページの欄。点を付けない要約で作り直したら前の点を消す
      if (q) saved.quality = q; else delete saved.quality;
      saved.summaryWait = false;   // 要約待ちの印を消す（0.10.0 LS-2）
      // どちらで要約したか（第1c回 OL6。ページのプロパティの行に出す）。成功したときだけ書く
      saved.route = { ...(saved.route || {}), summary: { by: route, at: new Date().toISOString() } };
    });
    if (!latest) return gone();
    clearUi();
    sendToMainWin('pages:updated', await db.call('pages.list', {}));
    sendToMainWin('page:updated', { page: latest, segments });
    return { ok: true, page: latest, stat };
  } catch (e) {
    if (quitting) return { ok: false, error: e.message };   // 終了中: before-quit が書いた「中断」の文を上書きしない
    if (unsaved(e)) return conflicted(unsaved(e));   // 書き戻しが5回ぶつかった・決まりで断られた: 要約の欄にも書けないので知らせるだけ
    // 0.10.0 LS-2（決めたこと 105）: 待てば直る混み合い（SUMMARY_RETRY_CODES）は要約待ちに戻し、次のつながり直しで作る。
    // ログイン切れ・上限・Claude Code が無いなどは、待っても直らないので印を消し、平易な理由と［要約を生成］の案内を欄に書く（欄の鍵が外れる）
    const again = Boolean(e && SUMMARY_RETRY_CODES.includes(e.claudeCode));
    let latest;
    try {
      latest = await saveIfExists(db, pageId, (saved) => {
        saved.summaryWait = again;
        saved.summaryError = again ? SUMMARY_WAIT_TEXT : e.message;
      });
    } catch (e2) { if (unsaved(e2)) return conflicted(unsaved(e2)); throw e2; }
    if (!latest) return gone();
    clearUi();
    sendToMainWin('page:updated', { page: latest, segments });
    return { ok: false, error: again ? SUMMARY_WAIT_TEXT : e.message, wait: again };
  }
}

// 0.10.0 LS-2（D59・決めたこと 104）: 要約待ちのページを、つながったら自動で作る。見回り（retryKeptWhenBack）から呼ぶ。
// Claude Code（ANTHROPIC_REACH）へ届くかを見て、届かない → 届く に変わったら試したページの控え（tried）を空にする。
// 届く間は、要約待ちのページを古い順に1つずつ（mainlib.summaryRetryPick）、つながり1回につき1ページ1回だけ作る。
// 録音中・終了中・ほかの要約の最中は何もしない（次の見回りで）。ゴミ箱のページと録音中の写しは DB の pages.summaryWaits が渡さない
const SUMMARY_RETRY_CODES = ['overloaded'];   // 待てば直る Claude Code の誤り（決めたこと 105 の「届かない」と同じ扱い）
const summaryNet = { up: null, tried: new Set() };
async function retrySummaryWaits() {
  if (quitting || meeting || state !== 'idle' || isSummarizing()) return;
  const r = await online.isUp(ANTHROPIC_REACH);
  if (!r || r.up !== true) { summaryNet.up = false; return; }
  if (summaryNet.up === false) summaryNet.tried.clear();
  summaryNet.up = true;
  for (;;) {
    if (quitting || meeting || state !== 'idle') return;
    const list = await db.call('pages.summaryWaits', {});
    const id = summaryRetryPick(Array.isArray(list) ? list : [], { tried: summaryNet.tried });
    if (!id) return;
    summaryNet.tried.add(id);
    engineLog('要約: 要約待ちのページを作ります（つながったので）');
    await runSummary(id);
    if (summaryNet.up === false) return;   // 作る途中で届かなくなった（要約待ちに戻った）
  }
}

// ---------------------------------------------------------------- ホットキー / トレイ
// 登録できていないホットキーの状態。画面（hotkey:state）とトレイに出す。
// 形は mainlib.hotkeyStatus の state: { ok, failed, fallback, message }。
// 以前は片方が他アプリと衝突すると両方を黙って既定に戻し、ディスクにも
// 書いていたので、利用者は「設定したキーが勝手に変わる」としか見えなかった。
let hotkeyState = { ok: true, failed: [], fallback: {}, message: '' };
let hotkeyNote = '';   // トレイに添える「（音声入力: 既定の … を使用中）」「（Alt+M は登録できず）」
// 実際に登録しているキー。settings は常に利用者が選んだキーを持ち、起動時に既定へ
// 退避してもここにだけ入れる。settings に書くと settings:get が既定を返して設定画面に
// 既定が出、次の無関係な保存（自動起動の切り替えなど）でディスクにも漏れて、
// 利用者のキーが黙って消える。トレイと保存時の登録し直しはこちらを使う。
let activeHotkeys = { hotkey: '', meetingHotkey: '' };

// 片方ずつ独立に登録する。片方が失敗しても成功した側は解除しない
// （mainlib.registerHotkeys）。戻り値 { ok, failed: ['音声入力'|'議事録'…] }
function applyHotkeys(hk, mhk) {
  globalShortcut.unregisterAll();
  return registerHotkeys([
    { label: '音声入力', accel: hk, handler: toggleRecording },
    { label: '議事録', accel: mhk, handler: () => toggleMeetingByHotkey().catch((e) => engineLog(`議事録のホットキーを処理できません: ${errCode(e)}`)) },
  ], (accel, handler) => globalShortcut.register(accel, handler));
}

/*
 * トレイのアイコン。
 *
 * nativeImage が読めるのは PNG / JPEG（Windows なら ICO も）だけで、
 * SVG は読めない。以前は SVG のデータURLから作っていたため常に空の画像になり、
 * タスクトレイのアイコンが透明になっていた。
 *
 * 図柄は src/assets に置く。src/ 配下ならアプリ内更新で一緒に入れ替わる
 * （更新は src/ をまるごと差し替える方式のため）。
 * ICO は 16/20/24/32/48/64 を含むので、Windows が画面のDPIに合うものを選ぶ。
 */
function makeTrayIcon(recording) {
  const base = path.join(__dirname, 'assets', recording ? 'tray-rec' : 'tray');
  const candidates = process.platform === 'win32'
    ? [`${base}.ico`, `${base}.png`]
    : [`${base}.png`];
  for (const file of candidates) {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
  }
  // 見つからなければアプリのアイコンで代用する（透明なトレイよりはよい）
  const fallback = nativeImage.createFromPath(path.join(__dirname, 'assets', 'window.png'));
  return fallback.isEmpty() ? fallback : fallback.resize({ width: 16, height: 16 });
}

// トレイからの更新確認。画面を経由しないので、レンダラーが壊れていても動く。
// 文とボタンは設定の画面・起動時の告知と同じ（withNotice → updater.updateNotice。第0c回 EL4）
async function checkUpdateFromTray() {
  const target = updateTarget();
  const r = await updater.check(app.getVersion(), app.getPath('userData'));
  if (!r.ok) {
    dialog.showMessageBox({ title: APP_TITLE, type: 'error', message: '更新を確認できませんでした', detail: r.error || '' });
    return;
  }
  if (!r.update) {
    dialog.showMessageBox({ title: APP_TITLE, type: 'info', message: `最新です（${app.getVersion()}）` });
    return;
  }
  // 入れ直しが要る版・テスト用の取得先・置き場所に書けないときは、当てずに配布ページへ送る
  const offerDownload = (button, detail) => {
    const pick = dialog.showMessageBoxSync({
      title: APP_TITLE, type: 'info', buttons: [button, '閉じる'], defaultId: 0, cancelId: 1,
      message: `新しいバージョン ${r.version} があります`, detail,
    });
    if (pick === 0) shell.openExternal(`https://github.com/${updater.REPO}/releases/latest`);
  };
  const n = withNotice(r).notice;
  if (n.action === 'download') { offerDownload(n.button, n.message); return; }
  const pick = dialog.showMessageBoxSync({
    title: APP_TITLE, type: 'question', buttons: [n.button, 'あとで'], defaultId: 0, cancelId: 1,
    message: `新しいバージョン ${r.version} があります`,
    detail: String(r.notes || '').slice(0, 800),
  });
  if (pick !== 0) return;
  // 確認の間に要約・録音が始まっていることがある（#52・第1d回 A-9）。録音中と議事録の保存の間は取り込みを始めない
  const before = restartBlockNow();
  if (before === 'summary') {
    dialog.showMessageBox({ title: APP_TITLE, type: 'info', message: '要約を作成中です', detail: '終わってから更新してください' });
    return;
  }
  if (before) {
    dialog.showMessageBox({ title: APP_TITLE, type: 'info', message: RESTART_BLOCK_TEXT[before] });
    return;
  }
  const res = await updater.apply(r.url, target.root, app.getPath('userData'), () => {}, { sha256: r.sha256 || '' });
  if (!res.ok && res.reinstall) {   // 門が断った（natsu-update.json の無い古いリリースのための最後の守り）
    offerDownload('ダウンロード', res.error || '');
    return;
  }
  if (!res.ok) {
    dialog.showMessageBox({ title: APP_TITLE, type: 'error', message: '更新に失敗しました', detail: res.error || '' });
    return;
  }
  // 取り込みの間に録音が始まっていることがある（第1d回 A-9）。再起動の直前にもう一度見て、録音中・保存の間は再起動しない（更新は次の起動で使われる）
  const late = restartBlockNow();
  if (late === 'recording' || late === 'finalizing') {
    dialog.showMessageBox({ title: APP_TITLE, type: 'info', message: RESTART_BLOCK_TEXT.late });
    return;
  }
  quitting = true;
  stopEngine(whisperEng); stopPaster();
  // 議事録の DB を閉じてから（cleanShutdown を書いてチェックポイント。第2a1回 ST7）
  await db.close({ timeoutMs: DB_CLOSE_MS });
  relaunchAndExit();
}

function updateTray() {
  updatePowerBlock();
  noteDetectState();   // 0.9.3 M-2: 録音の状態が変わったら、会議の検出の見張りを起こす・止める
  syncLevelAsk();      // 0.9.3 M-5: 録音中のページの音の波のために聞くか
  if (!tray) return;
  const recording = state === 'recording' || state === 'meeting';
  tray.setImage(recording ? trayIconRec : trayIconIdle);
  const items = [];
  if (state === 'meeting') {
    items.push({ label: '■ 議事録を終了して作成', click: stopMeeting });
    items.push({ label: '議事録を破棄', click: discardMeeting });
  } else if (state === 'meeting-finalizing') {
    items.push({ label: '議事録を作成中…', enabled: false });
  } else {
    items.push({
      label: state === 'recording' ? '■ 停止して文字起こし' : state === 'processing' ? '文字起こし中…' : '● 音声入力を開始',
      enabled: state !== 'processing', click: toggleRecording,
    });
    items.push({ label: '議事録の記録を開始', enabled: state === 'idle', click: () => { startMeetingBy('tray').catch((e) => engineLog(`議事録を開始できません: ${errCode(e)}`)); createMainWindow(); } });
  }
  // 0.9.0 O-4（RP8）: 録音中に録音バーを隠しているときだけ、出し直す口
  if (panelHidden && (state === 'recording' || state === 'meeting')) items.push({ label: '録音バーを表示', click: showPanel });
  items.push({ type: 'separator' });
  items.push({ label: 'ノートを開く', click: createMainWindow });
  // 更新はトレイからも行えるようにする。画面側の組み立てが1か所でも
  // つまずくと、設定タブの「更新を確認」ボタンごと動かなくなり、
  // アプリ内更新で直すこともできなくなる（実機で起きた）。
  // 復旧の手段が、壊れうるものに依存していてはいけない。
  items.push({ label: '更新を確認', enabled: state === 'idle' && !isSummarizing(), click: checkUpdateFromTray });
  // エンジンを手で止めてメモリを解放する（#58）。どちらかが起動していて、手が空いているときだけ
  items.push({ label: 'エンジンを停止（メモリを解放）', enabled: Boolean(whisperEng.proc) && !isBusy(), click: stopEnginesFromTray });
  items.push({ type: 'separator' });
  items.push({ label: '終了', click: quitFromTray });
  // 既定で代替している／登録できていないキーがあれば、その旨を添える
  // （画面を開かなくても気づけるように）
  if (hotkeyNote) items.push({ label: `ホットキー ${hotkeyNote}`, enabled: false });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  // 出すのは設定のキーではなく実際に登録しているキー（退避中は設定のキーは効かない）
  tray.setToolTip(
    state === 'meeting' ? 'NaTsu — 議事録を記録中'
      : state === 'recording' ? 'NaTsu — 録音中'
        : state === 'processing' || state === 'meeting-finalizing' ? 'NaTsu — 処理中'
          : `NaTsu — ${activeHotkeys.hotkey}: 音声入力 / ${activeHotkeys.meetingHotkey || '未設定'}: 議事録${hotkeyNote}`,
  );
}

function createTray() {
  trayIconIdle = makeTrayIcon(false);
  trayIconRec = makeTrayIcon(true);
  tray = new Tray(trayIconIdle);
  tray.on('double-click', createMainWindow);
  updateTray();
}

// ---------------------------------------------------------------- 更新の適用先
/*
 * 更新は src/ をファイル単位で差し替える方式なので、
 * 「package.json と src/ が素のファイルとして置かれているか」が条件になる。
 *
 * app.getAppPath() は、開発時はプロジェクトフォルダ、
 * インストーラー版（asar 無効）は <インストール先>\resources\app を返すので、
 * どちらもそのまま適用先になる。asar 同梱でビルドすると書庫の中に入り、
 * ファイル単位では差し替えられない（package.json の build.asar を参照）。
 *
 * 「インストーラー版かどうか」ではなく「実際に差し替えられるか」で判断する。
 */
let updateTargetCache = null;
function updateTarget() {
  if (updateTargetCache) return updateTargetCache;
  const root = app.getAppPath();
  let result;
  if (/\.asar$/i.test(root)) {
    result = { ok: false, error: 'このビルドは asar 同梱のため、この方法では更新できません。新しいインストーラーを実行してください。' };
  } else {
    // Windows の access() は ACL を見ないので、実際に書いて確かめる
    try {
      const probe = path.join(root, `.write-test-${process.pid}`);
      fs.writeFileSync(probe, '');
      fs.unlinkSync(probe);
      result = { ok: true, root };
    } catch (_) {
      result = { ok: false, error: `インストール先に書き込めないため更新できません（${root}）。新しいインストーラーを実行してください。` };
    }
  }
  updateTargetCache = result;
  return result;
}

// 更新の知らせ（設定の画面・起動時の告知・トレイで同じ文。文は updater.updateNotice の 1 か所。第0c回 EL4）
const updateSha = new Map();   // zip の URL → natsu-update.json の SHA-256（当てるときに照らす）
function withNotice(r) {
  const t = updateTarget();
  if (r && r.ok && r.url && r.sha256) updateSha.set(r.url, r.sha256);
  return { ...r, applyable: Boolean(t.ok && !(r && (r.reinstall || r.test))), notice: updater.updateNotice(r, t) };
}

// ---------------------------------------------------------------- IPC
let lastPickDir = '';   // この起動で前に選んだフォルダ（43 から OS が覚えないので自分で覚える。保存はしない）
const isDirSync = (d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } };

function setupIpc() {
  ipcMain.handle('settings:get', () => { if (settingsState === 'unreadable') retrySettingsRead(); return settings; });
  ipcMain.handle('settings:save', (_e, next) => {
    const prevAutoLaunch = settings.autoLaunch;
    // 決まりのあるキーだけを受け取り（許可の一覧 pickSavable）、読み込みと同じ決まりで整える。知らないキーは
    // ファイルにあったものだけが残る（画面から新しく入れさせない）
    // ログイン中のメールアドレスは main のログインの IPC だけが書く（第1d回 A-2。画面の古い写しで消したり、ほかの名前にしたりさせない）
    const merged = readSettings({ ...settings, ...pickSavable(next), accountEmail: settings.accountEmail }, DEFAULT_SETTINGS).settings;
    // 記録中はエンジンに関わる設定を前の値に留める（#57。判断は mainlib.guardEngineSettings）。
    // 保存のたびにエンジンが再起動すると、文字起こし中の区間が失われる。留めた値は
    // applied で画面へ戻し、warning で伝える。
    // 音声入力（recording）の最中も同じ。文字起こし中に whisper を再起動すると、その発話が失われる
    const guard = guardEngineSettings(settings, merged, Boolean(meeting) || state === 'recording');
    Object.assign(merged, guard.settings);

    // ホットキーは変えた側だけ登録し直し、失敗した側だけ前の値に戻して、他の設定は
    // 保存する（判断は mainlib.saveHotkeys。main.test.js で実行して固定）。
    // 以前は片方の衝突で保存全体を失敗にしていたので、同時に変えた他の項目まで
    // 黙って捨てられていた。失敗は warning で画面に返す。
    // 設定として残ったキーは applied で返す。画面はこれを欄に戻す（失敗したキーが
    // 欄に残ると、以後の無関係な保存のたびに再失敗して警告が出続ける）。
    // 両方とも変えていなければ hk は null で、登録も状態も触らない。
    let warning = '';
    const hk = saveHotkeys(settings, activeHotkeys, merged, applyHotkeys);
    if (hk) {
      merged.hotkey = hk.applied.hotkey;
      merged.meetingHotkey = hk.applied.meetingHotkey;
      activeHotkeys = hk.active;
      hotkeyState = hk.state;
      hotkeyNote = hk.note;
      warning = hk.warning;
    }
    if (guard.warning) warning = warning ? `${warning}。${guard.warning}` : guard.warning;
    const prevDetect = { meetingDetect: settings.meetingDetect, mute: JSON.stringify(settings.meetingDetectMute) };
    const prevLeave = settings.autoStopLeave !== false;
    settings = merged;
    // 0.9.3 M-2: 会議の検出の設定が変わったら、判断に知らせて見張りを起こす・止める
    if (prevDetect.meetingDetect !== settings.meetingDetect || prevDetect.mute !== JSON.stringify(settings.meetingDetectMute)) applyDetectSettings(prevDetect);
    if (prevLeave !== (settings.autoStopLeave !== false)) applyLeaveSetting();   // 0.12.1 LV-2（決めたこと L9・L16）
    // 書けなくても投げず、当てる行（テーマ・エンジン・保留の復旧・ログイン時の起動・トレイ）は最後まで行い、warning で返す。
    // 書けなかった値は書き手に「まだ書いていない」として残り、次の保存と書き出しの合図でやり直す（JS1・JS5・P14・RF22）
    const w = settingsWriter.now(settings);
    if (!w.ok) {
      let msg = '';
      if (w.error && w.error.readOnly) {
        if (settingsState !== 'readonly') msg = NOTICE.settingsReadOnly;   // その起動で1回だけ（N6）
        settingsState = 'readonly';
      } else if (w.error && w.error.code === 'NOT_WRITABLE') {
        msg = NOTICE.settingsBusy;   // 読めない間（N4）
      } else {
        msg = NOTICE.settingsNotSaved;   // N7
        engineLog(`設定: 保存できませんでした（${errCode(w.error)}）。次の変更のときにもう一度保存します`);
      }
      if (msg) warning = warning ? `${warning}。${msg}` : msg;
    }
    applyTheme();
    if (!guard.kept.length) restartEnginesIfNeeded();
    // 保留していた復旧（エンジン未設定で止めていた分）を、設定が直った機会にもう一度試す
    if (recoveryQueue) transcribeRecovered().catch((e) => engineLog(`復旧の文字起こしに失敗: ${logReason(e)}`));
    if (settings.autoLaunch !== prevAutoLaunch) {
      try { app.setLoginItemSettings({ openAtLogin: settings.autoLaunch }); } catch (_) { /* noop */ }
    }
    updateTray();
    const applied = { hotkey: settings.hotkey, meetingHotkey: settings.meetingHotkey };
    // 画面が送った値と違う値で残ったキーは全部載せる（記録中に留めたエンジン設定・
    // 正規化で丸めた値も）。画面はこれを欄に戻す（mainlib.keptDifferent）
    Object.assign(applied, keptDifferent(next, settings));
    return warning ? { ok: true, applied, warning } : { ok: true, applied };
  });
  ipcMain.handle('hotkey:state', () => hotkeyState);

  ipcMain.handle('history:get', () => history);
  // 第1d2回 M-5: 残した音声入力の行を消したら、その音声も消す
  ipcMain.handle('history:delete', (_e, id) => { dropDictWaits(history.filter((h) => h.id === id)); history = history.filter((h) => h.id !== id); saveHistoryOrNotice(); return history; });
  ipcMain.handle('history:clear', () => { dropDictWaits(history, true); history = []; saveHistoryOrNotice(); return history; });
  ipcMain.handle('app:toggle-recording', () => { toggleRecording(); return state; });

  // 議事録の画面の口は main を通らない（第2a1回 ST5。preload が DB の口（役 app）へ直に頼む）。要約だけは今どおり main の IPC
  ipcMain.handle('page:summarize', (_e, id) => runSummary(id));
  // 0.11.0 V-1・V-5: 画面は種類の並びを1か所（meetingType.SELECTABLE）から読む（群の見出しは無い）。メモの型の表も
  ipcMain.handle('meta:types', () => typesForView());
  ipcMain.handle('meta:memo-types', () => memoTypes.listMemoTypes());
  // 0.11.0 V-4（P15 (a)・D79）: 題名を直した自動のページで、今の題名と文字起こしの頭から判定した種類（種類も要約も変えない。画面が一言を出すだけ）
  ipcMain.handle('meta:detect-type', async (_e, id, title) => {
    if (typeof id !== 'string' || typeof title !== 'string') return { type: '' };
    let segs = [];
    try { const r = await db.call('page.get', { id }); segs = r && Array.isArray(r.segments) ? r.segments : []; } catch (_) { segs = []; }
    const plain = segs.filter((sg) => sg && !sg.failed && !sg.pending).map((sg) => String(sg.text || '')).join('\n');
    return { type: mtype.detectType(title.slice(0, 200), plain.slice(0, 1200)) };
  });
  ipcMain.handle('meeting:toggle', () => {
    if (state === 'idle') return startMeetingBy('page');
    if (state === 'meeting') return stopMeetingBy('page');
    return { ok: false, error: '処理中です' };
  });
  ipcMain.handle('meeting:discard', () => discardMeeting());
  // 0.13.0 RDY-1（RD1・RD2・RD14）: 録音の前のページを開く・閉じる・始めるだけ
  ipcMain.handle('meeting:prepare', () => prepareMeeting());
  ipcMain.handle('meeting:unprepare', () => unprepareMeeting());
  ipcMain.handle('meeting:start', (_e, o) => startMeetingFromPage(o));
  ipcMain.handle('meeting:status', () => meetingStatus());
  // 第1d回 A-6（D17）: 帯の［もう一度］。失敗して音声を残した区間を今の経路で並べ直す → { ok: true, n } | { ok: false }
  ipcMain.handle('meeting:retry', () => retryFailedSegments());
  ipcMain.handle('meeting:keep-going', () => keepGoingQuiet());   // 0.9.1 Q-4: 帯の［続ける］
  // 第1d回 A-8（D17）: 画面が「録音中のページを開いていて、窓が隠れていない」かを知らせる（変わったときだけ送ってくる）
  ipcMain.on('meeting:live-shown', (_e, on) => { liveShownByUi = on === true; syncLevelAsk(); });
  ipcMain.handle('meeting:set-memo', (_e, memo) => { if (meeting) { meeting.memo = String(memo || ''); writeDraft(); } else if (prep) prep.memo = String(memo || ''); return true; });   // 0.13.0 RDY-1（RD7）: 録音の前は prep に
  // 0.11.0 M-4（D50・決めたこと 10・11）: 録音中のページで種類を選ぶ（auto は自動に戻す）。メモが手を付けていなければ新しい型の雛形に替え、
  // 下書きに書き、経過に1件積む。画面は先に待っているメモを meeting:set-memo で送ってから呼ぶ → { ok, memo, inserted, meetingType }
  // 0.13.0 RDY-1（RD7）: 会議が無くて録音の前のページがあれば、同じ決まりで prep に書く（下書きには書かず、経過は始めたときに積む: RD4）
  ipcMain.handle('meeting:set-type', (_e, key) => {
    const t = meeting || prep;
    if (!t) return { ok: false };
    if (key !== 'auto' && !mtype.isSelectable(key)) return { ok: false };
    t.meetingType = key === 'auto' ? null : key;
    let inserted = false;
    if (key !== 'auto' && memoTypes.isUntouchedMemo(t.memo, mtype.listTypes().map((x) => x.agenda).filter(Boolean))) {
      t.memo = memoTypes.memoPreset(memoTypes.memoTypeOf(key));
      inserted = true;
    }
    if (t === meeting) noteMeetingState(meeting, 'type', 'live-page');   // 下書きにも書く
    return { ok: true, memo: t.memo, inserted, meetingType: t.meetingType };
  });
  // 終了後の文字起こし待ちを後回しにする（#42。0.9.4 S-3 で打ち切りから替えた: ［文字起こしを後回しにして要約］）。記録中（終了前）は押せない。
  // 待ちの区間は「文字起こし待ち」（kept）で WAV を残す（mainlib.skipPendingSegments。消さない）。締めは要約を待たせずに今ある分で作り（m.later）、
  // 残した区間は会議の後の待ち行列が文字起こしする（済んだら［要約を生成］で作り直せると知らせる。自動で作り直さない: 問い Q5）。
  // 進行中・待ち行列の結果は世代（gen）で無効にし、待ち件数を 0 にして締める
  ipcMain.handle('meeting:skipPending', () => {
    if (!meeting || !meeting.stopping) return { ok: false, error: '記録を終了したあとにだけ打ち切れます' };
    const m = meeting;
    m.gen++;
    const r = skipPendingSegments(m.segments);
    m.later = true;
    if (r.kept) engineLog(`文字起こしを後回しにした: ${r.count} 区間（音声を残した ${r.kept}）`);
    m.skipped += r.count;
    m.inFlightSince = 0;
    pendingSegs = 0;
    // 録音側の最後の区間がまだ届いていなければ、届いてから締める（届いた区間も打ち切り扱い）。
    // 録音側が落ちて最後が来ないときのために 60 秒で諦めて締める
    m.skipAll = true;
    if (!m.finalSeen) {
      setTimeout(() => {
        if (meeting === m && m.skipAll && !m.finalSeen) {
          m.finalSeen = true;
          maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
        }
      }, 60000);
    }
    writeDraft();
    sendToMainWin('meeting:update', meetingStatus());
    maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
    return { ok: true, skipped: r.count };
  });

  ipcMain.handle('clipboard:copy', async (_e, t) => { await copyPrivate(String(t ?? '')); return true; });
  ipcMain.handle('app:test', async () => {
    forgetRuntimeIssues();   // ランタイムを入れた後の押し直しで読み直す（RF4）
    // 置き場所の注意は、動いていても動いていなくても添える（原因の説明にも予防にもなる）
    const warning = engineDirNote(whisperEng);
    const problem = engineCheck(whisperEng);   // 原因を名指しする（#32）
    if (problem) return { ok: false, error: problem, warning };
    const ok = await ensureEngineReady(whisperEng);
    if (!ok) return { ok: false, error: whisperEng.lastError || '起動に失敗しました', warning };
    const vad = settings.useVad ? resolveVadModel() : '';
    const notes = [vad ? `VAD有効（${path.basename(vad)}）` : 'VAD無効'];
    if (settings.suppressNst) notes.push('非発話トークン抑制');
    // 記録・文字起こしの最中は試さない（エンジンは 1 件ずつ処理するので、前の区間を待って時間切れになりうる）。
    // 要約だけが動いているときは文字起こしエンジンは空いているので試す
    if (state !== 'idle' || recoveryRunning || pendingSegs > 0) return { ok: true, info: `文字起こしエンジンは起動しています。記録や文字起こしの最中のため、試しの文字起こしは省きました（${notes.join(' / ')}）`, warning };
    const tried = await probeInference();
    if (tried) { engineLog(`起動テスト: ${tried}`); return { ok: false, error: tried, warning }; }
    return { ok: true, info: `文字起こしエンジンは起動しています。短い無音を試しに文字起こしさせ、返事があることも確かめました（${notes.join(' / ')}）`, warning };
  });
  // 設定の「PC の中の文字起こし：使えます／使えません」（第1d回 A-13・D19。前の「エンジン：正常／要確認」）。置き場所のファイルを見るだけで、エンジンは起動しない。
  // 0.10.0 LS-3（D59）で要約のエンジンの欄（sum）を外した
  ipcMain.handle('engine:status', () => ({ ok: true, chosen: isOfflineChosen(), whisper: engineCheck(whisperEng),
    whisperNote: isKotobaModel() ? KOTOBA_NOTE : '' }));
  // 取り込みの欄の写し（第0b回）。読むだけで、取り込みは始めない
  ipcMain.handle('engine:fetch-status', () => engineFetchStatus());
  // 取り込みの開始（第0b回 Task 14）。押したことが同意。すぐに写しを返す（取り込みの終わりを待たない）。
  // 待っているときは、すぐ試す（［今すぐ試す］も同じ受け口）。動いていれば二重に始めない（係が束ねる）
  ipcMain.handle('engine:fetch-start', (_e, o) => getEngineFetch().start({ all: Boolean(o && o.all), user: true }));
  // ボタンからの一時停止は利用者の一時停止（次の起動で自動で続けない）
  ipcMain.handle('engine:fetch-pause', () => (engineFetch ? engineFetch.pause('user') : { ok: true }));
  // ［取り込み先を開く］。まだ無ければ何もしない（フォルダは作らない）
  ipcMain.handle('engine:open-dir', () => { if (ENGINE_HOME.supported && fs.existsSync(ENGINE_HOME.root)) shell.openPath(ENGINE_HOME.root); return true; });
  // 辞書が初期プロンプトの予算に収まっているか（#23）。kept: 収まった語数、total: 辞書の語数。
  // 尻尾（直前の発言）は付けずに数える（辞書そのものの収まり具合を見せるため）
  ipcMain.handle('prompt:info', () => {
    const r = promptParts('');
    // off: いまは認識ヒントを渡していない。offReason: 'kotoba'（モデルが kotoba）／'empty'（渡すと空になった）
    const offReason = isKotobaModel() ? 'kotoba' : (promptOff() ? 'empty' : '');
    return { ok: true, kept: r.kept, total: r.total, over: r.over, off: Boolean(offReason), offReason };
  });
  ipcMain.handle('app:vad-status', () => {
    const p = resolveVadModel();
    return { path: p, auto: Boolean(p) && p !== settings.vadModelPath };
  });
  // 開くのはデータフォルダ <userData>/data（保存先はここだけ）
  ipcMain.handle('app:open-data-dir', () => { shell.openPath(dataRoot()); return true; });
  // Windows のサウンド設定を開く。録音されるスピーカーは「既定の再生デバイス」
  // で決まり、アプリ側から選ぶ手段は無いので、変える場所へ案内する。
  ipcMain.handle('app:open-sound-settings', () => {
    // URL は固定。画面から受け取った文字列を開くと、任意のURIを開けてしまう。
    shell.openExternal('ms-settings:sound').catch(() => {});
    return true;
  });
  ipcMain.handle('app:open-releases', () => {
    // URL は REPO 定数から組み立てる。画面から受け取ったURLを開くと、
    // 表示中の文字列次第で任意のページを開けてしまう。
    shell.openExternal(`https://github.com/${updater.REPO}/releases/latest`);
    return true;
  });
  // 0.9.2 I-1: ヘルプセンターを既定のブラウザで開く。画面から来るのは記事の名前（例 record/pause）だけで、決まった一覧
  // （lib.HELP_ARTICLES = help/site.json）にちょうどある名前だけ道にする。ほか（住所・文字でない物）はホーム。住所は画面から受け取らない
  ipcMain.handle('app:open-help', (_e, article) => {
    shell.openExternal(`${HELP_URL}${lib.helpPath(article)}`).catch(() => {});
    return true;
  });
  ipcMain.handle('app:version', () => ({ version: app.getVersion(), repo: updater.REPO }));
  ipcMain.handle('update:check', async () => {
    const r = await updater.check(app.getVersion(), app.getPath('userData'));
    // 画面側が「更新して再起動」を出すか「ダウンロード」を出すかの判断に使う（文とボタンは notice）
    return withNotice(r);
  });
  ipcMain.handle('update:apply', async (_e, url) => {
    // 録音中と議事録の保存の間は取り込みを始めない（第1d回 A-9。要約中の文は今のまま）
    const why = restartBlockNow();
    if (why === 'summary') return { ok: false, code: why, error: '要約を作成中です。終わってから更新してください' };
    if (why) return { ok: false, code: why, error: RESTART_BLOCK_TEXT[why] };
    const t = updateTarget();
    if (!t.ok) return { ok: false, error: t.error };
    return updater.apply(url, t.root, app.getPath('userData'),
      (msg) => sendToMainWin('update:progress', { message: msg }), { sha256: updateSha.get(String(url)) || '' });
  });
  ipcMain.handle('app:restart', async () => {
    // 録音中と議事録の保存の間は再起動しない（第1d回 A-9）。断ったら何も止めない（エンジン・DB・貼り付け）
    const why = restartBlockNow();
    if (why === 'summary') return { ok: false, code: why, error: '要約を作成中です。終わってから再起動してください' };
    if (why) return { ok: false, code: why, error: RESTART_BLOCK_TEXT[why] };
    quitting = true;
    stopEngine(whisperEng); stopPaster();
    // 議事録の DB を閉じてから（第2a1回 ST7）
    await db.close({ timeoutMs: DB_CLOSE_MS });
    relaunchAndExit();
    return true;
  });
  // ---- 設定のカード「オンライン」（第1c回 Task C-2。OL7・OL3・OL5・RF30）----
  // 0.7.0 の鍵の欄の IPC（cloud:status・cloud:set-key・cloud:test-key・cloud:clear-key）は、文字起こしを中継へ送るようにしたので
  // 第1d回 A-4（RL10・F11）で受け口・preload・画面を一緒に消した（PC に会社の鍵を置かない。残った鍵は起動のときに purgeOld が消す）
  // ---- ログイン（第1d回 Task A-2・A-11。RL10・RF32・F1・F12・F20・F21・F22・F27）----
  // ログインは Cloudflare Access の窓（openLoginWindow）。cookie は secrets に relay の名前でしまうだけで、画面・記録・知らせ・IPC の答えには
  // 出さない（返すのはログインしているか・メール・期限だけ）。記録は符号だけ（メールアドレスも書かない）。account:status は外へ通信しない
  // （ログインしているかは PC の中の accessState で決める）。文は計画「作り替え」の「画面と知らせの文」の AR1〜AR7・R12〜R16
  const relayHost = relay.relayProvider().host;
  const accountFail = (code, extra = {}) => ({ ok: false, code, message: lib.accountMessage(code, { host: relayHost, ...extra }) });
  ipcMain.handle('account:status', async () => {
    let canStore = false;
    try { canStore = Boolean(secrets) && await secrets.available(); } catch (_) { canStore = false; }
    const on = hasRelayLogin();
    const up = netOnline();
    return { ok: true, signedIn: on, email: on ? settings.accountEmail : '', method: 'access', until: on ? accessState.until : null, canStore, online: { up, why: up ? 'ok' : 'offline' } };
  });
  // 前の自前のログイン（確認コード）の口 account:start・account:verify は、画面のカード「アカウント」を Access の［ログイン］にした
  // 第1d回 A-12 で受け口ごと消した（preload の accountStart・accountVerify と relay.makeAccountApi も）
  ipcMain.handle('account:login', async () => {
    const r = await openLoginWindow();
    if (r.ok) return { ok: true, email: r.email, message: lib.accountMessage('login-ok') };
    return accountFail(r.code, r.host ? { host: r.host } : {});
  });
  ipcMain.handle('account:logout', async () => {
    const was = hasRelayLogin() || accessState.state !== 'none';
    let reached = 'ログインなし';
    if (was) {
      // Access のログアウト（その人のログインを全部の app で取り消す）。同じ partition の cookie で開き、転送にはついて行かない。
      // 届かなくても PC からは消す（F22）。見えない窓は作らない
      try {
        await sttCloud.postForm({ request: relayRequest, session: accessSession(), method: 'GET', url: relay.LOGOUT_URL, redirect: 'manual', timeoutMs: LOGOUT_TIMEOUT_MS });
        reached = 'ok';
      } catch (e) {
        reached = e instanceof sttCloud.CloudSttError && Number.isInteger(e.status) ? 'ok' : '届かない';
      }
    }
    // partition の中は全部空にする（cookie・localstorage など）
    try { await accessSession().clearStorageData(); } catch (e) { engineLog(`アカウント: ログインの入れ物を空にできません（${errCode(e)}）`); }
    const removed = secrets ? secrets.remove('relay') : { ok: true };
    accessState = ACCESS_NONE;
    loginExpired = false;
    setAccountEmail('');
    online.forget(relay.relayProvider().reachUrl);
    engineLog(`アカウント: ログアウトした（Access ${reached}）`);
    if (!removed.ok) return accountFail(removed.code || 'write');
    return { ok: true, message: lib.accountMessage('logout') };
  });
  // Claude Code の状態（claude:status は auth status だけ。-p は呼ばない）。同時に押されても子は1つだけ起こす。
  // ［Claude Code を確かめる］（claude:test）は、その後に確かめの小さな -p を1つ送る（第1b回の続き Lane F-b。auth status は
  // OAuth の鍵が切れても claude.ai と答える）。設定の画面の文は、要約の失敗の文（claudeMessage。「［要約を生成］を押してください」で終わる）とは分ける
  const CLAUDE_STATUS_TEXT = {
    'auth-expired': claudeCli.claudeMessage({ code: 'auth-expired' }),
    overloaded: 'Claude が混み合っています（ログインはできています）。少し待ってから［Claude Code を確かめる］を押してください。',
    timeout: `Claude Code が ${Math.round(claudeCli.PING_TIMEOUT_MS / 1000)} 秒たっても返事をしませんでした。少し待ってから［Claude Code を確かめる］を押してください。`,
    account: claudeCli.claudeMessage({ code: 'account' }),
    // 入れる・ログインはカードのボタンへ案内する（第1b回の続き Lane F-c・F-d。利用者にターミナルを打たせない。入れる命令は見せる）
    'not-found': `Claude Code が見つかりません。［Claude Code を入れる］を押すと、PowerShell の窓で Anthropic の公式の入れ方（\`${claudeCli.INSTALL_CMD}\`）を実行します。入れ終わったら［Claude Code にログイン］を押してください。`,
    'cmd-only': `Claude Code が \`claude.cmd\` の形（npm 版など）でしか見つからないため、NaTsu から呼べません。［Claude Code を入れる］で Anthropic の公式の入れ方（\`${claudeCli.INSTALL_CMD}\`）で入れ直すか、下の「Claude Code の場所」に \`claude.exe\` を指定してください。`,
    'not-logged-in': 'Claude Code にログインしていないか、ログインが切れています。［Claude Code にログイン］を押してログインしてください。',
    'api-billing': 'Claude Code が API キー（従量課金）で動く設定になっています。NaTsu は各自の Claude のプランだけを使うため、このままでは要約を作りません。ターミナルで `claude auth status` を実行して確かめ、`claude auth login` で claude.ai のアカウントにログインしてください。',
    'old-version': 'Claude Code が古いため、NaTsu から呼べません。ターミナルで `claude update` を実行してください。',
    other: 'Claude Code の状態を確かめられませんでした。少し待ってから［Claude Code を確かめる］を押してください。続くときは、理由の記録を見てください。理由の記録: %APPDATA%\\natsu\\engine.log',
  };
  const claudeStatusText = (code) => CLAUDE_STATUS_TEXT[Object.prototype.hasOwnProperty.call(CLAUDE_STATUS_TEXT, code) ? code : 'other'];
  // 上限はリセットの時刻を添える（確かめの要求が上限で断られても、ログインはできている）
  const claudeLimitText = (r) => {
    const at = r && typeof r.resetAt === 'string' ? r.resetAt.trim().slice(0, 40) : '';
    return `Claude の利用の上限に達しています${at ? `（${at} に戻ります）` : ''}。ログインはできています。戻ってから議事録の要約を作れます。`;
  };
  let claudeChecking = null;
  async function claudeStatusNow() {
    const f = claudeCli.findClaude({ configured: settings.claudeExe });
    if (!f.ok) {
      engineLog(`Claude Code の確かめ: ${f.code}`);
      // 場所を手で入れていて見つからないときは、その欄のことも添える（空にすると自動で探す）
      const hint = f.code === 'not-found' && settings.claudeExe ? '「Claude Code の場所」に入れたファイルが見つからないときは、場所を空にすると自動で探します。' : '';
      return { ok: true, found: false, cmdOnly: f.code === 'cmd-only', method: '', message: claudeStatusText(f.code) + hint };
    }
    // 作業フォルダは要約と同じ claudeRunDir()（NaTsu が作る空のフォルダ）。利用者のフォルダの設定を読ませない
    let cwd;
    try { cwd = claudeRunDir(); } catch (_) { cwd = path.join(app.getPath('userData'), 'claude-run'); /* 作れなくても auth status は動く */ }
    const r = await claudeCli.claudeAuthStatus({ cmd: f.cmd, spawn, cwd });
    engineLog(`Claude Code の確かめ: ${r.ok ? `ok（${r.method}）` : r.code}`);
    const method = typeof r.method === 'string' ? r.method : '';
    if (r.ok) return { ok: true, found: true, cmdOnly: false, method, message: '' };
    return { ok: true, found: r.code !== 'not-found', cmdOnly: false, method, message: claudeStatusText(r.code) };
  }
  const claudeStatus = () => {
    if (!claudeChecking) claudeChecking = claudeStatusNow().finally(() => { claudeChecking = null; });
    return claudeChecking;
  };
  let claudeTesting = null;
  async function claudeTestNow() {
    const s = await claudeStatus();
    if (!(s.found && s.method === 'claude.ai' && !s.message)) return s;   // auth status が通らなければ -p は送らない
    const f = claudeCli.findClaude({ configured: settings.claudeExe });
    if (!f.ok) return s;
    let cwd;
    try { cwd = claudeRunDir(); } catch (_) { cwd = path.join(app.getPath('userData'), 'claude-run'); }
    const r = await claudeCli.claudePing({ cmd: f.cmd, spawn, cwd });
    engineLog(`Claude Code の確かめの要求: ${claudeCli.runWhy(r)}`);   // 符号・副型・状態の番号だけ
    if (r.ok) return { ...s, verified: true };
    if (r.code === 'not-found') return { ...s, found: false, message: claudeStatusText('not-found') };
    return { ...s, message: r.code === 'limit' ? claudeLimitText(r) : claudeStatusText(r.code) };
  }
  const claudeTest = () => {
    if (!claudeTesting) claudeTesting = claudeTestNow().finally(() => { claudeTesting = null; });
    return claudeTesting;
  };
  ipcMain.handle('claude:status', () => claudeStatus());
  // Claude との連携（MCP。0.10.0 C-2。引数なし: 場所は main が決める）
  ipcMain.handle('mcp:status', () => mcpStatus());
  ipcMain.handle('mcp:register', () => mcpRegister());
  ipcMain.handle('mcp:unregister', () => mcpUnregister());
  // 議事録のリンクの住所の頭（0.10.0 L-1。D78・決めたこと 153: ヘルプのサイトの /open のページ。# の後ろの ID はサーバーへ送られない）
  ipcMain.handle('app:link-base', () => `${HELP_URL}open#p=`);
  // 画面の検索の窓に貼ったリンク（natsu:// か https の住所）の照らし（0.10.0 LN-4・決めたこと 148。画面は住所を持たないので main で照らす）。→ { id, anchor } か null
  ipcMain.handle('app:parse-link', (_e, s) => (typeof s === 'string' && s.length <= 1000 ? natsulink.parseAnyLink(s) : null));
  ipcMain.handle('claude:test', () => claudeTest());
  // ［Claude Code にログイン］［Claude Code を入れる］（第1b回の続き Lane F-c・F-d。利用者に PowerShell を打たせない）。
  // 見える窓は claudeCli.claudeOpenWindow が隠した PowerShell から開き、閉じるまで待つ。閉じたら確かめ直して、その答えを返す
  // （ログインの後は小さな要求まで、入れた後は auth status まで）。窓は1つずつ。NaTsu はログインの情報を読まない。記録は種類と符号だけ
  const CLAUDE_OPEN_TEXT = {
    busy: 'Claude Code の窓がもう開いています。窓での操作が終わったら閉じてください。',
    unsupported: 'この画面から Claude Code の窓を開けるのは Windows だけです。ターミナルで `claude auth login` を実行してください。',
    'no-powershell': 'PowerShell を起こせなかったため、Claude Code の窓を開けませんでした。',
    'open-failed': 'Claude Code の窓を開けませんでした。少し待ってからもう一度押してください。続くときは、理由の記録を見てください。理由の記録: %APPDATA%\\natsu\\engine.log',
  };
  let claudeWindow = null;
  async function claudeOpenNow(kind) {
    let exe = '';
    if (kind === 'login') {
      const f = claudeCli.findClaude({ configured: settings.claudeExe });
      if (!f.ok) {
        engineLog(`Claude Code の窓: ${kind} → ${f.code}`);
        return { ok: false, code: f.code, message: claudeStatusText(f.code) };
      }
      exe = f.cmd;
    }
    let cwd;
    try { cwd = claudeRunDir(); } catch (_) { cwd = undefined; }
    const r = await claudeCli.claudeOpenWindow({ kind, exe, spawn, cwd });
    engineLog(`Claude Code の窓: ${kind} → ${r.code}`);
    if (!r.ok) {
      const message = r.code === 'not-found' ? claudeStatusText('not-found') : (CLAUDE_OPEN_TEXT[r.code] || CLAUDE_OPEN_TEXT['open-failed']);
      return { ok: false, code: r.code, message };
    }
    const status = kind === 'login' ? await claudeTest() : await claudeStatus();
    return { ok: true, status };
  }
  const claudeOpen = (kind) => {
    if (claudeWindow) return Promise.resolve({ ok: false, code: 'busy', message: CLAUDE_OPEN_TEXT.busy });
    claudeWindow = claudeOpenNow(kind).finally(() => { claudeWindow = null; });
    return claudeWindow;
  };
  ipcMain.handle('claude:login', () => claudeOpen('login'));
  ipcMain.handle('claude:install', () => claudeOpen('install'));
  // ［この会議は PC の中だけ］は片道（会議中の true だけを受け取る。false で送る側に戻さない: RF28・C-3）。
  // 会議の外・false は何も変えず、今の印を同じ形 { ok, localOnly } で返す
  // ページの［一時停止］（第1b回 N4c）。on は true か false だけ（ほかは何も流さない）
  ipcMain.handle('meeting:set-paused', (_e, on) => (typeof on === 'boolean' ? requestOverlayPause(on, 'user') : { ok: false }));
  ipcMain.handle('meeting:set-local-only', (_e, on) => (on === true && meeting ? setMeetingLocalOnly(true)
    : { ok: false, localOnly: Boolean(meeting && meeting.localOnly) }));

  // 画面の覚え書きのうち画面が持つもの（第1b回 N6）。ui:get はサイドバーとタブを返す。タブは今あるページだけにし
  // （消したページのタブを戻さない: F7）、外した数だけを engine.log に1行（ページの id は書かない）。
  // ui:set は画面から来た値を照らしてから（幅を寄せる・録音中のタブと形の悪い鍵を捨てる）まとめ書きにする
  ipcMain.handle('ui:get', async () => {
    // 今あるページは一覧で見る（第2a1回 ST1）。DB の用意がまだ（起動・移行・起こし直しの間）・使えない・一覧を読めなかったら、
    // タブは外さずにそのまま返す（用意を待たない。止まっているのを「無い」にしない: F12）
    let ids = null;
    if (db.state() === 'ready' || db.state() === 'read-only') {
      try { ids = new Set((await db.call('pages.list', {})).map((p) => p.id)); } catch (e) { engineLog(`画面の覚え書き: 議事録の一覧を読めませんでした（${errCode(e)}）`); }
    }
    const k = W.keepTabs(winState.tabs, (id) => !ids || ids.has(id));
    const dropped = k.dropped + winTabsDropped;
    winTabsDropped = 0;
    if (dropped) engineLog(`画面の覚え書き: 無いページのタブを ${dropped} 個外した`);
    winState.tabs = k.tabs;
    return { sidebar: { ...winState.sidebar }, tabs: { open: winState.tabs.open.slice(), active: winState.tabs.active },
      slashRecent: Array.isArray(winState.slashRecent) ? winState.slashRecent.slice() : [] };   // 0.13.0 ED-5（決めたこと 39）
  });
  ipcMain.handle('ui:set', (_e, patch) => {
    winState = W.applyUi(winState, patch);
    saveWinState();
    return { ok: winStateState !== 'unreadable' };
  });

  ipcMain.handle('dialog:pick', async (_e, kind, key) => {
    const filters = kind === 'exe'
      ? [{ name: '実行ファイル', extensions: process.platform === 'win32' ? ['exe'] : ['*'] }]
      : [{ name: 'モデルファイル', extensions: ['bin', 'gguf'] }];
    // 画面からはパスを受け取らない。キーの名前だけを受け取り、開く場所は main が決める（EL3）
    const defaultPath = pickDefaultPath(String(key || ''), settings,
      { lastDir: lastPickDir, engineRoot: ENGINE_HOME.supported ? ENGINE_HOME.root : '', isDir: isDirSync });
    const res = await dialog.showOpenDialog(mainWin, { properties: ['openFile'], filters, ...(defaultPath ? { defaultPath } : {}) });
    if (!res.canceled && res.filePaths[0]) lastPickDir = path.dirname(res.filePaths[0]);
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.on('overlay:confirm', () => {
    if (state === 'recording') stopRecording();
    else if (state === 'meeting') stopMeetingBy('bar');
  });
  ipcMain.on('overlay:cancel-request', () => { if (state === 'recording') cancelRecording(); });
  ipcMain.on('audio:done', (_e, { buffer, durationMs }) => handleDictationAudio(Buffer.from(buffer), durationMs));
  // 0.12.0 SP-3a: 2つの流れの議事録は4つ目 meta（main が checkSegMeta で照らす）
  ipcMain.on('audio:segment', (_e, { buffer, durationMs, final, meta }) => onMeetingSegment(Buffer.from(buffer), durationMs, Boolean(final), meta));
  // 録音側が実際に何を録れているかを受け取る。設定がオンでも、再生デバイスが
  // 無い・他のアプリが排他で掴んでいる等で失敗しうる。黙ってマイクだけで進むと、
  // 会議が終わってから片側しか残っていないことに気づく——それが一番まずい。
  // 一時停止の状態を受け取る。記録中バーにも出す（オーバーレイを
  // 隠したまま席を外すと、止めたつもりが録れている／その逆が起きる）。
  // 第1b回 A-3: 返事が来たら頼んだ印を下ろす。再開したら止めた所（会議の時計 offsetMs。録音バーは区間を送り終えてから再開を
  // 知らせる）と長さの印を1つ残す（録音バーの［一時停止］を直接押したときも why は user）
  ipcMain.on('overlay:pause', (_e, { paused }) => {
    if (!meeting) return;
    // 0.10.0 K-1: main が頼んだ答えなら頼んだ側（画面のボタン・スリープ）、頼んでいなければ録音バーで押した
    const by = meeting.pauseAsked && meeting.pauseBy ? meeting.pauseBy : 'overlay';
    meeting.pauseBy = '';
    clearPauseAsk(meeting);
    if (paused && !meeting.paused) { meeting.paused = true; meeting.pausedAt = Date.now(); noteMeetingState(meeting, 'pause', by); leaveEvent({ type: 'pause', on: true }); }
    else if (!paused && meeting.paused) {
      noteMeetingState(meeting, 'resume', by);
      meeting.paused = false;
      meeting.pauses.push({ atMs: meeting.offsetMs, ms: Math.max(0, Date.now() - meeting.pausedAt), why: meeting.pauseWhy || 'user' });
      meeting.pausedMs += Date.now() - meeting.pausedAt;
      meeting.pauseWhy = '';
      meeting.resumeHint = false;
      meeting.hintOnPause = false;
      writeDraft();
      restartQuiet(meeting, 'resume');   // 0.9.1 Q-4（決めたこと 14）: 再開は人の答え。［続ける］と同じに数え直す
      leaveEvent({ type: 'pause', on: false });   // 0.12.1 LV-3（決めたこと L8）: 再開の後の読みから数える
    }
    syncLevelAsk();   // 0.9.3 M-5: 一時停止の間は聞かない
    if (paused && meeting.paused && meeting.hintOnPause) { meeting.hintOnPause = false; showResumeHint(meeting); return; }
    sendToMainWin('meeting:update', meetingStatus());
  });
  // 録音側が実際にどのマイクを掴んだか。設定のマイクが抜かれている・名前が
  // 変わっている等で要求と合わなかったときだけ「代替中」にする（#56）。
  ipcMain.on('overlay:mic', (_e, info) => {
    // 音声入力（議事録なし）からも届く。議事録が無いのに meeting:update を送ると、
    // 画面が「記録していない」状態として描き直し、走っている要約の進捗表示を消す
    if (!meeting) return;
    meeting.micFallback = !!(info && info.requested && !info.matched);
    sendToMainWin('meeting:update', meetingStatus());
  });
  ipcMain.on('overlay:source', (_e, { systemAudio, wanted }) => {
    if (!meeting) return;
    meeting.systemAudio = Boolean(systemAudio);
    if (wanted) noteSysSource(meeting, Boolean(systemAudio));   // 0.12.0 SP-3a（決めたこと 137・147）
    sendToMainWin('meeting:update', meetingStatus());
    if (wanted && !systemAudio) {
      sendToMainWin('app:notice',
        'パソコンから出ている音を取り込めませんでした。マイクの音だけで議事録を記録します。');
    }
  });
  ipcMain.on('audio:error', (_e, { message }) => {
    if (state === 'meeting' || state === 'meeting-finalizing') {
      // 0.9.0 O-4（RP8）: 隠したままマイクのエラーが来たら、録音バーを出してから締める（作成中の文を見せる）。音声入力は
      // finishWithError のエラーの文の前に sendToOverlay が出し直す
      showPanel();
      if (meeting) {
        // 録音側は最後の区間を送り終えてからこれを送る（overlay の settleSeg）ので、
        // ここで締めに入っても変換中の区間を取りこぼさない
        if (state === 'meeting') {
          // 会議の長さはここまで（stopMeeting と同じ締め方。文字起こし待ちを混ぜない）
          meeting.stoppedAt = Date.now();
          if (meeting.paused) { meeting.pausedMs += meeting.stoppedAt - meeting.pausedAt; meeting.paused = false; meeting.pausedAt = 0; }
          sendToMainWin('app:notice', `${message || 'マイクにアクセスできません'}。ここまでの録音で議事録を作成します。`);
        }
        meeting.stopping = true; state = 'meeting-finalizing';
        sendToMainWin('meeting:update', meetingStatus());
        maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
      }
    } else finishWithError(message || 'マイクにアクセスできません');
  });
  ipcMain.on('overlay:hidden-request', () => hideOverlayIfIdle());
  // 0.9.0 O-2（RP4）: 録音バーの画面が測ったピルの大きさ
  ipcMain.on('overlay:size', (_e, p) => onPanelSize(p));
  // 0.9.3 M-5: 録音バーが答えた音の大きさ（照らしてから録音中のページへ）
  ipcMain.on('overlay:level', (_e, p) => onOverlayLevel(p));
  // 0.9.0 O-4（RP8）: 縦の形の × で隠す（録音中だけ。録音は止めない）と、録音中のページの［録音バーを出す］
  ipcMain.on('overlay:hide-panel', () => hidePanel());
  ipcMain.handle('panel:show', () => { showPanel(); return { ok: true }; });
  // 0.9.3 M-3: 会議の検出のパネルの口（画面からは id も文も受けない）
  ipcMain.handle('nudge:start', (_e, o) => startFromNudge(o));
  ipcMain.on('nudge:close', () => { if (nudgeShown) nudgeEvent({ type: 'closed' }); });
  ipcMain.on('nudge:mute', () => muteFromNudge());
  ipcMain.on('nudge:settings', () => settingsFromNudge());
  ipcMain.on('nudge:size', (_e, p) => onNudgeSize(p));
  ipcMain.on('nudge:hover', (_e, on) => { if (nudgeShown) nudgeEvent({ type: 'hover', on: on === true }); });
}

// ---------------------------------------------------------------- 起動
// タスクバーのまとまりと通知の名前を、ショートカットと同じ APP_ID にする。呼ばないと app.name
// （小文字の natsu）から作られる。窓とトレイより先に呼ぶ。Windows だけの関数なので win32 のときだけ
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 0.10.0 LN-4: 2つ目の起動の引数にリンクがあれば、そのページを開く
  app.on('second-instance', (_e, argv) => { createMainWindow(); openLinkFromArgv(argv); });
  // 書き出しの合図（第1a回 JS8・RF21）。窓ができたら、その窓の session-end と query-session-end に付ける（Windows の
  // シャットダウン・再起動・サインアウト。隠れた本体の窓と録音バーにも付く）。窓を作る whenReady より前に付ける
  app.on('browser-window-created', (_e, w) => { w.on('session-end', flushAllWriters); w.on('query-session-end', flushAllWriters); });
  // 最後の守り（同期の書き出しは exit の受け口でも効く）
  process.on('exit', flushAllWriters);
  app.whenReady().then(async () => {
    // 鍵を取った後で、前回残った JSON の一時ファイルを片付ける（JS4。読む前に）
    cleanStartupTemps();
    // スリープ・画面のロック・シャットダウン（powerMonitor は ready の後でしか使えない）
    powerMonitor.on('suspend', flushAllWriters);
    powerMonitor.on('lock-screen', flushAllWriters);
    powerMonitor.on('shutdown', flushAllWriters);
    // 第1b回 A-3（RF4）: スリープは一時停止として頼み、戻ったら再開を促す。書き出しの受け口より後ろに付ける（書き出しが先に走る）
    powerMonitor.on('suspend', pauseForSuspend);
    powerMonitor.on('resume', promptAfterResume);
    loadStores();
    // 録音バーの前の位置を、置き場所の名前に1回だけ直す（0.9.0 O-1・RP2。screen は ready の後でしか使えない。窓と IPC の前に直さないと、
    // 画面の最初の settings:get が既定の置き場所を出し、ほかの欄の自動保存がそれを書いて直しを潰す: 計画の調べた結果の 41）
    migratePillSlot();
    // 画面の覚え書き（第1b回 N6）。窓を作る前に読んで照らす（壊れていたら知らせ W1 を startupNotices に）
    loadWinState();
    // ログインの札の保管（第1c回 OL3・第1d回 A-2。ready の後に作る）。作った直後に、0.7.0 までの鍵（groq・openai・custom。会社の
    // OpenAI の鍵が入りうる）と退けた控えを消す（第1d回 A-4・K2・F11。記録の1行は purgeOld が書く。投げない）
    secrets = makeSecrets({ file: path.join(app.getPath('userData'), 'secrets.json'), safeStorage, J, log: engineLog });
    secrets.purgeOld();
    // しまった Access のログイン（cookie）をメモリの partition へ戻す（第1d回 A-11。待たない: 経路の判断が accessReady を待つ）
    accessReady = restoreAccessCookies().catch((e) => engineLog(`アカウント: しまったログインを戻せません（${errCode(e)}）`));
    // 取り込んだエンジンの候補を記録から読む（読むだけ。フォルダは作らない）。照らし終えるまで managed は空なので、
    // 取り込んだ側は下の起動の行では起動しない（RF3）。手で設定した側は今までどおり起動する
    const installedRec = engineInstall.readInstalled(engineInstall.layout(ENGINE_HOME.root, MANIFEST).installed);
    managedCands = engineInstall.managedCandidates(ENGINE_HOME, MANIFEST, installedRec, fs.statSync);
    for (const g of MANAGED_GROUPS) if (managedCands[g]) managedState[g] = 'checking';
    // 取り込みのボタンを押したか（第1d2回 M-1）。読めなかった（掴まれている）ときは押したものとして扱う（0.8.0 の動きに倒す）。
    // 取り込めない PC（置き場所が無い）には記録が無い
    offlineConsent = Boolean(ENGINE_HOME.supported && (installedRec.consent || installedRec.unreadable));
    engineLog(`起動: オフラインの準備 ${isOfflineChosen() ? '選んだ' : '選んでいない'}`);
    // 起動の片付け（どれも DB の用意を待つ。投げない）: 1. 前に消しきれなかった取り消しを、下書きの復旧と写しの片付けより先に送る（第2a1回
    // RF16）。2. 下書きの復旧（復旧のページは db.call で作る）。待ってから待ち行列と掃除を決める（復旧中のフォルダを消さない）。
    // 3. 下書きを失った録音の写しを recovered で残す（読めない下書きが無ければ。keep はこの時の録音中・締めの返事待ちを入れて決める）。
    // DB がすぐ用意できるふつうの起動では今どおり済むのを待ってから窓とホットキーを用意する（復旧のページを窓が開く）。DB が利用者を
    // 待つ（移行の窓）か STARTUP_DB_WAIT_MS を過ぎたら待たずに進み、片付けは裏で続ける（第2a1回 M-4・F9: 移行の窓が出ている間・移行の
    // 間・起こし直しの間も、窓とホットキーで録音を始められる。録音は DB に頼らない）
    const startupWork = (async () => {
      await flushPurgePending();
      const startupDrafts = await recoverDraftIfAny();
      settleCopies(startupDrafts);
      if (!recoveryQueue) recoveryQueue = loadSavedRecoveryQueue();   // 前回エンジンが無くて残した分
      cleanOrphanSegbuf(recoveryQueue ? recoveryQueue.dir : '');   // 復旧の後で（復旧中のフォルダは残す。7 日より新しい今の会議のフォルダも消さない）
    })();
    startupWork.catch((e) => engineLog(`起動の片付けに失敗: ${errCode(e)}`));
    await Promise.race([startupWork.catch(() => {}), dbNeedsUser, new Promise((r) => { setTimeout(r, STARTUP_DB_WAIT_MS); })]);
    applyTheme();
    setupIpc();
    // 相手の声（パソコンから出ている音）を録るための受け口。
    // これを設定しないと getDisplayMedia は必ず失敗する。
    // 第2引数（useSystemPicker）は Electron 33 以降のもの。ここで渡すと
    // ハンドラごと無効になるので、引数はコールバック1つだけにする。
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      // Electron 33 から request.frame は null のことがあり、44 では壊れた枠を渡すと callback が投げる。
      // 枠の読み取りも callback も try で包み、断るときは null を渡す（{} は main で TypeError になる）
      let frame = null;
      let url = '';
      try { frame = (request && request.frame) || null; url = frame ? String(frame.url || '') : ''; } catch (_) { frame = null; url = ''; }
      const streams = chooseDisplayMedia({
        platform: process.platform,
        frame,
        enabled: Boolean(settings.useSystemAudio),   // 設定がオフなら誰にも渡さない
        url,
      });
      try { callback(streams); } catch (e) { engineLog(`相手の声の取り込みを渡せませんでした: ${e && e.message}`); }
    });
    // 窓を作る前に守りを付ける（許可の受け口・file:// の画面への CSP・移動と新しい窓の禁止。第1a回 SEC1）
    // 第1d回 A-11（F25）: ログインの窓（ログインの partition）だけは、全体の「必ず止める」の代わりに loginGuard で行き先を決める
    security.install({ app, session: session.defaultSession, pages: RENDERER_PAGES, log: engineLog, isLoginContents, loginGuard });
    createOverlay();
    // 0.9.0 O-2: 画面の拡大率・作業領域の変化と、画面が外れたとき（録音中なら置き直す）
    if (typeof screen.on === 'function') {
      screen.on('display-metrics-changed', onDisplayChanged);
      screen.on('display-removed', onDisplayRemoved);
      // 0.9.3 M-3: 会議の検出のパネルも置き直す・出している画面が外れたら引っ込める
      screen.on('display-metrics-changed', onNudgeDisplayChanged);
      screen.on('display-removed', onNudgeDisplayRemoved);
    }
    // 登録できなかった側だけ既定に落として再試行する（成功した側はそのまま）。
    // 有効なキーは activeHotkeys にだけ持ち、settings には書かない。settings に書くと
    // settings:get が既定を返して設定画面に既定が出、次の無関係な保存（自動起動の
    // 切り替えなど）でディスクにも漏れて、利用者が選んだキーが黙って消える。
    // トレイより先に決めておく（トレイの表示は activeHotkeys から組む）。
    {
      const r = resolveStartupHotkeys(settings, DEFAULT_SETTINGS, applyHotkeys);
      activeHotkeys = r.active;
      hotkeyState = r.state;
      hotkeyNote = r.note;
      if (!r.state.ok) engineLog(`ホットキー: ${r.state.message}`);
    }
    createTray();
    if (engineValid(whisperEng)) warmWhisper().catch((e) => engineLog(`文字起こしエンジンの先読みに失敗: ${logReason(e)}`));
    // 照らし終えたら managed に入れて起動し直す（待たない）。照らしの後の起動などで投げても、main で unhandled にしない
    verifyManagedAtStartup().catch((e) => engineLog(`取り込んだエンジンの照らしと起動に失敗: ${e && e.message}`));
    // 使われないエンジンを 60 秒ごとに見て止める（#58。判断は mainlib.idleEnginesToStop）
    setInterval(releaseIdleEngines, ENGINE_IDLE_CHECK_MS);
    // 文字起こし待ちの見回り（第1d2回 M-3）: 中継が戻った・オンラインに戻ったら、残した音声を文字起こしする
    setInterval(retryKeptWhenBack, KEPT_CHECK_MS);
    // 復旧ページに文字起こし待ちの音声が残っていれば、エンジンの用意を待って順に片付ける（起動の片付けが済んでから。下の startupWork）
    startupWork.then(() => transcribeRecovered()).catch((e) => engineLog(`復旧の文字起こしに失敗: ${logReason(e)}`));
    ensurePaster();
    createMainWindow();
    // 0.10.0 C-2: Claude デスクトップへの登録を1回だけ確かめる（読むだけ。場所が古い・消えたときだけ知らせる）
    checkMcpRegistration().catch(() => {});   // 0.10.1 CD-4: 起動のときの書き直し（投げない）
    // 0.10.0 LS-4: 0.9.x で取り込んだ要約のエンジンとモデルを消す（全部消せるまで起動ごとに1回。知らせは1回）
    retireSummaryEngine().catch((e) => engineLog(`要約のエンジンを消す: 失敗（${errCode(e)}）`));
    // 0.10.0 LN-3: natsu:// の登録（パックした NaTsu で場所が変わったときだけ書き直す）
    registerNatsuProtocol();
    // 0.10.0 LN-4: リンクで起こされたとき（起動の引数の -- の後ろの natsu://）は、そのページを開く
    openLinkFromArgv(process.argv);
    // 0.9.3 M-2: 会議の検出の見張り（Windows・設定がオン・録音していないとき）。窓とトレイの後に起こす
    detectReady = true;
    detectBusy = state;
    try { nativeTheme.on('updated', onNudgeTheme); } catch (_) { /* 明暗の知らせが無くても出すときの明暗で描く */ }
    nudgeSt = lib.nudgeInit({ on: settings.meetingDetect !== false, mute: settings.meetingDetectMute });
    syncMicWatch();
    app.on('activate', () => createMainWindow());
    // 取り込みの続きを自動で始める（第0b回 Task 14）。係は同意済みで利用者が一時停止していないときだけ動き、
    // 大きな取り込み直しは始めない（押されるまで待つ。RF13）。窓とエンジンの起動を先に済ませてから
    setTimeout(() => {
      if (quitting) return;   // 終了が始まっていたら始めない（before-quit の一時停止の後に係を作り直さない）
      try { getEngineFetch().start({ auto: true }); } catch (e) { engineLog(`取り込みの続きを始められません: ${e && e.message}`); }
    }, ENGINE_FETCH_AUTO_MS);

    // 起動から少し置いて更新確認。オフラインなら黙って諦める
    setTimeout(async () => {
      const r = await updater.check(app.getVersion(), app.getPath('userData'));
      if (r.ok && r.update) sendToMainWin('update:available', withNotice(r));
    }, 8000);
  });
  app.on('window-all-closed', () => { /* トレイ常駐 */ });
  app.on('before-quit', (e) => {
    flushAllWriters();
    quitting = true;
    // 取り込みを止める（.part は確定して残り、次の起動で続く。利用者の一時停止としては残さない）。
    // 止めるときに投げても、下の要約の「中断された」の印とエンジンの停止は続ける
    try { if (engineFetch) engineFetch.pause('quit'); } catch (_) { /* noop */ }
    // 要約の途中で終了するなら、そのページに「中断された」と書いておく（#52）。書かないと、次に開いたときに要約が空のまま
    // 何も言わないページになる。書き込みは db.call で非同期なので（第2a1回 ST1）、1回だけ終了を止め、書き込み（合わせて
    // QUIT_MARK_MS まで）を待ち、議事録の DB を閉じて（cleanShutdown を書いてチェックポイント。第2a1回 ST7。待ちは DB_CLOSE_MS まで）
    // から app.quit() をもう一度呼ぶ。2回目は quitMarkDone が立っているので止めない。要約が無くても DB を閉じるために1回止める
    if (!quitMarkDone) {
      quitMarkDone = true;
      if (e) e.preventDefault();
      const running = runSummary.running();
      const marks = running.map((id) => saveIfExists(db, id, (p) => { p.summaryError = '要約が中断されました。「要約を生成」で作り直せます'; })
        .catch((err) => engineLog(`終了のときに要約の中断を書けませんでした: ${errCode(err)}`)));
      let timer = null;
      Promise.race([Promise.all(marks), new Promise((r) => { timer = setTimeout(r, QUIT_MARK_MS); })])
        .then(() => { if (timer) clearTimeout(timer); return db.close({ timeoutMs: DB_CLOSE_MS }); })
        .catch((err) => engineLog(`終了のときに議事録の DB を閉じられませんでした: ${errCode(err)}`))
        .then(() => app.quit());
      return;
    }
    stopEngine(whisperEng); stopPaster(); stopMicWatch();
  });
  app.on('will-quit', () => { flushAllWriters(); globalShortcut.unregisterAll(); stopEngine(whisperEng); stopPaster(); stopMicWatch(); });
}

// 読み直し（retrySettingsRead）で本当の値に切り替えたときに当てる（第1a回 Task 2-3）。settings:save の当てる行と同じもの
// （あちらはそのまま残す）。ファイルの最後に置くのは、repo.test.js の起動のホットキーの確かめが、最初の
// resolveStartupHotkeys( の呼び出し（起動の所）から読むため（ここが先にあると、その確かめが起動の所を見なくなる）
function applyReloadedSettings(prev, next) {
  if (prev.meetingDetect !== next.meetingDetect || JSON.stringify(prev.meetingDetectMute) !== JSON.stringify(next.meetingDetectMute)) applyDetectSettings(prev);   // 0.9.3 M-2
  if ((prev.autoStopLeave !== false) !== (next.autoStopLeave !== false)) applyLeaveSetting();   // 0.12.1 LV-2
  // ホットキーは起動のときと同じ決め方（登録できなければ既定に退避し、settings には書かない）
  if (prev.hotkey !== next.hotkey || prev.meetingHotkey !== next.meetingHotkey) {
    const r = resolveStartupHotkeys(next, DEFAULT_SETTINGS, applyHotkeys);
    activeHotkeys = r.active;
    hotkeyState = r.state;
    hotkeyNote = r.note;
    if (!r.state.ok) engineLog(`ホットキー: ${r.state.message}`);
  }
  applyTheme();
  restartEnginesIfNeeded();
  // 保留していた復旧（起動のときは既定の設定でエンジンが無く止めていた分）を、本当の設定になった機会にもう一度試す
  if (recoveryQueue) transcribeRecovered().catch((e) => engineLog(`復旧の文字起こしに失敗: ${logReason(e)}`));
  if (next.autoLaunch !== prev.autoLaunch) {
    try { app.setLoginItemSettings({ openAtLogin: next.autoLaunch }); } catch (_) { /* noop */ }
  }
  updateTray();
}
