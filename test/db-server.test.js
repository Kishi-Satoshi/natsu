/* db-server.test.js — 第2a1回 ST2・ST5・T4b: 口のつなぎと当て直し */
'use strict';
const { titleAt } = require('./helpers/titles');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const sqlite = require('node:sqlite');
const { MessageChannel } = require('node:worker_threads');
const { tmpData, electronShape, snapshotTree } = require('./helpers/dbtmp');   // electronShape: worker_threads の口を Electron の形（{ data } と start）に包む
const { startServer } = require('../src/db/server');
const { withSteps } = require('./helpers/steps');   // 段ごとの時刻を残し、予算を越えたら止まった段を言う（0.7.0 の前）

// 決まった時間ではなく、条件がそろうまで待つ（ほかのレーンのテストで機械が混んでいても落ちない。5 秒で諦める）。
// 諦めたときは detail()（子の記録の行など）も言う（0.7.0 の前。どの段で止まったかを残す）
async function waitFor(pred, what, ms = 5000, detail = () => '') {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`待ちきれない: ${what}（${ms}ms）${detail()}`);
    await new Promise((res) => setTimeout(res, 10));
  }
}

function boot(d, opts = {}) {
  const fromServer = [];
  const parent = electronShape.parent((m) => fromServer.push(m));   // parentPort の偽物: on('message', ({ data, ports }) …)・postMessage
  startServer({ parentPort: parent, sqlite: require('node:sqlite'), ...opts });
  parent.emit({ type: 'init', dataDir: d.dataDir, labels: {}, network: false });
  const clients = [];
  const late = [];   // 子の側の口が閉じた後に、子がその口へ送ったもの
  const port = (role) => {
    const ch = new MessageChannel();
    const sp = electronShape.port(ch.port1);
    const seen = { closed: false };
    sp.on('close', () => { seen.closed = true; });
    const send = sp.postMessage;
    sp.postMessage = (m) => { if (seen.closed) late.push(m); send(m); };
    parent.emit({ type: 'port', role }, [sp]);
    const c = electronShape.client(ch.port2);
    c.serverSeesClose = () => seen.closed;
    clients.push(c);
    return c;
  };
  // 子の記録の行（snapshot.js の段ごとの時間を含む。待ちきれないときに言う）
  const logs = () => fromServer.filter((m) => m.type === 'log').map((m) => m.line);
  const detail = () => `\n子の記録:\n${logs().join('\n')}\n走っている段: ${require('../src/db/snapshot').activeSteps().join(' / ') || 'なし'}`;
  const ready = (ms) => waitFor(() => fromServer.some((m) => m.type === 'ready'), 'ready', ms, detail);
  // 子を閉じて closed を待ち、テストの側の口も閉じる（Windows で DB を掴んだままフォルダを消さない）
  const stop = async (ms) => {
    const before = fromServer.filter((m) => m.type === 'closed').length;
    parent.emit({ type: 'close' });
    await waitFor(() => fromServer.filter((m) => m.type === 'closed').length > before, 'closed', ms, detail);
    for (const c of clients.splice(0)) c.close();
  };
  return { fromServer, port, parent, ready, stop, late, logs };
}

const readyMsg = (s) => s.fromServer.find((m) => m.type === 'ready');

test('ST5: 口ごとの役は main が付け、頼みの中で役を名乗っても変わらない。書くと全部の口に changed', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  const s = boot(d);
  try {
    const app = s.port('app'); const main = s.port('main');
    const seen = []; main.onEvent((e) => seen.push(e));
    const r = await app.ask({ id: 1, cmd: 'meeting.discard', args: { pageId: d.ids[0], role: 'main' }, tx: 'a:t-000001' });
    assert.deepStrictEqual([r.ok, r.code], [false, 'forbidden']);
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    const w = await app.ask({ id: 2, cmd: 'page.setTitle', args: { id: d.ids[0], title: '新しい題' }, tx: 'a:t-000002' });
    assert.strictEqual(w.ok, true);
    assert.deepStrictEqual([d.peek().oplogCount('a:t-000002'), d.peek().getPage(d.ids[0]).title], [1, '新しい題']);
    await new Promise((res) => setTimeout(res, 50));
    assert.deepStrictEqual(seen, [{ event: 'changed', pageIds: [d.ids[0]], actor: 'me' }]);
    assert.ok(s.fromServer.some((m) => m.type === 'ready' && m.state === 'ok'));
    assert.ok(s.fromServer.every((m) => m.type !== 'log' || !m.line.includes(d.dataDir)), '記録にパスを出した');
    for (const f of ['src/db/server.js', 'src/db/commands.js', 'src/db/migrate.js', 'src/db/snapshot.js', 'src/main.js']) assert.ok(!require('node:fs').readFileSync(f, 'utf8').includes('registerForTest'), `${f} が試しの表を使った`);
  } finally { await s.stop(); d.done(); }
});

