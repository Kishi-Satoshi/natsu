#!/usr/bin/env node
'use strict';
// mcp-probe.js — 詰めた NaTsu.exe（と node_modules の Electron）で MCP のサーバーを ELECTRON_RUN_AS_NODE=1 で起こし、往復を通す煙テスト
// （0.10.0 Task E-1。MR9・F3・F4・F6・RF65。計画 docs/plans/2026-10-20-100.md）。Claude デスクトップと同じ起こし方（exe に server.js を渡す）。
//
//   node tools/mcp-probe.js --exe <exe> --script <server.js>
//
// 一時フォルダ（日本語と 𠮷 の名前）に種の DB（ふつうの会議1つ pm1 とゴミ箱の会議1つ pt1。test/helpers/mcpdb.js が core と commands の命令だけで作る）を作り、
// NATSU_DATA_DIR で渡す。次の5つを1行ずつ OK／NG で出し、全部 OK なら終了コード 0（使い方の誤りは 2）。全体の見張りは 60 秒。
//   1. 握手の版の initialize → tools/list に6つ
//   2. list_meetings がふつうの会議だけを返し、search_passages で両方の会議にある語を探すと、ふつうの会議の箇所だけが出る（D51）
//   3. get_meeting のゴミ箱の会議の ID が not-found
//   4. 起こし直して、新しい版の server/discover と _meta つきの tools/call
//   5. 標準入力を閉じて 5 秒以内に終わり、標準出力の全部の行が JSON-RPC（どの起動でも）
// 記録（標準エラー）は見ない。一時フォルダは終わりに消す。

const path = require('node:path');
const { spawn } = require('node:child_process');

const CHECKS = [
  [1, '握手の版の initialize → tools/list に6つの道具'],
  [2, 'list_meetings はふつうの会議だけ。search_passages で両方の会議にある語を探すと、ふつうの会議の箇所だけ'],
  [3, 'get_meeting のゴミ箱の会議の ID は not-found'],
  [4, '起こし直して、新しい版の server/discover と _meta つきの tools/call'],
  [5, '標準入力を閉じて 5 秒以内に終わり、標準出力の全部の行が JSON-RPC'],
];
const WATCH_MS = 60000;
const LINE_MS = 10000;
const EXIT_MS = 5000;
const META = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const USAGE = '使い方: node tools/mcp-probe.js --exe <NaTsu.exe か electron.exe> --script <src/mcp/server.js>';

const argOf = (argv, name) => { const i = argv.indexOf(name); return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : ''; };

/** 全部そろって全部 OK のときだけ 0 */
function exitCodeOf(results) {
  return CHECKS.every(([n]) => results.some((r) => r.n === n && r.ok)) ? 0 : 1;
}

// 標準出力の全部の行が JSON-RPC の答え（JSON で読め、jsonrpc が 2.0）
function allJsonRpc(raw) {
  const lines = String(raw).split('\n').filter((l) => l.length > 0);
  return lines.every((l) => { try { return JSON.parse(l).jsonrpc === '2.0'; } catch (_) { return false; } });
}

// サーバーを1つ起こして1行ずつ話す
function start(exe, script, dataDir) {
  const proc = spawn(exe, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NATSU_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let out = '';
  let seen = 0;
  const waiters = [];
  const wake = () => { while (waiters.length) waiters.shift()(); };
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (s) => { out += s; wake(); });
  proc.stderr.on('data', () => {});
  let exited = null;
  proc.on('error', () => { exited = exited || { code: -1 }; wake(); });
  const exitP = new Promise((resolve) => proc.on('exit', (code) => { exited = { code }; wake(); resolve(exited); }));
  const send = (obj) => proc.stdin.write(`${JSON.stringify(obj)}\n`);
  // 次の JSON-RPC の答え（JSON でない行は飛ばす。それは 5 の確かめが数える）
  async function next() {
    const until = Date.now() + LINE_MS;
    for (;;) {
      const lines = out.split('\n').slice(0, -1);
      while (seen < lines.length) {
        const l = lines[seen++];
        try { const j = JSON.parse(l); if (j && j.jsonrpc === '2.0') return j; } catch (_) { /* 次の行 */ }
      }
      if (exited) throw new Error('サーバーが終わった');
      if (Date.now() > until) throw new Error('答えが来ない');
      await new Promise((r) => { waiters.push(r); setTimeout(r, 100); });
    }
  }
  async function close() {
    const t0 = Date.now();
    proc.stdin.end();
    const done = await Promise.race([exitP, new Promise((r) => setTimeout(() => r(null), EXIT_MS))]);
    if (!done) { try { proc.kill(); } catch (_) { /* 終わっている */ } }
    return { ok: Boolean(done), code: done ? done.code : null, ms: Date.now() - t0, raw: out };
  }
  return { send, next, close, kill: () => { try { proc.kill(); } catch (_) { /* 終わっている */ } } };
}

