/*
 * door.js — Claude（MCP のプロセス）の書き込みの口（0.18.0 CW-2。計画 docs/plans/2026-11-18-180.md の決めたこと 1〜5・8・F230・F231。DB のプロセスの中だけで読む）
 *
 * DB のプロセスが、起動ごとに名前を変える名前付きパイプ（Windows。ほかの OS は一時フォルダの UNIX ソケット: テストの Linux）を1つ開き、
 * 起動ごとに作り直す合い言葉を、DB のフォルダの「扉の紙」natsu.door（文字の3行。JSON にしない）に置く。つないだ口は、握手（合い言葉）の後に
 * DB のプロセスの役の表へ役 mcp で入る（役は口を受けた側が付け、頼みの中で名乗っても変わらない）。main は口を作らず、頼みを中継しない。
 *
 * pipePath(platform, rand) → win32: '\\.\pipe\natsu-<24 字の16進>'、ほか: <一時フォルダ>/natsu-<24 字>.sock
 * doorText({ pipe, token, pid }) → 'pipe <pipe>\ntoken <64 字の16進>\npid <番号>\n'
 * parseDoor(text) → { pipe, token, pid } | null（3行の形・パイプの形・合い言葉の形のどれかが違えば null）
 * checkHello(line, token) → 真偽（{"hello":"<合い言葉>","v":1} の形だけ。比べは crypto.timingSafeEqual）
 * startDoor({ dataDir, onRequest, onOpen, onClose, log, platform, rand, limits, fs }) → { close() → Promise }
 *   受け口を開き、開けたら紙を書く（一時ファイル → fsync → 名前の変更。名前の変更が掴まれていれば snapshot の renameWaiting と同じに待つ。
 *   書けなければ合い言葉を持つ一時ファイルを消して口を閉じる: 点検 1 の CR49）。close で受け口と口を閉じ、紙を消す。
 *   1行に1つの JSON。最初の1行は握手だけ。合わない（形・合い言葉）・握手の前の頼み・helloMs までに握手が無い・1行が lineBytes を越えた・
 *   idleMs なにも来ない・送れずに溜まった分が outBytes を越えた（答えを読まない客: 点検 1 の CR50）ときは、答えずに切る。
 *   同時の口が conns を越えたら: 握手の前の口があれば、いちばん古いその口を切って新しい口を受け、全部が握手した口なら新しい口をすぐ切る（AQ37 (a)）。
 *   握手の後の1行は onRequest(port, data)（port は { postMessage(obj) }: 1行の JSON を書く）。JSON にできない行は bad-args を答える。
 *   onOpen(port)・onClose(port) は握手した口の出入り（DB のプロセスが役の表に入れる・外す）。
 *   記録（log）には数と符号だけ（合い言葉・パイプの名前・頼みの中身・パスは書かない）。
 * DOOR_NAME … 扉の紙の名前。TMP_RE … 扉の紙の一時ファイルの名前（natsu.door.<番号>.tmp。起動の頭で前の起動の物を消す）。
 * LIMITS … 既定の上限（1 行 1MB・口 4 つ・握手 2 秒・無言 60 秒・送れずに溜まった分 4MB）
 */
'use strict';

const nodeFs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('./snapshot');

const DOOR_NAME = 'natsu.door';
// outBytes（点検 1 の CR50）: 1 行の上限の 4 倍。答えを読む客なら大きな答えが数個重なっても届き、読まない客の分は DB のプロセスに溜め続けない
const LIMITS = Object.freeze({ lineBytes: 1024 * 1024, conns: 4, helloMs: 2000, idleMs: 60000, outBytes: 4 * 1024 * 1024 });
const TMP_RE = /^natsu\.door\.\d+\.tmp$/;
const WIN_PIPE_RE = /^\\\\\.\\pipe\\natsu-[0-9a-f]{24}$/;
const SOCK_RE = /^natsu-[0-9a-f]{24}\.sock$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const PID_RE = /^[1-9][0-9]{0,9}$/;

