/*
 * claude-cli.js — 利用者の Claude Code（claude）を呼ぶ部品（第1c回 OL5。RF24・RF25・RF31）
 *
 * オンラインのときの要約は、利用者が自分で入れてログインした Claude Code を
 * 子のプロセスで呼んで作る（claude -p。文字起こしは標準入力）。NaTsu は claude を
 * 同梱しない・改変しない・~/.claude/.credentials.json を読まない・ログインを出さない。
 * ここは子のプロセスを起こさない純粋な部分（探す・環境・引数・結果の分け方・文）。
 * Electron を読まない。B-2 で claudeAuthStatus・claudeSummarize（spawn を引数で受ける）を足す。
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
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STRIP_EXACT = ['CLAUDE_CODE_SIMPLE', 'ELECTRON_RUN_AS_NODE'];   // SIMPLE は --bare と同じ（OAuth を読まない）
const STRIP_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_USE_', 'CLAUDE_CODE_OAUTH_'];
const STDIN_MAX = 9 * 1024 * 1024;      // 資料の上限 10MB より下に
const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const AUTH_TIMEOUT_MS = 30 * 1000;
const CLAUDE_MODEL = 'sonnet';          // 設計書 C8
const ASK = '標準入力の指示に従い、会議の文字起こしから議事録を作成してください。本文だけを出力してください。';
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

// 失敗の文を符号に分ける（資料の文のとおり）
function classifyText(text) {
  const t = String(text || '').trim();
  if (/Not logged in|Login expired|Authentication required|OAuth (session|token)|Invalid authentication credentials|Please run \/login/.test(t)) {
    return { code: 'not-logged-in', resetAt: '' };
  }
  // 従量課金の文を上限より先に見る（「monthly spend limit」は API の課金の上限で、プランの上限ではない）
  if (/Invalid API key|Credit balance is too low|monthly spend limit|disabled API key/.test(t)) return { code: 'api-billing', resetAt: '' };
  if (/hit your .*limit/i.test(t)) {
    const m = t.match(/resets ([^\n·]+)$/);
    return { code: 'limit', resetAt: m ? m[1].trim().slice(0, 40) : '' };
  }
  if (/Overloaded|high load|temporarily limiting|Request rejected \(429\)/.test(t)) return { code: 'overloaded', resetAt: '' };
  if (/account is on hold|organization has been disabled|disabled Claude subscription access/.test(t)) return { code: 'account', resetAt: '' };
  if (/Prompt is too long|prompt is too long|context window/i.test(t)) return { code: 'too-long', resetAt: '' };
  return { code: 'failed', resetAt: '' };
}

const fail = (code, resetAt = '') => ({ ok: false, code, resetAt });

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
    return fail('bad-reply');
  }
  let text = '';
  if (typeof j.result === 'string' && j.result.trim()) text = j.result;
  else if (Array.isArray(j.errors) && j.errors.length) text = j.errors.map(String).join('\n');
  else text = String(stderr || '');
  const c = classifyText(text);
  return fail(c.code, c.resetAt);
}

const RETRY = '［要約を生成］を押してください。';
const MESSAGES = {
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
  STRIP_EXACT, STRIP_PREFIXES, STDIN_MAX, RUN_TIMEOUT_MS, AUTH_TIMEOUT_MS, CLAUDE_MODEL, ASK, INSTALL_CMD,
  findClaude, childEnv, summaryArgs, authArgs, parseAuthStatus, classifyRun, claudeMessage,
};