const textOf = (r) => (r && r.result && Array.isArray(r.result.content) && r.result.content[0] && typeof r.result.content[0].text === 'string' ? r.result.content[0].text : '');

async function probe({ exe, script }) {
  const { mcpDb } = require('../test/helpers/mcpdb');
  const m = mcpDb({ only: ['plain1', 'trash'] });
  const results = [];
  const closes = [];
  const push = (n, ok, note) => results.push({ n, ok: Boolean(ok), note });
  try {
    // 握手の版
    const a = start(exe, script, m.dataDir);
    try {
      a.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-probe', version: '1' } } });
      const init = await a.next();
      a.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      a.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const list = await a.next();
      const names = list.result && Array.isArray(list.result.tools) ? list.result.tools.map((t) => t.name) : [];
      push(1, init.result && init.result.protocolVersion === '2025-06-18' && names.length === 6, `版 ${init.result && init.result.protocolVersion}・道具 ${names.join(',')}`);
      a.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_meetings', arguments: {} } });
      const lm = textOf(await a.next());
      a.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search_passages', arguments: { query: '予算案', limit: 20 } } });
      const sp = textOf(await a.next());
      push(2, /ID pm1/.test(lm) && !lm.includes('pt1') && /- 印: pm1#/.test(sp) && !sp.includes('pt1'), `一覧に pm1 ${/ID pm1/.test(lm)}・pt1 ${lm.includes('pt1')}／箇所に pm1 ${/- 印: pm1#/.test(sp)}・pt1 ${sp.includes('pt1')}`);
      a.send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_meeting', arguments: { id: 'pt1' } } });
      const gm = await a.next();
      push(3, gm.result && gm.result.isError === true && /その ID の議事録はありません/.test(textOf(gm)), `isError ${gm.result && gm.result.isError}`);
    } catch (e) {
      for (const n of [1, 2, 3]) if (!results.some((r) => r.n === n)) push(n, false, `止まった: ${e.message}`);
    } finally { closes.push(await a.close()); }
    // 新しい版（起こし直す）
    const b = start(exe, script, m.dataDir);
    try {
      b.send({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: META } });
      const d = await b.next();
      b.send({ jsonrpc: '2.0', id: 'c', method: 'tools/call', params: { name: 'list_meetings', arguments: {}, _meta: META } });
      const c = await b.next();
      const ok = d.result && Array.isArray(d.result.supportedVersions) && d.result.supportedVersions[0] === '2026-07-28' && c.result && c.result.resultType === 'complete' && /ID pm1/.test(textOf(c));
      push(4, ok, `版 ${d.result && d.result.supportedVersions && d.result.supportedVersions.join(',')}・答えの形 ${c.result && c.result.resultType}`);
    } catch (e) {
      push(4, false, `止まった: ${e.message}`);
    } finally { closes.push(await b.close()); }
    const bad = closes.filter((x) => !x.ok || x.code !== 0 || !allJsonRpc(x.raw));
    push(5, bad.length === 0, closes.map((x) => `終了 ${x.code}（${x.ms}ms）・JSON-RPC だけ ${allJsonRpc(x.raw)}`).join('／'));
  } finally {
    m.done();
  }
  return results;
}

async function main(argv) {
  const exe = argOf(argv, '--exe');
  const script = argOf(argv, '--script');
  if (!exe || !script) { console.error(USAGE); return 2; }
  const watch = setTimeout(() => { console.log('NG 時間切れ（60 秒）'); process.exit(1); }, WATCH_MS);
  let results = [];
  try {
    results = await probe({ exe: path.resolve(exe), script: path.resolve(script) });
  } catch (e) {
    console.log(`NG 止まった: ${e && e.message}`);
  }
  clearTimeout(watch);
  for (const [n, what] of CHECKS) {
    const r = results.find((x) => x.n === n);
    console.log(`${r && r.ok ? 'OK' : 'NG'} ${n} ${what}${r && r.note ? `（${r.note}）` : '（結果が無い）'}`);
  }
  const code = exitCodeOf(results);
  console.log(code === 0 ? `結果: ${CHECKS.length} 件とも OK` : '結果: NG');
  return code;
}

module.exports = { CHECKS, exitCodeOf, allJsonRpc, probe };

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
