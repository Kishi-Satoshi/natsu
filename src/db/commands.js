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
const { isCitable, refreshCitations, searchFold, attachCitations } = require('../cite');
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
// 0.18.0 CW-1（計画 docs/plans/2026-11-18-180.md の決めたこと 10〜14）: Claude の変更の控え（page_snapshot）の中身と戻す形
const CS = require('./claudeSnap');
// 0.18.0 CS-2（決めたこと 15・17〜22）: Claude の要約の書き戻しも、main の［要約を生成］と同じ要約の作り方（summaryWrite.prepareSummary）を通る
const SW = require('../summaryWrite');
const TL = require('../mcp/timeline');
// 0.18.0 CS-3（決めたこと 23〜26）: Claude の名前の直し（要約・メモ・発言・担当・参加者を1回で。純粋な部品）
const NF = require('../nameFix');
const { markdownToBlocks } = require('../minutes');   // 0.18.0 CT-2: Claude が渡す Markdown を本文の行に（要約の書き戻しと同じ読み方。飾りは落ちる）

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
  // 0.17.0 MG-1（決めたこと 46）: 「議事録」データベースの子のページ（議事録。ゴミ箱と録音中の写しは dbRowsOf が外す。一覧の1行の鍵を作る欄も読む）
  minutesKids: "select rid, id, ord, text, attrs, rev, created_at, updated_at, trashed_at from blocks where type = 'page' and parent_id = ?",
  // 0.17.0 MG-2（決めたこと 47・48）: 最上位の生きているページ（移す議事録を探す。attrs は JS で照らす: 壊れた attrs のページで問い合わせを止めない）と、
  // 役の印のある「議事録」データベースの候補（同じ理由で字だけで絞って JS で照らす）・その子の並びの鍵の末尾
  topPages: "select id, ord, attrs, created_at from blocks where type = 'page' and parent_id is null and trashed_at is null",
  minutesDbs: "select id, attrs from blocks where type = 'page' and trashed_at is null and instr(attrs, '\"minutes\"') > 0 order by created_at, id",
  tasksDbs: "select id, attrs from blocks where type = 'page' and trashed_at is null and instr(attrs, '\"tasks\"') > 0 order by created_at, id",   // 0.17.0 TK-1
  tasksDbsAll: "select id, attrs from blocks where type = 'page' and instr(attrs, '\"tasks\"') > 0 order by created_at, id",   // 0.17.0 点検 3（rv60 軽い 4）: ゴミ箱の「タスク管理」も
  kidLastOrd: "select max(ord) as m from blocks where parent_id = ? and type in ('page', 'row')",
  // 0.16.0 DX-2（決めたこと 44）: ゴミ箱の行（［ゴミ箱］の窓のまとまり）と、1つのまとまり（同じデータベース・同じ時刻）の行
  trashedRows: "select id, parent_id, ord, text, trashed_at from blocks where type = 'row' and trashed_at is not null",
  trashedRowsAt: "select id, trashed_at from blocks where type = 'row' and parent_id = ? and trashed_at = ? order by ord, id",
  dbLastOrd: "select max(ord) as m from blocks where type = 'row' and parent_id = ?",
  dbRow: 'select id, type, parent_id, ord, text, attrs, rev, created_at, updated_at, trashed_at from blocks where id = ?',
  viewRow: 'select id, type, page_id, attrs, trashed_at from blocks where id = ?',   // 0.16.0 DL-1: リンクドビューの行（置いたページと attrs）
  pageBlocks: 'select id, type, text, rich, attrs, ord, parent_id from blocks where page_id = ? and id <> ? order by ord',
  // 0.15.0 PR-1（HR14）: 白紙のページの本文の並び（行の木の形と、子ページの行の指すページだけ。文・飾り・ほかの欄は読まない）
  bodyRows: "select id, parent_id, ord, type, json_extract(attrs, '$.page') as sub from blocks where page_id = ? and id <> ? order by ord",
  pageSegments: 'select id, at_ms, duration_ms, text, failed, extra from segments where page_id = ? order by n',
  todoPages: "select distinct page_id from blocks where type = 'todo'",
  oplogTx: 'select seq, role, tx, at, actor, action, page_id, ops from oplog where role = ? and tx = ?',
  purgeMark: "select seq from oplog where page_id = ? and action = 'meeting.discard' and instr(ops, '\"op\":\"purge\"') > 0 limit 1",
  pageOplog: 'delete from oplog where page_id = ?',
  // 0.18.0 CW-1（決めたこと 10〜12）: Claude の変更の控え（page_snapshot。索引 page_snapshot_page(page_id, rid)）
  snapAdd: 'insert into page_snapshot(page_id, at, what, rev_after, body) values (?, ?, ?, ?, ?)',
  snapRevAfter: 'update page_snapshot set rev_after = ? where rid = ?',
  snapDel: 'delete from page_snapshot where rid = ?',   // 点検 1（CR46）: 何も変えなかった書き込みの控え
  snapTrim: 'delete from page_snapshot where page_id = ? and rid not in (select rid from page_snapshot where page_id = ? order by rid desc limit ?)',
  snapList: 'select rid, at, what, rev_after from page_snapshot where page_id = ? order by rid desc limit ?',
  snapOne: 'select rid, body from page_snapshot where rid = ? and page_id = ?',
  snapFrom: 'select rid, body from page_snapshot where page_id = ? and rid >= ? order by rid',
  snapDropFrom: 'delete from page_snapshot where page_id = ? and rid >= ?',
  snapPurge: 'delete from page_snapshot where page_id = ?',
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
// 0.17.0 MG-1（決めたこと 49・F195・P9）: 要約の書き戻しと締め直しは、「議事録」データベースの書ける列の値（議事録のページの attrs.cells）を DB の今の値のまま
function keepStoredCells(was, page) {
  if (Object.hasOwn(was, 'cells')) page.cells = structuredClone(was.cells); else delete page.cells;
}
// 0.17.0 点検 3（rv60 軽い 3・R67。2026-11-15 の持ち主の答え「同じ文の ToDo に印を引き継ぐ（おすすめ）」）: 要約の書き戻し（page.put。作り直した要約は
// 新しいブロックの ID）で、印の無い ToDo の文（前後の空白を除いて）が、前のページの印のある ToDo の文と1字も同じなら、前のページの順で最初に当たる印を
// 引き継ぐ（使った印は外す: 1つのタスクを2つの ToDo が指さない）。送ったページの中で同じ印が2つあれば、後の方の印を外す
function keepTaskMarks(was, page) {
  const marked = (b) => isObj(b) && b.type === 'todo' && typeof b.task === 'string' && b.task !== '';
  const now = BT.flattenBlocks(Array.isArray(page.blocks) ? page.blocks : []);
  const taken = new Set();
  for (const b of now) if (marked(b)) { if (taken.has(b.task)) delete b.task; else taken.add(b.task); }
  const left = [];
  for (const b of BT.flattenBlocks(Array.isArray(was.blocks) ? was.blocks : [])) {
    if (marked(b) && !taken.has(b.task) && !left.some((x) => x.task === b.task)) left.push({ text: String(b.text || '').trim(), task: b.task });
  }
  for (const b of now) {
    if (!left.length) break;
    if (!isObj(b) || b.type !== 'todo' || marked(b)) continue;
    const text = String(b.text || '').trim();
    const i = text ? left.findIndex((x) => x.text === text) : -1;
    if (i < 0) continue;
    b.task = left[i].task;
    left.splice(i, 1);
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
  const trashUp = new Set();   // 0.17.0 点検 2（rv59 軽い 8・R48）: ゴミ箱の子のあるページ（白紙のページの一覧の1行の trashKid）
  for (const r of db.prepare(HOT_QUERIES.list).all()) {
    if (r.trashed_at !== null && r.trashed_at !== undefined) { if (r.parent_id) trashUp.add(r.parent_id); continue; }
    const attrs = JSON.parse(r.attrs || '{}');
    if (isLive(attrs)) continue;
    out.push({ id: r.id, key: keyOfRow(r), attrs, createdAt: r.created_at, parentId: r.parent_id ?? null, ord: r.ord, title: r.text });   // 0.15.0 PH-7: 題名は MCP の場所の文（決めたこと 34）
  }
  // 0.16.0 R97（2026-11-09 の持ち主の答え・M14）: データベースの行の中の子ページ（と子孫）は、行が生きている間だけ一覧に出し、一番近い行の印 inRow を付ける
  // （画面はサイドバーの木に出さない）。行かデータベースをゴミ箱へ入れると見えなくなる（ページには書かない: 決めたこと 28）
  for (const r of out) if (trashUp.has(r.id)) r.trashKid = true;
  // 0.17.0 MG-3（決めたこと 56）: 「議事録」データベース（役の印）に minutes、その子孫（議事録と議事録の子ページ）に inMinutes（画面はサイドバーの木と
  // ライブラリに出さず、「議事録」の1行をいちばん上に固定する）。MCP の答えは shownOf が別に作る（ここの印を読まない: 決めたこと 57）
  const mins = new Set(out.filter((r) => r.attrs.role === 'minutes' && isDbPage(r.attrs)).map((r) => r.id));
  for (const r of out) if (r.attrs.role === 'tasks' && isDbPage(r.attrs)) r.tasks = true;   // 0.17.0 TK-1（決めたこと 65）: 「議事録」の下に固定
  if (mins.size) {
    const byId = new Map(out.map((r) => [r.id, r]));
    for (const r of out) {
      if (mins.has(r.id)) { r.minutes = true; continue; }
      for (let up = r.parentId, seen = 0; up && seen < 1000; seen += 1) {
        if (mins.has(up)) { r.inMinutes = true; break; }
        const u = byId.get(up);
        up = u ? u.parentId : null;
      }
    }
  }
  const scope = rowScope(db, out);
  return out.filter((r) => {
    const s = scope.page(r.id);
    if (!s) return true;
    if (!s.live) return false;
    r.inRow = { row: s.row, title: s.title, db: s.db, dbTitle: s.dbTitle };
    return true;
  });
}

// 0.17.0 SV-1（決めたこと 36）: データベースのページのビュー → 一覧の1行の views（ビューの並びのまま・20 まで・名前は1行）。読むのはもう読んだ attrs の views だけ
const VIEW_ROWS_MAX = 20;
const oneLine = (s) => String(s ?? '').replace(/[\u0000-\u001f\u2028\u2029]+/g, ' ').trim();
const viewRowsOf = (views) => (Array.isArray(views) ? views : []).filter((v) => isObj(v) && typeof v.id === 'string' && v.id)
  .slice(0, VIEW_ROWS_MAX).map((v) => ({ id: v.id, name: oneLine(v.name), type: v.layout === 'list' ? 'list' : 'table' }));
// 0.15.0 PH-2（決めたこと 17・F118）: 一覧の1行の木の欄。覚えた1行（LIST_CACHE）の外で、読んだページの行から添える
// （親と並びの鍵は覚えた1行の鍵に入れない。白紙のページは kind、アイコンはあるときだけ）
function withTree(e, row) {
  e.parentId = row.parentId ?? null;
  e.ord = row.ord;
  if (row.attrs && row.attrs.kind === 'blank') {
    e.kind = 'blank';
    if (row.trashKid) e.trashKid = true;   // 点検 2（rv59 軽い 8）: 画面の［データベース］は、ゴミ箱の子だけを持つページにも出さない（DB の page.toDb と同じ: IR7）
  }
  if (row.attrs && row.attrs.kind === 'database') {
    e.kind = 'database';   // 0.16.0 DR-1: リレーションの列のつなぐ先を選ぶ窓（DX-1 のサイドバーの 🗃️ も）
    e.views = viewRowsOf(row.attrs.views);   // 0.17.0 SV-1（決めたこと 36）: サイドバーのビューの行（データベースの行だけ）
    if (row.attrs.locked === true) e.locked = true;   // 0.17.0 LK-1（決めたこと 74）: サイドバーの行のメニュー（名前を変える・移動先…を出さない）
    if (row.minutes) e.minutes = true;   // 0.17.0 MG-3（決めたこと 56）: 「議事録」データベース（サイドバーのいちばん上に固定）
    if (row.tasks) e.tasks = true;   // 0.17.0 TK-1（決めたこと 65）: 「タスク管理」（「議事録」の下に固定）
  }
  if (row.attrs && typeof row.attrs.icon === 'string' && row.attrs.icon) e.icon = row.attrs.icon;
  if (row.inRow) e.inRow = { ...row.inRow };   // 0.16.0 R97: データベースの行の中のページ（一番近い行・その題名・データベース・その題名）
  if (row.inMinutes) e.inMinutes = true;   // 0.17.0 MG-3（決めたこと 56）: 「議事録」データベースの中（サイドバーの木とライブラリに出さない）
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
    rowsOf: (cands) => rowHits(db, rows, cands),   // 0.16.0 DX-2（決めたこと 46）
  };
}
// 0.16.0 DX-2（決めたこと 46・R102）: 検索に当たった行（一覧の外の ID）のうち、生きている行（ゴミ箱でない行で、データベースもゴミ箱でなく見える所）を
// 一覧の1行の形 { id, title, kind: 'row', db, dbTitle, date } にする。並びはデータベースの一覧の並び・行の並びの鍵の順。texts は抜き出しに使うセルの文字
function rowHits(db, rows, cands) {
  if (!cands.length) return [];
  const scope = rowScope(db, rows);
  const at = new Map(rows.map((r, i) => [r.id, i]));
  const out = [];
  for (const id of cands) {
    const info = scope.row(id);
    if (!info || !info.live) continue;
    const r = db.prepare(HOT_QUERIES.dbRow).get(id);
    if (isTplRaw(r)) continue;   // 0.17.0 RT-1（決めたこと 66）: テンプレートの行は検索に出さない
    const d = dbOf(db, info.db);
    const v = rowView(r);
    out.push({ id, at: at.has(info.db) ? at.get(info.db) : rows.length, ord: r.ord, texts: DM.foldCells(d ? d.cols : [], v.cells).split('\n'),
      entry: { id, title: r.text, kind: 'row', db: info.db, dbTitle: info.dbTitle, date: localDate(new Date(r.created_at)) } });
  }
  out.sort((x, y) => x.at - y.at || cmpStr(x.ord, y.ord));
  return out;
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
// 0.17.0 MG-2（決めたこと 49）: place（ctx）なら、書いた後に最上位になる新しい議事録を「議事録」データベースの子にする操作も足し、全部を1回で当てる → { ops, made }
function putMeetingPage(db, page, segments, was, place = null) {
  if (was) keepStoredCells(was.page, page);   // 0.17.0 MG-1（P9）: 締め直しは「議事録」の列の値を消さない
  const ops = diffPage(was ? was.page : null, page, { ords: was ? was.ords : undefined });
  ops.push(...diffSegments(was ? readSegments(db, page.id) : [], segments, page.id));
  if (was && was.trashedAt !== null && isLive(was.page)) ops.push({ op: 'restore', id: page.id, at: page.updatedAt, old: was.trashedAt });
  const placed = place ? placeOps(db, page.id, place, ops) : { ops: [], made: null };
  ops.push(...placed.ops);
  applyOps(db, ops);
  return { ops, made: placed.made };
}

function meetingFinalize(db, { pageId, page, segments }, ctx) {
  const was = loadPage(db, pageId, { trashed: true });
  // 0.17.0 MG-2（決めたこと 49）: 新しい議事録（行が無い・録音中の写し）は「議事録」データベースへ。締め直し（締めた議事録）は置き場を変えない
  const { ops, made } = putMeetingPage(db, meetingPage(pageId, page, ctx.now, { recovered: false }), segments, was, !was || isLive(was.page) ? ctx : null);
  return { ops, pageIds: made ? [pageId, made, ...colSetIds(ops)] : [pageId], result: readPage(db, pageId) };
}

function meetingRecover(db, { pageId, page, segments }, ctx) {
  const l = loadPage(db, pageId, { trashed: true });
  if (!l && isPurged(db, pageId)) return { ops: [], pageIds: [], result: { page: null, already: true } };
  if (!l || isLive(l.page)) {
    // 行が無い・録音中の写し（ゴミ箱に入っていても）: 下書きの中身で作る・上書きする（下書きが正本）
    const { ops, made } = putMeetingPage(db, meetingPage(pageId, page, ctx.now, { recovered: true }), segments, l, ctx);   // 0.17.0 MG-2: 下書きから作った議事録も「議事録」へ
    return { ops, pageIds: made ? [pageId, made, ...colSetIds(ops)] : [pageId], result: { page: readPage(db, pageId), already: false } };
  }
  // 締め済み（F11）: ページは変えず、下書きにあって DB に無い発言だけ後ろに足す
  const olds = readSegments(db, pageId);
  const have = new Set(olds.map((s) => s.id));
  const news = [...olds, ...segments.filter((s) => !have.has(s.id)).map(clone)];
  const ops = diffSegments(olds, news, pageId);
  applyOps(db, ops);
  return { ops, pageIds: ops.length ? [pageId] : [], result: { page: readPage(db, pageId), already: true } };
}

// ---------------------------------------------------------------- 0.17.0 MG-2（計画 docs/plans/2026-11-13-170.md の決めたこと 45〜49・58・59・F193〜F195・F203）
// 議事録を「議事録」データベースへ。議事録はページのまま（type page）で、親（parent_id）と並びの鍵（ord）だけを前の値つきの move で替える（決めたこと 46）。
// 「議事録」データベースは役の印 attrs.role 'minutes' の1つ（題名では探さない。meta の minutes.db は写しで、食い違えば印を正にして直す: F203）
const MINUTES_TITLE = '議事録';   // 画面の文（「議事録」データベースの題名）
const MINUTES_VIEW = 'すべて';    // 画面の文（ビューの名前）
const minutesCols = () => [{ ...TITLE_COL }, { id: 'c1', name: '日付', type: 'mdate' }, { id: 'c2', name: '作成者', type: 'cby' }, { id: 'c3', name: '参加者', type: 'person' }, { id: 'c4', name: '要約', type: 'msum' }];
const putMetaRow = (db, key, value) => db.prepare('insert into meta(key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
const parseOr = (s) => { try { const v = JSON.parse(s || '{}'); return isObj(v) ? v : null; } catch (_) { return null; } };
// 生きている「議事録」データベース（印のあるデータベース。meta の minutes.db が指す物を先に、無ければ作った順の最初）→ dbOf の形 | null
function minutesDbOf(db) {
  const ids = db.prepare(HOT_QUERIES.minutesDbs).all().filter((r) => { const a = parseOr(r.attrs); return Boolean(a) && a.role === 'minutes' && isDbPage(a); }).map((r) => r.id);
  const m = db.prepare("select value from meta where key = 'minutes.db'").get();
  const id = m && ids.includes(m.value) ? m.value : ids[0];
  return id ? dbOf(db, id) : null;
}
// 新しい「議事録」データベース（プライベートの最上位・ロックした形: 決めたこと 45・50・51・76）→ add の操作
// ID は p＋時刻の36進＋決まった5字（同じ時刻の行がもうあれば今どおりの乱数: newPageId）。決まった時刻で回す道具（tools/make-db-fixture.js）の答えを2回同じにする
const MINUTES_TAIL = 0x2d7b0e5;   // 36 進で 5 字（末尾の字）
function newMinutesDb(db, ctx) {
  let first = true;
  const id = newPageId(db, ctx.now, () => (first ? ((first = false), MINUTES_TAIL) : randU32()));
  const at = ctx.now();
  const cols = minutesCols();
  const page = { id, title: MINUTES_TITLE, kind: 'database', role: 'minutes', locked: true, date: localDate(at), memo: '', blocks: [], cols,
    views: [{ ...DV.defaultView('v1', 'table', cols, MINUTES_VIEW), sort: [{ col: 'c1', dir: 'desc' }] }], nextNo: 1, createdAt: at.toISOString(), updatedAt: at.toISOString() };
  return { op: 'add', id, row: { ...pageRow(page, { ord: PT.TOP_ORD }), parent_id: null } };
}
// 0.17.0 TK-1（決めたこと 60〜62）: 「タスク管理」データベース（役の印 attrs.role 'tasks' の1つ。消せる・ロックしない）。列は 名前・ステータス・担当・期限・
// 優先度・議事録（「議事録」への片側のリレーション: TQ2b）、ビューは すべて・マイタスク（担当に「自分」・完了でない・期限の昇順）・期限順（完了を除く・期限の昇順）
const TASKS_TITLE = 'タスク管理';   // 画面の文
const TASKS_TAIL = 0x2d7b0e6;   // 36 進で 5 字（「議事録」と同じ時刻に作っても ID が重ならない）
const tasksCols = (minutesId) => [{ ...TITLE_COL }, { id: 'c1', name: 'ステータス', type: 'status', ...DM.COLS.status.defaults() }, { id: 'c2', name: '担当', type: 'person' },
  { id: 'c3', name: '期限', type: 'date' }, { id: 'c4', name: '優先度', type: 'select', opts: [{ id: 'o4', name: '高', color: 'red' }, { id: 'o5', name: '中', color: 'yellow' }, { id: 'o6', name: '低', color: 'gray' }] },
  { id: 'c5', name: '議事録', type: 'rel', db: minutesId }];
const ME = '自分';   // 画面の文（担当の「自分」: 0.16.0 の作成者の列の字と同じ。D129）
function tasksDbOf(db) {
  const ids = db.prepare(HOT_QUERIES.tasksDbs).all().filter((r) => { const a = parseOr(r.attrs); return Boolean(a) && a.role === 'tasks' && isDbPage(a); }).map((r) => r.id);
  return ids.length ? dbOf(db, ids[0]) : null;
}
function newTasksDb(db, ctx, minutesId) {
  let first = true;
  const id = newPageId(db, ctx.now, () => (first ? ((first = false), TASKS_TAIL) : randU32()));
  const at = ctx.now();
  const cols = tasksCols(minutesId);
  const base = (vid, name) => DV.defaultView(vid, 'table', cols, name);
  const dueAsc = [{ col: 'c3', dir: 'asc' }];
  const notDone = { col: 'c1', cmp: 'none', value: ['o3'] };
  const views = [base('v1', 'すべて'), { ...base('v2', 'マイタスク'), filter: { op: 'and', items: [{ col: 'c2', cmp: 'contains', value: ME }, notDone] }, sort: dueAsc },
    { ...base('v3', '期限順'), filter: { op: 'and', items: [notDone] }, sort: dueAsc }];
  const page = { id, title: TASKS_TITLE, kind: 'database', role: 'tasks', date: localDate(at), memo: '', blocks: [], cols, views, nextNo: 1, createdAt: at.toISOString(), updatedAt: at.toISOString() };
  return { op: 'add', id, row: { ...pageRow(page, { ord: PT.TOP_ORD }), parent_id: null } };
}
// 「議事録」データベース（無ければ make のときだけ作る操作を返す。当てるのは呼び手が、ほかの操作と一緒に1回だけ: T4b の rev の上がり方）
// → { id, ops（作る add | []）, made（作った ID | null） } | null。meta の minutes.db を印に合わせる（同じトランザクション）
function minutesDbFor(db, ctx, make) {
  const d = minutesDbOf(db);
  if (d) { putMetaRow(db, 'minutes.db', d.id); return { id: d.id, ops: [], made: null }; }
  if (!make) return null;
  const op = newMinutesDb(db, ctx);
  const prev = db.prepare("select value from meta where key = 'minutes.db'").get();
  putMetaRow(db, 'minutes.db', op.id);
  // 0.17.0 点検 3（rv60 軽い 4・R72）: 前の「議事録」（消した・印を外した）を指す「タスク管理」の「議事録」の列は、作った「議事録」へ
  return { id: op.id, ops: [op, ...(prev && prev.value !== op.id ? tasksRelRepoint(db, prev.value, op.id) : [])], made: op.id };
}
// 0.17.0 点検 3（rv60 軽い 4・R72）: 「タスク管理」（役の印。ゴミ箱も）のリレーションの列のうち、from（前の「議事録」）を指す列のつなぐ先を to（今の「議事録」）にする
// 前の値つきの set（列の並び cols）。片側の列（back の無い列）だけ（両側の列は相手の列が対なので替えない）→ 操作の並び（当てない）
function tasksRelRepoint(db, from, to) {
  const out = [];
  for (const r of db.prepare(HOT_QUERIES.tasksDbsAll).all()) {
    const a = parseOr(r.attrs);
    if (!a || a.role !== 'tasks' || !isDbPage(a) || !Array.isArray(a.cols)) continue;
    if (!a.cols.some((c) => isObj(c) && c.type === 'rel' && c.db === from && c.back === undefined)) continue;
    out.push({ op: 'set', id: r.id, key: 'cols', value: a.cols.map((c) => (isObj(c) && c.type === 'rel' && c.db === from && c.back === undefined ? { ...c, db: to } : c)), old: a.cols });
  }
  return out;
}
// 操作のうち、列の並びを書き替えたデータベース（知らせる pageIds に足す）
const colSetIds = (ops) => ops.filter((o) => o.op === 'set' && o.key === 'cols').map((o) => o.id);
// 議事録たち（[{ id, ord }]）を「議事録」の子の末尾へ、渡した順に（並びの鍵は前から順に大きい）→ move の操作（当てない）
function movesUnder(db, m, list) {
  let last = m.made ? null : (db.prepare(HOT_QUERIES.kidLastOrd).get(m.id) || {}).m || null;
  return list.map((p) => { last = appendKey(last); return { op: 'move', id: p.id, ord: last, old: p.ord, parent: m.id, oldParent: null }; });
}
// 締め・復旧で書く議事録（書いた後に最上位になるときだけ）を「議事録」データベースの子にする操作（無ければ同じ命令の中で作る: 決めたこと 49）。
// ops は締め・復旧の書く操作（まだ当てていない）。前の行が無ければその add の行から親と並びの鍵を読む → { ops, made }
function placeOps(db, id, ctx, ops) {
  const r = db.prepare('select parent_id, ord from blocks where id = ?').get(id);
  const add = ops.find((o) => o.op === 'add' && o.id === id);
  const at = r ? { parent: r.parent_id ?? null, ord: r.ord } : add ? { parent: add.row.parent_id ?? null, ord: add.row.ord } : null;
  if (!at || at.parent !== null) return { ops: [], made: null };
  const m = minutesDbFor(db, ctx, true);
  return { ops: [...m.ops, ...movesUnder(db, m, [{ id, ord: at.ord }])], made: m.made };
}
// minutes.gather（役 main・actor system・1つのトランザクション＝oplog の1行）: 最上位の締めた議事録（録音中の写し・ゴミ箱・白紙のページ・データベースを除く）を、
// 会議の日付と始めた時刻の順に「議事録」データベースの子の末尾へ。壊れた attrs のページはそこに残して数える（skipped）。first（0.17.0 の最初の移し替え: 控えの後）は
// 「議事録」が無ければ作り、meta に minutes.gathered（数と時刻）を書く。見回り（first 無し）は移すものがあるときだけ作る（消した「議事録」を起動のたびに作らない）
// → { moved, skipped, created, db }
function minutesGather(db, a, ctx) {
  const top = [];
  let skipped = 0;
  for (const r of db.prepare(HOT_QUERIES.topPages).all()) {
    const attrs = parseOr(r.attrs);
    if (!attrs) { skipped += 1; continue; }
    if (isMeetingRaw(attrs)) top.push({ id: r.id, ord: r.ord, key: `${typeof attrs.date === 'string' ? attrs.date : ''}\u0000${r.created_at || ''}\u0000${r.id}` });
  }
  const m = minutesDbFor(db, ctx, a.first === true || top.length > 0);
  if (!m) return { ops: [], pageIds: [], result: { moved: 0, skipped, created: false, db: null } };
  top.sort((x, y) => cmpStr(x.key, y.key));
  const moves = movesUnder(db, m, top);
  const ops = [...m.ops, ...moves];
  // 0.17.0 TK-1（決めたこと 60）: 最初の移し替えと同じトランザクションで「タスク管理」も（無ければ。見回りでは作らない: 消した後は［タスクにする］が作り直す）
  const tk = a.first === true && !tasksDbOf(db) ? newTasksDb(db, ctx, m.id) : null;
  if (tk) ops.push(tk);
  applyOps(db, ops);
  if (a.first === true) putMetaRow(db, 'minutes.gathered', JSON.stringify({ n: moves.length, at: ctx.now().toISOString() }));
  return { ops, pageIds: ops.length ? [m.id, ...moves.map((o) => o.id), ...(tk ? [tk.id] : []), ...colSetIds(m.ops)] : [], result: { moved: moves.length, skipped, created: Boolean(m.made), db: m.id, tasks: tk ? tk.id : null } };
}
// 起動のとき（DB のプロセス）: 移す議事録があるか（移す前の控えを取るか・見回りの命令を送るかを決める。壊れた attrs のページは数えない）と、
// 「議事録」データベースがもうあるか（初めての起動で、移す物も作る物も無ければ命令を送らない: 空の oplog の行を積まない）
const minutesState = (db) => ({
  pending: db.prepare(HOT_QUERIES.topPages).all().some((r) => { const a = parseOr(r.attrs); return Boolean(a) && isMeetingRaw(a); }),
  hasDb: Boolean(minutesDbOf(db)),
  hasTasks: Boolean(tasksDbOf(db)),   // 0.17.0 TK-1: 最初の起動で「タスク管理」が無ければ、移す物が無くても命令を送る
});

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
  db.prepare(HOT_QUERIES.snapPurge).run(pageId);   // 0.18.0 CW-1（決めたこと 11・RF16）: Claude の変更の控え（ページの文字を持つ）も同じトランザクションで消す
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
  // 0.17.0 PD-1（決めたこと 33）: 種類を替えた歩み（page.toDb と、それを戻した edit.revert）は、その1つの歩みだけで戻す（表の操作の歩みと混ぜない）
  const switched = rows.map((r) => JSON.parse(r.ops || '[]')).map((ops) => ops.some((o) => isObj(o) && o.op === 'set' && o.id === a.pageId && o.key === 'kind'));
  if (switched.some(Boolean)) {
    if (rows.length !== 1) throw refuse('bad-args');
    return kindSwitchRevert(db, a, ctx, JSON.parse(rows[0].ops || '[]'));
  }
  // 0.17.0 TK-2（決めたこと 63）: ［タスクにする］の歩み（とそれを戻した歩み）は、その1つの歩みだけで戻す（要約の欄の歩みと混ぜない）
  const tasked = rows.map((r) => JSON.parse(r.ops || '[]')).map((ops) => ops.some((o) => isObj(o) && o.op === 'set' && o.key === 'task'));
  if (tasked.some(Boolean)) {
    if (rows.length !== 1) throw refuse('bad-args');
    return taskRevert(db, a, ctx, JSON.parse(rows[0].ops || '[]'));
  }
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
  if (back.some((o) => o.op === 'add' && viewToNonDb(db, o.row))) throw refuse('stale');   // 0.17.0 点検 2（rv59 軽い 1・R45）
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
  if (isFixedRow(b) && (text !== '' || a.inside === true)) throw refuse('bad-args');   // 0.16.0 DL-1: リンクドビューの行も
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
  // 0.17.0 MG-3（決めたこと 54・IR18）: 「議事録」データベースの中の議事録は外へ出さない（議事録の子ページ・白紙のページの中の議事録は今どおり）
  if (me.parentId !== null && isMinutesDb(dbOf(db, me.parentId))) throw refuse('bad-args');
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
  // 0.16.0 DL-1（決めたこと 56・DQ9）: 別の親（最上位・ほかのページの子・議事録の子）からなら、下のふつうの動かしの道で親を替え、新しい親（白紙のページか行）の
  // 本文の rowAfter・rowParent の所に行を置く（前の白紙の親の本文の行は同じ命令で消える。満杯の白紙のページの本文なら行を置かずに動かす: R33）
  const cross = (a.rowAfter !== undefined || a.rowParent !== undefined) && me.parentId !== to;
  if (cross && (a.rowAfter === undefined || a.afterId !== undefined || to === null || !(toRow || isBlankPage(tree.byId.get(to).attrs)))) throw refuse('bad-args');
  if (!cross && (a.rowAfter !== undefined || a.rowParent !== undefined)) return placeInBody(db, a, ctx, me, to, tree, toRow);
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
  const fresh = () => newSubRow(db, ctx, a.id);   // 0.16.0 DL-1（決めたこと 39・56）: 新しい親の行に inline は写さない（ページの行になる）
  const put = (p) => (cross ? putAtRow(p, fresh(), a.rowAfter, a.rowParent) : placeSubRow(p, fresh(), { afterPage: a.afterId, sibs }));
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
// 0.16.0 DL-1（決めたこと 56）: 別の親から来たページの行を、本文の rowAfter の行のすぐ後ろ（'' は頭・rowParent があればその子の頭。block.move と同じ置き場:
// BT.spotOf）へ。本文に同じページを指す行がもうあれば（前の版の行）、新しく作らずに動かし、inline を外す（同じページを指す行を2つにしない）
function putAtRow(p, row, rowAfter, rowParent) {
  const had = subSpot(p.blocks, row.page);
  let me = row;
  if (had) { me = had.b; had.list.splice(had.index, 1); delete me.inline; }
  if (rowAfter !== '' && !BT.locate(p.blocks, rowAfter)) throw refuse('bad-args');
  const s = BT.spotOf(p.blocks, rowAfter, rowParent);
  if (!s) throw refuse('bad-args');   // 無い親の行・子を持てない行・親の違う行
  s.list.splice(s.index, 0, me);
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
  if (!me && isRowId(db, a.id)) return rowsRestore(db, a, ctx, rows);   // 0.16.0 DX-2（決めたこと 44）: ゴミ箱の［戻す］の行
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
  // 0.17.0 点検 2（rv59 重要 3・R43）・点検 3（rv60 重要 4・R65）: 戻す組（restoreGroup）の全部について、役の印のある「議事録」「タスク管理」を見る
  const merge = roleMergeOps(db, group);
  ops.push(...merge.ops);
  applyOps(db, ops);
  return { ops, pageIds: [...(body ? [a.id, me.parentId] : [a.id]), ...merge.pageIds], result: listPages(db) };
}
// 0.17.0 点検 2（rv59 重要 3・R43。2026-11-15 の持ち主の答え「中身を今の方へ移す（おすすめ）」）: ゴミ箱から戻す「議事録」データベース（役の印）のほかに、生きている
// 「議事録」があれば、戻す方の子の議事録（ゴミ箱の議事録も。録音中の写しは除く）を、同じ命令で今の方の子の末尾へ（会議の日付と始めた時刻の順）移し、戻す方は
// 役の印を外したふつうのデータベースにする（印のある生きた「議事録」を1つに保つ: F203）。戻す方の列とビューは今の方へ写さない。議事録のセルは、今の方に同じ ID・
// 同じ名前・同じ種類の列（参加者など。選択肢とリレーションの列を除く）があれば残し、同じ ID の違う列の値は外す（今の方の列に違う形の値を見せない）→ { ops, pageIds }
// 戻す組の全部の、役の印のあるデータベース（「議事録」・「タスク管理」）の移し（tails: 今の方の子の末尾の鍵。同じ組に2つあっても鍵を重ねない）→ { ops, pageIds }
function roleMergeOps(db, group) {
  const tails = new Map();
  const ops = []; const pageIds = [];
  for (const id of group) {
    for (const m of [minutesMergeOps(db, id, tails), tasksMergeOps(db, id, tails)]) { ops.push(...m.ops); pageIds.push(...m.pageIds); }
  }
  return { ops, pageIds };
}
function minutesMergeOps(db, id, tails = new Map()) {
  const raw = parseOr((db.prepare('select attrs from blocks where id = ?').get(id) || {}).attrs);
  if (!raw || raw.role !== 'minutes' || !isDbPage(raw)) return { ops: [], pageIds: [] };
  const cur = minutesDbOf(db);
  if (!cur || cur.id === id) return { ops: [], pageIds: [] };
  const list = [];
  for (const r of db.prepare(HOT_QUERIES.minutesKids).all(id)) {
    const at = parseOr(r.attrs);
    if (at && isMeetingRaw(at)) list.push({ id: r.id, ord: r.ord, cells: isObj(at.cells) ? at.cells : {}, key: `${typeof at.date === 'string' ? at.date : ''}\u0000${r.created_at || ''}\u0000${r.id}` });
  }
  list.sort((x, y) => cmpStr(x.key, y.key));
  const ops = [];
  ops.push({ op: 'set', id, key: 'role', value: undefined, old: raw.role });
  const oldCols = new Map((Array.isArray(raw.cols) ? raw.cols : []).filter(isObj).map((c) => [c.id, c]));
  const curCols = new Map(cur.cols.map((c) => [c.id, c]));
  const SAME_OK = (o, n) => Boolean(o) && o.type === n.type && o.name === n.name && !['select', 'multi', 'status', 'rel'].includes(n.type);
  let last = tails.has(cur.id) ? tails.get(cur.id) : (db.prepare(HOT_QUERIES.kidLastOrd).get(cur.id) || {}).m || null;
  for (const p of list) {
    last = appendKey(last);
    ops.push({ op: 'move', id: p.id, ord: last, old: p.ord, parent: cur.id, oldParent: id });
    for (const [k, v] of Object.entries(p.cells)) {
      const n = curCols.get(k);
      if (n && !SAME_OK(oldCols.get(k), n)) ops.push({ op: 'set', id: p.id, key: `cell:${k}`, value: undefined, old: v });
    }
  }
  tails.set(cur.id, last);
  const repoint = tasksRelRepoint(db, id, cur.id);   // 0.17.0 点検 3（rv60 軽い 4・R72）: 古い方を指す「タスク管理」の「議事録」の列は今の方へ
  ops.push(...repoint);
  return { ops, pageIds: [cur.id, ...list.map((p) => p.id), ...colSetIds(repoint)] };
}
// 0.17.0 点検 3（rv60 重要 4・R65。2026-11-15 の持ち主の答え「議事録と同じく今の方へ移す（おすすめ）」）: ゴミ箱から戻す「タスク管理」（役の印）のほかに、生きている
// 「タスク管理」があれば、戻す方の行（ゴミ箱の行も。テンプレートの行は戻す方に残す）を、同じ命令で今の方の行の末尾へ（並びの鍵の順）移し、番号（no）は今の方の
// 続きに振り直し、戻す方は役の印を外したふつうのデータベースにする（R43 と同じ形）。戻す方の列とビューは写さない。行のセルは、今の方に同じ ID・同じ名前・
// 同じ種類の列があり、値が今の方でも同じ意味のとき（選択肢は同じ ID で同じ名前の選択肢・リレーションは今の方の列のつなぐ先の行）だけ残し、
// 同じ ID の違う列の値は外す（前の値つきの set）。今の方に無い ID の値は残す（どこにも出ない）→ { ops, pageIds }
function tasksMergeOps(db, id, tails = new Map()) {
  const raw = parseOr((db.prepare('select attrs from blocks where id = ?').get(id) || {}).attrs);
  if (!raw || raw.role !== 'tasks' || !isDbPage(raw)) return { ops: [], pageIds: [] };
  const cur = tasksDbOf(db);
  if (!cur || cur.id === id) return { ops: [], pageIds: [] };
  const ords = new Map(db.prepare(HOT_QUERIES.dbOrds).all(id).map((r) => [r.id, r.ord]));
  const rows = db.prepare(HOT_QUERIES.dbAllRows).all(id).filter((r) => !tplAttrs(r.attrs)).map((r) => ({ ...r, ord: ords.get(r.id) || '' }))
    .sort((x, y) => cmpStr(x.ord, y.ord) || cmpStr(x.id, y.id));
  const live = rows.filter((r) => r.trashed_at === null || r.trashed_at === undefined).length;
  if (db.prepare(HOT_QUERIES.dbRowCount).get(cur.id).c + live > LIMITS.dbRows) throw refuse('too-big');   // 1つのデータベースの行の上限（決めたこと 7）
  const ops = [{ op: 'set', id, key: 'role', value: undefined, old: raw.role }];
  const oldCols = new Map((Array.isArray(raw.cols) ? raw.cols : []).filter(isObj).map((c) => [c.id, c]));
  const curCols = new Map(cur.cols.map((c) => [c.id, c]));
  const optName = (c, o) => { const x = Array.isArray(c.opts) ? c.opts.find((y) => isObj(y) && y.id === o) : null; return x ? x.name : null; };
  const relIn = (n, v) => (Array.isArray(v) ? v : []).every((x) => typeof x === 'string' && (db.prepare('select parent_id from blocks where id = ?').get(x) || {}).parent_id === n.db);
  const keeps = (o, n, v) => {
    if (!o || o.type !== n.type || o.name !== n.name) return false;
    if (['select', 'multi', 'status'].includes(n.type)) return (Array.isArray(v) ? v : [v]).every((x) => optName(o, x) !== null && optName(o, x) === optName(n, x));
    if (n.type === 'rel') return o.db === n.db || relIn(n, v);
    return true;
  };
  let last = tails.has(cur.id) ? tails.get(cur.id) : (db.prepare(HOT_QUERIES.dbLastOrd).get(cur.id) || {}).m || null;
  let no = Number.isSafeInteger(cur.attrs.nextNo) && cur.attrs.nextNo >= 1 ? cur.attrs.nextNo : 1;
  for (const r of rows) {
    last = appendKey(last);
    const at = parseOr(r.attrs) || {};
    ops.push({ op: 'move', id: r.id, ord: last, old: r.ord, parent: cur.id, oldParent: id }, { op: 'set', id: r.id, key: 'no', value: no, old: at.no });
    no += 1;
    for (const [k, v] of Object.entries(isObj(at.cells) ? at.cells : {})) {
      const n = curCols.get(k);
      if (n && !keeps(oldCols.get(k), n, v)) ops.push({ op: 'set', id: r.id, key: `cell:${k}`, value: undefined, old: v });
    }
  }
  tails.set(cur.id, last);
  if (rows.length) ops.push({ op: 'set', id: cur.id, key: 'nextNo', value: no, old: cur.attrs.nextNo });
  return { ops, pageIds: [cur.id, id, ...rows.map((r) => r.id)] };
}

// 0.16.0 DX-2（決めたこと 44・R98 (1)・R102）: 行のまとまり（同じデータベース・同じ時刻に消した行）を、元の並びの鍵のまま戻す（1つの命令・oplog の1行。
// 元に戻すの歩みにはしない: ページの［戻す］と同じ）。データベースがゴミ箱・見えない所なら bad-args・戻すと 10,000 行を越えるなら too-big（決めたこと 7）
function rowsRestore(db, a, ctx, rows) {
  const r = db.prepare(HOT_QUERIES.dbRow).get(a.id);
  const d = dbOf(db, r.parent_id);
  const up = d ? rowScope(db, rows).page(d.id) : null;
  if (!d || (up && !up.live)) throw refuse('bad-args');
  if (r.trashed_at === null || r.trashed_at === undefined) return { ops: [], pageIds: [], result: listPages(db) };   // ゴミ箱に無い（ほかの窓で戻した）
  const group = db.prepare(HOT_QUERIES.trashedRowsAt).all(d.id, r.trashed_at);
  if (db.prepare(HOT_QUERIES.dbRowCount).get(d.id).c + group.length > LIMITS.dbRows) throw refuse('too-big');
  const at = ctx.now().toISOString();
  const ops = group.map((x) => ({ op: 'restore', id: x.id, at, old: x.trashed_at }));
  applyOps(db, ops);
  return { ops, pageIds: [d.id, ...group.map((x) => x.id)], result: listPages(db) };
}

// ゴミ箱の頭（一緒に消したまとまりの頭だけ。消した新しい順・200 まで: 決めたこと 32）→ [{ id, title, kind?, icon?, trashedAt, count }]
const TRASH_MAX = 200;
function trashHeads(db) {
  const rows = pageRowsOf(db);
  const tree = PT.pageTree(rows);   // 木は1回だけ作る（R11）。親は木の親（壊れた輪の行は最上位: R14）
  const heads = rows.filter((r) => r.trashedAt !== null && !isLive(r.attrs))
    .filter((r) => { const up = tree.byId.get(tree.parent.get(r.id)); return !up || up.trashedAt !== r.trashedAt; });
  // 0.16.0 DX-2（決めたこと 44・R98 (1)・R102）: 行のまとまり（同じデータベース・同じ時刻に消した行。頭は並びの鍵の一番前）。データベースがゴミ箱・見えない所の行は出さない
  const groups = new Map();
  for (const r of db.prepare(HOT_QUERIES.trashedRows).all()) {
    const k = `${r.parent_id}\u0001${r.trashed_at}`;
    const g = groups.get(k);
    if (!g) groups.set(k, { head: r, n: 1 });
    else { g.n += 1; if (cmpStr(r.ord, g.head.ord) < 0 || (r.ord === g.head.ord && r.id < g.head.id)) g.head = r; }
  }
  const scope = groups.size ? rowScope(db, rows) : null;
  const rowHeads = [];
  for (const { head, n } of groups.values()) {
    const d = tree.byId.get(head.parent_id);
    const up = d ? scope.page(d.id) : null;
    if (!d || d.trashedAt !== null || !isDbPage(d.attrs) || (up && !up.live)) continue;
    rowHeads.push({ row: true, id: head.id, title: head.text, db: d.id, dbTitle: d.title, trashedAt: head.trashed_at, n });
  }
  const all = [...heads, ...rowHeads];
  all.sort((x, y) => (x.trashedAt < y.trashedAt ? 1 : x.trashedAt > y.trashedAt ? -1 : 0));
  return all.slice(0, TRASH_MAX).map((r) => {
    if (r.row) return { id: r.id, title: r.title, kind: 'row', db: r.db, dbTitle: r.dbTitle, trashedAt: r.trashedAt, count: r.n - 1 };
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
// 0.16.0 DL-1（決めたこと 40・R105）: リンクドビューの行 { id, type: 'dbview', text: '', db, views }。子ページの行と同じく文と子を持たない（断りは isFixedRow）。
// 指すのは元のデータベース（attrs.db）で、ページの木には入らない（行を消しても元は何もされない）
const isViewRow = (b) => isObj(b) && b.type === 'dbview';
const isFixedRow = (b) => isSubRow(b) || isViewRow(b);
// 本文に描くデータベースの表（インラインの子ページの行とリンクドビューの行）の数（決めたこと 40: 1つの本文に 10 まで）
const tablesIn = (blocks) => BT.flattenBlocks(blocks).filter((b) => (isSubRow(b) && b.inline === true) || isViewRow(b)).length;
const tableRoom = (blocks) => { if (tablesIn(blocks) >= LIMITS.dbTables) throw refuse('too-big'); };
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
      // 0.17.0 点検 3（rv60 軽い 7・R75）: テンプレートの行は生きていない行と同じ（中のページを一覧・検索・Claude に出さず、中にページを作らない: F202）
      const live = (r.trashed_at === null || r.trashed_at === undefined) && !tplAttrs(r.attrs) && alive(d) && isDbPage(d.attrs) && !isLive(d.attrs) && (!up || up.live);
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
      l.list[l.index] = { id: l.b.id, type: 'subpage', text: '', page: row.page, ...(row.inline === true ? { inline: true } : {}) };   // 0.16.0 DL-1: インラインの行
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
// 0.16.0 DL-1（決めたこと 39・R113）: 子ページの行の inline の欄だけを変える（block.update の patch { inline }。ほかの欄と一緒は断る）。行はこのページの子の
// 生きているデータベースを指す子ページの行だけ（ページの 📄・灰色の行・リンクドビューの行は断る）。入れるときは本文の表を 10 まで（too-big）。false は欄を消す
function setInline(db, p, b, patch) {
  if (Object.keys(patch).length !== 1 || !isSubRow(b)) throw refuse('bad-args');
  const d = dbOf(db, b.page);
  if (!d || (db.prepare(HOT_QUERIES.dbRow).get(d.id) || {}).parent_id !== p.id) throw refuse('bad-args');
  if (patch.inline === (b.inline === true)) return true;   // 今と同じ（editPage は書かずに今のページを返す）
  if (patch.inline) { tableRoom(p.blocks); b.inline = true; } else delete b.inline;
  return true;
}
// 子ページの行の断り（決めたこと 52・53・59）: 文を持たない・型を変えない・つながない・分けない・写さない（0.16.0 DL-1: リンクドビューの行も）
function noSubRow(b) {
  if (isFixedRow(b)) throw refuse('bad-args');
}
// 写す行から子ページの行を除く（子孫も。決めたこと 52: 同じページを指す行を2つにしない。0.16.0 DL-1: リンクドビューの行も写さない（表の数を増やさない: R113））
function dropSubRows(list) {
  const out = [];
  for (const b of list) {
    if (isFixedRow(b)) continue;
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
// 0.17.0 LK-1（決めたこと 73）: ロック中のデータベース（attrs.locked が true のデータベースのページ。ゴミ箱でも印は見る）か
function isLockedDb(db, id) {
  if (typeof id !== 'string') return false;
  const a = parseOr((db.prepare('select attrs from blocks where id = ? and type = \'page\'').get(id) || {}).attrs);
  return Boolean(a) && isDbPage(a) && a.locked === true;
}
// db.setLock（決めたこと 73・75。役 app・データベースの歩みにしない）: on なら locked: true、外すなら欄を消す（前の値つき）→ { locked }
function dbSetLock(db, a) {
  const d = mustDb(db, a.db);
  const was = d.attrs.locked === true;
  if (was === a.on) return { ops: [], pageIds: [], result: { locked: was } };
  const ops = [{ op: 'set', id: d.id, key: 'locked', value: a.on ? true : undefined, old: d.attrs.locked }];
  applyOps(db, ops);
  return { ops, pageIds: [d.id], result: { locked: a.on } };
}
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
  if (r.page) {   // 0.17.0 MG-1（決めたこと 50）: 「議事録」データベースの議事録の行。作成者はいつも「自分」・日付と要約は議事録から読む
    out.page = true;   // 0.17.0 MG-4（決めたこと 52）: 画面は議事録のページとして開く（行のページにしない）
    out.by = { c: 'me' };
    const md = meetingDay(attrs.date, r.created_at);
    if (md) out.mdate = md;
    if (typeof r.msum === 'string' && r.msum) out.msum = r.msum;
  }
  return out;
}
// 会議の日付（ページの date）と始めた時刻（createdAt のその PC の時刻）→ 日付の列の値 { start, time? } | null
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function meetingDay(date, createdAt) {
  if (typeof date !== 'string' || !DAY_RE.test(date)) return null;
  const at = new Date(createdAt);
  if (typeof createdAt !== 'string' || Number.isNaN(at.getTime())) return { start: date };
  return { start: date, time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}` };
}
// 0.17.0 MG-1（計画 docs/plans/2026-11-13-170.md の決めたこと 45・46・50〜52・F196）: 「議事録」データベース（役の印 attrs.role 'minutes'）か
const isMinutesDb = (d) => Boolean(d) && d.attrs.role === 'minutes';
// 議事録のページの行か（ページで、種類（白紙のページ・データベース）が無く、録音中の写しでない。ゴミ箱は呼び手が見る）
const isMeetingRaw = (attrs) => attrs.kind === undefined && !isLive(attrs);
// データベースの行を読む1か所（db.view・rel.find・dbDump。書く道の liveRow も同じ決まり）→ 行の生の形（HOT_QUERIES.dbRows の欄）の並び。
// 生きている行（row）からテンプレートの行（attrs.tpl: RT-1）を外し、「議事録」データベースなら子の議事録のページ（ゴミ箱・録音中の写し・白紙のページと
// データベースを除く）を page: true と要約の最初の要点 msum（一覧の1行の preview。一覧と同じ覚えた1行を使う）を付けて足す
// 0.17.0 点検 3（rv60 重要 2・R69）: 表の行の2つの決まり（テンプレートの行を外す・「議事録」の子の生きた議事録のページ）を、数える所（dbRowCountOf）と分け合う
const tplAttrs = (attrs) => typeof attrs === 'string' && attrs.includes('"tpl"') && (parseOr(attrs) || {}).tpl === true;
const plainRowsOf = (db, d) => db.prepare(HOT_QUERIES.dbRows).all(d.id).filter((r) => !tplAttrs(r.attrs));
const minutesPagesOf = (db, d) => (isMinutesDb(d) ? db.prepare(HOT_QUERIES.minutesKids).all(d.id).filter((r) => r.trashed_at === null && isMeetingRaw(JSON.parse(r.attrs || '{}'))) : []);
function dbRowsOf(db, d) {
  const out = plainRowsOf(db, d);
  if (isMinutesDb(d)) {
    const cache = cacheOf(db);
    for (const r of minutesPagesOf(db, d)) {
      const attrs = JSON.parse(r.attrs || '{}');
      const e = entryFor(db, cache, { id: r.id, key: keyOfRow(r), attrs, parentId: d.id, ord: r.ord });
      out.push({ id: r.id, ord: r.ord, text: r.text, attrs: r.attrs, rev: r.rev, created_at: r.created_at, updated_at: r.updated_at, page: true, msum: e ? e.preview : '' });
    }
  }
  return out;
}
// 表と同じ数え方の行の数（db.get の rowCount・MCP の「データベース（行 n）」。無い・ゴミ箱のデータベースは 0）
function dbRowCountOf(db, id) {
  const d = dbOf(db, id);
  return d ? plainRowsOf(db, d).length + minutesPagesOf(db, d).length : 0;
}
// そのデータベースの生きている行（書く命令はこの形に attrs と rev を足して使う）
function liveRow(db, d, id) {
  const r = db.prepare(HOT_QUERIES.dbRow).get(id);
  if (!r || r.parent_id !== d.id || (r.trashed_at !== null && r.trashed_at !== undefined)) throw refuse('bad-args');
  const attrs = JSON.parse(r.attrs || '{}');
  // 0.17.0 MG-1: 「議事録」データベースでは子の議事録のページも行（dbRowsOf と同じ決まり。書けるのは書ける列だけ: 日付・作成者・要約は cellFor が断る）
  const page = r.type === 'page' && isMinutesDb(d) && isMeetingRaw(attrs);
  if (r.type !== 'row' && !page) throw refuse('bad-args');
  const raw = page ? { ...r, page: true } : r;
  return { ...rowView(raw), raw, attrs };
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
  if (r.raw.page) return out;   // 0.17.0 MG-1: 議事録のページには最終更新者を書かない（作成者・最終更新者はいつも「自分」）
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
function sigOf(d, rows, more = '') {
  const h = crypto.createHash('sha1');
  for (const r of rows) h.update(`${r.id}:${r.rev}\n`);
  if (more) h.update(more);
  return `${d.rev}.${rows.length}.${h.digest('hex').slice(0, 16)}`;
}

// 0.16.0 DR-1（決めたこと 34）: ほかのデータベースへのリレーションの列があれば、その相手の行の題名・ゴミ箱が変わっても印を変える（相手のデータベースのページの rev と
// 行の rev・ゴミ箱。自分のデータベースへの列は自分の行の印に入っている）
function relSig(db, d) {
  const dbs = [...new Set(d.cols.filter((c) => c.type === 'rel' && !c.gone && c.db !== d.id).map((c) => c.db))].sort(cmpStr);
  if (!dbs.length) return '';
  const parts = [];
  for (const id of dbs) {
    const p = db.prepare(HOT_QUERIES.pageRow).get(id);
    parts.push(`${id}:${p ? `${p.rev}:${p.trashed_at || ''}` : '-'}`);
    for (const r of db.prepare("select id, rev, trashed_at from blocks where type = 'row' and parent_id = ? order by id").all(id)) parts.push(`${r.id}:${r.rev}:${r.trashed_at || ''}`);
  }
  return parts.join('\n');
}
// データベースを作る（決めたこと 1・43。親は一覧に出るページで、データベースでない。白紙のページの中なら本文の最後に子ページの行: page.create と同じ）→ { page, id }
// 0.16.0 DL-1（決めたこと 39・F141）: inline（/データベース を打った行）があれば、白紙のページの本文のその所に inline: true の子ページの行
// （placeAt と同じ: 空のテキストの行なら替え、ほかの行ならすぐ下・無ければ本文の最後）。議事録の本文・親の無い inline は断る。本文の表は 10 まで（too-big）。
// 満杯の本文（2,000 行）なら page.create と同じく行を置かずに作る（R33）
function dbCreate(db, a, ctx) {
  const rows = pageRowsOf(db);
  const parentId = a.parentId || null;
  const host = parentId === null ? null : rows.find((r) => r.id === parentId);
  if (parentId !== null && (!host || host.trashedAt !== null || isLive(host.attrs) || isDbPage(host.attrs))) throw refuse('bad-args');   // 録音中の写し・ゴミ箱・無い・データベースの中には作らない
  if (a.inline !== undefined && !(host && isBlankPage(host.attrs))) throw refuse('bad-args');   // 議事録の本文・最上位にはインラインを作らない（BQ3）
  const id = newPageId(db, ctx.now);
  const at = ctx.now();
  const ord = parentId === null ? PT.TOP_ORD : PT.siblingKey(PT.pageTree(rows), new Map(rows.map((r) => [r.id, r.ord])), parentId, undefined);
  const cols = [{ ...TITLE_COL }];
  const page = { id, title: '', kind: 'database', date: localDate(at), memo: '', blocks: [], cols, views: [DV.defaultView('v1', 'table', cols)], nextNo: 1,
    createdAt: at.toISOString(), updatedAt: at.toISOString() };
  const ops = [{ op: 'add', id, row: { ...pageRow(page, { ord }), parent_id: parentId } }];
  const inline = a.inline !== undefined;
  const body = host && isBlankPage(host.attrs) ? bodyOps(db, parentId, ctx, (p) => {
    if (inline) tableRoom(p.blocks);
    placeSubRow(p, inline ? { ...newSubRow(db, ctx, id), inline: true } : newSubRow(db, ctx, id), inline ? { placeAt: a.inline } : {});
  }) : null;
  if (body) ops.push(...body);
  applyOps(db, ops);
  return { ops, pageIds: body ? [id, parentId] : [id], result: { page: readPage(db, id), id } };
}
// 0.17.0 PD-1（計画 docs/plans/2026-11-13-170.md の決めたこと 31〜34・F187・F188）: 空の白紙のページを、同じ ID・同じ親と並びの鍵・同じ題名と見た目のまま
// データベースにする（種類・db.create と同じ列とビューと次の番号を書き、空のテキストの行を消し、付けていたアイコンを外す: RQ2）。どれも前の値を持つ
//（1つのトランザクション＝oplog の1行。Ctrl+Z は toDbRevert）。断る（bad-args・何も変えない）: 無い・ゴミ箱（祖先も）・白紙のページでない（議事録・行・
// データベース）・録音中の写し・空でない（本文の文・子のページ（ゴミ箱の子も）・メモ）・親がデータベースの行（行の中にデータベースを作らない）
// 0.17.0 PD-1 直し（rv58 重要 2）: データベースにしてよい白紙のページか（page.toDb と、白紙のページからデータベースへ戻す Ctrl+Z のやり直しが同じ照らしを当てる）
// → { me（ページの行）, hasKid（ゴミ箱の子も数えた子の有無） } | null（無い・ゴミ箱・祖先のどれかがゴミ箱・録音中の写し・白紙のページでない・親がデータベースの行）。
// 本文とメモの「空」（isEmptyBlank）は呼び手が読んだページで見る
function toDbHost(db, id) {
  const rows = pageRowsOf(db);
  const byId = new Map(rows.map((r) => [r.id, r]));
  const me = byId.get(id);
  if (!me || me.trashedAt !== null || isLive(me.attrs) || !isBlankPage(me.attrs)) return null;
  if (me.parentId !== null && isRowId(db, me.parentId)) return null;
  for (let up = me.parentId, seen = new Set(); up !== null && !seen.has(up);) {
    seen.add(up);
    const r = byId.get(up);
    if (!r) break;
    if (r.trashedAt !== null) return null;
    up = r.parentId;
  }
  return { me, hasKid: rows.some((r) => r.parentId === id) };   // ゴミ箱の子も（pageRows はゴミ箱の行も読む）
}
function pageToDb(db, a, ctx) {
  const host = toDbHost(db, a.id);
  if (!host) throw refuse('bad-args');
  const { hasKid } = host;
  const r = editPage(db, a.id, ctx, (p) => {
    if (!PT.isEmptyBlank(p, hasKid)) throw refuse('bad-args');
    const cols = [{ ...TITLE_COL }];
    p.kind = 'database';
    p.cols = cols;
    p.views = [DV.defaultView('v1', 'table', cols)];
    p.nextNo = 1;
    p.blocks = [];
    delete p.icon;
  });
  return { ...r, result: r.result ? { page: r.result, id: a.id } : null };
}
// PD-1（決めたこと 33）: 種類を替えた歩み（page.toDb か、それを戻した edit.revert）を戻す。fwd はその1つの歩みの操作（ページの欄の set と、本文の行の trash か add）。
// データベースから白紙のページへ戻すときは、行が1つでもあれば（ゴミ箱の行も）戻さない（行を見えなくしない）。種類・列・アイコンと本文の行が、その歩みの後の
// 形のままでなければ（後で列を変えて、その歩みがまだ戻っていない・戻した後に本文を書いた）stale。ビューと次の番号は見た目と数なので見ない（前の値へ戻す）
const KIND_SWITCH_SKIP = Object.freeze(['views', 'nextNo', 'updatedAt']);
// ---------------------------------------------------------------- 0.17.0 TK-2（計画 docs/plans/2026-11-13-170.md の決めたこと 63・F199）: ［タスクにする］
// todo.toTask { pageId, blockId }（役 app・1つのトランザクション）: 議事録の要約・白紙のページの本文の ToDo の行から「タスク管理」の行を1つ作り（題名 = ToDo の文・
// 担当 = ToDo の担当（あれば）・期限 = ToDo の期限（あれば。推し量った期限 dueApprox は入れない）・議事録 = その議事録（白紙のページなら空）・ステータス = ToDo が
// 済みなら完了のまとまり、でなければ未着手のまとまりの最初の選択肢）、ToDo の行に attrs.task = 行の ID を書く。印のある ToDo は今の行を返すだけ（二度作らない）。
// 「タスク管理」が無ければ同じ命令の中で作る（決めたこと 60）。列は名前と種類で探す（利用者が消した列には入れない）→ { id, db }
function colByName(d, name, type) { return d.cols.find((c) => !c.gone && c.name === name && c.type === type) || null; }
function todoToTask(db, a, ctx) {
  const l = loadPage(db, a.pageId);
  if (!l || isLive(l.page) || isDbPage(l.page) || l.page.kind === 'row') throw refuse('bad-args');
  if (summaryLockedPage(db, l.page)) throw refuse('locked');
  const hit = BT.locate(l.page.blocks, a.blockId);
  const b = hit ? hit.b : null;
  if (!b || b.type !== 'todo' || !String(b.text || '').trim()) throw refuse('bad-args');
  if (typeof b.task === 'string' && b.task) {
    const r = db.prepare(HOT_QUERIES.dbRow).get(b.task);
    // 0.17.0 点検 3（rv60 軽い 2・R71）: 生きている行（データベースも生きている）だけを「もうある」とする。ゴミ箱なら新しく作り、印を書き替える
    if (r && r.type === 'row' && r.trashed_at === null && dbOf(db, r.parent_id)) return { ops: [], pageIds: [], result: { id: b.task, db: r.parent_id } };
  }
  const ops = [];
  let d = tasksDbOf(db);
  if (!d) {
    const m = minutesDbFor(db, ctx, true);
    ops.push(...m.ops, newTasksDb(db, ctx, m.id));
    applyOps(db, ops);
    d = tasksDbOf(db);
  }
  if (LIMITS.dbRows <= db.prepare(HOT_QUERIES.dbRowCount).get(d.id).c) throw refuse('too-big');   // 1つのデータベースの行の上限（決めたこと 7）
  const cells = {};
  const st = colByName(d, 'ステータス', 'status');
  const grp = st && isObj(st.groups) ? st.groups[b.checked ? 'done' : 'todo'] : null;
  if (Array.isArray(grp) && grp.length) cells[st.id] = grp[0];
  const who = colByName(d, '担当', 'person');
  if (who && typeof b.assignee === 'string' && b.assignee.trim()) cells[who.id] = [b.assignee.trim()];
  const due = colByName(d, '期限', 'date');
  if (due && typeof b.due === 'string' && DAY_RE.test(b.due) && b.dueApprox !== true) cells[due.id] = { start: b.due };
  const rel = colByName(d, '議事録', 'rel');
  const isMeeting = l.page.kind === undefined;
  if (rel && isMeeting && isMinutesDb(dbOf(db, rel.db)) && db.prepare('select parent_id from blocks where id = ?').get(a.pageId).parent_id === rel.db) cells[rel.id] = [a.pageId];
  const id = newRowId(db, ctx.now);
  const no = Number.isSafeInteger(d.attrs.nextNo) && d.attrs.nextNo >= 1 ? d.attrs.nextNo : 1;
  const by = whoOf(ctx);
  const add = [{ op: 'add', id, row: rowBlock({ id, db: d.id, ord: rowOrd(db, d.id), title: oneLine(b.text).slice(0, DM.MAX.title), cells, by: { c: by, u: by }, no, at: ctx.now().toISOString() }) },
    { op: 'set', id: d.id, key: 'nextNo', value: no + 1, old: d.attrs.nextNo },
    { op: 'set', id: b.id, key: 'task', value: id, old: b.task }];
  applyOps(db, add);
  ops.push(...add);
  return { ops, pageIds: [a.pageId, d.id, id], result: { id, db: d.id } };
}
// todo.toTask の歩み（とそれを戻した歩み）を戻す: ToDo の印を前の値へ、作った行はゴミ箱へ（戻した歩みのやり直しは行をゴミ箱から戻す）。「タスク管理」を作った分は戻さない。
// ToDo の印か行が、その歩みの後の形のままでなければ stale（ほかの所で行を消した・印を変えた）
function taskRevert(db, a, ctx, fwd) {
  const mark = fwd.find((o) => isObj(o) && o.op === 'set' && o.key === 'task');
  const blk = mark ? db.prepare('select page_id, attrs from blocks where id = ?').get(mark.id) : null;
  if (!blk || blk.page_id !== a.pageId) throw refuse('stale');
  const now = parseOr(blk.attrs);
  if (!now || !isDeepStrictEqual(now.task, mark.value)) throw refuse('stale');
  const rowId = typeof mark.value === 'string' ? mark.value : mark.old;
  const r = typeof rowId === 'string' ? db.prepare(HOT_QUERIES.dbRow).get(rowId) : null;
  if (!r || r.type !== 'row') throw refuse('stale');
  const live = r.trashed_at === null || r.trashed_at === undefined;
  const back = [{ op: 'set', id: mark.id, key: 'task', value: mark.old, old: mark.value }];
  if (typeof mark.value === 'string') { if (!live) throw refuse('stale'); back.push({ op: 'trash', id: rowId, at: ctx.now().toISOString(), old: null }); }
  else { if (live) throw refuse('stale'); back.push({ op: 'restore', id: rowId, at: ctx.now().toISOString(), old: r.trashed_at }); }
  applyOps(db, back);
  return { ops: back, pageIds: [a.pageId, r.parent_id, rowId], result: { page: readPage(db, a.pageId) } };
}

// 0.17.0 PD-1 直し（rv58 重要 3）: ほかの所からこのデータベースへの指し。データベースのリレーションの列（消した列も: col.restore で戻せるので）の相手か、
// リンクドビューの行（attrs.db）の元か。あれば白紙のページへ戻さない（つなげない列・データベースでないページを指すビューを作らない）。
// 点検 2（rv59 軽い 1・R45）: ゴミ箱のデータベースの列と、消した（ゴミ箱の）リンクドビューの行も数える（戻すと白紙のページを指す）。attrs は JS で照らす
// （parseOr。json_extract は壊れた attrs の行1つで問い合わせごと投げ、Ctrl+Z が internal になる: R40 と同じ理由）
const relColsTo = (db, id) => db.prepare("select attrs from blocks where type = 'page' and instr(attrs, '\"rel\"') > 0").all()
  .some((r) => { const a = parseOr(r.attrs); return Boolean(a) && isDbPage(a) && Array.isArray(a.cols) && a.cols.some((c) => isObj(c) && c.type === 'rel' && c.db === id); });
// 足し直すリンクドビューの行（row）が、データベースでなくなったページ（白紙のページへ戻したデータベース）を指すか。消した行は oplog にだけあり、
// 数えられないので、足し直す Ctrl+Z の側で断る（無いページ・ゴミ箱のデータベースを指す行は今どおり戻す）
function viewToNonDb(db, row) {
  if (!isObj(row) || row.type !== 'dbview') return false;
  const a = typeof row.attrs === 'string' ? parseOr(row.attrs) : row.attrs;
  const t = isObj(a) && typeof a.db === 'string' ? db.prepare(HOT_QUERIES.pageRow).get(a.db) : null;
  if (!t || t.type !== 'page') return false;
  const ta = parseOr(t.attrs);
  return !ta || !isDbPage(ta);
}
const linkedViewsTo = (db, id) => db.prepare("select attrs from blocks where type = 'dbview'").all().some((r) => { const a = parseOr(r.attrs); return Boolean(a) && a.db === id; });
function kindSwitchRevert(db, a, ctx, fwd) {
  const id = a.pageId;
  const row = db.prepare('select type, attrs, trashed_at from blocks where id = ?').get(id);
  if (!row || row.type !== 'page' || row.trashed_at !== null) throw refuse('stale');
  const attrs = JSON.parse(row.attrs || '{}');
  const kindOp = fwd.find((o) => o.op === 'set' && o.id === id && o.key === 'kind');
  if (!kindOp) throw refuse('bad-args');
  if (kindOp.value === 'database') {   // データベース → 白紙のページ（Ctrl+Z）
    if (attrs.locked === true) throw refuse('stale');   // 0.17.0 LK-1（決めたこと 74）: ロック中のデータベースは白紙のページに戻さない
    if (db.prepare(HOT_QUERIES.dbAllRows).all(id).length) throw refuse('has-rows');   // 行（ゴミ箱の行も）。知らせを分ける答え（rv58 軽い 1）
    if (relColsTo(db, id)) throw refuse('stale');   // rv58 重要 3: ほかのデータベースのリレーションの列の相手
    if (linkedViewsTo(db, id)) throw refuse('stale');   // rv58 重要 3: リンクドビューの行の元
  } else {   // 白紙のページ → データベース（やり直し）: page.toDb と同じ照らし（rv58 重要 2。中身・子・録音中・親が行・祖先がゴミ箱なら変えない）
    const host = toDbHost(db, id);
    const l = host ? loadPage(db, id) : null;
    if (!l || !PT.isEmptyBlank(l.page, host.hasKid)) throw refuse('stale');
  }
  const blockNow = db.prepare('select type, page_id, text, attrs from blocks where id = ?');
  const back = [];
  for (const o of [...fwd].reverse()) {
    if (o.op === 'set' && o.id === id) {
      if (!KIND_SWITCH_SKIP.includes(o.key) && !isDeepStrictEqual(attrs[o.key], o.value)) throw refuse('stale');
      if (o.key === 'updatedAt') continue;
      back.push({ op: 'set', id, key: o.key, value: o.old, old: attrs[o.key] });
    } else if (o.op === 'trash' && isObj(o.old) && o.old.page_id === id && o.old.type === 'paragraph') {
      if (blockNow.get(o.id)) throw refuse('stale');
      back.push({ op: 'add', id: o.id, row: o.old });
    } else if (o.op === 'add' && isObj(o.row) && o.row.page_id === id && o.row.type === 'paragraph') {
      const b = blockNow.get(o.id);
      if (!b || b.type !== 'paragraph' || String(b.text || '') !== '' || !isDeepStrictEqual(JSON.parse(b.attrs || '{}'), isObj(o.row.attrs) ? o.row.attrs : {})) throw refuse('stale');
      back.push({ op: 'trash', id: o.id, old: o.row });
    } else throw refuse('bad-args');
  }
  back.push({ op: 'set', id, key: 'updatedAt', value: ctx.now().toISOString(), old: db.prepare('select updated_at from blocks where id = ?').get(id).updated_at });
  applyOps(db, back);
  return { ops: back, pageIds: [id], result: { page: readPage(db, id) } };
}
// 0.16.0 DX-3（決めたこと 49・R103）: Claude（MCP）が読むデータベースの中身。列（消した列は除く。名前と種類の名前）と、最初のビューの並べ替えの順
// （ビューの絞り込みとグループは当てない: Claude からの絞り込みは 0.18.0）の行の頭から max 行。値は画面と同じ見せ方の文字（fmtCell。リレーションは生きている相手の題名）。
// 文字を1行にするのは呼び手（src/mcp/format.js の safeLine）→ { total, cols: [{ name, label }], rows: [{ title, vals: [[列の名前, 値]] }] } | null（無い・ゴミ箱）
function dbDump(db, id, max, nowMs) {
  const d = dbOf(db, id);
  if (!d) return null;
  const list = dbRowsOf(db, d).map(rowView);
  const v0 = d.views.length ? normView(d, d.views[0]) : DV.defaultView('v1', 'table', d.cols);
  const order = DV.applyView(list, { ...v0, filter: null, group: null }, d.cols, { now: nowMs }).order;
  const byId = new Map(list.map((r) => [r.id, r]));
  const cols = d.cols.filter((c) => !c.gone && Object.hasOwn(DM.COLS, c.type));
  const picked = order.slice(0, max).map((o) => byId.get(o.id)).filter(Boolean);
  const titles = relTitlesOf(db, picked.flatMap((r) => relIdsIn(cols, r.cells)));
  const opts = { rowsById: new Map(Object.entries(titles)) };
  return {
    total: list.length,
    cols: cols.map((c) => ({ name: c.name, label: DM.COLS[c.type].label })),
    rows: picked.map((r) => ({
      title: DM.fmtCell(TITLE_COL, r.title, opts),
      vals: cols.filter((c) => c.type !== 'title').map((c) => [c.name, DM.fmtCell(c, DM.cellValue(r, c), opts)]).filter((x) => x[1] !== ''),
    })),
  };
}
// データベースの形（列・照らしたビュー・今の行の数。行の数は削除の確かめの文が使う: 決めたこと 44・R36）→ null（無い・ゴミ箱）
// 0.16.0 DL-1（R105・R113）: linked（リンクドビューの行）があれば views はその行のビュー（元の今の列で照らす）
function dbGetOf(db, id, linked) {
  const d = dbOf(db, id);
  if (!d) return null;
  const views = linked === undefined ? d.views : linkedOf(db, d.id, linked).views;
  const out = { id, title: d.title, cols: d.cols, views: views.map((v) => normView(d, v)), rowCount: dbRowCountOf(db, id) };   // 0.17.0 点検 3（rv60 重要 2・R69）: 表と同じ数え方
  if (typeof d.attrs.icon === 'string' && d.attrs.icon) out.icon = d.attrs.icon;
  if (d.attrs.locked === true) out.locked = true;   // 0.17.0 LK-1（決めたこと 73）
  if (d.attrs.role === 'tasks') out.tasks = true;   // 0.17.0 TK-1（決めたこと 62）: 担当の候補の先頭に「自分」
  if (!isMinutesDb(d)) out.tpls = tplInfo(db, d);   // 0.17.0 RT-1（決めたこと 66・67）: テンプレートの並びとビューごとの既定
  if (isMinutesDb(d)) out.minutes = true;   // 0.17.0 MG-4（決めたこと 52・53）: 「議事録」データベースの表（［＋ 新しい議事録］・読む列の灰色・空のときの文）
  const sub = subOf(d);   // 0.16.0 DR-1 直し2（rv51 I2・R108）: 木にしているときだけ（列が消えている・互いを指していないなら無い）
  if (sub) out.sub = sub;
  return out;
}
// 表を読む（決めたこと 30・R20）: 行を1回読み、dbView.applyView で絞り込み・並べ替え・グループ・集計をし、並べる行（shown）の from から count だけ返す
function dbViewRead(db, a, ctx) {
  if (!Number.isSafeInteger(a.from) || a.from < 0 || !Number.isSafeInteger(a.count) || a.count < 1 || a.count > DB_VIEW_MAX) throw refuse('bad-args');
  const d = dbOf(db, a.id);
  if (!d) return { result: null };
  // 0.16.0 DL-1（R105）: linked（リンクドビューの行）はその行のビューで読み、印にその行のビューの並びを入れる（タブや設定を変えると描き直す: R113）
  const L = a.linked === undefined ? null : linkedOf(db, d.id, a.linked);
  const raw = (L ? L.views : d.views).find((v) => v.id === a.viewId);
  if (!raw) throw refuse('bad-args');
  const v = normView(d, raw);
  const stored = dbRowsOf(db, d);
  const list = stored.map(rowView);
  const sub = subOf(d);   // 0.16.0 DR-1: サブアイテムの木（開いた行は画面の窓のメモリ: 決めたこと 38）
  const out = DV.applyView(list, v, d.cols, { now: ctx.now().getTime(), q: a.q, ...(sub ? { sub, open: a.open || [] } : {}) });
  const shown = new Set(v.props.filter((p) => p.show).map((p) => p.col));
  const byId = new Map(list.map((r) => [r.id, r]));
  const rows = out.order.slice(a.from, a.from + a.count).map((o) => {
    const r = byId.get(o.id);
    const cells = {};
    for (const [k, x] of Object.entries(r.cells)) if (shown.has(k)) cells[k] = x;
    const one = { ...r, cells, depth: o.depth, hasKids: o.hasKids };
    if (o.dim) one.dim = true;
    if (o.g !== undefined) one.g = o.g;
    return one;
  });
  // DR-1（決めたこと 34）: 返す行のリレーションのセルの相手の題名（ゴミ箱の行・ゴミ箱のデータベースの行は入れない: 値は残る）
  const rel = relTitlesOf(db, rows.flatMap((r) => relIdsIn(d.cols, r.cells, shown)));
  return { result: { total: out.total, shown: out.shown, rows, groups: out.groups, agg: out.agg, rel, sig: sigOf(d, stored, relSig(db, d) + (L ? `\n${L.id}\n${JSON.stringify(L.raw)}` : '')) } };
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
// 0.16.0 DR-1（R98 (1)・M15-1）: サブアイテムの入ったデータベースでは、子のある行の子孫の生きている行も同じ命令（同じ時刻）でゴミ箱へ。答えの数は子孫も数える
function rowsTrash(db, a, ctx) {
  const d = mustDb(db, a.db);
  const at = ctx.now().toISOString();
  const picked = [...new Set(a.ids)].map((id) => liveRow(db, d, id));
  const extra = subKidsOf(db, d, picked.map((r) => r.id)).map((id) => liveRow(db, d, id));
  const rows = [...picked, ...extra];
  const ops = rows.map((r) => ({ op: 'trash', id: r.id, at, old: r.raw.trashed_at ?? null }));
  // 0.17.0 点検 2（rv59 重要 1・R44）: 「議事録」の議事録の行は、page.delete と同じく子孫のページも同じ時刻で（trashGroup。もうゴミ箱にある子孫は
  // 書き換えない）。子ページを親の無い最上位に残さない。答えの数は表の行だけ（知らせ「行 n 件」）
  const meetings = rows.filter((r) => r.raw.page);
  if (meetings.length) {
    const prows = pageRowsOf(db);
    const tree = PT.pageTree(prows);
    const seen = new Set(ops.map((o) => o.id));
    for (const r of meetings) for (const id of PT.trashGroup(prows, r.id, tree)) if (!seen.has(id)) { seen.add(id); ops.push({ op: 'trash', id, at, old: null }); }
  }
  return dbDone(db, d, ops, { trashed: rows.length }, ops.map((o) => o.id));
}
// 何行何列かの貼り付け（DQ7 (a)・決めたこと 52・R35）: ビューの見えている並びで、選んだセルから右下へ。足りない行は足し（絞り込みの値を入れる）、
// 右にはみ出した列・書けない列・リレーションは飛ばして skipped に、種類に読めない値は空にして unread に数える。全部が1つの命令（Ctrl+Z の1回）
function rowsPaste(db, a, ctx, dry = false) {
  const d = mustDb(db, a.db);
  const raw = viewOf(d, a.viewId);
  if (!raw) throw refuse('bad-args');
  const v = normView(d, raw);
  // 0.17.0 点検 2（rv59 軽い 5・R46）: 表に見えている並びと同じ1か所（dbRowsOf。「議事録」では議事録の行も）で並べる
  const stored = dbRowsOf(db, d);
  const list = stored.map(rowView);
  const order = [...new Set(DV.applyView(list, v, d.cols, { now: ctx.now().getTime() }).order.map((o) => o.id))];
  const start = order.indexOf(a.at.row);
  const vcols = v.props.filter((p) => p.show).map((p) => colIn(d.cols, p.col)).filter((c) => c && !c.gone);
  const c0 = vcols.findIndex((c) => c.id === a.at.col);
  if (start < 0 || c0 < 0) throw refuse('bad-args');
  const rowsFor = order.slice(start, start + a.grid.length);
  while (rowsFor.length < a.grid.length) rowsFor.push(null);   // 足りない行は足す
  const adding = rowsFor.filter((x) => x === null).length;
  if (adding && isMinutesDb(d)) throw refuse('bad-args');   // 決めたこと 52: 「議事録」では行を足す分の貼り付けを使えない
  if (db.prepare(HOT_QUERIES.dbRowCount).get(d.id).c + adding > LIMITS.dbRows) throw refuse('too-big');
  const colsNow = new Map(d.cols.map((c) => [c.id, c]));
  const defaults = DV.filterDefaults(v, d.cols);
  const locked = d.attrs.locked === true;
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
        // 0.17.0 LK-1（決めたこと 74）: ロック中は選択肢を足さない（足す値は読めない値と同じく空にして数える）
        const grew = locked && !isDeepStrictEqual(got.col, colsNow.get(col.id));
        if (!grew) colsNow.set(col.id, got.col);
        val = grew ? null : got.value;
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

// ---- 0.17.0 RT-1（計画 docs/plans/2026-11-13-170.md の決めたこと 66・67・69・70・F202）: 行のテンプレート
// テンプレートはデータベースの下の行（type row）に attrs.tpl = true を付けた物（題名・列の値・本文）。表・検索・MCP・集計・リレーションの選びには出さない（dbRowsOf が外す）。
// 1つのデータベースに 20 まで。既定はデータベースの既定 attrs.tplDefault と、ビューごとの既定 attrs.tplViews（{ ビューの ID: テンプレートの ID | '' }。'' は「空白のページ」）。
// ビューの既定はデータベースの欄に持つ（ビューの設定 views は元に戻すの歩みにしない: DB_NO_REVERT。R58・M12）。どれも役 app・データベースの歩み（Ctrl+Z）
const isTplRaw = (r) => Boolean(r) && r.type === 'row' && (r.trashed_at === null || r.trashed_at === undefined) && (parseOr(r.attrs) || {}).tpl === true;
const tplRowsOf = (db, d) => db.prepare("select id, type, ord, text, attrs, trashed_at, created_at from blocks where type = 'row' and parent_id = ? and instr(attrs, '\"tpl\"') > 0 order by ord, id").all(d.id).filter(isTplRaw);
function liveTpl(db, d, id) {
  const r = db.prepare(HOT_QUERIES.dbRow).get(id);
  if (!r || r.parent_id !== d.id || !isTplRaw(r)) throw refuse('bad-args');
  return r;
}
const tplViewsOf = (d) => (isObj(d.attrs.tplViews) ? d.attrs.tplViews : {});
// 画面の形（db.get の tpls）: テンプレートの並び（題名）・ビューごとの今の既定（ビューの既定 → データベースの既定 → ''）
function tplInfo(db, d) {
  const list = tplRowsOf(db, d).map((r) => ({ id: r.id, title: r.text }));
  const ids = new Set(list.map((x) => x.id));
  const base = typeof d.attrs.tplDefault === 'string' && ids.has(d.attrs.tplDefault) ? d.attrs.tplDefault : '';
  const per = tplViewsOf(d);
  const defaults = {};
  for (const v of d.views) defaults[v.id] = typeof per[v.id] === 'string' && (per[v.id] === '' || ids.has(per[v.id])) ? per[v.id] : base;
  return { list, base, defaults };
}
// 0.17.0 点検 3（rv60 軽い 2・R71）: 写した行（子孫も）から［タスクにする］の印を外す（block.duplicate・blocks.duplicate。copyBodyOps と同じ考え）
function dropTaskMarks(list) { for (const b of BT.flattenBlocks(list)) delete b.task; }
// 本文のブロックを写す操作（ブロックの ID は新しく作り、子ページの行・リンクドビューの行とその下は写さない。ToDo の［タスクにする］の印は外す）
function copyBodyOps(db, ctx, fromId, toId) {
  const rows = db.prepare(HOT_QUERIES.pageBlocks).all(fromId, fromId);
  const map = new Map([[fromId, toId]]);
  const out = [];
  for (const r of rows) {
    if (r.type === 'subpage' || r.type === 'dbview' || !map.has(r.parent_id)) continue;   // 親を写さなかったブロックの下も写さない
    const id = newBlockId(db, ctx.now);
    map.set(r.id, id);
    const attrs = parseOr(r.attrs) || {};
    delete attrs.task;
    let rich = null;
    try { rich = r.rich ? JSON.parse(r.rich) : null; } catch (_) { rich = null; }
    out.push({ op: 'add', id, row: { id, type: r.type, page_id: toId, parent_id: map.get(r.parent_id), ord: r.ord, text: String(r.text || ''), rich: Array.isArray(rich) ? rich : null, attrs, rev: 1, created_at: '', updated_at: '', trashed_at: null } });
  }
  return out;
}
const rowsFull = (db, d) => LIMITS.dbRows <= db.prepare(HOT_QUERIES.dbRowCount).get(d.id).c;   // 1つのデータベースの行の上限（テンプレートも数える: 決めたこと 7）
function tplRoom(db, d) {
  if (tplRowsOf(db, d).length >= LIMITS.tpls) throw refuse('too-big');
  if (rowsFull(db, d)) throw refuse('too-big');
}
// 新しい行（テンプレートか、テンプレートから作る行）の操作。src があれば題名・列の値（今ある書ける列だけ）・本文を写す
function tplRowOps(db, a, ctx, d, src, asTpl) {
  const id = newRowId(db, ctx.now);
  const who = whoOf(ctx);
  // 0.17.0 点検 3（rv60 重要 3・R70）: 両側のリレーション（back のある列・自分への列1つ）の値は写さない（相手の行に作った行が入らず、片側だけになる）
  const twoSided = (c) => c.type === 'rel' && (c.back !== undefined || c.db === d.id);
  const live = new Set(d.cols.filter((c) => !c.gone && c.type !== 'title' && DM.COLS[c.type] && DM.COLS[c.type].writable && !twoSided(c)).map((c) => c.id));
  const from = src ? (parseOr(src.attrs) || {}).cells : null;
  const cells = {};
  if (isObj(from)) for (const [k, v] of Object.entries(from)) if (live.has(k)) cells[k] = structuredClone(v);
  const title = src ? String(src.text || '') : String(a.title || '');
  const ops = [];
  if (asTpl) {
    const row = rowBlock({ id, db: d.id, ord: appendKey((db.prepare(HOT_QUERIES.dbLastOrd).get(d.id) || {}).m || null), title, cells, by: { c: who, u: who }, at: ctx.now().toISOString() });
    row.attrs.tpl = true;
    delete row.attrs.no;
    ops.push({ op: 'add', id, row });
  } else {
    const no = Number.isSafeInteger(d.attrs.nextNo) && d.attrs.nextNo >= 1 ? d.attrs.nextNo : 1;
    ops.push({ op: 'add', id, row: rowBlock({ id, db: d.id, ord: rowOrd(db, d.id, a.afterId), title, cells, by: { c: who, u: who }, no, at: ctx.now().toISOString() }) },
      { op: 'set', id: d.id, key: 'nextNo', value: no + 1, old: d.attrs.nextNo });
  }
  if (src) ops.push(...copyBodyOps(db, ctx, src.id, id));
  return { id, ops };
}
// tpl.add（a.id があれば tpl.dup: そのテンプレートの複製）→ { id }
function tplAdd(db, a, ctx) {
  const d = mustDb(db, a.db);
  if (isMinutesDb(d)) throw refuse('bad-args');   // 決めたこと 69（TQ13 の (a)）: 「議事録」にはテンプレートを作らない
  const src = a.id === undefined ? null : liveTpl(db, d, a.id);
  tplRoom(db, d);
  const { id, ops } = tplRowOps(db, a, ctx, d, src, true);
  return dbDone(db, d, ops, { id }, [id]);
}
function tplRemove(db, a, ctx) {
  const d = mustDb(db, a.db);
  liveTpl(db, d, a.id);
  const ops = [{ op: 'trash', id: a.id, at: ctx.now().toISOString(), old: null }];
  if (d.attrs.tplDefault === a.id) ops.push({ op: 'set', id: d.id, key: 'tplDefault', value: undefined, old: a.id });   // 既定のテンプレートを消すと既定が外れる
  const per = tplViewsOf(d);
  if (Object.values(per).includes(a.id)) {
    const next = Object.fromEntries(Object.entries(per).filter(([, v]) => v !== a.id));   // そのビューは「データベースの既定」に戻る
    ops.push({ op: 'set', id: d.id, key: 'tplViews', value: Object.keys(next).length ? next : undefined, old: d.attrs.tplViews });
  }
  return dbDone(db, d, ops, { removed: a.id }, [a.id]);
}
function tplSetDefault(db, a) {
  const d = mustDb(db, a.db);
  if (isMinutesDb(d)) throw refuse('bad-args');
  if (a.id !== '') liveTpl(db, d, a.id);
  const ops = [];
  if (a.view !== undefined) {   // 「このビューだけ」
    if (!viewOf(d, a.view)) throw refuse('bad-args');
    const next = { ...tplViewsOf(d), [a.view]: a.id };
    if (!isDeepStrictEqual(next, d.attrs.tplViews)) ops.push({ op: 'set', id: d.id, key: 'tplViews', value: next, old: d.attrs.tplViews });
  } else {   // 「すべてのビュー」: データベースの既定にして、ビューごとの既定を外す
    const val = a.id === '' ? undefined : a.id;
    if (d.attrs.tplDefault !== val) ops.push({ op: 'set', id: d.id, key: 'tplDefault', value: val, old: d.attrs.tplDefault });
    if (d.attrs.tplViews !== undefined) ops.push({ op: 'set', id: d.id, key: 'tplViews', value: undefined, old: d.attrs.tplViews });
  }
  const after = { ...d, attrs: { ...d.attrs, ...Object.fromEntries(ops.map((o) => [o.key, o.value])) } };
  return dbDone(db, d, ops, { tpls: tplInfo(db, after) });
}
function rowFromTpl(db, a, ctx) {
  const d = mustDb(db, a.db);
  if (isMinutesDb(d)) throw refuse('bad-args');
  const src = liveTpl(db, d, a.id);
  if (rowsFull(db, d)) throw refuse('too-big');
  const { id, ops } = tplRowOps(db, a, ctx, d, src, false);
  return dbDone(db, d, ops, { id }, [id]);
}

// ---- リレーションとサブアイテム（0.16.0 DR-1。決めたこと 33〜38・R98）
// サブアイテムの列（{ parent, kids }。どちらも生きている自分へのリレーションの列で、互いを指しているときだけ: R108）| null
function subOf(d) {
  const s = isObj(d.attrs.sub) ? d.attrs.sub : null;
  if (!s) return null;
  const p = colIn(d.cols, s.parent); const k = colIn(d.cols, s.kids);
  const live = (c, o) => c && !c.gone && c.type === 'rel' && c.db === d.id && c.back === o;
  return p && k && p !== k && live(p, k.id) && live(k, p.id) ? { parent: p.id, kids: k.id } : null;
}
// 生きている行の親（親アイテムの列の1つ目）の Map
function subParents(db, d, pcol) {
  const out = new Map();
  for (const r of db.prepare("select id, json_extract(attrs, '$.cells.\"' || ? || '\"') as p from blocks where type = 'row' and parent_id = ? and trashed_at is null").all(pcol, d.id)) {
    let p = null;
    try { const v = r.p ? JSON.parse(r.p) : null; p = Array.isArray(v) && typeof v[0] === 'string' ? v[0] : null; } catch (_) { p = null; }
    out.set(r.id, p);
  }
  return out;
}
// ids の行の子孫の生きている行（ids に無いもの。木の順）
function subKidsOf(db, d, ids) {
  const sub = subOf(d);
  if (!sub) return [];
  const kids = new Map();
  for (const [id, p] of subParents(db, d, sub.parent)) if (p && p !== id) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push(id); }
  const seen = new Set(ids);
  const out = [];
  const stack = [...ids];
  while (stack.length) {
    for (const k of kids.get(stack.pop()) || []) if (!seen.has(k)) { seen.add(k); out.push(k); stack.push(k); }
  }
  return out;
}
// リレーションの列の相手（つなぐ先のデータベース t と、値を写す相手の列 bcol）。両側なら対の列（相手の back がこの列のときだけ）、
// 自分のデータベースへの列1つ（back が無い）は自分の列（行どうしが互いを指す: R98 (2)）、ほかは null（片側）。soft: つなぐ先が無くても投げない
function relPeer(db, d, col, soft = false) {
  const t = col.db === d.id ? d : dbOf(db, col.db);
  if (!t) { if (soft) return null; throw refuse('bad-args'); }
  if (col.back !== undefined) {
    const b = colIn(t.cols, col.back);
    return { t, bcol: b && !b.gone && b.type === 'rel' && b.db === d.id && b.back === col.id ? b : null };
  }
  return { t, bcol: t === d ? col : null };
}
// リレーションの行を足す・外す（rel.link・rel.unlink）。両側・自分への列1つは相手の行のセルも同じ命令で書く（決めたこと 33・R98 (2)）。
// title（足すときだけ）: つなぐ先に新しい行を作ってつなぐ（［新しい行を作ってつなぐ］・［サブアイテムを足す］）。
// サブアイテムの列は、親は1つ・輪にしない（決めたこと 37）。セルは 100 まで（相手のセルも）→ { cell, added? }
function relEdit(db, a, ctx, add) {
  const d = mustDb(db, a.db);
  const col = liveCol(d, a.col);
  if (col.type !== 'rel' || (!add && a.title !== undefined)) throw refuse('bad-args');
  const { t, bcol } = relPeer(db, d, col);
  const staged = new Map();
  const stage = (dd, id) => {
    if (!staged.has(id)) { const r = liveRow(db, dd, id); staged.set(id, { r, cells: { ...r.cells }, mine: dd === d }); }
    return staged.get(id);
  };
  const putId = (e, colId, id) => {
    const was = Array.isArray(e.cells[colId]) ? e.cells[colId] : [];
    const next = add ? (was.includes(id) ? was : [...was, id]) : was.filter((x) => x !== id);
    if (next.length) e.cells[colId] = next; else delete e.cells[colId];
  };
  const me = stage(d, a.id);
  const ops = [];
  for (const id of [...new Set(a.ids)]) {
    const o = stage(t, id);
    putId(me, col.id, id);
    if (bcol) putId(o, bcol.id, a.id);
  }
  // 0.17.0 点検 3（rv60 重要 3・R70。F202）: テンプレートの行へはつながない。テンプレートは両側のリレーション（自分への列1つも）の値を持たない
  //（相手の行のセルにテンプレートが入り、相手の表と Claude の答えに出る）。片側の列はテンプレートでも書ける。外すのは今どおり
  if (add && [...staged.values()].some((e) => e.r.attrs.tpl === true && (e !== me || bcol))) throw refuse('bad-args');
  let added = null;
  if (add && a.title !== undefined) {
    if (isMinutesDb(t)) throw refuse('bad-args');   // 0.17.0 TK-1（rv59 軽い 6・決めたこと 52・53）: 「議事録」にふつうの行を作らない
    if (db.prepare(HOT_QUERIES.dbRowCount).get(t.id).c >= LIMITS.dbRows) throw refuse('too-big');
    added = newRowId(db, ctx.now);
    const no = Number.isSafeInteger(t.attrs.nextNo) && t.attrs.nextNo > 0 ? t.attrs.nextNo : 1;
    const who = whoOf(ctx);
    const cells = bcol ? { [bcol.id]: [a.id] } : {};
    ops.push({ op: 'add', id: added, row: rowBlock({ id: added, db: t.id, ord: rowOrd(db, t.id), title: a.title, cells, by: { c: who, u: who }, no, at: ctx.now().toISOString() }) },
      { op: 'set', id: t.id, key: 'nextNo', value: no + 1, old: t.attrs.nextNo });
    if (a.id === added) throw refuse('bad-args');
    putId(me, col.id, added);
  }
  // サブアイテム: 親は1つ・輪にしない（行の親の木を歩く: 0.15.0 の canMoveUnder と同じ考え）
  const sub = t === d ? subOf(d) : null;
  if (sub && bcol && (col.id === sub.parent || col.id === sub.kids)) {
    const par = subParents(db, d, sub.parent);
    for (const [id, e] of staged) {
      const v = Array.isArray(e.cells[sub.parent]) ? e.cells[sub.parent] : [];
      if (v.length > 1) throw refuse('bad-args');
      par.set(id, v.length ? v[0] : null);
    }
    // 新しい行の親: サブアイテムの列なら a（新しい行は a の子）。親アイテムの列なら無し（新しい行が a の親になる: rv51 I1・R106）
    if (added) par.set(added, col.id === sub.kids ? a.id : null);
    for (const id of staged.keys()) {
      let p = par.get(id);
      for (let k = 0; p && k <= par.size; k += 1) { if (p === id) throw refuse('bad-args'); p = par.get(p); }
    }
  }
  // セルを照らし（100 まで・重なり無し）、変わった行ごとにセルの set と行を書いた印
  const changed = [];
  for (const [id, e] of staged) {
    const one = [];
    // この行の列（自分のデータベースの行は col と、自分への列なら対の列・相手のデータベースの行は対の列だけ）
    const mineCols = e.mine ? (bcol && t === d && bcol !== col ? [col, bcol] : [col]) : (bcol ? [bcol] : []);
    for (const c of mineCols) {
      const next = Object.hasOwn(e.cells, c.id) ? e.cells[c.id] : null;
      if (next !== null) { try { DM.cellOf(c, next); } catch (_) { throw refuse('bad-args'); } }
      one.push(...cellOps(e.r, c, next));
    }
    if (!one.length) continue;
    ops.push(...one, ...touchOps(e.r, ctx));
    changed.push(id);
  }
  if (!changed.length && !added) return { ops: [], pageIds: [], result: { cell: me.cells[col.id] || [] } };
  applyOps(db, ops);
  return { ops, pageIds: [d.id, ...(t === d ? [] : [t.id]), ...changed, ...(added ? [added] : [])], result: { cell: me.cells[col.id] || [], ...(added ? { added } : {}) } };
}
// サブアイテムを入れる・外す（決めたこと 37: 入れると同じデータベースへの両側のリレーションの列「親アイテム」「サブアイテム」を足し、attrs.sub に2つの ID。
// 外すと attrs.sub だけ消して列は残す）→ { sub? }
function dbSetSub(db, a) {
  const d = mustDb(db, a.db);
  if (isMinutesDb(d)) throw refuse('bad-args');   // 0.17.0 MG-4（決めたこと 52）: 「議事録」はサブアイテムを使えない（ロックを外しても）
  const now = subOf(d);
  if (a.on && now) return { ops: [], pageIds: [], result: { sub: now } };
  if (!a.on) {
    if (!isObj(d.attrs.sub)) return { ops: [], pageIds: [], result: {} };
    return dbDone(db, d, [{ op: 'set', id: d.id, key: 'sub', value: undefined, old: d.attrs.sub }], {});
  }
  if (d.cols.length + 2 > LIMITS.dbCols) throw refuse('bad-args');
  const p = { ...DM.newCol('rel', '親アイテム', d.cols), db: d.id };
  const k = { ...DM.newCol('rel', 'サブアイテム', [...d.cols, p]), db: d.id };
  const f = freshIds(d, [...d.cols, p, k]);
  const n = f.cols.length;
  const pid = f.cols[n - 2].id; const kid = f.cols[n - 1].id;
  const cols = [...f.cols.slice(0, -2), { ...f.cols[n - 2], back: kid }, { ...f.cols[n - 1], back: pid }];
  const sub = { parent: pid, kids: kid };
  return dbDone(db, d, [dbSet(d, 'cols', cols), ...f.ops.slice(1), { op: 'set', id: d.id, key: 'sub', value: sub, old: d.attrs.sub }], { sub });
}
// リレーションの相手の行の題名（生きている行で、データベースもゴミ箱でないものだけ: 決めたこと 34）→ { <行の ID>: { title, icon? } }
function relTitlesOf(db, ids) {
  const out = {};
  const live = new Map();
  for (const id of ids) {
    if (Object.hasOwn(out, id)) continue;
    const r = db.prepare(HOT_QUERIES.dbRow).get(id);
    if (!r || (r.type !== 'row' && r.type !== 'page') || r.trashed_at !== null) continue;
    if (!live.has(r.parent_id)) { const p = dbOf(db, r.parent_id); live.set(r.parent_id, p ? (isMinutesDb(p) ? 'minutes' : 'db') : ''); }
    if (!live.get(r.parent_id)) continue;
    if (r.type === 'page' && (live.get(r.parent_id) !== 'minutes' || !isMeetingRaw(JSON.parse(r.attrs || '{}')))) continue;   // 0.17.0 MG-1: 「議事録」の議事録だけ
    const one = { title: r.text || '' };
    const attrs = JSON.parse(r.attrs || '{}');
    if (typeof attrs.icon === 'string' && attrs.icon) one.icon = attrs.icon;
    out[id] = one;
  }
  return out;
}
// 行のセルのうち、生きているリレーションの列の行の ID
function relIdsIn(cols, cells, only) {
  const out = [];
  for (const c of cols) if (c.type === 'rel' && !c.gone && (!only || only.has(c.id)) && Array.isArray(cells[c.id])) out.push(...cells[c.id]);
  return out;
}
// つなぐ先のデータベースの行を探す（選びの窓: 題名で・ひらがなとカタカナを寄せる・並びの鍵の順に 200 まで）→ { rows: [{ id, title, icon? }], total }
const kanaFold = (s) => searchFold(s).replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));   // カタカナをひらがなに（src/emojiDict.js と同じ寄せ方）
function relFind(db, a) {
  const t = mustDb(db, a.db);
  const q = a.q ? kanaFold(a.q) : '';
  const all = dbRowsOf(db, t).sort((x, y) => cmpStr(x.ord, y.ord) || cmpStr(x.id, y.id));
  const hits = q ? all.filter((r) => kanaFold(r.text || '').includes(q)) : all;
  const rows = hits.slice(0, DB_VIEW_MAX).map((r) => {
    const one = { id: r.id, title: r.text || '' };
    const attrs = JSON.parse(r.attrs || '{}');
    if (typeof attrs.icon === 'string' && attrs.icon) one.icon = attrs.icon;
    return one;
  });
  return { result: { rows, total: hits.length } };
}

// ---- 列（決めたこと 13・R32〜R34）
// 列を足す（名前が重なれば「名前 2」: dbModel.newCol。after は列の並びの置き場: '' は頭・無ければ末尾。列は消した列も入れて 100 まで）→ { col }
// 0.16.0 DR-1（決めたこと 33）: リレーションの列は target（つなぐ先のデータベース。自分も）を必ず渡す。both なら相手のデータベースにも対の列を足し、
// 互いの back に相手の列の ID を書く（1つの命令）。対の列の名前は、このデータベースの題名（無題・使えない名前なら種類の名前）
function colAdd(db, a) {
  const d = mustDb(db, a.db);
  if ((a.type === 'rel') !== (a.target !== undefined) || (a.both !== undefined && a.type !== 'rel')) throw refuse('bad-args');
  const t = a.type !== 'rel' ? null : a.target === d.id ? d : mustDb(db, a.target);
  const self = t === d;
  if (d.cols.length + (a.both && self ? 2 : 1) > LIMITS.dbCols || (a.both && !self && t.cols.length >= LIMITS.dbCols)) throw refuse('bad-args');
  if (a.both && !self && isLockedDb(db, t.id)) throw refuse('bad-args');   // 0.17.0 点検 3（rv60 重要 1・R68）: ロック中の相手に対の列を足さない（決めたこと 74）
  let col;
  try { col = DM.newCol(a.type, a.name, d.cols); } catch (_) { throw refuse('bad-args'); }
  if (t) col = { ...col, db: t.id };
  const cols = [...d.cols];
  const i = a.after === undefined ? cols.length : a.after === '' ? 0 : cols.findIndex((c) => c.id === a.after) + 1;
  if (i < 0 || (a.after && i === 0)) throw refuse('bad-args');
  cols.splice(i, 0, col);
  if (!a.both) {
    const f = freshIds(d, cols);   // 列の ID は使い直さない（R56）
    return dbDone(db, d, f.ops, { col: f.cols[i] });
  }
  const peerName = (list) => { try { return DM.newCol('rel', self ? undefined : (d.title || '').trim() || undefined, list); } catch (_) { return DM.newCol('rel', undefined, list); } };
  if (self) {
    cols.push({ ...peerName(cols), db: d.id });
    const f = freshIds(d, cols);
    const a1 = f.cols[i]; const b1 = f.cols[f.cols.length - 1];
    const out = f.cols.map((c) => (c === a1 ? { ...c, back: b1.id } : c === b1 ? { ...c, back: a1.id } : c));
    return dbDone(db, d, [dbSet(d, 'cols', out), ...f.ops.slice(1)], { col: out[i], back: out[out.length - 1] });
  }
  const fa = freshIds(d, cols);
  const fb = freshIds(t, [...t.cols, { ...peerName(t.cols), db: d.id }]);
  const mine = { ...fa.cols[i], back: fb.cols[fb.cols.length - 1].id };
  const theirs = { ...fb.cols[fb.cols.length - 1], back: mine.id };
  const ops = [dbSet(d, 'cols', fa.cols.map((c, k) => (k === i ? mine : c))), ...fa.ops.slice(1), dbSet(t, 'cols', [...fb.cols.slice(0, -1), theirs]), ...fb.ops.slice(1)];
  return dbDone(db, d, ops, { col: mine, back: theirs }, [t.id]);
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
// 0.17.0 点検 2（rv59 重要 2・R44）: 「議事録」データベースでは子の議事録のページ（ゴミ箱も。録音中の写し・白紙のページ・データベースを除く）も、セルを持つ行
function cellRowsOf(db, id) {
  const out = db.prepare(HOT_QUERIES.dbAllRows).all(id);
  if (isMinutesDb(dbOf(db, id))) {
    for (const r of db.prepare(HOT_QUERIES.minutesKids).all(id)) { const a = parseOr(r.attrs); if (a && isMeetingRaw(a)) out.push({ id: r.id, attrs: r.attrs, trashed_at: r.trashed_at }); }
  }
  return out;
}
const allRows = (db, d) => cellRowsOf(db, d.id).map((r) => ({ id: r.id, cells: (JSON.parse(r.attrs || '{}').cells) || {}, trashed: r.trashed_at !== null }));
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
const MINUTES_FIXED = Object.freeze(['mdate', 'cby', 'msum']);
function colRemove(db, a) {
  const d = mustDb(db, a.db);
  const col = colIn(d.cols, a.col);
  if (!col || col.type === 'title') throw refuse('bad-args');   // 題名の列は消せない（J-18）
  if (isMinutesDb(d) && MINUTES_FIXED.includes(col.type)) throw refuse('bad-args');   // 0.17.0 MG-1（決めたこと 50・76）: 「議事録」の日付・作成者・要約は消せない
  if (col.gone) return { ops: [], pageIds: [], result: { col } };
  // 0.16.0 DR-1 直し2（MQ2・R108）: サブアイテムを入れている間は2つの列を消せない（外すのは db.setSub の off だけ）
  const sub = subOf(d);
  if (sub && (sub.parent === col.id || sub.kids === col.id)) throw refuse('bad-args');
  const next = { ...col, gone: true };
  const ops = [dbSet(d, 'cols', d.cols.map((c) => (c.id === col.id ? next : c)))];
  // 0.16.0 DR-1（決めたこと 36）: 両側のリレーションの片方を消すと、相手の列は片側のリレーションに戻る（相手の値は消さない。同じ命令で Ctrl+Z も一緒）
  const peer = col.type === 'rel' ? relPeer(db, d, col, true) : null;
  if (peer && peer.bcol && peer.bcol !== col) {
    if (peer.t !== d && isLockedDb(db, peer.t.id)) throw refuse('bad-args');   // 0.17.0 点検 3（rv60 重要 1・R68）: ロック中の相手の列（back）を書き換えない
    const t = peer.t === d ? { ...d, attrs: { ...d.attrs, cols: ops[0].value }, cols: ops[0].value } : peer.t;
    const lone = { ...peer.bcol };
    delete lone.back;
    const set = dbSet(t, 'cols', t.cols.map((c) => (c.id === lone.id ? lone : c)));
    if (peer.t === d) ops[0] = { ...set, old: d.attrs.cols }; else ops.push(set);
    return dbDone(db, d, ops, { col: next }, peer.t === d ? [] : [peer.t.id]);
  }
  return dbDone(db, d, ops, { col: next });
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
// 0.16.0 DL-1（決めたこと 40・R105）: linked（リンクドビューの行の ID）があれば、その行の attrs.views を書く（元のデータベースのビューは変えない）。
// 行の照らしと上限・最後の1つ・複製の決まりは元のビューと同じ（viewsOf の1か所）
function viewsSet(db, d, views, result) { return dbDone(db, d, [dbSet(d, 'views', views)], result); }
// 照らした写し（patch か新しいビューの、壊れた項目があれば bad-args: 画面の誤りを黙って直さない。前からある壊れた項目は直して残す）
function checkedView(d, v, keys) {
  const { view, repaired } = DV.normalizeView(v, d.cols);
  if (repaired.some((k) => keys.includes(k))) throw refuse('bad-args');
  return view;
}
// 置いたページ: 生きている（ゴミ箱でない）白紙のページ（録音中の写しでない）
function blankHost(db, id) {
  const r = db.prepare(HOT_QUERIES.pageRow).get(id);
  if (!r || r.type !== 'page' || (r.trashed_at !== null && r.trashed_at !== undefined)) return false;
  const attrs = JSON.parse(r.attrs || '{}');
  return isBlankPage(attrs) && !isLive(attrs);
}
// リンクドビューの行 → { id, pageId, raw（保存した値）, views }。行が無い・dbview でない・attrs.db が dbId でない・置いたページがゴミ箱か白紙のページでないなら bad-args
function linkedOf(db, dbId, linked) {
  const r = db.prepare(HOT_QUERIES.viewRow).get(linked);
  if (!r || r.type !== 'dbview' || (r.trashed_at !== null && r.trashed_at !== undefined)) throw refuse('bad-args');
  const attrs = JSON.parse(r.attrs || '{}');
  if (attrs.db !== dbId || !blankHost(db, r.page_id)) throw refuse('bad-args');
  return { id: r.id, pageId: r.page_id, raw: attrs.views, views: Array.isArray(attrs.views) ? attrs.views.filter(isObj) : [] };
}
// ビューの持ち主（元のデータベースか、リンクドビューの行）→ { d, L?, views, done(views, result) }
function viewsOf(db, a) {
  const d = mustDb(db, a.db);
  if (a.linked === undefined) return { d, views: d.views, done: (views, result) => viewsSet(db, d, views, result) };
  const L = linkedOf(db, d.id, a.linked);
  return { d, L, views: L.views, done: (views, result) => {
    if (Buffer.byteLength(JSON.stringify(views), 'utf8') > LIMITS.dbAttrs) throw refuse('too-big');
    const ops = [{ op: 'set', id: L.id, key: 'views', value: views, old: L.raw }];
    applyOps(db, ops);
    return { ops, pageIds: [L.pageId], result };
  } };
}
function viewAdd(db, a) {
  const h = viewsOf(db, a);
  const d = h.d;
  if (h.views.length >= LIMITS.dbViews) throw refuse('bad-args');
  // DV-3 直し（rv48 F11・R88）: ビューの ID は使い直さない（消したビューへの古いリンクがほかのビューを開かない）。今までに振った一番大きい数を attrs.seq.v に
  // （DL-1: リンクドビューのタブはリンクで選ばないので、行の中の一番大きい数の次: R113）
  const was0 = !h.L && isObj(d.attrs.seq) ? d.attrs.seq : {};
  let n = Number.isSafeInteger(was0.v) ? was0.v : 0;
  for (const x of h.views) { const m = /^v(\d{1,9})$/.exec(String(x.id)); if (m) n = Math.max(n, Number(m[1])); }
  n += 1;
  let v;
  if (a.from !== undefined) {
    const src = h.views.find((x) => x.id === a.from);
    if (!src || a.layout !== undefined) throw refuse('bad-args');
    v = { ...normView(d, src), id: `v${n}`, ...(a.name !== undefined ? { name: a.name } : {}) };
  } else v = DV.defaultView(`v${n}`, a.layout || 'table', d.cols, a.name);
  const view = checkedView(d, v, ['name', 'layout']);
  if (h.L) return h.done([...h.views, view], { view });
  return dbDone(db, d, [dbSet(d, 'views', [...d.views, view]), { op: 'set', id: d.id, key: 'seq', value: { ...was0, v: n }, old: d.attrs.seq }], { view });
}
function viewUpdate(db, a) {
  const h = viewsOf(db, a);
  const was = h.views.find((v) => v.id === a.viewId);
  if (!was) throw refuse('bad-args');
  const view = checkedView(h.d, { ...normView(h.d, was), ...a.patch, id: was.id }, Object.keys(a.patch));
  if (isDeepStrictEqual(view, was)) return { ops: [], pageIds: [], result: { view } };
  return h.done(h.views.map((v) => (v.id === was.id ? view : v)), { view });
}
function viewRemove(db, a) {
  const h = viewsOf(db, a);
  if (!h.views.some((v) => v.id === a.viewId) || h.views.length <= 1) throw refuse('bad-args');   // 最後の1つは消せない（V-T03）
  return h.done(h.views.filter((v) => v.id !== a.viewId), { removed: a.viewId });
}
function viewMove(db, a) {
  const h = viewsOf(db, a);
  const me = h.views.find((v) => v.id === a.viewId);
  if (!me) throw refuse('bad-args');
  const rest = h.views.filter((v) => v.id !== a.viewId);
  const i = a.after === '' ? 0 : rest.findIndex((v) => v.id === a.after) + 1;
  if (a.after === a.viewId) return { ops: [], pageIds: [], result: { view: me } };
  if (i === 0 && a.after !== '') throw refuse('bad-args');
  rest.splice(i, 0, me);
  if (isDeepStrictEqual(rest.map((v) => v.id), h.views.map((v) => v.id))) return { ops: [], pageIds: [], result: { view: me } };
  return h.done(rest, { view: me });
}
// 0.16.0 DL-1（R105）: データベースの題名（頭の題名の欄。データベースのページ・インライン・リンクドビューのどこからでも）。page.setTitle と同じく題名と
// 最終更新日時を書き、oplog の page_id はデータベース（元に戻すの歩み bookKey(<データベース>, 'db'): UNDO_CMDS。dbRevert が題名の text を戻す）→ ページ
function dbSetTitle(db, a, ctx) {
  const d = mustDb(db, a.db);
  if (d.title === a.title) return { ops: [], pageIds: [], result: readPage(db, d.id) };
  const r = db.prepare(HOT_QUERIES.pageRow).get(d.id);
  const ops = [{ op: 'text', id: d.id, value: a.title, old: d.title }, { op: 'set', id: d.id, key: 'updatedAt', value: ctx.now().toISOString(), old: r.updated_at }];
  applyOps(db, ops);
  return { ops, pageIds: [d.id], result: readPage(db, d.id) };
}
// 0.16.0 DL-1（決めたこと 40・R105）: /リンクドビュー で本文にリンクドビューの行を置く（1つの命令・本文の歩み: UNDO_CMDS）。from は写す元のビュー（設定の写しで
// ID は行の中の v1。後で元を変えても変わらない）、無ければ「表」のビュー。afterId は打った行（placeAt と同じ: 空のテキストの行なら替え、ほかはすぐ下・無ければ本文の最後）。
// 置けるのは生きている白紙のページで、元は生きているデータベースだけ。本文の表は 10 まで（too-big）→ { page, blockId }
function insertDbView(db, a, ctx) {
  const d = mustDb(db, a.db);
  if (!blankHost(db, a.pageId)) throw refuse('bad-args');
  let view;
  if (a.from !== undefined) {
    const src = viewOf(d, a.from);
    if (!src) throw refuse('bad-args');
    view = { ...normView(d, src), id: 'v1' };
  } else view = DV.defaultView('v1', 'table', d.cols);
  let blockId = newBlockId(db, ctx.now);
  const out = editPage(db, a.pageId, ctx, (p) => {
    tableRoom(p.blocks);
    const row = { id: blockId, type: 'dbview', text: '', db: d.id, views: [view] };
    const l = a.afterId ? BT.locate(p.blocks, a.afterId) : null;
    if (l && l.b.type === 'paragraph' && String(l.b.text || '') === '' && !(Array.isArray(l.b.children) && l.b.children.length)) { blockId = l.b.id; l.list[l.index] = { ...row, id: blockId }; }
    else if (l) l.list.splice(l.index + 1, 0, row);
    else p.blocks.push(row);
    pageFits(p, ctx);
  }, { summary: true });
  return { ...out, result: out.result ? { page: out.result, blockId } : null };
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
  // 0.17.0 LK-1（決めたこと 74）: ロック中は、列（両側のリレーションの相手も）の形を戻さない（ロックの前の列の歩みも。行とセルの歩みは戻す）
  if (back.some((o) => o.op === 'set' && o.key === 'cols' && isLockedDb(db, o.id))) throw refuse('stale');
  // 0.17.0 点検 3（rv60 軽い 5・R73）: ロック中は、テンプレートを作る歩み（tpl.add・tpl.dup のやり直し）も戻さない（決めたこと 69・74）
  if (isLockedDb(db, a.pageId) && back.some((o) => o.op === 'add' && isObj(o.row) && (isObj(o.row.attrs) ? o.row.attrs.tpl === true : tplAttrs(o.row.attrs)))) throw refuse('stale');
  // 戻すと消える行（足した行）に本文があれば戻さない（本文を親の無い行にしない）
  // 0.17.0 RT-1: 同じ歩みで足した本文（テンプレートから写した本文）は、同じ歩みで消えるので数えない
  const goneNow = new Set(back.filter((o) => o.op === 'trash' && isObj(o.old)).map((o) => o.id));
  const body = db.prepare('select id from blocks where page_id = ? and id <> ?');
  if (back.some((o) => o.op === 'trash' && isObj(o.old) && body.all(o.id, o.id).some((x) => !goneNow.has(x.id)))) throw refuse('stale');
  // 戻すと消える列（足した列の戻し）に値のある行があれば戻さない（ゴミ箱の行も。行に持ち主の無いセルを残さない: rv42 I2・R57）
  // 0.16.0 DR-1: 両側のリレーションの列は相手のデータベースの列も同じ歩み（o.id はそのデータベース）
  for (const o of back) {
    if (o.op !== 'set' || o.key !== 'cols' || !Array.isArray(o.value) || !Array.isArray(o.old)) continue;
    const keep = new Set(o.value.map((c) => c && c.id));
    const lost = o.old.map((c) => c && c.id).filter((id) => !keep.has(id));
    if (lost.length && cellRowsOf(db, o.id).some((r) => { const c = JSON.parse(r.attrs || '{}').cells; return isObj(c) && lost.some((id) => Object.hasOwn(c, id)); })) throw refuse('stale');
  }
  applyOps(db, back);
  // 戻すと消える選択肢（足した選択肢の戻し）を、戻した後も持つ行があれば戻さない（ゴミ箱の行も。行に持ち主の無い選択肢の ID を残さない: rv44 F5・R72）。
  // 同じ歩みで行のセルも戻る（貼り付けで足した選択肢と行）ので、当てた後に見る（断れば命令ごと戻る）
  const lostOpts = [];
  for (const o of back) {
    if (o.op !== 'set' || o.key !== 'cols' || !Array.isArray(o.value) || !Array.isArray(o.old)) continue;
    const after = new Map(o.value.filter(isObj).map((c) => [c.id, c]));
    for (const c of o.old) {
      const n = isObj(c) ? after.get(c.id) : null;
      if (!n || !Array.isArray(c.opts)) continue;
      const keep = new Set((Array.isArray(n.opts) ? n.opts : []).map((x) => x && x.id));
      for (const x of c.opts) if (x && !keep.has(x.id)) lostOpts.push([c.id, x.id]);
    }
  }
  if (lostOpts.length && cellRowsOf(db, a.pageId).some((r) => {
    const c = JSON.parse(r.attrs || '{}').cells;
    return isObj(c) && lostOpts.some(([col, id]) => c[col] === id || (Array.isArray(c[col]) && c[col].includes(id)));
  })) throw refuse('stale');
  // 行を戻す・やり直すでも、1つのデータベースの行は 10,000 まで（rv42 M1・R58。越えれば何も変えない。DR-1: ［新しい行を作ってつなぐ］の相手のデータベースも）
  const grown = new Set(back.filter((o) => o.op === 'restore' || o.op === 'add').map((o) => (o.op === 'add' && isObj(o.row) ? o.row.parent_id : a.pageId)));
  for (const id of grown) if (db.prepare(HOT_QUERIES.dbRowCount).get(id).c > LIMITS.dbRows) throw refuse('too-big');
  const touched = [...new Set(back.filter((o) => o.op === 'text' || (o.op === 'set' && o.key.startsWith('cell:'))).map((o) => o.id))];
  const meta = [];
  for (const id of touched) {
    const r = db.prepare(HOT_QUERIES.dbRow).get(id);
    if (r && r.type === 'row') meta.push(...touchOps({ id, raw: r, attrs: JSON.parse(r.attrs || '{}') }, ctx));
  }
  applyOps(db, meta);
  // DR-1 直し（rv51 M2・R106）: 知らせには、相手のデータベース（両側の列の set・［新しい行を作ってつなぐ］で足した行の add と戻しの trash の相手）も入れる
  const dbs = new Set([a.pageId]);
  for (const o of back) {
    if (o.op === 'set' && o.key === 'cols') dbs.add(o.id);
    const r = o.op === 'add' ? o.row : o.op === 'trash' ? o.old : null;
    if (isObj(r) && r.type === 'row' && typeof r.parent_id === 'string') dbs.add(r.parent_id);
  }
  return { ops: [...back, ...meta], pageIds: [...dbs, ...touched], result: { page: readPage(db, a.pageId) } };
}

// ---- 送り直しの答え（rv42 M3・R59: 1回目と同じ R29 の形を、今の中身と oplog の1行から作り直す。データベースが無ければ null）
const dupOps = (row) => { try { const l = JSON.parse(row.ops || '[]'); return Array.isArray(l) ? l : []; } catch (_) { return []; } };
const dupDb = (db, a) => dbOf(db, a.db);
const tplDupId = (row) => { const add = dupOps(row).find((o) => isObj(o) && o.op === 'add' && isObj(o.row) && o.row.type === 'row'); return add ? add.id : null; };   // 0.17.0 RT-1
// 0.16.0 DL-1: ビューの命令の今のビューの並び（linked ならその行の。行が無ければ null）
function dupViews(db, a) {
  const d = dupDb(db, a);
  if (!d) return null;
  if (a.linked === undefined) return d.views;
  try { return linkedOf(db, d.id, a.linked).views; } catch (_) { return null; }
}
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
  'col.add': (db, a, row) => {
    const d = dupDb(db, a); const id = dupNewId(row, 'cols'); const col = d && id ? colIn(d.cols, id) : null;
    if (!col) return null;
    if (!a.both) return { col };
    const t = col.db === d.id ? d : dbOf(db, col.db);   // DR-1: 両側なら対の列も（1回目と同じ形）
    const back = t ? colIn(t.cols, col.back) : null;
    return back ? { col, back } : null;
  },
  'col.setType': (db, a, row) => {
    const got = dupCol(db, a);
    return got ? { ...got, emptied: dupOps(row).filter((o) => o && o.op === 'set' && o.key === `cell:${a.col}` && (o.value === undefined || o.value === null)).length } : null;
  },
  'col.purge': (db, a) => ({ purged: a.col }),
  'view.add': (db, a, row) => { const vs = dupViews(db, a); const id = dupNewId(row, 'views'); const v = vs && id ? vs.find((x) => x.id === id) : null; return v ? { view: v } : null; },
  'view.one': (db, a) => { const vs = dupViews(db, a); const v = vs ? vs.find((x) => x.id === a.viewId) : null; return v ? { view: v } : null; },
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
// ---------------------------------------------------------------- Claude の変更の控えと戻す（0.18.0 CW-1。計画 docs/plans/2026-11-18-180.md の
// 決めたこと 10〜14・F233・F234）
// withSnap(db, pageId, what, fn, ctx, { segIds }): Claude の命令の本体 fn を、書く直前のページの控え（page_snapshot の1行）と同じトランザクションで包む。
// 控えを足す → fn → 書いた後の rev を rev_after に → ページごとに新しい SNAP_KEEP 行に詰める。fn が投げれば core.call が控えごと戻す。
// 控えは oplog の操作にしない（決めたこと 13）。無い・ゴミ箱のページは not-found（呼び手が先に照らす）
function withSnap(db, pageId, what, fn, ctx, { segIds = [] } = {}) {
  const l = loadPage(db, pageId);
  if (!l) throw refuse('not-found');
  const row = (db.prepare(HOT_QUERIES.typeOf).get(pageId) || {}).type === 'row';
  const body = JSON.stringify(CS.snapOf(l.page, readSegments(db, pageId), { segIds, row }));
  const putSnap = () => db.prepare(HOT_QUERIES.snapAdd).run(pageId, ctx.now().toISOString(), what, l.page.rev, body).lastInsertRowid;
  const sid = putSnap();
  const out = fn();
  // 点検 1（CR46）: 何も変えなかった（操作が空の）書き込みは控えを残さない（新しい 10 行の控えを押し出さない・戻しても何も変わらない控えを並べない）
  if (!isObj(out) || !Array.isArray(out.ops) || out.ops.length === 0) { db.prepare(HOT_QUERIES.snapDel).run(sid); return out; }
  const after = db.prepare(HOT_QUERIES.pageRow).get(pageId);
  db.prepare(HOT_QUERIES.snapRevAfter).run(after ? after.rev : l.page.rev, sid);
  db.prepare(HOT_QUERIES.snapTrim).run(pageId, pageId, CS.SNAP_KEEP);
  return out;
}

// page.claudeSnaps（役 app・読む）: ページの控えの一覧（新しい順・SNAP_KEEP まで）。later は今のページの rev が書いた後と違う（その後に誰かが書いた）。
// 無い・ゴミ箱のページは []
function claudeSnaps(db, a) {
  const l = loadPage(db, a.id);
  if (!l) return { result: [] };
  return { result: db.prepare(HOT_QUERIES.snapList).all(a.id, CS.SNAP_KEEP).map((r) => ({ sid: r.rid, at: r.at, what: r.what, later: r.rev_after !== l.page.rev })) };
}

// page.claudeRevert（役 app）: 控え sid の形にページを戻す（利用者の新しい書き込み: actor me・1つの命令）。控えにある欄だけを diffPage・diffSegments の差で
// 書き、戻した控えとそれより新しい控えを消す（CR11）。断る（bad-args）: 無い・ゴミ箱のページ・録音中の写し・ゴミ箱のデータベースの行・そのページに無い控え
function claudeRevert(db, a, ctx) {
  const me = db.prepare(HOT_QUERIES.dbRow).get(a.id);
  const w = me ? forWrite(db, a.id) : null;
  if (!w || isLive(w.was.page)) throw refuse('bad-args');
  const host = me.parent_id ? dbOf(db, me.parent_id) : null;
  if (me.type === 'row' && !host) throw refuse('bad-args');   // データベースのゴミ箱の行
  const snap = db.prepare(HOT_QUERIES.snapOne).get(a.sid, a.id);
  if (!snap) throw refuse('bad-args');
  const segs = readSegments(db, a.id);
  const body = JSON.parse(snap.body);
  // 後の控えが直した発言も、戻す時点の文に（CR36）。議事録の控えだけが segs を持つ
  if (Array.isArray(body.segs)) body.segs = CS.segsFrom(db.prepare(HOT_QUERIES.snapFrom).all(a.id, snap.rid).map((r) => JSON.parse(r.body)));
  const back = CS.restoreOf(w.page, segs, body, host ? host.cols : null);
  if (me.type === 'row') back.page.by = { ...(isObj(w.page.by) ? w.page.by : {}), u: whoOf(ctx) };   // 行の最終更新者
  R.markShortBlocks(back.page.blocks);
  pageFits(back.page, ctx);   // 点検 1（CR47）: ほかの本文の書き込みと同じ上限（行の数・ページの大きさ）。越えれば too-big で何も変えない
  const ops = [...saveOps(w.was, back.page, ctx.now), ...diffSegments(segs, back.segments, a.id)];
  applyOps(db, ops);
  db.prepare(HOT_QUERIES.snapDropFrom).run(a.id, snap.rid);
  return { ops, pageIds: [a.id], result: readPage(db, a.id) };
}

// ---------------------------------------------------------------- Claude の要約の書き戻し（0.18.0 CS-2。計画 docs/plans/2026-11-18-180.md の
// 決めたこと 17〜22・F235・F236）
// mcp.writeSummary（役 mcp）: Claude が書いた Markdown を、main の［要約を生成］と同じ作り方（prepareSummary: 写しを落とす・印・担当と期限の裏付け・
// 出典は今の文字起こしと照らして付け直す）で要約の行にし、書く直前の形を控えに取って（withSnap）要約の行を作り直す。
// 断る: 無い・ゴミ箱・録音中の写し（listedRows の外）は not-found、白紙のページ・データベース・データベースの行は bad-args（要約が無い）、
// main が要約を作っている間（ctx.making）と要約の欄の鍵（要約待ちなど: summaryLockedPage）は locked、読んだ版（baseRev）が今と違えば conflict、
// 本文が上限（行の数・ページの大きさ）を越えれば too-big。採点の節があり文字起こしが短くなければ Claude Code の要約と同じに点を読み、無ければ前の点を消す
function claudeSummaryAnswer(p, edited) {
  const st = R.citeStatOf(p.blocks || []);
  const notes = typeof p.summaryError === 'string' && p.summaryError ? p.summaryError.split('\n') : [];
  return { title: p.title, rows: BT.flattenBlocks(p.blocks || []).length, cited: st.linked, citable: st.total, edited, notes };
}
function mcpWriteSummary(db, a, ctx) {
  const raw = db.prepare(HOT_QUERIES.dbRow).get(a.pageId);
  if (!raw || (raw.trashed_at !== null && raw.trashed_at !== undefined)) throw refuse('not-found');
  if (raw.type === 'row') throw refuse('bad-args');   // データベースの行のページ（要約が無い。append_to_page で書き足す: CT-2）
  if (!listedRows(db).some((r) => r.id === a.pageId)) throw refuse('not-found');   // 録音中の写し・ゴミ箱の行の中のページ
  const l = loadPage(db, a.pageId);
  if (!l) throw refuse('not-found');
  if (isBlankPage(l.page) || isDbPage(l.page)) throw refuse('bad-args');
  if (ctx.making.has(a.pageId)) throw refuse('locked');   // main が要約を作っている間（作り終えた要約が Claude の要約を黙って上書きしない）
  if (summaryLockedPage(db, l.page)) throw refuse('locked');   // 要約待ちなど（D69。待っている要約で Claude の要約を追い越さない: CR14）
  if (l.page.rev !== a.baseRev) throw refuse('conflict');
  return withSnap(db, a.pageId, 'summary', () => {
    const w = forWrite(db, a.pageId);
    const p = w.page;
    const edited = p.summaryEdited === true;
    if (a.meetingType !== undefined) setTypePage(p, { type: a.meetingType, preset: false }, ctx.now());   // 手で選んだのと同じ（決めたこと 20）
    const segs = readSegments(db, a.pageId);
    const rows = TL.timelineOf(segs.filter((x) => !x.failed && !x.pending));
    const plain = rows.map((r) => r.text).join('\n');
    const asked = quality.splitScore(a.md).found > 0;
    const score = asked && plain.length >= quality.MIN_SCORE_CHARS;
    const template = memoTypes.buildTemplate({ meetingType: p.meetingType, score, labeled: rows.some((r) => TL.srcLabel(r)) });
    const made = SW.prepareSummary({ md: a.md, page: p, segments: segs, segmentsAtStart: segs, score, template, at: ctx.now().toISOString() });
    p.blocks = made.blocks;
    keepTaskMarks(w.was.page, p);   // 作り直した同じ文の ToDo に［タスクにする］の印を引き継ぐ（page.put と同じ: 0.17.0 R67）
    p.citeStat = made.citeStat;
    p.actionStat = made.actionStat;
    if (made.quality) p.quality = made.quality; else delete p.quality;   // 点は要約と組（古い要約の点を残さない: 決めたこと 22）
    p.summaryError = [made.scoreNote || (asked && !score ? SW.QUALITY_NOTE_SHORT : '')].filter(Boolean).join('\n');
    p.summaryEdited = true;   // ［要約を再生成］で Claude の要約を消す前に、0.13.0 の確かめが出る（決めたこと 19）
    p.route = { ...(isObj(p.route) ? p.route : {}), summary: { by: 'claude', at: ctx.now().toISOString() } };
    pageFits(p, ctx);
    const ops = saveOps(w.was, p, ctx.now);
    applyOps(db, ops);
    return { ops, pageIds: [a.pageId], what: 'summary', result: claudeSummaryAnswer(readPage(db, a.pageId), edited) };
  }, ctx);
}
// 送り直し（同じ tx）の答え: 今の中身から作り直す。手で直した要約だったかは、1回目が summaryEdited を書いたか（書いていなければ前から真）で読む
function writeSummaryDup(db, a, row) {
  const p = readPage(db, a.pageId);
  if (!p) return null;
  const ops = JSON.parse(row.ops || '[]');
  return claudeSummaryAnswer(p, !ops.some((o) => o && o.op === 'set' && o.key === 'summaryEdited'));
}

// ---------------------------------------------------------------- Claude の名前の直し（0.18.0 CS-3。計画 docs/plans/2026-11-18-180.md の
// 決めたこと 23〜26・F237。第14回 F2 の MCP の形）
// mcp.fixNames（役 mcp）: 1つのページの要約の行（白紙のページと行のページは本文の行）・メモの行・文字起こしの発言・ToDo の担当・「議事録」の「参加者」を、
// 1つの命令（oplog の1行・控えは1つ。控えの segs は直した発言だけ）で直す（nameFix.fixNames）。題名とタスク（「タスク管理」の行）の担当は直さず数を返す。
// 直した発言を指す行は segment.update の recite と同じ refreshCitations で、文を直した行は今の文字起こしで、出典を照らし直す。
// 当たりが無ければ何も書かない（操作の空の行だけ。rev・更新の時刻・控えは変わらない: 決めたこと 56）。
// 断る: 無い・ゴミ箱・録音中の写し（listedRows の外）・ゴミ箱のデータベースの行・テンプレートの行は not-found、データベースのページは bad-args
// その ToDo から作ったタスクの「担当」の名前（生きている行だけ。数えるだけ: CR15）
function taskNamesOf(db, blocks) {
  const out = [];
  for (const b of BT.flattenBlocks(Array.isArray(blocks) ? blocks : [])) {
    if (!isObj(b) || b.type !== 'todo' || typeof b.task !== 'string' || !b.task) continue;
    const r = db.prepare(HOT_QUERIES.dbRow).get(b.task);
    if (!r || r.type !== 'row' || (r.trashed_at !== null && r.trashed_at !== undefined)) continue;
    const d = dbOf(db, r.parent_id);
    const who = d ? colByName(d, '担当', 'person') : null;
    const v = who ? ((parseOr(r.attrs) || {}).cells || {})[who.id] : null;
    if (Array.isArray(v)) out.push(...v.filter((x) => typeof x === 'string'));
  }
  return out;
}
function mcpFixNames(db, a, ctx) {
  const raw = db.prepare(HOT_QUERIES.dbRow).get(a.pageId);
  if (!raw || (raw.trashed_at !== null && raw.trashed_at !== undefined)) throw refuse('not-found');
  const row = raw.type === 'row';
  if (row && (!raw.parent_id || !dbOf(db, raw.parent_id) || isTplRaw(raw))) throw refuse('not-found');
  if (!row && !listedRows(db).some((r) => r.id === a.pageId)) throw refuse('not-found');   // 録音中の写し・ゴミ箱の行の中のページ
  const w = forWrite(db, a.pageId);
  if (!w) throw refuse('not-found');
  if (isDbPage(w.page)) throw refuse('bad-args');
  const meeting = !row && !isBlankPage(w.page);
  const segs = meeting ? readSegments(db, a.pageId) : [];
  let people = [];
  const host = meeting && raw.parent_id ? dbOf(db, raw.parent_id) : null;
  if (isMinutesDb(host)) people = host.cols.filter((c) => !c.gone && c.type === 'person').map((c) => c.id);   // 「議事録」の「参加者」
  const f = NF.fixNames(w.page, segs, a.pairs, { tasks: taskNamesOf(db, w.page.blocks), people });
  const result = { title: w.page.title, counts: f.counts };
  const c = f.counts;
  if (!(c.summary + c.memo + c.transcript + c.assignee + c.people)) return { ops: [], pageIds: [], result };   // 当たりが無い: 書かない
  return withSnap(db, a.pageId, 'names', () => {
    const p = f.page;
    if (meeting && p.blocks.length) {
      const flat = BT.flattenBlocks(p.blocks);
      const fresh = f.segments.filter((x) => !x.failed);
      for (const segId of f.segIds) refreshCitations(flat, fresh, segId);   // 直した発言を指す行（segment.update の recite と同じ）
      const touched = flat.filter((b) => f.changedBlocks.has(b.id));
      if (touched.length) attachCitations(touched, fresh);   // 文を直した要約の行も、今の文字起こしで照らし直す
    }
    if (row) p.by = { ...(isObj(p.by) ? p.by : {}), u: whoOf(ctx) };   // 行の最終更新者（Claude）
    pageFits(p, ctx);
    const ops = [...saveOps(w.was, p, ctx.now), ...diffSegments(segs, f.segments, a.pageId)];
    applyOps(db, ops);
    return { ops, pageIds: [a.pageId], what: 'names', result };
  }, ctx, { segIds: f.segIds });
}

// ---------------------------------------------------------------- Claude の ToDo とタスク（0.18.0 CT-1。計画 docs/plans/2026-11-18-180.md の
// 決めたこと 27〜29・F238・D148・D149）
// Claude の命令が書けるページ（議事録・白紙のページ・データベースの行のページ）を読む。無い・ゴミ箱・録音中の写し（listedRows の外）・
// ゴミ箱のデータベースの行・テンプレートの行は not-found → { row（データベースの行か）, w（forWrite） }
function mcpPageOf(db, id) {
  const raw = db.prepare(HOT_QUERIES.dbRow).get(id);
  if (!raw || (raw.trashed_at !== null && raw.trashed_at !== undefined)) throw refuse('not-found');
  const row = raw.type === 'row';
  if (row && (!raw.parent_id || !dbOf(db, raw.parent_id) || isTplRaw(raw))) throw refuse('not-found');
  if (!row && !listedRows(db).some((r) => r.id === id)) throw refuse('not-found');   // 録音中の写し・ゴミ箱の行の中のページ
  const w = forWrite(db, id);
  if (!w) throw refuse('not-found');
  return { row, w };
}
// ToDo の印の指す生きているタスクの行の ID（行もデータベースも生きている: todo.toTask と同じ見方）| null
function liveTaskOf(db, b) {
  if (typeof b.task !== 'string' || !b.task) return null;
  const r = db.prepare(HOT_QUERIES.dbRow).get(b.task);
  return r && r.type === 'row' && r.trashed_at === null && dbOf(db, r.parent_id) ? r.id : null;
}
// mcp.updateAction（役 mcp）: ToDo の行の済み・担当・期限（どれか1つ以上）を、block.setAction と同じ照らしと読み（parseDue）で書く。空の担当と期限は断る
// （消す道具にしない）。その ToDo から作ったタスクのステータスは変えない（D149。答えにタスクの ID）。同じ値なら書かない（操作の空の行だけ）。
// 断る: mcpPageOf の not-found・データベースのページと ToDo でない行（無い行も）は bad-args・main が要約を作っている間と要約の欄の鍵（要約待ちなど）は locked
function mcpUpdateAction(db, a, ctx) {
  const assignee = typeof a.assignee === 'string' ? a.assignee.trim() : undefined;
  const dueRaw = typeof a.dueRaw === 'string' ? a.dueRaw.trim() : undefined;
  if (a.done === undefined && assignee === undefined && dueRaw === undefined) throw refuse('bad-args');
  if (assignee === '' || dueRaw === '') throw refuse('bad-args');   // 担当と期限を空にしない（決めたこと 27）
  const { row, w } = mcpPageOf(db, a.pageId);
  if (isDbPage(w.page)) throw refuse('bad-args');
  if (ctx.making.has(a.pageId) || summaryLockedPage(db, w.was.page)) throw refuse('locked');   // 要約の欄の鍵（main が作っている間・要約待ち）
  const hit = BT.locate(w.page.blocks, a.blockId);
  if (!hit || hit.b.type !== 'todo') throw refuse('bad-args');
  const b = hit.b;
  const before = JSON.stringify(b);
  if (a.done !== undefined) b.checked = a.done;
  if (assignee !== undefined) b.assignee = assignee;
  if (dueRaw !== undefined) {
    b.dueRaw = dueRaw;
    const r = parseDue(dueRaw, new Date(w.page.createdAt));
    b.due = r.date; b.dueApprox = r.approx;
  }
  const task = liveTaskOf(db, b);
  const result = { title: w.page.title, ...(task ? { task } : {}) };
  if (JSON.stringify(b) === before) return { ops: [], pageIds: [], result };   // 同じ値: 書かない（rev・更新の時刻・控えは変わらない: 決めたこと 56）
  return withSnap(db, a.pageId, 'action', () => {
    w.page.summaryEdited = true;   // 要約の欄の手直しと同じ（block.setAction の summary: true）
    if (row) w.page.by = { ...(isObj(w.page.by) ? w.page.by : {}), u: whoOf(ctx) };   // 行の最終更新者（Claude）
    const ops = saveOps(w.was, w.page, ctx.now);
    applyOps(db, ops);
    return { ops, pageIds: [a.pageId], what: 'action', result };
  }, ctx);
}
function actionDup(db, a) {
  const p = readPage(db, a.pageId);
  const h = p ? BT.locate(p.blocks, a.blockId) : null;
  const task = h ? liveTaskOf(db, h.b) : null;
  return p ? { title: p.title, ...(task ? { task } : {}) } : null;
}
// mcp.makeTask（役 mcp）: ［タスクにする］（todo.toTask）と同じ部品で「タスク管理」の行を作り（無ければ「タスク管理」も）、ToDo に印を付ける。作成者は
// Claude（actor）。もうタスクがあれば何もせずその行の ID（made 偽）。控えは ToDo のページの1行（戻すのは印だけ: CR13）。
// 断る: mcpPageOf の not-found・main が要約を作っている間は locked・ほかは todo.toTask と同じ（ToDo でない行は bad-args・要約の欄の鍵は locked）
function mcpMakeTask(db, a, ctx) {
  const { w } = mcpPageOf(db, a.pageId);
  if (ctx.making.has(w.page.id)) throw refuse('locked');   // main が要約を作っている間（todo.toTask が見るのは DB の要約の欄の鍵だけ）
  return withSnap(db, a.pageId, 'task', () => {
    const out = todoToTask(db, a, ctx);
    return { ...out, what: 'task', result: { ...out.result, made: out.ops.length > 0 } };
  }, ctx);
}

// ---------------------------------------------------------------- Claude の白紙のページと書き足し（0.18.0 CT-2。計画 docs/plans/2026-11-18-180.md の
// 決めたこと 30〜33・F239・F243）
// Markdown → 本文の行（markdownToBlocks の見出し・箇条書き・ToDo・段落。新しい ID・人の行・出典なし: 貼り付けの pasteRows と同じ形。子ページの行は作れない）
function mdRows(db, ctx, md) {
  const used = new Set();
  return markdownToBlocks(md).map((b) => {
    const out = { id: freshId(db, ctx, used), type: b.type, text: b.text, cites: [], citeState: 'manual' };
    if (b.type === 'heading') out.level = b.level;
    if (b.type === 'todo') out.checked = b.checked === true;
    return out;
  });
}
// mcp.createPage（役 mcp）: 0.15.0 の page.create と同じ部品（pageCreate）で白紙のページを作り、同じ命令で題名と本文の行を書く（oplog の1行・控えは無い: CR6）。
// 親は白紙のページか無し（最上位）。白紙の親なら、その本文の最後に子ページの行（pageCreate のまま）。データベース・データベースの行・議事録・「議事録」の中は
// bad-args（CR17）。録音中の写し・ゴミ箱（祖先も）・無い親は pageCreate が bad-args で断る。本文は 2,000 行まで（too-big）
function mcpCreatePage(db, a, ctx) {
  if (a.parentId !== undefined) {
    const host = db.prepare(HOT_QUERIES.pageRow).get(a.parentId);
    if (!host || host.type !== 'page' || !isBlankPage(parseOr(host.attrs))) throw refuse('bad-args');   // 白紙のページの中だけ（決めたこと 30）
  }
  const rows = mdRows(db, ctx, a.md);
  if (rows.length > LIMITS.blocks) throw refuse('too-big');
  const made = pageCreate(db, { parentId: a.parentId }, ctx);
  const id = made.result.id;
  const w = forWrite(db, id);
  w.page.title = a.title;
  w.page.blocks = rows;
  pageFits(w.page, ctx);
  const ops = saveOps(w.was, w.page, ctx.now);
  applyOps(db, ops);
  return { ops: [...made.ops, ...ops], pageIds: made.pageIds, what: 'create', result: { id, title: a.title, rows: rows.length } };
}
function createPageDup(db, _a, row) {
  const ops = JSON.parse(row.ops || '[]');
  const add = ops.find((o) => o && o.op === 'add' && o.row && o.row.type === 'page');
  const p = add ? readPage(db, add.id) : null;
  return p ? { id: add.id, title: p.title, rows: ops.filter((o) => o && o.op === 'add' && o.row && o.row.page_id === add.id && o.id !== add.id).length } : null;
}
// mcp.appendPage（役 mcp）: 白紙のページとデータベースの行のページの本文の最上位の最後に、Markdown の行を足す（今ある行は1つも変えない・動かさない）。
// 議事録とデータベースのページは bad-args（AQ8 (a)）。ロック中のデータベースの行にも書ける（D152）。行の無い Markdown は書かない（操作の空の行だけ）。
// 本文が 2,000 行を越えるなら too-big。断る: mcpPageOf の not-found（テンプレートの行も）
function mcpAppendPage(db, a, ctx) {
  const { row, w } = mcpPageOf(db, a.pageId);
  if (!row && !isBlankPage(w.page)) throw refuse('bad-args');   // 白紙のページと行のページだけ（決めたこと 31）
  const rows = mdRows(db, ctx, a.md);
  const result = { title: w.page.title, rows: rows.length };
  if (!rows.length) return { ops: [], pageIds: [], result };
  if (BT.flattenBlocks(w.page.blocks).length + rows.length > LIMITS.blocks) throw refuse('too-big');
  return withSnap(db, a.pageId, 'append', () => {
    w.page.blocks.push(...rows);   // 最上位の最後（子の中には入れない）
    if (row) w.page.by = { ...(isObj(w.page.by) ? w.page.by : {}), u: whoOf(ctx) };   // 行の最終更新者（Claude）
    pageFits(w.page, ctx);
    const ops = saveOps(w.was, w.page, ctx.now);
    applyOps(db, ops);
    return { ops, pageIds: [a.pageId], what: 'append', result };
  }, ctx);
}
function appendPageDup(db, a, row) {
  const p = readPage(db, a.pageId);
  const ops = JSON.parse(row.ops || '[]');
  return p ? { title: p.title, rows: ops.filter((o) => o && o.op === 'add').length } : null;
}

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
      if (me && me.type === 'row') {
        // 0.16.0 DR-1（決めたこと 34）: 列の値の並びのリレーションの相手の題名（rel。生きている行だけ）
        const host = dbOf(db, me.parent_id);
        const cells = JSON.parse(me.attrs || '{}').cells;
        const rel = host && isObj(cells) ? relTitlesOf(db, relIdsIn(host.cols, cells)) : {};
        return { result: { page: forView(page, ctx.labels), segments: readSegments(db, a.id), db: me.parent_id, rel } };
      }
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
  'page.delete': { roles: ['app', 'main'], write: true, lockBlocked: true, args: { id: 'id' },
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
  'page.move': { roles: ['app'], write: true, lockBlocked: true, args: { id: 'id', parentId: 'idOrEmpty', afterId: 'idOrEmpty?', rowAfter: 'idOrEmpty?', rowParent: 'id?' },   // PR-2 直し（R44）: rowAfter・rowParent
    run: pageMove, dupResult: (db) => listPages(db) },
  'page.restore': { roles: ['app'], write: true, args: { id: 'id' },
    run: pageRestore, dupResult: (db) => listPages(db) },
  // 0.18.0 CW-1（決めたこと 12・14・AQ5 (a)）: Claude の変更の控えの一覧と戻す（役 app だけ。Claude（役 mcp）は戻せない。元に戻すの歩みにしない）
  'page.claudeSnaps': { roles: ['app'], write: false, args: { id: 'id' }, run: claudeSnaps },
  'page.claudeRevert': { roles: ['app'], write: true, args: { id: 'id', sid: 'num' }, run: claudeRevert, dupResult: reread },
  // 0.18.0 CS-2（決めたこと 17〜22）: Claude の要約の書き戻し（役 mcp だけ: CR42）
  'mcp.writeSummary': { roles: ['mcp'], write: true, args: { pageId: 'id', baseRev: 'int', md: 'mdText', meetingType: 'meetingTypeArg?' }, run: mcpWriteSummary, dupResult: writeSummaryDup },
  // 0.18.0 CS-3（決めたこと 23〜26）: Claude の名前の直し（役 mcp だけ）。送り直しの答えは counts: null（直した後なので当たりは数え直さない: CR61）
  'mcp.fixNames': { roles: ['mcp'], write: true, args: { pageId: 'id', pairs: 'namePairs' }, run: mcpFixNames,
    dupResult: (db, a) => { const p = readPage(db, a.pageId); return p ? { title: p.title, counts: null } : null; } },
  // 0.18.0 CT-1（決めたこと 27・28・D149）: Claude の ToDo の更新と［タスクにする］（役 mcp だけ）
  'mcp.updateAction': { roles: ['mcp'], write: true, args: { pageId: 'id', blockId: 'id', done: 'bool?', assignee: 'short?', dueRaw: 'short?' }, run: mcpUpdateAction, dupResult: actionDup },
  'mcp.makeTask': { roles: ['mcp'], write: true, args: { pageId: 'id', blockId: 'id' }, run: mcpMakeTask,
    dupResult: (db, a, row) => { const r = DEFS['todo.toTask'].dupResult(db, a); return r ? { ...r, made: JSON.parse(row.ops || '[]').length > 0 } : null; } },
  // 0.18.0 CT-2（決めたこと 30〜33）: Claude の白紙のページを作る・書き足す（役 mcp だけ）
  'mcp.createPage': { roles: ['mcp'], write: true, args: { title: 'oneLineTitle', md: 'mdText', parentId: 'id?' }, run: mcpCreatePage, dupResult: createPageDup },
  'mcp.appendPage': { roles: ['mcp'], write: true, args: { pageId: 'id', md: 'mdText' }, run: mcpAppendPage, dupResult: appendPageDup },
  'pages.trash': { roles: ['app'], write: false, args: {},
    run: (db) => ({ result: trashHeads(db) }) },
  'block.update': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id', patch: 'patch' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      const l = BT.locate(p.blocks, a.blockId);
      if (!l) return false;
      const b = l.b;
      if (a.patch.inline !== undefined) return setInline(db, p, b, a.patch);   // 0.16.0 DL-1（決めたこと 39・R113）: ［インラインにする］・［ページの行に変える］
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
  // 無ければ平らにした保存の順の前の行（main など）。消した行の子は、消した行のあった所に元の順で1段上がって並ぶ（0.17.0 NX-2・決めたこと 81: BT.liftOut。
  // 前の「つないだ先の子の末尾へ」（0.13.1 の EQ6 (a)・mergeKids）を替えた）
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
        if (isFixedRow(prev)) throw refuse('bad-args');   // 0.15.0 PR-1（決めたこと 53・HR18）: 子ページの行はつなぐ先にもしない（画面は子ページの行を選ぶ）
        if (a.rich !== undefined && RT.plainOf(a.rich) !== a.text) throw refuse('bad-args');
        if (a.rich !== undefined) putRich(b, a.rich);   // つなぐ今の行の飾り（画面の今の形）
        if (prev.type === 'divider') { pl.list.splice(pl.index, 1); retext(b, a.text); return true; }
        const at = String(prev.text || '').length;
        const tail = Array.isArray(b.rich) && RT.plainOf(b.rich) === a.text ? b.rich : [{ t: a.text }];   // 今の行の飾りを捨てない（0.14.0 EB-2）
        if (Array.isArray(prev.rich) || Array.isArray(b.rich)) putRich(prev, blockEdit.joinRich(Array.isArray(prev.rich) ? prev.rich : [{ t: String(prev.text || '') }], tail));
        if (a.text) retext(prev, String(prev.text || '') + a.text);
        BT.liftOut(l.list, l.index);   // 0.17.0 NX-2（決めたこと 81）: 子は消えた行の所に1段上がって並ぶ
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
        dropTaskMarks([copy]);   // 0.17.0 点検 3（rv60 軽い 2・R71）: ［タスクにする］の印は写さない（1つのタスクを2つの ToDo が指さない）
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
      if (tops.every(isFixedRow)) throw refuse('bad-args');   // 0.16.0 DL-1: リンクドビューの行も
      for (const top of tops) {
        for (const x of BT.flattenBlocks([top])) { if (isFixedRow(x)) continue; if (a.color) x.color = a.color; else delete x.color; }
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
        dropTaskMarks(keep);   // 0.17.0 点検 3（rv60 軽い 2・R71）: ［タスクにする］の印は写さない
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
      keepStoredCells(was.page, page);   // 0.17.0 MG-1: 「議事録」の列の値も
      if (!Array.isArray(page.blocks)) page.blocks = [];
      keepTaskMarks(was.page, page);   // 0.17.0 点検 3（rv60 軽い 3・R67）: 作り直した同じ文の ToDo に［タスクにする］の印を引き継ぐ
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
  // 0.17.0 MG-2（決めたこと 47・48）: 議事録を「議事録」データベースへ移す（最初の起動の控えの後は first・起動のたびの見回りは first 無し。DB のプロセスが呼ぶ）
  'minutes.gather': { roles: ['main'], write: true, args: { first: 'bool?' }, run: minutesGather, pageOf: () => null },
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
  // 0.17.0 PD-1（決めたこと 32）: 空の白紙のページをデータベースにする（oplog の page_id はそのページ・元に戻すの歩みはデータベースの歩み）→ { page, id }
  'page.toDb': { roles: ['app'], write: true, args: { id: 'id' }, run: pageToDb, dupResult: (db, a) => { const page = readPage(db, a.id); return page ? { page, id: a.id } : null; } },
  'db.create': { roles: ['app'], write: true, args: { parentId: 'id?', inline: 'id?' }, pageOf: () => null,
    run: dbCreate,
    dupResult: (db, _a, row) => {
      const add = JSON.parse(row.ops || '[]').find((o) => o && o.op === 'add' && o.row && o.row.type === 'page');
      return add ? { page: readPage(db, add.id), id: add.id } : null;
    } },
  'db.get': { roles: ['app'], write: false, args: { id: 'id', linked: 'id?' }, run: (db, a) => ({ result: dbGetOf(db, a.id, a.linked) }) },
  'db.view': { roles: ['app'], write: false, args: { id: 'id', viewId: 'id', from: 'int', count: 'int', q: 'short?', open: 'ids?', linked: 'id?' }, run: dbViewRead },
  // 0.16.0 DL-1（決めたこと 40・R105）: リンクドビューの行を置く（本文の歩み）・データベースの題名（データベースの歩み）
  'block.insertDbView': { roles: ['app'], write: true, args: { pageId: 'id', afterId: 'idOrEmpty', db: 'id', from: 'id?' }, run: insertDbView,
    dupResult: (db, a, row) => {
      const page = readPage(db, a.pageId);
      const o = dupOps(row).find((x) => x && ((x.op === 'add' && isObj(x.row) && x.row.type === 'dbview') || (x.op === 'retype' && x.value === 'dbview')));
      return page ? { page, blockId: o ? o.id : null } : null;
    } },
  'db.setTitle': { roles: ['app'], write: true, args: { db: 'id', title: 'title' }, pageOf: dbOfArgs, run: dbSetTitle, dupResult: (db, a) => readPage(db, a.db) },
  // 0.17.0 RT-1（決めたこと 66〜70）: 行のテンプレート（どれも役 app・データベースの歩み。作るのはロック中は断る: 決めたこと 69・74）
  'tpl.add': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', title: 'title?' }, pageOf: dbOfArgs, run: tplAdd, dupResult: (db, a, row) => ({ id: tplDupId(row) }) },
  'tpl.dup': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', id: 'id' }, pageOf: dbOfArgs, run: tplAdd, dupResult: (db, a, row) => ({ id: tplDupId(row) }) },
  'tpl.remove': { roles: ['app'], write: true, args: { db: 'id', id: 'id' }, pageOf: dbOfArgs, run: tplRemove, dupResult: (db, a) => ({ removed: a.id }) },
  'tpl.setDefault': { roles: ['app'], write: true, args: { db: 'id', id: 'idOrEmpty', view: 'id?' }, pageOf: dbOfArgs, run: tplSetDefault, dupResult: (db, a) => { const d = dbOf(db, a.db); return d ? { tpls: tplInfo(db, d) } : null; } },
  'row.fromTpl': { roles: ['app'], write: true, args: { db: 'id', id: 'id', afterId: 'idOrEmpty?' }, pageOf: dbOfArgs, run: rowFromTpl, dupResult: (db, a, row) => ({ id: tplDupId(row) }) },
  // 0.17.0 TK-2（決めたこと 63）: ［タスクにする］（役 app・要約の欄の歩み: Ctrl+Z で行と印が一緒に戻る）
  'todo.toTask': { roles: ['app'], write: true, args: { pageId: 'id', blockId: 'id' }, run: todoToTask,
    dupResult: (db, a) => { const l = loadPage(db, a.pageId); const h = l ? BT.locate(l.page.blocks, a.blockId) : null; const r = h && h.b.task ? db.prepare(HOT_QUERIES.dbRow).get(h.b.task) : null; return r ? { id: r.id, db: r.parent_id } : null; } },
  // 0.17.0 LK-1（決めたこと 73・75）: データベースのロック（役 app・元に戻すの歩みにしない: UNDO_CMDS に入れない）
  'db.setLock': { roles: ['app'], write: true, args: { db: 'id', on: 'bool' }, pageOf: dbOfArgs, run: dbSetLock, dupResult: (db, a) => { const d = dbOf(db, a.db); return d ? { locked: d.attrs.locked === true } : null; } },
  // 0.16.0 DR-1（決めたこと 33〜38・R98）: リレーションの行を足す・外す・サブアイテムを入れる・外す（データベースの歩み）・つなぐ先の行を探す（読む）
  'rel.link': { roles: ['app'], write: true, args: { db: 'id', id: 'id', col: 'id', ids: 'ids', title: 'title?' }, pageOf: dbOfArgs, run: (db, a, ctx) => relEdit(db, a, ctx, true),
    dupResult: (db, a, row) => { const r = db.prepare(HOT_QUERIES.dbRow).get(a.id); const c = r ? JSON.parse(r.attrs || '{}').cells : null; const add = dupOps(row).find((o) => o && o.op === 'add'); return r ? { cell: (isObj(c) && c[a.col]) || [], ...(add ? { added: add.id } : {}) } : null; } },
  'rel.unlink': { roles: ['app'], write: true, args: { db: 'id', id: 'id', col: 'id', ids: 'ids' }, pageOf: dbOfArgs, run: (db, a, ctx) => relEdit(db, a, ctx, false),
    dupResult: (db, a) => { const r = db.prepare(HOT_QUERIES.dbRow).get(a.id); const c = r ? JSON.parse(r.attrs || '{}').cells : null; return r ? { cell: (isObj(c) && c[a.col]) || [] } : null; } },
  'db.setSub': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', on: 'bool' }, pageOf: dbOfArgs, run: dbSetSub,
    dupResult: (db, a) => { const d = dupDb(db, a); const s = d ? subOf(d) : null; return d ? (s ? { sub: s } : {}) : null; } },
  'rel.find': { roles: ['app'], write: false, args: { db: 'id', q: 'short?' }, run: relFind },
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
    // 0.17.0 点検 3（rv60 軽い 6・R74）: 1回目の答えと同じ数（表の行だけ: そのデータベースの直の子。議事録の子孫のページは数えない）
    dupResult: (db, a, row) => ({ trashed: JSON.parse(row.ops || '[]').filter((o) => o && o.op === 'trash' && (db.prepare('select parent_id from blocks where id = ?').get(o.id) || {}).parent_id === a.db).length }) },
  'rows.paste': { roles: ['app'], write: true, args: { db: 'id', viewId: 'id', at: 'cellRef', grid: 'pasteGrid' }, pageOf: dbOfArgs, run: rowsPaste, dupResult: DUP['rows.paste'] },
  'col.add': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', type: 'colType', name: 'short?', after: 'idOrEmpty?', target: 'id?', both: 'bool?' }, pageOf: dbOfArgs, run: colAdd, dupResult: DUP['col.add'] },
  'col.rename': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', col: 'id', name: 'short' }, pageOf: dbOfArgs, run: colRename, dupResult: dupCol },
  'col.setType': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', col: 'id', type: 'colType' }, pageOf: dbOfArgs, run: colSetType, dupResult: DUP['col.setType'] },
  'col.typeCheck': { roles: ['app'], write: false, args: { db: 'id', col: 'id', type: 'colType' }, run: colTypeCheck },
  'col.move': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', col: 'id', after: 'idOrEmpty' }, pageOf: dbOfArgs, run: colMove, dupResult: dupCol },
  'col.remove': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', col: 'id' }, pageOf: dbOfArgs, run: colRemove, dupResult: dupCol },
  'col.restore': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', col: 'id' }, pageOf: dbOfArgs, run: colRestore, dupResult: dupCol },
  'col.purge': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', col: 'id' }, pageOf: dbOfArgs, run: colPurge, dupResult: DUP['col.purge'] },
  'col.setOpts': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', col: 'id', opts: 'optsArg', groups: 'groupsArg?' }, pageOf: dbOfArgs, run: colSetOpts, dupResult: dupCol },
  'col.setFmt': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', col: 'id', fmt: 'short?', prefix: 'short?' }, pageOf: dbOfArgs, run: colSetFmt, dupResult: dupCol },
  'view.add': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', layout: 'layout?', name: 'short?', from: 'id?', linked: 'id?' }, pageOf: dbOfArgs, run: viewAdd, dupResult: DUP['view.add'] },
  'view.update': { roles: ['app'], write: true, args: { db: 'id', viewId: 'id', patch: 'viewPatch', linked: 'id?' }, pageOf: dbOfArgs, run: viewUpdate, dupResult: DUP['view.one'] },
  'view.remove': { roles: ['app'], write: true, lockBlocked: true, args: { db: 'id', viewId: 'id', linked: 'id?' }, pageOf: dbOfArgs, run: viewRemove, dupResult: DUP['view.remove'] },
  'view.move': { roles: ['app'], write: true, args: { db: 'id', viewId: 'id', after: 'idOrEmpty', linked: 'id?' }, pageOf: dbOfArgs, run: viewMove, dupResult: DUP['view.one'] },
};

// 0.17.0 LK-1（計画 docs/plans/2026-11-13-170.md の決めたこと 74・75・F204。持ち主の試作 5 の「命令の表の1か所の印」）: lockBlocked の命令は、指すデータベース
// （a.db、無ければ a.id。リンクドビューのビュー（a.linked）はそのページの行の設定なので見ない）がロック中なら bad-args で何も書かない。送り直しの答えは今どおり（core が先に見る）
const lockTargetOf = (a) => (a.linked !== undefined ? null : typeof a.db === 'string' ? a.db : typeof a.id === 'string' ? a.id : null);
const lockGuard = (run) => (db, a, ctx) => { if (isLockedDb(db, lockTargetOf(a))) throw refuse('bad-args'); return run(db, a, ctx); };
const COMMANDS = Object.freeze(Object.assign(Object.create(null),
  Object.fromEntries(Object.entries(DEFS).map(([k, v]) => [k, Object.freeze(v.lockBlocked ? { ...v, run: lockGuard(v.run) } : v)]))));

module.exports = { minutesState, newPageId, COMMANDS, HOT_QUERIES, withSnap, putPageRows, readPage, readRawPage, readSegments, listPages, isPurged, listedRows, actionView, entryOf, setTypePage, keepStoredMemo, dbDump, dbRowCountOf };
