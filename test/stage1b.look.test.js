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
  // 第1b2回 L-1: 暗の --line を測った参考の値にした（読み方の確かめは同じ）
  assert.strictEqual(S.resolveVar(rules, '1px solid var(--line)', DARK), '1px solid rgba(255,255,235,.1)');
  assert.strictEqual(S.resolveVar(rules, 'var(--nope, #123456)', ''), '#123456');
});

// 第1b2回 L-1: 設計書の N1 を測った参考の値に直した（2026-10-19 の利用者の決定。全部の値は stage1b2.look.test.js）
test('N1: 設計書の色の値（明・暗・夏の差し色）', () => {
  const want = { '--bg': ['#ffffff', '#191919'], '--side': ['#f9f8f7', '#202020'], '--text': ['#2c2c2b', '#f0efed'],
    '--line': ['rgba(28,19,1,.11)', 'rgba(255,255,235,.1)'], '--hover': ['rgba(33,27,23,.051)', 'rgba(255,255,255,.055)'],
    '--accent': ['#2077ce', '#2077ce'], '--on-accent': ['#ffffff', '#ffffff'], '--level': ['#0e8cae', '#0e8cae'] };
  for (const [k, [l, d]] of Object.entries(want)) {
    assert.strictEqual(light[k].replace(/\s/g, ''), l, `明の ${k}`);
    assert.strictEqual(dark[k].replace(/\s/g, ''), d, `暗の ${k}`);
  }
});

// 「N1: 夏の小さな差し色」は第1b2回 L-1 で消した（選んでいる行の左の線をやめた）。stage1b2.look.test.js の海の色のテストが置き換わる
test('N1: 書体は OS 標準の並び（第1b2回 L-1 で Segoe UI Variable から）', () => {
  assert.strictEqual(S.declsFor(rules, 'body', { at: '' })['font-family'], '"Segoe UI Variable Text", "Segoe UI", "Yu Gothic UI", "Hiragino Sans", "Noto Sans JP", sans-serif');
});

