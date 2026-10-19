/* db-core.test.js — 第2a1回 ST2・ST3・ST4・T4b: 開く・版・命令の台・照らし・送り直し・oplog */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpDb } = require('./helpers/dbtmp');     // → { file, dir, open(opts), raw(opts), done() }（done は全部の接続を閉じてから消す）
const core = require('../src/db/core');
const V = require('../src/db/validate');

test('ST2: 開くと WAL・FULL・外部キー・busy_timeout・secure_delete。自分の確かめの結果を返す', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const r = t.open();
    assert.strictEqual(r.state, 'ok');
    assert.strictEqual(r.journal, 'wal');
    assert.deepStrictEqual(r.selfTest.trigram, true);
    assert.match(r.selfTest.sqlite, /^3\.\d+\.\d+$/);
    const p = (k) => Object.values(r.db.prepare(`pragma ${k}`).get())[0];
    assert.strictEqual(p('synchronous'), 2);
    assert.strictEqual(p('foreign_keys'), 1);
    assert.strictEqual(p('secure_delete'), 1);
    assert.ok(p('busy_timeout') >= 5000);
    assert.strictEqual(p('user_version'), core.SCHEMA_VERSION);
  } finally { t.done(); }
});

// 計画に足した確かめ: 外部キーは node:sqlite の既定（今は入っている）に頼らず、開くときに自分で入れる
test('ST2: 外部キーを切って作る SQLite でも、開くと foreign_keys が 1', { timeout: 5000 }, () => {
  const sqlite = require('node:sqlite');
  class NoFk extends sqlite.DatabaseSync { constructor(f, o) { super(f, { ...o, enableForeignKeyConstraints: false }); } }
  const t = tmpDb();
  try {
    const r = t.open({ sqlite: { DatabaseSync: NoFk } });
    assert.strictEqual(r.state, 'ok');
    assert.strictEqual(r.db.prepare('pragma foreign_keys').get().foreign_keys, 1);
  } finally { t.done(); }
});

test('ST3: 表は STRICT、索引に条件が無い、表の定義は JS の関数を呼ばない（素の接続で全文検索まで引ける）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    t.open();
    const raw = t.raw();     // 関数を1つも登録していない接続
    const sql = raw.prepare("select type, name, sql from sqlite_schema where sql is not null").all();
    for (const n of ['blocks', 'segments', 'oplog', 'meta']) assert.match(sql.find((x) => x.name === n).sql, /\)\s*STRICT\s*$/i, n);
    for (const ix of sql.filter((x) => x.type === 'index')) assert.ok(!/\bwhere\b/i.test(ix.sql), `条件付きの索引 ${ix.name}`);
    raw.exec("insert into blocks(id,type,page_id,ord,text,fold) values('pq1','page','pq1','a0','見本','予算案の作成')");
    assert.strictEqual(raw.prepare("select count(*) c from blocks_fts where blocks_fts match ?").get('"予算案"').c, 1);
    assert.match(raw.prepare("select v from blocks_fts_config where k = 'secure-delete'").get().v + '', /^1$/);
  } finally { t.done(); }
});

test('ST2: 版を1段ずつ上げる・新しすぎる版は読み取り専用で開いて書かない・落ちない', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const r0 = t.open(); r0.db.exec(`pragma user_version = ${core.SCHEMA_VERSION + 1}`); r0.db.close();
    const r = t.open();
    assert.strictEqual(r.state, 'newer');
    core.registerForTest({ 'test.w': { roles: ['main'], write: true, args: {}, run: () => ({ ops: [], pageIds: [], result: null }) } });
    const w = core.call(r.db, { role: 'main', cmd: 'test.w', args: {}, tx: 'm:test-w:1' }, { now: () => new Date() });
    assert.deepStrictEqual([w.ok, w.code], [false, 'read-only']);
    // 計画に足した確かめ: 接続そのものが読み取り専用（台の判定だけでなく、書く文も SQLite が断る）。版は下げない
    assert.throws(() => r.db.exec('create table zz(a integer) strict'), /readonly/i, '新しすぎる版を書ける形で開いた');
    assert.strictEqual(r.db.prepare('pragma user_version').get().user_version, core.SCHEMA_VERSION + 1);
  } finally { t.done(); }
});

