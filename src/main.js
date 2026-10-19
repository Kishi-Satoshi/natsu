/*
 * NaTsu — 音声入力・議事録ツール（オンラインはクラウドの文字起こしと各自の Claude Code の要約、オフラインは手元の whisper と llama）
 *
 * 文字起こし(whisper.cpp) も要約(llama.cpp) もすべてローカルで完結する。
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
const { enrichActionBlocks, groundActionFields } = require('./actions');
const updater = require('./updater');
const { chooseDisplayMedia } = require('./loopback');
// オンラインの文字起こし（第1c回 OL1〜OL4）: オンラインかの判定と経路・OpenAI と同じ形の口・鍵の保管
const { makeOnline, decideStt, decideSummary } = require('./online');
const sttCloud = require('./stt-cloud');
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
const security = require('./security');
const RENDERER_PAGES = { app: path.join(__dirname, 'renderer', 'app.html'), overlay: path.join(__dirname, 'renderer', 'overlay.html') };
const minutes = require('./minutes');
// オンラインの要約（第1c回 OL5）: 利用者の Claude Code を子のプロセスで呼ぶ部品
const claudeCli = require('./claude-cli');
const { markdownToBlocks, dropRedundantEmpty } = minutes;
// テンプレートの写し（見出しだけ・雛形そのまま）を落とす。minutes.js 側に
// まだ無い版でも動くよう、無ければ素通しにする。
const dropTemplateEcho = minutes.dropTemplateEcho || ((b) => b);
const { defaultSettings, readSettings, pickSavable, isSettingsShape, SETTING_RULES } = require('./settings');
// DB の外の JSON（設定・履歴）を読む・退ける・書く部品（第1a回 JS1〜JS3・JS6）
const J = require('./jsonfile');
// 画面の覚え書き（第1b回 N6）の照らし。純粋な関数だけ（Electron を読まない）。読み書きは上の J で行う
const W = require('./winstate');
// エンジンの取り込み（第0b回 R7）。置き場所・記録・照らし（通信しない）とピン（版・URL・大きさ・SHA-256）
const engineInstall = require('./engine-install');
const { MANIFEST } = require('./engine-manifest');
const { localDateISO } = require('./dates');
const {
  saveIfExists, meetingDurationSec, promptTail,
  registerHotkeys, resolveStartupHotkeys, saveHotkeys, makeSummaryRunner, tickStep,
  pasterScript, parsePasterLine,
  engineFileIssue, engineIssueMessage, engineInAppDir, engineDirWarning, portInUseError, guardEngineSettings, keptDifferent, closeConfirm, logReason,
  engineSpawnPlan, vcRuntimeVersions, vcRuntimeIssue, runtimeGate, engineExitHint, spawnErrorHint, speedLine,
  extractNotes, truncationMessage, buildPromptParts,
  publicSegments, settledSegments, pendingDurationMs, recoverSegments, staleSegbufDirs, nextSegmentMs, EtaTracker, chooseDraftName,
  skipPendingSegments,
  estimateTokens, foldNotes, idleEnginesToStop, silentWav, wavLevelDbfs, mergeSummaryType, memoEvidence,
  sameShas, keepPrevious, candStamp, repairIdsOf, pathUsedBy, fetchMinutesLeft,
  pickDefaultPath,
} = require('./mainlib');
// クリップボードの読み書き（mainlib.copyPrivate・deliverText）は main.js の同じ名前の包みとぶつかるので、lib から呼ぶ
const lib = require('./mainlib');

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
const SUM_MAX_TOKENS = 3000;   // 最終的な議事録
const NOTE_MAX_TOKENS = 900;   // 分割要約の各パート
// 文脈長（settings.sumCtx）のうち、指示文・役割名・書式の余白として取っておく分（#41）
const SUM_CTX_MARGIN = 256;
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
  // 起きた後は、係が待ちの時計（60 秒）と net.isOnline で自分で試し直す
  const busy = state !== 'idle' || isSummarizing() || engineFetchDownloading();
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
let segChain = Promise.resolve();
let pendingSegs = 0;

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
  // 画面の覚え書き（第1b回 W1。P16）
  winStateBroken: (name) => `画面の覚え書き（窓の大きさ・開いていたタブ）のファイルが壊れていたため、脇へ退けて最初の大きさで開きました（退けた先: ${name}）。`,
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
// 諦めた・使えないときは知らせ D1 を1回（録音は下書きと音声の控えに続く）。移行の窓は M-4 で作るので、この段は聞かずに移す
let dbDownNoticed = false;
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
    if (dbDownNoticed) return;
    dbDownNoticed = true;
    engineLog(`DB: 使えないので知らせた（${ev.why}）`);
    laterNotice(NOTICE.dbDown);
  } else if (ev.type === 'migrate-plan' && !ev.auto) db.migrate(true);
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
  if (!dbPortStale) return;
  dbPortStale = false;
  sendDbPort();
});
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
function flushAllWriters() { try { retryUnsavedRecovery(); } catch (_) { /* 書き直せなくても設定などの書き出しは続ける */ } return J.flushAll(); }
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
  const res = (v) => ({ state: r.state, settings: v, notices });
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
    return res(rs.settings);
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
    if (s.sumThreads === CPU_OLD_DEFAULT_THREADS) s.sumThreads = CPU_DEFAULT_THREADS;
  }
}

function loadStores() {
  // 保存時と同じ決まり（settings.js の readSettings）を通す。手で編集された settings.json のポートが文字列や
  // 範囲外だと、起動直後だけ正規化をすり抜けてエンジンの起動待ちが静かに失敗する。
  const ls = loadSettingsFromDisk();
  settings = ls.settings;
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

// ---------------------------------------------------------------- エンジン管理
function makeEngine(name) {
  // lastUsed: 起動時と推論のたびの時刻。使われないまま engineIdleMin 分たったら止める（#58）
  return { name, proc: null, ready: false, lastError: '', readyPromise: null, startPromise: null, sig: '', stderrTail: '', stopping: false, lastUsed: 0 };
}
const whisperEng = makeEngine('文字起こしエンジン');
const sumEng = makeEngine('要約エンジン');
// 取り込んだエンジン（第0b回 設計 B）。詳細設定の実行ファイルとモデルが両方空の側だけが使う。設定には書かない（RF7）。
// 取り込み先は %LOCALAPPDATA%\natsu\engine（Windows の x64 だけ。それ以外の PC では supported が偽で、今までどおり）
const ENGINE_HOME = engineInstall.engineRoot(process.env, process.platform, process.arch);
let managed = { whisper: null, sum: null };            // この起動の中で照らし終えた組だけ（RF3）。暇なときだけ入れ替える（Task 14）
let managedCands = { whisper: null, sum: null };       // 記録から見た候補（まだ照らしていない）
let managedState = { whisper: 'none', sum: 'none' };   // 'none' | 'checking' | 'ok' | 'broken'
let managedTried = { whisper: null, sum: null };       // 照らし終えた候補の印（mainlib.candStamp）。合わなかった組を、変わるまで照らし直さない（Task 14）
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

function engineSpawnArgs(eng) {
  if (eng === whisperEng) {
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
  return [
    '-m', engineModel(eng),
    '--host', '127.0.0.1',
    '--port', String(settings.sumPort),
    '-t', String(settings.sumThreads),
    '-c', String(settings.sumCtx),   // 文脈長（#41）。統合プロンプトが収まらなければ要点メモを畳む
    // 取り込んだ llama にだけ（第0b回 Task 16）: RAM のプロンプトの控えを使わない・席を1つ・flash attention・
    // 考える手順を切る（b11669 の既定では Gemma 4 が考える文で時間と max_tokens を食う）。
    // 手で設定した exe には渡さない（古い llama-server は知らない旗で止まる）。画像・音声の部品は取り込まないので渡さない
    ...(manualGroup(eng) ? [] : ['--cache-ram', '0', '-np', '1', '-fa', 'on', '--reasoning', 'off']),
  ];
}
// 詳細設定の実行ファイルとモデルが両方空の側は、取り込んだエンジン（第0b回）。片方でも入っていれば今までどおり手の設定
// （第0b回 Task 16 の要約の旗もこれで分ける）。取り込んだ側は、照らし終えた組（managed）が無ければパスは空
const manualGroup = (e) => (e === whisperEng ? Boolean(settings.localServerExe || settings.localModelPath) : Boolean(settings.sumServerExe || settings.sumModelPath));
const managedFile = (e, k) => { const g = managed[e === whisperEng ? 'whisper' : 'sum']; return (g && g[k]) || ''; };
const engineExe = (e) => (manualGroup(e) ? (e === whisperEng ? settings.localServerExe : settings.sumServerExe) : managedFile(e, 'exe'));
const engineModel = (e) => (manualGroup(e) ? (e === whisperEng ? settings.localModelPath : settings.sumModelPath) : managedFile(e, 'model'));
const enginePort = (e) => (e === whisperEng ? settings.localPort : settings.sumPort);
const engineConfigured = (e) => Boolean(engineExe(e) && engineModel(e));
// 実行ファイルとモデルは「あるか」だけでなく中身まで見る（#32。判断は mainlib.engineFileIssue）。
// 存在だけを見ると、OneDrive のプレースホルダ（大きさはあるが実体がこの PC に無い）や
// 途中で切れたダウンロードを「ある」と誤認し、起動して落ちるまで原因が分からない。
// 下限はどの配布物でも下回らない大きさ（exe は数 MB、whisper は tiny でも 75MB、
// 要約の gguf は最小のものでも数百 MB）。
// 床を置くのはモデルだけ。実行ファイルの大きさでは壊れているか判断しない——上流の配布構成は
// 変わる。llama.cpp は llama-server.exe を 9,216 バイトの薄いランチャにし、中身を
// llama-server-impl.dll（約 8.9MB）へ移した。床を置くと、その正常な exe を「壊れている」と
// 断じて製品を使えなくする（実機で起きた）。本当の判定は起動して /health が応えるかどうかで、
// ここの検査は「より良い文を出すためのおまけ」に過ぎない。誤検知の害の方が桁違いに大きい。
const ENGINE_MIN_BYTES = { whisper: 50_000_000, gguf: 300_000_000 };
const fileSize = (f) => { try { return fs.statSync(f).size; } catch (_) { return 0; } };
// 問題があれば利用者向けの一文、無ければ ''
function engineCheck(eng) {
  // 取り込んだ側は、確かめ中・壊れた・ランタイムで止める・まだ無い を先に伝える（第0b回 RF3・RF4）
  if (!manualGroup(eng) && ENGINE_HOME.supported) { const m = managedIssue(eng); if (m) return m; }
  if (!engineConfigured(eng)) return `${eng.name}の実行ファイルまたはモデルが見つかりません`;
  const stat = (f) => fs.statSync(f);
  // 実行し直すスクリプトはエンジンごとに違う。名指ししないと利用者はどれか分からない
  const ps = eng === whisperEng ? 'setup-local-engine.ps1' : 'setup-summarizer.ps1';
  const exe = engineFileIssue(engineExe(eng), 0, stat);   // 大きさの床は置かない（0 バイトとプレースホルダだけ見る）
  if (exe !== 'ok') return `${eng.name}の${engineIssueMessage(exe, 'exe', fileSize(engineExe(eng)), engineExe(eng), ps)}`;
  const model = engineFileIssue(engineModel(eng), eng === whisperEng ? ENGINE_MIN_BYTES.whisper : ENGINE_MIN_BYTES.gguf, stat);
  if (model !== 'ok') return `${eng.name}の${engineIssueMessage(model, 'model', fileSize(engineModel(eng)), engineModel(eng), ps)}`;
  // whisper は英数字以外のパスを読めずに落ちる（RF1）。相対にしても日本語が残るなら起動しない。
  // engine:status と起動テストにも同じ理由が出る（startEngine は先にここを見る）
  if (eng === whisperEng) {
    const plan = engineSpawnPlan(engineExe(eng), engineSpawnArgs(eng), { whisper: true });
    if (plan.problem) return plan.problem;
  }
  return '';
}
// アプリのインストール先（NaTsu.exe のあるフォルダ）。開発中は Electron の実行ファイルの
// 場所になるが、その下にエンジンを置く人は居ないので誤検知しない
const appInstallDir = () => path.dirname(process.execPath);
// エンジンがインストール先の中にあれば移動を促す一文（更新のたびに消えうる。mainlib.engineDirWarning）
const engineDirNote = (eng) => engineDirWarning([engineExe(eng), engineModel(eng)], appInstallDir());
const engineValid = (e) => !engineCheck(e);
// 未設定なのか、設定はあるが中身に問題があるのかを分けて伝える
// 取り込める PC で手の設定が無い側は［エンジンを取り込む］へ案内する。どちらの文も「未設定」の語を残す
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
    return fetchable ? '文字起こしエンジンが未設定です。設定タブの［エンジンを取り込む］から取り込んでください。'
      : '文字起こしエンジンが未設定です。設定タブでパスを指定してください。';
  }
  return engineCheck(whisperEng);
}
// 取り込んだ側の、使えない理由（無ければ ''）。engineCheck の頭で見る（engine:status と起動テストにも同じ文が出る）
function managedIssue(eng) {
  const g = eng === whisperEng ? 'whisper' : 'sum';
  if (managedState[g] === 'checking') return `${eng.name}を確かめています（数秒で終わります）`;
  if (managedState[g] === 'broken') {
    return `${eng.name}のファイルが消えたか変わっています。ウイルス対策が消した可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。取り直しています`;
  }
  // 取り込んだ組だけ、Visual C++ ランタイムが無い・古いなら起動しない（RF4。手で設定した組は記録だけ: Task 10）
  if (managed[g]) return runtimeGate(engineRuntimeIssue(eng), { managed: true }) === 'block' ? engineRuntimeIssue(eng).message : '';
  return `${eng.name}はまだ取り込んでいません。設定タブの［エンジンを取り込む］を押してください`;
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
  const key = `${eng === whisperEng ? 'whisper' : 'sum'}|${engineExe(eng)}`;
  if (!runtimeIssueCache.has(key)) {
    runtimeIssueCache.set(key, vcRuntimeIssue(vcRuntimeVersions(path.dirname(engineExe(eng)), system32Dir(), readFileHead), { whisper: eng === whisperEng }));
  }
  return runtimeIssueCache.get(key);
}
// 覚えた版を忘れる。［起動テスト］（app:test・app:test-sum）の最初に呼ぶ。担当がランタイムを入れた後、
// INSTALL の「入れてもらってから、もう一度お試しください」のとおり、NaTsu を起動し直さずに押せば読み直す（RF4）。
// engine:status・記録の開始・エンジンの起動は、今までどおり覚えた版を使う（そのたびに DLL を読まない）
function forgetRuntimeIssues() {
  runtimeIssueCache.clear();
}
// 取り込む組のランタイム。取り込む前の欄にも出す（数 GB を落としてから知らせない。RF4・Task 15）。
// whisper の置き場所 → System32 の順に読む（whisper は vcomp140 も要るので、llama の分も含む）。覚え方は engineRuntimeIssue と同じ。
// Windows 以外・取り込めない PC は null
function managedRuntimeIssue() {
  if (process.platform !== 'win32' || !ENGINE_HOME.supported) return null;
  const exe = engineInstall.layout(ENGINE_HOME.root, MANIFEST).whisper.exe;
  const key = `whisper|${exe}`;
  if (!runtimeIssueCache.has(key)) runtimeIssueCache.set(key, vcRuntimeIssue(vcRuntimeVersions(path.dirname(exe), system32Dir(), readFileHead), { whisper: true }));
  return runtimeIssueCache.get(key);
}

