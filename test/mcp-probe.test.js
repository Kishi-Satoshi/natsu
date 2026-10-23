/*
 * mcp-probe.test.js — 0.10.0 Task E-1（MR9・F6）: 詰めた NaTsu.exe で MCP の往復を通す煙テストの道具（tools/mcp-probe.js）。
 * Linux の Node（process.execPath）と src/mcp/server.js を渡して5つとも OK。標準出力に文字を混ぜる偽の壊れたサーバーでは 5 が NG。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PROBE = path.join(ROOT, 'tools', 'mcp-probe.js');
const SERVER = path.join(ROOT, 'src', 'mcp', 'server.js');
const NOISY = path.join(__dirname, 'fixtures', 'mcp-probe', 'noisy-server.js');
const T = { timeout: 90000 };
const runProbe = (script) => new Promise((resolve) => {
  execFile(process.execPath, [PROBE, '--exe', process.execPath, '--script', script], { timeout: 80000, maxBuffer: 1 << 22 }, (err, stdout, stderr) => {
    resolve({ code: err ? err.code : 0, lines: String(stdout).split('\n').filter(Boolean), stderr: String(stderr) });
  });
});

test('E-1: mcp-probe は5つ（握手と道具の一覧・一覧と箇所の検索がゴミ箱を出さない・ゴミ箱の会議は not-found・新しい版の往復・閉じて 5 秒以内に終わり標準出力は全部 JSON-RPC）を1行ずつ OK で出し、終了コード 0', T, async () => {
  const r = await runProbe(SERVER);
  const res = r.lines.filter((l) => /^(OK|NG) \d /.test(l));
  assert.deepStrictEqual(res.map((l) => l.slice(0, 4)), ['OK 1', 'OK 2', 'OK 3', 'OK 4', 'OK 5'], `${r.lines.join('\n')}\n${r.stderr}`);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.lines[r.lines.length - 1], '結果: 5 件とも OK');
});

test('E-1・F6: 標準出力に JSON-RPC でない文字を混ぜるサーバーでは 5 が NG で、終了コード 1', T, async () => {
  const r = await runProbe(NOISY);
  const five = r.lines.find((l) => /^(OK|NG) 5 /.test(l));
  assert.ok(five && five.startsWith('NG 5'), r.lines.join('\n'));
  assert.strictEqual(r.code, 1);
});

test('E-1: 使い方の誤り（--exe・--script が無い）は使い方を出して 2。exitCodeOf は5つそろって全部 OK のときだけ 0', { timeout: 10000 }, async () => {
  const P = require('../tools/mcp-probe');
  assert.deepStrictEqual(P.CHECKS.map(([n]) => n), [1, 2, 3, 4, 5]);
  const all = P.CHECKS.map(([n]) => ({ n, ok: true }));
  assert.strictEqual(P.exitCodeOf(all), 0);
  assert.strictEqual(P.exitCodeOf(all.slice(0, 4)), 1);
  assert.strictEqual(P.exitCodeOf(all.map((x) => (x.n === 3 ? { ...x, ok: false } : x))), 1);
  const r = await new Promise((resolve) => execFile(process.execPath, [PROBE], (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr: String(stderr) })));
  assert.strictEqual(r.code, 2);
  assert.match(r.stderr, /使い方/);
  assert.ok(fs.existsSync(NOISY));
});
