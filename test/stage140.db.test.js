/*
 * stage140.db.test.js — 0.14.0 の DB の命令と照らし（計画 docs/plans/2026-10-26-140.md の Task EB-2）
 * 自分の操作を後ろから当てて戻す命令 edit.revert（後から変わっていたら stale・main の行とほかのページの行は戻さない・鍵の間は locked・
 * ページの行は memo・memoDoc だけ戻す: R60）・文字の飾り rich の保存と照らし（色は決まった9色で1つの区切りに1つ・リンクは決まった頭・
 * コードとリンクは同じ区切りに持てない）・口の答えの changed（変えたときだけ・送り直しも: R59・R75）・preload の onEditStep。
 * 一時の DB（helpers/dbtmp.js）で core.call を本当に呼ぶ。口の答えは server.js を本当に起こして見る。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sqlite = require('node:sqlite');
const { MessageChannel } = require('node:worker_threads');
const { tmpDb, tmpData, samplePage, electronShape } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const C = require('../src/db/commands');
const { applyOps } = require('../src/db/ops');
const R = require('../src/pagerules');
const BT = require('../src/blockTree');

// 時計は命令ごとに進める（戻した後の updatedAt が「今」かを見る）
let clock = Date.parse('2026-10-29T01:00:00.000Z');
const now = () => new Date(clock);
const tick = () => { clock += 60000; return new Date(clock).toISOString(); };
let n = 0;
const txOf = (role) => `${role[0]}:eb2-${String(++n).padStart(6, '0')}`;
const call = (db, cmd, args, role = 'app', tx = txOf(role)) => ({ ...core.call(db, { role, cmd, args, tx }, { now, labels: {} }), tx });
const get = (db, id = 'pa1') => call(db, 'page.get', { id }).result.page;
const raw = (db, id = 'pa1') => C.readRawPage(db, id);
const oplogN = (db) => db.prepare('select count(*) as c from oplog').get().c;
const opsOf = (db, tx) => JSON.parse(db.prepare('select ops from oplog where tx = ?').get(tx).ops);
const revert = (db, steps, pageId = 'pa1', role = 'app') => call(db, 'edit.revert', { pageId, steps }, role);
const find = (page, id) => BT.locate(page.blocks, id);
const T = { timeout: 5000 };

function withDb(fn, patch = {}, more = []) {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const { page, segments } = samplePage('pa1');
    t.seed({ ...page, ...patch }, segments);
    for (const p of more) t.seed(p, []);
    return fn(db, t);
  } finally { t.done(); }
}

// ページの中身の比べ（updatedAt・citeStat・summaryEdited・rev は除く。R60: 戻さない・作り直す欄。画面に添える routeText・qualityView も除く）
const body = (p) => { const o = structuredClone(p); for (const k of ['updatedAt', 'citeStat', 'summaryEdited', 'rev', 'routeText', 'qualityView']) delete o[k]; return o; };

// ---------------------------------------------------------------- 前提 P2・P3・P8
test('EB-2・P2: 文のある行の頭の block.split（上に空の行）の後の edit.revert で、空の行が消え、今の行は前と同じ（ID・担当・期限・出典も）', T, () => withDb((db) => {
  const before = get(db);
  tick();
  const s = call(db, 'block.split', { pageId: 'pa1', blockId: 'b4', text: before.blocks[3].text, at: 0 });
  assert.strictEqual(s.ok, true, s.code);
  assert.strictEqual(get(db).blocks.length, before.blocks.length + 1);
  tick();
  const r = revert(db, [s.tx]);
  assert.strictEqual(r.ok, true, r.code);
  assert.deepStrictEqual(body(get(db)), body(before));
  assert.deepStrictEqual(r.result.page.blocks.map((b) => b.id), before.blocks.map((b) => b.id));
}));

test('EB-2・P3: Enter の後に同じ文の block.update が来ても、何も書かず changed も無い（1回の Enter は1歩）', T, () => withDb((db) => {
  const s = call(db, 'block.split', { pageId: 'pa1', blockId: 'b2', text: '来月の予算案の作成を担当Aが進める', at: 4 });
  assert.strictEqual(s.ok, true, s.code);
  assert.ok(s.changed, '分割に changed が無い');
  const u = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '来月の予' } });
  assert.strictEqual(u.ok, true, u.code);
  assert.strictEqual(u.changed, undefined, '同じ文の保存が歩みになった');
  assert.deepStrictEqual(opsOf(db, u.tx), []);
}));

test('EB-2・P8: AI の見出しをテキストにした turnInto の edit.revert で aiHeading・citeState も前と同じ', T, () => withDb((db) => {
  const before = get(db);
  const t = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'b1', type: 'paragraph' });
  assert.strictEqual(t.ok, true, t.code);
  const mid = find(get(db), 'b1').b;
  assert.deepStrictEqual([mid.type, mid.aiHeading, mid.citeState], ['paragraph', true, 'manual']);
  const r = revert(db, [t.tx]);
  assert.strictEqual(r.ok, true, r.code);
  const b1 = find(get(db), 'b1').b;
  assert.deepStrictEqual([b1.type, b1.level, b1.aiHeading, b1.citeState], ['heading', 2, undefined, undefined]);
  assert.deepStrictEqual(body(get(db)), body(before));
}));

// ---------------------------------------------------------------- 1つずつ戻す・やり直す（F100）
const STEPS = [
  ['block.split', { pageId: 'pa1', blockId: 'b2', text: '来月の予算案の作成を担当Aが進める', at: 5 }],
  ['block.merge', { pageId: 'pa1', blockId: 'b3', text: '了解' }],
  ['block.turnInto', { pageId: 'pa1', blockId: 'b5', type: 'numbered' }],
  ['block.duplicate', { pageId: 'pa1', blockId: 'b4' }],
  ['block.move', { pageId: 'pa1', blockId: 'b1', afterId: 'b4' }],
  ['block.remove', { pageId: 'pa1', blockId: 'b6' }],
  ['block.setAction', { pageId: 'pa1', blockId: 'b4', assignee: '担当B', dueRaw: '来週の金曜' }],
  ['block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '直した要点の文をここに書いた' } }],
];
test('EB-2・F100: split・merge・turnInto・duplicate・move・remove・setAction・update を1つずつ edit.revert → 前と同じ（updatedAt は今・citeStat は作り直し）。戻した tx をもう一度戻すとやり直し', T, () => {
  for (const [cmd, args] of STEPS) withDb((db) => {
    const before = get(db);
    tick();
    const s = call(db, cmd, args);
    assert.strictEqual(s.ok, true, `${cmd} ${s.code}`);
    const after = get(db);
    assert.notDeepStrictEqual(body(after), body(before), `${cmd}: 何も変わっていない`);
    const n0 = oplogN(db);
    const at = tick();
    const r = revert(db, [s.tx]);
    assert.strictEqual(r.ok, true, `${cmd}: ${r.code}`);
    assert.ok(r.changed, `${cmd}: 戻したのに changed が無い`);
    assert.strictEqual(oplogN(db), n0 + 1, `${cmd}: oplog が1行でない`);
    const back = get(db);
    assert.deepStrictEqual(body(back), body(before), `${cmd}: 戻した形が前と違う`);
    assert.deepStrictEqual(body(r.result.page), body(before), `${cmd}: 答えのページ`);
    assert.strictEqual(back.updatedAt, at, `${cmd}: updatedAt が今の時刻でない`);
    assert.deepStrictEqual(back.citeStat, { ...before.citeStat, ...R.citeStatOf(back.blocks) }, `${cmd}: citeStat を作り直していない`);
    const again = revert(db, [r.tx]);
    assert.strictEqual(again.ok, true, `${cmd}: やり直し ${again.code}`);
    assert.deepStrictEqual(body(get(db)), body(after), `${cmd}: やり直した形が直した後と違う`);
  });
});

test('EB-2・P5 ‡131: 入れ子の字下げと子ごとの削除が edit.revert で戻る（親と子の並び・子孫の行も）', T, () => {
  const kid = (id, o = {}) => ({ id, type: 'bullet', text: `${id}の行の文です`, citeState: 'manual', cites: [], ...o });
  const blocks = [kid('x'), kid('a', { children: [kid('a1'), kid('a2', { children: [kid('a21')] })] }), kid('y')];
  withDb((db) => {
    const before = get(db);
    const i = call(db, 'block.indent', { pageId: 'pa1', blockId: 'a', dir: 'in' });
    assert.strictEqual(i.ok, true, i.code);
    assert.deepStrictEqual(find(get(db), 'a').parent && find(get(db), 'a').parent.id, 'x');
    const d = call(db, 'block.remove', { pageId: 'pa1', blockId: 'x' });
    assert.strictEqual(d.ok, true, d.code);
    assert.strictEqual(find(get(db), 'a21'), null);
    assert.strictEqual(revert(db, [d.tx]).ok, true);
    assert.strictEqual(find(get(db), 'a21').parent.id, 'a2');
    assert.strictEqual(revert(db, [i.tx]).ok, true);
    assert.deepStrictEqual(body(get(db)), body(before));
  }, { blocks });
});

test('EB-2: 1つの歩みに2つの tx（記法の変換＋下に行を足す）を渡すと、新しい順に後ろから当てて1回で戻る（oplog は1行）', T, () => withDb((db) => {
  const before = get(db);
  const a = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'b5', type: 'divider' });
  assert.deepStrictEqual([a.ok, a.code], [false, 'bad-args']);   // 文のある行は区切り線にできない（EQ16 (a)）
  const t = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'b5', type: 'quote' });
  const ins = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b5', type: 'bullet' });
  assert.ok(t.ok && ins.ok);
  const n0 = oplogN(db);
  const r = revert(db, [t.tx, ins.tx]);
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(oplogN(db), n0 + 1);
  assert.deepStrictEqual(body(get(db)), body(before));
  for (const bad of [[], [t.tx, t.tx], Array.from({ length: 51 }, (_, k) => `a:many-${String(k).padStart(6, '0')}`), ['x']]) {
    assert.deepStrictEqual([revert(db, bad).ok, revert(db, bad).code], [false, 'bad-args'], JSON.stringify(bad).slice(0, 40));
  }
}));

// ---------------------------------------------------------------- 後から変わっていたら戻さない（F100）
test('EB-2・F100: 後から main の page.put（再生成）が入った行の歩みは stale で、何も変わらない', T, () => withDb((db) => {
  const s = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '人が直した要点の文です' } });
  assert.strictEqual(s.ok, true, s.code);
  const p = get(db);
  const put = call(db, 'page.put', { page: { ...p, blocks: p.blocks.map((b) => (b.id === 'b2' ? { ...b, text: '作り直した要点の文です' } : b)) }, baseRev: p.rev }, 'main');
  assert.strictEqual(put.ok, true, put.code);
  const was = JSON.stringify(raw(db));
  const n0 = oplogN(db);
  const r = revert(db, [s.tx]);
  assert.deepStrictEqual([r.ok, r.code, r.retry], [false, 'stale', false]);
  assert.strictEqual(JSON.stringify(raw(db)), was, '中途半端に戻した');
  assert.strictEqual(oplogN(db), n0, '断った命令が oplog に残った');
}));

test('EB-2・F100: 文字起こしを直した後の出典の付け直し（segment.update）が入った行の歩みは stale で、何も変わらない', T, () => withDb((db) => {
  const s = call(db, 'block.duplicate', { pageId: 'pa1', blockId: 'b2' });
  assert.strictEqual(s.ok, true, s.code);
  const copy = s.result.blockId;
  const c0 = find(get(db), copy).b.cites;
  const u = call(db, 'segment.update', { pageId: 'pa1', segId: 's2', patch: { text: '予算の話は別の日にすることにしました' } });
  assert.strictEqual(u.ok, true, u.code);
  assert.notDeepStrictEqual(find(get(db), copy).b.cites, c0, '付け直しで出典が変わっていない（場面が空振り）');
  const was = JSON.stringify(raw(db));
  const r = revert(db, [s.tx]);
  assert.deepStrictEqual([r.ok, r.code], [false, 'stale']);
  assert.strictEqual(JSON.stringify(raw(db)), was);
}));

// ---------------------------------------------------------------- 戻せるのは自分の行だけ・鍵
test('EB-2: main の行・ほかのページの行・知らない tx・戻せない命令の tx は bad-args、main の役の edit.revert は forbidden', T, () => {
  const other = { ...samplePage('pa2').page, blocks: [{ id: 'q1', type: 'bullet', text: 'ほかのページの要点の文です', cites: [] }] };
  withDb((db) => {
    const before = JSON.stringify(raw(db));
    const m = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: 'main が直した要点の文です' } }, 'main');
    assert.strictEqual(m.ok, true, m.code);
    const mid = JSON.stringify(raw(db));
    assert.notStrictEqual(mid, before);
    assert.deepStrictEqual([revert(db, [m.tx]).ok, revert(db, [m.tx]).code], [false, 'bad-args'], 'main の行を戻した');
    const o = call(db, 'block.update', { pageId: 'pa2', blockId: 'q1', patch: { text: 'ほかのページで直した文です' } });
    assert.strictEqual(o.ok, true, o.code);
    const r2 = revert(db, [o.tx]);
    assert.deepStrictEqual([r2.ok, r2.code], [false, 'bad-args'], 'ほかのページの tx を通した');
    assert.strictEqual(find(get(db, 'pa2'), 'q1').b.text, 'ほかのページで直した文です');
    assert.deepStrictEqual([revert(db, ['a:no-such-tx-0001']).code], ['bad-args']);
    // 利用者が付け直した題名（D77。戻せない命令の tx の見本）
    const title = call(db, 'page.setTitle', { id: 'pa1', title: '直した題' });
    assert.deepStrictEqual([revert(db, [title.tx]).code], ['bad-args'], '戻せない命令を戻した');
    const mine = call(db, 'block.update', { pageId: 'pa1', blockId: 'b5', patch: { text: '自分で直した要点の文です' } });
    assert.deepStrictEqual([revert(db, [mine.tx], 'pa1', 'main').code], ['forbidden']);
    assert.strictEqual(JSON.stringify(raw(db).blocks.find((b) => b.id === 'b2')), JSON.stringify(JSON.parse(mid).blocks.find((b) => b.id === 'b2')));
  }, {}, [other]);
});

test('EB-2: 同じ tx の edit.revert を2回送ると1回だけ戻る（dup）。要約の欄の鍵の間は locked で何も変えない', T, () => withDb((db) => {
  const before = get(db);
  const s = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '直した要点の文をここに書いた' } });
  const tx = txOf('app');
  const r1 = call(db, 'edit.revert', { pageId: 'pa1', steps: [s.tx] }, 'app', tx);
  const n0 = oplogN(db);
  const r2 = call(db, 'edit.revert', { pageId: 'pa1', steps: [s.tx] }, 'app', tx);
  assert.deepStrictEqual([r1.ok, r2.ok, r2.dup], [true, true, true]);
  assert.strictEqual(oplogN(db), n0, '送り直しが新しい命令として効いた');
  assert.deepStrictEqual(body(get(db)), body(before));
  assert.deepStrictEqual(body(r2.result.page), body(before));
  // 鍵: 直した後に要約待ちになったページ
  const s2 = call(db, 'block.update', { pageId: 'pa1', blockId: 'b5', patch: { text: '鍵の前に直した要点の文です' } });
  const p = get(db);
  assert.strictEqual(call(db, 'page.put', { page: { ...p, summaryWait: true }, baseRev: p.rev }, 'main').ok, true);
  const was = JSON.stringify(raw(db));
  const r3 = revert(db, [s2.tx]);
  assert.deepStrictEqual([r3.ok, r3.code], [false, 'locked']);
  assert.strictEqual(JSON.stringify(raw(db)), was);
}));

// ---------------------------------------------------------------- T4b
test('EB-2: T4b: 控えに後の oplog（edit.revert を含む）を前へ当て直すと今の表と同じ', T, async () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const { page, segments } = samplePage('pa1');
    t.seed(page, segments);
    const to = path.join(t.dir, 'copy-1.db');
    await sqlite.backup(db, to);
    const copy = new sqlite.DatabaseSync(to);
    try {
      const k = db.prepare('select coalesce(max(seq), 0) s from oplog').get().s;
      const steps = STEPS.map(([cmd, args]) => { const r = call(db, cmd, args); assert.strictEqual(r.ok, true, `${cmd} ${r.code}`); return r.tx; });
      const back = revert(db, [steps[7]]);
      const back2 = revert(db, [steps[5]]);
      assert.ok(back.ok && back2.ok, `${back.code} ${back2.code}`);
      assert.strictEqual(revert(db, [back.tx]).ok, true);
      const rows = db.prepare('select ops from oplog where seq > ? order by seq').all(k).map((r) => JSON.parse(r.ops));
      for (const o of rows) applyOps(copy, o, 'forward');
      const dump = (c) => [
        c.prepare('select id, type, page_id, parent_id, ord, text, rich, attrs, fold, rev, created_at, updated_at, trashed_at from blocks order by id').all(),
        c.prepare('select page_id, id, n, at_ms, duration_ms, text, fold, failed, extra from segments order by page_id, id').all(),
      ].map((list) => list.map((r) => ({ ...r })));
      assert.deepStrictEqual(dump(copy), dump(db));
    } finally { copy.close(); }
  } finally { t.done(); }
});

// ---------------------------------------------------------------- 文字の飾り（F101・SEC2）
test('EB-2・F101: block.update の patch.rich が保存され、text は rich から作られる。rich の行に text だけ → bad-args', T, () => withDb((db) => {
  const rich = [{ t: '来月の', m: ['b'] }, { t: '予算案', m: [['color', 'red']] }, { t: 'の作成', m: [] }];
  const r = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { rich } });
  assert.strictEqual(r.ok, true, r.code);
  const b2 = find(get(db), 'b2').b;
  assert.deepStrictEqual(b2.rich, [{ t: '来月の', m: ['b'] }, { t: '予算案', m: [['color', 'red']] }, { t: 'の作成', m: [] }]);
  assert.strictEqual(b2.text, '来月の予算案の作成');
  assert.strictEqual(raw(db).blocks.find((b) => b.id === 'b2').text, '来月の予算案の作成');
  const was = JSON.stringify(raw(db));
  const t = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '飾りを捨てる文' } });
  assert.deepStrictEqual([t.ok, t.code], [false, 'bad-args'], 'rich の行に text だけの直しを通した');
  assert.strictEqual(JSON.stringify(raw(db)), was);
  // 飾りを全部外した rich は行に rich を持たない
  const plain = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { rich: [{ t: '飾りの無い文', m: [] }] } });
  assert.strictEqual(plain.ok, true, plain.code);
  assert.deepStrictEqual([find(get(db), 'b2').b.rich, find(get(db), 'b2').b.text], [undefined, '飾りの無い文']);
  assert.strictEqual(call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '飾りの無い行は文だけで直せる' } }).ok, true);
}));

test('EB-2・F101・SEC2・BQ3: 色が COLORS に無い・1つの区切りに color と bg の両方か同じ種類の2つ・javascript: のリンク・code と link が同じ区切り → bad-args', T, () => withDb((db) => {
  const try1 = (m) => call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { rich: [{ t: '要点', m }] } });
  for (const m of [[['color', 'red']], [['bg', 'yellow']], ['b', 'code'], [['link', 'https://example.invalid/']], ['i', ['link', 'natsu://page/p1']]]) {
    assert.strictEqual(try1(m).ok, true, JSON.stringify(m));
  }
  const was = JSON.stringify(raw(db));
  for (const m of [[['color', '#ff0000']], [['bg', 'cyan']], [['color', 'red'], ['bg', 'yellow']], [['color', 'red'], ['color', 'blue']], [['bg', 'red'], ['bg', 'red']],
    [['link', 'javascript:alert(1)']], [['link', 'JavaScript:alert(1)']], ['code', ['link', 'https://example.invalid/']]]) {
    const r = try1(m);
    assert.deepStrictEqual([r.ok, r.code], [false, 'bad-args'], JSON.stringify(m));
  }
  assert.strictEqual(JSON.stringify(raw(db)), was);
  // main の書き戻し（page.put）も同じ照らし（全部の役）
  const p = get(db);
  const bad = { ...p, blocks: p.blocks.map((b) => (b.id === 'b5' ? { ...b, rich: [{ t: b.text, m: [['color', 'red'], ['bg', 'red']] }] } : b)) };
  assert.deepStrictEqual([call(db, 'page.put', { page: bad, baseRev: p.rev }, 'main').code], ['bad-args']);
}));

test('EB-2・F101: block.merge に rich を渡すと今の行の飾りが前の行の後ろに残る。block.split に rich を渡すと同じ位置で分かれる。rich の文と text が違えば bad-args', T, () => withDb((db) => {
  const m = call(db, 'block.merge', { pageId: 'pa1', blockId: 'b3', text: '了解', rich: [{ t: '了', m: ['b'] }, { t: '解', m: [] }] });
  assert.strictEqual(m.ok, true, m.code);
  const b2 = find(get(db), 'b2').b;
  assert.strictEqual(b2.text, '来月の予算案の作成を担当Aが進める了解');
  assert.deepStrictEqual(b2.rich, [{ t: '来月の予算案の作成を担当Aが進める', m: [] }, { t: '了', m: ['b'] }, { t: '解', m: [] }]);
  const s = call(db, 'block.split', { pageId: 'pa1', blockId: 'b5', text: '次回は来週', at: 2, rich: [{ t: '次回', m: ['b'] }, { t: 'は来週', m: ['i'] }] });
  assert.strictEqual(s.ok, true, s.code);
  const p = get(db);
  assert.deepStrictEqual([find(p, 'b5').b.text, find(p, 'b5').b.rich], ['次回', [{ t: '次回', m: ['b'] }]]);
  assert.deepStrictEqual([find(p, s.result.blockId).b.text, find(p, s.result.blockId).b.rich], ['は来週', [{ t: 'は来週', m: ['i'] }]]);
  const plainTail = call(db, 'block.split', { pageId: 'pa1', blockId: 'b6', text: '議事録を共有', at: 3, rich: [{ t: '議事録', m: ['u'] }, { t: 'を共有', m: [] }] });
  assert.strictEqual(find(get(db), plainTail.result.blockId).b.rich, undefined, '飾りの無い後ろの行に rich が残った');
  const was = JSON.stringify(raw(db));
  for (const [cmd, args] of [['block.split', { pageId: 'pa1', blockId: 'b4', text: '見積書', at: 1, rich: [{ t: '別の文', m: ['b'] }] }],
    ['block.merge', { pageId: 'pa1', blockId: 'b4', text: '見積書', rich: [{ t: '見積', m: ['b'] }] }],
    ['block.split', { pageId: 'pa1', blockId: 'b4', text: '見積書', at: 1, rich: [{ t: '見積書', m: [['color', 'cyan']] }] }]]) {
    const r = call(db, cmd, args);
    assert.deepStrictEqual([r.ok, r.code], [false, 'bad-args'], cmd);
  }
  assert.strictEqual(JSON.stringify(raw(db)), was);
  // 戻すと飾りも前の形
  assert.strictEqual(revert(db, [s.tx]).ok, true);
  assert.deepStrictEqual([find(get(db), 'b5').b.text, find(get(db), 'b5').b.rich], ['次回は来週の同じ時間に集まることにした', undefined]);
}));

test('EB-2: blocks.setColor（1つの行でも）は oplog 1行で行の色を付け・外し、edit.revert で戻る。知らない色・無い行 → bad-args', T, () => withDb((db) => {
  const before = get(db);
  const r = call(db, 'blocks.setColor', { pageId: 'pa1', ids: ['b2'], color: 'red' });
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(find(get(db), 'b2').b.color, 'red');
  const two = call(db, 'blocks.setColor', { pageId: 'pa1', ids: ['b2', 'b5'], color: 'yellow_bg' });
  assert.strictEqual(two.ok, true, two.code);
  assert.deepStrictEqual([find(get(db), 'b2').b.color, find(get(db), 'b5').b.color], ['yellow_bg', 'yellow_bg']);
  const was = JSON.stringify(raw(db));
  for (const args of [{ ids: ['b2'], color: 'cyan' }, { ids: ['b2'], color: 'red_fg' }, { ids: ['b2'], color: '#f00' }, { ids: ['nope'], color: 'red' }, { ids: [], color: 'red' }]) {
    const x = call(db, 'blocks.setColor', { pageId: 'pa1', ...args });
    assert.deepStrictEqual([x.ok, x.code], [false, 'bad-args'], JSON.stringify(args));
  }
  assert.strictEqual(JSON.stringify(raw(db)), was);
  const off = call(db, 'blocks.setColor', { pageId: 'pa1', ids: ['b5'], color: '' });
  assert.strictEqual(find(get(db), 'b5').b.color, undefined);
  assert.strictEqual(revert(db, [two.tx, off.tx]).ok, true);
  assert.strictEqual(revert(db, [r.tx]).ok, true);
  assert.deepStrictEqual(body(get(db)), body(before));
}));

// ---------------------------------------------------------------- G1・R60（第4版）
test('EB-2・G1: 行を足した歩みの後にその行を block.setOpen で閉じても、足した歩みは edit.revert で戻る。複製（open を写す）も同じ', T, () => withDb((db) => {
  const before = get(db);
  const ins = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b2', type: 'toggle' });
  assert.strictEqual(ins.ok, true, ins.code);
  const id = ins.result.blockId;
  assert.strictEqual(call(db, 'block.setOpen', { pageId: 'pa1', blockId: id, open: false }).ok, true);
  const dup = call(db, 'block.duplicate', { pageId: 'pa1', blockId: id });
  assert.strictEqual(find(get(db), dup.result.blockId).b.open, false);
  assert.strictEqual(call(db, 'block.setOpen', { pageId: 'pa1', blockId: dup.result.blockId, open: true }).ok, true);
  const r1 = revert(db, [dup.tx]);
  assert.strictEqual(r1.ok, true, `複製: ${r1.code}`);
  const r2 = revert(db, [ins.tx]);
  assert.strictEqual(r2.ok, true, `足した行: ${r2.code}`);
  assert.deepStrictEqual(body(get(db)), body(before));
}));

test('EB-2・R60: 要約の歩みを全部戻しても summaryEdited は立てたまま。作り直しで印が消えた後に戻しても印が立つ', T, () => withDb((db) => {
  assert.strictEqual(get(db).summaryEdited, undefined);
  const s = call(db, 'block.update', { pageId: 'pa1', blockId: 'b5', patch: { text: '人が直した要点の文です' } });
  assert.strictEqual(get(db).summaryEdited, true);
  assert.strictEqual(revert(db, [s.tx]).ok, true);
  assert.strictEqual(get(db).summaryEdited, true, '戻したら手直しの印が消えた（［要約を再生成］の確かめが出ない）');
  // 作り直し（同じ行で、印の無い要約の書き戻し）の後に、前の歩みを戻す → 戻した直しも手直し
  const s2 = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '二つ目に直した要点の文です' } });
  const p = get(db);
  const regen = { ...p }; delete regen.summaryEdited;
  assert.strictEqual(call(db, 'page.put', { page: regen, baseRev: p.rev }, 'main').ok, true);
  assert.strictEqual(get(db).summaryEdited, undefined);
  assert.strictEqual(revert(db, [s2.tx]).ok, true);
  assert.strictEqual(get(db).summaryEdited, true, 'edit.revert が手直しの印を立てない');
}));

test('EB-2・R60: 後の命令で関係の無い短い箇条書きに citeSkip が付いた後でも、前の歩みは戻る。戻して短くなった行は citeSkip が付き、出典の照合に足りる文に戻った行は外れる', T, () => withDb((db) => {
  // b3（「了解」: 短い AI の行）は印を持たずに入っている。消して戻すと、印の無いまま戻る
  assert.strictEqual(raw(db).blocks.find((b) => b.id === 'b3').citeSkip, undefined);
  const del = call(db, 'block.remove', { pageId: 'pa1', blockId: 'b3' });
  const back = revert(db, [del.tx]);
  assert.strictEqual(back.ok, true, back.code);
  assert.strictEqual(raw(db).blocks.find((b) => b.id === 'b3').citeSkip, undefined, '戻した歩みが関係の無い行の印を作った');
  // 後の命令（ほかの行の直し）が b3 に印を付ける
  assert.strictEqual(call(db, 'block.update', { pageId: 'pa1', blockId: 'b5', patch: { text: '関係の無い行を直した文です' } }).ok, true);
  assert.strictEqual(raw(db).blocks.find((b) => b.id === 'b3').citeSkip, true);
  const redo = revert(db, [back.tx]);
  assert.strictEqual(redo.ok, true, `印が付いただけで戻せない: ${redo.code}`);
  assert.strictEqual(find(get(db), 'b3'), null);
  // 文が変わった行の印は作り直す
  const shorten = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '短い' } });
  assert.strictEqual(raw(db).blocks.find((b) => b.id === 'b2').citeSkip, true);
  assert.strictEqual(revert(db, [shorten.tx]).ok, true);
  assert.strictEqual(raw(db).blocks.find((b) => b.id === 'b2').citeSkip, undefined, '照合に足りる文に戻ったのに印が残った');
  const grow = call(db, 'block.update', { pageId: 'pa1', blockId: 'b6', patch: { text: '短' } });
  assert.strictEqual(revert(db, [grow.tx]).ok, true);
  const lengthen = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b6', type: 'bullet' });
  const w = call(db, 'block.update', { pageId: 'pa1', blockId: lengthen.result.blockId, patch: { text: '人が足した行に書いた長めの文です' } });
  assert.strictEqual(raw(db).blocks.find((b) => b.id === lengthen.result.blockId).citeSkip, undefined);
  assert.strictEqual(revert(db, [w.tx]).ok, true);
  assert.strictEqual(raw(db).blocks.find((b) => b.id === lengthen.result.blockId).citeSkip, true, '短い文に戻ったのに印が無い');
}));

// ---------------------------------------------------------------- 口の答えの changed（R59・R75）
function boot(d) {
  const { startServer } = require('../src/db/server');
  const fromServer = [];
  const parent = electronShape.parent((m) => fromServer.push(m));
  startServer({ parentPort: parent, sqlite });
  parent.emit({ type: 'init', dataDir: d.dataDir, labels: {}, network: false });
  const clients = [];
  const port = (role) => {
    const ch = new MessageChannel();
    parent.emit({ type: 'port', role }, [electronShape.port(ch.port1)]);
    const c = electronShape.client(ch.port2);
    clients.push(c);
    return c;
  };
  const waitFor = async (pred, what) => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > 5000) throw new Error(`待ちきれない: ${what}`);
      await new Promise((res) => setTimeout(res, 10));
    }
  };
  const ready = () => waitFor(() => fromServer.some((m) => m.type === 'ready'), 'ready');
  const stop = async () => {
    parent.emit({ type: 'close' });
    await waitFor(() => fromServer.some((m) => m.type === 'closed'), 'closed');
    for (const c of clients.splice(0)) c.close();
  };
  return { port, ready, stop };
}

test('EB-2・R59・R75: 口の答えに changed: true は変えたときだけ。何も変えない命令・読む命令・断られた命令には無い。送り直し（dup）の答えにも変えた命令なら changed', { timeout: 10000 }, async () => {
  const d = tmpData({ pages: 1 });
  const s = boot(d);
  try {
    await s.ready();
    const app = s.port('app');
    const pid = d.ids[0];
    const got = await app.ask({ id: 1, cmd: 'page.get', args: { id: pid } });
    assert.strictEqual(got.ok, true);
    assert.strictEqual(got.changed, undefined, '読む命令に changed');
    const [first, second] = got.result.page.blocks;
    const w = await app.ask({ id: 2, cmd: 'block.update', args: { pageId: pid, blockId: first.id, patch: { text: '口から直した要点の文です' } }, tx: 'a:eb2-port-000001' });
    assert.deepStrictEqual([w.ok, w.changed], [true, true]);
    const again = await app.ask({ id: 3, cmd: 'block.update', args: { pageId: pid, blockId: first.id, patch: { text: '口から直した要点の文です' } }, tx: 'a:eb2-port-000001' });
    assert.deepStrictEqual([again.ok, again.changed], [true, true], '送り直しの答えに changed が無い（1回目の答えが消えると戻せない直しが残る）');
    const same = await app.ask({ id: 4, cmd: 'block.move', args: { pageId: pid, blockId: second.id, afterId: first.id }, tx: 'a:eb2-port-000002' });
    assert.deepStrictEqual([same.ok, same.changed], [true, undefined], '何も変えない命令に changed');
    const sameAgain = await app.ask({ id: 5, cmd: 'block.move', args: { pageId: pid, blockId: second.id, afterId: first.id }, tx: 'a:eb2-port-000002' });
    assert.deepStrictEqual([sameAgain.ok, sameAgain.changed], [true, undefined]);
    assert.strictEqual(d.peek().oplogCount('a:eb2-port-000002'), 1, '何も変えない命令の oplog の行が無い（送り直しを1回だけ効かせられない）');
    const no = await app.ask({ id: 6, cmd: 'block.update', args: { pageId: pid, blockId: first.id, patch: { type: 'nope' } }, tx: 'a:eb2-port-000003' });
    assert.deepStrictEqual([no.ok, no.changed], [false, undefined]);
    const rv = await app.ask({ id: 7, cmd: 'edit.revert', args: { pageId: pid, steps: ['a:eb2-port-000001'] }, tx: 'a:eb2-port-000004' });
    assert.deepStrictEqual([rv.ok, rv.changed], [true, true], rv.code);
  } finally { await s.stop(); d.done(); }
});

// ---------------------------------------------------------------- preload（onEditStep・R58）
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
function loadPreload() {
  const exposed = {}; const on = {}; let uuid = 0;
  const electron = { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } },
    ipcRenderer: { on: (ch, fn) => { on[ch] = fn; }, invoke: async () => ({}), send: () => {} } };
  const sandbox = { require: (m) => { if (m !== 'electron') throw new Error(`sandbox で ${m} を読んだ`); return electron; },
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` }, setTimeout, clearTimeout, console, Promise };
  vm.runInNewContext(PRELOAD, sandbox);
  const port = () => { const p = new EventTarget(); p.sent = []; p.postMessage = (m) => p.sent.push(structuredClone(m)); p.start = () => {};
    p.reply = (id, b) => { const ev = new Event('message'); ev.data = { id, ...b }; (p.onmessage || (() => {}))(ev); };
    p.close = () => p.dispatchEvent(new Event('close')); return p; };
  const givePort = () => { const p = port(); on['db:port']({ ports: [p] }); return p; };
  return { k: exposed.koeApp, givePort };
}
const settle = () => new Promise((r) => setImmediate(r));

test('EB-2: preload の onEditStep は戻せる命令の ok で changed のときだけ・答えより先に { cmd, pageId, step: tx }。読む・断られた・何も変えない・開け閉めの命令では呼ばない', T, async () => {
  const { k, givePort } = loadPreload();
  const p = givePort();
  const seen = [];
  k.onEditStep((s) => seen.push(['step', structuredClone(s)]));   // vm の中の物は別の realm（写して比べる）
  const w = k.blockUpdate('pa1', 'b2', { text: '直した' });
  w.then(() => seen.push(['answer']));
  const m = p.sent[0];
  p.reply(m.id, { ok: true, result: { id: 'pa1' }, changed: true });
  await w; await settle();
  assert.deepStrictEqual(seen, [['step', { cmd: 'block.update', pageId: 'pa1', step: m.tx }], ['answer']]);
  seen.length = 0;
  const cases = [
    [k.blockMove('pa1', 'b2', { afterId: 'b1' }), { ok: true, result: {} }],                      // 何も変えない（changed が無い）
    [k.pageGet('pa1'), { ok: true, result: {}, changed: true }],                                    // 読む命令
    [k.blockRemove('pa1', 'b2'), { ok: false, code: 'locked', retry: false }],                      // 断られた
    [k.blockSetOpen('pa1', 't', false), { ok: true, result: {}, changed: true }],                   // 開け閉め（戻せる命令でない: P6）
    [k.pageSetTitle('pa1', '題'), { ok: true, result: {}, changed: true }],                         // 要約の欄の命令でない
  ];
  for (const [i, [pr, rep]] of cases.entries()) { p.reply(p.sent[i + 1].id, rep); await pr.catch(() => {}); }
  assert.deepStrictEqual(seen, [], '歩みでない答えで onEditStep を呼んだ');
  const rv = k.editRevert('pa1', [m.tx]);
  const sent = p.sent[p.sent.length - 1];
  assert.deepStrictEqual([sent.cmd, sent.args], ['edit.revert', { pageId: 'pa1', steps: [m.tx] }]);
  assert.match(sent.tx, /^a:[0-9a-f-]{36}$/);
  p.reply(sent.id, { ok: true, result: { page: {} }, changed: true });
  await rv;
  assert.deepStrictEqual(seen, [['step', { cmd: 'edit.revert', pageId: 'pa1', step: sent.tx }]]);
  const UB = require('../src/undoBook');
  const names = [.../const UNDO_CMDS = new Set\(\[([^\]]*)\]\)/.exec(PRELOAD)[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  assert.deepStrictEqual(names.sort(), [...UB.UNDO_CMDS].sort(), 'preload の戻せる命令の表が undoBook と違う');
});

test('EB-2・R75: 書く命令を送った後に口を切って送り直すと、送り直しの答え（changed あり）で onEditStep は1回', T, async () => {
  const { k, givePort } = loadPreload();
  const p1 = givePort();
  const seen = [];
  k.onEditStep((s) => seen.push(structuredClone(s)));
  const w = k.blockTurnInto('pa1', 'b2', 'quote');
  const tx = p1.sent[0].tx;
  p1.close();
  const p2 = givePort();
  assert.deepStrictEqual([p2.sent[0].cmd, p2.sent[0].tx], ['block.turnInto', tx]);
  p1.reply(p1.sent[0].id, { ok: true, result: {}, changed: true });   // 古い口の遅い答えは使わない
  p2.reply(p2.sent[0].id, { ok: true, result: {}, changed: true });
  await w;
  p2.reply(p2.sent[0].id, { ok: true, result: {}, changed: true });   // 同じ答えがもう一度来ても
  await settle();
  assert.deepStrictEqual(seen, [{ cmd: 'block.turnInto', pageId: 'pa1', step: tx }]);
});

test('EB-2・R58: preload の blockSplit(…, afterId, inside, rich)・blockMerge(…, intoId, rich) が rich を送る。rich が無ければ今の引数のまま。blocksSetColor は1回', T, () => {
  const { k, givePort } = loadPreload();
  const p = givePort();
  const rich = [{ t: '文', m: ['b'] }];
  k.blockSplit('pa1', 'b2', '文', 1, undefined, undefined, rich);
  k.blockSplit('pa1', 'b2', '文', 0, '', true, rich);
  k.blockSplit('pa1', 'b2', '文', 1);
  k.blockMerge('pa1', 'b2', '文', undefined, rich);
  k.blockMerge('pa1', 'b2', '文', 'a3', rich);
  k.blockMerge('pa1', 'b2', '文');
  k.blocksSetColor('pa1', ['b2', 'b3'], 'red_bg');
  assert.deepStrictEqual(p.sent.map((m) => [m.cmd, m.args]), [
    ['block.split', { pageId: 'pa1', blockId: 'b2', text: '文', at: 1, rich }],
    ['block.split', { pageId: 'pa1', blockId: 'b2', text: '文', at: 0, afterId: '', inside: true, rich }],
    ['block.split', { pageId: 'pa1', blockId: 'b2', text: '文', at: 1 }],
    ['block.merge', { pageId: 'pa1', blockId: 'b2', text: '文', rich }],
    ['block.merge', { pageId: 'pa1', blockId: 'b2', text: '文', intoId: 'a3', rich }],
    ['block.merge', { pageId: 'pa1', blockId: 'b2', text: '文' }],
    ['blocks.setColor', { pageId: 'pa1', ids: ['b2', 'b3'], color: 'red_bg' }],
  ]);
});

// ---------------------------------------------------------------- 0.14.0 EB-1 直し・I4（R90）: 戻す置き場が成り立たなければ stale
test('EB-1 直し・I4（R90）: 戻すと前の親がもう無い・前の並びの鍵にほかの行が入っている → stale で何も変えない', T, () => {
  const kid = (id, o = {}) => ({ id, type: 'bullet', text: `${id}の行の文です`, citeState: 'manual', cites: [], ...o });
  withDb((db) => {
    // 子 a1 を外に出した後、元の親 a を消した → 外に出した歩みを戻すと、a1 は無い親の子になる
    const out = call(db, 'block.indent', { pageId: 'pa1', blockId: 'a1', dir: 'out' });
    assert.strictEqual(out.ok, true, out.code);
    assert.strictEqual(find(get(db), 'a1').parent, null);
    assert.strictEqual(call(db, 'block.remove', { pageId: 'pa1', blockId: 'a' }).ok, true);
    const was = JSON.stringify(raw(db));
    const r = revert(db, [out.tx]);
    assert.deepStrictEqual([r.ok, r.code], [false, 'stale'], '無い親の子に戻した');
    assert.strictEqual(JSON.stringify(raw(db)), was);
  }, { blocks: [kid('x'), kid('a', { children: [kid('a1')] }), kid('y')] });
  withDb((db) => {
    // b3 を消した後、ほかの書き手が b4 を b3 の前の並びの鍵へ動かした → 消した歩みを戻すと、同じ鍵の兄弟が2つになる
    const ord3 = db.prepare("select ord from blocks where id = 'b3'").get().ord;
    const del = call(db, 'block.remove', { pageId: 'pa1', blockId: 'b3' });
    assert.strictEqual(del.ok, true, del.code);
    const ord4 = db.prepare("select ord from blocks where id = 'b4'").get().ord;
    db.exec('BEGIN IMMEDIATE');
    applyOps(db, [{ op: 'move', id: 'b4', ord: ord3, old: ord4 }]);
    db.exec('COMMIT');
    const was = JSON.stringify(raw(db));
    const r = revert(db, [del.tx]);
    assert.deepStrictEqual([r.ok, r.code], [false, 'stale'], '同じ並びの鍵の兄弟を作った');
    assert.strictEqual(JSON.stringify(raw(db)), was);
  });
});

// ---------------------------------------------------------------- EB-2 直し（2026-10-29 の点検）
const kid2 = (id, o = {}) => ({ id, type: 'bullet', text: `${id}の行の文です`, citeState: 'manual', cites: [], ...o });
const orphansOf = (db) => BT.buildTree(db.prepare('select id, parent_id from blocks where page_id = ? and id <> ?').all('pa1', 'pa1').map((r) => ({ id: r.id, parent_id: r.parent_id, block: {} })), 'pa1').orphans;   // 親の無い子と輪の中の行の数

test('EB-2 直し・R90: 戻すと親の輪ができる歩み（a1 を外に出した後に、ほかの書き手が a を a1 の子にした）は stale で、何も変わらない', T, () => withDb((db) => {
  const s = call(db, 'block.indent', { pageId: 'pa1', blockId: 'a1', dir: 'out' });
  assert.strictEqual(s.ok, true, s.code);
  const m = call(db, 'block.move', { pageId: 'pa1', blockId: 'a', afterId: '', parentId: 'a1' }, 'main');
  assert.strictEqual(m.ok, true, m.code);
  assert.strictEqual(orphansOf(db), 0);
  const was = JSON.stringify(raw(db));
  const r = revert(db, [s.tx]);
  assert.deepStrictEqual([r.ok, r.code], [false, 'stale'], '戻して a と a1 が互いの親になった');
  assert.strictEqual(JSON.stringify(raw(db)), was);
  assert.strictEqual(orphansOf(db), 0);
}, { blocks: [kid2('x'), kid2('a', { children: [kid2('a1')] }), kid2('y')] }));

test('EB-2 直し・R90: 戻すと親の無い子ができる歩み（足した行の子に、ほかの書き手が行を入れた）は stale で、何も変わらない', T, () => withDb((db) => {
  const s = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'x', type: 'bullet' });
  assert.strictEqual(s.ok, true, s.code);
  const n = s.result.blockId;
  const m = call(db, 'block.move', { pageId: 'pa1', blockId: 'y', afterId: '', parentId: n }, 'main');
  assert.strictEqual(m.ok, true, m.code);
  const was = JSON.stringify(raw(db));
  const r = revert(db, [s.tx]);
  assert.deepStrictEqual([r.ok, r.code], [false, 'stale'], '戻して y が消えた行を親に持った');
  assert.strictEqual(JSON.stringify(raw(db)), was);
  assert.strictEqual(orphansOf(db), 0);
}, { blocks: [kid2('x'), kid2('y')] }));

test('EB-2 直し: 歩みの tx を古い順でなく渡しても、oplog の順（seq）に重ねて戻す（stale にならない）', T, () => withDb((db) => {
  const before = get(db);
  const s1 = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '一度目に直した文です' } });
  const s2 = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '二度目に直した文です' } });
  assert.ok(s1.ok && s2.ok);
  const r = revert(db, [s2.tx, s1.tx]);
  assert.strictEqual(r.ok, true, r.code);
  assert.deepStrictEqual(body(get(db)), body(before));
}));

test('EB-2 直し: 同じ歩みの中で足してから動かした行は、戻すと消える（置き場の照らしで stale にしない）', T, () => withDb((db) => {
  const before = get(db);
  const ins = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b1', type: 'bullet' });
  assert.strictEqual(ins.ok, true, ins.code);
  const mv = call(db, 'block.move', { pageId: 'pa1', blockId: ins.result.blockId, afterId: 'b4' });
  assert.strictEqual(mv.ok, true, mv.code);
  const r = revert(db, [ins.tx, mv.tx]);
  assert.strictEqual(r.ok, true, r.code);
  assert.deepStrictEqual(body(get(db)), body(before));
}));

test('EB-2 直し: 操作の無い歩み（何も変えない命令の oplog の空の行）を戻しても、何も書かず（updatedAt も）、答えに changed が無い', T, () => withDb((db) => {
  const p0 = get(db);
  const same = call(db, 'block.move', { pageId: 'pa1', blockId: 'b2', afterId: p0.blocks[0].id });
  assert.strictEqual(same.ok, true, same.code);
  assert.deepStrictEqual(opsOf(db, same.tx), [], '前提: 何も変えない命令');
  tick();
  const before = raw(db);
  const r = revert(db, [same.tx]);
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(r.changed, undefined, '何も戻していないのに changed');
  assert.deepStrictEqual(opsOf(db, r.tx), []);
  assert.deepStrictEqual(raw(db), before, 'updatedAt などを書いた');
}));

test('EB-2 直し: ゴミ箱のページの歩みは bad-args（戻さない）', T, () => withDb((db) => {
  const s = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '人が直した要点の文です' } });
  assert.strictEqual(s.ok, true, s.code);
  assert.strictEqual(call(db, 'page.delete', { id: 'pa1' }).ok, true);
  const r = revert(db, [s.tx]);
  assert.deepStrictEqual([r.ok, r.code], [false, 'bad-args']);
}));

test('EB-2 直し: 1回の edit.revert の tx は 50 まで（本物の 51 の歩みは bad-args・新しい 50 は戻せる）', T, () => withDb((db) => {
  const txs = [];
  for (let i = 0; i < 51; i++) {
    const s = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: `直した文 ${i} 回目の要点です` } });
    assert.strictEqual(s.ok, true, s.code);
    txs.push(s.tx);
  }
  assert.deepStrictEqual([revert(db, txs).ok, revert(db, txs).code], [false, 'bad-args']);
  const r = revert(db, txs.slice(1));
  assert.strictEqual(r.ok, true, r.code);
  assert.strictEqual(find(get(db), 'b2').b.text, '直した文 0 回目の要点です');
}));

test('EB-2 直し・R85: rich の行に text だけの直しは、文が同じでも bad-args', T, () => withDb((db) => {
  const rich = [{ t: '来月の', m: ['b'] }, { t: '予算', m: [] }];
  assert.strictEqual(call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { rich } }).ok, true);
  const text = find(get(db), 'b2').b.text;
  assert.strictEqual(text, '来月の予算');
  const r = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text } });
  assert.deepStrictEqual([r.ok, r.code], [false, 'bad-args']);
}));

test('EB-2 直し: rich を送らない古い画面の block.merge で、今の行の文が保存した飾りと違えば、飾りを捨てて文でつなぐ（文と飾りが食い違わない）', T, () => withDb((db) => {
  assert.strictEqual(call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { rich: [{ t: '太字', m: ['b'] }, { t: 'の行', m: [] }] } }).ok, true);
  const prevId = get(db).blocks[0].id;
  const prevText = get(db).blocks[0].text;
  const r = call(db, 'block.merge', { pageId: 'pa1', blockId: 'b2', text: '太字の行に足した' });
  assert.strictEqual(r.ok, true, r.code);
  const b = find(get(db), prevId).b;
  assert.strictEqual(b.text, `${prevText}太字の行に足した`);
  assert.ok(!Array.isArray(b.rich) || b.rich.map((x) => x.t).join('') === b.text, `飾りと文が食い違う: ${JSON.stringify(b.rich)}`);
}));

test('EB-2 直し・R87: 戻す操作はページの行の memo・memoDoc のほかを後ろへ当てない（summaryEdited・updatedAt・citeStat は saveOps と R72 だけが書く）', T, () => withDb((db) => {
  const s = call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '人が直した要点の文です' } });
  assert.strictEqual(s.ok, true, s.code);
  assert.ok(opsOf(db, s.tx).some((o) => o.op === 'set' && o.id === 'pa1' && o.key === 'summaryEdited'), '前提: 直しの歩みがページの印を立てる');
  tick();
  const r = revert(db, [s.tx]);
  assert.strictEqual(r.ok, true, r.code);
  const page = opsOf(db, r.tx).filter((o) => o.id === 'pa1');
  assert.deepStrictEqual(page.filter((o) => o.key === 'summaryEdited'), [], '印を後ろへ当てた（立てたままの印を外してから立て直した）');
  assert.strictEqual(page.filter((o) => o.key === 'updatedAt').length, 1, 'updatedAt を2回書いた（前の値へ戻してから今にした）');
  assert.ok(page.every((o) => o.op === 'set' && ['updatedAt', 'citeStat'].includes(o.key)), JSON.stringify(page));
  assert.strictEqual(get(db).summaryEdited, true);
}));
