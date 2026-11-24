'use strict';
// 0.18.0 XE-3（計画 docs/plans/2026-11-18-180.md の決めたこと 59・D161・AQ25 (a)・F247）: 折り返した行の ↑↓ の見た目の行。純粋（何も読まない）。
// 画面（app.html）は Range の四角を集めて渡すだけで、写しを使う（undoBook と同じ形）。座標は画面の px（拡大 200% では小数になる）。

const EPS = 0.5;   // 同じ見た目の行とみなす縦のずれ（px。小数の座標の丸め）

// 四角の並び（行の中の文字の箱。1つの見た目の行に何個あってもよい）→ 見た目の行の並び [{ top, bottom }]（上から）。縦の真ん中が前の行の中なら同じ行
function linesOf(rects) {
  const list = (Array.isArray(rects) ? rects : []).filter((r) => r && Number.isFinite(r.top) && Number.isFinite(r.bottom) && r.bottom >= r.top)
    .slice().sort((a, b) => a.top - b.top || a.bottom - b.bottom);
  const out = [];
  for (const r of list) {
    const mid = (r.top + r.bottom) / 2;
    const last = out[out.length - 1];
    if (last && mid >= last.top - EPS && mid <= last.bottom + EPS) { last.top = Math.min(last.top, r.top); last.bottom = Math.max(last.bottom, r.bottom); }
    else out.push({ top: r.top, bottom: r.bottom });
  }
  return out;
}
// カーソルの四角 caret { top, bottom } と、文の見た目の行の四角 lines → 'only' | 'first' | 'last' | 'middle'。
// 行の境のカーソル（前の行の末と次の行の頭が同じ位置）は、縦の真ん中で見て下の行。読めなければ 'only'（今の文の頭・末の決まりに近い形）
function edgeOf({ caret, lines } = {}) {
  const rows = linesOf(lines);
  if (rows.length <= 1 || !caret || !Number.isFinite(caret.top) || !Number.isFinite(caret.bottom)) return 'only';
  const mid = (caret.top + caret.bottom) / 2;
  let at = 0;
  for (let i = 0; i < rows.length; i++) if (mid >= rows[i].top - EPS) at = i;
  return at === 0 ? 'first' : at === rows.length - 1 ? 'last' : 'middle';
}
// 画面の x と、1つの見た目の行の字の四角 chars [{ left, right, offset, end? }]（左から）→ x にいちばん近い字の境の位置。
// 字の真ん中より左なら字の前（offset）・右なら後ろ（end。無ければ offset + 1）。行より右なら行の末。空の行は 0
function pickOffset({ x, chars } = {}) {
  const list = Array.isArray(chars) ? chars.filter((c) => c && Number.isFinite(c.left) && Number.isFinite(c.right) && Number.isSafeInteger(c.offset)) : [];
  if (!list.length) return 0;
  const endOf = (c) => (Number.isSafeInteger(c.end) ? c.end : c.offset + 1);
  if (!Number.isFinite(x)) return list[0].offset;
  for (const c of list) if (x < (c.left + c.right) / 2) return c.offset;
  return endOf(list[list.length - 1]);
}

module.exports = { linesOf, edgeOf, pickOffset };
