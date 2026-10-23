/*
 * mcprun.js — MCP のサーバーを本物のプロセスで起こして1行ずつ話す台（0.10.0 S-2。計画 docs/plans/2026-10-20-100.md）
 *
 *   mcpRun({ script, dataDir, cwd, env }) → { proc, send(obj), sendRaw(text), next(), raw(), err(), close(), kill() }
 *     process.execPath で script（既定は src/mcp/server.js）を起こす。env は今の環境に ELECTRON_RUN_AS_NODE=1・NATSU_DATA_DIR を足したもの
 *     （Windows では SystemRoot などが要るので、今の環境を消さない。ELECTRON_RUN_AS_NODE は Node では何もしない）。
 *     send(obj) は JSON を1行で書く。sendRaw(text) は文字をそのまま書く（塊を分けて書くときに使う）。
 *     next() は標準出力の次の1行を JSON で返す（5 秒で来なければ投げる）。raw() は標準出力の全部・err() は標準エラーの全部。
 *     close() は標準入力を閉じて終わりを待ち { code, signal, ms } を返す（5 秒で終わらなければ殺して投げる）。
 */
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const SERVER = path.join(__dirname, '..', '..', 'src', 'mcp', 'server.js');
const ENTRY = path.join(__dirname, 'mcp-entry.js');

function mcpRun({ script = SERVER, dataDir, cwd, env = {} } = {}) {
  const proc = spawn(process.execPath, [script], {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(dataDir ? { NATSU_DATA_DIR: dataDir } : {}), ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let seen = 0;   // next() が返した行の数
  const waiters = [];
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  const wake = () => { while (waiters.length) waiters.shift()(); };
  proc.stdout.on('data', (s) => { out += s; wake(); });
  proc.stderr.on('data', (s) => { err += s; });
  let exited = null;
  const exitP = new Promise((resolve) => proc.on('exit', (code, signal) => { exited = { code, signal }; wake(); resolve(exited); }));
  const lines = () => out.split('\n').slice(0, -1);
  async function next(ms = 5000) {
    const until = Date.now() + ms;
    for (;;) {
      const all = lines();
      if (all.length > seen) return JSON.parse(all[seen++]);
      if (exited) throw new Error(`サーバーが終わった（${JSON.stringify(exited)}）: ${err.slice(-500)}`);
      const left = until - Date.now();
      if (left <= 0) throw new Error(`標準出力の行が来ない: ${err.slice(-500)}`);
      await new Promise((resolve) => { const t = setTimeout(resolve, left); waiters.push(() => { clearTimeout(t); resolve(); }); });
    }
  }
  return {
    proc,
    send: (obj) => proc.stdin.write(`${JSON.stringify(obj)}\n`),
    sendRaw: (text) => proc.stdin.write(text),
    next,
    raw: () => out,
    err: () => err,
    async close(ms = 5000) {
      const t0 = Date.now();
      proc.stdin.end();
      const timer = new Promise((resolve) => setTimeout(() => resolve(null), ms));
      const r = await Promise.race([exitP, timer]);
      if (!r) { proc.kill('SIGKILL'); throw new Error('標準入力を閉じても終わらない'); }
      return { ...r, ms: Date.now() - t0 };
    },
    kill: () => { try { proc.kill('SIGKILL'); } catch (_) { /* 終わり済み */ } },
  };
}

module.exports = { mcpRun, SERVER, ENTRY };
