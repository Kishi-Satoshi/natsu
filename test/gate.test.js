'use strict';
// 変更危険度ゲートそのものを検査する。
// 「落ちるべきものが落ち、落ちてはいけないもので落ちない」を機械が確かめ続ける。
// これが無いと、ゲートは静かに空振りしはじめる（過去に正規表現検査で実際に起きた）。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const H = require('../tools/lib/htmltree');
const E = require('../tools/hedit');
const HTMLS = ['src/renderer/app.html', 'src/renderer/overlay.html'];
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const hasGit = (() => { try { cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; } })();

test('HTML が木として正しい（閉じ忘れ・相手のいない閉じタグが無い）', () => {
  for (const f of HTMLS) {
    const r = H.parse(read(f), f);
    assert.deepStrictEqual(r.errors, [], `${f}: ${JSON.stringify(r.errors)}`);
    assert.ok(H.elements(r).length > 20, `${f} の要素が少なすぎる（検査が空振りしている）`);
  }
});

test('hedit の自己検査が、要素を落とす編集を必ず拒む', () => {
  const src = read('src/renderer/app.html');
  // 「最後のカードより後ろを切り落とす」= v0.10.3 の事故そのもの
  const cut = src.replace(/<span class="save-msg" id="saveMsg"><\/span>/, '');
  const { bad } = E.verify(src, cut, 'app.html');
  assert.ok(bad.some((b) => b.includes('要素が増減した')), '要素の消失を拒めていない: ' + JSON.stringify(bad));
});

test('hedit の自己検査が、閉じタグの道連れを必ず拒む', () => {
  const S = require('../tools/lib/sel');
  const src = read('src/renderer/app.html');
  const root = H.parse(src, 'app.html');
  const scroll = S.matches(root, '#tabSettings > .scroll')[0];
  const card1 = S.matches(root, '#tabSettings > .scroll > .card')[0];
  assert.ok(scroll && card1 && scroll.closeStart != null);
  // 枠を閉じる </div> を1枚目のカードの直後へ動かす（v0.10.2 の事故そのもの）。
  // 開閉の総数は変わらないので、数を数える検査では捕まらない。
  const close = src.slice(scroll.closeStart, scroll.end);
  const broken = src.slice(0, card1.end) + close
    + src.slice(card1.end, scroll.closeStart) + src.slice(scroll.end);
  assert.strictEqual((broken.match(/<div/g) || []).length, (src.match(/<div/g) || []).length);
  assert.strictEqual((broken.match(/<\/div>/g) || []).length, (src.match(/<\/div>/g) || []).length);
  const { bad, moved } = E.verify(src, broken, 'app.html');
  assert.ok(bad.length || moved.length, '枠からの離脱を拒めていない');
  assert.ok(moved.some((m) => m.includes('div.scroll')), '離脱した枠を名指しできていない: ' + JSON.stringify(moved.slice(0, 2)));
});

test('ゲートが、実機で起きた5件のデグレを、それが入ったコミットで止める', { skip: !hasGit && 'git が無い' }, () => {
  const R = require('../tools/risk');
  const cases = [
    { base: '4fd8de5^', head: '4fd8de5', want: ['透過ウィンドウの地雷'], why: 'v0.9.11 で直した透過破壊（backgroundThrottling）' },
    { base: 'ebb3b5d', head: 'c71fabc', want: ['HTML-枠からの離脱', '透過ウィンドウの地雷', '地とインクの向き'], why: 'v0.10.1 の暗色地/影 と v0.10.2 のカード枠外' },
    { base: '8bdd954', head: 'cd6c365', want: ['HTML-要素の消失', 'HTML-参照の破れ'], why: 'v0.10.3 の footer 切り落とし と v0.10.4 の更新ボタン死亡' },
  ];
  for (const c of cases) {
    const rules = new Set(R.analyze(c.base, c.head).findings.filter((f) => f.level === 'BLOCK').map((f) => f.rule));
    for (const w of c.want) assert.ok(rules.has(w), `${c.head}（${c.why}）で「${w}」が出ていない。出たのは ${[...rules].join(', ')}`);
  }
});

