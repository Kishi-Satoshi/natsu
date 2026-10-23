/*
 * db.win.test.js — Windows だけで意味のある、議事録の DB のテスト（第2a1回 G-2。RF18・RF1・NTFS の上の WAL の読み手）
 * Windows でないときは、ファイルの頭で抜ける（test.skip にしない。ci.yml は飛ばしたテストを Linux で 0 件しか許さない）。
 * CI の test (windows-latest) は npm test で、electron-smoke は同じテストを Electron の Node（ELECTRON_RUN_AS_NODE=1）でも回す。
 *
 * 別のプロセスは node -e の子（Electron の Node で回すときは electron.exe を ELECTRON_RUN_AS_NODE=1 で）。子は natsu.db を
 * 読み取り専用で開いて、標準入力の行で動く（read → 「T <ページの題名>」、close → 閉じて「CLOSED」を書いて終わる）。
 * 子に渡すパスと ID は環境変数で渡す（日本語と 𠮷 を引数の引用に通さない）。
 */
'use strict';
if (process.platform !== 'win32') return;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');
const { spawn } = require('node:child_process');
const core = require('../src/db/core');
const M = require('../src/db/migrate');
const S = require('../src/db/snapshot');
const { tmpData, oldBuildData, snapshotTree } = require('./helpers/dbtmp');   // どちらも一時フォルダの名前に日本語と 𠮷 が入る

const CHILD_WAIT = { timeout: 20000 };   // 止まったときの見張り（ふつうは 1〜3 秒。子の起動の遅い CI の機械のため）

// 子の中身。文字列の引用は ' だけにする（Windows の引数の引用に " を通さない）。SQL は ? で渡す
const CHILD = [
  "const s = require('node:sqlite'); const fs = require('node:fs');",
  'const d = new s.DatabaseSync(process.env.NATSU_DB, { readOnly: true });',
  "const title = d.prepare('select text from blocks where id = ? and type = ?');",
  "const say = (x) => fs.writeSync(1, x + '\\n');",
  "say('OPEN ' + d.prepare('pragma journal_mode').get().journal_mode);",
  "require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {",
  "  if (l === 'read') { say('T ' + title.get(process.env.NATSU_ID, 'page').text); return; }",
  "  d.close(); say('CLOSED'); process.exit(0);",
  '});',
].join('\n');

function reader(file, id = '') {
  const env = { ...process.env, NATSU_DB: file, NATSU_ID: id };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
  const p = spawn(process.execPath, ['-e', CHILD], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = []; const waiting = []; let buf = ''; let err = '';
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (waiting.length) waiting.shift().resolve(l); else lines.push(l);
    }
  });
  p.stderr.on('data', (c) => { err += c; });
  const exited = new Promise((resolve) => p.on('exit', (code) => {
    for (const w of waiting.splice(0)) w.reject(new Error(`子が終わった（${code}）: ${err.split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join(' ').slice(0, 300)}`));
    resolve(code);
  }));
  return {
    line: () => (lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve, reject) => waiting.push({ resolve, reject }))),
    send: (cmd) => p.stdin.write(`${cmd}\n`),
    exited,
    kill: () => { try { p.kill(); } catch (_) { /* 終わり済み */ } },
  };
}

