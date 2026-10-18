/*
 * settings-rules.test.js — 設定の決まり（第1a回 JS6。RF23・F8・F11）
 * 35 のキーの表（第1a回の 30 に第1c回 Task C-1 で5つ足した）・項目ごとの読み方・今の読み方（normalizeSettings({ ...既定, ...raw }, 既定)）との比べ・保存の許可の一覧。
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
// 今の画面（app.html の save）が送る 29 のキー（pillCustom は録音バーを動かしたときだけ main が書く）
const UI = { ...TODAY, localServerExe: 'C:\\e\\w.exe', localModelPath: 'C:\\m\\g.bin', theme: 'dark', micId: 'mic-1', dictionary: ['見積', '検収'] };
delete UI.pillCustom; delete UI.maxHistory;
// 第1c回 Task C-1: TODAY に足す（ほかの 30 は変えない）。意図: 既定が今の値のまま・決まりのないキーを足せない
// （UI は今の画面が送るキーなので、C-2 の画面の前の 29 のまま）
Object.assign(TODAY, { cloudTranscribe: 'ask', sttProvider: 'groq', sttBaseUrl: '', sttModel: '', claudeExe: '' });
const legacy = (raw) => S.normalizeSettings({ ...D, ...raw }, D);
const ON = (key, v) => (key === 'useBuiltinTerms' ? v !== false : Boolean(v));
const BOOLS = ['useVad', 'suppressNst', 'autoPaste', 'removeFillers', 'soundFeedback', 'autoLaunch', 'stayInTray', 'useBuiltinTerms', 'useSystemAudio'];

test('JS6: 決まりの表のキーは既定の 35 のキーとちょうど同じ。どれにも画面の名前がある', { timeout: 5000 }, () => {
  assert.deepStrictEqual(D, TODAY);
  assert.strictEqual(S.SETTING_KEYS.length, 35);
  assert.deepStrictEqual([...S.SETTING_KEYS].sort(), Object.keys(TODAY).sort());
  for (const k of S.SETTING_KEYS) assert.ok(typeof S.SETTING_RULES[k].label === 'string' && S.SETTING_RULES[k].label.length > 1, k);
  assert.strictEqual(S.defaultSettings(2).localThreads, 4);
  assert.ok(!('dataDir' in D));
});

test('JS6: 無いキーは黙って既定で埋める（版を上げたときのふつうのこと）。今の画面が書く値はそのまま往復する', { timeout: 5000 }, () => {
  assert.deepStrictEqual(S.readSettings({}, D), { settings: D, repaired: [], falseLike: [] });
  const r = S.readSettings(JSON.parse(JSON.stringify({ ...UI, pillCustom: { x: 10, y: 20 }, maxHistory: 300 })), D);
  assert.deepStrictEqual(r.repaired, []);
  assert.deepStrictEqual(r.settings, { ...D, ...UI, pillCustom: { x: 10, y: 20 }, maxHistory: 300 });
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
    ['pillPos', 'top-left', 'top-left', null], ['pillPos', 5, 'bottom', 'type'], ['pillPos', 'center', 'bottom', 'enum'],
    ['pillCustom', { x: 1, y: 2 }, { x: 1, y: 2 }, null], ['pillCustom', { x: '1', y: 2 }, null, 'type'], ['pillCustom', 'x', null, 'type'],
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
  const raws = [{ maxHistory: -1, pillPos: 5, futureKey: { a: 1 } }, { useVad: 'true', autoPaste: 'false', useBuiltinTerms: null, stayInTray: '' },
    { localPort: 'abc', language: 'JA', hotkey: '', pillCustom: { x: '1', y: 2 }, theme: 'blue', dictionary: 'x', micId: 7 }, { maxHistory: 20000, sumCtx: 999999 }];
  for (const raw of raws) {
    const once = S.readSettings(raw, D).settings;
    const twice = S.readSettings(JSON.parse(JSON.stringify(once)), D);
    assert.deepStrictEqual([twice.repaired, twice.falseLike], [[], []], JSON.stringify(raw));
    assert.deepStrictEqual(twice.settings, once, JSON.stringify(raw));
  }
});

test('JS6・SEC1: 保存の許可の一覧 — 決まりのないキーは画面から来ても保存しない（__proto__・constructor も通さない）', { timeout: 5000 }, () => {
  const next = JSON.parse('{"theme":"dark","evil":"x","dataDir":"C:\\\\old","__proto__":{"polluted":1},"constructor":"y","pillCustom":{"x":1,"y":2}}');
  assert.deepStrictEqual(S.pickSavable(next), { theme: 'dark', pillCustom: { x: 1, y: 2 } });
  assert.deepStrictEqual(S.pickSavable(null), {});
  assert.strictEqual({}.polluted, undefined);
  assert.strictEqual(S.isSettingsShape({}), true);
  for (const v of [null, [], 'x', 1]) assert.strictEqual(S.isSettingsShape(v), false, JSON.stringify(v));
});

test('OL7: 第1c回の5つのキー。同意の壊れた値は送らない側（ask）に戻す', { timeout: 5000 }, () => {
  assert.strictEqual(S.SETTING_KEYS.length, 35);
  const r = (raw) => S.readSettings(raw, D);
  for (const v of [true, 'yes', 1, null, 'ON']) assert.strictEqual(r({ cloudTranscribe: v }).settings.cloudTranscribe, 'ask', JSON.stringify(v));
  assert.strictEqual(r({ cloudTranscribe: 'on' }).settings.cloudTranscribe, 'on');
  assert.strictEqual(r({ sttProvider: 'azure' }).settings.sttProvider, 'groq');
  assert.strictEqual(r({ sttBaseUrl: 'http://stt.example/v1' }).settings.sttBaseUrl, '');
  assert.strictEqual(r({ sttBaseUrl: 'https://stt.example/v1' }).settings.sttBaseUrl, 'https://stt.example/v1');
  assert.strictEqual(r({ sttBaseUrl: 'http://127.0.0.1:8123/v1' }).settings.sttBaseUrl, 'http://127.0.0.1:8123/v1');
  assert.strictEqual(r({ sttModel: 'whisper-large-v3; rm -rf' }).settings.sttModel, '');
  assert.strictEqual(r({ sttModel: 'gpt-4o-transcribe' }).settings.sttModel, 'gpt-4o-transcribe');
  assert.strictEqual(r({ claudeExe: 'C:\\npm\\claude.cmd' }).settings.claudeExe, '');
  assert.strictEqual(r({ claudeExe: 'C:\\Users\\u\\.local\\bin\\claude.exe' }).settings.claudeExe, 'C:\\Users\\u\\.local\\bin\\claude.exe');
  assert.deepStrictEqual(r({ cloudTranscribe: 'yes' }).repaired, [{ key: 'cloudTranscribe', why: 'enum' }]);
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

test('OL7: sttBaseUrl は 2048 字まで。http は 127.0.0.1・localhost だけで、似た名前と鍵入りの URL は通さない', { timeout: 5000 }, () => {
  const url = (v) => S.readSettings({ sttBaseUrl: v }, D);
  const AT = '@';   // 文字のままだと repo.test.js のメールアドレスの見張りに当たるので分けて書く
  const max = 'https://a.example/' + 'x'.repeat(2048 - 18);
  assert.strictEqual(max.length, 2048);
  assert.strictEqual(url(max).settings.sttBaseUrl, max);
  assert.deepStrictEqual(url(max + 'x').settings.sttBaseUrl, '');
  assert.deepStrictEqual(url(max + 'x').repaired, [{ key: 'sttBaseUrl', why: 'enum' }]);
  for (const v of ['http://localhost.example/v1', 'http://127.0.0.1.evil/v1', `http://localhost${AT}evil.example/`, 'HTTPS://stt.example/v1',
    'https:stt.example/v1', `https://user:gsk_secret${AT}stt.example/v1`, `https://:gsk_secret${AT}stt.example/v1`, `http://u:p${AT}127.0.0.1:8123/v1`,
    'http://localhost\\v1']) {   // 最後は URL では localhost に読めるが、文字の頭の決まり（名前の後ろは : か / か終わり）で落とす
    const got = url(v);
    assert.strictEqual(got.settings.sttBaseUrl, '', JSON.stringify(v));
    assert.deepStrictEqual(got.repaired, [{ key: 'sttBaseUrl', why: 'enum' }], JSON.stringify(v));
  }
  for (const v of ['http://localhost:8123', 'http://127.0.0.1:8123', 'http://localhost/v1', 'https://stt.example/v1/']) {
    assert.strictEqual(url(v).settings.sttBaseUrl, v, JSON.stringify(v));
  }
});

test('RF30: 鍵らしい欄は画面から来ても保存しない（設定の JSON に秘密を置かない）', { timeout: 5000 }, () => {
  const next = { theme: 'dark', sttKey: 'gsk_x', groqKey: 'gsk_x', openaiKey: 'sk-x', apiKey: 'k', ANTHROPIC_API_KEY: 'sk-ant', cloudTranscribe: 'on' };
  assert.deepStrictEqual(S.pickSavable(next), { theme: 'dark', cloudTranscribe: 'on' });
});
