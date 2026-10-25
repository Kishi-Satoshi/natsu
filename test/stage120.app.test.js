/*
 * stage120.app.test.js — 0.12.0 Task SP-4（計画 docs/plans/2026-10-22-120.md の決めたこと 85・127・139・142・145・148。D53・D66）:
 * ページと録音中の文字起こしの行をタイムラインの順に並べ、時刻の後に「自分」「相手」の札（span.spk）。PC の側の文ごとの行（parts）・
 * 文ごとの行の直し・文字起こしの［コピー］・止めていた時間の印。最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。
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

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const clone = (x) => JSON.parse(JSON.stringify(x));
const T1 = titleAt('2026-10-25T01:00:00.000Z');
const PAGE = { id: 'pa1', title: T1, date: '2026-10-25', createdAt: '2026-10-25T01:00:00.000Z', durationSec: 120, blocks: [], memo: '', summaryError: '' };
const MIC_TITLE = 'マイクから録った声です（同じ部屋の人の声も入ります）';
const SYS_TITLE = 'PC から流れた相手の声です';

// 届いた順（DB の並び）は自分の行が先。時刻の順は相手の行が先（決めたこと 127）
const SEGS = [
  { id: 's1', atMs: 2000, durationMs: 3000, text: '自分の発言です', src: 'mic' },
  { id: 's2', atMs: 0, durationMs: 6000, text: '相手の発言です', src: 'loopback' },
  { id: 's3', atMs: 7000, durationMs: 2000, text: '札の無い行です' },
  { id: 's4', atMs: 9000, durationMs: 1000, text: '話者の値の行です', src: '話者A' },
  { id: 's5', atMs: 12000, durationMs: 1000, text: '危ない値の行です', src: '<b>x</b>' },
];
// PC の側の長い区間（文ごとの行）・その間の自分の行・壊れた parts の区間
const LONG = '一つ目の文です。二つ目の文です。三つ目です。';
const PARTS = [
  { id: 's7', atMs: 0, durationMs: 60000, text: LONG, src: 'loopback', parts: [{ ms: 0, at: 0 }, { ms: 20000, at: 8 }, { ms: 40000, at: 16 }] },
  { id: 's8', atMs: 25000, durationMs: 3000, text: 'はい', src: 'mic' },
  { id: 's9', atMs: 65000, durationMs: 9000, text: '壊れた区間の文です', src: 'loopback', parts: [{ ms: 0, at: 0 }, { ms: 5000, at: 999 }] },
];

async function openSegs(segments, o = {}) {
  const page = { ...PAGE, ...(o.page || {}) };
  let segs = clone(segments);
  const copied = [];
  const l = await load(APP, {
    preloadSrc: PRELOAD,
    returns: {
      meetingTypes: () => lib.typesForView(), memoTypes: () => M.listMemoTypes(),
      pageGet: () => ({ page: clone(page), segments: clone(segs) }),
      // DB と同じ決まり（決めたこと 144）: 文が変わって parts の無い patch なら parts を消す
      segmentUpdate: (pid, sid, patch) => {
        segs = segs.map((s) => { if (s.id !== sid) return s; const n = { ...s, text: patch.text }; delete n.parts; return n; });
        return { page: clone(page), segments: clone(segs) };
      },
      copy: (t) => { copied.push(t); return true; },
      ...(o.returns || {}),
    },
  });
  l.fire('onPageOpen', 'pa1');
  await l.drain();
  l.copied = copied;
  return l;
}
const $ = (l, id) => l.byId.get(id);
const segRows = (l) => $(l, 'pScript').children.filter((e) => e.classList.contains('seg'));
const lastText = (e) => e.children[e.children.length - 1].textContent;
// 行の見た目: [時刻, 札, 文]
const rowView = (e) => [e.querySelector('.at').textContent, e.querySelector('.spk') ? e.querySelector('.spk').textContent : '', lastText(e)];
const view = (l) => segRows(l).filter((e) => !e.hidden).map(rowView);

test('SP-4・D53（決めたこと 85・139）: src が mic・loopback の行に時刻の後の札「自分」「相手」（title つき）。無い・話者A・<b>x</b> は札なし。行はタイムラインの順（届いた順でない）', T, async () => {
  const l = await openSegs(SEGS);
  assert.deepStrictEqual(view(l), [
    ['0:00', '相手', '相手の発言です'], ['0:02', '自分', '自分の発言です'], ['0:07', '', '札の無い行です'], ['0:09', '', '話者の値の行です'], ['0:12', '', '危ない値の行です'],
  ]);
  const rows = segRows(l);
  // 札は時刻のすぐ後
  assert.deepStrictEqual(rows[0].children.map((c) => c.className), ['at', 'spk', 'txt']);
  assert.deepStrictEqual(rows[2].children.map((c) => c.className), ['at', 'txt']);
  assert.strictEqual(rows[0].querySelector('.spk').title, SYS_TITLE);
  assert.strictEqual(rows[1].querySelector('.spk').title, MIC_TITLE);
  // 検索の当たりへ飛ぶ印（seg-<ID>）は区間ごとに1つ
  assert.deepStrictEqual(rows.map((e) => e.id), ['seg-s2', 'seg-s1', 'seg-s3', 'seg-s4', 'seg-s5']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP-4（決めたこと 128・145）: parts のある区間は文ごとの行（同じ札・行の時刻）。壊れた parts の区間は1行で札だけ。文ごとの行を押すと区間の文全体を直す行になり（ほかの文の行は隠す）、保存は segmentUpdate(id, { text }) の1回で、その区間は1行になる', T, async () => {
  const l = await openSegs(PARTS);
  assert.deepStrictEqual(view(l), [
    ['0:00', '相手', '一つ目の文です。'], ['0:20', '相手', '二つ目の文です。'], ['0:25', '自分', 'はい'], ['0:40', '相手', '三つ目です。'], ['1:05', '相手', '壊れた区間の文です'],
  ]);
  assert.deepStrictEqual(segRows(l).map((e) => e.id), ['seg-s7', '', 'seg-s8', '', 'seg-s9']);
  // 文ごとの行の2つ目を押す → 区間の文全体。ほかの文の行は隠す
  const tx = segRows(l)[1].querySelector('.txt');
  tx.dispatchEvent({ type: 'focus' });
  assert.strictEqual(tx.textContent, LONG);
  assert.deepStrictEqual(view(l).map((r) => r[2]), [LONG, 'はい', '壊れた区間の文です']);
  // 変えずに抜けると元の文ごとの行に戻る
  tx.dispatchEvent({ type: 'blur' });
  await l.drain();
  assert.deepStrictEqual(l.called('segmentUpdate'), []);
  assert.deepStrictEqual(view(l).map((r) => r[2]), ['一つ目の文です。', '二つ目の文です。', 'はい', '三つ目です。', '壊れた区間の文です']);
  // 直して抜ける → 保存は1回・区間は1行
  const tx2 = segRows(l)[3].querySelector('.txt');
  tx2.dispatchEvent({ type: 'focus' });
  tx2.textContent = '直した文です。';
  tx2.dispatchEvent({ type: 'blur' });
  await l.drain();
  assert.deepStrictEqual(l.called('segmentUpdate').map((c) => c.args), [['pa1', 's7', { text: '直した文です。' }]]);
  assert.deepStrictEqual(view(l), [['0:00', '相手', '直した文です。'], ['0:25', '自分', 'はい'], ['1:05', '相手', '壊れた区間の文です']]);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP-4（決めたこと 148）: 文字起こしの［コピー］の行は「[0:12] 自分: 文」でタイムラインの順。札の無い行は今どおり「[0:07] 文」。空にした行は写さない', T, async () => {
  const l = await openSegs([...SEGS, { id: 's6', atMs: 13000, durationMs: 1000, text: '', src: 'mic' }]);
  $(l, 'paneBtnScript').click();
  await l.drain();
  const btn = $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === 'コピー');
  await btn.onclick();
  await l.drain();
  assert.deepStrictEqual(l.copied, [['[0:00] 相手: 相手の発言です', '[0:02] 自分: 自分の発言です', '[0:07] 札の無い行です', '[0:09] 話者の値の行です', '[0:12] 危ない値の行です'].join('\n')]);
  // parts のある区間は文ごとの行
  const p = await openSegs(PARTS);
  $(p, 'paneBtnScript').click();
  await p.drain();
  await $(p, 'pMenu').querySelectorAll('button').find((b) => b.textContent === 'コピー').onclick();
  await p.drain();
  assert.deepStrictEqual(p.copied, [['[0:00] 相手: 一つ目の文です。', '[0:20] 相手: 二つ目の文です。', '[0:25] 自分: はい', '[0:40] 相手: 三つ目です。', '[1:05] 相手: 壊れた区間の文です'].join('\n')]);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP-4（決めたこと 142）: 止めていた時間の印は時刻の位置（タイムラインの行の間）に入る', T, async () => {
  const l = await openSegs(SEGS, { page: { pauses: [{ atMs: 6500, ms: 60000 }] } });
  const kids = $(l, 'pScript').children.map((e) => (e.classList.contains('pausemark') ? 'pause' : e.id));
  assert.deepStrictEqual(kids, ['seg-s2', 'seg-s1', 'pause', 'seg-s3', 'seg-s4', 'seg-s5']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP-4（R26）: リンクの印 t:<from>-<to> は文字起こしの面の行（タイムラインの順）で示す。文ごとの行は区間の ID で示し、番号の大小は見ない', T, async () => {
  const LIST = [{ id: 'pa1', title: T1, date: '2026-10-25', durationSec: 120, hasSummary: false, meetingType: null }];
  const l = await openSegs(PARTS, { returns: { linkBase: () => 'https://natsu.example/open#p=', pagesSearch: () => LIST, pagesList: () => LIST } });
  const hits = () => segRows(l).filter((e) => e.classList.contains('linkhit')).map(rowView).map((r) => r[2]);
  l.fire('onOpenLink', { id: 'pa1', anchor: 't:s7-s8' }); await l.drain();
  assert.deepStrictEqual(hits(), ['一つ目の文です。', '二つ目の文です。', 'はい']);
  l.clock.advance(3100); await l.drain();
  l.fire('onOpenLink', { id: 'pa1', anchor: 't:s8-s7' }); await l.drain();
  assert.deepStrictEqual(hits(), ['はい', '三つ目です。']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- 録音中のページ（決めたこと 85・142）
const LIVE = (o = {}) => ({ active: true, startedAt: Date.now() - 60000, segments: [], pauses: [], cloud: true, memo: '',
  stt: { route: 'cloud', lastTextAt: Date.now() - 5000, segSec: 15, problem: null }, ...o });
async function openLive(st) {
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { meetingTypes: () => lib.typesForView(), memoTypes: () => M.listMemoTypes() } });
  await l.drain();
  l.fire('onMeetingUpdate', LIVE(st));
  await l.drain();
  return l;
}

test('SP-4（決めたこと 85・142）: 録音中の行もタイムラインの順で札つき。文字起こし待ちの行（「（文字起こし中…）」）にも札。札の無い会議は今と同じ', T, async () => {
  const l = await openLive({ segments: [
    { id: 's1', atMs: 4000, durationMs: 3000, text: '自分の発言です', src: 'mic' },
    { id: 's2', atMs: 0, durationMs: 8000, text: '', src: 'loopback', pending: true },
    { id: 's3', atMs: 9000, durationMs: 3000, text: '話者の値', src: '話者A' },
  ], pauses: [{ atMs: 8500, ms: 30000 }] });
  assert.deepStrictEqual(view(l), [['0:00', '相手', '（文字起こし中…）'], ['0:04', '自分', '自分の発言です'], ['0:09', '', '話者の値']]);
  assert.ok(segRows(l)[0].classList.contains('pending'));
  const kids = $(l, 'pScript').children.map((e) => e.className.split(' ')[0]);
  assert.deepStrictEqual(kids, ['seg', 'seg', 'pausemark', 'seg', 'livetail']);
  const one = await openLive({ segments: [{ id: 's1', atMs: 0, text: '本日の議題です。' }, { id: 's2', atMs: 15000, text: '', pending: true }] });
  assert.deepStrictEqual(view(one), [['0:00', '', '本日の議題です。'], ['0:15', '', '（文字起こし中…）']]);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
