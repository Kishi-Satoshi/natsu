/*
 * mutate.test.js — 自動の変異確認（第1a回 G3。tools/mutate.js・tools/mutants.js）
 * 本番の変異確認は CI の mutate のジョブが回す（全部の変異で数分）。ここでは小さな見本のリポジトリで道具の決め方を見て、
 * 一覧がどれも今のファイルにちょうど1回当たる（古くなっていない）ことを見る。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../tools/mutate');
const MUTANTS = require('../tools/mutants');
const { jobsOf, stepsOf } = require('./helpers/yml');

const ROOT = path.join(__dirname, '..');
const ADD_SRC = "'use strict';\n// 足す\nmodule.exports = (a, b) => a + b;\n";
const made = [];
test.after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* noop */ } } });
function fixtureRepo({ red = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-変異𠮷-'));
  made.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'test'));
  fs.mkdirSync(path.join(root, 'tools'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","private":true}');
  fs.writeFileSync(path.join(root, 'README.md'), '# 見本\n');   // src・test・tools の外のファイル（写しに無いと元のテストが赤くなる）
  fs.writeFileSync(path.join(root, 'src', 'add.js'), ADD_SRC);
  fs.writeFileSync(path.join(root, 'test', 'add.test.js'),
    `'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert');\nconst fs = require('node:fs');\nconst path = require('node:path');\nconst add = require('../src/add');\ntest('足し算', () => { assert.ok(fs.existsSync(path.join(__dirname, '..', 'README.md'))); assert.strictEqual(add(1, 2), ${red ? 4 : 3}); });\n`);
  return root;
}

test('G3・F10: 変異の一覧は、どれも今のファイルにちょうど1回だけ当たり、id は重ならず、テストのファイルがある', { timeout: 5000 }, () => {
  assert.deepStrictEqual(M.findStale(MUTANTS, (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')), []);
  assert.ok(MUTANTS.length >= 6);
  assert.strictEqual(new Set(MUTANTS.map((m) => m.id)).size, MUTANTS.length);
  for (const m of MUTANTS) {
    assert.ok(m.id && m.why && m.from !== m.to && m.tests.length, m.id);
    assert.ok(m.also === undefined || (Array.isArray(m.also) && m.also.length && m.also.every((x) => x && x.from && x.from !== x.to)), `${m.id}: also`);
    for (const t of m.tests) assert.ok(fs.existsSync(path.join(ROOT, t)), `${m.id}: ${t}`);
  }
});

test('G3: applyMutant はちょうど1回だけ置き換え、0 回や2回なら投げる', { timeout: 5000 }, () => {
  assert.strictEqual(M.applyMutant('a + b', { from: '+', to: '-' }), 'a - b');
  assert.throws(() => M.applyMutant('a + b', { from: '*', to: '/' }));
  assert.throws(() => M.applyMutant('a + b + c', { from: '+', to: '-' }));
});

// 第2a1回 G-3: 離れた2か所を一緒に戻さないと見えない直し（片方だけでは、もう片方が守るので同じ動き）は also に足す。
// also の from も、前の置き換えの後の文字にちょうど1回（当たらなければ古い）
test('G3: also のある変異は、本体の後に also を順に1回ずつ置き換え、どれかが 0 回や2回なら投げて古いと数える', { timeout: 5000 }, () => {
  const m = { from: 'a + b', to: 'a - b', also: [{ from: 'x * y', to: 'x / y' }] };
  assert.strictEqual(M.applyMutant('a + b; x * y', m), 'a - b; x / y');
  assert.throws(() => M.applyMutant('a + b; x + y', m));
  assert.throws(() => M.applyMutant('a + b; x * y; x * y', m));
  assert.deepStrictEqual(M.findStale([{ id: 'ok', file: 'f', ...m }, { id: 'old', file: 'g', ...m }], (f) => (f === 'f' ? 'a + b; x * y' : 'a + b; x + y')), ['old']);
});

test('G3・F10: 小さな見本で、殺される・生き残る・古い（当たらない）変異を見分け、元のファイルは変えない（写しは src・test・tools の外も写す）', { timeout: 20000 }, async () => {
  const root = fixtureRepo();
  const r = await M.runAll({ root, jobs: 1, mutants: [
    { id: 'kill', file: 'src/add.js', from: 'a + b', to: 'a - b', tests: ['test/add.test.js'], why: '足し算' },
    { id: 'live', file: 'src/add.js', from: '// 足す', to: '// たす', tests: ['test/add.test.js'], why: '注釈だけ（生き残る）' },
    { id: 'old', file: 'src/add.js', from: 'a * b', to: 'a / b', tests: ['test/add.test.js'], why: '無い文字' },
  ] });
  assert.deepStrictEqual(r.map((x) => [x.id, x.status]), [['kill', 'killed'], ['live', 'survived'], ['old', 'stale']]);
  assert.strictEqual(M.exitCodeOf(r), 1);
  assert.strictEqual(M.exitCodeOf(r.filter((x) => x.status === 'killed')), 0);
  assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'add.js'), 'utf8'), ADD_SRC);
});

// 第2a1回 G-3: 場面（mainrun）を使う重いテストのファイルは、赤になるテストの名前だけを回す（pattern は --test-name-pattern に渡す。
// CI の mutate を 20 分に収めるため）。名前に当たらなければ何も走らず「生き残り」に見える（黙って殺したと数えない）
test('G3: pattern のある変異は、その名前のテストだけを回す（当たらない名前なら生き残りに見える）', { timeout: 20000 }, async () => {
  const root = fixtureRepo();
  const r = await M.runAll({ root, jobs: 1, mutants: [
    { id: 'kill-pat', file: 'src/add.js', from: 'a + b', to: 'a - b', tests: ['test/add.test.js'], pattern: '^足し算$', why: '名前が当たる' },
    { id: 'miss-pat', file: 'src/add.js', from: 'a + b', to: 'a - b', tests: ['test/add.test.js'], pattern: '^無い名前$', why: '名前が当たらない' },
  ] });
  assert.deepStrictEqual(r.map((x) => [x.id, x.status]), [['kill-pat', 'killed'], ['miss-pat', 'survived']]);
});

test('G3: pattern は正規表現として読め、tests のファイルのどれかのテストの名前に当たる（古くなった名前で黙って生き残らせない）', { timeout: 5000 }, () => {
  const names = (f) => [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/\b(?:test|it|describe)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map((x) => x[2].replace(/\\(.)/g, '$1'));
  for (const m of MUTANTS.filter((x) => x.pattern !== undefined)) {
    assert.strictEqual(typeof m.pattern, 'string', m.id);
    const re = new RegExp(m.pattern);
    assert.ok(m.tests.some((f) => names(f).some((n) => re.test(n))), `${m.id}: pattern ${m.pattern} に当たるテストが無い`);
  }
});

// 0.9.0 見た目の直しの CI（run 39491867266）: 元のままの確かめは一覧のテストのほぼ全部（ふだん 100〜130 秒）を1回で走らせるのに、
// 変異1つの見張り（120 秒）と同じ見張りだったので、遅い機械で「元のままで赤（時間切れ）」になり、変異を1つも試さずに止まった。
// 元のままの確かめは自分の見張り（baseTimeoutMs）を持つ。変異1つの見張りは今のまま
test('G3: 元のままの確かめは変異1つの見張り（timeoutMs）でなく、自分の見張り（baseTimeoutMs）で切る', { timeout: 30000 }, async () => {
  const mut = [{ id: 'kill', file: 'src/add.js', from: 'a + b', to: 'a - b', tests: ['test/add.test.js'], why: 'x' }];
  // 変異1つの見張りより長くかかる元のままの確かめも、元のままの見張りの中なら赤にしない
  const ok = await M.runAll({ root: fixtureRepo(), jobs: 1, timeoutMs: 1, baseTimeoutMs: 20000, mutants: mut });
  assert.ok(!ok.some((x) => x.status === 'baseline-red'), `元のままの確かめを変異1つの見張りで切った: ${JSON.stringify(ok.map((x) => [x.id, x.status, x.timedOut]))}`);
  // 元のままの見張りを越えたら、今どおり「元のままで赤（時間切れ）」で止める
  const late = await M.runAll({ root: fixtureRepo(), jobs: 1, timeoutMs: 20000, baseTimeoutMs: 1, mutants: mut });
  assert.deepStrictEqual(late.map((x) => [x.status, x.timedOut]), [['baseline-red', true]]);
  assert.ok(M.BASE_TIMEOUT_MS >= 4 * 120000, '元のままの見張りの既定が、一覧のテストの全部を走らせる長さに足りない');
});

test('G3・F10: 元のテストが赤なら、変異を試さずに止める（何でも「殺した」に見えるため）', { timeout: 20000 }, async () => {
  const r = await M.runAll({ root: fixtureRepo({ red: true }), jobs: 1, mutants: [{ id: 'kill', file: 'src/add.js', from: 'a + b', to: 'a - b', tests: ['test/add.test.js'], why: 'x' }] });
  assert.deepStrictEqual(r.map((x) => x.status), ['baseline-red']);
  assert.strictEqual(M.exitCodeOf(r), 1);
});

test('ci.yml: mutate のジョブ（Linux）が node tools/mutate.js を回す（release.yml は ci.yml を呼ぶので、生き残りがあればリリースも止まる）', { timeout: 5000 }, () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const j = jobsOf(ci).mutate;
  assert.ok(j, 'mutate のジョブが無い');
  assert.match(j, /^    runs-on: ubuntu-latest$/m);
  assert.ok(stepsOf(j).some((s) => /^\s*run: node tools\/mutate\.js( --jobs \d+)?$/m.test(s)));
  assert.match(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8'), /^    uses: \.\/\.github\/workflows\/ci\.yml$/m);
});

const IDS_1A = [
  'js-bom', 'js-utf16', 'js-fatal', 'js-busy-ebusy', 'js-read-waits', 'js-shape', 'js-maxbytes', 'js-quarantine-unreadable',
  'js-fsync', 'js-wx', 'js-rename-retry', 'js-tmp-cleanup', 'js-readonly', 'js-same-text',
  'js-prune-ms', 'js-prune-keep', 'js-copy-dedupe', 'js-clean-wav', 'js-timer-throw', 'js-unref', 'js-flush-retry', 'js-discard',
  'st-port-low', 'st-maxhistory-default', 'st-unknown-keep', 'st-builtin-notfalse', 'st-false-like', 'st-allowlist',
  'mn-writeback', 'mn-startup-notice', 'mn-history-paste', 'mn-save-warning', 'mn-unreadable-nowrite', 'mn-reread-get', 'mn-reload-dictation', 'mn-reload-one-timer',
  'mn-flush-session-end', 'mn-flush-suspend', 'mn-flush-hide', 'mn-exit-flush', 'mn-temps', 'mn-draft-keep', 'mn-draft-name', 'mn-recovery-quarantine',
  'mn-recovery-retry', 'mn-recovery-rewrite', 'mn-log-reason',   // mn-transcript-notice は第2a1回 M-2b で外した（起動で元の JSON を退けないので、退けた文字起こしの知らせ N17 が無い）
  'sr-index-nofsync', 'sr-page-report', 'sr-transcript-report', 'sr-index-keep', 'up-pkg-no-quarantine', 'ei-unreadable-nowrite',
  'sec-video', 'sec-display-app', 'sec-display45', 'sec-check-video', 'sec-crlf', 'sec-strict-fallback', 'sec-nav', 'sec-open', 'sec-sandbox', 'sec-decode', 'smoke-judge-9',
  'png-paeth', 'png-crc', 'png-tolerance', 'png-alpha', 'shots-missing', 'shots-flaky', 'shots-clock', 'shots-errors', 'shots-date-install',
  'mut-stale', 'mut-copy-all', 'gate-json', 'perf-judge', 'perf-fsync',
];
test('G3: 第1a回の変異が一覧にそろう（計画の「変異確認」の表と同じ id）', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual(IDS_1A.filter((id) => !ids.has(id)), []);
});

// 第1c回（Task D-1。計画 docs/plans/2026-10-18-1c.md の「変異確認」の表）
const IDS_1C = [
  'on-offline-noask', 'on-401-up', 'on-cache-ok', 'on-cache-ng', 'on-cert', 'on-order-localonly', 'on-order-key', 'on-summary-localonly',
  'stt-redirect', 'stt-429-wait', 'stt-429-long', 'stt-waitcap', 'stt-offline-class', 'stt-400-noprompt',
  'sec-unavailable', 'sec-basic-text', 'sec-reencrypt', 'sec-key-re',
  'cl-strip-prefix', 'cl-strip-case', 'cl-auth-gate', 'cl-no-bare', 'cl-no-persist', 'cl-safe-mode', 'cl-old-version', 'cl-tools-off', 'cl-stdin-cap', 'cl-limit-class', 'cl-reset-at', 'cl-timeout-kill', 'cl-cmd-only', 'cl-cwd',
  'mn-no-fallback', 'mn-offline-local', 'mn-seg-fallback', 'mn-429-no-local', 'mn-route-count', 'mn-localonly-draft', 'mn-notice-once', 'mn-recovery-keep', 'mn-input-same',
  'mn-warm-local', 'mn-localonly-summary', 'mn-recovery-local-keep', 'mn-recovery-engine-keep', 'mn-key-decrypt',
  'st-claude-cmd', 'ui-localonly-final', 'gate-online',
];
// 0.7.0 U-1（設計書 D5）で、直しそのものが無くなったので外した変異（同意を見ない・同意と URL のキーが無い）
const IDS_1C_RETIRED = ['on-order-consent', 'on-consent-unknown', 'st-consent-ask', 'st-url-https'];
// 第1c回の各タスクの点検で、テストを足して殺した変異（計画の表の外。合流の申し送り）
const IDS_1C_REVIEW = [
  'ui-localonly-reset', 'ui-localonly-cloud', 'mn-status-cloud', 'mn-page-view',
  'on-redirect-up', 'sec-unreadable-set', 'sec-unreadable-remove', 'stt-413', 'cl-out-cap', 'cl-exit-nonzero', 'cl-auth-timeout',
  'mn-ask-no-decrypt', 'mn-announce-localonly', 'mn-localonly-oneway',
];
test('G3: 第1c回の変異が一覧にそろう（計画の「変異確認」の表と同じ id、と点検で足した id。0.7.0 U-1 で外した4つは無い）', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual([...IDS_1C, ...IDS_1C_REVIEW].filter((id) => !ids.has(id)), []);
  assert.deepStrictEqual(IDS_1C_RETIRED.filter((id) => ids.has(id)), []);
});

