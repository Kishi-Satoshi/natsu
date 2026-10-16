'use strict';
// GitHub Actions の YAML を、文字列のまま「ジョブ」と「ステップ」に切る（依存なし）。
// YAML パーサは入れない（追加の npm 依存を増やさない）。
// ジョブは 2 桁字下げのキー、ステップは 6 桁字下げの "- " で切る。

const assert = require('node:assert');

/** jobs: 配下を { 名前: 本文 } に切る */
function jobsOf(text) {
  const i = text.indexOf('\njobs:\n');
  assert.ok(i >= 0, 'jobs: が無い');
  const body = text.slice(i + '\njobs:\n'.length);
  const out = {};
  const re = /^  ([\w-]+):[ \t]*\n/gm;
  const hits = [...body.matchAll(re)];
  hits.forEach((m, k) => {
    const from = m.index + m[0].length;
    const to = k + 1 < hits.length ? hits[k + 1].index : body.length;
    out[m[1]] = body.slice(from, to);
  });
  return out;
}

/** ジョブ本文を steps の配列（各ステップの生テキスト）に切る。行頭コメントは落とす */
function stepsOf(job) {
  const i = job.indexOf('\n    steps:\n');
  assert.ok(i >= 0, 'steps: が無い');
  return job.slice(i + '\n    steps:\n'.length)
    .replace(/^[ \t]*#[^\n]*\n/gm, '')
    .split(/^      - /m).filter((s) => s.trim());
}

/** ステップの名前（name: が無ければ uses: の値） */
const nameOf = (s) => (s.match(/^\s*name:\s*(.+)$/m) || [])[1] || (s.match(/^uses:\s*(.+)$/m) || [])[1] || '';

module.exports = { jobsOf, stepsOf, nameOf };
