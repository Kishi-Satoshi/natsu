// 速さと書く時間を計る道具（第1a回 PERF・JS7。第2a1回 G-1 で議事録の DB の目安にした）。CI の test のジョブの「速さを計る」の段が回す
// （5,000 ページの見本は npm test の「1つ 5 秒」に入らないので npm test の外。test/perf.test.js は決め方と小さな見本だけを見る）。
//
//   BUDGETS                 … 目安（ミリ秒）。比べる値はいつも median（CI の機械の一瞬の遅れで赤にしない）
//   p95(list)               … 並べて 95% の位置（Math.ceil(0.95 * n) 番目）。決め方（suggest…）にだけ使う
//   median(list)            … 並べて真ん中の値（数が偶数なら真ん中の2つの平均）
//   judge(results, budgets) … [{ name, ms }] → [{ name, ms, budget, ok }]。目安の無い名前は投げる
//   exitCodeOf(judged)      … NG が1つでもあれば 1
//   suggestBatchMs(p95)     … 設定の大きさの書き込み＋fsync の p95 が 100ms までなら 350（今のまま）、越えたら 1000
//   suggestDraftFsync(p95)  … 512KB（下書きの大きさ）の書き込み＋fsync の p95 が 20ms までなら true（足す）、越えたら false
//   measureDb({ pages, segments, bigBlocks, bigSegments, dir })   → [{ name, ms }]（db-open・list・searchIndex-*・searchFull-*・open-page・write-commit）
//   measureMigrate({ pages, segments, blocks, rounds, dir, onDone }) → [{ name: 'migrate-500', ms }]
//   measureDraftWhileBusy({ reps, dir })                          → { name: 'draft-write-while-db-busy', ms, p95, dbWritesDuring, stillWriting }（参考の値）
//   measureWrites({ reps, dir, fs })                              → [{ name, ms（median）, p95 }]（fs は試しで fsync を数えるため。既定は node の fs）
//   sampleDbPage(i, { rare, segments }) → { page, segments }・insertSample(db, items) … DB の見本（テストが形を putPageRows と比べる）
//
// 決め方:
//  - 目安は設計書 PERF（開く 0.5 秒・検索 0.3 秒）と RF12（30万発言の全文検索 0.3 秒）。第1a回の JSON の保存の目安（store-init・
//    searchFullText の天井 2 秒）は外した（main はもう JSON の保存を使わない）。
//  - DB の見本は 5,000 ページ × 発言 60 = 30 万発言と、2,000 ブロック・1 万発言の大きなページ。命令を通さずに SQL で直に入れる
//    （1つのトランザクション。JSON は作らない）。行は命令と同じ ops.pageRow・blockRow・segRow で作り、全文検索の索引は表の trigger が
//    作る。計る前に、読んだページが見本と同じ形かを確かめる（ずれたら投げる。黙ってずれた形の時間を計らない）。
//  - 計る操作は core.call を通す（照らし・BEGIN・COMMIT まで。画面と main の頼みと同じ道）。searchFull-short は 2 文字の LIKE で、
//    どの発言にもある語（30 万行が当たる。いちばん重い形）。write-commit は synchronous=FULL の1回の書き込み（page.setTitle）。
//  - migrate-500 は 500 ページ × 発言 60 × ブロック 25 の JSON を書いて、D-5a の migrate で移して確かめるまで（D-5a から移した。
//    単体テストの 5 秒の決まりに入らないため）。元の JSON が変わらないことも見る。
//  - draft-write-while-db-busy は、別のスレッドの DB の接続が書き続けている間の 512KB の下書きの書き込み＋fsync（ST12。目安なし。
//    DB は別のプロセスなので write-512k-fsync と同じくらいのはず）。
//  - 作った見本は最後に中のフォルダごと消す（失敗しても消す）。
//  - Windows の CI（windows-latest）は Linux より遅い。越えた名前だけを BUDGETS_WIN（測った中央値の 2 倍）にし、main は
//    budgetsFor(process.platform) で目安を選ぶ。第1a回の searchIndex-all（JSON の保存で 729.43ms）は DB にしたので外した。
//    DB の Windows の値は CI の出力から決め直す。
//
// node tools/perf.js [--pages=N] [--segments=N]
//   1 行ずつ「OK／NG 名前 ms（目安 ms）」、目安の無い参考の値、決め方の答え（まとめ書きの間隔・draft.json の fsync）、
//   最後に `PERF_JSON {…}` を出し、exitCodeOf で終わる。--pages・--segments は手で見本の大きさを変えて計るとき（既定 5000・60）。

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const J = require('../src/jsonfile');

