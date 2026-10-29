/*
 * stage140.main.test.js — 0.14.0 の main の場面（計画 docs/plans/2026-10-26-140.md の Task EB-3〜）
 * 偽の Electron の上で main.js を本当に動かして確かめる（helpers/mainrun.js）。
 * EB-3（決めたこと 35・R24・F103）: 起きたときに Electron の既定のメニューを外す（Ctrl+W・Ctrl+Z・Ctrl+R を既定のメニューに横取りさせない）。
 * EB-5（決めたこと 20・33・SEC2）: 画面の行のリンクを開く口 app:open-link（開くのは https・http・mailto だけ・NaTsu のリンクはページを開く・
 *       ほかは開かずに記録に符号だけ。住所は書かない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args, { env = {}, timeout = 30000 } = {}) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, ...env }, maxBuffer: 1 << 24, timeout }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});
const T = { timeout: sceneTimeout(30000) };

test('EB-3・F103（決めたこと 35・R24）: main は起きたときに、窓を作る前に既定のメニューを1回外す（Menu.setApplicationMenu(null)）', T, async () => {
  const r = await run(['text', '--json-scene=plain']);
  assert.ok(r.windows >= 2, '前提: 録音バーと本体の窓ができる');
  assert.deepStrictEqual(r.appMenu, [{ menu: null, wins: 0 }]);
});

// ---------------------------------------------------------------- EB-5（決めたこと 20・33・SEC2）
const NL = require('../src/natsulink');
test('EB-5・SEC2（決めたこと 20・33）: app:open-link は https・http・mailto だけ shell.openExternal、NaTsu のリンクはページを開く、javascript:・file: などは開かず記録に符号だけ（住所は書かない）', T, async () => {
  const CASES = [
    ['https://example.com/a?b=1', 'ext'], ['mailto:someone', 'ext'], ['HTTP://example.com/', 'ext'],
    ['natsu://page/pm1#b:x1', 'page'], [`${NL.LINK_ORIGIN}/open#p=pm2`, 'page'],
    ['javascript:alert(1)', 'no'], ['JaVaScRiPt:alert(1)', 'no'], ['file:///c:/windows/x', 'no'], ['data:text/html,x', 'no'], ['vbscript:x', 'no'],
    [' https://example.com/', 'no'], ['https://example.com/\u0000x', 'no'], ['natsu://page/p!1', 'no'], ['natsu://settings', 'no'], [`https://example.com/${'a'.repeat(2049)}`, 'no'], [5, 'no'], [null, 'no'],
  ];
  const r = await run(['text', `--open-link=${JSON.stringify(CASES.map((c) => c[0]))}`]);
  assert.deepStrictEqual(r.openLink, CASES.map((c) => c[1] !== 'no'), '答え（開いたか）');
  assert.deepStrictEqual(r.external, CASES.filter((c) => c[1] === 'ext').map((c) => c[0]), 'shell.openExternal に渡した住所');
  assert.deepStrictEqual(r.linkSent, [{ id: 'pm1', anchor: 'b:x1' }, { id: 'pm2', anchor: '' }], 'NaTsu のリンクでページを開かない');
  const logs = r.engineLog.filter((x) => x.startsWith('リンク: 開かなかった'));
  assert.strictEqual(logs.length, CASES.filter((c) => c[1] === 'no').length, '開かなかったリンクの記録の数');
  for (const x of logs) assert.match(x, /^リンク: 開かなかった（[a-z]+）$/, '記録は符号だけ');
  for (const x of r.engineLog) assert.ok(!/example|javascript|alert|windows|vbscript|pm1|pm2|natsu:/i.test(x), `記録に住所: ${x}`);
});

// ---------------------------------------------------------------- EB-3 直し（R109）: stage140.win の小さなアプリを、偽の electron（Electron 44 と同じく Promise のクリップボード）で走らせる
// 本物の Electron は Windows の electron-smoke でだけ走るので、待ち方の誤り（Promise を文字として読む・書き戻しで止まる）をここで先に見る
const fs = require('node:fs');
const os = require('node:os');
const { MAIN, PAGE } = require('./helpers/keysapp');
function fakeElectron({ hangRead = false } = {}) {
  const st = { clip: 'もとの文', focused: '', values: { t1: '', t2: '' }, selected: false, menu: undefined, paths: {}, exit: null, writes: [] };
  const clipboard = {
    readText: () => (hangRead ? new Promise(() => {}) : Promise.resolve(st.clip)),
    writeText: (v) => { if (typeof v !== 'string') throw new TypeError('writeText: 文字でない'); st.writes.push(v); st.clip = v; return Promise.resolve(); },
  };
  const wc = {
    on() {}, focus() {}, debugger: { attach() { throw new Error('無い'); } },
    sendInputEvent(e) {
      const f = st.focused;
      if (e.type === 'char') st.values[f] += e.keyCode;
      else if (e.type === 'keyDown' && e.modifiers.includes('control')) {
        if (e.keyCode === 'Z') st.values[f] = '';
        if (e.keyCode === 'C' && st.selected) st.clip = st.values[f];
        if (e.keyCode === 'V') st.values[f] += st.clip;
      }
    },
    executeJavaScript(s) {
      if (s.includes("t.value = 'xyz'")) { st.values.t1 = 'xyz'; st.focused = 't1'; st.selected = true; return Promise.resolve(1); }
      const m = /getElementById\('(t[12])'\)\.(focus|value)/.exec(s);
      if (m && m[2] === 'focus') { st.focused = m[1]; st.selected = false; return Promise.resolve(1); }
      if (m) return Promise.resolve(st.values[m[1]]);
      if (s.includes('__natsuMark')) return Promise.resolve(1);
      return Promise.resolve(undefined);
    },
  };
  function BrowserWindow() { this.webContents = wc; }
  BrowserWindow.prototype.loadFile = () => Promise.resolve();
  BrowserWindow.prototype.show = () => {};
  BrowserWindow.prototype.focus = () => {};
  const app = { setPath: (k, v) => { st.paths[k] = v; }, whenReady: () => Promise.resolve(), exit: (c) => { st.exit = c; } };
  const Menu = { setApplicationMenu: (m) => { st.menu = m; }, getApplicationMenu: () => st.menu };
  return { st, electron: { app, BrowserWindow, Menu, clipboard } };
}
// MAIN を偽の electron で走らせる（待つ時間は縮め、40 秒の見張りだけ 300ms に）。終わる（app.exit）か 3 秒で答える
async function runKeys(main, opt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-keys-議事録𠮷-'));
  const { st, electron } = fakeElectron(opt);
  const timers = new Set();
  const fastTimeout = (fn, ms) => { const h = setTimeout(() => { timers.delete(h); fn(); }, ms >= 40000 ? 300 : 0); timers.add(h); return h; };
  const fastClear = (h) => { timers.delete(h); clearTimeout(h); };
  const req = (n) => (n === 'electron' ? electron : require(n));
  const outFile = path.join(dir, 'out.json');
  const proc = { env: { NATSU_KEYS_OUT: outFile } };
  const errs = [];
  const onRej = (e) => { errs.push(String(e && e.message || e)); };
  process.on('unhandledRejection', onRej);
  try {
    new Function('require', 'process', '__dirname', 'setTimeout', 'clearTimeout', main)(req, proc, dir, fastTimeout, fastClear);   // eslint-disable-line no-new-func
    for (let i = 0; i < 300 && st.exit === null; i++) await new Promise((r) => setTimeout(r, 10));
    const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
    return { st, out, errs, dir };
  } finally {
    process.off('unhandledRejection', onRej);
    for (const h of timers) clearTimeout(h);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
test('EB-3 直し・R109: stage140.win の小さなアプリは Electron 44 の Promise のクリップボードを待って最後まで走り、元のクリップボードを書き戻し、userData を一時フォルダに置く', { timeout: 10000 }, async () => {
  const r = await runKeys(MAIN);
  assert.deepStrictEqual(r.out, { menu: true, typed: 'abc', undone: '', copied: 'xyz', pasted: 'xyz', reloaded: false, mark: 1 });
  assert.strictEqual(r.st.exit, 0);
  assert.strictEqual(r.st.clip, 'もとの文', '元のクリップボードを書き戻さない');
  assert.strictEqual(r.st.paths.userData, path.join(r.dir, 'userData'), 'userData が一時フォルダに無い');
  assert.deepStrictEqual(r.errs, []);
  assert.ok(PAGE.includes('id="t1"') && PAGE.includes('id="t2"') && PAGE.includes('__natsuMark = 1'));
});
test('EB-3 直し・R109: 小さなアプリが止まったときは、待っていた段の名前を書く（timeout: <段>）', { timeout: 10000 }, async () => {
  const r = await runKeys(MAIN, { hangRead: true });
  assert.strictEqual(r.out && r.out.error, 'timeout: clipboard-read');
  assert.strictEqual(r.st.exit, 2);
});
