/*
 * stage121.main.test.js — 0.12.1 の main の場面（計画 docs/plans/2026-10-24-121.md の Task LV-2・LV-3）
 * LV-2: 議事録の録音中も会議の検出の見張りを動かし、見張る会議のアプリ（W）を決める（設定「会議を出たら自動で止める」。記録にアプリの名前を書かない）。
 * 場面は helpers/mainrun.js を別のプロセスで回す（--mic-feed。見張りは偽の子で、場面が行を書く。偽の時計 ["clock", ms] で読みの間を作る）。
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
// 見張りの1行を書いて、偽の時計を 2 秒進める（本物の見張りの読みの間）
const L = (s) => [['line', s], ['clock', 2000]];
const Ls = (s, n) => Array.from({ length: n }, () => L(s)).flat();
const FOUND = '会議を出たかの見張り: 会議のアプリがマイクを使っているのを見た（この録音で見張る）';
// 記録・経過・知らせに出てはいけないアプリの名前（0.9.3 の K3）
const NAMES = /Teams|teams|Zoom|zoom|ms-teams|Chrome|chrome|Edge|msedge/;
const noNames = (o) => {
  for (const l of o.engineLog) assert.ok(!NAMES.test(l), `engine.log にアプリの名前: ${l}`);
  assert.ok(!NAMES.test(JSON.stringify(o.pageStateLogs)), JSON.stringify(o.pageStateLogs));
};
const PANEL = (id) => [...L(`mic ${id}:1`), ...L(`mic ${id}:1`), ['wait-show', 1], ['ipc', 'nudge:start', {}]];

// ---------------------------------------------------------------- LV-2（決めたこと L2・L3・L14〜L17・L19〜L21）
test('LV-2（L16）: 議事録の録音中も見張りが動く（止めない）・idle に戻っても起こし直さない・音声入力では止める', S, async () => {
  const steps = [['snap', 'boot'], ['start'], ['snap', 'meeting'], ['stop'], ['snap', 'idle'], ['dictate'], ['snap', 'dictate'], ['dictate-cancel'], ['snap', 'after']];
  const o = await run(steps);
  assert.deepStrictEqual([o.snaps.boot.spawns, o.snaps.boot.kills], [1, 0]);
  assert.strictEqual(o.snaps.meeting.active, true);
  assert.deepStrictEqual([o.snaps.meeting.spawns, o.snaps.meeting.kills], [1, 0], '議事録の録音中に見張りを止めた');
  assert.deepStrictEqual([o.snaps.idle.spawns, o.snaps.idle.kills], [1, 0], 'idle に戻るときに起こし直した');
  assert.deepStrictEqual([o.snaps.dictate.spawns, o.snaps.dictate.kills], [1, 1], '音声入力の録音中も見張りが動いている');
  assert.deepStrictEqual([o.snaps.after.spawns, o.snaps.after.kills], [2, 1]);
  // 設定「会議を出たら自動で止める」がオフなら 0.9.3 のまま（議事録の録音中は止める）
  const off = await run(steps, '--leave=off');
  assert.deepStrictEqual([off.snaps.meeting.spawns, off.snaps.meeting.kills], [1, 1], '--leave=off なのに議事録の録音中も見張りが動いている');
  assert.deepStrictEqual([off.snaps.idle.spawns, off.snaps.idle.kills], [2, 1]);
  // 「会議の検出の通知」を切っていても、録音中だけ起こし、idle では起こさない
  const det = await run(steps, '--detect=off');
  assert.deepStrictEqual([det.snaps.boot.spawns, det.snaps.boot.kills], [0, 0]);
  assert.deepStrictEqual([det.snaps.meeting.spawns, det.snaps.meeting.kills], [1, 0], '録音中に起こさない');
  assert.deepStrictEqual([det.snaps.idle.spawns, det.snaps.idle.kills], [1, 1], 'idle に戻っても止めない');
  assert.deepStrictEqual([det.snaps.after.spawns, det.snaps.after.kills], [1, 1]);
});

test('LV-2（L3）: パネルから始めた Teams・Chrome は初めから見張る（記録に1行）', S, async () => {
  for (const id of ['teams', 'chrome']) {
    const o = await run([...PANEL(id), ...Ls(`mic ${id}:1`, 3)]);
    assert.strictEqual(o.active, true, id);
    assert.strictEqual(o.engineLog.filter((l) => l === FOUND).length, 1, `${id}: ${o.engineLog.join('\n')}`);
    noNames(o);
  }
});

test('LV-2（L3・LQ5）: ホットキーで始めて後から Zoom が2回続けて見えたら見張る（1回だけなら見張らない）。Firefox は何回見えても見張らない', S, async () => {
  const two = await run([['hotkey-meeting'], ...Ls('mic zoom:7', 2), ...Ls('mic zoom:7', 2)]);
  assert.strictEqual(two.active, true);
  assert.strictEqual(two.engineLog.filter((l) => l === FOUND).length, 1, two.engineLog.join('\n'));
  noNames(two);
  const one = await run([['hotkey-meeting'], ...L('mic zoom:7'), ...L('mic -'), ...L('mic zoom:7'), ...L('mic -')]);
  assert.ok(!one.engineLog.includes(FOUND), one.engineLog.join('\n'));
  const ff = await run([['hotkey-meeting'], ...Ls('mic firefox:3', 5)]);
  assert.ok(!ff.engineLog.includes(FOUND), ff.engineLog.join('\n'));
  // 会議のアプリを一度も見ていない録音（対面の会議）も見張らない
  const none = await run([['start'], ...Ls('mic -', 5)]);
  assert.ok(!none.engineLog.includes(FOUND), none.engineLog.join('\n'));
  assert.strictEqual(none.active, true);
});

// ---------------------------------------------------------------- LV-3（決めたこと L4〜L13・L18）: 黙って止め、止めた後に1回知らせる
const STOP_LOG = '会議を出たかの見張り: 会議のアプリがマイクを放したので、録音を止めた';
const BLIP = '会議を出たかの見張り: 少しだけ放して見えたので止めない';
const LOST = '会議を出たかの見張り: 見張りの記録が読めないので数え直す';
const GAP = '会議を出たかの見張り: 見張りの読みが途切れたので数え直す';
const LN4 = '会議を出たので録音を止めました。議事録を作っています。';
const count = (o, line) => o.engineLog.filter((l) => l === line).length;
const stops = (o) => o.engineLog.filter((l) => l.startsWith('会議: 止めた')).length;
const lastState = (o) => { const sl = (o.pageStateLogs[0] || {}).stateLog || []; const x = sl[sl.length - 1]; return x ? `${x.s}/${x.by}` : ''; };
const shows = (o) => (o.nudge ? o.nudge.calls.filter((c) => c === 'showInactive').length : 0);
const sentBetween = (o, a, b) => o.mainSentAll.slice(o.snaps[a].sentN, o.snaps[b].sentN);

test('LV-3（L4・L10・L11・L13）: 出たら黙って止める（放した読み3回目）。知らせは LN4 がちょうど1つ（録音中のページが見えていても・止めた後にまた mic - が来ても1つ）。経過は auto-stop/leave・所要時間は放した最初の読みまで', S, async () => {
  const steps = [...PANEL('teams'), ['live', true], ...Ls('mic teams:1', 2), ...L('mic -'), ['line', 'mic -'], ['snap', 'two'], ['clock', 7000], ['line', 'mic -'], ['snap', 'three'],
    ['clock', 2000], ...Ls('mic -', 2), ['snap', 'after'], ['finish']];
  for (const flags of [[], ['--main-hidden']]) {
    const o = await run(steps, ...flags);
    assert.strictEqual(o.snaps.two.notes, 0, '放した読み2回で知らせた');
    assert.strictEqual(o.engineLog.slice(0, o.engineLog.indexOf(STOP_LOG) + 1).filter((l) => l.startsWith('会議: 止めた')).length, 0, '止めた行より前に止めた');
    assert.strictEqual(o.snaps.three.notes, 1, `${flags}: 3回目で止めて知らせていない`);
    assert.strictEqual(count(o, '会議: 止めた（auto-leave）'), 1, o.engineLog.join('\n'));
    assert.strictEqual(stops(o), 1);
    assert.strictEqual(count(o, STOP_LOG), 1, o.engineLog.join('\n'));
    assert.deepStrictEqual(o.notifications.map((n) => [n.title, n.body]), [['NaTsu', LN4]], `${flags}: ${JSON.stringify(o.notifications)}`);
    assert.strictEqual(count(o, '会議を出たかの見張り: Windows の知らせ'), 1);
    assert.strictEqual(lastState(o), 'auto-stop/leave', JSON.stringify(o.pageStateLogs));
    assert.ok(o.engineLog.includes('議事録: 終了（会議を出たので自動）'), o.engineLog.join('\n'));
    // 所要時間は放した最初の読み（始めてから約 4 秒）まで。止めた3回目の読み（約 13 秒）までではない
    const d = o.pageDur[0].durationSec;
    assert.ok(d >= 4 && d <= 7, `所要時間 ${d}`);
    // 0.9.1 の止めた後の知らせは出ない・録音中の状態に新しい欄が無い
    assert.ok(!JSON.stringify(o.notices).includes('話し声が無かったので'), JSON.stringify(o.notices));
    assert.ok(!Object.keys(o.status).some((k) => /leave/i.test(k)), JSON.stringify(Object.keys(o.status)));
    noNames(o);
  }
});

test('LV-3（L11）: 知らせを押すと、作成中なら録音中のページ（meeting:show-live）、保存した後なら本体の窓を出してそのページを開く（page:open）', S, async () => {
  const o = await run([...PANEL('teams'), ...Ls('mic -', 3), ['snap', 's'], ['click-notice', 0], ['snap', 'c1'], ['finish'], ['snap', 'f'], ['click-notice', 0], ['snap', 'c2']]);
  assert.strictEqual(o.notifications.length, 1);
  assert.ok(sentBetween(o, 's', 'c1').some(([ch]) => ch === 'meeting:show-live'), JSON.stringify(sentBetween(o, 's', 'c1')));
  const id = o.pageDur[0].id;
  assert.ok(typeof id === 'string' && id.length > 0);
  assert.deepStrictEqual(sentBetween(o, 'f', 'c2').filter(([ch]) => ch === 'page:open'), [['page:open', id]], JSON.stringify(sentBetween(o, 'f', 'c2')));
  assert.ok(!sentBetween(o, 'f', 'c2').some(([ch]) => ch === 'meeting:show-live'));
});

test('LV-3（F60）: 少しだけ放して見えた（mic - → teams → mic - ×2 → teams）は止めず、知らせも無い。記録に「少しだけ放して見えたので止めない」が2回', S, async () => {
  const o = await run([...PANEL('teams'), ...L('mic -'), ...L('mic teams:1'), ...Ls('mic -', 2), ...L('mic teams:1')]);
  assert.strictEqual(stops(o), 0, o.engineLog.join('\n'));
  assert.strictEqual(o.active, true);
  assert.strictEqual(o.notifications.length, 0);
  assert.strictEqual(count(o, BLIP), 2, o.engineLog.join('\n'));
  noNames(o);
});

test('LV-3（F71・問9）: 参加の前の画面から入る（パネルから始めて 5 分待った後に mic - ×2 → teams:2）は止まらず、その後に会議を出ると止まる', S, async () => {
  const o = await run([...PANEL('teams'), ...Ls('mic teams:1', 150), ...Ls('mic -', 2), ...Ls('mic teams:2', 3), ['snap', 'mid'], ...Ls('mic -', 3)]);
  assert.strictEqual(o.snaps.mid.notes, 0);
  assert.strictEqual(o.engineLog.slice(0, o.engineLog.indexOf(STOP_LOG)).filter((l) => l.startsWith('会議: 止めた')).length, 0);
  assert.strictEqual(count(o, BLIP), 1, o.engineLog.join('\n'));
  assert.strictEqual(count(o, '会議: 止めた（auto-leave）'), 1);
  assert.strictEqual(o.notifications.length, 1);
});

test('LV-3（F61・R3）: 機器の切り替え（teams:1 → mic - ×3）は止まり知らせは1つ。止めた後 60 秒の内の teams:2 にはパネルを出さず（0.9.3 のつなぎ直し）、60 秒より後の teams:3 で出す。素早い切り替えと mic - ×2 で戻る切り替えでは止まらない', S, async () => {
  const o = await run([...PANEL('teams'), ...L('mic teams:1'), ...Ls('mic -', 3), ['finish'], ...Ls('mic teams:2', 2), ['snap', 'rejoin'], ...L('mic -'), ['clock', 61000],
    ...Ls('mic teams:3', 2), ['wait-show', 2]]);
  assert.strictEqual(count(o, '会議: 止めた（auto-leave）'), 1);
  assert.strictEqual(o.notifications.length, 1);
  assert.strictEqual(lastState(o), 'auto-stop/leave');
  assert.ok(o.engineLog.includes('会議の検出: 出さない（rejoin）'), o.engineLog.join('\n'));
  assert.strictEqual(shows(o), 2, JSON.stringify(o.nudge && o.nudge.calls));
  const quick = await run([...PANEL('teams'), ...L('mic teams:1'), ...Ls('mic teams:2', 2), ...Ls('mic -', 2), ...Ls('mic teams:3', 2)]);
  assert.strictEqual(stops(quick), 0, quick.engineLog.join('\n'));
  assert.strictEqual(quick.notifications.length, 0);
});

test('LV-3（L5）: Chrome のパネルから始めた録音で、mic - ×2 の後に同じ Chrome の別の使い（Start が違う）が来たら止めない', S, async () => {
  const o = await run([...PANEL('chrome'), ...Ls('mic -', 2), ...Ls('mic chrome:99', 3)]);
  assert.strictEqual(stops(o), 0, o.engineLog.join('\n'));
  assert.strictEqual(count(o, BLIP), 1);
  noNames(o);
});

test('LV-3（L7・L6・F62）: データが無いときは止めない（見張りが落ちた・err read を挟む・読みが 5 分空いた・行が来ない）', S, async () => {
  const gone = await run([...PANEL('teams'), ...L('mic -'), ['exit', 1], ['clock', 600000], ['sleep', 50]]);
  assert.strictEqual(stops(gone), 0, gone.engineLog.join('\n'));
  assert.strictEqual(gone.active, true);
  assert.strictEqual(count(gone, LOST), 1, gone.engineLog.join('\n'));
  const err = await run([...PANEL('teams'), ...Ls('mic -', 2), ...L('err read'), ...Ls('mic -', 2), ['snap', 'm'], ...L('mic -')]);
  assert.strictEqual(err.snaps.m.notes, 0);
  assert.strictEqual(err.engineLog.slice(0, err.engineLog.indexOf(STOP_LOG)).filter((l) => l.startsWith('会議: 止めた')).length, 0);
  assert.strictEqual(count(err, '会議: 止めた（auto-leave）'), 1, err.engineLog.join('\n'));
  assert.strictEqual(count(err, LOST), 1);
  const gap = await run([...PANEL('teams'), ...Ls('mic -', 2), ['clock', 300000], ...L('mic -'), ['snap', 'g'], ...Ls('mic -', 2)]);
  assert.strictEqual(gap.snaps.g.notes, 0);
  assert.strictEqual(count(gap, GAP), 1, gap.engineLog.join('\n'));
  assert.strictEqual(count(gap, '会議: 止めた（auto-leave）'), 1, gap.engineLog.join('\n'));
  const idle = await run([...PANEL('teams'), ...L('mic -'), ['clock', 600000], ['sleep', 50]]);
  assert.strictEqual(stops(idle), 0);
  assert.strictEqual(idle.active, true);
});

test('LV-3（L8）: 一時停止の間の mic - ×5 では止めず、再開の後の mic - ×3 で止める', S, async () => {
  const o = await run([...PANEL('teams'), ['pause', true], ...Ls('mic -', 5), ['snap', 'p'], ['pause', false], ...Ls('mic -', 3)]);
  assert.strictEqual(o.snaps.p.notes, 0);
  assert.strictEqual(o.engineLog.slice(0, o.engineLog.indexOf(STOP_LOG)).filter((l) => l.startsWith('会議: 止めた')).length, 0);
  assert.ok(o.engineLog.includes('議事録: 一時停止（画面のボタン）'), o.engineLog.join('\n'));
  assert.strictEqual(count(o, '会議: 止めた（auto-leave）'), 1, o.engineLog.join('\n'));
});

test('LV-3（F68）: 手で止めた会議は1回だけ止め LN4 を出さない（止めた後の mic - も数えない）。破棄の後も止めない。設定を切ると止めない', S, async () => {
  const hand = await run([...PANEL('teams'), ...Ls('mic -', 2), ['bar-stop'], ...Ls('mic -', 3), ['finish']]);
  assert.strictEqual(stops(hand), 1, hand.engineLog.join('\n'));
  assert.strictEqual(count(hand, '会議: 止めた（bar）'), 1);
  assert.strictEqual(count(hand, STOP_LOG), 0, hand.engineLog.join('\n'));
  assert.strictEqual(hand.notifications.length, 0, JSON.stringify(hand.notifications));
  assert.strictEqual(lastState(hand), 'stop/overlay');
  const dis = await run([...PANEL('teams'), ...Ls('mic -', 2), ['discard'], ...Ls('mic -', 3)]);
  assert.strictEqual(stops(dis), 0, dis.engineLog.join('\n'));
  assert.strictEqual(dis.notifications.length, 0);
  assert.strictEqual(dis.active, false);
  const off = await run([...PANEL('teams'), ['save', { autoStopLeave: false }], ...Ls('mic -', 5)]);
  assert.strictEqual(stops(off), 0, off.engineLog.join('\n'));
  assert.strictEqual(off.active, true);
  assert.strictEqual(off.notifications.length, 0);
});

test('LV-3（L18）: 会議を出て止めた後、放した読みで見えた別のアプリ（Zoom）には idle に戻った後の読みでパネルを出す。手で止めた普通の会議では、録音中に始まった Zoom に出さない', S, async () => {
  const o = await run([...PANEL('teams'), ...L('mic teams:1'), ...Ls('mic zoom:5', 3), ['finish'], ...L('mic zoom:5'), ['wait-show', 2]]);
  assert.strictEqual(count(o, '会議: 止めた（auto-leave）'), 1, o.engineLog.join('\n'));
  assert.strictEqual(shows(o), 2, JSON.stringify(o.nudge && o.nudge.calls));
  noNames(o);
  const hand = await run([...PANEL('teams'), ...Ls('mic teams:1,zoom:5', 2), ['bar-stop'], ['finish'], ...Ls('mic zoom:5', 3)]);
  assert.strictEqual(shows(hand), 1, JSON.stringify(hand.nudge && hand.nudge.calls));
});

// 話し声の帯とぶつかる（決めたこと L12・F66）: 帯は区間の文字起こしで出るので --quiet-seq の場面に --quiet-mic で見張りの字を足す（R2）
const runQ = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001' }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
test('LV-3（L12・F66）: 話し声の帯が出ている間に会議を出ると、会議を出た決まりで止まり、帯と話し声の Windows の知らせを閉じる。経過は auto-stop/leave・知らせは LN4 だけ・その後 10 分たっても止めるのは1回', S, async () => {
  const o = await runQ(['text', '--relay=text', '--quiet-mic', '--quiet-seq=T,T,t,s*11,L,L,L', '--main-hidden']);
  const asked = o.quietTrace.findIndex((x) => x.asked);
  assert.ok(asked > 0, JSON.stringify(o.quietTrace));
  assert.strictEqual(o.quietStopAt, o.quietTrace.length - 1, JSON.stringify(o.quietTrace));
  assert.strictEqual(o.quietTrace[o.quietTrace.length - 2].asked, true, '止める前に帯が出ていない');
  assert.strictEqual(o.quietTrace[o.quietTrace.length - 1].asked, false, '止めた後も帯が出ている');
  assert.ok(o.notifyClosed >= 1, '話し声の Windows の知らせを閉じていない');
  assert.strictEqual(o.stopCalls, 1);
  assert.strictEqual(o.engineLog.filter((l) => l.startsWith('会議: 止めた')).length, 1, o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('会議: 止めた（auto-leave）'), o.engineLog.join('\n'));
  const sl = o.pageDur.stateLog;
  assert.deepStrictEqual([sl[sl.length - 1].s, sl[sl.length - 1].by], ['auto-stop', 'leave'], JSON.stringify(sl));
  assert.ok(o.notifications.some((n) => n.body === LN4), JSON.stringify(o.notifications));
  assert.ok(!o.notifications.some((n) => /話し声が無かったので/.test(n.body)), JSON.stringify(o.notifications));
  assert.ok(!JSON.stringify(o.notices).includes('話し声が無かったので'), JSON.stringify(o.notices));
});

// ---------------------------------------------------------------- 点検の直し（2026-10-25）
test('点検の直し 1（L18・F64）: 止めた後の作成中に新しく始まった別のアプリの使い（Zoom）には、idle に戻った後の読みでパネルを出す（会議を出て止めた・手で止めたのどちらでも）。録音中に始まった使いは今どおり出さない', S, async () => {
  const leave = await run([...PANEL('teams'), ...L('mic teams:1'), ...Ls('mic -', 3), ...Ls('mic zoom:5', 2), ['finish'], ...L('mic zoom:5'), ['wait-show', 2]]);
  assert.strictEqual(count(leave, '会議: 止めた（auto-leave）'), 1, leave.engineLog.join('\n'));
  assert.strictEqual(shows(leave), 2, JSON.stringify(leave.nudge && leave.nudge.calls));
  const hand = await run([...PANEL('teams'), ...L('mic teams:1'), ['bar-stop'], ...Ls('mic teams:1,zoom:5', 2), ['finish'], ...L('mic teams:1,zoom:5'), ['wait-show', 2]]);
  assert.strictEqual(count(hand, '会議: 止めた（bar）'), 1, hand.engineLog.join('\n'));
  assert.strictEqual(shows(hand), 2, JSON.stringify(hand.nudge && hand.nudge.calls));
  // 録音中から使っている Teams（作成中も続く）は出さない（パネルは Zoom の1回だけ増える）
  noNames(hand);
});
test('点検の直し 3（L11）: 保存の後に議事録の一覧（pages.list）を読めなくても、知らせを押すとそのページを開く（開くページは保存した直後に覚える）', S, async () => {
  const o = await run([...PANEL('teams'), ...Ls('mic -', 3), ['db-fail', 'pages.list'], ['finish'], ['sleep', 50], ['snap', 'f'], ['click-notice', 0], ['snap', 'c']]);
  assert.strictEqual(o.notifications.length, 1);
  const id = o.pageDur[0].id;
  assert.ok(typeof id === 'string' && id.length > 0);
  assert.deepStrictEqual(sentBetween(o, 'f', 'c').filter(([ch]) => ch === 'page:open'), [['page:open', id]], JSON.stringify(sentBetween(o, 'f', 'c')));
});
