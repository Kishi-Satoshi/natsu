/*
 * stage160.main.test.js — 0.16.0「データベース」の main の場面（計画 docs/plans/2026-11-04-160.md の Task DV-2 から）
 * 偽の Electron の上で main.js を本当に動かして確かめる（helpers/mainrun.js）。
 * DV-2（決めたこと 25・F145・SEC2・R64）: URL のセルの値を押すと、画面は 0.14.0 EB-5 の口 app:open-link（koeApp.openLink）へ送る。
 *       main はセルの照らしと別にもう一度照らし、http(s) と mailto: だけを既定のブラウザやメールで開く（javascript:・file: は開かない）。
 * 住所は作った物で、実在の人名・社名は使わない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const sceneRun = (args, timeout = 30000) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const T = { timeout: sceneTimeout(30000) };

test('DV-2・F145（決めたこと 25・SEC2・R64）: URL のセルの値・メールのセルの mailto: は app:open-link で開き、javascript:・file:・data: の値は開かない（記録に住所を書かない）', T, async () => {
  const MAIL = ['someone', 'example.invalid'].join('@');
  const CASES = [
    ['https://example.com/doc/1', true], ['http://example.com/a?b=1', true], [`mailto:${MAIL}`, true],
    ['javascript:alert(1)', false], ['file:///c:/windows/x', false], ['data:text/html,x', false], [`https://example.com/${'a'.repeat(2049)}`, false],
  ];
  const r = await sceneRun(['text', `--mic-feed=${JSON.stringify([['sleep', 100], ...CASES.map((c) => ['ipc-from', 'main', 'app:open-link', c[0]])])}`]);
  assert.deepStrictEqual(r.ipc.map(([, v]) => v), CASES.map((c) => c[1]), '答え（開いたか）');
  assert.deepStrictEqual(r.external, CASES.filter((c) => c[1]).map((c) => c[0]), 'shell.openExternal に渡した住所');
  for (const x of r.engineLog) assert.ok(!/example|javascript|alert|windows|someone/i.test(x), `記録に住所: ${x}`);
});
