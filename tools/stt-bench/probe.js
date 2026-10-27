'use strict';
// probe.js — ほかのアプリがもたつかないかの目安を測る。文字起こしの比べ（docs/plans/2026-10-27-stt-bench.md）の道具。
// アプリには組み込まない。
//
//   NaTsu.exe を Node として使う（ELECTRON_RUN_AS_NODE=1。bench-stt.ps1 がふつうの優先度で起こす）:
//     probe.js <結果.json> <止めの印のファイル> [--max-sec 10800]
//
// ふつうのアプリと同じ優先度で、2つを測り続ける:
//   - 時計の遅れ: 25 ミリ秒ごとに起きる約束で、実際に何ミリ秒遅れて起きたか（画面の動きや打鍵の返りのもたつきの目安）
//   - 決まった仕事の時間: 1 秒ごとに同じ計算（約 10 ミリ秒ぶん）をして、何ミリ秒かかったか（ほかのアプリが CPU を取れるかの目安）
// 「<止めの印>.go」ができるまでは「静か」（文字起こしの前）、できてからは「負荷」（文字起こしの間）に数える。
// 「<止めの印>」ができたら、数だけを結果の JSON に書いて終わる。
// 依存なし（Node の fs と perf_hooks だけ）。

const fs = require('fs');
const { performance } = require('perf_hooks');

const TICK_MS = 25;
const WORK_EVERY_MS = 1000;

function stats(xs) {
  if (!xs.length) return { n: 0, p50: null, p95: null, p99: null, max: null };
  const s = Float64Array.from(xs).sort();
  const at = (q) => Math.round(s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))] * 10) / 10;
  return { n: s.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Math.round(s[s.length - 1] * 10) / 10 };
}

// 決まった仕事: 乱数のような整数の計算を決まった回数だけ回す（最適化で消されないよう結果を返す）
let sink = 0;
function work(loops) {
  let x = 0x9e3779b9 | 0;
  for (let i = 0; i < loops; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; x = (x + i) | 0; }
  sink ^= x;
  return x;
}

function main() {
  const args = process.argv.slice(2);
  let maxSec = 10800;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-sec') maxSec = Number(args[++i]) || maxSec;
    else pos.push(args[i]);
  }
  if (pos.length !== 2) { console.error('使い方: probe.js <結果.json> <止めの印のファイル> [--max-sec 10800]'); process.exit(2); }
  const [outFile, stopFile] = pos;
  const goFile = `${stopFile}.go`;

  // 仕事の大きさを、始めに約 10 ミリ秒になるよう合わせる（PC ごとに違うため）
  let loops = 200000;
  for (let k = 0; k < 8; k++) {
    const t0 = performance.now(); work(loops); const dt = performance.now() - t0;
    if (dt > 0) loops = Math.max(10000, Math.round(loops * (10 / dt)));
  }

  const phase = { idle: { lag: [], work: [] }, load: { lag: [], work: [] } };
  const started = performance.now();
  let lastWork = started;
  let expect = started + TICK_MS;

  const finish = () => {
    const out = {
      tickMs: TICK_MS, workLoops: loops, sec: Math.round((performance.now() - started) / 100) / 10,
      idle: { lag: stats(phase.idle.lag), work: stats(phase.idle.work) },
      load: { lag: stats(phase.load.lag), work: stats(phase.load.work) },
    };
    fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
    process.exit(0);
  };

  const tick = () => {
    const now = performance.now();
    const p = fs.existsSync(goFile) ? phase.load : phase.idle;
    p.lag.push(Math.max(0, now - expect));
    if (now - lastWork >= WORK_EVERY_MS) {
      const t0 = performance.now(); work(loops); p.work.push(performance.now() - t0);
      lastWork = performance.now();
    }
    if (fs.existsSync(stopFile) || now - started > maxSec * 1000) { finish(); return; }
    expect = performance.now() + TICK_MS;
    setTimeout(tick, TICK_MS);
  };
  setTimeout(tick, TICK_MS);
}

module.exports = { stats, work };

if (require.main === module) main();
