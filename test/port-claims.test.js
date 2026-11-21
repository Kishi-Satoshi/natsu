/*
 * port-claims.test.js — 場面が偽のエンジンに渡すポートの選び（test/helpers/port-claims.js。0.17.1 R33: run 44842332022 の mutate-3）
 *
 *  - 別のプロセスが選んで、まだ待ち受けていないポートを、もう一度選ばない（選んでから偽のエンジンが口を開くまでの間に、
 *    別の場面の偽のエンジンがそのポートで先に口を開き、こちらの main がその偽物に要求を送っていた）
 * 印のフォルダは NATSU_PORT_CLAIM_DIR でテストごとに分ける（ふだんのテストの場面の印と混ぜない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const CLAIMS_JS = path.join(__dirname, 'helpers', 'port-claims.js');
const { freePort, PORT_LO, PORT_SPAN } = require(CLAIMS_JS);
const T = { timeout: 30000 };

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-port-claims-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
// 初めの1回は port を指す乱数、後は Math.random
const firstAt = (port) => { let used = false; return () => { if (used) return Math.random(); used = true; return (port - PORT_LO + 0.5) / PORT_SPAN; }; };
// ポートを選んで行に書き、標準入力が閉じるまで生きている子のプロセス（待ち受けはしない: 場面の main が偽のエンジンを起こす前の形）
function holder(env) {
  const src = `require(${JSON.stringify(CLAIMS_JS)}).freePort().then((p) => { process.stdout.write(p + '\\n'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0)); });`;
  const c = cp.spawn(process.execPath, ['-e', src], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const port = new Promise((resolve, reject) => {
    let out = '';
    c.stdout.on('data', (d) => { out += d; if (out.includes('\n')) resolve(Number(out.trim())); });
    c.once('exit', (code) => reject(new Error(`子が先に終わった（${code}）`)));
  });
  const done = new Promise((r) => c.once('exit', r));
  return { port, stop: () => { c.stdin.end(); return done; } };
}

test('R33: 別のプロセスが選んでまだ待ち受けていないポートは、もう一度選ばない（run 44842332022 の mutate-3: 偽のエンジンが口を開く前に、別の場面の偽物が同じポートで答えた）', T, async (t) => {
  const env = { NATSU_PORT_CLAIM_DIR: tmp(t) };
  process.env.NATSU_PORT_CLAIM_DIR = env.NATSU_PORT_CLAIM_DIR;
  t.after(() => { delete process.env.NATSU_PORT_CLAIM_DIR; });
  const h = holder(env);
  try {
    const theirs = await h.port;
    const mine = await freePort({ random: firstAt(theirs) });
    assert.ok(Number.isInteger(mine) && mine >= PORT_LO && mine < PORT_LO + PORT_SPAN, String(mine));
    assert.notStrictEqual(mine, theirs, `別のプロセスが選んだポート ${theirs} をもう一度選んだ`);
  } finally { await h.stop(); }
});

test('R33: 印は持ち主のプロセスが終わると消え、消さずに落ちたプロセスの印は次に選ぶ者が片付けて取る', T, async (t) => {
  const dir = tmp(t);
  const env = { ...process.env, NATSU_PORT_CLAIM_DIR: dir };
  // ふつうに終わった子: 印は残らない
  const ok = cp.execFileSync(process.execPath, ['-e', `require(${JSON.stringify(CLAIMS_JS)}).freePort().then((p) => console.log(p))`], { env }).toString().trim();
  assert.ok(/^\d+$/.test(ok), ok);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  // 印を置いたまま落ちた子（SIGKILL では 'exit' の片付けが走らない）
  const src = `const c = require(${JSON.stringify(CLAIMS_JS)}); c.freePort().then((p) => { require('fs').writeSync(1, p + '\\n'); process.kill(process.pid, 'SIGKILL'); });`;
  const dead = Number(cp.spawnSync(process.execPath, ['-e', src], { env }).stdout.toString().trim());
  assert.deepStrictEqual(fs.readdirSync(dir), [String(dead)]);
  process.env.NATSU_PORT_CLAIM_DIR = dir;
  t.after(() => { delete process.env.NATSU_PORT_CLAIM_DIR; });
  const mine = await freePort({ random: firstAt(dead) });
  assert.strictEqual(mine, dead, '落ちたプロセスの印のポートを取らなかった');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, String(dead)), 'utf8')).pid, process.pid);
});

test('R33: 場面を起こすテストは、みなポートをこの印で選ぶ（mainrun.js の freePort・transcribe.e2e の reservePorts）', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  assert.match(read('helpers/mainrun.js'), /const \{ freePort \} = require\('\.\/port-claims'\);/);
  assert.doesNotMatch(read('helpers/mainrun.js'), /PORT_LO|tryPort/);
  const e2e = read('transcribe.e2e.test.js');
  assert.match(e2e, /require\('\.\/helpers\/port-claims'\)/);
  assert.match(e2e, /if \(s && !claims\.claim\(s\.address\(\)\.port\)\)/);
});