test('画面の使いやすさ・F10: 明と暗のすべての「文字 × 地」の組で 4.5:1 以上（ホバー・薄い強調の地の上も）', () => {
  const TEXT = ['--text', '--text-2', '--muted', '--accent-text', '--danger', '--ok'];   // 第1b2回 L-1: --text-2 を足した（地は同じ6つ）
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

// 0.9.0 O-3・O-4 で意図して変えた: 利用者が D25 で凍結を解き、録音バーを作り直した（O-3 の見た目と O-4 の縦の形の ×）。O-4 の最後の中身の
// ハッシュにして、凍結をかけ直した。変えるのは利用者の決定のときだけ（D25 で一度解いた）
// 0.9.0 見た目の直し（利用者に見せる前の見直しの指示）で意図して変えた: 縦の形の縦書きを縦向きの字（「︱」「︙」）にし、禁則で2字並ばないようにした。
// その中身のハッシュで凍結をかけ直した（O-4 の値は 943d8c9a…）
// 0.9.3 M-5 で意図して変えた: 利用者が問い Q1 で「録音バーに音の大きさを答える受け口を数行足す」ことを認めたので、凍結を解いて受け口（onLevelAsk → reportLevel）
// だけを <script> に足した（見た目・点・文・区切り・無音の見張りは変えない）。その中身のハッシュで凍結をかけ直した（0.9.0 の値は 788dad76…）
// 0.9.4 W-1 で意図して変えた: 持ち主の決定（2026-10-22「5本がそれぞれ揺れる」・録音中のページと同じ）で凍結を解き、5つの点の長さを mainlib.levelBars と
// 同じ式（左右対称の重み・1本ずつ違う速さの揺れ・動きを減らす設定では揺らさない）にした。その中身のハッシュで凍結をかけ直した（0.9.3 の値は 8f6d2fac…）
// 0.9.4 P-1 で意図して変えた: 持ち主の決定（2026-10-22「スピーカーのロゴはいらない」「✅マークはもういらない」「そのまますっと消える」・F1〜F4・Q24）で
// 凍結を解き、相手の声の印と完了の印を外し、止めた・済んだときは薄く消え、録れない文を録音中ずっと（縦の形は角の点と説明の文）にした。その中身で凍結をかけ直した（W-1 の値は 35a9a04c…）
// 0.11.1 LG-2 で意図して変えた: ロゴの差し替え（2026-10-24 の持ち主の決定 L-2・LG6「ロゴの所だけ変えてよい」）で凍結を解き、ロゴの SVG の path を
// 新しいロゴ（assets/icon.svg と同じ2本）にし、注の「3本」を「2本」にした（ほかは1バイトも変えない）。その中身で凍結をかけ直した（0.9.4 の値は c14a7309…）
// 0.11.1 LG-4 で意図して変えた: 同じ持ち主の決定（LG6「ロゴの SVG とその色の CSS だけ」・LG2「暗い所は白い箱に黒いリス」）で、ロゴの2本の path に
// 箱とリスの印（class）を付けて塗りの属性を外し、色の CSS（白い箱・ピルの地の色のリス）を2行と注を足した。その中身で凍結をかけ直した（LG-2 の値は eab70854…）
// 0.12.0 SP-2 で意図して変えた: 持ち主の D53・D66（文字起こしの「自分」「相手」・別々に文字起こし）で、<script> の中だけを変えた（マイクと相手の声を
// 別々の MediaRecorder で録り、流れごとの区間の番号・始まりの時計・最後を送る。main に言われた流れの区間を切る）。見た目（<style>・DOM・点・印）は変えない。
// その中身で凍結をかけ直した（0.11.1 の値は ac78ef07…）。<script> の外は 0.11.1（bbd8a51）と1バイトも違わないことを下のテストで見る
// 0.13.0 CLK-1 で意図して変えた: 持ち主の答え（2026-10-27「録音バーとページの両方を直す（おすすめ）」）で、<script> の中の時計だけを変えた（250ms の時計を
// startClock() にまとめ、再開でも動かす）。見た目は変えない（下のテストの <script> の外の値はそのまま）。その中身で凍結をかけ直した（0.12.0 の値は a4d97388…）
// 0.13.0 CLK-2 で意図して変えた: 同じ答えで、再開でマイクを開き直している間の押し直しを見直す所（<script> の中だけ）を足した（CLK-1 の値は a6bbc7d6…）
test('録音バーは触らない（D25 で 0.9.0 の形にした。変えるのは利用者の決定のときだけ）: overlay.html は時計のずれの直し（0.13.0 CLK。<script> の中だけ）で直した中身と1バイトも違わない', () => {
  const buf = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay.html'));
  assert.strictEqual(require('node:crypto').createHash('sha256').update(buf).digest('hex'), 'd186b9d092e356f1b4bc779819707845756af28918244a4d8c224f14edfdbb67');
});
test('0.12.0 SP-2: <script> の中身を除いた overlay.html は 0.11.1（bbd8a51）と1バイトも違わない（見た目を変えない）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'overlay.html'), 'utf8');
  assert.strictEqual((src.match(/<script>/g) || []).length, 1);
  const outside = src.replace(/<script>[\s\S]*?<\/script>/, '<script></script>');
  assert.strictEqual(require('node:crypto').createHash('sha256').update(outside).digest('hex'), '9da5c78766f7688687f4d9b1c3d306236de3d2ed4b8cfe46327f5f413b5c3938');
});

test('N1: ガラス風をやめた（backdrop-filter・グラデーション・ぼかし玉・filter: blur が無い）', () => {
  for (const r of rules) for (const [k, v] of Object.entries(r.decls)) {
    assert.ok(!/backdrop-filter/.test(k), `${r.sel} に ${k}`);
    assert.ok(!/gradient\(/.test(v), `${r.sel} { ${k}: ${v} }`);
    assert.ok(!(k === 'filter' && /blur/.test(v)), `${r.sel} にぼかし`);
  }
  assert.ok(!/class="(bg|blob)\b/.test(html), '飾りのぼかし玉の要素が残っている');
});

// 第1b2回 L-1: 部品は 6px まで・まとまり（会議のブロック・検索の窓・囲み）は 10px まで・丸いタブは 14px（高さ 28px の丸）
test('N1: 角丸は部品 6px・まとまり 10px・丸いタブ 14px まで（例外は設定のトグルと丸い点）。影は浮く部品の --shadow だけで、青い影が無い', () => {
  // 0.9.2 I-2 で意図して変えた: 設定の ⓘ（.setinfo）の丸も、文字を持たない飾りの丸（トグル・点と同じ）
  const ROUND_OK = new Set(['.check input', '.check input::after', '.rec-dot', '#updBadge .dot', '.setinfo']);
  // 0.9.0 U-1（SP1・D24）で意図して変えた: 設定のポップアップの箱（.setbox）も角丸 10px のまとまり（計画 U-1 の「角丸 10px（まとまり）」）
  const R10 = new Set(['.mblock', '.palbox', '.note', '.setbox']);
  const R14 = new Set(['.ptab']);
  const limit = (sel) => sel.split(',').map((s) => s.trim()).reduce((m, s) => Math.max(m, R14.has(s) ? 14 : R10.has(s) ? 10 : 6), 0);
  for (const r of rules) {
    const v = r.decls['border-radius'];
    if (!v || r.sel.split(',').every((s) => ROUND_OK.has(s.trim()))) continue;
    for (const n of String(v).match(/[\d.]+(?=px)/g) || []) assert.ok(Number(n) <= limit(r.sel), `${r.sel} { border-radius: ${v} }`);
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
  // 第1b2回 L-1: 文字に --text-2、地に --scrim（検索の窓の後ろ。飾りの地だけ）を足した
  const TEXT = /^(var\(--(text|text-2|muted|accent-text|danger|ok|on-accent)\)|inherit|currentcolor|transparent)$/i;
  const GROUND = /^(var\(--(bg|side|hover|tint|accent|level|line|scrim)\)|transparent|none)$/i;
  const RAW = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;
  // 0.9.3 M-6 で意図して足した: 録音中のページの音の波の棒（#liveWave i。文字を持たない飾り。音のある棒は --level、一時停止は --line）
  const decor = (sel) => sel.split(',').every((s) => /^\.check input/.test(s.trim()) || ['.rec-dot', '#updBadge .dot', '#palette', '#liveWave i', '#liveWave.paused i'].includes(s.trim()));   // 文字を持たない飾り
  // 0.9.3 M-6 で意図して足した: 無音の点（#liveWave.quiet i）だけは地に文字のトークン --muted を使う（点は文字を載せない飾りで、文字の色と同じ灰色に見せる）
  // 0.9.4 W-1 で意図して変えた: 点は録音バーと同じ5つで、無音も声も文字の灰色（--text-2。持ち主の答え「青を使わない」）。無音の色分け（.quiet）は無くした
  const MUTED_DOT = '#liveWave i';
  for (const r of rules) {
    if (r.sel === ':root') continue;   // トークンの定義（明・暗）
    if (r.sel === MUTED_DOT) { assert.strictEqual((r.decls.background || '').trim(), 'var(--text-2)', MUTED_DOT); continue; }
    for (const [k, v] of Object.entries(r.decls)) if (!k.startsWith('--')) assert.ok(!RAW.test(v), `${r.sel} { ${k}: ${v} } に生の色`);
    if (r.decls.color) assert.match(r.decls.color.trim(), TEXT, `${r.sel} の文字の色（強調の面の色 --accent・--level を文字にしない）`);
    const bg = r.decls.background || r.decls['background-color'];
    if (!bg) continue;
    assert.match(bg.trim(), GROUND, `${r.sel} の地`);
    if (/var\(--(level|line)\)/.test(bg)) assert.ok(decor(r.sel), `${r.sel}: --level・--line は飾りの地だけ（文字の地にしない）`);
    // 0.9.0 U-1（SP1・D24）で意図して変えた: 設定のポップアップの後ろ（.setmodal）も検索の窓と同じ --scrim（文字を載せない飾りの地）
    if (/var\(--scrim\)/.test(bg)) assert.ok(r.sel === '#palette' || r.sel === '.setmodal', `${r.sel}: --scrim は検索の窓と設定のポップアップの後ろだけ`);
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
  'spkSettingsBtn', 'language', 'autoPaste', 'removeFillers', 'soundFeedback', 'autoLaunch', 'stayInTray', 'dictionary', 'dictWarn', 'useBuiltinTerms',
  'claudeState', 'claudeTest', 'claudeHelp',
  'claudeExe', 'onlineMsg', 'engineState', 'testBtn', 'testMsg', 'engineNote', 'engineFetch', 'engineFetchSummary', 'engineFetchBar', 'engineFetchBtn',
  'engineFetchPause', 'engineFetchSwitch', 'engineDirBtn', 'engineFetchCopy', 'engineFetchMsg', 'engineFetchList', 'engineFetchRows', 'engineAdv', 'localServerExe',
  'pickExeBtn', 'localModelPath', 'pickModelBtn', 'localThreads', 'localPort', 'useVad', 'vadState', 'vadModelPath', 'pickVadBtn', 'suppressNst',
  'segmentSec', 'engineIdleMin', 'saveMsg', 'openDataBtn', 'toast',
  'updBadge', 'liveTitle', 'liveSkipBtn', 'liveTm', 'liveEta', 'liveSkipped', 'liveMic', 'meetingLocalOnly', 'meetingLocalOnlyNote'];
// 0.7.0 U-1（設計書 D5）で意図して消した5つ: 同意の案内の行・同意・送り先・URL・モデルの欄（一覧から外し、消えたことを見る）
const IDS_D5_REMOVED = ['onlineAskNote', 'cloudTranscribe', 'sttProvider', 'sttBaseUrl', 'sttModel'];
// 第1d回 A-4（RL10・F11）で意図して消した6つ: D5 の［詳細設定（管理者用）］の鍵の欄（文字起こしは中継へ送り、PC に会社の鍵を置かない）。
// 一覧から外し、消えたことを見る
const IDS_1D_REMOVED = ['onlineAdv', 'sttKey', 'sttKeySave', 'sttKeyTest', 'sttKeyClear', 'sttKeyState'];
// 0.10.0 LS-3（D59）で意図して消した10: 詳細設定の要約のエンジンの欄（要約は Claude Code。一覧から外し、消えたことを見る）
const IDS_LS3_REMOVED = ['testSumMsg', 'sumServerExe', 'pickSumExeBtn', 'sumModelPath', 'pickSumModelBtn', 'sumThreads', 'sumPort', 'sumCtx', 'testSumBtn', 'setPopSThreads'];
test('N2・F9: 第1b回の前からある id は1つも消えていない（作る id は setMeetingUi の中に残る。D5 で意図して消した5つと、1d で意図して消した6つと、0.10.0 LS-3 で意図して消した10を除く）', () => {
  for (const id of IDS_1A_1C) assert.ok(html.includes(`id="${id}"`), `id="${id}" が消えた`);
  for (const id of [...IDS_D5_REMOVED, ...IDS_1D_REMOVED, ...IDS_LS3_REMOVED]) assert.ok(!html.includes(`id="${id}"`) && !html.includes(`$('${id}')`), `id="${id}" が残っている`);
});

// 偽 DOM に配置が無いので、宣言で見る。見た目そのものは C-2 の画像。.pcol は本文の列
test('N4: 本文は中央に最大 720px、題名は 40px の太字', () => {
  const body = S.declsFor(rules, '.pcol', { at: '' });
  assert.strictEqual(body['max-width'], '720px');
  assert.match(body.margin || `${body['margin-left']} ${body['margin-right']}`, /auto/);
  const t = S.declsFor(rules, '.ptitle', { at: '' });
  assert.deepStrictEqual([t['font-size'], t['font-weight']], ['40px', '700']);
});

// 計画の .ttab・.ttab .x は、B-3 で作った上のタブの class（.tabitem・その × の .tx）に読み替えた
test('画面の使いやすさ・F12: 新しい部品のすべてに :focus-visible の輪がある', () => {
  for (const sel of ['.tabitem:focus-visible', '.tabitem .tx:focus-visible', '#sideGrip:focus-visible', '#sideCollapse:focus-visible', '#sideExpand:focus-visible',
    '#pMore:focus-visible', '#pMenu [role="menuitem"]:focus-visible', '.ptabs [role="tab"]:focus-visible', '#livePauseBtn:focus-visible']) {
    const r = rules.find((x) => x.sel.split(',').map((s) => s.trim()).includes(sel));
    assert.ok(r && r.decls.outline && !/none/.test(r.decls.outline), `${sel} に輪が無い`);
  }
});

test('N5: 設定の区画は平ら（地も影も持たない）。音声入力の履歴は線で区切った素の一覧', () => {
  const card = S.declsFor(rules, '.card', { at: '' });
  assert.ok(!card.background || /var\(--bg\)|transparent/.test(card.background), card.background);
  assert.ok(!card['box-shadow'] || card['box-shadow'] === 'none');
  assert.match(S.declsFor(rules, '.entry', { at: '' })['border-bottom'] || '', /var\(--line\)/);
});

test('画面の使いやすさ・F11: 狭い画面（200% の 560px）で詰める規則があり、タブの帯は横に捲れる', () => {
  assert.ok(rules.some((r) => /max-width:\s*760px/.test(r.at) && r.sel.includes('.ptitle')), '狭い画面の規則が無い');
  assert.strictEqual(S.declsFor(rules, '#tabbar', { at: '' })['overflow-x'], 'auto');
});
