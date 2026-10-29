/*
 * stage093.lib.test.js — 0.9.3 Task M-1（計画 docs/plans/2026-10-22-093.md の決めたこと 1〜6・8・11・14 の純粋な部分）
 * 会議のアプリの一覧（MEET_APPS）・Windows のマイクの記録を読む見張りの PowerShell の文字列（micWatchScript）・見張りの行の読み方（parseMicLine）・
 * 出す／引っ込める／2度出さないの判断（nudgeStep）・パネルの置き場所（nudgeBounds）・音の大きさの照らし（levelMsg）・設定の kind apps。
 * 時刻は出来事の now だけを使う（Date.now() を読まない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const lib = require('../src/mainlib');
const S = require('../src/settings');

const T = { timeout: 5000 };
const IDS = ['teams', 'zoom', 'webex', 'slack', 'chrome', 'edge', 'firefox'];
const SELF = 'C:\\Users\\Example\\AppData\\Local\\Programs\\NaTsu\\NaTsu.exe';

test('M-1: MEET_APPS は決まった7つ（一覧の順）で凍っている。どれも label・exe（小文字の .exe）・pkg・proc（.exe を外した形）を持つ', T, () => {
  assert.deepStrictEqual(lib.MEET_APPS.map((a) => a.id), IDS);
  assert.ok(Object.isFrozen(lib.MEET_APPS) && lib.MEET_APPS.every((a) => Object.isFrozen(a) && Object.isFrozen(a.exe) && Object.isFrozen(a.pkg) && Object.isFrozen(a.proc)));
  for (const a of lib.MEET_APPS) {
    assert.ok(typeof a.label === 'string' && a.label.length > 0, a.id);
    for (const e of a.exe) assert.match(e, /^[a-z0-9._-]+\.exe$/, a.id);
    for (const p of a.proc) assert.match(p, /^[a-z0-9._-]+$/, a.id);
    assert.ok(a.exe.length + a.pkg.length > 0 && a.proc.length > 0, a.id);
  }
  assert.deepStrictEqual(lib.MEET_APPS.map((a) => a.label), ['Teams', 'Zoom', 'Webex', 'Slack', 'Chrome（ブラウザ）', 'Edge（ブラウザ）', 'Firefox（ブラウザ）']);
  // 設定の kind apps が受ける id は同じ並び（settings.js は mainlib を読まないので写しを持つ）
  assert.deepStrictEqual([...S.MEET_APP_IDS], IDS);
  assert.strictEqual(lib.MIC_ROOT, 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone');
});

test('持ち主の実機の記録: 一覧は新しい Teams のパッケージ MSTeams_8wekyb3d8bbwe と zoom.exe を持ち、Notion と NaTsu を持たない。mic notion:… と mic natsu:… は空になり、nudgeStep は何も出さない（Notion だけ・NaTsu だけがマイクを使っている）', T, () => {
  const teams = lib.MEET_APPS.find((a) => a.id === 'teams');
  assert.ok(teams.pkg.includes('MSTeams_8wekyb3d8bbwe') && teams.exe.includes('ms-teams.exe'));
  assert.ok(lib.MEET_APPS.find((a) => a.id === 'zoom').exe.includes('zoom.exe'));
  const all = JSON.stringify(lib.MEET_APPS).toLowerCase();
  for (const w of ['notion', 'natsu', 'electron']) assert.ok(!all.includes(w), `一覧に ${w} がある`);
  const script = lib.micWatchScript({ self: SELF, parent: 1234 }).toLowerCase();
  assert.ok(!script.includes('notion.exe'), '見張りが Notion を拾う');
  for (const line of ['mic notion:133700000000000000', 'mic natsu:133700000000000000', 'mic notion:133700000000000000,natsu:133700000000000001']) {
    const r = lib.parseMicLine(line);
    assert.deepStrictEqual(r, { kind: 'mic', items: [] }, line);
    let st = lib.nudgeInit({ on: true, mute: [] });
    for (let i = 0; i < 5; i++) {
      const o = lib.nudgeStep(st, { type: 'sample', items: r.items, now: 2000 * i });
      assert.strictEqual(o.show, null, line);
      st = o.st;
    }
  }
});

test('M1・M5: micWatchScript は一覧の exe と pkg と proc だけを持ち、self をパスの比べに使い、行は mic と err の2つの形だけを書く', T, () => {
  const s = lib.micWatchScript({ self: SELF, parent: 4321, everyMs: 2000 });
  for (const w of ['[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(', 'GetProcessesByName(', 'Start-Sleep -Milliseconds 2000', 'LastUsedTimeStart', 'LastUsedTimeStop',
    'RegistryValueKind]::QWord', "'NonPackaged'", "Say ('mic ' + ($items -join ','))", "Say 'mic -'", "Say 'err read'", "Say 'err proc'", 'GetProcessById(4321)']) {
    assert.ok(s.includes(w), w);
  }
  for (const w of ['reg.exe', 'Get-WmiObject', 'MainWindowTitle', 'Invoke-WebRequest', 'Invoke-RestMethod', 'Net.WebClient', 'Out-File', 'Set-Content', 'Add-Content']) {
    assert.ok(!s.toLowerCase().includes(w.toLowerCase()), `${w} の字面がある`);
  }
  // 「今使っている」は Stop が 0 で Start が 0 でない（どちらも QWORD）。古い値はプロセスがあるかで除く（変異確認は Linux で回るので、
  // micwatch.win（Windows の CI だけ）のほかに字面でも見る）
  assert.ok(s.includes('if ($b -eq 0 -and $a -ne 0) { return $a }'), '「今使っている」の判定が Stop == 0 かつ Start != 0 でない');
  assert.ok(s.includes('foreach ($p in $procMap[$id]) { if ([System.Diagnostics.Process]::GetProcessesByName($p).Length -gt 0) { $alive = $true; break } }')
    && s.includes("if ($alive) { $items += ($id + ':' + $found[$id]) }"), 'プロセスが無い古い値を除いていない');
  assert.ok(s.includes('if (-not $exeMap.ContainsKey($leaf)) { continue }') && s.includes('if (-not $pkgMap.ContainsKey($low)) { continue }'), '一覧に無いものを除いていない');
  // 自分（NaTsu の実行ファイル）は # の形のキーの名前を小文字で比べて除く（M1）
  assert.ok(s.includes('if ($low -eq $self) { continue }'), '自分のパスを除いていない');
  assert.ok(s.includes("'c:#users#example#appdata#local#programs#natsu#natsu.exe'"), '自分のパスの比べが無い');
  for (const a of lib.MEET_APPS) {
    for (const e of a.exe) assert.ok(s.includes(`'${e}' = '${a.id}'`), e);
    for (const p of a.pkg) assert.ok(s.includes(`'${p.toLowerCase()}' = '${a.id}'`), p);
    assert.ok(s.includes(`'${a.id}' = @(${a.proc.map((p) => `'${p}'`).join(', ')})`), a.id);
  }
  // 書くのは Say を通した mic と err の行と、（timing のときだけ）t の行。ほかの Write-Host・Write-Output は無い
  // 0.9.4 D-1 で意図して直した: Say は読むたびに書く（前は変わったときだけ書いたので、判断の「2回読んだら出す」に2回目が来ずパネルが出なかった）
  const writes = [...s.matchAll(/WriteLine\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(writes, ['$t']);
  const says = [...s.matchAll(/\bSay (\(?'[^']*')/g)].map((m) => m[1]);
  assert.deepStrictEqual(says.sort(), ["'err proc'", "'err read'", "'mic -'", "('mic '"].sort());
  assert.ok(s.includes('function Say($t) { [Console]::Out.WriteLine($t); [Console]::Out.Flush() }'), '読むたびに書く形でない');
  assert.ok(!/Write-(Host|Output)/.test(s));
  assert.ok(!s.includes("WriteLine('t '"), 'timing でないのに時間の行を書く');
  assert.ok(lib.micWatchScript({ self: SELF, parent: 1, timing: true }).includes("WriteLine('t '"));
  // root と self の ' は2つ重ねる（PowerShell の文字列を抜けない）
  const q = lib.micWatchScript({ self: "C:\\a'b\\x.exe", root: "Software\\N'aTsuTest\\microphone", parent: 1 });
  assert.ok(q.includes("'c:#a''b#x.exe'") && q.includes("'Software\\N''aTsuTest\\microphone'"));
  // 既定の間は 2000ms、root は MIC_ROOT
  const d = lib.micWatchScript({ self: SELF, parent: 1 });
  assert.ok(d.includes('Start-Sleep -Milliseconds 2000') && d.includes(`'${lib.MIC_ROOT}'`));
});

test('M5: parseMicLine の表', T, () => {
  const S1 = '133713371337133713', S2 = '133713371337133714';
  const rows = [
    [`mic zoom:${S1},teams:${S2}`, { kind: 'mic', items: [{ id: 'zoom', start: S1 }, { id: 'teams', start: S2 }] }],
    [`mic zoom:${S1}\r`, { kind: 'mic', items: [{ id: 'zoom', start: S1 }] }],
    ['mic -', { kind: 'mic', items: [] }],
    [`mic notepad:${S1},zoom:${S1}`, { kind: 'mic', items: [{ id: 'zoom', start: S1 }] }],
    ['mic zoom:abc,teams:-5,slack:0,edge:1.5', { kind: 'mic', items: [] }],
    [`mic __proto__:${S1},constructor:${S1}`, { kind: 'mic', items: [] }],
    ['err read', { kind: 'err', code: 'read' }],
    ['err proc', { kind: 'err', code: 'proc' }],
    ['err C:\\Users\\x', null],
    ['mic C:#Users#x#Zoom.exe:1', { kind: 'mic', items: [] }],
    ['t 3', null],
    ['', null],
    ['hello', null],
    [`mic ${'zoom:1,'.repeat(700)}`, null],
    [null, null],
    [undefined, null],
    [42, null],
  ];
  for (const [line, want] of rows) assert.deepStrictEqual(lib.parseMicLine(line), want, JSON.stringify(line));
});

// 見張りの1行（2 秒ごと）を順に渡す。now は 2 秒ずつ進む
function drive(steps, init = {}) {
  let st = lib.nudgeInit({ on: true, mute: [], ...init });
  const out = [];
  for (const ev of steps) {
    const o = lib.nudgeStep(st, ev);
    st = o.st;
    out.push({ show: o.show ? o.show.id : null, hide: o.hide });
  }
  return { out, st };
}
const sample = (now, ...items) => ({ type: 'sample', now, items: items.map(([id, start]) => ({ id, start })) });
const shows = (r) => r.out.map((o) => o.show).filter(Boolean);

test('M2・M3: nudgeStep の表', T, () => {
  const z1 = ['zoom', '100'], z2 = ['zoom', '200'], t1 = ['teams', '300'];
  // 1回だけ見えた → 出さない／2回続けて → 出す
  assert.deepStrictEqual(shows(drive([sample(0, z1), sample(2000)])), []);
  let r = drive([sample(0, z1), sample(2000, z1)]);
  assert.deepStrictEqual(r.out.map((o) => o.show), [null, 'zoom']);
  assert.strictEqual(lib.nudgeStep(lib.nudgeInit({ on: true }), sample(0, z1)).show, null);
  // show の形は { id, label }
  const st1 = lib.nudgeStep(lib.nudgeInit({ on: true }), sample(0, z1)).st;
  assert.deepStrictEqual(lib.nudgeStep(st1, sample(2000, z1)).show, { id: 'zoom', label: 'Zoom' });
  // 同じ (id, start) → 2度目は出さない（閉じた後・引っ込めた後も）
  r = drive([sample(0, z1), sample(2000, z1), { type: 'closed', now: 3000 }, sample(4000, z1), sample(6000, z1), sample(8000, z1)]);
  assert.deepStrictEqual(shows(r), ['zoom']);
  assert.deepStrictEqual(r.out[2], { show: null, hide: true });
  // マイクを離した → 引っ込める
  r = drive([sample(0, z1), sample(2000, z1), sample(4000)]);
  assert.deepStrictEqual(r.out[2], { show: null, hide: true });
  // 60 秒以内に同じアプリが新しい start → 出さない（つなぎ直し・機器の切り替え）。続けて使っていても出さない
  r = drive([sample(0, z1), sample(2000, z1), sample(4000), sample(30000, z2), sample(32000, z2), sample(90000, z2)]);
  assert.deepStrictEqual(shows(r), ['zoom']);
  // 使いが続いたまま start が替わった（機器の切り替え）→ 出さない
  r = drive([sample(0, z1), sample(2000, z1), sample(4000, z2), sample(6000, z2)]);
  assert.deepStrictEqual(shows(r), ['zoom']);
  // 60 秒より後 → 出す
  r = drive([sample(0, z1), sample(2000, z1), sample(4000), sample(64001, z2), sample(66001, z2)]);
  assert.deepStrictEqual(shows(r), ['zoom', 'zoom']);
  // 録音中（議事録）に始まった → 出さない。idle に戻ってもその使いは出さない（議事録で録っていた会議）
  r = drive([{ type: 'busy', busy: true, meeting: true, now: 0 }, sample(1000, z1), sample(3000, z1), { type: 'busy', busy: false, now: 4000 }, sample(5000, z1), sample(7000, z1)]);
  assert.deepStrictEqual(shows(r), []);
  // 音声入力の間に始まった → 出さない。idle に戻ってまだ使っていれば1回だけ出す
  r = drive([{ type: 'busy', busy: true, now: 0 }, sample(1000, z1), sample(3000, z1), { type: 'busy', busy: false, now: 4000 }, sample(5000, z1), sample(7000, z1)]);
  assert.deepStrictEqual(r.out.map((o) => o.show), [null, null, null, 'zoom', null, null]);
  // もう離していれば出さない
  r = drive([{ type: 'busy', busy: true, now: 0 }, sample(1000, z1), sample(3000, z1), sample(3500), { type: 'busy', busy: false, now: 4000 }, sample(5000)]);
  assert.deepStrictEqual(shows(r), []);
  // 設定オフ・出さないアプリ → 出さない（出していれば引っ込める）
  assert.deepStrictEqual(shows(drive([sample(0, z1), sample(2000, z1)], { on: false })), []);
  assert.deepStrictEqual(shows(drive([sample(0, z1), sample(2000, z1)], { mute: ['zoom'] })), []);
  assert.deepStrictEqual(shows(drive([sample(0, z1, t1), sample(2000, z1, t1)], { mute: ['zoom'] })), ['teams']);
  r = drive([sample(0, z1), sample(2000, z1), { type: 'setting', on: false, mute: [], now: 3000 }]);
  assert.deepStrictEqual(r.out[2], { show: null, hide: true });
  r = drive([sample(0, z1), sample(2000, z1), { type: 'setting', on: true, mute: ['zoom'], now: 3000 }]);
  assert.deepStrictEqual(r.out[2], { show: null, hide: true });
  // 2つ同時 → 一覧の順の先（teams は zoom より前）
  assert.deepStrictEqual(shows(drive([sample(0, z1, t1), sample(2000, z1, t1)])), ['teams']);
  // 出ている間に別のアプリ → 今のを出したまま（1つだけ）
  r = drive([sample(0, z1), sample(2000, z1), sample(4000, z1, t1), sample(6000, z1, t1)]);
  assert.deepStrictEqual(shows(r), ['zoom']);
  assert.ok(r.out.every((o) => !o.hide));
  // 30 秒で引っ込める
  r = drive([sample(0, z1), sample(2000, z1), { type: 'tick', now: 31999 }, { type: 'tick', now: 32000 }]);
  assert.deepStrictEqual(r.out.slice(2), [{ show: null, hide: false }, { show: null, hide: true }]);
  assert.strictEqual(lib.NUDGE_SHOW_MS, 30000);
  assert.strictEqual(lib.NUDGE_HOVER_GRACE_MS, 5000);
  assert.strictEqual(lib.NUDGE_REJOIN_MS, 60000);
  // カーソルが乗っている間は引っ込めない・離れて 5 秒で引っ込める（30 秒より前に離れたら 30 秒で）
  r = drive([sample(0, z1), sample(2000, z1), { type: 'hover', on: true, now: 10000 }, { type: 'tick', now: 60000 }, { type: 'hover', on: false, now: 70000 },
    { type: 'tick', now: 74999 }, { type: 'tick', now: 75000 }]);
  assert.deepStrictEqual(r.out.slice(3), [{ show: null, hide: false }, { show: null, hide: false }, { show: null, hide: false }, { show: null, hide: true }]);
  r = drive([sample(0, z1), sample(2000, z1), { type: 'hover', on: true, now: 3000 }, { type: 'hover', on: false, now: 4000 }, { type: 'tick', now: 31999 }, { type: 'tick', now: 32000 }]);
  assert.deepStrictEqual(r.out.slice(4), [{ show: null, hide: false }, { show: null, hide: true }]);
  // どの道でも録音が始まった → 引っ込める
  r = drive([sample(0, z1), sample(2000, z1), { type: 'busy', busy: true, meeting: true, now: 3000 }]);
  assert.deepStrictEqual(r.out[2], { show: null, hide: true });
  // 引っ込めた後に同じ使いが続いても出さない
  r = drive([sample(0, z1), sample(2000, z1), { type: 'tick', now: 32000 }, sample(34000, z1), sample(36000, z1)]);
  assert.deepStrictEqual(shows(r), ['zoom']);
  // 出ていないときの閉じる・カーソル・時計は何もしない
  for (const ev of [{ type: 'closed', now: 1 }, { type: 'hover', on: true, now: 1 }, { type: 'tick', now: 99999 }, { type: '???', now: 1 }, null]) {
    const o = lib.nudgeStep(lib.nudgeInit({ on: true }), ev);
    assert.deepStrictEqual([o.show, o.hide], [null, false], JSON.stringify(ev));
  }
  // 入れた st は書き換えない（純粋）
  const st0 = lib.nudgeInit({ on: true });
  const snap = JSON.stringify(st0);
  lib.nudgeStep(st0, sample(0, z1));
  assert.strictEqual(JSON.stringify(st0), snap);
});

// 0.13.2 LN-7（持ち主の答え「下の中央、録音バーと同じ高さ」。計画 docs/plans/2026-10-28-132.md の「意図して変えるテスト」）で意図して変えた: 右上でなく
// 作業領域の下の中央（カードの下の端が 12px・左右の真ん中は Math.round で整数）。同じ組（左の画面・上の画面・タスクバーが上・大きすぎる・大きさが無い）で書き直した
test('nudgeBounds の表', T, () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  const P = lib.NUDGE_PAD, E = lib.NUDGE_EDGE;
  assert.strictEqual(E, 12);
  // 下の中央。カードの下の端が作業領域の下の端から 12px（窓はカードの周りに NUDGE_PAD の余白を持つ）
  const b = lib.nudgeBounds({ size: { w: 520.4, h: 60 }, workArea: wa });
  assert.deepStrictEqual(b, { x: Math.round((1920 - (521 + 2 * P)) / 2), y: 1040 - (E - P) - (60 + 2 * P), width: 521 + 2 * P, height: 60 + 2 * P });
  assert.strictEqual(b.y + P + 60, 1040 - 12);
  // 左にある画面（x が負）
  const L = { x: -1280, y: 0, width: 1280, height: 984 };
  assert.deepStrictEqual(lib.nudgeBounds({ size: { w: 400, h: 60 }, workArea: L }), { x: -1280 + (1280 - (400 + 2 * P)) / 2, y: 984 - (E - P) - (60 + 2 * P), width: 400 + 2 * P, height: 60 + 2 * P });
  // 上にある画面（y が負）・作業領域が上にずれている（タスクバーが上）
  assert.strictEqual(lib.nudgeBounds({ size: { w: 400, h: 60 }, workArea: { x: 0, y: -1080, width: 1920, height: 1040 } }).y, -1080 + 1040 - (E - P) - (60 + 2 * P));
  assert.strictEqual(lib.nudgeBounds({ size: { w: 400, h: 60 }, workArea: { x: 0, y: 48, width: 1920, height: 1032 } }).y, 48 + 1032 - (E - P) - (60 + 2 * P));
  // 大きすぎる大きさは作業領域 − 2 × (12 − 余白) で切る
  const small = { x: 0, y: 0, width: 300, height: 100 };
  const c = lib.nudgeBounds({ size: { w: 5000, h: 5000 }, workArea: small });
  assert.deepStrictEqual(c, { x: E - P, y: E - P, width: 300 - 2 * (E - P), height: 100 - 2 * (E - P) });
  // 大きさが無い・壊れている → 決まった初めの大きさ
  for (const size of [null, undefined, {}, { w: 0, h: 10 }, { w: NaN, h: 1 }, { w: -1, h: 5 }, { w: '400', h: '60' }]) {
    assert.deepStrictEqual(lib.nudgeBounds({ size, workArea: wa }), lib.nudgeBounds({ size: lib.NUDGE_FIRST, workArea: wa }), JSON.stringify(size));
  }
});

test('M8: levelMsg の表', T, () => {
  const rows = [
    [{ mic: 0.5, sys: 0.25, warn: '' }, { mic: 0.5, sys: 0.25, warn: '' }],
    [{ mic: 0.123456, sys: 0.987654, warn: '音が入っていません' }, { mic: 0.12, sys: 0.99, warn: '音が入っていません' }],
    [{ mic: 0, sys: 0, warn: 'マイクの音が入っていません' }, { mic: 0, sys: 0, warn: 'マイクの音が入っていません' }],
    [{ mic: 3, sys: -1, warn: '<b>好きな文</b>' }, { mic: 1, sys: 0, warn: '' }],
    [{ mic: NaN, sys: Infinity, warn: 7 }, { mic: 0, sys: 0, warn: '' }],
    [{ mic: '0.5', sys: null, warn: null }, { mic: 0, sys: 0, warn: '' }],
    [{}, { mic: 0, sys: 0, warn: '' }],
    [null, { mic: 0, sys: 0, warn: '' }],
    ['abc', { mic: 0, sys: 0, warn: '' }],
    [[0.5, 0.5], { mic: 0, sys: 0, warn: '' }],
  ];
  for (const [p, want] of rows) assert.deepStrictEqual(lib.levelMsg(p), want, JSON.stringify(p));
  assert.deepStrictEqual(Object.keys(lib.levelMsg({ mic: 1, sys: 1, warn: '', extra: 'x' })), ['mic', 'sys', 'warn']);
  assert.strictEqual(lib.LEVEL_ASK_MS, 100);
});

test('kind apps の直し方（meetingDetectMute）と meetingDetect（既定オン）', T, () => {
  const D = S.defaultSettings(8);
  assert.strictEqual(D.meetingDetect, true);
  assert.deepStrictEqual(D.meetingDetectMute, []);
  assert.deepStrictEqual(S.SETTING_RULES.meetingDetect, { label: '会議の検出の通知', kind: 'bool', notFalse: true });
  assert.deepStrictEqual(S.SETTING_RULES.meetingDetectMute, { label: '通知を出さないアプリ', kind: 'apps' });
  const read = (v) => S.readSettings({ meetingDetectMute: v }, D);
  const rows = [
    [['zoom', 'teams'], ['zoom', 'teams'], []],
    [['zoom', 'notepad', 'zoom', 3, null, 'TEAMS', 'chrome'], ['zoom', 'chrome'], [{ key: 'meetingDetectMute', why: 'type' }]],
    ['zoom', [], [{ key: 'meetingDetectMute', why: 'type' }]],
    [{ zoom: true }, [], [{ key: 'meetingDetectMute', why: 'type' }]],
    [null, [], [{ key: 'meetingDetectMute', why: 'type' }]],
    [['__proto__', 'constructor'], [], [{ key: 'meetingDetectMute', why: 'type' }]],
    [[], [], []],
  ];
  for (const [v, want, rep] of rows) {
    const r = read(v);
    assert.deepStrictEqual(r.settings.meetingDetectMute, want, JSON.stringify(v));
    assert.deepStrictEqual(r.repaired, rep, JSON.stringify(v));
  }
  assert.strictEqual(S.readSettings({ meetingDetect: false }, D).settings.meetingDetect, false);
  assert.strictEqual(S.readSettings({ meetingDetect: 'yes' }, D).settings.meetingDetect, true);
  // 既定の配列を書き換えても既定に響かない
  const r = S.readSettings({}, D);
  r.settings.meetingDetectMute.push('zoom');
  assert.deepStrictEqual(S.defaultSettings(8).meetingDetectMute, []);
  assert.deepStrictEqual(D.meetingDetectMute, []);
  // 保存の許可の一覧に入る
  assert.deepStrictEqual(S.pickSavable({ meetingDetect: false, meetingDetectMute: ['zoom'] }), { meetingDetect: false, meetingDetectMute: ['zoom'] });
});
