/*
 * stage130.edit.app.test.js — 0.13.0 第1部「編集の動き その1」の画面（計画 docs/plans/2026-10-24-130.md の Task ED-3〜ED-7）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { titleAt } = require('./helpers/titles');
const lib = require('../src/mainlib');
const M = require('../src/memoTypes');
const E = require('../src/blockEdit');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const HTML = fs.readFileSync(APP, 'utf8');
const T = { timeout: 8000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const T1 = titleAt('2026-10-26T01:00:00.000Z');
const SEGS = [{ id: 's1', atMs: 0, durationMs: 5000, text: '来月の予算案は担当Aさんが進めます' }];
const fnFromApp = (name) => {
  const at = HTML.indexOf(`  function ${name}(`);
  assert.ok(at > 0, `app.html に ${name} が無い`);
  return HTML.slice(at, HTML.indexOf('\n  }\n', at) + 4);
};

// 保存したページを開く。cur は DB の今のページ（命令の答えで直す）。calls に IPC の呼び出し（[名前, ...引数]）
async function openPage(page, o = {}) {
  const calls = [];
  let cur = { id: 'pa1', title: T1, date: '2026-10-26', createdAt: '2026-10-26T01:00:00.000Z', durationSec: 1800, memo: '', summaryError: '', meetingType: 'general', typeAuto: false,
    route: { stt: { cloud: 1, local: 0, provider: 'openai' }, summary: { by: 'claude-code' } }, ...page };
  const list = () => [{ id: cur.id, title: cur.title, date: cur.date, durationSec: cur.durationSec, hasSummary: true, meetingType: cur.meetingType }];
  const l = await load(APP, {
    returns: {
      meetingTypes: () => lib.typesForView(), memoTypes: () => M.listMemoTypes(), pagesSearch: list, pagesList: list,
      pageGet: () => ({ page: JSON.parse(JSON.stringify(cur)), segments: SEGS }),
      copy: (t) => { calls.push(['copy', t]); return true; },
      ...(o.returns ? o.returns(() => cur, (p) => { cur = p; }, calls) : {}),
    },
    ...(o.load || {}),
  });
  await l.drain();
  l.byId.get('plist').querySelectorAll('.pitem')[0].dispatchEvent({ type: 'click' });
  await l.drain();
  l.calls130 = calls;
  return l;
}

// ---------------------------------------------------------------- ED-3（決めたこと 22）
test('ED-3: ［コピー］の Markdown は blocksMarkdown の写し（app.html）で、src/blockEdit.js と同じ答え（段 1〜3・番号付き・引用・区切り線・コールアウト・今の4つの型）', () => {
  const app = new Function(`const CALLOUT_ICON = '💡';\n${fnFromApp('headingLevel')}\n${fnFromApp('numberLabels')}\n${fnFromApp('blocksMarkdown')}\nreturn { blocksMarkdown, numberLabels };`)();   // eslint-disable-line no-new-func
  const tables = [[], undefined, [{ id: 'a', type: 'heading', text: '決定事項' }, { id: 'b', type: 'bullet', text: '行' }, { id: 'c', type: 'todo', text: 'やる', checked: true }, { id: 'd', type: 'paragraph', text: '本文' }],
    [{ id: 'h1', type: 'heading', level: 1, text: '一' }, { id: 'h3', type: 'heading', level: 3, text: '三' }, { id: 'n1', type: 'numbered', text: 'a' }, { id: 'n2', type: 'numbered', text: 'b' },
      { id: 'x', type: 'bullet', text: 'c\nd' }, { id: 'n3', type: 'numbered', text: 'e' }, { id: 'q', type: 'quote', text: 'f' }, { id: 'v', type: 'divider', text: '' }, { id: 'c', type: 'callout', text: 'g' }, { id: 'z', type: 'video', text: 'h' }]];
  for (const t of tables) assert.strictEqual(app.blocksMarkdown(t), E.blocksMarkdown(t), JSON.stringify(t));
  for (const t of tables.slice(2)) assert.deepStrictEqual([...app.numberLabels(t)], [...E.numberLabels(t)]);
});

test('ED-3: 要約の欄の［コピー］が見出しを段の数の # で写す（画面の順・今の型は前と同じ）', T, async () => {
  const blocks = [{ id: 'h1', type: 'heading', level: 1, text: '全体の結論' }, { id: 'b1', type: 'bullet', text: '来週に出す', cites: ['s1'], citeState: 'linked' },
    { id: 'h2', type: 'heading', level: 2, text: '決定事項' }, { id: 'n1', type: 'numbered', text: '一つ目' }, { id: 'h3', type: 'heading', level: 3, text: '細かい決めごと' },
    { id: 'p1', type: 'paragraph', text: '本文' }];
  const l = await openPage({ blocks });
  const btn = $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === 'コピー');
  await btn.onclick();
  await l.drain();
  const want = E.blocksMarkdown(M.orderForView(blocks).map((i) => blocks[i])).trim();
  assert.deepStrictEqual(l.calls130.filter((c) => c[0] === 'copy').map((c) => c[1]), [want]);
  assert.ok(want.includes('\n### 細かい決めごと') && want.includes('\n# 全体の結論') && want.includes('1. 一つ目'), want);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
