/*
 * stage1c.ipc.test.js — 第1c回 Task C-2: 設定のカード「オンライン」の IPC（cloud:*・claude:*・meeting:set-local-only）を、
 * 偽の Electron の上で main.js を本当に動かして呼ぶ（helpers/mainrun.js の --json-scene=cloud-ipc）。
 * 外へはつながない（鍵の確かめは 127.0.0.1 の偽の送り先。fake-net は外の宛先で死ぬ）。本物の claude は探さない・起こさない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const KEY = 'gsk_test_0123456789';
const { LEGACY_KEYS } = require('./helpers/json-scenes');
const run = (args) => new Promise((resolve, reject) => {
  execFile(process.execPath, [RUN, ...args], { maxBuffer: 1 << 24, timeout: 20000 }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});

test('RF30・OL3・OL5・OL7: 設定のカード「オンライン」の IPC。鍵は画面へ返らず、記録・設定・secrets.json に鍵の文字が無い', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=cloud-ipc']);
  // 状態: 鍵の代わりに「しまってあるか」だけ。設定を開いただけでは外へ通信しない（online は net.isOnline() だけ）
  // 0.7.0 U-1（設計書 D5）で意図して変えた: 送り先は OpenAI に固定。同意（consent）は返さず、settings.json の前の版の値（off・groq）は読まない
  assert.deepStrictEqual(o.status0, { ok: true, provider: { id: 'openai', label: 'OpenAI', host: 'api.openai.com' },
    hasKey: false, canStore: true, online: { up: true, why: 'ok' } });
  assert.strictEqual(o.badId.code, 'bad-id');
  assert.deepStrictEqual(o.badOther.map((r) => r.code), ['bad-id', 'bad-id', 'bad-id', 'bad-id'], 'groq・custom の名前の鍵を受け付けた（OpenAI のほかへは届かない）');
  assert.strictEqual(o.badKey.code, 'bad-key');
  assert.ok(typeof o.badKey.message === 'string' && o.badKey.message.length > 5, '断ったときの文が無い');
  assert.strictEqual(o.testNoKey.code, 'no-key');
  assert.strictEqual(o.testNoKey.message, 'OpenAI: 鍵が入っていません。');
  assert.deepStrictEqual(o.set, { ok: true });
  assert.strictEqual(o.status1.hasKey, true);
  assert.ok(o.secretsAfterSet.includes('"openai"') && !o.secretsAfterSet.includes(KEY), 'secrets.json に鍵が平文で入った');
  // 前の版の groq・custom の鍵は、openai の鍵を保存しても消しても、そのまま残る（読まず・書き換えず・消さない）
  const keysAfterSet = JSON.parse(o.secretsAfterSet).keys;
  assert.deepStrictEqual([keysAfterSet.groq, keysAfterSet.custom], [LEGACY_KEYS.groq, LEGACY_KEYS.custom], 'openai の鍵の保存で groq・custom の鍵が消えたか変わった');
  assert.ok(typeof keysAfterSet.openai === 'string' && keysAfterSet.openai !== '', 'openai の名前で鍵をしまっていない');
  // 前の版の画面が送っていた4つのキーは保存しない。settings.json に前の版が書いた値は残る（JS6）
  assert.strictEqual(o.saved.ok, true);
  const saved = JSON.parse(o.settingsAfterSave);
  assert.deepStrictEqual([saved.cloudTranscribe, saved.sttProvider, saved.sttBaseUrl, saved.sttModel], ['off', 'groq', undefined, undefined]);
  // 鍵の確かめ: 正しい鍵（前後の空白は落とす）・違う鍵。宛先は OpenAI（偽の口へ書き換え）
  assert.deepStrictEqual(o.testOk, { ok: true });
  assert.deepStrictEqual(o.setWrong, { ok: true });
  assert.strictEqual(o.testAuth.code, 'auth');
  assert.match(o.testAuth.message, /^OpenAI: 鍵が正しくないか、使えなくなっています。$/);
  assert.deepStrictEqual(o.seen, [{ method: 'GET', url: '/v1/models', auth: true }, { method: 'GET', url: '/v1/models', auth: false }]);
  // 第1b回の続き Lane F-e（利用者の PC の 0.5.0）: 返事の符号で分ける。一覧の権限だけが無い鍵は、小さな文字起こしで確かめて「使えます」
  assert.deepStrictEqual(o.testScope, { ok: true, code: 'no-model-read', message: 'OpenAI: 鍵は使えます（モデルの一覧を読む権限はありません）' });
  assert.deepStrictEqual(o.testQuota, { ok: false, code: 'quota', message: 'OpenAI: 残高が足りません（OpenAI の Billing を確かめてください）。' });
  assert.deepStrictEqual(o.testInvalid, { ok: false, code: 'invalid-key', message: 'OpenAI: 鍵が正しくありません。' });
  assert.deepStrictEqual(o.seenF.map((r) => `${r.kind} ${r.method} ${r.url}`),
    ['scope GET /v1/models', 'scope POST /v1/audio/transcriptions', 'quota GET /v1/models', 'invalid GET /v1/models']);
  assert.ok(o.engineLog.includes('文字起こしの経路: openai の鍵の確かめ → ok（no-model-read）'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('文字起こしの経路: openai の鍵の確かめ → quota'));
  assert.ok(o.engineLog.includes('文字起こしの経路: openai の鍵の確かめ → invalid-key'));
  assert.ok(!o.engineLog.some((l) => /gsk_(scope|quota|invalid)|Missing scopes|exceeded|Incorrect API key/.test(l)), '鍵か返事の文が記録に写った');
  assert.strictEqual(o.statusKeyed.provider.id, 'openai');
  assert.strictEqual(o.statusKeyed.provider.host, 'api.openai.com');
  assert.strictEqual(o.statusKeyed.hasKey, true);
  assert.deepStrictEqual(o.clear, { ok: true });
  assert.strictEqual(o.statusCleared.hasKey, false);
  const keysAfterClear = JSON.parse(o.secretsAfterClear).keys;
  assert.deepStrictEqual(keysAfterClear, { groq: LEGACY_KEYS.groq, custom: LEGACY_KEYS.custom }, '［鍵を消す］が openai のほかの鍵まで消したか変えた');
  // Claude Code: 場所が無いファイルなら子を起こさず、入れ方の文（S1）を返す。-p は呼ばない
  for (const c of [o.claude, o.claudeTest]) {
    assert.deepStrictEqual({ ...c, message: '' }, { ok: true, found: false, cmdOnly: false, method: '', message: '' });
    // 設定の画面の文: 入れ方を示し、議事録の［要約を生成］へは誘わない（要約の失敗の文をそのまま出さない）
    assert.match(c.message, /^Claude Code が見つかりません。［Claude Code を入れる］を押すと、PowerShell の窓で Anthropic の公式の入れ方（`irm https:\/\/claude\.ai\/install\.ps1 \| iex`）を実行します。入れ終わったら［Claude Code にログイン］を押してください。/);
    assert.ok(!/要約を生成|要約を作れませんでした/.test(c.message), `設定の画面に要約の失敗の文が出る: ${c.message}`);
    assert.match(c.message, /「Claude Code の場所」に入れたファイルが見つからないときは、場所を空にすると自動で探します。$/);
  }
  assert.strictEqual(o.spawns.length, 0, '子のプロセスを起こした');
  // ［この会議は PC の中だけ］: 会議の外では何もしない。false（送る側に戻す）は受け取らない
  assert.deepStrictEqual(o.localOnlyTrue, { ok: false, localOnly: false });
  assert.deepStrictEqual(o.localOnlyFalse, { ok: false, localOnly: false });
  // 鍵の文字は、返事・設定・記録のどこにも無い（記録は送り先の名前と符号だけ）
  const blob = JSON.stringify([o.status0, o.status1, o.statusKeyed, o.statusCleared, o.badId, o.badOther, o.badKey, o.set, o.testOk, o.testAuth, o.testNoKey,
    o.settingsText, o.engineLog, o.notices]);
  assert.ok(!blob.includes(KEY) && !blob.includes('gsk_wrong'), '鍵の文字が返事・設定・記録・知らせのどこかにある');
  assert.ok(o.engineLog.some((l) => l.includes('openai の鍵を保存しました')) && o.engineLog.some((l) => l.includes('openai の鍵の確かめ → auth')));
  assert.ok(!o.engineLog.some((l) => /(groq|custom) の鍵/.test(l)), 'groq・custom の鍵を扱った');
});

test('RF28: ［この会議は PC の中だけ］の IPC は片道。会議中に true の後で false が来ても PC の中だけのまま（下書きにも残る）。会議の外は { ok:false, localOnly:false }', { timeout: 30000 }, async () => {
  const o = await run(['text', '--json-scene=local-only-ipc']);
  // 会議の外: どちらの値でも何もせず、計画の表の形 { ok, localOnly } で返す
  assert.deepStrictEqual(o.idleTrue, { ok: false, localOnly: false });
  assert.deepStrictEqual(o.idleFalse, { ok: false, localOnly: false });
  assert.strictEqual(o.start.ok, true, `会議を始められない: ${JSON.stringify(o.start)}`);
  assert.strictEqual(o.draftAtStart, false);
  // 押す前の false は何も変えない（送る側のまま。下書きも false のまま）
  assert.deepStrictEqual(o.falseBefore, { ok: false, localOnly: false });
  assert.strictEqual(o.draftAfterFalseBefore, false);
  assert.deepStrictEqual(o.on, { ok: true, localOnly: true });
  assert.strictEqual(o.draftAfterOn, true);
  // 押した後の false（押し間違い・古い画面）は断り、PC の中だけのまま。下書き（落ちた後の送り直し）も true のまま
  assert.deepStrictEqual(o.off, { ok: false, localOnly: true });
  assert.deepStrictEqual(o.offAgain, { ok: false, localOnly: true });
  assert.strictEqual(o.draftAfterOff, true);
  assert.ok(o.engineLog.some((l) => l.includes('この会議は PC の中だけ: on')));
  assert.ok(!o.engineLog.some((l) => l.includes('この会議は PC の中だけ: off')), '会議の印が送る側に戻った');
  assert.deepStrictEqual(o.discard, { ok: true });
});

test('OL5・RF25・RF31: 設定の［Claude Code を確かめる］を偽の claude で通す。claude.ai なら ok、未ログイン・API キー・起こせない・分からない答えは設定の画面の文。-p は確かめの1語だけ（第1b回の続き Lane F-b）、課金の変数は子に渡らず、作業フォルダは claude-run。同時に押しても子は1つ', { timeout: 30000 }, async () => {
  const o = await run(['text', '--json-scene=claude-status']);
  assert.deepStrictEqual(o.ok, { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '' });
  // 開いたときの確かめと［Claude Code を確かめる］が重なっても auth status は1回だけ（同じ答えを使う）。
  // 第1b回の続き Lane F-b: ［確かめる］はその後に小さな -p を1つ送り、通れば verified（開いたときの確かめは送らない）
  assert.deepStrictEqual(o.both[0], { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '' });
  assert.deepStrictEqual(o.both[1], { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '', verified: true });
  assert.strictEqual(o.authAfterBoth - o.authBeforeBoth, 2, '重ねて押して auth status を2つ起こしたか、確かめの -p を送っていない');
  // ［確かめる］を同時に2回押しても、auth status と -p の1つずつ
  assert.deepStrictEqual(o.twice[0], o.twice[1]);
  assert.strictEqual(o.twice[0].verified, true);
  assert.strictEqual(o.linesAfterTwice - o.linesBeforeTwice, 2, '同時に押して子を2組起こした');
  // 利用者の PC の 0.5.0 の形: auth status は claude.ai なのに、-p は 401。開いたときの確かめは今どおり「ログイン済み」、
  // ［確かめる］はログインの案内（設定の画面の文。要約の失敗の文ではない）
  assert.deepStrictEqual(o.expiredStatus, { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '' });
  assert.deepStrictEqual(o.expired, { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: 'Claude Code のログインが切れています。設定の［Claude Code にログイン］を押してください。' });
  assert.match(o.limited.message, /^Claude の利用の上限に達しています（3:45pm に戻ります）。/);
  assert.ok(!('verified' in o.limited) && !('verified' in o.expired));
  // 混み合い・時間切れは設定の画面の自分の文（分からない答えの文に落ちない）。ログインはできているので found のまま
  assert.deepStrictEqual(o.overloaded, { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: 'Claude が混み合っています（ログインはできています）。少し待ってから［Claude Code を確かめる］を押してください。' });
  assert.deepStrictEqual(o.pingTimeout, { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: 'Claude Code が 60 秒たっても返事をしませんでした。少し待ってから［Claude Code を確かめる］を押してください。' });
  // auth status は通ったのに -p を起こせない（消された・ウイルス対策）: 見つからない扱い（カードは［Claude Code を入れる］を出す）
  assert.deepStrictEqual({ ...o.pingNotFound, message: '' }, { ok: true, found: false, cmdOnly: false, method: 'claude.ai', message: '' });
  assert.match(o.pingNotFound.message, /^Claude Code が見つかりません。［Claude Code を入れる］を押すと、/);
  assert.ok(!o.pingNotFound.message.includes('場所を空にすると'), o.pingNotFound.message);
  assert.ok(o.engineLog.includes('Claude Code の確かめの要求: timeout') && o.engineLog.includes('Claude Code の確かめの要求: not-found'), o.engineLog.join('\n'));
  const settingsText = (r) => {
    assert.ok(typeof r.message === 'string' && r.message.length > 10, `文が無い: ${JSON.stringify(r)}`);
    assert.ok(!/要約を生成|要約を作れませんでした/.test(r.message), `設定の画面に要約の失敗の文が出る: ${r.message}`);
  };
  assert.deepStrictEqual({ ...o.notLogged, message: '' }, { ok: true, found: true, cmdOnly: false, method: 'none', message: '' });
  assert.strictEqual(o.notLogged.message, 'Claude Code にログインしていないか、ログインが切れています。［Claude Code にログイン］を押してログインしてください。');
  settingsText(o.notLogged);
  assert.deepStrictEqual({ ...o.apiKey, message: '' }, { ok: true, found: true, cmdOnly: false, method: 'api_key', message: '' });
  assert.match(o.apiKey.message, /^Claude Code が API キー（従量課金）で動く設定になっています。/);
  settingsText(o.apiKey);
  assert.deepStrictEqual({ ...o.unknown, message: '' }, { ok: true, found: true, cmdOnly: false, method: 'mystery', message: '' });
  assert.match(o.unknown.message, /^Claude Code の状態を確かめられませんでした。/);
  settingsText(o.unknown);
  // 場所のファイルはあるが起こせない（実行できない中身）: 入れ方の文。場所の欄の添え書きは無い（ファイルはある）
  assert.deepStrictEqual({ ...o.noexec, message: '' }, { ok: true, found: false, cmdOnly: false, method: '', message: '' });
  assert.match(o.noexec.message, /^Claude Code が見つかりません。［Claude Code を入れる］を押すと、PowerShell の窓で Anthropic の公式の入れ方（`irm https:\/\/claude\.ai\/install\.ps1 \| iex`）を実行します。入れ終わったら［Claude Code にログイン］を押してください。/);
  assert.ok(!o.noexec.message.includes('場所を空にすると'), `ファイルがあるのに場所の欄の添え書きが出た: ${o.noexec.message}`);
  settingsText(o.noexec);
  // claude.cmd の場所は設定の決まり（exe）で空になる（F12）ので、ここでは試さない（findClaude の cmd-only は claude-cli.test.js が見る）
  // 偽の claude の記録: auth status と、確かめの -p（決まった1語・標準入力は空。要約の -p は無い）だけ。課金の変数は無い・作業フォルダは claude-run
  assert.ok(o.claudeLog.length >= 4, `auth status の記録が足りない: ${o.claudeLog.length}`);
  for (const r of o.claudeLog) {
    assert.ok(r.kind === 'auth' || r.kind === 'p', r.kind);
    if (r.kind === 'p') {
      assert.deepStrictEqual(r.args.slice(0, 2), ['-p', 'ping'], '確かめのほかの -p を呼んだ');
      assert.strictEqual(r.stdinBytes, 0);
    }
    assert.deepStrictEqual(r.envKeys, [], `課金の変数が子に渡った: ${r.envKeys}`);
    assert.strictEqual(path.basename(r.cwd), 'claude-run');
  }
  // -p は auth status が claude.ai のときだけ（both・twice・expired・limited・overloaded の5回。未ログイン・API キー・分からない答えでは送らない。
  // 記録は時間切れと起こせない場合の前に取る）
  assert.strictEqual(o.claudeLog.filter((r) => r.kind === 'p').length, 5);
  assert.ok(o.engineLog.some((l) => l.includes('Claude Code の確かめ: ok（claude.ai）')));
  assert.ok(o.engineLog.some((l) => l.includes('Claude Code の確かめ: api-billing')));
  assert.ok(o.engineLog.includes('Claude Code の確かめの要求: ok'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('Claude Code の確かめの要求: auth-expired（subtype=success・api_error_status=401）'));
  assert.ok(!o.engineLog.some((l) => /OAuth|authenticate|hit your/i.test(l)), '返事の英語の文が記録に写った');
});

// 第1b回の続き Lane F-c・F-d（利用者は PowerShell を打たない）: ［Claude Code にログイン］は見つけた claude.exe の auth login を、
// ［Claude Code を入れる］は Anthropic の公式の入れ方を、見える窓で開き、閉じたら確かめ直す。窓を開くのは隠した PowerShell で、
// claude.exe の場所は環境の変数だけで渡す。窓は1つずつ。NaTsu はログインの情報を読まない
test('Lane F-c・F-d: ログインと入れる窓の IPC。閉じたら確かめ直し（ログインの後は小さな要求まで）、窓は1つずつ、開けなければ設定の画面の文', { timeout: 30000 }, async () => {
  const o = await run(['text', '--json-scene=claude-window']);
  const decode = (l) => Buffer.from(l.args[l.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  // ログイン: 窓が閉じたら auth status と確かめの要求まで通して「確かめ済み」
  assert.deepStrictEqual(o.login, { ok: true, status: { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '', verified: true } });
  assert.deepStrictEqual(o.linesAfterLogin, ['auth', 'p']);
  const login = o.launches[0];
  assert.match(login.cmd, /powershell\.exe$/i);
  assert.ok(login.exe.endsWith(path.join('bin', 'claude.exe')), login.exe);
  assert.deepStrictEqual([login.shell, login.windowsHide], [false, true]);
  assert.deepStrictEqual(login.billingKeys, [], '課金の変数がログインの窓に渡った');
  assert.match(decode(login), /Start-Process -FilePath \$env:NATSU_CLAUDE_EXE -ArgumentList 'auth','login'/);
  assert.ok(!decode(login).includes('claude.exe') && !JSON.stringify(login.args).includes('claude.exe'), '場所が命令の文字に入った');
  // 窓は1つずつ: 同時の2つ目は busy（開かない）
  const busy = o.both.find((r) => r.code === 'busy');
  assert.ok(busy && o.both.some((r) => r.ok === true), JSON.stringify(o.both));
  assert.strictEqual(busy.message, 'Claude Code の窓がもう開いています。窓での操作が終わったら閉じてください。');
  // 入れる: 窓が閉じたら auth status まで（要求は送らない）
  assert.deepStrictEqual(o.install, { ok: true, status: { ok: true, found: true, cmdOnly: false, method: 'claude.ai', message: '' } });
  const install = o.launches[2];
  assert.strictEqual(install.exe, '');
  assert.match(decode(install), /^\$ErrorActionPreference = 'Stop'; \$p = Start-Process -FilePath \(Join-Path \$PSHOME 'powershell\.exe'\) -ArgumentList '-NoProfile','-NoExit','-EncodedCommand'/);
  // 開けなかった（隠した PowerShell が 1 で終わった）
  assert.deepStrictEqual(o.failed, { ok: false, code: 'open-failed', message: 'Claude Code の窓を開けませんでした。少し待ってからもう一度押してください。続くときは、理由の記録を見てください。理由の記録: %APPDATA%\\natsu\\engine.log' });
  // 場所のファイルが無ければ、ログインの窓は開かず入れ方の文
  assert.strictEqual(o.savedMissing.ok, true);
  assert.strictEqual(o.loginMissing.ok, false);
  assert.strictEqual(o.loginMissing.code, 'not-found');
  assert.match(o.loginMissing.message, /^Claude Code が見つかりません。/);
  assert.strictEqual(o.launches.length, 4, `開いた窓の数が違う: ${o.launches.length}`);
  // 記録は窓の種類と符号だけ
  assert.ok(o.engineLog.includes('Claude Code の窓: login → closed'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('Claude Code の窓: install → open-failed'));
  assert.ok(!o.engineLog.some((l) => l.includes('sk-ant-test-window') || l.includes('claude.exe')), '鍵か場所が記録に写った');
});
