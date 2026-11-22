/*
 * stage180.win.test.js — 0.18.0（計画 docs/plans/2026-11-18-180.md）の Windows だけのテスト（CW-2・前提 P6・F230・F231）
 * Windows でないときは、ファイルの頭で抜ける（test.skip にしない。ci.yml は飛ばしたテストを Linux で 0 件しか許さない）。
 * CI の test (windows-latest) は npm test（Node）で、electron-smoke は同じテストを Electron の Node（ELECTRON_RUN_AS_NODE=1）でも回す。
 *
 * 本物の DB の口（src/db/server.js。このプロセスの中で、偽の parentPort）が本物の名前付きパイプ \\.\pipe\natsu-… を開き、別のプロセス
 * （process.execPath。Electron の Node で回すときは ELECTRON_RUN_AS_NODE=1 の electron.exe。Claude デスクトップが MCP のプロセスを起こすのと同じ形）が
 * 扉の紙を読んで net.connect({ path }) でつなぎ、握手して頼む。違う合い言葉は答えずに切られる。
 * 子に渡すパスは環境変数で渡す（日本語と 𠮷 を引数の引用に通さない）。
 */
'use strict';
if (process.platform !== 'win32') return;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const { spawn } = require('node:child_process');
const { tmpData, electronShape } = require('./helpers/dbtmp');   // 一時フォルダの名前に日本語と 𠮷 が入る
const core = require('../src/db/core');
const D = require('../src/db/door');
const { startServer } = require('../src/db/server');

core.registerForTest({
  'mcp.c180win': { roles: ['mcp'], write: true, args: { id: 'id', title: 'title' }, run: (db, a, ctx) => core.COMMANDS['page.setTitle'].run(db, { id: a.id, title: a.title }, ctx) },   // D77: 題名を書く試しの命令
});

// 子: 扉の紙を読み、つないで握手（NATSU_BAD なら違う合い言葉）し、1つ頼んで、答えの行か「CLOSED」を書いて終わる。文字列の引用は ' だけ
const CHILD = [
  "const fs = require('node:fs'); const net = require('node:net');",
  "const say = (x) => fs.writeSync(1, x + '\\n');",
  "const m = /^pipe ([^\\n]+)\\ntoken ([0-9a-f]{64})\\npid ([0-9]+)\\n$/.exec(fs.readFileSync(process.env.NATSU_DOOR, 'utf8'));",
  "if (!m) { say('NOPAPER'); process.exit(0); }",
  "say('PIPE ' + m[1]);",
  "const token = process.env.NATSU_BAD === '1' ? 'b'.repeat(64) : m[2];",
  "const s = net.connect({ path: m[1] }); let buf = ''; let done = false;",
  "const end = (x) => { if (done) return; done = true; say(x); s.destroy(); process.exit(0); };",
  "s.setEncoding('utf8');",
  "s.on('connect', () => { s.write(JSON.stringify({ hello: token, v: 1 }) + '\\n'); s.write(JSON.stringify({ id: 1, cmd: 'mcp.c180win', args: { id: process.env.NATSU_ID, title: process.env.NATSU_TITLE }, tx: 'c:c180-win-' + process.pid }) + '\\n'); });",
  "s.on('data', (c) => { buf += c; const i = buf.indexOf('\\n'); if (i >= 0) end('R ' + buf.slice(0, i)); });",
  "s.on('error', (e) => end('ERR ' + (e.code || '')));",
  "s.on('close', () => end('CLOSED'));",
  "setTimeout(() => end('TIMEOUT'), 15000);",
].join('\n');

function child(env) {
  const e = { ...process.env, ...env };
  if (process.versions.electron) e.ELECTRON_RUN_AS_NODE = '1';
  const p = spawn(process.execPath, ['-e', CHILD], { env: e, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = ''; let err = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => { out += c; });
  p.stderr.on('data', (c) => { err += c; });
  return new Promise((resolve) => p.on('exit', (code) => resolve({ code, lines: out.split(/\r?\n/).filter(Boolean), err })));
}
async function waitFor(pred, what, ms = 20000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`待ちきれない: ${what}`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

test('CW-2・P6・F230・F231（Windows）: 本物の DB の口が \\\\.\\pipe\\natsu-… を開き、別のプロセス（ELECTRON_RUN_AS_NODE=1 の客と同じ形）が握手して書ける（役 mcp・actor claude）。違う合い言葉は答えずに切られる。閉じると紙が消える', { timeout: 60000 }, async () => {
  const d = tmpData({ pages: 1 });
  d.close();
  const fromServer = [];
  const parent = electronShape.parent((x) => fromServer.push(x));
  startServer({ parentPort: parent, sqlite, runCheck: async () => 'ok' });
  parent.emit({ type: 'init', dataDir: d.dataDir, labels: {}, network: false });
  const paper = path.join(d.dataDir, D.DOOR_NAME);
  try {
    await waitFor(() => fromServer.some((x) => x.type === 'ready'), 'ready');
    await waitFor(() => fs.existsSync(paper), '扉の紙');
    const p = D.parseDoor(fs.readFileSync(paper, 'utf8'));
    assert.ok(p && /^\\\\\.\\pipe\\natsu-[0-9a-f]{24}$/.test(p.pipe), `名前付きパイプでない: ${p && p.pipe}`);
    const good = await child({ NATSU_DOOR: paper, NATSU_ID: d.ids[0], NATSU_TITLE: 'パイプから書いた題' });
    assert.strictEqual(good.lines[0], `PIPE ${p.pipe}`, good.err);
    assert.ok(good.lines[1] && good.lines[1].startsWith('R '), `答えが無い: ${good.lines.join(' / ')} ${good.err.slice(0, 300)}`);
    const r = JSON.parse(good.lines[1].slice(2));
    assert.deepStrictEqual([r.id, r.ok, r.changed], [1, true, true], JSON.stringify(r));
    const peek = d.peek();
    assert.deepStrictEqual(peek.db.prepare("select role, actor from oplog where action = 'mcp.c180win'").all().map((x) => [x.role, x.actor]), [['mcp', 'claude']]);
    const bad = await child({ NATSU_DOOR: paper, NATSU_ID: d.ids[0], NATSU_TITLE: '違う合い言葉の題', NATSU_BAD: '1' });
    assert.ok(['CLOSED', 'ERR EPIPE', 'ERR ECONNRESET'].includes(bad.lines[1]), `違う合い言葉を切らない: ${bad.lines.join(' / ')}`);
    assert.strictEqual(peek.db.prepare("select count(*) c from oplog where action = 'mcp.c180win'").get().c, 1, '違う合い言葉で書けた');
  } finally {
    parent.emit({ type: 'close' });
    await waitFor(() => fromServer.some((x) => x.type === 'closed'), 'closed');
    try {
      assert.strictEqual(fs.existsSync(paper), false, '閉じても紙が残った');
    } finally { d.done(); }
  }
});
