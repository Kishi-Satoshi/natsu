/* db-snapshot.test.js — 第2a1回 ST9・RF11・RF18: 控えと壊れたとき */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const { tmpData } = require('./helpers/dbtmp');   // data フォルダに natsu.db と見本のページ（種の oplog の時刻は決まった 2026-10-19T00:00:00.000Z）
const S = require('../src/db/snapshot');
const { withSteps, sum } = require('./helpers/steps');   // 段ごとの時刻を残し、予算を越えたら止まった段を言う（0.7.0 の前）

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
    // 消そうとしたことを覚える（投げた誤りを recover が busy に変えても、消そうとした形を見逃さない: G-3 の変異 dn-no-delete-busy）
    // （natsu.db.lock は自分の目印なので消してよい）
    const tried = [];
    const lock = (p) => path.basename(String(p)) === S.LOCK_NAME;
    const stuck = { ...fs, renameSync: (a, b) => { if (own(a) && own(b)) return fs.renameSync(a, b); throw Object.assign(new Error('x'), { code: 'EBUSY' }); },
      unlinkSync: (p) => { if (own(p) || lock(p)) return fs.unlinkSync(p); tried.push(path.basename(String(p))); throw new Error('消そうとした'); },
      rmSync: (p, o) => { if (own(p)) return fs.rmSync(p, o); tried.push(path.basename(String(p))); throw new Error('消そうとした'); } };
    const r = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date(), fs: stuck, waits: [1, 1] });
    assert.deepStrictEqual(tried, [], '名前を変えられないのに消そうとした');
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

