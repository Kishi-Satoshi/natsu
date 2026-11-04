/*
 * stage150.main.test.js — 0.15.0「ページの階層」の main の場面（計画 docs/plans/2026-11-03-150.md の Task PH-3・PH-4）
 * main.js を偽の Electron の上で本当に動かす（helpers/mainrun.js の --json-scene）。
 * PH-3（決めたこと 19・F118）: ui:get のサイドバーの木の開け閉め（tree.open）は今あるページだけ（無いページは落とし、数だけを記録に1行）。
 * PH-4（決めたこと 24・F116）: 白紙のページの page:summarize は断る（Claude Code を呼ばない・ページを書かない）。
 * PL-1（決めたこと 37・F119）: ui:get はアイコンの最近使ったもの（emojiRecent）も返す（辞書の絵文字だけ）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});

test('PH-3・F118: ui:get の tree は今あるページだけ（無いページの開け閉めは落とし、engine.log には数だけ）。2回目の ui:get は外した後の形', { timeout: sceneTimeout(20000) }, async () => {
  const r = await run(['text', '--json-scene=ws-tree-get']);
  assert.deepStrictEqual(r.ui.tree, { open: ['ptkeep2', 'ptkeep1'] }, '無いページの開け閉めを返した（覚えた並びのまま残す）');
  assert.deepStrictEqual(r.again.tree, { open: ['ptkeep2', 'ptkeep1'] });
  assert.deepStrictEqual(r.engineLog.filter((l) => /無いページの木の開け閉め/.test(l)), ['画面の覚え書き: 無いページの木の開け閉めを 2 個外した'], r.engineLog.join('\n'));
  assert.ok(!r.engineLog.some((l) => /ptgone|ptkeep/.test(l)), 'engine.log にページの id を書いた');
});

test('PH-4・F116: page:summarize に白紙のページの ID → 断り（「白紙のページは要約できません」。Claude Code を呼ばない・ページを書かない）', { timeout: sceneTimeout(20000) }, async () => {
  const r = await run(['text', '--json-scene=blank-summarize']);
  assert.match(r.made, /^p[a-z0-9]+$/);
  assert.deepStrictEqual(r.sum, { ok: false, error: '白紙のページは要約できません' }, '白紙のページの要約を断らない');
  assert.deepStrictEqual([r.after.rev, r.after.updatedAt, r.after.kind, r.after.blocks], [r.before.rev, r.before.updatedAt, 'blank', []], '断ったのにページを書いた');
  assert.ok(!r.spawns.some((s) => /claude/i.test(JSON.stringify(s))), `Claude Code を呼んだ: ${JSON.stringify(r.spawns)}`);
});

test('PL-1・F119: ui:get は最近使ったアイコン（emojiRecent）も返す（覚え書きの辞書に無い値・重なりは落とす）。ui:set で足した値も照らして次の ui:get に出る', { timeout: sceneTimeout(20000) }, async () => {
  const r = await run(['text', '--json-scene=ws-emoji-get']);
  assert.deepStrictEqual(r.ui.emojiRecent, ['🚀', '📄'], '辞書に無い値・重なりを返した');
  assert.deepStrictEqual(r.set, { ok: true });
  assert.deepStrictEqual(r.again.emojiRecent, ['🌸', '🚀'], 'ui:set の値を照らさないか、覚えない');
});
