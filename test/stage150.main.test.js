/*
 * stage150.main.test.js — 0.15.0「ページの階層」の main の場面（計画 docs/plans/2026-11-03-150.md の Task PH-3・PH-4）
 * main.js を偽の Electron の上で本当に動かす（helpers/mainrun.js の --json-scene）。
 * PH-3（決めたこと 19・F118）: ui:get のサイドバーの木の開け閉め（tree.open）は今あるページだけ（無いページは落とし、数だけを記録に1行）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});

test('PH-3・F118: ui:get の tree は今あるページだけ（無いページの開け閉めは落とし、engine.log には数だけ）。2回目の ui:get は外した後の形', { timeout: sceneTimeout(20000) }, async () => {
  const r = await run(['text', '--json-scene=ws-tree-get']);
  assert.deepStrictEqual(r.ui.tree, { open: ['ptkeep2', 'ptkeep1'] }, '無いページの開け閉めを返した（覚えた並びのまま残す）');
  assert.deepStrictEqual(r.again.tree, { open: ['ptkeep2', 'ptkeep1'] });
  assert.deepStrictEqual(r.engineLog.filter((l) => /無いページの木の開け閉め/.test(l)), ['画面の覚え書き: 無いページの木の開け閉めを 2 個外した'], r.engineLog.join('\n'));
  assert.ok(!r.engineLog.some((l) => /ptgone|ptkeep/.test(l)), 'engine.log にページの id を書いた');
});
