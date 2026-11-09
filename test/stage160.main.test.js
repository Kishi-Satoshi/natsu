/*
 * stage160.main.test.js — 0.16.0「データベース」の main の場面（計画 docs/plans/2026-11-04-160.md の Task DV-2 から）
 * 偽の Electron の上で main.js を本当に動かして確かめる（helpers/mainrun.js）。
 * DV-2（決めたこと 25・F145・SEC2・R64）: URL のセルの値を押すと、画面は 0.14.0 EB-5 の口 app:open-link（koeApp.openLink）へ送る。
 *       main はセルの照らしと別にもう一度照らし、http(s) と mailto: だけを既定のブラウザやメールで開く（javascript:・file: は開かない）。
 * 住所は作った物で、実在の人名・社名は使わない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const sceneRun = (args, timeout = 30000) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const T = { timeout: sceneTimeout(30000) };

test('DV-2・F145（決めたこと 25・SEC2・R64）: URL のセルの値・メールのセルの mailto: は app:open-link で開き、javascript:・file:・data: の値は開かない（記録に住所を書かない）', T, async () => {
  const MAIL = ['someone', 'example.invalid'].join('@');
  const CASES = [
    ['https://example.com/doc/1', true], ['http://example.com/a?b=1', true], [`mailto:${MAIL}`, true],
    ['javascript:alert(1)', false], ['file:///c:/windows/x', false], ['data:text/html,x', false], [`https://example.com/${'a'.repeat(2049)}`, false],
  ];
  const r = await sceneRun(['text', `--mic-feed=${JSON.stringify([['sleep', 100], ...CASES.map((c) => ['ipc-from', 'main', 'app:open-link', c[0]])])}`]);
  assert.deepStrictEqual(r.ipc.map(([, v]) => v), CASES.map((c) => c[1]), '答え（開いたか）');
  assert.deepStrictEqual(r.external, CASES.filter((c) => c[1]).map((c) => c[0]), 'shell.openExternal に渡した住所');
  for (const x of r.engineLog) assert.ok(!/example|javascript|alert|windows|someone/i.test(x), `記録に住所: ${x}`);
});

// ---------------------------------------------------------------- 0.16.0 DX-1（決めたこと 45・50・R101）
const run = (args) => sceneRun(args, sceneTimeout(20000));
test('DX-1（決めたこと 50・R101）: page:summarize にデータベースのページ・データベースの行のページ → 断る（Claude Code を呼ばない・ページも行も書かない）', T, async () => {
  const r = await run(['text', '--json-scene=db-summarize']);
  assert.match(r.made, /^p[a-z0-9]+$/);
  assert.match(r.row, /^r[a-z0-9]+$/);
  const NO = { ok: false, error: 'データベースのページは要約できません' };
  assert.deepStrictEqual(r.sum, [NO, NO], 'データベースか行のページの要約を断らない');
  for (const i of [0, 1]) assert.deepStrictEqual([r.after[i].rev, r.after[i].updatedAt, r.after[i].blocks], [r.before[i].rev, r.before[i].updatedAt, r.before[i].blocks], '断ったのに書いた');
  assert.ok(!r.spawns.some((s) => /claude/i.test(JSON.stringify(s))), `Claude Code を呼んだ: ${JSON.stringify(r.spawns)}`);
});

test('DX-1（決めたこと 45）: 行のページのタブは起動し直しても戻る（ui:get が今ある行のタブを残す）。ゴミ箱の行・ゴミ箱のデータベースの行・無い行のタブは外し、数だけを記録に書く', T, async () => {
  const r = await run(['text', '--json-scene=ws-row-tabs']);
  const { keep, r1 } = r.ids;
  assert.deepStrictEqual(r.set, { ok: true });
  assert.deepStrictEqual(r.ui.tabs, { open: [`page:${r1}`, `page:${keep}`], active: `page:${r1}` }, '今ある行のタブを外したか、無い行のタブを残した');
  assert.deepStrictEqual(r.engineLog.filter((l) => /無いページのタブ/.test(l)), ['画面の覚え書き: 無いページのタブを 3 個外した'], r.engineLog.join('\n'));
  assert.ok(!r.engineLog.some((l) => Object.values(r.ids).some((id) => l.includes(id))), 'engine.log にページか行の id を書いた');
});