// 0.7.0 U-1・U-2（計画 docs/plans/2026-10-19-ui07.md の「変異確認」の表）
const IDS_U07 = ['u1-retired-keys',
  'u2-top', 'u2-toggle-system', 'u2-toggle-ime', 'u2-toggle-prevented', 'u2-toggle-revert', 'u2-retake-settings'];
// 第1d回 A-3（RL11）で、直しそのものが無くなったので外した変異: 送り先は OpenAI の固定でなく中継（relayProvider。G-2 の ra-no-direct が受け継ぐ）、
// 経路は鍵でなくログインの札で決める（G-2 の ra-signed-out-probe が受け継ぐ）
const IDS_U07_RETIRED = ['u1-fixed-provider', 'u1-nokey-noprobe'];
test('G3: 0.7.0 U-1・U-2 の変異が一覧にそろう（第1d回 A-3 で外した2つは無い）', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual(IDS_U07.filter((id) => !ids.has(id)), []);
  assert.deepStrictEqual(IDS_U07_RETIRED.filter((id) => ids.has(id)), []);
});

// 第1d回 A-4（RL10・RL11・F11）で、直しそのものが無くなったので外した変異（上の一覧からも外した）:
//  - PC から OpenAI・Groq へ直に送る道（transcribeCloud・resolveProvider・customBase）を消した: stt-auth-only（札は Authorization だけ、は
//    G-2 の ra-token-header が transcribeRelay で受け継ぐ）・stt-https-only・stt-preset-fixed・stt-403-auth（中継の答えに 403 の分けは無い）
//  - 鍵の確かめ（checkKey・keyErrorKind・CHECK_WAV）と cloud:test-key の文を消した: lf-key-*（10）・lf-key-msg-main・lf-ui-key-msg
//  - 鍵の欄（画面）と鍵の IPC（cloud:*）を消した: ui-key-cleared（コードの欄を空にする ra-ui-code-clear が G-2 で受け継ぐ）・
//    u1-key-openai-only・u1-ui-no-provider・u1-status-openai-only
const IDS_1D_RETIRED = ['stt-auth-only', 'stt-https-only', 'stt-preset-fixed', 'stt-403-auth', 'ui-key-cleared',
  'lf-key-invalid', 'lf-key-scope-retry', 'lf-key-scope-only', 'lf-key-quota', 'lf-key-scope-msg', 'lf-key-silent', 'lf-key-no-hint', 'lf-key-waitcap',
  'lf-key-ratelong', 'lf-key-msg-main', 'lf-ui-key-msg', 'u1-key-openai-only', 'u1-ui-no-provider', 'u1-status-openai-only'];
