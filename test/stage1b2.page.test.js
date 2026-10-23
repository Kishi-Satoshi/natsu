/*
 * stage1b2.page.test.js — 第1b2回の上の帯（タブの帯・パンくず・「···」）とページ（アイコン・題名・プロパティ・会議のブロック・丸いタブ・札）
 */
'use strict';
const { titleAt } = require('./helpers/titles');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const { parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const html = fs.readFileSync(APP, 'utf8');
const rules = S.parse(parseHTML(html).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const LIST = [{ id: 'pa1', title: titleAt('2026-10-16T01:00:00.000Z'), date: '2026-10-16', durationSec: 1800, hasSummary: true }, { id: 'pb2', title: titleAt('2026-10-09T05:00:00.000Z'), date: '2026-10-15', durationSec: 900, hasSummary: false }];
// 出典は区間の id（renderCiteBadge は curSegs の s.id で引き、jumpToSegment は #seg-<id> を探す）
const BLOCKS = [{ id: 'b1', type: 'heading', text: '決まったこと' }, { id: 'b2', type: 'bullet', text: '出す日を決めた（見本）', cites: ['s1'] }];
const SEGS = [{ id: 's1', atMs: 75000, text: '出す日はこの日にしましょう（見本）' }];
const PAGE = (id) => ({ page: { id, title: LIST.find((p) => p.id === id).title, createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800,
  blocks: id === 'pa1' ? BLOCKS : [], memo: '', meetingType: 'general', citeStat: { linked: 1, total: 1 } }, segments: id === 'pa1' ? SEGS : [] });
const openPage = async (id = 'pa1') => {
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: () => LIST, pageGet: PAGE } });
  await l.drain();
  l.byId.get('plist').querySelectorAll('.pitem').find((r) => r.querySelector('.t').textContent === LIST.find((p) => p.id === id).title).dispatchEvent({ type: 'click' });
  await l.drain();
  return l;
};
const crumb = (l) => [l.byId.get('crumb').querySelector('.ci').textContent, l.byId.get('crumb').querySelector('.ct').textContent];

test('1b2 P-1・G6: 操作（#pActs）は上の帯（.pagebar）にあり、ページを開いているページのタブのときだけ出る。パンくずは選んでいるタブを追う', async () => {
  const l = await openPage('pa1');
  const acts = l.byId.get('pActs');
  assert.ok(acts.closest('.pagebar') && !acts.closest('#pageWrap'), '操作がページの中にある');
  assert.strictEqual(acts.hidden, false);
  assert.deepStrictEqual(crumb(l), ['🎙️', titleAt('2026-10-16T01:00:00.000Z')]);
  // 0.9.0 U-1（SP1・SP2・D24）で意図して変えた: 設定はタブでなくページの上のポップアップ。パンくずはページのまま、後ろ（.col）は inert で
  //［削除］は押せない（見えていないページを消さない）。閉じると戻る
  l.byId.get('tabBtnSettings').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(acts.closest('.col').inert, true, '設定のポップアップの後ろで［削除］が押せる（見えていないページを消す）');
  assert.deepStrictEqual(crumb(l), ['🎙️', titleAt('2026-10-16T01:00:00.000Z')]);
  l.key({ key: 'Escape' }); await l.drain();
  assert.ok(!acts.closest('.col').inert && acts.hidden === false);
  assert.strictEqual(S.declsFor(rules, '.pacts[hidden]', { at: '' }).display, 'none', '本物の画面で hidden が .pacts の display に負ける');
  l.byId.get('tabBtnDictation').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(acts.hidden, true);
  assert.deepStrictEqual(crumb(l), ['🎤', '音声入力']);
});

