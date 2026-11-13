/*
 * stage151.app.test.js — 0.15.1「音声入力をなくす」の画面（計画 docs/plans/2026-11-04-151.md の Task ND-3。D114・WQ3）
 * 最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。preload の口の名前は src/preload.js から読む（simrun）。
 * ND-3（決めたこと 12・16・F149・F151・F152）: preload の koeApp から音声入力の9つの口を消し（koeOverlay は変えない）、サイドバーの［🎤 音声入力］・
 *       音声入力のタブとページ・履歴・設定の「音声入力ホットキー」「文字起こし後、カーソル位置へ自動貼り付け」「口述の文を AI で整える」・
 *       NaTsu の中の音声入力（入れる所を答える・入れる・Esc で取り消す）を消す。覚えたタブの音声入力は開かない。画面の見える文に「音声入力」が無い
 *       （設定の一言（WQ3）の中だけ）。
 * 題名は作った物（titleAt）。実在の人名・社名は使わない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load, preloadApis } = require('./helpers/simrun.js');
const { titleAt } = require('./helpers/titles');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const HTML = fs.readFileSync(APP, 'utf8');
const T = { timeout: 15000 };
const $ = (l, id) => l.document.getElementById(id);
// 画面とヘルプの文の版の数字（計画の「並べて作る決まり」の 3: 0.16.0 が先に出たら G でここだけを 0.16.1 にする）
const VER = '0.15.1';
const NOTE = `NaTsu の音声入力は ${VER} でなくなりました。Windows の音声入力（Windows キー + H）を使えます。`;

const LIST = [{ id: 'pa1', title: titleAt('2026-11-01T01:00:00.000Z'), date: '2026-11-01', durationSec: 1800, hasSummary: true, createdAt: '2026-11-01T01:00:00.000Z', parentId: null, ord: 'i' }];
const PAGE = (id) => (id === 'pa1' ? { page: { id, title: LIST[0].title, createdAt: LIST[0].createdAt, durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] } : null);
const UI = (tabs = { open: [], active: '' }) => () => ({ sidebar: { width: 260, collapsed: false }, tabs });
async function boot(o = {}) {
  const l = await load(APP, { returns: { pagesSearch: () => LIST, pageGet: PAGE, uiState: UI(), ...o } });
  await l.drain();
  return l;
}
const tabKeys = (l) => $(l, 'tabbar').querySelectorAll('[role="tab"]').map((t) => t.dataset.key);
// 設定の検索（stage090.settings と同じ形）と、画面に出ている行の名前
const visible = (el) => { for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) { if (n.id === 'settingsModal') return true; if (n.hidden || n.classList.contains('set-miss')) return false; } return true; };
const shownRows = (l) => $(l, 'tabSettings').querySelectorAll('[data-row]').filter(visible).map((r) => r.dataset.row);
const search = async (l, q) => { const b = $(l, 'setSearch'); b.value = q; b.dispatchEvent({ type: 'input', target: b }); await l.drain(); };

// 0.15.1 で消した preload の口（決めたこと 12）と、変えない録音バーの口（WQ1。da37aaa の src/preload.js の koeOverlay の名前の並び）。
// main から来る知らせの4つの受け口（LISTEN_APIS）は、main が送るのをやめた ND-2 で消した（計画の R7。ND-2 で5つから9つに）
const GONE_APIS = ['getHistory', 'deleteHistory', 'clearHistory', 'toggleRecording', 'dictationCancel'];
const LISTEN_APIS = ['onDictationWhere', 'onDictationText', 'onDictationEnd', 'onHistoryUpdated'];
const OVERLAY_APIS = ['onStart', 'onStop', 'onCancel', 'onPhase', 'onTick', 'onSegmentMs', 'sendAudio', 'sendSegment', 'sendError', 'reportSource', 'reportPause', 'reportMic',
  'confirmStop', 'requestCancel', 'requestHide', 'reportSize', 'onForm', 'hidePanel', 'onHover', 'onLevelAsk', 'reportLevel', 'onCut'];
const GONE_ROWS = ['音声入力ホットキー', '文字起こし後、カーソル位置へ自動貼り付け', '口述の文を AI で整える'];

test('ND-3・ND-2・決めたこと 12: preload の koeApp に音声入力の9つの口（履歴・録音の切り替え・取り消しと、main から来る4つの知らせの受け口）が無く、録音バーの koeOverlay の口は前と同じ', () => {
  const a = preloadApis();
  assert.deepStrictEqual([...GONE_APIS, ...LISTEN_APIS].filter((n) => a.koeApp.includes(n)), [], '消した口が koeApp に残っている');
  assert.deepStrictEqual(a.koeOverlay, OVERLAY_APIS, '録音バーの口が変わった（overlay.html は凍結: WQ1）');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  for (const ch of ['history:get', 'history:delete', 'history:clear', 'app:toggle-recording', 'dictation:cancel', 'history:updated', 'dictation:where', 'dictation:where-answer', 'dictation:text', 'dictation:end']) {
    assert.ok(!src.includes(`'${ch}'`), `preload が ${ch} を使っている`);
  }
});

test('ND-3: サイドバーの一覧の下の行は［🗑️ ゴミ箱］（ゴミ箱が空なら隠れている）と［⚙️ 設定］だけ。音声入力のページと履歴の部品が無い', T, async () => {
  const l = await boot();
  const side = $(l, 'side');
  const kids = side.children;
  const after = kids.slice(kids.indexOf($(l, 'plist')) + 1).filter((e) => e.classList.contains('side-row'));
  assert.deepStrictEqual(after.map((e) => e.id), ['tabBtnTrash', 'tabBtnSettings']);
  assert.strictEqual($(l, 'tabBtnTrash').hidden, true, 'ゴミ箱が空なのに［ゴミ箱］が出ている');
  for (const id of ['tabBtnDictation', 'tabDictation', 'histList', 'recBtn', 'histSearch', 'clearBtn', 'stToday', 'stTotal', 'stSaved']) {
    assert.strictEqual(l.root.querySelectorAll(`#${id}`).length, 0, `#${id} が残っている`);
  }
  assert.deepStrictEqual(l.errors.map(String), []);
  for (const n of [...GONE_APIS, ...LISTEN_APIS]) assert.deepStrictEqual(l.called(n), [], `${n} を呼んだ・受けた`);
});

test('ND-3・F152: 覚えたタブ（古い main の答え）に音声入力があっても開かず、ページのタブだけを開く。タブの帯に「音声入力」が無い', T, async () => {
  for (const tabs of [{ open: ['dictation', 'page:pa1'], active: 'dictation' }, { open: ['page:pa1', 'dictation'], active: 'page:pa1' }]) {
    const l = await boot({ uiState: UI(tabs) });
    assert.deepStrictEqual(tabKeys(l), ['page:pa1'], JSON.stringify(tabs));
    assert.ok(!$(l, 'tabbar').textContent.includes('音声入力'), 'タブの帯に音声入力');
    assert.strictEqual($(l, 'tabbar').querySelector('[aria-selected="true"]').dataset.key, 'page:pa1');
    assert.deepStrictEqual(l.errors.map(String), []);
  }
  // 音声入力のタブだけを覚えていたら、タブは無い（ページの無い形）
  const l = await boot({ uiState: UI({ open: ['dictation'], active: 'dictation' }) });
  assert.deepStrictEqual(tabKeys(l), []);
  assert.deepStrictEqual(l.errors.map(String), []);
});

test('ND-3・F151: 設定に音声入力のキー・自動貼り付け・口述の整えの欄と行が無く、検索で当たらず、保存で送らない。議事録のホットキーの警告は今のまま', T, async () => {
  const l = await boot({ hotkeyState: () => ({ ok: false, failed: ['議事録'], fallback: {}, message: '' }) });
  for (const id of ['hotkey', 'hotkeyWarn', 'hotkeyCaps', 'autoPaste', 'aiTidy', 'aiTidyDesc', 'aiTidyWarn']) assert.strictEqual(l.root.querySelectorAll(`#${id}`).length, 0, `#${id} が残っている`);
  const rows = $(l, 'tabSettings').querySelectorAll('[data-row]').map((r) => r.dataset.row);
  assert.deepStrictEqual(GONE_ROWS.filter((r) => rows.includes(r)), [], '消した行が残っている');
  assert.ok(rows.includes('議事録ホットキー') && rows.includes('フィラー除去'), '残す行が無い');
  $(l, 'tabBtnSettings').click(); await l.drain();
  for (const q of ['音声入力ホットキー', '自動貼り付け', '口述']) {
    await search(l, q);
    assert.deepStrictEqual(shownRows(l), [], `「${q}」で当たる行がある`);
  }
  await search(l, '音声入力');
  assert.deepStrictEqual(shownRows(l).filter((r) => r.includes('音声入力')), [], '「音声入力」の名前の行がある');
  await search(l, '');
  // 保存で送る欄（自動保存は #tabSettings の change）
  $(l, 'tabSettings').dispatchEvent({ type: 'change' }); await l.drain();
  const saved = l.called('saveSettings').pop().args[0];
  for (const k of ['hotkey', 'autoPaste', 'aiTidy', 'maxHistory']) assert.ok(!Object.hasOwn(saved, k), `保存で ${k} を送った`);
  assert.strictEqual(saved.meetingHotkey, 'Alt+M');
  assert.strictEqual(saved.removeFillers, true);
  // 議事録のホットキーが登録できていなければ、その欄の下に警告（音声入力の側の欄は無い）
  assert.strictEqual($(l, 'meetingHotkeyWarn').hidden, false);
  assert.strictEqual($(l, 'meetingHotkeyWarn').textContent, 'このキーは他のアプリが使用中のため登録できていません');
  assert.deepStrictEqual(l.errors.map(String), []);
});

test('ND-3・F149: 何も開いていない所の Esc は何もしない（main へ何も送らず、既定も止めない）。設定と検索の窓の Esc はそれぞれ自分だけを閉じる', T, async () => {
  const l = await boot();
  const n = l.calls.length;
  const ev = l.key({ key: 'Escape', code: 'Escape' });
  await l.drain();
  assert.strictEqual(ev.defaultPrevented, false, '何も開いていない Esc の既定を止めた');
  assert.deepStrictEqual(l.calls.slice(n).map((c) => c.method), [], '何も開いていない Esc で main へ送った');
  // 設定の Esc は設定だけを閉じる
  $(l, 'tabBtnSettings').click(); await l.drain();
  assert.strictEqual($(l, 'settingsModal').hidden, false, '前提: 設定が開いた');
  l.key({ key: 'Escape', code: 'Escape' }, l.document.activeElement); await l.drain();
  assert.strictEqual($(l, 'settingsModal').hidden, true, '設定の Esc で閉じない');
  // 検索の窓の Esc は検索の窓だけを閉じる
  $(l, 'sideSearch').click(); await l.drain();
  assert.strictEqual($(l, 'palette').hidden, false, '前提: 検索の窓が開いた');
  const pe = l.key({ key: 'Escape', code: 'Escape' }, l.document.activeElement); await l.drain();
  assert.strictEqual($(l, 'palette').hidden, true, '検索の窓の Esc で閉じない');
  assert.strictEqual(pe.defaultPrevented, true);
  assert.strictEqual($(l, 'settingsModal').hidden, true);
  // 0.15.1 ND-3 直し（B。消した 0.14.0 の EK-6・R64 直し（R194）のうち、音声入力でない分を引き継ぐ）: 入力の欄でない所（絞り込みの［アクション］）にフォーカスが
  // あっても、検索の窓の Esc は窓だけを閉じ、既定を止める（document の受け口）
  $(l, 'sideSearch').click(); await l.drain();
  assert.strictEqual($(l, 'palette').hidden, false, '前提: 検索の窓がもう一度開いた');
  const chip = $(l, 'fltActions');
  chip.focus();
  assert.ok(l.document.activeElement === chip, '前提: 絞り込みにフォーカスがある');
  const ce = l.key({ key: 'Escape', code: 'Escape' }, chip); await l.drain();
  assert.strictEqual($(l, 'palette').hidden, true, '絞り込みにフォーカスがあるときの Esc で検索の窓が閉じない');
  assert.strictEqual(ce.defaultPrevented, true, '絞り込みにフォーカスがあるときの Esc の既定を止めていない');
  assert.deepStrictEqual(l.errors.map(String), []);
});

// 画面の見える文（<script>・<style>・コメントの外の文字）と、title・aria-label・placeholder・data-row の字
function seenText(html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const attrs = [...body.matchAll(/\s(?:title|aria-label|placeholder|data-row)="([^"]*)"/g)].map((m) => m[1]);
  const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  return { text, attrs };
}
test('ND-3・決めたこと 16: 画面の見える文と title・aria-label・placeholder・data-row に「音声入力」が無い（設定の一言（WQ3）の中だけ）', () => {
  const { text, attrs } = seenText(HTML);
  assert.ok(text.includes(NOTE), '設定の一言が無い');
  assert.ok(!text.replace(NOTE, '').includes('音声入力'), `見える文に音声入力: ${text.replace(NOTE, '').match(/.{0,30}音声入力.{0,30}/)}`);
  assert.deepStrictEqual(attrs.filter((a) => a.includes('音声入力')), [], '名前の字に音声入力');
  // 画面の <script> が作る見える字（知らせ・タブの名前・パンくず）にも無い
  const script = [...HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/ [^\n'`]*$/gm, '');
  assert.deepStrictEqual([...script.matchAll(/['`][^'`\n]*音声入力[^'`\n]*['`]/g)].map((m) => m[0]), [], '<script> の文字に音声入力');
});

test('ND-3・画面の文: 「起動と終了」の説明・ⓘ の3つの文・設定の一言（WQ3）と［ヘルプで詳しく見る ↗］の記事が dictation/dictation', T, async () => {
  const l = await boot({ uiState: UI() });
  const tray = $(l, 'stayInTray').parentNode.textContent.replace(/\s+/g, ' ');
  assert.ok(tray.includes('オフなら、閉じると終了します（議事録のホットキーも使えません）。'), tray);
  const settingsText = $(l, 'tabSettings').textContent.replace(/\s+/g, ' ');
  assert.strictEqual((settingsText.match(/会議の音声を文字起こしの中継に送り/g) || []).length, 2, 'ⓘ の［アカウント］と［録音］の吹き出しの文');
  assert.ok(settingsText.includes('準備しなくても、インターネットにつながっていてログインしていれば、会議はそのまま使えます。'));
  assert.ok(!settingsText.includes('音声入力（ホットキー）は、これまでどおりマイクだけを使います。'));
  const note = $(l, 'shortcutNote');
  assert.ok(note.textContent.replace(/\s+/g, ' ').includes(NOTE), note.textContent);
  const help = note.querySelector('.setpop-help');
  assert.ok(help, '一言に［ヘルプで詳しく見る ↗］が無い');
  assert.strictEqual(help.textContent, 'ヘルプで詳しく見る ↗');
  assert.strictEqual(help.getAttribute('type'), 'button');
  assert.strictEqual(help.dataset.help, 'dictation/dictation');
  assert.deepStrictEqual(l.errors.map(String), []);
});

// 0.15.1 ND-3（R2）: 変異 eb-innerhtml-gate の当て直し先。0.14.0 EB-6 の「設定のホットキーの文字は要素の文字として入る」を、音声入力の履歴の空の文から、
// 残る議事録のホットキーの欄のキーの形の箱（showKeyCaps）で見る
test('EB-6・SEC2（0.15.1 ND-3 で当て直した）: 議事録のホットキーのキーの形の箱は、設定の文字を <kbd> の文字として入れる（HTML にならない）', T, async () => {
  const { RETURNS } = require('./helpers/simrun.js');
  const meetingHotkey = '<img src=x onerror="alert(1)">+<b>Q</b>';
  const l = await boot({ getSettings: () => ({ ...RETURNS.getSettings(), meetingHotkey }) });
  const box = $(l, 'meetingHotkeyCaps');
  assert.strictEqual(box.querySelectorAll('img').length + box.querySelectorAll('b').length, 0, 'ホットキーの文字が要素になった');
  const kbd = box.querySelectorAll('kbd');
  assert.deepStrictEqual(kbd.map((k) => k.textContent), ['<img src=x onerror="alert(1)">', '<b>Q</b>']);
  assert.ok(kbd.every((k) => k._html === undefined), 'innerHTML で入れた');
  // ふつうのキーは今と同じ箱（Alt・M）
  const l2 = await boot();
  assert.deepStrictEqual($(l2, 'meetingHotkeyCaps').querySelectorAll('kbd').map((k) => k.textContent), ['Alt', 'M']);
  assert.deepStrictEqual([...l.errors, ...l2.errors].map(String), []);
});
