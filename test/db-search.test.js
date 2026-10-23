/* db-search.test.js — 第2a1回 ST8・RF12: 今の検索と同じページが当たる */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { tmpDb, jsonTwin, searchCorpus } = require('./helpers/dbtmp');
const core = require('../src/db/core');
// 語の表（短い語・全角・句読点をまたぐ語・文法の文字・メモにだけある語・LIKE の特別な文字・サロゲート・ひらがな）
// 「予算会議」は、題名が「…予算」で終わりメモが「会議室…」で始まるページだけにある並び（題名とメモの区切りを外すと当たってしまう: 変異 ds-sep）
// 計画の表に足したもの: 「無題」（題名の無いページは、一覧の行の題名「(無題の議事録)」で当たる。今の searchIndex と同じ）
const QUERIES = ['会議', '見積', 'AI', 'ＡＩ戦略', '予算案の作成', '予', '"', '"予算', 'AND', 'NEAR(予算 会議)', '%', '_', '\\', '100%',
  'メモだけの語', '予算会議', '𠮷野', '𠮷野家', 'でーたべーす', 'データベース', '   ', '', '無題'];

test('RF12: 一覧の検索は json-backend（今の searchIndex）と同じページ・同じ順。題名とメモの抜き出しも同じ', { timeout: 5000 }, async () => {
  const t = tmpDb(); const j = jsonTwin();
  try {
    const { db } = t.open();
    // 30 ページ（{ page, segments } の並び）。題名・要約・メモ・文字起こしに上の語を散らし、% や _ や \ を含む行も入れる。
    // 入れる順は createdAt の順と違える（並びを rid の順にすると外れる: 変異 ds-order）
    const pages = searchCorpus();
    for (const { page, segments } of pages) { t.seed(page, segments); await j.seed(page, segments); }
    for (const q of QUERIES) {
      const got = core.call(db, { role: 'app', cmd: 'pages.list', args: { q } }, {}).result;
      const want = await j.call('pages.list', { q });
      assert.deepStrictEqual(got.map((p) => p.id), want.map((p) => p.id), `「${q}」`);
      // 題名で当たった行は抜き出しが無く、要約・メモで当たった行は元の文から切った抜き出しがある（ブロックごとに切るので文は比べない: 意図した違い）
      got.forEach((p, i) => assert.strictEqual(typeof p.snippet, typeof want[i].snippet, `「${q}」 ${p.id}`));
    }
  } finally { t.done(); j.done(); }
});

test('RF12: 全文検索は今の searchFullText と同じ hits の順・segmentHits・total・truncated（上限 2 でも）', { timeout: 5000 }, async () => {
  const t = tmpDb(); const j = jsonTwin();
  try {
    const { db } = t.open();
    for (const { page, segments } of searchCorpus()) { t.seed(page, segments); await j.seed(page, segments); }
    for (const q of QUERIES) for (const limit of [60, 2]) {
      const got = core.call(db, { role: 'app', cmd: 'pages.searchFull', args: { q, limit } }, {}).result;
      const want = await j.call('pages.searchFull', { q, limit });
      const key = (r) => ({ ids: r.hits.map((h) => [h.id, h.segmentHits, h.snippet]), total: r.total, truncated: r.truncated });
      assert.deepStrictEqual(key(got), key(want), `「${q}」 ${limit}`);
    }
  } finally { t.done(); j.done(); }
});

test('RF12: 1〜2文字は LIKE（符号点で数える）、% と _ と \\ は逃がす（% 1文字で全部に当たらない）', { timeout: 5000 }, () => {
  const S = require('../src/db/search');
  assert.deepStrictEqual(S.plan('会議'), { kind: 'like', pattern: '%会議%' });
  assert.deepStrictEqual(S.plan('𠮷野'), { kind: 'like', pattern: '%𠮷野%' });
  assert.deepStrictEqual(S.plan('𠮷野家'), { kind: 'match', query: '"𠮷野家"' });
  assert.deepStrictEqual(S.plan('%'), { kind: 'like', pattern: '%\\%%' });
  assert.deepStrictEqual(S.plan('a\\b'), { kind: 'match', query: '"a\\b"' });
  assert.deepStrictEqual(S.plan('AND'), { kind: 'match', query: '"and"' });   // 文法の語も引用の中の文字
  // searchFold は " と _ と空白を落とすので、畳んで空になる問いは null（一覧は全部・全文検索は 0 件。今の searchIndex／searchFullText と同じ）
  for (const q of ['', '"', '_', '   ']) assert.strictEqual(S.plan(q), null, JSON.stringify(q));
  // " は plan には届かないが、守りとして引用の組み立ては重ねる（第3回の検索パレットなど、畳まない入口が来ても文法にしない）
  assert.strictEqual(S.ftsQuote('x"y'), '"x""y"');
});

