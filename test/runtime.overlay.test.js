/*
 * runtime.overlay.test.js — 録音バー（overlay.html）を最小DOM上で実際に走らせて検査する
 *
 * overlay.html は $ ヘルパを使わず document.getElementById を直に呼ぶため、
 * repo.test.js の「$('id') で参照する要素が存在する」検査はこのファイルに
 * 一度も当たっていなかった（ループ本体が0回で通っていた）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { parseHTML } = require('./helpers/simdom.js');
const { load, sineBuffer } = require('./helpers/simrun.js');
const C = require('./helpers/simcss.js');

const OVL = path.join(__dirname, '..', 'src', 'renderer', 'overlay.html');
const fmt = (e) => `${e.constructor.name}: ${e.message}`;

let 起動, 録音;

test.before(async () => {
  起動 = await load(OVL);
  録音 = await load(OVL);
  録音.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: true });
  await 録音.drain();
});

test('HTMLが木として整合している', () => {
  const { root, errors } = parseHTML(fs.readFileSync(OVL, 'utf8'));
  assert.deepStrictEqual(errors.map((e) => `${e.line}行 ${e.msg}`), []);
  assert.ok(root._walk([]).length > 10, '木が空。パーサが空振りしている');
});

test('初期化が例外なく完走し、録音の受け口が結線される', () => {
  assert.deepStrictEqual(起動.errors.map(fmt), [], '初期化で例外');
  for (const ev of ['onStart', 'onStop', 'onCancel', 'onPhase', 'onTick']) {
    assert.strictEqual(起動.called(ev).length, 1, `${ev} が結線されていない（録音が始まらない／止まらない）`);
  }
  assert.strictEqual(typeof 起動.window.__koeStart, 'function', 'window.__koeStart が公開されていない');
});

test('参照した id が全部ある', () => {
  const 未解決 = [...new Set([...起動.missingIds, ...録音.missingIds])].filter((i) => !起動.createdIds.has(i));
  assert.deepStrictEqual(未解決, [], 'HTMLに無い id を参照している');
  assert.ok(起動.lookups.size >= 5, `id の参照が ${起動.lookups.size} 件しかない。検査が空振りしている`);
});

test('開始の合図で実際に録音まで進み、停止で音声が渡る', async () => {
  assert.deepStrictEqual(録音.errors.map(fmt), [], '録音開始で例外');
  assert.ok(録音.byId.get('pill').classList.contains('visible'), 'ピルが表示状態にならない');
  assert.ok(録音.called('reportSource').length >= 1, '録音の開始がメインに伝わっていない');
  録音.fire('onStop');
  await 録音.drain();
  assert.deepStrictEqual(録音.errors.map(fmt), [], '録音停止で例外');
  assert.ok(録音.called('sendAudio').length + 録音.called('sendSegment').length >= 1,
    '停止しても音声がメインに渡らない（録音が成立していない）');
});

/*
 * #36 送られたものが本物の WAV であること。以前の偽の decode は {duration} だけを返し、
 * レンダリングは全部 0 だったので、0 バイトを送る壊れ方でも上の検査が通っていた。
 * ここでは overlay.html の blobToWav16k が実際に組み立てたバイト列を読む。
 */
/** 16kHz・mono・16bit の WAV として読み、ヘッダの各欄と PCM サンプルを返す */
function WAVを読む(u8) {
  assert.ok(u8 instanceof Uint8Array, `送られたものが Uint8Array でない: ${Object.prototype.toString.call(u8)}`);
  assert.ok(u8.length >= 44, `WAV ヘッダ（44 バイト）より短い: ${u8.length} バイト`);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (off, n) => String.fromCharCode(...u8.subarray(off, off + n));
  const h = {
    riff: str(0, 4), riffSize: dv.getUint32(4, true), wave: str(8, 4), fmt: str(12, 4), fmtSize: dv.getUint32(16, true),
    format: dv.getUint16(20, true), channels: dv.getUint16(22, true), rate: dv.getUint32(24, true),
    byteRate: dv.getUint32(28, true), blockAlign: dv.getUint16(32, true), bits: dv.getUint16(34, true),
    data: str(36, 4), dataSize: dv.getUint32(40, true),
  };
  const samples = new Int16Array(Math.floor((u8.length - 44) / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = dv.getInt16(44 + i * 2, true);
  return { h, samples };
}
function 本物のWAVである(u8, where) {
  const { h, samples } = WAVを読む(u8);
  assert.deepStrictEqual(
    { riff: h.riff, wave: h.wave, fmt: h.fmt, fmtSize: h.fmtSize, format: h.format, channels: h.channels, rate: h.rate, byteRate: h.byteRate, blockAlign: h.blockAlign, bits: h.bits, data: h.data },
    { riff: 'RIFF', wave: 'WAVE', fmt: 'fmt ', fmtSize: 16, format: 1, channels: 1, rate: 16000, byteRate: 32000, blockAlign: 2, bits: 16, data: 'data' },
    `${where}: WAV ヘッダが 16kHz・mono・16bit PCM でない`);
  assert.strictEqual(h.dataSize, u8.length - 44, `${where}: data チャンクの長さがバイト列と合わない`);
  assert.strictEqual(h.riffSize, u8.length - 8, `${where}: RIFF チャンクの長さがバイト列と合わない`);
  assert.ok(samples.length >= 1000, `${where}: サンプルが ${samples.length} 個しかない（録れた 1 秒ぶんが変換されていない）`);
  const peak = samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  assert.ok(peak > 0, `${where}: 全サンプルが 0（無音）。録った音が WAV に入っていない`);
  // 偽の音は振幅 0.5 の正弦波。間引いても山は残るので、頂点は 0.5 × 32767 の近くにある
  assert.ok(peak >= 0.45 * 32767 && peak <= 32767, `${where}: 頂点 ${peak} が録った音（振幅 0.5）と違う`);
  assert.ok(samples.some((s) => s < 0) && samples.some((s) => s > 0), `${where}: 正負の両側が無い（波形でない）`);
}

test('議事録で送られる区間は、16kHz・mono・16bit の本物の WAV で、録った音が入っている', async () => {
  const log = await load(OVL);
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false });
  await log.drain();
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  const segs = log.called('sendSegment');
  assert.strictEqual(segs.length, 1, '最後の区間が 1 回だけ届いていない');
  assert.strictEqual(segs[0].args[2], true, '最後の印が無い');
  本物のWAVである(segs[0].args[0], 'sendSegment');
});

