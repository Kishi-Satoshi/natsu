/*
 * migrate.js — 元の JSON（pages/・transcripts/）から議事録の DB への移行（第2a1回 ST10・ST12・RF14。純粋。node:sqlite は引数）
 *
 * 元の JSON は第1a回の J.readJsonFile（退けない読み方）だけで読む。元のファイルは名前も中身も変えない（壊れたものも元の場所のまま。P11）。
 * index.json・draft*.json・segbuf/・recovery.json は読まない・動かさない。正本は pages/*.json（今の store.reconcile と同じ）。
 *
 * plan(dataDir, { fs }) → counts（数だけ。移行の窓 D0 の材料。ファイルは何も変えない）
 * convertPage(page, segments, { usedIds }) → { ok: true, page, segments, fixed, fixedAt } | { ok: false, code: 'bad-shape' }（純粋。元の形は変えない）
 *   今の形で表せるかを見て（表せなければ bad-shape。D-5b の取り込みが起動のたびに試す）、重なった・無い・形の悪い ID だけを振り直す（F2）。
 *   ブロック: ID が無い・ID_RE に合わない・usedIds（前に移したページのブロックと、全部のページの ID）と重なる → 新しい b…（今の newId と同じ形）。
 *   発言: ID が無い・ID_RE に合わない・同じ文字起こしの中で2つ目 → そのページの s<n> の最大の次から空いているもの（出典は最初の発言を指したまま）。
 *   fixed は振り直した数、fixedAt は振り直した位置 { blocks: [i], segments: [i] }（確かめでその ID だけを比べから外す）。
 *   表せない（bad-shape）: 題名・ブロックの文・型が文字でない、型が 'page'（一覧のページになってしまう）、空の作成・更新時刻（読むと欄が消える）、
 *   ページに DB が作る欄・決まった名前（rev・routeText・children・type・text・rich）、blocks が配列でない、ブロックの rich が配列でない・children が空でない、
 *   発言・ブロックが物でない、発言に文が無い（読むと '' になる）、壊れたサロゲート・-0・有限でない数・__proto__ の鍵（表に入れると値が変わる）。
 *   blocks の無いページは今の getPage と同じく空の並びにする。
 * migrate({ sqlite, dataDir, onProgress, fs, now, verifyHook }) → { ok: true, counts, ms } | { ok: false, code: 'verify'|'io'|'quick-check', counts }
 *   1. natsu.db がもうあれば何もせずに io（上書きしない）。前の起動の残り natsu.db.migrating とその -wal・-shm・-journal は
 *      作り直せる自分の一時ファイルなので、開く前に全部消す（残った -wal を新しい .migrating に当てると壊れる）。
 *   2. .migrating を journal_mode=DELETE・synchronous=FULL で作り（名前を変えるときに1つのファイルにするため）、1つのトランザクションで
 *      全部のページ（putPageRows。並びの鍵は evenKeys・ID はそのまま）と指紋（meta の json:<id>）と meta.jsonMigration を書く。
 *      1つのページの書き込みが投げたら、そのページだけ SAVEPOINT で戻して badShape に数える（全部の移行を止めない: F2）。
 *      onProgress(done, total) はファイルを1つ見るたびに呼ぶ。投げたら落ちたのと同じに扱い（接続を閉じて戻す）、呼び手へ投げ返す。
 *   3. 確かめ: 件数（ページ・ブロック・発言・指紋）、全部のページと文字起こしを元の JSON を読み直して深く比べる（「表の形 v1」の読むときの形から
 *      rev と空の children を除いたもの。振り直した ID だけ除く）、verifyHook({ db })（テストだけ。false なら合わない）、quick_check、
 *      全文検索の integrity-check。1つでも合わなければ .migrating を natsu.db.migrating.failed-<時刻> へ退け（消さない。新しい2つだけ残す: JS2）、
 *      natsu.db は作らない。
 *   4. 閉じて fsync し、natsu.db が無いのに残っている natsu.db-wal・-shm・-journal は新しい DB に当てないように .orphan-<時刻> へ退けてから
 *      （消さない）、RENAME_WAITS で待ちながら natsu.db に名前を変え、WAL で開き直して閉じる（WAL は DB のファイルに残る設定）。
 *   移行は oplog に書かない（移行の直後の中身は D-7 の移行の控えが持つ。oplog を消す境は毎日・毎週の控え）。
 * counts = { pages, segments, broken, unreadable, badId, badShape, fixedIds }（数だけ。名前も題名も入れない）
 *   broken: 壊れたページのファイルと、壊れた文字起こし（そのページは発言 0 で移す。今の getTranscript が [] を返すのと同じ見え方）
 *   unreadable: 読めないページか文字起こし（そのページは移さず、D-5b が次の起動で取り込む）
 *   badId: ファイル名と page.id が違う・ページの ID が ID_RE に合わない（今の reconcile と同じく、0.6.0 の一覧にも出ていない）
 * 指紋 json:<id> = { size, mtimeMs, sha, tsize, tmtimeMs, tsha, rev, tbroken? }（文字起こしが無ければ t… は null。壊れていれば tbroken: true）。
 *   D-5b が変わったかを見る。
 * reimport({ db, dataDir, fs, now, onPage }) … 起動のたびの取り込み（D-5b。RF17）。下の関数の説明を見る。
 */