test('ゲートが、健全なコミットでは鳴らない（誤検知の実測）', { skip: !hasGit && 'git が無い' }, () => {
  const R = require('../tools/risk');
  const bug = new Set(['4fd8de5', 'c71fabc', 'cd6c365']);
  const log = cp.execFileSync('git', ['log', '--format=%h', '-30'], { cwd: ROOT }).toString().trim().split('\n');
  let checked = 0;
  for (const h of log) {
    let b;
    try { b = cp.execFileSync('git', ['rev-parse', '--short', h + '^'], { cwd: ROOT }).toString().trim(); } catch { continue; }
    if (bug.has(h)) continue;
    const news = R.analyze(b, h).findings.filter((f) => f.level === 'BLOCK' && f.rule !== '復旧の導線' && f.rule !== '配布-ps1');
    assert.deepStrictEqual(news.map((f) => f.rule + ': ' + f.msg.split('\n')[0]), [], `健全な ${h} で鳴った`);
    checked++;
  }
  assert.ok(checked >= 20, `検査したコミットが ${checked} 件しかない（空振り）`);
});

test('N2・F9: 台帳にある意図した移動だけ WARN「意図した移動」。台帳に無い id・枠・ファイルの離脱は今までどおり BLOCK', () => {
  const R = require('../tools/risk');
  const before = '<section id="tabNotes" class="tab active"><div class="notes"><aside class="side"><input id="searchBox"><div id="plist"></div><button id="mtToggleBtn"></button><button id="mtDiscardBtn"></button><button id="fltAll"></button><button id="fltActions"></button><button id="fltFull"></button></aside><div class="page" id="pageWrap"><div id="pTitle"></div></div></div></section>';
  const moved = '<aside class="side"><input id="searchBox"><div id="plist"></div><button id="mtToggleBtn"></button><button id="mtDiscardBtn"></button><button id="fltAll"></button><button id="fltActions"></button><button id="fltFull"></button></aside><section id="tabNotes" class="tab active"><div class="notes"><div class="page" id="pageWrap"><div id="pTitle"></div></div></div></section>';
  const rules = (b, a, f = 'src/renderer/app.html') => R.htmlFindings(f, b, a).map((x) => `${x.level} ${x.rule}`);
  assert.deepStrictEqual(rules(before, moved), ['WARN 意図した移動']);
  const alsoTitle = moved.replace('<div id="pTitle"></div></div></div></section>', '</div></div></section><div id="pTitle"></div>');
  assert.ok(rules(before, alsoTitle).includes('BLOCK HTML-枠からの離脱'), '台帳に無い id（pTitle）まで通した');
  assert.ok(rules(before, moved, 'src/renderer/other.html').includes('BLOCK HTML-枠からの離脱'), 'ほかのファイルまで通した');
  // 同じ枠を失った組に台帳に無い id が1つでも混ざれば BLOCK（失った枠の並びだけで通さない。pTitle は失う枠の並びが違うので、これとは別に見る）
  const stray = (h) => h.replace('</aside>', '</aside><b id="stray"></b>');
  assert.ok(rules(stray(before), stray(moved)).includes('BLOCK HTML-枠からの離脱'), '台帳に無い id（stray）が同じ枠を失ったのに通した');
  for (const m of require('../tools/lib/moves')) assert.ok(m.why && m.file && m.ids.length && m.lost.length, '台帳の行に理由が無い');
  // 台帳を広げるには、このテストも直す（点検で必ず目に入る。黙ってほかの離脱を通す口にしない）
  assert.deepStrictEqual(require('../tools/lib/moves').map((m) => `${m.file} ${m.lost.join(' / ')}: ${m.ids.join(',')}`),
    ['src/renderer/app.html section#tabNotes.tab.active / div.notes: mtToggleBtn,mtDiscardBtn,searchBox,fltAll,fltActions,fltFull,plist',
      'src/renderer/app.html aside#side.side: searchBox,fltAll,fltActions,fltFull',
      'src/renderer/app.html section#tabNotes.tab.active / div.notes / div#pageWrap.page / div.phead / div.pcol: pActs,pMore,pMenu',
      'src/renderer/app.html section#tabNotes.tab.active / div.notes / aside.side: searchBox,fltAll,fltActions,fltFull',
      'src/renderer/app.html section#tabNotes.tab.active / div.notes / div#pageWrap.page / div.phead: pActs']);
});

