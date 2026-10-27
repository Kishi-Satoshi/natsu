/*
 * stage130.ready.app.test.js — 0.13.0 第2部「録音の前のページ」の画面（計画 docs/plans/2026-10-24-130.md の Task RDY-2・RDY-3）
 * ［＋ 新しい議事録］は録音の前のページを開くだけ（meetingPrepare）。ページの［文字起こしを始める］・［オフラインモードで始める］は始めるだけの口
 * meetingStart。最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。main は下の fakeMain（状態を持つ偽物）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');
const lib = require('../src/mainlib');
const M = require('../src/memoTypes');
const mtype = require('../src/meetingType');
const MUTANTS = require('../tools/mutants.js');
const { applyMutant } = require('../tools/mutate.js');
const { titleAt } = require('./helpers/titles');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const T = { timeout: 8000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const $ = (l, id) => l.document.getElementById(id);
const RT1 = '新しい議事録';
const RT3 = '文字起こしを始める';
const RT4 = 'オフラインモードで始める';
const RT5 = '始めると、録音と文字起こしに参加者全員が同意したものとみなされます。音声は文字起こしのため OpenAI に送られます。';
const RT6 = '始めると、録音と文字起こしに参加者全員が同意したものとみなされます。文字起こしはこの PC の中で行います。';
const RT8 = '録音していません';
const RT9 = '［文字起こしを始める］を押すと、ここに文字起こしが流れます。';
const RT10 = 'この議事録はまだ録音していません。書いたメモは残りません。閉じますか？';
const NOTSET = '文字起こしエンジンが未設定です。設定タブの［PC の中の文字起こしを取り込む］から取り込んでください。';

// 状態を持つ偽の main（prep・会議の有無）。calls に呼ばれた順（[名前, ...引数]）
function fakeMain(o = {}) {
  const s = { prep: null, active: false, cloud: o.cloud !== false, memo: '', meetingType: null, calls: [] };
  const status = () => (s.active
    ? { active: true, finalizing: false, startedAt: Date.now() - 1000, memo: s.memo, meetingType: s.meetingType, segments: [], pending: 0, pauses: [], cloud: s.cloud, prep: null,
      stt: { route: 'cloud', lastTextAt: null, segSec: 15, problem: null } }
    : { active: false, finalizing: false, memo: '', segments: [], pending: 0, cloud: s.cloud, prep: s.prep ? { ...s.prep } : null });
  s.status = status;
  s.returns = {
    meetingTypes: () => lib.typesForView(), memoTypes: () => M.listMemoTypes(),
    meetingStatus: () => status(),
    meetingPrepare: () => { s.calls.push(['meetingPrepare']); if (s.active) return { ok: false }; if (!s.prep) s.prep = { memo: '', meetingType: null }; return { ok: true }; },
    meetingUnprepare: () => { s.calls.push(['meetingUnprepare']); s.prep = null; return { ok: true }; },
    meetingSetMemo: (m) => { s.calls.push(['meetingSetMemo', m]); if (s.active) s.memo = m; else if (s.prep) s.prep.memo = m; return true; },
    meetingSetType: (key) => {
      s.calls.push(['meetingSetType', key]);
      const t = s.active ? s : s.prep;
      if (!t) return { ok: false };
      t.meetingType = key === 'auto' ? null : key;
      let inserted = false;
      if (key !== 'auto' && M.isUntouchedMemo(t.memo, mtype.listTypes().map((x) => x.agenda).filter(Boolean))) { t.memo = M.memoPreset(M.memoTypeOf(key)); inserted = true; }
      return { ok: true, memo: t.memo, inserted, meetingType: t.meetingType };
    },
    meetingStart: (a) => {
      s.calls.push(['meetingStart', a]);
      if (o.start) return o.start(a, s);
      if (s.active) return { ok: false, error: '他の処理を実行中です' };
      s.active = true; s.memo = s.prep ? s.prep.memo : ''; s.meetingType = s.prep ? s.prep.meetingType : null; s.prep = null;
      return { ok: true, localOnly: Boolean(a && a.pcOnly) };
    },
    meetingToggle: () => { s.calls.push(['meetingToggle']); return { ok: true }; },
    ...(o.returns || {}),
  };
  return s;
}
async function boot(o = {}) {
  const s = fakeMain(o);
  const l = await load(APP, { returns: s.returns, ...(o.load || {}) });
  await l.drain();
  l.s = s;
  return l;
}
const clickNew = async (l) => { $(l, 'mtToggleBtn').dispatchEvent({ type: 'click' }); await l.drain(); };
const tabs = (l) => $(l, 'tabbar').querySelectorAll('.tabitem').map((t) => [t.dataset.key, t.querySelector('.tt').textContent]);
const memoTa = (l) => $(l, 'pMemo').querySelector('textarea');
const callNames = (l) => l.s.calls.map((c) => c[0]);
const typeIn = async (l, text) => { const ta = memoTa(l); ta.value = text; ta.oninput(); await l.drain(); };

// ---------------------------------------------------------------- RDY-2（RD1・RD5〜RD7・RD9・RD10・RD16。F83・F89）
test('RDY-2（RD1・RD5〜RD7・F83）: ［＋ 新しい議事録］は meetingPrepare だけ（録音しない）。タブは1つで RT1、題名 RT2 は直せない、［メモ］のタブ、種類は「自動」と一言、［文字起こし］の欄は RT9。フォーカスはサイドバーのボタン', T, async () => {
  const l = await boot();
  const btn = $(l, 'mtToggleBtn');
  btn.focus();
  await clickNew(l);
  assert.deepStrictEqual(callNames(l), ['meetingPrepare']);
  assert.strictEqual(l.called('meetingToggle').length, 0);
  assert.strictEqual(l.called('meetingStart').length, 0);
  assert.deepStrictEqual(tabs(l), [['live', RT1]]);
  const t = $(l, 'pTitle');
  assert.deepStrictEqual([t.textContent, t.getAttribute('contenteditable')], [RT1, 'false']);
  assert.strictEqual($(l, 'crumb').querySelector('.ct').textContent, RT1);
  assert.strictEqual($(l, 'paneBtnMemo').getAttribute('aria-selected'), 'true', '［メモ］のタブで開かない');
  assert.notStrictEqual($(l, 'pTypeRow').style.display, 'none');
  assert.strictEqual($(l, 'pType').value, '');
  assert.strictEqual($(l, 'pTypeLiveHint').hidden, false);
  assert.ok(memoTa(l), 'メモ欄が無い');
  assert.strictEqual($(l, 'pScript').textContent, RT9);
  assert.strictEqual($(l, 'readyStartBtn').textContent, RT3);
  assert.ok($(l, 'readyStartBtn').className.split(' ').includes('action'));
  assert.strictEqual($(l, 'readyState').textContent, RT8);
  assert.strictEqual($(l, 'readyNote').textContent, RT5);
  assert.strictEqual($(l, 'liveBar'), null, '録音の前に記録の行がある');
  // 録音の前の行は会議のブロックの頭（丸いタブの前）
  const rb = $(l, 'readyBar');
  const kids = rb.parentNode.children;
  assert.ok(rb.parentNode.className.split(' ').includes('mblock'));
  assert.ok(kids.indexOf(rb) < kids.findIndex((n) => (n.className || '').split(' ').includes('ptabs')));
  assert.ok(l.document.activeElement === btn, 'フォーカスがサイドバーのボタンから動いた');
  // サイドバーのボタンの文は今のまま（RD16）
  assert.strictEqual(btn.textContent, '＋新しい議事録');
  // 2回押してもタブは1つで、書いたメモはそのまま
  await typeIn(l, '議題: 予算');
  await clickNew(l);
  assert.deepStrictEqual(tabs(l), [['live', RT1]]);
  assert.strictEqual(memoTa(l).value, '議題: 予算');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('RDY-2（RD9・RD10・F89）: 同意と送り先の文はクラウドの PC で RT5・PC の中だけの PC で RT6 とちょうど同じ。［オフラインモードで始める］はクラウドの PC だけ', T, async () => {
  const c = await boot();
  await clickNew(c);
  assert.strictEqual($(c, 'readyNote').textContent, RT5);
  assert.strictEqual($(c, 'readyLocalBtn').hidden, false);
  assert.strictEqual($(c, 'readyLocalBtn').textContent, RT4);
  const p = await boot({ cloud: false });
  await clickNew(p);
  assert.strictEqual($(p, 'readyNote').textContent, RT6);
  assert.ok(!/OpenAI/.test($(p, 'readyNote').textContent));
  assert.strictEqual($(p, 'readyLocalBtn').hidden, true, 'PC の中だけの PC に［オフラインモードで始める］');
});

// ---------------------------------------------------------------- RDY-2（RD2・RD11・RD18。F81・F91）
test('RDY-2（RD2・F81）: ［文字起こしを始める］は今のメモを先に送ってから meetingStart。答えを待つ間は2つのボタンを押せず、2回押しても meetingStart は1回', T, async () => {
  let release;
  const l = await boot({ start: (a, s) => new Promise((r) => { release = () => { s.active = true; s.memo = s.prep.memo; s.prep = null; r({ ok: true, localOnly: false }); }; }) });
  await clickNew(l);
  const ta = memoTa(l);
  ta.value = '予算の相談'; ta.oninput();   // 0.5 秒の送りを待たない
  $(l, 'readyStartBtn').dispatchEvent({ type: 'click' }); await l.drain();
  $(l, 'readyStartBtn').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('meetingStart').length, 1, '答えを待つ間に2回目を送った');
  assert.deepStrictEqual(l.s.calls.filter((c) => c[0] === 'meetingSetMemo' || c[0] === 'meetingStart').map((c) => c[0]), ['meetingSetMemo', 'meetingStart']);
  assert.deepStrictEqual(l.s.calls.find((c) => c[0] === 'meetingSetMemo'), ['meetingSetMemo', '予算の相談']);
  assert.deepStrictEqual([$(l, 'readyStartBtn').disabled, $(l, 'readyLocalBtn').disabled], [true, true]);
  release(); await l.drain();
  assert.strictEqual($(l, 'readyBar').hidden, true, '始めた後も録音の前の行が見える');
  assert.ok($(l, 'liveBar'));
  assert.deepStrictEqual(l.called('meetingStart').map((c) => c.args[0]), [{ pcOnly: false }]);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('RDY-2（RD11）: ［オフラインモードで始める］は meetingStart({ pcOnly: true })', T, async () => {
  const l = await boot();
  await clickNew(l);
  $(l, 'readyLocalBtn').dispatchEvent({ type: 'click' }); await l.drain();
  assert.deepStrictEqual(l.called('meetingStart').map((c) => c.args[0]), [{ pcOnly: true }]);
});

test('RDY-2（RD18・F91）: 断られたら左下に出してボタンを戻し、ページはそのまま（録音の前のタブ・書いたメモ）', T, async () => {
  const l = await boot({ start: () => ({ ok: false, error: '他の処理を実行中です' }) });
  await clickNew(l);
  await typeIn(l, '議題: 採用');
  $(l, 'readyStartBtn').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual($(l, 'toast').textContent, '他の処理を実行中です');
  assert.deepStrictEqual([$(l, 'readyStartBtn').disabled, $(l, 'readyLocalBtn').disabled], [false, false]);
  assert.deepStrictEqual(tabs(l), [['live', RT1]]);
  assert.strictEqual(memoTa(l).value, '議題: 採用');
  // もう一度押せる
  $(l, 'readyStartBtn').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('meetingStart').length, 2);
});

// ---------------------------------------------------------------- RDY-2（RD7）
test('RDY-2（RD7）: 録音の前のページで種類を選ぶと、待っているメモを送ってから meetingSetType。雛形が入り、一言が消える', T, async () => {
  const l = await boot();
  await clickNew(l);
  const ta = memoTa(l);
  const sel = $(l, 'pType'); sel.value = 'sales'; await sel.onchange(); await l.drain();
  assert.deepStrictEqual(l.s.calls.slice(-2).map((c) => c[0]), ['meetingSetMemo', 'meetingSetType']);
  assert.strictEqual(memoTa(l), ta, 'メモ欄を作り直した');
  assert.strictEqual(ta.value, M.memoPreset(M.memoTypeOf('sales')));
  assert.strictEqual($(l, 'pTypeLiveHint').hidden, true);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// ---------------------------------------------------------------- RDY-2（RD14。F90）
test('RDY-2（RD14・F90）: 録音の前のタブの × は、手を付けていないメモなら確かめずに meetingUnprepare。人の文があれば RT10 で確かめ、取り消しならタブも残る', T, async () => {
  const x = (l) => $(l, 'tabbar').querySelector('.tabitem .tx');
  const a = await boot();
  await clickNew(a);
  let asked = [];
  a.window.confirm = (m) => { asked.push(m); return false; };
  x(a).dispatchEvent({ type: 'click' }); await a.drain();
  assert.deepStrictEqual(asked, []);
  assert.strictEqual(a.called('meetingUnprepare').length, 1);
  assert.deepStrictEqual(tabs(a), []);
  assert.strictEqual($(a, 'readyBar').hidden, true);
  // 種類を選んで雛形だけが入ったメモも「手を付けていない」
  const p = await boot();
  await clickNew(p);
  const sel = $(p, 'pType'); sel.value = 'sales'; await sel.onchange(); await p.drain();
  p.window.confirm = (m) => { asked.push(m); return false; };
  asked = [];
  x(p).dispatchEvent({ type: 'click' }); await p.drain();
  assert.deepStrictEqual(asked, []);
  assert.strictEqual(p.called('meetingUnprepare').length, 1);
  // 人の文: 取り消し → 残る・OK → 閉じる
  const b = await boot();
  await clickNew(b);
  await typeIn(b, '議題: 予算');
  asked = [];
  b.window.confirm = (m) => { asked.push(m); return false; };
  x(b).dispatchEvent({ type: 'click' }); await b.drain();
  assert.deepStrictEqual(asked, [RT10]);
  assert.strictEqual(b.called('meetingUnprepare').length, 0);
  assert.deepStrictEqual(tabs(b), [['live', RT1]]);
  assert.strictEqual(memoTa(b).value, '議題: 予算');
  b.window.confirm = (m) => { asked.push(m); return true; };
  x(b).dispatchEvent({ type: 'click' }); await b.drain();
  assert.strictEqual(b.called('meetingUnprepare').length, 1);
  assert.deepStrictEqual(tabs(b), []);
  // 閉じた後にもう一度開くと、メモは空から
  await clickNew(b);
  assert.strictEqual(memoTa(b).value, '');
  assert.deepStrictEqual(b.errors.map(fmt), []);
});

test('RDY-2（RD14）: 録音中の記録中のタブには今どおり × が無い', T, async () => {
  const l = await boot();
  await clickNew(l);
  $(l, 'readyStartBtn').dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual($(l, 'tabbar').querySelector('.tabitem .tx'), null);
});

// ---------------------------------------------------------------- RDY-2（RD20）
test('RDY-2（RD20）: 録音中のページの部品を写さない（前の版の変異 rec-title-lock・rec-in-block・ui-live-bar-only・v-live-tab の from が app.html にちょうど1回）', () => {
  const html = fs.readFileSync(APP, 'utf8');
  for (const id of ['rec-title-lock', 'rec-in-block', 'ui-live-bar-only', 'v-live-tab']) {
    const m = MUTANTS.find((x) => x.id === id);
    assert.ok(m, id);
    assert.doesNotThrow(() => applyMutant(html, m), id);
  }
});

// ---------------------------------------------------------------- RDY-3（RD6・RD8・RD10。F82・F85）
const RECORDING = (s, o = {}) => { s.active = true; s.memo = o.memo === undefined ? (s.prep ? s.prep.memo : '') : o.memo; s.meetingType = s.prep ? s.prep.meetingType : null; s.prep = null; };
test('RDY-3（RD8・F85）: 録音の前に打って 500 ms 待たずに main の側から録音が始まっても（main のメモは古い）、欄の今の文が残り meetingSetMemo で送り直す。欄を作り直さない。録音の前の行は隠れ、記録の行・「● 記録中」', T, async () => {
  const l = await boot();
  await clickNew(l);
  const ta = memoTa(l);
  ta.value = '議題: 予算と採用'; ta.oninput();   // 送りは 0.5 秒後（まだ送っていない）
  await l.drain();
  const sent0 = l.called('meetingSetMemo').length;
  RECORDING(l.s, { memo: '' });   // 例: Alt+M で始まった（main は空のメモを持っている）
  l.fire('onMeetingUpdate', l.s.status()); await l.drain();
  assert.strictEqual(memoTa(l), ta, 'メモ欄を作り直した');
  assert.strictEqual(ta.value, '議題: 予算と採用');
  assert.deepStrictEqual(l.called('meetingSetMemo').slice(sent0).map((c) => c.args[0]), ['議題: 予算と採用']);
  assert.strictEqual($(l, 'readyBar').hidden, true);
  assert.ok($(l, 'liveBar') && !$(l, 'liveBar').hidden);
  assert.deepStrictEqual(tabs(l), [['live', '● 記録中']]);
  assert.strictEqual($(l, 'pTitle').textContent, '記録中の会議');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('RDY-3（RD6）: 録音が始まったとき、メモ欄にフォーカスがあれば［メモ］のまま、無ければ［文字起こし］へ1回だけ切り替える。種類の行は選んだまま', T, async () => {
  const a = await boot();
  await clickNew(a);
  const sel = $(a, 'pType'); sel.value = 'sales'; await sel.onchange(); await a.drain();
  memoTa(a).focus();
  RECORDING(a.s);
  a.fire('onMeetingUpdate', a.s.status()); await a.drain();
  assert.strictEqual($(a, 'paneBtnMemo').getAttribute('aria-selected'), 'true', 'メモを書いている途中で文字起こしのタブへ引き戻した');
  assert.strictEqual($(a, 'pType').value, 'sales');
  const b = await boot();
  await clickNew(b);
  $(b, 'mtToggleBtn').focus();
  RECORDING(b.s);
  b.fire('onMeetingUpdate', b.s.status()); await b.drain();
  assert.strictEqual($(b, 'paneBtnScript').getAttribute('aria-selected'), 'true');
  // 区間が届いて描き直しても切り替え直さない
  $(b, 'paneBtnMemo').click();
  b.fire('onMeetingUpdate', { ...b.s.status(), segments: [{ id: 's1', atMs: 0, text: '始めます。' }] }); await b.drain();
  assert.strictEqual($(b, 'paneBtnMemo').getAttribute('aria-selected'), 'true');
});

test('RDY-3（RD10・F82）: ［文字起こしを始める］で始めた直後の 1 秒は［⏸ 一時停止］と［■ 終了して作成］を押しても何も起きない（disabled）。1 秒後は押せる。ホットキーで始めたときは守らない', T, async () => {
  const l = await boot();
  await clickNew(l);
  $(l, 'readyStartBtn').dispatchEvent({ type: 'click' }); await l.drain();
  const stop = $(l, 'liveStopBtn'), pause = $(l, 'livePauseBtn');
  assert.deepStrictEqual([stop.disabled, pause.disabled], [true, true]);
  stop.dispatchEvent({ type: 'click' }); pause.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('meetingToggle').length, 0, '始めた直後の2回目のクリックで止めた');
  assert.strictEqual(l.called('meetingSetPaused').length, 0, '始めた直後の2回目のクリックで一時停止した');
  await l.clock.advance(1000); await l.drain();
  assert.deepStrictEqual([stop.disabled, pause.disabled], [false, false]);
  stop.dispatchEvent({ type: 'click' }); await l.drain();
  assert.strictEqual(l.called('meetingToggle').length, 1);
  // 録音の前のページを通らずに始まった（ホットキー・パネル）
  const h = await boot();
  RECORDING(h.s);
  h.fire('onMeetingUpdate', h.s.status()); await h.drain();
  assert.deepStrictEqual([Boolean($(h, 'liveStopBtn').disabled), Boolean($(h, 'livePauseBtn').disabled)], [false, false]);
  $(h, 'liveStopBtn').dispatchEvent({ type: 'click' }); await h.drain();
  assert.strictEqual(h.called('meetingToggle').length, 1);
});

// ---------------------------------------------------------------- RDY-3（RD13。F86）
test('RDY-3（RD13・F86）: 締め・知らせのページ（onPageOpen）は、録音の前のページがあれば新しいタブで開き、録音の前のタブは残る。録音中のタブなら今どおり置き換える', T, async () => {
  const PAGE = (id) => ({ page: { id, title: titleAt('2026-10-26T01:00:00.000Z'), createdAt: '2026-10-26T01:00:00.000Z', durationSec: 60, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
  const r = await boot({ returns: { pageGet: PAGE } });
  await clickNew(r);
  await typeIn(r, '次の会議の議題');
  r.fire('onPageOpen', 'pa1'); await r.drain();
  assert.deepStrictEqual(tabs(r).map((t) => t[0]), ['live', 'page:pa1']);
  assert.strictEqual(tabs(r)[0][1], RT1);
  // 録音の前のタブへ戻ると書いた文がそのまま
  $(r, 'tabbar').querySelector('.tabitem').dispatchEvent({ type: 'click' }); await r.drain();
  assert.strictEqual(memoTa(r).value, '次の会議の議題');
  const c = await boot({ returns: { pageGet: PAGE } });
  RECORDING(c.s);
  c.fire('onMeetingUpdate', c.s.status()); await c.drain();
  c.s.active = false;
  c.fire('onMeetingUpdate', c.s.status()); await c.drain();
  c.fire('onPageOpen', 'pa1'); await c.drain();
  assert.deepStrictEqual(tabs(c).map((t) => t[0]), ['page:pa1']);
  assert.deepStrictEqual(r.errors.map(fmt), []);
});

test('RDY-3（RD13）: page:open の受けは pageOpenFromMain の1か所（onPageOpen はそれを呼ぶだけ）', () => {
  const html = fs.readFileSync(APP, 'utf8');
  assert.strictEqual(html.split('window.koeApp.onPageOpen(').length - 1, 1);
  assert.ok(html.includes('window.koeApp.onPageOpen((id, o) => pageOpenFromMain(id, o));'));
});

// ---------------------------------------------------------------- RDY-3（RD15）
test('RDY-3（RD15）: 画面を読み直したとき main に録音の前のページがあれば、記録中のタブを録音の前の形で戻す（メモと種類も）。覚えたタブがあればそれを選ぶ', T, async () => {
  const prep = { memo: '議題: 読み直し', meetingType: 'sales' };
  const a = await boot({ returns: { meetingStatus: () => ({ active: false, finalizing: false, segments: [], pending: 0, cloud: true, prep }) } });
  assert.deepStrictEqual(tabs(a), [['live', RT1]]);
  assert.strictEqual(memoTa(a).value, '議題: 読み直し');
  assert.strictEqual($(a, 'pType').value, 'sales');
  assert.ok(!$(a, 'readyBar').hidden);
  const PAGE = (id) => ({ page: { id, title: titleAt('2026-10-26T02:00:00.000Z'), createdAt: '2026-10-26T01:00:00.000Z', durationSec: 60, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
  const b = await boot({ returns: { meetingStatus: () => ({ active: false, finalizing: false, segments: [], pending: 0, cloud: true, prep }), pageGet: PAGE,
    uiState: () => ({ tabs: { open: ['page:pb1'], active: 'page:pb1' } }) } });
  assert.deepStrictEqual(tabs(b).map((t) => t[0]).sort(), ['live', 'page:pb1']);
  assert.strictEqual($(b, 'tabbar').querySelector('.tabitem.active').dataset.key, 'page:pb1');
  assert.deepStrictEqual(b.errors.map(fmt), []);
});

// ---------------------------------------------------------------- RDY-3（撮る画面）
test('RDY-3: 撮る画面 live-ready-light・live-ready-dark・live-ready-zoom200-light（録音の前のページ。［＋ 新しい議事録］を押す）があり、取り直し待ち', () => {
  const SH = require('../tools/shots/screens.js');
  for (const [n, theme, zoom] of [['live-ready-light', 'light', undefined], ['live-ready-dark', 'dark', undefined], ['live-ready-zoom200-light', 'light', 2]]) {
    const s = SH.SCREENS.find((x) => x.name === n);
    assert.ok(s, n);
    assert.deepStrictEqual([s.page, s.theme, s.zoom], ['app', theme, zoom], n);
    const st = s.answers['koeApp.meetingStatus'];
    assert.deepStrictEqual([st.active, st.prep, st.cloud], [false, { memo: '', meetingType: null }, true], n);
    assert.match(s.act, /mtToggleBtn/);
    assert.ok(SH.RETAKE.has(n), `${n} が取り直し待ちに無い`);
  }
});

// ---------------------------------------------------------------- 2026-10-26 の持ち主の答え（点検6「書いている間は切り替えない（おすすめ）」）
test('RDY-3・点検6: 録音の前のページのメモ・種類の欄に書いている間の保存した onPageOpen(\'pa1\', { saved: true }) は前に出さず、pa1 のタブを後ろに足す（書いた文とフォーカスはそのまま）。書いていない・印の無い page:open は今どおり前に出す', T, async () => {
  const PAGE = (id) => ({ page: { id, title: titleAt('2026-10-26T01:00:00.000Z'), createdAt: '2026-10-26T01:00:00.000Z', durationSec: 60, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
  const active = (l) => { const a = $(l, 'tabbar').querySelector('.tabitem.active'); return a ? a.dataset.key : ''; };
  for (const [name, focus, args, behind] of [
    ['メモ', (l) => memoTa(l).focus(), ['pa1', { saved: true }], true],
    ['種類', (l) => $(l, 'pType').focus(), ['pa1', { saved: true }], true],
    ['書いていない', () => {}, ['pa1', { saved: true }], false],
    ['メモ・印なし', (l) => memoTa(l).focus(), ['pa1'], false],
  ]) {
    const r = await boot({ returns: { pageGet: PAGE } });
    try {
      await clickNew(r);
      await typeIn(r, '次の会議の議題');
      focus(r);
      const el = r.document.activeElement;
      r.fire('onPageOpen', ...args); await r.drain();
      assert.deepStrictEqual(tabs(r).map((t) => t[0]), ['live', 'page:pa1'], name);
      assert.strictEqual(active(r), behind ? 'live' : 'page:pa1', name);
      if (behind) {
        assert.strictEqual(r.document.activeElement, el, `${name}: フォーカスが動いた`);
        assert.strictEqual(memoTa(r).value, '次の会議の議題', name);
        assert.strictEqual(r.called('pageGet').filter((c) => c.args[0] === 'pa1').length, 0, `${name}: 開いた`);
      }
      assert.deepStrictEqual(r.errors.map(fmt), []);
    } finally { if (r.done) r.done(); }
  }
});