const BUDGETS = { 'db-open': 500, 'list': 300, 'searchIndex-typical': 300, 'searchIndex-all': 600,
  'searchFull-trigram': 300, 'searchFull-short': 300, 'open-page': 500, 'write-commit': 50, 'migrate-500': 10000,
  'write-256k-fsync': 50, 'write-1m-fsync': 150, 'write-10m-fsync': 1500 };
// Windows だけの目安（越えた名前だけ。測った中央値の 2 倍）。DB にしたので、Windows の CI の値を見て決め直す
const BUDGETS_WIN = {};
const budgetsFor = (platform) => (platform === 'win32' ? { ...BUDGETS, ...BUDGETS_WIN } : BUDGETS);

const ROUNDS = 3;                 // 計る操作はどれも3回ずつ行い、median を ms にする
const WRITER_ROLE = 'natsu-perf-db-writer';   // measureDraftWhileBusy が起こすスレッドの印
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
const SHORT = '資料';             // 2 文字の LIKE の語（どの発言にもある。30 万行が当たる、いちばん重い形）

// 発言（今の録音が作る形 { id, atMs, durationMs, text }）。どれにも SHORT が入る
function sampleSegments(n, { rare } = {}) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const extra = rare && k === (n >> 1) ? `${RARE}の話もしました。` : '';
    out.push({ id: `s${k}`, atMs: k * 5000, durationMs: 4500, text: `${k}番目の発言です。来週までに${SHORT}をまとめて共有します。${extra}` });
  }
  return out;
}

// ふつうのページ（blocks 個のブロック: 見出し 1・残りを箇条書きと ToDo に 2:1 で）と、その発言。
// ブロックの ID は表全体で重ならない（blocks.id は UNIQUE）ので、ページの ID を頭に付ける
function sampleDbPage(i, { rare = false, segments = 60, blocks = 13 } = {}) {
  const id = pageId(i);
  const list = [{ id: `${id}b0`, type: 'heading', text: '要点' }];
  for (let k = 1; k < blocks; k++) {
    if (k % 3 === 0) {
      list.push({ id: `${id}b${k}`, type: 'todo', text: `資料の${k}番目の項目をまとめて共有する`, checked: k % 2 === 0, assignee: `担当${k % 3}`,
        due: '2026-10-25', cites: [`s${k}`], citeState: 'auto' });
    } else {
      const extra = rare && k === 4 ? `（${RARE}の件を決めた）` : '';
      list.push({ id: `${id}b${k}`, type: 'bullet', text: `第${i}回の議題の${k}番目について話し合い、${COMMON}は予定どおりと確かめた${extra}。`,
        cites: [`s${k}`], citeState: 'auto' });
    }
  }
  const page = {
    id, title: `定例会議 ${i}`, date: isoAt(i).slice(0, 10), durationSec: 3600, memo: `メモ ${i}`,
    blocks: list, createdAt: isoAt(i), updatedAt: isoAt(i), recovered: false, summaryError: '',
  };
  return { page, segments: sampleSegments(segments, { rare }) };
}

