'use strict';
// ページごとの見た目（0.15.0 Task PL-1。計画 docs/plans/2026-11-03-150.md の決めたこと 39〜42・U5・U6・F119。純粋）。
// ページの attrs.look は { wide?: true, small?: true, font?: 'serif' | 'mono' } だけ（全幅・小さい文字・書体）。既定（全部無し）は {}（DB は欄ごと消す: PL-2）。
// 知らない欄・真でない値・決まった書体のほかは投げる（決まりの外の CSS を当てさせない）。画面は lookClasses の class だけを当てる（PL-3）。

const FONTS = Object.freeze(['serif', 'mono']);
const KEYS = Object.freeze(['wide', 'small', 'font']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const bad = (what) => { const e = new Error(`見た目の形が違う: ${what}`); e.code = 'bad-look'; return e; };

// 照らして決まった形にする → { wide?, small?, font? }（並びは wide・small・font）。外れれば投げる
function normalizeLook(v) {
  if (!isObj(v)) throw bad('物でない');
  for (const k of Object.keys(v)) if (!KEYS.includes(k)) throw bad(`知らない欄 ${k.slice(0, 20)}`);
  const out = {};
  for (const k of ['wide', 'small']) {
    if (v[k] === undefined) continue;
    if (v[k] !== true) throw bad(`${k} は true だけ`);
    out[k] = true;
  }
  if (v.font !== undefined) {
    if (!FONTS.includes(v.font)) throw bad('決まった書体でない');
    out.font = v.font;
  }
  return out;
}

// 既定の見た目（全部無し）か（DB は欄ごと消す: 決めたこと 39・PL-2）
function isPlainLook(look) {
  return isObj(look) && Object.keys(look).length === 0;
}

// 見た目の class（照らせない値は []）→ ['look-wide', 'look-small', 'look-serif' | 'look-mono'] の部分集合
function lookClasses(look) {
  let l;
  try { l = normalizeLook(look); } catch (_) { return []; }
  const out = [];
  if (l.wide) out.push('look-wide');
  if (l.small) out.push('look-small');
  if (l.font) out.push(`look-${l.font}`);
  return out;
}

module.exports = { FONTS, normalizeLook, isPlainLook, lookClasses };
