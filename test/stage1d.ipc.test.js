/*
 * stage1d.ipc.test.js — 第1d回 Task A-2・A-11: ログインの IPC（account:status・login・logout）を、偽の Electron の上で main.js を
 * 本当に動かして呼ぶ（helpers/mainrun.js の --json-scene=access-ipc と --relay）。中継は本物の relay/ のコードを 127.0.0.1 で
 * 包んだもの（helpers/relay-local.js）の前に偽の Cloudflare Access を置いたもので、偽の Electron の net.request が RELAY_BASE を書き換えて
 * 届ける。ログインの窓は偽物（mainrun の --access-login・ctx.access）。外へはつながない。
 * 第1d回 A-11 で意図して変えた: 自前のログイン（account:start・verify・確認コード・札）の試しを、Access のログインの窓の試しに替えた
 * （account:start・verify の受け口は A-12 で消した）。
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
// 同じ場面は1回だけ動かし、どのテストも同じ結果を見る（場面は順に login・logout と進む1つの流れ）
const cache = new Map();
const run = (args) => { const k = args.join(' '); if (!cache.has(k)) cache.set(k, runOnce(args)); return cache.get(k); };
const HOST = new URL(require('../src/relay').RELAY_BASE).hostname;   // 第1d回 A-10: 仮の値を書かずに RELAY_BASE から取る
// 計画「作り替え」の「画面と知らせの文」
const AR4 = 'ログインしました。インターネットにつながっているときは、クラウドで文字起こしします。';
const AR5 = 'ログインの窓を閉じたため、ログインしていません。もう一度［ログイン］を押してください。';
const AR6 = 'ログインを確かめられませんでした。もう一度［ログイン］を押してください。';
const AR7 = 'このメールアドレスでは文字起こしの中継を使えません。管理者に知らせてください。';
const R12 = 'ログアウトしました。これからは PC の中で文字起こしします。';
const R13 = '文字起こしの中継につながりませんでした。インターネットにつながっているかを確かめてください。';
const R14 = `文字起こしの中継につながりません（会社の通信の検査で止められている可能性があります）。続くときは情報システムに ${HOST} への通信の許可を頼んでください。`;
const R15 = '文字起こしの中継の準備ができていません。管理者に知らせてください。';
const R16 = 'この PC ではログインの情報をしまえません（暗号にする仕組みが使えません）。管理者に知らせてください。';
// mainrun の偽の safeStorage の暗号（'ENC1:' + hex を base64）を戻して、しまった文字（packCookies の JSON）を取り出す
const packOf = (secretsRaw) => {
  try { return JSON.parse(Buffer.from(Buffer.from(JSON.parse(secretsRaw).keys.relay, 'base64').toString('latin1').slice(5), 'hex').toString('utf8')); } catch (_) { return null; }
};
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
const noRelay = (raw) => raw === null || !JSON.parse(raw).keys.relay;
const status = (o) => ({ ok: true, signedIn: false, email: '', method: 'access', until: null, canStore: true, online: { up: true, why: 'ok' }, ...o });

test('RL10・F20・F27: account:login は本体の窓を parent にした窓（モーダルにしない）を開き、設定は partition natsu-access（persist: なし）・sandbox・contextIsolation・nodeIntegration: false・webviewTag: false・spellcheck: false。新しい窓は断り、許していないホストへの移動は止めて記録1行（ホストを書かない）', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-ipc', '--relay=text']);
  const w = o.loginWin;
  assert.ok(w, 'ログインの窓を作っていない');
  assert.deepStrictEqual(pick(w.webPreferences, ['partition', 'sandbox', 'contextIsolation', 'nodeIntegration', 'webviewTag', 'spellcheck']),
    { partition: 'natsu-access', sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false });
  assert.strictEqual(w.modal, false, 'モーダルにした（録音中のページの［■ 終了して作成］が押せなくなる: F27）');
  assert.strictEqual(w.parent, 'main');
  assert.deepStrictEqual([w.width, w.height, w.title, w.show], [480, 680, 'NaTsu のログイン', false]);
  assert.strictEqual(w.url, `${require('../src/relay').RELAY_BASE}/auth/done`);
  // 新しい窓は断る（どのログインの窓でも）
  for (const x of o.loginWins) assert.deepStrictEqual(x.openHandler, { action: 'deny' });
  // ログインの画面へのフォームの送りと /auth/done への転送は通り、許していないホストへの移動は止める（security.install の loginGuard）
  const ok = o.loginWins.find((x) => x.accessFormAllowed !== null);
  assert.deepStrictEqual([ok.accessFormAllowed, ok.redirectAllowed], [true, true], 'ログインの画面のフォームの送りを止めた（ログインが終わらない: F25）');
  assert.strictEqual(o.loginWins.find((x) => x.wanderPrevented !== null).wanderPrevented, true, '許していないホストへの移動を止めなかった');
  assert.deepStrictEqual(o.wander, { ok: false, code: 'proxy', message: R14 });
  // （A-11 の点検で意図して直した: 場面にほかのチームの Access へ行く other-team を足したので、その（access）の1行も並ぶ）
  const lines = o.engineLog.filter((l) => l.startsWith('アカウント: ログインの窓が許していない行き先'));
  assert.deepStrictEqual(lines, ['アカウント: ログインの窓が許していない行き先（other）へ行こうとしたので止めた',
    'アカウント: ログインの窓が許していない行き先（access）へ行こうとしたので止めた']);
  assert.ok(!o.engineLog.some((l) => l.includes('evil.example')), '記録にホストの名前を書いた');
  // ログインの partition の権限の頼み・確かめは全部断り、ダウンロードは止める
  assert.deepStrictEqual(o.accessPerms, { req: false, check: false, downloadPrevented: true });
});

test('F25（A-11 の点検）: ログインの窓が開いていても、本体の窓と録音バーの webContents は中継の /auth/done・Access のログインの画面への移動（will-navigate・will-frame-navigate、本体の枠も中の枠も）を全部止める。同じ移動をログインの窓は通す', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-ipc', '--relay=text']);
  const p = o.navProbe;
  assert.ok(p && Array.isArray(p.login) && p.login.length === 4, `ログインの窓が開いていない: ${JSON.stringify(p)}`);
  assert.deepStrictEqual(p.login, [true, true, true, true], 'ログインの窓が許した行き先を止めた（場面の前提）');
  assert.deepStrictEqual(p.main, [false, false, false, false], '本体の窓がログインの窓の守りになった（中継・Access へ移動できる）');
  assert.deepStrictEqual(p.overlay, [false, false, false, false], '録音バーがログインの窓の守りになった（中継・Access へ移動できる）');
});

test('A-11 の点検（R14）: ログインの窓は最初に着いた Access のホストに留める。ほかのチームの Access への転送は止めて窓を閉じ、R14 の {ホスト} は留めたホスト（natsu-test.cloudflareaccess.com）。partition を空にし、secrets に何も書かない。記録にホストを書かない', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-ipc', '--relay=text']);
  const w = o.loginWins.find((x) => x.otherTeamPrevented !== null);
  assert.ok(w, 'other-team の窓が無い（場面の前提）');
  assert.strictEqual(w.accessFormAllowed, true, '最初の Access のホストへの移動を止めた（場面の前提）');
  assert.strictEqual(w.otherTeamPrevented, true, 'ほかのチームの Access への転送を止めなかった（窓を最初の Access のホストに留めていない）');
  assert.deepStrictEqual(o.otherTeam, { ok: false, code: 'proxy', message: R14.replace(HOST, 'natsu-test.cloudflareaccess.com') });
  assert.ok(noRelay(o.otherTeamSecrets), 'secrets に書いた');
  assert.strictEqual(o.otherTeamCookies, 0, 'partition の cookie を空にしていない');
  assert.strictEqual(w.closed, true, '窓を閉じていない');
  assert.ok(!o.engineLog.some((l) => l.includes('other-team') || l.includes('natsu-test')), '記録にホストの名前を書いた');
});

test('RL10・F21: ログインできたら cookie は secrets.json に暗号の文字でだけ入り、settings.json には accountEmail だけ。どの IPC の答え・engine.log・知らせにも cookie と JWT が無い。userData の下に Partitions のフォルダが無い', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-ipc', '--relay=text']);
  assert.deepStrictEqual(o.login, { ok: true, email: o.mail, message: AR4 });
  const pack = packOf(o.secretsRaw);
  assert.ok(pack && pack.v === 1 && Number.isInteger(pack.until), 'secrets.json の relay が packCookies の形でない');
  const jwt = pack.c[0].value;
  assert.match(jwt, /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.ok(!o.secretsRaw.includes(jwt) && !o.secretsRaw.includes('CF_Authorization'), 'secrets.json に cookie が平文で入った');
  assert.strictEqual(JSON.parse(o.settingsAfter).accountEmail, o.mail);
  assert.ok(!o.settingsAfter.includes(jwt) && !o.settingsAfter.includes('CF_'), 'settings.json に cookie がある');
  assert.deepStrictEqual(o.status1, status({ signedIn: true, email: o.mail, until: pack.until }));
  const blob = JSON.stringify([o.status0, o.cancel, o.nocookie, o.denied, o.denied403, o.notready, o.failload, o.wander, o.otherTeam, o.offline, o.login, o.status1,
    o.statusOffline, o.saveSpoof, o.logout, o.status2, o.login2, o.logoutDown, o.logoutSignedOut, o.settingsAfter, o.settingsAfterLogout,
    o.engineLog, o.notices, o.balloons]);
  assert.ok(!blob.includes(jwt) && !blob.includes('eyJ'), 'cookie（JWT）の文字が答え・設定・記録・知らせのどこかにある');
  assert.ok(!JSON.stringify(o.engineLog).includes(o.mail), 'engine.log にメールアドレスがある');
  assert.strictEqual(o.cookiesOnDisk, false, 'userData の下に Partitions のフォルダがある（cookie をディスクに置いた）');
  assert.ok(o.engineLog.includes('アカウント: ログインの窓を開いた') && o.engineLog.includes('アカウント: ログインした'), o.engineLog.join('\n'));
  // 画面の［保存］は accountEmail を書き換えられない（ログインの印は main だけが書く）
  assert.strictEqual(o.saveSpoof.ok, true);
  assert.strictEqual(JSON.parse(o.settingsAfterSpoof).accountEmail, o.mail, '画面から来た accountEmail で書き換えた');
});

test('F21: しまうのは CF_Authorization（と CF_Binding）だけ。partition に CF_AppSession・ほかのホストの cookie・\'.natsu-code.workers.dev\' の cookie があっても secrets に入らない', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-ipc', '--relay=text']);
  const parent = HOST.split('.').slice(1).join('.');
  // 偽のログインの窓は、しまってはいけない cookie も partition に置いた（場面の前提）
  assert.ok(o.cookiesAfterLogin.includes(`CF_AppSession|${HOST}`) && o.cookiesAfterLogin.includes(`CF_Authorization|.${parent}`)
    && o.cookiesAfterLogin.includes('CF_Authorization|other.example'), JSON.stringify(o.cookiesAfterLogin));
  const pack = packOf(o.secretsRaw);
  assert.deepStrictEqual(pack.c.map((x) => [x.name, x.domain, x.hostOnly]), [['CF_Authorization', HOST, true]]);
});

test('RL10: ログインの直後に /v1/me で確かめ、通らなければログインしたことにしない（AR6・secrets に残さない）。403 なら AR7', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-ipc', '--relay=text']);
  assert.deepStrictEqual(o.nocookie, { ok: false, code: 'no-cookie', message: AR6 });
  assert.deepStrictEqual(o.denied, { ok: false, code: 'denied', message: AR7 });
  assert.ok(o.relayCalls.filter((p) => p === '/v1/me').length >= 2, `ログインの直後に /v1/me で確かめていない: ${o.relayCalls}`);
  for (const k of ['nocookie', 'denied']) {
    assert.ok(noRelay(o[`${k}Secrets`]), `${k}: 確かめられないのに secrets にしまった`);
    assert.strictEqual(o[`${k}Cookies`], 0, `${k}: partition の cookie を空にしていない`);
  }
  assert.ok(o.engineLog.includes('アカウント: ログインの直後の確かめが通りませんでした（denied）'), o.engineLog.join('\n'));
  assert.ok(o.engineLog.includes('アカウント: ログインできませんでした（no-cookie）'), o.engineLog.join('\n'));
});

test('RL10: /auth/done が 403 → 窓を閉じて AR7・503 → R15。did-fail-load のプロキシ → R14（{ホスト} は中継のホスト）。どれも partition を空にし、secrets に何も書かない', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-ipc', '--relay=text']);
  assert.deepStrictEqual(o.denied403, { ok: false, code: 'denied', message: AR7 });
  assert.deepStrictEqual(o.notready, { ok: false, code: 'not-ready', message: R15 });
  assert.deepStrictEqual(o.failload, { ok: false, code: 'proxy', message: R14 });
  for (const k of ['denied403', 'notready', 'failload', 'wander', 'otherTeam']) {
    assert.ok(noRelay(o[`${k}Secrets`]), `${k}: secrets に書いた`);
    assert.strictEqual(o[`${k}Cookies`], 0, `${k}: partition の cookie を空にしていない`);
  }
  // 窓はどれも閉じた（hold の窓は利用者が閉じた）
  assert.ok(o.loginWins.every((x) => x.closed), JSON.stringify(o.loginWins.map((x) => x.closed)));
});

test('RL10: 窓を閉じたら cancel（AR5）。開いている間にもう一度押しても窓は1つ（前に出す）。オフライン（net.isOnline が偽）なら窓を作らずに R13', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-ipc', '--relay=text']);
  assert.strictEqual(o.winsWhileOpen, 1, '開いている間にもう一度押して、窓を2つ作った');
  assert.ok(o.focusedWhileOpen >= 1, '2回目に押したときに前の窓を前に出していない');
  assert.deepStrictEqual(o.cancel, [{ ok: false, code: 'cancel', message: AR5 }, { ok: false, code: 'cancel', message: AR5 }]);
  assert.ok(noRelay(o.secretsAfterCancel));
  assert.deepStrictEqual(o.offline, { ok: false, code: 'offline', message: R13 });
  assert.strictEqual(o.offlineWins, 0, 'オフラインなのにログインの窓を作った');
});

test('RL10: account:status は外へ通信せず（偽の中継に要求が来ない）、signedIn・email・method: \'access\'・until・canStore・online を返す', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-ipc', '--relay=text']);
  assert.deepStrictEqual(o.status0, status({}));
  assert.deepStrictEqual(o.statusCalls, [0, 0, 0, 0], 'account:status で中継へ要求を出した');
  assert.deepStrictEqual(o.statusOffline.online, { up: false, why: 'offline' });
  assert.strictEqual(o.statusOffline.signedIn, true);
  assert.deepStrictEqual(o.status2, status({}));
});

test('RL10・F19: 期限の切れた cookie は signedIn: false（起動で消し、accountEmail も消す）。期限の内なら signedIn: true で until は cookie の期限。どちらも外へ通信しない', { timeout: 20000 }, async () => {
  const [live, dead] = await Promise.all([
    run(['text', '--json-scene=access-status', '--relay=text']),
    run(['text', '--json-scene=access-status', '--relay=text', '--relay-expired']),
  ]);
  const pack = packOf(live.secretsRaw);
  assert.deepStrictEqual(live.status, status({ signedIn: true, email: require('./helpers/relay-run').mail('kaigi'), until: pack.until }));
  assert.ok(pack.until > Date.now() / 1000);
  assert.deepStrictEqual(live.cookies, ['CF_Authorization'], 'しまった cookie を partition に戻していない');
  assert.deepStrictEqual(dead.status, status({}));
  assert.ok(noRelay(dead.secretsRaw), '期限の切れた cookie を secrets に残した');
  assert.strictEqual(JSON.parse(dead.settingsText2).accountEmail, '', '期限の切れたログインのメールを残した');
  assert.deepStrictEqual(dead.cookies, []);
  assert.ok(dead.engineLog.includes('アカウント: しまったログインの期限が切れていた'), dead.engineLog.join('\n'));
  assert.deepStrictEqual([live.statusCalls, dead.statusCalls], [0, 0]);
});

test('F22: account:logout は LOGOUT_URL を relayRequest で開き（窓は作らない・ついて行かない）、cookie を全部消し、secrets と accountEmail を消す。LOGOUT_URL に届かなくても PC からは消す。次の account:status は signedIn: false', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-ipc', '--relay=text']);
  assert.deepStrictEqual(o.logout, { ok: true, message: R12 });
  assert.deepStrictEqual(o.logoutCalls, ['/cdn-cgi/access/logout'], 'Access のログアウトを開いていない');
  assert.strictEqual(o.cookiesAfterLogout, 0, 'ログアウトで partition の cookie を消していない');
  assert.ok(o.clears.includes('all'), `ログアウトで partition の全部を空にしていない: ${o.clears}`);
  assert.ok(noRelay(o.secretsAfterLogout), 'ログアウトで secrets を消していない');
  assert.strictEqual(JSON.parse(o.settingsAfterLogout).accountEmail, '');
  assert.deepStrictEqual(o.status2, status({}));
  assert.ok(o.engineLog.includes('アカウント: ログアウトした（Access ok）'), o.engineLog.join('\n'));
  // ログアウトで作った窓は無い（ログインの窓だけ）
  assert.ok(o.loginWins.every((x) => x.webPreferences.partition === 'natsu-access'));
  // 届かないとき（中継の前で切れる）も PC からは消す
  assert.deepStrictEqual(o.login2, { ok: true, email: o.mail, message: AR4 });
  assert.deepStrictEqual(o.logoutDown, { ok: true, message: R12 });
  assert.ok(noRelay(o.secretsAfterLogoutDown), '届かないときに PC の cookie を残した');
  assert.strictEqual(JSON.parse(o.settingsAfterLogoutDown).accountEmail, '');
  assert.strictEqual(o.cookiesAfterLogoutDown, 0);
  assert.ok(o.engineLog.includes('アカウント: ログアウトした（Access 届かない）'), o.engineLog.join('\n'));
  // ログインしていないときの logout は中継へ送らない
  assert.deepStrictEqual(o.logoutSignedOut, { ok: true, message: R12 });
  assert.strictEqual(o.callsAtSignedOutLogout, 0, 'ログインしていないのに Access のログアウトを開いた');
});

test('RL10: 暗号にできない PC（偽の safeStorage が使えない）では cookie をしまえず store（R16）。partition の cookie も消し（その場のメモリだけで使い続けない）、accountEmail を書かない', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-ipc-nostore', '--relay=text', '--no-store']);
  assert.deepStrictEqual(o.status0, status({ canStore: false }));
  assert.deepStrictEqual(o.login, { ok: false, code: 'store', message: R16 });
  assert.strictEqual(o.secretsRaw, null, 'しまえない PC に secrets.json を書いた');
  assert.ok(!o.settingsAfter.includes('kaigi'), 'しまえなかったのに accountEmail を書いた');
  assert.strictEqual(o.cookies, 0, 'しまえなかった cookie を partition に残した');
  assert.strictEqual(o.status1.signedIn, false);
  assert.ok(o.engineLog.includes('アカウント: ログインの情報をしまえません（unavailable）'), o.engineLog.join('\n'));
});

test('F27: 録音中に account:login を呼んでも録音は続き、窓を開いたまま会議を止めて議事録ができる（窓はモーダルでない）。窓を閉じると cancel', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=access-recording', '--relay=text']);
  assert.strictEqual(o.winsDuring, 1);
  assert.strictEqual(o.stateDuring, 'meeting', '録音中にログインの窓を開いたら録音が止まった');
  assert.strictEqual(o.winsOpenAfterStop, 1, '会議を止めたときにログインの窓が閉じていた（場面の前提）');
  assert.strictEqual(o.m1.segments.length, 2, JSON.stringify(o.m1));
  assert.ok(o.m1.segments.every((x) => !x.failed && x.text), JSON.stringify(o.m1.segments));
  assert.strictEqual(o.loginWin.modal, false);
  assert.deepStrictEqual(o.login, { ok: false, code: 'cancel', message: AR5 });
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

// 第1d回 A-12 で意図して変えた: 前の自前のログイン（確認コード）の受け口 account:start・account:verify を消した（ログインは account:login の窓だけ）
test('F11: cloud:status・cloud:set-key・cloud:test-key・cloud:clear-key の受け口が無い。account:start・account:verify の受け口も無い（ログインの3つだけ）', { timeout: 20000 }, async () => {
  const o = await run(['text', '--json-scene=old-keys', '--relay=text', '--old-keys']);
  assert.deepStrictEqual(o.cloudHandlers, [], '鍵の IPC の受け口が残っている');
  assert.deepStrictEqual(o.accountHandlers, ['account:login', 'account:logout', 'account:status']);
});
