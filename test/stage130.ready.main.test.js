/*
 * stage130.ready.main.test.js — 0.13.0 第2部「録音の前のページ」の main の場面（計画 docs/plans/2026-10-24-130.md の Task RDY-1・RDY-4）
 * ［＋ 新しい議事録］はページを開くだけ（main の録音の前の状態 prep。メモリだけで、下書きにも DB にも書かない）、［文字起こしを始める］は
 * 始めるだけの口 meeting:start で始める。メモと種類はどの始め方でも引き継ぎ、経過の頭に「ページを開いた」。
 * 場面は helpers/mainrun.js を別のプロセスで回す（--mic-feed。見張りは偽の子で、場面が行を書く）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');
const sl = require('../src/statelog.js');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const S = { timeout: sceneTimeout(30000) };
const run = (steps, ...flags) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, 'text', `--mic-feed=${JSON.stringify(steps)}`, ...flags], { env: { ...process.env }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const L = (s) => [['line', s], ['clock', 2000]];
const Ls = (s, n) => Array.from({ length: n }, () => L(s)).flat();
const PANEL = (id) => [...L(`mic ${id}:1`), ...L(`mic ${id}:1`), ['wait-show', 1], ['ipc', 'nudge:start', {}]];
const ipcOf = (o, ch) => o.ipc.filter(([c]) => c === ch).map(([, r]) => r);
const count = (o, line) => o.engineLog.filter((l) => l === line).length;
const OPENED = '会議: 録音の前のページを開いた';
const CLOSED = '会議: 録音の前のページを閉じた';
const FROM_PAGE = '会議: 録音の前のページで始めた';
const MEMO = '録音の前に書いた議題メモ（予算と採用）';
const firstUpdate = (o) => (o.mainSentAll.find(([ch, p]) => ch === 'meeting:update' && p && p.active) || [])[1];
const states = (o) => ((o.pageStateLogs[0] || {}).stateLog || []).map((x) => `${x.s}/${x.by}`);
const SALES_PRESET = require('../src/memoTypes.js').memoPreset(require('../src/memoTypes.js').memoTypeOf('sales'));

// ---------------------------------------------------------------- 純粋（RD4・RT12）
test('RDY-1（RD4・RT12）: 経過の表に prep「ページを開いた」。cleanStateLog が { s: prep, by: button } を通し、stateLogLine は RT12', () => {
  const at = '2026-10-26T01:00:00.000Z';
  assert.deepStrictEqual(sl.cleanStateLog([{ s: 'prep', by: 'button', at }]), [{ s: 'prep', by: 'button', at }]);
  assert.strictEqual(sl.stateLogLine({ s: 'prep', by: 'button', at }), '議事録: ページを開いた（画面のボタン）');
  assert.strictEqual(sl.STATE_NAMES.prep, 'ページを開いた');
});

// ---------------------------------------------------------------- RDY-1（RD1・RD3・RD7・RD19。F83・F84）
test('RDY-1（RD3・F84）: 録音の前のページは何も書かない（下書き・DB の命令・録音バー・state は idle）。2回目の prepare でもメモはそのまま、unprepare で null。記録にメモの文を書かない', S, async () => {
  const o = await run([['snap', 'boot'], ['ipc', 'meeting:prepare'], ['ipc', 'meeting:set-memo', MEMO], ['ipc', 'meeting:set-type', 'sales'], ['snap', 'p'],
    ['ipc', 'meeting:prepare'], ['snap', 'p2'], ['ipc', 'meeting:unprepare'], ['snap', 'u']]);
  assert.deepStrictEqual(ipcOf(o, 'meeting:prepare'), [{ ok: true }, { ok: true }]);
  assert.deepStrictEqual(o.snaps.p.status, { active: false, prep: { memo: MEMO, meetingType: 'sales' } });
  assert.deepStrictEqual(o.snaps.p2.status.prep, { memo: MEMO, meetingType: 'sales' }, '2回目の prepare でメモが消えた');
  assert.strictEqual(o.snaps.u.status.prep, null);
  for (const k of ['p', 'p2', 'u']) {
    assert.deepStrictEqual(o.snaps[k].drafts, [], `${k}: 下書きを書いた`);
    // DB の状態の問い合わせ（db.status）のほかは送らない（録音中の写し meeting.begin もページも作らない）
    assert.deepStrictEqual(o.snaps[k].dbSent.slice(o.snaps.boot.dbSent.length).filter((c) => c !== 'db.status'), [], `${k}: DB に送った`);
    assert.strictEqual(o.snaps[k].active, false);
  }
  assert.ok(!o.mainSentAll.some(([ch]) => /^overlay:/.test(ch)));
  assert.strictEqual(count(o, OPENED), 1, o.engineLog.join('\n'));
  assert.strictEqual(count(o, CLOSED), 1, o.engineLog.join('\n'));
  assert.ok(!o.engineLog.some((l) => l.includes('予算') || l.includes('議題')), o.engineLog.join('\n'));
  assert.strictEqual(o.pageMemos.length, 0, '一覧にページができた');
  // 本体の窓へ状態を送る（画面がタブを描き直す）
  assert.ok(o.mainSentAll.some(([ch, p]) => ch === 'meeting:update' && p && p.prep && p.prep.memo === MEMO));
});

test('RDY-1（RD7）: 録音の前のページで種類を選ぶと 0.11.0 と同じ決まりで雛形を入れ（手を付けていないときだけ）、経過には積まない。自動に戻せる', S, async () => {
  const o = await run([['ipc', 'meeting:prepare'], ['ipc', 'meeting:set-type', 'sales'], ['snap', 'a'], ['ipc', 'meeting:set-memo', MEMO], ['ipc', 'meeting:set-type', 'auto'], ['snap', 'b'],
    ['ipc', 'meeting:set-type', 'standup'], ['snap', 'c'], ['ipc', 'meeting:set-type', 'nope']]);
  const r = ipcOf(o, 'meeting:set-type');
  assert.deepStrictEqual(r[0], { ok: true, memo: SALES_PRESET, inserted: true, meetingType: 'sales' });
  assert.deepStrictEqual(o.snaps.a.status.prep, { memo: SALES_PRESET, meetingType: 'sales' });
  assert.deepStrictEqual(r[1], { ok: true, memo: MEMO, inserted: false, meetingType: null });
  assert.deepStrictEqual(r[2], { ok: true, memo: MEMO, inserted: false, meetingType: 'standup' }, '人の文のメモを雛形に替えた');
  assert.deepStrictEqual(r[3], { ok: false });
  assert.ok(!o.engineLog.some((l) => l.startsWith('議事録: 種類を選んだ')), '録音の前に経過を積んだ');
  // 録音の前のページが無ければ今どおり何もしない
  const none = await run([['ipc', 'meeting:set-type', 'sales'], ['ipc', 'meeting:set-memo', MEMO], ['snap', 'n']]);
  assert.deepStrictEqual(ipcOf(none, 'meeting:set-type'), [{ ok: false }]);
  assert.strictEqual(none.snaps.n.status.prep, null);
});

// ---------------------------------------------------------------- RDY-1（RD2・RD18。F81・F91）
test('RDY-1（RD2・F81）: 始めるだけの口 meeting:start。続けて2回 → 2回目は断る（止めない）。録音中の meeting:start も止めない', S, async () => {
  const o = await run([['ipc', 'meeting:prepare'], ['ipc', 'meeting:start'], ['ipc', 'meeting:start'], ['snap', 's'], ['ipc', 'meeting:start'], ['snap', 's2']]);
  const r = ipcOf(o, 'meeting:start');
  assert.deepStrictEqual(r[0], { ok: true, localOnly: false });
  assert.strictEqual(r[1].ok, false);
  assert.strictEqual(r[2].ok, false);
  assert.strictEqual(o.snaps.s.active, true);
  assert.strictEqual(o.snaps.s2.active, true, '録音中の meeting:start で止まった');
  assert.ok(!o.engineLog.some((l) => l.startsWith('会議: 止めた')), o.engineLog.join('\n'));
  assert.strictEqual(o.engineLog.filter((l) => l === '議事録: 開始（画面のボタン）').length, 1);
  assert.strictEqual(o.snaps.s2.dbSent.filter((c) => c === 'meeting.begin').length, 1);
});

test('RDY-1（RD18・F91）: 音声入力の録音中の meeting:start は「他の処理を実行中です」で断り、録音の前のページは残る', S, async () => {
  const o = await run([['ipc', 'meeting:prepare'], ['ipc', 'meeting:set-memo', MEMO], ['dictate'], ['ipc', 'meeting:start'], ['snap', 'd']]);
  assert.deepStrictEqual(ipcOf(o, 'meeting:start'), [{ ok: false, error: '他の処理を実行中です' }]);
  assert.deepStrictEqual(o.snaps.d.status.prep, { memo: MEMO, meetingType: null });
  assert.strictEqual(o.snaps.d.active, false);
});

// ---------------------------------------------------------------- RDY-1（RD4・RD8・RD17。F85）
for (const [name, startStep] of [['meeting:start', [['ipc', 'meeting:start']]], ['hotkey-meeting', [['hotkey-meeting']]], ['tray-start', [['tray-start']]], ['nudge:start', [...L('mic teams:1'), ...L('mic teams:1'), ['wait-show', 1], ['ipc', 'nudge:start', {}]]]]) {
  test(`RDY-1（RD8・F85）: ${name} で始めても、録音の前のメモと種類が最初の下書きと最初の meeting:update に入り、prep は null。経過は prep → start → type。次の prepare のメモは空`, S, async () => {
    const o = await run([['ipc', 'meeting:prepare'], ['ipc', 'meeting:set-type', 'sales'], ['ipc', 'meeting:set-memo', MEMO], ['sleep', 150], ...startStep, ['snap', 'm'],
      ['stop'], ['ipc', 'meeting:prepare'], ['snap', 'n']]);
    assert.strictEqual(o.snaps.m.active, true, o.engineLog.join('\n'));
    assert.deepStrictEqual(o.snaps.m.draft, { memo: MEMO, meetingType: 'sales' });
    const u = firstUpdate(o);
    assert.deepStrictEqual([u.memo, u.meetingType], [MEMO, 'sales'], '最初の meeting:update に録音の前のメモが無い');
    assert.strictEqual(o.snaps.m.status.prep, null);
    assert.deepStrictEqual(o.snaps.n.status.prep, { memo: '', meetingType: null }, '次の録音の前のページに前のメモが残った');
    assert.deepStrictEqual(o.pageMemos.map((p) => [p.memo, p.meetingType]), [[MEMO, 'sales']]);
    const sl0 = (o.pageStateLogs[0] || {}).stateLog || [];
    const kinds = sl0.map((x) => x.s);
    assert.deepStrictEqual(kinds.slice(0, 3), ['prep', 'start', 'type'], JSON.stringify(sl0));
    assert.strictEqual(sl0[0].by, 'button');
    assert.strictEqual(sl0[2].by, 'live-page');
    // 経過の「ページを開いた」は開いた時刻（始めた時刻ではない。場面は開いてから 150ms 待って始める）
    assert.ok(Date.parse(sl0[1].at) - Date.parse(sl0[0].at) >= 120, JSON.stringify(sl0));
    assert.strictEqual(count(o, FROM_PAGE), 1, o.engineLog.join('\n'));
    assert.strictEqual(count(o, '議事録: ページを開いた（画面のボタン）'), 1);
    assert.ok(!o.engineLog.some((l) => l.includes('予算')), o.engineLog.join('\n'));
  });
}

// ---------------------------------------------------------------- RDY-1（RD11。F88）
test('RDY-1（RD11・F88）: meeting:start の { pcOnly: true } はオフラインモードで始める（記録 page-offline・経過は「開始（画面のボタン）」）。pcOnly のほかの値は読まない', S, async () => {
  // ログインしてクラウドで文字起こしする PC（--relay=text）。オフラインモードで始めると「OpenAI に送られます」の知らせは出ない（経路の確かめより前に印を付ける）
  const o = await run([['ipc', 'meeting:prepare'], ['ipc', 'meeting:start', { pcOnly: true }], ['sleep', 800], ['snap', 's']], '--relay=text');
  assert.deepStrictEqual(ipcOf(o, 'meeting:start'), [{ ok: true, localOnly: true }]);
  assert.strictEqual(o.status.localOnly, true);
  assert.ok(o.engineLog.includes('会議: 始めた（page-offline）'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('議事録: 開始（画面のボタン）'), o.engineLog.join('\n'));
  assert.ok(!o.notices.some((n) => /OpenAI/.test(typeof n === 'string' ? n : JSON.stringify(n))), JSON.stringify(o.notices));
  const y = await run([['ipc', 'meeting:prepare'], ['ipc', 'meeting:start', { pcOnly: 'yes' }], ['sleep', 800]], '--relay=text');
  assert.deepStrictEqual(ipcOf(y, 'meeting:start'), [{ ok: true, localOnly: false }]);
  // 同じ PC で［文字起こしを始める］なら今どおり知らせが出る（上の「出ない」が空振りでない）
  assert.ok(y.notices.some((n) => /OpenAI/.test(typeof n === 'string' ? n : JSON.stringify(n))), JSON.stringify(y.notices));
  assert.strictEqual(y.status.localOnly, false);
  assert.ok(y.engineLog.includes('会議: 始めた（page）'), y.engineLog.join('\n'));
});

// ---------------------------------------------------------------- RDY-1（RD12。F87）
test('RDY-1（RD12・F87）: 録音の前のページを開いたまま会議に入って出ても止める物が無い（知らせも見張りの行も無い）。始めてから出ると止まり、経過は prep → start → auto-stop/leave', S, async () => {
  const o = await run([['ipc', 'meeting:prepare'], ...Ls('mic teams:1', 2), ['wait-show', 1], ...Ls('mic -', 3), ['snap', 'idle'],
    ['ipc', 'meeting:start'], ...Ls('mic teams:2', 3), ...Ls('mic -', 3), ['snap', 'stopped'], ['finish']]);
  assert.strictEqual(o.snaps.idle.notes, 0);
  assert.ok(!o.engineLog.slice(0, o.engineLog.indexOf('会議: 始めた（page）')).some((l) => l.startsWith('会議を出たかの見張り')), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('会議: 止めた（auto-leave）'), o.engineLog.join('\n'));
  assert.strictEqual(o.notifications.length, 1);
  assert.deepStrictEqual(states(o).filter((s) => !s.startsWith('type')), ['prep/button', 'start/button', 'auto-stop/leave'], JSON.stringify(o.pageStateLogs));
});

test('RDY-1（RD12・RD17）: 録音の前のページを開いていてもパネルは出て、パネルから始めればパネルのアプリを初めから見張り、メモは録音の前のまま', S, async () => {
  const o = await run([['ipc', 'meeting:prepare'], ['ipc', 'meeting:set-memo', MEMO], ...PANEL('teams'), ...Ls('mic teams:1', 2), ['snap', 'm']]);
  assert.strictEqual(o.snaps.m.active, true);
  assert.strictEqual(o.status.memo, MEMO);
  assert.strictEqual(count(o, '会議を出たかの見張り: 会議のアプリがマイクを使っているのを見た（この録音で見張る）'), 1, o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('会議: 始めた（panel）'));
  assert.strictEqual(count(o, FROM_PAGE), 1);
});

// ---------------------------------------------------------------- RDY-4（F92）: 録音の前のページが無いときの今の道は 0.12.1 と同じ
for (const [name, startStep, by] of [['hotkey-meeting', [['hotkey-meeting']], 'hotkey'], ['tray-start', [['tray-start']], 'tray'],
  ['nudge:start', [...L('mic teams:1'), ...L('mic teams:1'), ['wait-show', 1], ['ipc', 'nudge:start', {}]], 'panel'], ['meeting:toggle', [['start']], 'button']]) {
  test(`RDY-4（F92）: 録音の前のページが無いときの ${name} は 0.12.1 と同じ（経過の頭は「開始」で prep が無い・「録音の前のページで始めた」が無い・下書きのメモは空）`, S, async () => {
    // 終わった議事録のページが DB に入るのを待ってから経過を読む（待たないと、負荷の下で stop の直後に 0 件を読んで揺れた。2026-10-27）
    const o = await run([...startStep, ['snap', 'm'], ['stop'], ['wait-pages', 1]]);
    assert.strictEqual(o.snaps.m.active, true, o.engineLog.join('\n'));
    assert.deepStrictEqual(o.snaps.m.draft, { memo: '', meetingType: null });
    assert.deepStrictEqual(states(o).slice(0, 1), [`start/${by}`], JSON.stringify(o.pageStateLogs));
    assert.ok(!states(o).some((s) => s.startsWith('prep/')), JSON.stringify(o.pageStateLogs));
    assert.strictEqual(count(o, FROM_PAGE), 0);
    assert.ok(!o.engineLog.some((l) => l.includes('ページを開いた')), o.engineLog.join('\n'));
    assert.strictEqual(count(o, OPENED), 0);
  });
}

test('RDY-4（RD1）: 録音中・作成中の meeting:prepare は { ok: false } で何も変えない（録音の前のページを作らない・会議はそのまま）', S, async () => {
  const o = await run([['start'], ['ipc', 'meeting:prepare'], ['snap', 'r'], ['ipc', 'meeting:toggle'], ['ipc', 'meeting:prepare'], ['snap', 'f'], ['finish'], ['snap', 'i']]);
  assert.deepStrictEqual(ipcOf(o, 'meeting:prepare'), [{ ok: false }, { ok: false }]);
  assert.deepStrictEqual(o.snaps.r.status, { active: true, prep: null });
  assert.deepStrictEqual(o.snaps.f.status, { active: true, prep: null });
  assert.deepStrictEqual(o.snaps.i.status, { active: false, prep: null });
  assert.strictEqual(count(o, OPENED), 0);
  assert.strictEqual(o.pageMemos.length, 1);
});
