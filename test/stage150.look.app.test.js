/* stage150.look.app.test.js — 0.15.0 Task PL-3（U2・U5・U6・F119・F120。計画 docs/plans/2026-11-03-150.md の決めたこと 33・35〜42）:
 * ページのアイコンの選び（#iconPop）・アイコンが出る所（どれも pageIconOf）・「···」の全幅・小さい文字・書体と #pageWrap の組。
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。題名は作った物（titleAt か D77 の注）
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { titleAt } = require('./helpers/titles');
const { parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');
const D = require('../src/emojiDict');
const LK = require('../src/pageLook');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const HTML = fs.readFileSync(APP, 'utf8');
const T = { timeout: 15000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);

// 見本: 最上位の議事録 pa2（アイコン 📊）・その中の白紙のページ k1（アイコン 🚀・本文に子 g1 の行）・白紙のページ g1（アイコン無し）・議事録 pa1
const AT = (d) => `2026-10-${d}.000Z`;
const ROW = (id, createdAt, o = {}) => ({ id, title: titleAt(createdAt), date: createdAt.slice(0, 10), durationSec: 600, hasSummary: true, createdAt, parentId: null, ord: 'i', ...o });
const LIST = () => [
  ROW('g1', AT('21T08:00:00'), { parentId: 'k1', kind: 'blank' }),
  ROW('k1', AT('21T06:00:00'), { parentId: 'pa2', kind: 'blank', icon: '🚀' }),
  ROW('pa2', AT('21T00:00:00'), { icon: '📊' }),
  ROW('pa1', AT('20T00:00:00')),
];
const PAGE = (id, list = LIST(), extra = {}) => {
  const p = list.find((x) => x.id === id);
  if (!p) return null;
  const blocks = id === 'k1' ? [{ id: 'q1', type: 'paragraph', text: '本文の行' }, { id: 'q2', type: 'subpage', text: '', page: 'g1' }] : [];
  return { page: { id, title: p.title, date: p.date, createdAt: p.createdAt, durationSec: 600, blocks, memo: '', meetingType: 'general', ...(p.kind ? { kind: p.kind } : {}), ...(p.icon ? { icon: p.icon } : {}), ...(extra[id] || {}) }, segments: [] };
};
async function boot(o = {}) {
  let list = o.list || LIST();
  const looks = { ...(o.looks || {}) };
  const l = await load(APP, { returns: {
    pagesSearch: () => list, pageGet: (id) => PAGE(id, list, Object.fromEntries(Object.entries(looks).map(([k, v]) => [k, { look: v }]))),
    pageSetIcon: (id, icon) => { list = list.map((p) => (p.id === id ? (icon ? { ...p, icon } : (({ icon: _i, ...rest }) => rest)(p)) : p)); const pg = PAGE(id, list).page; return icon ? { ...pg, icon } : pg; },
    pageSetLook: (id, look) => { const n = LK.normalizeLook(look); if (LK.isPlainLook(n)) delete looks[id]; else looks[id] = n; return { ...PAGE(id, list).page, ...(looks[id] ? { look: looks[id] } : {}) }; },
    ...(o.returns || {}) } });
  await l.drain();
  return l;
}
const open = async (l, id) => { l.fire('onPageOpen', id); await l.drain(); };
const rowOf = (l, id) => $(l, 'plist').querySelectorAll('.pitem').find((r) => r.dataset.pid === id);
const opts = (l) => $(l, 'iconList').querySelectorAll('.icopt');
const heads = (l) => $(l, 'iconList').querySelectorAll('.ichead').map((h) => h.textContent);
const menuOf = (l) => $(l, 'pMenu').querySelectorAll('.mitem');
const openMenu = (l) => { $(l, 'pMore').dispatchEvent({ type: 'click' }); return menuOf(l); };
const item = (l, label) => menuOf(l).find((b) => b.textContent === label);
const lookClass = (el) => String(el.className || '').split(/\s+/).filter((c) => /^look-/.test(c));

// ---------------------------------------------------------------- 写し
test('PL-3: 画面の写し（app.html の emojiView・lookView）は src/emojiDict.js・src/pageLook.js と字も答えも同じ', () => {
  for (const [mark, file, from, ret] of [['emojiDict', 'emojiDict.js', 'const CATS', 'emojiView'], ['pageLook', 'pageLook.js', 'const FONTS', 'lookView']]) {
    const at = HTML.indexOf(`  // ---- ${mark} の写し`);
    const end = HTML.indexOf(`  // ---- ${mark} の写しはここまで`);
    assert.ok(at > 0 && end > at, `app.html に ${mark} の写しが無い`);
    const seg = HTML.slice(at, end);
    const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    const body = SRC.slice(SRC.indexOf(from), SRC.indexOf('\nmodule.exports')).replace(/\s+$/, '');
    assert.ok(seg.includes(body.split('\n').map((x) => (x ? `    ${x}` : x)).join('\n')), `app.html の ${mark} の写しの字が src/${file} と違う`);
    const v = new Function(`${seg}\nreturn ${ret};`)();   // eslint-disable-line no-new-func
    if (ret === 'emojiView') {
      assert.deepStrictEqual(v.EMOJI.map((x) => [x.e, x.n, x.y, x.c]), D.EMOJI.map((x) => [x.e, x.n, x.y, x.c]));
      for (const q of ['しょるい', 'ショルイ', 'tしゃつ', 'ね', '']) assert.deepStrictEqual(v.findEmoji(q), D.findEmoji(q), q);
      for (const e of [{ icon: '🚀' }, { kind: 'blank' }, {}, { icon: 'x', kind: 'blank' }]) assert.strictEqual(v.pageIconOf(e), D.pageIconOf(e));
    } else {
      for (const x of [{ wide: true, font: 'serif' }, { small: true }, {}, { font: 'x' }]) assert.deepStrictEqual(v.lookClasses(x), LK.lookClasses(x));
    }
  }
});

// ---------------------------------------------------------------- アイコンの選び
test('PL-3: #pIcon は button（aria-label）・押すと #iconPop・よみで探す・最近使ったもの・［外す］→ pageSetIcon(id, \'\')・Esc でフォーカスが #pIcon に戻る・描くのは textContent', T, async () => {
  const l = await boot({ returns: { uiState: () => ({ emojiRecent: ['🌸', 'x', '🦕', '🚀'] }) } });
  await open(l, 'g1');
  const btn = $(l, 'pIcon');
  assert.strictEqual(String(btn.tagName).toLowerCase(), 'button');
  assert.strictEqual(btn.getAttribute('aria-label'), 'アイコンを変える');
  assert.strictEqual(btn.textContent, '📄', '白紙のページの既定のアイコンでない');
  assert.strictEqual(btn.getAttribute('aria-disabled'), null);
  btn.focus();
  btn.dispatchEvent({ type: 'click' }); await l.drain();
  const pop = $(l, 'iconPop');
  assert.strictEqual(pop.hidden, false, '押しても選びの窓が出ない');
  assert.ok(l.document.activeElement === $(l, 'iconSearch'), '探す欄にフォーカスが無い');
  assert.deepStrictEqual(heads(l), ['最近使ったもの', ...D.CATS.map((c) => c.label)], '最近使ったもの・分類の見出しが違う');
  assert.deepStrictEqual(opts(l).slice(0, 2).map((b) => b.textContent), ['🌸', '🚀'], '最近使ったもの（辞書に無い値は落とす）が違う');
  assert.strictEqual(opts(l).length, 2 + D.EMOJI.length);
  const doc = opts(l).find((b) => b.textContent === '📄');
  assert.strictEqual(doc.getAttribute('aria-label'), '書類');
  for (const b of opts(l)) assert.strictEqual(b.childNodes.length, 1, '絵文字の他の子を描いた（textContent だけ）');
  // 窓の間は後ろを替えない（R58 の I-1 と同じ）
  l.key({ key: 'p', code: 'KeyP', ctrlKey: true }); await l.drain();
  assert.strictEqual($(l, 'palette').hidden, true, 'アイコンの選びの上に検索の窓を開いた');
  l.key({ key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true }); await l.drain();
  assert.strictEqual($(l, 'newPop').hidden, true, 'アイコンの選びの間に「新しいページ」を開いた');
  const g0 = l.called('pageGet').length;
  l.key({ key: 'U', code: 'KeyU', ctrlKey: true, shiftKey: true }); await l.drain();
  assert.strictEqual(l.called('pageGet').length, g0, 'アイコンの選びの間に Ctrl+Shift+U で親（k1）へ移った');
  assert.strictEqual(pop.hidden, false);
  // Tab は窓の中で回る（探す欄 →［外す］→ 選んでいる絵文字 → 探す欄。Shift+Tab は逆）
  $(l, 'iconSearch').focus();
  const ring = [];
  for (let i = 0; i < 3; i++) { l.key({ key: 'Tab' }, l.document.activeElement); ring.push(l.document.activeElement); }
  assert.deepStrictEqual(ring.map((e) => e.id || e.className), ['iconClear', 'icopt', 'iconSearch'], 'Tab が窓の中で回らない');
  l.key({ key: 'Tab', shiftKey: true }, l.document.activeElement);
  assert.ok(l.document.activeElement.className === 'icopt', 'Shift+Tab が逆に回らない');
  $(l, 'iconSearch').focus();
  // よみで探す（カタカナ・ひらがな）
  const box = $(l, 'iconSearch');
  box.value = 'ショルイ'; box.oninput(); await l.drain();
  assert.deepStrictEqual(heads(l), ['見つかったもの']);
  assert.deepStrictEqual(opts(l).map((b) => b.textContent), D.findEmoji('しょるい'));
  box.value = 'あいうえおかきく'; box.oninput(); await l.drain();
  assert.strictEqual($(l, 'iconList').textContent, '当てはまるアイコンはありません');
  // ↓ と ← → で選び、Enter で付ける（pageSetIcon の1回・最近使ったものの頭へ・覚える）
  box.value = 'ね'; box.oninput(); await l.drain();
  l.key({ key: 'ArrowDown' }, box);
  assert.ok(l.document.activeElement === opts(l)[0], '↓ で最初の絵文字へ移らない');
  l.key({ key: 'ArrowRight' }, opts(l)[0]);
  const want = opts(l)[1].textContent;
  assert.ok(l.document.activeElement === opts(l)[1], '→ で次の絵文字へ移らない');
  l.key({ key: 'Enter' }, opts(l)[1]); await l.drain(); await l.drain();
  assert.deepStrictEqual(l.called('pageSetIcon').map((c) => c.args), [['g1', want]]);
  assert.strictEqual(pop.hidden, true, '選んでも窓が閉じない');
  assert.ok(l.document.activeElement === btn, '選んだ後のフォーカスが #pIcon でない');
  assert.strictEqual(btn.textContent, want, 'ページの頭のアイコンが替わらない');
  const recent = l.called('uiSave').map((c) => c.args[0]).filter((p) => p && p.emojiRecent).pop();
  assert.deepStrictEqual(recent, { emojiRecent: [want, '🌸', '🚀'] }, '最近使ったものを覚えない（頭へ・重なり無し）');
  // ［外す］→ 既定に戻る
  btn.dispatchEvent({ type: 'click' }); await l.drain();
  $(l, 'iconClear').dispatchEvent({ type: 'click' }); await l.drain(); await l.drain();
  assert.deepStrictEqual(l.called('pageSetIcon').pop().args, ['g1', '']);
  assert.strictEqual(btn.textContent, '📄', '［外す］で既定のアイコンに戻らない');
  // Esc で閉じてフォーカスを #pIcon へ（付けない）
  const n0 = l.called('pageSetIcon').length;
  btn.dispatchEvent({ type: 'click' }); await l.drain();
  l.key({ key: 'Escape' }, $(l, 'iconSearch')); await l.drain();
  assert.deepStrictEqual([pop.hidden, l.document.activeElement === btn, l.called('pageSetIcon').length], [true, true, n0], 'Esc で閉じない・フォーカスを戻さない・付けた');
  // 変換中の Enter は付けない
  btn.dispatchEvent({ type: 'click' }); await l.drain();
  l.key({ key: 'ArrowDown' }, $(l, 'iconSearch'));
  l.key({ key: 'Enter', isComposing: true }, l.document.activeElement); await l.drain();
  assert.strictEqual(l.called('pageSetIcon').length, n0, '変換中の Enter で付けた');
  l.key({ key: 'Escape' }, $(l, 'iconSearch')); await l.drain();
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PL-3・R71: 録音中のページ（記録中のタブ）では #pIcon が aria-disabled で、押しても選びの窓を開かない。「···」の見た目の項目は録音中の写しに出さない', T, async () => {
  const live = { ...LIST()[3], id: 'plv1' };
  const l = await boot({ list: [...LIST(), live], returns: { pageGet: (id) => (id === 'plv1' ? { page: { id, title: live.title, date: live.date, createdAt: live.createdAt, blocks: [], memo: '', meeting: { phase: 'recording' }, look: { wide: true, font: 'serif' } }, segments: [] } : PAGE(id)) } });
  await open(l, 'plv1');
  assert.deepStrictEqual(lookClass($(l, 'pageWrap')), [], '録音中の写しに保存した見た目を付けた');
  assert.strictEqual($(l, 'pIcon').getAttribute('aria-disabled'), 'true', '録音中の写しのアイコンが押せる形');
  $(l, 'pIcon').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual($(l, 'iconPop').hidden, true, '録音中の写しで選びの窓を開いた');
  const labels = openMenu(l).map((b) => b.textContent);
  for (const w of ['全幅', '小さい文字', '書体 ▸']) assert.ok(!labels.includes(w), `録音中の写しの「···」に［${w}］`);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- アイコンが出る所
test('PL-3: アイコンがサイドバーの行・ページのタブ・パンくず・検索の結果・子ページの行・ページの頭に出る（どれも pageIconOf。辞書に無い値は既定）', T, async () => {
  const list = [...LIST(), ROW('pa3', AT('22T00:00:00'), { icon: '‮長い文' }), ROW('pa4', AT('19T00:00:00'), { icon: '🌸' })];   // pa4 は子の無い行のアイコン
  const l = await boot({ list, returns: { uiState: () => ({ tree: { open: ['pa2', 'k1'] } }) } });
  await open(l, 'pa2');
  for (const id of ['k1', 'pa3']) { rowOf(l, id).dispatchEvent({ type: 'click', ctrlKey: true }); await l.drain(); }
  $(l, 'tabbar').querySelectorAll('.tabitem').find((t) => t.dataset.key === 'page:k1').dispatchEvent({ type: 'click' }); await l.drain();
  // サイドバーの行（子のある行は ▸ の下の .pe・無い行は .pi）
  const rowIcon = (id) => { const r = rowOf(l, id); const pe = r.querySelector('.pe'); return (pe || r.querySelector('.pi')).textContent; };
  assert.deepStrictEqual(['pa2', 'k1', 'g1', 'pa1', 'pa3', 'pa4'].map(rowIcon), ['📊', '🚀', '📄', '🎙️', '🎙️', '🌸'], 'サイドバーの行のアイコン');
  // ページのタブ（data-icon を CSS の ::before が描く。録音中と音声入力のタブには付けない）
  const tabIcon = (id) => $(l, 'tabbar').querySelectorAll('.tabitem').find((t) => t.dataset.key === `page:${id}`).querySelector('.tt').getAttribute('data-icon');
  assert.deepStrictEqual(['pa2', 'k1', 'pa3'].map(tabIcon), ['📊', '🚀', '🎙️'], 'ページのタブのアイコン');
  const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
  assert.strictEqual(S.declsFor(rules, '.tabitem[data-key^="page:"] .tt::before', { at: '' }).content, "attr(data-icon) '\\00a0'");
  // パンくず（祖先の段と今のページ）・ページの頭
  assert.deepStrictEqual($(l, 'crumb').querySelectorAll('.csi').map((e) => e.textContent), ['📊'], 'パンくずの祖先の段のアイコン');
  assert.strictEqual($(l, 'crumb').querySelector('.ci').textContent, '🚀', 'パンくずの今のページのアイコン');
  assert.strictEqual($(l, 'pIcon').textContent, '🚀', 'ページの頭のアイコン');
  // 白紙のページの本文の子ページの行（g1 はアイコン無し → 📄）
  const sub = $(l, 'pNote').querySelectorAll('.blk').find((e) => e._b && e._b.type === 'subpage');
  assert.ok(sub && sub._txt.textContent.startsWith('📄 '), '子ページの行のアイコン');
  // 議事録の子ページの一覧（pa2 の子 k1）
  await open(l, 'pa2');
  $(l, 'paneBtnNote').dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual($(l, 'pKids').querySelectorAll('.kidrow').map((e) => e.textContent.split(' ')[0]), ['🚀'], '議事録の子ページの一覧のアイコン');
  // 検索の結果の頭
  $(l, 'sideSearch').dispatchEvent({ type: 'click' }); await l.drain();
  const pal = new Map($(l, 'palList').querySelectorAll('.pitem').map((e) => [e.dataset.pid, e.querySelector('.pi').textContent]));
  assert.deepStrictEqual(['pa2', 'k1', 'g1', 'pa1', 'pa3', 'pa4'].map((id) => pal.get(id)), ['📊', '🚀', '📄', '🎙️', '🎙️', '🌸'], '検索の結果の頭のアイコン');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- 見た目
test('PL-3・F120: 「···」の［全幅］［小さい文字］［書体 ▸］・aria-checked・押すと pageSetLook の1回・#pageWrap に組が付く・ページを替えると外れる・サイドバーと設定には付かない', T, async () => {
  const l = await boot({ looks: { pa1: { font: 'mono' } } });
  await open(l, 'k1');
  const wrap = $(l, 'pageWrap');
  assert.deepStrictEqual(lookClass(wrap), []);
  openMenu(l);
  assert.deepStrictEqual(['全幅', '小さい文字'].map((x) => [item(l, x).getAttribute('role'), item(l, x).getAttribute('aria-checked')]), [['menuitemcheckbox', 'false'], ['menuitemcheckbox', 'false']]);
  assert.strictEqual(item(l, '書体 ▸').getAttribute('aria-expanded'), 'false');
  item(l, '全幅').dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(l.called('pageSetLook').map((c) => c.args), [['k1', { wide: true }]], '［全幅］で pageSetLook の1回でない');
  assert.deepStrictEqual(lookClass(wrap), ['look-wide']);
  openMenu(l);
  assert.strictEqual(item(l, '全幅').getAttribute('aria-checked'), 'true', `全幅の今の状態が出ない ${JSON.stringify(menuOf(l).map((b) => [b.textContent, b.getAttribute('aria-checked'), b.dataset.look]))} ${$(l, 'pMenu').hidden}`);
  // ［書体 ▸］→ 標準・明朝・等幅（menuitemradio。今は標準）→ 明朝
  item(l, '書体 ▸').focus();
  l.key({ key: 'ArrowRight' }, item(l, '書体 ▸'));
  assert.deepStrictEqual(['標準', '明朝', '等幅'].map((x) => [item(l, x).getAttribute('role'), item(l, x).getAttribute('aria-checked')]),
    [['menuitemradio', 'true'], ['menuitemradio', 'false'], ['menuitemradio', 'false']]);
  assert.ok(l.document.activeElement === item(l, '標準'), '［書体 ▸］を開いて今の書体へフォーカスしない');
  l.key({ key: 'ArrowLeft' }, item(l, '標準'));
  assert.ok(!item(l, '標準') && l.document.activeElement === item(l, '書体 ▸'), '← で［書体 ▸］へ戻らない');
  l.key({ key: 'Enter' }, item(l, '書体 ▸'));
  item(l, '明朝').dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(l.called('pageSetLook').pop().args, ['k1', { wide: true, font: 'serif' }]);
  assert.deepStrictEqual(lookClass(wrap), ['look-wide', 'look-serif']);
  openMenu(l);
  if (!item(l, '明朝')) l.key({ key: 'Enter' }, item(l, '書体 ▸'));
  assert.deepStrictEqual(['標準', '明朝', '等幅'].map((x) => item(l, x).getAttribute('aria-checked')), ['false', 'true', 'false'], '書体の今の状態が答えに合わない');
  l.key({ key: 'ArrowLeft' }, item(l, '明朝'));
  item(l, '小さい文字').dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(lookClass(wrap), ['look-wide', 'look-small', 'look-serif']);
  // 全幅を外す
  openMenu(l);
  item(l, '全幅').dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(lookClass(wrap), ['look-small', 'look-serif']);
  // ページを替えると外れて、そのページの見た目（pa1 は等幅）
  await open(l, 'pa1');
  assert.deepStrictEqual(lookClass(wrap), ['look-mono'], 'ページを替えても前のページの見た目が残る');
  await open(l, 'pa2');
  assert.deepStrictEqual(lookClass(wrap), []);
  await open(l, 'k1');
  assert.deepStrictEqual(lookClass(wrap), ['look-small', 'look-serif']);
  // サイドバー・設定・体には付かない
  for (const el of [l.document.body, $(l, 'side'), $(l, 'settingsModal'), $(l, 'tabbar')]) assert.deepStrictEqual(lookClass(el), [], el.id || el.tagName);
  // CSS は #pageWrap の組だけ（全幅は列の 720px を外す・書体は OS の書体）
  const rules = S.parse(parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
  const css = parseHTML(HTML).root.querySelectorAll('style').map((s) => s._raw).join('\n');
  for (const m of css.matchAll(/([^{}]*)\{[^{}]*\}/g)) {
    const sel = m[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (/look-(wide|small|serif|mono)/.test(sel)) for (const one of sel.split(',')) assert.match(one.trim(), /^#pageWrap\.look-(wide|small|serif|mono)\b/, `見た目の規則が #pageWrap の外にも効く: ${one}`);
  }
  assert.strictEqual(S.declsFor(rules, '#pageWrap.look-wide .pcol', { at: '' })['max-width'], 'none');
  assert.match(S.declsFor(rules, '#pageWrap.look-serif', { at: '' })['font-family'], /^"Yu Mincho", "BIZ UDMincho", "MS Mincho", serif$/);
  assert.match(S.declsFor(rules, '#pageWrap.look-mono', { at: '' })['font-family'], /^"BIZ UDGothic", "Cascadia Mono", Consolas, monospace$/);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PL-3・F120: 録音中のページ（記録中のタブ）に替えると見た目の組が外れる', T, async () => {
  const l = await boot({ looks: { pa1: { wide: true } } });
  await open(l, 'pa1');
  assert.deepStrictEqual(lookClass($(l, 'pageWrap')), ['look-wide']);
  l.fire('onMeetingUpdate', { active: true, phase: 'recording', pageId: 'plive1', startedAt: Date.now(), elapsedMs: 1000 }); await l.drain();
  l.document.getElementById('mtToggleBtn');
  const liveTab = $(l, 'tabbar').querySelectorAll('.tabitem').find((t) => t.dataset.key === 'live');
  if (liveTab) { liveTab.dispatchEvent({ type: 'click' }); await l.drain(); }
  assert.ok($(l, 'pageWrap').classList.contains('live-on'), '前提: 記録中のタブ');
  assert.deepStrictEqual(lookClass($(l, 'pageWrap')), [], '録音中のページに見た目が残る');
  assert.strictEqual($(l, 'pIcon').getAttribute('aria-disabled'), 'true', '録音中のページのアイコンが押せる形');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('PL-3・F120: 見た目とアイコンの答えを待つ間にほかのページや録音中のページ（記録中のタブ）へ替えても、答えで見た目の組やアイコンを付けない。待つ間に開いた「···」の今の状態は答えに合わせる', T, async () => {
  let done = null;
  let iconDone = null;
  const l = await boot({ returns: {
    pageSetLook: (id, look) => new Promise((res) => { done = () => res({ ...PAGE(id).page, look }); }),
    pageSetIcon: (id, icon) => new Promise((res) => { iconDone = () => res({ ...PAGE(id).page, icon }); }),
  } });
  // 答えを待つ間にほかのページ（pa2）へ替えると、pa2 に答えの見た目もアイコンも付けない（pa2 の curPage に答えを書かない）
  await open(l, 'pa1');
  openMenu(l);
  item(l, '全幅').dispatchEvent({ type: 'click' }); await l.drain();
  $(l, 'pIcon').dispatchEvent({ type: 'click' }); await l.drain();
  opts(l).find((b) => b.textContent === '📄').dispatchEvent({ type: 'click' }); await l.drain();
  await open(l, 'pa2');
  done(); iconDone(); await l.drain();
  assert.deepStrictEqual(lookClass($(l, 'pageWrap')), [], 'ほかのページに答えの見た目が付いた');
  assert.strictEqual($(l, 'pIcon').textContent, '📊', 'ほかのページの頭に答えのアイコンが出た');
  openMenu(l);
  assert.strictEqual(item(l, '全幅').getAttribute('aria-checked'), 'false', 'ほかのページの「···」に答えの状態が出た');
  $(l, 'pMore').dispatchEvent({ type: 'click' });
  await open(l, 'pa1');
  // 待つ間にメニューを開き直すと、答えが来たときに［全幅］の ✓ が付く
  openMenu(l);
  item(l, '全幅').dispatchEvent({ type: 'click' }); await l.drain();
  openMenu(l);
  assert.strictEqual(item(l, '全幅').getAttribute('aria-checked'), 'false');
  done(); await l.drain();
  assert.strictEqual(item(l, '全幅').getAttribute('aria-checked'), 'true', '待つ間に開いた「···」の今の状態が答えに合わない');
  assert.deepStrictEqual(lookClass($(l, 'pageWrap')), ['look-wide']);
  // ［小さい文字］の答えを待つ間に記録中のタブへ
  openMenu(l);
  item(l, '小さい文字').dispatchEvent({ type: 'click' }); await l.drain();
  l.fire('onMeetingUpdate', { active: true, phase: 'recording', pageId: 'plive1', startedAt: Date.now(), elapsedMs: 1000 }); await l.drain();
  const liveTab = $(l, 'tabbar').querySelectorAll('.tabitem').find((t) => t.dataset.key === 'live');
  if (liveTab) { liveTab.dispatchEvent({ type: 'click' }); await l.drain(); }
  assert.ok($(l, 'pageWrap').classList.contains('live-on'), '前提: 記録中のタブ');
  done(); await l.drain();
  assert.deepStrictEqual(lookClass($(l, 'pageWrap')), [], '録音中のページに答えの見た目が付いた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
