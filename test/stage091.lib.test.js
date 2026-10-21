/*
 * stage091.lib.test.js — 0.9.1 の純粋な関数（計画 docs/plans/2026-10-21-091.md の Task Q-1。設計書 D29）
 * - 無音の判定（wavLoudestDbfs・SILENT_DBFS）: 一番大きい 0.5 秒の窓（0.25 秒ずつずらす）の RMS で見る（決めたこと 1）
 * - 認識ヒントの作り話の判定（hintEcho）: 答えの片が全部ヒントの材料なら真（決めたこと 2・3）
 * - 話し声が無いときに聞いて止める決め方（quietStep）: 会議の時計で数え、N 分で聞き、聞いてから 5 分で止める（決めたこと 8）
 * - 所要時間の終わり（quietTrimEnd）と時刻の書き方（clockText）（決めたこと 11）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const L = require('../src/mainlib');

const T = { timeout: 5000 };
const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
// main.js の `const NAME = …;` の値（配列・文字）を読む（main.js は electron を読むので require できない）
function constOf(name) {
  const at = MAIN.indexOf(`\nconst ${name} = `);
  assert.ok(at >= 0, `main.js に ${name} が無い`);
  const from = at + `\nconst ${name} = `.length;
  const to = MAIN.indexOf(';\n', from);
  return vm.runInNewContext(`(${MAIN.slice(from, to)})`, {});
}
const BUILTIN = constOf('BUILTIN_TERMS');
const SAMPLE = constOf('PROMPT_SAMPLE');

// 16kHz・モノラル・16bit の WAV（gen(i) が -1〜1 の値を返す。範囲の外は切る）
function wavOf(sec, gen = () => 0) {
  const n = Math.round(16000 * sec);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(gen(i) * 32768))), 44 + i * 2);
  return b;
}
// RMS が dbfs の 220Hz の正弦波を [from, to) 秒だけ鳴らす
const ampOf = (dbfs) => 10 ** (dbfs / 20) * Math.SQRT2;
const toneAt = (dbfs, from, to) => (i) => (i >= from * 16000 && i < to * 16000 ? ampOf(dbfs) * Math.sin((2 * Math.PI * 220 * i) / 16000) : 0);

test('QS1: wavLoudestDbfs は一番大きい 0.5 秒の窓の RMS（0.25 秒ずつずらす）。全部 0 は -Infinity、一定の音はその RMS', T, () => {
  assert.strictEqual(L.wavLoudestDbfs(wavOf(2)), -Infinity);
  const v = L.wavLoudestDbfs(wavOf(2, toneAt(-15, 0, 2)));
  assert.ok(Math.abs(v - -15) < 0.5, String(v));
  assert.strictEqual(L.QUIET_WIN_MS, 500);
  assert.strictEqual(L.QUIET_HOP_MS, 250);
});

test('QS1: 15 秒の無音の真ん中の 0.6 秒の小さな音（-45 dBFS）は、一番大きい窓で -46 dBFS より大きい（区間全体の RMS では -55 dBFS より小さく、無音に見える）', T, () => {
  const w = wavOf(15, toneAt(-45, 7.2, 7.8));
  const loud = L.wavLoudestDbfs(w);
  assert.ok(loud > -46, `一番大きい窓 ${loud}`);
  assert.ok(loud >= L.SILENT_DBFS, '小さな発言を無音にした');
  assert.ok(L.wavLevelDbfs(w) < L.SILENT_DBFS, `区間全体 ${L.wavLevelDbfs(w)}（全体で見ると落ちることを示す前提）`);
});

test('QS1: 0.3 秒の音が 0.5 秒の窓の境にまたがっても、窓を重ねるので音そのものの RMS から 3.5 dB 以内（重ねないと 4.5 dB 以上薄まる）', T, () => {
  const loud = L.wavLoudestDbfs(wavOf(2, toneAt(-15, 0.375, 0.675)));
  assert.ok(loud >= -15 - 3.5, String(loud));
});

test('QS1: 窓より短い WAV は全体で1つの窓。読めない WAV（RIFF でない・8bit・data が無い・中身が無い）は null（無音にしない）', T, () => {
  const v = L.wavLoudestDbfs(wavOf(0.2, toneAt(-20, 0, 0.2)));
  assert.ok(Math.abs(v - -20) < 0.5, String(v));
  assert.strictEqual(L.wavLoudestDbfs(Buffer.from('not a wav at all, just some bytes here')), null);
  assert.strictEqual(L.wavLoudestDbfs(null), null);
  const b8 = wavOf(1, toneAt(-20, 0, 1));
  b8.writeUInt16LE(8, 34);
  assert.strictEqual(L.wavLoudestDbfs(b8), null);
  const nodata = wavOf(1);
  nodata.write('junk', 36, 'ascii');
  assert.strictEqual(L.wavLoudestDbfs(nodata), null);
  assert.strictEqual(L.wavLoudestDbfs(wavOf(0)), null);
});

test('QS2: SILENT_DBFS は -55。録音バーの無音の警告（RMS 約 -44.6 dBFS）と止まりの見張りの STALL_MIN_DBFS（-40）より小さい', T, () => {
  assert.strictEqual(L.SILENT_DBFS, -55);
  assert.ok(L.SILENT_DBFS < 20 * Math.log10(0.02 / 3.4));
  assert.ok(L.SILENT_DBFS < L.STALL_MIN_DBFS);
  assert.strictEqual(L.SPEECH_DBFS, L.STALL_MIN_DBFS);
});

const HINT = { sample: SAMPLE, terms: [...BUILTIN, '固有名詞エックス'], tail: 'それでは来週までに資料を共有します。' };
const echo = (t, o) => L.hintEcho(t, HINT, o);

test('QE1: hintEcho は認識ヒントの材料（文例・業務の言葉・辞書の語・尻尾）だけの答えを真にする', T, () => {
  assert.strictEqual(SAMPLE, 'お疲れさまです。よろしくお願いします。');
  const yes = [
    'お疲れさまです。よろしくお願いします。', 'よろしくお願いします。', `${BUILTIN.join('、')}。`, '不具合', '不具合。',
    'お疲れさまですよろしくお願いします', 'お疲れさまです よろしくお願いします', '不具合 改修 受注', '固有名詞エックス。',
    '資料を共有します。', 'お疲れさまです。不具合、改修。', '不具合改修', 'お疲れさまです!', '  不具合、、改修。 ',
  ];
  for (const t of yes) assert.strictEqual(echo(t), true, t);
  const no = ['', '   ', '不具合が2件あります。', '来週リリースします。', 'お疲れさまです。今日の議題は進捗です。', '本日の議題は進捗の確認です。区間1', '。、'];
  for (const t of no) assert.strictEqual(echo(t), false, t);
});

test('QE2: 尻尾は 4 字以上の片だけ材料にする（尻尾にある「はい」で本物の「はい」を落とさない）。1 字の辞書の語は単位にしない', T, () => {
  const h = { sample: '', terms: ['あ', 'い'], tail: 'はい、承知しました。' };
  assert.strictEqual(L.hintEcho('はい。', h), false);
  assert.strictEqual(L.hintEcho('承知しました。', h), true);
  assert.strictEqual(L.hintEcho('あい', h), false);
  assert.strictEqual(L.HINT_TAIL_MIN, 4);
  // 材料が無い（英語の設定で辞書も無い）なら、どの答えも偽
  assert.strictEqual(L.hintEcho('お疲れさまです。', { sample: '', terms: [], tail: '' }), false);
});

test('QE3: 音声入力（dictation）は録った音の一番大きい窓が -40 dBFS より小さいときだけ真（大きな声の「お疲れさまです。」は口述として残す）。会議は音の大きさによらず真', T, () => {
  assert.strictEqual(echo('お疲れさまです。', { dictation: true, loudDbfs: -20 }), false);
  assert.strictEqual(echo('お疲れさまです。', { dictation: true, loudDbfs: -50 }), true);
  assert.strictEqual(echo('お疲れさまです。', { dictation: true, loudDbfs: null }), false);
  assert.strictEqual(echo('お疲れさまです。', { dictation: false, loudDbfs: -20 }), true);
  assert.strictEqual(echo('不具合', { loudDbfs: -10 }), true);
});

// 1 分の区間を並べて quietStep を回す。ev は [種類, 区間の終わり（分）] の並び → 動きの並び
const MIN = 60000;
function run(evs, cfg = { on: true, askMin: 10 }, st0) {
  let st = st0;
  const acts = [];
  for (const [kind, endMin] of evs) {
    const r = L.quietStep(st, { kind, endMs: endMin * MIN }, typeof cfg === 'function' ? cfg(acts.length) : cfg);
    st = r.st;
    acts.push(r.act);
  }
  return { acts, st };
}
const quietTo = (from, to) => Array.from({ length: to - from }, (_, i) => ['quiet', from + i + 1]);

test('QQ1: quietStep は話し声の無い長さが askMin 分で ask、聞いた時から 5 分で stop（会議の時計）', T, () => {
  const { acts } = run([['speech', 1], ...quietTo(1, 20)]);
  // 11 分の終わり（話し声の無い 10 分）で聞き、16 分の終わりで止める
  assert.strictEqual(acts.indexOf('ask'), 10);
  assert.strictEqual(acts.filter((a) => a === 'ask').length, 1);
  assert.strictEqual(acts.indexOf('stop'), 15);
  assert.deepStrictEqual(acts.slice(11, 15), ['', '', '', '']);
  assert.strictEqual(L.QUIET_GRACE_MS, 5 * MIN);
  // 5 分に設定すれば 6 分の終わりで聞き、11 分の終わりで止める
  const five = run([['speech', 1], ...quietTo(1, 12)], { on: true, askMin: 5 });
  assert.strictEqual(five.acts.indexOf('ask'), 5);
  assert.strictEqual(five.acts.indexOf('stop'), 10);
  assert.strictEqual(five.st.askMin, 5);
});

test('QQ2: 聞いている間に speech が来たら withdraw し、数えは speech の終わりから。keep-going は endMs から数え直して withdraw', T, () => {
  const a = run([['speech', 1], ...quietTo(1, 12), ['speech', 13], ...quietTo(13, 25)]);
  assert.strictEqual(a.acts[12], 'withdraw');
  assert.strictEqual(a.acts.indexOf('ask', 13), 22);
  assert.ok(!a.acts.slice(0, 13).includes('stop'));
  const k = run([['speech', 1], ...quietTo(1, 12), ['keep-going', 12], ...quietTo(12, 24)]);
  assert.strictEqual(k.acts[12], 'withdraw');
  assert.ok(!k.acts.slice(13, 22).includes('ask'), JSON.stringify(k.acts));
  assert.strictEqual(k.acts.indexOf('ask', 13), 22);
  // 聞いていないときの keep-going は何もしない（数えだけ戻す）
  assert.strictEqual(run([['speech', 1], ['quiet', 2], ['keep-going', 2]]).acts[2], '');
});

test('QQ3: on が偽なら ask も stop もしない。聞いている間にオフにしたら withdraw', T, () => {
  const off = run([['speech', 1], ...quietTo(1, 30)], { on: false, askMin: 10 });
  assert.deepStrictEqual([...new Set(off.acts)], ['']);
  const turned = run([['speech', 1], ...quietTo(1, 14)], (i) => ({ on: i < 12, askMin: 10 }));
  assert.strictEqual(turned.acts[10], 'ask');
  assert.strictEqual(turned.acts[12], 'withdraw');
  assert.ok(!turned.acts.includes('stop'));
});

test('QQ4: 1 つの区間で ask の長さと stop の長さを一度に越えても、聞いてから 5 分の猶予がある。壊れた st・ev でも投げない', T, () => {
  const j = run([['quiet', 20], ['quiet', 21], ['quiet', 24], ['quiet', 25]]);
  assert.deepStrictEqual(j.acts, ['ask', '', '', 'stop']);
  for (const st of [undefined, null, 'x', { sinceMs: NaN, untilMs: 'a', askedAt: {} }]) {
    assert.doesNotThrow(() => L.quietStep(st, { kind: 'quiet', endMs: MIN }, { on: true, askMin: 10 }));
  }
  assert.doesNotThrow(() => L.quietStep({}, null, null));
  // 時計が戻る区間（終わりが前より小さい）でも数えは戻らない
  const back = run([['speech', 5], ['quiet', 3], ['quiet', 16]]);
  assert.deepStrictEqual(back.acts, ['', '', 'ask']);
});

test('QT1: quietTrimEnd は区間の終わり（atMs + durationMs）の一番遅い値（無ければ null）。clockText は画面の fmtClock と同じ書き方', T, () => {
  assert.strictEqual(L.quietTrimEnd([{ atMs: 0, durationMs: 60000 }, { atMs: 120000, durationMs: 15000 }, { atMs: 60000, durationMs: 15000 }]), 135000);
  assert.strictEqual(L.quietTrimEnd([]), null);
  assert.strictEqual(L.quietTrimEnd(null), null);
  assert.strictEqual(L.quietTrimEnd([{ atMs: 'x' }, null, { atMs: 1000, durationMs: 500 }]), 1500);
  assert.strictEqual(L.clockText(0), '0:00');
  assert.strictEqual(L.clockText(3088000), '51:28');
  assert.strictEqual(L.clockText(6180000), '1:43:00');
  // 画面の fmtClock と同じ式（app.html の字面から読む）
  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.html'), 'utf8');
  const at = app.indexOf('  function fmtClock(ms) {');
  const fmtClock = vm.runInNewContext(`(${app.slice(at, app.indexOf('\n  }', at) + 4).trim()})`, {});
  for (const ms of [0, 999, 59999, 60000, 3599999, 3600000, 6180000, 36000000]) assert.strictEqual(L.clockText(ms), fmtClock(ms), String(ms));
});
