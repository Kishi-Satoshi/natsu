/*
 * sqlite-probe.test.js — リリースの煙テストの中身（第0c回 EL8・C5）
 * 本物の Electron では CI（electron-smoke）とリリース（installer）が走らせる。ここでは、この Node の node:sqlite で
 * 4 つとも OK になることと、足りない Electron（node:sqlite が無い・trigram が無い・backup() が無い）で NG になることを見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { probe, exitCodeOf } = require('../tools/sqlite-probe');

test('sqlite-probe: この Node の node:sqlite で 4 つとも OK、終了コード 0（node:sqlite か backup() の無い古い Node 22 では NG で 1）', async () => {
  // CI は Node 24。開発の機械の Node 22.12〜22.x の古いもの（旗なしの node:sqlite は 22.13 から）でも赤にせず、NG と出ることを見る（飛ばさない）
  let has = false;
  try { has = typeof require('node:sqlite').backup === 'function'; } catch (_) { has = false; }
  const r = await probe();
  assert.deepStrictEqual(r.map((x) => x.n), [1, 2, 3, 4]);
  if (!has) { assert.strictEqual(exitCodeOf(r), 1); return; }
  assert.deepStrictEqual(r.filter((x) => !x.ok).map((x) => x.line), []);
  assert.match(r[0].line, /^OK 1 .*SQLite 3\.\d+\.\d+/);
  assert.strictEqual(exitCodeOf(r), 0);
});

test('sqlite-probe.js は require されただけではコマンドとして走らない', () => {
  const s = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'tools', 'sqlite-probe.js'), 'utf8');
  assert.match(s, /if \(require\.main === module\)/);
});

test('sqlite-probe: node:sqlite が無い（Electron 31 の Node 20）と全部 NG で 1', async () => {
  const r = await probe({ load: () => { throw new Error('No such built-in module: node:sqlite'); } });
  assert.deepStrictEqual(r.map((x) => x.ok), [false, false, false, false]);
  assert.match(r[0].line, /^NG 1 .*No such built-in module/);
  assert.match(r[3].line, /前の段が NG/);
  assert.strictEqual(exitCodeOf(r), 1);
});

test('sqlite-probe: FTS5 の trigram が無い版（35.0.0 など）では 3 が NG', async () => {
  const real = require('node:sqlite');
  class NoTrigram extends real.DatabaseSync {
    exec(sql) { if (/trigram/.test(sql)) throw new Error('no such tokenizer: trigram'); return super.exec(sql); }
  }
  const r = await probe({ load: () => ({ ...real, DatabaseSync: NoTrigram }) });
  assert.deepStrictEqual(r.map((x) => x.ok), [true, true, false, true]);
  assert.match(r[2].line, /no such tokenizer: trigram/);
  assert.strictEqual(exitCodeOf(r), 1);
});

test('sqlite-probe: backup() が無い版では 4 が NG。数が足りない結果も 1', async () => {
  const real = require('node:sqlite');
  const r = await probe({ load: () => ({ DatabaseSync: real.DatabaseSync }) });
  assert.deepStrictEqual(r.map((x) => x.ok), [true, true, true, false]);
  assert.strictEqual(exitCodeOf(r), 1);
  assert.strictEqual(exitCodeOf(r.slice(0, 3).map((x) => ({ ...x, ok: true }))), 1);
  assert.strictEqual(exitCodeOf([]), 1);
});
