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
      'src/renderer/app.html section#tabNotes.tab.active / div.notes / div#pageWrap.page / div.phead: pActs',
      // 0.9.0 U-1（SP1・D24）で足した: 設定の section を設定のポップアップへ移す（中の id は全部そのまま）
      `src/renderer/app.html div.app / div.col: ${['tabSettings', 'appearanceCard', 'appearanceTitle', 'themeSel', 'accountCard', 'accountTitle', 'accountOut', 'accountSignIn', 'accountIn', 'accountWho', 'accountLogout', 'accountMsg', 'verNow', 'chkUpdBtn', 'applyUpdBtn', 'updMsg', 'updNotes', 'hotkey', 'hotkeyWarn', 'meetingHotkey', 'meetingHotkeyWarn', 'pillPos', 'micSelect', 'micReloadBtn', 'useSystemAudio', 'spkField', 'spkNow', 'spkReloadBtn', 'spkSettingsBtn', 'language', 'autoPaste', 'removeFillers', 'soundFeedback', 'autoLaunch', 'stayInTray', 'dictionary', 'dictWarn', 'useBuiltinTerms', 'claudeState', 'claudeTest', 'claudeLogin', 'claudeInstall', 'claudeHelp', 'claudeExe', 'onlineMsg', 'engineState', 'testBtn', 'testMsg', 'testSumMsg', 'engineNote', 'engineFetch', 'engineFetchSummary', 'engineFetchBar', 'engineFetchBtn', 'engineFetchPause', 'engineFetchSwitch', 'engineDirBtn', 'engineFetchCopy', 'engineFetchMsg', 'engineFetchList', 'engineFetchRows', 'engineAdv', 'localServerExe', 'pickExeBtn', 'localModelPath', 'pickModelBtn', 'localThreads', 'localPort', 'useVad', 'vadState', 'vadModelPath', 'pickVadBtn', 'suppressNst', 'sumServerExe', 'pickSumExeBtn', 'sumModelPath', 'pickSumModelBtn', 'sumThreads', 'sumPort', 'sumCtx', 'testSumBtn', 'segmentSec', 'engineIdleMin', 'saveMsg', 'openDataBtn'].join(',')}`,
      // 0.9.0 O-3 で足した: 録音バーの作り直しで、状態の文を真ん中の列からピルの直の子へ移した（D25）
      'src/renderer/overlay.html div.center: status']);
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

// ---------- 中継と直の送り先（第1d回 Task G-1。RL12・RF38・F6） ----------
// 鍵の見かけの文字は、このファイルにも書かない（実行のときに組み立てる）
const fakeKey = (head) => head + 'proj-' + 'A1b2C3d4'.repeat(3);
const fakeMailKey = () => 're' + '_' + 'Z9y8X7w6'.repeat(3);

