/*
 * security.test.js — Electron の守り（第1a回 SEC1。RF19・EL10・F1・F6）
 * 判断は src/security.js の純粋な関数で確かめ、本物の Electron 44 での動きは tools/electron-smoke（Windows の CI）で確かめる。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const S = require('../src/security');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const W = { app: 'file:///C:/Users/%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC/AppData/Local/Programs/NaTsu/resources/app/src/renderer/app.html',
  overlay: 'file:///C:/Users/%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC/AppData/Local/Programs/NaTsu/resources/app/src/renderer/overlay.html' };
const L = { app: 'file:///opt/natsu/src/renderer/app.html', overlay: 'file:///opt/natsu/src/renderer/overlay.html' };
const sha = (s) => `'sha256-${crypto.createHash('sha256').update(s, 'utf8').digest('base64')}'`;

test('SEC1: 窓の種類はファイルの URL で決める（? と # は見ない）。ほかのファイル・http・壊れた URL は種類なし', { timeout: 5000 }, () => {
  assert.strictEqual(S.pageKind(L.app, L, 'linux'), 'app');
  assert.strictEqual(S.pageKind(`${L.overlay}#x`, L, 'linux'), 'overlay');
  assert.strictEqual(S.pageKind(`${L.app}?a=1`, L, 'linux'), 'app');
  assert.strictEqual(S.pageKind('file:///opt/natsu/src/renderer/other.html', L, 'linux'), '');
  assert.strictEqual(S.pageKind('https://example.invalid/src/renderer/app.html', L, 'linux'), '');
  assert.strictEqual(S.pageKind('file:///opt/natsu/src/renderer/APP.html', L, 'linux'), '', 'Linux では大文字と小文字を区別する');
  for (const u of ['', 'not a url', null, undefined]) assert.strictEqual(S.pageKind(u, L, 'linux'), '', String(u));
});

test('SEC1: Windows ではドライブと大文字・小文字を区別せず、日本語のユーザー名は %E3… の形でも同じに扱う', { timeout: 5000 }, () => {
  assert.strictEqual(S.pageKind('file:///c:/users/ユーザー/appdata/local/programs/natsu/resources/app/src/renderer/APP.html', W, 'win32'), 'app');
  assert.strictEqual(S.pageKind(W.overlay, W, 'win32'), 'overlay');
  assert.strictEqual(S.pageKind('file:///D:/Users/ユーザー/AppData/Local/Programs/NaTsu/resources/app/src/renderer/app.html', W, 'win32'), '');
});

test('SEC1・RF19・EL10: 許可の頼み — マイク（音だけ）は app と overlay、画面の取り込み（44 は media の空、45 は display-capture）は overlay だけ。ほかは全部断る', { timeout: 5000 }, () => {
  const rows = [
    ['app', 'media', { mediaTypes: ['audio'] }, true], ['overlay', 'media', { mediaTypes: ['audio'] }, true], ['', 'media', { mediaTypes: ['audio'] }, false],
    ['app', 'media', { mediaTypes: ['video'] }, false], ['app', 'media', { mediaTypes: ['audio', 'video'] }, false], ['overlay', 'media', { mediaTypes: ['video'] }, false],
    ['overlay', 'media', { mediaTypes: [] }, true], ['app', 'media', { mediaTypes: [] }, false], ['', 'media', { mediaTypes: [] }, false], ['app', 'media', {}, false],
    ['overlay', 'display-capture', { mediaTypes: ['video', 'audio'] }, true], ['app', 'display-capture', {}, false], ['', 'display-capture', {}, false],
    ...['notifications', 'geolocation', 'clipboard-read', 'clipboard-sanitized-write', 'openExternal', 'fullscreen', 'midi', 'hid', 'usb', 'serial',
      'speaker-selection', 'fileSystem', 'local-fonts', 'window-management', 'unknown'].flatMap((p) => [['app', p, {}, false], ['overlay', p, {}, false]]),
  ];
  for (const [k, p, d, want] of rows) assert.strictEqual(S.allowRequest(k, p, d), want, `${k} ${p} ${JSON.stringify(d)}`);
});

test('SEC1・RF19: 許可の確かめ — media の audio だけを app と overlay に許す（マイクとスピーカーの名前が出る。カメラは出ない）', { timeout: 5000 }, () => {
  const rows = [
    ['app', 'media', { mediaType: 'audio' }, true], ['overlay', 'media', { mediaType: 'audio' }, true], ['', 'media', { mediaType: 'audio' }, false],
    ['app', 'media', { mediaType: 'video' }, false], ['app', 'media', { mediaType: 'unknown' }, false], ['app', 'media', {}, false],
    ['overlay', 'display-capture', {}, true], ['app', 'display-capture', {}, false], ['app', 'speaker-selection', {}, false], ['app', 'notifications', {}, false],
  ];
  for (const [k, p, d, want] of rows) assert.strictEqual(S.allowCheck(k, p, d), want, `${k} ${p} ${JSON.stringify(d)}`);
});

test('SEC1・F6: CSP はインラインの <script> の中身の sha256 だけを許し、ほかの script・接続・埋め込み・eval を断る', { timeout: 5000 }, () => {
  const html = '<!doctype html><style>p{}</style><script>window.a = 1;</script><p style="x">t</p><script>\nwindow.b = 2;\n</script><script src="x.js"></script>';
  const parts = S.cspFor(html).split('; ');
  assert.ok(parts.includes("default-src 'none'"));
  const script = parts.find((d) => d.startsWith('script-src '));
  assert.deepStrictEqual(script.split(' ').slice(1).sort(), [sha('window.a = 1;'), sha('\nwindow.b = 2;\n')].sort());
  for (const d of ["style-src 'unsafe-inline'", "connect-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'", "worker-src 'none'"]) assert.ok(parts.includes(d), d);
  assert.ok(!/unsafe-eval/.test(parts.join(';')) && !/unsafe-inline/.test(script), script);
  assert.strictEqual(S.cspFor('<p>x</p>').split('; ').find((d) => d.startsWith('script-src ')), "script-src 'none'");
});

test('F6: 改行が CRLF・CR のファイルでも、画面が見る中身（LF にそろえた文字）のハッシュにする', { timeout: 5000 }, () => {
  assert.strictEqual(S.cspFor('<script>\r\na();\r\n</script>'), S.cspFor('<script>\na();\n</script>'));
  assert.strictEqual(S.cspFor('<script>\ra();\r</script>'), S.cspFor('<script>\na();\n</script>'));
});

test('F6: 今の app.html と overlay.html のインラインの script は数え漏れなく1つずつ（数え漏れがあると画面が真っ白になる）', { timeout: 5000 }, () => {
  for (const f of ['src/renderer/app.html', 'src/renderer/overlay.html']) {
    const html = read(f);
    const n = (html.match(/<script\b(?![^>]*\bsrc=)[^>]*>/gi) || []).length;
    assert.ok(n >= 1, f);
    assert.strictEqual(S.inlineScriptHashes(html).length, n, f);
    assert.ok(!/\son[a-z]+=["']/i.test(html.replace(/<script\b[\s\S]*?<\/script>/gi, '')), `${f} にインラインの on…= がある（CSP で止まる）`);
  }
});

test('SEC1: 新しい窓は開かない', { timeout: 5000 }, () => {
  assert.deepStrictEqual(S.windowOpen({ url: 'https://example.invalid/' }), { action: 'deny' });
  assert.match(S.STRICT_CSP, /^default-src 'none'/);
});
