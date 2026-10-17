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
test('main: 起動の前にランタイムを見て記録だけし（止めない）、exit・error・spawn の失敗に案内を足す（engineChanged の数は変えない）', () => {
  const m = code(read('src/main.js'));
  const fn = fnBody(m, 'function startEngine(eng)', '\nfunction stopEngine');
  assert.ok(fn.includes('engineRuntimeIssue(eng)') && fn.includes('engineExitHint(code') && fn.includes('spawnErrorHint('));
  assert.ok(!/runtimeGate\(/.test(fn), 'startEngine で止めている（手で入れたエンジンまで止まる）');
  assert.ok(fnBody(m, 'function engineRuntimeIssue(eng)', '\n}').includes('vcRuntimeVersions(path.dirname(engineExe(eng))'));
  assert.strictEqual((fn.match(/engineChanged\(\)/g) || []).length, 2);
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
  assert.ok(m.includes("const sp = speedLine('whisper', { audioMs: durationMs, procMs: Date.now() - t0 });"));
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
  assert.ok(code(read('src/main.js')).includes('\n  sumCtx: 16384,'), 'main の既定が 16384 でない');
  assert.strictEqual(normalizeSettings({}, {}).sumCtx, 16384);
  assert.strictEqual(normalizeSettings({ sumCtx: 'x' }, { sumCtx: 16384 }).sumCtx, 16384);
  assert.strictEqual(normalizeSettings({ sumCtx: 32768 }, { sumCtx: 16384 }).sumCtx, 32768, '保存済みの値を書き換えた');
});
test('engine-smoke.js の llama も、取り込んだ llama と同じ旗で起動する', () => {
  const s = read('tools/engine-smoke.js');
  for (const f of ["'--cache-ram', '0'", "'-np', '1'", "'-fa', 'on'", "'--reasoning', 'off'"]) assert.ok(s.includes(f), f);
});
