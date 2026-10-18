'use strict';
// 速さと書く時間を計る道具（第1a回 PERF・JS7）。CI の test のジョブの「速さを計る」の段が回す（5,000 ページの見本は npm test の
// 「1つ 5 秒」に入らないので npm test の外。test/perf.test.js は決め方と小さな見本だけを見る）。
//
//   BUDGETS                 … 目安（ミリ秒）。比べる値はいつも median（CI の機械の一瞬の遅れで赤にしない）
//   p95(list)               … 並べて 95% の位置（Math.ceil(0.95 * n) 番目）。決め方（suggest…）にだけ使う
//   median(list)            … 並べて真ん中の値（数が偶数なら真ん中の2つの平均）
//   judge(results, budgets) … [{ name, ms }] → [{ name, ms, budget, ok }]。目安の無い名前は投げる
//   exitCodeOf(judged)      … NG が1つでもあれば 1
//   suggestBatchMs(p95)     … 設定の大きさの書き込み＋fsync の p95 が 100ms までなら 350（今のまま）、越えたら 1000
//   suggestDraftFsync(p95)  … 512KB（下書きの大きさ）の書き込み＋fsync の p95 が 20ms までなら true（足す）、越えたら false
//   measureStore({ pages, segments, bigBlocks, bigSegments, dir }) → [{ name, ms }]（どれも3回の median）
//   measureWrites({ reps, dir, fs })                               → [{ name, ms（median）, p95 }]（fs は試しで fsync を数えるため。既定は node の fs）
//
// 決め方:
//  - 目安は設計書 PERF（開く 0.5 秒・検索 0.3 秒）。今の JSON の保存では全文検索が 5,000 個のファイルを読むので 0.3 秒に入らない。
//    この回は天井（全文検索 2 秒・全ページに当たる一覧の検索 0.6 秒）で「遅くなっていない」ことを見る。DB にする第2a1回で 0.3 秒に下げる。
//  - 見本は store を通さずに作る（ページ・文字起こし・index.json を fs.writeFileSync で直接書く。fsync なし）。store.createPage で
//    5,000 回作ると、毎回 index.json（最後は約 5MB）を書き直して fsync もするので、見本を作るだけで数分かかる。
//    索引は store と同じ形（summarize の項目）で書き、計る前に store.init が索引を書き直さなかったことを確かめる（書き直したら、
//    見本の形が store とずれたしるしなので投げる。黙って作り直しの時間を計らない）。
//  - 作った見本は最後に中のフォルダごと消す（失敗しても消す）。
//  - Windows の CI でまだ測っていない。中央値が目安を越えた名前があれば、黙って緩めず、測った値を報告に写したうえで、
//    BUDGETS_WIN（越えた名前だけ測った中央値の 2 倍）を足し、judge が process.platform で目安を選ぶ形にする（計画の Task 4-4）。
//
// node tools/perf.js
//   1 行ずつ「OK／NG 名前 ms（目安 ms）」、目安の無い参考の値、決め方の答え（まとめ書きの間隔・draft.json の fsync）、
//   最後に `PERF_JSON {…}` を出し、exitCodeOf で終わる。

const fs = require('fs');
const os = require('os');
const path = require('path');
const J = require('../src/jsonfile');

const BUDGETS = { 'store-init': 500, 'open-page': 500, 'searchIndex-typical': 300, 'searchIndex-all': 600, 'searchFullText': 2000,
  'write-256k-fsync': 50, 'write-1m-fsync': 150, 'write-10m-fsync': 1500 };

const ROUNDS = 3;                 // 計る操作はどれも3回ずつ行い、median を ms にする
const RARE = 'ゆずりは';          // 1件だけに当たる語（一覧の検索は真ん中のページの要約、全文検索は真ん中のページの文字起こし）
const COMMON = '進捗';            // 全ページの要約に当たる語（タイトルには入れない。タイトルで当たると本文と抜粋の道を通らない）
const WRITES = [
  ['write-1k-fsync', 1024],                 // 設定の大きさ（参考の値。suggestBatchMs に p95 を渡す）
  ['write-256k-fsync', 256 * 1024],
  ['write-512k-fsync', 512 * 1024],         // 下書きの大きさ（参考の値。suggestDraftFsync に p95 を渡す）
  ['write-1m-fsync', 1024 * 1024],
  ['write-10m-fsync', 10 * 1024 * 1024],
];