'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const J = require('../jsonfile');
const V = require('./validate');
const core = require('./core');
// putPageRows・readRawPage・readSegments はいつも C.… と呼ぶ（テストが1つのページの書き込みを失敗させて見るため）
const C = require('./commands');

const DB_NAME = 'natsu.db';
const TMP_NAME = 'natsu.db.migrating';
const FAILED_PREFIX = `${TMP_NAME}.failed-`;
const KEEP_FAILED = 2;
const SIDECARS = ['-wal', '-shm', '-journal'];
// ページの欄のうち、行に入れると読むときに消える・作り直されるもの（DB が作る欄と、ページの行では使わない決まった名前）
const PAGE_LOST = ['rev', 'routeText', 'children', 'type', 'text', 'rich'];

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const zero = () => ({ pages: 0, segments: 0, broken: 0, unreadable: 0, badId: 0, badShape: 0, fixedIds: 0 });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const stampOf = (d) => d.toISOString().replace(/[:.]/g, '-');

// ---------------------------------------------------------------- 表せるか
// JSON.parse の答えのうち、表に入れて読み直すと値が変わるもの: 壊れたサロゲート（文字の列は UTF-8 になる）・-0 と有限でない数
// （JSON にすると 0・null）・__proto__ の鍵（欄を拾うときに鍵でなく原型になる）
function plainValue(v) {
  if (typeof v === 'string') return v.isWellFormed();
  if (typeof v === 'number') return Number.isFinite(v) && !Object.is(v, -0);
  if (v === null || typeof v === 'boolean') return true;
  if (Array.isArray(v)) return v.every(plainValue);
  if (isObj(v)) return Object.entries(v).every(([k, x]) => k !== '__proto__' && k.isWellFormed() && plainValue(x));
  return false;
}

const isText = (v) => typeof v === 'string';

function representable(page, segments) {
  if (!isObj(page) || !isText(page.title)) return false;
  for (const k of ['createdAt', 'updatedAt']) if (page[k] !== undefined && (!isText(page[k]) || page[k] === '')) return false;
  if (PAGE_LOST.some((k) => Object.hasOwn(page, k))) return false;
  if (page.blocks !== undefined && !Array.isArray(page.blocks)) return false;
  for (const b of page.blocks || []) {
    if (!isObj(b) || !isText(b.type) || b.type === '' || b.type === 'page' || !isText(b.text)) return false;
    if (b.rich !== undefined && !Array.isArray(b.rich)) return false;
    if (b.children !== undefined && !(Array.isArray(b.children) && b.children.length === 0)) return false;
  }
  for (const s of segments) if (!isObj(s) || s.text === undefined) return false;
  return plainValue(page) && plainValue(segments);
}

// ---------------------------------------------------------------- 1ページの変換（純粋）
function freshBlockId(used) {
  for (;;) {
    const id = `b${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex').slice(0, 5)}`;
    if (!used.has(id)) return id;
  }
}

