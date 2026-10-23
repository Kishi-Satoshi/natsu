/* mcp-reader.test.js — 0.10.0 Task R-1（MR3・F3・F8・F16。計画 docs/plans/2026-10-20-100.md）: MCP の読み手は呼び出しごとに読み取りだけで開き、必ず閉じる */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite = require('node:sqlite');
const core = require('../src/db/core');
const commands = require('../src/db/commands');
const snapshot = require('../src/db/snapshot');
const reader = require('../src/mcp/reader');
const { mcpDb, TITLES } = require('./helpers/mcpdb');

const T = { timeout: 5000 };
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const counter = () => {
  const c = { open: 0, close: 0 };
  c.onOpen = () => { c.open += 1; };
  c.onClose = () => { c.close += 1; };
  return c;
};
const lockText = (at) => `pid 4242\nat ${new Date(at).toISOString()}\n`;

test('MR3: 道具の呼び出しの前後で natsu.db のバイトが同じ（SHA-256 で比べる）', T, () => {
  const m = mcpDb({ only: ['plain1', 'plain2'] });
  try {
    const before = sha(m.file);
    const r = reader.withReader({ sqlite, dataDir: m.dataDir }, (db) => commands.listPages(db).map((e) => commands.readPage(db, e.id).title));
    assert.deepStrictEqual(r, { ok: true, value: [TITLES.plain2, TITLES.plain1] });
    assert.strictEqual(sha(m.file), before);
  } finally { m.done(); }
});

test('MR3: withReader の中で insert・update・pragma user_version を試すと全部断られる（readonly か query_only の誤り）', T, () => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    const errs = [];
    const r = reader.withReader({ sqlite, dataDir: m.dataDir }, (db) => {
      for (const sql of ["insert into meta(key, value) values ('x', 'y')", "update blocks set text = 'x'", 'pragma user_version = 5', "delete from blocks"]) {
        try { db.exec(sql); errs.push(`通った: ${sql}`); } catch (e) { errs.push(/readonly|read-only|query_only|attempt to write/i.test(String(e.message)) ? 'ok' : String(e.message)); }
      }
      return Number(db.prepare('pragma user_version').get().user_version);
    });
    assert.deepStrictEqual(errs, ['ok', 'ok', 'ok', 'ok']);
    assert.deepStrictEqual(r, { ok: true, value: core.SCHEMA_VERSION });
  } finally { m.done(); }
});

test('MR3: 開くときに readOnly: true を渡す（偽の sqlite の DatabaseSync が受けた引数を見る）', T, () => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    const seen = [];
    const fake = { DatabaseSync: class extends sqlite.DatabaseSync { constructor(f, o) { seen.push(o); super(f, o); } } };
    assert.strictEqual(reader.withReader({ sqlite: fake, dataDir: m.dataDir }, () => 1).ok, true);
    assert.ok(seen.length >= 1);
    assert.ok(seen.every((o) => o && o.readOnly === true), JSON.stringify(seen));
  } finally { m.done(); }
});

test('MR3: 開いた接続で pragma query_only が 1', T, () => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    const r = reader.withReader({ sqlite, dataDir: m.dataDir }, (db) => Number(db.prepare('pragma query_only').get().query_only));
    assert.deepStrictEqual(r, { ok: true, value: 1 });
  } finally { m.done(); }
});

