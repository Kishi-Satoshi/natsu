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