const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const codeOf = (e) => (e && typeof e.code === 'string' && e.code) || 'unknown';
const randHex = (rand, n) => Buffer.from(rand(n)).toString('hex');

function pipePath(platform = process.platform, rand = crypto.randomBytes) {
  const name = `natsu-${randHex(rand, 12)}`;
  return platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

// パイプの形: Windows の名前付きパイプか、絶対のパスの natsu-<24 字>.sock だけ（TCP の番地と港の形は通さない）
const pipeOk = (p) => typeof p === 'string' && (WIN_PIPE_RE.test(p) || (path.isAbsolute(p) && SOCK_RE.test(path.basename(p))));

function doorText({ pipe, token, pid }) {
  return `pipe ${pipe}\ntoken ${token}\npid ${pid}\n`;
}

function parseDoor(text) {
  if (typeof text !== 'string') return null;
  const m = /^pipe ([^\n]+)\ntoken ([^\n]+)\npid ([^\n]+)\n$/.exec(text);
  if (!m || !pipeOk(m[1]) || !TOKEN_RE.test(m[2]) || !PID_RE.test(m[3])) return null;
  return { pipe: m[1], token: m[2], pid: Number(m[3]) };
}

// 握手の行の合い言葉（形が違えば null）
function helloOf(line) {
  let v;
  try { v = JSON.parse(line); } catch (_) { return null; }
  if (!isObj(v) || Object.keys(v).length !== 2 || v.v !== 1 || typeof v.hello !== 'string' || !TOKEN_RE.test(v.hello)) return null;
  return v.hello;
}

function checkHello(line, token) {
  const h = helloOf(line);
  if (h === null || typeof token !== 'string' || !TOKEN_RE.test(token)) return false;
  return crypto.timingSafeEqual(Buffer.from(h, 'utf8'), Buffer.from(token, 'utf8'));
}

// 紙を書く: 一時ファイル → fsync → 名前の変更（半端な紙を読ませない）。名前の変更は掴まれていれば待ってやり直す（Windows のウイルス対策・索引づけ:
// snapshot の renameWaiting）。書けなければ一時ファイル（合い言葉を持つ）を消して投げる（点検 1 の CR49）
async function writeDoor(fs, dataDir, text, log) {
  const file = path.join(dataDir, DOOR_NAME);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (!(await S.renameWaiting(fs, tmp, file, S.RENAME_WAITS_SHORT, log))) throw Object.assign(new Error('rename'), { code: 'rename' });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) { /* 無い・消せない（次の起動の頭で消す） */ }
    throw e;
  }
}

