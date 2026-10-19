'use strict';
// 自動の変異確認（第1a回 G3）。tools/mutants.js の変異を1つずつリポジトリの写しに当て、決めたテストが赤になるか（殺せるか）を見る。
//
//   applyMutant(text, m)       … m.from がちょうど1回なら m.to に置き換えた文字を返す。0 回か2回以上なら投げる。
//                                m.also（[{ from, to }]）があれば、その後に順に同じ決まりで置き換える（離れた2か所を一緒に戻す変異。第2a1回 G-3）
//   findStale(mutants, read)   → 当たらない（0 回か2回以上・ファイルが無い。also も）変異の id の配列
//   runAll({ root, mutants, jobs, timeoutMs })
//                              → [{ id, status: 'killed' | 'survived' | 'stale' | 'baseline-red', file, why }]
//   exitCodeOf(results)        … 全部 'killed' なら 0、それ以外は 1
//
// 決め方:
//  - 当たらない変異は 'stale'（黙って殺したと数えない。一覧が古くなったしるし）。
//  - 写しは root の中を node_modules・dist のほか全部（.git も）写す。テストは README.md・.gitignore・.ps1・ワークフロー・git の履歴も読むので、
//    一部だけを写すと元のテストが赤くなり、何でも「殺した」に見える。
//  - 変異を試す前に、一覧のテストの組を写しで元のまま走らせる。赤があれば 'baseline-red' を返して止める。
//  - 子は process.execPath で走らせる（Electron の Node で回すときも同じ Node で走る）。env から NODE_TEST_CONTEXT を消し
//    （npm test の中から呼ばれても入れ子の報告が親に混ざらない）、NATSU_SCENE_CONCURRENCY=1 にする（写しを並べるので場面は1つずつ）。
//  - root のファイルは変えない（当てるのは写しだけ。1つ試すごとに元に戻す）。
//  - 変異に pattern（文字の正規表現）があれば --test-name-pattern に渡し、その名前のテストだけを回す（第2a1回 G-3。場面を使う
//    重いテストのファイルで、赤になるテストだけを回して CI の mutate を 20 分に収める）。元のままの確かめは名前で絞らない。
//
// node tools/mutate.js [--only id,id] [--jobs N]
//   結果を 1 行ずつ（killed／SURVIVED／STALE／BASELINE-RED）出し、最後に数をまとめ、exitCodeOf で終わる。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SKIP_DIRS = new Set(['node_modules', 'dist']);   // 写さない（根の直下の名前）
const OUTPUT_KEEP = 8000;                              // 子の出力は最後のこれだけ残す（元のままが赤いときに見せる）

function countOf(text, s) {
  if (!s) return 0;
  let n = 0;
  for (let i = text.indexOf(s); i >= 0; i = text.indexOf(s, i + s.length)) n++;
  return n;
}

function replaceOnce(text, from, to) {
  const n = countOf(text, from);
  if (n !== 1) throw new Error(`変異の元の文字が ${n} 回ある（ちょうど1回でないと当てられない）: ${JSON.stringify(from)}`);
  const i = text.indexOf(from);
  return text.slice(0, i) + to + text.slice(i + from.length);
}

function applyMutant(text, m) {
  let out = replaceOnce(text, m.from, m.to);
  for (const x of m.also || []) out = replaceOnce(out, x.from, x.to);
  return out;
}

function findStale(mutants, read) {
  const out = [];
  for (const m of mutants) {
    let text;
    try { text = read(m.file); } catch (_) { out.push(m.id); continue; }
    try { applyMutant(text, m); } catch (_) { out.push(m.id); }
  }
  return out;
}

function copyRepo(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-mutate-'));
  fs.cpSync(root, dir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(root, src);
      return !rel || !SKIP_DIRS.has(rel.split(path.sep)[0]);
    },
  });
  return dir;
}

