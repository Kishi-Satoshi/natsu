'use strict';
// 偽の whisper-server。main.js が spawn する実行ファイルの代わりに、node で起動される
// （mainrun.js が child_process.spawn を差し替える）。/health は 200、/inference は FAKE_MODE で答える。
//   text         … いつも文を返す
//   empty        … いつも {"text":""}（無音・マイクの選び違い）
//   prompt-empty … 語彙のヒント（prompt）付きなら {"text":""}、無ければ文（kotoba-whisper に長いヒントを渡したとき。0.1.1）
//   err200       … 200 のまま {"error": …}（古い whisper-server が WAV を読めないとき）
// 受けた要求は FAKE_LOG に 1 行ずつ書く（prompt の有無と大きさ）

const http = require('http');
const fs = require('fs');

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const mode = process.env.FAKE_MODE || 'text';
const log = process.env.FAKE_LOG;
const note = (line) => { if (log) fs.appendFileSync(log, `${line}\n`); };
let n = 0;
note(`spawn ${JSON.stringify(args)}`);

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  if (req.url === '/health') { json(res, 200, { status: 'ok' }); return; }
  if (req.url !== '/inference') { res.writeHead(404); res.end(); return; }
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    n++;
    const body = Buffer.concat(chunks).toString('latin1');
    const hasPrompt = /name="prompt"/.test(body);
    const isProbe = /filename="probe\.wav"/.test(body);
    note(`inference #${n} bytes=${body.length} prompt=${hasPrompt} probe=${isProbe}`);
    if (mode === 'err200') { json(res, 200, { error: 'failed to read audio data' }); return; }
    if (mode === 'empty' || (mode === 'prompt-empty' && hasPrompt)) { json(res, 200, { text: '' }); return; }
    json(res, 200, { text: `本日の議題は進捗の確認です。区間${n}` });
  });
}).listen(port, '127.0.0.1');
