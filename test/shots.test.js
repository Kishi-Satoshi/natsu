/*
 * shots.test.js — 画面を撮って比べる道具（第1a回 G2・PERF）の決め方
 * 本物の Electron で撮るのは Windows の CI（electron-smoke）だけ。ここでは画面の並び・偽の橋の名前・比べ方・揺れ・CSP・速さ・CI の段を見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const SH = require('../tools/shots/screens');
const P = require('../tools/png');
const { preloadApis } = require('./helpers/simrun');
const { jobsOf, stepsOf } = require('./helpers/yml');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const img = (w, h, fill = [255, 255, 255, 255]) => ({ width: w, height: h, data: Buffer.from(Array.from({ length: w * h }, () => fill).flat()) });
// 一時フォルダ（日本語と 𠮷 の名前。RF1 と同じ形）。テストの終わりに消す
const tmp = (t, name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `natsu-画面𠮷-${name}-`));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

// 第1b回 Task C-1 で意図して変えた: 撮る画面は 7 から 13 へ（タブ・畳んだサイドバー・記録中のページの明暗・200% の2つ）
test('G2: 撮る画面は決まった並び（第1b回の 13）で、名前は重ならない', { timeout: 5000 }, () => {
  assert.deepStrictEqual(SH.SCREENS.map((s) => s.name), ['notes-empty-light', 'notes-page-light', 'notes-page-dark', 'dictation-light', 'settings-light', 'settings-dark', 'overlay-processing',
    'notes-tabs-light', 'notes-collapsed-light', 'live-light', 'live-dark', 'notes-page-zoom200-light', 'settings-zoom200-dark']);
  for (const s of SH.SCREENS) assert.ok(['app', 'overlay'].includes(s.page) && ['light', 'dark'].includes(s.theme), s.name);
  assert.deepStrictEqual(SH.SCREENS.filter((s) => s.zoom).map((s) => [s.name, s.zoom]), [['notes-page-zoom200-light', 2], ['settings-zoom200-dark', 2]]);
  const live = SH.SCREENS.find((s) => s.name === 'live-light');
  const st = live.answers['koeApp.meetingStatus'];
  assert.ok(st.active && st.cloud && st.pauses.length === 1, '記録中の画面に一時停止の印か［PC の中だけ］が出ない');
});

test('F14: 取り直し待ち（RETAKE）の画面は違っても NG にしないが、録音バーは入れられず、揺れ・CSP・はみ出しは NG のまま', { timeout: 5000 }, () => {
  assert.ok(!SH.RETAKE.has('overlay-processing'), '録音バーの基準まで取り直そうとしている（overlay.html は変えない）');
  for (const n of SH.RETAKE) assert.ok(SH.SCREENS.some((s) => s.name === n), `${n} は撮る画面に無い`);
  const cmp = [{ name: 'notes-page-light', status: 'diff', count: 9 }, { name: 'overlay-processing', status: 'same' }];
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake: new Set(['notes-page-light']) }), 0);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: [{ name: 'overlay-processing', status: 'diff', count: 1 }], retake: new Set(['notes-page-light']) }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake: new Set(['notes-page-light']), overflow: [{ name: 'notes-page-light', ok: false }] }), 1);
  // 揺れ・CSP の違反・撮れなかった画面・速さの NG は、取り直し待ちの画面でも NG（足した: 計画の目的の「RETAKE でも NG」の残り）
  const retake = new Set(['notes-page-light']);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, flaky: ['notes-page-light'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, csp: ['app: Refused to execute inline script'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, errors: ['notes-page-light: 撮れなかった'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, perf: [{ name: 'open-2000-blocks', ms: 600, ok: false }] }), 1);
  // Tab の輪の NG は、取り直し待ちでない画面では NG（取り直し待ちの間は骨組みが変わる途中なので参考に出すだけ）
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake, focus: [{ name: 'notes-page-light', ok: false }] }), 0);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp, retake: new Set(), focus: [{ name: 'notes-page-light', ok: false }] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['a'], compare: cmp.map((c) => ({ ...c, status: 'same' })), focus: [{ name: 'notes-page-light', ok: true }], overflow: [{ name: 'notes-page-light', ok: true }] }), 0);
});

test('F11: 横のはみ出しの判定（scrollWidth が clientWidth を越える・右端が窓の外の要素がある）', { timeout: 5000 }, () => {
  assert.deepStrictEqual(SH.judgeOverflow({ sw: 560, cw: 560, offenders: [] }).ok, true);
  assert.deepStrictEqual(SH.judgeOverflow({ sw: 600, cw: 560, offenders: [] }).ok, false);
  assert.deepStrictEqual(SH.judgeOverflow({ sw: 560, cw: 560, offenders: ['button#pMore'] }).ok, false);
  assert.match(SH.OVERFLOW_PROBE, /scrollWidth/);
  assert.strictEqual(SH.judgeOverflow(null).ok, false, '計れなかったのを OK にした');
});

test('F11: はみ出しを集める文（OVERFLOW_PROBE）を偽の画面で走らせる — 窓の外へ出た要素だけを集め、祖先で切られた・隠れた要素は数えない', { timeout: 5000 }, () => {
  const vm = require('node:vm');
  const el = (tag, id, cls, rect, style = {}, parent = null) => ({ tagName: tag.toUpperCase(), id, className: cls, rect, style, parentElement: parent, getBoundingClientRect: () => rect });
  const body = el('body', '', '', { left: 0, right: 560, width: 560, height: 700 }, { overflowX: 'visible' });
  const scroller = el('div', 'tabbar', 'tabs', { left: 0, right: 560, width: 560, height: 30 }, { overflowX: 'auto' }, body);
  const inScroll = el('button', '', 'tab', { left: 500, right: 700, width: 200, height: 30 }, {}, scroller);   // 横に流れる帯の中（切られる）
  const out = el('button', 'pMore', '', { left: 520, right: 620, width: 100, height: 30 }, {}, body);       // 窓の外へ出た
  const hidden = el('div', 'x', '', { left: 0, right: 900, width: 900, height: 10 }, { visibility: 'hidden' }, body);
  const empty = el('span', '', '', { left: 0, right: 0, width: 0, height: 0 }, {}, body);
  const doc = { documentElement: { scrollWidth: 600, clientWidth: 560 }, body, querySelectorAll: () => [scroller, inScroll, out, hidden, empty] };
  const win = { innerWidth: 560, getComputedStyle: (e) => ({ overflowX: 'visible', visibility: 'visible', display: 'block', position: 'static', ...e.style }) };
  const r = vm.runInNewContext(SH.OVERFLOW_PROBE, { document: doc, window: win, getComputedStyle: win.getComputedStyle });
  assert.deepStrictEqual([r.sw, r.cw, Array.from(r.offenders)], [600, 560, ['button#pMore']]);
  assert.strictEqual(SH.judgeOverflow(r).ok, false);
});

test('F12: Tab の輪の判定（決めた id にフォーカスがあり、outline が none でない）', { timeout: 5000 }, () => {
  const s = SH.SCREENS.find((x) => x.focus);
  assert.deepStrictEqual([s.name, s.focus.tabs, s.focus.want], ['notes-page-light', 2, 'mtToggleBtn']);
  assert.deepStrictEqual(SH.SCREENS.filter((x) => x.focus).map((x) => x.name), ['notes-page-light']);
  assert.strictEqual(SH.judgeFocus({ id: 'mtToggleBtn', outline: 'solid' }, s.focus).ok, true);
  assert.strictEqual(SH.judgeFocus({ id: 'mtToggleBtn', outline: 'none' }, s.focus).ok, false);
  assert.strictEqual(SH.judgeFocus({ id: '', outline: 'none' }, s.focus).ok, false);
  assert.strictEqual(SH.judgeFocus({ id: 'tabBtnDictation', outline: 'solid' }, s.focus).ok, false);
  assert.strictEqual(SH.judgeFocus(null, s.focus).ok, false);
});

test('F11: 拡大の画面は、撮る前に窓の中の幅が「窓の幅 ÷ 倍率」になっている（画面の外で描く窓で拡大が効いたか）', { timeout: 5000 }, () => {
  assert.strictEqual(SH.judgeZoom(560, 2).ok, true);
  assert.strictEqual(SH.judgeZoom(1120, 2).ok, false);
  assert.strictEqual(SH.judgeZoom(1120, 1).ok, true);
  assert.strictEqual(SH.judgeZoom(undefined, 2).ok, false);
});

test('G2: 画面ごとの答えの名前も、本物の preload.js にあるものだけ', { timeout: 5000 }, () => {
  const names = SH.apiNamesOf(read('src/preload.js'));
  for (const s of SH.SCREENS) for (const key of Object.keys(s.answers || {})) {
    const [bridge, fn] = key.split('.');
    assert.ok(names[bridge] && names[bridge].includes(fn), `${s.name}: ${key}`);
  }
});

test('G2・F14: 録音バーの基準の PNG は第1a回のまま（取り直していない。git の履歴に頼らず中身で固定）', { timeout: 5000 }, () => {
  const buf = fs.readFileSync(path.join(ROOT, 'test', 'shots', 'win32', 'overlay-processing.png'));
  assert.strictEqual(require('node:crypto').createHash('sha256').update(buf).digest('hex'), 'd206317193b0f9460af62948ddbad5d904a6311154eb222dceb4ddf5a2f8fd02');
});

test('F14: 取り直し待ちが残っている間は、版を上げられない（取り直し待ちのまま 0.6.0 を出さない）', { timeout: 5000 }, () => {
  if (SH.RETAKE.size) assert.strictEqual(JSON.parse(read('package.json')).version, '0.5.0', `取り直し待ち ${[...SH.RETAKE].join(',')} を残したまま版を上げた`);
});

test('tools/shots/main.js は画面ごとの答え・拡大・はみ出し・Tab を使う', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  for (const s of ['s.answers', 'setZoomFactor(', 'SH.OVERFLOW_PROBE', 'sendInputEvent(', 'SH.RETAKE']) assert.ok(m.includes(s), s);
});

test('G2: 偽の橋の名前は、本物の preload.js から取ったものと同じ（simrun と同じ結果）。見本の答えは、その名前のものだけ', { timeout: 5000 }, () => {
  const src = read('src/preload.js');
  assert.deepStrictEqual(SH.apiNamesOf(src), preloadApis(src));
  const names = SH.apiNamesOf(src);
  for (const key of Object.keys(SH.fixtures())) {
    const [bridge, fn] = key.split('.');
    assert.ok(names[bridge] && names[bridge].includes(fn), key);
  }
  const fx = JSON.stringify(SH.fixtures());
  assert.ok(!/\d{4}-\d\d-\d\d/.test(fx) || /2026-10-01/.test(fx), '見本の日付は決まった過去の日にする');
});

test('G2・F9: 比べる — 基準が無い・大きさが違う・1画素違う・同じ、を分け、違えば前・後・差分の PNG を書く', { timeout: 5000 }, (t) => {
  const base = tmp(t, 'base');
  const out = tmp(t, 'out');
  const same = img(4, 3);
  const one = img(4, 3);
  one.data[0] = 0;   // 左上の1画素の赤だけ違う
  fs.writeFileSync(path.join(base, 'b.png'), P.encodePng(same));
  fs.writeFileSync(path.join(base, 'c.png'), P.encodePng(same));
  fs.writeFileSync(path.join(base, 'd.png'), P.encodePng(img(5, 3)));
  const r = SH.compareAll({ baseDir: base, outDir: out, shots: { a: same, b: one, c: same, d: same }, png: P, fs });
  assert.deepStrictEqual(r.map((x) => [x.name, x.status]), [['a', 'missing'], ['b', 'diff'], ['c', 'same'], ['d', 'size']]);
  assert.strictEqual(r[1].count, 1);
  for (const f of ['a.after.png', 'b.before.png', 'b.after.png', 'b.diff.png', 'd.before.png', 'd.after.png', 'd.diff.png']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.ok(!fs.existsSync(path.join(out, 'c.after.png')), '同じ画面の画像まで書いた');
  assert.strictEqual(SH.exitCodeOf({ compare: r }), 1);
  assert.strictEqual(SH.exitCodeOf({ compare: r.filter((x) => x.status === 'same') }), 0);
});

test('F9: 同じ画面を2回撮って違えば「揺れる」で NG。揺れ・CSP の違反・速さの NG があれば終了コードは 1', { timeout: 5000 }, () => {
  const a = img(2, 2);
  const b = img(2, 2);
  b.data[5] = 9;
  assert.deepStrictEqual(SH.judgePair(a, img(2, 2), P).ok, true);
  assert.deepStrictEqual(SH.judgePair(a, b, P).ok, false);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], flaky: ['x'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], csp: ['Refused to execute inline script'] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], perf: [{ name: 'open-2000-blocks', ms: 600, ok: false }] }), 1);
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'] }), 0);
  assert.strictEqual(SH.exitCodeOf({ shots: [] }), 1, '1枚も撮れていないのに 0');
  // 撮れなかった画面（errors）があれば、残りが撮れていても・残りが基準と全部同じでも 1（「比べる物が無いのに緑」にしない）
  assert.strictEqual(SH.exitCodeOf({ shots: ['x'], errors: ['y: 撮れなかった'] }), 1, '撮れなかった画面を見ていない');
  assert.strictEqual(SH.exitCodeOf({ compare: [{ name: 'a', status: 'same' }], errors: ['b: 比べる画像が無い'] }), 1, '比べられなかった画面を見ていない');
});

test('F6: CSP に断られた行を見分ける（自分のインラインの script が止まると画面が真っ白になる）', { timeout: 5000 }, () => {
  assert.strictEqual(SH.cspViolation(3, "Refused to execute inline script because it violates the following Content Security Policy directive: \"script-src 'sha256-x'\"."), true);
  assert.strictEqual(SH.cspViolation(2, 'Electron Security Warning (Insecure Content-Security-Policy)'), false);
  assert.strictEqual(SH.cspViolation(3, 'Uncaught TypeError: x'), false);
  // Electron 44.9.0（Chromium 152）が実際に出す形（作業環境の xvfb で、差し込んだ script を止めたときの行）。「Refused to」で始まらない
  assert.strictEqual(SH.cspViolation('error', "Executing inline script violates the following Content Security Policy directive 'script-src 'sha256-x''. Either the 'unsafe-inline' keyword, a hash ('sha256-y'), or a nonce ('nonce-...') is required to enable inline execution. The action has been blocked."), true);
});

test('F9: 撮る画面は時計・時間帯・アニメーションを止めて撮る（基準を取った次の日に「N日超過」が変わって赤にならない）', { timeout: 5000 }, () => {
  assert.strictEqual(new Date(SH.FIXED_NOW).toISOString(), '2026-10-18T00:00:00.000Z');
  assert.strictEqual(SH.TIME_ZONE, 'Asia/Tokyo');
  assert.match(SH.FREEZE_CSS, /transition:none!important/);
  assert.match(SH.FREEZE_CSS, /animation:none!important/);
  const pre = read('tools/shots/preload.js');
  assert.ok(pre.includes('contextBridge.executeInMainWorld(') && pre.includes('static now()'), '画面の時計を止めていない');
  const m = read('tools/shots/main.js');
  assert.ok(m.includes("'Emulation.setTimezoneOverride'") && m.includes('insertCSS('), '時間帯かアニメーションを止めていない');
  const fx = JSON.stringify(SH.fixtures());
  for (const d of fx.match(/\d{4}-\d\d-\d\d/g) || []) assert.ok(d < '2026-10-18', `見本の日付 ${d} が止めた時計より後`);
});

// preload.js の executeInMainWorld に渡す func の矢印関数を、func: から括弧を数えて取り出す（見本の文字列に括弧は無い）
function preloadFuncSource() {
  const pre = read('tools/shots/preload.js');
  const start = pre.indexOf('func:');
  assert.ok(start >= 0, 'preload.js に func: が無い');
  const from = pre.indexOf('(', start);
  const open = pre.indexOf('{', pre.indexOf('=>', from));
  let depth = 0;
  for (let i = open; i < pre.length; i++) {
    if (pre[i] === '{') depth++;
    else if (pre[i] === '}' && --depth === 0) return pre.slice(from, i + 1);
  }
  throw new Error('func: の括弧が閉じていない');
}

test('F9: preload の時計の止め方を本当に走らせる — 画面の Date が FIXED_NOW を返し、日付を渡した Date は変えない。機器の名前は見本', { timeout: 5000 }, async () => {
  const vm = require('node:vm');
  const md = { enumerateDevices: () => Promise.resolve([{ kind: 'audioinput', label: '本物のマイク' }]), getUserMedia: () => Promise.reject(new Error('本物')) };
  const w = { navigator: { mediaDevices: md } };
  vm.runInNewContext(`(${preloadFuncSource()})`, { window: w, navigator: w.navigator })(SH.FIXED_NOW);
  assert.strictEqual(typeof w.Date, 'function', '止めた Date を画面の世界に入れていない');
  assert.strictEqual(new w.Date().getTime(), SH.FIXED_NOW);
  assert.strictEqual(w.Date.now(), SH.FIXED_NOW);
  assert.strictEqual(new w.Date('2026-10-01T00:00:00.000Z').toISOString(), '2026-10-01T00:00:00.000Z');
  const list = await md.enumerateDevices();
  assert.deepStrictEqual(Array.from(list, (d) => d.label), [  // 画面の世界の配列なので、こちらの配列に写して比べる
    '既定 - マイク（見本）', 'マイク（見本）', '既定 - スピーカー（見本）']);
  assert.strictEqual((await md.getUserMedia({ audio: true })).getTracks().length, 0);
});

test('F9: 基準との比べは色の差 2 までを同じとみなす（CI の機械ごとの1段の差）。3 以上は違いとして数える。揺れの確かめは差を許さない', { timeout: 5000 }, (t) => {
  const base = tmp(t, 'tol');
  const out = tmp(t, 'tolout');
  fs.writeFileSync(path.join(base, 'a.png'), P.encodePng(img(2, 2)));
  fs.writeFileSync(path.join(base, 'b.png'), P.encodePng(img(2, 2)));
  const near = img(2, 2); near.data[0] = 253;
  const far = img(2, 2); far.data[0] = 252;
  const r = SH.compareAll({ baseDir: base, outDir: out, shots: { a: near, b: far }, png: P, fs });
  assert.deepStrictEqual(r.map((x) => [x.name, x.status]), [['a', 'same'], ['b', 'diff']]);
  assert.strictEqual(SH.TOLERANCE, 2);
  assert.strictEqual(SH.judgePair(img(2, 2), near, P).ok, false, '揺れの確かめが差を許した');
});

test('PERF: 2,000 ブロックのページと 1万行の文字起こしを開くのは 0.5 秒まで（3回の中央値）', { timeout: 5000 }, () => {
  assert.deepStrictEqual(SH.PERF, [{ name: 'open-2000-blocks', budgetMs: 500 }]);
  assert.strictEqual(SH.median([900, 410, 420]), 420);
  assert.deepStrictEqual(SH.judgePerf([{ name: 'open-2000-blocks', ms: 420 }]).map((x) => x.ok), [true]);
  assert.deepStrictEqual(SH.judgePerf([{ name: 'open-2000-blocks', ms: 501 }]).map((x) => x.ok), [false]);
  const big = SH.bigPage();
  assert.strictEqual(big.page.blocks.length, 2000);
  assert.strictEqual(big.segments.length, 10000);
});

test('ci.yml の electron-smoke: 小さなアプリの後に画面を撮り、撮った画像をいつも artifact に上げる', { timeout: 5000 }, () => {
  const st = stepsOf(jobsOf(read('.github/workflows/ci.yml'))['electron-smoke']);
  const iSmoke = st.findIndex((s) => /electron\.exe tools\/electron-smoke$/m.test(s));
  const iShots = st.findIndex((s) => /node_modules\/electron\/dist\/electron\.exe tools\/shots (--compare test\/shots\/win32 )?--out "\$RUNNER_TEMP\/shots"/.test(s));
  const iUp = st.findIndex((s) => /uses: actions\/upload-artifact@v4/.test(s));
  assert.ok(iSmoke >= 0 && iShots > iSmoke && iUp > iShots, `${iSmoke},${iShots},${iUp}`);
  assert.match(st[iUp], /^\s*if: always\(\)$/m);
  assert.match(st[iUp], /path: \$\{\{ runner\.temp \}\}\/shots/);
});

test('tools/shots/main.js は electron を boot() の中だけで読む（npm test が require しても本体を落としにいかない。第0c回 C6）', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  assert.ok(m.includes("if (process.versions.electron && process.type === 'browser') boot();"));
  assert.ok(!/^const .*require\('electron'\)/m.test(m));
  assert.ok(m.includes("require('../../src/security')") && m.includes('security.install('));
  assert.ok(m.includes("require('../png')") && !m.includes('toBitmap('), 'PNG は自作の部品で読む（toBitmap の並びは版ごとに変わる）');
});

test('G2: 作業域より大きい窓が作るときに縮められても（Windows の CI の画面は 1024x768）、撮る前に決めた大きさへ戻す', { timeout: 5000 }, () => {
  const fake = (w, h) => {
    const calls = [];
    return { calls, getContentSize: () => [w, h], setContentSize: (...a) => { calls.push(a); } };
  };
  const shrunk = fake(1024, 720);
  assert.strictEqual(SH.ensureContentSize(shrunk, SH.SIZE), true);
  assert.deepStrictEqual(shrunk.calls, [[SH.SIZE.width, SH.SIZE.height]]);
  const right = fake(SH.OVERLAY_SIZE.width, SH.OVERLAY_SIZE.height);
  assert.strictEqual(SH.ensureContentSize(right, SH.OVERLAY_SIZE), false);
  assert.deepStrictEqual(right.calls, []);
  // main は窓を作った直後（ページを開く前）に呼ぶ
  const m = read('tools/shots/main.js');
  const made = m.indexOf('new BrowserWindow(');
  const fix = m.indexOf('SH.ensureContentSize(win, size)');
  assert.ok(made >= 0 && fix > made && fix < m.indexOf("wc.loadURL('about:blank')"), '窓を作った直後に大きさを決め直していない');
});

// 第1b回 Task C-1 で意図して緩めた: 基準が無いのは、取り直し待ち（RETAKE）の第1b回の新しい画面だけ。C-2 で元の「全部ある」に戻す
const NEW_1B = ['notes-tabs-light', 'notes-collapsed-light', 'live-light', 'live-dark', 'notes-page-zoom200-light', 'settings-zoom200-dark'];
test('G2・F9: どの画面にも基準の PNG があり（取り直し待ちの新しい画面だけは無くてよい）、自作の部品で読めて、大きさが窓の大きさと同じ', { timeout: 5000 }, () => {
  for (const s of SH.SCREENS) {
    const f = path.join(ROOT, 'test', 'shots', 'win32', `${s.name}.png`);
    if (!fs.existsSync(f) && NEW_1B.includes(s.name) && SH.RETAKE.has(s.name)) continue;
    assert.ok(fs.existsSync(f), `${s.name} の基準が無い`);
    const im = P.decodePng(fs.readFileSync(f));
    const want = s.page === 'overlay' ? SH.OVERLAY_SIZE : SH.SIZE;
    assert.deepStrictEqual([im.width, im.height], [want.width, want.height], s.name);
  }
});

test('ci.yml の electron-smoke: 撮った画面を基準（test/shots/win32）と比べる', { timeout: 5000 }, () => {
  const st = stepsOf(jobsOf(read('.github/workflows/ci.yml'))['electron-smoke']);
  assert.ok(st.some((s) => s.includes('electron.exe tools/shots --compare test/shots/win32 --out "$RUNNER_TEMP/shots"')));
});

test('F9: 最初の画面を1度開いて撮って捨ててから（慣らし）本番を撮る（Windows の CI で、最初に開いた窓だけ縁の画素が実行ごとに2通りに描かれた）', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  const warm = m.indexOf('const warm = await open(SH.SCREENS[0].page, SH.SCREENS[0].theme, SH.fixtures());');
  const loop = m.indexOf('for (const s of SH.SCREENS) {');
  assert.ok(warm >= 0 && loop > warm, '本番の前に慣らしの窓を開いていない');
  assert.ok(m.slice(warm, loop).includes('await capture(warm.wc)'), '慣らしの窓を撮っていない（描き終わる前に壊すと慣らしにならない）');
  assert.ok(m.slice(warm, loop).includes('warm.win.destroy()'), '慣らしの窓を壊していない');
});

test('F9: 揺れの確かめの2枚目は、描き直させて（invalidate）から撮る（同じ描き終わりの写しを2回比べても揺れは見つからない）', { timeout: 5000 }, () => {
  const m = read('tools/shots/main.js');
  const a = m.indexOf('const a = await capture(o.wc);');
  const b = m.indexOf('const b = await capture(o.wc);');
  assert.ok(a >= 0 && b > a);
  assert.ok(/o\.wc\.invalidate\(\);/.test(m.slice(a, b)), '2枚目の前に描き直させていない');
  assert.ok(m.slice(a, b).includes('await settle(o.wc, o.t);'), '描き直しが済むのを待っていない');
});
