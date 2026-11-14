'use strict';
/*
 * realapp.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の画面のテストの台。app.html の <script> を最小 DOM（simrun）で走らせ、DB の命令は一時の DB
 * （helpers/dbtmp）に本当に通す。画面との口は本物の src/preload.js を vm で動かして使う（命令の引数の形・元に戻すの歩みの知らせが本物と同じ）。
 * stage160.app.test.js の realPreload と openDb の形を、作る種を呼び手に任せる形にした。
 *   realApp({ before(call) → made, returns?, seed?(t) }) → l（simrun の log）に { t, db, call, made, copies, done } を足した物
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { load } = require('./simrun.js');
const { tmpDb } = require('./dbtmp');
const core = require('../../src/db/core');

const ROOT = path.join(__dirname, '..', '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
const PRE = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
let clock = Date.parse('2026-11-14T01:00:00.000Z');
const ctx = { now: () => new Date(clock), labels: {} };
let txn = 0;

// 本物の preload を vm で動かし、DB の口（MessagePort）の代わりに core.call へ送る（答えは次の番で返す: 本物と同じく非同期）
function realPreload(db, onStep) {
  const exposed = {}; const on = {}; let uuid = 0;
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async () => ({}), send: () => {} } };
  vm.runInNewContext(PRE, { require: () => electron, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, setTimeout, clearTimeout, console, Promise });
  const port = {
    onmessage: null, addEventListener() {}, start() {}, close() {},
    postMessage(m) {
      const msg = structuredClone(m);
      setImmediate(() => {
        clock += 1000;
        const r = core.call(db, { role: 'app', cmd: msg.cmd, args: msg.args, tx: msg.tx }, ctx);
        port.onmessage({ data: r.ok ? { id: msg.id, ok: true, result: r.result, changed: Boolean(r.changed || r.dupChanged) } : { id: msg.id, ok: false, code: r.code } });
      });
    },
  };
  on['db:port']({ ports: [port] });
  exposed.koeApp.onEditStep(onStep);
  return exposed.koeApp;
}
// preload の呼び口のうち DB へ送るもの（dbCall を呼ぶもの）
const DB_APIS = [...PRE.matchAll(/^ {2}(\w+): \([^)]*\) => dbCall\(/gm)].map((m) => m[1]);

async function realApp({ before = () => ({}), returns: extra = {}, seed } = {}) {
  const t = tmpDb();
  const { db } = t.open();
  if (seed) seed(t);
  const call = (cmd, args, role = 'app') => {
    clock += 1000;
    const r = core.call(db, { role, cmd, args, tx: `${role[0]}:rl170-${String(++txn).padStart(6, '0')}` }, ctx);
    if (!r.ok) throw new Error(`${cmd}: ${r.code}`);
    return r.result;
  };
  const made = before(call) || {};
  let L = null;
  const K = realPreload(db, (s) => { if (L) L.fire('onEditStep', s); });
  const copies = [];
  const returns = { copy: (s) => { copies.push(s); return true; }, linkBase: () => 'https://example.invalid/open#p=', openLink: () => true };
  for (const n of DB_APIS) returns[n] = (...a) => K[n](...a);
  Object.assign(returns, extra);
  const l = await load(APP, { caret: true, returns });
  L = l;
  Object.assign(l, { K, t, db, call, made, copies, done: () => t.done() });
  await l.drain();
  return l;
}

module.exports = { realApp, APP };
