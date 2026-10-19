/*
 * keys.js — 並びの鍵（第2a1回 ST3。純粋。表の形 v1 の blocks.ord）
 *
 * 鍵は 36 進の数字の列で、0.<鍵> という 0 以上 1 未満の小数を表す。数字の文字は大小の順が値の順と同じ
 * なので、末尾が '0' でない鍵どうしなら、文字の順（SQL の ORDER BY ord）がそのまま並びの順になる。
 * 末尾が '0' の鍵は作らないし受けない（'a' と 'a0' は同じ値なのに文字の順では別で、その間に入れる鍵が無い）。
 */
'use strict';

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';   // 36 進。文字の大小と並びが同じ
const BASE = DIGITS.length;
const KEY_RE = /^[0-9a-z]*[1-9a-z]$/;

function checkKey(k, name) {
  if (k === null || k === undefined) return null;
  if (typeof k !== 'string' || !KEY_RE.test(k)) throw new Error(`keyBetween: ${name} の鍵の形が正しくない`);
  return k;
}

// a（'' は 0）と b（null は 1）の間の鍵。a < b、どちらも末尾が '0' でない
function midpoint(a, b) {
  if (b !== null) {
    // 共通の頭は写す（a は足りない桁を '0' とみなす）
    let n = 0;
    while ((a[n] || '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]) : BASE;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];   // da より大きいので '0' にならない
  // 隣どうしの数字: b に続きがあれば b の頭の1字（b より小さく a より大きい。db >= 1 なので '0' ではない）
  if (b !== null && b.length > 1) return b.slice(0, 1);
  // そうでなければ a の頭の1字の後ろに、a の残りより大きい鍵を続ける
  return DIGITS[da] + midpoint(a.slice(1), null);
}

// a < 結果 < b の文字列（a が null なら先頭より前、b が null なら末尾より後）。a >= b なら投げる。末尾が '0' の鍵は作らない
function keyBetween(a, b) {
  const lo = checkKey(a, 'a');
  const hi = checkKey(b, 'b');
  if (lo !== null && hi !== null && lo >= hi) throw new Error('keyBetween: a < b の順になっていない');
  return midpoint(lo || '', hi);
}

// 等間隔の n 個（移行で使う）。どれも同じ幅で、文字の順と値の順が同じ。
// 頭の m 桁で 0 と 1 の間を n+1 等分し、末尾に真ん中の数字 'i' を付ける（末尾が '0' にならず、どの隣どうし・両端の外にも入れられる）
function evenKeys(n) {
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  if (count === 0) return [];
  let m = 1;
  let span = BASE;
  while (span < count + 1) { m++; span *= BASE; }
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const v = Math.floor(((i + 1) * span) / (count + 1));
    out[i] = v.toString(BASE).padStart(m, '0') + DIGITS[BASE / 2];
  }
  return out;
}

module.exports = { DIGITS, keyBetween, evenKeys };
