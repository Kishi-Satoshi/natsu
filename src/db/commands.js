/*
 * commands.js — 議事録の DB の命令の一覧と、行 ⇄ ページの組み立て（第2a1回 ST4・ST6・ST11。純粋。node:sqlite の接続は引数）
 *
 * core.call が COMMANDS を凍らせて載せる。命令の表の1行は { roles, write, args（validate.checkArgs の spec）,
 * run(db, args, ctx) → { ops, pageIds, result }, dupResult?(db, args, oplogRow, ctx) }。run は core.call が開いた
 * BEGIN IMMEDIATE の中で呼ばれ、ops を自分で applyOps してから返す（core が oplog の1行に書く）。
 *
 * 行 ⇄ ページ（計画「表の形 v1」の「読むときの形」と「DB が作る欄」）
 *   putPageRows(db, page, segments, { now }) … 1ページの行・ブロック・発言を書く（同じ ID があれば差分で上書き）。
 *     rev・routeText は捨てる。segments が配列でなければ発言には触れない。→ { ops }（当てた操作の列）
 *     書いた中身を変えない（updatedAt・citeStat を作り直さない）。移行・会議の締め・テストの種が使う。now は呼び手の形をそろえるために受けるだけ
 *   readPage(db, id) … { ...attrs, id, title, createdAt?, updatedAt?, rev, blocks: [{ ...attrs, id, type, text, rich?, children: [] }] }
 *     に今の markShortBlocks を当てたもの（今の store.getPage と同じ）。無い・ゴミ箱なら null
 *   readRawPage(db, id, { trashed }) … readPage の markShortBlocks の前の形（移行の完全一致の比べ: D-5a）
 *   readSegments(db, pageId) … [{ id, atMs?, durationMs?, text, failed?, ...extra }]（NULL の欄は出さない）
 *
 * 画面の 14 の命令は、答えの形を今の main の IPC（= json-backend）と同じにする（test/db-commands.test.js が比べる）。
 * ページを書く命令は、今の store.savePage と同じに updatedAt と citeStat を作り直し、diffPage の操作を当てる
 * （当てるとページの行の rev が1つ上がる。ブロックだけを変える命令でも: F6）。
 * 一覧から外すページ: ゴミ箱（trashed_at）と、録音中の写し（attrs.meeting.phase が recording・paused・finalizing）。
 * 検索の2つ（pages.list の q・pages.searchFull）は search.js（D-4。ST8）。一覧の並びと外すページは listedRows の1か所だけ（一覧の1行は接続ごとに覚える: G-1）。
 *
 * 会議の命令（main だけ。D-3b。ST6・RF16・F11）。録音の正本は main のメモリと下書きで、DB のページは画面と復旧のための写し。
 *   meeting.begin／meeting.segment … 写し（attrs.meeting.phase 'recording'）を作る・発言を (page_id, id) で上書きする。
 *     その ID のページが写しでない（締め済み・会議でないページ）か、purge の印がある（取り消した）なら何も変えない
 *     （送り直しが締めや取り消しの後に届いても、写しに戻さない・取り消した文字を戻さない）。begin が届かなかったときは segment が写しを作る
 *   meeting.finalize … 同じ ID の行を、写しでも締め済みでも締めの中身で上書きする（putPageRows。meeting は { phase: 'done', recovered: false }）
 *   meeting.recover … 行が無ければ作り、写しなら下書きの中身で上書きする（下書きが正本）。締め済み（phase 'done'。recovered でも同じ）・
 *     会議でないページ・ゴミ箱のページは題名・要約・メモ・ブロックを変えず、下書きにあって DB に無い発言だけ足す（already: true。F11:
 *     締めた後に下書きを消せなかったとき、後からの要約と直しを空で上書きしない）。purge の印がある（取り消した）なら何もしない（already: true）
 *   ページの形は今の store.createPage と同じ欄（title・date・durationSec・memo・blocks・createdAt・recovered・route・pauses）に
 *     summaryError を足したもの（json-backend の create と同じ答え。summaryError があるときだけ citeStat を作る）
 *   meeting.discard … 写し（か、行が無い）なら、行・発言・その ID の oplog の行を消して purge の印（oplog の1行）だけを残し、
 *     確定の後に core が wal_checkpoint(TRUNCATE) を試す（after: 'checkpoint'。FTS5 の secure-delete と secure_delete=ON で文字を残さない）。
 *     締め済みのページは消さない（取り消しは録音中の会議だけ。古い頼みで議事録を失わない）
 *   meeting.settle({ keep }) … keep に無い写しを phase 'done'・recovered: true にする（ページの recovered も真にする）
 *   segment.fail／segment.remove … 復旧の文字起こしの失敗の文を残す（failed: true）・無音の区間を消す（答えは発言の配列。json-backend と同じ）
 */
'use strict';