test('RL12・RF38: src/（画面を除く）に OpenAI・Groq・Resend へ直に送る行を足すと BLOCK。画面・注釈・前からある行・消した行・src の外は通す', { timeout: 5000 }, () => {
  const R = require('../tools/risk');
  const bad = [
    ['src/main.js', "const u = 'https://api.openai.com/v1/audio/transcriptions';"],
    ['src/stt-cloud.js', "  { id: 'groq', base: 'https://api.groq.com/openai/v1' },"],
    ['src/relay.js', "const MAIL = 'https://api.resend.com/emails';"],
    ['src/new-part.js', 'const host = `api.openai.com`;'],
    // 逆引用符の中の ${…} のすぐ後ろの // は注釈ではない（注釈と見て宛先を落とさない）
    ['src/new-part.js', 'const u = `${scheme}//api.openai.com/v1`;'],
  ];
  for (const [file, line] of bad) {
    const got = R.relayFindings(file, '', `${line}\n`);
    assert.strictEqual(got.length, 1, `${file}: ${line}`);
    assert.match(got[0], /中継を通す/, got[0]);
  }
  assert.strictEqual(R.relayFindings('src/x.js', null, "fetchVia('https://api.openai.com/v1');\n").length, 1, '新しいファイルで鳴らない');
  assert.deepStrictEqual(R.relayFindings('src/renderer/app.html', '', '<p>api.openai.com</p>\n'), [], '画面まで止めた');
  assert.deepStrictEqual(R.relayFindings('src/main.js', '', '// api.openai.com へは直に送らない（中継を通す）\n'), [], '注釈の中で鳴った');
  assert.deepStrictEqual(R.relayFindings('test/x.test.js', '', "const u = 'https://api.openai.com/v1';\n"), [], 'テストまで止めた');
  assert.deepStrictEqual(R.relayFindings('relay/stt.mjs', '', "const OPENAI = 'https://api.openai.com/v1';\n"), [], '中継の本物の宛先まで止めた');
  const old = "const u = 'https://api.openai.com/v1';\n";
  assert.deepStrictEqual(R.relayFindings('src/x.js', old, `${old}const b = 2;\n`), [], '前からある行で鳴った');
  assert.deepStrictEqual(R.relayFindings('src/x.js', old, 'const b = 2;\n'), [], '消したら鳴った');
  assert.strictEqual(R.relayFindings('src/x.js', old, old + old).length, 1, '同じ行を2つにしたのに鳴らない');
  assert.deepStrictEqual(R.relayFindings('src/x.js', old, null), [], '消したファイルで鳴った');
});

test('RL12・RF38: 鍵の見かけの文字（sk-・re_ で始まる 20 字以上）を src/ の全部（画面も・注釈も）・relay/・出し方に足すと BLOCK', { timeout: 5000 }, () => {
  const R = require('../tools/risk');
  const sk = fakeKey('sk-'), re = fakeMailKey();
  const bad = [
    ['src/main.js', `const k = '${sk}';`],
    ['src/main.js', `// 試し: ${sk}`],
    ['src/renderer/app.html', `<input value="${sk}">`],
    ['src/renderer/app.html', `<!-- ${re} -->`],
    ['src/secrets.js', `const r = "${re}";`],
    ['src/main.js', `const k = 'sk-${'Ab12'.repeat(5)}';`],
    ['relay/config.mjs', `const KEY = '${sk}';`],
    ['tools/relay-deploy.js', `const RESEND = '${re}';`],
    ['.github/workflows/relay-deploy.yml', `      OPENAI_API_KEY: ${sk}`],
  ];
  for (const [file, line] of bad) {
    const got = R.relayFindings(file, '', `${line}\n`);
    assert.strictEqual(got.length, 1, `${file}: ${line}`);
    assert.match(got[0], /鍵の見かけ/, got[0]);
  }
  // 短いもの・ほかの語の途中・鍵の欄の名前・テストは通す
  const ok = [
    ['src/main.js', "const k = 'sk-ant-x';"],
    ['src/main.js', `const t = 'task-${'Ab12'.repeat(6)}';`],
    ['src/main.js', `const t = 'pre_${'Ab12'.repeat(6)}';`],
    ['src/main.js', "const n = 'OPENAI_API_KEY';"],
    ['src/renderer/app.html', '<div class="disk-usage-indicator-panel-wide"></div>'],
    ['test/x.test.js', `const k = '${sk}';`],
  ];
  for (const [file, line] of ok) assert.deepStrictEqual(R.relayFindings(file, '', `${line}\n`), [], `${file}: ${line}`);
  const old = `const k = '${sk}';\n`;
  assert.deepStrictEqual(R.relayFindings('src/x.js', old, `${old}const b = 2;\n`), [], '前からある行で鳴った');
});

