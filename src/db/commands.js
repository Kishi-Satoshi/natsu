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
const quality = require('../quality');
// 議事録の経過（0.10.0 K-1。決めたこと 116）: 締め・復旧のページの stateLog は表の鍵の項目だけを残す
const SL = require('../statelog');
const blockEdit = require('../blockEdit');
// 0.13.1（計画 docs/plans/2026-10-27-131.md の決めたこと 3・4・7〜11）: 要約のブロックは木（children）。命令は行を locate で探し、置き場は spotOf（NR6）
const BT = require('../blockTree');
const { diffPage, diffSegments, applyOps, invertOps, opsMatch } = require('./ops');
// 0.14.0 EB-2（計画 docs/plans/2026-10-26-140.md の決めたこと 1〜6・14〜16・R60・R72）: 戻せる命令の表（画面の元に戻すの列と同じ）と飾りの整え
const { UNDO_CMDS } = require('../undoBook');
const RT = require('../richText');
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
  pageBlocks: 'select id, type, text, rich, attrs, ord, parent_id from blocks where page_id = ? and id <> ? order by ord',
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

// 0.13.1 NR14: view が真の命令（トグルの開け閉め。見た目だけの欄 open）は鍵を見るが、手直しの印（summaryEdited）を付けない
function editPage(db, id, ctx, fn, { summary = false, view = false } = {}) {
  const w = forWrite(db, id);
  if (!w) return { ops: [], pageIds: [], result: null };
  if (summary && summaryLockedPage(db, w.was.page)) throw refuse('locked');
  const before = summary ? JSON.stringify(w.page.blocks) : '';
  if (fn(w.page) === false) return { ops: [], pageIds: [], result: null };
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
  const add = JSON.parse(row.ops || '[]').find((o) => o && o.op === 'add' && o.row && o.row.type !== 'page');
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
  const fwd = rows.flatMap((r) => JSON.parse(r.ops || '[]'));
  const l = loadPage(db, a.pageId);
  if (!l) throw refuse('bad-args');   // 無い・ゴミ箱のページ
  if (!fwd.length) return { ops: [], pageIds: [], result: { page: readPage(db, a.pageId) } };
  const summary = fwd.some((o) => o && o.id !== a.pageId);   // 要約の行に触れた歩み（鍵と印。メモだけの歩みは見ない: R76）
  if (summary && summaryLockedPage(db, l.page)) throw refuse('locked');
  let back;
  let same;
  try {
    back = invertOps(fwd, { pageId: a.pageId });
    same = opsMatch(db, fwd);
  } catch (_) { throw refuse('bad-args'); }   // 戻せない操作（ページの行の削除・発言など）
  if (!same) throw refuse('stale');
  // 後ろへ当てた形を一度試しに当てて、直した時刻・出典の数・印の操作を作る（当てるのは1回だけ: T4b の rev の上がり方を同じにする）
  let meta;
  let fits = true;
  db.exec('SAVEPOINT natsu_revert');
  try {
    applyOps(db, back);
    fits = placesFit(db, a.pageId, back);
    const w = loadPage(db, a.pageId);
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

const DEFS = {
  // ---- 読む（app と main）
  'pages.list': { roles: ['app', 'main'], write: false, args: { q: 'text?' },
    run: (db, a) => ({ result: a.q ? S.searchList(db, a.q, searchView(db)) : listPages(db) }) },
  'pages.searchFull': { roles: ['app', 'main'], write: false, args: { q: 'text?', limit: 'num?' },
    run: (db, a) => ({ result: S.searchFull(db, a.q || '', a.limit, searchView(db)) }) },
  'pages.actionView': { roles: ['app', 'main'], write: false, args: { q: 'text?', assignee: 'short?' },
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
      const l = BT.locate(p.blocks, a.blockId);
      if (!l) return false;
      const b = l.b;
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
      const add = JSON.parse(row.ops || '[]').find((o) => o && o.op === 'add' && o.row && o.row.type !== 'page');
      return { page, blockId: add ? add.id : null };
    } },
  'block.remove': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id' },
    // 0.13.1（決めたこと 3・F49）: 子ごと消す（子孫の行も同じ命令の trash に積む）。無い行は何も変えない
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      const l = BT.locate(p.blocks, a.blockId);
      if (l) l.list.splice(l.index, 1);
    }, { summary: true }),
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
      if (a.type === 'divider' && String(b.text || '') !== '') throw refuse('bad-args');
      if (a.type === 'divider' && Array.isArray(b.children) && b.children.length) throw refuse('bad-args');   // NR7（EQ16 (a)）: 子のある行も
      const level = a.type === 'heading' ? (a.level || 2) : 0;
      const toggle = a.type === 'heading' && a.toggle === true;
      if (b.type === a.type && (a.type !== 'heading' || (blockEdit.headingLevel(b) === level && (b.toggle === true) === toggle))) return false;
      const out = BT.turnMovesKids(b, { type: a.type, level, toggle });
      // 2026-10-26 の持ち主の答え（点検2）: AI の見出しを別の型にしたら印 aiHeading を付け、文を変えずに見出しへ戻したら AI の見出しに戻す
      // （orderForView の節と［コピー］の順が行って戻って同じ）。文を変えると印は消え（retext・block.update）、人の行のまま
      if (b.type === 'heading' && b.citeState === undefined && a.type !== 'heading') b.aiHeading = true;
      if (b.citeState === undefined && !(b.type === 'heading' && a.type === 'heading')) b.citeState = 'manual';
      if (a.type === 'heading' && b.aiHeading === true) { delete b.citeState; delete b.aiHeading; }
      b.type = a.type;
      if (level) b.level = level; else delete b.level;
      if (toggle) b.toggle = true; else delete b.toggle;
      if (a.type === 'callout' && !b.icon) b.icon = blockEdit.CALLOUT_ICON;
      if (a.type === 'todo' && typeof b.checked !== 'boolean') b.checked = false;
      if (out) BT.kidsOut(l.list, l.index);
      return true;
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
        const after = a.afterId === undefined ? a.blockId : a.afterId;
        if (after !== '' && !BT.locate(p.blocks, after)) throw refuse('bad-args');
        const copy = { ...clone(l.b), id: blockId };
        const used = new Set([blockId]);
        for (const d of BT.flattenBlocks(copy.children)) {
          let nid = newBlockId(db, ctx.now);
          while (used.has(nid)) nid = newBlockId(db, ctx.now);
          used.add(nid); d.id = nid;
        }
        const s = BT.spotOf(p.blocks, after, a.parentId);
        if (!s) throw refuse('bad-args');
        s.list.splice(s.index, 0, copy);
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
  'blocks.setColor': { roles: ['app', 'main'], write: true, args: { pageId: 'id', ids: 'ids', color: 'blockColor' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => {
      if (!a.ids.length) throw refuse('bad-args');
      for (const id of a.ids) {
        const l = BT.locate(p.blocks, id);
        if (!l) throw refuse('bad-args');
        if (a.color) l.b.color = a.color; else delete l.b.color;
      }
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
