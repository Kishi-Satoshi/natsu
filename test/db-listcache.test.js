/*
 * db-listcache.test.js — 第2a1回 G-1（PERF・RF12）: 一覧の1行を覚える（pages.list と検索が、変わっていないページを読み直さない）
 *
 * 5,000 ページの見本で pages.list が 667ms・「すべて」の検索が 1094ms かかり、目安（300ms・600ms）を越えた（ページごとに全部のブロックを
 * 読んで一覧の1行を作り直していた）。接続ごとに一覧の1行を覚え、ページの行（rid・rev・題名・attrs・作った時刻・直した時刻）が同じ間は
 * 使い回す。ブロックだけの直しでもページの rev が上がる（F6）ので、覚えた行が古くなることは無い。ここではそれを、どの変え方でも
 * 覚えていない接続で作った一覧と同じになることで見る。
 * 検索は、当たった行を全部 JS に渡さず、ページごとに SQL で数えて「並びの一番前」の行だけを返す（30 万発言で 932ms かかった）。
 * その答えが、並びの一番前のブロックと発言から抜き出し、数は全部であることも見る（並びと足した順が違うページで）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const sqlite = require('node:sqlite');
const { tmpDb } = require('./helpers/dbtmp');
const core = require('../src/db/core');
const C = require('../src/db/commands');

const NOW = () => new Date('2026-10-19T01:02:03.000Z');
let n = 0;
const call = (db, cmd, args, role = 'app') => {
  const r = core.call(db, { role, cmd, args, tx: `${role[0]}:lc-${String(++n).padStart(6, '0')}` }, { now: NOW, labels: {} });
  assert.strictEqual(r.ok, true, `${cmd} ${r.code}`);
  return r.result;
};

// ブロックの ID は表全体で重ならない（blocks.id は UNIQUE）ので、ページの ID を頭に付ける
function page(id, i, extra = {}) {
  return {
    id, title: `定例会議 ${i}`, date: '2026-10-19', durationSec: 60, memo: `メモ ${i}`,
    blocks: [
      { id: `${id}h`, type: 'heading', text: '決めたこと' },
      { id: `${id}a`, type: 'bullet', text: `第${i}回の予算案の作成を進める`, cites: [] },
      { id: `${id}t`, type: 'todo', text: `見積書を${i}日までに送る`, checked: false, assignee: `担当${i}`, due: `2026-10-${10 + i}`, cites: [] },
    ],
    createdAt: `2026-10-${10 + i}T00:00:00.000Z`, updatedAt: `2026-10-${10 + i}T00:00:00.000Z`, recovered: false, summaryError: '',
    ...extra,
  };
}
const segs = (i) => [{ id: 's1', atMs: 0, durationMs: 1000, text: `第${i}回の資料の話をしました` }];

// 接続を包んで、ページのブロックを読む問い合わせ（HOT_QUERIES.pageBlocks）を何回用意したかを数える
function counting(db) {
  const box = { reads: 0 };
  box.db = new Proxy(db, {
    get(target, key) {
      const v = Reflect.get(target, key, target);
      if (key === 'prepare') return (sql, ...rest) => { if (sql === C.HOT_QUERIES.pageBlocks) box.reads++; return v.call(target, sql, ...rest); };
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return box;
}

// 覚えていない接続（同じファイルを開いた新しい接続）で作った一覧
function freshList(t, args = {}) {
  const r = core.open({ sqlite, file: t.file });
  try {
    const res = core.call(r.db, { role: 'app', cmd: 'pages.list', args }, { labels: {} });
    assert.strictEqual(res.ok, true);
    return res.result;
  } finally { r.db.close(); }
}

test('G-1: pages.list の2回目は、変わっていないページのブロックを読み直さない。直したページだけ読み直す。検索の一覧の行も同じものを使う', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db: real } = t.open();
    for (let i = 1; i <= 3; i++) t.seed(page(`pl${i}`, i), segs(i));
    const c = counting(real);
    const first = call(c.db, 'pages.list', {});
    assert.strictEqual(first.length, 3);
    assert.strictEqual(c.reads, 3);
    c.reads = 0;
    assert.deepStrictEqual(call(c.db, 'pages.list', {}), first);
    assert.strictEqual(c.reads, 0, '変わっていないページを読み直した');
    call(c.db, 'page.setTitle', { id: 'pl2', title: '直した題' });
    c.reads = 0;
    const after = call(c.db, 'pages.list', {});
    assert.strictEqual(c.reads, 1, '直したページだけを読み直していない');
    assert.deepStrictEqual(after.map((x) => x.title), ['定例会議 3', '直した題', '定例会議 1']);
    c.reads = 0;
    assert.strictEqual(call(c.db, 'pages.list', { q: '予算案' }).length, 3);
    assert.strictEqual(call(c.db, 'pages.searchFull', { q: '資料' }).total, 3);
    assert.strictEqual(c.reads, 0, '検索が一覧の1行のためにページを読み直した');
  } finally { t.done(); }
});

test('G-1: 覚えた一覧の行は、どの変え方の後も、覚えていない接続で作った一覧と同じ（ブロックだけの直し・別の接続の書き込み・ゴミ箱・締めの上書き・消して作り直し）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    for (let i = 1; i <= 3; i++) t.seed(page(`pc${i}`, i), segs(i));
    const same = (why) => {
      assert.deepStrictEqual(call(db, 'pages.list', {}), freshList(t), why);
      assert.deepStrictEqual(call(db, 'pages.list', { q: '予算案' }), freshList(t, { q: '予算案' }), `${why}（検索）`);
    };
    same('はじめ');
    call(db, 'block.update', { pageId: 'pc1', blockId: 'pc1t', patch: { checked: true } });
    same('ToDo を済みにした（ブロックだけの直し）');
    call(db, 'block.setAction', { pageId: 'pc2', blockId: 'pc2t', assignee: '担当B', dueRaw: '' });
    same('担当を変えた');
    call(db, 'block.insert', { pageId: 'pc3', afterBlockId: 'pc3h', type: 'todo' });
    call(db, 'block.remove', { pageId: 'pc3', blockId: 'pc3a' });
    same('行を足して消した');
    call(db, 'page.setType', { id: 'pc2', type: 'oneonone' });
    same('種類を変えた');
    // ブロックだけを変え、題名・attrs・直した時刻は同じ（取り込み・締めの putPageRows の道）。ページの rev だけが変わる
    const was = call(db, 'page.get', { id: 'pc1' }).page;
    const next = structuredClone(was);
    next.blocks.find((b) => b.id === 'pc1t').checked = false;
    next.blocks.find((b) => b.id === 'pc1a').text = '題名も時刻も変えずに直した要点';
    t.seed(next, segs(1));
    assert.strictEqual(call(db, 'page.get', { id: 'pc1' }).page.updatedAt, was.updatedAt);
    same('ブロックだけを putPageRows で直した（rev だけが上がる）');
    // 別の接続（同じファイル）が書いた: 覚えた接続は、ページの行の rev が上がったのを見て読み直す
    const other = core.open({ sqlite, file: t.file });
    try {
      assert.strictEqual(core.call(other.db, { role: 'app', cmd: 'block.update', args: { pageId: 'pc3', blockId: 'pc3t', patch: { checked: true } }, tx: 'a:lc-other-1' }, { labels: {} }).ok, true);
    } finally { other.db.close(); }
    same('別の接続がブロックを直した');
    call(db, 'page.delete', { id: 'pc1' });
    same('ゴミ箱に入れた');
    call(db, 'meeting.finalize', { pageId: 'pc2', page: page('pc2', 2, { title: '締めた題', blocks: [{ id: 'pc2z', type: 'bullet', text: '締めで書いた要点', cites: [] }] }), segments: segs(2) }, 'main');
    same('締めで上書きした');
    // 消して同じ ID で作り直した（ページの行の rid と rev は1からやり直しになりうる）
    db.exec("delete from blocks where page_id = 'pc3'");
    t.seed(page('pc3', 3, { blocks: [{ id: 'pc3n', type: 'todo', text: '作り直したページの ToDo', checked: false, assignee: '担当Z', cites: [] }] }), segs(3));
    same('消して作り直した');
  } finally { t.done(); }
});

test('G-1: 返した一覧を書き換えても、覚えた一覧の行は変わらない', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    t.seed(page('pm1', 1), segs(1));
    const a = call(db, 'pages.list', {});
    a[0].title = '書き換えた';
    a[0].assignees.push('紛れ込んだ担当');
    const s = call(db, 'pages.list', { q: '予算案' });
    s[0].assignees.push('検索で紛れ込んだ担当');
    const f = call(db, 'pages.searchFull', { q: '資料' });
    f.hits[0].assignees.push('全文検索で紛れ込んだ担当');
    assert.deepStrictEqual(call(db, 'pages.list', {}), freshList(t));
    assert.deepStrictEqual(call(db, 'pages.list', {})[0].assignees, ['担当1']);
  } finally { t.done(); }
});

test('G-1: ページごとに集めた検索も、抜き出しは当たったうち並びの一番前のブロックと発言から、数は当たった発言の全部（3文字の trigram と 2文字の LIKE）', { timeout: 5000 }, () => {
  const t = tmpDb();
  try {
    const { db } = t.open();
    t.seed(page('pq1', 1, { title: '題', memo: '', blocks: [
      { id: 'pq1h', type: 'heading', text: '決めたこと' },
      { id: 'pq1a', type: 'bullet', text: 'その1: 予算案の作成', cites: [] },
      { id: 'pq1b', type: 'bullet', text: 'その2: 予算案の作成', cites: [] },
    ] }), [
      { id: 's1', atMs: 0, durationMs: 1000, text: 'いちばん前: 予算案の話' },
      { id: 's2', atMs: 1000, durationMs: 1000, text: '関係のない発言' },
      { id: 's3', atMs: 2000, durationMs: 1000, text: '二つ目: 予算案の話' },
      { id: 's4', atMs: 3000, durationMs: 1000, text: '三つ目: 予算案の話' },
    ]);
    // その2 を前へ動かす（並びの鍵の順と、行を足した順を違える）
    call(db, 'block.move', { pageId: 'pq1', blockId: 'pq1b', toIndex: 1 });
    for (const q of ['予算案', '予算']) {
      const list = call(db, 'pages.list', { q });
      assert.strictEqual(list.length, 1, q);
      assert.ok(list[0].snippet.includes('その2'), `「${q}」の抜き出しが並びの一番前のブロックからでない: ${list[0].snippet}`);
      const full = call(db, 'pages.searchFull', { q });
      assert.deepStrictEqual([full.total, full.hits[0].segmentHits, full.hits[0].snippet], [1, 3, 'いちばん前: 予算案の話'], q);
    }
  } finally { t.done(); }
});
