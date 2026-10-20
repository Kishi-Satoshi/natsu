/*
 * stage3.main.test.js — 第3段（v0.11.0）の main 側の判断と結線
 *
 * 判断は src/mainlib.js / src/settings.js の純関数として切り出し、ここで実行して固定する。
 * main.js は Electron を require するので直接は読み込めない。結線（main.js がそれらを
 * 本当に呼んでいるか）は repo.test.js と同じ流儀で、ソースの文字列を見て固定する。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeSettings, REMOVED_KEYS } = require('../src/settings');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const main = read('src/main.js');
const preload = read('src/preload.js');
// コメントに一致して素通りしないよう、コメントを落としてから見る（repo.test.js と同じ）
const code = (t) => String(t).replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fnBody = (src, from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `${from} が無い`);
  const j = src.indexOf(to, i + from.length);
  return src.slice(i, j > 0 ? j : src.length);
};

// ---------------------------------------------------------------- 設定キー（第3段で足した sumCtx / engineIdleMin）
const DEF = { localPort: 8990, sumPort: 8991, localThreads: 8, sumThreads: 8, segmentSec: 75, sumCtx: 32768, engineIdleMin: 10 };

test('normalizeSettings: sumCtx は 4096〜131072 に丸め、壊れた値は既定 32768', () => {
  assert.strictEqual(normalizeSettings({ ...DEF, sumCtx: 1000 }, DEF).sumCtx, 4096);
  assert.strictEqual(normalizeSettings({ ...DEF, sumCtx: 999999 }, DEF).sumCtx, 131072);
  assert.strictEqual(normalizeSettings({ ...DEF, sumCtx: 'abc' }, DEF).sumCtx, 32768);
  assert.strictEqual(normalizeSettings({ ...DEF, sumCtx: '16384' }, DEF).sumCtx, 16384, '文字列の数字を数に直していない');
  assert.strictEqual(normalizeSettings({ ...DEF, sumCtx: undefined }, DEF).sumCtx, 32768, '未設定（古い settings.json）で既定にならない');
});

test('normalizeSettings: engineIdleMin は 0〜120 に丸め、0（止めない）は 0 のまま', () => {
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: 0 }, DEF).engineIdleMin, 0, '0 = 止めない を既定に戻している');
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: '0' }, DEF).engineIdleMin, 0);
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: -5 }, DEF).engineIdleMin, 0);
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: 500 }, DEF).engineIdleMin, 120);
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: 'x' }, DEF).engineIdleMin, 10);
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: undefined }, DEF).engineIdleMin, 10);
  assert.strictEqual(normalizeSettings({ ...DEF, engineIdleMin: 7.9 }, DEF).engineIdleMin, 7, '整数に切っていない');
});

test('normalizeSettings: 外した設定キー（dataDir）は読まず、書き戻さない', () => {
  assert.deepStrictEqual(REMOVED_KEYS, ['dataDir']);
  for (const v of ['D:\\x', '', 42, null]) {
    assert.strictEqual(Object.hasOwn(normalizeSettings({ ...DEF, dataDir: v }, DEF), 'dataDir'), false);
  }
});

// 意図: 古い設定に無いキーが既定で埋まる。既定は settings.js の defaultSettings（第1a回 Task 2-2 で main から移した）
test('DEFAULT_SETTINGS は settings.js の defaultSettings。sumCtx / engineIdleMin があり、dataDir は無い', () => {
  assert.match(code(main), /const DEFAULT_SETTINGS = defaultSettings\(os\.cpus\(\)\.length\);/);
  const { defaultSettings } = require('../src/settings');
  const d = defaultSettings(8);
  assert.strictEqual(d.sumCtx, 16384);   // 第0b回 Task 16 で既定を 16384 に下げた（保存済みの値は書き換えない）
  assert.strictEqual(d.engineIdleMin, 10);
  assert.ok(!('dataDir' in d), '外した設定キー dataDir が既定値に残っている');
});

// ---------------------------------------------------------------- 保存先は userData/data だけ（第0a回 R6）
// 第2a1回 M-2b で意図して変えた（計画の「意図して変えるもの」）: 起動は下書きだけの初め方 store.initDrafts（元の JSON に触れない）。
// 議事録は DB のプロセスが持ち、DB を使えないときは知らせ D1
test('保存先は userData/data だけ（store.initDrafts は1引数、移動の道は無い）。開けなければ画面に知らせる', () => {
  const m = code(main);
  const load = fnBody(m, 'function loadStores()', '\n}');
  assert.ok(/try \{ store\.initDrafts\(app\.getPath\('userData'\)\); \} catch \(e\) \{ storeError = e\.message; engineLog\(/.test(load), '開けないときに窓が出なくなる／理由を持たない');
  assert.ok(m.includes("if (storeError) mainWin.webContents.once('did-finish-load', () => sendToMainWin('app:notice', "), '開けなかったことを画面に知らせていない');
  assert.strictEqual((m.match(/store\.initDrafts\(/g) || []).length, 1);
  assert.strictEqual((m.match(/store\.init\(/g) || []).length, 0, '起動で元の JSON を退けて索引を書き直す store.init が残っている');
  assert.ok(m.includes('議事録の保存の仕組みを使えません。録音は音声と下書きとして保存を続けています。NaTsu を終了して、もう一度起動してください（理由の記録: %APPDATA%\\\\natsu\\\\engine.log）。'), '知らせ D1 の文が無い');
  // 外した設定キー dataDir（保存先の移動）の名残が無い。DB のプロセスへの init の dataDir（<userData>/data に決めたもの。第2a1回 M-2b）だけは除く
  const noDbInit = m.replace(/^  dataDir: '',$/m, '').replace(/DB_INIT\.dataDir/g, '');
  assert.ok(m.includes("DB_INIT.dataDir = path.join(app.getPath('userData'), 'data');"), 'DB のプロセスの保存先が userData/data でない');
  for (const k of ['dataDir', "'data:dir'", "'data:move'", 'moveDataDir', 'cpSync', 'dataDirNotice', "kind === 'folder'"]) assert.ok(!noDbInit.includes(k), k);
  assert.ok(m.includes('const dataRoot = () => store.root();'));
  assert.match(m, /ipcMain\.handle\('app:open-data-dir', \(\) => \{ shell\.openPath\(dataRoot\(\)\); return true; \}\)/);
  assert.match(m, /const segbufRoot = \(\) => path\.join\(app\.getPath\('userData'\), 'data', 'segbuf'\)/);
  assert.ok(!preload.includes('dataDirGet') && !preload.includes("'data:"));
  const lib = require('../src/mainlib');
  for (const n of ['planDataMove', 'dataMoveMode', 'dataDirFallback', 'sameTree']) assert.strictEqual(lib[n], undefined, n);
});

test('dialog:pick はファイルだけを選ばせ（フォルダの分岐は無い）、pages:actionView の結線', () => {
  const m = code(main);
  const pick = fnBody(m, "ipcMain.handle('dialog:pick'", '\n  });');
  assert.ok(!pick.includes("'folder'"), 'フォルダ選択の分岐が残っている（呼び手は無い）');
  assert.ok(!pick.includes('openDirectory'), 'フォルダを選ぶ指定が残っている');
  assert.ok(pick.includes("properties: ['openFile']"), 'ファイルを選ぶ指定が無い');
  assert.match(pick, /return res\.canceled \? null : res\.filePaths\[0\];/, 'ファイル選択の戻り値が変わっている');
  // 第2a1回 M-3（ST5）: main はアクション一覧を中継しない（画面は preload の DB の口へ直に頼む。絞り込みはそのまま渡す）
  assert.ok(!m.includes("ipcMain.handle('pages:actionView'"), 'main が pages:actionView をまだ中継している');
  // 第2a1回 P-1: 画面の口は main を通らず DB の口へ（引数の形 { q, assignee } はそのまま）
  assert.ok(preload.includes("  pagesActionView: ({ q, assignee }) => dbCall('pages.actionView', { q, assignee }),"), 'preload の pagesActionView が無い（書式込み）');
  // app が使わなくなったので、統合で openActions / assigneeList は preload と main から外した
  assert.ok(!preload.includes('openActions:') && !preload.includes('assigneeList:'), '使われない openActions / assigneeList が preload に残っている');
  assert.ok(!m.includes("'pages:openActions'") && !m.includes("'pages:assignees'"), '使われない handle が main に残っている');
  // 全文検索は保存の側の答えをそのまま返す（上限 60）。第2a1回 M-3 から main は中継せず、preload が DB の口へ頼む
  assert.ok(!m.includes("ipcMain.handle('pages:searchFull'"), 'main が pages:searchFull をまだ中継している');
  assert.ok(preload.includes("  pagesSearchFull: (q) => dbCall('pages.searchFull', { q: q || '', limit: 60 }),"), 'pages.searchFull の上限 60（書式込み）');
});

// ---------------------------------------------------------------- #41 要約の文脈長（判断）
const { estimateTokens, foldNotes, ENGINE_SETTING_KEYS, guardEngineSettings } = require('../src/mainlib');

test('estimateTokens: UTF-8 のバイト数 ÷ 2.5 の切り上げ（多めに見積もって溢れる側に外さない）', () => {
  assert.strictEqual(estimateTokens(''), 0);
  assert.strictEqual(estimateTokens(null), 0);
  assert.strictEqual(estimateTokens('abcde'), 2);          // 5 バイト → 2
  assert.strictEqual(estimateTokens('あ'), 2);              // 3 バイト → 1.2 → 2
  assert.strictEqual(estimateTokens('あいうえお'), 6);      // 15 バイト → 6
  assert.strictEqual(estimateTokens('a'.repeat(250)), 100);
});

test('foldNotes: 前から順に「合計が予算に収まる束」に分ける（1 件で超える要点メモは単独の束）', () => {
  const len = (t) => t.length;
  assert.deepStrictEqual(foldNotes(['a', 'bb', 'ccc', 'd'], 3, len), [['a', 'bb'], ['ccc'], ['d']]);
  assert.deepStrictEqual(foldNotes(['aaaaa', 'b', 'c'], 3, len), [['aaaaa'], ['b', 'c']], '予算を超える 1 件を単独の束にしていない');
  assert.deepStrictEqual(foldNotes(['a', 'b'], 100, len), [['a', 'b']], '収まるなら 1 束');
  assert.deepStrictEqual(foldNotes([], 3, len), []);
  // 順序を入れ替えない（時系列のまま）。入力は書き換えない
  const notes = ['x', 'yy', 'z'];
  const r = foldNotes(notes, 2, len);
  assert.deepStrictEqual(r.flat(), notes);
  assert.deepStrictEqual(notes, ['x', 'yy', 'z']);
  // 予算が壊れていても止まらない（0 以下・NaN は 1 とみなす → 全部単独の束）
  assert.deepStrictEqual(foldNotes(['a', 'b'], 0, len), [['a'], ['b']]);
  assert.deepStrictEqual(foldNotes(['a', 'b'], NaN, len), [['a'], ['b']]);
  // 推定関数を省けば estimateTokens で数える
  assert.deepStrictEqual(foldNotes(['あいうえお', 'かきくけこ'], 6), [['あいうえお'], ['かきくけこ']]);
});

test('#41 sumCtx は記録中に変えられないエンジン設定で、名前は「要約の文脈長」', () => {
  assert.ok(ENGINE_SETTING_KEYS.includes('sumCtx'));
  const prev = { sumCtx: 32768, theme: 'dark' };
  const r = guardEngineSettings(prev, { sumCtx: 8192, theme: 'light' }, true);
  assert.strictEqual(r.settings.sumCtx, 32768);
  assert.deepStrictEqual(r.kept, ['sumCtx']);
  assert.ok(r.warning.includes('要約の文脈長'), '警告で名指ししていない');
});

// ---------------------------------------------------------------- #41 要約の文脈長（結線）
test('#41 llama-server の -c は settings.sumCtx で、署名（再起動の判断）にも入る', () => {
  const m = code(main);
  const args = fnBody(m, 'function engineSpawnArgs(eng)', '\n}');
  assert.ok(args.includes("'-c', String(settings.sumCtx),"), '-c が settings.sumCtx でない');
  assert.ok(!args.includes("'16384'"), '固定の 16384 が残っている');
  const sig = fnBody(m, 'function engineSignature(eng)', '\n}');
  assert.ok(sig.includes("eng === whisperEng ? '' : settings.sumCtx"), '要約エンジンの署名に sumCtx が入っていない（変えても再起動されない）');
});

test('#41 統合プロンプトが文脈長に収まらないときは要点メモを 2 段で畳み、engineLog にだけ残す', () => {
  const m = code(main);
  assert.match(m, /const SUM_CTX_MARGIN = 256;/);
  assert.match(m, /const sumCtxBudget = \(\) => settings\.sumCtx - SUM_MAX_TOKENS - SUM_CTX_MARGIN;/);
  const gen = fnBody(m, 'async function generateMinutes', '\nfunction ensurePaster');
  assert.ok(gen.includes('const budget = sumCtxBudget();'), '予算を sumCtxBudget から取っていない');
  assert.ok(gen.includes('const fixed = estimateTokens(sys + memoBlock + minutesTemplate(type));'), '固定分（役割・メモ・書式）を推定していない');
  // 1 回で収まるかの判断は、文字数だけでなく推定トークンでも見る（文脈長を小さくしたとき溢れない）
  assert.ok(gen.includes('&& estimateTokens(plain) + fixed <= budget) {'), '1 回で収まるかの判断が推定トークンを見ていない');
  // 畳む: 束の分け方は mainlib.foldNotes、各束は分割要約と同じ経路（extractNotes・NOTE_MAX_TOKENS）
  const fold = fnBody(gen, 'if (need > budget) {', "if (onProgress) onProgress('議事録をまとめています…');");
  assert.ok(gen.includes("const need = estimateTokens(notes.join('\\n\\n')) + fixed;"), '統合プロンプトの推定が無い');
  assert.ok(fold.includes('foldNotes(notes, Math.max(1, budget - fixed), estimateTokens)'), '束の分け方を mainlib.foldNotes で決めていない');
  assert.ok(fold.includes("extractNotes((t) => extract(t, k, bundles.length, '要点メモ'), bundles[k].join('\\n\\n'))"), '束を分割要約と同じ経路で要約していない');
  assert.ok(gen.includes("extractNotes((t) => extract(t, i, chunks.length, '文字起こし'), chunks[i])"), '既存の分割要約が同じ extract を通っていない');
  assert.ok(fold.includes('束に畳んだ'), 'engineLog に「n パートを m 束に畳んだ」を残していない');
  assert.ok(fold.includes('engineLog('), 'engineLog に残していない');
  assert.ok(!fold.includes('summaryError') && !fold.includes('page.notes') && !fold.includes('truncatedParts'), 'summaryError / page.notes / 切れたパートの一覧に畳んだことを書いている');
  // 統合には畳んだ後の材料を渡す
  assert.ok(gen.includes("【会議の要点メモ（時系列）】\\n${material.join('\\n\\n')}"), '統合に畳んだ材料を渡していない');
  // llmChatP の呼び出しは 3 か所のまま（repo.test.js が数える）。畳みは extract を通る
  assert.strictEqual((gen.match(/await llmChatP\(/g) || []).length, 3);
});

// ---------------------------------------------------------------- #58 メモリ（判断）
const { idleEnginesToStop } = require('../src/mainlib');
const MIN = 60000;

test('idleEnginesToStop: 手が空いていて、起動していて、idleMin 分使われていないエンジンだけを選ぶ', () => {
  const now = 10_000_000;
  const w = { name: 'w', proc: {}, lastUsed: now - 10 * MIN };
  const s = { name: 's', proc: {}, lastUsed: now - 3 * MIN };
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 10, false), [w]);
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 3, false), [w, s], 'ちょうど idleMin 分でも止める');
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 11, false), []);
  // 忙しいときは何も止めない／0 = 止めない
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 10, true), []);
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 0, false), []);
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, -1, false), []);
  assert.deepStrictEqual(idleEnginesToStop([w, s], now, 'x', false), []);
});

test('idleEnginesToStop: 起動していない・準備完了を待っている人がいる・使った時刻が無い エンジンは止めない', () => {
  const now = 10_000_000;
  const off = { name: 'off', proc: null, lastUsed: now - 60 * MIN };
  const waiting = { name: 'wait', proc: {}, lastUsed: now - 60 * MIN, readyPromise: Promise.resolve(true) };
  const unknown = { name: 'unk', proc: {} };
  const idle = { name: 'idle', proc: {}, lastUsed: now - 60 * MIN, readyPromise: null };
  assert.deepStrictEqual(idleEnginesToStop([off, waiting, unknown, idle, null], now, 10, false), [idle]);
  assert.deepStrictEqual(idleEnginesToStop(undefined, now, 10, false), []);
});

// ---------------------------------------------------------------- #58 メモリ（結線）
test('#58 記録開始で要約エンジンを先読みしない（要約直前の ensureEngineReady に任せる）', () => {
  const m = code(main);
  const start = fnBody(m, 'function startMeeting()', '\nfunction stopMeeting');
  assert.ok(!start.includes('startEngine(sumEng)'), '記録開始で要約エンジンを起動している（約 3GB が上がったまま降りない）');
  // 第1c回 Task A-4（意図して変えた）: whisper の先読みは warmWhisper を通す（経路が手元のときだけ起こす。D1・F14）
  assert.ok(start.includes('warmWhisper('), '文字起こしエンジンの先読みまで消している');
  assert.ok(fnBody(m, 'async function generateMinutes', '\nfunction ensurePaster').includes('await ensureEngineReady(sumEng)'), '要約直前に用意していない');
  // 理由はコメントに残す
  assert.ok(/3GB/.test(fnBody(main, 'function startMeeting()', '\nfunction stopMeeting')), '先読みをやめた理由（約 3GB）がコメントに無い');
  // 起動時の whisper 先読みは今まで通り
  assert.ok(fnBody(m, 'app.whenReady().then(', '\n  });').includes('if (engineValid(whisperEng)) warmWhisper('));
  assert.ok(fnBody(m, 'async function warmWhisper(', '\n}').includes('ensureEngineReady(whisperEng)'));
});

test('#58 lastUsed は起動時と推論のたびに更新し、60 秒ごとに使われないエンジンを止める', () => {
  const m = code(main);
  assert.ok(fnBody(m, 'function makeEngine(name)', '\n}').includes('lastUsed: 0'), 'エンジンに lastUsed が無い');
  assert.match(m, /const touchEngine = \(eng\) => \{ eng\.lastUsed = Date\.now\(\); \};/);
  const start = fnBody(m, 'function startEngine(eng)', '\nfunction stopEngine');
  assert.ok(/eng\.proc = p;\s*\n\s*eng\.lastUsed = Date\.now\(\);/.test(start), '起動時に lastUsed を入れていない');
  assert.strictEqual((fnBody(m, 'async function transcribeLocal(', '\n}').match(/touchEngine\(whisperEng\)/g) || []).length, 2, '文字起こしの前後で lastUsed を更新していない');
  assert.strictEqual((fnBody(m, 'async function llmChat(', '\n}').match(/touchEngine\(sumEng\)/g) || []).length, 2, '要約の前後で lastUsed を更新していない');
  // 判断は mainlib.idleEnginesToStop。busy は isBusy()（idle・要約中でない・復旧中でない・待ち 0）
  const busy = fnBody(m, 'const isBusy = () => ', '\n');
  for (const k of ["state !== 'idle'", 'isSummarizing()', 'recoveryRunning', 'pendingSegs > 0']) assert.ok(busy.includes(k), `isBusy が ${k} を見ていない`);
  const rel = fnBody(m, 'function releaseIdleEngines()', '\n}');
  assert.ok(rel.includes('idleEnginesToStop([whisperEng, sumEng], Date.now(), settings.engineIdleMin, isBusy())'), '判断を mainlib.idleEnginesToStop で行っていない');
  assert.ok(rel.includes('stopEngine(eng)'), '止めていない');
  assert.ok(rel.includes('engineLog('), '止めたことをログに残していない');
  assert.match(m, /const ENGINE_IDLE_CHECK_MS = 60000;/);
  assert.ok(fnBody(m, 'app.whenReady().then(', '\n  });').includes('setInterval(releaseIdleEngines, ENGINE_IDLE_CHECK_MS)'), '60 秒ごとに見ていない');
});

test('#58 トレイに「エンジンを停止（メモリを解放）」があり、起動中かつ手が空いているときだけ押せる', () => {
  const m = code(main);
  const tray = fnBody(m, 'function updateTray()', '\nfunction createTray');
  assert.ok(tray.includes("label: 'エンジンを停止（メモリを解放）', enabled: (Boolean(whisperEng.proc) || Boolean(sumEng.proc)) && !isBusy(), click: stopEnginesFromTray"), 'トレイの項目が無いか条件が違う');
  const fn = fnBody(m, 'function stopEnginesFromTray()', '\n}');
  assert.ok(fn.includes('stopEngine(whisperEng)') && fn.includes('stopEngine(sumEng)'), '両方止めていない');
  // 起動・終了・停止のたびにトレイの有効／無効を追随させる（終了中は触らない）
  assert.match(m, /function engineChanged\(\) \{ if \(!quitting\) updateTray\(\); \}/);
  assert.ok(fnBody(m, 'function stopEngine(eng)', '\n}').includes('engineChanged()'), '停止でトレイを更新していない');
  assert.strictEqual((fnBody(m, 'function startEngine(eng)', '\nfunction stopEngine').match(/engineChanged\(\)/g) || []).length, 2, '起動と exit でトレイを更新していない');
});

// ---------------------------------------------------------------- 「エンジン：正常」（第0a回 R6。第1d回 A-13・D19 で画面の文は「PC の中の文字起こし：使えます」。main の答えの形は変えない）
test('engine:status は engineCheck の結果（とモデルの勧め）を返すだけで、エンジンを起動しない', () => {
  assert.ok(code(main).includes("ipcMain.handle('engine:status', () => ({ ok: true, whisper: engineCheck(whisperEng), sum: engineCheck(sumEng),\n    whisperNote: isKotobaModel() ? KOTOBA_NOTE : '' }));"));
  assert.ok(preload.includes("  engineStatus: () => ipcRenderer.invoke('engine:status'),"));
});

// ---------------------------------------------------------------- #54 貼り付け先の確認（判断）
const { pasterScript, parsePasterLine } = require('../src/mainlib');

test('pasterScript: fg（前面ウィンドウの HWND）と paste <hwnd>（同じなら貼る）の命令がある。P/Invoke は user32 の 1 つだけ', () => {
  const s = pasterScript();
  assert.ok(s.includes("-eq 'fg'"), 'fg の命令が無い');
  assert.ok(s.includes("StartsWith('paste ')"), 'paste <hwnd> の命令が無い');
  assert.ok(s.includes("-eq 'paste'"), '従来の paste（確認なし）が消えている');
  assert.ok(s.includes("StartsWith('copy ')"), 'copy が消えている');
  // P/Invoke: Add-Type -TypeDefinition で user32 の GetForegroundWindow を 1 つだけ
  assert.strictEqual((s.match(/Add-Type -TypeDefinition/g) || []).length, 1);
  assert.strictEqual((s.match(/DllImport/g) || []).length, 1, 'P/Invoke が 1 つでない');
  assert.ok(s.includes('user32.dll') && s.includes('GetForegroundWindow()'), 'user32 の GetForegroundWindow でない');
  // -Command の引数として渡すので、引用符の扱いで壊れないよう二重引用符は使わず、1 行に収める
  assert.ok(!s.includes('"'), '二重引用符がある（powershell.exe -Command の引数で壊れうる）');
  assert.ok(!s.includes('\n'), '改行がある');
  // HWND は 10 進で標準出力に 1 行。応答は ok / mismatch / fail
  assert.ok(s.includes('[Console]::Out.WriteLine([string][long]'), 'HWND を 10 進の文字列で出していない');
  for (const r of ["'ok'", "'mismatch'", "'fail'"]) assert.ok(s.includes(`[Console]::Out.WriteLine(${r})`), `応答 ${r} を標準出力に出していない`);
  // 前面が違えば何もしない（SendWait しない）。fg が取れなければ 0
  const branch = s.slice(s.indexOf("StartsWith('paste ')"), s.indexOf("StartsWith('copy ')"));
  assert.ok(branch.indexOf('-eq $l.Substring(6)') < branch.indexOf("SendWait('^v')"), '前面を確かめる前に貼っている');
  assert.ok(branch.includes("else { [Console]::Out.WriteLine('mismatch') }"), '違うときに mismatch を返していない');
  assert.ok(s.includes("catch { [Console]::Out.WriteLine('0') }"), 'fg が取れないときに 0 を返していない');
  // PS5.1 で動く書き方（既存の検査と同じ）
  assert.ok(!/\bswitch\b/.test(s) && !/ValidateSet/.test(s));
});

test('parsePasterLine: HWND（10 進）・ok・mismatch・fail を読み、それ以外は null。0 は「控えられなかった」', () => {
  assert.deepStrictEqual(parsePasterLine('1970442'), { kind: 'hwnd', value: '1970442' });
  assert.deepStrictEqual(parsePasterLine('1970442\r'), { kind: 'hwnd', value: '1970442' }, 'CRLF の \\r を落としていない');
  assert.deepStrictEqual(parsePasterLine('0'), { kind: 'hwnd', value: '' }, 'HWND 0（前面なし）を控えている');
  assert.deepStrictEqual(parsePasterLine('ok'), { kind: 'ok' });
  assert.deepStrictEqual(parsePasterLine('mismatch\r'), { kind: 'mismatch' });
  assert.deepStrictEqual(parsePasterLine(' fail '), { kind: 'fail' });
  assert.strictEqual(parsePasterLine(''), null);
  assert.strictEqual(parsePasterLine('Exception calling ...'), null);
  assert.strictEqual(parsePasterLine('12ab'), null);
  assert.strictEqual(parsePasterLine(null), null);
});

// ---------------------------------------------------------------- #54 貼り付け先の確認（結線）
test('#54 常駐 PowerShell の標準出力を行ごとに読み、命令ごとの応答を待てる', () => {
  const m = code(main);
  const ens = fnBody(m, 'function ensurePaster()', '\n}');
  assert.ok(ens.includes("stdio: ['pipe', 'pipe', 'ignore']"), '標準出力を pipe にしていない');
  assert.ok(ens.includes("p.stdout.on('data'"), '標準出力を読んでいない');
  assert.ok(ens.includes('parsePasterLine(line)'), '行の読み方を mainlib.parsePasterLine で行っていない');
  assert.ok(ens.includes('pasterWaiters.shift()'), '応答を待っている順（FIFO）に渡していない');
  assert.ok(ens.includes('w.resolve(null)'), 'PowerShell が居なくなったとき待っている人を解放していない');
  const ask = fnBody(m, 'function askPaster(cmd, timeoutMs)', '\n}');
  assert.ok(ask.includes('pasterWaiters.push(w)') && ask.includes('setTimeout(() => w.resolve(null), timeoutMs)'), '時間切れで null にしていない');
  assert.ok(ask.includes('p.stdin.write(`${cmd}\\n`)'), '命令を 1 行で送っていない');
  assert.match(m, /const FG_REPLY_MS = 300;/);
  assert.match(m, /const PASTE_REPLY_MS = 1500;/);
});

test('#54 録音開始で前面ウィンドウを控え、貼り付けは控えた HWND 付きで送る。違えば貼らずに知らせる', () => {
  const m = code(main);
  const start = fnBody(m, 'function startRecording()', '\n}');
  assert.ok(start.includes("dictationFg = askPaster('fg', FG_REPLY_MS).then((r) => (r && r.kind === 'hwnd' ? r.value : ''))"), '録音開始で fg を送って控えていない');
  const paste = fnBody(m, 'function simulatePaste(hwnd)', '\n}');
  assert.ok(paste.includes("askPaster(hwnd ? `paste ${hwnd}` : 'paste', PASTE_REPLY_MS)"), '控えた HWND があるとき paste <hwnd> で送っていない');
  assert.ok(paste.includes("resolve(r && r.kind !== 'hwnd' ? r.kind : 'unknown')"), "応答を 'ok'|'mismatch'|'fail'|'unknown' に直していない");
  assert.ok(paste.includes("resolve(err ? 'fail' : 'ok')"), '常駐が居ないときの一回きりの貼り付けが結果を返していない');
  assert.strictEqual((paste.match(/resolve\('unknown'\)/g) || []).length, 2, 'Windows 以外は unknown（従来どおり貼れたものとして扱う）');
  // deliverText の本体は mainlib へ移した（第0c回 EL1）。同じ文と順を mainlib で見る。main.js は薄い包み
  const lib = code(read('src/mainlib.js'));
  const deliver = fnBody(lib, 'async function deliverText(', '\n}');
  assert.ok(deliver.includes('const hwnd = await d.fg;'), '控えた HWND を使っていない');
  assert.ok(deliver.includes('const result = await d.simulatePaste(hwnd);'));
  assert.ok(deliver.includes("if (result === 'mismatch') { d.notice('貼り付け先が変わったため、クリップボードに残しました（Ctrl+V で貼り付けられます）'); return result; }"), 'mismatch の知らせ方が違う');
  assert.ok(deliver.includes("if (result === 'fail') { d.notice('自動貼り付けに失敗しました。クリップボードに残しています'); return result; }"), 'fail の知らせ方が違う');
  assert.ok(deliver.indexOf("result === 'fail'") < deliver.indexOf('restoreAfterPaste(prev, text)'), '貼れなかったのに元のクリップボードを戻している');
  assert.ok(deliver.indexOf('await copyPrivate(text, d)') < deliver.indexOf('d.simulatePaste(hwnd)'));
  assert.match(m, /fg: dictationFg,/, 'main が控えた HWND（dictationFg）を渡していない');
  assert.match(m, /notice: \(m\) => sendToMainWin\('app:notice', m\)/, 'main が知らせを画面へ送っていない');
});
