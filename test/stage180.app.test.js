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
async function seeded(returns) {
  return realApp({
    ...(returns ? { returns } : {}),
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

// 点検 3（CR106）で意図して直した: pageClaudeRevert に確かめた時のページの版（rev）を渡す（id, sid, rev）
test('CU-1・F234: ［この前に戻す］→ 後で直した所がある控え（later）は確かめの文が違う。いいえで呼ばない・はいで pageClaudeRevert(id, sid, rev) の1回 → 読み直して「戻しました」', T, async () => {
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
    assert.deepStrictEqual(l.called('pageClaudeRevert').map((c) => c.args), [['pm1', snaps[1].sid, snaps[1].rev]], 'はいで戻す命令が1回でない');
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
    const { sid, rev } = l.call('page.claudeSnaps', { id: 'pm1' })[0];
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); return true; };
    await clickEl(l, toastBtn(l), 240);
    assert.deepStrictEqual(asked, [`Claude が${hm(AT3)}に要約を書き戻した前の形に戻します。よろしいですか？`]);
    // 点検 3（CR106）で意図して直した: 確かめた時のページの版（rev）も渡す
    assert.deepStrictEqual(l.called('pageClaudeRevert').map((c) => c.args), [['pm1', sid, rev]]);
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

// ---------------------------------------------------------------- 点検 3（2026-11-23。CR106〜CR114。持ち主の決まり「実装中の確かめは Notion に合わせるかおすすめを選ぶ」）
const ASK = (at, words) => `Claude が${hm(at)}に${words}前の形に戻します。よろしいですか？`;
const ASK_LATER = (at, words) => `Claude が${hm(at)}に${words}前の形に戻します。この後の Claude の変更と、あなたの直しも戻ります。よろしいですか？`;
const BACK_BAD = 'Claude の変更を戻せませんでした。';
const openPop = async (l) => { await clickEl(l, $(l, 'pMore'), 40); await clickEl(l, moreItem(l, UNDO_ITEM), 200); };
const toasts = (l) => {
  const te = $(l, 'toast');
  let cur = te.textContent;
  const seen = [];
  Object.defineProperty(te, 'textContent', { configurable: true, get: () => cur, set: (v) => { cur = v; seen.push(String(v)); } });
  return seen;
};
const memoRow = (l, id) => $(l, 'pMemo').querySelectorAll('.blk').find((e) => e.dataset.id === id);
const segTxt = (l, id) => $(l, 'pScript').querySelectorAll('.seg').find((e) => e.dataset.seg === id).querySelector('.txt');

test('CU-1・点検 3・F234: 窓を開いている間に Claude が同じページに書いたら（claude:wrote）、窓の行を読み直して描き直す。前からある行の確かめは「後で直した所」の文', T, async () => {
  const l = await seeded();
  try {
    await open(l, 'pm1');
    const a = claude(l, 'mcp.updateAction', { pageId: 'pm1', blockId: 'b4', done: true }, AT1);
    l.fire('onClaudeWrote', a.wrote); await l.drain(200);
    await openPop(l);
    assert.deepStrictEqual(popRows(l).map((r) => r.querySelector('.tpt').textContent), [`${hm(AT1)} ToDo を更新した`], '前提: 窓の行');
    const n = claude(l, 'mcp.fixNames', { pageId: 'pm1', pairs: [{ from: '担当A', to: '担当B' }] }, AT2);
    l.fire('onClaudeWrote', n.wrote); await l.drain(200);
    assert.strictEqual($(l, 'claudePop').hidden, false, '窓が閉じた');
    assert.deepStrictEqual(popRows(l).map((r) => r.querySelector('.tpt').textContent.replace(/（\d+ か所）$/, '')), [`${hm(AT2)} 名前を直した`, `${hm(AT1)} ToDo を更新した`], '窓の行を読み直していない');
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); return false; };
    await clickEl(l, popBtns(l)[1]);
    assert.deepStrictEqual(asked, [ASK_LATER(AT1, 'ToDo を更新した')], '前からある行の確かめが「後で直した所」の文でない');
    assert.deepStrictEqual(l.called('pageClaudeRevert'), []);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3・F234: ［この前に戻す］は控えを読み直してから確かめる: 窓を開いた後に利用者が書いたら「後で直した所」の文。控えが無くなっていたら確かめずに「Claude の変更を戻せませんでした。」', T, async () => {
  const l = await seeded();
  try {
    claude(l, 'mcp.updateAction', { pageId: 'pm1', blockId: 'b4', done: true }, AT1);
    await open(l, 'pm1');
    await openPop(l);
    l.call('page.setTitle', { id: 'pm1', title: '後で付けた題' });   // 窓を開いた後にほかの所で書いた（D77 の外。試しの字）
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); return false; };
    await clickEl(l, popBtns(l)[0]);
    assert.deepStrictEqual(asked, [ASK_LATER(AT1, 'ToDo を更新した')], '開いた時の控えのまま確かめた');
    // 窓を開いている間に控えが無くなった（ほかの所で戻した）
    const sid = l.call('page.claudeSnaps', { id: 'pm1' })[0].sid;
    l.call('page.claudeRevert', { id: 'pm1', sid });
    await clickEl(l, popBtns(l)[0], 200);
    assert.strictEqual(asked.length, 1, '無い控えで確かめた');
    assert.deepStrictEqual(l.called('pageClaudeRevert'), [], '無い控えで戻す命令を送った');
    assert.strictEqual(toastOf(l), BACK_BAD);
    assert.strictEqual($(l, 'claudePop').hidden, true, '控えが無くなったのに窓を開いたまま');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3・F234: 確かめている間に Claude が書いたら、DB が古い版（rev）を stale で断り、読み直して「後で直した所」の文でもう一度確かめる（窓の［この前に戻す］と左下の［戻す］）', T, async () => {
  // 窓
  let l = await seeded();
  try {
    claude(l, 'mcp.updateAction', { pageId: 'pm1', blockId: 'b4', done: true }, AT1);
    await open(l, 'pm1');
    await openPop(l);
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); if (asked.length === 1) claude(l, 'mcp.fixNames', { pageId: 'pm1', pairs: [{ from: '担当A', to: '担当B' }] }, AT2); return true; };
    const sid = l.call('page.claudeSnaps', { id: 'pm1' })[0].sid;
    await clickEl(l, popBtns(l)[0], 300);
    assert.deepStrictEqual(asked, [ASK(AT1, 'ToDo を更新した'), ASK_LATER(AT1, 'ToDo を更新した')], '確かめの間の Claude の書き込みを言わずに戻した');
    const calls = l.called('pageClaudeRevert').map((c) => c.args);
    assert.deepStrictEqual(calls.map((c) => c.slice(0, 2)), [['pm1', sid], ['pm1', sid]]);
    assert.ok(calls.every((c) => Number.isSafeInteger(c[2])) && calls[0][2] !== calls[1][2], `確かめた版を渡していない: ${JSON.stringify(calls)}`);
    assert.strictEqual(toastOf(l), '戻しました');
    const page = l.call('page.get', { id: 'pm1' }).page;
    assert.ok(page.blocks.some((b) => b.id === 'b4' && b.checked === false && b.assignee === '担当A'), '戻っていない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
  // 左下の［戻す］
  l = await seeded();
  try {
    await open(l, 'pm1');
    const s = claude(l, 'mcp.writeSummary', { pageId: 'pm1', baseRev: revOf(l, 'pm1'), md: SUM_MD }, AT3);
    l.fire('onClaudeWrote', s.wrote); await l.drain(200);
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); if (asked.length === 1) claude(l, 'mcp.fixNames', { pageId: 'pm1', pairs: [{ from: '担当A', to: '担当B' }] }, AT2); return asked.length === 1; };
    await clickEl(l, toastBtn(l), 300);
    assert.deepStrictEqual(asked, [ASK(AT3, '要約を書き戻した'), ASK_LATER(AT3, '要約を書き戻した')], '確かめの間の Claude の書き込みを言わずに戻した');
    assert.strictEqual(l.called('pageClaudeRevert').length, 1, '2回目の確かめで「いいえ」なのに戻した');
    assert.ok(JSON.stringify(l.call('page.get', { id: 'pm1' }).page.blocks).includes('予算案は来月に回す'), '断ったのに戻した');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3・F244: メモの打ちかけは、Claude が直した今のメモの上に行ごとに載せて送る（Claude が直したほかの行を戻さない）。打っていた行を Claude が直していたら、Claude の文のままにして「…打ちかけの文は入りませんでした」', T, async () => {
  const l = await seeded();
  try {
    l.call('page.setMemoDoc', { id: 'pm1', doc: [{ id: 'm1', type: 'paragraph', text: '担当Aの議題' }, { id: 'm2', type: 'paragraph', text: '二つ目の行' }] });
    await open(l, 'pm1');
    $(l, 'paneBtnMemo').onclick(); await l.drain();
    const memoOf = () => l.call('page.get', { id: 'pm1' }).page.memoDoc.map((b) => [b.id, b.text]);
    // ほかの行の打ちかけ: Claude の直しの上に載る
    let t = memoRow(l, 'm2')._txt;
    t.focus(); t.textContent = '二つ目の行に足した';
    const n1 = claude(l, 'mcp.fixNames', { pageId: 'pm1', pairs: [{ from: '担当A', to: '担当B' }] }, AT2);
    assert.ok(n1.result.counts.memo > 0, '前提: メモを直した');
    l.fire('onClaudeWrote', n1.wrote); await l.drain(200);
    assert.deepStrictEqual(memoOf(), [['m1', '担当Bの議題'], ['m2', '二つ目の行に足した']], 'Claude が直したメモの行を戻した・打ちかけが入らない');
    assert.match(toastOf(l), /を書き換えました（名前を直した）戻す$/);
    // 打っていた行を Claude が直した: Claude の文のまま
    t = memoRow(l, 'm1')._txt;
    t.focus(); t.textContent = '担当Bの議題を直す';
    const n2 = claude(l, 'mcp.fixNames', { pageId: 'pm1', pairs: [{ from: '担当B', to: '担当C' }] }, AT3);
    l.fire('onClaudeWrote', n2.wrote); await l.drain(200);
    assert.deepStrictEqual(memoOf(), [['m1', '担当Cの議題'], ['m2', '二つ目の行に足した']], 'Claude が直した行を打ちかけで黙って上書きした');
    assert.strictEqual(toastOf(l), `${LOST}戻す`);
    assert.strictEqual(memoRow(l, 'm1')._txt.textContent, '担当Cの議題', '画面が Claude の文でない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3・F244: 要約の行・文字起こしの行の打ちかけを、Claude がその行の中で直していたら（名前の直し）、Claude の文のままにして「…打ちかけの文は入りませんでした」。直していない行の打ちかけは入る', T, async () => {
  const l = await seeded();
  try {
    await open(l, 'pm1');
    let t = txtOf(l, 'b2'); t.focus(); t.textContent = '来月の予算案の作成を担当Aが進める（確認）';
    t = txtOf(l, 'b3'); t.focus(); t.textContent = '了解しました';
    const n1 = claude(l, 'mcp.fixNames', { pageId: 'pm1', pairs: [{ from: '担当A', to: '担当B' }] }, AT2);
    l.fire('onClaudeWrote', n1.wrote); await l.drain(200);
    const textOf = (id) => l.call('page.get', { id: 'pm1' }).page.blocks.find((b) => b.id === id).text;
    assert.deepStrictEqual([textOf('b2'), textOf('b3')], ['来月の予算案の作成を担当Bが進める', '了解しました'], 'Claude が直した要約の行を打ちかけで上書きした・直していない行の打ちかけが入らない');
    assert.strictEqual(toastOf(l), `${LOST}戻す`);
    // 文字起こし
    $(l, 'paneBtnScript').onclick(); await l.drain();
    // 偽 DOM の focus・blur は受け口を呼ばないので、本物と同じく呼ぶ（直している印 .editing と、blur での保存）
    t = segTxt(l, 's2'); t.focus(); t.onfocus(); t.blur = () => t.onblur(); t.textContent = '来月の予算案の作成は担当Bさんが進めることにしました（追記）';
    const n2 = claude(l, 'mcp.fixNames', { pageId: 'pm1', pairs: [{ from: '担当B', to: '担当C' }] }, AT3);
    l.fire('onClaudeWrote', n2.wrote); await l.drain(200);
    const seg = l.call('page.get', { id: 'pm1' }).segments.find((x) => x.id === 's2').text;
    assert.strictEqual(seg, '来月の予算案の作成は担当Cさんが進めることにしました', 'Claude が直した発言を打ちかけで上書きした');
    assert.strictEqual(toastOf(l), `${LOST}戻す`);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3 の残り・CR115・F244: 行のページの題名の打ちかけを、Claude が update_database_row で題名を直していたら、Claude の題名のままにして「…打ちかけの文は入りませんでした」。題名を直していなければ打ちかけは入る', T, async () => {
  const l = await seeded();
  try {
    const { R } = l.made;
    const titleOf = () => l.call('page.get', { id: R }).page.title;
    await open(l, R);
    // セルだけを直した: 題名の打ちかけは入る
    $(l, 'pTitle').focus(); $(l, 'pTitle').textContent = '一の打ちかけ';
    const c = claude(l, 'mcp.updateRow', { id: R, cells: { 場所: '所二' } }, AT1);
    l.fire('onClaudeWrote', c.wrote); await l.drain(200);
    assert.strictEqual(titleOf(), '一の打ちかけ', '題名を直していないのに題名の打ちかけが入らない');
    assert.match(toastOf(l), /を書き換えました（行を直した）戻す$/);
    // 題名を直した: Claude の題名のまま
    $(l, 'pTitle').focus(); $(l, 'pTitle').textContent = '一の打ちかけを直す';
    // 行の題名（D77 の外。試しの字）
    const t = claude(l, 'mcp.updateRow', { id: R, title: '二' }, AT2);
    l.fire('onClaudeWrote', t.wrote); await l.drain(200);
    assert.strictEqual(titleOf(), '二', 'Claude が直した題名を打ちかけで黙って上書きした');
    assert.strictEqual(toastOf(l), `${LOST}戻す`);
    assert.strictEqual($(l, 'pTitle').textContent, '二', '画面の題名が Claude の題名でない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3: 打ちかけを送っている間に claude:wrote が続けて2つ来ても投げず、知らせはどちらも出る（1つずつ順に）', T, async () => {
  const l = await seeded();
  try {
    await open(l, 'pm1');
    const title = l.call('page.get', { id: 'pm1' }).page.title;
    const t = txtOf(l, 'b3'); t.focus(); t.textContent = '了解しました';
    const seen = toasts(l);
    const a = claude(l, 'mcp.updateAction', { pageId: 'pm1', blockId: 'b4', done: true }, AT1);
    const n = claude(l, 'mcp.fixNames', { pageId: 'pm1', pairs: [{ from: '担当A', to: '担当B' }] }, AT2);
    l.fire('onClaudeWrote', a.wrote);
    l.fire('onClaudeWrote', n.wrote);
    await l.drain(400);
    assert.deepStrictEqual(l.errors.map(fmt), [], '続けて来た知らせで投げた');
    assert.deepStrictEqual(seen, [`Claude が「${title}」を書き換えました（ToDo を更新した）`, `Claude が「${title}」を書き換えました（名前を直した）`]);
    assert.ok(l.call('page.get', { id: 'pm1' }).page.blocks.some((b) => b.id === 'b3' && b.text === '了解しました'), '打ちかけが入らない');
  } finally { l.done(); }
});

test('CU-1・点検 3: #claudePop の間は Ctrl+W・Ctrl+Tab・Ctrl+P・Ctrl+\\・Ctrl+Shift+N・Ctrl+Shift+U で後ろを替えない・閉じない・開かない（ゴミ箱の窓と同じ）。窓は説明を aria-describedby で指す（ゴミ箱の窓も）', T, async () => {
  const l = await seeded();
  try {
    const { B } = l.made;
    const K = l.call('page.create', { parentId: B }).id;   // 親のある白紙のページ（Ctrl+Shift+U で親へ移れる）
    claude(l, 'mcp.appendPage', { pageId: K, md: '- 書き足した行' }, AT1);
    await open(l, 'pm1');
    $(l, 'plist').querySelectorAll('.pitem').find((r) => r.dataset.pid === B).dispatchEvent({ type: 'click', ctrlKey: true }); await l.drain(120);
    await open(l, K);
    const tabs = () => $(l, 'tabbar').querySelectorAll('.tabitem').map((x) => x.dataset.key);
    const before = tabs();
    assert.strictEqual(before.length, 2, `前提: タブが2つ: ${before}`);
    const act0 = $(l, 'tabbar').querySelector('.tabitem.active').dataset.key;
    await openPop(l);
    assert.strictEqual($(l, 'claudePop').hidden, false, '前提: 窓');
    const side0 = $(l, 'sideExpand').hidden;
    const g0 = l.called('pageGet').length;
    for (const k of [{ key: 'w', code: 'KeyW', ctrlKey: true }, { key: 'Tab', code: 'Tab', ctrlKey: true }, { key: 'p', code: 'KeyP', ctrlKey: true }, { key: '\\', code: 'Backslash', ctrlKey: true },
      { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }, { key: 'U', code: 'KeyU', ctrlKey: true, shiftKey: true }]) { l.key(k); await l.drain(); }
    assert.deepStrictEqual(tabs(), before, '窓の後ろのタブを閉じた');
    assert.strictEqual($(l, 'tabbar').querySelector('.tabitem.active').dataset.key, act0, '窓の後ろのタブを替えた');
    assert.strictEqual($(l, 'palette').hidden, true, '窓の上に検索の窓を開いた');
    assert.strictEqual($(l, 'sideExpand').hidden, side0, '窓の後ろのサイドバーを畳んだ');
    assert.strictEqual($(l, 'newPop').hidden, true, '窓の間に「新しいページ」を開いた');
    assert.strictEqual(l.called('pageGet').length, g0, '窓の間にほかのページへ移った');
    assert.strictEqual($(l, 'claudePop').hidden, false, '窓が閉じた');
    assert.strictEqual($(l, $(l, 'claudePop').getAttribute('aria-describedby')).textContent, NOTE, '窓の説明を指していない');
    assert.strictEqual($(l, 'trashPop').getAttribute('aria-describedby'), 'trashNote', 'ゴミ箱の窓の説明を指していない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3・CR100: Claude の書き込みの読み直しで、見ていた欄（文字起こし・メモ）のまま', T, async () => {
  const l = await seeded();
  try {
    await open(l, 'pm1');
    $(l, 'paneBtnScript').onclick(); await l.drain();
    const a = claude(l, 'mcp.updateAction', { pageId: 'pm1', blockId: 'b4', done: true }, AT1);
    l.fire('onClaudeWrote', a.wrote); await l.drain(200);
    assert.strictEqual($(l, 'paneBtnScript').getAttribute('aria-selected'), 'true', '読み直しで［AI 要約］の欄へ移った');
    $(l, 'paneBtnMemo').onclick(); await l.drain();
    const n = claude(l, 'mcp.fixNames', { pageId: 'pm1', pairs: [{ from: '担当A', to: '担当B' }] }, AT2);
    l.fire('onClaudeWrote', n.wrote); await l.drain(200);
    assert.strictEqual($(l, 'paneBtnMemo').getAttribute('aria-selected'), 'true', '読み直しで［AI 要約］の欄へ移った');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3・CR102: 窓を開くときと左下の［戻す］は、打ちかけを送り終えてから控えを読む（窓: 行の文の保存の後に page.claudeSnaps・［戻す］: 確かめは「後で直した所」の文）', T, async () => {
  let l = await seeded();
  try {
    claude(l, 'mcp.updateAction', { pageId: 'pm1', blockId: 'b4', done: true }, AT1);
    await open(l, 'pm1');
    const t = txtOf(l, 'b3'); t.focus(); t.textContent = '了解しました';
    const c0 = l.calls.length;
    await openPop(l);
    const order = l.calls.slice(c0).map((c) => c.method).filter((m) => m === 'blockUpdate' || m === 'pageClaudeSnaps');
    assert.deepStrictEqual(order.slice(0, 2), ['blockUpdate', 'pageClaudeSnaps'], `打ちかけを送る前に控えを読んだ: ${order}`);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
  l = await seeded();
  try {
    await open(l, 'pm1');
    const s = claude(l, 'mcp.writeSummary', { pageId: 'pm1', baseRev: revOf(l, 'pm1'), md: SUM_MD }, AT3);
    l.fire('onClaudeWrote', s.wrote); await l.drain(200);
    const row = rowsOf(l)[1];
    const t = row.querySelector('.txt'); t.focus(); t.textContent = `${t.textContent}（直した）`;
    const asked = [];
    l.window.confirm = (m) => { asked.push(m); return false; };
    await clickEl(l, toastBtn(l), 240);
    assert.deepStrictEqual(asked, [ASK_LATER(AT3, '要約を書き戻した')], '打ちかけを送る前に控えを読んだ（あなたの直しも戻ることを言わない）');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3・CR98: 戻す命令が断られたら（Claude の変更を戻せないとき）、左下に「Claude の変更を戻せませんでした。」', T, async () => {
  const l = await seeded({ pageClaudeRevert: () => Promise.reject(new Error('bad-args')) });
  try {
    claude(l, 'mcp.updateAction', { pageId: 'pm1', blockId: 'b4', done: true }, AT1);
    await open(l, 'pm1');
    await openPop(l);
    l.window.confirm = () => true;
    await clickEl(l, popBtns(l)[0], 240);
    assert.strictEqual(l.called('pageClaudeRevert').length, 1, '前提: 戻す命令を送った');
    assert.strictEqual(toastOf(l), BACK_BAD);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3・CR103: 道具の印の無い知らせ（決まった8つの外の what）は、開いているページを読み直すだけで、左下に知らせを出さない', T, async () => {
  const l = await seeded();
  try {
    await open(l, 'pm1');
    const seen = toasts(l);
    const g0 = l.called('pageGet').length;
    l.fire('onClaudeWrote', { pageIds: ['pm1'], what: 'zzz' }); await l.drain(200);
    l.fire('onClaudeWrote', { pageIds: ['pm1'] }); await l.drain(200);
    assert.ok(l.called('pageGet').length > g0, '開いているページを読み直していない');
    assert.deepStrictEqual(seen, [], '道具の印の無い知らせで左下に出した');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3・CR96: 飾りのある行の打ちかけも、Claude が行を作り直していて書けなければ「…打ちかけの文は入りませんでした」', T, async () => {
  const l = await seeded();
  try {
    l.call('block.update', { pageId: 'pm1', blockId: 'b3', patch: { rich: [{ t: '了解', m: ['b'] }] } });
    await open(l, 'pm1');
    const t = txtOf(l, 'b3'); t.focus(); t.textContent = '了解しました';
    const s = claude(l, 'mcp.writeSummary', { pageId: 'pm1', baseRev: revOf(l, 'pm1'), md: SUM_MD }, AT3);
    l.fire('onClaudeWrote', s.wrote); await l.drain(200);
    assert.ok(l.called('blockUpdate').some((c) => c.args[1] === 'b3' && c.args[2] && Array.isArray(c.args[2].rich)), '前提: 飾りのある行の形（rich）で送った');
    assert.strictEqual(toastOf(l), `${LOST}戻す`);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('CU-1・点検 3・F234: #claudePop の Tab・Shift+Tab は窓の中で回る（最後の［この前に戻す］の次は最初・最初の前は最後）。控えが無くなっていたら窓を開かず「Claude の変更を戻せませんでした。」', T, async () => {
  const l = await seeded();
  try {
    threeWrites(l);
    await open(l, 'pm1');
    await openPop(l);
    const btns = popBtns(l);
    btns[2].focus();
    const e1 = l.key({ key: 'Tab' }, $(l, 'claudeList')); await l.drain();
    assert.ok(e1.defaultPrevented && active(l) === btns[0], '最後の次が最初でない');
    const e2 = l.key({ key: 'Tab', shiftKey: true }, $(l, 'claudeList')); await l.drain();
    assert.ok(e2.defaultPrevented && active(l) === btns[2], '最初の前が最後でない');
    l.key({ key: 'Escape' }, $(l, 'claudeList')); await l.drain();
    // ほかの所で全部戻した後に「···」の項目を押す
    const snaps = l.call('page.claudeSnaps', { id: 'pm1' });
    l.call('page.claudeRevert', { id: 'pm1', sid: snaps[snaps.length - 1].sid });
    await openPop(l);
    assert.strictEqual($(l, 'claudePop').hidden, true, '控えが無いのに窓を開いた');
    assert.strictEqual(toastOf(l), BACK_BAD, '控えが無くなっていたのに何も言わない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- CH-1（決めたこと 52）
// 0.18.0 点検 3（持ち主の答え AQ46「「行の追加と直し」に直す（おすすめ）」）で意図して直した: 吹き出しの1行目の「データベースへの行の追加」を「データベースへの行の追加と直し」に
test('CH-1: 設定のカード「Claude との連携（MCP）」の頭の1行と、吹き出しの2行（決めたこと 52）。行の名前「Claude デスクトップから読む」と注意の1行は今のまま', T, async () => {
  const l = await seeded();
  try {
    const card = $(l, 'mcpCard');
    const lead = card.querySelector('.setlead').querySelectorAll('.desc').map((d) => d.textContent);
    assert.deepStrictEqual(lead, ['Claude デスクトップから議事録を読み、頼んだときは書き戻せるようにします。', '※ 読んだ議事録は Claude（Anthropic）へ送られます。']);
    const items = $(l, 'setPopMcp').querySelectorAll('li').map((li) => li.textContent);
    assert.deepStrictEqual(items.slice(0, 3), [
      'Claude は、頼んだときだけ、要約の書き戻し・名前の直し・ToDo とタスクの更新・白紙のページへの書き込み・データベースへの行の追加と直しをします（消すことはしません）。書き換えは、ページの「···」の［Claude の変更を戻す］で戻せます。',
      'NaTsu を閉じている間は、Claude は読むだけで、書けません。',
      'Claude に頼むと、Claude が読んだ議事録の題名・要約・メモ・文字起こしは、Claude（Anthropic）へ送られます（オフラインモードで録った会議も同じです）。',
    ]);
    assert.ok(!items.some((t) => t.includes('読むだけで、書き換えません')), '前の文が残る');
    assert.ok(card.querySelector('[data-row="Claude デスクトップから読む"]'), '行の名前「Claude デスクトップから読む」が無い');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- XE-1（決めたこと 57・AQ10 (a)・AQ23 (a)・AQ24 (a)・F245）: Ctrl+Z のまとまりは約 0.5 秒と日本語入力の確定
const XFS = require('node:fs');
const XHTML = XFS.readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer', 'app.html'), 'utf8');
const TM = require('../src/typeMarks');
const UB = require('../src/undoBook');
const ZK = { key: 'z', code: 'KeyZ', ctrlKey: true };
const YK = { key: 'y', code: 'KeyY', ctrlKey: true };
// 白紙のページ（行は texts の数。空の文は空の行）を作って開く
async function xePage(l, texts) {
  const id = l.call('page.create', {}).id;
  l.call('page.setTitle', { id, title: '打つ見本' });   // 白紙のページの題名（D77 の外。試しの字）
  let after = '';
  const ids = [];
  for (const s of texts) {
    const b = l.call('block.insert', { pageId: id, afterBlockId: after, type: 'paragraph' }).blockId;
    if (s) l.call('block.update', { pageId: id, blockId: b, patch: { text: s } });
    ids.push(b); after = b;
  }
  await open(l, id);
  return { id, ids };
}
// 打つ（文を置いて input。ms だけ偽の時計を進める）
async function typeTo(l, t, s, ms = 0) {
  t.textContent = s; l.caret.set(t, s.length);
  t.dispatchEvent({ type: 'input' });
  await l.drain();
  if (ms) { await l.clock.advance(ms); await l.drain(); }
}
// 日本語入力で打って確定する（変換中の input は isComposing。確定の後に ms 進める）
async function imeTo(l, t, kana, word, ms = 0) {
  t.dispatchEvent({ type: 'compositionstart' });
  t.textContent = kana; l.caret.set(t, kana.length);
  t.dispatchEvent({ type: 'input', isComposing: true });
  await l.drain();
  t.textContent = word; l.caret.set(t, word.length);
  t.dispatchEvent({ type: 'input', isComposing: true });
  t.dispatchEvent({ type: 'compositionend' });
  await l.drain();
  if (ms) { await l.clock.advance(ms); await l.drain(); }
}
const rowIn = (l, pid, bid) => l.call('page.get', { id: pid }).page.blocks.find((b) => b.id === bid);
const press = async (l, k, bid) => { l.key(k, txtOf(l, bid)); await l.drain(200); };

test('XE-1・F245: typeMarks の写し（app.html）と undoBook の印の写しは src と同じ答え', () => {
  const at = XHTML.indexOf('  // ---- 0.18.0 XE-1（計画 docs/plans/2026-11-18-180.md の決めたこと 57・F245）: typeMarks の写し');
  const end = XHTML.indexOf('  // ---- typeMarks の写しはここまで');
  assert.ok(at > 0 && end > at, 'app.html に typeMarks の写しが無い');
  const app = new Function(`${XHTML.slice(at, end)}\nreturn { UNDO_PAUSE_MS, MARKS_MAX, markAdd, marksOf, stepBack, stepFwd };`)();   // eslint-disable-line no-new-func
  assert.deepStrictEqual([app.UNDO_PAUSE_MS, app.MARKS_MAX], [TM.UNDO_PAUSE_MS, TM.MARKS_MAX]);
  const runM = (M) => {
    const S = (text) => ({ text, rich: null, caret: text.length });
    let l = M.markAdd([], S(''), 0);
    const out = [];
    for (const [s, t, cut] of [['a', 100], ['ab', 400], ['abc', 1000], ['abc今', 1100, true], ['abc今日', 1200], ['abc今日', 1300, true], ['x', 9000]]) { l = M.markAdd(l, S(s), t, { cut }); out.push(M.marksOf(l)); }
    for (let i = 0; i < 70; i++) l = M.markAdd(l, S(`n${i}`), 20000 + i * 1000);
    out.push(l.length, M.marksOf(l)[1]);
    const e = { steps: ['a:1'], marks: M.marksOf(l).slice(0, 4), row: 'r', at: 3 };
    let b = M.stepBack(e); out.push(b);
    b = b && M.stepBack(b.entry); out.push(b, b && M.stepBack(b.entry), b && M.stepFwd(b.entry), M.stepFwd(e));
    return JSON.parse(JSON.stringify(out));
  };
  assert.deepStrictEqual(runM(app), runM(TM));
  const ub = XHTML.slice(XHTML.indexOf('  // ---- undoBook の写し'), XHTML.indexOf('  // ---- undoBook の写しはここまで'));
  const appB = new Function(`${ub}\nreturn { bookKey, bookPush, bookTakeUndo, bookTakeRedo, bookDone, bookMark, bookStepped };`)();   // eslint-disable-line no-new-func
  const runB = (B) => {
    const k = B.bookKey('p', 'note'); const M3 = [{ text: '' }, { text: 'a' }, { text: 'ab' }];
    let b = B.bookMark(B.bookPush({}, k, ['a:1']), k, M3, 'a:1', 'r');
    const log = [b];
    let t = B.bookTakeUndo(b, k); b = B.bookStepped(t.book, k, 'undo', { ...t.entry, at: 1, steps: ['a:1', 'a:2'] }); log.push(b);
    t = B.bookTakeRedo(b, k); b = B.bookStepped(t.book, k, 'redo', { ...b[k].undo[0], at: 2 }); log.push(b);
    t = B.bookTakeUndo(b, k); b = B.bookDone(t.book, k, 'undo', 'a:3', t.entry); log.push(b);
    t = B.bookTakeRedo(b, k); b = B.bookDone(t.book, k, 'redo', 'a:4', t.entry); log.push(b);
    log.push(B.bookMark(B.bookPush({}, k, [], { literal: { before: [], after: [] } }), k, M3, null, 'm'), B.bookMark(b, k, M3, 'a:x', 'r'));
    return JSON.parse(JSON.stringify(log));
  };
  assert.deepStrictEqual(runB(appB), runB(UB));
});

test('XE-1・F245: 「あいう」→ 0.6 秒 →「えお」→ 0.6 秒 →「かき」→ 2 秒（保存1回）→ Ctrl+Z で「あいうえお」「あいう」・もう一度で空・Ctrl+Y で「あいう」「あいうえお」「あいうえおかき」。保存の命令は今と同じ1回で、Ctrl+Z・Ctrl+Y の数だけ edit.textStep', T, async () => {
  const l = await seeded();
  try {
    const { id, ids: [e] } = await xePage(l, ['']);
    const t = txtOf(l, e); t.focus();
    await typeTo(l, t, 'あ', 100); await typeTo(l, t, 'あい', 100); await typeTo(l, t, 'あいう', 600);
    await typeTo(l, t, 'あいうえ', 100); await typeTo(l, t, 'あいうえお', 600);
    await typeTo(l, t, 'あいうえおか', 100); await typeTo(l, t, 'あいうえおかき', 1999);
    assert.strictEqual(l.called('blockUpdate').length, 0, '2 秒より前に保存した（保存の間合いが 0.5 秒）');
    await l.clock.advance(1); await l.drain();
    assert.strictEqual(l.called('blockUpdate').length, 1, '保存の命令が今と同じ1回でない');
    const text = () => rowIn(l, id, e).text;
    const seen = [];
    for (const k of [ZK, ZK, ZK, YK, YK, YK]) { await press(l, k, e); seen.push([text(), txtOf(l, e).textContent]); }
    assert.deepStrictEqual(seen.map((x) => x[0]), ['あいうえお', 'あいう', '', 'あいう', 'あいうえお', 'あいうえおかき'], '印ごとに戻る・進む');
    assert.deepStrictEqual(seen.map((x) => x[1]), seen.map((x) => x[0]), '画面の文が DB と違う');
    assert.deepStrictEqual([l.called('blockUpdate').length, l.called('editTextStep').length, l.called('editRevert').length], [1, 4, 2], '保存・印・戻しの命令の数');
    assert.strictEqual(active(l), txtOf(l, e), 'フォーカスが行に無い');
    // やり直した後も印で戻る
    await press(l, ZK, e);
    assert.strictEqual(text(), 'あいうえお');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('XE-1・F245: 変換中（compositionstart 〜 compositionend）は印を積まない（確定の前の字に戻らない）', T, async () => {
  const l = await seeded();
  try {
    const { id, ids: [e] } = await xePage(l, ['']);
    const t = txtOf(l, e); t.focus();
    await typeTo(l, t, 'abc', 100);
    t.dispatchEvent({ type: 'compositionstart' });
    t.textContent = 'abcきょう'; l.caret.set(t, 6);
    t.dispatchEvent({ type: 'input', isComposing: true });
    await l.drain(); await l.clock.advance(600); await l.drain();
    t.textContent = 'abc今日'; l.caret.set(t, 5);
    t.dispatchEvent({ type: 'input', isComposing: true });
    t.dispatchEvent({ type: 'compositionend' });
    await l.drain(); await l.clock.advance(2000); await l.drain();
    assert.strictEqual(rowIn(l, id, e).text, 'abc今日');
    await press(l, ZK, e);
    assert.strictEqual(rowIn(l, id, e).text, 'abc', '変換中の字（abcきょう）に戻った');
    await press(l, ZK, e);
    assert.strictEqual(rowIn(l, id, e).text, '');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('XE-1・F245: 確定ごとに戻る（AQ24 (a)）: 「今日は」を確定 →（0.5 秒より短く）「会議」を確定 → 保存 → Ctrl+Z で「今日は」・もう一度で空（変換の前のひらがなは通らない）。確定の印で保存の命令は増えない', T, async () => {
  const l = await seeded();
  try {
    const { id, ids: [e] } = await xePage(l, ['']);
    const t = txtOf(l, e); t.focus();
    await imeTo(l, t, 'きょうは', '今日は', 100);
    await imeTo(l, t, '今日はかいぎ', '今日は会議', 2000);
    assert.strictEqual(l.called('blockUpdate').length, 1, '確定の印で保存の命令が増えた');
    await press(l, ZK, e);
    assert.strictEqual(rowIn(l, id, e).text, '今日は', '確定ごとに戻らない');
    await press(l, ZK, e);
    assert.strictEqual(rowIn(l, id, e).text, '', 'ひらがなを通った・戻らない');
    assert.strictEqual(l.called('blockUpdate').length, 1);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('XE-1・F245: 改行・貼り付け・飾りは打った字と1回で（AQ23 (a)）: 「abc」→ すぐ Shift+Enter →「def」→ Ctrl+Z で空・「abc」→ すぐ1行の貼り付け「xyz」→ Ctrl+Z で空・「abc」を選んですぐ Ctrl+B → Ctrl+Z で空（太字も外れる）', T, async () => {
  const l = await seeded();
  try {
    const { id, ids: [r1, r2, r3] } = await xePage(l, ['', '', '']);
    // Shift+Enter
    let t = txtOf(l, r1); t.focus();
    await typeTo(l, t, 'abc', 100);
    l.key({ key: 'Enter', shiftKey: true }, t); await l.drain();
    assert.strictEqual(t.textContent, 'abc\n', '前提: 行の中の改行');
    await l.clock.advance(100); await l.drain();
    await typeTo(l, t, 'abc\ndef', 2000);
    assert.strictEqual(rowIn(l, id, r1).text, 'abc\ndef');
    await press(l, ZK, r1);
    assert.strictEqual(rowIn(l, id, r1).text, '', 'Shift+Enter で印を切った');
    // 1行の貼り付け
    t = txtOf(l, r2); t.focus();
    await typeTo(l, t, 'abc', 100);
    t.dispatchEvent({ type: 'paste', clipboardData: { getData: (k) => (k === 'text/plain' ? 'xyz' : '') }, preventDefault() {} });
    await l.drain(); await l.clock.advance(2000); await l.drain();
    assert.strictEqual(rowIn(l, id, r2).text, 'abcxyz');
    await press(l, ZK, r2);
    assert.strictEqual(rowIn(l, id, r2).text, '', '貼り付けで印を切った');
    // 飾り（Ctrl+B）
    t = txtOf(l, r3); t.focus();
    await typeTo(l, t, 'abc', 100);
    l.caret.set(t, 0, 3);
    l.key({ key: 'b', code: 'KeyB', ctrlKey: true }, t); await l.drain();
    await l.clock.advance(2000); await l.drain();
    assert.deepStrictEqual(rowIn(l, id, r3).rich, [{ t: 'abc', m: ['b'] }], '前提: 太字');
    await press(l, ZK, r3);
    assert.deepStrictEqual([rowIn(l, id, r3).text, rowIn(l, id, r3).rich || null], ['', null], '飾りで印を切った');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('XE-1・F245: 記法の変換は別の1回（今のまま）: 行の頭で「- 」→ 箇条書き →「abc」→ Ctrl+Z で空の箇条書き・もう一度でテキストの行の「- 」', T, async () => {
  const l = await seeded();
  try {
    const { id, ids: [e] } = await xePage(l, ['']);
    const t = txtOf(l, e); t.focus();
    await typeTo(l, t, '- ', 0);
    await l.drain(200);
    assert.strictEqual(rowIn(l, id, e).type, 'bullet', '前提: 箇条書き');
    const u = txtOf(l, e); u.focus();
    await typeTo(l, u, 'abc', 2000);
    assert.strictEqual(rowIn(l, id, e).text, 'abc');
    await press(l, ZK, e);
    assert.deepStrictEqual([rowIn(l, id, e).type, rowIn(l, id, e).text], ['bullet', ''], '1回目で空の箇条書きにならない');
    await press(l, ZK, e);
    assert.deepStrictEqual([rowIn(l, id, e).type, txtOf(l, e).textContent], ['paragraph', '- '], '2回目でテキストの行の「- 」にならない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('XE-1・F245: 保存していない打ちかけの Ctrl+Z は先に保存してから印で戻る（打ちかけを失わない）', T, async () => {
  const l = await seeded();
  try {
    const { id, ids: [e] } = await xePage(l, ['']);
    const t = txtOf(l, e); t.focus();
    await typeTo(l, t, 'あいう', 600);
    await typeTo(l, t, 'あいうえお', 100);
    assert.strictEqual(l.called('blockUpdate').length, 0, '前提: まだ保存していない');
    await press(l, ZK, e);
    assert.deepStrictEqual(l.called('blockUpdate').map((c) => c.args[2]), [{ text: 'あいうえお' }], '打ちかけを先に保存しない');
    assert.strictEqual(rowIn(l, id, e).text, 'あいう', '印で戻らない');
    await press(l, YK, e);
    assert.strictEqual(rowIn(l, id, e).text, 'あいうえお', '打ちかけを失った');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('XE-1・F245: Claude が同じ行を書いた後の印の戻しは stale の一言（Claude の文を上書きしない）', T, async () => {
  const l = await seeded();
  try {
    await open(l, 'pm1');
    const t = txtOf(l, 'b2'); t.focus();
    await typeTo(l, t, '来月の予算案の作成を担当Aが進める。', 600);
    await typeTo(l, t, '来月の予算案の作成を担当Aが進める。確認', 2000);
    const n = claude(l, 'mcp.fixNames', { pageId: 'pm1', pairs: [{ from: '担当A', to: '担当B' }] }, AT2);
    l.fire('onClaudeWrote', n.wrote); await l.drain(200);
    const want = '来月の予算案の作成を担当Bが進める。確認';
    assert.strictEqual(rowIn(l, 'pm1', 'b2').text, want, '前提: Claude が直した');
    await press(l, ZK, 'b2');
    assert.strictEqual(rowIn(l, 'pm1', 'b2').text, want, 'Claude の文を印で上書きした');
    assert.strictEqual(toastOf(l), 'ほかの所で変わったので、元に戻せませんでした');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('XE-1・F245: 保存したページのメモの行も印で戻る（edit.textStep）・やり直す', T, async () => {
  const l = await seeded();
  try {
    l.call('page.setMemoDoc', { id: 'pm1', doc: [{ id: 'm1', type: 'paragraph', text: '' }] });
    await open(l, 'pm1');
    $(l, 'paneBtnMemo').onclick(); await l.drain();
    const t = memoRow(l, 'm1')._txt; t.focus();
    await typeTo(l, t, '議題', 600);
    await typeTo(l, t, '議題の一つ目', 2000);
    const memo = () => l.call('page.get', { id: 'pm1' }).page.memoDoc[0].text;
    assert.strictEqual(memo(), '議題の一つ目');
    l.key(ZK, memoRow(l, 'm1')._txt); await l.drain(200);
    assert.strictEqual(memo(), '議題');
    l.key(ZK, memoRow(l, 'm1')._txt); await l.drain(200);
    assert.strictEqual(memo(), '');
    l.key(YK, memoRow(l, 'm1')._txt); await l.drain(200);
    l.key(YK, memoRow(l, 'm1')._txt); await l.drain(200);
    assert.strictEqual(memo(), '議題の一つ目');
    assert.strictEqual(l.called('editTextStep').length, 2);
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

// ---------------------------------------------------------------- XE-2（決めたこと 58・AQ21 (a)・AQ22 (a)・F246）: 何行かの素の文の貼り付け
const PCs = require('../src/pasteConvert');
const fnApp = (name) => { const at = XHTML.indexOf(`  function ${name}(`); assert.ok(at > 0, name); return XHTML.slice(at, XHTML.indexOf('\n  }\n', at) + 4); };
const pastePlain = (t, s) => t.dispatchEvent({ type: 'paste', clipboardData: { getData: (k) => (k === 'text/plain' ? s : '') }, preventDefault() {} });
test('XE-2・F246: 画面の写しの fromPlain が src と同じ答え（何行か・空の行・100,000 字・below）', () => {
  const at = XHTML.indexOf('  // ---- pasteConvert の写し');
  const end = XHTML.indexOf('  // ---- pasteConvert の写しはここまで');
  const rt = XHTML.slice(XHTML.indexOf('  // ---- richText の写し'), XHTML.indexOf('  // ---- richText の写しはここまで'));
  const app = new Function(`${fnApp('kidsCanView')}\n${fnApp('graphemeEnds')}\n${fnApp('safeOffset')}\n${rt}\n${XHTML.slice(at, end)}\nreturn pasteConvert;`)();   // eslint-disable-line no-new-func
  for (const s of ['a\nb\nc', 'a\n\nb', 'a', 'a\n', 'a\r\n b  \n', `${'x'.repeat(60000)}\n${'y'.repeat(39999)}\nz`, 'a'.repeat(100001), '一\n二\n\n三']) {
    assert.deepStrictEqual(app.fromPlain(s), PCs.fromPlain(s), JSON.stringify(s).slice(0, 40));
    assert.deepStrictEqual(app.pasteBlocks({ text: s }), PCs.pasteBlocks({ text: s }), JSON.stringify(s).slice(0, 40));
  }
});

// 行の型と文を変えた白紙のページ（rows: [type, text, extra?]）
async function pastePage(l, rows) {
  const id = l.call('page.create', {}).id;
  l.call('page.setTitle', { id, title: '貼る見本' });   // 白紙のページの題名（D77 の外。試しの字）
  const ids = [];
  let after = '';
  for (const [type, text, kids] of rows) {
    const b = l.call('block.insert', { pageId: id, afterBlockId: after, type }).blockId;
    if (text) l.call('block.update', { pageId: id, blockId: b, patch: { text } });
    if (kids) { const k = l.call('block.insert', { pageId: id, afterBlockId: '', parentId: b, type: 'paragraph' }).blockId; l.call('block.update', { pageId: id, blockId: k, patch: { text: kids } }); }
    ids.push(b); after = b;
  }
  await open(l, id);
  return { id, ids };
}
const shape = (l, id) => l.call('page.get', { id }).page.blocks.map((b) => [b.type, b.text, ...(b.children && b.children.length ? [b.children.map((c) => `${c.type}:${c.text}`)] : [])]);

test('XE-2・F246（AQ21 (a)・AQ22 (a)）: 空のテキストの行は貼った1つの行に置き換わる・文のある行の途中と末は今の行を変えずにすぐ下（at は文の長さ・afterId は無い）・選んだ字は消えない・カーソルは最後に貼った行の末', T, async () => {
  const l = await seeded();
  try {
    const { id, ids: [e, a, s] } = await pastePage(l, [['paragraph', ''], ['paragraph', '12345'], ['paragraph', '選ぶ文']]);
    // 空のテキストの行: 置き換わる（R18。NC1: OC-04）
    let t = txtOf(l, e); t.focus(); l.caret.set(t, 0);
    pastePlain(t, '一\n二\n三'); await l.drain(200);
    assert.deepStrictEqual(shape(l, id)[0], ['paragraph', '一\n二\n三'], '空のテキストの行が1つの行に置き換わらない');
    assert.strictEqual(l.call('page.get', { id }).page.blocks[0].id, e, '空のテキストの行の ID が替わった');
    // 文のある行の途中: 今の行はそのまま（ID・文）・すぐ下にテキストの行
    t = txtOf(l, a); t.focus(); l.caret.set(t, 3);
    pastePlain(t, 'あ\nい'); await l.drain(200);
    const args = l.called('blockPaste').at(-1).args;
    assert.deepStrictEqual([args[1], args[3], args[5], args.length], [a, 5, undefined, 5], 'at が文の長さでない・afterId を送った');
    let blocks = l.call('page.get', { id }).page.blocks;
    assert.deepStrictEqual(blocks.slice(1, 3).map((b) => [b.id === a, b.type, b.text]), [[true, 'paragraph', '12345'], [false, 'paragraph', 'あ\nい']], '今の行が割れた・すぐ下に無い');
    const last = blocks[2].id;
    assert.deepStrictEqual([active(l), l.caret.get(txtOf(l, last))], [txtOf(l, last), [3, 3]], 'カーソルが最後に貼った行の末に無い（AQ22 (a)）');
    // 末
    t = txtOf(l, a); t.focus(); l.caret.set(t, 5);
    pastePlain(t, 'う\nえ'); await l.drain(200);
    blocks = l.call('page.get', { id }).page.blocks;
    assert.deepStrictEqual(blocks.slice(1, 3).map((b) => b.text), ['12345', 'う\nえ']);
    // 選んだ字は消えない
    t = txtOf(l, s); t.focus(); l.caret.set(t, 0, 2);
    pastePlain(t, 'お\nか'); await l.drain(200);
    blocks = l.call('page.get', { id }).page.blocks;
    const at = blocks.findIndex((b) => b.id === s);
    assert.deepStrictEqual(blocks.slice(at, at + 2).map((b) => b.text), ['選ぶ文', 'お\nか'], '選んだ字が消えた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('XE-2・F246（AQ21 (a)）: 空の箇条書き・空の ToDo・文のある箇条書きと ToDo（担当・期限・出典つき）に貼ると、今の行はそのまま（型・担当・期限・出典も）で、すぐ下にテキストの行（型は写らない）。「あ\\nい\\n\\nう」は下にテキストの行が2つ', T, async () => {
  const l = await seeded();
  try {
    const { id, ids: [eb, et] } = await pastePage(l, [['bullet', ''], ['todo', '']]);
    let t = txtOf(l, eb); t.focus(); l.caret.set(t, 0);
    pastePlain(t, 'あ\nい\n\nう'); await l.drain(200);
    assert.deepStrictEqual(shape(l, id).slice(0, 3), [['bullet', ''], ['paragraph', 'あ\nい'], ['paragraph', 'う']], '空の箇条書きが空のまま残らない・型が写った');
    t = txtOf(l, et); t.focus(); l.caret.set(t, 0);
    pastePlain(t, 'え\nお'); await l.drain(200);
    const sh = shape(l, id);
    const k = sh.findIndex((x) => x[0] === 'todo');
    assert.deepStrictEqual(sh.slice(k, k + 2), [['todo', ''], ['paragraph', 'え\nお']], '空の ToDo が空のまま残らない');
    // 議事録の ToDo（担当・期限・出典つき）と箇条書き
    await open(l, 'pm1');
    const before = l.call('page.get', { id: 'pm1' }).page.blocks.find((b) => b.id === 'b4');
    t = txtOf(l, 'b4'); t.focus(); l.caret.set(t, 3);
    pastePlain(t, 'か\nき'); await l.drain(200);
    let blocks = l.call('page.get', { id: 'pm1' }).page.blocks;
    let i = blocks.findIndex((b) => b.id === 'b4');
    const after = blocks[i];
    assert.deepStrictEqual([after.type, after.text, after.assignee, after.dueRaw, after.cites, after.checked], [before.type, before.text, before.assignee, before.dueRaw, before.cites, before.checked], 'ToDo の型・文・担当・期限・出典が変わった');
    assert.deepStrictEqual([blocks[i + 1].type, blocks[i + 1].text, blocks[i + 1].assignee], ['paragraph', 'か\nき', undefined], '下の行がテキストの行でない（型・担当が写った）');
    t = txtOf(l, 'b2'); t.focus(); l.caret.set(t, 4);
    pastePlain(t, 'く\nけ'); await l.drain(200);
    blocks = l.call('page.get', { id: 'pm1' }).page.blocks;
    i = blocks.findIndex((b) => b.id === 'b2');
    assert.deepStrictEqual([blocks[i].type, blocks[i].text, blocks[i].cites, blocks[i + 1].type, blocks[i + 1].text], ['bullet', '来月の予算案の作成を担当Aが進める', ['s2'], 'paragraph', 'く\nけ'], '箇条書きが変わった・下にテキストの行が無い');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('XE-2・F246: 子の見えている箇条書きは今どおり最初の子（BQ31）・文のある行の頭に貼ると今どおり上（BQ30 (a)・AQ33 (a)）・1行だけの文は今どおりカーソルの所・番号付き・トグル・見出しは今の block.paste の決まり（カーソルの所で分ける）', T, async () => {
  const l = await seeded();
  try {
    const { id, ids: [bp, hd, nb, tg, one] } = await pastePage(l, [['bullet', '親の文', '子の文'], ['heading', '見出しの文'], ['numbered', '番号の文'], ['toggle', 'トグルの文'], ['paragraph', '一行の文']]);
    let t = txtOf(l, bp); t.focus(); l.caret.set(t, 1);
    pastePlain(t, 'あ\nい'); await l.drain(200);
    let a = l.called('blockPaste').at(-1).args;
    assert.deepStrictEqual([a[3], a[6]], [3, true], '子の見えている行で inside でない');
    assert.deepStrictEqual(shape(l, id)[0], ['bullet', '親の文', ['paragraph:あ\nい', 'paragraph:子の文']], '最初の子でない・親の文が割れた');
    // 文のある行の頭: 上
    t = txtOf(l, one); t.focus(); l.caret.set(t, 0);
    pastePlain(t, 'う\nえ'); await l.drain(200);
    let sh = shape(l, id);
    assert.deepStrictEqual(sh.slice(-2), [['paragraph', 'う\nえ'], ['paragraph', '一行の文']], '頭で上に入らない');
    // 1行だけの文はカーソルの所（命令を送らない）
    const n = l.called('blockPaste').length;
    t = txtOf(l, one); t.focus(); l.caret.set(t, 2);
    pastePlain(t, 'お'); await l.drain(200);
    assert.deepStrictEqual([l.called('blockPaste').length, txtOf(l, one).textContent], [n, '一行おの文'], '1行の文がカーソルの所に入らない');
    // 見出し・番号付き・トグル: カーソルの所で分ける（今の決まり: CR28）
    for (const [rid, at, head] of [[hd, 3, '見出し'], [nb, 2, '番号'], [tg, 3, 'トグル']]) {
      t = txtOf(l, rid); t.focus(); l.caret.set(t, at);
      pastePlain(t, 'か\nき'); await l.drain(200);
      a = l.called('blockPaste').at(-1).args;
      assert.strictEqual(a[3], at, `${head}: カーソルの所で分けない`);
      const b = l.call('page.get', { id }).page.blocks.find((x) => x.id === rid);
      assert.strictEqual(b.text, head, `${head}: 今の block.paste の決まりでない`);
    }
    sh = shape(l, id);
    assert.ok(sh.some((x) => x[1] === 'か\nき') || JSON.stringify(sh).includes('か\\nき'), '貼った行が無い');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});

test('XE-2・F246: Ctrl+Shift+V と変換中は今どおり行の中・メモの行も同じ決まり・Ctrl+Z の1回で貼った行が消え、今の行はそのまま・断られても今の行と選んだ所はそのまま', T, async () => {
  const l = await seeded();
  try {
    const { id, ids: [a] } = await pastePage(l, [['paragraph', '12345']]);
    let t = txtOf(l, a); t.focus(); l.caret.set(t, 5);
    l.key({ key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }, t);
    pastePlain(t, 'あ\nい'); await l.drain(200);
    assert.deepStrictEqual([t.textContent, l.called('blockPaste').length], ['12345あ\nい', 0], 'Ctrl+Shift+V が行の中でない');
    t.textContent = '12345'; l.caret.set(t, 5);
    t._composing = true;
    pastePlain(t, 'う\nえ'); await l.drain(200);
    t._composing = false;
    assert.deepStrictEqual([t.textContent, l.called('blockPaste').length], ['12345う\nえ', 0], '変換中の貼り付けが行の中でない');
    t.textContent = '12345'; l.caret.set(t, 5);
    await l.clock.advance(2000); await l.drain();
    // Ctrl+Z の1回で貼った行が消え、今の行はそのまま
    t = txtOf(l, a); t.focus(); l.caret.set(t, 2);
    pastePlain(t, 'お\nか'); await l.drain(200);
    assert.deepStrictEqual(shape(l, id), [['paragraph', '12345'], ['paragraph', 'お\nか']]);
    l.key(ZK, active(l)); await l.drain(200);
    assert.deepStrictEqual(shape(l, id), [['paragraph', '12345']], 'Ctrl+Z の1回で貼った行が消えない・今の行が変わった');
    // メモの行も同じ決まり（文のある行の途中: すぐ下）
    l.call('page.setMemoDoc', { id: 'pm1', doc: [{ id: 'm1', type: 'paragraph', text: 'メモの文' }] });
    await open(l, 'pm1');
    $(l, 'paneBtnMemo').onclick(); await l.drain();
    t = memoRow(l, 'm1')._txt; t.focus(); l.caret.set(t, 2);
    pastePlain(t, 'け\nこ'); await l.drain(200);
    await l.clock.advance(2000); await l.drain();
    assert.deepStrictEqual(l.call('page.get', { id: 'pm1' }).page.memoDoc.map((b) => [b.type, b.text]), [['paragraph', 'メモの文'], ['paragraph', 'け\nこ']], 'メモの行が同じ決まりでない');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  } finally { l.done(); }
});
test('XE-2・F246: 下に入れる貼り付けが断られても、今の行の文と選んだ所はそのまま（R142 と同じ）', T, async () => {
  let refuse = null;
  const l = await seeded({ blockPaste: () => new Promise((_, rej) => { refuse = () => rej(new Error('locked')); }) });
  try {
    const { ids: [a] } = await pastePage(l, [['paragraph', '12345']]);
    const t = txtOf(l, a); t.focus(); l.caret.set(t, 1, 3);
    pastePlain(t, 'き\nく'); await l.drain();
    assert.strictEqual(t.textContent, '12345', '答えを待つ間に今の行の文が変わった');
    assert.ok(refuse, '前提: blockPaste を呼ばない');
    refuse(); await l.drain(200);
    assert.deepStrictEqual([txtOf(l, a).textContent, l.caret.get(txtOf(l, a))], ['12345', [1, 3]], '断られた後に選んだ所が戻らない');
  } finally { l.done(); }
});
