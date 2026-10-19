/*
 * dbtmp.js — 一時フォルダの議事録の DB を開いて、閉じて、消す台（第2a1回 D-2。D-3a〜D-7 で足す）
 *
 *   tmpDb() → { file, dir, open(opts), raw(opts), done() }
 *     open(opts) … core.open({ sqlite, file, ...opts })。開いた接続を覚える
 *     raw(opts)  … 関数を1つも登録していない素の接続（opts は DatabaseSync にそのまま渡す。既定は書ける接続）
 *     done()     … 覚えた接続を全部閉じてからフォルダを消す（Windows で掴んだままにしない）
 * フォルダの名前には日本語と 𠮷（サロゲートの対）を入れる（RF1）。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite = require('node:sqlite');
const core = require('../../src/db/core');

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-db-議事録𠮷-'));
  const file = path.join(dir, 'natsu.db');
  const opened = [];
  return {
    file,
    dir,
    open(opts = {}) {
      const r = core.open({ sqlite, file, ...opts });
      if (r.db) opened.push(r.db);
      return r;
    },
    raw(opts = {}) {
      const d = new sqlite.DatabaseSync(file, opts);
      opened.push(d);
      return d;
    },
    done() {
      for (const d of opened) { try { d.close(); } catch (_) { /* 閉じ済み */ } }
      opened.length = 0;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

module.exports = { tmpDb };
