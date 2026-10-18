/*
 * child.js — 小さなアプリの utilityProcess の子（第0c回 EL8）
 * 'crash' で終了コード 3 で落ちる。口（MessagePortMain）をもらったら、届いた値に node:sqlite の版を添えて返す。
 */
'use strict';

process.parentPort.on('message', (e) => {
  if (e.data === 'crash') process.exit(3);
  const [port] = e.ports;
  port.on('message', (m) => {
    let sqlite;
    try {
      const s = require('node:sqlite');
      const db = new s.DatabaseSync(':memory:');
      sqlite = db.prepare('select sqlite_version() v').get().v;
      db.close();
    } catch (err) { sqlite = 'ERR ' + err.message; }
    port.postMessage({ echo: m.data, sqlite });
  });
  port.start();
});
