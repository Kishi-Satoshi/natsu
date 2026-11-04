/*
 * stage150.win.test.js — 0.15.0 の Windows だけの確かめ（計画 docs/plans/2026-11-03-150.md の Task PH-5・決めたこと 28・BQ7 (a)・F117）
 * 本物の Electron（node_modules の electron.exe。CI の electron-smoke のジョブが入れ、テスト全部をその Node で回す）で、NaTsu の main と同じく
 * アプリのメニューを外した窓に NaTsu の本物の画面（src/renderer/app.html。橋は偽物: test/helpers/newpopapp.js）を開き、本物のキー（sendInputEvent）の
 * Ctrl+Shift+N で新しい窓が開かず、画面の「新しいページ」の選び（#newPop）が出ることを見る。画面の受け口の決まり（変換中・設定と検索の窓の間は開かない・
 * 項目・録音中の灰色）は test/stage150.app.test.js の PH-5 が偽 DOM で見る。
 * Windows でないとき・Electron の本体が無いとき（CI の test のジョブは npm install をしない）は、ファイルの頭で抜ける（test.skip にしない。
 * ci.yml は飛ばしたテストを Linux で 0 件・Windows で 1 件しか許さない）。
 */
'use strict';
if (process.platform !== 'win32') return;

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(EXE)) return;

const { MAIN, PRELOAD } = require('./helpers/newpopapp');
const SH = require('../tools/shots/screens');
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

test('PH-5・BQ7 (a)・F117（決めたこと 28）: アプリのメニューを外した窓の中の Ctrl+Shift+N で新しい窓が開かず、画面の「新しいページ」（#newPop）が出て、項目にフォーカスがある', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-newpop-議事録𠮷-'));
  let child = null;
  try {
    const apis = SH.apiNamesOf(fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'natsu-newpop', main: 'main.js' }));
    fs.writeFileSync(path.join(dir, 'main.js'), MAIN);
    fs.writeFileSync(path.join(dir, 'preload.js'), PRELOAD);
    fs.writeFileSync(path.join(dir, 'cfg.json'), JSON.stringify({ html: path.join(ROOT, 'src', 'renderer', 'app.html'), apis, answers: SH.fixtures() }));
    const outFile = path.join(dir, 'out.json');
    const env = { ...process.env, NATSU_NEWPOP_OUT: outFile };
    delete env.ELECTRON_RUN_AS_NODE;   // electron-smoke はテストを ELECTRON_RUN_AS_NODE=1 で回す（子は本物のアプリとして起こす）
    let err = '';
    const code = await new Promise((resolve) => {
      child = spawn(EXE, [dir], { env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: false });
      child.stderr.on('data', (c) => { err += c; });
      const t = setTimeout(() => { try { child.kill(); } catch (_) { /* 終わり済み */ } }, 50000);
      child.on('exit', (c) => { clearTimeout(t); resolve(c); });
    });
    assert.ok(fs.existsSync(outFile), `小さなアプリが結果を書かない（終わりの番号 ${code}）: ${err.slice(0, 400)}`);
    const o = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.strictEqual(o.error, undefined, JSON.stringify(o));
    assert.strictEqual(o.menu, true, 'アプリのメニューが残っている');
    assert.deepStrictEqual([o.before, o.hiddenBefore], [1, true], `前提: 窓は1つで「新しいページ」は閉じている: ${JSON.stringify(o)}`);
    assert.deepStrictEqual([o.windows, o.created], [1, 1], `Ctrl+Shift+N で新しい窓が開いた: ${JSON.stringify(o)}`);
    assert.strictEqual(o.shown, true, `Ctrl+Shift+N で「新しいページ」が出ない: ${JSON.stringify(o)}`);
    assert.deepStrictEqual(o.items, ['📄 白紙のページ', '🎙️ 議事録（録音の前のページ）'], JSON.stringify(o));
    assert.strictEqual(o.focusIn, true, `「新しいページ」の項目にフォーカスが無い: ${JSON.stringify(o)}`);
    assert.strictEqual(code, 0);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        const h = setTimeout(resolve, 5000);
        const end = () => { clearTimeout(h); resolve(); };
        child.once('exit', end);
        try { child.kill(); } catch (_) { end(); }
      });
    }
    fs.rmSync(dir, RM);
  }
});
