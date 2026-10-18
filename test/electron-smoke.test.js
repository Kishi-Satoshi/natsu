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

test('electron-smoke: 7 つの確かめ。終了コードは 7 件そろって全部 OK のときだけ 0', () => {
  assert.deepStrictEqual(S.CHECKS.map(([n]) => n), [1, 2, 3, 4, 5, 6, 7]);
  const all = S.CHECKS.map(([n]) => ({ n, ok: true }));
  assert.strictEqual(S.exitCodeOf(all), 0);
  assert.strictEqual(S.exitCodeOf(all.map((r) => (r.n === 6 ? { ...r, ok: false } : r))), 1);
  assert.strictEqual(S.exitCodeOf(all.slice(0, 6)), 1);
  assert.strictEqual(S.exitCodeOf([]), 1);
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
