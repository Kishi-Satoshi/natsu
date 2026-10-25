/*
 * ci.test.js — CI（.github/workflows/ci.yml）の形を固定する（第0a回 G1）
 *
 *  - Linux と Windows の両方で npm test とゲートを回す
 *  - Windows の取得で改行を変えない（変えると \n を探すテストが落ちる）
 *  - 履歴ごと取る（gate.test.js が古いコミットを読む）
 *  - ゲートの基準が使えない値（0 の並び・履歴に無い）でも落ちない
 *  - Windows では .ps1 を Windows PowerShell 5.1 で構文解析し、BOM と CRLF を確かめる
 *  - release.yml は natsu-v* のタグだけで動き、ci が緑のときだけリリースする（G1-2）
 *
 * GitHub Actions は手元で回せないので、YAML を文字列として読む（test/helpers/yml.js）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { jobsOf, stepsOf } = require('./helpers/yml');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('ci.yml: Linux と Windows で、改行を変えずに履歴ごと取り、npm test とゲートを回す', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.ok(!/\t/.test(ci), 'YAML にタブがある');
  assert.match(ci, /^  workflow_call:/m);
  assert.match(ci, /os: \[ubuntu-latest, windows-latest\]/);
  const st = stepsOf(jobsOf(ci).test);
  const iCrlf = st.findIndex((s) => s.includes('git config --global core.autocrlf false'));
  const iCo = st.findIndex((s) => /uses: actions\/checkout@v4/.test(s));
  assert.ok(iCrlf >= 0 && iCrlf < iCo, '改行の変換を止める前に checkout している');
  assert.match(st[iCo], /fetch-depth: 0/);
  assert.ok(st.some((s) => /node-version: '24'/.test(s)));
  assert.ok(st.some((s) => /^\s*npm test/m.test(s) && s.includes('# skipped')), '飛ばしたテストの数を見ていない');
  const gate = st.find((s) => s.includes('node tools/risk.js --base "$BASE" --head HEAD'));
  assert.ok(gate, 'ゲートのステップが無い');
  assert.ok(gate.includes('^0+$'), '新しいブランチ・タグの push（before が 0 の並び）で risk.js が落ちる');
  assert.ok(gate.includes('git cat-file -e "$BASE^{commit}"'), '履歴に無い基準（force-push の後）で risk.js が落ちる');
});

// CI の直し（run 39583796615 の Windows）: テスト全部を回す段は、一時フォルダ（os.tmpdir() が読む TEMP・TMP）を作業のディスク（RUNNER_TEMP）に置いてから回す。
// 既定の C: の %TEMP% では、場面の DB・JSON の fsync とファイルを多く書くテストが遅くなり、場面が見張りに当たった
test('ci.yml: Windows でテスト全部を回す段（test と electron-smoke）は、TEMP・TMP を RUNNER_TEMP の下にしてから回す', () => {
  const jobs = jobsOf(read('.github/workflows/ci.yml'));
  const steps = [
    stepsOf(jobs.test).find((s) => /^\s*npm test/m.test(s)),
    stepsOf(jobs['electron-smoke']).find((s) => s.includes('--test --test-reporter=tap "test/*.test.js"')),
  ];
  for (const st of steps) {
    assert.ok(st, 'テスト全部を回す段が無い');
    const set = st.indexOf('export TEMP="$(cygpath -w "$RUNNER_TEMP/natsu-tmp")" TMP="$(cygpath -w "$RUNNER_TEMP/natsu-tmp")"');
    assert.ok(set >= 0, 'TEMP・TMP を RUNNER_TEMP の下にしていない');
    assert.ok(st.indexOf('mkdir -p "$RUNNER_TEMP/natsu-tmp"') >= 0 && st.indexOf('mkdir -p "$RUNNER_TEMP/natsu-tmp"') < set, '一時フォルダを作る前に TEMP にしている');
    assert.ok(set < st.search(/^\s*(npm test|ELECTRON_RUN_AS_NODE=1 node_modules)/m), 'テストを回した後に TEMP を変えている');
  }
  // test のジョブは Linux でも回るので、Windows のときだけ変える（Linux の os.tmpdir() は TMPDIR を読み、TEMP は見ない）
  assert.match(steps[0], /if \[ "\$RUNNER_OS" = "Windows" \]; then\n\s+mkdir -p "\$RUNNER_TEMP\/natsu-tmp"/);
});

test('ci.yml: Windows では .ps1 を Windows PowerShell 5.1 で構文解析し、BOM と CRLF を確かめる', () => {
  const ci = read('.github/workflows/ci.yml');
  const st = stepsOf(jobsOf(ci).test);
  const parse = st.find((s) => s.includes('Parser]::ParseFile'));
  assert.ok(parse, '構文解析のステップが無い');
  assert.match(parse, /^\s*if: runner\.os == 'Windows'$/m);
  assert.match(parse, /^\s*shell: powershell$/m);
  assert.ok(parse.includes('GetEncoding(932)'), 'BOM が無いときの読まれ方（CP932）を試していない');
  assert.ok(!/pwsh/.test(ci), 'PowerShell 7 で解析している');
  const bom = st.find((s) => s.includes('0xEF') && s.includes('i/crlf'));
  assert.ok(bom, 'BOM と CRLF のステップが無い');
  assert.match(bom, /^\s*if: runner\.os == 'Windows'$/m);
});

// ---------------------------------------------------------------- engine-smoke（第0b回 Task 8。RF1・RF10）
// 本物の取得元に届くかと、日本語の名前のフォルダで本物のエンジンが起動するかは、Windows の CI でだけ見る。
// ここでは、ジョブの形と tools/engine-smoke.js が確かめる中身を文字で固定する。
test('ci.yml: Windows で、ピンの取得元に届くかを見て、日本語の名前のフォルダでエンジンを起動する（RF1・RF10）', () => {
  const j = jobsOf(read('.github/workflows/ci.yml'))['engine-smoke'];
  assert.ok(j, 'engine-smoke のジョブが無い');
  assert.match(j, /^    runs-on: windows-latest$/m);
  const st = stepsOf(j);
  const iCrlf = st.findIndex((s) => s.includes('git config --global core.autocrlf false'));
  assert.ok(iCrlf >= 0 && iCrlf < st.findIndex((s) => /uses: actions\/checkout@v4/.test(s)));
  assert.ok(st.some((s) => /uses: actions\/cache@v4/.test(s) && s.includes("hashFiles('src/engine-manifest.js', 'tools/engine-smoke.js')")));
  assert.ok(st.some((s) => s.includes('node tools/engine-smoke.js --pins')));
  assert.ok(st.some((s) => s.includes('node tools/engine-smoke.js --start')));
});
test('engine-smoke.js: é・日本語・𠮷 のフォルダに置き、アプリと同じ engineSpawnPlan で起動し、絶対パスでは落ちることも見る', () => {
  const s = read('tools/engine-smoke.js');
  assert.ok(s.includes("'Jé 日本語ユーザー𠮷'"));
  assert.ok(s.includes('engineSpawnPlan(') && s.includes('fetchFile(') && s.includes('listZip('));
  assert.ok(s.includes("'--vad-model'") && s.includes('/inference'), 'VAD を読ませていない（VAD は最初の文字起こしで読む）');
  assert.match(s, /負の確かめ/);
  // 文字は注釈と関数にも残るので、start() が結果に数えて呼んでいるかまで見る（呼ばないと、相対パスの緑が RF1 の証にならない）
  const st = s.slice(s.indexOf('async function start()'));
  assert.ok(/rs\.push\(report\(await smokeWhisperAbsolute\(/.test(st.slice(0, st.indexOf('\n}'))), 'start() で負の確かめを呼んでいない');
  assert.ok(!/api\.github\.com/.test(s));
});
test('engine-smoke.js: 本物の CDN で、キャッシュがあっても毎回、取り消してから続きを取る。コードページはレジストリから読む', () => {
  const s = read('tools/engine-smoke.js');
  assert.ok(s.includes("resumeCheck('whisper-vad', 400 * 1024)"), 'HF の CDN で続きからを試していない');
  assert.ok(s.includes("resumeCheck('whisper-engine', 1024 * 1024)"), 'GitHub の CDN で続きからを試していない');
  // 計画の変異確認の「resumeCheck をキャッシュがあるとき飛ばす」を赤にする（文字があるだけでは、if で包んでも緑のまま）
  const head = s.slice(s.indexOf('async function start()'), s.indexOf("resumeCheck('whisper-engine', 1024 * 1024)"));
  assert.ok(head.includes("resumeCheck('whisper-vad', 400 * 1024)"), 'start の頭で続きからを試していない');
  assert.ok(!/\bif\b|\?|&&|\|\||cache/i.test(head), 'キャッシュの有無などで、続きからの確かめを飛ばしうる');
  // resumeCheck の中でキャッシュを見て早く返しても、毎回の続きからにならない
  const i = s.indexOf('async function resumeCheck(');
  const rc = s.slice(i, s.indexOf('\n}', i));
  assert.ok(i >= 0 && !/CACHE|existsSync|obtain\(/.test(rc), 'resumeCheck の中でキャッシュを見ている');
  assert.ok(s.includes('Control\\\\Nls\\\\CodePage') && s.includes("'ACP'") && s.includes("'OEMCP'"), 'ANSI のコードページを読んでいない');
  assert.ok(!/\bchcp\b/.test(s), 'chcp は ANSI ではない');
});

// ---------------------------------------------------------------- release.yml（第0a回 G1-2）
// タグは natsu-v<x.y.z>。古い v* では動かさない。リリースは ci（Linux と Windows）が緑のときだけ。
const rel = () => read('.github/workflows/release.yml');

test('release.yml: natsu-v* だけで動き、古い v* では動かない', () => {
  assert.match(rel(), /^    tags:\n      - 'natsu-v\*'$/m);
  assert.match(rel(), /^    branches:\n      - 'release\/natsu-v\*'$/m);
  assert.ok(!/- 'v\*'|- 'release\/v\*'/.test(rel()));
});

test('release.yml: ci を呼び、release は ci が緑のときだけ走る', () => {
  const j = jobsOf(rel());
  assert.deepStrictEqual(Object.keys(j), ['ci', 'release', 'installer', 'help-redeploy']);   // help-redeploy は help-relnotes の Ruling R-RN3
  assert.match(j.ci, /^    uses: \.\/\.github\/workflows\/ci\.yml$/m);
  assert.match(j.release, /^    needs: ci$/m);
});

test('release.yml: タグは natsu-v<x.y.z> の形で、natsu-v を外した版が package.json と一致する', () => {
  const r = jobsOf(rel()).release;
  assert.ok(r.includes('TAG="${INPUT_TAG:-natsu-v${VER}}"'));
  assert.ok(r.includes('^natsu-v[0-9]+\\.[0-9]+\\.[0-9]+$'));
  assert.ok(r.includes('"${TAG#natsu-v}" != "$VER"'));
  assert.ok(!r.includes('${TAG#v}'));
});

test('release.yml: ゲートとチェックリストは前の natsu-v タグから（無ければ前の v タグ）', () => {
  const r = jobsOf(rel()).release;
  assert.ok(r.includes("--match 'natsu-v*' HEAD^") && r.includes("--match 'v*' HEAD^"));
  assert.ok(r.includes('node tools/risk.js --base "$PREV" --head HEAD --checklist RELEASE-CHECK.md'));
  assert.ok(!r.includes('--base-tag'));
});

// 資産の名前は release.yml と updater.js で同じにする（第0a回 R3）
test('release.yml が作る zip の名前を、updater の ASSET_PATTERN が拾う', () => {
  const m = rel().match(/zip -q -r -X "\.\.\/([\w-]+)\$\{VER\}\.zip"/);
  assert.ok(m, 'zip の名前が読めない');
  assert.ok(require('../src/updater').ASSET_PATTERN.test(`${m[1]}0.1.0.zip`));
});

// ---------------------------------------------------------------- electron-net（第0b回 Task 9。RF2）
// 取り込み（src/engine-fetch.js の fetchFile）とテストの偽物（test/helpers/fake-net.js）が頼る net.request の
// 振る舞いを、Windows の CI で本物の Electron（第0b回は 31.7.7。第0c回から 44.9.0 でも同じ）に確かめさせる。
test('ci.yml: Windows で、本物の Electron の net.request が取り込みの前提どおりかを見る（RF2）', () => {
  const j = jobsOf(read('.github/workflows/ci.yml'))['electron-net'];
  assert.ok(j, 'electron-net のジョブが無い');
  assert.match(j, /^    runs-on: windows-latest$/m);
  assert.match(j, /^    timeout-minutes: 15$/m);
  const st = stepsOf(j);
  assert.ok(st.some((s) => s.includes('$RUNNER_TEMP') && s.includes('npm install') && s.includes('devDependencies.electron')), 'Electron を一時フォルダに入れていない');
  assert.ok(st.some((s) => s.includes('electron.exe" tools/net-smoke.js')));
});
test('net-smoke.js: 転送・Range・abort・no-store・identity・圧縮と、本番の fetchFile を本物の net.request で試し、必ず終わる', () => {
  const s = read('tools/net-smoke.js');
  for (const k of ["redirect: 'manual'", 'followRedirect()', "'Range'", 'abort()', "cache: 'no-store'", "'Accept-Encoding'", 'fetchFile(', 'net.request(',
    'gzip: true', 'app.exit(0)', 'app.exit(1)', '120000']) assert.ok(s.includes(k), k);
});

// 本物の Electron はこの機械では動かさない。代わりに、同じ確かめを偽物の net.request の上で回し、
// 確かめそのものが動くこと（偽物の前提と食い違わないこと）と、前提が崩れた net.request では NG を出して
// 終わること（いつも OK を出す確かめではないこと）を見る。
const { fakeRequest } = require('./helpers/fake-net');

// 1 つの確かめの上限は、本物の確かめ（electron-net の net-smoke.js）と同じ既定の 12 秒にする（前は 4 秒）。確かめ 7・8 は本番の fetchFile で
// 1MB を本物のディスクに書き、途中の確定ごとに fsync と記録の書き込み（jsonfile。Windows でファイルが掴まれていれば同期で最大 0.5 秒待って
// やり直す: RENAME_WAITS）をする。electron-smoke の npm test（Windows・ほかのテストと並べて走る）では、偽のサーバーが要求を全部受けた
// （+162ms）後の書き込みだけで 4 秒を越えた（CI run 39510667416。イベントループの最大の止まり 1600ms。第1a回 d873976 の 1 回目も同じ確かめ）。
// 上限は止まらないことの守りで、速さの目安ではない（中身の確かめ「8 つとも OK」は変えない）
const NET_CHECK_MS = 12000;
test('net-smoke.js: 偽物の net.request（fake-net）の上では、8 つの確かめが全部 OK で終わる', async () => {
  const { runChecks } = require('../tools/net-smoke');
  const lines = [];
  const r = await runChecks({ request: fakeRequest, log: (l) => lines.push(l), checkMs: NET_CHECK_MS });
  assert.deepStrictEqual(r.map((x) => x.n), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepStrictEqual(r.filter((x) => !x.ok).map((x) => x.line), []);
  assert.strictEqual(lines.filter((l) => /^OK [1-8] /.test(l)).length, 8, lines.join('\n'));
});

test('net-smoke.js: Range と Accept-Encoding を送らない net.request では、その確かめと続きからの取り込みが NG になり、残りは OK のまま終わる', async () => {
  const { runChecks } = require('../tools/net-smoke');
  const dropping = (o) => {
    const req = fakeRequest(o);
    const set = req.setHeader;
    req.setHeader = (k, v) => { if (!/^(range|accept-encoding)$/i.test(k)) set(k, v); };
    return req;
  };
  const lines = [];
  const r = await runChecks({ request: dropping, log: (l) => lines.push(l), checkMs: NET_CHECK_MS });
  assert.deepStrictEqual(r.filter((x) => !x.ok).map((x) => x.n), [3, 6, 7], lines.join('\n'));
  assert.deepStrictEqual(lines.filter((l) => /^NG /.test(l)).map((l) => l.slice(0, 4)), ['NG 3', 'NG 6', 'NG 7']);
});

test('net-smoke.js: 時間切れの NG には、その確かめで偽のサーバーが受けた要求（名前・Range・Accept-Encoding）と、イベントループの最大の止まりを書く（CI でどこで止まったか・同期の処理が止めていたかを見分ける）', { timeout: 15000 }, async () => {
  const { runChecks } = require('../tools/net-smoke');
  // 応答を受け手に渡さない net.request（要求はサーバーに届くが、受け手はずっと待つ）
  const hanging = (o) => {
    const req = fakeRequest(o);
    const emit = req.emit.bind(req);
    req.emit = (ev, ...a) => (ev === 'response' ? true : emit(ev, ...a));
    return req;
  };
  const lines = [];
  // 確かめ 7 だけを回す。上限は、要求がサーバーに届くまで（サーバーを立てる・一時フォルダを作る）より十分長くする
  // （0.3 秒では Windows の CI で要求が届く前に時間切れになり「受けた要求: 無し」で赤になった）
  const r = await runChecks({ request: hanging, log: (l) => lines.push(l), checkMs: 3000, only: [7] });
  assert.deepStrictEqual(r.map((x) => x.n), [7], lines.join('\n'));
  const ng7 = r[0];
  assert.ok(!ng7.ok, lines.join('\n'));
  assert.match(ng7.line, /3 秒で終わらない（サーバーが受けた要求: origin.*cdn.*・イベントループの最大の止まり \d+ms）/, ng7.line);
});

// electron-net のジョブを赤にするのは net-smoke.js の終了コードだけ。boot() は Electron が無いと動かないので、
// 決め方（exitCodeOf）と終わり方（finish）を取り出して、ここで押さえる（NG の行を出しても緑のまま、を防ぐ。RF2）
test('net-smoke.js: 終了コードは 8 つとも OK のときだけ 0（NG が 1 つ・空・数が足りないは 1）。出力を流し切ってからその値で終える', () => {
  const { exitCodeOf, finish, CHECKS } = require('../tools/net-smoke');
  const all = CHECKS.map(([n]) => ({ n, ok: true, line: `OK ${n}` }));
  const oneNg = all.map((r) => (r.n === 4 ? { ...r, ok: false, line: 'NG 4' } : r));
  assert.strictEqual(exitCodeOf(all), 0);
  assert.strictEqual(exitCodeOf(oneNg), 1);
  assert.strictEqual(exitCodeOf([]), 1);
  assert.strictEqual(exitCodeOf(all.slice(0, 7)), 1);
  const codes = []; const lines = []; let flushed = 0;
  const app = { exit: (c) => codes.push(c) };
  const io = { log: (l) => lines.push(l), flush: (cb) => { flushed += 1; cb(); } };
  for (const r of [all, oneNg, all.slice(0, 7), []]) finish(app, r, io);
  assert.deepStrictEqual(codes, [0, 1, 1, 1]);
  assert.strictEqual(flushed, 4);
  assert.match(lines[0], /8 件とも OK/);
  assert.match(lines[1], /NG 1 件/);
  assert.match(read('tools/net-smoke.js'), /finish\(app, await runChecks\(/, 'boot() が結果を finish に渡していない');
});
test('net-smoke.js: 確かめる前に、動いている Electron が package.json の版と同じかを見る（古い本体のまま緑にしない。EL9）', () => {
  const s = read('tools/net-smoke.js');
  assert.ok(s.includes("require('./electron-version')"));
  const boot = s.slice(s.indexOf('function boot()'));
  const iVer = boot.indexOf('versionIssue(process.versions');
  const iRun = boot.indexOf('runChecks(');
  assert.ok(iVer > 0 && iVer < iRun, '版の確かめが無いか、確かめの後にある');
  // 確かめるだけでなく、違えば止める（versionGate が「NG 版: …」を出し、流し切ってから 1 で終える。
  // 止め方そのものは test/electron-smoke.test.js が押さえる）
  const iGate = boot.indexOf('if (versionGate(app, versionIssue(process.versions');
  assert.ok(iGate > 0 && iGate < iRun, '版が違っても止めていない（versionGate の答えで return していない）');
  assert.match(boot.slice(iGate, iRun), /^\s*if \(versionGate\(app, versionIssue\(process\.versions, [^\n]*\)\)\) return;$/m);
  assert.ok(!/Electron 31 の net\.request が/.test(s.slice(0, 400)), '頭の注釈が 31 のまま');
});

// ---------------------------------------------------------------- 本体の取り込み（第0c回 EL8・EL9。C3）
test('本物の Electron を動かす全部のジョブで、npm install の後・electron.exe の前に install.js を走らせ、npx install-electron を使わない', () => {
  let seen = 0;
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const y = read(f);
    assert.ok(!/npx\s+(--no\s+)?install-electron/.test(y), `${f} が npx install-electron を使っている（31 には無く、npm に同じ名前の別の包みがある）`);
    for (const [name, job] of Object.entries(jobsOf(y))) {
      // release.yml の ci は ci.yml を呼ぶだけで steps が無い（呼ばれる ci.yml はこの輪で見る）
      if (!job.includes('\n    steps:\n')) { assert.match(job, /^    uses: \.\/\.github\/workflows\/ci\.yml$/m, `${f} の ${name} に steps が無い`); continue; }
      const st = stepsOf(job);
      st.forEach((s, k) => {
        if (!/node_modules\/electron\/dist\/electron\.exe/.test(s)) return;
        seen += 1;
        const before = st.slice(0, k);
        const iNpm = before.findIndex((x) => /npm install/.test(x));
        const iInst = before.findIndex((x) => /node node_modules\/electron\/install\.js/.test(x));
        assert.ok(iNpm >= 0 && iInst > iNpm, `${f} の ${name} の ${k + 1} 番目: electron.exe の前に（npm install の後の）install.js が無い`);
      });
    }
  }
  assert.ok(seen >= 1, '本物の Electron を動かす段が見つからない（このテストが何も見ていない）');
});

// ---------------------------------------------------------------- Node 24（第0c回 EL7。C4・RF15）
test('CI とリリースの Node は全部 24（アプリの Node 24 系に合わせる。Electron 44 の包みは 22.12 以上を求める）', () => {
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const vs = [...read(f).matchAll(/node-version: '([^']+)'/g)].map((m) => m[1]);
    assert.ok(vs.length >= 2, `${f} の setup-node が見つからない`);
    assert.deepStrictEqual([...new Set(vs)], ['24'], `${f}: ${vs.join(',')}`);
  }
});
test('npm test は TAP で出す（Node 23 から既定が spec になり、ci.yml の「# skipped」の確かめが落ちる）', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.strictEqual(pkg.scripts.test, 'node --test --test-reporter=tap "test/*.test.js"');
});

// ---------------------------------------------------------------- electron-smoke・リリースの煙テスト（第0c回 EL6・EL8。C5）
const idxOf = (st, re) => st.findIndex((s) => re.test(s));
// 0.10.0 PB-1 で意図して変えた（D76）: ポータブル版を作らない（NSIS だけ）
test('ci.yml の electron-smoke（Windows）: 本体を取り込み、node_modules の Electron で煙テスト → NSIS → 詰めた NaTsu.exe で煙テスト', () => {
  const j = jobsOf(read('.github/workflows/ci.yml'))['electron-smoke'];
  assert.ok(j, 'electron-smoke のジョブが無い');
  assert.match(j, /^    runs-on: windows-latest$/m);
  const st = stepsOf(j);
  assert.ok(st.some((s) => /uses: actions\/checkout@v4/.test(s) && /fetch-depth: 0/.test(s)), '履歴ごと取っていない（Task 14 のテスト全部で gate.test.js が読む）');
  const i = [/npm install --no-audit --no-fund/, /node node_modules\/electron\/install\.js/,
    /ELECTRON_RUN_AS_NODE=1 node_modules\/electron\/dist\/electron\.exe tools\/sqlite-probe\.js/,
    /electron-builder --win nsis --publish never/,
    /ELECTRON_RUN_AS_NODE=1 dist\/win-unpacked\/NaTsu\.exe tools\/sqlite-probe\.js/].map((re) => idxOf(st, re));
  assert.ok(i[0] >= 0 && i.every((v, k) => k === 0 || v > i[k - 1]), `順が違う: ${i.join(',')}`);
});
// 0.10.0 PB-1 で意図して変えた（D76）: ポータブル版を作らず、setup だけを添付する
test('release.yml の installer: 本体を取り込んで煙テストを通してから exe を作り、詰めた NaTsu.exe でも通してから、setup を添付する', () => {
  const st = stepsOf(jobsOf(read('.github/workflows/release.yml')).installer);
  const i = [/npm install --no-audit --no-fund/, /node node_modules\/electron\/install\.js/,
    /ELECTRON_RUN_AS_NODE=1 node_modules\/electron\/dist\/electron\.exe tools\/sqlite-probe\.js/,
    /npm run dist:installer -- --publish never/,
    /ELECTRON_RUN_AS_NODE=1 dist\/win-unpacked\/NaTsu\.exe tools\/sqlite-probe\.js/,
    /gh release upload "\$TAG" --repo "\$GITHUB_REPOSITORY" dist\/\*-setup\.exe$/m].map((re) => idxOf(st, re));
  assert.ok(i[0] >= 0 && i.every((v, k) => k === 0 || v > i[k - 1]), `順が違う: ${i.join(',')}`);
  for (const k of [1, 2, 3, 4]) assert.match(st[i[k]], /^\s*if: steps\.exists\.outputs\.skip == 'false'$/m, `${k} 番目の段が、既に exe があるときも走る`);
});
test('ci.yml の electron-smoke: 小さなアプリと、テスト全部を Electron の Node で回す段が、煙テストの後・exe を作る前にある', () => {
  const st = stepsOf(jobsOf(read('.github/workflows/ci.yml'))['electron-smoke']);
  const i = [/ELECTRON_RUN_AS_NODE=1 node_modules\/electron\/dist\/electron\.exe tools\/sqlite-probe\.js/,
    /node_modules\/electron\/dist\/electron\.exe tools\/electron-smoke$/m,
    /ELECTRON_RUN_AS_NODE=1 node_modules\/electron\/dist\/electron\.exe --test --test-reporter=tap "test\/\*\.test\.js"/,
    /electron-builder --win nsis/].map((re) => idxOf(st, re));
  assert.ok(i[0] >= 0 && i.every((v, k) => k === 0 || v > i[k - 1]), `順が違う: ${i.join(',')}`);
  assert.ok(st[i[2]].includes('# skipped') && st[i[2]].includes('-gt 1'), '飛ばしたテストの数を見ていない');
});

// 0.9.0 O-2（RP4・F11）: 録音バーの窓の setBounds（17）を、拡大率 1.25 でもう一度本物の Electron で確かめる段が、ふだんの煙テストの後・画面を撮る前にある
test('ci.yml の electron-smoke: 17（録音バーの窓の大きさ）を拡大率 1.25 で確かめる段が、ふだんの煙テストの後・主な画面を撮る前にある', () => {
  const st = stepsOf(jobsOf(read('.github/workflows/ci.yml'))['electron-smoke']);
  const i = [/node_modules\/electron\/dist\/electron\.exe tools\/electron-smoke$/m,
    /node_modules\/electron\/dist\/electron\.exe tools\/electron-smoke --only=17 --scale=1\.25$/m,
    /electron\.exe tools\/shots /].map((re) => idxOf(st, re));
  assert.ok(i[0] >= 0 && i.every((v, k) => k === 0 || v > i[k - 1]), `順が違う: ${i.join(',')}`);
});

// 第0c回 0.3.0 の CI で見つけた: npm 11（Node 24）の npx は `npx --no electron-builder --win nsis portable` の
// `--win` を npm の設定として読み、nsis・portable を electron-builder へ渡してしまう（Unknown arguments: nsis, portable で赤）。
test('ワークフローは npx で道具を呼ばず、node_modules/.bin か npm run で呼ぶ（npx は後ろの --win などを npm の設定として読む）', () => {
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const runs = read(f).split('\n').filter((l) => /^\s*(- )?run: /.test(l) || /^\s{10,}\S/.test(l)).join('\n');
    assert.ok(!/(^|[\s'"|;&])npx\s/m.test(runs.replace(/#.*$/gm, '')), `${f} が npx を使っている`);
  }
  assert.match(read('.github/workflows/ci.yml'), /^        run: node_modules\/\.bin\/electron-builder --win nsis --publish never$/m);
});

test('ci.yml・release.yml: 引用符の無い1行の値に「: 」が無い（あると YAML として読めず、ワークフローが1つのジョブも動かずに赤になる）', { timeout: 5000 }, () => {
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const bad = [];
    read(f).split(/\r?\n/).forEach((line, i) => {
      const m = /^\s*(?:- )?[A-Za-z0-9_-]+:[ ]+(.+)$/.exec(line);
      if (!m) return;
      const v = m[1].replace(/\s+#.*$/, ''); // 後ろの「 #」からはコメント
      if (/^['"|>{[&*!#]/.test(v)) return;
      if (/: /.test(v) || /:$/.test(v)) bad.push(`${f}:${i + 1}: ${line.trim()}`);
    });
    assert.deepStrictEqual(bad, [], '引用符で囲むか、「: 」を使わない書き方にする');
  }
});

test('ci.yml・release.yml: 段の名前は UTF-8 で 200 バイトまで（記録の zip では「<番号>_<名前>.txt」が1つのファイル名になり、255 バイトを越えると Linux で取り出せない）', { timeout: 5000 }, () => {
  for (const f of ['.github/workflows/ci.yml', '.github/workflows/release.yml']) {
    const long = read(f).split(/\r?\n/)
      .map((line) => /^\s*- name: (.+)$/.exec(line))
      .filter((m) => m && Buffer.byteLength(m[1], 'utf8') > 200)
      .map((m) => `${f}: ${Buffer.byteLength(m[1], 'utf8')} バイト: ${m[1]}`);
    assert.deepStrictEqual(long, [], '段の名前を短くする');
  }
});

// 第1a回 合流（run 39104480319）: Electron の Node で回すテストで、偽のサーバーを立てて取り込む engine-install のテストが
// 5.6 秒で見張り（5 秒）に当たった（同じ時間帯に、取り込みのテスト約 40 個がふだんの 5〜15 倍の時間だった。ふだんは 0.3 秒）。
// 5 秒の見張りは「係が止まらない誤りで npm test が終わらなくならない」ためのもので、速さの目安ではない。偽のサーバーを立てて
// ファイルを書き換えるテストの見張りは、子のプロセスを起こすテストと同じ 20 秒にする（PS_WAIT と同じ考え）
test('サーバーを立てる取り込みのテスト（engine-install・engine-fetch）の見張りは 20 秒（IO_WAIT）。ほかのテストには付けない', { timeout: 5000 }, () => {
  for (const f of ['test/engine-install.test.js', 'test/engine-fetch.test.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.ok(src.includes('const IO_WAIT = { timeout: 20000 };'), `${f}: IO_WAIT が無い`);
    const blocks = src.split(/\n(?=test\()/).filter((b) => b.startsWith('test('));
    assert.ok(blocks.length > 10, f);
    for (const b of blocks) {
      const head = b.split('\n')[0];
      const io = /\b(smallSet|startServers)\(/.test(b);
      assert.strictEqual(head.includes(', IO_WAIT, '), io, `${f}: ${head.slice(0, 60)}`);
    }
  }
});

// ---------------------------------------------------------------- 0.10.0 PB-1（D76・決めたこと 150）: ポータブル版を作らず配らない
test('D76: ci.yml は electron-builder --win nsis --publish never・release.yml の添付は *-setup.exe だけで *-portable.exe の字が無い', () => {
  const ci = read('.github/workflows/ci.yml');
  const rel = read('.github/workflows/release.yml');
  assert.match(ci, /electron-builder --win nsis --publish never/);
  assert.match(ci, /ls -l dist\/\*-setup\.exe$/m);
  for (const [n, t] of [['ci.yml', ci], ['release.yml', rel]]) {
    assert.ok(!/portable/i.test(t.replace(/^\s*#.*$/gm, '')), `${n} にポータブル版の字がある`);
  }
  assert.ok(!/npm run dist -- /.test(rel), 'release.yml がポータブル版を作る');
});
