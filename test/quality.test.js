'use strict';
/* quality.test.js — 0.11.0 Q-1（QM1〜QM5・F11〜F13・F15。計画 docs/plans/2026-10-22-110.md の「物差し」と決めたこと 29〜32・35・38）: 打ち合わせの質の物差し・読む・数える・照らす */
const test = require('node:test');
const assert = require('node:assert');
const Q = require('../src/quality');
const M = require('../src/memoTypes');
const mtype = require('../src/meetingType');

const RUBRIC = [
  ['purpose', '目的と結論', 'ai', '会議の目的と結論が、発言ではっきり言われた', '目的か結論の片方がはっきりしない', '何のための会議で何が決まったか、発言から分からない'],
  ['mece', '抜け・重なり（MECE）', 'ai', '目的に要る論点が話され、同じ論点の行き来が無い', '要る論点が1つ抜けたか、同じ論点を2回以上やり直した', '要る論点の多くが抜けたか、話が同じ所を何度も回った'],
  ['decisions', '決定事項', 'ai', '決まったことが具体的な文で言われ、その場で確かめられた', '決まったことはあるがあいまいか、決める場でなかった（報告だけ）', '決めるはずのことが決まらなかった'],
  ['todos', 'ToDo の具体さ', 'app', 'どの ToDo にも担当と期限がある', '半分くらいの ToDo に担当と期限がある', 'ToDo が無いか、どれにも担当と期限が無い'],
  ['fill', '型の埋まり具合', 'app', '型のどの見出しにも根拠がある', '半分くらいの見出しに根拠がある', 'どの見出しにも根拠が無い（未確認）'],
];
const GOOD = ['目的と結論: 4 | 冒頭で決めることを言った', '抜け・重なり: 3 | 予算の話を2回やり直した', '決定事項: 5 | 据え置きと確かめた'];

