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
const { execSceneSync, sceneTimeout } = require('./helpers/scene-slots');

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
  const stdout = execSceneSync(process.execPath, [RUN, 'text', `--json-scene=${scene}`], { timeout: 19000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
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

test('ST1: 消されたページの待ち行列は、エンジンを起こさずに WAV と recovery.json を片付ける（今と同じ）', { timeout: sceneTimeout(20000) }, () => {
  const out = runScene('recovery-page-gone');   // recovery.json の pageId のページが無い
  assert.deepStrictEqual(out.spawns, []);
  assert.ok(!out.files.some((f) => /^data\/segbuf\/.*(recovery\.json|\.wav)$/.test(f)), JSON.stringify(out.files));
});

test('ST1: before-quit は要約中なら1回だけ止めて「中断」を書いてから終える', () => {
  const q = fnBody(read('src/main.js'), "app.on('before-quit'", '\n  });');
  assert.ok(q.includes('e.preventDefault()') && q.includes('app.quit()') && q.includes('saveIfExists(db, id'));
});

test('ST1: 要約の途中の終了は、1回だけ止め、「中断」がページに書けてから app.quit() を呼ぶ。2回目は止めずにエンジンを止める', { timeout: sceneTimeout(20000) }, () => {
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

test('ST1: 録音を始める前の復旧を待ってから下書きを選ぶ（今の会議の下書きを消さない・復旧のページは1つ）', { timeout: sceneTimeout(20000) }, () => {
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
test('ST12・RF10: DB が開けなくても（--db-down）設定・画面の覚え書き・履歴は読み書きでき、知らせ D1 が1回、録音は下書きに残る', { timeout: sceneTimeout(20000) }, () => {
  const out = runScene('db-down');   // json-scenes: 設定を保存・ui:set・音声入力1回・会議を始めて区間1つで止める
  assert.strictEqual(out.notices.filter((n) => n.startsWith('議事録の保存の仕組みを使えません。')).length, 1);
  assert.ok(out.settingsSaved && out.winStateText && out.history.length === 1);
  assert.ok(out.files.some((f) => /^data\/draft(-\d+)?\.json$/.test(f)), '締めに失敗したのに下書きを消した');
  assert.ok(out.engineLog.some((l) => /^DB: 諦めた/.test(l) || /^DB: SQLite .*trigram NG/.test(l)));
  assert.ok(out.engineLog.some((l) => /^DB: 起動（番号 \d+）$/.test(l)), '実機の 4 で照らす番号の行が無い');
});
test('F12: DB が止まっている間は、復旧の待ち行列の WAV と recovery.json を消さず、覚えたタブも外さない', { timeout: sceneTimeout(20000) }, () => {
  const out = runScene('recovery-db-down');   // segbuf に recovery.json（pageId は移したページ）と WAV 2つ、window-state.json に開いたタブ2つ。--db-down で起動
  // 計画の外で足した確かめ: 保留したのは「DB を読めない」ためであること（エンジンが無いための保留と取り違えない）
  assert.strictEqual(out.held, true, '復旧の文字起こしが「議事録を読めません」で保留していない');
  assert.ok(out.files.some((f) => /^data\/segbuf\/.*recovery\.json$/.test(f)), 'DB が止まっているだけなのに待ち行列を片付けた');
  assert.strictEqual(out.files.filter((f) => /^data\/segbuf\/.*\.wav$/.test(f)).length, 2, 'DB が止まっているだけなのに WAV を消した');
  assert.strictEqual(out.uiTabs.open.length, 2, 'DB が止まっているだけなのに覚えたタブを外した');
});
test('F12: DB の用意の前（起動・移行の途中）の ui:get は、用意を待たずに覚えたタブをそのまま返す。用意の後は無いページのタブを外す', { timeout: sceneTimeout(20000) }, () => {
  const out = runScene('ui-before-db-ready');
  assert.ok(['starting', 'migrating'].includes(out.stateBefore), `場面の前提: 用意の前に聞いていない（${out.stateBefore}）`);
  assert.deepStrictEqual(out.before.open, ['page:pkeep1', 'page:pgone'], '用意の前に覚えたタブを外した');
  assert.ok(out.beforeMs < 1000, `用意の前の ui:get が DB を待った（${out.beforeMs}ms）`);
  assert.ok(out.ready);
  assert.deepStrictEqual(out.after.open, ['page:pkeep1'], '用意の後に無いページのタブを外していない');
});
test('ST7: 口は本体の窓の読み込みのたびに配り、録音バーには渡さない', { timeout: sceneTimeout(20000) }, () => {
  const out = runScene('db-ports');   // 本体の窓の did-finish-load を2回、録音バーの did-finish-load を1回出す
  assert.deepStrictEqual(out.portsSent, [{ win: 'main', channel: 'db:port' }, { win: 'main', channel: 'db:port' }]);
});
// 点検で足した確かめ（M-2b の目的の「客の lost で db:lost を本体の窓に送り、起こし直したら口を配り直す」を押さえるテストが無かったため）
test('ST7: 用意の後に DB の子が落ちたら、本体の窓に db:lost を送り、起こし直した子の用意ができたら口を配り直す', { timeout: sceneTimeout(20000) }, () => {
  const out = runScene('db-restart');
  assert.ok(out.crashed && out.restarted, JSON.stringify(out));
  assert.deepStrictEqual(out.mainSent, ['db:lost'], '子が落ちたことを本体の窓に知らせていない');
  assert.deepStrictEqual(out.portsSent, [{ win: 'main', channel: 'db:port' }, { win: 'main', channel: 'db:port' }], '起こし直した後に口を配り直していない');
  assert.ok(out.engineLog.some((l) => /^DB: 子が終わった（1）。500ms 後に起こし直す$/.test(l)));
});
test('ST7・RF10: 最初の用意の前（移行の途中）に DB の子が落ちても、db:lost を送り、起こし直した子の用意で口を配り直す。移行はやり直し、元の JSON は変えない', { timeout: sceneTimeout(20000) }, () => {
  const out = runScene('db-restart-before-ready');
  assert.ok(out.migrating, '場面の前提: 移行の途中で落としていない');
  assert.ok(out.crashed && out.restarted, JSON.stringify(out));
  assert.deepStrictEqual(out.mainSent, ['db:lost']);
  assert.deepStrictEqual(out.portsSent, [{ win: 'main', channel: 'db:port' }, { win: 'main', channel: 'db:port' }], '落ちた子の口のまま（アプリで最初の用意だからと配り直さなかった）');
  assert.deepStrictEqual(out.pages, ['pmig1'], '起こし直した子が移行をやり直していない');
  assert.strictEqual(out.jsonKept, true, '元の JSON が変わった');
});

// 計画の外で足した確かめ（M-2b の目的の「終わるときと更新の前に DB を閉じる」「起動では元の JSON に触れない」を押さえるテストが無かったため）
test('ST7: 終わるときは要約が無くても1回だけ止め、DB を閉じてから app.quit() を呼ぶ（書き出しはいつも最初に同期で）', { timeout: sceneTimeout(20000) }, () => {
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

// ---------------------------------------------------------------- M-3（ST6・RF10・RF16・F6・F11）: 録音・下書き・復旧とのつなぎ
// 場面は helpers/mainrun.js をそのまま（--json-scene ではなく、記録 → 区間 → 締め の今の道）で動かす。--keep-user-data=<フォルダ> で
// 2回の起動に同じ userData を使う（フォルダは日本語と 𠮷 の名前。消すのはこのファイルの終わり）
const os = require('node:os');
const keptDirs = [];
test.after(() => { for (const d of keptDirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* 消せなくても結果は変えない */ } } });
const tmpUserData = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-ud-議事録𠮷-'));
  keptDirs.push(d);
  return d;
};
// mainrun を1回動かして最後の行の JSON を返す。expectExit なら、main ごと落ちて（0 でない番号で）終わることを確かめて null を返す。
// dbBytesHave(text) は、場面が終わる前に natsu.db と -wal のバイトに text があったか（mainrun の dbHas。--secret-text の語だけ見る）
function runMain(mode, flags, { expectExit = false } = {}) {
  let stdout = '';
  try {
    stdout = execSceneSync(process.execPath, [RUN, mode, ...flags], { timeout: 25000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (expectExit && typeof e.status === 'number' && e.status !== 0) return null;
    throw e;
  }
  assert.ok(!expectExit, '場面の前提: main ごと落ちていない');
  const out = JSON.parse(stdout.trim().split('\n').pop());
  out.dbBytesHave = (text) => {
    assert.ok(out.dbHas && Object.hasOwn(out.dbHas, text), `場面が ${text} を DB のバイトで見ていない`);
    return out.dbHas[text];
  };
  return out;
}
const onePage = (out) => { assert.strictEqual(out.pages.length, 1, JSON.stringify(out.pages.map((p) => p.title))); return out.pages[0]; };

test('ST6: 下書きに pageId があり、締めた会議のページは同じ ID。下書きは「書けた」の後に消える', { timeout: sceneTimeout(20000) }, () => {
  const out = runMain('text', ['--segs=2', '--draft-trace']);   // 下書きを書くたびの中身と、clearDraft と meeting.finalize の返事の順を out.trace に
  const ids = new Set(out.trace.filter((t) => t.kind === 'draft').map((t) => t.pageId));
  assert.strictEqual(ids.size, 1);
  assert.strictEqual(onePage(out).id, [...ids][0]);
  const iAck = out.trace.findIndex((t) => t.kind === 'ack' && t.cmd === 'meeting.finalize');
  const iClear = out.trace.findIndex((t) => t.kind === 'clearDraft');
  assert.ok(iAck >= 0 && iAck < iClear, '返事の前に下書きを消した');
});

test('RF10: 最初の発言の後に DB を落としても（--kill-db-during）録音は続き、会議はちょうど1つ・下書きは残らない', { timeout: sceneTimeout(20000) }, () => {
  const out = runMain('text', ['--segs=3', '--kill-db-during']);
  assert.strictEqual(onePage(out).segments.length, 3);
  assert.ok(out.dbStarts >= 2);
  assert.ok(!out.files.some((f) => /^data\/draft/.test(f)));
});

test('RF10: 最初の発言の後に main ごと落として起動し直す（--kill-main-during）→ 同じ ID のページがちょうど1つ・recovered', { timeout: sceneTimeout(30000) }, () => {
  const dir = tmpUserData();
  runMain('text', ['--segs=3', '--kill-main-during', `--keep-user-data=${dir}`], { expectExit: true });
  const out = runMain('text', ['--recover', `--keep-user-data=${dir}`]);
  const p = onePage(out);
  assert.strictEqual(p.recovered, true);
  assert.strictEqual(p.id, out.draftPageIdBefore, '復旧で別の ID のページを作った（写しと2つになる）');
});

// 計画の外で足した確かめ（目的の「下書きを失った写しだけを recovered: true で残す」（meeting.settle）を押さえるテストが無かったため）
test('ST6: main ごと落ちた後に下書きを失った録音の写しは、次の起動で同じ ID の recovered のページとして1つ残る（meeting.settle）', { timeout: sceneTimeout(30000) }, () => {
  const dir = tmpUserData();
  runMain('text', ['--segs=3', '--kill-main-during', `--keep-user-data=${dir}`], { expectExit: true });
  const drafts = fs.readdirSync(path.join(dir, 'data')).filter((n) => /^draft.*\.json$/.test(n));
  assert.strictEqual(drafts.length, 1, '場面の前提: 落ちた会議の下書きが1つでない');
  const pageId = JSON.parse(fs.readFileSync(path.join(dir, 'data', drafts[0]), 'utf8')).pageId;
  fs.rmSync(path.join(dir, 'data', drafts[0]));   // 下書きを失った（写しだけが DB に残る）
  const b = runMain('text', ['--idle', `--keep-user-data=${dir}`]);
  assert.ok(b.trace.some((t) => t.kind === 'ack' && t.cmd === 'meeting.settle'), '起動で meeting.settle を頼んでいない');
  const p = onePage(b);
  assert.strictEqual(p.id, pageId);
  assert.strictEqual(p.recovered, true);
  assert.strictEqual(p.segments.length, 1, '写しの発言が残っていない');
});

// 点検で足した確かめ（M-3 の「発言の無い下書きは、始めたときの空の写しを取り消しと同じ道で消す」を外しても全部が緑だったため）
test('ST6: 録音を始めた直後（発言の前）に main ごと落ちても、次の起動で空の写しを消し、空の「（復旧）」のページを作らない（0.6.0 と同じ）', { timeout: sceneTimeout(30000) }, () => {
  const dir = tmpUserData();
  runMain('text', ['--kill-main-at-begin', `--keep-user-data=${dir}`], { expectExit: true });
  const drafts = fs.readdirSync(path.join(dir, 'data')).filter((n) => /^draft.*\.json$/.test(n));
  assert.strictEqual(drafts.length, 1, '場面の前提: 落ちた会議の下書きが1つでない');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data', drafts[0]), 'utf8')).segments, [], '場面の前提: 下書きに発言がある');
  const b = runMain('text', ['--idle', `--keep-user-data=${dir}`]);
  assert.deepStrictEqual(b.pages, [], '発言の無い会議の空の写しが「（復旧）」のページになった');
  assert.ok(!b.files.some((f) => /^data\/draft/.test(f)), '発言の無い下書きを片付けなかった');
});

test('RF10: DB が開けないまま締める（--db-down）→ 下書きが残り、次に DB が開ける起動でちょうど1つになる', { timeout: sceneTimeout(30000) }, () => {
  const dir = tmpUserData();
  const a = runMain('text', ['--segs=2', '--db-down', `--keep-user-data=${dir}`]);
  assert.strictEqual(a.pages.length, 0);
  const b = runMain('text', ['--recover', `--keep-user-data=${dir}`]);
  onePage(b);
});

test('RF16: 録音中に取り消すと、写しの発言が DB のファイルに残らない（DB が落ちていたら次の起動で消す）', { timeout: sceneTimeout(30000) }, () => {
  const out = runMain('text', ['--segs=2', '--discard-during', '--secret-text']);   // 偽の文字起こしが秘密の語を返す
  // 計画の外で足した確かめ（場面の前提）: 取り消す前に、秘密の語が写しとして DB に届いていた
  assert.strictEqual(out.secretSeen, true, '場面の前提: 秘密の語が DB に届く前に取り消した');
  assert.deepStrictEqual(out.pages, []);
  assert.strictEqual(out.dbBytesHave('秘密の語'), false);
  const dir = tmpUserData();
  const a = runMain('text', ['--segs=1', '--discard-during', '--kill-db-at-discard', '--secret-text', `--keep-user-data=${dir}`]);
  assert.strictEqual(a.secretSeen, true, '場面の前提: 秘密の語が DB に届く前に取り消した');
  const b = runMain('text', ['--idle', `--keep-user-data=${dir}`]);
  assert.deepStrictEqual(b.pages, [], '取り消した会議が「下書きの無い写し」として復旧された');
  assert.strictEqual(b.dbBytesHave('秘密の語'), false);
});

// 点検で足した確かめ（取り消しの控えを書けず、DB の取り消しも返事の前に終わると、次の起動で取り消した会議が「（復旧）」のページになっていた）
test('RF16: 取り消しの控え（purge-pending.json）を1回書けず、DB も落ちていても、終わる前に書き直し、次の起動で写しを消す', { timeout: sceneTimeout(30000) }, () => {
  const dir = tmpUserData();
  const a = runMain('text', ['--segs=1', '--discard-during', '--kill-db-at-discard', '--secret-text', '--purge-save-fail-once', `--keep-user-data=${dir}`]);
  assert.strictEqual(a.secretSeen, true, '場面の前提: 秘密の語が DB に届く前に取り消した');
  assert.ok(a.trace.some((t) => t.kind === 'purgeSaveFail'), '場面の前提: 取り消しの控えの書き込みを失敗させていない');
  const b = runMain('text', ['--idle', `--keep-user-data=${dir}`]);
  assert.deepStrictEqual(b.pages, [], '取り消した会議が「下書きの無い写し」として復旧された');
  assert.strictEqual(b.dbBytesHave('秘密の語'), false);
});

test('F11: 締めた後に下書きを消せず（ウイルス対策が掴んだ）、要約と直しをしてから起動し直しても、要約と直しが残り、ページは1つ', { timeout: sceneTimeout(30000) }, () => {
  const dir = tmpUserData();
  const a = runMain('text', ['--segs=2', '--sum', '--keep-draft-after-finalize', '--set-title-after-sum=後で直した題', `--keep-user-data=${dir}`]);
  assert.ok(a.files.some((f) => /^data\/draft/.test(f)), '場面の前提: 下書きが残っていない');
  const b = runMain('text', ['--recover', `--keep-user-data=${dir}`]);
  const p = onePage(b);
  assert.strictEqual(p.title, '後で直した題', '復旧が直しを上書きした');
  assert.ok(p.blocks.length > 0, '復旧が要約を空で上書きした');
  assert.ok(!b.files.some((f) => /^data\/draft/.test(f)), '下書きを片付けなかった');
});

test('F6: 要約の途中に画面で直した題名を、要約の書き戻しが消さない', { timeout: sceneTimeout(30000) }, () => {
  const out = runMain('text', ['--sum', '--set-title-during=画面で直した題']);   // 要約は 1.5 秒。その間に appCall('page.setTitle')
  const p = onePage(out);
  assert.strictEqual(p.title, '画面で直した題');
  assert.ok(p.blocks.length > 0, '要約が入らなかった');
});

test('ST5: main は画面のページの口を中継しない（ipcMain の page:・block:・pages:・segment: は page:summarize だけ）', () => {
  const m = read('src/main.js');
  const chans = [...m.matchAll(/ipcMain\.handle\('((?:page|pages|block|segment):[\w-]+)'/g)].map((x) => x[1]);
  assert.deepStrictEqual(chans, ['page:summarize']);
});

// ---------------------------------------------------------------- M-4（ST10 の配線・ST9 の配線・RF14・F9）: 移行の窓・移行の間の録音・起動のたびの取り込み・毎日の控え
// 場面は helpers/json-scenes.js（migrate-*・snapshot-daily・summary-bad-args）。偽の dialog は場面が決めなければ［移す］を押す
test('ST10: 初めての起動で数を窓で見せ、［移す］で移して知らせる。元の JSON は1バイトも変わらない', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('migrate-go');   // 0.6.0 の store.js で 6 ページ（BOM 付き 1）と壊れたページのファイル 1 つを置いて起動し、窓で［移す］
  assert.match(out.dialogs[0].message, /議事録 6 件・文字起こしの発言 15 件/);
  assert.match(out.dialogs[0].message, /壊れているか形が合わず移せないファイル: 1 件/);
  assert.deepStrictEqual(out.dialogs[0].buttons, ['移す', '今は移さずに終える']);
  assert.ok(out.notices.some((n) => n.startsWith('議事録 6 件を新しい保存の形に移しました。')));
  assert.deepStrictEqual(out.jsonShaAfter, out.jsonShaBefore);
  assert.strictEqual(out.pages.length, 6);
  assert.ok(out.files.some((f) => /^data\/backup\/natsu-.*-migration\.db\.gz$/.test(f)), '移行の後の控えが無い');
  // 計画の外で足した確かめ: 窓の既定は［移す］、Esc は［今は移さずに終える］（元の JSON に触れない側）。飛ばしたものの知らせ D3 は1回
  assert.strictEqual(out.dialogs[0].defaultId, 0);
  assert.strictEqual(out.dialogs[0].cancelId, 1);
  assert.strictEqual(out.notices.filter((n) => n.startsWith('壊れているか形が合わなかったため、1 件のファイルを移せませんでした')).length, 1, JSON.stringify(out.notices));
  assert.ok(!out.notices.some((n) => n.startsWith('古い版で保存された議事録')), '移した直後の取り込みが同じページを「取り込んだ」と知らせた');
});

test('Q1: ［今は移さずに終える］なら natsu.db を作らずに終え、元の JSON も下書きもそのまま', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('migrate-quit');
  assert.strictEqual(out.quitCalled, true);
  assert.strictEqual(out.closed, true, '終える前に DB を閉じていない');
  assert.ok(!out.files.includes('data/natsu.db'));
  assert.deepStrictEqual(out.jsonShaAfter, out.jsonShaBefore);
  assert.strictEqual(out.draftSame, true, '下書きが変わった・消えた');
});

test('RF14・F9: 移行の間にホットキーで録音して止めると、待つ間も状態は待機に戻って次の録音を始められ、移行の後に会議が増える（窓が出ている間も同じ）', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('migrate-record-during');   // 窓を開いたまま録音 → 停止 → もう1回録音 → 停止 → 3回目の録音中に［移す］→ 止める
  assert.strictEqual(out.dialogShown, true, '場面の前提: 移行の窓が出ていない');
  // 録音の状態の確かめを場面の前提より先に見る（状態が戻らないと場面はそこで結果を出し、dbStateBeforeAnswer を入れない。M-4 の点検）
  assert.deepStrictEqual(out.statesBeforeReady, ['idle', 'idle'], '締めが DB を待つ間、録音の状態が戻らなかった（次の録音を始められない）');
  assert.strictEqual(out.dbStateBeforeAnswer, 'migrating', '場面の前提: 窓の答えの前に DB が用意できた');
  // 0.9.4 P-1 で意図して変えた: 録音バーは止めたら薄く消えるので、データベースを待つ文は本体の窓の知らせで出す
  assert.ok(out.notices.some((m) => m === '録音を保存しました。議事録は準備ができしだい作ります'), JSON.stringify(out.notices));
  assert.ok(!out.overlayDone.some((m) => m === '録音を保存しました。議事録は準備ができしだい作ります'), '録音バーに出した');
  // 計画と違えたところ: 録音中の写しを片付けが一覧に出さないかを見るため、3回目の録音を［移す］の前に始めて後で止める（会議は 3 つ増える）
  assert.strictEqual(out.thirdStarted, true);
  assert.strictEqual(out.pages.length, out.migratedCount + 3);
  assert.ok(!out.files.some((f) => /^data\/draft/.test(f)));
  assert.strictEqual(out.settled, true, '場面の前提: 用意の後の片付け（meeting.settle）が済んでいない');
  assert.strictEqual(out.listedWhileRecording, false, '移行の後の片付け（settle）で、録音中の写しが一覧に出た');
  assert.ok(!out.notices.some((n) => n.startsWith('前回中断された議事録')), '締めの返事を待っている会議を、復旧が別の道で書いた');
  // 計画の外で足した確かめ: 締めの返事を待つ会議の下書きを復旧が読まない（読むと「締め済み」として片付け、締めの道と2つの道で同じ下書きを扱う）
  assert.ok(!out.engineLog.some((l) => /は締め済みか取り消した会議のものだったので片付けました/.test(l)), '締めの返事を待っている会議の下書きを、復旧が読んだ');
  // 計画の外で足した確かめ: 移行の進み具合を帯に出し、済んだら帯を消す
  const lastMove = out.progress.map((m) => /^議事録を移しています… \d+\/\d+$/.test(m)).lastIndexOf(true);
  assert.ok(lastMove >= 0, JSON.stringify(out.progress));
  assert.strictEqual(out.progress[lastMove + 1], '', `移行が済んだのに進み具合の帯が残った: ${JSON.stringify(out.progress)}`);
});

// M-4 の点検で足した確かめ（利用者の 0.6.0 → 0.7.0 の初めての起動: 0.6.0 で落ちた会議の下書きが残っている）
test('F9・RF14: 0.6.0 の下書き（pageId が無い）を起動の復旧が DB を待って抱えている間も、窓 D0 を開いたまま録音をすぐ始められ、録音中の下書きを復旧が消さない。0.6.0 の下書きは1つのページになり、下書きは残らない', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('migrate-old-draft-record');
  assert.strictEqual(out.dialogShown, true, '場面の前提: 移行の窓が出ていない');
  assert.strictEqual(out.startedQuick, true, '録音を始めるのが、起動の復旧（DB の用意）を待った（録音は DB に頼らない: F9）');
  assert.strictEqual(out.dbBefore, 'migrating', '場面の前提: 録音を始めたときに DB が用意できていた');
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.recoverDone, true, '場面の前提: 起動の復旧（meeting.recover）が済んでいない');
  assert.strictEqual(out.stillRecording, true, '場面の前提: 起動の復旧が済んだときに録音が続いていない');
  assert.strictEqual(out.liveDraftKept, true, `起動の復旧の片付けが、録音中の会議の下書きを消した: ${JSON.stringify(out.draftsAfterReady)}`);
  assert.deepStrictEqual(out.draftsEnd, [], '下書き（退けた 0.6.0 の下書きを含む）が残った（次の起動でもう一度ページになる）');
  assert.ok(!out.files.some((f) => /^data\/draft/.test(f)), JSON.stringify(out.files));
  assert.strictEqual(out.pages.filter((p) => /（復旧）$/.test(p.title)).length, 1, JSON.stringify(out.pages));
  assert.strictEqual(out.pages.length, 2 + 1 + 1, JSON.stringify(out.pages));   // 移した 2・0.6.0 の下書き 1・録音 1
});

// 0.7.0 の前の直し（M-4 の点検で残したこと。データの守り）: 締めの返事を待つ会議は、録音の状態が待機に戻っても「忙しい」
test('F9: 締めの返事を待つ会議がある間は、省電力の抑止を外さず、閉じるボタンで確かめる。返事と要約の試みの後は外す', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('finalize-wait-busy');
  assert.strictEqual(out.dialogShown, true, '場面の前提: 移行の窓が出ていない');
  assert.strictEqual(out.waiting, true, '場面の前提: 締めが DB を待つ間に録音の状態が待機に戻らない');
  assert.strictEqual(out.dbWhileWaiting, 'migrating', '場面の前提: 締めの返事の前に DB が用意できた');
  assert.strictEqual(out.powerHeldWhileWaiting, true, '締めの返事を待つ間に省電力の抑止を外した（眠ると締めが遅れ、そのまま終えると要約が作られない）');
  assert.strictEqual(out.closeDialogs.length, 1, '締めの返事を待つ間の閉じるボタンで、確かめを出さずに終えた');
  assert.strictEqual(out.closeDialogs[0].message, '議事録を保存しています');
  assert.deepStrictEqual(out.closeDialogs[0].buttons, ['終了する', 'キャンセル']);
  assert.strictEqual(out.closePrevented, true, '［キャンセル］でも閉じた');
  assert.strictEqual(out.quitCallsAfterClose, 0, '［キャンセル］でも終えた');
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.finalized, true, '［移す］の後に会議が締まらない');
  assert.strictEqual(out.powerReleasedAfter, true, '締めと要約の試みが済んでも省電力の抑止を外さない');
});

// 0.7.0 の前の直し（M-4 の点検で残したこと。計画 2026-10-19-2a1.md の M-4「残したことの直し」）: 録音の最中の［今は移さずに終える］は、
// 録音を切らずに続け、止めて下書きに書き終えてから終える
test('Q1・F9: 録音の最中に［今は移さずに終える］を選ぶと、録音を切らずに知らせ、止めて下書きに書き終えてから終える（natsu.db は作らず、下書きは残る）', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('migrate-quit-recording');
  assert.strictEqual(out.dialogShown, true, '場面の前提: 移行の窓が出ていない');
  assert.strictEqual(out.started, true, '場面の前提: 窓の間に録音を始められない');
  assert.strictEqual(out.quitCallsWhileRecording, 0, '録音の最中に、確かめずに終えた（会議の録音が途中で切れる）');
  assert.strictEqual(out.stillRecording, true, '［今は移さずに終える］で録音が止まった');
  assert.strictEqual(out.notices.filter((n) => n === '録音中なので、録音が終わるまで NaTsu を開いたままにします。議事録の保存の形を移すかは、次に起動したときにもう一度聞きます。終えるときは、録音を止めてください。').length, 1, JSON.stringify(out.notices));
  assert.strictEqual(out.quitAfterStop, true, '録音を止めても終えない');
  assert.strictEqual(out.closed, true, '終える前に DB を閉じていない');
  assert.strictEqual(out.draftSegs, 2, '録音の2つの区間が下書きに残っていない（次の起動で復旧できない）');
  assert.ok(!out.files.includes('data/natsu.db'), '［今は移さずに終える］なのに natsu.db を作った');
  assert.deepStrictEqual(out.jsonShaAfter, out.jsonShaBefore);
});

test('F9: 下書きの復旧は1つずつ回す。DB の用意を待つ復旧が2つ重なっても、pageId の無い 0.6.0 の下書きは1つのページになる', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('migrate-draft-retry-twice');
  assert.strictEqual(out.dialogShown, true, '場面の前提: 移行の窓が出ていない');
  assert.ok(out.retries >= 1, '場面の前提: 起動で下書きを読めず、やり直しの時計が置かれていない');
  assert.strictEqual(out.dbBefore, 'migrating', '場面の前提: やり直しの間に DB が用意できていた');
  assert.strictEqual(out.ready, true);
  assert.strictEqual(out.pages.filter((p) => /（復旧）$/.test(p.title)).length, 1, `0.6.0 の下書きが2つのページになった: ${JSON.stringify(out.pages)}`);
  assert.deepStrictEqual(out.draftsEnd, []);
});