test('G3: 第1d回 A-4 で外した変異（PC から直に送る道・鍵の確かめ・鍵の欄と IPC）は一覧に無い', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual(IDS_1D_RETIRED.filter((id) => ids.has(id)), []);
});

// 第1b回（Task C-3。計画 docs/plans/2026-10-19-1b.md の「変異確認」の表）。look-sel-line は第1b2回で左の線をやめたので外した（tok-sel-line に置き換え）
const IDS_1B = [
  'ws-path-local', 'ws-min-size', 'ws-int', 'ws-max-edge', 'ws-onscreen', 'ws-visible-min', 'ws-normal-bounds', 'ws-zoom-steps', 'ws-zoom-cap',
  'ws-zoom-jis', 'ws-zoom-keyup', 'ws-sidebar-clamp', 'ws-tab-live', 'ws-tab-shape', 'ws-tab-drop', 'ws-tab-max', 'mw-batch', 'mw-unreadable',
  'mw-broken-keep', 'mw-broken-notice', 'mw-prevent', 'mw-wheel', 'mw-zoom-load', 'mw-maximize', 'mw-ui-validate', 'mw-bg', 'mp-same-state',
  'mp-mark', 'mp-mark-draft', 'mp-mark-page', 'mp-mark-shape', 'mp-suspend', 'mp-suspend-idle', 'mp-resume-hint', 'mp-resume-retry',
  'mp-no-autoresume', 'look-muted', 'look-accent-text', 'look-font', 'look-glass', 'look-radius', 'look-focus-ring', 'look-page-width',
  'ui-side-outside', 'ui-side-clamp', 'ui-side-key', 'ui-side-save', 'ui-tab-ctrl', 'ui-tab-middle', 'ui-tab-dedupe', 'ui-tab-close-next',
  'ui-tab-flush', 'ui-tab-live-nosave', 'ui-tab-restore', 'ui-tab-arrows', 'ui-more-esc', 'ui-more-ime', 'ui-side-ime', 'ui-live-open',
  'ui-live-convert', 'ui-pause-ask', 'ui-pause-key', 'ui-pause-final', 'ui-pausemark', 'ui-resume-note', 'ui-route-split', 'ui-cite-mark',
  'gate-move-ledger', 'shots-retake-overlay', 'shots-overflow', 'shots-zoom', 'mp-suspend-ensure', 'mp-suspend-late', 'look-text-token',
  'look-shadow-blue', 'ui-row-middle', 'gate-ledger-extra',
];
// 第1b回の点検で足した守り（計画「載せ直しで分かったこと」の「C-3 で変異の行にしてよい」）
const IDS_1B_REVIEW = [
  'mp-ask-clear', 'mp-suspend-clear', 'mp-notice-once', 'mw-temps', 'shots-focus-fatal', 'shots-main-overflow', 'shots-main-zoom-fatal',
  'shots-main-zoom', 'shots-main-answers', 'shots-main-probe-app', 'ui-live-bar-only', 'ui-side-touched', 'ui-tabs-touched', 'ui-pause-nopreload',
];
// 第1b2回（計画 docs/plans/2026-10-19-1b2.md の「変異確認」の表。bar-pacts-curid・pal-esc-collapsed は点検で足した行）
const IDS_1B2 = [
  'tok-muted', 'tok-accent', 'tok-accent-text', 'tok-text-2', 'tok-font', 'tok-wordmark', 'tok-sel-line', 'tok-sea', 'tok-scrollbar', 'tok-button',
  'side-oneline', 'side-title', 'side-title-order', 'side-icon', 'side-collapse-focus', 'side-new-label', 'side-all-pages', 'pal-open', 'pal-ctrlp',
  'pal-ctrlp-prevented', 'pal-ctrlp-shift', 'pal-esc-return', 'pal-esc-collapsed', 'pal-arrows', 'pal-ctrl-enter', 'pal-close-after', 'pal-trap',
  'pal-hidden-css', 'pal-chip-refresh', 'pal-closed-query', 'pal-target', 'bar-pacts-place', 'bar-pacts-hidden', 'bar-pacts-hidden-css', 'bar-crumb',
  'bar-pacts-curid', 'bar-regen-menu', 'bar-tab-white', 'pg-card', 'pg-scroll', 'pg-icon', 'pg-nopage', 'pg-pill-order', 'pg-pill-underline',
  'pg-banner', 'pg-ic', 'pg-cite-blue', 'pg-who-green', 'set-title', 'set-h2', 'set-check', 'rec-in-block', 'rec-title-lock', 'rec-title-unlock',
  'rec-stop', 'rec-live-on-css', 'shots-palette', 'shots-palette-retake', 'gate-1b2-ledger', 'gate-1b2-release',
];
// 第1b回の続き Lane F（Claude Code のログイン切れの見分け・本当の確かめ・ログインと入れるボタンの窓の組み立て・鍵の確かめの理由）と第1b2回の直し（fx-*）
const IDS_1B_FIX = [
  'lf-auth-401', 'lf-auth-text', 'lf-auth-case', 'lf-429-limit', 'lf-usage-limit', 'lf-log-facts', 'lf-subtype-list', 'lf-status-range',
  'lf-auth-msg', 'lf-ping-skip', 'lf-ping-gate', 'lf-ping-safe-args', 'lf-ping-handler', 'lf-ping-timeout', 'lf-ui-verified', 'lf-login-env',
  'lf-login-exe-only', 'lf-login-ctrl', 'lf-open-platform', 'lf-open-exit', 'lf-open-busy', 'lf-open-recheck', 'lf-install-visible',
  'lf-ui-install-shown', 'lf-ui-login-shown', 'lf-ui-disable', 'lf-msg-login-button',
  'lf-ping-notfound', 'lf-status-timeout', 'lf-status-overloaded', 'lf-win-quote', 'lf-install-del-env', 'fx-hidden-important', 'fx-hidden-weak',
  'fx-live-pad', 'fx-side-ic', 'fx-side-ic-html', 'fx-pal-grey', 'fx-seg-index', 'fx-seg-index-stale', 'fx-seg-index-first', 'fx-cv', 'fx-cv-clip',
];
test('G3: 第1b回・第1b2回・Lane F と直しの変異が一覧にそろい、第1b2回で消した look-sel-line は無い', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual([...IDS_1B, ...IDS_1B_REVIEW, ...IDS_1B2, ...IDS_1B_FIX].filter((id) => !ids.has(id)), []);
  assert.ok(!ids.has('look-sel-line'), '第1b2回で左の線をやめたのに look-sel-line が残っている');
});