test('RL12・RL1: relay/ で console を relay/log.mjs のほかで使う行・node: の読み込み・require(・Buffer を足すと BLOCK。log.mjs の console.log は通る', { timeout: 5000 }, () => {
  const R = require('../tools/risk');
  const bad = [
    ['relay/auth.mjs', "console.log('code', code);", /log\.mjs/],
    ['relay/stt.mjs', 'console.error(e);', /log\.mjs/],
    ['relay/http.mjs', "import { createHash } from 'node:crypto';", /Web の標準/],
    ['relay/http.mjs', 'import fs from "node:fs";', /Web の標準/],
    ['relay/http.mjs', "const m = await import('node:crypto');", /Web の標準/],
    ['relay/limits.mjs', "const crypto = require('crypto');", /Web の標準/],
    ['relay/mail.mjs', "const b64 = Buffer.from(s).toString('base64');", /Web の標準/],
  ];
  for (const [file, line, why] of bad) {
    const got = R.relayFindings(file, '', `${line}\n`);
    assert.ok(got.length >= 1, `${file}: ${line}`);
    assert.ok(got.some((g) => why.test(g)), got.join('\n'));
  }
  assert.deepStrictEqual(R.relayFindings('relay/log.mjs', '', '  console.log(JSON.stringify(out));\n'), [], 'log.mjs の console.log まで止めた');
  assert.deepStrictEqual(R.relayFindings('relay/auth.mjs', '', '// console.log は使わない（Buffer も node: も無し）\n'), [], '注釈の中で鳴った');
  assert.deepStrictEqual(R.relayFindings('relay/auth.mjs', '', "import { logEvent } from './log.mjs';\n"), []);
  assert.deepStrictEqual(R.relayFindings('src/main.js', '', "const { Buffer } = require('node:buffer'); console.log(1);\n"), [], 'src まで中継の決まりで止めた');
  assert.deepStrictEqual(R.relayFindings('tools/relay-deploy.js', '', "const fs = require('node:fs'); console.log('ok');\n"), [], '出す台本（Node で動く）まで止めた');
  const old = 'console.warn(x);\n';
  assert.deepStrictEqual(R.relayFindings('relay/stt.mjs', old, `${old}const b = 2;\n`), [], '前からある行で鳴った');
});