test('1b2 P-1・G6: 別のページのタブを読み込んでいる間は、操作（#pActs）を隠す（前のページの［削除］が押せない）', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: () => LIST, pageGet: (id) => (id === 'pb2' ? gate.then(() => PAGE(id)) : PAGE(id)) } });
  await l.drain();
  const row = (id) => l.byId.get('plist').querySelectorAll('.pitem').find((r) => r.querySelector('.t').textContent === LIST.find((p) => p.id === id).title);
  const acts = l.byId.get('pActs');
  row('pa1').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(acts.hidden, false);
  row('pb2').dispatchEvent({ type: 'click', ctrlKey: true }); await l.drain();
  assert.strictEqual(acts.hidden, true, '読み込み中の B のタブで A の［削除］が押せる');
  release(); await l.drain();
  assert.strictEqual(acts.hidden, false);
});

test('1b2 P-1: 要約のあるページは見えるボタンが「···」だけで、中は 要約を再生成・コピー・削除。無いページは［要約を生成］と「···」', async () => {
  const visible = (l) => l.byId.get('pActs').querySelectorAll('button').filter((b) => !b.closest('#pMenu')).map((b) => b.id || b.textContent);
  const menu = (l) => l.byId.get('pMenu').querySelectorAll('[role="menuitem"]').map((b) => b.textContent);
  const a = await openPage('pa1');
  // 0.10.0 L-1（D58）で意図して変えた: コピーと削除の間に［リンクを写す］
  assert.deepStrictEqual([visible(a), menu(a)], [['pMore'], ['要約を再生成', 'コピー', 'リンクを写す', '削除']]);
  const b = await openPage('pb2');
  assert.deepStrictEqual([visible(b), menu(b)], [['要約を生成', 'pMore'], ['コピー', 'リンクを写す', '削除']]);
});

test('1b2 P-1: タブの帯は 36px の灰色の帯で、選んでいるタブは白の地（灰色の強調ではない）。上の帯は 44px', () => {
  assert.strictEqual(S.declsFor(rules, '.topbar', { at: '' }).background, 'var(--side)');
  assert.strictEqual(S.declsFor(rules, '.tabitem.active', { at: '' }).background, 'var(--bg)');
  assert.strictEqual(S.declsFor(rules, '.pagebar', { at: '' }).height, '44px');
  assert.strictEqual(S.declsFor(rules, '#pMore', { at: '' }).width, '28px');
});

test('1b2 P-2: ページは箱を持たず、ページごと流れる（#pageWrap が巻く）。アイコン 78px・題名 40px／700／48px・プロパティ 34px＋4px・名前の列 160px', () => {
  const page = S.declsFor(rules, '.page', { at: '' });
  assert.ok(!page.border || /none/.test(page.border), `枠が残っている: ${page.border}`);
  assert.strictEqual(page['overflow-y'], 'auto');
  assert.ok(!/auto|scroll/.test(S.declsFor(rules, '.pbody', { at: '' })['overflow-y'] || ''), '本文だけが巻いている');
  const ic = S.declsFor(rules, '.picon', { at: '' });
  assert.deepStrictEqual([ic.width, ic.height], ['78px', '78px']);
  const t = S.declsFor(rules, '.ptitle', { at: '' });
  assert.deepStrictEqual([t['font-size'], t['font-weight'], t['line-height']], ['40px', '700', '48px']);
  const p = S.declsFor(rules, '.prop', { at: '' });
  assert.deepStrictEqual([p['min-height'], p['margin-bottom']], ['34px', '4px']);
  assert.strictEqual(S.declsFor(rules, '.prop .k', { at: '' }).width, '160px');
});

test('1b2 P-2: 要約・メモ・文字起こしは会議のブロック（線と角丸 10px）の中の丸いタブ。並びは AI 要約・メモ・文字起こし、選んでいるものは灰色の丸い地', async () => {
  const l = await openPage('pa1');
  const tabs = l.root.querySelectorAll('.ptabrow [role="tab"]');
  assert.deepStrictEqual(tabs.map((b) => [b.id, b.textContent]), [['paneBtnNote', 'AI 要約'], ['paneBtnMemo', 'メモ'], ['paneBtnScript', '文字起こし']]);
  assert.ok(l.byId.get('paneBtnNote').closest('.mblock') && l.byId.get('pBody').closest('.mblock'));
  const on = S.declsFor(rules, '.ptab.on', { at: '' });
  assert.strictEqual(on.background, 'var(--tint)');
  assert.ok(!on['border-bottom-color'] && !/solid/.test(on['border-bottom'] || ''), '下線が残っている');
  assert.strictEqual(S.declsFor(rules, '.ptab', { at: '' })['border-radius'], '14px');
  assert.strictEqual(S.declsFor(rules, '.mblock', { at: '' })['border-radius'], '10px');
});

