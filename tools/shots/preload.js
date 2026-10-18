/*
 * shots/preload.js — 画面を撮る窓の preload（第1a回 G2）。sandbox の preload なので electron の contextBridge と ipcRenderer だけを使う
 * （ほかのファイルは読めない。名前と止める時刻は main から sendSync でもらう）。
 *
 * - 本物の preload.js と同じ名前の偽の橋（window.koeApp・window.koeOverlay）を出す。名前は main が本物の preload.js から取る
 *   （screens.apiNamesOf）。koeApp の関数は ipcRenderer.invoke('shots:call', '<橋>.<名前>', …) で main の見本の答えを返し、
 *   ほかの橋（録音バー）の関数は本物と同じく送るだけ（ipcRenderer.send）。on… は ipcRenderer.on('shots:event:<橋>.<名前>', …) につなぐ。
 * - 画面の時計を止める（new Date()・Date.now() が FIXED_NOW）。contextBridge.executeInMainWorld で、画面の script より先に画面の世界で走る。
 * - マイクとスピーカーの名前を決まった見本にする（設定の画面は機器の名前を出すので、機械ごとに画面が変わらないように）。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const { apis, now } = ipcRenderer.sendSync('shots:apis');

contextBridge.executeInMainWorld({
  func: (t) => {
    const R = Date;
    class D extends R {
      constructor(...a) { super(...(a.length ? a : [t])); }
      static now() { return t; }
    }
    window.Date = D;
    // 機器の一覧と許可を決まった答えにする（本物の機器は見ない）
    const md = navigator.mediaDevices;
    if (md) {
      const devices = [
        { kind: 'audioinput', deviceId: 'default', groupId: 'g1', label: '既定 - マイク（見本）' },
        { kind: 'audioinput', deviceId: 'mic-sample-1', groupId: 'g1', label: 'マイク（見本）' },
        { kind: 'audiooutput', deviceId: 'default', groupId: 'g2', label: '既定 - スピーカー（見本）' },
      ];
      Object.defineProperty(md, 'enumerateDevices', { configurable: true, value: () => Promise.resolve(devices.map((d) => ({ ...d, toJSON() { return { ...d }; } }))) });
      Object.defineProperty(md, 'getUserMedia', { configurable: true, value: () => Promise.resolve({ getTracks: () => [] }) });
    }
  },
  args: [now],
});

for (const [bridge, names] of Object.entries(apis || {})) {
  const obj = {};
  for (const name of names) {
    const key = `${bridge}.${name}`;
    if (/^on[A-Z]/.test(name)) obj[name] = (cb) => { ipcRenderer.on(`shots:event:${key}`, (_e, ...a) => cb(...a)); };
    else if (bridge === 'koeApp') obj[name] = (...a) => ipcRenderer.invoke('shots:call', key, ...a);
    else obj[name] = () => { ipcRenderer.send('shots:send', key); };
  }
  contextBridge.exposeInMainWorld(bridge, obj);
}
