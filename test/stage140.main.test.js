/*
 * stage140.main.test.js — 0.14.0 の main の場面（計画 docs/plans/2026-10-26-140.md の Task EB-3〜）
 * 偽の Electron の上で main.js を本当に動かして確かめる（helpers/mainrun.js）。
 * EB-3（決めたこと 35・R24・F103）: 起きたときに Electron の既定のメニューを外す（Ctrl+W・Ctrl+Z・Ctrl+R を既定のメニューに横取りさせない）。
 * EB-5（決めたこと 20・33・SEC2）: 画面の行のリンクを開く口 app:open-link（開くのは https・http・mailto だけ・NaTsu のリンクはページを開く・
 *       ほかは開かずに記録に符号だけ。住所は書かない）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const run = (args, { env = {}, timeout = 30000 } = {}) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, ...env }, maxBuffer: 1 << 24, timeout }, (err, stdout, stderr) => {
    if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
    resolve(JSON.parse(stdout.trim().split('\n').pop()));
  });
});
const T = { timeout: sceneTimeout(30000) };

test('EB-3・F103（決めたこと 35・R24）: main は起きたときに、窓を作る前に既定のメニューを1回外す（Menu.setApplicationMenu(null)）', T, async () => {
  const r = await run(['text', '--json-scene=plain']);
  assert.ok(r.windows >= 2, '前提: 録音バーと本体の窓ができる');
  assert.deepStrictEqual(r.appMenu, [{ menu: null, wins: 0 }]);
});

// ---------------------------------------------------------------- EB-5（決めたこと 20・33・SEC2）
const NL = require('../src/natsulink');
test('EB-5・SEC2（決めたこと 20・33）: app:open-link は https・http・mailto だけ shell.openExternal、NaTsu のリンクはページを開く、javascript:・file: などは開かず記録に符号だけ（住所は書かない）', T, async () => {
  const CASES = [
    ['https://example.com/a?b=1', 'ext'], ['mailto:someone', 'ext'], ['HTTP://example.com/', 'ext'],
    ['natsu://page/pm1#b:x1', 'page'], [`${NL.LINK_ORIGIN}/open#p=pm2`, 'page'],
    ['javascript:alert(1)', 'no'], ['JaVaScRiPt:alert(1)', 'no'], ['file:///c:/windows/x', 'no'], ['data:text/html,x', 'no'], ['vbscript:x', 'no'],
    [' https://example.com/', 'no'], ['https://example.com/\u0000x', 'no'], ['natsu://page/p!1', 'no'], ['natsu://settings', 'no'], [`https://example.com/${'a'.repeat(2049)}`, 'no'], [5, 'no'], [null, 'no'],
  ];
  // 0.14.0 EB-5 直し（R209）で意図して変えた: app:open-link は本体の窓の画面から来たときだけ受けるので、本体の窓から送る（["ipc-from", 'main', …]）
  const r = await mic([['sleep', 100], ...CASES.map((c) => ['ipc-from', 'main', 'app:open-link', c[0]])]);
  assert.deepStrictEqual(r.ipc.map(([, v]) => v), CASES.map((c) => c[1] !== 'no'), '答え（開いたか）');
  assert.deepStrictEqual(r.external, CASES.filter((c) => c[1] === 'ext').map((c) => c[0]), 'shell.openExternal に渡した住所');
  assert.deepStrictEqual(r.mainSentAll.filter(([ch]) => ch === 'page:open-link').map(([, p]) => p), [{ id: 'pm1', anchor: 'b:x1' }, { id: 'pm2', anchor: '' }], 'NaTsu のリンクでページを開かない');
  const logs = r.engineLog.filter((x) => x.startsWith('リンク: 開かなかった'));
  assert.strictEqual(logs.length, CASES.filter((c) => c[1] === 'no').length, '開かなかったリンクの記録の数');
  for (const x of logs) assert.match(x, /^リンク: 開かなかった（[a-z]+）$/, '記録は符号だけ');
  for (const x of r.engineLog) assert.ok(!/example|javascript|alert|windows|vbscript|pm1|pm2|natsu:/i.test(x), `記録に住所: ${x}`);
});

// ---------------------------------------------------------------- EB-3 直し（R109）: stage140.win の小さなアプリを、偽の electron（Electron 44 と同じく Promise のクリップボード）で走らせる
// 本物の Electron は Windows の electron-smoke でだけ走るので、待ち方の誤り（Promise を文字として読む・書き戻しで止まる）をここで先に見る
const fs = require('node:fs');
const os = require('node:os');
const { MAIN, PAGE } = require('./helpers/keysapp');
function fakeElectron({ hangRead = false, hangMark = false } = {}) {
  const st = { clip: 'もとの文', html: '', focused: '', values: { t1: '', t2: '' }, selected: false, menu: undefined, paths: {}, exit: null, writes: [], box: { copied: 0, pasteKeys: 0 } };
  const clipboard = {
    readText: () => (hangRead ? new Promise(() => {}) : Promise.resolve(st.clip)),
    writeText: (v) => { if (typeof v !== 'string') throw new TypeError('writeText: 文字でない'); st.writes.push(v); st.clip = v; st.html = ''; return Promise.resolve(); },
    // EK-4 直し（R153）: Electron 44 の read()（ClipboardItem の並び。getType は Blob）
    read: () => Promise.resolve(st.html ? [{ types: ['text/plain', 'text/html'], getType: (t) => Promise.resolve({ text: () => Promise.resolve(t === 'text/html' ? st.html : st.clip) }) }] : []),
  };
  const wc = {
    on() {}, focus() {}, debugger: { attach() { throw new Error('無い'); } },
    sendInputEvent(e) {
      const f = st.focused;
      if (e.type === 'char') st.values[f] += e.keyCode;
      else if (e.type === 'keyDown' && e.modifiers.includes('control') && f === 'box') {
        // 箱の受け口（PAGE の script）と同じ: Ctrl+C・Ctrl+X は copy の事象で文字と HTML を書き、Ctrl+V は数えるだけ
        if (e.keyCode === 'C' || e.keyCode === 'X') { st.clip = '選んだ行'; st.html = '<p>選んだ行</p>'; st.box.copied += 1; }
        if (e.keyCode === 'V') st.box.pasteKeys += 1;
      } else if (e.type === 'keyDown' && e.modifiers.includes('control')) {
        if (e.keyCode === 'Z') st.values[f] = '';
        if (e.keyCode === 'C' && st.selected) st.clip = st.values[f];
        if (e.keyCode === 'V') st.values[f] += st.clip;
      }
    },
    executeJavaScript(s) {
      if (s.includes("t.value = 'xyz'")) { st.values.t1 = 'xyz'; st.focused = 't1'; st.selected = true; return Promise.resolve(1); }
      if (s.includes("getElementById('box').focus()")) { st.focused = 'box'; st.selected = false; return Promise.resolve(1); }
      if (s.includes('window.__natsuBox')) return Promise.resolve(JSON.stringify(st.box));
      const m = /getElementById\('(t[12])'\)\.(focus|value)/.exec(s);
      if (m && m[2] === 'focus') { st.focused = m[1]; st.selected = false; return Promise.resolve(1); }
      if (m) return Promise.resolve(st.values[m[1]]);
      if (s.includes('__natsuMark')) return hangMark ? new Promise(() => {}) : Promise.resolve(1);
      return Promise.resolve(undefined);
    },
  };
  function BrowserWindow() { this.webContents = wc; }
  BrowserWindow.prototype.on = () => {};
  BrowserWindow.prototype.isDestroyed = () => false;
  BrowserWindow.prototype.loadFile = () => Promise.resolve();
  BrowserWindow.prototype.show = () => {};
  BrowserWindow.prototype.focus = () => {};
  const app = { setPath: (k, v) => { st.paths[k] = v; }, on: () => {}, whenReady: () => Promise.resolve(), exit: (c) => { st.exit = c; } };
  const Menu = { setApplicationMenu: (m) => { st.menu = m; }, getApplicationMenu: () => st.menu };
  return { st, electron: { app, BrowserWindow, Menu, clipboard } };
}
// MAIN を偽の electron で走らせる（待つ時間は縮め、40 秒の見張りだけ 300ms に）。終わる（app.exit）か 3 秒で答える
async function runKeys(main, opt) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-keys-議事録𠮷-'));
  const { st, electron } = fakeElectron(opt);
  const timers = new Set();
  const fastTimeout = (fn, ms) => { const h = setTimeout(() => { timers.delete(h); fn(); }, ms >= 40000 ? 300 : 0); timers.add(h); return h; };
  const fastClear = (h) => { timers.delete(h); clearTimeout(h); };
  const req = (n) => (n === 'electron' ? electron : require(n));
  const outFile = path.join(dir, 'out.json');
  const proc = { env: { NATSU_KEYS_OUT: outFile, NATSU_MAINLIB: path.join(__dirname, '..', 'src', 'mainlib.js') } };
  const errs = [];
  const onRej = (e) => { errs.push(String(e && e.message || e)); };
  process.on('unhandledRejection', onRej);
  try {
    new Function('require', 'process', '__dirname', 'setTimeout', 'clearTimeout', main)(req, proc, dir, fastTimeout, fastClear);   // eslint-disable-line no-new-func
    for (let i = 0; i < 300 && st.exit === null; i++) await new Promise((r) => setTimeout(r, 10));
    const out = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : null;
    return { st, out, errs, dir };
  } finally {
    process.off('unhandledRejection', onRej);
    for (const h of timers) clearTimeout(h);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
test('EB-3 直し・R109: stage140.win の小さなアプリは Electron 44 の Promise のクリップボードを待って最後まで走り、元のクリップボードを書き戻し、userData を一時フォルダに置く', { timeout: 10000 }, async () => {
  const r = await runKeys(MAIN);
  assert.deepStrictEqual(r.out, { menu: true, typed: 'abc', undone: '', copied: 'xyz', pasted: 'xyz', boxCopied: '選んだ行', boxHtml: true, boxCut: '選んだ行', boxCopies: 2, boxPasteKeys: 1, reloaded: false, mark: 1, closed: false });   // EK-5 で closed を、EK-4 直し（R153）で box… を足した
  assert.strictEqual(r.st.exit, 0);
  assert.strictEqual(r.st.clip, 'もとの文', '元のクリップボードを書き戻さない');
  assert.strictEqual(r.st.paths.userData, path.join(r.dir, 'userData'), 'userData が一時フォルダに無い');
  assert.deepStrictEqual(r.errs, []);
  assert.ok(PAGE.includes('id="t1"') && PAGE.includes('id="t2"') && PAGE.includes('__natsuMark = 1'));
  assert.ok(PAGE.includes('<div id="box" tabindex="-1"><div id="ed" contenteditable="true">') && PAGE.includes('document.execCommand("copy")'), 'EK-4 直し: 箱が文の欄でない・execCommand で写していない');
});
test('EB-4 直し・R115: 小さなアプリがクリップボードを使った後に止まっても、40 秒の見張りで終える前に元のクリップボードを書き戻す', { timeout: 10000 }, async () => {
  const r = await runKeys(MAIN, { hangMark: true });
  assert.strictEqual(r.out && r.out.error, 'timeout: reload');
  assert.strictEqual(r.st.exit, 2);
  assert.deepStrictEqual(r.st.writes, ['', '', '', 'もとの文'], '空にしてから Ctrl+C で替わり（EK-4 直し: 箱の写す・切り取るの前にも空にする）、見張りで元に書き戻す');
  assert.strictEqual(r.st.clip, 'もとの文', '止まって終えるときに元のクリップボードを書き戻さない');
});
test('EB-3 直し・R109: 小さなアプリが止まったときは、待っていた段の名前を書く（timeout: <段>）', { timeout: 10000 }, async () => {
  const r = await runKeys(MAIN, { hangRead: true });
  assert.strictEqual(r.out && r.out.error, 'timeout: clipboard-read');
  assert.strictEqual(r.st.exit, 2);
});

// ---------------------------------------------------------------- MB-3（BQ11・F106・決めたこと 61・64・65・録音の守り）: 録音中と録音の前のメモの行と下書き
// 録音中と録音の前のメモの行（memoDoc）は main のメモリと draft.json に持つ（DB の命令は送らない）。照らしに外れる行は受けずに前のまま。
// 締めと復旧は下書きの行を DB の meetingPage が照らして持つ（外れれば memo だけ）。前の版の下書き（memo だけ）は今と同じ
const MD = require('../src/memoDoc');
const MT = require('../src/memoTypes');
const sceneRun = (args, timeout = 30000) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const mic = (steps, ...flags) => sceneRun(['text', `--mic-feed=${JSON.stringify(steps)}`, ...flags]);
const ipcOf = (o, ch) => o.ipc.filter(([c]) => c === ch).map(([, r]) => r);
const MB_DOC = [
  { id: 'm1', type: 'heading', level: 3, text: '目的' },
  { id: 'm2', type: 'paragraph', text: '予算を決める', rich: [{ t: '予算', m: ['b'] }, { t: 'を決める' }] },
  { id: 'm3', type: 'bullet', text: '見積の確認', children: [{ id: 'm4', type: 'todo', text: '比較表', checked: true }] },
];
const MB_VALID = MD.validateMemoDoc(MB_DOC);
const MB_PLAIN = MD.memoPlain(MB_VALID);
const MB_BAD = [{ id: 'm1', type: 'paragraph', text: '壊れた行の文', cites: [1] }];   // 出典の欄はメモの行に無い（R69）
const MB_BAD2 = [{ id: 'x1', type: 'paragraph', text: '頭の違う行の文' }];          // 行の ID は m で始まる（R151）
const MB_REFUSED = 'メモ: 行の形が合わないので受けなかった（bad-args）。前のメモのまま';
const noMemoText = (log) => !log.some((l) => /目的|予算|見積|比較表|壊れた行|頭の違う行/.test(l));

test('MB-3・F106: 前提（場面の行の形）: 照らした行は citeState を持ち、素の文字は見出しが「■ 」・太字は文字だけ・子は2つの空白。外れる行は bad-args', () => {
  assert.strictEqual(MB_PLAIN, '■ 目的\n予算を決める\n- 見積の確認\n  - [x] 比較表\n');
  assert.ok(MB_VALID.every((b) => b.citeState === 'manual'));
  for (const bad of [MB_BAD, MB_BAD2]) assert.throws(() => MD.validateMemoDoc(bad), (e) => e.code === 'bad-args');
});

test('MB-3・F106: 録音中に meeting:set-memo に行（doc）→ draft.json に memoDoc と memo（memoPlain）・meeting:status も同じ・DB の命令は0。締めのページは memoDoc と memo。DB を止めても書ける', T, async () => {
  const o = await mic([['start'], ['snap', 's'], ['ipc', 'meeting:set-memo', MB_DOC], ['snap', 'a'], ['stop'], ['wait-pages', 1]]);
  assert.deepStrictEqual(ipcOf(o, 'meeting:set-memo'), [true]);
  assert.deepStrictEqual(o.snaps.a.draft, { memo: MB_PLAIN, meetingType: null, memoDoc: MB_VALID });
  assert.deepStrictEqual(o.snaps.a.liveMemo, { memo: MB_PLAIN, memoDoc: MB_VALID }, 'meeting:status が行を返さない（画面を読み直すと行の形が消える）');
  assert.deepStrictEqual(o.snaps.a.dbSent.slice(o.snaps.s.dbSent.length).filter((c) => /^page\./.test(c)), [], '録音中のメモの直しを DB に送った');
  assert.deepStrictEqual(o.pageMemos.map((p) => [p.memo, p.memoDoc]), [[MB_PLAIN, MB_VALID]]);
  assert.ok(noMemoText(o.engineLog), o.engineLog.join('\n'));
  const d = await mic([['start'], ['ipc', 'meeting:set-memo', MB_DOC], ['snap', 'a']], '--db-down');
  assert.deepStrictEqual(ipcOf(d, 'meeting:set-memo'), [true]);
  assert.strictEqual(d.snaps.a.active, true, 'DB が止まっていて録音が止まった');
  assert.deepStrictEqual(d.snaps.a.draft, { memo: MB_PLAIN, meetingType: null, memoDoc: MB_VALID }, 'DB が止まっていると下書きに行が残らない');
});

test('MB-3・F106（決めたこと 65）: 照らしに外れる doc は受けず前のまま（答えは false）・録音は続く・記録に符号だけ（文を書かない）。録音の前のページでも同じ。文字のメモが来たら行の形は持たない（R164）', T, async () => {
  const o = await mic([['start'], ['ipc', 'meeting:set-memo', MB_DOC], ['ipc', 'meeting:set-memo', MB_BAD], ['ipc', 'meeting:set-memo', MB_BAD2], ['snap', 'b'],
    ['ipc', 'meeting:set-memo', 'あとで文字だけ'], ['snap', 'c'], ['stop'], ['wait-pages', 1]]);
  assert.deepStrictEqual(ipcOf(o, 'meeting:set-memo'), [true, false, false, true]);
  assert.strictEqual(o.snaps.b.active, true, '録音が止まった');
  assert.deepStrictEqual(o.snaps.b.draft, { memo: MB_PLAIN, meetingType: null, memoDoc: MB_VALID }, '外れる行で前のメモを捨てた');
  assert.deepStrictEqual(o.snaps.b.liveMemo, { memo: MB_PLAIN, memoDoc: MB_VALID });
  assert.deepStrictEqual(o.snaps.c.draft, { memo: 'あとで文字だけ', meetingType: null }, '文字のメモの後に古い行の形が下書きに残った');
  assert.deepStrictEqual(o.pageMemos.map((p) => [p.memo, p.memoDoc]), [['あとで文字だけ', undefined]]);
  assert.strictEqual(o.engineLog.filter((l) => l === MB_REFUSED).length, 2, o.engineLog.join('\n'));
  assert.ok(noMemoText(o.engineLog), o.engineLog.join('\n'));
  const p = await mic([['ipc', 'meeting:prepare'], ['ipc', 'meeting:set-memo', MB_DOC], ['ipc', 'meeting:set-memo', MB_BAD], ['snap', 'p']]);
  assert.deepStrictEqual(ipcOf(p, 'meeting:set-memo'), [true, false]);
  assert.deepStrictEqual(p.snaps.p.status.prep, { memo: MB_PLAIN, memoDoc: MB_VALID, meetingType: null });
  assert.ok(noMemoText(p.engineLog), p.engineLog.join('\n'));
});

test('MB-3（第4版）: 録音の前のページの doc は meeting:status が返し（画面を読み直すと行の形のまま）、録音を始めると会議に移る（最初の下書き・最初の meeting:update・締めのページ）。下書きは始めるまで書かない', T, async () => {
  const o = await mic([['ipc', 'meeting:prepare'], ['ipc', 'meeting:set-memo', MB_DOC], ['snap', 'p'], ['ipc', 'meeting:start'], ['snap', 'm'], ['stop'], ['wait-pages', 1], ['ipc', 'meeting:prepare'], ['snap', 'n']]);
  assert.deepStrictEqual(o.snaps.p.status.prep, { memo: MB_PLAIN, memoDoc: MB_VALID, meetingType: null }, 'meeting:status が録音の前の行を返さない');
  assert.deepStrictEqual(o.snaps.p.drafts, []);
  assert.deepStrictEqual(o.snaps.m.draft, { memo: MB_PLAIN, meetingType: null, memoDoc: MB_VALID }, '録音の前の行が会議に移らない');
  assert.deepStrictEqual(o.snaps.m.liveMemo, { memo: MB_PLAIN, memoDoc: MB_VALID });
  const u = (o.mainSentAll.find(([ch, x]) => ch === 'meeting:update' && x && x.active) || [])[1];
  assert.deepStrictEqual([u.memo, u.memoDoc], [MB_PLAIN, MB_VALID], '最初の meeting:update に行が無い');
  assert.deepStrictEqual(o.pageMemos.map((p) => [p.memo, p.memoDoc]), [[MB_PLAIN, MB_VALID]]);
  assert.deepStrictEqual(o.snaps.n.status.prep, { memo: '', meetingType: null }, '次の録音の前のページに前の行が残った');
});

test('MB-3（決めたこと 64）: meeting:set-type の雛形は memo と memoDoc（手を付けていないときだけ。録音の前のページと会議の両方）。人の文の行なら行はそのまま', T, async () => {
  const SALES = MT.memoPreset(MT.memoTypeOf('sales'));
  const STANDUP = MT.memoPreset(MT.memoTypeOf('standup'));
  const o = await mic([['ipc', 'meeting:prepare'], ['ipc', 'meeting:set-type', 'sales'], ['snap', 'a'], ['ipc', 'meeting:set-memo', MB_DOC], ['ipc', 'meeting:set-type', 'standup'], ['snap', 'b'],
    ['ipc', 'meeting:start'], ['ipc', 'meeting:set-memo', MD.memoFromText('')], ['ipc', 'meeting:set-type', 'standup'], ['snap', 'c'], ['stop'], ['wait-pages', 1]]);
  const r = ipcOf(o, 'meeting:set-type');
  assert.deepStrictEqual(r[0], { ok: true, memo: SALES, memoDoc: MD.memoFromText(SALES), inserted: true, meetingType: 'sales' });
  assert.deepStrictEqual(o.snaps.a.status.prep, { memo: SALES, memoDoc: MD.memoFromText(SALES), meetingType: 'sales' });
  assert.deepStrictEqual(r[1], { ok: true, memo: MB_PLAIN, memoDoc: MB_VALID, inserted: false, meetingType: 'standup' }, '人の文の行を雛形に替えた');
  assert.deepStrictEqual(r[2], { ok: true, memo: STANDUP, memoDoc: MD.memoFromText(STANDUP), inserted: true, meetingType: 'standup' });
  assert.deepStrictEqual(o.snaps.c.draft, { memo: STANDUP, meetingType: 'standup', memoDoc: MD.memoFromText(STANDUP) });
  assert.deepStrictEqual(o.pageMemos.map((p) => [p.memo, p.memoDoc]), [[STANDUP, MD.memoFromText(STANDUP)]]);
});

test('MB-3・F106: 締めの後の要約の入力は今と同じ memo の文（偽の claude の標準入力。見出しは「■ 」・太字の記号は出ない）', { timeout: sceneTimeout(30000) }, async () => {
  const o = await sceneRun(['text', '--sum', '--claude=ok', '--segs=2', '--claude-stdin', `--live-memo-doc=${JSON.stringify(MB_DOC)}`]);
  assert.strictEqual(o.liveMemoDoc, true);
  assert.deepStrictEqual([o.pages[0].memo, o.pages[0].memoDoc], [MB_PLAIN, MB_VALID]);
  const p = o.claude.filter((l) => l.kind === 'p');
  assert.strictEqual(p.length, 1);
  assert.ok(p[0].stdinText.startsWith(`【会議メモ・アジェンダ（要約のヒント）】\n${MT.fenceLines(MB_PLAIN.trim())}\n\n【会議の文字起こし】\n`), p[0].stdinText.slice(0, 300));
  const memoPart = p[0].stdinText.slice(0, p[0].stdinText.indexOf('【会議の文字起こし】'));
  assert.ok(memoPart.includes('■ 目的') && memoPart.includes('予算を決める') && !memoPart.includes('**') && !memoPart.includes('## '), `要約の入力のメモに行の飾りの記号が出た: ${memoPart}`);
});

test('MB-3・F106: 録音中に行を直してから main ごと落ちても、下書きから戻したページは memoDoc のまま（memo は memoPlain）', { timeout: sceneTimeout(60000) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-メモの行𠮷-'));
  try {
    const crashed = await new Promise((resolve) => {
      execScene(process.execPath, [RUN, 'text', '--segs=3', `--live-memo-doc=${JSON.stringify(MB_DOC)}`, '--kill-main-during', `--keep-user-data=${dir}`],
        { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 30000 }, (err) => resolve(err));
    });
    assert.ok(crashed && crashed.code !== 0, '場面の前提: main ごと落ちていない');
    const o = await sceneRun(['text', '--recover', `--keep-user-data=${dir}`]);
    assert.strictEqual(o.pages.length, 1);
    assert.deepStrictEqual([o.pages[0].recovered, o.pages[0].memo, o.pages[0].memoDoc], [true, MB_PLAIN, MB_VALID]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MB-3・F106（決めたこと 65・R158・R164）: 前の版の下書き（memo だけ）から戻すと memo だけのページ（今と同じ）。下書きの memoDoc が照らしに外れる（手で壊した）と memo だけのページで、下書きの写しを消さずに残す', { timeout: sceneTimeout(30000) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-前の下書き𠮷-'));
  try {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { recursive: true });
    const at = Date.now() - 600000;
    const seg = (id, text) => [{ id, atMs: 0, durationMs: 3000, text }];
    fs.writeFileSync(path.join(data, 'draft.json'), JSON.stringify({ pageId: 'pmbold1', startedAt: at, memo: '前の版のメモ\n- 素の文字', offsetMs: 3000, savedAt: at + 3000, segments: seg('s1', '前の版の会議です') }));
    const bad = JSON.stringify({ pageId: 'pmbbad1', startedAt: at + 1000, memo: '素の文字のメモ', memoDoc: MB_BAD, offsetMs: 3000, savedAt: at + 4000, segments: seg('s1', '壊れた行の会議です') });
    fs.writeFileSync(path.join(data, `draft-${at + 1000}.json`), bad);
    const o = await sceneRun(['text', '--idle', `--keep-user-data=${dir}`]);
    const byId = new Map(o.pages.map((p) => [p.id, p]));
    assert.deepStrictEqual([...byId.keys()].sort(), ['pmbbad1', 'pmbold1'], JSON.stringify(o.engineLog));
    assert.deepStrictEqual([byId.get('pmbold1').memo, byId.get('pmbold1').memoDoc, byId.get('pmbold1').recovered], ['前の版のメモ\n- 素の文字', undefined, true]);
    assert.deepStrictEqual([byId.get('pmbbad1').memo, byId.get('pmbbad1').memoDoc, byId.get('pmbbad1').recovered], ['素の文字のメモ', undefined, true], '壊れた行の形でページを作った');
    assert.deepStrictEqual(o.dataFiles.filter((n) => /^draft/.test(n) && n.endsWith('.json')), [], '戻した下書きが残った');
    const kept = o.dataFiles.filter((n) => n.startsWith(`draft-${at + 1000}.json.broken-`));
    assert.strictEqual(kept.length, 1, `壊れた行の下書きの写しが無い: ${o.dataFiles.join(',')}`);
    assert.strictEqual(fs.readFileSync(path.join(data, kept[0]), 'utf8'), bad, '写しが元の下書きと違う');
    assert.ok(!o.dataFiles.some((n) => n.startsWith('draft.json.broken-')), '前の版の下書きの写しを作った');
    assert.ok(o.engineLog.includes(`下書き（draft-${at + 1000}.json）のメモの行は形が合わないので、行の無いメモで戻します（bad-args。下書きの写しを残しました）`), o.engineLog.join('\n'));
    assert.ok(noMemoText(o.engineLog) && !o.engineLog.some((l) => /前の版のメモ|素の文字|会議です/.test(l)), o.engineLog.join('\n'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MB-3（R165）: main の締め（meeting.finalize）と復旧（meeting.recover）の頼みは fitLiveMemoDoc（mainlib.fitMemoDoc）を通り、要約の書き戻し（saveIfExists）はメモを送らない', () => {
  const m = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.strictEqual((m.match(/await db\.call\('meeting\.(finalize|recover)', fitLiveMemoDoc\(\{/g) || []).length, 2);
  assert.strictEqual((m.match(/db\.call\('meeting\.(finalize|recover)',/g) || []).length, 2, '締めか復旧の頼みがほかにもある');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'src', 'mainlib.js'), 'utf8');
  const s = lib.slice(lib.indexOf('async function saveIfExists('), lib.indexOf('\n}\n', lib.indexOf('async function saveIfExists(')));
  assert.ok(s.indexOf('delete saved.memo; delete saved.memoDoc;') > s.indexOf('apply(saved);') && s.indexOf('delete saved.memo;') < s.indexOf("db.call('page.put'"), '書き戻しがメモを送る');
});

// ---------------------------------------------------------------- MB-3 直し（2026-11-02 の点検の I1・I2・小さな頼み。R178〜R181）
// 大きなメモの行の下書き（2,000 行・1 行 45 字の日本語の太字と色。memoDoc は JSON で約 0.8MB・memoPlain は 10 万字の内で、memo と合わせると 1MB を越える）
const bigMemoDoc = () => MD.validateMemoDoc(Array.from({ length: 2000 }, (_, i) => ({ id: `m${(i + 1).toString(36)}`, type: 'bullet', text: '', rich: [{ t: '大事な議題の確認と次の打ち手の相談'.repeat(2), m: ['b'] }, { t: '・期限を決める予定です', m: [['color', 'blue']] }] })));
const freshStore = () => {
  const p = require.resolve('../src/store');
  const saved = require.cache[p];
  delete require.cache[p];
  const s = require('../src/store');
  delete require.cache[p];
  if (saved) require.cache[p] = saved;
  return s;
};

test('MB-3 直し（I1・R178）: 下書きは字下げの無い JSON で書き、メモの行は変わらない間は前に作った文字を使う（区間のたびの fsync の書き込みが大きなメモの行で重くならない）', { timeout: 30000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-下書きの大きさ𠮷-'));
  try {
    const S = freshStore();
    S.initDrafts(dir);
    const doc = bigMemoDoc();
    assert.ok(MD.memoPlain(doc).length <= 100000, '種の前提: memoPlain が 10 万字の内');
    let serialized = 0;
    Object.defineProperty(doc, 'toJSON', { value() { serialized += 1; return Array.from(this); }, enumerable: false });
    const plainDoc = Array.from(doc);
    const draft = (n) => ({ pageId: 'pbig1', startedAt: 1760000000000, memo: MD.memoPlain(doc), memoDoc: doc, segments: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, atMs: i * 15000, durationMs: 15000, text: `発言の${i + 1}` })), offsetMs: n * 15000, savedAt: 1760000000000 + n });
    const file = path.join(dir, 'data', 'draft.json');
    const t0 = process.hrtime.bigint();
    for (let n = 1; n <= 10; n++) S.writeDraft(draft(n), 'draft.json', { fsync: true });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.strictEqual(serialized, 1, `メモの行を書き込みのたびに文字にした（${serialized} 回）`);
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(!text.includes('\n'), '下書きが字下げのある JSON（大きくなる）');
    const back = JSON.parse(text);
    assert.deepStrictEqual(back, { ...draft(10), memoDoc: plainDoc }, '詰めて書いた下書きが元と違う');
    const pretty = Buffer.byteLength(JSON.stringify({ ...draft(10), memoDoc: plainDoc }, null, 2));
    assert.ok(Buffer.byteLength(text) < pretty * 0.8, `詰めて書いても小さくならない（${Buffer.byteLength(text)} / ${pretty}）`);
    assert.ok(ms < 8000, `大きなメモの行の下書きの 10 回の書き込み（fsync つき）が遅すぎる: ${ms.toFixed(0)}ms`);   // 広い上限（CI の遅い機械でも）。いまの手元は 1 回 10ms ほど
    // 行が替われば（新しい物）文字にし直す
    const doc2 = MD.validateMemoDoc([{ id: 'm1', type: 'paragraph', text: '替えた行' }]);
    S.writeDraft({ ...draft(11), memo: MD.memoPlain(doc2), memoDoc: doc2 }, 'draft.json', { fsync: true });
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).memoDoc, doc2);
    // 行の無い下書き（前の版と同じ形）も詰めて書く
    S.writeDraft({ startedAt: 1, memo: 'a', segments: [] }, 'draft.json', { fsync: true });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"startedAt":1,"memo":"a","segments":[]}');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MB-3 直し（I2・R179・小さな頼み 3）: 照らしに合うメモの行でも、復旧の頼みが 1MB を越えて行を外すときは、下書きの写し（.broken-）を残してから memo だけのページにする（場面: main の fitLiveMemoDoc）', { timeout: sceneTimeout(60000) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-大きなメモの復旧𠮷-'));
  try {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { recursive: true });
    const doc = bigMemoDoc();
    const at = Date.now() - 600000;
    const raw = JSON.stringify({ pageId: 'pmbbig1', startedAt: at, memo: MD.memoPlain(doc), memoDoc: doc, offsetMs: 3000, savedAt: at + 3000, segments: [{ id: 's1', atMs: 0, durationMs: 3000, text: '大きなメモの会議です' }] });
    assert.ok(Buffer.byteLength(raw) > 1024 * 1024, '種の前提: 復旧の頼みが 1MB を越える');
    fs.writeFileSync(path.join(data, 'draft.json'), raw);
    const o = await sceneRun(['text', '--idle', `--keep-user-data=${dir}`], 60000);
    assert.strictEqual(o.pages.length, 1, JSON.stringify(o.engineLog));
    assert.deepStrictEqual([o.pages[0].id, o.pages[0].memo, o.pages[0].memoDoc, o.pages[0].recovered], ['pmbbig1', MD.memoPlain(doc), undefined, true]);
    const kept = o.dataFiles.filter((n) => n.startsWith('draft.json.broken-'));
    assert.strictEqual(kept.length, 1, `外したメモの行の下書きの写しが無い: ${o.dataFiles.join(',')}`);
    assert.strictEqual(fs.readFileSync(path.join(data, kept[0]), 'utf8'), raw, '写しが元の下書きと違う');
    assert.ok(!o.dataFiles.includes('draft.json'), '写しを残したのに下書きが残った');
    assert.ok(o.engineLog.includes('メモ: 議事録の頼みが大きすぎるので、メモの行を外して素の文字のメモで保存します（下書きの写しを残しました）'), o.engineLog.join('\n'));
    assert.ok(!o.engineLog.some((l) => /大事な議題|会議です/.test(l)), '記録にメモか発言の文を書いた');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('MB-3 直し（小さな頼み 1・R181）: 照らしに合わないメモの行の下書きの写しを作れない（copy が EACCES）なら、ページは memo だけで作り、下書きは消さずに残す', T, async () => {
  const o = await run(['text', '--json-scene=mb-copy-fail']);
  assert.deepStrictEqual(o.page, { id: 'pmbcopy1', memo: '素の文字のメモ', memoDoc: null });
  assert.deepStrictEqual(o.drafts, ['draft.json'], '写しを残せなかったのに下書きを消した');
  assert.ok(!o.dataFiles.some((n) => n.includes('.broken-')), o.dataFiles.join(','));
  assert.ok(o.log.includes('下書き（draft.json）のメモの行は形が合わないので、行の無いメモで戻します（bad-args。写しを残せませんでした: EACCES。下書きを残します）'), o.log.join('\n'));
});

test('MB-3 直し（小さな頼み 3）: 締めた後の要約の書き戻し（main の saveIfExists → page.put）は、メモの行と素の文字のメモを保存してあるままにする（場面）', { timeout: sceneTimeout(30000) }, async () => {
  const o = await sceneRun(['text', '--sum', '--claude=ok', '--segs=2', `--live-memo-doc=${JSON.stringify(MB_DOC)}`]);
  assert.ok(o.pages[0].blocks && o.pages[0].blocks.length > 0, '場面の前提: 要約を書き戻した');
  assert.deepStrictEqual([o.pages[0].memo, o.pages[0].memoDoc], [MB_PLAIN, MB_VALID], '要約の書き戻しでメモの行が消えた・変わった');
});

test('MB-4 直し・M5（守り。R190）: 照らしに合わないメモの行で復旧の頼みも 1MB を越える下書きでも、写し（.broken-）は1つ（2回目の写しは jsonfile.quarantine が同じ中身の写しを使い回す）', { timeout: sceneTimeout(60000) }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-壊れた大きなメモ𠮷-'));
  try {
    const data = path.join(dir, 'data');
    fs.mkdirSync(data, { recursive: true });
    const good = bigMemoDoc();
    const doc = good.map((x, i) => (i === 0 ? { ...x, cites: [1] } : x));   // 出典の欄はメモの行に無い（R69）: 照らしに合わない
    const memo = MD.memoPlain(good);
    const at = Date.now() - 600000;
    const raw = JSON.stringify({ pageId: 'pmbbad1', startedAt: at, memo, memoDoc: doc, offsetMs: 3000, savedAt: at + 3000, segments: [{ id: 's1', atMs: 0, durationMs: 3000, text: '壊れたメモの会議です' }] });
    assert.ok(Buffer.byteLength(raw) > 1024 * 1024, '種の前提: 復旧の頼みが 1MB を越える');
    fs.writeFileSync(path.join(data, 'draft.json'), raw);
    const o = await sceneRun(['text', '--idle', `--keep-user-data=${dir}`], 60000);
    assert.strictEqual(o.pages.length, 1, JSON.stringify(o.engineLog));
    assert.deepStrictEqual([o.pages[0].id, o.pages[0].memo === memo, o.pages[0].memoDoc], ['pmbbad1', true, undefined]);
    const kept = o.dataFiles.filter((n) => n.startsWith('draft.json.broken-'));
    assert.strictEqual(kept.length, 1, `写しが1つでない: ${o.dataFiles.join(',')}`);
    assert.ok(!o.dataFiles.includes('draft.json'), '写しを残したのに下書きが残った');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- DQ-3（決めたこと 45）: 会議の区間の文は整えの口に送らない
// 0.15.1 ND-2（計画 docs/plans/2026-11-04-151.md の「意図して変えるテスト」・D114）: 口述の整え（EK-6・DQ-3・DQ-4 の音声入力の場面）は音声入力と一緒に消した。
// 会議の区間の文を整えない守り（前の版の変異 dq-meeting）は会議の場面として残す。偽の整えの口（--tidy）の答えは作った文
const AI_REPLY = { text: '明日の会議は、資料を見てから決めます。区間1', lines: [] };
test('DQ-3・F105（決めたこと 45）: 会議の区間の文は整えの口に送らない（会議を1つ録って偽の中継の整えの口の要求が0）', { timeout: sceneTimeout(60000) }, async () => {
  const o = await sceneRun(['text', '--relay=text', `--tidy=${JSON.stringify(AI_REPLY)}`]);
  assert.ok(o.relayCalls.filter((x) => x === '/v1/audio/transcriptions').length >= 1, `前提: 区間を中継へ送っていない ${JSON.stringify(o.relayCalls)}`);
  assert.strictEqual(o.tidy.requests.length, 0, JSON.stringify(o.tidy));
});

// ---------------------------------------------------------------- EB-5 直し（2026-11-03 の版の点検 M-1。R209）
test('EB-5 直し・M-1（R209）: app:open-link は本体の窓の画面から来たときだけ開く（録音バーの窓・送り手の無い頼みからは false で、shell.openExternal もページを開く知らせも0）', T, async () => {
  const o = await mic([['sleep', 100], ['ipc-from', 'overlay', 'app:open-link', 'https://example.com/a'], ['ipc-from', 'overlay', 'app:open-link', 'natsu://page/pm1'],
    ['ipc', 'app:open-link', 'https://example.com/b'], ['ipc-from', 'main', 'app:open-link', 'https://example.com/c']]);
  assert.deepStrictEqual(o.ipc, [['app:open-link', false], ['app:open-link', false], ['app:open-link', false], ['app:open-link', true]], `ほかの窓からリンクを開いた: ${JSON.stringify(o.ipc)}`);
  assert.deepStrictEqual(o.external, ['https://example.com/c'], 'ほかの窓から来た住所を shell.openExternal に渡した');
  assert.deepStrictEqual(o.mainSentAll.filter(([ch]) => ch === 'page:open-link'), [], 'ほかの窓から来た NaTsu のリンクでページを開いた');
});

// ---------------------------------------------------------------- MB-2 直し2（2026-11-03 の版の点検 M-4。R210）
test('MB-2 直し2・M-4（R210）: meeting:set-type は、素の文字が雛形のままでも、メモの行に飾り（rich）か色（color）のある行があれば雛形で置き換えない（録音の前のページと会議の両方）', T, async () => {
  const SALES = MT.memoPreset(MT.memoTypeOf('sales'));
  const STANDUP = MT.memoPreset(MT.memoTypeOf('standup'));
  const boldDoc = (memo) => { const d = MD.memoFromText(memo); d[0] = { ...d[0], rich: [{ t: d[0].text, m: ['b'] }] }; return MD.validateMemoDoc(d); };
  const redDoc = (memo) => { const d = MD.memoFromText(memo); d[1] = { ...d[1], color: 'red' }; return MD.validateMemoDoc(d); };
  const o = await mic([['ipc', 'meeting:prepare'], ['ipc', 'meeting:set-type', 'sales'], ['ipc', 'meeting:set-memo', boldDoc(SALES)], ['ipc', 'meeting:set-type', 'standup'],
    ['ipc', 'meeting:start'], ['ipc', 'meeting:set-memo', redDoc(SALES)], ['ipc', 'meeting:set-type', 'standup'], ['ipc', 'meeting:set-memo', MD.memoFromText(SALES)], ['ipc', 'meeting:set-type', 'standup'],
    ['stop'], ['wait-pages', 1]]);
  const r = ipcOf(o, 'meeting:set-type');
  assert.deepStrictEqual(r[1], { ok: true, memo: SALES, memoDoc: boldDoc(SALES), inserted: false, meetingType: 'standup' }, '太字にした雛形の見出しを雛形で置き換えた（録音の前のページ）');
  assert.deepStrictEqual(r[2], { ok: true, memo: SALES, memoDoc: redDoc(SALES), inserted: false, meetingType: 'standup' }, '色を付けた雛形の行を雛形で置き換えた（会議）');
  assert.deepStrictEqual(r[3], { ok: true, memo: STANDUP, memoDoc: MD.memoFromText(STANDUP), inserted: true, meetingType: 'standup' }, '飾りの無い雛形の行が新しい雛形にならない');
});