test('音声入力で送られる音声は、16kHz・mono・16bit の本物の WAV で、録った音が入っている', async () => {
  const log = await load(OVL);
  log.fire('onStart', { mode: 'dictation', sound: false });
  await log.drain();
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  const sent = log.called('sendAudio');
  assert.strictEqual(sent.length, 1, '音声が 1 回だけ届いていない');
  assert.strictEqual(sent[0].args[1], 'audio/wav', 'MIME が audio/wav でない');
  本物のWAVである(sent[0].args[0], 'sendAudio');
  assert.strictEqual(log.called('sendError').length, 0, '変換に成功したのにエラーを伝えている');
});

// 0.9.0 O-3（設計書 D25）で意図して変えた: canvas の波形を5つの点にした。描いた色の代わりに、点が実際に書いた長さ（--l）と、
// 点・印・文の色がピルの地の上で見えること（比べる組と値は test/stage090.overlay.test.js の「色の差」）を見る
test('実際に描いた点は、ピルの地の上で見える', () => {
  const css = 録音.root.querySelectorAll('style').map((s) => s._raw).join('\n');
  const rules = C.parse(css);
  const bg = C.firstColor(C.declsFor(rules, '.pill', { at: '' }).background);
  assert.ok(bg, '.pill の背景色が読めない');
  const dots = 録音.byId.get('lv').children.filter((e) => e.tagName === 'i');
  assert.strictEqual(dots.length, 5);
  assert.ok(dots.every((i) => /^\d+px$/.test(i.style.getPropertyValue('--l'))), '点の長さが一度も書かれていない（描く輪が回っていない）');
  for (const sel of ['.lv i', '.pill.paused .lv i', '.pill.warn .lv i']) {
    const c = C.firstColor(C.resolveVar(rules, C.declsFor(rules, sel, { at: '' }).background));
    assert.ok(c, `${sel} の色が読めない`);
    const r = C.contrast(C.over(c, bg), bg);
    assert.ok(r >= 3, `${sel} の点がピルの地 rgb(${bg.slice(0, 3).join(',')}) に埋もれる（コントラスト比 ${r.toFixed(2)}）`);
  }
});

/*
 * 一時停止まわり。実機の MediaRecorder.stop() は onstop を非同期に呼ぶ
 * （sim の FakeMediaRecorder は同期）。一時停止で recorder を先に捨てると、
 * あとから走る onstop が捨てた recorder を読んで落ち、最大75秒の発言が消える。
 */
/**
 * 実機と同じく stop() の後で onstop を非同期に呼ぶ。
 * 始まった recorder は log.recorders に溜める。sim の setTimeout は発火しないので、
 * 75秒の打ち切り（autoStopId: recorder.stop() を直に呼ぶ）はテストがここから起こす。
 */
function 非同期onstopに(log) {
  const MR = log.window.MediaRecorder;
  log.recorders = [];
  const start = MR.prototype.start;
  MR.prototype.start = function () { log.recorders.push(this); start.call(this); };
  MR.prototype.stop = function () {
    this.state = 'inactive';
    this._flush();                                             // 実機と同じく、録れたデータは onstop より先に届く
    setImmediate(() => { if (this.onstop) this.onstop(); });   // 実機と同じく後で発火
  };
}

/** decodeAudioData の差し替えが返すもの。simrun の既定と同じ形（getChannelData を持つ非無音の正弦波） */
const 復号した音 = () => sineBuffer(480);

/** simrun の fakeStream と同じ形で、トラックの stop() 回数を数える（マイクを手放したかの観測） */
function 偽ストリーム() {
  const track = { stops: 0, stop() { this.stops++; }, kind: 'audio', enabled: true, addEventListener() {}, onended: null };
  return { track, getTracks: () => [track], getAudioTracks: () => [track], addTrack() {}, active: true };
}

/** getUserMedia を差し替え、開いたストリームを返す配列を渡す */
function マイクを数える(log) {
  const streams = [];
  log.window.navigator.mediaDevices.getUserMedia = () => { const s = 偽ストリーム(); streams.push(s); return Promise.resolve(s); };
  return streams;
}

/** WAV 変換（decodeAudioData）をテストが進めるまで止める。戻り値を呼ぶと進む */
function 変換を待たせる(log) {
  let release;
  const gate = new Promise((r) => { release = r; });
  log.window.AudioContext.prototype.decodeAudioData = () => gate.then(復号した音);
  return release;
}

/** WAV 変換を必ず失敗させる（実機では壊れた webm や codec 差で起きる） */
function 変換を失敗させる(log) {
  log.window.AudioContext.prototype.decodeAudioData = () => Promise.reject(new Error('decode に失敗'));
}

async function 議事録を一時停止まで(opt = {}) {
  const log = await load(OVL);
  非同期onstopに(log);
  if (opt.setup) opt.setup(log);   // 録音を始める前に差し替えたいもの（getUserMedia など）
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音開始で例外');
  log.byId.get('pauseBtn').click();
  if (!opt.noDrain) await log.drain();
  return log;
}

test('一時停止で締めた区間は、onstop が非同期でも届く', async () => {
  const log = await 議事録を一時停止まで();
  assert.deepStrictEqual(log.errors.map(fmt), [], '一時停止で例外');
  assert.strictEqual(log.called('sendSegment').length, 1, '一時停止で締めた区間がメインに渡らない');
  assert.strictEqual(log.called('sendSegment')[0].args[2], false, '一時停止の区間が最後の区間として送られている');
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true], 'main へ一時停止が伝わっていない');
});

