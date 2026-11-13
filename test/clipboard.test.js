/*
 * clipboard.test.js — クリップボード（#27・第0c回 EL1・C1）
 * Electron 44 では main でも clipboard.readText()／writeText() が Promise を返す。31 では文字列と undefined。
 * 両方の形の偽物で、写した文字を Win+V の履歴に残さないこと（Electron で書かない）と、続けて置いても [object Promise] に
 * しないことを、mainlib の関数を本当に動かして確かめる（0.15.1 ND-1 で音声入力の貼り付け deliverText と貼り付けの後の戻し
 * restoreAfterPaste を消したので、そのテストも意図して消した: 計画 docs/plans/2026-11-04-151.md の「意図して変えるテスト」・D114）。
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
  const d = { clip, paster: paster ? paster.get : () => null, sleep: async () => {}, notice: (m) => notices.push(m), later: (fn, ms) => later.push({ fn, ms }), ...over };
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

  // 0.15.1 ND-1 で意図して変えた: 前は deliverText の貼り付けの2秒後の戻しで見ていた「[object Promise] にしない」を、［コピー］の copyPrivate を続けて呼ぶ形で見る
  test(`copyPrivate（${shape}）: 続けて置いても、クリップボードは最後に置いた文字（[object Promise] にしない）。PowerShell が居ても居なくても`, async () => {
    for (const withPaster of [true, false]) {
      const clip = fakeClip('abc', { promise });
      const d = deps(clip, withPaster ? fakePaster(clip) : null).d;
      await lib.copyPrivate('一つ目', d);
      await lib.copyPrivate('abc', d);
      assert.strictEqual(await lib.readClip(clip), 'abc', String(withPaster));
      assert.ok(!clip.seen.includes('[object Promise]'), clip.seen.join(' / '));
      if (withPaster) assert.deepStrictEqual(clip.electron, [], 'PowerShell が置けたのに Electron で書いた');
    }
  });
}

test('main.js: clipboard の readText／writeText を直に呼ばず、mainlib に clipboard を渡す', () => {
  const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/clipboard\.(readText|writeText)\(/.test(m), 'main.js が clipboard を直に読み書きしている（44 では Promise）');
  assert.match(m, /clip: clipboard,/);
  assert.match(m, /const copyPrivate = \(text\) => lib\.copyPrivate\(text, clipDeps\(\)\);/);
  // 0.15.1 ND-2（D114）で意図して変えた: 音声入力の貼り付け（deliverText）は音声入力と一緒に消した
  assert.ok(!/deliverText/.test(m), '音声入力の貼り付けが main に残っている');
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
