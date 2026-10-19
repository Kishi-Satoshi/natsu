/*
 * no-trigram.js — 偽の utilityProcess の子の中で、議事録の DB（server.js）より先に読む（第2a1回 M-2b の --db-down）
 *
 * node:sqlite の DatabaseSync が trigram の全文検索の表を作れないようにする（trigram を持たない SQLite と同じ失敗）。
 * DB のプロセスの自分の確かめが通らず、DB は「使えない」（state failed）で起きる。子の中だけに効き、main とテストの接続には効かない。
 */
'use strict';

const sqlite = require('node:sqlite');

const exec = sqlite.DatabaseSync.prototype.exec;
sqlite.DatabaseSync.prototype.exec = function (sql) {
  if (/tokenize\s*=\s*'trigram'/i.test(String(sql))) throw Object.assign(new Error('no such tokenizer: trigram'), { code: 'ERR_SQLITE_ERROR' });
  return exec.call(this, sql);
};
