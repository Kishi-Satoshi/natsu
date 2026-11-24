/* stage180.lib.test.js — 0.18.0（計画 docs/plans/2026-11-18-180.md）の純粋な部品
 *  CS-1（決めたこと 15・16・F236）: 要約の作り方を1つの部品に（src/summaryWrite.js の stripCiteMarks・prepareSummary）
 * 発言・要約の文・人の名前は作った物（実在の人名を使わない）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const SW = require('../src/summaryWrite');
const memoTypes = require('../src/memoTypes');
const mtype = require('../src/meetingType');
const quality = require('../src/quality');
const cite = require('../src/cite');
const lib = require('../src/mainlib');
const { markdownToBlocks, dropRedundantEmpty, dropTemplateEcho } = require('../src/minutes');
const { enrichActionBlocks, groundActionFields } = require('../src/actions');

// ---------------------------------------------------------------- CS-1
const SEGS = [
  { id: 's1', atMs: 0, durationMs: 4000, text: '今日は予算の配分を決めるための会議です' },
  { id: 's2', atMs: 5000, durationMs: 4000, text: '予算は据え置きにすると決めました' },
  { id: 's3', atMs: 10000, durationMs: 4000, text: '見積の案は山田さんが来週金曜までに作ります' },
];
const PAGE = { meetingType: '', createdAt: '2026-11-20T01:00:00.000Z', memo: '' };
const SCORE = [
  '## 打ち合わせの質（採点）',
  '目的と結論: 4 | 予算の配分を決めるための会議',
  '抜け・重なり: 3 | 予算の話を2回やり直した',
  '決定事項: 5 | 据え置きにすると決めました',
].join('\n');
const MD = [
  '## 目的',
  '- 予算の配分を決める',
  '## 論点ごとの要点',
  '## 決定事項',
  '- 決まったこと・合意したこと。箇条書き',
  '- 予算は据え置きにすると決めた',
  '#### 小見出し',
  '- 見積の案は来週に出す',
  '## ToDo（誰が・何を・いつまでに）',
  '- [ ] 見積の案を作る（担当: 山田 / 期限: 来週金曜）',
  '- [ ] 資料を配る（担当: 鈴木 / 期限: 10/23）',
  SCORE,
].join('\n');
const strip = (blocks) => JSON.parse(JSON.stringify(blocks, (k, v) => (k === 'id' ? undefined : v)));
const textsOf = (r) => r.blocks.map((b) => `${b.type}:${b.text}`);

test('CS-1・F236: stripCiteMarks の表（行の終わりの「（出典: …）」だけを外し、行の途中の印・担当の括弧・ふつうの括弧は残す）', () => {
  const URL1 = 'https://natsu.example/open#p=pa1&a=t:s12-s12';
  const URL2 = 'https://natsu.example/open#p=pa1&a=t:s15-s15';
  const CASES = [
    ['- 予算は据え置き（出典: s12）', '- 予算は据え置き'],
    ['- 予算は据え置き（出典: s12, s15）', '- 予算は据え置き'],
    [`- 予算は据え置き（出典: [s12](${URL1})・[s15](${URL2})）`, '- 予算は据え置き'],
    ['- [ ] 見積を作る（担当: 山田 / 期限: 来週金曜）（出典: s3）', '- [ ] 見積を作る（担当: 山田 / 期限: 来週金曜）'],
    ['- 据え置き（出典: s1） ', '- 据え置き'],
    ['- 前の版（出典: s1）の話は後で（出典: s2）', '- 前の版（出典: s1）の話は後で'],
    ['- [ ] 見積を作る（担当: 山田 / 期限: 来週金曜）', '- [ ] 見積を作る（担当: 山田 / 期限: 来週金曜）'],
    ['- 価格（税込み）は据え置き', '- 価格（税込み）は据え置き'],
    ['- 出典は（出典: 資料）とする', '- 出典は（出典: 資料）とする'],
    ['- 予算（出典: s12 と s15）', '- 予算（出典: s12 と s15）'],
    ['## 決定事項', '## 決定事項'],
    ['', ''],
  ];
  for (const [inp, want] of CASES) assert.strictEqual(SW.stripCiteMarks(inp), want, inp);
  // 何行でも行ごと。改行の数は変えない
  assert.strictEqual(SW.stripCiteMarks('- a（出典: s1）\n- b\n- c（出典: s2, s3）\n'), '- a\n- b\n- c\n');
  assert.strictEqual(SW.stripCiteMarks(null), '');
});

test('CS-1・F236: prepareSummary の表（型の見出しの写しが落ちる・未確認の印・文字起こしに無い担当と期限が外れる・出典は今の文字起こしから・採点の節は本文に残らず score のときだけ点・#### は見出し3）', () => {
  const template = memoTypes.buildTemplate({ meetingType: '', score: true, labeled: false });
  const r = SW.prepareSummary({ md: MD, page: PAGE, segments: SEGS, segmentsAtStart: SEGS, score: true, template, at: '2026-11-20T02:00:00.000Z' });
  // RF68: 型の見出しの雛形の写しの行が落ちる
  assert.ok(!textsOf(r).includes('bullet:決まったこと・合意したこと。箇条書き'), textsOf(r).join('\n'));
  assert.ok(textsOf(r).includes('bullet:予算は据え置きにすると決めた'));
  // RF69: 根拠の無い型の見出し（論点ごとの要点）は未確認の印の1行にまとまる
  const check = r.blocks.find((b) => b.mark === 'check' && b.unconfirmed);
  assert.ok(check && /未確認: 論点ごとの要点/.test(check.text), textsOf(r).join('\n'));
  assert.ok(r.folded >= 1, `folded ${r.folded}`);
  // 文字起こしに無い担当（鈴木）・期限（10/23）は外れ、ある担当（山田）・期限（来週金曜）は残る
  const todos = r.blocks.filter((b) => b.type === 'todo');
  assert.deepStrictEqual(todos.map((b) => [b.text, b.assignee || '', b.dueRaw || '']), [['見積の案を作る', '山田', '来週金曜'], ['資料を配る', '', '']]);
  assert.deepStrictEqual([r.droppedAssignee, r.droppedDue], [1, 1]);
  assert.deepStrictEqual(r.actionStat, { total: 2, withAssignee: 1, withDue: 1 });
  // 出典は今の文字起こしの ID だけ
  const decided = r.blocks.find((b) => b.text === '予算は据え置きにすると決めた');
  assert.deepStrictEqual(decided.cites, ['s2']);
  assert.ok(r.citeStat && r.citeStat.total > 0, JSON.stringify(r.citeStat));
  // 採点の節は本文に残らず、点になる（理由の出典も今の文字起こしから）
  assert.ok(!r.blocks.some((b) => /打ち合わせの質|目的と結論: |抜け・重なり: \d|決定事項: \d/.test(b.text)), textsOf(r).join('\n'));
  assert.ok(r.quality && r.quality.total === r.quality.axes.reduce((s, a) => s + a.score, 0), JSON.stringify(r.quality));
  assert.strictEqual(r.quality.at, '2026-11-20T02:00:00.000Z');
  assert.deepStrictEqual([r.scoreNote, r.scoreCode], ['', '']);
  // #### は見出し3（markdownToBlocks のまま）
  assert.deepStrictEqual(r.blocks.filter((b) => b.type === 'heading' && b.text === '小見出し').map((b) => b.level), [3]);
  // score が偽なら点を付けず、採点の節は本文に残らない
  const n = SW.prepareSummary({ md: MD, page: PAGE, segments: SEGS, score: false, template });
  assert.strictEqual(n.quality, null);
  assert.ok(!n.blocks.some((b) => /打ち合わせの質|目的と結論: /.test(b.text)), textsOf(n).join('\n'));
  assert.deepStrictEqual(strip(n.blocks), strip(r.blocks), '点の有無で本文が変わった');
  // 採点の節が読めなければ点を付けず、注（Claude Code の要約と同じ文）と符号
  const bad = SW.prepareSummary({ md: `${MD.replace(SCORE, '')}\n## 打ち合わせの質（採点）\n目的と結論: 9 | x`, page: PAGE, segments: SEGS, score: true, template });
  assert.strictEqual(bad.quality, null);
  assert.strictEqual(bad.scoreNote, SW.QUALITY_NOTE_UNREAD);
  assert.match(bad.scoreCode, /^[a-z-]+$/);
  assert.match(SW.QUALITY_NOTE_UNREAD, /^この要約には打ち合わせの質の点を付けていません/);
});

test('CS-1・F236: prepareSummary は行の終わりの出典の印を外してから行にし、出典は照合の答えだけ（無い発言 s999・別の発言を指す印を信じない）', () => {
  const md = '## 決定事項\n- 予算は据え置きにすると決めた（出典: s999）\n- 見積の案は来週に出す（出典: [s1](https://natsu.example/open#p=x&a=t:s1-s1)）';
  const r = SW.prepareSummary({ md, page: PAGE, segments: SEGS, score: false, template: '' });
  assert.deepStrictEqual(r.blocks.filter((b) => b.type === 'bullet').map((b) => b.text), ['予算は据え置きにすると決めた', '見積の案は来週に出す']);
  const all = r.blocks.flatMap((b) => (Array.isArray(b.cites) ? b.cites : []));
  assert.ok(!all.includes('s999'), JSON.stringify(all));
  assert.deepStrictEqual(r.blocks.find((b) => b.text === '予算は据え置きにすると決めた').cites, ['s2']);
  assert.ok(!r.blocks.find((b) => b.text === '見積の案は来週に出す').cites.includes('s1'), '印の s1 をそのまま出典にした');
});

// 今の doRunSummary の流れ（0.17.0 の main.js:5677〜:5735 の順を写した物。出典の印を外す段の前の形）
function currentFlow({ md, page, segments, segmentsAtStart, score, template, at }) {
  const split = quality.splitScore(md);
  const marked = memoTypes.markBlocks(dropTemplateEcho(dropRedundantEmpty(markdownToBlocks(split.body)), template), { meetingType: page.meetingType });
  const blocks = marked.blocks;
  enrichActionBlocks(blocks, new Date(page.createdAt));
  const plain = lib.timelineOf(segmentsAtStart.filter((s) => !s.failed && !s.pending)).map((r) => r.text).join('\n');
  const grounded = groundActionFields(blocks, `${plain}\n${lib.memoEvidence(page.memo, [...mtype.listTypes(), ...memoTypes.presetLines()])}`);
  const stat = cite.attachCitationsAcross(blocks, segments, segmentsAtStart);
  let q = null;
  if (score) {
    const parsed = quality.parseScore(split.lines, quality.AI_AXES, { found: split.found });
    if (parsed.ok) {
      const cites = {};
      for (const a of quality.AI_AXES) {
        const tmp = [{ id: `q-${a.key}`, type: 'bullet', text: parsed.ai[a.key].reason, cites: [] }];
        cite.attachCitationsAcross(tmp, segments, segmentsAtStart);
        cites[a.key] = Array.isArray(tmp[0].cites) ? tmp[0].cites.filter((c) => typeof c === 'string') : [];
      }
      q = quality.buildQuality({ ai: parsed.ai, todo: quality.todoAxis(blocks), fill: quality.fillAxis(blocks, { headings: memoTypes.sectionsOf(page.meetingType), key: memoTypes.headingKey }), cites, at });
    }
  }
  return { blocks, citeStat: stat, actionStat: grounded.stat, quality: q, dropped: marked.dropped, folded: marked.folded };
}

test('CS-1・F236: 同じ Markdown と同じページで、prepareSummary の答えが、今の doRunSummary の流れ（テストに写した今の順）の答えと同じ（要約の見本の全部と、文字起こしを読み直した後の出典）', () => {
  const dir = path.join(__dirname, 'fixtures', 'summaries');
  // 出典の印のある見本（report-score-cites.md）は、今の流れでは印が文に残るので外す（印を外すのは prepareSummary の新しい段: 上のテスト）
  const mds = [MD, ...fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).filter((t) => !t.includes('（出典'))];
  const later = [SEGS[0], { ...SEGS[1], text: '予算は据え置きにすると皆で決めました' }, SEGS[2], { id: 's4', atMs: 15000, durationMs: 3000, text: '資料は来週に配ります' }];
  for (const meetingType of ['', 'standup', 'sales', 'oneonone']) {
    for (const score of [true, false]) {
      for (const [k, md] of mds.entries()) {
        const page = { ...PAGE, meetingType, memo: k % 2 ? '来週金曜までに見積\n予算の枠を聞く' : '' };
        const template = memoTypes.buildTemplate({ meetingType, score, labeled: false });
        const args = { md, page, segments: later, segmentsAtStart: SEGS, score, template, at: '2026-11-20T02:00:00.000Z' };
        const want = currentFlow(structuredClone(args));
        const got = SW.prepareSummary(structuredClone(args));
        const label = `${meetingType || '（決まらない）'}・score ${score}・見本 ${k}`;
        assert.deepStrictEqual(strip(got.blocks), strip(want.blocks), `${label}: 行`);
        assert.deepStrictEqual([got.citeStat, got.actionStat, got.quality, got.dropped, got.folded], [want.citeStat, want.actionStat, want.quality, want.dropped, want.folded], `${label}: 数と点`);
      }
    }
  }
});

// ---------------------------------------------------------------- CS-2
test('CS-2: routeLabel の表に「🤖 要約: Claude（本人）」（今の2つの札は同じ字）', () => {
  assert.deepStrictEqual(lib.routeLabel({ summary: { by: 'claude', at: '2026-11-22T00:00:00.000Z' } }, ''), ['🤖 要約: Claude（本人）']);
  assert.deepStrictEqual(lib.routeLabel({ stt: { cloud: 2, local: 0, provider: 'openai' }, summary: { by: 'claude' } }, 'OpenAI'), ['☁ 文字起こし: クラウド（OpenAI）2', '🤖 要約: Claude（本人）']);
  assert.deepStrictEqual(lib.routeLabel({ summary: { by: 'claude-code' } }, ''), ['✨ 要約: Claude Code']);
  assert.deepStrictEqual(lib.routeLabel({ summary: { by: 'local' } }, ''), ['🖥 要約: PC（オフライン）']);
});

// ---------------------------------------------------------------- CS-3（決めたこと 23〜26・F237）: 名前の直しの部品（src/nameFix.js）
const NF = require('../src/nameFix');
const throwsBad = (fn, what) => assert.throws(fn, (e) => e && e.code === 'bad-args', what);

test('CS-3・F237: checkPairs の表（1字の from・空の to・from と to が同じ・改行と制御の文字・0 個と 11 個・形の違う組は投げる）', () => {
  throwsBad(() => NF.checkPairs([{ from: '林', to: '森' }]), '1字の from');
  throwsBad(() => NF.checkPairs([{ from: '𠮷', to: '吉田' }]), '1字（サロゲートの組）の from');
  throwsBad(() => NF.checkPairs([{ from: '山田', to: '' }]), '空の to');
  throwsBad(() => NF.checkPairs([{ from: '山田', to: '  ' }]), '空白だけの to');
  throwsBad(() => NF.checkPairs([{ from: '  ', to: '山田' }]), '空白だけの from');
  throwsBad(() => NF.checkPairs([{ from: '山田', to: '山田' }]), 'from と to が同じ');
  throwsBad(() => NF.checkPairs([{ from: '山\n田', to: '山本' }]), '改行の from');
  throwsBad(() => NF.checkPairs([{ from: '山田', to: '山\u0007本' }]), '制御の文字の to');
  throwsBad(() => NF.checkPairs([{ from: '山田', to: '\u202e山本' }]), '向きの制御の文字');
  throwsBad(() => NF.checkPairs([{ from: 'あ'.repeat(51), to: '山本' }]), '51 字の from');
  throwsBad(() => NF.checkPairs([{ from: '山田', to: 'あ'.repeat(51) }]), '51 字の to');
  throwsBad(() => NF.checkPairs([]), '0 個');
  throwsBad(() => NF.checkPairs(Array.from({ length: 11 }, (_, i) => ({ from: `名前${i}`, to: `新名${i}` }))), '11 個');
  throwsBad(() => NF.checkPairs([{ from: '山田', to: '山本', x: 1 }]), '知らない欄');
  throwsBad(() => NF.checkPairs([{ from: 3, to: '山本' }]), '文字でない');
  throwsBad(() => NF.checkPairs('山田'), '並びでない');
  assert.deepStrictEqual(NF.checkPairs([{ from: '林さん', to: '森さん' }, { from: '𠮷田', to: '吉田' }]), [{ from: '林さん', to: '森さん' }, { from: '𠮷田', to: '吉田' }]);
  assert.strictEqual(NF.checkPairs(Array.from({ length: 10 }, (_, i) => ({ from: `名前${i}`, to: `新名${i}` }))).length, 10);
});

test('CS-3・F237: fixNames の表（要約の行・メモの行・発言・ToDo の担当・参加者が変わる／題名とタスクの担当は変わらず数／飾りの区切りの中は置き換わり飾りは残る・区切りをまたぐ語は crossed に数えて変えない／組の順に1回ずつ／ひらがなとカタカナを寄せない）', () => {
  const page = {
    title: '山田さんと打ち合わせ',   // 利用者が付け直した題名（D77。題名の語を数えるため）
    blocks: [
      { id: 'b1', type: 'heading', text: '山田さんの報告', level: 2 },
      { id: 'b2', type: 'bullet', text: '見積は山田さんが作る', cites: ['s1'] },
      { id: 'b3', type: 'bullet', text: '担当は山田', rich: [{ t: '担当は' }, { t: '山田', m: ['b'] }], cites: [] },
      { id: 'b4', type: 'bullet', text: '担当は山田さん', rich: [{ t: '担当は山' }, { t: '田さん', m: ['i'] }], cites: [] },
      { id: 'b5', type: 'todo', text: '資料を配る', assignee: '山田', checked: false, task: 'r1', cites: [], children: [
        { id: 'b6', type: 'bullet', text: 'ヤマダ・やまだ・山田', cites: [] },
      ] },
    ],
    memo: '山田さんに聞く',
    memoDoc: [{ id: 'm1', type: 'paragraph', text: '山田さんに聞く', citeState: 'manual' }],
    cells: { c3: ['山田', '佐藤'], c9: '山田' },
  };
  const segs = [
    { id: 's1', atMs: 0, text: '見積は山田さんが作ります', parts: [{ at: 0, ms: 0 }] },
    { id: 's2', atMs: 1000, text: '（この区間の認識に失敗: 山田）', failed: true },
    { id: 's3', atMs: 2000, text: '佐藤です' },
  ];
  const before = JSON.stringify({ page, segs });
  const r = NF.fixNames(page, segs, [{ from: '山田', to: '山本' }], { tasks: ['山田', '鈴木'], people: ['c3'] });
  assert.strictEqual(JSON.stringify({ page, segs }), before, '受けた物を書き換えた');
  const flat = (list) => list.flatMap((b) => [b, ...flat(b.children || [])]);
  assert.deepStrictEqual(flat(r.page.blocks).map((b) => b.text), ['山本さんの報告', '見積は山本さんが作る', '担当は山本', '担当は山田さん', '資料を配る', 'ヤマダ・やまだ・山本']);
  assert.deepStrictEqual(r.page.blocks[2].rich, [{ t: '担当は' }, { t: '山本', m: ['b'] }], '飾りが外れた');
  assert.deepStrictEqual(r.page.blocks[3].rich, page.blocks[3].rich, '区切りをまたぐ語を置き換えた');
  assert.strictEqual(r.page.blocks[4].assignee, '山本');
  assert.deepStrictEqual([r.page.memoDoc[0].text, r.page.memo], ['山本さんに聞く', '山本さんに聞く\n'], '素の文字のメモをメモの行から作り直していない');
  assert.deepStrictEqual(r.page.cells, { c3: ['山本', '佐藤'], c9: '山田' }, '参加者の列のほかを直した・参加者が直らない');
  assert.strictEqual(r.page.title, '山田さんと打ち合わせ', '題名を直した');
  assert.deepStrictEqual(r.segments.map((s) => s.text), ['見積は山本さんが作ります', '（この区間の認識に失敗: 山田）', '佐藤です']);
  assert.strictEqual(r.segments[0].parts, undefined, '文を変えた発言の文の頭（parts）が古いまま');
  assert.deepStrictEqual(r.segIds, ['s1']);
  assert.deepStrictEqual(r.counts, { summary: 4, memo: 1, transcript: 1, assignee: 1, people: 1, title: 1, crossed: 1, tasks: 1 });
  assert.deepStrictEqual([...r.changedBlocks].sort(), ['b1', 'b2', 'b3', 'b5', 'b6']);
  // 組の順に1回ずつ（A→B・B→C で A は B のまま、もとの B は C）
  const two = NF.fixNames({ blocks: [{ id: 'x', type: 'bullet', text: '山田と佐藤と山田' }] }, [], [{ from: '山田', to: '佐藤' }, { from: '佐藤', to: '鈴木' }]);
  assert.strictEqual(two.page.blocks[0].text, '佐藤と鈴木と佐藤');
  assert.deepStrictEqual(two.counts.summary, 3);
  // 当たりが無ければ数は 0 で、ページと発言はそのまま
  const none = NF.fixNames(page, segs, [{ from: '該当なし', to: '山本' }], { tasks: ['山田'], people: ['c3'] });
  assert.deepStrictEqual(none.counts, { summary: 0, memo: 0, transcript: 0, assignee: 0, people: 0, title: 0, crossed: 0, tasks: 0 });
  assert.deepStrictEqual([none.page, none.segments, none.segIds], [page, segs, []]);
  // 参加者の名前が重なったら1つにまとめる（人の列は同じ名前を2つ持たない）
  const dup = NF.fixNames({ blocks: [], cells: { c3: ['山田', '山本'] } }, [], [{ from: '山田', to: '山本' }], { people: ['c3'] });
  assert.deepStrictEqual([dup.page.cells.c3, dup.counts.people], [['山本'], 1]);
});

// ---------------------------------------------------------------- CT-3（決めたこと 34〜38・F240・F241）: データベースの問い合わせと書く値の読み替え（src/mcp/dbQuery.js）
const DQ = require('../src/mcp/dbQuery');
const DV = require('../src/dbView');
const DMOD = require('../src/dbModel');
// データベースの列（作った物）: 題名・テキスト・数値・選択・複数選択・ステータス・日付・ユーザー・チェック・リレーション・作成者・作成日時・ID・消した列
const QCOLS = [
  { id: 'title', name: '名前', type: 'title' },
  { id: 'c1', name: 'メモ', type: 'text' },
  { id: 'c2', name: '金額', type: 'number', fmt: 'plain' },
  { id: 'c3', name: '区分', type: 'select', opts: [{ id: 'o1', name: '社内', color: 'default' }, { id: 'o2', name: '社外', color: 'blue' }] },
  { id: 'c4', name: 'タグ', type: 'multi', opts: [{ id: 'o1', name: '急ぎ', color: 'red' }, { id: 'o2', name: '確認', color: 'gray' }] },
  { id: 'c5', name: 'ステータス', type: 'status', opts: [{ id: 'o1', name: '未着手', color: 'default' }, { id: 'o2', name: '進行中', color: 'blue' }, { id: 'o3', name: '完了', color: 'green' }], groups: { todo: ['o1'], doing: ['o2'], done: ['o3'] } },
  { id: 'c6', name: '期限', type: 'date' },
  { id: 'c7', name: '担当', type: 'person' },
  { id: 'c8', name: '済み', type: 'check' },
  { id: 'c9', name: '関連', type: 'rel', db: 'pother' },
  { id: 'c10', name: '作成者', type: 'cby' },
  { id: 'c11', name: '作成日時', type: 'ctime' },
  { id: 'c12', name: '番号', type: 'no' },
  { id: 'c13', name: '消した列', type: 'text', gone: true },
];
const QVIEWS = [
  { id: 'v1', name: 'すべて', layout: 'table', props: [], sort: [{ col: 'c2', dir: 'desc' }], filter: null, group: null, agg: {} },
  { id: 'v2', name: '社内だけ', layout: 'table', props: [], sort: [], filter: { op: 'and', items: [{ col: 'c3', cmp: 'any', value: ['o1'] }] }, group: { col: 'c3' }, agg: {} },
];
const condsOf = (v) => (v.filter ? v.filter.items : []);

test('CT-3・F240: toView の表: 列の名前 → ID・選択肢の名前 → ID・「自分」「Claude」「NaTsu」→ me・claude・system・日付・between・match any → or・sort。条件は normalizeView を通した形で FILTER_OPS の中だけ', () => {
  const r = DQ.toView({ filters: [
    { column: 'メモ', op: 'contains', value: '見積' },
    { column: '金額', op: 'ge', value: 100 },
    { column: '区分', op: 'any', value: ['社外'] },
    { column: 'タグ', op: 'anyOf', value: '急ぎ' },
    { column: 'ステータス', op: 'none', value: '完了' },
    { column: '期限', op: 'between', value: { from: '2026-11-01', to: '2026-11-30' } },
    { column: '期限', op: 'before', value: '2026-12-01' },
    { column: '担当', op: 'contains', value: '担当A' },
    { column: '済み', op: 'no' },
    { column: '作成者', op: 'any', value: ['自分', 'Claude', 'NaTsu'] },
  ], match: 'any', sort: [{ column: '期限', dir: 'asc' }] }, QCOLS, QVIEWS);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(r.view.filter, { op: 'or', items: [
    { col: 'c1', cmp: 'contains', value: '見積' }, { col: 'c2', cmp: 'ge', value: 100 }, { col: 'c3', cmp: 'any', value: ['o2'] },
    { col: 'c4', cmp: 'anyOf', value: ['o1'] }, { col: 'c5', cmp: 'none', value: ['o3'] },
    { col: 'c6', cmp: 'between', value: { from: '2026-11-01', to: '2026-11-30' } }, { col: 'c6', cmp: 'before', value: '2026-12-01' },
    { col: 'c7', cmp: 'contains', value: '担当A' }, { col: 'c8', cmp: 'no' }, { col: 'c10', cmp: 'any', value: ['me', 'claude', 'system'] },
  ] });
  // 並べ替え: 渡した並べ替えの後に、ビュー（名前を渡さなければ最初のビュー）の並べ替え（同じ列は重ねない）
  assert.deepStrictEqual(r.view.sort, [{ col: 'c6', dir: 'asc' }, { col: 'c2', dir: 'desc' }]);
  assert.strictEqual(r.pre, null, 'ビューの名前を渡さないのに、ビューの絞り込みを使った');
  assert.strictEqual(r.view.group, null);
  for (const c of condsOf(r.view)) assert.ok(DV.FILTER_OPS[QCOLS.find((x) => x.id === c.col).type].includes(c.cmp), JSON.stringify(c));
  assert.deepStrictEqual(DV.normalizeView(r.view, QCOLS).repaired, [], 'normalizeView が直した（条件が FILTER_OPS の外）');
  // ビューの名前: そのビューの絞り込み（先に当てる pre）と並べ替え。グループは使わない
  const v = DQ.toView({ view: '社内だけ', filters: [{ column: 'メモ', op: 'notEmpty' }] }, QCOLS, QVIEWS);
  assert.deepStrictEqual([v.ok, v.pre, v.view.filter, v.view.sort, v.view.group], [true, { op: 'and', items: [{ col: 'c3', cmp: 'any', value: ['o1'] }] }, { op: 'and', items: [{ col: 'c1', cmp: 'notEmpty' }] }, [], null]);
  // 条件が無ければ絞らない
  assert.deepStrictEqual(((x) => [x.ok, x.view.filter, x.pre])(DQ.toView({}, QCOLS, QVIEWS)), [true, null, null]);
  // 選択肢と列の名前は大文字小文字・全角半角を寄せて当てる（dbModel の foldName）
  assert.deepStrictEqual(DQ.toView({ filters: [{ column: '作成者', op: 'any', value: 'claude' }] }, QCOLS, QVIEWS).view.filter.items, [{ col: 'c10', cmp: 'any', value: ['claude'] }]);
});

test('CT-3・F240: toView の表: 無い列（消した列も）・その種類に無い op・無い選択肢・形の悪い値・知らないビューの名前・並べ替えの無い列は { ok: false, at, why }（1つでも落ちたら絞らない）', () => {
  const bad = (args) => { const r = DQ.toView(args, QCOLS, QVIEWS); assert.strictEqual(r.ok, false, JSON.stringify(args)); assert.strictEqual(r.view, undefined, '落ちたのにビューを返した'); return [r.at, r.why]; };
  const two = (f) => ({ filters: [{ column: 'メモ', op: 'contains', value: '見積' }, f] });
  assert.deepStrictEqual(bad(two({ column: '無い列', op: 'contains', value: 'x' })), ['filter:2', 'no-col']);
  assert.deepStrictEqual(bad(two({ column: '消した列', op: 'contains', value: 'x' })), ['filter:2', 'no-col']);
  assert.deepStrictEqual(bad(two({ column: '金額', op: 'contains', value: 'x' })), ['filter:2', 'no-op']);
  assert.deepStrictEqual(bad(two({ column: '区分', op: 'any', value: ['無い名前'] })), ['filter:2', 'no-opt']);
  assert.deepStrictEqual(bad(two({ column: '作成者', op: 'any', value: ['だれか'] })), ['filter:2', 'bad-value']);
  assert.deepStrictEqual(bad(two({ column: '金額', op: 'ge', value: '100' })), ['filter:2', 'bad-value']);
  assert.deepStrictEqual(bad(two({ column: '期限', op: 'before', value: '2026-02-30' })), ['filter:2', 'bad-value']);
  assert.deepStrictEqual(bad(two({ column: '期限', op: 'between', value: { from: '2026-12-01', to: '2026-11-01' } })), ['filter:2', 'bad-value']);
  assert.deepStrictEqual(bad(two({ column: '済み', op: 'yes', value: true })), ['filter:2', 'bad-value']);
  assert.deepStrictEqual(bad(two({ column: 'メモ', op: 'contains', value: '' })), ['filter:2', 'bad-value']);
  assert.deepStrictEqual(bad(two({ column: 'メモ', op: 'contains', value: '、。' })), ['filter:2', 'bad-value']);   // 寄せると空の語は全部に当たる（dbView と同じ）
  assert.deepStrictEqual(bad({ view: '無いビュー' }), ['view', 'no-view']);
  assert.deepStrictEqual(bad({ sort: [{ column: '期限', dir: 'asc' }, { column: '無い列', dir: 'asc' }] }), ['sort:2', 'no-col']);
  // SQL や検索の文法の字はただの文字（そのまま値になる）
  const q = DQ.toView({ filters: [{ column: 'メモ', op: 'contains', value: '"見積" AND 100%' }] }, QCOLS, QVIEWS);
  assert.deepStrictEqual(q.view.filter.items, [{ col: 'c1', cmp: 'contains', value: '"見積" AND 100%' }]);
});

test('CT-3・F241: cellsFromNames の表: 列の名前 → ID・選択肢の名前 → ID・人は名前の並び・日付・null は空。書けない列（作成日時・作成者・ID・「議事録」の読む列）は read-only・無い選択肢は no-opt（今ある名前を添える）・題名は title・無い列は no-col・形の悪い値は bad-value。「議事録」は参加者（ユーザー）だけ', () => {
  const r = DQ.cellsFromNames({ メモ: '見積の件', 金額: 1200, 区分: '社外', タグ: ['急ぎ', '確認'], ステータス: '進行中', 期限: '2026-11-30', 担当: '担当A', 済み: true, 関連: ['r1', 'r2'] }, QCOLS);
  assert.deepStrictEqual(r, { ok: true, cells: { c1: '見積の件', c2: 1200, c3: 'o2', c4: ['o1', 'o2'], c5: 'o2', c6: { start: '2026-11-30' }, c7: ['担当A'], c8: true, c9: ['r1', 'r2'] } });
  assert.deepStrictEqual(DQ.cellsFromNames({ 期限: { from: '2026-11-01', to: '2026-11-03' }, 担当: ['担当A', '担当B'], メモ: null, 済み: false }, QCOLS).cells, { c6: { start: '2026-11-01', end: '2026-11-03' }, c7: ['担当A', '担当B'], c1: null, c8: null });
  const no = (cells, opts) => { const x = DQ.cellsFromNames(cells, QCOLS, opts); assert.strictEqual(x.ok, false, JSON.stringify(cells)); return x; };
  for (const name of ['作成者', '作成日時', '番号']) assert.deepStrictEqual(((x) => [x.col, x.why])(no({ [name]: 'x' })), [name, 'read-only'], name);
  assert.deepStrictEqual(no({ 区分: '無い名前' }), { ok: false, col: '区分', why: 'no-opt', opts: ['社内', '社外'] });
  assert.deepStrictEqual(no({ タグ: ['急ぎ', '無い名前'] }), { ok: false, col: 'タグ', why: 'no-opt', opts: ['急ぎ', '確認'] });
  assert.deepStrictEqual(((x) => [x.col, x.why])(no({ 名前: '題' })), ['名前', 'title']);
  assert.deepStrictEqual(((x) => [x.col, x.why])(no({ 無い列: 'x' })), ['無い列', 'no-col']);
  assert.deepStrictEqual(((x) => [x.col, x.why])(no({ 消した列: 'x' })), ['消した列', 'no-col']);
  for (const [name, v] of [['金額', '12'], ['期限', '11/30'], ['済み', 'はい'], ['関連', ['r 1']], ['メモ', 3]]) assert.deepStrictEqual(no({ [name]: v }).why, 'bad-value', name);
  // 「議事録」: 書けるのは参加者（ユーザーの列）だけ。日付・作成者・要約（読む列）と題名は書けない
  const MCOLS = [{ id: 'title', name: '名前', type: 'title' }, { id: 'c1', name: '日付', type: 'mdate' }, { id: 'c2', name: '作成者', type: 'cby' }, { id: 'c3', name: '参加者', type: 'person' }, { id: 'c4', name: '要約', type: 'msum' }, { id: 'c5', name: '足した列', type: 'text' }];
  assert.deepStrictEqual(DQ.cellsFromNames({ 参加者: ['担当A'] }, MCOLS, { minutes: true }), { ok: true, cells: { c3: ['担当A'] } });
  for (const name of ['日付', '作成者', '要約', '足した列']) assert.deepStrictEqual(DQ.cellsFromNames({ [name]: 'x' }, MCOLS, { minutes: true }).why, 'read-only', name);
  assert.deepStrictEqual(DQ.cellsFromNames({ 名前: 'x' }, MCOLS, { minutes: true }).why, 'title');
});

test('CT-3: OPS_HELP は FILTER_OPS から作った、列の種類の名前ごとの op の表（手で書かない・どの種類の op も載る）', () => {
  assert.strictEqual(typeof DQ.OPS_HELP, 'string');
  for (const [type, ops] of Object.entries(DV.FILTER_OPS)) {
    const line = DQ.OPS_HELP.split('\n').find((l) => l.split(': ')[0].split('・').includes(DMOD.COLS[type].label));
    assert.ok(line, `${type} の行が無い`);
    assert.deepStrictEqual(line.split(': ')[1].split('・'), ops, type);
  }
});

// ---------------------------------------------------------------- CP-1（決めたこと 47・AQ7 (a)・AQ44 (a)・F243）: Claude デスクトップの指示書（MCP のプロンプト）
const PR = require('../src/mcp/prompts');
const SUM_LEAD = 'get_meeting を include_transcript で読み、この書式で書き、write_summary に meeting_type を付けて書き戻す。';
const textOfPrompt = (name, args) => { const r = PR.promptMessages(name, args); assert.ok(r, `${name} が断られた`); assert.strictEqual(r.length, 1); assert.strictEqual(r[0].role, 'user'); assert.strictEqual(r[0].content.type, 'text'); return r[0].content.text; };

test('CP-1: 指示書は 10 個（要約タイプ 7 つ「<種類>の型で要約して書き戻す」と、資料・横断・ToDo のまとめ）。並びはいつも同じ・名前は英字の決まった形・題は「画面の文」の字・引数は決まった形', () => {
  assert.deepStrictEqual(PR.PROMPTS.map((p) => p.name), [...mtype.SELECTABLE.map((k) => `summary_${k}`), 'make_material', 'cross_topic', 'todo_digest']);
  assert.deepStrictEqual(PR.PROMPTS.map((p) => p.title), [
    '朝会・内部定例会の型で要約して書き戻す', '部会・報告会の型で要約して書き戻す', 'ブレスト・意見交換の型で要約して書き戻す', '1on1の型で要約して書き戻す',
    '採用面接・事前面談の型で要約して書き戻す', '商談の型で要約して書き戻す', 'プレゼン形式の型で要約して書き戻す',
    '指した会議から資料を作る', '話題で過去の会議を横断する', 'ToDo と決定事項をまとめる',
  ]);
  for (const p of PR.PROMPTS) assert.ok(/^[a-z_]{1,40}$/.test(p.name) && Object.isFrozen(p), p.name);
  assert.deepStrictEqual(PR.PROMPTS.map((p) => p.arguments.map((a) => `${a.name}${a.required ? '!' : '?'}`).join(',')),
    [...mtype.SELECTABLE.map(() => 'meeting!'), 'meetings!', 'topic!', 'from?,to?']);
  // 引数の説明は 0.10.0 の道具の引数の字をそのまま（CR83）
  const descs = Object.fromEntries(PR.PROMPTS.flatMap((p) => p.arguments.map((a) => [a.name, a.description])));
  assert.deepStrictEqual(descs, {
    meeting: '議事録の ID か、NaTsu の［リンクを写す］の住所', meetings: '会議の ID か、NaTsu の［リンクを写す］の住所の並び', topic: '探す語（空白で区切る）',
    from: 'この日の会議から（YYYY-MM-DD。両端を含む）', to: 'この日の会議まで（YYYY-MM-DD。両端を含む）',
  });
});

test('CP-1・AQ44 (a): 要約タイプの指示書の本文は K11 の字の手順・照らした ID・種類の鍵・「書式:」と memoTypes.buildTemplate（score なし・labeled）の書式だけ。点の節を持たない（RF71・CR22）', () => {
  for (const k of mtype.SELECTABLE) {
    const text = textOfPrompt(`summary_${k}`, { meeting: ' pm1 ' });
    const fmt = memoTypes.buildTemplate({ meetingType: k, score: false, labeled: true });
    assert.strictEqual(text, [SUM_LEAD, '議事録の ID: pm1', `meeting_type: ${k}`, '書式:', fmt].join('\n'), k);
    assert.ok(!text.includes(quality.SCORE_TEMPLATE) && !text.includes('打ち合わせの質'), `${k}: 点の節がある`);
  }
  // NaTsu の［リンクを写す］の住所も ID にして入れる（住所そのものは入れない）
  const link = textOfPrompt('summary_sales', { meeting: 'natsu://page/pm2' });
  assert.ok(link.includes('議事録の ID: pm2\n') && !link.includes('natsu://'), link.slice(0, 200));
});

test('CP-1・AQ44 (a): 資料・横断・ToDo と決定事項の指示書の本文は K11 の字。ToDo のまとめは日付の範囲が無ければ「（<from>〜<to> の会議の分）」を外し、list_action_items と query_database（『タスク管理』）の手順を持つ', () => {
  assert.strictEqual(textOfPrompt('make_material', { meetings: 'pm1 pm2、natsu://page/pm3,pm1' }),
    '次の会議を get_meetings で読み、要点を資料（見出しと箇条書き）にまとめてください。使った箇所ごとに出典を書いてください。会議: pm1・pm2・pm3');
  assert.strictEqual(textOfPrompt('cross_topic', { topic: '  見積の値引き ' }),
    'search_passages で「見積の値引き」を、言い換えも使って何回か探し、会議をまたいで、いつ・何が話され・どう決まったかを日付の順にまとめてください。使った箇所ごとに出典を書いてください。');
  const tail = '読み、query_database で『タスク管理』の済んでいない行も読んで、ToDo と決定事項を担当ごとにまとめてください。';
  assert.strictEqual(textOfPrompt('todo_digest', {}), `list_action_items で開いた ToDo を${tail}`);
  assert.strictEqual(textOfPrompt('todo_digest', { from: '', to: ' ' }), `list_action_items で開いた ToDo を${tail}`, '空の任意の引数は無いのと同じ');
  assert.strictEqual(textOfPrompt('todo_digest', { from: '2026-11-01', to: '2026-11-30' }), `list_action_items で開いた ToDo を（2026-11-01〜2026-11-30 の会議の分）${tail}`);
  assert.strictEqual(textOfPrompt('todo_digest', { from: '2026-11-01' }), `list_action_items で開いた ToDo を（2026-11-01〜 の会議の分）${tail}`);
  assert.strictEqual(textOfPrompt('todo_digest', { to: '2026-11-30' }), `list_action_items で開いた ToDo を（〜2026-11-30 の会議の分）${tail}`);
});

test('CP-1・F243: 引数の照らし: 形の違う meeting・meetings（21 個・リンクでない文字）・本当に無い日・from が to より後・知らない名前・知らない引数・必須の無い頼みは null（rpc が -32602）。topic の改行・向きの制御の文字は1行にされ、201 字は null（200 字は通る・𠮷 は1字）', () => {
  for (const [name, args] of [
    ['summary_standup', {}], ['summary_standup', { meeting: '' }], ['summary_standup', { meeting: '../pm1' }], ['summary_standup', { meeting: 'pm1', extra: 'x' }],
    ['summary_standup', { meeting: 3 }], ['summary_general', { meeting: 'pm1' }], ['nothing', {}], ['summary_standup', null],
    ['make_material', { meetings: Array.from({ length: 21 }, (_, i) => `pm${i}`).join(' ') }], ['make_material', { meetings: 'pm1 見積' }], ['make_material', { meetings: ' ' }],
    ['cross_topic', { topic: 'あ'.repeat(201) }], ['cross_topic', { topic: ' \n ' }], ['cross_topic', {}],
    ['todo_digest', { from: '2026-02-30' }], ['todo_digest', { from: '2026/11/01' }], ['todo_digest', { from: '2026-11-30', to: '2026-11-01' }], ['todo_digest', { at: '2026-11-01' }],
  ]) assert.strictEqual(PR.promptMessages(name, args), null, `${name} ${JSON.stringify(args).slice(0, 60)}`);
  assert.ok(PR.promptMessages('make_material', { meetings: Array.from({ length: 20 }, (_, i) => `pm${i}`).join(' ') }), '20 個は通る');
  const t = textOfPrompt('cross_topic', { topic: '見積\nの\u202e値引き\u2028の件' });
  assert.ok(t.startsWith('search_passages で「見積 の値引き の件」を') && !/[\n\u2028\u202e]/.test(t.split('\n')[0]) && !t.includes('\n'), JSON.stringify(t));
  assert.ok(textOfPrompt('cross_topic', { topic: '𠮷'.repeat(200) }).includes('𠮷'.repeat(200)));
  assert.strictEqual(PR.promptMessages('cross_topic', { topic: '𠮷'.repeat(201) }), null);
});

test('点検 2・CR93: fixNames の飾りの区切りをまたぐ当たりは、次の字から探し直す（重なった区切りの中の当たりも置き換え、またいだ所だけを crossed に1つ数える。重なったまたぎは1か所）', () => {
  const r = NF.fixNames({ blocks: [{ id: 'x', type: 'bullet', text: 'さささん', rich: [{ t: 'さ' }, { t: 'ささん', m: ['b'] }] }] }, [], [{ from: 'ささ', to: '佐々' }]);
  assert.deepStrictEqual(r.page.blocks[0].rich, [{ t: 'さ' }, { t: '佐々ん', m: ['b'] }], '重なった区切りの中の当たりを置き換えない');
  assert.strictEqual(r.page.blocks[0].text, 'さ佐々ん');
  assert.deepStrictEqual([r.counts.summary, r.counts.crossed], [1, 1]);
  // 重なったまたぎは1か所（区切りが3つ）
  const t = NF.fixNames({ blocks: [{ id: 'y', type: 'bullet', text: 'xあああy', rich: [{ t: 'xあ' }, { t: 'あ' }, { t: 'あy', m: ['i'] }] }] }, [], [{ from: 'ああ', to: 'いい' }]);
  assert.deepStrictEqual([t.counts.summary, t.counts.crossed], [0, 1]);
  // またがない当たりは今どおり
  const u = NF.fixNames({ blocks: [{ id: 'z', type: 'bullet', text: '担当は山田と山田', rich: [{ t: '担当は山' }, { t: '田と山田', m: ['b'] }] }] }, [], [{ from: '山田', to: '山本' }]);
  assert.deepStrictEqual([u.page.blocks[0].rich, u.counts.summary, u.counts.crossed], [[{ t: '担当は山' }, { t: '田と山本', m: ['b'] }], 1, 1]);
});

// ---------------------------------------------------------------- XE-1（決めたこと 57・AQ23 (a)・AQ24 (a)・F245）: Ctrl+Z の印（src/typeMarks.js）
const TM = require('../src/typeMarks');
const UB = require('../src/undoBook');
test('XE-1・F245: typeMarks の表（0.4 秒の間は同じ印・0.6 秒で次の印・cut（日本語入力の確定）は時刻によらず次の印・同じ文は足さない・60 まで・stepBack と stepFwd の往復・印が2つの歩みは null）', () => {
  assert.strictEqual(TM.UNDO_PAUSE_MS, 500);
  const S = (text, caret = text.length) => ({ text, rich: null, caret });
  let l = TM.markAdd([], S(''), 0);
  assert.deepStrictEqual(l, [{ snap: S(''), at: 0, open: false }], '始めは閉じた印');
  l = TM.markAdd(l, S('あ'), 1000);
  l = TM.markAdd(l, S('あい'), 1400);   // 0.4 秒: 同じ印
  l = TM.markAdd(l, S('あいう'), 1800);
  assert.deepStrictEqual(TM.marksOf(l).map((x) => x.text), ['', 'あいう'], '0.4 秒の間で分けた');
  l = TM.markAdd(l, S('あいうえ'), 2400);   // 0.6 秒: 次の印
  assert.deepStrictEqual(TM.marksOf(l).map((x) => x.text), ['', 'あいう', 'あいうえ'], '0.6 秒で分けない');
  // 確定（cut）: すぐ前（0.1 秒）でも次の印で、その印を閉じる（次の打鍵はすぐでも別の印）
  l = TM.markAdd(l, S('あいうえ今日'), 2500, { cut: true });
  l = TM.markAdd(l, S('あいうえ今日は'), 2600);
  assert.deepStrictEqual(TM.marksOf(l).map((x) => x.text), ['', 'あいう', 'あいうえ今日', 'あいうえ今日は'], '確定で印を閉じない');
  // 同じ文は足さない（カーソルだけの違いも）
  const n = l.length;
  l = TM.markAdd(l, S('あいうえ今日は', 2), 5000);
  assert.strictEqual(l.length, n, '同じ文を足した');
  // 飾りの違いは別の文
  l = TM.markAdd(l, { text: 'あいうえ今日は', rich: [{ t: 'あいうえ今日は', m: ['b'] }], caret: 7 }, 9000);
  assert.strictEqual(TM.marksOf(l).length, 5, '飾りの違いを同じ文にした');
  // 60 まで（始めは残る）
  let m = TM.markAdd([], S('始'), 0);
  for (let i = 1; i <= 70; i++) m = TM.markAdd(m, S(`始${i}`), i * 1000);
  assert.strictEqual(m.length, TM.MARKS_MAX);
  assert.deepStrictEqual([m[0].snap.text, m[1].snap.text, m[m.length - 1].snap.text], ['始', '始12', '始70']);
  // marksOf は続けて同じ文を1つに（後のカーソル）
  assert.deepStrictEqual(TM.marksOf([{ snap: S('a', 0) }, { snap: S('a', 1) }, { snap: S('ab') }]), [S('a', 1), S('ab')]);
  // stepBack・stepFwd の往復（印が2つ・始めの次は null: edit.revert で戻す）
  const e = { steps: ['a:s1'], marks: [S(''), S('あいう'), S('あいうえお')], row: 'r1', at: 2 };
  const b1 = TM.stepBack(e);
  assert.deepStrictEqual([b1.from.text, b1.to.text, b1.entry.at, b1.entry.row, b1.entry.steps], ['あいうえお', 'あいう', 1, 'r1', ['a:s1']]);
  assert.strictEqual(TM.stepBack(b1.entry), null, '始めの次から印で戻した（edit.revert で戻す）');
  const f1 = TM.stepFwd(b1.entry);
  assert.deepStrictEqual([f1.from.text, f1.to.text, f1.entry.at], ['あいう', 'あいうえお', 2]);
  assert.strictEqual(TM.stepFwd(f1.entry), null, '終わりから進めた');
  assert.strictEqual(TM.stepFwd({ ...e, at: 0 }), null, '始め（edit.revert のやり直し）から印で進めた');
  assert.strictEqual(TM.stepBack({ steps: ['a:s1'], marks: [S(''), S('あ')], at: 1 }), null, '印が2つの歩みは null でない');
  assert.strictEqual(TM.stepBack({ steps: ['a:s1'] }), null);
});

test('XE-1・F245: undoBook の印（bookMark は保存の歩みにだけ・3つ以上・bookStepped の戻すと進める・bookDone は印を反対の歩みへ）・UNDO_CMDS に edit.textStep', () => {
  assert.ok(UB.UNDO_CMDS.has('edit.textStep'));
  const k = UB.bookKey('p1', 'note');
  const M3 = [{ text: '' }, { text: 'a' }, { text: 'ab' }];
  let b = UB.bookPush({}, k, ['a:s1']);
  assert.strictEqual(UB.bookMark(b, k, M3.slice(0, 2), 'a:s1', 'r1'), b, '印が2つで付けた');
  assert.strictEqual(UB.bookMark(b, k, M3, 'a:other', 'r1'), b, 'ほかの歩みに付けた');
  b = UB.bookMark(b, k, M3, 'a:s1', 'r1');
  assert.deepStrictEqual(b[k].undo, [{ steps: ['a:s1'], marks: M3, row: 'r1', at: 2 }]);
  // 窓のメモリの歩み（step 無し）
  const lk = UB.bookKey('live', 'memo');
  const lb = UB.bookMark(UB.bookPush({}, lk, [], { literal: { before: [], after: [] } }), lk, M3, null, 'm1');
  assert.deepStrictEqual(lb[lk].undo[0].at, 2);
  // 戻した: 戻す列の上に戻し、やり直しの列に進みの印
  const t = UB.bookTakeUndo(b, k);
  b = UB.bookStepped(t.book, k, 'undo', { ...t.entry, steps: ['a:s1', 'a:t1'], at: 1 });
  assert.deepStrictEqual([b[k].undo.map((e) => [e.steps, e.at]), b[k].redo], [[[['a:s1', 'a:t1'], 1]], [{ steps: [], fwd: true }]]);
  // 進めた: 進みの印を取り、戻す列の一番上を替える
  const r = UB.bookTakeRedo(b, k);
  b = UB.bookStepped(r.book, k, 'redo', { ...b[k].undo[0], steps: ['a:s1', 'a:t1', 'a:t2'], at: 2 });
  assert.deepStrictEqual([b[k].undo.map((e) => [e.steps, e.at]), b[k].redo], [[[['a:s1', 'a:t1', 'a:t2'], 2]], []]);
  // edit.revert で戻した歩みの印は反対の歩みへ（戻した後は at 0・やり直した後は at 1）
  const u = UB.bookTakeUndo(b, k);
  b = UB.bookDone(u.book, k, 'undo', 'a:r1', u.entry);
  assert.deepStrictEqual(b[k].redo, [{ steps: ['a:r1'], marks: M3, row: 'r1', at: 0 }]);
  const y = UB.bookTakeRedo(b, k);
  b = UB.bookDone(y.book, k, 'redo', 'a:r2', y.entry);
  assert.deepStrictEqual(b[k].undo, [{ steps: ['a:r2'], marks: M3, row: 'r1', at: 1 }]);
  // 印の無い歩みは今のまま
  assert.deepStrictEqual(UB.bookDone({}, k, 'undo', 'a:x', { steps: ['a:y'] })[k].redo, [{ steps: ['a:x'] }]);
});

// ---------------------------------------------------------------- XE-2（決めたこと 58・AQ21 (a)・F246）: 何行かの素の文の貼り付け（src/pasteConvert.js の fromPlain）
const PC = require('../src/pasteConvert');
const txtsOf = (r) => r.blocks.map((b) => b.rich.map((x) => x.t).join(''));
test('XE-2・F246: fromPlain の表（改行1つは1つの行の中の改行・空の行で段落を分ける・1行は今どおり inline・行の頭の空白は残す・制御の文字は落とす・100,000 字を越える段落は越える前の最後の改行で分ける）', () => {
  let r = PC.fromPlain('a\nb\nc');
  assert.deepStrictEqual([txtsOf(r), r.inline, r.below], [['a\nb\nc'], false, true], '改行1つで行を分けた・below が無い');
  r = PC.fromPlain('a\n\nb');
  assert.deepStrictEqual([txtsOf(r), r.inline, r.below], [['a', 'b'], false, true], '空の行で分けない（NC1: OC-04）');
  r = PC.fromPlain('a\n\n\n\nb\n\nc');
  assert.deepStrictEqual(txtsOf(r), ['a', 'b', 'c'], '空の行そのものを行にした');
  r = PC.fromPlain('a');
  assert.deepStrictEqual([txtsOf(r), r.inline, r.below], [['a'], true, false], '1行の文が今どおり inline でない');
  r = PC.fromPlain('a\n');
  assert.deepStrictEqual([txtsOf(r), r.inline, r.below], [['a'], true, false], '末の改行だけで何行かの文にした');
  r = PC.fromPlain('a\r\n b  \n');
  assert.deepStrictEqual([txtsOf(r), r.below], [['a\n b'], true], '行の頭の空白を落とした・末の空白を残した');
  assert.deepStrictEqual(txtsOf(PC.fromPlain('a\u0000b\nc\u0007')), ['ab\nc'], '制御の文字を落とさない');
  // 100,000 字（validate.LIMITS.text）を越える段落は、越える前の最後の改行で次の行に（F246）
  const x = 'x'.repeat(60000); const y = 'y'.repeat(39999); const z = 'z'.repeat(10);
  r = PC.fromPlain(`${x}\n${y}\n${z}`);
  assert.deepStrictEqual(r.blocks.map((b) => b.rich[0].t.length), [100000, 10], '越える前の最後の改行で分けない');
  assert.ok(r.blocks.every((b) => b.rich[0].t.length <= 100000));
  assert.strictEqual(PC.fromPlain(`${x}\n${x}`).blocks.length, 2);
  // 改行の無い 100,001 字は今どおり大きすぎる
  assert.deepStrictEqual(PC.fromPlain('a'.repeat(100001)), { tooBig: true });
  assert.deepStrictEqual(PC.fromPlain(`b\n${'a'.repeat(100001)}`), { tooBig: true });
});
test('XE-2・F246: Markdown の印のある文字（- a\\n- b）・HTML の貼り付けは今と同じ行（below を持たない）。素の文字だけが below を持つ', () => {
  const md = PC.pasteBlocks({ text: '- a\n- b' });
  assert.deepStrictEqual([md.blocks.map((b) => `${b.type}:${b.rich[0].t}`), Object.hasOwn(md, 'below')], [['bullet:a', 'bullet:b'], false]);
  const h = PC.pasteBlocks({ html: '<p>a</p><p>b</p>', text: 'a\nb' });
  assert.deepStrictEqual([h.blocks.length, Object.hasOwn(h, 'below')], [2, false]);
  const p = PC.pasteBlocks({ text: 'a\nb' });
  assert.deepStrictEqual([txtsOf(p), p.below, p.inline], [['a\nb'], true, false]);
});

// ---------------------------------------------------------------- XE-3（決めたこと 59・AQ25 (a)・F247）: 折り返した行の ↑↓（src/caretLine.js）
const CL = require('../src/caretLine');
test('XE-3・F247: edgeOf の表（1行は only・3行の1行目は first・3行目は last・2行目は middle・行の境のカーソルは下の行・同じ見た目の行の四角はまとめる・拡大 200% の小数の座標）', () => {
  const L3 = [{ top: 0, bottom: 20 }, { top: 20, bottom: 40 }, { top: 40, bottom: 60 }];
  const at = (top, bottom = top + 20) => ({ top, bottom });
  assert.strictEqual(CL.edgeOf({ caret: at(0), lines: [{ top: 0, bottom: 20 }] }), 'only');
  assert.strictEqual(CL.edgeOf({ caret: at(0), lines: [{ top: 0, bottom: 20 }, { top: 1, bottom: 19 }] }), 'only', '同じ見た目の行の2つの箱を2行にした');
  assert.strictEqual(CL.edgeOf({ caret: at(0), lines: L3 }), 'first');
  assert.strictEqual(CL.edgeOf({ caret: at(20), lines: L3 }), 'middle');
  assert.strictEqual(CL.edgeOf({ caret: at(40), lines: L3 }), 'last');
  assert.strictEqual(CL.edgeOf({ caret: { top: 10, bottom: 30 }, lines: L3 }), 'middle', '行の境のカーソル（前の行の末と次の行の頭）が下の行でない');
  assert.strictEqual(CL.edgeOf({ caret: { top: 30, bottom: 50 }, lines: L3 }), 'last');
  // 拡大 200%（小数の座標・行の高さ 18.4px）
  const Z = [{ top: 100.2, bottom: 118.6 }, { top: 118.6, bottom: 137 }, { top: 137, bottom: 155.4 }];
  assert.deepStrictEqual([at(100.2, 118.6), at(118.6, 137), at(137, 155.4)].map((c) => CL.edgeOf({ caret: c, lines: Z })), ['first', 'middle', 'last']);
  assert.strictEqual(CL.edgeOf({ caret: { top: 100.6, bottom: 118.2 }, lines: [{ top: 100.2, bottom: 118.6 }, { top: 100.4, bottom: 118.5 }, { top: 118.6, bottom: 137 }] }), 'first', '小数のずれで同じ行を別の行にした');
  // 読めない（四角が無い・カーソルが無い）は only
  assert.strictEqual(CL.edgeOf({}), 'only');
  assert.strictEqual(CL.edgeOf({ caret: null, lines: L3 }), 'only');
  assert.deepStrictEqual(CL.linesOf([{ top: 40, bottom: 60 }, { top: 0, bottom: 20 }, { top: 2, bottom: 18 }]), [{ top: 0, bottom: 20 }, { top: 40, bottom: 60 }]);
});
test('XE-3・F247: pickOffset の表（x が字の真ん中より左なら前・右なら後ろ・行より右なら行の末・空の行は 0・サロゲートの字は end まで）', () => {
  const chars = [{ left: 0, right: 10, offset: 4 }, { left: 10, right: 20, offset: 5 }, { left: 20, right: 30, offset: 6 }];
  assert.strictEqual(CL.pickOffset({ x: 4, chars }), 4);
  assert.strictEqual(CL.pickOffset({ x: 6, chars }), 5);
  assert.strictEqual(CL.pickOffset({ x: 14.9, chars }), 5);
  assert.strictEqual(CL.pickOffset({ x: 15.1, chars }), 6);
  assert.strictEqual(CL.pickOffset({ x: -5, chars }), 4, '行より左が頭でない');
  assert.strictEqual(CL.pickOffset({ x: 500, chars }), 7, '行より右が行の末でない');
  assert.strictEqual(CL.pickOffset({ x: 3, chars: [] }), 0);
  assert.strictEqual(CL.pickOffset({ x: 40, chars: [{ left: 0, right: 20, offset: 0, end: 2 }] }), 2, 'サロゲートの字の後ろが end でない');
  assert.strictEqual(CL.pickOffset({ x: 12.25, chars: [{ left: 0.5, right: 12.5, offset: 0 }, { left: 12.5, right: 24.5, offset: 1 }] }), 1, '拡大の小数の座標');
});

// ---------------------------------------------------------------- XN-1（決めたこと 62・AQ11 (a)・AQ27 (a)・AQ28 (a)・F249）: ページの複製（src/db/duplicate.js の planDuplicate）
// 行は DB の blocks の行の形（attrs と rich は JSON の文字）。ページの題名・データベースの名前は作った物
const DUP = require('../src/db/duplicate');
const AT0 = '2026-11-01T00:00:00.000Z';
const dRow = (id, type, page, parent, ord, attrs = {}, more = {}) => ({ id, type, page_id: page, parent_id: parent, ord, text: more.text ?? '', rich: more.rich === undefined ? null : JSON.stringify(more.rich),
  attrs: JSON.stringify(attrs), rev: 3, created_at: type === 'page' || type === 'row' ? AT0 : '', updated_at: type === 'page' || type === 'row' ? AT0 : '', trashed_at: more.trashed ?? null });
const dPage = (id, parent, attrs, more = {}) => dRow(id, 'page', id, parent, more.ord ?? 'i', attrs, { text: more.text ?? `題 ${id}`, trashed: more.trashed });
const dRowOf = (id, dbId, cells, more = {}) => dRow(id, 'row', id, dbId, more.ord ?? 'a', { cells, by: { c: 'claude', u: 'claude' }, no: more.no ?? 1, ...(more.tpl ? { tpl: true } : {}) }, { text: `行 ${id}`, trashed: more.trashed });
const dBlock = (id, page, type, attrs = {}, more = {}) => dRow(id, type, page, more.parent ?? page, more.ord ?? 'a', attrs, { text: more.text ?? '', rich: more.rich });
// 根の白紙のページ P1 の木（外のデータベース DX・外のタスクの行 rT・外のページ PX を指す行も持つ）
function dupTree() {
  const D1 = { kind: 'database', locked: true, nextNo: 4,
    cols: [{ id: 'title', name: '名前', type: 'title' }, { id: 'c1', name: '親アイテム', type: 'rel', db: 'D1', back: 'c2' }, { id: 'c2', name: 'サブアイテム', type: 'rel', db: 'D1', back: 'c1' },
      { id: 'c3', name: '外の両側', type: 'rel', db: 'DX', back: 'cx' }, { id: 'c4', name: '外の片側', type: 'rel', db: 'DX' }, { id: 'c5', name: 'メモの列', type: 'text' }],
    views: [{ id: 'v1', name: '表', layout: 'table', filter: { op: 'and', items: [{ col: 'c1', op: 'contains', value: 'r2' }, { col: 'c3', op: 'contains', value: 'rx1' }] } }],
    sub: { parent: 'c1', kids: 'c2' }, tplDefault: 'rTpl', tplViews: { v1: 'rTpl' } };
  return [
    dPage('P1', 'PX', { kind: 'blank', memo: '', date: '2026-11-01' }, { text: '元のページ', ord: 'm' }),
    dBlock('b1', 'P1', 'paragraph', {}, { text: '本文の一行', rich: [{ t: '本文の', m: ['b'] }, { t: '一行', m: [] }], ord: 'a' }),
    dBlock('b2', 'P1', 'subpage', { page: 'P2' }, { ord: 'b' }),
    dBlock('b3', 'P1', 'subpage', { page: 'D1', inline: true }, { ord: 'c' }),
    dBlock('b4', 'P1', 'dbview', { db: 'D1', views: [{ id: 'v1', name: '表', layout: 'table', filter: { op: 'and', items: [{ col: 'c1', op: 'contains', value: 'r1' }] } }] }, { ord: 'd' }),
    dBlock('b5', 'P1', 'dbview', { db: 'DX', views: [{ id: 'v1', name: '表', layout: 'table' }] }, { ord: 'e' }),
    dBlock('b6', 'P1', 'todo', { task: 'rT', done: false }, { text: '外のタスクの ToDo', ord: 'f' }),
    dBlock('b7', 'P1', 'subpage', { page: 'P3' }, { ord: 'g' }),
    dBlock('b8', 'P1', 'subpage', { page: 'PX' }, { ord: 'h' }),
    dBlock('b9', 'P1', 'toggle', {}, { text: '畳む行', ord: 'i' }),
    dBlock('b10', 'P1', 'paragraph', {}, { text: '畳む行の子', parent: 'b9', ord: 'a' }),
    dPage('P2', 'P1', { kind: 'blank', memo: '', rowAt: { parent: 'P1', ord: 'b' } }, { ord: 'a' }),
    dBlock('b11', 'P2', 'paragraph', {}, { text: '子のページの本文' }),
    dPage('P3', 'P1', { kind: 'blank', memo: '' }, { ord: 'c', trashed: '2026-11-02T00:00:00.000Z' }),
    dBlock('b12', 'P3', 'paragraph', {}, { text: 'ゴミ箱の子の本文' }),
    dPage('P5', 'P3', { kind: 'blank', memo: '' }, { trashed: '2026-11-02T00:00:00.000Z' }),
    dPage('D1', 'P1', D1, { text: '中の表', ord: 'b' }),
    dRowOf('r1', 'D1', { c1: ['r2'], c3: ['rx1'], c4: ['rx2'], c5: 'メモ', c2: ['rDead'] }, { ord: 'a', no: 1 }),
    dRowOf('r2', 'D1', { c2: ['r1'] }, { ord: 'b', no: 2 }),
    dRowOf('rTpl', 'D1', { c5: 'ひな形' }, { ord: 'c', tpl: true }),
    dRowOf('rDead', 'D1', { c1: ['r1'] }, { ord: 'd', no: 3, trashed: '2026-11-02T00:00:00.000Z' }),
    dBlock('b13', 'r1', 'paragraph', {}, { text: '行の本文' }),
    dBlock('b14', 'r1', 'subpage', { page: 'P4' }),
    dPage('P4', 'r1', { kind: 'blank', memo: '' }),
    dBlock('b15', 'P4', 'paragraph', {}, { text: '行の中のページの本文' }),
    dBlock('b16', 'rDead', 'paragraph', {}, { text: 'ゴミ箱の行の本文' }),
  ];
}
const dupIdOf = (r) => `${r.type === 'page' ? 'p' : r.type === 'row' ? 'r' : 'b'}N${r.id}`;
const dupParse = (row) => ({ ...row, attrs: typeof row.attrs === 'string' ? JSON.parse(row.attrs) : row.attrs });

test('XN-1・F249: planDuplicate の表（どの行も新しい ID・写しの中を指す指しは写しへ・外はそのまま・外の両側の列は片側・ゴミ箱の子は写さない・ロックした表を中に持つページは写せ写しの表もロック中・題名の「 (1)」は1つ）', () => {
  const rows = dupTree();
  const r = DUP.planDuplicate(rows, 'P1', dupIdOf);
  assert.strictEqual(r.blocked, '');
  const ids = new Set(rows.map((x) => x.id));
  const byNew = new Map(r.ops.map((o) => [o.id, o.row]));
  const src = (o) => o.id.slice(2);
  assert.deepStrictEqual(r.ops.map((o) => o.op), r.ops.map(() => 'add'));
  assert.ok(r.ops.every((o) => !ids.has(o.id) && o.row.id === o.id), '元の ID を使った行がある');
  assert.strictEqual(new Set(r.ops.map((o) => o.id)).size, r.ops.length, '写しの ID が重なった');
  // 写すのはゴミ箱の子（P3・P5・その本文・rDead とその本文）と、ゴミ箱の子を指す本文の行（b7）のほか全部
  assert.deepStrictEqual(r.ops.map(src).sort(), ['P1', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b8', 'b9', 'b10', 'P2', 'b11', 'D1', 'r1', 'r2', 'rTpl', 'b13', 'b14', 'P4', 'b15'].sort());
  assert.strictEqual(r.count, r.ops.length);
  // 木の形: page_id・parent_id は写しの中（根の親は元の親のまま）・並びの鍵は元のまま
  for (const o of r.ops) {
    const was = rows.find((x) => x.id === src(o));
    assert.strictEqual(o.row.type, was.type);
    assert.strictEqual(o.row.ord, was.ord, `${o.id} の並びの鍵`);
    assert.strictEqual(o.row.page_id, was.id === 'P1' ? 'pNP1' : dupIdOf(rows.find((x) => x.id === was.page_id)), `${o.id} の page_id`);
    if (was.id === 'P1') assert.strictEqual(o.row.parent_id, 'PX', '根の親が変わった');
    else assert.strictEqual(o.row.parent_id, dupIdOf(rows.find((x) => x.id === was.parent_id)), `${o.id} の parent_id`);
    assert.strictEqual(o.row.trashed_at, null);
  }
  const at = (id) => dupParse(byNew.get(id));
  // 題名・文・飾り
  assert.strictEqual(at('pNP1').text, '元のページ (1)');
  assert.strictEqual(at('pNP2').text, '題 P2', '子のページの題名まで (1) にした');
  assert.strictEqual(at('bNb1').text, '本文の一行');
  assert.deepStrictEqual(at('bNb1').rich, [{ t: '本文の', m: ['b'] }, { t: '一行', m: [] }]);
  // 本文の指し: 子ページの行・インラインの行・リンクドビューは写しへ。外のデータベース・外のページ・外のタスクはそのまま
  assert.deepStrictEqual(at('bNb2').attrs, { page: 'pNP2' });
  assert.deepStrictEqual(at('bNb3').attrs, { page: 'pND1', inline: true });
  assert.strictEqual(at('bNb4').attrs.db, 'pND1');
  assert.deepStrictEqual(at('bNb4').attrs.views[0].filter.items[0], { col: 'c1', op: 'contains', value: 'rNr1' });
  assert.strictEqual(at('bNb5').attrs.db, 'DX');
  assert.deepStrictEqual(at('bNb6').attrs, { task: 'rT', done: false });
  assert.deepStrictEqual(at('bNb8').attrs, { page: 'PX' });
  assert.deepStrictEqual(at('bNb14').attrs, { page: 'pNP4' });
  assert.ok(!('rowAt' in at('pNP2').attrs), '子のページの rowAt（元の本文の置き場）を写した');
  // データベース: ロック・番号・列（自分への列は写しへ・外の両側は片側・外の片側はそのまま）・サブアイテム・テンプレートの既定・ビューの条件
  const d = at('pND1').attrs;
  assert.strictEqual(d.locked, true, 'ロックを写さない（AQ27 (a)・OC-14）');
  assert.strictEqual(d.nextNo, 4);
  assert.deepStrictEqual(d.cols.find((c) => c.id === 'c1'), { id: 'c1', name: '親アイテム', type: 'rel', db: 'pND1', back: 'c2' });
  assert.deepStrictEqual(d.cols.find((c) => c.id === 'c2'), { id: 'c2', name: 'サブアイテム', type: 'rel', db: 'pND1', back: 'c1' });
  assert.deepStrictEqual(d.cols.find((c) => c.id === 'c3'), { id: 'c3', name: '外の両側', type: 'rel', db: 'DX' }, '外の両側の列を写しでも両側にした（OC-13）');
  assert.deepStrictEqual(d.cols.find((c) => c.id === 'c4'), { id: 'c4', name: '外の片側', type: 'rel', db: 'DX' });
  assert.deepStrictEqual(d.sub, { parent: 'c1', kids: 'c2' });
  assert.strictEqual(d.tplDefault, 'rNrTpl');
  assert.deepStrictEqual(d.tplViews, { v1: 'rNrTpl' });
  assert.deepStrictEqual(d.views[0].filter.items, [{ col: 'c1', op: 'contains', value: 'rNr2' }, { col: 'c3', op: 'contains', value: 'rx1' }]);
  // 行: セルのリレーションは写しの中なら写しへ・外はそのまま・ゴミ箱の行（写さない）は外す。番号・テンプレートの印はそのまま
  assert.deepStrictEqual(at('rNr1').attrs.cells, { c1: ['rNr2'], c3: ['rx1'], c4: ['rx2'], c5: 'メモ' });
  assert.deepStrictEqual(at('rNr2').attrs.cells, { c2: ['rNr1'] });
  assert.strictEqual(at('rNr1').attrs.no, 1);
  assert.strictEqual(at('rNrTpl').attrs.tpl, true);
  // 元の行は1つも変えない（入れた物を書き換えない）
  assert.deepStrictEqual(rows, dupTree());
  // 写しの写し: 題名の「 (1)」は1つ（Q-22）。末が「 (1)」でない題名（「 (2)」・空）には足す
  const again = DUP.planDuplicate([{ ...rows[0], text: '元のページ (1)' }], 'P1', dupIdOf);
  assert.strictEqual(again.ops[0].row.text, '元のページ (1)', '写しの写しの題名が「 (1) (1)」');
  assert.strictEqual(DUP.planDuplicate([{ ...rows[0], text: '元 (2)' }], 'P1', dupIdOf).ops[0].row.text, '元 (2) (1)');
  assert.strictEqual(DUP.dupTitle(''), '(1)');
  assert.strictEqual(DUP.dupTitle('あ'.repeat(500)).length, 500, '題名の上限（500 字）を越えた');
  assert.ok(DUP.dupTitle('あ'.repeat(500)).endsWith('あ (1)'));
});

test('XN-1・F249: planDuplicate の blocked（議事録・録音中の写し・「議事録」「タスク管理」を含む・ロック中のデータベースそのもの）と、ゴミ箱の議事録は写さないので断らない・1 万を越えれば too-big', () => {
  const blank = (id, parent, more) => dPage(id, parent, { kind: 'blank', memo: '' }, more);
  const plan = (rows, root = 'R') => DUP.planDuplicate(rows, root, dupIdOf);
  const none = (r, why) => { assert.strictEqual(r.blocked, why); assert.deepStrictEqual(r.ops, []); };
  none(plan([blank('R', null), dPage('M', 'R', { memo: '', date: '2026-11-01' })]), 'meeting');
  none(plan([dPage('R', null, { memo: '' })]), 'meeting');
  none(plan([blank('R', null), dPage('L', 'R', { memo: '', meeting: { phase: 'recording' } })]), 'live');
  none(plan([blank('R', null), dPage('Dm', 'R', { kind: 'database', role: 'minutes', cols: [], views: [] })]), 'role');
  none(plan([blank('R', null), dPage('Dt', 'R', { kind: 'database', role: 'tasks', cols: [], views: [] })]), 'role');
  none(plan([dPage('R', null, { kind: 'database', locked: true, cols: [], views: [] })]), 'locked');
  // 行の本文の中のページの下の議事録も
  none(plan([dPage('R', null, { kind: 'database', cols: [], views: [] }), dRowOf('rr', 'R', {}), dPage('Pm', 'rr', { memo: '' })]), 'meeting');
  // ゴミ箱の議事録は写さないので断らない
  const ok1 = plan([blank('R', null), dPage('M', 'R', { memo: '' }, { trashed: AT0 })]);
  assert.strictEqual(ok1.blocked, '');
  assert.deepStrictEqual(ok1.ops.map((o) => o.id), ['pNR']);
  // 1 万（ページ・行・ブロックの合計）まで写せ、越えれば too-big（何も作らない）
  const big = (n) => [blank('R', null), ...Array.from({ length: n - 1 }, (_, i) => dBlock(`k${i}`, 'R', 'paragraph', {}, { text: `${i}` }))];
  assert.strictEqual(DUP.DUP_MAX, 10000);
  const atMax = plan(big(10000));
  assert.strictEqual(atMax.blocked, '');
  assert.strictEqual(atMax.count, 10000);
  none(plan(big(10001)), 'too-big');
  // 根が無い・ゴミ箱の根は null（命令が bad-args）
  assert.strictEqual(plan([blank('X', null)]), null);
  assert.strictEqual(plan([blank('R', null, { trashed: AT0 })]), null);
});

// ---------------------------------------------------------------- XN-3（決めたこと 63・AQ12 (a)・F250）: 見出し4
const BE = require('../src/blockEdit');
const VAL = require('../src/db/validate');
const MDOC = require('../src/memoDoc');
const FMT = require('../src/mcp/format');
test('XN-3・F250: 型の表に h4・th4（/ メニューと［変換 ▸］の項目）・/h4・/####・####＋空白・headingLevel が 1〜4・validate.level が 1〜4（5 は bad-args）・貼る行とメモの行の段も 1〜4・貼り付けの #### 以上と h4〜h6 は見出し4・Ctrl+Shift+4 は今どおり ToDo', () => {
  const h4 = BE.BLOCK_TYPES.find((r) => r.id === 'h4');
  assert.ok(h4, '型の表に h4 が無い');
  assert.deepStrictEqual([h4.key, h4.level, h4.label, [...h4.md], h4.kids, h4.code], ['heading', 4, '見出し4', ['#### '], false, undefined]);
  assert.strictEqual(BE.BLOCK_TYPES.indexOf(h4), BE.BLOCK_TYPES.findIndex((r) => r.id === 'h3') + 1, 'h4 が h3 の次に無い');
  assert.deepStrictEqual(BE.MENU_ROWS.filter((r) => r.key === 'heading').map((r) => [r.id, r.level, r.label]),
    [['h1', 1, '見出し1'], ['h2', 2, '見出し2'], ['h3', 3, '見出し3'], ['h4', 4, '見出し4'], ['th1', 1, 'トグル見出し1'], ['th2', 2, 'トグル見出し2'], ['th3', 3, 'トグル見出し3'], ['th4', 4, 'トグル見出し4']]);
  const ids = (q) => (BE.slashFilter(q, []) || []).map((x) => x.id);
  assert.deepStrictEqual(ids('h4'), ['h4', 'th4'], '/h4 で見出し4とトグル見出し4が出ない（OC-15）');
  assert.ok(ids('####').includes('h4'), '/#### で見出し4が出ない');
  assert.ok(ids('見出し4').includes('h4'));
  assert.deepStrictEqual(BE.shortcutFor('#### '), { type: 'heading', level: 4, strip: 5 });
  assert.deepStrictEqual(BE.shortcutFor('### '), { type: 'heading', level: 3, strip: 4 });
  assert.deepStrictEqual([1, 2, 3, 4, 5, undefined].map((level) => BE.headingLevel({ type: 'heading', level })), [1, 2, 3, 4, 2, 2]);
  assert.strictEqual(BE.typeOf({ type: 'heading', level: 4 }).id, 'h4');
  assert.strictEqual(BE.typeOf({ type: 'heading', level: 4, toggle: true }).id, 'th4');
  assert.strictEqual(BE.keyAction({ ctrlKey: true, shiftKey: true, code: 'Digit4', key: '$' }), 'turn:todo', 'Ctrl+Shift+4 が ToDo でない');
  assert.strictEqual(BE.blocksMarkdown([{ id: 'a', type: 'heading', level: 4, text: '小見出し' }]).trim(), '#### 小見出し');
  // DB の照らし
  assert.deepStrictEqual(VAL.checkArgs({ level: 'level' }, { level: 4 }), { ok: true, args: { level: 4 } });
  assert.deepStrictEqual(VAL.checkArgs({ level: 'level' }, { level: 5 }), { ok: false, field: 'level' });
  const pasted = VAL.checkArgs({ blocks: 'pasteBlocks' }, { blocks: [{ type: 'heading', level: 4, rich: [{ t: 'よん' }] }] });
  assert.strictEqual(pasted.ok && pasted.args.blocks[0].level, 4);
  assert.deepStrictEqual(VAL.checkArgs({ blocks: 'pasteBlocks' }, { blocks: [{ type: 'heading', level: 5, rich: [{ t: 'ご' }] }] }), { ok: false, field: 'blocks' });
  const memo = MDOC.validateMemoDoc([{ id: 'm1', type: 'heading', level: 4, text: 'メモの小見出し', citeState: 'manual' }]);
  assert.strictEqual(memo[0].level, 4, 'メモの行が見出し4を断った');
  assert.throws(() => MDOC.validateMemoDoc([{ id: 'm1', type: 'heading', level: 5, text: 'ご', citeState: 'manual' }]));
  // 貼り付け（OC-15）
  const md = PC.fromMarkdown('#### よん\n##### ご\n###### ろく\n### さん');
  assert.deepStrictEqual(md.blocks.map((b) => [b.type, b.level]), [['heading', 4], ['heading', 4], ['heading', 4], ['heading', 3]]);
  const html = PC.fromHtml('<h3>さん</h3><h4>よん</h4><h5>ご</h5><h6>ろく</h6>');
  assert.deepStrictEqual(html.blocks.map((b) => [b.type, b.level]), [['heading', 3], ['heading', 4], ['heading', 4], ['heading', 4]]);
});
test('XN-3・F250: markdownToBlocks の #### は今どおり段 3（要約の見出しは3段のまま・要約の型の印 markBlocks も今と同じ）。0.17.0 の headingLevel を写した見本で段 4 を読むと段 2（落ちない・字と段の値は残る）。MCP の答えの見出し4は #####（段 1・2 は ###・段 3 は ####）', () => {
  const b = markdownToBlocks('#### 小見出し\n- 要点');
  assert.deepStrictEqual([b[0].type, b[0].level], ['heading', 3], '要約の #### が見出し4になった');
  const marked = memoTypes.markBlocks(markdownToBlocks('## 決定事項\n#### 小見出し\n- 予算は据え置き'), { meetingType: 'standup' });
  assert.deepStrictEqual(marked.blocks.filter((x) => x.type === 'heading').map((x) => [x.level, x.text]), [[2, '決定事項'], [3, '小見出し']]);
  // 0.17.0 の headingLevel（src/blockEdit.js の 0.17.0 の字）で段 4 の行を読む
  const old170 = (x) => (x && (x.level === 1 || x.level === 2 || x.level === 3) ? x.level : 2);
  const row = { id: 'q', type: 'heading', level: 4, text: '残る字' };
  assert.strictEqual(old170(row), 2);
  assert.deepStrictEqual([row.level, row.text], [4, '残る字']);
  const page = { id: 'pb1', kind: 'blank', title: '見出しの見本',   // 白紙のページの題名（D77 の外）
    blocks: [1, 2, 3, 4].map((level) => ({ id: `h${level}`, type: 'heading', level, text: `段${level}` })) };
  const text = FMT.meetingMarkdown(page, [], { header: false }).text;
  assert.deepStrictEqual(text.split('\n').filter((l) => /段\d$/.test(l)), ['### 段1', '### 段2', '#### 段3', '##### 段4']);
});

// ---------------------------------------------------------------- XN-4（決めたこと 64・65・AQ13 (a)・AQ14 (a)・AQ29 (a)・AQ30 (a)・F251）: / メニューの閉じ方と語
test('XN-4・F251: slashMiss の表（当たりのある間は 0・当たらない字の 1〜4 は開いたまま・5 で閉じる・当たらないままの Backspace で1つ減る・当たる語に戻れば 0・3字を1回で確定すると 3・その後に2字で 5）', () => {
  assert.strictEqual(BE.SLASH_CLOSE_AT, 5);
  let st = { miss: 0, query: '' };
  const step = (q, found) => { const r = BE.slashMiss(st, q, found); st = { miss: r.miss, query: q }; return [r.miss, r.close]; };
  assert.deepStrictEqual(step('見', true), [0, false]);
  assert.deepStrictEqual(step('見ぬ', false), [1, false]);
  assert.deepStrictEqual(step('見ぬぬ', false), [2, false]);
  assert.deepStrictEqual(step('見ぬぬぬ', false), [3, false]);
  assert.deepStrictEqual(step('見ぬぬぬぬ', false), [4, false], '4つ目で閉じた（2026-11-14 の記録の形。AQ29 (a) は5つ目）');
  assert.deepStrictEqual(step('見ぬぬぬ', false), [3, false], '当たらないままの Backspace で減らない');
  assert.deepStrictEqual(step('見ぬぬぬぬ', false), [4, false]);
  assert.deepStrictEqual(step('見ぬぬぬぬぬ', false), [5, true], '5つ目で閉じない');
  st = { miss: 4, query: 'ぬぬぬぬ' };
  assert.deepStrictEqual(step('', true), [0, false], '当たる語に戻っても数え直さない');
  st = { miss: 0, query: '' };
  assert.deepStrictEqual(step('ぬぬぬ', false), [3, false], '3字を1回で確定したら 3（CR26）');
  assert.deepStrictEqual(step('ぬぬぬぬぬ', false), [5, true], '3字の後に2字を確定すると 5 で閉じる');
  assert.deepStrictEqual(BE.slashMiss(null, 'abc', false), { miss: 3, close: false });
  assert.deepStrictEqual(BE.slashMiss({ miss: 0, query: '' }, '𠮷𠮷', false), { miss: 2, close: false }, '字はコードポイントで数える');
});
test('XN-4・F251: slashFilter: ひらがなの読み（みだし・とぐる・こーるあうと・てきすと）では当たらない・名前（見出・出し）と英語の語（h1・head）は当たる・「チェック」「メモ書き」「やること」は何も当たらない・「リスト」は箇条書き・番号付き・トグル（ToDo とトグル見出しには当たらない）・当たりが無いときは空の並び（null を返さない）', () => {
  const ids = (q) => { const x = BE.slashFilter(q, []); assert.ok(Array.isArray(x), `${q} の答えが並びでない`); return x.map((i) => i.id); };
  for (const q of ['みだし', 'とぐる', 'こーるあうと', 'てきすと', 'かじょうがき', 'ばんごう', 'いんよう', 'くぎり', 'とぅーどぅー', 'チェック', 'メモ書き', 'やること', 'メモ', 'ぬぬぬぬぬぬ']) {
    assert.deepStrictEqual(ids(q), [], q);
  }
  assert.ok(ids('見出').includes('h1') && ids('見出').includes('h4'));
  assert.ok(ids('出し').includes('h2'));
  assert.deepStrictEqual(ids('h1'), ['h1', 'th1']);
  assert.ok(ids('head').includes('th1'));
  assert.deepStrictEqual(ids('リスト'), ['bullet', 'numbered', 'toggle'], '「リスト」（OC-17・AQ30 (a)）');
  assert.deepStrictEqual(ids('todo'), ['todo']);
  assert.deepStrictEqual(ids('コール'), ['callout']);
  for (const r of BE.MENU_ROWS) for (const w of r.words) assert.ok(!/^[ぁ-ゟー0-9]+$/.test(w), `${r.id} にひらがなだけの語 ${w}`);
});