function convertPage(page, segments, { usedIds = new Set() } = {}) {
  const list = segments === undefined || segments === null ? [] : segments;
  if (!Array.isArray(list) || !representable(page, list)) return { ok: false, code: 'bad-shape' };
  const out = structuredClone(page);
  if (out.blocks === undefined) out.blocks = [];
  const segs = structuredClone(list);
  const fixedAt = { blocks: [], segments: [] };
  if (typeof out.id === 'string') usedIds.add(out.id);
  out.blocks.forEach((b, i) => {
    if (typeof b.id !== 'string' || !V.ID_RE.test(b.id) || usedIds.has(b.id)) { b.id = freshBlockId(usedIds); fixedAt.blocks.push(i); }
    usedIds.add(b.id);
  });
  const good = (id) => typeof id === 'string' && V.ID_RE.test(id);
  const taken = new Set(segs.map((s) => s.id).filter(good));
  let k = 0;
  for (const id of taken) {
    const m = /^s(\d+)$/.exec(id);
    if (m && Number(m[1]) > k) k = Number(m[1]);
  }
  if (!Number.isSafeInteger(k)) k = 0;
  const seen = new Set();
  segs.forEach((s, i) => {
    if (!good(s.id) || seen.has(s.id)) {
      do { k++; } while (taken.has(`s${k}`));
      s.id = `s${k}`;
      taken.add(s.id);
      fixedAt.segments.push(i);
    }
    seen.add(s.id);
  });
  return { ok: true, page: out, segments: segs, fixed: fixedAt.blocks.length + fixedAt.segments.length, fixedAt };
}

// ---------------------------------------------------------------- 元の JSON を読む
function exists(fs, p) {
  try { fs.lstatSync(p); return true; } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return false;
    throw e;
  }
}

function listPageFiles(fs, dataDir) {
  let names;
  try { names = fs.readdirSync(path.join(dataDir, 'pages')); } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
    throw e;
  }
  return names.filter((n) => n.endsWith('.json')).sort();
}

// 退けない読み方で読み、読んだバイトの指紋も取る（同じバイトから。読み直さない）
function readCaptured(fs, file) {
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(file).mtimeMs; } catch (_) { /* 無ければ readJsonFile が missing と答える */ }
  let buf = null;
  const r = J.readJsonFile(file, { shape: isObj, fs: { readFileSync: (f) => { buf = fs.readFileSync(f); return buf; } } });
  const fp = buf ? { size: buf.length, mtimeMs, sha: sha256(buf) } : { size: null, mtimeMs: null, sha: null };
  return { r, fp };
}

// 1つのページのファイルと、その文字起こし → { kind: 'page', id, page, segments, transcriptOk, transcriptBroken, fp } か { kind: 数の名前 }
// transcriptOk: 文字起こしを読めて segments が配列（false なら segments は [] で、無いか壊れている）
function readSource(fs, dataDir, name) {
  const id = name.slice(0, -'.json'.length);
  const p = readCaptured(fs, path.join(dataDir, 'pages', name));
  if (p.r.state === 'missing') return { kind: 'gone' };
  if (p.r.state === 'unreadable') return { kind: 'unreadable' };
  if (p.r.state === 'broken') return { kind: 'broken' };
  const page = p.r.value;
  if (page.id !== id || !V.ID_RE.test(id)) return { kind: 'badId' };
  const t = readCaptured(fs, path.join(dataDir, 'transcripts', name));
  if (t.r.state === 'unreadable') return { kind: 'unreadable' };
  const ok = t.r.state === 'ok' && Array.isArray(t.r.value.segments);
  const transcriptBroken = t.r.state === 'broken' || (t.r.state === 'ok' && !ok);
  return {
    kind: 'page', id, page, segments: ok ? t.r.value.segments : [], transcriptOk: ok, transcriptBroken,
    fp: { ...p.fp, tsize: t.fp.size, tmtimeMs: t.fp.mtimeMs, tsha: t.fp.sha },
  };
}

function readOne(fs, dataDir, name, usedIds) {
  const src = readSource(fs, dataDir, name);
  if (src.kind !== 'page') return src;
  const conv = convertPage(src.page, src.segments, { usedIds });
  if (!conv.ok) return { kind: 'badShape' };
  return { ...src, conv };
}

function tally(counts, item) {
  if (item.kind === 'page') {
    counts.pages++;
    counts.segments += item.conv.segments.length;
    counts.fixedIds += item.conv.fixed;
    if (item.transcriptBroken) counts.broken++;
  } else if (Object.hasOwn(counts, item.kind)) counts[item.kind]++;
}

// 全部のページの ID（ファイル名のうち ID の形のもの）。前のページのブロックが後のページの ID と重ならないように先に押さえる
const pageIdsOf = (names) => new Set(names.map((n) => n.slice(0, -'.json'.length)).filter((id) => V.ID_RE.test(id)));