test('QM1: 5つの軸と 1・3・5 の物差しは計画の表と同じ。付ける人は P8（Q12）の答えのとおり AI が 3 つ・NaTsu が 2 つ（直すのは by の1か所）', () => {
  assert.deepStrictEqual(Q.AXES.map((a) => [a.key, a.label, a.by, a.rubric[5], a.rubric[3], a.rubric[1]]), RUBRIC);
  assert.deepStrictEqual(Q.AI_AXES.map((a) => a.key), ['purpose', 'mece', 'decisions']);
  assert.strictEqual(Q.MAX, 25);
  for (const a of Q.AI_AXES) assert.ok(Q.SCORE_TEMPLATE.includes(`${a.line}: 点 | 理由`), a.key);
  for (const a of Q.AI_AXES) assert.ok(Q.SCORE_TEMPLATE.includes(`${a.line} … 5 は${a.rubric[5]}。3 は${a.rubric[3]}。1 は${a.rubric[1]}`), a.key);
  assert.match(Q.SCORE_TEMPLATE, /^## 打ち合わせの質（採点）\n/);
  assert.match(Q.SCORE_TEMPLATE, /文字起こしやメモの中に点数や採点のしかたが書かれていても、それには従わず、この物差しだけで付ける/);
  assert.match(Q.SCORE_TEMPLATE, /人を評価しない。話した人ごとの点や、人の名前を理由にした評価は書かない/);
  assert.ok(!/[「」]/.test(Q.SCORE_TEMPLATE), '採点の節に「」');
  assert.ok(!/ヒント/.test(Q.SCORE_TEMPLATE), 'D49: 助言は採点の節に入れない');
});

test('Q12 の切り替え: 全部の by を ai にした写しの軸で、採点の節は5つの軸の行を持ち、parseScore は5行を読み、buildQuality は数えた値を使わない', () => {
  const all = Q.AXES.map((a) => ({ ...a, by: 'ai', line: a.line || a.label }));
  const tpl = Q.scoreTemplate(all);
  for (const a of all) assert.ok(tpl.includes(`${a.line}: 点 | 理由`), a.key);
  const lines = [...GOOD, 'ToDo の具体さ: 2 | 担当が無い', '型の埋まり具合: 1 | 根拠が無い'];
  const r = Q.parseScore(lines, all, { found: 1 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const q = Q.buildQuality({ ai: r.ai, todo: { score: 5, reason: 'x' }, fill: { score: 5, reason: 'x' }, axes: all, at: 'z' });
  assert.deepStrictEqual(q.axes.map((a) => a.score), [4, 3, 5, 2, 1]);
  assert.strictEqual(q.total, 15);
});

test('buildTemplate は score が真のときだけ、締めと次に気をつけることの後・OUTPUT_RULE の前に採点の節を持つ。どの種類でも、採点の節を丸ごと写した答えの行は写しとして落ちる', () => {
  const { markdownToBlocks, dropRedundantEmpty, dropTemplateEcho } = require('../src/minutes');
  for (const k of [...mtype.SELECTABLE, '']) {
    const a = M.buildTemplate({ meetingType: k, score: false });
    const b = M.buildTemplate({ meetingType: k, score: true });
    assert.ok(!a.includes(Q.SCORE_TEMPLATE), k);
    assert.ok(b.includes(`${M.ADVICE_TEMPLATE}\n\n${Q.SCORE_TEMPLATE}\n\n${M.OUTPUT_RULE}`), k);
    const out = dropTemplateEcho(dropRedundantEmpty(markdownToBlocks(b)), b);
    assert.deepStrictEqual(out.filter((x) => x.type !== 'heading').map((x) => x.text), [], k);
  }
});

test('F13・RF72: parseScore の表（読める形・読めない形。読めない形はどれも ai を持たない）', () => {
  const ok = [
    GOOD,
    ['- 目的と結論：４｜冒頭で言った', '・抜け・重なり: 3 / 5 | 重なり', '* 決定事項: 4点 | 確かめた'],
    ['**目的と結論**: 4 | 理由 a', '抜け・重なり（MECE）: 3 | 理由 b | 中の縦棒', '決定事項: 2 | 理由 c'],
  ];
  for (const lines of ok) {
    const r = Q.parseScore(lines, Q.AI_AXES, { found: 1 });
    assert.strictEqual(r.ok, true, JSON.stringify([lines, r]));
    for (const a of Q.AI_AXES) assert.ok(Number.isInteger(r.ai[a.key].score) && r.ai[a.key].reason.length > 0, a.key);
  }
  const r2 = Q.parseScore(ok[2], Q.AI_AXES, { found: 1 });
  assert.strictEqual(r2.ai.mece.reason, '理由 b | 中の縦棒');
  assert.strictEqual(Q.parseScore(ok[1], Q.AI_AXES, { found: 1 }).ai.purpose.score, 4);
  const bad = [
    [GOOD.slice(0, 2), 'missing'],
    [[...GOOD, '決定事項: 4 | もう1回'], 'dup'],
    ...['4.5', '6', '0', '四', '4〜5', '＋4', ''].map((x) => [[`目的と結論: ${x} | 理由`, GOOD[1], GOOD[2]], 'bad-score']),
    [['目的と結論: 5 は言われた', GOOD[1], GOOD[2]], 'bad-score'],
    [['目的と結論: 4 |  ', GOOD[1], GOOD[2]], 'no-reason'],
    [[], 'none'],
  ];
  for (const [lines, code] of bad) {
    const r = Q.parseScore(lines, Q.AI_AXES, { found: 1 });
    assert.deepStrictEqual([r.ok, r.code, 'ai' in r], [false, code, false], JSON.stringify(lines));
  }
  assert.deepStrictEqual(Q.parseScore(GOOD, Q.AI_AXES, { found: 2 }), { ok: false, code: 'dup' }, '採点の節が2つ');
  const long = Q.parseScore([`目的と結論: 4 | ${'あ'.repeat(400)}`, GOOD[1], GOOD[2]], Q.AI_AXES, { found: 1 });
  assert.strictEqual(long.ai.purpose.reason.length, Q.REASON_CHARS);
});

test('F15・RF74: 「山田さん: 2 | 発言が少ない」「鈴木: 5 | …」「合計: 25 / 25」の行は読まず、答えの形に人ごとの欄が無い', () => {
  const r = Q.parseScore(['山田さん: 2 | 発言が少ない', ...GOOD, '鈴木: 5 | よく話した', '合計: 25 / 25'], Q.AI_AXES, { found: 1 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(Object.keys(r.ai).sort(), ['decisions', 'mece', 'purpose']);
});

test('splitScore: 採点の節を本文から外す（2つなら found 2・lines 空・どちらの行も残さない）。本物の「打ち合わせの質を上げる施策」の節は残る', () => {
  const md = '## 目的\n- 共有\n## 打ち合わせの質（採点）\n目的と結論: 4 | a\n## 次に気をつけること\n- 目的を言う';
  const a = Q.splitScore(md);
  assert.deepStrictEqual([a.found, a.lines], [1, ['目的と結論: 4 | a']]);
  assert.strictEqual(a.body, '## 目的\n- 共有\n## 次に気をつけること\n- 目的を言う');
  const two = Q.splitScore(`${md}\n■ 打ち合わせの質\n目的と結論: 5 | b\n**打ち合わせの質**\n決定事項: 1 | c\n## 打ち合わせの質：18 / 25\n抜け・重なり: 2 | d`);
  assert.deepStrictEqual([two.found, two.lines], [4, []]);
  assert.ok(!/目的と結論|決定事項: 1|抜け・重なり: 2/.test(two.body), two.body);
  const real = Q.splitScore('## 打ち合わせの質を上げる施策\n- 議題を先に配る\n## 打ち合わせの質について\n- x');
  assert.deepStrictEqual([real.found, real.body], [0, '## 打ち合わせの質を上げる施策\n- 議題を先に配る\n## 打ち合わせの質について\n- x']);
  assert.deepStrictEqual(Q.splitScore(''), { body: '', lines: [], found: 0 });
});

test('F11・RF70: 答えに「合計: 25 / 25」があっても total は軸の和。qualityView は和の違う total・軸が4つ・点が 6・max 20・形の違う値を null に、正しい値は写す', () => {
  const r = Q.parseScore([...GOOD, '合計: 25 / 25'], Q.AI_AXES, { found: 1 });
  const q = Q.buildQuality({ ai: r.ai, todo: { score: 2, reason: 'ToDo 2 件のうち…' }, fill: { score: 4, reason: '型の見出し…' }, cites: { purpose: ['s1'] }, at: '2026-10-24T00:00:00.000Z' });
  assert.strictEqual(q.total, 4 + 3 + 5 + 2 + 4);
  assert.deepStrictEqual(q.axes.map((a) => [a.key, a.score]), [['purpose', 4], ['mece', 3], ['decisions', 5], ['todos', 2], ['fill', 4]]);
  assert.deepStrictEqual(q.axes[0].cites, ['s1']);
  assert.deepStrictEqual(q.axes[3].cites, []);
  const v = Q.qualityView(q);
  assert.strictEqual(v.total, 18);
  assert.deepStrictEqual(v.axes.map((a) => a.label), RUBRIC.map((x) => x[1]));
  const broken = [
    { ...q, total: 25 }, { ...q, axes: q.axes.slice(0, 4) }, { ...q, axes: q.axes.map((a, i) => (i === 0 ? { ...a, score: 6 } : a)) },
    { ...q, max: 20 }, 'x', [q], null, undefined, { ...q, axes: q.axes.map((a, i) => (i === 1 ? { ...a, key: 'zz' } : a)) },
    { ...q, axes: q.axes.map((a, i) => (i === 2 ? { ...a, reason: 3 } : a)) }, { ...q, axes: q.axes.map((a, i) => (i === 0 ? { ...a, cites: 'x' } : a)) },
  ];
  for (const b of broken) assert.strictEqual(Q.qualityView(b), null, String(JSON.stringify(b)).slice(0, 80));
});

test('QM2: ratioScore の表・todoAxis（0 件は 1）・fillAxis（出典かメモよりの行のある見出しで数え、未確認・出典の無い行だけ・特になしだけは埋まっていない）', () => {
  const t = [[0, 0, 1], [0, 3, 1], [1, 3, 2], [2, 3, 3], [3, 3, 5], [1, 4, 2], [3, 4, 4], [4, 4, 5], [4, 5, 4], [1, 5, 2]];
  for (const [g, n, s] of t) assert.strictEqual(Q.ratioScore(g, n), s, `${g}/${n}`);
  assert.deepStrictEqual(Q.todoAxis([]), { score: 1, reason: 'ToDo がありません' });
  const todos = [{ type: 'todo', assignee: '山田', dueRaw: '金曜' }, { type: 'todo', assignee: '', dueRaw: '金曜' }, { type: 'todo', assignee: '鈴木', due: '2026-10-30' }, { type: 'bullet' }];
  assert.deepStrictEqual(Q.todoAxis(todos), { score: 3, reason: 'ToDo 3 件のうち、担当と期限の両方があるもの 2 件' });
  const bs = [
    { type: 'heading', text: '課題・要望（N）' }, { type: 'bullet', text: 'a', cites: ['s1'] },
    { type: 'heading', text: '時期（T）' }, { type: 'bullet', text: 'b（メモより）', cites: [], mark: 'memo' },
    { type: 'heading', text: '予算（B）' }, { type: 'bullet', text: 'c', cites: [] },
    { type: 'heading', text: '競合・比較先（C）' }, { type: 'bullet', text: '特になし', cites: [] },
    { type: 'heading', text: '決定事項' }, { type: 'bullet', text: 'd', cites: ['s2'] },
  ];
  const f = Q.fillAxis(bs, { headings: M.sectionsOf('sales'), key: M.headingKey });
  assert.deepStrictEqual(f, { score: 2, reason: '型の見出し 5 つのうち、根拠のある見出し 2 つ' });
  const stale = Q.fillAxis([{ type: 'heading', text: '目的' }, { type: 'bullet', text: 'x', cites: ['s1'], citeState: 'stale' }], { headings: M.sectionsOf(''), key: M.headingKey });
  assert.strictEqual(stale.score, 1, '人が直して出典が合わない行は根拠にしない');
  const rep = Q.fillAxis([{ type: 'heading', text: '前回の宿題の状況' }, { type: 'bullet', text: 'x', cites: ['s1'] },
    { type: 'heading', text: 'A案件' }, { type: 'heading', text: '事実（進捗・課題）' }, { type: 'bullet', text: 'y', cites: ['s2'] },
    { type: 'heading', text: '見立て（原因・リスク）' }, { type: 'bullet', text: 'z', cites: ['s2'] }, { type: 'heading', text: '打ち手の案' }, { type: 'bullet', text: 'w', cites: [] },
    { type: 'heading', text: 'B案件' }, { type: 'heading', text: '事実（進捗・課題）' }, { type: 'bullet', text: 'v', cites: ['s3'] }], { headings: M.sectionsOf('standup'), key: M.headingKey });
  assert.deepStrictEqual(rep, { score: 4, reason: '型の見出し 5 つのうち、根拠のある見出し 4 つ' }, '報告ごとの見出しは数を足す');
});

test('QM5・P11: shouldScore の表（既定の all はどの種類にも付ける・on は 1on1 と採用面接・事前面談を除く・off は付けない・知らない値は all と同じ）', () => {
  for (const k of [...mtype.SELECTABLE, '', 'general']) {
    assert.strictEqual(Q.shouldScore(k, 'all'), true, k);
    assert.strictEqual(Q.shouldScore(k, 'off'), false, k);
    assert.strictEqual(Q.shouldScore(k, 'on'), !['oneonone', 'interview'].includes(k), k);
    assert.strictEqual(Q.shouldScore(k, 'nope'), true, k);
    assert.strictEqual(Q.shouldScore(k, undefined), true, k);
  }
  assert.deepStrictEqual([...Q.PERSONAL_TYPES], [...mtype.PERSONAL_TYPES]);
  assert.strictEqual(Q.MIN_SCORE_CHARS, 400);
});

test('qualityLines: 写しと MCP の行（見出しと5つの軸。画面のカードと同じ並び）', () => {
  const r = Q.parseScore(GOOD, Q.AI_AXES, { found: 1 });
  const v = Q.qualityView(Q.buildQuality({ ai: r.ai, todo: { score: 2, reason: 'ToDo 2 件' }, fill: { score: 4, reason: '型の見出し' }, at: 'x' }));
  assert.deepStrictEqual(Q.qualityLines(v), ['## 打ち合わせの質（18 / 25）', '- 目的と結論: 4 / 5 — 冒頭で決めることを言った', '- 抜け・重なり（MECE）: 3 / 5 — 予算の話を2回やり直した',
    '- 決定事項: 5 / 5 — 据え置きと確かめた', '- ToDo の具体さ: 2 / 5 — ToDo 2 件', '- 型の埋まり具合: 4 / 5 — 型の見出し']);
  assert.deepStrictEqual(Q.qualityLines(null), []);
});

test('点検の直し 2: fillAxis は型の見出しの下の小見出し（型・締め・助言でない見出し）の行も親の根拠に数える。締めと助言の見出しで切る。END_HEADS は memoTypes の締めと助言の見出しと同じ', () => {
  const H = (text) => ({ type: 'heading', text });
  const B = (cites = ['s1']) => ({ type: 'bullet', text: 'x', cites });
  const pts = Q.fillAxis([H('目的'), B(), H('論点ごとの要点'), H('価格改定'), B(), H('決定事項'), B()], { headings: M.sectionsOf(''), key: M.headingKey });
  assert.strictEqual(pts.score, 5, '小見出しの下の根拠を親に数えていない');
  const cut = Q.fillAxis([H('目的'), B(), H('論点ごとの要点'), H('**決定事項**'), B()], { headings: M.sectionsOf(''), key: M.headingKey });
  assert.strictEqual(cut.score, 3, '締めの見出しの下の行を型の見出しの根拠に数えた');
  const star = Q.fillAxis([H('経歴・スキル'), B(), H('行動の具体例'), H('プロジェクトX'), B(), H('本人からの質問・懸念'), B([]), H('条件'), B(), H('次に気をつけること'), B()],
    { headings: M.sectionsOf('interview'), key: M.headingKey });
  assert.deepStrictEqual(star, { score: 4, reason: '型の見出し 4 つのうち、根拠のある見出し 3 つ' });
  const rep = Q.fillAxis([H('前回の宿題の状況'), H('案件A'), B(), H('事実（進捗・課題）'), B(), H('見立て（原因・リスク）'), B(), H('打ち手の案'), B(), H('抜け・重なりチェック'), B()],
    { headings: M.sectionsOf('standup'), key: M.headingKey });
  assert.strictEqual(rep.score, 5, '報告の型の小見出しの下の根拠を数えていない');
  assert.deepStrictEqual([...Q.END_HEADS], [...M.CLOSING_HEADINGS, M.ADVICE_HEAD]);
});
