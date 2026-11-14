'use strict';
// ページの木の純粋な部品（0.15.0 Task PH-1。計画 docs/plans/2026-11-03-150.md の決めたこと 1〜6・19〜21・30・31・HR2・HR6）。
// src/db/keys.js だけを読む。DB の命令（src/db/commands.js: 動かす・子ごとゴミ箱へ・一緒に戻す）と画面の写し（app.html: サイドバーの木・
// パンくず・落とす所）が同じ表で使う。木の正本はページの行の parent_id だけで、兄弟の中の並びは ord（親に子の一覧を持たせない）。
// 行の形: { id, parentId（null か文字）, ord, createdAt, trashedAt? }（一覧の1行か、DB のページの行を読んだもの）。
// 輪や、親が rows に無い行（前の版で親だけを消した・壊れた行）は捨てずに最上位に並べ、orphans に数える（HR2。訪ねた印で必ず止まる）。
// 木を歩くのは SQL の再帰でなく、ここの JS（決めたこと 6: 索引の無い parent_id の再帰は 1,000 段で約 3 秒・JS は約 10 ミリ秒）。
const { keysBetween } = require('./db/keys');

// 最上位のページの並びの鍵（ops.js の PAGE_ORD と同じ。最上位は作った新しい順なので鍵で並べない: BQ5 (a)）
const TOP_ORD = 'i';

const has = (m, k) => m.has(k);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const parentOf = (r) => (r && typeof r.parentId === 'string' && r.parentId ? r.parentId : null);

// rows → { roots: [id], kids: Map(id → [id]), parent: Map(id → id|null), orphans: n, byId: Map(id → 行) }
// （byId は PH-1 直し: R11。trashGroup・restoreGroup が同じ木を何度も使うときに、行を引き直さない）
// 最上位は createdAt の新しい順（BQ5 (a)。同じなら rows の順）。子は ord の順（同じ鍵なら createdAt の古い順）
function pageTree(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r.id === 'string') : [];
  const byId = new Map();
  for (const r of list) if (!byId.has(r.id)) byId.set(r.id, r);
  // 親をたどれない行（親が rows に無い・輪の中）の印。輪は親をたどって今の道に戻ったら、その輪の行を全部切る
  const cut = new Set();
  const state = new Map();   // id → 1（今たどっている道の上）・2（済んだ）
  let orphans = 0;
  for (const start of byId.keys()) {
    if (state.has(start)) continue;
    const path = [];
    let cur = start;
    while (cur !== null && byId.has(cur) && !state.has(cur)) {
      state.set(cur, 1);
      path.push(cur);
      cur = parentOf(byId.get(cur));
    }
    if (cur !== null && state.get(cur) === 1) {
      for (let i = path.indexOf(cur); i < path.length; i++) cut.add(path[i]);
    }
    for (const id of path) state.set(id, 2);
  }
  const parent = new Map();
  const kids = new Map();
  const roots = [];
  for (const [id, r] of byId) {
    const p = parentOf(r);
    if (p !== null && (!byId.has(p) || cut.has(id))) orphans++;
    const eff = p !== null && byId.has(p) && !cut.has(id) ? p : null;
    parent.set(id, eff);
    if (eff === null) roots.push(id);
    else {
      if (!kids.has(eff)) kids.set(eff, []);
      kids.get(eff).push(id);
    }
  }
  const at = (id) => byId.get(id);
  roots.sort((a, b) => cmp(String(at(b).createdAt ?? ''), String(at(a).createdAt ?? '')));
  for (const ks of kids.values()) {
    ks.sort((a, b) => cmp(String(at(a).ord ?? ''), String(at(b).ord ?? '')) || cmp(String(at(a).createdAt ?? ''), String(at(b).createdAt ?? '')));
  }
  return { roots, kids, parent, orphans, byId };
}

const kidsIn = (tree, id) => (tree && tree.kids && has(tree.kids, id) ? tree.kids.get(id) : []);

// 子孫（自分を含まない。深さ優先・子の並びの順）。訪ねた印で止まる
function descendants(tree, id) {
  const out = [];
  const seen = new Set([id]);
  const stack = [...kidsIn(tree, id)].reverse();
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    const ks = kidsIn(tree, k);
    for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]);
  }
  return out;
}

// id を parentId の下へ動かしてよいか（null は最上位で真。自分の下・自分の子孫の下は偽: 輪を作らない。決めたこと 5）
function canMoveUnder(tree, id, parentId) {
  if (parentId === null || parentId === undefined || parentId === '') return true;
  if (parentId === id) return false;
  const seen = new Set();
  for (let cur = tree.parent.get(parentId) ?? null; cur !== null && !seen.has(cur); cur = tree.parent.get(cur) ?? null) {
    if (cur === id) return false;
    seen.add(cur);
  }
  return true;
}

