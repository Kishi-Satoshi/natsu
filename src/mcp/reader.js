'use strict';
// MCP の読み手（0.10.0 Task R-1。計画 docs/plans/2026-10-20-100.md の「受け渡す名前と形」）。
// 道具の呼び出しごとに natsu.db を読み取りだけ（readOnly と query_only の2つの守り）で開き、どの道でも finally で閉じる
// （呼び出しの間は何も開いていない: RF62。戻し・移行・控えの回転・終わるときのチェックポイントを止めない）。
// 戻しと移行の印 natsu.db.lock（snapshot.withLock が書く）を開く前と開いた後に見る（RF18）。lock は消さない（書かない）。
// 表の形の版は core.open の答えだけで決める（user_version を読み直さない: 決めたこと 24）。
// 触るファイルは dataDir の natsu.db と natsu.db.lock だけ（下書き・設定・履歴・控えを開かない: 決めたこと 65）。
// 投げた文・パスは返さない（符号だけ: 決めたこと 32・64）。
const os = require('node:os');
const path = require('node:path');
const nodeFs = require('node:fs');
const core = require('../db/core');

const DB_NAME = 'natsu.db';
const LOCK_NAME = 'natsu.db.lock';
const LOCK_STALE_MS = 10 * 60 * 1000;   // これより古い lock は落ちた跡（NaTsu を起動すると DB のプロセスが消す: 決めたこと 13）

// lock の有る無しと古さ: '' は無い。書く形は「pid <番号>\nat <ISO>\n」。時刻が読めなければファイルの更新時刻で決める
function lockState(fs, file, nowMs) {
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return '';
  }
  let at = NaN;
  if (typeof text === 'string') {
    const m = /^at (\S+)\s*$/m.exec(text);
    if (m) at = Date.parse(m[1]);
  }
  if (!Number.isFinite(at)) {
    try { at = fs.statSync(file).mtimeMs; } catch (e) {
      if (e && e.code === 'ENOENT') return '';
      at = nowMs;   // あるのに読めない: 新しいものとして扱う（開かない）
    }
  }
  return nowMs - at > LOCK_STALE_MS ? 'stale-lock' : 'locked';
}

// 読む DB のフォルダ。NATSU_DATA_DIR は絶対のパスのときだけ（相対・空は無いものとして既定の場所: F16）
function dataDirOf(env = process.env, home = os.homedir()) {
  const e = env && typeof env === 'object' ? env : {};
  const own = typeof e.NATSU_DATA_DIR === 'string' ? e.NATSU_DATA_DIR : '';
  if (own && path.isAbsolute(own)) return own;
  const appData = typeof e.APPDATA === 'string' && e.APPDATA && path.isAbsolute(e.APPDATA) ? e.APPDATA : path.join(home, 'AppData', 'Roaming');
  return path.join(appData, 'natsu', 'data');
}

// withReader({ sqlite, dataDir, fs, now, onOpen, onClose }, fn) → { ok: true, value } か { ok: false, code }
//   code: no-db・locked・stale-lock・old・newer・busy・open・read。onOpen・onClose はテストだけが渡す（開いた数と閉じた数）
function withReader({ sqlite, dataDir, fs = nodeFs, now = Date.now, onOpen, onClose } = {}, fn) {
  const file = path.join(dataDir, DB_NAME);
  const lock = path.join(dataDir, LOCK_NAME);
  if (!fs.existsSync(file)) return { ok: false, code: 'no-db' };   // 読み取りの接続は無いファイルを作らないが、符号を分ける
  const before = lockState(fs, lock, now());
  if (before) return { ok: false, code: before };
  const r = core.open({ sqlite, file, readOnly: true });
  if (!r.db) return { ok: false, code: r.code === 'empty' ? 'old' : r.code === 'busy' ? 'busy' : 'open' };
  const db = r.db;
  if (onOpen) onOpen(db);
  try {
    if (r.state === 'newer') return { ok: false, code: 'newer' };
    db.exec('pragma query_only = ON');
    if (lockState(fs, lock, now())) return { ok: false, code: 'locked' };   // 開く間に戻しや移行が始まった
    let value;
    try { value = fn(db); } catch (_) { return { ok: false, code: 'read' }; }
    return { ok: true, value };
  } finally {
    try { db.close(); } catch (_) { /* 閉じ済み */ }
    if (onClose) onClose(db);
  }
}

module.exports = { withReader, dataDirOf, LOCK_STALE_MS, DB_NAME, LOCK_NAME };
