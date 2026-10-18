/*
 * claude-cli.js — 利用者の Claude Code（claude）を呼ぶ部品（第1c回 OL5。RF24・RF25・RF31）
 *
 * オンラインのときの要約は、利用者が自分で入れてログインした Claude Code を
 * 子のプロセスで呼んで作る（claude -p。文字起こしは標準入力）。NaTsu は claude を
 * 同梱しない・改変しない・~/.claude/.credentials.json を読まない・ログインを出さない。
 * ここは子のプロセスを起こさない純粋な部分（探す・環境・引数・結果の分け方・文）。
 * Electron を読まない。子を起こすのは claudeAuthStatus・claudeSummarize・claudePing だけ（B-2。spawn を引数で受ける）。
 *
 * 資料（2026-10-18 に読んだ）:
 *   https://code.claude.com/docs/en/headless            （-p・--output-format json・--bare は ~/.claude を読まない代わりに OAuth も読まない）
 *   https://code.claude.com/docs/en/authentication      （認証の順: 環境の ANTHROPIC_API_KEY などがログインより先に効く）
 *   https://code.claude.com/docs/en/cli-reference       （--safe-mode・--tools・--no-session-persistence ほか、auth status）
 *   https://code.claude.com/docs/en/errors              （上限・ログイン切れ・混み合い・アカウントの文）
 *   https://code.claude.com/docs/en/legal-and-compliance（各自のプランの中で使う）
 *
 * 守りの理由:
 *  - 課金の変数（ANTHROPIC_API_KEY・ANTHROPIC_AUTH_TOKEN・CLAUDE_CODE_USE_BEDROCK など）が子に渡ると、
 *    利用者のプランではなく API キーの従量課金で動く（会社の鍵に請求が積もる）。Windows の環境の
 *    変数は名前の大小が混ざる（Anthropic_Api_Key）ので、大小を問わず外す（childEnv）。
 *    ~/.claude/settings.json の env の欄で置かれた鍵は外せないので、呼ぶ前に auth status の
 *    authMethod が claude.ai であることを確かめる（parseAuthStatus）。
 *  - --bare は使わない（OAuth のログインを読まなくなる）。代わりに --safe-mode で、利用者の
 *    CLAUDE.md・フック・プラグイン・スキル・MCP・自動メモリを読み込ませない（フックは文字起こしを
 *    受け取りうる）。--tools "" と MCP の禁止で PC を触らせない。会話は保存しない。
 *  - shell: false で呼ぶ。引数は決まった文字だけ、利用者の文は標準入力で渡す。だから npm 版の
 *    claude.cmd・.bat・.ps1（shell を通さないと起こせない包み）は使わず、ネイティブ版を入れる案内を出す。
 *  - 作業フォルダは NaTsu が作る空のフォルダ（B-2・B-3）。
 *  - 子は止まらないことがある（返事が来ない・背景の仕事を待つ）。時間切れで止め、stdout は 5MB まで読む（F11）。
 *    stderr は分け方にだけ使い、記録に写さない（文字起こしの断片や利用者の環境が混ざりうる）。
 */
'use strict';

const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const STRIP_EXACT = ['CLAUDE_CODE_SIMPLE', 'ELECTRON_RUN_AS_NODE'];   // SIMPLE は --bare と同じ（OAuth を読まない）
const STRIP_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_USE_', 'CLAUDE_CODE_OAUTH_'];
const STDIN_MAX = 9 * 1024 * 1024;      // 資料の上限 10MB より下に
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const AUTH_TIMEOUT_MS = 30 * 1000;
const OUT_MAX = 5 * 1024 * 1024;        // stdout はここまで読む（越えたら止めて bad-reply）
const ERR_MAX = 64 * 1024;              // stderr は分け方に要るだけ
const KILL_WAIT_MS = 2000;              // 止めた後、close が来なくてもここで返す
const CLAUDE_MODEL = 'sonnet';          // 設計書 C8
const ASK = '標準入力の指示に従い、会議の文字起こしから議事録を作成してください。本文だけを出力してください。';
// ［Claude Code を確かめる］の小さな本当の要求（第1b回の続き Lane F-b）。auth status は OAuth の鍵が切れても claude.ai と答えるので、
// 決まった1語を -p で1回だけ送って確かめる（各自のプランの上限をほんの少し使う。文字起こしは送らない）
const PING_ASK = 'ping';
const PING_TIMEOUT_MS = 60 * 1000;
const INSTALL_CMD = 'irm https://claude.ai/install.ps1 | iex';

