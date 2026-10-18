/*
 * stage1b2.rec.test.js — 第1b2回の設定と音声入力（題名のある平らなページ）と録音中のページ（会議のブロックの記録の行）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');
const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const html = fs.readFileSync(APP, 'utf8');
const doc = parseHTML(html).root;
const rules = S.parse(doc.querySelectorAll('style').map((s) => s._raw).join('\n'));

test('1b2 R-1: 設定と音声入力はページの題名を持ち、設定の見出しは 16px の文字の色（小さな灰色の見出しではない）。<h2> の並びは今のまま', () => {
  // simdom の文字の節は tagName が '#text'（空白も節になる）。要素だけを見る
  assert.deepStrictEqual(['#tabSettings', '#tabDictation'].map((s) => doc.querySelector(`${s} .scroll`).childNodes.find((n) => n.tagName && !n.tagName.startsWith('#')).className), ['stitle', 'stitle']);
  assert.deepStrictEqual(doc.querySelectorAll('.stitle').map((h) => h.textContent), ['音声入力', '設定']);
  const h2 = S.declsFor(rules, '.card h2', { at: '' });
  assert.deepStrictEqual([h2['font-size'], h2.color], ['16px', 'var(--text)']);
  assert.strictEqual(S.declsFor(rules, '.stitle', { at: '' })['font-size'], '32px');
});

test('1b2 R-1: トグルの行は文字が左・トグルが右。数の札は線を持たない', () => {
  const c = S.declsFor(rules, '.check', { at: '' });
  assert.deepStrictEqual([c['flex-direction'], c['justify-content']], ['row-reverse', 'space-between']);
  const st = S.declsFor(rules, '.stat', { at: '' });
  assert.ok(!st.border || /none/.test(st.border), st.border);
});
