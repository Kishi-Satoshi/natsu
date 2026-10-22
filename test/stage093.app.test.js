/*
 * stage093.app.test.js — 0.9.3 の本体の画面と録音バーの画面（計画 docs/plans/2026-10-22-093.md の Task M-4・M-5・M-6）
 * M-4: ［設定］→［録音］の頭のカード「会議の検出」（会議の検出の通知のオンオフ・通知を出さないアプリ）と、パネルからの app:open-settings。
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。main の答えは偽物（preload.js の名前から作る）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { parseHTML } = require('./helpers/simdom');
const lib = require('../src/mainlib');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const html = fs.readFileSync(APP, 'utf8');
const doc = parseHTML(html).root;
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const LIST = [{ id: 'pa1', title: '定例（見本）', date: '10/16', durationSec: 1800, hasSummary: true }];
const PAGE = (id) => ({ page: { id, title: '定例（見本）', createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
const UI = () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' } });
const open = (settings = {}, o = {}) => load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: () => LIST, pageGet: PAGE, uiState: UI, getSettings: () => ({ autoLaunch: false, ...settings }), ...o } });
const $ = (l, id) => l.document.getElementById(id);
const click = async (l, el) => { (typeof el === 'string' ? $(l, el) : el).dispatchEvent({ type: 'click' }); await l.drain(); };
const search = async (l, q) => { const b = $(l, 'setSearch'); b.value = q; b.dispatchEvent({ type: 'input', target: b }); await l.drain(); };
const visible = (el) => { for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) { if (n.id === 'settingsModal') return true; if (n.hidden || n.classList.contains('set-miss')) return false; } return true; };
const shownRows = (l) => l.byId.get('tabSettings').querySelectorAll('[data-row]').filter(visible).map((r) => r.dataset.row);
const saves = (l) => l.called('saveSettings').map((c) => c.args[0]);
const chips = (l) => $(l, 'meetingDetectMuteList').querySelectorAll('.chip').map((c) => norm(c.querySelector('span').textContent));

// ---------------------------------------------------------------- M-4: 設定「会議の検出」
test('M-4: ［設定］→［録音］の頭に「会議の検出」のカード（行は「会議の検出の通知」と「通知を出さないアプリ」）。見える説明は1行・ⓘ の吹き出しの芯', T, () => {
  const cards = doc.querySelector('#tabSettings .scroll').children.filter((c) => c.classList.contains('card') && c.dataset.sec === 'record');
  assert.strictEqual(norm(cards[0].querySelector('h2').textContent), '会議の検出');
  assert.deepStrictEqual(cards[0].querySelectorAll('[data-row]').map((r) => r.dataset.row), ['会議の検出の通知', '通知を出さないアプリ']);
  assert.strictEqual(norm(doc.querySelector('#meetingDetectDesc').textContent), '会議のアプリがマイクを使い始めたら、録音するか聞きます。');
  const pop = norm(doc.querySelector('#setPopDetect').textContent);
  for (const w of ['NaTsu は音を聞きません。', 'Windows の「マイクを使っているアプリ」の記録だけを見ます。', 'Teams・Zoom・Webex・Slack・ブラウザ（Chrome・Edge・Firefox。Google Meet など）',
    '録音しているときと、NaTsu が自分でマイクを使っているときは出しません。', '同じ会議では1度だけです。', '30 秒で消えます（カーソルを乗せている間は消えません）。', '押さなければ何も録りません。',
    '窓の題名・URL は読みません。何も外へ送りません。', 'Windows でだけ動きます。']) assert.ok(pop.includes(w), w);
  assert.strictEqual(doc.querySelector('#setPopDetect .setpop-help').dataset.help, 'record/meeting-detect');
  assert.ok(lib.HELP_ARTICLES.includes('record/meeting-detect'));
  // 一覧の名前は main の一覧と同じ（画面は mainlib を読めないので写しを持つ）
  const m = /const MEET_LABELS = (\{[^}]+\});/.exec(html);
  assert.ok(m, 'MEET_LABELS が無い');
  assert.deepStrictEqual(Function(`return ${m[1]}`)(), Object.fromEntries(lib.MEET_APPS.map((a) => [a.id, a.label])));
});

test('M-4: トグルは自動保存の引数に meetingDetect を入れる（既定オン）。出さないアプリの札は meetingDetectMute の id を一覧の名前で出し、× で外して保存する。一覧に無い id は出さない。空なら「ありません」', T, async () => {
  const l = await open({ meetingDetectMute: ['zoom', 'evil', 'chrome'] });
  await l.drain();
  assert.strictEqual($(l, 'meetingDetect').checked, true, '既定（無い）でオンになっていない');
  assert.deepStrictEqual(chips(l), ['Zoom', 'Chrome（ブラウザ）']);
  const xs = $(l, 'meetingDetectMuteList').querySelectorAll('.chip button');
  assert.deepStrictEqual(xs.map((b) => b.getAttribute('aria-label')), ['「Zoom」でもまた通知を出す', '「Chrome（ブラウザ）」でもまた通知を出す']);
  await click(l, xs[0]);
  assert.deepStrictEqual(chips(l), ['Chrome（ブラウザ）']);
  assert.deepStrictEqual(saves(l).pop().meetingDetectMute, ['chrome']);
  await click(l, $(l, 'meetingDetectMuteList').querySelectorAll('.chip button')[0]);
  assert.deepStrictEqual(chips(l), []);
  assert.strictEqual(norm($(l, 'meetingDetectMuteList').textContent), 'ありません');
  assert.deepStrictEqual(saves(l).pop().meetingDetectMute, []);
  $(l, 'meetingDetect').checked = false;
  $(l, 'tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.strictEqual(saves(l).pop().meetingDetect, false);
  const off = await open({ meetingDetect: false });
  await off.drain();
  assert.strictEqual($(off, 'meetingDetect').checked, false);
  assert.deepStrictEqual(l.errors, []);
});

test('M-4: main の settings:patched（パネルの「<アプリ> では出さない」）で札を描き直す。一覧に無い id・配列でない値は捨てる', T, async () => {
  const l = await open({});
  await l.drain();
  l.fire('onSettingsPatched', { meetingDetectMute: ['teams', 'nope'] });
  await l.drain();
  assert.deepStrictEqual(chips(l), ['Teams']);
  l.fire('onSettingsPatched', { meetingDetectMute: 'zoom' });
  await l.drain();
  assert.deepStrictEqual(chips(l), ['Teams']);
  // 次の自動保存は今の札を送る（古い札で上書きしない）
  $(l, 'tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.deepStrictEqual(saves(l).pop().meetingDetectMute, ['teams']);
});

test('M-4: onOpenSettings で設定を開き、録音の項目の「会議の検出」のカードを見せる。知らない項目は「一般」', T, async () => {
  const l = await open({});
  await l.drain();
  l.fire('onOpenSettings', { sec: 'record', row: '会議の検出の通知' });
  await l.drain();
  assert.strictEqual($(l, 'settingsModal').hidden, false);
  assert.strictEqual(norm($(l, 'setTitle').textContent), '録音');
  assert.ok(visible($(l, 'meetingDetect')), '会議の検出の行が見えない');
  l.fire('onOpenSettings', { sec: '../x' });
  await l.drain();
  assert.strictEqual(norm($(l, 'setTitle').textContent), '一般');
});

test('M-4: 検索「検出」「Zoom」で「会議の検出の通知」の行が出る', T, async () => {
  const l = await open({});
  await l.drain();
  await click(l, 'tabBtnSettings');
  await search(l, '検出');
  assert.ok(shownRows(l).includes('会議の検出の通知'), JSON.stringify(shownRows(l)));
  await search(l, 'Zoom');
  assert.ok(shownRows(l).includes('会議の検出の通知'), JSON.stringify(shownRows(l)));
});

// ---------------------------------------------------------------- M-5: 録音バーが音の大きさを答える受け口（決めたこと 15。問い Q1）
const OVL = path.join(ROOT, 'src', 'renderer', 'overlay.html');
function 音を決める(l) {
  const made = [];
  l.window.AudioContext.prototype.createAnalyser = function createAnalyser() {
    const a = { fftSize: 512, smoothingTimeConstant: 0, fill: 128, connect: (x) => x, disconnect() {}, getByteTimeDomainData(arr) { arr.fill(this.fill); } };
    made.push(a);
    return a;
  };
  l.window.navigator.mediaDevices.getDisplayMedia = () => {
    const track = { stop() {}, kind: 'audio', enabled: true, addEventListener() {}, getSettings: () => ({ channelCount: 1 }) };
    return Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [], removeTrack() {}, addTrack() {}, active: true });
  };
  return made;
}
const fillFor = (level) => 128 + Math.round((level * 128) / 3.4);
async function 録音バー(start = {}, frames = 0) {
  const l = await load(OVL, { frames });
  const an = 音を決める(l);
  l.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false, ...start });
  await l.drain();
  return { l, an };
}
const levels = (l) => l.called('reportLevel').map((c) => c.args[0]);

test('M-5・M8: onLevelAsk を受けると reportLevel を1回（毎フレームの描きを回さなくても答える: 録音バーを隠しても止まらない）。mic・sys は rmsOf の値、warn は今の文', T, async () => {
  const { l, an } = await 録音バー({ systemAudio: true });
  an[0].fill = fillFor(0.5);
  an[1].fill = fillFor(0.25);
  assert.strictEqual(l.fire('onLevelAsk'), 1, '受け口が無い');
  await l.drain();
  const r = levels(l);
  assert.strictEqual(r.length, 1);
  assert.ok(Math.abs(r[0].mic - 0.5) < 0.03 && Math.abs(r[0].sys - 0.25) < 0.03, JSON.stringify(r[0]));
  assert.strictEqual(r[0].warn, '');
  assert.deepStrictEqual(l.errors, []);
});

test('M-5: analyser が無い（録音の前・一時停止で捨てた）なら 0・0。無音の警告が出ていれば warn はその文（shownLabel と同じ）', T, async () => {
  const before = await load(OVL, { frames: 0 });
  before.fire('onLevelAsk');
  await before.drain();
  assert.deepStrictEqual(levels(before), [{ mic: 0, sys: 0, warn: '' }]);
  const { l } = await 録音バー({}, 400);
  l.clock.jump(8001);
  await l.drain();
  l.fire('onLevelAsk');
  await l.drain();
  assert.strictEqual(levels(l).pop().warn, '音が入っていません');
  l.byId.get('pauseBtn').click();
  await l.drain();
  l.fire('onLevelAsk');
  await l.drain();
  const p = levels(l).pop();
  assert.deepStrictEqual([p.mic, p.sys], [0, 0], '一時停止中に音の大きさを答えた');
});
