/*
 * help-tmp.js — ヘルプのテストの一時フォルダ（help-tmp.test.js で固める）
 *
 *   tmpDir(t, prefix) → os.tmpdir() の下に prefix で始まる新しいフォルダを作って返す。
 *     そのテスト t が終わると（通っても落ちても）中身ごと消す（t.after）。早く消したいときは呼んだ側で rmSync してよい。
 *     ヘルプのテストは help/assets（同梱の書体で約 7 MB）を写すので、残すと npm test のたびに数百 MB が溜まる。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

module.exports = { tmpDir };