test('RL12・F6: relay/・tools/relay-deploy.js・relay-deploy.yml で ALLOWED_EMAIL_DOMAINS・MAIL_FROM に値を書く行を足すと BLOCK。名前を読む行は通る', { timeout: 5000 }, () => {
  const R = require('../tools/risk');
  const bad = [
    ['relay/config.mjs', "const env = { ALLOWED_EMAIL_DOMAINS: 'example.test' };"],
    ['relay/config.mjs', "e.x = 1; const MAIL_FROM = 'NaTsu <no-reply＠example.test>';"],
    ['relay/deploy-config.json', '  "ALLOWED_EMAIL_DOMAINS": "example.test",'],
    ['tools/relay-deploy.js', "  bindings.push({ type: 'plain_text', name: 'x', MAIL_FROM: process.env.MAIL_FROM });"],
    ['.github/workflows/relay-deploy.yml', '          ALLOWED_EMAIL_DOMAINS: ${{ secrets.ALLOWED_EMAIL_DOMAINS }}'],
    ['.github/workflows/relay-deploy.yml', '        run: MAIL_FROM=x node tools/relay-deploy.js'],
    ['relay/worker.mjs', "  env.MAIL_FROM = 'x';"],
    // 角かっこで書く形と、読めなかったときの既定の値（|| と ??）で会社のドメインを混ぜる形も止める
    ['relay/worker.mjs', "  env['MAIL_FROM'] = 'x';"],
    ['relay/config.mjs', '  env["ALLOWED_EMAIL_DOMAINS"]=x;'],
    ['relay/config.mjs', "  const domains = text(e.ALLOWED_EMAIL_DOMAINS || 'example.test');"],
    ['relay/config.mjs', '  const mailFrom = text(e.MAIL_FROM ?? `NaTsu <no-reply＠example.test>`);'],
    ['relay/config.mjs', "  const d = e['ALLOWED_EMAIL_DOMAINS'] ?? \"example.test\";"],
  ];
  for (const [file, line] of bad) {
    const got = R.relayFindings(file, '', `${line}\n`);
    assert.strictEqual(got.length, 1, `${file}: ${line}`);
    assert.match(got[0], /秘密の欄/, got[0]);
  }
  const ok = [
    ['relay/config.mjs', '  const domains = new Set(text(e.ALLOWED_EMAIL_DOMAINS).split(\',\'));'],
    ['relay/config.mjs', '  const mailFrom = text(env.MAIL_FROM);'],
    ['relay/config.mjs', '  if (env.MAIL_FROM === undefined) return null;'],
    ['tools/relay-deploy.js', "const SECRET_NAMES = { openai: 'OPENAI_API_KEY', mail: 'RESEND_API_KEY・MAIL_FROM', domains: 'ALLOWED_EMAIL_DOMAINS' };"],
    ['relay/config.mjs', '// ALLOWED_EMAIL_DOMAINS: Cloudflare の画面で入れる'],
    ['.github/workflows/relay-deploy.yml', '      # MAIL_FROM: 利用者が Cloudflare の画面で入れる'],
    ['relay/config.mjs', "const MAIL_FROM_NAME = 'NaTsu';"],
    ['relay/config.mjs', "const SMTP_MAIL_FROM = 'x';"],
    ['test/relay-auth.test.js', "const env = { ALLOWED_EMAIL_DOMAINS: 'example.test' };"],
    ['src/main.js', "const env = { MAIL_FROM: 'x' };"],
    ['relay/config.mjs', "  if (env['MAIL_FROM'] === undefined) return null;"],
    ['relay/config.mjs', "  const mailFrom = text(e.MAIL_FROM || '');"],
    ['relay/config.mjs', '  const mailFrom = text(e.MAIL_FROM ?? fallback);'],
  ];
  for (const [file, line] of ok) assert.deepStrictEqual(R.relayFindings(file, '', `${line}\n`), [], `${file}: ${line}`);
  const old = "const env = { MAIL_FROM: 'x' };\n";
  assert.deepStrictEqual(R.relayFindings('relay/config.mjs', old, `${old}const b = 2;\n`), [], '前からある行で鳴った');
});