// 根から親までの ID（自分を含まない。輪でも止まる）
function crumbsOf(tree, id) {
  const out = [];
  const seen = new Set([id]);
  for (let cur = tree.parent.get(id) ?? null; cur !== null && !seen.has(cur); cur = tree.parent.get(cur) ?? null) {
    seen.add(cur);
    out.push(cur);
  }
  return out.reverse();
}

// 見えている行（open は開いている ID の Set）→ [{ id, depth, hasKids, open }]。閉じた行の子は出さない（描かない: F115）
function visibleRows(tree, open) {
  const isOpen = (id) => Boolean(open && typeof open.has === 'function' && open.has(id));
  const out = [];
  const seen = new Set();
  const stack = [...tree.roots].reverse().map((id) => ({ id, depth: 0 }));
  while (stack.length) {
    const { id, depth } = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const ks = kidsIn(tree, id);
    const hasKids = ks.length > 0;
    const opened = hasKids && isOpen(id);
    out.push({ id, depth, hasKids, open: opened });
    if (!opened) continue;
    for (let i = ks.length - 1; i >= 0; i--) stack.push({ id: ks[i], depth: depth + 1 });
  }
  return out;
}

// 鍵として使えるか（keys.js の形: 36 進の数字で、末尾が '0' でない）
const keyOk = (k) => typeof k === 'string' && /^[0-9a-z]*[1-9a-z]$/.test(k);
const ordIn = (ords, id) => {
  const v = ords instanceof Map ? ords.get(id) : (ords && Object.hasOwn(ords, id) ? ords[id] : undefined);
  return keyOk(v) ? v : null;
};
// parentId の子の並びで afterId の後ろに入れる鍵（afterId が '' なら頭・undefined なら末尾）。ords は id → ord（Map か物）。
// 呼び手は動かすページを除いた木を渡す（自分の今の鍵を兄弟に数えない）。最上位（parentId が null）は鍵で並べないので TOP_ORD（BQ5 (a)）。
// → { ord, rekey: [[id, ord]] }。PH-1 直し（R15）: 後ろの兄弟の鍵が前の兄弟と同じ（壊れた行・前の版の行）なら、その兄弟は入れるページの後ろへ
// 鍵を付け直す（rekey。呼び手が同じ命令の move に積む）。同じ鍵の間には鍵を作れないので、付け直さないと入れるページが同じ鍵の後ろへずれる
function placeKeys(tree, ords, parentId, afterId) {
  if (parentId === null || parentId === undefined || parentId === '') return { ord: TOP_ORD, rekey: [] };
  const sibs = kidsIn(tree, parentId);
  const keysOf = sibs.map((id) => ordIn(ords, id));
  let i;   // この位置の兄弟の後ろに入れる（-1 は頭）
  if (afterId === undefined || afterId === null) i = sibs.length - 1;
  else if (afterId === '') i = -1;
  else { i = sibs.indexOf(afterId); if (i < 0) i = sibs.length - 1; }   // 兄弟でない ID は末尾
  const lo = i >= 0 ? keysOf[i] : null;
  let j = i + 1;
  while (j < sibs.length && lo !== null && keysOf[j] !== null && keysOf[j] <= lo) j++;
  const hi = j < sibs.length ? keysOf[j] : null;
  const keys = keysBetween(lo, hi, j - i);
  return { ord: keys[0], rekey: sibs.slice(i + 1, j).map((id, k) => [id, keys[k + 1]]) };
}
function siblingKey(tree, ords, parentId, afterId) {
  return placeKeys(tree, ords, parentId, afterId).ord;
}

const trashedOf = (r) => (r && r.trashedAt !== null && r.trashedAt !== undefined && r.trashedAt !== '' ? r.trashedAt : null);

// id と、ゴミ箱に入っていない子孫（もうゴミ箱にある子の下は、その子のまとまりなので入れない。先に消した時刻を書き換えない: 決めたこと 30）
// tree は rows から作った木（無ければ作る。頭をいくつも歩くときは1回だけ作って渡す: R11）
function trashGroup(rows, id, tree = pageTree(rows)) {
  const byId = tree.byId;
  if (!byId.has(id)) return [];
  const out = [id];
  const seen = new Set([id]);
  const stack = [...kidsIn(tree, id)].reverse();
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k)) continue;
    seen.add(k);
    if (trashedOf(byId.get(k)) !== null) continue;
    out.push(k);
    const ks = kidsIn(tree, k);
    for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]);
  }
  return out;
}

