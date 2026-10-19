/*
 * snapshot.js — 議事録の DB の控え・壊れたときの退けと戻し・natsu.db.lock・ネットワークの場所の判定（第2a1回 ST9・RF11・RF18・P9。純粋）
 *
 * Electron を読まない。node:sqlite は引数で受ける。控えは <data>/backup/natsu-<時刻>-<kind>.db.gz
 * （時刻は toISOString の : と . を - にしたもの。kind は daily・weekly・migration・upgrade）。
 *
 * take({ sqlite, db, dataDir, kind, now, runCheck, fs, track, log }) → { ok, file, check: 'ok' | 符号 }
 *   backup() で <名前>.db.raw.tmp に写し → 自分の接続で journal_mode を DELETE にして閉じる（1つのファイルにする。track(接続) はテストだけ）
 *   → runCheck（既定は check-worker.js の worker。worker が終わってから答えるので、確かめた接続はもう閉じている）
 *   → ok なら gzipSync で縮めて <名前>.db.gz.tmp に書き、fsync してから <名前>.db.gz に名前を変える（半端な .gz を控えとして数えない）。
 *   ok でなければ縮めずに消す（確かめ済みだけを残す。check は runCheck の符号、走れなければ 'unavailable'）。写せなければ check 'io'。投げない。
 *   kind 'daily' でも、その週（UTC の月曜はじまり）に weekly がまだ無ければ weekly にする（最初の控えはいつも weekly）。
 *   take を同時に2つ走らせない（DB のプロセスの中で1つずつ）。始めに、走っていない take の残した .tmp を消す。
 * rotate({ dataDir, now, fs, log }) → 消した控えの名前の配列。daily は新しい 3、weekly は新しい 1、upgrade は新しい 2 を残し、migration は全部残す
 *   （1.x の間）。消せない控え（掴まれている EPERM・EBUSY ほか）は log に符号だけ書いて次へ（投げない。次に回したときに消す）。now は使わない
 *   （並びは名前の時刻）。
 * oldestKeptAt({ dataDir, fs }) → 残っている daily・weekly の控えのうち最も古い時刻（ISO）| null。oplog を消す境
 *   （migration・upgrade は境にしない。いつまでも残るので、入れると oplog を1行も消せない）。
 * pruneOplog({ db, before }) → 消した行の数。at が before（ISO か Date）より前の oplog の行を消す。ops に purge の操作がある行
 *   （取り消しの印: commands.isPurged が見るもの）は残す。before が無ければ何もしない。
 * recover({ sqlite, dataDir, now, fs, runCheck, waits, log, reimport }) → { ok: true, from, brokenAs, reimported } | { ok: false, code: 'no-snapshot' | 'busy' }
 *   withLock の中で: 控えを新しい順に1つずつ natsu.db.restoring へ広げて確かめ、ok の最初のものを選ぶ（広げられない半端な .gz・
 *   確かめの通らない・走れない控えは飛ばす。選べなければ natsu.db に触れずに no-snapshot）→ ここで初めて natsu.db と -wal・-shm・-journal を
 *   natsu.db.broken-<時刻>（と同じ後ろの名前）へ名前を変えて退ける（消さない。natsu.db が無ければ残りの -wal などだけ退ける:
 *   古い -wal を戻した DB に当てないため）→ natsu.db.restoring を natsu.db にする。名前を変えられなければ waits の順に待ってやり直し、
 *   だめなら動かしたものを元に戻し、natsu.db.restoring だけ消して busy（natsu.db は1バイトも変えない）。
 *   戻せたら core.open で開いて D-5b の reimport を回して閉じる（reimport: false で飛ばす。reimported はその答え。開けない・投げたら null）。
 *   from は選んだ控えの時刻（知らせ D6 の「抜けたかもしれない期間」）。brokenAs は退けた natsu.db の名前（無かったら null）。
 *   控えの一覧が読めない・自分の一時ファイルを消せないなど、ほかの失敗も投げずに busy で返す。
 * classifyOpenError(e) → 'corrupt'（SQLITE_CORRUPT・SQLITE_NOTADB だけ）| 'unavailable'（掴まれている・開けない・権限ほか全部: F8・F12）
 * checkResult(r) → runCheck の答えを 'ok' | 'corrupt'（確かめが走って ok 以外）| 'unavailable'（走れなかった: { error } ほか）
 * workerCheck({ file, timeoutMs }) → runCheck の既定。check-worker.js を worker_threads で起こし、worker が終わってから答えを返す。
 *   起きない・投げた・答えずに終わった・時間切れは { error }（checkResult が unavailable にする）。
 * withLock(dataDir, fn, { fs, log }) → fn の答え（Promise なら終わるのを待ってから）。natsu.db.lock（pid と時刻の2行の文字。本文・パスは書かない）を
 *   作ってから fn を呼び、終わったら（投げても）消す。消せなければ log に書くだけ（残った lock は次の起動の D-7 が消す）。
 * listBackups({ dataDir, fs }) → [{ name, at, ms, kind }]（古い順。名前の形の合うものだけ。.tmp は入らない）
 * isNetworkPath(p) → \\server\share（と \\?\UNC\…）の形なら真（P9。\\?\C:\ と \\.\ は手元の場所）
 * RENAME_WAITS_LONG … 戻すときに、ほかのプロセスが閉じるのを待つ間（合わせて約 6.3 秒）
 */
