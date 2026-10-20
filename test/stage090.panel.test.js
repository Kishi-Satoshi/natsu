/*
 * stage090.panel.test.js — 0.9.0 の録音バーの置き場所・前の位置の直し・窓の大きさ・吸い付き・隠す・出し直す（計画 docs/plans/2026-10-20-090.md の
 * レーン O。設計書 D25・RP1〜RP4・RP8・F11・F12・F18）。lib は純粋な関数の表、場面は main.js を偽の Electron の上で本当に動かす
 * （helpers/mainrun.js の --settings-json・--displays ほか）。場面は1つずつ別のプロセスで、4 つずつ並べて走らせる。
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const lib = require('../src/mainlib');
const { PILL_SLOTS } = require('../src/settings');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args) => new Promise((resolve, reject) => {
  execFile(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 19000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
// 場面は作業環境で 1〜2 秒。見張りは 20 秒（Windows の CI と変異確認の写しでは機械が混むため。今の場面のテストの決まり）
const SCENE = { timeout: 20000 };
const WA = { x: 0, y: 0, width: 1920, height: 1040 };
// 置き場所のピルの中心（端から PANEL_EDGE に、その形の初めの大きさ PANEL_FIRST のピルを置いた中心）。lib と別に、計画の言葉どおりに計算する
const centerOf = (slot, wa) => {
  const f = lib.slotForm(slot);
  const s = lib.PANEL_FIRST[f];
  const E = lib.PANEL_EDGE;
  const cx = slot.endsWith('left') ? wa.x + E + s.w / 2 : slot.endsWith('right') ? wa.x + wa.width - E - s.w / 2 : wa.x + wa.width / 2;
  const cy = slot.startsWith('top') ? wa.y + E + s.h / 2 : slot.startsWith('bottom') ? wa.y + wa.height - E - s.h / 2 : wa.y + wa.height / 2;
  return { x: cx, y: cy };
};

test('RP1: slotForm は middle-left・middle-right だけ v（縦の形）、ほかは h', () => {
  assert.deepStrictEqual(PILL_SLOTS.map((s) => [s, lib.slotForm(s)]), [
    ['top-left', 'h'], ['top-center', 'h'], ['top-right', 'h'], ['middle-left', 'v'], ['middle-right', 'v'],
    ['bottom-left', 'h'], ['bottom-center', 'h'], ['bottom-right', 'h']]);
  assert.strictEqual(lib.PANEL_EDGE, 12);
  assert.deepStrictEqual(lib.PANEL_FIRST, { h: { w: 240, h: 40 }, v: { w: 40, h: 240 } });
});

test('RP2: nearestSlot — 各置き場所の中心はその名前・升の中は近い角・同じ距離は PILL_SLOTS の順で前・x が負の画面でも同じ・外の点は一番近い端', () => {
  const LEFT = { x: -1920, y: 0, width: 1920, height: 1040 };
  const SMALL = { x: 0, y: 40, width: 1280, height: 680 };   // 上にタスクバーのある小さな画面
  for (const wa of [WA, LEFT, SMALL]) {
    for (const s of PILL_SLOTS) assert.strictEqual(lib.nearestSlot(centerOf(s, wa), wa), s, `${JSON.stringify(wa)} の ${s}`);
    // 少しずらしても同じ（升の中）
    for (const s of PILL_SLOTS) {
      const c = centerOf(s, wa);
      assert.strictEqual(lib.nearestSlot({ x: c.x + 30, y: c.y - 20 }, wa), s, `${JSON.stringify(wa)} の ${s} の近く`);
    }
  }
  // 左上の升の中（作業領域の 1/3 より左上）
  assert.strictEqual(lib.nearestSlot({ x: 400, y: 200 }, WA), 'top-left');
  assert.strictEqual(lib.nearestSlot({ x: -1920 + 400, y: 200 }, LEFT), 'top-left');
  // 真ん中の点は top-center と bottom-center から同じ距離（488）。順で前の top-center（bottom-center に決め打ちしない）
  assert.strictEqual(lib.nearestSlot({ x: 960, y: 520 }, WA), 'top-center');
  // 左の真ん中より少し下の点は middle-left（縦の形の中心は x = 12 + 20）
  assert.strictEqual(lib.nearestSlot({ x: 60, y: 560 }, WA), 'middle-left');
  // 作業領域の外の点は一番近い端の置き場所
  assert.strictEqual(lib.nearestSlot({ x: 5000, y: 520 }, WA), 'middle-right');
  assert.strictEqual(lib.nearestSlot({ x: -300, y: -300 }, WA), 'top-left');
  assert.strictEqual(lib.nearestSlot({ x: 960, y: 4000 }, WA), 'bottom-center');
});

// ---- 場面（main.js を偽の Electron の上で動かす）
const DISPLAYS2 = '--displays=-1920,0,1920,1040;0,0,1920,1040';
const logOf = (o) => o.engineLog.filter((l) => l.startsWith('録音バー: 置き場所を'));
const rawOf = (o) => JSON.parse(o.settings);
// 場面の settings.json の表（helpers/json-scenes.js の PILL_SETTINGS）
const PS = require('./helpers/json-scenes').PILL_SETTINGS;

describe('0.9.0 O-1 前の位置の直し（場面）', { concurrency: Number(process.env.NATSU_SCENE_CONCURRENCY) || 4 }, () => {
  test('F12: 左の画面の右上に動かしていた人（pillCustom が負の座標）は、起動だけで置き場所が top-right になり、記録が1行、settings.json の pillPos・pillCustom の値はそのまま残る', SCENE, async () => {
    const o = await run(['text', '--idle', '--settings-json=pill-custom-left', DISPLAYS2]);
    const raw = rawOf(o);
    assert.strictEqual(raw.pillSlot, 'top-right');
    assert.deepStrictEqual(logOf(o), ['録音バー: 置き場所を top-right にした（前の pillCustom から）']);
    assert.deepStrictEqual([raw.pillPos, raw.pillCustom], [PS['pill-custom-left'].pillPos, PS['pill-custom-left'].pillCustom]);
    assert.strictEqual(JSON.stringify(raw.pillCustom), JSON.stringify(PS['pill-custom-left'].pillCustom), 'pillCustom の値を書き換えた');
  });

  test('F18: 前の位置を直した起動の直後に画面が settings:get を呼ぶと、答えの pillSlot は直した top-right（既定の bottom-center でない）', SCENE, async () => {
    const o = await run(['text', '--idle', '--settings-json=pill-custom-left', DISPLAYS2]);
    assert.strictEqual(o.settingsGet.pillSlot, 'top-right');
  });

  test('F12: pillCustom が壊れていて pillPos が left の人は middle-left に直す（落ちない）', SCENE, async () => {
    const o = await run(['text', '--idle', '--settings-json=pill-pos-left']);
    assert.strictEqual(rawOf(o).pillSlot, 'middle-left');
    assert.deepStrictEqual(logOf(o), ['録音バー: 置き場所を middle-left にした（前の pillPos から）']);
    assert.deepStrictEqual([rawOf(o).pillPos, rawOf(o).pillCustom], ['left', 'x']);
  });

  test('F12: もう pillSlot がある設定（古い pillCustom も残っている）は直さず、記録も無く、settings.json を書かない', SCENE, async () => {
    const o = await run(['text', '--idle', '--settings-json=pill-slot-kept', DISPLAYS2]);
    assert.strictEqual(rawOf(o).pillSlot, 'top-center');
    assert.deepStrictEqual(logOf(o), []);
    assert.deepStrictEqual(rawOf(o), { ...o.settingsBefore }, '起動だけで settings.json を書き換えた');
  });

  test('F12: 2回目の起動では直さない（記録も無い）。1回目に直した置き場所のまま', SCENE, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), '置き場所の二度目𠮷-'));
    try {
      const first = await run(['text', '--idle', '--settings-json=pill-pos-left', `--keep-user-data=${dir}`]);
      assert.strictEqual(rawOf(first).pillSlot, 'middle-left');
      const second = await run(['text', '--idle', '--settings-json=pill-pos-left', `--keep-user-data=${dir}`]);
      assert.strictEqual(rawOf(second).pillSlot, 'middle-left');
      assert.deepStrictEqual(logOf(second).length, logOf(first).length, '2回目の起動でまた直した');
      assert.strictEqual(second.settings, first.settings, '2回目の起動で settings.json を書き換えた');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
