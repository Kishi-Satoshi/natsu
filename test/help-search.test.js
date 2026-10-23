/* help-search.test.js — ヘルプセンター H-4: 検索（search-index.json と help/assets/search.js）
 *
 * 索引はテスト用の記事の組（test/fixtures/help/）から写しのフォルダで作る。search.js の並べ方は Node で require して試し、
 * 検索の箱の配線は、作ったページの HTML を test/helpers/simdom.js で木にして、vm の中で search.js を本当に動かして試す。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseHTML, Element } = require('./helpers/simdom');
const { tmpDir } = require('./helpers/help-tmp');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'help');
const SEARCH_JS = path.join(ROOT, 'help', 'assets', 'search.js');
const { build } = require('../tools/help-build');

/** 写しのフォルダで作り、出力の場所を返す。写した help/assets と出力で 1 つ約 15 MB になるので、そのテストの終わりに消す（tmpDir） */
function buildFixture(t, edit) {
  const root = tmpDir(t, 'natsu-help-search-');
  fs.mkdirSync(path.join(root, 'help'));
  fs.cpSync(path.join(FIX, 'site.json'), path.join(root, 'help', 'site.json'));
  fs.cpSync(path.join(FIX, 'articles'), path.join(root, 'help', 'articles'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'help', 'assets'), path.join(root, 'help', 'assets'), { recursive: true });
  if (edit) edit(path.join(root, 'help'));
  const out = path.join(root, 'out');
  build({ root, out });
  return out;
}