// 2,000 ブロック（見出し・箇条書き・ToDo を順に）のページ
function sampleBigPage(id, nBlocks, nSegments) {
  const kinds = ['heading', 'bullet', 'todo'];
  const blocks = [];
  for (let k = 0; k < nBlocks; k++) {
    const type = kinds[k % 3];
    const b = { id: `${id}b${k}`, type, text: `大きなページの${k}番目のブロックで、長めの文を書いておく。` };
    if (type !== 'heading') { b.cites = [`s${k}`]; b.citeState = 'auto'; }
    if (type === 'todo') { b.checked = false; b.assignee = '担当1'; b.due = '2026-10-30'; }
    blocks.push(b);
  }
  const page = {
    id, title: '大きな会議', date: '2026-10-18', durationSec: 36000, memo: '', blocks,
    createdAt: '2026-10-18T01:00:00.000Z', updatedAt: '2026-10-18T01:00:00.000Z', recovered: false, summaryError: '',
  };
  return { page, segments: sampleSegments(nSegments) };
}

// 見本を SQL で直に入れる（1つのトランザクション。命令と oplog を通さない）。行の形は命令と同じ ops の関数で作る
function insertSample(db, items) {
  const OPS = require('../src/db/ops');
  const { evenKeys } = require('../src/db/keys');
  const putRow = db.prepare('insert into blocks(id, type, page_id, parent_id, ord, text, rich, attrs, fold, rev, created_at, updated_at, trashed_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const putSeg = db.prepare('insert into segments(page_id, id, n, at_ms, duration_ms, text, fold, failed, extra) values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const row = (r) => putRow.run(r.id, r.type, r.page_id, r.parent_id, r.ord, r.text, r.rich === null ? null : JSON.stringify(r.rich),
    JSON.stringify(r.attrs), OPS.foldOfRow(r.type, r.text, r.attrs), r.rev, r.created_at, r.updated_at, r.trashed_at);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const { page, segments } of items) {
      row(OPS.pageRow(page));
      const keys = evenKeys(page.blocks.length);
      page.blocks.forEach((b, i) => row(OPS.blockRow(b, page.id, keys[i])));
      segments.forEach((s, n) => {
        const r = OPS.segRow(s, page.id, n);
        putSeg.run(r.page_id, r.id, r.n, r.at_ms, r.duration_ms, r.text, r.fold, r.failed, r.extra);
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 戻せなくても投げる */ }
    throw e;
  }
}

// 計る場所: dir が無ければ OS の一時フォルダに作り、終わったら丸ごと消す
function workDir(dir, prefix) {
  return fs.mkdtempSync(path.join(dir || os.tmpdir(), dir ? prefix : `natsu-perf-${prefix}`));
}

// ---------------------------------------------------------------- 計る
// 読んだページが入れた見本と同じ形か（rev と空の children を除いて深く比べる）。ずれていたら投げる
function checkSampleShape(C, db, { page, segments }) {
  const got = C.readRawPage(db, page.id);
  if (!got) throw new Error('見本のページを読めない');
  const a = structuredClone(got);
  delete a.rev;
  for (const b of a.blocks) delete b.children;
  if (!isDeepStrictEqual(a, page) || !isDeepStrictEqual(C.readSegments(db, page.id), segments)) {
    throw new Error('見本の形が命令で読む形とずれている（tools/perf.js の insertSample を直す）');
  }
}

async function measureDb({ pages = 5000, segments = 60, bigBlocks = 2000, bigSegments = 10000, dir } = {}) {
  const sqlite = require('node:sqlite');
  const core = require('../src/db/core');
  const C = require('../src/db/commands');
  const root = workDir(dir, 'db-');
  const file = path.join(root, 'natsu.db');
  let db = null;
  const close = () => { if (db) { db.close(); db = null; } };
  try {
    const first = core.open({ sqlite, file });
    if (first.state !== 'ok') throw new Error(`見本の DB を開けない（${first.state}・${first.code || ''}）`);
    db = first.db;
    const bigId = 'pbig';
    const rareAt = pages >> 1;
    const items = [sampleBigPage(bigId, bigBlocks, bigSegments)];
    for (let i = 0; i < pages; i++) items.push(sampleDbPage(i, { rare: i === rareAt, segments }));
    insertSample(db, items);
    checkSampleShape(C, db, items[1 + rareAt]);
    close();

    const out = [];
    // median と、1回目（一覧の1行を覚える前・問い合わせを用意する前）の値
    const med = (n, fn) => { const list = timesOf(n, fn); return { ms: median(list), first: list[0] }; };
    out.push({ name: 'db-open', ...med(ROUNDS, () => { close(); db = core.open({ sqlite, file }).db; }) });
    if (!db) throw new Error('見本の DB を開き直せない');
    const ask = (cmd, args, tx) => {
      const r = core.call(db, { role: tx ? 'main' : 'app', cmd, args, tx }, { labels: {} });
      if (!r.ok) throw new Error(`${cmd} が ${r.code} で返った`);
      return r.result;
    };
    let hit = null;
    out.push({ name: 'list', ...med(ROUNDS, () => { hit = ask('pages.list', {}); }) });
    if (hit.length !== pages + 1) throw new Error(`一覧の数が合わない: ${hit.length}（見本は ${pages + 1}）`);
    out.push({ name: 'searchIndex-typical', ...med(ROUNDS, () => { hit = ask('pages.list', { q: RARE }); }) });
    if (hit.length !== 1) throw new Error(`1件に当たる語が ${hit.length} 件に当たった`);
    out.push({ name: 'searchIndex-all', ...med(ROUNDS, () => { hit = ask('pages.list', { q: COMMON }); }) });
    if (hit.length !== pages) throw new Error(`全ページに当たる語が ${hit.length} 件に当たった（見本は ${pages}）`);
    out.push({ name: 'searchFull-trigram', ...med(ROUNDS, () => { hit = ask('pages.searchFull', { q: RARE }); }) });
    if (hit.total !== 1) throw new Error(`全文検索の1件に当たる語が ${hit.total} 件に当たった`);
    out.push({ name: 'searchFull-short', ...med(ROUNDS, () => { hit = ask('pages.searchFull', { q: SHORT }); }) });
    if (hit.total !== pages + 1) throw new Error(`全文検索の 2 文字の語が ${hit.total} 件に当たった（見本は ${pages + 1}）`);

    let opened = null;
    out.push({ name: 'open-page', ...med(ROUNDS, () => { opened = ask('page.get', { id: bigId }); }) });
    if (!opened || opened.page.blocks.length !== bigBlocks || opened.segments.length !== bigSegments) throw new Error('大きなページを開けない');

    let n = 0;
    const target = pageId(0);
    out.push({ name: 'write-commit', ...med(10, () => { n++; ask('page.setTitle', { id: target, title: `定例会議 0（${n}）` }, `m:perf:${n}`); }) });
    if (ask('page.get', { id: target }).page.title !== `定例会議 0（${n}）`) throw new Error('書いた題名が読めない');

    return out.map((x) => ({ name: x.name, ms: round2(x.ms), first: round2(x.first) }));
  } finally {
    close();
    removeDir(root);
  }
}

// 0.6.0 の store.js が書くのと同じ形の JSON（JSON.stringify(…, null, 2)）を pages/・transcripts/ に直接書く
function writeJsonSample(dataDir, { pages, segments, blocks }) {
  const pagesDir = path.join(dataDir, 'pages');
  const trDir = path.join(dataDir, 'transcripts');
  fs.mkdirSync(pagesDir, { recursive: true });
  fs.mkdirSync(trDir, { recursive: true });
  const put = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  for (let i = 0; i < pages; i++) {
    const { page, segments: segs } = sampleDbPage(i, { segments, blocks });
    put(path.join(pagesDir, `${page.id}.json`), page);
    put(path.join(trDir, `${page.id}.json`), { version: 1, segments: segs });
  }
}

// フォルダの中の全部のファイルの名前と SHA-256（元の JSON が変わらないことを見る）
function treeOf(d) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(d, rel), { withFileTypes: true })) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) walk(r);
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(d, r))).digest('hex');
    }
  };
  walk('');
  return out;
}

