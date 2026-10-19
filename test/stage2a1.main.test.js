/*
 * stage2a1.main.test.js — 第2a1回（保存の作り替え）の main の確かめ
 *
 * M-1（ST1）: main の議事録の読み書きは、今の JSON の保存のまま await db.call(cmd, args) を通る（中身は src/db/json-backend.js）。
 * 下書き・newId・init・setReporter・root のほかに store を直に呼ばない。場面は helpers/mainrun.js の --json-scene で、
 * main.js を偽の Electron の上で本当に動かす（場面ごとに別のプロセス）。
 * M-2b（ST2・ST7・ST12）: 中身は議事録の DB のプロセス（偽の utilityProcess の中の本物の src/db/server.js）。場面の議事録の読みは
 * natsu.db を読み取り専用で見る（helpers/dbpeek.js）。DB を使えないとき（--db-down）・用意の前・口の配り方・終わるときの閉じ方を見る。
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

test('ST1: 要約の途中の終了は、1回だけ止め、「中断」がページに書けてから app.quit() を呼ぶ。2回目は止めずにエンジンを止める', { timeout: 20000 }, () => {
  const out = runScene('quit-during-summary');   // 要約エンジンは応えない（要約は終わらない）。app.quit は偽物で、呼ばれた瞬間のページを覚える
  assert.ok(out.sumStarted && out.quitted, JSON.stringify(out));
  assert.deepStrictEqual(out.prevented, [1, 0], '1回目だけ止める（2回目も止めると終われない）');
  assert.strictEqual(out.quits.length, 1);
  assert.strictEqual(out.quits[0].summaryError, '要約が中断されました。「要約を生成」で作り直せます', 'app.quit() が「中断」の書き込みより先に呼ばれた');
  assert.strictEqual(out.quits[0].kills, 0, '書き込みを待つ間にエンジンを止めた');
  assert.ok(out.killsAfter >= 1, '2回目の before-quit で要約エンジンを止めていない');
  assert.strictEqual(out.summary.ok, false, JSON.stringify(out.summary));
  assert.strictEqual(out.summaryErrorAfter, '要約が中断されました。「要約を生成」で作り直せます', '終了の後に要約の失敗が「中断」を上書きした');
});

test('ST1: 録音を始める前の復旧を待ってから下書きを選ぶ（今の会議の下書きを消さない・復旧のページは1つ）', { timeout: 20000 }, () => {
  const out = runScene('draft-recover-before-start');   // 起動では draft.json を読めず、録音を始める前の読みで読める
  assert.strictEqual(out.pagesAtStart, 0);
  assert.strictEqual(out.start.ok, true, JSON.stringify(out.start));
  assert.strictEqual(out.titlesAfterStart.length, 1);
  assert.ok(/（復旧）$/.test(out.titlesAfterStart[0]), out.titlesAfterStart[0]);
  assert.deepStrictEqual(out.draftsDuring, ['draft.json'], '今の会議の下書きが無いか、退けた控えが残った');
  assert.ok(out.draftStartedAt && out.draftStartedAt !== 1760000000000, `draft.json が今の会議のものでない: ${out.draftStartedAt}`);
  assert.strictEqual(out.titles.length, 2, JSON.stringify(out.titles));
  assert.strictEqual(out.titles.filter((t) => /（復旧）$/.test(t)).length, 1, JSON.stringify(out.titles));
  assert.deepStrictEqual(out.draftsAfter, []);
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
  // 受け止めた中身: 何も消さず、待ち行列を残して止める（ほかの catch と取り違えないよう、page.get の直後の catch の中だけを見る）
  const catchBody = (fn) => {
    const i = fn.indexOf("await db.call('page.get', { id: q.pageId })");
    const j = fn.indexOf('} catch (e) {', i);
    assert.ok(j > i && j - i < 120, 'page.get の直後に catch が無い');
    const indent = fn.slice(fn.lastIndexOf('\n', j) + 1, j);   // catch を閉じる } は同じ字下げ
    const k = fn.indexOf(`\n${indent}}\n`, j);
    assert.ok(k > j, 'catch の終わりが見つからない');
    return fn.slice(j, k);
  };
  const recCatch = catchBody(rec);
  assert.ok(recCatch.includes('recoveryQueue = q;') && /\breturn;/.test(recCatch), `transcribeRecovered: 読めないときに待ち行列を残して止めていない\n${recCatch}`);
  assert.ok(!/dropRecoveryQueue|unlink/.test(recCatch), `transcribeRecovered: 読めないときに WAV か recovery.json を消す\n${recCatch}`);
  const itemsCatch = catchBody(items);
  assert.ok(/return \{ \.\.\.q, items: rest \};\s*$/.test(itemsCatch), `transcribeRecoveredItems: 読めないときに残りの区間を返して止めていない\n${itemsCatch}`);
  assert.ok(!/unlink/.test(itemsCatch), `transcribeRecoveredItems: 読めないときに WAV を消す\n${itemsCatch}`);
  // 画面の覚え書き: 一覧を読めなかったら（ids が null）覚えたタブを外さない
  assert.ok(fnBody(m, "ipcMain.handle('ui:get'", '\n  });').includes('W.keepTabs(winState.tabs, (id) => !ids || ids.has(id))'), 'ui:get: 一覧を読めないときに覚えたタブを外す');
  assert.ok(rec.indexOf("await db.call('page.get', { id: q.pageId })") < rec.indexOf('await recoveryCloudReady(q)'), 'エンジンを待つ前にページを確かめていない');
  // 同期の読み込み（起動の途中と q = recoveryQueue = loadSavedRecoveryQueue()）はページを確かめない
  assert.ok(!fnBody(m, 'function loadSavedRecoveryQueue()', '\n}').includes('page.get'));
});

test('F6: 要約の書き戻しが5回続けてぶつかったら、要約を捨てたことを知らせる（「ページが削除されました」にしない）', () => {
  const fn = fnBody(read('src/main.js'), 'async function doRunSummary', '\nlet hotkeyState');
  assert.ok(fn.includes("e.code === 'conflict'"), 'conflict を見分けていない');
  assert.ok(read('src/main.js').includes('要約を保存できませんでした。もう一度［要約を生成］を押してください。'));
});

// 非同期になった受け口（ホットキー・やり直しの予約）は投げても unhandled にしない（main に unhandledRejection の受け手は無い）
test('ST1: 議事録のホットキーと下書きのやり直しは、失敗を記録に受け止める（unhandled にしない）', () => {
  const m = read('src/main.js');
  assert.ok(m.includes("{ label: '議事録', accel: mhk, handler: () => toggleMeetingByHotkey().catch((e) => engineLog("), 'ホットキーの受け口が .catch していない');
  const retry = fnBody(m, 'async function retryDraftRecovery()', '\n}\n');
  assert.ok(/\n  try \{\n/.test(retry) && /\n  \} catch \(e\) \{\n    engineLog\(`下書きのやり直しに失敗: \$\{errCode\(e\)\}`\);\n  \}$/.test(retry), `retryDraftRecovery が中身を try で受け止めていない\n${retry}`);
});

// ---------------------------------------------------------------- M-2b（ST2 の配線・ST7・ST12・F12）: main を DB のプロセスにつなぐ
test('ST12・RF10: DB が開けなくても（--db-down）設定・画面の覚え書き・履歴は読み書きでき、知らせ D1 が1回、録音は下書きに残る', { timeout: 20000 }, () => {
  const out = runScene('db-down');   // json-scenes: 設定を保存・ui:set・音声入力1回・会議を始めて区間1つで止める
  assert.strictEqual(out.notices.filter((n) => n.startsWith('議事録の保存の仕組みを使えません。')).length, 1);
  assert.ok(out.settingsSaved && out.winStateText && out.history.length === 1);
  assert.ok(out.files.some((f) => /^data\/draft(-\d+)?\.json$/.test(f)), '締めに失敗したのに下書きを消した');
  assert.ok(out.engineLog.some((l) => /^DB: 諦めた/.test(l) || /^DB: SQLite .*trigram NG/.test(l)));
  assert.ok(out.engineLog.some((l) => /^DB: 起動（番号 \d+）$/.test(l)), '実機の 4 で照らす番号の行が無い');
});
test('F12: DB が止まっている間は、復旧の待ち行列の WAV と recovery.json を消さず、覚えたタブも外さない', { timeout: 20000 }, () => {
  const out = runScene('recovery-db-down');   // segbuf に recovery.json（pageId は移したページ）と WAV 2つ、window-state.json に開いたタブ2つ。--db-down で起動
  // 計画の外で足した確かめ: 保留したのは「DB を読めない」ためであること（エンジンが無いための保留と取り違えない）
  assert.strictEqual(out.held, true, '復旧の文字起こしが「議事録を読めません」で保留していない');
  assert.ok(out.files.some((f) => /^data\/segbuf\/.*recovery\.json$/.test(f)), 'DB が止まっているだけなのに待ち行列を片付けた');
  assert.strictEqual(out.files.filter((f) => /^data\/segbuf\/.*\.wav$/.test(f)).length, 2, 'DB が止まっているだけなのに WAV を消した');
  assert.strictEqual(out.uiTabs.open.length, 2, 'DB が止まっているだけなのに覚えたタブを外した');
});
test('F12: DB の用意の前（起動・移行の途中）の ui:get は、用意を待たずに覚えたタブをそのまま返す。用意の後は無いページのタブを外す', { timeout: 20000 }, () => {
  const out = runScene('ui-before-db-ready');
  assert.ok(['starting', 'migrating'].includes(out.stateBefore), `場面の前提: 用意の前に聞いていない（${out.stateBefore}）`);
  assert.deepStrictEqual(out.before.open, ['page:pkeep1', 'page:pgone'], '用意の前に覚えたタブを外した');
  assert.ok(out.beforeMs < 1000, `用意の前の ui:get が DB を待った（${out.beforeMs}ms）`);
  assert.ok(out.ready);
  assert.deepStrictEqual(out.after.open, ['page:pkeep1'], '用意の後に無いページのタブを外していない');
});
test('ST7: 口は本体の窓の読み込みのたびに配り、録音バーには渡さない', { timeout: 20000 }, () => {
  const out = runScene('db-ports');   // 本体の窓の did-finish-load を2回、録音バーの did-finish-load を1回出す
  assert.deepStrictEqual(out.portsSent, [{ win: 'main', channel: 'db:port' }, { win: 'main', channel: 'db:port' }]);
});
// 点検で足した確かめ（M-2b の目的の「客の lost で db:lost を本体の窓に送り、起こし直したら口を配り直す」を押さえるテストが無かったため）
test('ST7: 用意の後に DB の子が落ちたら、本体の窓に db:lost を送り、起こし直した子の用意ができたら口を配り直す', { timeout: 20000 }, () => {
  const out = runScene('db-restart');
  assert.ok(out.crashed && out.restarted, JSON.stringify(out));
  assert.deepStrictEqual(out.mainSent, ['db:lost'], '子が落ちたことを本体の窓に知らせていない');
  assert.deepStrictEqual(out.portsSent, [{ win: 'main', channel: 'db:port' }, { win: 'main', channel: 'db:port' }], '起こし直した後に口を配り直していない');
  assert.ok(out.engineLog.some((l) => /^DB: 子が終わった（1）。500ms 後に起こし直す$/.test(l)));
});
test('ST7・RF10: 最初の用意の前（移行の途中）に DB の子が落ちても、db:lost を送り、起こし直した子の用意で口を配り直す。移行はやり直し、元の JSON は変えない', { timeout: 20000 }, () => {
  const out = runScene('db-restart-before-ready');
  assert.ok(out.migrating, '場面の前提: 移行の途中で落としていない');
  assert.ok(out.crashed && out.restarted, JSON.stringify(out));
  assert.deepStrictEqual(out.mainSent, ['db:lost']);
  assert.deepStrictEqual(out.portsSent, [{ win: 'main', channel: 'db:port' }, { win: 'main', channel: 'db:port' }], '落ちた子の口のまま（アプリで最初の用意だからと配り直さなかった）');
  assert.deepStrictEqual(out.pages, ['pmig1'], '起こし直した子が移行をやり直していない');
  assert.strictEqual(out.jsonKept, true, '元の JSON が変わった');
});

// 計画の外で足した確かめ（M-2b の目的の「終わるときと更新の前に DB を閉じる」「起動では元の JSON に触れない」を押さえるテストが無かったため）
test('ST7: 終わるときは要約が無くても1回だけ止め、DB を閉じてから app.quit() を呼ぶ（書き出しはいつも最初に同期で）', { timeout: 20000 }, () => {
  const out = runScene('quit-closes-db');
  assert.deepStrictEqual(out.prevented, [1, 0], '1回目だけ止める');
  assert.strictEqual(out.quits.length, 1);
  assert.strictEqual(out.quits[0].cleanShutdown, 1, 'DB を閉じる前に app.quit() を呼んだ');
  assert.strictEqual(out.quits[0].closed, true, 'DB の子を閉じていない');
});
test('ST7: 更新と再起動の前（relaunchAndExit の前）に DB を閉じる。main は DB のプロセスを NaTsu DB の名前で起こし、元の JSON の索引を読まない', () => {
  const m = read('src/main.js');
  const restart = fnBody(m, "ipcMain.handle('app:restart'", '\n  });');
  assert.ok(/await db\.close\(\{ timeoutMs: DB_CLOSE_MS \}\);\n\s*relaunchAndExit\(\);/.test(restart), `app:restart: 閉じてから再起動していない\n${restart}`);
  const tray = fnBody(m, 'async function checkUpdateFromTray()', '\nfunction updateTray');
  assert.ok(/await db\.close\(\{ timeoutMs: DB_CLOSE_MS \}\);\n\s*relaunchAndExit\(\);/.test(tray), 'トレイからの更新: 閉じてから再起動していない');
  assert.ok(m.includes("serverPath: path.join(__dirname, 'db', 'server.js')"));
  assert.ok(!m.includes('makeJsonBackend'), 'main がまだ JSON の保存（json-backend）を使う');
  assert.ok(!/store\.(init|listPages|getPage|getTranscript|searchIndex|savePage)\(/.test(m), 'main が元の JSON の索引やページを読む');
});
