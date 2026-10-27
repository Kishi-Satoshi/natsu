/*
 * stage130.edit.db.test.js — 0.13.0 第1部の DB の命令と照らし（計画 docs/plans/2026-10-24-130.md の Task ED-2）
 * 分割・結合・型の変換・複製・行の後ろへ動かす。1つの動作＝1つの命令＝1つのトランザクション＝ oplog の1行（持ち主の試作の tx）。
 * 画面の役の型は決まった表（BLOCK_TYPES）だけを通す。一時の DB（helpers/dbtmp.js）で core.call を本当に呼ぶ。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { tmpDb, jsonTwin, samplePage } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const R = require('../src/pagerules');

const NOW = () => new Date('2026-10-26T01:02:03.000Z');
let n = 0;
const txOf = (role) => `${role[0]}:ed2-${String(++n).padStart(6, '0')}`;
const call = (db, cmd, args, role = 'app', tx = txOf(role)) => core.call(db, { role, cmd, args, tx }, { now: NOW, labels: {} });
const get = (db, id = 'pa1') => call(db, 'page.get', { id }).result.page;
const oplogN = (db) => db.prepare('select count(*) as c from oplog').get().c;
const T = { timeout: 5000 };

function withDb(fn, patch = {}) {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const { page, segments } = samplePage('pa1');
    t.seed({ ...page, ...patch }, segments);
    return fn(db, t);
  } finally { t.done(); }
}

// ---------------------------------------------------------------- 分割（F40・F41）
test('ED-2・F40: block.split は送られた text で分け、前を今の行・後ろを新しい行（すぐ下）にする。DB の古い文は使わない', T, () => withDb((db) => {
  const r = call(db, 'block.split', { pageId: 'pa1', blockId: 'b2', text: '画面で打った途中の文です', at: 6 });
  assert.strictEqual(r.ok, true, r.code);
  const ids = r.result.page.blocks.map((b) => b.id);
  const nb = r.result.blockId;
  assert.strictEqual(ids.indexOf(nb), ids.indexOf('b2') + 1);
  const by = (id) => r.result.page.blocks.find((b) => b.id === id);
  assert.deepStrictEqual([by('b2').text, by(nb).text], ['画面で打った', '途中の文です']);
  assert.strictEqual(by(nb).type, 'bullet');
  // 見出しの後ろは箇条書き（EQ5 (a)）・ToDo の後ろは ToDo（担当・期限を持たない）
  const h = call(db, 'block.split', { pageId: 'pa1', blockId: 'b1', text: '決めたこと', at: 5 });
  assert.strictEqual(h.result.page.blocks.find((b) => b.id === h.result.blockId).type, 'bullet');
  const td = call(db, 'block.split', { pageId: 'pa1', blockId: 'b4', text: '見積書を月末までに先方へ送る', at: 3 });
  const tn = td.result.page.blocks.find((b) => b.id === td.result.blockId);
  assert.deepStrictEqual([tn.type, tn.text, tn.assignee, tn.due, tn.dueRaw, tn.checked], ['todo', 'を月末までに先方へ送る', undefined, undefined, undefined, false]);
}));

test('ED-2・F40: at がサロゲートペアの間・文の長さより大きい・負 → bad-args で何も変えない', T, () => withDb((db) => {
  const before = JSON.stringify(get(db).blocks);
  const n0 = oplogN(db);
  for (const at of [1, 9, -1, 1.5]) {
    const r = call(db, 'block.split', { pageId: 'pa1', blockId: 'b2', text: '𠮷野家の件', at });
    assert.deepStrictEqual([r.ok, r.code], [false, 'bad-args'], String(at));
  }
  assert.strictEqual(JSON.stringify(get(db).blocks), before);
  assert.strictEqual(oplogN(db), n0, '断った命令が oplog に残った');
  assert.strictEqual(call(db, 'block.split', { pageId: 'pa1', blockId: 'b2', text: '𠮷野家の件', at: 2 }).ok, true);
}));

test('ED-2・F41: split・merge・turnInto・duplicate・move（afterId）のどれも oplog はちょうど1行。同じ (役, tx) を2回送ると行は1つだけ増え、答えは同じ blockId', T, () => withDb((db) => {
  const cases = [
    ['block.split', { pageId: 'pa1', blockId: 'b2', text: '来月の予算案の作成', at: 4 }],
    ['block.merge', { pageId: 'pa1', blockId: 'b3', text: '了解' }],
    ['block.turnInto', { pageId: 'pa1', blockId: 'b5', type: 'numbered' }],
    ['block.duplicate', { pageId: 'pa1', blockId: 'b6' }],
    ['block.move', { pageId: 'pa1', blockId: 'b1', afterId: 'b4' }],
  ];
  for (const [cmd, args] of cases) {
    const n0 = oplogN(db);
    const len0 = get(db).blocks.length;
    const tx = txOf('app');
    const r1 = call(db, cmd, args, 'app', tx);
    assert.strictEqual(r1.ok, true, `${cmd} ${r1.code}`);
    assert.strictEqual(oplogN(db), n0 + 1, `${cmd}: oplog が1行でない`);
    const len1 = get(db).blocks.length;
    const r2 = call(db, cmd, args, 'app', tx);
    assert.strictEqual(r2.ok, true, cmd);
    assert.strictEqual(r2.dup, true, `${cmd}: 送り直しが新しい命令として効いた`);
    assert.strictEqual(oplogN(db), n0 + 1, cmd);
    assert.strictEqual(get(db).blocks.length, len1, `${cmd}: 送り直しで行が増えた・減った`);
    if (cmd === 'block.split' || cmd === 'block.duplicate') {
      assert.strictEqual(len1, len0 + 1, cmd);
      assert.strictEqual(r2.result.blockId, r1.result.blockId, `${cmd}: 送り直しの答えの blockId が違う`);
    }
    if (cmd === 'block.merge') assert.deepStrictEqual([r2.result.blockId, r2.result.at], [r1.result.blockId, r1.result.at]);
  }
}));

// 2026-10-26 の持ち主の答え（点検1「上に空の行を足す（おすすめ）」）: 文のある行の頭（at 0）の Enter は、上に空の行（型は EQ5 (a)）を足し、
// 今の行は ID・文・担当・期限・チェック・出典・citeState をそのまま残す。空の行の at 0 は今どおり（下に足す）
test('ED-2・点検1: 文のある行の頭（at 0）で block.split → 上に空の行を足し、今の行は ID・文・担当・期限・チェック・出典・citeState がそのまま。空の行は今どおり下に足す', T, () => withDb((db) => {
  const keep = (b) => ({ id: b.id, type: b.type, text: b.text, assignee: b.assignee, due: b.due, dueRaw: b.dueRaw, checked: b.checked, cites: b.cites, citeState: b.citeState, mark: b.mark });
  const was = get(db).blocks.find((b) => b.id === 'b4');
  const r = call(db, 'block.split', { pageId: 'pa1', blockId: 'b4', text: was.text, at: 0 });
  assert.strictEqual(r.ok, true, r.code);
  const ids = r.result.page.blocks.map((b) => b.id);
  const nb = r.result.page.blocks.find((b) => b.id === r.result.blockId);
  assert.strictEqual(ids.indexOf(nb.id), ids.indexOf('b4') - 1, '足した行が今の行の上に無い');
  assert.deepStrictEqual([nb.type, nb.text, nb.checked, nb.citeState, nb.cites, nb.assignee], ['todo', '', false, 'manual', [], undefined]);
  assert.deepStrictEqual(keep(r.result.page.blocks.find((b) => b.id === 'b4')), keep(was));
  // 見出しの頭: 上に足す行は EQ5 (a) の型（箇条書き）。見出しはそのまま
  const h = call(db, 'block.split', { pageId: 'pa1', blockId: 'b1', text: '決めたこと', at: 0 });
  const hb = h.result.page.blocks;
  assert.deepStrictEqual([hb[0].id === h.result.blockId, hb[0].type, hb[0].text], [true, 'bullet', '']);
  assert.deepStrictEqual([hb[1].id, hb[1].type, hb[1].text, hb[1].citeState], ['b1', 'heading', '決めたこと', undefined]);
  // 空の行の at 0 は今どおり、下に足す
  const e = call(db, 'block.split', { pageId: 'pa1', blockId: h.result.blockId, text: '', at: 0 });
  const eb = e.result.page.blocks.map((b) => b.id);
  assert.strictEqual(eb.indexOf(e.result.blockId), eb.indexOf(h.result.blockId) + 1);
}, { blocks: samplePage('pa1').page.blocks.map((b) => (b.id === 'b4' ? { ...b, citeState: 'linked', checked: true } : b)) }));

// ---------------------------------------------------------------- 結合
test('ED-2: merge は今の行の文を前の文のある行の後ろにつなぎ、答えの at がつないだ所。前が区切り線なら区切り線だけを消す。頭の行では何もしない', T, () => withDb((db) => {
  const r = call(db, 'block.merge', { pageId: 'pa1', blockId: 'b3', text: '画面の文' });
  assert.strictEqual(r.ok, true, r.code);
  const b2 = r.result.page.blocks.find((b) => b.id === 'b2');
  assert.strictEqual(b2.text, '来月の予算案の作成を担当Aが進める画面の文');
  assert.deepStrictEqual([r.result.blockId, r.result.at], ['b2', '来月の予算案の作成を担当Aが進める'.length]);
  assert.ok(!r.result.page.blocks.some((b) => b.id === 'b3'));
  // 区切り線の次の行の頭: 区切り線だけを消し、今の行は残る
  const d = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'b5', type: 'divider' });
  assert.deepStrictEqual([d.ok, d.code], [false, 'bad-args'], '文のある行を区切り線にできた');
  const ins = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b4', type: 'divider' });
  assert.strictEqual(ins.ok, true, ins.code);
  const dv = ins.result.blockId;
  const m2 = call(db, 'block.merge', { pageId: 'pa1', blockId: 'b5', text: '次回は来週' });
  assert.strictEqual(m2.ok, true, m2.code);
  const ids = m2.result.page.blocks.map((b) => b.id);
  assert.ok(!ids.includes(dv), '区切り線が消えていない');
  assert.ok(ids.includes('b5'), '区切り線の次の行まで消した');
  assert.strictEqual(m2.result.page.blocks.find((b) => b.id === 'b5').text, '次回は来週');
  assert.deepStrictEqual([m2.result.blockId, m2.result.at], ['b5', 0]);
  // 頭の行
  const top = call(db, 'block.merge', { pageId: 'pa1', blockId: 'b1', text: '決めたこと' });
  assert.strictEqual(top.ok, true);
  assert.deepStrictEqual([top.result.blockId, top.result.at], ['b1', 0]);
  assert.strictEqual(top.result.page.blocks[0].id, 'b1');
}));

// ---------------------------------------------------------------- 型の変換（F44・F46）
test('ED-2・F44: turnInto で箇条書き → 番号付き → 箇条書きにすると cites・assignee・due・mark・citeState が元のまま。見出しの level は 1〜3 だけ', T, () => withDb((db) => {
  const pick = (b) => ({ cites: b.cites, assignee: b.assignee, due: b.due, dueRaw: b.dueRaw, checked: b.checked, mark: b.mark, citeState: b.citeState });
  const was = get(db).blocks.find((b) => b.id === 'b4');
  for (const type of ['numbered', 'bullet', 'quote', 'todo']) assert.strictEqual(call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'b4', type }).ok, true, type);
  const now = get(db).blocks.find((b) => b.id === 'b4');
  assert.deepStrictEqual(pick(now), pick(was));
  const h = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'b2', type: 'heading', level: 3 });
  assert.strictEqual(h.result.blocks.find((b) => b.id === 'b2').level, 3);
  for (const level of [0, 4, 2.5, '2']) assert.deepStrictEqual(call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'b2', type: 'heading', level }).code, 'bad-args', String(level));
  assert.strictEqual(call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'b2', type: 'callout' }).result.blocks.find((b) => b.id === 'b2').icon, '💡');
}, { blocks: samplePage('pa1').page.blocks.map((b) => (b.id === 'b4' ? { ...b, mark: 'memo', citeState: 'linked' } : b)) }));

test('ED-2・F46: citeState の無い行（AI のテキストの行・見出し）を箇条書きにすると citeState manual になり、citeStat の分母に入らない。見出しの段 2 → 段 3 では citeState を付けない', T, () => withDb((db) => {
  const stat0 = R.citeStatOf(get(db).blocks);
  const p = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'bp', type: 'bullet' });
  const bp = p.result.blocks.find((b) => b.id === 'bp');
  assert.strictEqual(bp.citeState, 'manual');
  assert.deepStrictEqual(R.citeStatOf(p.result.blocks), stat0, '型を変えた AI の行が出典の分母に入った');
  const h = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'b1', type: 'heading', level: 3 });
  assert.strictEqual(h.result.blocks.find((b) => b.id === 'b1').citeState, undefined, '見出しの段の付け替えで citeState を付けた');
  const hb = call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'b1', type: 'bullet' });
  assert.strictEqual(hb.result.blocks.find((b) => b.id === 'b1').citeState, 'manual');
}, { blocks: [...samplePage('pa1').page.blocks, { id: 'bp', type: 'paragraph', text: 'AI の書いた段落' }] }));

// ---------------------------------------------------------------- 型の照らし（決めたこと 9）
test('ED-2: 画面の役の block.insert・turnInto・update の型は BLOCK_TYPES だけ（numbered は通る・video・../x は bad-args）。main の役の page.put は知らない型も今どおり通す', T, () => withDb((db) => {
  assert.strictEqual(call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b1', type: 'numbered' }).ok, true);
  assert.strictEqual(call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b1', type: 'heading', level: 1 }).result.page.blocks[1].level, 1);
  for (const type of ['video', '../x', 'toggle', 'page']) {
    assert.strictEqual(call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b1', type }).code, 'bad-args', `insert ${type}`);
    assert.strictEqual(call(db, 'block.turnInto', { pageId: 'pa1', blockId: 'b2', type }).code, 'bad-args', `turnInto ${type}`);
    assert.strictEqual(call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { type } }).code, 'bad-args', `update ${type}`);
  }
  for (const icon of ['🔥', 'x', '💡💡']) assert.strictEqual(call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b1', type: 'callout', icon }).code, 'bad-args', icon);
  assert.strictEqual(call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b1', type: 'callout', icon: '💡' }).ok, true);
  const p = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
  const put = call(db, 'page.put', { page: { ...p, blocks: [...p.blocks, { id: 'bv1', type: 'video', text: '新しい版が書いた型' }] }, baseRev: p.rev }, 'main');
  assert.strictEqual(put.ok, true, put.code);
  assert.strictEqual(get(db).blocks.find((b) => b.id === 'bv1').type, 'video');
}));

// ---------------------------------------------------------------- 鍵（F44）
test('ED-2・F44: 要約の欄の鍵（録音中の写し・要約待ち・まだ作っていない）のページでは新しい命令がどれも locked', T, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    assert.strictEqual(call(db, 'meeting.begin', { pageId: 'pl1', startedAt: Date.parse('2026-10-26T01:00:00.000Z') }, 'main').ok, true);
    const { page, segments } = samplePage('pw1');
    t.seed({ ...page, summaryWait: true, summaryError: '要約待ち（つながったら作ります）' }, segments);
    const p2 = samplePage('pn1');
    t.seed({ ...p2.page, blocks: [], route: { stt: { cloud: 1, local: 0, provider: 'openai' } } }, p2.segments);
    for (const [pageId, blockId] of [['pl1', 'bx1'], ['pw1', 'b2'], ['pn1', 'bx1']]) {
      for (const [cmd, args] of [['block.split', { text: 'ab', at: 1 }], ['block.merge', { text: 'ab' }], ['block.turnInto', { type: 'numbered' }],
        ['block.duplicate', {}], ['block.move', { afterId: '' }]]) {
        const r = call(db, cmd, { pageId, blockId, ...args });
        assert.deepStrictEqual([r.ok, r.code], [false, 'locked'], `${pageId} ${cmd}`);
      }
    }
    assert.strictEqual(get(db, 'pw1').blocks.length, 6);
  } finally { t.done(); }
});

// ---------------------------------------------------------------- 印と出典（決めたこと 13）
test('ED-2: split・merge は文が変わるので citeState を stale（manual は manual）にし、0.11.0 の mark・unconfirmed を消す。分けた後ろの行は citeState manual・cites 空で、担当・期限を持たない', T, () => withDb((db) => {
  const s = call(db, 'block.split', { pageId: 'pa1', blockId: 'b2', text: '未確認: 予算（B）の件', at: 4 });
  const by = (id) => s.result.page.blocks.find((b) => b.id === id);
  assert.deepStrictEqual([by('b2').citeState, by('b2').mark, by('b2').unconfirmed], ['stale', undefined, undefined]);
  assert.deepStrictEqual([by(s.result.blockId).citeState, by(s.result.blockId).cites, by(s.result.blockId).mark], ['manual', [], undefined]);
  const m = call(db, 'block.merge', { pageId: 'pa1', blockId: 'b3', text: '了解' });
  const b2 = m.result.page.blocks.find((b) => b.id === 'b2');
  assert.deepStrictEqual([b2.citeState, b2.cites], ['stale', ['s2']], '結合したときの出典は前の行のもの');
  const mm = call(db, 'block.merge', { pageId: 'pa1', blockId: 'b6', text: '共有する' });
  const b5 = mm.result.page.blocks.find((b) => b.id === 'b5');
  assert.strictEqual(b5.citeState, 'manual', 'manual の行が stale になった');
  assert.strictEqual(b5.mark, undefined);
  // 文の変わらない分割（行の終わりで Enter）では印を残す
  const e = call(db, 'block.split', { pageId: 'pa1', blockId: 'b4', text: '見積書を月末までに先方へ送る', at: '見積書を月末までに先方へ送る'.length });
  assert.strictEqual(e.result.page.blocks.find((b) => b.id === 'b4').citeState, 'linked');
}, { blocks: samplePage('pa1').page.blocks.map((b) => (b.id === 'b2' ? { ...b, mark: 'check', unconfirmed: true, citeState: 'linked' }
  : b.id === 'b4' ? { ...b, citeState: 'linked' } : b.id === 'b5' ? { ...b, citeState: 'manual', mark: 'memo' } : b)) }));

// ---------------------------------------------------------------- 動かす（F46）
test('ED-2: block.move の afterId は、その行のすぐ後ろに入る（toIndex の形も今どおり）。afterId が同じページに無い → bad-args', T, () => withDb((db) => {
  const ids = (r) => (r.result.page || r.result).blocks.map((b) => b.id);
  assert.deepStrictEqual(ids(call(db, 'block.move', { pageId: 'pa1', blockId: 'b1', afterId: 'b4' })), ['b2', 'b3', 'b4', 'b1', 'b5', 'b6']);
  assert.deepStrictEqual(ids(call(db, 'block.move', { pageId: 'pa1', blockId: 'b6', afterId: '' })), ['b6', 'b2', 'b3', 'b4', 'b1', 'b5']);
  assert.deepStrictEqual(ids(call(db, 'block.move', { pageId: 'pa1', blockId: 'b6', toIndex: 5 })), ['b2', 'b3', 'b4', 'b1', 'b5', 'b6']);
  assert.strictEqual(call(db, 'block.move', { pageId: 'pa1', blockId: 'b1', afterId: 'bnone' }).code, 'bad-args');
  assert.strictEqual(call(db, 'block.move', { pageId: 'pa1', blockId: 'b1' }).code, 'bad-args', 'afterId も toIndex も無い');
  // 複製の afterId（Alt を押しながら落とす: ED-6）
  const d = call(db, 'block.duplicate', { pageId: 'pa1', blockId: 'b2', afterId: 'b5' });
  assert.strictEqual(ids(d)[ids(d).indexOf('b5') + 1], d.result.blockId);
  const dup = d.result.page.blocks.find((b) => b.id === d.result.blockId);
  const src = d.result.page.blocks.find((b) => b.id === 'b2');
  assert.deepStrictEqual({ ...dup, id: 'x' }, { ...src, id: 'x' }, '複製は印ごと写す');
}));

// ---------------------------------------------------------------- preload と json-backend（決めたこと 14）
test('ED-2: preload の APP_COMMANDS は役 app の命令と同じ集まり・koeApp.blockSplit などは dbCall の1回で、書く命令には tx が付く。json-backend に block.split を送ると unknown-cmd', T, async () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const m = /const APP_COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(SRC);
  const names = [...m[1].matchAll(/'([\w.]+)'/g)].map((x) => x[1]);
  for (const c of ['block.split', 'block.merge', 'block.turnInto', 'block.duplicate']) {
    assert.ok(names.includes(c), c);
    assert.ok(core.COMMANDS[c].roles.includes('app'), c);
  }
  const exposed = {}; const on = {};
  const sandbox = { require: (n) => (n === 'electron' ? { contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { on: (ch, f) => { on[ch] = f; }, invoke: () => Promise.resolve(), send: () => {} } } : require(n)),
    crypto: { randomUUID: () => '12345678-1234-1234-1234-123456789abc' }, setTimeout, clearTimeout, console, Event, EventTarget };
  vm.runInNewContext(SRC, sandbox);
  const sent = [];
  const port = new EventTarget(); port.postMessage = (msg) => sent.push(structuredClone(msg)); port.start = () => {}; port.close = () => {};
  on['db:port']({ ports: [port] });
  exposed.koeApp.blockSplit('pa1', 'b2', '打った文', 2);
  exposed.koeApp.blockMerge('pa1', 'b3', '了解');
  exposed.koeApp.blockTurnInto('pa1', 'b2', 'heading', 3);
  exposed.koeApp.blockDuplicate('pa1', 'b2');
  exposed.koeApp.blockMove('pa1', 'b2', { afterId: 'b4' });
  exposed.koeApp.blockMove('pa1', 'b2', 3);
  assert.deepStrictEqual(sent.map((x) => [x.cmd, x.args]), [
    ['block.split', { pageId: 'pa1', blockId: 'b2', text: '打った文', at: 2 }], ['block.merge', { pageId: 'pa1', blockId: 'b3', text: '了解' }],
    ['block.turnInto', { pageId: 'pa1', blockId: 'b2', type: 'heading', level: 3 }], ['block.duplicate', { pageId: 'pa1', blockId: 'b2' }],
    ['block.move', { pageId: 'pa1', blockId: 'b2', afterId: 'b4' }], ['block.move', { pageId: 'pa1', blockId: 'b2', toIndex: 3 }]]);
  assert.ok(sent.every((x) => /^a:/.test(x.tx)), '書く命令に tx が無い');
  const j = jsonTwin();
  try {
    const { page, segments } = samplePage('pa1');
    await j.seed(page, segments);
    await assert.rejects(j.call('block.split', { pageId: 'pa1', blockId: 'b2', text: 'ab', at: 1 }), /unknown-cmd/);
  } finally { j.done(); }
});

// ---------------------------------------------------------------- F6 のまま（持ち主の試作の行ごとの版）
test('ED-2（F6 のまま）: page.get の後に block.split を通すと rev が上がり、前の rev を baseRev にした page.put は conflict で、分けた2行が残る', T, () => withDb((db) => {
  const p = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
  const s = call(db, 'block.split', { pageId: 'pa1', blockId: 'b2', text: '来月の予算案の作成を担当Aが進める', at: 5 });
  assert.strictEqual(s.ok, true);
  assert.ok(get(db).rev > p.rev);
  const put = call(db, 'page.put', { page: { ...p, summaryError: '古い写しの要約' }, baseRev: p.rev }, 'main');
  assert.deepStrictEqual([put.ok, put.code], [false, 'conflict']);
  const ids = get(db).blocks.map((b) => b.id);
  assert.ok(ids.includes('b2') && ids.includes(s.result.blockId));
}));