const crypto = require('node:crypto');
const { isCitable, refreshCitations, searchFold } = require('../cite');
const { parseDue } = require('../actions');
const { routeLabel, summaryLock } = require('../mainlib');
const R = require('../pagerules');
const mtype = require('../meetingType');
const memoTypes = require('../memoTypes');
// 議事録の経過（0.10.0 K-1。決めたこと 116）: 締め・復旧のページの stateLog は表の鍵の項目だけを残す
const SL = require('../statelog');
const { diffPage, diffSegments, applyOps } = require('./ops');
const S = require('./search');

const LIVE_PHASES = ['recording', 'paused', 'finalizing'];

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);

// 命令の本体が「この符号で断る」ときに投げる（core.call が e.dbCode を見て、その符号で答える。トランザクションは戻る）
function refuse(code) {
  const e = new Error(code);
  e.dbCode = code;
  return e;
}

// よく使う問い合わせ（ST11）。コードはここの文をそのまま使い、テストは EXPLAIN QUERY PLAN で表全体の走査が無いことを見る
const HOT_QUERIES = Object.freeze({
  list: "select rid, id, text, rev, created_at, updated_at, attrs, trashed_at from blocks where type = 'page' order by created_at desc, rid desc",
  pageRow: 'select id, type, text, attrs, rev, created_at, updated_at, trashed_at from blocks where id = ?',
  pageBlocks: 'select id, type, text, rich, attrs, ord from blocks where page_id = ? and id <> ? order by ord',
  pageSegments: 'select id, at_ms, duration_ms, text, failed, extra from segments where page_id = ? order by n',
  todoPages: "select distinct page_id from blocks where type = 'todo'",
  oplogTx: 'select seq, role, tx, at, actor, action, page_id, ops from oplog where role = ? and tx = ?',
  purgeMark: "select seq from oplog where page_id = ? and action = 'meeting.discard' and instr(ops, '\"op\":\"purge\"') > 0 limit 1",
  pageOplog: 'delete from oplog where page_id = ?',
});

// ---------------------------------------------------------------- 行 → ページ
// 生の形（markShortBlocks の前）と、ブロックの並びの鍵。無い行・ページでない行は null。ゴミ箱は opts.trashed のときだけ
function loadPage(db, id, { trashed = false } = {}) {
  const row = db.prepare(HOT_QUERIES.pageRow).get(id);
  if (!row || row.type !== 'page') return null;
  if (row.trashed_at !== null && row.trashed_at !== undefined && !trashed) return null;
  const page = { ...JSON.parse(row.attrs || '{}'), id: row.id, title: row.text };
  if (row.created_at) page.createdAt = row.created_at;
  if (row.updated_at) page.updatedAt = row.updated_at;
  page.rev = row.rev;
  const ords = {};
  page.blocks = db.prepare(HOT_QUERIES.pageBlocks).all(id, id).map((b) => {
    ords[b.id] = b.ord;
    const out = { ...JSON.parse(b.attrs || '{}'), id: b.id, type: b.type, text: b.text };
    if (b.rich !== null && b.rich !== undefined) out.rich = JSON.parse(b.rich);
    out.children = [];
    return out;
  });
  return { page, ords, trashedAt: row.trashed_at ?? null };
}

function readPage(db, id) {
  const l = loadPage(db, id);
  if (!l) return null;
  R.markShortBlocks(l.page.blocks);
  return l.page;
}

// 生の形（markShortBlocks の前。rev と空の children を持つ）。D-5a の移行の確かめと、テストの dbpeek.rawPage が使う。
// 無い・ページでない行は null。ゴミ箱のページは { trashed: true } のときだけ返す
function readRawPage(db, id, { trashed = false } = {}) {
  const l = loadPage(db, id, { trashed });
  return l ? l.page : null;
}

function readSegments(db, pageId) {
  return db.prepare(HOT_QUERIES.pageSegments).all(pageId).map((r) => {
    const s = { id: r.id };
    if (r.at_ms !== null) s.atMs = r.at_ms;
    if (r.duration_ms !== null) s.durationMs = r.duration_ms;
    s.text = r.text;
    if (r.failed !== null) s.failed = r.failed === 1;
    return r.extra ? { ...s, ...JSON.parse(r.extra) } : s;
  });
}

// ---------------------------------------------------------------- ページ → 行
// DB が作る欄（rev・routeText）は ops.diffPage が行にも attrs にも入れない（捨てるのは1か所だけ: 二重にすると片方を戻す変異が生き残る）
function putPageRows(db, page, segments, _opts = {}) {
  if (!isObj(page) || typeof page.id !== 'string') throw new Error('putPageRows: ページの形が正しくない');
  const was = loadPage(db, page.id, { trashed: true });
  const ops = diffPage(was ? was.page : null, page, { ords: was ? was.ords : undefined });
  if (Array.isArray(segments)) ops.push(...diffSegments(was ? readSegments(db, page.id) : [], segments, page.id));
  applyOps(db, ops);
  return { ops };
}

