/*
 * stage1b2.look.test.js — 第1b2回の見た目（測った値のトークン・青と海の色の約束・書体・部品の形）とサイドバー・検索の窓（L-2）
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
const rules = S.parse(parseHTML(html).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
const DARK = '@media (prefers-color-scheme: dark)';
const light = S.tokens(rules, '');
const dark = { ...light, ...S.tokens(rules, DARK) };
const norm = (v) => String(v).replace(/\s/g, '').toLowerCase();
const BODY = '"Segoe UI Variable Text", "Segoe UI", "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", sans-serif';

test('1b2 L-1: トークンは測った参考の値（4.5:1 に届かないものは直した値）', () => {
  const want = {
    '--bg': ['#ffffff', '#191919'], '--side': ['#f9f8f7', '#202020'], '--text': ['#2c2c2b', '#f0efed'],
    '--text-2': ['#5f5e59', '#bcbab6'], '--muted': ['#6d6a66', '#ada9a3'],
    '--line': ['rgba(28,19,1,.11)', 'rgba(255,255,235,.1)'], '--hover': ['rgba(33,27,23,.051)', 'rgba(255,255,255,.055)'],
    '--tint': ['rgba(33,27,23,.06)', 'rgba(255,255,235,.1)'], '--accent': ['#2077ce', '#2077ce'], '--on-accent': ['#ffffff', '#ffffff'],
    '--accent-text': ['#1d6cba', '#5ba3e9'], '--danger': ['#b8352c', '#ff7a70'], '--ok': ['#1a6e42', '#4cc98a'],
    '--level': ['#0e8cae', '#0e8cae'], '--scrim': ['rgba(15,15,15,.25)', 'rgba(0,0,0,.5)'] };
  for (const [k, [l, d]] of Object.entries(want)) {
    assert.strictEqual(norm(light[k]), l, `明の ${k}`);
    assert.strictEqual(norm(dark[k]), d, `暗の ${k}`);
  }
});

test('1b2 L-1・G8: 海の色（--level）はロゴの波と録音中の点だけ。選んでいる行は灰色の地で、左の線も青も持たない', () => {
  const users = new Set(rules.filter((r) => !r.sel.startsWith(':root') && Object.values(r.decls).some((v) => /var\(--level\)/.test(v))).map((r) => r.sel));
  assert.deepStrictEqual([...users].sort(), ['.logo .wave', '.rec-dot']);
  const sel = S.declsFor(rules, '.pitem.sel', { at: '' });
  assert.strictEqual(sel.background, 'var(--tint)');
  assert.ok(!/accent|level/.test(Object.values(sel).join(' ')), JSON.stringify(sel));
  assert.ok(!sel['border-left'] || /none|transparent/.test(sel['border-left']), '選んでいる行に左の線が残っている');
});

test('1b2 L-1・G8: 青（--accent）は主ボタン・フォーカスの輪と入力中の枠・入った印・進み具合・落とし先の線・当たった区間・更新の点だけ', () => {
  const OK = /^(button\.action|#updBadge (button\.go|\.dot))|:focus|\.check input:checked|\.blk\.dropmark|\.seg\.(hit|editing)|\.atag-edit|#engineFetchBar/;
  for (const r of rules) {
    if (r.sel.startsWith(':root')) continue;
    for (const [k, v] of Object.entries(r.decls)) {
      if (k === 'accent-color' || !/var\(--accent\)/.test(v)) continue;
      for (const s of r.sel.split(',')) assert.match(s.trim(), OK, `${r.sel} { ${k}: ${v} } に青`);
    }
  }
});

test('1b2 L-1: 書体は Segoe UI Variable から（題名は Display）。NaTsu の文字はゴシックの 14px・600', () => {
  assert.strictEqual(S.declsFor(rules, 'body', { at: '' })['font-family'], BODY);
  assert.strictEqual(S.declsFor(rules, '.ptitle', { at: '' })['font-family'], BODY.replace('"Segoe UI Variable Text"', '"Segoe UI Variable Display"'));
  const w = S.declsFor(rules, '.wordmark', { at: '' });
  assert.ok(!/Georgia|Mincho|(^|,\s*)serif/i.test(w['font-family'] || ''), `明朝が残っている: ${w['font-family']}`);
  assert.deepStrictEqual([w['font-size'], w['font-weight']], ['14px', '600']);
  assert.ok(html.includes('<div class="wordmark">NaTsu</div>'), '文字と class は今のまま（identity.test）');
});

test('1b2 L-1: ボタンは高さ 28px・角丸 6px・500。入力欄は角丸 6px。スクロールバーは OS の標準（独自のつまみを描かない）', () => {
  for (const sel of ['button.action', 'button.ghost']) {
    const d = S.declsFor(rules, sel, { at: '' });
    assert.deepStrictEqual([d.height, d['border-radius'], d['font-weight']], ['28px', '6px', '500'], sel);
  }
  assert.strictEqual(S.declsFor(rules, 'input[type="text"]', { at: '' })['border-radius'], '6px');
  assert.ok(!rules.some((r) => /::-webkit-scrollbar/.test(r.sel)), '独自のスクロールバーが残っている');
});