const WRAPPER_EXT = new Set(['.cmd', '.bat', '.ps1']);
const API_BILLING_METHODS = new Set(['api_key', 'api_key_helper', 'third_party', 'oauth_token']);
const UNKNOWN_FLAG_RE = /unknown (option|command)/i;

// 環境の変数を名前の大小を問わず読む（Windows の Path／PATH）
function envGet(env, name) {
  if (!env) return '';
  if (typeof env[name] === 'string') return env[name];
  const up = name.toUpperCase();
  for (const k of Object.keys(env)) if (k.toUpperCase() === up && typeof env[k] === 'string') return env[k];
  return '';
}

function splitPath(value, sep) {
  return String(value || '').split(sep).map((s) => s.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

function findClaude({ configured = '', env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const win = platform === 'win32';
  const P = win ? path.win32 : path.posix;
  const has = (p) => { try { return !!exists(p); } catch (_) { return false; } };

  const conf = typeof configured === 'string' ? configured.trim() : '';
  if (conf) {
    if (!has(conf)) return { ok: false, code: 'not-found' };
    if (WRAPPER_EXT.has(P.extname(conf).toLowerCase())) return { ok: false, code: 'cmd-only' };
    return { ok: true, cmd: conf };
  }

  const dirs = splitPath(envGet(env, 'PATH'), win ? ';' : ':');
  const home = envGet(env, win ? 'USERPROFILE' : 'HOME');
  if (home) dirs.push(P.join(home, '.local', 'bin'));

  const exe = win ? 'claude.exe' : 'claude';
  for (const d of dirs) {
    const p = P.join(d, exe);
    if (has(p)) return { ok: true, cmd: p };
  }
  if (win) {
    for (const d of dirs) {
      for (const ext of WRAPPER_EXT) if (has(P.join(d, `claude${ext}`))) return { ok: false, code: 'cmd-only' };
    }
  }
  return { ok: false, code: 'not-found' };
}

function childEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    const up = k.toUpperCase();
    if (STRIP_EXACT.includes(up)) continue;
    if (STRIP_PREFIXES.some((p) => up.startsWith(p))) continue;
    out[k] = v;
  }
  return out;
}

function summaryArgs(systemPrompt, { model = CLAUDE_MODEL } = {}) {
  return ['-p', ASK, '--output-format', 'json', '--no-session-persistence', '--safe-mode', '--system-prompt', String(systemPrompt),
    '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--permission-mode', 'dontAsk',
    '--disable-slash-commands', '--max-turns', '3', '--model', model];
}

// 確かめの要求の引数: 要約と同じ守りの引数（summaryArgs から作る）で、指示は決まった1語、役割の文は渡さず、1手で終える
function pingArgs() {
  const a = summaryArgs('');
  a[a.indexOf(ASK)] = PING_ASK;
  a.splice(a.indexOf('--system-prompt'), 2);
  a[a.indexOf('--max-turns') + 1] = '1';
  return a;
}

function authArgs() {
  return ['auth', 'status'];
}

// stdout の JSON を読む（全体、だめなら最後の空でない行）。オブジェクトでなければ null
function parseJsonObject(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  const tries = [s];
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) tries.push(lines[lines.length - 1]);
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch (_) { /* 次を試す */ }
  }
  return null;
}

function parseAuthStatus({ code, stdout, stderr = '' } = {}) {
  if (UNKNOWN_FLAG_RE.test(String(stderr || ''))) return { ok: false, code: 'old-version', method: '' };
  const j = parseJsonObject(stdout);
  const method = j && typeof j.authMethod === 'string' ? j.authMethod : '';
  if (code !== 0 || (j && j.loggedIn === false)) return { ok: false, code: 'not-logged-in', method };
  if (method === 'claude.ai') return { ok: true, method };
  if (API_BILLING_METHODS.has(method)) return { ok: false, code: 'api-billing', method };
  return { ok: false, code: 'unknown', method };
}

