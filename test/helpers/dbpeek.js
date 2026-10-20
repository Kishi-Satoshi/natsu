/*
 * dbpeek.js — 読み取り専用の接続で、一時フォルダの natsu.db を見る台（第2a1回 D-5a。D-5b〜D-7・M-2b〜M-4 も使う）
 *
 *   open(dataDir) → { db, listPages(), getPage(id), getTranscript(id), rawPage(id, { trashed }), metaKeys(), meta(key),
 *                     oplogCount(), bytesHave(text), close() }
 *     listPages()     … 一覧の行（今の store.listPages と同じ形。ゴミ箱と録音中の写しは出ない）
 *     getPage(id)     … 今の store.getPage と同じ形（markShortBlocks を当てた後。DB が作る rev と、2a1 では空の children を除く）。無ければ null
 *     getTranscript(id) … 今の store.getTranscript と同じ形の発言の配列
 *     rawPage(id)     … markShortBlocks の前の形（rev と空の children を除く）。今の JSON を読んだものと深く同じになるはず（移行の完全一致の定義）。
 *                       { trashed: true } でゴミ箱のページも返す
 *     metaKeys()      … meta の鍵の並び（名前の順）。meta(key) は値の JSON を読んだもの（無ければ undefined）
 *     oplogCount(tx?) … oplog の行の数（tx を渡せばその tx の行の数。D-7 で足す: M-2a の送り直しの確かめ）
 *     bytesHave(text) … natsu.db と -wal のバイトに text（UTF-8）があるか（消した文字が残っていないかを見る）
 *     close()         … 接続を閉じる（Windows で掴んだままにしない。テストは finally で呼ぶ）
 *   読む形は src/db/commands.js の読み手（アプリが読むのと同じもの）を使う。書かない。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite = require('node:sqlite');
const C = require('../../src/db/commands');

function strip(page) {
  if (!page) return null;
  const out = { ...page };
  delete out.rev;
  out.blocks = (out.blocks || []).map((b) => {
    const x = { ...b };
    if (Array.isArray(x.children) && x.children.length === 0) delete x.children;
    return x;
  });
  return out;
}

function open(dataDir) {
  const file = path.join(dataDir, 'natsu.db');
  if (!fs.existsSync(file)) throw new Error('dbpeek: natsu.db が無い');
  // timeout: アプリの DB のプロセスが書いている・落ちた後の WAL を直している間は、読み取り専用でも一瞬 SQLITE_BUSY になる。
  // アプリ自身の読み手（src/db/server.js の classify・core.js）と同じく待ってから読む（待たないと Windows の CI で「database is locked」）
  const db = new sqlite.DatabaseSync(file, { readOnly: true, timeout: 2000 });
  return {
    db,
    listPages: () => C.listPages(db),
    getPage: (id) => strip(C.readPage(db, id)),
    getTranscript: (id) => C.readSegments(db, id),
    rawPage: (id, { trashed = false } = {}) => strip(C.readRawPage(db, id, { trashed })),
    metaKeys: () => db.prepare('select key from meta order by key').all().map((r) => r.key),
    meta: (key) => {
      const r = db.prepare('select value from meta where key = ?').get(key);
      return r ? JSON.parse(r.value) : undefined;
    },
    oplogCount: (tx) => (tx === undefined ? db.prepare('select count(*) c from oplog').get().c
      : db.prepare('select count(*) c from oplog where tx = ?').get(String(tx)).c),
    bytesHave: (text) => {
      const needle = Buffer.from(String(text), 'utf8');
      return [file, `${file}-wal`].some((f) => fs.existsSync(f) && fs.readFileSync(f).indexOf(needle) >= 0);
    },
    close: () => { try { db.close(); } catch (_) { /* 閉じ済み */ } },
  };
}

module.exports = { open };