// 指紋 json:<id> の値。文字起こしが壊れていたら tbroken を付ける（取り込みが、読み直さずに飛ばしたときも壊れたものとして数えるため）
function fpValue(src, rev) {
  const v = { ...src.fp, rev };
  if (src.transcriptBroken) v.tbroken = true;
  return JSON.stringify(v);
}

function plan(dataDir, { fs = nodeFs } = {}) {
  const counts = zero();
  const names = listPageFiles(fs, dataDir);
  const usedIds = pageIdsOf(names);
  for (const name of names) tally(counts, readOne(fs, dataDir, name, usedIds));
  return counts;
}

// ---------------------------------------------------------------- 確かめ
// 読むときの形から DB が作る rev と、2a1 では空の children を除き、振り直した ID だけ外して元の JSON（今の getPage と同じく
// blocks が無ければ空の並び）と深く比べる
function samePage(actual, source, fixedAt) {
  if (!actual) return false;
  const a = structuredClone(actual);
  delete a.rev;
  const e = structuredClone(source);
  if (e.blocks === undefined) e.blocks = [];
  if (!Array.isArray(a.blocks) || !Array.isArray(e.blocks)) return false;
  for (const list of [a.blocks, e.blocks]) for (const b of list) if (isObj(b) && Array.isArray(b.children) && b.children.length === 0) delete b.children;
  for (const i of fixedAt.blocks) { if (isObj(a.blocks[i])) delete a.blocks[i].id; if (isObj(e.blocks[i])) delete e.blocks[i].id; }
  return isDeepStrictEqual(a, e);
}

function sameSegments(actual, source, fixedAt) {
  const a = structuredClone(actual);
  const e = structuredClone(source);
  for (const i of fixedAt.segments) { if (isObj(a[i])) delete a[i].id; if (isObj(e[i])) delete e[i].id; }
  return isDeepStrictEqual(a, e);
}

function verifyAll(db, fs, dataDir, done, counts, expectBlocks) {
  const one = (sql) => db.prepare(sql).get().c;
  if (one("select count(*) c from blocks where type = 'page'") !== counts.pages) return false;
  if (one("select count(*) c from blocks where type <> 'page'") !== expectBlocks) return false;
  if (one('select count(*) c from segments') !== counts.segments) return false;
  if (one("select count(*) c from meta where key like 'json:%'") !== counts.pages) return false;
  for (const { id, name, fixedAt } of done) {
    const src = readSource(fs, dataDir, name);   // 元の JSON を読み直す（移した形とは別に、今のファイルと比べる）
    if (src.kind !== 'page' || src.id !== id) return false;
    if (!samePage(C.readRawPage(db, id), src.page, fixedAt)) return false;
    if (!sameSegments(C.readSegments(db, id), src.segments, fixedAt)) return false;
  }
  return true;
}

function structureOk(db) {
  try {
    const rows = db.prepare('pragma quick_check').all();
    if (rows.length !== 1 || Object.values(rows[0])[0] !== 'ok') return false;
    db.exec("insert into blocks_fts(blocks_fts, rank) values('integrity-check', 1)");
    db.exec("insert into segments_fts(segments_fts, rank) values('integrity-check', 1)");
    return true;
  } catch (_) { return false; }
}

// ---------------------------------------------------------------- ファイル
function freeName(fs, base) {
  if (!exists(fs, base)) return base;
  for (let n = 2; ; n++) if (!exists(fs, `${base}-${n}`)) return `${base}-${n}`;
}

function renameWithWaits(fs, from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; } catch (e) {
      if (e && J.BUSY.has(e.code) && i < J.RENAME_WAITS.length) { J.sleepSync(J.RENAME_WAITS[i]); continue; }
      throw e;
    }
  }
}

