/* db-snapshot.test.js — 第2a1回 ST9・RF11・RF18: 控えと壊れたとき */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const { tmpData } = require('./helpers/dbtmp');   // data フォルダに natsu.db と見本のページ（種の oplog の時刻は決まった 2026-10-19T00:00:00.000Z）
const S = require('../src/db/snapshot');

test('ST9: 控えは確かめてから縮めて残し、確かめた接続を閉じる（閉じていなければ名前を変えられない形で見る）', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 3 });
  try {
    const opened = [];
    const r = await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-19T03:00:00Z'), track: (c) => opened.push(c) });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.check, 'ok');
    // daily を頼んでも、その週（月曜はじまり）に weekly がまだ無ければ weekly になる（最初の控えはいつも weekly）
    assert.match(path.basename(r.file), /^natsu-2026-10-19T03-00-00-000Z-weekly\.db\.gz$/);
    assert.ok(opened.every((c) => c.isOpen === false), '確かめた接続を閉じていない（Windows では回せない）');
    assert.ok(!fs.readdirSync(path.join(d.dataDir, 'backup')).some((n) => n.endsWith('.db')), '縮める前の写しが残った');
  } finally { d.done(); }
});

test('ST9: 確かめが ok でない控えは残さない（壊れた控えから戻さない）', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    const r = await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date(), runCheck: async () => 'malformed' });
    assert.deepStrictEqual([r.ok, r.check], [false, 'malformed']);
    assert.deepStrictEqual(fs.readdirSync(path.join(d.dataDir, 'backup')), []);
  } finally { d.done(); }
});

test('ST9: 回すと daily 3・weekly 1・migration は残る。oplog は残る最も古い控えより前を消し、purge は残す', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    for (let day = 1; day <= 9; day++) await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date(Date.UTC(2026, 9, day, 3)) });
    await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'migration', now: () => new Date(Date.UTC(2026, 8, 1)) });
    S.rotate({ dataDir: d.dataDir, now: () => new Date(Date.UTC(2026, 9, 9, 4)) });
    const left = fs.readdirSync(path.join(d.dataDir, 'backup')).sort();
    assert.strictEqual(left.filter((n) => n.includes('-daily')).length, 3);
    // 2026-10-01 は木曜。週は月曜はじまりなので 10-01（その週の最初）と 10-05 が weekly になり、残すのは新しい 1 つ
    assert.deepStrictEqual(left.filter((n) => n.includes('-weekly')).map((n) => n.slice(6, 16)), ['2026-10-05']);
    assert.ok(left.some((n) => n.includes('-migration')), '移行の控えを回した（1.x の間残す約束）');
    d.addOplog([{ at: '2026-09-01T00:00:00.000Z', action: 'page.setTitle' }, { at: '2026-09-01T00:00:00.000Z', action: 'meeting.discard', purge: true }, { at: '2026-10-09T00:00:00.000Z', action: 'page.setTitle' }]);
    S.pruneOplog({ db: d.db, before: S.oldestKeptAt({ dataDir: d.dataDir }) });
    // 見るのは足した3行だけ（種の行は 2026-10-19 で、境より新しいので残る）
    assert.deepStrictEqual(d.db.prepare("select action from oplog where at < '2026-10-10' order by seq").all().map((r) => r.action), ['meeting.discard', 'page.setTitle']);
  } finally { d.done(); }
});

test('RF11: 壊れた natsu.db は消さずに退け、確かめ済みの最新の控えから戻し、その時刻を返す', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 2 });
  try {
    await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    d.close();
    const f = path.join(d.dataDir, 'natsu.db');
    const bad = Buffer.from(fs.readFileSync(f)); bad.fill(0x55, 100, 4096); fs.writeFileSync(f, bad);   // 頭の後ろを壊す
    const r = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T00:00:00Z') });
    assert.strictEqual(r.ok, true); assert.strictEqual(r.from, '2026-10-18T03:00:00.000Z');
    assert.ok(fs.existsSync(path.join(d.dataDir, r.brokenAs)), '壊れたファイルを消した');
    assert.deepStrictEqual(fs.readFileSync(path.join(d.dataDir, r.brokenAs)), bad, '退けたファイルの中身が変わった');
    const db = new sqlite.DatabaseSync(f, { readOnly: true });
    assert.strictEqual(db.prepare("select count(*) c from blocks where type='page'").get().c, 2); db.close();
    assert.ok(!fs.existsSync(path.join(d.dataDir, 'natsu.db.lock')), 'lock を消し忘れた');
  } finally { d.done(); }
});

