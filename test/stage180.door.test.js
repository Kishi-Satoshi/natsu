/* stage180.door.test.js — 0.18.0（計画 docs/plans/2026-11-18-180.md）の Claude の書き込みの口（扉）
 *  CW-2（決めたこと 1〜5・8・F230・F231）: DB のプロセスが起動ごとに名前付きパイプ（Linux では一時フォルダのソケットのファイル）と合い言葉を作り、
 *  扉の紙 natsu.door に置く。握手の後の口に役 mcp を付ける。上限・記録・紙の出し入れ。
 *  本物の src/db/server.js をこのプロセスの中で動かし（偽の parentPort）、同じプロセスから net.connect でつなぐ（Windows の CI では本物の名前付きパイプ。
 *  別のプロセス・ELECTRON_RUN_AS_NODE=1 の客は test/stage180.win.test.js）。
 * 会議の題名は titleAt（D77）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const sqlite = require('node:sqlite');
const { MessageChannel } = require('node:worker_threads');
const { tmpData, electronShape } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const D = require('../src/db/door');
const { startServer } = require('../src/db/server');

const T = { timeout: 60000 };
const TOKEN = 'a'.repeat(64);
// 役 mcp の試しの命令（Claude の書く命令は第2部で作る）。mcp.c180w は題名を書く・mcp.c180any は役の表が緩い（app・main も書いた）命令
core.registerForTest({
  'mcp.c180w': { roles: ['mcp'], write: true, args: { id: 'id', title: 'title' }, run:   // D77: 題名を書く試しの命令
    (db, a, ctx) => core.COMMANDS['page.setTitle'].run(db, { id: a.id, title: a.title }, ctx) },
  'mcp.c180any': { roles: ['mcp', 'app', 'main'], write: false, args: {}, run: () => ({ result: 'read' }) },
});

async function waitFor(pred, what, ms = 15000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`待ちきれない: ${what}`);
    await new Promise((res) => setTimeout(res, 10));
  }
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function boot(d, opts = {}) {
  const fromServer = [];
  const parent = electronShape.parent((x) => fromServer.push(x));
  startServer({ parentPort: parent, sqlite, runCheck: async () => 'ok', ...opts });
  parent.emit({ type: 'init', dataDir: d.dataDir, labels: {}, network: false });
  const clients = [];
  const port = (role) => {
    const ch = new MessageChannel();
    parent.emit({ type: 'port', role }, [electronShape.port(ch.port1)]);
    const c = electronShape.client(ch.port2);
    clients.push(c);
    return c;
  };
  const logs = () => fromServer.filter((x) => x.type === 'log').map((x) => x.line);
  const ready = () => waitFor(() => fromServer.some((x) => x.type === 'ready'), 'ready').then(() => fromServer.find((x) => x.type === 'ready'));
  const stop = async () => {
    parent.emit({ type: 'close' });
    await waitFor(() => fromServer.some((x) => x.type === 'closed'), 'closed');
    for (const c of clients.splice(0)) c.close();
  };
  return { port, ready, stop, logs };
}
const paperOf = (d) => path.join(d.dataDir, D.DOOR_NAME);
const readPaper = (d) => { try { return fs.readFileSync(paperOf(d), 'utf8'); } catch (_) { return null; } };
async function doorOf(d) {
  await waitFor(() => readPaper(d) !== null, '扉の紙');
  const p = D.parseDoor(readPaper(d));
  assert.ok(p, `扉の紙の形が違う: ${JSON.stringify(readPaper(d))}`);
  return p;
}
// 扉の客（このプロセスから）: 行を溜め、next() は次の1行か、切れたら 'CLOSED'
function dial(pipe) {
  const sock = net.connect({ path: pipe });
  const lines = []; const waiting = []; let buf = ''; let closed = false;
  const give = (l) => { if (waiting.length) waiting.shift()(l); else lines.push(l); };
  sock.setEncoding('utf8');
  sock.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { give(buf.slice(0, i)); buf = buf.slice(i + 1); } });
  sock.on('error', () => {});
  sock.on('close', () => { closed = true; for (const w of waiting.splice(0)) w('CLOSED'); });
  const opened = new Promise((res) => { sock.on('connect', res); sock.on('close', res); });
  return {
    sock, opened,
    isClosed: () => closed,
    send: (x) => { if (!sock.destroyed) sock.write(typeof x === 'string' ? x : `${JSON.stringify(x)}\n`); },
    next: () => (lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve('CLOSED') : new Promise((res) => waiting.push(res))),
    reply: async (id) => { for (;;) { const l = await (lines.length ? Promise.resolve(lines.shift()) : closed ? Promise.resolve('CLOSED') : new Promise((res) => waiting.push(res))); if (l === 'CLOSED') return l; const m = JSON.parse(l); if (m.id === id) return m; } },
    close: () => sock.destroy(),
  };
}
async function hello(d) {
  const p = await doorOf(d);
  const c = dial(p.pipe);
  await c.opened;
  c.send({ hello: p.token, v: 1 });
  return c;
}
const withinMs = (pr, ms) => Promise.race([pr, sleep(ms).then(() => 'TIMEOUT')]);

// ---------------------------------------------------------------- 紙の出し入れ（F230）
test('CW-2・F230: ready の ok の後に natsu.door が3行の形（pipe・token・pid）で書かれ、close で消える。起動の頭で前の紙が消え、newer・failed では書かれない', T, async () => {
  const d = tmpData({ pages: 1 });
  d.close();
  try {
    fs.writeFileSync(paperOf(d), D.doorText({ pipe: D.pipePath(), token: TOKEN, pid: 1 }));   // 前の起動の紙（落ちた跡）
    let s = boot(d);
    try {
      assert.strictEqual((await s.ready()).state, 'ok');
      const p = await doorOf(d);
      assert.notStrictEqual(p.token, TOKEN, '前の起動の紙のまま');
      assert.strictEqual(p.pid, process.pid);
      assert.match(p.pipe, process.platform === 'win32' ? /^\\\\\.\\pipe\\natsu-[0-9a-f]{24}$/ : /natsu-[0-9a-f]{24}\.sock$/);
      assert.match(p.token, /^[0-9a-f]{64}$/);
      assert.deepStrictEqual(fs.readdirSync(d.dataDir).filter((x) => x.startsWith('natsu.door')), ['natsu.door'], '一時ファイルが残った');
    } finally { await s.stop(); }
    assert.strictEqual(readPaper(d), null, 'close で紙が消えない');
    // 新しい版の DB（newer）: 口を開かず紙も書かない。前の紙は起動の頭で消える
    const raw = new sqlite.DatabaseSync(d.file);
    try { raw.exec('pragma user_version = 3'); } finally { raw.close(); }
    fs.writeFileSync(paperOf(d), D.doorText({ pipe: D.pipePath(), token: TOKEN, pid: 1 }));
    s = boot(d);
    try {
      assert.strictEqual((await s.ready()).state, 'newer');
      await sleep(1000);   // 開いていれば紙は数ミリ秒で書かれる（混んだ CI でも見逃さない間）
      assert.strictEqual(readPaper(d), null, 'newer なのに紙がある（前の紙が消えない・扉を開いた）');
    } finally { await s.stop(); }
  } finally { d.done(); }
});

test('CW-2・F230: 使えない DB（failed: 版を上げる前の控えが取れない）では口を開かず紙も書かない', T, async () => {
  const d = tmpData({ pages: 0 });
  d.close();
  const raw = new sqlite.DatabaseSync(d.file);
  try { raw.exec('drop table if exists page_snapshot'); raw.exec('pragma user_version = 1'); } finally { raw.close(); }
  const noBackup = new Proxy(fs, { get: (t, k) => (k === 'mkdirSync'
    ? (p, ...a) => { if (/[\\/]backup$/.test(String(p))) throw Object.assign(new Error('EACCES: 試し'), { code: 'EACCES' }); return t.mkdirSync(p, ...a); }
    : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
  const s = boot(d, { fs: noBackup });
  try {
    assert.strictEqual((await s.ready()).state, 'failed');
    await sleep(1000);
    assert.strictEqual(readPaper(d), null);
  } finally { await s.stop(); d.done(); }
});

// ---------------------------------------------------------------- 握手と役（F231）
test('CW-2・F231: 違う合い言葉・形の違う握手・握手なしの頼みは、答えずにすぐ切る。2 秒（試しでは短くした helloMs）の無言でも切る', T, async () => {
  const d = tmpData({ pages: 1 });
  d.close();
  let s = boot(d, { door: { limits: { helloMs: 5000 } } });
  try {
    await s.ready();
    const p = await doorOf(d);
    for (const [first, what] of [
      [{ hello: 'b'.repeat(64), v: 1 }, '違う合い言葉'],
      [{ hello: p.token, v: 2 }, '形の違う握手'],
      [{ hello: p.token, v: 1, role: 'app' }, '欄の多い握手'],
      [{ id: 1, cmd: 'mcp.c180any', args: {} }, '握手なしの頼み'],
    ]) {
      const c = dial(p.pipe);
      await c.opened;
      c.send(first);
      c.send({ id: 2, cmd: 'mcp.c180any', args: {} });
      assert.strictEqual(await withinMs(c.next(), 1500), 'CLOSED', `${what}: 切らない・答えた`);
    }
  } finally { await s.stop(); }
  s = boot(d, { door: { limits: { helloMs: 400 } } });
  try {
    await s.ready();
    const quiet = dial((await doorOf(d)).pipe);
    await quiet.opened;
    assert.strictEqual(await withinMs(quiet.next(), 3000), 'CLOSED', '握手の無い無言の口を切らない');
  } finally { await s.stop(); d.done(); }
});

test('CW-2・F231: 合い言葉が合えば頼みに役 mcp が付き actor は claude（頼みの中で role を書いても変わらない・args.actor は bad-args）。書けたら全部の口に changed', T, async () => {
  const d = tmpData({ pages: 1 });
  d.close();
  const s = boot(d);
  try {
    await s.ready();
    const main = s.port('main');
    const seen = []; main.onEvent((e) => seen.push(e));
    const c = await hello(d);
    c.send({ id: 1, cmd: 'mcp.c180w', args: { id: d.ids[0], title: 'Claude が付けた題' }, tx: 'c:c180-000001' });   // 利用者が付け直した題名と同じ扱い（D77）
    const w = await c.reply(1);
    assert.deepStrictEqual([w.ok, w.changed, w.result && w.result.title], [true, true, 'Claude が付けた題']);
    c.send({ id: 2, cmd: 'mcp.c180w', args: { id: d.ids[0], title: '名乗る', actor: 'me' }, tx: 'c:c180-000002' });   // D77
    assert.deepStrictEqual(await c.reply(2), { id: 2, ok: false, code: 'bad-args', retry: false });
    c.send({ id: 3, role: 'app', cmd: 'page.get', args: { id: d.ids[0] } });
    assert.deepStrictEqual(await c.reply(3), { id: 3, ok: false, code: 'forbidden', retry: false }, '頼みの中の role を使った');
    c.send({ id: 4, role: 'main', cmd: 'db.status', args: {} });
    assert.deepStrictEqual(await c.reply(4), { id: 4, ok: false, code: 'forbidden', retry: false });
    c.send('{"id":5,\n');
    assert.deepStrictEqual(JSON.parse(await c.next()), { id: null, ok: false, code: 'bad-args', retry: false });
    c.close();
    await waitFor(() => seen.length > 0, 'changed');
    assert.deepStrictEqual(seen, [{ event: 'changed', pageIds: [d.ids[0]], actor: 'claude' }]);
    const peek = d.peek();
    assert.strictEqual(peek.db.prepare("select actor from oplog where tx = 'c:c180-000001'").get().actor, 'claude');
    assert.strictEqual(peek.db.prepare("select role from oplog where tx = 'c:c180-000001'").get().role, 'mcp');
  } finally { await s.stop(); d.done(); }
});

test('CW-2・F231: 役 mcp が今の命令（page.get・pages.list・page.delete・block.remove・rows.trash・col.remove・db.setLock・meeting.discard・page.claudeRevert）を呼ぶと forbidden。役 app・main が mcp.* を呼ぶと forbidden（役の表が緩くても）', T, async () => {
  const d = tmpData({ pages: 1 });
  d.close();
  const s = boot(d);
  try {
    await s.ready();
    const c = await hello(d);
    const id = d.ids[0];
    const calls = [
      ['page.get', { id }], ['pages.list', {}], ['page.delete', { id }], ['block.remove', { pageId: id, blockId: `${id}b2` }],
      ['rows.trash', { db: id, ids: [id] }], ['col.remove', { db: id, col: 'c1' }], ['db.setLock', { db: id, on: true }],
      ['meeting.discard', { pageId: id }], ['page.claudeRevert', { id, sid: 1 }],
    ];
    let k = 0;
    for (const [cmd, args] of calls) {
      k += 1;
      c.send({ id: k, cmd, args, tx: `c:c180-cmd-${k}` });
      assert.deepStrictEqual(await c.reply(k), { id: k, ok: false, code: 'forbidden', retry: false }, cmd);
    }
    c.send({ id: 99, cmd: 'mcp.c180any', args: {} });
    assert.deepStrictEqual(await c.reply(99), { id: 99, ok: true, result: 'read' });
    for (const role of ['app', 'main']) {
      const r = await s.port(role).ask({ id: 7, cmd: 'mcp.c180any', args: {} });
      assert.deepStrictEqual([r.ok, r.code], [false, 'forbidden'], `${role} が mcp.* を呼べた`);
      const w = await s.port(role).ask({ id: 8, cmd: 'mcp.c180w', args: { id, title: '名乗る' }, tx: `${role[0]}:c180-name-1` });   // D77
      assert.deepStrictEqual([w.ok, w.code], [false, 'forbidden'], `${role} が Claude を名乗った`);
    }
    assert.strictEqual(core.call(d.peek().db, { role: 'app', cmd: 'mcp.c180any', args: {} }, {}).code, 'forbidden');
  } finally { await s.stop(); d.done(); }
});

// ---------------------------------------------------------------- 上限と記録（F231）
test('CW-2・F231: 1MB を越える行は切る・5 つ目の口はすぐ切る（4 つまでは使える）・無言（試しでは短くした idleMs）で切る', T, async () => {
  const d = tmpData({ pages: 1 });
  d.close();
  const s = boot(d, { door: { limits: { idleMs: 4000 } } });
  try {
    await s.ready();
    const big = await hello(d);
    big.send(`{"id":1,"cmd":"mcp.c180any","args":{},"pad":"${'x'.repeat(1024 * 1024 + 10)}`);   // 改行の無い 1MB を越える行
    assert.strictEqual(await withinMs(big.next(), 2000), 'CLOSED', '1MB を越える行を切らない（無言の 4 秒より前に）');
    const four = [];
    for (let i = 0; i < 4; i += 1) four.push(await hello(d));
    for (const [i, c] of four.entries()) {
      c.send({ id: 10 + i, cmd: 'mcp.c180any', args: {} });
      assert.deepStrictEqual(await c.reply(10 + i), { id: 10 + i, ok: true, result: 'read' }, `${i + 1} つ目の口が使えない`);
    }
    const fifth = await hello(d);
    fifth.send({ id: 20, cmd: 'mcp.c180any', args: {} });
    assert.strictEqual(await withinMs(fifth.next(), 2000), 'CLOSED', '5 つ目の口を切らない（無言の 4 秒より前に）');
    for (const c of four) c.close();
    await sleep(100);
    const idle = await hello(d);
    idle.send({ id: 30, cmd: 'mcp.c180any', args: {} });
    assert.deepStrictEqual(await idle.reply(30), { id: 30, ok: true, result: 'read' });
    assert.strictEqual(await withinMs(idle.next(), 10000), 'CLOSED', '無言の口を切らない');
  } finally { await s.stop(); d.done(); }
});

test('CW-2・F231: 記録（log）には数と符号だけ（合い言葉・パイプの名前・DB のフォルダの字が無い）', T, async () => {
  const d = tmpData({ pages: 1 });
  d.close();
  const s = boot(d);
  let p = null;
  try {
    await s.ready();
    p = await doorOf(d);
    const c = await hello(d);
    c.send({ id: 1, cmd: 'mcp.c180w', args: { id: d.ids[0], title: '記録を見る' }, tx: 'c:c180-log-1' });   // D77
    await c.reply(1);
    const bad = dial(p.pipe);
    await bad.opened;
    bad.send({ hello: 'c'.repeat(64), v: 1 });
    await bad.next();
    c.close();
  } finally { await s.stop(); }
  try {
    const logs = s.logs();
    assert.ok(logs.includes('DB: 書き込みの口を開いた'), logs.join('\n'));
    assert.ok(logs.some((x) => /^DB: 書き込みの口 つないだ（\d+）$/.test(x)) && logs.includes('DB: 書き込みの口 断った（合い言葉）'), logs.join('\n'));
    const name = path.basename(p.pipe).replace(/\.sock$/, '');
    for (const l of logs) {
      for (const secret of [p.token, name, p.pipe, d.dataDir, '記録を見る']) assert.ok(!l.includes(secret), `記録に出た: ${l}`);
    }
  } finally { d.done(); }
});

// ---------------------------------------------------------------- 純粋な部品の表
test('CW-2: parseDoor・checkHello・pipePath の表（形の違う紙・長い合い言葉・別のパイプの名前・TCP の番地は null・偽）', () => {
  const rand = (n) => Buffer.alloc(n, 0xab);
  assert.strictEqual(D.pipePath('win32', rand), `\\\\.\\pipe\\natsu-${'ab'.repeat(12)}`);
  assert.strictEqual(path.basename(D.pipePath('linux', rand)), `natsu-${'ab'.repeat(12)}.sock`);
  assert.ok(path.isAbsolute(D.pipePath('linux', rand)));
  const win = `\\\\.\\pipe\\natsu-${'0123456789ab'.repeat(2)}`;
  assert.deepStrictEqual(D.parseDoor(D.doorText({ pipe: win, token: TOKEN, pid: 4321 })), { pipe: win, token: TOKEN, pid: 4321 });
  const sock = path.join(path.parse(process.cwd()).root, 'tmp', `natsu-${'f'.repeat(24)}.sock`);
  assert.deepStrictEqual(D.parseDoor(`pipe ${sock}\ntoken ${TOKEN}\npid 1\n`), { pipe: sock, token: TOKEN, pid: 1 });
  for (const [text, what] of [
    [`pipe ${win}\ntoken ${TOKEN}\npid 1`, '最後の改行が無い'],
    [`pipe ${win}\ntoken ${TOKEN}\npid 1\nextra 1\n`, '4行'],
    [`token ${TOKEN}\npipe ${win}\npid 1\n`, '行の順が違う'],
    [`pipe ${win}\ntoken ${TOKEN}a\npid 1\n`, '長い合い言葉'],
    [`pipe ${win}\ntoken ${'A'.repeat(64)}\npid 1\n`, '大文字の合い言葉'],
    [`pipe \\\\.\\pipe\\other-${'0'.repeat(24)}\ntoken ${TOKEN}\npid 1\n`, '別のパイプの名前'],
    [`pipe \\\\server\\pipe\\natsu-${'0'.repeat(24)}\ntoken ${TOKEN}\npid 1\n`, 'ほかの PC のパイプ'],
    [`pipe 127.0.0.1:8080\ntoken ${TOKEN}\npid 1\n`, 'TCP の番地と港'],
    [`pipe natsu-${'0'.repeat(24)}.sock\ntoken ${TOKEN}\npid 1\n`, '相対のパス'],
    [`pipe ${win}\ntoken ${TOKEN}\npid 0\n`, 'pid 0'],
    ['', '空'], [null, 'null'], [{ pipe: win }, '物'],
  ]) assert.strictEqual(D.parseDoor(text), null, what);
  assert.strictEqual(D.checkHello(JSON.stringify({ hello: TOKEN, v: 1 }), TOKEN), true);
  for (const [line, what] of [
    [JSON.stringify({ hello: 'b'.repeat(64), v: 1 }), '違う合い言葉'],
    [JSON.stringify({ hello: TOKEN, v: 2 }), '版が違う'],
    [JSON.stringify({ hello: TOKEN }), '版が無い'],
    [JSON.stringify({ hello: TOKEN, v: 1, x: 1 }), '欄が多い'],
    [JSON.stringify({ hello: `${TOKEN}a`, v: 1 }), '長い合い言葉'],
    [JSON.stringify({ hello: TOKEN.slice(1), v: 1 }), '短い合い言葉'],
    [JSON.stringify([TOKEN]), '配列'], ['{"hello":', '壊れた JSON'], ['', '空'],
  ]) assert.strictEqual(D.checkHello(line, TOKEN), false, what);
  assert.strictEqual(D.checkHello(JSON.stringify({ hello: TOKEN, v: 1 }), 'short'), false, '形の違う合い言葉と比べた');
});
