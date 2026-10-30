/*
 * stage140.win.test.js — 0.14.0 の Windows だけの確かめ（計画 docs/plans/2026-10-26-140.md の Task EB-3・EK-5。決めたこと 35・R24・F103）
 * 本物の Electron（node_modules の electron.exe。CI の electron-smoke のジョブが入れ、テスト全部をその Node で回す）で、NaTsu の main と同じく
 * アプリのメニューを外した（Menu.setApplicationMenu(null)）窓に本物のキー（sendInputEvent）を送り、メニューが無くても入力の欄の
 * Ctrl+Z（欄の中の戻し）・Ctrl+C／Ctrl+V が効き、Ctrl+R で読み直さず、Ctrl+W で窓が閉じない（EK-5）ことを見る。main.js が起きたときにメニューを外すことは
 * stage140.main.test.js が偽の Electron で見る。
 * Windows でないとき・Electron の本体が無いとき（CI の test のジョブは npm install をしない）は、ファイルの頭で抜ける（test.skip にしない。
 * ci.yml は飛ばしたテストを Linux で 0 件・Windows で 1 件しか許さない）。
 */
'use strict';
if (process.platform !== 'win32') return;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(EXE)) return;

// 小さなアプリ（一時フォルダに書く: test/helpers/keysapp.js。EB-3 直し: Electron 44 の Promise のクリップボードを待ち、止まった段を書く）
const { MAIN, PAGE } = require('./helpers/keysapp');
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

test('EB-3・EK-5・F103（決めたこと 35・36・R24）: アプリのメニューを外した窓で、入力の欄の Ctrl+Z は欄の中で戻り、Ctrl+C／Ctrl+V が効き、Ctrl+R で読み直さず、Ctrl+W で窓が閉じない', { timeout: 60000 }, async () => {
  // EB-3 直し（R109）: 前の版の小さなアプリが %APPDATA% に残した設定のフォルダを消す（この版からは userData を一時フォルダに置く）
  if (process.env.APPDATA) fs.rmSync(path.join(process.env.APPDATA, 'natsu-keys'), RM);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-keys-議事録𠮷-'));
  let child = null;
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'natsu-keys', main: 'main.js' }));
    fs.writeFileSync(path.join(dir, 'main.js'), MAIN);
    fs.writeFileSync(path.join(dir, 'page.html'), PAGE);
    const outFile = path.join(dir, 'out.json');
    const env = { ...process.env, NATSU_KEYS_OUT: outFile };
    delete env.ELECTRON_RUN_AS_NODE;   // electron-smoke はテストを ELECTRON_RUN_AS_NODE=1 で回す（子は本物のアプリとして起こす）
    let err = '';
    const code = await new Promise((resolve) => {
      child = spawn(EXE, [dir], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
      child.stderr.on('data', (c) => { err += c; });
      const t = setTimeout(() => { try { child.kill(); } catch (_) { /* 終わり済み */ } }, 50000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.ok(fs.existsSync(outFile), `小さなアプリが結果を書かない（終わりの番号 ${code}）: ${err.slice(0, 400)}`);
    const o = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.strictEqual(o.error, undefined, JSON.stringify(o));
    assert.strictEqual(o.menu, true, 'アプリのメニューが残っている');
    assert.strictEqual(o.typed, 'abc', `キーが欄に届かない: ${JSON.stringify(o)}`);
    assert.ok(o.undone.length < 3 && 'abc'.startsWith(o.undone), `Ctrl+Z が欄の中で戻らない: ${JSON.stringify(o)}`);
    assert.strictEqual(o.copied, 'xyz', `Ctrl+C が効かない: ${JSON.stringify(o)}`);
    assert.strictEqual(o.pasted, 'xyz', `Ctrl+V が効かない: ${JSON.stringify(o)}`);
    assert.strictEqual(o.reloaded, false, 'Ctrl+R で読み直した');
    assert.strictEqual(o.mark, 1, 'Ctrl+R で読み直した（印が消えた）');
    // EK-5（決めたこと 35・36・F103）: メニューが無いので Ctrl+W で窓は閉じない（既定のメニューの「閉じる」が無い）
    assert.strictEqual(o.closed, false, 'EK-5: Ctrl+W で窓が閉じた');
    assert.strictEqual(code, 0);
  } finally {
    // 子が残っていれば止めてから消す（Windows で掴んだままのファイルを消さない）
    if (child && child.exitCode === null && child.signalCode === null) {
      // EB-4 直し（R115）: 5 秒の待ちは子が終われば消す（テストの終わりを 5 秒引き延ばさない）
      await new Promise((resolve) => {
        const h = setTimeout(resolve, 5000);
        const end = () => { clearTimeout(h); resolve(); };
        child.once('exit', end);
        try { child.kill(); } catch (_) { end(); }
      });
    }
    fs.rmSync(dir, RM);
    if (process.env.APPDATA) fs.rmSync(path.join(process.env.APPDATA, 'natsu-keys'), RM);
  }
});
