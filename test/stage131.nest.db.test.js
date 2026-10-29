/*
 * stage131.nest.db.test.js — 0.13.1「入れ子とトグル」の DB の木と命令（計画 docs/plans/2026-10-27-131.md の Task NE-2・NE-3）
 * 木で読み書きする（子は parent_id と兄弟の中の鍵 ord: NR1）・字下げ・置き場の決まり（NR6）・子ごと消す・子ごと複製・トグルの開閉（見た目だけの欄: NR4・NR14）・
 * main の書き戻しの往復で木を壊さない（F54・NR3）。一時の DB（helpers/dbtmp.js）で core.call を本当に呼ぶ。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const { tmpDb, samplePage } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const { applyOps } = require('../src/db/ops');
const BT = require('../src/blockTree');
const { titleAt } = require('./helpers/titles');

const NOW = () => new Date('2026-10-27T01:02:03.000Z');
let n = 0;
const txOf = (role) => `${role[0]}:ne2-${String(++n).padStart(6, '0')}`;
const call = (db, cmd, args, role = 'app', tx = txOf(role)) => core.call(db, { role, cmd, args, tx }, { now: NOW, labels: {} });
const get = (db, id = 'pa1') => call(db, 'page.get', { id }).result.page;
const oplogN = (db) => db.prepare('select count(*) as c from oplog').get().c;
const lastOps = (db) => JSON.parse(db.prepare('select ops from oplog order by seq desc limit 1').get().ops);
const blockOps = (ops, pid = 'pa1') => ops.filter((o) => o.id !== pid);
const T = { timeout: 5000 };
// 形: [id, [子…]]（子が無ければ id だけ）
const shape = (blocks) => blocks.map((b) => (b.children && b.children.length ? [b.id, shape(b.children)] : b.id));
const find = (page, id) => BT.locate(page.blocks, id);

const kid = (id, type = 'bullet', o = {}) => ({ id, type, text: `${id}の文`, citeState: 'manual', cites: [], ...o });
// h1（AI の節の見出し）・a（子 a1・a2（孫 a21）・a3）・t（閉じたトグル。中に ToDo）・p（テキスト）
const TREE = () => [
  { id: 'h1', type: 'heading', level: 2, text: '決定事項' },
  { id: 'a', type: 'bullet', text: '親の行の要点を書いた長めの文です', cites: ['s2'], citeState: 'linked', children: [kid('a1'), kid('a2', 'bullet', { children: [kid('a21', 'todo', { checked: false })] }), kid('a3')] },
  { id: 't', type: 'toggle', text: 'たたんだ話', citeState: 'manual', open: false, children: [kid('t1', 'todo', { checked: false })] },
  { id: 'p', type: 'paragraph', text: '本文の行です' },
];
const TREE_SHAPE = ['h1', ['a', ['a1', ['a2', ['a21']], 'a3']], ['t', ['t1']], 'p'];

function withDb(fn, blocks = TREE()) {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const { page, segments } = samplePage('pa1');
    t.seed({ ...page, blocks }, segments);
    return fn(db, t);
  } finally { t.done(); }
}
const rowOf = (db, id) => db.prepare('select parent_id, ord from blocks where id = ?').get(id);

// ---------------------------------------------------------------- 木の読み書き（決めたこと 3・NR1・NR2）
test('NE-2: block.indent in/out は oplog 1行で親と鍵を変え、page.get の children に出る。子が3つある行を字下げしても操作はその行の move だけ（NR1）', T, () => withDb((db) => {
  assert.deepStrictEqual(shape(get(db).blocks), TREE_SHAPE, '種の木が page.get に出ない');
  assert.strictEqual(rowOf(db, 'a21').parent_id, 'a2');
  assert.strictEqual(rowOf(db, 'a').parent_id, 'pa1');
  let n0 = oplogN(db);
  const r = call(db, 'block.indent', { pageId: 'pa1', blockId: 'p', dir: 'in' });
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(oplogN(db), n0 + 1);
  assert.deepStrictEqual(shape(r.result.page.blocks), ['h1', ['a', ['a1', ['a2', ['a21']], 'a3']], ['t', ['t1', 'p']]]);
  assert.deepStrictEqual(blockOps(lastOps(db)).map((o) => [o.op, o.id, o.parent, o.oldParent]), [['move', 'p', 't', 'pa1']]);
  // 子が3つ（と孫）ある a を字下げ（前の兄弟 h1 は AI の見出しで子を持てない → 何もしない）。a2（子 a21）を a1 の子に → 操作は a2 の move だけ
  n0 = oplogN(db);
  const k = call(db, 'block.indent', { pageId: 'pa1', blockId: 'a2', dir: 'in' });
  assert.strictEqual(k.ok, true, k.code);
  assert.deepStrictEqual(blockOps(lastOps(db)).map((o) => [o.op, o.id]), [['move', 'a2']], '子の行まで書いた（NR1）');
  assert.strictEqual(rowOf(db, 'a21').parent_id, 'a2', '孫の親が変わった');
  assert.deepStrictEqual(shape(get(db).blocks)[1], ['a', [['a1', [['a2', ['a21']]]], 'a3']]);
  // out: 親のすぐ後ろへ（親の後ろの兄弟は付いてこない）
  const o = call(db, 'block.indent', { pageId: 'pa1', blockId: 'a1', dir: 'out' });
  assert.strictEqual(o.ok, true, o.code);
  assert.deepStrictEqual(shape(o.result.page.blocks).slice(0, 3), ['h1', ['a', ['a3']], ['a1', [['a2', ['a21']]]]]);
  // できない字下げは何も書かない（最上位の out・前に兄弟の無い in・AI の見出しの in）
  const before = JSON.stringify(get(db).blocks);
  for (const [id, dir] of [['h1', 'out'], ['h1', 'in'], ['a', 'in'], ['a3', 'in']]) {
    const x = call(db, 'block.indent', { pageId: 'pa1', blockId: id, dir });
    assert.strictEqual(x.ok, true, `${id} ${dir}`);
    assert.deepStrictEqual(lastOps(db), [], `${id} ${dir} を書いた`);
  }
  assert.strictEqual(JSON.stringify(get(db).blocks), before);
  for (const dir of ['up', '', 1]) assert.strictEqual(call(db, 'block.indent', { pageId: 'pa1', blockId: 'p', dir }).code, 'bad-args', String(dir));
}));

test('NE-2・P5: 親が変わった move の操作は parent と oldParent を持ち、後ろへ当てると前の親と鍵に戻る。親の変わらない move は今の形', T, () => withDb((db) => {
  const was = { p: rowOf(db, 'p'), blocks: JSON.stringify(get(db).blocks) };
  call(db, 'block.indent', { pageId: 'pa1', blockId: 'p', dir: 'in' });
  const ops = lastOps(db);
  const mv = ops.find((o) => o.op === 'move');
  assert.deepStrictEqual([mv.parent, mv.oldParent, mv.old], ['t', 'pa1', was.p.ord]);
  db.exec('BEGIN IMMEDIATE'); applyOps(db, ops, 'backward'); db.exec('COMMIT');
  assert.deepStrictEqual(rowOf(db, 'p'), was.p, '後ろへ当てても前の親と鍵に戻らない');
  assert.strictEqual(JSON.stringify(get(db).blocks), was.blocks);
  // 同じ親の中の move は今の形（parent・oldParent を持たない）
  call(db, 'block.move', { pageId: 'pa1', blockId: 'a3', afterId: 'a1' });
  const m2 = lastOps(db).find((o) => o.op === 'move');
  assert.deepStrictEqual(Object.keys(m2).sort(), ['id', 'old', 'op', 'ord']);
  assert.deepStrictEqual(shape(get(db).blocks)[1], ['a', ['a1', 'a3', ['a2', ['a21']]]]);
}));

test('NE-2・T4b: 控えに後の oplog を前へ当て直すと今の表と同じ（字下げ・子のある行の削除・子ごとの複製・中への move・開け閉めを含む）', T, () => {
  const t = tmpDb(); const u = tmpDb();
  try {
    const { db } = t.open();
    const { db: copy } = u.open();
    const { page, segments } = samplePage('pa1');
    t.seed({ ...page, blocks: TREE() }, segments);
    u.seed({ ...page, blocks: TREE() }, segments);
    const seq0 = db.prepare('select coalesce(max(seq), 0) as s from oplog').get().s;
    const steps = [
      ['block.indent', { pageId: 'pa1', blockId: 'p', dir: 'in' }],
      ['block.duplicate', { pageId: 'pa1', blockId: 'a' }],
      ['block.move', { pageId: 'pa1', blockId: 'a3', afterId: '', parentId: 'a1' }],
      ['block.setOpen', { pageId: 'pa1', blockId: 't', open: true }],
      ['block.setOpenAll', { pageId: 'pa1', open: false }],
      ['block.remove', { pageId: 'pa1', blockId: 'a2' }],
      ['block.indent', { pageId: 'pa1', blockId: 'a1', dir: 'out' }],
      ['block.turnInto', { pageId: 'pa1', blockId: 't', type: 'paragraph' }],
      ['block.split', { pageId: 'pa1', blockId: 'a', text: '親の行の要点を書いた長めの文です', at: 2, inside: true }],
    ];
    for (const [cmd, args] of steps) { const r = call(db, cmd, args); assert.strictEqual(r.ok, true, `${cmd} ${r.code}`); }
    copy.exec('BEGIN IMMEDIATE');
    for (const r of db.prepare('select ops from oplog where seq > ? order by seq').all(seq0)) applyOps(copy, JSON.parse(r.ops), 'forward');
    copy.exec('COMMIT');
    const dump = (d) => d.prepare('select id, type, page_id, parent_id, ord, text, rich, attrs, fold, rev, trashed_at from blocks order by id').all().map((r) => ({ ...r }));
    assert.deepStrictEqual(dump(copy), dump(db));
    // 後ろへ全部当てると種の表に戻る
    db.exec('BEGIN IMMEDIATE');
    for (const r of db.prepare('select ops from oplog where seq > ? order by seq desc').all(seq0)) applyOps(db, JSON.parse(r.ops), 'backward');
    db.exec('COMMIT');
    const v = tmpDb();
    try {
      const o = v.open(); v.seed({ ...page, blocks: TREE() }, segments);
      const keep = (rows) => rows.map((r) => ({ ...r, rev: 0 }));
      assert.deepStrictEqual(keep(dump(db)), keep(dump(o.db)), '後ろへ全部当てても種の表に戻らない');
    } finally { v.done(); }
  } finally { t.done(); u.done(); }
});

test('NE-2・F49: 子のある行を消すと子孫も消え（oplog 1行）、後ろへ当てると子孫も同じ親と鍵に戻る', T, () => withDb((db) => {
  const before = db.prepare("select id, parent_id, ord from blocks where page_id = 'pa1' and id <> 'pa1' order by id").all().map((r) => ({ ...r }));
  const n0 = oplogN(db);
  const r = call(db, 'block.remove', { pageId: 'pa1', blockId: 'a' });
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(oplogN(db), n0 + 1);
  assert.deepStrictEqual(shape(get(db).blocks), ['h1', ['t', ['t1']], 'p']);
  for (const id of ['a', 'a1', 'a2', 'a21', 'a3']) assert.strictEqual(rowOf(db, id), undefined, `${id} が残った（迷子の行）`);
  const ops = lastOps(db);
  assert.deepStrictEqual(blockOps(ops).filter((o) => o.op === 'trash').map((o) => o.id).sort(), ['a', 'a1', 'a2', 'a21', 'a3']);
  db.exec('BEGIN IMMEDIATE'); applyOps(db, ops, 'backward'); db.exec('COMMIT');
  assert.deepStrictEqual(db.prepare("select id, parent_id, ord from blocks where page_id = 'pa1' and id <> 'pa1' order by id").all().map((x) => ({ ...x })), before);
  assert.deepStrictEqual(shape(get(db).blocks), TREE_SHAPE);
  // 無い行の remove は何も変えない（今どおり答えは今のページ）
  const none = call(db, 'block.remove', { pageId: 'pa1', blockId: 'zz' });
  assert.strictEqual(none.ok, true);
  assert.deepStrictEqual(shape(none.result.blocks), TREE_SHAPE);
}));

test('NE-2: duplicate は子孫も新しい ID で写し、元の行のすぐ後ろ（兄弟）に置く。同じ tx の2回で1回だけ', T, () => withDb((db) => {
  const tx = txOf('app');
  const r1 = call(db, 'block.duplicate', { pageId: 'pa1', blockId: 'a2' }, 'app', tx);
  assert.strictEqual(r1.ok, true, r1.code);
  const n1 = oplogN(db);
  const r2 = call(db, 'block.duplicate', { pageId: 'pa1', blockId: 'a2' }, 'app', tx);
  assert.strictEqual(r2.dup, true);
  assert.strictEqual(oplogN(db), n1);
  assert.strictEqual(r2.result.blockId, r1.result.blockId);
  const p = get(db);
  const a = find(p, 'a').b;
  assert.deepStrictEqual(a.children.map((x) => x.id).slice(0, 2), ['a1', 'a2']);
  const copy = a.children[2];
  assert.strictEqual(copy.id, r1.result.blockId);
  assert.strictEqual(copy.text, 'a2の文');
  assert.strictEqual(copy.children.length, 1);
  assert.notStrictEqual(copy.children[0].id, 'a21', '複製の子に元の ID を使った');
  assert.strictEqual(copy.children[0].text, 'a21の文');
  assert.strictEqual(find(p, 'a21').parent.id, 'a2', '元の孫が動いた');
  assert.strictEqual(BT.flattenBlocks(p.blocks).length, new Set(BT.flattenBlocks(p.blocks).map((x) => x.id)).size, 'ID が重なった');
  // afterId と parentId（Alt で中へ落とした所）
  const d = call(db, 'block.duplicate', { pageId: 'pa1', blockId: 'p', afterId: '', parentId: 'a' });
  assert.strictEqual(d.ok, true, d.code);
  assert.strictEqual(find(get(db), d.result.blockId).parent.id, 'a');
}));

// ---------------------------------------------------------------- 置き場（NR6・NR8）
test('NE-2・NR6: insert・move の afterId は『その行と同じ親のすぐ後ろ』、\'\' と parentId は『その親の頭』。自分の子孫の中・別のページの行・同じ親でない parentId は bad-args', T, () => withDb((db, t) => {
  const { page, segments } = samplePage('pb2');
  t.seed({ ...page, blocks: [{ id: 'zb1', type: 'bullet', text: '別のページ' }] }, segments);
  const i1 = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'a1', type: 'bullet' });
  assert.strictEqual(i1.ok, true, i1.code);
  assert.deepStrictEqual(find(get(db), i1.result.blockId).parent.id, 'a', '今の insert（parentId なし）も行の親の中に足す');
  assert.strictEqual(find(get(db), i1.result.blockId).index, 1);
  const i2 = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: '', type: 'bullet', parentId: 'a2' });
  assert.strictEqual(i2.ok, true, i2.code);
  assert.deepStrictEqual([find(get(db), i2.result.blockId).parent.id, find(get(db), i2.result.blockId).index], ['a2', 0]);
  const i3 = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: '', type: 'bullet' });
  assert.strictEqual(get(db).blocks.at(-1).id, i3.result.blockId, '\'\' で parentId が無ければ今どおり末尾');
  const n0 = oplogN(db);
  for (const [cmd, args] of [
    ['block.insert', { pageId: 'pa1', afterBlockId: 'a1', type: 'bullet', parentId: 't' }],
    ['block.insert', { pageId: 'pa1', afterBlockId: '', type: 'bullet', parentId: 'h1' }],
    ['block.insert', { pageId: 'pa1', afterBlockId: '', type: 'bullet', parentId: 'zb1' }],
    ['block.move', { pageId: 'pa1', blockId: 'a', afterId: 'a21' }],
    ['block.move', { pageId: 'pa1', blockId: 'a', afterId: '', parentId: 'a2' }],
    ['block.move', { pageId: 'pa1', blockId: 'p', afterId: 'zb1' }],
    ['block.move', { pageId: 'pa1', blockId: 'p', afterId: 'a1', parentId: 't' }],
    ['block.move', { pageId: 'pa1', blockId: 'p', afterId: '', parentId: 'h1' }],
  ]) {
    const r = call(db, cmd, args);
    assert.deepStrictEqual([r.ok, r.code], [false, 'bad-args'], JSON.stringify(args));
  }
  assert.strictEqual(oplogN(db), n0, '断った命令が oplog に残った');
  const m = call(db, 'block.move', { pageId: 'pa1', blockId: 'p', afterId: '', parentId: 'a' });
  assert.strictEqual(m.ok, true, m.code);
  assert.deepStrictEqual([find(get(db), 'p').parent.id, find(get(db), 'p').index], ['a', 0]);
  const m2 = call(db, 'block.move', { pageId: 'pa1', blockId: 'a21', afterId: 'h1' });
  assert.strictEqual(m2.ok, true, m2.code);
  assert.deepStrictEqual(shape(get(db).blocks).slice(0, 2), ['h1', 'a21'], '子だけを動かすと afterId の行と同じ親へ');
  const top = call(db, 'block.move', { pageId: 'pa1', blockId: 'a1', afterId: '' });
  assert.strictEqual(get(db).blocks[0].id, 'a1', 'いちばん上へ（R28）');
  assert.strictEqual(top.ok, true);
}));

test('NE-2・NR8: 文のある行の頭の split（at 0）は、afterId が今の行の兄弟か \'\' のときだけ通り、上の空の行は今の行と同じ親の前に入る。孫の行の afterId は bad-args', T, () => withDb((db) => {
  const r = call(db, 'block.split', { pageId: 'pa1', blockId: 'a3', text: 'a3の文', at: 0, afterId: 'a2' });
  assert.strictEqual(r.ok, true, r.code);
  assert.deepStrictEqual(find(get(db), 'a').b.children.map((x) => x.id), ['a1', 'a2', r.result.blockId, 'a3']);
  const h = call(db, 'block.split', { pageId: 'pa1', blockId: 'a1', text: 'a1の文', at: 0, afterId: '' });
  assert.strictEqual(h.ok, true, h.code);
  assert.strictEqual(find(get(db), 'a').b.children[0].id, h.result.blockId, '最初の子の上の空の行が親の子の頭に入らない');
  const n0 = oplogN(db);
  const bad = call(db, 'block.split', { pageId: 'pa1', blockId: 'a3', text: 'a3の文', at: 0, afterId: 'a21' });
  assert.deepStrictEqual([bad.ok, bad.code], [false, 'bad-args'], '画面で1つ上の孫の後ろに入った（edn-split-sibling）');
  const bad2 = call(db, 'block.split', { pageId: 'pa1', blockId: 'a3', text: 'a3の文', at: 0, afterId: 'p' });
  assert.deepStrictEqual([bad2.ok, bad2.code], [false, 'bad-args'], '別の親の行の後ろに入った');
  assert.strictEqual(oplogN(db), n0);
  // 最上位は 0.13.0 のまま（画面で上に見えている最上位の行の後ろ）
  const tp = call(db, 'block.split', { pageId: 'pa1', blockId: 'p', text: '本文の行です', at: 0, afterId: 't' });
  assert.strictEqual(tp.ok, true, tp.code);
  assert.deepStrictEqual(get(db).blocks.map((b) => b.id).slice(-2), [tp.result.blockId, 'p']);
}));

// ---------------------------------------------------------------- 結合・Enter（TQ1・TQ3・EQ6 (a)）
test('NE-2・TQ1: merge の intoId は画面で上に見えている行（つないだ先）。子はつないだ先の子の末尾へ。intoId が無ければ平らにした保存の順の前の行（main など）', T, () => withDb((db) => {
  const r = call(db, 'block.merge', { pageId: 'pa1', blockId: 'x', text: '下の行', intoId: 'a3' });
  assert.strictEqual(r.ok, true, r.code);
  assert.deepStrictEqual([r.result.blockId, r.result.at], ['a3', 'a3の文'.length]);
  const p = get(db);
  assert.strictEqual(find(p, 'a3').b.text, 'a3の文下の行');
  assert.deepStrictEqual(shape(p.blocks), ['h1', ['a', ['a1', ['a2', ['a21']], ['a3', ['x1', 'x2']]]], 'p'], '子がつないだ先の子の末尾に入らない（EQ6 (a)）');
  assert.strictEqual(find(p, 'x'), null);
  // つないだ先が子を持てない見出しなら、子は見出しのすぐ後ろの兄弟
  const h = call(db, 'block.merge', { pageId: 'pa1', blockId: 'a', text: '親の行の要点を書いた長めの文です', intoId: 'h1' });
  assert.strictEqual(h.ok, true, h.code);
  assert.deepStrictEqual(shape(get(db).blocks).slice(0, 4), ['h1', 'a1', ['a2', ['a21']], ['a3', ['x1', 'x2']]]);
  // intoId が無ければ平らにした保存の順の前の行（p の前は x2）
  const f = call(db, 'block.merge', { pageId: 'pa1', blockId: 'p', text: '本文' });
  assert.strictEqual(f.ok, true, f.code);
  assert.strictEqual(f.result.blockId, 'x2');
  // 自分の子孫・無い行・自分への intoId は bad-args
  for (const intoId of ['a21', 'zz', 'a2']) {
    const b = call(db, 'block.merge', { pageId: 'pa1', blockId: 'a2', text: 'a2の文', intoId });
    assert.deepStrictEqual([b.ok, b.code], [false, 'bad-args'], intoId);
  }
}, [...TREE().slice(0, 2), { id: 'x', type: 'paragraph', text: '下の行', citeState: 'manual', children: [kid('x1'), kid('x2')] }, { id: 'p', type: 'paragraph', text: '本文の行です' }]));

test('NE-2・TQ3: split の inside は新しい行を今の行の最初の子に（子を持てない型なら bad-args）。閉じたトグルの inside の無い split は兄弟のトグル', T, () => withDb((db) => {
  const r = call(db, 'block.split', { pageId: 'pa1', blockId: 'a', text: '親の行の要点を書いた長めの文です', at: 7, inside: true });
  assert.strictEqual(r.ok, true, r.code);
  const a = find(get(db), 'a').b;
  assert.deepStrictEqual([a.children[0].id, a.children[0].type, a.children[0].text, a.text], [r.result.blockId, 'bullet', '書いた長めの文です', '親の行の要点を']);
  const tg = call(db, 'block.split', { pageId: 'pa1', blockId: 't', text: 'たたんだ話', at: 5, inside: true });
  const t = find(get(db), 't').b;
  assert.deepStrictEqual([t.children[0].id, t.children[0].type], [tg.result.blockId, 'paragraph'], '開いたトグルの中の新しい行はテキスト');
  const sib = call(db, 'block.split', { pageId: 'pa1', blockId: 't', text: 'たたんだ話', at: 5 });
  const s = find(get(db), sib.result.blockId);
  assert.deepStrictEqual([s.parent, s.index, s.b.type], [null, 3, 'toggle'], '閉じたトグルの後ろは兄弟のトグル');
  assert.strictEqual(s.b.open, undefined, '新しいトグルに open を書いた（NR4）');
  const bad = call(db, 'block.split', { pageId: 'pa1', blockId: 'h1', text: '決定事項', at: 4, inside: true });
  assert.deepStrictEqual([bad.ok, bad.code], [false, 'bad-args']);
  const th = call(db, 'block.split', { pageId: 'pa1', blockId: 'th', text: '節', at: 1 });
  const thb = find(get(db), th.result.blockId).b;
  assert.deepStrictEqual([thb.type, thb.level, thb.toggle], ['heading', 3, true], '閉じたトグル見出しの後ろは同じ段のトグル見出し（NR25）');
}, [...TREE(), { id: 'th', type: 'heading', level: 3, toggle: true, open: false, text: '節', citeState: 'manual' }]));

// ---------------------------------------------------------------- 型の変換（NR7・NR10・NR11）
test('NE-2・NR7・NR10: 子のある行を区切り線に → bad-args。トグル → テキスト・トグル見出し → 見出しで子がすぐ後ろに並ぶ（oplog 1行）。トグル → 箇条書きでは子が残る', T, () => withDb((db) => {
  const dv = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'e', type: 'divider' });
  assert.deepStrictEqual([dv.ok, dv.code], [false, 'bad-args'], '文の無い子のある行を区切り線にできた（edn-divider-kids）');
  assert.strictEqual(call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'e2', type: 'divider' }).ok, true, '文も子も無い行は区切り線にできる');
  const n0 = oplogN(db);
  const r = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 't', type: 'paragraph' });
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(oplogN(db), n0 + 1);
  assert.deepStrictEqual(shape(get(db).blocks).slice(2, 4), ['t', 't1'], 'トグルをテキストに戻して子が下に並ばない（EQ16 (a)）');
  const th = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'th', type: 'heading', level: 2 });
  assert.strictEqual(th.ok, true, th.code);
  const p = get(db);
  assert.strictEqual(find(p, 'th').b.toggle, undefined);
  assert.deepStrictEqual(shape(p.blocks).slice(-3), ['th', 'k1', 'k2'], 'トグル見出しを見出しにして子が残った（edn-kids-out）');
  const keep = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'tb', type: 'bullet' });
  assert.strictEqual(keep.ok, true, keep.code);
  assert.deepStrictEqual(shape(get(db).blocks).find((x) => Array.isArray(x) && x[0] === 'tb'), ['tb', ['m1']]);
  // 見出し → トグル見出し → 段の付け替え（子は残る）
  const back = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'th', type: 'heading', level: 1, toggle: true });
  assert.strictEqual(back.ok, true, back.code);
  assert.deepStrictEqual([find(get(db), 'th').b.toggle, find(get(db), 'th').b.level], [true, 1]);
}, [...TREE(), { id: 'e', type: 'bullet', text: '', citeState: 'manual', children: [kid('e1')] }, { id: 'e2', type: 'bullet', text: '', citeState: 'manual' },
  { id: 'tb', type: 'toggle', text: 'トグル', citeState: 'manual', children: [kid('m1')] },
  { id: 'th', type: 'heading', level: 2, toggle: true, text: 'トグル見出し', citeState: 'manual', children: [kid('k1'), kid('k2')] }]));

test('NE-2・NR11: AI の見出し（citeState なし）→ トグル見出し → 見出しで citeState も aiHeading も付かない', T, () => withDb((db) => {
  const r = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'h1', type: 'heading', level: 2, toggle: true });
  assert.strictEqual(r.ok, true, r.code);
  let h = find(get(db), 'h1').b;
  assert.deepStrictEqual([h.toggle, h.citeState, h.aiHeading], [true, undefined, undefined]);
  call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'h1', type: 'heading', level: 2 });
  h = find(get(db), 'h1').b;
  assert.deepStrictEqual([h.toggle, h.citeState, h.aiHeading], [undefined, undefined, undefined]);
  // 同じ形への変換は書かない（R45）
  call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'h1', type: 'heading', level: 2 });
  assert.strictEqual(call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'h1', type: 'heading', level: 2 }).result, null);
}));

// ---------------------------------------------------------------- 開け閉め（EQ18 (a)・EQ19 (a)・NR4・NR14）
test('NE-2・EQ18 (a)・EQ19 (a): setOpen・setOpenAll はトグルとトグル見出しだけを書く。同じ形なら書かない（R45）。setOpenAll は1行', T, () => withDb((db) => {
  const r = call(db, 'block.setOpen', { pageId: 'pa1', blockId: 't', open: true });
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(find(r.result.page, 't').b.open, true);
  assert.deepStrictEqual(blockOps(lastOps(db)).map((o) => [o.op, o.id, o.key, o.value, o.old]), [['set', 't', 'open', true, false]]);
  call(db, 'block.setOpen', { pageId: 'pa1', blockId: 't', open: true });
  assert.deepStrictEqual(lastOps(db), [], '同じ形を書いた');
  call(db, 'block.setOpen', { pageId: 'pa1', blockId: 'a', open: false });
  assert.deepStrictEqual(lastOps(db), [], 'トグルでない行に open を書いた');
  call(db, 'block.setOpen', { pageId: 'pa1', blockId: 'u', open: true });
  assert.deepStrictEqual(lastOps(db), [], '開いた形（open の無い）トグルに open: true を書いた');
  const n0 = oplogN(db);
  const all = call(db, 'block.setOpenAll', { pageId: 'pa1', open: false });
  assert.strictEqual(all.ok, true, all.code);
  assert.strictEqual(oplogN(db), n0 + 1);
  assert.deepStrictEqual(blockOps(lastOps(db)).map((o) => [o.id, o.key, o.value]).sort(), [['t', 'open', false], ['th', 'open', false], ['u', 'open', false], ['u1', 'open', false]]);
  const p = get(db);
  assert.deepStrictEqual(['t', 'u', 'u1', 'th'].map((id) => find(p, id).b.open), [false, false, false, false], 'Ctrl+Alt+T が全部のトグル（子の中のトグルも）を閉じない（edn-open-all）');
  call(db, 'block.setOpenAll', { pageId: 'pa1', open: false });
  assert.deepStrictEqual(lastOps(db), []);
  for (const open of ['true', 1, undefined]) assert.strictEqual(call(db, 'block.setOpen', { pageId: 'pa1', blockId: 't', open }).code, 'bad-args', String(open));
}, [...TREE(), { id: 'u', type: 'toggle', text: '開いたトグル', citeState: 'manual', children: [kid('u1', 'toggle', { open: true })] },
  { id: 'th', type: 'heading', toggle: true, level: 2, text: '節', citeState: 'manual' }]));

test('NE-2・NR4・NR14: setOpen・setOpenAll は summaryEdited を付けず、ほかの命令（insert・turnInto・duplicate・split）は open を書かない。字下げ・move は summaryEdited を付ける', T, () => {
  withDb((db) => {
    call(db, 'block.setOpen', { pageId: 'pa1', blockId: 't', open: true });
    call(db, 'block.setOpenAll', { pageId: 'pa1', open: false });
    assert.strictEqual(get(db).summaryEdited, undefined, '開け閉めが手直しの印を付けた（edn-open-noedit）');
    const seq0 = db.prepare('select max(seq) as s from oplog').get().s;
    const ins = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'p', type: 'toggle' });
    call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'p', type: 'toggle' });
    call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'h1', type: 'heading', level: 2, toggle: true });
    call(db, 'block.duplicate', { pageId: 'pa1', blockId: 't' });
    call(db, 'block.split', { pageId: 'pa1', blockId: ins.result.blockId, text: 'あ', at: 1 });
    call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'p', type: 'heading', level: 1, toggle: true });
    const ops = db.prepare('select ops from oplog where seq > ?').all(seq0).flatMap((r) => JSON.parse(r.ops));
    assert.deepStrictEqual(ops.filter((o) => o.op === 'set' && o.key === 'open'), [], 'ほかの命令が open を書いた（edn-open-only）');
    const added = ops.filter((o) => o.op === 'add').map((o) => o.row);
    assert.ok(added.every((row) => !('open' in row.attrs) || row.attrs.open === false), '足した行に open を書いた');
    const dupT = added.find((row) => row.type === 'toggle' && row.attrs.open === false);
    assert.ok(dupT, '閉じたトグルの複製は元の open を写す');
    assert.strictEqual(find(get(db), 'h1').b.toggle, true);
  });
  for (const [cmd, args] of [['block.indent', { pageId: 'pa1', blockId: 'p', dir: 'in' }], ['block.move', { pageId: 'pa1', blockId: 'p', afterId: '', parentId: 'a' }]]) {
    withDb((db) => {
      assert.strictEqual(call(db, cmd, args).ok, true, cmd);
      assert.strictEqual(get(db).summaryEdited, true, `${cmd} が手直しの印を付けない`);
    });
  }
});

// 2026-10-28 の独立した点検 8（作り手が決めた。計画の Ruling NR41）: 開け閉めは中身の直しでないので updatedAt を変えない
test('NE-2（点検 8）: setOpen・setOpenAll は updatedAt を変えず、updatedAt の操作を書かない。文を直す命令は updatedAt を今にする', T, () => withDb((db) => {
  const at = (cmd, args, iso) => core.call(db, { role: 'app', cmd, args, tx: txOf('app') }, { now: () => new Date(iso), labels: {} });
  const u0 = get(db).updatedAt;
  assert.ok(typeof u0 === 'string' && u0 !== '' && u0 < '2026-10-28', u0);
  let r = at('block.setOpen', { pageId: 'pa1', blockId: 't', open: true }, '2026-10-28T05:00:00.000Z');
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(find(get(db), 't').b.open, true);
  assert.strictEqual(r.result.page.updatedAt, u0, '▸ の開け閉めで updatedAt が変わった');
  assert.deepStrictEqual(lastOps(db).filter((o) => o.id === 'pa1' && o.key === 'updatedAt'), [], '開け閉めでページの updatedAt の操作を書いた');
  r = at('block.setOpenAll', { pageId: 'pa1', open: false }, '2026-10-28T06:00:00.000Z');
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(find(get(db), 't').b.open, false);
  assert.strictEqual(get(db).updatedAt, u0, 'Ctrl+Alt+T で updatedAt が変わった');
  r = at('block.update', { pageId: 'pa1', blockId: 'a', patch: { text: '直した文' } }, '2026-10-28T07:00:00.000Z');
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(get(db).updatedAt, '2026-10-28T07:00:00.000Z', '文を直しても updatedAt が今にならない');
}));

// 2026-10-28 の独立した点検 6（作り手が決めた。計画の Ruling NR42）: page.get は組めない行の数を見るために読んだページをそのまま使い、読み直さない
test('NE-2（点検 6）: page.get は要約の行を1回だけ読む（組めない行の数を見た loadPage の答えを使う）。答えは readPage と同じ', T, () => withDb((db) => {
  const want = call(db, 'page.get', { id: 'pa1' }).result;
  let reads = 0;
  const spy = new Proxy(db, { get(o, k) {
    if (k === 'prepare') return (sql) => { if (sql === require('../src/db/commands').HOT_QUERIES.pageBlocks) reads += 1; return o.prepare(sql); };
    const v = o[k];
    return typeof v === 'function' ? v.bind(o) : v;
  } });
  const r = core.call(spy, { role: 'app', cmd: 'page.get', args: { id: 'pa1' }, tx: txOf('app') }, { now: NOW, labels: {} });
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(reads, 1, `page.get が要約の行を ${reads} 回読んだ`);
  assert.deepStrictEqual(r.result, want);
  assert.ok(find(r.result.page, 'a').b.children.length > 0);
}));

// ---------------------------------------------------------------- main の書き戻し（F54・NR3）
test('NE-2・F54・NR3: 子のあるページを page.get → page.put（baseRev）で書き戻すと操作は空で子が残る。要約待ちの印だけを変えた page.put でも子が残る。AI の平らな行に置き換えた page.put は子孫を全部 trash する', T, () => withDb((db) => {
  let p = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
  const r = call(db, 'page.put', { page: p, baseRev: p.rev }, 'main');
  assert.strictEqual(r.ok, true, r.code);
  assert.deepStrictEqual(blockOps(lastOps(db)), [], '往復で行を書いた');
  assert.deepStrictEqual(shape(get(db).blocks), TREE_SHAPE);
  p = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
  const w = call(db, 'page.put', { page: { ...p, summaryWait: true, summaryError: '要約待ち' }, baseRev: p.rev }, 'main');
  assert.strictEqual(w.ok, true, w.code);
  assert.deepStrictEqual(blockOps(lastOps(db)), []);
  assert.deepStrictEqual(shape(get(db).blocks), TREE_SHAPE, '要約待ちの印の書き戻しで子が消えた（edn-put-tree）');
  p = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
  const flat = [{ id: 'n1', type: 'heading', level: 2, text: '作り直した見出し' }, { id: 'n2', type: 'bullet', text: '作り直した要点', cites: [] }];
  const re = call(db, 'page.put', { page: { ...p, blocks: flat }, baseRev: p.rev }, 'main');
  assert.strictEqual(re.ok, true, re.code);
  assert.deepStrictEqual(lastOps(db).filter((o) => o.op === 'trash').map((o) => o.id).sort(), ['a', 'a1', 'a2', 'a21', 'a3', 'h1', 'p', 't', 't1']);
  assert.strictEqual(db.prepare("select count(*) as c from blocks where page_id = 'pa1' and id <> 'pa1'").get().c, 2, '迷子の行が残った');
}));

test('NE-2・NR2: 親の無い行を足した DB を page.get すると、その行は最上位の末尾にある', T, () => withDb((db) => {
  db.prepare("insert into blocks(id, type, page_id, parent_id, ord, text, attrs, fold, rev, created_at, updated_at) values ('lost1', 'bullet', 'pa1', 'gone', 'a0', '迷子の行', '{}', '', 1, '', '')").run();
  const p = get(db);
  assert.deepStrictEqual(shape(p.blocks), [...TREE_SHAPE, 'lost1']);
  assert.strictEqual(p.blocks.at(-1).text, '迷子の行');
  // 記録には数だけ（本文・ID は書かない）
  const lines = [];
  core.call(db, { role: 'app', cmd: 'page.get', args: { id: 'pa1' } }, { now: NOW, labels: {}, log: (l) => lines.push(l) });
  assert.deepStrictEqual(lines, ['DB: 親をたどれない要約の行 1 件を末尾に並べた']);
  core.call(db, { role: 'app', cmd: 'page.get', args: { id: 'pa1' } }, { now: NOW, labels: {} });
}));

test('NE-2: 子の無いページの答えは前と同じ（children は空）。鍵の間は新しい命令がどれも locked', T, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const { page, segments } = samplePage('pa1');
    t.seed(page, segments);
    const got = get(db);
    assert.deepStrictEqual(got.blocks.map((b) => b.id), page.blocks.map((b) => b.id));
    assert.ok(got.blocks.every((b) => Array.isArray(b.children) && b.children.length === 0));
    const w = samplePage('pw1');
    t.seed({ ...w.page, blocks: w.page.blocks.map((b) => ({ ...b, id: `w${b.id}` })), summaryWait: true, summaryError: '要約待ち（つながったら作ります）' }, w.segments);
    for (const [cmd, args] of [['block.indent', { pageId: 'pw1', blockId: 'wb2', dir: 'in' }], ['block.setOpen', { pageId: 'pw1', blockId: 'wb2', open: false }],
      ['block.setOpenAll', { pageId: 'pw1', open: false }]]) assert.strictEqual(call(db, cmd, args).code, 'locked', cmd);
  } finally { t.done(); }
});

// ---------------------------------------------------------------- preload（決めたこと 10・14）
function loadPreload() {
  const SRC = fs.readFileSync(require.resolve('../src/preload.js'), 'utf8');
  const exposed = {}; const on = {}; let uuid = 0;
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async () => ({}), send: () => {} } };
  const sandbox = { require: () => electron, crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, setTimeout, clearTimeout, console, Promise };
  vm.runInNewContext(SRC, sandbox);
  const p = new EventTarget(); p.sent = []; p.postMessage = (m) => p.sent.push(structuredClone(m)); p.start = () => {};
  on['db:port']({ ports: [p] });
  return { exposed, p, SRC };
}
// 0.14.0 EB-2 で意図して直した: edit.revert と blocks.setColor を足して 23（照らしは同じ: 計画 docs/plans/2026-10-26-140.md の「意図して変えるテスト」）
// 0.14.0 EK-2 で意図して直した: block.paste・blocks.remove・blocks.move・blocks.duplicate・blocks.turnInto を足して 28（同じ表の行）
test('NE-2: preload の APP_COMMANDS（28）は役 app の命令と同じ集まり。koeApp.blockIndent などは dbCall の1回で tx が付く。足した引数が無ければ今の形を送る。json-backend に block.indent は unknown-cmd', T, async () => {
  const { exposed, p, SRC } = loadPreload();
  const names = [.../const APP_COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(SRC)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.strictEqual(names.length, 28);
  assert.deepStrictEqual(names.sort(), Object.keys(core.COMMANDS).filter((k) => core.COMMANDS[k].roles.includes('app')).sort());
  const k = exposed.koeApp;
  k.blockIndent('pa1', 'b2', 'in'); k.blockSetOpen('pa1', 't', false); k.blockSetOpenAll('pa1', true);
  k.blockMove('pa1', 'b2', { afterId: '' }); k.blockMove('pa1', 'b2', { afterId: '', parentId: 'a' });
  k.blockInsert('pa1', 'b2', 'bullet'); k.blockInsert('pa1', '', 'heading', 1, 'a', true);
  k.blockTurnInto('pa1', 'b2', 'heading', 2); k.blockTurnInto('pa1', 'b2', 'heading', 2, true);
  k.blockMerge('pa1', 'b2', '文'); k.blockMerge('pa1', 'b2', '文', 'a3');
  k.blockSplit('pa1', 'b2', '文', 1); k.blockSplit('pa1', 'b2', '文', 0, ''); k.blockSplit('pa1', 'b2', '文', 1, undefined, true);
  k.blockDuplicate('pa1', 'b2'); k.blockDuplicate('pa1', 'b2', '', 'a');
  assert.deepStrictEqual(p.sent.map((m) => [m.cmd, m.args]), [
    ['block.indent', { pageId: 'pa1', blockId: 'b2', dir: 'in' }], ['block.setOpen', { pageId: 'pa1', blockId: 't', open: false }], ['block.setOpenAll', { pageId: 'pa1', open: true }],
    ['block.move', { pageId: 'pa1', blockId: 'b2', afterId: '' }], ['block.move', { pageId: 'pa1', blockId: 'b2', afterId: '', parentId: 'a' }],
    ['block.insert', { pageId: 'pa1', afterBlockId: 'b2', type: 'bullet' }], ['block.insert', { pageId: 'pa1', afterBlockId: '', type: 'heading', level: 1, parentId: 'a', toggle: true }],
    ['block.turnInto', { pageId: 'pa1', blockId: 'b2', type: 'heading', level: 2 }], ['block.turnInto', { pageId: 'pa1', blockId: 'b2', type: 'heading', level: 2, toggle: true }],
    ['block.merge', { pageId: 'pa1', blockId: 'b2', text: '文' }], ['block.merge', { pageId: 'pa1', blockId: 'b2', text: '文', intoId: 'a3' }],
    ['block.split', { pageId: 'pa1', blockId: 'b2', text: '文', at: 1 }], ['block.split', { pageId: 'pa1', blockId: 'b2', text: '文', at: 0, afterId: '' }],
    ['block.split', { pageId: 'pa1', blockId: 'b2', text: '文', at: 1, inside: true }],
    ['block.duplicate', { pageId: 'pa1', blockId: 'b2' }], ['block.duplicate', { pageId: 'pa1', blockId: 'b2', afterId: '', parentId: 'a' }],
  ]);
  assert.ok(p.sent.every((m) => /^a:[0-9a-f-]{36}$/.test(m.tx)), '書く頼みに tx が無い');
  const { jsonTwin } = require('./helpers/dbtmp');
  const j = jsonTwin();
  try {
    await assert.rejects(j.call('block.indent', { pageId: 'pa1', blockId: 'b2', dir: 'in' }), (e) => e.code === 'unknown-cmd');
  } finally { j.done(); }
});

// ---------------------------------------------------------------- NE-3: 読み手は木を平らにしてから（F48・決めたこと 22〜25・33・34）
const R = require('../src/pagerules');
const F = require('../src/mcp/format');
const P = require('../src/mcp/passages');
const M = require('../src/memoTypes');
// 子の箇条書き（出典の付く文）と、閉じたトグルの中の ToDo
const READ = () => [
  { id: 'h1', type: 'heading', level: 2, text: '決定事項' },
  { id: 'a', type: 'bullet', text: '来月の予算案の作成を担当Aが進める', cites: ['s2'], children: [
    { id: 'c1', type: 'bullet', text: '見積書は月末までに先方へ送る予定', cites: [] },
    { id: 'n1', type: 'numbered', text: '一つ目の手順', citeState: 'manual', children: [{ id: 'g1', type: 'bullet', text: '孫の行の文', citeState: 'manual' }] },
    { id: 'n2', type: 'numbered', text: '二つ目の手順', citeState: 'manual' }] },
  { id: 't', type: 'toggle', text: 'たたんだ話', citeState: 'manual', open: false, children: [
    { id: 't1', type: 'todo', text: '閉じた中の ToDo を片付ける', checked: false, assignee: '担当B', citeState: 'manual' },
    { id: 'th', type: 'heading', level: 2, toggle: true, text: '中の見出し', citeState: 'manual' }] },
];

test('NE-3・F48: 文字起こしを直した後（segment.update）、子の箇条書きにも出典が付き、出典の数の分母に入る', T, () => withDb((db) => {
  const r = call(db, 'segment.update', { pageId: 'pa1', segId: 's3', patch: { text: '見積書は月末までに先方へ送る予定です' } });
  assert.strictEqual(r.ok, true, r.code);
  const c1 = find(r.result.page, 'c1').b;
  assert.ok(Array.isArray(c1.cites) && c1.cites.includes('s3'), `子の箇条書きに出典が付かない: ${JSON.stringify(c1)}`);
  assert.deepStrictEqual(r.result.page.citeStat, { ...r.result.page.citeStat, linked: 2, total: 2 });
  assert.deepStrictEqual(R.citeStatOf(r.result.page.blocks), { linked: 2, total: 2 });
}, READ()));

test('NE-3・F48: 閉じたトグルの中の ToDo が actionView と MCP の list_action_items に出る', T, () => withDb((db, t) => {
  const v = call(db, 'pages.actionView', {}).result;
  assert.deepStrictEqual(v.actions.map((x) => x.blockId), ['t1']);
  assert.strictEqual(v.total, 1);
  assert.deepStrictEqual(v.people, [{ name: '担当B', count: 1 }]);
  const tools = require('../src/mcp/tools');
  const r = tools.callTool('list_action_items', {}, { sqlite: require('node:sqlite'), dataDir: t.dir, now: NOW });
  assert.strictEqual(r.isError, false, r.text);
  assert.ok(r.text.split('\n').some((l) => l.startsWith('- [ ] 閉じた中の ToDo を片付ける｜担当: 担当B')), r.text);
}, READ()));

test('NE-3: 子の箇条書きが search_passages の要約の箇所と expand_passage に出る（箇所は下げない: NR20）', () => {
  const parts = P.chunkSummary(READ());
  const lines = parts.flatMap((p) => p.lines);
  for (const l of ['- 見積書は月末までに先方へ送る予定', '- 孫の行の文', '- たたんだ話']) assert.ok(lines.includes(l), `${l}\n${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => l.startsWith('- [ ] 閉じた中の ToDo を片付ける')), JSON.stringify(lines));
  assert.ok(!lines.some((l) => /^ /.test(l)), '箇所の行を下げた');
  assert.deepStrictEqual(parts.map((p) => p.heading), ['決定事項'], '子の中の見出しが節を始めた');
  assert.ok(parts[0].blocks.some((b) => b.id === 'g1'));
});

test('NE-3・決めたこと 22: get_meeting に子が2つの空白で下げて出る（閉じたトグルの子も・トグルは『- 』）。子の無い要約は 0.13.0 と1文字も同じ', () => {
  const md = F.meetingMarkdown({ id: 'pa1', title: titleAt('2026-10-27T01:00:00.000Z'), blocks: READ() }, [], { header: false }).text;
  const sum = md.slice(md.indexOf('## 要約'), md.indexOf('\n## ', md.indexOf('## 要約') + 3)).split('\n');
  assert.deepStrictEqual(sum.slice(1), [
    '### 決定事項',
    '- 来月の予算案の作成を担当Aが進める（出典: [s2](' + sum[2].split('[s2](')[1],
    '  - 見積書は月末までに先方へ送る予定',
    '  1. 一つ目の手順',
    '    - 孫の行の文',
    '  2. 二つ目の手順',
    '- たたんだ話',
    sum[8],
    '### 中の見出し',   // 2026-10-28 の点検 4（NR40）: 見出しは下げない（意図して変えたテスト。前は '  ### 中の見出し'）
  ]);
  assert.match(sum[8], /^ {2}- \[ \] 閉じた中の ToDo を片付ける（担当: 担当B／期限: 要確認）$/);
  // 子の無い要約は前と同じ（children が空でも無くても）
  const flat = samplePage('pa1').page.blocks;
  const a = F.meetingMarkdown({ id: 'pa1', title: titleAt('2026-10-27T01:00:00.000Z'), blocks: flat }, [], { header: false }).text;
  const b = F.meetingMarkdown({ id: 'pa1', title: titleAt('2026-10-27T01:00:00.000Z'), blocks: flat.map((x) => ({ ...x, children: [] })) }, [], { header: false }).text;
  assert.strictEqual(a, b);
});

test('NE-3（点検 4）: get_meeting の要約で、入れ子の見出しを下げず、見出しの後の行は見出しの段から数え直す（4つ以上の空白で始まる行が見出しの後に来ない）', () => {
  const deep = [{ id: 'o', type: 'toggle', text: '外', citeState: 'manual', children: [{ id: 'p', type: 'bullet', text: '親', citeState: 'manual', children: [
    { id: 'dh', type: 'heading', toggle: true, level: 2, text: '深い見出し', citeState: 'manual', children: [{ id: 'q', type: 'bullet', text: '見出しの子', citeState: 'manual', children: [{ id: 'r', type: 'bullet', text: '孫', citeState: 'manual' }] }] },
    { id: 'h3', type: 'heading', level: 3, text: '子の無い見出し', citeState: 'manual' }, { id: 's', type: 'bullet', text: '見出しの後', citeState: 'manual' }] },
  { id: 'u', type: 'bullet', text: '外の子', citeState: 'manual' }] }, { id: 'z', type: 'paragraph', text: '終わり', citeState: 'manual' }];
  const md = F.meetingMarkdown({ id: 'pa1', title: titleAt('2026-10-27T01:00:00.000Z'), blocks: deep }, [], { header: false }).text;
  const sum = md.slice(md.indexOf('## 要約'), md.indexOf('\n## ', md.indexOf('## 要約') + 3)).split('\n');
  assert.deepStrictEqual(sum.slice(1), ['- 外', '  - 親', '### 深い見出し', '  - 見出しの子', '    - 孫', '#### 子の無い見出し', '- 見出しの後', '- 外の子', '- 終わり']);
});

test('NE-3: 一覧のまとめの最初の要点・ToDo の数・『要約がある』・会議の頭の『出典: x/y』が子も数える', () => {
  const kidsOnly = [{ id: 'p', type: 'paragraph', text: '前置き', children: [{ id: 'k', type: 'bullet', text: '子の要点です', cites: ['s1'] },
    { id: 'kt', type: 'todo', text: '子の ToDo', checked: false, due: '2026-11-01', assignee: '担当C', citeState: 'manual' }, { id: 'kh', type: 'heading', toggle: true, text: '子の見出し' }] }];
  const s = R.summarize({ id: 'p1', blocks: kidsOnly });
  assert.deepStrictEqual([s.preview, s.actionCount, s.openActionCount, s.nextDue, s.assignees, s.hasSummary], ['子の要点です', 1, 1, '2026-11-01', ['担当C'], true]);
  assert.ok(s.searchText.includes('子の要点です') && s.searchText.includes('子の ToDo'));
  assert.deepStrictEqual(R.citeStatOf(kidsOnly), { linked: 1, total: 1 });
  const head = F.meetingMarkdown({ id: 'pa1', title: titleAt('2026-10-27T01:00:00.000Z'), blocks: kidsOnly }, []).text;
  assert.ok(head.includes('- 出典: 1/1'), head.slice(0, 400));
  const short = [{ id: 'q', type: 'paragraph', text: '親', children: [{ id: 'qs', type: 'bullet', text: '短い' }] }];
  R.markShortBlocks(short);
  assert.strictEqual(short[0].children[0].citeSkip, true, '子の短い行に印が付かない');
});

test('NE-3・決めたこと 34: orderForView は最上位の行だけを並べ替え、子は親と一緒（memoTypes と画面の写しが同じ答え: repo）。子の中の見出しは節を始めない', () => {
  const H = (id, text, o = {}) => ({ id, type: 'heading', text, ...o });
  const tree = [H('t1', '前回の宿題の状況'), { id: 'x', type: 'bullet', text: 'x', children: [H('in', '決定事項', { toggle: true }), { id: 'xk', type: 'bullet', text: 'xk' }] },
    H('c1', '決定事項'), { id: 'y', type: 'bullet', text: 'y', children: [{ id: 'yk', type: 'bullet', text: 'yk' }] }];
  assert.deepStrictEqual(M.orderForView(tree), [2, 3, 0, 1], '子が親から離れた・子の中の見出しが節を始めた');
  const view = M.orderForView(tree).map((i) => tree[i]);
  assert.deepStrictEqual(BT.flattenBlocks(view).map((b) => b.id), ['c1', 'y', 'yk', 't1', 'x', 'in', 'xk']);
  const html = fs.readFileSync(require.resolve('../src/renderer/app.html'), 'utf8');
  const m = /\n {2}const VIEW_HEADS = (\{[\s\S]*?\n {2}\});/.exec(html);
  const at = html.indexOf('  function orderForView(');
  const app = new Function(`const VIEW_HEADS = ${m[1]};\n${html.slice(at, html.indexOf('\n  }\n', at) + 4)}\nreturn orderForView;`)();   // eslint-disable-line no-new-func
  assert.deepStrictEqual(app(tree), M.orderForView(tree));
});

test('NE-3: cite.js の中身は前と同じ（sha256）', () => {
  const sha = require('node:crypto').createHash('sha256').update(fs.readFileSync(require.resolve('../src/cite.js'))).digest('hex');
  assert.strictEqual(sha, '356ad5939c88c9dc129ebfb9ef66cff2f6ebcecb549ee22947cfe7d68556e89e');
});
