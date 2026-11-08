/*
 * stage160.lib.test.js — 0.16.0「データベース」の純粋な部品（計画 docs/plans/2026-11-04-160.md の Task DS-1）
 * 列の種類とセルの値の照らし・種類の読み替え・選択肢の名前（src/dbModel.js）と、ビューの照らし・並べ替え・絞り込み（かつ／または）・
 * グループ・集計・データベースの中の検索・見える行の切り出し（src/dbView.js）。
 * 列・選択肢・行の名前は作った物で、実在の人名・社名は使わない。時計は偽物（決まった時刻）。
 */
'use strict';
// DS-1 直し（2026-11-07 の点検 rv38 の F6）: 「今日」と作成日時の日はその PC の時刻で見る。UTC の CI でも取り違えが見えるよう、このテストの中だけ
// 東京の時刻にし、偽の今を朝 8 時（UTC ではまだ前の日）に置く
process.env.TZ = 'Asia/Tokyo';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/dbModel.js');
const V = require('../src/dbView.js');

const throwsBad = (fn, msg) => assert.throws(fn, (e) => e && e.code === 'bad-args', msg);
const SEL = { id: 'c1', name: '優先度', type: 'select', opts: [{ id: 'o1', name: '高', color: 'red' }, { id: 'o2', name: '中', color: 'yellow' }, { id: 'o3', name: '低', color: 'default' }] };
const MUL = { id: 'c2', name: 'タグ', type: 'multi', opts: [{ id: 'o1', name: '会議', color: 'blue' }, { id: 'o2', name: '資料', color: 'green' }, { id: 'o3', name: 'Web', color: 'default' }] };
const NUM = { id: 'c3', name: '金額', type: 'number', fmt: 'plain' };
const TXT = { id: 'c4', name: 'メモ', type: 'text' };
const DAT = { id: 'c5', name: '期限', type: 'date' };
const CHK = { id: 'c6', name: '済み', type: 'check' };
const PER = { id: 'c7', name: '担当', type: 'person' };
const URL1 = { id: 'c8', name: '資料の住所', type: 'url' };
const STA = { id: 'c9', name: '状態', type: 'status', ...M.COLS.status.defaults() };
const TITLE = { id: 'title', name: '名前', type: 'title' };
const COLS = [TITLE, SEL, MUL, NUM, TXT, DAT, CHK, PER, URL1, STA];
// 偽の今（その PC の時刻で 2026-11-04 の朝 8 時。UTC ではまだ 11-03: DS-1 直し）
const NOW = new Date(2026, 10, 4, 8, 0, 0).getTime();
const row = (id, ord, title, cells = {}, extra = {}) => ({ id, ord, title, cells, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', by: { c: 'me', u: 'me' }, no: 1, ...extra });

// ---------------------------------------------------------------- dbModel
test('DS-1・F137: cellOf の表（種類ごとに通る値と断る値・空は null・書けない種類は投げる）', () => {
  // 数値
  assert.strictEqual(M.cellOf(NUM, 12.5), 12.5);
  assert.strictEqual(M.cellOf(NUM, -3), -3);
  assert.strictEqual(M.cellOf(NUM, null), null);
  for (const v of ['12', NaN, Infinity, -Infinity, true, {}]) throwsBad(() => M.cellOf(NUM, v), `数値 ${String(v)}`);
  // 選択・ステータス
  assert.strictEqual(M.cellOf(SEL, 'o2'), 'o2');
  assert.strictEqual(M.cellOf(SEL, ''), null);
  throwsBad(() => M.cellOf(SEL, 'o9'), '選択肢に無い ID');
  throwsBad(() => M.cellOf(SEL, 1), '選択の ID が数');
  assert.strictEqual(M.cellOf(STA, 'o2'), 'o2');
  throwsBad(() => M.cellOf(STA, 'o4'), 'ステータスの選択肢に無い ID');
  // 複数選択
  assert.deepStrictEqual(M.cellOf(MUL, ['o3', 'o1']), ['o3', 'o1']);
  assert.strictEqual(M.cellOf(MUL, []), null);
  throwsBad(() => M.cellOf(MUL, ['o1', 'o1']), '複数選択の重なり');
  throwsBad(() => M.cellOf(MUL, ['o1', 'o9']), '複数選択の選択肢に無い ID');
  throwsBad(() => M.cellOf(MUL, 'o1'), '複数選択が並びでない');
  // 日付
  assert.deepStrictEqual(M.cellOf(DAT, { start: '2026-11-04' }), { start: '2026-11-04' });
  assert.deepStrictEqual(M.cellOf(DAT, { start: '2026-11-04', time: '10:00', end: '2026-11-08' }), { start: '2026-11-04', time: '10:00', end: '2026-11-08' });
  assert.deepStrictEqual(M.cellOf(DAT, { start: '2028-02-29' }), { start: '2028-02-29' });
  throwsBad(() => M.cellOf(DAT, { start: '2026-02-30' }), '無い日');
  throwsBad(() => M.cellOf(DAT, { start: '2026-02-29' }), 'うるう年でない2月29日');
  throwsBad(() => M.cellOf(DAT, { start: '2026-11-08', end: '2026-11-04' }), '終わりが始まりより前');
  throwsBad(() => M.cellOf(DAT, { start: '2026-11-04', time: '10:00', endTime: '09:00' }), '同じ日で終わりの時刻が前');
  throwsBad(() => M.cellOf(DAT, { start: '2026-11-04', time: '25:00' }), '無い時刻');
  throwsBad(() => M.cellOf(DAT, { start: '2026-11-04', endTime: '10:00' }), '始まりの時刻の無い終わりの時刻');
  throwsBad(() => M.cellOf(DAT, { start: '2026-11-04', note: 'x' }), '知らない欄');
  throwsBad(() => M.cellOf(DAT, '2026-11-04'), '日付が文字');
  // URL（http(s) だけ: SEC2）
  assert.strictEqual(M.cellOf(URL1, 'https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.strictEqual(M.cellOf(URL1, 'http://example.com'), 'http://example.com');
  assert.strictEqual(M.cellOf(URL1, ''), null);
  for (const v of ['javascript:alert(1)', 'file:///C:/Windows', 'data:text/html,x', 'https://', 'https://a b', ' https://example.com', 'https://example.com/\u202e']) throwsBad(() => M.cellOf(URL1, v), `URL ${v}`);
  throwsBad(() => M.cellOf(URL1, `https://example.com/${'a'.repeat(2000)}`), '2,001 字を越える URL');
  // メールと電話
  // メールの見本は @ を分けて書く（公開前の確認がメールの住所の形の文字を断るため）
  const AT = '@';
  assert.strictEqual(M.cellOf({ id: 'e', name: 'メール', type: 'email' }, `a${AT}example.com`), `a${AT}example.com`);
  throwsBad(() => M.cellOf({ id: 'e', name: 'メール', type: 'email' }, 'example.com'), 'メールの形');
  throwsBad(() => M.cellOf({ id: 'e', name: 'メール', type: 'email' }, `a b${AT}example.com`), 'メールに空白');
  assert.strictEqual(M.cellOf({ id: 'p', name: '電話', type: 'phone' }, '+81 (3) 1234-5678'), '+81 (3) 1234-5678');
  throwsBad(() => M.cellOf({ id: 'p', name: '電話', type: 'phone' }, '03-1234-567x'), '電話に字');
  throwsBad(() => M.cellOf({ id: 'p', name: '電話', type: 'phone' }, '1'.repeat(31)), '31 字の電話');
  // テキスト（10,000 字まで）
  assert.strictEqual(M.cellOf(TXT, 'あ'.repeat(10000)).length, 10000);
  throwsBad(() => M.cellOf(TXT, 'あ'.repeat(10001)), '10,001 字のテキスト');
  throwsBad(() => M.cellOf(TXT, 5), 'テキストが数');
  assert.strictEqual(M.cellOf(TXT, ''), null);
  // ユーザー（10 人・1つ 50 字）
  assert.deepStrictEqual(M.cellOf(PER, ['佐藤', 'Aoi']), ['佐藤', 'Aoi']);
  throwsBad(() => M.cellOf(PER, Array.from({ length: 11 }, (_, i) => `人${i}`)), 'ユーザーの 11 人');
  throwsBad(() => M.cellOf(PER, ['人'.repeat(51)]), '51 字の名前');
  throwsBad(() => M.cellOf(PER, ['佐藤', '佐藤']), '名前の重なり');
  throwsBad(() => M.cellOf(PER, [' 佐藤']), '前後の空白');
  throwsBad(() => M.cellOf(PER, ['a\nb']), '改行の名前');
  // チェック（偽は空）
  assert.strictEqual(M.cellOf(CHK, true), true);
  assert.strictEqual(M.cellOf(CHK, false), null);
  throwsBad(() => M.cellOf(CHK, 'はい'), 'チェックが文字');
  // リレーション（行の ID の並び・100 まで）
  assert.deepStrictEqual(M.cellOf({ id: 'r', name: 'つなぐ', type: 'rel', db: 'pdb' }, ['rA', 'rB']), ['rA', 'rB']);
  throwsBad(() => M.cellOf({ id: 'r', name: 'つなぐ', type: 'rel', db: 'pdb' }, Array.from({ length: 101 }, (_, i) => `r${i}`)), '101 個のリレーション');
  throwsBad(() => M.cellOf({ id: 'r', name: 'つなぐ', type: 'rel', db: 'pdb' }, ['r/1']), 'ID の形');
  // 書けない種類
  for (const type of ['ctime', 'mtime', 'cby', 'mby', 'no']) throwsBad(() => M.cellOf({ id: 'x', name: 'x', type }, type === 'no' ? 3 : 'me'), `${type} は書けない`);
  throwsBad(() => M.cellOf({ id: 'x', name: 'x', type: 'rollup' }, 1), '知らない種類');
});

test('DS-1: 列の種類は 17（と題名）で、どれも名前・書けるか・既定の欄を持ち、colOk が形を照らす', () => {
  assert.deepStrictEqual(M.TYPES, ['title', 'text', 'number', 'select', 'multi', 'status', 'date', 'person', 'check', 'url', 'email', 'phone', 'rel', 'ctime', 'mtime', 'cby', 'mby', 'no']);
  assert.deepStrictEqual(M.TYPES.filter((t) => !M.COLS[t].writable), ['ctime', 'mtime', 'cby', 'mby', 'no']);
  assert.deepStrictEqual(M.OPT_COLORS, ['default', 'gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red']);
  for (const c of COLS) assert.ok(M.colOk(c), c.id);
  assert.ok(!M.colOk({ ...SEL, opts: [{ id: 'o1', name: 'A', color: 'red' }, { id: 'o2', name: 'a', color: 'red' }] }), '大文字小文字の重なり');
  assert.ok(!M.colOk({ ...SEL, opts: [{ id: 'o1', name: 'A,B', color: 'red' }] }), 'カンマの選択肢');
  assert.ok(!M.colOk({ ...SEL, opts: [{ id: 'o1', name: 'A', color: 'navy' }] }), '知らない色');
  assert.ok(!M.colOk({ ...NUM, fmt: 'euro' }), '知らない見せ方');
  assert.ok(!M.colOk({ id: 'title', name: '名前', type: 'text' }), '題名の ID で題名でない種類');
  assert.ok(!M.colOk({ id: 'c1', name: '名前', type: 'title' }), '題名の種類で題名でない ID');
  assert.ok(!M.colOk({ ...TXT, name: '' }), '空の名前');
  assert.ok(!M.colOk({ ...TXT, gone: false }), 'gone は true だけ');
  assert.ok(M.colOk({ ...TXT, gone: true }));
  assert.ok(!M.colOk({ ...STA, groups: { todo: ['o1'], doing: ['o2'], done: [] } }), 'ステータスのまとまりに入っていない選択肢');
  assert.ok(M.colOk({ id: 'c10', name: 'ID', type: 'no', prefix: 'TASK' }));
  assert.ok(!M.colOk({ id: 'c10', name: 'ID', type: 'no', prefix: 'TASK-1' }), '接頭辞は英字だけ');
  assert.deepStrictEqual(STA.opts.map((o) => o.name), ['未着手', '進行中', '完了']);
});

test('DS-1・F137: optNameOk（大文字小文字と全角半角を寄せた重なり・カンマ・101 字は偽）と addOpt・newCol', () => {
  const opts = [{ id: 'o1', name: 'Web', color: 'default' }];
  assert.ok(M.optNameOk(opts, '資料'));
  assert.ok(!M.optNameOk(opts, 'web'), '小文字の重なり');
  assert.ok(!M.optNameOk(opts, 'WEB'), '大文字の重なり');
  assert.ok(!M.optNameOk(opts, 'ｗｅｂ'), '全角の重なり');
  assert.ok(M.optNameOk(opts, 'web', 'o1'), '自分自身の名前を変えるときは重ならない');
  assert.ok(!M.optNameOk(opts, 'a,b'));
  assert.ok(!M.optNameOk(opts, 'a，b'));
  assert.ok(!M.optNameOk(opts, 'あ'.repeat(101)));
  assert.ok(M.optNameOk(opts, 'あ'.repeat(100)));
  assert.ok(!M.optNameOk(opts, ''));
  assert.ok(!M.optNameOk(opts, ' 資料'));
  const r = M.addOpt(SEL, '保留', 'gray');
  assert.strictEqual(r.id, 'o4');
  assert.deepStrictEqual(r.col.opts.at(-1), { id: 'o4', name: '保留', color: 'gray' });
  assert.strictEqual(SEL.opts.length, 3, 'もとの列は変えない');
  throwsBad(() => M.addOpt(SEL, '高'));
  const many = { ...SEL, opts: Array.from({ length: 200 }, (_, i) => ({ id: `o${i + 1}`, name: `名${i}`, color: 'default' })) };
  throwsBad(() => M.addOpt(many, '新しい'), '201 個目の選択肢');
  const c = M.newCol('text', 'メモ', COLS);
  assert.deepStrictEqual(c, { id: 'c10', name: 'メモ 2', type: 'text' });
  assert.deepStrictEqual(M.newCol('number', '', [TITLE]), { id: 'c1', name: '数値', type: 'number', fmt: 'plain' });
  throwsBad(() => M.newCol('title', 'x', COLS), '題名の列は足せない');
  throwsBad(() => M.newCol('formula', 'x', COLS), '知らない種類');
});

test('DS-1・F137: convertCell の表（読める数だけ・選択肢は名前で寄せ、無い名前は選択肢を足す・読めない値は空・リレーションと書けない種類は投げる）', () => {
  const conv = (from, to, v) => M.convertCell(from, to, v);
  // テキスト → 数値
  assert.strictEqual(conv(TXT, NUM, '1,234.5').value, 1234.5);
  assert.strictEqual(conv(TXT, NUM, '１２').value, 12);
  assert.strictEqual(conv(TXT, NUM, ' -3 ').value, -3);
  assert.strictEqual(conv(TXT, NUM, '約 3').value, null);
  assert.strictEqual(conv(TXT, NUM, '明日').value, null);
  // 数値 → テキスト
  assert.strictEqual(conv(NUM, TXT, 12).value, '12');
  // 選択 → 複数選択（名前で寄せる・無い名前は選択肢を足す）
  const toMul = conv(SEL, MUL, 'o1');
  assert.deepStrictEqual(toMul.value, ['o4']);
  assert.deepStrictEqual(toMul.col.opts.at(-1), { id: 'o4', name: '高', color: 'default' });
  assert.strictEqual(MUL.opts.length, 3, 'もとの列は変えない');
  // 複数選択 → 選択（頭の1つ）・ステータス・テキスト
  assert.deepStrictEqual(conv(MUL, { ...SEL, opts: [...SEL.opts, { id: 'o4', name: 'web', color: 'default' }] }, ['o3', 'o1']).value, 'o4', 'Web は web に寄る');
  assert.strictEqual(conv(MUL, TXT, ['o1', 'o2']).value, '会議, 資料');
  const toSta = conv(SEL, STA, 'o2');
  assert.strictEqual(toSta.col.opts.find((o) => o.id === toSta.value).name, '中');
  // テキスト → 複数選択（読点とカンマで分ける）
  const tm = conv(TXT, MUL, '会議、新しい, web');
  assert.deepStrictEqual(tm.value.map((id) => tm.col.opts.find((o) => o.id === id).name), ['会議', '新しい', 'Web']);
  // チェック ⇄ テキスト
  assert.strictEqual(conv(CHK, TXT, true).value, '✓');
  assert.strictEqual(conv(TXT, CHK, 'はい').value, true);
  assert.strictEqual(conv(TXT, CHK, 'TRUE').value, true);
  assert.strictEqual(conv(TXT, CHK, 'いいえ').value, null);
  // テキスト → 日付（書いた形だけ）・URL（形が合うときだけ）・ユーザー
  assert.deepStrictEqual(conv(TXT, DAT, '2026/11/4 9:30').value, { start: '2026-11-04', time: '09:30' });
  assert.strictEqual(conv(TXT, DAT, '来週').value, null);
  assert.strictEqual(conv(TXT, DAT, '2026-02-30').value, null);
  assert.strictEqual(conv(TXT, URL1, 'https://example.com').value, 'https://example.com');
  assert.strictEqual(conv(TXT, URL1, 'javascript:x').value, null);
  assert.deepStrictEqual(conv(TXT, PER, '佐藤、Aoi,佐藤').value, ['佐藤', 'Aoi']);
  // 空は空のまま
  assert.strictEqual(conv(TXT, NUM, null).value, null);
  // リレーション・書けない種類・題名
  const REL = { id: 'r', name: 'つなぐ', type: 'rel', db: 'pdb' };
  throwsBad(() => conv(TXT, REL, 'x'), 'テキスト → リレーション');
  throwsBad(() => conv(REL, TXT, ['rA']), 'リレーション → テキスト');
  throwsBad(() => conv(TXT, { id: 'x', name: 'x', type: 'ctime' }, 'x'), '書けない種類へ');
  throwsBad(() => conv({ id: 'x', name: 'x', type: 'no' }, TXT, 3), '書けない種類から');
});

test('DS-1: fmtCell（数値の見せ方・日付の形・作成者は「自分」・ID の接頭辞・リレーションはゴミ箱の行を出さない）と foldCells', () => {
  assert.strictEqual(M.fmtCell({ ...NUM, fmt: 'comma' }, 1234567.5), '1,234,567.5');
  assert.strictEqual(M.fmtCell({ ...NUM, fmt: 'yen' }, 1200), '¥1,200');
  assert.strictEqual(M.fmtCell({ ...NUM, fmt: 'dollar' }, -5.25), '-$5.25');
  assert.strictEqual(M.fmtCell({ ...NUM, fmt: 'percent' }, 40), '40%');
  assert.strictEqual(M.fmtCell(NUM, 0), '0');
  assert.strictEqual(M.fmtCell(DAT, { start: '2026-11-04' }), '2026/11/04');
  assert.strictEqual(M.fmtCell(DAT, { start: '2026-11-04', time: '10:00' }), '2026/11/04 10:00');
  assert.strictEqual(M.fmtCell(DAT, { start: '2026-11-04', end: '2026-11-08' }), '2026/11/04 → 2026/11/08');
  assert.strictEqual(M.fmtCell(SEL, 'o1'), '高');
  assert.strictEqual(M.fmtCell(MUL, ['o2', 'o1']), '資料, 会議');
  assert.strictEqual(M.fmtCell(CHK, true), '✓');
  assert.strictEqual(M.fmtCell({ id: 'x', name: 'x', type: 'cby' }, 'me'), '自分');
  assert.strictEqual(M.fmtCell({ id: 'x', name: 'x', type: 'mby' }, 'claude'), 'Claude');
  assert.strictEqual(M.fmtCell({ id: 'x', name: 'x', type: 'cby' }, 'system'), 'NaTsu');
  assert.strictEqual(M.fmtCell({ id: 'x', name: 'x', type: 'no', prefix: 'TASK' }, 12), 'TASK-12');
  assert.strictEqual(M.fmtCell({ id: 'x', name: 'x', type: 'no', prefix: '' }, 12), '12');
  const d = new Date('2026-11-04T01:02:00.000Z');
  const p2 = (n) => String(n).padStart(2, '0');
  assert.strictEqual(M.fmtCell({ id: 'x', name: 'x', type: 'ctime' }, d.toISOString()), `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`);
  // リレーションの相手の行の題名（D77 の会議の題名でなく、データベースの行の題名）
  const by = new Map([['rA', { title: '見積もり' }], ['rB', { title: '捨てた', trashed: true }], ['rC', { title: '' }]]);
  assert.strictEqual(M.fmtCell({ id: 'r', name: 'r', type: 'rel', db: 'pdb' }, ['rA', 'rB', 'rC', 'rZ'], { rowsById: by }), '見積もり, 無題のページ');
  assert.strictEqual(M.fmtCell(TXT, null), '');
  // 行の検索の欄: テキスト・URL の文字と選択肢の名前（数・日付・チェック・ユーザーは入れない）
  const f = M.foldCells(COLS, { c1: 'o1', c2: ['o3'], c3: 5, c4: '見積もりの前提', c5: { start: '2026-11-04' }, c6: true, c7: ['佐藤'], c8: 'https://example.com', c9: 'o3' });
  assert.deepStrictEqual(f.split('\n'), ['高', 'Web', '見積もりの前提', 'https://example.com', '完了']);
  // 行の値（題名・作成日時・作成者・ID は行の欄から）
  const r = row('r1', 'a', '計画', { c3: 5 }, { no: 7, by: { c: 'me', u: 'claude' } });
  assert.strictEqual(M.cellValue(r, TITLE), '計画');
  assert.strictEqual(M.cellValue(r, NUM), 5);
  assert.strictEqual(M.cellValue(r, TXT), null);
  assert.strictEqual(M.cellValue(r, { id: 'x', name: 'x', type: 'mby' }), 'claude');
  assert.strictEqual(M.cellValue(r, { id: 'x', name: 'x', type: 'no' }), 7);
});

// ---------------------------------------------------------------- dbView
test('DS-1・F138: compareCells の表（空はいつも最後・選択は選択肢の並び・文字は Unicode の照合・日付は始まり・数値・チェックは偽が先）', () => {
  const sortBy = (col, vals, dir = 'asc') => [...vals].sort((a, b) => V.compareCells(col, a, b, dir));
  assert.deepStrictEqual(sortBy(NUM, [3, null, -1, 10]), [-1, 3, 10, null]);
  assert.deepStrictEqual(sortBy(NUM, [3, null, -1, 10], 'desc'), [10, 3, -1, null], '降順でも空は最後');
  assert.deepStrictEqual(sortBy(SEL, ['o3', 'o1', null, 'o2']), ['o1', 'o2', 'o3', null], '選択肢を並べた順（名前の順でない）');
  assert.deepStrictEqual(sortBy(SEL, ['o3', 'o1', null, 'o2'], 'desc'), ['o3', 'o2', 'o1', null]);
  const ZA = { id: 'cz', name: '段階', type: 'select', opts: [{ id: 'o1', name: 'Zeta', color: 'default' }, { id: 'o2', name: 'Alpha', color: 'default' }, { id: 'o3', name: 'Mid', color: 'default' }] };
  assert.deepStrictEqual(sortBy(ZA, ['o2', 'o3', 'o1']), ['o1', 'o2', 'o3'], '名前の順（Alpha・Mid・Zeta）でなく選択肢を並べた順');
  assert.deepStrictEqual(sortBy({ ...STA, opts: [...STA.opts].reverse() }, ['o1', 'o3']), ['o3', 'o1'], 'ステータスも選択肢を並べた順');
  const coll = new Intl.Collator('ja');
  const words = ['い', 'あ', 'A', 'b', 'ア', 'a'];
  assert.deepStrictEqual(sortBy(TXT, words), [...words].sort(coll.compare));
  assert.deepStrictEqual(sortBy(TXT, words).slice(0, 3), ['a', 'A', 'b'], 'アルファベットが先');
  assert.deepStrictEqual(sortBy(TXT, words).slice(-1), ['い'], '五十音');
  assert.deepStrictEqual(sortBy(DAT, [{ start: '2026-11-05' }, null, { start: '2026-11-04', time: '10:00' }, { start: '2026-11-04' }]),
    [{ start: '2026-11-04' }, { start: '2026-11-04', time: '10:00' }, { start: '2026-11-05' }, null]);
  assert.deepStrictEqual(sortBy(CHK, [true, null, true]), [null, true, true], 'チェックは偽（空）が先');
  assert.deepStrictEqual(sortBy(MUL, [['o2'], ['o1', 'o3'], ['o1'], null]), [['o1'], ['o1', 'o3'], ['o2'], null]);
  assert.strictEqual(V.compareCells(NUM, null, null), 0);
});

test('DS-1・F138: matchFilter の表（かつ／または・入れ子・日付の今日と過去 n 日・複数選択の全部を含む・空）', () => {
  const r = (cells, title = '見積もりの前提') => row('r', 'a', title, cells);
  const c = (col, cmp, value) => (value === undefined ? { col, cmp } : { col, cmp, value });
  const and = (...items) => ({ op: 'and', items });
  const or = (...items) => ({ op: 'or', items });
  assert.ok(V.matchFilter(null, r({}), COLS, NOW), '絞り込みが無ければ通る');
  assert.ok(V.matchFilter(and(c('title', 'contains', '前提')), r({}), COLS, NOW));
  assert.ok(!V.matchFilter(and(c('title', 'notContains', '前提')), r({}), COLS, NOW));
  assert.ok(V.matchFilter(and(c('title', 'startsWith', '見積')), r({}), COLS, NOW));
  assert.ok(V.matchFilter(and(c('c4', 'empty')), r({}), COLS, NOW));
  assert.ok(V.matchFilter(and(c('c4', 'notEmpty')), r({ c4: 'x' }), COLS, NOW));
  // 数値
  assert.ok(V.matchFilter(and(c('c3', 'ge', 10)), r({ c3: 10 }), COLS, NOW));
  assert.ok(!V.matchFilter(and(c('c3', 'gt', 10)), r({ c3: 10 }), COLS, NOW));
  assert.ok(!V.matchFilter(and(c('c3', 'lt', 10)), r({}), COLS, NOW), '空は数の比べに当たらない');
  // かつ／または
  const hi = c('c1', 'any', ['o1']);
  const done = c('c6', 'yes');
  assert.ok(!V.matchFilter(and(hi, done), r({ c1: 'o1' }), COLS, NOW));
  assert.ok(V.matchFilter(or(hi, done), r({ c1: 'o1' }), COLS, NOW), '「または」は1つ当たれば通る');
  assert.ok(V.matchFilter(or(hi, done), r({ c6: true }), COLS, NOW));
  assert.ok(!V.matchFilter(or(hi, done), r({ c1: 'o2' }), COLS, NOW));
  // 入れ子（かつ の中の または の中の かつ: 3 段）
  const tree = and(c('title', 'contains', '前提'), or(done, and(hi, c('c3', 'ge', 100))));
  assert.ok(V.matchFilter(tree, r({ c1: 'o1', c3: 150 }), COLS, NOW));
  assert.ok(!V.matchFilter(tree, r({ c1: 'o1', c3: 50 }), COLS, NOW));
  assert.ok(V.matchFilter(tree, r({ c6: true }), COLS, NOW));
  assert.ok(!V.matchFilter(tree, r({ c6: true }, '別の行'), COLS, NOW));
  // 選択のどれでもない・空
  assert.ok(V.matchFilter(and(c('c1', 'none', ['o1'])), r({ c1: 'o2' }), COLS, NOW));
  assert.ok(V.matchFilter(and(c('c1', 'none', ['o1'])), r({}), COLS, NOW), '空は「どれでもない」に当たる');
  assert.ok(V.matchFilter(and(c('c1', 'empty')), r({}), COLS, NOW));
  // 複数選択の「どれかを含む」と「全部を含む」
  assert.ok(V.matchFilter(and(c('c2', 'anyOf', ['o1', 'o2'])), r({ c2: ['o2', 'o3'] }), COLS, NOW));
  assert.ok(!V.matchFilter(and(c('c2', 'allOf', ['o1', 'o2'])), r({ c2: ['o2', 'o3'] }), COLS, NOW));
  assert.ok(V.matchFilter(and(c('c2', 'allOf', ['o1', 'o2'])), r({ c2: ['o2', 'o3', 'o1'] }), COLS, NOW));
  // 日付（今日は 2026-11-04）
  const at = (s) => r({ c5: { start: s } });
  assert.ok(V.matchFilter(and(c('c5', 'today')), at('2026-11-04'), COLS, NOW));
  assert.ok(!V.matchFilter(and(c('c5', 'today')), at('2026-11-03'), COLS, NOW));
  assert.ok(V.matchFilter(and(c('c5', 'today')), r({ c5: { start: '2026-11-01', end: '2026-11-06' } }), COLS, NOW), '期間が今日を含む');
  assert.ok(V.matchFilter(and(c('c5', 'pastDays', 7)), at('2026-11-04'), COLS, NOW), '過去 7 日は今日を含む');
  assert.ok(V.matchFilter(and(c('c5', 'pastDays', 7)), at('2026-10-29'), COLS, NOW), '過去 7 日の一番古い日');
  assert.ok(!V.matchFilter(and(c('c5', 'pastDays', 7)), at('2026-10-28'), COLS, NOW));
  assert.ok(!V.matchFilter(and(c('c5', 'pastDays', 7)), at('2026-11-05'), COLS, NOW), '明日は過去でない');
  assert.ok(V.matchFilter(and(c('c5', 'nextDays', 3)), at('2026-11-06'), COLS, NOW));
  assert.ok(!V.matchFilter(and(c('c5', 'nextDays', 3)), at('2026-11-07'), COLS, NOW));
  assert.ok(V.matchFilter(and(c('c5', 'before', '2026-11-05')), at('2026-11-04'), COLS, NOW));
  assert.ok(!V.matchFilter(and(c('c5', 'before', '2026-11-04')), at('2026-11-04'), COLS, NOW));
  assert.ok(V.matchFilter(and(c('c5', 'between', { from: '2026-11-01', to: '2026-11-04' })), at('2026-11-04'), COLS, NOW));
  assert.ok(!V.matchFilter(and(c('c5', 'between', { from: '2026-11-01', to: '2026-11-03' })), at('2026-11-04'), COLS, NOW));
  assert.ok(!V.matchFilter(and(c('c5', 'today')), r({}), COLS, NOW), '空の日付は今日でない');
  // チェック・ユーザー
  assert.ok(V.matchFilter(and(c('c6', 'no')), r({}), COLS, NOW));
  assert.ok(V.matchFilter(and(c('c7', 'contains', '佐')), r({ c7: ['佐藤'] }), COLS, NOW));
  // 消した列・無い列の条件は無いのと同じ（normalizeView が落とす）
  assert.ok(V.matchFilter(and(c('cZ', 'contains', 'x')), r({}), COLS, NOW));
});

test('DS-1: normalizeView の表（知らない欄・無い列・消した列・幅 2,000・入れ子 4 段は落とし、ほかは残す。落とした項目の名前を返す）', () => {
  const cols = [...COLS, { id: 'c11', name: '古い', type: 'text', gone: true }];
  const deep = { op: 'and', items: [{ col: 'title', cmp: 'contains', value: '前提' }, { op: 'or', items: [{ col: 'c6', cmp: 'yes' }, { op: 'and', items: [{ col: 'c3', cmp: 'ge', value: 1 }, { op: 'or', items: [{ col: 'c3', cmp: 'le', value: 9 }] }] }] }] };
  const v = {
    id: 'v1', name: '今週', layout: 'table', extra: 1, q: '語',
    props: [{ col: 'c4', show: true, width: 2000 }, { col: 'cZ', show: true }, { col: 'title', show: true, width: 240, wrap: true }, { col: 'c11', show: true }, { col: 'c4', show: false }],
    sort: [{ col: 'c3', dir: 'desc' }, { col: 'c3', dir: 'asc' }, { col: 'cZ', dir: 'asc' }, { col: 'c1', dir: 'up' }],
    filter: deep,
    group: { col: 'c1', hideEmpty: true },
    agg: { c3: 'sum', c4: 'sum', cZ: 'count' },
  };
  const { view, repaired } = V.normalizeView(v, cols);
  assert.strictEqual(view.id, 'v1');
  assert.strictEqual(view.name, '今週');
  assert.strictEqual(view.layout, 'table');
  assert.ok(!('extra' in view) && !('q' in view), '知らない欄と検索の語は残さない');
  assert.deepStrictEqual(view.props.slice(0, 2), [{ col: 'c4', show: true, wrap: false }, { col: 'title', show: true, width: 240, wrap: true }], '幅 2,000 は落とし、列は残す');
  assert.ok(!view.props.some((p) => p.col === 'cZ' || p.col === 'c11'), '無い列と消した列の設定は落とす');
  assert.deepStrictEqual(view.props.map((p) => p.col).sort(), COLS.map((c) => c.id).sort(), 'ビューに無い列は後ろに足す');
  assert.deepStrictEqual(view.sort, [{ col: 'c3', dir: 'desc' }]);
  assert.deepStrictEqual(view.filter.items[1].items[1].items.length, 1, '4 段目のグループは落とし、3 段目の条件は残す');
  assert.deepStrictEqual(view.filter.items[1].items[1].items[0], { col: 'c3', cmp: 'ge', value: 1 });
  assert.deepStrictEqual(view.group, { col: 'c1', hideEmpty: true });
  assert.deepStrictEqual(view.agg, { c3: 'sum' }, '数でない列の合計・無い列の集計は落とす');
  for (const k of ['extra', 'q', 'props', 'sort', 'filter', 'agg']) assert.ok(repaired.includes(k), `落とした項目 ${k}`);
  assert.ok(!repaired.includes('group') && !repaired.includes('name'));
  // 壊れていなければ何も落とさない
  const again = V.normalizeView(view, cols);
  assert.deepStrictEqual(again.repaired, []);
  assert.deepStrictEqual(again.view, view);
  // 全部が壊れていても、既定のビューの形（表・題名の列）
  const broken = V.normalizeView({ id: 'v2', name: 5, layout: 'board', props: 'x', sort: {}, filter: [], group: 'x', agg: [] }, COLS);
  assert.strictEqual(broken.view.layout, 'table');
  assert.strictEqual(broken.view.name, '表');
  assert.strictEqual(broken.view.filter, null);
  assert.strictEqual(broken.view.group, null);
  assert.deepStrictEqual(broken.view.sort, []);
  // 絞り込みの条件の値の形・列の種類に無い条件
  const f = V.normalizeView({ id: 'v3', name: 'x', layout: 'list', filter: { op: 'and', items: [{ col: 'c3', cmp: 'contains', value: 'x' }, { col: 'c3', cmp: 'gt', value: '5' }, { col: 'c5', cmp: 'pastDays', value: 7 }, { col: 'c1', cmp: 'any', value: ['o9'] }] } }, COLS);
  assert.deepStrictEqual(f.view.filter.items, [{ col: 'c5', cmp: 'pastDays', value: 7 }]);
  assert.ok(f.repaired.includes('filter'));
  assert.deepStrictEqual(f.view.props.filter((p) => p.show).map((p) => p.col), ['title'], 'リストは題名だけを出して始まる');
  const hid = V.normalizeView({ id: 'v4', name: 'x', layout: 'table', props: [{ col: 'title', show: false }] }, COLS);
  assert.strictEqual(hid.view.props.find((p) => p.col === 'title').show, true, '題名の列は隠せない');
  assert.deepStrictEqual(hid.repaired, ['props']);
  assert.ok(V.FILTER_OPS.text.includes('contains') && V.FILTER_OPS.number.includes('ge') && V.FILTER_OPS.date.includes('pastDays'));
  assert.deepStrictEqual(V.FILTER_OPS.select, ['any', 'none', 'empty']);
  assert.deepStrictEqual(V.FILTER_OPS.multi, ['anyOf', 'allOf', 'empty']);
});

test('DS-1・F138: applyView の表（絞り込み → 並べ替え → グループ・集計は絞り込んだ後の行・検索の語・並べ替えの無いビューは ord の順）', () => {
  const rows = [
    row('r1', 'c', '見積もり', { c1: 'o2', c3: 300, c4: '前提の確認', c6: true }),
    row('r2', 'a', '議題', { c1: 'o1', c3: 100 }),
    row('r3', 'b', '日程', { c3: 200, c2: ['o1', 'o2'] }),
    row('r4', 'd', '資料', { c1: 'o1', c3: 50 }, { createdAt: '2026-10-01T00:00:00.000Z' }),
  ];
  const base = V.defaultView('v1', 'table', COLS);
  const ids = (r) => r.order.map((x) => x.id);
  // 並べ替えの無いビューは ord の順（作った順でない）
  assert.deepStrictEqual(ids(V.applyView(rows, base, COLS, { now: NOW })), ['r2', 'r3', 'r1', 'r4']);
  // 並べ替え（数値の降順）・重ねる（選択の昇順 → 数値の昇順）
  assert.deepStrictEqual(ids(V.applyView(rows, { ...base, sort: [{ col: 'c3', dir: 'desc' }] }, COLS, { now: NOW })), ['r1', 'r3', 'r2', 'r4']);
  assert.deepStrictEqual(ids(V.applyView(rows, { ...base, sort: [{ col: 'c1', dir: 'asc' }, { col: 'c3', dir: 'asc' }] }, COLS, { now: NOW })), ['r4', 'r2', 'r1', 'r3']);
  // 絞り込みと集計（絞り込んだ後の行で数える。title はデータベースの題名の列の ID で、D77 の会議の題名でない）
  const fv = { ...base, filter: { op: 'and', items: [{ col: 'c3', cmp: 'ge', value: 100 }] }, agg: { c3: 'sum', title: 'count', c6: 'checked' } };
  const fr = V.applyView(rows, fv, COLS, { now: NOW });
  assert.deepStrictEqual(ids(fr), ['r2', 'r3', 'r1']);
  assert.strictEqual(fr.total, 3);
  assert.deepStrictEqual(fr.agg, { c3: 600, title: 3, c6: 1 });
  // 検索の語（題名・テキストの列・選択肢の名前。0.10.0 の検索と同じ寄せ方 searchFold: 全角半角・大文字小文字）
  assert.deepStrictEqual(ids(V.applyView(rows, base, COLS, { now: NOW, q: '前提' })), ['r1']);
  assert.deepStrictEqual(ids(V.applyView(rows, base, COLS, { now: NOW, q: '会議' })), ['r3']);
  assert.deepStrictEqual(ids(V.applyView(rows, base, COLS, { now: NOW, q: '高' })), ['r2', 'r4']);
  assert.strictEqual(V.applyView(rows, base, COLS, { now: NOW, q: '前提' }).total, 1);
  // グループ（選択: どの選択肢にもグループ・空のグループを隠す・空の行は最後のグループ）
  const gv = { ...base, group: { col: 'c1' } };
  const gr = V.applyView(rows, gv, COLS, { now: NOW });
  assert.deepStrictEqual(gr.groups.map((g) => [g.key, g.count]), [['o1', 2], ['o2', 1], ['o3', 0], ['', 1]]);
  assert.deepStrictEqual(gr.order.map((x) => [x.id, x.g]), [['r2', 0], ['r4', 0], ['r1', 1], ['r3', 3]]);
  const hr = V.applyView(rows, { ...base, group: { col: 'c1', hideEmpty: true } }, COLS, { now: NOW });
  assert.deepStrictEqual(hr.groups.map((g) => g.key), ['o1', 'o2', ''], '行の無いグループを隠す');
  // 隠したグループ（目のアイコン）は数だけ残し、行は出さない・手の並び
  const hid = V.applyView(rows, { ...base, group: { col: 'c1', hide: ['o1'], order: ['o2', ''] } }, COLS, { now: NOW });
  assert.deepStrictEqual(hid.groups.map((g) => [g.key, g.count, Boolean(g.hidden)]), [['o2', 1, false], ['', 1, false], ['o1', 2, true], ['o3', 0, false]]);
  assert.deepStrictEqual(ids(hid), ['r1', 'r3']);
  // 複数選択のグループは、どの選択肢にも行が出る
  const mg = V.applyView(rows, { ...base, group: { col: 'c2', hideEmpty: true } }, COLS, { now: NOW });
  assert.deepStrictEqual(mg.groups.map((g) => [g.key, g.count]), [['o1', 1], ['o2', 1], ['', 3]]);
  assert.deepStrictEqual(mg.order.filter((x) => x.id === 'r3').map((x) => x.g), [0, 1]);
  // 降順のグループ・チェックのグループ
  const cg = V.applyView(rows, { ...base, group: { col: 'c6' } }, COLS, { now: NOW });
  assert.deepStrictEqual(cg.groups.map((g) => [g.key, g.count]), [['false', 3], ['true', 1]]);
  // ステータスは3つのまとまり
  const sg = V.applyView([row('s1', 'a', 'x', { c9: 'o3' }), row('s2', 'b', 'y', {})], { ...base, group: { col: 'c9' } }, COLS, { now: NOW });
  assert.deepStrictEqual(sg.groups.map((g) => [g.key, g.count]), [['todo', 1], ['doing', 0], ['done', 1]], '空のステータスは未着手');
});

test('DS-1: aggregate の表（全件・値のある件数・異なる値・空の割合・数値の合計と中央値・日付の期間・チェックの割合）と、列の種類ごとの集計の名前', () => {
  assert.strictEqual(V.aggregate(NUM, [1, 2, null, 10], 'count'), 4);
  assert.strictEqual(V.aggregate(NUM, [1, 2, null, 10], 'filled'), 3);
  assert.strictEqual(V.aggregate(NUM, [1, 2, null, 10], 'empty'), 1);
  assert.strictEqual(V.aggregate(NUM, [1, 2, null, 10], 'emptyPct'), 25);
  assert.strictEqual(V.aggregate(NUM, [1, 2, null, 10], 'sum'), 13);
  assert.strictEqual(V.aggregate(NUM, [1, 2, null, 10], 'avg'), 13 / 3);
  assert.strictEqual(V.aggregate(NUM, [1, 2, null, 10], 'median'), 2);
  assert.strictEqual(V.aggregate(NUM, [1, 2, 4, 10], 'median'), 3);
  assert.strictEqual(V.aggregate(NUM, [1, 2, null, 10], 'range'), 9);
  assert.strictEqual(V.aggregate(NUM, [null], 'avg'), null);
  assert.strictEqual(V.aggregate(SEL, ['o1', 'o1', 'o2', null], 'unique'), 2);
  assert.strictEqual(V.aggregate(MUL, [['o1', 'o2'], ['o2'], null], 'unique'), 2);
  assert.strictEqual(V.aggregate(DAT, [{ start: '2026-11-04' }, { start: '2026-11-01', end: '2026-11-02' }, null], 'earliest'), '2026-11-01');
  assert.strictEqual(V.aggregate(DAT, [{ start: '2026-11-04' }, { start: '2026-11-01', end: '2026-11-02' }], 'latest'), '2026-11-04');
  assert.strictEqual(V.aggregate(DAT, [{ start: '2026-11-04' }, { start: '2026-11-01' }], 'range'), 3);
  assert.strictEqual(V.aggregate(CHK, [true, null, null, true], 'checked'), 2);
  assert.strictEqual(V.aggregate(CHK, [true, null, null, true], 'uncheckedPct'), 50);
  assert.strictEqual(V.aggregate(TXT, [], 'emptyPct'), 0);
  assert.ok(V.AGG_KINDS(NUM).includes('median') && !V.AGG_KINDS(TXT).includes('sum') && V.AGG_KINDS(DAT).includes('range') && V.AGG_KINDS(CHK).includes('checkedPct'));
});

test('DS-1・F139: windowOf の表（1万行・高さのばらつく行で、見える行と上下 50 行）', () => {
  const total = 10000;
  const heights = new Map();
  for (let i = 0; i < 300; i += 1) heights.set(i, i % 3 === 0 ? 64 : 32);   // 読んだ行の高さ（折り返しで 64）
  // 頭
  const top = V.windowOf({ scrollTop: 0, viewHeight: 640, heights, defaultHeight: 32, total });
  assert.strictEqual(top.from, 0);
  assert.strictEqual(top.before, 0);
  // 640px に入る行: 64+32+32 の繰り返しで 128px に 3 行 → 15 行（0〜14）。上下 50 行で 0〜64
  assert.strictEqual(top.count, 65);
  // 真ん中（高さを知らない行は既定の高さ）
  const sumTo = (n) => { let s = 0; for (let i = 0; i < n; i += 1) s += heights.get(i) ?? 32; return s; };
  const mid = V.windowOf({ scrollTop: sumTo(5000), viewHeight: 320, heights, defaultHeight: 32, total });
  assert.strictEqual(mid.from, 4950);
  assert.strictEqual(mid.count, 50 + 10 + 50);
  assert.strictEqual(mid.before, sumTo(4950));
  assert.strictEqual(mid.before + sumTo(mid.from + mid.count) - sumTo(mid.from) + mid.after, sumTo(total), '上と下の余白と行の高さの和は全部の高さ');
  // 終わり（捲り過ぎても行の数を越えない）
  const end = V.windowOf({ scrollTop: sumTo(total) + 5000, viewHeight: 320, heights, defaultHeight: 32, total });
  assert.strictEqual(end.from + end.count, total);
  assert.strictEqual(end.after, 0);
  assert.ok(end.count <= 51 + 10);
  // 行が無い
  assert.deepStrictEqual(V.windowOf({ scrollTop: 0, viewHeight: 320, heights: new Map(), defaultHeight: 32, total: 0 }), { from: 0, count: 0, before: 0, after: 0 });
});

test('DS-1・F139: 1万行の applyView（絞り込み・2つの列の並べ替え・グループ・集計・検索の語）が 200 ミリ秒以内（3 回の中央値）', () => {
  const rows = [];
  for (let i = 0; i < 10000; i += 1) {
    rows.push(row(`r${i}`, `k${String(i).padStart(5, '0')}`, `行 ${i} の題名`, {
      c1: ['o1', 'o2', 'o3'][i % 3], c2: i % 5 === 0 ? ['o1', 'o3'] : ['o2'], c3: (i * 7919) % 1000, c4: `メモ ${i % 97}`,
      c5: { start: `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}` }, ...(i % 2 ? { c6: true } : {}),
    }));
  }
  const view = {
    ...V.defaultView('v1', 'table', COLS),
    filter: { op: 'or', items: [{ col: 'c3', cmp: 'ge', value: 300 }, { op: 'and', items: [{ col: 'c1', cmp: 'any', value: ['o1'] }, { col: 'c4', cmp: 'contains', value: '1' }] }] },
    sort: [{ col: 'c1', dir: 'desc' }, { col: 'title', dir: 'asc' }],
    group: { col: 'c2' },
    agg: { c3: 'median', c5: 'range', c6: 'checkedPct' },
  };
  const times = [];
  let out;
  for (let k = 0; k < 3; k += 1) {
    const t0 = process.hrtime.bigint();
    out = V.applyView(rows, view, COLS, { now: NOW, q: '題名' });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  assert.ok(out.total > 5000 && out.total < 10000, `絞り込んだ数 ${out.total}`);
  assert.ok(times[1] <= 200, `1万行の applyView の中央値 ${times[1].toFixed(1)} ミリ秒`);
});

// ---------------------------------------------------------------- DS-1 直し（2026-11-07 の点検 rv38。計画の R18〜R27）
test('DS-1 直し・F6: R5 の日付の絞り込みの表（前は始まり・後は終わり・その日は期間・間は始まり・次の n 日は今日を含む）と、今日・作成日時の日はその PC の時刻', () => {
  assert.strictEqual(new Date(NOW).toISOString().slice(0, 10), '2026-11-03', '偽の今は UTC ではまだ前の日');
  const c = (cmp, value) => ({ op: 'and', items: [value === undefined ? { col: 'c5', cmp } : { col: 'c5', cmp, value }] });
  const span = row('r', 'a', '期間', { c5: { start: '2026-11-01', end: '2026-11-06' } });
  const day = (d) => row('r', 'a', '日', { c5: { start: d } });
  assert.ok(V.matchFilter(c('before', '2026-11-02'), span, COLS, NOW), '前は始まりの日で見る');
  assert.ok(V.matchFilter(c('after', '2026-11-05'), span, COLS, NOW), '後は終わりの日で見る');
  assert.ok(!V.matchFilter(c('after', '2026-11-06'), span, COLS, NOW));
  assert.ok(V.matchFilter(c('on', '2026-11-03'), span, COLS, NOW), 'その日は期間に入るか');
  assert.ok(!V.matchFilter(c('on', '2026-11-07'), span, COLS, NOW));
  assert.ok(!V.matchFilter(c('between', { from: '2026-11-05', to: '2026-11-07' }), span, COLS, NOW), '間は始まりの日で見る');
  assert.ok(V.matchFilter(c('between', { from: '2026-10-30', to: '2026-11-01' }), span, COLS, NOW));
  assert.ok(V.matchFilter(c('nextDays', 3), day('2026-11-04'), COLS, NOW), '次の n 日は今日を含む');
  assert.ok(V.matchFilter(c('today'), day('2026-11-04'), COLS, NOW), '今日はその PC の時刻の日（UTC の日でない）');
  assert.ok(!V.matchFilter(c('today'), day('2026-11-03'), COLS, NOW));
  // 作成日時（UTC の 11-03 16:00 は東京の 11-04 01:00）
  const CT = { id: 'c10', name: '作成日時', type: 'ctime' };
  const made = row('r', 'a', '作った', {}, { createdAt: '2026-11-03T16:00:00.000Z' });
  assert.ok(V.matchFilter({ op: 'and', items: [{ col: 'c10', cmp: 'today' }] }, made, [...COLS, CT], NOW), '作成日時の日はその PC の時刻の日');
  assert.ok(V.matchFilter({ op: 'and', items: [{ col: 'c10', cmp: 'on', value: '2026-11-04' }] }, made, [...COLS, CT], NOW));
  assert.strictEqual(M.fmtCell(CT, '2026-11-03T16:00:00.000Z'), '2026/11/04 01:00', '作成日時はその PC の時刻で見せる');
  // 時計を渡さない matchFilter は今の時刻（NaN の日にしない: F12）
  const todayRow = row('r', 'a', '今日', { c5: { start: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })() } });
  assert.ok(V.matchFilter(c('today'), todayRow, COLS));
});

test('DS-1 直し・F6: 表に足した行（R9 の値のある件数・R7 の y・ステータスの選択肢ごとのグループ・リレーションの重なり・メールの見えない文字・消した列の検索・新しいステータスの選択肢・チェックの降順・空の数と ≠・週は月曜から・日付の既定は月・同じ値は並びの鍵）', () => {
  const AT = '@';
  assert.strictEqual(V.aggregate(MUL, [['o1', 'o2'], ['o2'], null], 'values'), 3, '値のある件数は値ごと');
  assert.strictEqual(V.aggregate(MUL, [['o1', 'o2'], ['o2'], null], 'filled'), 2);
  assert.strictEqual(M.convertCell(TXT, CHK, 'y').value, true);
  assert.strictEqual(M.convertCell(TXT, CHK, 'Y').value, true);
  const base = V.defaultView('v1', 'table', COLS);
  const sg = V.applyView([row('s1', 'a', 'x', { c9: 'o3' }), row('s2', 'b', 'y', {})], { ...base, group: { col: 'c9', by: 'option' } }, COLS, { now: NOW });
  assert.deepStrictEqual(sg.groups.map((g) => [g.key, g.count]), [['o1', 0], ['o2', 0], ['o3', 1], ['', 1]], 'ステータスを選択肢ごと');
  throwsBad(() => M.cellOf({ id: 'r', name: 'つなぐ', type: 'rel', db: 'pdb' }, ['rA', 'rA']), 'リレーションの重なり');
  throwsBad(() => M.cellOf({ id: 'e', name: 'メール', type: 'email' }, `a\u200b${AT}example.com`), 'メールの見えない文字');
  assert.strictEqual(M.foldCells([TITLE, { ...TXT, gone: true }], { c4: '消した列の文字' }), '', '消した列は検索の欄に入れない');
  const st = M.addOpt(STA, '保留');
  assert.ok(st.col.groups.todo.includes(st.id) && !st.col.groups.done.includes(st.id), '新しいステータスの選択肢は未着手');
  assert.deepStrictEqual([null, true, null].sort((a, b) => V.compareCells(CHK, a, b, 'desc')), [true, null, null], 'チェックの降順は済みが先');
  assert.ok(V.matchFilter({ op: 'and', items: [{ col: 'c3', cmp: 'ne', value: 10 }] }, row('r', 'a', 'x', {}), COLS, NOW), '空の数は「≠」に当たる');
  const dates = [row('d1', 'a', 'x', { c5: { start: '2026-11-04' } }), row('d2', 'b', 'y', { c5: { start: '2026-11-08' } }), row('d3', 'c', 'z', { c5: { start: '2026-11-09' } }), row('d4', 'd', 'w', { c5: { start: '2026-12-01' } })];
  assert.deepStrictEqual(V.applyView(dates, { ...base, group: { col: 'c5', by: 'week' } }, COLS, { now: NOW }).groups.map((g) => [g.key, g.count]),
    [['2026-11-02', 2], ['2026-11-09', 1], ['2026-11-30', 1]], '週は月曜から（11-08 の日曜は 11-02 の週）');
  assert.deepStrictEqual(V.applyView(dates, { ...base, group: { col: 'c5' } }, COLS, { now: NOW }).groups.map((g) => [g.key, g.count]), [['2026-11', 3], ['2026-12', 1]], '日付の既定は月ごと');
  const same = [row('t1', 'q', 'x', { c3: 5 }), row('t2', 'b', 'y', { c3: 5 }), row('t3', 'k', 'z', { c3: 1 })];
  assert.deepStrictEqual(V.applyView(same, { ...base, sort: [{ col: 'c3', dir: 'asc' }] }, COLS, { now: NOW }).order.map((o) => o.id), ['t3', 't2', 't1'], '同じ値は並びの鍵の順');
});

test('DS-1 直し・F1〜F5・F7〜F9・F11・F13: グループの長い鍵・出す行の数・検索の欄の境・記号だけの絞り込み・4 桁の年・見えない文字・消えた選択肢・指数の数・最終更新の既定・リレーションどうし・色の表・住所の利用者の欄', () => {
  const AT = '@';
  // F1: テキストの値のグループの鍵は 64 字を越えてもよい。悪い鍵だけを落とす
  const long = 'あ'.repeat(300);
  const g = V.normalizeView({ id: 'v', name: 'x', layout: 'table', group: { col: 'c4', hide: [long, 'short', 5], order: [long] } }, COLS);
  assert.deepStrictEqual(g.view.group, { col: 'c4', hide: [long, 'short'], order: [long] });
  assert.deepStrictEqual(g.repaired, ['group']);
  // F2: グループで行がいくつものグループに出るとき、total は絞り込んだ行の数・shown は並べる行の数（窓はこれで切る）
  const base = V.defaultView('v1', 'table', COLS);
  const mg = V.applyView([row('m1', 'a', 'x', { c2: ['o1', 'o2'] }), row('m2', 'b', 'y', { c2: ['o1'] })], { ...base, group: { col: 'c2', hide: ['o2'] } }, COLS, { now: NOW });
  assert.deepStrictEqual([mg.total, mg.shown, mg.order.length], [2, 2, 2]);
  const mg2 = V.applyView([row('m1', 'a', 'x', { c2: ['o1', 'o2'] }), row('m2', 'b', 'y', { c2: ['o1'] })], { ...base, group: { col: 'c2' } }, COLS, { now: NOW });
  assert.deepStrictEqual([mg2.total, mg2.shown], [2, 3]);
  assert.strictEqual(V.applyView([row('m1', 'a', 'x')], base, COLS, { now: NOW }).shown, 1);
  // F3: データベースの中の検索は欄をまたいで当たらない
  const cross = [row('x1', 'a', '題', { c4: 'ab', c8: 'https://example.com', c2: ['o1', 'o2'] })];
  assert.deepStrictEqual(V.applyView(cross, base, COLS, { now: NOW, q: 'bhttps' }).order, []);
  assert.deepStrictEqual(V.applyView(cross, base, COLS, { now: NOW, q: '議資' }).order, []);
  assert.deepStrictEqual(V.applyView(cross, base, COLS, { now: NOW, q: '題ab' }).order, []);
  assert.strictEqual(V.applyView(cross, base, COLS, { now: NOW, q: 'example' }).order.length, 1);
  // F4: 寄せると空になる文字（記号だけ）の絞り込みは落とす
  const f = V.normalizeView({ id: 'v', name: 'x', layout: 'table', filter: { op: 'and', items: [{ col: 'c4', cmp: 'contains', value: '・' }, { col: 'c4', cmp: 'is', value: ' - ' }] } }, COLS);
  assert.strictEqual(f.view.filter, null);
  // F5: 年は 1000〜9999
  throwsBad(() => M.cellOf(DAT, { start: '0999-03-03' }), '3 桁の年');
  assert.deepStrictEqual(M.cellOf(DAT, { start: '1000-01-01' }), { start: '1000-01-01' });
  assert.strictEqual(M.convertCell(TXT, DAT, '0050/3/3').value, null);
  // F7: 見えない文字・向きの文字・空に見える文字は名前と住所に入れない（絵文字の合わせの文字は名前に入れてよい）
  for (const bad of ['W\u00adeb', '\u3164', 'a\u061cb', 'a\u180eb', 'a\u034fb', '\u2800', 'a\u2028b']) assert.ok(!M.optNameOk([{ id: 'o1', name: 'Web', color: 'default' }], bad), `名前 ${JSON.stringify(bad)}`);
  for (const good of ['❤\ufe0f', '👩\u200d💻', '🔥 急ぎ']) assert.ok(M.optNameOk([], good), `名前 ${good}`);
  // DS-2 直し（rv40 F3・F4・R43）: 絵文字の合わせの文字の境目（絵文字でない文字の後の U+FE0F・二重の U+FE0F・後ろに絵文字の無い U+200D）と、
  // 既定で見えない文字・対の無いサロゲート・私用・割り当ての無い文字・結合の文字だけの名前は断る。絵文字の違いだけの名前は重なりと見る
  for (const bad of ['\u{1F600}\u200d', '\u{1F600}\u200da', 'a\ufe0f', '高\ufe0f', '\u{1F600}\ufe0f\ufe0f', '高\u{E0100}', 'a\u180bb', 'a\u17b4b', '\u0378', '\ue000', 'a\ud800', '\u0301']) {
    assert.ok(!M.optNameOk([], bad), `名前 ${JSON.stringify(bad)}`);
  }
  throwsBad(() => M.cellOf(PER, ['山\u{E0100}']), '人の名前の異体字の選び');
  for (const [a, b] of [['\u{1F600}', '\u{1F600}\ufe0f'], ['\u{1F600}\u{1F600}', '\u{1F600}\u200d\u{1F600}'], ['\u00a9', '\u00a9\ufe0f']]) {
    assert.ok(M.optNameOk([], a) && M.optNameOk([], b), `名前 ${JSON.stringify([a, b])}`);
    assert.ok(!M.optNameOk([{ id: 'o1', name: a, color: 'default' }], b), `重なり ${JSON.stringify([a, b])}`);
  }
  throwsBad(() => M.cellOf(URL1, 'https://exa\u00admple.com'), '住所の見えない文字');
  throwsBad(() => M.cellOf(PER, ['佐\u200b藤']), '人の名前の見えない文字');
  // F8: 消えた選択肢の ID を含む複数選択は、分かる名前だけを読み替える
  assert.strictEqual(M.convertCell(MUL, TXT, ['o1', 'o9']).value, '会議');
  // F9: 指数の形の数も読める（NaTsu が数を文字にした形）
  assert.strictEqual(M.convertCell(TXT, NUM, '1e+21').value, 1e21);
  assert.strictEqual(M.convertCell(TXT, NUM, '1e-7').value, 1e-7);
  assert.strictEqual(M.convertCell(NUM, NUM, 1e21).value, 1e21);
  assert.strictEqual(M.convertCell(TXT, NUM, M.convertCell(NUM, TXT, 1e-7).value).value, 1e-7, '数 → 文字 → 数で同じ');
  // F11 (a): 最終更新日時・最終更新者が無ければ作成日時・作成者
  // データベースの行の題名（D77 の会議の題名でない）
  const old = { id: 'r', ord: 'a', title: 'x', cells: {}, createdAt: '2026-11-01T00:00:00.000Z', by: { c: 'claude' }, no: 1 };
  assert.strictEqual(M.cellValue(old, { id: 'x', name: 'x', type: 'mtime' }), '2026-11-01T00:00:00.000Z');
  assert.strictEqual(M.cellValue(old, { id: 'x', name: 'x', type: 'mby' }), 'claude');
  // F11 (d): リレーションからリレーションへは値のまま
  const REL = { id: 'r', name: 'つなぐ', type: 'rel', db: 'pdb' };
  assert.deepStrictEqual(M.convertCell(REL, { ...REL, id: 'r2' }, ['rA']).value, ['rA']);
  // F11 (f): 選択肢の色は既定と、行の色の9色（src/richText.js の COLORS）
  assert.deepStrictEqual(M.OPT_COLORS, ['default', ...require('../src/richText.js').COLORS]);
  // F13: 住所に利用者の欄（@ の前）を入れない（見た目の住所を偽らせない: SEC2）
  throwsBad(() => M.cellOf(URL1, `https://trusted.example${AT}evil.example/`), '住所の利用者の欄');
  throwsBad(() => M.cellOf(URL1, `https://user:pw${AT}example.com`), '住所の利用者の欄と暗証');
  assert.strictEqual(M.cellOf(URL1, `https://example.com/a${AT}b`), `https://example.com/a${AT}b`, '道の中の @ はよい');
});
