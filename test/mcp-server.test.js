/* mcp-server.test.js — 0.10.0 Task S-2（MR1・F4・F6・F17・RF63・RF67・RF76。計画 docs/plans/2026-10-20-100.md）:
 * MCP のサーバーの入口を本物のプロセス（process.execPath）で起こし、標準入出力で話す */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mcpRun, ENTRY } = require('./helpers/mcprun');

const T = { timeout: 10000 };
const ROOT = path.join(__dirname, '..');
const NEW = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': NEW, 'io.modelcontextprotocol/clientCapabilities': {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-mcp-srv-議事録𠮷-'));
const init = (id = 1) => ({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
const call = (id, name, args = {}) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args, _meta: meta } });

// 標準出力の全部の行が JSON-RPC の答え（JSON として読め、jsonrpc が 2.0）
function allJsonRpc(raw) {
  const lines = raw.split('\n');
  assert.strictEqual(lines.pop(), '', '最後の行が改行で終わっていない');
  for (const l of lines) {
    const o = JSON.parse(l);
    assert.strictEqual(o.jsonrpc, '2.0', l.slice(0, 200));
  }
  return lines.length;
}

test('MR1: 握手の版の会話（initialize → initialized → tools/list）が本物のプロセスで通る', T, async () => {
  const dir = tmp();
  const s = mcpRun({ dataDir: dir });
  try {
    s.send(init());
    const r = await s.next();
    assert.strictEqual(r.result.protocolVersion, '2025-11-25');
    assert.strictEqual(r.result.serverInfo.name, 'natsu');
    assert.strictEqual(r.result.serverInfo.version, require('../package.json').version);
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    s.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const list = await s.next();
    assert.strictEqual(list.id, 2);
    assert.ok(Array.isArray(list.result.tools));
    const end = await s.close();
    assert.strictEqual(end.code, 0);
    allJsonRpc(s.raw());
  } finally { s.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MR1: 新しい版の server/discover が通り、標準入力を閉じると 2 秒以内に終了コード 0', T, async () => {
  const dir = tmp();
  const s = mcpRun({ dataDir: dir });
  try {
    s.send({ jsonrpc: '2.0', id: 'd', method: 'server/discover', params: { _meta: meta } });
    const r = await s.next();
    assert.strictEqual(r.result.resultType, 'complete');
    assert.deepStrictEqual(r.result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
    const end = await s.close();
    assert.strictEqual(end.code, 0);
    assert.ok(end.ms < 2000, `終わるまで ${end.ms}ms`);
    assert.match(s.err(), /NaTsu MCP/);
  } finally { s.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('RF67: 道具の偽物が console.log・console.error・process.emitWarning を呼んでも、標準出力の全部の行が JSON-RPC の答え。標準エラーにはその文が出る', T, async () => {
  const s = mcpRun({ script: ENTRY });
  try {
    s.send(call(1, 'say'));
    const r = await s.next();
    assert.strictEqual(r.result.content[0].text, 'say の答え');
    const end = await s.close();
    assert.strictEqual(end.code, 0);
    assert.strictEqual(allJsonRpc(s.raw()), 1);
    for (const w of ['console.log の文', 'console.info の文', 'console.error の文', 'console.dir の文', 'emitWarning の文']) assert.ok(s.err().includes(w), w);
  } finally { s.kill(); }
});

test('1MB を越える1行には -32600 を1回だけ返し、その後の行には今どおり答える。CRLF の行も読める', T, async () => {
  const s = mcpRun({ script: ENTRY });
  try {
    const big = JSON.stringify(call(1, 'echo', { text: 'あ'.repeat(400 * 1024) }));   // 1.2MB（UTF-8）
    s.sendRaw(big.slice(0, 500000));
    s.sendRaw(big.slice(500000));
    s.sendRaw('\n');
    const e = await s.next();
    assert.deepStrictEqual(e, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    s.sendRaw(`${JSON.stringify(call(2, 'echo', { text: 'つぎ' }))}\r\n`);
    const r = await s.next();
    assert.strictEqual(r.id, 2);
    assert.strictEqual(r.result.content[0].text, 'つぎ');
    s.sendRaw('\n\r\n');   // 空の行は飛ばす
    const end = await s.close();
    assert.strictEqual(end.code, 0);
    assert.strictEqual(allJsonRpc(s.raw()), 2);
  } finally { s.kill(); }
});

test('1行を 𠮷 の 4 バイトの途中で2つの塊に分けて書いても、同じ答え（化けない）', T, async () => {
  const s = mcpRun({ script: ENTRY });
  try {
    const buf = Buffer.from(`${JSON.stringify(call(1, 'echo', { text: '吉𠮷の字' }))}\n`, 'utf8');
    const at = buf.indexOf(Buffer.from('𠮷', 'utf8')) + 2;
    s.proc.stdin.write(buf.subarray(0, at));
    await new Promise((resolve) => setTimeout(resolve, 150));
    s.proc.stdin.write(buf.subarray(at));
    const r = await s.next();
    assert.strictEqual(r.result.content[0].text, '吉𠮷の字');
    await s.close();
  } finally { s.kill(); }
});

test('要求を書いた直後に標準入力を閉じても、その答えの行が全部出てから終了コード 0 で終わる（200KB の答え）', T, async () => {
  const s = mcpRun({ script: ENTRY });
  try {
    s.send(call(1, 'big'));
    const end = await s.close();
    assert.strictEqual(end.code, 0);
    assert.strictEqual(allJsonRpc(s.raw()), 1);
    const r = JSON.parse(s.raw().trim());
    assert.strictEqual(r.result.content[0].text.length, 200 * 1024);
  } finally { s.kill(); }
});

test('F4: 作業フォルダを src/mcp にして起こすと、サーバーの作業フォルダはアプリの外', T, async () => {
  const s = mcpRun({ script: ENTRY, cwd: path.join(ROOT, 'src', 'mcp') });
  try {
    s.send(call(1, 'cwd'));
    const r = await s.next();
    const cwd = r.result.content[0].text;
    const rel = path.relative(ROOT, cwd);
    assert.ok(rel.startsWith('..') || path.isAbsolute(rel), `作業フォルダがアプリの中: ${cwd}`);
    assert.strictEqual(path.resolve(cwd), path.resolve(os.homedir()));
    await s.close();
  } finally { s.kill(); }
});

test('F17・RF76: 道具の本体が目印の文字とパスの形の文字を含む Error で投げても、答え（isError の read）にも標準エラーにも目印とパスが無い。標準エラーには道具の名前と符号だけ', T, async () => {
  const s = mcpRun({ script: ENTRY });
  try {
    s.send(call(1, 'boom'));
    const r = await s.next();
    assert.strictEqual(r.result.isError, true);
    assert.strictEqual(r.result.content[0].text, '議事録を今は開けませんでした。少し待ってから、もう一度試してください。');
    await s.close();
    for (const text of [s.raw(), s.err()]) {
      assert.ok(!text.includes('ひみつ'), text.slice(-300));
      assert.ok(!text.includes('合言葉'));
      assert.ok(!text.includes('natsu-議事録'));
      assert.ok(!text.includes(os.tmpdir()));
    }
    assert.match(s.err(), /boom/);
    assert.match(s.err(), /read/);
  } finally { s.kill(); }
});

test('F6: 本物の道具の表の行の記録（標準エラー）は道具の名前・符号・件数・ms だけで、引数の文字を書かない', T, async () => {
  const s = mcpRun({ script: ENTRY });
  try {
    s.send(call(1, 'echo', { text: '検索の語ひみつ' }));
    await s.next();
    await s.close();
    assert.ok(!s.err().includes('検索の語ひみつ'));
    assert.match(s.err(), /echo/);
  } finally { s.kill(); }
});
