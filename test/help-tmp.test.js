/* help-tmp.test.js — ヘルプのテストの後片付け
 *
 * ヘルプのテスト（help-build・help-search・help-content・help-site）は help/assets（同梱の書体で約 7 MB）を写した
 * フォルダを一時フォルダに作る。それを残すと npm test のたびに数百 MB が溜まり、Windows の %TEMP% も埋まる。
 * 一時フォルダは test/helpers/help-tmp.js の tmpDir(t, prefix) だけで作り、そのテストの終わり（t.after）に消す。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FILES = ['help-build', 'help-search', 'help-content', 'help-site'].map((n) => `test/${n}.test.js`);

test('後片付け: tmpDir(t, prefix) は os.tmpdir の下に prefix の名前のフォルダを作り、そのテストが終わると中身ごと消す', { timeout: 5000 }, async (t) => {
  const { tmpDir } = require('./helpers/help-tmp');
  let dir;
  await t.test('中', (st) => {
    dir = tmpDir(st, 'natsu-help-tmp-');
    assert.match(path.basename(dir), /^natsu-help-tmp-/);
    fs.mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a', 'b', 'c.txt'), 'x');
  });
  assert.ok(dir && !fs.existsSync(dir), `${dir} を残した`);
});

test('後片付け: ヘルプのテストは一時フォルダを tmpDir でだけ作る（mkdtempSync・os.tmpdir を直に使わない）', { timeout: 5000 }, () => {
  for (const f of FILES) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.ok(!/mkdtempSync|os\.tmpdir\s*\(/.test(src), `${f}: 一時フォルダを直に作っている（tmpDir(t, …) を使う）`);
    assert.match(src, /require\('\.\/helpers\/help-tmp'\)/, f);
  }
});