function engineSignature(eng) {
  return [engineExe(eng), engineModel(eng), enginePort(eng),
    eng === whisperEng ? settings.localThreads : settings.sumThreads,
    eng === whisperEng ? settings.language : '',
    eng === whisperEng ? `${settings.useVad ? resolveVadModel() : ''}|${settings.suppressNst}` : '',
    eng === whisperEng ? '' : settings.sumCtx].join('|');   // 文脈長を変えたら要約エンジンを起動し直す（#41）
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
  for (const eng of idleEnginesToStop([whisperEng, sumEng], Date.now(), settings.engineIdleMin, isBusy())) {
    engineLog(`${eng.name}: ${settings.engineIdleMin} 分使われていないため停止（メモリを解放）`);
    stopEngine(eng);
  }
}
// トレイの「エンジンを停止（メモリを解放）」。次に使うときは起動し直す
function stopEnginesFromTray() {
  if (isBusy()) return;
  engineLog('トレイからエンジンを停止（メモリを解放）');
  stopEngine(whisperEng); stopEngine(sumEng);
}

function ensureEngineReady(eng) {
  if (eng.ready && eng.proc) return Promise.resolve(true);
  if (eng.readyPromise) return eng.readyPromise;
  const self = (async () => {
    if (!eng.proc) await startEngine(eng);
    let p = eng.proc;
    if (!p) return false;
    // 「/」は見ない。llama-server はモデル読み込み中でも「/」に 200 を
    // 返すため、準備完了と誤認して直後の推論が 503 になる（実機で発生）。
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
  for (const eng of [whisperEng, sumEng]) {
    if (eng.proc && eng.sig !== engineSignature(eng)) stopEngine(eng);
  }
  if (!whisperEng.proc && engineValid(whisperEng)) warmWhisper().catch((e) => engineLog(`文字起こしエンジンの先読みに失敗: ${logReason(e)}`));
}

// ---------------------------------------------------------------- 取り込んだエンジン（第0b回 設計 B・RF3）
// 取り込んだ exe と DLL を、この起動の中で SHA-256 で照らし終えてから使う（RF3。whisper 約 11.9MB・llama 約 44.4MB）
async function verifyManagedAtStartup() {
  let v;
  try {
    v = await engineInstall.verifyCandidates(managedCands);
    managedTried = managedStamps(managedCands);   // 合わなかった組は、取り直されるか触られるまで照らし直さない（Task 14）
  } catch (e) {
    // 照らせなかった組は使わない（「確かめています」のまま残さない）
    engineLog(`取り込んだエンジンの照らしに失敗: ${e && e.message}`);
    v = { whisper: null, sum: null, bad: [] };
  }
  managed = { whisper: v.whisper, sum: v.sum };
  for (const g of ['whisper', 'sum']) managedState[g] = !managedCands[g] ? 'none' : v[g] ? 'ok' : 'broken';
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
const managedChecking = () => ['whisper', 'sum'].some((g) => managedState[g] === 'checking' && !manualGroup(engOf(g)));

// 取り込みの欄の写し（設定タブの画面が読む。Task 15）。読むだけ: 通信もフォルダ作りもしない
// 照らしで合わなかった組は候補から外す（using・whisperReady で「使える」と見せず、画面が取り込みの欄を隠さない。RF3）
async function engineFetchStatus() {
  const installed = engineInstall.readInstalled(engineInstall.layout(ENGINE_HOME.root, MANIFEST).installed);
  const plan = engineInstall.planInstall(MANIFEST, installed, fs.statSync, ENGINE_HOME.root);
  const checking = managedChecking();
  const s = engineInstall.statusOf({ home: ENGINE_HOME, manifest: MANIFEST, plan, candidates: { whisper: usableCand('whisper'), sum: usableCand('sum') }, runner: engineFetch && engineFetch.status(),
    manual: { whisper: manualGroup(whisperEng), sum: manualGroup(sumEng) }, freeBytes: await engineInstall.freeBytesOf(ENGINE_HOME.root),
    runtime: managedRuntimeIssue(), installed });
  return { ...s, checking };
}

// ---------------------------------------------------------------- 取り込みの係と切り替え（第0b回 Task 14・RF3・RF8・RF13）
const ENGINE_FETCH_AUTO_MS = 10000;   // 起動から、取り込みの続きを自動で始めるまで（窓とエンジンの起動を先に済ませる）
const MANAGED_NAMES = { whisper: '文字起こしエンジン', sum: '要約エンジン' };
const engOf = (g) => (g === 'whisper' ? whisperEng : sumEng);
const managedStamps = (cands) => ({ whisper: candStamp(cands.whisper, fs.statSync), sum: candStamp(cands.sum, fs.statSync) });

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
// 実際に取っているか（係の state が running）。省電力の抑止が見る（待っている・止めている間は眠らせてよい。Q14）
function engineFetchDownloading() { return Boolean(engineFetch && engineFetch.downloading()); }

// 係の写しに、main だけが知っていることを入れる（engine:fetch-status と同じ見え方）: 使える組（using・whisperReady・sumReady）は
// 係の記録ではなく main が切り替えた組で決め（usableCand。照らしで合わなかった組は「使える」と見せない: RF3）、
// 確かめている途中か（checking）と、取り込む組の Visual C++ ランタイムの案内を入れる（係は Electron もランタイムも知らない。RF4）
function fetchView(s) {
  if (!s || !Array.isArray(s.items)) return s;
  const c = { whisper: usableCand('whisper'), sum: usableCand('sum') };
  const usingOf = (x) => (x ? (x.current ? 'current' : 'previous') : null);   // statusOf の using と同じ形
  const rt = managedRuntimeIssue();
  return { ...s, using: { whisper: usingOf(c.whisper), sum: usingOf(c.sum) }, whisperReady: Boolean(c.whisper), sumReady: Boolean(c.sum),
    checking: managedChecking(), runtime: rt ? { level: rt.level, message: rt.message } : null };
}

// 係の状態が変わったとき。実際に取っている間だけ眠らせない（Q14）。起動のときの自動の開始が大きな新しい版を取らなかったら、起動の中で1回だけ知らせる
let updateNoticeSent = false;
function onEngineFetchState(s) {
  updatePowerBlock();
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
  const groups = ['whisper', 'sum'].filter((g) => cands && cands[g] && !(checked && checked[g]) && !manualGroup(engOf(g)));
  if (!groups.length || !ENGINE_HOME.supported) return [];
  const repair = repairIdsOf(MANIFEST, cands, checked && checked.bad, groups);
  const consent = engineInstall.readInstalled(engineInstall.layout(ENGINE_HOME.root, MANIFEST).installed).consent === true;
  const go = consent && repair.length > 0;
  noticeMainWin(`${groups.map((g) => MANAGED_NAMES[g]).join('と')}のファイルが消えたか変わっていました。ウイルス対策が消した可能性があります（Windows セキュリティ → ウイルスと脅威の防止 → 保護の履歴）。`
    + (go ? '取り直しています。' : '設定タブの［エンジンを取り込む］から取り込み直してください。'));
  if (!go) return [];
  engineLog(`取り込んだエンジンの取り直しを頼みます: ${repair.join('、')}`);
  getEngineFetch().start({ repair });
  return repair;
}

// 片付け（cleanupOld）で消さないパス: 照らし終えた組と、記録から見た候補のフォルダ・ファイル（RF8）
function usedByManaged(p) {
  return pathUsedBy(p, [managed.whisper, managed.sum, managedCands.whisper, managedCands.sum]);
}
// 前の版の片付け（RF8）。両方のエンジンが止まっていて、起動の途中でもなく、暇なときだけ消す（Windows は動いている exe・DLL と、
// llama がメモリに写した gguf を消せない）。動いていれば何もせず、次の機会（60 秒ごとの releaseIdleEngines）に回す。投げない
function cleanupManaged() {
  if (!ENGINE_HOME.supported) return;
  const installed = engineInstall.readInstalled(engineInstall.layout(ENGINE_HOME.root, MANIFEST).installed);
  engineInstall.cleanupOld(ENGINE_HOME, MANIFEST, installed, { inUse: (p) => usedByManaged(p), canDelete: () => !whisperEng.proc && !whisperEng.startPromise && !sumEng.proc && !sumEng.startPromise && !isBusy() })
    .then((r) => { if (r.removed.length) engineLog(`取り込んだエンジンの前の版を片付けました: ${r.removed.join('、')}`); })
    .catch((e) => engineLog(`取り込んだエンジンの前の版を片付けられませんでした: ${e && e.message}`));
}

let managedApplying = false;   // 切り替えの照らしの途中（同時に 2 つ照らさない）
let managedAgain = false;      // 照らしている間にまた呼ばれた（組がそろうのが続いた）。終わってから、もう一度見る
// 取り込んだエンジンへの切り替えは、新しい組を照らし終え、手が空いていて記録中でないときだけ（#57 と同じ理由。区間を失わない）。
// 新しい組が照らしで合わなければ、照らし済みの前の組を使い続け（RF13。mainlib.keepPrevious）、合わなかった項目を取り直す（RF3）。
// 投げない（組がそろったときと、60 秒ごとの見回りから、待たずに呼ぶ）。起動のときの照らしの途中は、その結果を待つ（次の見回りで拾う）
async function applyManagedWhenIdle() {
  if (!ENGINE_HOME.supported || managedState.whisper === 'checking' || managedState.sum === 'checking') return false;
  if (managedApplying) { managedAgain = true; return false; }
  if (isBusy() || meeting) return false;
  managedApplying = true;
  try {
    const cands = engineInstall.managedCandidates(ENGINE_HOME, MANIFEST, engineInstall.readInstalled(engineInstall.layout(ENGINE_HOME.root, MANIFEST).installed), fs.statSync);
    if (sameShas(cands, managed)) return false;                       // 安い比べ（SHA-256 の並び）。同じなら何もしない
    // 照らして合わなかった組（壊れた組・前の組を使い続けている組）は、取り直されるか触られる（大きさか更新時刻が変わる）
    // まで照らし直さない（60 秒ごとに数十 MB を読まない・同じ知らせを繰り返さない）
    const stamps = managedStamps(cands);
    if (['whisper', 'sum'].every((g) => sameShas(cands, managed, [g]) || stamps[g] === managedTried[g])) return false;
    const checked = await engineInstall.verifyCandidates(cands);      // 照らす（数十 MB。待つ間に記録が始まりうる）
    if (isBusy() || meeting) return false;                            // 照らしている間に忙しくなったら替えない（次の機会に）
    managedTried = stamps;
    const v = keepPrevious(cands, managed, checked);
    const gotWhisper = !managed.whisper && v.whisper; const gotSum = !managed.sum && v.sum;
    managedCands = { whisper: v.kept.includes('whisper') ? v.whisper : cands.whisper, sum: v.kept.includes('sum') ? v.sum : cands.sum };
    managed = { whisper: v.whisper, sum: v.sum };
    for (const g of ['whisper', 'sum']) managedState[g] = managed[g] ? 'ok' : managedCands[g] ? 'broken' : 'none';
    if (checked.bad.length) engineLog(`取り込んだエンジンの照らし（切り替え）: 合わない ${checked.bad.map((b) => `${b.file}（${b.why}）`).join('、')}${v.kept.length ? `。前の組を使い続けます（${v.kept.join('・')}）` : ''}`);
    try {
      for (const g of ['whisper', 'sum']) if (v[g] && v[g].current) engineInstall.setActive(ENGINE_HOME, MANIFEST, g);
    } catch (e) { engineLog(`使っている組を installed.json に書けませんでした: ${e && (e.code || e.message)}`); }
    restartEnginesIfNeeded();
    updateTray();
    if (gotWhisper && !manualGroup(whisperEng)) {
      const more = !v.sum && !manualGroup(sumEng) && engineFetchRunning();
      sendToMainWin('app:notice', `文字起こしが使えるようになりました。${more ? '要約のエンジンは続けて取り込みます。' : ''}`);
      // 前にエンジンが無くて残した文字起こし待ちの音声を、今のエンジンで片付ける
      if (recoveryQueue) transcribeRecovered().catch((e) => engineLog(`復旧の文字起こしに失敗: ${logReason(e)}`));
    }
    if (gotSum && !manualGroup(sumEng)) sendToMainWin('app:notice', '要約のエンジンが使えるようになりました。記録済みの会議は［要約を生成］で要約できます。');
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
  const g = eng === whisperEng ? 'whisper' : 'sum';
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

// opts.isStale: やり直しの前に聞く。true なら（議事録の破棄・打ち切りの後）送り直さない。
// opts.learn: 議事録の区間のとき true。ヒントを止めるかの数え（promptEmptyStreak）に入れる
async function transcribeLocal(wavBuffer, extraPromptTail, durationMs, opts = {}) {
  const ok = await ensureEngineReady(whisperEng);
  if (!ok) throw new Error(whisperEng.lastError || '文字起こしエンジンが起動していません');
  // 処理時間は音声の長さにほぼ比例する。固定240秒だと、長くなった区間や
  // 長い音声入力が時間切れで丸ごと失われる（実機で9分の区間が消えた）。
  // 音声の5倍+60秒まで、上限30分で待つ。短い区間は今まで通り。下のやり直しも含めてこの時間の内。
  // トレードオフ: エンジンが応答しないままハングした場合、この時間まで
  // 待ち続ける（議事録は「破棄」で抜けられる）。喪失よりは待ちを選ぶ。
  const waitMs = Math.min(1800000, Math.max(240000, Math.round(durationMs || 0) * 5 + 60000));
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
      form.append('response_format', 'json');
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
        res = await fetch(`http://127.0.0.1:${settings.localPort}/inference`,
          { method: 'POST', body: makeForm(), signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now())) });
        break;
      } catch (e) {
        // 区間の失敗の文になる（議事録・音声入力・復旧）。英語の "fetch failed" をそのまま見せない
        const code = droppedCode(e);
        if (!code || resent) throw new Error(fetchErrorText(e));
        resent = true;
        // 記録の頭は「文字起こし:」にしない（認識ヒントのやり直しの行だけが使う。transcribe.e2e.test.js がその頭で見る）
        engineLog(`文字起こしの接続: エンジンとの接続が切れたため、同じ区間をもう一度送りました（${code}・音声 ${sec} 秒）`);
      }
    }
    touchEngine(whisperEng);
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json())?.error || ''; } catch (_) { /* noop */ }
      throw new Error(`文字起こしエンジンエラー (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    const data = await res.json();
    // 古い whisper-server（1.7.6・1.8.0）は WAV を読めないとき 200 のまま {"error": …} を返す。
    // 空の文として扱うと区間ごと黙って消えるので、失敗として残す（後で文字起こしし直せる）
    if (data?.error) throw new Error(`文字起こしエンジンエラー: ${data.error}`);
    text = cleanWhisperText(data?.text);
    if (text || !p) break;
  }
  // 空になった理由を後から追えるように残す（以前は何も書かず、engine.log からは何も分からなかった）
  if (retried) {
    engineLog(`文字起こし: 認識ヒント（${Buffer.byteLength(prompt, 'utf8')} バイト）付きでは空 → ヒントなしで${text ? ` ${text.length} 文字` : 'も空'}（音声 ${sec} 秒）`);
  }
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

// ---------------------------------------------------------------- オンラインの文字起こし（第1c回 OL1・OL2・OL4・OL6）
// 議事録の区間・音声入力・復旧の3か所は transcribeAuto を通す。経路は区間ごとに decideStt で決める
// （会議の印 → 同意 → 鍵 → 送り先に届くか。同意していない会議・PC の中だけの会議では、届くかの確かめも出さない: RF28）。
// クラウドの失敗のうち通信が切れたもの（切れた・時間切れ・届かない）だけ、その区間を手元でやり直す（RF27）。
// 429 は stt-cloud が retry-after だけ待つ（手元へ落とさない: RF29）。鍵の誤り・上限・受け付けないは区間の失敗として残し、
// WAV は今どおり残る（会議の後の送り直しの待ち行列へ）。記録には経路・送り先の名前・符号・秒数・区間の番号だけを書く（本文・鍵は書かない）。
// 記録の行の頭は「文字起こしの経路:」（「文字起こし:」は手元の認識ヒントのやり直しの行だけが使う。transcribe.e2e.test.js がその頭で見る）
const online = makeOnline({ request: (o) => electronNet.request(o), isOnline: () => electronNet.isOnline() });
// 鍵の保管。whenReady の後に作る（safeStorage の非同期の形は ready の後で用意される）
let secrets = null;
// 試験だけ: 429 の待ちを縮める（数で 0〜1 のときだけ効き、ほかは 1。実機の確かめの環境には置かない）
const STT_SLEEP_SCALE = (() => {
  const raw = String(process.env.NATSU_TEST_STT_SLEEP_SCALE || '').trim();
  const v = /^\d*\.?\d+$/.test(raw) ? Number(raw) : NaN;
  return v >= 0 && v <= 1 ? v : 1;
})();
// 知らせ（M1〜M8。計画「画面と知らせの文」）。{送り先} は送り先の表示の名前、{ホスト} はホストの名前だけ（鍵・URL の道は入れない）
const STT_NOTICE = {
  cloud: (p) => `この会議の音声は ${p.label} に送って文字起こしします。1on1・面談など外に出したくない会議は、議事録の画面の［この会議は PC の中だけ］を押してください。`,
  // 0.7.0 U-1（設計書 D5）: 同意の案内（consent-ask）は外した。鍵の欄は「オンライン」の［詳細設定（管理者用）］の奥（中継ができるまでの仮の欄）
  'no-key': (p) => `${p.label} の鍵が入っていないため、PC の中で文字起こししています。鍵は設定の「オンライン」の［詳細設定（管理者用）］で入れます。`,
  cert: (p) => `${p.label} につながりません（会社の通信の検査で証明書が差し替えられている可能性があります）。PC の中で文字起こしを続けます。続くときは情報システムに ${p.host} への通信の許可を頼んでください。`,
  unreachable: (p) => `${p.label} につながらないため、PC の中で文字起こしを続けます。`,
  wait: (p, sec) => `${p.label} の利用の上限に近いため、${sec} 秒待ってから送り直しています。`,
  rate: (p) => `${p.label} の利用の上限に達しました。文字起こしできなかった区間の音声は残してあり、議事録を閉じた後にもう一度試します。`,
  auth: (p) => `${p.label} の鍵が正しくないか、使えなくなっています。設定の「オンライン」の［詳細設定（管理者用）］で鍵を入れ直してください。`,
};
// 経路の理由 → 知らせの符号（M3〜M5）。オフライン・会議の印は知らせない（利用者が決めたこと・見て分かること）
const ROUTE_NOTICE = { 'no-key': 'no-key', cert: 'cert', proxy: 'unreachable', unreachable: 'unreachable' };
// 知らせを出した印。会議の中は meeting.notified（会議ごとに1回）、会議の外（音声入力・復旧）と M7・M8 は起動ごとに1回
const bootNotified = new Set();
// 同じ (scope, code) は1回だけ app:notice と engine.log（記録は符号だけ）→ 出したら true
function noticeOnce(scope, code, text) {
  const seen = scope && scope.notified instanceof Set ? scope.notified : bootNotified;
  if (seen.has(code)) return false;
  seen.add(code);
  engineLog(`文字起こしの経路: 知らせ ${code}`);
  noticeMainWin(text);
  return true;
}
const netOnline = () => { try { return electronNet.isOnline() !== false; } catch (_) { return true; } };
// 送り先（0.7.0 U-1・設計書 D5: OpenAI の gpt-4o-transcribe に固定）。前の版が保存した sttProvider・sttBaseUrl・sttModel は読まない
function sttProvider() {
  return sttCloud.fixedProvider();
}
// OpenAI の鍵がしまってあるか（復号しない: 会議の状態を聞くたびにキーリングの確かめを出さない）。ほかの送り先の鍵は数えない
function hasSttKey() {
  try { return Boolean(secrets) && secrets.has(sttProvider().id); } catch (_) { return false; }
}
let keyUnreadableLogged = false;
// 経路を決める（鍵も返す: transcribeAuto だけが使い、ほかへは渡さない）。
// opts.scope: 知らせの係（会議。無ければ起動ごと）、opts.quiet: 知らせを出さない、
// opts.probe: false なら送り先へ届くかを確かめず net.isOnline() だけで見る（先読みの判断。通信を出さない）
async function sttRoute(localOnly, { scope = null, quiet = false, probe = true } = {}) {
  const provider = sttProvider();
  let key = '';
  // ［この会議は PC の中だけ］なら鍵を復号もしない（送らないのにキーリングの確かめを出さない）
  if (!localOnly && secrets) {
    // 鍵があるかは、ファイルに暗号の文字があるか（secrets.has）でなく、実際に復号できたかで決める（RF30。
    // safeStorage の非同期の形は一時的に使えないことがあり、空の鍵で送ると 401 で「鍵が正しくない」と誤って知らせる）
    key = await secrets.get(provider.id);
    if (!key && secrets.has(provider.id)) {
      if (!keyUnreadableLogged) engineLog(`文字起こしの経路: ${provider.id} の鍵を復号できません（key-unreadable）。PC の中で文字起こしします`);
      keyUnreadableLogged = true;
    } else if (key) keyUnreadableLogged = false;
  }
  const up = probe ? () => online.isUp(provider.reachUrl)
    : async () => (netOnline() ? { up: true, why: 'ok' } : { up: false, why: 'offline' });
  const d = await decideStt({ localOnly: Boolean(localOnly), hasKey: key !== '', up });
  if (!quiet && ROUTE_NOTICE[d.why]) {
    const code = ROUTE_NOTICE[d.why];
    noticeOnce(scope, code, STT_NOTICE[code](provider));
  }
  return { route: d.route, why: d.why, provider, key: d.route === 'cloud' ? key : '' };
}
// → { route, why, provider }（鍵は返さない）
async function chooseSttRoute(localOnly, opts = {}) {
  const { route, why, provider } = await sttRoute(localOnly, opts);
  return { route, why, provider };
}
// クラウドの失敗（通信が切れた以外）→ 区間の失敗の文の Error。鍵の誤り（M8）・上限（M7）は起動ごとに1回知らせる。
// keepForRetry: 文字起こしまで届いていない（鍵・上限）。送り直しでは WAV と待ち行列を消さずに残す
function cloudFailure(e, provider) {
  const code = (e && e.code) || 'unknown';
  if (code === 'auth') noticeOnce(null, 'auth', STT_NOTICE.auth(provider));
  if (code === 'rate' || code === 'rate-long') noticeOnce(null, 'rate', STT_NOTICE.rate(provider));
  engineLog(`文字起こしの経路: ${provider.id} で失敗（${code}${e && e.status ? ` ${e.status}` : ''}）`);
  const err = new Error(sttCloud.cloudErrorText(e, provider.label));
  err.cloudCode = code;
  err.keepForRetry = code === 'auth' || code === 'rate' || code === 'rate-long';
  return err;
}
// opts: transcribeLocal と同じ（isStale・learn）＋ localOnly・notice（会議の知らせの係。無ければ起動ごと）・what（記録の名前）
// → { text, route: 'cloud'|'local', provider }。手元のエンジンが用意できないときの Error は engineMissing を持つ
async function transcribeAuto(wav, tail, durationMs, opts = {}) {
  const scope = opts.notice || null;
  const what = opts.what || '音声入力';
  const d = await sttRoute(Boolean(opts.localOnly), { scope });
  const provider = d.provider;
  let why = d.why;
  if (d.route === 'cloud') {
    const t0 = Date.now();
    try {
      const raw = await sttCloud.transcribeCloud(wav, {
        request: (o) => electronNet.request(o), provider, key: d.key, language: settings.language, prompt: buildPrompt(tail),
        sleep: (ms) => sleepMs(ms * STT_SLEEP_SCALE),
        onWait: (sec) => {
          engineLog(`文字起こしの経路: ${provider.id} が 429。${sec} 秒待つ`);
          noticeOnce(scope, 'wait', STT_NOTICE.wait(provider, sec));
        },
        onPromptDropped: () => engineLog(`文字起こしの経路: ${provider.id} が認識ヒント付きの要求を断ったため、ヒントを外して送り直しました`),
      });
      engineLog(`文字起こしの経路: ${what} → cloud(${provider.id}) ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
      return { text: cleanWhisperText(raw), route: 'cloud', provider };
    } catch (e) {
      if (!sttCloud.isOfflineError(e)) throw cloudFailure(e, provider);
      // 通信が切れた: この区間だけ手元でやり直す。届いた結果の覚えを捨て、次の区間は届くかを確かめ直す（戻っていればクラウドへ）
      online.forget(provider.reachUrl);
      why = e.code;
      if (ROUTE_NOTICE[why]) noticeOnce(scope, ROUTE_NOTICE[why], STT_NOTICE[ROUTE_NOTICE[why]](provider));
    }
  }
  engineLog(`文字起こしの経路: ${what} → local（理由: ${why}）`);
  if (!(await ensureEngineReady(whisperEng))) {
    const err = new Error(whisperEng.lastError || '文字起こしエンジンが起動していません');
    err.engineMissing = true;
    throw err;
  }
  const text = await transcribeLocal(wav, tail, durationMs, opts);
  return { text, route: 'local', provider };
}
// 復旧の前: q.localOnly でなく、クラウドで処理できるなら true（エンジンを起こさない。知らせは出さない）
async function recoveryCloudReady(q) {
  if (!q || q.localOnly) return false;
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
function setMeetingLocalOnly(on) {
  if (!meeting) return { ok: false };
  meeting.localOnly = Boolean(on);
  engineLog(`文字起こしの経路: この会議は PC の中だけ: ${meeting.localOnly ? 'on' : 'off'}`);
  writeDraft();
  return { ok: true, localOnly: meeting.localOnly };
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
// 会議の始めに経路を1回聞き、クラウドなら M1（トレイの知らせと画面）。同意前（M2）・鍵が無い（M3）・届かない（M4・M5）は sttRoute が出す
function announceSttRoute(m) {
  sttRoute(Boolean(m.localOnly), { scope: m }).then((r) => {
    // 確かめの返事（最大 3 秒）を待つ間に［PC の中だけ］が押された・会議が終わったなら、送ると知らせない
    if (r.route !== 'cloud' || m.localOnly || meeting !== m) return;
    const text = STT_NOTICE.cloud(r.provider);
    if (!noticeOnce(m, 'cloud', text)) return;
    try { if (tray && typeof tray.displayBalloon === 'function') tray.displayBalloon({ title: APP_TITLE, content: text }); } catch (_) { /* Windows の外には無い */ }
  }).catch((e) => engineLog(`文字起こしの経路: 会議の始めの経路を決められません: ${logReason(e)}`));
}
// fetch の失敗を、利用者に見せる一文にする（英語の "fetch failed" や時間切れの文をそのまま出さない）
function fetchErrorText(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return '時間内に返事がありませんでした';
  const code = e && e.cause && e.cause.code;
  if (e && (/fetch failed/i.test(e.message || '') || /^E(CONNREFUSED|CONNRESET|PIPE)$/.test(code || ''))) return 'エンジンにつながりませんでした';
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
    const res = await fetch(`http://127.0.0.1:${settings.localPort}/inference`,
      { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    let data = null;
    try { data = await res.json(); } catch (_) { /* 下で扱う */ }
    if (!res.ok) return `文字起こしを試せませんでした（${res.status}${data?.error ? `: ${data.error}` : ''}）`;
    if (!data || typeof data !== 'object') return '文字起こしエンジンの返事を読めませんでした';
    if (data.error) return `文字起こしを試せませんでした: ${data.error}`;
    return '';
  } catch (e) {
    return `文字起こしを試せませんでした: ${fetchErrorText(e)}`;
  } finally {
    touchEngine(whisperEng);
  }
}
// whisper の文から、無音・音楽などの印を外して 1 行にする
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
// 進み具合の文（「Claude Code で議事録を作成中…」）は doRunSummary が出す。onProgress は手元の道（generateMinutes）と同じ形のために受ける
// （claude -p は1回で返し、途中の段が無い）
async function summarizeWithClaude(plain, memo, type, onProgress) {
  const failWith = (r) => {
    // 符号と、-p の返事の副型・状態の番号だけ（claudeCli.runWhy。返事の文と本文は書かない: 第1b回の続き Lane F-a）
    engineLog(`要約: Claude Code → ${claudeCli.runWhy(r)}`);
    throw new Error(claudeCli.claudeMessage(r));
  };
  const found = claudeCli.findClaude({ configured: settings.claudeExe });
  if (!found.ok) failWith(found);
  let cwd;
  try { cwd = claudeRunDir(); } catch (e) { engineLog(`要約: Claude Code の作業フォルダを作れません: ${logReason(e)}`); failWith({ code: 'failed' }); }
  const auth = await claudeCli.claudeAuthStatus({ cmd: found.cmd, spawn, cwd });
  if (!auth.ok) failWith(auth);
  const memoText = String(memo || '').trim().slice(0, MEMO_MAX);
  const input = lib.buildClaudeInput({ memoText, plain, template: minutesTemplate(type) });
  const r = await claudeCli.claudeSummarize({ cmd: found.cmd, spawn, cwd, input, systemPrompt: MINUTES_SYS });
  if (!r.ok) failWith(r);
  engineLog('要約: Claude Code → ok');
  return { md: r.text, truncatedParts: [], finalTruncated: false };
}

// ---------------------------------------------------------------- 要約
async function llmChat(messages, maxTokens, onWait) {
  // 503 は「壊れた」ではなく「まだ準備中・手が塞がっている」。
  // すぐ諦めるとモデル読み込みの数十秒を待てずにエラーで返してしまう。
  // 待っていることは画面に出す。黙って待つと固まったように見え、
  // エラーで返すと壊れたように見える。どちらも実態と違う。
  let res;
  let waited = false;
  const deadline = Date.now() + 120000;
  touchEngine(sumEng);
  for (;;) {
    res = await fetch(`http://127.0.0.1:${settings.sumPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, temperature: 0.2, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(900000),
    });
    touchEngine(sumEng);
    if (res.status !== 503 || Date.now() >= deadline) break;
    if (!waited && onWait) {
      waited = true;
      onWait('要約エンジンを準備しています（モデルの読み込み中）。そのままお待ちください…');
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (res.status === 503) {
    throw new Error('要約エンジンがまだ準備中です。モデルの読み込みに時間がかかっています。'
      + '1〜2分おいてから、もう一度「要約を生成」を押してください。');
  }
  if (!res.ok) throw new Error(`要約エンジンエラー (${res.status})`);
  const data = await res.json();
  { const sp = speedLine('llama', data && data.timings); if (sp) engineLog(sp); }   // 実際の速さを残す（第0b回 Task 16）
  const text = data?.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('要約エンジンの応答が空でした');
  // 長さ上限で打ち切られると末尾の議題が黙って欠ける。
  // 黙って欠けるより、欠けたと分かる方がよい。
  const truncated = data?.choices?.[0]?.finish_reason === 'length';
  return { text, truncated };
}

// 節ごとに「なければ特になし」と書くと、小型モデルが条件を守り切れず
// 実項目と「特になし」を両方並べてくる。ルールは全体で1回だけ言う。
// （それでも混ざるので minutes.js の dropRedundantEmpty で後始末する）
// 装飾を禁じるのは見た目のためではない。「**」が残ると出典の一致が
// 薄まり、短い要点でリンクが消えるため。
const OUTPUT_RULE = '書き方のきまり:\n'
  + '- 該当する内容が本当に一つも無い見出しにだけ「特になし」と書く。'
  + '一つでも書くことがあれば「特になし」は書かない。\n'
  + '- 太字（**）や斜体などの装飾は使わない。素の文章で書く。\n'
  + '- 文体は報告文書として使える常体で書く。「です」「ます」は使わない。\n'
  // 3Bクラスは指示より例をまねる。会話体の文字起こしに引きずられて
  // 「です・ます」で書いてくるので、良い例と悪い例を1組だけ見せる。
  + '  良い例: 「結合テストは今週で完了。不具合22件のうち20件は修正済み。残り2件は来週対応。」\n'
  + '  悪い例: 「完了しました」「修正されました」「お願いします」「持ち越します」';

// プロンプトに入れる議事録の書式（見出しの雛形 + 書き方のきまり）。
// 要約後にテンプレートの写しを落とす（dropTemplateEcho）ときも同じ文字列を
// 渡す。別々に組み立てると、片方を直したときにずれて落とし損ねる。
function minutesTemplate(type) {
  return `${mtype.getFormat(type)}\n\n${OUTPUT_RULE}`;
}

// 文脈長のうち入力（プロンプト）に使える推定トークン（#41）: 文脈長 − 出力の上限 − 余白。
// 推定は mainlib.estimateTokens（UTF-8 バイト ÷ 2.5。多めに見積もる）
const sumCtxBudget = () => settings.sumCtx - SUM_MAX_TOKENS - SUM_CTX_MARGIN;

async function generateMinutes(plain, memo, onProgress, type) {
  const ok = await ensureEngineReady(sumEng);
  if (!ok) throw new Error(sumEng.lastError || '要約エンジンが起動していません');
  const llmChatP = (messages, maxTokens) => llmChat(messages, maxTokens, onProgress);
  const sys = MINUTES_SYS;
  // メモはユーザーが好きなだけ書けるうえ、そのままプロンプトに前置きされる。
  // 長すぎると文脈を食い潰して文字起こし側が押し出されるので上限を設ける。
  const memoText = String(memo || '').trim().slice(0, MEMO_MAX);
  const memoBlock = memoText ? `【会議メモ・アジェンダ（要約のヒント）】\n${memoText}\n\n` : '';

  const CHUNK = 5500;
  // 文脈長の予算（#41）。固定分（役割・メモ・書式）は先に引いておく
  const budget = sumCtxBudget();
  const fixed = estimateTokens(sys + memoBlock + minutesTemplate(type));
  // メモの分も含めて1回で収まるかを判断する。文字数のほか推定トークンでも見る
  // （文脈長を小さくした設定で、1 回分のプロンプトが溢れないように）
  if (plain.length + memoBlock.length <= CHUNK + 1500 && estimateTokens(plain) + fixed <= budget) {
    const one = await llmChatP([
      { role: 'system', content: sys },
      { role: 'user', content: `${memoBlock}【会議の文字起こし】\n${plain}\n\n上記から、次の構成のMarkdown議事録を作成してください。見出しはこの通りに使い、本文だけを出力してください。\n\n${minutesTemplate(type)}` },
    ], SUM_MAX_TOKENS);
    return { md: one.text, truncated: one.truncated, truncatedParts: [], finalTruncated: one.truncated };
  }

  const chunks = [];
  for (let i = 0; i < plain.length; i += CHUNK) {
    // 残りが重なり幅以下なら、直前のチャンクに完全に含まれるので作らない
    if (i > 0 && plain.length - i <= 200) break;
    chunks.push(plain.slice(i, i + CHUNK + 200));
  }
  const notes = [];
  const truncatedParts = [];   // 半分にしても上限で切れたパート番号（1 始まり）
  // 要点の抽出。kind は材料の呼び名（'文字起こし' | '要点メモ'）。文字起こしの分割要約と、
  // 文脈長に収まらないときの要点メモの畳み（下）が同じ経路を通る
  const extract = async (text, i, n, kind) => {
    const r = await llmChatP([
      { role: 'system', content: sys },
      { role: 'user', content: `以下は長い会議の${kind}の一部（${i + 1}/${n}）です。重要な発言・決定・依頼・課題・数字を漏らさず、簡潔な箇条書きで抽出してください。文体は常体（だ・である調、体言止め）。\n\n${text}` },
    ], NOTE_MAX_TOKENS);
    return r;
  };
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(`要約中… (${i + 1}/${chunks.length})`);
    // 上限で切れたら半分に割って両方をやり直す（一度だけ。mainlib.extractNotes）。
    // 切れたままだと中盤の議題が黙って欠ける（#16）。それでも切れたら本文は残し、
    // 要点メモに注記を添え、パート番号を控える（summaryError で名指しする）。
    const part = await extractNotes((t) => extract(t, i, chunks.length, '文字起こし'), chunks[i]);
    let text = part.text;
    if (part.truncated) {
      truncatedParts.push(i + 1);
      text += `\n（※パート${i + 1}の抽出は途中で切れています）`;
    }
    notes.push(`--- パート${i + 1} ---\n${text}`);
  }
  // 統合プロンプトが文脈長に収まらないなら、要点メモを 2 段で畳む（#41）。前から順に予算に
  // 収まる束に分け（mainlib.foldNotes）、各束を分割要約と同じ経路（extractNotes・NOTE_MAX_TOKENS）
  // でもう一段要約してから統合する。畳んだことは engineLog にだけ残す（page.notes や
  // summaryError には書かない。要約の中身の問題ではなく容量の話で、利用者が直すものではない）。
  // 束の予算は統合と同じ budget − fixed（束の要約は出力が短く指示文も短いので、余裕がある側）
  let material = notes;
  const need = estimateTokens(notes.join('\n\n')) + fixed;
  if (need > budget) {
    const bundles = foldNotes(notes, Math.max(1, budget - fixed), estimateTokens);
    engineLog(`要約: 要点メモ ${notes.length} パート（推定 ${need} トークン）が文脈長 ${settings.sumCtx} の予算 ${budget} を超えるため、${bundles.length} 束に畳んだ`);
    material = [];
    let first = 1;
    for (let k = 0; k < bundles.length; k++) {
      const last = first + bundles[k].length - 1;
      if (onProgress) onProgress(`要点メモをまとめ直しています… (${k + 1}/${bundles.length})`);
      const part = await extractNotes((t) => extract(t, k, bundles.length, '要点メモ'), bundles[k].join('\n\n'));
      let text = part.text;
      if (part.truncated) {
        engineLog(`要約: 束 ${k + 1}（パート${first}〜${last}）のまとめ直しが長さの上限で切れた`);
        text += `\n（※パート${first}〜${last}のまとめは途中で切れています）`;
      }
      material.push(`--- パート${first}〜${last}（まとめ） ---\n${text}`);
      first = last + 1;
    }
    const after = estimateTokens(material.join('\n\n')) + fixed;
    if (after > budget) engineLog(`要約: 畳んでも推定 ${after} トークンで予算 ${budget} を超える（2 段まで。続行する）`);
  }
  if (onProgress) onProgress('議事録をまとめています…');
  const final = await llmChatP([
    { role: 'system', content: sys },
    { role: 'user', content: `${memoBlock}【会議の要点メモ（時系列）】\n${material.join('\n\n')}\n\n上記の要点メモを統合し、次の構成のMarkdown議事録を作成してください。見出しはこの通りに使い、本文だけを出力してください。\n\n${minutesTemplate(type)}` },
  ], SUM_MAX_TOKENS);
  return { md: final.text, truncated: truncatedParts.length > 0 || final.truncated, truncatedParts, finalTruncated: final.truncated };
}

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
  const confirm = closeConfirm(state === 'meeting' || state === 'meeting-finalizing', isSummarizing());
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
  return { ...page, routeText: lib.routeLabel(page.route, preset ? preset.label : '') };
}
function sendToOverlay(ch, p) { if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(ch, p); }

function createOverlay() {
  overlayWin = new BrowserWindow({
    width: 316, height: 72,
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
  // 利用者が動かした位置は、設定の書き手のまとめ書きにする（第1a回 JS7。最後の位置だけを間隔の後に1回書く。
  // 残りは書き出しの合図で必ず書く: JS8）。位置を決めて動かした（positionOverlay）ときの move は数えない
  overlayWin.on('move', () => {
    if (programmaticMove || !overlayWin || overlayWin.isDestroyed() || !overlayWin.isVisible()) return;
    const [x, y] = overlayWin.getPosition();
    settings.pillCustom = { x, y };
    settingsWriter.set(settings);
  });
}

function positionOverlay() {
  if (!overlayWin) return;
  const [w, h] = overlayWin.getSize();
  let px; let py;
  const c = settings.pillCustom;
  if (c && Number.isFinite(c.x) && Number.isFinite(c.y)) {
    const d = screen.getDisplayNearestPoint({ x: c.x, y: c.y }).workArea;
    px = Math.min(Math.max(c.x, d.x), d.x + d.width - w);
    py = Math.min(Math.max(c.y, d.y), d.y + d.height - h);
  } else {
    const { x, y, width, height } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const mgn = 12;
    const pos = settings.pillPos || 'bottom';
    px = pos.includes('left') ? x + mgn : pos.includes('right') ? x + width - w - mgn : x + (width - w) / 2;
    py = pos.includes('top') ? y + mgn : pos.includes('bottom') ? y + height - h - mgn : y + (height - h) / 2;
  }
  programmaticMove = true;
  overlayWin.setPosition(Math.round(px), Math.round(py));
  setTimeout(() => { programmaticMove = false; }, 80);
}

// 窓（題名の帯・タスクバー）のアイコン。Windows では ICO を渡す。ICO なら OS が画面に合う大きさを選び、
// 16px・24px では線を太くした小さい版（assets/icon-small.svg から描いたもの）が出る。
// PNG（256px）を渡すと、それを縮めて使うので、16px で箱の上の波がほとんど見えなくなる。
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
  // 隠す・閉じるの前に、まとめ書きの残りを書き出す（第1a回 JS8。トレイ常駐で隠したまま電源を切られることがある）
  mainWin.on('hide', flushAllWriters);
  // 閉じるボタンの挙動。既定はそのまま終了。設定でトレイ常駐に切り替えられる。
  mainWin.on('close', (e) => {
    flushAllWriters();
    if (quitting) return;
    if (settings.stayInTray) { e.preventDefault(); mainWin.hide(); return; }
    // 記録中・要約中の閉じ間違いで会議や要約を失わせない（文は mainlib.closeConfirm）。
    // draft からの復旧はあるが要約前の状態に戻るので、一度は確認を挟む。
    const confirm = closeConfirm(state === 'meeting' || state === 'meeting-finalizing', isSummarizing());
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
  if (state !== 'idle') return;
  const problem = whisperProblem();
  if (problem) {
    createMainWindow();
    sendToMainWin('app:notice', problem);
    return;
  }
  warmWhisper().catch((e) => engineLog(`文字起こしエンジンの先読みに失敗: ${logReason(e)}`));
  state = 'recording';
  // いま前にある窓が貼り付け先。オーバーレイを出す前に控える（#54）
  dictationFg = askPaster('fg', FG_REPLY_MS).then((r) => (r && r.kind === 'hwnd' ? r.value : ''));
  positionOverlay();
  overlayWin.showInactive();
  sendToOverlay('overlay:start', { mode: 'dictation', micId: settings.micId || '', sound: Boolean(settings.soundFeedback) });
  globalShortcut.register('Escape', cancelRecording);
  updateTray();
}
function stopRecording() {
  if (state !== 'recording') return;
  state = 'processing';
  globalShortcut.unregister('Escape');
  sendToOverlay('overlay:stop', {});
  updateTray();
}
function cancelRecording() {
  if (state !== 'recording') return;
  state = 'idle';
  globalShortcut.unregister('Escape');
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
  if (state === 'recording') globalShortcut.unregister('Escape');
  state = 'processing'; updateTray();
  if (durationMs < MIN_RECORD_MS || buffer.byteLength < 1000) { finishWithError('録音が短すぎます'); return; }
  sendToOverlay('overlay:phase', { phase: 'processing', message: '文字起こし中…' });
  try {
    const t0 = Date.now();
    const { text: raw } = await transcribeAuto(buffer, '', durationMs);
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
  } catch (e) { finishWithError(e.message || '不明なエラー'); }
}

function finishWithError(message) {
  // 録音中に確保した Escape を必ず手放す。ここを抜かすと、以後アプリ以外の
  // 場所でも Escape が効かなくなる（録音中だけの横取りのはずが残り続ける）。
  if (state === 'recording') globalShortcut.unregister('Escape');
  state = 'idle'; updateTray();
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
  sendToMainWin('meeting:update', meetingStatus());
}

// 文字起こしが追いつかないとき（待ちが 3 区間を超える）は区間を倍に伸ばして送る回数を
// 減らし、追いついたら（待ち 1 以下）設定の長さに戻す（判断は mainlib.nextSegmentMs。#42）。
// 変わったときだけオーバーレイへ送る（次の区切りから効く）
function applyBackpressure(m, delta) {
  const base = (settings.segmentSec || 75) * 1000;
  const next = nextSegmentMs(pendingSegs, m.segmentMs || base, base, delta);
  if (next === m.segmentMs) return;
  m.segmentMs = next;
  sendToOverlay('overlay:segment-ms', next);
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
    // 第1c回 C-3（RF28）: ［この会議は PC の中だけ］の印と、いまクラウドで文字起こしする PC か（0.7.0 U-1 から: OpenAI の鍵がしまってある）。
    // 画面は cloud のときだけ［この会議は PC の中だけ］を出し、押した後（localOnly）は戻すボタンを出さない
    localOnly: Boolean(meeting && meeting.localOnly),
    cloud: hasSttKey(),
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
      startedAt: meeting.startedAt, memo: meeting.memo,
      segments: meeting.segments, offsetMs: meeting.offsetMs, savedAt: Date.now(),
      localOnly: Boolean(meeting.localOnly),   // ［この会議は PC の中だけ］（復旧した会議の送り直しも手元。第1c回 RF28）
      pauses: meeting.pauses || [],   // 止めていた時間の印（落ちて復旧したページにも残す。第1b回 N4c）
    }, meeting.draftName, { fsync: DRAFT_FSYNC });
  } catch (e) {
    if (!meeting.draftWriteFailed) {
      meeting.draftWriteFailed = true;
      engineLog(`下書き（${meeting.draftName}）を保存できませんでした（${errCode(e)}）。録音は続けます`);
    }
  }
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
    J.writeJsonFile(path.join(q.dir, RECOVERY_FILE), { pageId: q.pageId, items: q.items, retry: Boolean(q.retry), localOnly: Boolean(q.localOnly) }, { onFsyncUnsupported: noteFsyncOnce });
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
function loadSavedRecoveryQueue() {
  let names = [];
  try { names = fs.readdirSync(segbufRoot()); } catch (_) { return null; }
  let unreadable = false;
  let found = null;
  for (const name of names) {
    const dir = path.join(segbufRoot(), name);
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
    if (j.pageId && items.length) { found = { pageId: j.pageId, items, dir, retry: Boolean(j.retry), localOnly: Boolean(j.localOnly) }; break; }
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
// 控えは下書きのファイルを全部見る（draft.json・脇へ退けた draft.pending-<時刻>.json・会議ごとの draft-<開始時刻>.json）。
// ページは await db.call('meeting.recover') で作る（第2a1回 ST1。中身は議事録の DB のプロセス）。投げない（下書きごとに受け止める）
async function recoverDraftIfAny() {
  let unreadable = false;
  let recovered = 0;
  for (const name of store.draftFiles()) {
    if (meeting && name === meeting.draftName) continue;   // 今の会議の控えは復旧しない
    const r = store.readDraftFile(name);
    if (r.state === 'unreadable') { unreadable = true; engineLog(`下書き（${name}）を読めませんでした（${r.code}）。消さずに残します`); continue; }
    if (r.state !== 'ok') continue;   // 無い・壊れている（store が退けて知らせた。N15）
    const d = r.value;
    if (!Array.isArray(d.segments) || d.segments.length === 0) { store.clearDraft(name); continue; }
    try {
      const dt = new Date(d.startedAt || Date.now());
      // 文字起こしが終わっていなかった区間（pending）は失敗扱いでページに載せ、wav が残っていれば
      // あとで文字起こしして差し替える（mainlib.recoverSegments）。先にページを作るのは、
      // エンジンの起動を待たずに復旧した本文を開けるようにするため
      const rec = recoverSegments(d.segments, (f) => fs.existsSync(f));
      // 要約の欄の文（summaryError）も同じ1回の頼みで入れる（今の「作ってから保存し直す」と同じ中身）
      const { page } = await db.call('meeting.recover', { pageId: store.newId('p'), segments: rec.segments, page: {
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
        summaryError: rec.todo.length
          ? '録音が中断されたため要約は未生成です。残っていた音声の文字起こしを続けています。終わったら「要約を生成」で作成できます。'
          : '録音が中断されたため要約は未生成です。「要約を生成」で作成できます。',
      } });
      store.clearDraft(name);
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
}

// 復旧ページの「文字起こし待ち」を、起動が済んでエンジンが用意できてから順に文字起こしし、
// segment.update（recite: false。区間だけを直す）で本文を差し替える（failed が外れて要約の材料に戻る）。
// 失敗した区間は失敗の文を残す。ページが消されていたら残りの wav を捨てて止める。
// 済んだ wav は消し、空になった退避フォルダも消す。
// 「ページが消された」と決めるのは、保存の側がページの読み（page.get）に null と答えたときだけ。読めなかった（投げた）ときは何も消さずに
// 止め、待ち行列を残して次の機会（設定の保存・次の起動）に回す（エンジンが無いときと同じ扱い。第2a1回 F12）
let recoveryRunning = false;
async function transcribeRecovered() {
  if (recoveryRunning) return;
  let q = recoveryQueue;
  if (!q) return;
  recoveryRunning = true;
  updateTray();   // 復旧中は「手が塞がっている」（isBusy）。トレイの有効／無効を追随させる
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
      // クラウドで処理できるなら手元のエンジンを起こさない（q.localOnly の待ち行列は今どおりエンジンを待つ。第1c回）
      const ready = (await recoveryCloudReady(q)) || await ensureEngineReady(whisperEng);
      if (!ready) {
        // エンジンが未設定・未起動のときは何も消さない。wav と待ち行列（recovery.json）を残し、
        // 設定を直したとき（settings:save）や次の起動でもう一度ここへ来る
        engineLog(`復旧の文字起こしを保留: ${whisperEng.lastError || 'エンジンが起動していません'}`);
        retryUnsavedRecovery();
        return;
      }
      recoveryQueue = null;
      const kept = await transcribeRecoveredItems(q);
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
    recoveryRunning = false;
    updateTray();
  }
}
// → null（済んだ）| 残した待ち行列（文字起こしまで届かなかった区間から先。WAV と recovery.json を消していない）
async function transcribeRecoveredItems(q) {
  let done = 0;
  for (let i = 0; i < q.items.length; i++) {
    const item = q.items[i];
    let alive = null;
    try {
      alive = await db.call('page.get', { id: q.pageId });
    } catch (e) {
      // 読めなかった: 「消された」にしない。この区間から先の音声と待ち行列を残して止める（F12）
      const rest = q.items.slice(i).filter((it) => it && it.wav && fs.existsSync(it.wav));
      engineLog(`復旧の文字起こしを止めました（理由: ${errCode(e)}）。残りの ${rest.length} 区間の音声と待ち行列は残します`);
      return { ...q, items: rest };
    }
    if (!alive) { unlinkQuiet(item.wav); continue; }   // ページが消された（DB が null と答えた）
    let text = null;
    let err = '';
    let route = 'local';
    if (!err) {
      try {
        ({ text, route } = await transcribeAuto(fs.readFileSync(item.wav), '', item.durationMs, { localOnly: Boolean(q.localOnly), what: `復旧 ${item.id}` }));
        if (settings.removeFillers) text = removeFillersRule(text);
      } catch (e) {
        if (e && (e.keepForRetry || e.engineMissing)) {
          const rest = q.items.slice(i).filter((it) => it && it.wav && fs.existsSync(it.wav));
          engineLog(`復旧の文字起こしを止めました（理由: ${e.cloudCode || 'engine'}）。残りの ${rest.length} 区間の音声と待ち行列は残します`);
          return { ...q, items: rest };
        }
        err = e.message;
      }
    }
    // 経路ごとの数え直し（ページの route.stt。第1c回 OL6）
    if (!err) await saveIfExists(db, q.pageId, (p) => { if (p.route && p.route.stt) p.route.stt[route] = (Number(p.route.stt[route]) || 0) + 1; });
    if (err) {
      // 失敗の文を残す（segment.update は failed を外してしまうので、失敗の印を付ける命令で書く）
      await db.call('segment.fail', { pageId: q.pageId, segId: item.id, text: `（この区間の認識に失敗: ${err}）` });
    } else if (text) {
      await db.call('segment.update', { pageId: q.pageId, segId: item.id, patch: { text }, recite: false });
      done++;
    } else {
      await db.call('segment.remove', { pageId: q.pageId, segId: item.id });   // 無音: 区間ごと消す（記録中と同じ扱い）
      done++;
    }
    // 推論まで到達した wav は成否にかかわらず消す（同じ音声を何度も失敗させても意味が無い）
    unlinkQuiet(item.wav);
  }
  try { fs.unlinkSync(path.join(q.dir, RECOVERY_FILE)); } catch (_) { /* noop */ }
  removeDirIfEmpty(q.dir);
  const cur = await db.call('page.get', { id: q.pageId });
  if (!cur) return;
  // 「続けています」の文を通常の復旧の文に戻す（別の要約が書いていれば触らない）
  const latest = await saveIfExists(db, q.pageId, (p) => {
    if (String(p.summaryError || '').includes('文字起こしを続けています')) {
      p.summaryError = '録音が中断されたため要約は未生成です。「要約を生成」で作成できます。';
    }
  });
  sendToMainWin('pages:updated', await db.call('pages.list', {}));
  const now = await db.call('page.get', { id: q.pageId });
  sendToMainWin('page:updated', { page: latest || cur.page, segments: now ? now.segments : cur.segments });
  sendToMainWin('app:notice', q.retry
    ? `認識に失敗していた区間の文字起こしをやり直しました（${done}/${q.items.length} 区間）。「要約を生成」で議事録を作り直せます。`
    : `中断されていた文字起こしの復旧が終わりました（${done}/${q.items.length} 区間）。「要約を生成」で議事録を作成できます。`);
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

async function startMeeting() {
  if (state !== 'idle') return { ok: false, error: '他の処理を実行中です' };
  const problem = whisperProblem();
  if (problem) return { ok: false, error: problem };
  // 前の起動で読めなかった控えが残っていれば、始める前に1回だけ復旧を試す（第1a回 JS9）。復旧のページは
  // db.call で作るので待つ（待たずに進むと、復旧中の draft.json を下の chooseDraftName が脇へ退け、消しそこねて2つ目のページになる）。
  // 待つ間に別の処理が始まっていたら始めない（第2a1回 ST1）
  if (store.draftFiles().length) {
    await recoverDraftIfAny();
    if (state !== 'idle') return { ok: false, error: '他の処理を実行中です' };
  }
  const startedAt = Date.now();
  // 古い draft.json が残っていれば脇へ退けてから draft.json に、退けられなければ draft-<開始時刻>.json に書く
  const draftName = chooseDraftName({ existing: store.draftFiles(), startedAt, park: () => store.parkDraft() });
  if (draftName !== 'draft.json') engineLog(`前の下書きを退けられないので、この会議の下書きは ${draftName} に書きます`);
  meeting = { startedAt, draftName, memo: '', segments: [], offsetMs: 0, stopping: false, seq: 0,
    systemAudio: false, paused: false, pausedMs: 0, pausedAt: 0,
    // gen: 打ち切り（meeting:skipPending）で進める世代。進行中の結果を捨てる判断に使う
    // segmentMs: いま録音側に頼んでいる区間の長さ（背圧で伸縮する）
    // inFlightSince: 文字起こし中の区間の開始時刻（残り時間の見積もりで経過分を引く）
    // finalSeen: 録音側の最後の区間が届いたか。skipAll: 打ち切り後に届く区間も文字起こしせず数だけ残す
    // emptySegs: 文字起こしが空で除いた区間の数（全部が空なら、締めるときに知らせる）
    gen: 0, skipped: 0, micFallback: false, segmentMs: (settings.segmentSec || 75) * 1000, inFlightSince: 0,
    finalSeen: false, skipAll: false, emptySegs: 0,
    // 第1b回 A-3: pauses は再開した一時停止の印、pauseAsked は録音バーに頼んで返事を待つ間、pauseWhy は今の一時停止の理由、
    // suspendAsked はスリープで頼んだ、hintOnPause は復帰の頼み直しの返事で再開を促す、resumeHint は再開を促している
    pauses: [], pauseAsked: false, pauseAskTimer: null, pauseWhy: '', suspendAsked: false, hintOnPause: false, resumeHint: false,
    // 第1c回: localOnly は［この会議は PC の中だけ］、route は経路ごとの文字起こしできた区間の数、notified は会議ごとの知らせの印
    localOnly: false, route: { cloud: 0, local: 0 }, notified: new Set() };
  segChain = Promise.resolve(); pendingSegs = 0;
  state = 'meeting';
  writeDraft();
  warmWhisper().catch((e) => engineLog(`文字起こしエンジンの先読みに失敗: ${logReason(e)}`));
  // 経路を1回聞き、クラウドなら会議の始めの知らせ（M1）
  announceSttRoute(meeting);
  // 要約エンジンはここで先読みしない（#58）。記録開始で起動すると約 2〜3GB が上がり、破棄しても
  // 降りない（記録だけして要約しない会議でも掴んだまま）。要約直前の ensureEngineReady(sumEng)
  // （generateMinutes）に任せる。その分、最初の要約はモデル読み込みの待ちを含む
  positionOverlay();
  overlayWin.showInactive();
  // 音声入力の開始（上の 'dictation'）には systemAudio を渡さない。
  // あちらは常にマイクだけで、今回の変更で挙動が変わってはいけない。
  const payload = {
    mode: 'meeting', segmentSec: settings.segmentSec || 75,
    micId: settings.micId || '', sound: Boolean(settings.soundFeedback),
    systemAudio: Boolean(settings.useSystemAudio),
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
  updateTray();
  sendToMainWin('meeting:update', meetingStatus());
  return { ok: true };
}

function stopMeeting() {
  if (state !== 'meeting') return { ok: false };
  state = 'meeting-finalizing';
  meeting.stopping = true;
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
  sendToOverlay('overlay:stop', {});
  sendToOverlay('overlay:phase', { phase: 'processing', message: '議事録を作成中…' });
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
  cleanupSegbuf(m);
  meeting = null; store.clearDraft(m.draftName);
  segChain = Promise.resolve(); pendingSegs = 0;
  state = 'idle'; updateTray();
  sendToMainWin('meeting:update', meetingStatus());
  runDraftRetryAfterMeeting();
  return { ok: true };
}

async function toggleMeetingByHotkey() {
  if (state === 'idle') {
    const r = await startMeeting();
    createMainWindow();
    if (!r.ok) sendToMainWin('app:notice', r.error || '議事録を開始できません');
  } else if (state === 'meeting') stopMeeting();
}

function onMeetingSegment(buffer, durationMs, isFinal) {
  if (!meeting) return;
  // 文字起こしは録音より遅れて終わる。その間に議事録が破棄されて次の記録が
  // 始まっていることがあるので、この区間が属する議事録を捕まえておき、
  // 「今も同じ議事録か」で判断する。単なる null 判定だと、破棄した議事録の
  // 発言が次の議事録に紛れ込む。
  const m = meeting;
  const segOffset = m.offsetMs;
  m.offsetMs += durationMs;
  if (isFinal) m.finalSeen = true;
  // 打ち切り（meeting:skipPending）の後に届いた区間（録音側で変換中だった最後の区間）は
  // 文字起こしせず「打ち切り」として残す。黙って捨てると残り件数にも出ず、痕跡が無くなる
  if (m.skipAll) {
    if (buffer.byteLength >= 4000) {
      m.segments.push({ id: `s${++m.seq}`, atMs: segOffset, durationMs, text: '（文字起こしを打ち切り）', failed: true });
      m.skipped++;
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
    seg.wav = spoolSegment(segbufDir(m.startedAt), m.seq, buffer);
    m.segments.push(seg);
    writeDraft();
  }
  // 打ち切り（meeting:skipPending）で世代が進んだら、進行中・待ち行列の結果は捨てる
  const gen = m.gen;
  pendingSegs++;
  applyBackpressure(m, 1);
  sendToMainWin('meeting:update', meetingStatus());
  segChain = segChain.then(async () => {
    if (meeting !== m || m.gen !== gen || !seg) return;
    // 直近の「成功した」区間の末尾。失敗区間のエラー文を渡すと、次の区間が
    // それを文例として真似る（mainlib.promptTail。待ちの区間は飛ばす）。
    const tail = promptTail(m.segments);
    const t0 = Date.now();
    m.inFlightSince = t0;
    let text = '';
    let route = 'local';
    try {
      ({ text, route } = await transcribeAuto(buffer, tail, durationMs, { isStale: () => meeting !== m || m.gen !== gen, learn: true, localOnly: m.localOnly, notice: m, what: `区間 ${seg.id}` }));
    } catch (e) {
      if (meeting !== m || m.gen !== gen) return;
      m.inFlightSince = 0;
      settleSegment(m, seg, { text: `（この区間の認識に失敗: ${e.message}）`, failed: true });
      return;
    }
    if (meeting !== m || m.gen !== gen) return;
    m.inFlightSince = 0;
    m.route[route] += 1;   // 経路ごとの、文字起こしできた区間の数（ページの route.stt。第1c回 OL6）
    eta.record(Date.now() - t0, durationMs, route);   // 成功した区間だけで、経路ごとに学習（失敗は時間の目安にならない。クラウドの速さを手元の見積もりに混ぜない）
    m.etaRoute = route;
    if (route === 'local') { const sp = speedLine('whisper', { audioMs: durationMs, procMs: Date.now() - t0 }); if (sp) engineLog(sp); }   // 実際の速さを残す（第0b回 Task 16）
    if (settings.removeFillers) text = removeFillersRule(text);
    // 空・直前と同じ（繰り返しハルシネーション）は区間ごと消す
    const done = m.segments.filter((s) => !s.pending);
    const prev = done.length ? done[done.length - 1].text : '';
    if (!text || (prev && text.length > 6 && prev === text)) {
      if (!text) m.emptySegs++;
      engineLog(`区間 ${seg.id}（音声 ${Math.round(durationMs / 1000)} 秒）: ${text ? '直前と同じ文のため' : '文字起こしが空のため'}除きました`);
      settleSegment(m, seg, null);
      return;
    }
    settleSegment(m, seg, { text });
  }).catch(() => {}).finally(() => {
    // 破棄済みの議事録の区間は、破棄時に数え直した件数を減らさない
    if (meeting === m) { pendingSegs = Math.max(0, pendingSegs - 1); applyBackpressure(m, -1); }
    sendToMainWin('meeting:update', meetingStatus());
    if (meeting === m && (isFinal || (m.stopping && pendingSegs === 0))) {
      maybeFinalizeMeeting().catch((e) => engineLog(`finalize failed: ${e.message}`));
    }
  });
}

async function maybeFinalizeMeeting() {
  if (!meeting || !meeting.stopping || pendingSegs > 0) return;
  if (state !== 'meeting-finalizing') return;
  // 打ち切りで待ち件数を 0 にしても、録音側が変換中の最後の区間はこれから届く。
  // 先に締めると、その区間は議事録の無いところへ届いて消える（打ち切りの数にも入らない）
  if (meeting.skipAll && !meeting.finalSeen) return;
  const m = meeting;
  meeting = null;

  // 一時停止していた時間は会議の長さに含めない。基準は停止時刻であって
  // 「今」ではない（今で計ると文字起こし待ちが混ざる。mainlib.meetingDurationSec）。
  const endAt = m.stoppedAt || Date.now();
  const durationSec = meetingDurationSec(m, endAt);
  const dt = new Date(m.startedAt);
  const fallbackTitle = `${dt.getFullYear()}/${dt.getMonth() + 1}/${dt.getDate()} ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')} の議事録`;

  let page = null;
  try {
    // 議事録を締める（第2a1回 ST1: await db.call。中身は議事録の DB のプロセス。ページの ID はここで作る。下書きに書くのは M-3）。
    // 「書けた」と返ってから下書きを消す。締めの tx は会議の開始時刻（送り直しても1回だけ効く）
    page = await db.call('meeting.finalize', {
      pageId: store.newId('p'),
      segments: settledSegments(m.segments),   // 待ちの区間（本文なし）と wav のパスは載せない
      page: {
        title: fallbackTitle,
        date: localDateISO(dt),   // ローカルの暦日（#51）
        durationSec, memo: m.memo, blocks: [],
        createdAt: dt.toISOString(),
        // 文字起こしの経路と、会議の印（要約の経路が見る: C10）
        route: { stt: { ...m.route, provider: sttProvider().id }, localOnly: Boolean(m.localOnly) },
        pauses: m.pauses,   // 止めていた時間の印（区間とは別の欄。第1b回 N4c・F6）
      },
    }, { tx: `meeting:${m.startedAt}` });
    store.clearDraft(m.draftName);
    // 認識に失敗した区間の wav は残してある（settleSegment）。復旧と同じ待ち行列に載せ、
    // 要約のあとでもう一度文字起こしする。途中で落ちても recovery.json から次の起動で続く
    const retry = m.segments.filter((s) => s.failed && s.wav && fs.existsSync(s.wav))
      .map((s) => ({ id: s.id, wav: s.wav, durationMs: Number(s.durationMs) || 0 }));
    if (retry.length) {
      const q = { pageId: page.id, items: retry, dir: segbufDir(m.startedAt), retry: true, localOnly: Boolean(m.localOnly) };
      saveRecoveryQueue(q);
      if (!recoveryQueue) recoveryQueue = q;   // 別の復旧が待っていれば、その後に拾う（transcribeRecovered）
    }
    removeDirIfEmpty(segbufDir(m.startedAt));   // 全区間が片付いていれば空
  } catch (e) {
    // 保存に失敗しても draft.json は消さない（次回起動時に復旧できる）
    engineLog(`議事録の保存に失敗: ${logReason(e)}`);
    sendToOverlay('overlay:phase', { phase: 'error', message: '議事録を保存できませんでした' });
    sendToMainWin('app:notice', `議事録を保存できませんでした: ${e.message}\n次回起動時に復旧を試みます。`);
  } finally {
    // 何があっても録音状態は解除する。ここを抜けると画面が「作成中…」で止まる。
    state = 'idle'; updateTray();
    setTimeout(hideOverlayIfIdle, 2000);
    sendToMainWin('meeting:update', meetingStatus());
    // 録音中に来た控えの復旧のやり直しを、ここで回す（第1a回 JS9）
    runDraftRetryAfterMeeting();
  }
  if (!page) return;

  sendToOverlay('overlay:phase', { phase: 'done', message: '議事録を保存しました' });
  sendToMainWin('pages:updated', await db.call('pages.list', {}));
  sendToMainWin('page:open', page.id);
  // 音声は届いたのに、文字起こしが全部空だった。黙っていると「0 区間」の理由が分からない。
  // 通知は数秒で消えるので、要約の欄（summaryError）にも同じ文を残す（下の runSummary の後）
  const allEmpty = m.emptySegs > 0 && !settledSegments(m.segments).length;
  const allEmptyText = `${m.emptySegs} 区間の音声を受け取りましたが、文字起こしの結果がすべて空でした。`
    + '設定の「使用するマイク」が話している人の声を拾うマイクになっているか確かめてください。'
    + '続くときは、理由の記録を見てください。理由の記録: %APPDATA%\\natsu\\engine.log';
  if (allEmpty) {
    engineLog(`議事録を保存: 文字起こしが空の区間が ${m.emptySegs}、文字の残った区間は 0`);
    sendToMainWin('app:notice', allEmptyText);
  }

  await runSummary(page.id);
  if (allEmpty) {
    const saved = await saveIfExists(db, page.id, (p) => { p.summaryError = allEmptyText; });
    const now = saved ? await db.call('page.get', { id: page.id }) : null;
    if (saved) sendToMainWin('page:updated', { page: saved, segments: now ? now.segments : [] });
  }
  if (recoveryQueue) transcribeRecovered().catch((e) => engineLog(`retry failed: ${logReason(e)}`));
}

// 同じページの要約は同時に一つだけ（mainlib.makeSummaryRunner。main.test.js で
// 実行して固定）。走行中に「要約を生成」を連打されると、同じ文字起こしに対して
// 要約が二重に走り、後から終わった方が前の結果（とその間の編集）を上書きしていた。
// 走行中なら同じ Promise を返す。
const runSummary = makeSummaryRunner(doRunSummary, () => updateTray());
// 要約の書き戻しが続けてぶつかったときの知らせ（第2a1回 F6。mainlib.saveIfExists が conflict を投げた）
const SUMMARY_CONFLICT_TEXT = '要約を保存できませんでした。もう一度［要約を生成］を押してください。';
// 要約が走っている間はアプリを「忙しい」として扱う（#52）: 省電力を止めない・終了前に
// 確かめる・更新と再起動を拒む。件数は mainlib.makeSummaryRunner が持つ。
const isSummarizing = () => runSummary.running().length > 0;
// 「手が塞がっている」: 記録・文字起こし・要約・復旧の文字起こしのどれかが動いている。
// 使われないエンジンの停止（#58）はこれが false のときだけ
const isBusy = () => state !== 'idle' || isSummarizing() || recoveryRunning || pendingSegs > 0;

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
  // 書き戻しが何度もぶつかった（その間ずっと画面で直されていた。第2a1回 F6）。「削除された」にせず、要約を保存できなかったと知らせる
  const conflicted = () => {
    engineLog('要約の書き戻しが続けてぶつかったため保存できませんでした');
    clearUi();
    sendToMainWin('app:notice', SUMMARY_CONFLICT_TEXT);
    return { ok: false, error: SUMMARY_CONFLICT_TEXT };
  };
  const opened = await db.call('page.get', { id: pageId });
  if (!opened) { clearUi(); return { ok: false, error: 'ページが見つかりません' }; }
  const { page } = opened;
  let segments = opened.segments;   // 出典付与の直前に読み直して差し替える（下記）
  const segmentsAtStart = segments;   // 要約の材料にした配列。出典付けで今の配列と突き合わせる（#4）
  const usable = segments.filter((s) => !s.failed && !s.pending);
  const plain = usable.map((s) => s.text).join('\n');

  if (!plain.trim()) {
    const err = '文字起こしが空のため要約できません';
    let saved;
    try { saved = await saveIfExists(db, pageId, (p) => { p.summaryError = err; }); } catch (e) { if (e && e.code === 'conflict') return conflicted(); throw e; }
    if (!saved) return gone();
    clearUi();
    sendToMainWin('page:updated', { page: saved, segments });
    return { ok: false, error: err };
  }
  // 要約の経路を1回決める（第1c回 OL5・D1）。［この会議は PC の中だけ］のページは届くかを確かめずに手元（C10。
  // 文字起こしの文も PC の外へ出さない）。届けば利用者の Claude Code、届かなければ今までどおり手元の llama
  const localOnly = Boolean(page.route && page.route.localOnly);
  const route = (await decideSummary({ localOnly, up: () => online.isUp(ANTHROPIC_REACH) })).route;
  if (route === 'local' && !engineValid(sumEng)) {
    // 取り込める PC で手の設定が無い側は［エンジンを取り込む］を指す（第0b回）。まだ取り込んでいなければ「未設定」の語を残す
    // （画面はこの語で設定タブへ連れて行く）。取り込んだ組を確かめ中・壊れた・ランタイムで止めたときは、その理由を伝える。
    // 確かめ中・取り直し中は待てば使えるようになるので、終わってからすることを1つ書いて終える
    const fetchable = ENGINE_HOME.supported && !manualGroup(sumEng);
    const waitable = managedState.sum === 'checking' || managedState.sum === 'broken';
    const err = !fetchable
      ? '要約エンジンが未設定のため、文字起こしのみ保存しました。'
        + 'setup-summarizer.ps1 を実行し、設定タブでパスを指定すると「要約を生成」で作成できます。'
      : managedState.sum === 'none'
        ? '要約エンジンが未設定のため、文字起こしのみ保存しました。設定タブの［エンジンを取り込む］で取り込むと「要約を生成」で作成できます。'
        : `要約エンジンを使えないため、文字起こしのみ保存しました。${engineCheck(sumEng)}${waitable ? '。終わったら「要約を生成」で作成できます。' : ''}`;
    let saved;
    try { saved = await saveIfExists(db, pageId, (p) => { p.summaryError = err; }); } catch (e) { if (e && e.code === 'conflict') return conflicted(); throw e; }
    if (!saved) return gone();
    clearUi();
    sendToMainWin('page:updated', { page: saved, segments });
    sendToMainWin('app:notice', err);
    return { ok: false, error: err };
  }

  // 会議タイプ: 手動指定があればそれを尊重し、無ければタイトルと冒頭から推定。
  // 自動判定は手動指定があっても必ず走らせ、結果を別に残す。こうしないと
  // 「自動判定が当たっていたか」を後から誰も確かめられない
  // （手で選んだ議事録では detectType が一度も呼ばれていなかった）。
  const autoType = mtype.detectType(page.title, plain.slice(0, 1200));
  page.autoType = autoType;
  if (!page.meetingType || page.typeAuto !== false) {
    // 判定材料が無いときは「一般・その他」（自動判定の答えのまま）。0.1.1 までは「定例・進捗報告」に
    // していたが、定例の型（担当・案件ごとの報告、担当・期限つきのアクション）に合わせようとして、
    // 手元の小さいモデルが発言に無い担当と期限を作った（実機。一般・その他で作り直すと出なかった）。
    // タイトルに定例らしい言葉（朝会・定例・週次など）があれば（本文だけなら 5 語以上）、今までどおり自動で定例になる
    page.meetingType = autoType;
    page.typeAuto = true;
  }
  // タイトルは書かない。1on1・面談の議事録は機微で、engine.log は
  // 不具合報告に添付されうる。
  engineLog(`会議タイプ: 採用=${page.meetingType} 自動判定=${autoType}`
    + ` 手動=${page.typeAuto === false} 区間数=${usable.length}`);

  const progress = (msg) => sendToMainWin('meeting:progress', { message: msg });
  progress(route === 'claude-code'
    ? `Claude Code で議事録を作成中…（${mtype.getLabel(page.meetingType)}として要約します）`
    : `要約エンジンで議事録を作成中…（${mtype.getLabel(page.meetingType)}として要約します）`);
  try {
    // オンラインで Claude Code が失敗したら、理由を要約の欄に書いて終える（下の catch。手元の llama へは行かない: D1）
    const { md, truncatedParts, finalTruncated } = route === 'claude-code'
      ? await summarizeWithClaude(plain, page.memo, page.meetingType, progress)
      : await generateMinutes(plain, page.memo, progress, page.meetingType);
    // 「特になし」の混入を先に落とす。ここで落とさないと
    // 「- [ ] 特になし」がアクション1件として数えられてしまう。
    // 続けて、テンプレートの見出し・雛形をそのまま写した行も落とす。
    const blocks = dropTemplateEcho(dropRedundantEmpty(markdownToBlocks(md)), minutesTemplate(page.meetingType));
    // 担当・期限を先に抜く。出典の突き合わせは
    // 「（担当: ○○ / 期限: ○○）」を落とした本文に対して行いたい。
    // 書式が残ったままだと、その語がクエリに混ざって一致がぶれる。
    enrichActionBlocks(blocks, new Date(page.createdAt));
    // 文字起こしとメモに出てこない担当・期限は外す（推測で埋めない。モデルが指示に反して書くことがある）。
    // engine.log には数だけを書く（名前は機微。engine.log は不具合報告に添付されうる）
    // メモのうち、要約タイプを選んだときに入るアジェンダの雛形の行は裏付けにしない（「次回までのアクション」で
    // 作り話の「期限: 次回」が通ってしまう）。mainlib.memoEvidence
    const grounded = groundActionFields(blocks, `${plain}\n${memoEvidence(page.memo, mtype.listTypes())}`);
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

    // 同じ理由で、タイトルやメモも読み込み時のページを丸ごと書き戻さず、
    // 生成物だけを最新のページに載せる。ページが消えていれば生成物は捨てる。
    const latest = await saveIfExists(db, pageId, (saved) => {
      saved.blocks = blocks;
      // 要約の途中で種類を手で選び直されていたら、その選択を残す（上書きすると、選んだ種類が黙って戻る。
      // mainlib.mergeSummaryType）。この要約は始めたときの種類で作ったものなので、そう書き添える
      const t = mergeSummaryType(saved, page);
      saved.meetingType = t.meetingType;
      saved.typeAuto = t.typeAuto;
      saved.autoType = page.autoType;
      saved.citeStat = stat;
      saved.actionStat = actStat;
      // 切れたパートと最終統合の打ち切りを名指しする（mainlib.truncationMessage。無ければ ''）
      const notes = [truncationMessage(truncatedParts, finalTruncated)];
      if (t.changed) {
        notes.push(`この要約は「${mtype.getLabel(page.meetingType)}」として作りました。途中で選んだ「${mtype.getLabel(t.meetingType)}」で作り直すには［要約を再生成］を押してください。`);
      }
      saved.summaryError = notes.filter(Boolean).join('\n');
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
    if (e && e.code === 'conflict') return conflicted();   // 書き戻しが5回ぶつかった: 要約の欄にも書けないので知らせるだけ
    let latest;
    try { latest = await saveIfExists(db, pageId, (saved) => { saved.summaryError = e.message; }); } catch (e2) { if (e2 && e2.code === 'conflict') return conflicted(); throw e2; }
    if (!latest) return gone();
    clearUi();
    sendToMainWin('page:updated', { page: latest, segments });
    return { ok: false, error: e.message };
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
  if (isSummarizing()) {   // 確認の間に要約が始まっていることがある（#52）
    dialog.showMessageBox({ title: APP_TITLE, type: 'info', message: '要約を作成中です', detail: '終わってから更新してください' });
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
  quitting = true;
  stopEngine(whisperEng); stopEngine(sumEng); stopPaster();
  // 議事録の DB を閉じてから（cleanShutdown を書いてチェックポイント。第2a1回 ST7）
  await db.close({ timeoutMs: DB_CLOSE_MS });
  relaunchAndExit();
}

function updateTray() {
  updatePowerBlock();
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
    items.push({ label: '議事録の記録を開始', enabled: state === 'idle', click: () => { startMeeting().catch((e) => engineLog(`議事録を開始できません: ${errCode(e)}`)); createMainWindow(); } });
  }
  items.push({ type: 'separator' });
  items.push({ label: 'ノートを開く', click: createMainWindow });
  // 更新はトレイからも行えるようにする。画面側の組み立てが1か所でも
  // つまずくと、設定タブの「更新を確認」ボタンごと動かなくなり、
  // アプリ内更新で直すこともできなくなる（実機で起きた）。
  // 復旧の手段が、壊れうるものに依存していてはいけない。
  items.push({ label: '更新を確認', enabled: state === 'idle' && !isSummarizing(), click: checkUpdateFromTray });
  // エンジンを手で止めてメモリを解放する（#58）。どちらかが起動していて、手が空いているときだけ
  items.push({ label: 'エンジンを停止（メモリを解放）', enabled: (Boolean(whisperEng.proc) || Boolean(sumEng.proc)) && !isBusy(), click: stopEnginesFromTray });
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
    const prevPillPos = settings.pillPos;
    // 決まりのあるキーだけを受け取り（許可の一覧 pickSavable）、読み込みと同じ決まりで整える。知らないキーは
    // ファイルにあったものだけが残る（画面から新しく入れさせない）
    const merged = readSettings({ ...settings, ...pickSavable(next) }, DEFAULT_SETTINGS).settings;
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
    if (merged.pillPos !== prevPillPos) merged.pillCustom = null;
    settings = merged;
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
  ipcMain.handle('history:delete', (_e, id) => { history = history.filter((h) => h.id !== id); saveHistoryOrNotice(); return history; });
  ipcMain.handle('history:clear', () => { history = []; saveHistoryOrNotice(); return history; });
  ipcMain.handle('app:toggle-recording', () => { toggleRecording(); return state; });

  // 議事録の画面の口（第2a1回 ST1）。中身は await db.call（main の客。M-2b）。名前と答えの形は今のまま。画面が DB の口に移る（P-1）までの間だけで、M-3 で消す
  ipcMain.handle('pages:search', async (_e, q) => await db.call('pages.list', { q: q || '' }));
  ipcMain.handle('pages:searchFull', async (_e, q) => await db.call('pages.searchFull', { q: q || '', limit: 60 }));
  // アクション一覧（絞り込み込み）。答え { actions, people, total } をそのまま返す
  ipcMain.handle('pages:actionView', async (_e, { q, assignee } = {}) => await db.call('pages.actionView', { q, assignee }));
  // 経路の行（routeText）は保存の側が添える（第1c回 OL6。送り先の名前は labels）
  ipcMain.handle('page:get', async (_e, id) => await db.call('page.get', { id }));
  ipcMain.handle('page:delete', async (_e, id) => await db.call('page.delete', { id }));
  ipcMain.handle('page:setTitle', async (_e, { id, title }) => await db.call('page.setTitle', { id, title }));
  ipcMain.handle('page:setMemo', async (_e, { id, memo }) => await db.call('page.setMemo', { id, memo }));
  ipcMain.handle('block:update', async (_e, { pageId, blockId, patch }) => await db.call('block.update', { pageId, blockId, patch }));
  ipcMain.handle('block:insert', async (_e, { pageId, afterBlockId, type }) => await db.call('block.insert', { pageId, afterBlockId, type }));
  ipcMain.handle('block:remove', async (_e, { pageId, blockId }) => await db.call('block.remove', { pageId, blockId }));
  ipcMain.handle('block:move', async (_e, { pageId, blockId, toIndex }) => await db.call('block.move', { pageId, blockId, toIndex }));
  // 文字起こしの1区間を直す。その区間を根拠にしていた要点と根拠なしの要点だけ出典を引き直す（segment.update の既定 recite）。
  // page:updated は送らない。送ると画面が文字起こし面を全部描き直し、次の行の編集を壊す。
  // 戻り値（page:get と同じ形・経路の行つき）で画面側が要約タブの出典チップだけを描き直す。
  ipcMain.handle('segment:update', async (_e, { pageId, segId, patch }) => await db.call('segment.update', { pageId, segId, patch: patch || {} }));
  ipcMain.handle('block:setAction', async (_e, { pageId, blockId, assignee, dueRaw }) => await db.call('block.setAction', { pageId, blockId, assignee, dueRaw }));
  ipcMain.handle('page:summarize', (_e, id) => runSummary(id));
  // 手動指定は以後の自動推定より優先（typeAuto: false。DB の page.setType）
  ipcMain.handle('page:setType', async (_e, { id, type }) => await db.call('page.setType', { id, type }));
  ipcMain.handle('meta:types', () => mtype.listTypes());
  ipcMain.handle('meeting:toggle', () => {
    if (state === 'idle') return startMeeting();
    if (state === 'meeting') return stopMeeting();
    return { ok: false, error: '処理中です' };
  });
  ipcMain.handle('meeting:discard', () => discardMeeting());
  ipcMain.handle('meeting:status', () => meetingStatus());
  ipcMain.handle('meeting:set-memo', (_e, memo) => { if (meeting) { meeting.memo = String(memo || ''); writeDraft(); } return true; });
  // 終了後の文字起こし待ちを打ち切る（#42）。記録中（終了前）は打ち切れない。待ちの区間は
  // 「（文字起こしを打ち切り）」の失敗扱いでページに残し、wav は消す（mainlib.skipPendingSegments）。
  // 進行中・待ち行列の結果は世代（gen）で無効にし、待ち件数を 0 にして締める
  ipcMain.handle('meeting:skipPending', () => {
    if (!meeting || !meeting.stopping) return { ok: false, error: '記録を終了したあとにだけ打ち切れます' };
    const m = meeting;
    m.gen++;
    const r = skipPendingSegments(m.segments);
    for (const f of r.wavs) unlinkQuiet(f);
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
  ipcMain.handle('app:test-sum', async () => {
    forgetRuntimeIssues();   // ランタイムを入れた後の押し直しで読み直す（RF4）
    const warning = engineDirNote(sumEng);
    const problem = engineCheck(sumEng);
    if (problem) return { ok: false, error: problem, warning };
    const ok = await ensureEngineReady(sumEng);
    return ok ? { ok: true, info: '要約エンジンは起動済みです（オフライン動作可）', warning }
      : { ok: false, error: sumEng.lastError || '起動に失敗しました', warning };
  });
  // 設定の「エンジン：正常／要確認」。置き場所のファイルを見るだけで、エンジンは起動しない（要約は約 2〜3GB: #58）
  ipcMain.handle('engine:status', () => ({ ok: true, whisper: engineCheck(whisperEng), sum: engineCheck(sumEng),
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
  ipcMain.handle('app:version', () => ({ version: app.getVersion(), repo: updater.REPO }));
  ipcMain.handle('update:check', async () => {
    const r = await updater.check(app.getVersion(), app.getPath('userData'));
    // 画面側が「更新して再起動」を出すか「ダウンロード」を出すかの判断に使う（文とボタンは notice）
    return withNotice(r);
  });
  ipcMain.handle('update:apply', async (_e, url) => {
    if (isSummarizing()) return { ok: false, error: '要約を作成中です。終わってから更新してください' };
    const t = updateTarget();
    if (!t.ok) return { ok: false, error: t.error };
    return updater.apply(url, t.root, app.getPath('userData'),
      (msg) => sendToMainWin('update:progress', { message: msg }), { sha256: updateSha.get(String(url)) || '' });
  });
  ipcMain.handle('app:restart', async () => {
    if (isSummarizing()) return { ok: false, error: '要約を作成中です。終わってから再起動してください' };
    quitting = true;
    stopEngine(whisperEng); stopEngine(sumEng); stopPaster();
    // 議事録の DB を閉じてから（第2a1回 ST7）
    await db.close({ timeoutMs: DB_CLOSE_MS });
    relaunchAndExit();
    return true;
  });
  // ---- 設定のカード「オンライン」（第1c回 Task C-2。OL7・OL3・OL5・RF30）----
  // 鍵は画面から受け取って secrets にしまうだけで、画面へは返さない（返すのは「しまってあるか」だけ）。
  // 記録には送り先の名前と符号だけを書く（鍵・暗号の文字は書かない）。設定を開いただけでは外へ通信しない
  // （届くかは net.isOnline() だけで見る。外へ出るのは［鍵を確かめる］を押したときの送り先の /models だけ）
  const KEY_TEXT = {
    'bad-id': '送り先が正しくありません。',
    'bad-key': '鍵の形が正しくありません（空白や日本語を含まない 8〜512 文字）。',
    unavailable: 'この PC では鍵をしまえません（鍵を暗号にする仕組みが使えません）。',
    write: '鍵を書き込めませんでした（secrets.json に書けません）。',
    'no-key': '鍵が入っていません。',
    'key-unreadable': 'しまってある鍵を読めません。鍵を入れ直してください。',
    auth: '鍵が正しくないか、使えなくなっています。',
    'invalid-key': '鍵が正しくありません。',   // 第1b回の続き Lane F-e: 返事の符号が invalid_api_key
    rate: '利用の上限に達しています（鍵は使える可能性があります。少し待ってからもう一度確かめてください）。',
    server: '送り先が混み合っているか、止まっています。少し待ってからもう一度確かめてください。',
    'bad-request': '送り先が受け付けませんでした（URL を確かめてください）。',
    other: 'つながりませんでした（インターネットか、会社の通信の検査を確かめてください）。',
  };
  const keyText = (code) => KEY_TEXT[Object.prototype.hasOwnProperty.call(KEY_TEXT, code) ? code : 'other'];
  // 鍵の名前は OpenAI だけ（0.7.0 U-1・設計書 D5）。groq・custom の鍵は secrets.json に残っても、読まず・確かめず・消さない
  const keyProvider = (id) => (id === sttCloud.FIXED_PROVIDER_ID ? id : '');
  ipcMain.handle('cloud:status', async () => {
    const p = sttProvider();
    let canStore = false;
    try { canStore = Boolean(secrets) && await secrets.available(); } catch (_) { canStore = false; }
    // hasKey は暗号の文字があるかだけを見る（復号しない: 設定を開くたびにキーリングの確かめを出さない）。
    // 使えるかは［鍵を確かめる］が復号して送り先に聞く
    const hasKey = Boolean(secrets) && secrets.has(p.id);
    const up = netOnline();
    return { ok: true, provider: { id: p.id, label: p.label, host: p.host || '' },
      hasKey, canStore, online: { up, why: up ? 'ok' : 'offline' } };
  });
  ipcMain.handle('cloud:set-key', async (_e, provider, key) => {
    const id = keyProvider(provider);
    if (!id) return { ok: false, code: 'bad-id', message: keyText('bad-id') };
    if (!secrets) return { ok: false, code: 'unavailable', message: keyText('unavailable') };
    const r = await secrets.set(id, typeof key === 'string' ? key.trim() : '');
    if (r && r.ok) { engineLog(`文字起こしの経路: ${id} の鍵を保存しました`); return { ok: true }; }
    const code = (r && r.code) || 'write';
    engineLog(`文字起こしの経路: ${id} の鍵を保存できません（${code}）`);
    return { ok: false, code, message: keyText(code) };
  });
  ipcMain.handle('cloud:clear-key', async (_e, provider) => {
    const id = keyProvider(provider);
    if (!id) return { ok: false, code: 'bad-id', message: keyText('bad-id') };
    if (!secrets) return { ok: true };
    const r = secrets.remove(id);
    if (r && r.ok) { engineLog(`文字起こしの経路: ${id} の鍵を消しました`); return { ok: true }; }
    const code = (r && r.code) || 'write';
    return { ok: false, code, message: keyText(code) };
  });
  ipcMain.handle('cloud:test-key', async (_e, provider) => {
    const id = keyProvider(provider);
    if (!id) return { ok: false, code: 'bad-id', message: keyText('bad-id') };
    const p = sttProvider();
    const key = secrets ? await secrets.get(id) : '';
    if (!key) {
      const code = secrets && secrets.has(id) ? 'key-unreadable' : 'no-key';
      return { ok: false, code, message: `${p.label}: ${keyText(code)}` };
    }
    const r = await sttCloud.checkKey({ request: (o) => electronNet.request(o), provider: p, key });
    // 記録は符号だけ（返事の文は鍵の一部を含むことがあるので書かない）
    engineLog(`文字起こしの経路: ${id} の鍵の確かめ → ${r.ok ? (r.code === 'no-model-read' ? 'ok（no-model-read）' : 'ok') : r.code}`);
    // 第1b回の続き Lane F-e: モデルの一覧を読む権限だけが無い鍵（OpenAI の制限付きの鍵）は、小さな文字起こしが通れば使える
    if (r.ok && r.code === 'no-model-read') return { ok: true, code: r.code, message: `${p.label}: 鍵は使えます（モデルの一覧を読む権限はありません）` };
    if (r.ok) return { ok: true };
    const message = r.code === 'cert'
      ? `${p.label}: つながりません（会社の通信の検査で証明書が差し替えられている可能性があります）。続くときは情報システムに ${p.host} への通信の許可を頼んでください。`
      : r.code === 'quota' ? `${p.label}: 残高が足りません（${p.label} の Billing を確かめてください）。`
        : `${p.label}: ${keyText(r.code)}`;
    return { ok: false, code: r.code, message };
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
    return { sidebar: { ...winState.sidebar }, tabs: { open: winState.tabs.open.slice(), active: winState.tabs.active } };
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
    else if (state === 'meeting') stopMeeting();
  });
  ipcMain.on('overlay:cancel-request', () => { if (state === 'recording') cancelRecording(); });
  ipcMain.on('audio:done', (_e, { buffer, durationMs }) => handleDictationAudio(Buffer.from(buffer), durationMs));
  ipcMain.on('audio:segment', (_e, { buffer, durationMs, final }) => onMeetingSegment(Buffer.from(buffer), durationMs, Boolean(final)));
  // 録音側が実際に何を録れているかを受け取る。設定がオンでも、再生デバイスが
  // 無い・他のアプリが排他で掴んでいる等で失敗しうる。黙ってマイクだけで進むと、
  // 会議が終わってから片側しか残っていないことに気づく——それが一番まずい。
  // 一時停止の状態を受け取る。記録中バーにも出す（オーバーレイを
  // 隠したまま席を外すと、止めたつもりが録れている／その逆が起きる）。
  // 第1b回 A-3: 返事が来たら頼んだ印を下ろす。再開したら止めた所（会議の時計 offsetMs。録音バーは区間を送り終えてから再開を
  // 知らせる）と長さの印を1つ残す（録音バーの［一時停止］を直接押したときも why は user）
  ipcMain.on('overlay:pause', (_e, { paused }) => {
    if (!meeting) return;
    clearPauseAsk(meeting);
    if (paused && !meeting.paused) { meeting.paused = true; meeting.pausedAt = Date.now(); }
    else if (!paused && meeting.paused) {
      meeting.paused = false;
      meeting.pauses.push({ atMs: meeting.offsetMs, ms: Math.max(0, Date.now() - meeting.pausedAt), why: meeting.pauseWhy || 'user' });
      meeting.pausedMs += Date.now() - meeting.pausedAt;
      meeting.pauseWhy = '';
      meeting.resumeHint = false;
      meeting.hintOnPause = false;
      writeDraft();
    }
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
    sendToMainWin('meeting:update', meetingStatus());
    if (wanted && !systemAudio) {
      sendToMainWin('app:notice',
        'パソコンから出ている音を取り込めませんでした。マイクの音だけで議事録を記録します。');
    }
  });
  ipcMain.on('audio:error', (_e, { message }) => {
    if (state === 'meeting' || state === 'meeting-finalizing') {
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
}

// ---------------------------------------------------------------- 起動
// タスクバーのまとまりと通知の名前を、ショートカットと同じ APP_ID にする。呼ばないと app.name
// （小文字の natsu）から作られる。窓とトレイより先に呼ぶ。Windows だけの関数なので win32 のときだけ
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => createMainWindow());
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
    // 画面の覚え書き（第1b回 N6）。窓を作る前に読んで照らす（壊れていたら知らせ W1 を startupNotices に）
    loadWinState();
    // クラウドの文字起こしの鍵の保管（第1c回 OL3。ready の後に作る）
    secrets = makeSecrets({ file: path.join(app.getPath('userData'), 'secrets.json'), safeStorage, J, log: engineLog });
    // 取り込んだエンジンの候補を記録から読む（読むだけ。フォルダは作らない）。照らし終えるまで managed は空なので、
    // 取り込んだ側は下の起動の行では起動しない（RF3）。手で設定した側は今までどおり起動する
    managedCands = engineInstall.managedCandidates(ENGINE_HOME, MANIFEST, engineInstall.readInstalled(engineInstall.layout(ENGINE_HOME.root, MANIFEST).installed), fs.statSync);
    for (const g of ['whisper', 'sum']) if (managedCands[g]) managedState[g] = 'checking';
    await recoverDraftIfAny();   // 復旧のページは db.call で作る（投げない）。待ってから待ち行列と掃除を決める（復旧中のフォルダを消さない）
    if (!recoveryQueue) recoveryQueue = loadSavedRecoveryQueue();   // 前回エンジンが無くて残した分
    cleanOrphanSegbuf(recoveryQueue ? recoveryQueue.dir : '');   // 復旧の後で（復旧中のフォルダは残す）
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
    security.install({ app, session: session.defaultSession, pages: RENDERER_PAGES, log: engineLog });
    createOverlay();
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
    // 復旧ページに文字起こし待ちの音声が残っていれば、エンジンの用意を待って順に片付ける
    transcribeRecovered().catch((e) => engineLog(`復旧の文字起こしに失敗: ${logReason(e)}`));
    ensurePaster();
    createMainWindow();
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
    stopEngine(whisperEng); stopEngine(sumEng); stopPaster();
  });
  app.on('will-quit', () => { flushAllWriters(); globalShortcut.unregisterAll(); stopEngine(whisperEng); stopEngine(sumEng); stopPaster(); });
}

// 読み直し（retrySettingsRead）で本当の値に切り替えたときに当てる（第1a回 Task 2-3）。settings:save の当てる行と同じもの
// （あちらはそのまま残す）。ファイルの最後に置くのは、repo.test.js の起動のホットキーの確かめが、最初の
// resolveStartupHotkeys( の呼び出し（起動の所）から読むため（ここが先にあると、その確かめが起動の所を見なくなる）
function applyReloadedSettings(prev, next) {
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