// 第1b回の「台帳にある意図した移動だけ WARN」と同じ形の rules(before, after)（あちらはテストの中の const なので、ここでも作る）
test('1b2 L-1・G1: 検索の欄と「…」の移動は、1つ前の版からでも natsu-v0.5.0 からでも台帳に当たって WARN。台帳に無い id を混ぜると BLOCK', () => {
  const R = require('../tools/risk');
  const rules = (b, a, f = 'src/renderer/app.html') => R.htmlFindings(f, b, a).map((x) => `${x.level} ${x.rule}`);
  const filters = '<div class="filters"><button id="fltAll"></button><button id="fltActions"></button><button id="fltFull"></button></div>';
  const v050 = `<section id="tabNotes" class="tab active"><div class="notes"><aside class="side"><input id="searchBox">${filters}<div id="plist"></div></aside>`
    + '<div class="page" id="pageWrap"><div class="phead"><div class="pacts" id="pActs"></div><div id="pTitle"></div></div></div></div></section>';
  const b1b = `<div class="app"><aside class="side" id="side"><input id="searchBox">${filters}<div id="plist"></div></aside><div class="col"><div class="topbar"></div><main>`
    + '<section id="tabNotes" class="tab active"><div class="notes"><div class="page" id="pageWrap"><div class="phead"><div class="pcol"><div class="pacts" id="pActs"><button id="pMore"></button><div id="pMenu"></div></div><div id="pTitle"></div></div></div></div></div></section></main></div></div>';
  const now = (extra = '') => '<div class="app"><aside class="side" id="side"><div id="plist"></div></aside><div class="col"><div class="topbar"></div>'
    + '<div class="pagebar"><div class="crumb" id="crumb"></div><div class="pacts" id="pActs"><button id="pMore"></button><div id="pMenu"></div></div></div><main>'
    + '<section id="tabNotes" class="tab active"><div class="notes"><div class="page" id="pageWrap"><div class="phead"><div class="pcol"><div id="pTitle"></div></div></div></div></div></section></main></div>'
    + `<div class="palette" id="palette"><div class="palbox"><input id="searchBox"><div class="palopts">${filters}</div>${extra}</div></div></div>`;
  for (const before of [v050, b1b]) {
    const r = rules(before, now());
    assert.ok(!r.includes('BLOCK HTML-枠からの離脱'), r.join('\n'));
    assert.ok(r.includes('WARN 意図した移動'), r.join('\n'));
  }
  // 台帳に無い id（stray）が検索の欄と同じ枠を失ったら BLOCK のまま
  const strayBefore = b1b.replace('<input id="searchBox">', '<input id="searchBox"><b id="stray"></b>');
  assert.ok(rules(strayBefore, now('<b id="stray"></b>')).includes('BLOCK HTML-枠からの離脱'), '台帳に無い id まで通した');
});

