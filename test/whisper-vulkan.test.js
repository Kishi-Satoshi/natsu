/*
 * whisper-vulkan.test.js — 文字起こしの比べ用に whisper.cpp（Vulkan 版）を作るワークフロー
 * （.github/workflows/whisper-vulkan.yml。計画 docs/plans/2026-10-27-stt-bench.md の「1-1」。持ち主の答え GQ1〜GQ3）の形を固定する。
 *
 *  - 手で押すときだけ動く（push・pull_request・schedule・workflow_call で動かない）
 *  - 権限は置く仕事だけが contents: write。他人の action は commit の SHA で固定する
 *  - whisper.cpp の commit と Vulkan SDK の SHA-256 を照らしてから使う
 *  - 置くのは先行版（prerelease）で latest にしない。アプリの札（natsu-v）と release.yml には触らない
 *
 * GitHub Actions は手元で回せないので、YAML を文字列として読む（test/helpers/yml.js）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { jobsOf, stepsOf, nameOf } = require('./helpers/yml');

const ROOT = path.join(__dirname, '..');
const WF = '.github/workflows/whisper-vulkan.yml';
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const runOf = (st) => { const i = st.search(/^\s*run: \|$/m); return i >= 0 ? st.slice(i) : ''; };
const stepNamed = (st, re) => { const s = st.find((x) => re.test(nameOf(x))); assert.ok(s, `段が無い: ${re}`); return s; };

test('whisper-vulkan.yml: 手で押すときだけ動き、入力は whisper.cpp のタグと commit（既定は NaTsu のピン v1.9.5 = d1be6fde）', () => {
  const y = read(WF);
  assert.ok(!/\t/.test(y), 'YAML にタブがある');
  const on = y.slice(y.indexOf('\non:\n'), y.indexOf('\npermissions:'));
  assert.match(on, /^on:\n  workflow_dispatch:\n    inputs:\n/m);
  assert.deepStrictEqual([...on.matchAll(/^  ([a-z_]+):/gm)].map((m) => m[1]), ['workflow_dispatch'], 'workflow_dispatch のほかの起こし方がある');
  assert.ok(!/^\s+(push|pull_request|pull_request_target|schedule|workflow_call|workflow_run|release):/m.test(y), 'push などで動く');
  assert.match(on, /^      whisper_ref:\n(?: {8}.+\n)*? {8}default: 'v1\.9\.5'$/m);
  assert.match(on, /^      whisper_commit:\n(?: {8}.+\n)*? {8}default: 'd1be6fde11ac6e0407606b4e42fe72d34add8037'$/m);
  // 既定の commit は、アプリが今取り込む whisper.cpp（engine-manifest.js の頭の注）と同じ
  assert.ok(read('src/engine-manifest.js').includes('whisper.cpp v1.9.5（commit d1be6fde11ac6e0407606b4e42fe72d34add8037）'), 'アプリのピンが変わった（既定の入力を見直す）');
});

test('whisper-vulkan.yml: 権限は頭と作る仕事が空、置く仕事（main のときだけ）だけが contents: write', () => {
  const y = read(WF);
  assert.match(y, /^permissions: \{\}$/m);
  const jobs = jobsOf(y);
  assert.deepStrictEqual(Object.keys(jobs), ['build', 'publish']);
  assert.match(jobs.build, /^    permissions: \{\}$/m);
  assert.match(jobs.publish, /^    permissions:\n      contents: write(?:\s+#.*)?\n    env:/m);
  assert.match(jobs.publish, /^    needs: build$/m);
  assert.match(jobs.publish, /^    if: github\.ref == 'refs\/heads\/main'(?:\s+#.*)?$/m);
  assert.strictEqual((y.match(/^\s+[a-z-]+: write\b/gm) || []).length, 1, 'write の権限が置く仕事のほかにもある');
  assert.ok(!/secrets\./.test(y), '秘密を読む');
  assert.match(y, /^concurrency:\n  group: whisper-vulkan\n  cancel-in-progress: false$/m);
});

test('whisper-vulkan.yml: 他人の action は commit の SHA（40 桁）で固定し、版を注に書く。このリポジトリは checkout しない', () => {
  const y = read(WF);
  const uses = [...y.matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)].map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(uses.map((u) => u[0]), [
    'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    'actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093',
  ]);
  for (const [u, rest] of uses) {
    assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${u} が SHA で固定されていない`);
    assert.match(rest, /^ # v\d+\.\d+\.\d+$/, `${u} の版の注が無い`);
  }
  assert.ok(!/actions\/checkout/.test(y), 'checkout している');
});

test('whisper-vulkan.yml: run の中に ${{ }} の式を書かず、入力は env で渡して決まった形だけを通す', () => {
  const y = read(WF);
  const jobs = jobsOf(y);
  for (const [name, job] of Object.entries(jobs)) {
    for (const st of stepsOf(job)) assert.ok(!/\$\{\{/.test(runOf(st)), `${name} の「${nameOf(st)}」の run の中に式`);
  }
  assert.ok(!/github\.event\./.test(y), 'github.event を読む');
  const inputs = y.split('\n').filter((l) => /inputs\./.test(l));
  assert.deepStrictEqual(inputs.map((l) => l.trim()), [
    'WHISPER_REF: ${{ inputs.whisper_ref }}',
    'WHISPER_COMMIT: ${{ inputs.whisper_commit }}',
  ]);
  const chk = runOf(stepNamed(stepsOf(jobs.build), /^入力を確かめる$/));
  // PowerShell の -match は大文字小文字を区別しないので、-cnotmatch で照らす
  assert.ok(chk.includes("$env:WHISPER_REF -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$'"), chk);
  assert.ok(chk.includes("$env:WHISPER_COMMIT -cnotmatch '^[0-9a-f]{40}$'"), chk);
  const pub = runOf(stepNamed(stepsOf(jobs.publish), /照らし直す/));
  assert.ok(pub.includes('[[ "$SHORT" =~ ^[0-9a-f]{7}$ ]]'), '置く仕事が受け取った頭7桁を照らさない');
});

test('whisper-vulkan.yml: whisper.cpp の commit と Vulkan SDK（llama.cpp と同じ 1.4.357.0）の SHA-256 を、使う前に照らす', () => {
  const jobs = jobsOf(read(WF));
  const b = jobs.build;
  assert.match(b, /^    runs-on: windows-2025(?:\s+#.*)?$/m);
  assert.match(b, /^      VULKAN_VERSION: 1\.4\.357\.0$/m);
  assert.match(b, /^      VULKAN_SHA256: 81f474711e9042f4cd22b31b2f7a8870db2e428b21586fb43dd80150be97310d(?:\s+#.*)?$/m);
  const st = stepsOf(b);
  const src = runOf(stepNamed(st, /^whisper\.cpp を取り/));
  assert.ok(src.indexOf('git -C src checkout -q --detach FETCH_HEAD') < src.indexOf('if ($head -cne $env:WHISPER_COMMIT) { throw'), 'commit を照らしていない');
  const vk = runOf(stepNamed(st, /^Vulkan SDK/));
  const iHash = vk.indexOf('if ($got -cne $env:VULKAN_SHA256) { throw');
  const iRun = vk.indexOf("Start-Process -FilePath $f -ArgumentList '--accept-licenses', '--default-answer', '--confirm-command', 'install' -Wait -PassThru");
  assert.ok(iHash > 0 && iRun > iHash, 'SHA-256 を照らす前に入れている');
  assert.ok(vk.includes('https://sdk.lunarg.com/sdk/download/$($env:VULKAN_VERSION)/windows/vulkansdk-windows-X64-$($env:VULKAN_VERSION).exe'));
  // 天然のコマンドの失敗で止まる（pwsh は既定では exe の終了コードで止まらない）
  for (const s of st) if (runOf(s) && !/煙テスト/.test(nameOf(s))) assert.match(runOf(s), /^\s+\$PSNativeCommandUseErrorActionPreference = \$true$/m, nameOf(s));
});

test('whisper-vulkan.yml: GGML_VULKAN と静的な実行の部品で whisper-cli・whisper-server を作り、再頒布の包みが要らないことを照らし、--help の煙テストを通してから zip と SHA-256 を出す', () => {
  const st = stepsOf(jobsOf(read(WF)).build);
  const names = st.map(nameOf);
  const build = runOf(stepNamed(st, /^作る/));
  for (const f of ['-DGGML_VULKAN=ON', '-DBUILD_SHARED_LIBS=ON', '-DGGML_BACKEND_DL=ON', '-DGGML_CPU_ALL_VARIANTS=ON', '-DGGML_NATIVE=OFF',
    '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded']) assert.ok(build.includes(f), f);
  assert.ok(build.includes('cmake --build build --config Release --parallel --target whisper-cli whisper-server'));
  const deps = runOf(stepNamed(st, /読む DLL を照らす/));
  assert.ok(deps.includes("if ($k -match '^(msvcp|vcruntime|concrt|ucrtbased)') { throw"), '動的な実行の部品を読んでも止まらない');
  assert.ok(deps.includes("elseif ($k -eq 'vulkan-1.dll') { $how = 'GPU のドライバのもの（同梱しない）' }"));
  assert.ok(/else \{ throw "\$name が読む \$d が、同梱にも Windows にもありません" \}/.test(deps), '知らない DLL を通す');
  for (const w of ['whisper.dll', 'ggml-vulkan.dll', 'ggml-cpu-alderlake.dll', 'ggml-cpu-x64.dll']) assert.ok(deps.includes(`'${w}'`), w);
  const smoke = runOf(stepNamed(st, /^煙テスト/));
  assert.ok(smoke.includes('& .\\whisper-cli.exe --help'), 'whisper-cli --help を回していない');
  assert.ok(smoke.includes('& .\\whisper-server.exe --help'), 'whisper-server --help を回していない');
  assert.ok(!/\.bin\b|-m |ggml-tiny|jfk\.wav/.test(smoke), '作業機に GPU は無いので、文字起こしは試さない');
  const zip = runOf(stepNamed(st, /zip にして SHA-256/));
  for (const f of ["Copy-Item 'src\\LICENSE' (Join-Path $env:PKG 'LICENSE-whisper.cpp.txt')", 'THIRD-PARTY-NOTICES.txt', 'Get-FileHash -Algorithm SHA256 $zip',
    '[IO.File]::WriteAllText("$zip.sha256"', '$env:GITHUB_STEP_SUMMARY']) assert.ok(zip.includes(f), f);
  const order = [/^入力を確かめる$/, /^whisper\.cpp/, /^Vulkan SDK/, /^作る/, /読む DLL/, /^煙テスト/, /zip にして/, /^作ったものを次の仕事へ渡す$/]
    .map((re) => names.findIndex((n) => re.test(n)));
  assert.ok(order.every((v, k) => v >= 0 && (k === 0 || v > order[k - 1])), names.join(' / '));
});

test('whisper-vulkan.yml: 置くのは whisper-vulkan-<頭7桁> の先行版（prerelease・latest にしない）。latest が変わらないことを確かめ、アプリの札と release.yml に触らない', () => {
  const y = read(WF);
  const st = stepsOf(jobsOf(y).publish);
  const verify = runOf(stepNamed(st, /照らし直す/));
  assert.ok(verify.includes('sha256sum -c "${ZIP}.sha256"'));
  assert.ok(verify.includes('echo "TAG=whisper-vulkan-$SHORT" >> "$GITHUB_ENV"'));
  const pub = runOf(stepNamed(st, /^先行版/));
  const rel = pub.split('\n').filter((l) => /gh release (create|edit)/.test(l));
  assert.strictEqual(rel.length, 2, rel.join('\n'));
  for (const l of rel) assert.ok(l.includes('--prerelease --latest=false'), l);
  assert.ok(pub.includes('[ "$AFTER" = "$BEFORE" ] || {'), 'latest が変わっていないことを確かめない');
  assert.ok(pub.includes('--json isPrerelease --jq .isPrerelease)" = "true" ]'), '先行版になったことを確かめない');
  const code = y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.ok(!/natsu-v|--latest(?!=false)|make_latest|--draft=false/.test(code), 'アプリの札や latest に触る');
  assert.ok(!/release\.yml|ci\.yml/.test(code), 'ほかのワークフローを呼ぶ');
  // release.yml・ci.yml の側も、このワークフローを知らない（アプリのリリースと CI は変わらない）
  for (const f of ['.github/workflows/release.yml', '.github/workflows/ci.yml']) assert.ok(!/whisper-vulkan/.test(read(f)), f);
});

test('whisper-vulkan.yml の YAML の書き方（引用符の無い値に「: 」が無い・段の名前は 200 バイトまで）', () => {
  const bad = [];
  read(WF).split(/\r?\n/).forEach((line, i) => {
    const m = /^\s*(?:- )?[A-Za-z0-9_-]+:[ ]+(.+)$/.exec(line);
    if (!m) return;
    const v = m[1].replace(/\s+#.*$/, '');
    if (/^['"|>{[&*!#]/.test(v)) return;
    if (/: /.test(v) || /:$/.test(v)) bad.push(`${i + 1}: ${line.trim()}`);
  });
  assert.deepStrictEqual(bad, []);
  for (const m of read(WF).matchAll(/^\s*- name: (.+)$/gm)) assert.ok(Buffer.byteLength(m[1], 'utf8') <= 200, m[1]);
});
