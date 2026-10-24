/* help-relnotes.js — ヘルプセンターのリリースノート（計画 docs/plans/2026-10-23-help-relnotes.md の RN1〜RN4・RNF1〜RNF5）
 *
 * 中身は CHANGELOG.md だけ（RN1）。版の節の見出しは次の2つの形だけを受ける（RN4）。
 *   ## natsu-v<版> （<YYYY-MM-DD>）   … 出した版。半角の空白のあとに全角の括弧（release.yml の取り出しは版のあとの空白で節を見分ける）
 *   ## natsu-v<版>                    … まだ出していない版。一番上の1つだけ。ページには出さない
 * 本文は記事と同じ help-md で変換する（生の HTML・危ないリンクは作るのを止める）。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { renderMarkdown, HelpBuildError } = require('./help-md');

const FILE = 'CHANGELOG.md';
const HEAD = /^## natsu-v(\d+)\.(\d+)\.(\d+)(?: （(\d{4})-(\d{2})-(\d{2})）)?$/;

/** 公開前の確認（G-21）。リポジトリに置いてはいけない字面 */
const PUBLIC = [
  [/[a-z0-9-]+\.cloudflareaccess\.com/i, 'チームのドメイン'],
  [/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i, '64 字の16進'],
  [/[A-Za-z]:\\{1,2}Users\\{1,2}/, '個人の Windows のパス'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/, 'メールの住所'],
];

const fail = (msg, line) => { throw new HelpBuildError(`${FILE}: ${msg}`, { file: FILE, line, code: 'bad-changelog' }); };
const realDate = (y, m, d) => {
  const t = new Date(Date.UTC(+y, +m - 1, +d));
  return t.getUTCFullYear() === +y && t.getUTCMonth() === +m - 1 && t.getUTCDate() === +d;
};
const cmpVer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * CHANGELOG.md を版の節に分ける → [{ version, date（出していなければ null）, line（見出しの行）, body, bodyLine（本文の1行目の行） }]（上から順）
 * 本文は release.yml の取り出しと同じ（見出しの次の行から次の「## 」の前まで。前後の空の行を除く）。
 */
function parseChangelog(text) {
  const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((l, k) => {
    for (const [re, what] of PUBLIC) if (re.test(l)) fail(`公開してはいけない字面（${what}）があります`, k + 1);
  });
  const secs = [];
  let cur = null;
  const close = () => {
    if (!cur) return;
    const b = cur.raw;
    let s = 0;
    let e = b.length;
    while (s < e && b[s] === '') s++;
    while (e > s && b[e - 1] === '') e--;
    secs.push({ version: cur.version, date: cur.date, line: cur.line, body: b.slice(s, e).join('\n'), bodyLine: cur.line + 1 + s, v: cur.v });
  };
  lines.forEach((l, k) => {
    if (!/^## /.test(l)) { if (cur) cur.raw.push(l); return; }
    const m = HEAD.exec(l);
    if (!m) fail(`版の見出しの形が違います（「## natsu-v<版> （<YYYY-MM-DD>）」か「## natsu-v<版>」）: ${l}`, k + 1);
    if (m[4] && !realDate(m[4], m[5], m[6])) fail(`実在しない日付です: ${m[4]}-${m[5]}-${m[6]}`, k + 1);
    close();
    cur = { version: `${+m[1]}.${+m[2]}.${+m[3]}`, v: [+m[1], +m[2], +m[3]], date: m[4] ? `${m[4]}-${m[5]}-${m[6]}` : null, line: k + 1, raw: [] };
  });
  close();
  if (!secs.length) fail('版の節が1つもありません', 1);
  let upperDate = null;
  secs.forEach((s, i) => {
    if (i > 0) {
      if (cmpVer(secs[i - 1].v, s.v) <= 0) fail(`版は上から新しい順に1回ずつ書きます（${secs[i - 1].version} の下に ${s.version}）`, s.line);
      if (!s.date) fail(`日付の無い節（まだ出していない版）は一番上の1つだけです: ${s.version}`, s.line);
    }
    if (s.date) {
      if (upperDate && s.date > upperDate) fail(`上の版（${upperDate}）より新しい日付です: ${s.date}`, s.line);
      upperDate = s.date;
    }
  });
  return secs.map(({ v, ...s }) => s);
}

/** ページに出す版（日付のある節だけ。上から新しい順） → [{ version, date, id, html, text }] */
function renderRelnotes(secs) {
  return secs.filter((s) => s.date).map((s) => {
    const r = renderMarkdown(s.body, {
      file: FILE,
      bodyLine: s.bodyLine,
      articleExists: () => false,
      anchorExists: () => false,
      assetExists: () => false,
    });
    return { version: s.version, date: s.date, id: `v${s.version.replace(/\./g, '-')}`, html: r.html, text: r.text };
  });
}

/** リポジトリの根の CHANGELOG.md を読んで、ページに出す版を返す */
function readRelnotes(root) {
  const f = path.join(root, FILE);
  if (!fs.existsSync(f)) throw new HelpBuildError(`${FILE} がありません`, { file: FILE, line: null, code: 'bad-changelog' });
  return renderRelnotes(parseChangelog(fs.readFileSync(f, 'utf8')));
}

module.exports = { parseChangelog, renderRelnotes, readRelnotes, HEAD };
