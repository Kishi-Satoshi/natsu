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
test('RF1・RF11: startEngine は engineSpawnPlan の引数と cwd で起動し、engineCheck は whisper の問題を返す', () => {
  const m = code(read('src/main.js'));
  const fn = fnBody(m, 'function startEngine(eng)', '\nfunction stopEngine');
  assert.ok(fn.includes('const plan = engineSpawnPlan(engineExe(eng), engineSpawnArgs(eng), { whisper: eng === whisperEng });'));
  assert.match(fn, /p = spawn\(engineExe\(eng\), plan\.args, \{ cwd: plan\.cwd, windowsHide: true,/);
  const chk = fnBody(m, 'function engineCheck(eng)', '\n}');
  assert.ok(chk.includes('if (plan.problem) return plan.problem;'));
});