test('RF2: main 側に外向きのグローバル fetch を足すと BLOCK。127.0.0.1・net.fetch・net.request・画面は通す', () => {
  const R = require('../tools/risk');
  const base = 'async function a() { await fetch(url, {}); }\n';
  assert.deepStrictEqual(R.fetchFindings('src/x.js', base, base), []);
  assert.strictEqual(R.fetchFindings('src/x.js', base, base + "await fetch('https://example.invalid/a');\n").length, 1);
  assert.deepStrictEqual(R.fetchFindings('src/x.js', base, base + 'await fetch(`http://127.0.0.1:${p}/health`);\n'), []);
  assert.deepStrictEqual(R.fetchFindings('src/x.js', base, base + 'await net.fetch(u); electronNet.request(o);\n'), []);
  assert.deepStrictEqual(R.fetchFindings('src/renderer/app.html', '', "fetch('https://example.invalid')"), []);
  assert.strictEqual(R.fetchFindings('src/new.js', null, 'fetch(u)\n').length, 1);
  // 今ある呼び出しの同じ行の他の所を直しても鳴らない（第1引数で数える）
  assert.deepStrictEqual(R.fetchFindings('src/x.js', base, 'async function a() { await fetch(url, { signal: s }); }\n'), []);
  // 注釈の中は数えない
  assert.deepStrictEqual(R.fetchFindings('src/x.js', base, base + "// fetch('https://example.invalid')\n"), []);
  assert.ok(R.SCOPE.sees.some((s) => s.includes('グローバルの fetch')));
});

