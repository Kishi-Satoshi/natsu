/*
 * stage094.lib.test.js — 0.9.4 Task S-1（計画 docs/plans/2026-10-22-094.md の決めたこと 1・7〜10・14・16・29〜31 の純粋な部分）
 * PC の失敗の種類（localFailKind）・速さ（effRtf。whisper の 30 秒の窓）と遅い PC の判断（paceStep・paceSaved）・PC への待ち時間（localTimeoutMs）・
 * 会議の後の目安（afterEtaMin）・PC の区間の上限（LOCAL_SEGMENT_MS_CAP）・クラウドの区切りを背圧で伸ばさない（nextLiveSegmentMs の経路）・
 * 中継の一時の失敗で長い側へ替えない（segmentModeNext・RELAY_TRANSIENT）・中継の 5xx が続いたら間を空ける（relayHoldStep）・帯の順（kept-late）。
 * 時刻は出来事の now だけを使う（Date.now() を読まない）。数は持ち主の engine.log（2026-10-16〜10-22）のもの。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/mainlib');

const T = { timeout: 5000 };
const DAY = 24 * 3600 * 1000;
const MODEL = { name: 'ggml-large-v3-turbo-q5_0.bin', size: 574041195 };

test('localFailKind の表', T, () => {
  const withCause = (code, msg = 'fetch failed') => Object.assign(new TypeError(msg), { cause: Object.assign(new Error('x'), { code }) });
  const named = (name) => Object.assign(new Error('x'), { name });
  const late = [Object.assign(new Error('x'), { late: true, code: 'LOCAL_TIMEOUT' }), named('TimeoutError'), named('AbortError'),
    withCause('UND_ERR_HEADERS_TIMEOUT'), withCause('UND_ERR_BODY_TIMEOUT'), Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' })];
  for (const e of late) assert.strictEqual(L.localFailKind(e), 'late', `${e.name} ${e.code || (e.cause && e.cause.code)}`);
  const down = [withCause('ECONNREFUSED'), withCause('ECONNRESET'), withCause('EPIPE'), withCause('UND_ERR_SOCKET'),
    Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), Object.assign(new Error('起動していません'), { engineMissing: true })];
  for (const e of down) assert.strictEqual(L.localFailKind(e), 'down', `${e.code || (e.cause && e.cause.code) || 'engineMissing'}`);
  const error = [new Error('文字起こしエンジンエラー (500)'), new Error('文字起こしエンジンエラー: failed to read WAV'), new SyntaxError('Unexpected token'),
    null, undefined, 'fetch failed', 42];
  for (const e of error) assert.strictEqual(L.localFailKind(e), 'error', String(e));
  // 時間切れは「つながりませんでした」の側に入れない（undici の時間切れも TypeError('fetch failed')）
  assert.strictEqual(L.localFailKind(withCause('UND_ERR_HEADERS_TIMEOUT')), 'late');
});

test('effRtf は 30 秒の床', T, () => {
  assert.strictEqual(L.effRtf({ audioMs: 15000, procMs: 49000 }), 1.63);
  assert.strictEqual(L.effRtf({ audioMs: 120000, procMs: 138000 }), 1.15);
  assert.strictEqual(L.effRtf({ audioMs: 30000, procMs: 12000 }), 0.4);
  assert.strictEqual(L.effRtf({ audioMs: 240000, procMs: 308000 }), 1.28);
  for (const t of [{ audioMs: 0, procMs: 1000 }, { audioMs: NaN, procMs: 1000 }, { audioMs: 15000, procMs: -1 }, { audioMs: '15000', procMs: 1 }, {}, null]) {
    assert.strictEqual(L.effRtf(t), null, JSON.stringify(t));
  }
});

test('paceStep の表', T, () => {
  const run = (evs, st0 = undefined) => {
    let st = st0;
    const out = [];
    for (const ev of evs) { const r = L.paceStep(st, ev); st = r.st; out.push([r.slow, r.why]); }
    return out;
  };
  const s = (audioSec, procSec) => ({ kind: 'sample', audioMs: audioSec * 1000, procMs: procSec * 1000 });
  // 持ち主の記録（10-22 の会議中）: 15 秒に 49 秒（1.63）→ 1.5 越えの 1 つで遅い（big）
  assert.deepStrictEqual(run([s(15, 49)]), [[true, 'big']]);
  // 1.0 越えが 2 つ続いた（1.2・1.3。1.5 は越えない）→ 2 つ目で遅い（two）
  assert.deepStrictEqual(run([s(75, 90), s(120, 156)]), [[false, ''], [true, 'two']]);
  // 1.6 の 1 つ（1.5 越え）
  assert.deepStrictEqual(run([s(60, 96)]), [[true, 'big']]);
  // 0.9・1.1・0.9 → 続いていないので遅いでない
  assert.deepStrictEqual(run([s(60, 54), s(60, 66), s(60, 54)]), [[false, ''], [false, ''], [false, '']]);
  // 1.0 ちょうどは越えていない
  assert.deepStrictEqual(run([s(60, 60), s(60, 60)]), [[false, ''], [false, '']]);
  // 時間切れが 1 つ → 遅い（late）
  assert.deepStrictEqual(run([{ kind: 'late' }]), [[true, 'late']]);
  // PC の待ち（音声の合計）が 240 秒を越えた → 遅い（backlog）。ちょうど 240 秒は越えていない
  assert.deepStrictEqual(run([{ kind: 'backlog', audioMs: 240000 }, { kind: 'backlog', audioMs: 241000 }]), [[false, ''], [true, 'backlog']]);
  // 遅いの後に速い区間が来ても会議の中は戻らない
  assert.deepStrictEqual(run([s(15, 49), s(60, 18), s(60, 18), s(60, 18)]).map((x) => x[0]), [true, true, true, true]);
  // 30 秒の床: 15 秒に 20 秒（素の比 1.33・床で 0.67）を 2 つ続けても遅いでない
  assert.deepStrictEqual(run([s(15, 20), s(15, 20)]), [[false, ''], [false, '']]);
  // 会議の始め: 覚えが同じモデル・slow・13 日前 → 始めから遅い（saved）。15 日前・別のモデル（名前・大きさ）・slow でない → 遅いでない
  const now = Date.UTC(2026, 9, 22, 1, 0, 0);
  const saved = (o) => ({ schema: 1, model: { ...MODEL }, rtf: 1.7, slow: true, at: now - 13 * DAY, from: 'live', ...o });
  const start = (sv, model = MODEL) => L.paceStep(undefined, { kind: 'start', saved: sv, model, now });
  assert.deepStrictEqual([start(saved()).slow, start(saved()).why], [true, 'saved']);
  assert.strictEqual(start(saved({ at: now - 15 * DAY })).slow, false, '14 日を過ぎた覚えを使った');
  assert.strictEqual(start(saved(), { name: 'ggml-medium-q5_0.bin', size: 539212467 }).slow, false, '別のモデルの覚えを使った');
  assert.strictEqual(start(saved(), { name: MODEL.name, size: MODEL.size + 1 }).slow, false, '大きさの違うモデルの覚えを使った');
  assert.strictEqual(start(saved({ slow: false })).slow, false);
  assert.strictEqual(start(null).slow, false);
  assert.strictEqual(start(saved({ at: 'x' })).slow, false, '形の悪い覚え');
  // 始めの答えの st は会議の中の数えを空から始める（前の会議の続きにしない）
  const fresh = L.paceStep({ slow: true, why: 'big', run: 1, rtf: 2 }, { kind: 'start', saved: null, model: MODEL, now });
  assert.strictEqual(fresh.slow, false);
  assert.deepStrictEqual(run([s(75, 90)], fresh.st), [[false, '']]);
  // 引数の st は書き換えない
  const st0 = { slow: false, why: '', run: 1, rtf: 1.2 };
  const before = JSON.stringify(st0);
  L.paceStep(st0, s(75, 90));
  assert.strictEqual(JSON.stringify(st0), before);
  // 知らない出来事・形の悪い出来事は何も変えない
  assert.deepStrictEqual(run([{ kind: 'x' }, null, s(0, 10)]), [[false, ''], [false, ''], [false, '']]);
});

test('paceSaved: rtf は重み 0.5 の移動平均・bench で 0.6 以下なら slow 偽・1.0 越えで真・間は前のまま・モデルの name と size を持つ', T, () => {
  const now = Date.UTC(2026, 9, 22, 2, 0, 0);
  const s = (audioSec, procSec) => ({ kind: 'sample', audioMs: audioSec * 1000, procMs: procSec * 1000 });
  let st;
  for (const ev of [s(60, 96), s(60, 120)]) st = L.paceStep(st, ev).st;
  // 会議の中の rtf: 1.6 → 1.6 + 0.5 × (2.0 − 1.6) = 1.8
  const first = L.paceSaved(st, null, { model: MODEL, now, from: 'live' });
  assert.deepStrictEqual(first, { schema: 1, model: { name: MODEL.name, size: MODEL.size }, rtf: 1.8, slow: true, at: now, from: 'live' });
  // 前の覚え（同じモデル）と重み 0.5 で混ぜる
  const prev = { schema: 1, model: { ...MODEL }, rtf: 1.0, slow: false, at: now - DAY, from: 'live' };
  assert.strictEqual(L.paceSaved(st, prev, { model: MODEL, now, from: 'live' }).rtf, 1.4);
  // 別のモデルの覚えとは混ぜない
  assert.strictEqual(L.paceSaved(st, { ...prev, model: { name: 'ggml-medium-q5_0.bin', size: 539212467 } }, { model: MODEL, now, from: 'live' }).rtf, 1.8);
  // 測った数（bench）: 0.6 以下なら slow を外す・1.0 越えなら slow・間は前のまま
  const slowPrev = { ...prev, slow: true };
  const bench = (r, p) => L.paceSaved({ rtf: r }, p, { model: MODEL, now, from: 'bench' });
  assert.strictEqual(bench(0.6, slowPrev).slow, false);
  assert.strictEqual(bench(0.61, slowPrev).slow, true, '0.6 と 1.0 の間は前のまま');
  assert.strictEqual(bench(0.8, prev).slow, false, '0.6 と 1.0 の間は前のまま');
  assert.strictEqual(bench(1.01, prev).slow, true);
  assert.strictEqual(bench(1.0, prev).slow, false);
  assert.strictEqual(bench(0.5, slowPrev).from, 'bench');
  // 始めから遅い会議（覚えから。PC に送っていない）は覚えを書き直さない（14 日の期限を延ばさない）
  const savedStart = L.paceStep(undefined, { kind: 'start', saved: { ...slowPrev, at: now - DAY }, model: MODEL, now }).st;
  assert.strictEqual(L.paceSaved(savedStart, slowPrev, { model: MODEL, now, from: 'live' }), null);
  // 数えた区間も遅いもない会議は書かない
  assert.strictEqual(L.paceSaved(L.paceStep(undefined, { kind: 'start', saved: null, model: MODEL, now }).st, null, { model: MODEL, now, from: 'live' }), null);
  // モデルが分からなければ書かない
  assert.strictEqual(L.paceSaved(st, null, { model: null, now, from: 'live' }), null);
  assert.ok(Object.isFrozen(L.PACE));
  assert.deepStrictEqual({ ...L.PACE }, { over: 1.0, big: 1.5, backlogMs: 240000, exit: 0.6, ttlMs: 14 * DAY, alpha: 0.5 });
});

test('localTimeoutMs の表', T, () => {
  assert.strictEqual(L.localTimeoutMs({ audioMs: 15000 }), 240000);
  assert.strictEqual(L.localTimeoutMs({ audioMs: 15000, rtf: null }), 240000);
  assert.strictEqual(L.localTimeoutMs({ audioMs: 120000, rtf: 1.7 }), 468000);
  assert.strictEqual(L.localTimeoutMs({ audioMs: 300000, rtf: 4 }), 1800000, '30 分で切る');
  assert.strictEqual(L.localTimeoutMs({ audioMs: 120000, rtf: 0.5 }), 300000, 'rtf 0.5 は 1 として数える');
  assert.strictEqual(L.localTimeoutMs({ audioMs: 2000, rtf: 3 }), 240000, '30 秒の床と 240 秒の床');
  assert.strictEqual(L.localTimeoutMs({ audioMs: NaN, rtf: 'x' }), 240000);
  assert.strictEqual(L.LOCAL_SEGMENT_MS_CAP, 90000);   // 持ち主の答え Q3
});

test('afterEtaMin: 音声 × max(rtf, 1) を分に切り上げ', T, () => {
  assert.strictEqual(L.afterEtaMin({ audioMs: 42 * 60000, rtf: 1.66 }), 70);
  assert.strictEqual(L.afterEtaMin({ audioMs: 10 * 60000, rtf: 0.4 }), 10, '速い PC でも録った長さより短く言わない');
  assert.strictEqual(L.afterEtaMin({ audioMs: 61000, rtf: null }), 2);
  assert.strictEqual(L.afterEtaMin({ audioMs: 0, rtf: 2 }), 0);
});

test('S6: クラウドの側は背圧で伸ばさない（short は待ち 5 でも 15 秒・途中なら 20 秒）。PC の側は 90 秒まで（持ち主の答え Q3）', T, () => {
  const n = L.nextLiveSegmentMs;
  // short（クラウド）
  assert.strictEqual(n(5, 15000, 15000, 1, 'short'), 15000, '始めの 15 秒のまま');
  assert.strictEqual(n(6, 20000, 15000, 1, 'short'), 20000, '途中で戻した 20 秒のまま');
  assert.strictEqual(n(4, 75000, 15000, 1, 'short'), 20000, '長い側から戻すときは 20 秒（録音バーの下限）');
  assert.strictEqual(n(0, 15000, 15000, -1, 'short'), 15000);
  // long（PC）: 75 → 90（150 にならない）→ 90、待ち 1 以下で基準へ
  assert.strictEqual(n(4, 75000, 75000, 1, 'long'), 90000);
  assert.strictEqual(n(5, 90000, 75000, 1, 'long'), 90000);
  assert.strictEqual(n(1, 90000, 75000, -1, 'long'), 75000);
  assert.strictEqual(n(2, 15000, 75000, 0, 'long'), 75000, '長い側へは待ちが残っていてもすぐ');
  // 設定 300 秒・120 秒でも long の基準は 90 秒
  assert.strictEqual(L.segmentBaseMs('long', 300), 90000);
  assert.strictEqual(L.segmentBaseMs('long', 120), 90000);
  assert.strictEqual(L.segmentBaseMs('long', 90), 90000);
  assert.strictEqual(L.segmentBaseMs('long', 75), 75000);
  assert.strictEqual(n(0, 90000, L.segmentBaseMs('long', 300), -1, 'long'), 90000);
  assert.strictEqual(n(4, 40000, 40000, 1, 'long'), 80000);
  assert.strictEqual(n(4, 60000, 60000, 1, 'long'), 90000);
  // 背圧の素の判断も 90 秒まで
  assert.strictEqual(L.nextSegmentMs(4, 75000, 75000, 1), 90000);
  assert.strictEqual(L.nextSegmentMs(6, 120000, 75000, 1), 90000);
});

test('segmentModeNext は中継の一時の失敗を数えない', T, () => {
  const run = (st, whys) => whys.map((why) => (st = L.segmentModeNext(st, { route: 'local', why })).mode);
  const short = { mode: 'short', localRun: 0, cloudRun: 3 };
  assert.deepStrictEqual(run(short, ['server', 'server', 'server']), ['short', 'short', 'short']);
  for (const why of L.RELAY_TRANSIENT) assert.deepStrictEqual(run(short, [why, why, why]), ['short', 'short', 'short'], why);
  assert.deepStrictEqual(run(short, ['local-only']), ['long']);
  assert.deepStrictEqual(run(short, ['signed-out']), ['long']);
  assert.deepStrictEqual(run(short, ['offline', 'offline']), ['short', 'long']);
  assert.deepStrictEqual(run(short, ['slow']), ['long']);
  // 一時の失敗の間も、クラウドで文字になれば今どおり short の数えが続く
  let st = { mode: 'long', localRun: 3, cloudRun: 0 };
  st = L.segmentModeNext(st, { route: 'local', why: 'server' });
  assert.strictEqual(st.mode, 'long', '一時の失敗で短い側にもしない');
  // 中継の符号の全部（stt-cloud）と経路の why のうち、一時のものだけが表にある
  assert.deepStrictEqual([...L.RELAY_TRANSIENT], ['server', 'net', 'timeout', 'unreachable', 'bad-reply', 'relay-hold']);
  assert.ok(Object.isFrozen(L.RELAY_TRANSIENT));
  for (const w of L.STICKY_LOCAL) assert.ok(!L.RELAY_TRANSIENT.includes(w), w);
});

test('relayHoldStep の表', T, () => {
  const now = Date.UTC(2026, 9, 22, 1, 38, 57);
  const run = (codes, st0) => {
    let st = st0;
    return codes.map((code, i) => { const r = L.relayHoldStep(st, { code, now: now + i * 1000 }); st = r.st; return r.holdMs; });
  };
  assert.deepStrictEqual(run(['server']), [0]);
  assert.deepStrictEqual(run(['server', 'server']), [0, 60000]);
  assert.deepStrictEqual(run(['server', 'server', 'server', 'server', 'server', 'server']), [0, 60000, 120000, 300000, 600000, 600000]);
  // クラウドで文字になったら 0 に戻る
  assert.deepStrictEqual(run(['server', 'server', 'ok', 'server', 'server']), [0, 60000, 0, 0, 60000]);
  // server でない符号は数えない（続きも切らない）
  assert.deepStrictEqual(run(['server', 'net', 'server']), [0, 0, 60000]);
  assert.deepStrictEqual(run(['net', 'net', 'timeout', 'unreachable']), [0, 0, 0, 0]);
  // 引数の st は書き換えない
  const st0 = { run: 1 };
  L.relayHoldStep(st0, { code: 'server', now });
  assert.deepStrictEqual(st0, { run: 1 });
  assert.deepStrictEqual([...L.RELAY_HOLD_LADDER_MS], [60000, 120000, 300000, 600000]);
});

test('PROBLEM_ORDER の kept-late は engine-down の後・kept-local の前', T, () => {
  const o = L.PROBLEM_ORDER;
  assert.strictEqual(o.indexOf('kept-late'), o.indexOf('engine-down') + 1);
  assert.ok(o.indexOf('kept-late') < o.indexOf('kept-local'));
  // 帯の選び方: engine-down と kept-late が両方あれば engine-down、kept-late と kept-local なら kept-late
  assert.strictEqual(L.sttProblemOf(new Map([['kept-local', {}], ['kept-late', {}]])).code, 'kept-late');
  assert.strictEqual(L.sttProblemOf(new Map([['kept-late', {}], ['engine-down', {}]])).code, 'engine-down');
  // Windows の知らせは増やさない
  assert.ok(!L.WIN_NOTIFY_CODES.includes('kept-late'));
});

// ---------------------------------------------------------------- S-7（決めたこと 19〜22・持ち主の答え Q9）: 速さを測る
test('benchVerdict の表（0.5・0.51・1.0・1.01）と結果の文（画面は作らない）', T, () => {
  assert.deepStrictEqual([0.4, 0.5, 0.51, 1.0, 1.01, 1.6].map(L.benchVerdict), ['ok', 'ok', 'maybe', 'maybe', 'slow', 'slow']);
  assert.strictEqual(L.benchResultText(0.4), '30 秒の音声に 12 秒（0.40 倍）。会議中も PC で文字起こしできます。');
  assert.strictEqual(L.benchResultText(0.8), '30 秒の音声に 24 秒（0.80 倍）。会議中は追いつけないことがあります。追いつけないときは音声を残し、会議の後で文字起こしします。');
  assert.strictEqual(L.benchResultText(1.6), '30 秒の音声に 48 秒（1.60 倍）。この PC では会議中に追いつけません。会議中は音声を残し、会議の後で文字起こしします。会議中も文字にしたいときは、軽いモデルに替えられます（精度は下がります）。');
});

test('benchVoiceScript は System.Speech と 16000・Sixteen・Mono・ja の声の選びだけを持ち、Invoke-WebRequest・Start-Process・Remove-Item の外のパスの字面が無い。声が無ければ novoice の1行', T, () => {
  const out = 'C:\\Users\\Example\\AppData\\Local\\Temp\\natsu-bench-1.wav';
  const sc = L.benchVoiceScript({ out, text: L.BENCH_TEXT });
  for (const must of ['Add-Type -AssemblyName System.Speech', 'SpeechSynthesizer', 'SpeechAudioFormatInfo(16000', 'AudioBitsPerSample]::Sixteen', 'AudioChannel]::Mono',
    "Culture.Name -eq 'ja-JP'", "WriteLine('novoice')", "WriteLine('ok')", `SetOutputToWaveFile('${out}'`]) assert.ok(sc.includes(must), must);
  for (const bad of ['Invoke-WebRequest', 'Invoke-RestMethod', 'Net.WebClient', 'Start-Process', 'Remove-Item', 'http://', 'https://', 'DownloadString']) assert.ok(!sc.includes(bad), bad);
  // 外のパスは出力の1つだけ（' は二重にして PowerShell の文字に閉じ込める）
  assert.ok(L.benchVoiceScript({ out: "C:\\a'b.wav", text: "x'y" }).includes("'C:\\a''b.wav'"));
  assert.ok(L.BENCH_TEXT.length >= 200 && L.BENCH_TEXT.length <= 400, String(L.BENCH_TEXT.length));
  assert.ok(!/[\r\n]/.test(L.BENCH_TEXT));
  // switch・[ValidateSet] を使わない（PowerShell の決まり）
  assert.ok(!/\bswitch\b|ValidateSet/.test(sc));
});

test('benchThreadCounts の表（4・6・10 と今の数。CPU の数を越える数は除く）', T, () => {
  assert.deepStrictEqual(L.benchThreadCounts({ cpus: 12, current: 10 }), [4, 6, 10]);
  assert.deepStrictEqual(L.benchThreadCounts({ cpus: 8, current: 6 }), [4, 6]);
  assert.deepStrictEqual(L.benchThreadCounts({ cpus: 4, current: 4 }), [4]);
  assert.deepStrictEqual(L.benchThreadCounts({ cpus: 16, current: 14 }), [4, 6, 10, 14]);
  assert.deepStrictEqual(L.benchThreadCounts({ cpus: 2, current: 2 }), [2]);
  assert.deepStrictEqual(L.benchThreadCounts({ cpus: 12, current: 'x' }), [4, 6, 10]);
});

test('benchPickThreads の表（一番速い数・同じなら今の数・次に少ない数）', T, () => {
  const r = (a) => a.map(([threads, rtf]) => ({ threads, rtf }));
  assert.strictEqual(L.benchPickThreads(r([[4, 0.9], [6, 0.7], [10, 0.95]]), 10), 6);
  assert.strictEqual(L.benchPickThreads(r([[4, 0.9], [6, 0.9], [10, 0.95]]), 10), 4);
  assert.strictEqual(L.benchPickThreads(r([[4, 0.9], [6, 0.8], [10, 0.8]]), 10), 10);
  assert.strictEqual(L.benchPickThreads(r([[4, 1.2]]), 4), 4);
  assert.strictEqual(L.benchPickThreads(r([[4, null], [6, 0.8]]), 4), 6, '測れなかった数は選ばない');
  assert.strictEqual(L.benchPickThreads([], 10), 10);
});
