/*
 * stage1d.ipc.test.js — 第1d回 Task A-2: ログインの IPC（account:status・start・verify・logout）を、偽の Electron の上で main.js を
 * 本当に動かして呼ぶ（helpers/mainrun.js の --json-scene=account-ipc と --relay）。中継は本物の relay/ のコードを 127.0.0.1 で
 * 包んだもの（helpers/relay-local.js）で、偽の Electron の net.request が RELAY_BASE を書き換えて届ける。外へはつながない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const runOnce = (args) => new Promise((resolve, reject) => {
  execFile(process.execPath, [RUN, ...args], { maxBuffer: 1 << 24, timeout: 20000 }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});
// 同じ場面は1回だけ動かし、どのテストも同じ結果を見る（場面は順に start・verify・logout と進む1つの流れ）
const cache = new Map();
const run = (args) => { const k = args.join(' '); if (!cache.has(k)) cache.set(k, runOnce(args)); return cache.get(k); };
const HOST = 'natsu-relay.-unset-.workers.dev';
const R8 = (n) => `確認コードが違います（あと ${n} 回試せます）。メールの 6 けたを入れ直してください。`;
const R13 = '文字起こしの中継につながりませんでした。インターネットにつながっているかを確かめてください。';
const R16 = 'この PC ではログインの情報をしまえません（暗号にする仕組みが使えません）。管理者に知らせてください。';
// 6 けたのコードが文字の中に「ほかの数字の一部でなく」あるか（記録の時刻などの長い数字に偶然含まれるのは数えない）
const hasCode = (text, code) => new RegExp(`(?<![0-9])${code}(?![0-9])`).test(text);

test('RL10・RF32・F1: account:start → account:verify でログインし、札は secrets.json に暗号の文字でだけ入り、settings.json には accountEmail だけ。どの IPC の答え・engine.log・知らせにも札とコードが無い', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=account-ipc', '--relay=text']);
  // 設定を開いた形: ログインしていない。外へは通信しない
  assert.deepStrictEqual(o.status0, { ok: true, signedIn: false, email: '', method: 'email', canStore: true, online: { up: true, why: 'ok' } });
  assert.deepStrictEqual(o.start, { ok: true });
  assert.match(o.code, /^[0-9]{6}$/, '偽の Resend にコードが届いていない');
  assert.deepStrictEqual(o.wrong, { ok: false, code: 'code', message: R8(4), left: 4 });
  assert.deepStrictEqual(o.verify, { ok: true, email: o.mail });
  assert.match(o.token, /^nt1_[A-Za-z0-9_-]{43}$/, 'secrets.json の relay の暗号を戻すと中継の札の形でない');
  assert.deepStrictEqual(Object.keys(JSON.parse(o.secretsRaw).keys), ['relay']);
  assert.ok(!o.secretsRaw.includes(o.token), 'secrets.json に札が平文で入った');
  assert.strictEqual(JSON.parse(o.settingsAfter).accountEmail, o.mail);
  assert.deepStrictEqual(o.status1, { ok: true, signedIn: true, email: o.mail, method: 'email', canStore: true, online: { up: true, why: 'ok' } });
  // 札とコードは、IPC の答え・settings.json・engine.log・知らせのどこにも無い
  const blob = JSON.stringify([o.status0, o.start, o.wrong, o.verify, o.status1, o.saveSpoof, o.logout, o.status2, o.logoutDown, o.startDown,
    o.settingsAfter, o.settingsAfterLogout, o.engineLog, o.notices, o.balloons]);
  assert.ok(!blob.includes(o.token), '札の文字が答え・設定・記録・知らせのどこかにある');
  assert.ok(!hasCode(blob, o.code) && !hasCode(blob, o.code2), '確認コードが答え・設定・記録・知らせのどこかにある');
  assert.ok(!JSON.stringify(o.engineLog).includes(o.mail), 'engine.log にメールアドレスがある');
  // 記録は符号だけ（計画「engine.log に書く行」）
  assert.ok(o.engineLog.includes('アカウント: 確認コードを頼んだ（sent）'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('アカウント: ログインした'));
  // 画面の［保存］は accountEmail を書き換えられない（ログインの印は main だけが書く）
  assert.strictEqual(o.saveSpoof.ok, true);
  assert.strictEqual(JSON.parse(o.settingsAfterSpoof).accountEmail, o.mail, '画面から来た accountEmail で書き換えた');
});

test('RL10: account:status は外へ通信しない（偽の中継に要求が来ない。/auth/me も呼ばない）で、signedIn・email・method・canStore・online を返す', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=account-ipc', '--relay=text']);
  // ログインする前・した後・オフライン・ログアウトの後の4回とも、呼ぶ前と後で中継への要求の数が同じ
  assert.deepStrictEqual(o.statusCalls, [0, 0, 0, 0], 'account:status で中継へ要求を出した');
  assert.ok(o.relayCalls.includes('/auth/start') && o.relayCalls.includes('/auth/verify'), `中継への要求を数えられていない: ${o.relayCalls}`);
  assert.ok(!o.relayCalls.some((p) => p.startsWith('/auth/me')), '/auth/me を呼んだ');
  assert.deepStrictEqual(o.statusOffline.online, { up: false, why: 'offline' });
  assert.strictEqual(o.statusOffline.signedIn, true);
});

test('RL10: account:logout は中継へ /auth/logout を送って札を取り消し、届かなくても PC の札を消す。accountEmail も消す', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=account-ipc', '--relay=text']);
  // 届くとき: 中継の札が取り消され（D1 の revoked_at）、PC の札とメールが消える
  assert.deepStrictEqual(o.logout, { ok: true, message: 'ログアウトしました。これからは PC の中で文字起こしします。' });
  assert.strictEqual(o.revokedAfterLogout, 1, '中継の札を取り消していない');
  assert.ok(!JSON.parse(o.secretsAfterLogout).keys.relay, 'PC の札が残っている');
  assert.strictEqual(JSON.parse(o.settingsAfterLogout).accountEmail, '');
  assert.deepStrictEqual(o.status2, { ok: true, signedIn: false, email: '', method: 'email', canStore: true, online: { up: true, why: 'ok' } });
  assert.ok(o.engineLog.includes('アカウント: ログアウトした（中継 ok）'));
  // 届かないとき（中継の前で切れる）: PC の札は消す。中継の札は残る（使わなければ 30 日で切れる）
  assert.deepStrictEqual(o.verify2, { ok: true, email: o.mail });
  assert.deepStrictEqual(o.logoutDown, { ok: true, message: 'ログアウトしました。これからは PC の中で文字起こしします。' });
  assert.ok(!JSON.parse(o.secretsAfterLogoutDown).keys.relay, '中継に届かないときに PC の札を残した');
  assert.strictEqual(JSON.parse(o.settingsAfterLogoutDown).accountEmail, '');
  assert.ok(o.engineLog.includes('アカウント: ログアウトした（中継 届かない）'), o.engineLog.join('\n'));
  // 届かないときの start は投げずに R13
  assert.deepStrictEqual(o.startDown, { ok: false, code: 'net', message: R13 });
  // ログインしていないときの logout は中継へ送らない
  assert.deepStrictEqual(o.logoutSignedOut, { ok: true, message: 'ログアウトしました。これからは PC の中で文字起こしします。' });
  assert.strictEqual(o.callsAtSignedOutLogout, 0, 'ログインしていないのに中継へ /auth/logout を送った');
});

test('RL10: 中継の断りの符号ごとに R4〜R10 の文を返し、形の悪いメールとコードは中継へ送らずに断る（コードの回数を使わない）', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=account-ipc', '--relay=text']);
  assert.deepStrictEqual(o.startDomain, { ok: false, code: 'domain', message: 'このメールアドレスでは登録できません。会社のメールアドレスを入れてください。' });
  assert.deepStrictEqual(o.startBad, { ok: false, code: 'bad-email', message: 'メールアドレスの形が正しくありません。入れ直してください。' });
  assert.deepStrictEqual(o.verifyBadCode, { ok: false, code: 'bad-code', message: '確認コードは 6 けたの数字です。メールの 6 けたを入れ直してください。' });
  assert.strictEqual(o.callsAtLocalRefusals, 0, '形の悪いメール・コードを中継へ送った');
  assert.deepStrictEqual(o.verifyExpired, { ok: false, code: 'code-expired', message: '確認コードの期限が切れたか、試せる回数を使い切りました。［コードを送り直す］を押してください。' });
  assert.deepStrictEqual(o.verifyBlocked, { ok: false, code: 'blocked', message: 'このメールアドレスは使えなくなっています。管理者に知らせてください。' });
  assert.strictEqual(o.rate.ok, false);
  assert.strictEqual(o.rate.code, 'rate');
  assert.ok(Number.isInteger(o.rate.retryAfter) && o.rate.retryAfter > 0 && o.rate.retryAfter <= 900, JSON.stringify(o.rate));
  assert.strictEqual(o.rate.message, `確認コードを送る回数が多すぎます。${Math.ceil(o.rate.retryAfter / 60)} 分ほど待ってから、もう一度試してください。`);
  // 全角の数字と前後の空白は、送る前に半角にして落とす（IME で打ったコード）
  assert.deepStrictEqual(o.verifyWide, { ok: true, email: o.mail });
  assert.ok(o.engineLog.includes('アカウント: 確認コードを頼んだ（domain）') && o.engineLog.includes('アカウント: 確認コードを頼んだ（rate）'), o.engineLog.join('\n'));
});

test('RL10・RF32: 暗号にできない PC（偽の safeStorage が使えない）では verify の札をしまえず R16 で返し、中継の札はその場で /auth/logout で取り消す', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=account-ipc-nostore', '--relay=text', '--no-store']);
  // 札が無ければ、settings.json に前のメールが残っていてもログインしていない（メールも返さない）
  assert.deepStrictEqual(o.status0, { ok: true, signedIn: false, email: '', method: 'email', canStore: false, online: { up: true, why: 'ok' } });
  assert.deepStrictEqual(o.start, { ok: true });
  assert.deepStrictEqual(o.verify, { ok: false, code: 'store', message: R16 });
  assert.strictEqual(o.secretsRaw, null, 'しまえない PC に secrets.json を書いた');
  assert.ok(!o.settingsAfter.includes('kaigi'), 'しまえなかったのに accountEmail を書いた');
  assert.deepStrictEqual(o.relayCalls, ['/auth/start', '/auth/verify', '/auth/logout']);
  assert.strictEqual(o.revoked, 1, '中継の札を取り消していない（使われない札が 180 日残る）');
  assert.strictEqual(o.status1.signedIn, false);
  assert.ok(o.engineLog.some((l) => /^アカウント: ログインの札をしまえません（unavailable）。中継の札を取り消しました（ok）$/.test(l)), o.engineLog.join('\n'));
});

test('RL10: ログインしたまま、もう一度ログインし直したら、前の札は中継で取り消し、新しい札だけが使える（使われない札を残さない）', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=account-relogin', '--relay=text']);
  assert.deepStrictEqual([o.verify1.ok, o.verify2.ok], [true, true], JSON.stringify([o.verify1, o.verify2]));
  assert.ok(o.tokenA && o.tokenB && o.tokenA !== o.tokenB, '2回目のログインで札が替わっていない（場面の前提）');
  assert.strictEqual(o.revoked, 1, '前の札を中継で取り消していない');
  assert.deepStrictEqual([o.meA, o.meB], [401, 200], '前の札がまだ使える・新しい札が使えない');
  assert.deepStrictEqual(o.relayCalls.filter((p) => p === '/auth/logout').length, 1);
  assert.ok(o.engineLog.includes('アカウント: 前の札を中継で取り消した（ok）'), o.engineLog.join('\n'));
  assert.ok(!JSON.stringify([o.engineLog, o.notices, o.verify1, o.verify2]).includes(o.tokenA), '前の札の文字が記録・知らせ・答えにある');
});

// ---------------------------------------------------------------- 第1d回 A-4（F11・K2）
// 0.7.0 までの鍵（会社の OpenAI の鍵が入りうる）は、起動のときに purgeOld で消す。鍵の IPC（cloud:*）の受け口は無い
const { OLD_KEY_TEXT } = require('./helpers/json-scenes');

test('F11・K2: --old-keys で起動すると、groq・openai・custom の鍵と退けた控えが消え、engine.log に「secrets: 前の鍵 4 個を消しました」が1行。ログインの札は残り、鍵の文字は記録に無い', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=old-keys', '--relay=text', '--old-keys']);
  const keys = JSON.parse(o.secretsRaw).keys;
  assert.deepStrictEqual(Object.keys(keys), ['relay'], '前の版の鍵が残った');
  assert.ok(!o.files.some((f) => f.startsWith('secrets.json.broken-')), `退けた控えが残った: ${o.files.join(',')}`);
  // 3つの鍵と控え1つ（控えにも前の鍵の暗号の文字が残りうる: A-2 の purgeOld）
  assert.deepStrictEqual(o.engineLog.filter((l) => l.startsWith('secrets: 前の鍵')), ['secrets: 前の鍵 4 個を消しました']);
  assert.strictEqual(o.status.signedIn, true, 'ログインの札まで消した');
  const blob = JSON.stringify([o.engineLog, o.notices, o.settingsText, o.status]);
  for (const k of Object.values(OLD_KEY_TEXT)) assert.ok(!blob.includes(k), `鍵の文字が記録か答えに出た: ${k}`);
  assert.ok(!blob.includes('ENC1') && !blob.includes(keys.relay), '暗号の文字が記録か答えに出た');
});

test('F11・K2: 前の版の鍵が無い PC では、起動で何も消さず、記録もしない（ログインの札はそのまま）', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=old-keys', '--relay=text']);
  assert.deepStrictEqual(Object.keys(JSON.parse(o.secretsRaw).keys), ['relay']);
  assert.deepStrictEqual(o.engineLog.filter((l) => l.startsWith('secrets:')), []);
  assert.strictEqual(o.status.signedIn, true);
});

test('F11: cloud:status・cloud:set-key・cloud:test-key・cloud:clear-key の受け口が無い（ログインの4つはある）', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=old-keys', '--relay=text', '--old-keys']);
  assert.deepStrictEqual(o.cloudHandlers, [], '鍵の IPC の受け口が残っている');
  assert.deepStrictEqual(o.accountHandlers, ['account:logout', 'account:start', 'account:status', 'account:verify']);
});
