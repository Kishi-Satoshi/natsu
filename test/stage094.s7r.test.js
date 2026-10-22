/*
 * stage094.s7r.test.js — 0.9.4 Task S-7R（計画 docs/plans/2026-10-22-094.md の2回目・3回目の問答 Q15・Q26）: 「速さを測る」と軽いモデル（medium）を外した
 * 持ち主の答え「速さを測るは要らない」・軽いモデルも一緒に外す。画面・preload・main・mainlib・設定・取り込みの一覧に残っていないことを見る。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('S-7R: 「この PC の速さ」の行・［速さを測る］・「軽いモデルと精度」が画面に無く、preload と main の口も無い', { timeout: 5000 }, () => {
  const app = read('src/renderer/app.html');
  for (const w of ['benchRow', 'benchBtn', 'setPopBench', 'この PC の速さ', '速さを測る', 'altBox', '軽いモデルと精度', '.alttable']) assert.ok(!app.includes(w), `app.html に ${w} が残っている`);
  const pre = read('src/preload.js');
  for (const w of ['benchLocal', 'applyBenchThreads', 'altModelStatus', 'fetchAltModel', 'useAltModel']) assert.ok(!pre.includes(w), `preload に ${w}`);
  const main = read('src/main.js');
  for (const w of ["'local:bench'", "'local:bench-threads'", "'local:alt-status'", "'local:alt-fetch'", "'local:alt-use'", 'runBench(', 'benchThreads', 'altModelPath', 'localModelAlt']) assert.ok(!main.includes(w), `main に ${w}`);
  assert.ok(!fs.existsSync(path.join(ROOT, 'test', 'bench.win.test.js')), '本物の読み上げの試験が残っている');
});

test('S-7R: mainlib に速さを測る関数が無く、設定に localModelAlt が無く、取り込みの一覧に ALT_MODELS が無い', { timeout: 5000 }, () => {
  const lib = require('../src/mainlib');
  for (const k of ['BENCH_TEXT', 'benchVoiceScript', 'benchVerdict', 'benchResultText', 'BENCH_THREADS', 'benchThreadCounts', 'benchPickThreads']) assert.ok(!(k in lib), `mainlib に ${k}`);
  assert.ok(!read('src/settings.js').includes('localModelAlt'), '設定に localModelAlt が残っている');
  const man = require('../src/engine-manifest');
  assert.ok(!('ALT_MODELS' in man), 'engine-manifest に ALT_MODELS が残っている');
  const inst = require('../src/engine-install');
  assert.ok(!('installAlt' in inst) && !('altModelFile' in inst), 'engine-install に軽いモデルの取り込みが残っている');
});
