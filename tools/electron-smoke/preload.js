/*
 * preload.js — 小さなアプリの sandbox の窓の preload（第0c回 EL8）
 * main から口（'port'）をもらい、window.smoke.call(x) で子へ送って返事を待つ。
 * electron の contextBridge と ipcRenderer だけを使う（45 から sandbox の preload では Node の代わりの
 * 物（バッファや即時の時計）が無くなるため。第2a1回の DB の客も同じ形で書く。EL10）。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let port = null;
let gen = 0;                 // 口を受け取るたびに進む（main は、これが進んだのを見てから往復する）
const waiting = [];
ipcRenderer.on('port', (e) => {
  // 起こし直したときは新しい口に替える。古い口で待っている返事は来ないので断る
  for (const w of waiting.splice(0)) w.reject(new Error('口が替わった'));
  port = e.ports[0];
  gen += 1;
  port.onmessage = (m) => { const w = waiting.shift(); if (w) w.resolve(m.data); };
});

contextBridge.exposeInMainWorld('smoke', {
  call(x) {
    return new Promise((resolve, reject) => {
      if (!port) { reject(new Error('口がまだ無い')); return; }
      waiting.push({ resolve, reject });
      port.postMessage(x);
    });
  },
  hasPort() { return port !== null; },
  gen() { return gen; },
  // 第1a回 Task 3-3（確かめの 8）: sandbox: true の窓では、preload の process.sandboxed が真
  sandboxed: () => process.sandboxed === true,
});