test('一時停止中に終了すると、締めた区間の後に空の最後の区間が届く', async () => {
  const log = await 議事録を一時停止まで();
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  const segs = log.called('sendSegment').map((c) => c.args[2]);
  assert.deepStrictEqual(segs, [false, true], '区間の並びが違う（締めた区間 → 最後の区間 の順で1回ずつ）');
});

test('区間を締めている最中に終了しても、最後の区間は1回だけ届く', async () => {
  const log = await 議事録を一時停止まで({ noDrain: true });   // onstop がまだ走っていない
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  const segs = log.called('sendSegment').map((c) => c.args[2]);
  assert.deepStrictEqual(segs, [true], '最後の区間が二重に届く／届かない');
  assert.ok(log.called('sendSegment')[0].args[0].length > 0, '締めた区間の音声が捨てられている');
});

test('再開すると次の区間が始まり、終了で最後の区間が届く', async () => {
  const log = await 議事録を一時停止まで();
  log.byId.get('pauseBtn').click();   // 再開
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '再開で例外');
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true, false]);
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  const segs = log.called('sendSegment').map((c) => c.args[2]);
  assert.deepStrictEqual(segs, [false, true], '再開後の区間が最後の区間として届かない');
});

/*
 * 上限時間（75秒）で切られた区間は、onstop が WAV 変換を待っている間 recorder が
 * 「止まっている」ように見える。その間に一時停止→終了と押されると、一時停止側は
 * 締める区間が無いと思ってマイクを手放し、終了側は待つものが無いと思って
 * 空の最後の区間を先に送る。変換が終わって届く本物の区間は最後の印の後になり、
 * main に捨てられる（最大75秒の発言が消える）。
 */
test('上限時間で切られた区間の変換中に一時停止→終了しても、その区間が最後として1回だけ届く', async () => {
  const log = await load(OVL);
  非同期onstopに(log);
  const streams = マイクを数える(log);
  const 変換を進める = 変換を待たせる(log);
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音開始で例外');
  assert.strictEqual(log.recorders.length, 1, '最初の区間の recorder が始まっていない（検査が空振り）');
  log.recorders[0].stop();          // 上限時間の打ち切り（autoStopId と同じく recorder.stop() を直に呼ぶ）
  await log.drain();                // onstop が走り、変換待ちで止まる
  assert.strictEqual(log.called('sendSegment').length, 0, '変換が終わる前に区間が送られている（検査が空振り）');
  log.byId.get('pauseBtn').click();
  await log.drain();
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true], 'main へ一時停止が伝わっていない');
  log.fire('onStop');
  await log.drain();
  変換を進める();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  const segs = log.called('sendSegment');
  // #13 以降、切られた区間の変換中も次の区間が録っている。一時停止はその次の区間を
  // 締めるので、届く順は「切られた区間（途中）→ 一時停止で締めた区間（最後）」。
  // 守るべきことは変わらない: 最後の印は1回だけ、切られた区間の音声は捨てない。
  assert.deepStrictEqual(segs.map((c) => c.args[2]), [false, true],
    '最後の区間が二重に届く／届かない（本物の区間が空の最後の後に届き、main に捨てられる）');
  assert.ok(segs[0].args[0].length > 0, '切られた区間の音声が捨てられている');
  assert.ok(streams[0].track.stops >= 1, '終了後もマイクが開いたまま');
});

test('一時停止で区間を送り終えると、マイクを手放す', async () => {
  let streams;
  const log = await 議事録を一時停止まで({ setup: (l) => { streams = マイクを数える(l); } });
  assert.deepStrictEqual(log.errors.map(fmt), [], '一時停止で例外');
  assert.strictEqual(streams.length, 1, 'マイクが開かれていない（検査が空振り）');
  assert.strictEqual(log.called('sendSegment').length, 1, '一時停止で締めた区間が届かない');
  assert.ok(streams[0].track.stops >= 1, '一時停止してもマイクが開いたまま（OS のマイク使用表示が点きっぱなしになる）');
});

test('再開でマイクを開き直している間に終了しても、最後の区間が1回だけ届く', async () => {
  const log = await 議事録を一時停止まで();
  let マイクが開く = null;
  const opened = 偽ストリーム();
  log.window.navigator.mediaDevices.getUserMedia = () => new Promise((r) => { マイクが開く = r; });
  log.byId.get('pauseBtn').click();   // 再開 → getUserMedia 待ちで止まる
  await log.drain();
  assert.ok(マイクが開く, '再開がマイクを開きに行っていない（検査が空振り）');
  log.fire('onStop');
  await log.drain();
  マイクが開く(opened);
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  const segs = log.called('sendSegment').map((c) => c.args[2]);
  assert.deepStrictEqual(segs, [false, true], '最後の区間が届かない（main が待ち続ける）／二重に届く');
  assert.ok(opened.track.stops >= 1, '終了したのに開き直したマイクが開いたまま');
});

test('最後の区間の WAV 変換に失敗しても、空の最後の区間で main を閉じる', async () => {
  const log = await load(OVL);
  変換を失敗させる(log);
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音開始で例外');
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  const segs = log.called('sendSegment');
  assert.strictEqual(segs.length, 1, '最後の区間が届かない（main が待ち続ける）／二重に届く');
  assert.strictEqual(segs[0].args[0].length, 0, '変換に失敗した区間の中身が送られている');
  assert.strictEqual(segs[0].args[2], true, '最後の区間の印が付いていない');
});

test('音声入力の WAV 変換に失敗すると、エラーを1回だけ伝える', async () => {
  const log = await load(OVL);
  変換を失敗させる(log);
  log.fire('onStart', { mode: 'dictation', sound: false });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音開始で例外');
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  assert.strictEqual(log.called('sendAudio').length, 0, '変換に失敗したのに音声が送られている');
  assert.deepStrictEqual(log.called('sendError').map((c) => c.args[0]), ['音声の変換に失敗しました']);
});

