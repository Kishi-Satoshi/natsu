/* stage180.main.test.js — 0.18.0（計画 docs/plans/2026-11-18-180.md）の main の場面
 * 偽の Electron の上で main.js を本当に動かして確かめる（helpers/mainrun.js）。
 *  CS-1（決めたこと 15・16・F236）: ［要約を生成］は要約の作り方の部品（src/summaryWrite.js の prepareSummary）を通る
 * 発言・要約の文・人の名前は作った物（実在の人名を使わない）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');
const SW = require('../src/summaryWrite');
const memoTypes = require('../src/memoTypes');
const lib = require('../src/mainlib');
const R = require('../src/pagerules');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const sceneRun = (args, timeout = 30000, env = {}) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', ...env }, maxBuffer: 1 << 24, timeout },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const T = { timeout: sceneTimeout(60000) };

// ---------------------------------------------------------------- CS-1
const LONG = '見積の作成は済みました。結合テストは今週で完了します。遅れの原因は仕様の変更です。来週に人を足す案があります。冒頭で決めることを言いました。予算の話を2回やり直しました。人を足すと確かめました。人の手配は山田さんが来週金曜までにします。'.repeat(2);
const sumRun = (md) => sceneRun(['text', '--sum', '--claude=ok', '--segs=2', `--text=${LONG}`, '--set-type-live=standup', `--sum-md=${md}`]);
const noAt = (q) => (q ? { ...q, at: '' } : q);
const shapeOf = (p) => ({ sumBlocks: p.sumBlocks, citeStat: p.citeStat, actionStat: p.actionStat, quality: noAt(p.quality) });

test('CS-1・F236: Claude Code の偽の答えで［要約を生成］→ 保存される要約の行・出典の数・点が prepareSummary の答えと同じ。答えの行の終わりの出典の印（無い発言 s999 を指すものも）は外れ、出典は照合の答えだけ', T, async () => {
  const [a, b] = await Promise.all([sumRun('report-score'), sumRun('report-score-cites')]);
  const p = a.pages[0];
  assert.ok(p.quality, `前提: 点が付く: ${p.summaryError}`);
  // 同じページ（種類・メモ・発言）を prepareSummary に通した答えと、保存された要約が同じ（main は同じ部品を通る）
  const segs = p.segs.filter((s) => !s.failed);
  const hasLabel = lib.timelineOf(segs).some((r) => lib.srcLabel(r));
  const template = memoTypes.buildTemplate({ meetingType: p.meetingType, score: true, labeled: hasLabel });
  const md = fs.readFileSync(path.join(__dirname, 'fixtures', 'summaries', 'report-score.md'), 'utf8');
  const want = SW.prepareSummary({ md, page: { meetingType: p.meetingType, createdAt: '2026-11-20T01:00:00.000Z', memo: p.memo }, segments: segs, segmentsAtStart: segs, score: true, template });
  R.markShortBlocks(want.blocks);
  const view = (bs) => bs.map((x) => ({ type: x.type, text: x.text, mark: x.mark, unconfirmed: x.unconfirmed, citeState: x.citeState, cites: Array.isArray(x.cites) ? x.cites.length : 0, ...(x.level !== undefined ? { level: x.level } : {}) }));
  assert.deepStrictEqual(JSON.parse(JSON.stringify(p.sumBlocks)), JSON.parse(JSON.stringify(view(want.blocks))), '保存された要約の行');
  assert.deepStrictEqual(p.citeStat, { ...want.citeStat, ...R.citeStatOf(want.blocks) }, '出典の数');
  assert.deepStrictEqual([p.actionStat, noAt(p.quality)], [want.actionStat, noAt(want.quality)], 'ToDo の数と点');
  // 出典の印を書いた答えも、印の無い答えと同じ行・出典・点になる（印は文に残らず、s999 を指さない）
  const q = b.pages[0];
  assert.ok(!q.sumBlocks.some((x) => /出典/.test(x.text)), q.sumBlocks.map((x) => x.text).join('\n'));
  assert.deepStrictEqual(shapeOf(q), shapeOf(p), '出典の印を書いた答えの保存が、印の無い答えと違う');
  for (const o of [a, b]) assert.ok(!o.engineLog.some((l) => /出典|結合テスト|s999/.test(l)), '記録に要約の文や出典の印が出た');
});

// ---------------------------------------------------------------- CS-2
// main の客の trace（helpers/mainrun.js）: 要約を作っている間の知らせ（making）と、頼み（call・ack）の順
const makingsOf = (o) => o.trace.filter((x) => x.kind === 'making').map((x) => x.ids);
function makingAround(o, id) {
  const tr = o.trace;
  const on = tr.findIndex((x) => x.kind === 'making' && x.ids.includes(id));
  assert.ok(on >= 0, `making が届いていない: ${JSON.stringify(tr.filter((x) => x.kind !== 'draft'))}`);
  // ページを読む前: making の次の頼みが、そのページの読み（page.get）
  assert.deepStrictEqual(tr.slice(on + 1).find((x) => x.kind === 'call'), { kind: 'call', cmd: 'page.get' }, 'making より先にページを読んだ');
  const off = tr.findIndex((x, i) => i > on && x.kind === 'making' && !x.ids.includes(id));
  assert.ok(off > on, 'making が外れていない');
  return { on, off };
}

test('CS-2・F235: ［要約を生成］の間、DB のプロセスに making が届き（ページを読む前）、終わると外れる。Claude Code が失敗しても・終了の中断でも外れる', T, async () => {
  const [good, bad, quit] = await Promise.all([
    sceneRun(['text', '--sum', '--claude=ok', '--segs=1']),
    sceneRun(['text', '--sum', '--claude=limit', '--segs=1']),
    sceneRun(['text', '--json-scene=making-quit', '--claude=slow'], 40000, { FAKE_CLAUDE_DELAY: '1500' }),
  ]);
  const id = good.pages[0].id;
  assert.deepStrictEqual(makingsOf(good), [[id], []]);
  const g = makingAround(good, id);
  const lastPut = good.trace.map((x) => `${x.kind} ${x.cmd}`).lastIndexOf('ack page.put');
  assert.ok(lastPut > g.on && lastPut < g.off, '要約の書き戻しの後に外していない');
  const bid = bad.pages[0].id;
  assert.ok(bad.pages[0].summaryError, '前提: Claude Code が失敗した');
  assert.deepStrictEqual(makingsOf(bad), [[bid], []]);
  makingAround(bad, bid);
  assert.ok(quit.sumStarted, JSON.stringify(quit));
  assert.notStrictEqual(quit.summary, 'running', '要約が終わらない');
  assert.deepStrictEqual(makingsOf(quit), [['pq1'], []]);
  makingAround(quit, 'pq1');
});

// ---------------------------------------------------------------- AQ41（2026-11-22「設定に従う（おすすめ）」・決めたこと 22・CR59）
test('AQ41・CS-2: main は、設定「打ち合わせの質」を DB のプロセスに知らせる（起動で DB の頼みより前に今の値・設定の保存で変わった値）', T, async () => {
  const o = await sceneRun(['text', `--mcp-steps=${JSON.stringify([['save', { qualityScore: 'off' }], ['save', { qualityScore: 'on' }]])}`, `--settings-add=${JSON.stringify({ qualityScore: 'on' })}`]);
  const q = o.qualityTrace.map((x) => x.setting);
  assert.strictEqual(q[0], 'on', `起動で今の値を知らせていない: ${JSON.stringify(q)}`);
  assert.deepStrictEqual(q.filter((v, i) => i === 0 || v !== q[i - 1]), ['on', 'off', 'on'], `設定の保存で変わった値を知らせていない: ${JSON.stringify(q)}`);
});
