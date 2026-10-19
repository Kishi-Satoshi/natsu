/*
 * core.js — 議事録の DB を開く・自分の確かめ・版の上げ・命令の台 call（第2a1回 ST2・ST3・ST4・T4b。純粋）
 *
 * Electron を読まない。node:sqlite は open({ sqlite }) の引数で受ける（テストは一時フォルダの DB で、server.js は子のプロセスで使う）。
 *
 * open({ sqlite, file, readOnly, network, steps })
 *   → { db, state: 'ok' | 'newer' | 'failed', version, journal: 'wal' | 'delete', selfTest: { sqlite, trigram }, code? }
 *   開くたびに: busy_timeout=5000・foreign_keys=ON・secure_delete=ON・synchronous=FULL・journal_mode=WAL
 *   （ネットワークの場所か、WAL にできなければ DELETE）。自分の確かめは一時の trigram 表で「予算案」が引けるか。
 *   版 0 から SCHEMA_VERSION まで、STEPS（既定 schema.STEPS。テストだけ steps で差し替える）を BEGIN IMMEDIATE の中で1段ずつ流す。
 *   user_version が SCHEMA_VERSION より大きい（新しい版の NaTsu で作った）なら、読み取り専用で開き直して state 'newer'。
 *   開けない・確かめが通らない・版を上げられないなら state 'failed'（接続は閉じて db は null）。
 *
 * call(db, { role, cmd, args, tx }, ctx) → { ok: true, result, changed?, dup? } | { ok: false, code, retry }
 *   順: 名前（凍らせた COMMANDS を Object.hasOwn で引く）→ 役 → 書けるか（newer なら read-only）→ 引数の照らし →
 *   tx（書く命令だけ）→ BEGIN IMMEDIATE → 送り直しの表引き（oplog の (role, tx)。同じ action・page_id なら dup、違えば tx-mismatch）→
 *   本体 → oplog の1行 → COMMIT。本体が投げたら ROLLBACK して internal、SQLITE_BUSY なら busy（retry: true）。
 *   本体が cmdError(code) を投げたら、その符号（not-found・conflict・bad-args）で返す（conflict だけ retry: true）。
 *   actor は役から（app → me、main → system。main は args.actor に recovery・migration を渡せる）。
 *   命令の表の1行: { roles, write, args（validate.checkArgs の spec）, run(db, args, ctx) → { ops, pageIds, result },
 *                   dupResult?(db, args, oplogRow, ctx), pageOf?(args), after?: 'checkpoint' }
 *   dupResult は送り直し（dup）の答えを今の中身から作り直す（ctx は run と同じ。page.get の形の routeText に labels が要る）。
 *   エラーの答えにパス・SQL・本文を入れない（符号だけ）。
 *
 * COMMANDS は Object.create(null) を凍らせた本物の命令の表（commands.js の COMMANDS を載せる: D-3a・D-3b）。
 * 送り直しの表引きの文は commands.HOT_QUERIES.oplogTx（よく使う問い合わせとして EXPLAIN QUERY PLAN で見る: ST11）。
 * registerForTest は、それとは別の試しの表に足す（テストだけが使う。src のほかのファイルは呼ばない: D-7 のテストで字面を見る）。
 */
'use strict';

const schema = require('./schema');
const V = require('./validate');
const commands = require('./commands');

const SCHEMA_VERSION = 1;
const BUSY_MS = 5000;
const ROLES = ['app', 'main'];
const MAIN_ACTORS = ['system', 'recovery', 'migration'];
const CMD_CODES = ['not-found', 'conflict', 'bad-args'];

const COMMANDS = Object.freeze(Object.assign(Object.create(null), commands.COMMANDS));
const TEST_COMMANDS = Object.create(null);

// 開いた接続の状態（newer・readOnly は書く命令を read-only で断る）
const OPENED = new WeakMap();

function registerForTest(defs) {
  for (const [name, def] of Object.entries(defs || {})) TEST_COMMANDS[name] = Object.freeze({ ...def });
}

function lookup(cmd) {
  if (typeof cmd !== 'string') return null;
  if (Object.hasOwn(COMMANDS, cmd)) return COMMANDS[cmd];
  if (Object.hasOwn(TEST_COMMANDS, cmd)) return TEST_COMMANDS[cmd];
  return null;
}

