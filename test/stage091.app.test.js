/*
 * stage091.app.test.js — 0.9.1 の設定と画面（計画 docs/plans/2026-10-21-091.md の Task Q-3・Q-4。設計書 D29）
 * Q-3: ［設定］→［録音］のカード「話し声が無いとき」（話し声が無いときに自動で止める・知らせるまでの時間）と、設定の決まりの2つのキー
 * Q-4: 録音中のページの「会議は終わりましたか？」の帯（文は main の meetingStatus().quiet.text、ボタン［続ける］［終了して作成］）
 * 画面は最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。main の答えは偽物（preload.js の名前から作る）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const S = require('../src/settings');

const T = { timeout: 5000 };
const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const preloadWith = (...names) => names.reduce((src, n) => (new RegExp(`^\\s+${n}\\s*:`, 'm').test(src) ? src
  : src.replace("exposeInMainWorld('koeApp', {", `exposeInMainWorld('koeApp', {\n  ${n}: (...a) => ipcRenderer.invoke('test:${n}', ...a),`)), PRELOAD);
const P = preloadWith('uiState', 'uiSave', 'meetingSetPaused');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const click = async (l, el) => { (typeof el === 'string' ? $(l, el) : el).dispatchEvent({ type: 'click' }); await l.drain(); };
const UI = () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' } });
const BASE = {
  localServerExe: 'C:\\srv\\whisper.exe', localModelPath: 'C:\\m\\ggml.bin', localThreads: 4, localPort: 8990, vadModelPath: '', useVad: true, suppressNst: true,
  sumServerExe: 'C:\\srv\\sum.exe', sumModelPath: 'C:\\m\\sum.gguf', sumThreads: 4, sumPort: 8991, hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M',
  segmentSec: 75, pillSlot: 'bottom-center', language: 'ja', autoPaste: true, removeFillers: true, soundFeedback: true, autoLaunch: false,
  dictionary: ['固有名詞'], useBuiltinTerms: true, stayInTray: false, theme: 'system', useSystemAudio: false, micId: '',
};
const open = (settings = {}, o = {}) => load(APP, { preloadSrc: P, returns: { uiState: UI, getSettings: () => ({ ...BASE, ...settings }), ...o } });
const cardsOf = (l) => l.root.querySelector('#tabSettings').querySelector('.scroll').children.filter((c) => c.classList.contains('card'));
const titleOf = (c) => c.querySelector('h2').textContent.trim();
const visible = (el) => { for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) { if (n.id === 'settingsModal') return true; if (n.hidden || n.classList.contains('set-miss')) return false; } return true; };
const shownRows = (l) => l.byId.get('tabSettings').querySelectorAll('[data-row]').filter(visible).map((r) => r.dataset.row);
const pick = async (l, sec) => { const nav = $(l, 'setNav'); nav.dispatchEvent({ type: 'click', target: nav.querySelector(`[data-sec="${sec}"]`) }); await l.drain(); };
const search = async (l, q) => { const b = $(l, 'setSearch'); b.value = q; b.dispatchEvent({ type: 'input', target: b }); await l.drain(); };

// ---------------------------------------------------------------- Q-3（決めたこと 12）
test('Q-3: autoStopQuiet は既定 true（false でなければオン）、autoStopMin は 5・10・15・20・30・60 のどれか（数の文字も受ける。ほかは 10 に直した印）', T, () => {
  const D = S.defaultSettings(8);
  assert.strictEqual(D.autoStopQuiet, true);
  assert.strictEqual(D.autoStopMin, 10);
  assert.deepStrictEqual(S.AUTO_STOP_CHOICES, [5, 10, 15, 20, 30, 60]);
  assert.deepStrictEqual(S.SETTING_RULES.autoStopQuiet, { label: '話し声が無いときに自動で止める', kind: 'bool', notFalse: true });
  assert.deepStrictEqual(S.SETTING_RULES.autoStopMin, { label: '知らせるまでの時間', kind: 'pick', values: S.AUTO_STOP_CHOICES });
  const rows = [[15, 15, null], ['15', 15, 'type'], [60, 60, null], [5, 5, null], [0, 10, 'enum'], [7, 10, 'enum'], [-5, 10, 'enum'], [61, 10, 'enum'],
    [15.5, 10, 'enum'], ['x', 10, 'type'], [null, 10, 'type'], [true, 10, 'type']];
  for (const [raw, want, why] of rows) {
    const r = S.readSettings({ autoStopMin: raw }, D);
    assert.strictEqual(r.settings.autoStopMin, want, JSON.stringify(raw));
    assert.deepStrictEqual(r.repaired.map((x) => x.why), why ? [why] : [], `${JSON.stringify(raw)} の why`);
  }
  assert.strictEqual(S.readSettings({ autoStopQuiet: false }, D).settings.autoStopQuiet, false);
  assert.strictEqual(S.readSettings({ autoStopQuiet: null }, D).settings.autoStopQuiet, true, '壊れた値で自動で止めるのが切れた');
  assert.deepStrictEqual(S.pickSavable({ autoStopQuiet: false, autoStopMin: 20, evil: 1 }), { autoStopQuiet: false, autoStopMin: 20 });
});

test('Q-3: ［録音］の「マイクと相手の声」の後にカード「話し声が無いとき」。チェックと選ぶ欄（選択肢は AUTO_STOP_CHOICES と同じで、既定の 10 分に印）', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  await pick(l, 'record');
  const titles = cardsOf(l).filter(visible).map(titleOf);
  assert.deepStrictEqual(titles, ['録音バー', 'マイクと相手の声', '話し声が無いとき', '文字起こし', 'ユーザー辞書（認識ヒント）']);
  const card = cardsOf(l).find((c) => titleOf(c) === '話し声が無いとき');
  assert.strictEqual(card.dataset.sec, 'record');
  assert.deepStrictEqual(card.querySelectorAll('[data-row]').map((r) => r.dataset.row), ['話し声が無いときに自動で止める', '知らせるまでの時間']);
  const sel = $(l, 'autoStopMin');
  assert.strictEqual(sel.tagName, 'select');
  assert.deepStrictEqual(sel.querySelectorAll('option').map((o) => Number(o.getAttribute('value'))), S.AUTO_STOP_CHOICES);
  assert.deepStrictEqual(sel.querySelectorAll('option').map((o) => o.textContent.trim()), ['5 分', '10 分（既定）', '15 分', '20 分', '30 分', '60 分']);
  assert.strictEqual($(l, 'autoStopQuiet').closest('[data-row]').dataset.row, '話し声が無いときに自動で止める');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('Q-3: 読み込んだ設定が欄に入り（オフ・20 分）、欄を変えると自動保存が2つのキーを送る', T, async () => {
  const l = await open({ autoStopQuiet: false, autoStopMin: 20 });
  await l.drain();
  assert.strictEqual($(l, 'autoStopQuiet').checked, false);
  assert.strictEqual(String($(l, 'autoStopMin').value), '20');
  await click(l, 'tabBtnSettings');
  $(l, 'autoStopQuiet').checked = true;
  $(l, 'autoStopMin').value = '30';
  l.byId.get('tabSettings').dispatchEvent({ type: 'change', target: $(l, 'autoStopMin') });
  await l.drain();
  const saved = l.called('saveSettings');
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].args[0].autoStopQuiet, true);
  assert.strictEqual(saved[0].args[0].autoStopMin, 30);
  // 古い main（キーが無い）は既定の形（オン・10 分）で出す
  const o = await open({ autoStopQuiet: undefined, autoStopMin: undefined });
  await o.drain();
  assert.strictEqual($(o, 'autoStopQuiet').checked, true);
  assert.strictEqual(String($(o, 'autoStopMin').value), '10');
  assert.deepStrictEqual([...l.errors, ...o.errors].map(fmt), []);
});

test('Q-3: 設定の検索「自動で止める」「話し声」でチェックの行が、「知らせるまで」で選ぶ欄の行が出る', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  await search(l, '自動で止める');
  assert.deepStrictEqual(shownRows(l), ['話し声が無いときに自動で止める']);
  await search(l, '話し声');
  assert.deepStrictEqual(shownRows(l), ['話し声が無いときに自動で止める']);
  await search(l, '知らせるまで');
  assert.deepStrictEqual(shownRows(l), ['知らせるまでの時間']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- Q-4（決めたこと 10）: 「会議は終わりましたか？」の帯
const T0 = Date.UTC(2026, 9, 21, 1, 0, 0);
const LIVE = (o = {}) => ({ active: true, finalizing: false, startedAt: T0 - 60000, memo: '', segments: [], pending: 0, stoppedAt: null,
  stopping: false, paused: false, pausedMs: 0, systemAudio: false, micFallback: false, etaSec: null, skipped: 0, pauses: [], pausing: false,
  resumeHint: false, localOnly: false, cloud: true, stt: { route: 'cloud', lastTextAt: T0 - 5000, segSec: 15, problem: null }, quiet: null, ...o });
const QA1 = '10 分ほど話し声がありません。会議は終わりましたか？ このままなら 5 分後に録音を止めて議事録を作ります。';
const nextEl = (el) => { const kids = el.parentNode.children; return kids[kids.indexOf(el) + 1] || null; };
const inTree = (l, id) => l.root.querySelectorAll(`#${id}`).length > 0;

test('Q-4: quiet があれば録音中のページの頭（文字起こしの帯の上）に帯 #liveQuietAsk（文は main の text・ボタン［続ける］［終了して作成］）。［続ける］は meetingKeepGoing、［終了して作成］は meetingToggle', T, async () => {
  const l = await load(APP, { now: T0, preloadSrc: P, returns: { uiState: UI, meetingKeepGoing: () => ({ ok: true }), meetingToggle: () => ({ ok: true }) } });
  l.fire('onMeetingUpdate', LIVE()); await l.drain();
  const b = $(l, 'liveQuietAsk');
  assert.ok(b, '帯が無い');
  assert.strictEqual(b.hidden, true, 'quiet が null なのに出ている');
  l.fire('onMeetingUpdate', LIVE({ quiet: { text: QA1 } })); await l.drain();
  assert.strictEqual(b.hidden, false);
  assert.strictEqual(b.getAttribute('role'), 'alert');
  assert.strictEqual($(l, 'liveQuietAskText').textContent, QA1);
  assert.strictEqual(nextEl(b), $(l, 'liveSttBanner'), '帯が録音中のページの頭（文字起こしの帯のすぐ上）に無い');
  assert.strictEqual(nextEl($(l, 'liveSttBanner')), $(l, 'liveBar'), '文字起こしの帯が記録の行のすぐ上でなくなった');
  assert.deepStrictEqual([$(l, 'liveQuietGo').textContent, $(l, 'liveQuietStop').textContent], ['続ける', '終了して作成']);
  // 同じ文は書き直さない（role="alert" の読み上げ直しを避ける）
  const kids = $(l, 'liveQuietAskText').childNodes;
  l.fire('onMeetingUpdate', LIVE({ quiet: { text: QA1 }, pending: 1 })); await l.drain();
  assert.strictEqual($(l, 'liveQuietAskText').childNodes, kids);
  await click(l, 'liveQuietGo');
  assert.strictEqual(l.called('meetingKeepGoing').length, 1);
  await click(l, 'liveQuietStop');
  assert.strictEqual(l.called('meetingToggle').length, 1);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('Q-4: quiet が null に戻る・作成中なら隠し、会議が終わると帯を外す', T, async () => {
  const l = await load(APP, { now: T0, preloadSrc: P, returns: { uiState: UI } });
  l.fire('onMeetingUpdate', LIVE({ quiet: { text: QA1 } })); await l.drain();
  assert.strictEqual($(l, 'liveQuietAsk').hidden, false);
  l.fire('onMeetingUpdate', LIVE({ quiet: null })); await l.drain();
  assert.strictEqual($(l, 'liveQuietAsk').hidden, true);
  l.fire('onMeetingUpdate', LIVE({ quiet: { text: QA1 }, finalizing: true, stopping: true })); await l.drain();
  assert.strictEqual($(l, 'liveQuietAsk').hidden, true, '作成中に聞いた');
  l.fire('onMeetingUpdate', { active: false }); await l.drain();
  assert.ok(!inTree(l, 'liveQuietAsk'), '会議が終わっても帯が残った');
  // quiet の無い古い main の答えでも落ちない
  l.fire('onMeetingUpdate', LIVE({ quiet: undefined })); await l.drain();
  assert.strictEqual($(l, 'liveQuietAsk').hidden, true);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