test('P8: ひらがなとカタカナは区別する（今と同じ）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    t.seed({ id: 'pa1', title: 'データベースの設計', blocks: [] }, []);
    assert.deepStrictEqual(core.call(db, { role: 'app', cmd: 'pages.list', args: { q: 'でーたべーす' } }, {}).result, []);
  } finally { t.done(); }
});

// ---- ここから下は計画のテストに足したもの（計画に無い守りと、変異を生き残らせないための確かめ）

test('ST8: 問いの制御文字は除く（題名とメモの区切り char(1) に当てない）。1文字の _ や \\ の LIKE も逃がした形', { timeout: 5000 }, () => {
  const S = require('../src/db/search');
  assert.deepStrictEqual(S.plan('\u0001予算案'), { kind: 'match', query: '"予算案"' });
  assert.deepStrictEqual(S.plan('予\u0001'), { kind: 'like', pattern: '%予%' });
  assert.strictEqual(S.plan('\u0001\u0002'), null);
  assert.deepStrictEqual(S.plan('\\'), { kind: 'like', pattern: '%\\\\%' });
  assert.deepStrictEqual(S.plan('a%'), { kind: 'like', pattern: '%a\\%%' });
});

test('ST8: ゴミ箱のページと録音中の写しは、一覧の検索にも全文検索にも出ない。締めると出る', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    let n = 0;
    const call = (cmd, args, role = 'main') => core.call(db, { role, cmd, args, tx: `${role[0]}:t-${String(++n).padStart(6, '0')}` }, { now: () => new Date('2026-10-19T01:00:00.000Z'), labels: {} });
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    t.seed({ id: 'pt1', title: '捨てる予算の会議', memo: '', blocks: [{ id: 'pt1b1', type: 'bullet', text: '捨てる予算の要点' }], createdAt: '2026-10-01T00:00:00.000Z' },
      [{ id: 's1', atMs: 0, durationMs: 1, text: '捨てる予算の発言' }]);
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    t.seed({ id: 'pt2', title: '残す予算の会議', memo: '', blocks: [], createdAt: '2026-10-02T00:00:00.000Z' },
      [{ id: 's1', atMs: 0, durationMs: 1, text: '残す予算の発言' }]);
    assert.strictEqual(call('page.delete', { id: 'pt1' }, 'app').ok, true);
    call('meeting.begin', { pageId: 'pt3', startedAt: Date.parse('2026-10-03T00:00:00.000Z'), localOnly: false });
    call('meeting.segment', { pageId: 'pt3', seg: { id: 's1', atMs: 0, durationMs: 1, text: '録音中の予算の発言' } });
    for (const q of ['予算', '予算の会議']) assert.deepStrictEqual(call('pages.list', { q }).result.map((p) => p.id), ['pt2'], `一覧「${q}」`);
    for (const q of ['予算', '予算の発言']) {
      const full = call('pages.searchFull', { q }).result;
      assert.deepStrictEqual([full.hits.map((h) => h.id), full.total, full.truncated], [['pt2'], 1, false], `全文「${q}」`);
    }
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    call('meeting.finalize', { pageId: 'pt3', page: { title: '締めた予算の会議', createdAt: '2026-10-03T00:00:00.000Z' }, segments: [{ id: 's1', atMs: 0, durationMs: 1, text: '録音中の予算の発言' }] });
    assert.deepStrictEqual(call('pages.searchFull', { q: '予算の発言' }).result.hits.map((h) => h.id), ['pt3', 'pt2']);
  } finally { t.done(); }
});

