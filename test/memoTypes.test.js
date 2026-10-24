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

// ---------------------------------------------------------------- 0.11.0 M-3（MT4・F10。決めたこと 17・18・22〜24）: 印・畳み・チェックの数
const fs = require('node:fs');
const path = require('node:path');
const cite = require('../src/cite');
const R = require('../src/pagerules');
const MIXED = fs.readFileSync(path.join(__dirname, 'fixtures', 'summaries', 'bantc-mixed.md'), 'utf8');
const blocksOf = (md) => dropRedundantEmpty(markdownToBlocks(md));
const view = (bs) => bs.map((b) => `${b.type}:${b.text}${b.mark ? `|${b.mark}` : ''}${b.unconfirmed ? '|u' : ''}`);

test('MT4・D39・決めたこと 18: markBlocks は「■」の見出しを直し、根拠の無い見出し（未確認・言及なし・特になしだけ）を畳んで未確認の1行にまとめ、話されなかった持ち越しを落とし、チェックは 3 件まで', () => {
  const input = blocksOf(MIXED);
  const before = JSON.stringify(input);
  const { blocks, dropped, folded } = M.markBlocks(input, { meetingType: 'sales' });
  assert.strictEqual(JSON.stringify(input), before, '受けた配列を書き換えた');
  assert.deepStrictEqual(view(blocks), [
    'heading:課題・要望（N）', 'bullet:先方は見積の作成に時間がかかっていると話した',
    'heading:時期（T）', 'bullet:見込み: 来月から使いたい（メモより）|memo',
    'heading:競合・比較先（C）', 'bullet:他社の製品と比べていると話した',
    'heading:決定事項', 'bullet:次回に見積の案を出す',
    'heading:ToDo（誰が・何を・いつまでに）', 'todo:見積の案を作る（担当: 山田 / 期限: 来週金曜）',
    'heading:抜け・重なりチェック', 'bullet:未確認: 決め方・決裁者（A）、予算（B）|check|u',
    'bullet:次の会議で決裁の流れを聞く|check', 'bullet:予算の枠を聞く|check', 'bullet:導入の時期を確かめる|check',
    'heading:次に気をつけること', 'bullet:冒頭で会議の目的を言うと、論点がそろう|advice', 'bullet:決めることを先に挙げる|advice',
  ]);
  assert.strictEqual(dropped, 1);
  assert.strictEqual(folded, 2);
  for (const b of blocks.filter((x) => x.mark)) { assert.strictEqual(b.citeState, 'manual', b.text); assert.deepStrictEqual(b.cites, [], b.text); }
  assert.ok(!blocks.filter((x) => !x.mark && x.type !== 'heading').some((b) => b.citeState === 'manual'));
});

test('決めたこと 18: 人の文らしい行が1行でもある見出しは畳まない。型の見出しの外（締め）の「未確認」で始まる行には印を付けない', () => {
  const md = '## 予算（B）\n- 未確認の不具合が3件ある\n## 時期（T）\n- 未確認\n- 来月から\n## 決定事項\n- 未確認の項目は次回に決める\n## 抜け・重なりチェック\n- 次の会議で予算を聞く';
  const { blocks, folded } = M.markBlocks(blocksOf(md), { meetingType: 'sales' });
  assert.strictEqual(folded, 0);
  assert.deepStrictEqual(view(blocks), ['heading:予算（B）', 'bullet:未確認の不具合が3件ある', 'heading:時期（T）', 'bullet:未確認', 'bullet:来月から',
    'heading:決定事項', 'bullet:未確認の項目は次回に決める', 'heading:抜け・重なりチェック', 'bullet:次の会議で予算を聞く|check']);
});

test('決めたこと 18: 畳んだ見出しがあって抜け・重なりチェックが無ければ、次に気をつけることの前に節と未確認の1行を作る。行の無い型の見出しも畳む', () => {
  const md = '## 目的\n## 論点ごとの要点\n- 予算の配分を話した\n## 決定事項\n- 据え置き\n## 次に気をつけること\n- 目的を先に言う';
  const { blocks, folded } = M.markBlocks(blocksOf(md), { meetingType: '' });
  assert.strictEqual(folded, 1);
  assert.deepStrictEqual(view(blocks), ['heading:論点ごとの要点', 'bullet:予算の配分を話した', 'heading:決定事項', 'bullet:据え置き',
    'heading:抜け・重なりチェック', 'bullet:未確認: 目的|check|u', 'heading:次に気をつけること', 'bullet:目的を先に言う|advice']);
});

