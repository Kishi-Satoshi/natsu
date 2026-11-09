/*
 * ops.js — 操作の列 oplog の操作を作る（diffPage・diffSegments）・当てる（applyOps）（第2a1回 T4b。純粋。node:sqlite の接続は引数）
 *
 * 1つの命令 = oplog の1行 = 操作の配列。どの操作も前の値を持つので、後ろへ当てれば元に戻せる（第2b回の「元に戻す」）。
 * 控えに後の oplog を前へ当て直せば今の表になる（D-7）。操作の形（どれも id は blocks の行の id。seg だけ発言の id）:
 *   { op: 'add', id, row }                ブロックかページの行を足す（row は下の blockRow・pageRow の形）。後ろへは消す
 *   { op: 'move', id, ord, old }          並びの鍵を変える（鍵は同じ親の兄弟の中の並び: 0.13.1 NR1）
 *   { op: 'move', id, ord, old, parent, oldParent }  親も変える（0.13.1 決めたこと 7。親が変わったときだけ parent・oldParent を持つ。
 *                                         後ろへ当てれば前の親と鍵に戻る。子は親の ID を指したままなので書かない）。
 *                                         0.15.0 PH-2: ページの行の親（子のページ）。最上位は parent: null・前の親が最上位なら oldParent: null
 *   { op: 'set', id, key, value, old }    欄を変える。ページの行の createdAt・updatedAt は列、rich はどの行でも列、
 *                                         ほかは attrs の欄。value・old が無い（undefined。JSON にすると欄ごと消える）なら欄を消す
 *   { op: 'text', id, value, old }        text を変える（ページの行は題名）
 *   { op: 'retype', id, value, old }      type を変える
 *   { op: 'trash', id, at, old }          ページの行: trashed_at を at に（old は前の trashed_at）
 *   { op: 'trash', id, old: row }         ブロックの行: 行を消す（old は消した行。後ろへは戻す）
 *   { op: 'restore', id, at, old }        ページの行: trashed_at を NULL に（old は前の trashed_at）
 *   { op: 'purge', id }                   ページの全部の行と発言を消す（中身を残さない。後ろへは当てられない）
 *   { op: 'seg', id, page, n, value, old, oldN }  発言（value・old は発言の形。old が null なら足した、value が null なら消した）
 * 当てたら、検索の欄 fold を作り直し、触れたページの行の rev を1つ上げる（この呼び出しで足した・消したページは除く）。
 * 投げたら、呼び手のトランザクションごと戻す（core.call の中で呼ぶ）。
 * 0.14.0 EB-1（元に戻す）: invertOps は後ろへ当てる形を新しい操作の列にし（前へ当てれば後ろへ当てたのと同じ）、opsMatch は操作の「後の値」が
 * 今の表と同じかを見る（後から変わっていたら戻さない: 計画 docs/plans/2026-10-26-140.md の決めたこと 4・5・R60）。
 */
'use strict';

const { isDeepStrictEqual } = require('node:util');
const { searchFold } = require('../cite');
const { evenKeys, keyBetween, keysBetween } = require('./keys');
const { VIEW_KEYS } = require('../blockTree');
const { foldCells } = require('../dbModel');

const PAGE_FIXED = ['id', 'title', 'blocks', 'createdAt', 'updatedAt', 'children', 'type', 'text', 'rich'];
const DB_MADE = ['rev', 'routeText', 'qualityView'];     // DB が作る欄（書くときは黙って捨てる）。0.11.0 Q-3 で qualityView を足した
const BLOCK_FIXED = ['id', 'type', 'text', 'rich', 'children'];
const SEG_FIXED = ['id', 'atMs', 'durationMs', 'text', 'failed'];
const PAGE_ORD = 'i';                     // ページの行の並びの鍵（2a1 では使わない。第5回の子のページで使う）

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
// 0.16.0 DS-2（計画 docs/plans/2026-11-04-160.md の決めたこと 2・3・TR1）: ページとして開ける行の型（ページの行と、データベースの行 row）。
// 判定はこの1か所。一覧・木・ゴミ箱・会議の見回り・MCP の読み手は今どおり type = 'page' だけを読む（行を混ぜない: 決めたこと 3）
const isDocType = (type) => type === 'page' || type === 'row';

// ---------------------------------------------------------------- 検索の欄
function pageFold(title, memo) { return searchFold(title) + '\u0001' + searchFold(memo); }
function textFold(text) { return searchFold(text); }
// 0.16.0 DS-2（決めたこと 6）: データベースの行は、題名と、セルの文字（テキスト・URL・メール・電話）と選択肢の名前。列（cols）は
// 親のデータベースのページの attrs.cols（applyOps が読んで渡す）。1つの欄ずつ寄せ、間は \u0001（欄をまたいで当たらない）
function rowFold(text, attrs, cols) {
  const cells = isObj(attrs) && isObj(attrs.cells) ? attrs.cells : {};
  return [text, ...foldCells(Array.isArray(cols) ? cols : [], cells).split('\n')].map(searchFold).join('\u0001');
}
function foldOfRow(type, text, attrs, cols) {
  if (type === 'row') return rowFold(text, attrs, cols);
  return type === 'page' ? pageFold(text, isObj(attrs) ? attrs.memo : '') : textFold(text);
}

// ---------------------------------------------------------------- ページ・ブロック・発言 → 行
function pick(obj, fixed) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (!fixed.includes(k) && v !== undefined) out[k] = v;
  return out;
}

