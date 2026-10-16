'use strict';
// 偽の whisper-server。main.js が spawn する実行ファイルの代わりに、node で起動される
// （mainrun.js が child_process.spawn を差し替える）。/health は 200、/inference は FAKE_MODE で答える。
//   text          … いつも文を返す（改行を挟む。main 側で 1 行にまとめるかを見る）
//   empty         … ヒント付きは {"text":""}、ヒントなしは "[BLANK_AUDIO]"（どちらも main では空になる）
//   prompt-empty  … ヒント（prompt）付きなら {"text":""}、無ければ文（kotoba-whisper に長いヒントを渡したとき。0.1.1）
//   mixed         … 大きい区間（80KB 超）は空、小さい区間は文（一部だけ空の議事録）
//   err200        … 200 のまま {"error": …}（古い whisper-server が WAV を読めないとき）
//   probe500      … 起動テストの試し（probe.wav）にだけ 500。ほかは文
//   probe-badjson … 起動テストの試しにだけ JSON でない返事
//   probe-drop    … 起動テストの試しにだけ、返事をせずに接続を切る
//   slow          … 区間の返事を 1.5 秒遅らせる（文字起こしの最中に起動テストを押した場面）
// どの場面でも、WAV の頭（RIFF/WAVE、16kHz・モノラル・16bit）が壊れていれば 200 のまま {"error"} を返す
// （本物の 1.7.6・1.8.0 と同じ）。受けた要求は FAKE_LOG に 1 行ずつ書く。

const http = require('http');
const fs = require('fs');

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const mode = process.env.FAKE_MODE || 'text';
const log = process.env.FAKE_LOG;
const note = (line) => { if (log) { try { fs.appendFileSync(log, `${line}\n`); } catch (_) { /* 片付けの後 */ } } };
note(`spawn ${JSON.stringify(args)}`);

// 起動した側（mainrun）が居なくなったら自分も終わる（孤児として残り続けない）
const parent = process.ppid;
setInterval(() => { try { process.kill(parent, 0); } catch (_) { process.exit(0); } }, 500).unref();

// multipart の本文から、名前の付いた欄（文字）と file の中身（バイト列）を取り出す
function parseForm(buf, type) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(type || '');
  const out = { fields: {}, file: null, filename: '' };
  if (!m) return out;
  const sep = Buffer.from(`--${m[1] || m[2]}`);
  let i = buf.indexOf(sep);
  while (i >= 0) {
    const next = buf.indexOf(sep, i + sep.length);
    if (next < 0) break;
    const part = buf.subarray(i + sep.length + 2, next - 2);   // 区切りの後の CRLF と、次の区切りの前の CRLF を除く
    const h = part.indexOf('\r\n\r\n');
    if (h >= 0) {
      const head = part.subarray(0, h).toString('utf8');
      const body = part.subarray(h + 4);
      const name = (/name="([^"]*)"/.exec(head) || [])[1];
      const filename = (/filename="([^"]*)"/.exec(head) || [])[1];
      if (filename !== undefined) { out.file = body; out.filename = filename; } else if (name) out.fields[name] = body.toString('utf8');
    }
    i = next;
  }
  return out;
}

const wavOk = (b) => Boolean(b && b.length >= 44 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE'
  && b.toString('ascii', 12, 16) === 'fmt ' && b.readUInt16LE(20) === 1 && b.readUInt16LE(22) === 1
  && b.readUInt32LE(24) === 16000 && b.readUInt16LE(34) === 16 && b.toString('ascii', 36, 40) === 'data'
  && b.readUInt32LE(40) > 0 && b.readUInt32LE(40) <= b.length - 44);

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

let n = 0;
http.createServer((req, res) => {
  if (req.url === '/health') { json(res, 200, { status: 'ok' }); return; }
  if (req.url !== '/inference') { res.writeHead(404); res.end(); return; }
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    n++;
    const body = Buffer.concat(chunks);
    const form = parseForm(body, req.headers['content-type']);
    const hasPrompt = 'prompt' in form.fields;
    const isProbe = form.filename === 'probe.wav';
    const okWav = wavOk(form.file);
    note(`inference #${n} bytes=${body.length} prompt=${hasPrompt} probe=${isProbe} lang=${form.fields.language || ''} carry=${form.fields.carry_initial_prompt || ''} nc=${form.fields.no_context || ''} wav=${okWav}`);
    if (!okWav) { json(res, 200, { error: 'failed to read audio data' }); return; }
    if (isProbe && mode === 'probe500') { json(res, 500, { error: 'boom' }); return; }
    if (isProbe && mode === 'probe-badjson') { json(res, 200, 'not json'); return; }
    if (isProbe && mode === 'probe-drop') { req.socket.destroy(); return; }
    if (mode === 'err200') { json(res, 200, { error: 'failed to read audio data' }); return; }
    if (mode === 'empty') { json(res, 200, { text: hasPrompt ? '' : ' [BLANK_AUDIO]\n' }); return; }
    if (mode === 'prompt-empty' && hasPrompt) { json(res, 200, { text: '' }); return; }
    if (mode === 'mixed' && !isProbe && form.file.length > 80000) { json(res, 200, { text: '' }); return; }
    const reply = () => json(res, 200, { text: ` 本日の議題は\n進捗の確認です。区間${n}\n` });
    if (mode === 'slow' && !isProbe) setTimeout(reply, 1500); else reply();
  });
}).listen(port, '127.0.0.1');