test('ST2: close はチェックポイントして閉じ、closed を返す（-wal が空）', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  try {
    const s = boot(d);
    s.parent.emit({ type: 'close' });
    await waitFor(() => s.fromServer.some((m) => m.type === 'closed'), 'closed');
    const fs = require('node:fs');
    assert.ok(!fs.existsSync(d.file + '-wal') || fs.statSync(d.file + '-wal').size === 0);
  } finally { d.done(); }
});

test('T4b: 時点 k の控えに k より後の oplog を当て直すと、今の表と同じ（purge を含む）', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 3 });
  try {
    const copy = await d.copyNow();           // 時点 k の写し（backup() は非同期）
    const k = d.lastSeq();
    d.runScript();                            // 題名・メモ・ブロックの足し引き・並べ替え・ToDo・発言の直し・会議の写し → 締め・取り消し（purge）・ゴミ箱
    const ops = d.db.prepare('select ops from oplog where seq > ? order by seq').all(k).map((r) => JSON.parse(r.ops));
    for (const o of ops) require('../src/db/ops').applyOps(copy, o, 'forward');
    assert.deepStrictEqual(d.dump(copy), d.dump(d.db));   // blocks と segments の全部の行（rid を除く）
    // 見本が一通りの操作を含むこと（当て直しの比べが空振りしない）
    const kinds = new Set(ops.flat().map((o) => o.op));
    for (const op of ['add', 'move', 'set', 'text', 'trash', 'purge', 'seg']) assert.ok(kinds.has(op), `見本に ${op} が無い`);
    assert.ok(!d.dump(d.db)[0].some((r) => r.page_id === 'pm0002'), '取り消した会議が残った');
  } finally { d.done(); }
});

test('ST2: N 件「書けた」と返した後に書き手を強制終了しても、開き直すと N 件ともある（synchronous=FULL）', { timeout: 10000 }, () => {
  const { spawnSync } = require('node:child_process');
  const d = tmpData({ pages: 1 }); d.close();
  try {
    // 子は core で20件書き、1件ごとに「書けた」を出してから自分を SIGKILL する（閉じない・チェックポイントしない）
    const r = spawnSync(process.execPath, [require.resolve('./helpers/dbtmp'), 'write-and-die', d.dataDir, '20'], { encoding: 'utf8' });
    assert.strictEqual(r.stdout.trim().split('\n').filter((l) => l.startsWith('ack ')).length, 20);
    const db = new (require('node:sqlite').DatabaseSync)(d.file);
    assert.strictEqual(db.prepare("select count(*) c from oplog where tx like 'm:die-%'").get().c, 20, '「書けた」と返した書き込みが消えた');
    db.close();
  } finally { d.done(); }
});

test('F8: 一度移した後に natsu.db が無くなっても、JSON から移し直さず控えから戻す', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 2, withJson: true });   // pages/ に JSON もある（移した後の形）
  let s = null;
  try {
    await require('../src/db/snapshot').take({ sqlite: require('node:sqlite'), db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    d.close();
    require('node:fs').renameSync(d.file, d.file + '.broken-2026-10-19T00-00-00-000Z');
    s = boot(d);
    await s.ready();
    assert.ok(!s.fromServer.some((m) => m.type === 'migrate-plan'), '控えがあるのに JSON から移し直そうとした');
    assert.ok(s.fromServer.some((m) => m.type === 'ready' && m.state === 'ok'));
    // 戻した後の取り込みは、移した後の指紋のままなので何も足さない（同じ議事録が2つにならない）
    const main = s.port('main');
    const list = await main.ask({ id: 1, cmd: 'pages.list', args: {} });
    assert.deepStrictEqual(list.result.map((p) => p.id).sort(), d.ids);
    const st = await main.ask({ id: 2, cmd: 'db.status', args: {} });
    assert.strictEqual(st.result.startup.restored.from, '2026-10-18T03:00:00.000Z', '知らせ D6 の時刻が無い');
    assert.ok(fs.existsSync(d.file + '.broken-2026-10-19T00-00-00-000Z'), '退けてあったものを消した');
  } finally { if (s) await s.stop(); d.done(); }
});