const sorted = (list) => [...list].sort((a, b) => a - b);
const round2 = (n) => Math.round(n * 100) / 100;

function p95(list) {
  const s = sorted(list);
  return s[Math.ceil(0.95 * s.length) - 1];
}

function median(list) {
  const s = sorted(list);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function judge(results, budgets = BUDGETS) {
  return results.map(({ name, ms }) => {
    if (!Object.prototype.hasOwnProperty.call(budgets, name)) throw new Error(`目安が無い: ${name}`);
    const budget = budgets[name];
    return { name, ms, budget, ok: ms <= budget };
  });
}

const exitCodeOf = (judged) => (judged.some((x) => !x.ok) ? 1 : 0);
const suggestBatchMs = (p95SettingsWriteMs) => (p95SettingsWriteMs <= 100 ? 350 : 1000);
const suggestDraftFsync = (p95DraftWriteMs) => p95DraftWriteMs <= 20;

// fn を n 回走らせ、1回ずつのミリ秒の配列を返す
function timesOf(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn();
    out.push(performance.now() - t0);
  }
  return out;
}

function removeDir(d) {
  // Windows ではウイルス対策が新しいファイルを一瞬掴むので、待ってやり直す
  fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// ---------------------------------------------------------------- 見本
const pageId = (i) => `p${String(i).padStart(6, '0')}`;
const isoAt = (i) => new Date(Date.UTC(2026, 9, 18, 0, 0, 0) - i * 3600 * 1000).toISOString();

// ふつうのページ（13 ブロック: 見出し 1・箇条書き 8・ToDo 4）
function samplePage(i, { rare }) {
  const blocks = [{ id: 'b0', type: 'heading', text: '要点' }];
  for (let k = 1; k <= 8; k++) {
    const extra = rare && k === 4 ? `（${RARE}の件を決めた）` : '';
    blocks.push({ id: `b${k}`, type: 'bullet', text: `第${i}回の議題の${k}番目について話し合い、${COMMON}は予定どおりと確かめた${extra}。`, cites: [`s${k}`], citeState: 'auto' });
  }
  for (let k = 9; k <= 12; k++) {
    blocks.push({ id: `b${k}`, type: 'todo', text: `資料の${k}番目の項目をまとめて共有する`, checked: k % 2 === 0, assignee: `担当${k % 3}`, due: '2026-10-25', cites: [`s${k}`], citeState: 'auto' });
  }
  return {
    id: pageId(i), title: `定例会議 ${i}`, date: isoAt(i).slice(0, 10), durationSec: 3600, memo: `メモ ${i}`,
    blocks, createdAt: isoAt(i), updatedAt: isoAt(i), recovered: false, summaryError: '',
  };
}

function sampleSegments(n, { rare } = {}) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const extra = rare && k === (n >> 1) ? `${RARE}の話もしました。` : '';
    out.push({ id: `s${k}`, start: k * 5, end: k * 5 + 4.5, text: `${k}番目の発言です。来週までに資料をまとめて共有します。${extra}` });
  }
  return out;
}

// 2,000 ブロック（見出し・箇条書き・ToDo を順に）のページ
function sampleBigPage(id, nBlocks) {
  const kinds = ['heading', 'bullet', 'todo'];
  const blocks = [];
  for (let k = 0; k < nBlocks; k++) {
    const type = kinds[k % 3];
    const b = { id: `b${k}`, type, text: `大きなページの${k}番目のブロックで、長めの文を書いておく。` };
    if (type !== 'heading') { b.cites = [`s${k}`]; b.citeState = 'auto'; }
    if (type === 'todo') { b.checked = false; b.assignee = '担当1'; b.due = '2026-10-30'; }
    blocks.push(b);
  }
  return {
    id, title: '大きな会議', date: '2026-10-18', durationSec: 36000, memo: '', blocks,
    createdAt: '2026-10-18T01:00:00.000Z', updatedAt: '2026-10-18T01:00:00.000Z', recovered: false, summaryError: '',
  };
}

