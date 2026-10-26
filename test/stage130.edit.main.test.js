/*
 * stage130.edit.main.test.js — 0.13.0 第1部の読み手と場面（計画 docs/plans/2026-10-24-130.md の Task ED-3・ED-5）
 * ED-3: 要約の見出しに段（1〜3。古い見出しは 2）・［コピー］と Claude から読む文（MCP）の新しい型・0.11.0 の並べ替えの人の見出し（EQ3 (a)）。
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