function childEnv() {
  const env = { ...process.env, NATSU_SCENE_CONCURRENCY: '1' };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

// テストのファイルを写しで走らせる → { code, timedOut, output }
function runTests(cwd, tests, timeoutMs, pattern) {
  return new Promise((resolve) => {
    let output = '';
    const keep = (b) => { output = (output + b.toString('utf8')).slice(-OUTPUT_KEEP); };
    const only = typeof pattern === 'string' ? [`--test-name-pattern=${pattern}`] : [];
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...only, ...tests], { cwd, env: childEnv(), windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, timedOut, output: output + String(e && e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code === null ? -1 : code, timedOut, output }); });
  });
}

async function runAll({ root, mutants, jobs = 2, timeoutMs = 120000 }) {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const stale = new Set(findStale(mutants, read));
  const results = mutants.map((m) => ({ id: m.id, status: stale.has(m.id) ? 'stale' : null, file: m.file, why: m.why }));
  const todo = mutants.map((m, i) => ({ m, i })).filter(({ m }) => !stale.has(m.id));
  if (!todo.length) return results;

  const copies = [];
  try {
    const n = Math.max(1, Math.min(Number(jobs) || 1, todo.length));
    for (let k = 0; k < n; k++) copies.push(copyRepo(root));

    // 元のままで、一覧のテストの組が緑か
    const allTests = [...new Set(todo.flatMap(({ m }) => m.tests))];
    const base = await runTests(copies[0], allTests, timeoutMs);
    if (base.code !== 0) {
      return [
        ...results.filter((r) => r.status === 'stale'),
        { id: '(元のまま)', status: 'baseline-red', file: '', why: `元のままで赤いテストがある: ${allTests.join(' ')}`, timedOut: base.timedOut, output: base.output },
      ];
    }

    let next = 0;
    const worker = async (dir) => {
      while (next < todo.length) {
        const { m, i } = todo[next++];
        const target = path.join(dir, m.file);
        const original = fs.readFileSync(target, 'utf8');
        fs.writeFileSync(target, applyMutant(original, m));
        try {
          const r = await runTests(dir, m.tests, timeoutMs, m.pattern);
          results[i].status = r.code === 0 ? 'survived' : 'killed';
          if (r.timedOut) results[i].timedOut = true;
        } finally {
          fs.writeFileSync(target, original);
        }
      }
    };
    await Promise.all(copies.map(worker));
    return results;
  } finally {
    for (const d of copies) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 片付けられなくても結果は変えない */ } }
  }
}

function exitCodeOf(results) {
  return results.every((r) => r.status === 'killed') ? 0 : 1;
}

const LABEL = { killed: 'killed', survived: 'SURVIVED', stale: 'STALE', 'baseline-red': 'BASELINE-RED' };

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const all = require('./mutants');
  let mutants = all;
  const only = arg('--only');
  if (only) {
    const want = only.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = want.filter((id) => !all.some((m) => m.id === id));
    if (unknown.length) { console.error(`一覧に無い id: ${unknown.join(', ')}`); return 1; }
    mutants = all.filter((m) => want.includes(m.id));
  }
  const jobs = Number(arg('--jobs')) || 2;
  const started = Date.now();
  const results = await runAll({ root: path.join(__dirname, '..'), mutants, jobs });
  for (const r of results) {
    console.log(`${LABEL[r.status].padEnd(12)} ${r.id}  ${r.file}${r.timedOut ? '（時間切れ）' : ''} — ${r.why}`);
    if (r.status === 'baseline-red' && r.output) console.log(r.output);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`殺した ${count('killed')} / 生き残り ${count('survived')} / 古い ${count('stale')} / 元のままで赤 ${count('baseline-red')}（${mutants.length} 個・${Math.round((Date.now() - started) / 1000)} 秒）`);
  return exitCodeOf(results);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e && e.stack || e); process.exitCode = 1; });
}

module.exports = { applyMutant, findStale, runAll, exitCodeOf, copyRepo };
