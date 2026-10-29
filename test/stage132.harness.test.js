/*
 * stage132.harness.test.js — 0.13.2 Task LN-1（計画 docs/plans/2026-10-28-132.md の LR14・LR15。F111）
 * LR14: マイクの場面（helpers/mainrun.js の --mic-feed）の stop・finish は、会議が待機に戻るだけでなく、締め（meeting.finalize）の答えまで待つ。
 *       main は締めの返事を待たずに待機に戻る（F9: 録音は DB を待たせない）ので、CI が混むと場面が締めの前にページを読んでいた（68767ba の CI の
 *       「元のままで赤」）。偽の DB の締めの答えを遅らせる場面の選び肢 --finalize-delay=<ms>（finalizeDelayMs。試験の台の中だけ）で確かめる。
 * LR15: 変異確認の「元のままで赤」は、TAP を全部受けて赤いテストの名前と理由（failsOf）を出す（最後の 8000 文字だけでは名前が残らなかった）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');
const M = require('../tools/mutate');

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
const DELAY = '--finalize-delay=300';
const states = (o) => ((o.pageStateLogs[0] || {}).stateLog || []).map((x) => `${x.s}/${x.by}`);
// 締めの後の形: ページが1つ・題名がある・meeting.phase が done
const finalized = (o) => {
  assert.strictEqual(o.pageFinal.length, 1, `stop の後に読んだページが締めの前の形: ${JSON.stringify(o.pageFinal)}`);
  assert.strictEqual(o.pageFinal[0].phase, 'done', JSON.stringify(o.pageFinal));
  assert.ok(typeof o.pageFinal[0].title === 'string' && o.pageFinal[0].title.length > 0, JSON.stringify(o.pageFinal));
};

// ---------------------------------------------------------------- LR14
test('LN-1・LR14: 偽の DB の締めの答えを 300 ミリ秒遅らせた場面でも、stop の後に読んだページは締めの後の形（題名・meeting.phase が done・経過）（K-1 の形）', S, async () => {
  const o = await run([['hotkey-meeting'], ['ipc', 'overlay:pause', { paused: true }], ['ipc', 'overlay:pause', { paused: false }], ['stop']], DELAY);
  finalized(o);
  assert.deepStrictEqual(states(o), ['start/hotkey', 'pause/overlay', 'resume/overlay', 'stop/button']);
});

test('LN-1・LR14: 締めの答えを遅らせても、finish の後に読んだページは締めの後の形（LV-3 の会議を出て止めた形）', S, async () => {
  const o = await run([...PANEL('teams'), ...Ls('mic -', 3), ['finish']], DELAY);
  finalized(o);
  assert.strictEqual(states(o).slice(-1)[0], 'auto-stop/leave', JSON.stringify(o.pageStateLogs));
});

test('LN-1・LR14: 締めの答えを遅らせても、録音の前のメモと種類が締めの後のページにある（RDY-1 の形）', S, async () => {
  const MEMO = '録音の前に書いた議題メモ（締めを待つ）';
  const o = await run([['ipc', 'meeting:prepare'], ['ipc', 'meeting:set-type', 'sales'], ['ipc', 'meeting:set-memo', MEMO], ['sleep', 50], ['ipc', 'meeting:start'], ['stop']], DELAY);
  finalized(o);
  assert.deepStrictEqual(o.pageMemos.map((p) => [p.memo, p.meetingType]), [[MEMO, 'sales']]);
});

// 0.13.2 点検の直し 5（LR40）: DB の答えを毎回遅らせる場面（dbDelayMs・--db-delay）でも、締めの呼び出しの印を遅らせる前に残す（遅らせている間に
// 「呼び出し 0・答え 0」で締めの済んだ形と読まない）
test('LN-1・LR14・点検の直し 5: DB の答えを毎回 400 ミリ秒遅らせた場面（--db-delay=400）でも、stop の後に読んだページは締めの後の形', S, async () => {
  const o = await run([['hotkey-meeting'], ['stop']], '--db-delay=400');
  finalized(o);
});

// ---------------------------------------------------------------- LR15
const made = [];
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* noop */ } } });
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-赤い名前𠮷-')); made.push(d); return d; };
// 本物の node --test の TAP（入れ子・子だけで赤い親・# TODO・# SKIP・\# の入った名前）
const NESTED_TEST = `'use strict';
const test = require('node:test');
const assert = require('node:assert');
test('親', async (t) => { await t.test('子が赤', () => { assert.strictEqual(1, 2); }); await t.test('子が緑', () => {}); });
test('親も赤', async (t) => { await t.test('子は緑', () => {}); assert.fail('親の失敗'); });
test('やること', { todo: true }, () => { assert.fail('x'); });
test('飛ばす', { skip: true }, () => { assert.fail('x'); });
test('緑', () => {});
test('#入り\\\\名前', () => assert.fail('名前の失敗'));
`;
const tapOf = (dir, file) => require('node:child_process').spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: dir, encoding: 'utf8', env: M.childEnv() }).stdout;

