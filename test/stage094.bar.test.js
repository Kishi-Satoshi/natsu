/*
 * stage094.bar.test.js — 0.9.4 Task P-1（計画 docs/plans/2026-10-22-094.md の3回目の節「Task P-1（作り直し）」と最後の問答の F1〜F5）: 録音バー
 * 持ち主の言葉: 「キャプチャのスピーカーのロゴはいらないです」・「録音を停止した時に✅のようなマークがでますが、見た目が悪いです。Notionと同じようにしてください。」
 * （Notion は「そのまますっと消える」）・「撮り終わった後の✅議事録を保存しました、の✅マークはもういらない。」・F2 止めたらすぐ薄く消える・F1 音声入力も同じ・
 * F3 保存の音は残す・F4 縦の形はロゴの角の黄色い点と説明の文「相手の声を録れません」・Q24 相手の声を録れない文を録音中ずっと。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const ROOT = path.join(__dirname, '..');
const OVL = path.join(ROOT, 'src', 'renderer', 'overlay.html');
const SRC = fs.readFileSync(OVL, 'utf8');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;

function 音を決める(log, sysOk) {
  log.window.AudioContext.prototype.createAnalyser = function createAnalyser() {
    return { fftSize: 512, smoothingTimeConstant: 0, fill: 128, connect: (x) => x, disconnect() {}, getByteTimeDomainData(arr) { arr.fill(this.fill); } };
  };
  log.window.navigator.mediaDevices.getDisplayMedia = sysOk
    ? () => { const track = { stop() {}, kind: 'audio', enabled: true, addEventListener() {}, getSettings: () => ({ channelCount: 1 }) };
      return Promise.resolve({ getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [], removeTrack() {}, addTrack() {}, active: true }); }
    : () => Promise.reject(new Error('NotAllowedError'));
}
async function start(st = {}, sysOk = true) {
  const log = await load(OVL, { frames: 200 });
  音を決める(log, sysOk);
  const beeps = [];
  log.window.AudioContext.prototype.createOscillator = function createOscillator() { const o = { frequency: { setValueAtTime() {}, value: 0 }, connect: (x) => x, start() {}, stop() {} }; return o; };
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: true, ...st });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), []);
  return { log, beeps };
}
const pill = (log) => log.byId.get('pill');
const msg = (log) => log.byId.get('status').textContent;

test('P-1: スピーカーの印（#spk・.spk・setSpeaker）が無く、✓（.okm）も無い', () => {
  assert.ok(!/id="spk"|\.spk\b|setSpeaker|spkState/.test(SRC), 'スピーカーの印が残っている');
  assert.ok(!/class="okm"|\.okm\b|✓/.test(SRC), '✓ が残っている');
});

test('P-1（Q24）: 相手の声を録れないときは「相手の声を録れません」を録音中ずっと出す（4 秒で消えない）。ほかの短い文が出ている間はそちら、消えたらまた戻る', async () => {
  const { log } = await start({}, false);
  assert.strictEqual(msg(log), '相手の声を録れません');
  await log.clock.advance(4500);
  assert.strictEqual(msg(log), '相手の声を録れません', '4 秒で消えた');
  log.fire('onPhase', { phase: 'recording', message: '会議は終わりましたか？' });
  await log.drain();
  assert.strictEqual(msg(log), '会議は終わりましたか？');
  await log.clock.advance(4500);
  assert.strictEqual(msg(log), '相手の声を録れません', 'ほかの文の後に戻らない');
  // 録れる会議では出さない
  const ok = await start({}, true);
  assert.strictEqual(msg(ok.log), '');
});

test('P-1（F4）: 縦の形では文の代わりに、ロゴの角の黄色い点（#micBadge）と説明の文（title）「相手の声を録れません」', async () => {
  const { log } = await start({ form: 'v' }, false);
  assert.strictEqual(pill(log).dataset.form, 'v');
  assert.strictEqual(log.byId.get('micBadge').hidden, false, '角の点が無い');
  assert.strictEqual(pill(log).getAttribute('title'), '相手の声を録れません');
  const ok = await start({ form: 'v' }, true);
  assert.strictEqual(ok.log.byId.get('micBadge').hidden, true);
  assert.ok(!pill(ok.log).getAttribute('title'));
});

test('P-1（F2）: 議事録を止めると「議事録を作成中…」を出さず、その場で薄くなって消える（visible を外し leaving を付ける。約 0.4 秒の移り変わり）', async () => {
  const { log } = await start({ systemAudio: false });
  log.fire('onStop');
  await log.drain();
  assert.ok(!pill(log).classList.contains('visible'), 'すぐ消えない');
  assert.ok(pill(log).classList.contains('leaving'));
  assert.notStrictEqual(msg(log), '議事録を作成中…');
  assert.ok(/\.pill\.leaving \{[^}]*transition: opacity \.4s/.test(SRC), '薄くなる移り変わりが無い');
});

test('P-1（F1・F3・F5）: 完了（done）は ✓ も文も出さず、保存の音は鳴らし、薄くなって消える（議事録・音声入力）。エラーは今どおり赤い文を出す', async () => {
  for (const mode of ['meeting', 'dictation']) {
    const { log } = await start({ mode, systemAudio: false });
    const sounds = [];
    log.window.__beeps = sounds;
    log.fire('onPhase', { phase: 'processing', message: mode === 'meeting' ? '議事録を作成中…' : '文字起こし中…' });
    log.fire('onPhase', { phase: 'done', message: mode === 'meeting' ? '議事録を保存しました' : '明日の定例は10時から', procSec: '1.2' });
    await log.drain();
    assert.strictEqual(msg(log), '', `${mode}: 完了の文を出した`);
    assert.ok(!pill(log).classList.contains('visible'), `${mode}: 薄く消えない`);
  }
  assert.ok(/phase === 'done'\) \{\n\s*beep\(SND\.done\);/.test(SRC), '保存の音を鳴らさない');
  const e = await start({ systemAudio: false });
  e.log.fire('onStop');
  await e.log.drain();
  e.log.fire('onPhase', { phase: 'error', message: '議事録を保存できませんでした' });
  await e.log.drain();
  assert.strictEqual(msg(e.log), '議事録を保存できませんでした');
  assert.ok(pill(e.log).classList.contains('visible'), '止めた後のエラーが見えない');
});

test('P-1: main は議事録を止めたときに録音バーへ「議事録を作成中…」を送らず、データベースを待つ文は本体の窓の知らせで出す', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  assert.ok(!main.includes("sendToOverlay('overlay:phase', { phase: 'processing', message: '議事録を作成中…' });"));
  assert.ok(!main.includes("sendToOverlay('overlay:phase', { phase: 'done', message: DB_WAIT_TEXT });"));
  assert.ok(main.includes("sendToMainWin('app:notice', DB_WAIT_TEXT);"));
});