test('ST4: 知らない命令・__proto__・constructor・役の違う命令は断る。エラーにパスや SQL を出さない', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    for (const cmd of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'nope', '', 7]) {
      const r = core.call(db, { role: 'app', cmd, args: {} }, {});
      assert.deepStrictEqual([r.ok, r.code], [false, 'unknown-cmd'], String(cmd));
    }
    core.registerForTest({ 'test.mainonly': { roles: ['main'], write: true, args: { pageId: 'id' }, run: () => ({ ops: [], pageIds: [], result: null }) } });
    const r = core.call(db, { role: 'app', cmd: 'test.mainonly', args: { pageId: 'pa1' }, tx: 'a:00000000-0000' }, {});
    assert.deepStrictEqual([r.ok, r.code], [false, 'forbidden']);
    assert.ok(!JSON.stringify(r).includes(t.dir) && !/select|insert/i.test(JSON.stringify(r)));
    assert.ok(Object.isFrozen(core.COMMANDS) && Object.getPrototypeOf(core.COMMANDS) === null);
  } finally { t.done(); }
});

test('ST4: 照らし — ID の形・長さ・件数・1MB・attrs の決まった名前・rich の飾りとリンク', { timeout: 5000 }, () => {
  assert.ok(V.ID_RE.test('p1') && V.ID_RE.test('pmz3k1abcde') && V.ID_RE.test('s12'));
  for (const bad of ['../x', 'a b', 'a.b', '', 'x'.repeat(65)]) assert.ok(!V.ID_RE.test(bad), bad);
  assert.strictEqual(V.checkArgs({ id: 'id' }, { id: '../x' }).ok, false);
  assert.strictEqual(V.checkArgs({ blocks: 'blocks' }, { blocks: new Array(2001).fill({ id: 'b1', type: 'bullet', text: '' }) }).ok, false);
  assert.strictEqual(V.checkArgs({ text: 'text' }, { text: 'x'.repeat(V.LIMITS.text + 1) }).ok, false);
  assert.strictEqual(V.checkArgs({ block: 'block' }, { block: { id: 'b1', type: 'bullet', text: 'x', attrs: { id: 'b2' } } }).ok, false);
  assert.strictEqual(V.richText([{ t: '今日は', m: [] }, { t: '大事', m: ['b'] }]), '今日は大事');
  assert.throws(() => V.richText([{ t: 'x', m: ['blink'] }]));
  assert.throws(() => V.richText([{ t: 'x', m: [['link', 'javascript:alert(1)']] }]));
  assert.strictEqual(V.richText([{ t: 'x', m: [['link', 'natsu://page/pa1']] }]), 'x');
  // 計画に足した確かめ: 1MB（件数と長さはどれも上限の内で、合わせた大きさだけが超える）と、通るものは通る
  const big = (n) => ({ blocks: new Array(n).fill({ id: 'b1', type: 'bullet', text: '字'.repeat(1000) }) });   // 1つ約 3KB
  assert.strictEqual(V.checkArgs({ blocks: 'blocks' }, big(300)).ok, true, '1MB より小さい頼みを断った');
  assert.strictEqual(V.checkArgs({ blocks: 'blocks' }, big(400)).ok, false, '1MB を超える頼みを通した');
  assert.strictEqual(V.checkArgs({ blocks: 'blocks' }, { blocks: new Array(2000).fill({ id: 'b1', type: 'bullet', text: '' }) }).ok, true);
  assert.strictEqual(V.checkArgs({ block: 'block' }, { block: { id: 'b1', type: 'bullet', text: 'x', attrs: { note: 'b2' } } }).ok, true);
  assert.strictEqual(V.checkArgs({ id: 'id', text: 'text?' }, { id: 'p1' }).ok, true);
  assert.strictEqual(V.checkArgs({ id: 'id' }, { id: 'p1', extra: 1 }).ok, false, '知らない引数を通した');
  assert.strictEqual(V.checkArgs({ id: 'id' }, {}).ok, false, '要る引数が無いのに通した');
  assert.throws(() => V.richText([{ t: 'x', m: [['link', 'file:///C:/x']] }]));
  assert.strictEqual(V.richText([{ t: 'x', m: [['link', 'https://example.com/']] }, { t: 'y', m: [['link', 'mailto:a@example.com']] }]), 'xy');
});

