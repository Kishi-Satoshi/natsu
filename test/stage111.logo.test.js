/*
 * stage111.logo.test.js — 0.11.1 ロゴの差し替え（計画 docs/plans/2026-10-24-logo.md の Task LG-4）: 画面の中のロゴ
 *
 *  - RF-LG2: app（サイドバーの頭）・overlay（録音バー）・nudge（会議の知らせのパネル）のロゴの SVG は2本の path（箱・リス）で、
 *    d が assets/icon.svg と1文字も違わない（写しが食い違わない。色は CSS で場所ごとに決める）
 *  - LG2 (a)・RF-LG3: 暗い所は白い箱に黒いリス。サイドバーは明るい画面で黒い箱・暗い画面で白い箱（CSS だけ）、
 *    録音バーは暗いピルなのでいつも白い箱、パネルは明るいとき（.nz.light）黒い箱・暗いとき（.light の外）白い箱。
 *    どこでも、箱と地・リスと箱の明るさの比が 3:1 以上
 *  - LG3 (a): ロゴから海の色の波を外す。録音中の点・処理中の輪の海の色は残す
 *
 * 依存は足さない（テストの台の simcss だけ）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('./helpers/simcss');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const FILES = ['src/renderer/app.html', 'src/renderer/overlay.html', 'src/renderer/nudge.html'];
const DARK = '@media (prefers-color-scheme: dark)';
const ICON_D = [...read('assets/icon.svg').matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
const rulesOf = (f) => S.parse([...read(f).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n'));
const logoSvgs = (f) => [...read(f).matchAll(/<svg\b[^>]*\bclass="logo"[^>]*>([\s\S]*?)<\/svg>/g)].map((m) => m[1]);
const pathsIn = (body) => [...body.matchAll(/<path\b([^>]*)>/g)].map((m) => {
  const a = {};
  for (const x of m[1].matchAll(/([\w:-]+)="([^"]*)"/g)) a[x[1]] = x[2];
  return a;
});
const hex = (c) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

test('LG-4 RF-LG2: app・overlay・nudge のロゴの SVG は1つずつで、2本の path（箱 .logo-box・リス .logo-sq の順）の d が assets/icon.svg と1文字も違わない。色は CSS で決める（塗りの属性を持たない）', () => {
  assert.strictEqual(ICON_D.length, 2, 'assets/icon.svg の path が2本でない');
  for (const f of FILES) {
    const svgs = logoSvgs(f);
    assert.strictEqual(svgs.length, 1, `${f} のロゴの SVG が1つでない`);
    const ps = pathsIn(svgs[0]);
    assert.deepStrictEqual(ps.map((p) => p.class), ['logo-box', 'logo-sq'], `${f} の path の組`);
    assert.deepStrictEqual(ps.map((p) => p.d), ICON_D, `${f} のロゴの d が assets/icon.svg と違う`);
    for (const p of ps) assert.ok(!('fill' in p) && !('stroke' in p) && !('style' in p), `${f} の ${p.class} が色の属性を持つ（色は CSS で場所ごとに決める）`);
  }
});

// サイドバー: 箱は .logo の color（文字の色 --text）・リスはサイドバーの地（--side）。暗い画面はトークンの上書き（prefers-color-scheme）だけで切り替わる。
// 計画の「[data-theme=dark] と prefers-color-scheme の両方」は、app.html に data-theme が無い（設定の配色は main が nativeTheme.themeSource を
// 切り替え、prefers-color-scheme がそのまま反応する）ので、prefers-color-scheme の明と暗の2つで見る（Ruling R11）
test('LG-4 LG2 (a)・RF-LG3: サイドバーのロゴは、明るい画面で黒い箱・暗い画面で白い箱。箱はサイドバーの地と、リスは箱と 3:1 以上（CSS だけで切り替わる）', () => {
  const rules = rulesOf('src/renderer/app.html');
  const logo = S.declsFor(rules, '.logo', { at: '' });
  const box = S.declsFor(rules, '.logo .logo-box', { at: '' });
  const sq = S.declsFor(rules, '.logo .logo-sq', { at: '' });
  const side = S.declsFor(rules, '.side', { at: '' });
  assert.strictEqual(box.fill, 'currentColor', '箱の塗りが .logo の色（文字の色）でない');
  for (const at of ['', DARK]) {
    const name = at ? '暗い画面' : '明るい画面';
    const ink = S.parseColor(S.resolveVar(rules, logo.color, at));
    const sqc = S.parseColor(S.resolveVar(rules, sq.fill, at));
    const ground = S.parseColor(S.resolveVar(rules, side.background, at));
    assert.ok(ink && sqc && ground, `${name}: 色が読めない`);
    assert.ok(S.contrast(ink, ground) >= 3, `${name}: 箱 ${hex(ink)} とサイドバーの地 ${hex(ground)} の比 ${S.contrast(ink, ground).toFixed(2)}（3 以上）`);
    assert.ok(S.contrast(sqc, ink) >= 3, `${name}: リス ${hex(sqc)} と箱 ${hex(ink)} の比 ${S.contrast(sqc, ink).toFixed(2)}（3 以上）`);
    if (at) assert.ok(S.luminance(ink) > S.luminance(sqc), `${name}: 箱が白くない（箱 ${hex(ink)}・リス ${hex(sqc)}）`);
    else assert.ok(S.luminance(ink) < S.luminance(sqc), `${name}: 箱が黒くない（箱 ${hex(ink)}・リス ${hex(sqc)}）`);
  }
  // 暗い画面の上書きはトークンだけ（ロゴの規則を @media の中に書かない: COLOR-03）
  assert.deepStrictEqual(rules.filter((r) => r.at && /\.logo\b/.test(r.sel)).map((r) => r.sel), []);
});

test('LG-4 LG6・LG2 (a)・RF-LG3: 録音バーのロゴは、いつも白い箱に黒いリス（リスはピルの地の色）。箱はピルの地と 3:1 以上', () => {
  const rules = rulesOf('src/renderer/overlay.html');
  const box = S.parseColor(S.resolveVar(rules, S.declsFor(rules, '.logo .logo-box', { at: '' }).fill));
  const sq = S.parseColor(S.resolveVar(rules, S.declsFor(rules, '.logo .logo-sq', { at: '' }).fill));
  const pill = S.firstColor(S.resolveVar(rules, S.declsFor(rules, '.pill', { at: '' }).background));
  assert.ok(box && sq && pill, '色が読めない');
  assert.deepStrictEqual(box, [255, 255, 255, 1], `箱が白でない（${hex(box)}）`);
  assert.deepStrictEqual(sq, pill, `リス ${hex(sq)} がピルの地 ${hex(pill)} と違う`);
  assert.ok(S.contrast(box, pill) >= 3, `箱とピルの地の比 ${S.contrast(box, pill).toFixed(2)}`);
  // 明るいデスクトップでも同じ暗いピルなので、明暗でロゴの色を替えない
  assert.deepStrictEqual(rules.filter((r) => r.at && /\.logo\b/.test(r.sel)).map((r) => r.sel), []);
});

// パネルの明暗は main が送る .nz の light（無ければ録音バーと同じ暗い地）。色の変数は .nz と .nz.light に書く
test('LG-4 LG2 (a)・RF-LG3: 会議の知らせのパネルのロゴは、明るいとき（.nz.light）黒い箱・暗いとき（.light の外）白い箱。リスはパネルの地', () => {
  const rules = rulesOf('src/renderer/nudge.html');
  const darkVars = S.declsFor(rules, '.nz', { at: '' });
  const lightVars = { ...darkVars, ...S.declsFor(rules, '.nz.light', { at: '' }) };
  const solve = (v, vars) => String(v).replace(/var\((--[\w-]+)\)/g, (_, k) => { assert.ok(vars[k], `${k} が無い`); return vars[k]; });
  const boxFill = S.declsFor(rules, '.logo .logo-box', { at: '' }).fill;
  const sqFill = S.declsFor(rules, '.logo .logo-sq', { at: '' }).fill;
  for (const [name, vars, white] of [['暗いとき', darkVars, true], ['明るいとき', lightVars, false]]) {
    const box = S.parseColor(solve(boxFill, vars)), sq = S.parseColor(solve(sqFill, vars)), ground = S.parseColor(solve('var(--nz-bg)', vars));
    assert.ok(box && sq && ground, `${name}: 色が読めない`);
    assert.deepStrictEqual(sq, ground, `${name}: リス ${hex(sq)} がパネルの地 ${hex(ground)} と違う`);
    assert.ok(S.contrast(box, ground) >= 3, `${name}: 箱 ${hex(box)} と地 ${hex(ground)} の比 ${S.contrast(box, ground).toFixed(2)}`);
    assert.deepStrictEqual(box, white ? [255, 255, 255, 1] : [17, 17, 17, 1], `${name}: 箱 ${hex(box)}`);
  }
});

test('LG-4 LG3 (a): ロゴから海の色の波を外した（.logo .wave の規則と、ロゴの中の #0e8cae が無い）。録音中の点・処理中の輪は海の色のまま', () => {
  for (const f of FILES) {
    assert.ok(!/\.logo \.wave/.test(read(f)), `${f} に .logo .wave が残っている`);
    assert.ok(!/0e8cae|class="wave"/.test(logoSvgs(f).join('')), `${f} のロゴに海の色の波が残っている`);
  }
  const app = rulesOf('src/renderer/app.html');
  assert.strictEqual(S.declsFor(app, '.rec-dot', { at: '' }).background, 'var(--level)');
  assert.strictEqual(S.tokens(app, '')['--level'], '#0e8cae');
  const ovl = rulesOf('src/renderer/overlay.html');
  assert.match(S.declsFor(ovl, '.spin', { at: '' })['border-top-color'], /var\(--sea\)/);
  assert.strictEqual(S.tokens(ovl, '')['--sea'], '#0e8cae');
});
