/* stage180.app.test.js — 0.18.0（計画 docs/plans/2026-11-18-180.md）の画面
 *  CU-1（決めたこと 48〜51・F234・F244）: Claude が書いたら画面に知らせて［戻す］・ページの「···」の［Claude の変更を戻す］（#claudePop）・印
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせ、命令は本物の preload から一時の DB に本当に通す（helpers/realapp.js）。
 * Claude の書き込みは役 mcp の命令を同じ DB へ直に通し（扉と同じ actor claude）、main が窓へ送る claude:wrote（DB の知らせの pageIds と what）を l.fire で渡す。
 * 会議の題名は titleAt（D77）。白紙のページ・データベース・行の題名と本文は作った物。人の名前は置き名（担当A など）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const core = require('../src/db/core');
const { realApp } = require('./helpers/realapp');
const { samplePage } = require('./helpers/dbtmp');

const T = { timeout: 60000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const open = async (l, id) => { l.fire('onPageOpen', id); await l.drain(120); };
const clickEl = async (l, el, n = 120) => { el.dispatchEvent({ type: 'click' }); await l.drain(n); };
const toastOf = (l) => $(l, 'toast').textContent;
const toastBtn = (l) => $(l, 'toast').querySelector('button');
const rowsOf = (l) => $(l, 'pNote').querySelectorAll('.blk');
const rowOf = (l, id) => rowsOf(l).find((e) => e.dataset.id === id);
const txtOf = (l, id) => rowOf(l, id).querySelector('.txt');
const moreItems = (l) => $(l, 'pMenu').querySelectorAll('.mitem').map((b) => b.textContent);
const moreItem = (l, label) => $(l, 'pMenu').querySelectorAll('.mitem').find((b) => b.textContent === label);
const popRows = (l) => $(l, 'claudeList').querySelectorAll('.tprow');
const popBtns = (l) => $(l, 'claudeList').querySelectorAll('button');
const active = (l) => l.document.activeElement;
const UNDO_ITEM = 'Claude の変更を戻す';
const LOST = 'Claude が書き換えたので、打ちかけの文は入りませんでした';
const NOTE = 'Claude が書き換える前の形を、ページごとに 10 回分まで PC の中に残しています';

// Claude の書き込み（役 mcp。扉と同じ actor claude）。時刻は決まった時刻（控えの at になる）。答えの changed は main が窓へ送る形（claude:wrote）
let txn = 0;
function claude(l, cmd, args, at) {
  const r = core.call(l.db, { role: 'mcp', cmd, args, tx: `c:cu1-${String(++txn).padStart(6, '0')}` }, { now: () => new Date(at), labels: {} });
  assert.strictEqual(r.ok, true, `${cmd}: ${r.code}`);
  return { result: r.result, wrote: r.changed ? { pageIds: r.changed.pageIds, what: r.changed.what } : null };
}
const revOf = (l, id) => l.db.prepare('select rev from blocks where id = ?').get(id).rev;
// 控えの時刻の見せる形（画面と同じく、この PC の時間帯の 月/日 時:分）
const hm = (iso) => { const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const AT1 = '2026-11-18T01:20:00.000Z';
const AT2 = '2026-11-18T01:31:00.000Z';
const AT3 = '2026-11-18T01:45:00.000Z';
const SUM_MD = '## 決めたこと\n- 予算案は来月に回す';

// 見本: 議事録 pm1（要約・ToDo・発言。担当A の名前）・白紙のページ（本文に1行）・データベース「名簿」と行1つ（本文に1行）
async function seeded() {
  return realApp({
    seed: (t) => { const { page, segments } = samplePage('pm1'); t.seed(page, segments); },
    before: (call) => {
      const B = call('page.create', {}).id;
      call('page.setTitle', { id: B, title: '白紙の見本' });   // 白紙のページの題名（D77 の外。試しの字）
      const bb = call('block.insert', { pageId: B, afterBlockId: '', type: 'paragraph' }).blockId;
      call('block.update', { pageId: B, blockId: bb, patch: { text: '白紙の一行' } });
      const D = call('db.create', {}).id;
      call('db.setTitle', { db: D, title: '名簿' });   // データベースの題名（D77 の外）
      const c1 = call('col.add', { db: D, type: 'text', name: '場所' }).col.id;   // 列の名前（試しの字）
      const R = call('row.add', { db: D, title: '一', cells: { [c1]: '所一' } }).id;   // 行の題名（D77 の外）
      const rb = call('block.insert', { pageId: R, afterBlockId: '', type: 'paragraph' }).blockId;
      call('block.update', { pageId: R, blockId: rb, patch: { text: '行の一行' } });
      return { B, bb, D, c1, R };
    },
  });
}
// 議事録 pm1 に Claude の書き込みを3つ（ToDo の更新 → 名前の直し → 要約の書き戻し）。それぞれの窓への知らせを返す
function threeWrites(l) {
  const a = claude(l, 'mcp.updateAction', { pageId: 'pm1', blockId: 'b4', done: true }, AT1);
  const n = claude(l, 'mcp.fixNames', { pageId: 'pm1', pairs: [{ from: '担当A', to: '担当B' }] }, AT2);
  const s = claude(l, 'mcp.writeSummary', { pageId: 'pm1', baseRev: revOf(l, 'pm1'), md: SUM_MD }, AT3);
  const c = n.result.counts;
  return { a, n, s, count: c.summary + c.memo + c.transcript + c.assignee + c.people };
}

// ---------------------------------------------------------------- 知らせと読み直し（決めたこと 49・F244）
test('CU-1・F244: 開いている議事録に claude:wrote → 読み直して Claude の要約を描き、左下に「Claude が「題名」を書き換えました（要約を書き戻した）」と［戻す］。プロパティの行に「🤖 要約: Claude（本人）」', T, async () => {
  const l = await seeded();
  try {
    await open(l, 'pm1');
    const title = l.call('page.get', { id: 'pm1' }).page.title;
    const s = claude(l, 'mcp.writeSummary', { pageId: 'pm1', baseRev: revOf(l, 'pm1'), md: SUM_MD }, AT3);
    assert.deepStrictEqual(s.wrote, { pageIds: ['pm1'], what: 'summary' }, '前提: DB の知らせの形');
    l.fire('onClaudeWrote', s.wrote); await l.drain(200);
    assert.ok(rowsOf(l).some((e) => e.textContent.includes('予算案は来月に回す')), `読み直していない: ${rowsOf(l).map((e) => e.textContent)}`);
    assert.strictEqual(toastOf(l), `Claude が「${title}」を書き換えました（要約を書き戻した）戻す`);
    assert.strictEqual(toastBtn(l) && toastBtn(l).textContent, '戻す', '左下の知らせに［戻す］が無い');
    // 決めたこと 51: プロパティの行の札（頭の 🤖 は .ic に包む字のまま）
    const prop = $(l, 'pProps').querySelectorAll('.prop').find((r) => r.querySelector('.k').textContent.endsWith(' 要約'));
    assert.ok(prop, 'プロパティの行に「要約」が無い');
    assert.deepStrictEqual([prop.querySelector('.ic').textContent, prop.querySelector('.k').textContent, prop.querySelector('.v').textContent], ['🤖', '🤖 要約', 'Claude（本人）']);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・F244: 打ちかけの文は送ってから（flushEdits と答えを待つ）読み直す。Claude が行を作り直していて書けなければ「Claude が書き換えたので、打ちかけの文は入りませんでした」と［戻す］。書ける行の打ちかけは入る', T, async () => {
  const l = await seeded();
  try {
    // 議事録: 要約の行 b2 に打ちかけ（まだ保存していない）→ Claude が要約を書き戻す（行を作り直す）
    await open(l, 'pm1');
    txtOf(l, 'b2').focus();
    txtOf(l, 'b2').textContent = '打ちかけの文';
    const s = claude(l, 'mcp.writeSummary', { pageId: 'pm1', baseRev: revOf(l, 'pm1'), md: SUM_MD }, AT3);
    l.fire('onClaudeWrote', s.wrote); await l.drain(200);
    assert.strictEqual(toastOf(l), `${LOST}戻す`);
    assert.ok(!JSON.stringify(l.call('page.get', { id: 'pm1' }).page.blocks).includes('打ちかけの文'), '前提: 打ちかけの文が DB に入った');
    assert.ok(rowsOf(l).some((e) => e.textContent.includes('予算案は来月に回す')), '読み直していない');
    // 白紙のページ: 本文の行に打ちかけ → Claude が最後に書き足す（今の行は変えない）→ 打ちかけは入り、知らせは「書き換えました（本文に書き足した）」
    const { B, bb } = l.made;
    await open(l, B);
    txtOf(l, bb).focus();
    txtOf(l, bb).textContent = '白紙の一行に足した';
    const a = claude(l, 'mcp.appendPage', { pageId: B, md: '- 書き足した行' }, AT3);
    l.fire('onClaudeWrote', a.wrote); await l.drain(200);
    const blocks = l.call('page.get', { id: B }).page.blocks;
    assert.deepStrictEqual(blocks.map((b) => b.text), ['白紙の一行に足した', '書き足した行'], '打ちかけの文が入らない');
    assert.deepStrictEqual(rowsOf(l).map((e) => e.querySelector('.txt').textContent), ['白紙の一行に足した', '書き足した行'], '読み直していない');
    assert.strictEqual(toastOf(l), 'Claude が「白紙の見本」を書き換えました（本文に書き足した）戻す');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・F244: 開いているデータベースの表（白紙のページの本文の表）は、Claude が行を足したら描き直す。知らせは「Claude が「名簿」に行を足しました」と［開く］（足した行のページが開く）', T, async () => {
  const l = await seeded();
  try {
    // 白紙のページの本文の表（データベース「本文の表」。知らせの pageIds に白紙のページは入らない）
    const P = l.call('page.create', {}).id;
    const pb = l.call('block.insert', { pageId: P, afterBlockId: '', type: 'paragraph' }).blockId;
    const I = l.call('db.create', { parentId: P, inline: pb }).id;
    l.call('db.setTitle', { db: I, title: '本文の表' });   // データベースの題名（D77 の外）
    await open(l, P);
    const host = () => $(l, 'pNote').querySelector('.dbhost');
    assert.ok(host(), '前提: 本文に表が無い');
    const add = claude(l, 'mcp.addRow', { db: I, title: '二' }, AT3);   // 行の題名（D77 の外）
    assert.strictEqual(add.wrote.what, 'addRow');
    assert.ok(!add.wrote.pageIds.includes(P), '前提: 知らせに白紙のページが入っている');
    l.fire('onClaudeWrote', add.wrote); await l.drain(200);
    assert.ok(host().querySelectorAll('.dbrow').some((r) => r.dataset.id === add.result.id), '開いている表を描き直していない');
    assert.strictEqual(toastOf(l), 'Claude が「本文の表」に行を足しました開く');
    // データベースのページを開いているとき（その表）も同じ。［開く］で足した行のページが開く
    const { D } = l.made;
    await open(l, D);
    const add2 = claude(l, 'mcp.addRow', { db: D, title: '三' }, AT3);   // 行の題名（D77 の外）
    l.fire('onClaudeWrote', add2.wrote); await l.drain(200);
    assert.ok($(l, 'pDb').querySelectorAll('.dbrow').some((r) => r.dataset.id === add2.result.id), 'データベースのページの表を描き直していない');
    assert.strictEqual(toastOf(l), 'Claude が「名簿」に行を足しました開く');
    await clickEl(l, toastBtn(l), 200);
    assert.strictEqual($(l, 'pTitle').textContent, '三', '［開く］で足した行のページが開かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1: Claude がページを作った知らせ「Claude が「題名」を作りました」の［開く］で、そのページが開く', T, async () => {
  const l = await seeded();
  try {
    await open(l, 'pm1');
    const c = claude(l, 'mcp.createPage', { title: '次回の議題（試し）', md: '- 一つ目' }, AT3);   // 白紙のページの題名（D77 の外。試しの字）
    assert.deepStrictEqual(c.wrote, { pageIds: [c.result.id], what: 'create' });
    l.fire('onClaudeWrote', c.wrote); await l.drain(200);
    assert.strictEqual(toastOf(l), 'Claude が「次回の議題（試し）」を作りました開く');
    await clickEl(l, toastBtn(l), 200);
    assert.strictEqual($(l, 'pTitle').textContent, '次回の議題（試し）', '［開く］で作ったページが開かない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 「···」の［Claude の変更を戻す］（決めたこと 50・F244）
test('CU-1・F244: 控えの無いページの「···」は今と同じ項目。控えのあるページ（議事録・白紙のページ・行のページ）だけ［削除］の前に［Claude の変更を戻す］', T, async () => {
  const l = await seeded();
  try {
    const { B, R, D, c1 } = l.made;
    const itemsOf = async (id) => { await open(l, id); await clickEl(l, $(l, 'pMore'), 40); const v = moreItems(l); l.key({ key: 'Escape' }, active(l)); await l.drain(); return v; };
    const before = {};
    for (const id of ['pm1', B, R, D]) {
      before[id] = await itemsOf(id);
      assert.ok(!before[id].includes(UNDO_ITEM), `控えの無いページ ${id} の「···」に［Claude の変更を戻す］`);
    }
    claude(l, 'mcp.updateAction', { pageId: 'pm1', blockId: 'b4', done: true }, AT1);
    claude(l, 'mcp.appendPage', { pageId: B, md: '- 書き足した行' }, AT1);
    claude(l, 'mcp.updateRow', { id: R, cells: { 場所: '所二' } }, AT1);
    assert.ok(c1);
    for (const id of ['pm1', B, R]) {
      const want = [...before[id]];
      want.splice(want.indexOf('削除'), 0, UNDO_ITEM);
      assert.deepStrictEqual(await itemsOf(id), want, `控えのあるページ ${id} の「···」`);
    }
    assert.deepStrictEqual(await itemsOf(D), before[D], 'データベースのページの「···」が変わった');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・F234: #claudePop の行（時刻・道具の言葉・数。新しい順）・説明・［この前に戻す］の名前。描くのは textContent。↑↓ で移り、変換中の Esc では閉じず、Esc で閉じてフォーカスが「···」へ', T, async () => {
  const l = await seeded();
  try {
    const w = threeWrites(l);
    await open(l, 'pm1');
    await clickEl(l, $(l, 'pMore'), 40);
    await clickEl(l, moreItem(l, UNDO_ITEM), 200);
    const pop = $(l, 'claudePop');
    assert.strictEqual(pop.hidden, false, '窓が開かない');
    assert.strictEqual(pop.getAttribute('role'), 'dialog');
    assert.strictEqual($(l, pop.getAttribute('aria-labelledby')).textContent, UNDO_ITEM, '窓の見出し');
    assert.strictEqual($(l, 'claudeNote').textContent, NOTE);
    const lines = popRows(l).map((r) => r.querySelector('.tpt').textContent);
    assert.deepStrictEqual(lines, [`${hm(AT3)} 要約を書き戻した`, `${hm(AT2)} 名前を直した（${w.count} か所）`, `${hm(AT1)} ToDo を更新した`]);
    assert.ok(w.count > 0, '前提: 名前を直した数');
    for (const r of popRows(l)) for (const n of [r, ...r.querySelectorAll('*')]) assert.strictEqual(n._html, undefined, 'innerHTML で描いた');
    assert.deepStrictEqual(popBtns(l).map((b) => [b.textContent, b.getAttribute('aria-label')]),
      [['この前に戻す', `${hm(AT3)} の要約を書き戻した前の形に戻す`], ['この前に戻す', `${hm(AT2)} の名前を直した前の形に戻す`], ['この前に戻す', `${hm(AT1)} のToDo を更新した前の形に戻す`]]);
    assert.strictEqual(active(l), popBtns(l)[0], '開くと1つ目の［この前に戻す］にフォーカス');
    l.key({ key: 'ArrowDown' }, $(l, 'claudeList')); await l.drain();
    assert.strictEqual(active(l), popBtns(l)[1], '↓ で次へ');
    l.key({ key: 'ArrowUp' }, $(l, 'claudeList')); await l.drain();
    assert.strictEqual(active(l), popBtns(l)[0], '↑ で前へ');
    l.key({ key: 'Escape', isComposing: true }, $(l, 'claudeList')); await l.drain();
    assert.strictEqual(pop.hidden, false, '変換中の Esc で閉じた');
    l.key({ key: 'Escape', keyCode: 229 }, $(l, 'claudeList')); await l.drain();
    assert.strictEqual(pop.hidden, false, '変換中（229）の Esc で閉じた');
    l.key({ key: 'Escape' }, $(l, 'claudeList')); await l.drain();
    assert.strictEqual(pop.hidden, true, 'Esc で閉じない');
    assert.strictEqual(active(l), $(l, 'pMore'), 'Esc で閉じたらフォーカスが「···」へ戻らない');
    assert.deepStrictEqual(l.called('pageClaudeRevert'), [], '開いて閉じただけで戻した');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・F234: ［この前に戻す］→ 後で直した所がある控え（later）は確かめの文が違う。いいえで呼ばない・はいで pageClaudeRevert(id, sid) の1回 → 読み直して「戻しました」', T, async () => {
  const l = await seeded();
  try {
    threeWrites(l);
    const snaps = l.call('page.claudeSnaps', { id: 'pm1' });
    assert.deepStrictEqual(snaps.map((s) => s.later), [false, true, true], '前提: 新しい控えだけ後の書き込みが無い');
    await open(l, 'pm1');
    const asked = [];
    let yes = false;
    l.window.confirm = (m) => { asked.push(m); return yes; };
    const openPop = async () => { await clickEl(l, $(l, 'pMore'), 40); await clickEl(l, moreItem(l, UNDO_ITEM), 200); };
    await openPop();
    await clickEl(l, popBtns(l)[0]);
    await clickEl(l, popBtns(l)[1]);
    assert.deepStrictEqual(asked, [
      `Claude が${hm(AT3)}に要約を書き戻した前の形に戻します。よろしいですか？`,
      `Claude が${hm(AT2)}に名前を直した前の形に戻します。この後の Claude の変更と、あなたの直しも戻ります。よろしいですか？`,
    ]);
    assert.deepStrictEqual(l.called('pageClaudeRevert'), [], 'いいえで戻した');
    assert.strictEqual($(l, 'claudePop').hidden, false, 'いいえで窓が閉じた');
    yes = true;
    await clickEl(l, popBtns(l)[1], 240);
    assert.deepStrictEqual(l.called('pageClaudeRevert').map((c) => c.args), [['pm1', snaps[1].sid]], 'はいで戻す命令が1回でない');
    assert.strictEqual($(l, 'claudePop').hidden, true, '戻したら窓を閉じる');
    assert.strictEqual(toastOf(l), '戻しました');
    // 名前を直す前の形（要約の書き戻しも戻る: その後の控え）。画面も読み直した
    const page = l.call('page.get', { id: 'pm1' }).page;
    assert.ok(page.blocks.some((b) => b.assignee === '担当A') && !JSON.stringify(page.blocks).includes('予算案は来月に回す'), '名前を直す前の形に戻らない');
    assert.ok(rowsOf(l).some((e) => e.dataset.id === 'b2'), '画面を読み直していない');
    // 残った控えは1つ（ToDo の更新）
    await openPop();
    assert.deepStrictEqual(popRows(l).map((r) => r.querySelector('.tpt').textContent), [`${hm(AT1)} ToDo を更新した`]);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・F244: 左下の知らせの［戻す］は、そのページの一番新しい控えで確かめを通して戻す', T, async () => {
  const l = await seeded();
  try {
    await open(l, 'pm1');
    const s = claude(l, 'mcp.writeSummary', { pageId: 'pm1', baseRev: revOf(l, 'pm1'), md: SUM_MD }, AT3);
    l.fire('onClaudeWrote', s.wrote); await l.drain(200);
    const sid = l.call('page.claudeSnaps', { id: 'pm1' })[0].sid;
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); return true; };
    await clickEl(l, toastBtn(l), 240);
    assert.deepStrictEqual(asked, [`Claude が${hm(AT3)}に要約を書き戻した前の形に戻します。よろしいですか？`]);
    assert.deepStrictEqual(l.called('pageClaudeRevert').map((c) => c.args), [['pm1', sid]]);
    assert.ok(rowsOf(l).some((e) => e.dataset.id === 'b2'), '戻した形を描いていない');
    assert.strictEqual(toastOf(l), '戻しました');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- 0.14.0 の元に戻す（F244）
test('CU-1・F244: 0.14.0 の Ctrl+Z: 自分で直した要約の行を Claude が書き戻した後に戻すと stale（何も変えず「ほかの所で変わったので、元に戻せませんでした」）', T, async () => {
  const l = await seeded();
  try {
    await open(l, 'pm1');
    const t = txtOf(l, 'b2');
    t.focus();
    t.textContent = '自分で直した文';
    t.onblur();
    await l.drain(120);
    assert.ok(l.call('page.get', { id: 'pm1' }).page.blocks.some((b) => b.text === '自分で直した文'), '前提: 直した文が保存されない');
    const s = claude(l, 'mcp.writeSummary', { pageId: 'pm1', baseRev: revOf(l, 'pm1'), md: SUM_MD }, AT3);
    l.fire('onClaudeWrote', s.wrote); await l.drain(200);
    const before = JSON.stringify(l.call('page.get', { id: 'pm1' }).page.blocks);
    const row = rowsOf(l)[0];
    row.querySelector('.txt').focus();
    l.key({ key: 'z', code: 'KeyZ', ctrlKey: true }, row.querySelector('.txt')); await l.drain(200);
    assert.strictEqual(toastOf(l), 'ほかの所で変わったので、元に戻せませんでした');
    assert.strictEqual(JSON.stringify(l.call('page.get', { id: 'pm1' }).page.blocks), before, '古い歩みで Claude の要約を戻した');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- CH-1（決めたこと 52）
test('CH-1: 設定のカード「Claude との連携（MCP）」の頭の1行と、吹き出しの2行（決めたこと 52）。行の名前「Claude デスクトップから読む」と注意の1行は今のまま', T, async () => {
  const l = await seeded();
  try {
    const card = $(l, 'mcpCard');
    const lead = card.querySelector('.setlead').querySelectorAll('.desc').map((d) => d.textContent);
    assert.deepStrictEqual(lead, ['Claude デスクトップから議事録を読み、頼んだときは書き戻せるようにします。', '※ 読んだ議事録は Claude（Anthropic）へ送られます。']);
    const items = $(l, 'setPopMcp').querySelectorAll('li').map((li) => li.textContent);
    assert.deepStrictEqual(items.slice(0, 3), [
      'Claude は、頼んだときだけ、要約の書き戻し・名前の直し・ToDo とタスクの更新・白紙のページへの書き込み・データベースへの行の追加をします（消すことはしません）。書き換えは、ページの「···」の［Claude の変更を戻す］で戻せます。',
      'NaTsu を閉じている間は、Claude は読むだけで、書けません。',
      'Claude に頼むと、Claude が読んだ議事録の題名・要約・メモ・文字起こしは、Claude（Anthropic）へ送られます（オフラインモードで録った会議も同じです）。',
    ]);
    assert.ok(!items.some((t) => t.includes('読むだけで、書き換えません')), '前の文が残る');
    assert.ok(card.querySelector('[data-row="Claude デスクトップから読む"]'), '行の名前「Claude デスクトップから読む」が無い');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
