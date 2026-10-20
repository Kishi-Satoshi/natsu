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

// ---- O-2（RP3・RP4・F11・F18）: 窓の大きさと吸い付き
// ピルは窓の真ん中に描かれる（overlay.html の体は flex の真ん中寄せ）。ピルの四角（DIP）
const pillRect = (b, size) => ({ x: b.x + (b.width - size.w) / 2, y: b.y + (b.height - size.h) / 2, w: size.w, h: size.h });
const SIZES = [{ w: 240, h: 40 }, { w: 40, h: 240 }, { w: 420, h: 40 }, { w: 236.4, h: 40.2 }, { w: 39.6, h: 251.5 }, { w: 300.5, h: 40.5 }];
const AREAS = [WA, { x: 0, y: 0, width: 1280, height: 680 }, { x: -1920, y: 0, width: 1920, height: 1040 }, { x: 1920, y: -200, width: 1366, height: 728 }];
test('RP4・F11: panelBounds — 8つの置き場所 × 横・縦・伸ばした横 × 作業領域で、整数の DIP・ピルの周りに PANEL_PAD 以上の余白・窓は作業領域の中・ピルの端は端から 12px。拡大率 1〜2 で丸めてもピルが窓の内側に 1 点以上の余白で入る', () => {
  assert.strictEqual(lib.PANEL_PAD, 8);
  assert.deepStrictEqual(lib.PANEL_MAX, { width: 560, height: 360 });
  for (const wa of AREAS) for (const slot of PILL_SLOTS) for (const size of SIZES) {
    const b = lib.panelBounds({ slot, size, workArea: wa });
    const at = `${slot} ${JSON.stringify(size)} ${JSON.stringify(wa)} → ${JSON.stringify(b)}`;
    for (const k of ['x', 'y', 'width', 'height']) assert.ok(Number.isInteger(b[k]), `${at} の ${k} が整数でない`);
    assert.ok(b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height, `${at}: 窓が作業領域の外`);
    const r = pillRect(b, size);
    assert.ok(r.x - b.x >= lib.PANEL_PAD && b.x + b.width - (r.x + r.w) >= lib.PANEL_PAD, `${at}: 左右の余白が ${lib.PANEL_PAD} より狭い`);
    assert.ok(r.y - b.y >= lib.PANEL_PAD && b.y + b.height - (r.y + r.h) >= lib.PANEL_PAD, `${at}: 上下の余白が ${lib.PANEL_PAD} より狭い`);
    // ピルの端は作業領域の端から 12px（右の置き場所は右から、下は下から。丸めの半点まで）
    const near = (a, want) => Math.abs(a - want) <= 0.5;
    if (slot.endsWith('left')) assert.ok(near(r.x - wa.x, 12), `${at}: 左の端から ${r.x - wa.x}`);
    if (slot.endsWith('right')) assert.ok(near(wa.x + wa.width - (r.x + r.w), 12), `${at}: 右の端から ${wa.x + wa.width - (r.x + r.w)}`);
    if (slot.startsWith('top')) assert.ok(near(r.y - wa.y, 12), `${at}: 上の端から ${r.y - wa.y}`);
    if (slot.startsWith('bottom')) assert.ok(near(wa.y + wa.height - (r.y + r.h), 12), `${at}: 下の端から ${wa.y + wa.height - (r.y + r.h)}`);
    // 拡大率で DIP を画面の点に丸めても、ピルの四角（DIP × 拡大率。丸めない）が窓（丸めた点）の内側に 1 点以上の余白で入る
    for (const k of [1, 1.25, 1.5, 2]) {
      const X0 = Math.round(b.x * k); const X1 = Math.round((b.x + b.width) * k);
      const Y0 = Math.round(b.y * k); const Y1 = Math.round((b.y + b.height) * k);
      const ok = r.x * k - X0 >= 1 && X1 - (r.x + r.w) * k >= 1 && r.y * k - Y0 >= 1 && Y1 - (r.y + r.h) * k >= 1;
      assert.ok(ok, `${at} 拡大率 ${k}: ピルが窓の端から 1 点より近い`);
    }
  }
  // 整数の大きさなら、ちょうど ceil + 2 × PANEL_PAD
  assert.deepStrictEqual(lib.panelBounds({ slot: 'bottom-right', size: { w: 236, h: 40 }, workArea: WA }), { x: 1920 - 4 - 252, y: 1040 - 4 - 56, width: 252, height: 56 });
  assert.deepStrictEqual(lib.panelBounds({ slot: 'top-left', size: { w: 236.2, h: 40 }, workArea: WA }), { x: 4, y: 4, width: 253, height: 56 });
  // 大きさが数でなければ PANEL_FIRST（形ごと）
  for (const size of [null, undefined, {}, { w: 'x', h: 40 }, { w: NaN, h: 1 }, { w: -3, h: 40 }, { w: 0, h: 40 }]) {
    assert.deepStrictEqual(lib.panelBounds({ slot: 'middle-right', size, workArea: WA }), { x: 1920 - 4 - 56, y: 392, width: 56, height: 256 }, JSON.stringify(size));
    assert.deepStrictEqual(lib.panelBounds({ slot: 'bottom-center', size, workArea: WA }), { x: 832, y: 1040 - 4 - 56, width: 256, height: 56 }, JSON.stringify(size));
  }
  // 最大は 560×360（それより大きい中身は窓で止める）
  const big = lib.panelBounds({ slot: 'top-center', size: { w: 900, h: 500 }, workArea: WA });
  assert.deepStrictEqual([big.width, big.height], [560, 360]);
});