test('ST8: 要約の後半（今の 2 万字の打ち切りの外）とメモの後半も当たり、抜き出しは当たったうち一番前のブロックとメモの元の文から切る（意図した違い）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    const filler = Array.from({ length: 30 }, (_, i) => ({ id: `pl1b${i + 1}`, type: 'bullet', text: 'あ'.repeat(800) }));
    // 利用者が付け直した題名（D77。題名の語に頼るため）
    t.seed({ id: 'pl1', title: '長い会議', memo: 'い'.repeat(2100) + 'メモの後半の語', blocks: [...filler, { id: 'pl1b99', type: 'bullet', text: '最後の、要点（ＡＩ）です' }, { id: 'pl1b100', type: 'bullet', text: '二つ目の最後の要点AI' }], createdAt: '2026-10-01T00:00:00.000Z' }, []);
    const list = (q) => core.call(db, { role: 'app', cmd: 'pages.list', args: { q } }, {}).result;
    const [hit] = list('最後の要点ai');
    assert.strictEqual(hit && hit.id, 'pl1');
    assert.strictEqual(hit.snippet, '最後の、要点（ＡＩ）です', '抜き出しが当たったうち一番前のブロックからでない');
    const [memoHit] = list('メモの後半');
    assert.strictEqual(memoHit && memoHit.snippet, '…' + 'い'.repeat(20) + 'メモの後半の語');
    assert.strictEqual(list('長い会議')[0].snippet, undefined, '題名で当たった行に抜き出しがある');
  } finally { t.done(); }
});

// ---------------------------------------------------------------- 0.10.0 T-2b（D51）: 箇所の候補を引く決まった SQL
test('D51: passageHits は渡した ID の会議の行だけを返し、max + 1 行で overflow を決める。FTS5 と LIKE の当たりが同じ行（3文字の語で比べる）', { timeout: 5000 }, () => {
  const sqlite = require('node:sqlite');
  const search = require('../src/db/search');
  const { mcpDb } = require('./helpers/mcpdb');
  const m = mcpDb({ only: ['rag'] });
  try {
    const db = m.open();
    const all = m.ids.rag;
    const r = search.passageHits(db, '見積書', all, 100);
    assert.deepStrictEqual(r.segs.map((s) => [s.page_id, s.id]), [['pr01', 's1']]);
    assert.strictEqual(r.overflow, false);
    const some = search.passageHits(db, '会議', ['pr02', 'pr03'], 100);
    assert.ok(some.segs.length > 0 && some.segs.every((s) => ['pr02', 'pr03'].includes(s.page_id)));
    const capped = search.passageHits(db, '会議', all, 3);
    assert.strictEqual(capped.segs.length, 3);
    assert.strictEqual(capped.overflow, true);
    const exact = search.passageHits(db, '会議', all, some.segs.length + 100);
    assert.strictEqual(exact.overflow, false);
    // 新しい行の順（rid の大きい順）
    const rids = db.prepare("select rid from segments where page_id = 'pr10' order by rid desc").all().map((x) => x.rid);
    assert.ok(rids.length > 1);
    // FTS5 と LIKE が同じ行
    const fts = search.passageHits(db, '値引き', all, 100);
    const like = { segs: db.prepare(search.SQL.passSegLike).all('%値引き%', JSON.stringify(all), 101), blocks: db.prepare(search.SQL.passBlockLike).all('%値引き%', JSON.stringify(all), 101) };
    assert.deepStrictEqual(fts.segs.map((s) => `${s.page_id}/${s.id}`).sort(), like.segs.map((s) => `${s.page_id}/${s.id}`).sort());
    assert.deepStrictEqual(fts.blocks.map((s) => `${s.page_id}/${s.id}`).sort(), like.blocks.map((s) => `${s.page_id}/${s.id}`).sort());
    assert.ok(fts.blocks.some((b) => b.page_id === 'pr02' && b.is_page === 1), 'メモ（ページの行）の当たり');
    // 失敗した区間は引かない
    assert.deepStrictEqual(search.passageHits(db, '失敗', all, 100).segs.map((s) => s.id).sort(), ['s1', 's3']);
    // 2文字は LIKE
    assert.ok(search.passageHits(db, '見積', all, 100).blocks.some((b) => b.page_id === 'pr09'));
    m.close();
  } finally { m.done(); }
  void sqlite;
});
