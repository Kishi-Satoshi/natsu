'use strict';
// 0.12.0 Task SP-1（計画 docs/plans/2026-10-22-120.md の決めたこと 80・84・127・128。D53・D66）: 文字起こしの「自分」「相手」とタイムライン（純粋）。
// 相手の声を取り込む会議では、マイクの流れの区間（src: 'mic'）と相手の声の流れの区間（src: 'loopback'）を別々に文字起こしする。
// 読む側（画面・［コピー］・要約への入力・MCP）は、発言を timelineOf で「行」の並びにしてから使う（DB の並びは届いた順のまま: K30）。
// 札は DB の値をそのまま出さず、決まった表の名前だけ（K27）。mainlib が同じ物を出し直す（1か所で決める）。

// 入口の名前（設計書の項目 11 の名前 → 持ち主の D53 の言葉）
const SOURCE_LABELS = Object.freeze({ mic: '自分', loopback: '相手' });
// 第13回の「話者A・B」（1.0.0 の後の申し送り: 決めたこと 96）。0.12.0 では空
const SPEAKER_LABELS = Object.freeze({});
// PC の側の区間の文の頭（parts）の数の上限
const PARTS_MAX = 200;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const look = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : '');

/** 発言（か行）の札: SPEAKER_LABELS にある speaker、無ければ SOURCE_LABELS にある src の名前、どちらも無ければ '' */
function srcLabel(seg) {
  if (!isObj(seg)) return '';
  return look(SPEAKER_LABELS, seg.speaker) || look(SOURCE_LABELS, seg.src);
}

/**
 * PC の側の区間の文の頭の照らし（読む側。決めたこと 128）: [{ ms, at }] が 2〜PARTS_MAX 個・どれも 0 以上の整数・最初は { ms: 0, at: 0 }・
 * ms と at がどちらも増える・at は文の中・ms は区間の長さの中（長さが分かるとき）・どの文の切れも空でない → 写し。違えば null
 */
function checkParts(parts, text, durationMs) {
  if (!Array.isArray(parts) || parts.length < 2 || parts.length > PARTS_MAX || typeof text !== 'string') return null;
  const out = [];
  for (const p of parts) {
    if (!isObj(p) || !Number.isSafeInteger(p.ms) || !Number.isSafeInteger(p.at) || p.ms < 0 || p.at < 0) return null;
    const prev = out[out.length - 1];
    if (prev ? (p.ms <= prev.ms || p.at <= prev.at) : (p.ms !== 0 || p.at !== 0)) return null;
    if (p.at >= text.length) return null;
    if (Number.isFinite(durationMs) && p.ms > durationMs) return null;
    out.push({ ms: p.ms, at: p.at });
  }
  for (let k = 0; k < out.length; k++) if (!text.slice(out[k].at, k + 1 < out.length ? out[k + 1].at : text.length).trim()) return null;
  return out;
}

/**
 * 発言 → 行の並び（決めたこと 127）。行は { id, ms, text, src, failed, kept, pending, part }（part は文ごとの行の番号。区間のままの行は -1）。
 * 並びは format.sortSegs と同じ決まり（時刻の順・同じ時刻は発言の並び＝届いた順。atMs の無い発言は前の発言の後: S12 (a)）。
 * parts のある区間（文字になっていて、checkParts を通るもの）は文ごとの行に分けてから並べ直す。声が重なった所は両方の行を残す（混ぜない・消さない）
 */
function timelineOf(segments) {
  const keyed = [];
  let prev = -Infinity;
  let i = 0;
  for (const s of (Array.isArray(segments) ? segments : [])) {
    if (!isObj(s)) continue;
    const has = Number.isFinite(s.atMs);
    const at = has ? s.atMs : prev;
    prev = at;
    const text = typeof s.text === 'string' ? s.text : '';
    const base = { id: s.id, src: typeof s.src === 'string' ? s.src : '', failed: s.failed === true, kept: s.kept === true, pending: s.pending === true };
    if (typeof s.speaker === 'string') base.speaker = s.speaker;
    const parts = !base.failed && !base.pending ? checkParts(s.parts, text, s.durationMs) : null;
    const end = at + (Number.isFinite(s.durationMs) ? s.durationMs : 0);
    if (parts) {
      parts.forEach((p, k) => {
        const piece = text.slice(p.at, k + 1 < parts.length ? parts[k + 1].at : text.length).trim();
        keyed.push({ row: { ...base, ms: has ? at + p.ms : null, text: piece, part: k }, at: at + p.ms, end, i, k });
      });
    } else {
      keyed.push({ row: { ...base, ms: has ? at : null, text, part: -1 }, at, end, i, k: 0 });
    }
    i++;
  }
  keyed.sort((a, b) => (a.at - b.at) || (a.i - b.i) || (a.k - b.k));
  return keyed.map((x) => {
    const { id, ms, text, src, failed, kept, pending, part, speaker } = x.row;
    const row = { id, ms, text, src, failed, kept, pending, part };
    if (speaker !== undefined) row.speaker = speaker;
    return row;
  });
}

/** 行の頭に札を付けた文（要約への入力・［コピー］: 決めたこと 102・148）。札の無い行は文のまま */
function labeledLine(row) {
  const label = srcLabel(row);
  const text = isObj(row) && typeof row.text === 'string' ? row.text : '';
  return label ? `${label}: ${text}` : text;
}

module.exports = { SOURCE_LABELS, SPEAKER_LABELS, PARTS_MAX, srcLabel, checkParts, timelineOf, labeledLine };
