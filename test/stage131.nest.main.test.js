/*
 * stage131.nest.main.test.js — 0.13.1「入れ子とトグル」の場面（計画 docs/plans/2026-10-27-131.md の Task NE-3）
 * main の小さな書き戻し（要約待ちの印）で木が壊れないこと（F54・NR3）と、［要約を再生成］で入れ子もトグルも消えること（決めたこと 35）。
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

test('NE-3・F54: 子のある要約で要約待ちの印を書き戻しても子が残る。［要約を再生成］で作り直すと子もトグルも消え、summaryEdited も消える', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--sum', '--claude=ok', '--segs=2', '--nest-after-sum']);
  const n = o.nest;
  assert.ok(n, JSON.stringify(o).slice(0, 400));
  const has = (shape, id) => JSON.stringify(shape).includes(`"${id}"`);
  const lastAt = n.before.findIndex((x) => Array.isArray(x) && x[0] === n.last);
  assert.ok(lastAt >= 0 && has(n.before[lastAt][1], n.kid), `子が足せていない: ${JSON.stringify(n.before)}`);
  assert.ok(n.before.some((x) => Array.isArray(x) && x[0] === n.toggle), JSON.stringify(n.before));
  assert.deepStrictEqual(n.afterWait, n.before, '要約待ちの印の書き戻しで木が変わった（F54）');
  assert.strictEqual(n.editedBefore, true);
  assert.strictEqual(n.resum && n.resum.ok, true, JSON.stringify(n.resum));
  assert.ok(n.afterResum.length > 0);
  assert.ok(n.afterResum.every((x) => typeof x === 'string'), `作り直した要約に子が残った: ${JSON.stringify(n.afterResum)}`);
  assert.ok(!has(n.afterResum, n.kid) && !has(n.afterResum, n.toggle));
  assert.strictEqual(n.toggles, false, 'トグルが残った');
  assert.strictEqual(n.editedAfter, undefined, '作り直した後も印が残った');
});