// 第1d回 Task G-3（作り替え。RL12・D18・F17・F23）: チームの名前（<チーム>.cloudflareaccess.com）は Cloudflare の設定と Worker の秘密の欄
// （TEAM_DOMAIN）にだけ置き、アプリ・中継・出し方には書かない。Access の秘密の欄（TEAM_DOMAIN・POLICY_AUD・CF_ACCESS_CLIENT_ID・
// CF_ACCESS_CLIENT_SECRET）は名前を読むだけにし、値を書かない（ワークフローが同じ名前の GitHub の秘密を渡す行だけは通す）。
// テストの中の名前（natsu-test）は、テストの外の決まりを見るための見本
test('RL12・D18: src/・relay/・出し方にチームのドメインの字面（<名前>.cloudflareaccess.com）を書いた行を足すと BLOCK（注釈の中も・大文字も）。終わりの照らし・*.・<チーム>.・正規表現の形は通る', { timeout: 5000 }, () => {
  const R = require('../tools/risk');
  const bad = [
    ['src/relay.js', "const TEAM = 'natsu-test.cloudflareaccess.com';"],
    ['src/main.js', "  if (host === 'other-team.cloudflareaccess.com') return true;"],
    ['src/renderer/app.html', '<p>https://natsu-test.cloudflareaccess.com のログインの画面</p>'],
    ['relay/config.mjs', "const CERTS = 'https://natsu-test.cloudflareaccess.com/cdn-cgi/access/certs';"],
    ['relay/access.mjs', '// 試しに https://natsu-test.cloudflareaccess.com/cdn-cgi/access/certs で見た'],
    ['tools/relay-deploy.js', "const url = 'https://Natsu-Test.CloudflareAccess.com/cdn-cgi/access/certs';"],
    ['.github/workflows/relay-deploy.yml', '          TEAM: x1.cloudflareaccess.com'],
    ['relay/worker.mjs', "const t = 'a.b.cloudflareaccess.com';"],
    // 正規表現に \\. で書いた名前も字面（G-3 の点検）
    ['src/stt-cloud.js', 'const ACCESS_HOST = /^natsu-test\\.cloudflareaccess\\.com$/;'],
    ['relay/config.mjs', 'const TEAM_RE = /^https:\\/\\/Natsu-Test\\.cloudflareaccess\\.com$/i;'],
  ];
  for (const [file, line] of bad) {
    const got = R.relayFindings(file, '', `${line}\n`);
    assert.strictEqual(got.length, 1, `${file}: ${line} → ${got.join(' / ')}`);
    assert.match(got[0], /チームの名前/, got[0]);
  }
  const ok = [
    ['src/relay.js', "  return host.endsWith('.cloudflareaccess.com');"],
    ['src/stt-cloud.js', 'const ACCESS_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.cloudflareaccess\\.com$/;'],
    ['relay/config.mjs', 'const TEAM_RE = /^https:\\/\\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.cloudflareaccess\\.com$/;'],
    ['src/security.js', ' *  - 行き先は中継のホストか <チーム>.cloudflareaccess.com（チームの名前はアプリに書かない）'],
    ['relay/config.mjs', '// TEAM_DOMAIN（https://<チームの名前>.cloudflareaccess.com の形のときだけ）'],
    ['src/main.js', '// *.cloudflareaccess.com への転送は Access のログインの画面'],
    ['src/stt-cloud.js', '/** cloudflareaccess.com そのもの・後ろに続くホストは偽 */'],
    ['test/stage1d.ipc.test.js', "const team = 'https://natsu-test.cloudflareaccess.com';"],
    ['README.md', '`https://<チームの名前>.cloudflareaccess.com/cdn-cgi/access/certs`'],
  ];
  for (const [file, line] of ok) assert.deepStrictEqual(R.relayFindings(file, '', `${line}\n`), [], `${file}: ${line}`);
  const old = "const TEAM = 'natsu-test.cloudflareaccess.com';\n";
  assert.deepStrictEqual(R.relayFindings('src/relay.js', old, `${old}const b = 2;\n`), [], '前からある行で鳴った');
  assert.strictEqual(R.relayFindings('src/relay.js', old, old + old).length, 1, '同じ行を2つにしたのに鳴らない');
});