// 計画の LIMITS.segments: 500 から変えた（区間の長さは最短 20 秒なので、500 では 2 時間 46 分より長い会議の締めと復旧が DB に入らない）
test('ST4: 長い会議（20 秒の区間で 3 時間 = 540 区間）の発言は1つの頼みで通り、上限より多いものは断る', { timeout: 5000 }, () => {
  const segs = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, atMs: i * 20000, durationMs: 20000, text: '今日の議題について話します。' }));
  assert.strictEqual(V.checkArgs({ segments: 'segments' }, { segments: segs(540) }).ok, true, '3 時間の会議を断った');
  assert.strictEqual(V.checkArgs({ segments: 'segments' }, { segments: segs(V.LIMITS.segments + 1) }).ok, false);
});

test('ST4・T4b: 書く命令は本体と oplog を1つのトランザクションで。同じ (役, tx) は1回だけ・違う中身は tx-mismatch・違う役の同じ tx は別', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    core.registerForTest({ 'test.put': { roles: ['app', 'main'], write: true, args: { pageId: 'id', text: 'text' },
      run: (d, a) => { d.prepare("insert into meta(key,value) values(?,?) on conflict(key) do update set value=excluded.value").run('t:' + a.pageId, a.text); return { ops: [{ op: 'set', id: a.pageId, key: 't', value: a.text, old: null }], pageIds: [a.pageId], result: a.text }; } } });
    const c = (role, tx, a) => core.call(db, { role, cmd: 'test.put', args: a, tx }, { now: () => new Date('2026-10-19T00:00:00Z') });
    assert.strictEqual(c('app', 'a:tx-0001', { pageId: 'pa1', text: '一' }).ok, true);
    const dup = c('app', 'a:tx-0001', { pageId: 'pa1', text: '一' });
    assert.deepStrictEqual([dup.ok, dup.dup], [true, true]);
    assert.strictEqual(db.prepare('select count(*) c from oplog').get().c, 1, '送り直しで2回効いた');
    const mis = c('app', 'a:tx-0001', { pageId: 'pb2', text: '二' });
    assert.deepStrictEqual([mis.ok, mis.code], [false, 'tx-mismatch'], '中身の違う命令を「済み」と言った');
    assert.strictEqual(c('main', 'a:tx-0001', { pageId: 'pa1', text: '一' }).dup, undefined, '違う役の同じ tx を送り直しとみなした');
    assert.strictEqual(core.call(db, { role: 'app', cmd: 'test.put', args: { pageId: 'pa1', text: 'x' } }, {}).code, 'bad-args', 'tx の無い書き込みを通した');
    // 本体が投げたら oplog も残らない
    core.registerForTest({ 'test.boom': { roles: ['app'], write: true, args: {}, run: (d) => { d.prepare("insert into meta(key,value) values('boom','1')").run(); throw new Error('x'); } } });
    assert.strictEqual(core.call(db, { role: 'app', cmd: 'test.boom', args: {}, tx: 'a:tx-boom1' }, {}).code, 'internal');
    assert.strictEqual(db.prepare("select count(*) c from meta where key='boom'").get().c, 0);
    // 計画に足した確かめ: oplog の1行が書けなければ本体も残らない（oplog は本体と同じトランザクションの中で書く）
    core.registerForTest({ 'test.badops': { roles: ['app'], write: true, args: {}, run: (d) => { d.prepare("insert into meta(key,value) values('badops','1')").run(); return { ops: [{ op: 'set', id: 'pa1', key: 'k', value: 1n, old: null }], pageIds: [], result: null }; } } });
    assert.strictEqual(core.call(db, { role: 'app', cmd: 'test.badops', args: {}, tx: 'a:tx-badops1' }, {}).code, 'internal');
    assert.strictEqual(db.prepare("select count(*) c from meta where key='badops'").get().c, 0, 'oplog を書けなかったのに本体が残った');
    const row = db.prepare('select role, tx, actor, action, page_id, at from oplog').get();
    assert.deepStrictEqual({ ...row }, { role: 'app', tx: 'a:tx-0001', actor: 'me', action: 'test.put', page_id: 'pa1', at: '2026-10-19T00:00:00.000Z' });
  } finally { t.done(); }
});