// 第2a1回（Task G-3。計画 docs/plans/2026-10-19-2a1.md の「変異確認」の表。各レーンの点検で足した行を含む）
const IDS_2A1 = [
  'dk-between-order', 'dk-trailing-zero', 'dk-even-width', 'pr-list-entry', 'db-wal', 'db-full', 'db-fk', 'db-secure-delete',
  'db-fts-secure', 'db-strict', 'db-selftest', 'db-newer-ro', 'db-step-immediate', 'db-proto', 'db-role', 'db-tx-dup',
  'db-tx-mismatch', 'db-tx-role', 'db-oplog-same-tx', 'db-tx-required', 'dv-id-shape', 'dv-limit-blocks', 'dv-limit-bytes', 'dv-attrs-reserved',
  'dv-rich-mark', 'dv-rich-link', 'dv-rich-text', 'ops-old', 'db-view-order', 'db-short-mark', 'db-cite-stat', 'db-stale',
  'db-seg-recite', 'db-seg-failed', 'db-route-text', 'db-rev-conflict', 'db-put-create', 'db-hidden-live', 'db-finalize-overwrite', 'db-trash',
  'db-trash-hidden', 'db-purge-oplog', 'db-purge-mark', 'db-hot-index', 'db-rev-blocks', 'db-strip-derived', 'db-dup-result', 'db-begin-no-downgrade',
  'db-recover-keep-done', 'db-settle-keep', 'db-discard-checkpoint', 'ds-short-like', 'ds-codepoints', 'ds-escape', 'ds-quote', 'ds-memo',
  'ds-sep', 'ds-order', 'ds-truncated', 'dm-no-move', 'dm-verify', 'dm-tmp', 'dm-failed-keep', 'dm-count-broken',
  'dm-reimport-new', 'dm-reimport-replace', 'dm-reimport-copy', 'dm-purge-skip', 'dm-fingerprint', 'dm-page-tolerant', 'dm-fix-ids', 'dm-stale-wal',
  'dm-failed-prune', 'dm-fingerprint-migrate', 'dm-reimport-atomic', 'dn-verify', 'dn-close', 'dn-keep-broken', 'dn-no-delete-busy', 'dn-lock',
  'dn-rotate', 'dn-keep-migration', 'dn-prune-purge', 'dn-classify', 'dn-check-unavailable', 'dn-restore-first', 'dn-skip-partial', 'dn-rotate-held',
  'dsv-changed', 'dsv-close', 'dsv-no-remigrate', 'mc-backoff', 'mc-giveup', 'mc-intentional', 'mc-resend', 'mc-port-each-load',
  'mc-no-overlay-port', 'mc-down-rejects', 'mc-send-resend', 'mb-tabs-keep', 'mr-recovery-keep-on-error', 'mc-no-init-store', 'mc-resend-order', 'mc-port-on-restart',
  'mc-db-lost', 'mr-draft-pageid', 'mr-clear-after-ack', 'mr-recover-same-id', 'mr-discard-pending', 'mr-settle-keep', 'mr-no-relay', 'mr-already-clear',
  'mr-empty-draft-purge', 'mr-purge-unsaved', 'mr-bg-finalize', 'mr-skip-finalizing', 'mr-start-no-wait', 'mr-park-recovering', 'mr-recover-chain', 'm1-saveifexists-retry',
  'm1-quit-wait', 'm1-conflict-throw', 'm1-down-not-gone', 'mm-dialog-counts', 'mm-quit-untouched', 'mm-no-snapshot-meeting', 'pp-tx', 'pp-resend-same-tx',
  'pp-reject-read', 'pp-name-check', 'pp-queue-before-port', 'gp-search-budget', 'gp-list-key-rev', 'gp-list-copy', 'gp-search-cache', 'gp-search-first-seg',
  'gp-search-first-block', 'gp-busy-writing',
];
test('G3: 第2a1回の変異が一覧にそろう（計画の「変異確認」の表と同じ id）', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual(IDS_2A1.filter((id) => !ids.has(id)), []);
});
// 第2a1回の各レーンの点検で、テストを足して殺した変異（計画の表の外。統合の申し送り (a)〜(e)）
const IDS_2A1_REVIEW = [
  'dj-create-summary-error', 'db-actor-main', 'db-readonly-flag', 'db-put-trashed', 'db-insert-pos', 'db-seg-norecite',
  'db-copy-trashed', 'db-recover-trashed', 'db-restore-copy', 'db-restore-done', 'gp-search-group-page', 'gp-list-forget',
];
test('G3: 第2a1回の点検で足した変異も一覧にそろい、IDS_2A1 は計画の「変異確認」の表の id とちょうど同じ', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual(IDS_2A1_REVIEW.filter((id) => !ids.has(id)), []);
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-19-2a1.md'), 'utf8');
  const table = plan.slice(plan.indexOf('## 変異確認'), plan.indexOf('## ゲート'));
  const rows = [...table.matchAll(/^\| ([a-z0-9]+(?:-[a-z0-9]+)+) \|/gm)].map((x) => x[1]);
  assert.deepStrictEqual([...rows].sort(), [...IDS_2A1].sort());
});

// 0.7.0 の前の直し（第2a1回 M-4 の点検で残したこと: 締めの返事を待つ会議を「忙しい」に数える・録音の最中の［今は移さずに終える］）
const IDS_M4_REST = ['m4b-power-finalizing', 'm4b-close-finalizing', 'm4b-confirm-finalizing', 'm4b-quit-after-recording'];
test('G3: 第2a1回 M-4 の残りを直した変異が一覧にそろう', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual(IDS_M4_REST.filter((id) => !ids.has(id)), []);
});

// 第1d回 W-1・D-1 の独立した点検で、テストを足して殺した変異（計画 docs/plans/2026-10-19-1d.md の「W-1・D-1 の独立した点検（2026-10-19）で足したもの」）。
// W-1・D-1 は 0.7.0 の版で main に入るので、この5つも 0.7.0 で一覧に入れる（計画の表の rl-* は G-2 で足す）
const IDS_1D_REVIEW = ['rl-deploy-api-redirect', 'rl-deploy-health-redirect', 'rl-deploy-run-expr', 'rl-deploy-foreign-action', 'rl-deploy-self-hosted'];
test('G3: 第1d回 W-1・D-1 の点検で足した5つの変異が一覧にそろい、どれも中継の出し方のテストで赤にする', { timeout: 5000 }, () => {
  const byId = new Map(MUTANTS.map((m) => [m.id, m]));
  assert.deepStrictEqual(IDS_1D_REVIEW.filter((id) => !byId.has(id)), []);
  for (const id of IDS_1D_REVIEW) assert.deepStrictEqual(byId.get(id).tests, ['test/relay-deploy.test.js'], id);
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-19-1d.md'), 'utf8');
  for (const id of IDS_1D_REVIEW) assert.ok(plan.includes(`\`${id}\``), `計画に ${id} が無い`);
});