// 0.7.0 の前に意図して変えた: CI run 39243734668 の Windows の electron-smoke で、このテストと db-server の ST10 が別のプロセスで同じ時間帯に
// 10 秒の時間切れ（ふだんは約 0.8 秒）。同じ時間帯に engine-fetch（SQLite も worker も控えも使わない）も 8〜19 倍遅く、CI の機械の止まりだった。
// 製品のコードの待ちには上限があり（名前の変更の待ちは RENAME_WAITS_LONG で約 6.3 秒・控えの .gz は RENAME_WAITS_SHORT で約 0.5 秒）、
// この道は名前の変更を 3 回（控えの .gz・natsu.db を退ける・戻す写しを natsu.db にする）する。予算を「前の 10 秒 + その上限」にし、
// 越えたら最後に始めた段と、製品の段ごとの時間（snapshot.js の記録）を言って落ちる
const RF11_BUDGET_MS = 10000 + 2 * sum(S.RENAME_WAITS_LONG) + sum(S.RENAME_WAITS_SHORT);
test('RF11: 戻した後に、控えより後に古い版が書いた JSON のページを取り込む（reimported に数が出る）', { timeout: RF11_BUDGET_MS + 5000 }, async () => {
  const o = oldBuildData({ pages: 1 });
  try {
    await withSteps(RF11_BUDGET_MS, async ({ step, log }) => {
      const M = require('../src/db/migrate');
      step('移す');
      assert.strictEqual(M.migrate({ sqlite, dataDir: o.dataDir }).ok, true);
      const f = path.join(o.dataDir, 'natsu.db');
      step('開く');
      let opened = core.open({ sqlite, file: f });
      try {
        step('控え');
        assert.strictEqual((await S.take({ sqlite, db: opened.db, dataDir: o.dataDir, kind: 'migration', now: () => new Date('2026-10-18T03:00:00Z'), log })).ok, true);
        step('取り込み');
        assert.strictEqual(M.reimport({ db: opened.db, dataDir: o.dataDir }).added, 0);
      } finally { opened.db.close(); }
      step('古い版で書く');
      const later = o.oldBuild((store) => store.createPage({ title: '控えの後に古い版で録った会議', blocks: [], segments: [] }));
      fs.writeFileSync(f, Buffer.alloc(8192, 0x55));
      step('戻す');
      const r = await S.recover({ sqlite, dataDir: o.dataDir, now: () => new Date('2026-10-19T00:00:00Z'), log });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.reimported && r.reimported.added, 1);
      step('読む');
      opened = core.open({ sqlite, file: f, readOnly: true });
      try {
        const got = core.call(opened.db, { role: 'main', cmd: 'page.get', args: { id: later.id } });
        assert.strictEqual(got.ok && got.result && got.result.page.title, '控えの後に古い版で録った会議');
      } finally { opened.db.close(); }
    }, () => `\n走っている段: ${S.activeSteps().join(' / ') || 'なし'}`);
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

// ---- 0.7.0 の前の直し（CI run 39243734668 の Windows の electron-smoke で、RF11 と db-server の ST10 が 10 秒で時間切れ。原因は CI の機械の
// ほかのテストとも重なった止まり。次に起きたとき、どの段で止まったかが記録に出るように、控えと戻しの段ごとの時間を記録に書く。名前と数だけ）
const STEP = /^\S+ \d+ms$/;

test('台: withSteps は予算を越えたら、最後に始めた段と段ごとの時刻と記録の行を言って落ちる（越えなければ fn の答えを返す）', { timeout: 5000 }, async () => {
  assert.strictEqual(await withSteps(1000, async ({ step }) => { step('A'); return 7; }), 7);
  await assert.rejects(withSteps(50, async ({ step, log }) => { step('A'); log('DB: 何かの記録'); step('B'); await new Promise((res) => setTimeout(res, 300)); }, () => '\n足した文'),
    (e) => /予算 50ms を越えた。最後に始めた段: B/.test(e.message) && /A@\d+ms → B@\d+ms/.test(e.message) && e.message.includes('DB: 何かの記録') && e.message.endsWith('足した文'));
});
const stepsOf = (line) => { const m = /（([^（）]*)）$/.exec(line); return m ? m[1].split('・') : []; };

test('ST9: 控えの記録に段ごとの時間（写し・一つに・確かめ・縮め・名前）が出る。確かめ NG のときも、そこまでの段が出る', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    const lines = [];
    const r = await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-19T03:00:00Z'), log: (l) => lines.push(l) });
    assert.strictEqual(r.ok, true);
    const ok = lines.find((l) => l.startsWith('DB: 控え weekly・確かめ ok'));
    assert.ok(ok, JSON.stringify(lines));
    assert.deepStrictEqual(stepsOf(ok).map((s) => s.split(' ')[0]), ['写し', '一つに', '確かめ', '縮め', '名前'], ok);
    assert.ok(stepsOf(ok).every((s) => STEP.test(s)), ok);
    const ng = [];
    await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-19T04:00:00Z'), runCheck: async () => { await new Promise((res) => setTimeout(res, 60)); return 'malformed'; }, log: (l) => ng.push(l) });
    const line = ng.find((l) => l.startsWith('DB: 控え daily・確かめ NG'));
    assert.ok(line, JSON.stringify(ng));
    assert.deepStrictEqual(stepsOf(line).map((s) => s.split(' ')[0]), ['写し', '一つに', '確かめ'], line);
    assert.ok(Number(stepsOf(line)[2].split(' ')[1].replace('ms', '')) >= 50, `確かめの時間が出ていない: ${line}`);
    assert.ok(!lines.concat(ng).some((l) => l.includes(d.dataDir)), '記録にパスを出した');
  } finally { d.done(); }
});

