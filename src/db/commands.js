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
 *   readSegments(db, pageId) … [{ id, atMs?, durationMs?, text, failed?, ...extra }]（NULL の欄は出さない）
 *
 * 画面の 14 の命令は、答えの形を今の main の IPC（= json-backend）と同じにする（test/db-commands.test.js が比べる）。
 * ページを書く命令は、今の store.savePage と同じに updatedAt と citeStat を作り直し、diffPage の操作を当てる
 * （当てるとページの行の rev が1つ上がる。ブロックだけを変える命令でも: F6）。
 * 一覧から外すページ: ゴミ箱（trashed_at）と、録音中の写し（attrs.meeting.phase が recording・paused・finalizing）。
 * 検索の2つ（pages.list の q・pages.searchFull）は D-4。この段の pages.list は q を見ない。
 */
'use strict';

const crypto = require('node:crypto');
const { isCitable, refreshCitations, searchFold } = require('../cite');
const { parseDue } = require('../actions');
const { routeLabel } = require('../mainlib');
const R = require('../pagerules');
const { diffPage, diffSegments, applyOps } = require('./ops');

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
  list: "select id, created_at, attrs, trashed_at from blocks where type = 'page' order by created_at desc, rid desc",
  pageRow: 'select id, type, text, attrs, rev, created_at, updated_at, trashed_at from blocks where id = ?',
  pageBlocks: 'select id, type, text, rich, attrs, ord from blocks where page_id = ? and id <> ? order by ord',
  pageSegments: 'select id, at_ms, duration_ms, text, failed, extra from segments where page_id = ? order by n',
  todoPages: "select distinct page_id from blocks where type = 'todo'",
  oplogTx: 'select seq, role, tx, at, actor, action, page_id, ops from oplog where role = ? and tx = ?',
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

// ページを1つ直す命令の形: fn(page) が直す（false を返したら何も書かずに null）。答えは書いた後のページ（今の savePage の答え）
function editPage(db, id, ctx, fn) {
  const w = forWrite(db, id);
  if (!w) return { ops: [], pageIds: [], result: null };
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

// 一覧に出すページの ID（新しい順。ゴミ箱と録音中の写しを除く）
function listedIds(db) {
  const out = [];
  for (const r of db.prepare(HOT_QUERIES.list).all()) {
    if (r.trashed_at !== null && r.trashed_at !== undefined) continue;
    if (isLive(JSON.parse(r.attrs || '{}'))) continue;
    out.push(r.id);
  }
  return out;
}

// 外すページの判定は listedIds の1か所だけ（読むときにもう一度ゴミ箱を見ると、片方を戻す変異が生き残る）
function listPages(db) {
  const out = [];
  for (const id of listedIds(db)) {
    const l = loadPage(db, id, { trashed: true });
    if (l) out.push(R.listEntry(l.page));
  }
  return out;
}

// アクションタブの1画面分（今の store.actionView と同じ答え。ToDo のあるページだけ読む）
function actionView(db, { q, assignee } = {}) {
  const fq = searchFold(q);
  const who = String(assignee || '');
  const withTodo = new Set(db.prepare(HOT_QUERIES.todoPages).all().map((r) => r.page_id));
  const counts = new Map();
  const actions = [];
  let total = 0;
  for (const id of listedIds(db)) {
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

const DEFS = {
  // ---- 読む（app と main）
  'pages.list': { roles: ['app', 'main'], write: false, args: { q: 'text?' },
    run: (db) => ({ result: listPages(db) }) },
  'pages.actionView': { roles: ['app', 'main'], write: false, args: { q: 'text?', assignee: 'short?' },
    run: (db, a) => ({ result: actionView(db, a) }) },
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
  'page.setType': { roles: ['app', 'main'], write: true, args: { id: 'id', type: 'name' },
    run: (db, a, ctx) => editPage(db, a.id, ctx, (p) => { p.meetingType = a.type; p.typeAuto = false; }), dupResult: reread },
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
        b.text = patch.text;
      }
      if (typeof patch.checked === 'boolean') b.checked = patch.checked;
      if (typeof patch.type === 'string') b.type = patch.type;
      return true;
    }),
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
      });
      return { ...out, result: out.result ? { page: out.result, blockId } : null };
    },
    dupResult: (db, a, row) => {
      const page = readPage(db, a.pageId);
      if (!page) return null;
      const add = JSON.parse(row.ops || '[]').find((o) => o && o.op === 'add' && o.row && o.row.type !== 'page');
      return { page, blockId: add ? add.id : null };
    } },
  'block.remove': { roles: ['app', 'main'], write: true, args: { pageId: 'id', blockId: 'id' },
    run: (db, a, ctx) => editPage(db, a.pageId, ctx, (p) => { p.blocks = p.blocks.filter((x) => x.id !== a.blockId); }),
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
    }),
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
    }),
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
};

const COMMANDS = Object.freeze(Object.assign(Object.create(null),
  Object.fromEntries(Object.entries(DEFS).map(([k, v]) => [k, Object.freeze(v)]))));

module.exports = { COMMANDS, HOT_QUERIES, putPageRows, readPage, readSegments, listPages };
