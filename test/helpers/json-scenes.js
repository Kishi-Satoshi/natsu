'use strict';
// json-scenes.js — 第1a回の保存の守りを、main.js を偽の Electron の上で動かして確かめる場面（helpers/mainrun.js の --json-scene=名前）
//   files:   userData からの相対パス → 中身（文字列か Buffer。関数なら { base, userData } を受け取る。base は mainrun が決めたエンジンのパスとポート）
//   faults:  helpers/faulty-fs.js の rules（main・store・jsonfile が読む fs にだけ効く）
//   dbDelayMs: main の db.call の答えを毎回この分（ミリ秒）だけ遅らせる（DB のプロセスの返事がさらに遅いとき。第2a1回 M-1）
//   engine:  真なら偽の文字起こしエンジンを設定に入れて起こす（既定は起こさない）
//            'lazy' なら起こせるが、act の前に起動の先読みを待たない（第1d回 A-3。ログインした PC は手元に落ちた区間で起こす）
//   relaySeed: 真なら mainrun の --relay の札の種をまく（第1d回 A-3。ログインした形から始める。settings.json に accountEmail も書く）
//   env:     main.js を読む前に入れる環境変数
//   prepare: userData を受け取り、置いた後に手を入れる（読み取り専用にする等）
//   act:     起動の後にすること（ctx は mainrun.js の頭の注釈）
//   local:   %LOCALAPPDATA%（mainrun の一時フォルダ）からの相対パス → 中身（第1b回 Task A-2。画面の覚え書き natsu/window-state.json）
//   displays: 偽の screen.getAllDisplays() の並び（無ければ 1920×1080 が1つ。作業領域は 1920×1040）
//   noDbWait: 真なら、場面は議事録の DB の用意を待たずに act を呼ぶ（第2a1回 M-2b。用意の前の動きを見る）
//   dbDown:  真なら mainrun の --db-down と同じ（議事録の DB のプロセスの SQLite が trigram を持たない: 自分の確かめが通らず、
//            DB は「使えない」で起きる。第2a1回 M-2b）
//   dialog:  偽の dialog.showMessageBox の答え方（第2a1回 M-4。無い = 1 番目の［移す］、'quit' = 2 番目、'hold' = ctx.answerDialog(i) まで答えない）
//   quitEmits: 真なら app.quit() が本物と同じく before-quit を出す（第2a1回 M-4）
//   overlayPause: 偽の録音バーの［一時停止］の答え方（第1b回 Task A-3。'lost-once' = 最初の頼みが届かない、'late' = 最初の返事を
//            ctx.releasePause() まで出さない。無ければすぐ返す）
const pretty = (o) => JSON.stringify(o, null, 2);   // 今の saveJson が書く形（main.js:219）
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const CP932_NIHONGO = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
// 今の利用者がふつうに持っている設定（30 のキー。localThreads は CPU の移し替えに当たらない 3）
const TYPICAL = {
  localServerExe: 'C:\\engine\\whisper-server.exe', localModelPath: 'C:\\engine\\ggml-model.bin', localPort: 8990, localThreads: 3,
  vadModelPath: '', useVad: true, suppressNst: true, sumServerExe: '', sumModelPath: '', sumPort: 8991, sumThreads: 3, language: 'ja',
  hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M', micId: 'mic-1', pillPos: 'top-right', pillCustom: { x: 40, y: 60 },
  autoPaste: true, removeFillers: true, soundFeedback: true, autoLaunch: false, theme: 'dark', stayInTray: false,
  dictionary: ['見積', '検収'], useBuiltinTerms: true, useSystemAudio: false, maxHistory: 300, segmentSec: 75, sumCtx: 32768, engineIdleMin: 10,
};
const HISTORY = [{ id: 'h1', text: '前の口述', raw: '前の口述', createdAt: '2026-10-01T00:00:00.000Z', durationSec: 3, procMs: 900, chars: 4 }];
// 画面（app.html の save）が送る 29 のキー
const UI = (o = {}) => { const u = { ...TYPICAL, ...o }; delete u.pillCustom; delete u.maxHistory; return u; };
// 第1a回 Task 2-5: 前の起動で落ちた会議の控え（文字起こし済みの区間 1 つ）
// recovery-write-later: 起動の間は recovery.json の一時ファイルを開けない（act の途中で times を 0 にして離す）
const RECOVERY_OPEN_FAIL = { op: 'open', match: /recovery\.json\.\d+-[0-9a-z]+\.tmp$/, code: 'EACCES', times: Infinity };
const OLD_DRAFT = { startedAt: 1760000000000, memo: '', offsetMs: 3000, savedAt: 1760000003000, segments: [{ id: 's1', atMs: 0, durationMs: 3000, text: '落ちた会議の発言です' }] };
// 第1b回 Task A-2: 画面の覚え書き（%LOCALAPPDATA%\natsu\window-state.json）。値は stage1b.main.test.js が見る
const WS = (o = {}) => JSON.stringify({ v: 1, bounds: { x: 100, y: 80, width: 1200, height: 800 }, maximized: false, zoom: 1, sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' }, ...o }, null, 2);
const WS_FILE = 'natsu/window-state.json';
// 第1a回の壊れたページ（p1）と、文字起こしだけ壊れたページ（p2）。page-files-broken が置き、元の中身のままかを見る
const BROKEN_PAGE_FILES = {
  'data/pages/p1.json': '{"id":"p1","title":"壊れ', 'data/transcripts/p1.json': '{"id":"p1","segments":[]}',
  'data/pages/p2.json': JSON.stringify({ id: 'p2', title: '文字起こしが壊れた会議', blocks: [], createdAt: '2026-10-01T00:00:00.000Z' }),
  'data/transcripts/p2.json': '{"id":"p2","segments":[{"text":"途中',
};
const wsText = (c) => { const b = c.readLocal(WS_FILE); return b ? b.toString('utf8') : null; };
// 0.7.0 U-1: 前の版が groq・custom の名前でしまった鍵（mainrun の偽の safeStorage の暗号 'ENC1:<hex>' の base64）
const fakeEncB64 = (k) => Buffer.from(`ENC1:${Buffer.from(k, 'utf8').toString('hex')}`).toString('base64');
// 第1d回 A-4（F11・K2）: mainrun の --old-keys が secrets.json に置く 0.7.0 までの鍵（平文。試験はこの文字がどこにも出ないことを探す）
const OLD_KEY_TEXT = { groq: 'gsk_old_groq_000000', openai: 'sk-old-openai-00000', custom: 'old_custom_0000000' };

// 第2a1回 M-4: 0.6.0 と同じ store.js（別の写し: main の store と状態を分ける）で、userData の data に議事録を置く。segs[i] はページ i の発言の数。
// 作ったページの ID の並びを返す
function oldPages(ud, segs) {
  const p = require.resolve('../../src/store');
  const saved = require.cache[p];
  delete require.cache[p];
  let st;
  try { st = require(p); } finally { if (saved) require.cache[p] = saved; else delete require.cache[p]; }
  st.init(ud);
  return segs.map((n, i) => st.createPage({
    title: `第${i + 1}回の定例会議（𠮷）`, date: `2026-09-${String(i + 1).padStart(2, '0')}`, durationSec: 600, memo: i % 2 ? '' : `メモ ${i + 1}`,
    blocks: [{ id: st.newId('b'), type: 'bullet', text: `決めたこと ${i + 1}`, cites: [] }],
    segments: Array.from({ length: n }, (_, k) => ({ id: `s${k + 1}`, atMs: k * 20000, durationMs: 20000, text: `第${i + 1}回の発言 ${k + 1}` })),
    createdAt: new Date(Date.UTC(2026, 8, 1 + i, 9)).toISOString(),
  }).id);
}
// 元の JSON（data/pages・data/transcripts・data/index.json）の 相対パス → SHA-256（名前と中身が1バイトも変わらないかを見る）
function jsonShas(ud) {
  const fs = require('node:fs');
  const path = require('node:path');
  const out = {};
  const sha = (f) => require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  for (const dir of ['pages', 'transcripts']) {
    let names = [];
    try { names = fs.readdirSync(path.join(ud, 'data', dir)); } catch (_) { names = []; }
    for (const n of names.sort()) out[`data/${dir}/${n}`] = sha(path.join(ud, 'data', dir, n));
  }
  try { out['data/index.json'] = sha(path.join(ud, 'data', 'index.json')); } catch (_) { /* 無ければ入れない */ }
  return out;
}
let shaBefore = null;   // 場面の prepare で取った元の JSON の SHA-256（同じプロセスの act が読む）

// 第1d回 Task A-3（RL11）: 中継で文字起こしする会議を1回（区間 n 個。1つ目 3 秒・ほか 2 秒）。afterFirst は1つ目の区間を送った後に呼ぶ。
// 締めて要約（エンジンの無い場面では、すぐ理由を書いて終わる）まで待ち、増えたページの { route, segments } と、その会議の間に main が
// 中継へ送った道の並び（calls）を返す
async function relayMeeting(c, n, { afterFirst } = {}) {
  const h = (ch, ...a) => c.handlers[ch]({}, ...a);
  const before = new Set(c.store.listPages().map((p) => p.id));
  const calls0 = c.relay.calls().length;
  await h('meeting:toggle');
  for (let i = 0; i < n; i++) {
    const last = i === n - 1;
    if (last) await h('meeting:toggle');
    c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(i ? 2 : 3)), durationMs: i ? 2000 : 3000, final: last });
    await c.sleep(50);
    if (i === 0 && afterFirst) await afterFirst();
  }
  const fresh = () => c.store.listPages().find((p) => !before.has(p.id));
  await c.waitFor(() => { const p = fresh(); const page = p && c.store.getPage(p.id); return Boolean(page && ((page.blocks && page.blocks.length) || page.summaryError)) && c.mainState() === 'idle'; }, 15000);
  const p = fresh();
  return { route: p ? c.store.getPage(p.id).route : null, segments: p ? c.store.getTranscript(p.id).map((x) => ({ text: x.text, failed: Boolean(x.failed) })) : [],
    calls: c.relay.calls().slice(calls0) };
}
const logText = (c) => { const b = c.read('engine.log'); return b ? b.toString('utf8') : ''; };
const RELAY_BASE_SETTINGS = ({ base, userData }) => JSON.stringify({ ...base, autoLaunch: false, claudeExe: require('node:path').join(userData, 'no-such-claude.exe') });

