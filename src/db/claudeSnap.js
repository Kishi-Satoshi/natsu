/*
 * claudeSnap.js — Claude の変更の控え（page_snapshot の body）の中身と、控えから戻す形（0.18.0 CW-1。計画 docs/plans/2026-11-18-180.md の
 * 決めたこと 10・12・F233・F234。純粋。DB を読まない）
 *
 * snapOf(page, segments, { segIds, row }) → body（JSON にして page_snapshot.body に書く物）
 *   議事録: { blocks, memoDoc?, attrs: { 控えの欄（SNAP_ATTRS のうちページにある物） }, segs: [{ id, text }]（segIds の発言だけ） }
 *   白紙のページ（とデータベースのページ）: { blocks }
 *   データベースの行のページ（row: true）: { title, cells, blocks }
 *   page は DB に書いてある形（commands の loadPage の page）。全部の文字起こしは写さない（名前の直しで変える発言の文だけ）
 * restoreOf(nowPage, nowSegs, body, cols) → { page, segments }（diffPage・diffSegments に渡す。nowPage・nowSegs は変えない）
 *   戻すのは控えにある欄だけ。親・並び・ゴミ箱・アイコン・見た目・ロック・データベースの列とビュー・議事録の題名は今のまま（行の題名は控えにあれば戻す）。
 *   本文の子ページの行（subpage）は今の行のまま: 控えに無い今の子ページの行は戻した本文の最後に残し、今は無い子ページの行は戻さない
 *   （木の正本は parent_id: 0.15.0 の HR17）。セルは cols（今の列）が配列なら、今の生きている列のセルだけを控えの値にする
 *   （控えに無ければ空にする・今の列に無い列と消した列のセルは今のまま書かない）
 * segsFrom(bodies) → [{ id, text }]（戻す控えとそれより新しい控えの body の古い順。発言ごとに、いちばん古い控えの文＝戻す時点の文。CR36）
 * SNAP_KEEP … ページごとに残す控えの数（設計書 Q5「ページごとに直近10回分」）。WHATS … 道具の印と画面の言葉（「画面の文」）
 */
'use strict';

const SNAP_KEEP = 10;
const WHATS = Object.freeze({ summary: '要約を書き戻した', names: '名前を直した', action: 'ToDo を更新した', task: 'ToDo をタスクにした', append: '本文に書き足した', row: '行を直した' });
// 議事録のページの欄のうち、Claude の命令が変えうるもの（決めたこと 10。memo は memoDoc から作る素の文字のメモ: 一緒に戻す。CR35）
const SNAP_ATTRS = Object.freeze(['meetingType', 'typeAuto', 'route', 'quality', 'summaryEdited', 'summaryWait', 'summaryError', 'citeStat', 'actionStat', 'cells', 'memo']);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const blocksOf = (v) => (Array.isArray(v) ? v.filter(isObj) : []);
const isMeeting = (page) => page.kind === undefined;

function snapOf(page, segments, { segIds = [], row = false } = {}) {
  const blocks = clone(blocksOf(page.blocks));
  if (row) return { title: typeof page.title === 'string' ? page.title : '', cells: isObj(page.cells) ? clone(page.cells) : {}, blocks };
  if (!isMeeting(page)) return { blocks };
  const attrs = {};
  for (const k of SNAP_ATTRS) if (Object.hasOwn(page, k) && page[k] !== undefined) attrs[k] = clone(page[k]);
  const want = new Set(segIds);
  const segs = (Array.isArray(segments) ? segments : []).filter((s) => isObj(s) && want.has(s.id)).map((s) => ({ id: s.id, text: String(s.text ?? '') }));
  const out = { blocks, attrs, segs };
  if (page.memoDoc !== undefined) out.memoDoc = clone(page.memoDoc);
  return out;
}