async function measureMigrate({ pages = 500, segments = 60, blocks = 25, rounds = ROUNDS, dir, onDone } = {}) {
  const sqlite = require('node:sqlite');
  const M = require('../src/db/migrate');
  const root = workDir(dir, 'migrate-');
  const dataDir = path.join(root, 'data');
  try {
    writeJsonSample(dataDir, { pages, segments, blocks });
    const before = treeOf(dataDir);
    let last = null;
    const list = [];
    for (let k = 0; k < rounds; k++) {
      // 前の回の natsu.db（と WAL の脇のファイル）を消してから移す（移行は natsu.db があると移さない）
      for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(path.join(dataDir, M.DB_NAME + suffix), { force: true });
      const t0 = performance.now();
      last = M.migrate({ sqlite, dataDir });
      list.push(performance.now() - t0);
      if (!last.ok) throw new Error(`移行が ${last.code} で止まった`);
      if (last.counts.pages !== pages || last.counts.segments !== pages * segments) throw new Error('移した数が見本と合わない');
    }
    const after = treeOf(dataDir);
    for (const name of Object.keys(after)) if (name.startsWith(M.DB_NAME)) delete after[name];
    if (typeof onDone === 'function') onDone({ ok: last.ok, counts: last.counts, sourceSame: isDeepStrictEqual(before, after) });
    return [{ name: 'migrate-500', ms: round2(median(list)) }];
  } finally {
    removeDir(root);
  }
}

