/*
 * electron-smoke.test.js — 小さなアプリ（tools/electron-smoke）の決め方（第0c回 EL8・C1・C7）
 * 本物の Electron は Windows の CI（electron-smoke）だけで動かす。ここでは、確かめの並び・終了コード・クリップボードの
 * 確かめ（偽物の clipboard で）・版の確かめを見る。
 */
'use strict';
const { titleAt } = require('./helpers/titles');

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../tools/electron-smoke/main.js');
const { versionIssue, versionGate } = require('../tools/electron-version');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const clipOf = (promise, { dropAbc = false, drop = null } = {}) => {
  const c = { value: '' };
  const wrap = (v) => (promise ? Promise.resolve(v) : v);
  c.readText = () => wrap(c.value);
  c.writeText = (t) => { if (!(dropAbc && t === 'abc' && c.value !== '') && t !== drop) c.value = t; return wrap(undefined); };
  return c;
};

// 第1a回 Task 3-3 で直した（意図: 全部そろって OK のときだけ 0。確かめは 12 になった）
// 第1c回 Task A-5 で直した（意図: 本物の net.request の POST（13）と safeStorage の非同期（14）を足して 14）
// 第2a1回 Task P-2 で直した（意図: 本物の src/db/server.js と本物の src/preload.js の往復（15）を足して 15）
// 第1d回 A-10 で直した（意図: Access の cookie を本物の net.request が付けるか（16）を足して 16）
// 0.9.0 O-2 で直した（意図: 録音バーの窓の setBounds が本物の Electron で getBounds にそのまま返るか（17）を足して 17）
// 0.10.0 LN-3 で直した（意図: natsu:// の登録が Windows の HKCU に "<exe>" -- "%1" の形で書かれるか（18）を足して 18）
// 0.11.1 LG-7 で直した（意図: assets/icon.png と Chromium が描いた assets/icon.svg の違う画素が 1% 未満か（19）を足して 19。RF-LG1）
test('electron-smoke: 19 の確かめ。終了コードは 19 件そろって全部 OK のときだけ 0', { timeout: 5000 }, () => {
  assert.deepStrictEqual(S.CHECKS.map(([n]) => n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const all = S.CHECKS.map(([n]) => ({ n, ok: true }));
  assert.strictEqual(S.exitCodeOf(all), 0);
  assert.strictEqual(S.exitCodeOf(all.map((r) => (r.n === 10 ? { ...r, ok: false } : r))), 1);
  assert.strictEqual(S.exitCodeOf(all.map((r) => (r.n === 14 ? { ...r, ok: false } : r))), 1);
  assert.strictEqual(S.exitCodeOf(all.map((r) => (r.n === 15 ? { ...r, ok: false } : r))), 1);
  assert.strictEqual(S.exitCodeOf(all.map((r) => (r.n === 16 ? { ...r, ok: false } : r))), 1);
  assert.strictEqual(S.exitCodeOf(all.map((r) => (r.n === 17 ? { ...r, ok: false } : r))), 1);
  assert.strictEqual(S.exitCodeOf(all.map((r) => (r.n === 18 ? { ...r, ok: false } : r))), 1);
  assert.strictEqual(S.exitCodeOf(all.map((r) => (r.n === 19 ? { ...r, ok: false } : r))), 1);
  assert.strictEqual(S.exitCodeOf(all.slice(0, 18)), 1);
  assert.strictEqual(S.exitCodeOf([]), 1);
  const lines = [];
  S.finish({ exit: () => {} }, all, { log: (l) => lines.push(l), flush: (cb) => cb() });
  assert.strictEqual(lines[lines.length - 1], '結果: 19 件とも OK');
  assert.match(read('tools/electron-smoke/main.js'), /次の 19 を確かめる/);
});

// 第2a1回 Task P-2（ST5・ST7）: 本物の Electron で、本物の server.js（utilityProcess）と本物の preload（sandbox の窓）を往復する
test('P-2: 15 番目の確かめ（本物の server.js と本物の preload）が一覧にあり、判定は純粋な dbResults', () => {
  const S = require('../tools/electron-smoke/main.js');
  assert.strictEqual(S.CHECKS.length, 19);   // 第1d回 A-10 で 16、0.9.0 O-2 で 17、0.10.0 LN-3 で 18、0.11.1 LG-7 で 19 を足した（15 の場所は変えない）
  assert.match(S.CHECKS[14][1], /src\/db\/server\.js.*src\/preload\.js/);
  const good = { got: { title: S.SMOKE_DB.title, routeText: [] }, portOnWindow: false, rejectedWhileDown: true, titleAfter: '直した', oplogRows: 1, killCode: 0, resendOk: true };
  assert.strictEqual(S.dbResults(good)[0].ok, true);
  for (const k of ['portOnWindow', 'rejectedWhileDown', 'oplogRows']) {
    const bad = { ...good, [k]: k === 'oplogRows' ? 2 : !good[k] };
    assert.strictEqual(S.dbResults(bad)[0].ok, false, k);
  }
  const src = read('tools/electron-smoke/main.js');
  assert.ok(src.includes("path.join(ROOT, 'src', 'db', 'server.js')") && src.includes("path.join(ROOT, 'src', 'preload.js')"), '本物を使っていない');
});

// P-2 の続き（計画のテストに足した）: 判定のほかの崩れも NG。読めたページ・題名・routeText・書き込み・oplog の数・kill の番号
test('P-2: dbResults は、ページが返らない・routeText が無い・題名が違う・書き込みが済まない・oplog が 0 行・kill の番号が 0 でない・同じ tx の送り直しが済みで返らない、でも NG', { timeout: 5000 }, () => {
  const good = { got: { title: S.SMOKE_DB.title, routeText: ['☁ 文字起こし: クラウド（OpenAI）1'] }, portOnWindow: false, rejectedWhileDown: true, titleAfter: '直した', oplogRows: 1, killCode: 0, resendOk: true };
  assert.deepStrictEqual(S.dbResults(good).map((r) => [r.n, r.ok]), [[15, true]]);
  const bad = [{ got: null }, { got: { title: S.SMOKE_DB.title } }, { got: { title: S.SMOKE_DB.title, routeText: '' } }, { got: { title: titleAt('2026-10-19T01:00:00.000Z'), routeText: [] } },
    { titleAfter: '' }, { titleAfter: undefined }, { oplogRows: 0 }, { oplogRows: undefined }, { killCode: 1 }, { killCode: null },
    { portOnWindow: undefined }, { rejectedWhileDown: 'rejected retry' }, { error: '子の ready が 15000ms で来ない' },
    // 済んだ締めを同じ (役 main, tx) でもう一度送ると「済み」で返る（変異 db-tx-dup は UNIQUE(role, tx) で internal になる）
    { resendOk: false }, { resendOk: undefined }, { resendOk: 'true' }];
  for (const patch of bad) assert.strictEqual(S.dbResults({ ...good, ...patch })[0].ok, false, JSON.stringify(patch));
  assert.strictEqual(S.dbResults({})[0].ok, false);
  assert.strictEqual(S.dbResults(null)[0].ok, false);
  // 止まったときは、どこで止まったかを文に残す
  assert.match(S.dbResults({ ...good, error: '子の ready が 15000ms で来ない' })[0].note, /止まった: 子の ready/);
});

test('P-2: 15 は DB の子を NaTsu DB の名前で起こし、本物の preload を sandbox の窓に付け、口を落としてから起こし直し、版を見た後・守りの確かめの前に走る', { timeout: 5000 }, () => {
  const m = read('tools/electron-smoke/main.js');
  for (const k of ["serviceName: 'NaTsu DB'", "type: 'init'", "type: 'port', role: 'main'", "type: 'port', role: 'app'", "postMessage('db:port', null, [", "send('db:lost'",
    "'meeting.finalize'", 'koeApp.pageGet(', 'koeApp.pageSetTitle(', "('meeting.finalize', finArgs, finTx)", 'o.resendOk = ', 'instanceof MessagePort', "type: 'close'", "require('node:sqlite')", 'dbResults(', 'dbChecks('])
    assert.ok(m.includes(k), k);
  const fn = m.slice(m.indexOf('async function dbChecks('));
  assert.ok(fn.indexOf('preload: PRELOAD_REAL, sandbox: true, contextIsolation: true, nodeIntegration: false') > 0, '本物の preload を sandbox の窓に付けていない');
  const boot = m.slice(m.indexOf('function boot()'), m.indexOf('async function securityChecks('));
  assert.ok(boot.indexOf('displayMediaCheck(') < boot.indexOf('dbChecks(') && boot.indexOf('dbChecks(') < boot.indexOf('securityChecks('), '15 の場所');
  // 版を見る前の所に new BrowserWindow( を書かない（dbChecks は boot() の後に置く）
  assert.ok(m.indexOf('async function dbChecks(') > m.indexOf('function boot()'));
  // 子を落とすのは 'spawn' の後（Electron の UtilityProcess の kill() は、プロセスが出来る前（pid の無い間）は何もせず false を返す。
  // Windows は起こすのが遅く、用意の前の子 B を出来る前に kill して、終わりを 10 秒待って止まった。CI run 39240983508）
  assert.ok(fn.includes("spawned: new Promise((r) => child.once('spawn', r))"), "子の 'spawn' を待てない");
  for (const k of ['a', 'b']) {
    const kill = fn.indexOf(`o.kill${k.toUpperCase()}Ok = ${k}.child.kill();`);
    assert.ok(kill > 0, `${k} の kill() の答えを残していない`);
    const waitSpawn = fn.lastIndexOf(`await within(${k}.spawned,`, kill);
    assert.ok(waitSpawn > 0 && fn.slice(waitSpawn, kill).split('\n').length <= 2, `${k} を 'spawn' を待たずに kill している`);
  }
  // 一時フォルダは日本語と 𠮷 の名前（利用者のデータに触れない）
  assert.match(fn, /mkdtempSync\(path\.join\(os\.tmpdir\(\), '[^']*[ぁ-ん一-龠][^']*𠮷[^']*'\)\)/);
  // 何もしないページのまま（見るのは preload の口）
  assert.ok(!/<script/i.test(read('tools/electron-smoke/page.html')));
});

// 第1c回 Task A-5（OL2・OL3）: 13・14 の判定（純粋）。本物の Electron で集めた観測の見本で確かめる（npm test では Electron を起こさない）
const STT_REQ = { method: 'POST', path: '/openai/v1/audio/transcriptions', authOk: true, wavOk: true, fileName: 'segment.wav', fileType: 'audio/wav',
  fields: { model: 'whisper-large-v3', language: 'ja', prompt: 'お疲れさまです。見積 検収', response_format: 'json', temperature: '0' } };
const ONLINE_GOOD = {
  text: '本日の議題は進捗の確認です。区間1', sttRequests: [STT_REQ],
  redirects: [{ status: 302, reached: true, cloud: true, code: 'net', targetHits: 0 }, { status: 307, reached: true, cloud: true, code: 'net', targetHits: 0 }],
  platform: 'win32', asyncAvailable: true, backend: '', roundTrip: true, setCode: 'ok', getBack: true, plainInFile: false, reEncryptBack: true,
};
const LINUX_BASIC = { platform: 'linux', asyncAvailable: true, backend: 'basic_text', roundTrip: true, setCode: 'unavailable', getBack: false, plainInFile: false };
test('electron-smoke: 13・14 の判定は、よい観測で OK。1つ崩すとその番号だけ NG（いつも OK を出す確かめではない）', { timeout: 5000 }, () => {
  assert.deepStrictEqual(S.onlineResults(ONLINE_GOOD).map((r) => [r.n, r.ok]), [[13, true], [14, true]]);
  // A-2 のテスト（test/stt-cloud.test.js の OL2）と同じ欄を、判定の側も同じ値で持つ
  assert.deepStrictEqual(S.SMOKE_STT.fields, STT_REQ.fields);
  const req = (patch) => ({ sttRequests: [{ ...STT_REQ, ...patch }] });
  const bad = [
    [13, { text: '' }], [13, { text: '本日の議題は進捗の確認です。区間2' }], [13, { sttRequests: [] }], [13, { sttRequests: [STT_REQ, STT_REQ] }],
    [13, req({ authOk: false })], [13, req({ wavOk: false })], [13, req({ method: 'GET' })], [13, req({ fileName: 'a.wav' })], [13, req({ fileType: 'audio/x-wav' })],
    [13, req({ fields: { ...STT_REQ.fields, language: 'en' } })], [13, req({ fields: { ...STT_REQ.fields, extra: '1' } })],
    [13, req({ fields: { model: 'whisper-large-v3', language: 'ja', response_format: 'json', temperature: '0' } })],
    // 転送（302・307）: 先へ要求が届いた・転送の元に届いていない・失敗にならなかった（code が空）・時間切れで止まった・どちらかが欠けた
    [13, { redirects: [{ status: 302, reached: true, code: 'net', targetHits: 1 }, ONLINE_GOOD.redirects[1]] }],
    [13, { redirects: [ONLINE_GOOD.redirects[0], { status: 307, reached: true, code: 'net', targetHits: 1 }] }],
    [13, { redirects: [{ status: 302, reached: false, code: 'net', targetHits: 0 }, ONLINE_GOOD.redirects[1]] }],
    [13, { redirects: [{ status: 302, reached: true, code: '', targetHits: 0 }, ONLINE_GOOD.redirects[1]] }],
    [13, { redirects: [{ status: 302, reached: true, code: 'timeout', targetHits: 0 }, ONLINE_GOOD.redirects[1]] }],
    [13, { redirects: [ONLINE_GOOD.redirects[0]] }], [13, { redirects: [] }],
    // 転送の失敗が postForm の通信の失敗（CloudSttError の net の仲間）でない: ほかの理由で投げた・返事として読んだ（bad-request など）
    [13, { redirects: [{ status: 302, reached: true, cloud: false, code: '投げた（TypeError: x is not a function）', targetHits: 0 }, ONLINE_GOOD.redirects[1]] }],
    [13, { redirects: [{ status: 302, reached: true, code: 'net', targetHits: 0 }, ONLINE_GOOD.redirects[1]] }],
    [13, { redirects: [ONLINE_GOOD.redirects[0], { status: 307, reached: true, cloud: true, code: 'bad-request', targetHits: 0 }] }],
    [13, { redirects: [{ status: 302, reached: true, cloud: true, code: 'auth', targetHits: 0 }, ONLINE_GOOD.redirects[1]] }],
    // safeStorage: 使えるのに戻らない・secrets.js で保存できない・読み返せない・ファイルに鍵の文字がある
    [14, { roundTrip: false }], [14, { setCode: 'unavailable' }], [14, { getBack: false }], [14, { plainInFile: true }],
    // shouldReEncrypt: true のときに secrets.get が暗号にし直して書き、読み戻せる（計画の「確かめられなかったこと」）
    [14, { reEncryptBack: false }], [14, { reEncryptBack: undefined }],
    // Windows で使えない は NG（Linux の basic_text だけを「使えない」で OK とする）
    [14, { asyncAvailable: false }], [14, { platform: 'win32', backend: 'basic_text', setCode: 'unavailable', getBack: false }],
    // Linux で使えないのに保存した（平文と同じ）・ファイルに鍵の文字がある
    [14, { ...LINUX_BASIC, setCode: 'ok' }], [14, { ...LINUX_BASIC, plainInFile: true }],
    [14, { ...LINUX_BASIC, backend: 'gnome_libsecret' }],
  ];
  for (const [n, patch] of bad) {
    const r = S.onlineResults({ ...ONLINE_GOOD, ...patch });
    assert.deepStrictEqual(r.filter((x) => !x.ok).map((x) => x.n), [n], `${n} ${JSON.stringify(patch)}`);
  }
  // Linux の CI（basic_text・使えない）は「使えない」で OK。鍵の保存を断り、ファイルを作らない
  // 暗号にし直す確かめ（reEncryptBack）は、しまえない Linux では求めない
  for (const linux of [LINUX_BASIC, { ...LINUX_BASIC, asyncAvailable: false, roundTrip: false }, { ...LINUX_BASIC, backend: 'unknown', roundTrip: false },
    { ...LINUX_BASIC, reEncryptBack: false }, { ...LINUX_BASIC, reEncryptBack: undefined }]) {
    const r = S.onlineResults({ ...ONLINE_GOOD, ...linux });
    assert.deepStrictEqual(r.map((x) => [x.n, x.ok]), [[13, true], [14, true]], JSON.stringify(linux));
    assert.match(r[1].note, /使えない/);
  }
  // Linux でも鍵の入れ物が使えるなら（gnome_libsecret など）、戻ることまで見る
  assert.strictEqual(S.onlineResults({ ...ONLINE_GOOD, platform: 'linux', backend: 'gnome_libsecret' })[1].ok, true);
  assert.strictEqual(S.onlineResults({ ...ONLINE_GOOD, platform: 'linux', backend: 'gnome_libsecret', reEncryptBack: false })[1].ok, false);
  // 転送の失敗は offline・cert・proxy・net のどれでも OK（timeout は上で NG）
  for (const code of ['offline', 'cert', 'proxy']) {
    assert.strictEqual(S.onlineResults({ ...ONLINE_GOOD, redirects: ONLINE_GOOD.redirects.map((d) => ({ ...d, code })) })[0].ok, true, code);
  }
  assert.deepStrictEqual(S.onlineResults({}).map((r) => [r.n, r.ok]), [[13, false], [14, false]]);
  assert.deepStrictEqual(S.onlineResults(null).map((r) => [r.n, r.ok]), [[13, false], [14, false]]);
  // 鍵は判定の文に出さない
  for (const r of S.onlineResults({ ...ONLINE_GOOD, setCode: S.SMOKE_STT.key })) assert.ok(!r.note.includes(S.SMOKE_STT.key), r.note);
});

// 14 の「暗号にし直した後に読み戻す」確かめの道具そのもの（本物の safeStorage が要るのは Windows の CI だけなので、ここでは偽物で見る）
test('electron-smoke: reEncryptCheck は、secrets.get が暗号にし直して書き、読み戻せたときだけ true（書き直さない・壊れた暗号・鍵が無いは false）', { timeout: 5000 }, async () => {
  const os = require('node:os');
  const J = require('../src/jsonfile');
  const { makeSecrets } = require('../src/secrets');
  // 同じ文字から毎回同じ暗号ができる偽物（書いた回数で書き直しを見分けられることも見る）
  const fake = ({ encFails = false, encBad = false, garble = false } = {}) => {
    let n = 0;
    return {
      isAsyncEncryptionAvailable: async () => true,
      getSelectedStorageBackend: () => 'dpapi',
      encryptStringAsync: async (str) => { n += 1; if (encFails && n > 1) throw new Error('enc'); if (encBad && n > 1) return Buffer.from('E:zz'); return Buffer.from(`E:${Buffer.from(str).toString('hex')}`); },
      decryptStringAsync: async (b) => ({ result: garble ? 'x' : Buffer.from(String(b).slice(2), 'hex').toString('utf8'), shouldReEncrypt: false }),
    };
  };
  const fileWith = async (safe) => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-smoke-re-')), 'secrets.json');
    assert.deepStrictEqual(await makeSecrets({ file, safeStorage: safe, J }).set('relay', S.SMOKE_STT.key), { ok: true });
    return file;
  };
  assert.strictEqual(await S.reEncryptCheck({ file: await fileWith(fake()), safeStorage: fake() }), true);
  // 暗号にし直せない（get は鍵を返すが、書き直さない）
  const failing = fake({ encFails: true });
  assert.strictEqual(await S.reEncryptCheck({ file: await fileWith(failing), safeStorage: failing }), false);
  // 暗号にし直した文字を、別の係で読み戻せない
  const bad = fake({ encBad: true });
  assert.strictEqual(await S.reEncryptCheck({ file: await fileWith(bad), safeStorage: bad }), false);
  // 復号して違う文字になる
  assert.strictEqual(await S.reEncryptCheck({ file: await fileWith(fake()), safeStorage: fake({ garble: true }) }), false);
  // しまった鍵が無い
  const empty = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-smoke-re-')), 'secrets.json');
  assert.strictEqual(await S.reEncryptCheck({ file: empty, safeStorage: fake() }), false);
});

// 第1d回 A-4（F11）で意図して変えた: PC から OpenAI へ直に送る transcribeCloud を消したので、13 は残した postForm・buildMultipart で
// 同じ multipart を組んで本物の net.request で送る（fake-net が本物と同じかの確かめという意図は同じ）。14 の鍵の名前は relay（しまえる名前が relay だけ）
test('electron-smoke: 13・14 は本物の net.request を postForm（buildMultipart の multipart）に渡し、127.0.0.1 の偽の送り先と、本物の safeStorage を secrets.js で使う', { timeout: 5000 }, () => {
  const m = read('tools/electron-smoke/main.js');
  assert.ok(!m.includes('transcribeCloud') && !m.includes('resolveProvider'), '消した直の道を呼んでいる');
  for (const k of ["require('../../src/stt-cloud')", "require('../../src/secrets')", "require('../../src/jsonfile')", "require('../../test/helpers/fake-stt')",
    'const request = (opts) => net.request(opts)', 'smokeTranscribe(lib.silentWav(0.5), { request, base', 'sttCloud.buildMultipart(', 'sttCloud.postForm({ request', "set('relay'", 'makeSecrets(', 'isAsyncEncryptionAvailable()', 'encryptStringAsync(', 'decryptStringAsync(',
    'getSelectedStorageBackend()', "listen(0, '127.0.0.1'", 'onlineResults(', 'onlineChecks(',
    // 暗号にし直す道: 本物の decryptStringAsync の返りに shouldReEncrypt: true を足す包みで secrets.get を呼ぶ
    'shouldReEncrypt: true', 'o.reEncryptBack =', 'cloud = e instanceof sttCloud.CloudSttError', 'writeJsonFile: (...a) => { const r = J.writeJsonFile(...a); writes += 1;'])
    assert.ok(m.includes(k), k);
  assert.ok(!/\bfetch\(/.test(m), 'fetch( を使っている');
  // 1〜12 の後に足す（守りの確かめの install より後。finish の前）
  const boot = m.slice(m.indexOf('function boot()'));
  assert.ok(boot.indexOf('securityChecks(') < boot.indexOf('onlineChecks(') && boot.indexOf('onlineChecks(') < boot.indexOf('finish(app, results)'), '13・14 の場所');
  assert.ok(!/require\('electron'\)/.test(m.slice(0, m.indexOf('function boot()'))), 'boot() より前で electron を読んでいる');
});

const GOOD = { sandboxed: true, inlineRan: true, injectedRan: false, violations: 1, gumAudio: 'ok', audioLabels: 2, gumVideo: 'NotAllowedError',
  gdmApp: 'NotAllowedError', gdmOverlay: 'AbortError', handlerCalls: 1, urlAfter: 'sec-app.html', opened: false };
test('electron-smoke: 守りの確かめ（8〜12）は、よい観測で全部 OK。1つ崩すとその番号だけ NG（いつも OK を出す確かめではない）', { timeout: 5000 }, () => {
  assert.deepStrictEqual(S.securityResults(GOOD).map((r) => [r.n, r.ok]), [[8, true], [9, true], [10, true], [11, true], [12, true]]);
  const bad = [
    [8, { sandboxed: false }], [9, { inlineRan: false }], [9, { injectedRan: true }], [9, { violations: 0 }],
    [10, { audioLabels: 0 }], [10, { gumAudio: 'NotAllowedError' }], [10, { gumVideo: 'ok' }], [10, { gdmApp: 'AbortError' }],
    [11, { gdmOverlay: 'NotAllowedError' }], [11, { handlerCalls: 2 }], [12, { urlAfter: '' }], [12, { opened: true }],
  ];
  for (const [n, patch] of bad) {
    const r = S.securityResults({ ...GOOD, ...patch });
    assert.deepStrictEqual(r.filter((x) => !x.ok).map((x) => x.n), [n], `${n} ${JSON.stringify(patch)}`);
  }
});

test('electron-smoke: 守りの確かめは別の session に付け（1〜7 の受け口を変えない）、本物の security.install と偽のマイクを使う', { timeout: 5000 }, () => {
  const m = read('tools/electron-smoke/main.js');
  for (const k of ["session.fromPartition('natsu-sec-smoke')", "require('../../src/security')", "appendSwitch('use-fake-device-for-media-stream')", 'security.install(', 'sec-app.html', 'sec-overlay.html'])
    assert.ok(m.includes(k), k);
  assert.ok(m.indexOf('displayMediaCheck(') < m.indexOf('securityChecks('), '1〜7 より先に守りを付けている');
  for (const f of ['tools/electron-smoke/sec-app.html', 'tools/electron-smoke/sec-overlay.html']) assert.match(read(f), /<script>window\.inlineRan = true;/);
});

test('electron-smoke: クリップボードの確かめは、44 の形（Promise）でも 31 の形でも 5・6 が OK', async () => {
  for (const promise of [true, false]) {
    const r = await S.clipboardChecks(clipOf(promise));
    assert.deepStrictEqual(r.map((x) => [x.n, x.ok]), [[5, true], [6, true]], `${promise}: ${JSON.stringify(r)}`);
  }
});

test('electron-smoke: 元に戻らない clipboard では 6 が NG になる（いつも OK を出す確かめではない）', async () => {
  const r = await S.clipboardChecks(clipOf(true, { dropAbc: true }));
  assert.deepStrictEqual(r.map((x) => [x.n, x.ok]), [[5, true], [6, false]]);
});

test('electron-smoke: 書いた文が読み返せない clipboard では 5 が NG になる（5 もいつも OK を出す確かめではない）', async () => {
  for (const promise of [true, false]) {
    const r = await S.clipboardChecks(clipOf(promise, { drop: 'NaTsu の試し' }));
    assert.deepStrictEqual(r.map((x) => [x.n, x.ok]), [[5, false], [6, true]], `${promise}: ${JSON.stringify(r)}`);
  }
});

test('electron-version: 動いている Electron が package.json の版と違えば、その旨を返す', () => {
  const pkg = { devDependencies: { electron: '44.9.0' } };
  assert.strictEqual(versionIssue({ electron: '44.9.0' }, pkg), '');
  assert.match(versionIssue({ electron: '31.7.7' }, pkg), /31\.7\.7.*44\.9\.0/);
  assert.match(versionIssue({}, pkg), /44\.9\.0/);
  assert.match(versionIssue({ electron: '44.9.0' }, { devDependencies: { electron: '^44.9.0' } }), /x\.y\.z/);
});

test('electron-version: versionGate は、問題があれば「NG 版: …」を出し、出力を流し切ってから 1 で終え、true を返す（無ければ何もしない）', () => {
  const run = (issue) => {
    const ev = [];
    const app = { exit: (c) => ev.push(['exit', c]) };
    const stop = versionGate(app, issue, { log: (l) => ev.push(['log', l]), flush: (cb) => { ev.push(['flush']); cb(); } });
    return { stop, ev };
  };
  assert.deepStrictEqual(run(''), { stop: false, ev: [] });
  const r = run('動いている Electron は 31.7.7、package.json は 44.9.0');
  assert.strictEqual(r.stop, true);
  assert.deepStrictEqual(r.ev, [['log', 'NG 版: 動いている Electron は 31.7.7、package.json は 44.9.0'], ['flush'], ['exit', 1]]);
  // 流し切る前には終えない
  const ev = [];
  versionGate({ exit: (c) => ev.push(c) }, 'x', { log: () => {}, flush: () => {} });
  assert.deepStrictEqual(ev, []);
});

test('electron-smoke の形: sandbox の窓で preload を使い、utilityProcess と口で往復し、落として起こし直し、Electron の main のときだけ動く', () => {
  const m = read('tools/electron-smoke/main.js');
  for (const k of ['sandbox: true', 'contextIsolation: true', 'nodeIntegration: false', 'utilityProcess.fork(', 'new MessageChannelMain()',
    "child.postMessage('crash'", 'child.kill()', 'executeJavaScript(', 'setDisplayMediaRequestHandler(', 'chooseDisplayMedia(', 'if (versionGate(app, versionIssue(process.versions',
    'app.exit(0)', 'app.exit(1)', '90000', "if (process.versions.electron && process.type === 'browser') boot();"]) assert.ok(m.includes(k), k);
  // 版が違えば、窓を作る前に止める（versionGate の答えで return する）
  assert.match(m, /^\s*if \(versionGate\(app, versionIssue\(process\.versions, [^\n]*\)\)\) return;$/m);
  assert.ok(m.indexOf('if (versionGate(app,') < m.indexOf('new BrowserWindow('), '窓を作った後で版を見ている');
  // electron は boot() の中でだけ読む（このテストが require するので、頭で読むと 44 の包みが本体を落としにいく）
  assert.ok(!/require\('electron'\)/.test(m.slice(0, m.indexOf('function boot()'))), 'boot() より前で electron を読んでいる');
  assert.ok(read('tools/electron-version.js').indexOf("require('electron')") < 0);
  assert.ok(read('tools/electron-smoke/child.js').includes('process.exit(3)'));
  assert.ok(read('tools/electron-smoke/child.js').includes("require('node:sqlite')"));
  const pre = read('tools/electron-smoke/preload.js');
  assert.ok(pre.includes("contextBridge.exposeInMainWorld('smoke'"));
  assert.ok(!/\bBuffer\b|setImmediate/.test(pre), '45 から sandbox の preload に無いものを使っている');
  assert.deepStrictEqual(JSON.parse(read('tools/electron-smoke/package.json')).main, 'main.js');
  assert.ok(!/<script/i.test(read('tools/electron-smoke/page.html')));
});

// 第1d回 A-10（RL9・F19・F21）: 16 は本物の Electron の net.request が、メモリの partition に cookies.set で置いた cookie を
// useSessionCookies で 127.0.0.1 へ付けるか・X-Requested-With・redirect: 'manual' の 302 でついて行かないか・Partitions のフォルダを作らないか。
// Secure の cookie を http://127.0.0.1 に置けたかは観測（secureLoopback）で、置けなければ Windows では 16b（自分で作った証明書の https の口）で見る
// 第1d回 A-11（F25・F20）: 16c 窓の守り。本物の security.install を付けたまま、ログインの partition の sandbox の窓で、許したホストへの
// フォームの送り（POST）が通って did-navigate が来る（formPosted）・許していない行き先への will-navigate（navBlocked）と will-redirect
// （redirectBlocked）が止まる・window.open が断られる（openDenied）・既定の session の窓のフォームの送りは今のまま止まる（defaultBlocked）
const GUARD_GOOD = { formPosted: true, navBlocked: true, redirectBlocked: true, openDenied: true, defaultBlocked: true };
const ACCESS_GOOD = {
  platform: 'win32', laxStrictSent: true, xrw: true, secureLoopback: true, secureSent: true, redirectEvent: true, redirectCode: 'server',
  targetHits: 0, afterRedirect: 'abort', partitionsDir: false, guard: GUARD_GOOD,
};
test('electron-smoke: 16 の判定（accessResults）は、よい観測で OK。1つ崩すと NG。Secure の cookie は観測で、置けないときだけ 16b の https で届くことを求める', { timeout: 5000 }, () => {
  assert.deepStrictEqual(S.accessResults(ACCESS_GOOD).map((r) => [r.n, r.ok]), [[16, true]]);
  // Secure が置けても届かないのは観測（失敗にしない）。後の出来事が何も来ないのも観測
  assert.strictEqual(S.accessResults({ ...ACCESS_GOOD, secureSent: false })[0].ok, true);
  assert.strictEqual(S.accessResults({ ...ACCESS_GOOD, afterRedirect: 'none' })[0].ok, true);
  for (const patch of [{ laxStrictSent: false }, { xrw: false }, { redirectEvent: false }, { redirectCode: 'net' }, { redirectCode: 'login' },
    { targetHits: 1 }, { targetHits: undefined }, { partitionsDir: true }, { partitionsDir: undefined }, { error: '止まった' }]) {
    assert.strictEqual(S.accessResults({ ...ACCESS_GOOD, ...patch })[0].ok, false, JSON.stringify(patch));
  }
  // Secure を http://127.0.0.1 に置けない Windows では 16b が要る
  const noSecure = { ...ACCESS_GOOD, secureLoopback: false, secureSent: false };
  assert.strictEqual(S.accessResults(noSecure)[0].ok, false, '16b を見ずに OK にした');
  assert.strictEqual(S.accessResults({ ...noSecure, https: { ran: true, sent: true } })[0].ok, true);
  assert.strictEqual(S.accessResults({ ...noSecure, https: { ran: true, sent: false } })[0].ok, false);
  assert.strictEqual(S.accessResults({ ...noSecure, https: { ran: false, error: 'PowerShell が無い' } })[0].ok, false);
  // Windows でなければ 16b は動かさない（観測だけ）
  assert.strictEqual(S.accessResults({ ...noSecure, platform: 'linux' })[0].ok, true);
  assert.strictEqual(S.accessResults({})[0].ok, false);
  assert.strictEqual(S.accessResults(null)[0].ok, false);
  // 16c（第1d回 A-11）: 窓の守りの観測が1つでも崩れれば NG。無ければ NG
  for (const k of Object.keys(GUARD_GOOD)) {
    assert.strictEqual(S.accessResults({ ...ACCESS_GOOD, guard: { ...GUARD_GOOD, [k]: false } })[0].ok, false, `16c の ${k}`);
  }
  assert.strictEqual(S.accessResults({ ...ACCESS_GOOD, guard: undefined })[0].ok, false, '16c を見ずに OK にした');
  assert.match(S.accessResults(ACCESS_GOOD)[0].note, /16c/);
  const note = S.accessResults({ ...noSecure, https: { ran: true, sent: true } })[0].note;
  assert.match(note, /Secure/);
  assert.match(note, /16b/);
});

test('electron-smoke: 16 は本物の net.request を stt-cloud.postForm（session・redirect: manual）に渡し、メモリの partition に cookies.set で置き、15 の後・finish の前に走る', { timeout: 5000 }, () => {
  const m = read('tools/electron-smoke/main.js');
  for (const k of ["session.fromPartition('natsu-access-smoke')", 'ses.cookies.set(', "sameSite: 'lax'", "sameSite: 'strict'", "sameSite: 'no_restriction'",
    'sttCloud.postForm({ request', "redirect: 'manual'", 'session: ses', "'Partitions'", 'accessResults(', 'accessChecks(',
    // 16b: 一時の証明書（CurrentUser\My）を作って消す・その partition にだけ指紋で通す
    'New-SelfSignedCertificate', 'Export-PfxCertificate', 'Cert:\\\\CurrentUser\\\\My', 'setCertificateVerifyProc(', 'Remove-Item'])
    assert.ok(m.includes(k), k);
  assert.ok(!m.includes("fromPartition('persist:"), 'ディスクに置く partition を使った');
  const boot = m.slice(m.indexOf('function boot()'));
  assert.ok(boot.indexOf('onlineChecks(') < boot.indexOf('accessChecks(') && boot.indexOf('accessChecks(') < boot.indexOf('finish(app, results)'), '16 の場所');
  const fn = m.slice(m.indexOf('async function accessChecks('), m.indexOf('async function accessHttpsCheck('));
  // 一時フォルダは日本語と 𠮷 の名前・鍵はリポジトリに置かない（一時フォルダに作って消す）
  const https = m.slice(m.indexOf('async function accessHttpsCheck('));
  assert.match(https, /mkdtempSync\(path\.join\(os\.tmpdir\(\), '[^']*[ぁ-ん一-龠][^']*𠮷[^']*'\)\)/);
  assert.ok(https.includes('fs.rmSync(tmp, { recursive: true, force: true })'));
  assert.ok(fn.includes('if (!o.secureLoopback && process.platform === \'win32\')'), '16b は Secure を置けない Windows だけ');
  assert.ok(!/\.pfx'\)/.test(m.slice(0, m.indexOf('async function accessHttpsCheck('))), '証明書のファイルを決まった場所に置いた');
});

// 第1d回 A-11（F25）: 16c は、8〜12 で付けた本物の security.install（1つだけ。2つ付けるとログインの窓も全体の止めに当たる）に
// isLoginContents（partition natsu-access-smoke）と loginGuard（試しの行き先: 127.0.0.1 のその口）を渡したまま、ログインの partition の窓で見る
test('electron-smoke: 16c は 8〜12 の security.install に isLoginContents と loginGuard を渡し、accessChecks の中で sandbox のログインの partition の窓と既定の session の窓のフォームの送り・移動・転送・window.open を見る', { timeout: 5000 }, () => {
  const m = read('tools/electron-smoke/main.js');
  const sec = m.slice(m.indexOf('async function securityChecks('), m.indexOf('async function smokeTranscribe('));
  assert.ok(sec.includes('security.install({ app, session: ses, pages: PAGES, log: (l) => console.log(`参考: ${l}`), isLoginContents: smokeIsLogin, loginGuard: smokeLoginGuard });'), '8〜12 の install にログインの窓の守りを渡していない');
  assert.strictEqual((m.match(/security\.install\(/g) || []).length, 1, 'security.install を2回付けた（ログインの窓も全体の止めに当たる）');
  const fn = m.slice(m.indexOf('async function accessGuardCheck('), m.indexOf('async function accessHttpsCheck('));
  for (const k of ["partition: 'natsu-access-smoke'", 'sandbox: true', "'did-navigate'", 'submit()', 'window.open(', 'smokeLoginAllow =', "'/redir'"]) assert.ok(fn.includes(k), k);
  const checks = m.slice(m.indexOf('async function accessChecks('), m.indexOf('async function accessGuardCheck('));
  assert.ok(checks.includes('o.guard = await accessGuardCheck('), '16c を accessChecks から呼んでいない');
  assert.match(m, /16c/);
});

// 0.9.0 O-2（RP4・F11）: 録音バーの窓（透過・枠なし・resizable: false・focusable: false・影なし）の setBounds が、本物の Electron で
// getBounds にちょうど同じ整数の幅と高さで返るか（17）。拡大率 1 と 1.25（--only=17 --scale=1.25 の2回目の起動）の両方で、Windows の CI で見る
test('electron-smoke: 17 の判定（panelResults）は、当てた大きさが全部そのまま返り、頼んだ拡大率で動いたときだけ OK', { timeout: 5000 }, () => {
  assert.match(S.CHECKS[16][1], /setBounds/);
  assert.deepStrictEqual(S.PANEL_SIZES, [[252, 56], [56, 252], [436, 56]]);
  const good = { sizes: S.PANEL_SIZES, got: S.PANEL_SIZES.map(([w, h]) => ({ width: w, height: h })), scale: 1, want: 1 };
  assert.deepStrictEqual(S.panelResults(good).map((r) => [r.n, r.ok]), [[17, true]]);
  assert.strictEqual(S.panelResults({ ...good, scale: 1.25, want: 1.25 })[0].ok, true);
  assert.strictEqual(S.panelResults({ ...good, got: [good.got[0], { width: 56, height: 251 }, good.got[2]] })[0].ok, false, '1点ずれても OK');
  assert.strictEqual(S.panelResults({ ...good, got: [good.got[0], { width: 252, height: 56 }, good.got[2]] })[0].ok, false, '大きさが替わらなくても OK');
  assert.strictEqual(S.panelResults({ ...good, got: good.got.slice(0, 2) })[0].ok, false, '観測が足りなくても OK');
  assert.strictEqual(S.panelResults({ ...good, scale: 1, want: 1.25 })[0].ok, false, '頼んだ拡大率で動いていないのに OK');
  assert.strictEqual(S.panelResults({ ...good, error: '作れない' })[0].ok, false);
  assert.match(S.panelResults({ ...good, scale: 1.25, want: 1.25 })[0].note, /1\.25/);
  // --only=17 の起動は 17 だけをそろえれば 0
  assert.deepStrictEqual(S.checksFor(['--only=17']).map(([n]) => n), [17]);
  assert.deepStrictEqual(S.checksFor([]).map(([n]) => n), S.CHECKS.map(([n]) => n));
  assert.strictEqual(S.exitCodeOf([{ n: 17, ok: true }], S.checksFor(['--only=17'])), 0);
  assert.strictEqual(S.exitCodeOf([{ n: 17, ok: false }], S.checksFor(['--only=17'])), 1);
  assert.strictEqual(S.exitCodeOf([{ n: 17, ok: true }]), 1, '全部の起動で 17 だけでも 0 にした');
  assert.strictEqual(S.scaleFor(['--only=17', '--scale=1.25']), 1.25);
  assert.strictEqual(S.scaleFor([]), 0);
});

test('electron-smoke: 17 は本物の録音バーと同じ作りの窓（transparent・frame: false・resizable: false・focusable: false・hasShadow: false）に setBounds を当て、16 の後・finish の前に走る。拡大率はスイッチで当てる', { timeout: 5000 }, () => {
  const m = read('tools/electron-smoke/main.js');
  const fn = m.slice(m.indexOf('async function panelCheck('), m.indexOf('function panelResults('));
  for (const k of ['transparent: true', 'frame: false', 'resizable: false', 'focusable: false', 'hasShadow: false', '.setBounds(', '.getBounds()', 'scaleFactor'])
    assert.ok(fn.includes(k), k);
  assert.ok(!/backgroundThrottling/.test(fn), '透過の窓に backgroundThrottling を付けた（実機で透明が壊れる）');
  const boot = m.slice(m.indexOf('function boot()'), m.indexOf('\n}\n', m.indexOf('function boot()')));
  // ふだんの起動では 16 の後・finish の前（--only=17 の起動は版の確かめのすぐ後に 17 だけを回して終える）
  assert.ok(boot.indexOf('accessChecks(') < boot.lastIndexOf('panelCheck(') && boot.lastIndexOf('panelCheck(') < boot.indexOf('finish(app, results)'), '17 の場所');
  assert.ok(boot.indexOf('versionGate(') < boot.indexOf('panelCheck('), '--only=17 の起動で版を確かめていない');
  assert.ok(boot.indexOf("appendSwitch('force-device-scale-factor'") >= 0 && boot.indexOf("appendSwitch('force-device-scale-factor'") < boot.indexOf('app.whenReady()'), '拡大率のスイッチを ready の前に当てていない');
  assert.match(m, /次の 19 を確かめる/);   // 0.10.0 LN-3 で 18 を足した（17 の後に natsu:// の登録）。0.11.1 LG-7 で 19（ロゴの形）
  // 統合（CI run 39474527787 の electron-smoke「NG 17 … 結果が無い」）で足した: panelCheck は panelResults の配列を返すので、ふだんの起動では
  // 広げて足し、--only=17 の起動ではそのまま finish に渡す（配列を配列で包むと 17 の結果が見つからず、Windows の CI で NG になる）
  assert.ok(boot.includes('results.push(...await panelCheck('), 'ふだんの起動で panelCheck の配列を広げずに足した');
  assert.ok(boot.includes('finish(app, await panelCheck('), '--only=17 の起動で panelCheck の配列をもう一度包んだ');
});

// 0.10.0 LN-3（D72・決めたこと 144）: natsu:// の登録の判定（protocolResults）。Windows の CI でだけ、本物の setAsDefaultProtocolClient の後に
// reg query で HKCU\Software\Classes\natsu\shell\open\command の既定の値を読み、"<exe>" -- "%1" の形かを見て、確かめた後に外す
test('LN-3: 18 の判定（protocolResults）は、登録できて、コマンドがちょうど "<exe>" -- "%1" で、外せたときだけ OK。Windows でなければ確かめずに OK', { timeout: 5000 }, () => {
  assert.match(S.CHECKS[17][1], /natsu:\/\//);
  const exe = 'D:\\a\\natsu\\node_modules\\electron\\dist\\electron.exe';
  const good = { platform: 'win32', set: true, value: `"${exe}" -- "%1"`, exe, removed: true };
  assert.deepStrictEqual(S.protocolResults(good).map((r) => [r.n, r.ok]), [[18, true]]);
  for (const bad of [{ set: false }, { value: `"${exe}" "%1"` }, { value: `"${exe}" -- %1` }, { value: `"C:\\other.exe" -- "%1"` }, { value: '' }, { removed: false }]) {
    assert.strictEqual(S.protocolResults({ ...good, ...bad })[0].ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(S.protocolResults({ platform: 'linux' })[0].ok, true);
  assert.strictEqual(S.regDefaultValue('\r\nHKEY_CURRENT_USER\\Software\\Classes\\natsu\\shell\\open\\command\r\n    (既定)    REG_SZ    "C:\\x.exe" -- "%1"\r\n\r\n'), '"C:\\x.exe" -- "%1"');
  assert.strictEqual(S.regDefaultValue('    (Default)    REG_SZ    "C:\\x.exe" -- "%1"\r\n'), '"C:\\x.exe" -- "%1"');
  assert.strictEqual(S.regDefaultValue('ERROR: The system was unable to find the specified registry key or value.'), '');
});

// 0.11.1 LG-7（計画 docs/plans/2026-10-24-logo.md の RF-LG1）: tools/icon-render.js の 3次ベジェの折れ線が Chromium の描く SVG と違う形にならないか。
// Windows の CI で、本物の Electron（Chromium）が assets/icon.svg を 256px の画面の外の窓（白い地）に描いた画像と、assets/icon.png を白い地に置いた色を
// 比べ、違う画素（どれかの色が 32 より違う）が 1% 未満なら OK（iconCheck。判定は純粋な iconResults、数え方は iconDiff）
test('LG-7 RF-LG1: 19 の判定（iconResults）は、256×256 で違う画素が 1% 未満のときだけ OK。iconDiff は icon.png を白い地に置いた色と Chromium の BGRA を比べる', { timeout: 5000 }, () => {
  assert.match(S.CHECKS[18][1], /assets\/icon\.svg/);
  assert.match(S.CHECKS[18][1], /Chromium/);
  assert.match(S.CHECKS[18][1], /assets\/icon\.png/);
  // 2×1 の icon: 1つ目は半分の透明度の黒（白い地で 136 の灰）、2つ目は透明（白い地で白）
  const icon = Buffer.from([17, 17, 17, 128, 0, 0, 0, 0]);
  const onWhite = (v) => Math.round(v * 128 / 255 + 255 * (1 - 128 / 255));
  const bgra = (a, b) => Buffer.from([a, a, a, 255, b, b, b, 255]);
  assert.strictEqual(S.iconDiff(bgra(onWhite(17), 255), icon, 2, 1), 0);
  assert.strictEqual(S.iconDiff(bgra(onWhite(17) + 32, 255), icon, 2, 1), 0, '32 までの違いは同じとみなす');
  assert.strictEqual(S.iconDiff(bgra(onWhite(17) + 33, 255), icon, 2, 1), 1);
  assert.strictEqual(S.iconDiff(bgra(onWhite(17), 200), icon, 2, 1), 1, '透明な画素は白い地の色で比べる');
  // B と R の並び（toBitmap は BGRA）: 赤い icon は BGRA の 3 つ目が赤
  assert.strictEqual(S.iconDiff(Buffer.from([0, 0, 255, 255]), Buffer.from([255, 0, 0, 255]), 1, 1), 0);
  assert.strictEqual(S.iconDiff(Buffer.from([255, 0, 0, 255]), Buffer.from([255, 0, 0, 255]), 1, 1), 1);
  const ok = { width: 256, height: 256, diff: 655 };
  assert.deepStrictEqual(S.iconResults(ok).map((r) => [r.n, r.ok]), [[19, true]]);
  for (const bad of [{ diff: 656 }, { width: 512 }, { height: 320 }, { diff: undefined }, { error: '撮れなかった' }]) {
    assert.strictEqual(S.iconResults({ ...ok, ...bad })[0].ok, false, JSON.stringify(bad));
  }
  const m = read('tools/electron-smoke/main.js');
  const boot = m.slice(m.indexOf('function boot()'), m.indexOf('\n}\n', m.indexOf('function boot()')));
  assert.ok(boot.includes('results.push(...await iconCheck(') && boot.indexOf('protocolCheck(') < boot.indexOf('iconCheck(') && boot.indexOf('iconCheck(') < boot.indexOf('finish(app, results)'), '19 の場所（18 の後・finish の前）');
  const fn = m.slice(m.indexOf('async function iconCheck('), m.indexOf('\n}\n', m.indexOf('async function iconCheck(')));
  assert.match(fn, /offscreen: true/, '画面の外の窓で描かない（拡大率や画面の色の設定で撮る画像が変わる）');
  assert.match(fn, /assets', 'icon\.svg'|ICON_SVG/);
});
