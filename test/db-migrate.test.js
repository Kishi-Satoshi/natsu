/* db-migrate.test.js — 第2a1回 ST10・RF14: 移行（最初の1回） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { oldBuildData, snapshotTree } = require('./helpers/dbtmp');   // oldBuildData: 0.6.0 と同じ store.js で JSON の data を作る（BOM 付き・壊れた・読めない・形の違う ID も）
const M = require('../src/db/migrate');
const sqlite = require('node:sqlite');
const { evenKeys } = require('../src/db/keys');

test('ST10: plan は数だけを返し、ファイルを1つも変えない', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 5, broken: 1, bom: 1, badId: 1 });
  try {
    const before = snapshotTree(d.dataDir);   // 相対パス → sha256（名前と中身）
    assert.deepStrictEqual(M.plan(d.dataDir, {}), { pages: 6, segments: 6 * 3, broken: 1, unreadable: 0, badId: 1, badShape: 0, fixedIds: 0 });
    assert.deepStrictEqual(snapshotTree(d.dataDir), before);
  } finally { d.done(); }
});

test('ST10: 移した後、全部のページと文字起こしが元の JSON と深く同じ（知らない欄・経路・一時停止・1b のタブに要る ID も）。元のファイルは1バイトも変わらない。指紋も書く', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 8, broken: 1, bom: 1 });
  try {
    const before = snapshotTree(d.dataDir);
    const r = M.migrate({ sqlite, dataDir: d.dataDir });
    assert.strictEqual(r.ok, true, r.code);
    assert.deepStrictEqual(r.counts, { pages: 9, segments: 27, broken: 1, unreadable: 0, badId: 0, badShape: 0, fixedIds: 0 });
    const after = snapshotTree(d.dataDir);
    for (const [rel, sha] of Object.entries(before)) assert.strictEqual(after[rel], sha, `${rel} が変わった・消えた`);
    assert.ok(fs.existsSync(path.join(d.dataDir, 'natsu.db')) && !fs.existsSync(path.join(d.dataDir, 'natsu.db.migrating')));
    const peek = require('./helpers/dbpeek').open(d.dataDir);
    try {
      for (const id of d.ids) assert.deepStrictEqual(peek.rawPage(id), d.rawPage(id), id);   // rawPage: markShortBlocks の前の形（rev を除く）
      assert.strictEqual(peek.metaKeys().filter((k) => k.startsWith('json:')).length, 9, '移したページの指紋が無い（最初の取り込みが全部を「変わった」とみなす）');
    } finally { peek.close(); }
  } finally { d.done(); }
});

test('F2: ブロックの ID の重なり・ID の無いブロック・発言の ID の重なり・形の悪いページがあっても、残りは移り、元のファイルはそのまま', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 3 });
  try {
    d.writePage({ id: 'pdup000001', title: '重なり', blocks: [{ id: 'bsame', type: 'bullet', text: '一' }, { id: 'bsame', type: 'bullet', text: '二' }, { type: 'bullet', text: 'ID なし' }] },
      [{ id: 's1', atMs: 0, text: '一' }, { id: 's1', atMs: 1, text: '二' }]);
    d.writePage({ id: 'pbad000001', title: 7, blocks: ['文字だけ'] }, []);
    const before = snapshotTree(d.dataDir);
    const r = M.migrate({ sqlite, dataDir: d.dataDir });
    assert.strictEqual(r.ok, true, `1つのページの形で全部の移行が止まった（${r.code}）`);
    assert.deepStrictEqual([r.counts.pages, r.counts.badShape, r.counts.fixedIds], [4, 1, 3]);
    const peek = require('./helpers/dbpeek').open(d.dataDir);
    try {
      const p = peek.rawPage('pdup000001');
      assert.deepStrictEqual(p.blocks.map((b) => b.text), ['一', '二', 'ID なし']);
      assert.strictEqual(new Set(p.blocks.map((b) => b.id)).size, 3);
      assert.deepStrictEqual(peek.getTranscript('pdup000001').map((x) => [x.id, x.text]), [['s1', '一'], ['s2', '二']]);
    } finally { peek.close(); }
    const after = snapshotTree(d.dataDir);
    for (const [rel, sha] of Object.entries(before)) assert.strictEqual(after[rel], sha, `${rel} が変わった（形の悪いページの元のファイルも動かさない）`);
  } finally { d.done(); }
});

test('RF14: 途中で落ちても natsu.db はできず、元のファイルはそのまま。前の残り（.migrating と -wal・-shm・-journal）は当てずに作り直す。確かめが合わなければ .failed に退けて消さない', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 4 });
  try {
    const before = snapshotTree(d.dataDir);
    assert.throws(() => M.migrate({ sqlite, dataDir: d.dataDir, onProgress: (n) => { if (n === 2) throw new Error('落ちた'); } }));
    assert.ok(!fs.existsSync(path.join(d.dataDir, 'natsu.db')));
    fs.writeFileSync(path.join(d.dataDir, 'natsu.db.migrating-wal'), Buffer.alloc(4096, 7));   // 前の起動の残りの -wal（当てると壊れる）
    assert.strictEqual(M.migrate({ sqlite, dataDir: d.dataDir }).ok, true, 'やり直しで済まない');
    assert.ok(!fs.readdirSync(d.dataDir).some((n) => /^natsu\.db\.migrating(-wal|-shm|-journal)?$/.test(n)), '前の残りが残った');
    const d2 = oldBuildData({ pages: 2 });
    try {
      for (let i = 0; i < 3; i++) {
        const r = M.migrate({ sqlite, dataDir: d2.dataDir, verifyHook: () => false, now: () => new Date(Date.UTC(2026, 9, 19, 0, 0, i)) });   // 比べが合わない
        assert.deepStrictEqual([r.ok, r.code], [false, 'verify']);
      }
      assert.ok(!fs.existsSync(path.join(d2.dataDir, 'natsu.db')));
      // 失敗した写しは消さない。ただし作り直せるものなので、新しい2つだけ残す（起動のたびに数十 MB ずつ増えない）
      assert.strictEqual(fs.readdirSync(d2.dataDir).filter((n) => /^natsu\.db\.migrating\.failed-/.test(n)).length, 2);
    } finally { d2.done(); }
    for (const [rel, sha] of Object.entries(before)) assert.strictEqual(snapshotTree(d.dataDir)[rel], sha);
  } finally { d.done(); }
});

// ---- 計画のテストに足したもの（D-5a の実装で決めた細部と、変異 dm-* を殺す確かめ）

test('RF14: 確かめは本当に DB と元の JSON を比べる（移した後に1行の文字が変わると verify で作らず、写しは .failed に残す）', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 2 });
  try {
    const r = M.migrate({ sqlite, dataDir: d.dataDir, verifyHook: ({ db }) => { db.prepare("update blocks set text = '書き換えた文' where type = 'heading'").run(); } });
    assert.deepStrictEqual([r.ok, r.code], [false, 'verify'], '比べを飛ばした');
    assert.ok(!fs.existsSync(path.join(d.dataDir, 'natsu.db')));
    const failed = fs.readdirSync(d.dataDir).filter((n) => /^natsu\.db\.migrating\.failed-/.test(n));
    assert.strictEqual(failed.length, 1, '合わなかった写しを消した');
    assert.ok(!fs.existsSync(path.join(d.dataDir, 'natsu.db.migrating')));
    // 発言の1つが変わっても合わない
    const r2 = M.migrate({ sqlite, dataDir: d.dataDir, now: () => new Date(Date.UTC(2026, 9, 19, 1)), verifyHook: ({ db }) => { db.prepare("update segments set text = '別の発言' where id = 's3'").run(); } });
    assert.deepStrictEqual([r2.ok, r2.code], [false, 'verify']);
    // 件数が合わない（余計なページの行）も合わない
    const r3 = M.migrate({ sqlite, dataDir: d.dataDir, now: () => new Date(Date.UTC(2026, 9, 19, 2)), verifyHook: ({ db }) => { db.prepare("insert into blocks(id, type, page_id, ord) values ('pextra0001', 'page', 'pextra0001', 'i')").run(); } });
    assert.deepStrictEqual([r3.ok, r3.code], [false, 'verify']);
    assert.strictEqual(M.migrate({ sqlite, dataDir: d.dataDir }).ok, true);
  } finally { d.done(); }
});

test('ST10: すでに natsu.db があれば移さず、natsu.db には1バイトも触れない', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 2 });
  try {
    const db = path.join(d.dataDir, 'natsu.db');
    fs.writeFileSync(db, Buffer.from('今の DB の見本（上書きされない）'));
    const before = snapshotTree(d.dataDir);
    const r = M.migrate({ sqlite, dataDir: d.dataDir });
    assert.deepStrictEqual([r.ok, r.code], [false, 'io']);
    assert.deepStrictEqual(snapshotTree(d.dataDir), before);
  } finally { d.done(); }
});

test('ST10: 数え方 — 読めないもの・ファイル名と違う ID・文字起こしの無い・壊れたページ。meta の jsonMigration と指紋（大きさ・時刻・SHA-256・rev）', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 3, unreadable: 1, badId: 1 });
  try {
    const tdir = path.join(d.dataDir, 'transcripts');
    fs.rmSync(path.join(tdir, `${d.ids[0]}.json`));                  // 文字起こしが無い → 発言 0 で移す（数えない）
    fs.writeFileSync(path.join(tdir, `${d.ids[1]}.json`), '{"id":');   // 文字起こしが壊れた → 発言 0 で移し、broken に1つ
    const plan = M.plan(d.dataDir, {});
    assert.deepStrictEqual(plan, { pages: 3, segments: 3, broken: 1, unreadable: 1, badId: 1, badShape: 0, fixedIds: 0 });
    const r = M.migrate({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T03:04:05.000Z') });
    assert.strictEqual(r.ok, true, r.code);
    assert.deepStrictEqual(r.counts, plan, '窓で見せた数と移した数が食い違う');
    assert.ok(Number.isFinite(r.ms) && r.ms >= 0);
    const peek = require('./helpers/dbpeek').open(d.dataDir);
    try {
      assert.deepStrictEqual(peek.listPages().map((p) => p.id).sort(), [...d.ids].sort());
      assert.deepStrictEqual(peek.getTranscript(d.ids[0]), []);
      assert.deepStrictEqual(peek.getTranscript(d.ids[1]), []);
      assert.strictEqual(peek.getTranscript(d.ids[2]).length, 3);
      assert.deepStrictEqual(peek.meta('jsonMigration'), { at: '2026-10-19T03:04:05.000Z', ...plan });
      const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
      const pf = path.join(d.dataDir, 'pages', `${d.ids[2]}.json`);
      const tf = path.join(tdir, `${d.ids[2]}.json`);
      assert.deepStrictEqual(peek.meta(`json:${d.ids[2]}`), {
        size: fs.statSync(pf).size, mtimeMs: fs.statSync(pf).mtimeMs, sha: sha(pf),
        tsize: fs.statSync(tf).size, tmtimeMs: fs.statSync(tf).mtimeMs, tsha: sha(tf), rev: 1,
      });
      const none = peek.meta(`json:${d.ids[0]}`);
      assert.deepStrictEqual([none.tsize, none.tmtimeMs, none.tsha], [null, null, null], '無い文字起こしの指紋');
      assert.strictEqual(peek.meta(`json:${d.ids[1]}`).tsha, sha(path.join(tdir, `${d.ids[1]}.json`)), '壊れた文字起こしも今のバイトの指紋');
      assert.strictEqual(peek.metaKeys().filter((k) => k.startsWith('json:')).length, 3, '移していないファイルの指紋を書いた');
      assert.strictEqual(peek.oplogCount(), 0, '移行は oplog に書かない（移行の直後の控えが始まり）');
    } finally { peek.close(); }
  } finally { d.done(); }
});

test('ST3: 移したブロックの並びの鍵は evenKeys、ページ・ブロック・発言の ID はそのまま。DB は1つのファイル（WAL で開き直せる）', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 2 });
  try {
    assert.strictEqual(M.migrate({ sqlite, dataDir: d.dataDir }).ok, true);
    assert.deepStrictEqual(fs.readdirSync(d.dataDir).filter((n) => n.startsWith('natsu.db')), ['natsu.db']);
    const db = new sqlite.DatabaseSync(path.join(d.dataDir, 'natsu.db'), { readOnly: true });
    try {
      for (const id of d.ids) {
        const rows = db.prepare('select id, ord from blocks where page_id = ? and id <> ? order by ord').all(id, id);
        assert.deepStrictEqual(rows.map((x) => x.ord), evenKeys(5));
        assert.deepStrictEqual(rows.map((x) => x.id), d.rawPage(id).blocks.map((b) => b.id));
      }
      assert.strictEqual(String(db.prepare('pragma journal_mode').get().journal_mode).toLowerCase(), 'wal');
    } finally { db.close(); }
  } finally { d.done(); }
});

test('F2: 今の形で表せないページは移さず数える（題名・ブロックの文が文字でない・型が無い・ページの型・空の作成時刻・壊れたサロゲート・-0・決まった名前の欄）。表せる知らない値は移す', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 1 });
  try {
    const bad = [
      { id: 'pshape0001', title: null, blocks: [] },
      { id: 'pshape0002', title: '文が無い', blocks: [{ id: 'bx1', type: 'bullet' }] },
      { id: 'pshape0003', title: '型が無い', blocks: [{ id: 'bx2', text: '型なし' }] },
      { id: 'pshape0004', title: 'ページの型', blocks: [{ id: 'bx3', type: 'page', text: '一覧に出てしまう' }] },
      { id: 'pshape0005', title: '空の時刻', createdAt: '', blocks: [] },
      { id: 'pshape0006', title: '壊れた\ud800サロゲート', blocks: [] },
      { id: 'pshape0007', title: '負のゼロ', durationSec: -0, blocks: [] },
      { id: 'pshape0008', title: '決まった名前', rev: 3, blocks: [] },
      { id: 'pshape0009', title: 'blocks が配列でない', blocks: '文字' },
      { id: 'pshape0010', title: '子がある', blocks: [{ id: 'bx4', type: 'bullet', text: '親', children: [{ id: 'bx5' }] }] },
    ];
    for (const p of bad) d.writePage(p, []);
    // JSON.stringify は -0 を 0 と書くので、-0 のファイルは手で書く（JSON.parse は -0 に読む。表に入れると 0 になり比べが合わない）
    fs.writeFileSync(path.join(d.dataDir, 'pages', 'pshape0007.json'), '{"id":"pshape0007","title":"負のゼロ","durationSec":-0,"blocks":[]}');
    d.writePage({ id: 'pshape0011', title: '発言の形が悪い', blocks: [] }, [{ id: 's1', atMs: 0 }]);
    d.writePage({ id: 'pshape0012', title: '発言が物でない', blocks: [] }, ['文字だけ']);
    // 表せるもの: blocks の無いページ（今の getPage と同じく空の並び）・整数でない時刻・真偽でない failed・null の欄・入れ子の知らない欄
    d.writePage({ id: 'pgood00001', title: '表せる', memo: 'メモ', nested: { a: [1, { b: null }] } },
      [{ id: 's1', atMs: 1.5, durationMs: null, text: '一', failed: 'yes' }, { id: 's2', text: '二', speaker: '話者2' }]);
    const r = M.migrate({ sqlite, dataDir: d.dataDir });
    assert.strictEqual(r.ok, true, r.code);
    assert.deepStrictEqual([r.counts.pages, r.counts.badShape, r.counts.fixedIds], [2, 12, 0]);
    assert.deepStrictEqual(M.plan(d.dataDir, {}), r.counts);
    const peek = require('./helpers/dbpeek').open(d.dataDir);
    try {
      assert.deepStrictEqual(peek.rawPage('pgood00001'), { id: 'pgood00001', title: '表せる', memo: 'メモ', nested: { a: [1, { b: null }] }, blocks: [] });
      assert.deepStrictEqual(peek.getTranscript('pgood00001'), [{ id: 's1', atMs: 1.5, durationMs: null, text: '一', failed: 'yes' }, { id: 's2', text: '二', speaker: '話者2' }]);
      for (const p of bad) assert.strictEqual(peek.rawPage(p.id), null, p.id);
      assert.deepStrictEqual(peek.listPages().map((p) => p.id).sort(), [d.ids[0], 'pgood00001'].sort());
    } finally { peek.close(); }
  } finally { d.done(); }
});

test('F2: ブロックの ID がほかのページの ID・別のページのブロックと重なっても、後から振り直して両方移す。発言の ID の無い・形の悪いものも空いている s<n> に', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 0 });
  try {
    d.writePage({ id: 'pzz0000001', title: '前', blocks: [{ id: 'pzz0000002', type: 'bullet', text: '後のページと同じ ID' }, { id: 'bshared', type: 'bullet', text: '共有' }, { id: 'pzz0000001', type: 'bullet', text: '自分と同じ ID' }] },
      [{ id: 's5', text: '五' }, { text: 'ID なし' }, { id: 'こんにちは', text: '形の悪い ID' }, { id: 's5', text: '重なり' }]);
    d.writePage({ id: 'pzz0000002', title: '後', blocks: [{ id: 'bshared', type: 'bullet', text: '別のページの共有' }, { id: 'b.bad', type: 'bullet', text: '形の悪い ID' }] }, []);
    const r = M.migrate({ sqlite, dataDir: d.dataDir });
    assert.strictEqual(r.ok, true, r.code);
    assert.deepStrictEqual([r.counts.pages, r.counts.badShape, r.counts.fixedIds], [2, 0, 7]);
    const peek = require('./helpers/dbpeek').open(d.dataDir);
    try {
      const a = peek.rawPage('pzz0000001');
      const b = peek.rawPage('pzz0000002');
      assert.deepStrictEqual(a.blocks.map((x) => x.text), ['後のページと同じ ID', '共有', '自分と同じ ID']);
      assert.deepStrictEqual(b.blocks.map((x) => x.text), ['別のページの共有', '形の悪い ID']);
      const all = [...a.blocks, ...b.blocks].map((x) => x.id);
      assert.strictEqual(new Set([...all, 'pzz0000001', 'pzz0000002']).size, 7, 'ブロックの ID が重なったまま');
      assert.strictEqual(a.blocks[1].id, 'bshared', '先のページの ID まで振り直した');
      for (const id of all) assert.match(id, /^[A-Za-z0-9_-]{1,64}$/);
      assert.deepStrictEqual(peek.getTranscript('pzz0000001').map((x) => [x.id, x.text]), [['s5', '五'], ['s6', 'ID なし'], ['s7', '形の悪い ID'], ['s8', '重なり']]);
    } finally { peek.close(); }
  } finally { d.done(); }
});

test('F2: 1つのページの書き込みが投げても、そのページだけ戻して数え、残りは移る（書きかけの行を残さない）', { timeout: 5000 }, () => {
  const C = require('../src/db/commands');
  const d = oldBuildData({ pages: 3 });
  const orig = C.putPageRows;
  C.putPageRows = (db, page, ...rest) => {
    const out = orig(db, page, ...rest);
    if (page.id === d.ids[1]) throw new Error('書き込みの途中で失敗');
    return out;
  };
  try {
    const r = M.migrate({ sqlite, dataDir: d.dataDir });
    C.putPageRows = orig;
    assert.strictEqual(r.ok, true, r.code);
    assert.deepStrictEqual([r.counts.pages, r.counts.badShape, r.counts.segments], [2, 1, 6]);
    const db = new sqlite.DatabaseSync(path.join(d.dataDir, 'natsu.db'), { readOnly: true });
    try {
      assert.strictEqual(db.prepare('select count(*) c from blocks where page_id = ?').get(d.ids[1]).c, 0, '書きかけの行が残った');
      assert.strictEqual(db.prepare('select count(*) c from segments where page_id = ?').get(d.ids[1]).c, 0);
      assert.strictEqual(db.prepare('select count(*) c from meta where key = ?').get(`json:${d.ids[1]}`).c, 0, '移していないページの指紋');
    } finally { db.close(); }
  } finally { C.putPageRows = orig; d.done(); }
});

test('RF14: natsu.db が無いのに残っている natsu.db-wal・-shm は新しい DB に当てず、消さずに脇へ退ける', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 2 });
  try {
    fs.writeFileSync(path.join(d.dataDir, 'natsu.db-wal'), Buffer.alloc(4096, 9));
    fs.writeFileSync(path.join(d.dataDir, 'natsu.db-shm'), Buffer.alloc(1024, 9));
    const r = M.migrate({ sqlite, dataDir: d.dataDir, now: () => new Date('2026-10-19T05:06:07.000Z') });
    assert.strictEqual(r.ok, true, r.code);
    const names = fs.readdirSync(d.dataDir);
    assert.ok(names.includes('natsu.db-wal.orphan-2026-10-19T05-06-07-000Z'), names.join(','));
    assert.ok(names.includes('natsu.db-shm.orphan-2026-10-19T05-06-07-000Z'), names.join(','));
    assert.deepStrictEqual(fs.readFileSync(path.join(d.dataDir, 'natsu.db-wal.orphan-2026-10-19T05-06-07-000Z')), Buffer.alloc(4096, 9));
    const peek = require('./helpers/dbpeek').open(d.dataDir);
    try {
      for (const id of d.ids) assert.deepStrictEqual(peek.rawPage(id), d.rawPage(id));
    } finally { peek.close(); }
  } finally { d.done(); }
});

test('convertPage は純粋（元の形を変えない）。usedIds に使った ID を足す。ページが無い data は空の DB になる', { timeout: 5000 }, () => {
  const page = { id: 'pc00000001', title: '題', blocks: [{ id: 'b1', type: 'bullet', text: '一' }, { id: 'b1', type: 'bullet', text: '二' }] };
  const segs = [{ id: 's1', text: '一' }, { id: 's1', text: '二' }];
  const copy = structuredClone([page, segs]);
  const used = new Set(['pc00000001']);
  const c = M.convertPage(page, segs, { usedIds: used });
  assert.strictEqual(c.ok, true);
  assert.deepStrictEqual([page, segs], copy, '元の形を変えた');
  assert.strictEqual(c.fixed, 2);
  assert.strictEqual(c.page.blocks[0].id, 'b1');
  assert.notStrictEqual(c.page.blocks[1].id, 'b1');
  assert.ok(used.has('b1') && used.has(c.page.blocks[1].id));
  assert.deepStrictEqual(c.segments.map((s) => s.id), ['s1', 's2']);
  assert.deepStrictEqual(M.convertPage({ id: 'pc2', title: 1, blocks: [] }, [], { usedIds: new Set() }), { ok: false, code: 'bad-shape' });
  const d = oldBuildData({ pages: 0 });
  try {
    const r = M.migrate({ sqlite, dataDir: d.dataDir });
    assert.strictEqual(r.ok, true, r.code);
    assert.deepStrictEqual(r.counts, { pages: 0, segments: 0, broken: 0, unreadable: 0, badId: 0, badShape: 0, fixedIds: 0 });
  } finally { d.done(); }
});

test('RF14: 前の残りの -shm・-journal・-wal と中身のある .migrating は、開く前に全部消して作り直す（名前を変えた後に natsu.db.migrating-* を残さない）', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 2 });
  try {
    const tmp = path.join(d.dataDir, 'natsu.db.migrating');
    fs.writeFileSync(tmp, Buffer.alloc(8192, 3));
    for (const s of ['-wal', '-shm', '-journal']) fs.writeFileSync(tmp + s, Buffer.alloc(4096, 5));
    const r = M.migrate({ sqlite, dataDir: d.dataDir });
    assert.strictEqual(r.ok, true, r.code);
    assert.deepStrictEqual(fs.readdirSync(d.dataDir).filter((n) => n.startsWith('natsu.db')), ['natsu.db'], '前の残りが残った');
  } finally { d.done(); }
});

test('RF14: 全文検索の索引が表と合わなければ quick-check で作らず、写しは .failed に残す', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 2 });
  try {
    const r = M.migrate({ sqlite, dataDir: d.dataDir, verifyHook: ({ db }) => { db.prepare("insert into blocks_fts(rowid, fold) values (999999, 'ありえない索引の行')").run(); } });
    assert.deepStrictEqual([r.ok, r.code], [false, 'quick-check']);
    assert.ok(!fs.existsSync(path.join(d.dataDir, 'natsu.db')));
    assert.strictEqual(fs.readdirSync(d.dataDir).filter((n) => /^natsu\.db\.migrating\.failed-/.test(n)).length, 1);
  } finally { d.done(); }
});

test('ST10: 文字起こしが読めないページは発言 0 で移さず、読めないものに数える（指紋も書かない。次の起動の取り込みが丸ごと入れる）', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 2 });
  try {
    const tf = path.join(d.dataDir, 'transcripts', `${d.ids[0]}.json`);
    fs.rmSync(tf);
    fs.mkdirSync(tf);   // どの OS でも読めない
    const r = M.migrate({ sqlite, dataDir: d.dataDir });
    assert.strictEqual(r.ok, true, r.code);
    assert.deepStrictEqual([r.counts.pages, r.counts.unreadable, r.counts.segments], [1, 1, 3]);
    const peek = require('./helpers/dbpeek').open(d.dataDir);
    try {
      assert.strictEqual(peek.rawPage(d.ids[0]), null);
      assert.ok(!peek.metaKeys().includes(`json:${d.ids[0]}`));
      assert.deepStrictEqual(peek.rawPage(d.ids[1]), d.rawPage(d.ids[1]));
    } finally { peek.close(); }
  } finally { d.done(); }
});

test('convertPage: 発言の番号が大きすぎて数えられないときも、空いている s<n> を使う（使っている番号に重ねない）', { timeout: 5000 }, () => {
  const c = M.convertPage({ id: 'pc3', title: '題', blocks: [] }, [{ id: 's1', text: '一' }, { id: 's99999999999999999999', text: '大' }, { id: 's1', text: '重なり' }], { usedIds: new Set() });
  assert.deepStrictEqual(c.segments.map((s) => s.id), ['s1', 's99999999999999999999', 's2']);
  assert.deepStrictEqual(c.fixedAt, { blocks: [], segments: [2] });
});
