/*
 * claude-cli.test.js — 利用者の Claude Code を呼ぶ部品（第1c回 OL5。RF24・RF25・RF31）
 * 本物の claude は走らせない。B-1 は子のプロセスを起こさない部分、B-2 は偽の claude（helpers/fake-claude.js）で試す。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const K = require('../src/claude-cli');

const has = (set) => (p) => set.has(p);

test('OL5: claude を探す。Windows は PATH と %USERPROFILE%\\.local\\bin の claude.exe。npm 版の claude.cmd しか無ければ cmd-only（shell で呼ばない）', () => {
  const env = { Path: 'C:\\Windows;C:\\npm', USERPROFILE: 'C:\\Users\\u' };
  const native = path.win32.join('C:\\Users\\u', '.local', 'bin', 'claude.exe');
  assert.deepStrictEqual(K.findClaude({ env, platform: 'win32', exists: has(new Set([native])) }), { ok: true, cmd: native });
  assert.deepStrictEqual(K.findClaude({ env, platform: 'win32', exists: has(new Set(['C:\\npm\\claude.exe', native])) }), { ok: true, cmd: 'C:\\npm\\claude.exe' }, 'PATH を先に見ていない');
  assert.deepStrictEqual(K.findClaude({ env, platform: 'win32', exists: has(new Set(['C:\\npm\\claude.cmd'])) }), { ok: false, code: 'cmd-only' });
  assert.deepStrictEqual(K.findClaude({ env, platform: 'win32', exists: has(new Set()) }), { ok: false, code: 'not-found' });
  assert.deepStrictEqual(K.findClaude({ env: { PATH: '/usr/bin', HOME: '/home/u' }, platform: 'linux', exists: has(new Set(['/home/u/.local/bin/claude'])) }), { ok: true, cmd: '/home/u/.local/bin/claude' });
  // 設定で指したものだけを見る（PATH は見ない）
  assert.deepStrictEqual(K.findClaude({ configured: 'D:\\tools\\claude.exe', env, platform: 'win32', exists: has(new Set([native, 'D:\\tools\\claude.exe'])) }), { ok: true, cmd: 'D:\\tools\\claude.exe' });
  assert.deepStrictEqual(K.findClaude({ configured: 'D:\\tools\\claude.cmd', env, platform: 'win32', exists: has(new Set(['D:\\tools\\claude.cmd'])) }), { ok: false, code: 'cmd-only' });
  assert.deepStrictEqual(K.findClaude({ configured: 'D:\\none.exe', env, platform: 'win32', exists: has(new Set([native])) }), { ok: false, code: 'not-found' });
});

test('RF25: 子の環境から課金の変数を大小を問わず外す。ほか（PATH・CLAUDE_CONFIG_DIR・プロキシ・証明書）は残す', () => {
  const env = {
    Path: 'C:\\x', USERPROFILE: 'C:\\Users\\u', CLAUDE_CONFIG_DIR: 'C:\\c', HTTPS_PROXY: 'http://proxy:8080', NODE_EXTRA_CA_CERTS: 'C:\\ca.pem',
    ANTHROPIC_API_KEY: 'sk-ant-x', Anthropic_Auth_Token: 't', ANTHROPIC_BASE_URL: 'https://gw', ANTHROPIC_PROFILE: 'p', ANTHROPIC_MODEL: 'opus',
    claude_code_oauth_token: 'o', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_USE_FOUNDRY: '1', CLAUDE_CODE_USE_SOMEDAY: '1', CLAUDE_CODE_SIMPLE: '1', ELECTRON_RUN_AS_NODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',   // 課金に関わらない CLAUDE_CODE_ の変数は残す
  };
  const out = K.childEnv(env);
  assert.deepStrictEqual(Object.keys(out).sort(), ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CONFIG_DIR', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'Path', 'USERPROFILE']);
  assert.strictEqual(env.ANTHROPIC_API_KEY, 'sk-ant-x', '元の環境を書き換えた');
});

test('RF31: 引数は決まったものだけ。会話を保存しない・利用者の CLAUDE.md・フック・プラグイン・MCP を読み込ませない（--safe-mode）・道具と MCP を外す・聞かずに断る・--bare を使わない', () => {
  const a = K.summaryArgs('あなたは議事録作成の専門家です。');
  assert.deepStrictEqual(a, ['-p', K.ASK, '--output-format', 'json', '--no-session-persistence', '--safe-mode', '--system-prompt', 'あなたは議事録作成の専門家です。',
    '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--disable-slash-commands', '--max-turns', '3', '--model', 'sonnet']);
  assert.ok(!a.includes('--bare'));
  assert.deepStrictEqual(K.authArgs(), ['auth', 'status']);
});

test('RF25: auth status は終わりの番号と authMethod で読む。claude.ai のときだけ通す', () => {
  assert.deepStrictEqual(K.parseAuthStatus({ code: 0, stdout: '{"authMethod":"claude.ai"}' }), { ok: true, method: 'claude.ai' });
  assert.deepStrictEqual(K.parseAuthStatus({ code: 1, stdout: '{"authMethod":"none"}' }), { ok: false, code: 'not-logged-in', method: 'none' });
  for (const m of ['api_key', 'api_key_helper', 'third_party', 'oauth_token']) {
    assert.deepStrictEqual(K.parseAuthStatus({ code: 0, stdout: JSON.stringify({ authMethod: m }) }), { ok: false, code: 'api-billing', method: m }, m);
  }
  assert.deepStrictEqual(K.parseAuthStatus({ code: 0, stdout: 'Logged in' }), { ok: false, code: 'unknown', method: '' });
  assert.deepStrictEqual(K.parseAuthStatus({ code: 1, stdout: '', stderr: "error: unknown command 'auth'" }), { ok: false, code: 'old-version', method: '' });
});

test('RF24: 結果の分け方（資料の文のとおり）。成功は result の文。上限はリセットの時刻を取る', () => {
  const res = (o, code = 0) => ({ code, stdout: `${JSON.stringify({ type: 'result', ...o })}\n`, stderr: '', timedOut: false });
  assert.deepStrictEqual(K.classifyRun(res({ subtype: 'success', is_error: false, result: '## 概要\n進捗の確認を行った。' })), { ok: true, text: '## 概要\n進捗の確認を行った。' });
  const cases = [
    ['Not logged in · Please run /login', 'not-logged-in', ''],
    ['Login expired · Please run /login', 'not-logged-in', ''],
    ["You've hit your session limit · resets 3:45pm", 'limit', '3:45pm'],
    ["You've hit your weekly limit · resets Mon 12:00am", 'limit', 'Mon 12:00am'],
    ["You've hit your Opus limit · resets 3:45pm", 'limit', '3:45pm'],
    ['Invalid API key', 'api-billing', ''],
    ['Credit balance is too low', 'api-billing', ''],
    ['API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.', 'overloaded', ''],
    ["Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted", 'account', ''],
    ['Your organization has disabled Claude subscription access', 'account', ''],
    ["You've hit your Sonnet limit · resets 3:45pm", 'limit', '3:45pm'],
    ['Authentication required · Sign in again to continue', 'not-logged-in', ''],
    ['Failed to authenticate: OAuth session expired and could not be refreshed', 'not-logged-in', ''],
    ['Prompt is too long: 250000 tokens > 200000 maximum', 'too-long', ''],
    ['something else', 'failed', ''],
  ];
  for (const [text, code, resetAt] of cases) {
    assert.deepStrictEqual(K.classifyRun(res({ subtype: 'success', is_error: true, result: text }, 1)), { ok: false, code, resetAt }, text);
  }
  // 失敗の副型は errors の並びで来る
  assert.deepStrictEqual(K.classifyRun(res({ subtype: 'error_during_execution', is_error: true, errors: ['Not logged in · Please run /login'] }, 1)), { ok: false, code: 'not-logged-in', resetAt: '' });
  // 引数の誤り（古い版が --safe-mode などを知らない）は始まる前に stderr へ → old-version。ほかの stderr だけの失敗は failed
  assert.deepStrictEqual(K.classifyRun({ code: 1, stdout: '', stderr: "error: unknown option '--safe-mode'", timedOut: false }), { ok: false, code: 'old-version', resetAt: '' });
  assert.deepStrictEqual(K.classifyRun({ code: 1, stdout: '', stderr: 'something broke', timedOut: false }), { ok: false, code: 'failed', resetAt: '' });
  assert.deepStrictEqual(K.classifyRun({ code: 0, stdout: 'not json', stderr: '', timedOut: false }), { ok: false, code: 'bad-reply', resetAt: '' });
  assert.deepStrictEqual(K.classifyRun({ code: null, stdout: '', stderr: '', timedOut: true }), { ok: false, code: 'timeout', resetAt: '' });
  // 成功でも result が空なら失敗
  assert.deepStrictEqual(K.classifyRun(res({ subtype: 'success', is_error: false, result: '  ' })), { ok: false, code: 'bad-reply', resetAt: '' });
});

test('RF24: 平易な文。入れ方のコマンド・リセットの時刻が入り、英語の文や記録の本文を写さない', () => {
  assert.match(K.claudeMessage({ code: 'not-found' }), /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  assert.match(K.claudeMessage({ code: 'cmd-only' }), /npm 版/);
  assert.match(K.claudeMessage({ code: 'not-logged-in' }), /ログインしていないか、ログインが切れています/);
  assert.match(K.claudeMessage({ code: 'api-billing' }), /API キー（従量課金）で動く設定/);
  assert.match(K.claudeMessage({ code: 'limit', resetAt: '3:45pm' }), /上限に達しました（3:45pm に戻ります）/);
  assert.match(K.claudeMessage({ code: 'limit', resetAt: '' }), /上限に達しました。/);
  assert.match(K.claudeMessage({ code: 'overloaded' }), /混み合っている/);
  assert.match(K.claudeMessage({ code: 'timeout' }), /15 分/);
  assert.match(K.claudeMessage({ code: 'too-large' }), /9MB まで/);
  assert.match(K.claudeMessage({ code: 'old-version' }), /claude update/);
  assert.match(K.claudeMessage({ code: 'too-long' }), /長すぎるため/);
  for (const c of ['failed', 'bad-reply', 'unknown']) assert.match(K.claudeMessage({ code: c }), /［要約を生成］でもう一度試せます/);
  assert.ok(!/hit your|Please run/.test(K.claudeMessage({ code: 'limit', resetAt: '3:45pm' })));
});