test('LN-1・LR15: failsOf は TAP の中の赤いテスト（入れ子も）の名前と理由を返し、子の失敗だけで赤い親は返さない・# SKIP・# TODO は返さない', { timeout: 20000 }, () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'n.test.js'), NESTED_TEST);
  const tap = tapOf(dir, 'n.test.js');
  const fails = M.failsOf(tap);
  assert.deepStrictEqual(fails.map((f) => f.name), ['子が赤', '親も赤', '#入り\\名前'], tap);
  assert.match(fails[0].reason, /Expected values to be strictly equal/);
  assert.match(fails[1].reason, /親の失敗/);
  assert.match(fails[2].reason, /名前の失敗/);
  // 理由の YAML は 40 行まで
  for (const f of fails) assert.ok(f.reason.split('\n').length <= 40, f.reason);
  const long = ['not ok 1 - 長い理由', '  ---', ...Array.from({ length: 100 }, (_, i) => `  line${i}: ${i}`), '  ...', '1..1'].join('\n');
  const l = M.failsOf(long);
  assert.deepStrictEqual(l.map((f) => f.name), ['長い理由']);
  assert.strictEqual(l[0].reason.split('\n').length, 40);
  assert.deepStrictEqual(M.failsOf(''), []);
  assert.deepStrictEqual(M.failsOf(undefined), []);
});

// 0.13.2 点検の直し 7（LR42）: YAML の塊（--- から ...）の中の字下げした「not ok N - 」（理由の文に写った別の TAP など）を赤いテストと読まない
test('LN-1・LR15・点検の直し 7: failsOf は YAML の塊の中の字下げした not ok の行を数えない（塊の外の入れ子の赤いテストは今どおり数える）', { timeout: 5000 }, () => {
  const tap = [
    'TAP version 13',
    '# Subtest: 親',
    '    # Subtest: 子が赤',
    '    not ok 1 - 子が赤',
    '      ---',
    '      duration_ms: 1',
    "      failureType: 'testCodeFailure'",
    '      error: |-',
    '        写った別の出力:',
    '        not ok 7 - 幽霊',
    '          not ok 8 - 幽霊の子',
    '      ...',
    '    1..1',
    'not ok 1 - 親',
    '  ---',
    "  failureType: 'subtestsFailed'",
    '  ...',
    '# Subtest: 本物',
    'not ok 2 - 本物',
    '  ---',
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    子の TAP:',
    '    not ok 3 - 理由の中の幽霊',
    '  ...',
    '# Subtest: 緑',
    'ok 3 - 緑',
    '  ---',
    '  duration_ms: 1',
    '  stdout: |-',
    '      not ok 5 - 緑の中の幽霊',
    '  ...',
    '1..3',
  ].join('\n');
  const fails = M.failsOf(tap);
  assert.deepStrictEqual(fails.map((f) => f.name), ['子が赤', '本物'], JSON.stringify(fails));
  assert.match(fails[0].reason, /幽霊/, '理由の文が失われた');
});

test('LN-1・LR15: 赤いテストが最初にあり、その後に 8000 文字より長い緑の出力が続く写しで runAll を回すと、baseline-red の fails に赤いテストの名前がある。報告に ✖ <名前> が出る', { timeout: 30000 }, async () => {
  const root = tmpDir();
  for (const d of ['src', 'test', 'tools']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","private":true}');
  fs.writeFileSync(path.join(root, 'src', 'add.js'), "'use strict';\nmodule.exports = (a, b) => a + b;\n");
  const greens = Array.from({ length: 120 }, (_, i) => `test('緑のテスト ${i} ${'あ'.repeat(40)}', () => { assert.strictEqual(add(1, 2), 3); });`).join('\n');
  fs.writeFileSync(path.join(root, 'test', 'add.test.js'),
    `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst add = require('../src/add');\ntest('最初の赤いテスト', () => { assert.strictEqual(add(1, 2), 4, '足し算が合わない'); });\n${greens}\n`);
  const r = await M.runAll({ root, jobs: 1, mutants: [{ id: 'kill', file: 'src/add.js', from: 'a + b', to: 'a - b', tests: ['test/add.test.js'], why: 'x' }] });
  assert.deepStrictEqual(r.map((x) => x.status), ['baseline-red']);
  assert.ok(r[0].output.length <= 8000 && !r[0].output.includes('最初の赤いテスト'), '見本が 8000 文字に収まり、最後の出力に名前が残ってしまう（見本の作り違い）');
  assert.deepStrictEqual(r[0].fails.map((f) => f.name), ['最初の赤いテスト']);
  assert.match(r[0].fails[0].reason, /足し算が合わない/);
  const lines = M.reportLines(r);
  assert.ok(lines.includes('  ✖ 最初の赤いテスト'), lines.join('\n'));
  assert.ok(lines.some((l) => /足し算が合わない/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('BASELINE-RED')), lines.join('\n'));
});
