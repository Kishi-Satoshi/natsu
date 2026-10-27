'use strict';
// cer.js — 文字誤り率（CER）を出す。文字起こしの比べ（docs/plans/2026-10-27-stt-bench.md）の道具。アプリには組み込まない。
//
//   NaTsu.exe を Node として使う（ELECTRON_RUN_AS_NODE=1。bench-stt.ps1 が呼ぶ）:
//     cer.js <参照.txt> <比べる文字起こし.txt> [--max-sec 600]
//
// 参照は、NaTsu の文字起こしのタブの［コピー］で写した文（行の形「[0:12] 自分: 文」）か、手で直した文。
//   - 行の頭の時刻 [m:ss]・[h:mm:ss] と、札「自分:」「相手:」は外す。--max-sec があれば、時刻がそれ以上の行は使わない
//     （比べる音声は頭の max-sec 秒だけなので、参照も同じ所までにする）。
// 比べる文字起こしは、whisper-cli の txt（行ごとの文）か、sherpa-onnx の行（「0.000 -- 3.200: 文」）。時刻は外す。
// 比べる前に両方を同じ形にする: NFKC（全角の英数を半角に）・英字は小文字・文字と数字のほか（空白・句読点・記号）は外す。
// 出すのは数だけ（1行の JSON）。文そのものは出さない。
//   { refChars, hypChars, edits, cer, lenRatio, hypPeriods }
//   cer = 置き換え・抜け・足しの数 ÷ 参照の文字の数（%）。lenRatio = 比べる側 ÷ 参照（繰り返しの暴走や抜け落ちの目安）。
//   hypPeriods = 比べる側の元の文の「。」の数（句点を打つかどうかの目安。NaTsu は文ごとの行に分けるときに使う）
// 依存なし（Node の fs だけ）。

const fs = require('fs');

const TIME_RE = /^\s*\[(?:(\d+):)?(\d{1,2}):(\d{2})\]\s*/;
const SHERPA_RE = /^\s*\d+(?:\.\d+)?\s*--\s*\d+(?:\.\d+)?\s*:\s?/;
const LABEL_RE = /^(?:自分|相手)\s*[:：]\s*/;

function readText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
}

/** 参照の文から、時刻と札を外した文の並び。maxSec より後の行は外す */
function refLines(text, maxSec) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    const m = TIME_RE.exec(line);
    if (m) {
      const sec = (Number(m[1] || 0) * 3600) + Number(m[2]) * 60 + Number(m[3]);
      if (maxSec > 0 && sec >= maxSec) continue;
      line = line.slice(m[0].length);
    }
    out.push(line.replace(LABEL_RE, ''));
  }
  return out;
}

function hypLines(text) {
  return text.split(/\r?\n/).map((l) => l.replace(SHERPA_RE, ''));
}

/** 比べる形: NFKC・小文字・文字と数字だけ。コードポイントの並び */
function norm(lines) {
  return Array.from(lines.join('').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
}

/** 編集距離（置き換え・抜け・足しはどれも 1）。行は2本だけ持つ */
function editDistance(a, b) {
  if (a.length < b.length) [a, b] = [b, a];
  const m = b.length;
  if (m === 0) return a.length;
  const ids = new Map();
  const code = (s) => { let v = ids.get(s); if (v === undefined) { v = ids.size; ids.set(s, v); } return v; };
  const A = Int32Array.from(a, code);
  const B = Int32Array.from(b, code);
  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= A.length; i++) {
    cur[0] = i;
    const ai = A[i - 1];
    for (let j = 1; j <= m; j++) {
      const sub = prev[j - 1] + (ai === B[j - 1] ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[m];
}

function score(refText, hypText, { maxSec = 0 } = {}) {
  const ref = norm(refLines(refText, maxSec));
  const hyp = norm(hypLines(hypText));
  const edits = editDistance(ref, hyp);
  const pct = (x) => Math.round(x * 1000) / 10;
  return {
    refChars: ref.length,
    hypChars: hyp.length,
    edits,
    cer: ref.length ? pct(edits / ref.length) : null,
    lenRatio: ref.length ? Math.round((hyp.length / ref.length) * 100) / 100 : null,
    hypPeriods: (hypText.match(/[。．]/g) || []).length,
  };
}

module.exports = { score, refLines, hypLines, norm, editDistance };

if (require.main === module) {
  const args = process.argv.slice(2);
  let maxSec = 0;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--max-sec') maxSec = Number(args[++i]) || 0;
    else pos.push(args[i]);
  }
  if (pos.length !== 2) { console.error('使い方: cer.js <参照.txt> <比べる文字起こし.txt> [--max-sec 600]'); process.exit(2); }
  try {
    console.log(JSON.stringify(score(readText(pos[0]), readText(pos[1]), { maxSec })));
  } catch (e) {
    console.error(`CER を出せませんでした: ${e.message}`);
    process.exit(1);
  }
}