// 第1d回 Task G-2（計画 docs/plans/2026-10-19-1d.md の「変異確認」の表。W・D・A・G の各レーンの直しを1つずつ戻す）
const IDS_1D = [
  'rl-log-fields', 'rl-test-base', 'rl-health-db', 'rl-domain-exact',
  'rl-usage-reserve', 'rl-wav-bytes', 'rl-wav-format', 'rl-wav-rate', 'rl-wav-bits', 'rl-prompt-bytes', 'rl-stt-timeout',
  'rl-blocked', 'rl-model-forced', 'rl-size-cap', 'rl-daily-user',
  'rl-daily-all', 'rl-usage-on-fail', 'rl-upstream-401', 'rl-retry-after', 'rl-deploy-keep', 'rl-deploy-invocation', 'rl-deploy-print', 'rl-deploy-env',
  'ra-login-code', 'ra-login-strict', 'ra-redo-all', 'ra-no-direct', 'ra-secrets-relay-only', 'ra-purge-old', 'ra-logout-local',
  'ra-status-offline', 'ra-401-redo', 'ra-401-forget', 'ra-hold', 'ra-signed-out-probe', 'ra-notice-action', 'rg-direct-host',
  'rg-relay-console', 'ra-seg-online-75', 'ra-seg-flap', 'ra-seg-sticky', 'ra-seg-no-clamp', 'ra-seg-probe-start', 'ra-seg-localonly', 'ra-seg-bp-base',
  'ra-stall-silent', 'ra-stall-n', 'ra-stall-drop-wav', 'ra-problem-sticky', 'ra-problem-offline', 'ra-login-clear', 'ra-retry-once', 'ra-retry-localonly',
  'ra-discard-keep-quiet', 'ra-finalize-keep-quiet', 'ra-text-no-reset', 'ra-retry-no-pending', 'ra-seg-fail-why', 'ra-memo-scale-floor', 'ra-ui-banner-text', 'ra-ui-stt-live',
  'ra-notify-visible', 'ra-notify-once', 'ra-notify-codes', 'ra-notify-text', 'ra-notify-throw-guard', 'ra-notify-focused', 'ra-restart-recording', 'ra-restart-finalizing',
  'ra-apply-recording', 'ra-tray-late', 'ra-ui-restart-result', 'ra-restart-stops', 'ra-restart-quitting', 'ra-start-quitting', 'ra-dictate-quitting',
  // 第1d回 Task G-3（作り替え: Cloudflare Access のログイン。計画の「作り替えの変異」の「足す変異」を「変異確認」の表へ移した 60 個）
  ...IDS_1D_ACCESS_ADDED(),
  // 第1d回 統合（G-4 の前）: W-5 の点検の直しのテストに当てる3つ（exp の境目・access がそろう前の 503・ASCII でないメール）
  'rl-jwt-exp-boundary', 'rl-access-not-ready', 'rl-email-ascii',
  // 0.8.0 の出し直し: Workers は fetch の redirect: 'error' を受けない（鍵の口が 503 certs になった）
  'rl-workers-redirect',
];
// 中継の Access の確かめ（W-5・W-6）・出し方のサービストークン（D-2）・アプリの送り方とログインの窓と cookie（A-10〜A-14）・ゲート（G-3）
function IDS_1D_ACCESS_ADDED() {
  return [
    'rl-jwt-sig', 'rl-jwt-alg', 'rl-jwt-kid', 'rl-jwt-iss', 'rl-jwt-aud', 'rl-jwt-exp', 'rl-jwt-type', 'rl-jwt-service', 'rl-jwt-cookie', 'rl-jwt-ctx-any',
    'rl-jwt-aud-503', 'rl-jwt-kind', 'rl-email-alias', 'rl-certs-cache', 'rl-certs-refetch', 'rl-certs-base', 'rl-certs-timeout', 'rl-certs-inflight',
    'rl-health-open', 'rl-done-csp', 'rl-no-cors', 'rl-schema-drop',
    'rl-deploy-svc-header', 'rl-deploy-svc-host', 'rl-deploy-svc-env', 'rl-deploy-svc-503',
    'ra-no-token-header', 'ra-xrw', 'ra-session-cookies', 'ra-redirect-follow', 'ra-302-login', 'ra-cfray', 'ra-403-server', 'ra-nav-any',
    'ra-cookie-names', 'ra-cookie-host', 'ra-login-persist', 'ra-login-sandbox', 'ra-login-popup', 'ra-login-modal', 'ra-login-me', 'ra-cookie-plain',
    'ra-logout-clear', 'ra-expired-l3', 'ra-denied-l11', 'ra-login-guard', 'ra-login-guard-all', 'ra-login-contents-any', 'ra-login-pin',
    'ra-login-blocked-once', 'ra-restore-unreadable', 'ra-login-race', 'ra-no-autoopen',
    'ra-ui-offline-text', 'ra-ui-localonly-row', 'ra-e2e-cause', 'ra-e2e-code-shape', 'ra-e2e-seg-retry',
    'rg-team-domain', 'rg-access-secret',
  ];
}
// 第1d回の作り替え（Cloudflare Access のログイン）で、直しそのものが無くなったので外した変異（上の IDS_1D と計画の「変異確認」の表からも外した）。
// 外したタスクが理由を書く（計画「作り替え」の「作り替えの変異」の「外す変異」の表）:
//  - ra-token-header（A-11）: 文字起こしの要求に札を入れる道（Authorization: Bearer）が無い。札を見出しに入れない守りは G-3 の ra-no-token-header が受け継ぐ
//  - ra-ui-code-clear（A-12）: 設定のカード「アカウント」に確認コードの欄が無い（コードは Cloudflare のログインの画面で入れる。画面はコードを扱わない）
//  - rl-code-hash・rl-code-ttl・rl-start-email-limit・rl-start-ip-limit・rl-ip-before-domain・rl-blocked-order（W-6）: /auth/start・/auth/verify と
//    確認コードの表（login_codes）が無い（コードは Cloudflare の One-time PIN。10 分・1回だけ・頼み直すと前のコードは使えない）
//  - rl-mail-cap・rl-mail-fail-keep・rl-mail-redirect・rl-mail-timeout（W-6）: Resend のメールの道（relay/mail.mjs）が無い（あとの直し (d)）
//  - rl-verify-attempts・rl-verify-once・rl-verify-atomic（W-6）: 中継でのコードの確かめが無い
//  - rl-token-hash・rl-idle・rl-absolute・rl-revoked（W-6）: 中継の札の表（sessions）が無い（ログインの長さと取り消しは Access の側）
//  （rl-domain-exact・rl-blocked は外さず、W-6 で relay/access.mjs の requireAccess へ移した）
const IDS_1D_ACCESS_RETIRED = ['ra-token-header', 'ra-ui-code-clear',
  'rl-code-hash', 'rl-code-ttl', 'rl-start-email-limit', 'rl-start-ip-limit', 'rl-ip-before-domain', 'rl-blocked-order',
  'rl-mail-cap', 'rl-mail-fail-keep', 'rl-mail-redirect', 'rl-mail-timeout', 'rl-verify-attempts', 'rl-verify-once', 'rl-verify-atomic',
  'rl-token-hash', 'rl-idle', 'rl-absolute', 'rl-revoked'];
test('G3: 第1d回の作り替えで外した変異（IDS_1D_ACCESS_RETIRED）は一覧にも IDS_1D にも無い', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual(IDS_1D_ACCESS_RETIRED.filter((id) => ids.has(id) || IDS_1D.includes(id)), []);
});
test('G3: 第1d回の変異が一覧にそろい、IDS_1D は計画の「変異確認」の表の id とちょうど同じ（中継・出し方・アプリ・ゲートの直しを1つずつ戻す）', { timeout: 5000 }, () => {
  const byId = new Map(MUTANTS.map((m) => [m.id, m]));
  assert.deepStrictEqual(IDS_1D.filter((id) => !byId.has(id)), []);
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-19-1d.md'), 'utf8');
  const table = plan.slice(plan.indexOf('## 変異確認'), plan.indexOf('## ゲート'));
  const rows = [...table.matchAll(/^\| ([a-z0-9]+(?:-[a-z0-9]+)+) \|/gm)].map((x) => x[1]);
  assert.deepStrictEqual([...rows].sort(), [...IDS_1D].sort());
  // 中継（relay/）と出し方の変異は、Electron の場面を使わない中継のテストで殺す（CI の mutate を短く保つ）。ゲートの変異はゲートのテストで殺す
  for (const id of IDS_1D.filter((x) => x.startsWith('rl-'))) {
    const m = byId.get(id);
    // ヘルプセンター H-10 で意図して変えた: 出し方の共通の部品 tools/lib/cf-api.js（relay-deploy から出した。rl-deploy-print が当たる）も中継の出し方
    assert.ok(/^(relay\/|tools\/relay-deploy\.js$|tools\/lib\/cf-api\.js$|\.github\/workflows\/relay-deploy\.yml$)/.test(m.file), `${id}: ${m.file}`);
    assert.ok(m.tests.every((t) => /^test\/relay-[a-z-]+\.test\.js$/.test(t)), `${id}: ${m.tests}`);
  }
  for (const id of IDS_1D.filter((x) => x.startsWith('rg-'))) assert.deepStrictEqual(byId.get(id).tests, ['test/gate.test.js'], id);
});
test('G3: 第1d回の作り替え（G-3）で足した 60 個の変異が一覧にそろい、計画の「作り替えの変異」の節には足す表が残っていない（「変異確認」の表へ移した）', { timeout: 5000 }, () => {
  const added = IDS_1D_ACCESS_ADDED();
  assert.strictEqual(added.length, 60);
  assert.strictEqual(new Set(added).size, added.length);
  const byId = new Map(MUTANTS.map((m) => [m.id, m]));
  assert.deepStrictEqual(added.filter((id) => !byId.has(id)), []);
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-19-1d.md'), 'utf8');
  const at = plan.indexOf('### 作り替えの変異');
  const sec = plan.slice(at, plan.indexOf('\n### ', at + 5));
  assert.ok(at > 0 && sec.length > 100, '計画に「作り替えの変異」の節が無い');
  assert.deepStrictEqual([...sec.matchAll(/^\| ([a-z0-9]+(?:-[a-z0-9]+)+) \|/gm)].map((x) => x[1]), [], '「作り替えの変異」の節に足す表の行が残っている');
  // 重い場面のテスト（Electron の場面を起こすファイル）は、赤になるテストの名前だけを回す（CI の mutate を短く保つ）
  for (const id of added) {
    const m = byId.get(id);
    if (m.tests.some((t) => /stage1d\.(main|ipc|app|seg|status|restart)\.test\.js$|transcribe\.e2e\.test\.js$/.test(t))) assert.ok(m.pattern, `${id}: pattern が無い`);
  }
});

