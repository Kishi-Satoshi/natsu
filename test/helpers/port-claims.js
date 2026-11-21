'use strict';
/*
 * port-claims.js — 場面（helpers/mainrun.js）が偽のエンジンに渡す空いたポートを選ぶ（mainrun.js の freePort をここへ移した）
 *
 * 偽のエンジン（子のプロセス）に渡す空いたポート。前は listen(0) で OS の一時ポート（Linux は 32768〜60999・Windows は 49152〜65535）を借りて
 * すぐ返していたが、返した後・子が待ち受ける前に、同じ機械の外向きの接続（中継の偽物への要求など。並べて回すほかの場面も）が一時ポートとして
 * そのポートを使うことがあり、偽のエンジンが EADDRINUSE で落ちた（CI run 39904812869 の ubuntu・stage094.main の S4・S5。0.9.4 の freePort の
 * Ruling と同じ原因）。一時ポートの範囲の外（20000〜31999）から選び、待ち受けられることを確かめてから返す（Windows の予約された範囲は EACCES で飛ばす）
 *
 * 0.17.1 R33（run 44842332022 の mutate-3。計画 docs/plans/2026-11-18-171.md）: 待ち受けられるかを見るだけでは、選んでから偽のエンジンが口を開く
 * までの間（stage094.main の「S4: 速さの数は PC への要求だけ」は、中継の 0.8 秒とエンジンの起動の 1 秒で約 2.5 秒）、そのポートは空いて見える。
 * その間に別の場面（並べて回すほかのテストのファイル・transcribe.e2e が先にまとめて取ったポート）が同じポートを選んで偽のエンジンを先に起こすと、
 * こちらの main はその偽物の /health と /inference に当たり（すぐ答える）、処理の時間が 1 秒になった。こちらの偽のエンジンは後で EADDRINUSE で落ちる。
 * だから、選んだポートに機械全体の印（os.tmpdir() の下の natsu-port-claims/<ポート>。中は持ち主の pid）を 'wx' で置き、印のあるポートは選ばない。
 * 印は持ち主のプロセスが終わるときに消す。消さずに落ちたプロセスの印（pid が居ない・STALE_MS より古い）は、次に選ぶ者が片付けて取る。
 *
 *  - freePort({ random }) … 空いたポートを選び、印を置いて返す。random は試験だけが差し替える（既定は Math.random）
 *  - claim(port)          … ポートに印を置く（置けたら true。ほかの居るプロセスの印・このプロセスが置いた印があれば false）
 * 環境変数: NATSU_PORT_CLAIM_DIR（印のフォルダ。テスト用）
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const PORT_LO = 20000;
const PORT_SPAN = 12000;
const STALE_MS = 30 * 60 * 1000;
const dirOf = () => process.env.NATSU_PORT_CLAIM_DIR || path.join(os.tmpdir(), 'natsu-port-claims');

const held = new Set();   // このプロセスが置いた印のファイル（終わるときに消す）
process.on('exit', () => { for (const f of held) { try { fs.unlinkSync(f); } catch (_) { /* noop */ } } });

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function claim(port) {
  const dir = dirOf();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { return false; }
  const f = path.join(dir, String(port));
  if (held.has(f)) return false;
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(f, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      held.add(f);
      return true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return false;
    }
    let pid = NaN;
    try { pid = Number(JSON.parse(fs.readFileSync(f, 'utf8')).pid); } catch (_) { /* 書いている途中か壊れた印 */ }
    let age = 0;
    try { age = Date.now() - fs.statSync(f).mtimeMs; } catch (_) { continue; }   // 持ち主が今消した: もう一度置く
    if (age > STALE_MS || (Number.isFinite(pid) ? !alive(pid) : age > 5000)) {
      try { fs.unlinkSync(f); } catch (_) { /* 別の者が先に片付けた */ }
      continue;
    }
    return false;
  }
  return false;
}
function release(port) {
  const f = path.join(dirOf(), String(port));
  if (!held.delete(f)) return;
  try { fs.unlinkSync(f); } catch (_) { /* noop */ }
}

const tryPort = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});
const freePort = async ({ random = Math.random } = {}) => {
  for (let i = 0; i < 200; i++) {
    const port = PORT_LO + Math.floor(random() * PORT_SPAN);
    if (!claim(port)) continue;
    if (await tryPort(port)) return port;
    release(port);
  }
  throw new Error('mainrun: 空いたポートが見つからない');
};

module.exports = { freePort, claim, release, tryPort, PORT_LO, PORT_SPAN, STALE_MS };