test('H-4: search-index.json は v: 1 と、site.json の順の記事ごとの u・t・d・c・h・x。x は印の無い本文で 4,000 字まで', { timeout: 5000 }, (t) => {
  const out = buildFixture(t, (h) => fs.appendFileSync(path.join(h, 'articles', 'record', 'pause.md'), `\n${'あ'.repeat(5000)}\n`));
  const raw = fs.readFileSync(path.join(out, 'search-index.json'), 'utf8');
  const idx = JSON.parse(raw);
  assert.deepStrictEqual(Object.keys(idx), ['v', 'items']);
  assert.strictEqual(idx.v, 1);
  assert.deepStrictEqual(idx.items.map((i) => i.u), ['/start/first/', '/start/steps/', '/record/pause/']);
  for (const it of idx.items) assert.deepStrictEqual(Object.keys(it), ['u', 't', 'd', 'c', 'h', 'x']);
  const steps = idx.items[1];
  assert.strictEqual(steps.t, '試しの手順の記事');
  assert.strictEqual(steps.d, '手順の見出しが3つある記事（このページの内容が出る）');
  assert.strictEqual(steps.c, 'はじめに');
  assert.deepStrictEqual(steps.h, ['用意するもの', '手順1. インストールする', '手順2. ログインする', '見出しの id の無い節']);
  assert.ok(steps.x.includes('大事な注意') && steps.x.includes('Alt+M') && steps.x.includes('irm x | iex'));
  assert.ok(!/\*\*|\[\[|<|>|\]\(|`/.test(steps.x), steps.x);
  assert.strictEqual([...idx.items[2].x].length, 4000, '4,000 字で切る');
  // HTML のページから読む（どのページも同じ search.js）
  assert.ok(fs.readFileSync(path.join(out, 'index.html'), 'utf8').includes('<script src="/assets/search.js" defer></script>'));
  // 同じ元なら同じバイト
  assert.strictEqual(fs.readFileSync(path.join(buildFixture(t, (h) => fs.appendFileSync(path.join(h, 'articles', 'record', 'pause.md'), `\n${'あ'.repeat(5000)}\n`)), 'search-index.json'), 'utf8'), raw);
});

const S = require('../help/assets/search.js');

test('H-4: fold は NFKC と小文字（全角の英数字・半角のカナ・大文字が同じになる）。空白は詰める', { timeout: 5000 }, () => {
  assert.strictEqual(S.fold('ＡＢＣ１２３'), 'abc123');
  assert.strictEqual(S.fold('ｶﾞｲﾄﾞ'), 'ガイド');
  assert.strictEqual(S.fold('LogIn'), 'login');
  assert.strictEqual(S.fold('  一時　 停止  '), '一時 停止');
});

const ITEMS = [
  { u: '/a/', t: '録音を始める', d: '始め方', c: '会議', h: ['ホットキー'], x: '一時停止もできます' },
  { u: '/b/', t: '一時停止と再開', d: '止める', c: '会議', h: ['再開'], x: '本文' },
  { u: '/c/', t: 'ログイン', d: 'コードが届かない', c: 'はじめに', h: ['一時停止の見出し'], x: 'a.b と (x) と [y] と \\ と *' },
  { u: '/d/', t: 'LOGIN の英語', d: '', c: 'はじめに', h: [], x: '' },
];

test('H-4: rank は語が全部あるものだけ。題名に語がある記事が、見出し・説明・本文にだけある記事より上。同じ点は site.json の順。8 件まで', { timeout: 5000 }, () => {
  assert.deepStrictEqual(S.rank(ITEMS, '一時停止').map((r) => r.u), ['/b/', '/c/', '/a/']);   // 題名 3・見出し 2・本文 1
  assert.deepStrictEqual(S.rank(ITEMS, '一時停止 再開').map((r) => r.u), ['/b/']);           // 語が全部ある記事だけ
  assert.deepStrictEqual(S.rank(ITEMS, 'ｌｏｇｉｎ').map((r) => r.u), ['/d/']);               // 全角と大文字がそろう
  assert.deepStrictEqual(S.rank(ITEMS, 'ログイン').map((r) => r.u), ['/c/']);
  assert.deepStrictEqual(S.rank(ITEMS, '会議'), [], '分類の題名では当てない（見出し・題名・説明・本文だけ）');
  assert.deepStrictEqual(S.rank(ITEMS, '一時停止')[0], { u: '/b/', t: '一時停止と再開', c: '会議' });
  // 同じ点は元の順・8 件まで
  const many = Array.from({ length: 12 }, (_, i) => ({ u: `/m${i}/`, t: `記事${i}`, d: '', c: 'x', h: [], x: '共通の語' }));
  assert.deepStrictEqual(S.rank(many, '共通').map((r) => r.u), many.slice(0, 8).map((m) => m.u));
  many[10].t = '共通の題名';
  assert.strictEqual(S.rank(many, '共通')[0].u, '/m10/');
});

test('H-4: rank は空の語・空白だけで空の配列。正規表現の文字（. * ( [ \\）を文字として探す', { timeout: 5000 }, () => {
  assert.deepStrictEqual(S.rank(ITEMS, ''), []);
  assert.deepStrictEqual(S.rank(ITEMS, '   　 '), []);
  for (const q of ['.', '*', '(', '[', '\\', 'a.b', '(x)']) assert.deepStrictEqual(S.rank(ITEMS, q).map((r) => r.u), ['/c/'], q);
  assert.deepStrictEqual(S.rank(ITEMS, '.*'), []);
});

test('H-4: search.js は外へ通信しない（fetch は /search-index.json だけ・eval も new Function も innerHTML も無い。結果の文字は textContent で入れる）', { timeout: 5000 }, () => {
  const js = fs.readFileSync(SEARCH_JS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const fetches = [...js.matchAll(/fetch\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.deepStrictEqual(fetches, ["'/search-index.json'"]);
  assert.ok(!/XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts|eval\s*\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write|https?:|localStorage|sessionStorage|document\.cookie/.test(js));
  assert.match(js, /\.textContent = /);
  assert.match(js, /if \(typeof module === 'object'\) module\.exports = HelpSearch;/);
});

/** 作ったページを simdom の木にして、search.js を vm の中で動かす */
function runPage(t, file, opt = {}) {
  const out = buildFixture(t);
  const html = fs.readFileSync(path.join(out, file), 'utf8');
  const index = opt.index || JSON.parse(fs.readFileSync(path.join(out, 'search-index.json'), 'utf8'));
  const { root } = parseHTML(html);
  const docListeners = {};
  const document = {
    querySelector: (s) => root.querySelector(s),
    querySelectorAll: (s) => root.querySelectorAll(s),
    getElementById: (id) => root.querySelector(`#${id}`),
    createElement: (t) => new Element(t),
    addEventListener: (t, fn) => { (docListeners[t] = docListeners[t] || []).push(fn); },
    documentElement: root.querySelector('html'),
  };
  const calls = [];
  const went = [];
  const fetch = (u) => { calls.push(u); return Promise.resolve(opt.fail ? { ok: false, json: () => Promise.reject(new Error('x')) } : { ok: true, json: () => Promise.resolve(index) }); };
  const media = [];   // matchMedia の問い合わせ（再審査の指摘 4）
  const window = { location: { assign: (u) => went.push(u) } };
  if (opt.narrow !== undefined) {
    window.matchMedia = (q) => { const m = { media: q, matches: opt.narrow, fns: [], addEventListener: (t, fn) => { if (t === 'change') m.fns.push(fn); } }; media.push(m); return m; };
  }
  const ctx = vm.createContext({ document, window, fetch, location: window.location });
  vm.runInContext(fs.readFileSync(SEARCH_JS, 'utf8'), ctx, { filename: 'search.js' });
  const tick = () => new Promise((r) => setImmediate(r));
  const key = (el, k) => el.dispatchEvent({ type: 'keydown', key: k });
  const type = async (el, v) => { el.value = v; el.dispatchEvent({ type: 'input' }); await tick(); await tick(); };
  return { root, html, calls, went, tick, key, type, docListeners, media };
}

test('H-4: 検索の箱の配線（simdom。再審査の指摘 1: 選択肢は a[role="option"]・li は role="none"）: JS が動くと箱が出る・打つと結果が出る・↓↑で aria-activedescendant が動く・Enter で選んだ記事の URL へ・Esc で閉じ、もう一度 Esc で空に・index は1回だけ読む', { timeout: 5000 }, async (t) => {
  const p = runPage(t, 'start/first/index.html');
  // 初めの HTML では箱は hidden（JS が動かないときは出さない）
  assert.ok(/<div class="search" hidden>/.test(p.html));
  const box = p.root.querySelector('.search');
  const q = p.root.querySelector('#hc-q');
  const list = p.root.querySelector('#hc-q-results');
  assert.strictEqual(box.hidden, false, 'JS が箱を出していない');
  assert.strictEqual(q.getAttribute('role'), 'combobox');
  assert.strictEqual(q.getAttribute('aria-controls'), 'hc-q-results');
  assert.strictEqual(list.getAttribute('role'), 'listbox');
  assert.strictEqual(p.calls.length, 0, '打つ前に読んでいる');

  await p.type(q, '一時停止');
  assert.deepStrictEqual(p.calls, ['/search-index.json']);
  assert.strictEqual(list.hidden, false);
  assert.strictEqual(q.getAttribute('aria-expanded'), 'true');
  const opts = () => list.querySelectorAll('[role="option"]');
  // 題名に語のある記事（3 点）が、本文のリンクの文にだけある記事（1 点）より上
  assert.deepStrictEqual(opts().map((o) => o.getAttribute('href')), ['/record/pause/', '/start/first/']);
  assert.strictEqual(opts()[0].querySelector('.rt').textContent, '試しの一時停止');
  assert.strictEqual(opts()[0].querySelector('.rc').textContent, '会議を記録する');
  // 再審査の指摘 1（WCAG 4.1.2・nested-interactive）: 選択肢はリンクそのもの（a[role="option"]）で、li は role="none"。選択肢の中にリンクを入れ子にしない
  for (const o of opts()) {
    assert.strictEqual(o.tagName, 'a', '選択肢が a でない');
    assert.strictEqual(o.getAttribute('tabindex'), '-1');
    assert.strictEqual(o.parentNode.tagName, 'li');
    assert.strictEqual(o.parentNode.getAttribute('role'), 'none');
    assert.strictEqual(o.querySelectorAll('a, button, input, [tabindex]').length, 0, '選択肢の中に操作できるもの');
  }
  assert.strictEqual(list.querySelectorAll('[role="option"] a').length, 0, '選択肢の中にリンクが入れ子');

  await p.type(q, '試し');
  assert.deepStrictEqual(opts().map((o) => o.getAttribute('href')), ['/start/first/', '/start/steps/', '/record/pause/']);
  assert.strictEqual(q.getAttribute('aria-activedescendant'), null);
  p.key(q, 'ArrowDown');
  assert.strictEqual(q.getAttribute('aria-activedescendant'), opts()[0].id);
  assert.strictEqual(opts()[0].getAttribute('aria-selected'), 'true');
  p.key(q, 'ArrowDown');
  assert.strictEqual(q.getAttribute('aria-activedescendant'), opts()[1].id);
  assert.strictEqual(opts()[0].getAttribute('aria-selected'), 'false');
  p.key(q, 'ArrowUp');
  p.key(q, 'ArrowUp');
  assert.strictEqual(q.getAttribute('aria-activedescendant'), opts()[2].id, '↑ は一番上から一番下へ回る');
  p.key(q, 'Enter');
  assert.deepStrictEqual(p.went, ['/record/pause/']);
  assert.strictEqual(new Set(opts().map((o) => o.id)).size, 3);

  // 見つからないとき
  await p.type(q, 'ありえない語');
  assert.deepStrictEqual(opts().map((o) => o.textContent), ['見つかりませんでした']);
  assert.strictEqual(opts()[0].getAttribute('aria-disabled'), 'true');
  p.key(q, 'Enter');
  assert.deepStrictEqual(p.went, ['/record/pause/'], '見つからないのに開いた');

  // Esc で閉じ、もう一度 Esc で空に
  await p.type(q, '試し');
  p.key(q, 'Escape');
  assert.strictEqual(list.hidden, true);
  assert.strictEqual(q.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(q.value, '試し');
  p.key(q, 'Escape');
  assert.strictEqual(q.value, '');
  // 空にすると閉じる。index は1回だけ読む
  await p.type(q, '試し');
  await p.type(q, '   ');
  assert.strictEqual(list.hidden, true);
  assert.deepStrictEqual(p.calls, ['/search-index.json']);
});

test('H-4: どのページの上の帯にも検索の箱があり、ホームには大きな箱もある（id は重ならない）', { timeout: 5000 }, async (t) => {
  const p = runPage(t, 'index.html');
  const boxes = p.root.querySelectorAll('.search');
  assert.strictEqual(boxes.length, 2);
  assert.ok(p.root.querySelector('header .search #hc-q'), '上の帯の箱');
  assert.ok(p.root.querySelector('main .search-big #hc-q-home'), 'ホームの大きな箱');
  assert.strictEqual(p.root.querySelector('#hc-q-home').getAttribute('placeholder'), '記事を探す（例: ログイン、一時停止）');
  for (const b of boxes) assert.strictEqual(b.hidden, false);
  const big = p.root.querySelector('#hc-q-home');
  await p.type(big, 'ホットキー');
  const list = p.root.querySelector('#hc-q-home-results');
  assert.deepStrictEqual(list.querySelectorAll('[role="option"]').map((o) => o.getAttribute('href')), ['/record/pause/', '/start/first/']);
  assert.strictEqual(p.root.querySelector('#hc-q-results').hidden, true, 'ほかの箱の結果まで開いた');
  // 外を押すと閉じる
  for (const fn of p.docListeners.click || []) fn({ type: 'click', target: p.root.querySelector('main h1') });
  assert.strictEqual(list.hidden, true);
  assert.deepStrictEqual(p.calls, ['/search-index.json']);
});

// help-dads HD-5（HD6。計画 docs/plans/2026-10-23-help-dads.md の決めたこと H・DF3）: 検索の件数の知らせ（読み上げソフトへの対応の唯一の例外。
// 0.10.0 の /open のページの知らせ（D78）と合わせて2つ）。決まった文だけを textContent で入れ、閉じたら空に、同じ文なら書き直さない
test('HD-5（HD6・DF3）: 検索の箱ごとに見えない role="status" の p.vh が1つ（id は <箱の id>-status）。本物の help/ から作った全部のページで、role="status" は検索の箱の中と /open のページの #hc-open-msg にだけ', { timeout: 10000 }, (t) => {
  const p = runPage(t, 'index.html');
  for (const id of ['hc-q', 'hc-q-home']) {
    const box = p.root.querySelector(`#${id}`).closest('.search');
    const st = box.querySelectorAll('[role="status"]');
    assert.strictEqual(st.length, 1, `${id}: status の数`);
    assert.strictEqual(st[0].tagName, 'p');
    assert.strictEqual(st[0].id, `${id}-status`);
    assert.ok(st[0].classList.contains('vh'), `${id}: 見えない文でない`);
    assert.strictEqual(st[0].textContent, '');
  }
  // 本物の記事の全部（/open のページも）で、role="status" は決まった所だけ（例外が知らないうちに広がらない）
  const root = tmpDir(t, 'natsu-help-status-');
  fs.cpSync(path.join(ROOT, 'help'), path.join(root, 'help'), { recursive: true, filter: (x) => !x.split(path.sep).includes('dist') });
  const out = path.join(root, 'out');
  const r = build({ root, out });
  assert.ok(r.pages.includes('open/index.html'), '/open のページが無い');
  let n = 0;
  for (const f of r.pages) {
    const html = fs.readFileSync(path.join(out, f), 'utf8');
    const count = (html.match(/role="status"/g) || []).length;
    const tree = parseHTML(html).root;
    const st = tree.querySelectorAll('[role="status"]');
    assert.strictEqual(st.length, count, `${f}: 木で数えた数と字面の数が違う`);
    for (const el of st) {
      n++;
      if (f === 'open/index.html' && el.id === 'hc-open-msg') continue;
      const box = el.closest('.search');
      assert.ok(box, `${f}: 検索の箱の外に role="status"（${el.id}）`);
      assert.strictEqual(el.id, `${box.querySelector('input').id}-status`, `${f}: status の id`);
    }
    if (f !== 'open/index.html') assert.strictEqual(st.length, tree.querySelectorAll('.search').length, `${f}: 箱ごとに1つでない`);
  }
  assert.ok(n > r.pages.length, '数えた status が少ない');
});

test('HD-5（HD6・DF3）: 件数の知らせの文（simdom）: 3 件は「3 件見つかりました」、8 件（上限）は「上から 8 件を表示しています」、0 件は「見つかりませんでした」。Esc で閉じると空、空にしても空。同じ文が続くときは書き直さない', { timeout: 5000 }, async (t) => {
  const p = runPage(t, 'start/first/index.html');
  const q = p.root.querySelector('#hc-q');
  const st = p.root.querySelector('#hc-q-status');
  assert.strictEqual(st.textContent, '');
  await p.type(q, '試し');
  assert.strictEqual(st.textContent, '3 件見つかりました');
  const node = st.childNodes[0];
  await p.type(q, '試しの');
  assert.strictEqual(st.textContent, '3 件見つかりました');
  assert.strictEqual(st.childNodes[0], node, '同じ文を書き直した（読み上げが積もる）');
  await p.type(q, '一時停止');
  assert.strictEqual(st.textContent, '2 件見つかりました');
  await p.type(q, 'ありえない語');
  assert.strictEqual(st.textContent, '見つかりませんでした');
  p.key(q, 'Escape');
  assert.strictEqual(st.textContent, '', 'Esc で閉じても前の文が残る');
  await p.type(q, '試し');
  assert.strictEqual(st.textContent, '3 件見つかりました');
  await p.type(q, '  ');
  assert.strictEqual(st.textContent, '', '空にしても前の文が残る');
  await p.type(q, '試し');
  for (const fn of p.docListeners.click || []) fn({ type: 'click', target: p.root.querySelector('main h1') });
  assert.strictEqual(st.textContent, '', '外を押して閉じても前の文が残る');
  // 上限の 8 件は全体の数と偽らない
  const many = { v: 1, items: Array.from({ length: 12 }, (_, i) => ({ u: `/m${i}/`, t: `記事${i}`, d: '', c: 'x', h: [], x: '共通の語' })) };
  const p8 = runPage(t, 'start/first/index.html', { index: many });
  await p8.type(p8.root.querySelector('#hc-q'), '共通');
  assert.strictEqual(p8.root.querySelector('#hc-q-results').querySelectorAll('[role="option"]').length, 8);
  assert.strictEqual(p8.root.querySelector('#hc-q-status').textContent, '上から 8 件を表示しています');
});

test('HD-5（HD6・DF3）: 索引が読めないときは「検索を読み込めませんでした。開き直してください」を status にも入れる（黙らない）', { timeout: 5000 }, async (t) => {
  const p = runPage(t, 'start/first/index.html', { fail: true });
  await p.type(p.root.querySelector('#hc-q'), '試し');
  assert.strictEqual(p.root.querySelector('#hc-q-status').textContent, '検索を読み込めませんでした。開き直してください');
});

// 再審査の指摘 4（持ち主の答え「全部直す」）: 320px と、375px で文字を 125% にしたとき、上の帯の検索の箱の「記事を探す」が「記事を探」で切れた。
// 狭い画面（max-width: 29.9375rem。rem なので文字の設定を大きくしたときも当たる）では、上の帯の箱の置き換えの文だけを「探す」にする
test('再審査の指摘 4: 上の帯の検索の箱は data-short="探す" を持ち、狭い画面（matchMedia の (max-width: 29.9375rem) が当たる）では置き換えの文が「探す」、広くなると「記事を探す」に戻る。ホームの大きな箱は変えない。matchMedia が無いブラウザでは今のまま', { timeout: 5000 }, async (t) => {
  const p = runPage(t, 'index.html', { narrow: true });
  const top = p.root.querySelector('#hc-q');
  const big = p.root.querySelector('#hc-q-home');
  assert.strictEqual(top.getAttribute('data-short'), '探す');
  assert.strictEqual(big.getAttribute('data-short'), null);
  assert.deepStrictEqual(p.media.map((m) => m.media), ['(max-width: 29.9375rem)']);
  assert.strictEqual(top.getAttribute('placeholder'), '探す');
  assert.strictEqual(big.getAttribute('placeholder'), '記事を探す（例: ログイン、一時停止）');
  p.media[0].matches = false;
  for (const fn of p.media[0].fns) fn({ matches: false });
  assert.strictEqual(top.getAttribute('placeholder'), '記事を探す');
  p.media[0].matches = true;
  for (const fn of p.media[0].fns) fn({ matches: true });
  assert.strictEqual(top.getAttribute('placeholder'), '探す');
  const wide = runPage(t, 'index.html', { narrow: false });
  assert.strictEqual(wide.root.querySelector('#hc-q').getAttribute('placeholder'), '記事を探す');
  const old = runPage(t, 'index.html');
  assert.strictEqual(old.root.querySelector('#hc-q').getAttribute('placeholder'), '記事を探す');
  // 見えないラベルは「記事を探す」のまま（置き換えの文だけを短くする）
  assert.strictEqual(p.root.querySelector('label[for="hc-q"]').textContent, '記事を探す');
});

// 3回目の審査の指摘 2（重要・WCAG 2.4.11）と 4: 結果を開いたまま Tab で箱の外へ出ると一覧が開いたまま残り、輪の付いた部品を覆い隠した。
// 箱からフォーカスが外へ出たら閉じる。結果の一覧（ul）は tabindex="-1"（Tab で一覧そのものに止まらない）
test('3回目の指摘 2: 検索の箱からフォーカスが外へ出たら（focusout の行き先が箱の外・無い）一覧を閉じ、aria-expanded="false"・status は空。行き先が箱の中（結果のリンク）なら閉じない。一覧の ul は tabindex="-1"', { timeout: 5000 }, async (t) => {
  const p = runPage(t, 'index.html');
  for (const id of ['hc-q', 'hc-q-home']) assert.strictEqual(p.root.querySelector(`#${id}-results`).getAttribute('tabindex'), '-1', `${id}: 一覧に Tab が止まる`);
  const big = p.root.querySelector('#hc-q-home');
  const box = big.closest('.search');
  const list = p.root.querySelector('#hc-q-home-results');
  const st = p.root.querySelector('#hc-q-home-status');
  await p.type(big, '試し');
  assert.strictEqual(list.hidden, false);
  // 箱の中（結果のリンク）へ移るときは閉じない（マウスで結果を押したとき）
  box.dispatchEvent({ type: 'focusout', relatedTarget: list.querySelector('[role="option"]') });
  assert.strictEqual(list.hidden, false, '箱の中へ移ったのに閉じた');
  // Tab で箱の外（分類のカード）へ出たら閉じる
  box.dispatchEvent({ type: 'focusout', relatedTarget: p.root.querySelector('.cats a') });
  assert.strictEqual(list.hidden, true, '箱の外へ出ても一覧が開いたまま（輪の付いた部品を隠す）');
  assert.strictEqual(big.getAttribute('aria-expanded'), 'false');
  assert.strictEqual(st.textContent, '');
  assert.strictEqual(big.value, '試し', '打った文字は消さない');
  // 行き先が無い（窓の外へ出た）ときも閉じる
  await p.type(big, '一時停止');
  assert.strictEqual(list.hidden, false);
  box.dispatchEvent({ type: 'focusout', relatedTarget: null });
  assert.strictEqual(list.hidden, true);
});
