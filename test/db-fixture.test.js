/* db-fixture.test.js — 第2a1回 RF11: 出した表の形の版ごとの固定の DB から開ける */
'use strict';
const { titleAt } = require('./helpers/titles');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const sqlite = require('node:sqlite');
const core = require('../src/db/core');
// copyFixture はこのファイルの中に書く（dbtmp.js はレーン D のファイルなので、G は触らない）。開いた接続は done で全部閉じてから消す
// 固定の DB は必ず写してから開く（頭が WAL なので、読むだけで開いても test/fixtures/db/ に -shm・-wal ができる。そのまま開かない）
function copyFixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-fx-議事録𠮷-')); const file = path.join(dir, 'natsu.db'); const opened = [];
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'db', name), file);
  return { dir, file, open: (f = file) => { const r = core.open({ sqlite, file: f }); opened.push(r.db); return r; },
    raw: (f = file) => { const d = new sqlite.DatabaseSync(f, { readOnly: true }); opened.push(d); return d; },
    done: () => { for (const d of opened) { try { if (d) d.close(); } catch (_) { /* 閉じ済み */ } } fs.rmSync(dir, { recursive: true, force: true }); } };
}
test('RF11: v1.db（0.7.0 で出した形）を今の版で開ける・中身が読める・素の接続で全文検索できる', { timeout: 5000 }, () => {
  const t = copyFixture('v1.db');
  try {
    const r = t.open();
    assert.deepStrictEqual([r.state, r.version], ['ok', core.SCHEMA_VERSION]);
    const g = core.call(r.db, { role: 'app', cmd: 'page.get', args: { id: 'pfixture000001' } }, {});
    assert.strictEqual(g.result.page.title, titleAt('2026-10-15T01:00:00.000Z'));   // 0.10.0 SH-2（D77）で v1.db の題名を日付の形にした
    assert.strictEqual(core.call(r.db, { role: 'app', cmd: 'pages.searchFull', args: { q: '結合テスト' } }, {}).result.total, 1);
    const raw = t.raw();
    assert.strictEqual(raw.prepare("select count(*) c from segments_fts where segments_fts match ?").get('"結合テスト"').c, 1);
  } finally { t.done(); }
});

// ---- 計画のテストに足した確かめ（目的の「決まった中身」と「backup() の写しも同じ」）
// 決まった中身: 一覧（ゴミ箱と取り消した会議は出ない）・飾り・ToDo・会議の種類・メモ・発言の欄・取り消しの印・版
function checkContents(t, file) {
  const r = t.open(file);
  assert.deepStrictEqual([r.state, r.version], ['ok', 1], '版 1 の ok で開けない');
  const call = (cmd, args) => { const o = core.call(r.db, { role: 'app', cmd, args }, { labels: {} }); assert.ok(o.ok, `${cmd} が ${o.code}`); return o.result; };
  // 一覧は新しい順（今の画面と同じ）
  assert.deepStrictEqual(call('pages.list', {}).map((p) => [p.id, p.title]), [['pfixture000002', titleAt('2026-10-16T01:00:00.000Z')], ['pfixture000001', titleAt('2026-10-15T01:00:00.000Z')]]);
  const { page, segments } = call('page.get', { id: 'pfixture000001' });
  assert.strictEqual(page.memo, 'リリース日の確認は次回も続ける');
  assert.strictEqual(page.meetingType, 'standup');
  assert.deepStrictEqual(page.meeting, { phase: 'done', recovered: false });
  assert.deepStrictEqual(page.blocks.map((b) => b.id), ['pfixture000001b1', 'pfixture000001b2', 'pfixture000001b3', 'pfixture000001b4', 'pfixture000001b5']);
  const rich = page.blocks.find((b) => b.id === 'pfixture000001b2');
  assert.deepStrictEqual([rich.text, rich.rich], ['結合テストは今週で完了した', [{ t: '結合テスト', m: ['b'] }, { t: 'は今週で完了した', m: [] }]]);
  const todo = page.blocks.find((b) => b.id === 'pfixture000001b4');
  assert.deepStrictEqual([todo.type, todo.assignee, todo.dueRaw, todo.due, todo.checked], ['todo', '担当A', '来週金曜', '2026-10-23', false]);
  assert.deepStrictEqual(segments.map((s) => s.id), ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's10', 's11']);
  assert.deepStrictEqual(segments[9], { id: 's11', atMs: 750000, durationMs: 30000, text: '（この区間の認識に失敗: 見本）', failed: true });
  assert.ok(!segments.some((s) => /山田|佐藤/.test(s.text)), '見本の発言に人の名前が残った');
  assert.deepStrictEqual(segments.find((s) => s.id === 's5'), { id: 's5', atMs: 300000, durationMs: 75000, text: '分かりました。実行計画を確認して、必要ならインデックスを追加します。', speaker: '話者2' });
  assert.strictEqual(call('page.get', { id: 'pfixture000003' }), null, 'ゴミ箱のページが見えた');
  assert.strictEqual(call('page.get', { id: 'pfixture000004' }), null, '取り消した会議が見えた');
  assert.deepStrictEqual(call('pages.actionView', {}).actions.map((a) => [a.blockId, a.assignee, a.due]), [['pfixture000001b4', '担当A', '2026-10-23']], '済みの ToDo が出た・まだの ToDo が出ない');
  const raw = t.raw(file);
  assert.deepStrictEqual(raw.prepare('select id, trashed_at from blocks where type = \'page\' order by id').all().map((x) => ({ ...x })), [
    { id: 'pfixture000001', trashed_at: null }, { id: 'pfixture000002', trashed_at: null }, { id: 'pfixture000003', trashed_at: '2026-10-16T09:00:00.000Z' }]);
  assert.strictEqual(raw.prepare('select count(*) c from segments where page_id = \'pfixture000004\'').get().c, 0, '取り消した会議の発言が残った');
  assert.strictEqual(raw.prepare('select count(*) c from segments_fts where segments_fts match ?').get('"取り消す見本"').c, 0, '取り消した会議の文字が索引に残った');
  assert.deepStrictEqual(raw.prepare('select role, actor, action, page_id from oplog order by seq').all().map((x) => Object.values(x).join(' ')), [
    'main system meeting.finalize pfixture000001',
    'app me page.setType pfixture000001',
    'app me page.setMemo pfixture000001',
    'app me block.setAction pfixture000001',
    'main system meeting.finalize pfixture000002',
    'main system meeting.finalize pfixture000003',
    'app me page.delete pfixture000003',
    'main system meeting.discard pfixture000004',
  ]);
  assert.strictEqual(raw.prepare('pragma user_version').get().user_version, 1);
  return r.db;
}