/*
 * #13 区間の境目の空白。切られた区間は onstop → WAV 変換 → 送信 → 次の区間、の順で
 * 動いていたので、変換の間（実機で数百ms〜数秒）は誰も録っていなかった。
 * 空白のぶん atMs も会議が進むほど手前へずれる。次の区間は切った瞬間に始め、
 * 変換は裏で続ける。送る順は区間の番号で守る（短い後の区間が先に変換し終えても
 * 先に届かない。main は届いた順に atMs を積む）。
 */
/**
 * overlay の Date.now() を進める（simrun の偽の時計 log.clock）。ここの 進める は時限
 * （setTimeout）を発火させない＝画面が隠れて setTimeout が間引かれた状態。区切りの見張り
 * （onTick）を検査するための時計。時限まで進めるときは log.clock.advance(ms) を使う。
 */
function 時計(log) {
  return { now: () => log.clock.now, 進める(ms) { return log.clock.jump(ms); } };
}
/** WAV 変換を呼ばれた順に個別に止める。戻り値の配列の要素を呼ぶと、その変換だけ進む */
function 変換を個別に待たせる(log) {
  const gates = [];
  log.window.AudioContext.prototype.decodeAudioData = () => new Promise((r) => {
    gates.push(() => r(復号した音()));
  });
  return gates;
}
const FIRST_SEG = 20000, GRACE = 2000;   // overlay.html の FIRST_SEG_MS と cutSegmentIfOverdue の猶予

async function 議事録を開始(opt = {}) {
  const log = await load(OVL, opt.load || {});
  非同期onstopに(log);
  if (opt.setup) opt.setup(log);
  const clock = 時計(log);
  log.fire('onStart', Object.assign({ mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false }, opt.start || {}));
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '録音開始で例外');
  assert.strictEqual(log.recorders.length, 1, '最初の区間の recorder が始まっていない（検査が空振り）');
  return { log, clock };
}

/*
 * #37 区間長そのもの。最初の区間は FIRST_SEG_MS（20 秒）、以後は設定の segmentSec 秒。
 * これまで時計を進めるテストは区切りの「見張り」（onTick）だけを通していて、setTimeout の
 * 期限で自動に切れる本線に時間軸が無かった。segmentSec * 1000 の * 1000 を消しても
 * 全件が緑だった（最初の 20 秒だけ残り、以後が 75 ミリ秒ごとに細切れになる壊れ方）。
 */
/** 区間が「最初 FIRST_SEG → 以後 segMs」の長さで、時限が来ると自動に切れて順に届くことを見る */
async function 時限で切れる区間を見る(segmentSec) {
  const segMs = segmentSec * 1000;
  const { log } = await 議事録を開始({ start: { segmentSec } });
  const 届いた = () => log.called('sendSegment').map((c) => [c.args[1], c.args[2]]);
  await log.clock.advance(FIRST_SEG - 1);
  assert.strictEqual(log.recorders.length, 1, `最初の区間が ${FIRST_SEG} ms より前に切られている`);
  await log.clock.advance(1);
  assert.strictEqual(log.recorders.length, 2, `最初の区間が ${FIRST_SEG} ms で切られない（setTimeout の期限で自動に切れていない）`);
  assert.strictEqual(log.recorders[1].state, 'recording', '2 つ目の区間が録っていない');
  await log.drain();
  assert.deepStrictEqual(届いた(), [[FIRST_SEG, false]], '最初の区間が 20 秒の長さで途中の印で届いていない');
  await log.clock.advance(segMs - 1);
  assert.strictEqual(log.recorders.length, 2, `2 つ目の区間が設定の ${segmentSec} 秒より前に切られている（segmentSec の単位が壊れている疑い）`);
  await log.clock.advance(1);
  assert.strictEqual(log.recorders.length, 3, `2 つ目の区間が設定の ${segmentSec} 秒で切られない`);
  await log.drain();
  await log.clock.advance(segMs);
  assert.strictEqual(log.recorders.length, 4, `3 つ目の区間が設定の ${segmentSec} 秒で切られない`);
  await log.drain();
  assert.deepStrictEqual(届いた(), [[FIRST_SEG, false], [segMs, false], [segMs, false]],
    `区間が ${FIRST_SEG} → ${segMs} → ${segMs} ms の長さで順に届いていない`);
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  assert.deepStrictEqual(log.called('sendSegment').map((c) => c.args[2]), [false, false, false, true], '最後の印が最後の区間だけに付いていない');
  assert.strictEqual(log.recorders.length, 4, '終了で区間が余計に始まっている');
  return log;
}

test('区間は最初 20 秒（FIRST_SEG_MS）、以後は設定の 75 秒で、setTimeout の期限が来ると自動に切れて順に届く', async () => {
  await 時限で切れる区間を見る(75);
});

test('設定の segmentSec が 120 なら、2 つ目からの区間は 120 秒で切れる（75 秒の決め打ちではない）', async () => {
  await 時限で切れる区間を見る(120);
});

test('偽の時計は、進めた時間のぶんだけ Date.now と経過表示が進む（時間軸の検査そのものが空振りしていない）', async () => {
  const { log } = await 議事録を開始();
  const t0 = log.clock.now;
  assert.ok(log.clock.pending().some((t) => t.at === t0 + FIRST_SEG && !t.every), '最初の区間の時限（20 秒）が登録されていない');
  assert.ok(log.clock.pending().some((t) => t.every === 250), '経過表示の setInterval（250ms）が登録されていない');
  await log.clock.advance(61_500);
  assert.strictEqual(log.clock.now - t0, 61_500, '時計が進んでいない');
  assert.strictEqual(log.byId.get('timer').textContent, '1:01', '経過表示が偽の時計に追従していない');
});

