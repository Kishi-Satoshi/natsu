/*
 * dbtmp.js — 一時フォルダの議事録の DB を開いて、閉じて、消す台（第2a1回 D-2。D-3a〜D-7 で足す）
 *
 *   tmpDb() → { file, dir, open(opts), raw(opts), seed(page, segments), done() }
 *     open(opts) … core.open({ sqlite, file, ...opts })。開いた接続を覚える
 *     raw(opts)  … 関数を1つも登録していない素の接続（opts は DatabaseSync にそのまま渡す。既定は書ける接続）
 *     seed(page, segments) … 最後に open した接続に、commands.putPageRows で1ページを書く（D-3a。中身を変えずにそのまま入れる。oplog は書かない）
 *     done()     … 覚えた接続を全部閉じてからフォルダを消す（Windows で掴んだままにしない）
 *   samplePage(id) → { page, segments }（D-3a）… 見出し・箇条書き（出典あり・短い行・知らない欄）・ToDo（担当・期限）・経路・
 *     一時停止の印・知らない欄 extraField を持つページと、認識に失敗した区間を含む発言。page の中に segments は入れない。
 *     種の時刻は決まった 2026-10-19T00:00:00.000Z。呼ぶたびに新しい写しを返す
 *   jsonTwin({ labels }) → { dir, store, seed(page, segments), call(cmd, args), done() }（D-3a）… 一時フォルダの今の JSON の保存
 *     （src/store.js を、ほかのテストと共有しない別の読み込みで）と json-backend。seed は同じ JSON をそのまま書いて索引を作り直す。
 *     labels の既定は { groq: 'Groq（無料枠）' }（DB の側のテストが ctx.labels に渡すものと同じ）
 *   searchCorpus() → 30 個の { page, segments }（D-4）… 検索の比べの見本。題名・要約（ブロック）・メモ・文字起こしに検索の語を散らす
 *     （短い語・全角・句読点をまたぐ語・文法の文字・メモにだけある語・% や \ や _ を含む行・サロゲート・カタカナ・無題のページ）。
 *     createdAt はページごとに違い、返す並び（= 入れる順）は createdAt の順と違える。ブロックの ID は表全体で重ならない。
 *     比べから外す意図した違い（ブロックをまたぐ一致・要約 2 万字とメモ 2 千字の打ち切り）に当たる並びは入れない
 *   oldBuildData({ pages, bom, broken, badId, unreadable }) → { dataDir, ids, rawPage(id), writePage(page, segments), oldBuild(fn), done() }（D-5a。oldBuild は D-5b）
 *     … 0.6.0 と同じ src/store.js（ほかのテストと共有しない別の読み込み）で、古い版の JSON の data を作る。
 *     pages 個の普通のページ（知らない欄・経路・一時停止・出典・担当と期限・認識に失敗した区間・話者の欄）と、
 *     bom 個の BOM 付き UTF-8 に書き直したページ（どちらも ids に入り、文字起こしは 3 区間）。
 *     broken 個の壊れたページのファイル、badId 個のファイル名と page.id が違うページ、unreadable 個の読めないもの
 *     （pages/ の中の <id>.json という名前のフォルダ。どの OS でも読めない）は ids に入れない。
 *     rawPage(id) は元のファイルを退けない読み方で読んだもの（markShortBlocks の前の形）。writePage はそのままの形で書く
 *     oldBuild(fn) は fn(store) を呼ぶ（D-5b。移行の後に古い版がまた動いて JSON を書いた、を作る。store は同じ data を開いた 0.6.0 の store.js）
 *   snapshotTree(dir) → { 相対パス（'/' 区切り）: sha256 | 'dir' }… フォルダの中の全部の名前と中身（元のファイルが変わらないことを見る）
 *   tmpData({ pages }) → { dir, dataDir, file, db, ids, close(), addOplog(rows), done() }（D-6）
 *     … <一時フォルダ>/data に core.open で natsu.db を作り、pages 個の見本のページ（samplePage の中身。ID は pd0001…、ブロックは pd0001b1…）を
 *     main の meeting.finalize で書く（種の oplog の時刻は決まった 2026-10-19T00:00:00.000Z）。db は開いたままの接続。
 *     close() は db を閉じる（壊す・戻すテストの前に。2回呼んでもよい）。
 *     addOplog([{ at, action, purge? }]) は oplog に行を足す（role main・actor system・tx は m:test-<番号>）。
 *     purge が真なら action のまま ops に {"op":"purge"} を入れる（取り消しの印と同じ形）。そうでなければ ops は []。
 *     done() は開いた接続を閉じてからフォルダを消す
 * フォルダの名前には日本語と 𠮷（サロゲートの対）を入れる（RF1）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');
const core = require('../../src/db/core');

const crypto = require('node:crypto');

const SEED_AT = '2026-10-19T00:00:00.000Z';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-db-議事録𠮷-'));
  const file = path.join(dir, 'natsu.db');
  const opened = [];
  let last = null;   // 最後に core.open した接続（seed が書く先）
  return {
    file,
    dir,
    open(opts = {}) {
      const r = core.open({ sqlite, file, ...opts });
      if (r.db) { opened.push(r.db); last = r.db; }
      return r;
    },
    raw(opts = {}) {
      const d = new sqlite.DatabaseSync(file, opts);
      opened.push(d);
      return d;
    },
    seed(page, segments = []) {
      if (!last) throw new Error('dbtmp.seed: 先に open する');
      const { putPageRows } = require('../../src/db/commands');
      last.exec('BEGIN IMMEDIATE');
      try {
        putPageRows(last, page, segments, { now: () => new Date(SEED_AT) });
        last.exec('COMMIT');
      } catch (e) {
        try { last.exec('ROLLBACK'); } catch (_) { /* 戻せなくても投げる */ }
        throw e;
      }
    },
    done() {
      for (const d of opened) { try { d.close(); } catch (_) { /* 閉じ済み */ } }
      opened.length = 0;
      last = null;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function samplePage(id = 'pa1') {
  const page = {
    id,
    title: '定例会議（見本）',
    date: '2026-10-19',
    durationSec: 60,
    memo: '',
    blocks: [
      { id: 'b1', type: 'heading', text: '決めたこと', level: 2 },
      { id: 'b2', type: 'bullet', text: '来月の予算案の作成を担当Aが進める', cites: ['s2'] },
      { id: 'b3', type: 'bullet', text: '了解', cites: [] },
      { id: 'b4', type: 'todo', text: '見積書を月末までに先方へ送る', checked: false, assignee: '担当A', dueRaw: '月末', due: '2026-10-31', dueApprox: true, cites: ['s3'] },
      { id: 'b5', type: 'bullet', text: '次回は来週の同じ時間に集まることにした', cites: [], extraField: 'ブロックの知らない欄' },
      { id: 'b6', type: 'todo', text: '議事録を共有フォルダに置いておく', checked: false, assignee: '担当C', dueRaw: '', due: '', dueApprox: false, cites: [] },
    ],
    createdAt: SEED_AT,
    updatedAt: SEED_AT,
    recovered: false,
    summaryError: '',
    meetingType: 'general',
    citeStat: { linked: 9, total: 9 },
    route: { stt: { cloud: 3, local: 0, provider: 'groq' }, localOnly: false, summary: { by: 'claude-code' } },
    pauses: [{ atMs: 30000, ms: 5000, why: 'user' }],
    extraField: 'ページの知らない欄',
  };
  const segments = [
    { id: 's1', atMs: 0, durationMs: 20000, text: '（この区間の認識に失敗: 見本）', failed: true },
    { id: 's2', atMs: 20000, durationMs: 20000, text: '来月の予算案の作成は担当Aさんが進めることにしました' },
    { id: 's3', atMs: 40000, durationMs: 20000, text: '見積書は月末までに先方へ送る予定です', speaker: '話者1' },
  ];
  return { page, segments };
}

// src/store.js はフォルダを覚えるので、ほかのテストと共有しない別の読み込みにする（読んだ後は元の読み込みに戻す）
function isolatedStore() {
  const p = require.resolve('../../src/store');
  const saved = require.cache[p];
  delete require.cache[p];
  try { return require(p); } finally {
    if (saved) require.cache[p] = saved; else delete require.cache[p];
  }
}

function jsonTwin({ labels = { groq: 'Groq（無料枠）' } } = {}) {
  const J = require('../../src/jsonfile');
  const { makeJsonBackend } = require('../../src/db/json-backend');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-json-議事録𠮷-'));
  const store = isolatedStore();
  const data = store.init(dir);
  const jb = makeJsonBackend(store, { labels });
  return {
    dir,
    store,
    async seed(page, segments = []) {
      J.writeJsonFile(path.join(data, 'pages', `${page.id}.json`), page);
      J.writeJsonFile(path.join(data, 'transcripts', `${page.id}.json`), { id: page.id, segments });
      store.init(dir);   // 索引を pages/ から作り直す（reconcile）
    },
    call(cmd, args) { return jb.call(cmd, args); },
    done() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// 検索の比べの見本（D-4）。[題名, ブロックの文の並び, メモ, 発言の文の並び]
const CORPUS = [
  ['週次の定例会議', ['決めたこと', '見積書を来週までに作る', '予算案の作成を担当Aが進める'], '', ['では、予算案の、作成を始めます', '見積は来週です']],
  ['AI戦略の打ち合わせ', ['話したこと', 'ＡＩ戦略の資料を共有する', '生成AIの使い方を整理する'], '', ['AI戦略について話します', '社内でＡＩを試します']],
  ['データベースの設計', ['表の形を決めた', '索引を2つ作る'], 'でーたは後で見る', ['データベースの移行は来月です', '表の名前を決めましょう']],
  ['来期の予算', ['人件費を見直す', '広告費は据え置く'], '会議室Bを押さえた', ['来期の予算は少し増やします']],
  ['', ['録音だけの会議の要点'], '', ['試しの録音です']],
  ['割引の相談', ['達成率は100%を目指す', '割引は5%まで'], '', ['割引は5%です', '100%の確認が要ります']],
  ['記法の確認', ['改行は \\n と書く', 'file_name の形にそろえる'], '', ['バックスラッシュ \\ を使います', 'アンダースコア _ は消えます']],
  ['昼の打ち合わせ', ['𠮷野さんに連絡する', '店を決める'], '', ['𠮷野家のご家族にも昼食の案内を送ります', '𠮷野さんも来ます']],
  ['端末の検討', ['Android の端末を2台買う', '見積を取る'], '', ['Androidで試します']],
  ['採用の面談', ['候補者の評価をまとめる'], 'メモだけの語をここに書いた', ['よろしくお願いします']],
  ['月次の会議', ['売上の報告', '会議の時間を短くする'], '', ['今月の会議を始めます', '予定どおりです']],
  ['品質の振り返り', ['不具合の件数を数える'], '次回は品質の会議で話す', ['不具合が3件ありました']],
  ['引き継ぎ', ['担当を交代する', '資料を移す'], '', ['予算の話は次回にします']],
  ['研修の準備', ['教材を印刷する'], '', ['研修の会議室を取りました']],
  ['朝会', ['昨日やったこと', '今日やること'], '', ['おはようございます', '今日は会議が2つあります']],
  ['顧客への提案', ['提案書の見積を直す'], '', ['先方の会議は木曜です']],
  ['社内報の企画', ['記事の題を3つ出す'], '', ['写真を集めます']],
  ['備品の購入', ['椅子を4脚買う'], '予備の机も見る', ['在庫を確かめます']],
  ['旅費の精算', ['領収書を集める'], '', ['精算は月末までです']],
  ['開発の進み具合', ['画面の作り直し', 'テストを足す'], '', ['ＡＩの要約を試しました', '会議の録音から作ります']],
  ['安全の点検', ['消火器の場所を確かめる'], '', ['点検は年に2回です']],
  ['年度の計画', ['目標を3つに絞る', '予算の配分を決める'], '', ['計画の会議をもう一度開きます']],
  ['広報の相談', ['発表の日を決める'], '', ['記者向けの資料を作ります']],
  ['契約の見直し', ['更新の時期を確かめる'], '', ['契約の見積を取り直します']],
  ['情報の共有', ['共有フォルダを整理する'], '', ['資料はフォルダに置きます']],
  ['新人の歓迎', ['歓迎の会の店を探す'], '', ['会場は𠮷野家のお宅ではない所にします']],
  ['設備の更新', ['空調を入れ替える'], '', ['工事は週末です']],
  ['問い合わせの整理', ['よくある質問をまとめる'], '', ['質問は20件ありました']],
  ['評価の面談', ['自己評価を書く'], '', ['面談は30分です']],
  ['振り返りの会議', ['良かったこと', '直すこと'], '', ['次の会議までに直します']],
];
const BLOCK_TYPES = ['heading', 'bullet', 'todo'];

function searchCorpus() {
  const out = [];
  // 入れる順を createdAt の順（i の順）と違える（7 と 30 は互いに素なので全部を1回ずつ通る）
  for (let k = 0; k < CORPUS.length; k++) {
    const i = (k * 7) % CORPUS.length;
    const [title, texts, memo, says] = CORPUS[i];
    const id = `ps${String(i + 1).padStart(2, '0')}`;
    const at = new Date(Date.UTC(2026, 8, 1 + i, 9)).toISOString();
    const page = {
      id, title, date: at.slice(0, 10), durationSec: 60, memo,
      blocks: texts.map((text, n) => ({ id: `${id}b${n + 1}`, type: BLOCK_TYPES[n % 3], text, cites: [] })),
      createdAt: at, updatedAt: at, recovered: false, summaryError: '', meetingType: 'general',
    };
    const segments = says.map((text, n) => ({ id: `s${n + 1}`, atMs: n * 20000, durationMs: 20000, text }));
    out.push({ page, segments });
  }
  return out;
}

// 古い版（0.6.0）の JSON の data（D-5a・D-5b）
function oldBuildData({ pages = 3, bom = 0, broken = 0, badId = 0, unreadable = 0 } = {}) {
  const J = require('../../src/jsonfile');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-old-議事録𠮷-'));
  const store = isolatedStore();
  const dataDir = store.init(userData);
  const pageFile = (id) => path.join(dataDir, 'pages', `${id}.json`);
  const transcriptFile = (id) => path.join(dataDir, 'transcripts', `${id}.json`);
  const ids = [];
  const make = (i) => {
    const segments = [
      { id: 's1', atMs: 0, durationMs: 20000, text: '（この区間の認識に失敗: 見本）', failed: true },
      { id: 's2', atMs: 20000, durationMs: 20000, text: `第${i + 1}回の予算案の作成は担当Aさんが進めます` },
      { id: 's3', atMs: 40000, durationMs: 20000, text: '見積書は月末までに先方へ送る予定です', speaker: '話者1' },
    ];
    const page = store.createPage({
      title: `第${i + 1}回の定例会議（𠮷）`,
      date: `2026-09-${String(i + 1).padStart(2, '0')}`,
      durationSec: 600 + i,
      memo: i % 2 ? '' : `メモの文 ${i + 1}`,
      blocks: [
        { id: store.newId('b'), type: 'heading', text: '決めたこと', cites: [] },
        { id: store.newId('b'), type: 'bullet', text: '来月の予算案の作成を担当Aが進める', cites: ['s2'] },
        { id: store.newId('b'), type: 'bullet', text: '了解', cites: [] },
        { id: store.newId('b'), type: 'todo', text: '見積書を月末までに先方へ送る', checked: false, assignee: '担当A', dueRaw: '月末', due: '2026-10-31', dueApprox: true, cites: ['s3'] },
        { id: store.newId('b'), type: 'bullet', text: '次回は来週の同じ時間に集まる', cites: [], extraField: 'ブロックの知らない欄' },
      ],
      segments,
      createdAt: new Date(Date.UTC(2026, 8, 1 + i, 9)).toISOString(),
      recovered: i === 1,
      route: { stt: { cloud: 2, local: 1, provider: 'groq' }, localOnly: false, summary: { by: 'claude-code' } },
      pauses: [{ atMs: 30000, ms: 5000, why: 'user' }],
    });
    page.meetingType = 'general';
    page.extraField = 'ページの知らない欄';
    store.savePage(page);
    ids.push(page.id);
    return page.id;
  };
  for (let i = 0; i < pages; i++) make(i);
  for (let i = 0; i < bom; i++) {
    const id = make(pages + i);
    fs.writeFileSync(pageFile(id), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(pageFile(id))]));
  }
  for (let i = 0; i < broken; i++) {
    const id = `pbroken${String(i + 1).padStart(4, '0')}`;
    fs.writeFileSync(pageFile(id), `{"id":"${id}","title":"壊れた`);
  }
  for (let i = 0; i < badId; i++) {
    const id = `pbadid${String(i + 1).padStart(4, '0')}`;
    J.writeJsonFile(pageFile(id), { id: `pother${String(i + 1).padStart(4, '0')}`, title: 'ファイル名と違う ID', blocks: [] });
    J.writeJsonFile(transcriptFile(id), { id, segments: [{ id: 's1', atMs: 0, text: '数えない' }] });
  }
  for (let i = 0; i < unreadable; i++) fs.mkdirSync(pageFile(`punread${String(i + 1).padStart(4, '0')}`));
  return {
    dataDir,
    ids,
    rawPage(id) {
      const r = J.readJsonFile(pageFile(id));
      if (r.state !== 'ok') throw new Error(`oldBuildData.rawPage: ${r.state}`);
      return r.value;
    },
    writePage(page, segments) {
      J.writeJsonFile(pageFile(page.id), page);
      if (segments !== undefined) J.writeJsonFile(transcriptFile(page.id), { id: page.id, segments });
    },
    oldBuild(fn) { return fn(store); },
    done() { fs.rmSync(userData, { recursive: true, force: true }); },
  };
}

// data フォルダに natsu.db と見本のページ（D-6。D-7 で足す）
function tmpData({ pages = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-data-議事録𠮷-'));
  const dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir);
  const file = path.join(dataDir, 'natsu.db');
  const r = core.open({ sqlite, file });
  if (r.state !== 'ok') { fs.rmSync(dir, { recursive: true, force: true }); throw new Error(`tmpData: 開けない ${r.code}`); }
  const db = r.db;
  const ids = [];
  const now = () => new Date(SEED_AT);
  let n = 0;
  let closed = false;
  try {
    for (let i = 0; i < pages; i++) {
      const id = `pd${String(i + 1).padStart(4, '0')}`;
      const { page, segments } = samplePage(id);
      delete page.id;
      page.title = `${page.title} ${i + 1}`;
      for (const blk of page.blocks) blk.id = `${id}${blk.id}`;   // ブロックの ID は表全体で重ならない
      const out = core.call(db, { role: 'main', cmd: 'meeting.finalize', args: { pageId: id, page, segments }, tx: `m:seed-${id}` }, { now });
      if (!out.ok) throw new Error(`tmpData: 種を書けない ${out.code}`);
      ids.push(id);
    }
  } catch (e) {
    try { db.close(); } catch (_) { /* 閉じ済み */ }
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const close = () => { if (!closed) { closed = true; db.close(); } };
  return {
    dir,
    dataDir,
    file,
    db,
    ids,
    close,
    addOplog(rows) {
      const put = db.prepare('insert into oplog(role, tx, at, actor, action, page_id, ops) values (?, ?, ?, ?, ?, ?, ?)');
      for (const row of rows) {
        n += 1;
        const pageId = row.pageId || ids[0] || null;
        const ops = row.purge ? [{ op: 'purge', id: pageId }] : [];
        put.run('main', `m:test-${String(n).padStart(6, '0')}`, row.at, 'system', row.action, pageId, JSON.stringify(ops));
      }
    },
    done() {
      try { close(); } catch (_) { /* 閉じ済み */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function snapshotTree(dir) {
  const out = {};
  const walk = (abs, rel) => {
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[r] = 'dir'; walk(a, r); } else out[r] = crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex');
    }
  };
  walk(dir, '');
  return out;
}

module.exports = { tmpDb, tmpData, samplePage, jsonTwin, searchCorpus, oldBuildData, snapshotTree, SEED_AT };
