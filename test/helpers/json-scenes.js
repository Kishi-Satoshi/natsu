'use strict';
// json-scenes.js — 第1a回の保存の守りを、main.js を偽の Electron の上で動かして確かめる場面（helpers/mainrun.js の --json-scene=名前）
//   files:   userData からの相対パス → 中身（文字列か Buffer。関数なら { base, userData } を受け取る。base は mainrun が決めたエンジンのパスとポート）
//   faults:  helpers/faulty-fs.js の rules（main・store・jsonfile が読む fs にだけ効く）
//   dbDelayMs: main の db.call の答えを毎回この分（ミリ秒）だけ遅らせる（json-backend はほぼ同期で答えるため。第2a1回 M-1）
//   engine:  真なら偽の文字起こしエンジンを設定に入れて起こす（既定は起こさない）
//   env:     main.js を読む前に入れる環境変数
//   prepare: userData を受け取り、置いた後に手を入れる（読み取り専用にする等）
//   act:     起動の後にすること（ctx は mainrun.js の頭の注釈）
//   local:   %LOCALAPPDATA%（mainrun の一時フォルダ）からの相対パス → 中身（第1b回 Task A-2。画面の覚え書き natsu/window-state.json）
//   displays: 偽の screen.getAllDisplays() の並び（無ければ 1920×1080 が1つ。作業領域は 1920×1040）
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
const wsText = (c) => { const b = c.readLocal(WS_FILE); return b ? b.toString('utf8') : null; };

