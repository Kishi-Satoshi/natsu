/*
 * stage110.memo.app.test.js — 0.11.0 Task V-1（MT2・MT3・MT5・F10・F14・F25・F29・F30。決めたこと 2〜10・23・26。計画 docs/plans/2026-10-22-110.md）:
 * 会議の種類の行（名前・自動・群・メモの型・決まらなかったときの文）をページと録音中に・録音中の一言・録音中に選んだらメモのタブへ・手引き・
 * MQ2/MQ3・メモの flush・札・ToDo の「要確認」・サイドバーの title。最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。
 */
'use strict';
const { titleAt } = require('./helpers/titles');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const mtype = require('../src/meetingType');
const M = require('../src/memoTypes');
const lib = require('../src/mainlib');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const T1 = titleAt('2026-10-22T01:00:00.000Z');
const SEGS = [{ id: 's1', atMs: 0, durationMs: 5000, text: '来月の予算案は担当Aさんが進めます' }];
const base = { id: 'pa1', title: T1, date: '2026-10-22', createdAt: '2026-10-22T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', summaryError: '' };
const TYPES = () => lib.typesForView();
const MEMOS = () => M.listMemoTypes();
const BANTC = M.memoPreset('bantc');
const LABEL = (k) => M.MEMO_TYPES[k].label;

// 保存したページを開く。calls に IPC の呼び出しの順（[名前, ...引数]）。pageSetType は DB と同じ決まり（setTypePage）でページを直して返す
async function openPage(page, o = {}) {
  const calls = [];
  let cur = { ...base, ...page };
  const list = () => [{ id: cur.id, title: cur.title, date: cur.date, durationSec: cur.durationSec, hasSummary: Boolean(cur.blocks && cur.blocks.length), meetingType: mtype.normalizeType(cur.meetingType) }];
  const l = await load(APP, {
    preloadSrc: PRELOAD,
    returns: {
      meetingTypes: TYPES, memoTypes: MEMOS, pagesSearch: list, pagesList: list,
      pageGet: () => ({ page: JSON.parse(JSON.stringify(cur)), segments: SEGS }),
      pageSetMemo: (id, memo) => { calls.push(['pageSetMemo', id, memo]); cur = { ...cur, memo }; return { page: cur }; },
      pageSetType: (id, type, preset) => {
        calls.push(['pageSetType', id, type, preset]);
        const p = JSON.parse(JSON.stringify(cur));
        require('../src/db/commands').setTypePage(p, { type, preset }, new Date());
        cur = p;
        return JSON.parse(JSON.stringify(cur));   // DB の page.setType の答えは直した後のページ（reread）
      },
      ...(o.returns || {}),
    },
  });
  await l.drain();
  l.byId.get('plist').querySelectorAll('.pitem')[0].dispatchEvent({ type: 'click' });
  await l.drain();
  l.calls110 = calls;
  return l;
}
const $ = (l, id) => l.byId.get(id);
const choose = async (l, v) => { const s = $(l, 'pType'); s.value = v; await s.onchange(); await l.drain(); };
const opts = (l) => $(l, 'pType').children;
const guide = (l) => { const g = $(l, 'pMemo').querySelector('.memoguide'); return g && !g.hidden ? g.children.map((c) => c.textContent) : []; };
const memoTa = (l) => $(l, 'pMemo').querySelector('textarea');
const toastText = (l) => $(l, 'toast').textContent;

