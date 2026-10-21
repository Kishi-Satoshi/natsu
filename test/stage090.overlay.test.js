/*
 * stage090.overlay.test.js — 0.9.0 の録音バーの見た目（計画 docs/plans/2026-10-20-090.md の O-3・O-4。設計書 D25・RP4〜RP9・F11・F16・F18）
 * 録音バー（src/renderer/overlay.html）を最小の DOM（test/helpers/simrun.js）の上で本当に走らせ、5つの点・相手の声の印・一時的な文・
 * ボタンの名前・大きさの知らせ・形を見る。録る処理（区間・WAV・一時停止・停止）は test/runtime.overlay.test.js が見続ける（F16）。
 * 撮る画面の見本（tools/shots/pill-states.js）は、本物の録音バーを同じ状態にしたときの DOM と同じであることもここで見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const C = require('./helpers/simcss.js');
const lib = require('../src/mainlib');
const PS = require('../tools/shots/pill-states');

const ROOT = path.join(__dirname, '..');
const OVL = path.join(ROOT, 'src', 'renderer', 'overlay.html');
const SRC = fs.readFileSync(OVL, 'utf8');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const CSS = () => C.parse([...SRC.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n'));

// 音の大きさを決められる偽の analyser（作られた順: マイク → 相手の声）。fill はバイトの値（128 が無音）
function 音を決める(log) {
  const made = [];
  log.window.AudioContext.prototype.createAnalyser = function createAnalyser() {
    const a = { fftSize: 512, smoothingTimeConstant: 0, fill: 128, connect: (x) => x, disconnect() {},
      getByteTimeDomainData(arr) { arr.fill(this.fill); } };
    made.push(a);
    return a;
  };
  // 相手の声の取り込み（simrun の既定の偽物は映像トラックの口を持たず、取り込めない扱いになる）。取り込めるストリームにする
  log.window.navigator.mediaDevices.getDisplayMedia = () => {
    const track = { stop() {}, kind: 'audio', enabled: true, addEventListener() {}, getSettings: () => ({ channelCount: 1 }) };
    return Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [], removeTrack() {}, addTrack() {}, active: true });
  };
  return made;
}
// rmsOf と同じ計算で、level（0〜1）になるバイトの値
const fillFor = (level) => 128 + Math.round((level * 128) / 3.4);

async function 録音を始める(start = {}, opt = {}) {
  const log = await load(OVL, { frames: 400, ...(opt.load || {}) });
  const an = 音を決める(log);
  if (opt.setup) opt.setup(log, an);
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false, ...start });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音の開始で例外');
  return { log, an };
}
const pillOf = (log) => log.byId.get('pill');
const dots = (log) => log.byId.get('lv').children.filter((e) => e.tagName === 'i').map((i) => parseFloat(i.style.getPropertyValue('--l')));
const msgText = (log) => log.byId.get('status').textContent;

test('RP5: ピルの中に、ロゴの SVG（assets/icon.svg と同じ3本の path）・ちょうど5つの点・時間・#pauseBtn・#stopBtn・#ngBtn があり、canvas と「記録中（相手の声も）」「議事録を記録中」の文が無い', async () => {
  const log = await load(OVL);
  assert.deepStrictEqual(log.errors.map(fmt), []);
  const pill = pillOf(log);
  const inPill = (el) => { for (let n = el; n; n = n.parentNode) if (n === pill) return true; return false; };
  const logo = log.root.querySelector('svg.logo');
  assert.ok(logo && inPill(logo), 'ロゴの SVG がピルの中に無い');
  const iconPaths = [...fs.readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8').matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(iconPaths.length, 3);
  assert.deepStrictEqual(logo.querySelectorAll('path').map((p) => p.getAttribute('d')), iconPaths, 'ロゴの path が assets/icon.svg と違う');
  assert.ok(!/<img\b/i.test(SRC), '画像のファイルを読んでいる（CSP の img-src を広げない）');
  assert.strictEqual(log.byId.get('lv').children.filter((e) => e.tagName === 'i').length, 5, '点がちょうど5つでない');
  for (const id of ['lv', 'timer', 'status', 'pauseBtn', 'stopBtn', 'ngBtn', 'spk', 'micBadge']) assert.ok(log.byId.get(id) && inPill(log.byId.get(id)), `#${id} がピルの中に無い`);
  for (const id of ['pauseBtn', 'stopBtn', 'ngBtn']) assert.strictEqual(log.byId.get(id).tagName, 'button', `#${id} が本物の button でない`);
  assert.ok(!/<canvas/i.test(SRC), 'canvas が残っている');
  for (const t of ['記録中（相手の声も）', '議事録を記録中', '記録中（マイクのみ）']) assert.ok(!SRC.includes(t), `「${t}」の文が残っている`);
  assert.ok(SRC.includes('<title>NaTsu Overlay</title>'));
});

test('RP5: 無音（level 0）は5つとも 4px、声（level 0.6）は左から伸び、どれも 16px まで。縦の形でも同じ長さが入る。一時停止中は5つとも 4px で class paused', async () => {
  const { log, an } = await 録音を始める();
  assert.deepStrictEqual(dots(log), [4, 4, 4, 4, 4], '無音の点が 4px でない');
  an[0].fill = fillFor(0.6);
  await log.drain();
  const loud = dots(log);
  assert.ok(loud[0] > 4, `声で点が伸びない: ${loud}`);
  for (let i = 1; i < 5; i++) assert.ok(loud[i] <= loud[i - 1], `左ほど早く伸びていない: ${loud}`);
  assert.ok(loud.every((x) => x >= 4 && x <= 16), `点が 4〜16px の外: ${loud}`);
  an[0].fill = fillFor(1);
  await log.drain();
  assert.ok(dots(log).every((x) => x <= 16), `最大の声で 16px を越えた: ${dots(log)}`);
  assert.strictEqual(dots(log)[0], 16);
  // 縦の形でも同じ長さ（CSS が横の長さに使う）
  an[0].fill = fillFor(0.6);
  log.fire('onForm', { form: 'v' });
  await log.drain();
  assert.strictEqual(pillOf(log).dataset.form, 'v');
  assert.deepStrictEqual(dots(log), loud);
  // 一時停止
  log.byId.get('pauseBtn').click();
  await log.drain();
  assert.ok(pillOf(log).classList.contains('paused'));
  assert.deepStrictEqual(dots(log), [4, 4, 4, 4, 4], '一時停止中の点が平らでない');
  assert.deepStrictEqual(log.errors.map(fmt), []);
});

test('RP6: 相手の声を録る設定の議事録で、相手の音がある間だけ #spk が on、無ければ idle、取り込めなければ ng とはじめの 4 秒「相手の声を録れません」。録らない設定・音声入力では #spk が hidden', async () => {
  const { log, an } = await 録音を始める({ systemAudio: true });
  const spk = log.byId.get('spk');
  assert.strictEqual(spk.hidden, false, '相手の声を録るのに印が無い');
  assert.ok(spk.classList.contains('idle') && !spk.classList.contains('on'), `相手が無音なのに ${spk.className}`);
  an[1].fill = fillFor(0.5);
  await log.drain();
  assert.ok(spk.classList.contains('on') && !spk.classList.contains('idle'), `相手の音で on にならない: ${spk.className}`);
  an[1].fill = 128;
  await log.drain();
  assert.ok(spk.classList.contains('idle'), '相手が黙っても on のまま');
  // 取り込めなかった
  const ng = await 録音を始める({ systemAudio: true }, { setup: (l) => { l.window.navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new Error('NotAllowedError')); } });
  const s2 = ng.log.byId.get('spk');
  assert.ok(!s2.hidden && s2.classList.contains('ng'), `取り込めないのに ng でない: ${s2.className}`);
  assert.strictEqual(msgText(ng.log), '相手の声を録れません');
  await ng.log.clock.advance(4000);
  assert.strictEqual(msgText(ng.log), '', '4 秒で引っ込まない');
  assert.ok(s2.classList.contains('ng'), '文が引っ込んだら印も消えた');
  // 録らない設定・音声入力
  for (const start of [{ systemAudio: false }, { mode: 'dictation', systemAudio: true }]) {
    const r = await 録音を始める(start);
    assert.strictEqual(r.log.byId.get('spk').hidden, true, `${JSON.stringify(start)} で印が出た`);
  }
});

test('RP6: 8 秒の無音で class warn と「音が入っていません」、音が戻ると消える（4 秒で引っ込めない）。相手の声を録っていてマイクだけ 60 秒無音なら「マイクの音が入っていません」', async () => {
  const { log, an } = await 録音を始める();
  log.clock.jump(8001);
  await log.drain();
  assert.ok(pillOf(log).classList.contains('warn'), '8 秒の無音で warn にならない');
  assert.strictEqual(msgText(log), '音が入っていません');
  await log.clock.advance(10000);   // 時限を進めても、音が戻るまで出したまま
  await log.drain();
  assert.strictEqual(msgText(log), '音が入っていません', '無音の警告が音の戻る前に引っ込んだ');
  an[0].fill = fillFor(0.5);
  await log.drain();
  assert.ok(!pillOf(log).classList.contains('warn'), '音が戻っても warn のまま');
  assert.strictEqual(msgText(log), '');
  // マイクだけが無音（相手の声はある）
  const r = await 録音を始める({ systemAudio: true });
  r.an[1].fill = fillFor(0.5);
  await r.log.drain();
  r.log.clock.jump(8001);
  await r.log.drain();
  assert.ok(!pillOf(r.log).classList.contains('warn'), '相手の声があるのに 8 秒で警告した');
  r.log.clock.jump(60000);
  await r.log.drain();
  assert.strictEqual(msgText(r.log), 'マイクの音が入っていません');
  assert.ok(pillOf(r.log).classList.contains('warn'));
});

test('RP6: 既定のマイクで代替なら #micBadge が出て、はじめの 4 秒「既定のマイクで録音中」', async () => {
  const setup = (l) => {
    l.window.navigator.mediaDevices.getUserMedia = () => {
      const track = { stop() {}, kind: 'audio', enabled: true, addEventListener() {}, getSettings: () => ({ deviceId: 'other', channelCount: 1 }) };
      return Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track], addTrack() {}, active: true });
    };
  };
  const { log } = await 録音を始める({ micId: 'chosen' }, { setup });
  assert.strictEqual(log.byId.get('micBadge').hidden, false, '代替なのに角の点が無い');
  assert.strictEqual(msgText(log), '既定のマイクで録音中');
  await log.clock.advance(4000);
  assert.strictEqual(msgText(log), '');
  assert.strictEqual(log.byId.get('micBadge').hidden, false, '文が引っ込んだら角の点も消えた');
  const ok = await 録音を始める({ micId: '' });
  assert.strictEqual(ok.log.byId.get('micBadge').hidden, true);
});

test('RP7: keyLabel は画面の書き方（Control → Ctrl・Super → Win）。空は空', () => {
  assert.strictEqual(lib.keyLabel('Control+Shift+Space'), 'Ctrl+Shift+Space');
  assert.strictEqual(lib.keyLabel('Super+K'), 'Win+K');
  assert.strictEqual(lib.keyLabel('CommandOrControl+Alt+M'), 'Ctrl+Alt+M');
  assert.strictEqual(lib.keyLabel('Alt+M'), 'Alt+M');
  for (const v of ['', null, undefined, 5]) assert.strictEqual(lib.keyLabel(v), '');
});

test('RP7: keys の入った議事録の停止は「停止して議事録を作成（Alt+M）」、音声入力は「停止して文字起こし（Ctrl+Shift+Space）」とキャンセル「キャンセル（Esc）」。議事録では #ngBtn、音声入力では #pauseBtn が出ない。keys が無ければキーを付けない', async () => {
  const name = (log, id) => [log.byId.get(id).getAttribute('title'), log.byId.get(id).getAttribute('aria-label')];
  const m = await 録音を始める({ keys: { stop: 'Alt+M', cancel: 'Esc' } });
  assert.deepStrictEqual(name(m.log, 'stopBtn'), ['停止して議事録を作成（Alt+M）', '停止して議事録を作成（Alt+M）']);
  assert.deepStrictEqual(name(m.log, 'pauseBtn'), ['一時停止 / 再開', '一時停止 / 再開']);
  assert.strictEqual(m.log.byId.get('ngBtn').hidden, true, '議事録で ✕ を出した');
  assert.strictEqual(m.log.byId.get('pauseBtn').hidden, false);
  const d = await 録音を始める({ mode: 'dictation', keys: { stop: 'Ctrl+Shift+Space', cancel: 'Esc' } });
  assert.deepStrictEqual(name(d.log, 'stopBtn'), ['停止して文字起こし（Ctrl+Shift+Space）', '停止して文字起こし（Ctrl+Shift+Space）']);
  assert.deepStrictEqual(name(d.log, 'ngBtn'), ['キャンセル（Esc）', 'キャンセル（Esc）']);
  assert.strictEqual(d.log.byId.get('pauseBtn').hidden, true, '音声入力で一時停止を出した');
  assert.strictEqual(d.log.byId.get('ngBtn').hidden, false);
  const n = await 録音を始める({ mode: 'dictation' });
  assert.deepStrictEqual(name(n.log, 'stopBtn'), ['停止して文字起こし', '停止して文字起こし']);
  assert.deepStrictEqual(name(n.log, 'ngBtn'), ['キャンセル', 'キャンセル']);
});

test('RP4: ピルの大きさが変わると reportSize が1回だけ呼ばれ、同じ大きさでは呼ばれない。onForm(v) で data-form が v になり、もう一度呼ばれる', async () => {
  const setup = (l) => { l.byId.get('pill')._rect = { width: 236, height: 40 }; };
  const { log } = await 録音を始める({}, { setup });
  const sizes = () => log.called('reportSize').map((c) => c.args[0]);
  assert.deepStrictEqual(sizes(), [{ w: 236, h: 40, form: 'h' }]);
  log.fire('onPhase', { phase: 'recording' });
  log.byId.get('pauseBtn').click();
  await log.drain();
  assert.strictEqual(sizes().length, 1, '同じ大きさでも送った');
  pillOf(log)._rect = { width: 300, height: 40 };
  log.fire('onForm', { form: 'h' });
  await log.drain();
  assert.deepStrictEqual(sizes().slice(1), [{ w: 300, h: 40, form: 'h' }]);
  pillOf(log)._rect = { width: 40, height: 236 };
  log.fire('onForm', { form: 'v' });
  await log.drain();
  assert.strictEqual(pillOf(log).dataset.form, 'v');
  assert.deepStrictEqual(sizes().slice(2), [{ w: 40, h: 236, form: 'v' }]);
  // 大きさ 0（描いていない）は送らない
  pillOf(log)._rect = { width: 0, height: 0 };
  log.fire('onForm', { form: 'h' });
  await log.drain();
  assert.strictEqual(sizes().length, 3);
  // 始めの合図の form でも形を決める
  const v = await 録音を始める({ form: 'v' });
  assert.strictEqual(pillOf(v.log).dataset.form, 'v');
});

test('RP4: preload に reportSize・onForm が無い古い版でも、録音は例外なく始まる', async () => {
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8').replace(/^\s{2}(reportSize|onForm):.*\n/gm, '');
  const { log } = await 録音を始める({}, { load: { preloadSrc: pre } });
  assert.deepStrictEqual(log.errors.map(fmt), []);
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), []);
});

// 色の差（決めたこと 29）。比べる組: 文字は地 #262626 と 4.5 以上、点・印は地と 3 以上、ボタンの中の印はそのボタンの地と 3 以上、赤い［停止］の地は地と 3 以上
test('RP5・RP6: 色の差 — 文は地 #262626 と 4.5 以上、点・印は 3 以上、ボタンの中の印はそのボタンの地と 3 以上、赤い［停止］の地は地と 3 以上', () => {
  const rules = CSS();
  const val = (sel, prop) => {
    const v = C.declsFor(rules, sel, { at: '' })[prop];
    assert.ok(v, `${sel} { ${prop} } が無い`);
    return C.firstColor(C.resolveVar(rules, v));
  };
  const bg = val('.pill', 'background');
  assert.deepStrictEqual(bg.slice(0, 3), [0x26, 0x26, 0x26]);
  const on = (fg, ground) => C.contrast(C.over(fg, ground), ground);
  const TEXT = [['.timer', 'color'], ['.pill.paused .timer', 'color'], ['.msg', 'color'], ['.msg.warn', 'color'], ['.msg.err', 'color'], ['.msg.ok', 'color']];
  for (const [sel, p] of TEXT) { const r = on(val(sel, p), bg); assert.ok(r >= 4.5, `${sel} の文字が地と ${r.toFixed(2)}`); }
  const MARKS = [['.lv i', 'background'], ['.pill.paused .lv i', 'background'], ['.pill.warn .lv i', 'background'],
    ['.spk .w', 'stroke'], ['.spk.idle .w', 'stroke'], ['.spk.ng', 'color'], ['.badge', 'background'], ['.spin', 'border-top-color'], ['.okm', 'background']];
  for (const [sel, p] of MARKS) { const r = on(val(sel, p), bg); assert.ok(r >= 3, `${sel} の印が地と ${r.toFixed(2)}`); }
  const btn = C.over(val('.pbtn', 'background'), bg);
  for (const [sel, p] of [['.pbtn .bar', 'background'], ['.pbtn.ng', 'color']]) { const r = on(val(sel, p), btn); assert.ok(r >= 3, `${sel} がボタンの地と ${r.toFixed(2)}`); }
  const red = C.over(val('.pbtn.stop', 'background'), bg);
  assert.ok(C.contrast(red, bg) >= 3, `赤い［停止］が地と ${C.contrast(red, bg).toFixed(2)}`);
  assert.ok(on(val('.pbtn .sq', 'background'), red) >= 3, '停止の白い四角が赤い地と 3 より低い');
  // 完了の緑の丸の上の ✓（O-3 で作るときに足した: 暗い ✓ はゲートのインクの向きに当たるので、白い ✓ と濃い緑にした）
  const green = C.over(val('.okm', 'background'), bg);
  assert.ok(on(val('.okm', 'color'), green) >= 3, `完了の ✓ が緑の丸と ${on(val('.okm', 'color'), green).toFixed(2)}`);
  const white = C.over(val('.pill.paused .pbtn.pause', 'background'), bg);
  assert.ok(on(val('.pbtn .tri', 'border-left-color'), white) >= 3, '再開の三角が白い丸と 3 より低い');
});

test('RP5: .pill に外向きの影・backdrop-filter・グラデーションが無い。#hideBtn 以外のピルの部品も同じ', () => {
  for (const r of CSS()) {
    if (r.at.startsWith('@keyframes')) continue;
    for (const [k, v] of Object.entries(r.decls)) {
      assert.ok(!/backdrop-filter/.test(k), `${r.sel} に ${k}`);
      assert.ok(!/gradient\(/.test(v), `${r.sel} { ${k}: ${v} } にグラデーション`);
      if (k === 'box-shadow') assert.ok(/^\s*(inset|none)/.test(v), `${r.sel} に外向きの影: ${v}`);
      assert.ok(!(k === 'filter' && /blur|drop-shadow/.test(v)), `${r.sel} に ${v}`);
    }
  }
});

// O-3 で作るときに撮った画像で見つけた: 「.pbtn .tri { display: block }」が後ろにあって、録音中も［‖］の上に［▶］の三角が出ていた
test('RP5: 一時停止していない間は［▶］の三角を出さない（三角の display を決めるのは .pbtn .resume-ico と一時停止中の規則の2つだけ）', () => {
  const rules = CSS().filter((r) => !r.at && /\.(tri|resume-ico)\b/.test(r.sel) && r.decls.display !== undefined);
  assert.deepStrictEqual(rules.map((r) => [r.sel, r.decls.display]), [['.pbtn .resume-ico', 'none'], ['.pill.paused .pbtn .resume-ico', 'block']]);
  assert.match(SRC, /<span class="tri resume-ico"><\/span>/);
});

test('F18: .pill は flex: none と width: max-content（縦は height: max-content）、.msg は max-width と text-overflow: ellipsis', () => {
  const rules = CSS();
  const d = (sel) => C.declsFor(rules, sel, { at: '' });
  assert.strictEqual(d('.pill').flex, 'none', '.pill が窓の幅に縮む（測った幅が窓の幅になる）');
  assert.strictEqual(d('.pill').width, 'max-content');
  assert.strictEqual(d('.pill[data-form="v"]').height, 'max-content');
  assert.strictEqual(d('.msg')['max-width'], '360px');
  assert.strictEqual(d('.msg')['text-overflow'], 'ellipsis');
  assert.strictEqual(d('.msg').overflow, 'hidden');
});

test('RP5: 縦の形の時間は1時間までは分:秒、越えたら時:分。横の形は今の fmt（1時間を越えると時:分:秒）', async () => {
  const h = await 録音を始める();
  await h.log.clock.advance(61000);
  assert.strictEqual(h.log.byId.get('timer').textContent, '1:01');
  await h.log.clock.advance(3600000);
  assert.strictEqual(h.log.byId.get('timer').textContent, '1:01:01');
  const v = await 録音を始める({ form: 'v' });
  await v.log.clock.advance(754000);
  assert.strictEqual(v.log.byId.get('timer').textContent, '12:34');
  await v.log.clock.advance(3600000 - 754000 + 2 * 60000 + 5000);
  assert.strictEqual(v.log.byId.get('timer').textContent, '1:02');
});

test('RP6: 作成中・完了・エラーは形ごとの文（横は main の文、縦は短い文）。完了 1.6 秒・エラー 2.8 秒で隠すのは今のまま。音声入力の完了は「{秒} 秒・{文の頭}」', async () => {
  const h = await 録音を始める();
  h.log.fire('onPhase', { phase: 'processing', message: '議事録を作成中…' });
  assert.strictEqual(pillOf(h.log).dataset.phase, 'processing');
  assert.strictEqual(msgText(h.log), '議事録を作成中…');
  h.log.fire('onPhase', { phase: 'done', message: '議事録を保存しました' });
  assert.strictEqual(msgText(h.log), '議事録を保存しました');
  assert.ok(log0(h.log, 'status').classList.contains('ok'));
  await h.log.clock.advance(1600);
  assert.ok(!pillOf(h.log).classList.contains('visible'), '完了で 1.6 秒で隠さない');
  const v = await 録音を始める({ form: 'v' });
  v.log.fire('onPhase', { phase: 'processing', message: '議事録を作成中…' });
  // 0.9.0 見た目の直し（統合の後の見直し）で意図して変えた: 縦の形の文は縦向きの字（「…」は「︙」、「ー」は「︱」。下のテスト）
  assert.strictEqual(msgText(v.log), '作成中︙');
  v.log.fire('onPhase', { phase: 'done', message: '議事録を保存しました' });
  assert.strictEqual(msgText(v.log), '保存しました');
  const e = await 録音を始める({ form: 'v' });
  e.log.fire('onPhase', { phase: 'error', message: '議事録を保存できませんでした' });
  assert.strictEqual(msgText(e.log), 'エラ︱');
  assert.strictEqual(pillOf(e.log).getAttribute('title'), '議事録を保存できませんでした', '縦の形のエラーの文がピルの title に無い');
  await e.log.clock.advance(2799);
  assert.ok(pillOf(e.log).classList.contains('visible'));
  await e.log.clock.advance(1);
  assert.ok(!pillOf(e.log).classList.contains('visible'), 'エラーで 2.8 秒で隠さない');
  const d = await 録音を始める({ mode: 'dictation' });
  d.log.fire('onPhase', { phase: 'processing', message: '文字起こし中…' });
  assert.strictEqual(msgText(d.log), '文字起こし中…');
  d.log.fire('onPhase', { phase: 'done', message: '明日の定例は10時から', procSec: '1.2' });
  assert.strictEqual(msgText(d.log), '1.2 秒・明日の定例は10時から');
});
const log0 = (log, id) => log.byId.get(id);

// 0.9.0 見た目の直し（統合の後の見直し）: 縦の形の文は1字ずつの列に並べるので、横向きの字（伸ばす棒「ー」・「…」）は縦向きの字にして出す。
// 横の形のままだと「エラー」の「ー」が横棒に、「作成中…」の「…」が「中」の横に並ぶ（CI の撮った画面で見つけた）。横の形の文は今のまま
const SIDEWAYS = /[ー―—－‐~〜～…‥、。]/;
test('RP6: 縦の形の文は縦向きの字（「エラー」は「エラ︱」、「作成中…」は「作成中︙」）で、横向きの字が残らない。横の形は main の文のまま。形を替えると書き直す', async () => {
  const cases = [
    [{}, { phase: 'processing', message: '議事録を作成中…' }, '作成中︙', '議事録を作成中…'],
    [{ mode: 'dictation' }, { phase: 'processing', message: '文字起こし中…' }, '文字起こし中︙', '文字起こし中…'],
    [{}, { phase: 'processing', message: '知らない文…' }, '作成中︙', '知らない文…'],
    [{}, { phase: 'error', message: '議事録を保存できませんでした' }, 'エラ︱', '議事録を保存できませんでした'],
    [{}, { phase: 'error', message: 'キャンセルしました' }, 'キャンセル', 'キャンセルしました'],
    [{}, { phase: 'done', message: '議事録を保存しました' }, '保存しました', '議事録を保存しました'],
  ];
  for (const [start, ph, v, h] of cases) {
    const rv = await 録音を始める({ form: 'v', ...start });
    rv.log.fire('onPhase', ph);
    assert.strictEqual(msgText(rv.log), v, `縦: ${ph.message}`);
    assert.ok(!SIDEWAYS.test(msgText(rv.log)), `縦の文に横向きの字: ${msgText(rv.log)}`);
    const rh = await 録音を始める(start);
    rh.log.fire('onPhase', ph);
    assert.strictEqual(msgText(rh.log), h, `横: ${ph.message}`);
    assert.ok(!/[︱︙︰︑︒]/.test(msgText(rh.log)), `横の文に縦向きの字: ${msgText(rh.log)}`);
  }
  // 形を替えたら書き直す（横 → 縦で縦向き、縦 → 横で main の文）
  const r = await 録音を始める();
  r.log.fire('onPhase', { phase: 'processing', message: '議事録を作成中…' });
  r.log.fire('onForm', { form: 'v' });
  assert.strictEqual(msgText(r.log), '作成中︙');
  r.log.fire('onForm', { form: 'h' });
  assert.strictEqual(msgText(r.log), '議事録を作成中…');
  assert.deepStrictEqual(r.log.errors.map(fmt), []);
  // 1字ずつの列: 「︙」は行の頭に置けない字（禁則）なので、word-break だけでは「中」の横に並ぶ。どの字の間でも折り返し、幅は1字
  const vmsg = C.declsFor(CSS(), '.pill[data-form="v"][data-phase="processing"] .msg');
  assert.strictEqual(vmsg['line-break'], 'anywhere', '縦の文が禁則で2字並ぶ');
  assert.strictEqual(vmsg.width, 'min-content', '縦の文の幅が1字でない');
});

// 撮る画面の見本（tools/shots/pill-states.js）は、本物の録音バーをその状態にしたときと同じ DOM になる（撮る act が本物とずれない）
test('RP9: 撮る画面の見本の act は、本物の録音バーを同じ状態にしたときと同じ DOM（形・段階・印・点・文）になる', async () => {
  const drive = {
    rec: async (form) => { const r = await 録音を始める({ systemAudio: true, form }); r.an[0].fill = fillFor(PS.byState.rec.level); r.an[1].fill = fillFor(0.5); await r.log.drain(); return r.log; },
    silent: async (form) => (await 録音を始める({ systemAudio: true, form })).log,
    paused: async (form) => { const r = await 録音を始める({ systemAudio: true, form }); r.log.byId.get('pauseBtn').click(); await r.log.drain(); return r.log; },
    proc: async (form) => { const r = await 録音を始める({ form }); r.log.fire('onPhase', { phase: 'processing', message: '議事録を作成中…' }); return r.log; },
    done: async (form) => { const r = await 録音を始める({ form }); r.log.fire('onPhase', { phase: 'done', message: '議事録を保存しました' }); return r.log; },
    error: async (form) => { const r = await 録音を始める({ form }); r.log.fire('onPhase', { phase: 'error', message: '議事録を保存できませんでした' }); return r.log; },
    dict: async (form) => { const r = await 録音を始める({ mode: 'dictation', form }); r.an[0].fill = fillFor(PS.byState.dict.level); await r.log.drain(); return r.log; },
    warn: async (form) => { const r = await 録音を始める({ form }); r.log.clock.jump(8001); await r.log.drain(); return r.log; },
    // 0.9.1 Q-5: 話し声が無いので main が「会議は終わりましたか？」を overlay:phase の recording の文で送った形（無音の警告の点のまま、文だけ赤の短い文）
    quiet: async (form) => {
      const r = await 録音を始める({ form }); r.log.clock.jump(8001); await r.log.drain();
      r.log.fire('onPhase', { phase: 'recording', message: '会議は終わりましたか？' }); await r.log.drain(); return r.log;
    },
    fallback: async (form) => {
      const r = await 録音を始める({ micId: 'chosen', form }, { setup: (l) => { l.window.navigator.mediaDevices.getUserMedia = () => { const t = { stop() {}, kind: 'audio', enabled: true, addEventListener() {}, getSettings: () => ({ deviceId: 'other' }) }; return Promise.resolve({ getTracks: () => [t], getAudioTracks: () => [t], addTrack() {}, active: true }); }; } });
      r.an[0].fill = fillFor(PS.byState.fallback.level); await r.log.drain(); return r.log;
    },
    'spk-ng': async (form) => {
      const r = await 録音を始める({ systemAudio: true, form }, { setup: (l) => { l.window.navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new Error('x')); } });
      r.an[0].fill = fillFor(PS.byState['spk-ng'].level); await r.log.drain(); return r.log;
    },
  };
  // 0.9.1 Q-5 で意図して変えた: 状態 quiet（「会議は終わりましたか？」）を最後に足した
  assert.deepStrictEqual(PS.STATES.map((s) => s.state), ['rec', 'silent', 'paused', 'proc', 'done', 'error', 'dict', 'warn', 'fallback', 'spk-ng', 'quiet']);
  for (const s of PS.STATES) for (const form of PS.FORMS) {
    const real = PS.signature((await drive[s.state](form)).document);
    const shot = await load(OVL);
    new Function('document', PS.actFor(s.state, form, 'light'))(shot.document);   // eslint-disable-line no-new-func
    assert.deepStrictEqual(PS.signature(shot.document), real, `${s.state} ${form} の見本が本物とずれた`);
  }
  // 0.9.0 O-4: 縦の形の × が出た形（カーソルが乗った記録中）
  const real = await drive.rec('v');
  const rl = await (async () => { const r = await 録音を始める({ systemAudio: true, form: 'v' }); r.an[0].fill = fillFor(PS.byState.rec.level); r.an[1].fill = fillFor(0.5); r.log.fire('onHover', true); await r.log.drain(); return r.log; })();
  const shot = await load(OVL);
  new Function('document', PS.actFor('rec', 'v', 'dark', true))(shot.document);   // eslint-disable-line no-new-func
  assert.deepStrictEqual(PS.signature(shot.document), PS.signature(rl.document), '× の見本が本物とずれた');
  assert.ok(PS.signature(shot.document).classes.includes('hover') && PS.signature(shot.document).hideShown);
  assert.ok(!PS.signature(real.document).classes.includes('hover'));
});

test('RP4・F16: 録る処理の関数は今のまま（字面）— 区間・WAV・一時停止・停止・キャンセル・二重起動よけ・効果音', () => {
  for (const fn of ['blobToWav16k', 'openSystemStream', 'checkMicChoice', 'openStream', 'muteSystemForBeep', 'newRecorder', 'startDictation',
    'cutSegmentIfOverdue', 'rollSegment', 'settleSeg', 'sendSegmentQueued', 'startMeetingSegment', 'newClosing', 'releaseStream', 'beep']) {
    assert.ok(new RegExp(`function ${fn}\\(`).test(SRC), `${fn} が無い`);
  }
  assert.match(SRC, /if \(starting \|\| active\) return;/);
  assert.match(SRC, /const SEG_MIN_MS = 20000, SEG_MAX_MS = 300000;/);
});

// ---- O-4（RP8・F18）: 縦の形の ×（録音バーを隠す。録音は止めない）
test('RP8: 縦の形のときだけ #hideBtn があり、押すと hidePanel が1回。横の形には無い（押せない）', async () => {
  const h = await 録音を始める();
  const btn = h.log.byId.get('hideBtn');
  assert.ok(btn && btn.tagName === 'button', '#hideBtn が本物の button でない');
  for (let n = btn; n !== pillOf(h.log); n = n.parentNode) assert.ok(n, '#hideBtn がピルの中に無い');
  assert.strictEqual(btn.getAttribute('aria-label'), '録音バーを隠す');
  assert.strictEqual(btn.getAttribute('title'), '録音バーを隠す');
  assert.strictEqual(btn.hidden, true, '横の形に × がある');
  h.log.fire('onForm', { form: 'v' });
  await h.log.drain();
  assert.strictEqual(btn.hidden, false, '縦の形に × が無い');
  btn.click();
  await h.log.drain();
  assert.strictEqual(h.log.called('hidePanel').length, 1);
  assert.strictEqual(h.log.called('confirmStop').length + h.log.called('requestCancel').length, 0, '× で録音を止めた');
  h.log.fire('onForm', { form: 'h' });
  await h.log.drain();
  assert.strictEqual(btn.hidden, true, '横の形に戻っても × が残る');
  // 始めの合図の形でも決める
  const v = await 録音を始める({ form: 'v' });
  assert.strictEqual(v.log.byId.get('hideBtn').hidden, false);
  assert.deepStrictEqual([...h.log.errors, ...v.log.errors].map(fmt), []);
});

test('RP8: onHover(true) で .pill に hover が付き（main がカーソルを見る: Windows のドラッグの領域に :hover は来ない）、縦の形なら × が見える。横の形では見えない', async () => {
  const { log } = await 録音を始める({ form: 'v' });
  log.fire('onHover', true);
  await log.drain();
  assert.ok(pillOf(log).classList.contains('hover'));
  log.fire('onHover', false);
  await log.drain();
  assert.ok(!pillOf(log).classList.contains('hover'));
  log.fire('onHover', true);
  // 次の録音では hover を外して始める
  log.fire('onStop');
  await log.drain();
  await log.clock.advance(2000);
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, form: 'h' });
  await log.drain();
  assert.ok(!pillOf(log).classList.contains('hover'), '前の録音の hover が残った');
  // CSS: × は録音中の縦の形の .pill.hover と、そのピルの :hover のときだけ出す。横の形・hover でない・作成中のときは出さない
  const rules = CSS();
  const disp = (sel) => C.declsFor(rules, sel, { at: '' }).display;
  assert.strictEqual(disp('.hide'), 'none');
  const V = '.pill[data-form="v"][data-phase="recording"]';
  assert.ok(disp(`${V}.hover .hide`) && disp(`${V}.hover .hide`) !== 'none', '縦の形の hover で × が出ない');
  assert.ok(disp(`${V}:hover .hide`) && disp(`${V}:hover .hide`) !== 'none', '縦の形の :hover で × が出ない');
  for (const r of rules) {
    if (r.at || !/\.hide\b/.test(r.sel) || r.decls.display === undefined || r.decls.display === 'none') continue;
    assert.ok(r.sel.split(',').every((s) => s.includes(V)), `横の形か作成中にも × を出す規則: ${r.sel}`);
  }
  // 押せるように、ドラッグの領域から外す
  assert.strictEqual(C.declsFor(rules, '#hideBtn', { at: '' })['-webkit-app-region'], 'no-drag');
  // preload に hidePanel・onHover が無い古い版でも落ちない
  const pre = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8').replace(/^\s{2}(hidePanel|onHover):.*\n/gm, '');
  const old = await 録音を始める({ form: 'v' }, { load: { preloadSrc: pre } });
  old.log.byId.get('hideBtn').click();
  await old.log.drain();
  assert.deepStrictEqual(old.log.errors.map(fmt), []);
});