test('区切りの見張りで区間を切ると、変換を待たずに次の区間が始まる', async () => {
  let 変換を進める;
  const { log, clock } = await 議事録を開始({ setup: (l) => { 変換を進める = 変換を待たせる(l); } });
  clock.進める(FIRST_SEG + GRACE + 1);
  log.fire('onTick');                       // 区切りの見張り（main からの overlay:tick）
  assert.strictEqual(log.recorders.length, 2, '切った瞬間に次の区間が始まっていない（変換の間の録音が空白になる）');
  assert.strictEqual(log.recorders[0].state, 'inactive', '前の区間が止まっていない');
  assert.strictEqual(log.recorders[1].state, 'recording', '次の区間が録っていない');
  await log.drain();
  assert.strictEqual(log.called('sendSegment').length, 0, '変換が終わる前に区間が送られている（検査が空振り）');
  assert.strictEqual(log.recorders.length, 2, '変換待ちの間に区間が余計に始まっている（録音が2本走る）');
  変換を進める();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  const segs = log.called('sendSegment');
  assert.strictEqual(segs.length, 1, '切った区間が届かない／二重に届く');
  assert.strictEqual(segs[0].args[2], false, '途中の区間が最後の印で届いている');
  assert.strictEqual(segs[0].args[1], FIRST_SEG + GRACE + 1, '区間の長さが録った長さと違う');
  assert.strictEqual(log.recorders.length, 2, '変換後にもう一度次の区間を始めている（録音が2本走る）');
});

test('上限で止まった区間の onstop でも、変換を待たずに次の区間が始まる', async () => {
  let 変換を進める;
  const { log } = await 議事録を開始({ setup: (l) => { 変換を進める = 変換を待たせる(l); } });
  log.recorders[0].stop();                  // 上限時間の打ち切り（recorder.stop() を直に呼ぶ経路）
  await log.drain();                        // onstop が走り、変換待ちで止まる
  assert.strictEqual(log.called('sendSegment').length, 0, '変換が終わる前に区間が送られている（検査が空振り）');
  assert.strictEqual(log.recorders.length, 2, 'onstop が変換を待ってから次の区間を始めている（その間の録音が空白になる）');
  assert.strictEqual(log.recorders[1].state, 'recording', '次の区間が録っていない');
  変換を進める();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  assert.deepStrictEqual(log.called('sendSegment').map((c) => c.args[2]), [false], '切った区間が届かない／二重に届く');
  assert.strictEqual(log.recorders.length, 2, '変換後にもう一度次の区間を始めている（録音が2本走る）');
});

test('先に切った区間の変換が後から終わっても、区間は切った順に届き、長さに変換の時間を含めない', async () => {
  let gates;
  const { log, clock } = await 議事録を開始({ setup: (l) => { gates = 変換を個別に待たせる(l); } });
  const durA = FIRST_SEG + GRACE + 1;
  clock.進める(durA);
  log.fire('onTick');                       // A を切る → B が始まる
  await log.drain();
  const durB = 75000 + GRACE + 1;
  clock.進める(durB);
  log.fire('onTick');                       // B を切る → C が始まる
  await log.drain();
  assert.strictEqual(log.recorders.length, 3, '区間が3つ目まで進んでいない（検査が空振り）');
  assert.strictEqual(gates.length, 2, '2つの区間が変換待ちになっていない（検査が空振り）');
  gates[1]();                               // 後の区間（B）の変換が先に終わる
  await log.drain();
  assert.strictEqual(log.called('sendSegment').length, 0, '前の区間より先に後の区間が届いている（main の atMs がずれ、文脈の並びも狂う）');
  clock.進める(50000);                      // A の変換に時間がかかった。これは区間の長さに入れない
  gates[0]();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  assert.deepStrictEqual(log.called('sendSegment').map((c) => c.args[1]), [durA, durB],
    '区間が切った順に届いていない／長さに変換の時間が混ざっている');
  log.fire('onStop');                       // C を最後として締める
  await log.drain();
  assert.strictEqual(gates.length, 3, '最後の区間が変換に入っていない（検査が空振り）');
  gates[2]();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '終了で例外');
  assert.deepStrictEqual(log.called('sendSegment').map((c) => c.args[2]), [false, false, true], '最後の印が最後の区間だけに1回付いていない');
});

/*
 * マイクの切断。トラックが終わった直後に次の区間の MediaRecorder.start() が投げる
 * （InvalidStateError）。投げたままだと、その番号が待ち行列で埋まらず、変換中の区間も
 * 空の最後も永久に届かない（main は終了しても締められない）。番号を空の最後で埋め、
 * 変換中の区間を送り終えてから main にエラーを伝える。
 */
test('次の区間の start() がマイクの切断で投げても、変換中の区間は届き、空の最後で締めてから伝える', async () => {
  let 変換を進める; let streams;
  const { log } = await 議事録を開始({ setup: (l) => { 変換を進める = 変換を待たせる(l); streams = マイクを数える(l); } });
  const MR = log.window.MediaRecorder;
  const startWrapped = MR.prototype.start;
  MR.prototype.start = function () { throw new Error('InvalidStateError: The MediaRecorder\'s stream is inactive'); };
  log.recorders[0].stop();                  // 上限時間の打ち切り → onstop → 次の区間の start() が投げる
  await log.drain();                        // 切った区間は変換待ち
  assert.deepStrictEqual(log.errors.map(fmt), [], '次の区間の start() の例外が漏れている');
  assert.strictEqual(log.called('sendSegment').length, 0, '変換が終わる前に何かを送っている（検査が空振り）');
  assert.strictEqual(log.called('sendError').length, 0, '変換中の区間を送り終える前にエラーを伝えている（main が先に締めて区間が消える）');
  変換を進める();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  assert.deepStrictEqual(log.called('sendSegment').map((c) => c.args[2]), [false, true],
    '変換中だった区間と空の最後が、この順に1回ずつ届いていない');
  assert.ok(log.called('sendSegment')[0].args[0].length > 0, '変換中だった区間の音声が空');
  assert.deepStrictEqual(log.called('sendError').map((c) => c.args[0]), ['マイクが切断されました'], 'エラーが1回だけ伝わっていない');
  assert.ok(streams[0].track.stops >= 1, 'マイクを手放していない');
  // 次の録音は普通に始まり、区間が届く（前の録音の番号が待ち行列を塞いでいない）
  MR.prototype.start = startWrapped;
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '次の録音の開始で例外');
  log.fire('onStop');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '次の録音の終了で例外');
  assert.deepStrictEqual(log.called('sendSegment').map((c) => c.args[2]), [false, true, true], '次の録音の最後の区間が届かない（待ち行列が前の録音で止まっている）');
});