function startDoor({ dataDir, onRequest, onOpen = () => {}, onClose = () => {}, log = () => {}, platform = process.platform, rand = crypto.randomBytes, limits = {}, fs = nodeFs } = {}) {
  const lim = { ...LIMITS, ...(isObj(limits) ? limits : {}) };
  const token = randHex(rand, 32);
  const pipe = pipePath(platform, rand);
  const paper = path.join(dataDir, DOOR_NAME);
  const socks = new Map();   // 口 → { hello }（入れた順: いちばん古い握手の前の口を探す）
  let closed = false;
  let wrote = false;
  const tooBig = (n) => n > lim.lineBytes;

  const server = net.createServer((sock) => {
    if (closed) { sock.destroy(); return; }
    if (socks.size >= lim.conns) {
      // AQ37 (a)（点検 1）: 握手の前の口がふさいでいれば、いちばん古いその口を切って受ける。全部が握手した口なら新しい口をすぐ切る
      const old = [...socks].find(([, v]) => !v.hello);
      if (!old) { log('DB: 書き込みの口 断った（数）'); sock.destroy(); return; }
      log('DB: 書き込みの口 断った（数）');
      old[0].destroy();
      socks.delete(old[0]);
    }
    const st = { hello: false };
    socks.set(sock, st);
    sock.unref();
    let buf = Buffer.alloc(0);
    let hello = false;
    let idle = null;
    const cut = (why) => { log(`DB: 書き込みの口 断った（${why}）`); sock.destroy(); };
    // 点検 1（CR50）: 送れずに溜まった分（sock.writableLength）が outBytes を越えたら切る（答えも changed も読まない客の分を溜め続けない）
    const port = { postMessage(obj) {
      if (sock.destroyed) return;
      try { sock.write(`${JSON.stringify(obj)}\n`); } catch (_) { return; /* 閉じた口 */ }
      if (sock.writableLength > lim.outBytes) cut('詰まり');
    } };
    const helloTimer = setTimeout(() => cut('時間'), lim.helloMs);
    helloTimer.unref();
    const touch = () => { if (idle) clearTimeout(idle); idle = setTimeout(() => cut('時間'), lim.idleMs); idle.unref(); };
    touch();
    sock.on('data', (chunk) => {
      if (sock.destroyed) return;
      touch();
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const at = buf.indexOf(10);
        if (at < 0) { if (tooBig(buf.length)) cut('大きさ'); return; }
        if (tooBig(at)) { cut('大きさ'); return; }
        const line = buf.subarray(0, at).toString('utf8').replace(/\r$/, '');
        buf = buf.subarray(at + 1);
        if (!hello) {
          if (!checkHello(line, token)) { cut(helloOf(line) === null ? '形' : '合い言葉'); return; }
          hello = true;
          st.hello = true;
          clearTimeout(helloTimer);
          log(`DB: 書き込みの口 つないだ（${socks.size}）`);
          onOpen(port);
          continue;
        }
        let data;
        try { data = JSON.parse(line); } catch (_) { port.postMessage({ id: null, ok: false, code: 'bad-args', retry: false }); continue; }
        onRequest(port, data);
        if (sock.destroyed) return;
      }
    });
    sock.on('error', () => { /* 切れた口（close が続く） */ });
    sock.on('close', () => {
      clearTimeout(helloTimer);
      if (idle) clearTimeout(idle);
      if (socks.get(sock) === st) socks.delete(sock);
      if (hello) onClose(port);
    });
  });
  server.on('error', (e) => log(`DB: 書き込みの口を開けない（${codeOf(e)}）`));
  server.unref();   // 口だけでプロセスを生かさない（DB のプロセスは parentPort で生きる。テストのプロセスも閉じ忘れの口で止まらない）
  if (platform !== 'win32') { try { fs.unlinkSync(pipe); } catch (_) { /* 無い */ } }
  server.listen(pipe, async () => {
    if (closed) return;
    const text = doorText({ pipe, token, pid: process.pid });
    try {
      await writeDoor(fs, dataDir, text, log);
    } catch (e) {
      log(`DB: 扉の紙を書けない（${codeOf(e)}）`);
      server.close();
      return;
    }
    if (closed) {   // 書いている間（名前の変更を待つ間）に閉じた: 自分の紙だけを消す（次の起動の紙は消さない）
      try { if (fs.readFileSync(paper, 'utf8') === text) fs.unlinkSync(paper); } catch (_) { /* 無い */ }
      return;
    }
    wrote = true;
    log('DB: 書き込みの口を開いた');
  });

  function close() {
    if (closed) return Promise.resolve();
    closed = true;
    for (const s of socks.keys()) s.destroy();
    if (wrote) {
      try { fs.unlinkSync(paper); } catch (e) { if (!e || e.code !== 'ENOENT') log(`DB: 扉の紙を消せない（${codeOf(e)}）`); }
    }
    return new Promise((resolve) => { try { server.close(() => resolve()); } catch (_) { resolve(); } });
  }
  return { close };
}

module.exports = { DOOR_NAME, TMP_RE, LIMITS, pipePath, doorText, parseDoor, checkHello, startDoor };