test('RF18: 名前を変えられない間（EPERM・EBUSY）は消さずに待ってやり直し、だめなら busy で何も消さない', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date() }); d.close();
    let fails = 3;
    const fsx = { ...fs, renameSync: (a, b) => { if (fails-- > 0) throw Object.assign(new Error('x'), { code: 'EPERM' }); return fs.renameSync(a, b); } };
    assert.strictEqual((await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date(), fs: fsx, waits: [1, 1, 1, 1] })).ok, true);
    const f = path.join(d.dataDir, 'natsu.db');
    const before = fs.readFileSync(f);
    const backups = fs.readdirSync(path.join(d.dataDir, 'backup'));
    // 消してよいのは自分の一時ファイル natsu.db.restoring だけ
    const own = (p) => /\.restoring$/.test(String(p));
    const stuck = { ...fs, renameSync: (a, b) => { if (own(a) && own(b)) return fs.renameSync(a, b); throw Object.assign(new Error('x'), { code: 'EBUSY' }); },
      unlinkSync: (p) => { if (own(p)) return fs.unlinkSync(p); throw new Error('消そうとした'); }, rmSync: (p, o) => { if (own(p)) return fs.rmSync(p, o); throw new Error('消そうとした'); } };
    const r = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date(), fs: stuck, waits: [1, 1] });
    assert.deepStrictEqual([r.ok, r.code], [false, 'busy']);
    assert.deepStrictEqual(fs.readFileSync(f), before, '戻せなかったのに natsu.db が変わった');
    assert.deepStrictEqual(fs.readdirSync(path.join(d.dataDir, 'backup')), backups, '控えが消えた');
    assert.ok(!fs.existsSync(f + '.restoring'), '一時ファイルが残った');
  } finally { d.done(); }
});

test('F8・F12: 掴まれて開けない・確かめが走れないは「壊れた」にしない。控えが無ければ natsu.db に触れない。半端な控えは飛ばして古い控えから戻す', { timeout: 10000 }, async () => {
  // node:sqlite の誤りは { code: 'ERR_SQLITE_ERROR', errcode, errstr }（Node 22.22 で確かめた: 開けない 14・壊れた形 26）
  for (const [errcode, name] of [[5, 'BUSY'], [6, 'LOCKED'], [14, 'CANTOPEN'], [10, 'IOERR'], [3, 'PERM'], [8, 'READONLY']]) {
    assert.strictEqual(S.classifyOpenError(Object.assign(new Error(name), { code: 'ERR_SQLITE_ERROR', errcode })), 'unavailable', name);
  }
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) assert.strictEqual(S.classifyOpenError(Object.assign(new Error('x'), { code })), 'unavailable', code);
  assert.strictEqual(S.classifyOpenError(Object.assign(new Error('file is not a database'), { code: 'ERR_SQLITE_ERROR', errcode: 26 })), 'corrupt');
  assert.strictEqual(S.classifyOpenError(Object.assign(new Error('database disk image is malformed'), { code: 'ERR_SQLITE_ERROR', errcode: 11 })), 'corrupt');
  assert.strictEqual(S.checkResult({ error: 'worker を起こせない' }), 'unavailable');
  assert.strictEqual(S.checkResult('ok'), 'ok');
  assert.strictEqual(S.checkResult('malformed'), 'corrupt');
  const d = tmpData({ pages: 2 });
  try {
    d.close();
    const f = path.join(d.dataDir, 'natsu.db');
    const before = fs.readFileSync(f);
    const r0 = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T00:00:00Z') });
    assert.deepStrictEqual([r0.ok, r0.code], [false, 'no-snapshot']);
    assert.deepStrictEqual(fs.readFileSync(f), before, '控えが無いのに natsu.db を退けた（次の起動で JSON から移し直してしまう）');
    const d2 = tmpData({ pages: 2 });
    await S.take({ sqlite, db: d2.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-17T03:00:00Z') });
    await S.take({ sqlite, db: d2.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    d2.done();
    const newest = path.join(d.dataDir, 'backup', 'natsu-2026-10-18T03-00-00-000Z-daily.db.gz');
    fs.writeFileSync(newest, fs.readFileSync(newest).subarray(0, 100));   // 縮めている途中で落ちた形
    const r = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T00:00:00Z') });
    assert.deepStrictEqual([r.ok, r.from], [true, '2026-10-17T03:00:00.000Z']);
  } finally { d.done(); }
});

test('ST9: 回すときに消せない控え（掴まれている）があっても投げずに残りを回し、次に消す', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    for (let day = 1; day <= 5; day++) await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date(Date.UTC(2026, 9, day + 4, 3)) });
    const held = { ...fs, unlinkSync: (p) => { if (String(p).includes('2026-10-06')) throw Object.assign(new Error('x'), { code: 'EBUSY' }); return fs.unlinkSync(p); } };
    assert.doesNotThrow(() => S.rotate({ dataDir: d.dataDir, now: () => new Date(Date.UTC(2026, 9, 9, 4)), fs: held }));
    assert.ok(fs.readdirSync(path.join(d.dataDir, 'backup')).some((n) => n.includes('2026-10-06')));
    S.rotate({ dataDir: d.dataDir, now: () => new Date(Date.UTC(2026, 9, 9, 5)) });
    assert.ok(!fs.readdirSync(path.join(d.dataDir, 'backup')).some((n) => n.includes('2026-10-06')), '次に回したときにも消さない');
  } finally { d.done(); }
});

