'use strict';
/*
 * scene-slots.js — 場面（helpers/mainrun.js を別のプロセスで回すもの）を、機械全体で同時にいくつまで走らせるかの枠（CI の直し）
 *
 * なぜ: node --test はテストのファイルを CPU の数 - 1 個ずつ並べて回し、ファイルの中でも場面を並べる（stage1a・stage1b・
 * stage090.panel は 4 つずつ、transcribe.e2e は 22 と 13 を一度に）。重なると、4 CPU の機械で場面のプロセスが 20 を越えて
 * 同時に走り（手元で数えた）、ふだん 0.5〜3 秒の場面が、場面ごとの見張り（19〜20 秒）に当たっていた（CI run 39583796615 の Windows）。
 * 見張りが測っていたのは場面の長さではなく、順番を待たされた長さだった。
 *
 * そこで、場面を始める前に機械全体の枠（既定は CPU の数 - 1。2 より少なくしない）を1つ取り、場面が終わったら返す。
 * 枠はファイル（os.tmpdir() の下の natsu-scene-slots）で、別のテストのファイル（別のプロセス）とも、変異確認の写しとも分け合う。
 * 待つ順は来た順（札の名前に時刻を入れて並べる）。
 *  - execScene(file, args, opts, cb) … child_process.execFile と同じ形。枠を取ってから起こす。opts.timeout は起こしてからの長さ
 *                                       （場面そのものの持ち時間。待った長さを入れない）
 *  - execSceneSync(file, args, opts) … child_process.execFileSync と同じ形（枠を待つ間は Atomics.wait で眠る）
 *  - sceneTimeout(ms)               … テスト（node:test）の見張り。場面の持ち時間 ms に、枠を待つ上限 QUEUE_MS を足した長さ
 *  - acquire() / acquireSync()      … 枠を取る。返り値の関数で返す（テストの台・この枠のテストが使う）
 * 枠を返さずに落ちたプロセスの札と枠は、持ち主の pid が居なければ（または STALE_MS より古ければ）次に待つ者が片付ける。
 * 枠が QUEUE_MS のあいだ空かなければ、理由の分かる文で投げる（黙って待ち続けない）。
 * 環境変数: NATSU_SCENE_SLOTS（枠の数）・NATSU_SCENE_QUEUE_MS（待つ上限）・NATSU_SCENE_SLOT_DIR（枠のフォルダ。テスト用）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const cpuCount = () => (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
const SLOTS = Math.max(1, Math.floor(Number(process.env.NATSU_SCENE_SLOTS)) || Math.max(2, cpuCount() - 1));
const QUEUE_MS = Math.max(1000, Number(process.env.NATSU_SCENE_QUEUE_MS) || 180000);
const STALE_MS = 15 * 60 * 1000;
const POLL_MS = 40;
const dirOf = () => process.env.NATSU_SCENE_SLOT_DIR || path.join(os.tmpdir(), 'natsu-scene-slots');

let seq = 0;
const held = new Map();   // 枠のファイル → 札（このプロセスが持っている枠。終わるときに返す）
process.on('exit', () => { for (const f of held.keys()) { try { fs.unlinkSync(f); } catch (_) { /* noop */ } } });

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
const pidOfTicket = (name) => Number(name.split('-')[2]);
function pidOfSlot(file) {
  try { return Number(JSON.parse(fs.readFileSync(file, 'utf8')).pid); } catch (_) { return NaN; }
}
const unlinkQuiet = (f) => { try { fs.unlinkSync(f); } catch (_) { /* noop: 別の者が先に片付けた */ } };
const ageOf = (file) => { try { return Date.now() - fs.statSync(file).mtimeMs; } catch (_) { return 0; } };

