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
