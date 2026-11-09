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
// 0.15.1 GV-1（計画 docs/plans/2026-11-04-151.md の「意図して変えるテスト（第7版）」・D126）で意図して直した: GitHub はこのリポジトリ（src/updater.js の REPO）の
// 先行版の札 whisper-vulkan-<頭7桁> も許す（latest・API・アプリの更新の札 natsu-v は断る）
const { REPO } = require('../src/updater');
test('ピン: URL は https で版が固定（GitHub はタグ、HF は 40 桁の commit）。latest・main・api.github.com を使わない', () => {
  const own = new RegExp(`^https://github\\.com/${REPO.replace(/[.]/g, '\\.')}/releases/download/whisper-vulkan-[0-9a-f]{7}/[\\w.-]+\\.zip$`);
  for (const it of MANIFEST.items) {
    assert.match(it.url, /^https:\/\//, it.id);
    assert.ok(!/api\.github\.com|\/latest\/|\/resolve\/main\/|\/natsu-v/.test(it.url), it.id);
    if (it.url.includes('huggingface.co')) assert.match(it.url, /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\/[\w.-]+$/, it.id);
    else if (own.test(it.url)) continue;
    else assert.match(it.url, /^https:\/\/github\.com\/ggml-org\/(whisper|llama)\.cpp\/releases\/download\/(b\d+|v\d+\.\d+\.\d+)\/[\w.-]+\.zip$/, it.id);
  }
  assert.ok(!own.test(`https://github.com/${REPO}/releases/download/natsu-v0.15.1/natsu-src-0.15.1.zip`));
  assert.ok(!own.test(`https://github.com/${REPO}/releases/latest/download/whisper-vulkan-bin-x64-d1be6fd.zip`));
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
  // 0.10.0 LS-3（D59）で意図して直した: 要約の組（llama b11669）を外した
  assert.strictEqual(itemsOf('whisper')[0].version, '1.9.5');
});
// 0.15.1 GV-1（「意図して変えるテスト（第7版）」）で意図して直した: strip が空のとき（GPU 版の平らな zip）は名前に / が無い。files の合計は 60,473,419
test('ピン: zip は使うファイルを全部、大きさと SHA-256 つきで持ち、exe はその中。名前は strip で始まる', () => {
  for (const z of MANIFEST.items.filter((i) => i.kind === 'zip')) {
    assert.ok(z.files.length > 0, z.id);
    for (const f of z.files) {
      assert.ok(f.name.startsWith(z.strip), f.name);
      if (!z.strip) assert.ok(!f.name.includes('/'), f.name);
      assert.match(f.name.slice(z.strip.length), /^[A-Za-z0-9._-]+$/, f.name);   // フォルダの入れ子は無い
      assert.match(f.sha256, HEX64, f.name);
      assert.ok(f.size > 0, f.name);
    }
    assert.ok(z.files.some((f) => f.name === z.strip + z.exe), `${z.id}: exe が files に無い`);
  }
  assert.strictEqual(totalBytes(itemsOf('whisper')[0].files), 60473419);
  assert.deepStrictEqual(itemsOf('sum'), [], '要約の組が残っている（0.10.0 LS-3）');
});
// 0.10.0 LS-3（D59）で意図して直した: 要約の組（llama のエンジンと要約のモデル）を外した
test('ピン: 並びは whisper のエンジン → VAD → 文字起こしのモデル', () => {
  assert.deepStrictEqual(MANIFEST.items.map((i) => i.id), ['whisper-engine', 'whisper-vad', 'whisper-model']);
});
// 0.15.1 GV-1（「意図して変えるテスト（第7版）」）で意図して直した: エンジンを GPU 版の組に（583,854,933 → 595,367,104）
test('ピン: 既定の組の合計（モデルを替えたら、ここも直す）', () => {
  assert.strictEqual(totalBytes(), 595367104);
  assert.strictEqual(totalBytes(itemsOf('whisper')), 595367104);
});
test('ピン: 凍結されていて、実行中に書き換えられない', () => {
  assert.ok(Object.isFrozen(MANIFEST) && Object.isFrozen(MANIFEST.items) && Object.isFrozen(MANIFEST.items[0].files[0]));
});

// 計画の7件の後に足した1件（点検の指摘: hostOf を呼ぶテストが無く、空を返す変異が生き残った）。
const { hostOf } = require('../src/engine-manifest');
test('ピン: hostOf は画面の「取得元」の欄のホスト名を返し、読めない URL は空の文字列', () => {
  assert.deepStrictEqual(MANIFEST.items.map((i) => hostOf(i.url)), ['github.com', 'huggingface.co', 'huggingface.co']);   // 0.10.0 LS-3 で要約の2つを外した
  assert.strictEqual(hostOf('not a url'), '');
});