// 1回見て、取れれば枠のファイルを返す（取れなければ null）。持ち主の居ない札と枠はここで片付ける
function tryTake(dir, ticket) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { names = []; }
  const queue = [];
  let busy = 0;
  for (const n of names) {
    const f = path.join(dir, n);
    if (n.startsWith('q-')) {
      if (n !== ticket && (!alive(pidOfTicket(n)) || ageOf(f) > STALE_MS)) { unlinkQuiet(f); continue; }
      queue.push(n);
    } else if (n.startsWith('s-')) {
      if (!held.has(f)) {
        // 書きかけ（作った直後で pid がまだ読めない）の枠は、5 秒までは使っていると見る
        const pid = pidOfSlot(f);
        const age = ageOf(f);
        if (age > STALE_MS || (Number.isNaN(pid) ? age > 5000 : !alive(pid))) { unlinkQuiet(f); continue; }
      }
      busy++;
    }
  }
  if (!queue.includes(ticket)) {
    // 自分の札を誰かが消した（古いと見た）: 置き直す
    try { fs.writeFileSync(path.join(dir, ticket), String(process.pid), { flag: 'wx' }); } catch (_) { /* noop */ }
    queue.push(ticket);
  }
  queue.sort();
  const rank = queue.indexOf(ticket);
  if (rank >= SLOTS - busy) return null;
  for (let i = 0; i < SLOTS; i++) {
    const f = path.join(dir, `s-${i}`);
    try {
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid, ticket }), { flag: 'wx' });
      held.set(f, ticket);
      unlinkQuiet(path.join(dir, ticket));
      return f;
    } catch (_) { /* 埋まっている: 次の番号 */ }
  }
  return null;
}

function newTicket(dir) {
  fs.mkdirSync(dir, { recursive: true });
  seq += 1;
  const name = `q-${String(Date.now()).padStart(15, '0')}-${process.pid}-${String(seq).padStart(6, '0')}`;
  fs.writeFileSync(path.join(dir, name), String(process.pid), { flag: 'wx' });
  return name;
}
const releaser = (f) => () => { if (held.delete(f)) unlinkQuiet(f); };
const queueError = () => new Error(`場面の枠（${SLOTS} 個）が ${Math.round(QUEUE_MS / 1000)} 秒のあいだ空かない（${dirOf()}）。枠を返さずに止まっている場面がある`);

async function acquire() {
  const dir = dirOf();
  const ticket = newTicket(dir);
  const until = Date.now() + QUEUE_MS;
  for (;;) {
    const f = tryTake(dir, ticket);
    if (f) return releaser(f);
    if (Date.now() > until) { unlinkQuiet(path.join(dir, ticket)); throw queueError(); }
    await new Promise((r) => { setTimeout(r, POLL_MS + Math.floor(Math.random() * POLL_MS)); });
  }
}

const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
function acquireSync() {
  const dir = dirOf();
  const ticket = newTicket(dir);
  const until = Date.now() + QUEUE_MS;
  for (;;) {
    const f = tryTake(dir, ticket);
    if (f) return releaser(f);
    if (Date.now() > until) { unlinkQuiet(path.join(dir, ticket)); throw queueError(); }
    sleepSync(POLL_MS + Math.floor(Math.random() * POLL_MS));
  }
}

// child_process.execFile と同じ形。枠を取ってから起こし、子が終わったら返す。opts.timeout は起こしてからの長さ
function execScene(file, args, opts, cb) {
  acquire().then((release) => {
    let done = false;
    const finish = (err, stdout, stderr) => { if (done) return; done = true; release(); cb(err, stdout, stderr); };
    try {
      cp.execFile(file, args, opts, finish);
    } catch (e) { finish(e, '', ''); }
  }, (e) => cb(e, '', ''));
}

// child_process.execFileSync と同じ形
function execSceneSync(file, args, opts) {
  const release = acquireSync();
  try { return cp.execFileSync(file, args, opts); } finally { release(); }
}

const sceneTimeout = (ms) => ms + QUEUE_MS;

module.exports = { SLOTS, QUEUE_MS, execScene, execSceneSync, sceneTimeout, acquire, acquireSync };
