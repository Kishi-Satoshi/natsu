/*
 * bench.win.test.js — 0.9.4 Task S-7（計画 docs/plans/2026-10-22-094.md の決めたこと 19・持ち主の答え Q6）: 速さを測る読み上げの PowerShell を本物の Windows で回す
 * Windows でないときは、ファイルの頭で抜ける（test.skip にしない。ci.yml は飛ばしたテストを Linux で 0 件しか許さない）。
 * 日本語の声があれば 16kHz・モノラル・16 ビットの WAV（約 30 秒）を書き、無ければ novoice の1行（CI の英語の Windows は novoice）。どちらも 20 秒以内。
 * 出力は一時フォルダの中の名前（本当の名前を書かない）。済んだら消す。
 */
'use strict';
if (process.platform !== 'win32') return;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lib = require('../src/mainlib');

test('benchVoiceScript を powershell.exe で走らせると、日本語の声があれば 16kHz・モノラル・16 ビットの WAV（約 30 秒）を書き、無ければ novoice の1行。20 秒以内', { timeout: 25000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-bench-'));
  const out = path.join(dir, 'bench.wav');
  try {
    const t0 = Date.now();
    const lines = await new Promise((resolve, reject) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', lib.benchVoiceScript({ out, text: lib.BENCH_TEXT })], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let buf = '';
      let err = '';
      p.stdout.on('data', (d) => { buf += d; });
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (c) => (c === 0 ? resolve(buf.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) : reject(new Error(`powershell ${c}: ${err}`))));
    });
    assert.ok(Date.now() - t0 < 20000, `${Date.now() - t0} ms`);
    const last = lines.pop();
    assert.ok(last === 'ok' || last === 'novoice', JSON.stringify(lines));
    if (last === 'novoice') {
      assert.ok(!fs.existsSync(out), '声が無いのに WAV を書いた');
      return;
    }
    const b = fs.readFileSync(out);
    assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF');
    assert.strictEqual(b.readUInt16LE(22), 1, 'モノラルでない');
    assert.strictEqual(b.readUInt32LE(24), 16000, '16kHz でない');
    assert.strictEqual(b.readUInt16LE(34), 16, '16 ビットでない');
    const sec = (b.length - 44) / 32000;
    assert.ok(sec >= 15 && sec <= 60, `${sec} 秒`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