function pageRow(page, { ord = PAGE_ORD } = {}) {
  return {
    id: page.id, type: 'page', page_id: page.id, parent_id: null, ord,
    text: str(page.title), rich: null, attrs: pick(page, [...PAGE_FIXED, ...DB_MADE]),
    rev: 1, created_at: str(page.createdAt), updated_at: str(page.updatedAt), trashed_at: null,
  };
}

// parentId は親の行の ID（最上位はページの ID。0.13.1 決めたこと 7: 子は parent_id と兄弟の中の鍵 ord を持つ）
// 0.16.0 DS-2（決めたこと 2）: データベースの行。page_id は自分（行の本文のブロックは page_id が行の ID）・parent_id はデータベースのページ・
// text は題名・attrs は { cells, by: { c, u }, no }（作成者・最終更新者・ID の列の番号）。作成日時・最終更新日時は列
function rowBlock({ id, db, ord, title, cells, by, no, at }) {
  return {
    id, type: 'row', page_id: id, parent_id: db, ord,
    text: str(title), rich: null, attrs: { cells: isObj(cells) ? cells : {}, by, no },
    rev: 1, created_at: str(at), updated_at: str(at), trashed_at: null,
  };
}

function blockRow(b, pageId, ord, parentId = pageId) {
  return {
    id: b.id, type: b.type, page_id: pageId, parent_id: parentId, ord,
    text: str(b.text), rich: Array.isArray(b.rich) ? b.rich : null, attrs: pick(b, BLOCK_FIXED),
    rev: 1, created_at: '', updated_at: '', trashed_at: null,
  };
}

// 発言 → segments の行。列に入らない値（整数でない時刻・真偽でない failed・文字でない text）は extra に残す（形を変えない）
function segRow(s, pageId, n) {
  const extra = pick(s, SEG_FIXED);
  const intCol = (k) => {
    if (s[k] === undefined) return null;
    if (Number.isSafeInteger(s[k])) return s[k];
    extra[k] = s[k];
    return null;
  };
  const at = intCol('atMs');
  const dur = intCol('durationMs');
  let failed = null;
  if (typeof s.failed === 'boolean') failed = s.failed ? 1 : 0;
  else if (s.failed !== undefined) extra.failed = s.failed;
  let text = '';
  if (typeof s.text === 'string') text = s.text;
  else if (s.text !== undefined) extra.text = s.text;
  return {
    page_id: pageId, id: s.id, n, at_ms: at, duration_ms: dur, text, fold: textFold(text), failed,
    extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
  };
}