// ヘルプセンター H-11: ヘルプの直しを1つずつ戻す変異（計画 docs/plans/2026-10-20-help.md の「変異確認」の表。H-12 の分は 0.9.2 の IDS_092 の i-help-*）
const IDS_HELP = [
  'hp-escape-lt', 'hp-escape-quote', 'hp-raw-html', 'hp-link-scheme', 'hp-anchor', 'hp-nest', 'hp-inline-style', 'hp-label', 'hp-search-nfkc',
  'hp-gate-require', 'hp-gate-ready', 'hp-gate-readonly', 'hp-gate-nostore', 'hp-gate-set', 'hp-gate-csp', 'hp-gate-need',
  'hp-gate-why-team', 'hp-gate-why-aud', 'hp-gate-why-domains', 'hp-gate-why-log', 'hp-gate-why-page', 'hp-gate-why-word', 'hp-gate-why-access',
  'hp-gate-why-assets', 'hp-gate-why-redirect', 'hp-gate-why-error', 'hp-gate-why-errname', 'hp-gate-why-method',
  'hp-deploy-leak', 'hp-deploy-old', 'hp-deploy-stale', 'hp-deploy-index', 'hp-deploy-wait', 'hp-deploy-keep', 'hp-deploy-rwf', 'hp-deploy-nocreate', 'hp-relay-skip-help',
];
test('G3: ヘルプセンターの変異が一覧にそろい、IDS_HELP は計画 docs/plans/2026-10-20-help.md の「変異確認」の表の id とちょうど同じ', { timeout: 5000 }, () => {
  const byId = new Map(MUTANTS.map((m) => [m.id, m]));
  assert.deepStrictEqual(IDS_HELP.filter((id) => !byId.has(id)), []);
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-20-help.md'), 'utf8');
  const table = plan.slice(plan.indexOf('## 変異確認'), plan.indexOf('## ゲート'));
  const rows = [...table.matchAll(/^\| ([a-z0-9]+(?:-[a-z0-9]+)+) \| `([^`]+)` \| [^|]+ \| ([^\n]+) \|$/gm)];
  assert.deepStrictEqual(rows.map((x) => x[1]).sort(), [...IDS_HELP].sort());
  // 表の「当てるファイル」と「赤になるテスト」が一覧と同じ（ヘルプの変異は Electron の場面を使わない help-*・relay-deploy のテストで殺す）
  for (const [, id, file, tests] of rows) {
    const m = byId.get(id);
    assert.strictEqual(m.file, file, id);
    assert.deepStrictEqual([...m.tests].sort(), [...tests.matchAll(/`([^`]+)`/g)].map((x) => x[1]).sort(), id);
  }
  // H-12 の分（アプリの入口）はまだ無い（0.9.0 の U-4 と一緒に H-12 が足す）
  assert.deepStrictEqual(MUTANTS.filter((m) => /^hp-app-/.test(m.id)).map((m) => m.id), []);
});

// 0.9.0（計画 docs/plans/2026-10-20-090.md の「変異確認」の表）。G-1 は速さの計り直しの4つを入れる。G-2 が残りの全部を足し、
// この並びが計画の表の id とちょうど同じことを見るテストを足す
// 0.9.0（G-1 で perf の6つ、G-2 で計画 docs/plans/2026-10-20-090.md の「変異確認」の表の全部）
const IDS_090 = [
  'op-chosen-manual', 'op-chosen-managed', 'op-chosen-consent', 'op-chosen-fetching', 'op-cloud-likely', 'op-start-refuse', 'op-start-chosen',
  'op-start-cloud', 'op-dict-refuse', 'op-status-cloud', 'op-kept-wav', 'op-kept-text', 'op-kept-refused', 'op-k1-first', 'op-recover-kept',
  'op-kept-banner', 'op-kept-login', 'op-kept-segfailed', 'op-kept-notify', 'op-kept-notice-text', 'op-start-k1', 'op-public-kept', 'op-auto-retry',
  'op-auto-retry-cap', 'op-auto-retry-stopping', 'op-kept-empty', 'op-summary-wait', 'op-auto-summary', 'op-queue-skip', 'op-watcher',
  'op-watcher-offline', 'op-log-once', 'op-hold-log-once', 'op-watch-engine', 'op-relogin-kick', 'op-sum-text', 'op-localonly-queue',
  'op-localonly-needs', 'op-status-needs', 'op-dict-keep', 'op-dict-nopaste', 'op-dict-readd', 'op-dict-dup', 'op-dict-broken', 'op-ui-neutral',
  'op-ui-startup-jump', 'op-ui-signin-account', 'op-ui-fetch-label', 'op-ui-test-hidden', 'op-ui-banner-signin', 'op-ui-notice-signin',
  'op-shots-retake', 'sp-tab-open', 'sp-open-sec', 'sp-esc-hotkey', 'sp-inert', 'sp-focus-back', 'sp-keys-behind', 'sp-restore-settings',
  'sp-winstate-fixed', 'sp-esc-global', 'sp-nav-blue', 'sp-sec-show', 'sp-search-nfkc', 'sp-search-esc', 'sp-help-live', 'sp-help-args',
  'sp-section-keep', 'sp-hotkey-tab', 'rp-slot-default', 'rp-nearest-tie', 'rp-migrate-once', 'rp-migrate-display', 'rp-legacy-keep', 'rp-pad',
  'rp-ceil', 'rp-anchor', 'rp-size-repeat', 'rp-snap-write', 'rp-form', 'rp-migrate-startup', 'rp-drag-defer', 'rp-display-keep', 'rp-move-fallback',
  'rp-pill-flex', 'rp-shots-watchdog', 'rp-dots-silent', 'rp-dots-five', 'rp-spk-sea', 'rp-spk-hidden', 'rp-warn-sticky', 'rp-title-key',
  'rp-report-once', 'rp-hide-v', 'rp-show-inactive', 'rp-hide-error', 'rp-tray-show', 'rp-hover-poll', 'bn-relay-down', 'bn-accuracy',
  'bn-kept-plain', 'bn-offline-show', 'bn-offline-clear', 'bn-offline-eligible', 'bn-offline-notify', 'bn-offline-relay-clear', 'bn-offline-shown',
  'bn-offline-relay-swap', 'bn-offline-engine', 'perf-recheck-any', 'perf-recheck-all', 'perf-recheck-skip', 'perf-again-tx', 'perf-readback',
  'perf-bench-close',
];
test('PG1: 変異 perf-recheck-any・perf-recheck-all・perf-recheck-skip・perf-again-tx・perf-readback・perf-bench-close が一覧にあり、IDS_090 に入っている', { timeout: 5000 }, () => {
  const byId = new Map(MUTANTS.map((m) => [m.id, m]));
  for (const id of ['perf-recheck-any', 'perf-recheck-all', 'perf-recheck-skip', 'perf-again-tx', 'perf-readback', 'perf-bench-close']) {
    assert.ok(IDS_090.includes(id), `IDS_090 に ${id} が無い`);
    assert.ok(byId.has(id), `一覧に ${id} が無い`);
    assert.strictEqual(byId.get(id).file, 'tools/perf.js', id);
    assert.deepStrictEqual(byId.get(id).tests, ['test/perf.test.js'], id);
  }
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-20-090.md'), 'utf8');
  const table = plan.slice(plan.indexOf('## 変異確認'), plan.indexOf('## ゲート'));
  for (const id of IDS_090) assert.ok(table.includes(`| ${id} |`), `計画の「変異確認」の表に ${id} が無い`);
});

test('CI: mutate のジョブの timeout-minutes は 40（0.9.0 の約 99 の変異で 20 分を越える見込み。PG1・決めたこと 37）', { timeout: 5000 }, () => {
  const j = jobsOf(fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')).mutate;
  assert.match(j, /^    timeout-minutes: 40$/m);
  assert.ok(stepsOf(j).some((s) => /^\s*run: node tools\/mutate\.js --jobs 2$/m.test(s)), '変異確認の写しの数を変えた');
});

// 0.9.0 の各レーンの点検で足した変異（計画の表の行の場面・lib の分け・点検する人が殺せなかった行に場面を足して殺したもの）
const IDS_090_REVIEW = [
  'op-start-refuse-scene', 'op-recover-kept-lib', 'op-kept-login-scene', 'op-kept-notify-scene', 'op-p1', 'op-dict-delete', 'op-dict-refuse-lib',
  'rv-consent-unreadable', 'rv-dict-user-deleted', 'rv-kept-banner-clear', 'rv-localonly-exec-guard', 'rv-dict-save-before-unlink', 'rv-dict-empty-before-unlink',
  'op-watch-cloudonly-dict', 'op-watch-cloudonly-item', 'op-watch-cloudonly-throw', 'op-dict-rename-retry', 'op-finalize-s3',
  'op-ui-startup-await', 'op-ui-chosen-missing', 'sp-showlive-close', 'sp-liveshown-modal', 'sp-esc-unregister', 'op-ui-search-hidden',
  'rp-size-form', 'rp-self-move', 'rp-meeting-error-show', 'rp-hidden-status', 'rp-snap-patch',
];
test('G3: 0.9.0 の変異が一覧にそろい、IDS_090 は計画の「変異確認」の表の id とちょうど同じ（点検で足した変異も一覧にある）', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual(IDS_090.filter((id) => !ids.has(id)), [], '計画の表の変異が一覧に無い');
  assert.deepStrictEqual(IDS_090_REVIEW.filter((id) => !ids.has(id)), [], '点検で足した変異が一覧に無い');
  assert.deepStrictEqual(IDS_090_REVIEW.filter((id) => IDS_090.includes(id)), [], '点検で足した変異と計画の表の id が重なる');
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-20-090.md'), 'utf8');
  const table = plan.slice(plan.indexOf('## 変異確認'), plan.indexOf('## ゲート'));
  const rows = new Set([...table.matchAll(/^\| ([a-z][a-z0-9-]*) \|/gm)].map((m) => m[1]).filter((id) => id !== 'id'));
  assert.deepStrictEqual([...rows].sort(), [...IDS_090].sort());
  // 0.9.0 の変異は、どれも決まったテストのファイルを持ち、なぜ戻すと困るかを書く
  for (const m of MUTANTS.filter((x) => IDS_090.includes(x.id) || IDS_090_REVIEW.includes(x.id))) {
    assert.ok(Array.isArray(m.tests) && m.tests.length > 0 && m.tests.every((t) => /^test\/[^/]+\.test\.js$/.test(t)), `${m.id}: tests`);
    assert.ok(typeof m.why === 'string' && m.why.length > 8, `${m.id}: why`);
  }
});

