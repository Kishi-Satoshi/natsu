'use strict';
/*
 * door.js — MCP のプロセスの、書き込みの口（扉）の客（0.18.0 CT-4。計画 docs/plans/2026-11-18-180.md の決めたこと 5・7・8・F230・F231）
 *
 * NaTsu の DB のプロセスが起動ごとに開く名前付きパイプ（ほかの OS では一時フォルダの UNIX ソケット: テストの Linux）に、扉の紙 natsu.door の合い言葉で
 * 握手してから、書く命令を1つ頼む。MCP のプロセスは natsu.db を書ける形で開かない（読む道具は今どおり reader の読み取りだけの接続）。
 * src/mcp/ で node:net を読むのはこのファイルだけ。つなぐのは net.connect({ path }) だけで、口を開かない（listen・createServer を書かない）。
 * 扉の紙を読むのもこのファイルだけ（MCP のプロセスが読むファイルは natsu.db・natsu.db.lock・natsu.door の3つ）。
 *
 * readDoor(dataDir, fs) → { pipe, token } | null（紙が無い・読めない・3行の形・パイプの形（Windows の \\.\pipe\natsu-<24 字> か、絶対のパスの
 *   natsu-<24 字>.sock）・合い言葉の形のどれかが違えば null。TCP の番地と港の形は通さない: F231）
 * isNetworkDir(dataDir) → 真偽（DB のフォルダがネットワークの場所: DB のプロセスは口を開かず紙も書かない。AQ36 (a)。src/netPath.js の1か所）
 * newTx(now, rand) → 'c:<時刻の36進>:<8 字の16進>'（道具の呼び出しごとに1つ。DB の TX_RE に合う）
 * callDoor({ dataDir, cmd, args, tx, timeoutMs = 10000, net, fs }) → Promise<{ ok: true, result, dup? } | { ok: false, code }>
 *   紙が無い・つながらない（頼みを送る前に切れた）→ closed。頼みを送った後、答えの前に口が切れた（か timeoutMs を過ぎた）→ 紙を読み直して
 *   つなぎ直し、同じ tx で1回だけ送り直す（DB の (役, tx) の表引きで2回目は効かず、1回目の答えを今の中身から作り直して返す: dupResult）。
 *   送り直しでも答えが無ければ（紙が消えた・つながらないも）unknown（1回目が書けたかどうか分からない）。DB の答えの失敗はその符号のまま。
 *   口に流れる changed の知らせ（id の無い行）は読み捨てる。記録は書かない（呼び手が符号と件数だけを書く: RF67）。
 */
const nodeNet = require('node:net');
const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isNetworkPath } = require('../netPath');

const DOOR_NAME = 'natsu.door';
const WIN_PIPE_RE = /^\\\\\.\\pipe\\natsu-[0-9a-f]{24}$/;
const SOCK_RE = /^natsu-[0-9a-f]{24}\.sock$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const PID_RE = /^[1-9][0-9]{0,9}$/;
const TIMEOUT_MS = 10000;

const pipeOk = (p) => typeof p === 'string' && (WIN_PIPE_RE.test(p) || (path.isAbsolute(p) && SOCK_RE.test(path.basename(p))));

function readDoor(dataDir, fs = nodeFs) {
  let text;
  try { text = fs.readFileSync(path.join(dataDir, DOOR_NAME), 'utf8'); } catch (_) { return null; }
  const m = typeof text === 'string' ? /^pipe ([^\n]+)\ntoken ([^\n]+)\npid ([^\n]+)\n$/.exec(text) : null;
  if (!m || !pipeOk(m[1]) || !TOKEN_RE.test(m[2]) || !PID_RE.test(m[3])) return null;
  return { pipe: m[1], token: m[2] };
}

const isNetworkDir = (dataDir) => isNetworkPath(dataDir);

function newTx(now = Date.now, rand = crypto.randomBytes) {
  return `c:${now().toString(36)}:${Buffer.from(rand(4)).toString('hex')}`;
}

let lastId = 0;
// 1回つないで頼む → { kind: 'answer', msg } | { kind: 'noconnect' }（頼みを送る前に切れた）| { kind: 'lost' }（送った後、答えの前に切れた・時間切れ）
function once(paper, req, timeoutMs, net) {
  return new Promise((resolve) => {
    const id = (lastId = (lastId % 1e9) + 1);
    let sent = false;
    let done = false;
    let buf = '';
    let sock;
    const finish = (out) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (_) { /* 閉じ済み */ }
      resolve(out);
    };
    const timer = setTimeout(() => finish(sent ? { kind: 'lost' } : { kind: 'noconnect' }), timeoutMs);
    try { sock = net.connect({ path: paper.pipe }); } catch (_) { finish({ kind: 'noconnect' }); return; }
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      if (done) return;
      try {
        sock.write(`${JSON.stringify({ hello: paper.token, v: 1 })}\n${JSON.stringify({ id, cmd: req.cmd, args: req.args, tx: req.tx })}\n`);
        sent = true;
      } catch (_) { finish({ kind: 'noconnect' }); }
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg && typeof msg === 'object' && msg.id === id) { finish({ kind: 'answer', msg }); return; }
      }
    });
    sock.on('error', () => { /* close が続く */ });
    sock.on('close', () => finish(sent ? { kind: 'lost' } : { kind: 'noconnect' }));
  });
}

const resultOf = (msg) => (msg.ok === true ? { ok: true, result: msg.result, ...(msg.dup ? { dup: true } : {}) } : { ok: false, code: typeof msg.code === 'string' ? msg.code : 'internal' });

async function callDoor({ dataDir, cmd, args, tx, timeoutMs = TIMEOUT_MS, net = nodeNet, fs = nodeFs } = {}) {
  const req = { cmd, args, tx };
  const first = readDoor(dataDir, fs);
  if (!first) return { ok: false, code: 'closed' };
  const a = await once(first, req, timeoutMs, net);
  if (a.kind === 'answer') return resultOf(a.msg);
  if (a.kind === 'noconnect') return { ok: false, code: 'closed' };
  // 答えの前に切れた: 同じ tx で1回だけ送り直す（F230。2回目は DB の (役, tx) で効かない）
  const again = readDoor(dataDir, fs);
  if (!again) return { ok: false, code: 'unknown' };
  const b = await once(again, req, timeoutMs, net);
  return b.kind === 'answer' ? resultOf(b.msg) : { ok: false, code: 'unknown' };
}

module.exports = { DOOR_NAME, readDoor, isNetworkDir, newTx, callDoor, TIMEOUT_MS };
