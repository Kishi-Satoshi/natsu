/* db-reimport.test.js — 第2a1回 ST10・RF17: 起動のたびの取り込み */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { oldBuildData } = require('./helpers/dbtmp');
const M = require('../src/db/migrate');
const sqlite = require('node:sqlite');

test('RF17: 移した後に古い版が書いた JSON — 新しいページは足し、書き換えたページは置き換え、両方で直したページ（ゴミ箱へ入れたページを含む）は別のページとして足し、purge のページは戻さない', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 4 });
  try {
    M.migrate({ sqlite, dataDir: d.dataDir });
    const db = new sqlite.DatabaseSync(path.join(d.dataDir, 'natsu.db'));
    const core = require('../src/db/core');
    let k = 0;
    const c = (cmd, args, role = 'app') => core.call(db, { role, cmd, args, tx: `${role[0]}:${cmd}:${String(++k).padStart(4, '0')}` }, { now: () => new Date('2026-10-19T00:00:00Z') });
    c('page.setTitle', { id: d.ids[1], title: '新しい版で直した' });
    c('page.delete', { id: d.ids[2] });
    db.prepare("insert into oplog(role,tx,at,actor,action,page_id,ops) values('main','m:x-00001','2026-10-19T00:00:00Z','system','meeting.discard','pgone1','[{\"op\":\"purge\",\"id\":\"pgone1\"}]')").run();
    d.oldBuild((store) => {   // 古い版の store.js で書く
      store.createPage({ title: '古い版で録った会議', segments: [{ id: 's1', atMs: 0, text: '古い版の発言' }] });
      const p0 = store.getPage(d.ids[0]); p0.title = '古い版で直した0'; store.savePage(p0);
      const p1 = store.getPage(d.ids[1]); p1.title = '古い版で直した1'; store.savePage(p1);
      const p2 = store.getPage(d.ids[2]); p2.memo = '古い版のメモ'; store.savePage(p2);
      d.writePage({ id: 'pgone1', title: '取り消した会議', blocks: [] }, []);
    });
    const r = M.reimport({ db, dataDir: d.dataDir });
    assert.deepStrictEqual([r.added, r.replaced, r.copied, r.skipped, r.broken], [1, 1, 2, 1, 0]);
    const titles = c('pages.list', {}).result.map((p) => p.title).sort();
    assert.ok(titles.includes('古い版で録った会議') && titles.includes('古い版で直した0'));
    assert.ok(titles.includes('新しい版で直した') && titles.includes(`古い版で直した1${M.COPY_SUFFIX}`), '両方で直したページの片方が消えた');
    assert.ok(!titles.includes('取り消した会議'), 'purge したページが戻った');
    assert.strictEqual(c('page.get', { id: d.ids[2] }).result, null, 'ゴミ箱のページそのものが戻った');
    const again = M.reimport({ db, dataDir: d.dataDir });
    assert.deepStrictEqual([again.added, again.replaced, again.copied], [0, 0, 0], '同じものを2回取り込んだ');
    db.close();
  } finally { d.done(); }
});

test('F3: 取り込みが途中で落ちても、次の起動で同じページを2回足さない（1ページずつ指紋と同じトランザクション）', { timeout: 5000 }, () => {
  const d = oldBuildData({ pages: 2 });
  try {
    M.migrate({ sqlite, dataDir: d.dataDir });
    const db = new sqlite.DatabaseSync(path.join(d.dataDir, 'natsu.db'));
    d.oldBuild((store) => { for (let i = 0; i < 3; i++) store.createPage({ title: `古い版の会議${i}`, segments: [] }); });
    let n = 0;
    assert.throws(() => M.reimport({ db, dataDir: d.dataDir, onPage: () => { if (++n === 2) throw new Error('落ちた'); } }));
    M.reimport({ db, dataDir: d.dataDir });
    const titles = db.prepare("select text from blocks where type='page' and text like '古い版の会議%'").all().map((x) => x.text).sort();
    assert.deepStrictEqual(titles, ['古い版の会議0', '古い版の会議1', '古い版の会議2']);
    db.close();
  } finally { d.done(); }
});

// ---- 計画に足した確かめ（D-5b の実装で決めた細部）
const fs = require('node:fs');
const dbpeek = require('./helpers/dbpeek');

