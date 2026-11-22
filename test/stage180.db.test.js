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
  assert.deepStrictEqual(list, [{ sid: rids[1], at: at2, what: 'names', later: false }, { sid: rids[0], at: at1, what: 'summary', later: true }]);
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

test('CW-1: preload の 74 の名前（page.claudeSnaps・page.claudeRevert）は役 app の命令と同じ集まり。page.claudeSnaps は読む命令（tx なし）・page.claudeRevert は tx 付き', T, async () => {
  const vm = require('node:vm');
  const PRE = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const names = [.../const APP_COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(PRE)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.strictEqual(names.length, 74);
  assert.deepStrictEqual(names.sort(), Object.keys(core.COMMANDS).filter((k) => core.COMMANDS[k].roles.includes('app')).sort());
  const reads = [.../const DB_READS = new Set\(\[([^\]]*)\]\)/.exec(PRE)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.ok(reads.includes('page.claudeSnaps') && !reads.includes('page.claudeRevert'));
  const undo = [.../const UNDO_CMDS = new Set\(\[([^\]]*)\]\)/.exec(PRE)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.ok(!undo.includes('page.claudeRevert') && !undo.includes('page.claudeSnaps'));
  const exposed = {}; const on = {}; let uuid = 0;
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async () => ({}), send: () => {} } };
  vm.runInNewContext(PRE, { require: () => electron, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, setTimeout, clearTimeout, console, Promise });
  const port = new EventTarget(); port.sent = []; port.postMessage = (m) => port.sent.push(structuredClone(m)); port.start = () => {};
  on['db:port']({ ports: [port] });
  exposed.koeApp.pageClaudeSnaps('pa1');
  exposed.koeApp.pageClaudeRevert('pa1', 7);
  assert.deepStrictEqual(port.sent.map((m) => [m.cmd, m.args, typeof m.tx]), [['page.claudeSnaps', { id: 'pa1' }, 'undefined'], ['page.claudeRevert', { id: 'pa1', sid: 7 }, 'string']]);
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