// store.js の summarize と同じ項目（searchText と memoText があれば、store.init は索引を書き直さない）
function indexEntryOf(page) {
  const todos = page.blocks.filter((b) => b.type === 'todo');
  const open = todos.filter((b) => !b.checked);
  const firstBullet = page.blocks.find((b) => b.type === 'bullet' && b.text);
  const dues = open.map((b) => b.due).filter(Boolean).sort();
  return {
    id: page.id, title: page.title, date: page.date, durationSec: page.durationSec,
    createdAt: page.createdAt, updatedAt: page.updatedAt, meetingType: 'general',
    hasSummary: page.blocks.some((b) => b.type === 'heading'),
    actionCount: todos.length, openActionCount: open.length, nextDue: dues[0] || '',
    assignees: [...new Set(open.map((b) => b.assignee).filter(Boolean))],
    preview: firstBullet ? firstBullet.text.slice(0, 120) : '',
    searchText: page.blocks.map((b) => b.text).filter(Boolean).join(' ').slice(0, 20000),
    memoText: String(page.memo || '').slice(0, 2000),
    recovered: false,
  };
}

// <userData>/data に見本を直接書く（store を通さない）
function writeSample(userData, { pages, segments, bigBlocks, bigSegments }) {
  const data = path.join(userData, 'data');
  const pagesDir = path.join(data, 'pages');
  const trDir = path.join(data, 'transcripts');
  fs.mkdirSync(pagesDir, { recursive: true });
  fs.mkdirSync(trDir, { recursive: true });
  const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  const entries = [];
  const big = sampleBigPage('pbig', bigBlocks);
  put(path.join(pagesDir, `${big.id}.json`), big);
  put(path.join(trDir, `${big.id}.json`), { id: big.id, segments: sampleSegments(bigSegments) });
  entries.push(indexEntryOf(big));
  const rareAt = pages >> 1;
  for (let i = 0; i < pages; i++) {
    const page = samplePage(i, { rare: i === rareAt });
    put(path.join(pagesDir, `${page.id}.json`), page);
    put(path.join(trDir, `${page.id}.json`), { id: page.id, segments: sampleSegments(segments, { rare: i === rareAt }) });
    entries.push(indexEntryOf(page));
  }
  entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const indexFile = path.join(data, 'index.json');
  put(indexFile, { version: 2, pages: entries });
  return { indexFile, bigId: big.id };
}

// ---------------------------------------------------------------- 計る
async function measureStore({ pages = 5000, segments = 60, bigBlocks = 2000, bigSegments = 10000, dir } = {}) {
  if (!dir) throw new Error('measureStore: dir が要る');
  const userData = fs.mkdtempSync(path.join(dir, 'store-'));
  try {
    const { indexFile, bigId } = writeSample(userData, { pages, segments, bigBlocks, bigSegments });
    const store = require('../src/store');
    const before = fs.statSync(indexFile);
    const out = [];
    out.push({ name: 'store-init', ms: median(timesOf(ROUNDS, () => store.init(userData))) });
    const after = fs.statSync(indexFile);
    if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.size !== before.size) {
      throw new Error('store.init が見本の索引を書き直した（見本の索引の形が store.js の summarize とずれている）');
    }
    if (store.listPages().length !== pages + 1) throw new Error(`索引の数が合わない: ${store.listPages().length}（見本は ${pages + 1}）`);

    let opened = null;
    out.push({ name: 'open-page', ms: median(timesOf(ROUNDS, () => { opened = [store.getPage(bigId), store.getTranscript(bigId)]; })) });
    if (!opened[0] || opened[0].blocks.length !== bigBlocks || opened[1].length !== bigSegments) throw new Error('大きなページを開けない');

    let hit = null;
    out.push({ name: 'searchIndex-typical', ms: median(timesOf(ROUNDS, () => { hit = store.searchIndex(RARE); })) });
    if (hit.length !== 1) throw new Error(`1件に当たる語が ${hit.length} 件に当たった`);
    out.push({ name: 'searchIndex-all', ms: median(timesOf(ROUNDS, () => { hit = store.searchIndex(COMMON); })) });
    if (hit.length !== pages) throw new Error(`全ページに当たる語が ${hit.length} 件に当たった（見本は ${pages}）`);
    out.push({ name: 'searchFullText', ms: median(timesOf(ROUNDS, () => { hit = store.searchFullText(RARE); })) });
    if (hit.total !== 1) throw new Error(`全文検索の1件に当たる語が ${hit.total} 件に当たった`);

    return out.map((x) => ({ name: x.name, ms: round2(x.ms) }));
  } finally {
    removeDir(userData);
  }
}

