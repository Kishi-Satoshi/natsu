/*
 * stage094.detect.test.js — 0.9.4 Task D-1（計画 docs/plans/2026-10-22-094.md の2回目の節「Task D-1」・最後の問答）: 会議の検出が出ない
 * 確かめた原因: 見張りの PowerShell は行が変わったときだけ書き、判断（nudgeStep）は同じ使いを2回受けてから出す → 会議のアプリだけがマイクを使い
 * 続けるとパネルが出ない。直し（N2・Ruling）: 見張りは読むたびに（2 秒ごと）書く。あわせて診断の記録（マイクの記録の数・出さなかった理由の符号・
 * 会議の始まりと終わりの引き金）を engine.log に書く（アプリの名前は書かない）。受け入れの目標: 参加の前の画面を開いたとき（マイクを開いたとき）に出る。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const lib = require('../src/mainlib');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const T = { timeout: 5000 };
const S = { timeout: sceneTimeout(20000) };
const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (steps, ...flags) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, 'text', `--mic-feed=${JSON.stringify(steps)}`, ...flags], { env: { ...process.env }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const Z = 'mic zoom:133713371337133713';
const NAMES = /zoom|teams|webex|slack|chrome|edge|firefox|Zoom|Teams|Webex|Slack|Chrome|Edge|Firefox|ブラウザ/;

test('D-1: 見張りの文は読むたびに行を書く（前の行と比べて書かないことをしない）', T, () => {
  const s = lib.micWatchScript({ self: 'C:\\x\\NaTsu.exe', parent: 1 });
  assert.ok(s.includes('function Say($t) { [Console]::Out.WriteLine($t); [Console]::Out.Flush() }'), s.split('\n').find((l) => l.includes('function Say')));
  assert.ok(!s.includes('$script:last'), '前の行を覚えて比べている');
});

// 見張りの1行を判断に通す（本物の main と同じ: parseMicLine → nudgeStep）
const feed = (lines, st0 = lib.nudgeInit({ on: true, mute: [] })) => {
  let st = st0;
  const out = [];
  for (const [now, line] of lines) {
    const r = lib.parseMicLine(line);
    const o = lib.nudgeStep(st, r.kind === 'mic' ? { type: 'sample', items: r.items, now } : { type: 'tick', now });
    st = o.st;
    out.push({ show: o.show ? o.show.id : null, hide: o.hide, why: o.why });
  }
  return { out, st };
};
const every2s = (from, to, line) => { const xs = []; for (let t = from; t <= to; t += 2000) xs.push([t, line]); return xs; };

test('D-1: 参加の前の画面（マイクを開いた）→ 2 回目の読み（約 2〜4 秒）で出す。そのまま参加しても2つ目は出さない', T, () => {
  const r = feed(every2s(0, 20000, Z));
  assert.deepStrictEqual(r.out.map((o) => o.show).filter(Boolean), ['zoom']);
  assert.strictEqual(r.out.findIndex((o) => o.show), 1, '2 回目の読みで出していない');
});

test('D-1: 参加のときにマイクを開き直しても（開始の時刻が変わる）60 秒の間は2つ目を出さない（理由 rejoin）。61 秒後なら出す・59 秒後なら出さない', T, () => {
  const S1 = 'mic zoom:100', S2 = 'mic zoom:200', S3 = 'mic zoom:300';
  let r = feed([...every2s(0, 4000, S1), ...every2s(6000, 12000, S2)]);
  assert.deepStrictEqual(r.out.map((o) => o.show).filter(Boolean), ['zoom']);
  assert.strictEqual(r.out[r.out.length - 1].why, 'rejoin');
  r = feed([...every2s(0, 4000, S1), [6000, 'mic -'], ...every2s(6000 + 61000, 6000 + 65000, S3)]);
  assert.deepStrictEqual(r.out.map((o) => o.show).filter(Boolean), ['zoom', 'zoom']);
  r = feed([...every2s(0, 4000, S1), [6000, 'mic -'], ...every2s(6000 + 59000, 6000 + 59000 + 4000, S3)]);
  assert.deepStrictEqual(r.out.map((o) => o.show).filter(Boolean), ['zoom']);
  assert.strictEqual(r.out[r.out.length - 1].why, 'rejoin');
});

test('D-1: 出さなかった理由の符号（wait・done・mute・busy・off）。マイクの記録が無ければ空', T, () => {
  let r = feed([[0, Z]]);
  assert.strictEqual(r.out[0].why, 'wait');
  r = feed([[0, Z], [2000, Z]]);
  assert.strictEqual(r.out[1].why, '', '出しているのに理由を書いた');
  const closed = lib.nudgeStep(r.st, { type: 'closed', now: 3000 }).st;
  assert.strictEqual(feed([[4000, Z]], closed).out[0].why, 'done');
  r = feed([[0, Z], [2000, Z]], lib.nudgeInit({ on: true, mute: ['zoom'] }));
  assert.strictEqual(r.out[1].why, 'mute');
  r = feed([[0, Z], [2000, Z]], lib.nudgeInit({ on: false, mute: [] }));
  assert.strictEqual(r.out[1].why, 'off');
  const busy = lib.nudgeStep(lib.nudgeInit({ on: true, mute: [] }), { type: 'busy', busy: true, meeting: false, now: 0 }).st;
  r = feed([[0, Z], [2000, Z]], busy);
  assert.strictEqual(r.out[1].why, 'busy');
  r = feed([[0, 'mic -']]);
  assert.strictEqual(r.out[0].why, '');
});

test('D-1（場面）: 本物と同じく 2 秒ごとに同じ行が来ると出す。記録に「マイクの記録 1 件」「出さない（wait）」「パネルを出した」（名前は書かない）。行が1回だけなら出さない', S, async () => {
  const o = await run([['line', Z], ['line', Z], ['wait-show', 1], ['line', Z]]);
  assert.strictEqual(o.nudge.calls.filter((c) => c === 'showInactive').length, 1, JSON.stringify(o.nudge.calls));
  const lines = o.engineLog.filter((l) => l.startsWith('会議の検出'));
  assert.ok(lines.includes('会議の検出: マイクの記録 1 件'), lines.join('\n'));
  assert.ok(lines.includes('会議の検出: 出さない（wait）'), lines.join('\n'));
  assert.ok(lines.includes('会議の検出: パネルを出した'), lines.join('\n'));
  assert.strictEqual(lines.filter((l) => l === '会議の検出: マイクの記録 1 件').length, 1, '同じ数を続けて書いた');
  assert.ok(!o.engineLog.some((l) => NAMES.test(l) && /会議|マイク|見張り/.test(l)), o.engineLog.join('\n'));
  const once = await run([['line', Z], ['sleep', 100]]);
  assert.strictEqual(once.nudge, null, '1回の行で出した');
});

test('D-1（場面）: 会議の始まりと終わりの引き金を記録に書く（page・panel・panel-offline・hotkey・tray／page・bar・hotkey）', S, async () => {
  const fin = [['finish']];
  const page = await run([['start'], ['stop']]);
  assert.ok(page.engineLog.includes('会議: 始めた（page）') && page.engineLog.includes('会議: 止めた（page）'), page.engineLog.join('\n'));
  const panel = await run([['line', Z], ['line', Z], ['wait-show', 1], ['ipc', 'nudge:start'], ['sleep', 100], ['hotkey-meeting'], ...fin]);
  assert.ok(panel.engineLog.includes('会議: 始めた（panel）') && panel.engineLog.includes('会議: 止めた（hotkey）'), panel.engineLog.join('\n'));
  const off = await run([['line', Z], ['line', Z], ['wait-show', 1], ['ipc', 'nudge:start', { pcOnly: true }], ['sleep', 100], ['bar-stop'], ...fin]);
  assert.ok(off.engineLog.includes('会議: 始めた（panel-offline）') && off.engineLog.includes('会議: 止めた（bar）'), off.engineLog.join('\n'));
  const keys = await run([['hotkey-meeting'], ['sleep', 100], ['hotkey-meeting'], ...fin, ['tray-start'], ['sleep', 100]]);
  assert.ok(keys.engineLog.includes('会議: 始めた（hotkey）'), keys.engineLog.join('\n'));
  assert.ok(keys.engineLog.includes('会議: 始めた（tray）'), keys.engineLog.join('\n'));
});
