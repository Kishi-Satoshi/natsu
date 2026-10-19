/*
 * fake-utility.js — 偽の utilityProcess と MessageChannelMain・速いタイマー（第2a1回 M-2a。M-2b〜M-4 も使う）
 *
 * Electron を読まずに、本物の src/db/server.js を worker_threads の中で動かし、Electron 44 の形に包む。
 *   fakeFork({ crashAfterRequests, exitOnStart, preload }) → fork(modulePath, args, options) → 子
 *     子: on('message', (msg) …)（Electron の UtilityProcess と同じく、中身をそのまま渡す）・on('exit', (code) …)・on('spawn')、
 *         postMessage(msg, [MessagePortMain])・kill()・pid
 *     kill() は worker.terminate() で、'exit' を番号 0 で出す（Electron 44 の kill() と同じ: 計画の調べた結果の 11）。
 *     worker の中では process.parentPort に偽物（on('message', ({ data, ports }) …)・postMessage）を置いてから modulePath を読む
 *     （server.js の最後の行「process.parentPort があれば startServer」がそのまま動く）。
 *     crashAfterRequests: n … 最初に起こした子だけ、口の上の n 個目の頼みを本体が済ませた後、その返事を送る代わりに番号 1 で落ちる
 *                            （書けた後・返事の前に落ちる。起こし直した子は落ちない）
 *     exitOnStart: code    … 起こすたびに、何も読まずにすぐ番号 code で落ちる
 *     preload: path        … 子の中で modulePath より先に読むファイル（M-2b の --db-down: node:sqlite が trigram の表を作れないようにする
 *                            test/helpers/no-trigram.js）
 *     fork.starts() … 起こした回数。fork.calls() … 起こしたときの [modulePath, args, options] の並び
 *     fork.crash(code = 1) … 今生きている最後の子を、思わず落ちたことにする（worker.terminate() で止め、'exit' を番号 code で出す。
 *                            生きている子が無ければ false）。M-2b の場面が、用意の前や後に DB の子を落とすのに使う
 *     fork.dispose() … 起こした子を全部止める（テストの後片付け。テストが途中で止まっても worker が残ってプロセスを終わらせない、を防ぐ）。
 *                      後から起こされた子も、すぐ止めて事象のループを掴まない
 *   FakeChannel … new FakeChannel() → { port1, port2 }（MessagePortMain の形: on('message', ({ data, ports }) …)・on('close')・
 *                 postMessage・start・close。start() を呼ぶまで届いたものは溜めておく（Electron と同じ））
 *   fastTimers() → { setTimeout, clearTimeout, now(), pending(), history(), runAll({ idleMs }) }
 *     setTimeout を覚えるだけで本物の時間を待たない偽物。runAll() は、本物の時間で idleMs（既定 400ms）何も起きなくなるまで、
 *     いちばん早いものから時刻を進めて呼ぶ（子が落ちる・起きるのは本物の時間で起きるので、その合間を待つ）。
 *     pending() は呼ぶ前のものの待ち（ms）の並び、history() は覚えたもの全部の待ち（ms）の並び。
 */
'use strict';

const { Worker, MessageChannel, isMainThread, workerData, parentPort: workerPort } = require('node:worker_threads');
const { EventEmitter } = require('node:events');

const RAW = Symbol('raw-port');

// worker_threads の MessagePort を、Electron の MessagePortMain の形に包む
function electronPort(raw, hooks = {}) {
  const ee = new EventEmitter();
  const held = [];
  let started = false;
  raw.on('message', (data) => {
    if (hooks.onIncoming) hooks.onIncoming(data);
    if (started) ee.emit('message', { data, ports: [] });
    else held.push(data);
  });
  raw.on('close', () => ee.emit('close'));
  const port = {
    [RAW]: raw,
    on(ev, fn) { ee.on(ev, fn); return port; },
    once(ev, fn) { ee.once(ev, fn); return port; },
    off(ev, fn) { ee.off(ev, fn); return port; },
    postMessage(m) {
      if (hooks.beforePost && hooks.beforePost(m) === false) return;
      raw.postMessage(m);
    },
    start() {
      if (started) return;
      started = true;
      for (const data of held.splice(0)) ee.emit('message', { data, ports: [] });
    },
    close() { raw.close(); },
  };
  return port;
}

class FakeChannel {
  constructor() {
    const ch = new MessageChannel();
    this.port1 = electronPort(ch.port1);
    this.port2 = electronPort(ch.port2);
  }
}

