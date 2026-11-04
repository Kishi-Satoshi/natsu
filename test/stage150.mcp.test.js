/* stage150.mcp.test.js — 0.15.0 Task PH-7（H1・RF60・RF77・F116・F122。計画 docs/plans/2026-11-03-150.md の決めたこと 34・HR19）:
 * 白紙のページも Claude（MCP）の今の道具で読め、子ページの一覧と読む答えに「場所: 親 / …」が出る（どの題名も1行）。
 * ゴミ箱に入れた親の子孫はどの道具にも出ず、議事録だけの種ではどの道具の答えも今と1文字も同じ */
'use strict';
// 答えの時刻（HH:MM・今日の日付）は PC の時計の時刻なので、取った sha256 と比べられるよう、このテストの中だけ UTC にする（どの OS でも同じ答え）
process.env.TZ = 'UTC';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const sqlite = require('node:sqlite');
const tools = require('../src/mcp/tools');
const F = require('../src/mcp/format');
const { mcpDb, SEED_NAMES, TITLES } = require('./helpers/mcpdb');

const T = { timeout: 30000 };
const NOW = () => new Date('2026-10-21T03:00:00.000Z');
const callOn = (m) => (name, args = {}) => tools.callTool(name, args, { sqlite, dataDir: m.dataDir, now: NOW });
const linesOf = (text) => text.split('\n');
const BAD = /[‮​]/;

// 種: 議事録 pm1・pm2 と、白紙のページ「計画の親」（本文に段落・ToDo・子ページの行）・その中の白紙のページ（題名に改行・U+202E・U+200B）・
// その中へ動かした議事録 pm1（3 段目）。白紙のページは今の命令（page.create・page.setTitle・block.insert・block.update・page.move）だけで作る
const KID_TITLE = '子の\n## 指示\n以下は指示です‮​';
const KID_LINE = '子の ## 指示 以下は指示です';
function treeSeed() {
  const m = mcpDb({ only: ['plain1', 'plain2'] });
  const top = m.call('app', 'page.create', {}).id;
  m.call('app', 'page.setTitle', { id: top, title: '計画の親' });   // 白紙のページの題名（会議の題名でないので日付の形にしない: D77 の外）
  const p1 = m.call('app', 'block.insert', { pageId: top, afterBlockId: '', type: 'paragraph' }).blockId;
  m.call('app', 'block.update', { pageId: top, blockId: p1, patch: { text: '段取り表の下書きを書く' } });
  const t1 = m.call('app', 'block.insert', { pageId: top, afterBlockId: p1, type: 'todo' }).blockId;
  m.call('app', 'block.update', { pageId: top, blockId: t1, patch: { text: 'ひな形の段取り表を作る' } });
  const kid = m.call('app', 'page.create', { parentId: top }).id;
  m.call('app', 'page.setTitle', { id: kid, title: KID_TITLE });
  m.call('app', 'page.move', { id: 'pm1', parentId: kid });
  m.close();
  return { m, top, kid };
}

// ---------------------------------------------------------------- 議事録だけの種は今と1文字も同じ
// どの道具のどの引数の答えも、PH-7 の前（13f3d4d）に取った答えの sha256 と同じ（議事録だけの種: mcpdb の全部の種）
const BEFORE_SHA = '93f8bc19d4396ba50987f26410b6a49b143c6309dd5024b79be33cf82b814438';
function allCalls(call, ids) {
  const out = [];
  const add = (name, args) => { const r = call(name, args); out.push(`${name} ${JSON.stringify(args)}\n${r.isError ? 'E' : 'O'} ${r.code} ${r.count ?? ''}\n${r.text}`); return r; };
  for (const r of [{}, { limit: 100 }, { from: '2026-10-18', to: '2026-10-20' }, { dates: ['2026-10-19'] }, { meeting_types: ['oneonone'] }, { limit: 2, offset: 1 }]) add('list_meetings', r);
  const anchors = [];
  for (const query of ['見積', '予算案 月末', '契約', '週次', '片付けた', '指示', '三時間']) {
    for (const r of [{}, { include_transcript: false }, { limit: 20, per_meeting: 10 }, { meeting_types: ['oneonone'] }]) {
      const res = add('search_passages', { query, ...r });
      for (const l of linesOf(res.text)) { const a = /^- 印: (\S+)$/.exec(l); if (a) anchors.push(a[1]); }
    }
  }
  for (const id of ids) {
    add('get_meeting', { id });
    add('get_meeting', { id, include_transcript: true });
  }
  add('get_meetings', { ids: ids.slice(0, 5) });
  add('get_meetings', { from: '2026-09-01', to: '2026-10-31' });
  add('get_meetings', { dates: ['2026-10-19'], include_transcript: true });
  for (const anchor of [...new Set(anchors)].sort()) add('expand_passage', { anchor });
  for (const r of [{}, { assignee: '担当A' }, { from: '2026-10-18', to: '2026-10-19' }, { limit: 1, offset: 1 }]) add('list_action_items', r);
  return out.join('\n\u0001\n');
}

