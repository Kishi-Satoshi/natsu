/*
 * limits.test.js — 上限の値（第1a回 G3 の「上限」。変えるなら意図を書いて、このテストと一緒に直す）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

test('MEMO_MAX: 会議のメモは 1500 字で切ってから要約の頼みに前置きする（長いメモで文字起こしが文脈から押し出されない）', { timeout: 5000 }, () => {
  assert.match(main, /^const MEMO_MAX = 1500;$/m);
  assert.ok(main.includes("const memoText = String(memo || '').trim().slice(0, MEMO_MAX);"), 'メモを上限で切っていない');
});
