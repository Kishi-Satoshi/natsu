/*
 * stage094.app.test.js — 0.9.4 の本体の画面（計画 docs/plans/2026-10-22-094.md）。最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。
 *  S-3: ［文字起こしを後回しにして要約］（前の［文字起こしを打ち切って要約］。id liveSkipBtn のまま）と確かめの文
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const 作成中 = (extra) => Object.assign({ active: true, finalizing: true, stopping: true, pending: 3, etaSec: 150, skipped: 0, micFallback: false, startedAt: Date.now() - 60000, stoppedAt: Date.now(), segments: [] }, extra);

test('S-3: 打ち切りのボタンは『文字起こしを後回しにして要約』・確かめの文・id liveSkipBtn のまま。後回しにした数の行', T, async () => {
  let st = 作成中();
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { meetingStatus: () => st, meetingSkipPending: () => ({ ok: true, skipped: 3 }) } });
  l.fire('onMeetingUpdate', st);
  await l.drain();
  const btn = l.document.getElementById('liveSkipBtn');
  assert.ok(btn && !btn.hidden);
  assert.strictEqual(btn.textContent, '文字起こしを後回しにして要約');
  const asked = [];
  l.window.confirm = (m) => { asked.push(m); return true; };
  st = 作成中({ pending: 0, etaSec: null, skipped: 3 });
  btn.dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(asked, ['残っている文字起こしを後回しにして、今ある分で議事録を作ります。残りの音声は消さずに残し、後で文字起こしします。よろしいですか？']);
  assert.strictEqual(l.called('meetingSkipPending').length, 1);
  assert.strictEqual(l.document.getElementById('liveSkipped').textContent, '3 区間の文字起こしを後回しにしました（音声は残してあります）');
  const html = fs.readFileSync(APP, 'utf8');
  assert.ok(!html.includes('打ち切って要約') && !html.includes('打ち切った区間の発言は議事録に入りません'), '前の名前と文が残っている');
});

test('Q3: ヘルプに PC の区切りは 90 秒まで（設定の画面は変えない: 「議事録の文字起こし間隔（秒）」の欄と説明は今のまま）', T, () => {
  const offline = fs.readFileSync(path.join(ROOT, 'help', 'articles', 'settings', 'offline.md'), 'utf8');
  assert.match(offline, /「議事録の文字起こし間隔（秒）」に 90 より大きい値を入れても、PC の中で文字起こしする区切りは 90 秒までです/);
  const line = fs.readFileSync(path.join(ROOT, 'help', 'articles', 'record', 'status-line.md'), 'utf8');
  assert.match(line, /長くても 90 秒/);
  const html = fs.readFileSync(APP, 'utf8');
  assert.ok(html.includes('<div class="desc">短いほど早く画面に出ますが、文の切れ目が増えます（既定75秒。最初の1回は20秒）。</div>'), '設定の画面の説明を変えた');
  assert.strictEqual(require('../src/mainlib').LOCAL_SEGMENT_MS_CAP, 90000);
});

// ---------------------------------------------------------------- S-4（決めたこと 11）: 遅い会議の「聞き取り中」の行
test('遅い会議の #liveTail は『音声を残しています（会議の後で文字起こしします）』（meeting:update の stt.slow で。クラウドで文字になっている間は今の「聞き取り中」）', T, async () => {
  const LIVE = (stt) => ({ active: true, startedAt: Date.now() - 60000, segments: [{ id: 's1', atMs: 0, text: '本日の議題です。' }], pauses: [], cloud: false, stt });
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: () => [], uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' } }), getSettings: () => ({}) } });
  await l.drain();
  const tail = () => l.document.getElementById('pScript').querySelectorAll('.livetail')[0] || null;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  l.fire('onMeetingUpdate', LIVE({ route: 'local', lastTextAt: null, segSec: 75, problem: null, slow: true }));
  await l.drain();
  assert.strictEqual(norm(tail().textContent), '音声を残しています（会議の後で文字起こしします）');
  assert.ok(!tail().classList.contains('seg'));
  l.fire('onMeetingUpdate', LIVE({ route: 'cloud', lastTextAt: Date.now(), segSec: 15, problem: null, slow: true }));
  await l.drain();
  assert.strictEqual(norm(tail().textContent), '聞き取り中…（約 15 秒ごとに文字になります）');
  l.fire('onMeetingUpdate', LIVE({ route: 'local', lastTextAt: null, segSec: 75, problem: null }));
  await l.drain();
  assert.strictEqual(norm(tail().textContent), '聞き取り中…（約 75 秒ごとに文字になります）');
});

// ---------------------------------------------------------------- S-7（決めたこと 19〜22・Q9）: ［ローカル AI の設定］の「この PC の速さ」と軽いモデル
const { parseHTML } = require('./helpers/simdom');
const lib094 = require('../src/mainlib');
const openSettings = (returns = {}) => load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: () => [], uiState: () => ({ sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' } }), getSettings: () => ({ localThreads: 10 }), ...returns } });

test('行『この PC の速さ』とボタン［速さを測る（約 3 分）］・結果の3つの文を出す（画面は文を作らない: main の文をそのまま）・勧めのスレッドの数とボタン・軽いモデルの折りたたみの表と［軽いモデルを取り込む（539 MB）］', T, async () => {
  let answer = null;
  const l = await openSettings({ benchLocal: () => answer, applyBenchThreads: () => ({ ok: true, threads: 6 }), altModelStatus: () => ({ supported: true, manual: false, fetched: false, using: false, path: '' }) });
  await l.drain();
  const $ = (id) => l.document.getElementById(id);
  const row = $('benchRow');
  assert.strictEqual(row.dataset.row, 'この PC の速さ');
  assert.strictEqual($('benchBtn').textContent, '速さを測る（約 3 分）');
  assert.match(String(row.querySelector('.desc').textContent).replace(/\s+/g, ' '), /^会議中に PC で文字起こしが追いつくかを測ります（音声は外へ送りません）。/);
  for (const r of [0.4, 0.8]) {
    answer = { ok: true, rtf: r, verdict: lib094.benchVerdict(r), text: lib094.benchResultText(r), threads: [{ threads: 10, rtf: r }], recommend: null };
    $('benchBtn').dispatchEvent({ type: 'click' });
    await l.drain();
    assert.strictEqual($('benchMsg').textContent, lib094.benchResultText(r));
    assert.ok($('benchThreadsRow').hidden);
    assert.strictEqual($('altBox').open === true, false, '遅くないのに軽いモデルを開いた');
  }
  answer = { ok: true, rtf: 1.6, verdict: 'slow', text: lib094.benchResultText(1.6), threads: [{ threads: 4, rtf: 1.9 }, { threads: 6, rtf: 1.4 }, { threads: 10, rtf: 1.6 }],
    recommend: { threads: 6, text: 'スレッドの数を 6 にすると速くなります（1.60 倍 → 1.40 倍）。', button: 'スレッドの数を 6 にする' } };
  $('benchBtn').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual($('benchMsg').textContent, lib094.benchResultText(1.6));
  assert.strictEqual($('altBox').open, true, '遅いのに軽いモデルの折りたたみを開かない');
  assert.strictEqual($('benchThreadsRow').hidden, false);
  assert.strictEqual($('benchThreadsText').textContent, 'スレッドの数を 6 にすると速くなります（1.60 倍 → 1.40 倍）。');
  assert.strictEqual($('benchThreadsBtn').textContent, 'スレッドの数を 6 にする');
  $('benchThreadsBtn').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(l.called('applyBenchThreads').map((c) => c.args[0]), [6]);
  assert.ok($('benchThreadsRow').hidden);
  answer = { ok: false, code: 'novoice', error: '日本語の読み上げの声が無いため、測れませんでした。会議で使ったときの速さで判断します。' };
  $('benchBtn').dispatchEvent({ type: 'click' });
  await l.drain();
  assert.strictEqual($('benchMsg').textContent, answer.error);
  // 軽いモデルと精度
  const box = $('altBox');
  assert.strictEqual(box.dataset.row, '軽いモデルと精度');
  const t = box.querySelector('table').textContent.replace(/\s+/g, ' ');
  for (const w of ['large-v3-turbo（574 MB）', 'medium（539 MB）', '計算は約半分', '約 1.3 倍', '約 2 倍', 'small（190 MB）', '約 2〜3 倍']) assert.ok(t.includes(w), w);
  assert.strictEqual($('altFetchBtn').textContent, '軽いモデルを取り込む（539 MB）');
  assert.ok(!$('altFetchBtn').hidden && $('altUseBtn').hidden && $('altResetBtn').hidden && $('altManual').hidden);
});

test('手の組の PC ではパスと［パスを写す］（手のパスは書き換えない）。取り込んだ組の PC は［軽いモデルを使う］［元のモデルに戻す］', T, async () => {
  const PATH = '%LOCALAPPDATA%\\natsu\\engine\\models\\ggml-medium-q5_0.bin';
  const manual = await openSettings({ altModelStatus: () => ({ supported: true, manual: true, fetched: true, using: false, path: PATH }) });
  await manual.drain();
  const m = (id) => manual.document.getElementById(id);
  assert.strictEqual(m('altManual').hidden, false);
  assert.strictEqual(m('altManualText').textContent, `詳細設定の『モデルファイル（ggml-*.bin）のパス』を次のファイルに替えてください: ${PATH}`);
  assert.ok(m('altUseBtn').hidden, '手の組の PC で［軽いモデルを使う］を出した');
  m('altCopyBtn').dispatchEvent({ type: 'click' });
  await manual.drain();
  assert.deepStrictEqual(manual.called('copy').map((c) => c.args[0]), [PATH]);
  let using = false;
  const managed = await openSettings({ altModelStatus: () => ({ supported: true, manual: false, fetched: true, using, path: PATH }), useAltModel: (on) => { using = on; return { ok: true }; } });
  await managed.drain();
  const g = (id) => managed.document.getElementById(id);
  assert.ok(!g('altUseBtn').hidden && g('altResetBtn').hidden && g('altFetchBtn').hidden && g('altManual').hidden);
  g('altUseBtn').dispatchEvent({ type: 'click' });
  await managed.drain();
  assert.deepStrictEqual(managed.called('useAltModel').map((c) => c.args[0]), [true]);
  assert.ok(g('altUseBtn').hidden && !g('altResetBtn').hidden);
});

test('0.9.2 の決まり（見える説明は1行・ⓘ）と検索『速さ』『軽い』で行が出る', T, async () => {
  const doc = parseHTML(fs.readFileSync(APP, 'utf8')).root;
  const row = doc.querySelector('#benchRow');
  const descs = row.querySelectorAll('.desc').filter((d) => !d.closest('.setpop') && !d.classList.contains('save-msg'));
  assert.strictEqual(descs.length, 1);
  assert.ok(row.querySelector('.setinfo') && doc.querySelector('#setPopBench'), 'ⓘ の吹き出しが無い');
  const pop = doc.querySelector('#setPopBench').textContent.replace(/\s+/g, ' ');
  assert.ok(pop.includes('Windows の読み上げで作った約 30 秒の日本語を、この PC の文字起こしで1回処理する時間を測ります。音声と結果の文字は残さず、外へ送りません。'), pop);
  assert.ok(pop.includes('会議中は会議のアプリの分だけ遅くなります。'));
  const l = await openSettings({ altModelStatus: () => ({ supported: true, manual: false, fetched: false, using: false, path: '' }) });
  await l.drain();
  const search = async (q) => { const b = l.document.getElementById('setSearch'); b.value = q; b.dispatchEvent({ type: 'input', target: b }); await l.drain(); };
  const shown = () => l.byId.get('tabSettings').querySelectorAll('[data-row]').filter((r) => !r.classList.contains('set-miss') && !r.hidden).map((r) => r.dataset.row);
  await search('速さ');
  assert.ok(shown().includes('この PC の速さ'), JSON.stringify(shown()));
  await search('軽い');
  assert.ok(shown().includes('軽いモデルと精度'), JSON.stringify(shown()));
});
