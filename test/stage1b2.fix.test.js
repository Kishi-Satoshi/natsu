/*
 * stage1b2.fix.test.js — 第1b2回の画面の直し（CI の画面の写しで見つけた崩れと、2,000 ブロックのページを開く速さ）
 *
 * 偽 DOM は hidden しか見ず、CSS の display・padding・content-visibility を描かないので、ここは CSS の規則を読んで確かめる。
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
const doc = parseHTML(html).root;
const rules = S.parse(doc.querySelectorAll('style').map((s) => s._raw).join('\n'));
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const px = (v) => { const m = /^(-?\d+(?:\.\d+)?)(px)?$/.exec(String(v || '').trim()); return m ? Number(m[1]) : NaN; };

test('1b2 直し: hidden の要素は CSS の display に負けない（[hidden] は display: none !important）。サイドバーを開いている間に » が出ない', () => {
  // .side-btn { display: inline-flex } が UA の [hidden] { display: none } に勝ち、#sideExpand（»）がサイドバーを開いている間も見えていた
  assert.strictEqual(S.declsFor(rules, '[hidden]', { at: '' }).display, 'none !important', '[hidden] の規則が無いか、!important が無い');
  assert.ok(/inline-flex/.test(S.declsFor(rules, '.side-btn', { at: '' }).display || ''), '前提: .side-btn が display を書く（だから hidden が負けていた）');
  assert.ok(doc.querySelector('#sideExpand').hasAttribute('hidden'), '前提: » は hidden で始まる');
  // !important の display をほかの規則に書くと、[hidden] に勝ててしまう
  const strong = rules.filter((r) => r.sel !== '[hidden]' && /!important/.test(r.decls.display || '')).map((r) => r.sel);
  assert.deepStrictEqual(strong, [], `display に !important を書いた規則が [hidden] に勝つ: ${strong.join(' / ')}`);
});

test('1b2 直し: 記録の行のボタン（.live button.ghost）は上下の余白 0（高さ 28px・行の高さ 26px のボタンで文字が下に押し出されない）', () => {
  const base = S.declsFor(rules, 'button.ghost', { at: '' });
  assert.deepStrictEqual([base.height, base['line-height']], ['28px', '26px']);
  // 高さと行の高さを決めたボタンに上下の余白を足す規則は、どれも文字を下へ押し出す
  for (const r of rules) {
    if (!r.sel.split(',').some((s) => /button\.(ghost|action)$/.test(s.trim()))) continue;
    if (r.decls.height || r.decls['line-height']) continue;
    const pad = r.decls.padding ? r.decls.padding.split(/\s+/) : [];
    const top = r.decls['padding-top'] || pad[0];
    const bottom = r.decls['padding-bottom'] || pad[2] || pad[0];
    for (const v of [top, bottom]) if (v !== undefined) assert.strictEqual(px(v), 0, `${r.at || ''} ${r.sel} の上下の余白が ${v}`);
  }
  assert.strictEqual(S.declsFor(rules, '.live button.ghost', { at: '' }).padding, '0 10px');
});

const LIST = [{ id: 'pa1', title: titleAt('2026-10-16T01:00:00.000Z'), date: '2026-10-16', durationSec: 1800, hasSummary: true },
  { id: 'pc3', title: titleAt('2026-10-01T08:00:00.000Z'), date: '2026-10-14', durationSec: 600, hasSummary: false, meetingType: 'standup' }];
const TYPES = [{ key: 'general', label: '一般・その他' }, { key: 'standup', label: '定例・進捗報告' }];
const ST = (o = {}) => ({ active: true, finalizing: false, startedAt: Date.now() - 60000, segments: [{ atMs: 0, text: '始めます（見本）' }], pending: 0, pauses: [], cloud: true, ...o });
const row = (el) => [el.querySelector('.ic') ? el.querySelector('.ic').textContent : null, el.childNodes.filter((n) => n.tagName === '#text').map((n) => n.textContent).join('')];

test('1b2 直し: サイドバーの［＋ 新しい議事録］［■ 終了して作成］［破棄］もアイコンの欄（.ic）を持ち、文字がほかの行とそろう', async () => {
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: () => LIST, meetingTypes: () => TYPES } });
  await l.drain();
  const tog = l.byId.get('mtToggleBtn'), dis = l.byId.get('mtDiscardBtn');
  assert.deepStrictEqual(row(l.byId.get('sideSearch')), ['🔍', '検索'], '前提: ほかの行はアイコンの欄と文字');
  assert.deepStrictEqual(row(tog), ['＋', '新しい議事録']);
  assert.deepStrictEqual(row(dis), ['🗑️', '破棄']);
  l.fire('onMeetingUpdate', ST()); await l.drain();
  assert.deepStrictEqual(row(tog), ['■', '終了して作成']);
  l.fire('onMeetingUpdate', ST({ finalizing: true })); await l.drain();
  assert.deepStrictEqual(row(tog), ['■', '作成中…']);
  l.fire('onMeetingUpdate', ST({ active: false })); await l.drain();
  assert.deepStrictEqual(row(tog), ['＋', '新しい議事録']);
});

test('1b2 直し: 検索の窓の結果の2行目は灰色の文字だけ（赤い「要約なし」・青いタイプの札を出さない）。並びはサイドバーの行の title と同じ', async () => {
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: () => LIST, meetingTypes: () => TYPES } });
  await l.drain();
  l.byId.get('sideSearch').dispatchEvent({ type: 'click' }); await l.drain();
  const rows = l.byId.get('palList').querySelectorAll('.pitem');
  assert.strictEqual(rows.length, 2);
  const m = rows[1].querySelector('.m');
  assert.strictEqual(m.textContent, '2026-10-14 ・ 10分0秒 ・ 要約なし ・ 定例・進捗報告');
  assert.ok(!m.querySelector('.tbadge'), 'タイプの札（青）が残っている');
  const colored = [m, ...m.querySelectorAll('*')].filter((e) => e.style && e.style.color);
  assert.deepStrictEqual(colored.map((e) => e.style.color), [], '2行目に色を付けた文字がある');
  assert.strictEqual(rows[0].querySelector('.m').textContent, '2026-10-16 ・ 30分0秒');
  assert.strictEqual(S.declsFor(rules, '.pitem .m', { at: '' }).color, 'var(--muted)');
});

test('1b2 直し（開く速さ）: 出典の札を描くのに、ブロックごとに文字起こしの区間を頭から探さない（2,000 ブロック・1万区間で数百万回の比べになる）', async () => {
  let scans = 0;
  const segs = Array.from({ length: 50 }, (_, i) => ({ id: `s${i + 1}`, atMs: i * 1000, text: `${i + 1} 行目の発言（見本）` }));
  Object.defineProperty(segs, 'findIndex', { value(...a) { scans += 1; return Array.prototype.findIndex.apply(this, a); } });
  Object.defineProperty(segs, 'find', { value(...a) { scans += 1; return Array.prototype.find.apply(this, a); } });
  const blocks = Array.from({ length: 30 }, (_, i) => ({ id: `b${i + 1}`, type: 'bullet', text: `${i + 1} 番目の要点（見本）`, cites: [`s${50 - i}`, `s${i + 1}`] }));
  const page = { id: 'pa1', title: titleAt('2026-10-16T01:00:00.000Z'), createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks, memo: '', meetingType: 'general', citeStat: { linked: 30, total: 30 } };
  // 2つ目のページ（pc3）は同じ id の区間が別の時刻にある（区間の並びの写しを、前のページのまま使い回さない）。s1 は2つあり、前の方を引く
  const segsB = [{ id: 's9', atMs: 600000, text: 'B の発言（見本）' }, { id: 's1', atMs: 300000, text: 'B の発言（見本）' }, { id: 's1', atMs: 900000, text: '同じ id（見本）' }];
  const pageB = { ...page, id: 'pc3', title: titleAt('2026-10-01T08:00:00.000Z'), blocks: [{ id: 'b1', type: 'bullet', text: 'B の要点（見本）', cites: ['s1', 's9', 's50'] }] };
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { pagesSearch: () => LIST, pageGet: (id) => (id === 'pc3' ? { page: pageB, segments: segsB } : { page, segments: segs }), meetingTypes: () => TYPES } });
  await l.drain();
  const open = async (title) => { l.byId.get('plist').querySelectorAll('.pitem').find((r) => r.querySelector('.t').textContent === title).dispatchEvent({ type: 'click' }); await l.drain(); };
  await open(titleAt('2026-10-16T01:00:00.000Z'));
  const els = l.byId.get('pNote').querySelectorAll('.blk');
  assert.strictEqual(els.length, 30);
  assert.ok(scans <= 2, `区間を ${scans} 回探した（ブロックの数だけ探している）`);
  // 札は今どおり発言の時系列で、時刻を出す（b1 は s50 と s1 → 0:00・0:49 の順）
  assert.deepStrictEqual(els[0].querySelectorAll('.cite').map((c) => c.textContent), ['0:00', '0:49']);
  assert.deepStrictEqual(els[29].querySelectorAll('.cite').map((c) => c.textContent), ['0:20', '0:29']);
  await open(titleAt('2026-10-01T08:00:00.000Z'));
  assert.deepStrictEqual(l.byId.get('pNote').querySelector('.blk').querySelectorAll('.cite').map((c) => c.textContent), ['?', '10:00', '5:00'],
    '別のページで前のページの区間の位置を使った（s50 は B に無いので ?、s9 → s1 の順）');
});

test('1b2 直し（開く速さ）: 画面の外のブロックは描かない（content-visibility: auto）。見積もりは本文1行、切る線はボタンの Tab の輪の外', () => {
  const b = S.declsFor(rules, '.blk', { at: '' });
  assert.strictEqual(b['content-visibility'], 'auto');
  assert.strictEqual(b['contain-intrinsic-size'], 'auto 30px', '見積もりが本文1行（16px の文字・24px の行・上下 3px）と違う');
  // content-visibility は中身を枠で切る（paint の封じ込め）。ボタンの輪（線＋離れ）がはみ出す分より外で切る
  const ring = S.declsFor(rules, 'button:focus-visible', { at: '' });
  const reach = px(ring.outline.split(/\s+/)[0]) + px(ring['outline-offset']);
  assert.ok(reach > 0, `輪のはみ出しを読めない: ${ring.outline} / ${ring['outline-offset']}`);
  assert.ok(px(b['overflow-clip-margin']) >= reach, `切る線（overflow-clip-margin: ${b['overflow-clip-margin']}）が輪（${reach}px）より内側`);
});
