'use strict';
// json-scenes.js — 第1a回の保存の守りを、main.js を偽の Electron の上で動かして確かめる場面（helpers/mainrun.js の --json-scene=名前）
//   files:   userData からの相対パス → 中身（文字列か Buffer。関数なら { base, userData } を受け取る。base は mainrun が決めたエンジンのパスとポート）
//   faults:  helpers/faulty-fs.js の rules（main・store・jsonfile が読む fs にだけ効く）
//   engine:  真なら偽の文字起こしエンジンを設定に入れて起こす（既定は起こさない）
//   env:     main.js を読む前に入れる環境変数
//   prepare: userData を受け取り、置いた後に手を入れる（読み取り専用にする等）
//   act:     起動の後にすること（ctx は mainrun.js の頭の注釈）
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

module.exports = {
  TYPICAL, HISTORY, UI,
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
};