// 今の store.savePage と同じに updatedAt と citeStat を作り直して、前の形との差分の操作を返す（当てない）
function saveOps(was, page, now) {
  page.updatedAt = now().toISOString();
  page.citeStat = { ...(page.citeStat || {}), ...R.citeStatOf(page.blocks || []) };
  return diffPage(was.page, page, { ords: was.ords });
}

// 書くための読み: 生の形と、markShortBlocks を当てた写し（今の store が getPage → 直す → savePage するのと同じ）
function forWrite(db, id) {
  const was = loadPage(db, id);
  if (!was) return null;
  const page = clone(was.page);
  R.markShortBlocks(page.blocks);
  return { was, page };
}

// 0.11.0 M-4: page.setType の中身（json-backend も同じ部品を使う）。p を直す。preset は手を付けていないメモのときだけ雛形に替える
const LEGACY_AGENDAS = mtype.listTypes().map((t) => t.agenda).filter(Boolean);
function setTypePage(p, { type, preset }, at) {
  if (type === 'auto') p.typeAuto = true;
  else {
    p.meetingType = type; p.typeAuto = false;
    if (preset === true && memoTypes.isUntouchedMemo(p.memo, LEGACY_AGENDAS)) p.memo = memoTypes.memoPreset(memoTypes.memoTypeOf(type));
  }
  p.stateLog = SL.stateLogAdd(p.stateLog, { s: 'type', by: 'page', at: at.toISOString() });
}

// ページを1つ直す命令の形: fn(page) が直す（false を返したら何も書かずに null）。答えは書いた後のページ（今の savePage の答え）
// 0.10.0 LS-2（D63・D69・O8・決めたこと 111）: 要約の欄を直す命令（summary: true）は、ページの欄と発言から mainlib.summaryLock を見て、
// 鍵なら locked で断る（画面の外の道からも直せない）。making（要約を作っている間）は DB からは分からないので見ない。
// 要約を保存する命令（page.put）とメモ・題名・種類の命令は鍵を見ない
function summaryLockedPage(db, page) {
  const live = isObj(page.meeting) && LIVE_PHASES.includes(page.meeting.phase);
  return summaryLock(page, { live, segments: readSegments(db, page.id) }) !== '';
}

function editPage(db, id, ctx, fn, { summary = false } = {}) {
  const w = forWrite(db, id);
  if (!w) return { ops: [], pageIds: [], result: null };
  if (summary && summaryLockedPage(db, w.was.page)) throw refuse('locked');
  if (fn(w.page) === false) return { ops: [], pageIds: [], result: null };
  const ops = saveOps(w.was, w.page, ctx.now);
  applyOps(db, ops);
  return { ops, pageIds: [id], result: readPage(db, id) };
}

// 画面に渡すページ（第1c回 OL6）: 経路の行を routeText に添えた写し。送り先の名前は main が init で渡した表示の名前
function forView(page, labels) {
  if (!isObj(page)) return page;
  const id = page.route && page.route.stt ? page.route.stt.provider : '';
  const label = typeof id === 'string' && isObj(labels) && Object.hasOwn(labels, id) && typeof labels[id] === 'string' ? labels[id] : '';
  return { ...page, routeText: routeLabel(page.route, label) };
}

// ---------------------------------------------------------------- 一覧
const isLive = (attrs) => isObj(attrs.meeting) && LIVE_PHASES.includes(attrs.meeting.phase);

// 一覧の1行を接続ごとに覚える（G-1。PERF・RF12: 5,000 ページで pages.list が 667ms・「すべて」の検索が 1094ms かかり、目安を越えた）。
// 鍵はページの行の rid・rev・題名・作った時刻・直した時刻・attrs。ブロックだけの直しでもページの rev が上がる（ops.applyOps。F6）ので、
// 鍵が同じ間は一覧の1行も同じ。別の接続が書いても、読むのは今の行なので古い行は使わない。一覧の全部を作るたびに、一覧に無い
// ページ（ゴミ箱・録音中の写し・消したページ）を忘れる（消して同じ ID で作り直したページを、前の1行で見せない）
const LIST_CACHE = new WeakMap();   // db → Map(id → { key, entry })
const keyOfRow = (r) => [r.rid, r.rev, r.text, r.created_at, r.updated_at, r.attrs].join('\u0000');
// 返す行は写し（呼び手が書き換えても、覚えた行は変わらない）
const copyEntry = (e) => structuredClone(e);

function cacheOf(db) {
  let m = LIST_CACHE.get(db);
  if (!m) { m = new Map(); LIST_CACHE.set(db, m); }
  return m;
}