module.exports = {
  TYPICAL, HISTORY, UI, OLD_DRAFT, WS,
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
      c.out.titles = c.store.listPages().map((p) => p.title);
      c.out.draftsAfter = c.store.draftFiles();
    } },
  // 下書きから復旧したページを保存できない（ページの一時ファイルを開けない）。下書きは消さず、記録には理由の符号だけを書く
  'draft-page-fail': { files: { 'settings.json': pretty(TYPICAL), 'data/draft.json': JSON.stringify(OLD_DRAFT) },
    faults: [{ op: 'open', match: /pages[\\/][^\\/]+\.json\.\d+-[0-9a-z]+\.tmp$/, code: 'EACCES', times: Infinity }] },
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
    act: async (c) => { c.out.retries = (c.timers.retryDraftRecovery || []).length; for (const f of c.timers.retryDraftRecovery || []) f(); } },
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
      c.out.titles = c.store.listPages().map((p) => p.title);
      c.out.draftsAfter = c.store.draftFiles();
    } },
  // 第2a1回 M-1（ST1）: 要約の途中で終了する。要約エンジンは起こそうとしても応えない（偽の子。/health に誰も居ない）ので要約は終わらない。
  // before-quit は1回だけ止め、「要約が中断されました」をページに書いてから app.quit() を呼ぶ。2回目の before-quit は止めずにエンジンを止める
  // db.call の答えは 30ms 遅らせる（json-backend は書き込みをほぼ同期で済ませ、待たずに app.quit() を呼んでも間に合ってしまう）
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
  // 壊れたページ（p1）と、ページは無事で文字起こしだけ壊れたページ（p2）。起動の reconcile か、開いたときに退けて知らせる
  'page-files-broken': { files: { 'settings.json': pretty(TYPICAL),
      'data/pages/p1.json': '{"id":"p1","title":"壊れ', 'data/transcripts/p1.json': '{"id":"p1","segments":[]}',
      'data/pages/p2.json': JSON.stringify({ id: 'p2', title: '文字起こしが壊れた会議', blocks: [], createdAt: '2026-10-01T00:00:00.000Z' }),
      'data/transcripts/p2.json': '{"id":"p2","segments":[{"text":"途中' },
    act: async (c) => { c.out.p1 = await c.handlers['page:get']({}, 'p1'); c.out.p2 = await c.handlers['page:get']({}, 'p2'); } },
  // 第1c回 Task C-2: 設定のカード「オンライン」の IPC を main で本当に呼ぶ（鍵は画面へ返さない・secrets.json は暗号の形・
  // ［鍵を確かめる］は 127.0.0.1 の偽の送り先の /models へ・Claude Code の場所が無いときの文・［PC の中だけ］は片道）。
  // Claude Code の場所は無いファイルに向ける（本物の claude を探しに行かない。子は起こさない）
  // 0.7.0 U-1（設計書 D5）: 送り先は OpenAI に固定。https://api.openai.com/v1 への要求は setOpenAiBase で 127.0.0.1 の偽の口へ書き換える。
  // settings.json の cloudTranscribe・sttProvider は前の版が書いた値（読まれず、消されないことを見る）
  'cloud-ipc': { files: { 'settings.json': pretty({ ...TYPICAL, cloudTranscribe: 'off', sttProvider: 'groq', claudeExe: '/natsu-test-missing/claude.exe' }) },
    act: async (c) => {
      const KEY = 'gsk_test_0123456789';
      const h = (ch, ...a) => c.handlers[ch]({}, ...a);
      const seen = [];
      const seenF = [];   // 第1b回の続き Lane F-e の鍵（下の FKEYS）への要求
      // Lane F-e: 鍵ごとの答え方。scope は OpenAI の制限付きの鍵（一覧は 401 の権限の文、文字起こしは通る）、quota は残高なし、invalid は鍵の誤り
      const FKEYS = { 'gsk_scope_00000000': 'scope', 'gsk_quota_00000000': 'quota', 'gsk_invalid_0000000': 'invalid' };
      const srv = require('node:http').createServer((req, res) => {
        const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
        const f = FKEYS[bearer];
        if (f) {
          seenF.push({ method: req.method, url: req.url, kind: f });
          req.resume();
          const send = (st, body) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
          if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') { if (f === 'scope') send(200, { text: '' }); else send(401, { error: { code: 'invalid_api_key' } }); return; }
          if (f === 'scope') send(401, { error: { message: 'You have insufficient permissions for this operation. Missing scopes: api.model.read.', type: 'invalid_request_error', param: null, code: null } });
          else if (f === 'quota') send(429, { error: { message: 'You exceeded your current quota.', type: 'insufficient_quota', code: 'insufficient_quota' } });
          else send(401, { error: { message: `Incorrect API key provided: ${bearer}`, type: 'invalid_request_error', code: 'invalid_api_key' } });
          return;
        }
        const ok = req.headers.authorization === `Bearer ${KEY}`;
        seen.push({ method: req.method, url: req.url, auth: ok });
        res.statusCode = ok ? 200 : 401;
        res.end('{"data":[]}');
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const o = c.out;
      try {
        c.setOpenAiBase(`http://127.0.0.1:${srv.address().port}/v1`);
        o.status0 = await h('cloud:status');
        o.badId = await h('cloud:set-key', 'evil', KEY);
        // 0.7.0 U-1: groq・custom の名前は画面から届かない（main も断る）
        o.badOther = [await h('cloud:set-key', 'groq', KEY), await h('cloud:test-key', 'groq'), await h('cloud:clear-key', 'custom'), await h('cloud:test-key', 'custom')];
        o.badKey = await h('cloud:set-key', 'openai', 'short');
        o.testNoKey = await h('cloud:test-key', 'openai');
        o.set = await h('cloud:set-key', 'openai', ` ${KEY} `);
        o.status1 = await h('cloud:status');
        o.secretsAfterSet = String(c.read('secrets.json') || '');
        // 前の版の画面が送っていた4つのキーは保存しない（settings.json には前の版の値が残る）
        o.saved = await h('settings:save', UI({ cloudTranscribe: 'on', sttProvider: 'custom', sttBaseUrl: 'https://stt.example/v1', sttModel: 'm', claudeExe: '/natsu-test-missing/claude.exe' }));
        o.settingsAfterSave = String(c.read('settings.json') || '');
        o.testOk = await h('cloud:test-key', 'openai');
        o.setWrong = await h('cloud:set-key', 'openai', 'gsk_wrong_00000000');
        o.testAuth = await h('cloud:test-key', 'openai');
        for (const [name, k] of [['testScope', 'gsk_scope_00000000'], ['testQuota', 'gsk_quota_00000000'], ['testInvalid', 'gsk_invalid_0000000']]) {
          await h('cloud:set-key', 'openai', k);
          o[name] = await h('cloud:test-key', 'openai');
        }
        o.seenF = seenF;
        await h('cloud:set-key', 'openai', 'gsk_wrong_00000000');
        o.statusKeyed = await h('cloud:status');
        o.clear = await h('cloud:clear-key', 'openai');
        o.statusCleared = await h('cloud:status');
        o.claude = await h('claude:status');
        o.claudeTest = await h('claude:test');
        o.localOnlyTrue = await h('meeting:set-local-only', true);
        o.localOnlyFalse = await h('meeting:set-local-only', false);
        o.seen = seen;
      } finally {
        await new Promise((r) => srv.close(r));
      }
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
