'use strict';
// MCP のサーバーの入口（0.10.0 Task S-2。計画 docs/plans/2026-10-20-100.md の「受け渡す名前と形」）。
// Claude デスクトップが NaTsu.exe を ELECTRON_RUN_AS_NODE=1 で起こし、このスクリプトを渡す（場所は変えない約束: 決めたこと 22）。
//  - 口は標準入出力だけ（ポート・名前付きパイプ・ファイルの見張りを作らない: 決めたこと 59）。1行に1つの JSON-RPC。
//  - 標準出力に書くのは send の1か所だけ。console の全部を標準エラーへ回す（RF67）。
//  - 使う部品は頭で全部読む（後から require しない: 自動更新が src を入れ替える間に新旧を混ぜない）。作業フォルダがアプリの中なら
//    ホームへ移る（src の名前を変えられるように: 決めたこと 23）。
//  - 標準入力は setEncoding('utf8') で読む（塊の境の 𠮷 を化けさせない）。EOF では書きかけの答えを出し切ってから終わる（決めたこと 31）。
//  - 標準エラーの記録は、起動の1行と、道具ごとの「名前・符号・件数・ms」だけ（題名・本文・語・ID・パス・例外の文を書かない: 決めたこと 26・64）。
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const sqlite = require('node:sqlite');
const rpc = require('./rpc');
const reader = require('./reader');
const tools = require('./tools');
const format = require('./format');
const passages = require('./passages');
const core = require('../db/core');
const commands = require('../db/commands');
const search = require('../db/search');
const pagerules = require('../pagerules');
const meetingType = require('../meetingType');
const pkg = require('../../package.json');

const APP_ROOT = path.resolve(__dirname, '..', '..');
// 頭で読んだ部品（使う所はそれぞれの部品の中。ここでは後から require しないために読むだけ）
const LOADED = Object.freeze({ format, passages, core, commands, search, pagerules, meetingType });

function errLine(text) {
  try { process.stderr.write(`${text}\n`); } catch (_) { /* 標準エラーが閉じている */ }
}

// console の全部を標準エラーへ（標準出力は MCP のメッセージだけ）
function guardConsole() {
  for (const k of ['log', 'info', 'debug', 'warn', 'error', 'trace']) console[k] = (...a) => errLine(util.format(...a));
  console.dir = (v, o) => errLine(util.inspect(v, o));
}

function send(text) {
  process.stdout.write(`${text}\n`);
}

function leaveAppDir() {
  const rel = path.relative(APP_ROOT, process.cwd());
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    try { process.chdir(os.homedir()); } catch (_) { /* 移れなくても続ける */ }
  }
}

function main({ tools: toolList = tools.TOOLS, call = null } = {}) {
  guardConsole();
  leaveAppDir();
  process.on('uncaughtException', (e) => {
    errLine(`NaTsu MCP: 思わぬ誤りで終わります（${e && e.code ? String(e.code) : e && e.name ? String(e.name) : 'error'}）`);
    process.exit(1);
  });
  const dataDir = reader.dataDirOf(process.env);
  const run = call || ((name, args) => tools.callTool(name, args, { sqlite, dataDir }));
  // 道具を呼ぶ: 投げたら read の道具の誤りにして、記録には名前と符号だけ
  const wrapped = (name, args) => {
    const t0 = Date.now();
    let r;
    try { r = run(name, args); } catch (_) {
      r = { text: tools.ERROR_TEXT.read, isError: true, code: 'read' };
    }
    const code = r && typeof r.code === 'string' && /^[a-z-]{1,20}$/.test(r.code) ? r.code : r && r.isError ? 'error' : 'ok';
    const count = r && Number.isInteger(r.count) && r.count >= 0 ? r.count : 0;
    errLine(`NaTsu MCP: 道具 ${name}: ${code}・${count} 件・${Date.now() - t0}ms`);
    return r;
  };
  const session = rpc.createSession({ version: pkg.version, tools: toolList, call: wrapped });
  errLine(`NaTsu MCP: 起動（NaTsu ${pkg.version}・MCP ${[...rpc.SUPPORTED, ...rpc.LEGACY].join(' / ')}）`);

  let buf = '';
  let dropping = false;   // 1行が大きすぎるので、次の改行まで捨てている
  let ended = false;
  const onLine = (line) => {
    const l = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (!l.trim()) return;
    for (const out of session.handle(l)) send(out);
  };
  const tooBig = () => send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (ended) return;
    let rest = chunk;
    for (;;) {
      const i = rest.indexOf('\n');
      if (i < 0) break;
      const piece = rest.slice(0, i);
      rest = rest.slice(i + 1);
      if (dropping) { dropping = false; buf = ''; continue; }
      const line = buf + piece;
      buf = '';
      if (Buffer.byteLength(line, 'utf8') > rpc.MAX_LINE_BYTES) { tooBig(); continue; }
      onLine(line);
    }
    if (dropping) return;
    buf += rest;
    if (Buffer.byteLength(buf, 'utf8') > rpc.MAX_LINE_BYTES) { tooBig(); dropping = true; buf = ''; }
  });
  process.stdin.on('end', () => {
    ended = true;
    process.exitCode = 0;
    // 書きかけの答えを出し切ってから終わる（process.exit を直ぐ呼ばない）。2 秒の見張りで必ず終わる
    const bye = () => process.exit(0);
    setTimeout(bye, 2000).unref();
    if (process.stdout.writableLength > 0) process.stdout.once('drain', bye);
    else setImmediate(bye);
  });
  return { dataDir, loaded: LOADED };
}

module.exports = { main, dataDirOf: reader.dataDirOf };

if (require.main === module) main();
