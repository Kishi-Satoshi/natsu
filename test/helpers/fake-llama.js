'use strict';
// 偽の llama-server（要約エンジン）。main.js が spawn する実行ファイルの代わりに、node で起動される
// （mainrun.js が child_process.spawn を差し替える）。/health は 200、/v1/chat/completions は
// FAKE_SUM_MD（無ければ既定の Markdown）を FAKE_SUM_DELAY ミリ秒待ってから返す。
// 既定の Markdown は、手元の小さいモデルがやりがちな「文字起こしに無い担当・期限」を混ぜてある。
// 受けた要求は FAKE_LOG に 1 行ずつ書く。

const http = require('http');
const fs = require('fs');

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const log = process.env.FAKE_LOG;
const delay = Number(process.env.FAKE_SUM_DELAY || 0);
const note = (line) => { if (log) { try { fs.appendFileSync(log, `${line}\n`); } catch (_) { /* 片付けの後 */ } } };
note(`sum spawn ${JSON.stringify(args)}`);

const parent = process.ppid;
setInterval(() => { try { process.kill(parent, 0); } catch (_) { process.exit(0); } }, 500).unref();

const MD = process.env.FAKE_SUM_MD || [
  '## 概要',
  '進捗の確認を行った。',
  '',
  '## 報告事項',
  '- 進捗の確認を行った。',
  '',
  '## 決定事項',
  '- 特になし',
  '',
  '## アクションアイテム',
  '- [ ] 進捗の確認をまとめる（担当: 山田 / 期限: 来週金曜）',
  '- [ ] 資料を配布する（担当: 鈴木 / 期限: 10/23）',
  '',
  '## 課題・持ち越し事項',
  '- 特になし',
].join('\n');

let n = 0;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"status":"ok"}'); return; }
  if (req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    n++;
    note(`chat #${n} bytes=${Buffer.concat(chunks).length}`);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: MD }, finish_reason: 'stop' }] }));
    }, delay);
  });
}).on('error', (e) => { note(`sum listen error ${e.code || e.message}`); process.exit(3); })
  .listen(port, '127.0.0.1');
