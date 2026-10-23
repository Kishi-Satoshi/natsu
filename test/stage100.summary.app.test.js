/*
 * stage100.summary.app.test.js — 0.10.0 Task LS-2（D63・D69・決めたこと 111。計画 docs/plans/2026-10-20-100.md）: 要約の欄の鍵の画面。
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。main の答えは偽物（preload.js の名前から作る）。
 */
'use strict';
const { titleAt } = require('./helpers/titles');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const T1 = titleAt('2026-10-22T01:00:00.000Z');
const LIST = [{ id: 'pa1', title: T1, date: '2026-10-22', durationSec: 1800, hasSummary: false }];
const BLOCKS = [
  { id: 'b1', type: 'heading', text: '決めたこと' },
  { id: 'b2', type: 'bullet', text: '来月の予算案の作成を担当Aが進める', cites: ['s1'] },
  { id: 'b3', type: 'todo', text: '見積書を月末までに先方へ送る', checked: false, assignee: '担当A', dueRaw: '月末', due: '2026-10-31', dueApprox: true, cites: ['s1'] },
];
const SEGS = [{ id: 's1', atMs: 0, durationMs: 5000, text: '来月の予算案は担当Aさんが進めます' }];
const base = { id: 'pa1', title: T1, date: '2026-10-22', createdAt: '2026-10-22T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general', summaryError: '' };
const openPage = async (page, segments = SEGS) => {
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: () => LIST, pageGet: () => ({ page: { ...base, ...page }, segments }) } });
  await l.drain();
  l.byId.get('plist').querySelectorAll('.pitem')[0].dispatchEvent({ type: 'click' });
  await l.drain();
  return l;
};
const lockText = (l) => { const n = l.byId.get('pNote').querySelector('.locknote'); return n ? n.textContent : ''; };
const note = (l) => { const n = l.byId.get('pNote').querySelector('.note'); return n ? n.textContent : ''; };
const LK = {
  live: '録音中は要約を直せません。書きたいことはメモに書いてください。',
  making: '要約を作っています。',
  wait: '要約待ち（つながったら作ります）。要約ができるまでは直せません。書きたいことはメモに書いてください。',
  empty: '文字起こしが無いので、要約は作れません。書きたいことはメモに書いてください。',
  none: '［要約を生成］で要約を作ると、直せるようになります。書きたいことはメモに書いてください。',
};

test('D69・決めたこと 111: 欄の頭の一言（要約待ち・まだ作っていない・文字起こしが空・録音中）。要約待ちの文を ⚠ の理由として重ねない', T, async () => {
  const w = await openPage({ summaryWait: true, summaryError: '要約待ち（つながったら作ります）' });
  assert.strictEqual(lockText(w), LK.wait);
  assert.strictEqual(note(w), '', '要約待ちの文を ⚠ の理由として重ねた');
  assert.strictEqual(lockText(await openPage({})), LK.none);
  assert.strictEqual(lockText(await openPage({}, [{ id: 's1', atMs: 0, durationMs: 1000, text: '（失敗）', failed: true }])), LK.empty);
  assert.strictEqual(lockText(await openPage({ meeting: { phase: 'recording' } })), LK.live);
  assert.deepStrictEqual(w.errors.map(fmt), []);
});

test('D63: 鍵の間は要約の欄が読むだけ（文を直せない・つまみと × が無い・チェックと担当と期限を押せない）。メモは直せる', T, async () => {
  const l = await openPage({ summaryWait: true, summaryError: '要約待ち（つながったら作ります）', blocks: BLOCKS });
  const box = l.byId.get('pNote');
  const blks = box.querySelectorAll('.blk');
  assert.strictEqual(blks.length, 3, '要約のブロックを見せていない');
  assert.ok(blks.every((b) => b.querySelector('.txt').contentEditable === 'false'), '鍵なのに文を直せる');
  assert.deepStrictEqual(box.querySelectorAll('.grip'), [], '鍵なのに並べ替えのつまみがある');
  assert.deepStrictEqual(box.querySelectorAll('.del'), [], '鍵なのに行を消す × がある');
  const todo = blks.find((b) => b.dataset.id === 'b3');
  assert.strictEqual(todo.querySelector('input').disabled, true);
  assert.ok(todo.querySelectorAll('.atag').length > 0 && todo.querySelectorAll('.atag').every((t) => t.disabled === true), '担当・期限を押せる');
  assert.strictEqual(todo.querySelector('.atag').textContent, '担当A');
  // メモの欄は鍵を見ない
  assert.ok(l.byId.get('pMemo').querySelector('textarea'), 'メモの欄が無い');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('決めたこと 111 の 4・5: 要約があるページと Claude Code が断ったページは鍵が無い（一言を出さず、文を直せる。断った理由は ⚠ で出る）', T, async () => {
  const m = await openPage({ blocks: BLOCKS, route: { summary: { by: 'claude-code', at: '2026-10-22T02:00:00.000Z' } } });
  assert.strictEqual(lockText(m), '');
  const blks = m.byId.get('pNote').querySelectorAll('.blk');
  assert.ok(blks.every((b) => b.querySelector('.txt').contentEditable === 'true'));
  assert.strictEqual(m.byId.get('pNote').querySelectorAll('.del').length, 3);
  const gone = await openPage({ blocks: [], route: { summary: { by: 'claude-code', at: '2026-10-22T02:00:00.000Z' } } });
  assert.strictEqual(lockText(gone), '', '要約ができた後にブロックを全部消すと鍵がまたかかった');
  const r = await openPage({ summaryError: 'Claude Code のログインが切れています。設定の［Claude Code にログイン］を押してください。' });
  assert.strictEqual(lockText(r), '');
  assert.strictEqual(note(r), 'Claude Code のログインが切れています。設定の［Claude Code にログイン］を押してください。');
  assert.ok(r.byId.get('pActs').querySelectorAll('button').some((b) => b.textContent === '要約を生成'), '［要約を生成］が無い');
});

test('決めたこと 111 の 2: main が今そのページの要約を作っている間（summary:running）は「要約を作っています。」で読むだけ。終われば外れる', T, async () => {
  const l = await openPage({ blocks: BLOCKS, route: { summary: { by: 'claude-code', at: '2026-10-22T02:00:00.000Z' } } });
  assert.strictEqual(lockText(l), '');
  l.fire('onSummaryRunning', ['pa1']); await l.drain();
  assert.strictEqual(lockText(l), LK.making);
  assert.ok(l.byId.get('pNote').querySelectorAll('.blk').every((b) => b.querySelector('.txt').contentEditable === 'false'));
  l.fire('onSummaryRunning', ['pzz']); await l.drain();
  assert.strictEqual(lockText(l), '', 'ほかのページの要約で鍵がかかった');
  l.fire('onSummaryRunning', []); await l.drain();
  assert.strictEqual(lockText(l), '');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
