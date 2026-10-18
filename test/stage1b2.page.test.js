/*
 * stage1b2.page.test.js — 第1b2回の上の帯（タブの帯・パンくず・「···」）とページ（アイコン・題名・プロパティ・会議のブロック・丸いタブ・札）
 */
'use strict';
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
const LIST = [{ id: 'pa1', title: '定例（見本）', date: '2026-10-16', durationSec: 1800, hasSummary: true }, { id: 'pb2', title: '設計の打ち合わせ（見本）', date: '2026-10-15', durationSec: 900, hasSummary: false }];
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
  assert.deepStrictEqual(crumb(l), ['🎙️', '定例（見本）']);
  l.byId.get('tabBtnSettings').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(acts.hidden, true, '設定のタブで［削除］が押せる（見えていないページを消す）');
  assert.strictEqual(S.declsFor(rules, '.pacts[hidden]', { at: '' }).display, 'none', '本物の画面で hidden が .pacts の display に負ける');
  assert.deepStrictEqual(crumb(l), ['⚙️', '設定']);
  l.byId.get('tabBtnDictation').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(acts.hidden, true);
  assert.deepStrictEqual(crumb(l), ['🎤', '音声入力']);
});

test('1b2 P-1: 要約のあるページは見えるボタンが「···」だけで、中は 要約を再生成・コピー・削除。無いページは［要約を生成］と「···」', async () => {
  const visible = (l) => l.byId.get('pActs').querySelectorAll('button').filter((b) => !b.closest('#pMenu')).map((b) => b.id || b.textContent);
  const menu = (l) => l.byId.get('pMenu').querySelectorAll('[role="menuitem"]').map((b) => b.textContent);
  const a = await openPage('pa1');
  assert.deepStrictEqual([visible(a), menu(a)], [['pMore'], ['要約を再生成', 'コピー', '削除']]);
  const b = await openPage('pb2');
  assert.deepStrictEqual([visible(b), menu(b)], [['要約を生成', 'pMore'], ['コピー', '削除']]);
});

test('1b2 P-1: タブの帯は 36px の灰色の帯で、選んでいるタブは白の地（灰色の強調ではない）。上の帯は 44px', () => {
  assert.strictEqual(S.declsFor(rules, '.topbar', { at: '' }).background, 'var(--side)');
  assert.strictEqual(S.declsFor(rules, '.tabitem.active', { at: '' }).background, 'var(--bg)');
  assert.strictEqual(S.declsFor(rules, '.pagebar', { at: '' }).height, '44px');
  assert.strictEqual(S.declsFor(rules, '#pMore', { at: '' }).width, '28px');
});
