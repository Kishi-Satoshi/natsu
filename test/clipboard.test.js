/*
 * clipboard.test.js — クリップボード（#27・第0c回 EL1・C1）
 * Electron 44 では main でも clipboard.readText()／writeText() が Promise を返す。31 では文字列と undefined。
 * 両方の形の偽物で、口述の文字を Win+V の履歴に残さないこと（Electron で書かない）と、貼り付けの後に元の
 * クリップボードへ戻ること（[object Promise] にしない）を、mainlib の関数を本当に動かして確かめる。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('../src/mainlib');

// 偽のクリップボード。promise: true は 44 の形、false は 31 の形。electron に Electron で書いた文字を、seen に置かれた全部の値を残す
function fakeClip(initial = '', { promise = true, readFails = false } = {}) {
  const c = { value: initial, electron: [], seen: [initial] };
  const wrap = (v) => (promise ? Promise.resolve(v) : v);
  c.readText = () => { if (readFails) return promise ? Promise.reject(new Error('読めない')) : (() => { throw new Error('読めない'); })(); return wrap(c.value); };
  c.writeText = (t) => { c.electron.push(t); c.value = t; c.seen.push(t); return wrap(undefined); };
  return c;
}
// 偽の常駐 PowerShell。works: true なら copy の命令で（除外の印付きで）クリップボードに置く
function fakePaster(clip, { works = true } = {}) {
  const lines = [];
  const port = { writable: () => true, write: (l) => { lines.push(l); if (works && l.startsWith('copy ')) { clip.value = Buffer.from(l.slice(5).trim(), 'base64').toString('utf8'); clip.seen.push(clip.value); } } };
  return { lines, get: () => port };
}
const deps = (clip, paster, over = {}) => {
  const later = [];
  const notices = [];
  const d = { clip, paster: paster ? paster.get : () => null, sleep: async () => {}, autoPaste: true, fg: Promise.resolve('123'),
    simulatePaste: async () => 'ok', notice: (m) => notices.push(m), later: (fn, ms) => later.push({ fn, ms }), ...over };
  return { d, later, notices };
};

for (const promise of [true, false]) {
  const shape = promise ? '44 の形（Promise）' : '31 の形（文字列）';

  test(`copyPrivate（${shape}）: PowerShell が置けたら Electron で書かない（Win+V の履歴に残さない）`, async () => {
    const clip = fakeClip('', { promise });
    const p = fakePaster(clip);
    assert.strictEqual(await lib.copyPrivate('口述の文', deps(clip, p).d), 'private');
    assert.strictEqual(clip.value, '口述の文');
    assert.deepStrictEqual(clip.electron, [], 'Electron で書いた（履歴とクラウド同期に採られる）');
    assert.strictEqual(p.lines.length, 1);
    assert.match(p.lines[0], /^copy [A-Za-z0-9+/=]+\n$/);
  });

  test(`copyPrivate（${shape}）: PowerShell が居ない・置けないときだけ Electron で書く（何も残らないよりはよい）`, async () => {
    const a = fakeClip('', { promise });
    assert.strictEqual(await lib.copyPrivate('x', deps(a, null).d), 'electron');
    assert.deepStrictEqual(a.electron, ['x']);
    const b = fakeClip('', { promise });
    const p = fakePaster(b, { works: false });
    assert.strictEqual(await lib.copyPrivate('y', deps(b, p).d), 'electron');
    assert.deepStrictEqual(b.electron, ['y']);
    assert.strictEqual(p.lines.length, 1, 'Electron の書き込みより先に PowerShell に頼んでいない');
  });

  test(`deliverText（${shape}）: 貼り付けの2秒後に元の「abc」に戻る。[object Promise] にしない`, async () => {
    const clip = fakeClip('abc', { promise });
    const p = fakePaster(clip);
    const { d, later } = deps(clip, p);
    assert.strictEqual(await lib.deliverText('口述の文', d), 'ok');
    assert.strictEqual(clip.value, '口述の文');
    assert.strictEqual(later.length, 1);
    assert.strictEqual(later[0].ms, 2000);
    later[0].fn();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(clip.value, 'abc');
    assert.ok(!clip.seen.includes('[object Promise]'), clip.seen.join(' / '));
    assert.deepStrictEqual(clip.electron, [], '戻すときも Electron で書いた');
  });
}

test('deliverText: 貼り付け先が変わった・失敗したら、知らせてクリップボードに残し、戻さない', async () => {
  for (const [result, msg] of [['mismatch', '貼り付け先が変わったため、クリップボードに残しました（Ctrl+V で貼り付けられます）'],
    ['fail', '自動貼り付けに失敗しました。クリップボードに残しています']]) {
    const clip = fakeClip('abc');
    const { d, later, notices } = deps(clip, fakePaster(clip), { simulatePaste: async () => result });
    assert.strictEqual(await lib.deliverText('本文', d), result);
    assert.deepStrictEqual(notices, [msg]);
    assert.deepStrictEqual(later, []);
    assert.strictEqual(clip.value, '本文');
  }
});

test('deliverText: 自動貼り付けが切ってあれば置くだけ（貼らない・戻さない）。元が読めなくても投げない', async () => {
  const clip = fakeClip('abc');
  let pasted = 0;
  const { d, later } = deps(clip, fakePaster(clip), { autoPaste: false, simulatePaste: async () => { pasted += 1; return 'ok'; } });
  assert.strictEqual(await lib.deliverText('本文', d), undefined);
  assert.strictEqual(pasted, 0);
  assert.deepStrictEqual(later, []);
  const bad = fakeClip('abc', { readFails: true });
  const r = deps(bad, null);
  assert.strictEqual(await lib.deliverText('本文', r.d), 'ok');
  assert.deepStrictEqual(r.later, [], '読めなかった元（空）を戻そうとした');
});

test('restoreAfterPaste: 文字列でない元（Promise・null・数）は戻さない', () => {
  assert.strictEqual(lib.restoreAfterPaste(Promise.resolve('abc'), '本文'), false);
  assert.strictEqual(lib.restoreAfterPaste(null, '本文'), false);
  assert.strictEqual(lib.restoreAfterPaste(123, '本文'), false);
  assert.strictEqual(lib.restoreAfterPaste('abc', '本文'), true);
});

test('main.js: clipboard の readText／writeText を直に呼ばず、mainlib に clipboard を渡す', () => {
  const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/clipboard\.(readText|writeText)\(/.test(m), 'main.js が clipboard を直に読み書きしている（44 では Promise）');
  assert.match(m, /clip: clipboard,/);
  assert.match(m, /const copyPrivate = \(text\) => lib\.copyPrivate\(text, clipDeps\(\)\);/);
  assert.match(m, /const deliverText = \(text\) => lib\.deliverText\(text, clipDeps\(\)\);/);
});

// ---------------------------------------------------------------- 0.14.0 EK-4 直し（計画 docs/plans/2026-10-26-140.md の R153）: 要約の欄の選んだ行・区切り線の行への貼り付けで読むクリップボード
// Electron 44 の clipboard.read() は ClipboardItem の並び（types と getType(mime) → Blob）を返す
const htmlItem = (html) => ({ types: ['text/plain', 'text/html'], getType: async (t) => (t === 'text/html' ? { text: async () => html } : { text: async () => '' }) });
test('EK-4 直し（R153）: readClipRows は文字と HTML を読む（44 の形の ClipboardItem・Blob）。読むだけで書かない', async () => {
  const c = fakeClip('- 一\n- 二');
  c.read = async () => [htmlItem('<ul><li>一</li></ul>')];
  assert.deepStrictEqual(await lib.readClipRows(c), { text: '- 一\n- 二', html: '<ul><li>一</li></ul>' });
  assert.deepStrictEqual(c.electron, [], '読むだけなのに書いた');
  // HTML が無い・read が無い（31 の形）・getType が文字を返す
  const p = fakeClip('文字だけ');
  p.read = async () => [{ types: ['text/plain'], getType: async () => ({ text: async () => 'x' }) }];
  assert.deepStrictEqual(await lib.readClipRows(p), { text: '文字だけ', html: '' });
  assert.deepStrictEqual(await lib.readClipRows(fakeClip('31')), { text: '31', html: '' });
  const s = fakeClip('');
  s.read = async () => [{ types: ['text/html'], getType: async () => '<p>文字の答え</p>' }];
  assert.deepStrictEqual(await lib.readClipRows(s), { text: '', html: '<p>文字の答え</p>' });
});
test('EK-4 直し（R153）: readClipRows は形の違う答え・読めない・断られた Promise を空にし、大きすぎる中身（文字 1MB・HTML 16MB を越える）は渡さず tooBig', async () => {
  const bad = fakeClip('', { readFails: true });
  bad.read = async () => { throw new Error('読めない'); };
  assert.deepStrictEqual(await lib.readClipRows(bad), { text: '', html: '' });
  const odd = fakeClip('');
  odd.readText = async () => 123;
  odd.read = async () => [null, { types: 'text/html' }, { types: ['text/html'], getType: async () => ({ text: async () => 5 }) }];
  assert.deepStrictEqual(await lib.readClipRows(odd), { text: '', html: '' });
  const rej = fakeClip('x');
  rej.read = () => Promise.reject(new Error('断られた'));
  assert.deepStrictEqual(await lib.readClipRows(rej), { text: 'x', html: '' });
  const bigT = fakeClip('a'.repeat(lib.CLIP_ROWS_TEXT_MAX + 1));
  assert.deepStrictEqual(await lib.readClipRows(bigT), { tooBig: true });
  const okT = fakeClip('a'.repeat(lib.CLIP_ROWS_TEXT_MAX));
  assert.strictEqual((await lib.readClipRows(okT)).text.length, lib.CLIP_ROWS_TEXT_MAX);
  const bigH = fakeClip('');
  bigH.read = async () => [htmlItem('b'.repeat(lib.CLIP_ROWS_HTML_MAX + 1))];
  assert.deepStrictEqual(await lib.readClipRows(bigH), { tooBig: true });
  assert.strictEqual(lib.CLIP_ROWS_TEXT_MAX, 1024 * 1024);
  assert.strictEqual(lib.CLIP_ROWS_HTML_MAX, 16 * 1024 * 1024);
});
test('EK-4 直し（R153）: main の clipboard:read-rows は本体の窓（送り手とフォーカス）のときだけ mainlib.readClipRows で読み、preload は clipReadRows で呼ぶ。書く入口は今も copyPrivate だけ（#27）', () => {
  const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const at = m.indexOf("ipcMain.handle('clipboard:read-rows'");
  assert.ok(at > 0, 'clipboard:read-rows の受け口が無い');
  const body = m.slice(at, m.indexOf('\n  });', at));
  assert.ok(body.includes('e.sender !== mainWin.webContents') && body.includes('!mainWin.isFocused()'), '送り手と窓のフォーカスを見ていない');
  assert.ok(body.includes('return lib.readClipRows(clipboard);'), 'mainlib.readClipRows で読んでいない');
  assert.ok(!/clipboard\.(write|writeText|writeHTML)\(/.test(m), 'main.js が clipboard に直に書いている');
  const pre = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  assert.ok(pre.includes("  clipReadRows: () => ipcRenderer.invoke('clipboard:read-rows'),"), 'preload の clipReadRows が無い');
});
