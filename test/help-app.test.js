/*
 * help-app.test.js — 0.9.2 I-1（ヘルプの計画 docs/plans/2026-10-20-help.md の H-12。0.9.2 の計画 docs/plans/2026-10-21-092.md の決めたこと 11・12）:
 * アプリからヘルプセンターを開く口。住所は main だけが持ち（HELP_URL）、画面は記事の名前だけを渡す。main は help/site.json と同じ
 * 決まった一覧（mainlib の HELP_ARTICLES）で照らし、一覧に無いもの・文字でないものはヘルプのホームを開く。画面から住所は渡させない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');
const lib = require('../src/mainlib');
const { RELAY_BASE } = require('../src/relay');
const { load } = require('./helpers/simrun.js');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const site = JSON.parse(read('help/site.json'));
const REFS = site.categories.flatMap((c) => c.articles.map((a) => `${c.id}/${a}`));
const mainSrc = read('src/main.js');
// 0.10.0 LN-1（D78・決めたこと 154）で意図して変えた: 住所の頭は src/natsulink.js の LINK_ORIGIN の1か所。main の HELP_URL はそこから作る
const { LINK_ORIGIN } = require('../src/natsulink');
const HELP_URL = /^const HELP_URL = `\$\{natsulink\.LINK_ORIGIN\}\/`;$/m.test(mainSrc) ? `${LINK_ORIGIN}/` : undefined;

test('I1: HELP_ARTICLES は help/site.json の分類の articles と同じ並び。helpPath は一覧の記事だけ「<記事>/」、ほかは \'\'', T, () => {
  assert.deepStrictEqual([...lib.HELP_ARTICLES], REFS, 'アプリの記事の一覧が help/site.json と違う（記事を足したら HELP_ARTICLES も直す）');
  assert.ok(Object.isFrozen(lib.HELP_ARTICLES), '一覧を書き換えられる');
  for (const r of REFS) assert.strictEqual(lib.helpPath(r), `${r}/`, r);
  for (const bad of [undefined, null, '', ' ', 'record', 'record/', 'record/pause/', ' record/pause', 'record/pause ', 'RECORD/PAUSE', 'record/pause#sleep',
    '../admin/seats', 'record/../admin/seats', 'https://example.invalid/', '//example.invalid', 'javascript:alert(1)', 'record\\pause', 7, {}, ['record/pause'],
    { toString: () => 'record/pause' }]) {
    assert.strictEqual(lib.helpPath(bad), '', `${JSON.stringify(bad)} に道を作った`);
  }
});

test('I1: HELP_URL は https で、ホストは natsu-help.<RELAY_BASE と同じサブドメイン>.workers.dev、道は /。住所は src/natsulink.js にだけある（LN-1 で意図して変えた）', T, () => {
  assert.ok(HELP_URL, 'src/main.js に const HELP_URL = `${natsulink.LINK_ORIGIN}/`; の行が無い');
  const u = new URL(HELP_URL);
  assert.strictEqual(u.protocol, 'https:');
  assert.strictEqual(u.pathname, '/');
  assert.ok(!u.search && !u.hash && !u.port && !u.username);
  const sub = new URL(RELAY_BASE).hostname.split('.')[1];
  assert.strictEqual(u.hostname, `natsu-help.${sub}.workers.dev`);
  assert.strictEqual(HELP_URL, `https://${u.hostname}/`);
  for (const f of ['src/renderer/app.html', 'src/preload.js', 'src/mainlib.js', 'src/renderer/overlay.html', 'src/main.js']) {
    assert.ok(!/natsu-help/i.test(read(f)), `${f} にヘルプのサイトの住所がある（住所は src/natsulink.js だけ）`);
  }
  // src/ の中で住所の字があるのは src/natsulink.js の LINK_ORIGIN の1行だけ
  const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]));
  const hits = walk('src').filter((f) => /\.(js|html|mjs)$/.test(f)).flatMap((f) => read(f).split('\n').map((l, i) => [f, i, l]).filter(([, , l]) => /natsu-help/i.test(l)).map(([g, i]) => `${g}:${i + 1}`));
  assert.strictEqual(hits.length, 1, hits.join(' '));
  assert.ok(hits[0].startsWith('src/natsulink.js:'), hits[0]);
});

// 場面 open-help（helpers/mainrun.js の --open-help）: 起動の後に app:open-help を引数の並びで順に呼び、shell.openExternal の住所を集める
const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const runMain = (args) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { maxBuffer: 1 << 24, timeout: 20000 }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});
const CALLS = [[], ['record/pause'], ['settings/offline'], ['https://example.invalid/'], ['../admin/seats'], ['record/pause#sleep'], ['RECORD/PAUSE'], [7], [{}], [null]];
test('I1（場面 open-help）: app:open-help は一覧の記事だけを開き、ほかはホームを開く。どの呼び出しも openExternal を1回だけ、答えは true', { timeout: sceneTimeout(20000) }, async () => {
  const o = await runMain(['text', `--open-help=${JSON.stringify(CALLS)}`]);
  assert.deepStrictEqual(o.openHelp, CALLS.map(() => true));
  assert.deepStrictEqual(o.external, [HELP_URL, `${HELP_URL}record/pause/`, `${HELP_URL}settings/offline/`, ...Array(7).fill(HELP_URL)]);
});

test('I2: preload の openHelp は app:open-help へ文字だけを渡す（文字でなければ \'\'）', T, () => {
  const pre = read('src/preload.js');
  assert.ok(pre.includes("  openHelp: (article) => ipcRenderer.invoke('app:open-help', typeof article === 'string' ? article : ''),"), 'preload の openHelp の形が違う');
  assert.ok(/ipcMain\.handle\('app:open-help', \(_e, article\) => \{/.test(mainSrc), 'main に app:open-help の受け口が無い');
  assert.ok(mainSrc.includes('shell.openExternal(`${HELP_URL}${lib.helpPath(article)}`)'), 'main が一覧で照らした道だけを開いていない');
});

// 本物の preload（openHelp がある）で、左の列の下の［ヘルプ］
test('I2: 左の列の下の［ヘルプ］は出ていて、押すと openHelp を引数なしで1回。ポップアップは開いたまま', T, async () => {
  const l = await load(APP, { preloadSrc: read('src/preload.js'), returns: { openHelp: () => true } });
  await l.drain();
  assert.ok(l.apis.koeApp.includes('openHelp'), '前提: preload に openHelp が無い');
  l.byId.get('tabBtnSettings').dispatchEvent({ type: 'click' }); await l.drain();
  const b = l.document.getElementById('setHelpLink');
  assert.strictEqual(b.hidden, false, '［ヘルプ］が出ていない（HELP_SITE_LIVE が偽か、口が無い）');
  assert.strictEqual(b.textContent.trim(), 'ヘルプ');
  assert.ok(b.closest('.setfoot'), '［ヘルプ］が左の列の下に無い');
  b.dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(l.called('openHelp').map((c) => c.args), [[]], 'openHelp を引数なしで1回呼んでいない');
  assert.strictEqual(l.document.getElementById('settingsModal').hidden, false, '［ヘルプ］でポップアップが閉じた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('I2: 画面は口の名前をそのまま書く（HELP_API の回り道が無い）。HELP_SITE_LIVE は真', T, () => {
  const html = read('src/renderer/app.html');
  assert.ok(!html.includes('HELP_API'), '口の名前を文字列で引く回り道が残っている');
  assert.ok(html.includes('window.koeApp.openHelp'), '画面が koeApp.openHelp を名前で書いていない');
  assert.strictEqual(html.split('const HELP_SITE_LIVE = true;').length, 2, 'HELP_SITE_LIVE = true の行がちょうど1つ無い');
});