// 混み合いの文。api_error_status の 429 の分け方にも使う
const OVERLOADED_RE = /Overloaded|high load|temporarily limiting|Request rejected \(429\)/;

// 失敗の文を符号に分ける（資料の文のとおり）。-p の結果で「ログインしていない・切れた」は auth-expired
// （第1b回の続き Lane F。auth status が claude.ai と言っても OAuth の鍵が切れていれば -p だけが落ちる。
// 直し方はどれも設定の［Claude Code にログイン］。auth status の loggedIn:false は parseAuthStatus の not-logged-in のまま）
function classifyText(text) {
  const t = String(text || '').trim();
  if (/Not logged in|Login expired|Authentication required|OAuth (session|token|access token has expired)|Invalid authentication credentials|Failed to authenticate|Please run \/login/i.test(t)) {
    return { code: 'auth-expired', resetAt: '' };
  }
  // 従量課金の文を上限より先に見る（「monthly spend limit」は API の課金の上限で、プランの上限ではない）
  if (/Invalid API key|Credit balance is too low|monthly spend limit|disabled API key/.test(t)) return { code: 'api-billing', resetAt: '' };
  if (/hit your .*limit/i.test(t)) {
    const m = t.match(/resets ([^\n·]+)$/);
    return { code: 'limit', resetAt: m ? m[1].trim().slice(0, 40) : '' };
  }
  if (/usage limit reached/i.test(t)) return { code: 'limit', resetAt: '' };
  if (OVERLOADED_RE.test(t)) return { code: 'overloaded', resetAt: '' };
  if (/account is on hold|organization has been disabled|disabled Claude subscription access/.test(t)) return { code: 'account', resetAt: '' };
  if (/Prompt is too long|prompt is too long|context window/i.test(t)) return { code: 'too-long', resetAt: '' };
  return { code: 'failed', resetAt: '' };
}

const fail = (code, resetAt = '') => ({ ok: false, code, resetAt });

// 記録に写してよい値だけ（第1b回の続き Lane F-a）。返事の文・文字起こしは写さない。
// 副型は Claude Code の資料の result の subtype の決まった名前だけ（ほかは other）、状態の番号は 100〜599 の整数だけ
const SUBTYPES = new Set(['success', 'error_max_turns', 'error_during_execution', 'error_max_budget_usd', 'error_max_structured_output_retries']);
const CODES = new Set(['ok', 'not-found', 'cmd-only', 'not-logged-in', 'auth-expired', 'api-billing', 'limit', 'overloaded', 'account', 'timeout',
  'too-large', 'old-version', 'too-long', 'bad-reply', 'failed', 'unknown']);
const okStatus = (v) => Number.isInteger(v) && v >= 100 && v <= 599;
function facts(j) {
  const out = {};
  if (j && j.subtype !== undefined) out.subtype = typeof j.subtype === 'string' && SUBTYPES.has(j.subtype) ? j.subtype : 'other';
  if (j && okStatus(j.api_error_status)) out.apiStatus = j.api_error_status;
  return out;
}
/** engine.log に書く1語（符号）と、副型・状態の番号。決まりの外の値は写さない */
function runWhy(r) {
  if (r && r.ok === true) return 'ok';
  const code = r && typeof r.code === 'string' && CODES.has(r.code) ? r.code : 'failed';
  const parts = [];
  if (r && r.subtype !== undefined) parts.push(`subtype=${typeof r.subtype === 'string' && SUBTYPES.has(r.subtype) ? r.subtype : 'other'}`);
  if (r && okStatus(r.apiStatus)) parts.push(`api_error_status=${r.apiStatus}`);
  return parts.length ? `${code}（${parts.join('・')}）` : code;
}