test('T4b: diffPage は前の値を持ち、applyOps で前へも後ろへも当てられる', { timeout: 5000 }, () => {
  const O = require('../src/db/ops');
  const a = { id: 'pa1', title: '題', memo: '', blocks: [{ id: 'b1', type: 'bullet', text: '一' }] };
  const b = { id: 'pa1', title: '新しい題', memo: 'メモ', blocks: [{ id: 'b1', type: 'todo', text: '一つ', checked: true }, { id: 'b2', type: 'bullet', text: '二' }] };
  const ops = O.diffPage(a, b);
  assert.ok(ops.every((o) => o.op === 'add' || 'old' in o), '前の値の無い操作がある（元に戻せない）');
  assert.deepStrictEqual(new Set(ops.map((o) => o.op)), new Set(['text', 'set', 'retype', 'add']));
});

// 計画の「applyOps で前へも後ろへも」を、表に当てて確かめる（計画のテストは操作の形だけを見ていた）
test('T4b: applyOps で前へ当てると新しいページ、後ろへ当てると元のページの行に戻る（消した行・並べ替え・発言も）', { timeout: 5000 }, () => {
  const O = require('../src/db/ops');
  const t = tmpDb();
  try {
    const { db } = t.open();
    const a = { id: 'pa1', title: '題', memo: '', createdAt: '2026-10-19T00:00:00.000Z', blocks: [
      { id: 'b1', type: 'bullet', text: '一' }, { id: 'b2', type: 'bullet', text: '二', cites: ['s1'] }, { id: 'b3', type: 'todo', text: '三', checked: false }] };
    const b = { id: 'pa1', title: '新しい題', memo: 'メモの語', createdAt: '2026-10-19T00:00:00.000Z', blocks: [
      { id: 'b3', type: 'todo', text: '三', checked: true }, { id: 'b1', type: 'heading', text: '一つ目' }, { id: 'b4', type: 'bullet', text: '四', rich: [{ t: '四', m: ['b'] }] }] };
    O.applyOps(db, O.diffPage(null, a));
    const sa = [{ id: 's1', atMs: 0, durationMs: 1000, text: '最初の発言' }, { id: 's2', atMs: 1000, text: '二つ目', failed: true }];
    const sb = [{ id: 's2', atMs: 1000, text: '直した二つ目' }, { id: 's3', atMs: 2000, durationMs: 1000, text: '足した発言', speaker: 'A' }];
    O.applyOps(db, O.diffSegments([], sa, 'pa1'));
    const rows = () => db.prepare('select id, type, page_id, parent_id, text, rich, attrs, fold, created_at, trashed_at from blocks order by ord, id').all().map((r) => ({ ...r }));
    const segs = () => db.prepare('select id, n, at_ms, duration_ms, text, fold, failed, extra from segments where page_id = ? order by n').all('pa1').map((r) => ({ ...r }));
    const pageRows = (p) => ['pa1', ...p.blocks.map((x) => x.id)];
    const before = rows(); const segBefore = segs(); const rev0 = db.prepare("select rev from blocks where id='pa1'").get().rev;
    assert.deepStrictEqual(before.filter((r) => r.type !== 'page').map((r) => r.id), pageRows(a).slice(1));
    const ops = O.diffPage(a, b, { ords: Object.fromEntries(db.prepare("select id, ord from blocks where page_id='pa1' and type != 'page'").all().map((r) => [r.id, r.ord])) });
    const sops = O.diffSegments(sa, sb, 'pa1');
    const all = JSON.parse(JSON.stringify([...ops, ...sops]));   // oplog に入れて読み直した形で当てる
    O.applyOps(db, all, 'forward');
    const after = rows();
    assert.deepStrictEqual(after.filter((r) => r.type !== 'page').map((r) => r.id), pageRows(b).slice(1), '並びが新しいページと違う');
    const pg = after.find((r) => r.id === 'pa1');
    assert.strictEqual(pg.text, '新しい題');
    assert.strictEqual(JSON.parse(pg.attrs).memo, 'メモの語');
    assert.ok(pg.fold.includes('メモの語') && pg.fold.includes('新しい題'), '題名とメモの検索の欄を作り直していない');
    assert.strictEqual(JSON.parse(after.find((r) => r.id === 'b3').attrs).checked, true);
    assert.strictEqual(after.find((r) => r.id === 'b4').text, '四');
    assert.ok(!after.some((r) => r.id === 'b2'));
    assert.deepStrictEqual(segs().map((s) => [s.id, s.text, s.failed]), [['s2', '直した二つ目', null], ['s3', '足した発言', null]]);
    assert.strictEqual(JSON.parse(segs()[1].extra).speaker, 'A');
    assert.strictEqual(db.prepare("select rev from blocks where id='pa1'").get().rev, rev0 + 1, 'ページの rev を上げていない');
    assert.strictEqual(db.prepare('select count(*) c from blocks_fts where blocks_fts match ?').get('"一つ目"').c, 1, '全文検索の索引が合っていない');
    O.applyOps(db, all, 'backward');
    assert.deepStrictEqual(rows(), before, '後ろへ当てても元の行に戻らない');
    assert.deepStrictEqual(segs(), segBefore, '後ろへ当てても元の発言に戻らない');
    assert.strictEqual(db.prepare('select count(*) c from blocks_fts where blocks_fts match ?').get('"一つ目"').c, 0);
    assert.strictEqual(db.prepare("pragma integrity_check").get().integrity_check, 'ok');
    db.exec("insert into blocks_fts(blocks_fts) values('integrity-check')");
    db.exec("insert into segments_fts(segments_fts) values('integrity-check')");
  } finally { t.done(); }
});