test('F18: ドラッグの止まり（最後の move から PANEL_QUIET_MS）で吸い付くのは Linux だけ（moved の来ない OS）。Windows・macOS は moved を待つ（手を止めただけで吸い付かない）', () => {
  assert.strictEqual(lib.PANEL_QUIET_MS, 300);
  assert.strictEqual(lib.snapsOnQuiet('linux'), true);
  for (const p of ['win32', 'darwin', '', undefined]) assert.strictEqual(lib.snapsOnQuiet(p), false, String(p));
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

// ---- O-2 の場面（録音の始めの後に、録音バーの画面の大きさの知らせ・ドラッグ・カーソルの移動を送る）
const lastB = (o) => o.overlayBounds[o.overlayBounds.length - 1];
describe('0.9.0 O-2 窓の大きさと吸い付き（場面）', { concurrency: Number(process.env.NATSU_SCENE_CONCURRENCY) || 4 }, () => {
  test('RP4: 右下の置き場所で録音バーの画面が 236×40 を送ると、窓は 252×56 になり、右の端と下の端は前と同じ（作業領域の端から 12 − 8）。同じ大きさが2回来ても setBounds は1回', SCENE, async () => {
    const o = await run(['text', '--dictate', '--settings-json=slot-bottom-right', '--panel-size=236x40']);
    const atStart = o.panel.boundsAtStartList[o.panel.boundsAtStartList.length - 1];
    assert.deepStrictEqual(atStart, { x: 1920 - 4 - 256, y: 1040 - 4 - 56, width: 256, height: 56 }, '録音の始めの窓が PANEL_FIRST.h でない');
    assert.deepStrictEqual(o.panel.afterSize, [{ x: 1920 - 4 - 252, y: 1040 - 4 - 56, width: 252, height: 56 }]);
    for (const b of [atStart, o.panel.afterSize[0]]) assert.deepStrictEqual([b.x + b.width, b.y + b.height], [1916, 1036]);
    assert.strictEqual(o.overlaySent[0].form, 'h', '録音の始めの合図に form が無い');
  });

  test('RP3: 右の真ん中へドラッグして離すと middle-right に吸い付き、pillSlot に middle-right を書き、overlay:form に v を1回送る。窓は縦の大きさ（PANEL_FIRST.v）で右の真ん中', SCENE, async () => {
    const o = await run(['text', '--drag-to=1880,520']);
    assert.strictEqual(o.panel.slotAfter, 'middle-right');
    assert.deepStrictEqual(o.overlayForms, [{ form: 'v' }]);
    assert.deepStrictEqual(o.panel.afterMoved, [{ x: 1920 - 4 - 56, y: 392, width: 56, height: 256 }]);
    assert.strictEqual(o.panel.duringDrag, 0);
  });

  test('F18: ドラッグで吸い付いた置き場所は、本体の画面へ settings:patched（{ pillSlot }）で1回知らせる（画面の欄が古いままだと、無関係な自動保存が前の置き場所へ戻す）', SCENE, async () => {
    const o = await run(['text', '--drag-to=1880,520']);
    assert.strictEqual(o.panel.slotAfter, 'middle-right');
    assert.deepStrictEqual(o.panel.patched, [{ pillSlot: 'middle-right' }]);
  });

  test('RP3: 今の置き場所の近くへ少し動かして離すと、名前が同じなので settings.json を書かず、窓は元の所へ戻る', SCENE, async () => {
    const o = await run(['text', '--drag-to=1000,990']);
    assert.strictEqual(o.panel.settingsChanged, false, '名前が同じなのに settings.json を書いた');
    assert.deepStrictEqual(o.panel.patched, [], '名前が同じなのに本体の画面へ知らせた');
    assert.deepStrictEqual(o.panel.afterMoved, [o.panel.boundsAtStartList[o.panel.boundsAtStartList.length - 1]], '元の所へ戻らない');
    assert.deepStrictEqual(o.overlayForms, []);
  });

  test('F18: ドラッグの間に録音バーの画面の大きさが変わっても setBounds は0回（OS のドラッグと取り合わない）。離した後に新しい大きさで1回', SCENE, async () => {
    const o = await run(['text', '--drag-to=1700,60', '--drag-steps', '--panel-size=300x40']);
    assert.strictEqual(o.panel.duringDrag, 0, 'ドラッグの間に置き直した');
    assert.strictEqual(o.panel.slotAfter, 'top-right');
    assert.deepStrictEqual(o.panel.afterMoved, [{ x: 1920 - 4 - 316, y: 4, width: 316, height: 56 }]);
  });

  test('F18: 録音の途中でカーソルを左の画面へ動かしてから大きさが変わっても、置き直しは録音を始めた右の画面の作業領域のまま', SCENE, async () => {
    const o = await run(['text', DISPLAYS2, '--cursor-to=-500,500', '--panel-size=300x40']);
    assert.deepStrictEqual(o.panel.afterSize, [{ x: Math.round((1920 - 316) / 2), y: 1040 - 4 - 56, width: 316, height: 56 }]);
  });
});

// ---- O-4（RP8・F18）: 縦の形の × で隠す・出し直す・トレイ・カーソルを見る見張り
const SHOW_TRAY = '録音バーを表示';
describe('0.9.0 O-4 隠す・出し直す（場面）', { concurrency: Number(process.env.NATSU_SCENE_CONCURRENCY) || 4 }, () => {
  test('RP8: 隠すと録音は続き（区間が届く）、meeting:status の panelHidden が真、トレイに［録音バーを表示］。panel:show で出し直し（showInactive。フォーカスを取らない）、panelHidden が偽、トレイの項目が消える', SCENE, async () => {
    const o = await run(['text', '--hide-panel']);
    const h = o.panel.hide;
    assert.strictEqual(h.afterHide.panelHidden, true);
    assert.ok(h.afterHide.tray.includes(SHOW_TRAY), `トレイに［録音バーを表示］が無い: ${h.afterHide.tray}`);
    assert.deepStrictEqual(h.afterHide.calls.slice(-1), ['hide'], '録音バーの窓を隠していない');
    assert.deepStrictEqual(h.show, { ok: true });
    assert.strictEqual(h.afterShow.panelHidden, false);
    assert.ok(!h.afterShow.tray.includes(SHOW_TRAY), '出し直した後もトレイに項目が残る');
    assert.deepStrictEqual(h.afterShow.calls.slice(h.afterHide.calls.length), ['showInactive'], '出し直しがフォーカスを取る（show）か、出していない');
    // 録音は止めていない: 隠した後に送った区間も文字になって議事録に入る
    assert.strictEqual(o.pages.length, 1);
    assert.ok(o.pages[0].segments.length >= 2 && o.pages[0].segments.every((s) => !s.failed && s.text), JSON.stringify(o.pages[0].segments));
  });

  test('RP8: 隠したままマイクのエラーが来ると、録音バーを出してから（showInactive）エラーの文を送る', SCENE, async () => {
    const o = await run(['text', '--dictate', '--hide-panel=error']);
    const calls = o.panel.hide.afterError.calls;
    const iHide = calls.lastIndexOf('hide');
    const iShow = calls.indexOf('showInactive', iHide);
    const iErr = calls.indexOf('phase:error', iHide);
    assert.ok(iHide >= 0 && iErr > iHide, `エラーの文を送っていない: ${calls}`);
    assert.ok(iShow > iHide && iShow < iErr, `隠したままエラーの文を送った: ${calls}`);
    assert.strictEqual(o.panel.hide.afterError.panelHidden, false);
    // 議事録でも、隠したままマイクのエラーが来たら出し直してから締める（作成中の文を見せる）
    const m = await run(['text', '--hide-panel=error']);
    const mc = m.panel.hide.afterError.calls;
    const mHide = mc.lastIndexOf('hide');
    assert.ok(mHide >= 0 && mc.indexOf('showInactive', mHide) > mHide, `議事録で隠したまま締めた: ${mc}`);
  });

  test('RP8: 隠した後の次の録音では、録音バーを出す（panelHidden は偽に戻り、トレイの項目も無い）', SCENE, async () => {
    const o = await run(['text', '--dictate', '--hide-panel=next']);
    const h = o.panel.hide;
    assert.strictEqual(h.afterHide.panelHidden, true);
    assert.strictEqual(h.afterNext.panelHidden, false);
    assert.ok(!h.afterNext.tray.includes(SHOW_TRAY), `次の録音でトレイに項目が残る: ${h.afterNext.tray}`);
    assert.deepStrictEqual(h.afterNext.calls.slice(h.afterHide.calls.length).filter((c) => !c.startsWith('phase:')), ['showInactive']);
    assert.strictEqual(o.history.length, 1, '次の録音の音声入力が履歴に入らない');
  });

  test('F18: 縦の形でカーソルが窓に入ると overlay:hover の真を1回、出ると偽を1回。横の形・隠した後は送らない（見張りが止まる）', SCENE, async () => {
    const o = await run(['text', '--drag-to=1880,520', '--hover-panel']);
    const hv = o.panel.hover;
    assert.deepStrictEqual(hv.horizontal, { sent: [], intervals: 0 }, '横の形でカーソルを見て送った');
    assert.strictEqual(hv.intervals, 1, '縦の形になっても 120ms の見張りを始めない');
    assert.deepStrictEqual(hv.sent, [true, false], 'カーソルの出入りを1回ずつ送っていない');
    assert.deepStrictEqual(hv.afterHide, [true, false], '隠した後にも送った');
    assert.strictEqual(hv.cleared, true, '隠しても見張りを止めない');
  });
});

// ---- O-4（RP1・RP8）: 本体の画面の設定の置き場所と［録音バーを出す］（app.html を simrun で走らせる。計画の stage090.settings の2つ:
// U の台（stage090.settings.test.js）はこのレーンの元に無いので、ここに置く）
const { load } = require('./helpers/simrun.js');
const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const fmtE = (e) => `${e.constructor.name}: ${e.message}`;
const SLOT_NAMES = [['top-left', '左上'], ['top-center', '上の中央'], ['top-right', '右上'], ['middle-left', '左の中央（縦）'], ['middle-right', '右の中央（縦）'],
  ['bottom-left', '左下'], ['bottom-center', '下の中央（既定）'], ['bottom-right', '右下']];
test('RP1: 設定の #pillPos の選択肢は8つの置き場所（値は PILL_SLOTS）で、起動で pillSlot を出し、保存は pillSlot。pillPos・pillCustom を保存に入れない', { timeout: 5000 }, async () => {
  const l = await load(APP, { returns: { getSettings: () => ({ hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M', segmentSec: 75, language: 'ja', dictionary: [], pillSlot: 'middle-right' }) } });
  await l.drain();
  const sel = l.byId.get('pillPos');
  assert.deepStrictEqual(sel.querySelectorAll('option').map((o) => [o.getAttribute('value'), o.textContent.trim()]), SLOT_NAMES);
  assert.deepStrictEqual(SLOT_NAMES.map(([v]) => v), PILL_SLOTS);
  const label = l.root.querySelectorAll('label').find((x) => x.getAttribute('for') === 'pillPos');
  assert.strictEqual(label.textContent.trim(), '録音バーの置き場所（表示中はドラッグでも動かせます）');
  assert.strictEqual(sel.value, 'middle-right', '起動で pillSlot を出していない');
  sel.value = 'top-left';
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  const saved = l.called('saveSettings').map((c) => c.args[0]);
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].pillSlot, 'top-left');
  assert.ok(!('pillPos' in saved[0]) && !('pillCustom' in saved[0]), '前の版のキーを保存に入れた');
  assert.deepStrictEqual(l.errors.map(fmtE), []);
});

test('F18: ドラッグの吸い付きを知らせる onSettingsPatched({ pillSlot }) で #pillPos が今の置き場所になり（保存はしない）、その後の無関係な自動保存も今の置き場所を送る（前の置き場所へ戻さない）', { timeout: 5000 }, async () => {
  const l = await load(APP, { returns: { getSettings: () => ({ hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M', segmentSec: 75, language: 'ja', dictionary: [], pillSlot: 'bottom-center' }) } });
  await l.drain();
  assert.strictEqual(l.byId.get('pillPos').value, 'bottom-center');
  assert.strictEqual(l.fire('onSettingsPatched', { pillSlot: 'middle-right' }), 1, '画面が onSettingsPatched を受けていない');
  await l.drain();
  assert.strictEqual(l.byId.get('pillPos').value, 'middle-right', '吸い付いた置き場所を欄に出していない');
  assert.strictEqual(l.called('saveSettings').length, 0, '知らせを受けただけで保存した');
  l.byId.get('segmentSec').value = '90';
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  const saved = l.called('saveSettings').map((c) => c.args[0]);
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].pillSlot, 'middle-right', '無関係な自動保存が前の置き場所を送った');
  assert.deepStrictEqual(l.errors.map(fmtE), []);
});

test('F18: 保存の答えの applied に pillSlot があれば（main が送った値と違う置き場所で残した）、#pillPos をその置き場所に戻す', { timeout: 5000 }, async () => {
  const l = await load(APP, { returns: {
    getSettings: () => ({ hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M', segmentSec: 75, language: 'ja', dictionary: [], pillSlot: 'bottom-center' }),
    saveSettings: () => ({ ok: true, applied: { hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M', pillSlot: 'top-right' } }) } });
  await l.drain();
  l.byId.get('pillPos').value = 'top-left';
  l.byId.get('tabSettings').dispatchEvent({ type: 'change' });
  await l.drain();
  assert.strictEqual(l.called('saveSettings').length, 1);
  assert.strictEqual(l.byId.get('pillPos').value, 'top-right', 'applied の置き場所を欄に戻していない');
  assert.deepStrictEqual(l.errors.map(fmtE), []);
});

test('RP8: 録音中のページの記録の行に、panelHidden のときだけ［録音バーを出す］があり、押すと showPanel が1回', { timeout: 5000 }, async () => {
  const st = (panelHidden) => ({ active: true, startedAt: Date.now(), memo: '', segments: [], pending: 0, panelHidden });
  const l = await load(APP, { returns: { meetingStatus: () => st(false) } });
  await l.drain();
  l.fire('onMeetingUpdate', st(false));
  await l.drain();
  const btn = l.byId.get('livePanelShow');
  assert.ok(btn, '記録の行に［録音バーを出す］が無い');
  assert.strictEqual(btn.textContent.trim(), '録音バーを出す');
  assert.strictEqual(btn.hidden, true, '隠していないのに出ている');
  l.fire('onMeetingUpdate', st(true));
  await l.drain();
  assert.strictEqual(l.byId.get('livePanelShow').hidden, false, '隠したのに出ない');
  l.byId.get('livePanelShow').click();
  await l.drain();
  assert.strictEqual(l.called('showPanel').length, 1);
  l.fire('onMeetingUpdate', st(false));
  await l.drain();
  assert.strictEqual(l.byId.get('livePanelShow').hidden, true);
  assert.deepStrictEqual(l.errors.map(fmtE), []);
});
