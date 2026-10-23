/*
 * stage100.summary.engine.test.js — 0.10.0 Task LS-3（D59・決めたこと 106・109。計画 docs/plans/2026-10-20-100.md）:
 * エンジンの表・取り込み・設定のキー・「ローカル AI の設定」・起動の確かめ・トレイ・煙テストから要約のローカル AI を外す（文字起こしの whisper と VAD はそのまま）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const T = { timeout: 5000 };
const SUM_KEYS = ['sumServerExe', 'sumModelPath', 'sumPort', 'sumThreads', 'sumCtx'];

test('D59: エンジンの表は whisper の組だけ（文字起こしのエンジン・VAD・文字起こしのモデル）。要約の項目と llama の表が無い', T, () => {
  const M = require('../src/engine-manifest');
  assert.deepStrictEqual(M.MANIFEST.items.map((i) => [i.id, i.group]), [['whisper-engine', 'whisper'], ['whisper-vad', 'whisper'], ['whisper-model', 'whisper']]);
  assert.deepStrictEqual(M.itemsOf('sum'), []);
  const src = read('src/engine-manifest.js');
  for (const w of ['llama', 'LLAMA', 'gemma', 'sum-engine', 'sum-model']) assert.ok(!src.includes(w), `engine-manifest.js に ${w}`);
});

test('D59: 取り込みの組は whisper だけ（engine-install の組・置き場所・installed.json の active）', T, () => {
  const I = require('../src/engine-install');
  const { MANIFEST } = require('../src/engine-manifest');
  const lay = I.layout('C:\\e', MANIFEST, path.win32);
  assert.deepStrictEqual(Object.keys(lay).sort(), ['download', 'installed', 'notices', 'whisper']);
  const empty = I.readInstalled(path.join(ROOT, 'no-such-dir', 'installed.json'));
  assert.deepStrictEqual(empty.active, { whisper: null });
});

test('決めたこと 109・JS6: 設定の決まりの表と既定に要約のキーが無い。保存に残っていた要約のキーは、読み込みで知らないキーとして値のまま残る', T, () => {
  const S = require('../src/settings');
  for (const k of SUM_KEYS) {
    assert.ok(!Object.hasOwn(S.SETTING_RULES, k), `決まりの表に ${k}`);
    assert.ok(!Object.hasOwn(S.defaultSettings(8), k), `既定に ${k}`);
  }
  const raw = { sumServerExe: 'D:\\llm\\llama-server.exe', sumModelPath: 'D:\\llm\\m.gguf', sumPort: 70000, sumThreads: 'x', sumCtx: 2 };
  const r = S.readSettings(raw, S.defaultSettings(8));
  for (const k of SUM_KEYS) assert.deepStrictEqual(r.settings[k], raw[k], `${k} を直した・消した`);
  assert.deepStrictEqual(r.repaired.filter((x) => SUM_KEYS.includes(x.key)), []);
  // 画面から来ても保存の許可に入らない
  assert.deepStrictEqual(S.pickSavable({ sumServerExe: 'x', sumCtx: 1, localPort: 9000 }), { localPort: 9000 });
});

test('D59: 「ローカル AI の設定」のカードに要約の行（llama のパス・モデル・スレッド・ポート・文脈長・起動テスト）が無く、文字起こしの行はそのまま', T, () => {
  const app = read('src/renderer/app.html');
  for (const id of [...SUM_KEYS, 'pickSumExeBtn', 'pickSumModelBtn', 'testSumBtn', 'testSumMsg', 'setPopSThreads', 'setPopCtx']) {
    assert.ok(!new RegExp(`id="${id}"`).test(app), `画面に #${id}`);
    assert.ok(!app.includes(`'${id}'`), `画面の JS に ${id}`);
  }
  assert.ok(!/llama/i.test(app), '画面に llama');
  for (const id of ['localServerExe', 'localModelPath', 'localThreads', 'localPort', 'useVad', 'vadModelPath', 'suppressNst', 'testBtn', 'engineFetchBtn']) assert.match(app, new RegExp(`id="${id}"`), id);
  assert.ok(!read('src/preload.js').includes('testSum'), 'preload に testSum');
});

test('D59: main は要約のエンジンを持たない（sumEng・起動テストの口・トレイ・起動の確かめ）', T, () => {
  const main = read('src/main.js');
  for (const w of ['sumEng', "'app:test-sum'", 'settings.sumPort', 'settings.sumCtx', 'settings.sumThreads', 'sumServerExe', 'sumModelPath']) assert.ok(!main.includes(w), `main.js に ${w}`);
});

test('D59: engine-smoke は whisper と VAD だけを確かめる（llama を落とさない・起こさない）', T, () => {
  const smoke = require('../tools/engine-smoke');
  assert.ok(!('smokeLlama' in smoke), 'smokeLlama が残っている');
  assert.ok(!('llama' in smoke.SMALL) && !('llama' in smoke.PORT));
  const src = read('tools/engine-smoke.js');
  assert.ok(!/llama|sum-engine/i.test(src), 'engine-smoke.js に llama か sum-engine');
});