// 0.9.1（計画 docs/plans/2026-10-21-091.md の「変異確認」の表。Task Q-6 で全部を入れた）
const IDS_091 = [
  'q-loud-window', 'q-loud-hop', 'q-loud-unreadable', 'q-silent-level', 'q-gate-off', 'q-echo-off', 'q-echo-terms', 'q-echo-sample', 'q-echo-join',
  'q-echo-tail', 'q-echo-tail-min', 'q-echo-dict-level', 'q-echo-dict-flag', 'q-repeat-two', 'q-repeat-quiet', 'q-echo-stall', 'q-quiet-ask',
  'q-quiet-grace', 'q-quiet-speech', 'q-quiet-keep', 'q-quiet-off', 'q-quiet-wall', 'q-quiet-paused', 'q-quiet-resume', 'q-quiet-failed',
  'q-quiet-empty-loud', 'q-quiet-stopping', 'q-quiet-stop-close', 'q-quiet-note-close', 'q-recover-silent-route', 'q-trim', 'q-trim-end',
  'q-done-notice', 'q-setting-pick', 'q-ui-keep',
];
test('G3: 0.9.1 の変異が一覧にそろい、IDS_091 は計画の「変異確認」の表の id とちょうど同じ。どれも決まったテストのファイルを持ち、なぜ戻すと困るかを書く', { timeout: 5000 }, () => {
  const byId = new Map(MUTANTS.map((m) => [m.id, m]));
  assert.deepStrictEqual(IDS_091.filter((id) => !byId.has(id)), [], '計画の表の変異が一覧に無い');
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-21-091.md'), 'utf8');
  const table = plan.slice(plan.indexOf('## 変異確認'), plan.indexOf('## ゲート'));
  const rows = [...table.matchAll(/^\| ([a-z][a-z0-9-]*) \|/gm)].map((m) => m[1]).filter((id) => id !== 'id');
  assert.deepStrictEqual([...rows].sort(), [...IDS_091].sort());
  for (const id of IDS_091) {
    const m = byId.get(id);
    assert.ok(Array.isArray(m.tests) && m.tests.length > 0 && m.tests.every((t) => /^test\/[^/]+\.test\.js$/.test(t)), `${id}: tests`);
    assert.ok(typeof m.why === 'string' && m.why.startsWith('0.9.1 '), `${id}: why`);
  }
});

// 0.9.2（計画 docs/plans/2026-10-21-092.md の「変異確認」の表）: ヘルプの口・ⓘ の吹き出し・検索・説明の直しを1つずつ戻す変異
const IDS_092 = [
  'i-help-url-arg', 'i-help-allow', 'i-help-list', 'i-help-preload', 'i-help-live', 'i-help-nav-args',
  'i-pop-article', 'i-pop-link-live', 'i-pop-esc', 'i-pop-esc-focus', 'i-pop-search-esc', 'i-pop-one', 'i-pop-aria', 'i-pop-toggle', 'i-pop-outside',
  'i-pop-inside', 'i-pop-sec', 'i-pop-clamp', 'i-pop-flip', 'i-pop-width', 'i-pop-height', 'i-pop-scroll', 'i-search-pop', 'i-search-hit', 'i-search-lead',
  'i-search-css', 'i-desc-alt', 'i-warn-hidden', 'i-check-label',
];
test('G3: 0.9.2 の変異が一覧にそろい、IDS_092 は計画の「変異確認」の表の id とちょうど同じ。どれも決まったテストのファイルを持ち、なぜ戻すと困るかを書く', { timeout: 5000 }, () => {
  const byId = new Map(MUTANTS.map((m) => [m.id, m]));
  assert.deepStrictEqual(IDS_092.filter((id) => !byId.has(id)), [], '計画の表の変異が一覧に無い');
  assert.deepStrictEqual(MUTANTS.filter((m) => /^i-/.test(m.id) && !IDS_092.includes(m.id)).map((m) => m.id), [], 'IDS_092 に無い i- の変異がある');
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-21-092.md'), 'utf8');
  const table = plan.slice(plan.indexOf('## 変異確認'), plan.indexOf('## ゲート'));
  const rows = [...table.matchAll(/^\| ([a-z][a-z0-9-]*) \|/gm)].map((m) => m[1]).filter((id) => id !== 'id');
  assert.deepStrictEqual([...rows].sort(), [...IDS_092].sort());
  for (const id of IDS_092) {
    const m = byId.get(id);
    assert.ok(Array.isArray(m.tests) && m.tests.length > 0 && m.tests.every((t) => /^test\/[^/]+\.test\.js$/.test(t)), `${id}: tests`);
    assert.ok(typeof m.why === 'string' && m.why.startsWith('0.9.2 '), `${id}: why`);
  }
});

// 0.9.3（計画 docs/plans/2026-10-22-093.md の「変異確認」の表）: 会議の検出（見張り・判断・パネル・設定）・音の波・名前の付け直し（D54）の直しを1つずつ戻す変異
const IDS_093 = [
  'm-self', 'm-stop-zero', 'm-stale', 'm-catalog', 'm-twice', 'm-once', 'm-rejoin', 'm-busy', 'm-pending', 'm-mute', 'm-release', 'm-timeout',
  'm-hover', 'm-focus', 'm-protect', 'm-bounds', 'm-start-busy', 'm-start-show', 'm-start-tray', 'm-theme', 'm-theme-live', 'm-sub-label',
  'm-type-sel', 'm-pconly', 'm-notion', 'm-mute-arg', 'm-log-name', 'm-csp', 'm-media', 'm-watch-busy', 'm-backoff', 'm-giveup', 'm-watch-off',
  'm-apps-kind', 'd-save', 'd-mute-patch', 'd-mute-known', 'd-chip-class', 'w-ask-hidden', 'w-ask-raf', 'w-ask-pause', 'w-level-raw', 'w-clamp', 'w-warn',
  'w-silent', 'w-stale', 'w-paused', 'w-reduced', 'w-tail-seg', 'w-tail-paused', 'w-tail-align', 'r-button', 'r-notice', 'r-section', 'r-act', 'r-key', 'r-help',
  'r-nav-width', 'r-pill', 'r-pill-look', 'r-title-off', 'r-local-update',
];
test('G3: 0.9.3 の変異が一覧にそろい、IDS_093 は計画の「変異確認」の表の id とちょうど同じ。どれも決まったテストのファイルを持ち、なぜ戻すと困るかを書く', { timeout: 5000 }, () => {
  const byId = new Map(MUTANTS.map((m) => [m.id, m]));
  assert.deepStrictEqual(IDS_093.filter((id) => !byId.has(id)), [], '計画の表の変異が一覧に無い');
  assert.deepStrictEqual(MUTANTS.filter((m) => /^[mwrd]-/.test(m.id) && !IDS_093.includes(m.id)).map((m) => m.id), [], 'IDS_093 に無い m-・w-・r-・d- の変異がある');
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-22-093.md'), 'utf8');
  const table = plan.slice(plan.indexOf('## 変異確認'), plan.indexOf('## ゲート'));
  const rows = [...table.matchAll(/^\| ([a-z][a-z0-9-]*) \|/gm)].map((m) => m[1]).filter((id) => id !== 'id');
  assert.deepStrictEqual([...rows].sort(), [...IDS_093].sort());
  for (const id of IDS_093) {
    const m = byId.get(id);
    assert.ok(Array.isArray(m.tests) && m.tests.length > 0 && m.tests.every((t) => /^test\/[^/]+\.test\.js$/.test(t)), `${id}: tests`);
    assert.ok(typeof m.why === 'string' && m.why.startsWith('0.9.3 '), `${id}: why`);
  }
});