test('RL12・F23: src/・relay/・出し方で TEAM_DOMAIN・POLICY_AUD・CF_ACCESS_CLIENT_ID・CF_ACCESS_CLIENT_SECRET に値を書く行を足すと BLOCK。名前を読む行と、ワークフローが同じ名前の秘密を渡す行は通る', { timeout: 5000 }, () => {
  const R = require('../tools/risk');
  const bad = [
    ['relay/config.mjs', "const env = { TEAM_DOMAIN: 'https://x.example' };"],
    ['relay/config.mjs', "  const aud = text(e.POLICY_AUD || 'ab'.repeat(32));"],
    ['relay/worker.mjs', "  env['POLICY_AUD'] = x;"],
    ['relay/access.mjs', '  const team = e["TEAM_DOMAIN"] ?? `https://x.example`;'],
    ['tools/relay-deploy.js', "  const svcId = env.CF_ACCESS_CLIENT_ID ?? '0123abcd.access';"],
    ['tools/relay-deploy.js', "const CF_ACCESS_CLIENT_SECRET = 'x';"],
    ['src/relay.js', "const TEAM_DOMAIN = 'https://x.example';"],
    ['src/main.js', "  process.env.CF_ACCESS_CLIENT_ID = 'x';"],
    ['.github/workflows/relay-deploy.yml', '          TEAM_DOMAIN: ${{ secrets.TEAM_DOMAIN }}'],
    ['.github/workflows/relay-deploy.yml', '          POLICY_AUD: ${{ vars.POLICY_AUD }}'],
    ['.github/workflows/relay-deploy.yml', '          CF_ACCESS_CLIENT_ID: ${{ secrets.OTHER_ID }}'],
    ['.github/workflows/relay-deploy.yml', '          CF_ACCESS_CLIENT_SECRET: abc123'],
    ['.github/workflows/relay-deploy.yml', '        run: CF_ACCESS_CLIENT_SECRET=x node tools/relay-deploy.js'],
  ];
  for (const [file, line] of bad) {
    const got = R.relayFindings(file, '', `${line}\n`);
    assert.strictEqual(got.length, 1, `${file}: ${line} → ${got.join(' / ')}`);
    assert.match(got[0], /Access の秘密の欄/, got[0]);
  }
  const ok = [
    ['relay/config.mjs', "  const teamDomain = TEAM_RE.test(text(e.TEAM_DOMAIN)) ? text(e.TEAM_DOMAIN) : '';"],
    ['relay/config.mjs', "  const policyAud = AUD_RE.test(text(e.POLICY_AUD)) ? text(e.POLICY_AUD) : '';"],
    ['relay/config.mjs', '// TEAM_DOMAIN: Cloudflare の画面で入れる'],
    ['relay/config.mjs', 'const TEAM_DOMAIN_RE = /x/;'],
    ['tools/relay-deploy.js', "  const svcId = typeof env.CF_ACCESS_CLIENT_ID === 'string' ? env.CF_ACCESS_CLIENT_ID.trim() : '';"],
    ['tools/relay-deploy.js', '    if (j.ready.access !== true) say(`Cloudflare の画面で TEAM_DOMAIN と POLICY_AUD を入れてください`);'],
    ['tools/relay-deploy.js', "  const need = 'GitHub の Environments → relay に CF_ACCESS_CLIENT_ID と CF_ACCESS_CLIENT_SECRET を入れてください';"],
    ['.github/workflows/relay-deploy.yml', '          CF_ACCESS_CLIENT_ID: ${{ secrets.CF_ACCESS_CLIENT_ID }}'],
    ['.github/workflows/relay-deploy.yml', '          CF_ACCESS_CLIENT_SECRET: ${{ secrets.CF_ACCESS_CLIENT_SECRET }}'],
    ['.github/workflows/relay-deploy.yml', '# CF_ACCESS_CLIENT_ID・CF_ACCESS_CLIENT_SECRET は Access のサービストークン'],
    ['src/main.js', "const NOTE = 'POLICY_AUD は 64 字';"],
    ['test/relay-access.test.js', 'const env = { TEAM_DOMAIN: fa.teamDomain, POLICY_AUD: fa.aud };'],
  ];
  for (const [file, line] of ok) assert.deepStrictEqual(R.relayFindings(file, '', `${line}\n`), [], `${file}: ${line}`);
  const old = "const env = { POLICY_AUD: 'x' };\n";
  assert.deepStrictEqual(R.relayFindings('relay/config.mjs', old, `${old}const b = 2;\n`), [], '前からある行で鳴った');
});

