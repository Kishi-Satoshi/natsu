/*
 * newpopapp.js — test/stage150.win.test.js が本物の Electron で起こす小さなアプリ（0.15.0 PH-5。計画 docs/plans/2026-11-03-150.md の Task PH-5・決めたこと 28・BQ7 (a)）
 * MAIN は main のファイルの文・PRELOAD は窓の preload の文（どちらも一時フォルダに書く）。窓は NaTsu の本物の画面（src/renderer/app.html）を、
 * NaTsu の main と同じくアプリのメニューを外して（Menu.setApplicationMenu(null)）開く。橋（window.koeApp ほか）は偽物で、名前は本物の preload.js から
 * テストが取り（tools/shots/screens.js の apiNamesOf）、答えは撮る道具の見本（fixtures）を cfg.json で受ける（tools/shots/preload.js と同じ考え）。
 * 窓に本物の Ctrl+Shift+N（sendInputEvent）を送り、新しい窓が開かず、画面の「新しいページ」の選び（#newPop）が出ることを NATSU_NEWPOP_OUT に JSON で書く。
 * 止まったときは、待っていた段の名前を error に書く（「timeout: <段>」）。設定（userData）は一時フォルダの中に置く。
 */
'use strict';

const MAIN = String.raw`'use strict';
const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
app.setPath('userData', path.join(__dirname, 'userData'));   // %APPDATA% に残さない
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'cfg.json'), 'utf8'));   // { html, apis, answers }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
let step = 'start';
const at = (s) => { step = s; };
let done = false;
let guard = null;
const finish = (code) => {
  if (done) return;
  done = true;
  clearTimeout(guard);
  try { fs.writeFileSync(process.env.NATSU_NEWPOP_OUT, JSON.stringify(out)); } catch (_) {}
  app.exit(code);
};
guard = setTimeout(() => { out.error = 'timeout: ' + step; finish(2); }, 40000);
let created = 0;
app.on('browser-window-created', () => { created += 1; });
app.on('window-all-closed', () => {});   // 窓が閉じても結果を書いてから終える
ipcMain.on('np:apis', (e) => { e.returnValue = cfg.apis; });
ipcMain.handle('np:call', (_e, key) => (Object.prototype.hasOwnProperty.call(cfg.answers, key) ? cfg.answers[key] : { ok: true }));
app.whenReady().then(async () => {
  try {
    at('menu');
    Menu.setApplicationMenu(null);   // NaTsu の main と同じ（src/main.js の whenReady の頭）
    out.menu = Menu.getApplicationMenu() === null;
    at('window');
    const w = new BrowserWindow({ show: true, width: 1120, height: 780,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const wc = w.webContents;
    at('load');
    await w.loadFile(cfg.html);
    w.show(); w.focus(); wc.focus();
    at('focus-emulation');
    try { wc.debugger.attach('1.3'); await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch (_) { /* 無くても窓のフォーカスで足りる */ }
    await wait(1500);
    const js = (s) => wc.executeJavaScript(s);
    at('ready');
    out.before = BrowserWindow.getAllWindows().length;
    out.hiddenBefore = await js("document.getElementById('newPop').hidden");
    at('key');
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control', 'shift'] });
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['control', 'shift'] });
    await wait(1200);
    at('read');
    out.windows = BrowserWindow.getAllWindows().length;
    out.created = created;
    out.shown = await js("!document.getElementById('newPop').hidden");
    out.items = JSON.parse(await js("JSON.stringify([...document.querySelectorAll('#newList .mitem')].map((b) => b.textContent))"));
    out.icons = JSON.parse(await js("JSON.stringify([...document.querySelectorAll('#newList .mitem')].map((b) => (b.querySelector('.pgi') || { getAttribute: () => null }).getAttribute('data-icon')))"));   // 0.17.0 IV-1
    out.focusIn = await js("document.getElementById('newList').contains(document.activeElement)");
  } catch (e) { out.error = step + ': ' + String(e && e.message || e); }
  finish(0);
});
`;

// 偽の橋（sandbox の preload なので electron の contextBridge と ipcRenderer だけ）。koeApp の関数は main の見本の答え、ほかの橋と on… は何もしない
const PRELOAD = String.raw`'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const apis = ipcRenderer.sendSync('np:apis');
for (const [bridge, names] of Object.entries(apis || {})) {
  const obj = {};
  for (const name of names) {
    const key = bridge + '.' + name;
    if (/^on[A-Z]/.test(name)) obj[name] = () => {};
    else if (bridge === 'koeApp') obj[name] = () => ipcRenderer.invoke('np:call', key);
    else obj[name] = () => {};
  }
  contextBridge.exposeInMainWorld(bridge, obj);
}
`;

module.exports = { MAIN, PRELOAD };
