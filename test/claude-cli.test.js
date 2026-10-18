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
    // 第1b回の続き Lane F: -p の結果で「ログインしていない・切れた」は auth-expired（auth status は claude.ai と言っても、
    // OAuth の鍵が切れていれば -p だけが 401 で落ちる。直し方はどれも［Claude Code にログイン］）
    ['Not logged in · Please run /login', 'auth-expired', ''],
    ['Login expired · Please run /login', 'auth-expired', ''],
    ["You've hit your session limit · resets 3:45pm", 'limit', '3:45pm'],
    ["You've hit your weekly limit · resets Mon 12:00am", 'limit', 'Mon 12:00am'],
    ["You've hit your Opus limit · resets 3:45pm", 'limit', '3:45pm'],
    ['Invalid API key', 'api-billing', ''],
    ['Credit balance is too low', 'api-billing', ''],
    ['API Error: Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary.', 'overloaded', ''],
    ["Your account is on hold and can't use Claude Code. View details or appeal: https://claude.ai/restricted", 'account', ''],
    ['Your organization has disabled Claude subscription access', 'account', ''],
    ["You've hit your Sonnet limit · resets 3:45pm", 'limit', '3:45pm'],
    ['Authentication required · Sign in again to continue', 'auth-expired', ''],
    ['Failed to authenticate: OAuth session expired and could not be refreshed', 'auth-expired', ''],
    ['Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.', 'auth-expired', ''],
    ['not logged in', 'auth-expired', ''],
    ['Claude AI usage limit reached|1760000000', 'limit', ''],
    ['Prompt is too long: 250000 tokens > 200000 maximum', 'too-long', ''],
    ['something else', 'failed', ''],
  ];
  for (const [text, code, resetAt] of cases) {
    assert.deepStrictEqual(K.classifyRun(res({ subtype: 'success', is_error: true, result: text }, 1)), { ok: false, code, resetAt, subtype: 'success' }, text);
  }
  // 失敗の副型は errors の並びで来る
  assert.deepStrictEqual(K.classifyRun(res({ subtype: 'error_during_execution', is_error: true, errors: ['Not logged in · Please run /login'] }, 1)),
    { ok: false, code: 'auth-expired', resetAt: '', subtype: 'error_during_execution' });
  // 引数の誤り（古い版が --safe-mode などを知らない）は始まる前に stderr へ → old-version。ほかの stderr だけの失敗は failed
  assert.deepStrictEqual(K.classifyRun({ code: 1, stdout: '', stderr: "error: unknown option '--safe-mode'", timedOut: false }), { ok: false, code: 'old-version', resetAt: '' });
  assert.deepStrictEqual(K.classifyRun({ code: 1, stdout: '', stderr: 'something broke', timedOut: false }), { ok: false, code: 'failed', resetAt: '' });
  assert.deepStrictEqual(K.classifyRun({ code: 0, stdout: 'not json', stderr: '', timedOut: false }), { ok: false, code: 'bad-reply', resetAt: '' });
  assert.deepStrictEqual(K.classifyRun({ code: null, stdout: '', stderr: '', timedOut: true }), { ok: false, code: 'timeout', resetAt: '' });
  // is_error が false でも終わりの番号が 0 でなければ失敗（result の文を議事録にしない）
  assert.deepStrictEqual(K.classifyRun({ code: 1, stdout: `${JSON.stringify({ type: 'result', is_error: false, result: '## 概要' })}\n`, stderr: '', timedOut: false }), { ok: false, code: 'failed', resetAt: '' });
  // 成功でも result が空なら失敗
  assert.deepStrictEqual(K.classifyRun(res({ subtype: 'success', is_error: false, result: '  ' })), { ok: false, code: 'bad-reply', resetAt: '', subtype: 'success' });
});

