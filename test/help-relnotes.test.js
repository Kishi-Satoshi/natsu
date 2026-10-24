/* help-relnotes.test.js — ヘルプセンターのリリースノート（計画 docs/plans/2026-10-23-help-relnotes.md の RN1〜RN4・RNF1〜RNF5）
 *
 * 中身は CHANGELOG.md だけ。見出しの形・版の並び・日付・まだ出していない版・本文の変換（記事と同じ help-md）・公開前の確認を、
 * 本物の CHANGELOG.md と、崩した小さな写しで確かめる。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const R = require('../tools/lib/help-relnotes');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/** release.yml の本文の取り方の写し（test/identity.test.js の releaseBody と同じ） */
function releaseBody(cl, tag) {
  const re = new RegExp(`^## +${tag}([ \\t]|$)`);
  const out = [];
  let on = false;
  for (const l of cl.replace(/\r\n?/g, '\n').split('\n')) {
    if (!on) { if (re.test(l)) on = true; continue; }
    if (/^## /.test(l)) break;
    out.push(l);
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}
/** 小さな写し: 頭の説明と、与えた見出しと本文の節 */
const mini = (...secs) => ['# 変更履歴', '', '説明。', '', ...secs.flatMap(([h, b]) => [h, '', ...(b === undefined ? ['- 直しました。'] : b.split('\n')), ''])].join('\n');
const errOf = (text) => { try { R.renderRelnotes(R.parseChangelog(text)); return null; } catch (e) { return e; } };

test('RN-2（RN1・RN4）: 本物の CHANGELOG.md の版は上から新しい順で、どれも日付つき。ページに出す版の本文は、release.yml が取るリリース本文（アプリの［設定］→［更新］の文）とちょうど同じ（RNF4）', { timeout: 5000 }, () => {
  const cl = read('CHANGELOG.md');
  const secs = R.parseChangelog(cl);
  assert.ok(secs.length >= 16);
  assert.deepStrictEqual(secs.slice(-3).map((s) => s.version), ['0.1.2', '0.1.1', '0.1.0']);
  for (const s of secs) {
    assert.strictEqual(s.body, releaseBody(cl, `natsu-v${s.version}`), `${s.version}: 本文がリリース本文と違う`);
    assert.match(cl.split(/\r?\n/)[s.line - 1], new RegExp(`^## natsu-v${s.version.replace(/\./g, '\\.')}( |$)`), `${s.version}: 見出しの行の番号`);
  }
  const shown = R.renderRelnotes(secs);
  const want = secs.filter((s) => s.date).map((s) => s.version);
  assert.deepStrictEqual(shown.map((v) => v.version), want, '出す版の数・並びが CHANGELOG の日付のある節と違う');
  assert.ok(shown.length >= 16);
  const v010 = shown.find((v) => v.version === '0.10.0');
  assert.deepStrictEqual([v010.date, v010.id], ['2026-10-23', 'v0-10-0']);
  assert.match(v010.html, /<strong>Claude から議事録を読めるようになりました。<\/strong>/);
  for (const v of shown) assert.ok(!/<script|\sstyle=|\son[a-z]+=|javascript:/i.test(v.html), `${v.version}: 危ない HTML`);
});

test('RN-2（RN4・参考 1・2）: 見出しの形は2つだけ。版が新しい順でない・同じ版が2回・実在しない日付・上の版より新しい日付・空白の無い全角の括弧・日付の無い節が一番上でない、は作るのを止め、CHANGELOG.md の行を出す', { timeout: 5000 }, () => {
  const ok = mini(['## natsu-v0.2.0', '- まだ出していない版。'], ['## natsu-v0.1.1 （2026-10-18）'], ['## natsu-v0.1.0 （2026-10-17）']);
  assert.deepStrictEqual(R.parseChangelog(ok).map((s) => [s.version, s.date]), [['0.2.0', null], ['0.1.1', '2026-10-18'], ['0.1.0', '2026-10-17']]);
  assert.deepStrictEqual(R.parseChangelog(mini(['## natsu-v0.1.1 （2026-10-17）'], ['## natsu-v0.1.0 （2026-10-17）'])).length, 2, '同じ日の2つの版は通す');
  const bad = [
    ['順の逆', mini(['## natsu-v0.1.0 （2026-10-17）'], ['## natsu-v0.1.1 （2026-10-18）']), 9],
    ['順の逆（同じ日。日付の照らしでは止まらない）', mini(['## natsu-v0.1.0 （2026-10-17）'], ['## natsu-v0.1.1 （2026-10-17）']), 9],
    ['同じ版が2回', mini(['## natsu-v0.1.0 （2026-10-17）'], ['## natsu-v0.1.0 （2026-10-17）']), 9],
    ['実在しない日付', mini(['## natsu-v0.1.1 （2026-02-30）'], ['## natsu-v0.1.0 （2026-02-01）']), 5],
    ['上の版より新しい日付', mini(['## natsu-v0.1.1 （2026-10-17）'], ['## natsu-v0.1.0 （2026-10-18）']), 9],
    ['空白の無い全角の括弧', mini(['## natsu-v0.1.0（2026-10-17）']), 5],
    ['日付の形', mini(['## natsu-v0.1.0 （2026/10/17）']), 5],
    ['知らない見出し', mini(['## 0.1.0']), 5],
    ['日付の無い節が一番上でない', mini(['## natsu-v0.1.1 （2026-10-18）'], ['## natsu-v0.1.0']), 9],
  ];
  for (const [why, text, line] of bad) {
    const e = errOf(text);
    assert.ok(e && e.name === 'HelpBuildError', `${why}: 止めない`);
    assert.strictEqual(e.code, 'bad-changelog', why);
    assert.strictEqual(e.file, 'CHANGELOG.md', why);
    assert.strictEqual(e.line, line, `${why}: 行`);
  }
  assert.strictEqual(errOf('# 変更履歴\n\n説明だけ。\n').code, 'bad-changelog', '版の節が1つも無いのに通した');
});

test('RN-2（F・RNF2）: 日付の無い節（まだ出していない版）はページに出さない。日付のある節だけを、上から新しい順で出す', { timeout: 5000 }, () => {
  const shown = R.renderRelnotes(R.parseChangelog(mini(['## natsu-v0.2.0', '- まだ出していない版。'], ['## natsu-v0.1.0 （2026-10-17）', '- 出した版。'])));
  assert.deepStrictEqual(shown.map((v) => [v.version, v.date, v.id]), [['0.1.0', '2026-10-17', 'v0-1-0']]);
  assert.ok(!shown.some((v) => v.html.includes('まだ出していない版')));
});

test('RN-2（C・RNF3）: 本文は記事と同じ help-md で変換する（太字・コード・入れ子の箇条書き・［…］）。生の HTML・javascript: のリンク・閉じていない ** は作るのを止め、CHANGELOG.md の行を出す', { timeout: 5000 }, () => {
  const [v] = R.renderRelnotes(R.parseChangelog(mini(['## natsu-v0.1.0 （2026-10-17）', '頭の段落。［設定］を押します。\n\n- **太字** と `a < b`\n  1. 入れ子の1\n  2. 入れ子の2'])));
  assert.strictEqual(v.html, '<p>頭の段落。［設定］を押します。</p>\n<ul>\n<li><strong>太字</strong> と <code>a &lt; b</code>\n<ol>\n<li>入れ子の1</li>\n<li>入れ子の2</li>\n</ol></li>\n</ul>');
  const bad = [
    ['生の HTML', mini(['## natsu-v0.1.1 （2026-10-18）'], ['## natsu-v0.1.0 （2026-10-17）', '一行目。\n\n<b>太い</b> 文字']), 13],
    ['javascript: のリンク', mini(['## natsu-v0.1.0 （2026-10-17）', '[押す](javascript:alert(1))']), 7],
    ['閉じていない **', mini(['## natsu-v0.1.0 （2026-10-17）', '- **閉じていない']), 7],
  ];
  for (const [why, text, line] of bad) {
    const e = errOf(text);
    assert.ok(e && e.name === 'HelpBuildError', `${why}: 止めない`);
    assert.strictEqual(e.file, 'CHANGELOG.md', why);
    assert.strictEqual(e.line, line, `${why}: CHANGELOG.md の行でない`);
  }
});

test('RN-5（G-21）: 公開前の確認（チームのドメイン・64 字の16進・個人の Windows のパス・半角の @ のメール）に当たる字面が CHANGELOG.md にあれば作るのを止める。本物の CHANGELOG.md は通る', { timeout: 5000 }, () => {
  const team = ['natsu', 'test.cloudflareaccess.com'].join('-');
  const bad = [`住所は https://${team}/ です。`, `AUD は ${'ab'.repeat(32)} です。`, `場所は ${['C:', 'Users', 'someone', 'x'].join('\\')} です。`, `連絡は ${['someone', 'example.com'].join('@')} へ。`];
  for (const b of bad) {
    const e = errOf(mini(['## natsu-v0.1.0 （2026-10-17）', `- ${b}`]));
    assert.ok(e && e.code === 'bad-changelog' && e.line === 7, `止めない: ${b}`);
  }
  assert.doesNotThrow(() => R.parseChangelog(read('CHANGELOG.md')));
});

test('RN-2（RN4）: 次の版（例 0.10.1）を本物の CHANGELOG.md の一番上に足しても通る。日付つきならページの先頭に出し、日付が無ければ出さない。0.10.0 より前の日付は止める', { timeout: 5000 }, () => {
  const cl = read('CHANGELOG.md');
  const at = cl.indexOf('\n## natsu-v');
  assert.ok(at > 0);
  const add = (h) => `${cl.slice(0, at + 1)}${h}\n\n- 直しました。\n\n${cl.slice(at + 1)}`;
  const top = R.parseChangelog(cl)[0];
  const [a, b, c] = top.version.split('.').map(Number);
  const next = `${a}.${b}.${c + 1}`;
  const dated = R.renderRelnotes(R.parseChangelog(add(`## natsu-v${next} （${top.date}）`)));
  assert.deepStrictEqual([dated[0].version, dated[0].date, dated[1].version], [next, top.date, top.version]);
  assert.deepStrictEqual(R.renderRelnotes(R.parseChangelog(add(`## natsu-v${next}`)))[0].version, top.version);
  const e = errOf(add(`## natsu-v${next} （2026-01-01）`));
  assert.ok(e && e.code === 'bad-changelog' && e.line === cl.slice(0, at + 1).split('\n').length + 4, '上の版の日付が下の版より古いのに通した');
});

// ================= RN-3: ページ・左の目次の行（RN2・RN3。計画の決めたこと D） =================

const { parseHTML } = require('./helpers/simdom');
const { tmpDir } = require('./helpers/help-tmp');
const { build } = require('../tools/help-build');
const { jaDate } = require('../tools/lib/help-page');

/** 本物の help/ と CHANGELOG.md を写したフォルダで作る（edit で写しを書き換えられる）。出力の HTML を返す */
function buildReal(t, edit) {
  const root = tmpDir(t, 'natsu-help-relnotes-');
  fs.cpSync(path.join(ROOT, 'help'), path.join(root, 'help'), { recursive: true, filter: (x) => !x.split(path.sep).includes('dist') });
  fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(root, 'CHANGELOG.md'));
  if (edit) edit(root);
  const out = path.join(root, 'out');
  const r = build({ root, out });
  return { r, html: (f) => fs.readFileSync(path.join(out, f), 'utf8') };
}
const LEDE = 'NaTsu の版ごとの変更点です（新しい版が上）。アプリの［設定］→［更新］に出る文と同じです。古い版の文には、今は無い機能や名前（Groq・ポータブル版 など）が出てきます。今の使い方は各分類の記事を見てください。';

test('RN-3（RN2・RN3）: /release-notes/ のページ。題名・パンくず・h1・頭の注（R-RN1）・版ごとの section（h2 の id は v0-10-0 の形）と公開日の time・並びは CHANGELOG.md の日付のある節の順・本文は help-md の出力', { timeout: 10000 }, (t) => {
  const { r, html } = buildReal(t);
  assert.ok(r.pages.includes('release-notes/index.html'), r.pages.join(','));
  const h = html('release-notes/index.html');
  assert.ok(h.includes('<title>リリースノート — NaTsu ヘルプセンター</title>'));
  assert.ok(h.includes('<nav class="crumbs" aria-label="パンくず"><a href="/">ホーム</a> <span aria-hidden="true">›</span> <span aria-current="page">リリースノート</span></nav>'));
  const doc = parseHTML(h).root;
  const main = doc.querySelector('#hc-main');
  assert.deepStrictEqual(main.querySelectorAll('h1').map((e) => e.textContent), ['リリースノート']);
  assert.strictEqual(main.querySelector('p.lede').textContent, LEDE);
  const want = R.renderRelnotes(R.parseChangelog(read('CHANGELOG.md')));
  const secs = main.querySelectorAll('section').filter((s) => s.parentElement.classList.contains('body'));
  assert.deepStrictEqual(secs.map((s) => s.getAttribute('aria-labelledby')), want.map((v) => v.id));
  secs.forEach((s, k) => {
    const v = want[k];
    const [h2, date] = s.children;
    assert.deepStrictEqual([h2.tagName, h2.id, h2.textContent], ['h2', v.id, v.version], v.version);
    assert.ok(date.classList.contains('relnote-date'), `${v.version}: 公開日の行`);
    const time = date.children[0];
    assert.deepStrictEqual([date.children.length, time.tagName, time.getAttribute('datetime'), time.textContent], [1, 'time', v.date, jaDate(v.date)], v.version);
  });
  for (const v of want) assert.ok(h.includes(`<p class="relnote-date"><time datetime="${v.date}">${jaDate(v.date)}</time></p>\n${v.html}\n</section>`), `${v.version}: 本文が help-md の出力でない`);
  assert.ok(h.includes('<h2 id="v0-10-0">0.10.0</h2>\n<p class="relnote-date"><time datetime="2026-10-23">2026 年 10 月 23 日</time></p>'));
  // 見出しの順: h1 が1つ、版は h2（本文の中に h1 は無い）
  assert.strictEqual(doc.querySelectorAll('h1').length, 1);
});

test('RN-3（D・RNF5）: 右の「このページの内容」に全部の版（新しい順。#v… へのリンク）。左の目次の最後に「リリースノート」の行（このページでは aria-current="page"、ほかのページでは付けない）', { timeout: 10000 }, (t) => {
  const { html } = buildReal(t);
  const h = html('release-notes/index.html');
  const want = R.renderRelnotes(R.parseChangelog(read('CHANGELOG.md')));
  const doc = parseHTML(h).root;
  const on = doc.querySelector('aside.onpage');
  assert.ok(on, '「このページの内容」が無い');
  assert.strictEqual(on.getAttribute('aria-labelledby'), 'hc-onpage');
  assert.strictEqual(on.querySelector('h2#hc-onpage').textContent, 'このページの内容');
  assert.deepStrictEqual(on.querySelectorAll('a').map((a) => [a.getAttribute('href'), a.textContent]), want.map((v) => [`#${v.id}`, v.version]));
  const tocRow = (page) => {
    const toc = parseHTML(page).root.querySelector('nav#hc-toc');
    const cats = toc.children.filter((c) => c.classList.contains('toc-cat'));
    return { last: cats[cats.length - 1], n: cats.length, cur: toc.querySelectorAll('[aria-current="page"]').map((a) => a.getAttribute('href')) };
  };
  const site = JSON.parse(read('help/site.json'));
  const here = tocRow(h);
  assert.strictEqual(here.n, site.categories.length + 1);
  const a = here.last.querySelector('p.toc-h a');
  assert.deepStrictEqual([a.getAttribute('href'), a.textContent, a.getAttribute('aria-current')], ['/release-notes/', 'リリースノート', 'page']);
  assert.strictEqual(here.last.querySelectorAll('ul').length, 0, '目次の行の下に版を並べない');
  assert.deepStrictEqual(here.cur, ['/release-notes/']);
  for (const f of ['start/index.html', 'start/login/index.html']) {
    const o = tocRow(html(f));
    const oa = o.last.querySelector('p.toc-h a');
    assert.deepStrictEqual([oa.getAttribute('href'), oa.textContent, oa.getAttribute('aria-current')], ['/release-notes/', 'リリースノート', null], f);
    assert.ok(!o.cur.includes('/release-notes/'), f);
  }
  // 狭い画面の［目次］（site.js が目次を動かす）も同じ枠
  assert.ok(h.includes('<button type="button" class="toc-btn" aria-controls="hc-toc" aria-expanded="false" hidden>目次</button>'));
});

test('RN-3（F）: CHANGELOG.md の一番上に日付の無い節（まだ出していない版）があっても、ページ・目次・カードの数に出ない', { timeout: 10000 }, (t) => {
  const { html } = buildReal(t, (root) => {
    const f = path.join(root, 'CHANGELOG.md');
    const cl = fs.readFileSync(f, 'utf8');
    const at = cl.indexOf('\n## natsu-v') + 1;
    fs.writeFileSync(f, `${cl.slice(0, at)}## natsu-v9.9.9\n\n- まだ出していない版の文。\n\n${cl.slice(at)}`);
  });
  const h = html('release-notes/index.html');
  assert.ok(!h.includes('9.9.9') && !h.includes('まだ出していない版の文'));
  const n = R.renderRelnotes(R.parseChangelog(read('CHANGELOG.md'))).length;
  assert.ok(html('index.html').includes(`<span class="c">${n} の版</span>`));
});

test('RN-3（RN1）: releaseNotes があるのに CHANGELOG.md が無い・形が違うときは作るのを止め（bad-changelog）、出力に何も書かない', { timeout: 10000 }, (t) => {
  for (const [why, edit] of [['無い', (root) => fs.rmSync(path.join(root, 'CHANGELOG.md'))], ['形が違う', (root) => fs.appendFileSync(path.join(root, 'CHANGELOG.md'), '\n## 0.0.1\n')]]) {
    const root = tmpDir(t, 'natsu-help-relnotes-bad-');
    fs.cpSync(path.join(ROOT, 'help'), path.join(root, 'help'), { recursive: true, filter: (x) => !x.split(path.sep).includes('dist') });
    fs.copyFileSync(path.join(ROOT, 'CHANGELOG.md'), path.join(root, 'CHANGELOG.md'));
    edit(root);
    const out = path.join(root, 'out');
    assert.throws(() => build({ root, out }), (e) => e.name === 'HelpBuildError' && e.code === 'bad-changelog' && e.file === 'CHANGELOG.md', why);
    assert.ok(!fs.existsSync(out), `${why}: 出力に書いた`);
  }
});

// ================= RN-6: リリースの公開の後にヘルプを出し直す（決めたこと F・Q2 の A。ワークフローは動かさない） =================

const { jobsOf, stepsOf } = require('./helpers/yml');
const ifLine = (s) => (s.match(/^\s*if:\s*(.+)$/m) || [])[1] || '';

test('RN-6（F・RNF2）＋審査 A-1・A-2（R-RN3・持ち主の答え A）: help-deploy を起こすのは installer の後ろの小さなジョブ help-redeploy（needs: installer・公開したときだけの if と success()・ジョブの continue-on-error: true・権限は actions: write だけ・取り出しも npm も無し）。失敗は ::warning:: で知らせ、リリースを赤にしない。installer の権限は contents: write だけ', { timeout: 5000 }, () => {
  const y = read('.github/workflows/release.yml');
  const jobs = jobsOf(y);
  assert.deepStrictEqual(Object.keys(jobs), ['ci', 'release', 'installer', 'help-redeploy']);
  const job = jobs['help-redeploy'];
  assert.match(job, /^    needs: installer$/m);
  assert.match(job, /^    if: success\(\) && \(github\.event_name != 'workflow_dispatch' \|\| inputs\.publish\)$/m, '公開しないとき・installer が赤のときにも起こす');
  assert.match(job, /^    continue-on-error: true$/m, '出し直しの失敗でリリースが赤になる');
  const perm = /^    permissions:\n((?:      [^\n]*\n)+)/m.exec(job);
  assert.ok(perm, 'help-redeploy の permissions が無い');
  assert.deepStrictEqual(perm[1].split('\n').filter(Boolean).map((l) => l.replace(/\s+#.*$/, '').trim()), ['actions: write']);
  const st = stepsOf(job);
  assert.strictEqual(st.length, 1, '取り出しや npm を足さない');
  assert.ok(!/actions\/checkout|npm /.test(job));
  assert.match(st[0], /^\s*GH_TOKEN: \$\{\{ github\.token \}\}$/m);
  assert.match(st[0], /^\s*gh workflow run help-deploy\.yml --repo "\$GITHUB_REPOSITORY" --ref main \\$/m);
  assert.match(st[0], /\|\| \{ echo "::warning::[^"]*Run workflow[^"]*"; exit 1; \}/, '失敗を ::warning:: で知らせない');
  assert.strictEqual((y.match(/gh workflow run/g) || []).length, 1, 'ほかにもワークフローを起こしている');
  // installer: 権限は contents: write だけに戻し、公開の段・失敗の要約・一時ブランチの片付けに help-deploy が混ざらない
  const inst = jobs.installer;
  const ip = /^    permissions:\n((?:      [^\n]*\n)+)/m.exec(inst);
  assert.deepStrictEqual(ip[1].split('\n').filter(Boolean).map((l) => l.replace(/\s+#.*$/, '').trim()), ['contents: write']);
  assert.ok(!/help-deploy|actions: write/.test(inst.replace(/^[ \t]*#[^\n]*\n/gm, '')), 'installer に help-deploy を起こす段・actions: write が残っている');
  const ist = stepsOf(inst);
  const iPub = ist.findIndex((s) => /gh release edit "\$TAG"[^\n]*--draft=false --latest/.test(s));
  assert.ok(iPub >= 0 && ifLine(ist[iPub]) === "github.event_name != 'workflow_dispatch' || inputs.publish", '公開の段の if が変わった');
  assert.match(y, /\npermissions:\n  contents: write # リリースとタグの作成に必要\n\n/);
});

test('RN-6（F・RNF2）: help-deploy.yml の paths に CHANGELOG.md が無い（版を上げた commit が main に入っただけでは、公開の前のリリースノートを出さない）。workflow_dispatch は今のまま', { timeout: 5000 }, () => {
  const y = read('.github/workflows/help-deploy.yml');
  const on = y.slice(y.indexOf('\non:\n'), y.indexOf('\npermissions:\n'));
  assert.match(on, /^  workflow_dispatch:/m);
  const paths = /^    paths: \[(.+)\]$/m.exec(on);
  assert.ok(paths, 'paths が無い');
  const list = paths[1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
  assert.ok(!list.some((p) => /CHANGELOG|^\*\*|^\*$/.test(p)), `paths に CHANGELOG.md（か全部に当たる形）がある: ${list.join(', ')}`);
  assert.ok(list.includes('tools/lib/help-*.js'), '作る道具（help-relnotes.js）の変化で出し直さない');
});

// ================= 審査の回（2026-10-24。scratchpad の review-relnotes.md の A-1〜A-5・B-1） =================

test('審査 A-5（R-RN1）: README と release.yml の注の「アプリのどこに出るか」は、アプリの設定の左の列の名前（［設定］→［更新］）。［アップデート］（中のカードの見出し）と書かない。出した版の CHANGELOG の本文は変えない', { timeout: 5000 }, () => {
  const ng = /\[設定\]\s*(?:→|->)\s*\[アップデート\]|［設定］\s*→\s*［アップデート］/;
  for (const f of ['README.md', '.github/workflows/release.yml']) assert.ok(!ng.test(read(f)), `${f} に「[設定] → [アップデート]」が残っている`);
  const readme = read('README.md');
  assert.ok(readme.includes('[設定] → [更新] に表示されます。'), 'README の更新の配布の節');
  assert.ok(readme.includes('[設定] → [更新] → [更新を確認] で検出します。'), 'README の各 PC の更新の確かめ方');
  assert.match(read('.github/workflows/release.yml'), /^# リリース本文はアプリの \[設定\] -> \[更新\] にそのまま表示される。$/m);
  assert.ok(read('src/renderer/app.html').includes('>更新<'), 'アプリの設定の左の列に「更新」が無い（前提が崩れた）');
});

test('審査 A-4（R-RN5）: 版の節の中の見出しの id は版の id を頭に付け（v0-1-0-s1・{#fix} は v0-1-0-fix、ページの中の #fix のリンクも同じ）、見出しの無い表の名前も版ごと（0.1.0 の表 1）。2つの版に同じ見出しがあっても、作ったページの中で id と表の名前が重ならない', { timeout: 10000 }, (t) => {
  const cl = mini(
    ['## natsu-v0.1.1 （2026-10-18）', '### 直したこと\n\n- 1つ。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n### 別の見出し {#v0-1-0}\n\n- 版の id と同じ字の {#…}。'],
    ['## natsu-v0.1.0 （2026-10-17）', '| x | y |\n| --- | --- |\n| 3 | 4 |\n\n### 直したこと {#fix}\n\n- [直したこと](#fix) を見る。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |'],
  );
  const [v1, v0] = R.renderRelnotes(R.parseChangelog(cl));
  assert.ok(v1.html.includes('<h3 id="v0-1-1-s1">直したこと</h3>'), v1.html);
  assert.ok(v1.html.includes('<h3 id="v0-1-1-v0-1-0">別の見出し</h3>'), v1.html);
  assert.ok(v0.html.includes('<h3 id="v0-1-0-fix">直したこと</h3>'), v0.html);
  assert.ok(v0.html.includes('<a href="#v0-1-0-fix">直したこと</a>'), v0.html);
  assert.ok(v0.html.includes('aria-label="0.1.0 の表 1"'), v0.html);
  assert.ok(v1.html.includes('aria-label="0.1.1 の直したことの表"') && v0.html.includes('aria-label="0.1.0 の直したことの表"'));
  // 作ったページ全体で id と表の名前が重ならない（作るときの照らしも通る）
  const { html } = buildReal(t, (root) => fs.writeFileSync(path.join(root, 'CHANGELOG.md'), cl));
  const h = html('release-notes/index.html');
  const ids = [...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(new Set(ids).size, ids.length, `id が重なる: ${ids.join(',')}`);
  const names = [...h.matchAll(/role="region" aria-label="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(names.length, 3);
  assert.strictEqual(new Set(names).size, names.length, names.join(','));
  assert.ok(h.includes('<section aria-labelledby="v0-1-0">\n<h2 id="v0-1-0">0.1.0</h2>'));
});

test('審査 A-3（R-RN4）: 公開前の確認の形は tools/lib/help-public.js に1つだけ置き、リリースノートと記事のテストの両方が使う。パッケージ@版（electron@44.9.0・@anthropic-ai/claude-code@2.0.1）と伏せ字のパス（C:\\Users\\<名前>\\…・%…%・＜…＞）は通し、小文字のパス・メールは止める', { timeout: 5000 }, () => {
  const P = require('../tools/lib/help-public');
  assert.ok(Array.isArray(P.PUBLIC) && P.PUBLIC.length === 4);
  assert.match(fs.readFileSync(path.join(ROOT, 'tools', 'lib', 'help-relnotes.js'), 'utf8'), /require\('\.\/help-public'\)/, 'help-relnotes.js が help-public を使っていない');
  assert.match(read('test/help-content.test.js'), /require\('\.\.\/tools\/lib\/help-public'\)/, '記事のテストが help-public を使っていない');
  const sec = (line) => mini(['## natsu-v0.1.0 （2026-10-17）', `- ${line}`]);
  const pass = [
    'electron@44.9.0 にしました。',
    '`npm i -g @anthropic-ai/claude-code@2.0.1` で入れます。',
    `控えは ${['C:', 'Users', '<名前>', 'AppData'].join('\\')} にあります。`,
    `控えは ${['C:', 'Users', '%USERNAME%', 'AppData'].join('\\')} にあります。`,
    `控えは ${['C:', 'Users', '＜名前＞', 'AppData'].join('\\')} にあります。`,
    '問い合わせは someone＠example.com（全角の＠）へ。',
  ];
  for (const l of pass) assert.strictEqual(errOf(sec(l)), null, `止めた: ${l}`);
  const stop = [
    `場所は ${['c:', 'users', 'someone', 'x'].join('\\')} です。`,
    `場所は ${['C:', '', 'Users', '', 'someone'].join('\\')} です。`,
    `連絡は ${['someone', 'example.co.jp'].join('@')} へ。`,
  ];
  for (const l of stop) {
    const e = errOf(sec(l));
    assert.ok(e && e.code === 'bad-changelog' && e.line === 7, `止めない: ${l}`);
  }
});