// 本文の子ページの行（今の行）を残す形にする
const isSub = (b) => isObj(b) && b.type === 'subpage' && typeof b.page === 'string';
const kidsOf = (b) => blocksOf(b.children);
function keepSubRows(nowBlocks, backBlocks) {
  const nowSubs = [];
  const walk = (list) => { for (const b of blocksOf(list)) { if (isSub(b)) nowSubs.push(b); walk(kidsOf(b)); } };
  walk(nowBlocks);
  const byPage = new Map(nowSubs.map((b) => [b.page, b]));
  const used = new Set();
  const fix = (list) => blocksOf(list).flatMap((b) => {
    if (isSub(b)) {
      const cur = byPage.get(b.page);
      if (!cur || used.has(b.page)) return [];   // 今は無い（動かした・ゴミ箱の）子ページの行は戻さない
      used.add(b.page);
      return [clone(cur)];
    }
    return [{ ...b, children: fix(b.children) }];
  });
  const out = fix(backBlocks);
  for (const b of nowSubs) if (!used.has(b.page)) out.push(clone(b));   // 控えに無い子ページの行は本文の最後に残す
  return out;
}

// セル: 今の生きている列のセルだけを控えの値にする（今の列に無いセルは書かない）
function cellsBack(nowCells, backCells, cols) {
  const out = isObj(nowCells) ? clone(nowCells) : {};
  const back = isObj(backCells) ? backCells : {};
  for (const c of Array.isArray(cols) ? cols : []) {
    if (!isObj(c) || c.gone || typeof c.id !== 'string' || c.type === 'title') continue;
    if (Object.hasOwn(back, c.id)) out[c.id] = clone(back[c.id]); else delete out[c.id];
  }
  return out;
}

function restoreOf(nowPage, nowSegs, body, cols) {
  const page = clone(nowPage);
  const b = isObj(body) ? body : {};
  page.blocks = keepSubRows(blocksOf(nowPage.blocks), blocksOf(b.blocks));
  let segments = (Array.isArray(nowSegs) ? nowSegs : []).map((s) => clone(s));
  if (typeof b.title === 'string') page.title = b.title;   // 行の題名（行の「名前」のセル）。議事録の控えに題名は無い
  if (Object.hasOwn(b, 'cells') && isObj(b.cells)) {
    const c = cellsBack(nowPage.cells, b.cells, cols);
    if (Object.keys(c).length) page.cells = c; else delete page.cells;
  }
  if (isObj(b.attrs)) {
    for (const k of SNAP_ATTRS) {
      if (k === 'cells' && Array.isArray(cols)) {
        const c = cellsBack(nowPage.cells, b.attrs.cells, cols);
        if (Object.keys(c).length) page.cells = c; else delete page.cells;
      } else if (Object.hasOwn(b.attrs, k)) page[k] = clone(b.attrs[k]);
      else delete page[k];
    }
    if (Object.hasOwn(b, 'memoDoc')) page.memoDoc = clone(b.memoDoc); else delete page.memoDoc;
  }
  if (Array.isArray(b.segs)) {
    const back = new Map(b.segs.filter(isObj).map((s) => [s.id, String(s.text ?? '')]));
    segments = segments.map((s) => (back.has(s.id) ? { ...s, text: back.get(s.id) } : s));
  }
  return { page, segments };
}

// 戻す控えより新しい Claude の書き込みが直した発言も、戻す時点の文に戻す（控えの segs はその書き込みが直す発言だけなので、新しい控えの segs も合わせる。
// 同じ発言はいちばん古い控えの文: その時点より後の最初の直しの前の文）
function segsFrom(bodies) {
  const out = new Map();
  for (const b of Array.isArray(bodies) ? bodies : []) {
    for (const s of isObj(b) && Array.isArray(b.segs) ? b.segs : []) if (isObj(s) && typeof s.id === 'string' && !out.has(s.id)) out.set(s.id, String(s.text ?? ''));
  }
  return [...out].map(([id, text]) => ({ id, text }));
}

module.exports = { SNAP_KEEP, WHATS, SNAP_ATTRS, snapOf, restoreOf, segsFrom };
