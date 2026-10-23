/*
 * stage094.rename.test.js — 0.9.4 Task R-1（計画 docs/plans/2026-10-22-094.md の3回目の節 Q25）: 設定の項目「ローカル AI の設定」を「ローカル AI」に
 * 持ち主の言葉は「ローカルAI」。今の画面の書き方（日本語と英字の間に半角の空白: 「AI 要約」「PC の中」）にそろえて「ローカル AI」（持ち主の答え Q25）。
 * ［ローカル AI の準備］［ローカル AI を使う（数 GB を取り込む）］のボタンの名前はそのまま。内部のキー（offline・setNavOffline・settings/offline）は変えない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('./helpers/simdom');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const T = { timeout: 5000 };
const helpFiles = () => {
  const out = [];
  const dir = path.join(ROOT, 'help', 'articles');
  for (const c of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, c))) out.push(`help/articles/${c}/${f}`);
  return out;
};

test('R-1: 設定の左の列・隠した見出し・項目の名前（SETTINGS_SECS）は「ローカル AI」。キーは offline のまま', T, () => {
  const html = read('src/renderer/app.html');
  const doc = parseHTML(html).root;
  const nav = doc.querySelector('#setNavOffline');
  assert.strictEqual(nav.textContent.trim(), 'ローカル AI');
  assert.strictEqual(nav.getAttribute('data-sec'), 'offline');
  assert.ok(html.includes("{ sec: 'offline', name: 'ローカル AI' }"));
  assert.ok(/<h2 hidden>ローカル AI<\/h2>/.test(html));
  assert.ok(html.includes("offline: 'ローカル AI の準備' }") && html.includes("btn = `ローカル AI を使う（約 ${fetchGB(need)} を取り込む）`;"), 'ボタンの名前まで替えた');
});

test('R-1: 利用者に見える文（app.html・main.js・mainlib.js・ヘルプ・site.json・README・INSTALL）に「ローカル AI の設定」が無い', T, () => {
  const files = ['src/renderer/app.html', 'src/main.js', 'src/mainlib.js', ...helpFiles(), 'help/site.json', 'README.md', 'INSTALL.md'];
  const bad = [];
  for (const f of files) read(f).split('\n').forEach((l, i) => { if (l.includes('ローカル AI の設定')) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`); });
  assert.deepStrictEqual(bad, []);
  assert.ok(read('help/articles/settings/offline.md').includes('title: ローカル AI\n'));
  assert.ok(read('src/main.js').includes('設定の「ローカル AI」の準備'), 'LOCAL_SETUP_NOTICE が古い');
});

// 0.9.4 O-1（3回目の節 Q32・0.10.0 の持ち主の決定: オフラインモードは「ネットワークが不安定なとき・つながらないとき」に PC の文字起こしに固定する印で、
// 外へ送らない約束ではない）: 0.9.4 が足した帯 kept-late のオフラインモードの文から「（外には送りません）」を外す。ほかの文は 0.10.0 で直す（計画の一覧）
test('O-1: 帯 kept-late のオフラインモードの文に「外には送りません」が無く、決めた文になっている', T, () => {
  const main = read('src/main.js');
  const m = /'kept-late': \(d\) => \(d && d\.offline\n\s*\? '([^']+)'/.exec(main);
  assert.ok(m, '帯 kept-late のオフラインモードの文が無い');
  assert.strictEqual(m[1], 'オフラインモードです。この PC の文字起こしが録音に追いつかないため、音声を残しています。会議が終わったら PC の中で文字起こしします。');
  assert.ok(!m[1].includes('外には送りません'));
});