function fsyncPath(fs, p, flags) {
  const fd = fs.openSync(p, flags);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function removeStale(fs, tmp) {
  for (const suffix of ['', ...SIDECARS]) {
    try { fs.unlinkSync(tmp + suffix); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  }
}

function pruneFailed(fs, dataDir) {
  const old = fs.readdirSync(dataDir).filter((n) => n.startsWith(FAILED_PREFIX)).sort().slice(0, -KEEP_FAILED);
  for (const n of old) { try { fs.unlinkSync(path.join(dataDir, n)); } catch (_) { /* 消せなければ次の失敗のときにもう一度 */ } }
}

// ---------------------------------------------------------------- 移行
function migrate({ sqlite, dataDir, onProgress, fs = nodeFs, now = () => new Date(), verifyHook } = {}) {
  const t0 = Date.now();
  const counts = zero();
  const dbFile = path.join(dataDir, DB_NAME);
  const tmp = path.join(dataDir, TMP_NAME);
  let db = null;
  const closeDb = () => { if (db) { try { db.close(); } catch (_) { /* 閉じ済み */ } db = null; } };
  // 合わなかった・書けなかった: 写しは消さずに .failed-<時刻> へ退け、古いものは新しい2つまで
  const giveUp = (code) => {
    closeDb();
    try {
      if (exists(fs, tmp)) renameWithWaits(fs, tmp, freeName(fs, path.join(dataDir, FAILED_PREFIX + stampOf(now()))));
      pruneFailed(fs, dataDir);
    } catch (_) { /* 退けられなければ、次の起動が前の残りとして消して作り直す */ }
    return { ok: false, code, counts };
  };

  try { if (exists(fs, dbFile)) return { ok: false, code: 'io', counts }; } catch (_) { return { ok: false, code: 'io', counts }; }
  let progressError = null;
  try {
    removeStale(fs, tmp);
    // network: true は journal_mode=DELETE で開く道（名前を変えるときに1つのファイルにする。synchronous=FULL はいつも）
    const opened = core.open({ sqlite, file: tmp, network: true });
    if (!opened.db) return giveUp('io');
    db = opened.db;
    if (opened.state !== 'ok' || opened.journal !== 'delete') return giveUp('io');

    const names = listPageFiles(fs, dataDir);
    const usedIds = pageIdsOf(names);
    const done = [];
    let expectBlocks = 0;
    const putMeta = db.prepare('insert into meta(key, value) values (?, ?)');
    const revOf = db.prepare('select rev from blocks where id = ?');
    db.exec('BEGIN IMMEDIATE');
    names.forEach((name, i) => {
      const item = readOne(fs, dataDir, name, usedIds);
      if (item.kind === 'page') {
        db.exec('SAVEPOINT natsu_page');
        try {
          C.putPageRows(db, item.conv.page, item.conv.segments, { now });
          putMeta.run(`json:${item.id}`, fpValue(item, revOf.get(item.id).rev));
          db.exec('RELEASE natsu_page');
          tally(counts, item);
          expectBlocks += item.conv.page.blocks.length;
          done.push({ id: item.id, name, fixedAt: item.conv.fixedAt });
        } catch (_) {
          db.exec('ROLLBACK TO natsu_page');
          db.exec('RELEASE natsu_page');
          counts.badShape++;
        }
      } else tally(counts, item);
      if (typeof onProgress === 'function') {
        try { onProgress(i + 1, names.length); } catch (e) { progressError = e; throw e; }
      }
    });
    putMeta.run('jsonMigration', JSON.stringify({ at: now().toISOString(), ...counts }));
    db.exec('COMMIT');

    if (typeof verifyHook === 'function' && verifyHook({ db }) === false) return giveUp('verify');
    if (!verifyAll(db, fs, dataDir, done, counts, expectBlocks)) return giveUp('verify');
    if (!structureOk(db)) return giveUp('quick-check');
    closeDb();
    fsyncPath(fs, tmp, 'r+');

    // natsu.db の無い残りの -wal・-shm・-journal を新しい DB に当てない（消さずに脇へ）
    const stamp = stampOf(now());
    for (const suffix of SIDECARS) {
      if (exists(fs, dbFile + suffix)) renameWithWaits(fs, dbFile + suffix, freeName(fs, `${dbFile}${suffix}.orphan-${stamp}`));
    }
    if (exists(fs, dbFile)) return giveUp('io');   // 移している間に誰かが作った natsu.db は上書きしない
    renameWithWaits(fs, tmp, dbFile);
    try { fsyncPath(fs, dataDir, 'r'); } catch (_) { /* フォルダを開けない OS（Windows）では飛ばす */ }
    // WAL で開き直す（journal_mode は DB のファイルに残る）。開けなくても移した中身はそのまま（次に開く人がもう一度 WAL にする）
    const re = core.open({ sqlite, file: dbFile });
    if (re.db) { try { re.db.close(); } catch (_) { /* 閉じ済み */ } }
    return { ok: true, counts, ms: Date.now() - t0 };
  } catch (e) {
    if (progressError && e === progressError) { closeDb(); throw e; }   // 落ちたのと同じ: .migrating は次の起動が消して作り直す
    return giveUp('io');
  }
}

// ---------------------------------------------------------------- 起動のたびの取り込み（D-5b。RF17）
const COPY_SUFFIX = '（古い版で直したもの）';
const REIMPORT_ACTION = 'json.reimport';

function statOf(fs, file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { size: null, mtimeMs: null };
    return null;   // 見られない: 変わったとみなして読む（読めなければ unreadable）
  }
}

// 大きさと更新時刻が指紋と同じなら、読まずに飛ばす（変わったものだけ SHA-256 を取る）
function sameStat(fs, dataDir, name, fp) {
  const p = statOf(fs, path.join(dataDir, 'pages', name));
  const t = statOf(fs, path.join(dataDir, 'transcripts', name));
  return Boolean(p && t) && p.size === fp.size && p.mtimeMs === fp.mtimeMs && t.size === fp.tsize && t.mtimeMs === fp.tmtimeMs;
}

function readFp(db, id) {
  const r = db.prepare('select value from meta where key = ?').get(`json:${id}`);
  if (!r) return null;
  try { const v = JSON.parse(r.value); return isObj(v) ? v : null; } catch (_) { return null; }
}

function freshPageId(db, used, now) {
  const has = db.prepare('select 1 from blocks where id = ?');
  for (;;) {
    const id = `p${now().getTime().toString(36)}${crypto.randomBytes(4).toString('hex').slice(0, 5)}`;
    if (!used.has(id) && !has.get(id)) return id;
  }
}

// reimport({ db, dataDir, fs, now, onPage }) → { added, replaced, copied, skipped, broken, badShape, unreadable, skippedSig }
//   起動のたびに pages/*.json を見て、指紋（meta の json:<id>）と大きさ・更新時刻が違うものだけ読み、SHA-256 も違えば入れる。
//   - DB に行が無い: purge の印があれば戻さない（skipped）。無ければ同じ ID で足す（added）
//   - DB の行の rev が指紋の rev と同じで、ゴミ箱でもない（DB の側は変わっていない）: 古い版の中身で置き換える（replaced。差分の操作で）
//     文字起こしが無い・壊れているときは、DB の発言に触れない（壊れたファイルで発言を消さない）
//   - それ以外（DB の側も変わった・ゴミ箱に入れた・指紋が無い）: 題名に COPY_SUFFIX を付けた新しい ID の別のページとして足す
//     （copied。文字起こしも写す。DB の側は変えない）。指紋の rev は前のまま（null なら null）にして、後で古い版がまた直しても
//     DB の側を上書きせず、また別のページとして足す（どちらも消さない）
//   1ページずつ、ページの書き込み・oplog の1行（role main・actor migration・action json.reimport）・指紋を1つのトランザクションで書く
//   （途中で落ちても、次の起動で同じページを2回足さない: F3）。onPage(pageId) はテストだけで、書き込みの後・指紋の前に呼ぶ（投げたら戻して投げ返す）。
//   中身が同じ（触っただけ）なら指紋の大きさと時刻だけ直す（数えない）。古い版が消したページ（DB にあって JSON が無い）は DB の側をそのまま残す。
//   壊れたページ（broken）・表せないページ（badShape）・読めないもの（unreadable。数えるだけで次の起動に試す）は入れず、指紋も書かない。
//   文字起こしだけ壊れたページは入れて broken に数える（指紋の tbroken で、次からも数える）。
//   skippedSig: 入れられなかったファイル（pages/<名前>・transcripts/<名前>。ファイル名の順）の名前の並びの SHA-256（M-4 が meta.reimportSkipped と比べる）
function reimport({ db, dataDir, fs = nodeFs, now = () => new Date(), onPage } = {}) {
  const out = { added: 0, replaced: 0, copied: 0, skipped: 0, broken: 0, badShape: 0, unreadable: 0, skippedSig: '' };
  const names = listPageFiles(fs, dataDir);
  const skippedNames = [];
  const putMeta = db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value');
  const rowOf = db.prepare('select type, rev, trashed_at from blocks where id = ?');
  const putLog = db.prepare('insert into oplog(role, tx, at, actor, action, page_id, ops) values (?, ?, ?, ?, ?, ?, ?)');
  let used = null;   // 全部の行の ID と全部のページのファイルの ID（要るときに1回だけ作る）
  const usedIds = () => {
    if (!used) {
      used = pageIdsOf(names);
      for (const r of db.prepare('select id from blocks').all()) used.add(r.id);
    }
    return used;
  };
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { fn(); db.exec('COMMIT'); } catch (e) {
      try { db.exec('ROLLBACK'); } catch (_) { /* 戻せなくても投げる */ }
      throw e;
    }
  };

  for (const name of names) {
    const id = name.slice(0, -'.json'.length);
    const fp0 = V.ID_RE.test(id) ? readFp(db, id) : null;
    if (fp0 && sameStat(fs, dataDir, name, fp0)) {
      if (fp0.tbroken) { out.broken++; skippedNames.push(`transcripts/${name}`); }
      continue;
    }
    const src = readSource(fs, dataDir, name);
    if (src.kind === 'unreadable') { out.unreadable++; continue; }
    if (src.kind === 'broken') { out.broken++; skippedNames.push(`pages/${name}`); continue; }
    if (src.kind !== 'page') continue;   // 消えた・ファイル名と ID が違う（今の 0.6.0 の一覧にも出ていない）
    if (src.transcriptBroken) { out.broken++; skippedNames.push(`transcripts/${name}`); }
    if (fp0 && fp0.sha === src.fp.sha && fp0.tsha === src.fp.tsha) {
      // 中身は同じ（触っただけ）: 大きさと時刻だけ直して、次から読まずに飛ばす
      tx(() => putMeta.run(`json:${id}`, fpValue(src, fp0.rev ?? null)));
      continue;
    }
    const row = rowOf.get(id);
    let mode;
    if (!row) {
      if (C.isPurged(db, id)) { out.skipped++; continue; }   // 取り消した会議は戻さない
      mode = 'add';
    } else if (row.type === 'page' && fp0 && row.trashed_at === null && row.rev === fp0.rev) mode = 'replace';
    else mode = 'copy';

    const ids = usedIds();
    let source = src.page;
    let own = [];
    if (mode === 'copy') {
      if (!isObj(src.page) || !isText(src.page.title)) { out.badShape++; skippedNames.push(`pages/${name}`); continue; }
      source = { ...src.page, id: freshPageId(db, ids, now), title: src.page.title + COPY_SUFFIX };
    } else if (mode === 'replace') {
      // 自分のブロックの ID は重なりとみなさない（同じ ID のブロックを差分で直す）
      own = db.prepare('select id from blocks where page_id = ? and id <> ?').all(id, id).map((r) => r.id);
      for (const b of own) ids.delete(b);
    }
    const conv = convertPage(source, src.segments, { usedIds: ids });
    for (const b of own) ids.add(b);
    if (!conv.ok) { out.badShape++; skippedNames.push(`pages/${name}`); continue; }
    // 置き換えで文字起こしが無い・壊れているなら、DB の発言には触れない
    const segments = mode === 'replace' && !src.transcriptOk ? undefined : conv.segments;

    let fromHook = null;
    let wrote = false;
    try {
      tx(() => {
        const { ops } = C.putPageRows(db, conv.page, segments, { now });
        if (ops.length) {
          putLog.run('main', `m:reimport:${crypto.randomUUID()}`, now().toISOString(), 'migration', REIMPORT_ACTION, conv.page.id, JSON.stringify(ops));
          wrote = true;
          if (typeof onPage === 'function') {
            try { onPage(conv.page.id); } catch (e) { fromHook = e; throw e; }
          }
        }
        // 別のページとして足したときは、指紋の rev を前のまま（DB の側と食い違ったまま）にする
        const rev = mode === 'copy' ? (fp0 ? fp0.rev ?? null : null) : rowOf.get(id).rev;
        putMeta.run(`json:${id}`, fpValue(src, rev));
      });
    } catch (e) {
      if (fromHook && e === fromHook) throw e;
      out.badShape++;   // そのページだけ戻した（ID の重なりなど）。指紋は書いていないので、次の起動でもう一度試す
      skippedNames.push(`pages/${name}`);
      continue;
    }
    if (!wrote) continue;   // 置き換えても中身が同じだった（数えない）
    if (mode === 'add') out.added++;
    else if (mode === 'replace') out.replaced++;
    else out.copied++;
  }
  out.skippedSig = sha256(Buffer.from(JSON.stringify(skippedNames), 'utf8'));
  return out;
}

module.exports = { plan, convertPage, migrate, reimport, COPY_SUFFIX, DB_NAME, TMP_NAME };
