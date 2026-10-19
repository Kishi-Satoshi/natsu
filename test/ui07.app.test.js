/*
 * ui07.app.test.js — 0.7.0 U-2（設計書 D8。計画 docs/plans/2026-10-19-ui07.md）: 設定のいちばん上の「外観」と Ctrl+Shift+L を、
 * 最小 DOM の上で app.html を本当に走らせて確かめる。設定のキー theme と main の applyTheme（nativeTheme.themeSource）は変えない
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const T = { timeout: 5000 };
const settingsWith = (theme) => () => ({
  localServerExe: '', localModelPath: '', localThreads: 4, localPort: 8990, vadModelPath: '', useVad: true, suppressNst: true,
  sumServerExe: '', sumModelPath: '', sumThreads: 4, sumPort: 8991, hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M', segmentSec: 75,
  pillPos: 'bottom', language: 'ja', autoPaste: true, removeFillers: true, soundFeedback: true, autoLaunch: false, dictionary: [],
  useBuiltinTerms: true, stayInTray: false, theme, useSystemAudio: false, micId: '',
});
// 今見えている配色（prefers-color-scheme）を偽る。main の nativeTheme.themeSource が Windows の設定かアプリの設定でこれを決める
const scheme = (dark) => (q) => ({ matches: /prefers-color-scheme:\s*dark/.test(q) ? dark : !dark, media: q, addEventListener() {}, addListener() {} });
const CTRL_SHIFT_L = { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true };
const themesSaved = (l) => l.called('saveSettings').map((c) => c.args[0].theme);

test('D8: 設定の画面のいちばん上のカードが「外観」で、選択肢は「システム設定を使用」「ライト」「ダーク」。「動作」のカードに「画面の配色」が無い', T, async () => {
  const l = await load(APP);
  await l.drain();
  const cards = l.byId.get('tabSettings').querySelectorAll('.card');
  const top = cards[0];
  assert.strictEqual(top.id, 'appearanceCard', '設定のいちばん上が外観のカードでない');
  assert.strictEqual(top.querySelector('h2').textContent.trim(), '外観');
  const sel = l.byId.get('themeSel');
  assert.strictEqual(sel.closest('.card'), top, '外観の欄が外観のカードの中に無い');
  assert.deepStrictEqual(sel.querySelectorAll('option').map((o) => [o.getAttribute('value'), o.textContent.trim()]),
    [['system', 'システム設定を使用'], ['light', 'ライト'], ['dark', 'ダーク']]);
  // 欄の名前は見出し「外観」（読み上げでも「外観」）
  const named = l.byId.get(sel.getAttribute('aria-labelledby'));
  assert.ok(named && named.textContent.trim() === '外観', '外観の欄に名前が無い');
  assert.match(top.textContent, /Ctrl\+Shift\+L でライトとダークを切り替えられます/);
  const work = cards.find((c) => c.querySelector('h2') && c.querySelector('h2').textContent.trim() === '動作');
  assert.ok(work, '動作のカードが無い');
  assert.ok(!work.textContent.includes('画面の配色') && !work.querySelector('#themeSel'), '動作のカードに前の「画面の配色」が残っている');
  assert.ok(!l.byId.get('tabSettings').textContent.includes('Windowsの設定に合わせる'), '前の選択肢の文が残っている');
  assert.strictEqual(sel.value, 'system');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('D8: 外観を変えると、今の自動保存ですぐ main に送る（theme の値は今のまま system・light・dark）', T, async () => {
  const l = await load(APP, { returns: { getSettings: settingsWith('dark') } });
  await l.drain();
  assert.strictEqual(l.byId.get('themeSel').value, 'dark');
  l.byId.get('themeSel').value = 'light';
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.deepStrictEqual(themesSaved(l), ['light']);
});

test('D8: Ctrl+Shift+L でライトとダークを切り替えて保存する。「システム設定を使用」のときは今見えている配色の反対', T, async () => {
  const l = await load(APP, { returns: { getSettings: settingsWith('light') } });
  await l.drain();
  const ev = l.key(CTRL_SHIFT_L);
  await l.drain();
  assert.strictEqual(ev.defaultPrevented, true);
  assert.strictEqual(l.byId.get('themeSel').value, 'dark');
  l.key({ ...CTRL_SHIFT_L, key: 'l' });   // Shift の押し方で key が小文字のことがある
  await l.drain();
  assert.strictEqual(l.byId.get('themeSel').value, 'light');
  assert.deepStrictEqual(themesSaved(l), ['dark', 'light']);
  for (const [dark, want] of [[true, 'light'], [false, 'dark']]) {
    const s = await load(APP, { returns: { getSettings: settingsWith('system') }, matchMedia: scheme(dark) });
    await s.drain();
    s.key(CTRL_SHIFT_L);
    await s.drain();
    assert.deepStrictEqual(themesSaved(s), [want], `今の配色が${dark ? 'ダーク' : 'ライト'}のシステム設定から${want}にならない`);
    assert.strictEqual(s.byId.get('themeSel').value, want);
  }
});

test('D8: Ctrl+Shift+L は入力欄の中でも効く（Notion と同じ）。変換中・押しっぱなし・ホットキーの欄の取り込み・ほかの組み合わせでは動かない', T, async () => {
  const l = await load(APP, { returns: { getSettings: settingsWith('dark') } });
  await l.drain();
  l.key(CTRL_SHIFT_L, l.byId.get('histSearch'));
  await l.drain();
  assert.deepStrictEqual(themesSaved(l), ['light'], '入力欄の中で効かない');
  const none = [
    [{ ...CTRL_SHIFT_L, isComposing: true }, null, '変換中'],
    [{ ...CTRL_SHIFT_L, keyCode: 229 }, null, '変換中（Windows の Chromium が isComposing を立てず keyCode 229 だけで知らせる）'],
    [{ ...CTRL_SHIFT_L, repeat: true }, null, '押しっぱなしの繰り返し'],
    [CTRL_SHIFT_L, l.byId.get('hotkey'), 'ホットキーの欄（キーを取り込む）'],
    [{ key: 'l', code: 'KeyL', ctrlKey: true }, null, 'Ctrl+L'],
    [{ ...CTRL_SHIFT_L, altKey: true }, null, 'Ctrl+Alt+Shift+L'],
    [{ ...CTRL_SHIFT_L, metaKey: true }, null, 'Ctrl+Shift+Win+L'],
    [{ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }, null, 'Ctrl+Shift+K'],
  ];
  for (const [o, target, name] of none) {
    const ev = l.key(o, target || undefined);
    await l.drain();
    assert.deepStrictEqual(themesSaved(l), ['light'], `${name} で切り替えた`);
    if (!target) assert.strictEqual(ev.defaultPrevented, false, `${name} の既定の動きを止めた`);
  }
  assert.strictEqual(l.byId.get('hotkey').value, 'Control+Shift+L', 'ホットキーの欄に Ctrl+Shift+L を入れられない');
  assert.strictEqual(l.byId.get('themeSel').value, 'light');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('D8: 設定を読み込めていないうちは Ctrl+Shift+L でも保存せず、欄も前の値のまま', T, async () => {
  const l = await load(APP, { returns: { getSettings: () => new Promise(() => {}) } });   // 返事が来ない（runtime.app.test.js の未読込と同じ）
  await l.drain();
  const before = l.byId.get('themeSel').value;
  l.key(CTRL_SHIFT_L);
  await l.drain();
  assert.deepStrictEqual(themesSaved(l), []);
  assert.strictEqual(l.byId.get('themeSel').value, before, '保存していないのに欄だけ変わった');
});