module.exports = {
  TYPICAL, HISTORY, UI, OLD_DRAFT, WS, OLD_KEY_TEXT,
  plain: { files: { 'settings.json': pretty(TYPICAL), 'history.json': pretty(HISTORY) },
    act: async (c) => { c.out.got = await c.handlers['settings:get'](); c.out.history = await c.handlers['history:get'](); } },
  bom: { engine: true, files: { 'settings.json': ({ base }) => Buffer.concat([BOM, Buffer.from(JSON.stringify({ ...base, theme: 'dark' }))]) } },
  utf16: { files: { 'settings.json': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify({ theme: 'dark', micId: 'マイク' }), 'utf16le')]) },
    act: async (c) => { c.out.got = await c.handlers['settings:get'](); } },
  repair: { files: { 'settings.json': pretty({ ...TYPICAL, maxHistory: -1, pillPos: 5, futureKey: { a: 1 } }) } },
  falselike: { files: { 'settings.json': pretty({ ...TYPICAL, autoPaste: 'false' }) } },
  'broken-json': { files: { 'settings.json': '{"theme":"da' }, act: async (c) => { c.out.got = await c.handlers['settings:get'](); } },
  ansi: { files: { 'settings.json': Buffer.concat([Buffer.from('{"micId":"'), CP932_NIHONGO, Buffer.from('"}')]) } },
  'history-broken': { files: { 'settings.json': pretty(TYPICAL), 'history.json': '[{"id":"h1","text":"途中' },
    act: async (c) => { c.out.history = await c.handlers['history:get'](); } },
  partial: { files: { 'settings.json': ({ base }) => JSON.stringify({ ...base, autoLaunch: false }) } },
  allowlist: { files: { 'settings.json': pretty({ ...TYPICAL, futureKey: { a: 1 } }) },
    act: async (c) => { c.out.saved = await c.handlers['settings:save']({}, { ...UI({ theme: 'light' }), evil: 'x', dataDir: 'C:\\old', constructor: 'y' }); } },
  // 計画の外で足した場面（履歴の形の確かめを押さえるテストが無かったため）: JSON としては読めるが配列でない history.json
  'history-shape': { files: { 'settings.json': pretty(TYPICAL), 'history.json': pretty({ id: 'h1', text: '配列でない' }) },
    act: async (c) => { c.out.history = await c.handlers['history:get'](); } },
  // 計画の外で足した場面（N10 を押さえるテストが無かったため）: history.json の名前の変更がずっと失敗する
  'history-save-fail': { files: { 'settings.json': pretty(TYPICAL), 'history.json': pretty(HISTORY) },
    faults: [{ op: 'rename', match: /history\.json$/, code: 'EBUSY', times: Infinity }],
    act: async (c) => { c.out.cleared = await c.handlers['history:clear'](); c.out.history = await c.handlers['history:get'](); } },
  // 第1a回 Task 2-3: 書けないとき・読めないとき
  'save-fail': { files: { 'settings.json': pretty(TYPICAL) },
    faults: [{ op: 'rename', match: /settings\.json$/, code: 'EBUSY', times: 7 }],   // 1 回の保存の試し（1 + RENAME_WAITS の 6）を全部失敗させる
    act: async (c) => {
      c.out.saved = await c.handlers['settings:save']({}, UI({ theme: 'light' }));
      c.out.themeAfterSave = c.electron.nativeTheme.themeSource;
      c.out.textAfterSave = c.read('settings.json').toString('utf8');
      c.out.flushed = c.jsonfile.flushAll();   // 次の書き出しの合図でやり直す（失敗は使い切ったので通る）
    } },
  readonly: { files: { 'settings.json': pretty(TYPICAL) },
    prepare: (ud) => require('node:fs').chmodSync(require('node:path').join(ud, 'settings.json'), 0o444),
    act: async (c) => {
      c.out.first = await c.handlers['settings:save']({}, UI({ theme: 'light' }));
      c.out.second = await c.handlers['settings:save']({}, UI({ theme: 'dark' }));
      c.out.themeSource = c.electron.nativeTheme.themeSource;
      require('node:fs').chmodSync(require('node:path').join(c.userData, 'settings.json'), 0o644);   // 一時フォルダを消せるように戻す
    } },
  unreadable: { files: { 'settings.json': pretty(TYPICAL) },
    faults: [{ op: 'read', match: /settings\.json$/, code: 'EBUSY', times: 7 }],   // 起動の1回の読み（1 + READ_WAITS の 6）を全部失敗させる
    act: async (c) => {
      c.out.saveWhileUnreadable = await c.handlers['settings:save']({}, UI({ theme: 'light' }));
      c.out.flushWhileUnreadable = c.jsonfile.flushAll();
      c.out.textWhileUnreadable = c.read('settings.json').toString('utf8');
      c.out.retries = (c.timers.retrySettingsRead || []).length;
      c.timers.retrySettingsRead[0]();
      c.out.after = await c.handlers['settings:get']();
      c.out.themeAfter = c.electron.nativeTheme.themeSource;
      c.jsonfile.flushAll();
      c.out.textAfterReload = c.read('settings.json').toString('utf8');
      c.out.saveAfter = await c.handlers['settings:save']({}, UI({ theme: 'light' }));
      c.out.textAfterSave = c.read('settings.json').toString('utf8');
    } },
  'unreadable-get': { files: { 'settings.json': pretty(TYPICAL) },
    faults: [{ op: 'read', match: /settings\.json$/, code: 'EBUSY', times: 7 }],
    act: async (c) => { c.out.got = await c.handlers['settings:get'](); } },
  // 読めない間に会議を始めると、読み直しは切り替えずに後へ回す（#57: エンジンの設定が変わると再起動して区間を失う）。
  // エンジンのパスは読めない間の保存でメモリにだけ入れる（ファイルは読めないので、手のパスは保存の画面から来る）
  'unreadable-busy': { files: { 'settings.json': ({ base }) => pretty({ ...TYPICAL, ...base }) },
    faults: [{ op: 'read', match: /settings\.json$/, code: 'EBUSY', times: 7 }],
    act: async (c) => {
      const onDisk = JSON.parse(c.read('settings.json').toString('utf8'));
      c.out.saveWhileUnreadable = await c.handlers['settings:save']({}, UI({ theme: 'light', localServerExe: onDisk.localServerExe, localModelPath: onDisk.localModelPath }));
      c.out.start = await c.handlers['meeting:toggle']();
      c.out.retriesBefore = (c.timers.retrySettingsRead || []).length;
      c.timers.retrySettingsRead[0]();
      c.out.retriesDuring = c.timers.retrySettingsRead.length;
      c.out.themeDuring = (await c.handlers['settings:get']()).theme;
      c.out.discard = await c.handlers['meeting:discard']();
      c.timers.retrySettingsRead[c.timers.retrySettingsRead.length - 1]();
      c.out.themeAfter = (await c.handlers['settings:get']()).theme;
    } },
  // 同じ読み直しを、音声入力（ホットキー）の最中に呼ぶ。#57 の守りの state === 'recording' の側。
  // 待っている読み直しの時計はいつも1つだけ（後へ回すたびに前のを止める）
  'unreadable-dictation': { files: { 'settings.json': ({ base }) => pretty({ ...TYPICAL, ...base }) },
    faults: [{ op: 'read', match: /settings\.json$/, code: 'EBUSY', times: 7 }],
    act: async (c) => {
      const onDisk = JSON.parse(c.read('settings.json').toString('utf8'));
      const pending = () => (c.timers.retrySettingsRead || []).length - (c.clearedTimers.retrySettingsRead || 0);
      c.out.saveWhileUnreadable = await c.handlers['settings:save']({}, UI({ theme: 'light', localServerExe: onDisk.localServerExe, localModelPath: onDisk.localModelPath }));
      c.out.hotkeyRegistered = typeof c.shortcuts[TYPICAL.hotkey] === 'function';
      c.shortcuts[TYPICAL.hotkey]();   // 音声入力を始める
      c.out.retriesBefore = (c.timers.retrySettingsRead || []).length;
      c.timers.retrySettingsRead[0]();
      c.out.retriesDuring = c.timers.retrySettingsRead.length;
      c.timers.retrySettingsRead[c.timers.retrySettingsRead.length - 1]();
      c.out.retriesDuring2 = c.timers.retrySettingsRead.length;
      c.out.themeDuring = (await c.handlers['settings:get']()).theme;
      c.out.pendingDuring = pending();
      c.listeners['overlay:cancel-request']();   // 音声入力を取り消す（idle に戻る）
      c.timers.retrySettingsRead[c.timers.retrySettingsRead.length - 1]();
      c.out.themeAfter = (await c.handlers['settings:get']()).theme;
      c.out.pendingAfter = pending();
    } },
  'history-unreadable': { files: { 'settings.json': pretty(TYPICAL), 'history.json': pretty(HISTORY) },
    faults: [{ op: 'read', match: /history\.json$/, code: 'EBUSY', times: 7 }],
    act: async (c) => {
      c.out.cleared = await c.handlers['history:clear']();
      c.out.textWhileUnreadable = c.read('history.json').toString('utf8');
      c.timers.retryHistoryRead[0]();
      c.out.after = await c.handlers['history:get']();
    } },
  // 第1a回 Task 2-4: 録音バーの位置のまとめ書き・書き出しの合図・始めの片付け
  signals: { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      const [overlay, main] = c.wins;   // createOverlay が先、createMainWindow が後
      const pill = () => { const t = c.read('settings.json'); return t ? JSON.parse(t.toString('utf8')).pillCustom : undefined; };
      const order = [
        ['win', overlay, 'session-end'], ['win', main, 'query-session-end'], ['power', null, 'suspend'], ['power', null, 'lock-screen'],
        ['power', null, 'shutdown'], ['win', main, 'hide'], ['win', main, 'close'], ['app', null, 'will-quit'], ['app', null, 'before-quit'],
      ];
      c.out.signals = order.map(([kind, w, ev], i) => {
        overlay.setPosition(100 + i, 200);
        overlay.emit('move');
        const before = pill();
        const e = { preventDefault() {} };
        if (kind === 'win') w.emit(ev, e); else if (kind === 'power') c.power.emit(ev); else c.app.emit(ev, e);
        return { ev, before, after: pill() };   // 受け口が返った直後（同じ手番の中）に読む
      });
    } },
  batched: { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      const [overlay] = c.wins;
      overlay.setPosition(7, 8); overlay.emit('move');
      overlay.setPosition(9, 10); overlay.emit('move');
      c.out.right = JSON.parse(c.read('settings.json').toString('utf8')).pillCustom;
      const pillNow = () => JSON.parse(c.read('settings.json').toString('utf8')).pillCustom;
      await c.waitFor(() => pillNow().x === 9, 3000);   // 間隔（350ms）の後に書かれるのを待つ（決まった長さで眠らない。混んだ CI でも揺れない）
      c.out.later = pillNow();
    } },
  // segbuf のフォルダの名前は録音を始めた時刻。7日より前の時刻の名前は起動のときの cleanOrphanSegbuf がフォルダごと消すので
  // （計画の 1760000000000 = 2025-10-09 では WAV が残るかを確かめられない）、先の時刻（2100-01-01）にして残す
  temps: { files: { 'settings.json': pretty(TYPICAL), 'settings.json.tmp': 'x', 'settings.json.4242-k3j9ab.tmp': 'x', 'history.json.tmp': 'x',
    'data/pages/p1.json.tmp': 'x', 'data/segbuf/4102444800000/0001.wav.tmp': 'x', 'data/segbuf/4102444800000/recovery.json.9-zz.tmp': 'x' } },
  'batch-env': { files: { 'settings.json': pretty(TYPICAL) }, env: { NATSU_TEST_BATCH_MS: '60000' } },
  'unreadable-move': { files: { 'settings.json': pretty(TYPICAL) },
    faults: [{ op: 'read', match: /settings\.json$/, code: 'EBUSY', times: 7 }],
    act: async (c) => {
      const [overlay] = c.wins;
      overlay.setPosition(5, 6); overlay.emit('move');
      c.power.emit('suspend');
      c.out.textAfterSignal = c.read('settings.json').toString('utf8');
      c.timers.retrySettingsRead[0]();
      await c.sleep(600);
      c.out.textLater = c.read('settings.json').toString('utf8');
      c.out.after = await c.handlers['settings:get']();
    } },
  // 第1a回 Task 2-5: 録音の控え（draft.json・recovery.json）
  'draft-busy': { engine: true, files: { 'settings.json': ({ base }) => JSON.stringify(base), 'data/draft.json': JSON.stringify(OLD_DRAFT) },
    // 起動の読み（7 回）と、録音を始める前の読み（7 回）を失敗させる。退けようとしても掴まれていて名前を変えられない
    faults: [{ op: 'read', match: /draft\.json$/, code: 'EBUSY', times: 14 }, { op: 'rename', match: /draft\.pending-/, code: 'EBUSY', times: Infinity }],
    act: async (c) => {
      c.out.pagesAtStart = c.store.listPages().length;
      c.out.start = await c.handlers['meeting:toggle']();
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: false });
      await c.waitFor(() => c.store.draftFiles().some((n) => /^draft-\d+\.json$/.test(n)));
      c.out.draftsDuring = c.store.draftFiles();
      c.out.oldDraftDuring = c.read('data/draft.json').toString('utf8');
      c.out.retryDuringMeeting = (c.timers.retryDraftRecovery || []).length;
      for (const f of c.timers.retryDraftRecovery || []) f();   // 録音中の試しは、終わった後に回る
      c.out.pagesWhileRecording = c.store.listPages().length;
      c.out.stop = await c.handlers['meeting:toggle']();
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(2)), durationMs: 2000, final: true });
      await c.waitFor(() => c.store.listPages().length >= 2);
      // 第2a1回 M-2b から復旧のページは DB が書き、main は返事を受けてから下書きを消す。ページが見えた時はまだ返事の前のことがある
      // （CI run 39242366429 の Windows の Electron の Node）。下書きが片付くのを 10 秒まで待ってから見る（片付かなければ下の確かめが赤）
      await c.waitFor(() => c.store.draftFiles().length === 0, 10000);
      c.out.titles = c.store.listPages().map((p) => p.title);
      c.out.draftsAfter = c.store.draftFiles();
    } },
  // 下書きから復旧したページを保存できない。下書きは消さず、記録には理由の符号だけを書く。第2a1回 M-2b から議事録は DB のプロセスが
  // 書くので、main の fs の失敗（ページの一時ファイルを開けない）の代わりに、DB を使えない（--db-down）で保存できなくする
  'draft-page-fail': { dbDown: true, files: { 'settings.json': pretty(TYPICAL), 'data/draft.json': JSON.stringify(OLD_DRAFT) } },
  'draft-broken': { files: { 'settings.json': pretty(TYPICAL), 'data/draft.json': '{"startedAt":1760000000000,"segme' } },
  'recovery-broken': { files: { 'settings.json': pretty(TYPICAL), 'data/segbuf/1700000000000/0001.wav': 'RIFF', 'data/segbuf/1700000000000/recovery.json': '{"pageId":"p1","items":[' } },
  // 前の起動で退けた recovery.json だけが残った、7日より古いフォルダ（名前が無いので掃除が避けない）
  'recovery-old-quarantined': { files: { 'settings.json': pretty(TYPICAL), 'data/segbuf/1700000000000/0001.wav': 'RIFF', 'data/segbuf/1700000000000/recovery.json.broken-2026-10-01T00-00-00-000Z': '{"pageId":' },
    prepare: (ud) => { const p = require('node:path').join(ud, 'data', 'segbuf', '1700000000000'); const old = new Date(Date.now() - 8 * 86400000); require('node:fs').utimesSync(p, old, old); } },
  'recovery-unreadable': { files: { 'settings.json': pretty(TYPICAL), 'data/segbuf/1700000000000/0001.wav': 'RIFF', 'data/segbuf/1700000000000/recovery.json': '{"pageId":"p1","items":[]}' },
    faults: [{ op: 'read', match: /recovery\.json$/, code: 'EBUSY', times: Infinity }],
    prepare: (ud) => { const p = require('node:path').join(ud, 'data', 'segbuf', '1700000000000'); const old = new Date(Date.now() - 8 * 86400000); require('node:fs').utimesSync(p, old, old); } },
  'recovery-write-fail': { files: { 'settings.json': pretty(TYPICAL),
      'data/draft.json': ({ userData }) => JSON.stringify({ ...OLD_DRAFT, segments: [{ id: 's1', atMs: 0, durationMs: 3000, pending: true, wav: require('node:path').join(userData, 'data', 'segbuf', '1760000000000', '0001.wav'), text: '' }] }),
      'data/segbuf/1760000000000/0001.wav': 'RIFF' },
    faults: [{ op: 'open', match: /recovery\.json\.\d+-[0-9a-z]+\.tmp$/, code: 'EACCES', times: Infinity }] },
  // 起動の途中で1回だけ recovery.json を書けない（エンジンも無い）。下書きはもう消えたので、書き出しの合図で書き直す（N16 の「次の起動でもう一度」を本当にする）
  'recovery-write-later': { files: { 'settings.json': pretty(TYPICAL),
      'data/draft.json': ({ userData }) => JSON.stringify({ ...OLD_DRAFT, segments: [{ id: 's1', atMs: 0, durationMs: 3000, pending: true, wav: require('node:path').join(userData, 'data', 'segbuf', '1760000000000', '0001.wav'), text: '' }] }),
      'data/segbuf/1760000000000/0001.wav': 'RIFF' },
    faults: [RECOVERY_OPEN_FAIL],
    act: async (c) => {
      const f = require('node:path').join(c.userData, 'data', 'segbuf', '1760000000000', 'recovery.json');
      c.out.before = require('node:fs').existsSync(f);
      RECOVERY_OPEN_FAIL.times = 0;   // ここから書けるようになる（掴んでいたプログラムが離した）
      c.power.emit('suspend');
      c.out.after = require('node:fs').existsSync(f) ? JSON.parse(require('node:fs').readFileSync(f, 'utf8')) : null;
      c.out.pages = c.store.listPages().map((p) => p.id);
    } },
  // 起動の1回の読み（1 + READ_WAITS の 6）だけ読めない recovery.json。少し後のやり直しで読める
  'recovery-busy-retry': { files: { 'settings.json': pretty(TYPICAL),
      'data/pages/p1.json': JSON.stringify({ id: 'p1', title: '復旧の会議', blocks: [], createdAt: '2026-10-01T00:00:00.000Z' }),
      'data/segbuf/1700000000000/0001.wav': 'RIFF',
      'data/segbuf/1700000000000/recovery.json': ({ userData }) => JSON.stringify({ pageId: 'p1', items: [{ id: 's1', wav: require('node:path').join(userData, 'data', 'segbuf', '1700000000000', '0001.wav'), durationMs: 3000 }], retry: false }) },
    faults: [{ op: 'read', match: /recovery\.json$/, code: 'EBUSY', times: 7 }],
    // やり直しは待つ（第2a1回 M-4 から下書きの復旧は1つずつ回すので、読み直しの記録は数手番あとに書かれる）
    act: async (c) => { c.out.retries = (c.timers.retryDraftRecovery || []).length; for (const f of c.timers.retryDraftRecovery || []) await f(); } },
  // 第2a1回 M-1（ST1）: recovery.json の pageId のページが無い（消された）。フォルダは7日の掃除に当たらない新しい名前。
  // エンジンを起こさずに、WAV と recovery.json を片付ける（ページの確かめは db.call('page.get') が null と答えたときだけ）
  'recovery-page-gone': { files: { 'settings.json': pretty(TYPICAL),
      'data/segbuf/4102444800000/0001.wav': 'RIFF',
      'data/segbuf/4102444800000/recovery.json': ({ userData }) => JSON.stringify({ pageId: 'pgone1', items: [{ id: 's1', wav: require('node:path').join(userData, 'data', 'segbuf', '4102444800000', '0001.wav'), durationMs: 3000 }], retry: false }) },
    act: async (c) => { await c.waitFor(() => !c.read('data/segbuf/4102444800000/recovery.json') && !c.read('data/segbuf/4102444800000/0001.wav'), 3000); } },
  // 第2a1回 M-1（ST1）: 録音を始める前の復旧（起動の読み 7 回だけ draft.json を読めない。退けることはできる）。
  // startMeeting は復旧の書き込み（db.call('meeting.recover')）を待ってから下書きを選ぶ。待たないと、復旧中の draft.json を
  // 脇へ退け（draft.pending-*）、新しい会議の draft.json を復旧の後片付けが消し、退けた控えがもう一度復旧されて2つ目のページになる
  'draft-recover-before-start': { engine: true, files: { 'settings.json': ({ base }) => JSON.stringify(base), 'data/draft.json': JSON.stringify(OLD_DRAFT) },
    faults: [{ op: 'read', match: /draft\.json$/, code: 'EBUSY', times: 7 }],
    act: async (c) => {
      c.out.pagesAtStart = c.store.listPages().length;
      c.out.start = await c.handlers['meeting:toggle']();
      await c.sleep(50);
      c.out.titlesAfterStart = c.store.listPages().map((p) => p.title);
      c.out.draftsDuring = c.store.draftFiles();
      try { c.out.draftStartedAt = JSON.parse(c.read('data/draft.json').toString('utf8')).startedAt; } catch (_) { c.out.draftStartedAt = null; }
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: false });
      c.out.stop = await c.handlers['meeting:toggle']();
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(2)), durationMs: 2000, final: true });
      await c.waitFor(() => c.store.listPages().length >= 2);
      for (const f of c.timers.retryDraftRecovery || []) await f();   // 起動のときに予約したやり直し: もう復旧するものは無い
      await c.sleep(100);
      await c.waitFor(() => c.store.draftFiles().length === 0, 10000);   // 締めの返事の後に下書きが消える（draft-busy と同じ。返事より先にページが見える）
      c.out.titles = c.store.listPages().map((p) => p.title);
      c.out.draftsAfter = c.store.draftFiles();
    } },
  // 第2a1回 M-1（ST1）: 要約の途中で終了する。要約エンジンは起こそうとしても応えない（偽の子。/health に誰も居ない）ので要約は終わらない。
  // before-quit は1回だけ止め、「要約が中断されました」をページに書いてから app.quit() を呼ぶ。2回目の before-quit は止めずにエンジンを止める
  // db.call の答えは 30ms 遅らせる（第2a1回 M-1 で、書き込みをほぼ同期で済ませる json-backend のために足した。DB のプロセスの返事の
  // 遅れに上乗せして、待たずに app.quit() を呼ぶと間に合わないようにする）
  'quit-during-summary': { dbDelayMs: 30, files: {
      'settings.json': ({ base, userData }) => pretty({ ...TYPICAL, sumPort: base.sumPort,
        sumServerExe: require('node:path').join(userData, 'engine-sum', 'llama-server.exe'), sumModelPath: require('node:path').join(userData, 'engine-sum', 'sum-model.gguf') }),
      // 偽の実行ファイルは 8KB にする。NTFS は数百バイトまでの小さなファイルを MFT の中に置き（割り当て 0）、Windows の Node の
      // stat の blocks が 0 になって engineFileIssue が「プレースホルダ」と見なし、要約エンジンを「未設定」にする（CI の Windows で落ちた）
      'engine-sum/llama-server.exe': 'MZ-fake-llama-server'.padEnd(8192, '.'),
      'data/pages/pq1.json': JSON.stringify({ id: 'pq1', title: '終了の前の会議', blocks: [], memo: '', createdAt: '2026-10-01T00:00:00.000Z', summaryError: '', route: { localOnly: true } }),
      'data/transcripts/pq1.json': JSON.stringify({ id: 'pq1', segments: [{ id: 's1', atMs: 0, durationMs: 3000, text: '本日の議題は進捗の確認です' }] }) },
    // 要約のモデルは大きさの床（300MB）を超える疎のファイル（先頭だけ書く。全部が疎だとプレースホルダと見なされる）
    prepare: (ud) => {
      const fs = require('node:fs');
      const fd = fs.openSync(require('node:path').join(ud, 'engine-sum', 'sum-model.gguf'), 'w');
      fs.writeSync(fd, Buffer.alloc(8192, 1));
      fs.ftruncateSync(fd, 301 * 1024 * 1024);
      fs.closeSync(fd);
    },
    act: async (c) => {
      const exe = require('node:path').join(c.userData, 'engine-sum', 'llama-server.exe');
      const kills = () => c.fakeKids.filter((k) => k.cmd === exe).reduce((n, k) => n + k.kills, 0);
      const summarizing = c.handlers['page:summarize']({}, 'pq1');
      c.out.sumStarted = await c.waitFor(() => c.fakeKids.some((k) => k.cmd === exe), 5000);
      const quits = [];
      // app.quit() を呼ばれた瞬間のページのファイル（書き込みを待ってから呼んだか）とエンジンを止めた回数
      c.app.quit = () => { const p = c.store.getPage('pq1'); quits.push({ summaryError: p ? p.summaryError : null, kills: kills() }); };
      const ev1 = { n: 0, preventDefault() { this.n += 1; } };
      c.app.emit('before-quit', ev1);
      c.out.quitted = await c.waitFor(() => quits.length >= 1, 5000);
      // 本物の Electron は app.quit() でもう一度 before-quit を出す
      const ev2 = { n: 0, preventDefault() { this.n += 1; } };
      c.app.emit('before-quit', ev2);
      await c.sleep(50);
      c.out.prevented = [ev1.n, ev2.n];
      c.out.quits = quits;
      c.out.killsAfter = kills();
      c.out.summary = await Promise.race([summarizing, c.sleep(5000).then(() => 'timeout')]);
      const p = c.store.getPage('pq1');
      c.out.summaryErrorAfter = p ? p.summaryError : null;
    } },
  // 壊れたページ（p1）と、ページは無事で文字起こしだけ壊れたページ（p2）。第2a1回 M-2b から、起動では元の JSON に触れない（store.init で
  // 退けない）。移行は退けない読み方で読み、壊れたページは数えて飛ばし、文字起こしだけ壊れたページは「発言なし」で移す（ST10）。
  // 元のファイルは元の名前・元の中身のまま（out.originals に、置いたときと同じ中身かを名前ごとに入れる）
  'page-files-broken': { files: { 'settings.json': pretty(TYPICAL), ...BROKEN_PAGE_FILES },
    act: async (c) => {
      // 画面と同じ役 app の口で読む（第2a1回 M-3 から main は page:get を中継しない）
      c.out.p1 = await c.appCall('page.get', { id: 'p1' });
      c.out.p2 = await c.appCall('page.get', { id: 'p2' });
      c.out.originals = Object.fromEntries(Object.entries(BROKEN_PAGE_FILES).map(([rel, body]) => {
        const b = c.read(rel);
        return [rel, b !== null && b.toString('utf8') === body];
      }));
    } },
  // 第2a1回 M-2b（ST12・RF10）: 議事録の DB を使えない（--db-down: SQLite に trigram が無く、自分の確かめが通らない）。
  // 設定・画面の覚え書き・音声入力の履歴は今までどおり読み書きでき、会議は下書きに残り、知らせ D1 が1回出る
  'db-down': { engine: true, dbDown: true, files: { 'settings.json': ({ base }) => JSON.stringify(base) },
    act: async (c) => {
      const saved = await c.handlers['settings:save']({}, { theme: 'light' });
      const onDisk = JSON.parse(c.read('settings.json').toString('utf8'));
      c.out.settingsSaved = Boolean(saved) && saved.ok !== false && onDisk.theme === 'light';
      c.out.uiSet = await c.handlers['ui:set']({}, { sidebar: { width: 300, collapsed: false } });
      const hk = (await c.handlers['settings:get']()).hotkey;
      c.shortcuts[hk]();   // 音声入力を1回
      c.listeners['audio:done']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000 });
      await c.waitFor(() => (c.handlers['history:get']() || []).length > 0, 10000);
      c.out.history = c.handlers['history:get']();
      // 音声入力の後片付け（貼り付け）が済んで待機に戻るまでは「処理中です」で断られる。戻ったら会議を始める
      for (let i = 0; i < 200; i++) {
        c.out.start = await c.handlers['meeting:toggle']();
        if (c.out.start && c.out.start.ok) break;
        await c.sleep(50);
      }
      c.out.stop = await c.handlers['meeting:toggle']();
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: true });
      const log = () => { const b = c.read('engine.log'); return b ? b.toString('utf8') : ''; };
      c.out.finalizeFailed = await c.waitFor(() => log().includes('議事録の保存に失敗'), 10000);
      c.power.emit('suspend');   // 画面の覚え書きのまとめ書きを書き出す
    } },
  // 第2a1回 M-2b（F12）: 前の起動で DB に移した議事録（prec1・pother1）の復旧の待ち行列（WAV 2つ）と、開いたタブ2つ。DB を使えない
  // （--db-down）間は、「ページが無い」と取り違えて WAV と recovery.json を消さず、覚えたタブも外さない
  'recovery-db-down': { dbDown: true, files: { 'settings.json': pretty(TYPICAL),
      'data/pages/prec1.json': JSON.stringify({ id: 'prec1', title: '復旧を待つ会議', blocks: [], createdAt: '2026-10-01T00:00:00.000Z' }),
      'data/transcripts/prec1.json': JSON.stringify({ id: 'prec1', segments: [{ id: 's1', atMs: 0, durationMs: 3000, text: '', failed: true }, { id: 's2', atMs: 3000, durationMs: 3000, text: '', failed: true }] }),
      'data/pages/pother1.json': JSON.stringify({ id: 'pother1', title: '別の会議', blocks: [], createdAt: '2026-10-02T00:00:00.000Z' }),
      'data/segbuf/4102444800000/0001.wav': 'RIFF', 'data/segbuf/4102444800000/0002.wav': 'RIFF',
      'data/segbuf/4102444800000/recovery.json': ({ userData }) => {
        const wav = (n) => require('node:path').join(userData, 'data', 'segbuf', '4102444800000', n);
        return JSON.stringify({ pageId: 'prec1', items: [{ id: 's1', wav: wav('0001.wav'), durationMs: 3000 }, { id: 's2', wav: wav('0002.wav'), durationMs: 3000 }], retry: false });
      } },
    local: { [WS_FILE]: WS({ tabs: { open: ['page:prec1', 'page:pother1'], active: 'page:prec1' } }) },
    // 前の起動で移した（本物の移行で natsu.db を作る。この起動では DB のプロセスの SQLite が trigram を持たず、開けない）
    prepare: (ud) => {
      const r = require('../../src/db/migrate').migrate({ sqlite: require('node:sqlite'), dataDir: require('node:path').join(ud, 'data') });
      if (!r.ok) throw new Error(`recovery-db-down: 前の移行を作れない（${r.code}）`);
    },
    act: async (c) => {
      const log = () => { const b = c.read('engine.log'); return b ? b.toString('utf8') : ''; };
      c.out.held = await c.waitFor(() => log().includes('復旧の文字起こしを保留: 議事録を読めません'), 10000);
      c.out.uiTabs = (await c.handlers['ui:get']()).tabs;
    } },
  // 第2a1回 M-2b（ST7）: 要約が無くても、終わるときは1回だけ止めて DB を閉じ（cleanShutdown を書いてチェックポイント）、それから
  // app.quit() を呼ぶ。app.quit は偽物で、呼ばれた瞬間の DB の meta.cleanShutdown と、子を閉じたかを覚える
  'quit-closes-db': { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      const quits = [];
      c.app.quit = () => { quits.push({ cleanShutdown: c.dbMeta('cleanShutdown'), closed: c.dbState() === 'down' }); };
      const ev1 = { n: 0, preventDefault() { this.n += 1; } };
      c.app.emit('before-quit', ev1);
      await c.waitFor(() => quits.length >= 1, 8000);
      const ev2 = { n: 0, preventDefault() { this.n += 1; } };
      c.app.emit('before-quit', ev2);
      c.out.prevented = [ev1.n, ev2.n];
      c.out.quits = quits;
    } },
  // 第2a1回 M-2b（F12）: DB の用意の前（移行の途中。移行のファイル1つごとに 1.5 秒止まる）の ui:get は、用意を待たずに覚えたタブを
  // そのまま返す（止まっているのを「無い」にしない）。用意ができた後は、無いページ（pgone）のタブを外す
  'ui-before-db-ready': { noDbWait: true, env: { NATSU_TEST_MIGRATE_DELAY_MS: '1500' }, files: { 'settings.json': pretty(TYPICAL),
      'data/pages/pkeep1.json': JSON.stringify({ id: 'pkeep1', title: '残る会議', blocks: [], createdAt: '2026-10-01T00:00:00.000Z' }) },
    local: { [WS_FILE]: WS({ tabs: { open: ['page:pkeep1', 'page:pgone'], active: 'page:pkeep1' } }) },
    act: async (c) => {
      c.out.stateBefore = c.dbState();
      const t0 = Date.now();
      c.out.before = (await c.handlers['ui:get']()).tabs;
      c.out.beforeMs = Date.now() - t0;
      c.out.ready = await c.waitFor(() => c.dbState() === 'ready', 15000);
      c.out.after = (await c.handlers['ui:get']()).tabs;
    } },
  // 第2a1回 M-2b（ST7）: 本体の窓の読み込みのたびに DB の口を配り直す（画面を読み込み直すと前の口は閉じる）。録音バーには渡さない
  'db-ports': { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      const [overlay, main] = c.wins;
      main.webContents.emit('did-finish-load');
      overlay.webContents.emit('did-finish-load');
      main.webContents.emit('did-finish-load');
    } },
  // 第2a1回 M-2b（ST7。点検で足した場面）: 用意ができた後に DB の子が落ちたら、本体の窓に db:lost を送り、起こし直した子の用意が
  // できたら口を配り直す（前の子の口は死んでいる）。読み込みで1つ配ってから落とす
  'db-restart': { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      const [, main] = c.wins;
      main.webContents.emit('did-finish-load');
      c.out.crashed = c.dbCrash(1);
      c.out.restarted = await c.waitFor(() => c.dbStarts() === 2 && c.dbState() === 'ready', 10000);
      await c.sleep(100);   // 用意の知らせの後の配り直しを待つ
      c.out.mainSent = c.mainSent().filter((ch) => ch === 'db:lost');
    } },
  // 第2a1回 M-2b（ST7。点検で足した場面）: 最初の用意の前（移行の途中）に DB の子が落ちても同じ。読み込みで配った口は落ちた子のもの
  // なので、起こし直した子の（アプリで最初の）用意で配り直す。移行は起こし直した子がやり直し、元の JSON は1バイトも変えない
  'db-restart-before-ready': { noDbWait: true, env: { NATSU_TEST_MIGRATE_DELAY_MS: '1000' }, files: { 'settings.json': pretty(TYPICAL),
      'data/pages/pmig1.json': JSON.stringify({ id: 'pmig1', title: '移行の途中で落ちた会議', blocks: [], createdAt: '2026-10-01T00:00:00.000Z' }) },
    act: async (c) => {
      const [, main] = c.wins;
      c.out.migrating = await c.waitFor(() => c.dbState() === 'migrating', 10000);
      main.webContents.emit('did-finish-load');
      c.out.crashed = c.dbCrash(1);
      c.out.restarted = await c.waitFor(() => c.dbStarts() === 2 && c.dbState() === 'ready', 12000);
      await c.sleep(100);
      c.out.mainSent = c.mainSent().filter((ch) => ch === 'db:lost');
      c.out.pages = c.store.listPages().map((p) => p.id);
      const raw = c.read('data/pages/pmig1.json');
      c.out.jsonKept = raw !== null && raw.toString('utf8') === JSON.stringify({ id: 'pmig1', title: '移行の途中で落ちた会議', blocks: [], createdAt: '2026-10-01T00:00:00.000Z' });
    } },
  // 第2a1回 M-4（ST10・Q1）: 初めての起動で、0.6.0 の store.js で置いた 6 ページ（1 つは BOM 付き。発言は 3・3・3・2・2・2 の 15）と
  // 壊れたページのファイル 1 つ。窓 D0 で［移す］（偽の dialog の既定）。元の JSON（pages・transcripts・index.json）の SHA-256 を前後で見る
  'migrate-go': { files: { 'settings.json': pretty(TYPICAL) },
    prepare: (ud) => {
      const fs = require('node:fs');
      const path = require('node:path');
      const ids = oldPages(ud, [3, 3, 3, 2, 2, 2]);
      const f = path.join(ud, 'data', 'pages', `${ids[0]}.json`);
      fs.writeFileSync(f, Buffer.concat([BOM, fs.readFileSync(f)]));   // メモ帳で保存し直した（BOM 付き）
      fs.writeFileSync(path.join(ud, 'data', 'pages', 'pbroken0001.json'), '{"id":"pbroken0001","title":"壊れ');
      shaBefore = jsonShas(ud);
    },
    act: async (c) => { c.out.jsonShaBefore = shaBefore; c.out.jsonShaAfter = jsonShas(c.userData); } },
  // 第2a1回 M-4（Q1）: 窓 D0 で［今は移さずに終える］。本物と同じく app.quit() が before-quit を出す（main は DB を閉じてから終える）。
  // 前の起動の下書き（落ちた会議）も置き、中身がそのままかを見る
  'migrate-quit': { noDbWait: true, dialog: 'quit', quitEmits: true,
    files: { 'settings.json': pretty(TYPICAL), 'data/draft.json': pretty(OLD_DRAFT) },
    prepare: (ud) => { oldPages(ud, [2, 1]); shaBefore = jsonShas(ud); },
    act: async (c) => {
      c.out.closed = await c.waitFor(() => c.quitCalls() >= 2 && c.dbState() === 'down', 10000);
      c.out.jsonShaBefore = shaBefore;
      c.out.jsonShaAfter = jsonShas(c.userData);
      const d = c.read('data/draft.json');
      c.out.draftSame = d !== null && d.toString('utf8') === pretty(OLD_DRAFT);
    } },
  // 第2a1回 M-4（ST10）: 移行の確かめが合わない（NATSU_TEST_MIGRATE_VERIFY_FAIL）。natsu.db は作らず、.migrating を .failed に退け、知らせ D4
  'migrate-verify-fail': { env: { NATSU_TEST_MIGRATE_VERIFY_FAIL: '1' }, files: { 'settings.json': pretty(TYPICAL) },
    prepare: (ud) => { oldPages(ud, [2, 2]); shaBefore = jsonShas(ud); },
    act: async (c) => {
      await c.sleep(100);   // 使えないと分かった後の知らせが画面に届くのを待つ
      c.out.jsonShaBefore = shaBefore;
      c.out.jsonShaAfter = jsonShas(c.userData);
    } },
  // 第2a1回 M-4（RF14・F9）: 窓 D0 を開いたまま（DB は移行の答え待ち）、ホットキーで2回録音して止める（どちらも締めは DB を待つ）。
  // 3回目の録音の最中に［移す］を押し、DB の用意の後の片付け（meeting.settle）が録音中の写しを一覧に出さないかを見てから止める。
  // 前の起動で消しきれなかった取り消しの控え（purge-pending.json）を置く（起動の片付けが DB を待ち、settle が用意の後に、
  // 録音中の写しが DB に届いてから決まるように）。移行のファイル1つごとに 200ms 止める（進み具合の帯を見る）
  'migrate-record-during': { engine: true, noDbWait: true, dialog: 'hold', env: { NATSU_TEST_MIGRATE_DELAY_MS: '200' },
    files: { 'settings.json': ({ base }) => JSON.stringify(base), 'data/purge-pending.json': pretty({ pageIds: ['pzpurge0001'] }) },
    prepare: (ud) => { oldPages(ud, [1, 1]); },
    act: async (c) => {
      const hk = (await c.handlers['settings:get']()).meetingHotkey;
      c.out.dialogShown = await c.waitFor(() => c.dialogs().length === 1, 10000);
      await c.waitFor(() => c.mainState() === 'idle', 10000);
      const waitText = '録音を保存しました。議事録は準備ができしだい作ります';
      const stopOne = async (n) => {
        c.shortcuts[hk]();   // 止める
        c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: true });
        await c.waitFor(() => c.overlayDone().filter((m) => m === waitText).length >= n, 6000);
      };
      const states = [];
      c.out.statesBeforeReady = states;
      for (let n = 1; n <= 2; n++) {
        c.shortcuts[hk]();   // 始める
        await c.waitFor(() => c.mainState() === 'meeting', 5000);
        await stopOne(n);
        states.push(c.mainState());
        if (states[n - 1] !== 'idle') return;   // 待機に戻らない: 次の録音を始められないので、ここで結果を出す
      }
      c.out.dbStateBeforeAnswer = c.dbState();
      // 3回目を始め、録音中に［移す］
      c.shortcuts[hk]();
      c.out.thirdStarted = await c.waitFor(() => c.mainState() === 'meeting', 5000);
      const drafts = c.store.draftFiles().map((n) => c.store.readDraftFile(n)).filter((r) => r.state === 'ok').map((r) => r.value);
      const cur = drafts.sort((a, b) => b.startedAt - a.startedAt)[0];
      c.answerDialog(0);
      c.out.ready = await c.waitFor(() => c.dbState() === 'ready', 10000);
      c.out.settled = await c.waitFor(() => c.trace().some((t) => t.kind === 'ack' && t.cmd === 'meeting.settle'), 8000);
      c.out.listedWhileRecording = (await c.appCall('pages.list', {})).some((p) => p.id === (cur && cur.pageId));
      c.out.migratedCount = 2;
      c.shortcuts[hk]();
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: true });
      await c.waitFor(() => c.store.listPages().length >= 5 && !c.store.draftFiles().length, 8000);
      c.out.progress = c.mainProgress();
    } },
  // 第2a1回 M-4 の点検で足した場面（F9・RF14。利用者の 0.6.0 → 0.7.0 の初めての起動）: 0.6.0 で落ちた会議の下書き（pageId の無い
  // draft.json）が残ったまま、窓 D0 を開いたまま録音を始める。起動の復旧はこの下書きで DB（移行の答え）を待っている。
  // 録音はその復旧を待たずにすぐ始まり（録音は DB に頼らない）、その下書きは draft.json を脇へ退けずに別の名前になる（退けると、
  // 起動の復旧が後で clearDraft('draft.json') で録音中の会議の下書きを消し、退けた 0.6.0 の下書きが残って次の起動で2つ目のページになる）
  'migrate-old-draft-record': { engine: true, noDbWait: true, dialog: 'hold', env: { NATSU_TEST_MIGRATE_DELAY_MS: '200' },
    files: { 'settings.json': ({ base }) => JSON.stringify(base), 'data/draft.json': pretty(OLD_DRAFT) },
    prepare: (ud) => { oldPages(ud, [1, 1]); },
    act: async (c) => {
      const hk = (await c.handlers['settings:get']()).meetingHotkey;
      c.out.dialogShown = await c.waitFor(() => c.dialogs().length === 1, 10000);
      await c.waitFor(() => c.mainState() === 'idle', 10000);
      c.shortcuts[hk]();   // 始める（窓 D0 は開いたまま）
      c.out.startedQuick = await c.waitFor(() => c.mainState() === 'meeting', 2000);
      c.out.dbBefore = c.dbState();
      // 録音中の会議の下書き（pageId があるもの。0.6.0 の下書きには無い）
      const live = () => c.store.draftFiles().map((name) => ({ name, r: c.store.readDraftFile(name) }))
        .find((x) => x.r.state === 'ok' && typeof x.r.value.pageId === 'string' && x.r.value.pageId);
      let cur = null;
      if (c.out.startedQuick) {
        cur = live();
        c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: false });
        // 区間の文字起こしが下書きに載るのを待つ（この後、起動の復旧が片付けをしても、この会議の下書きに触れないかを見る）
        await c.waitFor(() => c.trace().some((t) => t.kind === 'draft' && cur && t.pageId === cur.r.value.pageId && t.segs >= 1), 4000);
      }
      c.answerDialog(0);
      c.out.ready = await c.waitFor(() => c.dbState() === 'ready', 10000);
      if (!c.out.startedQuick) { await c.waitFor(() => c.mainState() === 'meeting', 5000); cur = live(); }
      // 起動の復旧（0.6.0 の下書きのページ）が済むのを待ってから、録音中の会議の下書きがまだあるかを見る
      c.out.recoverDone = await c.waitFor(() => c.trace().some((t) => t.kind === 'ack' && t.cmd === 'meeting.recover'), 8000);
      await c.sleep(50);
      c.out.stillRecording = c.mainState() === 'meeting';
      c.out.draftsAfterReady = c.store.draftFiles();
      const kept = cur ? c.store.readDraftFile(cur.name) : null;
      c.out.liveDraftKept = Boolean(cur && kept && kept.state === 'ok' && kept.value.pageId === cur.r.value.pageId);
      c.shortcuts[hk]();   // 止める
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: true });
      await c.waitFor(() => c.mainState() === 'idle' && c.store.listPages().length >= 4 && !c.store.draftFiles().length, 8000);
      await c.sleep(50);
      c.out.draftsEnd = c.store.draftFiles();
    } },
  // 0.7.0 の前の直し（第2a1回 M-4 の点検で残したこと）: 締めの返事を待つ会議（窓 D0 を開いたままなので DB は答え待ち）は、録音の状態が
  // 待機に戻っても「忙しい」。省電力の抑止を外さず、閉じるボタンで確かめを出す（偽の確かめは［キャンセル］を返す）。［移す］の後、
  // 締めと要約の試みが済んだら抑止を外す
  'finalize-wait-busy': { engine: true, noDbWait: true, dialog: 'hold', env: { NATSU_TEST_MIGRATE_DELAY_MS: '200' },
    files: { 'settings.json': ({ base }) => JSON.stringify(base) },
    prepare: (ud) => { oldPages(ud, [1]); },
    act: async (c) => {
      const hk = (await c.handlers['settings:get']()).meetingHotkey;
      const held = () => { let n = 0; for (const [k] of c.powerBlocks()) n += k === 'start' ? 1 : -1; return n > 0; };
      c.out.dialogShown = await c.waitFor(() => c.dialogs().length === 1, 10000);
      await c.waitFor(() => c.mainState() === 'idle', 10000);
      c.shortcuts[hk]();   // 始める
      c.out.started = await c.waitFor(() => c.mainState() === 'meeting', 5000);
      c.shortcuts[hk]();   // 止める
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: true });
      c.out.waiting = await c.waitFor(() => c.overlayDone().includes('録音を保存しました。議事録は準備ができしだい作ります') && c.mainState() === 'idle', 6000);
      await c.sleep(50);
      c.out.dbWhileWaiting = c.dbState();
      c.out.powerHeldWhileWaiting = held();
      let prevented = false;
      c.mainWin.emit('close', { preventDefault() { prevented = true; } });
      c.out.closeDialogs = c.syncDialogs();
      c.out.closePrevented = prevented;
      c.out.quitCallsAfterClose = c.quitCalls();
      c.answerDialog(0);
      c.out.ready = await c.waitFor(() => c.dbState() === 'ready', 10000);
      c.out.finalized = await c.waitFor(() => c.store.listPages().length >= 2 && !c.store.draftFiles().length, 8000);
      c.out.powerReleasedAfter = await c.waitFor(() => !held() && c.mainState() === 'idle', 8000);
    } },
  // 0.7.0 の前の直し（第2a1回 M-4 の点検で残したこと）: 窓 D0 を開いたまま録音を始め、録音の最中に［今は移さずに終える］。録音を途中で
  // 切らずに続け、平易な知らせを1回出す。録音を止めて下書きに書き終えたら終える（natsu.db は作らず、元の JSON もそのまま。下書きは
  // 2つの区間を持ったまま残り、次の起動で復旧する）
  'migrate-quit-recording': { engine: true, noDbWait: true, dialog: 'hold', quitEmits: true, env: { NATSU_TEST_MIGRATE_DELAY_MS: '200' },
    files: { 'settings.json': ({ base }) => JSON.stringify(base) },
    prepare: (ud) => { oldPages(ud, [1]); shaBefore = jsonShas(ud); },
    act: async (c) => {
      const hk = (await c.handlers['settings:get']()).meetingHotkey;
      c.out.dialogShown = await c.waitFor(() => c.dialogs().length === 1, 10000);
      await c.waitFor(() => c.mainState() === 'idle', 10000);
      c.shortcuts[hk]();   // 始める（窓 D0 は開いたまま）
      c.out.started = await c.waitFor(() => c.mainState() === 'meeting', 5000);
      const live = () => c.store.draftFiles().map((name) => ({ name, r: c.store.readDraftFile(name) }))
        .find((x) => x.r.state === 'ok' && typeof x.r.value.pageId === 'string' && x.r.value.pageId);
      const cur = live();
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: false });
      await c.waitFor(() => c.trace().some((t) => t.kind === 'draft' && cur && t.pageId === cur.r.value.pageId && t.segs >= 1), 4000);
      c.answerDialog(1);   // ［今は移さずに終える］
      await c.sleep(400);
      c.out.quitCallsWhileRecording = c.quitCalls();
      c.out.stillRecording = c.mainState() === 'meeting';
      c.shortcuts[hk]();   // 止める
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: true });
      c.out.quitAfterStop = await c.waitFor(() => c.quitCalls() >= 1, 8000);
      c.out.closed = await c.waitFor(() => c.quitCalls() >= 2 && c.dbState() === 'down', 10000);
      const kept = cur ? c.store.readDraftFile(cur.name) : null;
      c.out.draftSegs = kept && kept.state === 'ok' ? kept.value.segments.length : -1;
      c.out.jsonShaBefore = shaBefore;
      c.out.jsonShaAfter = jsonShas(c.userData);
    } },
  // 第2a1回 M-4 の点検で足した場面（下書きの復旧は1つずつ回す）: 起動のときは 0.6.0 の下書き（pageId が無い）を読めず、やり直しの
  // 時計が置かれる。窓 D0 を開いたまま（DB は移行の答え待ち）、そのやり直しが2つ重なって走る。並べて回すと、2つが同じ下書きを読んで
  // 別々の新しい ID で2つの「（復旧）」のページを作る
  'migrate-draft-retry-twice': { noDbWait: true, dialog: 'hold', env: { NATSU_TEST_MIGRATE_DELAY_MS: '200' },
    files: { 'settings.json': pretty(TYPICAL), 'data/draft.json': pretty(OLD_DRAFT) },
    faults: [{ op: 'read', match: /draft\.json$/, code: 'EBUSY', times: 7 }],   // 起動の1回の読み（1 + READ_WAITS の 6）だけ読めない
    prepare: (ud) => { oldPages(ud, [1]); },
    act: async (c) => {
      c.out.dialogShown = await c.waitFor(() => c.dialogs().length === 1, 10000);
      await c.waitFor(() => (c.timers.retryDraftRecovery || []).length > 0, 5000);
      const retry = (c.timers.retryDraftRecovery || [])[0];
      c.out.retries = (c.timers.retryDraftRecovery || []).length;
      const runs = retry ? [retry(), retry()] : [];
      await c.sleep(100);
      c.out.dbBefore = c.dbState();
      c.answerDialog(0);
      c.out.ready = await c.waitFor(() => c.dbState() === 'ready', 10000);
      await Promise.race([Promise.all(runs), c.sleep(8000)]);
      await c.sleep(50);
      c.out.draftsEnd = c.store.draftFiles();
    } },
  // 第2a1回 M-4（RF17。計画の外で足した場面）: 前の起動で移した後に、古い版（0.6.0）がページを1つ足し、壊れたページのファイルも1つ置いた。
  // 起動のたびの取り込みで入れて知らせ D5、飛ばしたファイルの組が前と変わったので知らせ D3
  'reimport-after-migrate': { files: { 'settings.json': pretty(TYPICAL) },
    prepare: (ud) => {
      const fs = require('node:fs');
      const path = require('node:path');
      oldPages(ud, [1, 1]);
      const r = require('../../src/db/migrate').migrate({ sqlite: require('node:sqlite'), dataDir: path.join(ud, 'data') });
      if (!r.ok) throw new Error(`場面の用意: 移せない（${r.code}）`);
      oldPages(ud, [2]);   // 古い版が後で書いたページ（ID は時刻と乱数で新しい）
      fs.writeFileSync(path.join(ud, 'data', 'pages', 'pbroken0002.json'), '{"id":"pbroken0002","title":"壊れ');
    } },
  // 第2a1回 M-4（D7。計画の外で足した場面）: 新しい版の NaTsu で作られた DB（user_version が大きい）は読むだけで開き、知らせ D7
  'db-newer': { files: { 'settings.json': pretty(TYPICAL) },
    prepare: (ud) => {
      const path = require('node:path');
      const sqlite = require('node:sqlite');
      oldPages(ud, [1]);
      const dataDir = path.join(ud, 'data');
      const r = require('../../src/db/migrate').migrate({ sqlite, dataDir });
      if (!r.ok) throw new Error(`場面の用意: 移せない（${r.code}）`);
      const db = new sqlite.DatabaseSync(path.join(dataDir, 'natsu.db'));
      try { db.exec('pragma user_version = 99'); } finally { db.close(); }
    },
    act: async (c) => { c.out.dbState = c.dbState(); } },
  // 第2a1回 M-4（ST9）: 手の空いたときだけ1日1回 daily の控えを取る。録音中に見ても取らない（見直しの時計を置く）。録音を締め、要約の
  // 試み（要約エンジンが無いので欄に理由を書くだけ）が済んでから見ると1回取り、同じ日にもう一度見ても取らない
  'snapshot-daily': { engine: true, files: { 'settings.json': ({ base }) => JSON.stringify(base) },
    act: async (c) => {
      const hk = (await c.handlers['settings:get']()).meetingHotkey;
      const checks = () => c.timers.checkDailySnapshot || [];
      c.out.scheduledAtStart = checks().length;
      c.shortcuts[hk]();
      await c.waitFor(() => c.mainState() === 'meeting', 5000);
      if (checks().length) await checks()[checks().length - 1]();
      c.out.snapshotKindsDuringMeeting = c.snapshotKinds();
      c.shortcuts[hk]();
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: true });
      await c.waitFor(() => { const p = c.store.listPages()[0]; return Boolean(p && c.store.getPage(p.id) && c.store.getPage(p.id).summaryError) && c.mainState() === 'idle'; }, 8000);
      await c.sleep(50);
      for (let i = 0; i < 2; i++) if (checks().length) await checks()[checks().length - 1]();
      c.out.snapshotKindsAfter = c.snapshotKinds();
    } },
  // 第2a1回 M-4（点検の申し送り。データの守り）: DB に入った後で保存の決まり（ブロックは 2,000 個まで）を超えたページ（画面の［行を足す］は
  // 数を見ない）に、要約の書き戻し（page.put）が bad-args で断られても、黙って飲まずに平易な文で知らせる
  'summary-bad-args': { files: { 'settings.json': pretty(TYPICAL),
      'data/pages/pbig000001.json': JSON.stringify({ id: 'pbig000001', title: '行の多い会議', blocks: Array.from({ length: 2000 }, (_, i) => ({ id: `b${i}`, type: 'bullet', text: `行 ${i}`, cites: [] })), memo: '', createdAt: '2026-10-01T00:00:00.000Z', summaryError: '' }),
      'data/transcripts/pbig000001.json': JSON.stringify({ id: 'pbig000001', segments: [] }) },
    act: async (c) => {
      c.out.inserted = Boolean(await c.appCall('block.insert', { pageId: 'pbig000001', afterBlockId: '', type: 'bullet' }));
      try { c.out.summary = await c.handlers['page:summarize']({}, 'pbig000001'); } catch (e) { c.out.summaryThrew = String((e && e.code) || (e && e.message) || e); }
      await c.sleep(50);
    } },
  // 第1c回 Task C-2: 設定のカード「オンライン」の IPC を main で本当に呼ぶ（Claude Code の場所が無いときの文・［PC の中だけ］は片道）。
  // Claude Code の場所は無いファイルに向ける（本物の claude を探しに行かない。子は起こさない）。
  // settings.json の cloudTranscribe・sttProvider は前の版が書いた値（読まれず、消されないことを見る）。
  // 第1d回 A-4（RL10・F11）で意図して変えた: 鍵の IPC（cloud:*）の受け口を消したので、鍵の保存・確かめ・消すと、前の版の groq・custom の鍵が
  // 残ることの場面を外した（Claude Code と［PC の中だけ］の部分だけを残す。受け口が無いことと前の版の鍵を起動で消すことは stage1d.ipc の old-keys）
  'cloud-ipc': { files: { 'settings.json': pretty({ ...TYPICAL, cloudTranscribe: 'off', sttProvider: 'groq', claudeExe: '/natsu-test-missing/claude.exe' }) },
    act: async (c) => {
      const h = (ch, ...a) => c.handlers[ch]({}, ...a);
      const o = c.out;
      // 前の版の画面が送っていた4つのキーは保存しない（settings.json には前の版の値が残る）
      o.saved = await h('settings:save', UI({ cloudTranscribe: 'on', sttProvider: 'custom', sttBaseUrl: 'https://stt.example/v1', sttModel: 'm', claudeExe: '/natsu-test-missing/claude.exe' }));
      o.settingsAfterSave = String(c.read('settings.json') || '');
      o.claude = await h('claude:status');
      o.claudeTest = await h('claude:test');
      o.localOnlyTrue = await h('meeting:set-local-only', true);
      o.localOnlyFalse = await h('meeting:set-local-only', false);
    } },
  // 第1d回 Task A-3（RL11・F5）: --relay=text。1回目の会議の1つ目の区間が中継で文字になった後に、D1 で札を取り消す（revoked_at）。
  // 2つ目の区間は中継が 401 login → 手元でやり直す。3つ目の区間は札が無いので中継へ送らない（同じ会議で「ログインしていない」を重ねない）。
  // 2回目の会議（区間 1 つ）も、札が消えたので中継へ何も送らない
  'relay-revoke': { relaySeed: true, engine: 'lazy', files: { 'settings.json': RELAY_BASE_SETTINGS },
    act: async (c) => {
      const o = c.out;
      const fileText = (rel) => { const b = c.read(rel); return b ? b.toString('utf8') : null; };
      o.secretsBefore = fileText('secrets.json');
      o.m1 = await relayMeeting(c, 3, { afterFirst: async () => {
        o.firstCloud = await c.waitFor(() => /区間 s1 → cloud\(relay\)/.test(logText(c)), 15000);
        await c.relay.revoke();
      } });
      o.secretsAfter = fileText('secrets.json');
      o.settingsAfter = fileText('settings.json');
      o.statusCloudAfter = c.handlers['meeting:status']().cloud;
      o.m2 = await relayMeeting(c, 1);
    } },
  // 第1d回 Task A-3（F5）: --relay=text。札 A を D1 で取り消し、文字起こしの要求を中継の前で 800 ミリ秒止めている間に、設定の画面と同じ IPC で
  // ログインし直す（札 B）。遅れて届いた A の 401 login で、しまった B を消さない。次の会議は B で中継へ送る
  'relay-relogin': { relaySeed: true, engine: 'lazy', files: { 'settings.json': RELAY_BASE_SETTINGS },
    act: async (c) => {
      const h = (ch, ...a) => c.handlers[ch]({}, ...a);
      const o = c.out;
      const fileText = (rel) => { const b = c.read(rel); return b ? b.toString('utf8') : null; };
      o.secretsBefore = fileText('secrets.json');
      await c.relay.revoke();
      c.relay.setFront('delay-stt');
      const M = c.relay.seededMail;
      o.m1 = await relayMeeting(c, 1, { afterFirst: async () => {
        o.start = await h('account:start', M);
        o.verify = await h('account:verify', M, c.relay.codeFor(M));
        o.secretsRelogin = fileText('secrets.json');
      } });
      o.secretsAfter = fileText('secrets.json');
      c.relay.setFront('');
      o.m2 = await relayMeeting(c, 1);
    } },
  // 第1d回 Task A-3（RL11）: --relay=daily-cap（1人の1日の上限 4 秒）。1回目の会議は 3 秒・2 秒・2 秒の区間で、2つ目が上限（scope user）。
  // 3つ目は hold の間なので中継へ何も送らない。11 分後の2回目の会議も、日が替わるまでの hold なので送らない（quota の 10 分とは違う）。
  // main と中継の時計を1日進めると、3回目の会議はクラウドに戻る
  'relay-day': { relaySeed: true, engine: 'lazy', files: { 'settings.json': RELAY_BASE_SETTINGS },
    act: async (c) => {
      const o = c.out;
      o.m1 = await relayMeeting(c, 3);
      c.advanceClock(11 * 60 * 1000);
      o.m2 = await relayMeeting(c, 1);
      c.advanceClock(24 * 3600 * 1000);
      o.m3 = await relayMeeting(c, 1);
    } },
  // 第1d回 Task A-3（RL11）: --relay=quota（OpenAI の残高なし → 中継は 503 quota）など。1回目の会議（区間 1 つ）で hold が付き、
  // 9 分後の2回目は中継へ何も送らず、さらに 2 分後（11 分後）の3回目はまた中継へ送る（hold は 10 分）
  'relay-hold': { relaySeed: true, engine: 'lazy', files: { 'settings.json': RELAY_BASE_SETTINGS },
    act: async (c) => {
      const o = c.out;
      o.m1 = await relayMeeting(c, 1);
      c.advanceClock(9 * 60 * 1000);
      o.m2 = await relayMeeting(c, 1);
      c.advanceClock(2 * 60 * 1000);
      o.m3 = await relayMeeting(c, 1);
    } },
  // 第1d回 Task A-2（RL10・RF32・F1）: ログインの IPC を main で本当に呼ぶ（mainrun の --relay で、本物の中継のコードを 127.0.0.1 で動かす）。
  // 1つの流れ: 設定を開く → コードを頼む → 違うコード → 正しいコード → 設定を開く・オフライン → 画面の保存 → ログアウト → もう一度ログイン
  // （全角の数字と空白のコード）→ 中継の前で切れた中のログアウトと start → ログインしていない logout → 形の悪いメールとコード →
  // ほかのドメイン → 頼んでいないメール → 止めたメール → 同じメールの 15 分の上限。どの account:status の前後でも中継への要求の数を見る
  'account-ipc': { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      const h = (ch, ...a) => c.handlers[ch]({}, ...a);
      const o = c.out;
      const r = c.relay;
      const M = r.mail('kaigi');
      const fileText = (rel) => { const b = c.read(rel); return b ? b.toString('utf8') : null; };
      const statusCalls = [];
      const status = async () => { const n = r.calls().length; const s = await h('account:status'); statusCalls.push(r.calls().length - n); return s; };
      const revoked = () => r.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NOT NULL').first('n');
      const wide = (code) => ` ${[...code].map((d) => String.fromCharCode(0xff10 + Number(d))).join('')} `;
      o.mail = M;
      o.status0 = await status();
      o.start = await h('account:start', M);
      o.code = r.codeFor(M);
      o.wrong = await h('account:verify', M, o.code === '000000' ? '111111' : '000000');
      o.verify = await h('account:verify', M, o.code);
      o.secretsRaw = fileText('secrets.json');
      // mainrun の偽の safeStorage の暗号（'ENC1:' + hex）を戻して、しまった札を取り出す（どこにも漏れていないかを試験が探す）
      try { o.token = Buffer.from(Buffer.from(JSON.parse(o.secretsRaw).keys.relay, 'base64').toString('latin1').slice(5), 'hex').toString('utf8'); } catch (_) { o.token = ''; }
      o.settingsAfter = fileText('settings.json');
      o.status1 = await status();
      c.setOnline(false);
      o.statusOffline = await status();
      c.setOnline(true);
      o.saveSpoof = await h('settings:save', UI({ accountEmail: r.mail('other') }));
      o.settingsAfterSpoof = fileText('settings.json');
      o.logout = await h('account:logout');
      o.revokedAfterLogout = await revoked();
      o.secretsAfterLogout = fileText('secrets.json');
      o.settingsAfterLogout = fileText('settings.json');
      o.status2 = await status();
      o.statusCalls = statusCalls;
      await h('account:start', M);
      o.code2 = r.codeFor(M);
      o.verify2 = await h('account:verify', ` ${M} `, wide(o.code2));
      o.verifyWide = o.verify2;
      r.setFront('drop');
      o.logoutDown = await h('account:logout');
      o.secretsAfterLogoutDown = fileText('secrets.json');
      o.settingsAfterLogoutDown = fileText('settings.json');
      o.startDown = await h('account:start', M);
      r.setFront('');
      let n = r.calls().length;
      o.logoutSignedOut = await h('account:logout');
      o.callsAtSignedOutLogout = r.calls().length - n;
      n = r.calls().length;
      o.startBad = await h('account:start', 'not-an-email');
      o.verifyBadCode = await h('account:verify', M, '12345');
      o.callsAtLocalRefusals = r.calls().length - n;
      o.startDomain = await h('account:start', r.mail('a', 'other.example'));
      o.verifyExpired = await h('account:verify', r.mail('nobody'), '123456');
      const B = r.mail('tome');
      await r.db.prepare('INSERT INTO blocked_emails (email, at) VALUES (?1, ?2)').bind(B, 0).run();
      await h('account:start', B);
      o.verifyBlocked = await h('account:verify', B, r.codeFor(B));
      await h('account:start', M);
      o.rate = await h('account:start', M);
      o.relayCalls = r.calls();
    } },
  // 同じ流れの、暗号にできない PC（mainrun の --no-store: 偽の safeStorage の isAsyncEncryptionAvailable が false）。
  // settings.json には前のログインのメールだけが残っている（札は無い: ログインしていない形で、メールは返さない）
  'account-ipc-nostore': { files: { 'settings.json': pretty({ ...TYPICAL, accountEmail: require('./relay-run').mail('mae') }) },
    act: async (c) => {
      const h = (ch, ...a) => c.handlers[ch]({}, ...a);
      const o = c.out;
      const r = c.relay;
      const M = r.mail('kaigi');
      const fileText = (rel) => { const b = c.read(rel); return b ? b.toString('utf8') : null; };
      o.status0 = await h('account:status');
      o.start = await h('account:start', M);
      o.verify = await h('account:verify', M, r.codeFor(M));
      o.secretsRaw = fileText('secrets.json');
      o.settingsAfter = fileText('settings.json');
      o.relayCalls = r.calls();
      o.revoked = await r.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE revoked_at IS NOT NULL').first('n');
      o.status1 = await h('account:status');
    } },
  // 第1d回 Task A-4（F11・K2）: 起動のときに 0.7.0 までの鍵（--old-keys が置く groq・openai・custom と退けた控え）を purgeOld で消す。
  // ログインの札（種をまいた relay）は残る。鍵の IPC（cloud:*）の受け口は無く、ログインの IPC（account:*）はある
  'old-keys': { relaySeed: true, files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      const o = c.out;
      const b = c.read('secrets.json');
      o.secretsRaw = b ? b.toString('utf8') : null;
      o.cloudHandlers = Object.keys(c.handlers).filter((k) => k.startsWith('cloud:')).sort();
      o.accountHandlers = Object.keys(c.handlers).filter((k) => k.startsWith('account:')).sort();
      o.status = await c.handlers['account:status']({});
    } },
  // 第1c回 Task C-2 の直し: ［この会議は PC の中だけ］の IPC は片道（RF28）。会議の外と、会議中に true の後で false を送る。
  // 同意は既定（ask）のまま: 会議の始めに外へ聞きに行かない
  'local-only-ipc': { engine: true, files: { 'settings.json': ({ base }) => JSON.stringify(base) },
    act: async (c) => {
      const h = (ch, ...a) => c.handlers[ch]({}, ...a);
      const draft = () => { try { return JSON.parse(c.read('data/draft.json').toString('utf8')).localOnly; } catch (_) { return null; } };
      const o = c.out;
      o.idleTrue = await h('meeting:set-local-only', true);
      o.idleFalse = await h('meeting:set-local-only', false);
      o.start = await h('meeting:toggle');
      o.draftAtStart = draft();
      o.falseBefore = await h('meeting:set-local-only', false);
      o.draftAfterFalseBefore = draft();
      o.on = await h('meeting:set-local-only', true);
      o.draftAfterOn = draft();
      o.off = await h('meeting:set-local-only', false);
      o.offAgain = await h('meeting:set-local-only', 'false');
      o.draftAfterOff = draft();
      o.discard = await h('meeting:discard');
    } },
  // 第1c回 合流（B3・C2）: 設定の［Claude Code を確かめる］（claude:status）を偽の claude（helpers/fake-claude.js）で通す。
  // claude: true の場面は mainrun の spawn が偽の claude と userData の claude-noexec.exe だけを本当に起こす（ほかは起こさない）。
  // auth status の答え方は FAKE_CLAUDE_AUTH（子を起こすときの process.env）で変える。-p は呼ばない
  'claude-status': { claude: true,
    files: { 'settings.json': pretty({ ...TYPICAL, claudeExe: require('node:path').join(__dirname, 'fake-claude.js') }) },
    act: async (c) => {
      const p = require('node:path');
      const fs = require('node:fs');
      const h = (ch, ...a) => c.handlers[ch]({}, ...a);
      const logFile = p.join(c.userData, '..', 'claude-status.log');
      process.env.FAKE_CLAUDE_LOG = logFile;
      const lines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
      const o = c.out;
      process.env.FAKE_CLAUDE_AUTH = 'claude.ai';
      process.env.FAKE_CLAUDE_MODE = 'ok';
      o.ok = await h('claude:status');
      o.authBeforeBoth = lines().length;
      o.both = await Promise.all([h('claude:status'), h('claude:test')]);
      o.authAfterBoth = lines().length;
      // 第1b回の続き Lane F-b: ［Claude Code を確かめる］は auth status の後に小さな -p を1つ送る。同時に2回押しても子は auth と -p の1つずつ
      o.linesBeforeTwice = lines().length;
      o.twice = await Promise.all([h('claude:test'), h('claude:test')]);
      o.linesAfterTwice = lines().length;
      process.env.FAKE_CLAUDE_MODE = 'expired401';   // 利用者の PC の 0.5.0: auth status は claude.ai、-p だけが 401
      o.expiredStatus = await h('claude:status');
      o.expired = await h('claude:test');
      process.env.FAKE_CLAUDE_MODE = 'limit';
      o.limited = await h('claude:test');
      process.env.FAKE_CLAUDE_MODE = 'overloaded';   // 混み合い（ログインはできている）
      o.overloaded = await h('claude:test');
      process.env.FAKE_CLAUDE_MODE = 'ok';
      process.env.FAKE_CLAUDE_AUTH = 'none';
      o.notLogged = await h('claude:test');
      process.env.FAKE_CLAUDE_AUTH = 'api_key';
      o.apiKey = await h('claude:test');
      process.env.FAKE_CLAUDE_AUTH = 'mystery';
      o.unknown = await h('claude:test');
      o.claudeLog = lines();
      // 確かめの要求の時間切れと、auth status は通ったのに -p を起こせない。main が呼ぶ claude-cli の claudePing を、この間だけ
      // 短い時間切れ（60 秒は待たない）か、起こすと投げる spawn で包む（文は main の 60 秒のまま）。偽の claude の記録の数は上で取った
      const cli = require('../../src/claude-cli');
      const realPing = cli.claudePing;
      process.env.FAKE_CLAUDE_AUTH = 'claude.ai';
      try {
        process.env.FAKE_CLAUDE_MODE = 'slow';
        process.env.FAKE_CLAUDE_DELAY = '20000';
        cli.claudePing = (a) => realPing({ ...a, timeoutMs: 300 });
        o.pingTimeout = await h('claude:test');
        process.env.FAKE_CLAUDE_MODE = 'ok';
        cli.claudePing = (a) => realPing({ ...a, spawn: () => { const e = new Error('spawn ENOENT'); e.code = 'ENOENT'; throw e; } });
        o.pingNotFound = await h('claude:test');
      } finally {
        cli.claudePing = realPing;
        delete process.env.FAKE_CLAUDE_DELAY;
        process.env.FAKE_CLAUDE_MODE = 'ok';
      }
      const noexec = p.join(c.userData, 'claude-noexec.exe');
      fs.writeFileSync(noexec, 'not a program\n');
      fs.chmodSync(noexec, 0o644);
      o.savedNoexec = await h('settings:save', UI({ claudeExe: noexec }));
      o.noexec = await h('claude:test');
    } },
  // 第1b回の続き Lane F-c・F-d: ［Claude Code にログイン］［Claude Code を入れる］。claude.exe は userData の bin の空のファイル（mainrun が
  // 偽の claude を node で起こす）。見える窓を開く powershell.exe は mainrun が本当には起こさず覚えるだけ（launches）。窓を開く間だけ
  // process.platform を win32 と読ませる（Windows のほかでは窓を開かない: claude-cli.test.js が見る）
  'claude-window': { claude: true,
    files: { 'bin/claude.exe': '', 'settings.json': ({ userData }) => pretty({ ...TYPICAL, claudeExe: require('node:path').join(userData, 'bin', 'claude.exe') }) },
    act: async (c) => {
      const p = require('node:path');
      const fs = require('node:fs');
      const h = (ch, ...a) => c.handlers[ch]({}, ...a);
      const logFile = p.join(c.userData, '..', 'claude-window.log');
      process.env.FAKE_CLAUDE_LOG = logFile;
      process.env.FAKE_CLAUDE_AUTH = 'claude.ai';
      process.env.FAKE_CLAUDE_MODE = 'ok';
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test-window';
      const lines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
      const o = c.out;
      const real = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        o.login = await h('claude:login');
        o.linesAfterLogin = lines().map((l) => l.kind);
        o.both = await Promise.all([h('claude:login'), h('claude:install')]);   // 窓は1つずつ（2つ目は busy）
        o.install = await h('claude:install');
        c.launchPlan.push(1);
        o.failed = await h('claude:install');
        o.savedMissing = await h('settings:save', UI({ claudeExe: p.join(c.userData, 'bin', 'none.exe') }));
        o.loginMissing = await h('claude:login');
        o.launches = c.launches.slice();
      } finally {
        Object.defineProperty(process, 'platform', { value: real, configurable: true });
        delete process.env.ANTHROPIC_API_KEY;
      }
    } },
  // 第1b回 Task A-2: 画面の覚え書き（N6・RF21・RF22・F1〜F4・F7）
  'ws-none': { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => { c.out.ui = await c.handlers['ui:get']({}); } },
  'ws-restore': { files: { 'settings.json': pretty(TYPICAL),
      'data/pages/pkeep1.json': JSON.stringify({ id: 'pkeep1', title: '定例（見本）', blocks: [], createdAt: '2026-10-01T00:00:00.000Z' }) },
    local: { [WS_FILE]: WS({ maximized: true, zoom: 1.5, sidebar: { width: 300, collapsed: true }, tabs: { open: ['page:pkeep1', 'page:pgone', 'live', 'dictation'], active: 'dictation' } }) },
    act: async (c) => {
      c.mainWin.webContents.emit('did-finish-load');
      c.out.ui = await c.handlers['ui:get']({});
    } },
  'ws-offscreen': { files: { 'settings.json': pretty(TYPICAL) },
    local: { [WS_FILE]: WS({ bounds: { x: 3000, y: 100, width: 1000, height: 700 } }) } },
  'ws-minimized': { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      const w = c.mainWin;
      w.normal = { x: 300, y: 200, width: 1000, height: 700 };
      w.bounds = { x: -32000, y: -32000, width: 160, height: 28 };   // 最小化中の getBounds
      w.minimized = true;
      w.emit('move');
      c.power.emit('suspend');
    } },
  'ws-batch': { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      const w = c.mainWin;
      w.normal = { x: 400, y: 300, width: 1200, height: 800 }; w.emit('move');
      w.normal = { x: 420, y: 330, width: 1200, height: 800 }; w.emit('move');
      c.out.before = wsText(c);
      c.power.emit('suspend');
      c.out.after = wsText(c);   // 受け口が返った直後（同じ手番の中）に読む
    } },
  'ws-zoom': { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      const wc = c.mainWin.webContents;
      const prevented = [];
      const key = (k, o = {}) => {
        const input = { type: 'keyDown', key: k, code: '', control: true, meta: false, alt: false, shift: false, ...o };
        wc.emit('before-input-event', { preventDefault: () => prevented.push(input.key) }, input);
      };
      key('='); key('='); key(';'); key('-'); key('0'); key('p'); key('+', { code: 'NumpadAdd' });
      for (let i = 0; i < 12; i++) wc.emit('zoom-changed', {}, 'in');
      c.app.emit('will-quit', { preventDefault() {} });
      c.out.prevented = prevented;
    } },
  'ws-unreadable': { files: { 'settings.json': pretty(TYPICAL) },
    local: { [WS_FILE]: WS() },
    faults: [{ op: 'read', match: /window-state\.json$/, code: 'EBUSY', times: Infinity }],
    act: async (c) => {
      c.out.localBefore = WS();
      const w = c.mainWin;
      w.normal = { x: 500, y: 400, width: 1000, height: 700 }; w.emit('move');
      c.out.set = await c.handlers['ui:set']({}, { sidebar: { width: 320, collapsed: true } });
      c.power.emit('suspend');
    } },
  'ws-broken': { files: { 'settings.json': pretty(TYPICAL) },
    local: { [WS_FILE]: '{"v":1,"bou',
      ...Object.fromEntries([1, 2, 3, 4].map((d) => [`${WS_FILE}.broken-2026-10-0${d}T00-00-00-000Z`, WS()])) } },
  'ws-ui-set': { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      c.out.set = await c.handlers['ui:set']({}, { sidebar: { width: 9999, collapsed: 1 }, tabs: { open: ['live', 'settings', 'page:../x'], active: 'live' } });
      c.power.emit('suspend');
    } },
  // 点検で足した場面: 前回の書きかけで残った覚え書きの一時ファイルは起動で消す（本体の覚え書きは残す）
  'ws-temps': { files: { 'settings.json': pretty(TYPICAL) },
    local: { [WS_FILE]: WS(), [`${WS_FILE}.4242-k3j9ab.tmp`]: 'x', [`${WS_FILE}.tmp`]: 'x' } },
  // 第1b回 Task A-3: ページからの一時停止・止めていた時間の印・スリープ（N4c・RF4・F5・F6）。録音バーは mainrun の偽物（overlayPause）
  'pause-page': { engine: true, files: { 'settings.json': ({ base }) => JSON.stringify(base) },
    act: async (c) => {
      const o = c.out;
      const status = () => c.handlers['meeting:status']({});
      o.start = await c.handlers['meeting:toggle']({});
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: false });
      const realNow = Date.now;
      let now = realNow();
      Date.now = () => now;   // 止めていた長さをちょうど 2 秒にする
      try {
        o.ask1 = await c.handlers['meeting:set-paused']({}, true);
        o.ask2 = await c.handlers['meeting:set-paused']({}, true);   // 頼んでいる途中なので押さない
        await c.waitFor(() => status().paused === true);
        // 頼んだ印は返事が来たときに下ろす（3 秒の上限を待たない）。Date.now を止めているので waitFor の期限は切れない → sleep で見る
        await c.sleep(30);
        if (status().pausing) throw new Error('返事が来ても頼んだ印が下りない');
        o.ask2b = await c.handlers['meeting:set-paused']({}, true);   // もう止まっていて頼んでいる途中でもない → 同じ状態なので押さない
        if (o.ask2b.pending) throw new Error('止まっているのに一時停止をまた頼んだ');
        now += 2000;
        o.ask3 = await c.handlers['meeting:set-paused']({}, false);
        await c.waitFor(() => status().paused === false && status().pauses.length === 1);
      } finally { Date.now = realNow; }
      try { o.draftPauses = JSON.parse(c.read('data/draft.json').toString('utf8')).pauses; } catch (_) { o.draftPauses = null; }
      o.status = status();
      o.stop = await c.handlers['meeting:toggle']({});
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(2)), durationMs: 2000, final: true });
      await c.waitFor(() => c.store.listPages().length >= 1);
      const id = c.store.listPages()[0].id;
      o.page = { ...c.store.getPage(id), segments: c.store.getTranscript(id) };
    } },
  'suspend-meeting': { engine: true, files: { 'settings.json': ({ base }) => JSON.stringify(base) },
    act: async (c) => {
      const status = () => c.handlers['meeting:status']({});
      c.out.start = await c.handlers['meeting:toggle']({});
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: false });
      c.power.emit('suspend');
      await c.waitFor(() => status().paused === true);
      c.power.emit('resume');
      await c.sleep(50);
      c.out.status = status();
    } },
  'suspend-lost': { engine: true, overlayPause: 'lost-once', files: { 'settings.json': ({ base }) => JSON.stringify(base) },
    act: async (c) => {
      const status = () => c.handlers['meeting:status']({});
      c.out.start = await c.handlers['meeting:toggle']({});
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: false });
      c.power.emit('suspend');
      await c.sleep(100);   // 返事は来ない（眠る前に届かなかった）
      c.out.pausedBeforeResume = status().paused;
      c.power.emit('resume');
      await c.waitFor(() => status().paused === true);
      await c.sleep(50);
      c.out.status = status();
    } },
  'suspend-late': { engine: true, overlayPause: 'late', files: { 'settings.json': ({ base }) => JSON.stringify(base) },
    act: async (c) => {
      const status = () => c.handlers['meeting:status']({});
      c.out.start = await c.handlers['meeting:toggle']({});
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: false });
      c.power.emit('suspend');   // 偽の録音バーは止まるが、返事はまだ
      await c.sleep(50);
      c.power.emit('resume');    // main は止まっていないと見て頼み直す
      await c.sleep(50);
      c.releasePause();          // 遅れた返事が届く
      await c.waitFor(() => status().paused === true);
      await c.sleep(50);
      c.out.status = status();
    } },
  // 点検で足した場面: スリープを2回。再開した後のはぐれた resume で止めない（suspendAsked を下ろす）・知らせ R1 は会議ごとに1回
  'suspend-twice': { engine: true, files: { 'settings.json': ({ base }) => JSON.stringify(base) },
    act: async (c) => {
      const status = () => c.handlers['meeting:status']({});
      c.out.start = await c.handlers['meeting:toggle']({});
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: false });
      c.power.emit('suspend');
      await c.waitFor(() => status().paused === true);
      c.power.emit('resume');
      await c.sleep(50);
      c.out.resume = await c.handlers['meeting:set-paused']({}, false);
      await c.waitFor(() => status().paused === false && !status().pausing);
      c.power.emit('resume');   // はぐれた復帰の合図（スリープを頼んでいない）
      await c.sleep(100);
      c.out.afterStray = status().paused;
      c.power.emit('suspend');
      await c.waitFor(() => status().paused === true);
      c.power.emit('resume');
      await c.sleep(50);
      c.out.status = status();
    } },
  // 点検で足した場面: 締めている間（meeting-finalizing。meeting はまだある）のスリープでは何も押さない
  'suspend-finalizing': { engine: true, files: { 'settings.json': ({ base }) => JSON.stringify(base) },
    act: async (c) => {
      c.out.start = await c.handlers['meeting:toggle']({});
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(3)), durationMs: 3000, final: false });
      c.out.stop = await c.handlers['meeting:toggle']({});
      c.out.stateAtSuspend = c.handlers['meeting:status']({}).finalizing;
      c.power.emit('suspend');
      c.power.emit('resume');
      await c.sleep(50);
      c.listeners['audio:segment']({}, { buffer: new Uint8Array(c.toneWav(2)), durationMs: 2000, final: true });
      await c.waitFor(() => c.store.listPages().length >= 1);
    } },
  'suspend-idle': { files: { 'settings.json': pretty(TYPICAL) },
    act: async (c) => {
      c.power.emit('suspend');
      c.power.emit('resume');
      await c.sleep(50);
    } },
  'pause-recover': { files: { 'settings.json': pretty(TYPICAL),
      'data/draft.json': JSON.stringify({ ...OLD_DRAFT, pauses: [{ atMs: 3000, ms: 125000, why: 'suspend' }, { atMs: 'x' }] }) },
    act: async (c) => {
      await c.waitFor(() => c.store.listPages().length >= 1);
      const id = c.store.listPages()[0].id;
      c.out.page = { ...c.store.getPage(id), segments: c.store.getTranscript(id) };
    } },
};