// ---------------------------------------------------------------- 計画のテストに足した確かめ（M-2a〜M-4 が server.js に頼るところ）

test('ST10: pages/ に JSON があり natsu.db が無ければ数を送って待ち、移したら頼みを受ける前に移行の控えを取る（元の JSON は変えない）', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 2, withJson: true });
  let s = null;
  try {
    d.close();
    fs.rmSync(d.file);   // 移す前の形（JSON だけ）にする。控えも退けたものも無い
    for (const sfx of ['-wal', '-shm']) fs.rmSync(d.file + sfx, { force: true });
    fs.writeFileSync(path.join(d.dataDir, 'natsu.db.lock'), 'pid 1\nat 2026-10-18T00:00:00.000Z\n');   // 前の起動の残り
    const before = snapshotTree(path.join(d.dataDir, 'pages'));
    s = boot(d);
    await waitFor(() => s.fromServer.some((m) => m.type === 'migrate-plan'), 'migrate-plan');
    const plan = s.fromServer.find((m) => m.type === 'migrate-plan');
    assert.deepStrictEqual(plan.counts, { pages: 2, segments: 6, broken: 0, unreadable: 0, badId: 0, badShape: 0, fixedIds: 0 });
    assert.ok(!fs.existsSync(d.file), '窓の答えの前に natsu.db を作った');
    assert.ok(!fs.existsSync(path.join(d.dataDir, 'natsu.db.lock')), '前の起動の残りの lock を消していない');
    // 窓の答えの前に届いた書き込みは、用意ができるまで待たせる（移行の控えには入らない）
    const app = s.port('app');
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    const w = app.ask({ id: 1, cmd: 'page.setTitle', args: { id: d.ids[0], title: '移した後に直した題' }, tx: 'a:t-000001' });
    await new Promise((res) => setTimeout(res, 30));
    assert.ok(!s.fromServer.some((m) => m.type === 'ready'));
    s.parent.emit({ type: 'migrate', go: false });   // 「移す」でない答えでは移さない（窓を閉じて終えるのは main）
    await new Promise((res) => setTimeout(res, 30));
    assert.ok(!fs.existsSync(d.file) && !s.fromServer.some((m) => m.type === 'ready'), '「移す」でないのに移した');
    s.parent.emit({ type: 'migrate', go: true });
    assert.strictEqual((await w).ok, true);
    assert.ok(s.fromServer.some((m) => m.type === 'progress' && m.done === 2 && m.total === 2), '進み具合を送っていない');
    assert.strictEqual(readyMsg(s).state, 'ok');
    assert.ok(Number.isInteger(readyMsg(s).pid) && readyMsg(s).version === 1 && readyMsg(s).selfTest.trigram === true);
    const backups = fs.readdirSync(path.join(d.dataDir, 'backup')).filter((n) => /-migration\.db\.gz$/.test(n));
    assert.strictEqual(backups.length, 1, '移行の控えが無い');
    const raw = path.join(d.dir, 'mig.db');
    fs.writeFileSync(raw, zlib.gunzipSync(fs.readFileSync(path.join(d.dataDir, 'backup', backups[0]))));
    const c = new sqlite.DatabaseSync(raw);
    try {
      assert.strictEqual(c.prepare('select text from blocks where id = ?').get(d.ids[0]).text, `${titleAt(require('./helpers/dbtmp').SEED_AT)} 1`, '移行の控えに移した後の書き込みが入った');
    } finally { c.close(); }
    assert.deepStrictEqual(snapshotTree(path.join(d.dataDir, 'pages')), before, '元の JSON が変わった');
    assert.ok(s.fromServer.some((m) => m.type === 'log' && /^DB: 移行 ページ 2・発言 6・飛ばした 0（[\d.]+秒）$/.test(m.line)));
    // 移した起動では、飛ばしたものの知らせ D3 は移行の数で出す。直後の取り込みの skippedChanged は偽（同じ知らせを2回出さない）
    const st = await s.port('main').ask({ id: 2, cmd: 'db.status', args: {} });
    assert.deepStrictEqual([st.result.startup.migrated.pages, st.result.startup.reimport.skippedChanged], [2, false]);
  } finally { if (s) await s.stop(); d.done(); }
});