test('ST2: 版の上げが途中で投げたら、版も表も上がらない（BEGIN IMMEDIATE の中で1段ずつ）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    // 計画の x1(a) は STRICT では「型が無い」で1つ目の文から落ち、半分だけ作る形を試せないので、型を付けた
    const boom = { 1: "create table x1(a integer) strict; create table x2(", };   // 2つ目の文で構文の誤り
    const r = t.open({ steps: boom });
    assert.strictEqual(r.state, 'failed');
    const raw = t.raw();
    assert.strictEqual(raw.prepare('pragma user_version').get().user_version, 0, '版だけ上がった');
    assert.strictEqual(raw.prepare("select count(*) c from sqlite_schema where name = 'x1'").get().c, 0, '半分だけ作った');
  } finally { t.done(); }
});

// 計画に足した確かめ: 自分の確かめは本当に trigram で引く（いつも真にしない）。trigram の無い SQLite なら failed で、表を作らない
test('ST2: trigram が効かない SQLite では自分の確かめが通らず failed（表も版も作らない）', { timeout: 5000 }, () => {
  const sqlite = require('node:sqlite');
  // 一時の表の trigram を、日本語を区切らない unicode61 にすり替えた偽の SQLite（本物の表の定義はすり替えない）
  class NoTrigram extends sqlite.DatabaseSync {
    exec(sql) { return super.exec(/\btemp\./i.test(sql) ? sql.replace(/tokenize\s*=\s*'trigram'/i, "tokenize='unicode61'") : sql); }
  }
  const t = tmpDb();
  try {
    const r = t.open({ sqlite: { DatabaseSync: NoTrigram } });
    assert.deepStrictEqual([r.state, r.selfTest && r.selfTest.trigram], ['failed', false]);
    const raw = t.raw();
    assert.strictEqual(raw.prepare('pragma user_version').get().user_version, 0);
    assert.strictEqual(raw.prepare("select count(*) c from sqlite_schema where name = 'blocks'").get().c, 0);
  } finally { t.done(); }
});

