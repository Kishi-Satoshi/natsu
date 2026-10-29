/*
 * stage140.win.test.js — 0.14.0 の Windows だけの確かめ（計画 docs/plans/2026-10-26-140.md の Task EB-3・EK-5。決めたこと 35・R24・F103）
 * 本物の Electron（node_modules の electron.exe。CI の electron-smoke のジョブが入れ、テスト全部をその Node で回す）で、NaTsu の main と同じく
 * アプリのメニューを外した（Menu.setApplicationMenu(null)）窓に本物のキー（sendInputEvent）を送り、メニューが無くても入力の欄の
 * Ctrl+Z（欄の中の戻し）・Ctrl+C／Ctrl+V が効き、Ctrl+R で読み直さないことを見る。main.js が起きたときにメニューを外すことは
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

// 小さなアプリ（一時フォルダに書く）。結果は NATSU_KEYS_OUT のファイルに JSON で書いて終わる
const MAIN = String.raw`'use strict';
const { app, BrowserWindow, Menu, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
const finish = (code) => { try { fs.writeFileSync(process.env.NATSU_KEYS_OUT, JSON.stringify(out)); } catch (_) {} app.exit(code); };
setTimeout(() => { out.error = 'timeout'; finish(2); }, 40000);
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);   // NaTsu の main と同じ（src/main.js の whenReady の頭）
  out.menu = Menu.getApplicationMenu() === null;
  const w = new BrowserWindow({ show: true, width: 480, height: 320, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const wc = w.webContents;
  let loads = 0;
  wc.on('did-start-loading', () => { loads += 1; });
  await w.loadFile(path.join(__dirname, 'page.html'));
  w.show(); w.focus(); wc.focus();
  try { wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (_) { /* 無くても窓のフォーカスで足りる */ }
  await wait(500);
  const js = (s) => wc.executeJavaScript(s);
  const key = async (keyCode, modifiers = []) => {
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    await wait(300);
  };
  const type = async (s) => { for (const c of s) { wc.sendInputEvent({ type: 'char', keyCode: c }); await wait(60); } await wait(300); };
  const was = clipboard.readText();
  try {
    await js("document.getElementById('t1').focus(), 1");
    await type('abc');
    out.typed = await js("document.getElementById('t1').value");
    await key('Z', ['control']);
    out.undone = await js("document.getElementById('t1').value");
    await js("(() => { const t = document.getElementById('t1'); t.value = 'xyz'; t.focus(); t.select(); return 1; })()");
    clipboard.writeText('');
    await key('C', ['control']);
    out.copied = clipboard.readText();
    await js("document.getElementById('t2').focus(), 1");
    await key('V', ['control']);
    out.pasted = await js("document.getElementById('t2').value");
    const before = loads;
    await key('R', ['control']);
    await wait(1200);
    out.reloaded = loads !== before;
    out.mark = await js('window.__natsuMark');
  } catch (e) { out.error = String(e && e.message || e); }
  clipboard.writeText(was);
  finish(0);
});
`;
const PAGE = '<!doctype html><meta charset="utf-8"><title>keys</title><input id="t1"><input id="t2"><script>window.__natsuMark = 1;</script>';

test('EB-3・F103（決めたこと 35・R24）: アプリのメニューを外した窓で、入力の欄の Ctrl+Z は欄の中で戻り、Ctrl+C／Ctrl+V が効き、Ctrl+R で読み直さない', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-keys-議事録𠮷-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'natsu-keys', main: 'main.js' }));
    fs.writeFileSync(path.join(dir, 'main.js'), MAIN);
    fs.writeFileSync(path.join(dir, 'page.html'), PAGE);
    const outFile = path.join(dir, 'out.json');
    const env = { ...process.env, NATSU_KEYS_OUT: outFile };
    delete env.ELECTRON_RUN_AS_NODE;   // electron-smoke はテストを ELECTRON_RUN_AS_NODE=1 で回す（子は本物のアプリとして起こす）
    let err = '';
    const code = await new Promise((resolve) => {
      const p = spawn(EXE, [dir], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
      p.stderr.on('data', (c) => { err += c; });
      const t = setTimeout(() => { try { p.kill(); } catch (_) { /* 終わり済み */ } }, 50000);
      p.on('exit', (c) => { clearTimeout(t); resolve(c); });
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
    assert.strictEqual(code, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