// 0.9.4（計画 docs/plans/2026-10-22-094.md の「変異確認」の表）: 文字起こしの安定化（音声を失わない・遅い PC・PC への要求・文・区切り・中継）の直しを1つずつ戻す変異。
// タスクごとに足す（S-8 で表とちょうど同じにする）。足した分は表の id で、表の頭の文字（ka・pc・lt・wd・sg・rx・bm・ci・dt・wv・pb・rn）の変異は全部ここにある
const IDS_094 = [
  'pc-floor', 'pc-two', 'pc-big', 'pc-backlog', 'pc-sticky', 'pc-model', 'pc-ttl', 'lt-timeout', 'lt-cap', 'sg-cloud-grow', 'sg-transient', 'sg-hold', 'sg-hold-reset',
  'lt-fetch', 'lt-destroy', 'lt-restart', 'wd-late-text', 'wd-down-text', 'wd-late-banner', 'ka-live-late', 'ka-live-down',
  'ka-recover-late', 'ka-recover-error', 'ka-held-retry', 'ka-old-queue', 'ka-skip-wav', 'ka-skip-auto', 'ka-rec-busy',
  'rx-buffer', 'rx-cl-cap', 'rx-head', 'rx-count', 'rx-refund', 'rx-sec', 'rx-compat', 'rx-fixed', 'rx-fields', 'rx-keys',
  'pc-proc', 'pc-relay-local', 'pc-local-only', 'pc-cloud', 'pc-dict', 'sg-hold-health',
  'ci-noon', 'pc-after-local',
  'dt-say-dedupe', 'dt-rejoin', 'dt-why', 'dt-count', 'dt-trigger',
  'wv-weights', 'wv-same-phase', 'wv-silent', 'wv-bar-reduced', 'wv-page-dots', 'wv-page-blue',
  'pb-okm', 'pb-spk-flash', 'pb-fade', 'pb-done-sound', 'pb-db-notice',
  'rn-secs', 'rn-notice', 'rn-offline-text',
  'pc-help-slow', 'pc-late-screen',
];
test('G3・0.9.4 S-8: 0.9.4 の変異が一覧にそろい、IDS_094 は計画の「変異確認」の表の id とちょうど同じ。どれも決まったテストのファイルを持ち、なぜ戻すと困るかを書く', { timeout: 5000 }, () => {
  const byId = new Map(MUTANTS.map((m) => [m.id, m]));
  assert.deepStrictEqual(IDS_094.filter((id) => !byId.has(id)), [], '計画の表の変異が一覧に無い');
  assert.deepStrictEqual(MUTANTS.filter((m) => /^(ka|pc|lt|wd|sg|rx|bm|ci|dt|wv|pb|rn)-/.test(m.id) && !IDS_094.includes(m.id)).map((m) => m.id), [], 'IDS_094 に無い 0.9.4 の頭の変異がある');
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-22-094.md'), 'utf8');
  const table = plan.slice(plan.indexOf('## 変異確認'), plan.indexOf('## ゲート'));
  const rows = [...table.matchAll(/^\| ([a-z][a-z0-9-]*) \|/gm)].map((m) => m[1]).filter((id) => id !== 'id');
  assert.deepStrictEqual(IDS_094.filter((id) => !rows.includes(id)), [], '計画の表に無い id');
  // 0.9.4 S-8 で意図して足した: IDS_094 は計画の「変異確認」の表とちょうど同じ（表の id は全部 IDS_094 にある）
  assert.deepStrictEqual(rows.filter((id) => !IDS_094.includes(id)), [], 'IDS_094 に無い表の id');
  assert.strictEqual(rows.length, IDS_094.length, '表の行の数が IDS_094 と違う');
  assert.strictEqual(new Set(IDS_094).size, IDS_094.length);
  for (const id of IDS_094) {
    const m = byId.get(id);
    assert.ok(Array.isArray(m.tests) && m.tests.length > 0 && m.tests.every((t) => /^test\/[^/]+\.test\.js$/.test(t)), `${id}: tests`);
    assert.ok(typeof m.why === 'string' && m.why.startsWith('0.9.4 '), `${id}: why`);
  }
});

// 0.10.0（計画 docs/plans/2026-10-20-100.md の「変異確認」の表）: MCP の読む道具・議事録のリンク・要約のローカル AI をやめることの直しを1つずつ戻す変異。
// タスクを作るたびに足す（表の全部とちょうど同じにそろえるのは G-1。それまでは「どれも表にある」と「接頭の変異は IDS_100 にある」を見る）
const IDS_100 = [
  'mcp-ro-flag', 'mcp-query-only', 'mcp-lock-check', 'mcp-lock-recheck', 'mcp-lock-stale', 'mcp-close', 'mcp-version', 'mcp-read-code', 'mcp-data-dir-rel',
  'mcp-proto-unsupported', 'mcp-proto-legacy', 'mcp-proto-meta',
  'mcp-stdout-guard', 'mcp-chdir', 'mcp-line-cap', 'mcp-stdin-utf8', 'mcp-eof-drain', 'mcp-log-message',
  'mcp-cap-chars', 'mcp-cap-list', 'mcp-arg-date', 'mcp-ref-strict', 'mcp-oneline', 'mcp-invisible',
  'mcp-pass-window-overlap', 'mcp-pass-window-size', 'mcp-pass-per-meeting', 'mcp-pass-rank', 'mcp-time-order', 'mcp-anchor-order', 'mcp-hit-forge', 'mcp-hit-mark',
  'mcp-pass-short-term', 'mcp-pass-multi-term', 'mcp-pass-failed', 'mcp-pass-dates', 'mcp-pass-types', 'mcp-pass-personal', 'mcp-ref-personal', 'mcp-pass-oneline', 'mcp-pass-quote',
  'mcp-get-listed', 'mcp-ref', 'mcp-transcript-page', 'mcp-failed-text', 'mcp-memo-quote', 'mcp-sections',
  'mcp-multi-cursor', 'mcp-multi-listed', 'mcp-expand-listed', 'mcp-expand-cap', 'mcp-pass-anchor',
  'mcp-pass-visible-sql', 'mcp-pass-df-hidden',
  'pt-target', 'pt-upload',
  'lk-head-css',
  'cfg-keep-others', 'cfg-taken', 'cfg-msix', 'cfg-stale', 'cfg-claude-running',
  'cfg-broken-write', 'cfg-backup', 'cfg-backup-keep', 'cfg-gone',
  'cfg-ui-running', 'cfg-ui-noclaude', 'cfg-ui-unreg', 'cfg-ui-notice',
];
test('G3: 0.10.0 の変異が一覧にそろい、IDS_100 はどれも計画の「変異確認」の表にある。mcp-・cfg-・lk-・ls-・stl-・nl-・pt- の変異は IDS_100 にある。どれも決まったテストのファイルを持ち、なぜ戻すと困るかを書く', { timeout: 5000 }, () => {
  const byId = new Map(MUTANTS.map((m) => [m.id, m]));
  assert.deepStrictEqual(IDS_100.filter((id) => !byId.has(id)), [], 'IDS_100 の変異が一覧に無い');
  assert.strictEqual(new Set(IDS_100).size, IDS_100.length, 'IDS_100 に重なり');
  assert.deepStrictEqual(MUTANTS.filter((m) => /^(mcp|cfg|lk|ls|stl|nl|pt)-/.test(m.id) && !IDS_100.includes(m.id)).map((m) => m.id), [], 'IDS_100 に無い 0.10.0 の接頭の変異がある');
  const plan = fs.readFileSync(path.join(ROOT, 'docs', 'plans', '2026-10-20-100.md'), 'utf8');
  // D60 で計画を分けた（メモの型と打ち合わせの質は 0.11.0・話者は 0.12.0 の計画）。0.10.0 の表は1つ
  const table = plan.slice(plan.indexOf('## 変異確認（直しを1つ戻すと'), plan.indexOf('## ゲート'));
  const rows = [...table.matchAll(/^\| ([a-z][a-z0-9-]*) \|/gm)].map((m) => m[1]).filter((id) => id !== 'id');
  assert.ok(rows.length > 50, '計画の表が読めない');
  assert.deepStrictEqual(IDS_100.filter((id) => !rows.includes(id)), [], '計画の「変異確認」の表に無い変異');
  for (const id of IDS_100) {
    const m = byId.get(id);
    assert.ok(Array.isArray(m.tests) && m.tests.length > 0 && m.tests.every((t) => /^test\/[^/]+\.test\.js$/.test(t)), `${id}: tests`);
    assert.ok(typeof m.why === 'string' && m.why.startsWith('0.10.0 '), `${id}: why`);
  }
});
