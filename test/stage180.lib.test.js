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
