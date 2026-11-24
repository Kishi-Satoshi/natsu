/* stage180.db.test.js — 0.18.0（計画 docs/plans/2026-11-18-180.md）の DB（一時の DB に本物の命令を通す）
 *  CW-1（決めたこと 9〜14・F232〜F234）: 表の形の版 2（page_snapshot）・上げる前の控え・控えの書き方（withSnap）・控えから戻す命令
 * 会議の題名は titleAt（D77）。データベースの題名・列の名前・人の名前は作った物（実在の人名を使わない）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const sqlite = require('node:sqlite');
const { MessageChannel } = require('node:worker_threads');
const { tmpDb, tmpData, samplePage, electronShape } = require('./helpers/dbtmp');
const { titleAt } = require('./helpers/titles');
const core = require('../src/db/core');
const C = require('../src/db/commands');
const schema = require('../src/db/schema');
const S = require('../src/db/snapshot');
const MD = require('../src/memoDoc');
const { applyOps } = require('../src/db/ops');
const { UNDO_CMDS } = require('../src/undoBook');
const { startServer } = require('../src/db/server');
const tools = require('../src/mcp/tools');

let clock = Date.parse('2026-11-22T01:00:00.000Z');
const now = () => new Date(clock);
const tick = () => { clock += 60000; return new Date(clock).toISOString(); };
let n = 0;
const txOf = (role) => `${role[0]}:c180-${String(++n).padStart(6, '0')}`;
const call = (db, cmd, args, role = 'app', tx = txOf(role)) => { tick(); return { ...core.call(db, { role, cmd, args, tx }, { now, labels: {} }), tx }; };
const ok = (r, what) => { assert.strictEqual(r.ok, true, `${what}: ${r.code}`); return r; };
const T = { timeout: 60000 };
function withDb(fn) {
  const t = tmpDb();
  let out;
  try { const { db } = t.open(); out = fn(db, t); } catch (e) { t.done(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(() => t.done());
  t.done();
  return out;
}
const snapRows = (db, id) => db.prepare('select rid, page_id, at, what, rev_after, body from page_snapshot where page_id = ? order by rid').all(id).map((r) => ({ ...r }));
const revOf = (db, id) => db.prepare('select rev from blocks where id = ?').get(id).rev;

// Claude の書き込みの代わり（役 mcp の命令は第2部で作る）: 試しの命令が、控え（withSnap）の中で今の命令の本体を呼ぶ
const FNS = new Map([
  ['block', (db, a, ctx) => core.COMMANDS['block.update'].run(db, { pageId: a.pageId, blockId: a.blockId, patch: { text: a.text } }, ctx)],
  ['seg', (db, a, ctx) => core.COMMANDS['segment.update'].run(db, { pageId: a.pageId, segId: 's2', patch: { text: a.text } }, ctx)],
  ['cell', (db, a, ctx) => core.COMMANDS['row.setCell'].run(db, { db: a.db, id: a.pageId, col: a.col, value: a.text }, ctx)],
  ['boom', (db, a, ctx) => { core.COMMANDS['block.update'].run(db, { pageId: a.pageId, blockId: a.blockId, patch: { text: '投げる前の直し' } }, ctx); throw new Error('試しに投げる'); }],
]);
core.registerForTest({
  'test.c180w': { roles: ['app'], write: true, args: { pageId: 'id', what: 'short', fn: 'short', blockId: 'id?', text: 'short?', db: 'id?', col: 'id?', segIds: 'ids?' },
    run: (db, a, ctx) => C.withSnap(db, a.pageId, a.what, () => FNS.get(a.fn)(db, a, ctx), ctx, { segIds: a.segIds || [] }) },
});
const claudeWrite = (db, args) => call(db, 'test.c180w', args);

// 白紙のページ（本文に1行）
function blankPage(db, text = '白紙の本文の一行') {
  const id = ok(call(db, 'page.create', {}), 'page.create').result.id;
  const blockId = ok(call(db, 'block.insert', { pageId: id, afterBlockId: '', type: 'paragraph' }), 'block.insert').result.blockId;
  ok(call(db, 'block.update', { pageId: id, blockId, patch: { text } }), 'block.update');
  return { id, blockId };
}
// データベースと、題名とテキストの列のセルを持つ行（行の本文に1行）
function dbWithRow(db) {
  const d = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const col = ok(call(db, 'col.add', { db: d, type: 'text', name: 'メモの列' }), 'col.add').result.col.id;
  const col2 = ok(call(db, 'col.add', { db: d, type: 'text', name: '消す列' }), 'col.add').result.col.id;
  const row = ok(call(db, 'row.add', { db: d, title: '行の題', cells: { [col]: '前の値', [col2]: '消す列の値' } }), 'row.add').result.id;   // D77: データベースの行の題名（会議の題名でない）
  const blockId = ok(call(db, 'block.insert', { pageId: row, afterBlockId: '', type: 'paragraph' }), 'block.insert(行)').result.blockId;
  ok(call(db, 'block.update', { pageId: row, blockId, patch: { text: '行の本文' } }), 'block.update(行)');
  return { d, col, col2, row, blockId };
}
// 議事録（要約・メモの行・発言）
function meetingPage(t, id = 'pm1') {
  const { page, segments } = samplePage(id);
  for (const b of page.blocks) b.id = `${id}${b.id}`;   // ブロックの ID は表全体で重ならない
  page.memo = 'メモの一行';
  page.memoDoc = MD.memoFromText(page.memo);
  t.seed(page, segments);
  return id;
}

// ---------------------------------------------------------------- 版 2 と上げる前の控え（F232）
// 版 1（0.16.0・0.17.0 の形）の DB のフォルダ: 今の版で作った DB から版 2 の表を外し、user_version を 1 にする。olds 個の最上位の議事録を足す
function v1Data(olds = 0) {
  const d = tmpData({ pages: 0 });
  d.close();
  const raw = new sqlite.DatabaseSync(d.file);
  try {
    raw.exec('drop table if exists page_snapshot');
    raw.exec('pragma user_version = 1');
    for (let i = 0; i < olds; i += 1) {
      const id = `pq${i}`;
      const { page, segments } = samplePage(id);
      page.title = titleAt(`2026-11-0${i + 1}T01:00:00.000Z`);
      page.createdAt = `2026-11-0${i + 1}T01:00:00.000Z`;
      for (const b of page.blocks) b.id = `${id}${b.id}`;
      raw.exec('BEGIN IMMEDIATE');
      C.putPageRows(raw, page, segments);
      raw.exec('COMMIT');
    }
  } finally { raw.close(); }
  return d;
}
async function waitFor(pred, what, ms = 20000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`待ちきれない: ${what}`);
    await new Promise((res) => setTimeout(res, 10));
  }
}
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
const backups = (d, kind) => S.listBackups({ dataDir: d.dataDir }).filter((b) => b.kind === kind);
const versionOf = (file) => { const c = new sqlite.DatabaseSync(file, { readOnly: true }); try { return c.prepare('pragma user_version').get().user_version; } finally { c.close(); } };
const schemaOf = (file) => {
  const c = new sqlite.DatabaseSync(file, { readOnly: true });
  try { return c.prepare("select type, name, tbl_name, sql from sqlite_schema where name not like 'sqlite_%' order by type, name").all().map((r) => ({ ...r })); } finally { c.close(); }
};

test('CW-1・F232: 版 1 の DB を開くと、上げる前に控え upgrade を1つ取り（確かめ ok・中身は版 1）、版 2 に上がって page_snapshot と索引がある。版 1 の表の SQL は変わらない。0.17.0 の議事録のまとめは版を上げた後', T, async () => {
  const d = v1Data(2);
  const s = boot(d);
  try {
    const r = await s.ready();
    assert.deepStrictEqual([r.state, r.version], ['ok', 2], s.logs().join('\n'));
    const logs = s.logs();
    const iSnap = logs.findIndex((x) => /^DB: 控え upgrade・確かめ ok/.test(x));
    const iUp = logs.indexOf('DB: 表の形を v2 に上げた');
    const iGather = logs.findIndex((x) => x.startsWith('DB: 議事録 移した 2'));
    assert.ok(iSnap >= 0 && iUp > iSnap && iGather > iUp, `順が違う（開く → 控え → 版 2 → 見回り）:\n${logs.join('\n')}`);
    assert.ok(!logs.some((x) => x.includes('議事録をまとめられない')), logs.join('\n'));
  } finally { await s.stop(); }
  try {
    // 版を上げる前の控え（いちばん古い upgrade）の中身は版 1・page_snapshot が無い（版を上げた後に取った控えではない）
    const ups = backups(d, 'upgrade');
    assert.ok(ups.length >= 1, '上げる前の控えが無い');
    const f = path.join(d.dir, 'first-upgrade.db');
    fs.writeFileSync(f, zlib.gunzipSync(fs.readFileSync(path.join(d.dataDir, 'backup', ups[0].name))));
    assert.strictEqual(versionOf(f), 1, '上げる前の控えが版 1 でない');
    assert.ok(!schemaOf(f).some((x) => x.name === 'page_snapshot'));
    // 上げた DB: 版 2・page_snapshot と索引・版 1 の表の形は版 1 だけで作った DB と1字も同じ
    assert.strictEqual(versionOf(d.file), 2);
    const now2 = schemaOf(d.file);
    assert.deepStrictEqual(now2.filter((x) => x.tbl_name === 'page_snapshot').map((x) => [x.type, x.name]), [['index', 'page_snapshot_page'], ['table', 'page_snapshot']]);
    const f1 = path.join(d.dir, 'only-v1.db');
    const o1 = core.open({ sqlite, file: f1, steps: { 1: schema.STEPS[1] } });
    assert.deepStrictEqual([o1.state, o1.version], ['ok', 1]);
    o1.db.close();
    assert.deepStrictEqual(now2.filter((x) => x.tbl_name !== 'page_snapshot'), schemaOf(f1), '版 1 の表の形が変わった');
  } finally { d.done(); }
});

test('CW-1・F232: 控えが取れない（控えのフォルダを作れない偽の fs）と版を上げず state failed・user_version は 1 のまま。次の起動（作れる fs）で上がる', T, async () => {
  const d = v1Data(0);
  const noBackup = new Proxy(fs, { get: (t, k) => (k === 'mkdirSync'
    ? (p, ...a) => { if (/[\\/]backup$/.test(String(p))) throw Object.assign(new Error('EACCES: 試し'), { code: 'EACCES' }); return t.mkdirSync(p, ...a); }
    : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
  try {
    let s = boot(d, { fs: noBackup });
    try {
      const r = await s.ready();
      assert.strictEqual(r.state, 'failed', s.logs().join('\n'));
      assert.ok(s.logs().includes('DB: 版を上げる前の控えが取れない（io）'), s.logs().join('\n'));
    } finally { await s.stop(); }
    assert.strictEqual(versionOf(d.file), 1, '控えが取れないのに版を上げた');
    assert.ok(!fs.existsSync(path.join(d.dataDir, S.LOCK_NAME)), 'lock が残った');
    s = boot(d);
    try {
      const r = await s.ready();
      assert.deepStrictEqual([r.state, r.version], ['ok', 2], s.logs().join('\n'));
    } finally { await s.stop(); }
    assert.strictEqual(versionOf(d.file), 2);
    assert.strictEqual(backups(d, 'upgrade').length, 1);
  } finally { d.done(); }
});

test('CW-1・F232: 新しい（natsu.db の無い）フォルダは、控えを取らずに今の版で作る（守る中身が無い・初めての起動を遅くしない: CR39）', T, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-c180-新しい𠮷-'));
  const d = { dataDir: path.join(dir, 'data') };
  try {
    const s = boot(d, { runCheck: async () => { throw new Error('確かめを走らせた'); } });
    try {
      const r = await s.ready();
      assert.deepStrictEqual([r.state, r.version], ['ok', 2], s.logs().join('\n'));
      assert.ok(!s.logs().some((x) => x.startsWith('DB: 表の形を v') || x.includes('控え upgrade')), s.logs().join('\n'));
    } finally { await s.stop(); }
    assert.deepStrictEqual(backups(d, 'upgrade'), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CW-1・F232: core.open({ upgrade: false }) は版 1 の DB で state old（版はそのまま）・書く命令は read-only。upgradeTo で版 2 に上がると書ける', T, () => {
  const d = v1Data(0);
  try {
    const o = core.open({ sqlite, file: d.file, upgrade: false });
    try {
      assert.deepStrictEqual([o.state, o.version], ['old', 1]);
      assert.strictEqual(o.db.prepare('pragma user_version').get().user_version, 1);
      core.registerForTest({ 'test.c180old': { roles: ['main'], write: true, args: {}, run: () => ({ ops: [], pageIds: [], result: null }) } });
      assert.deepStrictEqual(core.call(o.db, { role: 'main', cmd: 'test.c180old', args: {}, tx: 'm:c180-old-1' }, { now }).code, 'read-only');
      assert.deepStrictEqual(core.upgradeTo(o.db), { ok: true, version: 2 });
      assert.strictEqual(o.db.prepare('pragma user_version').get().user_version, 2);
      assert.strictEqual(core.call(o.db, { role: 'main', cmd: 'test.c180old', args: {}, tx: 'm:c180-old-2' }, { now }).ok, true);
    } finally { o.db.close(); }
  } finally { d.done(); }
});

test('CW-1・F232: 版 2 の DB を版 1 の数（steps を1段に: 前の版の NaTsu）で開くと newer の読み取りだけ・書く命令は read-only。MCP の読み手は版 1 の DB に old、版 3 の DB に newer の文', T, () => {
  const d = tmpData({ pages: 1 });
  d.close();
  try {
    const o = core.open({ sqlite, file: d.file, steps: { 1: schema.STEPS[1] } });
    try {
      assert.deepStrictEqual([o.state, o.version], ['newer', 2]);
      assert.strictEqual(core.call(o.db, { role: 'app', cmd: 'page.setTitle', args: { id: d.ids[0], title: '前の版の直し' }, tx: 'a:c180-newer-1' }, { now }).code, 'read-only');   // D77
    } finally { o.db.close(); }
    assert.strictEqual(versionOf(d.file), 2, '前の版の数で開いて版を下げた');
    const mcp = () => tools.callTool('list_meetings', {}, { sqlite, dataDir: d.dataDir, now });
    assert.deepStrictEqual([mcp().isError, mcp().code], [false, 'ok']);
    const raw = new sqlite.DatabaseSync(d.file);
    try { raw.exec('drop table page_snapshot'); raw.exec('pragma user_version = 1'); } finally { raw.close(); }
    assert.deepStrictEqual([mcp().isError, mcp().code, mcp().text], [true, 'old', tools.ERROR_TEXT.old]);
    assert.strictEqual(versionOf(d.file), 1, 'MCP の読み手が版を上げた');
    const raw3 = new sqlite.DatabaseSync(d.file);
    try { raw3.exec('pragma user_version = 3'); } finally { raw3.close(); }
    assert.deepStrictEqual([mcp().isError, mcp().code, mcp().text], [true, 'newer', tools.ERROR_TEXT.newer]);
  } finally { d.done(); }
});

// ---------------------------------------------------------------- 控えの書き方（F233）
test('CW-1・F233: withSnap は同じトランザクション: 中の fn が投げると、控えもページも変わらない（命令の後に控えだけ残ることも無い）', T, async () => withDb(async (db, t) => {
  const id = meetingPage(t);
  const before = C.readPage(db, id);
  const r = claudeWrite(db, { pageId: id, what: 'summary', fn: 'boom', blockId: `${id}b2` });
  assert.deepStrictEqual([r.ok, r.code], [false, 'internal']);
  await new Promise((res) => setImmediate(res));
  await new Promise((res) => setTimeout(res, 20));
  assert.deepStrictEqual(snapRows(db, id), [], '投げたのに控えが残った');
  assert.deepStrictEqual(C.readPage(db, id), before, '投げたのにページが変わった');
  assert.strictEqual(db.prepare('select count(*) c from oplog where tx = ?').get(r.tx).c, 0);
  // 書けたときは同じトランザクションで1行（rev_after は書いた後のページの rev）
  const w = ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: 'Claude が直した要点' }), 'write');
  void w;
  const rows = snapRows(db, id);
  assert.deepStrictEqual(rows.map((x) => [x.what, x.rev_after]), [['summary', revOf(db, id)]]);
  assert.strictEqual(JSON.parse(rows[0].body).blocks.find((b) => b.id === `${id}b2`).text, '来月の予算案の作成を担当Aが進める', '控えが書く前の形でない');
}));

test('CW-1・F233: 11 回書くと控えは新しい 10 行だけ（ほかのページの控えは消さない）', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const other = meetingPage(t, 'pm2');
  ok(claudeWrite(db, { pageId: other, what: 'names', fn: 'block', blockId: `${other}b2`, text: 'ほかのページ' }), 'other');
  for (let i = 0; i < 11; i += 1) ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: `直し${i}` }), `write ${i}`);
  const rows = snapRows(db, id);
  assert.strictEqual(rows.length, 10);
  assert.strictEqual(JSON.parse(rows[0].body).blocks.find((b) => b.id === `${id}b2`).text, '直し0', '古い方から消していない');
  assert.strictEqual(JSON.parse(rows[9].body).blocks.find((b) => b.id === `${id}b2`).text, '直し9');
  assert.strictEqual(snapRows(db, other).length, 1, 'ほかのページの控えを消した');
}));

test('CW-1・F233: 控えの中身はページの種類ごと（議事録: 要約の行・メモの行・控えの欄・名前の直しで変える発言の文だけ／白紙: 本文の行／行: 題名・セル・本文の行）', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  ok(claudeWrite(db, { pageId: id, what: 'names', fn: 'seg', text: '直した発言', segIds: ['s2'] }), 'meeting');
  const m = JSON.parse(snapRows(db, id)[0].body);
  assert.deepStrictEqual(Object.keys(m).sort(), ['attrs', 'blocks', 'memoDoc', 'segs']);
  assert.deepStrictEqual(m.segs, [{ id: 's2', text: '来月の予算案の作成は担当Aさんが進めることにしました' }], '発言の文が控えに無い・ほかの発言まで写した');
  assert.deepStrictEqual(m.memoDoc, MD.memoFromText('メモの一行'));
  assert.deepStrictEqual([m.attrs.meetingType, m.attrs.memo, m.attrs.summaryError, m.attrs.citeStat], ['general', 'メモの一行', '', { linked: 9, total: 9 }]);
  assert.deepStrictEqual(m.attrs.route, samplePage().page.route);
  assert.ok(!Object.hasOwn(m.attrs, 'title') && !Object.hasOwn(m.attrs, 'pauses') && !Object.hasOwn(m.attrs, 'extraField'), '控えの欄の外を写した');
  assert.deepStrictEqual(m.blocks.map((b) => b.id), ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map((b) => `${id}${b}`));
  const blank = blankPage(db);
  ok(claudeWrite(db, { pageId: blank.id, what: 'append', fn: 'block', blockId: blank.blockId, text: '書き足した' }), 'blank');
  const b = JSON.parse(snapRows(db, blank.id)[0].body);
  assert.deepStrictEqual(Object.keys(b), ['blocks']);
  assert.deepStrictEqual(b.blocks.map((x) => x.text), ['白紙の本文の一行']);
  const r = dbWithRow(db);
  ok(claudeWrite(db, { pageId: r.row, what: 'row', fn: 'cell', db: r.d, col: r.col, text: 'Claude の値' }), 'row');
  const rb = JSON.parse(snapRows(db, r.row)[0].body);
  assert.deepStrictEqual(Object.keys(rb).sort(), ['blocks', 'cells', 'title']);
  assert.deepStrictEqual([rb.title, rb.cells, rb.blocks.map((x) => x.text)], ['行の題', { [r.col]: '前の値', [r.col2]: '消す列の値' }, ['行の本文']]);
}));

test('CW-1・RF16・F233: Claude の控えのあるページを meeting.discard すると page_snapshot の行が無く、チェックポイントの後の DB のファイルに目印の文字が無い。page.delete・rows.trash では控えが残る', T, () => withDb((db, t) => {
  const mark = '控えだけにある目印の文字列ＲＦ十六';
  ok(call(db, 'meeting.begin', { pageId: 'plive1', startedAt: Date.parse('2026-11-22T00:00:00.000Z') }, 'main'), 'begin');
  ok(call(db, 'meeting.segment', { pageId: 'plive1', seg: { id: 's1', atMs: 0, durationMs: 1000, text: '取り消す会議の発言' } }, 'main'), 'segment');
  // 録音中の写しには Claude は書けない（第2部）。ここでは控えの行を素の SQL で置いて、取り消しで消えるかを見る
  db.prepare('insert into page_snapshot(page_id, at, what, rev_after, body) values (?, ?, ?, ?, ?)').run('plive1', tick(), 'summary', 1, JSON.stringify({ blocks: [{ id: 'bx', type: 'bullet', text: mark, children: [] }] }));
  ok(call(db, 'meeting.discard', { pageId: 'plive1' }, 'main'), 'discard');
  assert.strictEqual(db.prepare("select count(*) c from page_snapshot where page_id = 'plive1'").get().c, 0, '取り消した会議の控えが残った');
  db.exec('pragma wal_checkpoint(TRUNCATE)');
  for (const f of [t.file, `${t.file}-wal`]) {
    if (fs.existsSync(f)) assert.ok(!fs.readFileSync(f).includes(Buffer.from(mark, 'utf8')), `${path.basename(f)} に控えの文字が残った`);
  }
  // ゴミ箱へ入れるのは控えを残す（戻したページで使える）
  const id = meetingPage(t);
  ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: '直した' }), 'write');
  ok(call(db, 'page.delete', { id }), 'page.delete');
  assert.strictEqual(snapRows(db, id).length, 1, 'page.delete で控えが消えた');
  const r = dbWithRow(db);
  ok(claudeWrite(db, { pageId: r.row, what: 'row', fn: 'cell', db: r.d, col: r.col, text: '新しい値' }), 'row');
  ok(call(db, 'rows.trash', { db: r.d, ids: [r.row] }), 'rows.trash');
  assert.strictEqual(snapRows(db, r.row).length, 1, 'rows.trash で控えが消えた');
}));

// ---------------------------------------------------------------- 控えの一覧と戻す（F234）
test('CW-1・F234: page.claudeSnaps は新しい順（sid・at・what・later）。later は後で誰かが書いたとき（page.setTitle だけでも）。役 mcp・main は forbidden。無い・ゴミ箱のページは空', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const w1 = claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: '一回目' });
  const at1 = new Date(clock).toISOString();
  ok(w1, 'w1');
  ok(claudeWrite(db, { pageId: id, what: 'names', fn: 'block', blockId: `${id}b3`, text: '二回目' }), 'w2');
  const at2 = new Date(clock).toISOString();
  const rids = snapRows(db, id).map((x) => x.rid);
  const list = ok(call(db, 'page.claudeSnaps', { id }), 'snaps').result;
  // 点検 3（CR106）で意図して直した: 行に読んだ時のページの版（rev）を足した（page.claudeRevert に渡して、確かめの後の変わりを見分ける）
  const rev = C.readPage(db, id).rev;
  assert.deepStrictEqual(list, [{ sid: rids[1], at: at2, what: 'names', later: false, rev }, { sid: rids[0], at: at1, what: 'summary', later: true, rev }]);
  ok(call(db, 'page.setTitle', { id, title: '利用者が付け直した題' }), 'setTitle');   // 利用者が付け直した題名（D77）
  assert.deepStrictEqual(ok(call(db, 'page.claudeSnaps', { id }), 'snaps').result.map((x) => x.later), [true, true], '後で書いても later が偽');
  for (const role of ['mcp', 'main']) assert.strictEqual(core.call(db, { role, cmd: 'page.claudeSnaps', args: { id } }, { now }).code, 'forbidden', role);
  assert.deepStrictEqual(ok(call(db, 'page.claudeSnaps', { id: 'pnothing1' }), 'none').result, []);
  ok(call(db, 'page.delete', { id }), 'delete');
  assert.deepStrictEqual(ok(call(db, 'page.claudeSnaps', { id }), 'trashed').result, []);
  assert.strictEqual(core.COMMANDS['page.claudeSnaps'].write, false);
}));

test('CW-1・F234: page.claudeRevert（議事録）: 控えの形に戻る（要約の行・メモの行・控えの欄・控えた発言の文）・oplog の actor は me・その控えと新しい控えが消え古い控えは残る・議事録の題名とアイコンと親は今のまま・UNDO_CMDS に無い', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  ok(call(db, 'page.setIcon', { id, icon: '📝' }), 'icon');
  ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b4`, text: '古い方の控えの後' }), 'w0');
  const mid = C.readPage(db, id);
  const segsMid = C.readSegments(db, id);
  ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: 'Claude の要点' }), 'w1');
  ok(claudeWrite(db, { pageId: id, what: 'names', fn: 'seg', text: 'Claude が直した発言', segIds: ['s2'] }), 'w2');
  ok(call(db, 'page.setTitle', { id, title: '利用者の題' }), 'setTitle');   // 利用者が付け直した題名（D77）
  const rids = snapRows(db, id).map((x) => x.rid);
  const r = ok(call(db, 'page.claudeRevert', { id, sid: rids[1] }), 'revert');
  const p = C.readPage(db, id);
  assert.deepStrictEqual(p.blocks.map((b) => [b.id, b.text]), mid.blocks.map((b) => [b.id, b.text]), '要約の行が控えの形でない');
  assert.deepStrictEqual(C.readSegments(db, id), segsMid, '控えた発言の文が戻らない');
  assert.deepStrictEqual([p.title, p.icon, p.memo, p.memoDoc, p.meetingType], ['利用者の題', '📝', mid.memo, mid.memoDoc, mid.meetingType]);
  assert.deepStrictEqual(r.result.blocks.map((b) => b.text), p.blocks.map((b) => b.text));
  assert.strictEqual(db.prepare('select actor from oplog where tx = ?').get(r.tx).actor, 'me');
  assert.deepStrictEqual(snapRows(db, id).map((x) => x.rid), [rids[0]], '戻した控えと新しい控えを消していない');
  assert.ok(!UNDO_CMDS.has('page.claudeRevert') && !UNDO_CMDS.has('page.claudeSnaps'), 'Ctrl+Z の歩みに入れた');
}));

test('CW-1・F234: page.claudeRevert（白紙・行）: 白紙のページの本文に控えの後で作った子ページの行は本文の最後に残る（子ページの親は今のまま）。行は題名・セル・本文が戻り、今の列に無いセルは書かない。データベースの列とロックは今のまま', T, () => withDb((db) => {
  const blank = blankPage(db);
  ok(claudeWrite(db, { pageId: blank.id, what: 'append', fn: 'block', blockId: blank.blockId, text: 'Claude が書き足した' }), 'blank');
  const kid = ok(call(db, 'page.create', { parentId: blank.id }), 'kid').result.id;
  const sid = snapRows(db, blank.id)[0].rid;
  ok(call(db, 'page.claudeRevert', { id: blank.id, sid }), 'revert blank');
  const p = C.readPage(db, blank.id);
  assert.deepStrictEqual(p.blocks.map((b) => [b.type, b.type === 'subpage' ? b.page : b.text]), [['paragraph', '白紙の本文の一行'], ['subpage', kid]], '子ページの行が本文の最後に残らない');
  assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get(kid).parent_id, blank.id);
  // 行
  const r = dbWithRow(db);
  ok(claudeWrite(db, { pageId: r.row, what: 'row', fn: 'cell', db: r.d, col: r.col, text: 'Claude の値' }), 'row');
  ok(call(db, 'page.setTitle', { id: r.row, title: '後の題' }), 'row title');   // D77: データベースの行の題名
  ok(call(db, 'block.update', { pageId: r.row, blockId: r.blockId, patch: { text: '後の本文' } }), 'row body');
  ok(call(db, 'col.remove', { db: r.d, col: r.col2 }), 'col.remove');
  ok(call(db, 'col.purge', { db: r.d, col: r.col2 }), 'col.purge');
  ok(call(db, 'db.setLock', { db: r.d, on: true }), 'lock');
  const dbBefore = db.prepare('select attrs from blocks where id = ?').get(r.d).attrs;
  ok(call(db, 'page.claudeRevert', { id: r.row, sid: snapRows(db, r.row)[0].rid }), 'revert row');
  const row = db.prepare('select text, attrs from blocks where id = ?').get(r.row);
  const attrs = JSON.parse(row.attrs);
  assert.deepStrictEqual([row.text, attrs.cells], ['行の題', { [r.col]: '前の値' }], '題名とセルが戻らない・今の列に無いセルを書いた');
  assert.strictEqual(attrs.by.u, 'me');
  assert.deepStrictEqual(C.readPage(db, r.row).blocks.map((b) => b.text), ['行の本文']);
  assert.strictEqual(db.prepare('select attrs from blocks where id = ?').get(r.d).attrs, dbBefore, 'データベースの列・ロックが変わった');
}));

test('CW-1・F234: page.claudeRevert は録音中の写し・ゴミ箱のページ・ゴミ箱のデータベースの行・無い sid・ほかのページの sid を bad-args で何も変えない。役 mcp・main は forbidden', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: '直した' }), 'w');
  const sid = snapRows(db, id)[0].rid;
  const other = meetingPage(t, 'pm2');
  ok(claudeWrite(db, { pageId: other, what: 'summary', fn: 'block', blockId: `${other}b2`, text: 'ほか' }), 'w2');
  const bad = (args, what) => { const r = call(db, 'page.claudeRevert', args); assert.deepStrictEqual([r.ok, r.code], [false, 'bad-args'], what); };
  bad({ id, sid: sid + 1000 }, '無い sid');
  bad({ id, sid: snapRows(db, other)[0].rid }, 'ほかのページの sid');
  for (const role of ['mcp', 'main']) assert.strictEqual(core.call(db, { role, cmd: 'page.claudeRevert', args: { id, sid }, tx: txOf(role) }, { now }).code, 'forbidden', role);
  ok(call(db, 'meeting.begin', { pageId: 'plive2', startedAt: Date.parse('2026-11-22T00:00:00.000Z') }, 'main'), 'begin');
  db.prepare('insert into page_snapshot(page_id, at, what, rev_after, body) values (?, ?, ?, ?, ?)').run('plive2', tick(), 'summary', 1, JSON.stringify({ blocks: [], attrs: {}, segs: [] }));
  bad({ id: 'plive2', sid: snapRows(db, 'plive2')[0].rid }, '録音中の写し');
  const r = dbWithRow(db);
  ok(claudeWrite(db, { pageId: r.row, what: 'row', fn: 'cell', db: r.d, col: r.col, text: 'Claude の値' }), 'row');
  ok(call(db, 'page.delete', { id: r.d }), 'db delete');
  bad({ id: r.row, sid: snapRows(db, r.row)[0].rid }, 'ゴミ箱のデータベースの行');
  ok(call(db, 'page.delete', { id }), 'delete');
  bad({ id, sid }, 'ゴミ箱のページ');
  assert.strictEqual(snapRows(db, id).length, 1, '断ったのに控えを消した');
}));

test('CW-1: T4b: 控えに後の oplog（Claude の書き込みと page.claudeRevert を含む）を前へ当て直すと、blocks・segments が今と同じ（page_snapshot は比べない: 決めたこと 13）', T, async () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const id = meetingPage(t);
    const blank = blankPage(db);
    const to = path.join(t.dir, 'copy-cw1.db');
    await sqlite.backup(db, to);
    const copy = new sqlite.DatabaseSync(to);
    try {
      const k = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
      ok(claudeWrite(db, { pageId: id, what: 'names', fn: 'seg', text: 'Claude の発言', segIds: ['s2'] }), 'w1');
      ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: 'Claude の要点' }), 'w2');
      ok(claudeWrite(db, { pageId: blank.id, what: 'append', fn: 'block', blockId: blank.blockId, text: 'Claude の本文' }), 'w3');
      ok(call(db, 'page.claudeRevert', { id, sid: snapRows(db, id)[0].rid }), 'revert');
      ok(call(db, 'page.claudeRevert', { id: blank.id, sid: snapRows(db, blank.id)[0].rid }), 'revert blank');
      for (const r of db.prepare('select ops from oplog where seq > ? order by seq').all(k)) applyOps(copy, JSON.parse(r.ops), 'forward');
      const dump = (c) => [c.prepare('select id, type, page_id, parent_id, ord, text, rich, attrs, rev, created_at, updated_at, trashed_at from blocks order by id').all().map((r) => ({ ...r })),
        c.prepare('select page_id, id, n, at_ms, text, extra from segments order by page_id, n').all().map((r) => ({ ...r }))];
      assert.deepStrictEqual(dump(copy), dump(db));
      assert.strictEqual(copy.prepare('select count(*) c from page_snapshot').get().c, 0, '控えが操作の列に入った');
    } finally { copy.close(); }
  } finally { t.done(); }
});

// 0.18.0 XE-1 で意図して直した（計画の「意図して変えるテスト」の preload の名前の数）: edit.textStep を足して 75（意図「役 app の命令と同じ集まり」は残す）
// 0.18.0 XN-1 で意図して直した（同じ行）: page.duplicate を足して 76。pageDuplicate は tx 付きで、元に戻すの歩みにしない（CR24）
test('CW-1・XE-1・XN-1: preload の 76 の名前（page.claudeSnaps・page.claudeRevert・edit.textStep・page.duplicate）は役 app の命令と同じ集まり。page.claudeSnaps は読む命令（tx なし）・page.claudeRevert と page.duplicate は tx 付き', T, async () => {
  const vm = require('node:vm');
  const PRE = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const names = [.../const APP_COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(PRE)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.strictEqual(names.length, 76);
  assert.deepStrictEqual(names.sort(), Object.keys(core.COMMANDS).filter((k) => core.COMMANDS[k].roles.includes('app')).sort());
  const reads = [.../const DB_READS = new Set\(\[([^\]]*)\]\)/.exec(PRE)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.ok(reads.includes('page.claudeSnaps') && !reads.includes('page.claudeRevert'));
  const undo = [.../const UNDO_CMDS = new Set\(\[([^\]]*)\]\)/.exec(PRE)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.ok(!undo.includes('page.claudeRevert') && !undo.includes('page.claudeSnaps') && !undo.includes('page.duplicate'));
  const exposed = {}; const on = {}; let uuid = 0;
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async () => ({}), send: () => {} } };
  vm.runInNewContext(PRE, { require: () => electron, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, setTimeout, clearTimeout, console, Promise });
  const port = new EventTarget(); port.sent = []; port.postMessage = (m) => port.sent.push(structuredClone(m)); port.start = () => {};
  on['db:port']({ ports: [port] });
  exposed.koeApp.pageClaudeSnaps('pa1');
  exposed.koeApp.pageClaudeRevert('pa1', 7);
  exposed.koeApp.pageDuplicate('pa1');
  assert.deepStrictEqual(port.sent.map((m) => [m.cmd, m.args, typeof m.tx]), [['page.claudeSnaps', { id: 'pa1' }, 'undefined'], ['page.claudeRevert', { id: 'pa1', sid: 7 }, 'string'], ['page.duplicate', { id: 'pa1' }, 'string']]);
});

test('CW-1: 表の形の版は 2・STEPS は2段（版 1 の SQL は 0.15.0 の字のまま）', () => {
  assert.strictEqual(core.SCHEMA_VERSION, 2);
  assert.deepStrictEqual(Object.keys(schema.STEPS), ['1', '2']);
  assert.strictEqual(require('node:crypto').createHash('sha256').update(schema.STEPS[1]).digest('hex'), '3c4f1638e5806288d3f9fbedc86af6d8dfddaba6ac8fab0ab8a74c1fc5ba9772');
});

// ---------------------------------------------------------------- 点検 1（2026-11-22。AQ34・CR44〜CR47）
test('CW-1・点検 1・AQ34: page.claudeRevert はリレーションの列を戻さず（控えの後に結んだリレーションが残る）、今の列の種類・選択肢に合わない控えの値も戻さない（今の値のまま）。合う値は戻る', T, () => withDb((db) => {
  const r = dbWithRow(db);
  const other = ok(call(db, 'db.create', {}), 'db.create other').result.id;
  const target = ok(call(db, 'row.add', { db: other, title: '相手の行' }), 'row.add other').result.id;   // D77: データベースの行の題名
  const rel = ok(call(db, 'col.add', { db: r.d, type: 'rel', target: other }), 'col.add rel').result.col.id;
  const sel = ok(call(db, 'col.add', { db: r.d, type: 'select', name: '選ぶ列' }), 'col.add select').result.col.id;
  ok(call(db, 'col.setOpts', { db: r.d, col: sel, opts: [{ id: 'o1', name: '高', color: 'red' }, { id: 'o2', name: '低', color: 'default' }] }), 'col.setOpts');
  ok(call(db, 'row.setCell', { db: r.d, id: r.row, col: sel, value: 'o1' }), 'sel o1');
  ok(call(db, 'row.setCell', { db: r.d, id: r.row, col: r.col2, value: '12' }), 'col2 12');
  ok(claudeWrite(db, { pageId: r.row, what: 'row', fn: 'cell', db: r.d, col: r.col, text: 'Claude の値' }), 'claude');
  // 控えの後: リレーションを結ぶ・テキストの列を数値に変えて値を直す・選択肢 o1 を外して o2 にする
  ok(call(db, 'rel.link', { db: r.d, id: r.row, col: rel, ids: [target] }), 'rel.link');
  ok(call(db, 'col.setType', { db: r.d, col: r.col2, type: 'number' }), 'setType');
  ok(call(db, 'row.setCell', { db: r.d, id: r.row, col: r.col2, value: 34 }), 'col2 34');
  ok(call(db, 'row.setCell', { db: r.d, id: r.row, col: sel, value: 'o2' }), 'sel o2');
  ok(call(db, 'col.setOpts', { db: r.d, col: sel, opts: [{ id: 'o2', name: '低', color: 'default' }] }), 'drop o1');
  const targetBefore = db.prepare('select attrs from blocks where id = ?').get(target).attrs;
  ok(call(db, 'page.claudeRevert', { id: r.row, sid: snapRows(db, r.row)[0].rid }), 'revert');
  const cells = JSON.parse(db.prepare('select attrs from blocks where id = ?').get(r.row).attrs).cells;
  assert.strictEqual(cells[r.col], '前の値', '合う値が戻らない');
  assert.deepStrictEqual(cells[rel], [target], 'リレーションを戻した（控えの後に結んだリレーションが消えた）');
  assert.strictEqual(cells[r.col2], 34, '今の列の種類に合わない控えの値を書いた');
  assert.strictEqual(cells[sel], 'o2', '外した選択肢を書いた');
  assert.strictEqual(db.prepare('select attrs from blocks where id = ?').get(target).attrs, targetBefore, 'ほかの行を変えた');
}));

test('CW-1・点検 1: page.claudeRevert はリンクドビューの行（ビューの設定を中に持つ）を子ページの行と同じに扱う: 今の行のまま（ビューの設定も今のまま）・控えに無い今の行は本文の最後に残り・今は無い行は戻さない', T, () => withDb((db) => {
  const blank = blankPage(db);
  const d = ok(call(db, 'db.create', {}), 'db.create').result.id;
  const ins = () => ok(call(db, 'block.insertDbView', { pageId: blank.id, afterId: '', db: d }), 'insertDbView').result.blockId;
  const keep = ins();
  const gone = ins();
  ok(claudeWrite(db, { pageId: blank.id, what: 'append', fn: 'block', blockId: blank.blockId, text: 'Claude が書き足した' }), 'claude');
  ok(call(db, 'view.update', { db: d, viewId: 'v1', linked: keep, patch: { name: '後で付けた名前' } }), 'view.update');
  ok(call(db, 'block.remove', { pageId: blank.id, blockId: gone }), 'block.remove');
  const added = ins();
  const keepNow = C.readPage(db, blank.id).blocks.find((b) => b.id === keep);
  ok(call(db, 'page.claudeRevert', { id: blank.id, sid: snapRows(db, blank.id)[0].rid }), 'revert');
  const p = C.readPage(db, blank.id);
  assert.deepStrictEqual(p.blocks.map((b) => [b.type, b.id === blank.blockId ? b.text : b.id]), [['paragraph', '白紙の本文の一行'], ['dbview', keep], ['dbview', added]],
    'リンクドビューの行が今のままでない（控えの後に足した行が消えた・消した行が戻った）');
  assert.deepStrictEqual(p.blocks.find((b) => b.id === keep), keepNow, 'リンクドビューのビューの設定を控えの形に戻した');
}));

test('CW-1・点検 1: 何も変えなかった Claude の書き込み（操作が空）は控えを残さない（新しい 10 行の控えを押し出さない）', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  for (let i = 0; i < 10; i += 1) ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: `直し${i}` }), `write ${i}`);
  const before = snapRows(db, id);
  const rev = revOf(db, id);
  const r = ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: '直し9' }), 'same text');
  assert.strictEqual(JSON.parse(db.prepare('select ops from oplog where tx = ?').get(r.tx).ops).length, 0, '試しの書き込みが何か変えた');
  assert.strictEqual(revOf(db, id), rev);
  assert.deepStrictEqual(snapRows(db, id), before, '何も変えないのに控えを足した・古い控えを押し出した');
}));

test('CW-1・点検 1: page.claudeRevert は、戻した本文が行の上限（2,000 行）を越えるなら、ほかの本文の書き込みと同じ too-big で断り、何も変えない（控えも残る）', T, () => withDb((db) => {
  const blank = blankPage(db);
  ok(claudeWrite(db, { pageId: blank.id, what: 'append', fn: 'block', blockId: blank.blockId, text: 'Claude が書き足した' }), 'claude');
  const sid = snapRows(db, blank.id)[0].rid;
  const big = Array.from({ length: 2001 }, (_, i) => ({ id: `bbig${i}`, type: 'paragraph', text: `行${i}`, children: [] }));
  db.prepare('update page_snapshot set body = ? where rid = ?').run(JSON.stringify({ blocks: big }), sid);
  const before = C.readPage(db, blank.id);
  const r = call(db, 'page.claudeRevert', { id: blank.id, sid });
  assert.deepStrictEqual([r.ok, r.code], [false, 'too-big']);
  assert.deepStrictEqual(C.readPage(db, blank.id), before);
  assert.strictEqual(snapRows(db, blank.id).length, 1, '断ったのに控えを消した');
}));

test('CW-1・点検 1・AQ35: page_snapshot の番号は使い回さない（AUTOINCREMENT）: 戻して消えた控えの sid は、後の控えに付かず bad-args（無い控え）', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: '一回目' }), 'w1');
  const sid = snapRows(db, id)[0].rid;
  ok(call(db, 'page.claudeRevert', { id, sid }), 'revert');
  assert.deepStrictEqual(snapRows(db, id), []);
  ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: '二回目' }), 'w2');
  assert.ok(snapRows(db, id)[0].rid > sid, '消えた控えの番号を使い回した');
  const r = call(db, 'page.claudeRevert', { id, sid });
  assert.deepStrictEqual([r.ok, r.code], [false, 'bad-args'], '古い sid で新しい控えに戻った');
  assert.match(schema.STEPS[2], /rid INTEGER PRIMARY KEY AUTOINCREMENT,/);
}));

test('CW-1・点検 1: natsu.db.lock を書けない（控えを取る前に止まる）ときも、版を上げずに「版を上げる前の控えが取れない」の記録と upgrade-backup で止まり、版は 1 のまま（internal にしない）', T, async () => {
  const d = v1Data(0);
  const noLock = new Proxy(fs, { get: (t, k) => (k === 'writeFileSync'
    ? (p, ...a) => { if (path.basename(String(p)) === S.LOCK_NAME) throw Object.assign(new Error('EACCES: 試し'), { code: 'EACCES' }); return t.writeFileSync(p, ...a); }
    : (typeof t[k] === 'function' ? t[k].bind(t) : t[k])) });
  try {
    const s = boot(d, { fs: noLock });
    try {
      const r = await s.ready();
      assert.strictEqual(r.state, 'failed', s.logs().join('\n'));
      const logs = s.logs();
      assert.ok(logs.includes('DB: 版を上げる前の控えが取れない（EACCES）') && logs.includes('DB: 使えない（upgrade-backup）'), logs.join('\n'));
      assert.ok(!logs.some((x) => x.startsWith('DB: 思わぬ失敗') || x === 'DB: 使えない（internal）'), logs.join('\n'));
    } finally { await s.stop(); }
    assert.strictEqual(versionOf(d.file), 1, 'lock を書けないのに版を上げた');
    assert.deepStrictEqual(backups(d, 'upgrade'), []);
  } finally { d.done(); }
});

test('CW-2・点検 1: 役 mcp を持つ命令は、名前が mcp. で始まる命令とちょうど同じ集まりで、mcp.* の命令の役は mcp だけ（試しの命令 registerForTest は core.COMMANDS に入らない）', () => {
  const names = Object.keys(core.COMMANDS);
  assert.ok(names.length > 50, '命令の表が読めない');
  assert.ok(!names.includes('test.c180w') && !names.includes('test.c180old'), '試しの命令が core.COMMANDS に入った');
  const withMcp = names.filter((k) => core.COMMANDS[k].roles.includes('mcp')).sort();
  const mcpNamed = names.filter((k) => k.startsWith('mcp.')).sort();
  assert.deepStrictEqual(withMcp, mcpNamed, '役 mcp を持つ今の命令がある・mcp.* の命令に役 mcp が無い');
  for (const k of mcpNamed) assert.deepStrictEqual(core.COMMANDS[k].roles, ['mcp'], `${k} の役が mcp だけでない`);
});

// ---------------------------------------------------------------- CS-2（決めたこと 17〜22・F235・F236）: Claude の要約の書き戻し mcp.writeSummary
// 役 mcp の頼み（ctx に main が知らせた「要約を作っている間」の making を渡せる）
const mcp = (db, cmd, args, ctx = {}, tx = txOf('mcp')) => { tick(); return { ...core.call(db, { role: 'mcp', cmd, args, tx }, { now, labels: {}, ...ctx }), tx }; };
// 発言 s2「来月の予算案の作成は担当Aさんが進めることにしました」・s3「見積書は月末までに先方へ送る予定です」（samplePage）に当たる要約
const SUM_MD = [
  '## 決めたこと',
  '- 来月の予算案の作成は担当Aさんが進める（出典: s999）',
  '## ToDo',
  '- [ ] 見積書を月末までに先方へ送る（担当: 担当A / 期限: 月末）（出典: [s999](https://natsu.example/open#p=pm1&a=t:s999-s999)）',
].join('\n');
const writeSum = (db, id, more = {}, ctx = {}, tx) => mcp(db, 'mcp.writeSummary', { pageId: id, baseRev: revOf(db, id), md: SUM_MD, ...more }, ctx, tx);
const oplogOf = (db, tx) => { const r = db.prepare('select actor, action, page_id from oplog where tx = ?').get(tx); return r ? { ...r } : null; };

test('CS-2・F235: mcp.writeSummary は baseRev が今のページの rev と違えば conflict で何も変えない。同じなら書け、控えが1行（what summary）・oplog の actor は claude・changed の what は summary', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const before = C.readPage(db, id);
  const bad = mcp(db, 'mcp.writeSummary', { pageId: id, baseRev: before.rev + 1, md: SUM_MD });
  assert.deepStrictEqual([bad.ok, bad.code], [false, 'conflict']);
  assert.deepStrictEqual(C.readPage(db, id), before, '古い rev で書いた');
  assert.deepStrictEqual(snapRows(db, id), []);
  const r = ok(writeSum(db, id), 'mcp.writeSummary');
  assert.deepStrictEqual(r.changed, { pageIds: [id], actor: 'claude', what: 'summary' });
  assert.deepStrictEqual(oplogOf(db, r.tx), { actor: 'claude', action: 'mcp.writeSummary', page_id: id });
  const snaps = snapRows(db, id);
  assert.deepStrictEqual(snaps.map((s) => [s.what, s.rev_after]), [['summary', revOf(db, id)]]);
  assert.deepStrictEqual(JSON.parse(snaps[0].body).blocks.map((b) => b.text), before.blocks.map((b) => b.text), '控えが書く前の要約でない');
  const p = C.readPage(db, id);
  assert.deepStrictEqual(p.blocks.map((b) => `${b.type}:${b.text}`), ['heading:決めたこと', 'bullet:来月の予算案の作成は担当Aさんが進める', 'heading:ToDo', 'todo:見積書を月末までに先方へ送る']);
  assert.deepStrictEqual(r.result, { title: before.title, rows: 4, cited: p.citeStat.linked, citable: p.citeStat.total, edited: false, notes: [] });
  assert.ok(p.citeStat.total > 0 && p.citeStat.linked > 0, JSON.stringify(p.citeStat));
}));

test('CS-2・F235: making（main が要約を作っている間）・要約待ちのページは locked で何も変えず、外れたら書ける。録音中の写し・ゴミ箱・無いページは not-found。白紙のページ・データベース・データベースの行は bad-args', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const rev = revOf(db, id);
  const locked = writeSum(db, id, {}, { making: new Set([id]) });
  assert.deepStrictEqual([locked.ok, locked.code], [false, 'locked'], 'making のページに書いた');
  assert.strictEqual(revOf(db, id), rev);
  assert.deepStrictEqual(snapRows(db, id), []);
  ok(writeSum(db, id, {}, { making: new Set(['pother']) }), 'ほかのページの making は鍵にならない');
  // 要約待ち（D69）
  const { page: wp, segments: ws } = samplePage('pw1');
  for (const b of wp.blocks) b.id = `pw1${b.id}`;
  wp.summaryWait = true;
  t.seed(wp, ws);
  const w = writeSum(db, 'pw1');
  assert.deepStrictEqual([w.ok, w.code], [false, 'locked'], '要約待ちのページに書いた');
  assert.deepStrictEqual(snapRows(db, 'pw1'), []);
  // 録音中の写し（listedRows の外）
  const { page: lp, segments: ls } = samplePage('pl1');
  for (const b of lp.blocks) b.id = `pl1${b.id}`;
  lp.meeting = { phase: 'recording' };
  t.seed(lp, ls);
  const live = writeSum(db, 'pl1');
  assert.deepStrictEqual([live.ok, live.code], [false, 'not-found'], '録音中の写しに書いた');
  // 白紙のページ・データベース・データベースの行
  const blank = blankPage(db).id;
  const { d, row } = dbWithRow(db);
  for (const x of [blank, d, row]) {
    const r = writeSum(db, x);
    assert.deepStrictEqual([r.ok, r.code], [false, 'bad-args'], `${x} に要約を書いた`);
    assert.deepStrictEqual(snapRows(db, x), []);
  }
  // ゴミ箱・無いページ
  ok(call(db, 'page.delete', { id }), 'page.delete');
  const gone = mcp(db, 'mcp.writeSummary', { pageId: id, baseRev: revOf(db, id), md: SUM_MD });
  assert.deepStrictEqual([gone.ok, gone.code], [false, 'not-found'], 'ゴミ箱のページに書いた');
  const none = mcp(db, 'mcp.writeSummary', { pageId: 'pnone1', baseRev: 0, md: SUM_MD });
  assert.deepStrictEqual([none.ok, none.code], [false, 'not-found']);
}));

test('AQ42・CS-2: mcp.writeSummary の鍵は、main が要約を作っている間（making）と要約待ちだけ。要約が一度も無い議事録（文字起こしあり: 要約の欄の鍵の none・文字起こしも無い: empty）にも書け、要約待ちは今どおり locked', T, () => withDb((db, t) => {
  const noSummary = (id, { wait = false, segs = true } = {}) => {
    const { page, segments } = samplePage(id);
    Object.assign(page, { blocks: [], summaryError: '' }, wait ? { summaryWait: true } : {});
    delete page.route.summary;   // 要約の行・要約の印・要約の欄の注のどれも無い
    t.seed(page, segs ? segments : []);
    return id;
  };
  // 文字起こしのある議事録（要約の欄の鍵の none の形）
  const r = ok(writeSum(db, noSummary('pn1')), '要約の無い議事録に書けない');
  assert.deepStrictEqual(r.changed, { pageIds: ['pn1'], actor: 'claude', what: 'summary' });
  assert.deepStrictEqual(C.readPage(db, 'pn1').blocks.map((b) => b.type), ['heading', 'bullet', 'heading', 'todo']);
  assert.deepStrictEqual(snapRows(db, 'pn1').map((s) => s.what), ['summary']);
  // 文字起こしも無い議事録（empty の形）
  ok(writeSum(db, noSummary('pe1', { segs: false })), '文字起こしの無い議事録に書けない');
  assert.strictEqual(C.readPage(db, 'pe1').blocks.length, 4);
  // 要約の無い議事録でも、要約待ちと main が作っている間は locked（AQ42 で鍵にするのはこの2つ）
  const w = writeSum(db, noSummary('pw2', { wait: true }));
  assert.deepStrictEqual([w.ok, w.code], [false, 'locked'], '要約待ちに書いた');
  const m = writeSum(db, noSummary('pk2'), {}, { making: new Set(['pk2']) });
  assert.deepStrictEqual([m.ok, m.code], [false, 'locked'], 'making に書いた');
  assert.deepStrictEqual([...snapRows(db, 'pw2'), ...snapRows(db, 'pk2')], []);
}));

test('CS-2・F236: Markdown に無い発言の「（出典: s999）」を書いても、行の出典は照合の答えだけ（s999 を指さず、今の文字起こしの s2・s3 が付く）。印は文に残らない', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  ok(writeSum(db, id), 'mcp.writeSummary');
  const p = C.readPage(db, id);
  const all = p.blocks.flatMap((b) => (Array.isArray(b.cites) ? b.cites : []));
  assert.ok(!all.includes('s999'), JSON.stringify(all));
  assert.deepStrictEqual(p.blocks.filter((b) => b.type !== 'heading').map((b) => b.cites), [['s2'], ['s3']]);
  assert.ok(!p.blocks.some((b) => /出典/.test(b.text)), '出典の印が文に残った');
}));

test('CS-2: 書いた後: route.summary.by は claude・summaryEdited は真・meetingType を渡すと typeAuto: false で替わる・採点の節が無ければ前の quality が消える・本文が 2,000 行を越えると too-big・「議事録」の表の「要約」の列が新しい最初の要点', T, () => withDb((db, t) => {
  const { page, segments } = samplePage('pm1');
  for (const b of page.blocks) b.id = `pm1${b.id}`;
  page.quality = { total: 12, max: 25, axes: [], at: '2026-11-01T00:00:00.000Z' };
  page.summaryEdited = true;
  t.seed(page, segments);
  const r = ok(writeSum(db, 'pm1', { meetingType: 'standup' }), 'mcp.writeSummary');
  assert.strictEqual(r.result.edited, true, '手で直した要約を書き換えたことが答えに無い');
  const p = C.readPage(db, 'pm1');
  assert.deepStrictEqual([p.route.summary.by, typeof p.route.summary.at], ['claude', 'string']);
  assert.deepStrictEqual(p.route.stt, page.route.stt, '文字起こしの経路が変わった');
  assert.deepStrictEqual([p.summaryEdited, p.meetingType, p.typeAuto, p.summaryError, p.summaryWait === true], [true, 'standup', false, '', false]);
  assert.strictEqual(p.quality, undefined, '採点の節の無い要約で前の点が残った');
  // 長すぎる本文
  const big = mcp(db, 'mcp.writeSummary', { pageId: 'pm1', baseRev: revOf(db, 'pm1'), md: Array.from({ length: 2001 }, (_, i) => `- 行${i}`).join('\n') });
  assert.deepStrictEqual([big.ok, big.code], [false, 'too-big']);
  // 「議事録」データベースの「要約」の列（議事録から読む列）
  ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather');
  const mdb = db.prepare("select id, attrs from blocks where type = 'page' and instr(attrs, '\"minutes\"') > 0").get();
  const viewId = JSON.parse(mdb.attrs).views[0].id;
  const msumOf = () => ok(call(db, 'db.view', { id: mdb.id, viewId, from: 0, count: 50 }), 'db.view').result.rows.find((x) => x.id === 'pm1').msum;
  assert.strictEqual(msumOf(), '来月の予算案の作成は担当Aさんが進める');
  ok(mcp(db, 'mcp.writeSummary', { pageId: 'pm1', baseRev: revOf(db, 'pm1'), md: '## 決めたこと\n- 見積書を月末までに先方へ送る' }), '2回目');
  assert.strictEqual(msumOf(), '見積書を月末までに先方へ送る', '「議事録」の「要約」の列が古いまま');
}));

test('CS-2: 同じ tx の送り直しは dup で、2回目は控えも oplog も増えず、答えは同じ形', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const tx = txOf('mcp');
  const a = ok(writeSum(db, id, {}, {}, tx), '1回目');
  const n = db.prepare('select count(*) c from oplog').get().c;
  const b = mcp(db, 'mcp.writeSummary', { pageId: id, baseRev: 0, md: SUM_MD }, {}, tx);
  assert.deepStrictEqual([b.ok, b.dup], [true, true]);
  assert.deepStrictEqual(b.result, a.result, '送り直しの答えが違う');
  assert.strictEqual(db.prepare('select count(*) c from oplog').get().c, n);
  assert.strictEqual(snapRows(db, id).length, 1);
}));

// ---------------------------------------------------------------- AQ41（2026-11-22「設定に従う（おすすめ）」・決めたこと 22・CR59）: Claude の書き戻しの点は、
// main の要約と同じく設定「打ち合わせの質」（main が DB のプロセスに知らせた ctx.qualityScore）に従う
const SCORE_MD = ['## 決めたこと', '- 来月の予算案の作成は担当Aさんが進める', '## 打ち合わせの質（採点）',
  '目的と結論: 4 | 冒頭で決めることを言いました', '抜け・重なり: 3 | 予算の話を2回やり直しました', '決定事項: 5 | 人を足すと確かめました'].join('\n');
// 種類を手で選んだ議事録。long なら文字起こしが点を付ける長さ（quality.MIN_SCORE_CHARS）を越える
function scorePage(t, id, type, long) {
  const { page, segments } = samplePage(id);
  for (const b of page.blocks) b.id = `${id}${b.id}`;
  Object.assign(page, { meetingType: type, typeAuto: false });
  if (long) segments[1].text = '来月の予算案の作成は担当Aさんが進めることにしました。'.repeat(20);
  t.seed(page, segments);
  return id;
}

test('AQ41・CS-2: mcp.writeSummary の点は、main の要約と同じく設定「打ち合わせの質」に従う（付けない設定・付けない種類では、Claude が書いた採点の節を main と同じに黙って落とす。短ければ注 QN2・読めなければ注 QN1。節が無ければ点も注も無い。知らせが無ければ既定の「すべて」）', T, () => withDb((db, t) => {
  const SW = require('../src/summaryWrite');
  const UNREAD_MD = '## 決めたこと\n- 来月の予算案の作成は担当Aさんが進める\n## 打ち合わせの質（採点）\n読めない採点の行';
  const cases = [
    // [設定, 種類, 長い, Markdown, 点が付く, 注]
    ['all', 'standup', true, SCORE_MD, true, ''],
    ['on', 'standup', true, SCORE_MD, true, ''],
    [undefined, 'standup', true, SCORE_MD, true, ''],
    ['off', 'standup', true, SCORE_MD, false, ''],
    ['on', 'oneonone', true, SCORE_MD, false, ''],
    ['on', 'interview', true, SCORE_MD, false, ''],
    ['all', 'oneonone', true, SCORE_MD, true, ''],
    ['all', 'standup', false, SCORE_MD, false, SW.QUALITY_NOTE_SHORT],
    ['off', 'standup', false, SCORE_MD, false, ''],
    ['all', 'standup', true, UNREAD_MD, false, SW.QUALITY_NOTE_UNREAD],
    ['off', 'standup', true, UNREAD_MD, false, ''],
    ['all', 'standup', true, '## 決めたこと\n- 来月の予算案の作成は担当Aさんが進める', false, ''],
  ];
  cases.forEach(([setting, type, long, md, scored, note], i) => {
    const id = scorePage(t, `pq${i}`, type, long);
    const what = JSON.stringify([setting, type, long, i]);
    ok(mcp(db, 'mcp.writeSummary', { pageId: id, baseRev: revOf(db, id), md }, setting === undefined ? {} : { qualityScore: setting }), what);
    const p = C.readPage(db, id);
    assert.strictEqual(Boolean(p.quality), scored, `${what}: 点`);
    if (scored) assert.ok(p.quality.total > 0, what);
    assert.strictEqual(p.summaryError, note, `${what}: 注`);
    assert.ok(!p.blocks.some((b) => /打ち合わせの質|目的と結論|読めない採点/.test(b.text)), `${what}: 採点の節が本文に残った`);
  });
}));

// ---------------------------------------------------------------- CS-3（決めたこと 23〜26・F237）: Claude の名前の直し mcp.fixNames
const fixN = (db, id, pairs, ctx) => mcp(db, 'mcp.fixNames', { pageId: id, pairs }, ctx);

test('AQ40・CS-3: mcp.fixNames は、main が要約を作っている間（making）と要約待ちのページは locked で何も変えない（当たりがあっても）。外れたら書ける。要約の無い議事録・白紙のページは鍵にならない', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const before = C.readPage(db, id);
  const pairs = [{ from: '担当A', to: '担当B' }];
  const m = fixN(db, id, pairs, { making: new Set([id]) });
  assert.deepStrictEqual([m.ok, m.code], [false, 'locked'], 'making のページの名前を直した');
  assert.deepStrictEqual(C.readPage(db, id), before);
  assert.deepStrictEqual(snapRows(db, id), []);
  // 要約待ち
  const w = db.prepare('select attrs from blocks where id = ?').get(id);
  db.prepare('update blocks set attrs = ? where id = ?').run(JSON.stringify({ ...JSON.parse(w.attrs), summaryWait: true }), id);
  const waiting = fixN(db, id, pairs);
  assert.deepStrictEqual([waiting.ok, waiting.code], [false, 'locked'], '要約待ちのページの名前を直した');
  assert.deepStrictEqual(snapRows(db, id), []);
  db.prepare('update blocks set attrs = ? where id = ?').run(w.attrs, id);
  const r = ok(fixN(db, id, pairs, { making: new Set(['pother']) }), '鍵が外れたら書ける（ほかのページの making は鍵にならない）');
  assert.ok(r.result.counts.summary + r.result.counts.transcript > 0, JSON.stringify(r.result));
  // 要約の無い議事録（要約の欄の鍵の none の形）は鍵にならない（AQ40 は「作っている間・要約待ち」だけ）
  const { page, segments } = samplePage('pn1');
  Object.assign(page, { blocks: [], summaryError: '' });
  delete page.route.summary;
  t.seed(page, segments);
  const n = ok(fixN(db, 'pn1', pairs), '要約の無い議事録の名前を直せない');
  assert.strictEqual(n.result.counts.transcript, 1, JSON.stringify(n.result));
  // 白紙のページ
  const b = blankPage(db, '担当Aに渡す');
  assert.strictEqual(ok(fixN(db, b.id, pairs), '白紙のページ').result.counts.summary, 1);
}));

test('CS-3・F237: 命令: 1回で要約・メモ・発言・担当・「議事録」の参加者が直り、控えは1行（segs は直した発言だけ）・直した発言を指す行の出典が付け直る・タスクの担当は変わらず数・changed の what は names', T, () => withDb((db, t) => {
  const { page, segments } = samplePage('pm1');
  for (const b of page.blocks) b.id = `pm1${b.id}`;
  page.memo = '担当Aに確認する';
  page.memoDoc = MD.memoFromText(page.memo);
  page.blocks.push({ id: 'pm1b7', type: 'bullet', text: '見積書は月末までに先方へ送る', cites: [] });   // 根拠なしの要点（直した後に照らし直す）
  t.seed(page, segments);
  ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather');
  const mdb = db.prepare("select id, attrs from blocks where type = 'page' and instr(attrs, '\"minutes\"') > 0").get();
  const people = JSON.parse(mdb.attrs).cols.find((c) => c.type === 'person').id;
  ok(call(db, 'row.setCell', { db: mdb.id, id: 'pm1', col: people, value: ['担当A', '担当C'] }), '参加者');
  const task = ok(call(db, 'todo.toTask', { pageId: 'pm1', blockId: 'pm1b4' }), 'todo.toTask').result.id;
  const taskBefore = JSON.parse(db.prepare('select attrs from blocks where id = ?').get(task).attrs).cells;
  const before = C.readPage(db, 'pm1');
  const r = ok(fixN(db, 'pm1', [{ from: '担当A', to: '担当B' }]), 'mcp.fixNames');
  assert.deepStrictEqual(r.changed, { pageIds: ['pm1'], actor: 'claude', what: 'names' });
  assert.deepStrictEqual(r.result, { title: before.title, counts: { summary: 1, memo: 1, transcript: 1, assignee: 1, people: 1, title: 0, crossed: 0, tasks: 1 } });
  const p = C.readPage(db, 'pm1');
  assert.strictEqual(p.blocks.find((b) => b.id === 'pm1b2').text, '来月の予算案の作成を担当Bが進める');
  assert.strictEqual(p.blocks.find((b) => b.id === 'pm1b4').assignee, '担当B');
  assert.deepStrictEqual([p.memo, p.memoDoc[0].text], ['担当Bに確認する\n', '担当Bに確認する']);
  assert.deepStrictEqual(p.cells[people], ['担当B', '担当C']);
  assert.strictEqual(p.title, before.title);
  const segs = C.readSegments(db, 'pm1');
  assert.strictEqual(segs.find((s) => s.id === 's2').text, '来月の予算案の作成は担当Bさんが進めることにしました');
  assert.deepStrictEqual(JSON.parse(db.prepare('select attrs from blocks where id = ?').get(task).attrs).cells, taskBefore, 'タスクの担当を直した');
  // 出典: 直した発言を指す行は付け直り、根拠なしの要点も照らし直す（segment.update の recite と同じ）
  assert.deepStrictEqual(p.blocks.find((b) => b.id === 'pm1b2').cites, ['s2']);
  assert.deepStrictEqual(p.blocks.find((b) => b.id === 'pm1b7').cites, ['s3'], '直した後に出典を照らし直していない');
  // 控えは1行・segs は直した発言だけ（書く前の文）
  const snaps = snapRows(db, 'pm1');
  assert.deepStrictEqual(snaps.map((s) => s.what), ['names']);
  assert.deepStrictEqual(JSON.parse(snaps[0].body).segs, [{ id: 's2', text: '来月の予算案の作成は担当Aさんが進めることにしました' }]);
}));

test('CS-3・F237: 当たりが無ければ操作の空の行だけで、rev・更新の時刻・控えは変わらない。録音中の写し・ゴミ箱・無いページは not-found・データベースは bad-args・形の違う組は bad-args', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const raw = () => C.readRawPage(db, id);
  const was = raw();
  const r = ok(fixN(db, id, [{ from: '該当なし', to: '担当B' }]), 'mcp.fixNames');
  assert.deepStrictEqual(r.result.counts, { summary: 0, memo: 0, transcript: 0, assignee: 0, people: 0, title: 0, crossed: 0, tasks: 0 });
  assert.strictEqual(r.changed, undefined);
  assert.deepStrictEqual([raw().rev, raw().updatedAt], [was.rev, was.updatedAt]);
  assert.deepStrictEqual(snapRows(db, id), []);
  assert.deepStrictEqual(oplogOf(db, r.tx), { actor: 'claude', action: 'mcp.fixNames', page_id: id });
  assert.strictEqual(db.prepare('select ops from oplog where tx = ?').get(r.tx).ops, '[]');
  for (const pairs of [[{ from: '担', to: '担当B' }], [{ from: '担当A', to: '' }], []]) {
    const b = fixN(db, id, pairs);
    assert.deepStrictEqual([b.ok, b.code], [false, 'bad-args'], JSON.stringify(pairs));
  }
  const { page: lp, segments: ls } = samplePage('pl1');
  for (const b of lp.blocks) b.id = `pl1${b.id}`;
  lp.meeting = { phase: 'recording' };
  t.seed(lp, ls);
  const live = fixN(db, 'pl1', [{ from: '担当A', to: '担当B' }]);
  assert.deepStrictEqual([live.ok, live.code], [false, 'not-found'], '録音中の写しを直した');
  assert.strictEqual(C.readSegments(db, 'pl1').find((s) => s.id === 's2').text, ls[1].text);
  const d = ok(call(db, 'db.create', {}), 'db.create').result.id;
  assert.deepStrictEqual(((x) => [x.ok, x.code])(fixN(db, d, [{ from: '担当A', to: '担当B' }])), [false, 'bad-args']);
  ok(call(db, 'page.delete', { id }), 'page.delete');
  assert.deepStrictEqual(((x) => [x.ok, x.code])(fixN(db, id, [{ from: '担当A', to: '担当B' }])), [false, 'not-found']);
  assert.deepStrictEqual(((x) => [x.ok, x.code])(fixN(db, 'pnone1', [{ from: '担当A', to: '担当B' }])), [false, 'not-found']);
}));

test('CS-3・F237: 白紙のページと行のページは本文と ToDo の担当だけを直す（題名は数だけ）。控えは1行', T, () => withDb((db) => {
  const { id, blockId } = blankPage(db, '担当Aがまとめる');
  ok(call(db, 'page.setTitle', { id, title: '担当Aのメモ' }), 'page.setTitle');   // 白紙のページの題名（利用者が付け直した題名と同じ扱い: D77）
  const todo = ok(call(db, 'block.insert', { pageId: id, afterBlockId: blockId, type: 'todo' }), 'block.insert').result.blockId;
  ok(call(db, 'block.update', { pageId: id, blockId: todo, patch: { text: '資料を配る' } }), 'block.update');
  ok(call(db, 'block.setAction', { pageId: id, blockId: todo, assignee: '担当A' }), 'block.setAction');
  const r = ok(fixN(db, id, [{ from: '担当A', to: '担当B' }]), 'mcp.fixNames(白紙)');
  assert.deepStrictEqual(r.result.counts, { summary: 1, memo: 0, transcript: 0, assignee: 1, people: 0, title: 1, crossed: 0, tasks: 0 });
  const p = C.readPage(db, id);
  assert.deepStrictEqual([p.title, p.blocks[0].text, p.blocks[1].assignee], ['担当Aのメモ', '担当Bがまとめる', '担当B']);
  assert.strictEqual(snapRows(db, id).length, 1);
  const { row } = dbWithRow(db);
  const w = ok(fixN(db, row, [{ from: '本文', to: '中身' }]), 'mcp.fixNames(行)');
  assert.deepStrictEqual(w.result.counts.summary, 1);
  assert.strictEqual(C.readPage(db, row).blocks[0].text, '行の中身');
  assert.deepStrictEqual(snapRows(db, row).map((s) => s.what), ['names']);
}));

test('CS-3: 同じ tx の送り直しは dup で、2回目は何も直さず（控えも oplog も増えない）、答えは題名と counts: null', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const tx = txOf('mcp');
  const a = ok(mcp(db, 'mcp.fixNames', { pageId: id, pairs: [{ from: '担当A', to: '担当B' }] }, {}, tx), '1回目');
  const n = db.prepare('select count(*) c from oplog').get().c;
  const b = mcp(db, 'mcp.fixNames', { pageId: id, pairs: [{ from: '担当B', to: '担当D' }] }, {}, tx);
  assert.deepStrictEqual([b.ok, b.dup, b.result], [true, true, { title: a.result.title, counts: null }]);
  assert.strictEqual(db.prepare('select count(*) c from oplog').get().c, n);
  assert.strictEqual(snapRows(db, id).length, 1);
  assert.ok(!JSON.stringify(C.readPage(db, id)).includes('担当D'), '送り直しで2回目の組を当てた');
}));

// ---------------------------------------------------------------- CT-1（決めたこと 27〜29・F238・D149）: Claude の ToDo の更新 mcp.updateAction と［タスクにする］mcp.makeTask
const act = (db, id, blockId, more, ctx = {}, tx) => mcp(db, 'mcp.updateAction', { pageId: id, blockId, ...more }, ctx, tx);
const cellsOf = (db, id) => JSON.parse(db.prepare('select attrs from blocks where id = ?').get(id).attrs).cells;
const byOf = (db, id) => JSON.parse(db.prepare('select attrs from blocks where id = ?').get(id).attrs).by;

test('CT-1・F238: mcp.updateAction: 済み・担当・期限が変わり控えが1行（what action）・changed の what は action・oplog の actor は claude。ToDo でない行・無い行・何も渡さない・空の担当と期限は bad-args。同じ値は操作の空の行で rev と控えは変わらない', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const before = C.readPage(db, id);
  const r = ok(act(db, id, 'pm1b4', { done: true, assignee: ' 担当B ', dueRaw: '11/30' }), 'mcp.updateAction');
  assert.deepStrictEqual(r.changed, { pageIds: [id], actor: 'claude', what: 'action' });
  assert.deepStrictEqual(oplogOf(db, r.tx), { actor: 'claude', action: 'mcp.updateAction', page_id: id });
  assert.deepStrictEqual(r.result, { title: before.title });
  const b = C.readPage(db, id).blocks.find((x) => x.id === 'pm1b4');
  assert.deepStrictEqual([b.checked, b.assignee, b.dueRaw, typeof b.due, b.due.length, b.dueApprox], [true, '担当B', '11/30', 'string', 10, false]);
  assert.strictEqual(b.text, '見積書を月末までに先方へ送る', '文が変わった');
  const snaps = snapRows(db, id);
  assert.deepStrictEqual(snaps.map((s) => [s.what, s.rev_after]), [['action', revOf(db, id)]]);
  const was = JSON.parse(snaps[0].body).blocks.find((x) => x.id === 'pm1b4');
  assert.deepStrictEqual([was.checked, was.assignee, was.dueRaw], [false, '担当A', '月末'], '控えが書く前の ToDo でない');
  // 断る（何も変えない）
  const rev = revOf(db, id);
  for (const [what, more] of [['ToDo でない行', { blockId: 'pm1b2', done: true }], ['見出し', { blockId: 'pm1b1', assignee: '担当B' }], ['無い行', { blockId: 'pm1bx', done: true }],
    ['何も渡さない', { blockId: 'pm1b4' }], ['空の担当', { blockId: 'pm1b4', assignee: '  ' }], ['空の期限', { blockId: 'pm1b4', dueRaw: '' }]]) {
    const x = mcp(db, 'mcp.updateAction', { pageId: id, ...more });
    assert.deepStrictEqual([x.ok, x.code], [false, 'bad-args'], what);
  }
  assert.strictEqual(C.readPage(db, id).blocks.find((x) => x.id === 'pm1b2').assignee, undefined, 'ToDo でない行に担当が付いた');
  assert.strictEqual(revOf(db, id), rev);
  // 同じ値: 操作の空の行だけ（rev・更新の時刻・控えは変わらない）
  const raw = C.readRawPage(db, id);
  const same = ok(act(db, id, 'pm1b4', { done: true, assignee: '担当B' }), '同じ値');
  assert.strictEqual(same.changed, undefined);
  assert.strictEqual(db.prepare('select ops from oplog where tx = ?').get(same.tx).ops, '[]');
  assert.deepStrictEqual([C.readRawPage(db, id).rev, C.readRawPage(db, id).updatedAt], [raw.rev, raw.updatedAt]);
  assert.strictEqual(snapRows(db, id).length, 1);
}));

test('CT-1・F238: mcp.updateAction の要約の欄の鍵: making・要約待ちは locked で何も変えない（外れたら書ける）。録音中の写し・ゴミ箱・無いページは not-found（CR58 と同じ）・データベースは bad-args。白紙のページと行のページの本文の ToDo も書け、行の最終更新者は Claude', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const rev = revOf(db, id);
  const m = act(db, id, 'pm1b4', { done: true }, { making: new Set([id]) });
  assert.deepStrictEqual([m.ok, m.code], [false, 'locked'], 'making のページの ToDo を書いた');
  assert.strictEqual(revOf(db, id), rev);
  assert.deepStrictEqual(snapRows(db, id), []);
  ok(act(db, id, 'pm1b4', { done: true }, { making: new Set(['pother']) }), 'ほかのページの making は鍵にならない');
  const { page: wp, segments: ws } = samplePage('pw1');
  for (const b of wp.blocks) b.id = `pw1${b.id}`;
  wp.summaryWait = true;
  t.seed(wp, ws);
  const w = act(db, 'pw1', 'pw1b4', { done: true });
  assert.deepStrictEqual([w.ok, w.code], [false, 'locked'], '要約待ちのページの ToDo を書いた');
  assert.strictEqual(C.readPage(db, 'pw1').blocks.find((b) => b.id === 'pw1b4').checked, false);
  const { page: lp, segments: ls } = samplePage('pl1');
  for (const b of lp.blocks) b.id = `pl1${b.id}`;
  lp.meeting = { phase: 'recording' };
  t.seed(lp, ls);
  const live = act(db, 'pl1', 'pl1b4', { done: true });
  assert.deepStrictEqual([live.ok, live.code], [false, 'not-found'], '録音中の写しの ToDo を書いた');
  const d = ok(call(db, 'db.create', {}), 'db.create').result.id;
  assert.deepStrictEqual(((x) => [x.ok, x.code])(act(db, d, 'pm1b4', { done: true })), [false, 'bad-args']);
  assert.deepStrictEqual(((x) => [x.ok, x.code])(act(db, 'pnone1', 'pm1b4', { done: true })), [false, 'not-found']);
  // 白紙のページの本文の ToDo
  const { id: blank, blockId } = blankPage(db);
  const todo = ok(call(db, 'block.insert', { pageId: blank, afterBlockId: blockId, type: 'todo' }), 'block.insert').result.blockId;
  ok(call(db, 'block.update', { pageId: blank, blockId: todo, patch: { text: '資料を配る' } }), 'block.update');
  ok(act(db, blank, todo, { assignee: '担当B', done: true }), 'mcp.updateAction(白紙)');
  assert.deepStrictEqual(((b) => [b.assignee, b.checked])(C.readPage(db, blank).blocks.find((b) => b.id === todo)), ['担当B', true]);
  assert.deepStrictEqual(snapRows(db, blank).map((s) => s.what), ['action']);
  // データベースの行のページの本文の ToDo（最終更新者は Claude）
  const { row, blockId: rb } = dbWithRow(db);
  const rt = ok(call(db, 'block.insert', { pageId: row, afterBlockId: rb, type: 'todo' }), 'block.insert(行)').result.blockId;
  ok(call(db, 'block.update', { pageId: row, blockId: rt, patch: { text: '行の ToDo' } }), 'block.update(行)');
  assert.notStrictEqual(byOf(db, row).u, 'claude');
  ok(act(db, row, rt, { dueRaw: '12/1' }), 'mcp.updateAction(行)');
  assert.strictEqual(C.readPage(db, row).blocks.find((b) => b.id === rt).dueRaw, '12/1');
  assert.strictEqual(byOf(db, row).u, 'claude', '行の最終更新者が Claude でない');
  assert.deepStrictEqual(snapRows(db, row).map((s) => s.what), ['action']);
  // ゴミ箱
  ok(call(db, 'page.delete', { id }), 'page.delete');
  assert.deepStrictEqual(((x) => [x.ok, x.code])(act(db, id, 'pm1b6', { done: true })), [false, 'not-found']);
}));

test('CT-1・F238・D149: ToDo を済みにしても、その ToDo から作ったタスクのステータスは変わらない。答えにタスクの ID（ゴミ箱のタスクは書かない）', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const task = ok(call(db, 'todo.toTask', { pageId: id, blockId: 'pm1b4' }), 'todo.toTask').result.id;
  const cells = cellsOf(db, task);
  const r = ok(act(db, id, 'pm1b4', { done: true }), 'mcp.updateAction');
  assert.deepStrictEqual(r.result, { title: C.readPage(db, id).title, task });
  assert.strictEqual(C.readPage(db, id).blocks.find((b) => b.id === 'pm1b4').checked, true);
  assert.deepStrictEqual(cellsOf(db, task), cells, 'タスクのステータスが変わった（D149）');
  ok(act(db, id, 'pm1b4', { done: false }), '済みを外す');
  assert.deepStrictEqual(cellsOf(db, task), cells, 'タスクのステータスが変わった（D149）');
  const d = db.prepare('select parent_id from blocks where id = ?').get(task).parent_id;
  ok(call(db, 'rows.trash', { db: d, ids: [task] }), 'rows.trash');
  assert.deepStrictEqual(ok(act(db, id, 'pm1b4', { done: true }), 'ゴミ箱のタスク').result, { title: C.readPage(db, id).title });
}));

test('CT-1・F238: mcp.makeTask: ［タスクにする］（todo.toTask）と同じ行ができる（ステータス・担当・期限・「議事録」）・作成者と最終更新者は Claude・2回目は同じ行の ID で何もしない（made 偽・控えは増えない）・控えは ToDo のページの1行（what task。戻すと印だけ外れ行は残る）', T, () => withDb((db, t) => {
  const a = meetingPage(t, 'pm1');
  const b = meetingPage(t, 'pm2');
  ok(call(db, 'block.setAction', { pageId: 'pm1', blockId: 'pm1b6', dueRaw: '12/1' }), '期限（推し量らない）');
  ok(call(db, 'block.setAction', { pageId: 'pm2', blockId: 'pm2b6', dueRaw: '12/1' }), '期限（推し量らない）');
  ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather');
  const r = ok(mcp(db, 'mcp.makeTask', { pageId: a, blockId: 'pm1b6' }), 'mcp.makeTask');
  const tdb = db.prepare("select id from blocks where type = 'page' and instr(attrs, '\"tasks\"') > 0").get().id;
  assert.deepStrictEqual(r.result, { id: r.result.id, db: tdb, made: true });
  assert.strictEqual(r.changed.what, 'task');
  assert.deepStrictEqual([r.changed.actor, r.changed.pageIds.includes(a), r.changed.pageIds.includes(r.result.id)], ['claude', true, true]);
  assert.deepStrictEqual(oplogOf(db, r.tx), { actor: 'claude', action: 'mcp.makeTask', page_id: a });
  const u = ok(call(db, 'todo.toTask', { pageId: b, blockId: 'pm2b6' }), 'todo.toTask').result.id;
  const mine = cellsOf(db, r.result.id);
  const theirs = cellsOf(db, u);
  const dbAttrs = JSON.parse(db.prepare('select attrs from blocks where id = ?').get(tdb).attrs);
  const relCol = dbAttrs.cols.find((c) => c.type === 'rel').id;
  assert.deepStrictEqual([mine[relCol], theirs[relCol]], [[a], [b]], '「議事録」のリレーション');
  assert.deepStrictEqual({ ...mine, [relCol]: null }, { ...theirs, [relCol]: null }, '［タスクにする］と違う行');
  assert.strictEqual(Object.keys(mine).length, 4, `ステータス・担当・期限・議事録: ${JSON.stringify(mine)}`);
  assert.deepStrictEqual(byOf(db, r.result.id), { c: 'claude', u: 'claude' }, '作成者が Claude でない');
  assert.deepStrictEqual(byOf(db, u), { c: 'me', u: 'me' });
  assert.strictEqual(C.readPage(db, a).blocks.find((x) => x.id === 'pm1b6').task, r.result.id);
  assert.deepStrictEqual(snapRows(db, a).map((s) => s.what), ['task']);
  assert.strictEqual(JSON.parse(snapRows(db, a)[0].body).blocks.find((x) => x.id === 'pm1b6').task, undefined, '控えが印の前でない');
  // 2回目: 同じ行の ID で何もしない（made 偽・控えも oplog の操作も増えない）
  const rows = db.prepare("select count(*) c from blocks where type = 'row'").get().c;
  const again = ok(mcp(db, 'mcp.makeTask', { pageId: a, blockId: 'pm1b6' }), '2回目');
  assert.deepStrictEqual([again.result, again.changed], [{ id: r.result.id, db: tdb, made: false }, undefined]);
  assert.strictEqual(db.prepare("select count(*) c from blocks where type = 'row'").get().c, rows, '2つ目のタスクができた');
  assert.strictEqual(snapRows(db, a).length, 1);
  // 戻すと印だけ外れ、行は残る（CR13）
  ok(call(db, 'page.claudeRevert', { id: a, sid: snapRows(db, a)[0].rid }), 'page.claudeRevert');
  assert.strictEqual(C.readPage(db, a).blocks.find((x) => x.id === 'pm1b6').task, undefined);
  assert.strictEqual(db.prepare('select trashed_at from blocks where id = ?').get(r.result.id).trashed_at, null, '作った行がゴミ箱へ入った');
}));

test('CT-1・F238: mcp.makeTask は ToDo でない行は bad-args、making・要約待ちは locked、録音中の写し・ゴミ箱・無いページは not-found で何も作らない。行のページの ToDo からも作れ、「タスク管理」が無ければ作る', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const rowsN = () => db.prepare("select count(*) c from blocks where type = 'row'").get().c;
  const n0 = rowsN();
  const code = (x) => [x.ok, x.code];
  assert.deepStrictEqual(code(mcp(db, 'mcp.makeTask', { pageId: id, blockId: 'pm1b2' })), [false, 'bad-args']);
  assert.deepStrictEqual(code(mcp(db, 'mcp.makeTask', { pageId: id, blockId: 'pm1b4' }, { making: new Set([id]) })), [false, 'locked']);
  const { page: wp, segments: ws } = samplePage('pw1');
  for (const b of wp.blocks) b.id = `pw1${b.id}`;
  wp.summaryWait = true;
  t.seed(wp, ws);
  assert.deepStrictEqual(code(mcp(db, 'mcp.makeTask', { pageId: 'pw1', blockId: 'pw1b4' })), [false, 'locked']);
  const { page: lp, segments: ls } = samplePage('pl1');
  for (const b of lp.blocks) b.id = `pl1${b.id}`;
  lp.meeting = { phase: 'recording' };
  t.seed(lp, ls);
  assert.deepStrictEqual(code(mcp(db, 'mcp.makeTask', { pageId: 'pl1', blockId: 'pl1b4' })), [false, 'not-found']);
  assert.deepStrictEqual(code(mcp(db, 'mcp.makeTask', { pageId: 'pnone1', blockId: 'pl1b4' })), [false, 'not-found']);
  assert.strictEqual(rowsN(), n0, '断ったのに行ができた');
  assert.deepStrictEqual([snapRows(db, id), snapRows(db, 'pw1')], [[], []]);
  const { row, blockId: rb } = dbWithRow(db);
  const rt = ok(call(db, 'block.insert', { pageId: row, afterBlockId: rb, type: 'todo' }), 'block.insert(行)').result.blockId;
  ok(call(db, 'block.update', { pageId: row, blockId: rt, patch: { text: '行の ToDo' } }), 'block.update(行)');
  const tasksN = () => db.prepare("select count(*) c from blocks where type = 'page' and instr(attrs, '\"tasks\"') > 0").get().c;
  assert.strictEqual(tasksN(), 0, '「タスク管理」が初めからある');
  const r = ok(mcp(db, 'mcp.makeTask', { pageId: row, blockId: rt }), 'mcp.makeTask(行)');
  assert.strictEqual(tasksN(), 1, '「タスク管理」が無いときに作らない');
  assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get(r.result.id).parent_id, r.result.db);
  assert.strictEqual(C.readPage(db, row).blocks.find((b) => b.id === rt).task, r.result.id);
  assert.deepStrictEqual(snapRows(db, row).map((s) => s.what), ['task']);
  ok(call(db, 'page.delete', { id }), 'page.delete');
  assert.deepStrictEqual(code(mcp(db, 'mcp.makeTask', { pageId: id, blockId: 'pm1b6' })), [false, 'not-found']);
}));

test('CT-1: 同じ tx の送り直しは dup で、2回目は控えも oplog も増えない（mcp.updateAction・mcp.makeTask）', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const tx1 = txOf('mcp');
  const a = ok(act(db, id, 'pm1b4', { done: true }, {}, tx1), '1回目');
  const n = db.prepare('select count(*) c from oplog').get().c;
  const b = act(db, id, 'pm1b4', { done: false }, {}, tx1);
  assert.deepStrictEqual([b.ok, b.dup, b.result], [true, true, a.result]);
  assert.strictEqual(C.readPage(db, id).blocks.find((x) => x.id === 'pm1b4').checked, true, '送り直しで2回目を当てた');
  const tx2 = txOf('mcp');
  const c = ok(mcp(db, 'mcp.makeTask', { pageId: id, blockId: 'pm1b6' }, {}, tx2), '1回目');
  const d = mcp(db, 'mcp.makeTask', { pageId: id, blockId: 'pm1b6' }, {}, tx2);
  assert.deepStrictEqual([d.ok, d.dup, d.result], [true, true, c.result]);
  assert.strictEqual(db.prepare('select count(*) c from oplog').get().c, n + 1);
  assert.deepStrictEqual(snapRows(db, id).map((s) => s.what), ['action', 'task']);
}));

// ---------------------------------------------------------------- CT-2（決めたこと 30〜33・F239・F243）: Claude の白紙のページを作る mcp.createPage・書き足す mcp.appendPage
const bodyRowsOf = (db, id) => db.prepare('select id, parent_id, ord, type, text from blocks where page_id = ? and id <> ? order by ord').all(id, id).map((r) => ({ ...r }));
const pagesN = (db) => db.prepare("select count(*) c from blocks where type = 'page'").get().c;
const NEW_MD = '# 次回の議題\n- 予算の **確認**\n- [ ] 資料を配る\n本文の段落';

test('CT-2・F239・F243: mcp.createPage: 白紙のページ（kind blank）が本文つきでできる（飾りは落ち、出典は付かない）・oplog は1行（actor claude）・控えは無い・changed の what は create。白紙の親なら本文の最後に子ページの行。データベース・行・議事録・「議事録」・録音中の写し・ゴミ箱・無い親は bad-args・題名の改行・U+202E・201 字・空は bad-args・本文の 2,001 行は too-big', T, () => withDb((db, t) => {
  const r = ok(mcp(db, 'mcp.createPage', { title: '次回の議題（見本）', md: NEW_MD }), 'mcp.createPage');   // D77: 白紙のページ・テンプレートの題名（会議の題名でない）
  const id = r.result.id;
  assert.deepStrictEqual(r.result, { id, title: '次回の議題（見本）', rows: 4 });   // D77: 白紙のページ・テンプレートの題名（会議の題名でない）
  assert.deepStrictEqual(r.changed, { pageIds: [id], actor: 'claude', what: 'create' });
  assert.deepStrictEqual(oplogOf(db, r.tx), { actor: 'claude', action: 'mcp.createPage', page_id: null });
  assert.strictEqual(db.prepare('select count(*) c from oplog where tx = ?').get(r.tx).c, 1);
  const p = C.readPage(db, id);
  assert.deepStrictEqual([p.kind, p.title, db.prepare('select parent_id from blocks where id = ?').get(id).parent_id], ['blank', '次回の議題（見本）', null]);
  assert.deepStrictEqual(p.blocks.map((b) => `${b.type}:${b.text}`), ['heading:次回の議題', 'bullet:予算の 確認', 'todo:資料を配る', 'paragraph:本文の段落']);
  assert.ok(p.blocks.every((b) => Array.isArray(b.cites) && b.cites.length === 0 && !b.rich), '出典か飾りが付いた');
  assert.deepStrictEqual(snapRows(db, id), []);
  assert.ok(ok(call(db, 'pages.list', {}), 'pages.list').result.some((e) => e.id === id), '一覧に出ない');
  // 白紙の親: 本文の最後に子ページの行（0.15.0 の F123 と同じ形）
  const { id: host } = blankPage(db);
  const c = ok(mcp(db, 'mcp.createPage', { title: '中のページ', md: '- 一行', parentId: host }), 'mcp.createPage(中)');   // D77: 白紙のページ・テンプレートの題名（会議の題名でない）
  assert.deepStrictEqual(c.changed.pageIds.slice().sort(), [c.result.id, host].sort());
  assert.strictEqual(db.prepare('select parent_id from blocks where id = ?').get(c.result.id).parent_id, host);
  const hb = C.readPage(db, host).blocks;
  assert.deepStrictEqual([hb.length, hb[hb.length - 1].type, hb[hb.length - 1].page], [2, 'subpage', c.result.id], '親の本文の最後に子ページの行が無い');
  assert.deepStrictEqual(snapRows(db, host), [], '親の控えを作った');
  // 断る親（何も作らない）
  const mid = meetingPage(t);
  const { d, row } = dbWithRow(db);
  ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather');
  const mdb = db.prepare("select id from blocks where type = 'page' and instr(attrs, '\"minutes\"') > 0").get().id;
  const { page: lp, segments: ls } = samplePage('pl1');
  for (const b of lp.blocks) b.id = `pl1${b.id}`;
  lp.meeting = { phase: 'recording' };
  t.seed(lp, ls);
  const { id: gone } = blankPage(db);
  ok(call(db, 'page.delete', { id: gone }), 'page.delete');
  const n0 = pagesN(db);
  for (const [what, parentId] of [['データベース', d], ['行', row], ['議事録', mid], ['「議事録」', mdb], ['録音中の写し', 'pl1'], ['ゴミ箱', gone], ['無い', 'pnone1']]) {
    const x = mcp(db, 'mcp.createPage', { title: '中のページ', md: '- 一行', parentId });   // D77: 白紙のページ・テンプレートの題名（会議の題名でない）
    assert.deepStrictEqual([x.ok, x.code], [false, 'bad-args'], what);
  }
  for (const [what, title] of [['改行', '題\n名'], ['U+202E', '題‮名'], ['U+2028', '題 名'], ['制御の文字', '題\u0007名'], ['201 字', 'あ'.repeat(201)], ['空', ''], ['空白だけ', '  ']]) {
    const x = mcp(db, 'mcp.createPage', { title, md: '- 一行' });
    assert.deepStrictEqual([x.ok, x.code], [false, 'bad-args'], what);
  }
  const big = mcp(db, 'mcp.createPage', { title: '長い', md: Array.from({ length: 2001 }, (_, i) => `- 行${i}`).join('\n') });   // D77: 白紙のページ・テンプレートの題名（会議の題名でない）
  assert.deepStrictEqual([big.ok, big.code], [false, 'too-big']);
  assert.strictEqual(pagesN(db), n0, '断ったのにページができた');
  ok(mcp(db, 'mcp.createPage', { title: 'あ'.repeat(200), md: '- 一行' }), '200 字の題名');   // D77: 白紙のページ・テンプレートの題名（会議の題名でない）
}));

test('CT-2・F239: mcp.appendPage: 白紙のページと行のページの本文の最上位の最後に足され、前からある行の id・ord・文は1つも変わらない・控えが1行（what append）・changed の what は append・行の最終更新者は Claude。議事録・データベースは bad-args・テンプレートの行・ゴミ箱は not-found・ロック中のデータベースの行には書ける・満杯は too-big・行の無い Markdown は操作の空の行', T, () => withDb((db, t) => {
  const { id, blockId } = blankPage(db);
  const k = ok(call(db, 'block.insert', { pageId: id, afterBlockId: blockId, type: 'bullet' }), 'block.insert').result.blockId;
  ok(call(db, 'block.update', { pageId: id, blockId: k, patch: { text: '前からある箇条' } }), 'block.update');
  ok(call(db, 'block.indent', { pageId: id, blockId: k, dir: 'in' }), 'block.indent');   // 子の行（最上位の最後に足すとき、子の中に入れない）
  const before = bodyRowsOf(db, id);
  const r = ok(mcp(db, 'mcp.appendPage', { pageId: id, md: '- 足した1\n- [ ] 足した2' }), 'mcp.appendPage');
  assert.deepStrictEqual(r.result, { title: '', rows: 2 });
  assert.deepStrictEqual(r.changed, { pageIds: [id], actor: 'claude', what: 'append' });
  assert.deepStrictEqual(oplogOf(db, r.tx), { actor: 'claude', action: 'mcp.appendPage', page_id: id });
  const after = bodyRowsOf(db, id);
  assert.deepStrictEqual(after.filter((x) => before.some((y) => y.id === x.id)), before, '前からある行が変わった・動いた');
  const p = C.readPage(db, id);
  assert.deepStrictEqual(p.blocks.map((b) => `${b.type}:${b.text}`), ['paragraph:白紙の本文の一行', 'bullet:足した1', 'todo:足した2'], '最上位の最後でない');
  assert.deepStrictEqual(p.blocks[0].children.map((b) => b.text), ['前からある箇条']);
  assert.deepStrictEqual(snapRows(db, id).map((s) => [s.what, s.rev_after]), [['append', revOf(db, id)]]);
  // 行のページ（ロック中のデータベースの行も）
  const { d, row } = dbWithRow(db);
  ok(call(db, 'db.setLock', { db: d, on: true }), 'db.setLock');
  ok(mcp(db, 'mcp.appendPage', { pageId: row, md: '本文に足す' }), 'mcp.appendPage(ロック中の行)');
  assert.deepStrictEqual(C.readPage(db, row).blocks.map((b) => b.text), ['行の本文', '本文に足す']);
  assert.strictEqual(byOf(db, row).u, 'claude', '行の最終更新者が Claude でない');
  assert.deepStrictEqual(snapRows(db, row).map((s) => s.what), ['append']);
  ok(call(db, 'db.setLock', { db: d, on: false }), 'db.setLock(外す)');
  // 断る
  const mid = meetingPage(t);
  const tpl = ok(call(db, 'tpl.add', { db: d, title: 'テンプレートの見本' }), 'tpl.add').result.id;   // D77: 白紙のページ・テンプレートの題名（会議の題名でない）
  const code = (x) => [x.ok, x.code];
  assert.deepStrictEqual(code(mcp(db, 'mcp.appendPage', { pageId: mid, md: '- 足す' })), [false, 'bad-args'], '議事録に書き足した');
  assert.deepStrictEqual(code(mcp(db, 'mcp.appendPage', { pageId: d, md: '- 足す' })), [false, 'bad-args'], 'データベースに書き足した');
  assert.deepStrictEqual(code(mcp(db, 'mcp.appendPage', { pageId: tpl, md: '- 足す' })), [false, 'not-found'], 'テンプレートの行に書き足した');
  assert.deepStrictEqual(code(mcp(db, 'mcp.appendPage', { pageId: 'pnone1', md: '- 足す' })), [false, 'not-found']);
  assert.deepStrictEqual([snapRows(db, mid), snapRows(db, tpl)], [[], []]);
  assert.strictEqual(C.readPage(db, mid).blocks.length, 6);
  // 行の無い Markdown: 操作の空の行だけ（rev・控えは変わらない）
  const rev = revOf(db, id);
  const empty = ok(mcp(db, 'mcp.appendPage', { pageId: id, md: '  \n\n ' }), '空');
  assert.deepStrictEqual([empty.result, empty.changed, revOf(db, id), snapRows(db, id).length], [{ title: '', rows: 0 }, undefined, rev, 1]);
  // 満杯（本文の 2,000 行）
  const full = ok(mcp(db, 'mcp.createPage', { title: '満杯', md: Array.from({ length: 2000 }, (_, i) => `- 行${i}`).join('\n') }), '2,000 行').result.id;   // D77: 白紙のページ・テンプレートの題名（会議の題名でない）
  assert.deepStrictEqual(code(mcp(db, 'mcp.appendPage', { pageId: full, md: '- もう1行' })), [false, 'too-big']);
  assert.deepStrictEqual(snapRows(db, full), []);
  // ゴミ箱
  ok(call(db, 'page.delete', { id }), 'page.delete');
  assert.deepStrictEqual(code(mcp(db, 'mcp.appendPage', { pageId: id, md: '- 足す' })), [false, 'not-found']);
}));

test('CT-2: 同じ tx の送り直しは dup で、2回目はページも行も控えも増えず、答えは同じ形（mcp.createPage・mcp.appendPage）', T, () => withDb((db) => {
  const tx1 = txOf('mcp');
  const a = ok(mcp(db, 'mcp.createPage', { title: '次回の議題（見本）', md: NEW_MD }, {}, tx1), '1回目');   // D77: 白紙のページ・テンプレートの題名（会議の題名でない）
  const n = pagesN(db);
  const b = mcp(db, 'mcp.createPage', { title: '次回の議題（見本）', md: NEW_MD }, {}, tx1);   // D77: 白紙のページ・テンプレートの題名（会議の題名でない）
  assert.deepStrictEqual([b.ok, b.dup, b.result], [true, true, a.result]);
  assert.strictEqual(pagesN(db), n);
  const tx2 = txOf('mcp');
  const c = ok(mcp(db, 'mcp.appendPage', { pageId: a.result.id, md: '- 足す' }, {}, tx2), '1回目');
  const d = mcp(db, 'mcp.appendPage', { pageId: a.result.id, md: '- 足す' }, {}, tx2);
  assert.deepStrictEqual([d.ok, d.dup, d.result], [true, true, c.result]);
  assert.strictEqual(C.readPage(db, a.result.id).blocks.length, 5);
  assert.strictEqual(snapRows(db, a.result.id).length, 1);
}));

// ---------------------------------------------------------------- CT-3（決めたこと 35〜38・F241）: Claude の行の追加 mcp.addRow と行の直し mcp.updateRow
const ops180 = require('../src/db/ops');
const colOf = (db, d, type, name, more = {}) => ok(call(db, 'col.add', { db: d, type, name, ...more }), `col.add ${type}`).result.col.id;
const rowCount = (db, d) => db.prepare("select count(*) c from blocks where type = 'row' and parent_id = ? and trashed_at is null").get(d).c;
// データベース（題名「案件」）と列（メモ・区分（社内・社外）・担当・期限・金額・作成日時・関連（相手のデータベースへの両側のリレーション））と、相手のデータベースの行 2 つ
function rowDb(db) {
  const d = ok(call(db, 'db.create', {}), 'db.create').result.id;
  ok(call(db, 'db.setTitle', { db: d, title: '案件' }), 'db.setTitle');   // D77: データベースの題名（会議の題名でない）
  const memo = colOf(db, d, 'text', 'メモ');
  const sel = colOf(db, d, 'select', '区分');
  ok(call(db, 'col.setOpts', { db: d, col: sel, opts: [{ id: 'o1', name: '社内', color: 'default' }, { id: 'o2', name: '社外', color: 'blue' }] }), 'col.setOpts');
  const who = colOf(db, d, 'person', '担当');
  const due = colOf(db, d, 'date', '期限');
  const num = colOf(db, d, 'number', '金額');
  const ctime = colOf(db, d, 'ctime', '作成日時');
  const d2 = ok(call(db, 'db.create', {}), 'db.create(相手)').result.id;
  const ra = ok(call(db, 'row.add', { db: d2, title: '相手の行A' }), 'row.add').result.id;   // D77: データベースの行の題名
  const rb = ok(call(db, 'row.add', { db: d2, title: '相手の行B' }), 'row.add').result.id;   // D77: データベースの行の題名
  const rel = colOf(db, d, 'rel', '関連', { target: d2, both: true });
  const back = JSON.parse(db.prepare('select attrs from blocks where id = ?').get(d).attrs).cols.find((c) => c.id === rel).back;
  return { d, memo, sel, who, due, num, ctime, d2, ra, rb, rel, back };
}
const addRow = (db, args, ctx, tx) => mcp(db, 'mcp.addRow', args, ctx, tx);

test('CT-3・F241: mcp.addRow: 題名とセル（名前で渡す）と本文の行が1つの命令（oplog の1行・actor claude）で入る・作成者と最終更新者は Claude・リレーションの相手の対の列も・テンプレートは当てない・控えは無い・changed の what は addRow。ロック中のデータベースにも足せる', T, () => withDb((db) => {
  const x = rowDb(db);
  // 既定のテンプレート（Claude の行には当てない: CR19）
  const tpl = ok(call(db, 'tpl.add', { db: x.d, title: 'テンプレートの見本' }), 'tpl.add').result.id;   // D77: テンプレートの題名
  ok(call(db, 'block.insert', { pageId: tpl, afterBlockId: '', type: 'paragraph' }), 'block.insert(テンプレート)');
  ok(call(db, 'tpl.setDefault', { db: x.d, id: tpl }), 'tpl.setDefault');
  const r = ok(addRow(db, { db: x.d, title: '見積の行', cells: { メモ: '見積の件', 区分: '社外', 担当: ['担当A'], 期限: '2026-11-30', 金額: 1200, 関連: [x.ra] }, md: '- 本文の一行\n- [ ] 先方に送る' }), 'mcp.addRow');   // D77: データベースの行の題名
  const id = r.result.id;
  assert.deepStrictEqual(r.result, { id, title: '見積の行' });   // D77: データベースの行の題名（会議の題名でない）
  assert.strictEqual(r.changed.what, 'addRow');
  assert.deepStrictEqual([r.changed.actor, r.changed.pageIds.includes(x.d), r.changed.pageIds.includes(id)], ['claude', true, true]);
  assert.deepStrictEqual(oplogOf(db, r.tx), { actor: 'claude', action: 'mcp.addRow', page_id: x.d });
  assert.strictEqual(db.prepare('select count(*) c from oplog where tx = ?').get(r.tx).c, 1);
  assert.deepStrictEqual(cellsOf(db, id), { [x.memo]: '見積の件', [x.sel]: 'o2', [x.who]: ['担当A'], [x.due]: { start: '2026-11-30' }, [x.num]: 1200, [x.rel]: [x.ra] });
  assert.deepStrictEqual(cellsOf(db, x.ra)[x.back], [id], 'リレーションの相手の対の列が無い');
  assert.deepStrictEqual(byOf(db, id), { c: 'claude', u: 'claude' }, '作成者が Claude でない');
  assert.deepStrictEqual(C.readPage(db, id).blocks.map((b) => `${b.type}:${b.text}`), ['bullet:本文の一行', 'todo:先方に送る'], 'テンプレートの本文が混ざった');
  assert.strictEqual(db.prepare('select text from blocks where id = ?').get(id).text, '見積の行');
  assert.deepStrictEqual(snapRows(db, id), []);
  // 本文もセルも無い行・ロック中のデータベース（D152: 行を足すのはロック中もできる）
  ok(call(db, 'db.setLock', { db: x.d, on: true }), 'db.setLock');
  const bare = ok(addRow(db, { db: x.d, title: '題名だけ' }), 'mcp.addRow(ロック中)').result.id;   // D77: データベースの行の題名
  assert.deepStrictEqual([cellsOf(db, bare), C.readPage(db, bare).blocks], [{}, []]);
  // 同じ tx の送り直し: 行は1つ
  const tx = txOf('mcp');
  const a1 = ok(addRow(db, { db: x.d, title: '送り直し' }, {}, tx), '1回目');   // D77: データベースの行の題名
  const n = rowCount(db, x.d);
  const a2 = addRow(db, { db: x.d, title: '送り直し' }, {}, tx);   // D77: データベースの行の題名
  assert.deepStrictEqual([a2.ok, a2.dup, a2.result], [true, true, a1.result]);
  assert.strictEqual(rowCount(db, x.d), n);
}));

test('CT-3・F241: mcp.addRow は書けない列（作成日時）・無い選択肢（選択肢は増えない）・無い列・題名の列・形の悪い値・ゴミ箱の相手のリレーション・空や改行の題名を bad-args、「議事録」を bad-args（minutes-row）、無い・ゴミ箱のデータベースを not-found、1 万行で too-big。どれも行を作らない', T, () => withDb((db, t) => {
  const x = rowDb(db);
  const code = (r) => [r.ok, r.code];
  const optsOf = () => JSON.parse(db.prepare('select attrs from blocks where id = ?').get(x.d).attrs).cols.find((c) => c.id === x.sel).opts;
  const opts0 = optsOf();
  ok(call(db, 'rows.trash', { db: x.d2, ids: [x.rb] }), 'rows.trash(相手)');
  const n0 = rowCount(db, x.d);
  for (const [what, args] of [
    ['作成日時', { cells: { 作成日時: '2026-11-01' } }], ['無い選択肢', { cells: { 区分: '社長室' } }], ['無い列', { cells: { 無い列: 'x' } }], ['題名の列', { cells: { 名前: 'x' } }],
    ['形の悪い値', { cells: { 金額: '千円' } }], ['ゴミ箱の相手', { cells: { 関連: [x.rb] } }], ['無い相手', { cells: { 関連: ['rnone1'] } }],
    ['空の題名', { title: '  ' }], ['改行の題名', { title: '題\n名' }], ['U+202E の題名', { title: '題‮名' }],   // D77: データベースの行の題名（会議の題名でない）
  ]) assert.deepStrictEqual(code(addRow(db, { db: x.d, title: '断る行', ...args })), [false, 'bad-args'], what);   // D77: データベースの行の題名
  assert.strictEqual(rowCount(db, x.d), n0, '断ったのに行ができた');
  assert.deepStrictEqual(optsOf(), opts0, '選択肢が増えた');
  // 「議事録」には足せない
  meetingPage(t);
  ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather');
  const mdb = db.prepare("select id from blocks where type = 'page' and instr(attrs, '\"minutes\"') > 0").get().id;
  const kids = () => db.prepare('select count(*) c from blocks where parent_id = ?').get(mdb).c;
  const k0 = kids();
  assert.deepStrictEqual(code(addRow(db, { db: mdb, title: '会議の行' })), [false, 'bad-args'], '「議事録」に行を足した');   // D77: 断る題名（作られない）
  assert.strictEqual(kids(), k0);
  // 無い・ゴミ箱のデータベース
  assert.deepStrictEqual(code(addRow(db, { db: 'pnone1', title: '無い' })), [false, 'not-found']);   // D77: 断る題名
  const gone = ok(call(db, 'db.create', {}), 'db.create').result.id;
  ok(call(db, 'page.delete', { id: gone }), 'page.delete');
  assert.deepStrictEqual(code(addRow(db, { db: gone, title: 'ゴミ箱' })), [false, 'not-found']);   // D77: 断る題名
  // 1 万行（決めたこと 7 の上限）
  const at = new Date(clock).toISOString();
  db.exec('BEGIN');
  applyOps(db, Array.from({ length: 10000 - n0 }, (_, i) => ({ op: 'add', id: `rq${i}`, row: ops180.rowBlock({ id: `rq${i}`, db: x.d, ord: `z${String(i).padStart(5, '0')}`, title: `行 ${i}`, cells: {}, by: { c: 'me', u: 'me' }, no: 100 + i, at }) })));   // D77: データベースの行の題名
  db.exec('COMMIT');
  assert.strictEqual(rowCount(db, x.d), 10000);
  assert.deepStrictEqual(code(addRow(db, { db: x.d, title: '一万一行目' })), [false, 'too-big']);   // D77: 断る題名
  assert.strictEqual(rowCount(db, x.d), 10000);
}));

test('CT-3・F241: mcp.updateRow: 題名とセルが変わり控えが1行（what row。書く直前の題名・セル・本文）・null でセルが空になる・リレーションは渡した並びに（外した相手の対の列も外れる）・最終更新者は Claude・同じ値は書かない。題名は空にできない・読む列・無い選択肢は bad-args・ゴミ箱の行・テンプレートの行・無い行は not-found。ロック中のデータベースの行も直せる', T, () => withDb((db) => {
  const x = rowDb(db);
  const id = ok(addRow(db, { db: x.d, title: '前の題', cells: { メモ: '前のメモ', 期限: '2026-11-30', 関連: [x.ra] }, md: '本文' }), 'mcp.addRow').result.id;   // D77: データベースの行の題名
  ok(call(db, 'row.setCell', { db: x.d, id, col: x.memo, value: '自分が直したメモ' }), 'row.setCell');
  assert.strictEqual(byOf(db, id).u, 'me');
  ok(call(db, 'db.setLock', { db: x.d, on: true }), 'db.setLock');
  const r = ok(mcp(db, 'mcp.updateRow', { id, title: '新しい題', cells: { メモ: '直したメモ', 期限: null, 関連: [x.rb] } }), 'mcp.updateRow');   // D77: データベースの行の題名
  assert.deepStrictEqual(r.result, { title: '新しい題', db: x.d });
  assert.strictEqual(r.changed.what, 'row');
  assert.deepStrictEqual(oplogOf(db, r.tx), { actor: 'claude', action: 'mcp.updateRow', page_id: id });
  assert.strictEqual(db.prepare('select text from blocks where id = ?').get(id).text, '新しい題');
  assert.deepStrictEqual(cellsOf(db, id), { [x.memo]: '直したメモ', [x.rel]: [x.rb] }, 'null で期限が空にならない・リレーションが渡した並びでない');
  assert.deepStrictEqual([cellsOf(db, x.ra)[x.back], cellsOf(db, x.rb)[x.back]], [undefined, [id]], '外した相手・つないだ相手の対の列');
  assert.strictEqual(byOf(db, id).u, 'claude');
  const snaps = snapRows(db, id);
  assert.deepStrictEqual(snaps.map((s) => s.what), ['row']);
  const body = JSON.parse(snaps[0].body);
  assert.deepStrictEqual([body.title, body.cells[x.memo], body.cells[x.due], body.blocks.map((b) => b.text)], ['前の題', '自分が直したメモ', { start: '2026-11-30' }, ['本文']], '控えが書く直前の行でない');
  // 同じ値: 書かない（控えも増えない）
  const same = ok(mcp(db, 'mcp.updateRow', { id, cells: { メモ: '直したメモ', 関連: [x.rb] } }), '同じ値');
  assert.deepStrictEqual([same.changed, snapRows(db, id).length], [undefined, 1]);
  const code = (args) => ((q) => [q.ok, q.code])(mcp(db, 'mcp.updateRow', args));
  for (const [what, args] of [['何も渡さない', { id }], ['空の題名', { id, title: ' ' }], ['改行の題名', { id, title: '題\n名' }], ['作成日時', { id, cells: { 作成日時: '2026-11-01' } }], ['無い選択肢', { id, cells: { 区分: '社長室' } }], ['題名の列', { id, cells: { 名前: 'x' } }]]) {   // D77: データベースの行の題名（会議の題名でない）
    assert.deepStrictEqual(code(args), [false, 'bad-args'], what);
  }
  assert.strictEqual(db.prepare('select text from blocks where id = ?').get(id).text, '新しい題');
  ok(call(db, 'db.setLock', { db: x.d, on: false }), 'db.setLock(外す)');
  const tplId = ok(call(db, 'tpl.add', { db: x.d, title: 'テンプレートの見本2' }), 'tpl.add').result.id;   // D77: テンプレートの題名
  assert.deepStrictEqual(code({ id: tplId, title: '直す' }), [false, 'not-found'], 'テンプレートの行を直した');
  assert.deepStrictEqual(code({ id: 'rnone1', title: '直す' }), [false, 'not-found']);   // D77: データベースの行の題名（会議の題名でない）
  ok(call(db, 'rows.trash', { db: x.d, ids: [id] }), 'rows.trash');
  assert.deepStrictEqual(code({ id, title: '直す' }), [false, 'not-found'], 'ゴミ箱の行を直した');   // D77: データベースの行の題名（会議の題名でない）
}));

test('CT-3・F241: mcp.updateRow の「議事録」の行（議事録）は「参加者」だけ: 名前（題名）・日付・要約は bad-args。参加者は直り、控えは議事録の1行', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  ok(call(db, 'minutes.gather', { first: true }, 'main'), 'minutes.gather');
  const mdb = db.prepare("select id, attrs from blocks where type = 'page' and instr(attrs, '\"minutes\"') > 0").get();
  const people = JSON.parse(mdb.attrs).cols.find((c) => c.type === 'person').id;
  const title = C.readPage(db, id).title;
  const code = (args) => ((q) => [q.ok, q.code])(mcp(db, 'mcp.updateRow', args));
  assert.deepStrictEqual(code({ id, title: '会議の新しい題' }), [false, 'bad-args'], '議事録の題名を直した');   // D77: 断る題名（直らない）
  for (const name of ['名前', '日付', '要約', '作成者']) assert.deepStrictEqual(code({ id, cells: { [name]: 'x' } }), [false, 'bad-args'], name);
  const r = ok(mcp(db, 'mcp.updateRow', { id, cells: { 参加者: ['担当A', '担当B'] } }), 'mcp.updateRow(参加者)');
  assert.deepStrictEqual([r.result.db, C.readPage(db, id).cells[people], C.readPage(db, id).title], [mdb.id, ['担当A', '担当B'], title]);
  assert.deepStrictEqual(snapRows(db, id).map((s) => s.what), ['row']);
}));

// ================================================================ 点検 2（2026-11-23。計画の CR85・CR89・CR94。持ち主の決まり「実装中の確かめは Notion に合わせるかおすすめを選ぶ」で決めた）
test('点検 2・CR85: mcp.updateAction の同じ値（何も変えない）は答えに same: true（送り直しの答えも oplog の操作の空の行から同じに）。変えたときは same を付けない', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const title = C.readPage(db, id).title;
  const tx1 = txOf('mcp');
  const a = ok(act(db, id, 'pm1b4', { done: true }, {}, tx1), '変える');
  assert.deepStrictEqual(a.result, { title });
  assert.deepStrictEqual(act(db, id, 'pm1b4', { done: false }, {}, tx1).result, { title }, '変えた送り直しに same');
  const tx2 = txOf('mcp');
  const same = ok(act(db, id, 'pm1b4', { done: true }, {}, tx2), '同じ値');
  assert.deepStrictEqual(same.result, { title, same: true });
  const again = act(db, id, 'pm1b4', { done: true }, {}, tx2);
  assert.deepStrictEqual([again.dup, again.result], [true, { title, same: true }], '同じ値の送り直しの答え');
}));

test('点検 2・CR85: mcp.fixNames の送り直し（同じ tx）は、1回目に何も直さなかった（当たりが無かった）なら答えに found: false（書いたときは今どおり counts: null だけ）', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const title = C.readPage(db, id).title;
  const tx = txOf('mcp');
  const a = ok(mcp(db, 'mcp.fixNames', { pageId: id, pairs: [{ from: '該当なしの名前', to: '担当B' }] }, {}, tx), '1回目（当たりなし）');
  assert.strictEqual(a.result.counts.summary, 0);
  const b = mcp(db, 'mcp.fixNames', { pageId: id, pairs: [{ from: '該当なしの名前', to: '担当B' }] }, {}, tx);
  assert.deepStrictEqual([b.ok, b.dup, b.result], [true, true, { title, counts: null, found: false }]);
}));

test('点検 2・CR89: mcp.writeSummary の meetingType は選べる種類だけ（auto は bad-args で何も変えない。決めたこと 20: 種類は渡すか今のまま）。page.setType の auto は今どおり', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  const rev = revOf(db, id);
  const r = writeSum(db, id, { meetingType: 'auto' });
  assert.deepStrictEqual([r.ok, r.code], [false, 'bad-args']);
  assert.strictEqual(revOf(db, id), rev);
  ok(call(db, 'page.setType', { id, type: 'auto' }), 'page.setType auto');
}));

test('点検 2・CR94: Claude の Markdown（validate の mdText）の 60,000 字はコードポイントで数える（𠮷 は1字。道具の inputSchema の maxLength と同じ数え方）', () => {
  const V = require('../src/db/validate');
  assert.strictEqual(V.checkArgs({ md: 'mdText' }, { md: '𠮷'.repeat(60000) }).ok, true, '6 万字の 𠮷 を断った');
  assert.strictEqual(V.checkArgs({ md: 'mdText' }, { md: 'あ'.repeat(60000) }).ok, true);
  assert.strictEqual(V.checkArgs({ md: 'mdText' }, { md: 'あ'.repeat(60001) }).ok, false);
  assert.strictEqual(V.checkArgs({ md: 'mdText' }, { md: `${'あ'.repeat(59999)}𠮷𠮷` }).ok, false);
  assert.strictEqual(V.checkArgs({ md: 'mdText' }, { md: '' }).ok, false);
});

// ---------------------------------------------------------------- CU-1（決めたこと 50・受け渡す形の page.claudeSnaps の count: CR95・M38）
test('CU-1・F234: page.claudeSnaps の名前の直しの行に count（直した数の和: 要約・メモ・文字起こし・担当・参加者）。ほかの道具の行と、控えから戻す形には count が入らない', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: '一回目' }), 'w1');
  const r = ok(fixN(db, id, [{ from: '担当A', to: '担当B' }]), 'mcp.fixNames');
  const c = r.result.counts;
  const n = c.summary + c.memo + c.transcript + c.assignee + c.people;
  assert.ok(n > 1, `前提: 直した数: ${JSON.stringify(c)}`);
  const list = ok(call(db, 'page.claudeSnaps', { id }), 'snaps').result;
  assert.deepStrictEqual(list.map((x) => [x.what, x.count]), [['names', n], ['summary', undefined]]);
  assert.ok(!Object.hasOwn(list[1], 'count'), '名前の直しでない行に count');
  // 戻しても count の欄はページに入らない（控えにある欄だけを戻す）
  ok(call(db, 'page.claudeRevert', { id, sid: list[0].sid }), 'revert');
  assert.ok(!Object.hasOwn(C.readPage(db, id), 'count'), '戻したページに count が入った');
}));

// ---------------------------------------------------------------- 点検 3（2026-11-23。CR106〜。持ち主の決まり「実装中の確かめは Notion に合わせるかおすすめを選ぶ」）
test('CU-1・点検 3・F234: page.claudeSnaps の行は今のページの版（rev）を持つ。page.claudeRevert に確かめた時の版（rev）を渡すと、その後に Claude か利用者が書いていれば stale で断り何も変えない（控えも残る）。今の版なら戻る。rev を渡さなければ今どおり', T, () => withDb((db, t) => {
  const id = meetingPage(t);
  ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: '一回目' }), 'w1');
  const s = ok(call(db, 'page.claudeSnaps', { id }), 'snaps').result[0];
  assert.strictEqual(s.rev, C.readPage(db, id).rev, 'page.claudeSnaps の行に今の版が無い');
  // 確かめている間に Claude が書いた
  ok(claudeWrite(db, { pageId: id, what: 'names', fn: 'block', blockId: `${id}b3`, text: '二回目' }), 'w2');
  const page0 = JSON.stringify(C.readPage(db, id));
  const r = call(db, 'page.claudeRevert', { id, sid: s.sid, rev: s.rev });
  assert.deepStrictEqual([r.ok, r.code], [false, 'stale'], '確かめた後に変わったページを戻した');
  assert.strictEqual(JSON.stringify(C.readPage(db, id)), page0, '断ったのにページが変わった');
  assert.strictEqual(snapRows(db, id).length, 2, '断ったのに控えを消した');
  // 確かめている間に利用者が書いた（題名だけでも）
  const s2 = ok(call(db, 'page.claudeSnaps', { id }), 'snaps2').result[1];
  ok(call(db, 'page.setTitle', { id, title: '利用者が付け直した題' }), 'setTitle');   // 利用者が付け直した題名（D77）
  assert.deepStrictEqual((({ ok: o, code }) => [o, code])(call(db, 'page.claudeRevert', { id, sid: s2.sid, rev: s2.rev })), [false, 'stale'], '利用者が書いた後に戻した');
  // 読み直した今の版なら戻る
  const s3 = ok(call(db, 'page.claudeSnaps', { id }), 'snaps3').result[1];
  assert.strictEqual(s3.sid, s2.sid);
  ok(call(db, 'page.claudeRevert', { id, sid: s3.sid, rev: s3.rev }), 'revert');
  assert.deepStrictEqual(snapRows(db, id), [], '戻した控えと新しい控えを消していない');
  // rev を渡さない（今の形）は版を見ない
  ok(claudeWrite(db, { pageId: id, what: 'summary', fn: 'block', blockId: `${id}b2`, text: '三回目' }), 'w3');
  ok(call(db, 'page.setTitle', { id, title: '後の題' }), 'setTitle2');   // 利用者が付け直した題名（D77）
  ok(call(db, 'page.claudeRevert', { id, sid: snapRows(db, id)[0].rid }), 'revert(rev なし)');
}));

test('CU-1・点検 3・CR97: Claude の mcp.updateRow の知らせ（changed.pageIds）の頭はいつも直した行のページ（リレーションだけを直したときも。データベース・相手の行は後ろ）。何も変えなければ知らせない', T, () => withDb((db) => {
  const x = rowDb(db);
  const id = ok(addRow(db, { db: x.d, title: '前の題', cells: { 関連: [x.ra] } }), 'mcp.addRow').result.id;   // D77: データベースの行の題名
  const rel = ok(mcp(db, 'mcp.updateRow', { id, cells: { 関連: [x.rb] } }), 'リレーションだけ');
  assert.strictEqual(rel.changed.pageIds[0], id, `頭が直した行でない: ${JSON.stringify(rel.changed.pageIds)}`);
  assert.ok(rel.changed.pageIds.includes(x.d) && rel.changed.pageIds.includes(x.rb), 'データベース・相手の行が知らせに無い');
  assert.strictEqual(new Set(rel.changed.pageIds).size, rel.changed.pageIds.length, '知らせに重なり');
  const both = ok(mcp(db, 'mcp.updateRow', { id, title: '新しい題', cells: { 関連: [x.ra] } }), '題名とリレーション');   // D77: データベースの行の題名
  assert.strictEqual(both.changed.pageIds[0], id);
  assert.strictEqual(ok(mcp(db, 'mcp.updateRow', { id, cells: { 関連: [x.ra] } }), '同じ値').changed, undefined, '何も変えないのに知らせた');
}));

// ---------------------------------------------------------------- XE-1（決めたこと 57・F245）: edit.textStep（Ctrl+Z・Ctrl+Y の印を1つ動かす）
test('XE-1・F245: edit.textStep: 今の文と飾りが from なら to を書く・違えば stale で何も変えない・UNDO_CMDS にある・役 app だけ・保存の歩みと合わせて edit.revert で始めへ戻る（出典の印も）', T, () => withDb((db, t) => {
  const { page, segments } = samplePage('pq1');
  t.seed(page, segments);
  assert.ok(UNDO_CMDS.has('edit.textStep'));
  assert.deepStrictEqual(core.COMMANDS['edit.textStep'].roles, ['app']);
  const before = db.prepare('select text, attrs from blocks where id = ?').get('b2');
  const at = (id = 'b2') => { const b = ok(call(db, 'page.get', { id: 'pq1' }), 'page.get').result.page.blocks.find((x) => x.id === id); return [b.text, b.rich || null, b.citeState]; };
  const save = ok(call(db, 'block.update', { pageId: 'pq1', blockId: 'b2', patch: { text: '来月の予算案の作成を担当Aが進める。確認' } }), 'block.update');
  // from が今の文: to を書く（出典は古い印: block.update と同じ）
  const s1 = ok(call(db, 'edit.textStep', { pageId: 'pq1', blockId: 'b2', from: { text: '来月の予算案の作成を担当Aが進める。確認', rich: null }, to: { text: '来月の予算案の作成を担当Aが進める。', rich: null } }), 'edit.textStep');
  assert.ok(s1.changed, '変えたのに changed が無い');
  assert.deepStrictEqual(at(), ['来月の予算案の作成を担当Aが進める。', null, 'stale']);
  // from が今の文と違う: stale で何も変えない（Claude や別の欄が書いた後の文を上書きしない）
  const rev = revOf(db, 'b2');
  const st = call(db, 'edit.textStep', { pageId: 'pq1', blockId: 'b2', from: { text: '来月の予算案の作成を担当Aが進める。確認', rich: null }, to: { text: '別の文', rich: null } });
  assert.deepStrictEqual([st.ok, st.code], [false, 'stale']);
  assert.deepStrictEqual([at()[0], revOf(db, 'b2')], ['来月の予算案の作成を担当Aが進める。', rev], 'stale で書いた');
  // 飾りも照らす（同じ文でも飾りが違えば stale）・飾りを書く
  const bold = [{ t: '来月の予算案の作成を担当Aが進める。', m: ['b'] }];
  const st2 = call(db, 'edit.textStep', { pageId: 'pq1', blockId: 'b2', from: { text: '来月の予算案の作成を担当Aが進める。', rich: bold }, to: { text: 'x', rich: null } });
  assert.deepStrictEqual([st2.ok, st2.code], [false, 'stale'], '飾りの違いを照らさない');
  ok(call(db, 'edit.textStep', { pageId: 'pq1', blockId: 'b2', from: { text: '来月の予算案の作成を担当Aが進める。', rich: null }, to: { text: '来月の予算案の作成を担当Aが進める。', rich: bold } }), '飾りを書く');
  assert.deepStrictEqual(at().slice(0, 2), ['来月の予算案の作成を担当Aが進める。', bold]);
  // 形の照らし（rich の素の文字が text と違う・知らない欄）・役 mcp と main は断る
  for (const bad of [{ text: 'a', rich: [{ t: 'b', m: [] }] }, { text: 'a', rich: null, caret: 1 }, { rich: null }]) {
    assert.strictEqual(call(db, 'edit.textStep', { pageId: 'pq1', blockId: 'b2', from: bad, to: { text: 'a', rich: null } }).code, 'bad-args', JSON.stringify(bad));
  }
  for (const role of ['mcp', 'main']) assert.strictEqual(call(db, 'edit.textStep', { pageId: 'pq1', blockId: 'b2', from: { text: 'a', rich: null }, to: { text: 'b', rich: null } }, role).ok, false, role);
  // 保存の歩みと印の歩みを合わせて edit.revert: 保存の前の形（出典の印も）に戻る
  const s2tx = call(db, 'edit.textStep', { pageId: 'pq1', blockId: 'b2', from: { text: '来月の予算案の作成を担当Aが進める。', rich: bold }, to: { text: '来月の予算案の作成を担当Aが進める。', rich: null } }).tx;
  ok(call(db, 'edit.revert', { pageId: 'pq1', steps: [save.tx, s1.tx, s2tx] }), 'edit.revert');
  assert.deepStrictEqual(db.prepare('select text, attrs from blocks where id = ?').get('b2'), before, '保存の前の形に戻らない');
  // メモの行（保存したページの memoDoc）
  ok(call(db, 'page.setMemoDoc', { id: 'pq1', doc: [{ id: 'm1', type: 'paragraph', text: 'メモの一行' }] }), 'page.setMemoDoc');
  ok(call(db, 'edit.textStep', { pageId: 'pq1', blockId: 'm1', from: { text: 'メモの一行', rich: null }, to: { text: 'メモの', rich: null } }), 'メモの行');
  const p = ok(call(db, 'page.get', { id: 'pq1' }), 'page.get').result.page;
  assert.deepStrictEqual([p.memoDoc.map((b) => b.text), p.memo], [['メモの'], 'メモの\n']);
  assert.strictEqual(call(db, 'edit.textStep', { pageId: 'pq1', blockId: 'm1', from: { text: 'メモの一行', rich: null }, to: { text: 'x', rich: null } }).code, 'stale');
  assert.strictEqual(call(db, 'edit.textStep', { pageId: 'pq1', blockId: 'zz9', from: { text: '', rich: null }, to: { text: 'x', rich: null } }).code, 'stale', '無い行');
}));

// ---------------------------------------------------------------- XN-1（決めたこと 62・AQ11 (a)・AQ27 (a)・AQ28 (a)・F249）: ページの複製の命令 page.duplicate
const PT = require('../src/pageTree');
const kidsOf = (db, id) => PT.pageTree(ok(call(db, 'pages.list', {}), 'pages.list').result).kids.get(id) || [];
const subRowsOf = (db, id) => C.readPage(db, id).blocks.filter((b) => b.type === 'subpage').map((b) => b.page);
const dumpAll = (c) => [c.prepare('select id, type, page_id, parent_id, ord, text, rich, attrs, rev, created_at, updated_at, trashed_at from blocks order by id').all().map((r) => ({ ...r })),
  c.prepare('select page_id, id, n, at_ms, text, extra from segments order by page_id, n').all().map((r) => ({ ...r }))];
test('XN-1・F249: page.duplicate: 題名に「 (1)」（写しの写しも1つだけ・2回複製しても「 (1)」）・元のすぐ後ろ（本文の子ページの行も）・1つの命令・作成者と最終更新者は「自分」で作成日時は今・写しを直しても元は変わらない・ロックした表を中に持つページの写しの表はロック中で行を足しセルを書ける・外の両側の列は片側（外は変わらない）・ロック中のデータベースを根にすると bad-args・UNDO_CMDS に無い・T4b', T, async () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const P = ok(call(db, 'page.create', {}), 'P').result.id;
    const Q = ok(call(db, 'page.create', { parentId: P }), 'Q').result.id;
    const after = ok(call(db, 'page.create', { parentId: P }), '後の兄弟').result.id;
    ok(call(db, 'page.setTitle', { id: Q, title: '複製の元' }), 'setTitle');   // 白紙のページの題名（D77 の会議の題名でない）
    const qb = ok(call(db, 'block.insert', { pageId: Q, afterBlockId: '', type: 'paragraph' }), 'block.insert').result.blockId;
    ok(call(db, 'block.update', { pageId: Q, blockId: qb, patch: { text: '元の本文' } }), 'block.update');
    const D = ok(call(db, 'db.create', { parentId: Q, inline: qb }), 'db.create').result.id;
    const memoCol = ok(call(db, 'col.add', { db: D, type: 'text', name: 'メモの列' }), 'col.add').result.col.id;
    const E = ok(call(db, 'db.create', {}), '外のデータベース').result.id;
    const er = ok(call(db, 'row.add', { db: E, title: '外の行' }), '外の行').result.id;   // データベースの行の題名（D77 の外）
    const rel = ok(call(db, 'col.add', { db: D, type: 'rel', target: E, both: true, name: '外へ' }), '両側の列').result;
    const r1 = ok(call(db, 'row.add', { db: D, title: '中の行', cells: { [memoCol]: '中の値' } }), 'row.add').result.id;   // D77 の外（行の題名）
    ok(call(db, 'rel.link', { db: D, id: r1, col: rel.col.id, ids: [er] }), 'rel.link');
    ok(call(db, 'db.setLock', { db: D, on: true }), 'db.setLock');
    const eWas = dumpAll(db)[0].filter((x) => x.id === E || x.id === er);
    // T4b の控え
    let Q2 = null;
    const to = path.join(t.dir, 'copy-xn1.db');
    await sqlite.backup(db, to);
    const copy = new sqlite.DatabaseSync(to);
    try {
      const k = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
      const r = ok(call(db, 'page.duplicate', { id: Q }), 'page.duplicate');
      const at = new Date(clock).toISOString();
      Q2 = r.result.id;
      assert.ok(typeof Q2 === 'string' && Q2 !== Q);
      const logs = db.prepare('select action, actor, page_id from oplog where seq > ?').all(k).map((x) => ({ ...x }));
      assert.deepStrictEqual(logs, [{ action: 'page.duplicate', actor: 'me', page_id: Q }], '1つの命令（oplog の1行）でない');
      // 題名・置き場（サイドバーの並びも本文の子ページの行も元のすぐ後ろ）・画面の元のページはそのまま（命令は開かない）
      const q2 = C.readPage(db, Q2);
      assert.strictEqual(q2.title, '複製の元 (1)');
      assert.deepStrictEqual(kidsOf(db, P), [Q, Q2, after], '元のすぐ後ろでない');
      assert.deepStrictEqual(subRowsOf(db, P), [Q, Q2, after], '本文の子ページの行が元のすぐ後ろでない');
      assert.strictEqual(q2.createdAt, at, '作成日時が今でない');
      assert.strictEqual(q2.kind, 'blank');
      // 本文と中の表（新しい ID・ロック中・外の両側の列は片側）
      assert.strictEqual(q2.blocks[0].text, '元の本文');
      assert.notStrictEqual(q2.blocks[0].id, qb);
      const inl = q2.blocks.find((b) => b.type === 'subpage');
      assert.ok(inl && inl.inline === true && inl.page !== D, 'インラインの行が写しの表を指さない');
      const D2 = inl.page;
      const d2 = db.prepare('select parent_id, text, attrs, created_at from blocks where id = ?').get(D2);
      const d2a = JSON.parse(d2.attrs);
      assert.strictEqual(d2.parent_id, Q2);
      assert.strictEqual(d2.created_at, at);
      assert.strictEqual(d2a.locked, true, '写しの表のロックが外れた（AQ27 (a)）');
      const oneSided = { ...rel.col };
      delete oneSided.back;
      assert.ok(typeof rel.col.back === 'string');
      assert.deepStrictEqual(d2a.cols.find((c) => c.id === rel.col.id), oneSided, '外の両側の列を写しでも両側にした（OC-13）');
      assert.deepStrictEqual(dumpAll(db)[0].filter((x) => x.id === E || x.id === er), eWas, '外のデータベースの列か行を書き替えた（OC-13）');
      const rows2 = db.prepare("select id, text, attrs, created_at, updated_at from blocks where type = 'row' and parent_id = ?").all(D2);
      assert.strictEqual(rows2.length, 1);
      const row2 = JSON.parse(rows2[0].attrs);
      assert.notStrictEqual(rows2[0].id, r1);
      assert.deepStrictEqual(row2.cells, { [memoCol]: '中の値', [rel.col.id]: [er] });
      assert.deepStrictEqual(row2.by, { c: 'me', u: 'me' }, '作成者・最終更新者が「自分」でない');
      assert.deepStrictEqual([rows2[0].created_at, rows2[0].updated_at], [at, at]);
      // 写しを直しても元は変わらない
      ok(call(db, 'block.update', { pageId: Q2, blockId: q2.blocks[0].id, patch: { text: '写しだけの直し' } }), '写しの直し');
      assert.strictEqual(C.readPage(db, Q).blocks[0].text, '元の本文');
      ok(call(db, 'row.setCell', { db: D2, id: rows2[0].id, col: memoCol, value: '写しの値' }), 'ロック中の写しの表のセル（D152）');
      assert.strictEqual(JSON.parse(db.prepare('select attrs from blocks where id = ?').get(r1).attrs).cells[memoCol], '中の値');
      ok(call(db, 'row.add', { db: D2, title: '写しに足した行' }), 'ロック中の写しの表に行を足す（D152）');   // D77 の外（行の題名）
      // T4b: 控えに後の oplog を前へ当て直すと同じ
      for (const x of db.prepare('select ops from oplog where seq > ? order by seq').all(k)) applyOps(copy, JSON.parse(x.ops), 'forward');
      assert.deepStrictEqual(dumpAll(copy), dumpAll(db));
    } finally { copy.close(); }
    // 写しの写しも「 (1)」は1つ・2回複製しても「 (1)」
    const Q3 = ok(call(db, 'page.duplicate', { id: Q2 }), '写しの写し').result.id;
    assert.strictEqual(C.readPage(db, Q3).title, '複製の元 (1)');
    const Q4 = ok(call(db, 'page.duplicate', { id: Q }), '2回目').result.id;
    assert.strictEqual(C.readPage(db, Q4).title, '複製の元 (1)');
    assert.deepStrictEqual(kidsOf(db, P), [Q, Q4, Q2, Q3, after]);
    // ロック中のデータベースそのもの・無い・ゴミ箱のページは bad-args（何も作らない）
    ok(call(db, 'page.delete', { id: after }), 'delete');
    const n0 = db.prepare('select count(*) c from blocks').get().c;
    for (const id of [D, 'pnone000000']) assert.strictEqual(call(db, 'page.duplicate', { id }).code, 'bad-args', id);
    assert.strictEqual(call(db, 'page.duplicate', { id: after }).code, 'bad-args', 'ゴミ箱のページ');
    assert.strictEqual(db.prepare('select count(*) c from blocks').get().c, n0, '断ったのに行が増えた');
    assert.ok(![...UNDO_CMDS].includes('page.duplicate'), 'UNDO_CMDS に入れた（CR24）');
    assert.deepStrictEqual(core.COMMANDS['page.duplicate'].roles, ['app']);
  } finally { t.done(); }
});

test('XN-1・F249: page.duplicate は議事録を含むページを bad-args で断り何も作らない（議事録・「議事録」・「タスク管理」は写さない）。同じ tx の送り直しは同じ写しの ID で、2つ目を作らない', T, () => withDb((db, t) => {
  const P = ok(call(db, 'page.create', {}), 'P').result.id;
  const id = meetingPage(t);
  ok(call(db, 'page.move', { id, parentId: P }), '議事録を白紙のページの中へ');
  const n0 = db.prepare('select count(*) c from blocks').get().c;
  assert.strictEqual(call(db, 'page.duplicate', { id: P }).code, 'bad-args');
  assert.strictEqual(call(db, 'page.duplicate', { id }).code, 'bad-args', '議事録そのもの');
  assert.strictEqual(db.prepare('select count(*) c from blocks').get().c, n0);
  const Q = ok(call(db, 'page.create', {}), 'Q').result.id;
  const tx = txOf('app');
  const a = ok(call(db, 'page.duplicate', { id: Q }, 'app', tx), '1回目');
  const n1 = db.prepare('select count(*) c from blocks').get().c;
  const b = call(db, 'page.duplicate', { id: Q }, 'app', tx);
  assert.strictEqual(b.ok, true);
  assert.deepStrictEqual(b.result, a.result, '送り直しの答えが違う');
  assert.strictEqual(db.prepare('select count(*) c from blocks').get().c, n1, '送り直しで2つ目を作った');
}));

// ---------------------------------------------------------------- XN-3（決めたこと 63・AQ12 (a)・F250）: 見出し4
test('XN-3・F250: 見出し4の行を作れ（block.insert・block.turnInto・block.paste・メモの行）、読み直しても段 4。段 5 は bad-args で何も変えない', T, () => withDb((db, t) => {
  const { id, blockId } = blankPage(db);
  const a = ok(call(db, 'block.insert', { pageId: id, afterBlockId: blockId, type: 'heading', level: 4 }), 'block.insert').result.blockId;
  ok(call(db, 'block.turnInto', { pageId: id, blockId, type: 'heading', level: 4, toggle: true }), 'block.turnInto');
  const page = C.readPage(db, id);
  assert.deepStrictEqual(page.blocks.map((b) => [b.type, b.level, b.toggle]), [['heading', 4, true], ['heading', 4, undefined]]);
  assert.ok(page.blocks.some((b) => b.id === a));
  const rev = revOf(db, id);
  assert.strictEqual(call(db, 'block.insert', { pageId: id, afterBlockId: a, type: 'heading', level: 5 }).code, 'bad-args');
  assert.strictEqual(revOf(db, id), rev);
  ok(call(db, 'block.paste', { pageId: id, blockId: a, rich: [], at: 0, blocks: [{ type: 'heading', level: 4, rich: [{ t: '貼った見出し4' }] }] }), 'block.paste');
  assert.ok(C.readPage(db, id).blocks.some((b) => b.type === 'heading' && b.level === 4 && b.text === '貼った見出し4'));
  const m = meetingPage(t);
  ok(call(db, 'page.setMemoDoc', { id: m, doc: [{ id: 'm1', type: 'heading', level: 4, text: 'メモの見出し4', citeState: 'manual' }] }), 'page.setMemoDoc');
  assert.deepStrictEqual(C.readPage(db, m).memoDoc.map((b) => [b.type, b.level]), [['heading', 4]]);
}));
