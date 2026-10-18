/*
 * stage1b2.look.test.js — 第1b2回の見た目（測った値のトークン・青と海の色の約束・書体・部品の形）とサイドバー・検索の窓（L-2）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const html = fs.readFileSync(APP, 'utf8');
const rules = S.parse(parseHTML(html).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
const DARK = '@media (prefers-color-scheme: dark)';
const light = S.tokens(rules, '');
const dark = { ...light, ...S.tokens(rules, DARK) };
const norm = (v) => String(v).replace(/\s/g, '').toLowerCase();
const BODY = '"Segoe UI Variable Text", "Segoe UI", "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", sans-serif';

test('1b2 L-1: トークンは測った参考の値（4.5:1 に届かないものは直した値）', () => {
  const want = {
    '--bg': ['#ffffff', '#191919'], '--side': ['#f9f8f7', '#202020'], '--text': ['#2c2c2b', '#f0efed'],
    '--text-2': ['#5f5e59', '#bcbab6'], '--muted': ['#6d6a66', '#ada9a3'],
    '--line': ['rgba(28,19,1,.11)', 'rgba(255,255,235,.1)'], '--hover': ['rgba(33,27,23,.051)', 'rgba(255,255,255,.055)'],
    '--tint': ['rgba(33,27,23,.06)', 'rgba(255,255,235,.1)'], '--accent': ['#2077ce', '#2077ce'], '--on-accent': ['#ffffff', '#ffffff'],
    '--accent-text': ['#1d6cba', '#5ba3e9'], '--danger': ['#b8352c', '#ff7a70'], '--ok': ['#1a6e42', '#4cc98a'],
    '--level': ['#0e8cae', '#0e8cae'], '--scrim': ['rgba(15,15,15,.25)', 'rgba(0,0,0,.5)'] };
  for (const [k, [l, d]] of Object.entries(want)) {
    assert.strictEqual(norm(light[k]), l, `明の ${k}`);
    assert.strictEqual(norm(dark[k]), d, `暗の ${k}`);
  }
});

test('1b2 L-1・G8: 海の色（--level）はロゴの波と録音中の点だけ。選んでいる行は灰色の地で、左の線も青も持たない', () => {
  const users = new Set(rules.filter((r) => !r.sel.startsWith(':root') && Object.values(r.decls).some((v) => /var\(--level\)/.test(v))).map((r) => r.sel));
  assert.deepStrictEqual([...users].sort(), ['.logo .wave', '.rec-dot']);
  const sel = S.declsFor(rules, '.pitem.sel', { at: '' });
  assert.strictEqual(sel.background, 'var(--tint)');
  assert.ok(!/accent|level/.test(Object.values(sel).join(' ')), JSON.stringify(sel));
  assert.ok(!sel['border-left'] || /none|transparent/.test(sel['border-left']), '選んでいる行に左の線が残っている');
});

test('1b2 L-1・G8: 青（--accent）は主ボタン・フォーカスの輪と入力中の枠・入った印・進み具合・落とし先の線・当たった区間・更新の点だけ', () => {
  const OK = /^(button\.action|#updBadge (button\.go|\.dot))|:focus|\.check input:checked|\.blk\.dropmark|\.seg\.(hit|editing)|\.atag-edit|#engineFetchBar/;
  for (const r of rules) {
    if (r.sel.startsWith(':root')) continue;
    for (const [k, v] of Object.entries(r.decls)) {
      if (k === 'accent-color' || !/var\(--accent\)/.test(v)) continue;
      for (const s of r.sel.split(',')) assert.match(s.trim(), OK, `${r.sel} { ${k}: ${v} } に青`);
    }
  }
});

test('1b2 L-1: 書体は Segoe UI Variable から（題名は Display）。NaTsu の文字はゴシックの 14px・600', () => {
  assert.strictEqual(S.declsFor(rules, 'body', { at: '' })['font-family'], BODY);
  assert.strictEqual(S.declsFor(rules, '.ptitle', { at: '' })['font-family'], BODY.replace('"Segoe UI Variable Text"', '"Segoe UI Variable Display"'));
  const w = S.declsFor(rules, '.wordmark', { at: '' });
  assert.ok(!/Georgia|Mincho|(^|,\s*)serif/i.test(w['font-family'] || ''), `明朝が残っている: ${w['font-family']}`);
  assert.deepStrictEqual([w['font-size'], w['font-weight']], ['14px', '600']);
  assert.ok(html.includes('<div class="wordmark">NaTsu</div>'), '文字と class は今のまま（identity.test）');
});

test('1b2 L-1: ボタンは高さ 28px・角丸 6px・500。入力欄は角丸 6px。スクロールバーは OS の標準（独自のつまみを描かない）', () => {
  for (const sel of ['button.action', 'button.ghost']) {
    const d = S.declsFor(rules, sel, { at: '' });
    assert.deepStrictEqual([d.height, d['border-radius'], d['font-weight']], ['28px', '6px', '500'], sel);
  }
  assert.strictEqual(S.declsFor(rules, 'input[type="text"]', { at: '' })['border-radius'], '6px');
  assert.ok(!rules.some((r) => /::-webkit-scrollbar/.test(r.sel)), '独自のスクロールバーが残っている');
});

// ---------------- L-2: サイドバーの行と検索の窓（画面を偽 DOM で本当に走らせる） ----------------
const { load } = require('./helpers/simrun.js');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const LIST = [{ id: 'pa1', title: '定例（見本）', date: '2026-10-16', durationSec: 1800, hasSummary: true, meetingType: 'standup' },
  { id: 'pb2', title: '設計の打ち合わせ（見本）', date: '2026-10-15', durationSec: 900, hasSummary: false }];
const PAGE = (id) => ({ page: { id, title: LIST.find((p) => p.id === id).title, createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
const TYPES = [{ key: 'general', label: '一般・その他' }, { key: 'standup', label: '定例・進捗報告' }];
const boot = async (o = {}) => { const l = await load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: (q) => (q ? LIST.filter((p) => p.title.includes(q)) : LIST), pageGet: PAGE, meetingTypes: () => TYPES, ...o } }); await l.drain(); return l; };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;

test('1b2 L-2・G5: サイドバーの議事録は「🎙️ 題名」の1行。日付・長さ・要約なし・要約タイプは行の title（要約なしが先）', async () => {
  const l = await boot();
  const rows = l.byId.get('plist').querySelectorAll('.pitem');
  assert.deepStrictEqual(rows.map((r) => [r.querySelector('.pi').textContent, r.querySelector('.t').textContent]),
    [['🎙️', '定例（見本）'], ['🎙️', '設計の打ち合わせ（見本）']]);
  assert.ok(rows.every((r) => !r.querySelector('.m') && !r.querySelector('.snip') && !r.querySelector('.tbadge')), '2行目が残っている');
  assert.match(rows[0].getAttribute('title'), /^2026-10-16 ・ 30分0秒 ・ 定例・進捗報告$/);
  assert.match(rows[1].getAttribute('title'), /^2026-10-15 ・ 15分0秒 ・ 要約なし$/);
  // 要約が無くタイプもある行で、「要約なし」がタイプより先（上の2行では並びを確かめられない）
  const l2 = await boot({ pagesSearch: () => [{ id: 'pc3', title: '振り返り（見本）', date: '2026-10-14', durationSec: 600, hasSummary: false, meetingType: 'standup' }] });
  assert.strictEqual(l2.byId.get('plist').querySelector('.pitem').getAttribute('title'), '2026-10-14 ・ 10分0秒 ・ 要約なし ・ 定例・進捗報告');
});

test('1b2 L-2: サイドバーの頭はロゴと NaTsu と飾りの ▾。行は 🔍 検索・＋ 新しい議事録・見出し・議事録・音声入力・設定。« はフォーカスで見える', async () => {
  const l = await boot();
  const side = l.byId.get('side');
  assert.ok(side.querySelector('.logo .wave') && side.querySelector('.ws-caret'));
  assert.strictEqual(l.byId.get('sideSearch').textContent, '🔍検索');
  assert.strictEqual(l.byId.get('mtToggleBtn').textContent, '＋ 新しい議事録');
  assert.ok(!side.querySelector('#searchBox') && !side.querySelector('#fltAll'), '検索の欄と絞り込みがサイドバーに残っている');
  for (const id of ['sideSearch', 'mtToggleBtn', 'tabBtnDictation', 'tabBtnSettings']) assert.ok(l.byId.get(id).className.split(' ').includes('side-row'), id);
  assert.strictEqual(S.declsFor(rules, '#sideCollapse:focus-visible', { at: '' }).opacity, '1', 'キーボードで « が見えない');
});

test('1b2 L-2・G4: ［検索］で窓が開いて入力欄へ。Esc で閉じて［検索］へ戻る。閉じている間は窓に Tab で届かない', async () => {
  const l = await boot();
  const pal = l.byId.get('palette'), btn = l.byId.get('sideSearch'), box = l.byId.get('searchBox');
  assert.strictEqual(pal.hidden, true);
  btn.focus(); btn.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(pal.hidden, false);
  assert.ok(box.closest('#palette') && l.byId.get('fltFull').closest('#palette'), '検索の欄と絞り込みが窓の中に無い（台帳は移した先を見ない）');
  assert.strictEqual(S.declsFor(rules, '.palette[hidden]', { at: '' }).display, 'none', '本物の画面で hidden が display に負ける');
  assert.ok(l.document.activeElement === box, '入力欄にフォーカスが無い');   // 要素どうしの strictEqual は、落ちたときの差分の表示で偽 DOM の木を丸ごと書き出して止まる
  assert.deepStrictEqual(l.byId.get('palList').querySelectorAll('.pitem').length, 2, '開いたら今の絞り込みで結果を描く');
  l.key({ key: 'Escape' }, box); await l.drain();
  assert.strictEqual(pal.hidden, true);
  assert.ok(l.document.activeElement === btn, '閉じても［検索］へフォーカスが戻らない');
});

test('1b2 L-2・G4: サイドバーを畳んだまま Ctrl+P で開いて Esc で閉じると、フォーカスは［»］へ戻る（隠れた［検索］へ送って見失わない）', async () => {
  const l = await boot();
  l.byId.get('sideCollapse').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.byId.get('sideExpand').hidden, false);
  if (l.document.activeElement) l.document.activeElement.blur();   // 何も選んでいない画面（body）から Ctrl+P
  l.key({ key: 'p', code: 'KeyP', ctrlKey: true }); await l.drain();
  assert.strictEqual(l.byId.get('palette').hidden, false);
  l.key({ key: 'Escape' }, l.byId.get('searchBox')); await l.drain();
  assert.ok(l.document.activeElement === l.byId.get('sideExpand'), '畳んだサイドバーの［検索］へフォーカスを送った（本物の画面では body へ落ちる）');
});

test('1b2 L-2・G3: Ctrl+P で開く（preventDefault）。Ctrl+Shift+P・変換中・ホットキーを入れている最中は開かない', async () => {
  const l = await boot();
  const pal = l.byId.get('palette');
  const ev = l.key({ key: 'p', code: 'KeyP', ctrlKey: true }); await l.drain();
  assert.strictEqual(pal.hidden, false); assert.strictEqual(ev.defaultPrevented, true);
  l.key({ key: 'Escape' }, l.byId.get('searchBox')); await l.drain();
  l.key({ key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true }); await l.drain();
  assert.strictEqual(pal.hidden, true, 'Ctrl+Shift+P（一時停止）で開いた');
  l.key({ key: 'p', code: 'KeyP', ctrlKey: true, isComposing: true }); await l.drain();
  assert.strictEqual(pal.hidden, true, '変換中に開いた');
  l.key({ key: 'p', code: 'KeyP', ctrlKey: true }, l.byId.get('hotkey')); await l.drain();   // attachHotkey が先に preventDefault する
  assert.strictEqual(pal.hidden, true, 'ホットキーを入れている最中に開いた');
});

test('1b2 L-2: ↓ で選び Enter で今のタブ、Ctrl+Enter で新しいタブに開いて窓を閉じる。Tab は窓の中を回る', async () => {
  const l = await boot();
  const pageTabs = () => l.byId.get('tabbar').querySelectorAll('[role="tab"]').map((t) => t.dataset.key).filter((k) => k.startsWith('page:'));
  const box = l.byId.get('searchBox');
  l.key({ key: 'p', code: 'KeyP', ctrlKey: true }); await l.drain();
  l.key({ key: 'Enter' }, box); await l.drain();   // 1つ目の行を今のタブで
  assert.strictEqual(l.byId.get('palette').hidden, true);
  assert.deepStrictEqual(pageTabs(), ['page:pa1']);
  l.key({ key: 'p', code: 'KeyP', ctrlKey: true }); await l.drain();
  l.key({ key: 'ArrowDown' }, box); await l.drain();
  assert.strictEqual(l.byId.get('palList').querySelectorAll('.pitem.kbd').map((r) => r.querySelector('.t').textContent).join(), '設計の打ち合わせ（見本）');
  l.key({ key: 'Enter', ctrlKey: true }, box); await l.drain();
  assert.strictEqual(l.byId.get('palette').hidden, true);
  assert.deepStrictEqual(l.called('pageGet').map((c) => c.args[0]).pop(), 'pb2');
  assert.deepStrictEqual(pageTabs(), ['page:pa1', 'page:pb2'], 'Ctrl+Enter が新しいタブにならない（今のタブを置き換えた）');
  l.key({ key: 'p', code: 'KeyP', ctrlKey: true }); await l.drain();
  const rows = l.byId.get('palList').querySelectorAll('.pitem');
  const last = rows[rows.length - 1];   // 窓の中の最後の届く部品（結果の行も Tab で届く）
  last.focus();
  l.key({ key: 'Tab' }, last); await l.drain();
  assert.ok(l.document.activeElement === box, 'Tab が窓の外へ出た');
  l.key({ key: 'Tab', shiftKey: true }, box); await l.drain();
  assert.ok(l.document.activeElement === last, 'Shift+Tab が窓の最後の部品へ回らない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('1b2 L-2・G2: サイドバーは検索語に関わらず全部のページ。窓が閉じている間は、一覧の更新で窓の側の検索を呼ばない', async () => {
  const l = await boot({ pagesSearchFull: () => ({ hits: [], total: 0, truncated: false }) });
  l.byId.get('searchBox').value = '設計';
  l.byId.get('fltAll').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.byId.get('plist').querySelectorAll('.pitem').length, 2, 'サイドバーが検索語で絞られた');
  assert.strictEqual(l.byId.get('palList').querySelectorAll('.pitem').length, 1);
  const n = l.called('pagesSearch').length;
  l.fire('onPageUpdated', PAGE('pa1')); await l.drain();   // 一覧の更新（refreshList）
  assert.deepStrictEqual(l.called('pagesSearch').slice(n).map((c) => c.args[0]), [''], '閉じた窓の側まで検索した');
});