test('RF2: analyze が変わった src の .js を fetchFindings に渡して BLOCK にする。globalThis.fetch と 127.0.0.1 に似た名前も数える', () => {
  const R = require('../tools/risk');
  const src = read('tools/risk.js');
  const at = src.indexOf('function analyze(');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(body, /fetchFindings\(f, at\(base, f\), at\(head, f\)\)/, 'analyze が fetchFindings を呼んでいない');
  assert.match(body, /add\('BLOCK', 'main の外向き通信'/, '見つけても BLOCK にしていない');
  assert.strictEqual(R.fetchFindings('src/x.js', '', "globalThis.fetch('https://example.invalid/a');\n").length, 1);
  assert.strictEqual(R.fetchFindings('src/x.js', '', "fetch('http://127.0.0.1.example.invalid/');\n").length, 1);
  // 画面（src/renderer/）は main ではないので、.js でも数えない
  assert.deepStrictEqual(R.fetchFindings('src/renderer/x.js', null, "fetch('https://example.invalid')\n"), []);
  // 127.0.0.1 の後に userinfo の @ が来るものは、本当のホストが別なので数える。ポートを足し算で作る形は今までどおり通す
  assert.strictEqual(R.fetchFindings('src/x.js', '', "fetch('http://127.0.0.1:80@10.0.0.2/');\n").length, 1);
  assert.deepStrictEqual(R.fetchFindings('src/x.js', '', "fetch('http://127.0.0.1:' + port + '/health');\n"), []);
  // 足し算の後ろの文字に @ があるものも、本当のホストが別になりうるので数える
  assert.strictEqual(R.fetchFindings('src/x.js', '', "fetch('http://127.0.0.1:' + port + '@example.invalid/');\n").length, 1);
});

test('RF2: 新しい src の .js がある範囲をゲートにかけても、git の fatal の行を出さない（リリースのゲートの記録が失敗に見えない）', { skip: !hasGit && 'git が無い' }, () => {
  // 基準の版に無いファイルを git show で読むと、git が stderr に fatal の行を出す。結果は BLOCK 0 でも、記録では失敗に見える
  const h = cp.execFileSync('git', ['log', '--diff-filter=A', '--format=%h', '-1', '--', ':(glob)src/*.js'], { cwd: ROOT }).toString().trim();
  assert.ok(h, 'src の .js を足した commit が見つからない');
  const r = cp.spawnSync(process.execPath, ['tools/risk.js', '--base', h + '^', '--head', h], { cwd: ROOT, encoding: 'utf8' });
  assert.match(r.stdout, /結果: BLOCK 0 件/, r.stdout + r.stderr);
  assert.ok(!/fatal:/.test(r.stderr), `git の fatal の行が出た:\n${r.stderr}`);
});

test('新しい .ps1 を足した範囲をゲートにかけても、git の fatal の行を出さない（基準の版に無い .ps1 を読みに行かない）', { skip: !hasGit && 'git が無い' }, () => {
  const h = cp.execFileSync('git', ['log', '--diff-filter=A', '--format=%h', '-1', '--', ':(glob)**/*.ps1'], { cwd: ROOT }).toString().trim();
  assert.ok(h, '.ps1 を足した commit が見つからない');
  // 足す前の版どうしを比べる。今の索引にある .ps1 は、どちらの版にも無い
  const r = cp.spawnSync(process.execPath, ['tools/risk.js', '--base', h + '^', '--head', h + '^'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(r.stdout, /結果: BLOCK 0 件/, r.stdout + r.stderr);
  assert.ok(!/fatal:/.test(r.stderr), `git の fatal の行が出た:\n${r.stderr}`);
});

test('RF2: チェックリストに、ゲートが見る範囲（SCOPE.sees）が1行ずつ全部出る（main の外向きの通信を含む）', { skip: !hasGit && 'git が無い' }, () => {
  const R = require('../tools/risk');
  assert.ok(R.SCOPE.sees.includes('main プロセスの外向きの通信（グローバルの fetch）'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-取込𠮷-'));
  try {
    const out = path.join(dir, 'RELEASE-CHECK.md');
    cp.execFileSync(process.execPath, ['tools/risk.js', '--base', 'HEAD', '--head', 'HEAD', '--checklist', out], { cwd: ROOT });
    const lines = fs.readFileSync(out, 'utf8').split('\n');
    for (const s of R.SCOPE.sees) {
      assert.ok(lines.some((l) => l.startsWith(`- [x] ${s}: `) || l.startsWith(`- [ ] ${s}: `)), `チェックリストに「${s}」の行が無い`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('復旧の導線が、画面を経由せずに main 側から到達できる', () => {
  const R = require('../tools/risk');
  const bad = R.analyze('HEAD', null).findings.filter((f) => f.rule === '復旧の導線');
  assert.deepStrictEqual(bad.map((f) => f.msg), []);
});

test('.ps1 は BOM 付きで、生成器を通さない書き出しが無い', () => {
  const R = require('../tools/risk');
  const bad = R.analyze('HEAD', null).findings.filter((f) => f.rule === '配布-ps1');
  assert.deepStrictEqual(bad.map((f) => f.file + ': ' + f.msg), []);
});

test('G8・JS5: src の JSON の直書き（writeFileSync・writeFile と JSON.stringify が同じ行）を足すと BLOCK。jsonfile.js・画面・WAV・記録の追記・前からある行は通す', { timeout: 5000 }, () => {
  const R = require('../tools/risk');
  const base = 'const a = 1;\n';
  assert.strictEqual(R.jsonWriteFindings('src/x.js', base, `${base}fs.writeFileSync(f, JSON.stringify(o), 'utf8');\n`).length, 1);
  assert.strictEqual(R.jsonWriteFindings('src/x.js', base, `${base}await fsp.writeFile(tmp, JSON.stringify({ a }));\n`).length, 1);
  assert.strictEqual(R.jsonWriteFindings('src/x.js', base, `${base}await fs.promises.writeFile(p, JSON.stringify(v, null, 2));\n`).length, 1);
  assert.deepStrictEqual(R.jsonWriteFindings('src/jsonfile.js', base, `${base}fs.writeFileSync(fd, JSON.stringify(v));\n`), []);
  assert.deepStrictEqual(R.jsonWriteFindings('src/renderer/app.html', '', 'fs.writeFileSync(f, JSON.stringify(o))'), []);
  assert.deepStrictEqual(R.jsonWriteFindings('src/x.js', base, `${base}fs.writeFileSync(\`\${file}.tmp\`, buffer);\n`), []);
  assert.deepStrictEqual(R.jsonWriteFindings('src/x.js', base, `${base}fs.appendFileSync(log, JSON.stringify(o));\n`), []);
  assert.deepStrictEqual(R.jsonWriteFindings('src/x.js', base, `${base}// fs.writeFileSync(f, JSON.stringify(o));\n`), [], '注釈の中で鳴った');
  const old = "fs.writeFileSync(f, JSON.stringify(o), 'utf8');\n";
  assert.deepStrictEqual(R.jsonWriteFindings('src/x.js', old, `${old}const b = 2;\n`), [], '前からある行で鳴った');
  assert.deepStrictEqual(R.jsonWriteFindings('src/x.js', old, ''), [], '消したら鳴った');
});

test('G8・JS5: analyze が JSON の直書きの検査を呼ぶ（BLOCK の名前は「JSON の直書き」）', { timeout: 5000 }, () => {
  const src = read('tools/risk.js');
  assert.ok(src.includes("add('BLOCK', 'JSON の直書き', f,") && src.includes('jsonWriteFindings(f, at(base, f), at(head, f))'));
});

test('JS5: src の中で JSON を直接書く行は、jsonfile.js のほかに 0 件（全部の書き手を部品に移した）', { timeout: 5000 }, () => {
  const R = require('../tools/risk');
  const files = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js') && f !== 'jsonfile.js').map((f) => `src/${f}`);
  for (const f of files) assert.deepStrictEqual(R.jsonWriteFindings(f, '', read(f)), [], f);
});

// ---------- 外への送り方と Claude Code の呼び方（第1c回 Task D-1。G8・OL8） ----------
test('OL8: src の --bare・.credentials.json・同期の safeStorage・claude-cli.js のほかでの claude の起動を止める', { timeout: 5000 }, () => {
  const R = require('../tools/risk');
  const bad = [
    ['src/main.js', "const args = ['--bare', '-p'];"],
    ['src/main.js', "fs.readFileSync(path.join(home, '.claude', '.credentials.json'))"],
    ['src/secrets.js', 'const b = safeStorage.encryptString(key);'],
    ['src/secrets.js', 'const s = safeStorage.decryptString(buf);'],
    ['src/main.js', "spawn('claude', ['-p'])"],
    ['src/main.js', "cp.execFile(claudePath, ['auth', 'status'], cb)"],
    ['src/claude-cli.js', "const args = ['--bare', '-p'];"],
  ];
  for (const [file, line] of bad) assert.ok(R.onlineFindings(file, '', `${line}\n`).length > 0, line);
  assert.deepStrictEqual(R.onlineFindings('src/claude-cli.js', '', "const child = spawn(cmd, [...preArgs, ...args], { shell: false });\n"), []);
  assert.deepStrictEqual(R.onlineFindings('test/claude-cli.test.js', '', "spawn('claude', ['--bare'])\n"), [], 'テストまで止めた');
  // 非同期の形・注釈・前からある行・ほかの子の起動では鳴らない
  assert.deepStrictEqual(R.onlineFindings('src/secrets.js', '', 'const buf = await safeStorage.encryptStringAsync(key);\nconst out = await safeStorage.decryptStringAsync(b);\n'), []);
  assert.deepStrictEqual(R.onlineFindings('src/main.js', '', '// --bare は使わない（.credentials.json も読まない）\n'), [], '注釈の中で鳴った');
  assert.deepStrictEqual(R.onlineFindings('src/main.js', '', "const child = spawn(whisperExe, args, { windowsHide: true });\n"), []);
  const old = "const args = ['--bare'];\n";
  assert.deepStrictEqual(R.onlineFindings('src/main.js', old, `${old}const b = 2;\n`), [], '前からある行で鳴った');
});

test('OL8: analyze が外への送り方と Claude Code の呼び方の検査を呼び、射程に載る。今の src には1件も無い', { timeout: 5000 }, () => {
  const R = require('../tools/risk');
  const src = read('tools/risk.js');
  assert.ok(src.includes("add('BLOCK', '外への送り方と Claude Code の呼び方', f,") && src.includes('onlineFindings(f, at(base, f), at(head, f))'));
  assert.ok(R.SCOPE.sees.includes('Claude Code の呼び方と鍵のしまい方（--bare・.credentials.json・同期の safeStorage・claude-cli.js のほかでの claude の起動）'));
  const files = fs.readdirSync(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js')).map((f) => `src/${f}`);
  for (const f of files) assert.deepStrictEqual(R.onlineFindings(f, '', read(f)), [], f);
});
