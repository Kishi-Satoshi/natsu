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
// 要素どうしは assert.ok(a === b) で比べる（strictEqual だと赤のときに報告が最小 DOM の木を丸ごと書き出し、写しで数 GB の記憶を使う: R22）

// 0.11.0 V-5（持ち主の画面の確かめ。決めたこと 2 を改める）で意図して変えた: 群の見出し（<optgroup>）は無い。並びはそのまま
const SEL_VIEW = () => [['', '自動（文字起こしから判定）'], ...mtype.SELECTABLE.map((k) => [k, mtype.getLabel(k)])];
const optView = (l) => opts(l).map((o) => [o.tagName, o.value, o.textContent]);
test('0.11.0 V-1・V-5（D43・P12）: プルダウンは「自動（文字起こしから判定）」の後に選べる種類が SELECTABLE の順でちょうど7つ。群の見出し（社内の会議・人と話す・社外と話す）も「一般・その他」もどこにも無い', T, async () => {
  const l = await openPage({ meetingType: 'sales', typeAuto: false, autoType: 'sales' });
  assert.deepStrictEqual(optView(l), SEL_VIEW().map(([v, t]) => ['option', v, t]));
  assert.strictEqual(opts(l).length, 8);
  assert.deepStrictEqual($(l, 'pType').querySelectorAll('optgroup').length, 0, '群の見出しがある');
  for (const w of ['社内の会議', '人と話す', '社外と話す']) assert.ok(!$(l, 'pageWrap').textContent.includes(w), `群の名前「${w}」がある`);
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

test('0.11.0 V-5: main が前の形（groups のある答え）を返しても、見出しを作らずに SELECTABLE の順で並べる。typesForView の答えに groups は無い', T, async () => {
  assert.deepStrictEqual(Object.keys(lib.typesForView()), ['types', 'selectable']);
  const old = { ...lib.typesForView(), groups: [{ label: '社内の会議', keys: ['brainstorm', 'standup', 'review'] }, { label: '人と話す', keys: ['oneonone', 'interview'] }, { label: '社外と話す', keys: ['sales', 'present'] }] };
  const l = await openPage({ meetingType: 'sales', typeAuto: false, autoType: 'sales' }, { returns: { meetingTypes: () => old } });
  assert.deepStrictEqual(optView(l), SEL_VIEW().map(([v, t]) => ['option', v, t]));
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
  // 0.11.0 V-5: 録音中の欄も同じ項目（群の見出しは無い）
  assert.deepStrictEqual(optView(l), SEL_VIEW().map(([v, t]) => ['option', v, t]));
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
  assert.ok(memoTa(l) === ta, 'メモ欄を作り直した');
  assert.strictEqual(ta.value, BANTC);
  assert.strictEqual($(l, 'paneBtnMemo').getAttribute('aria-selected'), 'true', 'メモのタブに替わらない');
  assert.ok($(l, 'pMemo').classList.contains('active'));
  assert.strictEqual(toastText(l), toastBefore, '見出しを入れたのに知らせを出した');
  assert.ok(l.document.activeElement === sel, '焦点が種類の欄から動いた');
  assert.strictEqual(liveHint(l), '');
  assert.deepStrictEqual(guide(l).length, 5);
  // 区間が届いて描き直しても、行と手引きとメモ欄は作り直さず、メモのタブのまま
  const g = $(l, 'pMemo').querySelector('.memoguide');
  l.fire('onMeetingUpdate', LIVE({ memo: BANTC, segments: [{ id: 's1', atMs: 0, text: '本日の議題です。' }, { id: 's2', atMs: 15000, text: '次です。' }] }));
  await l.drain();
  assert.ok(memoTa(l) === ta, 'メモ欄を作り直した');
  assert.ok($(l, 'pMemo').querySelector('.memoguide') === g, '手引きを作り直した');
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

// ---------------------------------------------------------------- 0.11.0 V-2（D48・D49・F24・F26・QM4・QM7。決めたこと 27・28）
const HB = (id, text) => ({ id, type: 'heading', text });
const BB = (id, text, o = {}) => ({ id, type: 'bullet', text, cites: ['s1'], ...o });
const SAVED = [
  HB('h1', '課題・要望（N）'), BB('n1', '在庫の管理を楽にしたい'),
  HB('h3', '決定事項'), BB('d1', '来月に試す'),
  HB('h4', '持ち越し'), BB('c1', '価格は次回'),
  HB('h6', '抜け・重なりチェック'), BB('k1', '未確認: 予算（B）', { cites: [], citeState: 'manual', mark: 'check', unconfirmed: true }),
  HB('h7', '次に気をつけること'), BB('a1', '次は時間を決めてから話す', { cites: [], citeState: 'manual', mark: 'advice' }),
];
const viewIds = (l) => $(l, 'pNote').querySelectorAll('.blk').map((e) => e.dataset.id);
const QV = {
  total: 18, max: 25,
  axes: [
    { key: 'purpose', label: '目的と結論', by: 'ai', score: 4, reason: '冒頭で目的を言った', cites: ['s1'] },
    { key: 'mece', label: '抜け・重なり（MECE）', by: 'ai', score: 3, reason: '予算が抜けた', cites: [] },
    { key: 'decisions', label: '決定事項', by: 'ai', score: 4, reason: '来月に試すと決めた', cites: ['s1'] },
    { key: 'todos', label: 'ToDo の具体さ', by: 'app', score: 3, reason: 'ToDo 2 件のうち担当と期限がそろったのは 1 件', cites: [] },
    { key: 'fill', label: '型の埋まり具合', by: 'app', score: 4, reason: '型の見出し 5 つのうち根拠があるのは 4 つ', cites: [] },
  ],
};

test('0.11.0 V-2（D48・F24）: 要約は「決定事項・持ち越し・ToDo」→ 型の見出し → 抜け・重なりチェック → 次に気をつけること の順で描く（保存の順は変えない）。行の集まりは保存と同じ', T, async () => {
  const l = await openPage({ meetingType: 'sales', typeAuto: false, blocks: SAVED });
  assert.deepStrictEqual(viewIds(l), M.orderForView(SAVED).map((i) => SAVED[i].id));
  assert.deepStrictEqual(viewIds(l), ['h3', 'd1', 'h4', 'c1', 'h1', 'n1', 'h6', 'k1', 'h7', 'a1']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-2（F26）: つまみで「持ち越し」の行を型の見出しの節（n1 の前）へ落とすと、blockMove の toIndex は保存の番号', T, async () => {
  const moves = [];
  const l = await openPage({ meetingType: 'sales', typeAuto: false, blocks: SAVED }, { returns: { blockMove: (...a) => { moves.push(a); return { ok: true }; } } });
  const box = $(l, 'pNote');
  const els = box.querySelectorAll('.blk');
  els.forEach((e, i) => { e.getBoundingClientRect = () => ({ top: i * 10, height: 10, bottom: i * 10 + 10, left: 0, right: 100, width: 100 }); });
  const c1 = els.find((e) => e.dataset.id === 'c1');
  c1.ondragstart({ dataTransfer: { setData() {}, effectAllowed: '' } });
  // c1 を除いた画面の行: h3 d1 h4 h1 n1 h6 k1 h7 a1。n1 は 4 番目（els の中の位置 5 の上半分）
  const n1 = els.findIndex((e) => e.dataset.id === 'n1');
  await box.ondrop({ preventDefault() {}, clientY: n1 * 10 + 2 });
  await l.drain();
  // 保存の並びから c1 を抜くと n1 は 1 番目。その前に入れる
  assert.deepStrictEqual(moves, [['pa1', 'c1', 1]]);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-2（D48）: ［コピー］は画面と同じ順で、点があれば最後に打ち合わせの質の行', T, async () => {
  const copied = [];
  const l = await openPage({ meetingType: 'sales', typeAuto: false, blocks: SAVED, qualityView: QV }, { returns: { copy: (t) => { copied.push(t); return true; } } });
  const btn = $(l, 'pMenu').querySelectorAll('button').find((b) => b.textContent === 'コピー');
  await btn.onclick();
  await l.drain();
  const want = [...M.orderForView(SAVED).map((i) => SAVED[i]).map((b) => (b.type === 'heading' ? `\n## ${b.text}` : `- ${b.text}`)), '', ...require('../src/quality').qualityLines(QV)].join('\n').trim();
  assert.deepStrictEqual(copied, [want]);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-2（QM4・QM7・決めたこと 28）: 点のカードは要約の欄の最後で qualityView の数を出す（quality の total を 25 にした種でも）。軸 1〜3 に出典のチップか「根拠なし」、足の一言', T, async () => {
  const broken = { v: 1, total: 25, max: 25, axes: QV.axes.map((a) => ({ key: a.key, score: a.score, reason: a.reason, cites: a.cites })) };
  const l = await openPage({ meetingType: 'sales', typeAuto: false, blocks: SAVED, quality: broken, qualityView: QV });
  const card = $(l, 'pNote').querySelector('.qcard');
  assert.ok(card, '点のカードが無い');
  const kids = $(l, 'pNote').children;
  assert.ok(kids[kids.length - 1] === card, '点のカードが要約の欄の最後に無い');
  assert.strictEqual(card.querySelector('.qhead').textContent, '打ち合わせの質：18 / 25');
  const rows = card.querySelectorAll('.qrow');
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.qlabel').textContent), QV.axes.map((a) => a.label));
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.qscore').textContent), QV.axes.map((a) => `${a.score} / 5`));
  assert.deepStrictEqual(rows.map((r) => r.querySelector('.qreason').textContent), QV.axes.map((a) => a.reason));
  assert.deepStrictEqual(rows.map((r) => r.querySelectorAll('.cite').length), [1, 0, 1, 0, 0]);
  assert.deepStrictEqual(rows.map((r) => { const n = r.querySelector('.nocite'); return n ? n.textContent : ''; }), ['', '根拠なし', '', '', '']);
  assert.strictEqual(card.querySelector('.qfoot').textContent, '会議の進め方の目安です。人の評価ではありません。同じ会議でも作り直すと 1 点ほど動くので、何回かの会議の流れで見てください。');
  assert.ok(!card.textContent.includes('25 / 25'));
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-2（F11・P9）: qualityView が null ならカードも「/ 25」も無い。助言の欄（次に気をつけること）は点の無いページにもある', T, async () => {
  const l = await openPage({ meetingType: 'oneonone', typeAuto: false, blocks: SAVED, quality: { total: 25 }, qualityView: null });
  assert.ok($(l, 'pNote').querySelector('.qcard') === null, '点が無いのにカードがある');
  assert.ok(!$(l, 'pNote').textContent.includes('/ 25'));
  assert.ok(viewIds(l).includes('h7') && viewIds(l).includes('a1'), '助言の欄が無い');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- 0.11.0 V-3（QM6・QC1）: 設定のカード「打ち合わせの質」（0.9.2 の形）
const openSettings = async (settings = {}, o = {}) => {
  const saved = [];
  const l = await load(APP, {
    preloadSrc: PRELOAD,
    returns: {
      meetingTypes: TYPES, memoTypes: MEMOS,
      getSettings: () => ({ ...require('./helpers/simrun.js').RETURNS.getSettings(), ...settings }),
      saveSettings: (next) => { saved.push(next); return { ok: true }; },
      ...(o.returns || {}),
    },
  });
  await l.drain();
  l.saved110 = saved;
  return l;
};
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim();

test('0.11.0 V-3（QC1）: カード「打ち合わせの質」は「Claude との連携（MCP）」の次。頭の1行・ⓘ の吹き出しの文・行「打ち合わせの質の点数」と3つの選び肢（「すべての会議で付ける」が先頭）', T, async () => {
  const l = await openSettings();
  const cards = $(l, 'tabSettings').querySelector('.scroll').children.filter((c) => c.classList.contains('card'));
  const titles = cards.map((c) => norm(c.querySelector('h2').textContent));
  const i = titles.indexOf('Claude との連携（MCP）');
  assert.strictEqual(titles[i + 1], '打ち合わせの質');
  const card = cards[i + 1];
  assert.strictEqual(card.dataset.sec, 'summary');
  assert.strictEqual(card.id, 'qualityCardSet');
  assert.strictEqual(card.querySelector('.setinfo').getAttribute('aria-controls'), 'setPopQuality');
  assert.strictEqual(norm(card.querySelector('.setlead .desc').textContent), '要約の最後に、会議の進め方の目安を 25 点で付けます。');
  const pop = $(l, 'setPopQuality');
  assert.strictEqual(norm(pop.querySelector('.setpop-head').textContent), '目的と結論・抜け・重なり・決定事項・ToDo の具体さ・型の埋まり具合を 5 点ずつ見ます。');
  assert.deepStrictEqual(pop.querySelectorAll('li').map((x) => norm(x.textContent)), [
    '人の評価ではありません。',
    '同じ会議でも作り直すと 1 点ほど動くので、何回かの会議の流れで見てください。',
    '1on1 と採用面接・事前面談にも付けます。外すときは「1on1 と採用面接・事前面談を除いて付ける」を選びます。',
    '点を付けない会議にも、要約の最後に「次に気をつけること」は付きます。',
  ]);
  assert.strictEqual(norm(pop.querySelector('.setpop-help').textContent), 'ヘルプで詳しく見る ↗');
  assert.strictEqual(norm(pop.querySelector('.setpop-esc').textContent), 'Esc で閉じる');
  const row = card.querySelectorAll('[data-row]');
  assert.deepStrictEqual(row.map((r) => r.dataset.row), ['打ち合わせの質の点数']);
  assert.strictEqual(norm(row[0].querySelector('.desc').textContent), '人の評価ではなく、会議の進め方の目安です。');
  const sel = $(l, 'qualityScore');
  assert.deepStrictEqual(sel.children.map((o) => [o.getAttribute('value'), norm(o.textContent)]), [
    ['all', 'すべての会議で付ける'], ['on', '1on1 と採用面接・事前面談を除いて付ける'], ['off', '付けない'],
  ]);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-3（QM6・P11 (b)）: 既定（設定に無い・知らない値）は「すべての会議で付ける」。選ぶと settings:save に qualityScore', T, async () => {
  for (const [v, want] of [[undefined, 'all'], ['nope', 'all'], ['on', 'on'], ['off', 'off'], ['all', 'all']]) {
    const l = await openSettings(v === undefined ? {} : { qualityScore: v });
    assert.strictEqual($(l, 'qualityScore').value, want, String(v));
  }
  const l = await openSettings();
  const sel = $(l, 'qualityScore');
  sel.value = 'on';
  $(l, 'tabSettings').dispatchEvent({ type: 'change', target: sel });
  await l.drain();
  assert.strictEqual(l.saved110.pop().qualityScore, 'on');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-3: 設定の検索で「点数」と打つと、行「打ち合わせの質の点数」だけが出る', T, async () => {
  const l = await openSettings();
  const b = $(l, 'setSearch');
  b.value = '点数';
  b.dispatchEvent({ type: 'input', target: b });
  await l.drain();
  const visible = (el) => { for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) { if (n.id === 'settingsModal') return true; if (n.hidden || n.classList.contains('set-miss')) return false; } return true; };
  assert.deepStrictEqual($(l, 'tabSettings').querySelectorAll('[data-row]').filter(visible).map((r) => r.dataset.row), ['打ち合わせの質の点数']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- 0.11.0 V-4（P15 (a)・D79）: 題名を直した自動のページの一言
const editTitle = async (l, t) => { const el = $(l, 'pTitle'); el.textContent = t; el.onblur(); await l.drain(); };
const titleHint = (l) => { const n = $(l, 'pTitleTypeHint'); return n && !n.hidden ? n.textContent : ''; };

test('0.11.0 V-4（P15 (a)）: 自動のページで題名を直すと main に判定を聞き、今の種類と違えば「題名からは「{名前}」です（［要約を再生成］で反映されます）」。種類も要約も変えない', T, async () => {
  const asked = [];
  const l = await openPage({ meetingType: 'standup', typeAuto: true, autoType: 'standup', blocks: [{ id: 'b1', type: 'bullet', text: '要点', cites: ['s1'] }] },
    { returns: { metaDetectType: (id, title) => { asked.push([id, title]); return { type: 'sales' }; }, pageSetTitle: () => ({ ok: true }) } });
  await editTitle(l, 'A社 商談');
  assert.deepStrictEqual(asked, [['pa1', 'A社 商談']]);
  assert.strictEqual(titleHint(l), `題名からは「${mtype.getLabel('sales')}」です（［要約を再生成］で反映されます）`);
  assert.strictEqual($(l, 'pType').value, '', '種類を変えた');
  assert.ok(!l.calls110.some((c) => c[0] === 'pageSetType'), '種類を書いた');
  assert.ok($(l, 'pTypeHint').textContent.startsWith(`自動判定: ${mtype.getLabel('standup')}`));
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('0.11.0 V-4: 判定が今の種類と同じ・決まらない・手で選んだページでは一言を出さない（手で選んだページは聞かない）', T, async () => {
  for (const [ans, want] of [[{ type: 'standup' }, ''], [{ type: '' }, ''], [null, '']]) {
    const l = await openPage({ meetingType: 'standup', typeAuto: true, autoType: 'standup' }, { returns: { metaDetectType: () => ans, pageSetTitle: () => ({ ok: true }) } });
    await editTitle(l, '定例');
    assert.strictEqual(titleHint(l), want, JSON.stringify(ans));
  }
  const asked = [];
  const m = await openPage({ meetingType: 'review', typeAuto: false, autoType: 'standup' }, { returns: { metaDetectType: (...a) => { asked.push(a); return { type: 'sales' }; }, pageSetTitle: () => ({ ok: true }) } });
  await editTitle(m, 'A社 商談');
  assert.deepStrictEqual(asked, [], '手で選んだページで判定を聞いた');
  assert.strictEqual(titleHint(m), '');
  assert.deepStrictEqual(m.errors.map(fmt), []);
});
