/*
 * stage094.wave.test.js — 0.9.4 Task W-1（計画 docs/plans/2026-10-22-094.md の3回目の節「Task W-1（作り直し）」・モック 2）: 5本がそれぞれ揺れる波
 * 持ち主の言葉「音の波が左側に寄ってしまうのはなぜでしょうか？バランスよくできませんか？」→「5本がそれぞれ揺れる」。録音バーと録音中のページで同じ式
 * （mainlib.levelBars。overlay.html と app.html は main のファイルを読めないので同じ式を写し、同じ値になることをここで見る）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../src/mainlib');
const { load } = require('./helpers/simrun.js');

const T = { timeout: 5000 };
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const pick = (src) => {
  const m = /\n {2}(const LEVEL_BAR_[\s\S]*?\n {2}function levelBars\(level, tMs\) \{[\s\S]*?\n {2}\})\n/.exec(src);
  assert.ok(m, 'levelBars が無い');
  return Function(`${m[1]}; return levelBars;`)();   // eslint-disable-line no-new-func
};

test('levelBars の表: 無音（0.02 以下・数でない）は同じ点が5つ。声は5本がそれぞれ違う速さで揺れ、4〜16px。止めた形（null）は左右対称', T, () => {
  assert.deepStrictEqual(lib.levelBars(0, 0), [4, 4, 4, 4, 4]);
  assert.deepStrictEqual(lib.levelBars(0.02, 1234), [4, 4, 4, 4, 4]);
  assert.deepStrictEqual(lib.levelBars(NaN, 0), [4, 4, 4, 4, 4]);
  assert.deepStrictEqual(lib.levelBars('0.5', 0), [4, 4, 4, 4, 4]);
  assert.deepStrictEqual(lib.levelBars(0.6, 0), [9, 14, 13, 11, 13]);
  assert.deepStrictEqual(lib.levelBars(0.6, 180), [13, 10, 15, 13, 10]);
  assert.deepStrictEqual(lib.levelBars(0.6, 420), [8, 11, 8, 9, 12]);
  for (const t of [0, 90, 180, 420, 1000, 5000]) for (const l of [0.03, 0.3, 0.6, 1, 5]) {
    const b = lib.levelBars(l, t);
    assert.ok(b.length === 5 && b.every((h) => Number.isInteger(h) && h >= 4 && h <= 16), `${l} ${t}: ${b}`);
  }
  // 重みは左右対称（左に寄らない）・速さと位相は5本とも違う（それぞれ揺れる）
  assert.deepStrictEqual(lib.LEVEL_BAR_W, [...lib.LEVEL_BAR_W].reverse());
  assert.strictEqual(new Set(lib.LEVEL_BAR_SPEED).size, 5);
  assert.strictEqual(new Set(lib.LEVEL_BAR_PHASE).size, 5);
  const still = lib.levelBars(0.6, null);
  assert.deepStrictEqual(still, [...still].reverse(), '止めた形が左右対称でない');
  assert.ok(still[2] >= still[1] && still[1] >= still[0], `真ん中が高くない: ${still}`);
  assert.deepStrictEqual(lib.levelBars(1, null), [16, 16, 16, 16, 16].map((_, i) => Math.round(4 + 12 * Math.min(1, 1.6 * lib.LEVEL_BAR_W[i]))));
});

test('録音バー（overlay.html）と録音中のページ（app.html）の levelBars は mainlib と同じ値', T, () => {
  for (const f of ['src/renderer/overlay.html', 'src/renderer/app.html']) {
    const fn = pick(read(f));
    for (const t of [null, 0, 37, 180, 420, 999, 12345]) for (const l of [0, 0.02, 0.021, 0.2, 0.45, 0.6, 1, NaN]) {
      assert.deepStrictEqual(fn(l, t), lib.levelBars(l, t), `${f}: ${l} ${t}`);
    }
  }
});

// ---------------------------------------------------------------- 録音バー（本物の overlay.html を最小の DOM で走らせる）
const OVL = path.join(ROOT, 'src', 'renderer', 'overlay.html');
function 音を決める(log) {
  const made = [];
  log.window.AudioContext.prototype.createAnalyser = function createAnalyser() {
    const a = { fftSize: 512, smoothingTimeConstant: 0, fill: 128, connect: (x) => x, disconnect() {}, getByteTimeDomainData(arr) { arr.fill(this.fill); } };
    made.push(a);
    return a;
  };
  return made;
}
const fillFor = (level) => 128 + Math.round((level * 128) / 3.4);
const dots = (log) => log.byId.get('lv').children.filter((e) => e.tagName === 'i').map((i) => parseFloat(i.style.getPropertyValue('--l')));
async function start(opt = {}) {
  const log = await load(OVL, { frames: 400, ...opt });
  const an = 音を決める(log);
  log.fire('onStart', { mode: 'meeting', segmentSec: 75, sound: false, systemAudio: false });
  await log.drain();
  return { log, an };
}

test('録音バー: 声の間は5本がそれぞれ揺れる（同じ声の大きさで時計を進めると高さの並びが変わる）。左から順に満ちる形でない。無音と一時停止は同じ点が5つ', async () => {
  const { log, an } = await start();
  assert.deepStrictEqual(dots(log), [4, 4, 4, 4, 4]);
  an[0].fill = fillFor(0.6);
  await log.drain();
  const a = dots(log);
  assert.ok(a.some((h) => h > 4) && a.every((h) => h >= 4 && h <= 16), `${a}`);
  await log.clock.advance(180);
  await log.drain();
  const b = dots(log);
  assert.notDeepStrictEqual(a, b, '時計を進めても揺れない');
  assert.ok(!(a[0] >= a[1] && a[1] >= a[2] && a[2] >= a[3] && a[3] >= a[4] && b[0] >= b[1] && b[1] >= b[2] && b[2] >= b[3] && b[3] >= b[4]), `左から順に満ちる形のまま: ${a} ${b}`);
  log.byId.get('pauseBtn').click();
  await log.drain();
  assert.deepStrictEqual(dots(log), [4, 4, 4, 4, 4]);
  assert.deepStrictEqual(log.errors, []);
});

test('録音バー: 動きを減らす設定では揺らさず、左右対称の止めた形（声の大きさで伸び縮みだけ）', async () => {
  const { log, an } = await start({ matchMedia: (q) => ({ matches: /prefers-reduced-motion: reduce/.test(q), addEventListener() {}, addListener() {} }) });
  an[0].fill = fillFor(0.6);
  await log.drain();
  const a = dots(log);
  await log.clock.advance(180);
  await log.drain();
  assert.deepStrictEqual(dots(log), a, '動きを減らす設定で揺れた');
  assert.deepStrictEqual(a, [...a].reverse(), `左右対称でない: ${a}`);
});

test('撮る画面の見本（pill-states）の点は levelBars の時刻 0 の形', T, () => {
  const PS = require('../tools/shots/pill-states');
  assert.deepStrictEqual(PS.dotsFor(0.6, false), lib.levelBars(0.6, 0));
  assert.deepStrictEqual(PS.dotsFor(0.6, true), [4, 4, 4, 4, 4]);
  assert.deepStrictEqual(PS.dotsFor(0, false), [4, 4, 4, 4, 4]);
});

// ---------------------------------------------------------------- 録音中のページ（app.html）
test('録音中のページ: 点は5つで、色は文字の灰色（--text-2）。青（--level）を使わない。高さは CSS で短く移る（動きを減らす設定では移らない）', T, () => {
  const html = read('src/renderer/app.html');
  const box = /<span id="liveWave"[^>]*>([\s\S]*?)<\/span>/.exec(html);
  assert.ok(box, '#liveWave が無い');
  assert.strictEqual((box[1].match(/<i><\/i>/g) || []).length, 5);
  const rule = /#liveWave i \{([^}]*)\}/.exec(html);
  assert.ok(rule && /background: var\(--text-2\)/.test(rule[1]) && !/--level/.test(rule[1]), rule && rule[1]);
  assert.ok(/#liveWave\.paused i \{ background: var\(--line\); \}/.test(html));
  assert.ok(!/#liveWave[^{]*\{[^}]*--level/.test(html), '波に青を使っている');
  assert.ok(/#liveWave i \{[^}]*transition: height \.1s/.test(html));
  assert.ok(html.includes('@media (prefers-reduced-motion: reduce) { * { transition: none !important; animation: none !important; } }'), '動きを減らす設定で移る');
});