test('決めたこと 22: 「■ 見出し」と、型か締めの見出しと同じ名前だけの段落は見出しに直す。違う名前の ■ の行は段落のまま。報告の名前の説明の見出しの写しは落とす', () => {
  const md = '■ 目的\n- 共有\n論点ごとの要点\n- 予算\n■ 雑談\n## 報告の名前（議題ごとに1つ。報告が1本なら1つ）\n- x';
  const { blocks } = M.markBlocks(blocksOf(md), { meetingType: '' });
  assert.deepStrictEqual(view(blocks), ['heading:目的', 'bullet:共有', 'heading:論点ごとの要点', 'bullet:予算', 'paragraph:■ 雑談', 'bullet:x']);
  const r = M.markBlocks(blocksOf('■ 前回の宿題の状況\n- 済んだ\n## A案件\n■ 事実（進捗・課題）\n- 遅れ'), { meetingType: 'standup' });
  assert.deepStrictEqual(view(r.blocks), ['heading:前回の宿題の状況', 'bullet:済んだ', 'heading:A案件', 'heading:事実（進捗・課題）', 'bullet:遅れ']);
});

test('F10・RF69: 印を付けた後に attachCitationsAcross と refreshCitations をかけても、印の行（メモより・チェック・助言）は出典が空で、出典の数の分母に入らない', () => {
  const { blocks } = M.markBlocks(blocksOf(MIXED), { meetingType: 'sales' });
  const segs = [
    { id: 's1', atMs: 0, text: '来月から使いたいと思っています。決裁の流れを聞く必要がありますね' },
    { id: 's2', atMs: 5000, text: '冒頭で会議の目的を言うと論点がそろうと思います。予算の枠を聞くのも大事' },
    { id: 's3', atMs: 9000, text: '他社の製品と比べています。見積の作成に時間がかかっています' },
  ];
  cite.attachCitationsAcross(blocks, segs, segs);
  const marked = blocks.filter((b) => b.mark);
  assert.ok(marked.length >= 6);
  for (const b of marked) assert.deepStrictEqual(b.cites, [], `${b.text} に出典`);
  assert.ok(blocks.some((b) => !b.mark && b.cites.length > 0), '前提: 印の無い行には出典が付く');
  cite.refreshCitations(blocks, segs, 's2');
  for (const b of marked) assert.deepStrictEqual(b.cites, [], `refresh の後に ${b.text} に出典`);
  const st = R.citeStatOf(blocks);
  assert.ok(st.total > 0);
  assert.deepStrictEqual(st, R.citeStatOf(blocks.filter((b) => !b.mark)), '印の行が出典の数に入った');
});

test('MT4・決めたこと 24: 一覧の最初の要点（preview）は印の無い箇条書きから', () => {
  const { blocks } = M.markBlocks(blocksOf('## 抜け・重なりチェック\n- 未確認: 目的\n## 論点ごとの要点\n- 予算を据え置く'), { meetingType: '' });
  assert.strictEqual(R.summarize({ blocks, memo: '' }).preview, '予算を据え置く');
});

// ---------------------------------------------------------------- 0.11.0 V-2（D48・F26。決めたこと 27）: 画面の並びとつまみの番号
const H = (id, text) => ({ id, type: 'heading', text });
const B = (id, text = id) => ({ id, type: 'bullet', text });
const ids = (blocks, order) => order.map((i) => blocks[i].id);

test('0.11.0 V-2（D48）: orderForView は「決定事項・持ち越し・ToDo」→ 型の見出しの節（と見出しの前の行）→ 抜け・重なりチェック → 次に気をつけること → それ以外の節。節の中は保存の順', () => {
  const blocks = [
    B('pre'), H('h1', '課題・要望（N）'), B('n1'), H('h2', '予算（B）'), B('b1'),
    H('h3', '決定事項'), B('d1'), H('h4', '持ち越し'), B('c1'), H('h5', 'ToDo（誰が・何を・いつまでに）'), { id: 't1', type: 'todo', text: 'やる' },
    H('h6', '抜け・重なりチェック'), B('k1'), H('h7', '次に気をつけること'), B('a1'), H('h8', '人が足した見出し'), B('x1'),
  ];
  const o = M.orderForView(blocks);
  assert.deepStrictEqual(ids(blocks, o), ['h3', 'd1', 'h4', 'c1', 'h5', 't1', 'pre', 'h1', 'n1', 'h2', 'b1', 'h6', 'k1', 'h7', 'a1', 'h8', 'x1']);
  assert.deepStrictEqual([...o].sort((a, b) => a - b), blocks.map((_, i) => i), '出る行の集まりが保存と違う');
  // AI が並びを崩しても（ToDo が先・持ち越しが後ろ・■ や ** の見出し・半角の括弧）、締めは決定事項 → 持ち越し → ToDo
  const b2 = [H('a', 'ToDo'), B('t'), H('b', '■ 目的'), B('p'), H('c', '持ち越し'), B('q'), H('d', '**決定事項**'), B('r'), H('e', '次に気をつけること'), B('s'), H('f', '抜け・重なりチェック'), B('u')];
  assert.deepStrictEqual(ids(b2, M.orderForView(b2)), ['d', 'r', 'c', 'q', 'a', 't', 'b', 'p', 'f', 'u', 'e', 's']);
});