function setup(pages) {
  const d = oldBuildData({ pages });
  let db;
  try {
    M.migrate({ sqlite, dataDir: d.dataDir });
    db = new sqlite.DatabaseSync(path.join(d.dataDir, 'natsu.db'));
  } catch (e) { d.done(); throw e; }
  let k = 0;
  const core = require('../src/db/core');
  const c = (cmd, args) => core.call(db, { role: 'app', cmd, args, tx: `a:${cmd}:${String(++k).padStart(4, '0')}` }, { now: () => new Date('2026-10-19T00:00:00Z') });
  const pf = (id) => path.join(d.dataDir, 'pages', `${id}.json`);
  const tf = (id) => path.join(d.dataDir, 'transcripts', `${id}.json`);
  // DB を必ず閉じてから一時フォルダを消す（Windows では開いたままだと消せず、本当の失敗が EBUSY に隠れる）
  const done = () => { try { if (db.isOpen) db.close(); } finally { d.done(); } };
  return { d, db, c, pf, tf, done };
}

test('RF17: 置き換えたページと足したページは元の JSON と深く同じ（発言も）。oplog に actor migration の1行ずつ（戻せる）。指紋は今のファイルと rev', { timeout: 5000 }, () => {
  const { d, db, pf, done } = setup(2);
  try {
    let newId = null;
    d.oldBuild((store) => {
      const p0 = store.getPage(d.ids[0]); p0.title = '古い版で直した'; p0.blocks.pop(); p0.blocks.reverse(); store.savePage(p0);
      store.saveTranscript(d.ids[0], [{ id: 's1', atMs: 0, text: '古い版で直した発言' }]);
      newId = store.createPage({ title: '古い版の新しいページ', blocks: [{ id: d.ids[1], type: 'bullet', text: 'ほかのページの ID と同じブロック', cites: [] }], segments: [{ id: 's1', atMs: 0, text: '一' }] }).id;
    });
    const r = M.reimport({ db, dataDir: d.dataDir });
    assert.deepStrictEqual([r.added, r.replaced, r.copied], [1, 1, 0]);
    db.close();
    const peek = dbpeek.open(d.dataDir);
    try {
      assert.deepStrictEqual(peek.rawPage(d.ids[0]), d.rawPage(d.ids[0]));
      assert.deepStrictEqual(peek.getTranscript(d.ids[0]), [{ id: 's1', atMs: 0, text: '古い版で直した発言' }]);
      const added = peek.rawPage(newId);
      assert.strictEqual(added.title, '古い版の新しいページ');
      assert.notStrictEqual(added.blocks[0].id, d.ids[1], 'ほかのページの ID と重なるブロックを振り直していない');
      assert.ok(peek.rawPage(d.ids[1]), '重なった ID のページが消えた');
      const logs = peek.db.prepare('select role, actor, action, page_id from oplog order by seq').all().map((x) => ({ ...x }));
      assert.deepStrictEqual(logs, [
        { role: 'main', actor: 'migration', action: 'json.reimport', page_id: d.ids[0] },
        { role: 'main', actor: 'migration', action: 'json.reimport', page_id: newId },
      ].sort((a, b) => (a.page_id < b.page_id ? -1 : 1)));
      const fp = peek.meta(`json:${d.ids[0]}`);
      assert.deepStrictEqual([fp.size, fp.mtimeMs], [fs.statSync(pf(d.ids[0])).size, fs.statSync(pf(d.ids[0])).mtimeMs]);
      assert.strictEqual(fp.rev, peek.db.prepare('select rev from blocks where id = ?').get(d.ids[0]).rev);
    } finally { peek.close(); }
  } finally { done(); }
});

test('RF17: 変わっていないファイルは読まない（大きさと時刻が同じ）。触っただけ（中身が同じ）なら数えずに指紋の時刻だけ直す（DB の側を直していても別のページにしない）。読んだ値が同じなら数えない', { timeout: 5000 }, () => {
  const { d, db, c, pf, done } = setup(3);
  try {
    c('page.setTitle', { id: d.ids[1], title: '新しい版で直した' });
    const reads = [];
    const spy = { ...fs, readFileSync: (f, ...a) => { reads.push(path.basename(f)); return fs.readFileSync(f, ...a); } };
    const r0 = M.reimport({ db, dataDir: d.dataDir, fs: spy });
    assert.deepStrictEqual([r0.added, r0.replaced, r0.copied, reads.length], [0, 0, 0, 0], '移した直後のファイルを読んだ・取り込んだ');
    const t = new Date(Date.now() + 60000);
    fs.writeFileSync(pf(d.ids[1]), fs.readFileSync(pf(d.ids[1])));
    fs.utimesSync(pf(d.ids[1]), t, t);
    const r1 = M.reimport({ db, dataDir: d.dataDir, fs: spy });
    assert.deepStrictEqual([r1.added, r1.replaced, r1.copied], [0, 0, 0]);
    assert.ok(reads.includes(`${d.ids[1]}.json`), '時刻の変わったファイルを読んでいない');
    reads.length = 0;
    M.reimport({ db, dataDir: d.dataDir, fs: spy });
    assert.deepStrictEqual(reads, [], '触っただけのファイルの指紋の時刻を直していない（毎回読む）');
    // BOM を付けただけ（バイトは違うが読んだ値は同じ）: DB の側は変わっていないページなので置き換えの道に入るが、何も変わらないので数えない
    fs.writeFileSync(pf(d.ids[2]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(pf(d.ids[2]))]));
    const r2 = M.reimport({ db, dataDir: d.dataDir });
    assert.deepStrictEqual([r2.added, r2.replaced, r2.copied], [0, 0, 0], '中身の同じページを取り込んだと数えた');
    assert.deepStrictEqual(c('pages.list', {}).result.map((p) => p.title).filter((t) => t.endsWith(M.COPY_SUFFIX)), [], '触っただけのページを別のページとして足した');
    assert.strictEqual(db.prepare("select count(*) c from oplog where actor = 'migration'").get().c, 0);
  } finally { done(); }
});