'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Worker } = require('node:worker_threads');
const { isCorruptError } = require('./check-worker');
const core = require('./core');
const M = require('./migrate');

const DB_NAME = 'natsu.db';
const BACKUP_DIR = 'backup';
const LOCK_NAME = 'natsu.db.lock';
const RESTORING = `${DB_NAME}.restoring`;
const SIDECARS = ['-wal', '-shm', '-journal'];
const KINDS = ['daily', 'weekly', 'migration', 'upgrade'];
const KEEP = Object.freeze({ daily: 3, weekly: 1, upgrade: 2 });   // migration は回さない（1.x の間残す）
const NAME_RE = /^natsu-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-(daily|weekly|migration|upgrade)\.db\.gz$/;
const TMP_RE = /^natsu-.*\.tmp(-wal|-shm|-journal)?$/;
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_WAITS_LONG = [100, 200, 400, 800, 1600, 3200];
const RENAME_WAITS_SHORT = [20, 40, 60, 80, 100, 200];
const CHECK_WORKER = path.join(__dirname, 'check-worker.js');
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const inProgress = new Set();   // 走っている take の一時ファイル（始めの片付けで消さない）

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = (d) => d.toISOString().replace(/[:.]/g, '-');
const unstamp = (s) => s.replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1:$2:$3.$4Z');
const codeOf = (e) => (e && typeof e.code === 'string' && e.code) || 'unknown';
const noop = () => {};

function exists(fs, p) {
  try { fs.lstatSync(p); return true; } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
    throw e;
  }
}

function writeSynced(fs, file, buf) {
  const fd = fs.openSync(file, 'w');
  try {
    fs.writeFileSync(fd, buf);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function fsyncDir(fs, dir) {
  // Windows ではフォルダを開けない。確定の順を強めるだけなので、できなければ飛ばす
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch (_) { /* できる OS だけ */ }
}

// 自分の一時ファイルと、その -wal・-shm・-journal を消す（あるものだけ。無いものに触れない）
function dropOwn(fs, file) {
  for (const s of ['', ...SIDECARS]) {
    if (!exists(fs, file + s)) continue;
    try { fs.unlinkSync(file + s); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  }
}

// 名前を変える。掴まれていれば waits の順に待ってやり直す。だめなら false（投げない）
async function renameWaiting(fs, from, to, waits) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return true; } catch (e) {
      if (e && BUSY.has(e.code) && i < waits.length) { await sleep(waits[i]); continue; }
      return false;
    }
  }
}

// ---------------------------------------------------------------- 控えの一覧
function listBackups({ dataDir, fs = nodeFs } = {}) {
  let names;
  try { names = fs.readdirSync(path.join(dataDir, BACKUP_DIR)); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
    throw e;
  }
  const out = [];
  for (const name of names) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const at = unstamp(m[1]);
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) continue;
    out.push({ name, at: new Date(ms).toISOString(), ms, kind: m[2] });
  }
  return out.sort((a, b) => a.ms - b.ms || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// その時刻の週の始まり（UTC の月曜 0 時）
function weekStart(ms) {
  const d = new Date(ms);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return day - ((d.getUTCDay() + 6) % 7) * DAY_MS;
}

// ---------------------------------------------------------------- 確かめ
function classifyOpenError(e) {
  return isCorruptError(e) ? 'corrupt' : 'unavailable';
}

function checkResult(r) {
  if (r === 'ok') return 'ok';
  if (typeof r === 'string' && r) return 'corrupt';
  return 'unavailable';
}

function workerCheck({ file, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let w;
    try { w = new Worker(CHECK_WORKER, { workerData: { natsuCheck: true, file } }); } catch (_) { resolve({ error: 'worker' }); return; }
    let answer;
    const timer = setTimeout(() => { answer = { error: 'timeout' }; w.terminate().catch(noop); }, timeoutMs);
    w.on('message', (m) => { if (answer === undefined) answer = m; });
    w.on('error', () => { if (answer === undefined) answer = { error: 'worker' }; });
    // worker が終わってから答える（確かめた接続は worker の中で閉じ、worker ごと無くなっている）
    w.on('exit', () => { clearTimeout(timer); resolve(answer === undefined ? { error: 'worker' } : answer); });
  });
}