test('P9: UNC のパスはネットワークの場所', { timeout: 5000 }, () => {
  assert.strictEqual(S.isNetworkPath('\\\\server\\share\\natsu\\data'), true);
  assert.strictEqual(S.isNetworkPath('C:\\Users\\a\\AppData\\Roaming\\natsu\\data'), false);
});

// ---- 計画のテストに足した確かめ（D-6 の実装で、変異が生き残らないように）
const core = require('../src/db/core');
const { oldBuildData } = require('./helpers/dbtmp');

test('ST9: 移行の控えは2つ以上あっても回さない。take は前に落ちた take の .tmp を片付ける', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    const dir = path.join(d.dataDir, 'backup');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'natsu-2026-08-01T00-00-00-000Z-daily.db.raw.tmp'), 'x');
    fs.writeFileSync(path.join(dir, 'natsu-2026-08-01T00-00-00-000Z-daily.db.gz.tmp'), 'x');
    for (const m of [7, 8]) await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'migration', now: () => new Date(Date.UTC(2026, m, 1)) });
    assert.ok(!fs.readdirSync(dir).some((n) => n.endsWith('.tmp')), '前の take の一時ファイルが残った');
    assert.deepStrictEqual(S.rotate({ dataDir: d.dataDir, now: () => new Date(Date.UTC(2026, 9, 1)) }), []);
    assert.strictEqual(fs.readdirSync(dir).filter((n) => n.endsWith('-migration.db.gz')).length, 2);
    assert.strictEqual(S.oldestKeptAt({ dataDir: d.dataDir }), null, '移行の控えを oplog を消す境にした（いつまでも消せない）');
  } finally { d.done(); }
});

test('RF11・F8: 残っていた -wal も一緒に退け（戻した DB に当てない）、動かせない -wal があれば natsu.db を元の名前に戻して busy', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 2 });
  try {
    await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    d.close();
    const f = path.join(d.dataDir, 'natsu.db');
    const wal = Buffer.from('前の起動の -wal（議事録𠮷）');
    fs.writeFileSync(f + '-wal', wal);
    const before = fs.readFileSync(f);
    const held = { ...fs, renameSync: (a, b) => { if (String(a).endsWith('natsu.db-wal')) throw Object.assign(new Error('x'), { code: 'EBUSY' }); return fs.renameSync(a, b); } };
    const r0 = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T00:00:00Z'), fs: held, waits: [1] });
    assert.deepStrictEqual([r0.ok, r0.code], [false, 'busy']);
    assert.deepStrictEqual(fs.readFileSync(f), before, 'natsu.db を元の名前に戻していない');
    assert.deepStrictEqual(fs.readFileSync(f + '-wal'), wal);
    assert.deepStrictEqual(fs.readdirSync(d.dataDir).filter((n) => /broken|restoring/.test(n)), [], '退けかけたものが残った');
    const r = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T00:00:00Z') });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(fs.readFileSync(path.join(d.dataDir, r.brokenAs + '-wal')), wal, '-wal を退けていない');
    assert.deepStrictEqual(fs.readFileSync(path.join(d.dataDir, r.brokenAs)), before);
    const db = new sqlite.DatabaseSync(f, { readOnly: true });
    try { assert.strictEqual(db.prepare('pragma quick_check').get().quick_check, 'ok'); } finally { db.close(); }
  } finally { d.done(); }
});

