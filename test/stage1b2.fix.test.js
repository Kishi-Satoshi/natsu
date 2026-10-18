/*
 * stage1b2.fix.test.js — 第1b2回の画面の直し（CI の画面の写しで見つけた崩れと、2,000 ブロックのページを開く速さ）
 *
 * 偽 DOM は hidden しか見ず、CSS の display・padding・content-visibility を描かないので、ここは CSS の規則を読んで確かめる。
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

const LIST = [{ id: 'pa1', title: '定例（見本）', date: '2026-10-16', durationSec: 1800, hasSummary: true },
  { id: 'pc3', title: '振り返り（見本）', date: '2026-10-14', durationSec: 600, hasSummary: false, meetingType: 'standup' }];
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
