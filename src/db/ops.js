/*
 * ops.js — 操作の列 oplog の操作を作る（diffPage・diffSegments）・当てる（applyOps）（第2a1回 T4b。純粋。node:sqlite の接続は引数）
 *
 * 1つの命令 = oplog の1行 = 操作の配列。どの操作も前の値を持つので、後ろへ当てれば元に戻せる（第2b回の「元に戻す」）。
 * 控えに後の oplog を前へ当て直せば今の表になる（D-7）。操作の形（どれも id は blocks の行の id。seg だけ発言の id）:
 *   { op: 'add', id, row }                ブロックかページの行を足す（row は下の blockRow・pageRow の形）。後ろへは消す
 *   { op: 'move', id, ord, old }          並びの鍵を変える
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
 */
'use strict';

const { isDeepStrictEqual } = require('node:util');
const { searchFold } = require('../cite');
const { evenKeys, keyBetween } = require('./keys');

const PAGE_FIXED = ['id', 'title', 'blocks', 'createdAt', 'updatedAt', 'children', 'type', 'text', 'rich'];
const DB_MADE = ['rev', 'routeText'];     // DB が作る欄（書くときは黙って捨てる）
const BLOCK_FIXED = ['id', 'type', 'text', 'rich', 'children'];
const SEG_FIXED = ['id', 'atMs', 'durationMs', 'text', 'failed'];
const PAGE_ORD = 'i';                     // ページの行の並びの鍵（2a1 では使わない。第5回の子のページで使う）

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');

