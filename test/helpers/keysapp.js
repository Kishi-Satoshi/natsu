/*
 * keysapp.js — test/stage140.win.test.js が本物の Electron で起こす小さなアプリ（0.14.0 EB-3・EB-3 直し: 計画 docs/plans/2026-10-26-140.md の R100・R109）
 * MAIN は main のファイルの文（一時フォルダに書く）・PAGE はその窓の頁。結果は NATSU_KEYS_OUT のファイルに JSON で書いて終わる。
 * Electron 44 の main では clipboard.readText()／writeText() が Promise を返す（設計書の EL1）ので、全部を待つ。
 * 止まったときは、待っていた段の名前を error に書く（「timeout: <段>」）。設定と控え（userData）は一時フォルダの中に置く（%APPDATA% に残さない）。
 * test/stage140.main.test.js が偽の electron（Promise のクリップボード）で、Linux でも最後まで走ることを見る。
 */
'use strict';

const MAIN = String.raw`'use strict';
const { app, BrowserWindow, Menu, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
app.setPath('userData', path.join(__dirname, 'userData'));   // %APPDATA%\natsu-keys を作らない
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
let step = 'start';   // 今待っている段（止まったときに書く）
const at = (s) => { step = s; };
let done = false;
let guard = null;
const finish = (code) => {
  if (done) return;
  done = true;
  clearTimeout(guard);
  try { fs.writeFileSync(process.env.NATSU_KEYS_OUT, JSON.stringify(out)); } catch (_) {}
  app.exit(code);
};
guard = setTimeout(() => { out.error = 'timeout: ' + step; finish(2); }, 40000);
app.whenReady().then(async () => {
  let was = null;
  try {
    at('menu');
    Menu.setApplicationMenu(null);   // NaTsu の main と同じ（src/main.js の whenReady の頭）
    out.menu = Menu.getApplicationMenu() === null;
    at('window');
    const w = new BrowserWindow({ show: true, width: 480, height: 320, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const wc = w.webContents;
    let loads = 0;
    wc.on('did-start-loading', () => { loads += 1; });
    at('load');
    await w.loadFile(path.join(__dirname, 'page.html'));
    w.show(); w.focus(); wc.focus();
    at('focus-emulation');
    try { wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (_) { /* 無くても窓のフォーカスで足りる */ }
    await wait(500);
    const js = (s) => wc.executeJavaScript(s);
    const key = async (keyCode, modifiers = []) => {
      wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await wait(300);
    };
    const type = async (s) => { for (const c of s) { wc.sendInputEvent({ type: 'char', keyCode: c }); await wait(60); } await wait(300); };
    at('clipboard-read');
    was = await clipboard.readText();
    at('type');
    await js("document.getElementById('t1').focus(), 1");
    await type('abc');
    out.typed = await js("document.getElementById('t1').value");
    at('undo');
    await key('Z', ['control']);
    out.undone = await js("document.getElementById('t1').value");
    at('copy');
    await js("(() => { const t = document.getElementById('t1'); t.value = 'xyz'; t.focus(); t.select(); return 1; })()");
    await clipboard.writeText('');
    await key('C', ['control']);
    out.copied = await clipboard.readText();
    at('paste');
    await js("document.getElementById('t2').focus(), 1");
    await key('V', ['control']);
    out.pasted = await js("document.getElementById('t2').value");
    at('reload');
    const before = loads;
    await key('R', ['control']);
    await wait(1200);
    out.reloaded = loads !== before;
    out.mark = await js('window.__natsuMark');
  } catch (e) { out.error = step + ': ' + String(e && e.message || e); }
  try { at('clipboard-restore'); if (typeof was === 'string') await clipboard.writeText(was); } catch (e) { if (!out.error) out.error = step + ': ' + String(e && e.message || e); }
  finish(0);
});
`;
const PAGE = '<!doctype html><meta charset="utf-8"><title>keys</title><input id="t1"><input id="t2"><script>window.__natsuMark = 1;</script>';

module.exports = { MAIN, PAGE };