test('議事録の開始でマイクを開けなかったときは、空の最後を送ってからエラーを伝える（main が締められる）', async () => {
  const log = await load(OVL);
  非同期onstopに(log);
  log.window.navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('NotAllowedError'));
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false });
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  assert.deepStrictEqual(log.called('sendSegment').map((c) => c.args[2]), [true], '空の最後が届いていない');
  assert.strictEqual(log.called('sendError').length, 1, 'エラーが1回伝わっていない');
});

/*
 * preload はこの作業木ではまだ reportMic / onSegmentMs を公開していない。
 * simrun の偽 IPC は preload から名前を読むので、契約どおりの行を足した preload を渡す
 * （runtime.app.test.js の preloadWithHotkey と同じ手）。preload が追いついたらそのまま通る。
 */
const PRELOAD_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
function 拡張preload() {
  let s = PRELOAD_SRC;
  const head = "exposeInMainWorld('koeOverlay', {";
  assert.ok(s.includes(head), 'preload の koeOverlay が見つからない');
  if (!/^\s{2}reportMic:/m.test(s)) s = s.replace(head, `${head}\n  reportMic: (info) => ipcRenderer.send('overlay:mic', info),`);
  if (!/^\s{2}onSegmentMs:/m.test(s)) s = s.replace(head, `${head}\n  onSegmentMs: (cb) => ipcRenderer.on('overlay:segment-ms', (_e, ms) => cb(ms)),`);
  return s;
}

/*
 * #56 選んだマイクが無い。deviceId: { ideal } なので、選んだ機器が抜けていると Chromium は
 * 黙って既定のマイクで録る。開いたトラックの deviceId を見て、違えば代替中と扱い、
 * main（overlay:mic）とピルに出す。機器名（ラベル）は送らない。
 */
function マイクを(deviceId) {
  return (log) => {
    log.window.navigator.mediaDevices.getUserMedia = () => {
      const s = 偽ストリーム();
      s.track.getSettings = () => ({ deviceId, channelCount: 1 });
      return Promise.resolve(s);
    };
  };
}

// 0.9.0 O-3（設計書 D25・RP6）で意図して変えた: ピルの代替の表示は、ロゴの角の黄色い点（#micBadge）と、はじめの 4 秒だけの文「既定のマイクで録音中」
test('選んだマイクが無く既定のマイクで開いたときは、代替中を main とピルに伝える', async () => {
  const { log } = await 議事録を開始({ load: { preloadSrc: 拡張preload() }, setup: マイクを('other'), start: { micId: 'chosen' } });
  assert.deepStrictEqual(log.called('reportMic').map((c) => c.args[0]), [{ requested: true, matched: false }],
    '選んだマイクと違うマイクで開いたことが main に伝わっていない（機器名を送ってもいけない）');
  const label = log.byId.get('status').textContent;
  assert.strictEqual(label, '既定のマイクで録音中', `ピルに代替中と出ない: ${label}`);
  assert.strictEqual(log.byId.get('micBadge').hidden, false, 'ロゴの角に代替中の点が出ない');
  // 開き直すたびに1回。一時停止→再開でマイクを開き直したら、また報告する
  log.byId.get('pauseBtn').click();
  await log.drain();
  log.byId.get('pauseBtn').click();
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '一時停止・再開で例外');
  assert.strictEqual(log.called('reportMic').length, 2, 'マイクを開き直したのに報告し直していない');
  assert.strictEqual(log.byId.get('micBadge').hidden, false, '再開後のピルに代替中と出ない');
});

test('選んだマイクで開けたとき・マイクを選んでいないときは、合っていると伝え、ピルは通常の文言', async () => {
  const 合致 = await 議事録を開始({ load: { preloadSrc: 拡張preload() }, setup: マイクを('chosen'), start: { micId: 'chosen' } });
  assert.deepStrictEqual(合致.log.called('reportMic').map((c) => c.args[0]), [{ requested: true, matched: true }]);
  assert.ok(!/既定のマイク/.test(合致.log.byId.get('status').textContent) && 合致.log.byId.get('micBadge').hidden, '合っているのに代替中と出る');
  const 未選択 = await 議事録を開始({ load: { preloadSrc: 拡張preload() }, setup: マイクを('default'), start: { micId: '' } });
  assert.deepStrictEqual(未選択.log.called('reportMic').map((c) => c.args[0]), [{ requested: false, matched: true }]);
  assert.ok(!/既定のマイク/.test(未選択.log.byId.get('status').textContent) && 未選択.log.byId.get('micBadge').hidden, '選んでいないのに代替中と出る');
  // getSettings が無い／deviceId を返さない実装では判定できないので、合っていると扱う（誤警告を出さない）
  const 不明 = await 議事録を開始({ load: { preloadSrc: 拡張preload() }, setup: (l) => { マイクを数える(l); }, start: { micId: 'chosen' } });
  assert.deepStrictEqual(不明.log.called('reportMic').map((c) => c.args[0]), [{ requested: true, matched: true }]);
  assert.ok(!/既定のマイク/.test(不明.log.byId.get('status').textContent) && 不明.log.byId.get('micBadge').hidden, '判定できないのに代替中と出る');
});