test('1b2 P-2: ページのアイコンは 🎙️。何も開いていないときはアイコンと丸いタブを出さない（nopage）', async () => {
  const l = await openPage('pa1');
  assert.strictEqual(l.byId.get('pIcon').textContent, '🎙️');
  assert.ok(!l.byId.get('pageWrap').classList.contains('nopage'));
  l.root.querySelector('.tabitem .tx').dispatchEvent({ type: 'click' }); await l.drain();   // ただ1つのタブを × で閉じる
  assert.ok(l.byId.get('pageWrap').classList.contains('nopage'));
  assert.match(l.byId.get('pNote').textContent, /左の一覧から議事録を選んでください/);
  for (const sel of ['.nopage #pIcon', '.nopage .ptabrow']) assert.strictEqual(S.declsFor(rules, sel, { at: '' }).display, 'none', sel);
});

test('1b2 P-2・G9: プロパティの名前のアイコンは灰色（.ic）で、名前の欄の文字は今のまま（経路の行も）。水色の案内の帯は出ない', async () => {
  const l = await openPage('pa1');
  const rows = l.byId.get('pProps').querySelectorAll('.prop').map((r) => r.querySelector('.k'));
  assert.ok(rows.length && rows.every((k) => k.querySelector('.ic')), 'アイコンが .ic に包まれていない');
  assert.ok(rows.some((k) => k.textContent === '🔗 出典'), '名前の欄の文字が変わった');
  assert.strictEqual(l.byId.get('pNote').querySelector('.note.info'), null, '案内の帯が残っている');
  const cite = l.byId.get('pNote').querySelector('.cite');
  assert.match(cite.title, /押すと、根拠になった発言へ移動します/);
  const ic = S.declsFor(rules, '.ic', { at: '' });
  assert.match(ic.filter || '', /grayscale\(1\)/);
});

test('1b2 P-2・G13: 時刻と担当の札は灰色の小さな札（青い面・緑の文字をやめた）。札を押すと根拠の発言へ巻く', async () => {
  const c = S.declsFor(rules, '.cite', { at: '' });
  assert.deepStrictEqual([c.background, c.color, c['border-radius']], ['var(--hover)', 'var(--muted)', '4px']);
  assert.strictEqual(S.declsFor(rules, '.atag.who', { at: '' }).color, 'var(--text)');
  const l = await openPage('pa1');
  l.byId.get('pNote').querySelector('.cite').dispatchEvent({ type: 'click' }); await l.drain();   // jumpToSegment
  assert.strictEqual(l.byId.get('paneBtnScript').getAttribute('aria-selected'), 'true', '札で文字起こしへ移らない');
  assert.ok(l.byId.get('pScript').querySelector('.seg.hit'), '根拠の発言に印が付かない（scrollIntoView の前で止まった）');
});

// 計画の「←／→ の順は DOM の並び」を固定する（並びを入れ替えたのに矢印だけ前の並びで動かない）
test('1b2 P-2: 丸いタブの ←／→ は見えている並び（AI 要約 → メモ → 文字起こし）で移る', async () => {
  const l = await openPage('pa1');
  l.byId.get('paneBtnNote').dispatchEvent({ type: 'keydown', key: 'ArrowRight' }); await l.drain();
  assert.strictEqual(l.byId.get('paneBtnMemo').getAttribute('aria-selected'), 'true', '→ でメモへ移らない');
  l.byId.get('paneBtnMemo').dispatchEvent({ type: 'keydown', key: 'ArrowRight' }); await l.drain();
  assert.strictEqual(l.byId.get('paneBtnScript').getAttribute('aria-selected'), 'true', '→ で文字起こしへ移らない');
});
