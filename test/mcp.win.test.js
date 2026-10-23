/*
 * mcp.win.test.js — 0.10.0 Task E-1（F3・F4。RF62・RF63）: Windows で、MCP のサーバーが動いている間に DB と src の名前の変更を止めないこと。
 * Windows だけ（ほかの OS では名前の変更が開いたファイルに止められないので、確かめにならない）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mcpDb } = require('./helpers/mcpdb');
const { mcpRun } = require('./helpers/mcprun');

const ROOT = path.join(__dirname, '..');
const T = { timeout: 30000 };
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: meta } });

if (process.platform !== 'win32') {
  test('mcp.win: Windows だけ（このOSでは確かめない）', () => {});
  return;
}

test('F3: サーバーが道具に1回答えて待っている間に、natsu.db の名前を変えて戻せる（読むたびに開いて閉じる）', T, async () => {
  const m = mcpDb({ only: ['plain1'] });
  const s = mcpRun({ dataDir: m.dataDir });
  try {
    s.send(call(1, 'list_meetings'));
    const r = await s.next();
    assert.strictEqual(r.result.isError, false);
    const moved = `${m.file}.moved`;
    fs.renameSync(m.file, moved);
    fs.renameSync(moved, m.file);
    s.send(call(2, 'list_meetings'));
    assert.strictEqual((await s.next()).result.isError, false);
  } finally { await s.close().catch(() => s.kill()); m.done(); }
});

test('F4: src を一時フォルダに写し、作業フォルダを写した src\\mcp にして起こしたサーバーが待っている間に、写した src の名前を src.backup-1 に変えられる（自動更新の名前の変え方）', T, async () => {
  const m = mcpDb({ only: ['plain1'] });
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-mcp-app-議事録𠮷-'));
  try {
    fs.cpSync(path.join(ROOT, 'src'), path.join(app, 'src'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(app, 'package.json'));
    const s = mcpRun({ script: path.join(app, 'src', 'mcp', 'server.js'), dataDir: m.dataDir, cwd: path.join(app, 'src', 'mcp') });
    try {
      s.send(call(1, 'list_meetings'));
      assert.strictEqual((await s.next()).result.isError, false);
      fs.renameSync(path.join(app, 'src'), path.join(app, 'src.backup-1'));
      s.send(call(2, 'get_meeting', { id: 'pm1' }));
      assert.strictEqual((await s.next()).result.isError, false, '名前を変えた後に読めない（後から require した）');
    } finally { await s.close().catch(() => s.kill()); }
  } finally { fs.rmSync(app, { recursive: true, force: true }); m.done(); }
});