test('RF11: 戻した後に、控えより後に古い版が書いた JSON のページを取り込む（reimported に数が出る）', { timeout: 10000 }, async () => {
  const o = oldBuildData({ pages: 1 });
  try {
    const M = require('../src/db/migrate');
    assert.strictEqual(M.migrate({ sqlite, dataDir: o.dataDir }).ok, true);
    const f = path.join(o.dataDir, 'natsu.db');
    let opened = core.open({ sqlite, file: f });
    try {
      assert.strictEqual((await S.take({ sqlite, db: opened.db, dataDir: o.dataDir, kind: 'migration', now: () => new Date('2026-10-18T03:00:00Z') })).ok, true);
      assert.strictEqual(M.reimport({ db: opened.db, dataDir: o.dataDir }).added, 0);
    } finally { opened.db.close(); }
    const later = o.oldBuild((store) => store.createPage({ title: '控えの後に古い版で録った会議', blocks: [], segments: [] }));
    fs.writeFileSync(f, Buffer.alloc(8192, 0x55));
    const r = await S.recover({ sqlite, dataDir: o.dataDir, now: () => new Date('2026-10-19T00:00:00Z') });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reimported && r.reimported.added, 1);
    opened = core.open({ sqlite, file: f, readOnly: true });
    try {
      const got = core.call(opened.db, { role: 'main', cmd: 'page.get', args: { id: later.id } });
      assert.strictEqual(got.ok && got.result && got.result.page.title, '控えの後に古い版で録った会議');
    } finally { opened.db.close(); }
  } finally { o.done(); }
});

test('F12: 確かめの worker は、開けないファイルを「走れない」と答え、壊れたファイル・全文検索の索引が合わないファイルを「壊れた」と答える', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    d.close();
    assert.strictEqual(await S.workerCheck({ file: d.file }), 'ok');
    assert.strictEqual(S.checkResult(await S.workerCheck({ file: path.join(d.dataDir, '無いフォルダ', 'natsu.db') })), 'unavailable');
    const junk = path.join(d.dataDir, '壊れた.db');
    fs.writeFileSync(junk, Buffer.alloc(8192, 0x55));
    assert.strictEqual(S.checkResult(await S.workerCheck({ file: junk })), 'corrupt');
    // quick_check は通るが、全文検索の索引が中身の表と合わない（1行を索引から抜く）
    const raw = new sqlite.DatabaseSync(d.file);
    try {
      const row = raw.prepare("select rid, fold from blocks where fold <> '' limit 1").get();
      raw.prepare("insert into blocks_fts(blocks_fts, rowid, fold) values('delete', ?, ?)").run(row.rid, row.fold);
      assert.strictEqual(raw.prepare('pragma quick_check').get().quick_check, 'ok');
    } finally { raw.close(); }
    assert.strictEqual(await S.workerCheck({ file: d.file }), 'fts');
  } finally { d.done(); }
});

test('RF11・F8: 広げられても確かめの通らない控え・確かめが走れない控えからは戻さず、古い控えへ進む', { timeout: 10000 }, async () => {
  for (const first of ['quick-check', { error: 'worker' }]) {
    const d = tmpData({ pages: 2 });
    try {
      await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-17T03:00:00Z') });
      await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
      d.close();
      const f = path.join(d.dataDir, 'natsu.db');
      fs.writeFileSync(f, Buffer.alloc(8192, 0x55));
      const checks = [];
      const runCheck = async ({ file }) => { checks.push(path.basename(file)); return checks.length === 1 ? first : 'ok'; };
      const r = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T00:00:00Z'), runCheck });
      assert.deepStrictEqual([r.ok, r.from], [true, '2026-10-17T03:00:00.000Z'], `確かめの答え ${JSON.stringify(first)} の控えから戻した`);
      assert.deepStrictEqual(checks, ['natsu.db.restoring', 'natsu.db.restoring']);
      assert.ok(!fs.existsSync(f + '.restoring'), '一時ファイルが残った');
    } finally { d.done(); }
  }
});

test('RF11: lock を書けなくても recover は投げずに busy を返し、natsu.db に触れない', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    d.close();
    const f = path.join(d.dataDir, 'natsu.db');
    const before = fs.readFileSync(f);
    const noLock = { ...fs, writeFileSync: (p, ...rest) => { if (String(p).endsWith('natsu.db.lock')) throw Object.assign(new Error('x'), { code: 'EACCES' }); return fs.writeFileSync(p, ...rest); } };
    const r = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T00:00:00Z'), fs: noLock });
    assert.deepStrictEqual([r.ok, r.code], [false, 'busy']);
    assert.deepStrictEqual(fs.readFileSync(f), before);
  } finally { d.done(); }
});