// ---------------------------------------------------------------- 差分
// 並べ替え: 残ったブロックのうち、前の並びの順を保ついちばん長い列（LIS）は動かさず、ほかは前後の鍵の間に入れ直す
function stayingSet(order) {
  // order: 残ったブロックの、前の並びでの位置（新しい並びの順）。LIS の位置の集合を返す
  const tails = []; const tailIdx = []; const prev = new Array(order.length).fill(-1);
  for (let i = 0; i < order.length; i++) {
    let lo = 0; let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] < order[i]) lo = mid + 1; else hi = mid; }
    tails[lo] = order[i]; tailIdx[lo] = i; prev[i] = lo > 0 ? tailIdx[lo - 1] : -1;
  }
  const keep = new Set();
  for (let i = tails.length ? tailIdx[tails.length - 1] : -1; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

function setOps(id, oldObj, newObj, fixed, colKeys) {
  const ops = [];
  const keys = new Set([...Object.keys(pick(oldObj, fixed)), ...Object.keys(pick(newObj, fixed)), ...colKeys]);
  for (const key of keys) {
    const isCol = colKeys.includes(key);
    const before = isCol ? colValue(key, oldObj[key]) : oldObj[key];
    const after = isCol ? colValue(key, newObj[key]) : newObj[key];
    if (!isDeepStrictEqual(before, after)) ops.push({ op: 'set', id, key, value: after, old: before });
  }
  return ops;
}
function colValue(key, v) {
  if (key === 'rich') return Array.isArray(v) ? v : null;
  return str(v);   // createdAt・updatedAt（無ければ ''）
}

// diffPage(oldPage, newPage, { ords }) → ops。oldPage が null なら新しいページ（行を全部足す）。
// ords は前のブロックの id → 並びの鍵（DB の今の値）。無ければ前の兄弟の並びに evenKeys を当てたものとみなす。
// 0.13.1（決めたこと 7・NR1）: ブロックは木（children）。木を親ごとの兄弟の並びに分けて比べ、鍵は兄弟の中の並び。
// 同じ親に残った行のうち、前の並びの順を保ついちばん長い列（LIS）は動かさず、ほかの行（親が変わった行も）だけに新しい鍵を書く
// （字下げ・動かすは動かした行の1行だけ。子は親の ID を指したままなので書かない）。消した行の子孫も trash（page.put の往復で木を壊さない: F54）
const kidsOf = (b) => (isObj(b) && Array.isArray(b.children) ? b.children.filter(isObj) : []);
function diffPage(oldPage, newPage, { ords } = {}) {
  if (!isObj(newPage) || typeof newPage.id !== 'string') throw new Error('diffPage: 新しいページの形が正しくない');
  const pid = newPage.id;
  const newBlocks = Array.isArray(newPage.blocks) ? newPage.blocks.filter(isObj) : [];
  if (!oldPage) {
    const ops = [{ op: 'add', id: pid, row: pageRow(newPage) }];
    const addAll = (list, parent) => {
      const keys = evenKeys(list.length);
      list.forEach((b, i) => { ops.push({ op: 'add', id: b.id, row: blockRow(b, pid, keys[i], parent) }); addAll(kidsOf(b), b.id); });
    };
    addAll(newBlocks, pid);
    return ops;
  }
  const ops = [];
  // ページの行
  if (str(oldPage.title) !== str(newPage.title)) ops.push({ op: 'text', id: pid, value: str(newPage.title), old: str(oldPage.title) });
  ops.push(...setOps(pid, pick(oldPage, DB_MADE), pick(newPage, DB_MADE), PAGE_FIXED, ['createdAt', 'updatedAt']));
  // ブロック（前の木: id → { b, parent, i（兄弟の中の位置）, ord }）
  const oldInfo = new Map();
  const scanOld = (list, parent) => {
    const even = evenKeys(list.length);
    list.forEach((b, i) => {
      oldInfo.set(b.id, { b, parent, i, ord: isObj(ords) && typeof ords[b.id] === 'string' ? ords[b.id] : even[i] });
      scanOld(kidsOf(b), b.id);
    });
  };
  scanOld(Array.isArray(oldPage.blocks) ? oldPage.blocks.filter(isObj) : [], pid);
  const newIds = new Set();
  const scanNew = (list) => { for (const b of list) { newIds.add(b.id); scanNew(kidsOf(b)); } };
  scanNew(newBlocks);
  for (const [id, w] of oldInfo) if (!newIds.has(id)) ops.push({ op: 'trash', id, old: blockRow(w.b, pid, w.ord, w.parent) });
  const walkNew = (list, parent) => {
    const survivors = list.filter((b) => oldInfo.has(b.id) && oldInfo.get(b.id).parent === parent);
    const keep = stayingSet(survivors.map((b) => oldInfo.get(b.id).i));
    const stays = new Set([...keep].map((i) => survivors[i].id));
    let prevKey = null;
    let run = [];   // EK-2 直し（I1・R128）: 続けて足した・動かした行の鍵（2つ以上は keysBetween で等しい間に。1つは今どおり keyBetween）
    list.forEach((b, i) => {
      let key;
      if (stays.has(b.id)) key = oldInfo.get(b.id).ord;
      else if (run.length) key = run.shift();
      else {
        let next = null;
        let j = i + 1;
        for (; j < list.length; j++) if (stays.has(list[j].id)) { next = oldInfo.get(list[j].id).ord; break; }
        if (j - i > 1) { run = keysBetween(prevKey, next, j - i); key = run.shift(); }
        else key = keyBetween(prevKey, next);
      }
      prevKey = key;
      const was = oldInfo.get(b.id);
      if (!was) ops.push({ op: 'add', id: b.id, row: blockRow(b, pid, key, parent) });
      else {
        const a = was.b;
        if (str(a.text) !== str(b.text)) ops.push({ op: 'text', id: b.id, value: str(b.text), old: str(a.text) });
        if (a.type !== b.type) ops.push({ op: 'retype', id: b.id, value: b.type, old: a.type });
        ops.push(...setOps(b.id, a, b, BLOCK_FIXED, ['rich']));
        if (!stays.has(b.id)) ops.push({ op: 'move', id: b.id, ord: key, old: was.ord, ...(was.parent !== parent ? { parent, oldParent: was.parent } : {}) });
      }
      walkNew(kidsOf(b), b.id);
    });
  };
  walkNew(newBlocks, pid);
  return ops;
}

// diffSegments(oldSegs, newSegs, pageId) → ops（seg）。足した・消した・中身か並びの変わった発言だけ
function diffSegments(oldSegs, newSegs, pageId) {
  const olds = Array.isArray(oldSegs) ? oldSegs : [];
  const news = Array.isArray(newSegs) ? newSegs : [];
  const oldById = new Map(olds.map((s, i) => [s.id, { s, i }]));
  const newIds = new Set(news.map((s) => s.id));
  const ops = [];
  for (const [id, { s, i }] of oldById) if (!newIds.has(id)) ops.push({ op: 'seg', id, page: pageId, n: null, value: null, old: s, oldN: i });
  news.forEach((s, n) => {
    const was = oldById.get(s.id);
    if (!was) ops.push({ op: 'seg', id: s.id, page: pageId, n, value: s, old: null, oldN: null });
    else if (was.i !== n || !isDeepStrictEqual(was.s, s)) ops.push({ op: 'seg', id: s.id, page: pageId, n, value: s, old: was.s, oldN: was.i });
  });
  return ops;
}

// ---------------------------------------------------------------- 当てる
const ROW_COLS = 'id, type, page_id, parent_id, ord, text, rich, attrs, fold, rev, created_at, updated_at, trashed_at';

// 0.16.0 DS-2: データベースの行の列（親のデータベースのページの attrs.cols。無ければ空）
// cache（Map。1回の applyOps の中だけ）があれば同じデータベースの列を読み直さない（DS-3: 1万行の検索の欄を作り直すとき。列を書いたら捨てる）
function colsOfDb(db, dbId, cache) {
  if (cache && cache.has(dbId)) return cache.get(dbId);
  const out = colsRead(db, dbId);
  if (cache) cache.set(dbId, out);
  return out;
}
function colsRead(db, dbId) {
  const r = typeof dbId === 'string' ? db.prepare('select attrs from blocks where id = ? and type = ?').get(dbId, 'page') : null;
  const attrs = r ? JSON.parse(r.attrs || '{}') : {};
  return Array.isArray(attrs.cols) ? attrs.cols : [];
}

function insertRow(db, row, cache) {
  const attrs = isObj(row.attrs) ? row.attrs : {};
  const cols = row.type === 'row' ? colsOfDb(db, row.parent_id, cache) : null;
  db.prepare(`insert into blocks(${ROW_COLS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.type, row.page_id, row.parent_id ?? null, row.ord, str(row.text),
    Array.isArray(row.rich) ? JSON.stringify(row.rich) : null, JSON.stringify(attrs), foldOfRow(row.type, str(row.text), attrs, cols),
    Number.isSafeInteger(row.rev) ? row.rev : 1, str(row.created_at), str(row.updated_at), row.trashed_at ?? null);
}

function rowOf(db, id) {
  const r = db.prepare('select id, type, page_id, attrs from blocks where id = ?').get(id);
  if (!r) throw new Error('applyOps: 当てる行が無い');
  return r;
}

function upsertSeg(db, seg, pageId, n) {
  const r = segRow(seg, pageId, n);
  db.prepare(`insert into segments(page_id, id, n, at_ms, duration_ms, text, fold, failed, extra) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(page_id, id) do update set n = excluded.n, at_ms = excluded.at_ms, duration_ms = excluded.duration_ms,
    text = excluded.text, fold = excluded.fold, failed = excluded.failed, extra = excluded.extra`)
    .run(r.page_id, r.id, r.n, r.at_ms, r.duration_ms, r.text, r.fold, r.failed, r.extra);
}

// 0.16.0 DS-3（決めたこと 5）: データベースの行のセルの操作の鍵 cell:<列の ID>（ほかの人のほかの列の変更とぶつからない形: D6）
const CELL_KEY = 'cell:';
const cellColOf = (key) => (typeof key === 'string' && key.startsWith(CELL_KEY) && key.length > CELL_KEY.length ? key.slice(CELL_KEY.length) : null);
function setCellIn(attrs, colId, value) {
  const cells = isObj(attrs.cells) ? { ...attrs.cells } : {};
  if (value === undefined || value === null) delete cells[colId]; else cells[colId] = value;   // 空のセルは欄ごと消す（決めたこと 10）
  attrs.cells = cells;
}

function setField(db, row, key, value, st) {
  if (isDocType(row.type) && (key === 'createdAt' || key === 'updatedAt')) {
    const col = key === 'createdAt' ? 'created_at' : 'updated_at';
    db.prepare(`update blocks set ${col} = ? where id = ?`).run(str(value), row.id);
    return;
  }
  if (key === 'rich') {
    db.prepare('update blocks set rich = ? where id = ?').run(Array.isArray(value) ? JSON.stringify(value) : null, row.id);
    return;
  }
  const attrs = JSON.parse(row.attrs || '{}');
  const prevCols = attrs.cols;
  const cellKey = row.type === 'row' ? cellColOf(key) : null;
  if (cellKey !== null) setCellIn(attrs, cellKey, value);   // 0.16.0 DS-3（決めたこと 5）: セルは列ごとの set（cell:<列の ID>）。cells の中の1つだけを書く
  else if (value === undefined) delete attrs[key]; else attrs[key] = value;
  db.prepare('update blocks set attrs = ? where id = ?').run(JSON.stringify(attrs), row.id);
  if (row.type === 'page' && key === 'memo') st.refold.add(row.id);
  if (row.type === 'page' && key === 'cols') {   // 0.16.0 DS-3（R14）: 列（名前・選択肢・消した印・種類）が変われば、行の検索の欄を作り直す
    st.cols.delete(row.id);
    foldPlanAdd(st.refoldDb, row.id, prevCols, value);   // DS-3 直し（rv42 I3・R61）: 検索の欄に入る所が変わった列の値のある行だけ（名前・見せ方・入らない列の並びは作り直さない）
  }
  if (row.type === 'row') st.refold.add(row.id);   // 0.16.0 DS-2: データベースの行はセルが検索の欄に入る（決めたこと 6）
}

function applyOne(db, o, back, st) {
  if (!isObj(o) || typeof o.op !== 'string' || typeof o.id !== 'string') throw new Error('applyOps: 操作の形が正しくない');
  switch (o.op) {
    case 'add': {
      if (!back) { insertRow(db, o.row, st.cols); st.touched.add(o.row.page_id); if (isDocType(o.row.type)) st.fresh.add(o.row.id); return; }
      const r = rowOf(db, o.id);
      db.prepare('delete from blocks where id = ?').run(o.id);
      st.touched.add(r.page_id); if (isDocType(r.type)) st.fresh.add(r.id);
      return;
    }
    case 'trash':
    case 'restore': {
      if (o.op === 'trash' && isObj(o.old)) {   // ブロックの行を消す
        if (!back) { const r = rowOf(db, o.id); db.prepare('delete from blocks where id = ?').run(o.id); st.touched.add(r.page_id); }
        else { insertRow(db, o.old, st.cols); st.touched.add(o.old.page_id); }
        return;
      }
      const r = rowOf(db, o.id);
      const fwd = o.op === 'trash' ? (o.at ?? null) : null;
      db.prepare('update blocks set trashed_at = ? where id = ?').run(back ? (o.old ?? null) : fwd, o.id);
      st.touched.add(r.page_id);
      return;
    }
    case 'purge': {
      if (back) throw new Error('applyOps: purge は戻せない');
      db.prepare('delete from blocks where page_id = ?').run(o.id);
      db.prepare('delete from segments where page_id = ?').run(o.id);
      st.fresh.add(o.id);
      return;
    }
    case 'move': {
      const r = rowOf(db, o.id);
      db.prepare('update blocks set ord = ? where id = ?').run(back ? o.old : o.ord, o.id);
      // 0.13.1（決めたこと 7）: 親が変わった move は parent_id も（後ろへは前の親に）。0.15.0 PH-2（決めたこと 4）: ページの行を最上位へ出す
      // move は parent: null（前の親は oldParent）なので、欄があれば当てる（ブロックの行の move は今どおり文字の親だけを持つ）
      if (Object.hasOwn(o, 'parent')) db.prepare('update blocks set parent_id = ? where id = ?').run(back ? (o.oldParent ?? null) : (o.parent ?? null), o.id);
      st.touched.add(r.page_id);
      return;
    }
    case 'text': {
      const r = rowOf(db, o.id);
      db.prepare('update blocks set text = ? where id = ?').run(str(back ? o.old : o.value), o.id);
      st.touched.add(r.page_id); st.refold.add(o.id);
      return;
    }
    case 'retype': {
      const r = rowOf(db, o.id);
      db.prepare('update blocks set type = ? where id = ?').run(back ? o.old : o.value, o.id);
      st.touched.add(r.page_id); st.refold.add(o.id);
      return;
    }
    case 'set': {
      const r = rowOf(db, o.id);
      setField(db, r, o.key, back ? o.old : o.value, st);
      st.touched.add(r.page_id);
      return;
    }
    case 'seg': {
      const value = back ? o.old : o.value;
      const n = back ? o.oldN : o.n;
      if (value === null || value === undefined) db.prepare('delete from segments where page_id = ? and id = ?').run(o.page, o.id);
      else upsertSeg(db, value, o.page, n);
      st.touched.add(o.page);
      return;
    }
    default:
      throw new Error('applyOps: 知らない操作');
  }
}

// 0.16.0 DS-3 直し（rv42 I3・R61）: 行の検索の欄に入る列（決めたこと 6: テキスト・URL・メール・電話と、選択肢の名前）の形。列の書き込みの前と後で比べ、
// 入る列の並びが変われば全部の行（欄の並びが変わる）、入る列の種類・選択肢の名前・消した印が変われば、その列に値のある行だけを作り直す
const FOLD_TYPES = Object.freeze(['text', 'url', 'email', 'phone', 'select', 'multi', 'status']);
function foldShape(cols) {
  const out = new Map();
  for (const c of Array.isArray(cols) ? cols : []) {
    if (!isObj(c) || c.gone || !FOLD_TYPES.includes(c.type)) continue;
    out.set(c.id, JSON.stringify([c.type, Array.isArray(c.opts) ? c.opts.map((o) => (isObj(o) ? [o.id, o.name] : null)) : null]));
  }
  return out;
}
function foldPlanAdd(plans, dbId, before, after) {
  const a = foldShape(before), b = foldShape(after);
  const common = (x, y) => [...x.keys()].filter((k) => y.has(k));
  const plan = plans.get(dbId) || { all: false, cols: new Set() };
  if (common(a, b).join('\u0001') !== common(b, a).join('\u0001')) plan.all = true;
  for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) plan.cols.add(k);
  if (plan.all || plan.cols.size) plans.set(dbId, plan);
}
// 作り直す行の ID（全部か、どれかの列に値のある行）
function foldPlanRows(db, dbId, plan) {
  if (plan.all) return db.prepare("select id from blocks where type = 'row' and parent_id = ?").all(dbId);
  const cols = [...plan.cols].filter((c) => /^[A-Za-z0-9_-]{1,64}$/.test(c));
  if (!cols.length) return [];
  const where = cols.map(() => 'json_extract(attrs, ?) is not null').join(' or ');
  return db.prepare(`select id from blocks where type = 'row' and parent_id = ? and (${where})`).all(dbId, ...cols.map((c) => `$.cells."${c}"`));
}

function applyOps(db, ops, dir = 'forward') {
  if (!Array.isArray(ops)) throw new Error('applyOps: 操作の列が無い');
  if (dir !== 'forward' && dir !== 'backward') throw new Error('applyOps: 向きが正しくない');
  const back = dir === 'backward';
  const st = { touched: new Set(), fresh: new Set(), refold: new Set(), refoldDb: new Map(), cols: new Map() };
  for (const o of back ? [...ops].reverse() : ops) applyOne(db, o, back, st);
  for (const [dbId, plan] of st.refoldDb) for (const r of foldPlanRows(db, dbId, plan)) st.refold.add(r.id);
  for (const id of st.refold) {
    const r = db.prepare('select type, parent_id, text, attrs, fold from blocks where id = ?').get(id);
    if (!r) continue;
    const fold = foldOfRow(r.type, r.text, JSON.parse(r.attrs || '{}'), r.type === 'row' ? colsOfDb(db, r.parent_id, st.cols) : null);
    if (fold !== r.fold) db.prepare('update blocks set fold = ? where id = ?').run(fold, id);
  }
  for (const pid of st.touched) if (!st.fresh.has(pid)) db.prepare("update blocks set rev = rev + 1 where id = ? and type in ('page', 'row')").run(pid);
}

// ---------------------------------------------------------------- 元に戻す（0.14.0 EB-1。決めたこと 2〜5・R60。F100）
// 後ろへ当てる形を、前へ当てる新しい操作の列にする（新しい順に・値と前の値を入れ替え）。edit.revert の oplog の1行になり、もう一度
// 戻せばやり直し。ページの行の trash・restore・purge・発言（seg）・ページの行の add は戻さない（投げる）。
// pageId があれば、ページの行の set は memo・memoDoc だけを残す（summaryEdited・updatedAt・citeStat は戻さない: R60）
// ブロックの行の set のうち、短い行の印 citeSkip と見た目だけの欄（VIEW_KEYS。open）は戻さない（決めたこと 5・G1・R70。
// citeSkip は書くたびの markShortBlocks が関係の無い行にも付ける印で、戻した後の文から作り直す: edit.revert）
const REVERT_PAGE_KEYS = Object.freeze(['memo', 'memoDoc']);
// 0.15.0 PR-1（決めたこと 50）: 戻すページ（pageId を渡したときだけ）でない、ほかのページの行の操作か
const childPage = (o, pageId) => typeof pageId === 'string' && o.id !== pageId;
const NO_REVERT_BLOCK = Object.freeze(['citeSkip', ...VIEW_KEYS]);
function invertOps(ops, { pageId, dbId } = {}) {
  if (!Array.isArray(ops)) throw new Error('invertOps: 操作の列が無い');
  if (typeof dbId === 'string') return invertDbOps(ops, dbId);   // 0.16.0 DS-3（決めたこと 48）: データベースの歩み
  const out = [];
  for (const o of [...ops].reverse()) {
    if (!isObj(o) || typeof o.op !== 'string' || typeof o.id !== 'string') throw new Error('invertOps: 操作の形が正しくない');
    switch (o.op) {
      case 'add':
        // DS-2 直し（rv40 F1・R41）: データベースの行（row）の add も、dbId を渡さない呼び出しでは戻さない（戻すと本文の行を親の無い行にする: 決めたこと 48）
        if (!isObj(o.row) || isDocType(o.row.type)) throw new Error('invertOps: ページの行は戻さない');
        out.push({ op: 'trash', id: o.id, old: o.row });
        break;
      case 'trash':
        if (!isObj(o.old)) {
          // 0.15.0 PR-1（計画 docs/plans/2026-11-03-150.md の決めたこと 50）: 戻すページ（pageId）でないページの行（子ページの行を消して一緒にゴミ箱へ
          // 入れた子のページ）の trash は restore に入れ替える。pageId を渡さない呼び出しと、戻すページ自身の行は今どおり投げる
          if (!childPage(o, pageId) || typeof o.at !== 'string') throw new Error('invertOps: ページの行は戻さない');
          out.push({ op: 'restore', id: o.id, at: o.old ?? null, old: o.at });
          break;
        }
        out.push({ op: 'add', id: o.id, row: o.old });
        break;
      case 'restore':   // 0.15.0 PR-1（決めたこと 50）: 上の入れ替えを戻す（やり直し）。子のページの行だけ
        if (!childPage(o, pageId) || typeof o.old !== 'string') throw new Error('invertOps: ページの行は戻さない');
        out.push({ op: 'trash', id: o.id, at: o.old, old: o.at ?? null });
        break;
      case 'move':
        out.push({ op: 'move', id: o.id, ord: o.old, old: o.ord, ...(typeof o.parent === 'string' ? { parent: o.oldParent, oldParent: o.parent } : {}) });
        break;
      case 'set':
        if (o.id === pageId && !REVERT_PAGE_KEYS.includes(o.key)) break;
        if (o.id !== pageId && NO_REVERT_BLOCK.includes(o.key)) break;
        out.push({ op: 'set', id: o.id, key: o.key, value: o.old, old: o.value });
        break;
      case 'text':
      case 'retype':
        out.push({ op: o.op, id: o.id, value: o.old, old: o.value });
        break;
      default:
        throw new Error('invertOps: 戻せない操作');
    }
  }
  return out;
}

// opsMatch(db, ops) → 各操作の「後の値」が今の行と同じか（並べた操作を前から重ねた形と比べる）。
// 比べない欄: 見た目だけの欄（VIEW_KEYS。add の行の中の欄も: G1）・短い行の印 citeSkip・ページの行の印と時刻と出典の数（R60）
const NO_MATCH_VIEW = VIEW_KEYS;
const NO_MATCH_BLOCK = Object.freeze(['citeSkip']);
const NO_MATCH_PAGE = Object.freeze(['summaryEdited', 'updatedAt', 'citeStat']);
const skipKey = (isPage, key) => (isPage ? NO_MATCH_PAGE.includes(key) : NO_MATCH_VIEW.includes(key) || NO_MATCH_BLOCK.includes(key));
const PAGE_COLS = { createdAt: 'created_at', updatedAt: 'updated_at' };
// 0.15.0 PR-1（決めたこと 50）: 3つ目の引数 { pageId } があれば、そのページでないページの行の trash・restore（子のページ）の trashed_at が
// 歩みの後の値と同じかも見る（後からゴミ箱から戻した・消し直した子のページを古い歩みで変えない）。無ければ今どおり投げる
function opsMatch(db, ops, { pageId, dbId } = {}) {
  if (!Array.isArray(ops)) throw new Error('opsMatch: 操作の列が無い');
  if (typeof dbId === 'string') return dbOpsMatch(db, ops, dbId);   // 0.16.0 DS-3（決めたこと 48）: データベースの歩み
  const want = new Map();   // id → { gone } か { cols, attrs（add の行の全部の欄）か null, sets: Map }
  const at = (id) => {
    let w = want.get(id);
    if (!w || w.gone) { w = { gone: false, cols: {}, attrs: null, sets: new Map() }; want.set(id, w); }
    return w;
  };
  for (const o of ops) {
    if (!isObj(o) || typeof o.op !== 'string' || typeof o.id !== 'string') throw new Error('opsMatch: 操作の形が正しくない');
    switch (o.op) {
      case 'add': {
        if (!isObj(o.row) || isDocType(o.row.type)) throw new Error('opsMatch: ページの行は照らさない');
        const r = o.row;
        want.set(o.id, { gone: false, cols: { type: r.type, page_id: r.page_id, parent_id: r.parent_id ?? null, ord: r.ord, text: str(r.text), rich: Array.isArray(r.rich) ? r.rich : null },
          attrs: { ...(isObj(r.attrs) ? r.attrs : {}) }, sets: new Map() });
        break;
      }
      case 'trash':
        if (!isObj(o.old)) {
          if (!childPage(o, pageId)) throw new Error('opsMatch: ページの行は照らさない');
          at(o.id).cols.trashed_at = o.at ?? null;   // 子のページの行: ゴミ箱に入れた時刻のまま
          break;
        }
        want.set(o.id, { gone: true });
        break;
      case 'restore':
        if (!childPage(o, pageId)) throw new Error('opsMatch: ページの行は照らさない');
        at(o.id).cols.trashed_at = null;   // 子のページの行: 戻したまま
        break;
      case 'move': { const w = at(o.id); w.cols.ord = o.ord; if (typeof o.parent === 'string') w.cols.parent_id = o.parent; break; }
      case 'text': at(o.id).cols.text = str(o.value); break;
      case 'retype': at(o.id).cols.type = o.value; break;
      case 'set': {
        const w = at(o.id);
        if (o.key === 'rich') w.cols.rich = Array.isArray(o.value) ? o.value : null;
        else w.sets.set(o.key, o.value);
        break;
      }
      default:
        throw new Error('opsMatch: 照らせない操作');
    }
  }
  const read = db.prepare('select type, page_id, parent_id, ord, text, rich, attrs, created_at, updated_at, trashed_at from blocks where id = ?');
  for (const [id, w] of want) {
    const r = read.get(id);
    if (w.gone) { if (r) return false; continue; }
    // 0.14.0 MB-2 直し（R166）: 比べない欄（短い行の印 citeSkip・見た目だけの欄）だけを書いた行は、無くてもよい（戻すときに当てない欄なので、
    // 後から消えた・作り直された関係の無い要約の行のせいでメモの歩みを stale にしない: BQ22 (a)）
    if (!r) { if (!w.attrs && !Object.keys(w.cols).length && [...w.sets.keys()].every((k) => skipKey(false, k))) continue; return false; }
    const isPage = isDocType(r.type);   // DS-2 直し（rv40 F1・R41）: 行の作成日時・最終更新日時もページと同じ列（setField）。行の本文の歩みを戻せる
    const now = { type: r.type, page_id: r.page_id, parent_id: r.parent_id ?? null, ord: r.ord, text: str(r.text), rich: r.rich ? JSON.parse(r.rich) : null, trashed_at: r.trashed_at ?? null };
    for (const [k, v] of Object.entries(w.cols)) if (!isDeepStrictEqual(now[k], v)) return false;
    const attrs = JSON.parse(r.attrs || '{}');
    const expect = w.attrs ? { ...w.attrs } : null;
    for (const [k, v] of w.sets) {
      if (isPage && Object.hasOwn(PAGE_COLS, k)) {
        if (!skipKey(isPage, k) && str(r[PAGE_COLS[k]]) !== str(v)) return false;
        continue;
      }
      if (expect) { if (v === undefined) delete expect[k]; else expect[k] = v; continue; }
      if (!skipKey(isPage, k) && !isDeepStrictEqual(attrs[k], v)) return false;
    }
    if (expect) {
      const keys = new Set([...Object.keys(expect), ...Object.keys(attrs)]);
      for (const k of keys) if (!skipKey(isPage, k) && !isDeepStrictEqual(attrs[k], expect[k])) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------- 0.16.0 DS-3: データベースの歩みを戻す（計画 docs/plans/2026-11-04-160.md の決めたこと 47・48・R31）
// invertOps・opsMatch に { dbId } を渡したときだけ通る（渡さない呼び出しは上の 0.14.0・0.15.0 の決まりのまま）。データベースの命令の操作は、
// データベースの行（row）の add・ブロックとしての trash（足したのを戻す）・trash ⇄ restore（行のゴミ箱）・move・text（題名）・set（cell:<列>）と、
// データベースのページの set（cols）だけ。ID の列の次の番号 nextNo（消しても詰めない: 決めたこと 29）・ビュー（見た目の設定: 決めたこと 47）・
// 行の最終更新日時と更新者（戻すのも書き込みなので、edit.revert が今の時刻と自分で書き直す）は戻さず、照らさない
const DB_NO_REVERT = Object.freeze(['nextNo', 'views', 'updatedAt', 'by', 'seq']);   // seq: 振った列と選択肢の ID の数（使い直さない: R56）
// 0.16.0 DR-1: ［新しい行を作ってつなぐ］は相手のデータベースに行を足す（同じ歩み）ので、どのデータベースの行でも戻す（ページの行・本文の行は戻さない）
const isDbRow = (r) => isObj(r) && r.type === 'row' && typeof r.parent_id === 'string' && r.parent_id !== '';
function invertDbOps(ops, dbId) {
  const out = [];
  for (const o of [...ops].reverse()) {
    if (!isObj(o) || typeof o.op !== 'string' || typeof o.id !== 'string') throw new Error('invertOps: 操作の形が正しくない');
    switch (o.op) {
      case 'add':
        if (!isDbRow(o.row, dbId)) throw new Error('invertOps: データベースの行でない');
        out.push({ op: 'trash', id: o.id, old: o.row });
        break;
      case 'trash':
        if (isObj(o.old)) {
          if (!isDbRow(o.old, dbId)) throw new Error('invertOps: データベースの行でない');
          out.push({ op: 'add', id: o.id, row: o.old });   // 足した行を戻した歩み → やり直し
          break;
        }
        if (o.id === dbId || typeof o.at !== 'string') throw new Error('invertOps: データベースのページは戻さない');
        out.push({ op: 'restore', id: o.id, at: o.old ?? null, old: o.at });   // 行をゴミ箱へ入れた歩み → 戻す
        break;
      case 'restore':
        if (o.id === dbId || typeof o.old !== 'string') throw new Error('invertOps: データベースのページは戻さない');
        out.push({ op: 'trash', id: o.id, at: o.old, old: o.at ?? null });
        break;
      case 'move':
        out.push({ op: 'move', id: o.id, old: o.ord, ord: o.old, ...(Object.hasOwn(o, 'parent') ? { parent: o.oldParent ?? null, oldParent: o.parent ?? null } : {}) });
        break;
      case 'set':
        if (DB_NO_REVERT.includes(o.key)) break;
        out.push({ op: 'set', id: o.id, key: o.key, value: o.old, old: o.value });
        break;
      case 'text':
        out.push({ op: 'text', id: o.id, value: o.old, old: o.value });
        break;
      default:
        throw new Error('invertOps: 戻せない操作');
    }
  }
  return out;
}
// 各操作の「後の値」が今の表と同じか（行のセルは cells の中の1つずつ、足した行は題名・並び・セル・番号の全部、行のゴミ箱は trashed_at）
function dbOpsMatch(db, ops, dbId) {
  const want = new Map();   // id → { gone } か { cols, cells（足した行なら全部の写し）か null, cell: Map, sets: Map }
  const at = (id) => {
    let w = want.get(id);
    if (!w || w.gone) { w = { gone: false, cols: {}, cells: null, cell: new Map(), sets: new Map() }; want.set(id, w); }
    return w;
  };
  for (const o of ops) {
    if (!isObj(o) || typeof o.op !== 'string' || typeof o.id !== 'string') throw new Error('opsMatch: 操作の形が正しくない');
    switch (o.op) {
      case 'add': {
        if (!isDbRow(o.row, dbId)) throw new Error('opsMatch: データベースの行でない');
        const r = o.row;
        const attrs = isObj(r.attrs) ? r.attrs : {};
        want.set(o.id, { gone: false, cols: { type: r.type, parent_id: r.parent_id, ord: r.ord, text: str(r.text), trashed_at: r.trashed_at ?? null },
          cells: { ...(isObj(attrs.cells) ? attrs.cells : {}) }, cell: new Map(), sets: new Map([['no', attrs.no]]) });
        break;
      }
      case 'trash':
        if (isObj(o.old)) { want.set(o.id, { gone: true }); break; }
        if (o.id === dbId) throw new Error('opsMatch: データベースのページは照らさない');
        at(o.id).cols.trashed_at = o.at ?? null;
        break;
      case 'restore':
        if (o.id === dbId) throw new Error('opsMatch: データベースのページは照らさない');
        at(o.id).cols.trashed_at = null;
        break;
      case 'move': { const w = at(o.id); w.cols.ord = o.ord; if (Object.hasOwn(o, 'parent')) w.cols.parent_id = o.parent ?? null; break; }
      case 'text': at(o.id).cols.text = str(o.value); break;
      case 'set': {
        if (DB_NO_REVERT.includes(o.key)) break;
        const w = at(o.id);
        const c = cellColOf(o.key);
        if (c !== null && w.cells) { if (o.value === undefined || o.value === null) delete w.cells[c]; else w.cells[c] = o.value; }
        else if (c !== null) w.cell.set(c, o.value ?? undefined);
        else w.sets.set(o.key, o.value);
        break;
      }
      default:
        throw new Error('opsMatch: 照らせない操作');
    }
  }
  const read = db.prepare('select type, parent_id, ord, text, attrs, trashed_at from blocks where id = ?');
  for (const [id, w] of want) {
    const r = read.get(id);
    if (w.gone) { if (r) return false; continue; }
    if (!r) return false;
    const now = { type: r.type, parent_id: r.parent_id ?? null, ord: r.ord, text: str(r.text), trashed_at: r.trashed_at ?? null };
    for (const [k, v] of Object.entries(w.cols)) if (!isDeepStrictEqual(now[k], v)) return false;
    const attrs = JSON.parse(r.attrs || '{}');
    const cells = isObj(attrs.cells) ? attrs.cells : {};
    if (w.cells && !isDeepStrictEqual(cells, w.cells)) return false;
    for (const [c, v] of w.cell) if (!isDeepStrictEqual(cells[c], v)) return false;
    for (const [k, v] of w.sets) if (!isDeepStrictEqual(attrs[k], v)) return false;
  }
  return true;
}

module.exports = { diffPage, diffSegments, applyOps, invertOps, opsMatch, pageRow, blockRow, rowBlock, segRow, pageFold, textFold, foldOfRow, isDocType };