test('ST9・RF18: 控えの名前を変えられずに待ったら回数と時間と符号を書き、取れなければ止まった段を書く', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    const lines = [];
    const stuck = { ...fs, renameSync: (a, b) => { if (String(a).endsWith('.db.gz.tmp')) throw Object.assign(new Error('x'), { code: 'EBUSY' }); return fs.renameSync(a, b); } };
    const r = await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-19T03:00:00Z'), fs: stuck, log: (l) => lines.push(l) });
    assert.deepStrictEqual([r.ok, r.check], [false, 'io']);
    assert.ok(lines.some((l) => /^DB: 名前の変更を 6 回待った（\d+ms・EBUSY）$/.test(l)), JSON.stringify(lines));
    const fail = lines.find((l) => l.startsWith('DB: 控え weekly・取れない（rename）・止まった段 名前'));
    assert.ok(fail, JSON.stringify(lines));
    assert.deepStrictEqual(stepsOf(fail).map((s) => s.split(' ')[0]), ['写し', '一つに', '確かめ', '縮め', '名前'], fail);
  } finally { d.done(); }
});

test('RF11・RF18: 戻すときの記録に段ごとの時間（広げ・確かめ・退け・置き換え・取り込み）と、名前の変更を待った回数が出る', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    d.close();
    let fails = 2;
    const fsx = { ...fs, renameSync: (a, b) => { if (fails-- > 0) throw Object.assign(new Error('x'), { code: 'EPERM' }); return fs.renameSync(a, b); } };
    const lines = [];
    const r = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T00:00:00Z'), fs: fsx, waits: [1, 1, 1], log: (l) => lines.push(l) });
    assert.strictEqual(r.ok, true);
    assert.ok(lines.some((l) => /^DB: 名前の変更を 2 回待った（\d+ms・EPERM）$/.test(l)), JSON.stringify(lines));
    const done = lines.find((l) => l.startsWith('DB: 戻した段'));
    assert.ok(done, JSON.stringify(lines));
    assert.deepStrictEqual(stepsOf(done).map((s) => s.split(' ')[0]), ['広げ', '確かめ', '退け', '置き換え', '取り込み'], done);
    assert.ok(stepsOf(done).every((s) => STEP.test(s)), done);
    // 戻せないとき（名前をずっと変えられない）は、止まった段を書く
    const stuck = { ...fs, renameSync: () => { throw Object.assign(new Error('x'), { code: 'EBUSY' }); } };
    const ng = [];
    const r2 = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T01:00:00Z'), fs: stuck, waits: [1], log: (l) => ng.push(l) });
    assert.deepStrictEqual([r2.ok, r2.code], [false, 'busy']);
    assert.ok(ng.some((l) => l.startsWith('DB: 戻せなかった段・止まった段 退け（')), JSON.stringify(ng));
    assert.ok(!lines.concat(ng).some((l) => l.includes(d.dataDir)), '記録にパスを出した');
  } finally { d.done(); }
});

test('ST9・RF11: 走っている控えと戻しの段は activeSteps() で見える（テストが待ちきれないときに、どの段の途中かを言う）。終わったら消える', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    let release;
    const gate = new Promise((res) => { release = res; });
    let seen = null;
    const p = S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-19T03:00:00Z'),
      runCheck: async (o) => { try { seen = S.activeSteps(); } catch (e) { seen = String(e && e.message); } await gate; return S.workerCheck(o); } });
    for (let i = 0; seen === null && i < 1000; i++) await new Promise((res) => setTimeout(res, 5));
    assert.ok(Array.isArray(seen), `確かめの途中に activeSteps() を読めない: ${seen}`);
    assert.strictEqual(seen.length, 1, JSON.stringify(seen));
    assert.match(seen[0], /^控え weekly: 写し \d+ms・一つに \d+ms・確かめ \d+ms$/);
    release();
    assert.strictEqual((await p).ok, true);
    assert.deepStrictEqual(S.activeSteps(), [], '終わった控えの段が残った');
    d.close();
    let seenR = null;
    const r = await S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T04:00:00Z'), runCheck: async (o) => { seenR = S.activeSteps(); return S.workerCheck(o); } });
    assert.strictEqual(r.ok, true);
    assert.match(seenR[0], /^戻す: 広げ \d+ms・確かめ \d+ms$/);
    assert.deepStrictEqual(S.activeSteps(), []);
  } finally { d.done(); }
});
