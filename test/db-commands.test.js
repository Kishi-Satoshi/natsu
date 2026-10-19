/* db-commands.test.js — 第2a1回 ST4・ST6・ST11・F6: 行 ⇄ ページと画面の命令 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpDb, jsonTwin, samplePage } = require('./helpers/dbtmp');   // jsonTwin: 一時フォルダの store.js と json-backend。seed は同じ JSON をそのまま書く
const core = require('../src/db/core');

const NOW = () => new Date('2026-10-19T01:02:03.000Z');
let n = 0;
const call = (db, cmd, args, role = 'app') => core.call(db, { role, cmd, args, tx: `${role[0]}:t-${String(++n).padStart(6, '0')}` }, { now: NOW, labels: { groq: 'Groq（無料枠）' } });
// updatedAt・rev・id の作り方の違いと、DB だけが付ける空の children（2a1 は子のない木）だけを落として比べる
const plain = (v) => JSON.parse(JSON.stringify(v, (k, x) => (['updatedAt', 'rev', 'blockId'].includes(k) || (k === 'children' && Array.isArray(x) && x.length === 0) ? undefined : x)));

test('ST4: 画面の 14 の命令は json-backend（今の保存）と同じ答え', { timeout: 5000 }, async () => {
  const t = tmpDb(); const j = jsonTwin();
  try {
    const { db } = t.open();
    // 見出し・箇条書き（出典あり・短い行）・ToDo（担当・期限）・経路・一時停止の印・知らない欄 extraField。page の中に segments は入れない
    const { page, segments } = samplePage('pa1');
    t.seed(page, segments);           // putPageRows で入れる（会議の印 meeting を足さない。比べを同じ JSON から始める）
    await j.seed(page, segments);
    const steps = [
      ['page.get', { id: 'pa1' }], ['page.setTitle', { id: 'pa1', title: '直した題' }], ['page.setMemo', { id: 'pa1', memo: 'メモ' }],
      ['page.setType', { id: 'pa1', type: 'oneonone' }], ['block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '書き換えた要点の文' } }],
      ['block.update', { pageId: 'pa1', blockId: 'b4', patch: { checked: true } }], ['block.move', { pageId: 'pa1', blockId: 'b1', toIndex: 2 }],
      ['block.setAction', { pageId: 'pa1', blockId: 'b4', assignee: ' 担当B ', dueRaw: '来週の金曜' }], ['block.remove', { pageId: 'pa1', blockId: 'b3' }],
      ['segment.update', { pageId: 'pa1', segId: 's1', patch: { text: '直した発言' } }], ['pages.actionView', {}], ['page.get', { id: 'nope' }],
    ];
    for (const [cmd, args] of steps) {
      const r = call(db, cmd, args);
      assert.strictEqual(r.ok, true, `${cmd} ${r.code}`);
      assert.deepStrictEqual(plain(r.result), plain(await j.call(cmd, args)), cmd);
    }
    const ins = call(db, 'block.insert', { pageId: 'pa1', afterBlockId: 'b2', type: 'bullet' });
    assert.deepStrictEqual(ins.result.page.blocks.map((b) => b.type), (await j.call('page.get', { id: 'pa1' })).page.blocks.map((b) => b.type).toSpliced(1, 0, 'bullet'));
    assert.strictEqual(call(db, 'page.get', { id: 'pa1' }).result.page.routeText[0], '☁ 文字起こし: クラウド（Groq（無料枠））3');
  } finally { t.done(); j.done(); }
});

test('F6: page.put は baseRev が今の rev と違えば conflict（画面の直しを古い写しで上書きしない）。ブロックだけの直しでも rev が上がる。rev と routeText は保存しない', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    t.seed(samplePage('pa1').page, []);
    const p = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
    assert.ok(Number.isInteger(p.rev) && Array.isArray(p.routeText));
    call(db, 'page.setTitle', { id: 'pa1', title: '画面で直した' });
    const r = call(db, 'page.put', { page: { ...p, summaryError: '要約の文' }, baseRev: p.rev }, 'main');
    assert.deepStrictEqual([r.ok, r.code, r.retry], [false, 'conflict', true]);
    assert.strictEqual(call(db, 'page.get', { id: 'pa1' }).result.page.title, '画面で直した');
    const p2 = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
    call(db, 'block.update', { pageId: 'pa1', blockId: 'b2', patch: { text: '画面で直した行' } });
    assert.strictEqual(call(db, 'page.put', { page: { ...p2, summaryError: 'x' }, baseRev: p2.rev }, 'main').code, 'conflict', 'ブロックの直しで rev が上がらない（要約が行の直しを消す）');
    const p3 = call(db, 'page.get', { id: 'pa1' }, 'main').result.page;
    assert.strictEqual(call(db, 'page.put', { page: { ...p3, summaryError: 'y' }, baseRev: p3.rev }, 'main').ok, true);
    const attrs = JSON.parse(db.prepare("select attrs from blocks where id='pa1'").get().attrs);
    assert.ok(!('rev' in attrs) && !('routeText' in attrs), 'DB が作る欄を attrs に保存した');
    assert.strictEqual(call(db, 'page.put', { page: { ...p, id: 'gone' }, baseRev: 1 }, 'main').result, null, '無いページを作った（要約中に消したページが戻る）');
  } finally { t.done(); }
});

test('Q2: page.delete はゴミ箱へ（一覧と検索から消え、行は残り、oplog は trash）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    t.seed(samplePage('pa1').page, []);
    assert.deepStrictEqual(call(db, 'page.delete', { id: 'pa1' }).result, []);
    assert.strictEqual(call(db, 'page.get', { id: 'pa1' }).result, null);
    assert.ok(db.prepare("select trashed_at from blocks where id='pa1'").get().trashed_at);
    assert.strictEqual(JSON.parse(db.prepare("select ops from oplog where action='page.delete'").get().ops)[0].op, 'trash');
  } finally { t.done(); }
});

test('ST11: よく使う問い合わせに表全体の走査が無い（EXPLAIN QUERY PLAN）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    for (const [name, sql] of Object.entries(require('../src/db/commands').HOT_QUERIES)) {
      const plan = db.prepare(`explain query plan ${sql}`).all(...new Array((sql.match(/\?/g) || []).length).fill('x')).map((r) => r.detail).join(' / ');
      assert.ok(!/\bSCAN (blocks|segments|oplog)\b/.test(plan), `${name}: ${plan}`);
    }
  } finally { t.done(); }
});

// 計画の表に足した確かめ: 読むときは決まった名前（列の値）を attrs の後に置く。attrs に古い id・title・type・text・rev が
// 紛れていても（素の SQL で書いた行・後の版の行）、列の値が勝つ（変異 db-view-order: attrs を最後に広げると赤）
test('ST3: 読む形は attrs を先に広げ、id・title・rev・ブロックの type・text は列の値', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    db.exec(`insert into blocks(id, type, page_id, ord, text, attrs, rev) values
      ('pv1', 'page', 'pv1', 'i', '列の題', '{"id":"px","title":"古い題","rev":99,"memo":"メモ"}', 3),
      ('bv1', 'bullet', 'pv1', 'a0', '列の文', '{"id":"bx","type":"todo","text":"古い文","children":[1]}', 1)`);
    const p = call(db, 'page.get', { id: 'pv1' }).result.page;
    assert.deepStrictEqual([p.id, p.title, p.rev, p.memo], ['pv1', '列の題', 3, 'メモ']);
    assert.deepStrictEqual([p.blocks[0].id, p.blocks[0].type, p.blocks[0].text, p.blocks[0].children], ['bv1', 'bullet', '列の文', []]);
  } finally { t.done(); }
});
