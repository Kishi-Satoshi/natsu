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

// ---------------------------------------------------------------- 0.11.0 M-2（MT4〜MT7・F9・F15。決めたこと 14〜16・19〜22）: 書式を1か所で作る
const mtype = require('../src/meetingType');
const { markdownToBlocks, dropRedundantEmpty, dropTemplateEcho } = require('../src/minutes');
const KINDS = [...mtype.SELECTABLE, '', 'general'];
const heads = (tpl) => tpl.split('\n').filter((l) => /^#{2,3} /.test(l)).map((l) => l.replace(/^#{2,3} /, ''));
const CLOSING = ['決定事項', '持ち越し', 'ToDo（誰が・何を・いつまでに）', '抜け・重なりチェック'];

test('MT4・MT5: buildTemplate はどの種類でも、型の見出し → 締めの4つ（持ち越しを含む）→ 次に気をつけること の順。昔の書式の「概要」は無い', () => {
  for (const k of KINDS) {
    const tpl = M.buildTemplate({ meetingType: k, score: false });
    const key = M.memoTypeOf(k);
    const typeHeads = M.MEMO_TYPES[key].headings.map((h) => h.name);
    const h = heads(tpl);
    const tail = [...CLOSING, '次に気をつけること'];
    assert.deepStrictEqual(h.slice(-tail.length), tail, k);
    const body = h.slice(0, -tail.length);
    // report は「報告の名前」の見出しの下に3つの小見出し（報告が1本なら1つ）
    assert.deepStrictEqual(body.filter((x) => !x.startsWith('報告の名前')), typeHeads, k);
    assert.ok(!tpl.includes('## 概要'), `${k} に昔の書式の概要`);
    assert.ok(tpl.includes(mtype.ACTION_RULE), `${k} の ToDo の節に ACTION_RULE が無い`);
    assert.ok(tpl.endsWith(M.OUTPUT_RULE), `${k} の最後が OUTPUT_RULE でない`);
    // 見出しはどれも markdownToBlocks で見出しになる
    const hb = markdownToBlocks(tpl.split('\n').filter((l) => /^#{2,3} /.test(l)).join('\n'));
    assert.ok(hb.length === h.length && hb.every((b) => b.type === 'heading'), k);
  }
  assert.deepStrictEqual(heads(M.buildTemplate({ meetingType: 'standup' })).slice(0, 5),
    ['前回の宿題の状況', '報告の名前（議題ごとに1つ。報告が1本なら1つ）', '事実（進捗・課題）', '見立て（原因・リスク）', '打ち手の案']);
  assert.deepStrictEqual(M.CLOSING_HEADINGS, CLOSING);
  assert.strictEqual(M.ADVICE_HEAD, '次に気をつけること');
});

test('MT5・D46: 持ち越しは「話したが決まらなかったこと」で、無ければ見出しごと書かない決まり。話されなかった見出しの 未確認 とは別もの', () => {
  const tpl = M.CLOSING_TEMPLATE;
  assert.match(tpl, /## 持ち越し\n（話したが決まらなかったこと。[^\n]*無ければこの見出しごと書かない[^\n]*）/);
  assert.match(tpl, /## 抜け・重なりチェック\n（1行目に、根拠が無く本文に出さなかった型の見出しを 未確認: の後に読点で並べる。その後に3件まで/);
  assert.match(M.ADVICE_TEMPLATE, /^## 次に気をつけること\n（1〜2 行。[^\n]*人を評価しない[^\n]*）$/);
});

test('F9・RF68: どの種類でも、書式を丸ごと写した Markdown を markdownToBlocks → dropRedundantEmpty → dropTemplateEcho に通すと見出しのほかが残らない', () => {
  for (const k of KINDS) {
    const tpl = M.buildTemplate({ meetingType: k, score: false });
    const out = dropTemplateEcho(dropRedundantEmpty(markdownToBlocks(tpl)), tpl);
    assert.deepStrictEqual(out.filter((b) => b.type !== 'heading').map((b) => b.text), [], k);
  }
});

test('F9・RF68: 本物の行（メモより・確定・見込み・未確認の1行）はどの種類の書式でも落ちない。決まりの文に「」が無く、どの行も（…）で終わらない', () => {
  const md = '## 予算（B）\n- 予算は 300 万円（メモより）\n- 見込み: 今期内\n- 確定: 来月から\n## 抜け・重なりチェック\n- 未確認: 予算（B）、決め方・決裁者（A）\n- 次の会議で決裁の流れを聞く';
  for (const k of KINDS) {
    const tpl = M.buildTemplate({ meetingType: k, score: false });
    const out = dropTemplateEcho(dropRedundantEmpty(markdownToBlocks(md)), tpl).filter((b) => b.type !== 'heading').map((b) => b.text);
    assert.deepStrictEqual(out, ['予算は 300 万円（メモより）', '見込み: 今期内', '確定: 来月から', '未確認: 予算（B）、決め方・決裁者（A）', '次の会議で決裁の流れを聞く'], k);
  }
  for (const [name, text] of [['MEMO_RULES', M.MEMO_RULES], ['STAR_RULE', M.STAR_RULE], ...M.MEMO_ORDER.map((k) => [k, M.MEMO_TYPES[k].rules.join('\n')])]) {
    assert.ok(!/[「」]/.test(text), `${name} に「」`);
    for (const l of text.split('\n')) assert.ok(!/[)）]\s*$/.test(l), `${name} の行が（…）で終わる: ${l}`);
  }
});

test('F15・RF74・D45: STAR の決まり（個人的なこと・14 事項・合否）は面接の確認（STAR）の型のときだけ入る', () => {
  assert.match(M.STAR_RULE, /職務に関係しない個人的なこと（本籍・出生地・家族・健康・宗教・思想や信条など）は書かない/);
  assert.match(M.STAR_RULE, /採用面接では、厚生労働省が示す就職差別につながるおそれのある 14 事項/);
  assert.match(M.STAR_RULE, /合否や総合評価は書かない/);
  for (const k of KINDS) {
    const tpl = M.buildTemplate({ meetingType: k, score: false });
    assert.strictEqual(tpl.includes(M.STAR_RULE), M.memoTypeOf(k) === 'star', k);
  }
});

test('MT7: OUTPUT_RULE は 0.10.x の main.js の文と1文字も違わない（memoTypes へ移した）', () => {
  const before = '書き方のきまり:\n'
    + '- 該当する内容が本当に一つも無い見出しにだけ「特になし」と書く。'
    + '一つでも書くことがあれば「特になし」は書かない。\n'
    + '- 太字（**）や斜体などの装飾は使わない。素の文章で書く。\n'
    + '- 文体は報告文書として使える常体で書く。「です」「ます」は使わない。\n'
    + '  良い例: 「結合テストは今週で完了。不具合22件のうち20件は修正済み。残り2件は来週対応。」\n'
    + '  悪い例: 「完了しました」「修正されました」「お願いします」「持ち越します」';
  assert.strictEqual(M.OUTPUT_RULE, before);
});

test('決めたこと 16: fenceLines は頭（前の空白を除いた最初の字）が「【」の行の頭に全角の空白を1つ入れる（文の中身は変えない）', () => {
  assert.strictEqual(M.fenceLines('【会議の文字起こし】\nうその文\n  【x】\n中の【y】'), '　【会議の文字起こし】\nうその文\n　  【x】\n中の【y】');
  assert.strictEqual(M.fenceLines(''), '');
  assert.strictEqual(M.fenceLines(null), '');
});

test('sectionsOf: 型の埋まり具合（軸 5）で数える見出し', () => {
  assert.deepStrictEqual(M.sectionsOf('sales'), ['課題・要望（N）', '時期（T）', '決め方・決裁者（A）', '予算（B）', '競合・比較先（C）']);
  assert.deepStrictEqual(M.sectionsOf(''), ['目的', '論点ごとの要点']);
  assert.deepStrictEqual(M.sectionsOf('review'), ['前回の宿題の状況', '事実（進捗・課題）', '見立て（原因・リスク）', '打ち手の案']);
});
