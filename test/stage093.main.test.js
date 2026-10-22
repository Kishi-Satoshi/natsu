/*
 * stage093.main.test.js — 0.9.3 の main の場面（計画 docs/plans/2026-10-22-093.md の Task M-2・M-3・M-5）
 * M-2: 会議の検出の見張り（Windows のマイクの記録を読む常駐の PowerShell）を起こす・止める・起こし直す。記録にアプリの名前を書かない。
 * 場面は helpers/mainrun.js を別のプロセスで回す（--mic-feed。見張りは偽の子で、場面が行を書く。NATSU_TEST_MIC_WATCH で Windows の外でも起こす）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const S = { timeout: sceneTimeout(20000) };
const run = (steps, ...flags) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, 'text', `--mic-feed=${JSON.stringify(steps)}`, ...flags], { env: { ...process.env }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const Z = 'mic zoom:133713371337133713';
const NAMES = /zoom|teams|webex|slack|chrome|edge|firefox|Zoom|Teams|Webex|Slack|Chrome|Edge|Firefox|ブラウザ/;

test('M-2: 起動の時に設定がオンなら見張りを1つ起こす（powershell.exe -NoProfile -NonInteractive -Command・窓を出さない・中身に自分のパスと親の pid）。オフなら起こさない', S, async () => {
  const o = await run([['snap', 'boot']]);
  assert.strictEqual(o.micSpawns.length, 1, JSON.stringify(o.micSpawns));
  const sp = o.micSpawns[0];
  assert.strictEqual(sp.cmd, 'powershell.exe');
  assert.deepStrictEqual(sp.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.strictEqual(sp.opts.windowsHide, true);
  const script = sp.args[3];
  assert.ok(script.includes(`'${process.execPath.replace(/\\/g, '#').toLowerCase().replace(/'/g, "''")}'`), '自分のパスが無い');
  assert.ok(/GetProcessById\(\d+\)/.test(script), '親の pid が無い');
  assert.ok(o.engineLog.includes('会議の検出: 見張りを始めた'), o.engineLog.join('\n'));
  const off = await run([['snap', 'boot']], '--detect=off');
  assert.strictEqual(off.micSpawns.length, 0);
  assert.ok(!off.engineLog.some((l) => l.startsWith('会議の検出')), off.engineLog.join('\n'));
});

test('M-2: 録音を始めると見張りを止め、idle に戻ると起こす（議事録・音声入力）', S, async () => {
  const o = await run([['snap', 'boot'], ['start'], ['snap', 'meeting'], ['stop'], ['snap', 'idle'], ['dictate'], ['snap', 'dictate'], ['dictate-cancel'], ['snap', 'after']]);
  assert.deepStrictEqual([o.snaps.boot.spawns, o.snaps.boot.kills], [1, 0]);
  assert.strictEqual(o.snaps.meeting.active, true);
  assert.deepStrictEqual([o.snaps.meeting.spawns, o.snaps.meeting.kills], [1, 1], '議事録の録音中も見張りが動いている');
  assert.deepStrictEqual([o.snaps.idle.spawns, o.snaps.idle.kills], [2, 1], 'idle に戻っても見張りを起こさない');
  assert.deepStrictEqual([o.snaps.dictate.spawns, o.snaps.dictate.kills], [2, 2], '音声入力の録音中も見張りが動いている');
  assert.deepStrictEqual([o.snaps.after.spawns, o.snaps.after.kills], [3, 2]);
  assert.strictEqual(o.engineLog.filter((l) => l === '会議の検出: 見張りを止めた').length, 2);
});

test('M-2: 設定を切ると止め、入れると起こす', S, async () => {
  const o = await run([['save', { meetingDetect: false }], ['snap', 'off'], ['save', { meetingDetect: true }], ['snap', 'on']]);
  assert.deepStrictEqual([o.snaps.off.spawns, o.snaps.off.kills], [1, 1]);
  assert.deepStrictEqual([o.snaps.on.spawns, o.snaps.on.kills], [2, 1]);
  assert.strictEqual(JSON.parse(o.settingsText).meetingDetect, true);
});

test('M-2: 落ちたら 30 秒・2 分・10 分の後に起こし直し、4 回目に落ちたら設定のオンオフまで起こさない。行を受けたら数え直す', S, async () => {
  const o = await run([['exit', 1], ['sleep', 40], ['exit', 1], ['sleep', 40], ['exit', 1], ['sleep', 40], ['exit', 1], ['sleep', 40], ['snap', 'gave'],
    ['save', { meetingDetect: false }], ['save', { meetingDetect: true }], ['snap', 'again']]);
  assert.deepStrictEqual(o.restartDelays, [30000, 120000, 600000]);
  assert.strictEqual(o.snaps.gave.spawns, 4, '起こし直しの数が違う');
  assert.ok(o.engineLog.includes('会議の検出: 見張りが落ちたので 30 秒後に起こし直します'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('会議の検出: 見張りが続けて落ちたので、次の起動か設定のオンオフまで起こしません'), o.engineLog.join('\n'));
  assert.strictEqual(o.snaps.again.spawns, 5, '設定を入れ直しても起こさない');
  const r = await run([['exit', 1], ['sleep', 40], [`line`, Z], ['exit', 1], ['sleep', 40]]);
  assert.deepStrictEqual(r.restartDelays, [30000, 30000], '行を受けた後も落ちた数を数え直していない');
});

test('M5・M-2: engine.log の見張りの行にアプリの名前と id が無い（読めない符号だけ）。終了で止める', S, async () => {
  const o = await run([['line', Z], ['line', Z], ['line', 'err read'], ['line', 'mic -'], ['line', 'mic teams:1,chrome:2'], ['quit']]);
  const lines = o.engineLog.filter((l) => l.startsWith('会議の検出'));
  assert.ok(lines.includes('会議の検出: マイクの記録を読めません（read）'), lines.join('\n'));
  assert.ok(!o.engineLog.some((l) => NAMES.test(l) && /会議|マイク|見張り/.test(l)), o.engineLog.join('\n'));
  assert.ok(o.micKills >= 1 && o.engineLog.includes('会議の検出: 見張りを止めた'), '終了で見張りを止めていない');
});

// ---------------------------------------------------------------- M-3: パネルの窓（決めたこと 7〜10。持ち主の答え Q3・Q5・D50）
const Z2 = [['line', Z], ['line', Z]];
const nudgeCalls = (o) => (o.nudge ? o.nudge.calls : []);
const shows = (o) => (o.nudge ? o.nudge.sent.filter(([ch]) => ch === 'nudge:show').map(([, p]) => p) : []);
const sentMain = (o, ch) => o.mainSentAll.filter(([c]) => c === ch).map(([, p]) => p);

test('M3・M4: 2回続けて Zoom が見えたら、パネルの窓を作り、nudge:show に「Zoom」を送り、showInactive を1回（show・focus は0回）。窓は focusable: false・transparent・hasShadow: false・alwaysOnTop・skipTaskbar・setContentProtection(true)。1回だけでは出さない', S, async () => {
  const once = await run([['line', Z], ['sleep', 50]]);
  assert.strictEqual(once.nudgeWindows, 0, '1回見えただけで窓を作った');
  const o = await run([...Z2, ['sleep', 50]]);
  assert.strictEqual(o.nudgeWindows, 1);
  const op = o.nudge.opts;
  for (const [k, v] of [['focusable', false], ['transparent', true], ['hasShadow', false], ['alwaysOnTop', true], ['skipTaskbar', true], ['show', false], ['frame', false], ['resizable', false]]) assert.strictEqual(op[k], v, k);
  assert.ok(!('backgroundThrottling' in op));
  assert.strictEqual(op.webPreferences.sandbox, true);
  assert.strictEqual(op.webPreferences.contextIsolation, true);
  const calls = nudgeCalls(o);
  assert.ok(calls.some((c) => Array.isArray(c) && c[0] === 'setContentProtection' && c[1] === true), JSON.stringify(calls));
  assert.ok(calls.some((c) => Array.isArray(c) && c[0] === 'setAlwaysOnTop' && c[1][0] === true && c[1][1] === 'screen-saver'), JSON.stringify(calls));
  assert.strictEqual(calls.filter((c) => c === 'showInactive').length, 1);
  assert.strictEqual(calls.filter((c) => c === 'show' || c === 'focus').length, 0, 'パネルを show・focus で出した（会議のアプリの入力を奪う）');
  assert.strictEqual(shows(o).length, 1);
  assert.strictEqual(shows(o)[0].label, 'Zoom');
  assert.deepStrictEqual(o.mainWinCalls, [], 'パネルを出しただけで本体の窓を前に出した');
});

test('M4: 置き場所はカーソルの画面の作業領域の右上（カードの端が 12px）。パネルが測った大きさで置き直す。出している間はカーソルを動かしても飛ばない', S, async () => {
  const o = await run([['cursor', 2500, 300], ...Z2, ['ipc', 'nudge:size', { w: 520, h: 60 }], ['cursor', 10, 10], ['ipc', 'nudge:size', { w: 520, h: 200 }]],
    '--displays=0,0,1920,1040;1920,0,1280,984');
  const b = nudgeCalls(o).filter((c) => Array.isArray(c) && c[0] === 'setBounds').map((c) => c[1]);
  assert.ok(b.length >= 3, JSON.stringify(b));
  const P = 8, E = 12;
  assert.deepStrictEqual(b[b.length - 2], { x: 1920 + 1280 - (E - P) - (520 + 2 * P), y: E - P, width: 520 + 2 * P, height: 60 + 2 * P });
  assert.deepStrictEqual(b[b.length - 1], { x: 1920 + 1280 - (E - P) - (520 + 2 * P), y: E - P, width: 520 + 2 * P, height: 200 + 2 * P });
});

test('M3: 議事録を始めると引っ込め、録音中に Zoom が新しく見えても出さない。マイクを離すとすぐ引っ込める', S, async () => {
  const o = await run([...Z2, ['start'], ['snap', 'started'], ['line', 'mic zoom:999,teams:5'], ['line', 'mic zoom:999,teams:5'], ['sleep', 30]]);
  assert.strictEqual(nudgeCalls(o).filter((c) => c === 'showInactive').length, 1, '録音中に始まった会議にパネルを出した');
  const hideAt = nudgeCalls(o).indexOf('hide');
  assert.ok(hideAt >= 0 && hideAt < o.snaps.started.nudgeCalls, '録音を始めても引っ込めない');
  const r = await run([...Z2, ['line', 'mic -']]);
  assert.deepStrictEqual(nudgeCalls(r).filter((c) => c === 'showInactive' || c === 'hide'), ['showInactive', 'hide']);
  assert.ok(r.engineLog.includes('会議の検出: パネルを引っ込めた（sample）'), r.engineLog.join('\n'));
});

test('Q5: nudge:start で始まり（会議中）、本体の窓を出して（show・focus）meeting:show-live を送る。トレイに隠した窓・最小化した窓でも。pcOnly なら localOnly', S, async () => {
  const o = await run([...Z2, ['ipc', 'nudge:start', { pcOnly: false }], ['sleep', 50]], '--main-hidden');
  assert.deepStrictEqual(o.ipc.find(([ch]) => ch === 'nudge:start')[1], { ok: true, localOnly: false });
  assert.strictEqual(o.active, true);
  assert.ok(o.mainWinCalls.includes('show') && o.mainWinCalls.includes('focus'), `トレイに隠した窓を出していない: ${JSON.stringify(o.mainWinCalls)}`);
  assert.strictEqual(sentMain(o, 'meeting:show-live').length, 1);
  assert.strictEqual(o.status.localOnly, false);
  assert.ok(nudgeCalls(o).includes('hide'), '始めたのにパネルが出たまま');
  const m = await run([...Z2, ['ipc', 'nudge:start', { pcOnly: true }], ['sleep', 50]], '--main-minimized');
  assert.ok(m.mainWinCalls.includes('restore'), JSON.stringify(m.mainWinCalls));
  assert.strictEqual(m.status.localOnly, true, 'オフラインモードで始めたのに localOnly でない');
  assert.strictEqual(sentMain(m, 'meeting:show-live').length, 1);
});

test('D50: nudge:start は pcOnly のほかの引数（種類など）を読まず、［新しい議事録］と同じ既定で始める。パネルが出ていない／idle でないときの nudge:start は何もしない', S, async () => {
  const o = await run([...Z2, ['ipc', 'nudge:start', { pcOnly: 'yes', meetingType: 'sales', type: 'sales' }], ['sleep', 50]]);
  assert.strictEqual(o.status.localOnly, false, '"yes" を真とみなした');
  assert.ok(!JSON.stringify(o.status).includes('sales'), JSON.stringify(o.status));
  const none = await run([['ipc', 'nudge:start', { pcOnly: false }]]);
  assert.deepStrictEqual(none.ipc[0][1], { ok: false });
  assert.strictEqual(none.active, false);
  const busy = await run([...Z2, ['dictate'], ['ipc', 'nudge:start', { pcOnly: false }]]);
  assert.deepStrictEqual(busy.ipc.find(([ch]) => ch === 'nudge:start')[1], { ok: false });
  assert.strictEqual(busy.active, false);
  assert.deepStrictEqual(busy.notices, [], '音声入力の間に押した nudge:start が知らせを出した');
});

test('M7: nudge:mute は引数を読まず、出している id だけを meetingDetectMute に足し、settings:patched を送る（引数に別の id を渡しても保存されない）。出していなければ何もしない', S, async () => {
  const o = await run([...Z2, ['ipc', 'nudge:mute', 'webex'], ['line', 'mic zoom:555'], ['line', 'mic zoom:555'], ['ipc', 'nudge:mute', 'slack']]);
  assert.deepStrictEqual(JSON.parse(o.settingsText).meetingDetectMute, ['zoom']);
  assert.deepStrictEqual(sentMain(o, 'settings:patched'), [{ meetingDetectMute: ['zoom'] }]);
  assert.strictEqual(nudgeCalls(o).filter((c) => c === 'showInactive').length, 1, '出さないにした Zoom の新しい使いでまた出した');
  assert.ok(nudgeCalls(o).includes('hide'));
});

test('nudge:settings は引っ込めて本体の窓を出し、app:open-settings（録音の「会議の検出の通知」）を送る。× は引っ込める', S, async () => {
  const o = await run([...Z2, ['ipc', 'nudge:settings']], '--main-hidden');
  assert.ok(o.mainWinCalls.includes('show'), JSON.stringify(o.mainWinCalls));
  assert.deepStrictEqual(sentMain(o, 'app:open-settings'), [{ sec: 'record', row: '会議の検出の通知' }]);
  assert.ok(nudgeCalls(o).includes('hide'));
  const c = await run([...Z2, ['ipc', 'nudge:close'], ['line', Z]]);
  assert.deepStrictEqual(nudgeCalls(c).filter((x) => x === 'showInactive' || x === 'hide'), ['showInactive', 'hide']);
});

test('Q2: 30 秒で引っ込める。nudge:hover の間は引っ込めない（離れて 5 秒で引っ込める）', S, async () => {
  const o = await run([...Z2, ['clock', 31000], ['sleep', 1300]]);
  assert.ok(nudgeCalls(o).includes('hide'), '30 秒たっても引っ込めない');
  assert.ok(o.engineLog.includes('会議の検出: パネルを引っ込めた（tick）'), o.engineLog.join('\n'));
  const h = await run([...Z2, ['ipc', 'nudge:hover', true], ['clock', 60000], ['sleep', 1300], ['snap', 'hover'], ['ipc', 'nudge:hover', false], ['clock', 6000], ['sleep', 1300]]);
  assert.ok(nudgeCalls(h).indexOf('hide') >= h.snaps.hover.nudgeCalls, 'カーソルが乗っている間に引っ込めた');
  assert.ok(nudgeCalls(h).includes('hide'), '離れて 5 秒たっても引っ込めない');
});

test('Q3: nudge:show の theme は nativeTheme.shouldUseDarkColors から。出している間に updated が来たら送り直す', S, async () => {
  const l = await run([...Z2, ['theme', true], ['sleep', 20]]);
  assert.deepStrictEqual(shows(l).map((p) => p.theme), ['light', 'dark']);
  assert.deepStrictEqual(shows(l).map((p) => p.label), ['Zoom', 'Zoom']);
  const d = await run([...Z2, ['ipc', 'nudge:close'], ['theme', false]], '--dark');
  assert.deepStrictEqual(shows(d).map((p) => p.theme), ['dark'], '引っ込めた後の updated で送った');
});

test('M5: engine.log にアプリの名前と id が無い（パネルを出した・引っ込めた・押した道のどれでも）。Notion・NaTsu のマイクでは何も出さない', S, async () => {
  const o = await run([...Z2, ['ipc', 'nudge:mute'], ['line', 'mic teams:7'], ['line', 'mic teams:7'], ['ipc', 'nudge:start', { pcOnly: true }], ['stop']]);
  assert.ok(o.engineLog.includes('会議の検出: パネルを出した'), o.engineLog.join('\n'));
  assert.ok(!o.engineLog.some((l) => /^会議の検出/.test(l) && NAMES.test(l)), o.engineLog.join('\n'));
  const n = await run([['line', 'mic notion:1'], ['line', 'mic notion:1'], ['line', 'mic natsu:2'], ['line', 'mic natsu:2'], ['sleep', 30]]);
  assert.strictEqual(n.nudgeWindows, 0, 'Notion・NaTsu のマイクでパネルを作った');
});

// ---------------------------------------------------------------- M-5: 音の大きさを録音中のページへ（決めたこと 14・15・22）
const asks = (o) => o.overlayAsks;
test('M9: 録音中のページが見えている 1 秒で overlay:level-ask が 5〜12 回（100ms ごと）。最小化・ページを開いていない・一時停止では 0 回。M8: 録音バーを × で隠しても聞き続ける', S, async () => {
  const o = await run([['start'], ['live', true], ['snap', 'a'], ['sleep', 1000], ['snap', 'b']]);
  const n = o.snaps.b.asks - o.snaps.a.asks;
  assert.ok(n >= 5 && n <= 12, `1 秒に ${n} 回`);   // 100ms ごと（混んだ機械では時計が遅れるので下は 5）
  const min = await run([['start'], ['live', true], ['minimize'], ['snap', 'a'], ['sleep', 600], ['snap', 'b']]);
  assert.strictEqual(min.snaps.b.asks - min.snaps.a.asks, 0, '最小化しても聞いた');
  const nolive = await run([['start'], ['live', false], ['snap', 'a'], ['sleep', 600], ['snap', 'b']]);
  assert.strictEqual(nolive.snaps.b.asks - nolive.snaps.a.asks, 0, '録音中のページを開いていないのに聞いた');
  const paused = await run([['start'], ['live', true], ['ipc', 'overlay:pause', { paused: true }], ['snap', 'a'], ['sleep', 600], ['snap', 'b'], ['ipc', 'overlay:pause', { paused: false }], ['sleep', 400], ['snap', 'c']]);
  assert.strictEqual(paused.snaps.b.asks - paused.snaps.a.asks, 0, '一時停止中に聞いた');
  assert.ok(paused.snaps.c.asks - paused.snaps.b.asks >= 2, '再開しても聞き直さない');
  const hidden = await run([['start'], ['live', true], ['ipc', 'overlay:hide-panel'], ['snap', 'a'], ['sleep', 600], ['snap', 'b']]);
  assert.ok(hidden.snaps.b.asks - hidden.snaps.a.asks >= 4, '録音バーを隠したら聞くのをやめた');
  const idle = await run([['live', true], ['snap', 'a'], ['sleep', 400], ['snap', 'b'], ['start'], ['stop'], ['snap', 'c'], ['sleep', 400], ['snap', 'd']]);
  assert.strictEqual(idle.snaps.b.asks - idle.snaps.a.asks, 0, '録音していないのに聞いた');
  assert.strictEqual(idle.snaps.d.asks - idle.snaps.c.asks, 0, '録音を止めた後も聞いた');
});

test('M8: overlay:level の中身を levelMsg で照らして meeting:level で送る（warn に好きな文を入れても \'\'・数は 0〜1）。聞いていないときは送らない', S, async () => {
  const o = await run([['start'], ['live', true], ['ipc', 'overlay:level', { mic: 0.5, sys: 3, warn: '<b>好きな文</b>' }], ['ipc', 'overlay:level', { mic: 0.123, sys: 0, warn: '音が入っていません' }],
    ['live', false], ['ipc', 'overlay:level', { mic: 0.9, sys: 0, warn: '' }]]);
  assert.deepStrictEqual(sentMain(o, 'meeting:level'), [{ mic: 0.5, sys: 1, warn: '' }, { mic: 0.12, sys: 0, warn: '音が入っていません' }]);
});
