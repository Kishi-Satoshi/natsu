/*
 * engine-manifest.test.js — 取り込むエンジンとモデルのピン（版・URL・大きさ・SHA-256・置き場所）
 *
 * ピンは src/engine-manifest.js の1か所だけ。ここでは「版が固定されている」
 * 「置き場所が英数字だけの相対パスで重ならない」「zip の中で使うファイルを全部
 * SHA-256 つきで持つ」「凍結されている」を守る（第0b回 R7、RF3、RF13）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { MANIFEST, itemsOf, totalBytes } = require('../src/engine-manifest');
const HEX64 = /^[0-9a-f]{64}$/;
const REL = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;   // 英数字だけの相対パス（.. と先頭の / は下で別に見る）
test('ピン: URL は https で版が固定（GitHub はタグ、HF は 40 桁の commit）。latest・main・api.github.com を使わない', () => {
  for (const it of MANIFEST.items) {
    assert.match(it.url, /^https:\/\//, it.id);
    assert.ok(!/api\.github\.com|\/latest\/|\/resolve\/main\//.test(it.url), it.id);
    if (it.url.includes('huggingface.co')) assert.match(it.url, /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\/[\w.-]+$/, it.id);
    else assert.match(it.url, /^https:\/\/github\.com\/ggml-org\/(whisper|llama)\.cpp\/releases\/download\/(b\d+|v\d+\.\d+\.\d+)\/[\w.-]+\.zip$/, it.id);
  }
});
test('ピン: SHA-256 は 64 桁、大きさは正の整数、置き場所は英数字だけの相対パスで重ならない', () => {
  const places = [];
  for (const it of MANIFEST.items) {
    assert.match(it.sha256, HEX64, it.id);
    assert.ok(Number.isSafeInteger(it.size) && it.size > 0, it.id);
    const place = it.kind === 'zip' ? it.dir : it.dest;
    assert.match(place, REL, it.id);
    assert.ok(!place.split('/').includes('..'), it.id);
    places.push(place.toLowerCase());
  }
  assert.strictEqual(new Set(places).size, places.length, '置き場所が重なっている');
  assert.strictEqual(new Set(MANIFEST.items.map((i) => i.id)).size, MANIFEST.items.length);
});
test('ピン: エンジンのフォルダの名前は版を含む（ピンを上げると置き場所も変わる）', () => {
  for (const z of MANIFEST.items.filter((i) => i.kind === 'zip')) assert.ok(z.dir.includes(z.version), `${z.id}: ${z.dir} に ${z.version} が無い`);
  assert.strictEqual(itemsOf('sum')[0].version, 'b11669');
});
test('ピン: zip は使うファイルを全部、大きさと SHA-256 つきで持ち、exe はその中。名前は strip で始まる', () => {
  for (const z of MANIFEST.items.filter((i) => i.kind === 'zip')) {
    assert.ok(z.files.length > 0, z.id);
    for (const f of z.files) {
      assert.ok(f.name.startsWith(z.strip), f.name);
      assert.match(f.name.slice(z.strip.length), /^[A-Za-z0-9._-]+$/, f.name);   // フォルダの入れ子は無い
      assert.match(f.sha256, HEX64, f.name);
      assert.ok(f.size > 0, f.name);
    }
    assert.ok(z.files.some((f) => f.name === z.strip + z.exe), `${z.id}: exe が files に無い`);
  }
  assert.strictEqual(totalBytes(itemsOf('whisper')[0].files), 11850240);
  assert.strictEqual(totalBytes(itemsOf('sum')[0].files), 44353821);
});
test('ピン: 並びは whisper のエンジン → VAD → 文字起こしのモデル → llama のエンジン → 要約のモデル', () => {
  assert.deepStrictEqual(MANIFEST.items.map((i) => i.id), ['whisper-engine', 'whisper-vad', 'whisper-model', 'sum-engine', 'sum-model']);
});
test('ピン: 既定の組の合計（Task 0 の答えでモデルを替えたら、ここも直す）', () => {
  assert.strictEqual(totalBytes(), 5580564403);
  assert.strictEqual(totalBytes(itemsOf('whisper')), 583854933);
});
test('ピン: 凍結されていて、実行中に書き換えられない', () => {
  assert.ok(Object.isFrozen(MANIFEST) && Object.isFrozen(MANIFEST.items) && Object.isFrozen(MANIFEST.items[0].files[0]));
});