test('ST10: 移行の確かめが合わなければ natsu.db を作らず state failed。子は生きたまま全部の頼みに unavailable', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1, withJson: true });
  let s = null;
  try {
    d.close();
    fs.rmSync(d.file);
    for (const sfx of ['-wal', '-shm']) fs.rmSync(d.file + sfx, { force: true });
    const before = snapshotTree(path.join(d.dataDir, 'pages'));
    s = boot(d, { env: { NATSU_TEST_MIGRATE_VERIFY_FAIL: '1' } });
    await waitFor(() => s.fromServer.some((m) => m.type === 'migrate-plan'), 'migrate-plan');
    // 移行の窓の間に届いて待たされていた頼みも、失敗したら unavailable で返す（待ちっぱなしにしない: F7）
    const early = s.port('app').ask({ id: 6, cmd: 'pages.list', args: {} });
    await new Promise((res) => setTimeout(res, 30));
    s.parent.emit({ type: 'migrate', go: true });
    await s.ready();
    assert.strictEqual(readyMsg(s).state, 'failed');
    const late = new Promise((res) => setTimeout(() => res('答えが来ない'), 3000));
    assert.deepStrictEqual(await Promise.race([early, late]), { id: 6, ok: false, code: 'unavailable', retry: false }, '待たせた頼みに答えていない');
    const main = s.port('main');
    assert.deepStrictEqual(await main.ask({ id: 7, cmd: 'page.get', args: { id: d.ids[0] } }), { id: 7, ok: false, code: 'unavailable', retry: false });
    assert.deepStrictEqual(await main.ask({ id: 8, cmd: 'db.status', args: {} }), { id: 8, ok: false, code: 'unavailable', retry: false });
    assert.ok(!fs.existsSync(d.file));
    assert.ok(fs.readdirSync(d.dataDir).some((n) => n.startsWith('natsu.db.migrating.failed-')), '合わなかった写しを残していない');
    assert.deepStrictEqual(snapshotTree(path.join(d.dataDir, 'pages')), before);
  } finally { if (s) await s.stop(); d.done(); }
});