// ---------------------------------------------------------------- 検索の欄
function pageFold(title, memo) { return searchFold(title) + '\u0001' + searchFold(memo); }
function textFold(text) { return searchFold(text); }
function foldOfRow(type, text, attrs) {
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

function blockRow(b, pageId, ord) {
  return {
    id: b.id, type: b.type, page_id: pageId, parent_id: pageId, ord,
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
// ords は前のブロックの id → 並びの鍵（DB の今の値）。無ければ前の並びに evenKeys を当てたものとみなす
function diffPage(oldPage, newPage, { ords } = {}) {
  if (!isObj(newPage) || typeof newPage.id !== 'string') throw new Error('diffPage: 新しいページの形が正しくない');
  const pid = newPage.id;
  const newBlocks = Array.isArray(newPage.blocks) ? newPage.blocks : [];
  if (!oldPage) {
    const keys = evenKeys(newBlocks.length);
    return [{ op: 'add', id: pid, row: pageRow(newPage) }, ...newBlocks.map((b, i) => ({ op: 'add', id: b.id, row: blockRow(b, pid, keys[i]) }))];
  }
  const ops = [];
  // ページの行
  if (str(oldPage.title) !== str(newPage.title)) ops.push({ op: 'text', id: pid, value: str(newPage.title), old: str(oldPage.title) });
  ops.push(...setOps(pid, pick(oldPage, DB_MADE), pick(newPage, DB_MADE), PAGE_FIXED, ['createdAt', 'updatedAt']));
  // ブロック
  const oldBlocks = Array.isArray(oldPage.blocks) ? oldPage.blocks : [];
  const even = evenKeys(oldBlocks.length);
  const oldOrd = new Map(oldBlocks.map((b, i) => [b.id, isObj(ords) && typeof ords[b.id] === 'string' ? ords[b.id] : even[i]]));
  const oldById = new Map(oldBlocks.map((b, i) => [b.id, { b, i }]));
  const newIds = new Set(newBlocks.map((b) => b.id));
  for (const b of oldBlocks) if (!newIds.has(b.id)) ops.push({ op: 'trash', id: b.id, old: blockRow(b, pid, oldOrd.get(b.id)) });
  const survivors = newBlocks.filter((b) => oldById.has(b.id));
  const keep = stayingSet(survivors.map((b) => oldById.get(b.id).i));
  const stays = new Set([...keep].map((i) => survivors[i].id));
  let prevKey = null;
  newBlocks.forEach((b, i) => {
    let key;
    if (stays.has(b.id)) key = oldOrd.get(b.id);
    else {
      let next = null;
      for (let j = i + 1; j < newBlocks.length; j++) if (stays.has(newBlocks[j].id)) { next = oldOrd.get(newBlocks[j].id); break; }
      key = keyBetween(prevKey, next);
    }
    prevKey = key;
    const was = oldById.get(b.id);
    if (!was) { ops.push({ op: 'add', id: b.id, row: blockRow(b, pid, key) }); return; }
    const a = was.b;
    if (str(a.text) !== str(b.text)) ops.push({ op: 'text', id: b.id, value: str(b.text), old: str(a.text) });
    if (a.type !== b.type) ops.push({ op: 'retype', id: b.id, value: b.type, old: a.type });
    ops.push(...setOps(b.id, a, b, BLOCK_FIXED, ['rich']));
    if (!stays.has(b.id)) ops.push({ op: 'move', id: b.id, ord: key, old: oldOrd.get(b.id) });
  });
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

function insertRow(db, row) {
  const attrs = isObj(row.attrs) ? row.attrs : {};
  db.prepare(`insert into blocks(${ROW_COLS}) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.id, row.type, row.page_id, row.parent_id ?? null, row.ord, str(row.text),
    Array.isArray(row.rich) ? JSON.stringify(row.rich) : null, JSON.stringify(attrs), foldOfRow(row.type, str(row.text), attrs),
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

function setField(db, row, key, value, st) {
  if (row.type === 'page' && (key === 'createdAt' || key === 'updatedAt')) {
    const col = key === 'createdAt' ? 'created_at' : 'updated_at';
    db.prepare(`update blocks set ${col} = ? where id = ?`).run(str(value), row.id);
    return;
  }
  if (key === 'rich') {
    db.prepare('update blocks set rich = ? where id = ?').run(Array.isArray(value) ? JSON.stringify(value) : null, row.id);
    return;
  }
  const attrs = JSON.parse(row.attrs || '{}');
  if (value === undefined) delete attrs[key]; else attrs[key] = value;
  db.prepare('update blocks set attrs = ? where id = ?').run(JSON.stringify(attrs), row.id);
  if (row.type === 'page' && key === 'memo') st.refold.add(row.id);
}

function applyOne(db, o, back, st) {
  if (!isObj(o) || typeof o.op !== 'string' || typeof o.id !== 'string') throw new Error('applyOps: 操作の形が正しくない');
  switch (o.op) {
    case 'add': {
      if (!back) { insertRow(db, o.row); st.touched.add(o.row.page_id); if (o.row.type === 'page') st.fresh.add(o.row.id); return; }
      const r = rowOf(db, o.id);
      db.prepare('delete from blocks where id = ?').run(o.id);
      st.touched.add(r.page_id); if (r.type === 'page') st.fresh.add(r.id);
      return;
    }
    case 'trash':
    case 'restore': {
      if (o.op === 'trash' && isObj(o.old)) {   // ブロックの行を消す
        if (!back) { const r = rowOf(db, o.id); db.prepare('delete from blocks where id = ?').run(o.id); st.touched.add(r.page_id); }
        else { insertRow(db, o.old); st.touched.add(o.old.page_id); }
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

function applyOps(db, ops, dir = 'forward') {
  if (!Array.isArray(ops)) throw new Error('applyOps: 操作の列が無い');
  if (dir !== 'forward' && dir !== 'backward') throw new Error('applyOps: 向きが正しくない');
  const back = dir === 'backward';
  const st = { touched: new Set(), fresh: new Set(), refold: new Set() };
  for (const o of back ? [...ops].reverse() : ops) applyOne(db, o, back, st);
  for (const id of st.refold) {
    const r = db.prepare('select type, text, attrs, fold from blocks where id = ?').get(id);
    if (!r) continue;
    const fold = foldOfRow(r.type, r.text, JSON.parse(r.attrs || '{}'));
    if (fold !== r.fold) db.prepare('update blocks set fold = ? where id = ?').run(fold, id);
  }
  for (const pid of st.touched) if (!st.fresh.has(pid)) db.prepare("update blocks set rev = rev + 1 where id = ? and type = 'page'").run(pid);
}

module.exports = { diffPage, diffSegments, applyOps, pageRow, blockRow, segRow, pageFold, textFold, foldOfRow };
