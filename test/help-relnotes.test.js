/* help-relnotes.test.js — ヘルプセンターのリリースノート（計画 docs/plans/2026-10-23-help-relnotes.md の RN1〜RN4・RNF1〜RNF5）
 *
 * 中身は CHANGELOG.md だけ。見出しの形・版の並び・日付・まだ出していない版・本文の変換（記事と同じ help-md）・公開前の確認を、
 * 本物の CHANGELOG.md と、崩した小さな写しで確かめる。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const R = require('../tools/lib/help-relnotes');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** release.yml の本文の取り方の写し（test/identity.test.js の releaseBody と同じ） */
function releaseBody(cl, tag) {
  const re = new RegExp(`^## +${tag}([ \\t]|$)`);
  const out = [];
  let on = false;
  for (const l of cl.replace(/\r\n?/g, '\n').split('\n')) {
    if (!on) { if (re.test(l)) on = true; continue; }
    if (/^## /.test(l)) break;
    out.push(l);
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
/** 小さな写し: 頭の説明と、与えた見出しと本文の節 */
const mini = (...secs) => ['# 変更履歴', '', '説明。', '', ...secs.flatMap(([h, b]) => [h, '', ...(b === undefined ? ['- 直しました。'] : b.split('\n')), ''])].join('\n');
const errOf = (text) => { try { R.renderRelnotes(R.parseChangelog(text)); return null; } catch (e) { return e; } };

test('RN-2（RN1・RN4）: 本物の CHANGELOG.md の版は上から新しい順で、どれも日付つき。ページに出す版の本文は、release.yml が取るリリース本文（アプリの［設定］→［更新］の文）とちょうど同じ（RNF4）', { timeout: 5000 }, () => {
  const cl = read('CHANGELOG.md');
  const secs = R.parseChangelog(cl);
  assert.ok(secs.length >= 16);
  assert.deepStrictEqual(secs.slice(-3).map((s) => s.version), ['0.1.2', '0.1.1', '0.1.0']);
  for (const s of secs) {
    assert.strictEqual(s.body, releaseBody(cl, `natsu-v${s.version}`), `${s.version}: 本文がリリース本文と違う`);
    assert.match(cl.split(/\r?\n/)[s.line - 1], new RegExp(`^## natsu-v${s.version.replace(/\./g, '\\.')}( |$)`), `${s.version}: 見出しの行の番号`);
  }
  const shown = R.renderRelnotes(secs);
  const want = secs.filter((s) => s.date).map((s) => s.version);
  assert.deepStrictEqual(shown.map((v) => v.version), want, '出す版の数・並びが CHANGELOG の日付のある節と違う');
  assert.ok(shown.length >= 16);
  const v010 = shown.find((v) => v.version === '0.10.0');
  assert.deepStrictEqual([v010.date, v010.id], ['2026-10-23', 'v0-10-0']);
  assert.match(v010.html, /<strong>Claude から議事録を読めるようになりました。<\/strong>/);
  for (const v of shown) assert.ok(!/<script|\sstyle=|\son[a-z]+=|javascript:/i.test(v.html), `${v.version}: 危ない HTML`);
});

test('RN-2（RN4・参考 1・2）: 見出しの形は2つだけ。版が新しい順でない・同じ版が2回・実在しない日付・上の版より新しい日付・空白の無い全角の括弧・日付の無い節が一番上でない、は作るのを止め、CHANGELOG.md の行を出す', { timeout: 5000 }, () => {
  const ok = mini(['## natsu-v0.2.0', '- まだ出していない版。'], ['## natsu-v0.1.1 （2026-10-18）'], ['## natsu-v0.1.0 （2026-10-17）']);
  assert.deepStrictEqual(R.parseChangelog(ok).map((s) => [s.version, s.date]), [['0.2.0', null], ['0.1.1', '2026-10-18'], ['0.1.0', '2026-10-17']]);
  assert.deepStrictEqual(R.parseChangelog(mini(['## natsu-v0.1.1 （2026-10-17）'], ['## natsu-v0.1.0 （2026-10-17）'])).length, 2, '同じ日の2つの版は通す');
  const bad = [
    ['順の逆', mini(['## natsu-v0.1.0 （2026-10-17）'], ['## natsu-v0.1.1 （2026-10-18）']), 9],
    ['同じ版が2回', mini(['## natsu-v0.1.0 （2026-10-17）'], ['## natsu-v0.1.0 （2026-10-17）']), 9],
    ['実在しない日付', mini(['## natsu-v0.1.1 （2026-02-30）'], ['## natsu-v0.1.0 （2026-02-01）']), 5],
    ['上の版より新しい日付', mini(['## natsu-v0.1.1 （2026-10-17）'], ['## natsu-v0.1.0 （2026-10-18）']), 9],
    ['空白の無い全角の括弧', mini(['## natsu-v0.1.0（2026-10-17）']), 5],
    ['日付の形', mini(['## natsu-v0.1.0 （2026/10/17）']), 5],
    ['知らない見出し', mini(['## 0.1.0']), 5],
    ['日付の無い節が一番上でない', mini(['## natsu-v0.1.1 （2026-10-18）'], ['## natsu-v0.1.0']), 9],
  ];
  for (const [why, text, line] of bad) {
    const e = errOf(text);
    assert.ok(e && e.name === 'HelpBuildError', `${why}: 止めない`);
    assert.strictEqual(e.code, 'bad-changelog', why);
    assert.strictEqual(e.file, 'CHANGELOG.md', why);
    assert.strictEqual(e.line, line, `${why}: 行`);
  }
  assert.strictEqual(errOf('# 変更履歴\n\n説明だけ。\n').code, 'bad-changelog', '版の節が1つも無いのに通した');
});

test('RN-2（F・RNF2）: 日付の無い節（まだ出していない版）はページに出さない。日付のある節だけを、上から新しい順で出す', { timeout: 5000 }, () => {
  const shown = R.renderRelnotes(R.parseChangelog(mini(['## natsu-v0.2.0', '- まだ出していない版。'], ['## natsu-v0.1.0 （2026-10-17）', '- 出した版。'])));
  assert.deepStrictEqual(shown.map((v) => [v.version, v.date, v.id]), [['0.1.0', '2026-10-17', 'v0-1-0']]);
  assert.ok(!shown.some((v) => v.html.includes('まだ出していない版')));
});

test('RN-2（C・RNF3）: 本文は記事と同じ help-md で変換する（太字・コード・入れ子の箇条書き・［…］）。生の HTML・javascript: のリンク・閉じていない ** は作るのを止め、CHANGELOG.md の行を出す', { timeout: 5000 }, () => {
  const [v] = R.renderRelnotes(R.parseChangelog(mini(['## natsu-v0.1.0 （2026-10-17）', '頭の段落。［設定］を押します。\n\n- **太字** と `a < b`\n  1. 入れ子の1\n  2. 入れ子の2'])));
  assert.strictEqual(v.html, '<p>頭の段落。［設定］を押します。</p>\n<ul>\n<li><strong>太字</strong> と <code>a &lt; b</code>\n<ol>\n<li>入れ子の1</li>\n<li>入れ子の2</li>\n</ol></li>\n</ul>');
  const bad = [
    ['生の HTML', mini(['## natsu-v0.1.1 （2026-10-18）'], ['## natsu-v0.1.0 （2026-10-17）', '一行目。\n\n<b>太い</b> 文字']), 13],
    ['javascript: のリンク', mini(['## natsu-v0.1.0 （2026-10-17）', '[押す](javascript:alert(1))']), 7],
    ['閉じていない **', mini(['## natsu-v0.1.0 （2026-10-17）', '- **閉じていない']), 7],
  ];
  for (const [why, text, line] of bad) {
    const e = errOf(text);
    assert.ok(e && e.name === 'HelpBuildError', `${why}: 止めない`);
    assert.strictEqual(e.file, 'CHANGELOG.md', why);
    assert.strictEqual(e.line, line, `${why}: CHANGELOG.md の行でない`);
  }
});

test('RN-5（G-21）: 公開前の確認（チームのドメイン・64 字の16進・個人の Windows のパス・半角の @ のメール）に当たる字面が CHANGELOG.md にあれば作るのを止める。本物の CHANGELOG.md は通る', { timeout: 5000 }, () => {
  const team = ['natsu', 'test.cloudflareaccess.com'].join('-');
  const bad = [`住所は https://${team}/ です。`, `AUD は ${'ab'.repeat(32)} です。`, `場所は ${['C:', 'Users', 'someone', 'x'].join('\\')} です。`, `連絡は ${['someone', 'example.com'].join('@')} へ。`];
  for (const b of bad) {
    const e = errOf(mini(['## natsu-v0.1.0 （2026-10-17）', `- ${b}`]));
    assert.ok(e && e.code === 'bad-changelog' && e.line === 7, `止めない: ${b}`);
  }
  assert.doesNotThrow(() => R.parseChangelog(read('CHANGELOG.md')));
});

test('RN-2（RN4）: 次の版（例 0.10.1）を本物の CHANGELOG.md の一番上に足しても通る。日付つきならページの先頭に出し、日付が無ければ出さない。0.10.0 より前の日付は止める', { timeout: 5000 }, () => {
  const cl = read('CHANGELOG.md');
  const at = cl.indexOf('\n## natsu-v');
  assert.ok(at > 0);
  const add = (h) => `${cl.slice(0, at + 1)}${h}\n\n- 直しました。\n\n${cl.slice(at + 1)}`;
  const top = R.parseChangelog(cl)[0];
  const [a, b, c] = top.version.split('.').map(Number);
  const next = `${a}.${b}.${c + 1}`;
  const dated = R.renderRelnotes(R.parseChangelog(add(`## natsu-v${next} （${top.date}）`)));
  assert.deepStrictEqual([dated[0].version, dated[0].date, dated[1].version], [next, top.date, top.version]);
  assert.deepStrictEqual(R.renderRelnotes(R.parseChangelog(add(`## natsu-v${next}`)))[0].version, top.version);
  const e = errOf(add(`## natsu-v${next} （2026-01-01）`));
  assert.ok(e && e.code === 'bad-changelog' && e.line === cl.slice(0, at + 1).split('\n').length + 4, '上の版の日付が下の版より古いのに通した');
});
