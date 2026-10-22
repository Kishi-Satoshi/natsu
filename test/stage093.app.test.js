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
const chips = (l) => $(l, 'meetingDetectMuteList').querySelectorAll('.mutechip').map((c) => norm(c.querySelector('span').textContent));

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

// CI run 39745472232 の electron-smoke で、出さないアプリの札を前は .chip の規則で描いていたので、検索の窓の絞り込みの札（.chip。#fltAll など）の形まで変わり、
// search-palette-light が基準と 17306 画素違って赤になった。札は自分の名前（.mutechip）で描き、.chip を決める規則は 0.9.2 の1つ（と :hover・.on）のまま
test('M-4: 出さないアプリの札は .mutechip で描き、検索の窓の札（.chip）の規則を足さない（search-palette-light を変えない）', T, async () => {
  const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
  assert.strictEqual((style.match(/^\s*\.chip\s*\{/gm) || []).length, 1, '.chip の規則がふえた');
  assert.deepStrictEqual((style.match(/^\s*\.chip(?![-\w])[^\n{]*\{/gm) || []).map((x) => x.trim()), ['.chip {', '.chip:hover {', '.chip.on {']);
  const l = await open({ meetingDetectMute: ['zoom'] });
  await l.drain();
  const box = $(l, 'meetingDetectMuteList');
  assert.strictEqual(box.querySelectorAll('.chip').length, 0);
  assert.strictEqual(box.querySelectorAll('.mutechip').length, 1);
});

test('M-4: トグルは自動保存の引数に meetingDetect を入れる（既定オン）。出さないアプリの札は meetingDetectMute の id を一覧の名前で出し、× で外して保存する。一覧に無い id は出さない。空なら「ありません」', T, async () => {
  const l = await open({ meetingDetectMute: ['zoom', 'evil', 'chrome'] });
  await l.drain();
  assert.strictEqual($(l, 'meetingDetect').checked, true, '既定（無い）でオンになっていない');
  assert.deepStrictEqual(chips(l), ['Zoom', 'Chrome（ブラウザ）']);
  const xs = $(l, 'meetingDetectMuteList').querySelectorAll('.mutechip button');
  assert.deepStrictEqual(xs.map((b) => b.getAttribute('aria-label')), ['「Zoom」でもまた通知を出す', '「Chrome（ブラウザ）」でもまた通知を出す']);
  await click(l, xs[0]);
  assert.deepStrictEqual(chips(l), ['Chrome（ブラウザ）']);
  assert.deepStrictEqual(saves(l).pop().meetingDetectMute, ['chrome']);
  await click(l, $(l, 'meetingDetectMuteList').querySelectorAll('.mutechip button')[0]);
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

// ---------------------------------------------------------------- M-6: 音の波と「聞き取り中」の行（決めたこと 16〜21）
const LIVE = (o = {}) => ({ active: true, startedAt: Date.now() - 60000, segments: [{ id: 's1', atMs: 0, text: '本日の議題です。' }], pauses: [], cloud: true,
  stt: { route: 'cloud', lastTextAt: Date.now() - 5000, segSec: 15, problem: null }, ...o });
async function liveOpen(o = {}, st = {}) {
  const l = await open({}, o);
  await l.drain();
  l.fire('onMeetingUpdate', LIVE(st));
  await l.drain();
  return l;
}
const bars = (l) => $(l, 'liveWave').children.filter((e) => e.tagName === 'i').map((i) => parseFloat(i.style.height));
// 「聞き取り中」の行（drawLive が描き直すたびに作り直すので、id の写しでなく今の #pScript の中を引く）
const tail = (l) => $(l, 'pScript').querySelectorAll('.livetail')[0] || null;
const level = async (l, mic, sys = 0, warn = '') => { l.fire('onMeetingLevel', { mic, sys, warn }); await l.drain(); };

test('waveHeights の表（0・0.02 → 3・0.021 → 3 より大きい・0.8 以上 → 16・NaN → 3・20 本より多い値は右の 20 本）', T, async () => {
  // 画面の waveHeights（純粋な関数。外の名前を使わない）を取り出して試す
  const m = /\n  function waveHeights\(levels\) \{[\s\S]*?\n  \}\n/.exec(html);
  assert.ok(m, 'app.html に waveHeights が無い');
  const H = Function(`${m[0]}; return waveHeights;`)();
  assert.deepStrictEqual(H([]), Array(20).fill(3));
  assert.strictEqual(H([0]).pop(), 3);
  assert.strictEqual(H([0.02]).pop(), 3);
  assert.ok(H([0.021]).pop() > 3);
  assert.strictEqual(H([0.8]).pop(), 16);
  assert.strictEqual(H([5]).pop(), 16);
  assert.strictEqual(H([NaN]).pop(), 3);
  assert.strictEqual(H(['0.5']).pop(), 3);
  const many = Array.from({ length: 25 }, (_, i) => (i < 5 ? 0.8 : 0));
  assert.deepStrictEqual(H(many), Array(20).fill(3), '20 本より多い値で左の値を使った');
  assert.strictEqual(H([0.5]).length, 20);
});

test('M8: onMeetingLevel を 20 回受けると 20 本が右から埋まる（大きい方の値）。1 秒届かなければ全部 3px。warn は届いた文をそのまま #liveWaveNote に（文が同じなら書き直さない）', T, async () => {
  const l = await liveOpen();
  assert.strictEqual($(l, 'liveWaveBox').hidden, false, '録音中のページに波が無い');
  assert.deepStrictEqual(bars(l), Array(20).fill(3), '届く前から波が立っている');
  await level(l, 0.1, 0.8);
  assert.strictEqual(bars(l)[19], 16, '右の端に入らない・大きい方の値でない');
  assert.strictEqual(bars(l)[18], 3);
  for (let i = 0; i < 19; i++) await level(l, 0.8);
  assert.deepStrictEqual(bars(l), Array(20).fill(16));
  assert.ok(!$(l, 'liveWave').classList.contains('quiet'));
  // 描き直しは 0.5 秒ごと（録音中のページの時計と同じ）なので、1 秒を越えた次の描き直しで平らになる
  await l.clock.advance(1600);
  await l.drain();
  assert.deepStrictEqual(bars(l), Array(20).fill(3), '1 秒届かないのに波が残った');
  assert.ok($(l, 'liveWave').classList.contains('quiet'), '平らなのに無音の点の色でない');
  await level(l, 0, 0, '音が入っていません');
  assert.strictEqual($(l, 'liveWaveNote').textContent, '音が入っていません');
  assert.ok($(l, 'liveWaveNote').classList.contains('warn'));
  const note = $(l, 'liveWaveNote');
  let writes = 0;
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(note), 'textContent');
  Object.defineProperty(note, 'textContent', { get() { return desc.get.call(this); }, set(v) { writes += 1; desc.set.call(this, v); }, configurable: true });
  await level(l, 0, 0, '音が入っていません');
  assert.strictEqual(writes, 0, '同じ文を書き直した（読み上げが繰り返す）');
  await level(l, 0.5, 0, '');
  assert.strictEqual(note.textContent, '');
  assert.deepStrictEqual(l.errors, []);
});

test('M8: 一時停止（meeting:update の paused）で列を空にし「一時停止中」。再開で戻る', T, async () => {
  const l = await liveOpen();
  await level(l, 0.8);
  l.fire('onMeetingUpdate', LIVE({ paused: true }));
  await l.drain();
  assert.deepStrictEqual(bars(l), Array(20).fill(3));
  assert.ok($(l, 'liveWave').classList.contains('paused'));
  assert.strictEqual($(l, 'liveWaveNote').textContent, '一時停止中');
  assert.ok(!$(l, 'liveWaveNote').classList.contains('warn'));
  await level(l, 0.8);
  assert.deepStrictEqual(bars(l), Array(20).fill(3), '一時停止中に波が立った');
  l.fire('onMeetingUpdate', LIVE({ paused: false }));
  await l.drain();
  assert.ok(!$(l, 'liveWave').classList.contains('paused'));
  assert.strictEqual($(l, 'liveWaveNote').textContent, '');
  await level(l, 0.8);
  assert.strictEqual(bars(l)[19], 16);
});

test('#liveWave は #paneBtnScript のすぐ後ろ・aria-hidden・録音中のタブで会議の録音中だけ（保存したページ・作成中に無い）。文は role=status', T, async () => {
  const box = doc.querySelector('#liveWaveBox');
  assert.ok(box && box.hasAttribute('hidden'), '初めから出ている');
  const tabs = doc.querySelector('#paneBtnScript').parentNode.children;
  assert.strictEqual(tabs[tabs.indexOf(doc.querySelector('#paneBtnScript')) + 1], box, '#paneBtnScript のすぐ後ろに無い');
  assert.strictEqual(doc.querySelector('#liveWave').getAttribute('aria-hidden'), 'true');
  assert.strictEqual(doc.querySelector('#liveWave').querySelectorAll('i').length, 20);
  assert.strictEqual(doc.querySelector('#liveWaveNote').getAttribute('role'), 'status');
  const l = await liveOpen();
  assert.strictEqual($(l, 'liveWaveBox').hidden, false);
  l.fire('onMeetingUpdate', LIVE({ finalizing: true }));
  await l.drain();
  assert.strictEqual($(l, 'liveWaveBox').hidden, true, '作成中に波を出した');
  const p = await open({});
  await p.drain();
  p.fire('onPageOpen', 'pa1');
  await p.drain();
  assert.strictEqual($(p, 'liveWaveBox').hidden, true, '保存したページに波を出した');
});

test('動きを減らす設定では流さず、真ん中の5本だけが今の大きさで動き、ほかは 3px', T, async () => {
  const l = await liveOpen({}, {});
  const r = await load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: () => LIST, pageGet: PAGE, uiState: UI, getSettings: () => ({ autoLaunch: false }) },
    matchMedia: (q) => ({ matches: /prefers-reduced-motion: reduce/.test(q), addEventListener() {}, addListener() {} }) });
  await r.drain();
  r.fire('onMeetingUpdate', LIVE());
  await r.drain();
  await level(r, 0.8);
  const b = bars(r);
  assert.deepStrictEqual(b.filter((_, i) => i < 7 || i > 11), Array(15).fill(3), '真ん中の5本のほかが動いた');
  assert.ok(b.slice(7, 12).every((h) => h > 3), JSON.stringify(b));
  assert.deepStrictEqual(b.slice(7, 12), [...b.slice(7, 12)].reverse(), '左右対称でない');
  await level(r, 0);
  assert.deepStrictEqual(bars(r), Array(20).fill(3));
  assert.ok(l);
});

test('M10: #liveTail は録音中（一時停止でない）の #pScript の一番下にあり、.seg でない。文は segSec から。segSec が無ければ「聞き取り中…」だけ。時刻の欄は空', T, async () => {
  const l = await liveOpen();
  const box = $(l, 'pScript');
  const last = box.children[box.children.length - 1];
  assert.strictEqual(last.id, 'liveTail');
  assert.ok(!last.classList.contains('seg'), '「聞き取り中」の行を区間にした');
  assert.strictEqual(norm(last.textContent), '聞き取り中…（約 15 秒ごとに文字になります）');
  assert.strictEqual(last.querySelector('.at').textContent, '');
  assert.strictEqual(box.querySelectorAll('.seg').length, 1, '区間の数がずれた');
  l.fire('onMeetingUpdate', LIVE({ stt: { route: 'local', lastTextAt: null, segSec: 75, problem: null } }));
  await l.drain();
  assert.strictEqual(norm(tail(l).textContent), '聞き取り中…（約 75 秒ごとに文字になります）');
  l.fire('onMeetingUpdate', LIVE({ stt: { route: 'cloud', lastTextAt: null, problem: null } }));
  await l.drain();
  assert.strictEqual(norm(tail(l).textContent), '聞き取り中…');
  l.fire('onMeetingUpdate', LIVE({ paused: true }));
  await l.drain();
  assert.strictEqual(tail(l), null, '一時停止中も「聞き取り中」の行を出した');
  l.fire('onMeetingUpdate', LIVE({ finalizing: true }));
  await l.drain();
  assert.strictEqual(tail(l), null, '作成中も「聞き取り中」の行を出した');
});

// CI run 39751610440 の撮った画面（live-wave-light など）で、「聞き取り中」の行が時刻の欄を持たず、文字起こしの左の線に寄って区間の文と揃わなかった
// （計画の決めたこと 20「時刻の欄は空」）。区間の行（.seg）と同じ並び・余白・時刻の欄の幅にする
test('M10: 「聞き取り中」の行は区間の行（.seg）と同じ並び（flex・gap 10px・余白 4px 6px・15px/24px）で、空の時刻の欄が 44px（文が区間の文と揃う）', T, () => {
  const rule = (sel) => { const m = new RegExp(`\\n  ${sel.replace(/[.*]/g, '\\$&')} \\{([^}]*)\\}`).exec(html); assert.ok(m, `${sel} の規則が無い`); return m[1]; };
  const seg = rule('.seg');
  const tail = rule('.livetail');
  for (const p of ['display: flex', 'gap: 10px', 'padding: 4px 6px', 'font-size: 15px', 'line-height: 24px']) {
    assert.ok(seg.includes(p), `.seg に ${p} が無い（区間の行が変わった）`);
    assert.ok(tail.includes(p), `.livetail に ${p} が無い`);
  }
  assert.match(rule('.seg .at'), /min-width: 44px/);
  assert.match(rule('.livetail .at'), /flex: none; min-width: 44px/);
});