test('RL12: analyze が中継と直の送り先の検査を呼んで BLOCK にし、射程とチェックリストに載る。今の src・relay・出し方には1件も無い', { timeout: 5000 }, () => {
  const R = require('../tools/risk');
  const src = read('tools/risk.js');
  const at = src.indexOf('function analyze(');
  const body = src.slice(at, src.indexOf('\n}\n', at));
  assert.match(body, /\.filter\(relayTarget\)/, 'analyze が変わったファイルを relayTarget で選んでいない');
  // 選ぶ元は、base と head の間で変わったファイルの全部（changed）。空の並びや一部に替えると、どの commit も止まらない
  assert.match(body, /\n  for \(const f of \[\.\.\.changed\]\.filter\(relayTarget\)\) \{\n/, 'analyze が変わったファイル（changed）の全部を中継の検査に渡していない');
  assert.match(body, /const changed = new Set\(\n\s*\(head === null \? git\(\['diff', '--name-only', base\]\)/, 'changed が base からの差分で作られていない');
  assert.match(body, /relayFindings\(f, at\(base, f\), at\(head, f\)\)/, 'analyze が relayFindings を呼んでいない');
  assert.match(body, /add\('BLOCK', '中継と直の送り先', f,/, '見つけても BLOCK にしていない');
  // 第1d回 G-3 で意図して変えた: チームのドメインの字面と Access の秘密の欄に値を書く行も見る
  const sees = '中継と直の送り先（src/ から OpenAI・Groq・Resend へ直に送る行・鍵の見かけの文字・relay/ の console と node: と Buffer・中継と出し方の中で秘密の欄に値を書く行・チームのドメインの字面・Access の秘密の欄に値を書く行）';
  assert.ok(R.SCOPE.sees.includes(sees), '射程に載っていない');
  assert.ok(R.scopeNote(new Set()).includes('中継と直の送り先'), '射程の但し書きに出ない');
  for (const f of ['src/main.js', 'src/relay.js', 'relay/log.mjs', 'tools/relay-deploy.js', '.github/workflows/relay-deploy.yml', 'relay/deploy-config.json']) assert.ok(R.relayTarget(f), f);
  for (const f of ['test/gate.test.js', 'tools/risk.js', 'docs/plans/natsu-design.md', '.github/workflows/ci.yml']) assert.ok(!R.relayTarget(f), f);
  const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]);
  const files = [...walk('src'), ...walk('relay'), 'tools/relay-deploy.js', '.github/workflows/relay-deploy.yml'];
  assert.ok(files.length > 30 && files.includes('relay/log.mjs') && files.includes('src/renderer/app.html'), '見たファイルが少ない（空振り）');
  for (const f of files) assert.deepStrictEqual(R.relayFindings(f, '', read(f)), [], f);
});

test('RL12・RF38: ゲートが、src/ に OpenAI と Groq の直の宛先を足した commit（第1c回 A-2）を、その commit で止める', { skip: !hasGit && 'git が無い', timeout: 5000 }, () => {
  // analyze を丸ごと回すと git を 200 回あまり呼び、Windows では 5 秒を越えうる。analyze と同じく、その commit で変わった
  // ファイルを relayTarget で選び、前と後の中身を relayFindings に渡す（git は数回。analyze の結線は上のテストが字面で見る）
  const R = require('../tools/risk');
  const git = (...a) => cp.execFileSync('git', a, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString();
  const h = git('log', '--reverse', '--format=%h', '-S', 'api.groq.com', '--', 'src/stt-cloud.js').trim().split('\n')[0];
  assert.ok(h, 'src/stt-cloud.js に api.groq.com を足した commit が見つからない');
  const show = (rev, f) => { try { return git('show', `${rev}:${f}`); } catch { return null; } };
  const files = git('diff', '--name-only', h + '^', h).split('\n').filter(Boolean).filter(R.relayTarget);
  assert.ok(files.includes('src/stt-cloud.js'), `${h} の変わったファイルに src/stt-cloud.js が無い: ${files.join(' ')}`);
  const got = files.flatMap((f) => R.relayFindings(f, show(h + '^', f), show(h, f)).map((line) => ({ f, line })));
  assert.ok(got.some((x) => x.f === 'src/stt-cloud.js' && x.line.includes('api.groq.com')), `${h} で Groq の宛先が止まらない: ${got.map((x) => x.line).join(' / ')}`);
  assert.ok(got.some((x) => x.f === 'src/stt-cloud.js' && x.line.includes('api.openai.com')), `${h} で OpenAI の宛先が止まらない`);
});
