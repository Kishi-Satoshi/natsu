/*
 * settings-rules.test.js — 設定の決まり（第1a回 JS6。RF23・F8・F11）
 * 31 のキーの表（第1a回の 30 に第1c回 Task C-1 で5つ足し、0.7.0 U-1（設計書 D5）で送り先と同意の4つを外し、第1d回 A-2 で accountEmail を足し、
 * 0.9.0 O-1（設計書 D25）で pillPos・pillCustom を外して pillSlot を足した）・項目ごとの読み方・今の読み方（normalizeSettings({ ...既定, ...raw }, 既定)）との比べ・保存の許可の一覧。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/settings');

const D = S.defaultSettings(8);   // スレッド数は Math.max(4, 8 - 2) = 6
const T = 6;
// 今の main.js:77-120 の DEFAULT_SETTINGS を写したもの（第1a回の時点の正）
const TODAY = {
  localServerExe: '', localModelPath: '', localPort: 8990, localThreads: T, vadModelPath: '', useVad: true, suppressNst: true,
  sumServerExe: '', sumModelPath: '', sumPort: 8991, sumThreads: T, language: 'ja', hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M',
  micId: '', pillPos: 'bottom', pillCustom: null, autoPaste: true, removeFillers: true, soundFeedback: true, autoLaunch: false,
  theme: 'system', stayInTray: false, dictionary: [], useBuiltinTerms: true, useSystemAudio: false, maxHistory: 500, segmentSec: 75,
  sumCtx: 16384, engineIdleMin: 10,
};
// 第1a回の画面（app.html の save）が送る 29 のキー（第1c回 Task C-2 で下の5つを足して 34。pillCustom は録音バーを動かしたときだけ main が書く）
const UI = { ...TODAY, localServerExe: 'C:\\e\\w.exe', localModelPath: 'C:\\m\\g.bin', theme: 'dark', micId: 'mic-1', dictionary: ['見積', '検収'] };
delete UI.pillCustom; delete UI.maxHistory;
// 0.9.0 O-1（設計書 D25・RP1）で意図して変えた: 録音バーの pillPos・pillCustom を表と既定から外し、8つの置き場所の pillSlot（既定 bottom-center）を
// 足した（31 のキー）。画面は pillPos の代わりに pillSlot を送る（O-4 で画面の欄を替える）
delete TODAY.pillPos; delete TODAY.pillCustom; Object.assign(TODAY, { pillSlot: 'bottom-center' });
delete UI.pillPos; Object.assign(UI, { pillSlot: 'top-right' });
// 第1c回 Task C-1: TODAY に足す（ほかの 30 は変えない）。意図: 既定が今の値のまま・決まりのないキーを足せない
// 0.7.0 U-1（設計書 D5）で意図して変えた: 送り先と同意の4つ（cloudTranscribe・sttProvider・sttBaseUrl・sttModel）は表と既定から外した（31 のキー）
Object.assign(TODAY, { claudeExe: '' });
// 第1d回 A-2（RL10）で意図して変えた: ログイン中のメールアドレス accountEmail を足した（32 のキー。既定 ''）。画面は送らない（main が書く）
Object.assign(TODAY, { accountEmail: '' });
// 第1c回 Task C-2: 画面のカード「オンライン」が送るキー（0.7.0 U-1 で claudeExe だけ。30 のキー）。既定でない値で往復することを見る
Object.assign(UI, { claudeExe: 'C:\\c\\claude.exe' });
const legacy = (raw) => S.normalizeSettings({ ...D, ...raw }, D);
const ON = (key, v) => (key === 'useBuiltinTerms' ? v !== false : Boolean(v));
const BOOLS = ['useVad', 'suppressNst', 'autoPaste', 'removeFillers', 'soundFeedback', 'autoLaunch', 'stayInTray', 'useBuiltinTerms', 'useSystemAudio'];

test('JS6: 決まりの表のキーは既定の 31 のキーとちょうど同じ。どれにも画面の名前がある', { timeout: 5000 }, () => {
  assert.deepStrictEqual(D, TODAY);
  assert.strictEqual(S.SETTING_KEYS.length, 31);
  assert.deepStrictEqual([...S.SETTING_KEYS].sort(), Object.keys(TODAY).sort());
  for (const k of S.SETTING_KEYS) assert.ok(typeof S.SETTING_RULES[k].label === 'string' && S.SETTING_RULES[k].label.length > 1, k);
  assert.strictEqual(S.defaultSettings(2).localThreads, 4);
  assert.ok(!('dataDir' in D));
});

test('JS6: 無いキーは黙って既定で埋める（版を上げたときのふつうのこと）。今の画面が書く値はそのまま往復する', { timeout: 5000 }, () => {
  // 0.9.0 O-1: pillSlot の無い raw には前の位置の読み pillFrom が付く（何も無ければ point も pos も null）
  assert.deepStrictEqual(S.readSettings({}, D), { settings: D, repaired: [], falseLike: [], pillFrom: { point: null, pos: null } });
  const r = S.readSettings(JSON.parse(JSON.stringify({ ...UI, pillCustom: { x: 10, y: 20 }, maxHistory: 300 })), D);
  assert.deepStrictEqual(r.repaired, []);
  assert.deepStrictEqual(r.settings, { ...D, ...UI, pillCustom: { x: 10, y: 20 }, maxHistory: 300 });
  assert.strictEqual(r.pillFrom, null);
});

test('JS6・RF23: 壊れた項目だけを直し、ほかは残す（キーごとの表）', { timeout: 5000 }, () => {
  const rows = [
    // [キー, 書かれていた値, 読んだ値, repaired の why（null は直していない）]
    ['localPort', '8080', 8080, null], ['localPort', 99999, 65535, 'range'], ['localPort', 'abc', 8990, 'type'],
    ['localPort', 1023, 1024, 'range'], ['localPort', 1024, 1024, null], ['localPort', 65535, 65535, null], ['sumPort', 65536, 65535, 'range'],
    ['localThreads', 0, T, 'range'], ['segmentSec', 5, 20, 'range'], ['sumCtx', 32768, 32768, null], ['engineIdleMin', 0, 0, null],
    ['maxHistory', '300', 300, null], ['maxHistory', 0, 0, null], ['maxHistory', 20000, 10000, 'range'],
    ['maxHistory', -1, 500, 'range'], ['maxHistory', 1.5, 500, 'type'], ['maxHistory', 'abc', 500, 'type'],
    ['localModelPath', 5, '', 'type'], ['micId', 7, '', 'type'], ['vadModelPath', null, '', 'type'],
    ['language', 'zh', 'zh', null], ['language', 'auto', 'auto', null], ['language', 'JA', 'ja', 'enum'], ['language', 5, 'ja', 'enum'],
    ['hotkey', '', 'Control+Shift+Space', 'empty'], ['meetingHotkey', 5, 'Alt+M', 'type'],
    // 0.9.0 O-1: pillPos・pillCustom は知らないキー（下の RP2）。前の表示位置の名前（bottom）は置き場所の名前でない
    ['pillSlot', 'top-left', 'top-left', null], ['pillSlot', 'middle-right', 'middle-right', null], ['pillSlot', 5, 'bottom-center', 'type'],
    ['pillSlot', 'center', 'bottom-center', 'enum'], ['pillSlot', 'bottom', 'bottom-center', 'enum'],
    ['theme', 'blue', 'system', 'enum'], ['theme', 5, 'system', 'enum'], ['dictionary', 'x', [], 'type'], ['dictionary', [' 見積 ', '', 42], ['見積', '42'], null],
  ];
  for (const [key, raw, want, why] of rows) {
    const r = S.readSettings({ [key]: raw, theme: key === 'theme' ? raw : 'dark' }, D);
    assert.deepStrictEqual(r.settings[key], want, `${key}=${JSON.stringify(raw)}`);
    assert.deepStrictEqual(r.repaired.filter((x) => x.key === key).map((x) => x.why), why ? [why] : [], `${key}=${JSON.stringify(raw)} の why`);
    if (key !== 'theme') assert.strictEqual(r.settings.theme, 'dark', 'ほかのキーまで戻した');
  }
});

test('F11・JS6: オンとオフの欄は今の判定のまま真偽値に直す（useBuiltinTerms だけ「false でなければオン」）。"false" の文字はオンのままで印を返す', { timeout: 5000 }, () => {
  const raw = { useVad: 'true', autoPaste: 'false', removeFillers: 0, soundFeedback: 'yes', useBuiltinTerms: null, useSystemAudio: 1, stayInTray: '' };
  const r = S.readSettings(raw, D);
  for (const k of Object.keys(raw)) {
    assert.strictEqual(typeof r.settings[k], 'boolean', k);
    assert.strictEqual(r.settings[k], ON(k, raw[k]), `${k}: 今の動き（${ON(k, raw[k])}）と違う`);
  }
  assert.strictEqual(r.settings.useBuiltinTerms, true, 'null の人の業務用語がオフになった');
  assert.strictEqual(S.readSettings({ useBuiltinTerms: 0 }, D).settings.useBuiltinTerms, true);
  assert.strictEqual(S.readSettings({ useBuiltinTerms: false }, D).settings.useBuiltinTerms, false);
  assert.deepStrictEqual(r.falseLike, [{ key: 'autoPaste', raw: 'false' }]);
  assert.deepStrictEqual(r.repaired.map((x) => x.key).sort(), Object.keys(raw).sort());
});

test('JS6: 知らないキーは消さずに残し（古い版に戻したときに新しい版の設定が消えない）、dataDir は今どおり黙って捨てる。入力は書き換えない', { timeout: 5000 }, () => {
  const raw = { futureKey: { a: 1 }, dataDir: 'C:\\old', theme: 'dark' };
  const copy = JSON.parse(JSON.stringify(raw));
  const r = S.readSettings(raw, D);
  assert.deepStrictEqual(r.settings.futureKey, { a: 1 });
  assert.ok(!('dataDir' in r.settings));
  assert.deepStrictEqual(r.repaired, []);
  assert.deepStrictEqual(raw, copy);
});

test('RF23: 今の読み方と比べる — 今の結果が正しかった所は同じ値、オンかオフか・whisper に渡す言語は同じ', { timeout: 5000 }, () => {
  const fixtures = [
    JSON.parse(JSON.stringify(D)),
    { ...UI, pillPos: 'top-right', pillCustom: { x: 10, y: 20 }, maxHistory: 300, sumCtx: 32768 },
    { localPort: '8080' }, { dataDir: 'C:\\old' }, { futureKey: 1 }, {},
    { localServerExe: 'x', localModelPath: 'y', localPort: 8990, sumPort: 8991, autoLaunch: false },   // mainrun の一部だけの設定
    { useVad: 'true', autoPaste: 'false', useBuiltinTerms: null }, { language: 'zh' },
  ];
  for (const raw of fixtures) {
    const old = legacy(raw);
    const now = S.readSettings(raw, D).settings;
    for (const k of S.SETTING_KEYS) {
      const accepted = S.readSettings({ [k]: old[k] }, D).repaired.length === 0;
      if (accepted) assert.deepStrictEqual(now[k], old[k], `${JSON.stringify(raw)} の ${k}`);
      if (BOOLS.includes(k)) assert.strictEqual(ON(k, now[k]), ON(k, old[k]), `${JSON.stringify(raw)} の ${k} のオンとオフ`);
    }
    assert.strictEqual(now.language, old.language, `${JSON.stringify(raw)} の language`);
  }
});

test('JS6・P16: 直した設定をもう一度読むと、直すものは何も無い（書き戻した後の2回目の起動では、知らせも新しい写しも出ない）', { timeout: 5000 }, () => {
  const raws = [{ maxHistory: -1, pillSlot: 5, futureKey: { a: 1 } }, { useVad: 'true', autoPaste: 'false', useBuiltinTerms: null, stayInTray: '' },
    { localPort: 'abc', language: 'JA', hotkey: '', pillCustom: { x: '1', y: 2 }, theme: 'blue', dictionary: 'x', micId: 7 }, { maxHistory: 20000, sumCtx: 999999 }];
  for (const raw of raws) {
    const once = S.readSettings(raw, D).settings;
    const twice = S.readSettings(JSON.parse(JSON.stringify(once)), D);
    assert.deepStrictEqual([twice.repaired, twice.falseLike], [[], []], JSON.stringify(raw));
    assert.deepStrictEqual(twice.settings, once, JSON.stringify(raw));
  }
});

test('JS6・SEC1: 保存の許可の一覧 — 決まりのないキーは画面から来ても保存しない（__proto__・constructor も通さない）', { timeout: 5000 }, () => {
  // 0.9.0 O-1 で意図して変えた: pillCustom は決まりの表に無くなったので、画面から来ても保存しない（置き場所は pillSlot）
  const next = JSON.parse('{"theme":"dark","evil":"x","dataDir":"C:\\\\old","__proto__":{"polluted":1},"constructor":"y","pillCustom":{"x":1,"y":2},"pillSlot":"top-left"}');
  assert.deepStrictEqual(S.pickSavable(next), { theme: 'dark', pillSlot: 'top-left' });
  assert.deepStrictEqual(S.pickSavable(null), {});
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(S.isSettingsShape({}), true);
  for (const v of [null, [], 'x', 1]) assert.strictEqual(S.isSettingsShape(v), false, JSON.stringify(v));
});

// 0.7.0 U-1（設計書 D5・D7）: 送り先は OpenAI に固定し、同意の選択も外した。前の版が書いた4つのキーは読まず・直さず・消さず（JS6 の知らないキー。
// 0.6.0 に戻したときに前の選択が戻る）、画面からは保存させない。claudeExe の決まりは今のまま
const RETIRED = { cloudTranscribe: 'off', sttProvider: 'custom', sttBaseUrl: 'https://stt.example/v1', sttModel: 'whisper-large-v3' };
test('U-1: 送り先と同意の4つのキーは決まりの表に無く、保存の値は読まずに残し（知らないキー）、画面からは保存しない', { timeout: 5000 }, () => {
  for (const k of Object.keys(RETIRED)) assert.ok(!S.SETTING_KEYS.includes(k) && !(k in D), `${k} がまだ決まりの表か既定にある`);
  const r = S.readSettings({ ...RETIRED }, D);
  assert.deepStrictEqual(r.repaired, []);
  for (const [k, v] of Object.entries(RETIRED)) assert.strictEqual(r.settings[k], v, `${k} を書き換えた・消した`);
  // 壊れた値（前は ask に直していた true・"yes"）もそのまま残す（読まないので直さない）
  const odd = S.readSettings({ cloudTranscribe: 'yes', sttProvider: 5, sttBaseUrl: 'http://stt.example/v1' }, D);
  assert.deepStrictEqual(odd.repaired, []);
  assert.deepStrictEqual([odd.settings.cloudTranscribe, odd.settings.sttProvider, odd.settings.sttBaseUrl], ['yes', 5, 'http://stt.example/v1']);
  assert.deepStrictEqual(S.pickSavable({ ...RETIRED, theme: 'dark' }), { theme: 'dark' });
  assert.strictEqual(S.readSettings({ claudeExe: 'C:\\npm\\claude.cmd' }, D).settings.claudeExe, '');
  assert.strictEqual(S.readSettings({ claudeExe: 'C:\\Users\\u\\.local\\bin\\claude.exe' }, D).settings.claudeExe, 'C:\\Users\\u\\.local\\bin\\claude.exe');
});

test('OL7: claudeExe は npm 版（.cmd・.bat・.ps1）を大小を問わず捨てる。Windows が無視する後ろの . と空白も外して見る', { timeout: 5000 }, () => {
  const exe = (v) => S.readSettings({ claudeExe: v }, D);
  for (const v of ['C:\\npm\\claude.bat', 'C:\\npm\\claude.ps1', 'C:\\npm\\CLAUDE.CMD', 'C:\\x\\claude.Bat', 'C:\\x\\claude.PS1',
    'C:\\npm\\claude.cmd.', 'C:\\npm\\claude.cmd ']) {
    const got = exe(v);
    assert.strictEqual(got.settings.claudeExe, '', JSON.stringify(v));
    assert.deepStrictEqual(got.repaired, [{ key: 'claudeExe', why: 'enum' }], JSON.stringify(v));
  }
  assert.strictEqual(exe('/home/u/.local/bin/claude').settings.claudeExe, '/home/u/.local/bin/claude');
});

test('RF30: 鍵らしい欄は画面から来ても保存しない（設定の JSON に秘密を置かない）', { timeout: 5000 }, () => {
  const next = { theme: 'dark', sttKey: 'gsk_x', groqKey: 'gsk_x', openaiKey: 'sk-x', apiKey: 'k', ANTHROPIC_API_KEY: 'sk-ant', claudeExe: '' };
  assert.deepStrictEqual(S.pickSavable(next), { theme: 'dark', claudeExe: '' });
});

// 第1d回 A-2（RL10・F1）: ログイン中のメールアドレス。形の悪い値は '' に戻し（ログインしていない形）、repaired にはキーの名前と理由だけ
// （値は入れない: main は記録にキーの名前だけを書く）。テストの中にメールアドレスの形の文字を書かないため @ は文字の番号で作る
const AT = String.fromCharCode(64);
test('RL10: accountEmail は最後（31 番目。0.9.0 O-1 で pillPos・pillCustom を外して pillSlot を足した）のキー。形の良いメールアドレスはそのまま、形の悪い値は \'\' に戻し、キーの名前だけを記録する', { timeout: 5000 }, () => {
  assert.strictEqual(S.SETTING_KEYS[30], 'accountEmail');
  assert.strictEqual(S.SETTING_RULES.accountEmail.kind, 'email');
  const good = `kaigi${AT}example.com`;
  assert.deepStrictEqual(S.readSettings({ accountEmail: good }, D).settings.accountEmail, good);
  assert.deepStrictEqual(S.readSettings({ accountEmail: '' }, D).repaired, []);
  const long64 = `${'a'.repeat(64)}${AT}${'b'.repeat(185)}.com`;   // 254 字（いちばん長い形）
  assert.strictEqual(long64.length, 254);
  assert.strictEqual(S.readSettings({ accountEmail: long64 }, D).settings.accountEmail, long64);
  const rows = [
    [`${'a'.repeat(65)}${AT}example.com`, 'enum'], [`${'a'.repeat(64)}${AT}${'b'.repeat(186)}.com`, 'enum'], ['example.com', 'enum'],
    [`a b${AT}example.com`, 'enum'], [`a${AT}b${AT}example.com`, 'enum'], [`${AT}example.com`, 'enum'], [`a${AT}`, 'enum'], [` a${AT}example.com`, 'enum'],
    [5, 'type'], [null, 'type'], [{ v: good }, 'type'],
  ];
  for (const [raw, why] of rows) {
    const r = S.readSettings({ accountEmail: raw }, D);
    assert.strictEqual(r.settings.accountEmail, '', JSON.stringify(raw));
    assert.deepStrictEqual(r.repaired, [{ key: 'accountEmail', why }], JSON.stringify(raw));
  }
  assert.ok(S.isEmailShape(good) && !S.isEmailShape(`a b${AT}example.com`) && !S.isEmailShape(5));
});

// 0.9.0 O-1（設計書 D25・RP1・RP2・F12）: 録音バーの置き場所は8つの名前の pillSlot。前の版の pillPos・pillCustom は 0.7.0 U-1 の4つのキーと
// 同じく読まず・直さず・消さない（0.8.0 に戻すと前の位置が戻る）。pillFrom は raw に正しい pillSlot が無いときだけ前の2つの読みを返す
const SLOTS8 = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];
test('RP1: pillSlot は8つの名前の enum で既定 bottom-center。壊れた値は既定に戻し、記録にキーの名前', { timeout: 5000 }, () => {
  assert.deepStrictEqual(S.PILL_SLOTS, SLOTS8);
  assert.deepStrictEqual(S.SETTING_RULES.pillSlot, { label: '録音バーの置き場所', kind: 'enum', values: SLOTS8 });
  assert.strictEqual(D.pillSlot, 'bottom-center');
  for (const v of SLOTS8) assert.deepStrictEqual(S.readSettings({ pillSlot: v }, D).repaired, [], v);
  for (const [v, why] of [['center', 'enum'], [3, 'type'], [null, 'type'], ['BOTTOM-CENTER', 'enum']]) {
    const r = S.readSettings({ pillSlot: v }, D);
    assert.strictEqual(r.settings.pillSlot, 'bottom-center', JSON.stringify(v));
    assert.deepStrictEqual(r.repaired, [{ key: 'pillSlot', why }], JSON.stringify(v));
  }
  for (const k of ['pillPos', 'pillCustom']) assert.ok(!S.SETTING_KEYS.includes(k) && !(k in D), `${k} がまだ決まりの表か既定にある`);
});

test('RP2: pillFrom は raw に正しい pillSlot が無いときだけ { point, pos }。pillPos・pillCustom は知らないキーとして残り、画面からは保存できない', { timeout: 5000 }, () => {
  const from = (raw) => S.readSettings(raw, D).pillFrom;
  assert.deepStrictEqual(from({ pillCustom: { x: -200, y: 40 }, pillPos: 'left' }), { point: { x: -200, y: 40 }, pos: 'middle-left' });
  assert.deepStrictEqual(from({ pillPos: 'bottom' }), { point: null, pos: 'bottom-center' });
  assert.deepStrictEqual(from({ pillPos: 'top' }), { point: null, pos: 'top-center' });
  assert.deepStrictEqual(from({ pillPos: 'right' }), { point: null, pos: 'middle-right' });
  for (const p of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) assert.deepStrictEqual(from({ pillPos: p }), { point: null, pos: p });
  // 壊れた前の値は読まない（落ちない）。__proto__ の名前も前の表示位置にしない
  for (const c of [{ x: '1', y: 2 }, 'x', [1, 2], { x: Infinity, y: 0 }, { x: 1 }, null]) assert.deepStrictEqual(from({ pillCustom: c }), { point: null, pos: null }, JSON.stringify(c));
  for (const p of ['center', 5, '__proto__', 'constructor']) assert.deepStrictEqual(from({ pillPos: p }), { point: null, pos: null }, JSON.stringify(p));
  // 正しい pillSlot があれば直さない（null）。壊れた pillSlot なら前の値から直す
  assert.strictEqual(from({ pillSlot: 'top-center', pillCustom: { x: 1, y: 2 } }), null);
  assert.deepStrictEqual(from({ pillSlot: 'middle', pillPos: 'top-left' }), { point: null, pos: 'top-left' });
  // 前の2つの値は読んだ後もバイトのまま残り（直さない・消さない）、画面からは保存できない
  const raw = { pillPos: 5, pillCustom: { x: '1', y: 2 } };
  const r = S.readSettings(raw, D);
  assert.deepStrictEqual(r.repaired, []);
  assert.deepStrictEqual([r.settings.pillPos, r.settings.pillCustom], [5, { x: '1', y: 2 }]);
  assert.deepStrictEqual(S.pickSavable({ pillPos: 'top', pillCustom: { x: 1, y: 2 }, pillSlot: 'top-center' }), { pillSlot: 'top-center' });
  assert.deepStrictEqual(S.SLOT_FROM_POS, { bottom: 'bottom-center', top: 'top-center', left: 'middle-left', right: 'middle-right',
    'top-left': 'top-left', 'top-right': 'top-right', 'bottom-left': 'bottom-left', 'bottom-right': 'bottom-right' });
});
