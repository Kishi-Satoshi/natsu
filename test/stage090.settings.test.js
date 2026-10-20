/*
 * stage090.settings.test.js — 0.9.0（第1d2回）の設定のポップアップ（D24・案C。SP1〜SP7・F13・F15）を、最小 DOM（helpers/simrun.js）の上で
 * app.html の <script> を本当に走らせて確かめる。main の答えは偽物（preload.js の名前から作る）。
 * U-1（SP1〜SP3）: ポップアップで開く・開く道の全部・閉じ方と Esc・inert と Tab・左の列のキー・覚えたタブの settings を落とす・
 * 音声入力の録音中に本体の窓が前にあれば Esc を全体のホットキーにしない（場面 esc-focus。helpers/mainrun.js）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { load } = require('./helpers/simrun.js');
const { parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const preloadWith = (...names) => names.reduce((src, n) => (new RegExp(`^\\s+${n}\\s*:`, 'm').test(src) ? src
  : src.replace("exposeInMainWorld('koeApp', {", `exposeInMainWorld('koeApp', {\n  ${n}: (...a) => ipcRenderer.invoke('test:${n}', ...a),`)), PRELOAD);
const P1B = preloadWith('uiState', 'uiSave', 'meetingSetPaused');
const T = { timeout: 5000 };
const fmt = (e) => `${e.constructor.name}: ${e.message}`;
const LIST = [{ id: 'pa1', title: '定例（見本）', date: '10/16', durationSec: 1800, hasSummary: true },
  { id: 'pb2', title: '設計の打ち合わせ（見本）', date: '10/15', durationSec: 900, hasSummary: false }];
const PAGE = (id) => ({ page: { id, title: LIST.find((p) => p.id === id).title, createdAt: '2026-10-16T01:00:00.000Z', durationSec: 1800, blocks: [], memo: '', meetingType: 'general' }, segments: [] });
const UI = (tabs = { open: [], active: '' }) => () => ({ sidebar: { width: 260, collapsed: false }, tabs });
const open = (o = {}) => load(APP, { preloadSrc: P1B, returns: { pagesSearch: () => LIST, pageGet: PAGE, uiState: UI(), ...o } });
const tabs = (l) => l.byId.get('tabbar').querySelectorAll('[role="tab"]');
const keysOf = (l) => tabs(l).map((t) => t.dataset.key);
const row = (l, i) => l.byId.get('plist').querySelectorAll('.pitem')[i];
const $ = (l, id) => l.document.getElementById(id);
const isOpen = (l) => $(l, 'settingsModal').hidden === false && $(l, 'tabSettings').classList.contains('active');
const secOf = (l) => { const on = $(l, 'setNav').querySelectorAll('.setnav-item').filter((b) => b.classList.contains('on')); return on.length === 1 ? on[0].dataset.sec : `(${on.length} 個)`; };
const inModal = (l, el) => { for (let n = el; n; n = n.parentNode) if (n === $(l, 'settingsModal')) return true; return false; };
const click = async (l, el) => { (typeof el === 'string' ? $(l, el) : el).dispatchEvent({ type: 'click' }); await l.drain(); };
const key = async (l, o, target) => { const ev = l.key(o, target); await l.drain(); return ev; };
const T0 = Date.UTC(2026, 9, 19, 1, 0, 0);
const LIVE = (o = {}) => ({ active: true, finalizing: false, startedAt: T0 - 60000, memo: '', segments: [], pending: 0, stoppedAt: null,
  stopping: false, paused: false, pausedMs: 0, systemAudio: false, micFallback: false, etaSec: null, skipped: 0, pauses: [], pausing: false,
  resumeHint: false, localOnly: false, cloud: true, stt: null, ...o });
const PROB = (code, action, text) => LIVE({ stt: { route: 'local', lastTextAt: T0 - 5000, segSec: 15, problem: { code, action, text } } });

const html = fs.readFileSync(APP, 'utf8');
const doc = parseHTML(html).root;
const rules = S.parse(doc.querySelectorAll('style').map((s) => s._raw).join('\n'));

// ---------------------------------------------------------------- U-1（SP1〜SP3・F13）

test('SP1: サイドバーの［⚙️ 設定］を押すと #settingsModal が開き（hidden が無い・#tabSettings が active）、上の帯のタブの数は変わらず、今のタブも替わらない', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, row(l, 0));
  assert.deepStrictEqual(keysOf(l), ['page:pa1'], '前提: ページのタブが1つ');
  assert.strictEqual($(l, 'settingsModal').hidden, true, '初めから開いている');
  await click(l, 'tabBtnSettings');
  assert.ok(isOpen(l), 'ポップアップが開かない');
  assert.deepStrictEqual(keysOf(l), ['page:pa1'], '上の帯に設定のタブを足した');
  assert.strictEqual(tabs(l)[0].getAttribute('aria-selected'), 'true', '今のタブが替わった');
  assert.ok($(l, 'tabNotes').classList.contains('active'), '後ろのページが消えた');
  const m = $(l, 'settingsModal');
  assert.strictEqual(m.getAttribute('role'), 'dialog');
  assert.strictEqual(m.getAttribute('aria-modal'), 'true');
  assert.strictEqual(m.getAttribute('aria-labelledby'), 'setTitle');
  assert.strictEqual(m.parentNode, l.document.body, 'ポップアップが体の直の子でない（.app の中にある）');
  assert.ok($(l, 'tabSettings').closest('.setbox'), '設定の中身が .setbox の中に無い');
  assert.strictEqual(secOf(l), 'general', '初めの項目が「一般」でない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP1: 開く道の全部が、ポップアップをその項目で開く: showAccount → アカウント、showEngineSettings → オフライン、帯の account と engine のボタン、知らせの『未設定』の文、要約の失敗の『未設定』、起動の連れて行き', T, async () => {
  // 知らせの［ログインし直す］（showAccount）
  const a = await open();
  await a.drain();
  a.fire('onNotice', { text: 'ログインが切れたため（見本）', action: 'account' }); await a.drain();
  await click(a, $(a, 'toast').querySelector('button'));
  assert.ok(isOpen(a), 'showAccount でポップアップが開かない');
  assert.strictEqual(secOf(a), 'account');
  // 帯の account・engine
  for (const [action, sec] of [['account', 'account'], ['engine', 'offline']]) {
    const l = await open();
    await l.drain();
    l.fire('onMeetingUpdate', PROB('x', action, '帯の文（見本）')); await l.drain();
    await click(l, 'liveSttBannerBtn');
    assert.ok(isOpen(l), `帯の ${action} でポップアップが開かない`);
    assert.strictEqual(secOf(l), sec, `帯の ${action}`);
    assert.deepStrictEqual(keysOf(l), ['live'], `帯の ${action} で上の帯に設定のタブを足した`);
  }
  // 知らせの「未設定」（showEngineSettings）
  const n = await open();
  await n.drain();
  n.fire('onNotice', '要約エンジンが未設定です（見本）'); await n.drain();
  assert.ok(isOpen(n), '知らせの「未設定」でポップアップが開かない');
  assert.strictEqual(secOf(n), 'offline');
  // 要約の失敗の「未設定」
  const s = await open({ pageSummarize: () => ({ ok: false, error: '要約エンジンが未設定のため（見本）' }) });
  await s.drain();
  await click(s, row(s, 0));
  const sum = $(s, 'pActs').querySelectorAll('button').find((b) => /要約を生成/.test(b.textContent));
  assert.ok(sum, '前提: ［要約を生成］が無い');
  await click(s, sum);
  assert.ok(isOpen(s), '要約の失敗の「未設定」でポップアップが開かない');
  assert.strictEqual(secOf(s), 'offline');
  // 起動の連れて行き（パスが空で取り込んだ組も無い）
  const empty = () => ({ ...require('./helpers/simrun.js').RETURNS.getSettings(), localServerExe: '', localModelPath: '' });
  const b = await open({ getSettings: empty });
  await b.drain();
  assert.ok(isOpen(b), '起動の連れて行きでポップアップが開かない');
  assert.strictEqual(secOf(b), 'offline');
  assert.deepStrictEqual(keysOf(b), [], '起動の連れて行きで上の帯に設定のタブを足した');
  assert.deepStrictEqual([...a.errors, ...n.errors, ...s.errors, ...b.errors].map(fmt), []);
});

test('SP2: Esc・×・外の暗い所で閉じ、開く前に押した要素へフォーカスが戻る。.setbox の中の click では閉じない', T, async () => {
  const l = await open();
  await l.drain();
  const from = $(l, 'tabBtnSettings');
  const how = {
    Esc: async () => key(l, { key: 'Escape' }),
    '×': async () => click(l, 'setClose'),
    外: async () => {
      const m = $(l, 'settingsModal');
      m.dispatchEvent({ type: 'pointerdown', target: m });
      m.dispatchEvent({ type: 'click', target: m });
      await l.drain();
    },
  };
  for (const [name, close] of Object.entries(how)) {
    from.focus();
    await click(l, from);
    assert.ok(isOpen(l), `${name}: 開かない`);
    assert.ok(inModal(l, l.document.activeElement), `${name}: 開いたのにフォーカスがポップアップの中に無い`);
    assert.strictEqual(l.document.activeElement.dataset.sec, 'general', `${name}: 選んだ項目の行にフォーカスが無い`);
    const box = $(l, 'settingsModal').querySelector('.setbox');
    $(l, 'settingsModal').dispatchEvent({ type: 'pointerdown', target: box });
    $(l, 'settingsModal').dispatchEvent({ type: 'click', target: box });
    await l.drain();
    assert.ok(isOpen(l), `${name}: .setbox の中の click で閉じた`);
    await close();
    assert.ok(!isOpen(l), `${name} で閉じない`);
    assert.strictEqual($(l, 'settingsModal').hidden, true);
    assert.ok(!$(l, 'tabBtnSettings').classList.contains('active'), `${name}: 閉じたのにサイドバーの設定が選んだまま`);
    assert.ok(l.document.activeElement === from, `${name}: 閉じたのにフォーカスが開く前の所へ戻らない`);
  }
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP2: ホットキーの欄で Esc を押すと欄から抜けるだけで閉じない。もう一度 Esc で閉じる', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  const hk = $(l, 'hotkey');
  const before = hk.value;
  hk.focus();
  const ev = await key(l, { key: 'Escape' }, hk);
  assert.ok(isOpen(l), 'ホットキーの欄の Esc でポップアップを閉じた');
  assert.ok(l.document.activeElement !== hk, 'ホットキーの欄から抜けない');
  assert.strictEqual(hk.value, before, 'Esc をホットキーとして取り込んだ');
  assert.strictEqual($(l, 'saveMsg').textContent, '', '「修飾キー…」の文を出した');
  assert.strictEqual(ev.defaultPrevented, true);
  await key(l, { key: 'Escape' });
  assert.ok(!isOpen(l), '2回目の Esc で閉じない');
  // 議事録ホットキーの欄も同じ
  await click(l, 'tabBtnSettings');
  $(l, 'meetingHotkey').focus();
  await key(l, { key: 'Escape' }, $(l, 'meetingHotkey'));
  assert.ok(isOpen(l), '議事録ホットキーの欄の Esc でポップアップを閉じた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP2: 開いている間は .side と .col が inert（#toast は inert でない）。Tab は最後の部品の次で最初に戻り、最初の前は最後', T, async () => {
  const l = await open();
  await l.drain();
  const side = l.document.querySelector('.side'), col = l.document.querySelector('.col');
  assert.ok(!side.inert && !col.inert, '前提: 閉じているのに inert');
  await click(l, 'tabBtnSettings');
  assert.strictEqual(side.inert, true, '.side が inert でない');
  assert.strictEqual(col.inert, true, '.col が inert でない');
  assert.ok(!$(l, 'toast').inert, '#toast を inert にした（開いている間の知らせのボタンが押せない）');
  const last = $(l, 'openDataBtn');
  last.focus();
  const ev = await key(l, { key: 'Tab' }, last);
  assert.strictEqual(ev.defaultPrevented, true, '最後の部品の Tab を本物に任せた（後ろへ抜ける）');
  assert.ok(inModal(l, l.document.activeElement) && l.document.activeElement.closest('.setnav'), `最後の次が最初（左の列）でない: ${l.document.activeElement && l.document.activeElement.id}`);
  await key(l, { key: 'Tab', shiftKey: true }, l.document.activeElement);
  assert.ok(l.document.activeElement === last, '最初の前が最後でない');
  // 途中の Tab は本物に任せる（preventDefault しない）
  const mid = $(l, 'themeSel');
  mid.focus();
  assert.strictEqual((await key(l, { key: 'Tab' }, mid)).defaultPrevented, false, '途中の Tab を横取りした');
  await key(l, { key: 'Escape' });
  assert.ok(!side.inert && !col.inert, '閉じたのに inert が残った');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP2: 左の列は ↓ で次の項目、End で『更新』、Home で『アカウント』、↑ で前（端で回る）。選んだ行だけ tabindex 0', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  const nav = $(l, 'setNav');
  assert.strictEqual(nav.getAttribute('role'), 'tablist');
  assert.strictEqual(nav.getAttribute('aria-orientation'), 'vertical');
  const step = async (k) => { nav.dispatchEvent({ type: 'keydown', key: k, preventDefault() {} }); await l.drain(); return secOf(l); };
  assert.strictEqual(await step('ArrowDown'), 'record');
  assert.strictEqual(await step('End'), 'update');
  assert.strictEqual(await step('ArrowDown'), 'account', '端で回らない');
  assert.strictEqual(await step('ArrowUp'), 'update');
  assert.strictEqual(await step('Home'), 'account');
  const items = nav.querySelectorAll('.setnav-item');
  assert.deepStrictEqual(items.map((b) => b.tabIndex), [0, -1, -1, -1, -1, -1], '選んだ行だけ Tab で届く形でない');
  assert.deepStrictEqual(items.map((b) => b.getAttribute('aria-selected')), ['true', 'false', 'false', 'false', 'false', 'false']);
  assert.ok(l.document.activeElement === items[0], '移った項目にフォーカスが無い');
  assert.strictEqual($(l, 'setTitle').textContent, 'アカウント', '題名が選んだ項目の名前でない');
  // 押しても選べる（左の列の click）
  nav.dispatchEvent({ type: 'click', target: items[4] }); await l.drain();
  assert.strictEqual(secOf(l), 'offline');
  // 前に選んだ項目は閉じても覚える（K8）
  await key(l, { key: 'Escape' });
  await click(l, 'tabBtnSettings');
  assert.strictEqual(secOf(l), 'offline', '前に選んだ項目を覚えていない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP1: 6つの項目の行がこの順（アカウント・一般・録音・要約・オフライン・更新）で、それぞれ aria-hidden の SVG のアイコンを持つ。選んだ行の地は var(--hover) で、--accent を使わない', T, () => {
  const items = doc.querySelector('#setNav').querySelectorAll('.setnav-item');
  assert.deepStrictEqual(items.map((b) => [b.id, b.dataset.sec, b.textContent.trim(), b.getAttribute('role')]), [
    ['setNavAccount', 'account', 'アカウント', 'tab'], ['setNavGeneral', 'general', '一般', 'tab'], ['setNavRecord', 'record', '録音', 'tab'],
    ['setNavSummary', 'summary', '要約', 'tab'], ['setNavOffline', 'offline', 'オフライン', 'tab'], ['setNavUpdate', 'update', '更新', 'tab']]);
  for (const b of items) {
    const svg = b.querySelector('svg');
    assert.ok(svg, `${b.id} にアイコンが無い`);
    assert.strictEqual(svg.getAttribute('aria-hidden'), 'true', b.id);
    assert.strictEqual(svg.getAttribute('fill'), 'none', `${b.id}: 線のアイコンでない`);
    assert.strictEqual(svg.getAttribute('stroke'), 'currentColor', b.id);
  }
  const on = S.declsFor(rules, '.setnav-item.on', { at: '' });
  assert.strictEqual(on.background, 'var(--hover)', '選んだ行の地が灰色（--hover）でない');
  assert.strictEqual(S.declsFor(rules, '.setnav-item', { at: '' })['border-radius'], '6px');
  for (const r of rules) {
    const sels = r.sel.split(',').map((x) => x.trim());
    if (!sels.some((x) => /setnav|setmodal|setbox|setclose|#setClose/.test(x))) continue;
    assert.ok(!Object.values(r.decls).some((v) => /--accent\b|--level/.test(v)) || sels.every((x) => /:focus/.test(x)), `${r.sel} に青を使った`);
  }
  const box = S.declsFor(rules, '.setbox', { at: '' });
  assert.strictEqual(box['border-radius'], '10px');
  assert.strictEqual(S.declsFor(rules, '.setnav', { at: '' }).width, '180px', '左の列の幅が 180px でない');
  assert.strictEqual(S.declsFor(rules, '.setmodal[hidden]', { at: '' }).display, 'none', '本物の画面で hidden が .setmodal の display に負ける');
});

test('SP2: 開いている間に Ctrl+Tab・Ctrl+W・Ctrl+P・Ctrl+\\ を押しても、上のタブも #tabSettings の active も替わらない。Ctrl+Shift+L は効く', T, async () => {
  const l = await open({ uiState: UI({ open: ['page:pa1', 'dictation'], active: 'page:pa1' }) });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pa1', 'dictation'], '前提: タブが2つ');
  await click(l, 'tabBtnSettings');
  const sel = () => tabs(l).map((t) => t.getAttribute('aria-selected'));
  const s0 = sel();
  for (const k of [{ key: 'Tab', ctrlKey: true }, { key: 'Tab', ctrlKey: true, shiftKey: true }, { key: 'w', code: 'KeyW', ctrlKey: true }, { key: 'p', code: 'KeyP', ctrlKey: true },
    { key: 'k', code: 'KeyK', ctrlKey: true }, { key: '\\', code: 'Backslash', ctrlKey: true }]) {
    await key(l, k, l.document.activeElement);
    assert.deepStrictEqual(sel(), s0, `${JSON.stringify(k)} で後ろのタブが替わった`);
    assert.ok(isOpen(l), `${JSON.stringify(k)} でポップアップが閉じた・中身が消えた`);
    assert.strictEqual($(l, 'palette').hidden, true, `${JSON.stringify(k)} で検索の窓が開いた`);
    assert.ok(!l.byId.get('side').closest('.app').className.includes('side-collapsed'), `${JSON.stringify(k)} でサイドバーを畳んだ`);
  }
  assert.ok($(l, 'tabNotes').classList.contains('active'));
  const n = l.called('saveSettings').length;
  await key(l, { key: 'L', code: 'KeyL', ctrlKey: true, shiftKey: true }, l.document.activeElement);
  assert.strictEqual(l.called('saveSettings').length, n + 1, 'Ctrl+Shift+L（外観）が効かない');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP1・F13: 開いている間に、記録が始まって録音中のタブが開いても（meeting:update の active）、page:open でページが開いても、#tabSettings の active とポップアップは出たまま。閉じると後ろは録音中のタブ・そのページ', T, async () => {
  const l = await open({ meetingSetPaused: () => ({ ok: true }) });
  await l.drain();
  await click(l, 'tabBtnSettings');
  l.fire('onMeetingUpdate', LIVE()); await l.drain();
  assert.ok(keysOf(l).includes('live'), '前提: 録音中のタブが開かない');
  assert.ok(isOpen(l), '録音中のタブが開いたら設定の中身が消えた（showSection が設定に触った）');
  await key(l, { key: 'Escape' });
  assert.ok(!isOpen(l));
  assert.strictEqual(tabs(l).find((t) => t.dataset.key === 'live').getAttribute('aria-selected'), 'true', '閉じた後ろが録音中のタブでない');
  assert.ok($(l, 'tabNotes').classList.contains('active'));
  const p = await open();
  await p.drain();
  await click(p, 'tabBtnSettings');
  p.fire('onPageOpen', 'pb2'); await p.drain();
  assert.ok(isOpen(p), 'ページが開いたら設定の中身が消えた');
  assert.ok($(p, 'tabSettings').classList.contains('active'));
  await click(p, 'setClose');
  assert.deepStrictEqual(keysOf(p), ['page:pb2']);
  assert.strictEqual($(p, 'pTitle').textContent, '設計の打ち合わせ（見本）', '閉じた後ろがそのページでない');
  assert.deepStrictEqual([...l.errors, ...p.errors].map(fmt), []);
});

test('SP1: 開いている間に知らせ（action: account）が来て、そのボタンを押すと、閉じずに項目がアカウントに替わる。#toast は inert でない。閉じるとフォーカスは開く前の所へ戻る（知らせのボタンへは戻らない）', T, async () => {
  const l = await open();
  await l.drain();
  const from = $(l, 'tabBtnSettings');
  from.focus();
  await click(l, from);
  assert.strictEqual(secOf(l), 'general');
  l.fire('onNotice', { text: 'ログインが切れたため（見本）', action: 'account' }); await l.drain();
  const btn = $(l, 'toast').querySelector('button');
  assert.ok(!$(l, 'toast').inert, '#toast が inert');
  btn.focus();
  await click(l, btn);
  assert.ok(isOpen(l), '知らせのボタンでポップアップが閉じた');
  assert.strictEqual(secOf(l), 'account', '項目がアカウントに替わらない');
  await key(l, { key: 'Escape' });
  assert.ok(l.document.activeElement === from, '閉じたのに開く前の所へ戻らない（知らせのボタンへ戻ろうとした）');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP2: ホットキーの欄で Tab を押すと欄が受けず（preventDefault しない）次の部品へ渡し、欄の値は変わらず、『修飾キー…』の文も出ない（Shift+Tab も）', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  for (const id of ['hotkey', 'meetingHotkey']) {
    const hk = $(l, id);
    const before = hk.value;
    hk.focus();
    for (const shiftKey of [false, true]) {
      const ev = l.key({ key: 'Tab', shiftKey }, hk);
      assert.strictEqual(ev.defaultPrevented, false, `${id}: Tab をホットキーとして受けた（キーボードで欄から出られない）`);
      assert.strictEqual(hk.value, before, `${id}: Tab で欄の値が変わった`);
      assert.strictEqual($(l, 'saveMsg').textContent, '', `${id}: 「修飾キー…」の文を出した`);
    }
    // 修飾キーのある組み合わせは今どおり受ける
    const ev = l.key({ key: 'k', ctrlKey: true, shiftKey: true }, hk);
    assert.strictEqual(ev.defaultPrevented, true);
    assert.strictEqual(hk.value, 'Control+Shift+K', `${id}: ホットキーの取り込みが壊れた`);
  }
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP2: .setbox の中で pointerdown して .setmodal で click が来ても閉じない（文字を選ぶドラッグ）', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  const m = $(l, 'settingsModal');
  m.dispatchEvent({ type: 'pointerdown', target: $(l, 'dictionary') });
  m.dispatchEvent({ type: 'click', target: m });
  await l.drain();
  assert.ok(isOpen(l), '中で押して外で離したら閉じた');
  m.dispatchEvent({ type: 'click', target: m });
  await l.drain();
  assert.ok(isOpen(l), '外で押していない click で閉じた');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP3: 覚えたタブ { open: [page:pa1, settings], active: settings } で起動すると、上の帯は page:pa1 だけで、設定は開かない', T, async () => {
  const l = await open({ uiState: UI({ open: ['page:pa1', 'settings'], active: 'settings' }) });
  await l.drain();
  assert.deepStrictEqual(keysOf(l), ['page:pa1']);
  assert.strictEqual(tabs(l)[0].getAttribute('aria-selected'), 'true', '残りの最後のタブを開いていない');
  assert.ok(!isOpen(l), '覚えたタブの settings で設定を開いた');
  assert.deepStrictEqual(l.called('pageGet').map((c) => c.args[0]), ['pa1']);
  const only = await open({ uiState: UI({ open: ['settings'], active: 'settings' }) });
  await only.drain();
  assert.deepStrictEqual(keysOf(only), []);
  assert.ok(!isOpen(only));
  assert.deepStrictEqual([...l.errors, ...only.errors].map(fmt), []);
});

// 場面 esc-focus（helpers/mainrun.js の --dictate --focus-main-during-dictation）。音声入力の録音中に本体の窓へ focus、続けて blur を送る
const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const runMain = (args) => new Promise((resolve, reject) => {
  execFile(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout: 20000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});

test('SP2・RF9（場面 esc-focus）: 音声入力の録音中に本体の窓へフォーカスが来ると Escape の全体のホットキーを外し、離れると付け直す。録音の終わりには付いていない', { timeout: 20000 }, async () => {
  const o = await runMain(['text', '--dictate', '--focus-main-during-dictation']);
  // 録音の始め（窓は前にない）で付ける → focus で外す → blur で付け直す → 音声が届いて外す
  assert.deepStrictEqual(o.escape, ['register', 'unregister', 'register', 'unregister'], JSON.stringify(o.escape));
  assert.deepStrictEqual(o.escapeAt, { start: true, focus: false, blur: true, end: false });
  assert.strictEqual(o.history.length, 1, '音声入力が最後まで通らない');
});

// ---------------------------------------------------------------- U-2（SP4・SP5・F13）
// 計画「設定の項目とカード」の表（カードの見出し → 項目・行の名前）。外観とアカウントのカードは id の付いた <h2>
const CARDS = [
  ['account', 'アカウント', ['ログイン', 'ログアウト']],
  ['general', '外観', ['外観']],
  ['general', 'ホットキー', ['音声入力ホットキー', '議事録ホットキー']],
  ['general', '起動と終了', ['Windowsサインイン時に自動起動', 'ウィンドウを閉じてもタスクトレイに残す', '効果音']],
  ['record', '録音バー', ['録音バーの表示位置']],
  ['record', 'マイクと相手の声', ['使用するマイク', '議事録で相手の声も録る', '録音されるスピーカー']],
  ['record', '文字起こし', ['認識言語', '文字起こし後、カーソル位置へ自動貼り付け', 'フィラー除去']],
  ['record', 'ユーザー辞書（認識ヒント）', ['ユーザー辞書', '業務でよく使う言葉のヒントも渡す']],
  ['summary', '要約（Claude Code）', ['Claude Code', 'Claude Code の場所']],
  ['offline', 'オフライン', ['PC の中の文字起こし', 'PC の中の文字起こしを取り込む', '詳細設定']],
  ['update', 'アップデート', ['更新を確認']],
];
// 行の名前 → その行にある入力の id（今の id のまま動かしたことを見る）
const ROW_IDS = {
  ログイン: ['accountSignIn'], ログアウト: ['accountLogout', 'accountWho'], 外観: ['themeSel'], 音声入力ホットキー: ['hotkey', 'hotkeyWarn'], 議事録ホットキー: ['meetingHotkey', 'meetingHotkeyWarn'],
  Windowsサインイン時に自動起動: ['autoLaunch'], ウィンドウを閉じてもタスクトレイに残す: ['stayInTray'], 効果音: ['soundFeedback'], 録音バーの表示位置: ['pillPos'],
  使用するマイク: ['micSelect', 'micReloadBtn'], 議事録で相手の声も録る: ['useSystemAudio'], 録音されるスピーカー: ['spkNow', 'spkReloadBtn', 'spkSettingsBtn'], 認識言語: ['language'],
  '文字起こし後、カーソル位置へ自動貼り付け': ['autoPaste'], フィラー除去: ['removeFillers'], ユーザー辞書: ['dictionary', 'dictWarn'], 業務でよく使う言葉のヒントも渡す: ['useBuiltinTerms'],
  'Claude Code': ['claudeState', 'claudeTest', 'claudeLogin', 'claudeInstall', 'claudeHelp'], 'Claude Code の場所': ['claudeExe'], 'PC の中の文字起こし': ['engineState', 'testBtn'],
  'PC の中の文字起こしを取り込む': ['engineFetchBtn', 'engineFetchSummary'], 詳細設定: ['localServerExe', 'sumCtx', 'engineIdleMin'], 更新を確認: ['verNow', 'chkUpdBtn', 'applyUpdBtn', 'updMsg'],
};
const cardsOf = (root) => root.querySelector('#tabSettings').querySelector('.scroll').children.filter((c) => c.classList.contains('card'));
const titleOf = (c) => c.querySelector('h2').textContent.trim();
// 画面に出ている（hidden も、検索で外す印 set-miss も、祖先に無い）。ポップアップそのものの hidden は見ない
const visible = (el) => { for (let n = el; n && n.tagName && !n.tagName.startsWith('#'); n = n.parentNode) { if (n.id === 'settingsModal') return true; if (n.hidden || n.classList.contains('set-miss')) return false; } return true; };
const shownCards = (l) => cardsOf(l.root).filter(visible).map(titleOf);
const shownRows = (l) => l.byId.get('tabSettings').querySelectorAll('[data-row]').filter(visible).map((r) => r.dataset.row);
// 左の列の項目を押す（受け口は #setNav の1つ。偽 DOM は泡立たないので、#setNav に target 付きで送る）
const pick = async (l, sec) => { const nav = $(l, 'setNav'); nav.dispatchEvent({ type: 'click', target: nav.querySelector(`[data-sec="${sec}"]`) }); await l.drain(); };
const search = async (l, q) => { const b = $(l, 'setSearch'); b.value = q; b.dispatchEvent({ type: 'input', target: b }); await l.drain(); };

test('SP4: カードの data-sec と見出しの並びが「設定の項目とカード」の表のとおり。どのカードも .scroll の直の子で、行（data-row）はその行のカードの中', T, () => {
  const cards = cardsOf(doc);
  assert.deepStrictEqual(cards.map((c) => [c.dataset.sec, titleOf(c)]), CARDS.map(([sec, t]) => [sec, t]));
  assert.ok(doc.querySelector('#tabSettings').querySelectorAll('.card').every((c) => c.parentNode.classList.contains('scroll')), '.scroll の直の子でないカードがある');
  for (const [, t, rows] of CARDS) {
    const c = cards.find((x) => titleOf(x) === t);
    assert.deepStrictEqual(c.querySelectorAll('[data-row]').map((r) => r.dataset.row), rows, `${t} の行`);
    for (const r of c.querySelectorAll('[data-row]')) assert.strictEqual(r.parentNode, c, `「${r.dataset.row}」の行がカードの直の子でない（検索で外す単位）`);
  }
  assert.strictEqual(doc.querySelectorAll('[data-row]').length, Object.keys(ROW_IDS).length, '表に無い行がある');
  // 「動作」と「オンライン」のカードは無くなる（中の欄は表の所へ動く）
  assert.ok(!cards.some((c) => ['動作', 'オンライン'].includes(titleOf(c))), '前の「動作」「オンライン」のカードが残っている');
  // 項目の名前は左の列の名前と同じ（SETTINGS_SECS）
  assert.deepStrictEqual([...new Set(cards.map((c) => c.dataset.sec))], ['account', 'general', 'record', 'summary', 'offline', 'update']);
});

// 0.8.0（34c9dfa）の #tabSettings の中の <label> の文 29 と .desc の文 20 を、並びに依らず数えた指紋（空白をまとめて並べ替えた JSON の sha256）。
// カードを動かしただけで文を変えていないことを見る（文を意図して変えるタスクは、この値をその commit で直す）
const TEXTS_080 = { labels: [29, '5c94550c717872728cfa63e36897a6f63a01a343a21064bb62bf561c95fe948d'], descs: [20, 'dee8088740a63c227369dba4dfa7f08e93c986f527bd33ebecbf560598da8567'] };
test('SP4: 動かした入力の id が全部あり、その行の中にある。文が 0.8.0 と同じ（label の文・.check の文・説明の文）', T, () => {
  const sec = doc.querySelector('#tabSettings');
  for (const [name, ids] of Object.entries(ROW_IDS)) {
    const r = sec.querySelectorAll('[data-row]').find((x) => x.dataset.row === name);
    assert.ok(r, `${name} の行が無い`);
    for (const id of ids) {
      const el = doc.querySelector(`#${id}`);
      assert.ok(el, `#${id} が無い（id を消した）`);
      assert.ok(el.closest('[data-row]') === r, `#${id} が「${name}」の行の中に無い`);
    }
  }
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const fp = (xs) => [xs.length, require('node:crypto').createHash('sha256').update(JSON.stringify([...xs].sort())).digest('hex')];
  assert.deepStrictEqual(fp(sec.querySelectorAll('label').map((e) => norm(e.textContent))), TEXTS_080.labels, '<label> の文が 0.8.0 と違う');
  // 足した「当てはまる設定はありません」（#setEmpty）は数えない
  assert.deepStrictEqual(fp(sec.querySelectorAll('.desc').filter((e) => e.id !== 'setEmpty').map((e) => norm(e.textContent)).filter(Boolean)), TEXTS_080.descs, '説明の文が 0.8.0 と違う');
  // 「文字起こし」のカードの頭は、前の「オンライン」のカードの説明（行でない説明）
  const tc = cardsOf(doc).find((c) => titleOf(c) === '文字起こし');
  assert.match(tc.querySelector('.desc').textContent, /^ログインしていて、インターネットにつながっているときは、会議と音声入力の音声を文字起こしの中継に送り/);
  // .lockNote（記録中は変えられない）は今の欄に付いたまま
  assert.ok(doc.querySelector('#language').closest('.field').querySelector('.lockNote'), '認識言語の .lockNote が欄から外れた');
});

test('SP4: 『録音』を選ぶと、録音バー・マイクと相手の声・文字起こし・ユーザー辞書の4枚だけが出て、#setTitle が『録音』。保存の文と［データ保存先を開く］はどの項目でも出る', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  assert.deepStrictEqual(shownCards(l), ['外観', 'ホットキー', '起動と終了'], '初めの「一般」のカードが違う');
  await pick(l, 'record');
  assert.deepStrictEqual(shownCards(l), ['録音バー', 'マイクと相手の声', '文字起こし', 'ユーザー辞書（認識ヒント）']);
  assert.strictEqual($(l, 'setTitle').textContent, '録音');
  assert.ok(visible($(l, 'openDataBtn')) && visible($(l, 'saveMsg')), '保存の文と［データ保存先を開く］が隠れた');
  for (const [sec, want] of [['account', ['アカウント']], ['summary', ['要約（Claude Code）']], ['offline', ['オフライン']], ['update', ['アップデート']]]) {
    await pick(l, sec);
    assert.deepStrictEqual(shownCards(l), want, sec);
  }
  // showAccount・showEngineSettings で開いたときもその項目のカード
  l.fire('onNotice', '要約エンジンが未設定です（見本）'); await l.drain();
  assert.deepStrictEqual(shownCards(l), ['オフライン']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP5: 『マイク』で使用するマイクの行だけ、『ﾏｲｸ』（半角）でも同じ、『CLAUDE』で Claude Code の2行が当たり、小見出しは『録音』と『要約』。検索の間は左の列のどれも選ばない', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  const sb = $(l, 'setSearch');
  assert.strictEqual(sb.getAttribute('type'), 'search');
  assert.strictEqual(sb.getAttribute('placeholder'), '検索');
  assert.strictEqual(sb.getAttribute('aria-label'), '設定を検索');
  const groups = () => l.root.querySelectorAll('.setgroup').filter(visible).map((h) => h.textContent);
  for (const q of ['マイク', 'ﾏｲｸ']) {
    await search(l, q);
    assert.deepStrictEqual(shownRows(l), ['使用するマイク'], q);
    assert.deepStrictEqual(shownCards(l), ['マイクと相手の声'], q);
    assert.deepStrictEqual(groups(), ['録音'], q);
    assert.strictEqual($(l, 'setTitle').textContent, '検索の結果');
    assert.strictEqual($(l, 'setEmpty').hidden, true);
    assert.strictEqual(secOf(l), '(0 個)', '検索の間も左の列の項目を選んだまま');
  }
  await search(l, 'CLAUDE');
  assert.deepStrictEqual(shownRows(l), ['Claude Code', 'Claude Code の場所']);
  assert.deepStrictEqual(groups(), ['要約']);
  // 項目をまたぐ当たりは、項目ごとの小見出しの下に（左の列の順）
  await search(l, 'ホットキー');
  assert.deepStrictEqual(shownRows(l), ['音声入力ホットキー', '議事録ホットキー']);
  await search(l, '文字起こし');
  assert.deepStrictEqual(groups(), ['録音', 'オフライン']);
  // 説明の長い文の中までは探さない（行の名前だけ）
  await search(l, 'OpenAI');
  assert.deepStrictEqual(shownRows(l), [], '説明の文の中で当たった');
  // 消すと前の項目に戻る
  await search(l, '');
  assert.strictEqual(secOf(l), 'general');
  assert.deepStrictEqual(shownCards(l), ['外観', 'ホットキー', '起動と終了']);
  assert.deepStrictEqual(groups(), [], '小見出しが残った');
  assert.ok(l.byId.get('tabSettings').querySelectorAll('.set-miss').length === 0, '検索で外した印が残った');
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP5: 当たらない語で『当てはまる設定はありません』（カードは出さない）', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  await search(l, 'あてはまらない語（見本）');
  assert.strictEqual($(l, 'setEmpty').hidden, false);
  assert.strictEqual($(l, 'setEmpty').textContent.trim(), '当てはまる設定はありません');
  assert.deepStrictEqual(shownCards(l), []);
  assert.strictEqual($(l, 'setTitle').textContent, '検索の結果');
  assert.ok($(l, 'setEmpty').parentNode.classList.contains('scroll'));
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

test('SP5: 検索の欄で Esc を押すと文字が消えて、前の項目に戻る（閉じない）。空の欄の Esc は閉じる。左の列で項目を選ぶと検索をやめる', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  await pick(l, 'summary');
  const sb = $(l, 'setSearch');
  sb.focus();
  await search(l, 'マイク');
  const ev = await key(l, { key: 'Escape' }, sb);
  assert.strictEqual(ev.defaultPrevented, true);
  assert.ok(isOpen(l), '検索の欄の Esc で閉じた');
  assert.strictEqual(sb.value, '', '文字が消えない');
  assert.strictEqual(secOf(l), 'summary', '前の項目に戻らない');
  assert.deepStrictEqual(shownCards(l), ['要約（Claude Code）']);
  await key(l, { key: 'Escape' }, sb);
  assert.ok(!isOpen(l), '空の検索の欄の Esc で閉じない');
  await click(l, 'tabBtnSettings');
  await search(l, 'マイク');
  await pick(l, 'update');
  assert.strictEqual($(l, 'setSearch').value, '', '項目を選んでも検索の文字が残った');
  assert.deepStrictEqual(shownCards(l), ['アップデート']);
  // 閉じて開き直すと検索をやめて前の項目（開くときの selectSettingsSec が検索の文字を消す）
  await search(l, 'マイク');
  await click(l, 'setClose');
  await click(l, 'tabBtnSettings');
  assert.strictEqual($(l, 'setSearch').value, '');
  assert.deepStrictEqual(shownCards(l), ['アップデート']);
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// 行の名前の照らし先: その行の <label> の文・.check の span の最初の行・ボタンの文・<summary> の文・aria-label・aria-labelledby の要素の文・
// 状態の文（.eng-state。main の答えで描いた後）。名前はどれかの頭と同じ（検索で当たる語と、画面に出ている語を食い違わせない）
test('SP5: data-row の名前はどれも、その行のラベル（label の文か .check の span の最初の行か、ボタンの文など）の頭と同じ', T, async () => {
  const l = await open();
  await l.drain();
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const rows = l.byId.get('tabSettings').querySelectorAll('[data-row]');
  assert.strictEqual(rows.length, Object.keys(ROW_IDS).length, '行が表の数だけ無い（照らしが空振りする）');
  for (const r of rows) {
    const cands = [
      ...r.querySelectorAll('label').map((e) => e.textContent),
      ...(r.tagName === 'label' ? [r.textContent] : []),
      ...[r, ...r.querySelectorAll('.check')].filter((e) => e.classList.contains('check')).map((e) => (e.querySelector('span') ? e.querySelector('span').childNodes[0].textContent : '')),
      ...r.querySelectorAll('button').map((e) => e.textContent),
      ...r.querySelectorAll('summary').map((e) => e.textContent),
      ...r.querySelectorAll('[aria-label]').map((e) => e.getAttribute('aria-label')),
      ...r.querySelectorAll('[aria-labelledby]').map((e) => (l.document.getElementById(e.getAttribute('aria-labelledby')) || {}).textContent),
      ...r.querySelectorAll('.eng-state').map((e) => e.textContent),
    ].map(norm).filter(Boolean);
    assert.ok(cands.some((c) => c.startsWith(r.dataset.row)), `「${r.dataset.row}」がその行の画面の文の頭に無い: ${JSON.stringify(cands)}`);
  }
  assert.deepStrictEqual(l.errors.map(fmt), []);
});

// 0.8.0 の自動保存の引数（simrun の既定の getSettings を読んで、何も変えずに #tabSettings の change を起こしたとき）
const SAVED_080 = { localServerExe: 'C:\\srv\\whisper.exe', localModelPath: 'C:\\m\\ggml.bin', localThreads: 4, localPort: 8990, vadModelPath: '', useVad: true, suppressNst: true,
  sumServerExe: 'C:\\srv\\sum.exe', sumModelPath: 'C:\\m\\sum.gguf', sumThreads: 4, sumPort: 8991, sumCtx: 16384, engineIdleMin: 10, hotkey: 'Control+Shift+Space', meetingHotkey: 'Alt+M',
  segmentSec: 75, pillPos: 'bottom', micId: '', language: 'ja', autoPaste: true, removeFillers: true, soundFeedback: true, autoLaunch: false, dictionary: ['固有名詞'],
  useBuiltinTerms: true, stayInTray: false, theme: 'system', useSystemAudio: false, claudeExe: '' };
test('SP4: 選んだ項目でない欄を変えても、自動保存が今と同じ値を保存する（#tabSettings の change → saveSettings の引数が 0.8.0 と同じキーと値）', T, async () => {
  const l = await open();
  await l.drain();
  await click(l, 'tabBtnSettings');
  await pick(l, 'account');   // 録音の欄は隠れている
  $(l, 'autoPaste').checked = false;
  l.byId.get('tabSettings').dispatchEvent({ type: 'change', target: $(l, 'autoPaste') });
  await l.drain();
  const saved = l.called('saveSettings');
  assert.strictEqual(saved.length, 1, '自動保存が走らない（結線が切れた）');
  assert.deepStrictEqual(saved[0].args[0], { ...SAVED_080, autoPaste: false });
  // 検索の間も同じ
  await search(l, 'フィラー');
  $(l, 'removeFillers').checked = false;
  l.byId.get('tabSettings').dispatchEvent({ type: 'change', target: $(l, 'removeFillers') });
  await l.drain();
  assert.deepStrictEqual(l.called('saveSettings')[1].args[0], { ...SAVED_080, autoPaste: false, removeFillers: false });
  assert.deepStrictEqual(l.errors.map(fmt), []);
});
