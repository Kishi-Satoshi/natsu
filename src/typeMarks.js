'use strict';
// 0.18.0 XE-1（計画 docs/plans/2026-11-18-180.md の決めたこと 57・D159・AQ10 (a)・AQ23 (a)・AQ24 (a)・F245）: Ctrl+Z の1回で戻るまとまり（印）。純粋（何も読まない）。
// 保存の間合いは今のまま（undoBook の TYPE_PAUSE_MS = 2 秒）。それとは別に、行の「印」（文と飾り rich とカーソルの位置）を窓のメモリに積む。
// 印を積むのは、打つ手が UNDO_PAUSE_MS 止まった後の次の打鍵（止まる前のまとまりを閉じる）と、日本語入力の確定（cut: 時刻によらず、そこまでを1つの印に閉じる）だけ。
// 行の中の改行・1行の貼り付け・飾りは印を切らない（すぐ前に打った字と同じまとまり: AQ23 (a)）。保存したとき、その保存の歩みに印の並び（始めと終わりを含む）を持たせ、
// Ctrl+Z・Ctrl+Y は並びの中を1つずつ動く（stepBack・stepFwd。印が2つ以下・始めの1つ手前まで来たら null: 今どおり edit.revert で戻す）。
// 画面（app.html）は使う関数を写す（undoBook と同じ形）。
const UNDO_PAUSE_MS = 500;   // 打つ手がこれだけ止まったら、次の打鍵から別のまとまり（Q-04・X-35）
const MARKS_MAX = 60;        // 1つの保存の印の数（始めの1つを残し、古いまとまりから捨てる）

// 印の形 { text, rich（飾りの無い行は null）, caret }
function snapOf(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    text: typeof o.text === 'string' ? o.text : '',
    rich: Array.isArray(o.rich) && o.rich.length ? o.rich : null,
    caret: Number.isSafeInteger(o.caret) && o.caret >= 0 ? o.caret : 0,
  };
}
// 文と飾りが同じか（カーソルの位置は見ない）
function sameSnap(a, b) {
  return Boolean(a && b) && a.text === b.text && JSON.stringify(a.rich || null) === JSON.stringify(b.rich || null);
}
// 並び list の項目は { snap, at（打った時刻 ms）, open（まだ閉じていないまとまり）}。最初の1つは始め（保存した形。閉じている）
function markAdd(list, snap, nowMs, { cut = false } = {}) {
  const l = Array.isArray(list) ? list : [];
  const s = snapOf(snap);
  const t = Number.isFinite(nowMs) ? nowMs : 0;
  if (!l.length) return [{ snap: s, at: t, open: false }];
  const last = l[l.length - 1];
  if (sameSnap(last.snap, s)) return cut && last.open ? [...l.slice(0, -1), { ...last, open: false }] : l;   // 同じ文は足さない（確定ならまとまりを閉じる）
  const next = { snap: s, at: t, open: !cut };
  const out = last.open && t - last.at < UNDO_PAUSE_MS ? [...l.slice(0, -1), next] : [...l, next];
  return out.length > MARKS_MAX ? [out[0], ...out.slice(out.length - MARKS_MAX + 1)] : out;
}
// 並び → 印（文と飾りの続けて同じものは1つに。後のカーソルを使う）
function marksOf(list) {
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const s = snapOf(m && m.snap);
    if (out.length && sameSnap(out[out.length - 1], s)) out[out.length - 1] = s; else out.push(s);
  }
  return out;
}
// 歩み { marks, at（今の印の番号）, … } を1つ戻す・進める → { entry, from, to } | null
function atOf(entry) {
  const m = entry && Array.isArray(entry.marks) ? entry.marks : [];
  return { m, at: entry && Number.isSafeInteger(entry.at) ? entry.at : m.length - 1 };
}
function stepBack(entry) {
  const { m, at } = atOf(entry);
  if (m.length < 3 || at < 2 || at >= m.length) return null;   // 印が2つ以下・始めの次まで来た: edit.revert で戻す
  return { entry: { ...entry, at: at - 1 }, from: m[at], to: m[at - 1] };
}
function stepFwd(entry) {
  const { m, at } = atOf(entry);
  if (m.length < 3 || at < 1 || at >= m.length - 1) return null;   // 始め（edit.revert のやり直し）・終わり
  return { entry: { ...entry, at: at + 1 }, from: m[at], to: m[at + 1] };
}

module.exports = { UNDO_PAUSE_MS, MARKS_MAX, markAdd, marksOf, stepBack, stepFwd };