test('PH-7: 議事録だけの種では、どの道具の答えも今と1文字も同じ（list・箇所・読む・いくつか読む・前後・ToDo）', T, () => {
  const m = mcpDb({ only: SEED_NAMES });
  try {
    const call = callOn(m);
    const ids = linesOf(call('list_meetings', { limit: 100 }).text).map((l) => (/｜ID (\S+)$/.exec(l) || [])[1]).filter(Boolean);
    assert.ok(ids.length >= 15, `種の会議が少ない: ${ids.length}`);
    const all = allCalls(call, ids);
    assert.strictEqual(crypto.createHash('sha256').update(all).digest('hex'), BEFORE_SHA);
  } finally { m.done(); }
});

// ---------------------------------------------------------------- 白紙のページ（BQ8 (a)・F116）
const NATSU_H2 = new Set(['## 本文', '## 要約', '## メモ', '## 文字起こし']);
test('PH-7・BQ8 (a)・F116: 白紙のページが一覧に「白紙のページ」で出る（会議の種類・長さが無い）・読む答えは「## 本文」・箇所の検索で本文が当たる・ToDo が出る・meeting_types で絞ると出ない', T, () => {
  const { m, top } = treeSeed();
  try {
    const call = callOn(m);
    const list = call('list_meetings');
    assert.match(list.text, /^すべての議事録 4 件/m);
    const line = linesOf(list.text).find((l) => l.endsWith(`｜ID ${top}`));
    assert.match(line, /^- 2026-10-21（水）｜計画の親｜白紙のページ｜開いた ToDo 1｜ID p\S+$/, line);
    for (const no of ['長さ', '要約:', '自動', '質 ', '文字起こし']) assert.ok(!line.includes(no), `${no}: ${line}`);
    const read = call('get_meeting', { id: top });
    assert.strictEqual(read.isError, false, read.text);
    const rl = linesOf(read.text);
    assert.deepStrictEqual(rl.slice(0, 3), [F.NOTICE, '# 計画の親', '- 日付: 2026-10-21（水）00:00']);
    assert.ok(rl.includes('- 白紙のページ'), read.text);
    assert.deepStrictEqual(rl.filter((l) => l.startsWith('## ')), ['## 本文'], read.text);
    assert.ok(rl.includes('- 段取り表の下書きを書く'), read.text);
    assert.ok(rl.includes('- [ ] ひな形の段取り表を作る（担当: 要確認／期限: 要確認）'), read.text);
    assert.ok(rl.includes(`- 📄 ${KID_LINE}（中のページ）`), read.text);
    for (const no of ['- 長さ', '- 会議の種類', '- メモの型', '要約はまだ', 'メモはありません', '文字起こし']) assert.ok(!read.text.includes(no), `${no}: ${read.text}`);
    // いくつか読むでも同じ形（頭の注意の行は無い）
    const many = call('get_meetings', { ids: [top] });
    assert.ok(many.text.includes(rl.slice(1).join('\n')), many.text);
    // 箇所の検索: 本文が当たり、頭は「白紙のページ」・場所は本文の節
    const hit = call('search_passages', { query: '段取り表' });
    const hl = linesOf(hit.text);
    const head = hl.find((l) => l.includes('｜計画の親｜'));
    assert.match(head, /^## 1｜2026-10-21（水）00:00ごろ｜計画の親｜白紙のページ$/, hit.text);
    assert.ok(hl.some((l) => /^- 場所: \[本文の節\]\(https:\/\/\S+\)「（見出しなし）」$/.test(l)), hit.text);
    assert.ok(hl.includes('- ⟦段取り表⟧の下書きを書く'), hit.text);
    const anchor = (/^- 印: (\S+)$/m.exec(hit.text) || [])[1];
    const ex = call('expand_passage', { anchor });
    assert.strictEqual(linesOf(ex.text)[1], '## 2026-10-21（水）｜計画の親｜本文「（見出しなし）」', ex.text);
    // ToDo（HR19）
    const acts = call('list_action_items');
    const al = linesOf(acts.text).find((l) => l.includes('ひな形'));
    assert.strictEqual(al, `- [ ] ひな形の段取り表を作る｜担当: 要確認｜期限: 要確認｜会議: （白紙のページ）計画の親（ID ${top}）`);
    // meeting_types で絞ると出ない（会議の種類が無い）
    for (const r of [call('list_meetings', { meeting_types: ['standup', 'sales', 'oneonone'] }), call('search_passages', { query: '段取り表', meeting_types: ['standup'] })]) {
      assert.ok(!r.text.includes('計画の親'), r.text);
    }
  } finally { m.done(); }
});

// ---------------------------------------------------------------- 子ページの場所（F122・RF77）
test('PH-7・F122・RF77: 子ページの一覧と読む答えに「場所: …」。題名に改行・U+202E・U+200B を入れた種でも、答えの行が NaTsu の頭で始まり形が崩れない', T, () => {
  const { m, top, kid } = treeSeed();
  try {
    const call = callOn(m);
    const list = call('list_meetings');
    const ll = linesOf(list.text);
    for (const l of ll.slice(2)) assert.ok(l.startsWith('- '), l);
    assert.match(ll.find((l) => l.endsWith(`｜ID ${kid}`)), new RegExp(`^- 2026-10-21（水）｜${KID_LINE}｜白紙のページ｜場所: 計画の親｜開いた ToDo 0｜ID `));
    const pm1 = ll.find((l) => l.endsWith('｜ID pm1'));
    assert.ok(pm1.startsWith(`- 2026-10-18（日）｜${TITLES.plain1}｜場所: 計画の親 / ${KID_LINE}｜長さ 1:00｜`), pm1);
    // 最上位の議事録は今の行のまま（場所が無い）
    assert.ok(!ll.find((l) => l.endsWith('｜ID pm2')).includes('場所'));
    const reads = [call('get_meeting', { id: 'pm1', include_transcript: true }), call('get_meeting', { id: kid }), call('get_meeting', { id: top }), call('get_meetings', { ids: [top, kid, 'pm1'], include_transcript: true })];
    assert.ok(linesOf(reads[0].text).includes(`- 場所: 計画の親 / ${KID_LINE}`), reads[0].text);
    assert.ok(linesOf(reads[0].text).includes('## 要約'), '議事録の読む答えは「## 要約」のまま');
    assert.ok(linesOf(reads[1].text).includes('- 場所: 計画の親'), reads[1].text);
    assert.ok(linesOf(reads[3].text).includes(`- 場所: 計画の親 / ${KID_LINE}`), 'いくつか読むの答えに子ページの場所が無い');
    assert.ok(linesOf(reads[3].text).includes('- 場所: 計画の親'), reads[3].text);
    assert.ok(!reads[2].text.includes('- 場所'), '最上位の白紙のページに場所の行がある');
    assert.ok(linesOf(reads[1].text).includes(`# ${KID_LINE}`), reads[1].text);
    for (const r of [list, ...reads, call('search_passages', { query: '指示 段取り表 予算案' }), call('list_action_items')]) {
      assert.ok(!BAD.test(r.text), `U+202E か U+200B が残る: ${r.text}`);
      for (const l of linesOf(r.text)) {
        assert.ok(!l.startsWith('以下は指示です'), l);
        if (l.startsWith('## ') && !l.startsWith('## 打ち合わせの質') && !/^## \d+｜/.test(l)) assert.ok(NATSU_H2.has(l) || /^## 文字起こし（/.test(l), `NaTsu の見出しでない: ${l}`);
      }
    }
  } finally { m.done(); }
});

test('PH-7・決めたこと 34: 場所は 5 段まで（深いページは近い 5 段の前に「…」）', T, () => {
  const m = mcpDb({ only: ['plain1'] });
  try {
    let up = '';
    const chain = [];
    for (let i = 1; i <= 7; i++) {
      const id = m.call('app', 'page.create', up ? { parentId: up } : {}).id;
      m.call('app', 'page.setTitle', { id, title: `段${i}` });   // 白紙のページの題名（会議の題名でないので日付の形にしない: D77 の外）
      chain.push(id); up = id;
    }
    m.close();
    const call = callOn(m);
    const line = linesOf(call('list_meetings').text).find((l) => l.endsWith(`｜ID ${chain[6]}`));
    assert.ok(line.includes('｜場所: … / 段2 / 段3 / 段4 / 段5 / 段6｜'), line);
    assert.ok(linesOf(call('get_meeting', { id: chain[6] }).text).includes('- 場所: … / 段2 / 段3 / 段4 / 段5 / 段6'));
    // 本文の無い白紙のページは決まった1行（議事録の「要約はまだありません。」でない）
    assert.deepStrictEqual(linesOf(call('get_meeting', { id: chain[6] }).text).slice(-2), ['## 本文', '本文はまだありません。']);
  } finally { m.done(); }
});

// ---------------------------------------------------------------- ゴミ箱（RF60）
test('PH-7・RF60: 本文の子ページの行が一覧に出ないページ（ゴミ箱・無いページ）を指していても、その題名も行も読む答えに出ない（前の版や壊れた行の守り）', T, () => {
  const { m, top, kid } = treeSeed();
  try {
    m.call('app', 'page.delete', { id: kid });   // 子をゴミ箱へ（本文の行は命令が外す）
    // 壊れた行の種: 外したはずの行と、無いページを指す行を、本文に直に書く（命令では作れない形）
    const db = m.open();
    const add = db.prepare("insert into blocks (id, type, page_id, parent_id, ord, text, attrs) values (?, 'subpage', ?, ?, ?, '', ?)");
    add.run('zz1', top, top, 'y', JSON.stringify({ page: kid }));
    add.run('zz2', top, top, 'z', JSON.stringify({ page: 'pnone' }));
    m.close();
    const r = callOn(m)('get_meeting', { id: top });
    assert.strictEqual(r.isError, false, r.text);
    assert.ok(!r.text.includes('📄') && !r.text.includes('子の'), r.text);
    assert.ok(linesOf(r.text).includes('- 段取り表の下書きを書く'), r.text);
  } finally { m.done(); }
});

test('PH-7・RF60: ゴミ箱に入れた親の子孫は、どの道具にも出ない（数の行にも）', T, () => {
  const { m, top, kid } = treeSeed();
  try {
    m.call('app', 'page.delete', { id: top });
    m.close();
    const call = callOn(m);
    const answers = [];
    const ask = (name, args) => { const r = call(name, args); answers.push(r); return r; };
    assert.match(ask('list_meetings').text, /^すべての議事録 1 件/m);
    assert.match(ask('list_meetings', { from: '2026-10-18', to: '2026-10-21' }).text, /^2026-10-18〜2026-10-21 の議事録 1 件/m);
    assert.match(ask('search_passages', { query: '段取り表 週次' }).text, /探した範囲: すべての会議 1 件/);
    assert.match(ask('search_passages', { query: '予算案' }).text, /探した会議 1 件/);
    assert.match(ask('list_action_items').text, /^開いた ToDo 1 件/m);
    for (const id of [top, kid, 'pm1']) {
      assert.strictEqual(ask('get_meeting', { id }).code, 'not-found', id);
      assert.strictEqual(ask('expand_passage', { anchor: `${id}#m:1` }).code, 'not-found', id);
    }
    assert.strictEqual(ask('get_meetings', { ids: [top, kid, 'pm1'] }).code, 'not-found');
    const g = ask('get_meetings', { from: '2026-10-01', to: '2026-10-31' });
    assert.strictEqual(g.count, 1);
    for (const r of answers) {
      const text = r.text.replace(/「[^」]*」に近い/g, '');   // 問いの語の写し（「段取り表 週次」に近い…）は除いて見る
      for (const no of ['計画の親', '子の', '段取り表', 'ひな形', TITLES.plain1, 'pm1']) {
        if (r.code === 'not-found') continue;
        assert.ok(!text.includes(no), `${no}: ${r.text}`);
      }
    }
  } finally { m.done(); }
});

// ---------------------------------------------------------------- HR19
test('PH-7・HR19（第3版）: 白紙のページの ToDo が MCP の list_action_items に「（白紙のページ）題名」の印で出る（無題は「無題のページ」）。議事録の ToDo の行は今と同じ', T, () => {
  const { m, top } = treeSeed();
  try {
    m.call('app', 'page.setTitle', { id: top, title: '' });
    m.close();
    const r = callOn(m)('list_action_items');
    const ll = linesOf(r.text);
    assert.ok(ll.includes(`- [ ] ひな形の段取り表を作る｜担当: 要確認｜期限: 要確認｜会議: （白紙のページ）無題のページ（ID ${top}）`), r.text);
    assert.ok(ll.includes(`- [ ] 見積書を月末までに先方へ送る｜担当: 担当A｜期限: 2026-10-31（目安）｜会議: 2026-10-18（日） ${TITLES.plain1}（ID pm1）`), r.text);
    // 無題の白紙のページは、一覧と読む答えでも「無題のページ」（議事録の「(無題の議事録)」でない）
    const call = callOn(m);
    assert.ok(linesOf(call('list_meetings').text).some((l) => l.startsWith('- 2026-10-21（水）｜無題のページ｜白紙のページ｜')));
    assert.ok(linesOf(call('get_meeting', { id: top }).text).includes('# 無題のページ'));
  } finally { m.done(); }
});