test('MR3: natsu.db が無ければ no-db で、ファイルを作らない', T, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-mcp-空𠮷-'));
  try {
    const c = counter();
    const r = reader.withReader({ sqlite, dataDir: dir, onOpen: c.onOpen, onClose: c.onClose }, () => assert.fail('呼ばれた'));
    assert.deepStrictEqual(r, { ok: false, code: 'no-db' });
    assert.deepStrictEqual(fs.readdirSync(dir), []);
    assert.strictEqual(c.open, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MR3・RF18: lock が今の時刻なら locked、11 分前なら stale-lock で、どちらも開かない（onOpen が 0 回）。withLock の中から呼んでも locked', T, () => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    const lock = path.join(m.dataDir, 'natsu.db.lock');
    const now = Date.parse('2026-10-21T09:00:00.000Z');
    const c = counter();
    const opts = { sqlite, dataDir: m.dataDir, now: () => now, onOpen: c.onOpen, onClose: c.onClose };
    fs.writeFileSync(lock, lockText(now - 60 * 1000));
    assert.deepStrictEqual(reader.withReader(opts, () => assert.fail('呼ばれた')), { ok: false, code: 'locked' });
    fs.writeFileSync(lock, lockText(now - 9 * 60 * 1000));
    assert.deepStrictEqual(reader.withReader(opts, () => assert.fail('呼ばれた')), { ok: false, code: 'locked' });
    fs.writeFileSync(lock, lockText(now - 11 * 60 * 1000));
    assert.deepStrictEqual(reader.withReader(opts, () => assert.fail('呼ばれた')), { ok: false, code: 'stale-lock' });
    // 中身が読めない形の lock はファイルの更新時刻で決める（今作ったので新しい）
    fs.writeFileSync(lock, 'こわれた中身');
    assert.deepStrictEqual(reader.withReader({ ...opts, now: Date.now }, () => assert.fail('呼ばれた')), { ok: false, code: 'locked' });
    assert.strictEqual(c.open, 0);
    fs.unlinkSync(lock);
    const inLock = snapshot.withLock(m.dataDir, () => reader.withReader({ sqlite, dataDir: m.dataDir }, () => assert.fail('呼ばれた')));
    assert.deepStrictEqual(inLock, { ok: false, code: 'locked' });
    assert.strictEqual(fs.existsSync(lock), false);
    assert.strictEqual(reader.withReader({ sqlite, dataDir: m.dataDir }, () => 1).ok, true);
  } finally { m.done(); }
});

test('MR3: 開いた後に lock ができたら（onOpen の中で作る）locked で、fn を呼ばない。開いた接続は閉じる', T, () => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    const lock = path.join(m.dataDir, 'natsu.db.lock');
    const c = counter();
    const r = reader.withReader({ sqlite, dataDir: m.dataDir, onOpen: (db) => { c.onOpen(db); fs.writeFileSync(lock, lockText(Date.now())); }, onClose: c.onClose },
      () => assert.fail('呼ばれた'));
    assert.deepStrictEqual(r, { ok: false, code: 'locked' });
    assert.deepStrictEqual([c.open, c.close], [1, 1]);
  } finally { m.done(); }
});

test('MR3・F8: user_version が 0 の DB は old で版が上がらない。user_version が 2 の DB は newer（開いた接続も閉じる）', T, () => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    const raw = new sqlite.DatabaseSync(m.file);
    raw.exec('pragma user_version = 0');
    raw.close();
    const c = counter();
    const o = { sqlite, dataDir: m.dataDir, onOpen: c.onOpen, onClose: c.onClose };
    assert.deepStrictEqual(reader.withReader(o, () => assert.fail('呼ばれた')), { ok: false, code: 'old' });
    const v0 = new sqlite.DatabaseSync(m.file, { readOnly: true });
    assert.strictEqual(Number(v0.prepare('pragma user_version').get().user_version), 0, '版が上がった');
    v0.close();
    const raw2 = new sqlite.DatabaseSync(m.file);
    raw2.exec(`pragma user_version = ${core.SCHEMA_VERSION + 1}`);
    raw2.close();
    assert.deepStrictEqual(reader.withReader(o, () => assert.fail('呼ばれた')), { ok: false, code: 'newer' });
    assert.strictEqual(c.open, c.close);
  } finally { m.done(); }
});