test('ST10: 移行の確かめが合わなければ「使えない」で起き、録音は下書きに残り、次の起動でやり直す', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('migrate-verify-fail');
  assert.ok(out.notices.some((n) => n.startsWith('議事録を新しい保存の形に移せませんでした。元のファイルはそのまま残っています。')));
  assert.ok(!out.files.includes('data/natsu.db'));
  assert.ok(out.files.some((f) => /^data\/natsu\.db\.migrating\.failed-/.test(f)));
  // 計画の外で足した確かめ: D4 のときは D1 を出さない。元の JSON は1バイトも変わらない
  assert.ok(!out.notices.some((n) => n.startsWith('議事録の保存の仕組みを使えません。')), JSON.stringify(out.notices));
  assert.deepStrictEqual(out.jsonShaAfter, out.jsonShaBefore);
});

test('ST9: 録音中は控えを取らず、手が空いたら1日1回 daily を取る', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('snapshot-daily');
  assert.strictEqual(out.scheduledAtStart, 1, '起動の後に毎日の控えを見る時計を置いていない');
  assert.deepStrictEqual(out.snapshotKindsDuringMeeting, []);
  assert.deepStrictEqual(out.snapshotKindsAfter, ['daily']);
});

// 計画の外で足した確かめ（M-4 の点検の申し送り: 保存の決まりを超えたページへの書き戻しの bad-args を黙って飲まない）
test('F6: 保存の決まり（ブロック 2,000 個まで）を超えたページへの要約の書き戻しが断られたら、平易な文で知らせる（投げて黙らない）', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('summary-bad-args');
  assert.strictEqual(out.inserted, true, '場面の前提: 2,001 個目の行を足せなかった');
  assert.strictEqual(out.summaryThrew, undefined, `要約が bad-args を投げた（画面に理由が出ない）: ${out.summaryThrew}`);
  assert.strictEqual(out.summary.ok, false);
  const text = '要約を保存できませんでした。この議事録が保存できる大きさ（題名は 500 字まで・行は 2,000 個まで）を超えています。題名を短くするか行を減らしてから、もう一度［要約を生成］を押してください。';
  assert.ok(out.notices.includes(text), JSON.stringify(out.notices));
  assert.strictEqual(out.summary.error, text);
});

