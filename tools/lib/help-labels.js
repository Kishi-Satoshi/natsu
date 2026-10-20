'use strict';
// help-labels.js — 記事の画面の言葉の照らし（H-5・HF2・RF51。実装計画 docs/plans/2026-10-20-help.md）
//
// 記事の ［…］ は NaTsu の画面の言葉だけ（R9）。どれもアプリのコード（src/ の .html と .js）にちょうどその文字があるかを見る。
// 照らしの元はここ1か所（help/ や README を混ぜると、記事の言葉が自分自身で通ってしまう）。例外の一覧は持たない。

const fs = require('node:fs');
const path = require('node:path');

/** src/ の下の .html と .js を、道の順につないだ文字 */
function appLabelText(root) {
  const src = path.join(root, 'src');
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(?:html|js)$/.test(e.name)) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  if (fs.existsSync(src)) walk(src);
  return out.join('\n');
}

/** 記事の ［…］ の言葉と行（1 から）。コードの塊（```）と文中のコード（`…`）の中は数えない */
function labelsIn(md) {
  const out = [];
  let fence = false;
  String(md).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const text = line.replace(/`[^`]*`/g, '');
    for (const m of text.matchAll(/［([^［］]+)］/g)) out.push({ label: m[1], line: i + 1 });
  });
  return out;
}

/** アプリの文字（appLabelText）に無い言葉だけ */
function missingLabels(md, appText) {
  return labelsIn(md).filter((l) => !appText.includes(l.label));
}

module.exports = { appLabelText, labelsIn, missingLabels };
