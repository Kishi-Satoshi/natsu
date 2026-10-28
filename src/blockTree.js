'use strict';
// 要約のブロックの木の純粋な部品（0.13.1 Task NE-1。計画 docs/plans/2026-10-27-131.md の決めたこと 3・4・7〜9・12〜16・19・23）。
// 何も読まない（型の表は src/blockEdit.js だけを読む）。DB（src/db/commands.js）・読み手（pagerules・MCP）・画面の写し（app.html）が使う。
// 木の形: page.blocks は最上位の行の並びで、子は children（設計書「保存の形」）。DB は子が parent_id と兄弟の中の鍵 ord を持つ（NR1）。
// 平らにした並び（flattenBlocks）は写しでなく同じ物を指す（出典を付け直す cite.js の refreshCitations が木の行に書けるように: F48）。
const blockEdit = require('./blockEdit');

// 見た目だけの欄（NR4）。書くのは block.setOpen・block.setOpenAll だけ（0.14.0 の元に戻すの照らしはこの欄を比べない）
const VIEW_KEYS = Object.freeze(['open']);

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const kidsOf = (b) => (isObj(b) && Array.isArray(b.children) ? b.children : []);

// トグルかトグル見出しか（開け閉めのある行）
function isToggle(b) {
  return isObj(b) && (b.type === 'toggle' || (b.type === 'heading' && b.toggle === true));
}
// 保存した開け閉め（TQ4: open の無いトグルは開いている。トグルでない行はいつも開いている）
function isOpenStored(b) {
  return !isToggle(b) || b.open !== false;
}
// 子を持てる型か（型の表の「子を持てる」。トグルでない見出しと区切り線は持てない。知らない型はテキストの見た目なので持てる）
function kidsCan(b) {
  return blockEdit.typeOf(b).kids === true;
}
// AI の節の見出し（citeState の無い見出し。トグル見出しにしても: 2026-10-28 の点検 A）。TQ2: 子にしない（人が足した見出しは citeState: 'manual'）
function aiSectionHead(b) {
  return isObj(b) && b.type === 'heading' && b.citeState === undefined;
}

// ---------------------------------------------------------------- 組み立てと平らにする
// rows: [{ id, parent_id, block }] を ord の順（DB の pageBlocks の順）。block に children を付けて木にする → { blocks, orphans }。
// 親が無い・親がページの外・親をたどると輪になる行は、捨てずに最上位の末尾に ord の順で並べる（NR2。文は消えない）
function buildTree(rows, pageId) {
  const list = Array.isArray(rows) ? rows.filter((r) => isObj(r) && isObj(r.block)) : [];
  const byId = new Map(list.map((r) => [r.id, r]));
  // 輪の中の行（たどると自分に戻る）を見つける
  const state = new Map();   // id → 1（たどっている途中）・2（済み）
  const inLoop = new Set();
  for (const r of list) {
    if (state.has(r.id)) continue;
    const path = [];
    let cur = r;
    while (cur && !state.has(cur.id)) {
      state.set(cur.id, 1); path.push(cur.id);
      cur = cur.parent_id !== pageId ? byId.get(cur.parent_id) : null;
    }
    if (cur && state.get(cur.id) === 1) for (const id of path.slice(path.indexOf(cur.id))) inLoop.add(id);
    for (const id of path) state.set(id, 2);
  }
  const blocks = [];
  const late = [];
  for (const r of list) r.block.children = [];
  for (const r of list) {
    const parent = r.parent_id === pageId ? null : byId.get(r.parent_id);
    if (r.parent_id === pageId) blocks.push(r.block);
    else if (!parent || inLoop.has(r.id)) late.push(r.block);
    else parent.block.children.push(r.block);
  }
  return { blocks: [...blocks, ...late], orphans: late.length };
}