// 命令の本体が「この符号で断る」ときに投げる（トランザクションは戻る）
function cmdError(code) {
  const e = new Error(code);
  e.dbCode = code;
  return e;
}

const fail = (code, retry = false) => ({ ok: false, code, retry });
const isBusy = (e) => Boolean(e) && ((Number(e.errcode) & 0xff) === 5 || (Number(e.errcode) & 0xff) === 6);
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- 開く
function pragma(db, sql) {
  const r = db.prepare(`pragma ${sql}`).get();
  return r ? Object.values(r)[0] : undefined;
}

function setup(db, { readOnly, network }) {
  db.exec(`pragma busy_timeout = ${BUSY_MS}`);
  db.exec('pragma foreign_keys = ON');
  db.exec('pragma secure_delete = ON');
  db.exec('pragma synchronous = FULL');
  if (readOnly) return String(pragma(db, 'journal_mode') || '').toLowerCase() === 'wal' ? 'wal' : 'delete';
  const mode = network ? '' : String(pragma(db, 'journal_mode = WAL') || '').toLowerCase();
  if (mode === 'wal') return 'wal';
  pragma(db, 'journal_mode = DELETE');
  return 'delete';
}

// 自分の確かめ: SQLite の版と、一時の表で trigram が本当に引けるか（「予算案の作成」に "予算案" が1件）
function selfTest(db) {
  const out = { sqlite: '', trigram: false };
  try { out.sqlite = String(db.prepare('select sqlite_version() v').get().v); } catch (_) { /* 版が分からなくても続ける */ }
  try {
    db.exec("create virtual table temp.natsu_selftest using fts5(x, tokenize='trigram')");
    try {
      db.prepare('insert into temp.natsu_selftest(x) values (?)').run('予算案の作成');
      const hits = db.prepare('select count(*) c from temp.natsu_selftest where natsu_selftest match ?').get('"予算案"').c;
      out.trigram = hits === 1;
    } finally { db.exec('drop table temp.natsu_selftest'); }
  } catch (_) { out.trigram = false; }
  return out;
}

// 版を1段ずつ上げる。どの段も BEGIN IMMEDIATE の中で SQL と user_version を一緒に確定する（途中で投げたら版も表も上がらない）
function upgrade(db, from, steps) {
  for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
    const sql = steps[v];
    if (typeof sql !== 'string') throw new Error('版の上げ方が無い');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.exec(`pragma user_version = ${v}`);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* 戻せなくても閉じる */ }
      throw e;
    }
  }
}

function open({ sqlite, file, readOnly = false, network = false, steps = schema.STEPS } = {}) {
  const failed = (code, extra = {}) => ({ db: null, state: 'failed', version: null, journal: null, selfTest: { sqlite: '', trigram: false }, code, ...extra });
  const connect = (ro) => {
    const db = new sqlite.DatabaseSync(file, { readOnly: ro, timeout: BUSY_MS, defensive: true });
    if (typeof db.enableDefensive === 'function') db.enableDefensive(true);
    return db;
  };
  let db = null;
  const close = () => { try { if (db) db.close(); } catch (_) { /* 閉じ済み */ } db = null; };
  try {
    db = connect(Boolean(readOnly));
    let journal = setup(db, { readOnly, network });
    const test = selfTest(db);
    if (!test.trigram) { close(); return failed('selftest', { selfTest: test }); }
    let version = Number(pragma(db, 'user_version')) || 0;
    let state = 'ok';
    let ro = Boolean(readOnly);
    if (version > SCHEMA_VERSION) {
      // 新しい版の NaTsu で作った DB: 読み取り専用で開き直し、書く命令は全部断る（表に触れない）
      state = 'newer';
      if (!ro) {
        close();
        db = connect(true);
        ro = true;
        journal = setup(db, { readOnly: true, network });
      }
    } else if (version < SCHEMA_VERSION) {
      if (ro) { close(); return failed('empty', { selfTest: test }); }
      try { upgrade(db, version, steps); } catch (_) { close(); return failed('upgrade', { selfTest: test }); }
      version = Number(pragma(db, 'user_version')) || 0;
    }
    OPENED.set(db, { state, readOnly: ro });
    return { db, state, version, journal, selfTest: test };
  } catch (e) {
    close();
    return failed(isBusy(e) ? 'busy' : 'open');
  }
}

