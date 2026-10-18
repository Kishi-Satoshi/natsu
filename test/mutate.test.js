/*
 * mutate.test.js — 自動の変異確認（第1a回 G3。tools/mutate.js・tools/mutants.js）
 * 本番の変異確認は CI の mutate のジョブが回す（全部の変異で数分）。ここでは小さな見本のリポジトリで道具の決め方を見て、
 * 一覧がどれも今のファイルにちょうど1回当たる（古くなっていない）ことを見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../tools/mutate');
const MUTANTS = require('../tools/mutants');
const { jobsOf, stepsOf } = require('./helpers/yml');

const ROOT = path.join(__dirname, '..');
const ADD_SRC = "'use strict';\n// 足す\nmodule.exports = (a, b) => a + b;\n";
const made = [];
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* noop */ } } });
function fixtureRepo({ red = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-変異𠮷-'));
  made.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.mkdirSync(path.join(root, 'tools'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","private":true}');
  fs.writeFileSync(path.join(root, 'README.md'), '# 見本\n');   // src・test・tools の外のファイル（写しに無いと元のテストが赤くなる）
  fs.writeFileSync(path.join(root, 'src', 'add.js'), ADD_SRC);
  fs.writeFileSync(path.join(root, 'test', 'add.test.js'),
    `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst add = require('../src/add');\ntest('足し算', () => { assert.ok(fs.existsSync(path.join(__dirname, '..', 'README.md'))); assert.strictEqual(add(1, 2), ${red ? 4 : 3}); });\n`);
  return root;
}

test('G3・F10: 変異の一覧は、どれも今のファイルにちょうど1回だけ当たり、id は重ならず、テストのファイルがある', { timeout: 5000 }, () => {
  assert.deepStrictEqual(M.findStale(MUTANTS, (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')), []);
  assert.ok(MUTANTS.length >= 6);
  assert.strictEqual(new Set(MUTANTS.map((m) => m.id)).size, MUTANTS.length);
  for (const m of MUTANTS) {
    assert.ok(m.id && m.why && m.from !== m.to && m.tests.length, m.id);
    for (const t of m.tests) assert.ok(fs.existsSync(path.join(ROOT, t)), `${m.id}: ${t}`);
  }
});

test('G3: applyMutant はちょうど1回だけ置き換え、0 回や2回なら投げる', { timeout: 5000 }, () => {
  assert.strictEqual(M.applyMutant('a + b', { from: '+', to: '-' }), 'a - b');
  assert.throws(() => M.applyMutant('a + b', { from: '*', to: '/' }));
  assert.throws(() => M.applyMutant('a + b + c', { from: '+', to: '-' }));
});

test('G3・F10: 小さな見本で、殺される・生き残る・古い（当たらない）変異を見分け、元のファイルは変えない（写しは src・test・tools の外も写す）', { timeout: 20000 }, async () => {
  const root = fixtureRepo();
  const r = await M.runAll({ root, jobs: 1, mutants: [
    { id: 'kill', file: 'src/add.js', from: 'a + b', to: 'a - b', tests: ['test/add.test.js'], why: '足し算' },
    { id: 'live', file: 'src/add.js', from: '// 足す', to: '// たす', tests: ['test/add.test.js'], why: '注釈だけ（生き残る）' },
    { id: 'old', file: 'src/add.js', from: 'a * b', to: 'a / b', tests: ['test/add.test.js'], why: '無い文字' },
  ] });
  assert.deepStrictEqual(r.map((x) => [x.id, x.status]), [['kill', 'killed'], ['live', 'survived'], ['old', 'stale']]);
  assert.strictEqual(M.exitCodeOf(r), 1);
  assert.strictEqual(M.exitCodeOf(r.filter((x) => x.status === 'killed')), 0);
  assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'add.js'), 'utf8'), ADD_SRC);
});

test('G3・F10: 元のテストが赤なら、変異を試さずに止める（何でも「殺した」に見えるため）', { timeout: 20000 }, async () => {
  const r = await M.runAll({ root: fixtureRepo({ red: true }), jobs: 1, mutants: [{ id: 'kill', file: 'src/add.js', from: 'a + b', to: 'a - b', tests: ['test/add.test.js'], why: 'x' }] });
  assert.deepStrictEqual(r.map((x) => x.status), ['baseline-red']);
  assert.strictEqual(M.exitCodeOf(r), 1);
});

test('ci.yml: mutate のジョブ（Linux）が node tools/mutate.js を回す（release.yml は ci.yml を呼ぶので、生き残りがあればリリースも止まる）', { timeout: 5000 }, () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const j = jobsOf(ci).mutate;
  assert.ok(j, 'mutate のジョブが無い');
  assert.match(j, /^    runs-on: ubuntu-latest$/m);
  assert.ok(stepsOf(j).some((s) => /^\s*run: node tools\/mutate\.js( --jobs \d+)?$/m.test(s)));
  assert.match(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8'), /^    uses: \.\/\.github\/workflows\/ci\.yml$/m);
});
