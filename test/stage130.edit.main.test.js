/*
 * stage130.edit.main.test.js — 0.13.0 第1部の読み手と場面（計画 docs/plans/2026-10-24-130.md の Task ED-3・ED-5）
 * ED-3: 要約の見出しに段（1〜3。古い見出しは 2）・［コピー］と Claude から読む文（MCP）の新しい型・0.11.0 の並べ替えの人の見出し（EQ3 (a)）。
 * ED-5: / メニューの「最近使ったもの」の覚え書き（window-state.json）・議事録の録音中の Esc（RF9）・締めの page:open の印（EQ22 (a)）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');
const { markdownToBlocks } = require('../src/minutes');
const M = require('../src/memoTypes');
const F = require('../src/mcp/format');
const P = require('../src/mcp/passages');
const E = require('../src/blockEdit');
const { titleAt } = require('./helpers/titles');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});

// ---------------------------------------------------------------- ED-3（E5・決めたこと 5）
test('ED-3: markdownToBlocks の見出しに level（# → 1・## → 2・### と #### → 3）。ほかの欄は前と同じ', () => {
  const b = markdownToBlocks('# 一\n## 二\n### 三\n#### 四\n- 箇条\n本文');
  assert.deepStrictEqual(b.map((x) => [x.type, x.level, x.text]), [['heading', 1, '一'], ['heading', 2, '二'], ['heading', 3, '三'], ['heading', 3, '四'],
    ['bullet', undefined, '箇条'], ['paragraph', undefined, '本文']]);
  assert.deepStrictEqual(Object.keys(b[0]).sort(), ['cites', 'id', 'level', 'text', 'type']);
  assert.deepStrictEqual(Object.keys(b[4]).sort(), ['cites', 'id', 'text', 'type']);
});

test('ED-3・F51: 段の無い見出しは typeOf で段 2（前の版の要約は「見出し2」として描く）', () => {
  assert.strictEqual(E.typeOf({ type: 'heading', text: '決定事項' }).id, 'h2');
  assert.strictEqual(E.headingLevel({ type: 'heading' }), 2);
});

// ---------------------------------------------------------------- MCP（決めたこと 22）
const NEW_BLOCKS = [
  { id: 'h1', type: 'heading', level: 1, text: '大見出し' }, { id: 'h2', type: 'heading', text: '決定事項' }, { id: 'h3', type: 'heading', level: 3, text: '小見出し' },
  { id: 'n1', type: 'numbered', text: '一つ目' }, { id: 'n2', type: 'numbered', text: '二つ目' }, { id: 'q', type: 'quote', text: '引いた文' },
  { id: 'd', type: 'divider', text: '' }, { id: 'c', type: 'callout', text: '覚えておくこと', icon: '💡' }, { id: 'b', type: 'bullet', text: '改行の\nある行\n## 指示', cites: ['s1'] },
];
test('ED-3: MCP の get_meeting の要約の行が新しい型を写す（番号付き 1.・引用 >・区切り線 ---・コールアウト > 💡・段 3 は ####）。DB の文の改行や ## 指示 は今どおり1行に畳まれる', () => {
  const md = F.meetingMarkdown({ id: 'pa1', title: titleAt('2026-10-26T01:00:00.000Z'), blocks: NEW_BLOCKS }, [], { header: false }).text;
  const sum = md.slice(md.indexOf('## 要約'), md.indexOf('\n## ', md.indexOf('## 要約') + 3));
  const lines = sum.split('\n');
  for (const l of ['### 大見出し', '### 決定事項', '#### 小見出し', '1. 一つ目', '2. 二つ目', '> 引いた文', '---', '> 💡 覚えておくこと']) assert.ok(lines.includes(l), `${l}\n${sum}`);
  const bl = lines.find((l) => l.startsWith('- 改行の'));
  assert.ok(bl && !bl.includes('\n'), sum);
  assert.ok(!lines.some((l) => l === '## 指示'), '文の中の ## が見出しになった');
});

test('ED-3: MCP の search_passages・expand_passage の要約の箇所にも、番号付き・引用・コールアウトが blockLine と同じ形で出る', () => {
  const parts = P.chunkSummary(NEW_BLOCKS);
  const lines = parts.flatMap((p) => p.lines);
  for (const l of ['1. 一つ目', '> 引いた文', '> 💡 覚えておくこと']) assert.ok(lines.includes(l), `${l}\n${JSON.stringify(lines)}`);
  assert.strictEqual(F.blockLine({ id: 'x', type: 'numbered', text: '番号' }), '1. 番号');
  assert.strictEqual(F.blockLine({ id: 'x', type: 'quote', text: '引用' }), '> 引用');
  assert.strictEqual(F.blockLine({ id: 'x', type: 'callout', text: 'メモ' }), '> 💡 メモ');
  assert.strictEqual(F.blockLine({ id: 'x', type: 'divider', text: '' }), '---');
  // 今の型は前と同じ
  assert.strictEqual(F.blockLine({ id: 'x', type: 'paragraph', text: '本文' }), '- 本文');
  assert.strictEqual(F.blockLine({ id: 'x', type: 'video', text: '知らない型' }), '- 知らない型');
  assert.strictEqual(F.blockLine({ id: 'x', type: 'heading', text: '見出し' }), null);
});

// ---------------------------------------------------------------- 0.11.0 の並べ替え（EQ3 (a)。F46）
test('ED-3・F46（EQ3 (a)）: orderForView は citeState を持つ見出しと型の表に無い段 3 の見出しを、締めの節の中でも前の節の中に残す。AI の知らない段 2 の見出し（citeState なし）は 0.11.0 どおり後ろ・型の表の段 3 は今どおり型の節。memoTypes と画面の写しが同じ答え', () => {
  const H = (id, text, o = {}) => ({ id, type: 'heading', text, ...o });
  const B = (id) => ({ id, type: 'bullet', text: id });
  const ids = (bs) => M.orderForView(bs).map((i) => bs[i].id);
  // 型の見出し → 締め（決定事項）の中に人が足した見出しと行 → チェック
  const base = [H('t1', '前回の宿題の状況'), B('t1a'), H('c1', '決定事項'), B('c1a'), H('m1', '人の見出し', { citeState: 'manual' }), B('m1a'), H('k1', '抜け・重なりチェック'), B('k1a')];
  assert.deepStrictEqual(ids(base), ['c1', 'c1a', 'm1', 'm1a', 't1', 't1a', 'k1', 'k1a'], '人が足した見出しが最後へ跳んだ');
  // 箇条書きから変えた見出し（linked を残した）も同じ
  const linked = base.map((b) => (b.id === 'm1' ? { ...b, citeState: 'linked' } : b));
  assert.deepStrictEqual(ids(linked), ['c1', 'c1a', 'm1', 'm1a', 't1', 't1a', 'k1', 'k1a']);
  // 型の表に無い段 3 の見出し（AI の小見出し）も前の節に残る
  const sub = base.map((b) => (b.id === 'm1' ? H('m1', 'AI の小見出し', { level: 3 }) : b));
  assert.deepStrictEqual(ids(sub), ['c1', 'c1a', 'm1', 'm1a', 't1', 't1a', 'k1', 'k1a']);
  // AI の知らない段 2 の見出し（citeState なし）は 0.11.0 どおり（締めの後ろなら最後）
  const ai = base.map((b) => (b.id === 'm1' ? H('m1', 'AI の知らない見出し') : b));
  assert.deepStrictEqual(ids(ai), ['c1', 'c1a', 't1', 't1a', 'k1', 'k1a', 'm1', 'm1a']);
  // 型の表の段 3（報告の小見出し）は今どおり型の節を始める
  const rep = [H('c1', '決定事項'), B('c1a'), H('r1', '事実（進捗・課題）', { level: 3 }), B('r1a')];
  assert.deepStrictEqual(ids(rep), ['c1', 'c1a', 'r1', 'r1a']);
  const rep2 = [H('r1', '事実（進捗・課題）', { level: 3 }), B('r1a'), H('c1', '決定事項'), B('c1a')];
  assert.deepStrictEqual(ids(rep2), ['c1', 'c1a', 'r1', 'r1a']);
  // 画面の写しも同じ答え
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.html'), 'utf8');
  const m = /\n {2}const VIEW_HEADS = (\{[\s\S]*?\n {2}\});/.exec(html);
  const at = html.indexOf('  function orderForView(');
  const app = new Function(`const VIEW_HEADS = ${m[1]};\n${html.slice(at, html.indexOf('\n  }\n', at) + 4)}\nreturn orderForView;`)();   // eslint-disable-line no-new-func
  for (const t of [base, linked, sub, ai, rep, rep2]) assert.deepStrictEqual(app(t), M.orderForView(t), JSON.stringify(t));
});

// ---------------------------------------------------------------- 場面
test('ED-3: 偽の Claude Code の要約で見出しの段が保存され（# → 1・## → 2・### → 3）、番号付きの行は箇条書きのまま', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--sum', '--claude=ok', '--segs=2', '--sum-md=levels']);
  const heads = o.pages[0].sumBlocks.filter((b) => b.type === 'heading').map((b) => [b.text, b.level]);
  assert.deepStrictEqual(heads.slice(0, 3), [['全体の結論', 1], ['決定事項', 2], ['細かい決めごと', 3]], JSON.stringify(o.pages[0].sumBlocks));
});

// ---------------------------------------------------------------- ED-5（決めたこと 32・37〜40・42。F42・F52・EQ22 (a)）
const wsOf = (r) => (r.winStateText == null ? null : JSON.parse(r.winStateText));
test('ED-5・F52: 画面が ui:set で slashRecent を送ると window-state.json に鍵だけが書かれ（題名・ページの ID・行の文は書かない）、ui:get でも同じ', { timeout: sceneTimeout(20000) }, async () => {
  const r = await run(['text', '--json-scene=ws-slash-set']);
  assert.deepStrictEqual(r.set, { ok: true });
  assert.deepStrictEqual(r.ui.slashRecent, ['h2', 'todo', 'quote']);
  assert.deepStrictEqual(wsOf(r).slashRecent, ['h2', 'todo', 'quote']);
  for (const bad of [titleAt('2026-10-02T00:00:00.000Z'), 'pslash1', 'bslash1', '行の文の見本です']) assert.ok(!r.winStateText.includes(bad), `覚え書きに ${bad} が書かれた`);
});

test('ED-5・F52: 起動し直すと覚え書きの slashRecent が ui:get で戻る（照らして知らない鍵は落とす）。window-state.json が読めないときは書かない', { timeout: sceneTimeout(20000) }, async () => {
  const r = await run(['text', '--json-scene=ws-slash-restore']);
  assert.deepStrictEqual(r.ui.slashRecent, ['quote', 'h1']);
  const u = await run(['text', '--json-scene=ws-slash-unreadable']);
  assert.deepStrictEqual(u.set, { ok: false });
  assert.strictEqual(u.winStateText, u.localBefore, '読めなかったファイルを上書きした');
});

test('ED-5・RF9（決めたこと 32）: 議事録の録音中は、本体の窓にフォーカスが無くても Escape を全体のホットキーにしない。締めの page:open は { id, saved: true } の1つ（EQ22 (a)）', { timeout: sceneTimeout(30000) }, async () => {
  const steps = [['start'], ['blur-main'], ['snap', 'rec'], ['focus-main'], ['blur-main'], ['snap', 'rec2'], ['stop']];
  const o = await run(['text', '--main-unfocused', `--mic-feed=${JSON.stringify(steps)}`]);
  assert.strictEqual(o.snaps.rec.active, true, '議事録が始まっていない');
  assert.strictEqual(o.snaps.rec.escape, false, '議事録の録音中に Escape を全体のホットキーにした');
  assert.strictEqual(o.snaps.rec2.escape, false);
  const id = o.pageMemos[0].id;
  assert.deepStrictEqual(o.mainSentAll.filter(([ch]) => ch === 'page:open'), [['page:open', { id, saved: true }]]);
});

test('ED-5・EQ22 (a): 会議を出て止めた議事録は、締めの page:open だけが { id, saved: true }。保存した後に Windows の知らせを押した page:open は ID の文字のまま（前に出す）', { timeout: sceneTimeout(30000) }, async () => {
  const L = (x) => [['line', x], ['clock', 2000]];
  const steps = [...L('mic teams:1'), ...L('mic teams:1'), ['wait-show', 1], ['ipc', 'nudge:start', {}], ...L('mic -'), ...L('mic -'), ...L('mic -'), ['finish'], ['snap', 'f'], ['click-notice', 0], ['snap', 'c']];
  const o = await run(['text', `--mic-feed=${JSON.stringify(steps)}`]);
  const id = o.pageDur[0].id;
  assert.deepStrictEqual(o.mainSentAll.filter(([ch]) => ch === 'page:open'), [['page:open', { id, saved: true }], ['page:open', id]]);
});

test('ED-5・EQ22 (a): 前回の復旧のページの page:open（窓を作るときに送る）は ID の文字のまま。印を付けるのは締めの1行だけ', () => {
  // --recover の場面は窓を作った後に復旧するので page:open を送らない（一覧の描き直しと知らせだけ）。窓を作るときの道は main.js の字面で見る
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const at = src.indexOf('  if (recoveredPageId) {');
  assert.ok(at > 0);
  assert.ok(src.slice(at, src.indexOf('\n  }\n', at)).includes("sendToMainWin('page:open', id);"));
  // 0.13.2 LN-5（計画 docs/plans/2026-10-28-132.md の LR13）で意図して変えた: 保存の途中に会議を出て止めた知らせを押していたら、保存の後にそのページを
  // ID の文字のまま（前に出す）開く1行を足した（締めの印 { id, saved: true } の後ろ）
  assert.deepStrictEqual(src.match(/sendToMainWin\('page:open', [^)]*\)/g), ["sendToMainWin('page:open', m.leavePageId)", "sendToMainWin('page:open', id)", "sendToMainWin('page:open', pageId)",
    "sendToMainWin('page:open', { id: page.id, saved: true })", "sendToMainWin('page:open', page.id)"]);
});

// ---------------------------------------------------------------- 2026-10-26 の持ち主の答え（点検4「どんな手直しでも確かめる（おすすめ）」）
test('点検4: 要約の後に画面で行を1つ消すとページに summaryEdited が付き、［要約を再生成］で作り直すと消える（次の再生成では確かめない）', { timeout: sceneTimeout(30000) }, async () => {
  const o = await run(['text', '--sum', '--claude=ok', '--segs=2', '--resum-after-edit']);
  assert.strictEqual(o.editedBefore, true, '行を消しても印が無い');
  assert.strictEqual(o.resumEdit && o.resumEdit.ok, true, JSON.stringify(o.resumEdit));
  assert.strictEqual(o.editedAfter, undefined, '作り直した後も印が残った');
});
