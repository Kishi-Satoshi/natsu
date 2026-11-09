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
const { isDeepStrictEqual } = require('node:util');
const { isCitable, refreshCitations, searchFold } = require('../cite');
const { parseDue } = require('../actions');
const { routeLabel, summaryLock, memoDocBare } = require('../mainlib');
const R = require('../pagerules');
const mtype = require('../meetingType');
const memoTypes = require('../memoTypes');
const quality = require('../quality');
// 議事録の経過（0.10.0 K-1。決めたこと 116）: 締め・復旧のページの stateLog は表の鍵の項目だけを残す
const SL = require('../statelog');
const blockEdit = require('../blockEdit');
// 0.13.1（計画 docs/plans/2026-10-27-131.md の決めたこと 3・4・7〜11）: 要約のブロックは木（children）。命令は行を locate で探し、置き場は spotOf（NR6）
const BT = require('../blockTree');
const { diffPage, diffSegments, applyOps, invertOps, opsMatch, pageRow, isDocType } = require('./ops');
// 0.16.0 DS-3（計画 docs/plans/2026-11-04-160.md の決めたこと 1〜32）: データベースの行・列の種類とセル（dbModel）・ビュー（dbView）・並びの鍵
const { rowBlock } = require('./ops');
const DM = require('../dbModel');
const DV = require('../dbView');
const { keyBetween } = require('./keys');
// 0.15.0 PH-2（計画 docs/plans/2026-11-03-150.md の決めたこと 1〜17・HR6）: ページの木は parent_id だけ。歩くのは JS（SQL の再帰を使わない: 決めたこと 6）
const PT = require('../pageTree');
// 0.15.0 PR-1（計画の HR14）: 白紙のページの子の並びの鍵は、本文の子ページの行の順から作る（等しい間の鍵）
const { evenKeys } = require('./keys');
// 0.14.0 EB-2（計画 docs/plans/2026-10-26-140.md の決めたこと 1〜6・14〜16・R60・R72）: 戻せる命令の表（画面の元に戻すの列と同じ）と飾りの整え
const { UNDO_CMDS } = require('../undoBook');
const pageLookLib = require('../pageLook');   // 0.15.0 PL-2: 全部既定の見た目は欄を消す（isPlainLook）
const RT = require('../richText');
const S = require('./search');
const { LIMITS } = require('./validate');
// 0.14.0 MB-2（決めたこと 59〜64・R74・R76）: メモの行（素の文字のメモ memo は memoPlain(memoDoc) で作り直す）
const MD = require('../memoDoc');

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
  list: "select rid, id, parent_id, ord, text, rev, created_at, updated_at, attrs, trashed_at from blocks where type = 'page' order by created_at desc, rid desc",
  // 0.15.0 PH-2（決めたこと 6）: 木を歩くためのページの行（ゴミ箱も録音中の写しも。命令の中で1回だけ読む）
  // PH-2 直し（R12）: attrs の全部（メモ・要約の欄）は読まない。木と一覧の判定に使う欄だけを SQL で取り出す
  pageRows: "select id, parent_id, ord, text, created_at, trashed_at, json_extract(attrs, '$.meeting.phase') as phase, json_extract(attrs, '$.kind') as kind, json_extract(attrs, '$.icon') as icon from blocks where type = 'page'",
  pageRow: 'select id, type, text, attrs, rev, created_at, updated_at, trashed_at from blocks where id = ?',
  typeOf: 'select type from blocks where id = ?',   // 0.16.0 DS-2: 行の型（データベースの行か）
  // 0.16.0 DS-3（決めたこと 30）: データベースの行（生きている行・全部の行・並びの鍵・数・末尾の鍵・1つの行）
  dbRows: "select id, ord, text, attrs, rev, created_at, updated_at from blocks where type = 'row' and parent_id = ? and trashed_at is null",
  dbAllRows: "select id, attrs, trashed_at from blocks where type = 'row' and parent_id = ?",
  dbOrds: "select id, ord from blocks where type = 'row' and parent_id = ?",
  dbRowCount: "select count(*) as c from blocks where type = 'row' and parent_id = ? and trashed_at is null",
  dbLastOrd: "select max(ord) as m from blocks where type = 'row' and parent_id = ?",
  dbRow: 'select id, type, parent_id, ord, text, attrs, rev, created_at, updated_at, trashed_at from blocks where id = ?',
  pageBlocks: 'select id, type, text, rich, attrs, ord, parent_id from blocks where page_id = ? and id <> ? order by ord',
  // 0.15.0 PR-1（HR14）: 白紙のページの本文の並び（行の木の形と、子ページの行の指すページだけ。文・飾り・ほかの欄は読まない）
  bodyRows: "select id, parent_id, ord, type, json_extract(attrs, '$.page') as sub from blocks where page_id = ? and id <> ? order by ord",
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
  if (!row || !isDocType(row.type)) return null;   // 0.16.0 DS-2: データベースの行（row）もページとして開ける
  if (row.trashed_at !== null && row.trashed_at !== undefined && !trashed) return null;
  const page = { ...JSON.parse(row.attrs || '{}'), id: row.id, title: row.text };
  if (row.created_at) page.createdAt = row.created_at;
  if (row.updated_at) page.updatedAt = row.updated_at;
  page.rev = row.rev;
  const ords = {};
  const rows = db.prepare(HOT_QUERIES.pageBlocks).all(id, id).map((b) => {
    ords[b.id] = b.ord;
    const out = { ...JSON.parse(b.attrs || '{}'), id: b.id, type: b.type, text: b.text };
    if (b.rich !== null && b.rich !== undefined) out.rich = JSON.parse(b.rich);
    out.children = [];
    return { id: b.id, parent_id: b.parent_id, block: out };
  });
  // 0.13.1（決めたこと 3・NR1・NR2）: parent_id から children を組み立てる（鍵 ord は兄弟の中の並び）。組めない行は捨てずに最上位の末尾
  const tree = BT.buildTree(rows, id);
  page.blocks = tree.blocks;
  return { page, ords, trashedAt: row.trashed_at ?? null, orphans: tree.orphans };
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

// 今の store.savePage と同じに updatedAt と citeStat を作り直して、前の形との差分の操作を返す（当てない）。
// keepTime（2026-10-28 の点検 8・NR41）: トグルの開け閉め（見た目だけの欄）は中身の直しでないので updatedAt を前のままにする
function saveOps(was, page, now, keepTime = false) {
  page.updatedAt = keepTime && was.page.updatedAt ? was.page.updatedAt : now().toISOString();
  page.citeStat = { ...(page.citeStat || {}), ...R.citeStatOf(page.blocks || []) };
  return diffPage(was.page, page, { ords: was.ords });
}

// 書くための読み: 生の形と、markShortBlocks を当てた写し（今の store が getPage → 直す → savePage するのと同じ）
function forWrite(db, id, { trashed = false } = {}) {
  const was = loadPage(db, id, { trashed });   // 0.15.0 PR-1 直し（R34）: ゴミ箱の白紙のページの本文も直せる（呼び手が trashed を渡したときだけ）
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
    if (preset === true && !memoDocBare(p.memoDoc)) preset = false;   // 0.14.0 MB-2 直し2（R210）: 飾り・色を付けた雛形の行は手を付けたメモ（置き換えない）
    if (preset === true && memoTypes.isUntouchedMemo(p.memo, LEGACY_AGENDAS)) p.memo = memoTypes.memoPreset(memoTypes.memoTypeOf(type));
    // 0.14.0 MB-2（決めたこと 64）: 雛形を入れたら、メモの行も同じ文から作る（手を付けていないかは今どおり memo で見る。memo は memoDoc から作った文と同じ）
    if (preset === true && p.memo === memoTypes.memoPreset(memoTypes.memoTypeOf(type))) p.memoDoc = MD.memoFromText(p.memo);
  }
  p.stateLog = SL.stateLogAdd(p.stateLog, { s: 'type', by: 'page', at: at.toISOString() });
}

// ページを1つ直す命令の形: fn(page) が直す（false を返したら何も書かずに null）。答えは書いた後のページ（今の savePage の答え）
// 0.10.0 LS-2（D63・D69・O8・決めたこと 111）: 要約の欄を直す命令（summary: true）は、ページの欄と発言から mainlib.summaryLock を見て、
// 鍵なら locked で断る（画面の外の道からも直せない）。making（要約を作っている間）は DB からは分からないので見ない。
// 要約を保存する命令（page.put）とメモ・題名・種類の命令は鍵を見ない
function summaryLockedPage(db, page) {
  // 0.16.0 DS-2（決めたこと 26）: データベースの行の本文は白紙のページと同じ本文（要約でない）なので鍵を掛けない
  if (db.prepare(HOT_QUERIES.typeOf).get(page.id)?.type === 'row') return false;
  const live = isObj(page.meeting) && LIVE_PHASES.includes(page.meeting.phase);
  return summaryLock(page, { live, segments: readSegments(db, page.id) }) !== '';
}

// 0.13.1 NR14: view が真の命令（トグルの開け閉め。見た目だけの欄 open）は鍵を見るが、手直しの印（summaryEdited）を付けない
// 0.15.0 PL-2: ページの欄 key を value にする（undefined は欄を消す）。録音中の写しは断る。今と同じ値なら saveOps が何も書かない（決めたこと 16。答えは今のページ）
function setPageAttr(p, key, value) {
  if (isLive(p)) throw refuse('bad-args');
  if (value === undefined) delete p[key]; else p[key] = structuredClone(value);
}
// 0.15.0 PL-2 直し（R75）: 今と同じアイコン・見た目（無い欄と '' や全部既定の見た目は同じ）は何も書かない（答えは今のページ）。
// editPage の saveOps は updatedAt を今にし、markShortBlocks は手を付けていないページの印も書くので、forWrite の前に照らす（setMemoDoc と同じ形）。
// 録音中の写しは同じ値でも setPageAttr が断る
function pageAttrCmd(db, id, ctx, key, value) {
  const l = loadPage(db, id);
  if (l && !isLive(l.page) && isDeepStrictEqual(l.page[key], value)) return { ops: [], pageIds: [], result: readPage(db, id) };
  return editPage(db, id, ctx, (p) => setPageAttr(p, key, value));
}
// 0.15.0 PL-2（決めたこと 35・39）: 要約の書き戻し（page.put）はアイコンと見た目を書き換えない（送ったページに無くても、違っても、DB の今の値のまま）
function keepStoredLook(was, page) {
  for (const k of ['icon', 'look']) {
    if (Object.hasOwn(was, k)) page[k] = structuredClone(was[k]); else delete page[k];
  }
}
function editPage(db, id, ctx, fn, { summary = false, view = false } = {}) {
  const w = forWrite(db, id);
  if (!w) return { ops: [], pageIds: [], result: null };
  if (summary && summaryLockedPage(db, w.was.page)) throw refuse('locked');
  const before = summary ? JSON.stringify(w.page.blocks) : '';
  if (fn(w.page, w.was) === false) return { ops: [], pageIds: [], result: null };   // 0.15.0 PR-1: fn は読んだ形（並びの鍵 ords）も受ける
  // 点検の見直し（R45）: 要約の欄の命令が行を何も変えなければ（同じ所への move・無い行の remove・同じ文の update）書かず、印も付けない（答えは今のページ）
  if (summary && JSON.stringify(w.page.blocks) === before) return { ops: [], pageIds: [], result: readPage(db, id) };
  // 2026-10-26 の持ち主の答え（点検4「どんな手直しでも確かめる」）: 要約の欄を直した印（［要約を再生成］の前に確かめる。作り直した要約の書き戻しで消える）
  if (view) summary = false;   // 0.13.1 NR14: 開け閉めは手直しに数えない（［要約を再生成］の前の確かめを出さない）
  if (summary) w.page.summaryEdited = true;
  const ops = saveOps(w.was, w.page, ctx.now, view);   // 点検 8（NR41）: 開け閉めは updatedAt を変えない
  applyOps(db, ops);
  return { ops, pageIds: [id], result: readPage(db, id) };
}

// 画面に渡すページ（第1c回 OL6）: 経路の行を routeText に添えた写し。送り先の名前は main が init で渡した表示の名前
function forView(page, labels) {
  if (!isObj(page)) return page;
  const id = page.route && page.route.stt ? page.route.stt.provider : '';
  const label = typeof id === 'string' && isObj(labels) && Object.hasOwn(labels, id) && typeof labels[id] === 'string' ? labels[id] : '';
  // 0.11.0 Q-3（決めたこと 33）: 照らした点（qualityView。DB が作る欄で保存しない）
  return { ...page, routeText: routeLabel(page.route, label), qualityView: quality.qualityView(page.quality) };
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
    out.push({ id: r.id, key: keyOfRow(r), attrs, createdAt: r.created_at, parentId: r.parent_id ?? null, ord: r.ord, title: r.text });   // 0.15.0 PH-7: 題名は MCP の場所の文（決めたこと 34）
  }
  // 0.16.0 R97（2026-11-09 の持ち主の答え・M14）: データベースの行の中の子ページ（と子孫）は、行が生きている間だけ一覧に出し、一番近い行の印 inRow を付ける
  // （画面はサイドバーの木に出さない）。行かデータベースをゴミ箱へ入れると見えなくなる（ページには書かない: 決めたこと 28）
  const scope = rowScope(db, out);
  return out.filter((r) => {
    const s = scope.page(r.id);
    if (!s) return true;
    if (!s.live) return false;
    r.inRow = { row: s.row, title: s.title, db: s.db, dbTitle: s.dbTitle };
    return true;
  });
}

// 0.15.0 PH-2（決めたこと 17・F118）: 一覧の1行の木の欄。覚えた1行（LIST_CACHE）の外で、読んだページの行から添える
// （親と並びの鍵は覚えた1行の鍵に入れない。白紙のページは kind、アイコンはあるときだけ）
function withTree(e, row) {
  e.parentId = row.parentId ?? null;
  e.ord = row.ord;
  if (row.attrs && row.attrs.kind === 'blank') e.kind = 'blank';
  if (row.attrs && typeof row.attrs.icon === 'string' && row.attrs.icon) e.icon = row.attrs.icon;
  if (row.inRow) e.inRow = { ...row.inRow };   // 0.16.0 R97: データベースの行の中のページ（一番近い行・その題名・データベース・その題名）
  return e;
}

// 一覧の1行（覚えた行の写し）。鍵が違えば読み直して覚え直す。読めなければ null
function entryFor(db, cache, row) {
  const { id, key } = row;
  const hit = cache.get(id);
  if (hit && hit.key === key) return withTree(copyEntry(hit.entry), row);
  const l = loadPage(db, id, { trashed: true });
  if (!l) { cache.delete(id); return null; }
  const entry = R.listEntry(l.page);
  cache.set(id, { key, entry });
  return withTree(copyEntry(entry), row);
}

