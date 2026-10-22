/*
 * stage093.nudge.test.js — 0.9.3 Task M-3（計画 docs/plans/2026-10-22-093.md の決めたこと 9・10。持ち主の答え Q3・Q4・D50・D54）
 * 会議の検出のパネル（src/renderer/nudge.html）を最小 DOM（helpers/simrun.js）の上で本当に走らせる。main の口は偽物（preload.js の名前から作る）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');

const ROOT = path.join(__dirname, '..');
const NUDGE = path.join(ROOT, 'src', 'renderer', 'nudge.html');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const html = fs.readFileSync(NUDGE, 'utf8');
const doc = parseHTML(html).root;
const rules = S.parse(doc.querySelectorAll('style').map((s) => s._raw).join('\n'));
const selOf = (r) => String(r.sel || '').split(',').map((x) => x.trim());
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const open = async () => { const l = await load(NUDGE, { preloadSrc: PRELOAD }); await l.drain(); return l; };
const $ = (l, id) => l.byId.get(id);
const click = async (l, id) => { $(l, id).dispatchEvent({ type: 'click' }); await l.drain(); };
const sizes = (l) => l.called('reportSize').map((c) => c.args[0]);

test('D50: パネルとメニューに select・会議の種類の言葉が無い。Q4: 1行目は「AI 議事録を始める」、下の行は「文字起こしで NaTsu を開く」、青いボタンは［文字起こしを始める］', T, () => {
  assert.strictEqual(doc.querySelectorAll('select').length, 0);
  for (const w of ['会議の種類', '要約タイプ', 'メモの型']) assert.ok(!html.includes(w), w);
  assert.strictEqual(norm(doc.querySelector('#nzTitle').textContent), 'AI 議事録を始める');
  assert.strictEqual(norm(doc.querySelector('#nzSub').textContent), '文字起こしで NaTsu を開く');
  assert.strictEqual(norm(doc.querySelector('#nzStart').textContent), '文字起こしを始める');
  assert.strictEqual(doc.querySelector('#nzMore').getAttribute('aria-label'), 'ほかの始め方');
  assert.strictEqual(doc.querySelector('#nzClose').getAttribute('aria-label'), '閉じる');
});

test('D54: メニューは「オフラインモードで始める」（下の小さな文が無い）・「<アプリ> では出さない」・線・「会議の検出の通知の設定…」の順', T, () => {
  const menu = doc.querySelector('#nzMenu');
  assert.strictEqual(menu.getAttribute('role'), 'menu');
  const items = menu.querySelectorAll('[role="menuitem"]');
  assert.deepStrictEqual(items.map((b) => b.id), ['nzPcOnly', 'nzMute', 'nzSettings']);
  assert.strictEqual(norm(items[0].textContent), 'オフラインモードで始める');
  assert.ok(!items[0].querySelector('.sub') && items[0].querySelectorAll('span').length <= 1, 'オフラインモードの項目に下の小さな文がある');
  assert.strictEqual(norm(items[2].textContent), '会議の検出の通知の設定…');
  assert.ok(menu.querySelector('.hr'), '線が無い');
  assert.ok(!html.includes('PC の中だけ'), 'パネルに古い名前がある');
});

test('onShow の label を「<label> では出さない」に textContent で入れる（HTML にしない）。Q3: theme が light なら明るい形、ほかは暗い形', T, async () => {
  const l = await open();
  l.fire('onShow', { label: 'Zoom', theme: 'light' });
  await l.drain();
  assert.strictEqual(norm($(l, 'nzMute').textContent), 'Zoom では出さない');
  assert.strictEqual(norm($(l, 'nzSub').textContent), '文字起こしで NaTsu を開く', 'Q4: 下の行にアプリの名前を入れた');
  assert.ok($(l, 'nz').classList.contains('light'));
  l.fire('onShow', { label: '<b>x</b>', theme: 'dark' });
  await l.drain();
  assert.strictEqual($(l, 'nzMuteLabel').textContent, '<b>x</b> では出さない');
  assert.strictEqual($(l, 'nzMuteLabel').children.length, 0, 'label を HTML にした');
  assert.ok(!$(l, 'nz').classList.contains('light'));
  for (const bad of [{ label: 'Teams', theme: 'pink' }, { label: 7 }, null, 'x']) {
    l.fire('onShow', bad);
    await l.drain();
    assert.ok(!$(l, 'nz').classList.contains('light'), JSON.stringify(bad));
  }
  assert.strictEqual($(l, 'nzMuteLabel').textContent, ' では出さない');
  assert.deepStrictEqual(l.errors, []);
});

test('［文字起こしを始める］は start(false)、オフラインモードは start(true)、出さないは mute()（引数なし）、設定は openSettings()、× は close()', T, async () => {
  const l = await open();
  l.fire('onShow', { label: 'Zoom', theme: 'dark' });
  await click(l, 'nzStart');
  await click(l, 'nzMore');
  await click(l, 'nzPcOnly');
  await click(l, 'nzMore');
  await click(l, 'nzMute');
  await click(l, 'nzMore');
  await click(l, 'nzSettings');
  await click(l, 'nzClose');
  assert.deepStrictEqual(l.called('start').map((c) => c.args), [[false], [true]]);
  assert.deepStrictEqual(l.called('mute').map((c) => c.args), [[]]);
  assert.deepStrictEqual(l.called('openSettings').map((c) => c.args), [[]]);
  assert.deepStrictEqual(l.called('close').map((c) => c.args), [[]]);
  assert.strictEqual($(l, 'nzMenu').hidden, true, '項目を押した後もメニューが開いている');
});

test('⌄ でメニューを開け閉めし（aria-expanded）、開くと閉じると reportSize を送り直す。メニューの外を押すと閉じる。起動で大きさを送る', T, async () => {
  const l = await open();
  assert.strictEqual(l.called('onShow').length, 1, '起動で onShow を受けていない');
  $(l, 'nz')._rect = { width: 520, height: 60 };
  l.fire('onShow', { label: 'Zoom', theme: 'dark' });
  await l.drain();
  assert.deepStrictEqual(sizes(l).pop(), { w: 520, h: 60 });
  $(l, 'nz')._rect = { width: 520, height: 200 };
  await click(l, 'nzMore');
  assert.strictEqual($(l, 'nzMenu').hidden, false);
  assert.strictEqual($(l, 'nzMore').getAttribute('aria-expanded'), 'true');
  assert.deepStrictEqual(sizes(l).pop(), { w: 520, h: 200 });
  $(l, 'nz')._rect = { width: 520, height: 60 };
  await click(l, 'nzMore');
  assert.strictEqual($(l, 'nzMenu').hidden, true);
  assert.strictEqual($(l, 'nzMore').getAttribute('aria-expanded'), 'false');
  assert.deepStrictEqual(sizes(l).pop(), { w: 520, h: 60 });
  // 外（カードの文字）を押すと閉じる。メニューの中・⌄ を押しても外とみなさない
  $(l, 'nz')._rect = { width: 520, height: 200 };
  await click(l, 'nzMore');
  l.key({ type: 'pointerdown' }, $(l, 'nzMenu'));
  assert.strictEqual($(l, 'nzMenu').hidden, false);
  l.key({ type: 'pointerdown' }, $(l, 'nzTitle'));
  await l.drain();
  assert.strictEqual($(l, 'nzMenu').hidden, true);
  // 出し直すと閉じた形から
  await click(l, 'nzMore');
  l.fire('onShow', { label: 'Teams', theme: 'dark' });
  await l.drain();
  assert.strictEqual($(l, 'nzMenu').hidden, true);
  assert.deepStrictEqual(l.errors, []);
});

test('カーソルが乗ると hover(true)、離れると hover(false)', T, async () => {
  const l = await open();
  $(l, 'nz').dispatchEvent({ type: 'mouseenter' });
  $(l, 'nz').dispatchEvent({ type: 'mouseleave' });
  await l.drain();
  assert.deepStrictEqual(l.called('hover').map((c) => c.args), [[true], [false]]);
});

test('WIN-02・Q3・K9: html と body の地は透明。外向きの box-shadow を使わない。明るい形の影は .card の疑似要素の半透明の地（輪を2つ）', T, () => {
  const htmlBody = rules.filter((r) => selOf(r).some((x) => /\bhtml\b|\bbody\b/.test(x)));
  assert.ok(htmlBody.some((r) => /transparent/.test(r.decls.background || r.decls['background-color'] || '')));
  for (const r of rules) {
    const v = r.decls['box-shadow'];
    if (v !== undefined) assert.match(v, /^\s*(inset|none)/, `${r.sel} に外向きの影`);
    assert.ok(!/blur|drop-shadow/.test((r.decls && r.decls.filter) || ''), String(r.selectors));
  }
  for (const pseudo of ['::before', '::after']) {
    const r = rules.find((x) => selOf(x).includes(`.nz.light .card${pseudo}`));
    assert.ok(r, `明るい形の ${pseudo} の輪が無い`);
    assert.match(r.decls.background, /^rgba\(/, pseudo);
    assert.strictEqual(r.decls['z-index'], '-1', pseudo);
  }
  const card = rules.find((x) => selOf(x).includes('.card') && !x.at);
  assert.strictEqual(card.decls.position, 'relative');
  assert.strictEqual(card.decls['z-index'], undefined, '.card が重なりの文脈を作ると、影の輪がカードの地の上に描かれる');
  const light = rules.find((x) => selOf(x).includes('.nz.light') && !x.at);
  assert.strictEqual(light.decls['--nz-bg'], '#ffffff', '明るいパネルの地が白でない');
  const dark = rules.find((x) => selOf(x).includes('.nz') && !x.at);
  assert.strictEqual(dark.decls['--nz-bg'], '#262626', '暗いパネルの地が録音バーと同じでない');
});