test('preload に reportMic が無くても、録音は例外なく始まり、ピルの代替表示は出る', async () => {
  const { log } = await 議事録を開始({ setup: マイクを('other'), start: { micId: 'chosen' } });
  assert.deepStrictEqual(log.errors.map(fmt), []);
  assert.ok(/既定のマイク/.test(log.byId.get('status').textContent) && !log.byId.get('micBadge').hidden, 'ピルの代替表示は preload に依らず出る');
});

/*
 * #8/#42 背圧。文字起こしが追いつかないとき main が区間を長く（または短く）できるよう、
 * overlay:segment-ms を受ける。効くのは次の区間から。今の区間を切ると、
 * 受けた瞬間に短い区間ができて文字起こしの文脈が細切れになる。
 */
test('main から区間長を変えると、次の区間から効き、今の区間は切らない', async () => {
  const { log, clock } = await 議事録を開始({ load: { preloadSrc: 拡張preload() } });
  assert.strictEqual(log.fire('onSegmentMs', 150000), 1, 'onSegmentMs が結線されていない');
  clock.進める(10000);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 1, '区間長を受けた瞬間に今の区間を切っている');
  clock.進める(FIRST_SEG + GRACE + 1 - 10000);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 2, '今の区間が元の長さで切られていない');
  await log.drain();
  clock.進める(75000 + GRACE + 1);          // 既定の 75 秒なら切られる時刻
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 2, '次の区間が新しい区間長（150秒）ではなく元の 75 秒で切られている');
  clock.進める(150000 - 75000);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 3, '新しい区間長（150秒）で切られない');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
});

test('区間長は 20〜300 秒に丸め、数でないものは無視する', async () => {
  const { log, clock } = await 議事録を開始({ load: { preloadSrc: 拡張preload() } });
  log.fire('onSegmentMs', 5000);            // 短すぎ → 20 秒
  clock.進める(FIRST_SEG + GRACE + 1);
  log.fire('onTick');                       // 最初の区間を切る → 2つ目（20 秒）
  await log.drain();
  clock.進める(20000 + GRACE + 1);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 3, '下限 20 秒に丸められていない');
  await log.drain();
  log.fire('onSegmentMs', 'abc');           // 数でない → 無視（直前の 20 秒のまま）
  log.fire('onSegmentMs', 999999);          // 長すぎ → 300 秒
  clock.進める(20000 + GRACE + 1);
  log.fire('onTick');                       // 3つ目（20 秒）を切る → 4つ目（300 秒）
  assert.strictEqual(log.recorders.length, 4, '数でない値で区間長が壊れた');
  await log.drain();
  clock.進める(299000);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 4, '上限 300 秒より前に切られている');
  clock.進める(1000 + GRACE + 1);
  log.fire('onTick');
  assert.strictEqual(log.recorders.length, 5, '上限 300 秒で切られない');
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
});

/*
 * 0.13.0 CLK-1（2026-10-27 の持ち主の答え「録音バーとページの両方を直す（おすすめ）」）: 録音バーの経過時間は一時停止の分を引き、
 * 再開の後も進む。250ms の時計は start() でだけ作られ、一時停止の stopMeters() が止めたまま再開で作り直されず、
 * 初めの一時停止から後ずっと止まっていた（持ち主の写しの画面: 録音バー 0:33・ページ 0:54。一時停止は 8 秒の1回）。
 */
const 時計の数 = (log) => log.clock.pending().filter((t) => t.every === 250).length;
const 経過 = (log) => log.byId.get('timer').textContent;
async function 一時停止を押す(log) { log.byId.get('pauseBtn').click(); await log.drain(); }

test('CLK-1: 33 秒録って 8 秒止め、再開して 21 秒で録音バーは 0:54（止めている間は 0:33 のまま・時計は動かさない。再開の後の 250ms の時計はちょうど1つ）', async () => {
  const { log } = await 議事録を開始();
  assert.strictEqual(時計の数(log), 1, '録音の始めに 250ms の時計がちょうど1つでない（検査が空振り）');
  await log.clock.advance(33_000);
  assert.strictEqual(経過(log), '0:33');
  await 一時停止を押す(log);
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true]);
  assert.strictEqual(時計の数(log), 0, '一時停止の間も 250ms の時計が動いている');
  await log.clock.advance(8_000);
  assert.strictEqual(経過(log), '0:33', '一時停止の間に経過時間が進んだ');
  await 一時停止を押す(log);   // 再開
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true, false]);
  assert.strictEqual(時計の数(log), 1, '再開の後の 250ms の時計がちょうど1つでない（動かし直していない／2つ走っている）');
  await log.clock.advance(21_000);
  assert.strictEqual(経過(log), '0:54', '再開の後に録音バーの時計が止まったまま／一時停止の分を引いていない');
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
});

test('CLK-1: 一時停止を2回しても、録音バーの経過時間は止めた分を全部引いて進む（止めている間は時計を動かさない）', async () => {
  const { log } = await 議事録を開始();
  await log.clock.advance(10_000);
  await 一時停止を押す(log);
  await log.clock.advance(5_000);
  await 一時停止を押す(log);   // 再開
  await log.clock.advance(10_000);
  assert.strictEqual(経過(log), '0:20', '1回目の再開の後に時計が進まない');
  await 一時停止を押す(log);
  assert.strictEqual(時計の数(log), 0, '2回目の一時停止の間も 250ms の時計が動いている');
  await log.clock.advance(7_000);
  assert.strictEqual(経過(log), '0:20', '2回目の一時停止の間に経過時間が進んだ');
  await 一時停止を押す(log);   // 再開
  assert.strictEqual(時計の数(log), 1, '2回目の再開の後の 250ms の時計がちょうど1つでない');
  await log.clock.advance(15_000);
  assert.strictEqual(経過(log), '0:35', '2回の一時停止（5 秒と 7 秒）を引いた 35 秒にならない');
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true, false, true, false]);
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
});