test('0.11.0 V-1（D43・D44・P12）: プルダウンの頭は「自動（文字起こしから判定）」、群（社内の会議・人と話す・社外と話す）の中の種類はこの並び。「一般・その他」はどこにも無い', T, async () => {
  const l = await openPage({ meetingType: 'sales', typeAuto: false, autoType: 'sales' });
  const o = opts(l);
  assert.deepStrictEqual([o[0].tagName, o[0].value, o[0].textContent], ['option', '', '自動（文字起こしから判定）']);
  const groups = o.slice(1);
  assert.deepStrictEqual(groups.map((g) => [g.tagName, g.getAttribute('label')]), mtype.GROUPS.map((g) => ['optgroup', g.label]));
  assert.deepStrictEqual(groups.map((g) => g.children.map((c) => c.value)), mtype.GROUPS.map((g) => [...g.keys]));
  assert.deepStrictEqual(groups.map((g) => g.children.map((c) => c.textContent)), mtype.GROUPS.map((g) => g.keys.map((k) => mtype.getLabel(k))));
  assert.strictEqual($(l, 'pType').value, 'sales');
  assert.ok(!$(l, 'pageWrap').textContent.includes('一般・その他'), '一般・その他がページにある');
  assert.ok(!$(l, 'plist').textContent.includes('一般・その他'));
  // 行の名前は「会議の種類」
  assert.ok($(l, 'pTypeRow').textContent.includes('会議の種類'));
  assert.strictEqual($(l, 'pType').getAttribute('aria-label'), '会議の種類');
  assert.ok(!$(l, 'pTypeRow').textContent.includes('要約タイプ'));
  assert.strictEqual($(l, 'pMemoType').textContent, `メモの型: ${LABEL('bantc')}`);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-1（P16・決めたこと 4・6）: 自動のページは「自動」を選んだ形で「自動判定: {名前}」と「メモの型: {名前}」。要約の前は「メモの型: 要約のときに決まります」', T, async () => {
  let l = await openPage({ meetingType: 'standup', typeAuto: true, autoType: 'standup' });
  assert.strictEqual($(l, 'pType').value, '');
  assert.ok($(l, 'pTypeHint').textContent.startsWith(`自動判定: ${mtype.getLabel('standup')}`), $(l, 'pTypeHint').textContent);
  assert.strictEqual($(l, 'pMemoType').textContent, `メモの型: ${LABEL('report')}`);
  l = await openPage({});
  assert.strictEqual($(l, 'pType').value, '');
  assert.strictEqual($(l, 'pMemoType').textContent, 'メモの型: 要約のときに決まります');
  assert.ok(!$(l, 'pTypeRow').textContent.includes('自動判定'), $(l, 'pTypeRow').textContent);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-1（P12・R4・F29）: 前の版の一般・その他のページ（自動でも手で選んだものでも）は「自動」と決まらなかった文・メモの型は会議の要点。開いただけでは pageSetType を呼ばない', T, async () => {
  for (const typeAuto of [true, false]) {
    const l = await openPage({ meetingType: 'general', typeAuto, autoType: 'general', blocks: [{ id: 'b1', type: 'bullet', text: '要点', cites: ['s1'] }] });
    assert.strictEqual($(l, 'pType').value, '');
    assert.ok($(l, 'pTypeHint').textContent.startsWith(mtype.AUTO_UNDECIDED_TEXT), $(l, 'pTypeHint').textContent);
    assert.strictEqual($(l, 'pMemoType').textContent, `メモの型: ${LABEL('points')}`);
    assert.ok(!$(l, 'pageWrap').textContent.includes('一般・その他'));
    assert.ok(!l.calls.some((c) => c.method === 'pageSetType'), '開いただけで種類を書いた');
    assert.deepStrictEqual(l.errors.map(fmt), []);
  }
});

