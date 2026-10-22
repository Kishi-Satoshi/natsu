/*
 * engine-main.test.js — main 側のエンジンまわりの守り（第0b回）
 *
 * RF2: main の中のグローバル fetch は 127.0.0.1 のエンジンへの呼び出しだけに使う。
 * 外への通信は Electron の net を使う（Node の fetch は Windows のプロキシ・PAC・
 * 証明書のストアを使わないため）。判断は src/mainlib.js に置いてここで動かし、
 * main.js が起動の最初にそれで包んでいるかを文字で見る。
 *
 * RF1: whisper-server は引数を ANSI（日本語の Windows では CP932）で受け、モデルのパスを UTF-8 として
 * 読み直して落ちる。エンジンを cwd = exe のフォルダで起動し、英数字以外のパスは相対にして渡す
 * （判断は mainlib.engineSpawnPlan。Linux でも path.win32 を渡して Windows の形で動かす）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
// コメントに一致して素通りしないよう、コメントを落としてから見る（stage3.main.test.js と同じ）
const code = (t) => String(t).replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const fnBody = (src, from, to) => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `${from} が無い`);
  const j = src.indexOf(to, i + from.length);
  return src.slice(i, j > 0 ? j : src.length);
};

const { isLoopbackUrl, loopbackOnlyFetch } = require('../src/mainlib');
test('RF2: main のグローバル fetch は 127.0.0.1・localhost・::1 だけ通す', async () => {
  for (const u of ['http://127.0.0.1:8990/health', 'http://localhost:1/x', 'http://[::1]:2/']) assert.ok(isLoopbackUrl(u), u);
  for (const u of ['https://huggingface.co/x', 'http://127.0.0.1.example.invalid/', 'http://10.0.0.1/', 'file:///C:/x', '', 'not a url']) assert.ok(!isLoopbackUrl(u), u);
  const seen = [];
  const f = loopbackOnlyFetch(async (u) => { seen.push(u); return 'ok'; });
  assert.strictEqual(await f('http://127.0.0.1:8991/v1/chat/completions'), 'ok');
  await assert.rejects(f('https://github.com/'), /Electron の net/);
  await assert.rejects(f({ url: 'https://huggingface.co/' }), /Electron の net/);
  assert.deepStrictEqual(seen, ['http://127.0.0.1:8991/v1/chat/completions']);
});
test('RF2: isLoopbackUrl は http: と https: だけ。ws:・ftp: などは 127.0.0.1・localhost・::1 でも偽', () => {
  for (const u of ['ws://127.0.0.1:1/', 'ftp://localhost/', 'wss://[::1]:2/']) assert.ok(!isLoopbackUrl(u), u);
  assert.ok(isLoopbackUrl('https://127.0.0.1:3/'));
});
test('RF2・#26: 読めない URL（ポートが 99999 など）は元の fetch に渡し、TypeError のまま返る', async () => {
  const g = loopbackOnlyFetch(globalThis.fetch);
  await assert.rejects(g('http://127.0.0.1:99999/health'), (e) => e instanceof TypeError && /URL/.test(e.message));
});
test('RF2: main.js は起動の最初にグローバル fetch を守りで包む', () => {
  const m = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const i = m.indexOf("globalThis.fetch = require('./mainlib').loopbackOnlyFetch(globalThis.fetch);");
  assert.ok(i > 0 && i < m.indexOf('function engineLog('), '守りが無いか、遅い');
});

const { engineSpawnPlan } = require('../src/mainlib');
const W = { whisper: true, p: path.win32 };
const ROOTJ = 'C:\\Users\\試験𠮷\\AppData\\Local\\natsu\\engine';
test('RF1: 日本語の利用者名のフォルダでも、whisper へ渡すモデルと VAD のパスは英数字だけ（cwd = exe のフォルダからの相対）', () => {
  const r = engineSpawnPlan(`${ROOTJ}\\whisper-1.9.5\\whisper-server.exe`,
    ['-m', `${ROOTJ}\\models\\ggml-large-v3-turbo-q5_0.bin`, '--host', '127.0.0.1', '--vad', '--vad-model', `${ROOTJ}\\models\\ggml-silero-v6.2.0.bin`], W);
  assert.strictEqual(r.problem, '');
  assert.strictEqual(r.cwd, `${ROOTJ}\\whisper-1.9.5`);
  assert.deepStrictEqual(r.args, ['-m', '..\\models\\ggml-large-v3-turbo-q5_0.bin', '--host', '127.0.0.1', '--vad', '--vad-model', '..\\models\\ggml-silero-v6.2.0.bin']);
  for (const a of r.args) assert.match(a, /^[\x20-\x7E]+$/, a);
});
test('RF1: 英数字だけのパスは今までどおり絶対パスのまま（cwd だけ exe のフォルダ）', () => {
  const r = engineSpawnPlan('D:\\eng\\bin\\Release\\whisper-server.exe', ['-m', 'D:\\eng\\ggml-large-v3-turbo-q5_0.bin'], W);
  assert.deepStrictEqual(r, { cwd: 'D:\\eng\\bin\\Release', args: ['-m', 'D:\\eng\\ggml-large-v3-turbo-q5_0.bin'], problem: '' });
});
test('RF1: 相対にしても日本語が残る（別のドライブ・ファイル名が日本語）なら起動せず、理由とパスを返す', () => {
  const a = engineSpawnPlan('C:\\e\\whisper-server.exe', ['-m', 'D:\\会議\\model.bin'], W);
  assert.match(a.problem, /英数字だけ/); assert.match(a.problem, /D:\\会議\\model\.bin$/);
  const b = engineSpawnPlan(`${ROOTJ}\\w\\whisper-server.exe`, ['-m', `${ROOTJ}\\models\\モデル.bin`], W);
  assert.match(b.problem, /英数字だけ/);
});
test('RF1: llama は日本語のパスもそのまま渡す（UTF-8 で読み直す）。cwd は exe のフォルダ', () => {
  const r = engineSpawnPlan('D:\\会議\\llama\\llama-server.exe', ['-m', 'E:\\会議\\q.gguf', '-c', '32768'], { whisper: false, p: path.win32 });
  assert.deepStrictEqual(r, { cwd: 'D:\\会議\\llama', args: ['-m', 'E:\\会議\\q.gguf', '-c', '32768'], problem: '' });
});
// 手で打った相対のパスは、アプリの今のフォルダから絶対にしてから決める。engineCheck（fs.statSync）が見るのは
// アプリの今のフォルダからのパスなので、cwd を exe のフォルダにしたまま渡すと、別のファイルを探してしまう
test('RF1: 相対のパスは、アプリの今のフォルダから絶対にしてから渡す（cwd を exe のフォルダにしても、engineCheck が見たのと同じファイル）', () => {
  const at = (cwd) => ({ ...path.win32, resolve: (...a) => path.win32.resolve(cwd, ...a) });
  const a = engineSpawnPlan('C:\\e\\bin\\whisper-server.exe', ['-m', 'models\\ggml-base.bin', '--vad-model', 'D:\\v\\silero.bin'], { whisper: true, p: at('D:\\app') });
  assert.deepStrictEqual(a, { cwd: 'C:\\e\\bin', args: ['-m', 'D:\\app\\models\\ggml-base.bin', '--vad-model', 'D:\\v\\silero.bin'], problem: '' });
  const b = engineSpawnPlan(`${ROOTJ}\\w\\whisper-server.exe`, ['-m', 'models\\ggml-base.bin'], { whisper: true, p: at(ROOTJ) });
  assert.deepStrictEqual(b.args, ['-m', '..\\models\\ggml-base.bin']);
  const c = engineSpawnPlan('C:\\l\\llama-server.exe', ['-m', 'q.gguf', '-c', '512'], { whisper: false, p: at('D:\\app') });
  assert.deepStrictEqual(c.args, ['-m', 'D:\\app\\q.gguf', '-c', '512']);
});
test('RF1・RF11: startEngine は engineSpawnPlan の引数と cwd で起動し、engineCheck は whisper の問題を返す', () => {
  const m = code(read('src/main.js'));
  const fn = fnBody(m, 'function startEngine(eng)', '\nfunction stopEngine');
  assert.ok(fn.includes('const plan = engineSpawnPlan(engineExe(eng), engineSpawnArgs(eng), { whisper: eng === whisperEng });'));
  assert.match(fn, /p = spawn\(engineExe\(eng\), plan\.args, \{ cwd: plan\.cwd, windowsHide: true,/);
  const chk = fnBody(m, 'function engineCheck(eng)', '\n}');
  assert.ok(chk.includes('if (plan.problem) return plan.problem;'));
  // whisper の形（{ whisper: true }）で見ないと、問題が出ないまま engine:status と起動テストを通り、文字起こしのたびに落ちる
  assert.ok(chk.includes('engineSpawnPlan(engineExe(eng), engineSpawnArgs(eng), { whisper: true })'), 'engineCheck が whisper の形で見ていない');
});

// RF4・RF3: Visual C++ ランタイムの版を exe のフォルダ → System32 の順に読み、止めるのは取り込んだ組だけ。
// 終了コード（0xC0000135 など）と spawn の失敗（EPERM・ENOENT など）を、何をすればよいかの文にする。
const { peFileVersion, vcRuntimeVersions, vcRuntimeIssue, runtimeGate, engineExitHint, spawnErrorHint } = require('../src/mainlib');
// >>> 0: 35211 << 16 は 32 ビットの符号付きでは負になり、writeUInt32LE が RangeError を投げる（計画の写しのままだと落ちる）
const ver = (a, b, c, d) => { const x = Buffer.alloc(4096); x.writeUInt32LE(0xFEEF04BD, 1000); x.writeUInt32LE(0x00010000, 1004);
  x.writeUInt32LE(((a << 16) | b) >>> 0, 1008); x.writeUInt32LE(((c << 16) | d) >>> 0, 1012); return x; };
const DLLS = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll'];
test('PE の版（VS_FIXEDFILEINFO）を読む。無ければ空', () => {
  assert.strictEqual(peFileVersion(ver(14, 44, 35211, 0)), '14.44.35211.0');
  assert.strictEqual(peFileVersion(Buffer.alloc(100)), '');
});
test('RF4: DLL は exe のフォルダを先に、無ければ System32 を読む', () => {
  const files = { 'D:\\e\\msvcp140.dll': ver(14, 51, 36247, 0), 'C:\\W\\S32\\msvcp140.dll': ver(14, 38, 33130, 0), 'C:\\W\\S32\\vcruntime140.dll': ver(14, 44, 35211, 0) };
  const v = vcRuntimeVersions('D:\\e', 'C:\\W\\S32', (f) => files[f] || null, path.win32);
  assert.deepStrictEqual(v, { 'msvcp140.dll': '14.51.36247.0', 'vcruntime140.dll': '14.44.35211.0', 'vcruntime140_1.dll': '', 'vcomp140.dll': '' });
});
test('RF4: 手で入れたエンジンが自分のフォルダに DLL を持っていれば、System32 に無くても ok', () => {
  const files = Object.fromEntries(DLLS.map((d) => [`D:\\e\\${d}`, ver(14, 51, 36247, 0)]));
  assert.strictEqual(vcRuntimeIssue(vcRuntimeVersions('D:\\e', 'C:\\W\\S32', (f) => files[f] || null, path.win32), { whisper: true }).level, 'ok');
});
test('RF4: 無い／14.40 未満は起動しない理由、14.40〜14.50 は記録だけ、14.51 以上は何も言わない。whisper は vcomp140 も見る', () => {
  const all = (v) => Object.fromEntries(DLLS.map((d) => [d, v]));
  assert.strictEqual(vcRuntimeIssue({ ...all('14.51.36247.0'), 'vcomp140.dll': '' }, { whisper: true }).level, 'missing');
  assert.strictEqual(vcRuntimeIssue({ ...all('14.51.36247.0'), 'vcomp140.dll': '' }, { whisper: false }).level, 'ok');
  assert.strictEqual(vcRuntimeIssue(all('14.38.33130.0'), { whisper: true }).level, 'old');
  assert.strictEqual(vcRuntimeIssue(all('14.44.35211.0'), { whisper: true }).level, 'warn');
  assert.strictEqual(vcRuntimeIssue(all('14.51.36247.0'), { whisper: true }).level, 'ok');
  assert.match(vcRuntimeIssue({}, { whisper: true }).message, /https:\/\/aka\.ms\/vc14\/vc_redist\.x64\.exe/);
});
test('RF4: 止めるのは取り込んだ組だけ。手で設定した組は、無くても古くても記録だけ（warn）', () => {
  const missing = vcRuntimeIssue({}, { whisper: true });
  assert.strictEqual(runtimeGate(missing, { managed: true }), 'block');
  assert.strictEqual(runtimeGate(missing, { managed: false }), 'warn');
  assert.strictEqual(runtimeGate({ level: 'old' }, { managed: false }), 'warn');
  assert.strictEqual(runtimeGate({ level: 'warn' }, { managed: true }), 'warn');
  assert.strictEqual(runtimeGate({ level: 'ok' }, { managed: true }), 'ok');
});
test('RF3・RF4: 終了コードと spawn の失敗を、やさしい案内にする', () => {
  assert.match(engineExitHint(3221225781, 500), /Visual C\+\+ ランタイム/);
  assert.match(engineExitHint(3221225785, 500), /古い/);
  assert.match(engineExitHint(3221225477, 3000), /古い/);
  assert.strictEqual(engineExitHint(3221225477, 60000), '');
  assert.match(engineExitHint(3221225501, 0), /CPU/);
  assert.match(engineExitHint(3221226505, 0), /異常終了/);
  assert.strictEqual(engineExitHint(1, 0), '');
  for (const c of ['EPERM', 'EACCES', 'UNKNOWN']) assert.match(spawnErrorHint(c, 'X.exe'), /Defender/);
  assert.match(spawnErrorHint('ENOENT', 'X.exe'), /保護の履歴/);
});
test('RF3: spawn の失敗の案内は、することを書いてから、そのファイルのパスを文末に置く（「次のファイル」が文末のパスを指す）', () => {
  for (const c of ['EPERM', 'EACCES', 'UNKNOWN']) {
    assert.match(spawnErrorHint(c, 'X.exe'), /情報システムの担当に、次のファイルの許可を頼んでください。今のパス: X\.exe$/, c);
  }
  const gone = spawnErrorHint('ENOENT', 'X.exe');
  assert.match(gone, /次のファイルを復元するか、情報システムの担当に頼んでください。今のパス: X\.exe$/);
  // パスが無いときは「次のファイル」と書かない（指す先が無い）
  for (const c of ['EPERM', 'ENOENT']) assert.ok(!spawnErrorHint(c, '').includes('次のファイル'), c);
});
test('main: 起動の前にランタイムを見て記録だけし（止めない）、exit・error・spawn の失敗に案内を足す（engineChanged の数は変えない）', () => {
  const m = code(read('src/main.js'));
  const fn = fnBody(m, 'function startEngine(eng)', '\nfunction stopEngine');
  assert.ok(fn.includes('engineRuntimeIssue(eng)') && fn.includes('engineExitHint(code') && fn.includes('spawnErrorHint('));
  assert.ok(!/runtimeGate\(/.test(fn), 'startEngine で止めている（手で入れたエンジンまで止まる）');
  assert.ok(fnBody(m, 'function engineRuntimeIssue(eng)', '\n}').includes('vcRuntimeVersions(path.dirname(engineExe(eng))'));
  assert.strictEqual((fn.match(/engineChanged\(\)/g) || []).length, 2);
  // runtimeGate を使わずに止める形（return・lastError）も見る。Linux では engineRuntimeIssue がいつも ok を返すので、
  // 動かして確かめられない。止めると、14.3x の PC で今動いている手で入れたエンジンまで止まる（RF4）
  const rt = fnBody(fn, 'const runtime = engineRuntimeIssue(eng);', "eng.lastError = ''; eng.ready = false;");
  assert.ok(!/\breturn\b|lastError\s*=/.test(rt), 'ランタイムで止めている（手で入れたエンジンまで止まる）');
  assert.strictEqual((fn.match(/engineRuntimeIssue\(/g) || []).length, 1, 'ランタイムを2か所で見ている');
  assert.ok(!/\bruntime\b/.test(fn.slice(fn.indexOf("eng.lastError = ''; eng.ready = false;"))), '後ろでランタイムを見て止めうる');
  // 版の行は、無い・古いときは起動のたびに、ok でも exe のパスごとに最初の1回は書く（実機の 13 で版を確かめる）
  assert.ok(/runtime\.level !== 'ok' \|\| !runtimeLogged\.has\(engineExe\(eng\)\)/.test(rt), 'ok の PC では版の行が1つも出ない（実機の 13）');
});
test('engine-smoke.js --start は、頭で4つの DLL の版を vcRuntimeVersions で読んでログに出す（RF4。続きからの確かめより前）', () => {
  const s = code(read('tools/engine-smoke.js'));
  assert.match(s, /require\('\.\.\/src\/mainlib'\)/);
  const fn = fnBody(s, 'async function start()', '\n}');
  assert.ok(fn.includes('runtimeVersions()'), '--start でランタイムの版を出していない');
  assert.ok(fn.indexOf('runtimeVersions()') < fn.indexOf('resumeCheck('), 'ランタイムの版が頭に無い');
  assert.ok(fnBody(s, 'function runtimeVersions()', '\n}').includes('vcRuntimeVersions('), 'vcRuntimeVersions で読んでいない');
});

// ---------------------------------------------------------------- 速さ（第0b回 Task 16）
// 利用者の「文字起こしと要約に時間がかかる」に対して、まず実際の速さを engine.log に残す。
// 取り込んだ llama にだけ、席を1つに・flash attention・考える手順を切る旗を渡す（手で設定した exe には渡さない。
// 古い llama-server は知らない旗で止まる）。要約の文脈長の既定は 16384（保存済みの値は書き換えない）。
const { speedLine } = require('../src/mainlib');
test('速さの1行: 文字起こしは音声と処理の秒と倍率、要約は読みと書きのトークンと秒。数でなければ空', () => {
  assert.strictEqual(speedLine('whisper', { audioMs: 65000, procMs: 43700 }), '文字起こしの速さ: 音声 65 秒・処理 44 秒（0.67 倍）');
  assert.match(speedLine('llama', { prompt_n: 5400, prompt_ms: 38200, predicted_n: 812, predicted_ms: 61000 }), /^要約の速さ: 読み 5400 トークン 38\.2 秒（141 トークン\/秒）・書き 812 トークン 61\.0 秒（13\.3 トークン\/秒）$/);
  for (const t of [undefined, null, {}, { prompt_n: 'x' }]) assert.strictEqual(speedLine('llama', t), '');
});
test('main: 区間と要約の後に速さを engine.log に残す（touchEngine の数は変えない）', () => {
  const m = code(read('src/main.js'));
  // 0.9.4 S-4（決めたこと 7）で意図して直した: 処理の時間は PC への要求の時間（transcribeLocal の onTimed）。無ければ今どおり t0 から
  assert.ok(m.includes("const pm = Number.isFinite(procMs) ? procMs : Date.now() - t0;"));
  assert.ok(m.includes("const sp = speedLine('whisper', { audioMs: durationMs, procMs: pm });"));
  const chat = fnBody(m, 'async function llmChat(', '\n}');
  assert.ok(chat.includes("const sp = speedLine('llama', data && data.timings);"));
  assert.strictEqual((chat.match(/touchEngine\(sumEng\)/g) || []).length, 2);
});
test('取り込んだ llama にだけ --cache-ram 0・-np 1・-fa on・--reasoning off を渡す（手で設定した exe には渡さない。mmproj は渡さない）', () => {
  const args = fnBody(code(read('src/main.js')), 'function engineSpawnArgs(eng)', '\n}');
  assert.ok(args.includes("...(manualGroup(eng) ? [] : ['--cache-ram', '0', '-np', '1', '-fa', 'on', '--reasoning', 'off'])"));
  assert.ok(args.includes("'-c', String(settings.sumCtx),"));
  assert.ok(!/mmproj/.test(args), '画像の部品を読ませている');
});
test('要約の文脈長の既定は 16384（main の既定と、壊れた値を戻す先）。保存済みの値は書き換えない', () => {
  const { normalizeSettings } = require('../src/settings');
  // 意図: main の既定の文脈長は 16384。既定は settings.js の defaultSettings から作る（第1a回 Task 2-2）
  assert.ok(code(read('src/main.js')).includes('const DEFAULT_SETTINGS = defaultSettings(os.cpus().length);'), 'main が settings.js の既定を使っていない');
  assert.strictEqual(require('../src/settings').defaultSettings(8).sumCtx, 16384, '既定の文脈長が 16384 でない');
  assert.strictEqual(normalizeSettings({}, {}).sumCtx, 16384);
  assert.strictEqual(normalizeSettings({ sumCtx: 'x' }, { sumCtx: 16384 }).sumCtx, 16384);
  assert.strictEqual(normalizeSettings({ sumCtx: 32768 }, { sumCtx: 16384 }).sumCtx, 32768, '保存済みの値を書き換えた');
});
test('engine-smoke.js の llama も、取り込んだ llama と同じ旗で起動する', () => {
  const s = read('tools/engine-smoke.js');
  for (const f of ["'--cache-ram', '0'", "'-np', '1'", "'-fa', 'on'", "'--reasoning', 'off'"]) assert.ok(s.includes(f), f);
});

// ---------------------------------------------------------------- Task 13（設計 B・RF3・RF7）
// 詳細設定の実行ファイルとモデルが両方空の側は、この起動の中で exe と DLL を照らし終えた取り込んだ組を使う。
// 設定には書かない（画面の自動保存が空の欄の値で書き戻す競り合いを作らない）
test('設計 B: 実行ファイルとモデルが両方空の側だけ、取り込んだエンジンを使う。片方でも入っていれば手の設定', () => {
  const m = code(read('src/main.js'));
  assert.ok(m.includes('const manualGroup = (e) => (e === whisperEng ? Boolean(settings.localServerExe || settings.localModelPath) : Boolean(settings.sumServerExe || settings.sumModelPath));'));
  assert.ok(m.includes("const engineExe = (e) => (manualGroup(e) ? (e === whisperEng ? settings.localServerExe : settings.sumServerExe) : managedFile(e, 'exe'));"));
  // 0.9.4 S-7（決めたこと 21）で意図して直した: 取り込んだ組の PC で軽いモデルを選んだら、文字起こしのモデルだけを取り込んだ軽いモデルにする（手の組は今のまま）
  assert.ok(m.includes("const engineModel = (e) => (manualGroup(e) ? (e === whisperEng ? settings.localModelPath : settings.sumModelPath)\n  : ((e === whisperEng && altModelPath()) || managedFile(e, 'model')));"));
});
test('設計 B: VAD の自動の発見・kotoba の判定・-m は engineModel から（取り込んだモデルでも効く）', () => {
  const m = code(read('src/main.js'));
  assert.ok(fnBody(m, 'function resolveVadModel()', '\n}').includes("path.dirname(engineModel(whisperEng) || '')"));
  assert.ok(m.includes("const isKotobaModel = () => /kotoba/i.test(path.basename(engineModel(whisperEng) || ''));"));
  const args = fnBody(m, 'function engineSpawnArgs(eng)', '\n}');
  assert.strictEqual((args.match(/'-m', engineModel\(eng\),/g) || []).length, 2);
  assert.ok(!/settings\.(localModelPath|sumModelPath)/.test(args));
});
test('RF7: 取り込んでも settings を書かない（画面の自動保存との競り合いを作らない）', () => {
  const m = code(read('src/main.js'));
  for (const k of ['localServerExe', 'localModelPath', 'vadModelPath', 'sumServerExe', 'sumModelPath']) {
    assert.ok(!new RegExp(`settings\\.${k}\\s*=[^=]`).test(m), `${k} を main が書いている`);
  }
});
test('RF3: whenReady は 候補を読む → 今の起動の行（managed は空）→ 照らし の順。照らし終えてから managed に入れて起動し直す', () => {
  const m = code(read('src/main.js'));
  assert.ok(m.includes('let managed = { whisper: null, sum: null };'));
  const ready = fnBody(m, 'app.whenReady().then(', '\n  });');
  const a = ready.indexOf('engineInstall.managedCandidates('); const b = ready.indexOf('if (engineValid(whisperEng)) warmWhisper(');   // 第1c回 Task A-4 で先読みを warmWhisper に（意図して変えた）
  // 照らしは待たない。照らしの後の起動などで投げても unhandled にしないよう .catch を付ける（計画の 'verifyManagedAtStartup();' から、点検の指摘で変えた）
  const c = ready.indexOf('verifyManagedAtStartup().catch(');
  assert.ok(a > 0 && a < b && b < c, `順が違う: ${a} ${b} ${c}`);
  assert.ok(!/await\s+verifyManagedAtStartup/.test(ready), '照らしを待っている（窓やトレイが遅れる）');
  assert.ok(!/managed = /.test(ready.slice(0, b)), '照らす前に managed に入れている');
  const v = fnBody(m, 'async function verifyManagedAtStartup()', '\n}');
  const i1 = v.indexOf('await engineInstall.verifyCandidates(managedCands)'); const i2 = v.indexOf('managed = { whisper: v.whisper, sum: v.sum };'); const i3 = v.indexOf('restartEnginesIfNeeded();');
  assert.ok(i1 > 0 && i1 < i2 && i2 < i3, '照らす → 入れる → 起動し直す の順でない');
});
test('managedIssue: 確かめ中・壊れた・ランタイムで止める・まだ無い を返し、engineCheck の頭で見る', () => {
  const m = code(read('src/main.js'));
  const f = fnBody(m, 'function managedIssue(eng)', '\n}');
  for (const k of ["'checking'", "'broken'", 'runtimeGate(engineRuntimeIssue(eng), { managed: true })', '［PC の中の文字起こしを取り込む］']) assert.ok(f.includes(k), k);
  assert.ok(fnBody(m, 'function engineCheck(eng)', '\n}').includes('if (!manualGroup(eng) && ENGINE_HOME.supported) { const m = managedIssue(eng); if (m) return m; }'));
});
test('engine:fetch-status は読むだけ（通信しない・フォルダを作らない）。preload の名前がそろう', () => {
  const m = code(read('src/main.js'));
  assert.ok(m.includes("ipcMain.handle('engine:fetch-status', () => engineFetchStatus());"));
  const f = fnBody(m, 'async function engineFetchStatus()', '\n}');
  for (const k of ['request', 'mkdir', 'fetchFile', '.start(']) assert.ok(!f.includes(k), k);
  assert.ok(f.includes('engineInstall.statusOf(') && f.includes('engineInstall.freeBytesOf('));
  assert.ok(read('src/preload.js').includes("  engineFetchStatus: () => ipcRenderer.invoke('engine:fetch-status'),"));
});
test('RF4: 2 つの［起動テスト］は、engineCheck の前に覚えたランタイムの版を忘れて読み直す（担当が入れた後に起動し直さなくてよい。統合）', () => {
  const m = code(read('src/main.js'));
  for (const ch of ['app:test', 'app:test-sum']) {
    const h = fnBody(m, `ipcMain.handle('${ch}', async () => {`, '\n  });');
    const a = h.indexOf('forgetRuntimeIssues();'); const b = h.indexOf('engineCheck(');
    assert.ok(a > 0 && a < b, `${ch}: 読み直す前に engineCheck している（${a} ${b}）`);
  }
  assert.ok(fnBody(m, 'function forgetRuntimeIssues()', '\n}').includes('runtimeIssueCache.clear();'));
});
// 第1d回 A-13（D19）で意図して変えた: 設定のボタンの名前が［エンジンを取り込む］から［PC の中の文字起こしを取り込む］になったので、指す名前も変えた（理由の文の言い方は変えない）
test('未設定の文は、取り込める PC では［PC の中の文字起こしを取り込む］を指し、「未設定」の語は残す', () => {
  const w = fnBody(code(read('src/main.js')), 'function whisperProblem()', '\n}');
  assert.ok(w.includes('［PC の中の文字起こしを取り込む］') && (w.match(/未設定/g) || []).length >= 2);
});
test('mainrun は main.js を読む前に LOCALAPPDATA を一時フォルダ（日本語と 𠮷 の名前）に向ける（Windows の CI で本当のプロファイルの natsu\\engine を見ない）', () => {
  const r = code(read('test/helpers/mainrun.js'));
  const d = r.indexOf("const localAppData = path.join(tmp, '");
  const i = r.indexOf('process.env.LOCALAPPDATA = localAppData;');
  const j = r.indexOf("require(path.join(ROOT, 'src', 'main.js'));");
  assert.ok(d > 0 && d < i && i < j, `順が違う: ${d} ${i} ${j}`);
  assert.match(r.slice(d, r.indexOf('\n', d)), /𠮷/);
});

// ---------------------------------------------------------------- Task 14（R7-9・RF3・RF8・RF13）
// 画面のボタンから取り込みを動かし、記録や要約の邪魔をしない。新しい組は照らしてから、暇なときに切り替える
test('取り込みは Electron の net.request で行い、ready の後に作る。本物の時計・net.isOnline を使う', () => {
  const m = code(read('src/main.js'));
  assert.match(m, /net: electronNet,?\s*\n\} = require\('electron'\);/);
  const f = fnBody(m, 'function getEngineFetch()', '\n}');
  assert.ok(f.includes('request: (o) => electronNet.request(o)') && f.includes('isOnline: () => electronNet.isOnline()'));
  assert.ok(!/\bsleep\b/.test(f), 'テスト用の sleep を本番に渡している');
});
test('開始の受け口はすぐ返り（user: true）、ボタンの一時停止は利用者の一時停止', () => {
  const m = code(read('src/main.js'));
  assert.ok(m.includes("ipcMain.handle('engine:fetch-start', (_e, o) => getEngineFetch().start({ all: Boolean(o && o.all), user: true }));"));
  assert.ok(m.includes("ipcMain.handle('engine:fetch-pause', () => (engineFetch ? engineFetch.pause('user') : { ok: true }));"));
});
test('切り替えは 安い比べ → 照らす → もう一度暇かを見る → 替える → active を書く → 片付け の順。isBusy の中身は変えない。60 秒ごとにも拾う', () => {
  const m = code(read('src/main.js'));
  const f = fnBody(m, 'async function applyManagedWhenIdle()', '\n}');
  const at = ['if (isBusy() || meeting) return false;', 'sameShas(cands, managed)', 'await engineInstall.verifyCandidates(cands)',
    'if (isBusy() || meeting) return false;', 'managed = { whisper: v.whisper, sum: v.sum };', 'engineInstall.setActive(', 'restartEnginesIfNeeded();', 'cleanupManaged();'];
  let pos = -1;
  for (const k of at) { const i = f.indexOf(k, pos + 1); assert.ok(i > pos, `順が違う: ${k}`); pos = i; }
  assert.ok(fnBody(m, 'function releaseIdleEngines()', '\n}').includes('applyManagedWhenIdle();'));
  // fnBody は始めの文字列も含めて返す（stage3.main.test.js:23-28）
  assert.strictEqual(fnBody(m, 'const isBusy = () => ', '\n'), "const isBusy = () => state !== 'idle' || isSummarizing() || recoveryRunning || pendingSegs > 0;");
});
test('RF8: 片付けは両方のエンジンが止まっていて、起動の途中でもなく、暇なときだけ', () => {
  const f = fnBody(code(read('src/main.js')), 'function cleanupManaged()', '\n}');
  assert.ok(f.includes('canDelete: () => !whisperEng.proc && !whisperEng.startPromise && !sumEng.proc && !sumEng.startPromise && !isBusy()'));
});
test('RF3: 取り込んだエンジンが 0xC0000135 で落ちたら、自分のファイルを照らし直して取り直す', () => {
  const fn = fnBody(code(read('src/main.js')), 'function startEngine(eng)', '\nfunction stopEngine');
  assert.ok(fn.includes('3221225781') && fn.includes('onManagedCrash(eng)'));
  const c = fnBody(code(read('src/main.js')), 'async function onManagedCrash(eng)', '\n}');
  assert.ok(c.includes('verifyCandidates(') && c.includes('repair'));
});
test('記録中は取り込みを止めて待つ（hold）。終了の前に止める（利用者の一時停止にはしない）。取り込み中は眠らせない。起動のときは auto で', () => {
  const m = code(read('src/main.js'));
  assert.ok(fnBody(m, 'function getEngineFetch()', '\n}').includes('hold: () => Boolean(meeting)'));
  assert.ok(fnBody(m, "app.on('before-quit'", '\n  });').includes("if (engineFetch) engineFetch.pause('quit');"));
  // Q14（2026-10-17 に利用者が了承）: 取り込みで眠らせないのは、実際に取っている間（係の state が running）だけ。
  // 回線を待つ（waiting。何日も続きうる）・記録中で止める（held）・一時停止の間は眠らせてよい（記録・要約は今までどおり眠らせない）
  const pb = fnBody(m, 'function updatePowerBlock()', '\n}');
  // 0.7.0 の前に意図して変えた（第2a1回 M-4 の残り）: 締めの返事（議事録の DB）を待つ会議がある間も眠らせない
  assert.ok(pb.includes("const busy = state !== 'idle' || isSummarizing() || engineFetchDownloading() || finalizingPageIds.size > 0;"), pb);
  assert.ok(!pb.includes('engineFetchRunning()'), '回線を待つ間も眠らせない（running() を見ている）');
  assert.ok(m.includes('function engineFetchDownloading() { return Boolean(engineFetch && engineFetch.downloading()); }'));
  assert.ok(fnBody(m, 'function onEngineFetchState(s)', '\n}').includes('updatePowerBlock();'), '係の状態が変わっても省電力の抑止を見直さない');
  assert.ok(fnBody(m, 'app.whenReady().then(', '\n  });').includes('getEngineFetch().start({ auto: true })'));
});
test('終了の前の一時停止が投げても、要約の「中断された」の印とエンジンの停止は続ける。終了が始まった後は、起動のときの自動の取り込みを始めない（点検）', () => {
  const m = code(read('src/main.js'));
  const q = fnBody(m, "app.on('before-quit'", '\n  });');
  const a = q.indexOf("try { if (engineFetch) engineFetch.pause('quit'); } catch (_)");
  assert.ok(a > 0 && a < q.indexOf('要約が中断されました') && a < q.indexOf('stopEngine(whisperEng);'), '終了の前の一時停止を try で包んでいない');
  const t = fnBody(m, 'setTimeout(() => {\n      ', '\n    }, ENGINE_FETCH_AUTO_MS);');
  assert.ok(t.indexOf('if (quitting) return;') >= 0 && t.indexOf('if (quitting) return;') < t.indexOf('getEngineFetch().start({ auto: true })'), '終了の途中でも自動の取り込みを始める');
});
test('受け口と preload の名前がそろう（start・pause・open-dir・progress）', () => {
  const p = read('src/preload.js');
  for (const s of ["engineFetchStart: (o) => ipcRenderer.invoke('engine:fetch-start', o),", "engineFetchPause: () => ipcRenderer.invoke('engine:fetch-pause'),",
    "openEngineDir: () => ipcRenderer.invoke('engine:open-dir'),", "onEngineFetchProgress: (cb) => ipcRenderer.on('engine:fetch-progress', (_e, s) => cb(s)),"]) assert.ok(p.includes(s), s);
});
test('知らせ: 要約が使えるようになったら［要約を生成］を案内。取り込み中の未設定の文は「未設定」を残す', () => {
  const m = code(read('src/main.js'));
  assert.ok(fnBody(m, 'async function applyManagedWhenIdle()', '\n}').includes('［要約を生成］'));
  const w = fnBody(m, 'function whisperProblem()', '\n}');
  assert.ok(w.includes('取り込み中') && (w.match(/未設定/g) || []).length >= 2);
});

// 切り替えの判断（mainlib の純粋な関数。main.js はこれで決める）。計画の Task 14 の Interfaces の
// sameShas と、実装で足した「新しい組が照らしで合わなければ前の組を使い続ける」「取り直す項目」「片付けで消さないパス」「残りの分」
const { sameShas, keepPrevious, repairIdsOf, pathUsedBy, fetchMinutesLeft, candStamp } = require('../src/mainlib');
const SHA = (c) => c.repeat(64);
const candOf = (root, shas, { current = true, dir = 'whisper-1.9.5', model = 'w.bin', vad = 'vad.bin', p = path.win32 } = {}) => ({
  current, shas, dir: p.join(root, dir), exe: p.join(root, dir, 'whisper-server.exe'), model: p.join(root, 'models', model),
  ...(vad ? { vad: p.join(root, 'models', vad) } : {}) });
const MAN = { items: [
  { id: 'whisper-engine', group: 'whisper', kind: 'zip', sha256: SHA('a') },
  { id: 'whisper-vad', group: 'whisper', kind: 'file', role: 'vad', sha256: SHA('b') },
  { id: 'whisper-model', group: 'whisper', kind: 'file', role: 'model', sha256: SHA('c') },
  { id: 'sum-engine', group: 'sum', kind: 'zip', sha256: SHA('d') },
  { id: 'sum-model', group: 'sum', kind: 'file', role: 'model', sha256: SHA('e') },
] };
test('sameShas: SHA-256 の並び（大文字と小文字は同じ）で比べる。組が無いどうしは同じ。groups で見る組を絞れる', () => {
  const w = candOf(ROOTJ, [SHA('a'), SHA('b'), SHA('c')]);
  const W2 = candOf(ROOTJ, [SHA('A'), SHA('B'), SHA('C')]);
  assert.strictEqual(sameShas({ whisper: w, sum: null }, { whisper: W2, sum: null }), true);
  assert.strictEqual(sameShas({ whisper: null, sum: null }, { whisper: null, sum: null }), true);
  assert.strictEqual(sameShas({ whisper: w, sum: null }, { whisper: null, sum: null }), false);
  const w3 = candOf(ROOTJ, [SHA('a'), SHA('b'), SHA('f')]);
  assert.strictEqual(sameShas({ whisper: w, sum: null }, { whisper: w3, sum: null }), false);
  assert.strictEqual(sameShas({ whisper: w, sum: candOf(ROOTJ, [SHA('d')]) }, { whisper: w, sum: null }, ['whisper']), true);
  assert.strictEqual(sameShas({ whisper: w, sum: candOf(ROOTJ, [SHA('d')]) }, { whisper: w, sum: null }, ['sum']), false);
});
test('RF13: 新しい組が照らしで合わなければ、照らし済みの前の組を使い続ける。同じ並びの組や前の組が無い組は、照らしのまま（null）', () => {
  const old = candOf(ROOTJ, [SHA('a'), SHA('b'), SHA('9')], { current: false });
  const neu = candOf(ROOTJ, [SHA('a'), SHA('b'), SHA('c')]);
  const bad = [{ group: 'whisper', file: neu.model, why: 'changed' }];
  // 新しい組が合わない → 前の組（kept）
  const r = keepPrevious({ whisper: neu, sum: null }, { whisper: old, sum: null }, { whisper: null, sum: null, bad });
  assert.deepStrictEqual([r.whisper, r.sum, r.kept, r.bad], [old, null, ['whisper'], bad]);
  // 新しい組が合う → 新しい組
  const ok = keepPrevious({ whisper: neu, sum: null }, { whisper: old, sum: null }, { whisper: neu, sum: null, bad: [] });
  assert.deepStrictEqual([ok.whisper, ok.kept], [neu, []]);
  // 同じ並び（触られた・取り直した）で合わない → 使わない（RF3）
  const same = keepPrevious({ whisper: neu, sum: null }, { whisper: neu, sum: null }, { whisper: null, sum: null, bad });
  assert.deepStrictEqual([same.whisper, same.kept], [null, []]);
  // 前の組が無い → 使わない
  const none = keepPrevious({ whisper: neu, sum: null }, { whisper: null, sum: null }, { whisper: null, sum: null, bad });
  assert.deepStrictEqual([none.whisper, none.kept], [null, []]);
  // 候補が消えた（記録と合わない）→ 使わない（前の組にも戻さない）
  const gone = keepPrevious({ whisper: null, sum: null }, { whisper: old, sum: null }, { whisper: null, sum: null, bad: [] });
  assert.deepStrictEqual([gone.whisper, gone.kept], [null, []]);
});
test('RF3: 取り直す項目は、合わなかったファイルの項目だけ（DLL → zip・モデル・VAD）。今のピンに無い前の組の項目は入れない。分からなければ組の今のピンを全部', () => {
  const c = candOf(ROOTJ, [SHA('a'), SHA('b'), SHA('c')]);
  const dll = { group: 'whisper', file: path.win32.join(c.dir, 'ggml.dll'), why: 'changed' };
  assert.deepStrictEqual(repairIdsOf(MAN, { whisper: c }, [dll], ['whisper']), ['whisper-engine']);
  assert.deepStrictEqual(repairIdsOf(MAN, { whisper: c }, [{ group: 'whisper', file: c.model, why: 'missing' }, { group: 'whisper', file: c.vad, why: 'changed' }], ['whisper']),
    ['whisper-vad', 'whisper-model']);
  // 前の組（モデルだけ今のピンと違う）: 合わないのが前のモデルなら取り直せない（今のピンに無い）。DLL は今のピンの zip
  const old = candOf(ROOTJ, [SHA('a'), SHA('b'), SHA('9')], { current: false, model: 'w-old.bin' });
  assert.deepStrictEqual(repairIdsOf(MAN, { whisper: old }, [{ group: 'whisper', file: old.model, why: 'changed' }], ['whisper']), []);
  assert.deepStrictEqual(repairIdsOf(MAN, { whisper: old }, [{ group: 'whisper', file: path.win32.join(old.dir, 'whisper.dll'), why: 'missing' }], ['whisper']), ['whisper-engine']);
  // 照らしが例外で終わった（どのファイルか分からない）: 組の今のピンを全部（係が照らし直して、違うものだけ取る）
  assert.deepStrictEqual(repairIdsOf(MAN, { whisper: c }, [], ['whisper']), ['whisper-engine', 'whisper-vad', 'whisper-model']);
  // 頼まれた組だけ
  const s = candOf(ROOTJ, [SHA('d'), SHA('e')], { dir: 'llama-b11669', model: 's.gguf', vad: null });
  assert.deepStrictEqual(repairIdsOf(MAN, { whisper: c, sum: s }, [dll, { group: 'sum', file: s.model, why: 'changed' }], ['sum']), ['sum-model']);
  assert.deepStrictEqual(repairIdsOf(MAN, { whisper: null, sum: null }, [dll], ['whisper', 'sum']), []);
});
test('RF8: 片付けで消さないパス: 使っている組のフォルダの中・そのファイル・それらを中に持つフォルダ（大文字と小文字は区別しない）', () => {
  const c = candOf(ROOTJ, [SHA('a')]);
  const W = path.win32;
  for (const p of [c.dir, W.join(c.dir, 'ggml.dll'), c.model, c.vad, W.join(ROOTJ, 'models'), ROOTJ, c.dir.toUpperCase()]) {
    assert.strictEqual(pathUsedBy(p, [c, null], W), true, p);
  }
  for (const p of [W.join(ROOTJ, 'whisper-1.9.4'), `${c.dir}.old-1234.tmp`, W.join(ROOTJ, 'models', 'w-old.bin'), W.join(ROOTJ, 'llama-b11000'), '']) {
    assert.strictEqual(pathUsedBy(p, [c, null], W), false, p);
  }
  assert.strictEqual(pathUsedBy(c.dir, [], W), false);
});
test('candStamp: 候補の並びと、exe・DLL・モデルの大きさと更新時刻（読まない）。取り直されるか触られると変わる。無いファイルも印にする', () => {
  const c = { ...candOf(ROOTJ, [SHA('a'), SHA('b')]), checkFiles: [{ file: 'x.exe', size: 1, sha256: SHA('1') }, { file: 'x.dll', size: 2, sha256: SHA('2') }],
    models: [{ file: 'm.bin', size: 3, mtimeMs: 30 }] };
  const disk = { 'x.exe': { size: 1, mtimeMs: 10 }, 'x.dll': { size: 2, mtimeMs: 20 }, 'm.bin': { size: 3, mtimeMs: 30 } };
  const stat = (f) => { if (!disk[f]) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return disk[f]; };
  const a = candStamp(c, stat);
  assert.strictEqual(candStamp(c, stat), a);
  assert.strictEqual(candStamp(null, stat), '-');
  disk['x.dll'] = { size: 2, mtimeMs: 21 };   // 取り直された（同じ大きさ・新しい更新時刻）
  const b = candStamp(c, stat);
  assert.notStrictEqual(b, a);
  delete disk['m.bin'];                         // 消された
  assert.notStrictEqual(candStamp(c, stat), b);
  disk['m.bin'] = { size: 3, mtimeMs: 30 };
  assert.notStrictEqual(candStamp({ ...c, shas: [SHA('a'), SHA('c')] }, stat), candStamp(c, stat));   // 並びが違う
});
test('取り込み中の「あと約 N 分」: 組の残りと今の速さから（切り上げ・1 分から）。速さが分からない・残りが 0 なら null（分は出さない）', () => {
  const s = (bytesPerSec, items) => ({ bytesPerSec, items });
  const its = [{ group: 'whisper', size: 600e6, done: 100e6 }, { group: 'whisper', size: 900e6, done: 900e6 }, { group: 'sum', size: 5e9, done: 0 }];
  assert.strictEqual(fetchMinutesLeft(s(1e6, its), 'whisper'), 9);   // 500MB / 1MB/s = 500 秒 → 9 分
  assert.strictEqual(fetchMinutesLeft(s(100e6, its), 'whisper'), 1);
  assert.strictEqual(fetchMinutesLeft(s(1e6, its), 'sum'), 84);      // 5GB / 1MB/s = 5000 秒 → 84 分
  assert.strictEqual(fetchMinutesLeft(s(null, its), 'whisper'), null);
  assert.strictEqual(fetchMinutesLeft(s(1e6, its.map((i) => ({ ...i, done: i.size }))), 'whisper'), null);
  assert.strictEqual(fetchMinutesLeft(null, 'whisper'), null);
});