function classifyRun({ code, stdout, stderr, timedOut } = {}) {
  if (timedOut) return fail('timeout');
  const j = parseJsonObject(stdout);
  if (!j) {
    if (code === 0) return fail('bad-reply');
    // 引数の誤り（古い版が --safe-mode などを知らない）は始まる前に stderr へ出る
    if (UNKNOWN_FLAG_RE.test(String(stderr || ''))) return fail('old-version');
    const c = classifyText(`${stderr || ''}\n${stdout || ''}`);
    return fail(c.code, c.resetAt);
  }
  if (j.is_error !== true && code === 0) {
    if (typeof j.result === 'string' && j.result.trim()) return { ok: true, text: j.result };
    return { ...fail('bad-reply'), ...facts(j) };
  }
  let text = '';
  if (typeof j.result === 'string' && j.result.trim()) text = j.result;
  else if (Array.isArray(j.errors) && j.errors.length) text = j.errors.map(String).join('\n');
  else text = String(stderr || '');
  let c = classifyText(text);
  // 状態の番号で分ける（Lane F-a）: 401 は文に関わらずログイン切れ（呼ぶ前に auth status で claude.ai を確かめてある）。
  // 429 は上限（リセットの時刻は文から取る）。ただし混み合いの文なら混み合い
  if (j.api_error_status === 401) c = { code: 'auth-expired', resetAt: '' };
  else if (j.api_error_status === 429 && c.code !== 'limit') c = OVERLOADED_RE.test(text) ? { code: 'overloaded', resetAt: '' } : { code: 'limit', resetAt: '' };
  return { ...fail(c.code, c.resetAt), ...facts(j) };
}

// 子を1つ起こして終わりを待つ。shell なし・課金の変数を外した環境・決まった作業フォルダ。
// 起こせなければ { spawnError }。時間切れと stdout の越えは子を止めて返す（close が来なくても KILL_WAIT_MS で）
function runChild({ cmd, args, spawn, env, cwd, input, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: childEnv(env), shell: false, windowsHide: true });
    } catch (e) {
      resolve({ spawnError: e });
      return;
    }
    const out = []; let outLen = 0;
    const err = []; let errLen = 0;
    let timedOut = false; let tooBig = false; let stopping = false; let done = false;
    let timer = null; let killTimer = null;
    const result = (code) => ({
      code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut, tooBig,
    });
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(killTimer);
      resolve(r);
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      try { child.kill(); } catch (_) { /* もう終わっている */ }
      killTimer = setTimeout(() => finish(result(null)), KILL_WAIT_MS);
    };
    child.on('error', (e) => {
      // 起こせなかった（ENOENT・EACCES など）。起きた後の誤り（止めるのに失敗など）は close を待つ
      if (child.pid === undefined) finish({ spawnError: e });
    });
    child.on('close', (code) => finish(result(code)));
    if (child.stdout) {
      child.stdout.on('data', (d) => {
        if (tooBig) return;
        if (outLen + d.length > OUT_MAX) { tooBig = true; stop(); return; }
        out.push(d); outLen += d.length;
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (d) => {
        if (errLen >= ERR_MAX) return;
        const part = d.subarray(0, ERR_MAX - errLen);
        err.push(part); errLen += part.length;
      });
    }
    if (child.stdin) {
      child.stdin.on('error', () => { /* EPIPE: 子が読む前に終わった。終わりの番号で分ける */ });
      try { child.stdin.end(input === undefined ? undefined : input); } catch (_) { /* 同上 */ }
    }
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  });
}

async function claudeAuthStatus({ cmd, preArgs = [], spawn = cp.spawn, env = process.env, cwd, timeoutMs = AUTH_TIMEOUT_MS } = {}) {
  const r = await runChild({ cmd, args: [...preArgs, ...authArgs()], spawn, env, cwd, timeoutMs });
  if (r.spawnError) return { ok: false, code: 'not-found' };
  // 時間切れ・読みきれない返事は「ログインしていない」とは言わない（誤った案内になる）
  if (r.timedOut || r.tooBig) return { ok: false, code: 'failed', method: '' };
  return parseAuthStatus({ code: r.code, stdout: r.stdout, stderr: r.stderr });
}

async function claudeSummarize({ cmd, preArgs = [], spawn = cp.spawn, env = process.env, cwd, input, systemPrompt, model, timeoutMs = RUN_TIMEOUT_MS } = {}) {
  const text = typeof input === 'string' ? input : String(input == null ? '' : input);
  if (Buffer.byteLength(text) > STDIN_MAX) return { ok: false, code: 'too-large' };
  const args = [...preArgs, ...summaryArgs(systemPrompt, { model })];
  const r = await runChild({ cmd, args, spawn, env, cwd, input: text, timeoutMs });
  if (r.spawnError) return fail('not-found');
  if (r.timedOut) return fail('timeout');
  if (r.tooBig) return fail('bad-reply');
  return classifyRun(r);
}