// id と、id と同じ時刻にゴミ箱に入った子孫（間にほかの時刻で消した子・ゴミ箱に無い子があれば、その下は入れない: 決めたこと 31）
function restoreGroup(rows, id, tree = pageTree(rows)) {
  const byId = tree.byId;
  if (!byId.has(id)) return [];
  const at = trashedOf(byId.get(id));
  const out = [id];
  if (at === null) return out;
  const seen = new Set([id]);
  const stack = [...kidsIn(tree, id)].reverse();
  while (stack.length) {
    const k = stack.pop();
    if (seen.has(k)) continue;
    seen.add(k);
    if (trashedOf(byId.get(k)) !== at) continue;
    out.push(k);
    const ks = kidsIn(tree, k);
    for (let i = ks.length - 1; i >= 0; i--) stack.push(ks[i]);
  }
  return out;
}

// サイドバーで引っ張って落とす所（rows は visibleRows の行・idx は乗せた行・y はその行の中の高さの位置・h は行の高さ）。
// → { parentId, afterId } | null。真ん中は中へ（最後の子: afterId は undefined）・上の4分の1はその前（同じ親の兄弟）・下の4分の1はその後ろ。
// 自分と自分の子孫の上は null（落とす印を出さない: 決めたこと 21）。afterId '' は兄弟の頭
function pageDropSpot(rows, idx, y, h, dragId, tree) {
  const row = Array.isArray(rows) ? rows[idx] : null;
  if (!row || typeof row.id !== 'string' || !tree) return null;
  if (row.id === dragId || !canMoveUnder(tree, dragId, row.id)) return null;
  const hh = Number(h) > 0 ? Number(h) : 1;
  const yy = Number(y);
  if (yy >= hh / 4 && yy < (hh * 3) / 4) return { parentId: row.id, afterId: undefined };
  const p = tree.parent.get(row.id) ?? null;
  const sibs = (p === null ? tree.roots : kidsIn(tree, p)).filter((id) => id !== dragId);
  if (yy >= (hh * 3) / 4) return { parentId: p, afterId: row.id };
  const i = sibs.indexOf(row.id);
  return { parentId: p, afterId: i > 0 ? sibs[i - 1] : '' };
}

// 場所の文（根から親まで「親 / 子」。最上位は ''）。titleOf(id) は呼び手が1行にした題名。max 段を越えたら近い max 段の前に「…」
function placeText(tree, titleOf, id, max = 5) {
  const ids = crumbsOf(tree, id);
  if (!ids.length) return '';
  const n = Math.max(1, Math.trunc(Number(max) || 5));
  const shown = ids.length > n ? ids.slice(ids.length - n) : ids;
  const parts = shown.map((x) => String(titleOf(x) ?? ''));
  return (ids.length > n ? ['…', ...parts] : parts).join(' / ');
}

// 0.17.0 PD-1（計画 docs/plans/2026-11-13-170.md の決めたこと 31・F187）: データベースにできる「空の白紙のページ」か。page は { kind, blocks, memo, memoDoc? }、
// hasKid はそのページを親にするページがあるか（ゴミ箱の子も数える）。本文の行が無いか、ある行が全部「空のテキストの行」（段落・文字が空・色と飾りが無い・
// 子が無い）で、子のページが無く、メモが空。題名・アイコン・見た目は数えない（題名と見た目は残し、アイコンは外す: RQ2）
const isBareParagraph = (b) => Boolean(b) && typeof b === 'object' && b.type === 'paragraph' && (b.text ?? '') === '' && !b.color
  && !(Array.isArray(b.rich) && b.rich.length) && !(Array.isArray(b.children) && b.children.length);
function isEmptyBlank(page, hasKid) {
  if (!page || typeof page !== 'object' || page.kind !== 'blank' || hasKid) return false;
  if (page.blocks !== undefined && !Array.isArray(page.blocks)) return false;
  if (!(page.blocks || []).every(isBareParagraph)) return false;
  if (String(page.memo ?? '') !== '') return false;
  return !(Array.isArray(page.memoDoc) && page.memoDoc.some((b) => !isBareParagraph(b)));
}

module.exports = { TOP_ORD, pageTree, descendants, canMoveUnder, crumbsOf, visibleRows, siblingKey, placeKeys, trashGroup, restoreGroup, pageDropSpot, placeText, isEmptyBlank };