test('CLK-1: 再開でマイクを開き直せなかったら一時停止のまま（時計は動かさず、値は止めた時のまま）。もう一度押して開けたら、止めた分を引いて進む', async () => {
  const { log } = await 議事録を開始();
  await log.clock.advance(10_000);
  await 一時停止を押す(log);
  log.window.navigator.mediaDevices.getUserMedia = () => Promise.reject(new Error('NotFoundError'));
  await log.clock.advance(2_000);
  await 一時停止を押す(log);   // 再開 → 開けない
  assert.ok(log.byId.get('pill').classList.contains('paused'), '開き直せなかったのに一時停止の形でない');
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true], '開き直せなかったのに main へ再開を知らせた');
  assert.strictEqual(時計の数(log), 0, '開き直せなかったのに 250ms の時計が動いている');
  await log.clock.advance(3_000);
  assert.strictEqual(経過(log), '0:10', '一時停止のままなのに経過時間が進んだ');
  マイクを数える(log);
  await 一時停止を押す(log);   // 再開 → 開ける
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true, false]);
  assert.strictEqual(時計の数(log), 1, '再開の後の 250ms の時計がちょうど1つでない');
  await log.clock.advance(4_000);
  assert.strictEqual(経過(log), '0:14', '止めていた 5 秒（開けなかった間も）を引いた 14 秒にならない');
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
});

test('CLK-1: 縦の形（左右の中央）でも、再開の後の時計は縦の形の書き方（1 時間を越えたら時:分）のまま進む', async () => {
  const { log } = await 議事録を開始({ start: { form: 'v' } });
  log.clock.jump(3_585_000);
  await log.clock.advance(5_000);
  assert.strictEqual(経過(log), '59:50');
  await 一時停止を押す(log);
  await log.clock.advance(8_000);
  await 一時停止を押す(log);   // 再開
  await log.clock.advance(21_000);
  assert.strictEqual(経過(log), '1:00', '縦の形の再開の後の時計が 1 時間 0 分 11 秒を「1:00」と書かない（止まったまま／横の形の書き方）');
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
});

/*
 * 0.13.0 CLK-2: 再開でマイクを開き直している間（await openStream()）に録音バーをもう一度押すと、pauseRec が走る。見直さずに
 * 再開を終えると main に「止めていない」と知らせ、録音バーは一時停止の形のまま録り、2つの時計が際限なくずれていた
 */
function 開き直しを待たせる(log) {
  const gate = { open: null, calls: 0 };
  log.window.navigator.mediaDevices.getUserMedia = () => { gate.calls++; return new Promise((r) => { gate.open = r; }); };
  return gate;
}

test('CLK-2: 再開でマイクを開き直している間にもう一度押すと、一時停止のまま（main へ再開を知らせない・開いたマイクを手放す・区間を始めない・時計は止めた時の値）。もう一度押すと再開でき、止めた分を全部引いて進む', async () => {
  const { log } = await 議事録を開始();
  await log.clock.advance(33_000);
  await 一時停止を押す(log);
  const recs = log.recorders.length;
  const gate = 開き直しを待たせる(log);
  await log.clock.advance(8_000);
  await 一時停止を押す(log);   // 再開 → getUserMedia 待ちで止まる
  assert.ok(gate.open, '再開がマイクを開きに行っていない（検査が空振り）');
  await log.clock.advance(1_000);
  await 一時停止を押す(log);   // 開き直している間にもう一度押す（一時停止し直す）
  await 一時停止を押す(log);   // さらに押しても、開き直しをもう1本走らせない
  assert.strictEqual(gate.calls, 1, '開き直している間の押しで、マイクをもう一度開きに行った');
  const opened = 偽ストリーム();
  gate.open(opened);
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  assert.ok(log.byId.get('pill').classList.contains('paused'), '一時停止し直したのに一時停止の形でない');
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true, true], '一時停止し直したのに main へ再開を知らせた（2つの時計がずれる）');
  assert.ok(opened.track.stops >= 1, '一時停止し直したのに開き直したマイクが開いたまま');
  assert.strictEqual(log.recorders.length, recs, '一時停止し直したのに次の区間を録り始めた');
  assert.strictEqual(時計の数(log), 0, '一時停止し直したのに 250ms の時計が動いている');
  await log.clock.advance(5_000);
  assert.strictEqual(経過(log), '0:33', '一時停止のままなのに経過時間が進んだ');
  マイクを数える(log);
  await 一時停止を押す(log);   // 再開
  assert.deepStrictEqual(log.called('reportPause').map((c) => c.args[0]), [true, true, false]);
  assert.strictEqual(時計の数(log), 1, '再開の後の 250ms の時計がちょうど1つでない');
  await log.clock.advance(21_000);
  assert.strictEqual(経過(log), '0:54', '止めていた 14 秒（開き直していた間も。main と同じ）を引いた 54 秒にならない');
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
});

test('CLK-2: 開き直している間に一時停止し直してから終了しても、最後の区間は1回だけ届き、開いたマイクを手放す', async () => {
  const { log } = await 議事録を開始();
  await log.clock.advance(10_000);
  await 一時停止を押す(log);
  const gate = 開き直しを待たせる(log);
  await 一時停止を押す(log);   // 再開 → getUserMedia 待ち
  await 一時停止を押す(log);   // 一時停止し直す
  log.fire('onStop');
  await log.drain();
  const opened = 偽ストリーム();
  gate.open(opened);
  await log.drain();
  assert.deepStrictEqual(log.errors.map(fmt), [], '例外');
  assert.deepStrictEqual(log.called('sendSegment').map((c) => c.args[2]), [false, true], '最後の区間が二重に届く／届かない');
  assert.ok(opened.track.stops >= 1, '終了したのに開き直したマイクが開いたまま');
});