test('F8・F12: 開くときに壊れていると分かったら控えから戻す。掴まれている・開けないだけならファイルに触れず failed', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  let s = null;
  try {
    // 控えは動いている DB のプロセスが取るので、中の cleanShutdown は '0'
    d.db.prepare("insert into meta(key, value) values ('cleanShutdown', '0')").run();
    await require('../src/db/snapshot').take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    d.close();
    for (const sfx of ['-wal', '-shm']) fs.rmSync(d.file + sfx, { force: true });
    fs.writeFileSync(d.file, Buffer.alloc(8192, 0x41));   // SQLite のファイルでない（NOTADB）
    const checks = [];
    s = boot(d, { runCheck: async (o) => { checks.push(path.basename(o.file)); return require('../src/db/snapshot').workerCheck(o); } });
    await s.ready();
    assert.strictEqual(readyMsg(s).state, 'ok');
    assert.deepStrictEqual(checks, ['natsu.db.restoring'], '確かめ済みの写しから戻した後に、もう一度確かめた');
    assert.ok(fs.readdirSync(d.dataDir).some((n) => /^natsu\.db\.broken-/.test(n)), '壊れたファイルを退けて残していない');
    const got = await s.port('main').ask({ id: 1, cmd: 'page.get', args: { id: d.ids[0] } });
    assert.strictEqual(got.result.page.id, d.ids[0]);
    await s.stop(); s = null;

    // natsu.db がフォルダ（開けない。壊れているとは分からない）: 控えがあっても戻さず、何も動かさない
    const d2 = tmpData({ pages: 1 });
    try {
      await require('../src/db/snapshot').take({ sqlite, db: d2.db, dataDir: d2.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
      d2.close();
      for (const sfx of ['', '-wal', '-shm']) fs.rmSync(d2.file + sfx, { force: true });
      fs.mkdirSync(d2.file);
      const tree = snapshotTree(d2.dataDir);
      s = boot(d2);
      await s.ready();
      assert.strictEqual(readyMsg(s).state, 'failed');
      assert.deepStrictEqual((await s.port('app').ask({ id: 1, cmd: 'pages.list', args: {} })).code, 'unavailable');
      assert.deepStrictEqual(snapshotTree(d2.dataDir), tree, '開けないだけの DB を動かした');
      await s.stop(); s = null;
    } finally { d2.done(); }
  } finally { if (s) await s.stop(); d.done(); }
});

test('ST7: きれいに閉じなかった後（cleanShutdown が 0）だけ確かめ、壊れていたときだけ戻す。走れなければ開いたまま進む', { timeout: 15000 }, async () => {
  const d = tmpData({ pages: 1 });
  let s = null;
  try {
    await require('../src/db/snapshot').take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    d.close();
    const checks = [];
    const answers = [];
    const runCheck = async ({ file }) => { checks.push(path.basename(file)); return answers.length ? answers.shift() : 'ok'; };
    const meta = () => { const c = new sqlite.DatabaseSync(d.file); try { const r = c.prepare("select value from meta where key = 'cleanShutdown'").get(); return r && r.value; } finally { c.close(); } };
    const setMeta = (v) => { const c = new sqlite.DatabaseSync(d.file); try { c.prepare("insert into meta(key, value) values ('cleanShutdown', ?) on conflict(key) do update set value = excluded.value").run(v); } finally { c.close(); } };

    // 1回目: cleanShutdown が無い（初めて開く）→ 確かめない。閉じると '1'
    s = boot(d, { runCheck });
    await s.ready();
    await s.stop(); s = null;
    assert.deepStrictEqual(checks, []);
    assert.strictEqual(meta(), '1');
    // 2回目: きれいに閉じた後 → 確かめない
    s = boot(d, { runCheck }); await s.ready(); await s.stop(); s = null;
    assert.deepStrictEqual(checks, []);
    // 3回目: 落ちた後（'0'）で、確かめが走れなかった → 記録だけして開いたまま進む（ファイルは動かさない）
    setMeta('0'); answers.push({ error: 'worker' });
    s = boot(d, { runCheck }); await s.ready();
    assert.deepStrictEqual([checks, readyMsg(s).state], [['natsu.db'], 'ok']);
    assert.ok(!fs.readdirSync(d.dataDir).some((n) => /^natsu\.db\.broken-/.test(n)), '走れなかっただけで退けた');
    await s.stop(); s = null;
    // 4回目: 落ちた後で、確かめが壊れていると答えた → 退けて控えから戻す（戻す写しは recover が確かめ済みなので、戻した後にもう一度は確かめない）
    setMeta('0'); answers.push('quick-check');
    s = boot(d, { runCheck }); await s.ready();
    assert.strictEqual(readyMsg(s).state, 'ok');
    assert.deepStrictEqual(checks, ['natsu.db', 'natsu.db', 'natsu.db.restoring']);
    assert.ok(fs.readdirSync(d.dataDir).some((n) => /^natsu\.db\.broken-/.test(n)), '壊れていたのに戻していない');
    const st = await s.port('main').ask({ id: 1, cmd: 'db.status', args: {} });
    assert.strictEqual(st.result.startup.restored.from, '2026-10-18T03:00:00.000Z');
  } finally { if (s) await s.stop(); d.done(); }
});

test('ST4: 形の違う頼み・1MB を超える頼みは bad-args。db.status・snapshot.take・db.reimport は main だけ。閉じた口には changed を送らない', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  const s = boot(d);
  try {
    const app = s.port('app'); const main = s.port('main'); const gone = s.port('app');
    await s.ready();
    gone.close();
    assert.deepStrictEqual(await app.ask({ id: 1, cmd: 7, args: {} }), { id: 1, ok: false, code: 'bad-args', retry: false });
    assert.deepStrictEqual(await app.ask({ id: 2, cmd: 'page.get', args: [] }), { id: 2, ok: false, code: 'bad-args', retry: false });
    // 1つ1つの欄は上限の内でも、頼み全体が 1MB を超える（UTF-8 で約 1.08MB）
    const blocks = Array.from({ length: 12 }, (_, i) => ({ id: `big${i}`, type: 'paragraph', text: 'あ'.repeat(30000) }));
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    const big = await main.ask({ id: 3, cmd: 'page.put', args: { page: { id: d.ids[0], title: '大きい', blocks }, baseRev: 1 }, tx: 'm:t-000003' });
    assert.deepStrictEqual(big, { id: 3, ok: false, code: 'bad-args', retry: false }, '1MB を超える頼みを通した');
    assert.deepStrictEqual(await app.ask({ id: 3, cmd: 'page.get', args: { id: 1n } }), { id: 3, ok: false, code: 'bad-args', retry: false }, 'JSON にできない頼み');
    // args の外に大きなものを付けた頼みも、頼み全体の大きさで断る（引数の照らしは args しか見ない）
    assert.deepStrictEqual(await app.ask({ id: 3, cmd: 'page.get', args: { id: d.ids[0] }, pad: 'x'.repeat(1100000) }), { id: 3, ok: false, code: 'bad-args', retry: false }, '頼み全体の大きさを見ていない');
    for (const cmd of ['db.status', 'snapshot.take', 'db.reimport']) {
      assert.strictEqual((await app.ask({ id: 4, cmd, args: { kind: 'daily' }, tx: 'a:t-000004' })).code, 'forbidden', cmd);
    }
    const st = await main.ask({ id: 5, cmd: 'db.status', args: {} });
    assert.deepStrictEqual([st.ok, st.result.state, st.result.version, st.result.journal, typeof st.result.pid], [true, 'ok', 1, 'wal', 'number']);
    assert.deepStrictEqual(st.result.startup.reimport, { added: 0, replaced: 0, copied: 0, skipped: 0, broken: 0, badShape: 0, unreadable: 0, skippedChanged: true });
    assert.strictEqual((await main.ask({ id: 6, cmd: 'snapshot.take', args: { kind: 'weekly' } })).code, 'bad-args');
    const snap = await main.ask({ id: 6, cmd: 'snapshot.take', args: { kind: 'daily' } });
    assert.deepStrictEqual([snap.ok, snap.result.ok, snap.result.check], [true, true, 'ok']);
    assert.ok(fs.readdirSync(path.join(d.dataDir, 'backup')).some((n) => /\.db\.gz$/.test(n)));
    const st2 = await main.ask({ id: 7, cmd: 'db.status', args: {} });
    assert.strictEqual(st2.result.lastSnapshot.kind, 'daily', '毎日の控えの時刻を覚えていない（M-4 の1日1回）');
    const re = await main.ask({ id: 8, cmd: 'db.reimport', args: {} });
    assert.deepStrictEqual([re.ok, re.result.added, re.result.skippedChanged], [true, 0, false]);
    const seen = []; main.onEvent((e) => seen.push(e));
    await waitFor(() => gone.serverSeesClose(), '子の側の口の close');
    assert.strictEqual((await app.ask({ id: 9, cmd: 'page.setMemo', args: { id: d.ids[0], memo: '閉じた口があっても書ける' }, tx: 'a:t-000009' })).ok, true);
    await waitFor(() => seen.length === 1, 'changed');
    assert.deepStrictEqual(s.late, [], '閉じた口に changed を送った（役の表から外していない）');
    assert.ok(s.fromServer.some((m) => m.type === 'log' && /^DB: 起動（番号 \d+）$/.test(m.line)), '実機の 4 で照らす番号の行が無い');
    assert.ok(s.fromServer.some((m) => m.type === 'log' && /^DB: SQLite [\d.]+・trigram OK・表の形 v1・wal$/.test(m.line)));
  } finally { await s.stop(); d.done(); }
});

