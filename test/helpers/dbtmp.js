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
 * フォルダの名前には日本語と 𠮷（サロゲートの対）を入れる（RF1）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');
const core = require('../../src/db/core');

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

module.exports = { tmpDb, samplePage, jsonTwin, SEED_AT };
