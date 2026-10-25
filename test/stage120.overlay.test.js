/*
 * stage120.overlay.test.js — 0.12.0 Task SP-2（計画 docs/plans/2026-10-22-120.md の決めたこと 120〜122・124・130・134・146。D66・F21・F22）
 * 相手の声を取り込む議事録で、録音バー（src/renderer/overlay.html）がマイクと相手の声を別々の MediaRecorder で録り、流れごとの区間の番号・
 * 始まりの時計（t0）・最後を送ること、main に言われた流れの区間だけを今の区切りの道で切ることを、最小の DOM（test/helpers/simrun.js）の上で
 * 本当に走らせて見る。見た目は変えない（stage1b.look・stage090.overlay が見続ける）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const OVL = path.join(__dirname, '..', 'src', 'renderer', 'overlay.html');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const fillFor = (level) => 128 + Math.round((level * 128) / 3.4);

// 偽の音の部品: analyser（作られた順）・相手の声のトラック（ended を起こせる）・マイクと流れの出口に札を付けた MediaRecorder の記録
function rig(log, { sysOk = true } = {}) {
  const an = [];
  const recs = [];
  const sysTracks = [];
  const W = log.window;
  W.AudioContext.prototype.createAnalyser = function createAnalyser() {
    const a = { fftSize: 512, smoothingTimeConstant: 0, fill: 128, connect: (x) => x, disconnect() {}, getByteTimeDomainData(arr) { arr.fill(this.fill); } };
    an.push(a);
    return a;
  };
  W.AudioContext.prototype.createMediaStreamDestination = function createMediaStreamDestination() {
    const track = { stop() {}, kind: 'audio', enabled: true, addEventListener() {}, getSettings: () => ({ channelCount: 1 }) };
    return { stream: { tag: 'dest', getTracks: () => [track], getAudioTracks: () => [track] }, connect() {} };
  };
  W.navigator.mediaDevices.getUserMedia = () => {
    const track = { stop() {}, kind: 'audio', enabled: true, addEventListener() {}, getSettings: () => ({}) };
    return Promise.resolve({ tag: 'mic', getTracks: () => [track], getAudioTracks: () => [track] });
  };
  W.navigator.mediaDevices.getDisplayMedia = () => {
    if (!sysOk) return Promise.reject(new Error('NotAllowedError'));
    const track = { stop() {}, kind: 'audio', enabled: true, ls: {}, addEventListener(t, fn) { (this.ls[t] = this.ls[t] || []).push(fn); }, getSettings: () => ({ channelCount: 1 }) };
    sysTracks.push(track);
    return Promise.resolve({ tag: 'sys', getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [], removeTrack() {}, addTrack() {}, active: true });
  };
  const Base = W.MediaRecorder;
  W.MediaRecorder = class extends Base {
    constructor(stream, o) { super(stream, o); recs.push(this); }
  };
  W.MediaRecorder.isTypeSupported = () => true;
  return { an, recs, sysTracks, setSys: (v) => { sysOk = v; } };
}
async function bar(start = {}, opt = {}) {
  const log = await load(OVL, { frames: 0 });
  const r = rig(log, opt);
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: true, ...start });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音の開始で例外');
  return { log, ...r };
}
const sends = (log) => log.called('sendSegment').map((c) => ({ bytes: c.args[0] ? c.args[0].length : 0, durationMs: c.args[1], final: c.args[2], meta: c.args[3], n: c.args.length }));
const live = (recs) => recs.filter((r) => r.state === 'recording').map((r) => r.stream.tag).sort();
const step = async (log, ms) => { await log.clock.advance(ms); await log.drain(); };

test('SP-2: systemAudio の議事録は MediaRecorder を2つ作り、1つはマイクの流れ、1つは相手の声の流れ（混ぜた流れは録らない）。sendSegment の4つ目は { src, seg, t0, last }', T, async () => {
  const { log, recs } = await bar();
  assert.deepStrictEqual(live(recs), ['dest', 'mic'], '2つの流れで録っていない');
  await step(log, 20000);
  const s = sends(log);
  assert.strictEqual(s.length, 2, JSON.stringify(s));
  const bySrc = Object.fromEntries(s.map((x) => [x.meta.src, x]));
  assert.deepStrictEqual(Object.keys(bySrc).sort(), ['loopback', 'mic']);
  for (const x of s) {
    assert.strictEqual(x.n, 4);
    assert.strictEqual(x.final, false);
    assert.deepStrictEqual(Object.keys(x.meta).sort(), ['last', 'seg', 'src', 't0']);
    assert.strictEqual(x.meta.seg, 0);
    assert.strictEqual(x.meta.last, false);
    assert.ok(x.meta.t0 >= 0 && x.meta.t0 < 100, `t0 ${x.meta.t0}`);
    assert.ok(x.bytes > 44, '音声が空');
  }
  assert.deepStrictEqual(live(recs), ['dest', 'mic'], '区切りの後に2つの流れが続いていない');
  // 2つ目の区間は 20 秒からの t0
  await step(log, 75000);
  const s2 = sends(log).slice(2);
  assert.deepStrictEqual(s2.map((x) => [x.meta.src, x.meta.seg]).sort(), [['loopback', 1], ['mic', 1]]);
  for (const x of s2) assert.ok(Math.abs(x.meta.t0 - 20000) < 100, `t0 ${x.meta.t0}`);
});

test('SP-2: systemAudio 偽の議事録・取り込めなかった議事録は今のまま1つの録音で4つ目なし。音声入力も今のまま', T, async () => {
  for (const [start, opt] of [[{ systemAudio: false }, {}], [{ systemAudio: true }, { sysOk: false }]]) {
    const { log, recs } = await bar(start, opt);
    assert.deepStrictEqual(live(recs), ['mic'], JSON.stringify(start));
    await step(log, 20000);
    const s = sends(log);
    assert.strictEqual(s.length, 1);
    assert.strictEqual(s[0].n, 3, '1本の会議に4つ目を付けた');
  }
  const d = await bar({ mode: 'dictation', systemAudio: true });
  assert.deepStrictEqual(live(d.recs), ['mic']);
});

test('SP-2・F21: overlay:cut { src, seg: 今の番号 } でその流れの区間だけが締まって次が始まる。番号の違う・知らない src・一時停止の間・終了の後の cut は何もしない。cut の後の区間も区間の時計を持つ。時計で切った直後の前の番号の cut は次の区間を切らない', T, async () => {
  const { log, recs } = await bar();
  await step(log, 5000);
  assert.strictEqual(log.fire('onCut', { src: 'loopback', seg: 0 }), 1, '受け口が無い');
  await log.drain();
  let s = sends(log);
  assert.deepStrictEqual(s.map((x) => [x.meta.src, x.meta.seg]), [['loopback', 0]]);
  assert.ok(Math.abs(s[0].durationMs - 5000) < 50);
  assert.deepStrictEqual(live(recs), ['dest', 'mic']);
  for (const bad of [{ src: 'loopback', seg: 0 }, { src: 'loopback', seg: 5 }, { src: 'mic', seg: 1 }, { src: 'speaker', seg: 1 }, { src: 'mic', seg: '0' }, null, 'x']) {
    log.fire('onCut', bad);
    await log.drain();
  }
  assert.strictEqual(sends(log).length, 1, '違う cut で切った');
  // マイクの cut はマイクの区間だけ
  log.fire('onCut', { src: 'mic', seg: 0 });
  await log.drain();
  s = sends(log);
  assert.deepStrictEqual(s.map((x) => [x.meta.src, x.meta.seg]), [['loopback', 0], ['mic', 0]]);
  // cut の後の区間も区間の時計（75 秒）で切れる
  await step(log, 75000);
  s = sends(log);
  assert.deepStrictEqual(s.slice(2).map((x) => [x.meta.src, x.meta.seg]).sort(), [['loopback', 1], ['mic', 1]]);
  // 時計で切った直後に届いた前の番号の cut は次の区間を切らない
  log.fire('onCut', { src: 'loopback', seg: 1 });
  log.fire('onCut', { src: 'mic', seg: 1 });
  await log.drain();
  assert.strictEqual(sends(log).length, 4, '前の番号の cut で次の区間を切った');
  // 一時停止の間の cut は何もしない（今の番号でも）
  log.byId.get('pauseBtn').click();
  await log.drain();
  const n = sends(log).length;
  const made = recs.length;
  log.fire('onCut', { src: 'loopback', seg: 2 });
  log.fire('onCut', { src: 'mic', seg: 2 });
  await log.drain();
  assert.strictEqual(sends(log).length, n, '一時停止の間に送った');
  assert.strictEqual(recs.length, made, '一時停止の間に録音を始めた');
  assert.deepStrictEqual(live(recs), []);
  // 終了の後の cut も何もしない
  log.fire('onStop');
  await log.drain();
  const after = recs.length;
  log.fire('onCut', { src: 'mic', seg: 3 });
  await log.drain();
  assert.strictEqual(recs.length, after);
  assert.deepStrictEqual(log.errors.map(fmt), []);
});

test('SP-2・F21: 止めると両方の流れの最後が送られ、isFinal は後に送った方だけに付く', T, async () => {
  const { log, recs } = await bar();
  await step(log, 7000);
  log.fire('onStop');
  await log.drain();
  const s = sends(log);
  assert.strictEqual(s.length, 2, JSON.stringify(s));
  assert.deepStrictEqual(s.map((x) => x.meta.last), [true, true]);
  assert.deepStrictEqual(s.map((x) => x.final), [false, true], 'isFinal が後の方だけでない');
  assert.deepStrictEqual(s.map((x) => x.meta.src).sort(), ['loopback', 'mic']);
  assert.deepStrictEqual(live(recs), []);
});

test('SP-2・F21: 一時停止で両方が締まり、再開で両方が始まる（t0 は一時停止の時間を含まない）。一時停止の間に終了すると、両方の流れの最後が送られ isFinal は1つ', T, async () => {
  const { log, recs } = await bar();
  await step(log, 10000);
  log.byId.get('pauseBtn').click();
  await log.drain();
  let s = sends(log);
  assert.deepStrictEqual(s.map((x) => [x.meta.src, x.meta.last, x.final]).sort(), [['loopback', false, false], ['mic', false, false]]);
  assert.deepStrictEqual(live(recs), []);
  await step(log, 30000);
  log.byId.get('pauseBtn').click();
  await log.drain();
  assert.deepStrictEqual(live(recs), ['dest', 'mic'], '再開で2つの流れが始まらない');
  await step(log, 75000);
  s = sends(log).slice(2);
  assert.deepStrictEqual(s.map((x) => [x.meta.src, x.meta.seg]).sort(), [['loopback', 1], ['mic', 1]]);
  for (const x of s) assert.ok(Math.abs(x.meta.t0 - 10000) < 100, `t0 が一時停止の時間を含む: ${x.meta.t0}`);
  // 一時停止の間に終了
  log.byId.get('pauseBtn').click();
  await log.drain();
  log.fire('onStop');
  await log.drain();
  s = sends(log).slice(4);
  assert.strictEqual(s.filter((x) => x.final).length, 1, JSON.stringify(s));
  assert.strictEqual(s[s.length - 1].final, true, '最後に送ったものが isFinal でない');
  // 流れは loopback と、それ以外（マイクの流れ。空の最後と取り込みが切れた後の区間は src ''）
  const lasts = s.filter((x) => x.meta.last).map((x) => (x.meta.src === 'loopback' ? 'loopback' : 'mic')).sort();
  assert.deepStrictEqual(lasts, ['loopback', 'mic'], '両方の流れの最後を送っていない');
  assert.deepStrictEqual(log.errors.map(fmt), []);
});

test('SP-2・F22: 相手の声のトラックが終わると、相手の声の流れの区間が last: true で送られ（isFinal でない）、以後のマイクの区間は src \'\'。マイクの録音は続く。reportSource(false, true) は今のまま。再開で取り込めれば2つの流れに戻る', T, async () => {
  const { log, recs, sysTracks } = await bar();
  await step(log, 5000);
  for (const fn of sysTracks[0].ls.ended || []) fn();
  await log.drain();
  let s = sends(log);
  assert.deepStrictEqual(s.map((x) => [x.meta.src, x.meta.last, x.final]), [['loopback', true, false]]);
  assert.deepStrictEqual(log.called('reportSource').map((c) => c.args).pop(), [false, true]);
  assert.deepStrictEqual(live(recs), ['mic'], 'マイクの録音が止まった');
  // 切れる前に始めたマイクの区間は mic、切れた後に始めた区間は ''
  await step(log, 15000);
  await step(log, 75000);
  s = sends(log).slice(1);
  assert.deepStrictEqual(s.map((x) => [x.meta.src, x.meta.seg]), [['mic', 0], ['', 1]]);
  // 一時停止して再開し、取り込めれば2つの流れに戻る
  log.byId.get('pauseBtn').click();
  await log.drain();
  log.byId.get('pauseBtn').click();
  await log.drain();
  assert.deepStrictEqual(live(recs), ['dest', 'mic']);
  await step(log, 75000);
  s = sends(log).slice(-2);
  assert.deepStrictEqual(s.map((x) => x.meta.src).sort(), ['loopback', 'mic']);
  // 止めると最後は1つだけ isFinal
  log.fire('onStop');
  await log.drain();
  assert.strictEqual(sends(log).filter((x) => x.final).length, 1);
  assert.deepStrictEqual(log.errors.map(fmt), []);
});

test('SP-2・F22: 一時停止の間に取り込めなくなったら、再開でマイクだけ（src \'\'）になり、相手の声の流れは空の最後で閉じる（止めると締められる）', T, async () => {
  const { log, recs, setSys } = await bar();
  await step(log, 5000);
  log.byId.get('pauseBtn').click();
  await log.drain();
  setSys(false);
  log.byId.get('pauseBtn').click();
  await log.drain();
  assert.deepStrictEqual(live(recs), ['mic']);
  const closed = sends(log).filter((x) => x.meta.src === 'loopback' && x.meta.last);
  assert.strictEqual(closed.length, 1, '相手の声の流れを閉じていない');
  await step(log, 75000);
  assert.strictEqual(sends(log).pop().meta.src, '');
  log.fire('onStop');
  await log.drain();
  const s = sends(log);
  assert.strictEqual(s.filter((x) => x.final).length, 1);
  assert.strictEqual(s[s.length - 1].final, true);
});

test('SP-2: level-ask の答えに vMic・vSys・segMic・segSys・sysOk。mic・sys・warn は 0.9.3 のまま（声を見る analyser の値を混ぜない）。1本の会議は今の3つだけ', T, async () => {
  const { log, an } = await bar();
  assert.strictEqual(an.length, 4, '声を見る analyser を流れごとに作っていない');
  assert.deepStrictEqual(an.map((a) => a.fftSize), [512, 512, 4096, 4096]);
  an[0].fill = fillFor(0.5); an[1].fill = fillFor(0.25); an[2].fill = fillFor(0.1); an[3].fill = fillFor(0.05);
  log.fire('onLevelAsk');
  await log.drain();
  const r = log.called('reportLevel').pop().args[0];
  assert.ok(Math.abs(r.mic - 0.5) < 0.03 && Math.abs(r.sys - 0.25) < 0.03, JSON.stringify(r));
  assert.ok(Math.abs(r.vMic - 0.1) < 0.03 && Math.abs(r.vSys - 0.05) < 0.03, JSON.stringify(r));
  assert.deepStrictEqual([r.segMic, r.segSys, r.sysOk, r.warn], [0, 0, true, '']);
  // 一時停止の間は区間なし（-1）
  log.byId.get('pauseBtn').click();
  await log.drain();
  log.fire('onLevelAsk');
  await log.drain();
  const p = log.called('reportLevel').pop().args[0];
  assert.deepStrictEqual([p.segMic, p.segSys], [-1, -1]);
  // 1本の会議
  const one = await bar({ systemAudio: false });
  one.log.fire('onLevelAsk');
  await one.log.drain();
  assert.deepStrictEqual(Object.keys(one.log.called('reportLevel').pop().args[0]).sort(), ['mic', 'sys', 'warn']);
});