test('D7: 新しい版の NaTsu で作った DB は読むだけ（書く命令は read-only・meta も書かない）', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  let s = null;
  try {
    d.db.exec('pragma user_version = 2');
    d.close();
    s = boot(d);
    await s.ready();
    assert.strictEqual(readyMsg(s).state, 'newer');
    const app = s.port('app');
    assert.strictEqual((await app.ask({ id: 1, cmd: 'page.get', args: { id: d.ids[0] } })).ok, true);
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    assert.strictEqual((await app.ask({ id: 2, cmd: 'page.setTitle', args: { id: d.ids[0], title: 'x' }, tx: 'a:t-000002' })).code, 'read-only');
    await s.stop(); s = null;
    const c = new sqlite.DatabaseSync(d.file);
    try { assert.strictEqual(c.prepare("select count(*) n from meta where key = 'cleanShutdown'").get().n, 0, '新しい版の DB に書いた'); } finally { c.close(); }
  } finally { if (s) await s.stop(); d.done(); }
});

// 0.7.0 の前に意図して変えた: CI run 39243734668 の Windows の electron-smoke で、このテストと db-snapshot の RF11 が別のプロセスで同じ時間帯に
// 10 秒の時間切れ（ふだんは約 0.9 秒）。同じ時間帯に engine-fetch（SQLite も worker も控えも使わない）も 8〜19 倍遅く、CI の機械の止まりだった。
// 段は4つ（起動して控えを取る・閉じる・もう一度起動・閉じる）で、どれも 5 秒まで待つ（控えを取る起動は、製品の控えの .gz の名前の変更の
// 上限 RENAME_WAITS_SHORT（約 0.5 秒）も足す）。前の 10 秒は段の待ちの合計より短く、どの段で止まったかを言わずに切れていた。
// 予算を段の待ちの合計にし、段の名前と子の記録（snapshot.js の段ごとの時間）を言って落ちる
const ST10_TAKE_READY_MS = 5000 + require('./helpers/steps').sum(require('../src/db/snapshot').RENAME_WAITS_SHORT);
const ST10_BUDGET_MS = ST10_TAKE_READY_MS + 3 * 5000;
test('ST10: 移した直後に落ちて移行の控えが無ければ、次の起動で頼みを受ける前に取る', { timeout: ST10_BUDGET_MS + 5000 }, async () => {
  const d = tmpData({ pages: 1, withJson: true });   // meta.jsonMigration はあるが、控えはまだ無い
  let s = null;
  try {
    await withSteps(ST10_BUDGET_MS, async ({ step, log }) => {
      d.close();
      step('起動して控えを取る');
      s = boot(d);
      try { await s.ready(ST10_TAKE_READY_MS); } finally { for (const l of s.logs()) log(l); }
      assert.strictEqual(readyMsg(s).state, 'ok');
      assert.strictEqual(fs.readdirSync(path.join(d.dataDir, 'backup')).filter((n) => /-migration\.db\.gz$/.test(n)).length, 1);
      step('閉じる');
      await s.stop(); s = null;
      step('もう一度起動');
      s = boot(d); await s.ready();   // 2回目は取らない
      assert.strictEqual(fs.readdirSync(path.join(d.dataDir, 'backup')).filter((n) => /-migration\.db\.gz$/.test(n)).length, 1);
      step('閉じる');
    });
  } finally { if (s) await s.stop(); d.done(); }
});

