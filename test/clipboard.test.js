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
