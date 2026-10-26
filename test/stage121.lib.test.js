/*
 * stage121.lib.test.js — 0.12.1 Task LV-1（計画 docs/plans/2026-10-24-121.md の決めたこと L1〜L9・L18 の純粋な部分）
 * 会議を出たかの判断（src/meetleave.js の leaveInit・leaveStep）: 見張る会議のアプリ（W）がマイクを放したのを、見張りの3回続けての読みで見たら止める。
 * 2回までの放し・データが無い・読みが途切れた・一時停止・設定がオフでは止めない。W に足すのは2回続けて使っているのを見たとき（パネルのアプリは初めから）。
 * パネルの判断（mainlib.nudgeStep）の forget: 会議を出て止めた後に、放した読みで見えた別のアプリの使いの印を外す。
 * 時刻は出来事の now だけを使う（Date.now() を読まない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const ML = require('../src/meetleave');
const lib = require('../src/mainlib');

const T = { timeout: 5000 };
const A = ML.LEAVE_IDS;
const T0 = 1700000000000;
const itemsOf = (s) => (s === '-' ? [] : s.split(',').map((p) => { const i = p.indexOf(':'); return { id: p.slice(0, i), start: p.slice(i + 1) }; }));
// 並びを順に通す。文字は見張りの1行の形（'-' か 'teams:1,zoom:2'）で、now を dt（既定 2 秒）ずつ進めた sample。
// 物は { ev, dt?, at? }（dt だけ進めるか at にしてから ev に now を付ける）。答えの act と goneAt・others を集める
function play(init, steps, { dt = 2000, t0 = T0 } = {}) {
  let st = ML.leaveInit(init);
  let now = t0;
  const acts = [];
  const outs = [];
  for (const s of steps) {
    let ev;
    if (typeof s === 'string') { now += dt; ev = { type: 'sample', items: itemsOf(s), now }; }
    else {
      if (s.at !== undefined) now = s.at; else now += s.dt === undefined ? 0 : s.dt;
      ev = { ...s.ev, now: s.ev.now === undefined ? now : s.ev.now };
    }
    const o = ML.leaveStep(st, ev);
    st = o.st;
    acts.push(o.act);
    outs.push(o);
  }
  return { st, acts, outs, now };
}
const rep = (s, n) => Array.from({ length: n }, () => s);
const PANEL = { apps: A, first: 'teams' };
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

test('LV-1: 数と LEAVE_IDS（Teams・Zoom・Chrome・Edge だけ。どれも MEET_APPS の id。凍っている）', T, () => {
  assert.strictEqual(ML.LEAVE_SEEN, 2);
  assert.strictEqual(ML.LEAVE_GONE, 3);
  assert.strictEqual(ML.LEAVE_GAP_MS, 10000);
  assert.deepStrictEqual([...A], ['teams', 'zoom', 'chrome', 'edge']);
  assert.ok(Object.isFrozen(A));
  const ids = lib.MEET_APPS.map((a) => a.id);
  for (const id of A) assert.ok(ids.includes(id), id);
});

test('LV-1: パネルのアプリは初めから W（Chrome・Edge のパネルも）。Firefox・Webex・Slack のパネルと、パネルでない録音は初めは空（wait）。off なら設定がオフで始める', T, () => {
  for (const first of ['teams', 'zoom', 'chrome', 'edge']) {
    const st = ML.leaveInit({ apps: A, first });
    assert.deepStrictEqual([st.phase, st.w, st.gone], ['in', [first], 0], first);
  }
  for (const first of ['firefox', 'webex', 'slack', null, undefined, 3]) {
    const st = ML.leaveInit({ apps: A, first });
    assert.deepStrictEqual([st.phase, st.w], ['wait', []], String(first));
  }
  assert.strictEqual(ML.leaveInit({ apps: A }).on, true);
  assert.strictEqual(ML.leaveInit({ apps: A, off: true }).on, false);
  // JSON に写せる値だけ
  const st = ML.leaveInit(PANEL);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(st)), st);
});

test('LV-1（F60・問9）: 放した読み1回・2回では止めない。3回続けば stop で goneAt は1回目の時刻。条件が続く間は stop を返し続ける', T, () => {
  const r = play(PANEL, ['teams:1', '-', '-', '-', '-']);
  assert.deepStrictEqual(r.acts, ['', '', '', 'stop', 'stop']);
  assert.strictEqual(r.outs[3].goneAt, T0 + 4000);
  assert.strictEqual(r.outs[4].goneAt, T0 + 4000);
  assert.deepStrictEqual([r.outs[1].st.gone, r.outs[2].st.gone], [1, 2]);
  assert.strictEqual(r.outs[1].st.goneAt, T0 + 4000);
  // 放した読み2回では止めない（問9 の前の決まりの2回ではない）
  assert.ok(!play(PANEL, ['-', '-']).acts.includes('stop'));
});

test('LV-1（F60）: 放した → 使っている → 放した では止めない（blip）。放した ×2 → 使っている → 放した ×2 でも止めない（blip の後は1回目から数え直す）', T, () => {
  const a = play(PANEL, ['-', 'teams:1', '-']);
  assert.deepStrictEqual(a.acts, ['', 'blip', '']);
  assert.strictEqual(a.st.gone, 1);
  const b = play(PANEL, ['-', '-', 'teams:1', '-', '-']);
  assert.deepStrictEqual(b.acts, ['', '', 'blip', '', '']);
  assert.strictEqual(b.st.gone, 2);
  assert.strictEqual(b.st.goneAt, T0 + 8000, 'blip の後の goneAt は数え直した1回目');
  const c = play(PANEL, ['-', '-', 'teams:1', '-', '-', '-']);
  assert.strictEqual(c.acts[5], 'stop');
  assert.strictEqual(c.outs[5].goneAt, T0 + 8000);
});

test('LV-1（F71・問9）: W ができてから 5 分「使っている」読みが続いた後でも、放した ×2 → 使っている では止めない（時間の窓に頼らない）。その後に出れば止まる', T, () => {
  const r = play(PANEL, [...rep('teams:1', 150), '-', '-', 'teams:2', 'teams:2', 'teams:2', '-', '-', '-']);
  assert.deepStrictEqual(r.acts.slice(150), ['', '', 'blip', '', '', '', '', 'stop']);
});

test('LV-1: 使っているアプリの Start が変わっても「使っている」（機器の素早い切り替え・同じブラウザの別のタブ）', T, () => {
  assert.deepStrictEqual(play(PANEL, ['teams:1', 'teams:2', 'teams:3']).acts, ['', '', '']);
  assert.deepStrictEqual(play(PANEL, ['teams:1', '-', 'teams:2']).acts, ['', '', 'blip']);
  assert.deepStrictEqual(play({ apps: A, first: 'chrome' }, ['-', '-', 'chrome:99']).acts, ['', '', 'blip']);
  assert.strictEqual(play(PANEL, ['teams:1', 'teams:2', 'teams:3']).st.gone, 0);
});

test('LV-1（L5・L18）: W に無いアプリ（Firefox・W に入っていない Zoom）が使っていても止める。放した読みで見えた W に無い使いが others に id:start で入る', T, () => {
  const r = play(PANEL, ['teams:1', 'zoom:5', 'zoom:5,firefox:3', 'zoom:5']);
  assert.deepStrictEqual(r.acts, ['', '', '', 'stop']);
  assert.deepStrictEqual([...r.outs[3].others].sort(), ['firefox:3', 'zoom:5']);
  // 使っている読みが来たら others は空に戻る
  const b = play(PANEL, ['zoom:5', 'teams:1']);
  assert.deepStrictEqual(b.st.others, []);
  // W に無い使いが無ければ others は空
  assert.deepStrictEqual(play(PANEL, ['-', '-', '-']).outs[2].others, []);
});

test('LV-1（L3）: パネルでない録音は、W にしてよいアプリが2回続けて見えたら W に足す（found）。1回だけでは足さない。Chrome と Edge も W にする', T, () => {
  for (const id of ['teams', 'zoom', 'chrome', 'edge']) {
    const r = play({ apps: A }, [`${id}:7`, `${id}:7`]);
    assert.deepStrictEqual(r.acts, ['', 'found'], id);
    assert.deepStrictEqual([r.st.phase, r.st.w], ['in', [id]], id);
  }
  // 1回だけ見えたアプリは W に入れない（続けてでなければ数え直す）
  const once = play({ apps: A }, ['teams:1', '-', 'teams:1', '-', 'zoom:2']);
  assert.deepStrictEqual(once.acts, ['', '', '', '', '']);
  assert.strictEqual(once.st.phase, 'wait');
  // W ができた後に、ほかの W にしてよいアプリが W のアプリと一緒に2回見えたら W に足す（found は初めの1回だけ）
  const more = play({ apps: A }, ['teams:1', 'teams:1', 'teams:1,zoom:2', 'teams:1,zoom:2', 'zoom:2', 'zoom:2', 'zoom:2']);
  assert.deepStrictEqual(more.acts, ['', 'found', '', '', '', '', '']);
  assert.deepStrictEqual(more.st.w, ['teams', 'zoom']);
});

test('LV-1（LQ5・LQ7）: Firefox・Webex・Slack は W にしない（何回見えても wait）。一覧に無い id も数えない', T, () => {
  for (const id of ['firefox', 'webex', 'slack', 'notion']) {
    const r = play({ apps: A }, rep(`${id}:3`, 5));
    assert.deepStrictEqual(r.acts, rep('', 5), id);
    assert.strictEqual(r.st.phase, 'wait', id);
  }
  // W のある録音で、一覧に無い id の使いは「放した読み」に数える
  assert.strictEqual(play(PANEL, ['notion:1', 'notion:1', 'notion:1']).acts[2], 'stop');
});

test('LV-1（L3・L7）: 会議のアプリを一度も見ていない録音は、mic - が何回続いても wait のまま（止めない）', T, () => {
  const r = play({ apps: A }, rep('-', 20));
  assert.deepStrictEqual(r.acts, rep('', 20));
  assert.deepStrictEqual([r.st.phase, r.st.gone], ['wait', 0]);
});

test('LV-1（L9）: 設定がオフなら何もしない（off で始めた・録音中に切った）。入れ直したら次の読みから数える（W は覚えたまま）', T, () => {
  const off = play({ ...PANEL, off: true }, rep('-', 5));
  assert.deepStrictEqual(off.acts, rep('', 5));
  assert.strictEqual(off.st.gone, 0);
  const mid = play(PANEL, ['-', '-', { ev: { type: 'setting', on: false } }, ...rep('-', 5), { ev: { type: 'setting', on: true } }, '-', '-', '-']);
  assert.deepStrictEqual(mid.acts, ['', '', 'reset', '', '', '', '', '', '', '', '', 'stop']);
  assert.deepStrictEqual(mid.st.w, ['teams']);
  // gone が 0 のときの設定は '' で、on を覚える
  const z = play(PANEL, [{ ev: { type: 'setting', on: false } }]);
  assert.deepStrictEqual([z.acts[0], z.st.on], ['', false]);
});

test('LV-1（L7・F62）: lost で gone が 0 に戻る（gone が 1・2 なら reset）。次に読めた放した読みは1回目。gone が 0 の lost は ""', T, () => {
  const r = play(PANEL, ['-', '-', { ev: { type: 'lost' } }, '-', '-', '-']);
  assert.deepStrictEqual(r.acts, ['', '', 'reset', '', '', 'stop']);
  assert.strictEqual(r.outs[5].goneAt, T0 + 6000);
  assert.strictEqual(r.outs[2].st.gone, 0);
  assert.deepStrictEqual(play(PANEL, [{ ev: { type: 'lost' } }]).acts, ['']);
  const one = play(PANEL, ['-', { ev: { type: 'lost' } }]);
  assert.deepStrictEqual(one.acts, ['', 'reset']);
});

test('LV-1（L7・F62）: 形の悪い読み（items が配列でない・now が数でない・項目が物でない）は lost と同じ（放した読みに数えない）', T, () => {
  const bad = [{ type: 'sample', items: null }, { type: 'sample', items: 'mic -' }, { type: 'sample', items: [], now: 'x' }, { type: 'sample', items: [null] },
    { type: 'sample', items: [{ id: 'teams' }] }, { type: 'sample', items: [{ id: 3, start: '1' }] }, null, 'mic -', { type: 'nope' }];
  for (const b of bad) {
    const r = play(PANEL, ['-', '-', { dt: 2000, ev: b && typeof b === 'object' ? b : { type: 'sample', items: b } }, '-']);
    assert.deepStrictEqual(r.acts, ['', '', 'reset', ''], JSON.stringify(b));
    const z = play(PANEL, rep({ dt: 2000, ev: b && typeof b === 'object' ? b : { type: 'sample', items: b } }, 5));
    assert.ok(!z.acts.includes('stop'), JSON.stringify(b));
    assert.strictEqual(z.st.gone, 0, JSON.stringify(b));
  }
  // ev そのものが物でない
  assert.strictEqual(ML.leaveStep(ML.leaveInit(PANEL), null).act, '');
});

test('LV-1（L8）: 一時停止の間の放した読みは数えない（pause on で gone が 0 に戻る）。再開の後の放した読み3回で止める', T, () => {
  const r = play(PANEL, ['-', { ev: { type: 'pause', on: true } }, ...rep('-', 5), { ev: { type: 'pause', on: false } }, '-', '-', '-']);
  assert.deepStrictEqual(r.acts, ['', 'reset', '', '', '', '', '', '', '', '', 'stop']);
  assert.strictEqual(r.outs[10].goneAt, T0 + 14000);
  const z = play(PANEL, [{ ev: { type: 'pause', on: true } }, ...rep('-', 3)]);
  assert.deepStrictEqual(z.acts, ['', '', '', '']);
  assert.strictEqual(z.st.paused, true);
});

test('LV-1（L6・F62）: 放した読みの間が 10 001 ms なら reset（止めず、その読みが1回目）。そこから放した読みが3回続けば止める。10 000 ms ちょうどなら数え続ける', T, () => {
  // 1回目と2回目の間
  const a = play(PANEL, ['-', { dt: 10001, ev: { type: 'sample', items: [] } }, '-', '-']);
  assert.deepStrictEqual(a.acts, ['', 'reset', '', 'stop']);
  assert.strictEqual(a.outs[1].st.gone, 1);
  assert.strictEqual(a.outs[3].goneAt, T0 + 2000 + 10001);
  // 2回目と3回目の間
  const b = play(PANEL, ['-', '-', { dt: 10001, ev: { type: 'sample', items: [] } }, '-', '-']);
  assert.deepStrictEqual(b.acts, ['', '', 'reset', '', 'stop']);
  // ちょうど 10 000 ms
  const c = play(PANEL, ['-', { dt: 10000, ev: { type: 'sample', items: [] } }, { dt: 10000, ev: { type: 'sample', items: [] } }]);
  assert.deepStrictEqual(c.acts, ['', '', 'stop']);
  assert.strictEqual(c.outs[2].goneAt, T0 + 2000);
});

test('LV-1（L6）: 時計が戻った（now が前の読みより前）ら、その読みを1回目として数え直す', T, () => {
  const r = play(PANEL, ['-', '-', { dt: -60000, ev: { type: 'sample', items: [] } }, '-', '-']);
  assert.deepStrictEqual(r.acts, ['', '', 'reset', '', 'stop']);
  assert.strictEqual(r.outs[2].st.goneAt, T0 + 4000 - 60000);
});

test('LV-1: 受けた st を変えない（写してから変える）', T, () => {
  let st = deepFreeze(ML.leaveInit({ apps: A }));
  for (const ev of [{ type: 'sample', items: itemsOf('teams:1'), now: T0 }, { type: 'sample', items: itemsOf('teams:1'), now: T0 + 2000 }, { type: 'sample', items: [], now: T0 + 4000 },
    { type: 'lost', now: T0 + 5000 }, { type: 'pause', on: true, now: T0 + 6000 }, { type: 'setting', on: false, now: T0 + 7000 }]) {
    const o = ML.leaveStep(st, ev);
    assert.notStrictEqual(o.st, st);
    st = deepFreeze(o.st);
  }
});

test('LV-1（L18）: nudgeStep の forget で「録った会議」の印（done）とつなぎ直しの印を外すと、まだ使っていれば次の読みでパネルが出る（外さなければ出ない）', T, () => {
  const Z = [{ id: 'zoom', start: '5' }];
  const run = (forget) => {
    let st = lib.nudgeInit({ on: true, mute: [] });
    const step = (ev, now) => { const o = lib.nudgeStep(st, { ...ev, now }); st = o.st; return o; };
    step({ type: 'busy', busy: true, meeting: true }, 1);
    step({ type: 'sample', items: Z }, 2);
    step({ type: 'sample', items: Z }, 3);
    step({ type: 'busy', busy: false }, 4);
    if (forget) step({ type: 'forget', keys: ['zoom:5'] }, 5);
    return step({ type: 'sample', items: Z }, 6);
  };
  assert.strictEqual(run(false).show, null);
  assert.deepStrictEqual(run(true).show, { id: 'zoom', label: 'Zoom' });
  // つなぎ直しの印（rejoin）も外す・形の悪い keys は何もしない
  let st = lib.nudgeInit({ on: true, mute: [] });
  st = { ...st, done: ['zoom:5', 'teams:1'], rejoin: ['zoom:5'] };
  const o = lib.nudgeStep(st, { type: 'forget', keys: ['zoom:5', 3, null], now: 1 });
  assert.deepStrictEqual([o.st.done, o.st.rejoin, o.show], [['teams:1'], [], null]);
  assert.deepStrictEqual(lib.nudgeStep(st, { type: 'forget', keys: 'zoom:5', now: 1 }).st.done, ['zoom:5', 'teams:1']);
});

// ---------------------------------------------------------------- LV-2（決めたこと L14・L15）: 経過のきっかけと設定の鍵
test('LV-2（L14）: 経過の表にきっかけ leave「会議を出たので自動」。cleanStateLog が auto-stop/leave を通し、stateLogLine は「議事録: 終了（会議を出たので自動）」。2版目の app-left・app-back・detect は通さない', T, () => {
  const SL = require('../src/statelog');
  assert.strictEqual(SL.BY_NAMES.leave, '会議を出たので自動');
  const at = '2026-10-25T01:43:00.000Z';
  assert.deepStrictEqual(SL.cleanStateLog([{ s: 'auto-stop', by: 'leave', at }]), [{ s: 'auto-stop', by: 'leave', at }]);
  assert.strictEqual(SL.stateLogLine({ s: 'auto-stop', by: 'leave', at }), '議事録: 終了（会議を出たので自動）');
  assert.deepStrictEqual(SL.cleanStateLog([{ s: 'app-left', by: 'leave', at }, { s: 'app-back', by: 'leave', at }, { s: 'auto-stop', by: 'detect', at }]), []);
  assert.strictEqual(SL.stateLogAdd([], { s: 'auto-stop', by: 'leave', at }).length, 1);
});

test('LV-2（L15・LQ3）: 設定 autoStopLeave は既定 true（false でなければオン）。壊れた値は既定のオンに戻す', T, () => {
  const S = require('../src/settings');
  const D = S.defaultSettings(8);
  assert.strictEqual(D.autoStopLeave, true);
  assert.deepStrictEqual(S.SETTING_RULES.autoStopLeave, { label: '会議を出たら自動で止める', kind: 'bool', notFalse: true });
  assert.strictEqual(S.readSettings({ autoStopLeave: false }, D).settings.autoStopLeave, false);
  for (const raw of [true, null, 'x', 0, 1]) assert.strictEqual(S.readSettings({ autoStopLeave: raw }, D).settings.autoStopLeave, true, JSON.stringify(raw));
  assert.strictEqual(S.readSettings({}, D).settings.autoStopLeave, true);
  assert.deepStrictEqual(S.pickSavable({ autoStopLeave: false, evil: 1 }), { autoStopLeave: false });
});