test('ST2: 別のプロセスの読み手は、確定していない書き込みを見ない', { timeout: 5000 }, () => {
  const { spawnSync } = require('node:child_process');
  const t = tmpDb();
  try {
    const { db } = t.open();
    const count = () => Number(spawnSync(process.execPath, ['-e',
      `const s=require('node:sqlite');const d=new s.DatabaseSync(process.argv[1],{readOnly:true});process.stdout.write(String(d.prepare("select count(*) c from blocks").get().c));d.close();`,
      t.file], { encoding: 'utf8' }).stdout);
    db.exec('begin immediate');
    db.exec("insert into blocks(id,type,page_id,ord,text) values('pr1','page','pr1','a0','見本')");
    assert.strictEqual(count(), 0, '半端な状態が見えた');
    db.exec('commit');
    assert.strictEqual(count(), 1);
  } finally { t.done(); }
});

test('ST4: rich があれば text は rich から作り直す（食い違ったまま保存しない）', { timeout: 5000 }, () => {
  assert.deepStrictEqual(V.normalizeBlock({ id: 'b1', type: 'bullet', text: '古い文', rich: [{ t: '新しい', m: [] }, { t: '文', m: ['b'] }] }).text, '新しい文');
  assert.strictEqual(V.normalizeBlock({ id: 'b1', type: 'bullet', text: 'そのまま' }).text, 'そのまま');
  // 計画に足した確かめ: 書き込みの照らしを通ると、作り直した text になる（照らしの道でも食い違いを残さない）
  const r = V.checkArgs({ block: 'block' }, { block: { id: 'b1', type: 'bullet', text: '古い文', rich: [{ t: '新しい文', m: ['i'] }] } });
  assert.deepStrictEqual([r.ok, r.args.block.text], [true, '新しい文']);
});

// 計画に足した確かめ: 送り直しの答えは命令の dupResult が今の中身から作る。tx の形が悪い書き込みは断る。actor は役から
test('ST4: 送り直しの答えは dupResult、tx の形が悪ければ bad-args、actor は app → me・main → system（main だけ recovery・migration を名乗れる）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    core.registerForTest({ 'test.note': { roles: ['app', 'main'], write: true, args: { pageId: 'id', text: 'text' },
      run: (d, a) => { d.prepare("insert into meta(key,value) values(?,?) on conflict(key) do update set value=excluded.value").run('n:' + a.pageId, a.text); return { ops: [], pageIds: [a.pageId], result: { v: a.text } }; },
      dupResult: (d, a) => ({ v: d.prepare('select value from meta where key = ?').get('n:' + a.pageId).value }) } });
    const c = (role, tx, args) => core.call(db, { role, cmd: 'test.note', args, tx }, {});
    const w = c('app', 'a:note-0001', { pageId: 'pn1', text: '一' });
    assert.deepStrictEqual([w.ok, w.result, w.changed], [true, { v: '一' }, { pageIds: ['pn1'], actor: 'me' }]);
    assert.strictEqual(c('app', 'a:note-0002', { pageId: 'pn1', text: '二' }).ok, true);
    const d = c('app', 'a:note-0001', { pageId: 'pn1', text: '一' });
    assert.deepStrictEqual([d.ok, d.dup, d.result], [true, true, { v: '二' }], '送り直しの答えが今の中身でない');
    for (const tx of ['short', 'a:../..', 'x'.repeat(121), 7, 'a:空白 あり']) assert.strictEqual(c('app', tx, { pageId: 'pn1', text: '三' }).code, 'bad-args', String(tx));
    assert.strictEqual(c('main', 'm:note-0001', { pageId: 'pn1', text: '四', actor: 'recovery' }).ok, true);
    assert.strictEqual(c('app', 'a:note-0003', { pageId: 'pn1', text: '五', actor: 'recovery' }).code, 'bad-args', 'app が actor を名乗れた');
    assert.strictEqual(c('main', 'm:note-0002', { pageId: 'pn1', text: '六', actor: 'me' }).code, 'bad-args');
    assert.deepStrictEqual(db.prepare('select role, actor from oplog order by seq').all().map((r) => `${r.role}/${r.actor}`), ['app/me', 'app/me', 'main/recovery']);
    assert.strictEqual(core.call(db, { role: 'mcp', cmd: 'test.note', args: { pageId: 'pn1', text: 'x' }, tx: 'x:note-0001' }, {}).code, 'forbidden');
  } finally { t.done(); }
});