test('RF11: v1.db の決まった中身（一覧・飾り・ToDo・発言の欄・ゴミ箱・取り消しの印・oplog）が今の版で読める', { timeout: 5000 }, () => {
  const t = copyFixture('v1.db');
  try { checkContents(t, t.file); } finally { t.done(); }
});

test('RF11: v1.db を開いた接続の backup() の写しも、同じ中身で開け・素の接続で全文検索できる', { timeout: 5000 }, async () => {
  const t = copyFixture('v1.db');
  try {
    const r = t.open();
    assert.strictEqual(r.state, 'ok');
    const copy = path.join(t.dir, 'natsu-写し.db');
    await sqlite.backup(r.db, copy);
    checkContents(t, copy);
    assert.strictEqual(t.raw(copy).prepare('select count(*) c from segments_fts where segments_fts match ?').get('"結合テスト"').c, 1);
  } finally { t.done(); }
});

test('RF11: tools/make-db-fixture.js は2回走らせても同じ行を作る（決まった時刻と ID）。在る出力は上書きしない', { timeout: 5000 }, () => {
  const { makeFixture } = require('../tools/make-db-fixture');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-fx-作る𠮷-'));
  const opened = [];
  try {
    const dump = (file) => {
      const d = new sqlite.DatabaseSync(file, { readOnly: true }); opened.push(d);
      const out = {};
      for (const tb of ['blocks', 'segments', 'oplog', 'meta']) out[tb] = d.prepare(`select * from ${tb} order by 1`).all().map((x) => ({ ...x }));
      out.version = d.prepare('pragma user_version').get().user_version;
      return out;
    };
    const a = path.join(dir, 'a.db'); const b = path.join(dir, 'b.db');
    makeFixture({ file: a }); makeFixture({ file: b });
    for (const s of ['-wal', '-shm', '-journal']) assert.ok(!fs.existsSync(a + s), `${s} が残った（1つのファイルで commit できない）`);
    const before = fs.readFileSync(a);
    const da = dump(a);
    assert.ok(da.blocks.length > 5 && da.segments.length > 9 && da.oplog.length === 8, '見本が足りない');
    assert.deepStrictEqual(dump(b), da);
    assert.throws(() => makeFixture({ file: a }), /在る/);
    assert.deepStrictEqual(fs.readFileSync(a), before, '在る固定の DB を書き換えた');
  } finally {
    for (const d of opened) { try { d.close(); } catch (_) { /* 閉じ済み */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
