/*
 * stage151.lib.test.js — 0.15.1「音声入力をなくす」の純粋な部品（計画 docs/plans/2026-11-04-151.md の Task ND-1。D114・JS6・決めたこと 4・5・7・9・10・14・15）
 * ND-1（F147・F151・F152・F153）: 設定の音声入力の4つのキー（hotkey・autoPaste・aiTidy・maxHistory）は表と既定から外して「知らないキー」に
 *       （値は残す・直さない・知らせない・画面から保存させない）。窓の覚え書きの音声入力のタブは黙って落とす。ホットキーの部品は議事録の1つの側。
 *       lib から音声入力だけの部品（始めるかの判断・断る文・履歴・貼り付け）を消す（常駐の PowerShell の台本は1字も変えない）。
 *       口述の整えの部品（dictTidy の tidyRules ほか・relay の tidyText）を消し、会議の区間のつなぎ言葉（dropFillers）は今のまま。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const S = require('../src/settings');
const W = require('../src/winstate');
const L = require('../src/mainlib');
const DT = require('../src/dictTidy');
const R = require('../src/relay');

const T = { timeout: 5000 };
const OLD4 = ['hotkey', 'autoPaste', 'aiTidy', 'maxHistory'];
const D = S.defaultSettings(8);

// ---------------------------------------------------------------- 設定（JS6・決めたこと 4・F151）
test('ND-1・JS6・F151: 設定のキーは 30。hotkey・autoPaste・aiTidy・maxHistory は表にも既定にも無い（外したキーの読み方は 0.7.0 U-1・0.10.0 LS-3 と同じ）', T, () => {
  assert.strictEqual(S.SETTING_KEYS.length, 30);
  assert.strictEqual(Object.keys(D).length, 30);
  assert.deepStrictEqual([...S.SETTING_KEYS].sort(), Object.keys(D).sort());
  for (const k of OLD4) {
    assert.ok(!S.SETTING_KEYS.includes(k) && !Object.hasOwn(S.SETTING_RULES, k), `${k} がまだ決まりの表にある`);
    assert.ok(!Object.hasOwn(D, k), `${k} がまだ既定にある`);
  }
  // 外したキーは消すキー（REMOVED_KEYS: 読まず・書き戻さない）にも入れない（0.15.0 に戻した人の設定を残す）
  for (const k of OLD4) assert.ok(!S.REMOVED_KEYS.includes(k), `${k} を消すキーにした`);
  // 音声入力の履歴の件数の直し方（history の kind）は使う所が無いので無い
  assert.ok(!Object.values(S.SETTING_RULES).some((r) => r.kind === 'history'), 'history の kind が残っている');
});

test('ND-1・F151: 前の4つのキーは知らないキーとして値のまま残る（直さない・知らせない・falseLike にも入れない）。removeFillers が false でも aiTidy を作らない', T, () => {
  const raw = { hotkey: 'Control+Shift+Space', autoPaste: false, aiTidy: false, maxHistory: -1 };
  const r = S.readSettings(JSON.parse(JSON.stringify(raw)), D);
  for (const k of OLD4) assert.deepStrictEqual(r.settings[k], raw[k], k);
  assert.deepStrictEqual(r.repaired, [], '前のキーを直したと数えた（起動のたびに記録と知らせが出る）');
  assert.deepStrictEqual(r.falseLike, []);
  // 壊れた値・文字の真偽も、知らないキーなのでそのまま（0.15.0 に戻すと 0.15.0 が今どおり直す）
  const odd = { hotkey: '', autoPaste: 'false', aiTidy: 'no', maxHistory: 20000 };
  const r2 = S.readSettings(JSON.parse(JSON.stringify(odd)), D);
  for (const k of OLD4) assert.deepStrictEqual(r2.settings[k], odd[k], k);
  assert.deepStrictEqual([r2.repaired, r2.falseLike], [[], []]);
  // 0.14.0 の BQ24 (a)（aiTidy が無く removeFillers が false なら切った形で読む）は無い。無いキーを作らない
  const r3 = S.readSettings({ removeFillers: false }, D);
  assert.strictEqual(r3.settings.removeFillers, false);
  for (const k of OLD4) assert.ok(!Object.hasOwn(r3.settings, k), `${k} を作った`);
  // 書いていなければ既定にも埋めない
  for (const k of OLD4) assert.ok(!Object.hasOwn(S.readSettings({}, D).settings, k), `${k} を既定で埋めた`);
});

test('ND-1・F151: 画面から前の4つのキーを保存できない（pickSavable が捨てる）。ほかのキーは今どおり通す', T, () => {
  const next = { hotkey: 'Control+Alt+K', autoPaste: true, aiTidy: true, maxHistory: 9, meetingHotkey: 'Alt+M', removeFillers: false };
  const out = S.pickSavable(next);
  for (const k of OLD4) assert.ok(!Object.hasOwn(out, k), `${k} を保存させた`);
  assert.deepStrictEqual(out, { meetingHotkey: 'Alt+M', removeFillers: false });
});

// ---------------------------------------------------------------- 窓の覚え書き（決めたこと 5・F152）
test('ND-1・F152: 覚え書きの音声入力のタブを黙って落とす（数えない・ほかのタブと active は残す）。tabKeyOk・normalize・applyUi も同じ', T, () => {
  assert.strictEqual(W.tabKeyOk('dictation'), false);
  assert.strictEqual(W.tabKeyOk('page:pa1'), true);
  assert.deepStrictEqual(W.keepTabs({ open: ['dictation', 'page:pa1'], active: 'dictation' }, () => true), { tabs: { open: ['page:pa1'], active: 'page:pa1' }, dropped: 0 });
  assert.deepStrictEqual(W.keepTabs({ open: ['dictation'], active: 'dictation' }, () => true), { tabs: { open: [], active: '' }, dropped: 0 });
  assert.deepStrictEqual(W.keepTabs({ open: ['page:pa1', 'dictation', 'page:pa2'], active: 'page:pa1' }, () => true), { tabs: { open: ['page:pa1', 'page:pa2'], active: 'page:pa1' }, dropped: 0 });
  // 無いページは今どおり数える（音声入力のタブは数えない）
  assert.deepStrictEqual(W.keepTabs({ open: ['dictation', 'page:pgone'], active: 'dictation' }, () => false), { tabs: { open: [], active: '' }, dropped: 1 });
  const raw = { v: 1, sidebar: { width: 300, collapsed: false }, tabs: { open: ['dictation', 'page:pa1'], active: 'dictation' }, tree: { open: ['pa1'] } };
  const n = W.normalize(raw, [{ x: 0, y: 0, width: 1920, height: 1040 }]);
  assert.deepStrictEqual(n.state.tabs, { open: ['page:pa1'], active: 'page:pa1' });
  assert.deepStrictEqual(n.state.tree, { open: ['pa1'] }, 'ほかの項目まで既定に戻した');
  assert.deepStrictEqual(n.state.sidebar, { width: 300, collapsed: false });
  assert.deepStrictEqual(W.normalize({ v: 1, tabs: { open: ['dictation'], active: 'dictation' } }, []).state.tabs, { open: [], active: '' });
  assert.deepStrictEqual(W.applyUi(W.defaults(), { tabs: { open: ['dictation', 'page:pa1'], active: 'dictation' } }).tabs, { open: ['page:pa1'], active: 'page:pa1' });
  assert.deepStrictEqual(W.applyUi(W.defaults(), { tabs: { open: ['dictation'], active: 'dictation' } }).tabs, { open: [], active: '' });
  // 0.9.0 の設定のタブも今どおり黙って落とす
  assert.deepStrictEqual(W.keepTabs({ open: ['settings', 'dictation', 'page:pa1'], active: 'settings' }, () => true), { tabs: { open: ['page:pa1'], active: 'page:pa1' }, dropped: 0 });
});

// ---------------------------------------------------------------- ホットキー（決めたこと 7・F147）
// bad: 登録できないキー。apply は main.js の applyHotkeys と同じ形（引数は議事録のキーの1つ。解除して登録し直す）で、呼ばれ方を記録する
const fakeApply = (bad) => {
  const calls = [];
  const apply = (...args) => {
    calls.push(args);
    return L.registerHotkeys([{ label: '議事録', accel: args[0], handler: () => {} }], (accel) => !bad.includes(accel));
  };
  return { apply, calls };
};
const noDictation = (v) => {
  const s = JSON.stringify(v);
  assert.ok(!s.includes('"hotkey"'), `答えに hotkey: ${s}`);
  assert.ok(!s.includes('音声入力'), `答えに「音声入力」: ${s}`);
};

test('ND-1・F147: ホットキーの部品は議事録の1つの側（登録・起動の退避・既定も駄目・保存の失敗。apply の引数は1つ。どの答えにも hotkey と「音声入力」が無い）', T, () => {
  // 登録: 議事録の1つだけ
  const reg = [];
  assert.deepStrictEqual(L.registerHotkeys([{ label: '議事録', accel: 'Alt+M', handler: () => {} }], (a) => { reg.push(a); return true; }), { ok: true, failed: [] });
  assert.deepStrictEqual(reg, ['Alt+M']);
  assert.deepStrictEqual(L.registerHotkeys([{ label: '議事録', accel: 'Alt+M', handler: () => {} }], () => false), { ok: false, failed: ['議事録'] });

  // 起動: 全部登録できる
  {
    const { apply, calls } = fakeApply([]);
    const r = L.resolveStartupHotkeys({ meetingHotkey: 'Ctrl+Alt+M', hotkey: 'Control+Shift+Space' }, { meetingHotkey: 'Alt+M' }, apply);
    assert.deepStrictEqual(calls, [['Ctrl+Alt+M']]);
    assert.deepStrictEqual(r.active, { meetingHotkey: 'Ctrl+Alt+M' });
    assert.deepStrictEqual(r.state, { ok: true, failed: [], fallback: {}, message: '' });
    assert.strictEqual(r.note, '');
    noDictation(r);
  }
  // 起動: 1回目が失敗 → 既定で試し直して退避（fallback.議事録）
  {
    const { apply, calls } = fakeApply(['Ctrl+Alt+M']);
    const cfg = { meetingHotkey: 'Ctrl+Alt+M' };
    const r = L.resolveStartupHotkeys(cfg, { meetingHotkey: 'Alt+M' }, apply);
    assert.deepStrictEqual(calls, [['Ctrl+Alt+M'], ['Alt+M']]);
    assert.deepStrictEqual(r.active, { meetingHotkey: 'Alt+M' });
    assert.deepStrictEqual(r.state, { ok: false, failed: [], fallback: { 議事録: { wanted: 'Ctrl+Alt+M', using: 'Alt+M' } },
      message: '議事録のホットキー Ctrl+Alt+M は他のアプリが使用中のため、代わりに既定の Alt+M を使っています' });
    assert.strictEqual(r.note, '（議事録: 既定の Alt+M を使用中）');
    assert.deepStrictEqual(cfg, { meetingHotkey: 'Ctrl+Alt+M' }, '設定を書き換えた');
    noDictation(r);
  }
  // 起動: 既定も駄目 → failed: ['議事録'] と「（既定の Alt+M も登録できませんでした）」
  {
    const { apply, calls } = fakeApply(['Ctrl+Alt+M', 'Alt+M']);
    const r = L.resolveStartupHotkeys({ meetingHotkey: 'Ctrl+Alt+M' }, { meetingHotkey: 'Alt+M' }, apply);
    assert.deepStrictEqual(calls, [['Ctrl+Alt+M'], ['Alt+M']]);
    assert.deepStrictEqual(r.state.failed, ['議事録']);
    assert.deepStrictEqual(r.state.fallback, {});
    assert.strictEqual(r.state.message, '議事録のホットキー Ctrl+Alt+M は他のアプリが使用中のため登録できていません（既定の Alt+M も登録できませんでした）');
    assert.deepStrictEqual(r.active, { meetingHotkey: 'Ctrl+Alt+M' });
    assert.strictEqual(r.note, '（Ctrl+Alt+M は登録できず）');
    noDictation(r);
  }
  // 起動: もともと既定なら同じキーで試し直さない
  {
    const { apply, calls } = fakeApply(['Alt+M']);
    const r = L.resolveStartupHotkeys({ meetingHotkey: 'Alt+M' }, { meetingHotkey: 'Alt+M' }, apply);
    assert.deepStrictEqual(calls, [['Alt+M']]);
    assert.strictEqual(r.state.message, '議事録のホットキー Alt+M は他のアプリが使用中のため登録できていません');
    noDictation(r);
  }
  // 保存: 変えていなければ何もしない（前の hotkey がファイルにあっても、それは見ない）
  {
    const { apply, calls } = fakeApply([]);
    assert.strictEqual(L.saveHotkeys({ meetingHotkey: 'Alt+M', hotkey: 'A' }, { meetingHotkey: 'Alt+M' }, { meetingHotkey: 'Alt+M', hotkey: 'B' }, apply), null);
    assert.deepStrictEqual(calls, []);
  }
  // 保存: 変えた議事録のキーが登録できる
  {
    const { apply, calls } = fakeApply([]);
    const r = L.saveHotkeys({ meetingHotkey: 'Alt+M' }, { meetingHotkey: 'Alt+M' }, { meetingHotkey: 'Ctrl+Alt+M' }, apply);
    assert.deepStrictEqual(calls, [['Ctrl+Alt+M']]);
    assert.deepStrictEqual([r.applied, r.active, r.warning], [{ meetingHotkey: 'Ctrl+Alt+M' }, { meetingHotkey: 'Ctrl+Alt+M' }, '']);
    assert.deepStrictEqual(r.state, { ok: true, failed: [], fallback: {}, message: '' });
    noDictation(r);
  }
  // 保存: 変えた議事録のキーが失敗 → 前の値に戻して warning
  {
    const { apply, calls } = fakeApply(['Ctrl+Alt+M']);
    const prev = { meetingHotkey: 'Alt+M' };
    const next = { meetingHotkey: 'Ctrl+Alt+M' };
    const r = L.saveHotkeys(prev, { meetingHotkey: 'Alt+M' }, next, apply);
    assert.deepStrictEqual(calls, [['Ctrl+Alt+M'], ['Alt+M']]);
    assert.deepStrictEqual([r.applied, r.active], [{ meetingHotkey: 'Alt+M' }, { meetingHotkey: 'Alt+M' }]);
    assert.strictEqual(r.warning, '議事録のホットキー Ctrl+Alt+M は他のアプリが使用中のため登録できませんでした');
    assert.deepStrictEqual(r.state, { ok: true, failed: [], fallback: {}, message: '' });
    assert.deepStrictEqual([prev, next], [{ meetingHotkey: 'Alt+M' }, { meetingHotkey: 'Ctrl+Alt+M' }], '設定を書き換えた');
    noDictation(r);
  }
  // 保存: 退避中（既定で動いている）に変えたキーも失敗 → 前の設定と既定の登録に戻す
  {
    const { apply, calls } = fakeApply(['Ctrl+Alt+M', 'Ctrl+Alt+Q']);
    const r = L.saveHotkeys({ meetingHotkey: 'Ctrl+Alt+M' }, { meetingHotkey: 'Alt+M' }, { meetingHotkey: 'Ctrl+Alt+Q' }, apply);
    assert.deepStrictEqual(calls, [['Ctrl+Alt+Q'], ['Alt+M']]);
    assert.deepStrictEqual([r.applied, r.active], [{ meetingHotkey: 'Ctrl+Alt+M' }, { meetingHotkey: 'Alt+M' }]);
    assert.deepStrictEqual(r.state.fallback, { 議事録: { wanted: 'Ctrl+Alt+M', using: 'Alt+M' } });
    noDictation(r);
  }
  // 状態の文（hotkeyStatus）も議事録の側だけ
  const st = L.hotkeyStatus({ meetingHotkey: 'B' }, { meetingHotkey: 'B' }, ['議事録']);
  assert.deepStrictEqual(st.state, { ok: false, failed: ['議事録'], fallback: {}, message: '議事録のホットキー B は他のアプリが使用中のため登録できていません' });
  noDictation(st);
});

// ---------------------------------------------------------------- lib の音声入力だけの部品（決めたこと 9・14・15）
test('ND-1: 音声入力の部品が lib に無い（始めるかの判断・断る文・履歴・貼り付け）。［コピー］の部品と常駐の PowerShell の台本は 0.15.0 のまま。ログインの窓は起動と会議の始めだけ', T, () => {
  for (const k of ['dictationPlan', 'DICTATION_REFUSE_TEXT', 'recordDictation', 'mergeHistory', 'deliverText', 'restoreAfterPaste']) {
    assert.ok(!Object.hasOwn(L, k), `mainlib に ${k} が残っている`);
  }
  for (const k of ['copyPrivate', 'pasterScript', 'parsePasterLine', 'copyCommand', 'readClip', 'readClipRows']) assert.strictEqual(typeof L[k], 'function', k);
  // 決めたこと 9: 台本は 1 字も変えない（da37aaa の字。fg・paste の命令も残る）
  assert.strictEqual(crypto.createHash('sha256').update(L.pasterScript()).digest('hex'), '805aa46f38d20e6fe702f63af5f1b3763e3007b6d7d7d325ad9db1cffd0d27d7');
  assert.deepStrictEqual([L.parsePasterLine('ok'), L.parsePasterLine('123'), L.parsePasterLine('x')], [{ kind: 'ok' }, { kind: 'hwnd', value: '123' }, null]);
  // 決めたこと 14
  assert.deepStrictEqual(L.LOGIN_ASK_MOMENTS, ['boot', 'meeting']);
  const P = (moment) => L.loginAskPlan({ moment, online: true, signedIn: false, why: 'signed-out', snoozed: false, localOnly: false, chosen: true, showing: false });
  assert.deepStrictEqual([P('boot'), P('meeting'), P('dictation')], [{ ask: true }, { ask: true }, { ask: false }]);
});

test('ND-1・決めたこと 15: hintEcho は opts.dictation を見ない（大きな声の「お疲れさまです。」も会議と同じ答え）', T, () => {
  const hint = { sample: 'お疲れさまです。よろしくお願いします。', terms: ['不具合'], tail: '' };
  for (const opts of [undefined, {}, { dictation: true, loudDbfs: -20 }, { dictation: true, loudDbfs: null }, { dictation: true, loudDbfs: -50 }, { loudDbfs: -10 }]) {
    assert.strictEqual(L.hintEcho('お疲れさまです。', hint, opts), true, JSON.stringify(opts));
    assert.strictEqual(L.hintEcho('来週リリースします。', hint, opts), false, JSON.stringify(opts));
  }
});

// ---------------------------------------------------------------- 整えと中継の口（決めたこと 10・F153・F156）
test('ND-1・F153: dictTidy は dropFillers だけを出し（中継の照らしの写しの LEAD_MARK は R23）、会議の区間のつなぎ言葉は今と同じ答え。relay に tidyText・TIDY_WAIT_MS・TIDY_SEND_MS が無い', T, () => {
  assert.deepStrictEqual(Object.keys(DT).sort(), ['LEAD_MARK', 'dropFillers']);
  assert.ok(DT.LEAD_MARK instanceof RegExp);
  for (const [said, want] of [
    ['えーと、明日の会議は十時からです。', '明日の会議は十時からです。'], ['あのー、資料を、えー、共有します。', '資料を、共有します。'],
    ['うーんと、そうですね。', 'そうですね。'], ['Um, the schedule is fine.', 'the schedule is fine.'], ['あの資料です。', 'あの資料です。'],
    ['その件は、えっと、来週に。', 'その件は、来週に。'],
  ]) assert.strictEqual(DT.dropFillers(said), want, said);
  for (const k of ['tidyText', 'TIDY_WAIT_MS', 'TIDY_SEND_MS']) assert.ok(!Object.hasOwn(R, k), `relay に ${k} が残っている`);
  for (const k of ['RELAY_BASE', 'relayProvider', 'makeAccessApi']) assert.ok(Object.hasOwn(R, k), k);
});