// 別のスレッドの DB の接続が書き続けている間に、512KB の下書きを書いて fsync する時間（ST12。参考の値）
async function measureDraftWhileBusy({ reps = 20, dir } = {}) {
  const sqlite = require('node:sqlite');
  const core = require('../src/db/core');
  const root = workDir(dir, 'busy-');
  const file = path.join(root, 'natsu.db');
  const shared = new Int32Array(new SharedArrayBuffer(8));   // [0] 止める印・[1] 書いた数
  let worker = null;
  try {
    const first = core.open({ sqlite, file });
    if (first.state !== 'ok') throw new Error('見本の DB を開けない');
    insertSample(first.db, [sampleDbPage(0, { segments: 60 })]);
    first.db.close();
    worker = new Worker(__filename, { workerData: { role: WRITER_ROLE, file, shared } });
    const exited = new Promise((resolve) => worker.once('exit', resolve));
    await new Promise((resolve, reject) => {
      worker.once('message', (m) => (m === 'writing' ? resolve() : reject(new Error(String(m)))));
      worker.once('error', reject);
    });
    const value = sampleOfSize(512 * 1024);
    const draft = path.join(root, 'draft.json');
    const c0 = Atomics.load(shared, 1);
    const list = timesOf(reps, () => J.writeJsonFile(draft, value, { fsync: true }));
    const c1 = Atomics.load(shared, 1);
    // 計り終えた後も書き続けている（計る間ずっと書いていた）ことを確かめてから止める（2 秒まで待つ）
    const until = Date.now() + 2000;
    while (Atomics.load(shared, 1) === c1 && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    const stillWriting = Atomics.load(shared, 1) > c1;
    Atomics.store(shared, 0, 1);
    await exited;
    worker = null;
    return { name: 'draft-write-while-db-busy', ms: round2(median(list)), p95: round2(p95(list)), dbWritesDuring: c1 - c0, stillWriting };
  } finally {
    if (worker) { Atomics.store(shared, 0, 1); await worker.terminate(); }
    removeDir(root);
  }
}

// 書き続けるスレッド: 止める印が立つまで page.setMemo を1つずつ確定する（synchronous=FULL）
function dbWriterLoop({ file, shared }) {
  const sqlite = require('node:sqlite');
  const core = require('../src/db/core');
  const { db } = core.open({ sqlite, file });
  try {
    let n = 0;
    while (Atomics.load(shared, 0) === 0) {
      n++;
      const r = core.call(db, { role: 'main', cmd: 'page.setMemo', args: { id: pageId(0), memo: `書き続け ${n}` }, tx: `m:perf-busy:${n}` }, {});
      if (!r.ok) throw new Error(`page.setMemo が ${r.code} で返った`);
      Atomics.add(shared, 1, 1);
      if (n === 1) parentPort.postMessage('writing');
    }
  } finally {
    db.close();
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
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  const n = hit ? Number(hit.slice(name.length + 3)) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
};

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-perf-'));
  try {
    const t0 = performance.now();
    const pages = argOf('pages', 5000);
    const segments = argOf('segments', 60);
    const d = await measureDb({ pages, segments, dir });
    const m = await measureMigrate({ dir });
    const busy = await measureDraftWhileBusy({ dir });
    const w = measureWrites({ dir });
    const judged = judge([...d, ...m, ...w.filter((x) => Object.prototype.hasOwnProperty.call(BUDGETS, x.name))], budgetsFor(process.platform));
    console.log(`見本: ${pages} ページ × 発言 ${segments}（${pages * segments} 発言）＋ 2,000 ブロック・1 万発言のページ`);
    for (const x of judged) console.log(`${x.ok ? 'OK' : 'NG'} ${x.name} ${x.ms}ms（目安 ${x.budget}ms）`);
    for (const x of w) console.log(`書く時間 ${x.name} 中央値 ${x.ms}ms・p95 ${x.p95}ms（${x.bytes} バイト）`);
    console.log(`参考 1回目（一覧の1行を覚える前）: ${d.map((x) => `${x.name} ${x.first}ms`).join('・')}`);
    console.log(`参考 ${busy.name} 中央値 ${busy.ms}ms・p95 ${busy.p95}ms（計る間に DB が ${busy.dbWritesDuring} 回書いた。目安なし）`);
    const byName = Object.fromEntries(w.map((x) => [x.name, x]));
    const batchMs = suggestBatchMs(byName['write-1k-fsync'].p95);
    const draftFsync = suggestDraftFsync(byName['write-512k-fsync'].p95);
    console.log(`決め方: まとめ書きの間隔 ${batchMs}ms（設定の大きさの書き込み＋fsync の p95 ${byName['write-1k-fsync'].p95}ms。100ms までなら今の 350ms）`);
    console.log(`決め方: draft.json の fsync ${draftFsync ? '足す' : '足さない'}（512KB の書き込み＋fsync の p95 ${byName['write-512k-fsync'].p95}ms。20ms までなら足す）`);
    console.log(`計り全体 ${Math.round(performance.now() - t0)}ms（${process.platform} ${process.version}）`);
    console.log(`PERF_JSON ${JSON.stringify({ platform: process.platform, node: process.version, sample: { pages, segments }, judged, writes: w, reference: [busy], suggest: { batchMs, draftFsync } })}`);
    process.exitCode = exitCodeOf(judged);
  } finally {
    removeDir(dir);
  }
}

if (!isMainThread && workerData && workerData.role === WRITER_ROLE) {
  dbWriterLoop(workerData);
} else if (require.main === module) {
  main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exitCode = 1; });
}

module.exports = { BUDGETS, BUDGETS_WIN, budgetsFor, p95, median, judge, exitCodeOf, suggestBatchMs, suggestDraftFsync,
  measureDb, measureMigrate, measureDraftWhileBusy, measureWrites, sampleDbPage, insertSample };