test('ST5: changed は書いた app の口にも、ほかの app の口にも、main の口にも届く', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  const s = boot(d);
  try {
    const writer = s.port('app'); const other = s.port('app'); const main = s.port('main');
    const seen = { writer: [], other: [], main: [] };
    writer.onEvent((e) => seen.writer.push(e)); other.onEvent((e) => seen.other.push(e)); main.onEvent((e) => seen.main.push(e));
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    assert.strictEqual((await writer.ask({ id: 1, cmd: 'page.setTitle', args: { id: d.ids[0], title: '全部の口へ' }, tx: 'a:t-000001' })).ok, true);
    await waitFor(() => seen.writer.length && seen.other.length && seen.main.length, '全部の口の changed');
    const want = [{ event: 'changed', pageIds: [d.ids[0]], actor: 'me' }];
    assert.deepStrictEqual(seen, { writer: want, other: want, main: want });
  } finally { await s.stop(); d.done(); }
});

test('F8: 開けた後に meta の読み書きで壊れていると分かっても（SQLITE_CORRUPT）、failed のままにせず控えから戻す', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  let s = null;
  try {
    await require('../src/db/snapshot').take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    d.close();
    for (const sfx of ['-wal', '-shm']) fs.rmSync(d.file + sfx, { force: true });
    const c = new sqlite.DatabaseSync(d.file);
    let root; let size;
    try {
      root = c.prepare("select rootpage from sqlite_master where type = 'table' and name = 'meta'").get().rootpage;
      size = c.prepare('pragma page_size').get().page_size;
    } finally { c.close(); }
    const buf = Buffer.from(fs.readFileSync(d.file));
    buf.fill(0x55, (root - 1) * size, root * size);   // meta の表の頁だけを壊す（頭は無事なので core.open は開ける）
    fs.writeFileSync(d.file, buf);
    s = boot(d);
    await s.ready();
    assert.strictEqual(readyMsg(s).state, 'ok', '開けた後に壊れていると分かったのに戻さなかった');
    assert.ok(s.fromServer.some((m) => m.type === 'log' && /^DB: 開いた後に壊れていると分かった（ERR_SQLITE_ERROR）$/.test(m.line)), '開けた後の道を通っていない（開く前に壊れていると分かった）');
    const main = s.port('main');
    const st = await main.ask({ id: 1, cmd: 'db.status', args: {} });
    assert.deepStrictEqual(st.result.startup.restored, { from: '2026-10-18T03:00:00.000Z', why: 'open' });
    const kept = fs.readdirSync(d.dataDir).filter((n) => /^natsu\.db\.broken-[0-9T-]+Z(-\d+)?$/.test(n));
    assert.strictEqual(kept.length, 1, '壊れたファイルを退けて残していない');
    assert.deepStrictEqual(fs.readFileSync(path.join(d.dataDir, kept[0])), buf, '退けたファイルの中身が変わった');
    assert.strictEqual((await main.ask({ id: 2, cmd: 'page.get', args: { id: d.ids[0] } })).result.page.id, d.ids[0]);
  } finally { if (s) await s.stop(); d.done(); }
});

