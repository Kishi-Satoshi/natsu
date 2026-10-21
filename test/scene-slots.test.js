/*
 * scene-slots.test.js — 場面の枠（test/helpers/scene-slots.js。CI の直し: run 39583796615 の Windows）
 *
 *  - 別々のプロセスが同時に枠を取っても、同時に走るのは枠の数まで（execScene と execSceneSync の両方）
 *  - 枠を返さずに落ちたプロセスの枠と札は、次に待つ者が片付けて取る
 *  - 場面の見張り（opts.timeout）は枠を取ってから数える（待った長さを入れない）。持ち時間を越えた子は今までどおり止める
 *  - 枠が空かなければ、理由の分かる文で投げる（黙って待ち続けない）
 *  - 場面（helpers/mainrun.js）を起こすテストは、みな枠を通す（直に execFile しない）
 * 枠のフォルダは NATSU_SCENE_SLOT_DIR でテストごとに分ける（ふだんのテストの場面の枠と混ぜない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SLOTS_JS = path.join(__dirname, 'helpers', 'scene-slots.js');
const T = { timeout: 30000 };

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-slots-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
// 枠を取るだけの子のプロセス（code は枠を取った後に走る。release() で返す）
function child(env, code) {
  const src = `const s = require(${JSON.stringify(SLOTS_JS)}); const fs = require('fs'); ${code}`;
  return new Promise((resolve) => {
    cp.execFile(process.execPath, ['-e', src], { env: { ...process.env, ...env }, timeout: 25000 }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
}
// 走っていた数の最大（start と end の行の並びから。同じ時刻なら end を先に数える）
function maxRunning(log) {
  const ev = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => { const [k, , t] = l.split(' '); return { k, t: Number(t) }; });
  ev.sort((a, b) => a.t - b.t || (a.k === 'end' ? -1 : 1));
  let n = 0, max = 0;
  for (const e of ev) { n += e.k === 'start' ? 1 : -1; max = Math.max(max, n); }
  return { max, starts: ev.filter((e) => e.k === 'start').length };
}
const deadPid = () => cp.spawnSync(process.execPath, ['-e', '']).pid;

test('別々のプロセスが同時に枠を取っても、同時に走るのは枠の数（2）まで。非同期と同期の取り方を混ぜても同じ', T, async (t) => {
  const dir = tmp(t);
  const log = path.join(dir, 'log.txt');
  const env = { NATSU_SCENE_SLOTS: '2', NATSU_SCENE_SLOT_DIR: path.join(dir, 'slots'), LOG: log };
  const mark = (k) => `fs.appendFileSync(process.env.LOG, '${k} ' + process.pid + ' ' + Date.now() + '\\n');`;
  const hold = `${mark('start')} const until = Date.now() + 300; while (Date.now() < until) {} ${mark('end')}`;
  const asyncOne = `s.acquire().then((release) => { ${hold} release(); });`;
  const syncOne = `const release = s.acquireSync(); ${hold} release();`;
  const rs = await Promise.all([asyncOne, syncOne, asyncOne, syncOne, asyncOne, syncOne].map((c) => child(env, c)));
  for (const r of rs) assert.strictEqual(r.err, null, r.stderr);
  const { max, starts } = maxRunning(log);
  assert.strictEqual(starts, 6);
  assert.ok(max <= 2, `同時に ${max} 個走った`);
  assert.strictEqual(max, 2, '枠が2つあるのに1つずつしか走っていない');
  assert.deepStrictEqual(fs.readdirSync(env.NATSU_SCENE_SLOT_DIR), [], '札か枠が残った');
});

test('枠を返さずに落ちたプロセスの枠と札（持ち主の pid が居ない）は、次に待つ者が片付けて取る', T, async (t) => {
  const dir = tmp(t);
  const slots = path.join(dir, 'slots');
  fs.mkdirSync(slots);
  const pid = deadPid();
  fs.writeFileSync(path.join(slots, 's-0'), JSON.stringify({ pid, ticket: 'q-x' }));
  fs.writeFileSync(path.join(slots, `q-${String(1).padStart(15, '0')}-${pid}-000001`), String(pid));
  const r = await child({ NATSU_SCENE_SLOTS: '1', NATSU_SCENE_SLOT_DIR: slots, NATSU_SCENE_QUEUE_MS: '5000' },
    "s.acquire().then((release) => { console.log('took'); release(); }, (e) => { console.log(e.message); process.exit(1); });");
  assert.strictEqual(r.err, null, r.stdout + r.stderr);
  assert.strictEqual(r.stdout.trim(), 'took');
});

test('場面の見張り（opts.timeout）は枠を取ってから数える。持ち時間を越えた子は今までどおり止め、枠は返す', T, async (t) => {
  const dir = tmp(t);
  const env = { NATSU_SCENE_SLOTS: '1', NATSU_SCENE_SLOT_DIR: path.join(dir, 'slots') };
  // 1つしかない枠を 1.5 秒持ってから返す。その間に待った場面（0.3 秒で終わる・見張り 1 秒）は、待った長さを入れずに通る。
  // 2 つ目（3 秒かかる・見張り 1 秒）は見張りで止まる
  const r = await child(env, `
    const release = s.acquireSync();
    const t0 = Date.now();
    const out = [];
    let left = 2;
    const done = () => { if (--left === 0) { console.log(JSON.stringify(out)); } };
    s.execScene(process.execPath, ['-e', 'setTimeout(() => console.log("ok"), 300)'], { timeout: 1000 }, (err, stdout) => {
      out.push({ k: 'short', err: err ? (err.killed ? 'killed' : err.message) : null, stdout: String(stdout).trim(), waited: Date.now() - t0 }); done();
    });
    s.execScene(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], { timeout: 1000 }, (err) => {
      out.push({ k: 'long', err: err ? (err.killed ? 'killed' : err.message) : null }); done();
    });
    setTimeout(release, 1500);`);
  assert.strictEqual(r.err, null, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  const short = out.find((x) => x.k === 'short');
  const long = out.find((x) => x.k === 'long');
  assert.deepStrictEqual({ err: short.err, stdout: short.stdout }, { err: null, stdout: 'ok' });
  assert.ok(short.waited >= 1500, `枠を待たずに走った（${short.waited}ms）`);
  assert.strictEqual(long.err, 'killed');
  assert.deepStrictEqual(fs.readdirSync(env.NATSU_SCENE_SLOT_DIR), [], '札か枠が残った');
});

test('枠が待つ上限のあいだ空かなければ、理由の分かる文で投げる（execScene はその文で呼び手に返す）', T, async (t) => {
  const dir = tmp(t);
  const slots = path.join(dir, 'slots');
  fs.mkdirSync(slots);
  // 生きているプロセス（このテスト）が持っている枠
  fs.writeFileSync(path.join(slots, 's-0'), JSON.stringify({ pid: process.pid, ticket: 'q-x' }));
  const r = await child({ NATSU_SCENE_SLOTS: '1', NATSU_SCENE_SLOT_DIR: slots, NATSU_SCENE_QUEUE_MS: '1000' },
    "s.execScene(process.execPath, ['-e', ''], {}, (err) => { console.log(err ? err.message : 'ran'); });");
  assert.strictEqual(r.err, null, r.stderr);
  assert.match(r.stdout, /^場面の枠（1 個）が 1 秒のあいだ空かない/);
  assert.deepStrictEqual(fs.readdirSync(slots), ['s-0'], '待っていた札が残った');
});

test('場面（helpers/mainrun.js）を起こすテストは、みな枠（scene-slots の execScene・execSceneSync）を通す。直に execFile・spawn しない', () => {
  const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.js'));
  const users = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
    if (!/helpers', 'mainrun\.js'|helpers\/mainrun\.js'/.test(src) || !/\[RUN\b/.test(src)) continue;
    users.push(f);
    assert.ok(!/\b(execFile|execFileSync|spawn|spawnSync|fork)\(process\.execPath, \[RUN\b/.test(src), `${f} が場面を枠を通さずに起こしている`);
    assert.match(src, /require\('\.\/helpers\/scene-slots'\)/, `${f} が枠を読んでいない`);
  }
  assert.ok(users.length >= 15, `場面を起こすテストが ${users.length} しか見つからない（探し方が外れている）`);
});

test('場面の見張りの長さ: sceneTimeout は場面の持ち時間に枠を待つ上限を足す。枠の数は CPU の数 - 1（2 より少なくしない）が既定', () => {
  const r = cp.spawnSync(process.execPath, ['-e', `const s = require(${JSON.stringify(SLOTS_JS)}); console.log(JSON.stringify({ slots: s.SLOTS, q: s.QUEUE_MS, t: s.sceneTimeout(20000) }));`],
    { env: { ...process.env, NATSU_SCENE_SLOTS: '', NATSU_SCENE_QUEUE_MS: '' }, encoding: 'utf8' });
  const o = JSON.parse(r.stdout);
  const cpus = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  assert.deepStrictEqual(o, { slots: Math.max(2, cpus - 1), q: 180000, t: 200000 });
});
