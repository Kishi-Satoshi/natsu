/* db-meeting.test.js — 第2a1回 ST6・RF16・F11: 会議の命令 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { tmpDb } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const NOW = () => new Date('2026-10-19T01:02:03.000Z');
let n = 0;
const call = (db, cmd, args, role = 'main') => core.call(db, { role, cmd, args, tx: `${role[0]}:t-${String(++n).padStart(6, '0')}` }, { now: NOW, labels: {} });

test('ST6: 会議 — begin の写しは一覧に出ない・segment は (page_id, id) で上書き・finalize で出る・同じ tx の finalize は1つ', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    t.seed({ id: 'pa0', title: '別のページ', blocks: [] }, []);
    // app の口が先に main の締めと同じ tx を名乗っても、後の main の meeting.finalize は効く（設計書「送り直し」のテスト）
    assert.strictEqual(core.call(db, { role: 'app', cmd: 'page.setTitle', args: { id: 'pa0', title: 'x' }, tx: 'meeting:1760000000000' }, { now: NOW }).ok, true);
    call(db, 'meeting.begin', { pageId: 'pm1', startedAt: 1760000000000, localOnly: false });
    call(db, 'meeting.segment', { pageId: 'pm1', seg: { id: 's1', atMs: 0, durationMs: 3000, text: '一' } });
    call(db, 'meeting.segment', { pageId: 'pm1', seg: { id: 's1', atMs: 0, durationMs: 3000, text: '一（確定）' } });
    assert.deepStrictEqual(call(db, 'pages.list', {}).result.map((p) => p.id), ['pa0'], '録音中の写しが一覧に出た');
    const fin = (tx) => core.call(db, { role: 'main', cmd: 'meeting.finalize', args: { pageId: 'pm1', page: { title: '会議', blocks: [] }, segments: [{ id: 's1', atMs: 0, durationMs: 3000, text: '一（確定）' }] }, tx }, { now: NOW });
    const f1 = fin('meeting:1760000000000');
    assert.deepStrictEqual([f1.ok, f1.dup], [true, undefined], 'app の同じ tx を main の送り直しとみなした');
    const f2 = fin('meeting:1760000000000');
    assert.deepStrictEqual([f2.dup, f2.result.id], [true, 'pm1'], '送り直しの答えにページが無い');
    assert.deepStrictEqual(call(db, 'pages.list', {}).result.map((p) => p.id).sort(), ['pa0', 'pm1']);
    assert.strictEqual(db.prepare("select count(*) c from segments where page_id='pm1'").get().c, 1);
    // 締めの後に送り直しの begin・segment が届いても、写しに戻さない
    call(db, 'meeting.begin', { pageId: 'pm1', startedAt: 1760000000000, localOnly: false });
    call(db, 'meeting.segment', { pageId: 'pm1', seg: { id: 's1', atMs: 0, durationMs: 3000, text: '古い' } });
    assert.ok(call(db, 'pages.list', {}).result.some((p) => p.id === 'pm1'), '締めた会議が写しに戻って一覧から消えた');
    assert.strictEqual(call(db, 'page.get', { id: 'pm1' }).result.segments[0].text, '一（確定）');
  } finally { t.done(); }
});

test('F11: recover は締め済みのページを上書きせず、足りない発言だけ足す。写しなら下書きで上書きする', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    call(db, 'meeting.finalize', { pageId: 'pm2', page: { title: '会議', blocks: [] }, segments: [{ id: 's1', atMs: 0, durationMs: 1, text: '一' }] });
    call(db, 'page.put', { page: { ...call(db, 'page.get', { id: 'pm2' }).result.page, title: '直した題', blocks: [{ id: 'b1', type: 'bullet', text: '要約の行' }] }, baseRev: call(db, 'page.get', { id: 'pm2' }).result.page.rev });
    const draftSegs = [{ id: 's1', atMs: 0, durationMs: 1, text: '一' }, { id: 's2', atMs: 1, durationMs: 1, text: '二' }];
    const r = call(db, 'meeting.recover', { pageId: 'pm2', page: { title: '（復旧）', blocks: [], recovered: true }, segments: draftSegs });
    assert.strictEqual(r.result.already, true);
    const g = call(db, 'page.get', { id: 'pm2' }).result;
    assert.deepStrictEqual([g.page.title, g.page.blocks.length], ['直した題', 1], '復旧が要約と直しを空で上書きした');
    assert.deepStrictEqual(g.segments.map((s) => s.id), ['s1', 's2']);
    call(db, 'meeting.begin', { pageId: 'pm3', startedAt: 2, localOnly: false });
    call(db, 'meeting.segment', { pageId: 'pm3', seg: { id: 's1', atMs: 0, durationMs: 1, text: '一' } });
    const r3 = call(db, 'meeting.recover', { pageId: 'pm3', page: { title: '（復旧）', blocks: [], recovered: true }, segments: draftSegs });
    assert.strictEqual(r3.result.already, false);
    assert.deepStrictEqual(call(db, 'page.get', { id: 'pm3' }).result.segments.map((s) => s.text), ['一', '二']);
  } finally { t.done(); }
});

test('ST6: settle は keep に無い写しだけを recovered で残し、keep の写しには触れない', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    for (const id of ['pk1', 'pk2']) { call(db, 'meeting.begin', { pageId: id, startedAt: 1, localOnly: false }); call(db, 'meeting.segment', { pageId: id, seg: { id: 's1', atMs: 0, durationMs: 1, text: '一' } }); }
    assert.strictEqual(call(db, 'meeting.settle', { keep: ['pk1'] }).result.settled, 1);
    const phase = (id) => JSON.parse(db.prepare('select attrs from blocks where id=?').get(id).attrs).meeting;
    assert.strictEqual(phase('pk1').phase, 'recording', '下書きのある写しを片付けた（復旧で上書きできなくなる）');
    assert.deepStrictEqual([phase('pk2').phase, phase('pk2').recovered], ['done', true]);
  } finally { t.done(); }
});

test('RF16: meeting.discard は行・発言・oplog を消して purge の印だけ残し、DB が自分でチェックポイントするのでファイルに文字もかけらも無い', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const SECRET = '人事評価の極秘メモの文';
    call(db, 'meeting.begin', { pageId: 'pz1', startedAt: 1, localOnly: true });
    for (let i = 1; i <= 30; i++) call(db, 'meeting.segment', { pageId: 'pz1', seg: { id: `s${i}`, atMs: i, durationMs: 1, text: SECRET + i } });
    call(db, 'meeting.discard', { pageId: 'pz1' });
    // ここで手のチェックポイントはしない（DB の after: 'checkpoint' を見る。しなければ -wal に文字が残る）
    const bytes = Buffer.concat([fs.readFileSync(t.file), fs.existsSync(t.file + '-wal') ? fs.readFileSync(t.file + '-wal') : Buffer.alloc(0)]);
    for (const frag of ['人事評価', '極秘メモ', '評価の', 'メモの文']) assert.strictEqual(bytes.indexOf(Buffer.from(frag)), -1, frag);
    assert.deepStrictEqual(db.prepare("select action, ops from oplog where page_id='pz1'").all().map((r) => [r.action, r.ops]), [['meeting.discard', '[{"op":"purge","id":"pz1"}]']]);
  } finally { t.done(); }
});

// ---- ここから下は計画のテストに足したもの（計画に無い守りと、変異を生き残らせないための確かめ）

test('RF16: 発言が少なく FTS5 の索引がまだ混ぜられていない会議を取り消しても、trigram のかけらが残らない（FTS5 の secure-delete）', { timeout: 5000 }, () => {
  // 30 区間だと FTS5 の自動の混ぜ合わせで消した行のかけらも落ちるので、secure-delete を外しても上のテストは通ってしまう
  const t = tmpDb();
  try {
    const { db } = t.open();
    call(db, 'meeting.begin', { pageId: 'pz2', startedAt: 1, localOnly: true });
    for (let i = 1; i <= 3; i++) call(db, 'meeting.segment', { pageId: 'pz2', seg: { id: `s${i}`, atMs: i, durationMs: 1, text: '人事評価の極秘メモの文' + i } });
    call(db, 'meeting.discard', { pageId: 'pz2' });
    const bytes = Buffer.concat([fs.readFileSync(t.file), fs.existsSync(t.file + '-wal') ? fs.readFileSync(t.file + '-wal') : Buffer.alloc(0)]);
    for (const frag of ['人事評価', '極秘メモ', '評価の', 'メモの文']) assert.strictEqual(bytes.indexOf(Buffer.from(frag)), -1, frag);
  } finally { t.done(); }
});

test('RF16: 取り消した会議は、後から届いた begin・segment・recover で戻らない（purge の印）。締め済みのページは discard で消さない', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    call(db, 'meeting.begin', { pageId: 'pz3', startedAt: 1, localOnly: false });
    call(db, 'meeting.segment', { pageId: 'pz3', seg: { id: 's1', atMs: 0, durationMs: 1, text: '取り消す発言' } });
    call(db, 'meeting.discard', { pageId: 'pz3' });
    // 起こし直した客が、返事の無かった送りっぱなしの書き込みを送り直した（別の tx）
    call(db, 'meeting.begin', { pageId: 'pz3', startedAt: 1, localOnly: false });
    call(db, 'meeting.segment', { pageId: 'pz3', seg: { id: 's2', atMs: 1, durationMs: 1, text: '取り消す発言の続き' } });
    // 下書きを消せずに残った（ウイルス対策が掴んだ）まま次の起動の復旧が来た
    const r = call(db, 'meeting.recover', { pageId: 'pz3', page: { title: '（復旧）', blocks: [], recovered: true }, segments: [{ id: 's1', atMs: 0, durationMs: 1, text: '取り消す発言' }] });
    assert.deepStrictEqual(r.result, { page: null, already: true });
    assert.strictEqual(db.prepare("select count(*) c from blocks where page_id='pz3'").get().c, 0, '取り消した会議の行が戻った');
    assert.strictEqual(db.prepare("select count(*) c from segments where page_id='pz3'").get().c, 0, '取り消した会議の発言が戻った');
    assert.strictEqual(require('../src/db/commands').isPurged(db, 'pz3'), true);
    // 締め済みの議事録は、古い取り消しの頼みが届いても消さない
    call(db, 'meeting.finalize', { pageId: 'pm4', page: { title: '締めた会議', blocks: [] }, segments: [{ id: 's1', atMs: 0, durationMs: 1, text: '残す発言' }] });
    call(db, 'meeting.discard', { pageId: 'pm4' });
    assert.strictEqual(call(db, 'page.get', { id: 'pm4' }).result.segments[0].text, '残す発言', '締めた議事録を取り消しで消した');
    assert.strictEqual(require('../src/db/commands').isPurged(db, 'pm4'), false);
    // 取り消しは main だけ
    assert.strictEqual(call(db, 'meeting.discard', { pageId: 'pm4' }, 'app').code, 'forbidden');
  } finally { t.done(); }
});

test('ST6: begin が届かなくても segment が写しを作る（一覧には出ない）。segment の oplog は新しい値と前の値を持つ。締めは写しにだけあった発言を消す', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    call(db, 'meeting.segment', { pageId: 'pm5', seg: { id: 's1', atMs: 0, durationMs: 1, text: '一' } });
    call(db, 'meeting.segment', { pageId: 'pm5', seg: { id: 's9', atMs: 9, durationMs: 1, text: '捨てる区間' } });
    call(db, 'meeting.segment', { pageId: 'pm5', seg: { id: 's1', atMs: 0, durationMs: 1, text: '一（確定）' } });
    assert.strictEqual(JSON.parse(db.prepare("select attrs from blocks where id='pm5'").get().attrs).meeting.phase, 'recording', '写しを作らなかった');
    assert.deepStrictEqual(call(db, 'pages.list', {}).result, []);
    const last = JSON.parse(db.prepare("select ops from oplog where action='meeting.segment' order by seq desc limit 1").get().ops);
    assert.deepStrictEqual(last.map((o) => [o.op, o.id, o.value.text, o.old.text, o.n]), [['seg', 's1', '一（確定）', '一', 0]]);
    call(db, 'meeting.finalize', { pageId: 'pm5', page: { title: '会議', blocks: [] }, segments: [{ id: 's1', atMs: 0, durationMs: 1, text: '一（確定）' }] });
    assert.deepStrictEqual(call(db, 'page.get', { id: 'pm5' }).result.segments.map((s) => s.id), ['s1']);
    assert.deepStrictEqual(JSON.parse(db.prepare("select attrs from blocks where id='pm5'").get().attrs).meeting, { phase: 'done', recovered: false });
  } finally { t.done(); }
});

test('ST6: 締め・復旧のページは今の保存（json-backend の createPage）と同じ形。発言も同じ', { timeout: 5000 }, async () => {
  const { jsonTwin } = require('./helpers/dbtmp');
  const t = tmpDb(); const j = jsonTwin({ labels: {} });   // DB の側の call も labels: {}
  try {
    const { db } = t.open();
    const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (['id', 'updatedAt', 'rev', 'meeting'].includes(k) || (k === 'children' && Array.isArray(x) && x.length === 0) ? undefined : x)));
    const page = {
      title: '定例（見本）', date: '2026-10-19', durationSec: 120, memo: '会議のメモ', createdAt: '2026-10-19T00:00:00.000Z',
      blocks: [{ id: 'b1', type: 'bullet', text: '十分に長い要点の文です', cites: ['s1'] }, { id: 'b2', type: 'bullet', text: '了解', cites: [] }],
      route: { stt: { cloud: 2, local: 0, provider: 'groq' }, localOnly: false }, pauses: [{ atMs: 1000, ms: 500, why: 'user' }, { bad: true }],
      meetingType: 'createPage が捨てる欄',
    };
    const segments = [{ id: 's1', atMs: 0, durationMs: 1000, text: '十分に長い要点の文です', speaker: '話者1' }, { id: 's2', atMs: 1000, durationMs: 1000, text: '（この区間の認識に失敗: 見本）', failed: true }];
    for (const [cmd, extra] of [['meeting.finalize', {}], ['meeting.recover', { recovered: true, summaryError: '録音が中断されたため要約は未生成です。' }]]) {
      const pageId = cmd === 'meeting.finalize' ? 'pf1' : 'pr1';
      // ブロックの ID は DB の中で1つだけ（blocks.id UNIQUE）なので、ページごとに別の ID にする（main の ID は newId('b')）
      const blocks = page.blocks.map((b) => ({ ...b, id: `${b.id}${pageId}` }));
      const r = call(db, cmd, { pageId, page: { ...page, blocks, ...extra }, segments });
      assert.strictEqual(r.ok, true, `${cmd} ${r.code}`);
      const jr = await j.call(cmd, { pageId, page: { ...page, blocks, ...extra }, segments });
      const jid = cmd === 'meeting.finalize' ? jr.id : jr.page.id;
      const got = call(db, 'page.get', { id: pageId }).result;
      const want = await j.call('page.get', { id: jid });
      assert.deepStrictEqual(plain(got), plain(want), cmd);
      assert.strictEqual(got.page.meeting.recovered, cmd === 'meeting.recover', `${cmd} の会議の印`);
    }
  } finally { t.done(); j.done(); }
});

test('ST6: 送り直し（同じ tx）の答え — recover は作ったなら already: false のまま、settle は片付けた数', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const send = (cmd, args, tx) => core.call(db, { role: 'main', cmd, args, tx }, { now: NOW });
    const rec = { pageId: 'pr2', page: { title: '（復旧）', blocks: [], recovered: true }, segments: [{ id: 's1', atMs: 0, durationMs: 1, text: '一' }] };
    const a = send('meeting.recover', rec, 'm:recover-000001');
    const b = send('meeting.recover', rec, 'm:recover-000001');
    assert.deepStrictEqual([a.result.already, b.dup, b.result.already, b.result.page.id], [false, true, false, 'pr2'], '送り直しの答えで「もうあった」になった（復旧の知らせが出ない）');
    const c = send('meeting.recover', rec, 'm:recover-000002');
    const d = send('meeting.recover', rec, 'm:recover-000002');
    assert.deepStrictEqual([c.result.already, d.dup, d.result.already], [true, true, true]);
    for (const id of ['pk3', 'pk4']) call(db, 'meeting.begin', { pageId: id, startedAt: 1, localOnly: false });
    const s1 = send('meeting.settle', { keep: [] }, 'm:settle-000001');
    const s2 = send('meeting.settle', { keep: [] }, 'm:settle-000001');
    assert.deepStrictEqual([s1.result.settled, s2.dup, s2.result.settled], [2, true, 2]);
    assert.strictEqual(send('meeting.settle', { keep: [] }, 'm:settle-000002').result.settled, 0);
    // 片付けた写しは「復旧」のページとして一覧に出る
    const listed = call(db, 'pages.list', {}).result.filter((p) => p.id === 'pk3' || p.id === 'pk4');
    assert.deepStrictEqual(listed.map((p) => p.recovered), [true, true]);
  } finally { t.done(); }
});

test('ST6: segment.fail と segment.remove は今の保存と同じ答え。発言の直しでページの rev が上がる', { timeout: 5000 }, async () => {
  const { jsonTwin, samplePage } = require('./helpers/dbtmp');
  const t = tmpDb(); const j = jsonTwin();
  try {
    const { db } = t.open();
    const { page, segments } = samplePage('pa2');
    t.seed(page, segments);
    await j.seed(page, segments);
    const rev = () => db.prepare("select rev from blocks where id='pa2'").get().rev;
    for (const [cmd, args] of [
      ['segment.fail', { pageId: 'pa2', segId: 's2', text: '（この区間の認識に失敗: もう一度）' }],
      ['segment.fail', { pageId: 'pa2', segId: 'nope', text: 'x' }],
      ['segment.remove', { pageId: 'pa2', segId: 's3' }],
      ['segment.remove', { pageId: 'pa2', segId: 'nope' }],
    ]) {
      const before = rev();
      const r = call(db, cmd, args);
      assert.strictEqual(r.ok, true, `${cmd} ${r.code}`);
      assert.deepStrictEqual(r.result, await j.call(cmd, args), `${cmd} ${args.segId}`);
      assert.strictEqual(rev(), before + (args.segId === 'nope' ? 0 : 1), `${cmd} ${args.segId} の rev`);
    }
    assert.deepStrictEqual(call(db, 'page.get', { id: 'pa2' }).result.segments.map((s) => [s.id, s.failed === true]), [['s1', true], ['s2', true]]);
  } finally { t.done(); j.done(); }
});

test('T4b: 会議の命令の oplog を空の DB に当て直すと、今の表と同じになる（取り消しを含む）', { timeout: 5000 }, () => {
  const t = tmpDb(); const u = tmpDb();
  try {
    const { db } = t.open();
    const { db: copy } = u.open();
    call(db, 'meeting.begin', { pageId: 'pt1', startedAt: 1760000000000, localOnly: false });
    call(db, 'meeting.segment', { pageId: 'pt1', seg: { id: 's1', atMs: 0, durationMs: 1, text: '一' } });
    call(db, 'meeting.segment', { pageId: 'pt2', seg: { id: 's1', atMs: 0, durationMs: 1, text: '写しを作る区間' } });
    call(db, 'meeting.segment', { pageId: 'pt1', seg: { id: 's1', atMs: 0, durationMs: 1, text: '一（確定）' } });
    call(db, 'meeting.begin', { pageId: 'pt3', startedAt: 3, localOnly: true });
    call(db, 'meeting.segment', { pageId: 'pt3', seg: { id: 's1', atMs: 0, durationMs: 1, text: '取り消す' } });
    call(db, 'meeting.finalize', { pageId: 'pt1', page: { title: '会議', blocks: [{ id: 'b1', type: 'bullet', text: '要点の行の文です' }] }, segments: [{ id: 's1', atMs: 0, durationMs: 1, text: '一（確定）' }, { id: 's2', atMs: 1, durationMs: 1, text: '二' }] });
    call(db, 'meeting.discard', { pageId: 'pt3' });
    call(db, 'meeting.settle', { keep: [] });
    call(db, 'meeting.recover', { pageId: 'pt1', page: { title: '（復旧）', blocks: [] }, segments: [{ id: 's3', atMs: 2, durationMs: 1, text: '三' }] });
    call(db, 'segment.fail', { pageId: 'pt1', segId: 's2', text: '（失敗）' });
    call(db, 'segment.remove', { pageId: 'pt1', segId: 's3' });
    const { applyOps } = require('../src/db/ops');
    copy.exec('BEGIN IMMEDIATE');
    for (const r of db.prepare('select ops from oplog order by seq').all()) applyOps(copy, JSON.parse(r.ops), 'forward');
    copy.exec('COMMIT');
    const dump = (d) => [
      d.prepare('select id, type, page_id, parent_id, ord, text, rich, attrs, fold, rev, created_at, updated_at, trashed_at from blocks order by id').all(),
      d.prepare('select page_id, id, n, at_ms, duration_ms, text, fold, failed, extra from segments order by page_id, id').all(),
    ].map((rows) => rows.map((r) => ({ ...r })));
    assert.deepStrictEqual(dump(copy), dump(db));
    assert.ok(dump(db)[0].some((r) => r.id === 'pt2'), '見本に写しが無い');
  } finally { t.done(); u.done(); }
});