// 一覧に出すページの行（新しい順。ゴミ箱と録音中の写しを除く）→ [{ id, key, attrs }]。attrs は読んだ物（0.10.0 R-2: MCP の読み手が
// 出さない会議の判定と日付の絞りに使う。録音中の写しを外すためにもう読んでいるので、読み直さない）
function listedRows(db) {
  const out = [];
  for (const r of db.prepare(HOT_QUERIES.list).all()) {
    if (r.trashed_at !== null && r.trashed_at !== undefined) continue;
    const attrs = JSON.parse(r.attrs || '{}');
    if (isLive(attrs)) continue;
    out.push({ id: r.id, key: keyOfRow(r), attrs, createdAt: r.created_at });
  }
  return out;
}

// 一覧の1行（覚えた行の写し）。鍵が違えば読み直して覚え直す。読めなければ null
function entryFor(db, cache, { id, key }) {
  const hit = cache.get(id);
  if (hit && hit.key === key) return copyEntry(hit.entry);
  const l = loadPage(db, id, { trashed: true });
  if (!l) { cache.delete(id); return null; }
  const entry = R.listEntry(l.page);
  cache.set(id, { key, entry });
  return copyEntry(entry);
}

// 外すページの判定は listedRows の1か所だけ（読むときにもう一度ゴミ箱を見ると、片方を戻す変異が生き残る）
function listPages(db) {
  const cache = cacheOf(db);
  const rows = listedRows(db);
  const listed = new Set(rows.map((r) => r.id));
  for (const id of cache.keys()) if (!listed.has(id)) cache.delete(id);
  const out = [];
  for (const row of rows) {
    const e = entryFor(db, cache, row);
    if (e) out.push(e);
  }
  return out;
}

