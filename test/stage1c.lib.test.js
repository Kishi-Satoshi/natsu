/*
 * stage1c.lib.test.js — 第1c回の mainlib の純粋な関数（Claude Code に渡す文・経路の表示）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const L = require('../src/mainlib');

test('F9: Claude Code に渡す文は、手元の LLM の1回で要約する頼みの文と同じ（main.js の文字から確かめる）', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  const m = /content: `\$\{memoBlock\}【会議の文字起こし】\\n\$\{plain\}\\n\\n(上記から、次の構成のMarkdown議事録を作成してください。見出しはこの通りに使い、本文だけを出力してください。)\\n\\n\$\{minutesTemplate\(type\)\}`/.exec(main);
  assert.ok(m, 'generateMinutes の1回で要約する頼みの文が見つからない（文を変えたなら buildClaudeInput も同じに直す）');
  const out = L.buildClaudeInput({ memoText: '議題: 予算', plain: '本日の議題は進捗の確認です。', template: '## 概要\n（要約）' });
  assert.strictEqual(out, `【会議メモ・アジェンダ（要約のヒント）】\n議題: 予算\n\n【会議の文字起こし】\n本日の議題は進捗の確認です。\n\n${m[1]}\n\n## 概要\n（要約）`);
  assert.ok(!L.buildClaudeInput({ memoText: '', plain: 'x', template: 't' }).includes('会議メモ'));
});

test('OL6: 経路の表示の行', () => {
  assert.deepStrictEqual(L.routeLabel({ stt: { cloud: 12, local: 2, provider: 'groq' }, summary: { by: 'claude-code' } }, 'Groq（無料枠）'),
    ['☁ 文字起こし: クラウド（Groq（無料枠））12・PC 2', '✨ 要約: Claude Code']);
  assert.deepStrictEqual(L.routeLabel({ stt: { cloud: 0, local: 3, provider: 'groq' }, summary: { by: 'local' } }, 'Groq（無料枠）'),
    ['🖥 文字起こし: PC', '🖥 要約: PC（オフライン）']);
  assert.deepStrictEqual(L.routeLabel({ stt: { cloud: 5, local: 0, provider: 'openai' } }, 'OpenAI'), ['☁ 文字起こし: クラウド（OpenAI）5']);
  assert.deepStrictEqual(L.routeLabel(undefined, 'x'), []);
  assert.deepStrictEqual(L.routeLabel({ stt: 'x', summary: 3 }, 'x'), [], '形の違う欄で落ちた');
});