// ---------------------------------------------------------------- 控えを取る
function cleanTemps(fs, dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return; }
  for (const n of names) {
    const p = path.join(dir, n);
    if (!TMP_RE.test(n) || inProgress.has(p)) continue;
    try { fs.unlinkSync(p); } catch (_) { /* 次の take でもう一度 */ }
  }
}

async function take({ sqlite, db, dataDir, kind, now = () => new Date(), runCheck = workerCheck, fs = nodeFs, track, log = noop } = {}) {
  if (!KINDS.includes(kind)) throw new Error('snapshot.take: kind が違う');
  const dir = path.join(dataDir, BACKUP_DIR);
  const at = now();
  let k = kind;
  const mine = [];   // この take の一時ファイル（終わったら消す）
  try {
    fs.mkdirSync(dir, { recursive: true });
    if (k === 'daily') {
      const week = weekStart(at.getTime());
      if (!listBackups({ dataDir, fs }).some((b) => b.kind === 'weekly' && weekStart(b.ms) === week)) k = 'weekly';
    }
    const base = path.join(dir, `natsu-${stamp(at)}-${k}`);
    const raw = `${base}.db.raw.tmp`;
    const gzTmp = `${base}.db.gz.tmp`;
    mine.push(raw, gzTmp);
    for (const p of mine) for (const s of ['', ...SIDECARS]) inProgress.add(p + s);
    cleanTemps(fs, dir);
    await sqlite.backup(db, raw);
    // 写しは WAL のまま。自分の接続で DELETE にして1つのファイルにし、確かめの前に必ず閉じる
    const c = new sqlite.DatabaseSync(raw);
    if (typeof track === 'function') track(c);
    try { c.prepare('pragma journal_mode = DELETE').get(); } finally { c.close(); }
    const answer = await runCheck({ file: raw });
    if (answer !== 'ok') {
      const check = typeof answer === 'string' && answer ? answer : 'unavailable';
      log(`DB: 控え ${k}・確かめ NG`);
      return { ok: false, file: null, check };
    }
    writeSynced(fs, gzTmp, zlib.gzipSync(fs.readFileSync(raw)));
    const file = `${base}.db.gz`;
    if (!(await renameWaiting(fs, gzTmp, file, RENAME_WAITS_SHORT))) throw Object.assign(new Error('rename'), { code: 'rename' });
    fsyncDir(fs, dir);
    log(`DB: 控え ${k}・確かめ ok`);
    return { ok: true, file, check: 'ok' };
  } catch (e) {
    log(`DB: 控え ${k}・取れない（${codeOf(e)}）`);
    return { ok: false, file: null, check: 'io' };
  } finally {
    for (const p of mine) {
      try { dropOwn(fs, p); } catch (_) { /* 次の take の始めに消す */ }
      for (const s of ['', ...SIDECARS]) inProgress.delete(p + s);
    }
  }
}

// ---------------------------------------------------------------- 回す
function rotate({ dataDir, now: _now, fs = nodeFs, log = noop } = {}) {
  const all = listBackups({ dataDir, fs });
  const doomed = [];
  for (const [kind, keep] of Object.entries(KEEP)) {
    const xs = all.filter((b) => b.kind === kind);
    doomed.push(...xs.slice(0, Math.max(0, xs.length - keep)));
  }
  const removed = [];
  for (const b of doomed) {
    try {
      fs.unlinkSync(path.join(dataDir, BACKUP_DIR, b.name));
      removed.push(b.name);
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      log(`DB: 控えを消せなかった（${codeOf(e)}）。次に回すときにもう一度`);
    }
  }
  return removed;
}

function oldestKeptAt({ dataDir, fs = nodeFs } = {}) {
  const kept = listBackups({ dataDir, fs }).filter((b) => b.kind === 'daily' || b.kind === 'weekly');
  return kept.length ? kept[0].at : null;
}

function pruneOplog({ db, before } = {}) {
  if (!before) return 0;
  const at = before instanceof Date ? before.toISOString() : String(before);
  const r = db.prepare('delete from oplog where at < ? and instr(ops, ?) = 0').run(at, '"op":"purge"');
  return Number(r.changes) || 0;
}

// ---------------------------------------------------------------- lock
function withLock(dataDir, fn, { fs = nodeFs, log = noop } = {}) {
  const lock = path.join(dataDir, LOCK_NAME);
  fs.writeFileSync(lock, `pid ${process.pid}\nat ${new Date().toISOString()}\n`);   // 目印だけ（読まない。本文・パスは書かない）
  const release = () => {
    try { fs.unlinkSync(lock); } catch (e) {
      if (!e || e.code !== 'ENOENT') log(`DB: lock を消せなかった（${codeOf(e)}）`);
    }
  };
  let out;
  try { out = fn(); } catch (e) { release(); throw e; }
  if (out && typeof out.then === 'function') return out.finally(release);
  release();
  return out;
}

