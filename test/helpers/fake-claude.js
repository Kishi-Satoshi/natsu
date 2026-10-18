#!/usr/bin/env node
'use strict';
// 偽の claude（Claude Code の CLI）。テストは本物の claude を走らせない（第1c回 B-2・B-3）。
// node で起こされる（preArgs にこの台本を置く）か、Windows 以外では PATH に「claude」として写して起こされる。
//   auth status → FAKE_CLAUDE_AUTH（既定 claude.ai）で {"loggedIn":…,"authMethod":…}。none なら 1 で終わる。
//                 FAKE_CLAUDE_AUTH_DELAY（ミリ秒）があれば、その間待ってから答える（時間切れの確かめ）
//   --version   → 2.1.300 (Claude Code)
//   -p          → 標準入力を全部読み、FAKE_CLAUDE_MODE で答える（下の ANSWERS）
//                 標準入力に FAKE_CLAUDE_EXPECT（文字起こし）・FAKE_CLAUDE_EXPECT_ASK（指示文）があるかを記録に書く
// 受けたものは FAKE_CLAUDE_LOG に1行の JSON で書く。envKeys は課金に関わる変数の名前だけ（大小を問わず
// ANTHROPIC_・CLAUDE_CODE_USE_・CLAUDE_CODE_OAUTH_ で始まるものと CLAUDE_CODE_SIMPLE）。CLAUDE_CODE_ で始まる
// ほかの変数は数えない（Claude Code の中でテストを回すと置かれていて、外さなくてよいため）。
// 既定の Markdown は fake-llama.js と同じ見出しで、文字起こしに無い担当・期限を混ぜてある（B-3 で照らしを見る）。

const fs = require('fs');

const args = process.argv.slice(2);
const env = process.env;
const log = env.FAKE_CLAUDE_LOG;
const note = (o) => { if (log) { try { fs.appendFileSync(log, `${JSON.stringify(o)}\n`); } catch (_) { /* 片付けの後 */ } } };

const BILLING_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_USE_', 'CLAUDE_CODE_OAUTH_'];
const envKeys = Object.keys(env).filter((k) => {
  const up = k.toUpperCase();
  return up === 'CLAUDE_CODE_SIMPLE' || BILLING_PREFIXES.some((p) => up.startsWith(p));
}).sort();

const MD = env.FAKE_CLAUDE_MD || [
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

const result = (isError, text, extra = {}) => JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, ...extra, result: text, total_cost_usd: 0.01, session_id: 's' });
const ok = () => ({ out: `${result(false, MD)}\n`, code: 0 });
const err = (text, extra) => ({ out: `${result(true, text, extra)}\n`, code: 1 });
const ANSWERS = {
  ok,
  limit: () => err("You've hit your session limit · resets 3:45pm"),
  weekly: () => err("You've hit your weekly limit · resets Mon 12:00am"),
  notlogged: () => err('Not logged in · Please run /login'),
  expired: () => err('Login expired · Please run /login'),
  overloaded: () => err('API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.'),
  hold: () => err("Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted"),
  // 第1b回の続き Lane F: 利用者の PC の 0.5.0 で見たままの返事（auth status は claude.ai なのに -p だけが落ちる）
  expired401: () => err('Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.', { api_error_status: 401 }),
  limit429: () => err('API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}', { api_error_status: 429 }),
  garbage: () => ({ out: 'not json\n', code: 0 }),
  // stdout が 5MB を越える。読める成功の行にしておく（上限で止めなければ ok: true になり、上限の確かめになる）
  huge: () => ({ out: `${result(false, 'x'.repeat(6 * 1024 * 1024))}\n`, code: 0 }),
};

const finish = ({ out = '', errText = '', code }) => {
  if (errText) process.stderr.write(errText);
  if (!out) { process.exit(code); return; }
  process.stdout.write(out, () => process.exit(code));
};

if (args[0] === 'auth' && args[1] === 'status') {
  note({ kind: 'auth', args, envKeys, cwd: require('path').basename(process.cwd()) });
  const method = env.FAKE_CLAUDE_AUTH || 'claude.ai';
  const loggedIn = method !== 'none';
  const answer = () => finish({ out: `${JSON.stringify({ loggedIn, authMethod: method })}\n`, code: loggedIn ? 0 : 1 });
  const delay = Number(env.FAKE_CLAUDE_AUTH_DELAY || 0);
  if (delay > 0) setTimeout(answer, delay); else answer();
} else if (args.includes('--version')) {
  finish({ out: '2.1.300 (Claude Code)\n', code: 0 });
} else if (args.includes('-p')) {
  const mode = env.FAKE_CLAUDE_MODE || 'ok';
  const chunks = [];
  process.stdin.on('data', (d) => chunks.push(d));
  process.stdin.on('end', () => {
    const stdin = Buffer.concat(chunks);
    const text = stdin.toString('utf8');
    const expect = env.FAKE_CLAUDE_EXPECT || '';
    const expectAsk = env.FAKE_CLAUDE_EXPECT_ASK || '';
    note({ kind: 'p', args, cwd: process.cwd(), envKeys, stdinBytes: stdin.length,
      stdinHasTranscript: !!expect && text.includes(expect), stdinHasAsk: !!expectAsk && text.includes(expectAsk) });
    if (mode === 'badflag') { finish({ errText: "error: unknown option '--safe-mode'\n", code: 1 }); return; }   // 古い版のまね
    if (mode === 'slow') { setTimeout(() => finish(ok()), Number(env.FAKE_CLAUDE_DELAY || 0)); return; }
    finish((ANSWERS[mode] || ok)());
  });
} else {
  finish({ errText: `fake-claude: unknown args ${JSON.stringify(args)}\n`, code: 2 });
}
