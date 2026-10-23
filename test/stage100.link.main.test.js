/*
 * stage100.link.main.test.js — 0.10.0 の main のリンク（計画 docs/plans/2026-10-20-100.md の Task LN-3・LN-4。D72・決めたこと 144〜146）
 * LN-3: 起動のたびに、パックした NaTsu は natsu:// を利用者ごとに登録し直す（場所が変わったとき）。引数は -- の後ろにリンク。
 * 場面は helpers/mainrun.js を別のプロセスで回す（Electron の口は偽物。本物の登録は Windows の CI の煙テストだけ）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');
const lib = require('../src/mainlib');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const S = { timeout: sceneTimeout(30000) };
const T = { timeout: 5000 };
const run = (steps, ...flags) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, 'text', `--mcp-steps=${JSON.stringify(steps)}`, ...flags], { env: { ...process.env }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});

test('D72・決めたこと 144: protocolPlan の表（パックしていて登録が違う → 登録・args は [\'--\']／登録が同じ → しない／パックしていない（開発の起動）→ しない）', T, () => {
  assert.deepStrictEqual(lib.protocolPlan({ packaged: true, execPath: 'C:\\P\\NaTsu.exe', isDefault: false }), { register: true, args: ['--'] });
  assert.deepStrictEqual(lib.protocolPlan({ packaged: true, execPath: 'C:\\P\\NaTsu.exe', isDefault: true }), { register: false, args: ['--'] });
  assert.deepStrictEqual(lib.protocolPlan({ packaged: false, execPath: 'C:\\P\\electron.exe', isDefault: false }), { register: false, args: ['--'] });
  for (const bad of [{ packaged: true, execPath: '', isDefault: false }, { packaged: true, execPath: null, isDefault: false }, {}]) assert.strictEqual(lib.protocolPlan(bad).register, false, JSON.stringify(bad));
  assert.strictEqual(lib.PROTOCOL, 'natsu');
});

test('D72・決めたこと 144: パックした形で起動すると、isDefaultProtocolClient を (natsu, execPath, [--]) で聞き、違えば setAsDefaultProtocolClient を同じ引数で1回。同じなら0回。パックしていない形では聞かずに0回', S, async () => {
  const p = await run([], '--packaged');
  assert.deepStrictEqual(p.protocolCalls, [['isDefaultProtocolClient', 'natsu', process.execPath, ['--']], ['setAsDefaultProtocolClient', 'natsu', process.execPath, ['--']]]);
  assert.ok(p.engineLog.includes('リンクの登録: 登録した'), p.engineLog.join('\n'));
  const same = await run([], '--packaged', '--protocol-default');
  assert.deepStrictEqual(same.protocolCalls.map((c) => c[0]), ['isDefaultProtocolClient']);
  const dev = await run([]);
  assert.deepStrictEqual(dev.protocolCalls, []);
  assert.ok(!dev.engineLog.some((l) => l.startsWith('リンクの登録')));
});

// ---------------------------------------------------------------- LN-4（D72・決めたこと 145・146）: リンクで NaTsu のその箇所を開く
test('D72・決めたこと 145: linkFromArgv の表（-- の後ろの最初の natsu: の引数だけを読む。読めなければ bad。-- より前・ほかの引数は見ない）', T, () => {
  assert.deepStrictEqual(lib.linkFromArgv(['C:\\NaTsu.exe', '--', 'natsu://page/pa1#t:s3-s5']), { id: 'pa1', anchor: 't:s3-s5' });
  assert.deepStrictEqual(lib.linkFromArgv(['C:\\NaTsu.exe', '--allow-x', '--', 'natsu://page/pa1/']), { id: 'pa1', anchor: '' });
  for (const argv of [['C:\\NaTsu.exe'], ['C:\\NaTsu.exe', 'natsu://page/pa1'], ['C:\\NaTsu.exe', 'natsu://page/pa1', '--'], ['C:\\NaTsu.exe', '--inspect=9229'], ['C:\\NaTsu.exe', '--', '--inspect'], null, 'x']) {
    assert.strictEqual(lib.linkFromArgv(argv), null, JSON.stringify(argv));
  }
  for (const s of ['NATSU://page/pa1', 'natsu://page/pa1?x=1', 'natsu://page/"pa1"', 'natsu:page/pa1', 'natsu://page/pa1#t:s3-']) {
    assert.strictEqual(lib.linkFromArgv(['C:\\NaTsu.exe', '--', s]), 'bad', s);
  }
});

test('D72: linkRate は 2 秒に 5 回まで（6 回目は捨てる。2 秒たてばまた受ける）。受けた物を変えない', T, () => {
  let times = [];
  const oks = [];
  for (let i = 0; i < 6; i++) { const r = lib.linkRate(times, 1000 + i * 100); oks.push(r.ok); times = r.times; }
  assert.deepStrictEqual(oks, [true, true, true, true, true, false]);
  const frozen = [...times];
  assert.strictEqual(lib.linkRate(times, 3200).ok, true);
  assert.deepStrictEqual(times, frozen);
});

const linksOf = (o) => o.mainSent.filter(([ch]) => ch === 'page:open-link').map(([, p]) => p);
test('D72・決めたこと 145: 起動の argv の -- の後ろの natsu://page/<ID>#t:s3-s5 で、窓を出して page:open-link { id, anchor } を1回。2つ目の起動（second-instance）でも同じ。最小化していれば戻す', S, async () => {
  const o = await run([['second-instance', ['C:\\NaTsu.exe', '--', 'natsu://page/pb2#m:2']]], '--argv=["--","natsu://page/pa1#t:s3-s5"]', '--main-minimized');
  assert.deepStrictEqual(linksOf(o), [{ id: 'pa1', anchor: 't:s3-s5' }, { id: 'pb2', anchor: 'm:2' }]);
  assert.ok(o.mainWinCalls.includes('restore') && o.mainWinCalls.includes('show') && o.mainWinCalls.includes('focus'), o.mainWinCalls.join(' '));
  for (const l of o.engineLog) assert.ok(!/pa1|pb2|natsu:/.test(l), l);
});

test('決めたこと 146: -- より前の natsu://・--inspect などのほかの引数・読めないリンク（NATSU://・?・引用符）は何もせず、記録は「読めないリンクを捨てました」だけ（リンクの文字も ID も書かない）', S, async () => {
  const o = await run([['second-instance', ['C:\\NaTsu.exe', 'natsu://page/pa1', '--inspect=9229']], ['second-instance', ['C:\\NaTsu.exe', '--', 'NATSU://page/pa1']],
    ['second-instance', ['C:\\NaTsu.exe', '--', 'natsu://page/pa1?x=1']], ['second-instance', ['C:\\NaTsu.exe', '--', 'natsu://page/"pa1"']]]);
  assert.deepStrictEqual(linksOf(o), []);
  assert.strictEqual(o.engineLog.filter((l) => l === 'リンク: 読めないリンクを捨てました').length, 3, o.engineLog.join('\n'));
  for (const l of o.engineLog) assert.ok(!/pa1|natsu:\/\/|natsu:page/i.test(l), l);
});

test('D72: 2 秒に 6 回目のリンクは捨て、記録は数の1行だけ', S, async () => {
  const steps = Array.from({ length: 6 }, (_, i) => ['second-instance', ['C:\\NaTsu.exe', '--', `natsu://page/p${i}`]]);
  const o = await run(steps);
  assert.deepStrictEqual(linksOf(o).map((l) => l.id), ['p0', 'p1', 'p2', 'p3', 'p4']);
  assert.ok(o.engineLog.includes('リンク: 2 秒に 5 回を越えたリンクを捨てました'), o.engineLog.join('\n'));
});

test('D78・決めたこと 148: app:parse-link（画面に貼った https の住所の照らし）は natsulink.parseAnyLink と同じ答え。文字でない・長すぎる物は null', S, async () => {
  const NL = require('../src/natsulink');
  const cases = [NL.openUrl('pa1', 't:s1-s2'), 'natsu://page/pa1#m:1', 'https://evil.example/open#p=pa1', 'x'.repeat(5000), 5, null];
  const o = await run(cases.map((c) => ['ipc-raw', 'app:parse-link', c]));
  assert.deepStrictEqual(o.ipc.map(([, r]) => r), cases.map((c) => (typeof c === 'string' ? NL.parseAnyLink(c) : null)));
});