test('F8: 0 バイトの natsu.db は、控えか退けたものがあれば空の DB として使わず、退けて控えから戻す', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 2 });
  let s = null;
  try {
    await require('../src/db/snapshot').take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    d.close();
    for (const sfx of ['-wal', '-shm']) fs.rmSync(d.file + sfx, { force: true });
    fs.writeFileSync(d.file, Buffer.alloc(0));
    s = boot(d);
    await s.ready();
    assert.strictEqual(readyMsg(s).state, 'ok');
    const main = s.port('main');
    const st = await main.ask({ id: 1, cmd: 'db.status', args: {} });
    assert.deepStrictEqual(st.result.startup.restored, { from: '2026-10-18T03:00:00.000Z', why: 'missing' }, '0 バイトの DB を空の DB として使った');
    assert.deepStrictEqual((await main.ask({ id: 2, cmd: 'pages.list', args: {} })).result.map((p) => p.id).sort(), d.ids);
    const kept = fs.readdirSync(d.dataDir).filter((n) => /^natsu\.db\.broken-[0-9T-]+Z(-\d+)?$/.test(n));
    assert.deepStrictEqual(kept.map((n) => fs.statSync(path.join(d.dataDir, n)).size), [0], '0 バイトのファイルを退けて残していない');
  } finally { if (s) await s.stop(); d.done(); }
});

test('ST2: 控えを取っている途中の close は、その終わりを待ってから閉じる（控えの時刻が残る）', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  let armed = false;
  let s = null;
  const runCheck = async (o) => {
    if (!armed) return 'ok';
    s.parent.emit({ type: 'close' });   // 確かめの途中で close が来る
    await new Promise((res) => setTimeout(res, 50));
    return 'ok';
  };
  try {
    s = boot(d, { runCheck });
    await s.ready();
    const main = s.port('main');
    armed = true;
    const snap = await main.ask({ id: 1, cmd: 'snapshot.take', args: { kind: 'daily' } });
    assert.deepStrictEqual([snap.ok, snap.result.ok], [true, true]);
    await waitFor(() => s.fromServer.some((m) => m.type === 'closed'), 'closed');
    const c = new sqlite.DatabaseSync(d.file);
    try {
      const r = c.prepare("select value from meta where key = 'lastSnapshot'").get();
      assert.ok(r && JSON.parse(r.value).kind === 'daily', '控えの終わりを待たずに閉じた（控えの時刻が書けなかった）');
    } finally { c.close(); }
  } finally { if (s) await s.stop(); d.done(); }
});

test('F12: natsu.db がフォルダなら、大きさが 0 と見えても（Windows の形）控えから戻さず、何も動かさない', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  let s = null;
  try {
    await require('../src/db/snapshot').take({ sqlite, db: d.db, dataDir: d.dataDir, kind: 'daily', now: () => new Date('2026-10-18T03:00:00Z') });
    d.close();
    for (const sfx of ['', '-wal', '-shm']) fs.rmSync(d.file + sfx, { force: true });
    fs.mkdirSync(d.file);
    const tree = snapshotTree(d.dataDir);
    const winLike = { ...fs, lstatSync: (p, ...rest) => { const st = fs.lstatSync(p, ...rest); if (st.isDirectory()) Object.defineProperty(st, 'size', { value: 0 }); return st; } };
    s = boot(d, { fs: winLike });
    await s.ready();
    assert.strictEqual(readyMsg(s).state, 'failed');
    assert.deepStrictEqual(snapshotTree(d.dataDir), tree, '開けないだけの DB（フォルダ）を 0 バイトのファイルとみなして動かした');
  } finally { if (s) await s.stop(); d.done(); }
});