// 第1b回の続き Lane F（利用者の PC の 0.5.0 で見つかった）: auth status は authMethod claude.ai なのに、claude -p は
// is_error:true・api_error_status 401・「OAuth access token has expired」で落ち、NaTsu は「要約を作れませんでした」としか言わなかった
test('Lane F-a: api_error_status の 401 はログイン切れ（文に関わらず）、429 は上限（混み合いの文なら混み合い）。副型と状態の番号は決まった値だけ持つ', () => {
  const res = (o, code = 1) => ({ code, stdout: `${JSON.stringify({ type: 'result', ...o })}\n`, stderr: '', timedOut: false });
  // 利用者の PC で見たままの返事
  const real = { subtype: 'success', is_error: true, api_error_status: 401, duration_ms: 812, result: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.' };
  assert.deepStrictEqual(K.classifyRun(res(real)), { ok: false, code: 'auth-expired', resetAt: '', subtype: 'success', apiStatus: 401 });
  assert.deepStrictEqual(K.classifyRun(res({ subtype: 'success', is_error: true, api_error_status: 401, result: 'something else' })),
    { ok: false, code: 'auth-expired', resetAt: '', subtype: 'success', apiStatus: 401 });
  assert.deepStrictEqual(K.classifyRun(res({ subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error: 429 rate_limit_error' })),
    { ok: false, code: 'limit', resetAt: '', subtype: 'success', apiStatus: 429 });
  assert.deepStrictEqual(K.classifyRun(res({ subtype: 'success', is_error: true, api_error_status: 429, result: "You've hit your session limit · resets 3:45pm" })),
    { ok: false, code: 'limit', resetAt: '3:45pm', subtype: 'success', apiStatus: 429 });
  assert.deepStrictEqual(K.classifyRun(res({ subtype: 'success', is_error: true, api_error_status: 429, result: 'API Error: Request rejected (429) · this may be a temporary capacity issue' })),
    { ok: false, code: 'overloaded', resetAt: '', subtype: 'success', apiStatus: 429 });
  // 終わりの番号が 0 でも is_error なら失敗（401 の返事が 0 で終わっても議事録にしない）
  assert.strictEqual(K.classifyRun(res(real, 0)).code, 'auth-expired');
  // 知らない副型は other、番号でない・範囲の外の状態は持たない（記録に写すのは決まった値だけ）
  assert.deepStrictEqual(K.classifyRun(res({ subtype: 'evil text\nline', is_error: true, api_error_status: '401 OAuth', result: 'x' })),
    { ok: false, code: 'failed', resetAt: '', subtype: 'other' });
  assert.deepStrictEqual(K.classifyRun(res({ is_error: true, api_error_status: 4010, result: 'x' })), { ok: false, code: 'failed', resetAt: '' });
});

test('Lane F-a: ログイン切れの文は設定の［Claude Code にログイン］へ案内する。記録の行は符号・副型・状態の番号だけ（返事の文を写さない）', () => {
  assert.strictEqual(K.claudeMessage({ code: 'auth-expired' }), 'Claude Code のログインが切れています。設定の［Claude Code にログイン］を押してください。');
  assert.strictEqual(K.runWhy({ ok: false, code: 'auth-expired', resetAt: '', subtype: 'success', apiStatus: 401 }), 'auth-expired（subtype=success・api_error_status=401）');
  assert.strictEqual(K.runWhy({ ok: false, code: 'limit', resetAt: '3:45pm' }), 'limit');
  assert.strictEqual(K.runWhy({ ok: false, code: 'timeout' }), 'timeout');
  assert.strictEqual(K.runWhy({ ok: true, text: '## 概要' }), 'ok');
  // 決まりの外の符号・副型・番号は写さない（返事の文が混ざっても記録に出ない）
  assert.strictEqual(K.runWhy({ ok: false, code: 'Failed to authenticate', subtype: 'OAuth access token has expired', apiStatus: 'x' }), 'failed（subtype=other）');
  assert.strictEqual(K.runWhy(null), 'failed');
  const real = { code: 1, stdout: `${JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Failed to authenticate. API Error: 401 OAuth access token has expired. Re-authenticate to continue.' })}\n`, stderr: '', timedOut: false };
  assert.strictEqual(K.runWhy(K.classifyRun(real)), 'auth-expired（subtype=success・api_error_status=401）', '返事の文が記録の行に写った');
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

// ---- B-2: 子のプロセスを本当に起こす（偽の claude で。本物は走らせない） ----
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');
const FAKE = path.join(__dirname, 'helpers', 'fake-claude.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-claude-'));
// childEnv は ELECTRON_RUN_AS_NODE を外す（本物の claude には要らない）。CI の electron-smoke はテストを
// Electron の Node（ELECTRON_RUN_AS_NODE=1）で回し、process.execPath が electron.exe になるので、偽の claude を
// Node として起こすためにテストの側でだけ戻す（Node で回すときは何も足さない）
const spawnFake = (c, a, o) => cp.spawn(c, a, process.versions.electron ? { ...o, env: { ...o.env, ELECTRON_RUN_AS_NODE: '1' } } : o);
const withFake = (mode, extra = {}) => {
  const d = tmp(); const log = path.join(d, 'claude.log');
  const env = { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-test', Anthropic_Base_Url: 'https://gw.example', CLAUDE_CODE_OAUTH_TOKEN: 'o', FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, ...extra };
  const cwd = path.join(d, 'claude-run'); fs.mkdirSync(cwd);
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const pids = [];   // 起こした子（時間切れで本当に止めたかを見る）
  const spawn = (c, a, o) => { const k = spawnFake(c, a, o); pids.push(k.pid); return k; };
  return { cmd: process.execPath, preArgs: [FAKE], spawn, env, cwd, lines, pids };
};
const INPUT = '【会議の文字起こし】\n本日の議題は進捗の確認です。\n\n上記から、次の構成のMarkdown議事録を作成してください。';

test('RF25: auth status を子の環境から課金の変数を外して呼ぶ。api_key_helper なら api-billing', { timeout: 20000 }, async () => {
  const f = withFake('ok');
  assert.deepStrictEqual(await K.claudeAuthStatus(f), { ok: true, method: 'claude.ai' });
  assert.deepStrictEqual(f.lines()[0].envKeys, [], '課金の変数が子に渡った');
  assert.deepStrictEqual(f.lines()[0].args, K.authArgs());
  const g = withFake('ok', { FAKE_CLAUDE_AUTH: 'api_key_helper' });
  assert.deepStrictEqual(await K.claudeAuthStatus(g), { ok: false, code: 'api-billing', method: 'api_key_helper' });
  const h = withFake('ok', { FAKE_CLAUDE_AUTH: 'none' });
  assert.deepStrictEqual(await K.claudeAuthStatus(h), { ok: false, code: 'not-logged-in', method: 'none' });
  // 時間切れは「ログインしていない」とは言わず failed（誤ったログインの案内を出さない）
  const slow = withFake('ok', { FAKE_CLAUDE_AUTH_DELAY: '10000' });
  assert.deepStrictEqual(await K.claudeAuthStatus({ ...slow, timeoutMs: 300 }), { ok: false, code: 'failed', method: '' });
  assert.throws(() => process.kill(slow.pids[0], 0), '時間切れの後も auth status の子が生きている');
  // 起こせない（無いファイル）なら not-found
  assert.deepStrictEqual(await K.claudeAuthStatus({ ...f, cmd: path.join(tmp(), 'no-such-claude'), preArgs: [] }), { ok: false, code: 'not-found' });
});

test('OL5: -p に決まった引数を渡し、文字起こしは標準入力だけで渡す（引数に入れない）。作業フォルダは渡したフォルダ', { timeout: 20000 }, async () => {
  const f = withFake('ok', { FAKE_CLAUDE_EXPECT: '本日の議題は進捗の確認です。' });
  const r = await K.claudeSummarize({ ...f, input: INPUT, systemPrompt: 'あなたは議事録作成の専門家です。' });
  assert.strictEqual(r.ok, true);
  assert.match(r.text, /## 概要/);
  const p = f.lines().find((l) => l.kind === 'p');
  assert.deepStrictEqual(p.args, K.summaryArgs('あなたは議事録作成の専門家です。'));
  assert.strictEqual(fs.realpathSync(p.cwd), fs.realpathSync(f.cwd));
  assert.strictEqual(p.stdinHasTranscript, true);
  assert.strictEqual(p.stdinBytes, Buffer.byteLength(INPUT));
  assert.ok(!p.args.some((a) => a.includes('本日の議題')), '文字起こしを引数に入れた');
  assert.deepStrictEqual(p.envKeys, []);
});

test('RF24: 上限・ログイン切れ・混み合い・読めない返事・古い版（引数を知らない）を分ける', { timeout: 20000 }, async () => {
  const want = { limit: ['limit', '3:45pm'], weekly: ['limit', 'Mon 12:00am'], notlogged: ['auth-expired', ''], expired: ['auth-expired', ''],
    overloaded: ['overloaded', ''], hold: ['account', ''], garbage: ['bad-reply', ''], badflag: ['old-version', ''] };
  for (const [mode, [code, resetAt]] of Object.entries(want)) {
    const f = withFake(mode);
    // JSON の返事なら副型（偽の claude はいつも success）を持つ。JSON でない返事・引数の誤りは持たない
    const extra = ['garbage', 'badflag'].includes(mode) ? {} : { subtype: 'success' };
    assert.deepStrictEqual(await K.claudeSummarize({ ...f, input: INPUT, systemPrompt: 's' }), { ok: false, code, resetAt, ...extra }, mode);
  }
  // Lane F-a: 利用者の PC で見た 401（OAuth の鍵が切れた）と、状態の番号だけの 429
  assert.deepStrictEqual(await K.claudeSummarize({ ...withFake('expired401'), input: INPUT, systemPrompt: 's' }),
    { ok: false, code: 'auth-expired', resetAt: '', subtype: 'success', apiStatus: 401 });
  assert.deepStrictEqual(await K.claudeSummarize({ ...withFake('limit429'), input: INPUT, systemPrompt: 's' }),
    { ok: false, code: 'limit', resetAt: '', subtype: 'success', apiStatus: 429 });
});

test('F11: 返事が来なければ時間切れで子を止める。標準入力が 9MB を越えるなら起こさない', { timeout: 20000 }, async () => {
  const f = withFake('slow', { FAKE_CLAUDE_DELAY: '10000' });
  const t0 = Date.now();
  assert.deepStrictEqual(await K.claudeSummarize({ ...f, input: INPUT, systemPrompt: 's', timeoutMs: 300 }), { ok: false, code: 'timeout', resetAt: '' });
  assert.ok(Date.now() - t0 < 5000);
  assert.strictEqual(f.pids.length, 1);
  assert.throws(() => process.kill(f.pids[0], 0), '時間切れの後も子が生きている（止めていない）');
  const g = withFake('ok');
  assert.deepStrictEqual(await K.claudeSummarize({ ...g, input: 'あ'.repeat(Math.ceil(K.STDIN_MAX / 3) + 1), systemPrompt: 's' }), { ok: false, code: 'too-large' });
  assert.deepStrictEqual(g.lines(), [], '大きすぎるのに起こした');
});

test('OL5: PATH に置いた偽の claude を見つけて呼べる（Windows 以外は台本そのもの、Windows は探すところまで）', { timeout: 20000 }, async () => {
  const d = tmp();
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(d, 'claude.exe'), '');   // 探すだけ（中身は起こさない）
    assert.deepStrictEqual(K.findClaude({ env: { Path: d, USERPROFILE: tmp() }, platform: 'win32' }), { ok: true, cmd: path.join(d, 'claude.exe') });
    return;
  }
  const bin = path.join(d, 'claude');
  fs.copyFileSync(FAKE, bin); fs.chmodSync(bin, 0o755);
  const found = K.findClaude({ env: { PATH: d, HOME: tmp() }, platform: process.platform });
  assert.deepStrictEqual(found, { ok: true, cmd: bin });
  const f = withFake('ok', { PATH: `${d}${path.delimiter}${path.dirname(process.execPath)}` });
  assert.deepStrictEqual(await K.claudeAuthStatus({ ...f, cmd: found.cmd, preArgs: [] }), { ok: true, method: 'claude.ai' });
});

test('F11: stdout が 5MB を越えたら読むのを止めて子を止め、bad-reply', { timeout: 20000 }, async () => {
  const f = withFake('huge');
  assert.deepStrictEqual(await K.claudeSummarize({ ...f, input: INPUT, systemPrompt: 's' }), { ok: false, code: 'bad-reply', resetAt: '' });
  assert.strictEqual(f.pids.length, 1);
  assert.throws(() => process.kill(f.pids[0], 0), '5MB を越えた後も子が生きている（止めていない）');
});

// ---- 第1b回の続き Lane F-b: ［Claude Code を確かめる］の小さな本当の要求（auth status だけでは鍵の切れが分からない） ----
test('Lane F-b: 確かめの要求は決まった1語の -p で、要約と同じ守りの引数（--safe-mode・道具なし・MCP なし・会話を保存しない・聞かずに断る）。役割の文は渡さず、1手で終える', () => {
  const a = K.pingArgs();
  assert.deepStrictEqual(a, ['-p', 'ping', '--output-format', 'json', '--no-session-persistence', '--safe-mode',
    '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--permission-mode', 'dontAsk', '--disable-slash-commands', '--max-turns', '1', '--model', 'sonnet']);
  assert.strictEqual(K.PING_ASK, 'ping');
  assert.ok(!a.includes('--bare') && !a.includes('--system-prompt'));
  assert.ok(K.PING_TIMEOUT_MS >= 15000 && K.PING_TIMEOUT_MS <= 90000, `確かめの時間切れが短くない: ${K.PING_TIMEOUT_MS}`);
});

test('Lane F-b: 確かめの要求を偽の claude で通す。成功は { ok: true }（返事の文は持たない）、401 はログイン切れ、時間切れは止めて timeout。標準入力は空、課金の変数は渡らない', { timeout: 20000 }, async () => {
  const f = withFake('ok');
  assert.deepStrictEqual(await K.claudePing(f), { ok: true });
  const p = f.lines().find((l) => l.kind === 'p');
  assert.deepStrictEqual(p.args, K.pingArgs());
  assert.strictEqual(p.stdinBytes, 0);
  assert.deepStrictEqual(p.envKeys, []);
  assert.strictEqual(fs.realpathSync(p.cwd), fs.realpathSync(f.cwd));
  assert.deepStrictEqual(await K.claudePing(withFake('expired401')), { ok: false, code: 'auth-expired', resetAt: '', subtype: 'success', apiStatus: 401 });
  assert.deepStrictEqual(await K.claudePing(withFake('limit')), { ok: false, code: 'limit', resetAt: '3:45pm', subtype: 'success' });
  const slow = withFake('slow', { FAKE_CLAUDE_DELAY: '10000' });
  assert.deepStrictEqual(await K.claudePing({ ...slow, timeoutMs: 300 }), { ok: false, code: 'timeout', resetAt: '' });
  assert.throws(() => process.kill(slow.pids[0], 0), '時間切れの後も確かめの子が生きている');
  assert.deepStrictEqual(await K.claudePing({ ...f, cmd: path.join(tmp(), 'no-such-claude'), preArgs: [] }), { ok: false, code: 'not-found', resetAt: '' });
});