function fakeFork({ crashAfterRequests = 0, exitOnStart = 0, preload = '' } = {}) {
  let starts = 0;
  const calls = [];
  const live = [];   // 生きている子の { worker, child, crash(code) }
  let disposed = false;
  const fork = (modulePath, args = [], options = {}) => {
    starts += 1;
    calls.push([modulePath, args, options]);
    const crashAfter = starts === 1 ? crashAfterRequests : 0;
    const worker = new Worker(__filename, { workerData: { fakeUtility: true, modulePath, crashAfter, exitOnStart, preload } });
    const child = new EventEmitter();
    let killed = false;
    let exited = false;
    let crashCode = null;   // fork.crash で落としたときの番号
    const rec = { worker, child, crash(code) { if (exited) return false; crashCode = code; worker.terminate(); return true; } };
    live.push(rec);
    if (disposed) { worker.unref(); worker.terminate(); }
    child.pid = 40000 + starts;
    child.postMessage = (msg, transfer = []) => {
      if (exited) return;
      const ports = transfer.map((p) => p[RAW]);
      worker.postMessage({ data: msg, ports }, ports);
    };
    child.kill = () => {
      if (exited) return false;
      killed = true;
      worker.terminate();
      return true;
    };
    worker.on('online', () => child.emit('spawn'));
    worker.on('message', (m) => child.emit('message', m));
    worker.on('error', () => { /* 子の中の投げ: 番号 1 で終わる（exit で知らせる） */ });
    worker.on('exit', (code) => {
      exited = true;
      const i = live.indexOf(rec);
      if (i >= 0) live.splice(i, 1);
      child.emit('exit', killed ? 0 : (crashCode !== null ? crashCode : code));
    });
    return child;
  };
  fork.starts = () => starts;
  fork.calls = () => calls.slice();
  fork.crash = (code = 1) => (live.length ? live[live.length - 1].crash(code) : false);
  fork.dispose = () => {
    disposed = true;
    for (const r of live.slice()) { r.worker.unref(); r.worker.terminate(); }
  };
  return fork;
}

function fastTimers() {
  let clock = Date.now();
  let seq = 0;
  const queue = new Map();   // handle → { at, ms, fn, n }
  const seen = [];
  let activity = 0;
  const api = {
    setTimeout(fn, ms = 0) {
      seq += 1;
      const h = { fake: seq };
      queue.set(h, { at: clock + Math.max(0, Number(ms) || 0), ms: Number(ms) || 0, fn, n: seq });
      seen.push(Number(ms) || 0);
      activity += 1;
      return h;
    },
    clearTimeout(h) { if (queue.delete(h)) activity += 1; },
    now: () => clock,
    pending: () => [...queue.values()].sort((a, b) => a.at - b.at || a.n - b.n).map((t) => t.ms),
    history: () => seen.slice(),
    async runAll({ idleMs = 400, maxSteps = 1000 } = {}) {
      for (let step = 0; step < maxSteps; step++) {
        if (queue.size === 0) {
          // 本物の時間で何か起きる（子が落ちて次の待ちが入る）かを idleMs まで見る
          const before = activity;
          const end = Date.now() + idleMs;
          while (queue.size === 0 && activity === before && Date.now() < end) await new Promise((res) => setTimeout(res, 10));
          if (queue.size === 0) return;
          continue;
        }
        const [h, t] = [...queue.entries()].sort((a, b) => a[1].at - b[1].at || a[1].n - b[1].n)[0];
        queue.delete(h);
        clock = Math.max(clock, t.at);
        t.fn();
        await new Promise((res) => setImmediate(res));
      }
      throw new Error('fastTimers.runAll: 終わらない');
    },
  };
  return api;
}

module.exports = { fakeFork, FakeChannel, fastTimers };

// ---------------------------------------------------------------- worker の中（偽の utilityProcess の子）
if (!isMainThread && workerData && workerData.fakeUtility) {
  if (workerData.exitOnStart) process.exit(workerData.exitOnStart);
  let requests = 0;
  let dieOn = null;   // この id の返事を送る代わりに落ちる
  const hooks = workerData.crashAfter > 0 ? {
    onIncoming(data) {
      if (data && typeof data.id === 'number') {
        requests += 1;
        if (requests === workerData.crashAfter) dieOn = data.id;
      }
    },
    beforePost(m) {
      if (dieOn !== null && m && m.id === dieOn) process.exit(1);
      return true;
    },
  } : {};
  const listeners = [];
  process.parentPort = {
    on(ev, fn) { if (ev === 'message') listeners.push(fn); return this; },
    once(ev, fn) { return this.on(ev, fn); },
    postMessage(m) { workerPort.postMessage(m); },
  };
  workerPort.on('message', (m) => {
    const ports = (m.ports || []).map((raw) => electronPort(raw, hooks));
    for (const fn of listeners) fn({ data: m.data, ports });
  });
  if (workerData.preload) require(workerData.preload);
  require(workerData.modulePath);
}