test('RF17: 両方で直した後も、古い版がまた直せば DB の側は上書きせず、もう1つ別のページとして足す（どちらも消さない）。別のページは文字起こしも写す', { timeout: 5000 }, () => {
  const { d, db, c, done } = setup(1);
  try {
    c('page.setTitle', { id: d.ids[0], title: '新しい版で直した' });
    d.oldBuild((store) => { const p = store.getPage(d.ids[0]); p.title = '古い版1'; store.savePage(p); });
    assert.strictEqual(M.reimport({ db, dataDir: d.dataDir }).copied, 1);
    d.oldBuild((store) => { const p = store.getPage(d.ids[0]); p.title = '古い版2'; store.savePage(p); });
    const r = M.reimport({ db, dataDir: d.dataDir });
    assert.deepStrictEqual([r.replaced, r.copied], [0, 1], '食い違った後の古い版の直しで DB の側を置き換えた');
    const list = c('pages.list', {}).result;
    assert.deepStrictEqual(list.map((p) => p.title).sort(), ['古い版1（古い版で直したもの）', '古い版2（古い版で直したもの）', '新しい版で直した'].sort());
    const copy = list.find((p) => p.title.startsWith('古い版2'));
    assert.notStrictEqual(copy.id, d.ids[0]);
    assert.deepStrictEqual(c('page.get', { id: copy.id }).result.segments, c('page.get', { id: d.ids[0] }).result.segments, '別のページに文字起こしを写していない');
  } finally { done(); }
});

test('RF17: 置き換えで文字起こしが無い・壊れているときは DB の発言を消さない。壊れたもの・表せないもの・読めないものは入れず数え、skippedSig は組が変わったときだけ変わる', { timeout: 5000 }, () => {
  const { d, db, c, pf, tf, done } = setup(3);
  try {
    d.oldBuild((store) => {
      for (const id of [d.ids[0], d.ids[1]]) { const p = store.getPage(id); p.title = `古い版で直した${id}`; store.savePage(p); }
    });
    fs.writeFileSync(tf(d.ids[0]), '{"id":');   // 壊れた
    fs.rmSync(tf(d.ids[1]));                   // 無い
    fs.writeFileSync(pf('pbroken0001'), '{"id":"pbroken0001","title":"壊れた');
    d.writePage({ id: 'pshape0001', title: 7, blocks: [] }, []);
    fs.mkdirSync(pf('punread0001'));
    const r = M.reimport({ db, dataDir: d.dataDir });
    assert.deepStrictEqual([r.added, r.replaced, r.copied, r.broken, r.badShape, r.unreadable], [0, 2, 0, 2, 1, 1]);
    for (const id of [d.ids[0], d.ids[1]]) {
      const got = c('page.get', { id }).result;
      assert.strictEqual(got.page.title, `古い版で直した${id}`);
      assert.strictEqual(got.segments.length, 3, '壊れた・無い文字起こしで DB の発言を消した');
    }
    assert.match(r.skippedSig, /^[0-9a-f]{64}$/);
    const again = M.reimport({ db, dataDir: d.dataDir });
    assert.deepStrictEqual([again.replaced, again.broken, again.badShape, again.unreadable, again.skippedSig], [0, 2, 1, 1, r.skippedSig], '同じ組なのに数か skippedSig が変わった（読まずに飛ばした壊れた文字起こしも数える）');
    assert.ok(!db.prepare("select 1 from meta where key in ('json:pbroken0001', 'json:pshape0001', 'json:punread0001')").get(), '入れていないファイルの指紋を書いた');
    d.writePage({ id: 'pshape0001', title: '直した', blocks: [] }, []);
    const fixed = M.reimport({ db, dataDir: d.dataDir });
    assert.deepStrictEqual([fixed.added, fixed.badShape], [1, 0]);
    assert.notStrictEqual(fixed.skippedSig, r.skippedSig, '飛ばしたファイルの組が変わったのに skippedSig が同じ');
  } finally { done(); }
});

