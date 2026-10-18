/*
 * electron-smoke.test.js — 小さなアプリ（tools/electron-smoke）の決め方（第0c回 EL8・C1・C7）
 * 本物の Electron は Windows の CI（electron-smoke）だけで動かす。ここでは、確かめの並び・終了コード・クリップボードの
 * 確かめ（偽物の clipboard で）・版の確かめを見る。
 */
'use strict';

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
test('electron-smoke: 14 の確かめ。終了コードは 14 件そろって全部 OK のときだけ 0', { timeout: 5000 }, () => {
  assert.deepStrictEqual(S.CHECKS.map(([n]) => n), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  const all = S.CHECKS.map(([n]) => ({ n, ok: true }));
  assert.strictEqual(S.exitCodeOf(all), 0);
  assert.strictEqual(S.exitCodeOf(all.map((r) => (r.n === 10 ? { ...r, ok: false } : r))), 1);
  assert.strictEqual(S.exitCodeOf(all.map((r) => (r.n === 14 ? { ...r, ok: false } : r))), 1);
  assert.strictEqual(S.exitCodeOf(all.slice(0, 13)), 1);
  assert.strictEqual(S.exitCodeOf([]), 1);
  const lines = [];
  S.finish({ exit: () => {} }, all, { log: (l) => lines.push(l), flush: (cb) => cb() });
  assert.strictEqual(lines[lines.length - 1], '結果: 14 件とも OK');
});

// 第1c回 Task A-5（OL2・OL3）: 13・14 の判定（純粋）。本物の Electron で集めた観測の見本で確かめる（npm test では Electron を起こさない）
const STT_REQ = { method: 'POST', path: '/openai/v1/audio/transcriptions', authOk: true, wavOk: true, fileName: 'segment.wav', fileType: 'audio/wav',
  fields: { model: 'whisper-large-v3', language: 'ja', prompt: 'お疲れさまです。見積 検収', response_format: 'json', temperature: '0' } };
const ONLINE_GOOD = {
  text: '本日の議題は進捗の確認です。区間1', sttRequests: [STT_REQ],
  redirects: [{ status: 302, reached: true, code: 'net', targetHits: 0 }, { status: 307, reached: true, code: 'net', targetHits: 0 }],
  platform: 'win32', asyncAvailable: true, backend: '', roundTrip: true, setCode: 'ok', getBack: true, plainInFile: false,
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
    // safeStorage: 使えるのに戻らない・secrets.js で保存できない・読み返せない・ファイルに鍵の文字がある
    [14, { roundTrip: false }], [14, { setCode: 'unavailable' }], [14, { getBack: false }], [14, { plainInFile: true }],
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
  for (const linux of [LINUX_BASIC, { ...LINUX_BASIC, asyncAvailable: false, roundTrip: false }, { ...LINUX_BASIC, backend: 'unknown', roundTrip: false }]) {
    const r = S.onlineResults({ ...ONLINE_GOOD, ...linux });
    assert.deepStrictEqual(r.map((x) => [x.n, x.ok]), [[13, true], [14, true]], JSON.stringify(linux));
    assert.match(r[1].note, /使えない/);
  }
  // Linux でも鍵の入れ物が使えるなら（gnome_libsecret など）、戻ることまで見る
  assert.strictEqual(S.onlineResults({ ...ONLINE_GOOD, platform: 'linux', backend: 'gnome_libsecret' })[1].ok, true);
  assert.deepStrictEqual(S.onlineResults({}).map((r) => [r.n, r.ok]), [[13, false], [14, false]]);
  assert.deepStrictEqual(S.onlineResults(null).map((r) => [r.n, r.ok]), [[13, false], [14, false]]);
  // 鍵は判定の文に出さない
  for (const r of S.onlineResults({ ...ONLINE_GOOD, setCode: S.SMOKE_STT.key })) assert.ok(!r.note.includes(S.SMOKE_STT.key), r.note);
});

test('electron-smoke: 13・14 は本物の net.request を transcribeCloud に渡し、127.0.0.1 の偽の送り先と、本物の safeStorage を secrets.js で使う', { timeout: 5000 }, () => {
  const m = read('tools/electron-smoke/main.js');
  for (const k of ["require('../../src/stt-cloud')", "require('../../src/secrets')", "require('../../src/jsonfile')", "require('../../test/helpers/fake-stt')",
    'const request = (opts) => net.request(opts)', 'request, provider', 'transcribeCloud(', 'makeSecrets(', 'isAsyncEncryptionAvailable()', 'encryptStringAsync(', 'decryptStringAsync(',
    'getSelectedStorageBackend()', "listen(0, '127.0.0.1'", 'onlineResults(', 'onlineChecks('])
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