// 検索（D-4）: 一覧に出すページの並びと一覧の1行を search.js に渡す（外す判定と並びは listedRows の1か所だけ）
function searchView(db) {
  const cache = cacheOf(db);
  const rows = listedRows(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return {
    ids: rows.map((r) => r.id),
    entryOf: (id) => (byId.has(id) ? entryFor(db, cache, byId.get(id)) : null),
  };
}

// 一覧の1行（0.10.0 R-2: MCP の読み手が絞った行だけを1行にする。覚えは接続ごとなので、呼び出しごとに開く読み手では空から）
function entryOf(db, row) {
  return entryFor(db, cacheOf(db), row);
}

// アクションタブの1画面分（今の store.actionView と同じ答え。ToDo のあるページだけ読む）。rows は一覧に出す行（0.10.0 R-2: MCP の読み手は
// 出さない会議を除いた行を渡す。省略は listedRows の全部。外す判定は listedRows の1か所のまま）
function actionView(db, { q, assignee } = {}, rows = listedRows(db)) {
  const fq = searchFold(q);
  const who = String(assignee || '');
  const withTodo = new Set(db.prepare(HOT_QUERIES.todoPages).all().map((r) => r.page_id));
  const counts = new Map();
  const actions = [];
  let total = 0;
  for (const { id } of rows) {
    if (!withTodo.has(id)) continue;
    const page = readPage(db, id);
    if (!page) continue;
    for (const b of page.blocks) {
      if (b.type !== 'todo' || b.checked || !b.text) continue;
      const row = R.actionRow(page, b);
      total++;
      if (row.assignee) counts.set(row.assignee, (counts.get(row.assignee) || 0) + 1);
      if (who && row.assignee !== who) continue;
      if (fq && ![row.text, row.pageTitle, row.assignee].some((s) => searchFold(s).includes(fq))) continue;
      actions.push(row);
    }
  }
  actions.sort(R.byDue);
  const people = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((x, y) => y.count - x.count);
  return { actions, people, total };
}

// ---------------------------------------------------------------- ブロックの ID
function newBlockId(db, now) {
  for (;;) {
    const id = `b${now().getTime().toString(36)}${crypto.randomBytes(4).toString('hex').slice(0, 5)}`;
    if (!db.prepare(HOT_QUERIES.pageRow).get(id)) return id;
  }
}

// ---------------------------------------------------------------- 命令
const reread = (db, args) => readPage(db, args.id ?? args.pageId);
const rereadPut = (db, args) => readPage(db, args.page.id);

function segmentUpdate(db, { pageId, segId, patch, recite = true }, ctx) {
  const w = forWrite(db, pageId);
  if (!w) return { ops: [], pageIds: [], result: null };
  const olds = readSegments(db, pageId);
  if (!olds.some((s) => s.id === segId)) return { ops: [], pageIds: [], result: null };
  const segments = clone(olds);
  const s = segments.find((x) => x.id === segId);
  if (typeof patch.text === 'string') {
    s.text = patch.text;
    delete s.failed;   // 「認識に失敗」の行を人が書き直したら、要約の材料に戻す（今の store.updateSegment）
  }
  // 発言の直し・出典の付け直し・ページの保存を1つのトランザクションで（今の2回の保存の間の隙間を無くす: ST6）
  const ops = diffSegments(olds, segments, pageId);
  if (recite !== false) {
    if (w.page.blocks.length) w.page.citeStat = refreshCitations(w.page.blocks, segments.filter((x) => !x.failed), segId);
    ops.push(...saveOps(w.was, w.page, ctx.now));
  }
  applyOps(db, ops);
  return { ops, pageIds: [pageId], result: { page: forView(readPage(db, pageId), ctx.labels), segments: readSegments(db, pageId) } };
}

// ---------------------------------------------------------------- 会議
// その ID が取り消した会議（purge の印がある）か。D-5b の取り込みも、印の ID を戻さないために使う。
// 締め済みのページへの取り消しは何もしない（ops が空の行だけが残る）ので、action だけでなく purge の操作があるかを見る
// 印の後に finalize が同じ ID を作り直しても true のまま（普通の流れでは起きない）。取り込みは「ページの行が無く、かつ印がある」で見ること
function isPurged(db, id) {
  return Boolean(db.prepare(HOT_QUERIES.purgeMark).get(id));
}

// 今の store.localDate と同じ（ローカルの暦日）
function localDate(d) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 締め・復旧のページ: 今の store.createPage と同じ欄と既定（json-backend の create と同じ答え）に、会議の印 meeting を足す
function meetingPage(pageId, src, now, { recovered }) {
  const p = isObj(src) ? src : {};
  const at = now();
  const page = {
    id: pageId,
    title: p.title || '',
    date: p.date || localDate(at),
    durationSec: p.durationSec || 0,
    memo: p.memo || '',
    blocks: Array.isArray(p.blocks) ? clone(p.blocks) : [],
    createdAt: p.createdAt || at.toISOString(),
    updatedAt: at.toISOString(),
    recovered: Boolean(p.recovered),
    summaryError: '',
  };
  if (isObj(p.route)) page.route = clone(p.route);
  if (Array.isArray(p.pauses)) page.pauses = R.cleanPauses(p.pauses);
  if (Array.isArray(p.stateLog)) page.stateLog = SL.cleanStateLog(p.stateLog);
  // 0.11.0 M-4（決めたこと 11・F27）: 録音中に選んだ種類（選べる鍵だけ）を手で選んだ種類として写す
  if (mtype.isSelectable(p.meetingType)) { page.meetingType = p.meetingType; page.typeAuto = false; }
  if (typeof p.summaryError === 'string' && p.summaryError) {
    // 今の復旧は createPage の後に summaryError を入れて savePage する（そのときだけ citeStat ができる）
    page.summaryError = p.summaryError;
    page.citeStat = { ...R.citeStatOf(page.blocks) };
  }
  page.meeting = { phase: 'done', recovered: Boolean(recovered) };
  return page;
}

// 録音中の写し（begin が作る。segment は begin が届かなかったときに作る）
function copyPage(pageId, startedAt, localOnly, now) {
  const at = now();
  const began = Number.isSafeInteger(startedAt) ? new Date(startedAt) : at;
  const meeting = { phase: 'recording', recovered: false };
  if (Number.isSafeInteger(startedAt)) meeting.startedAt = startedAt;
  if (typeof localOnly === 'boolean') meeting.localOnly = localOnly;
  return {
    id: pageId, title: '', date: localDate(began), durationSec: 0, memo: '', blocks: [],
    createdAt: began.toISOString(), updatedAt: at.toISOString(), recovered: false, summaryError: '', meeting,
  };
}

// 写しに書いてよいか: 'create'（行が無い）・'live'（写し）・null（締め済み・会議でない・取り消した・ゴミ箱の写し）
function copyState(db, pageId) {
  const l = loadPage(db, pageId, { trashed: true });
  if (l) return isLive(l.page) && l.trashedAt === null ? 'live' : null;
  return isPurged(db, pageId) ? null : 'create';
}

const NOTHING = { ops: [], pageIds: [], result: null };

function meetingBegin(db, { pageId, startedAt, localOnly }, ctx) {
  if (copyState(db, pageId) !== 'create') return NOTHING;   // 写しがもうある（送り直し）・締め済み・取り消した
  const { ops } = putPageRows(db, copyPage(pageId, startedAt, localOnly, ctx.now), []);
  return { ops, pageIds: [pageId], result: null };
}

function meetingSegment(db, { pageId, seg }, ctx) {
  const state = copyState(db, pageId);
  if (!state) return NOTHING;
  // 当てるのは1回だけ（控えに oplog を当て直したときと、ページの rev の上がり方を同じにする: T4b）
  const ops = state === 'create' ? diffPage(null, copyPage(pageId, undefined, undefined, ctx.now)) : [];
  const olds = state === 'create' ? [] : readSegments(db, pageId);
  const news = clone(olds);
  const i = news.findIndex((s) => s.id === seg.id);
  if (i >= 0) news[i] = clone(seg); else news.push(clone(seg));
  ops.push(...diffSegments(olds, news, pageId));   // 発言の新しい値と前の値（seg）
  applyOps(db, ops);
  return { ops, pageIds: [pageId], result: null };
}

// 締め・復旧のページを書く。前の行がゴミ箱の録音中の写し（app の page.delete で入る）なら、ゴミ箱から出す
// （締めた議事録・下書きから戻した議事録をゴミ箱に置かない）。当てるのは1回だけ
function putMeetingPage(db, page, segments, was) {
  const ops = diffPage(was ? was.page : null, page, { ords: was ? was.ords : undefined });
  ops.push(...diffSegments(was ? readSegments(db, page.id) : [], segments, page.id));
  if (was && was.trashedAt !== null && isLive(was.page)) ops.push({ op: 'restore', id: page.id, at: page.updatedAt, old: was.trashedAt });
  applyOps(db, ops);
  return ops;
}

function meetingFinalize(db, { pageId, page, segments }, ctx) {
  const ops = putMeetingPage(db, meetingPage(pageId, page, ctx.now, { recovered: false }), segments, loadPage(db, pageId, { trashed: true }));
  return { ops, pageIds: [pageId], result: readPage(db, pageId) };
}

function meetingRecover(db, { pageId, page, segments }, ctx) {
  const l = loadPage(db, pageId, { trashed: true });
  if (!l && isPurged(db, pageId)) return { ops: [], pageIds: [], result: { page: null, already: true } };
  if (!l || isLive(l.page)) {
    // 行が無い・録音中の写し（ゴミ箱に入っていても）: 下書きの中身で作る・上書きする（下書きが正本）
    const ops = putMeetingPage(db, meetingPage(pageId, page, ctx.now, { recovered: true }), segments, l);
    return { ops, pageIds: [pageId], result: { page: readPage(db, pageId), already: false } };
  }
  // 締め済み（F11）: ページは変えず、下書きにあって DB に無い発言だけ後ろに足す
  const olds = readSegments(db, pageId);
  const have = new Set(olds.map((s) => s.id));
  const news = [...olds, ...segments.filter((s) => !have.has(s.id)).map(clone)];
  const ops = diffSegments(olds, news, pageId);
  applyOps(db, ops);
  return { ops, pageIds: ops.length ? [pageId] : [], result: { page: readPage(db, pageId), already: true } };
}

// 送り直しの答え: 書いた操作に、ページの行を足したか会議の印を書き換えた操作があれば「作った・上書きした」（already: false）
function recoverDup(db, a, row) {
  const ops = JSON.parse(row.ops || '[]');
  const wrote = ops.some((o) => o && o.id === a.pageId && ((o.op === 'add' && o.row && o.row.type === 'page') || (o.op === 'set' && o.key === 'meeting')));
  return { page: readPage(db, a.pageId), already: !wrote };
}

function meetingDiscard(db, { pageId }) {
  const l = loadPage(db, pageId, { trashed: true });
  if (l && !isLive(l.page)) return NOTHING;   // 締め済み・会議でないページは消さない（行が無くても印は残す）
  db.prepare(HOT_QUERIES.pageOplog).run(pageId);   // 写しの間の操作（発言の文字を持つ）も残さない
  const ops = [{ op: 'purge', id: pageId }];
  applyOps(db, ops);
  return { ops, pageIds: [pageId], result: null };
}

function meetingSettle(db, { keep }) {
  const keepSet = new Set(keep);
  const ops = [];
  const ids = [];
  for (const r of db.prepare(HOT_QUERIES.list).all()) {
    if (keepSet.has(r.id) || !isLive(JSON.parse(r.attrs || '{}'))) continue;
    const l = loadPage(db, r.id, { trashed: true });
    const page = clone(l.page);
    page.meeting = { ...page.meeting, phase: 'done', recovered: true };
    page.recovered = true;
    ops.push(...diffPage(l.page, page, { ords: l.ords }));
    ids.push(r.id);
  }
  applyOps(db, ops);
  return { ops, pageIds: ids, result: { settled: ids.length } };
}

function segmentFail(db, { pageId, segId, text }) {
  const olds = readSegments(db, pageId);
  const news = clone(olds);
  const s = news.find((x) => x.id === segId);
  if (!s) return NOTHING;
  s.text = text; s.failed = true;
  const ops = diffSegments(olds, news, pageId);
  applyOps(db, ops);
  return { ops, pageIds: [pageId], result: readSegments(db, pageId) };
}

function segmentRemove(db, { pageId, segId }) {
  const olds = readSegments(db, pageId);
  const ops = diffSegments(olds, olds.filter((x) => x.id !== segId), pageId);
  applyOps(db, ops);
  return { ops, pageIds: ops.length ? [pageId] : [], result: readSegments(db, pageId) };
}

const resegments = (db, a) => readSegments(db, a.pageId);

const DEFS = {
  // ---- 読む（app と main）
  'pages.list': { roles: ['app', 'main'], write: false, args: { q: 'text?' },
    run: (db, a) => ({ result: a.q ? S.searchList(db, a.q, searchView(db)) : listPages(db) }) },
  'pages.searchFull': { roles: ['app', 'main'], write: false, args: { q: 'text?', limit: 'num?' },
    run: (db, a) => ({ result: S.searchFull(db, a.q || '', a.limit, searchView(db)) }) },
  'pages.actionView': { roles: ['app', 'main'], write: false, args: { q: 'text?', assignee: 'short?' },
    run: (db, a) => ({ result: actionView(db, a) }) },
  // 0.10.0 LS-2（決めたこと 104）: 要約待ちのページ（一覧に出るページのうち summaryWait が真）。main の見回りが mainlib.summaryRetryPick に渡す
  'pages.summaryWaits': { roles: ['main'], write: false, args: {},
    run: (db) => ({ result: listedRows(db).filter((r) => r.attrs.summaryWait === true).map((r) => ({ id: r.id, createdAt: r.createdAt || '', summaryWait: true })) }) },
  'page.get': { roles: ['app', 'main'], write: false, args: { id: 'id' },
    run: (db, a, ctx) => {
      const page = readPage(db, a.id);
      return { result: page ? { page: forView(page, ctx.labels), segments: readSegments(db, a.id) } : null };
    } },

  // ---- 画面の書き込み（app と main。答えは今の main の IPC と同じ）
  'page.setTitle': { roles: ['app', 'main'], write: true, args: { id: 'id', title: 'title' },
    run: (db, a, ctx) => editPage(db, a.id, ctx, (p) => { p.title = a.title; }), dupResult: reread },
  'page.setMemo': { roles: ['app', 'main'], write: true, args: { id: 'id', memo: 'text?' },
    run: (db, a, ctx) => editPage(db, a.id, ctx, (p) => { p.memo = String(a.memo || ''); }), dupResult: reread },
  // 0.11.0 M-4（決めたこと 8・12。持ち主の試作の「1つの命令＝1つのトランザクション」）: 種類を書き（auto なら自動に戻す）、preset が真なら
  // DB にある今のメモが手を付けていないときだけ新しい型の雛形に替え、経過に1件積む（setTypePage）
  'page.setType': { roles: ['app', 'main'], write: true, args: { id: 'id', type: 'meetingTypeArg', preset: 'bool?' },
    run: (db, a, ctx) => editPage(db, a.id, ctx, (p) => setTypePage(p, a, ctx.now())), dupResult: reread },
  // 削除はゴミ箱へ（Q2。元の JSON から取り込みで戻らないように、行は消さない）。答えは一覧
  'page.delete': { roles: ['app', 'main'], write: true, args: { id: 'id' },
    run: (db, a, ctx) => {
      const was = loadPage(db, a.id);
      if (!was) return { ops: [], pageIds: [], result: listPages(db) };
      const ops = [{ op: 'trash', id: a.id, at: ctx.now().toISOString(), old: was.trashedAt }];
      applyOps(db, ops);
      return { ops, pageIds: [a.id], result: listPages(db) };
    },
    dupResult: (db) => listPages(db) },
  'block.update': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', patch: 'patch' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      const b = p.blocks.find((x) => x.id === a.blockId);
      if (!b) return false;
      const patch = a.patch;
      if (typeof patch.text === 'string' && patch.text !== b.text) {
        // 人が書き換えた要点は出典が元の文に合うか分からない（cites は残し、被覆率の分子から外す。今の store.updateBlock）
        if (b.citeState !== 'manual') b.citeState = 'stale';
        if (isCitable(patch.text)) delete b.citeSkip; else b.citeSkip = true;
        // 0.11.0 M-3（決めたこと 23）: 人が直した印の行（未確認・チェック・助言・メモより）は印を外す（citeState は manual のまま＝手書き）
        delete b.mark; delete b.unconfirmed;
        b.text = patch.text;
      }
      if (typeof patch.checked === 'boolean') b.checked = patch.checked;
      if (typeof patch.type === 'string') b.type = patch.type;
      return true;
    }, { summary: true }),
    dupResult: reread },
  // afterBlockId が '' か見つからなければ末尾に足す（今の store.insertBlock と同じ）
  'block.insert': { roles: ['app', 'main'], write: true, args: { pageId: 'id', afterBlockId: 'idOrEmpty', type: 'name?' },
    run: (db, a, ctx) => {
      const blockId = newBlockId(db, ctx.now);
      const out = editPage(db, a.pageId, ctx, (p) => {
        // 人が足した行。LLM の要約ではないので出典の対象外（被覆率の分母に入れない）
        const block = { id: blockId, type: a.type || 'bullet', text: '', cites: [], citeState: 'manual' };
        const i = p.blocks.findIndex((x) => x.id === a.afterBlockId);
        if (i >= 0) p.blocks.splice(i + 1, 0, block); else p.blocks.push(block);
      }, { summary: true });
      return { ...out, result: out.result ? { page: out.result, blockId } : null };
    },
    dupResult: (db, a, row) => {
      const page = readPage(db, a.pageId);
      if (!page) return null;
      const add = JSON.parse(row.ops || '[]').find((o) => o && o.op === 'add' && o.row && o.row.type !== 'page');
      return { page, blockId: add ? add.id : null };
    } },
  'block.remove': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => { p.blocks = p.blocks.filter((x) => x.id !== a.blockId); }, { summary: true }),
    dupResult: reread },
  // toIndex は「動かす行を抜いたあとの」挿入位置（今の store.moveBlock）
  'block.move': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', toIndex: 'num' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      const from = p.blocks.findIndex((x) => x.id === a.blockId);
      if (from < 0) return false;
      const [b] = p.blocks.splice(from, 1);
      const to = Math.max(0, Math.min(Math.trunc(Number(a.toIndex) || 0), p.blocks.length));
      p.blocks.splice(to, 0, b);
      return true;
    }, { summary: true }),
    dupResult: reread },
  'block.setAction': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', assignee: 'short?', dueRaw: 'short?' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      const b = p.blocks.find((x) => x.id === a.blockId);
      if (!b) return false;
      if (typeof a.assignee === 'string') b.assignee = a.assignee.trim();
      if (typeof a.dueRaw === 'string') {
        b.dueRaw = a.dueRaw.trim();
        const r = parseDue(b.dueRaw, new Date(p.createdAt));
        b.due = r.date; b.dueApprox = r.approx;
      }
      return true;
    }, { summary: true }),
    dupResult: reread },
  // 文字起こしの1区間を直す。recite（既定）なら出典を引き直してページも保存する。recite: false は区間だけ（復旧の文字起こしの道）
  'segment.update': { roles: ['app', 'main'], write: true, args: { pageId: 'id', segId: 'id', patch: 'segPatch', recite: 'bool?' },
    run: segmentUpdate,
    dupResult: (db, a, _row, ctx) => {
      const page = readPage(db, a.pageId);
      return page ? { page: forView(page, ctx && ctx.labels), segments: readSegments(db, a.pageId) } : null;
    } },

  // ---- main だけ
  // 要約などの書き戻し: 読んだときの rev（baseRev）が今と違えば conflict（その間の画面の直しを古い写しで上書きしない: F6）。
  // 無い・ゴミ箱のページは作らずに null（要約の途中で消したページを戻さない）。rev と routeText は保存しない
  'page.put': { roles: ['main'], write: true, args: { page: 'page', baseRev: 'int' },
    run: (db, a, ctx) => {
      if (typeof a.page.id !== 'string') throw refuse('bad-args');
      const was = loadPage(db, a.page.id);
      if (!was) return { ops: [], pageIds: [], result: null };
      if (was.page.rev !== a.baseRev) throw refuse('conflict');
      const page = clone(a.page);
      if (!Array.isArray(page.blocks)) page.blocks = [];
      const ops = saveOps(was, page, ctx.now);
      applyOps(db, ops);
      return { ops, pageIds: [page.id], result: readPage(db, page.id) };
    },
    dupResult: rereadPut },

  // ---- 会議（main だけ。送りっぱなしの begin・segment は送るたびに別の tx）
  'meeting.begin': { roles: ['main'], write: true, args: { pageId: 'id', startedAt: 'int', localOnly: 'bool?' },
    run: meetingBegin },
  'meeting.segment': { roles: ['main'], write: true, args: { pageId: 'id', seg: 'seg' },
    run: meetingSegment },
  'meeting.finalize': { roles: ['main'], write: true, args: { pageId: 'id', page: 'page', segments: 'segments' },
    run: meetingFinalize, dupResult: (db, a) => readPage(db, a.pageId) },
  'meeting.recover': { roles: ['main'], write: true, args: { pageId: 'id', page: 'page', segments: 'segments' },
    run: meetingRecover, dupResult: recoverDup },
  'meeting.discard': { roles: ['main'], write: true, args: { pageId: 'id' },
    run: meetingDiscard, after: 'checkpoint' },
  'meeting.settle': { roles: ['main'], write: true, args: { keep: 'ids' },
    run: meetingSettle,
    dupResult: (db, a, row) => ({ settled: new Set(JSON.parse(row.ops || '[]').map((o) => o && o.id)).size }) },
  'segment.fail': { roles: ['main'], write: true, args: { pageId: 'id', segId: 'id', text: 'text' },
    run: segmentFail, dupResult: resegments },
  'segment.remove': { roles: ['main'], write: true, args: { pageId: 'id', segId: 'id' },
    run: segmentRemove, dupResult: resegments },
};

const COMMANDS = Object.freeze(Object.assign(Object.create(null),
  Object.fromEntries(Object.entries(DEFS).map(([k, v]) => [k, Object.freeze(v)]))));

module.exports = { COMMANDS, HOT_QUERIES, putPageRows, readPage, readRawPage, readSegments, listPages, isPurged, listedRows, actionView, entryOf, setTypePage };