// JSON にして bytes ほどになる値（文字起こしの発言の並び。writeJsonFile と同じ JSON.stringify(…, null, 2) で数える）
function sampleOfSize(bytes) {
  const size = (n) => Buffer.byteLength(JSON.stringify({ version: 1, segments: sampleSegments(n) }, null, 2));
  const base = size(0);
  const per = size(2) - size(1);
  return { version: 1, segments: sampleSegments(Math.max(1, Math.round((bytes - base) / per))) };
}

function measureWrites({ reps = 20, dir, fs: writeFs } = {}) {
  if (!dir) throw new Error('measureWrites: dir が要る');
  const root = fs.mkdtempSync(path.join(dir, 'write-'));
  try {
    return WRITES.map(([name, bytes]) => {
      const value = sampleOfSize(bytes);
      const file = path.join(root, `${name}.json`);
      const list = timesOf(reps, () => J.writeJsonFile(file, value, { fsync: true, fs: writeFs }));
      return { name, ms: round2(median(list)), p95: round2(p95(list)), bytes: fs.statSync(file).size };
    });
  } finally {
    removeDir(root);
  }
}

// ---------------------------------------------------------------- node tools/perf.js
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-perf-'));
  try {
    const t0 = performance.now();
    const s = await measureStore({ dir });
    const w = measureWrites({ dir });
    const judged = judge([...s, ...w.filter((x) => Object.prototype.hasOwnProperty.call(BUDGETS, x.name))]);
    for (const x of judged) console.log(`${x.ok ? 'OK' : 'NG'} ${x.name} ${x.ms}ms（目安 ${x.budget}ms）`);
    for (const x of w) console.log(`書く時間 ${x.name} 中央値 ${x.ms}ms・p95 ${x.p95}ms（${x.bytes} バイト）`);
    const byName = Object.fromEntries(w.map((x) => [x.name, x]));
    const batchMs = suggestBatchMs(byName['write-1k-fsync'].p95);
    const draftFsync = suggestDraftFsync(byName['write-512k-fsync'].p95);
    console.log(`決め方: まとめ書きの間隔 ${batchMs}ms（設定の大きさの書き込み＋fsync の p95 ${byName['write-1k-fsync'].p95}ms。100ms までなら今の 350ms）`);
    console.log(`決め方: draft.json の fsync ${draftFsync ? '足す' : '足さない'}（512KB の書き込み＋fsync の p95 ${byName['write-512k-fsync'].p95}ms。20ms までなら足す）`);
    console.log(`計り全体 ${Math.round(performance.now() - t0)}ms（${process.platform} ${process.version}）`);
    console.log(`PERF_JSON ${JSON.stringify({ platform: process.platform, node: process.version, judged, writes: w, suggest: { batchMs, draftFsync } })}`);
    process.exitCode = exitCodeOf(judged);
  } finally {
    removeDir(dir);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
}

module.exports = { BUDGETS, p95, median, judge, exitCodeOf, suggestBatchMs, suggestDraftFsync, measureStore, measureWrites };