// 深さ優先（親の後に子）の同じ物の並び（F48: 写しにしない）
function flattenBlocks(blocks) {
  const out = [];
  const go = (list) => { for (const b of Array.isArray(list) ? list : []) { if (!isObj(b)) continue; out.push(b); go(b.children); } };
  go(blocks);
  return out;
}
// → [{ b, depth, parentId（最上位は null）, list, index }]（深さ優先）
function walk(blocks) {
  const out = [];
  const go = (list, depth, parentId) => {
    if (!Array.isArray(list)) return;
    list.forEach((b, index) => {
      if (!isObj(b)) return;
      out.push({ b, depth, parentId, list, index });
      go(b.children, depth + 1, b.id);
    });
  };
  go(blocks, 0, null);
  return out;
}
// id の行の居場所 → { b, list, index, parent（最上位は null）, depth } か null
function locate(blocks, id) {
  const go = (list, parent, depth) => {
    if (!Array.isArray(list)) return null;
    for (let index = 0; index < list.length; index++) {
      const b = list[index];
      if (!isObj(b)) continue;
      if (b.id === id) return { b, list, index, parent, depth };
      const r = go(b.children, b, depth + 1);
      if (r) return r;
    }
    return null;
  };
  return go(blocks, null, 0);
}
// b の子孫（自分を含む）に id があるか
function within(b, id) {
  return flattenBlocks([b]).some((x) => x.id === id);
}

// ---------------------------------------------------------------- 字下げ（E10・EQ17 (a)・TQ2）
// 前の兄弟がいない・前の兄弟が子を持てない型・AI の節の見出し → できない
function canIndent(blocks, id) {
  const l = locate(blocks, id);
  if (!l || l.index === 0) return false;
  if (aiSectionHead(l.b)) return false;
  return kidsCan(l.list[l.index - 1]);
}
// in: 前の兄弟の子の末尾へ・out: 親のすぐ後ろへ（親の後ろの兄弟は付いてこない）→ { parentId（最上位は null）, afterId } か null
function indentPlan(blocks, id, dir) {
  const l = locate(blocks, id);
  if (!l) return null;
  if (dir === 'in') {
    if (!canIndent(blocks, id)) return null;
    const prev = l.list[l.index - 1];
    const kids = kidsOf(prev);
    return { parentId: prev.id, afterId: kids.length ? kids[kids.length - 1].id : '' };
  }
  if (dir === 'out') {
    if (!l.parent) return null;
    const up = locate(blocks, l.parent.id);
    return { parentId: up.parent ? up.parent.id : null, afterId: l.parent.id };
  }
  return null;
}

// ---------------------------------------------------------------- 置き場（NR6。足す・動かす・複製・行頭の Enter で共通）
// afterId が行なら「その行と同じ親の、その行のすぐ後ろ」（parentId を添えたら同じ親でなければ null）。
// afterId が '' なら「parentId の子の頭」（parentId が無ければ最上位の頭。parentId の行が子を持てなければ null）→ { list, index, parent } か null
function spotOf(blocks, afterId, parentId) {
  if (afterId) {
    const l = locate(blocks, afterId);
    if (!l) return null;
    if (parentId !== undefined && parentId !== null && (!l.parent || l.parent.id !== parentId)) return null;
    return { list: l.list, index: l.index + 1, parent: l.parent };
  }
  if (parentId === undefined || parentId === null) return { list: blocks, index: 0, parent: null };
  const p = locate(blocks, parentId);
  if (!p || !kidsCan(p.b)) return null;
  if (!Array.isArray(p.b.children)) p.b.children = [];
  return { list: p.b.children, index: 0, parent: p.b };
}

// ---------------------------------------------------------------- 見える順・番号
// 閉じたトグルの子孫を飛ばした見える順 → [{ b, depth, parentId }]。openView(b) は見えている開け閉め（画面は覗き開きも: NR18）
function visibleOrder(blocks, openView = isOpenStored) {
  const out = [];
  const go = (list, depth, parentId) => {
    for (const b of Array.isArray(list) ? list : []) {
      if (!isObj(b)) continue;
      out.push({ b, depth, parentId });
      if (openView(b)) go(b.children, depth + 1, b.id);
    }
  };
  go(blocks, 0, null);
  return out;
}
// 親ごとに番号付きを数える → Map(id → '1.')（F50）
function numberLabelsTree(blocks) {
  const out = new Map();
  const go = (list) => {
    if (!Array.isArray(list)) return;
    for (const [k, v] of blockEdit.numberLabels(list)) out.set(k, v);
    for (const b of list) if (isObj(b)) go(b.children);
  };
  go(blocks);
  return out;
}