test('RF17: 古い版が消したページ（DB にあって JSON が無い）は DB の側をそのまま残す。行の無い ID に印が無ければ同じ ID で戻す', { timeout: 5000 }, () => {
  const { d, db, c, pf, done } = setup(2);
  try {
    d.oldBuild((store) => store.deletePage(d.ids[0]));
    assert.ok(!fs.existsSync(pf(d.ids[0])));
    const r = M.reimport({ db, dataDir: d.dataDir });
    assert.deepStrictEqual([r.added, r.replaced, r.copied, r.skipped], [0, 0, 0, 0]);
    assert.ok(c('page.get', { id: d.ids[0] }).result, '古い版が消したページを DB から消した');
    db.prepare('delete from segments where page_id = ?').run(d.ids[1]);
    db.prepare('delete from blocks where page_id = ?').run(d.ids[1]);   // 印の無いまま行が無くなった（控えから戻したなど）
    d.oldBuild((store) => { const p = store.getPage(d.ids[1]); p.title = '古い版で直した'; store.savePage(p); });
    assert.strictEqual(M.reimport({ db, dataDir: d.dataDir }).added, 1);
    assert.strictEqual(c('page.get', { id: d.ids[1] }).result.page.title, '古い版で直した');
  } finally { done(); }
});

test('RF17: ゴミ箱のページは rev が同じでも「DB の側も変わった」とみなし、置き換えずに別のページとして足す（ゴミ箱から出さない）', { timeout: 5000 }, () => {
  const { d, db, c, done } = setup(1);
  try {
    // rev を上げずにゴミ箱へ（rev だけで見ると置き換えてしまう形）
    db.prepare("update blocks set trashed_at = '2026-10-19T00:00:00.000Z' where id = ?").run(d.ids[0]);
    d.oldBuild((store) => { const p = store.getPage(d.ids[0]); p.title = '古い版で直した'; store.savePage(p); });
    const r = M.reimport({ db, dataDir: d.dataDir });
    assert.deepStrictEqual([r.replaced, r.copied], [0, 1]);
    assert.strictEqual(c('page.get', { id: d.ids[0] }).result, null, 'ゴミ箱のページを置き換えて戻した');
    assert.deepStrictEqual(c('pages.list', {}).result.map((p) => p.title), [`古い版で直した${M.COPY_SUFFIX}`]);
  } finally { done(); }
});

test('F3: 指紋が書けなければ、そのページの書き込みも戻す（ページだけ残って、次の起動で「指紋の無い行」として別のページを足さない）', { timeout: 5000 }, () => {
  const { d, db, done } = setup(1);
  try {
    let ids = [];
    d.oldBuild((store) => { ids = [0, 1, 2].map((i) => store.createPage({ title: `古い版の会議${i}`, segments: [] }).id); });
    db.exec(`create temp trigger natsu_test_fp before insert on meta when new.key = 'json:${ids[1]}' begin select raise(abort, 'fp'); end`);
    try { M.reimport({ db, dataDir: d.dataDir }); } catch (_) { /* 落ちたのと同じ */ }
    db.exec('drop trigger natsu_test_fp');
    M.reimport({ db, dataDir: d.dataDir });
    const titles = db.prepare("select text from blocks where type='page' and text like '古い版の会議%'").all().map((x) => x.text).sort();
    assert.deepStrictEqual(titles, ['古い版の会議0', '古い版の会議1', '古い版の会議2']);
  } finally { done(); }
});

test('RF17: 別のページとして足すときも、題名が文字でないページは表せないものとして数え、入れない', { timeout: 5000 }, () => {
  const { d, db, c, pf, done } = setup(1);
  try {
    c('page.setTitle', { id: d.ids[0], title: '新しい版で直した' });
    const raw = JSON.parse(fs.readFileSync(pf(d.ids[0]), 'utf8'));
    d.writePage({ ...raw, title: 7 });
    const r = M.reimport({ db, dataDir: d.dataDir });
    assert.deepStrictEqual([r.copied, r.badShape], [0, 1]);
    assert.deepStrictEqual(c('pages.list', {}).result.map((p) => p.title), ['新しい版で直した']);
  } finally { done(); }
});
