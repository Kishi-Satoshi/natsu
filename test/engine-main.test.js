/*
 * engine-main.test.js — main 側のエンジンまわりの守り（第0b回）
 *
 * RF2: main の中のグローバル fetch は 127.0.0.1 のエンジンへの呼び出しだけに使う。
 * 外への通信は Electron の net を使う（Node の fetch は Windows のプロキシ・PAC・
 * 証明書のストアを使わないため）。判断は src/mainlib.js に置いてここで動かし、
 * main.js が起動の最初にそれで包んでいるかを文字で見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

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
test('RF2・#26: 読めない URL（ポートが 99999 など）は元の fetch に渡し、TypeError のまま返る', async () => {
  const g = loopbackOnlyFetch(globalThis.fetch);
  await assert.rejects(g('http://127.0.0.1:99999/health'), (e) => e instanceof TypeError && /URL/.test(e.message));
});
test('RF2: main.js は起動の最初にグローバル fetch を守りで包む', () => {
  const m = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
  const i = m.indexOf("globalThis.fetch = require('./mainlib').loopbackOnlyFetch(globalThis.fetch);");
  assert.ok(i > 0 && i < m.indexOf('function engineLog('), '守りが無いか、遅い');
});