test('RF18: 別のプロセスが natsu.db を読み取り専用で開いたまま 1.5 秒持つ間に戻しを始めると、名前の変更は待ち、子が閉じたら済む。退けた natsu.db.broken-… も控えも消えない', CHILD_WAIT, async () => {
  const d = tmpData({ pages: 2 });
  let child = null;
  try {
    await S.take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    // 控えの後の直し（戻すと控えの時点になる。直した題は退けた natsu.db.broken-… に残っていなければならない）
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    assert.ok(core.call(d.db, { role: 'app', cmd: 'page.setTitle', args: { id: d.ids[0], title: '控えの後に直した題' }, tx: 'a:win-after-backup' }, {}).ok);
    d.close();
    const f = path.join(d.dataDir, 'natsu.db');
    const backupDir = path.join(d.dataDir, 'backup');
    const backups = snapshotTree(backupDir);
    child = reader(f, d.ids[0]);
    assert.match(await child.line(), /^OPEN /);
    child.send('read');
    assert.strictEqual(await child.line(), 'T 控えの後に直した題');

    // 待ちの刻みはアプリの既定（RENAME_WAITS_LONG。合わせて約 6.3 秒で、1.5 秒の掴みより長い）より細かくする（子が閉じてから
    // 次のやり直しまでを短くし、このテストを 5 秒に収める。既定の刻みは db-snapshot.test.js が見る）
    assert.ok(S.RENAME_WAITS_LONG.reduce((a, b) => a + b, 0) > 1500 * 2, 'アプリの待ちが 1.5 秒の掴みに足りない');
    const waits = [100, 200, 400, 400, 400, 400, 400, 400, 400, 400];
    let settled = false;
    const t0 = Date.now();
    const p = S.recover({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T00:00:00Z'), waits }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const pendingWhileHeld = !settled;   // 子が開いている間は名前を変えられないので、まだ済んでいないはず
    child.send('close');
    assert.strictEqual(await child.line(), 'CLOSED');
    assert.strictEqual(await child.exited, 0);
    const r = await p;
    const ms = Date.now() - t0;
    assert.ok(pendingWhileHeld, `別のプロセスが開いている間に戻しが済んだ（${ms}ms。名前の変更を待っていない）`);
    assert.strictEqual(r.ok, true, `子が閉じた後も戻せない（${r.code}）`);
    assert.strictEqual(r.from, '2026-10-18T03:00:00.000Z');
    assert.ok(r.brokenAs && fs.existsSync(path.join(d.dataDir, r.brokenAs)), '退けた natsu.db.broken-… が無い');
    assert.deepStrictEqual(snapshotTree(backupDir), backups, '控えが変わった・消えた');
    assert.ok(!fs.existsSync(path.join(d.dataDir, 'natsu.db.lock')), 'lock を消し忘れた');
    assert.ok(!fs.existsSync(path.join(d.dataDir, 'natsu.db.restoring')), '一時ファイルが残った');
    // 戻した natsu.db は控えの時点。退けたほうに控えの後の直しが残っている（何も失っていない）
    const restored = new sqlite.DatabaseSync(f, { readOnly: true });
    try {
      assert.strictEqual(restored.prepare('select count(*) c from blocks where type = \'page\'').get().c, 2);
      assert.notStrictEqual(restored.prepare('select text from blocks where id = ?').get(d.ids[0]).text, '控えの後に直した題');
    } finally { restored.close(); }
    const broken = new sqlite.DatabaseSync(path.join(d.dataDir, r.brokenAs), { readOnly: true });
    try { assert.strictEqual(broken.prepare('select text from blocks where id = ?').get(d.ids[0]).text, '控えの後に直した題'); } finally { broken.close(); }
  } finally {
    if (child) child.kill();
    d.done();
  }
});

test('RF1: os.tmpdir() の下の日本語と 𠮷 の名前のフォルダで、移行・控え・戻しが通る（元の JSON は1バイトも変わらない）', CHILD_WAIT, async () => {
  const o = oldBuildData({ pages: 3 });
  let db = null;
  try {
    assert.ok(o.dataDir.startsWith(os.tmpdir()) && /議事録𠮷/.test(o.dataDir), 'フォルダの名前に日本語と 𠮷 が無い');
    const before = { pages: snapshotTree(path.join(o.dataDir, 'pages')), transcripts: snapshotTree(path.join(o.dataDir, 'transcripts')) };
    const m = M.migrate({ sqlite, dataDir: o.dataDir });
    assert.strictEqual(m.ok, true, `移せない（${m.code}）`);
    const f = path.join(o.dataDir, 'natsu.db');
    const opened = core.open({ sqlite, file: f });
    assert.strictEqual(opened.state, 'ok');
    db = opened.db;
    const titles = () => core.call(db, { role: 'app', cmd: 'pages.list', args: {} }, { labels: {} }).result.map((p) => p.title).sort();
    const want = titles();
    assert.strictEqual(want.length, 3);
    assert.ok(want.every((t) => t.includes('𠮷')), '題名の 𠮷 が移っていない');
    const b = await S.take({ sqlite, db, dataDir: o.dataDir, kind: 'migration', now: () => new Date('2026-10-18T03:00:00Z') });
    assert.deepStrictEqual([b.ok, b.check], [true, 'ok'], '控えを取れない');
    db.close(); db = null;
    const bad = Buffer.from(fs.readFileSync(f)); bad.fill(0x55, 100, 4096); fs.writeFileSync(f, bad);   // 頭の後ろを壊す
    const r = await S.recover({ sqlite, dataDir: o.dataDir, now: () => new Date('2026-10-19T00:00:00Z') });
    assert.strictEqual(r.ok, true, `戻せない（${r.code}）`);
    assert.deepStrictEqual(fs.readFileSync(path.join(o.dataDir, r.brokenAs)), bad, '退けたファイルの中身が変わった');
    db = core.open({ sqlite, file: f }).db;
    assert.deepStrictEqual(titles(), want, '戻した DB の一覧が移した時と違う');
    assert.strictEqual(core.call(db, { role: 'app', cmd: 'pages.searchFull', args: { q: '予算案の作成' } }, {}).result.total, 3);
    assert.deepStrictEqual({ pages: snapshotTree(path.join(o.dataDir, 'pages')), transcripts: snapshotTree(path.join(o.dataDir, 'transcripts')) }, before, '元の JSON が変わった');
  } finally {
    try { if (db) db.close(); } catch (_) { /* 閉じ済み */ }
    o.done();
  }
});

test('NTFS の上の WAL: 別のプロセスの読み取りの接続は、確定した行だけを見る（書いている途中の行は見えず、確定したら次の読みで見える）', CHILD_WAIT, async () => {
  const d = tmpData({ pages: 1 });
  let child = null;
  try {
    const id = d.ids[0];
    const first = d.db.prepare('select text from blocks where id = ?').get(id).text;
    child = reader(d.file, id);
    assert.strictEqual(await child.line(), 'OPEN wal', '別のプロセスから WAL で開けていない');
    child.send('read');
    assert.strictEqual(await child.line(), `T ${first}`);
    d.db.exec('BEGIN IMMEDIATE');
    d.db.prepare('update blocks set text = ? where id = ?').run('確定する前の題', id);
    child.send('read');
    assert.strictEqual(await child.line(), `T ${first}`, '確定していない行が別のプロセスから見えた');
    d.db.exec('COMMIT');
    child.send('read');
    assert.strictEqual(await child.line(), 'T 確定する前の題', '確定した行が別のプロセスから見えない');
    // 命令の台（core.call）で書いたものも、次の読みで見える
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    assert.ok(core.call(d.db, { role: 'app', cmd: 'page.setTitle', args: { id, title: '命令で直した題' }, tx: 'a:win-wal-reader' }, {}).ok);
    child.send('read');
    assert.strictEqual(await child.line(), 'T 命令で直した題');
    child.send('close');
    assert.strictEqual(await child.line(), 'CLOSED');
    assert.strictEqual(await child.exited, 0);
  } finally {
    if (child) child.kill();
    try { d.db.exec('ROLLBACK'); } catch (_) { /* 確定済み */ }
    d.done();
  }
});
