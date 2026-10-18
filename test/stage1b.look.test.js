/*
 * stage1b.look.test.js — 第1b回の見た目の決まり（N1 の値・明暗の 4.5:1・ガラス風が無い・角丸・書体・フォーカスの輪・id が残る）
 * CSS は simcss で「規則」として読む（コメントの中の語には当たらない）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { parseHTML } = require('./helpers/simdom');
const S = require('./helpers/simcss');
const C = require('./helpers/css');

const APP = path.join(__dirname, '..', 'src', 'renderer', 'app.html');
const html = fs.readFileSync(APP, 'utf8');
const rules = S.parse(parseHTML(html).root.querySelectorAll('style').map((s) => s._raw).join('\n'));
const DARK = '@media (prefers-color-scheme: dark)';
const light = S.tokens(rules, '');
const dark = { ...light, ...S.tokens(rules, DARK) };

test('S: tokens と resolveVar は :root の宣言を読み、var() を解く（明と暗で別の値）', () => {
  assert.strictEqual(S.resolveVar(rules, 'var(--bg)', ''), '#ffffff');
  assert.strictEqual(S.resolveVar(rules, '1px solid var(--line)', DARK), '1px solid rgba(255,255,255,.094)');
  assert.strictEqual(S.resolveVar(rules, 'var(--nope, #123456)', ''), '#123456');
});

test('N1: 設計書の色の値（明・暗・夏の差し色）', () => {
  const want = { '--bg': ['#ffffff', '#191919'], '--side': ['#f7f7f5', '#202020'], '--text': ['#37352f', 'rgba(255,255,255,.81)'],
    '--line': ['rgba(55,53,47,.09)', 'rgba(255,255,255,.094)'], '--hover': ['rgba(55,53,47,.06)', 'rgba(255,255,255,.055)'],
    '--accent': ['#0a7b9c', '#45b8d8'], '--on-accent': ['#ffffff', '#10242a'], '--level': ['#0e8cae', '#0e8cae'] };
  for (const [k, [l, d]] of Object.entries(want)) {
    assert.strictEqual(light[k].replace(/\s/g, ''), l, `明の ${k}`);
    assert.strictEqual(dark[k].replace(/\s/g, ''), d, `暗の ${k}`);
  }
});

test('N1: 夏の小さな差し色（選んでいるページの左端の 2px の強調・録音中の点の海の色）', () => {
  assert.match(Object.values(S.declsFor(rules, '.pitem.sel', { at: '' })).join(' '), /2px[^;]*var\(--accent\)|var\(--accent\)[^;]*2px/);
  assert.strictEqual(S.declsFor(rules, '.rec-dot', { at: '' }).background, 'var(--level)');
});

test('N1: 書体は OS 標準の並び（N1 のとおり）', () => {
  assert.strictEqual(S.declsFor(rules, 'body', { at: '' })['font-family'], '-apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", sans-serif');
});

test('画面の使いやすさ・F10: 明と暗のすべての「文字 × 地」の組で 4.5:1 以上（ホバー・薄い強調の地の上も）', () => {
  const TEXT = ['--text', '--muted', '--accent-text', '--danger', '--ok'];
  for (const [name, t] of [['明', light], ['暗', dark]]) {
    const base = ['--bg', '--side'].map((g) => C.color(t[g]));
    const grounds = [...base.map((g, i) => ({ g, why: ['地', 'サイドバー'][i] })),
      ...base.map((g, i) => ({ g: C.over(C.color(t['--hover']), g), why: `${['地', 'サイドバー'][i]}のホバー` })),
      ...base.map((g, i) => ({ g: C.over(C.color(t['--tint']), g), why: `${['地', 'サイドバー'][i]}の薄い強調` }))];
    for (const k of TEXT) for (const { g, why } of grounds) {
      const c = C.contrast(C.color(t[k]), g);
      assert.ok(c >= 4.5, `${name}: ${k}（${t[k]}）が${why}の上で ${c.toFixed(2)}`);
    }
    const onAccent = C.contrast(C.color(t['--on-accent']), C.color(t['--accent']));
    assert.ok(onAccent >= 4.5, `${name}: 強調の面の上の文字が ${onAccent.toFixed(2)}`);
  }
});

test('録音バーは触らない: overlay.html は第1b回の前（HEAD 21872fa。最後に変えたのは ce93e99）と1バイトも違わない', () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay.html'));
  assert.strictEqual(require('node:crypto').createHash('sha256').update(buf).digest('hex'), 'f01892bb7b5a7b3ce73c828777c07d6510848b5a93d74afea54d1f3f32d8808e');
});

test('N1: ガラス風をやめた（backdrop-filter・グラデーション・ぼかし玉・filter: blur が無い）', () => {
  for (const r of rules) for (const [k, v] of Object.entries(r.decls)) {
    assert.ok(!/backdrop-filter/.test(k), `${r.sel} に ${k}`);
    assert.ok(!/gradient\(/.test(v), `${r.sel} { ${k}: ${v} }`);
    assert.ok(!(k === 'filter' && /blur/.test(v)), `${r.sel} にぼかし`);
  }
  assert.ok(!/class="(bg|blob)\b/.test(html), '飾りのぼかし玉の要素が残っている');
});

test('N1: 角丸は 6px まで（例外は設定のトグルと丸い点）。影は浮く部品の --shadow だけで、青い影が無い', () => {
  const ROUND_OK = new Set(['.check input', '.check input::after', '.rec-dot', '#updBadge .dot']);
  for (const r of rules) {
    const v = r.decls['border-radius'];
    if (!v || r.sel.split(',').every((s) => ROUND_OK.has(s.trim()))) continue;
    for (const n of String(v).match(/[\d.]+(?=px)/g) || []) assert.ok(Number(n) <= 6, `${r.sel} { border-radius: ${v} }`);
    assert.ok(!/%/.test(v), `${r.sel} { border-radius: ${v} }`);
  }
  for (const r of rules) {
    const v = r.decls['box-shadow'];
    if (v) assert.match(v.trim(), /^(none|var\(--shadow\))$/, `${r.sel} の影は --shadow だけ`);
  }
  // 影のトークンそのものも色づかない（明・暗とも。トークンの中の青い影を見逃さない）
  for (const [name, t] of [['明', light], ['暗', dark]]) for (const c of C.colorsIn(t['--shadow'])) {
    assert.ok(Math.abs(c.r - c.g) <= 8 && Math.abs(c.g - c.b) <= 8, `${name}の --shadow ${c.raw} が色づいている`);
  }
});

test('F10: 規則の文字の色は文字のトークンだけ、地は地のトークンだけ、生の色は書かない（4.5:1 を計った組の外の色を使わせない）', () => {
  const TEXT = /^(var\(--(text|muted|accent-text|danger|ok|on-accent)\)|inherit|currentcolor|transparent)$/i;
  const GROUND = /^(var\(--(bg|side|hover|tint|accent|level|line)\)|transparent|none)$/i;
  const RAW = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;
  const decor = (sel) => sel.split(',').every((s) => /^\.check input/.test(s.trim()) || ['.rec-dot', '#updBadge .dot'].includes(s.trim()));   // 文字を持たない飾り
  for (const r of rules) {
    if (r.sel === ':root') continue;   // トークンの定義（明・暗）
    for (const [k, v] of Object.entries(r.decls)) if (!k.startsWith('--')) assert.ok(!RAW.test(v), `${r.sel} { ${k}: ${v} } に生の色`);
    if (r.decls.color) assert.match(r.decls.color.trim(), TEXT, `${r.sel} の文字の色（強調の面の色 --accent・--level を文字にしない）`);
    const bg = r.decls.background || r.decls['background-color'];
    if (!bg) continue;
    assert.match(bg.trim(), GROUND, `${r.sel} の地`);
    if (/var\(--(level|line)\)/.test(bg)) assert.ok(decor(r.sel), `${r.sel}: --level・--line は飾りの地だけ（文字の地にしない）`);
    if (/var\(--accent\)/.test(bg) && !decor(r.sel)) assert.match(r.decls.color || '', /var\(--on-accent\)/, `${r.sel}: 強調の面の上の文字は --on-accent`);
  }
  for (const m of html.matchAll(/style="([^"]*)"/g)) assert.ok(!RAW.test(m[1]), `インラインの style に生の色: ${m[1]}`);
  for (const m of html.matchAll(/style\.(?:color|background(?:Color)?)\s*=\s*([^;\n]+)/g)) {
    assert.ok(!RAW.test(m[1]) && !/--(accent|level|line)\)/.test(m[1]), `JS で付ける色: ${m[1]}`);
  }
});

test('simrun: document の keydown の受け口を l.key で呼べ、focus() で document.activeElement が動く', async () => {
  const { load } = require('./helpers/simrun');
  const l = await load('x.html', { html: '<body><button id="a"></button><script>document.addEventListener("keydown", (e) => { if (e.key === "k" && e.ctrlKey) { e.preventDefault(); document.getElementById("a").focus(); } });</script></body>' });
  const ev = l.key({ key: 'k', ctrlKey: true });
  assert.strictEqual(l.document.activeElement, l.byId.get('a'));
  assert.strictEqual(ev.defaultPrevented, true, 'preventDefault が defaultPrevented に残らない');
  assert.strictEqual(l.key({ key: 'k' }).defaultPrevented, false);
});

test('simdom: [属性="値"] と [属性] のセレクタが当たる（今は黙って何にも当たらない）', () => {
  const { root } = parseHTML('<div id="bar"><span role="tab" data-key="a"></span><span role="tab" aria-selected="true"></span><b role="menuitem"></b></div>');
  assert.strictEqual(root.querySelectorAll('[role="tab"]').length, 2);
  assert.strictEqual(root.querySelectorAll('#bar [role="menuitem"]').length, 1);
  assert.strictEqual(root.querySelectorAll('span[aria-selected]').length, 1);
  assert.strictEqual(root.querySelectorAll('[role="tablist"]').length, 0);
});

// 意図: 配線テストと画面テストを壊さないため、今の id は1つも消さない。設計書「id を残す理由」
const IDS_1A_1C = ['tabBtnNotes', 'tabBtnDictation', 'tabBtnSettings', 'tabNotes', 'mtToggleBtn', 'mtDiscardBtn', 'searchBox', 'fltAll', 'fltActions', 'fltFull', 'plist',
  'pageWrap', 'pTitle', 'pProps', 'pTypeRow', 'pType', 'pTypeHint', 'pActs', 'paneBtnNote', 'paneBtnScript', 'paneBtnMemo', 'pBody', 'pProgress', 'pNote', 'pScript', 'pMemo',
  'tabDictation', 'stToday', 'stTotal', 'stSaved', 'recBtn', 'histSearch', 'clearBtn', 'histList', 'tabSettings', 'verNow', 'chkUpdBtn', 'applyUpdBtn', 'updMsg', 'updNotes',
  'themeSel', 'hotkey', 'hotkeyWarn', 'meetingHotkey', 'meetingHotkeyWarn', 'pillPos', 'micSelect', 'micReloadBtn', 'useSystemAudio', 'spkField', 'spkNow', 'spkReloadBtn',
  'spkSettingsBtn', 'language', 'autoPaste', 'removeFillers', 'soundFeedback', 'autoLaunch', 'stayInTray', 'dictionary', 'dictWarn', 'useBuiltinTerms', 'onlineAskNote',
  'cloudTranscribe', 'sttProvider', 'sttBaseUrl', 'sttModel', 'sttKey', 'sttKeySave', 'sttKeyTest', 'sttKeyClear', 'sttKeyState', 'claudeState', 'claudeTest', 'claudeHelp',
  'claudeExe', 'onlineMsg', 'engineState', 'testBtn', 'testMsg', 'testSumMsg', 'engineNote', 'engineFetch', 'engineFetchSummary', 'engineFetchBar', 'engineFetchBtn',
  'engineFetchPause', 'engineFetchSwitch', 'engineDirBtn', 'engineFetchCopy', 'engineFetchMsg', 'engineFetchList', 'engineFetchRows', 'engineAdv', 'localServerExe',
  'pickExeBtn', 'localModelPath', 'pickModelBtn', 'localThreads', 'localPort', 'useVad', 'vadState', 'vadModelPath', 'pickVadBtn', 'suppressNst', 'sumServerExe',
  'pickSumExeBtn', 'sumModelPath', 'pickSumModelBtn', 'sumThreads', 'sumPort', 'sumCtx', 'testSumBtn', 'segmentSec', 'engineIdleMin', 'saveMsg', 'openDataBtn', 'toast',
  'updBadge', 'liveTitle', 'liveSkipBtn', 'liveTm', 'liveEta', 'liveSkipped', 'liveMic', 'meetingLocalOnly', 'meetingLocalOnlyNote'];
test('N2・F9: 第1b回の前からある id は1つも消えていない（作る id は setMeetingUi の中に残る）', () => {
  for (const id of IDS_1A_1C) assert.ok(html.includes(`id="${id}"`), `id="${id}" が消えた`);
});