// ---------------------------------------------------------------- 結合と変換の子（EQ6 (a)・EQ16 (a)・NR10）
// 結合で消す行の子 kids を、つないだ先 target（locate の答え）の子の末尾へ。target が子を持てない型なら、target のすぐ後ろに兄弟として並べる
function mergeKids(target, kids) {
  const list = Array.isArray(kids) ? kids : [];
  if (!list.length || !target) return;
  if (kidsCan(target.b)) { if (!Array.isArray(target.b.children)) target.b.children = []; target.b.children.push(...list); return; }
  target.list.splice(target.index + 1, 0, ...list);
}
// list[index] の子を外へ出して、その行のすぐ後ろに元の順で兄弟として並べる → 出した子の並び
function kidsOut(list, index) {
  const b = list[index];
  const kids = kidsOf(b);
  if (!kids.length) return [];
  b.children = [];
  list.splice(index + 1, 0, ...kids);
  return kids;
}

// 型を変えるときに子を外へ出すか（EQ16 (a)・NR10）: トグル（トグル見出し）をテキストに戻すときと、子を持てない型（トグルでない見出し）へ変えるとき。
// 子を持てるほかの型（箇条書き・ToDo・番号付き・引用・コールアウト・トグル）へ変えるときは子を残す。to は { type, level?, toggle? }
function turnMovesKids(b, to) {
  if (isToggle(b) && to.type === 'paragraph') return true;   // EQ16 (a): トグルをテキストに戻すと子は下に並ぶ
  return !kidsCan(to);   // NR10: 子を持てない型へ（区切り線は文か子のある行を断る: NR7）
}

// ---------------------------------------------------------------- 落とす段（NR12）
// rows: 見えている行（動かす行とその子孫を除く）[{ id, depth, parentId, kids }]・idx: 落とす所（rows の何番目の前か）・
// shift: 上の行の段からの横のずれ（段の数。右が正）・o.top: 最上位から動かさない行（TQ2: AI の節の見出し）→ { parentId（最上位は null）, afterId }
function dropSpot(rows, idx, shift, o = {}) {
  const list = Array.isArray(rows) ? rows : [];
  if (idx <= 0 || !list.length) return { parentId: null, afterId: '' };   // いちばん上は最上位の頭（R28）
  const above = list[Math.min(idx, list.length) - 1];
  const below = list[idx] || null;
  const deep = above.depth + (above.kids ? 1 : 0);   // いちばん深い所: 上の行が子を持てればその最初の子
  const shallow = below ? Math.min(below.depth, deep) : 0;   // いちばん浅い所: 下の行の段まで（親と最初の子の間は子の頭だけ）
  let depth = above.depth + Math.trunc(Number(shift) || 0);
  depth = Math.max(shallow, Math.min(deep, depth));
  if (o.top) depth = 0;   // TQ2: AI の節の見出しは最上位のまま（右へずらしても子にならない）
  if (depth > above.depth) return { parentId: above.id, afterId: '' };
  for (let i = Math.min(idx, list.length) - 1; i >= 0; i--) if (list[i].depth === depth) return { parentId: list[i].parentId, afterId: list[i].id };
  return { parentId: null, afterId: '' };
}

module.exports = {
  VIEW_KEYS, isToggle, isOpenStored, kidsCan, aiSectionHead,
  buildTree, flattenBlocks, walk, locate, within, canIndent, indentPlan, spotOf,
  visibleOrder, numberLabelsTree, mergeKids, kidsOut, turnMovesKids, dropSpot,
};
