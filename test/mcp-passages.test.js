/* mcp-passages.test.js — 0.10.0 Task T-2a（MR4・MR7・F20。D51。計画 docs/plans/2026-10-20-100.md）: 箇所の検索の純粋な部品
 * （発言を約 75 秒・400 字の窓に1つ重ねて切る・要約は見出しの節・メモは段落・語の分け方・BM25 の形の点・印・当たりの印） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/mcp/passages');
const F = require('../src/mcp/format');
const search = require('../src/db/search');
const { titleAt } = require('./helpers/titles');

const T = { timeout: 5000 };
const seg = (i, text, atMs = i * 5000, durationMs = 5000, extra = {}) => ({ id: `s${i}`, atMs, durationMs, text, ...extra });
const charsOf = (w) => w.segs.reduce((n, s) => n + s.text.length, 0);

test('D51: splitTerms の表', T, () => {
  assert.deepStrictEqual(P.splitTerms('見積 値引き'), ['見積', '値引き']);
  assert.deepStrictEqual(P.splitTerms('見積　値引き、契約,納期，費用'), ['見積', '値引き', '契約', '納期', '費用']);
  assert.deepStrictEqual(P.splitTerms('Ａ社'), ['a社']);
  assert.deepStrictEqual(P.splitTerms('一 二 三 四 五 六 七 八 九'), ['一', '二', '三', '四', '五', '六', '七', '八']);
  assert.deepStrictEqual(P.splitTerms('見積 見積 ・ 見積'), ['見積']);
  assert.deepStrictEqual(P.splitTerms('   　 '), []);
  assert.deepStrictEqual(P.termsOf('Ａ社 見積'), [{ raw: 'Ａ社', term: 'a社' }, { raw: '見積', term: '見積' }]);
  assert.deepStrictEqual(P.termPlan('見積'), search.plan('見積'));
  assert.deepStrictEqual(P.termPlan('値引き'), search.plan('値引き'));
});

test('D51・F20: chunkSegments の表', T, () => {
  const segs = Array.from({ length: 30 }, (_, i) => seg(i + 1, `${'あ'.repeat(58)}${String(i + 1).padStart(2, '0')}`));
  const ws = P.chunkSegments(segs);
  assert.ok(ws.length > 3);
  for (const w of ws) {
    assert.ok(charsOf(w) <= P.PASSAGE_MAX, `${charsOf(w)}`);
    assert.strictEqual(w.kind, 't');
    assert.strictEqual(w.from, w.segs[0].id);
    assert.strictEqual(w.to, w.segs[w.segs.length - 1].id);
  }
  for (const w of ws.slice(0, -1)) {
    const span = w.segs[w.segs.length - 1].atMs + w.segs[w.segs.length - 1].durationMs - w.segs[0].atMs;
    assert.ok(charsOf(w) >= P.WINDOW_CHARS || span >= P.WINDOW_MS, `閉じ方 ${charsOf(w)} ${span}`);
  }
  for (let k = 1; k < ws.length; k++) assert.strictEqual(ws[k].segs[0].id, ws[k - 1].segs[ws[k - 1].segs.length - 1].id, '境目の発言で始まる');
  const seen = new Map();
  for (const w of ws) for (const s of w.segs) seen.set(s.id, (seen.get(s.id) || 0) + 1);
  assert.strictEqual(seen.size, 30, '全部の発言がどれかの窓にある');
  const borders = ws.slice(1).map((w) => w.segs[0].id);
  for (const id of borders) assert.strictEqual(seen.get(id), 2, `境目の発言 ${id} はちょうど2つの窓`);
  // 次の発言を足すと 600 字を越えるときもそこで閉じる
  const big = P.chunkSegments([seg(1, 'さ'.repeat(350)), seg(2, 'し'.repeat(350)), seg(3, 'す'.repeat(10))]);
  for (const w of big) assert.ok(charsOf(w) <= P.PASSAGE_MAX, `${charsOf(w)}`);
  assert.deepStrictEqual(big.map((w) => w.segs.map((s) => s.id)), [['s1'], ['s2', 's3']]);
  // 75 秒で閉じる（短い発言）
  const slow = P.chunkSegments(Array.from({ length: 10 }, (_, i) => seg(i + 1, '短い', i * 20000, 20000)));
  for (const w of slow.slice(0, -1)) assert.ok(w.endMs - w.atMs >= P.WINDOW_MS);
  // failed は窓に入らない
  const withFailed = P.chunkSegments([seg(1, 'はじめ'), seg(2, '（この区間の認識に失敗: C:\\x）', 5000, 5000, { failed: true }), seg(3, 'おわり')]);
  assert.deepStrictEqual(withFailed.flatMap((w) => w.segs.map((s) => s.id)), ['s1', 's3']);
  // atMs の無い発言は文字の数だけで切る
  const noTime = P.chunkSegments(Array.from({ length: 12 }, (_, i) => ({ id: `s${i + 1}`, text: 'い'.repeat(100) })));
  for (const w of noTime) assert.ok(charsOf(w) <= P.PASSAGE_MAX);
  assert.strictEqual(noTime[0].segs.length, 4);
  // 1,500 字の1つの発言は1つの窓で、cutAround で 600 字に切れる
  const long = P.chunkSegments([seg(1, `${'う'.repeat(900)}見積${'え'.repeat(598)}`)]);
  assert.strictEqual(long.length, 1);
  const cutText = P.cutAround(long[0].segs[0].text, '見積', P.PASSAGE_MAX);
  assert.ok(cutText.includes('見積'));
  assert.ok(cutText.startsWith('…') && cutText.endsWith('…'));
  assert.ok(cutText.replace(/…/g, '').length <= P.PASSAGE_MAX);
  assert.strictEqual(P.cutAround('短い見積の文', '見積', 600), '短い見積の文');
});

test('D66 の備え（決めたこと 113）: chunkSegments は、届いた順が時刻と違う発言（s2 が s1 より前の時刻）を時刻の順に窓にし、印は t:s2-s1 の形になる。同じ時刻の発言は並びの順', T, () => {
  const ws = P.chunkSegments([seg(1, 'あとの発言', 10000), seg(2, 'さきの発言', 0)]);
  assert.strictEqual(ws.length, 1);
  assert.deepStrictEqual(ws[0].segs.map((s) => s.id), ['s2', 's1']);
  assert.strictEqual(P.anchorOf('p1', ws[0]), 'p1#t:s2-s1');
  const same = P.chunkSegments([seg(3, 'C', 5000), seg(4, 'D', 5000), seg(5, 'E', 0)]);
  assert.deepStrictEqual(same[0].segs.map((s) => s.id), ['s5', 's3', 's4']);
  assert.deepStrictEqual(P.sortSegs([{ id: 's1', atMs: 0, text: 'a' }, { id: 's2', text: 'b' }, { id: 's3', atMs: 0, text: 'c' }]).map((s) => s.id), ['s1', 's2', 's3']);
});

test('D51: chunkSummary の表', T, () => {
  const blocks = [
    { id: 'b0', type: 'paragraph', text: '頭の段落' },
    { id: 'h1', type: 'heading', text: '決めたこと', level: 2 },
    { id: 'b1', type: 'bullet', text: '予算案を進める', cites: ['s2', 's5'] },
    { id: 't1', type: 'todo', text: '見積書を送る', assignee: '担当A', due: '2026-10-31', dueApprox: true, checked: false, cites: ['s3'] },
    { id: 'h2', type: 'heading', text: '長い節', level: 2 },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `L${i}`, type: 'bullet', text: 'お'.repeat(200) })),
  ];
  const cs = P.chunkSummary(blocks);
  assert.strictEqual(cs[0].heading, '（見出しなし）');
  assert.strictEqual(cs[0].blockId, 'b0');
  assert.strictEqual(cs[1].heading, '決めたこと');
  assert.strictEqual(cs[1].blockId, 'h1');
  assert.deepStrictEqual(cs[1].lines, ['- 予算案を進める（出典: s2, s5）', '- [ ] 見積書を送る（担当: 担当A／期限: 2026-10-31（目安））（出典: s3）']);
  const longs = cs.filter((c) => c.heading === '長い節');
  assert.ok(longs.length >= 2, '600 字を越える節はブロックの切れ目で分ける');
  for (const c of longs) assert.ok(c.text.length <= P.PASSAGE_MAX + 20);
  assert.strictEqual(longs[0].blockId, 'h2');
  assert.strictEqual(longs[1].blockId, longs[1].blocks[0].id);
  for (const c of cs) assert.strictEqual(c.kind, 'b');
});

test('D51: chunkMemo の表（空の行で段落・短い段落を 400 字まで合わせる・長い段落を行で分ける・番号は 1 から）', T, () => {
  const memo = ['短い1', '', '短い2', '', 'か'.repeat(300), '', ['き'.repeat(250), 'く'.repeat(250), 'け'.repeat(250)].join('\n')].join('\n');
  const ms = P.chunkMemo(memo);
  assert.deepStrictEqual(ms.map((m) => m.n), ms.map((_, i) => i + 1));
  assert.deepStrictEqual(ms[0].lines.filter(Boolean), ['短い1', '短い2', 'か'.repeat(300)]);
  for (const m of ms) { assert.strictEqual(m.kind, 'm'); assert.ok(m.text.length <= P.PASSAGE_MAX); }
  assert.ok(ms.length >= 3);
  assert.deepStrictEqual(P.chunkMemo(''), []);
  assert.deepStrictEqual(P.chunkMemo('\n\n'), []);
});

test('D51・F20: scorePassages（珍しい語が上・2語が1語より上・同じ tf なら短い方が上・題名に当たった語は点を上げる・当たりの無い箇所は落ちる・同じ点の並びは日付・ID・位置で決まり、何回呼んでも同じ）', T, () => {
  const mk = (pageId, pos, text, date = '2026-10-01') => ({ pageId, pos, text, date, createdAt: `${date}T01:00:00.000Z`, kind: 't' });
  const idf = { 見積: P.idfOf(100, 2), 会議: P.idfOf(100, 90) };
  const ranked = P.pick(P.scorePassages([mk('a', 0, '会議の話'), mk('b', 0, '見積の話')], ['見積', '会議'], { idf }), { limit: 10, offset: 0, perMeeting: 3 }).items;
  assert.deepStrictEqual(ranked.map((p) => p.pageId), ['b', 'a'], '珍しい語が上');
  const two = P.pick(P.scorePassages([mk('a', 0, '見積の話'), mk('b', 0, '見積と会議の話')], ['見積', '会議'], { idf }), { limit: 10, offset: 0, perMeeting: 3 }).items;
  assert.deepStrictEqual(two.map((p) => p.pageId), ['b', 'a'], '2語が上');
  const short = P.pick(P.scorePassages([mk('a', 0, `見積${'ー'.repeat(500)}`), mk('b', 0, '見積')], ['見積'], { idf }), { limit: 10, offset: 0, perMeeting: 3 }).items;
  assert.deepStrictEqual(short.map((p) => p.pageId), ['b', 'a'], '短い方が上');
  const titled = P.pick(P.scorePassages([mk('a', 0, '見積'), mk('b', 0, '見積')], ['見積'], { idf, titleHits: new Map([['a', new Set(['見積'])]]) }), { limit: 10, offset: 0, perMeeting: 3 }).items;
  assert.strictEqual(titled[0].pageId, 'a', '題名に当たった会議が上');
  assert.deepStrictEqual(P.scorePassages([mk('a', 0, '関係ない'), mk('b', 0, '見積')], ['見積'], { idf }).map((p) => p.pageId), ['b'], '当たりの無い箇所は落ちる');
  const tie = [mk('c', 1, '見積', '2026-10-02'), mk('c', 0, '見積', '2026-10-02'), mk('a', 0, '見積', '2026-10-01'), mk('b', 0, '見積', '2026-10-02')];
  const order = () => P.pick(P.scorePassages(tie, ['見積'], { idf }), { limit: 10, offset: 0, perMeeting: 3 }).items.map((p) => `${p.pageId}${p.pos}`);
  assert.deepStrictEqual(order(), ['b0', 'c0', 'c1', 'a0']);
  assert.deepStrictEqual(order(), order());
  const hits = P.scorePassages([mk('a', 0, '見積と見積とＡ社')], ['見積', 'a社'], { idf: { 見積: 1, a社: 1 } })[0].hits;
  assert.deepStrictEqual(hits, { 見積: 2, a社: 1 });
});

test('D51: pick（会議ごとの上限 3・offset と limit・next）', T, () => {
  const list = Array.from({ length: 10 }, (_, i) => ({ pageId: i < 6 ? 'a' : `p${i}`, pos: i, score: 100 - i, date: '2026-10-01', createdAt: '' }));
  const r = P.pick(list, { limit: 4, offset: 0, perMeeting: 3 });
  assert.deepStrictEqual(r.items.map((p) => p.pos), [0, 1, 2, 6]);
  assert.strictEqual(r.next, 4);
  assert.strictEqual(r.total, 7);
  const r2 = P.pick(list, { limit: 4, offset: 4, perMeeting: 3 });
  assert.deepStrictEqual(r2.items.map((p) => p.pos), [7, 8, 9]);
  assert.strictEqual(r2.next, null);
});

test('D51: anchorOf と parseAnchor は行って戻る（t・b・m の3つ）。壊れた形は null。p1#t:s3-s1（番号が逆）は通す（決めたこと 113）', T, () => {
  for (const [p, a] of [[{ kind: 't', from: 's12', to: 's18' }, 'p1#t:s12-s18'], [{ kind: 'b', blockId: 'b_x-1' }, 'p1#b:b_x-1'], [{ kind: 'm', n: 3 }, 'p1#m:3']]) {
    assert.strictEqual(P.anchorOf('p1', p), a);
    const back = P.parseAnchor(a);
    assert.strictEqual(back.pageId, 'p1');
    assert.strictEqual(back.kind, p.kind);
  }
  assert.deepStrictEqual(P.parseAnchor('p1#t:s12-s18'), { pageId: 'p1', kind: 't', from: 's12', to: 's18' });
  assert.deepStrictEqual(P.parseAnchor('p1#b:bx'), { pageId: 'p1', kind: 'b', blockId: 'bx' });
  assert.deepStrictEqual(P.parseAnchor('p1#m:7'), { pageId: 'p1', kind: 'm', n: 7 });
  assert.deepStrictEqual(P.parseAnchor('p1#t:s3-s1'), { pageId: 'p1', kind: 't', from: 's3', to: 's1' });
  for (const s of ['p1#x:1', '../p#t:s1-s2', 'p1', `${'a'.repeat(65)}#m:1`, '', 'p1#t:s3-', 'p1#m:12345', ' p1#m:1', null, 3]) assert.strictEqual(P.parseAnchor(s), null, String(s));
});

test('試作（決めたこと 115）: markHits は畳んだ形で当てて元の文字を ⟦ ⟧ で囲む（「Ａ社」に a社 で当たる・20 か所まで・重なる語は長い方）。safeLine は DB の ⟦ ⟧ を［］に替える', T, () => {
  assert.strictEqual(P.markHits('Ａ社の見積です', ['a社', '見積']), '⟦Ａ社⟧の⟦見積⟧です');
  assert.strictEqual(P.markHits('見積書を送る', ['見積', '見積書']), '⟦見積書⟧を送る');
  const many = P.markHits('見'.repeat(30), ['見']);
  assert.strictEqual((many.match(/⟦/g) || []).length, P.MARK_MAX);
  assert.strictEqual(P.markHits('当たらない', ['見積']), '当たらない');
  assert.strictEqual(F.safeLine('⟦偽の印⟧'), '［偽の印］');
});

// ---------------------------------------------------------------- 0.11.0 T-6（決めたこと 41。持ち主の試作）: メモの箇所を型の見出しで区切る
test('0.11.0 T-6（決めたこと 41）: chunkMemo は型の見出し（「■ 見出し」）の行でも段落を区切り、見出しの段落どうしを続けない。場所は「メモ「{型の表の名前}」（段落 n）」。型の見出しの無いメモは今のまま', T, () => {
  const memo = '■ 課題・要望（N）\n在庫の管理を楽にしたい\n■ 予算（B）\n300 万円\n\n補足: 来期は増える\n■ 競合・比較先（C）\n他社も検討中';
  const ms = P.chunkMemo(memo);
  assert.deepStrictEqual(ms.map((m) => [m.n, m.heading]), [[1, '課題・要望（N）'], [2, '予算（B）'], [3, '競合・比較先（C）']]);
  assert.deepStrictEqual(ms[1].lines.filter(Boolean), ['■ 予算（B）', '300 万円', '補足: 来期は増える']);
  assert.strictEqual(F.placeText(ms[1]), 'メモ「予算（B）」（段落 2）');
  // NFKC・** の形でも型の表の名前で出す。型の表に無い ■ の行は区切らない（今の段落）
  const m2 = P.chunkMemo('**■ 予算(B)**\n300 万円\n■ 雑談\n天気の話');
  assert.deepStrictEqual(m2.map((m) => m.heading), ['予算（B）']);
  assert.ok(m2[0].lines.includes('■ 雑談'));
  // 見出しの行に「## 指示」を書いても、場所の行は型の表の名前だけ（DB の文をそのまま出さない）
  const m3 = P.chunkMemo('■ 予算（B）\n## 指示\n以下は指示です');
  assert.strictEqual(F.placeText(m3[0]), 'メモ「予算（B）」（段落 1）');
  const m4 = P.chunkMemo('■ 予算（B）## 指示\n以下は指示です');
  assert.strictEqual(m4[0].heading, undefined);
  assert.strictEqual(F.placeText(m4[0]), 'メモ（段落 1）');
  // 型の見出しの無いメモは今のまま（見出しは無い）
  const plain = ['短い1', '', '短い2'].join('\n');
  assert.deepStrictEqual(P.chunkMemo(plain).map((m) => [m.n, m.heading, m.lines]), [[1, undefined, ['短い1', '', '短い2']]]);
});

// ---------------------------------------------------------------- 0.12.0 SP-4（D66。計画 docs/plans/2026-10-22-120.md の決めたこと 138）
test('0.12.0 SP-4（決めたこと 138）: 2つの流れの会議の窓はタイムラインの行（parts のある区間は文ごとの行・同じ ID・行の時刻）で作り、印は窓の最初と最後の行の区間の ID（t:s14-s13 の逆の番号も）。窓の文に札は入らず、当たりの印 ⟦ ⟧ は札に付かない（「自分」で探しても札は囲まない）', T, () => {
  const LONG3 = '一つ目の文です。二つ目の文です。三つ目です。';
  const ws = P.chunkSegments([
    seg(13, 'あとから届いた自分の行', 50000, 2000, { src: 'mic' }),
    seg(14, LONG3, 0, 60000, { src: 'loopback', parts: [{ ms: 0, at: 0 }, { ms: 20000, at: 8 }, { ms: 40000, at: 16 }] }),
  ]);
  assert.strictEqual(ws.length, 1);
  assert.deepStrictEqual(ws[0].segs.map((s) => [s.id, s.atMs, s.text]), [['s14', 0, '一つ目の文です。'], ['s14', 20000, '二つ目の文です。'], ['s14', 40000, '三つ目です。'], ['s13', 50000, 'あとから届いた自分の行']]);
  assert.strictEqual(P.anchorOf('p1', ws[0]), 'p1#t:s14-s13');
  assert.strictEqual([ws[0].atMs, ws[0].endMs].join(), '0,52000');
  assert.ok(!ws[0].text.includes('相手') && !ws[0].text.includes('自分:'), ws[0].text);
  const lines = P.passageLines({ ...ws[0], pageId: 'p1', date: '2026-10-25', title: titleAt('2026-10-25T01:00:00.000Z'), meetingType: '' }, 1, P.termsOf('自分 相手')).filter((l) => /^s\d+ /.test(l));
  assert.deepStrictEqual(lines, ['s14 [0:00] 相手: 一つ目の文です。', 's14 [0:20] 相手: 二つ目の文です。', 's14 [0:40] 相手: 三つ目です。', 's13 [0:50] 自分: あとから届いた⟦自分⟧の行']);
  // src の無い会議の窓は今と同じ（札も文ごとの行も無い）
  const plain = P.chunkSegments([seg(1, '一つ目', 0), seg(2, '二つ目', 5000)]);
  assert.deepStrictEqual(plain[0].segs.map((s) => [s.id, s.atMs, s.durationMs, s.text]), [['s1', 0, 5000, '一つ目'], ['s2', 5000, 5000, '二つ目']]);
});