test('0.11.0 V-2（D48）: 型の見出しの無い前の版の要約は保存の順のまま。締めより前の知らない見出し（報告の名前）は型の節、締めより後ろの知らない見出しは後ろ', () => {
  const old = [H('a', '概要'), B('b'), H('c', '決まったこと'), B('d'), H('e', 'アクションアイテム'), { id: 'f', type: 'todo', text: 'x' }, B('g')];
  assert.deepStrictEqual(M.orderForView(old), old.map((_, i) => i));
  const rep = [H('a', '前回の宿題の状況'), B('b'), H('c', '案件A の受注画面'), H('d', '事実（進捗・課題）'), B('e'), H('f', '決定事項'), B('g'), H('h', '雑談メモ'), B('i'), H('j', '次に気をつけること'), B('k')];
  assert.deepStrictEqual(ids(rep, M.orderForView(rep)), ['f', 'g', 'a', 'b', 'c', 'd', 'e', 'j', 'k', 'h', 'i']);
  for (const v of [[], undefined, null, 'x']) assert.deepStrictEqual(M.orderForView(v), []);
  const noHead = [B('a'), B('b')];
  assert.deepStrictEqual(M.orderForView(noHead), [0, 1]);
});

test('0.11.0 V-2（F26）: savedIndexForDrop は落とした所の次の行の保存の番号。最後なら最後の行の保存の番号＋1', () => {
  const order = [5, 6, 7, 0, 1, 2, 3, 4];
  assert.strictEqual(M.savedIndexForDrop(order, 0), 5);
  assert.strictEqual(M.savedIndexForDrop(order, 3), 0);
  assert.strictEqual(M.savedIndexForDrop(order, 7), 4);
  assert.strictEqual(M.savedIndexForDrop(order, 8), 5);
  assert.strictEqual(M.savedIndexForDrop(order, 99), 5);
  assert.strictEqual(M.savedIndexForDrop([2, 0, 1], 3), 2);
  assert.strictEqual(M.savedIndexForDrop([], 0), 0);
  assert.strictEqual(M.savedIndexForDrop(order, -1), 5);
});

// ---------------------------------------------------------------- 0.11.0 点検の直し（2026-10-24）
test('点検の直し 1: AI の「未確認: なし」（特になし・言及なしなど畳む語だけ）は、畳んだ見出しがあれば置き換え（足さない）、無ければ行ごと落とす（チェックの節が空になれば節も）', () => {
  const rows = [
    // [AI の Markdown（BANTC）, 抜け・重なりチェックの節の形]
    ['## 課題・要望（N）\n- 楽にしたい\n## 予算（B）\n- 未確認\n## 抜け・重なりチェック\n- 未確認: なし\n- 次は予算を聞く',
      ['heading:抜け・重なりチェック', 'bullet:未確認: 予算（B）|check|u', 'bullet:次は予算を聞く|check']],
    ['## 課題・要望（N）\n- 楽にしたい\n## 予算（B）\n- 言及なし\n## 時期（T）\n- 特になし\n## 抜け・重なりチェック\n- **未確認**: 特になし',
      ['heading:抜け・重なりチェック', 'bullet:未確認: 予算（B）、時期（T）|check|u']],
    ['## 課題・要望（N）\n- 楽にしたい\n## 抜け・重なりチェック\n- 未確認: なし\n- 次は予算を聞く',
      ['heading:抜け・重なりチェック', 'bullet:次は予算を聞く|check']],
    ['## 課題・要望（N）\n- 楽にしたい\n## 抜け・重なりチェック\n- 未確認: 該当なし\n## 次に気をつけること\n- 目的を先に言う',
      []],
    ['## 課題・要望（N）\n- 楽にしたい\n## 予算（B）\n- 未確認\n## 抜け・重なりチェック\n- 未確認: 決め方・決裁者（A）',
      ['heading:抜け・重なりチェック', 'bullet:未確認: 決め方・決裁者（A）、予算（B）|check|u']],
  ];
  for (const [md, want] of rows) {
    const { blocks } = M.markBlocks(blocksOf(md), { meetingType: 'sales' });
    const v = view(blocks);
    const at = v.indexOf('heading:抜け・重なりチェック');
    const end = v.findIndex((x, i) => i > at && x.startsWith('heading:'));
    assert.deepStrictEqual(at < 0 ? [] : v.slice(at, end < 0 ? v.length : end), want, md);
    assert.ok(!v.some((x) => /未確認: (?:なし|特になし|該当なし)、/.test(x)), `畳む語に足した: ${md}`);
  }
});
