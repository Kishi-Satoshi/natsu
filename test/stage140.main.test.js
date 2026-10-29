/*
 * stage140.main.test.js — 0.14.0 の main の場面（計画 docs/plans/2026-10-26-140.md の Task EB-3〜）
 * 偽の Electron の上で main.js を本当に動かして確かめる（helpers/mainrun.js）。
 * EB-3（決めたこと 35・R24・F103）: 起きたときに Electron の既定のメニューを外す（Ctrl+W・Ctrl+Z・Ctrl+R を既定のメニューに横取りさせない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args, { env = {}, timeout = 30000 } = {}) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, ...env }, maxBuffer: 1 << 24, timeout }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});
const T = { timeout: sceneTimeout(30000) };

test('EB-3・F103（決めたこと 35・R24）: main は起きたときに、窓を作る前に既定のメニューを1回外す（Menu.setApplicationMenu(null)）', T, async () => {
  const r = await run(['text', '--json-scene=plain']);
  assert.ok(r.windows >= 2, '前提: 録音バーと本体の窓ができる');
  assert.deepStrictEqual(r.appMenu, [{ menu: null, wins: 0 }]);
});