// 確かめの要求を1つ送る → { ok: true } | { ok: false, code, … }。成功しても返事の文は持たない（画面にも記録にも出さない）
async function claudePing({ cmd, preArgs = [], spawn = cp.spawn, env = process.env, cwd, timeoutMs = PING_TIMEOUT_MS } = {}) {
  const r = await runChild({ cmd, args: [...preArgs, ...pingArgs()], spawn, env, cwd, input: '', timeoutMs });
  if (r.spawnError) return fail('not-found');
  if (r.timedOut) return fail('timeout');
  if (r.tooBig) return fail('bad-reply');
  const c = classifyRun(r);
  return c.ok ? { ok: true } : c;
}

const RETRY = '［要約を生成］を押してください。';
const MESSAGES = {
  'auth-expired': 'Claude Code のログインが切れています。設定の［Claude Code にログイン］を押してください。',
  'not-found': `Claude Code が見つからないため、要約を作れませんでした。PowerShell で \`${INSTALL_CMD}\` を実行して入れ、ターミナルで \`claude\` を一度起動してログインしてから、${RETRY}`,
  'cmd-only': `Claude Code が \`claude.cmd\` の形（npm 版など）でしか見つからないため、NaTsu から呼べません。PowerShell で \`${INSTALL_CMD}\` を実行して入れ直すか、設定の「Claude Code の場所」に \`claude.exe\` を指定してから、${RETRY}`,
  'not-logged-in': `Claude Code にログインしていないか、ログインが切れています。ターミナルで \`claude\` を起動してログインしてから、${RETRY}`,
  'api-billing': `Claude Code が API キー（従量課金）で動く設定になっているため、要約を作りませんでした（NaTsu は各自の Claude のプランだけを使います）。ターミナルで \`claude auth status\` を実行して確かめ、\`claude auth login\` で claude.ai のアカウントにログインしてから、${RETRY}`,
  overloaded: `Claude が混み合っているため、要約を作れませんでした。少し待ってから${RETRY}`,
  account: 'Claude のアカウントか組織の設定で Claude Code が使えません。Claude の管理者に確かめてください。',
  timeout: 'Claude Code が 15 分たっても要約を返さなかったため、止めました。［要約を生成］でもう一度試せます。',
  'too-large': '文字起こしが長すぎるため、Claude Code に渡せませんでした（9MB まで）。',
  'old-version': `Claude Code が古いため、NaTsu から呼べませんでした。ターミナルで \`claude update\` を実行してから、${RETRY}`,
  'too-long': '文字起こしが長すぎるため、Claude Code で一度に要約できませんでした（文字起こしは保存してあります）。長い会議は途中で区切って録ってください。',
  other: 'Claude Code で要約を作れませんでした。［要約を生成］でもう一度試せます。続くときは、理由の記録を見てください。理由の記録: %APPDATA%\\natsu\\engine.log',
};

function claudeMessage(r) {
  const code = r && typeof r.code === 'string' ? r.code : '';
  if (code === 'limit') {
    const at = r && typeof r.resetAt === 'string' ? r.resetAt.trim().slice(0, 40) : '';
    const head = at ? `Claude の利用の上限に達しました（${at} に戻ります）。` : 'Claude の利用の上限に達しました。';
    return `${head}Claude のチャットと同じ上限を使っています。戻ってから${RETRY}`;
  }
  return Object.prototype.hasOwnProperty.call(MESSAGES, code) && code !== 'other' ? MESSAGES[code] : MESSAGES.other;
}

module.exports = {
  STRIP_EXACT, STRIP_PREFIXES, STDIN_MAX, RUN_TIMEOUT_MS, AUTH_TIMEOUT_MS, CLAUDE_MODEL, ASK, INSTALL_CMD, PING_ASK, PING_TIMEOUT_MS,
  findClaude, childEnv, summaryArgs, pingArgs, authArgs, parseAuthStatus, classifyRun, claudeMessage, runWhy,
  claudeAuthStatus, claudeSummarize, claudePing,
};
