/*
 * stage120.lib.test.js — 0.12.0 Task SP-1（計画 docs/plans/2026-10-22-120.md の決めたこと 80・84・121〜135・140・141・146・147 の純粋な部分。D66・F22〜F25・F31・F32）
 * 流れごとの切れ目と無音の切り（vadStep）・始まりの時刻（segAtOf）・会議の時計（clockOf）・WAV の頭を切る（wavFrom）・タイムライン（timelineOf）・
 * PC の文の頭（partsOf・checkParts）・入口の名前（srcLabel・labeledLine）・録音バーから来た値の照らし（checkLevel・checkSegMeta）・回り込みの割合（bleedOf）・
 * 無音で止める見張りの合わせ（quietUnion）・止まりの見張り（stallStepMs）。フレームの並びは 100ms ごとの「声あり v・なし -」の文字で書く。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/mainlib');
const TL = require('../src/mcp/timeline');
const F = require('../src/mcp/format');

const T = { timeout: 5000 };

// 100ms ごとのフレームを順に回し、最初に切った位置（何個目か。1 から）と種類を返す（切らなければ null）
function runVad(frames, dtMs = 100) {
  let st = L.vadStart();
  for (let i = 0; i < frames.length; i++) {
    const r = L.vadStep(st, { voiced: frames[i] === 'v', dtMs });
    st = r.st;
    if (r.cut) return { at: i + 1, cut: r.cut, st };
  }
  return { at: null, cut: '', st };
}

test('SP-1・F24: vadStep の表（切れ目 700ms・区間 2 秒以上／長い切れ目 1.5 秒／無音 3 秒で idle／短い切れ目は切らない）', T, () => {
  assert.deepStrictEqual(Object.fromEntries(['VOICE_LEVEL', 'FRAME_MAX_MS', 'PAUSE_CUT_MS', 'LONG_PAUSE_MS', 'MIN_SEG_MS', 'IDLE_CUT_MS', 'PRE_ROLL_MS', 'BLEED_SHARE', 'BLEED_NEAR_MS'].map((k) => [k, L[k]])),
    { VOICE_LEVEL: 0.02, FRAME_MAX_MS: 250, PAUSE_CUT_MS: 700, LONG_PAUSE_MS: 1500, MIN_SEG_MS: 2000, IDLE_CUT_MS: 3000, PRE_ROLL_MS: 300, BLEED_SHARE: 0.6, BLEED_NEAR_MS: 3000 });
  // 声 3 秒の後の無音: 7 個目（700ms）で pause
  assert.deepStrictEqual((({ at, cut }) => ({ at, cut }))(runVad('v'.repeat(30) + '-'.repeat(10))), { at: 37, cut: 'pause' });
  // 声 1.0 秒・無音 0.7 秒（区間 1.7 秒）では切らない
  assert.strictEqual(runVad('v'.repeat(10) + '-'.repeat(7)).cut, '');
  // 長い切れ目: 声 0.3 秒の後、無音が 1.5 秒になったら区間が 2 秒より短くても切る（「はい」だけの区間も1行になる）
  assert.strictEqual(runVad('vvv' + '-'.repeat(14)).cut, '');
  assert.deepStrictEqual((({ at, cut }) => ({ at, cut }))(runVad('vvv' + '-'.repeat(20))), { at: 18, cut: 'pause' });
  // 声 1.0 秒・無音 1.0 秒（区間 2 秒になったところ）: 区間が 2 秒以上で無音 700ms 以上なので 20 個目で切る
  assert.deepStrictEqual((({ at, cut }) => ({ at, cut }))(runVad('v'.repeat(10) + '-'.repeat(12))), { at: 20, cut: 'pause' });
  // 無音だけ 3 秒 → idle（29 個では切らない）
  assert.deepStrictEqual((({ at, cut }) => ({ at, cut }))(runVad('-'.repeat(40))), { at: 30, cut: 'idle' });
  assert.strictEqual(runVad('-'.repeat(29)).cut, '');
  // 声 0.3 秒の後に無音 0.6 秒・また声 → 切らない
  assert.strictEqual(runVad('vvv' + '------' + 'v'.repeat(5)).cut, '');
  // 声の数え（voicedMs・firstVoiceMs）
  const s = runVad('----' + 'vv' + '---').st;
  assert.deepStrictEqual(L.vadSummary(s), { voicedMs: 200, firstVoiceMs: 400 });
  assert.deepStrictEqual(L.vadSummary(L.vadStart()), { voicedMs: 0, firstVoiceMs: -1 });
});

test('SP-1: vadStep は dtMs を 0〜FRAME_MAX_MS に丸め、受けた物を変えない', T, () => {
  const st0 = L.vadStart();
  const frozen = JSON.stringify(st0);
  const r = L.vadStep(st0, { voiced: true, dtMs: 400 });
  assert.strictEqual(JSON.stringify(st0), frozen, '受けた st を書き換えた');
  assert.deepStrictEqual(L.vadSummary(r.st), { voicedMs: 250, firstVoiceMs: 0 });
  for (const bad of [-50, NaN, 'x', undefined, Infinity]) {
    const x = L.vadStep(L.vadStart(), { voiced: true, dtMs: bad });
    assert.strictEqual(L.vadSummary(x.st).voicedMs, 0, `dtMs ${bad}`);
  }
  // 壊れた st でも投げない
  assert.doesNotThrow(() => L.vadStep(null, { voiced: false, dtMs: 100 }));
  assert.doesNotThrow(() => L.vadStep({ voicedMs: 'x' }, null));
});

test('SP-1・F23: segAtOf の表（正しい t0 → t0。前の区間の終わりより 1 秒より前・数でない・負・会議の時間＋5 秒より後 → その流れの長さの積み）', T, () => {
  const base = { prevEndMs: 60000, offsetMs: 61000, activeMs: 120000 };
  assert.strictEqual(L.segAtOf({ ...base, t0: 60200 }), 60200);
  assert.strictEqual(L.segAtOf({ ...base, t0: 59000 }), 59000, '1 秒の内の重なりは t0 のまま');
  assert.strictEqual(L.segAtOf({ ...base, t0: 58000 }), 61000, '前の区間の終わりより 2 秒前');
  for (const t0 of [NaN, -1, '60200', null, undefined, 125001, Infinity]) assert.strictEqual(L.segAtOf({ ...base, t0 }), 61000, `t0 ${t0}`);
  assert.strictEqual(L.segAtOf({ ...base, t0: 125000 }), 125000, 'ちょうど＋5 秒は通す');
});

test('SP-1・F31: clockOf は2つの流れの終わりの遅い方（和でない）', T, () => {
  assert.strictEqual(L.clockOf({ mic: { endMs: 600000 }, loopback: { endMs: 598000 } }), 600000);
  assert.strictEqual(L.clockOf({ mic: { endMs: 10 }, loopback: { endMs: 20 } }), 20);
  assert.strictEqual(L.clockOf({ mic: { endMs: 5000 } }), 5000);
  assert.strictEqual(L.clockOf({}), 0);
  assert.strictEqual(L.clockOf(null), 0);
  assert.strictEqual(L.clockOf({ mic: { endMs: NaN }, loopback: { endMs: 3000 } }), 3000);
});

// 16kHz・モノラル・16bit の WAV（標本は i の値を入れて、どこを切ったか分かるようにする）
function wav(ms) {
  const n = Math.round(16 * ms);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 30000, 44 + i * 2);
  return b;
}

test('SP-1・F24: wavFrom は頭の ms を除いた WAV（頭の 44 バイトの長さの欄が合う）。長さ以上・読めない WAV はそのまま', T, () => {
  const w = wav(2000);
  const cut = L.wavFrom(w, 500);
  assert.strictEqual(cut.length, 44 + 1500 * 16 * 2);
  assert.strictEqual(cut.readUInt32LE(4), cut.length - 8);
  assert.strictEqual(cut.readUInt32LE(40), cut.length - 44);
  assert.strictEqual(cut.toString('ascii', 36, 40), 'data');
  assert.strictEqual(cut.readInt16LE(44), 8000, '500ms（8000 標本）の後から始まる');
  assert.strictEqual(L.wavFrom(w, 2000), w);
  assert.strictEqual(L.wavFrom(w, 3000), w);
  assert.strictEqual(L.wavFrom(w, 0), w);
  const junk = Buffer.from('not a wav at all, just bytes');
  assert.strictEqual(L.wavFrom(junk, 100), junk);
  assert.strictEqual(L.wavFrom(w, NaN), w);
});

const seg = (id, atMs, durationMs, text, extra = {}) => ({ id, atMs, durationMs, text, ...extra });

test('SP-1・F23: timelineOf の表（時刻の順・同じ時刻は並びの順・重なりは両方・parts は文ごとの行・failed と pending は場所を保つ・壊れた parts は1行）', T, () => {
  // 届いた順が s1（相手 0:12）・s2（自分 0:10）→ s2・s1
  let rows = TL.timelineOf([seg('s1', 12000, 3000, '相手の文', { src: 'loopback' }), seg('s2', 10000, 3000, '自分の文', { src: 'mic' })]);
  assert.deepStrictEqual(rows.map((r) => r.id), ['s2', 's1']);
  assert.deepStrictEqual(rows[0], { id: 's2', ms: 10000, text: '自分の文', src: 'mic', failed: false, kept: false, pending: false, part: -1 });
  // 同じ時刻 → 並びの順
  rows = TL.timelineOf([seg('s1', 5000, 1000, 'あ', { src: 'loopback' }), seg('s2', 5000, 1000, 'い', { src: 'mic' })]);
  assert.deepStrictEqual(rows.map((r) => r.id), ['s1', 's2']);
  // 重なり（自分 0:10〜0:14・相手 0:12〜0:16）→ 両方残る
  rows = TL.timelineOf([seg('s1', 10000, 4000, '自分が話す', { src: 'mic' }), seg('s2', 12000, 4000, '相手も話す', { src: 'loopback' })]);
  assert.deepStrictEqual(rows.map((r) => [r.id, r.ms]), [['s1', 10000], ['s2', 12000]]);
  // parts のある区間は文ごとの行（時刻は区間の時刻＋ms）で、ほかの流れの行と時刻で混ざる
  const pc = seg('s1', 0, 90000, 'はじめの文。つぎの文。おわりの文。', { src: 'mic', parts: [{ ms: 0, at: 0 }, { ms: 30000, at: 6 }, { ms: 60000, at: 11 }] });
  rows = TL.timelineOf([pc, seg('s2', 40000, 5000, '相手の文', { src: 'loopback' })]);
  assert.deepStrictEqual(rows.map((r) => [r.id, r.ms, r.text, r.part]), [['s1', 0, 'はじめの文。', 0], ['s1', 30000, 'つぎの文。', 1], ['s2', 40000, '相手の文', -1], ['s1', 60000, 'おわりの文。', 2]]);
  // failed・pending の行は場所を保ち、parts で分けない
  rows = TL.timelineOf([seg('s1', 0, 15000, '一つ目', { src: 'mic' }), seg('s2', 15000, 15000, '（失敗）', { failed: true, kept: true, src: 'mic' }), seg('s3', 7000, 15000, '', { pending: true, src: 'loopback' })]);
  assert.deepStrictEqual(rows.map((r) => [r.id, r.failed, r.kept, r.pending]), [['s1', false, false, false], ['s3', false, false, true], ['s2', true, true, false]]);
  // 壊れた parts → 1行
  rows = TL.timelineOf([seg('s1', 0, 90000, 'はじめの文。つぎの文。', { src: 'mic', parts: [{ ms: 0, at: 0 }, { ms: 30000, at: 99 }] })]);
  assert.deepStrictEqual(rows.map((r) => [r.id, r.text, r.part]), [['s1', 'はじめの文。つぎの文。', -1]]);
  // src の無い発言だけなら format.sortSegs と同じ並び（atMs の無い発言は前の発言の後）
  const plain = [seg('s1', 30000, 15000, 'c'), seg('s2', 0, 15000, 'a'), { id: 's3', text: 'b' }, seg('s4', 15000, 15000, 'd')];
  assert.deepStrictEqual(TL.timelineOf(plain).map((r) => r.id), F.sortSegs(plain).map((s) => s.id));
  // 受けた物を変えない・壊れた入力で投げない
  const frozen = JSON.stringify(plain);
  TL.timelineOf(plain);
  assert.strictEqual(JSON.stringify(plain), frozen);
  assert.deepStrictEqual(TL.timelineOf(null), []);
  assert.deepStrictEqual(TL.timelineOf([null, 3, 'x']).length, 0);
  // mainlib は同じ物を出し直す（1か所で決める）
  assert.strictEqual(L.timelineOf, TL.timelineOf);
  for (const k of ['SOURCE_LABELS', 'SPEAKER_LABELS', 'srcLabel', 'checkParts', 'labeledLine']) assert.strictEqual(L[k], TL[k], k);
});

test('SP-1: partsOf の表（倒しの4つ: 時刻が無い・最後の end が長さより 2 秒より長い・直した文の中に見つからない文がある・数が 2〜200 の外。つなぎ言葉を除いた文でも位置が合う）', T, () => {
  const s3 = [{ start: 0, end: 4.2, text: ' はじめの文。' }, { start: 30, end: 33, text: 'つぎの文。' }, { start: 60, end: 89.5, text: 'おわりの文。' }];
  const text = 'はじめの文。つぎの文。おわりの文。';
  assert.deepStrictEqual(L.partsOf(s3, { text, durationMs: 90000 }), [{ ms: 0, at: 0 }, { ms: 30000, at: 6 }, { ms: 60000, at: 11 }]);
  // 最後の end が長さより 2 秒ちょうど長いなら作る・2 秒より長ければ作らない。点検の直し I1（決めたこと 128 の改め）で意図して変えた:
  // 最後の end が長さより前（最後が無音の区間）は作る（前は 2 秒より前でも作らなかった）
  assert.ok(L.partsOf(s3, { text, durationMs: 91500 }));
  assert.ok(L.partsOf(s3, { text, durationMs: 92600 }));
  assert.strictEqual(L.partsOf(s3, { text, durationMs: 86000 }), null);
  // 時刻が無い（古いエンジン）
  assert.strictEqual(L.partsOf([{ text: 'はじめの文。' }, { text: 'つぎの文。' }], { text: 'はじめの文。つぎの文。', durationMs: 10000 }), null);
  assert.strictEqual(L.partsOf(undefined, { text, durationMs: 90000 }), null);
  // 直した文の中に見つからない文
  assert.strictEqual(L.partsOf(s3, { text: 'はじめの文。おわりの文。', durationMs: 90000 }), null);
  // 数が 2〜200 の外
  assert.strictEqual(L.partsOf([s3[0]], { text: 'はじめの文。', durationMs: 4200 }), null);
  const many = Array.from({ length: 201 }, (_, i) => ({ start: i, end: i + 1, text: `文${i}。` }));
  assert.strictEqual(L.partsOf(many, { text: many.map((x) => x.text).join(''), durationMs: 201000 }), null);
  // つなぎ言葉を除いた文: 文ごとに同じ直し（clean）をかけてから探す。直して空になった文は行にしない
  const clean = (t) => String(t).replace(/えーと、?/g, '').trim();
  const withFiller = [{ start: 0, end: 3, text: 'えーと、はじめの文。' }, { start: 3, end: 4, text: 'えーと' }, { start: 30, end: 33, text: 'つぎの文。' }, { start: 60, end: 90, text: 'おわりの文。' }];
  assert.deepStrictEqual(L.partsOf(withFiller, { text, durationMs: 90000, clean }), [{ ms: 0, at: 0 }, { ms: 30000, at: 6 }, { ms: 60000, at: 11 }]);
  // ms と at が増える（同じ start が続くと作らない）
  assert.strictEqual(L.partsOf([{ start: 0, end: 1, text: 'あいう。' }, { start: 0, end: 2, text: 'えお。' }], { text: 'あいう。えお。', durationMs: 2000 }), null);
});

test('SP-1: checkParts の表（形・数・増える並び・文の中・長さの中。違えば null）', T, () => {
  const text = 'はじめの文。つぎの文。おわりの文。';
  const ok = [{ ms: 0, at: 0 }, { ms: 30000, at: 6 }, { ms: 60000, at: 11 }];
  assert.deepStrictEqual(TL.checkParts(ok, text, 90000), ok);
  assert.notStrictEqual(TL.checkParts(ok, text, 90000), ok, '写しを返す');
  const bad = [
    null, 'x', [], [{ ms: 0, at: 0 }],
    [{ ms: 0, at: 0 }, { ms: 30000, at: 6, x: 1 }].map((p) => ({ ms: p.ms, at: p.at })).concat([{ ms: 20000, at: 11 }]),   // 減る ms
    [{ ms: 0, at: 0 }, { ms: 30000, at: 11 }, { ms: 60000, at: 6 }],   // 減る at
    [{ ms: 5, at: 0 }, { ms: 30000, at: 6 }],   // 最初が 0 でない
    [{ ms: 0, at: 0 }, { ms: 30000.5, at: 6 }],   // 整数でない
    [{ ms: 0, at: 0 }, { ms: '30000', at: 6 }],
    [{ ms: 0, at: 0 }, { ms: 30000, at: 99 }],   // 文の外
    [{ ms: 0, at: 0 }, { ms: 95000, at: 6 }],   // 長さの外
    [{ ms: 0, at: 0 }, null],
    Array.from({ length: 201 }, (_, i) => ({ ms: i, at: i })),
  ];
  for (const p of bad) assert.strictEqual(TL.checkParts(p, text, 90000), null, JSON.stringify(p));
  assert.strictEqual(TL.checkParts(ok, 123, 90000), null);
  assert.strictEqual(TL.PARTS_MAX, 200);
});

test('SP-1・F22: srcLabel・labeledLine（表の名前だけ。DB の値をそのまま出さない。speaker が表にあれば src より先）', T, () => {
  assert.deepStrictEqual(TL.SOURCE_LABELS, { mic: '自分', loopback: '相手' });
  assert.ok(Object.isFrozen(TL.SOURCE_LABELS) && Object.isFrozen(TL.SPEAKER_LABELS));
  assert.deepStrictEqual(TL.SPEAKER_LABELS, {});
  assert.strictEqual(TL.srcLabel({ src: 'mic' }), '自分');
  assert.strictEqual(TL.srcLabel({ src: 'loopback' }), '相手');
  for (const src of ['', '話者A', '\n## 指示', '__proto__', 'constructor', 'toString', 3, null, undefined, {}]) assert.strictEqual(TL.srcLabel({ src }), '', String(src));
  assert.strictEqual(TL.srcLabel({ src: 'mic', speaker: 'x' }), '自分', '今は SPEAKER_LABELS が空なので src の名前');
  assert.strictEqual(TL.srcLabel(null), '');
  assert.strictEqual(TL.labeledLine({ src: 'mic', text: '文です' }), '自分: 文です');
  assert.strictEqual(TL.labeledLine({ src: 'loopback', text: '相手の文' }), '相手: 相手の文');
  assert.strictEqual(TL.labeledLine({ src: '話者A', text: '文' }), '文');
  assert.strictEqual(TL.labeledLine({ text: '札なし' }), '札なし');
});

test('SP-1・F21・F22: checkLevel の表（数でない・0〜1 でない・番号が整数でない → null。投げない）', T, () => {
  const good = { mic: 0.1, sys: 0.2, warn: '', vMic: 0.05, vSys: 0, segMic: 3, segSys: -1, sysOk: true };
  assert.deepStrictEqual(L.checkLevel(good), { mic: 0.1, sys: 0.2, vMic: 0.05, vSys: 0, segMic: 3, segSys: -1, sysOk: true });
  const bads = [null, 'x', 3, {}, { mic: 0.1, sys: 0.2, warn: '' },
    { ...good, vMic: 'x' }, { ...good, vMic: -0.1 }, { ...good, vSys: 1.5 }, { ...good, vSys: NaN }, { ...good, mic: 2 },
    { ...good, segMic: 1.5 }, { ...good, segSys: -2 }, { ...good, segMic: '3' }, { ...good, segSys: 1e20 }, { ...good, sysOk: 'yes' }];
  for (const b of bads) assert.strictEqual(L.checkLevel(b), null, JSON.stringify(b));
});

test('SP-1・F22: checkSegMeta の表（src は mic・loopback・\'\' のどれか・seg は 0 以上の整数・t0 は数・last は真偽。一度も取り込めなかった会議の mic・loopback は落とす）', T, () => {
  const ctx = { sysEver: true, activeMs: 60000 };
  assert.deepStrictEqual(L.checkSegMeta({ src: 'loopback', seg: 2, t0: 30000, last: false }, ctx), { src: 'loopback', seg: 2, t0: 30000, last: false });
  assert.deepStrictEqual(L.checkSegMeta({ src: 'mic', seg: 0, t0: 0, last: true }, ctx), { src: 'mic', seg: 0, t0: 0, last: true });
  assert.deepStrictEqual(L.checkSegMeta({ src: '', seg: 5, t0: 40000, last: false }, ctx), { src: '', seg: 5, t0: 40000, last: false });
  // t0 が数でない・負 → t0 は null（その流れの長さの積みに倒す: segAtOf）。4つ目は捨てない
  assert.deepStrictEqual(L.checkSegMeta({ src: 'mic', seg: 1, t0: 'x', last: false }, ctx), { src: 'mic', seg: 1, t0: null, last: false });
  assert.deepStrictEqual(L.checkSegMeta({ src: 'mic', seg: 1, t0: -5, last: false }, ctx), { src: 'mic', seg: 1, t0: null, last: false });
  // 一度も取り込めなかった会議（sysEver: false）には札を付けない
  assert.deepStrictEqual(L.checkSegMeta({ src: 'loopback', seg: 1, t0: 1000, last: false }, { sysEver: false, activeMs: 60000 }), { src: '', seg: 1, t0: 1000, last: false });
  assert.deepStrictEqual(L.checkSegMeta({ src: 'mic', seg: 1, t0: 1000, last: false }, { sysEver: false, activeMs: 60000 }), { src: '', seg: 1, t0: 1000, last: false });
  const bads = [null, undefined, 'x', 7, [], {}, { src: 'speaker', seg: 1, t0: 0, last: false }, { src: '__proto__', seg: 1, t0: 0, last: false },
    { src: 'mic', seg: -1, t0: 0, last: false }, { src: 'mic', seg: 1.5, t0: 0, last: false }, { src: 'mic', seg: '1', t0: 0, last: false },
    { src: 'mic', seg: 1, t0: 0, last: 'no' }, { src: 'mic', seg: 1, t0: 0 }];
  for (const b of bads) assert.strictEqual(L.checkSegMeta(b, ctx), null, JSON.stringify(b));
});

test('SP-1・F24: bleedOf の表（文字の3つ組の割合。同じ文 → 1・相手の文の一部 → 0.6 以上・違う文 → 0.2 未満・空 → 0）', T, () => {
  assert.strictEqual(L.bleedOf('その件は来週にお願いします。', ['その件は来週にお願いします']), 1);
  assert.ok(L.bleedOf('はい、その件は来週に', ['その件は来週にお願いします']) >= 0.6);
  assert.ok(L.bleedOf('見積書は金曜までに送ります', ['在庫の取り込みが遅い件ですね']) < 0.2);
  assert.strictEqual(L.bleedOf('', ['なにか']), 0);
  assert.strictEqual(L.bleedOf('なにか言った', []), 0);
  assert.strictEqual(L.bleedOf('なにか言った', null), 0);
  // 相手の行が2つあれば、どちらかに含まれる3つ組を数える
  assert.strictEqual(L.bleedOf('来週にお願いします', ['来週に', 'お願いします']) >= 0.6, true);
});

test('SP-1・F25: quietUnion の表（相手が話し続け自分が黙る → 止まらない・両方黙る → 小さい方の終わりまで・片方の流れが終わったら残りだけで見る）', T, () => {
  const cfg = { on: true, askMin: 10 };
  const play = (events) => {
    let u = null; let q = { sinceMs: 0, untilMs: 0, askedAt: null, askMin: 0 }; const acts = []; const feeds = [];
    for (const ev of events) {
      const r = L.quietUnion(u, ev);
      u = r.st;
      for (const f of r.feed) { feeds.push(f); const x = L.quietStep(q, f, cfg); q = x.st; if (x.act) acts.push(x.act); }
    }
    return { acts, feeds, q };
  };
  // 相手が 15 分話し続け、自分は黙っている（15 秒ずつの区間）
  const talk = [];
  for (let t = 15000; t <= 15 * 60000; t += 15000) talk.push({ src: 'mic', kind: 'quiet', endMs: t }, { src: 'loopback', kind: 'speech', endMs: t });
  const a = play(talk);
  assert.deepStrictEqual(a.acts, [], '相手が話している間に聞いた');
  assert.ok(a.feeds.every((f) => f.kind !== 'quiet' || f.endMs <= a.q.sinceMs), '相手の話し声の後ろの無音を渡した');
  // 両方黙る: 小さい方の終わりまでを quiet として渡す
  let u = L.quietUnion(null, { src: 'mic', kind: 'quiet', endMs: 60000 });
  assert.deepStrictEqual(u.feed, [], 'もう一方の流れがまだ 0 のところまでしか決まっていない');
  u = L.quietUnion(u.st, { src: 'loopback', kind: 'quiet', endMs: 45000 });
  assert.deepStrictEqual(u.feed, [{ kind: 'quiet', endMs: 45000 }]);
  // 両方 11 分黙ると聞く
  const silent = [];
  for (let t = 15000; t <= 11 * 60000; t += 15000) silent.push({ src: 'mic', kind: 'quiet', endMs: t }, { src: 'loopback', kind: 'quiet', endMs: t });
  assert.deepStrictEqual(play(silent).acts, ['ask']);
  // 片方の流れが終わった（取り込みが切れた）後は残りの流れだけで見る
  const lost = [{ src: 'loopback', kind: 'quiet', endMs: 15000 }, { src: 'loopback', kind: 'end', endMs: 15000 }];
  for (let t = 15000; t <= 11 * 60000; t += 15000) lost.push({ src: 'mic', kind: 'quiet', endMs: t });
  assert.deepStrictEqual(play(lost).acts, ['ask']);
  // 受けた物を変えない・壊れた出来事で投げない
  const st = L.quietUnion(null, { src: 'mic', kind: 'quiet', endMs: 1000 }).st;
  const frozen = JSON.stringify(st);
  L.quietUnion(st, { src: 'loopback', kind: 'speech', endMs: 2000 });
  assert.strictEqual(JSON.stringify(st), frozen);
  assert.doesNotThrow(() => L.quietUnion(st, null));
  assert.deepStrictEqual(L.quietUnion(st, { src: 'x', kind: 'quiet', endMs: 5 }).feed, []);
});

test('SP-1・F32: stallStepMs の表（音のある空の長さの和が 45 秒以上で区間が 2 つ以上のとき止まり。文のある区間で 0 に戻る。音の無い空は数えない）', T, () => {
  let st = null; let r;
  for (let i = 0; i < 3; i++) { r = L.stallStepMs(st, { text: '', levelDbfs: -30, durationMs: 3000 }); st = r.st; assert.strictEqual(r.stall, false, `相づち ${i + 1}`); }
  st = null;
  r = L.stallStepMs(st, { text: '', levelDbfs: -30, durationMs: 30000 }); st = r.st; assert.strictEqual(r.stall, false);
  r = L.stallStepMs(st, { text: '', levelDbfs: -30, durationMs: 15000 }); st = r.st; assert.strictEqual(r.stall, true, '合わせて 45 秒・2 つ');
  // 1つで 45 秒でも区間が 1 つなら止まりにしない
  assert.strictEqual(L.stallStepMs(null, { text: '', levelDbfs: -30, durationMs: 50000 }).stall, false);
  // 文のある区間で 0 に戻る
  st = L.stallStepMs(null, { text: '', levelDbfs: -30, durationMs: 40000 }).st;
  st = L.stallStepMs(st, { text: '文', levelDbfs: -30, durationMs: 3000 }).st;
  assert.strictEqual(L.stallStepMs(st, { text: '', levelDbfs: -30, durationMs: 10000 }).stall, false);
  // 音の無い空は数えない（st はそのまま）
  st = L.stallStepMs(null, { text: '', levelDbfs: -30, durationMs: 40000 }).st;
  const st2 = L.stallStepMs(st, { text: '', levelDbfs: -60, durationMs: 40000 }).st;
  assert.deepStrictEqual(st2, st);
});

// ---------------------------------------------------------------- 点検の直し（2026-10-25）I1（決めたこと 128 の改め。持ち主「最後が無音でも文の時刻を使う（おすすめ）」）
test('点検の直し I1: 最後の文が音声の終わりの数秒〜数十秒前に終わる区間（最後が無音）でも文ごとの行に分ける。最後の end が音声より 2 秒より長い（はみ出す）ときだけ作らない', T, () => {
  const s3 = [{ start: 0, end: 4.2, text: 'はじめの文。' }, { start: 30, end: 33, text: 'つぎの文。' }, { start: 60, end: 64, text: 'おわりの文。' }];
  const text = 'はじめの文。つぎの文。おわりの文。';
  const want = [{ ms: 0, at: 0 }, { ms: 30000, at: 6 }, { ms: 60000, at: 11 }];
  for (const durationMs of [64000, 66500, 70000, 90000]) assert.deepStrictEqual(L.partsOf(s3, { text, durationMs }), want, String(durationMs));
  assert.deepStrictEqual(L.partsOf(s3, { text, durationMs: 62000 }), want);   // はみ出しが 2 秒ちょうど
  for (const durationMs of [61900, 50000]) assert.strictEqual(L.partsOf(s3, { text, durationMs }), null, String(durationMs));
  // 文の頭が長さを越える（大きくはみ出す）形も作らない
  assert.strictEqual(L.partsOf(s3, { text, durationMs: 55000 }), null);
});
