/*
 * ops.js — 操作の列 oplog の操作を作る（diffPage・diffSegments）・当てる（applyOps）（第2a1回 T4b。純粋。node:sqlite の接続は引数）
 *
 * 1つの命令 = oplog の1行 = 操作の配列。どの操作も前の値を持つので、後ろへ当てれば元に戻せる（第2b回の「元に戻す」）。
 * 控えに後の oplog を前へ当て直せば今の表になる（D-7）。操作の形（どれも id は blocks の行の id。seg だけ発言の id）:
 *   { op: 'add', id, row }                ブロックかページの行を足す（row は下の blockRow・pageRow の形）。後ろへは消す
 *   { op: 'move', id, ord, old }          並びの鍵を変える（鍵は同じ親の兄弟の中の並び: 0.13.1 NR1）
 *   { op: 'move', id, ord, old, parent, oldParent }  親も変える（0.13.1 決めたこと 7。親が変わったときだけ parent・oldParent を持つ。
 *                                         後ろへ当てれば前の親と鍵に戻る。子は親の ID を指したままなので書かない）
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

const PAGE_FIXED = ['id', 'title', 'blocks', 'createdAt', 'updatedAt', 'children', 'type', 'text', 'rich'];
const DB_MADE = ['rev', 'routeText', 'qualityView'];     // DB が作る欄（書くときは黙って捨てる）。0.11.0 Q-3 で qualityView を足した
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

// parentId は親の行の ID（最上位はページの ID。0.13.1 決めたこと 7: 子は parent_id と兄弟の中の鍵 ord を持つ）
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
      // 0.13.1（決めたこと 7）: 親が変わった move は parent_id も（後ろへは前の親に）
      if (typeof o.parent === 'string') db.prepare('update blocks set parent_id = ? where id = ?').run(back ? o.oldParent : o.parent, o.id);
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

// ---------------------------------------------------------------- 元に戻す（0.14.0 EB-1。決めたこと 2〜5・R60。F100）
// 後ろへ当てる形を、前へ当てる新しい操作の列にする（新しい順に・値と前の値を入れ替え）。edit.revert の oplog の1行になり、もう一度
// 戻せばやり直し。ページの行の trash・restore・purge・発言（seg）・ページの行の add は戻さない（投げる）。
// pageId があれば、ページの行の set は memo・memoDoc だけを残す（summaryEdited・updatedAt・citeStat は戻さない: R60）
// ブロックの行の set のうち、短い行の印 citeSkip と見た目だけの欄（VIEW_KEYS。open）は戻さない（決めたこと 5・G1・R70。
// citeSkip は書くたびの markShortBlocks が関係の無い行にも付ける印で、戻した後の文から作り直す: edit.revert）
const REVERT_PAGE_KEYS = Object.freeze(['memo', 'memoDoc']);
const NO_REVERT_BLOCK = Object.freeze(['citeSkip', ...VIEW_KEYS]);
function invertOps(ops, { pageId } = {}) {
  if (!Array.isArray(ops)) throw new Error('invertOps: 操作の列が無い');
  const out = [];
  for (const o of [...ops].reverse()) {
    if (!isObj(o) || typeof o.op !== 'string' || typeof o.id !== 'string') throw new Error('invertOps: 操作の形が正しくない');
    switch (o.op) {
      case 'add':
        if (!isObj(o.row) || o.row.type === 'page') throw new Error('invertOps: ページの行は戻さない');
        out.push({ op: 'trash', id: o.id, old: o.row });
        break;
      case 'trash':
        if (!isObj(o.old)) throw new Error('invertOps: ページの行は戻さない');
        out.push({ op: 'add', id: o.id, row: o.old });
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
function opsMatch(db, ops) {
  if (!Array.isArray(ops)) throw new Error('opsMatch: 操作の列が無い');
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
        if (!isObj(o.row) || o.row.type === 'page') throw new Error('opsMatch: ページの行は照らさない');
        const r = o.row;
        want.set(o.id, { gone: false, cols: { type: r.type, page_id: r.page_id, parent_id: r.parent_id ?? null, ord: r.ord, text: str(r.text), rich: Array.isArray(r.rich) ? r.rich : null },
          attrs: { ...(isObj(r.attrs) ? r.attrs : {}) }, sets: new Map() });
        break;
      }
      case 'trash':
        if (!isObj(o.old)) throw new Error('opsMatch: ページの行は照らさない');
        want.set(o.id, { gone: true });
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
  const read = db.prepare('select type, page_id, parent_id, ord, text, rich, attrs, created_at, updated_at from blocks where id = ?');
  for (const [id, w] of want) {
    const r = read.get(id);
    if (w.gone) { if (r) return false; continue; }
    if (!r) return false;
    const isPage = r.type === 'page';
    const now = { type: r.type, page_id: r.page_id, parent_id: r.parent_id ?? null, ord: r.ord, text: str(r.text), rich: r.rich ? JSON.parse(r.rich) : null };
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

module.exports = { diffPage, diffSegments, applyOps, invertOps, opsMatch, pageRow, blockRow, segRow, pageFold, textFold, foldOfRow };