test('F9: 起動は、DB が利用者を待つ（移行の窓）か少し待っても用意できなければ、取り消しの送り直し・下書きの復旧・写しの片付けを待たずに画面とホットキーを用意する', () => {
  const m = read('src/main.js');
  const boot = fnBody(m, 'app.whenReady().then(', '\n  });');
  assert.ok(!/\n    await flushPurgePending\(\);/.test(boot) && !/\n    const startupDrafts = await recoverDraftIfAny\(\);/.test(boot), '起動の手番で DB をそのまま待っている');
  assert.ok(boot.includes('await Promise.race([startupWork.catch(() => {}), dbNeedsUser, new Promise((r) => { setTimeout(r, STARTUP_DB_WAIT_MS); })]);'), '起動の片付けの待ちに、移行の窓と時間の上限が無い');
  assert.ok(boot.indexOf('await Promise.race([startupWork') < boot.indexOf('setupIpc();') && boot.indexOf('setupIpc();') < boot.indexOf('resolveStartupHotkeys('));
  assert.ok(fnBody(m, 'async function askMigrate(', '\n}').includes('dbNeedsUserResolve();'), '移行の窓を出すときに起動の待ちを解かない');
});

// 計画の外で足した確かめ（M-4 の目的の「起動のたびの取り込みで入れたものがあれば D5、飛ばしたファイルの組が変わったときだけ D3」「新しすぎる版なら D7」を押さえるテストが無かったため）
test('RF17: 移した後に古い版が足したページを、起動のたびの取り込みで入れて知らせ D5。飛ばしたファイルの組が変わったので D3 も1回', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('reimport-after-migrate');
  assert.deepStrictEqual(out.notices.filter((n) => n === '古い版で保存された議事録 1 件を取り込みました。'), ['古い版で保存された議事録 1 件を取り込みました。'], JSON.stringify(out.notices));
  assert.strictEqual(out.notices.filter((n) => n.startsWith('壊れているか形が合わなかったため、1 件のファイルを移せませんでした')).length, 1, JSON.stringify(out.notices));
  assert.ok(!out.notices.some((n) => n.startsWith('議事録 ') && n.includes('新しい保存の形に移しました')), '移していない起動で D2 を出した');
  assert.strictEqual(out.pages.length, 3);
});
test('D7: 新しい版の NaTsu で作られた DB は読むだけで開き、知らせ D7 を1回', { timeout: sceneTimeout(30000) }, () => {
  const out = runScene('db-newer');
  assert.strictEqual(out.dbState, 'read-only');
  assert.strictEqual(out.notices.filter((n) => n.startsWith('この議事録の保存は、新しい版の NaTsu で作られています。')).length, 1, JSON.stringify(out.notices));
  assert.strictEqual(out.pages.length, 1);
});