// ---------------------------------------------------------------- 命令の台
function defaultPageOf(args) {
  if (typeof args.pageId === 'string') return args.pageId;
  if (typeof args.id === 'string') return args.id;
  if (isObj(args.page) && typeof args.page.id === 'string') return args.page.id;
  return null;
}

function call(db, req, ctx = {}) {
  const { role, cmd, args, tx } = isObj(req) ? req : {};
  const def = lookup(cmd);
  if (!def) return fail('unknown-cmd');
  if (!ROLES.includes(role) || !Array.isArray(def.roles) || !def.roles.includes(role)) return fail('forbidden');
  const opened = OPENED.get(db);
  if (def.write && opened && (opened.state === 'newer' || opened.readOnly)) return fail('read-only');
  if (!isObj(args)) return fail('bad-args');

  // actor: 役から決める。main だけが recovery・migration（と system）を名乗れる
  let actor = role === 'main' ? 'system' : 'me';
  let rest = args;
  if (Object.hasOwn(args, 'actor')) {
    if (role !== 'main' || !MAIN_ACTORS.includes(args.actor)) return fail('bad-args');
    actor = args.actor;
    rest = { ...args };
    delete rest.actor;
  }
  const checked = V.checkArgs(def.args || {}, rest);
  if (!checked.ok) return fail('bad-args');
  const a = checked.args;
  if (def.write && (typeof tx !== 'string' || !V.TX_RE.test(tx))) return fail('bad-args');

  const now = typeof ctx.now === 'function' ? ctx.now : () => new Date();
  const runCtx = { now, labels: isObj(ctx.labels) ? ctx.labels : {}, role, actor, tx: def.write ? tx : undefined };
  let begun = false;
  try {
    db.exec(def.write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    begun = true;
    if (!def.write) {
      const out = def.run(db, a, runCtx);
      db.exec('COMMIT');
      return { ok: true, result: isObj(out) && Object.hasOwn(out, 'result') ? out.result : null };
    }
    const pageId = typeof def.pageOf === 'function' ? def.pageOf(a) : defaultPageOf(a);
    const prev = db.prepare(commands.HOT_QUERIES.oplogTx).get(role, tx);
    if (prev) {
      if (prev.action !== cmd || (prev.page_id ?? null) !== (pageId ?? null)) { db.exec('ROLLBACK'); return fail('tx-mismatch'); }
      const result = typeof def.dupResult === 'function' ? def.dupResult(db, a, { ...prev }, runCtx) : null;
      db.exec('COMMIT');
      return { ok: true, result, dup: true };
    }
    const out = def.run(db, a, runCtx) || {};
    const pageIds = Array.isArray(out.pageIds) ? out.pageIds.filter((x) => typeof x === 'string') : [];
    db.prepare('insert into oplog(role, tx, at, actor, action, page_id, ops) values (?, ?, ?, ?, ?, ?, ?)')
      .run(role, tx, now().toISOString(), actor, cmd, pageId ?? null, JSON.stringify(Array.isArray(out.ops) ? out.ops : []));
    db.exec('COMMIT');
    begun = false;
    if (def.after === 'checkpoint') {
      try { db.exec('pragma wal_checkpoint(TRUNCATE)'); } catch (_) {
        if (typeof ctx.log === 'function') ctx.log('DB: チェックポイントを飛ばした');
      }
    }
    const res = { ok: true, result: Object.hasOwn(out, 'result') ? out.result : null };
    if (pageIds.length) res.changed = { pageIds, actor };
    return res;
  } catch (e) {
    if (begun) { try { db.exec('ROLLBACK'); } catch (_) { /* 戻せなくても答える */ } }
    if (e && CMD_CODES.includes(e.dbCode)) return fail(e.dbCode, e.dbCode === 'conflict');
    if (isBusy(e)) return fail('busy', true);
    return fail('internal');
  }
}

module.exports = { SCHEMA_VERSION, COMMANDS, open, call, registerForTest, cmdError };
