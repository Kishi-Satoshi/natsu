'use strict';
/* memoTypes.test.js — 0.11.0 M-1（MT1・MT2・F14。計画 docs/plans/2026-10-22-110.md の「型の表（MT1 改）」）: 型の表・種類から型・雛形・手を付けていないメモ・見出しの形 */
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/memoTypes');

// 計画の型の表（名前・見出し・ヒント）をそのまま写した表
const TABLE = [
  ['points', '会議の要点（論点整理）', [['目的', '共有・相談・決定のどれのための会議か（冒頭で言われた場合）'], ['論点ごとの要点', '発言の順でなく論点ごとに、出た意見と結論に至った理由']]],
  ['report', '進捗・報告の確認（空・雨・傘）', [['前回の宿題の状況', '済んだか・遅れているか'], ['事実（進捗・課題）', 'いま起きていること'], ['見立て（原因・リスク）', '発言者が言った原因やこれからの見通し'], ['打ち手の案', '出た対策の案']]],
  ['present', 'プレゼン形式（要旨・質疑）', [['発表の要旨', '何を伝えたか（結論を先に）'], ['質疑応答', '質問と答えの組'], ['出た意見・懸念', '聞き手の意見や気がかり']]],
  ['bantc', '商談の確認（BANTC）', [['課題・要望（N）', '先方の課題と求めていること'], ['時期（T）', '導入・開始したい時期'], ['決め方・決裁者（A）', '誰が決めるか・稟議の流れ'], ['予算（B）', '金額や予算の枠'], ['競合・比較先（C）', '他社の検討状況']]],
  ['grow', '1on1の振り返り（GROW）', [['テーマ・目標（G）', '本人が取り上げたテーマや目指すこと'], ['現状と困りごと（R）', 'いまの状況とつまずき'], ['選択肢・上司の助言（O）', '検討した選択肢と助言']]],
  ['star', '面接の確認（STAR）', [['経歴・スキル', '本人が話した事実'], ['行動の具体例', '状況・役割・行動・結果'], ['本人からの質問・懸念', '本人から出た質問や気がかり'], ['条件', '稼働開始時期・働き方など話した範囲']]],
];

test('MT1: 6 つの型がこの順で、名前・見出し・ヒントが計画の型の表と同じ', () => {
  assert.deepStrictEqual([...M.MEMO_ORDER], TABLE.map((r) => r[0]));
  for (const [key, label, heads] of TABLE) {
    const t = M.MEMO_TYPES[key];
    assert.strictEqual(t.label, label, key);
    assert.deepStrictEqual(t.headings.map((h) => [h.name, h.hint]), heads, key);
    assert.ok(Array.isArray(t.rules) && t.rules.length > 0, `${key} の決まり`);
  }
  assert.deepStrictEqual(M.MEMO_TYPES.report.headings.filter((h) => h.group).map((h) => h.name), ['事実（進捗・課題）', '見立て（原因・リスク）', '打ち手の案']);
});

test('MT1・D42: memoTypeOf の表（種類から型。決まらない・前の版の general・知らない種類は会議の要点）', () => {
  const want = { standup: 'report', review: 'report', brainstorm: 'points', oneonone: 'grow', interview: 'star', sales: 'bantc', present: 'present',
    '': 'points', general: 'points', nope: 'points', constructor: 'points', toString: 'points' };
  for (const [k, v] of Object.entries(want)) assert.strictEqual(M.memoTypeOf(k), v, `「${k}」`);
  assert.strictEqual(M.memoTypeOf(undefined), 'points');
  assert.strictEqual(M.memoTypeOf(null), 'points');
  assert.strictEqual(M.memoTypeOf(3), 'points');
});

test('MT2: 雛形は「■ 見出し」だけで、ヒントの文を含まない。知らない型は空', () => {
  assert.strictEqual(M.memoPreset('bantc'), '■ 課題・要望（N）\n\n■ 時期（T）\n\n■ 決め方・決裁者（A）\n\n■ 予算（B）\n\n■ 競合・比較先（C）\n');
  for (const [key, , heads] of TABLE) {
    const p = M.memoPreset(key);
    for (const [, hint] of heads) assert.ok(!p.includes(hint), `${key} の雛形にヒント`);
    assert.deepStrictEqual(p.split('\n').filter(Boolean), heads.map(([n]) => `■ ${n}`));
  }
  assert.strictEqual(M.memoPreset('nope'), '');
  assert.strictEqual(M.memoPreset(''), '');
  assert.strictEqual(M.memoPreset('__proto__'), '');
});

test('F14・RF73: isUntouchedMemo の表（空・どの雛形も・今のアジェンダの雛形は手を付けていない。人の文は1文字でも手を付けた）', () => {
  const legacy = ['議題:\n・各担当の進捗報告\n・課題・相談ごと'];
  const yes = ['', '   ', '\n\n \r\n', null, undefined,
    ...M.MEMO_ORDER.map((k) => M.memoPreset(k)),
    M.memoPreset('grow').replace(/\n/g, '\r\n'),
    M.memoPreset('star').replace(/\n\n/g, '\n'),
    M.memoPreset('points').replace(/\n/g, '  \n\n\n'),
    '  ■ 目的  \n■ 論点ごとの要点',
    legacy[0], `${legacy[0]}\n\n`];
  for (const m of yes) assert.strictEqual(M.isUntouchedMemo(m, legacy), true, JSON.stringify(m));
  const no = [`${M.memoPreset('bantc')}あ`, M.memoPreset('bantc').replace('■ 予算（B）\n\n', ''), '予算は 300 万円', '■ 目的\n予算の相談',
    `${legacy[0]}\n・予算`, '■ 目的'];
  for (const m of no) assert.strictEqual(M.isUntouchedMemo(m, legacy), false, JSON.stringify(m));
  assert.strictEqual(M.isUntouchedMemo(legacy[0]), false, 'legacy を渡さなければアジェンダは人の文');
});

test('headingKey: 「■ 予算（B）」「## 予算（B）」「**予算（B）**」「予算 （B）」は同じ形。違う見出しは違う形', () => {
  const k = M.headingKey('予算（B）');
  for (const t of ['■ 予算（B）', '## 予算（B）', '**予算（B）**', '予算 （B）', '  ■予算(B)', '#### 予算（Ｂ）']) assert.strictEqual(M.headingKey(t), k, t);
  assert.notStrictEqual(M.headingKey('決め方・決裁者（A）'), k);
  assert.strictEqual(M.headingKey(''), '');
  assert.strictEqual(M.headingKey(null), '');
});

test('presetLines と listMemoTypes: 6 つの雛形を { agenda } で返し、画面用の表は型の表の写し（受けた側が書き換えても表は変わらない）', () => {
  assert.deepStrictEqual(M.presetLines().map((x) => x.agenda), M.MEMO_ORDER.map((k) => M.memoPreset(k)));
  const list = M.listMemoTypes();
  assert.deepStrictEqual(list.map((x) => x.key), [...M.MEMO_ORDER]);
  assert.strictEqual(list[3].preset, M.memoPreset('bantc'));
  list[0].headings[0].name = 'x';
  list[0].rules.push('x');
  assert.strictEqual(M.MEMO_TYPES.points.headings[0].name, '目的');
  assert.ok(!M.MEMO_TYPES.points.rules.includes('x'));
});
