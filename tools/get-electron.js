/*
 * get-electron.js — ソースから起動する人のための起動の助け（第0c回 EL5）
 *
 * Electron 42 から npm install では本体（electron.exe）が落ちてこない。
 * start-natsu.bat と create-shortcut.ps1 は、本体が無いときだけこれを呼ぶ。
 *   node tools/get-electron.js [<アプリのフォルダ>]   … 省略時は tools の1つ上
 *
 * - 本体があれば何もしない（0）。
 * - Node.js が 22.12 より古ければ、平易な文を出して止まる（3）。
 * - node_modules\electron が無ければ npm install を促す（2）。
 * - node_modules/electron/install.js を、今の node で走らせて本体を取り込む。
 *   npx install-electron は使わない（31 の包みには bin が無く、登録簿には同じ名前の別の包みがある）。
 *   取り込めなければ回線とプロキシの案内を出す（1）。
 *
 * 古い Node でも、案内を出す前に構文で落ちないよう var と function だけで書く。
 * コマンドとしての動きは require.main === module の中だけ（テストが require しても取り込みを走らせない）。
 */
'use strict';

var fs = require('fs');
var path = require('path');
var childProcess = require('child_process');

var MIN = [22, 12, 0];
var MSG_OLD = 'Node.js 22.12 以上を入れてください（今の Node.js は %s）。https://nodejs.org/ja から LTS 版を入れられます。';
var MSG_NOPKG = 'node_modules\\electron がありません。先にこのフォルダで npm install を実行してください。';
var MSG_FAIL = 'Electron の本体を取り込めませんでした。回線を確かめて、もう一度実行してください。社内のプロキシの中では、先に setx NODE_USE_SYSTEM_CA 1 を実行して開き直してください（Node.js 22.19 以上で効きます）。';
var MSG_START = 'Electron の本体を取り込んでいます（初めの1回だけ。150MB ほど）…';
var MSG_DONE = '取り込みました。';

// 'v22.12.1' や '22.12.0' を 3 つの数で比べ、MIN 以上なら真。読めなければ偽。
function nodeOk(version) {
  var parts = String(version == null ? '' : version).replace(/^v/, '').split('.');
  for (var i = 0; i < MIN.length; i++) {
    var n = i < parts.length && /^\d+$/.test(parts[i]) ? parseInt(parts[i], 10) : NaN;
    if (i === 0 && isNaN(n)) return false;
    if (isNaN(n)) n = 0;
    if (n > MIN[i]) return true;
    if (n < MIN[i]) return false;
  }
  return true;
}

function electronExe(root, platform) {
  return path.join(root, 'node_modules', 'electron', 'dist', platform === 'win32' ? 'electron.exe' : 'electron');
}

// d = { version, platform, exists(p), run(script) → 終了コード, log(line) } → 終了コード
function getElectron(root, d) {
  var exe = electronExe(root, d.platform);
  if (d.exists(exe)) return 0;
  if (!nodeOk(d.version)) {
    d.log(MSG_OLD.replace('%s', String(d.version)));
    return 3;
  }
  var script = path.join(root, 'node_modules', 'electron', 'install.js');
  if (!d.exists(script)) {
    d.log(MSG_NOPKG);
    return 2;
  }
  d.log(MSG_START);
  var code = d.run(script);
  if (code !== 0 || !d.exists(exe)) {
    d.log(MSG_FAIL);
    return 1;
  }
  d.log(MSG_DONE);
  return 0;
}

module.exports = { nodeOk: nodeOk, electronExe: electronExe, getElectron: getElectron, MIN: MIN, MSG_OLD: MSG_OLD, MSG_NOPKG: MSG_NOPKG, MSG_FAIL: MSG_FAIL };

if (require.main === module) {
  var root = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, '..');
  process.exitCode = getElectron(root, {
    version: process.versions.node,
    platform: process.platform,
    exists: function (p) { return fs.existsSync(p); },
    run: function (script) {
      var r = childProcess.spawnSync(process.execPath, [script], { stdio: 'inherit', cwd: path.dirname(script) });
      return r.status === null ? 1 : r.status;
    },
    log: function (line) { console.log(line); }
  });
}
