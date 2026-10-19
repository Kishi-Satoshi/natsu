/*
 * stage2a1.main.test.js — 第2a1回（保存の作り替え）の main の確かめ
 *
 * M-1（ST1）: main の議事録の読み書きは、今の JSON の保存のまま await db.call(cmd, args) を通る（中身は src/db/json-backend.js）。
 * 下書き・newId・init・setReporter・root のほかに store を直に呼ばない。場面は helpers/mainrun.js の --json-scene で、
 * main.js を偽の Electron の上で本当に動かす（場面ごとに別のプロセス）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const fnBody = (src, from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `${from} が無い`);
  const j = src.indexOf(to, i + from.length);
  return src.slice(i, j > 0 ? j : src.length);
};
// 場面を1つ動かして、最後の行の JSON を返す（stage1a.main.test.js の run と同じ。見張りは 19 秒）
function runScene(scene) {
  const stdout = execFileSync(process.execPath, [RUN, 'text', `--json-scene=${scene}`], { timeout: 19000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
  return JSON.parse(stdout.trim().split('\n').pop());
}

test('ST1: main は下書きと newId のほかに store を直に呼ばない。ページの読み書きは await db.call を通る', () => {
  const m = read('src/main.js');
  const direct = [...m.matchAll(/store\.(\w+)\(/g)].map((x) => x[1]).filter((n) => !['writeDraft', 'clearDraft', 'draftFiles', 'readDraftFile', 'parkDraft', 'newId', 'init', 'initDrafts', 'setReporter', 'root'].includes(n));
  assert.deepStrictEqual([...new Set(direct)], []);
  assert.ok((m.match(/await db\.call\('/g) || []).length >= 20);
  // 返事を待たない書き込みは db.send（M-3 の写し）だけ。db.call は必ず await する
  assert.ok(!/\bdb\.call\(/.test(m.replace(/await db\.call\(/g, '')), 'await の無い db.call がある（返事を待たずに先へ進む）');
});

test('ST1: 消されたページの待ち行列は、エンジンを起こさずに WAV と recovery.json を片付ける（今と同じ）', { timeout: 20000 }, () => {
  const out = runScene('recovery-page-gone');   // recovery.json の pageId のページが無い
  assert.deepStrictEqual(out.spawns, []);
  assert.ok(!out.files.some((f) => /^data\/segbuf\/.*(recovery\.json|\.wav)$/.test(f)), JSON.stringify(out.files));
});

test('ST1: before-quit は要約中なら1回だけ止めて「中断」を書いてから終える', () => {
  const q = fnBody(read('src/main.js'), "app.on('before-quit'", '\n  });');
  assert.ok(q.includes('e.preventDefault()') && q.includes('app.quit()') && q.includes('saveIfExists(db, id'));
});

// F12: 「ページが無い」と決めてよいのは DB が null と答えたときだけ。読みの失敗で WAV と待ち行列を消さない
test('F12: 復旧の文字起こしは、ページを読めなかったら何も消さずに止める（null のときだけ片付ける）', () => {
  const m = read('src/main.js');
  const rec = fnBody(m, 'async function transcribeRecovered()', '\n}');
  const items = fnBody(m, 'async function transcribeRecoveredItems(', '\n}');
  for (const [name, fn] of [['transcribeRecovered', rec], ['transcribeRecoveredItems', items]]) {
    const i = fn.indexOf("await db.call('page.get', { id: q.pageId })");
    assert.ok(i >= 0, `${name}: ページの確かめが db.call を通っていない`);
    const around = fn.slice(Math.max(0, i - 200), i + 400);
    assert.ok(/try \{/.test(around) && /catch \(e\)/.test(around), `${name}: ページの読みの失敗を受け止めていない（「無い」と取り違える）`);
  }
  assert.ok(rec.indexOf("await db.call('page.get', { id: q.pageId })") < rec.indexOf('await recoveryCloudReady(q)'), 'エンジンを待つ前にページを確かめていない');
  // 同期の読み込み（起動の途中と q = recoveryQueue = loadSavedRecoveryQueue()）はページを確かめない
  assert.ok(!fnBody(m, 'function loadSavedRecoveryQueue()', '\n}').includes('page.get'));
});

test('F6: 要約の書き戻しが5回続けてぶつかったら、要約を捨てたことを知らせる（「ページが削除されました」にしない）', () => {
  const fn = fnBody(read('src/main.js'), 'async function doRunSummary', '\nlet hotkeyState');
  assert.ok(fn.includes("e.code === 'conflict'"), 'conflict を見分けていない');
  assert.ok(read('src/main.js').includes('要約を保存できませんでした。もう一度［要約を生成］を押してください。'));
});
