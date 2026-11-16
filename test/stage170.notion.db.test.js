/* stage170.notion.db.test.js — 0.17.0（計画 docs/plans/2026-11-13-170.md）の第4部（実機との違いの直し。決めたこと 78〜87・F205〜F214）の DB の命令
 * 一時の DB（helpers/dbtmp.js）で core.call を本当に呼ぶ。1回の操作は1つの命令＝oplog の1行＝edit.revert の1回（Q-04）。
 * Notion の動きは docs/plans/notion-behavior.md の項目番号（X-16〜X-34・B-24〜B-26・D-09〜D-11・T-06）で指す。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpDb, samplePage } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const BT = require('../src/blockTree');

let clock = Date.parse('2026-11-16T01:00:00.000Z');
const now = () => { clock += 1000; return new Date(clock); };
let n = 0;
const txOf = (role) => `${role[0]}:nx-${String(++n).padStart(6, '0')}`;
const call = (db, cmd, args, role = 'app', tx = txOf(role)) => ({ ...core.call(db, { role, cmd, args, tx }, { now, labels: {} }), tx });
const get = (db, id = 'pa1') => call(db, 'page.get', { id }).result.page;
const oplogN = (db) => db.prepare('select count(*) as c from oplog').get().c;
const revert = (db, steps, pageId = 'pa1') => call(db, 'edit.revert', { pageId, steps });
const find = (page, id) => BT.locate(page.blocks, id);
const T = { timeout: 8000 };
// ページの中身の比べ（stage140.db の body と同じ欄を除く）。citeSkip は書くたびに照合（src/cite.js の attachCitations）が付け直す印で、種（seed）は照合を通らないので除く
const noSkip = (list) => (Array.isArray(list) ? list.map((b) => { const { citeSkip, ...x } = b; if (Array.isArray(x.children)) x.children = noSkip(x.children); return x; }) : list);   // eslint-disable-line no-unused-vars
const body = (p) => { const o = structuredClone(p); for (const k of ['updatedAt', 'citeStat', 'summaryEdited', 'rev', 'routeText', 'qualityView']) delete o[k]; o.blocks = noSkip(o.blocks); return o; };
const kid = (id, o = {}) => ({ id, type: 'paragraph', text: `${id}の文`, citeState: 'manual', cites: [], ...o });
function withDb(fn, patch = {}) {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const { page, segments } = samplePage('pa1');
    t.seed({ ...page, ...patch }, segments);
    return fn(db, t);
  } finally { t.done(); }
}
// 1つの命令＝oplog の1行＝edit.revert の1回で、ページが前と同じに戻る
function once(db, cmd, args, check) {
  const before = get(db);
  const n0 = oplogN(db);
  const r = call(db, cmd, { pageId: 'pa1', ...args });
  assert.strictEqual(r.ok, true, `${cmd} ${r.code}`);
  assert.strictEqual(oplogN(db), n0 + 1, `${cmd}: oplog が1行でない`);
  check(get(db), r);
  const back = revert(db, [r.tx]);
  assert.strictEqual(back.ok, true, `${cmd}: ${back.code}`);
  assert.deepStrictEqual(body(get(db)), body(before), `${cmd}: edit.revert の1回で戻らない`);
  return r;
}

// ---------------------------------------------------------------- NX-1（決めたこと 78・79・F205）
test('NX-1・F205: 見出しの block.split は、末尾の後・途中の後半・文のある見出しの頭の上の行がテキスト（X-16）。どれも oplog の1行・edit.revert の1回で戻る', T, () => withDb((db) => {
  once(db, 'block.split', { blockId: 'h', text: '決めたこと', at: 5 }, (p, r) => {
    const l = find(p, 'h');
    assert.deepStrictEqual([l.list[l.index + 1].id, l.list[l.index + 1].type, l.list[l.index + 1].text], [r.result.blockId, 'paragraph', '']);
  });
  once(db, 'block.split', { blockId: 'h', text: '決めたこと', at: 2, rich: [{ t: '決め', m: ['b'] }, { t: 'たこと', m: ['b'] }] }, (p, r) => {
    const l = find(p, 'h');
    assert.deepStrictEqual([l.b.type, l.b.level, l.b.text], ['heading', 2, '決め'], '前半は見出しのまま');
    const nb = l.list[l.index + 1];
    assert.deepStrictEqual([nb.id, nb.type, nb.text, nb.rich], [r.result.blockId, 'paragraph', 'たこと', [{ t: 'たこと', m: ['b'] }]], '後半はテキスト（飾りは続きのまま）');
  });
  once(db, 'block.split', { blockId: 'h', text: '決めたこと', at: 0 }, (p, r) => {
    const l = find(p, 'h');
    assert.deepStrictEqual([l.b.id, l.b.type, l.b.text], ['h', 'heading', '決めたこと'], '見出しの ID と文はそのまま');
    assert.deepStrictEqual([l.list[l.index - 1].id, l.list[l.index - 1].type, l.list[l.index - 1].text], [r.result.blockId, 'paragraph', ''], '上の空の行がテキストでない');
  });
}, { blocks: [kid('x'), { id: 'h', type: 'heading', level: 2, text: '決めたこと', citeState: 'manual', cites: [] }, kid('y')] }));

test('NX-1・F205（BQ32 の「Enter と同じ」）: 見出しの途中で貼った後ろの文の行はテキスト。oplog の1行・edit.revert の1回で戻る', T, () => withDb((db) => {
  once(db, 'block.paste', { blockId: 'h', rich: [{ t: '決めたこと', m: [] }], at: 2, blocks: [{ type: 'paragraph', rich: [{ t: '貼った', m: [] }] }] }, (p) => {
    const l = find(p, 'h');
    assert.deepStrictEqual(l.list.slice(l.index, l.index + 3).map((b) => [b.type, b.text]), [['heading', '決め'], ['paragraph', '貼った'], ['paragraph', 'たこと']]);
  });
}, { blocks: [{ id: 'h', type: 'heading', level: 2, text: '決めたこと', citeState: 'manual', cites: [] }, kid('y')] }));

test('NX-1・F205（S5・B-24・X-31）: コールアウトの block.split（inside）は、文の末尾・途中・子のあるコールアウトのどれも最初の子にテキスト。oplog の1行・edit.revert の1回で戻る', T, () => withDb((db) => {
  once(db, 'block.split', { blockId: 'c', text: 'お知らせ', at: 4, inside: true }, (p, r) => {
    assert.deepStrictEqual(find(p, 'c').b.children.map((b) => [b.id === r.result.blockId, b.type, b.text]), [[true, 'paragraph', '']]);
  });
  once(db, 'block.split', { blockId: 'c', text: 'お知らせ', at: 2, inside: true }, (p) => {
    assert.deepStrictEqual([find(p, 'c').b.text, find(p, 'c').b.children.map((b) => [b.type, b.text])], ['お知', [['paragraph', 'らせ']]]);
  });
  once(db, 'block.split', { blockId: 'ck', text: '子あり', at: 3, inside: true }, (p) => {
    assert.deepStrictEqual(find(p, 'ck').b.children.map((b) => [b.type, b.text]), [['paragraph', ''], ['paragraph', 'k1の文']], '子のあるコールアウトの新しい行が最初の子でない');
  });
}, { blocks: [kid('x'), { id: 'c', type: 'callout', icon: '💡', text: 'お知らせ', citeState: 'manual', cites: [] }, { id: 'ck', type: 'callout', icon: '💡', text: '子あり', citeState: 'manual', cites: [], children: [kid('k1')] }] }));

test('NX-1（S12・B-26・OQ3「今のままチェックなし（おすすめ）」）: 文のある箇条書き・ToDo の頭の Enter は上に同じ型の空の行。上の空の ToDo はチェックなしで、担当・期限・出典・タスクの印を写さない', T, () => withDb((db) => {
  once(db, 'block.split', { blockId: 'b2', text: '来月の予算案の作成を担当Aが進める', at: 0 }, (p, r) => {
    const l = find(p, 'b2');
    assert.deepStrictEqual([l.list[l.index - 1].id, l.list[l.index - 1].type, l.list[l.index - 1].text], [r.result.blockId, 'bullet', '']);
  });
  once(db, 'block.split', { blockId: 'b4', text: '見積書を月末までに先方へ送る', at: 0 }, (p, r) => {
    const l = find(p, 'b4');
    const nb = l.list[l.index - 1];
    assert.deepStrictEqual([nb.id, nb.type, nb.text, nb.checked, nb.assignee, nb.due, nb.dueRaw, nb.cites, nb.task], [r.result.blockId, 'todo', '', false, undefined, undefined, undefined, [], undefined]);
    assert.deepStrictEqual([l.b.checked, l.b.assignee, l.b.task], [true, '担当A', 'r1'], '元の ToDo が変わった');
  });
}, { blocks: samplePage('pa1').page.blocks.map((b) => (b.id === 'b4' ? { ...b, checked: true, task: 'r1' } : b)) }));
