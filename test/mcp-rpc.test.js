/* mcp-rpc.test.js — 0.10.0 Task S-1（MR2・F6・RF65。計画 docs/plans/2026-10-20-100.md）: MCP の会話（2026-07-28 の要求ごとの版と
 * server/discover・前の版の initialize の握手の両方）。1行ずつ handle に渡して、返る行を比べる（入出力に触れない純粋な部品） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const rpc = require('../src/mcp/rpc');

const T = { timeout: 5000 };
const NEW = '2026-07-28';
const meta = (extra = {}) => ({ 'io.modelcontextprotocol/protocolVersion': NEW, 'io.modelcontextprotocol/clientCapabilities': {}, ...extra });
const TOOLS = [{ name: 'list_meetings', title: '議事録の一覧', description: '一覧', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } }];

function session(over = {}) {
  const calls = [];
  const s = rpc.createSession({
    version: '0.10.0',
    tools: TOOLS,
    call: (name, args) => { calls.push([name, args]); return { text: `答え\n2行目 ${name}`, isError: false }; },
    ...over,
  });
  const send = (obj) => {
    const out = s.handle(typeof obj === 'string' ? obj : JSON.stringify(obj));
    assert.ok(Array.isArray(out) && out.length <= 1, '答えは 0 か 1 行');
    for (const line of out) assert.ok(!/[\r\n]/.test(line), `答えの行に改行: ${line}`);
    return out.length ? JSON.parse(out[0]) : null;
  };
  return { s, send, calls };
}
const req = (id, method, params) => (params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params });

test('MR2: 握手の版: initialize（2025-11-25）→ 同じ版・tools の能力・serverInfo・instructions。notifications/initialized には答えない。tools/list・tools/call・ping が resultType なしで答える', T, () => {
  const { send, calls } = session();
  const init = send(req(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'claude', version: '1' } }));
  assert.strictEqual(init.id, 1);
  assert.strictEqual(init.result.protocolVersion, '2025-11-25');
  assert.deepStrictEqual(init.result.capabilities, { tools: {} });
  assert.strictEqual(init.result.serverInfo.name, 'natsu');
  assert.strictEqual(init.result.serverInfo.title, 'NaTsu の議事録');
  assert.strictEqual(init.result.serverInfo.version, '0.10.0');
  assert.strictEqual(init.result.instructions, rpc.INSTRUCTIONS);
  assert.strictEqual(init.result.resultType, undefined);
  assert.strictEqual(send({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = send(req(2, 'tools/list'));
  assert.deepStrictEqual(list.result, { tools: TOOLS });
  const call = send(req(3, 'tools/call', { name: 'list_meetings', arguments: { limit: 5 } }));
  assert.deepStrictEqual(call.result, { content: [{ type: 'text', text: '答え\n2行目 list_meetings' }], isError: false });
  assert.deepStrictEqual(calls, [['list_meetings', { limit: 5 }]]);
  const ping = send(req('p', 'ping'));
  assert.deepStrictEqual(ping, { jsonrpc: '2.0', id: 'p', result: {} });
});

test('MR2: initialize（2025-06-18・2025-03-26）は同じ版、（2024-11-05・1900-01-01）は 2025-11-25', T, () => {
  for (const [asked, want] of [['2025-06-18', '2025-06-18'], ['2025-03-26', '2025-03-26'], ['2024-11-05', '2025-11-25'], ['1900-01-01', '2025-11-25'], [NEW, '2025-11-25']]) {
    const { send } = session();
    const r = send(req(1, 'initialize', { protocolVersion: asked, capabilities: {} }));
    assert.strictEqual(r.result.protocolVersion, want, asked);
  }
});

test('MR2: 新しい版: server/discover（_meta の版 2026-07-28）→ supportedVersions に4つ・resultType complete・_meta の serverInfo', T, () => {
  const { send } = session();
  const r = send(req(7, 'server/discover', { _meta: meta() }));
  assert.deepStrictEqual(r.result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26']);
  assert.strictEqual(r.result.resultType, 'complete');
  assert.deepStrictEqual(r.result.capabilities, { tools: {} });
  assert.strictEqual(r.result.instructions, rpc.INSTRUCTIONS);
  assert.strictEqual(r.result._meta['io.modelcontextprotocol/serverInfo'].name, 'natsu');
  assert.strictEqual(r.result._meta['io.modelcontextprotocol/serverInfo'].version, '0.10.0');
});

test('MR2: 握手なしの tools/list・tools/call（_meta つき）が答える（resultType と serverInfo の _meta）', T, () => {
  const { send } = session();
  const list = send(req(1, 'tools/list', { _meta: meta() }));
  assert.deepStrictEqual(list.result.tools, TOOLS);
  assert.strictEqual(list.result.resultType, 'complete');
  assert.strictEqual(list.result._meta['io.modelcontextprotocol/serverInfo'].name, 'natsu');
  const call = send(req(2, 'tools/call', { name: 'list_meetings', arguments: {}, _meta: meta() }));
  assert.strictEqual(call.result.resultType, 'complete');
  assert.deepStrictEqual(call.result.content, [{ type: 'text', text: '答え\n2行目 list_meetings' }]);
  const ping = send(req(3, 'ping', { _meta: meta() }));
  assert.strictEqual(ping.result.resultType, 'complete');
});

test('MR2: _meta の版 2099-01-01 → -32022 で supported と requested', T, () => {
  const { send } = session();
  for (const method of ['server/discover', 'tools/list', 'tools/call']) {
    const r = send(req(9, method, { name: 'list_meetings', _meta: meta({ 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }) }));
    assert.strictEqual(r.error.code, -32022, method);
    assert.deepStrictEqual(r.error.data, { supported: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'], requested: '2099-01-01' });
    assert.strictEqual(r.id, 9);
  }
});

test('MR2: _meta に clientCapabilities が無い → -32602', T, () => {
  const { send, calls } = session();
  for (const method of ['server/discover', 'tools/list', 'tools/call']) {
    const r = send(req(4, method, { name: 'list_meetings', _meta: { 'io.modelcontextprotocol/protocolVersion': NEW } }));
    assert.strictEqual(r.error.code, -32602, method);
  }
  assert.deepStrictEqual(calls, []);
});

test('MR2: _meta も握手も無い tools/list → -32602（server/discover も _meta が要る）', T, () => {
  const { send } = session();
  assert.strictEqual(send(req(1, 'tools/list')).error.code, -32602);
  assert.strictEqual(send(req(2, 'tools/call', { name: 'list_meetings' })).error.code, -32602);
  assert.strictEqual(send(req(3, 'server/discover', {})).error.code, -32602);
  assert.strictEqual(send(req(4, 'ping')).error.code, -32602);
});

test('JSON-RPC: 壊れた JSON → -32700（id null）・配列 → -32600・jsonrpc 1.0 → -32600・id null → -32600・知らない method → -32601・知らない道具 → -32602・arguments が配列 → -32602・call が投げた → -32603（文は Internal error だけ）', T, () => {
  const { send } = session({ call: () => { throw new Error('ひみつの合言葉 C:\\Users\\x\\natsu.db'); } });
  const bad = send('{"jsonrpc": "2.0", "id": 1,');
  assert.deepStrictEqual(bad, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  assert.strictEqual(send([req(1, 'ping')]).error.code, -32600);
  assert.strictEqual(send([req(1, 'ping')]).id, null);
  const v1 = send({ jsonrpc: '1.0', id: 2, method: 'ping' });
  assert.strictEqual(v1.error.code, -32600);
  assert.strictEqual(send({ jsonrpc: '2.0', id: null, method: 'ping' }).error.code, -32600);
  assert.strictEqual(send({ jsonrpc: '2.0', id: 3, method: 7 }).error.code, -32600);
  assert.strictEqual(send({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' }).error.code, -32600);
  assert.strictEqual(send('"ping"').error.code, -32600);
  send(req(10, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }));
  const unknown = send(req(4, 'resources/list'));
  assert.deepStrictEqual(unknown.error, { code: -32601, message: 'Method not found' });
  assert.strictEqual(send(req(5, 'tools/call', { name: 'delete_everything' })).error.code, -32602);
  assert.strictEqual(send(req(6, 'tools/call', { name: 'list_meetings', arguments: [1] })).error.code, -32602);
  assert.strictEqual(send(req(6, 'tools/call', { arguments: {} })).error.code, -32602);
  assert.strictEqual(send(req(6, 'tools/call', [])).error.code, -32602);
  const thrown = send(req(7, 'tools/call', { name: 'list_meetings', arguments: {} }));
  assert.deepStrictEqual(thrown, { jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'Internal error' } });
  assert.ok(!JSON.stringify(thrown).includes('ひみつ'));
});

test('知らせ（id が無い）には答えない。客からの答え（result・error）も読み捨てる', T, () => {
  const { send } = session();
  assert.strictEqual(send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), null);
  assert.strictEqual(send({ jsonrpc: '2.0', method: 'notifications/whatever' }), null);
  assert.strictEqual(send({ jsonrpc: '2.0', id: 3, result: {} }), null);
  assert.strictEqual(send({ jsonrpc: '2.0', id: 4, error: { code: 1, message: 'x' } }), null);
});

test('道具の誤りは isError: true の結果（JSON-RPC の誤りではない）・どの答えの行にも改行が無い', T, () => {
  const { send } = session({ call: () => ({ text: '1行目\n2行目\r\n3行目\u2028', isError: true }) });
  send(req(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} }));
  const r = send(req(2, 'tools/call', { name: 'list_meetings' }));
  assert.strictEqual(r.error, undefined);
  assert.strictEqual(r.result.isError, true);
  assert.strictEqual(r.result.content[0].text, '1行目\n2行目\r\n3行目\u2028');
});

test('D36: serverInfo に icons があり、src が data: で始まる 64×64 の png・外の URL が無い（initialize と server/discover の両方）', T, () => {
  const { send } = session();
  const a = send(req(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} })).result.serverInfo;
  const b = send(req(2, 'server/discover', { _meta: meta() })).result._meta['io.modelcontextprotocol/serverInfo'];
  for (const info of [a, b]) {
    assert.strictEqual(info.icons.length, 1);
    const icon = info.icons[0];
    assert.strictEqual(icon.mimeType, 'image/png');
    assert.deepStrictEqual(icon.sizes, ['64x64']);
    assert.ok(icon.src.startsWith('data:image/png;base64,'));
    const png = Buffer.from(icon.src.slice('data:image/png;base64,'.length), 'base64');
    assert.strictEqual(png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.strictEqual(png.readUInt32BE(16), 64);
    assert.strictEqual(png.readUInt32BE(20), 64);
    assert.ok(!/https?:/.test(JSON.stringify(info)));
  }
});

test('MR2: 要求ごとの _meta の版は握手の有る無しに関わらない（握手の後でも 2099-01-01 は -32022）', T, () => {
  const { send } = session();
  send(req(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }));
  assert.strictEqual(send(req(2, 'tools/list', { _meta: meta({ 'io.modelcontextprotocol/protocolVersion': '2099-01-01' }) })).error.code, -32022);
  assert.strictEqual(send(req(3, 'tools/list')).result.resultType, undefined);
  assert.strictEqual(send(req(4, 'tools/list', { _meta: meta() })).result.resultType, 'complete');
});

test('MAX_LINE_BYTES は 1MB・SUPPORTED と LEGACY の版', T, () => {
  assert.strictEqual(rpc.MAX_LINE_BYTES, 1024 * 1024);
  assert.deepStrictEqual(rpc.SUPPORTED, ['2026-07-28']);
  assert.deepStrictEqual(rpc.LEGACY, ['2025-11-25', '2025-06-18', '2025-03-26']);
});