// 外すページの判定は listedRows の1か所だけ（読むときにもう一度ゴミ箱を見ると、片方を戻す変異が生き残る）
function listPages(db) {
  const cache = cacheOf(db);
  const rows = withBodyOrds(db, listedRows(db));   // 0.15.0 PR-1（決めたこと 47・HR14）: 白紙のページの子は本文の行の順
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
  const rows = withBodyOrds(db, listedRows(db));   // 0.15.0 PR-1（HR14）: 一覧と同じ並びの鍵
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
// noPrivate（DV-2 直し・2026-11-08 の持ち主の答え「PC の中だけの会議の名前は候補に出さない（おすすめ）」・R83）: オフラインモードの会議（経路か会議の印）と、
// 印の分からない会議（片付けた落ちた会議で経路の記録が無い）を外す（データベースのユーザーの列の候補のため。アクション一覧は渡さない）
const privateMeeting = (p) => p.kind !== 'blank' && p.kind !== 'database' && ((isObj(p.route) && p.route.localOnly === true)
  || (isObj(p.meeting) && p.meeting.localOnly === true) || (p.recovered === true && !isObj(p.route)));
function actionView(db, { q, assignee, noPrivate } = {}, rows = listedRows(db)) {
  const fq = searchFold(q);
  const who = String(assignee || '');
  const withTodo = new Set(db.prepare(HOT_QUERIES.todoPages).all().map((r) => r.page_id));
  const counts = new Map();
  const actions = [];
  let total = 0;
  for (const { id } of rows) {
    if (!withTodo.has(id)) continue;
    const page = readPage(db, id);
    if (!page || (noPrivate && privateMeeting(page))) continue;
    for (const b of BT.flattenBlocks(page.blocks)) {   // 0.13.1（F48）: 子の ToDo も（閉じたトグルの中も。開け閉めは見た目だけ）
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

// ---------------------------------------------------------------- 0.13.0 ED-2: 要約の編集の命令の部品（計画 docs/plans/2026-10-24-130.md の決めたこと 10〜13）
// 文が変わった行の出典と印（block.update と同じ決まり: 人が書き換えた行は出典が合うか分からないので stale・manual は manual のまま・0.11.0 の印を外す）
function retext(blk, text) {
  if (text === blk.text) return;
  if (blk.citeState !== 'manual') blk.citeState = 'stale';
  if (isCitable(text)) delete blk.citeSkip; else blk.citeSkip = true;
  delete blk.mark;
  delete blk.unconfirmed;
  delete blk.aiHeading;   // 2026-10-26 の点検2: 文を変えた元の AI の見出しは、見出しへ戻しても人の行
  blk.text = text;
}
// 0.14.0 EB-2（決めたこと 14）: 行の飾りを整えて持つ（飾りの無い行は rich を持たない）
function putRich(blk, rich) {
  const r = RT.normalizeRich(rich);
  if (r) blk.rich = r; else delete blk.rich;
}
// 分ける位置: 文の長さの中で、サロゲートペアの間でない（画面は書記素の境に寄せて送る: blockEdit.safeOffset）
const isHighSur = (c) => c >= 0xd800 && c <= 0xdbff;
const isLowSur = (c) => c >= 0xdc00 && c <= 0xdfff;
function splitAtOk(text, at) {
  if (!(at <= text.length)) return false;
  return !(at > 0 && at < text.length && isHighSur(text.charCodeAt(at - 1)) && isLowSur(text.charCodeAt(at)));
}
// 足した行の ID（split・duplicate の送り直しは、oplog の1行の add の操作から同じ答えを返す）
function addedDup(db, a, row) {
  const page = readPage(db, a.pageId);
  if (!page) return null;
  const add = JSON.parse(row.ops || '[]').find((o) => o && o.op === 'add' && o.row && !isDocType(o.row.type));
  return { page, blockId: add ? add.id : null };
}
// 結合の送り直し: つないだ先とつないだ所を oplog の1行から作り直す（今の行を消していなければ、区切り線を消したか頭の行: 今の行の頭）
function mergeDup(db, a, row) {
  const l = loadPage(db, a.pageId);
  if (!l) return null;
  const page = readPage(db, a.pageId);
  const ops = JSON.parse(row.ops || '[]');
  const gone = ops.find((o) => o && o.op === 'trash' && o.id === a.blockId);
  if (!gone) return { page, blockId: a.blockId, at: 0 };
  const t = ops.find((o) => o && o.op === 'text' && o.id !== a.pageId);
  if (t) return { page, blockId: t.id, at: String(t.old || '').length };
  // 0.13.1（TQ1）: intoId があればそこ（文の無い行をつないだので、つないだ先の文は変わっていない）
  if (a.intoId) { const t = BT.locate(page.blocks, a.intoId); if (t) return { page, blockId: a.intoId, at: String(t.b.text || '').length }; }
  const ord = gone.old && typeof gone.old.ord === 'string' ? gone.old.ord : '';
  const before = BT.flattenBlocks(page.blocks).filter((b) => typeof l.ords[b.id] === 'string' && l.ords[b.id] < ord).pop();
  return before ? { page, blockId: before.id, at: String(before.text || '').length } : { page, blockId: a.blockId, at: 0 };
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
    const changed = s.text !== patch.text;
    s.text = patch.text;
    delete s.failed;   // 「認識に失敗」の行を人が書き直したら、要約の材料に戻す（今の store.updateSegment）
    // 0.12.0 SP-3b（決めたこと 144・145）: 文が変わって parts の無い直しなら、古い文の頭を消す（文を直した区間は1行）
    if (changed && !Array.isArray(patch.parts)) delete s.parts;
  }
  if (Array.isArray(patch.parts)) s.parts = patch.parts;   // 会議の後と戻しの文字起こし（照らしは checkSegPatch）
  // 発言の直し・出典の付け直し・ページの保存を1つのトランザクションで（今の2回の保存の間の隙間を無くす: ST6）
  const ops = diffSegments(olds, segments, pageId);
  if (recite !== false) {
    // 0.13.1（F48）: 木を平らにした同じ物の並びを渡す（付け直した出典が子の行にも届く。cite.js は変えない）
    if (w.page.blocks.length) w.page.citeStat = refreshCitations(BT.flattenBlocks(w.page.blocks), segments.filter((x) => !x.failed), segId);
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

// 0.14.0 MB-3（R165）: page.put の引数がメモを持たなければ、保存してあるメモのまま（main の書き戻しはメモを送らない。memoDoc を送らないときは
// memo も保存してある方にして、行と素の文字を食い違わせない）。json-backend も同じ部品 → page（直した写し）
// 0.14.0 MB-2 直し（R167）: 引数がメモの行を持てば、締めと同じく照らして、合えば整えた行と memoPlain の memo、外れれば行を捨てて memo だけ
function keepStoredMemo(was, page) {
  if (Object.hasOwn(page, 'memoDoc')) {
    const doc = memoDocOr(page.memoDoc);
    if (doc) { page.memoDoc = doc; page.memo = MD.memoPlain(doc); return page; }
    delete page.memoDoc;
    // 0.14.0 MB-3 直し（R180）: 外れた行と一緒に素の文字のメモを渡していればそれだけ。渡していなければ保存してあるメモのまま（外れた行で消さない）
    if (Object.hasOwn(page, 'memo')) return page;
  }
  if (Array.isArray(was.memoDoc)) { page.memoDoc = clone(was.memoDoc); page.memo = was.memo; }
  else if (!Object.hasOwn(page, 'memo') && Object.hasOwn(was, 'memo')) page.memo = was.memo;
  return page;
}

// 0.14.0 MB-2: 照らしに合うメモの行の並び（整えた写し）か null（無い・外れる）
function memoDocOr(v) {
  if (v === undefined) return null;
  try { return MD.validateMemoDoc(v); } catch (_) { return null; }
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
  // 0.14.0 MB-2（決めたこと 65）: 下書きのメモの行（memoDoc）は照らしに合えば持ち、memo はそこから作り直す。無いか外れれば memo だけ（壊れた行の形は使わない）
  const doc = memoDocOr(p.memoDoc);
  if (doc) { page.memoDoc = doc; page.memo = MD.memoPlain(doc); }
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
  // 0.15.0 PH-2（決めたこと 11・F114）: 消すページを親に持つページの行（普通の流れでは無い: 決めたこと 9）は、同じ命令で最上位へ出してから消す（迷子にしない）
  const kids = pageRowsOf(db).filter((r) => r.parentId === pageId);
  const ops = [...kids.map((r) => topMove(r)), { op: 'purge', id: pageId }];
  applyOps(db, ops);
  return { ops, pageIds: [pageId, ...kids.map((r) => r.id)], result: null };
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

// ---------------------------------------------------------------- 0.14.0 MB-2: メモの行（計画 docs/plans/2026-10-26-140.md の決めたこと 59〜61・R74・BQ28 (a)）
// doc は照らした写し（validate の memoDoc）。editPage を summary なしで通る（要約の欄の鍵を見ず、手直しの印 summaryEdited を付けず、要約の行が
// 同じでもメモの直しを捨てない）。今と同じ doc なら何も書かない（答えは今のページ・changed なし: 元に戻すの1歩にならない）
function setMemoDoc(db, a, ctx) {
  const l = loadPage(db, a.id);
  if (!l) return { ops: [], pageIds: [], result: null };
  const memo = MD.memoPlain(a.doc);
  if (isDeepStrictEqual(l.page.memoDoc, a.doc) && l.page.memo === memo) return { ops: [], pageIds: [], result: readPage(db, a.id) };
  return editPage(db, a.id, ctx, (p) => {
    p.memoDoc = a.doc;
    p.memo = memo;   // 素の文字のメモは行から作り直す（食い違ったまま保存しない。読む所は全部これを読む）
  });
}

// メモの歩み（ページの行だけに触れる）か要約の歩み（ほかの行に触れる）か（R76・R84）。戻すときに当てる操作（invertOps が残すもの）で見る:
// 書くたびの forWrite が関係の無い短い行に付ける印 citeSkip（メモの最初の保存でも付く）と開け閉め open は、ブロックの行でも数えない。何も戻さない歩みはどちらでもない
function paneOfStep(ops, pageId) {
  let back;
  try { back = invertOps(ops, { pageId }); } catch (_) { back = ops; }   // 戻せない操作は下の invertOps が bad-args で断る
  if (back.some((o) => o && o.id !== pageId)) return 'note';
  return back.length ? 'memo' : '';
}

// ---------------------------------------------------------------- 0.14.0 EB-2: 元に戻す（計画 docs/plans/2026-10-26-140.md の決めたこと 2〜5・R2・R3・R60・R72）
// 渡された tx の行（自分の役・自分の操作・このページ・戻せる命令だけ）の操作を古い順に重ね、その「後の値」が今の表と同じなら
// 新しい順に後ろから当てる（invertOps）。1つでも違えば何も変えずに stale（中途半端に戻さない）。ページの行は memo・memoDoc だけ戻し、
// 直した時刻と出典の数は作り直し、手直しの印は立てる（要約の歩みのとき）。ブロックの短い行の印 citeSkip は戻さず、戻して文が変わった行だけ
// retext と同じ決まりで作り直す（ほかの行の印は、付いたままが正しい値）。oplog の1行になり、その tx をもう一度戻せばやり直し
// 戻して置き直した行（足し直した・動かし直した行）の置き場が今も成り立つか（0.14.0 EB-1 直し・R90）: 前の親が今もこのページにある
// （かページそのもの）・同じ親の兄弟に同じ並びの鍵の行が無い。成り立たなければ stale（後から親が消えた・ほかの行がその鍵に入った）
function placesFit(db, pageId, ops) {
  const ids = new Set(ops.filter((o) => o.op === 'add' || o.op === 'move').map((o) => o.id));
  const row = db.prepare('select id, page_id, parent_id, ord from blocks where id = ?');
  const twin = db.prepare('select count(*) as c from blocks where page_id = ? and parent_id = ? and ord = ? and id <> ?');
  for (const id of ids) {
    const r = row.get(id);
    if (!r) continue;   // 同じ歩みの中で後から消した行
    if (r.parent_id !== pageId) {
      const p = row.get(r.parent_id);
      if (!p || p.page_id !== pageId) return false;
    }
    if (twin.get(pageId, r.parent_id, r.ord, id).c > 0) return false;
  }
  return true;
}
function editRevert(db, a, ctx) {
  const rows = a.steps.map((tx) => {
    const r = db.prepare(HOT_QUERIES.oplogTx).get(ctx.role, tx);
    if (!r) throw refuse('bad-args');
    if (r.actor !== 'me') throw refuse('bad-args');                // main・Claude の行は戻さない（決めたこと 3）
    if (r.page_id !== a.pageId) throw refuse('bad-args');          // ほかのページの歩み
    if (!UNDO_CMDS.has(r.action)) throw refuse('bad-args');        // 戻せる命令（要約の欄とメモの欄の操作）だけ
    return r;
  });
  rows.sort((x, y) => x.seq - y.seq);
  // 0.16.0 DS-3（決めたこと 47・48）: データベースのページの歩みは、表の操作だけを戻す（要約・メモの欄の決まりは通らない）
  if (dbOf(db, a.pageId)) return rows.length ? dbRevert(db, a, ctx, rows.flatMap((r) => JSON.parse(r.ops || '[]'))) : { ops: [], pageIds: [], result: null };
  // 0.14.0 MB-2（R76）: 1回に戻すのは1つの欄の歩みだけ（メモの歩みと要約の歩みを混ぜたら断る。列は欄ごと: BQ22 (a)）
  const panes = new Set(rows.map((r) => paneOfStep(JSON.parse(r.ops || '[]'), a.pageId)).filter(Boolean));
  if (panes.size > 1) throw refuse('bad-args');
  const fwd = rows.flatMap((r) => JSON.parse(r.ops || '[]'));
  const l = loadPage(db, a.pageId);
  if (!l) throw refuse('bad-args');   // 無い・ゴミ箱のページ
  if (!fwd.length) return { ops: [], pageIds: [], result: { page: readPage(db, a.pageId) } };
  const summary = panes.has('note');   // 要約の行に触れた歩み（鍵と印。メモだけの歩みは見ない: R76・BQ28 (a)）
  if (summary && summaryLockedPage(db, l.page)) throw refuse('locked');
  let back;
  let same;
  try {
    back = invertOps(fwd, { pageId: a.pageId });
    same = opsMatch(db, fwd, { pageId: a.pageId });   // 0.15.0 PR-1（決めたこと 50）: 子のページの行の trashed_at も照らす
  } catch (_) { throw refuse('bad-args'); }   // 戻せない操作（ページの行の削除・発言など）
  if (!same) throw refuse('stale');
  // 0.15.0 PR-1（決めたこと 59）: 戻すと今の子ページの行に文・型を入れる歩み（/ページ で替えた行の前の文）は戻さない
  const typeNow = db.prepare('select type from blocks where id = ?');
  if (back.some((o) => (o.op === 'text' || o.op === 'retype') && (typeNow.get(o.id) || {}).type === 'subpage')) throw refuse('stale');
  // 後ろへ当てた形を一度試しに当てて、直した時刻・出典の数・印の操作を作る（当てるのは1回だけ: T4b の rev の上がり方を同じにする）
  let meta;
  let fits = true;
  db.exec('SAVEPOINT natsu_revert');
  try {
    applyOps(db, back);
    fits = placesFit(db, a.pageId, back);
    const w = loadPage(db, a.pageId);
    if (w.orphans > l.orphans) fits = false;   // EB-2 直し（R90）: 戻すと親の輪・親の無い子が増える（後からほかの書き手が木を変えた）
    const next = clone(w.page);
    const retexted = new Set(back.filter((o) => o.op === 'text').map((o) => o.id));
    for (const x of BT.flattenBlocks(next.blocks)) if (retexted.has(x.id)) { if (isCitable(x.text)) delete x.citeSkip; else x.citeSkip = true; }
    if (summary) next.summaryEdited = true;   // R72: 戻した直しも手直し（［要約を再生成］の前に確かめる）
    meta = saveOps(w, next, ctx.now);
  } finally {
    db.exec('ROLLBACK TO natsu_revert');
    db.exec('RELEASE natsu_revert');
  }
  if (!fits) throw refuse('stale');
  const ops = [...back, ...meta];
  applyOps(db, ops);
  return { ops, pageIds: [a.pageId], result: { page: readPage(db, a.pageId) } };
}

// ---------------------------------------------------------------- 0.14.0 EK-2: 貼り付けと、選んだ行をまとめて扱う命令の部品（計画 docs/plans/2026-10-26-140.md の決めたこと 25・30・31・R65・R66・BQ30 (a)）
// AI の節の見出し（aiSectionHead）を子にする置き場か（s は spotOf の答え。最上位の並びでなければ子になる: R65。人の見出しは citeState: 'manual' で子にできる）
const headIntoKid = (rows, s) => Boolean(s.parent) && rows.some((b) => BT.aiSectionHead(b));
// 選んだ行（ids は画面の順）→ ほかの選んだ行の子孫を除いた行の並び（子孫は親と一緒に扱い、重ねて数えない: 決めたこと 31）。無い行・空の ids は bad-args
function pickRoots(blocks, ids) {
  if (!ids.length) throw refuse('bad-args');
  const at = new Map(BT.walk(blocks).map((w) => [w.b.id, w]));
  const want = new Set(ids);
  const roots = [];
  for (const id of want) {
    const w = at.get(id);
    if (!w) throw refuse('bad-args');
    let up = w.parentId;
    while (up !== null && !want.has(up)) up = at.get(up).parentId;
    if (up === null) roots.push(w.b);
  }
  return roots;
}
// 行を外す（子孫ごと。居場所はその時に探す）
function takeOut(blocks, rows) {
  for (const b of rows) { const w = BT.locate(blocks, b.id); w.list.splice(w.index, 1); }
}
// 新しい ID（同じ命令の中で重ならない）
function freshId(db, ctx, used) {
  let id = newBlockId(db, ctx.now);
  while (used.has(id)) id = newBlockId(db, ctx.now);
  used.add(id);
  return id;
}
// 貼る行（validate の pasteBlocks の写し）→ 要約の行（新しい ID・人の行・出典なし）。子を持てない型（トグルでない見出し・区切り線）の下の子は、
// その行の後ろの兄弟に上げる（R66。src/pasteConvert.js と同じ決まりを DB でも当てる: 古い画面・後の MCP の貼り付けでも見出しに子が付かない）
function pasteRows(db, ctx, rows, used) {
  const out = [];
  for (const r of rows) {
    const b = { id: freshId(db, ctx, used), type: r.type, text: RT.plainOf(r.rich), cites: [], citeState: 'manual' };
    if (r.type === 'heading' && r.level) b.level = r.level;
    if (r.type === 'todo') b.checked = r.checked === true;
    if (r.type === 'callout') b.icon = blockEdit.CALLOUT_ICON;
    putRich(b, r.rich);
    const kids = pasteRows(db, ctx, r.children || [], used);
    out.push(b);
    if (!kids.length) continue;
    if (BT.kidsCan(b)) b.children = kids; else out.push(...kids);
  }
  return out;
}
const lastOf = (rows) => { const f = BT.flattenBlocks(rows); return f[f.length - 1].id; };
// 0.14.0 EK-2 直し（I2・M2・R129）: 行を増やす命令（貼り付け・複製）の後のページが、main の page.put が受ける上限（行は子孫も数えて LIMITS.blocks・
// ページの JSON は LIMITS.bytes）を越えるなら、何も変えずに too-big で断る（越えたページは要約の書き戻しの page.put が bad-args で断られて保存できなくなる）
// EK-3 直し（R143）: 大きさは main が次に送り直す形で見る（saveIfExists は page.get の答え（routeText・qualityView を添え、rev・citeStat を持つ）を
// { page, baseRev } に包んで page.put で送る）。saveOps が後で作る時刻・印と、main の小さな書き戻し（経路の数など）の分に FIT_RESERVE を残す
const FIT_RESERVE = 4096;
function pageFits(p, ctx) {
  if (BT.flattenBlocks(p.blocks).length > LIMITS.blocks) throw refuse('too-big');
  // 0.14.0 MB-2 直し2（R210）: saveIfExists はメモ（memo・memoDoc）を外して送る（R165）ので、ここでも数えない（大きなメモのページの貼り付け・複製を断らない）
  const { memo: _memo, memoDoc: _memoDoc, ...view } = forView(p, ctx && ctx.labels);
  const wire = { page: { ...view, rev: Number.MAX_SAFE_INTEGER }, baseRev: Number.MAX_SAFE_INTEGER };
  if (Buffer.byteLength(JSON.stringify(wire), 'utf8') + FIT_RESERVE > LIMITS.bytes) throw refuse('too-big');
}
// 貼り付けの中身（editPage の中）: 今の行を at で分けて、前を今の行・貼った行をすぐ下（inside なら最初の子）・後ろの文を貼った行のさらに下の新しい行にする。
// 文のある行の頭（at 0）は分けず、貼った行を上（afterId: 画面で上に見えている同じ親の兄弟の後ろ）に足し、今の行は ID・文・担当・期限・出典をそのまま持つ（BQ30 (a)。
// block.split の点検1・点検8 と同じ）。今の行が空のテキストの行（子も無い）なら、最初に貼った行がその行の型と中身になる（R18）→ 最後に貼った行の ID
function pasteInto(db, ctx, p, a) {
  const l = BT.locate(p.blocks, a.blockId);
  if (!l) return null;
  const b = l.b;
  const text = RT.plainOf(a.rich);
  // 0.15.0 PR-1（決めたこと 51）: 子ページの行の文には貼らない。PR-2（R31）: 区切り線と同じく、文の無い形（rich が空）なら行のすぐ下へ足す（行はそのまま）
  if (isSubRow(b) && (text !== '' || a.inside === true)) throw refuse('bad-args');
  if (!splitAtOk(text, a.at)) throw refuse('bad-args');
  // inside は子の見えている行だけ（R66・TQ3）。0.14.0 の BQ31（2026-10-30 の持ち主の答え「すぐ下（子の先頭）に入れる」）で文の途中も通す（Enter と同じ）。
  // 文のある行の頭は上に足す形（BQ30 (a)）なので inside は断る
  if (a.inside === true && (!BT.kidsCan(b) || (a.at === 0 && text !== ''))) throw refuse('bad-args');
  const rows = pasteRows(db, ctx, a.blocks, new Set());
  if (a.at === 0 && text !== '') {
    putRich(b, a.rich);
    retext(b, text);
    if (a.afterId === a.blockId) throw refuse('bad-args');
    const s = a.afterId === undefined ? { list: l.list, index: l.index } : BT.spotOf(p.blocks, a.afterId, a.afterId === '' && l.parent ? l.parent.id : undefined);
    if (!s || s.list !== l.list) throw refuse('bad-args');   // NR8: 同じ親の兄弟の並びの中だけ
    s.list.splice(s.index, 0, ...rows);
    return lastOf(rows);
  }
  if (b.type === 'paragraph' && text === '' && !(Array.isArray(b.children) && b.children.length)) {
    const [first, ...rest] = rows;
    b.type = first.type;
    if (first.level) b.level = first.level; else delete b.level;
    delete b.toggle;
    if (first.type === 'todo') b.checked = first.checked;
    if (first.type === 'callout' && !b.icon) b.icon = blockEdit.CALLOUT_ICON;
    if (b.citeState === undefined) b.citeState = 'manual';
    putRich(b, first.rich || [{ t: first.text }]);
    retext(b, first.text);
    if (first.children) b.children = first.children;
    l.list.splice(l.index + 1, 0, ...rest);
    return lastOf([b, ...rest]);
  }
  const [r1, r2] = blockEdit.splitRich(a.rich, a.at);
  putRich(b, r1);
  retext(b, text.slice(0, a.at));
  const after = [...rows];
  const tail = text.slice(a.at);
  if (tail !== '') {
    // 後ろの文の行の型は Enter と同じ nextTypeOnEnter（0.14.0 の BQ32: 2026-10-30 の持ち主の答え「Enter と同じにする」。見出しの後ろは箇条書き・
    // 引用とコールアウトの後ろはテキスト・開いたトグルの中はテキスト・閉じたトグルの後ろはトグル）。飾りは続きのまま。人の行・出典なし・担当と期限なし
    const nt = blockEdit.nextTypeOnEnter(b, { open: a.inside === true });
    const nb = { id: freshId(db, ctx, new Set(BT.flattenBlocks(rows).map((x) => x.id))), type: nt.type, text: tail, cites: [], citeState: 'manual' };
    if (nt.level) nb.level = nt.level;
    if (nt.toggle === true) nb.toggle = true;
    if (nt.type === 'todo') nb.checked = false;
    putRich(nb, r2);
    after.push(nb);
  }
  if (a.inside === true) { if (!Array.isArray(b.children)) b.children = []; b.children.splice(0, 0, ...after); }   // R66: 子の見えている行の文の終わりは最初の子
  else l.list.splice(l.index + 1, 0, ...after);
  return lastOf(rows);
}
// 貼り付けの送り直し: oplog の1行の add の行のうち、画面の順で最後に貼った行（後ろの文の行を作ったときは、その1つ前）。足した行が無ければ今の行
function pasteDup(db, a, row) {
  const page = readPage(db, a.pageId);
  if (!page) return null;
  const added = new Set(JSON.parse(row.ops || '[]').filter((o) => o && o.op === 'add' && o.row && !isDocType(o.row.type)).map((o) => o.id));
  const order = BT.flattenBlocks(page.blocks).map((b) => b.id).filter((id) => added.has(id));
  const text = RT.plainOf(a.rich);
  if (a.at > 0 && a.at < text.length) order.pop();
  return { page, lastId: order.length ? order[order.length - 1] : a.blockId };
}
// ---------------------------------------------------------------- 0.15.0 PH-2: ページの木の命令（決めたこと 1〜17・HR6）
// ページの行の全部（ゴミ箱・録音中の写しも）→ [{ id, parentId, ord, title, createdAt, trashedAt, attrs }]（pageTree の行の形）
// attrs は取り出した欄だけの小さな物（meeting.phase・kind・icon。isLive と一覧の印がそのまま使える: R12）
function pageRowsOf(db) {
  return db.prepare(HOT_QUERIES.pageRows).all().map((r) => {
    const attrs = {};
    if (r.phase !== null && r.phase !== undefined) attrs.meeting = { phase: r.phase };
    if (r.kind !== null && r.kind !== undefined) attrs.kind = r.kind;
    if (r.icon !== null && r.icon !== undefined) attrs.icon = r.icon;
    return { id: r.id, parentId: r.parent_id ?? null, ord: r.ord, title: r.text, createdAt: r.created_at, trashedAt: r.trashed_at ?? null, attrs };
  });
}
// 一覧に出るページか（ゴミ箱と録音中の写しは除く。listedRows と同じ決まり）
const isListedRow = (r) => Boolean(r) && r.trashedAt === null && !isLive(r.attrs);
// ページの行を最上位へ出す操作（決めたこと 4。最上位の鍵は 'i'）
const topMove = (r) => ({ op: 'move', id: r.id, ord: PT.TOP_ORD, old: r.ord, parent: null, oldParent: r.parentId });

// 新しいページの ID（決めたこと 14: store.newId と同じ形の p＋時刻の36進＋5字の小文字の英数。タブの鍵 ^page:p[a-z0-9]{1,40}$ に合う）
// rand は 32 ビットの乱数を返す関数（テストが重なりの照らしを見るために渡す。既定は crypto）
const randU32 = () => crypto.randomBytes(4).readUInt32BE(0);
function newPageId(db, now, rand = randU32) {
  for (;;) {
    const tail = rand().toString(36).padStart(7, '0').slice(-5);
    const id = `p${now().getTime().toString(36)}${tail}`;
    if (!db.prepare(HOT_QUERIES.pageRow).get(id)) return id;
  }
}

// 白紙のページを作る（決めたこと 13・14・24。親は一覧に出るページだけ。子は兄弟の末尾）→ { page, id }
function pageCreate(db, a, ctx) {
  const rows = pageRowsOf(db);
  const parentId = a.parentId || null;
  let inRow = false;
  if (parentId !== null) {
    const host = rows.find((r) => r.id === parentId);
    const scope = rowScope(db, rows);
    if (!host) {
      // 0.16.0 R97（M14）: 生きているデータベースの行の中（行の本文の /ページ）。行の本文に子ページの行を置けないなら作らない（行の無い子は見つけられない）
      const ri = scope.row(parentId);
      if (!ri || !ri.live) throw refuse('bad-args');
      inRow = true;
    } else {
      if (host.trashedAt !== null) throw refuse('bad-args');   // 無い・ゴミ箱のページの中には作らない
      if (isLive(host.attrs)) throw refuse('bad-args');   // 録音中の写しの中には作らない（決めたこと 9）
      if (isDbPage(host.attrs)) throw refuse('bad-args');   // 0.16.0 DS-3（決めたこと 42）: データベースの中にページを作らない
      const s = scope.page(parentId);
      if (s && !s.live) throw refuse('bad-args');   // R97: ゴミ箱の行の中の（見えない）ページの中にも作らない
    }
  }
  const id = newPageId(db, ctx.now);
  const at = ctx.now();
  const ords = new Map(rows.map((r) => [r.id, r.ord]));
  const ord = parentId === null ? PT.TOP_ORD : PT.siblingKey(inRow ? rowKidsTree(rows, parentId) : PT.pageTree(rows), ords, parentId, undefined);
  const page = { id, title: '', kind: 'blank', date: localDate(at), memo: '', blocks: [], createdAt: at.toISOString(), updatedAt: at.toISOString() };
  const ops = [{ op: 'add', id, row: { ...pageRow(page, { ord }), parent_id: parentId } }];
  // 0.15.0 PR-1（決めたこと 45・HR13）: 白紙のページの中なら、同じ命令でその本文に子ページの行（placeAt の所か本文の最後）。議事録の中には作らない（BQ3）
  const body = parentId === null || !(inRow || isBlankPage(rows.find((r) => r.id === parentId).attrs)) ? null : bodyOps(db, parentId, ctx, (p) => placeSubRow(p, newSubRow(db, ctx, id), { placeAt: a.placeAt }));
  if (inRow && !body) throw refuse('too-big');   // R97: 満杯の行の本文（R33 の白紙のページと違い、行の無い子は「このページの中のページ」にも出ないので作らない）
  if (body) ops.push(...body);
  applyOps(db, ops);
  return { ops, pageIds: body ? [id, parentId] : [id], result: { page: readPage(db, id), id } };
}

// 動かす（決めたこと 4・5・9・16・21）。'' は最上位。afterId は兄弟の後ろ（'' は頭・無ければ末尾。最上位は鍵で並べないので見ない）→ 一覧
function pageMove(db, a, ctx) {
  const raw = pageRowsOf(db);
  const rows = withBodyOrds(db, raw);   // 0.15.0 PR-1（HR14）: 白紙のページの子は本文の行の順で「同じ所」と兄弟の鍵を見る
  const stored = new Map(raw.map((r) => [r.id, r.ord]));   // PR-1 直し（R32）: 操作の old は表に書いてある ord（本文の順から作った鍵でない）
  const tree = PT.pageTree(rows);
  const me = tree.byId.get(a.id);
  if (!me || me.trashedAt !== null) throw refuse('bad-args');   // 無い・ゴミ箱のページは動かさない
  if (isLive(me.attrs)) throw refuse('bad-args');   // 録音中の写しは動かさない（決めたこと 9）
  // 0.16.0 R97（M14）: ゴミ箱の行の中の（見えない）ページは動かさない。行の中へは、生きている行だけ（行の本文の最後に子ページの行）
  const scope = rowScope(db, raw);
  const mine = scope.page(a.id);
  if (mine && !mine.live) throw refuse('bad-args');
  const to = a.parentId || null;
  const toRow = to !== null && !tree.byId.has(to);
  if (toRow) {
    const ri = scope.row(to);
    if (!ri || !ri.live) throw refuse('bad-args');
  } else if (to !== null) {
    const dest = tree.byId.get(to);
    if (dest.trashedAt !== null) throw refuse('bad-args');   // ゴミ箱のページの下へは動かさない
    if (isLive(dest.attrs)) throw refuse('bad-args');   // 録音中の写しの下へは動かさない
    if (isDbPage(dest.attrs)) throw refuse('bad-args');   // 0.16.0 DS-3（決めたこと 42）: データベースの中へページを入れない（行と混ぜない）
    const s = scope.page(to);
    if (s && !s.live) throw refuse('bad-args');   // R97: ゴミ箱の行の中の（見えない）ページの下へは動かさない
  }
  if (!PT.canMoveUnder(tree, a.id, to)) throw refuse('bad-args');   // 自分と子孫の下へは動かさない（輪: 決めたこと 5）
  if (to !== null && rawChainHas(tree.byId, to, a.id)) throw refuse('bad-args');   // PH-2 直し（R13）: 壊れた輪の上の親をたどって自分に戻る所へも動かさない
  if (to !== null && chainThroughRows(db, tree.byId, to, a.id)) throw refuse('bad-args');   // R97: 行を通って自分に戻る所（自分の下のデータベースの行の中）へも動かさない
  // 0.15.0 PR-2 直し（R44・決めたこと 55）: rowAfter（と rowParent）は、同じ白紙のページの子の行を本文のその所へ置く（行の無い子を「このページの中のページ」から引っ張って置く）
  if (a.rowAfter !== undefined || a.rowParent !== undefined) return placeInBody(db, a, ctx, me, to, tree, toRow);
  // 本文を読むのは白紙のページだけ（R97: とデータベースの行。ページの木に無い親は行か無い ID）
  const blank = (id) => id !== null && (tree.byId.has(id) ? isBlankPage(tree.byId.get(id).attrs) : isRowId(db, id));
  // PH-5 直し 2（R56・M-5）: 本文に行のある子を同じ白紙の親へ afterId なしで動かす（［移動先…］で親だけを選ぶ）と、最後の兄弟でも行を本文の最後へ（R54）。
  // 行がもう本文の最後なら同じ所
  // PH-6・PH-7 直し（rv29 F1・決めたこと 16）: ゴミ箱・録音中の写し・知らない・兄弟でない afterId は末尾（placeKeys と placeSubRow と同じ）なので、
  // 末尾として「同じ所」を見る（sameSpot も同じ決まり）
  const endAfter = a.afterId === undefined || (a.afterId !== '' && a.afterId !== a.id && !(tree.parent.get(a.afterId) === to && isListedRow(tree.byId.get(a.afterId))));
  const toEnd = endAfter && me.parentId === to && blank(to) && subRowNotLast(db, to, a.id);
  // 同じ所は書かない（操作の空の行だけ: 決めたこと 16）。PH-2 直し（R12）: 答えの一覧は同じ所のときだけ作る（前は毎回作って、動かすと一覧を2回作った）
  if (!toEnd && sameSpot(rows, me, to, a.afterId)) return { ops: [], pageIds: [], result: listPages(db) };
  // PH-2 直し（R16）: 兄弟は一覧に出るページだけ（ゴミ箱・録音中の写しの兄弟は並びに数えない）。同じ鍵の後ろの兄弟は付け直す（R15）
  const others = rows.filter((r) => r.id !== a.id && isListedRow(r));
  // 0.15.0 PR-1（決めたこと 45・46・48・HR12）: 同じ命令で、前の親（白紙のページ）の本文の行を外し、新しい親（白紙のページ）の本文に置く
  // （兄弟の後ろなら兄弟の行のすぐ後ろ・頭なら兄弟の最初の行の前・ほかは本文の最後）。同じ白紙のページの中の並べ替えは行を動かす
  // PH-5 直し 2（R56）: 本文の操作を先に作り、ページの行の move はその後で頭に積む（行を置けたかで並びの鍵の作り方が替わる）
  const ops = [];
  const sibs = new Set(to === null ? [] : PT.pageTree(others).kids.get(to) || []);
  const hosts = [];
  const put = (p) => placeSubRow(p, newSubRow(db, ctx, a.id), { afterPage: a.afterId, sibs });
  const add = (id, list) => { if (list) { ops.push(...list); hosts.push(id); } };
  // PH-6・PH-7 直し（rv29 F1）: 同じ白紙の親の中で、本文の行の並びが変わらない（行がもう置く所にある）なら、見える並び（本文の行の順: HR14）も
  // 変わらないので書かない（行の無い兄弟の後ろ・満杯の本文でも）
  let still = false;
  const putSame = (p, was) => { const sig = rowSig(p.blocks); put(p, was); if (subSpot(p.blocks, a.id) && rowSig(p.blocks) === sig) { still = true; return false; } return undefined; };
  if (me.parentId === to) { if (blank(to)) add(to, bodyOps(db, to, ctx, putSame)); }
  else {
    if (blank(me.parentId)) add(me.parentId, bodyOps(db, me.parentId, ctx, (p, was) => (takeSubRow(p, was, a.id) ? undefined : false)));
    if (blank(to)) add(to, bodyOps(db, to, ctx, put));
  }
  // PH-5 直し 2（R56。R53 を直す）: 白紙の親の本文に行を置けなかった（満杯の本文: R33）子は、行の無い子の中で表の ord で並ぶ（withBodyOrds）ので、
  // 鍵は本文の順から作った鍵でなく、行の無い兄弟の表の ord の間で作る（afterId が行の無い兄弟ならその後ろ・'' か行のある兄弟なら行の無い子の頭・無ければ末尾）
  if (still) return { ops: [], pageIds: [], result: listPages(db) };
  // R97: 行の本文に子ページの行を置けない（満杯）なら動かさない（行の無い行の子は見つけられない）。同じ行の中なら今の所のまま
  if (toRow && !hosts.includes(to)) {
    if (me.parentId === to) return { ops: [], pageIds: [], result: listPages(db) };
    throw refuse('too-big');
  }
  const rowless = !toRow && blank(to) && !hosts.includes(to) ? rowlessSpot(db, raw, others, to, me, a.afterId === a.id ? undefined : a.afterId) : null;
  // PH-5 直し 4（R61）: 行の無い子の中で今と同じ所（頭を頭へ・前の兄弟の後ろへ・最後をゴミ箱の兄弟の後ろへ）なら書かない（決めたこと 16）
  if (rowless && rowless.same) return { ops: [], pageIds: [], result: listPages(db) };
  const place = to === null ? { ord: PT.TOP_ORD, rekey: [] }
    : toRow ? PT.placeKeys(rowKidsTree(others, to), new Map(others.map((r) => [r.id, r.ord])), to, a.afterId === a.id ? undefined : a.afterId)
    : rowless ? PT.placeKeys(PT.pageTree([raw.find((r) => r.id === to), ...rowless.rows]), stored, to, rowless.at)
      : PT.placeKeys(PT.pageTree(others), new Map(others.map((r) => [r.id, r.ord])), to, a.afterId === a.id ? undefined : a.afterId);
  ops.unshift({ op: 'move', id: a.id, ord: place.ord, old: stored.get(a.id), ...(me.parentId !== to ? { parent: to, oldParent: me.parentId } : {}) },
    ...place.rekey.map(([id, ord]) => ({ op: 'move', id, ord, old: stored.get(id) })));
  applyOps(db, ops);
  return { ops, pageIds: [a.id, ...hosts], result: listPages(db) };
}
// 0.16.0 R97: 本文にそのページを指す子ページの行があるか（文と欄は読まない）
const hasSubRow = (db, hostId, pageId) => db.prepare(HOT_QUERIES.bodyRows).all(hostId, hostId).some((r) => r.type === 'subpage' && r.sub === pageId);
// PH-5 直し 2（R56）: 白紙のページの本文で、そのページの行が本文の最後（最上位の並びの末尾）に無いか（行が無ければ偽）
function subRowNotLast(db, hostId, pageId) {
  const rows = db.prepare(HOT_QUERIES.bodyRows).all(hostId, hostId);
  if (!rows.some((r) => r.type === 'subpage' && r.sub === pageId)) return false;
  const top = rows.filter((r) => (r.parent_id ?? hostId) === hostId);
  const last = top[top.length - 1];
  return !(last && last.type === 'subpage' && last.sub === pageId);
}
// PH-5 直し 2（R56）: 行の無い兄弟（白紙の親 to の一覧に出る子で、本文に行の無いもの。表の行で）と、その中の置き場 at（placeKeys の afterId）。
// afterId が行の無い兄弟ならその後ろ・'' か行のある兄弟なら行の無い子の頭・ほか（ゴミ箱・録音中の写し・知らない ID。PH-5 直し 4（R61）: 満杯でない本文と同じく）は末尾。
// same は me が今もその所にいるか（me が to の子のとき。並びは一覧と同じ表の ord と作った順: withBodyOrds）
function rowlessSpot(db, raw, others, to, me, afterId) {
  const rowed = new Set(bodySubOrder(db.prepare(HOT_QUERIES.bodyRows).all(to, to), to));
  const byId = new Map(raw.map((r) => [r.id, r]));
  const rows = others.filter((r) => r.parentId === to && !rowed.has(r.id)).map((r) => byId.get(r.id));
  const rowedKid = (id) => others.some((r) => r.id === id && r.parentId === to && rowed.has(r.id));
  const at = afterId === undefined ? undefined : rows.some((r) => r.id === afterId) ? afterId : afterId === '' || rowedKid(afterId) ? '' : undefined;
  let same = false;
  if (me.parentId === to) {
    const order = [...rows, byId.get(me.id)].sort((x, y) => cmpStr(x.ord, y.ord) || cmpStr(x.createdAt, y.createdAt)).map((r) => r.id);
    const i = order.indexOf(me.id);
    same = at === undefined ? i === order.length - 1 : at === '' ? i === 0 : i > 0 && order[i - 1] === at;
  }
  return { rows, at, same };
}
// 0.15.0 PR-2 直し（R44・決めたこと 55）: 白紙のページの子（me）の行を、同じ本文の rowAfter の行のすぐ後ろ（'' は頭・rowParent があればその子の頭。
// block.move の afterId・parentId と同じ置き場: BT.spotOf）へ。行が無ければ作り（上限を越えるなら too-big。本文もページも変えない）、あれば動かす（同じページを
// 指す行を2つにしない）。ページの親と並びの鍵は変えない（並びは本文の行の順: HR14）。同じ命令（oplog の1行）で、元に戻すの歩みにはしない（決めたこと 60）→ 一覧
function placeInBody(db, a, ctx, me, to, tree, toRow = false) {
  if (a.rowAfter === undefined || a.afterId !== undefined || to === null || me.parentId !== to || !(toRow || isBlankPage(tree.byId.get(to).attrs))) throw refuse('bad-args');   // R97: 行の本文も
  let made = false;
  const ops = bodyOps(db, to, ctx, (p) => {
    const had = subSpot(p.blocks, a.id);
    // PR-2 直し 3（R46）: 自分の行の後ろは今の所（block.move の afterId === blockId と同じく書かない。前は行を抜いてから探して bad-args）。親の違う rowParent は断る
    if (had && a.rowAfter === had.b.id) {
      if (a.rowParent !== undefined && (!had.parent || had.parent.id !== a.rowParent)) throw refuse('bad-args');
      return false;
    }
    let row;
    if (had) { row = had.b; had.list.splice(had.index, 1); } else { row = newSubRow(db, ctx, a.id); made = true; }
    if (a.rowAfter !== '' && !BT.locate(p.blocks, a.rowAfter)) throw refuse('bad-args');
    const s = BT.spotOf(p.blocks, a.rowAfter, a.rowParent);
    if (!s) throw refuse('bad-args');   // 無い親の行・子を持てない行（区切り線・子ページの行）・親の違う行
    s.list.splice(s.index, 0, row);
  });
  if (!ops) { if (made) throw refuse('too-big'); return { ops: [], pageIds: [], result: listPages(db) }; }
  applyOps(db, ops);
  return { ops, pageIds: [a.id, to], result: listPages(db) };
}
// PH-2 直し（R13）: start から「そのままの親」（parent_id）をたどって id に着くか（木の部品は輪の行を最上位に並べるので、壊れた輪の上では
// canMoveUnder が見ない道がある。訪ねた印で止まる）
function rawChainHas(byId, start, id) {
  const seen = new Set();
  for (let cur = start; cur !== null && cur !== undefined && !seen.has(cur); cur = byId.has(cur) ? byId.get(cur).parentId : null) {
    if (cur === id) return true;
    seen.add(cur);
  }
  return false;
}
// 今と同じ所か（最上位は並びが日付なので、最上位どうしはいつも同じ所。兄弟の中は今の前の兄弟と afterId で見る）
// PH-2 直し（R16）: 兄弟は一覧に出るページだけで見る（間のゴミ箱の兄弟を数えない）
function sameSpot(rows, me, to, afterId) {
  if (me.parentId !== to) return false;
  if (to === null) return true;
  if (afterId === me.id) return true;
  const sibs = PT.pageTree(rows.filter((r) => r.id === me.id || isListedRow(r))).kids.get(to) || [];
  const i = sibs.indexOf(me.id);
  if (afterId !== undefined && afterId !== '' && !sibs.includes(afterId)) afterId = undefined;   // PH-6・PH-7 直し（rv29 F1）: 兄弟でない ID は末尾（placeKeys と同じ）
  if (afterId === undefined) return i === sibs.length - 1;
  if (afterId === '') return i === 0;
  return i > 0 && sibs[i - 1] === afterId;
}

// ゴミ箱から戻す（決めたこと 31・HR6）。一緒に消した子孫も。親がゴミ箱のまま・無いなら同じ命令で最上位へ → 一覧
function pageRestore(db, a, ctx) {
  const rows = pageRowsOf(db);
  const tree = PT.pageTree(rows);
  const me = tree.byId.get(a.id);
  if (!me) throw refuse('bad-args');
  if (isLive(me.attrs)) throw refuse('bad-args');   // PH-2 直し（R17）: 録音中の写しはゴミ箱から戻さない（写しの正本は録音のメモリと下書き）
  if (me.trashedAt === null) return { ops: [], pageIds: [], result: listPages(db) };   // ゴミ箱に無い（ほかの窓で戻した）
  const at = ctx.now().toISOString();
  // 一緒に消したまとまりの中の録音中の写し（壊れた行）は戻さない（R17）。木は1回だけ作る（R11）
  const group = PT.restoreGroup(rows, a.id, tree).filter((id) => !isLive(tree.byId.get(id).attrs));
  const ops = group.map((id) => ({ op: 'restore', id, at, old: tree.byId.get(id).trashedAt }));
  const host = me.parentId === null ? null : tree.byId.get(me.parentId);
  // 0.16.0 R97（M14）: 親がデータベースの行なら、行が生きているときだけその本文へ戻す（ゴミ箱の行・ゴミ箱のデータベースの行の下は見えない所）。
  // 親のページがゴミ箱の行の中（見えない）なら、そこへも戻さない
  const scope = rowScope(db, rows);
  const hostRowInfo = me.parentId !== null && !host ? scope.row(me.parentId) : null;
  const hostSeen = host ? isListedRow(host) && !(scope.page(host.id) && !scope.page(host.id).live) : Boolean(hostRowInfo && hostRowInfo.live);
  // PR-1 直し（R34）: 最上位へ出すページの行が、ゴミ箱の白紙の親の本文に残っていれば同じ命令で消す（後で親を戻したときに灰色の行を残さない）
  const left = host && host.trashedAt !== null && isBlankPage(host.attrs) ? bodyOps(db, host.id, ctx, (p, was) => (takeSubRow(p, was, a.id) ? undefined : false), { trashed: true }) : null;
  if (left) ops.push(...left);
  // 0.15.0 PR-1（決めたこと 45・54・HR15）: 親が白紙のページなら、同じ命令でその本文に行を戻す（覚えた置き場がまだあればそこ・無ければ本文の最後。
  // 行がもうあれば足さない）。覚えた置き場は戻したら消す
  const rowAt = rowAtOf(db, a.id);
  const body = me.parentId !== null && hostSeen && (hostRowInfo || isBlankPage(host.attrs))
    ? bodyOps(db, me.parentId, ctx, (p, was) => (subSpot(p.blocks, a.id) ? false : putBackSubRow(p, was, newSubRow(db, ctx, a.id), rowAt)))
    : null;
  // R97: 行の本文に行を戻せない（満杯）なら最上位へ（行の無い行の子は見つけられない）。もう本文に行があれば戻せる
  const rowBack = !hostRowInfo || body || hasSubRow(db, me.parentId, a.id);
  if (me.parentId !== null && (!hostSeen || !rowBack)) ops.unshift(topMove(me));   // 見えない所（ゴミ箱・録音中の写しの親の下・無い親）に戻さない
  if (body) ops.push(...body);
  if (rowAt !== undefined) ops.push({ op: 'set', id: a.id, key: 'rowAt', value: undefined, old: rowAt });
  applyOps(db, ops);
  return { ops, pageIds: body ? [a.id, me.parentId] : [a.id], result: listPages(db) };
}

// ゴミ箱の頭（一緒に消したまとまりの頭だけ。消した新しい順・200 まで: 決めたこと 32）→ [{ id, title, kind?, icon?, trashedAt, count }]
const TRASH_MAX = 200;
function trashHeads(db) {
  const rows = pageRowsOf(db);
  const tree = PT.pageTree(rows);   // 木は1回だけ作る（R11）。親は木の親（壊れた輪の行は最上位: R14）
  const heads = rows.filter((r) => r.trashedAt !== null && !isLive(r.attrs))
    .filter((r) => { const up = tree.byId.get(tree.parent.get(r.id)); return !up || up.trashedAt !== r.trashedAt; });
  heads.sort((x, y) => (x.trashedAt < y.trashedAt ? 1 : x.trashedAt > y.trashedAt ? -1 : 0));
  return heads.slice(0, TRASH_MAX).map((r) => {
    const out = { id: r.id, title: r.title };
    if (r.attrs.kind === 'blank') out.kind = 'blank';
    if (typeof r.attrs.icon === 'string' && r.attrs.icon) out.icon = r.attrs.icon;
    out.trashedAt = r.trashedAt;
    out.count = PT.restoreGroup(rows, r.id, tree).length - 1;
    return out;
  });
}

// ---------------------------------------------------------------- 0.15.0 PR-1: 白紙のページの本文の子ページの行（計画の決めたこと 43〜60・HR12〜HR18・F123）
// 行は { id, type: 'subpage', text: '', page }（page は attrs の欄）。木の正本は子のページの parent_id で、行は「本文のどこに並ぶか」だけ（HR17）。
// 作る・動かす・戻す・ほかの所で消す命令は、ページの行の操作と本文の行の操作を同じ命令（同じ oplog の1行）に積む（決めたこと 44）
const isSubRow = (b) => isObj(b) && b.type === 'subpage';
const isBlankPage = (attrs) => isObj(attrs) && attrs.kind === 'blank';
// ---------------------------------------------------------------- 0.16.0 R97（2026-11-09 の持ち主の答え・M14）: データベースの行の中の子ページ
// 行（型 row）は本文を白紙のページと同じ部品で持つので、行の本文の /ページ で行を親にした白紙のページを作れる。そのページと子孫はページの木の外
// （木の行 rows に親が無い）で、サイドバーに出さない。rows（pageRowsOf か listedRows の行）について、
//   page(id) … id のページから親をたどって最初に出会う行（rows に無い親が型 row）→ { row, title, db, dbTitle, live }。行の下でなければ null
//   row(id)  … id が行なら { row, title, db, dbTitle, live }（無い・行でなければ null）
// live は行がゴミ箱でなく、データベースが rows にあってゴミ箱でないデータベースのページで、データベースも死んだ行の下でないとき。
// 親をたどる道は1回ずつ覚える（輪は行の下でないとみなす）。行の問い合わせは rows に無い親のときだけ（主キー）
function rowScope(db, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const pages = new Map();
  const rowsMemo = new Map();
  const busy = new Set();
  const alive = (r) => Boolean(r) && (r.trashedAt === null || r.trashedAt === undefined);
  const parentOf = (r) => (r && typeof r.parentId === 'string' && r.parentId ? r.parentId : null);
  function row(id) {
    if (rowsMemo.has(id)) return rowsMemo.get(id);
    rowsMemo.set(id, null);   // 輪の見張り（データベースの道が同じ行に戻る）
    const r = db.prepare(HOT_QUERIES.dbRow).get(id);
    let info = null;
    if (r && r.type === 'row') {
      const d = byId.get(r.parent_id);
      const up = d ? page(d.id) : null;
      const live = (r.trashed_at === null || r.trashed_at === undefined) && alive(d) && isDbPage(d.attrs) && !isLive(d.attrs) && (!up || up.live);
      info = { row: r.id, title: r.text, db: r.parent_id, dbTitle: d ? d.title : '', live };
    }
    rowsMemo.set(id, info);
    return info;
  }
  function page(start) {
    const path = [];
    let info = null;
    for (let cur = start; ;) {
      if (pages.has(cur)) { info = pages.get(cur); break; }
      if (busy.has(cur)) break;
      busy.add(cur); path.push(cur);
      const p = parentOf(byId.get(cur));
      if (p === null) break;
      if (!byId.has(p)) { info = row(p); break; }
      cur = p;
    }
    for (const id of path) { pages.set(id, info); busy.delete(id); }
    return info;
  }
  return { page: (id) => (byId.has(id) ? page(id) : null), row };
}
// R97: 本文に子ページの行を持つページ（白紙のページと、データベースの行）か。rows は木の行（行は入らない）
const isRowId = (db, id) => (db.prepare(HOT_QUERIES.typeOf).get(id) || {}).type === 'row';
// R97: start から親をたどって id に着くか（行を通るときは行のデータベースへ。輪を作る置き場を断る）
function chainThroughRows(db, byId, start, id) {
  const seen = new Set();
  for (let cur = start; cur !== null && cur !== undefined && !seen.has(cur);) {
    if (cur === id) return true;
    seen.add(cur);
    if (byId.has(cur)) { cur = byId.get(cur).parentId; continue; }
    const r = db.prepare(HOT_QUERIES.dbRow).get(cur);
    cur = r && r.type === 'row' ? r.parent_id : null;
  }
  return false;
}
// R97: 行の子の並びの鍵の木（行を根にした小さな木。ページの木では行の子は親の無い行なので兄弟に数えられない）
const rowKidsTree = (rows, rowId) => PT.pageTree([{ id: rowId, parentId: null }, ...rows.filter((r) => r.parentId === rowId)]);
const cmpStr = (x, y) => (String(x ?? '') < String(y ?? '') ? -1 : String(x ?? '') > String(y ?? '') ? 1 : 0);
// 本文の中の、そのページを指す子ページの行の居場所（BT.locate の形。無ければ null。同じページを指す行が2つあれば先の行）
function subSpot(blocks, pageId) {
  const w = BT.walk(blocks).find((x) => isSubRow(x.b) && x.b.page === pageId);
  return w ? BT.locate(blocks, w.b.id) : null;
}
// 白紙のページの本文を直す操作（当てない。呼び手がページの行の操作と1つの列にして当てる）。白紙のページでない・無い・fn が false なら null
// PR-1 直し（R33・決めたこと 58）: 行を足して本文が LIMITS.blocks を越えるなら、本文は変えない（null。ページの命令はそのまま通し、行の無い子は
// 「このページの中のページ」に出る: 決めたこと 55。ページを断らない・失わない）。trashed はゴミ箱の白紙のページの本文も読む（R34）
function bodyOps(db, pageId, ctx, fn, { trashed = false } = {}) {
  const w = forWrite(db, pageId, { trashed });
  if (!w || !(isBlankPage(w.was.page) || isRowId(db, pageId))) return null;   // 0.16.0 R97: データベースの行の本文も
  const n0 = BT.flattenBlocks(w.page.blocks).length;
  if (fn(w.page, w.was) === false) return null;
  const n = BT.flattenBlocks(w.page.blocks).length;
  if (n > n0 && n > LIMITS.blocks) return null;
  return saveOps(w.was, w.page, ctx.now);
}
// 子ページの行を置く（決めたこと 45・48・HR12・HR13）。本文にそのページの行がもうあれば（前の版の行・食い違った行）、新しく作らずに動かす。
// placeAt（/ページ を打った行）: 文も子も無いテキストの行ならその行を子ページの行に替え（同じ ID）、ほかの行ならすぐ下。afterPage が兄弟の
// ページの ID ならその行のすぐ後ろ・'' なら兄弟（sibs）の最初の行の前。どれも無ければ本文の最後（最上位の並びの末尾）
function placeSubRow(p, row, { placeAt, afterPage, sibs } = {}) {
  const had = subSpot(p.blocks, row.page);
  let me = row;
  if (had) { me = had.b; had.list.splice(had.index, 1); }
  if (placeAt !== undefined) {
    const l = BT.locate(p.blocks, placeAt);
    if (l && l.b.type === 'paragraph' && String(l.b.text || '') === '' && !(Array.isArray(l.b.children) && l.b.children.length)) {
      l.list[l.index] = { id: l.b.id, type: 'subpage', text: '', page: row.page };
      return;
    }
    if (l) { l.list.splice(l.index + 1, 0, me); return; }
  }
  if (typeof afterPage === 'string' && afterPage !== '') {
    const s = subSpot(p.blocks, afterPage);
    if (s) { s.list.splice(s.index + 1, 0, me); return; }
  } else if (afterPage === '' && sibs) {
    const first = BT.walk(p.blocks).find((x) => isSubRow(x.b) && x.b.page !== row.page && sibs.has(x.b.page));
    if (first) { const s = BT.locate(p.blocks, first.b.id); s.list.splice(s.index, 0, me); return; }
  }
  p.blocks.push(me);
}
// 本文の行の並びの形（行の ID と本文の中の親の並び。文や飾りは見ない）。PH-6・PH-7 直し（rv29 F1）: 行を置いても並びが変わらないかを見る
const rowSig = (blocks) => BT.walk(blocks).map((w) => `${w.b.id}<${w.parentId}`).join('\n');
// 本文からそのページの行を外す → 外した行の置き場 { parent（本文の中の親の行の ID か、最上位ならページの ID）, ord }（子の attrs.rowAt の形）か null
function takeSubRow(p, was, pageId) {
  const l = subSpot(p.blocks, pageId);
  if (!l) return null;
  l.list.splice(l.index, 1);
  return { parent: l.parent ? l.parent.id : p.id, ord: was.ords[l.b.id] };
}
// 覚えた置き場（rowAt）に行を戻す（HR15。置き場の親がまだこの本文にあって子を持てるなら、その子の並びの鍵の順の所。無ければ本文の最後）
function putBackSubRow(p, was, row, at) {
  if (isObj(at) && typeof at.ord === 'string' && typeof at.parent === 'string') {
    let list = null;
    if (at.parent === p.id) list = p.blocks;
    else {
      const l = BT.locate(p.blocks, at.parent);
      if (l && BT.kidsCan(l.b)) { if (!Array.isArray(l.b.children)) l.b.children = []; list = l.b.children; }
    }
    if (list) {
      let i = 0;
      while (i < list.length && !(typeof was.ords[list[i].id] === 'string' && was.ords[list[i].id] > at.ord)) i++;
      list.splice(i, 0, row);
      return;
    }
  }
  p.blocks.push(row);
}
const newSubRow = (db, ctx, pageId) => ({ id: newBlockId(db, ctx.now), type: 'subpage', text: '', page: pageId });
// ページの行の rowAt（今の値。無ければ undefined）
function rowAtOf(db, id) {
  const r = db.prepare(HOT_QUERIES.pageRow).get(id);
  const attrs = r ? JSON.parse(r.attrs || '{}') : {};
  return attrs.rowAt;
}
// 消した行の中の子ページの行 → [{ page, parent, ord }]（rows は消す行。子孫の行も。parent は本文の中の親の行かページの ID）
function goneSubRows(rows, topParent, was) {
  const out = [];
  const go = (list, parent) => {
    for (const b of list) {
      if (!isObj(b)) continue;
      if (isSubRow(b) && typeof b.page === 'string') out.push({ page: b.page, parent, ord: was.ords[b.id] });
      if (Array.isArray(b.children)) go(b.children, b.id);
    }
  };
  go(rows, topParent);
  return out;
}
// 子ページの行を消した命令（block.remove・blocks.remove）の後: 行の指すページのうち今のこのページの子（一覧に出るページ）を、ゴミ箱に入っていない
// 子孫ごと同じ時刻でゴミ箱へ（決めたこと 49。page.delete と同じ組: 決めたこと 30）。消した行の置き場は子の rowAt に（ゴミ箱から戻すと元の所: HR15）。
// 今の子でないページを指す行（HR16 の灰色の行）は消してもページを何もしない → { ops（当てない）, n（ゴミ箱に入れたページの数） }
function trashRowPages(db, pageId, gone, ctx) {
  if (!gone.length) return { ops: [], n: 0 };
  const rows = pageRowsOf(db);
  const tree = PT.pageTree(rows);   // 木は1回だけ作る（R11）
  const at = ctx.now().toISOString();
  const seen = new Set();
  const trash = [];
  const marks = [];
  for (const g of gone) {
    const r = tree.byId.get(g.page);
    if (!r || r.parentId !== pageId || !isListedRow(r) || seen.has(r.id)) continue;
    for (const id of PT.trashGroup(rows, r.id, tree)) {
      if (seen.has(id)) continue;
      seen.add(id);
      trash.push({ op: 'trash', id, at, old: tree.byId.get(id).trashedAt });
    }
    marks.push({ op: 'set', id: r.id, key: 'rowAt', value: { parent: g.parent, ord: g.ord }, old: rowAtOf(db, r.id) });
  }
  return { ops: [...trash, ...marks], n: seen.size };
}
// 行を消す命令の答え: 子ページの行のページをゴミ箱に入れたら、同じ命令に積んで当て、答えのページに trashed（数）を添える（無ければ今の答えのまま）
function withRowPages(db, a, ctx, out, gone) {
  const t = trashRowPages(db, a.pageId, gone, ctx);
  if (!t.ops.length) return out;
  applyOps(db, t.ops);
  return { ops: [...out.ops, ...t.ops], pageIds: out.pageIds, result: out.result ? { ...out.result, trashed: t.n } : out.result };
}
// 白紙のページの子の並びの鍵（HR14・決めたこと 47）: rows（listedRows か pageRowsOf の行）のうち、白紙のページの子の ord を本文の子ページの行の順
// （本文を上から読んだ順。トグルの中も）の等しい間の鍵に置き換えた写し。行の無い子（前の版で行を消した）は後ろに、今の ord の順。子のある白紙の
// ページの本文だけを読む（文と欄は読まない: HOT_QUERIES.bodyRows）
function withBodyOrds(db, rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const kidsOf = new Map();
  for (const r of rows) {
    const host = r.parentId ? byId.get(r.parentId) : null;
    if (!host || !isBlankPage(host.attrs)) continue;
    if (!kidsOf.has(host.id)) kidsOf.set(host.id, []);
    kidsOf.get(host.id).push(r);
  }
  if (!kidsOf.size) return rows;
  const q = db.prepare(HOT_QUERIES.bodyRows);
  const ord = new Map();
  for (const [hostId, kids] of kidsOf) {
    const order = bodySubOrder(q.all(hostId, hostId), hostId);
    const at = new Map();
    order.forEach((id, i) => { if (!at.has(id)) at.set(id, i); });
    const pos = (r) => (at.has(r.id) ? at.get(r.id) : order.length);
    const sorted = [...kids].sort((x, y) => pos(x) - pos(y) || cmpStr(x.ord, y.ord) || cmpStr(x.createdAt, y.createdAt));
    const keys = evenKeys(sorted.length);
    sorted.forEach((r, i) => ord.set(r.id, keys[i]));
  }
  return rows.map((r) => (ord.has(r.id) ? { ...r, ord: ord.get(r.id) } : r));
}
// 本文の行（id・parent_id・ord・type・sub。ord の順）→ 子ページの行の指すページの ID を本文の順に（組めない行は後ろ: blockTree.buildTree と同じ）
function bodySubOrder(rows, hostId) {
  const kids = new Map();
  for (const r of rows) { const k = r.parent_id ?? hostId; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(r); }
  const out = [];
  const seen = new Set();
  const go = (id) => {
    for (const r of kids.get(id) || []) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (r.type === 'subpage' && typeof r.sub === 'string') out.push(r.sub);
      go(r.id);
    }
  };
  go(hostId);
  for (const r of rows) if (!seen.has(r.id) && r.type === 'subpage' && typeof r.sub === 'string') out.push(r.sub);
  return out;
}
// 子ページの行の断り（決めたこと 52・53・59）: 文を持たない・型を変えない・つながない・分けない・写さない
function noSubRow(b) {
  if (isSubRow(b)) throw refuse('bad-args');
}
// 写す行から子ページの行を除く（子孫も。決めたこと 52: 同じページを指す行を2つにしない）
function dropSubRows(list) {
  const out = [];
  for (const b of list) {
    if (isSubRow(b)) continue;
    if (Array.isArray(b.children)) b.children = dropSubRows(b.children);
    out.push(b);
  }
  return out;
}

// 型を変える1行（block.turnInto・blocks.turnInto。区切り線の断りは呼ぶ側）。同じ型なら false
function turnBlock(l, a) {
  const b = l.b;
  const level = a.type === 'heading' ? (a.level || 2) : 0;
  const toggle = a.type === 'heading' && a.toggle === true;
  if (b.type === a.type && (a.type !== 'heading' || (blockEdit.headingLevel(b) === level && (b.toggle === true) === toggle))) return false;
  const out = BT.turnMovesKids(b, { type: a.type, level, toggle });
  // 2026-10-26 の持ち主の答え（点検2）: AI の見出しを別の型にしたら印 aiHeading を付け、文を変えずに見出しへ戻したら AI の見出しに戻す
  // （orderForView の節と［コピー］の順が行って戻って同じ）。文を変えると印は消え（retext・block.update）、人の行のまま
  if (b.type === 'heading' && b.citeState === undefined && a.type !== 'heading') b.aiHeading = true;
  if (b.citeState === undefined && !(b.type === 'heading' && a.type === 'heading')) b.citeState = 'manual';
  if (a.type === 'heading' && b.aiHeading === true && l.parent) delete b.aiHeading;   // EK-2 直し（I3・R130）: 子の行は AI の節の見出しに戻さない（人の見出しのまま: R65）
  if (a.type === 'heading' && b.aiHeading === true) { delete b.citeState; delete b.aiHeading; }
  b.type = a.type;
  if (level) b.level = level; else delete b.level;
  if (toggle) b.toggle = true; else delete b.toggle;
  if (a.type === 'callout' && !b.icon) b.icon = blockEdit.CALLOUT_ICON;
  if (a.type === 'todo' && typeof b.checked !== 'boolean') b.checked = false;
  if (out) BT.kidsOut(l.list, l.index);
  return true;
}

// ================================================================ 0.16.0 DS-3: データベース・行・列・ビューの命令（計画 docs/plans/2026-11-04-160.md の決めたこと 1〜32・47・48・52・R29〜R40）
// データベースはページの行（kind 'database'。列 cols・ビュー views・ID の列の次の番号 nextNo は attrs）、行は型 row（ops.rowBlock: 決めたこと 1・2）。
// どの命令も1つのトランザクション＝oplog の1行（core.call）で、oplog の page_id はデータベース（pageOf: args.db。元に戻すの列はデータベースの歩み: 決めたこと 47）。
// セルの値の照らしは dbModel.cellOf、ビューの照らしは dbView.normalizeView の1か所（決めたこと 10・15）。行を読むのは命令の中の1回（決めたこと 30）
const isDbPage = (attrs) => isObj(attrs) && attrs.kind === 'database';
const dbOfArgs = (a) => a.db;   // oplog の page_id（元に戻すの列の鍵: データベース）
const DB_VIEW_MAX = 200;   // db.view の1回に返す行（決めたこと 30）
const TITLE_COL = Object.freeze({ id: 'title', name: '名前', type: 'title' });   // 新しいデータベースの題名の列（画面の文「名前」）
const PASTE_TEXT = Object.freeze({ id: 'paste', name: 'paste', type: 'text' });   // 貼った文字（テキストの列として読み替える: 決めたこと 52）
const foldName = DM.foldName;   // 名前の重なり（dbModel と同じ寄せ方: J-20）
const whoOf = (ctx) => (DM.WHO.includes(ctx.actor) ? ctx.actor : 'system');
// 生きているデータベース（無い・ゴミ箱・データベースでないページは null）
function dbOf(db, id) {
  const r = db.prepare(HOT_QUERIES.pageRow).get(id);
  if (!r || r.type !== 'page' || (r.trashed_at !== null && r.trashed_at !== undefined)) return null;
  const attrs = JSON.parse(r.attrs || '{}');
  if (!isDbPage(attrs)) return null;
  return { id, rev: r.rev, title: r.text, attrs, cols: Array.isArray(attrs.cols) ? attrs.cols.filter(isObj) : [], views: Array.isArray(attrs.views) ? attrs.views.filter(isObj) : [] };
}
function mustDb(db, id) { const d = dbOf(db, id); if (!d) throw refuse('bad-args'); return d; }
const colIn = (cols, id) => cols.find((c) => c.id === id);
function liveCol(d, id) { const c = colIn(d.cols, id); if (!c || c.gone) throw refuse('bad-args'); return c; }
// 行の写し（dbView・画面の形: dbModel の頭の注）
function rowView(r) {
  const attrs = JSON.parse(r.attrs || '{}');
  const out = { id: r.id, ord: r.ord, title: r.text, cells: isObj(attrs.cells) ? attrs.cells : {}, createdAt: r.created_at, updatedAt: r.updated_at, by: isObj(attrs.by) ? attrs.by : {} };
  if (Number.isSafeInteger(attrs.no)) out.no = attrs.no;
  if (typeof attrs.icon === 'string' && attrs.icon) out.icon = attrs.icon;
  return out;
}
// そのデータベースの生きている行（書く命令はこの形に attrs と rev を足して使う）
function liveRow(db, d, id) {
  const r = db.prepare(HOT_QUERIES.dbRow).get(id);
  if (!r || r.type !== 'row' || r.parent_id !== d.id || (r.trashed_at !== null && r.trashed_at !== undefined)) throw refuse('bad-args');
  return { ...rowView(r), raw: r, attrs: JSON.parse(r.attrs || '{}') };
}
// 新しい行の ID（決めたこと 2: r＋時刻の36進＋5字。ページの ID と同じ作り方）
// issued: 同じ命令の中で振った ID（まだ書いていない。同じ時刻に足す行で重ならない: rv42 M2・R60）
function newRowId(db, now, rand = randU32, issued = null) {
  for (;;) {
    const id = `r${now().getTime().toString(36)}${rand().toString(36).padStart(7, '0').slice(-5)}`;
    if (issued && issued.has(id)) continue;
    if (!db.prepare(HOT_QUERIES.pageRow).get(id)) { if (issued) issued.add(id); return id; }
  }
}
// 末尾に足す並びの鍵（R31: keyBetween(最後, null) は足すたびに1字ずつ長くなる（1万行で 2,000 字）ので、4 桁の 36 進の数として1つ進める）
const KEY_DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
function appendKey(last) {
  if (!last) return 'i';
  const w = Math.max(last.length, 4);
  const d = last.padEnd(w, '0').split('').map((ch) => KEY_DIGITS.indexOf(ch));
  let i = w - 1;
  while (i >= 0 && d[i] === KEY_DIGITS.length - 1) { d[i] = 0; i -= 1; }
  if (i < 0) return keyBetween(last, null);
  d[i] += 1;
  return d.map((x) => KEY_DIGITS[x]).join('').replace(/0+$/, '');
}
// 行の並びの鍵: afterId が無ければ末尾・'' は頭・行の ID ならそのすぐ後ろ（ゴミ箱の行の鍵とも重ねない）。me は動かす行（並びから除く）
function rowOrd(db, dbId, afterId, me) {
  if (afterId === undefined) return appendKey(db.prepare(HOT_QUERIES.dbLastOrd).get(dbId).m);
  const all = db.prepare(HOT_QUERIES.dbOrds).all(dbId).filter((r) => r.id !== me).map((r) => r.ord).sort(cmpStr);
  if (afterId === '') return keyBetween(null, all.length ? all[0] : null);
  const a = db.prepare(HOT_QUERIES.dbRow).get(afterId);
  if (!a || a.type !== 'row' || a.parent_id !== dbId || afterId === me) throw refuse('bad-args');
  const next = all.find((o) => cmpStr(o, a.ord) > 0);
  return keyBetween(a.ord, next === undefined ? null : next);
}
// セルの値を照らす（列の種類ごと: dbModel.cellOf。題名は文字。形が違えば bad-args）。リレーションは DR-1 の rel.link で書く（R33）
function cellFor(col, v) {
  if (col.type === 'title') {
    if (v === null) return '';
    if (typeof v !== 'string' || v.length > DM.MAX.title) throw refuse('bad-args');
    return v;
  }
  if (col.type === 'rel') throw refuse('bad-args');
  try { return DM.cellOf(col, v); } catch (_) { throw refuse('bad-args'); }
}
// 1つの行の1つのセルを書く操作（同じ値なら無し）。題名は text・ほかは cell:<列の ID> の set（前の値つき: 決めたこと 5）
function cellOps(r, col, v) {
  if (col.type === 'title') return r.title === v ? [] : [{ op: 'text', id: r.id, value: v, old: r.title }];
  const was = Object.hasOwn(r.cells, col.id) ? r.cells[col.id] : undefined;
  const next = v === null ? undefined : v;
  return isDeepStrictEqual(was, next) ? [] : [{ op: 'set', id: r.id, key: `cell:${col.id}`, value: next, old: was }];
}
// 行を書いた印（最終更新日時と最終更新者: 決めたこと 10・29。行の updatedAt は列）
function touchOps(r, ctx) {
  const who = whoOf(ctx);
  const by = isObj(r.attrs.by) ? r.attrs.by : {};
  const out = [{ op: 'set', id: r.id, key: 'updatedAt', value: ctx.now().toISOString(), old: r.raw.updated_at || '' }];
  if (by.u !== who) out.push({ op: 'set', id: r.id, key: 'by', value: { ...by, u: who }, old: r.attrs.by });
  return out;
}
// データベースのページの欄を書く操作（cols・views。列とビューの設定の大きさは 256KB まで: 決めたこと 7）
function dbSet(d, key, value) {
  if (Buffer.byteLength(JSON.stringify({ ...d.attrs, [key]: value }), 'utf8') > LIMITS.dbAttrs) throw refuse('too-big');
  return { op: 'set', id: d.id, key, value, old: d.attrs[key] };
}
// 列と選択肢の ID は使い直さない（rv42 I1・R56）: 前の並びに無い列と、前のその列に無い選択肢（読み替え・貼り付け・画面が足した選択肢）の ID が、
// 今までに振った一番大きい数（データベースの attrs.seq の c と o。無ければ今ある ID の一番大きい数）以下なら、その次の数に振り直す（大きければそのまま）。
// 新しい列の選択肢はその列の中だけの ID なので見ない。→ { cols, ops（列の set と数の set）, mapCell(列の ID, 値) → 振り直した ID の値 }。
// 数は元に戻すで戻さない（DB_NO_REVERT）
const SEQ_NUM_RE = /^[co](\d{1,9})$/;
function freshIds(d, cols) {
  const num = (id) => { const m = SEQ_NUM_RE.exec(String(id)); return m ? Number(m[1]) : 0; };
  const was0 = isObj(d.attrs.seq) ? d.attrs.seq : {};
  const seq = { ...was0, c: Number.isSafeInteger(was0.c) ? was0.c : 0, o: Number.isSafeInteger(was0.o) ? was0.o : 0 };   // v（ビューの数: R88）は残す
  for (const c of d.cols) { seq.c = Math.max(seq.c, num(c.id)); for (const o of Array.isArray(c.opts) ? c.opts : []) seq.o = Math.max(seq.o, num(o.id)); }
  const take = (head, id) => { const n = num(id); if (n > seq[head]) { seq[head] = n; return id; } seq[head] += 1; return `${head}${seq[head]}`; };
  const was = new Map(d.cols.map((c) => [c.id, c]));
  const maps = new Map();
  const out = cols.map((c) => {
    if (!was.has(c.id)) return c.id === 'title' ? c : { ...c, id: take('c', c.id) };
    if (!Array.isArray(c.opts)) return c;
    const old = new Set((Array.isArray(was.get(c.id).opts) ? was.get(c.id).opts : []).map((o) => o.id));
    const map = new Map();
    const opts = c.opts.map((o) => { if (old.has(o.id)) return o; const id = take('o', o.id); if (id !== o.id) map.set(o.id, id); return id === o.id ? o : { ...o, id }; });
    if (!map.size) return c;
    maps.set(c.id, map);
    const next = { ...c, opts };
    if (isObj(c.groups)) next.groups = Object.fromEntries(Object.entries(c.groups).map(([k, ids]) => [k, Array.isArray(ids) ? ids.map((x) => map.get(x) || x) : ids]));
    return next;
  });
  const ops = [dbSet(d, 'cols', out)];
  if (seq.c !== was0.c || seq.o !== was0.o) ops.push({ op: 'set', id: d.id, key: 'seq', value: seq, old: d.attrs.seq });
  const mapCell = (colId, v) => {
    const map = maps.get(colId);
    if (!map || v === undefined || v === null) return v;
    return Array.isArray(v) ? v.map((x) => map.get(x) || x) : (map.get(v) || v);
  };
  return { cols: out, ops, mapCell };
}
// 振り直した選択肢の ID を、同じ命令のセルの操作（cell:<列> の set と、足した行のセル）にも当てる
function remapCellOps(list, mapCell) {
  return list.map((o) => {
    if (o.op === 'set' && typeof o.key === 'string' && o.key.startsWith('cell:')) {
      const v = mapCell(o.key.slice(5), o.value);
      return v === o.value ? o : { ...o, value: v };
    }
    if (o.op === 'add' && o.row && isObj(o.row.attrs) && isObj(o.row.attrs.cells)) {
      const cells = {};
      for (const [k, v] of Object.entries(o.row.attrs.cells)) cells[k] = mapCell(k, v);
      return { ...o, row: { ...o.row, attrs: { ...o.row.attrs, cells } } };
    }
    return o;
  });
}
const dbDone = (db, d, ops, result, rows = []) => { applyOps(db, ops); return { ops, pageIds: ops.length ? [d.id, ...rows] : [], result }; };
const viewOf = (d, id) => d.views.find((v) => v.id === id);
const normView = (d, v) => DV.normalizeView(v, d.cols).view;
// 表の印 sig（決めたこと 30: データベースのページの rev と、行の数と、行の rev から作る。同じ中身なら同じ印で、画面は描き直さない）
function sigOf(d, rows) {
  const h = crypto.createHash('sha1');
  for (const r of rows) h.update(`${r.id}:${r.rev}\n`);
  return `${d.rev}.${rows.length}.${h.digest('hex').slice(0, 16)}`;
}

// データベースを作る（決めたこと 1・43。親は一覧に出るページで、データベースでない。白紙のページの中なら本文の最後に子ページの行: page.create と同じ）→ { page, id }
function dbCreate(db, a, ctx) {
  const rows = pageRowsOf(db);
  const parentId = a.parentId || null;
  const host = parentId === null ? null : rows.find((r) => r.id === parentId);
  if (parentId !== null && (!host || host.trashedAt !== null || isLive(host.attrs) || isDbPage(host.attrs))) throw refuse('bad-args');   // 録音中の写し・ゴミ箱・無い・データベースの中には作らない
  const id = newPageId(db, ctx.now);
  const at = ctx.now();
  const ord = parentId === null ? PT.TOP_ORD : PT.siblingKey(PT.pageTree(rows), new Map(rows.map((r) => [r.id, r.ord])), parentId, undefined);
  const cols = [{ ...TITLE_COL }];
  const page = { id, title: '', kind: 'database', date: localDate(at), memo: '', blocks: [], cols, views: [DV.defaultView('v1', 'table', cols)], nextNo: 1,
    createdAt: at.toISOString(), updatedAt: at.toISOString() };
  const ops = [{ op: 'add', id, row: { ...pageRow(page, { ord }), parent_id: parentId } }];
  const body = host && isBlankPage(host.attrs) ? bodyOps(db, parentId, ctx, (p) => placeSubRow(p, newSubRow(db, ctx, id))) : null;
  if (body) ops.push(...body);
  applyOps(db, ops);
  return { ops, pageIds: body ? [id, parentId] : [id], result: { page: readPage(db, id), id } };
}
// データベースの形（列・照らしたビュー・今の行の数。行の数は削除の確かめの文が使う: 決めたこと 44・R36）→ null（無い・ゴミ箱）
function dbGetOf(db, id) {
  const d = dbOf(db, id);
  if (!d) return null;
  const out = { id, title: d.title, cols: d.cols, views: d.views.map((v) => normView(d, v)), rowCount: db.prepare(HOT_QUERIES.dbRowCount).get(id).c };
  if (typeof d.attrs.icon === 'string' && d.attrs.icon) out.icon = d.attrs.icon;
  if (isObj(d.attrs.sub)) out.sub = d.attrs.sub;
  return out;
}
// 表を読む（決めたこと 30・R20）: 行を1回読み、dbView.applyView で絞り込み・並べ替え・グループ・集計をし、並べる行（shown）の from から count だけ返す
function dbViewRead(db, a, ctx) {
  if (!Number.isSafeInteger(a.from) || a.from < 0 || !Number.isSafeInteger(a.count) || a.count < 1 || a.count > DB_VIEW_MAX) throw refuse('bad-args');
  const d = dbOf(db, a.id);
  if (!d) return { result: null };
  const raw = viewOf(d, a.viewId);
  if (!raw) throw refuse('bad-args');
  const v = normView(d, raw);
  const stored = db.prepare(HOT_QUERIES.dbRows).all(d.id);
  const list = stored.map(rowView);
  const out = DV.applyView(list, v, d.cols, { now: ctx.now().getTime(), q: a.q });
  const shown = new Set(v.props.filter((p) => p.show).map((p) => p.col));
  const byId = new Map(list.map((r) => [r.id, r]));
  const rows = out.order.slice(a.from, a.from + a.count).map((o) => {
    const r = byId.get(o.id);
    const cells = {};
    for (const [k, x] of Object.entries(r.cells)) if (shown.has(k)) cells[k] = x;
    const one = { ...r, cells, depth: o.depth, hasKids: o.hasKids };
    if (o.g !== undefined) one.g = o.g;
    return one;
  });
  return { result: { total: out.total, shown: out.shown, rows, groups: out.groups, agg: out.agg, sig: sigOf(d, stored) } };
}

// 行を足す（決めたこと 24・29: ID の列の番号は nextNo から振って詰めない・作成者は命令の actor・行は 10,000 まで）→ { id, row }
function rowAdd(db, a, ctx) {
  const d = mustDb(db, a.db);
  if (db.prepare(HOT_QUERIES.dbRowCount).get(d.id).c >= LIMITS.dbRows) throw refuse('too-big');
  const cells = {};
  for (const [k, v] of Object.entries(a.cells || {})) {
    const col = liveCol(d, k);
    if (col.type === 'title') throw refuse('bad-args');   // 題名は title の引数で
    const x = cellFor(col, v);
    if (x !== null) cells[k] = x;
  }
  const id = newRowId(db, ctx.now);
  const ord = rowOrd(db, d.id, a.afterId);
  const no = Number.isSafeInteger(d.attrs.nextNo) && d.attrs.nextNo > 0 ? d.attrs.nextNo : 1;
  const who = whoOf(ctx);
  const row = rowBlock({ id, db: d.id, ord, title: a.title || '', cells, by: { c: who, u: who }, no, at: ctx.now().toISOString() });
  const ops = [{ op: 'add', id, row }, { op: 'set', id: d.id, key: 'nextNo', value: no + 1, old: d.attrs.nextNo }];
  applyOps(db, ops);
  return { ops, pageIds: [d.id, id], result: { id, row: rowView(db.prepare(HOT_QUERIES.dbRow).get(id)) } };
}
// 1つ・選んだ行（決めたこと 25・27）のセルを書く
function setCells(db, a, ctx, ids) {
  const d = mustDb(db, a.db);
  const col = liveCol(d, a.col);
  const v = cellFor(col, a.value);
  const rows = [...new Set(ids)].map((id) => liveRow(db, d, id));
  const ops = [];
  const changed = [];
  for (const r of rows) {
    const one = cellOps(r, col, v);
    if (!one.length) continue;
    ops.push(...one, ...touchOps(r, ctx));
    changed.push(r.id);
  }
  applyOps(db, ops);
  return { ops, pageIds: ops.length ? [d.id, ...changed] : [], changed };
}
// 行を動かす（並べ替えの無いビューの手の並び: 決めたこと 27）
function rowMove(db, a) {
  const d = mustDb(db, a.db);
  const r = liveRow(db, d, a.id);
  if (a.afterId === a.id) return { ops: [], pageIds: [], result: { row: rowView(r.raw) } };
  const ord = rowOrd(db, d.id, a.afterId, a.id);
  return dbDone(db, d, [{ op: 'move', id: r.id, ord, old: r.ord }], { row: { ...rowView(r.raw), ord } }, [r.id]);
}
// 行をゴミ箱へ（決めたこと 28。確かめは画面が出さない）→ { trashed }
function rowsTrash(db, a, ctx) {
  const d = mustDb(db, a.db);
  const at = ctx.now().toISOString();
  const ops = [...new Set(a.ids)].map((id) => liveRow(db, d, id)).map((r) => ({ op: 'trash', id: r.id, at, old: r.raw.trashed_at ?? null }));
  return dbDone(db, d, ops, { trashed: ops.length }, ops.map((o) => o.id));
}
// 何行何列かの貼り付け（DQ7 (a)・決めたこと 52・R35）: ビューの見えている並びで、選んだセルから右下へ。足りない行は足し（絞り込みの値を入れる）、
// 右にはみ出した列・書けない列・リレーションは飛ばして skipped に、種類に読めない値は空にして unread に数える。全部が1つの命令（Ctrl+Z の1回）
function rowsPaste(db, a, ctx, dry = false) {
  const d = mustDb(db, a.db);
  const raw = viewOf(d, a.viewId);
  if (!raw) throw refuse('bad-args');
  const v = normView(d, raw);
  const stored = db.prepare(HOT_QUERIES.dbRows).all(d.id);
  const list = stored.map(rowView);
  const order = [...new Set(DV.applyView(list, v, d.cols, { now: ctx.now().getTime() }).order.map((o) => o.id))];
  const start = order.indexOf(a.at.row);
  const vcols = v.props.filter((p) => p.show).map((p) => colIn(d.cols, p.col)).filter((c) => c && !c.gone);
  const c0 = vcols.findIndex((c) => c.id === a.at.col);
  if (start < 0 || c0 < 0) throw refuse('bad-args');
  const rowsFor = order.slice(start, start + a.grid.length);
  while (rowsFor.length < a.grid.length) rowsFor.push(null);   // 足りない行は足す
  const adding = rowsFor.filter((x) => x === null).length;
  if (stored.length + adding > LIMITS.dbRows) throw refuse('too-big');
  const colsNow = new Map(d.cols.map((c) => [c.id, c]));
  const defaults = DV.filterDefaults(v, d.cols);
  const st = { filled: 0, added: 0, skipped: 0, unread: 0 };
  const rowOps = [];
  const addOps = [];
  let last = db.prepare(HOT_QUERIES.dbLastOrd).get(d.id).m;
  const issued = new Set();
  let no = Number.isSafeInteger(d.attrs.nextNo) && d.attrs.nextNo > 0 ? d.attrs.nextNo : 1;
  const who = whoOf(ctx);
  const at = ctx.now().toISOString();
  rowsFor.forEach((id, i) => {
    const r = id === null ? null : liveRow(db, d, id);
    const fresh = r ? null : { title: '', cells: { ...defaults } };
    const mine = [];
    a.grid[i].forEach((s, j) => {
      const col = vcols[c0 + j];
      if (!col || col.type === 'rel' || !DM.COLS[col.type].writable) { st.skipped += 1; return; }
      st.filled += 1;
      let val;
      if (col.type === 'title') val = s.length <= DM.MAX.title ? s : (st.unread += 1, '');
      else if (s.trim() === '') val = null;
      else {
        const got = DM.convertCell(PASTE_TEXT, colsNow.get(col.id), s.trim());
        colsNow.set(col.id, got.col);
        val = got.value;
        if (val === null) st.unread += 1;
      }
      if (fresh) { if (col.type === 'title') fresh.title = val; else if (val === null) delete fresh.cells[col.id]; else fresh.cells[col.id] = val; }
      else mine.push(...cellOps(r, col, val));
    });
    if (fresh) {
      last = appendKey(last);
      const nid = newRowId(db, ctx.now, randU32, issued);
      addOps.push({ op: 'add', id: nid, row: rowBlock({ id: nid, db: d.id, ord: last, title: fresh.title, cells: fresh.cells, by: { c: who, u: who }, no, at }) });
      no += 1;
      st.added += 1;
    } else if (mine.length) rowOps.push(...mine, ...touchOps(r, ctx));
  });
  if (dry) return st;   // 送り直しの答え（数だけ。書かない: R59）
  const newCols = d.cols.map((c) => colsNow.get(c.id) || c);
  const ops = [];
  if (!isDeepStrictEqual(newCols, d.cols)) {   // 読み替えで足した選択肢（ID はデータベースの数から振り直す: R56）
    const f = freshIds(d, newCols);
    ops.push(...f.ops, ...remapCellOps([...addOps, ...rowOps], f.mapCell));
  } else ops.push(...addOps, ...rowOps);
  if (st.added) ops.push({ op: 'set', id: d.id, key: 'nextNo', value: no, old: d.attrs.nextNo });
  return dbDone(db, d, ops, st);
}

// ---- 列（決めたこと 13・R32〜R34）
// 列を足す（名前が重なれば「名前 2」: dbModel.newCol。after は列の並びの置き場: '' は頭・無ければ末尾。列は消した列も入れて 100 まで）→ { col }
function colAdd(db, a) {
  const d = mustDb(db, a.db);
  if (a.type === 'rel') throw refuse('bad-args');   // リレーションの列は DR-1（つなぐ先を選んで足す）
  if (d.cols.length >= LIMITS.dbCols) throw refuse('bad-args');
  let col;
  try { col = DM.newCol(a.type, a.name, d.cols); } catch (_) { throw refuse('bad-args'); }
  const cols = [...d.cols];
  const i = a.after === undefined ? cols.length : a.after === '' ? 0 : cols.findIndex((c) => c.id === a.after) + 1;
  if (i < 0 || (a.after && i === 0)) throw refuse('bad-args');
  cols.splice(i, 0, col);
  const f = freshIds(d, cols);   // 列の ID は使い直さない（R56）
  return dbDone(db, d, f.ops, { col: f.cols[i] });
}
// 列を置き換えた並び（照らしてから）
function colsWith(d, col) {
  if (!DM.colOk(col)) throw refuse('bad-args');
  return d.cols.map((c) => (c.id === col.id ? col : c));
}
function colRename(db, a) {
  const d = mustDb(db, a.db);
  const col = liveCol(d, a.col);
  if (col.name === a.name) return { ops: [], pageIds: [], result: { col } };
  if (d.cols.some((c) => c.id !== col.id && foldName(c.name) === foldName(a.name))) throw refuse('bad-args');   // 名前の重なり（大文字小文字・全角半角を寄せて）
  const next = { ...col, name: a.name };
  return dbDone(db, d, [dbSet(d, 'cols', colsWith(d, next))], { col: next });
}
// そのデータベースの全部の行（ゴミ箱の行も。列の種類を変える・選択肢を消す・完全に消すは、戻したときに形の違うセルを残さない）
const allRows = (db, d) => db.prepare(HOT_QUERIES.dbAllRows).all(d.id).map((r) => ({ id: r.id, cells: (JSON.parse(r.attrs || '{}').cells) || {}, trashed: r.trashed_at !== null }));
// 種類を変える（決めたこと 13: セルを新しい種類に読み替えて同じ命令で書き直す。前の値は oplog にあり、Ctrl+Z で戻る）→ { col, emptied }
// 種類を変えたときの新しい列とセルの書き直し（col.setType と、変える前に数を見る col.typeCheck の両方: R63）→ { from, to, cellSets, emptied } | null（同じ種類）
function typePlan(db, d, a) {
  const from = liveCol(d, a.col);
  if (from.type === a.type) return null;
  if (from.type === 'title' || from.type === 'rel' || a.type === 'rel' || !DM.COLS[from.type].writable || !DM.COLS[a.type].writable) throw refuse('bad-args');
  const OPT = ['select', 'multi', 'status'];
  let to = { id: from.id, name: from.name, type: a.type, ...DM.COLS[a.type].defaults() };
  // 選択肢の種類どうしは、選択肢を同じ ID のまま写す（ステータスへは全部を「未着手」のまとまりに: R32）
  if (OPT.includes(from.type) && OPT.includes(a.type) && Array.isArray(from.opts) && from.opts.length) {
    to.opts = from.opts.map((o) => ({ ...o }));
    if (a.type === 'status') to.groups = from.type === 'status' ? structuredClone(from.groups) : { todo: to.opts.map((o) => o.id), doing: [], done: [] };
  }
  const cellSets = [];
  let emptied = 0;
  let shown = 0;   // DV-2 直し（rv46 M7・R85）: そのうちゴミ箱でない行（確かめの数）
  for (const r of allRows(db, d)) {
    if (!Object.hasOwn(r.cells, from.id)) continue;
    const was = r.cells[from.id];
    let got;
    try { got = DM.convertCell(from, to, was); } catch (_) { throw refuse('bad-args'); }
    to = got.col;
    if (got.value === null) { emptied += 1; if (!r.trashed) shown += 1; }
    cellSets.push({ op: 'set', id: r.id, key: `cell:${from.id}`, value: got.value ?? undefined, old: was });
  }
  return { from, to, cellSets, emptied, shown };
}
function colSetType(db, a) {
  const d = mustDb(db, a.db);
  const plan = typePlan(db, d, a);
  if (!plan) return { ops: [], pageIds: [], result: { col: liveCol(d, a.col), emptied: 0 } };
  const { to, cellSets, emptied } = plan;
  const f = freshIds(d, colsWith(d, to));   // 読み替えで足した選択肢の ID は使い直さない（R56）
  return dbDone(db, d, [...f.ops, ...remapCellOps(cellSets, f.mapCell)], { col: f.cols.find((c) => c.id === to.id), emptied });
}
// 種類を変える前に、読めずに空になるセルの数を見る（読む命令。何も書かない: 決めたこと 13・TR6「変える前に消える数を確かめで出す」・R63）→ { emptied }
function colTypeCheck(db, a) {
  const d = mustDb(db, a.db);
  const plan = typePlan(db, d, a);
  return { result: { emptied: plan ? plan.shown : 0 } };   // 確かめに出す数はゴミ箱でない行だけ（読み替えはゴミ箱の行にも当てる: R32・R85）
}
function colMove(db, a) {
  const d = mustDb(db, a.db);
  const col = colIn(d.cols, a.col);
  if (!col) throw refuse('bad-args');
  const rest = d.cols.filter((c) => c.id !== col.id);
  const i = a.after === '' ? 0 : rest.findIndex((c) => c.id === a.after) + 1;
  if (a.after === a.col) return { ops: [], pageIds: [], result: { col } };
  if (i === 0 && a.after !== '') throw refuse('bad-args');
  rest.splice(i, 0, col);
  if (isDeepStrictEqual(rest.map((c) => c.id), d.cols.map((c) => c.id))) return { ops: [], pageIds: [], result: { col } };
  return dbDone(db, d, [dbSet(d, 'cols', rest)], { col });
}
// 消す（gone を付けてビューから外す。セルは残す: R-24）・戻す・完全に消す（消した列だけ。セルも消す。Ctrl+Z の歩みにしない）
function colRemove(db, a) {
  const d = mustDb(db, a.db);
  const col = colIn(d.cols, a.col);
  if (!col || col.type === 'title') throw refuse('bad-args');   // 題名の列は消せない（J-18）
  if (col.gone) return { ops: [], pageIds: [], result: { col } };
  const next = { ...col, gone: true };
  return dbDone(db, d, [dbSet(d, 'cols', d.cols.map((c) => (c.id === col.id ? next : c)))], { col: next });
}
function colRestore(db, a) {
  const d = mustDb(db, a.db);
  const col = colIn(d.cols, a.col);
  if (!col) throw refuse('bad-args');
  if (!col.gone) return { ops: [], pageIds: [], result: { col } };
  const next = { ...col };
  delete next.gone;
  return dbDone(db, d, [dbSet(d, 'cols', colsWith(d, next))], { col: next });
}
function colPurge(db, a) {
  const d = mustDb(db, a.db);
  const col = colIn(d.cols, a.col);
  if (!col || !col.gone) throw refuse('bad-args');
  const cells = allRows(db, d).filter((r) => Object.hasOwn(r.cells, col.id)).map((r) => ({ op: 'set', id: r.id, key: `cell:${col.id}`, value: undefined, old: r.cells[col.id] }));
  const rest = d.cols.filter((c) => c.id !== col.id);
  const views = d.views.map((v) => DV.normalizeView(v, rest).view);   // ビューの設定からもその列を外す（R56）
  const out = [dbSet(d, 'cols', rest)];
  if (!isDeepStrictEqual(views, d.views)) out.push(dbSet({ ...d, attrs: { ...d.attrs, cols: rest } }, 'views', views));
  return dbDone(db, d, [...out, ...cells], { purged: col.id });
}
// 選択肢を置き換える（名前・色・並び・足す・消す。消した選択肢はセルからも外す: R34）→ { col }
function colSetOpts(db, a) {
  const d = mustDb(db, a.db);
  const col = liveCol(d, a.col);
  if (!['select', 'multi', 'status'].includes(col.type)) throw refuse('bad-args');
  const opts = a.opts.map((o) => ({ ...o }));
  const names = opts.map((o) => foldName(o.name));
  if (new Set(names).size !== names.length) throw refuse('bad-args');   // 大文字小文字・全角半角を寄せて重ならない（J-20）
  if (opts.some((o, i) => !DM.optNameOk(opts.filter((_, k) => k !== i), o.name))) throw refuse('bad-args');
  const next = { ...col, opts };
  if (col.type === 'status') {
    const ids = new Set(opts.map((o) => o.id));
    const g = a.groups || col.groups || {};
    next.groups = {};
    for (const k of DM.STATUS_GROUPS) next.groups[k] = (Array.isArray(g[k]) ? g[k] : []).filter((id) => ids.has(id));
    for (const o of opts) if (!DM.STATUS_GROUPS.some((k) => next.groups[k].includes(o.id))) next.groups.todo.push(o.id);   // 新しい選択肢は「未着手」
  } else if (a.groups !== undefined) throw refuse('bad-args');
  const cols = colsWith(d, next);
  const keep = new Set(opts.map((o) => o.id));
  const cells = [];
  for (const r of allRows(db, d)) {
    if (!Object.hasOwn(r.cells, col.id)) continue;
    const was = r.cells[col.id];
    const now = Array.isArray(was) ? was.filter((id) => keep.has(id)) : keep.has(was) ? was : undefined;
    const value = Array.isArray(now) && !now.length ? undefined : now;
    if (!isDeepStrictEqual(value, was)) cells.push({ op: 'set', id: r.id, key: `cell:${col.id}`, value, old: was });
  }
  const f = freshIds(d, cols);   // 新しい選択肢の ID は DB が振る（消した選択肢の ID を使い直さない: R56）
  return dbDone(db, d, [...f.ops, ...cells], { col: f.cols.find((c) => c.id === col.id) });
}
// 数値の見せ方（fmt）と ID の接頭辞（prefix。'' は外す）（R33）→ { col }
function colSetFmt(db, a) {
  const d = mustDb(db, a.db);
  const col = liveCol(d, a.col);
  const next = { ...col };
  if (col.type === 'number' && a.fmt !== undefined && a.prefix === undefined) next.fmt = a.fmt;
  else if (col.type === 'no' && a.prefix !== undefined && a.fmt === undefined) { if (a.prefix) next.prefix = a.prefix; else delete next.prefix; }
  else throw refuse('bad-args');
  if (isDeepStrictEqual(next, col)) return { ops: [], pageIds: [], result: { col } };
  return dbDone(db, d, [dbSet(d, 'cols', colsWith(d, next))], { col: next });
}

// ---- ビュー（決めたこと 15・16。どれも元に戻すの歩みにしない: 決めたこと 47）
function viewsSet(db, d, views, result) { return dbDone(db, d, [dbSet(d, 'views', views)], result); }
// 照らした写し（patch か新しいビューの、壊れた項目があれば bad-args: 画面の誤りを黙って直さない。前からある壊れた項目は直して残す）
function checkedView(d, v, keys) {
  const { view, repaired } = DV.normalizeView(v, d.cols);
  if (repaired.some((k) => keys.includes(k))) throw refuse('bad-args');
  return view;
}
function viewAdd(db, a) {
  const d = mustDb(db, a.db);
  if (d.views.length >= LIMITS.dbViews) throw refuse('bad-args');
  // DV-3 直し（rv48 F11・R88）: ビューの ID は使い直さない（消したビューへの古いリンクがほかのビューを開かない）。今までに振った一番大きい数を attrs.seq.v に
  const was0 = isObj(d.attrs.seq) ? d.attrs.seq : {};
  let n = Number.isSafeInteger(was0.v) ? was0.v : 0;
  for (const x of d.views) { const m = /^v(\d{1,9})$/.exec(String(x.id)); if (m) n = Math.max(n, Number(m[1])); }
  n += 1;
  let v;
  if (a.from !== undefined) {
    const src = viewOf(d, a.from);
    if (!src || a.layout !== undefined) throw refuse('bad-args');
    v = { ...normView(d, src), id: `v${n}`, ...(a.name !== undefined ? { name: a.name } : {}) };
  } else v = DV.defaultView(`v${n}`, a.layout || 'table', d.cols, a.name);
  const view = checkedView(d, v, ['name', 'layout']);
  return dbDone(db, d, [dbSet(d, 'views', [...d.views, view]), { op: 'set', id: d.id, key: 'seq', value: { ...was0, v: n }, old: d.attrs.seq }], { view });
}
function viewUpdate(db, a) {
  const d = mustDb(db, a.db);
  const was = viewOf(d, a.viewId);
  if (!was) throw refuse('bad-args');
  const view = checkedView(d, { ...normView(d, was), ...a.patch, id: was.id }, Object.keys(a.patch));
  if (isDeepStrictEqual(view, was)) return { ops: [], pageIds: [], result: { view } };
  return viewsSet(db, d, d.views.map((v) => (v.id === was.id ? view : v)), { view });
}
function viewRemove(db, a) {
  const d = mustDb(db, a.db);
  if (!viewOf(d, a.viewId) || d.views.length <= 1) throw refuse('bad-args');   // 最後の1つは消せない（V-T03）
  return viewsSet(db, d, d.views.filter((v) => v.id !== a.viewId), { removed: a.viewId });
}
function viewMove(db, a) {
  const d = mustDb(db, a.db);
  const me = viewOf(d, a.viewId);
  if (!me) throw refuse('bad-args');
  const rest = d.views.filter((v) => v.id !== a.viewId);
  const i = a.after === '' ? 0 : rest.findIndex((v) => v.id === a.after) + 1;
  if (a.after === a.viewId) return { ops: [], pageIds: [], result: { view: me } };
  if (i === 0 && a.after !== '') throw refuse('bad-args');
  rest.splice(i, 0, me);
  if (isDeepStrictEqual(rest.map((v) => v.id), d.views.map((v) => v.id))) return { ops: [], pageIds: [], result: { view: me } };
  return viewsSet(db, d, rest, { view: me });
}

// ---- 元に戻す（決めたこと 47・48・R31）: データベースの歩み。行の足し引き・セル・列を戻し、戻して書き直した行の最終更新日時と更新者は今の時刻と自分
function dbRevert(db, a, ctx, fwd) {
  let back;
  let same;
  try {
    back = invertOps(fwd, { dbId: a.pageId });
    same = opsMatch(db, fwd, { dbId: a.pageId });
  } catch (_) { throw refuse('bad-args'); }
  if (!same) throw refuse('stale');   // 後で変わったセル・行（決めたこと 48）
  // 戻すと消える行（足した行）に本文があれば戻さない（本文を親の無い行にしない）
  const body = db.prepare('select count(*) as c from blocks where page_id = ? and id <> ?');
  if (back.some((o) => o.op === 'trash' && isObj(o.old) && body.get(o.id, o.id).c > 0)) throw refuse('stale');
  // 戻すと消える列（足した列の戻し）に値のある行があれば戻さない（ゴミ箱の行も。行に持ち主の無いセルを残さない: rv42 I2・R57）
  for (const o of back) {
    if (o.op !== 'set' || o.id !== a.pageId || o.key !== 'cols' || !Array.isArray(o.value) || !Array.isArray(o.old)) continue;
    const keep = new Set(o.value.map((c) => c && c.id));
    const lost = o.old.map((c) => c && c.id).filter((id) => !keep.has(id));
    if (lost.length && db.prepare(HOT_QUERIES.dbAllRows).all(a.pageId).some((r) => { const c = JSON.parse(r.attrs || '{}').cells; return isObj(c) && lost.some((id) => Object.hasOwn(c, id)); })) throw refuse('stale');
  }
  applyOps(db, back);
  // 戻すと消える選択肢（足した選択肢の戻し）を、戻した後も持つ行があれば戻さない（ゴミ箱の行も。行に持ち主の無い選択肢の ID を残さない: rv44 F5・R72）。
  // 同じ歩みで行のセルも戻る（貼り付けで足した選択肢と行）ので、当てた後に見る（断れば命令ごと戻る）
  const lostOpts = [];
  for (const o of back) {
    if (o.op !== 'set' || o.id !== a.pageId || o.key !== 'cols' || !Array.isArray(o.value) || !Array.isArray(o.old)) continue;
    const after = new Map(o.value.filter(isObj).map((c) => [c.id, c]));
    for (const c of o.old) {
      const n = isObj(c) ? after.get(c.id) : null;
      if (!n || !Array.isArray(c.opts)) continue;
      const keep = new Set((Array.isArray(n.opts) ? n.opts : []).map((x) => x && x.id));
      for (const x of c.opts) if (x && !keep.has(x.id)) lostOpts.push([c.id, x.id]);
    }
  }
  if (lostOpts.length && db.prepare(HOT_QUERIES.dbAllRows).all(a.pageId).some((r) => {
    const c = JSON.parse(r.attrs || '{}').cells;
    return isObj(c) && lostOpts.some(([col, id]) => c[col] === id || (Array.isArray(c[col]) && c[col].includes(id)));
  })) throw refuse('stale');
  // 行を戻す・やり直すでも、1つのデータベースの行は 10,000 まで（rv42 M1・R58。越えれば何も変えない）
  if (back.some((o) => o.op === 'restore' || o.op === 'add') && db.prepare(HOT_QUERIES.dbRowCount).get(a.pageId).c > LIMITS.dbRows) throw refuse('too-big');
  const touched = [...new Set(back.filter((o) => o.op === 'text' || (o.op === 'set' && o.key.startsWith('cell:'))).map((o) => o.id))];
  const meta = [];
  for (const id of touched) {
    const r = db.prepare(HOT_QUERIES.dbRow).get(id);
    if (r && r.type === 'row') meta.push(...touchOps({ id, raw: r, attrs: JSON.parse(r.attrs || '{}') }, ctx));
  }
  applyOps(db, meta);
  return { ops: [...back, ...meta], pageIds: [a.pageId, ...touched], result: { page: readPage(db, a.pageId) } };
}

// ---- 送り直しの答え（rv42 M3・R59: 1回目と同じ R29 の形を、今の中身と oplog の1行から作り直す。データベースが無ければ null）
const dupOps = (row) => { try { const l = JSON.parse(row.ops || '[]'); return Array.isArray(l) ? l : []; } catch (_) { return []; } };
const dupDb = (db, a) => dbOf(db, a.db);
const dupCol = (db, a) => { const d = dupDb(db, a); const col = d ? colIn(d.cols, a.col) : null; return col ? { col } : null; };
// 1回目に足した物（列・ビュー）の ID: oplog の set の前と後の並びで、後にだけある ID
function dupNewId(row, key) {
  const o = dupOps(row).find((x) => x && x.op === 'set' && x.key === key && Array.isArray(x.value));
  if (!o) return null;
  const old = new Set((Array.isArray(o.old) ? o.old : []).map((x) => x && x.id));
  const got = o.value.find((x) => x && !old.has(x.id));
  return got ? got.id : null;
}
const DUP = {
  'col.add': (db, a, row) => { const d = dupDb(db, a); const id = dupNewId(row, 'cols'); const col = d && id ? colIn(d.cols, id) : null; return col ? { col } : null; },
  'col.setType': (db, a, row) => {
    const got = dupCol(db, a);
    return got ? { ...got, emptied: dupOps(row).filter((o) => o && o.op === 'set' && o.key === `cell:${a.col}` && (o.value === undefined || o.value === null)).length } : null;
  },
  'col.purge': (db, a) => ({ purged: a.col }),
  'view.add': (db, a, row) => { const d = dupDb(db, a); const id = dupNewId(row, 'views'); const v = d && id ? viewOf(d, id) : null; return v ? { view: v } : null; },
  'view.one': (db, a) => { const d = dupDb(db, a); const v = d ? viewOf(d, a.viewId) : null; return v ? { view: v } : null; },
  'view.remove': (db, a) => ({ removed: a.viewId }),
  'row.move': (db, a) => { const r = db.prepare(HOT_QUERIES.dbRow).get(a.id); return r ? { row: rowView(r) } : null; },
  'rows.setCell': (db, a, row) => ({ changed: new Set(dupOps(row).filter((o) => o && (o.op === 'text' || (o.op === 'set' && String(o.key).startsWith('cell:')))).map((o) => o.id)).size }),
  // 貼り付けは同じ引数で数え直す（書かない）。足した行は oplog の1行の数
  'rows.paste': (db, a, row, ctx) => {
    let st;
    try { st = rowsPaste(db, a, ctx, true); } catch (_) { return null; }
    return { ...st, added: dupOps(row).filter((o) => o && o.op === 'add').length };
  },
};
const DEFS = {
  // ---- 読む（app と main）
  'pages.list': { roles: ['app', 'main'], write: false, args: { q: 'text?' },
    run: (db, a) => ({ result: a.q ? S.searchList(db, a.q, searchView(db)) : listPages(db) }) },
  'pages.searchFull': { roles: ['app', 'main'], write: false, args: { q: 'text?', limit: 'num?' },
    run: (db, a) => ({ result: S.searchFull(db, a.q || '', a.limit, searchView(db)) }) },
  'pages.actionView': { roles: ['app', 'main'], write: false, args: { q: 'text?', assignee: 'short?', noPrivate: 'bool?' },
    run: (db, a) => ({ result: actionView(db, a) }) },
  // 0.10.0 LS-2（決めたこと 104）: 要約待ちのページ（一覧に出るページのうち summaryWait が真）。main の見回りが mainlib.summaryRetryPick に渡す
  // 0.11.0 M-5（P14 (a)）: 人が選んだ種類（typeAuto 偽・選べる鍵）の会議の作った時刻と種類だけ（since より後。ゴミ箱と録音中の写しは除く）
  'pages.typeSlots': { roles: ['main'], write: false, args: { since: 'short' },
    run: (db, a) => ({ ops: [], pageIds: [], result: listedRows(db)
      .filter((r) => r.attrs.typeAuto === false && mtype.isSelectable(r.attrs.meetingType) && typeof r.createdAt === 'string' && r.createdAt >= a.since)
      .map((r) => ({ createdAt: r.createdAt, meetingType: r.attrs.meetingType })) }) },
  'pages.summaryWaits': { roles: ['main'], write: false, args: {},
    run: (db) => ({ result: listedRows(db).filter((r) => r.attrs.summaryWait === true).map((r) => ({ id: r.id, createdAt: r.createdAt || '', summaryWait: true })) }) },
  'page.get': { roles: ['app', 'main'], write: false, args: { id: 'id' },
    run: (db, a, ctx) => {
      // 0.13.1 NR2: 組めない行を最上位の末尾に並べたら、記録には数だけ（本文・ID は書かない）
      const l = loadPage(db, a.id);
      if (l && l.orphans && ctx && typeof ctx.log === 'function') ctx.log(`DB: 親をたどれない要約の行 ${l.orphans} 件を末尾に並べた`);
      // 2026-10-28 の点検 6（NR42）: 読んだページをそのまま使う（readPage と同じ形。読み直さない）
      const page = l ? l.page : null;
      if (page) R.markShortBlocks(page.blocks);
      // 0.16.0 DV-4（R91）: データベースの行なら、答えにデータベースの ID（db）を添える（画面が行のページと分かり、列とパンくずを読む）。
      // ページの欄には入れない（ページを書き戻す命令が行の attrs に書かないように）
      const me = page ? db.prepare(HOT_QUERIES.dbRow).get(a.id) : null;
      if (me && me.type === 'row') return { result: { page: forView(page, ctx.labels), segments: readSegments(db, a.id), db: me.parent_id } };
      return { result: page ? { page: forView(page, ctx.labels), segments: readSegments(db, a.id) } : null };
    } },

  // ---- 画面の書き込み（app と main。答えは今の main の IPC と同じ）
  // 0.15.0 PL-2（計画 docs/plans/2026-11-03-150.md の決めたこと 13・15・16・35・36・39・F119）: ページのアイコンと見た目（役 app だけ・元に戻すの歩みにしない）。
  // アイコンは辞書の絵文字だけ（'' は欄を消して既定に戻す）・見た目は決まった形だけ（全部既定なら欄を消す）。同じ値は書かない。録音中の写しは断る（締めがページを書き直すため）
  'page.setIcon': { roles: ['app'], write: true, args: { id: 'id', icon: 'pageIcon' },
    run: (db, a, ctx) => pageAttrCmd(db, a.id, ctx, 'icon', a.icon === '' ? undefined : a.icon), dupResult: reread },
  'page.setLook': { roles: ['app'], write: true, args: { id: 'id', look: 'pageLook' },
    run: (db, a, ctx) => pageAttrCmd(db, a.id, ctx, 'look', pageLookLib.isPlainLook(a.look) ? undefined : a.look), dupResult: reread },
  'page.setTitle': { roles: ['app', 'main'], write: true, args: { id: 'id', title: 'title' },
    run: (db, a, ctx) => editPage(db, a.id, ctx, (p) => { p.title = a.title; }), dupResult: reread },
  'page.setMemo': { roles: ['app', 'main'], write: true, args: { id: 'id', memo: 'text?' },
    run: (db, a, ctx) => editPage(db, a.id, ctx, (p) => {
      if (Array.isArray(p.memoDoc)) throw refuse('bad-args');   // 0.14.0 MB-2（決めたこと 70）: 行のあるメモを素の文字だけで上書きしない（行と飾りを黙って捨てない）
      p.memo = String(a.memo || '');
    }), dupResult: reread },
  // 0.14.0 MB-2（決めたこと 59・61・R74・BQ28 (a)）: メモの行を保存し、素の文字のメモ memo（と検索の欄 fold）を memoPlain で作り直す。要約の欄の命令ではない
  'page.setMemoDoc': { roles: ['app'], write: true, args: { id: 'id', doc: 'memoDoc' }, run: setMemoDoc, dupResult: reread },
  // 0.11.0 M-4（決めたこと 8・12。持ち主の試作の「1つの命令＝1つのトランザクション」）: 種類を書き（auto なら自動に戻す）、preset が真なら
  // DB にある今のメモが手を付けていないときだけ新しい型の雛形に替え、経過に1件積む（setTypePage）
  'page.setType': { roles: ['app', 'main'], write: true, args: { id: 'id', type: 'meetingTypeArg', preset: 'bool?' },
    run: (db, a, ctx) => editPage(db, a.id, ctx, (p) => setTypePage(p, a, ctx.now())), dupResult: reread },
  // 削除はゴミ箱へ（Q2。元の JSON から取り込みで戻らないように、行は消さない）。答えは一覧
  'page.delete': { roles: ['app', 'main'], write: true, args: { id: 'id' },
    run: (db, a, ctx) => {
      // DS-2 直し（rv40 F2・R42）: データベースの行はページの木に無いので、ページとしては消さない（行は rows.trash でゴミ箱へ: 決めたこと 28）
      if ((db.prepare(HOT_QUERIES.typeOf).get(a.id) || {}).type === 'row') throw refuse('bad-args');
      const was = loadPage(db, a.id);
      if (!was) return { ops: [], pageIds: [], result: listPages(db) };
      // 0.15.0 PH-2（決めたこと 30・F113）: ゴミ箱に入っていない子孫も、同じ時刻で1つの命令に積む（もうゴミ箱にある子孫の時刻は書き換えない）
      const rows = pageRowsOf(db);
      const at = ctx.now().toISOString();
      const was2 = new Map(rows.map((r) => [r.id, r.trashedAt]));
      const ops = PT.trashGroup(rows, a.id).map((id) => ({ op: 'trash', id, at, old: was2.get(id) }));
      // 0.15.0 PR-1（決めたこと 54・HR15）: 親が白紙のページなら、同じ命令でその本文の行を消し、置き場を子の rowAt に覚える（戻すとそこへ）
      const host = rows.find((r) => r.id === a.id).parentId;
      const hostRow = host === null ? null : rows.find((r) => r.id === host);
      let spot = null;
      // 0.16.0 R97: 親がデータベースの行（行の本文の /ページ）でも同じ（ゴミ箱の行の本文は読まない）
      const bodyHost = hostRow ? isBlankPage(hostRow.attrs) : host !== null && isRowId(db, host);
      const body = !bodyHost ? null : bodyOps(db, host, ctx, (p, w) => { spot = takeSubRow(p, w, a.id); return spot ? undefined : false; });
      if (body) ops.push(...body, { op: 'set', id: a.id, key: 'rowAt', value: spot, old: rowAtOf(db, a.id) });
      applyOps(db, ops);
      return { ops, pageIds: [a.id], result: listPages(db) };
    },
    dupResult: (db) => listPages(db) },
  // ---- 0.15.0 PH-2（決めたこと 13〜16・30〜32。どれも役 app だけ: SEC3）
  'page.create': { roles: ['app'], write: true, args: { parentId: 'id?', placeAt: 'id?' },
    run: pageCreate,
    dupResult: (db, _a, row) => {
      const add = JSON.parse(row.ops || '[]').find((o) => o && o.op === 'add' && o.row && o.row.type === 'page');
      return add ? { page: readPage(db, add.id), id: add.id } : null;
    } },
  'page.move': { roles: ['app'], write: true, args: { id: 'id', parentId: 'idOrEmpty', afterId: 'idOrEmpty?', rowAfter: 'idOrEmpty?', rowParent: 'id?' },   // PR-2 直し（R44）: rowAfter・rowParent
    run: pageMove, dupResult: (db) => listPages(db) },
  'page.restore': { roles: ['app'], write: true, args: { id: 'id' },
    run: pageRestore, dupResult: (db) => listPages(db) },
  'pages.trash': { roles: ['app'], write: false, args: {},
    run: (db) => ({ result: trashHeads(db) }) },
  'block.update': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', patch: 'patch' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      const l = BT.locate(p.blocks, a.blockId);
      if (!l) return false;
      const b = l.b;
      noSubRow(b);   // 0.15.0 PR-1（決めたこと 59）: 子ページの行は文・チェック・型を持たない（前の版の画面の命令も断る）
      const patch = a.patch;
      // 0.14.0 EB-2（決めたこと 16）: 飾りのある行に文だけの直しは断る（黙って飾りを捨てない・ずらさない。画面はいつも rich を送る）
      if (patch.rich === undefined && typeof patch.text === 'string' && Array.isArray(b.rich)) throw refuse('bad-args');
      if (typeof patch.text === 'string' && patch.text !== b.text) {
        // 人が書き換えた要点は出典が元の文に合うか分からない（cites は残し、被覆率の分子から外す。今の store.updateBlock）
        if (b.citeState !== 'manual') b.citeState = 'stale';
        if (isCitable(patch.text)) delete b.citeSkip; else b.citeSkip = true;
        // 0.11.0 M-3（決めたこと 23）: 人が直した印の行（未確認・チェック・助言・メモより）は印を外す（citeState は manual のまま＝手書き）
        delete b.mark; delete b.unconfirmed;
        delete b.aiHeading;   // 2026-10-26 の点検2: 文を変えた元の AI の見出しは、見出しへ戻しても人の行
        b.text = patch.text;
      }
      if (typeof patch.checked === 'boolean') b.checked = patch.checked;
      if (typeof patch.type === 'string') b.type = patch.type;
      if (patch.rich !== undefined) putRich(b, patch.rich);   // 0.14.0 EB-2: 文は validate が rich から作った（normalizeBlock）
      return true;
    }, { summary: true }),
    dupResult: reread },
  // afterBlockId が '' か見つからなければ末尾に足す（今の store.insertBlock と同じ）
  // 0.13.0 ED-2: 型は決まった表（blockType）だけ。見出しの段（level）とコールアウトの絵文字（icon）を足した
  // 0.13.1（決めたこと 4・NR6）: parentId があれば置き場の決まり（afterBlockId が行ならその行と同じ親のすぐ後ろ・'' は parentId の子の頭）。toggle は見出しをトグル見出しに。
  // 足した行に open は書かない（NR4: 書くのは block.setOpen・block.setOpenAll だけ。open の無いトグルは開いている: TQ4）
  'block.insert': { roles: ['app', 'main'], write: true, args: { pageId: 'id', afterBlockId: 'idOrEmpty', type: 'blockType?', level: 'level?', icon: 'icon?', parentId: 'id?', toggle: 'bool?' },
    run: (db, a, ctx) => {
      const blockId = newBlockId(db, ctx.now);
      const out = editPage(db, a.pageId, ctx, (p) => {
        // 人が足した行。LLM の要約ではないので出典の対象外（被覆率の分母に入れない）
        const block = { id: blockId, type: a.type || 'bullet', text: '', cites: [], citeState: 'manual' };
        if (block.type === 'heading' && a.level) block.level = a.level;
        if (block.type === 'heading' && a.toggle === true) block.toggle = true;
        if (block.type === 'callout') block.icon = blockEdit.CALLOUT_ICON;
        if (a.parentId !== undefined) {
          const s = BT.spotOf(p.blocks, a.afterBlockId, a.parentId);
          if (!s) throw refuse('bad-args');
          s.list.splice(s.index, 0, block);
          return;
        }
        // 行の後ろ（入れ子ならその行と同じ親の中: NR6）。'' か見つからなければ末尾
        const l = BT.locate(p.blocks, a.afterBlockId);
        if (l) l.list.splice(l.index + 1, 0, block); else p.blocks.push(block);
      }, { summary: true });
      return { ...out, result: out.result ? { page: out.result, blockId } : null };
    },
    dupResult: (db, a, row) => {
      const page = readPage(db, a.pageId);
      if (!page) return null;
      const add = JSON.parse(row.ops || '[]').find((o) => o && o.op === 'add' && o.row && !isDocType(o.row.type));
      return { page, blockId: add ? add.id : null };
    } },
  'block.remove': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id' },
    // 0.13.1（決めたこと 3・F49）: 子ごと消す（子孫の行も同じ命令の trash に積む）。無い行は何も変えない
    // 0.15.0 PR-1（決めたこと 49・BQ10 (a)）: 子ページの行を消すと、同じ命令でそのページと子孫をゴミ箱へ（答えに trashed）
    run: (db, a, ctx) => {
      const gone = [];
      const out = editPage(db, a.pageId, ctx, (p, was) => {
        const l = BT.locate(p.blocks, a.blockId);
        if (l) { gone.push(...goneSubRows([l.b], l.parent ? l.parent.id : a.pageId, was)); l.list.splice(l.index, 1); }
      }, { summary: true });
      return withRowPages(db, a, ctx, out, gone);
    },
    dupResult: reread },
  // toIndex は「動かす行を抜いたあとの」挿入位置（今の store.moveBlock）
  // 0.13.0 ED-2（決めたこと 18。持ち主の試作の「子は誰の後ろか」）: afterId があれば、その行のすぐ後ろへ（'' は頭）。画面の番号でなく行で頼む
  // 0.13.1（決めたこと 4・NR6・NR19）: parentId（'' の afterId と一緒に）でその親の子の頭へ。afterId の行と同じ親へ動く（子だけを動かすと afterId の行と
  // 同じ親）。子は親と一緒に動く。自分か自分の子孫の中へは bad-args。toIndex（今の形）は最上位の行だけ
  'block.move': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', toIndex: 'num?', afterId: 'idOrEmpty?', parentId: 'id?' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      const l = BT.locate(p.blocks, a.blockId);
      if (!l) return false;
      if (a.afterId !== undefined) {
        if (a.afterId === a.blockId) return false;
        if (a.afterId !== '' && !BT.locate(p.blocks, a.afterId)) throw refuse('bad-args');
        if ((a.afterId && BT.within(l.b, a.afterId)) || (a.parentId && BT.within(l.b, a.parentId))) throw refuse('bad-args');
        const [m] = l.list.splice(l.index, 1);
        const s = BT.spotOf(p.blocks, a.afterId, a.parentId);
        if (!s) throw refuse('bad-args');
        if (headIntoKid([m], s)) throw refuse('bad-args');   // 0.14.0 EK-2（R65）: AI の節の見出しは子にしない（画面の dropSpot だけでなく DB でも）
        s.list.splice(s.index, 0, m);
        return true;
      }
      if (a.toIndex === undefined || l.parent) throw refuse('bad-args');
      const from = l.index;
      const [b] = p.blocks.splice(from, 1);
      const to = Math.max(0, Math.min(Math.trunc(Number(a.toIndex) || 0), p.blocks.length));
      p.blocks.splice(to, 0, b);
      return true;
    }, { summary: true }),
    dupResult: reread },
  'block.setAction': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', assignee: 'short?', dueRaw: 'short?' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      const l = BT.locate(p.blocks, a.blockId);
      if (!l) return false;
      const b = l.b;
      noSubRow(b);   // 0.15.0 PR-1（決めたこと 43）: 子ページの行は担当と期限を持たない
      if (typeof a.assignee === 'string') b.assignee = a.assignee.trim();
      if (typeof a.dueRaw === 'string') {
        b.dueRaw = a.dueRaw.trim();
        const r = parseDue(b.dueRaw, new Date(p.createdAt));
        b.due = r.date; b.dueApprox = r.approx;
      }
      return true;
    }, { summary: true }),
    dupResult: reread },
  // ---- 0.13.0 ED-2（計画 docs/plans/2026-10-24-130.md の決めたこと 10〜13。持ち主の試作の「1つの命令＝1つのトランザクション」と「書いている途中の文も
  // 命令と一緒に送る」）: 分割・結合・型の変換・複製。どれも要約の欄の鍵を見る（summary: true）。oplog の1行が第2b回の「元に戻す」の1歩になる
  // 今の行の文を text（画面の今の文）にしてから at で分け、前を今の行・後ろを新しい行（すぐ下。型は EQ5 (a)）にする → { page, blockId: 新しい行 }
  // （点検1）文のある行の頭（at 0）では、上に空の行（型は EQ5 (a)）を足し、今の行はそのまま残す（空の行の at 0 は今どおり下に足す）
  // （点検8）そのとき afterId（画面で上に見えている行。'' は頭）があれば、上の空の行はその行のすぐ後ろに入る（block.move と同じ。途中の分割では使わない）
  // 0.13.1（NR8）: 入れ子の行の頭の afterId は今の行の兄弟か ''（今の行の親の頭）だけ（画面で1つ上の孫の後ろに入れない）。
  // （TQ3: 持ち主の答え「すぐ下に出し、トグルは開いて作る（おすすめ）」）inside が真なら新しい行は今の行の最初の子（子を持てない型は bad-args）。
  // 型は nextTypeOnEnter（開いたトグルの中はテキスト・inside の無いトグルの後ろは同じ型のトグル: NR25）
  // 0.14.0 EB-2（決めたこと 16・R58）: rich は画面の今の飾り（文は text と同じ。違えば bad-args）。あればそれで分ける
  'block.split': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', text: 'text', at: 'offset', afterId: 'idOrEmpty?', inside: 'bool?', rich: 'richArg?' },
    run: (db, a, ctx) => {
      const blockId = newBlockId(db, ctx.now);
      const out = editPage(db, a.pageId, ctx, (p) => {
        const l = BT.locate(p.blocks, a.blockId);
        if (!l) return false;
        if (!splitAtOk(a.text, a.at)) throw refuse('bad-args');
        if (a.afterId !== undefined && a.afterId !== '' && (a.afterId === a.blockId || !BT.locate(p.blocks, a.afterId))) throw refuse('bad-args');
        const b = l.b;
        noSubRow(b);   // 0.15.0 PR-1（決めたこと 53・59）: 子ページの行は文を持たないので分けない（Enter は画面が下に行を足す）
        if (a.inside === true && !BT.kidsCan(b)) throw refuse('bad-args');
        if (a.rich !== undefined && RT.plainOf(a.rich) !== a.text) throw refuse('bad-args');
        if (a.rich !== undefined) putRich(b, a.rich);   // 分ける前の今の行の飾り（画面の今の形）
        const [head, tail] = [a.text.slice(0, a.at), a.text.slice(a.at)];
        const next = blockEdit.nextTypeOnEnter(b, { open: a.inside === true });
        // 分けた後ろの行は人の行（出典なし・担当と期限なし: 0.11.0 の「要確認」の札が出る）
        const nb = { id: blockId, type: next === 'revert' ? 'paragraph' : next.type, text: tail, cites: [], citeState: 'manual' };
        if (next.level) nb.level = next.level;
        if (next.toggle === true) nb.toggle = true;
        if (nb.type === 'todo') nb.checked = false;
        // 2026-10-26 の持ち主の答え（点検1）: 文のある行の頭では、上に空の行を足し、今の行は ID・文・担当・期限・出典をそのまま残す
        if (a.at === 0 && a.text !== '') {
          nb.text = '';
          if (Array.isArray(b.rich) && b.rich.map((r) => r.t).join('') !== a.text) delete b.rich;
          retext(b, a.text);
          // 2026-10-27 の持ち主の答え（点検8）: 画面で上に見えている行の後ろに足す（0.11.0 の並べ替えて見せる要約でも今の行のすぐ上に見える）
          // 0.13.1 NR8: 入れ子では今の行と同じ親の兄弟の並びの中だけ（'' は今の行の親の子の頭）
          const s = a.afterId === undefined ? null : BT.spotOf(p.blocks, a.afterId, a.afterId === '' && l.parent ? l.parent.id : undefined);
          if (a.afterId !== undefined && (!s || s.list !== l.list)) throw refuse('bad-args');
          if (a.afterId === undefined) l.list.splice(l.index, 0, nb);
          else s.list.splice(s.index, 0, nb);
          return true;
        }
        if (Array.isArray(b.rich)) {
          if (b.rich.map((r) => r.t).join('') === a.text) { const [r1, r2] = blockEdit.splitRich(b.rich, a.at); putRich(b, r1); putRich(nb, r2); } else delete b.rich;
        }
        retext(b, head);
        if (a.inside === true) { if (!Array.isArray(b.children)) b.children = []; b.children.unshift(nb); }   // TQ3: 最初の子
        else l.list.splice(l.index + 1, 0, nb);
        return true;
      }, { summary: true });
      return { ...out, result: out.result ? { page: out.result, blockId } : null };
    },
    dupResult: addedDup },
  // 今の行の文を text にしてから、すぐ前の行の後ろにつなぎ、今の行を消す → { page, blockId: つないだ先, at: つないだ所 }。前が区切り線なら
  // 区切り線だけを消す（決めたこと 17）。頭の行では何もしない。出典は前の行のものを残す（文が変わったので stale）
  // 0.13.1（TQ1: 持ち主の答え「画面で上に見えている行（おすすめ）」）: intoId（画面で上に見えている行）があればそこへつなぐ（自分か自分の子孫・無い行は bad-args）。
  // 無ければ平らにした保存の順の前の行（main など）。消した行の子は、つないだ先の子の末尾へ（子を持てない型なら、つないだ先のすぐ後ろの兄弟: EQ6 (a)）
  // 0.14.0 EB-2（決めたこと 16・R58）: rich は今の行の画面の今の飾り（文は text と同じ。違えば bad-args）。つないだ先の後ろに残す
  'block.merge': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', text: 'text', intoId: 'id?', rich: 'richArg?' },
    run: (db, a, ctx) => {
      let res = { blockId: a.blockId, at: 0 };
      const out = editPage(db, a.pageId, ctx, (p) => {
        const l = BT.locate(p.blocks, a.blockId);
        if (!l) return false;
        noSubRow(l.b);   // 0.15.0 PR-1（決めたこと 53）: 子ページの行はつなぐ元にしない（頭の行でも）
        let pl;
        if (a.intoId !== undefined) {
          if (BT.within(l.b, a.intoId)) throw refuse('bad-args');
          pl = BT.locate(p.blocks, a.intoId);
          if (!pl) throw refuse('bad-args');
        } else {
          const flat = BT.flattenBlocks(p.blocks);
          const i = flat.indexOf(l.b);
          if (i <= 0) return false;
          pl = BT.locate(p.blocks, flat[i - 1].id);
        }
        const b = l.b;
        const prev = pl.b;
        if (isSubRow(prev)) throw refuse('bad-args');   // 0.15.0 PR-1（決めたこと 53・HR18）: 子ページの行はつなぐ先にもしない（画面は子ページの行を選ぶ）
        if (a.rich !== undefined && RT.plainOf(a.rich) !== a.text) throw refuse('bad-args');
        if (a.rich !== undefined) putRich(b, a.rich);   // つなぐ今の行の飾り（画面の今の形）
        if (prev.type === 'divider') { pl.list.splice(pl.index, 1); retext(b, a.text); return true; }
        const at = String(prev.text || '').length;
        const tail = Array.isArray(b.rich) && RT.plainOf(b.rich) === a.text ? b.rich : [{ t: a.text }];   // 今の行の飾りを捨てない（0.14.0 EB-2）
        if (Array.isArray(prev.rich) || Array.isArray(b.rich)) putRich(prev, blockEdit.joinRich(Array.isArray(prev.rich) ? prev.rich : [{ t: String(prev.text || '') }], tail));
        if (a.text) retext(prev, String(prev.text || '') + a.text);
        const kids = Array.isArray(b.children) ? b.children : [];
        l.list.splice(l.index, 1);
        BT.mergeKids(BT.locate(p.blocks, prev.id), kids);
        res = { blockId: prev.id, at };
        return true;
      }, { summary: true });
      const page = out.result || readPage(db, a.pageId);
      return { ...out, result: page ? { page, ...res } : null };
    },
    dupResult: mergeDup },
  // 型を変える（文・出典・担当・期限・チェック・印は残す。見えなくなるだけ）。区切り線へは文の無い行だけ（EQ16 (a)）。citeState の無い行（AI の
  // 見出し・テキスト）を変えたら manual（人が型を決めた行。見出しの段の付け替えでは付けない: 決めたこと 13）
  // 0.13.1（決めたこと 8・NR7・NR10・NR11）: toggle は見出しをトグル見出しに（見出しの段の付け替えと同じ扱い）。子のある行は区切り線にできない。
  // トグル（トグル見出し）をテキストに戻すときと、子を持てない型（トグルでない見出し）へ変えるときは、子をすぐ後ろに元の順で兄弟として並べる。open は書かない（NR4）
  'block.turnInto': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', type: 'blockType', level: 'level?', toggle: 'bool?' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      const l = BT.locate(p.blocks, a.blockId);
      if (!l) return false;
      const b = l.b;
      noSubRow(b);   // 0.15.0 PR-1（決めたこと 43）: 子ページの行の型は変えない（subpage へは型の表 blockType が断る）
      if (a.type === 'divider' && String(b.text || '') !== '') throw refuse('bad-args');
      if (a.type === 'divider' && Array.isArray(b.children) && b.children.length) throw refuse('bad-args');   // NR7（EQ16 (a)）: 子のある行も
      return turnBlock(l, a);   // 0.14.0 EK-2: blocks.turnInto と同じ部品（R65）
    }, { summary: true }),
    dupResult: reread },
  // すぐ下（afterId があればその行の後ろ・'' は頭）に写しを作る（印ごと写す: 同じ文）→ { page, blockId: 写し }
  // 0.13.1（決めたこと 10・17）: 子孫も新しい ID で写す（元の行の open も写すだけ: NR4）。parentId は Alt で中へ落とした所（'' の afterId と一緒に。NR6）
  'block.duplicate': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', afterId: 'idOrEmpty?', parentId: 'id?' },
    run: (db, a, ctx) => {
      const blockId = newBlockId(db, ctx.now);
      const out = editPage(db, a.pageId, ctx, (p) => {
        const l = BT.locate(p.blocks, a.blockId);
        if (!l) return false;
        noSubRow(l.b);   // 0.15.0 PR-1（決めたこと 52・BQ13 (a)）: 子ページの行は写さない（同じページを指す行を2つにしない）
        const after = a.afterId === undefined ? a.blockId : a.afterId;
        if (after !== '' && !BT.locate(p.blocks, after)) throw refuse('bad-args');
        const copy = { ...clone(l.b), id: blockId };
        if (Array.isArray(copy.children)) copy.children = dropSubRows(copy.children);   // 子孫の子ページの行も写さない
        const used = new Set([blockId]);
        for (const d of BT.flattenBlocks(copy.children)) {
          let nid = newBlockId(db, ctx.now);
          while (used.has(nid)) nid = newBlockId(db, ctx.now);
          used.add(nid); d.id = nid;
        }
        const s = BT.spotOf(p.blocks, after, a.parentId);
        if (!s || headIntoKid([copy], s)) throw refuse('bad-args');   // 0.14.0 EK-2（R65）: AI の節の見出しの写しも子にしない
        s.list.splice(s.index, 0, copy);
        pageFits(p, ctx);
        return true;
      }, { summary: true });
      return { ...out, result: out.result ? { page: out.result, blockId } : null };
    },
    dupResult: addedDup },
  // ---- 0.13.1（計画 docs/plans/2026-10-27-131.md の決めたこと 4・6・11・NR14。持ち主の試作の「1つの命令＝1つのトランザクション」）
  // 字下げ（E10・EQ17 (a)）: in は前の兄弟の子の末尾へ・out は親のすぐ後ろへ（親の後ろの兄弟は付いてこない）。できないときは何も書かない（答えは今のページ）。
  // 動かした行の1行（move）だけを書く（子は親の ID を指したまま: NR1）→ { page }
  'block.indent': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', dir: 'dir' },
    run: (db, a, ctx) => {
      const out = editPage(db, a.pageId, ctx, (p) => {
        const plan = BT.indentPlan(p.blocks, a.blockId, a.dir);
        if (!plan) return;
        const l = BT.locate(p.blocks, a.blockId);
        const [m] = l.list.splice(l.index, 1);
        const s = BT.spotOf(p.blocks, plan.afterId, plan.parentId === null ? undefined : plan.parentId);
        s.list.splice(s.index, 0, m);
      }, { summary: true });
      return { ...out, result: out.result ? { page: out.result } : null };
    },
    dupResult: (db, a) => { const page = readPage(db, a.pageId); return page ? { page } : null; } },
  // トグルの開け閉め（EQ18 (a)・EQ19 (a)）: open は見た目だけの欄（NR4: 書くのはこの2つだけ）。トグルとトグル見出しだけ・同じ形なら書かない（R45）。
  // 手直しの印を付けない（NR14）→ { page }
  'block.setOpen': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', open: 'bool' },
    run: (db, a, ctx) => {
      const out = editPage(db, a.pageId, ctx, (p) => {
        const l = BT.locate(p.blocks, a.blockId);
        if (!l || !BT.isToggle(l.b) || BT.isOpenStored(l.b) === a.open) return;
        l.b.open = a.open;
      }, { summary: true, view: true });
      return { ...out, result: out.result ? { page: out.result } : null };
    },
    dupResult: (db, a) => { const page = readPage(db, a.pageId); return page ? { page } : null; } },
  // Ctrl+Alt+T（EQ19 (a)）: ページのトグルを全部 open に（閉じた子の中のトグルも）。oplog の1行
  'block.setOpenAll': { roles: ['app', 'main'], write: true, args: { pageId: 'id', open: 'bool' },
    run: (db, a, ctx) => {
      const out = editPage(db, a.pageId, ctx, (p) => {
        for (const x of BT.flattenBlocks(p.blocks)) {
          if (!BT.isToggle(x) || BT.isOpenStored(x) === a.open) continue;
          x.open = a.open;
        }
      }, { summary: true, view: true });
      return { ...out, result: out.result ? { page: out.result } : null };
    },
    dupResult: (db, a) => { const page = readPage(db, a.pageId); return page ? { page } : null; } },
  // ---- 0.14.0 EB-2（計画 docs/plans/2026-10-26-140.md の決めたこと 2〜6・21）
  // 自分の歩み（steps は tx の並び）を後ろから当てて戻す（editRevert）。役 app だけ → { page }
  'edit.revert': { roles: ['app'], write: true, args: { pageId: 'id', steps: 'txs' },
    run: editRevert,
    dupResult: (db, a) => { const page = readPage(db, a.pageId); return page ? { page } : null; } },
  // 行（ブロック）の色（'red' か 'red_bg'。'' で外す。1つの行でも）。無い行があれば bad-args → page
  // 0.14.0 EK-2（決めたこと 31・R122）: 親の行の色は子孫の行にも付ける・外す（親を選ぶと子も選んだものとして扱う）
  'blocks.setColor': { roles: ['app', 'main'], write: true, args: { pageId: 'id', ids: 'ids', color: 'blockColor' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      // 0.15.0 PR-1 直し（R37・決めたこと 43）: 子ページの行は色（飾り）を持たない。子ページの行だけなら断り、ほかの行と一緒なら除く（複製と同じ）
      const tops = pickRoots(p.blocks, a.ids);
      if (tops.every(isSubRow)) throw refuse('bad-args');
      for (const top of tops) {
        for (const x of BT.flattenBlocks([top])) { if (isSubRow(x)) continue; if (a.color) x.color = a.color; else delete x.color; }
      }
    }, { summary: true }),
    dupResult: reread },
  // ---- 0.14.0 EK-2（計画 docs/plans/2026-10-26-140.md の決めたこと 25・30・31・R65・R66・BQ30 (a)）: どれも1つの命令＝ oplog の1行＝元に戻すの1歩
  // 貼り付け（pasteInto）。rich は画面の今の行の飾り（文はそこから作る）。貼る行は子孫も数えて 2,000 行まで（validate の pasteBlocks）→ { page, lastId }
  'block.paste': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', rich: 'richArg', at: 'offset', blocks: 'pasteBlocks', afterId: 'idOrEmpty?', inside: 'bool?' },
    run: (db, a, ctx) => {
      let lastId = null;
      const out = editPage(db, a.pageId, ctx, (p) => {
        lastId = pasteInto(db, ctx, p, a);
        if (lastId !== null) pageFits(p, ctx);
        return lastId !== null;
      }, { summary: true });
      return { ...out, result: out.result ? { page: out.result, lastId } : null };
    },
    dupResult: pasteDup },
  // 選んだ行を子孫ごと消す（ほかの選んだ行の子孫は重ねない）→ page
  'blocks.remove': { roles: ['app', 'main'], write: true, args: { pageId: 'id', ids: 'ids' },
    // 0.15.0 PR-1（決めたこと 49・BQ10 (a)）: 子ページの行（子孫の行も）を消すと、同じ命令でそのページと子孫をゴミ箱へ（答えに trashed）
    run: (db, a, ctx) => {
      const gone = [];
      const out = editPage(db, a.pageId, ctx, (p, was) => {
        const roots = pickRoots(p.blocks, a.ids);
        for (const b of roots) { const l = BT.locate(p.blocks, b.id); gone.push(...goneSubRows([b], l.parent ? l.parent.id : a.pageId, was)); }
        takeOut(p.blocks, roots);
      }, { summary: true });
      return withRowPages(db, a, ctx, out, gone);
    },
    dupResult: reread },
  // 選んだ行を afterId の行の後ろ（'' は頭・parentId があればその子の頭。0.13.1 の block.move と同じ置き場）へ、画面の順（ids の順）のまま動かす。
  // 選んだ行を外してから置き場を探すので、afterId・parentId が選んだ行（とその子孫）の中・無い行なら置き場が無く bad-args。AI の節の見出しは子にしない（R65）→ page
  'blocks.move': { roles: ['app', 'main'], write: true, args: { pageId: 'id', ids: 'ids', afterId: 'idOrEmpty', parentId: 'id?' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      const roots = pickRoots(p.blocks, a.ids);
      takeOut(p.blocks, roots);
      const s = BT.spotOf(p.blocks, a.afterId, a.parentId);
      if (!s || headIntoKid(roots, s)) throw refuse('bad-args');
      s.list.splice(s.index, 0, ...roots);
    }, { summary: true }),
    dupResult: reread },
  // 選んだ行を子孫ごと新しい ID で写す（既定は最後に選んだ行の後ろ。afterId・parentId は block.duplicate と同じ）→ { page, ids: [写しの行（画面の順）] }
  'blocks.duplicate': { roles: ['app', 'main'], write: true, args: { pageId: 'id', ids: 'ids', afterId: 'idOrEmpty?', parentId: 'id?' },
    run: (db, a, ctx) => {
      let made = [];
      const out = editPage(db, a.pageId, ctx, (p) => {
        const roots = pickRoots(p.blocks, a.ids);
        const after = a.afterId === undefined ? roots[roots.length - 1].id : a.afterId;
        if (after !== '' && !BT.locate(p.blocks, after)) throw refuse('bad-args');
        const used = new Set();
        // 0.15.0 PR-1（決めたこと 52・BQ13 (a)）: 子ページの行は写さない（子孫も）。子ページの行だけなら bad-args
        const keep = dropSubRows(roots.map((b) => clone(b)));
        if (!keep.length) throw refuse('bad-args');
        const copies = keep.map((b) => {
          const c = b;
          for (const d of BT.flattenBlocks([c])) d.id = freshId(db, ctx, used);
          return c;
        });
        const s = BT.spotOf(p.blocks, after, a.parentId);
        if (!s || headIntoKid(copies, s)) throw refuse('bad-args');
        s.list.splice(s.index, 0, ...copies);
        pageFits(p, ctx);
        made = copies.map((c) => c.id);
      }, { summary: true });
      return { ...out, result: out.result ? { page: out.result, ids: made } : null };
    },
    dupResult: (db, a, row) => {
      const page = readPage(db, a.pageId);
      if (!page) return null;
      const added = new Set(JSON.parse(row.ops || '[]').filter((o) => o && o.op === 'add' && o.row && !isDocType(o.row.type)).map((o) => o.id));
      return { page, ids: BT.walk(page.blocks).filter((w) => added.has(w.b.id) && !(w.parentId !== null && added.has(w.parentId))).map((w) => w.b.id) };
    } },
  // 選んだ行の型を変える（行ごとは block.turnInto と同じ: turnBlock）。区切り線へは文も子も無い行だけ（1つでもあれば全部を断る: EQ16 (a)・NR7・R65）→ page
  'blocks.turnInto': { roles: ['app', 'main'], write: true, args: { pageId: 'id', ids: 'ids', type: 'blockType', level: 'level?', toggle: 'bool?' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      if (!a.ids.length) throw refuse('bad-args');
      const rows = [...new Set(a.ids)].map((id) => { const l = BT.locate(p.blocks, id); if (!l) throw refuse('bad-args'); return l.b; });
      rows.forEach(noSubRow);   // 0.15.0 PR-1（決めたこと 43）: 子ページの行の型は変えない（1つでもあれば全部を断る）
      if (a.type === 'divider' && rows.some((b) => String(b.text || '') !== '')) throw refuse('bad-args');
      if (a.type === 'divider' && rows.some((b) => Array.isArray(b.children) && b.children.length > 0)) throw refuse('bad-args');
      for (const b of rows) turnBlock(BT.locate(p.blocks, b.id), a);
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
      keepStoredMemo(was.page, page);   // 0.14.0 MB-3（R165）: メモを送らない書き戻しは保存してあるメモのまま
      keepStoredLook(was.page, page);   // 0.15.0 PL-2: アイコンと見た目も保存してあるまま
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

  // ---- 0.16.0 DS-3: データベース・行・列・ビュー（どれも役 app だけ。oplog の page_id はデータベース: 元に戻すの列はデータベースの歩み）
  'db.create': { roles: ['app'], write: true, args: { parentId: 'id?' }, pageOf: () => null,
    run: dbCreate,
    dupResult: (db, _a, row) => {
      const add = JSON.parse(row.ops || '[]').find((o) => o && o.op === 'add' && o.row && o.row.type === 'page');
      return add ? { page: readPage(db, add.id), id: add.id } : null;
    } },
  'db.get': { roles: ['app'], write: false, args: { id: 'id' }, run: (db, a) => ({ result: dbGetOf(db, a.id) }) },
  'db.view': { roles: ['app'], write: false, args: { id: 'id', viewId: 'id', from: 'int', count: 'int', q: 'short?' }, run: dbViewRead },
  'row.add': { roles: ['app'], write: true, args: { db: 'id', afterId: 'idOrEmpty?', cells: 'cellsArg?', title: 'title?' }, pageOf: dbOfArgs,
    run: rowAdd,
    dupResult: (db, _a, row) => {
      const add = JSON.parse(row.ops || '[]').find((o) => o && o.op === 'add' && o.row && o.row.type === 'row');
      const r = add ? db.prepare(HOT_QUERIES.dbRow).get(add.id) : null;
      return r ? { id: r.id, row: rowView(r) } : null;
    } },
  'row.setCell': { roles: ['app'], write: true, args: { db: 'id', id: 'id', col: 'id', value: 'cellArg' }, pageOf: dbOfArgs,
    run: (db, a, ctx) => { const out = setCells(db, a, ctx, [a.id]); return { ...out, result: { row: rowView(db.prepare(HOT_QUERIES.dbRow).get(a.id)) } }; },
    dupResult: (db, a) => { const r = db.prepare(HOT_QUERIES.dbRow).get(a.id); return r ? { row: rowView(r) } : null; } },
  'rows.setCell': { roles: ['app'], write: true, args: { db: 'id', ids: 'ids', col: 'id', value: 'cellArg' }, pageOf: dbOfArgs,
    run: (db, a, ctx) => { const out = setCells(db, a, ctx, a.ids); return { ...out, result: { changed: out.changed.length } }; },
    dupResult: DUP['rows.setCell'] },
  'row.move': { roles: ['app'], write: true, args: { db: 'id', id: 'id', afterId: 'idOrEmpty' }, pageOf: dbOfArgs, run: rowMove, dupResult: DUP['row.move'] },
  'rows.trash': { roles: ['app'], write: true, args: { db: 'id', ids: 'ids' }, pageOf: dbOfArgs, run: rowsTrash,
    dupResult: (_db, _a, row) => ({ trashed: JSON.parse(row.ops || '[]').length }) },
  'rows.paste': { roles: ['app'], write: true, args: { db: 'id', viewId: 'id', at: 'cellRef', grid: 'pasteGrid' }, pageOf: dbOfArgs, run: rowsPaste, dupResult: DUP['rows.paste'] },
  'col.add': { roles: ['app'], write: true, args: { db: 'id', type: 'colType', name: 'short?', after: 'idOrEmpty?' }, pageOf: dbOfArgs, run: colAdd, dupResult: DUP['col.add'] },
  'col.rename': { roles: ['app'], write: true, args: { db: 'id', col: 'id', name: 'short' }, pageOf: dbOfArgs, run: colRename, dupResult: dupCol },
  'col.setType': { roles: ['app'], write: true, args: { db: 'id', col: 'id', type: 'colType' }, pageOf: dbOfArgs, run: colSetType, dupResult: DUP['col.setType'] },
  'col.typeCheck': { roles: ['app'], write: false, args: { db: 'id', col: 'id', type: 'colType' }, run: colTypeCheck },
  'col.move': { roles: ['app'], write: true, args: { db: 'id', col: 'id', after: 'idOrEmpty' }, pageOf: dbOfArgs, run: colMove, dupResult: dupCol },
  'col.remove': { roles: ['app'], write: true, args: { db: 'id', col: 'id' }, pageOf: dbOfArgs, run: colRemove, dupResult: dupCol },
  'col.restore': { roles: ['app'], write: true, args: { db: 'id', col: 'id' }, pageOf: dbOfArgs, run: colRestore, dupResult: dupCol },
  'col.purge': { roles: ['app'], write: true, args: { db: 'id', col: 'id' }, pageOf: dbOfArgs, run: colPurge, dupResult: DUP['col.purge'] },
  'col.setOpts': { roles: ['app'], write: true, args: { db: 'id', col: 'id', opts: 'optsArg', groups: 'groupsArg?' }, pageOf: dbOfArgs, run: colSetOpts, dupResult: dupCol },
  'col.setFmt': { roles: ['app'], write: true, args: { db: 'id', col: 'id', fmt: 'short?', prefix: 'short?' }, pageOf: dbOfArgs, run: colSetFmt, dupResult: dupCol },
  'view.add': { roles: ['app'], write: true, args: { db: 'id', layout: 'layout?', name: 'short?', from: 'id?' }, pageOf: dbOfArgs, run: viewAdd, dupResult: DUP['view.add'] },
  'view.update': { roles: ['app'], write: true, args: { db: 'id', viewId: 'id', patch: 'viewPatch' }, pageOf: dbOfArgs, run: viewUpdate, dupResult: DUP['view.one'] },
  'view.remove': { roles: ['app'], write: true, args: { db: 'id', viewId: 'id' }, pageOf: dbOfArgs, run: viewRemove, dupResult: DUP['view.remove'] },
  'view.move': { roles: ['app'], write: true, args: { db: 'id', viewId: 'id', after: 'idOrEmpty' }, pageOf: dbOfArgs, run: viewMove, dupResult: DUP['view.one'] },
};

const COMMANDS = Object.freeze(Object.assign(Object.create(null),
  Object.fromEntries(Object.entries(DEFS).map(([k, v]) => [k, Object.freeze(v)]))));

module.exports = { newPageId, COMMANDS, HOT_QUERIES, putPageRows, readPage, readRawPage, readSegments, listPages, isPurged, listedRows, actionView, entryOf, setTypePage, keepStoredMemo };