test('F3・RF62: fn が答えた・投げた・大きな答えを返した、のどれでも onOpen と onClose の数が同じ。投げたら code は read（投げた文を返さない）', T, () => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    const c = counter();
    const o = { sqlite, dataDir: m.dataDir, onOpen: c.onOpen, onClose: c.onClose };
    assert.strictEqual(reader.withReader(o, () => 'ok').ok, true);
    const thrown = reader.withReader(o, () => { throw new Error('ひみつの合言葉𠮷 /tmp/パス'); });
    assert.deepStrictEqual(thrown, { ok: false, code: 'read' });
    assert.ok(!JSON.stringify(thrown).includes('ひみつ'));
    const big = reader.withReader(o, () => 'あ'.repeat(5 * 1024 * 1024));
    assert.strictEqual(big.value.length, 5 * 1024 * 1024);
    assert.deepStrictEqual([c.open, c.close], [3, 3]);
  } finally { m.done(); }
});

test('MR3: 別の接続（WAL の書き手）が開いたまま書いた行が読める（NaTsu が動いている間）。書き手が閉じた後でも読める（NaTsu を閉じた後）', T, () => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    m.call('app', 'page.setTitle', { id: 'pm1', title: '書き手が直した題' });   // 書き手は開いたまま。利用者が付け直した題名（D77。題名の語に頼るため）
    const read = () => reader.withReader({ sqlite, dataDir: m.dataDir }, (db) => commands.readPage(db, 'pm1').title);
    assert.deepStrictEqual(read(), { ok: true, value: '書き手が直した題' });
    m.close();
    assert.deepStrictEqual(read(), { ok: true, value: '書き手が直した題' });
  } finally { m.done(); }
});

test('F16・RF75: withReader が fs で触るファイルは natsu.db と natsu.db.lock だけ（同じフォルダの draft.json・history.json・settings.json・backup を開かない）', T, () => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    for (const n of ['draft.json', 'draft-1.json', 'history.json', 'settings.json']) fs.writeFileSync(path.join(m.dataDir, n), '{"ひみつ":"合言葉𠮷"}');
    fs.mkdirSync(path.join(m.dataDir, 'backup'));
    fs.writeFileSync(path.join(m.dataDir, 'natsu.db.lock'), lockText(Date.now() - 60 * 60 * 1000));   // 古い lock も読む（stale-lock）
    const touched = [];
    const spy = new Proxy(fs, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { if (typeof a[0] === 'string') touched.push(path.basename(a[0])); return t[k](...a); } : t[k]) });
    assert.deepStrictEqual(reader.withReader({ sqlite, dataDir: m.dataDir, fs: spy }, () => 1), { ok: false, code: 'stale-lock' });
    fs.unlinkSync(path.join(m.dataDir, 'natsu.db.lock'));
    assert.deepStrictEqual(reader.withReader({ sqlite, dataDir: m.dataDir, fs: spy }, () => 1), { ok: true, value: 1 });
    assert.ok(touched.length > 0);
    assert.deepStrictEqual([...new Set(touched)].sort(), ['natsu.db', 'natsu.db.lock']);
  } finally { m.done(); }
});

test('F16・RF75: dataDirOf は NATSU_DATA_DIR が絶対のパスのときだけ使い、相対・空・無いなら APPDATA の natsu\\data（無ければホームの AppData\\Roaming\\natsu\\data）', T, () => {
  const home = path.join(os.tmpdir(), 'ホーム𠮷');
  const abs = path.join(os.tmpdir(), 'データ𠮷', 'data');
  const app = path.join(os.tmpdir(), 'AppData𠮷');
  assert.strictEqual(reader.dataDirOf({ NATSU_DATA_DIR: abs, APPDATA: app }, home), abs);
  for (const d of ['data', './x', '..', '']) assert.strictEqual(reader.dataDirOf({ NATSU_DATA_DIR: d, APPDATA: app }, home), path.join(app, 'natsu', 'data'), JSON.stringify(d));
  assert.strictEqual(reader.dataDirOf({ APPDATA: app }, home), path.join(app, 'natsu', 'data'));
  assert.strictEqual(reader.dataDirOf({}, home), path.join(home, 'AppData', 'Roaming', 'natsu', 'data'));
  assert.strictEqual(reader.dataDirOf({ APPDATA: 'rel' }, home), path.join(home, 'AppData', 'Roaming', 'natsu', 'data'));
  assert.strictEqual(reader.LOCK_STALE_MS, 10 * 60 * 1000);
});
