/*
 * stage100.link.main.test.js — 0.10.0 の main のリンク（計画 docs/plans/2026-10-20-100.md の Task LN-3・LN-4。D72・決めたこと 144〜146）
 * LN-3: 起動のたびに、パックした NaTsu は natsu:// を利用者ごとに登録し直す（場所が変わったとき）。引数は -- の後ろにリンク。
 * 場面は helpers/mainrun.js を別のプロセスで回す（Electron の口は偽物。本物の登録は Windows の CI の煙テストだけ）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');
const lib = require('../src/mainlib');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const S = { timeout: sceneTimeout(30000) };
const T = { timeout: 5000 };
const run = (steps, ...flags) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, 'text', `--mcp-steps=${JSON.stringify(steps)}`, ...flags], { env: { ...process.env }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});

test('D72・決めたこと 144: protocolPlan の表（パックしていて登録が違う → 登録・args は [\'--\']／登録が同じ → しない／パックしていない（開発の起動）→ しない）', T, () => {
  assert.deepStrictEqual(lib.protocolPlan({ packaged: true, execPath: 'C:\\P\\NaTsu.exe', isDefault: false }), { register: true, args: ['--'] });
  assert.deepStrictEqual(lib.protocolPlan({ packaged: true, execPath: 'C:\\P\\NaTsu.exe', isDefault: true }), { register: false, args: ['--'] });
  assert.deepStrictEqual(lib.protocolPlan({ packaged: false, execPath: 'C:\\P\\electron.exe', isDefault: false }), { register: false, args: ['--'] });
  for (const bad of [{ packaged: true, execPath: '', isDefault: false }, { packaged: true, execPath: null, isDefault: false }, {}]) assert.strictEqual(lib.protocolPlan(bad).register, false, JSON.stringify(bad));
  assert.strictEqual(lib.PROTOCOL, 'natsu');
});

test('D72・決めたこと 144: パックした形で起動すると、isDefaultProtocolClient を (natsu, execPath, [--]) で聞き、違えば setAsDefaultProtocolClient を同じ引数で1回。同じなら0回。パックしていない形では聞かずに0回', S, async () => {
  const p = await run([], '--packaged');
  assert.deepStrictEqual(p.protocolCalls, [['isDefaultProtocolClient', 'natsu', process.execPath, ['--']], ['setAsDefaultProtocolClient', 'natsu', process.execPath, ['--']]]);
  assert.ok(p.engineLog.includes('リンクの登録: 登録した'), p.engineLog.join('\n'));
  const same = await run([], '--packaged', '--protocol-default');
  assert.deepStrictEqual(same.protocolCalls.map((c) => c[0]), ['isDefaultProtocolClient']);
  const dev = await run([]);
  assert.deepStrictEqual(dev.protocolCalls, []);
  assert.ok(!dev.engineLog.some((l) => l.startsWith('リンクの登録')));
});