// ---------------------------------------------------------------- 戻す
async function recover({ sqlite, dataDir, now = () => new Date(), fs = nodeFs, runCheck = workerCheck, waits = RENAME_WAITS_LONG, log = noop, reimport = true } = {}) {
  return withLock(dataDir, async () => {
    try { return await restore({ sqlite, dataDir, now, fs, runCheck, waits, log, reimport }); } catch (e) {
      // 一覧が読めない・自分の一時ファイルを消せないなど（名前の変更は投げない形で行う）。投げずに「今は戻せない」
      log(`DB: 控えから戻せない（${codeOf(e)}）`);
      return { ok: false, code: 'busy' };
    }
  }, { fs, log });
}

async function restore({ sqlite, dataDir, now, fs, runCheck, waits, log, reimport }) {
  const dbFile = path.join(dataDir, DB_NAME);
  const restoring = path.join(dataDir, RESTORING);
  dropOwn(fs, restoring);

  // 1. 戻す写しを先に作って確かめる（natsu.db にはまだ触れない）
  let chosen = null;
  for (const b of listBackups({ dataDir, fs }).reverse()) {
    try {
      writeSynced(fs, restoring, zlib.gunzipSync(fs.readFileSync(path.join(dataDir, BACKUP_DIR, b.name))));
    } catch (e) {
      log(`DB: 控えを広げられない（${codeOf(e)}）。古い控えへ`);
      dropOwn(fs, restoring);
      continue;
    }
    const r = checkResult(await runCheck({ file: restoring }));
    if (r === 'ok') { chosen = b; break; }
    log(`DB: 控えの確かめ ${r === 'corrupt' ? 'NG' : '走れない'}。古い控えへ`);
    dropOwn(fs, restoring);
  }
  if (!chosen) return { ok: false, code: 'no-snapshot' };

  // 2. ここで初めて natsu.db（と -wal・-shm・-journal）を退ける。動かせなければ元に戻して busy
  let brokenBase = path.join(dataDir, `${DB_NAME}.broken-${stamp(now())}`);
  for (let n = 2; [brokenBase, ...SIDECARS.map((s) => brokenBase + s)].some((p) => exists(fs, p)); n++) {
    brokenBase = path.join(dataDir, `${DB_NAME}.broken-${stamp(now())}-${n}`);
  }
  const moved = [];
  const undo = async () => {
    for (const [from, to] of moved.reverse()) {
      if (!(await renameWaiting(fs, to, from, waits))) log('DB: 退けたファイルを元に戻せなかった');
    }
  };
  const busy = async () => {
    await undo();
    dropOwn(fs, restoring);
    return { ok: false, code: 'busy' };
  };
  const hadDb = exists(fs, dbFile);
  for (const s of ['', ...SIDECARS]) {
    if (!exists(fs, dbFile + s)) continue;
    if (!(await renameWaiting(fs, dbFile + s, brokenBase + s, waits))) return busy();
    moved.push([dbFile + s, brokenBase + s]);
  }

  // 3. 確かめた写しを natsu.db にする
  if (!(await renameWaiting(fs, restoring, dbFile, waits))) return busy();
  fsyncDir(fs, dataDir);
  log('DB: 壊れていたので退けて控えから戻した');

  // 4. 控えより後に古い版が書いた JSON を取り込む（D-5b）
  let reimported = null;
  if (reimport) {
    try {
      const o = core.open({ sqlite, file: dbFile });
      if (o.db) {
        try { reimported = M.reimport({ db: o.db, dataDir, fs, now }); } finally { o.db.close(); }
      }
    } catch (e) {
      log(`DB: 戻した後の取り込みができない（${codeOf(e)}）`);
    }
  }
  return { ok: true, from: chosen.at, brokenAs: hadDb ? path.basename(brokenBase) : null, reimported };
}

// ---------------------------------------------------------------- ネットワークの場所
function isNetworkPath(p) {
  const s = String(p || '');
  if (/^[\\/]{2}[?.][\\/]/.test(s)) return /^[\\/]{2}\?[\\/]UNC[\\/]/i.test(s);   // \\?\C:\… と \\.\… は手元、\\?\UNC\… は UNC
  return /^\\\\[^\\/]/.test(s);
}

module.exports = {
  take, rotate, oldestKeptAt, recover, classifyOpenError, checkResult, withLock, pruneOplog, isNetworkPath,
  workerCheck, listBackups, RENAME_WAITS_LONG, LOCK_NAME,
};
