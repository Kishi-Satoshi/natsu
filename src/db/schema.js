/*
 * schema.js — 議事録の DB の表の形と、版を1段ずつ上げる表 STEPS（第2a1回 ST2・ST3。純粋）
 *
 * STEPS[n] は版 n-1 から版 n へ上げる SQL。core.open が BEGIN IMMEDIATE の中で1段ずつ流し、user_version を n にする。
 * 出した版の SQL は変えない（後の版は STEPS[2] などを足す。第15回の page_snapshot は版 2 の表として足す）。
 *
 * 表の形 v1（計画 docs/plans/2026-10-19-2a1.md の「表の形 v1」）
 *   blocks   … ページの行（type 'page'。text は題名）とブロックの行。rid は全文検索が指す番号（明示しないと VACUUM で変わりうる）。
 *              id は頼む側が作る（p…・b…）。parent_id は NULL が最上位のページ（第5回で子のページ）、2a1 のブロックは全部ページを指す。
 *              ord は並びの鍵（keys.keyBetween）。rich は [{t, m}] の JSON（飾りが無ければ NULL）。attrs はそのほかの欄の JSON。
 *              fold は検索の欄（ページの行は searchFold(題名) || char(1) || searchFold(メモ)）。trashed_at はゴミ箱（ページの行だけ）
 *   segments … 発言。無かった欄は NULL（読むときに欄ごと出さない）。extra はそのほかの欄の JSON（speaker・src は第13回）
 *   oplog    … 1つの命令 = 1行（T4b）。(role, tx) で1回だけ効かせる。actor は me・claude・system・recovery・migration
 *   meta     … 鍵と値（jsonMigration・json:<ページの id>・reimportSkipped・lastSnapshot・cleanShutdown）
 *   blocks_fts・segments_fts … FTS5 の trigram の外部内容（content_rowid='rid'）。FTS5 の secure-delete を入れる（RF16:
 *              消した会議の文字の trigram のかけらを索引に残さない）。合わせるのは素の SQL の trigger だけ
 * 決まり: 表はどれも STRICT、索引に条件（WHERE）を付けない、表の定義・trigger・索引から JS の関数を呼ばない
 * （関数を登録していない素の接続でも、全文検索まで引ける）。SQL の文字は '…'。
 */
'use strict';

const V1 = `
CREATE TABLE blocks (
  rid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  page_id TEXT NOT NULL,
  parent_id TEXT,
  ord TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  rich TEXT,
  attrs TEXT NOT NULL DEFAULT '{}',
  fold TEXT NOT NULL DEFAULT '',
  rev INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  trashed_at TEXT
) STRICT;
CREATE INDEX blocks_page ON blocks(page_id, ord);
CREATE INDEX blocks_type ON blocks(type, created_at);
CREATE TABLE segments (
  rid INTEGER PRIMARY KEY,
  page_id TEXT NOT NULL,
  id TEXT NOT NULL,
  n INTEGER NOT NULL,
  at_ms INTEGER,
  duration_ms INTEGER,
  text TEXT NOT NULL DEFAULT '',
  fold TEXT NOT NULL DEFAULT '',
  failed INTEGER,
  extra TEXT,
  UNIQUE(page_id, id)
) STRICT;
CREATE INDEX segments_order ON segments(page_id, n);
CREATE TABLE oplog (
  seq INTEGER PRIMARY KEY,
  role TEXT NOT NULL,
  tx TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  page_id TEXT,
  ops TEXT NOT NULL,
  UNIQUE(role, tx)
) STRICT;
CREATE INDEX oplog_page ON oplog(page_id, seq);
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
CREATE VIRTUAL TABLE blocks_fts USING fts5(fold, content='blocks', content_rowid='rid', tokenize='trigram');
CREATE VIRTUAL TABLE segments_fts USING fts5(fold, content='segments', content_rowid='rid', tokenize='trigram');
INSERT INTO blocks_fts(blocks_fts, rank) VALUES('secure-delete', 1);
INSERT INTO segments_fts(segments_fts, rank) VALUES('secure-delete', 1);
CREATE TRIGGER blocks_fts_ai AFTER INSERT ON blocks BEGIN
  INSERT INTO blocks_fts(rowid, fold) VALUES (new.rid, new.fold);
END;
CREATE TRIGGER blocks_fts_ad AFTER DELETE ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, fold) VALUES ('delete', old.rid, old.fold);
END;
CREATE TRIGGER blocks_fts_au AFTER UPDATE OF fold ON blocks BEGIN
  INSERT INTO blocks_fts(blocks_fts, rowid, fold) VALUES ('delete', old.rid, old.fold);
  INSERT INTO blocks_fts(rowid, fold) VALUES (new.rid, new.fold);
END;
CREATE TRIGGER segments_fts_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, fold) VALUES (new.rid, new.fold);
END;
CREATE TRIGGER segments_fts_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, fold) VALUES ('delete', old.rid, old.fold);
END;
CREATE TRIGGER segments_fts_au AFTER UPDATE OF fold ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, fold) VALUES ('delete', old.rid, old.fold);
  INSERT INTO segments_fts(rowid, fold) VALUES (new.rid, new.fold);
END;
`;

const STEPS = Object.freeze({ 1: V1 });

module.exports = { STEPS };
