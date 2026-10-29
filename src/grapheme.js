'use strict';
// 書記素の境（0.13.0 F40。0.14.0 EB-1 直しで src/blockEdit.js から移した: blockEdit と richText の両方が読む。純粋・何も読まない）。
// 画面（app.html）は同じ関数を写す（test/stage130.edit.app.test.js が同じ答えかを見る）。
function graphemeEnds(text) {
  const s = String(text);
  const out = [0];
  if (typeof Intl === 'object' && typeof Intl.Segmenter === 'function') {
    const seg = new Intl.Segmenter('ja', { granularity: 'grapheme' });
    for (const g of seg.segment(s)) out.push(g.index + g.segment.length);
  } else {
    for (let i = 0; i < s.length;) { const c = s.codePointAt(i); i += c > 0xffff ? 2 : 1; out.push(i); }
  }
  return out;
}
// 位置（UTF-16）を書記素の境に寄せる。途中なら次の境へ・負は 0・長さより大は長さ
function safeOffset(text, at) {
  const s = String(text ?? '');
  const n = Number.isFinite(at) ? Math.trunc(at) : 0;
  if (n <= 0) return 0;
  if (n >= s.length) return s.length;
  for (const e of graphemeEnds(s)) if (e >= n) return e;
  return s.length;
}

module.exports = { graphemeEnds, safeOffset };
