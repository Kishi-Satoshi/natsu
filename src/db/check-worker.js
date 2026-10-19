/*
 * check-worker.js — 議事録の DB のファイルを確かめる（第2a1回 ST9・RF11・F8・F12。worker_threads の中で動かす）
 *
 * quick_check と全文検索の integrity-check は同期で重いので、DB のプロセスの中の worker_threads で行う（snapshot.js の workerCheck が起こす）。
 * workerData = { natsuCheck: true, file } のときだけ確かめて、答えを1つ postMessage して終わる（接続は閉じてから答える）。
 * それ以外の読み込み（snapshot.js が isCorruptError を使う・偽の utilityProcess の worker の中で読まれる）では何もしない。
 *
 * checkFile({ sqlite, file }) → 'ok' | 符号 | { error: 符号 }
 *   'ok'                … quick_check が ok だけを返し、blocks_fts と segments_fts の integrity-check（rank 1 で中身の表とも比べる）が通った
 *   'quick-check'・'fts'・'corrupt' … 確かめが走って、壊れていると分かった（checkResult が corrupt にする）
 *   { error }           … 確かめが走れなかった（接続が開けない・掴まれている・読めない。checkResult が unavailable にする）
 *   答えに本文・パス・SQL の文は入れない（符号だけ）。
 *   確かめの接続は書ける接続で開く（FTS5 の integrity-check は INSERT の形なので、読み取り専用の接続では走らない）。
 *   確かめるのは自分の一時ファイル（控えの写し・戻す写し）か、DB のプロセスがもう開いている natsu.db（WAL の2つ目の接続）だけ。
 * isCorruptError(e) → boolean … node:sqlite の誤りの errcode の下位 8 ビットが 11（CORRUPT）・26（NOTADB）か、
 *   errcode が無いときに文が「malformed」「not a database」を含むか（ほかは全部「壊れた」ではない: F8）
 */
'use strict';

const { isMainThread, parentPort, workerData } = require('node:worker_threads');

const CORRUPT_CODES = [11, 26];   // SQLITE_CORRUPT（SQLITE_CORRUPT_VTAB 267 などの拡張も下位 8 ビットで）・SQLITE_NOTADB
const BUSY_MS = 5000;

function isCorruptError(e) {
  if (!e) return false;
  if (e.errcode !== undefined && e.errcode !== null) return Number.isInteger(e.errcode) && CORRUPT_CODES.includes(e.errcode & 0xff);
  return /malformed|not a database/i.test(String(e.message || ''));
}

const errName = (e) => {
  if (e && Number.isInteger(e.errcode)) return `sqlite-${e.errcode & 0xff}`;
  return (e && typeof e.code === 'string' && e.code) || 'unknown';
};

function checkFile({ sqlite, file }) {
  let db;
  try { db = new sqlite.DatabaseSync(file, { timeout: BUSY_MS }); } catch (e) { return { error: errName(e) }; }
  try {
    const rows = db.prepare('pragma quick_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') return 'quick-check';
    try {
      db.exec("insert into blocks_fts(blocks_fts, rank) values('integrity-check', 1)");
      db.exec("insert into segments_fts(segments_fts, rank) values('integrity-check', 1)");
    } catch (e) {
      // 合わない（CORRUPT_VTAB）・表が無い（SQLITE_ERROR 1: 議事録の DB の形でない）は壊れている。掴まれている・読めないは走れなかった
      if (isCorruptError(e) || (e && Number.isInteger(e.errcode) && (e.errcode & 0xff) === 1)) return 'fts';
      return { error: errName(e) };
    }
    return 'ok';
  } catch (e) {
    return isCorruptError(e) ? 'corrupt' : { error: errName(e) };
  } finally {
    try { db.close(); } catch (_) { /* 閉じ済み */ }
  }
}

if (!isMainThread && parentPort && workerData && workerData.natsuCheck === true) {
  let out;
  try { out = checkFile({ sqlite: require('node:sqlite'), file: workerData.file }); } catch (e) { out = { error: errName(e) }; }
  parentPort.postMessage(out);
}

module.exports = { checkFile, isCorruptError };