test('0.11.0 V-1（決めたこと 8・9・P18 (a)）: 空のメモで商談を選ぶと pageSetType(id, sales, true) が1回、メモは BANTC の雛形、手引きが5行、MQ2。タブは替わらない。メモに1文字書くと手引きが隠れる', T, async () => {
  const l = await openPage({ meetingType: 'standup', typeAuto: true, autoType: 'standup', blocks: [{ id: 'b1', type: 'bullet', text: '要点', cites: ['s1'] }] });
  await choose(l, 'sales');
  assert.deepStrictEqual(l.calls110.filter((c) => c[0] === 'pageSetType'), [['pageSetType', 'pa1', 'sales', true]]);
  assert.strictEqual(memoTa(l).value, BANTC);
  const heads = M.MEMO_TYPES.bantc.headings;
  assert.deepStrictEqual(guide(l), heads.map((h) => `■ ${h.name} ── ${h.hint}`));
  assert.strictEqual(guide(l).length, 5);
  assert.strictEqual(toastText(l), `メモに「${LABEL('bantc')}」の見出しを入れました（［要約を再生成］で要約にも反映されます）`);
  assert.strictEqual($(l, 'paneBtnNote').getAttribute('aria-selected'), 'true', '保存したページでタブを替えた');
  assert.strictEqual($(l, 'pMemoType').textContent, `メモの型: ${LABEL('bantc')}`);
  const ta = memoTa(l);
  ta.value = `${BANTC}予`;
  ta.oninput();
  await l.drain();
  assert.deepStrictEqual(guide(l), [], '人の文が入っても手引きが出ている');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-1（MQ2・要約の無いページ）: 要約の無いページで見出しを入れたときは後ろの一言が無い', T, async () => {
  const l = await openPage({});
  await choose(l, 'interview');
  assert.strictEqual(toastText(l), `メモに「${LABEL('star')}」の見出しを入れました`);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-1（F14・MQ3）: 人の文のメモで種類を替えると MQ3 でメモ欄は1文字も変わらない（要約の有無で後ろが違う）', T, async () => {
  let l = await openPage({ memo: '予算の相談をする', blocks: [{ id: 'b1', type: 'bullet', text: '要点', cites: ['s1'] }] });
  await choose(l, 'sales');
  assert.strictEqual(memoTa(l).value, '予算の相談をする');
  assert.strictEqual(toastText(l), `メモに書いた内容はそのまま残しました。要約は「${LABEL('bantc')}」の見出しで作ります（［要約を再生成］で反映されます）`);
  assert.deepStrictEqual(guide(l), []);
  l = await openPage({ memo: '予算の相談をする' });
  await choose(l, 'sales');
  assert.strictEqual(toastText(l), `メモに書いた内容はそのまま残しました。要約は「${LABEL('bantc')}」の見出しで作ります（［要約を生成］で使います）`);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-1（決めたこと 8）: メモを書いて 500ms たたないうちに種類を替えると、pageSetMemo（人の文）の後に pageSetType を呼ぶ', T, async () => {
  const l = await openPage({});
  const ta = memoTa(l);
  ta.value = '見積の話';
  ta.oninput();
  await choose(l, 'sales');
  const order = l.calls110.map((c) => c[0]);
  assert.deepStrictEqual(order, ['pageSetMemo', 'pageSetType'], JSON.stringify(l.calls110));
  assert.strictEqual(l.calls110[0][2], '見積の話');
  assert.strictEqual(memoTa(l).value, '見積の話', '人の文を雛形で上書きした');
  await l.clock.advance(1000);
  assert.strictEqual(l.calls110.filter((c) => c[0] === 'pageSetMemo').length, 1, '待っていた保存を2回送った');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-1（P16）: 「自動」に戻すと pageSetType(id, auto)。メモは変えない', T, async () => {
  const l = await openPage({ meetingType: 'sales', typeAuto: false, autoType: 'sales', memo: BANTC });
  await choose(l, '');
  assert.deepStrictEqual(l.calls110.map((c) => c.slice(0, 3)), [['pageSetType', 'pa1', 'auto']]);
  assert.strictEqual(memoTa(l).value, BANTC);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- 録音中のページ（決めたこと 10・P10・P17・R3）
const LIVE = (o = {}) => ({ active: true, startedAt: Date.now() - 60000, segments: [{ id: 's1', atMs: 0, text: '本日の議題です。' }], pauses: [], cloud: true, memo: '',
  stt: { route: 'cloud', lastTextAt: Date.now() - 5000, segSec: 15, problem: null }, ...o });
async function openLive(o = {}) {
  const calls = [];
  let memo = o.memo || '';
  const l = await load(APP, {
    preloadSrc: PRELOAD,
    returns: {
      meetingTypes: TYPES, memoTypes: MEMOS,
      meetingSetMemo: (m) => { calls.push(['meetingSetMemo', m]); memo = m; return { ok: true }; },
      meetingSetType: (key) => {
        calls.push(['meetingSetType', key]);
        let inserted = false;
        if (key !== 'auto' && M.isUntouchedMemo(memo, mtype.listTypes().map((t) => t.agenda).filter(Boolean))) { memo = M.memoPreset(M.memoTypeOf(key)); inserted = true; }
        return { ok: true, memo, inserted, meetingType: key === 'auto' ? null : key };
      },
    },
  });
  await l.drain();
  l.fire('onMeetingUpdate', LIVE({ memo }));
  await l.drain();
  l.calls110 = calls;
  return l;
}
const LIVE_HINT = '会議の種類を選ぶと、メモに見出しが入ります';
const liveHint = (l) => { const n = $(l, 'pTypeLiveHint'); return n && !n.hidden ? n.textContent : ''; };

test('0.11.0 V-1（決めたこと 10・P10）: 録音中のページにも種類の行（初めは「自動」）と一言。行は題名の下・録音の操作の行の上', T, async () => {
  const l = await openLive();
  assert.notStrictEqual($(l, 'pTypeRow').style.display, 'none');
  assert.strictEqual($(l, 'pType').value, '');
  assert.strictEqual(liveHint(l), LIVE_HINT);
  assert.strictEqual($(l, 'pMemoType').textContent, 'メモの型: 要約のときに決まります');
  const kids = $(l, 'pTypeRow').parentNode.children;
  const row = kids.indexOf($(l, 'pTypeRow'));
  assert.ok(row > kids.indexOf($(l, 'pTitle')), '種類の行が題名より上');
  const bar = $(l, 'liveBar');
  if (bar && bar.parentNode === $(l, 'pTypeRow').parentNode) assert.ok(kids.indexOf(bar) > row, '種類の行が録音の操作の行より下');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-1（P17・R3）: 録音中に商談を選ぶと、待っていたメモを送ってから meetingSetType。メモのタブに替わり、見出しを入れたので知らせは無く、焦点は種類の欄のまま。一言は消える', T, async () => {
  const l = await openLive();
  const ta = memoTa(l);
  assert.strictEqual($(l, 'paneBtnScript').getAttribute('aria-selected'), 'true');
  const sel = $(l, 'pType');
  sel.focus();
  const toastBefore = toastText(l);
  await choose(l, 'sales');
  assert.deepStrictEqual(l.calls110.map((c) => c[0]), ['meetingSetMemo', 'meetingSetType']);
  assert.strictEqual(memoTa(l), ta, 'メモ欄を作り直した');
  assert.strictEqual(ta.value, BANTC);
  assert.strictEqual($(l, 'paneBtnMemo').getAttribute('aria-selected'), 'true', 'メモのタブに替わらない');
  assert.ok($(l, 'pMemo').classList.contains('active'));
  assert.strictEqual(toastText(l), toastBefore, '見出しを入れたのに知らせを出した');
  assert.strictEqual(l.document.activeElement, sel, '焦点が種類の欄から動いた');
  assert.strictEqual(liveHint(l), '');
  assert.deepStrictEqual(guide(l).length, 5);
  // 区間が届いて描き直しても、行と手引きとメモ欄は作り直さず、メモのタブのまま
  const g = $(l, 'pMemo').querySelector('.memoguide');
  l.fire('onMeetingUpdate', LIVE({ memo: BANTC, segments: [{ id: 's1', atMs: 0, text: '本日の議題です。' }, { id: 's2', atMs: 15000, text: '次です。' }] }));
  await l.drain();
  assert.strictEqual(memoTa(l), ta);
  assert.strictEqual($(l, 'pMemo').querySelector('.memoguide'), g);
  assert.strictEqual($(l, 'pType').value, 'sales');
  assert.strictEqual($(l, 'paneBtnMemo').getAttribute('aria-selected'), 'true', '区間が届いて文字起こしのタブへ戻った');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-1（R3）: 録音中に人の文のメモで選ぶと、メモは変えず短い知らせ。「自動」に戻してもタブは替わらない', T, async () => {
  const l = await openLive();
  const ta = memoTa(l);
  ta.value = '予算の相談';
  ta.oninput();
  await l.drain();
  assert.strictEqual(liveHint(l), '', 'メモに書いても一言が消えない');
  await choose(l, 'sales');
  assert.deepStrictEqual(l.calls110.map((c) => c.slice(0, 2)), [['meetingSetMemo', '予算の相談'], ['meetingSetType', 'sales']]);
  assert.strictEqual(ta.value, '予算の相談');
  assert.strictEqual(toastText(l), `書いたメモはそのまま残しました（要約のときに「${LABEL('bantc')}」の見出しを使います）`);
  $(l, 'paneBtnScript').click();
  await choose(l, '');
  assert.deepStrictEqual(l.calls110.pop(), ['meetingSetType', 'auto']);
  assert.strictEqual($(l, 'paneBtnScript').getAttribute('aria-selected'), 'true', '「自動」に戻したのにタブを替えた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- 札（決めたこと 23・26）
test('0.11.0 V-1（決めたこと 23・F10）: 印の札。memo は「メモより」、check・advice は札なし（どれも「手書き」でない）。印の無い manual は「手書き」', T, async () => {
  const blocks = [
    { id: 'b1', type: 'bullet', text: '予算は 300 万円（メモより）', cites: [], citeState: 'manual', mark: 'memo' },
    { id: 'b2', type: 'bullet', text: '未確認: 予算（B）', cites: [], citeState: 'manual', mark: 'check', unconfirmed: true },
    { id: 'b3', type: 'bullet', text: '次は時間を決めてから話す', cites: [], citeState: 'manual', mark: 'advice' },
    { id: 'b4', type: 'bullet', text: '自分で足した行', cites: [], citeState: 'manual' },
  ];
  const l = await openPage({ blocks });
  const badge = (id) => { const b = $(l, 'pNote').querySelectorAll('.blk').find((e) => e.dataset.id === id || e.getAttribute('data-id') === id); const n = b && b.querySelector('.nocite'); return n ? n.textContent : ''; };
  assert.deepStrictEqual(['b1', 'b2', 'b3', 'b4'].map(badge), ['メモより', '', '', '手書き']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-1（決めたこと 26）: 担当と期限の無い ToDo の札は「担当: 要確認」「期限: 要確認」で、押すと今どおり入れられる。データに要確認と書かない', T, async () => {
  const blocks = [{ id: 'b1', type: 'todo', text: '見積を送る', checked: false, assignee: '', dueRaw: '', due: '', cites: ['s1'] }];
  const set = [];
  const l = await openPage({ blocks }, { returns: { blockSetAction: (...a) => { set.push(a); return { ok: true }; } } });
  const tags = $(l, 'pNote').querySelectorAll('.atag');
  assert.deepStrictEqual(tags.map((t) => t.textContent), ['担当: 要確認', '期限: 要確認']);
  // 押すと今どおり入れられる（editTag の欄。最小 DOM に replaceWith が無いので、押したときの働きがあることと title を見る）
  assert.ok(tags.every((t) => typeof t.onclick === 'function'), '押しても入れられない');
  assert.deepStrictEqual(tags.map((t) => t.title), ['担当者を設定', '期限を設定（「来週金曜」「8/30」などで入力できます）']);
  assert.ok(!set.some((a) => a.includes('要確認')), 'データに要確認と書いた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-1（P12）: サイドバーの行の title の種類は選べる鍵のときだけ（決まらなかった・前の版の一般・その他は出さない）', T, async () => {
  const LIST = [
    { id: 'pa1', title: T1, date: '2026-10-22', durationSec: 60, hasSummary: true, meetingType: 'sales' },
    { id: 'pa2', title: titleAt('2026-10-21T01:00:00.000Z'), date: '2026-10-21', durationSec: 60, hasSummary: true, meetingType: '' },
    { id: 'pa3', title: titleAt('2026-10-20T01:00:00.000Z'), date: '2026-10-20', durationSec: 60, hasSummary: true, meetingType: 'general' },
  ];
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { meetingTypes: TYPES, memoTypes: MEMOS, pagesSearch: () => LIST, pagesList: () => LIST } });
  await l.drain();
  const titles = $(l, 'plist').querySelectorAll('.pitem').map((r) => r.title || r.getAttribute('title'));
  assert.ok(titles[0].endsWith(mtype.getLabel('sales')), titles[0]);
  assert.ok(!/general|一般|自動/.test(titles[1]) && !/general|一般|自動/.test(titles[2]), JSON.stringify(titles));
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
