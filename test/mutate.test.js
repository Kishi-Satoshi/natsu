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
    for (const t of m.tests) assert.ok(fs.existsSync(path.join(ROOT, t)), `${m.id}: ${t}`);
  }
});

test('G3: applyMutant はちょうど1回だけ置き換え、0 回や2回なら投げる', { timeout: 5000 }, () => {
  assert.strictEqual(M.applyMutant('a + b', { from: '+', to: '-' }), 'a - b');
  assert.throws(() => M.applyMutant('a + b', { from: '*', to: '/' }));
  assert.throws(() => M.applyMutant('a + b + c', { from: '+', to: '-' }));
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
  'mn-recovery-retry', 'mn-recovery-rewrite', 'mn-transcript-notice', 'mn-log-reason',
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
  'stt-auth-only', 'stt-redirect', 'stt-429-wait', 'stt-429-long', 'stt-waitcap', 'stt-offline-class', 'stt-https-only', 'stt-preset-fixed', 'stt-400-noprompt',
  'sec-unavailable', 'sec-basic-text', 'sec-reencrypt', 'sec-key-re',
  'cl-strip-prefix', 'cl-strip-case', 'cl-auth-gate', 'cl-no-bare', 'cl-no-persist', 'cl-safe-mode', 'cl-old-version', 'cl-tools-off', 'cl-stdin-cap', 'cl-limit-class', 'cl-reset-at', 'cl-timeout-kill', 'cl-cmd-only', 'cl-cwd',
  'mn-no-fallback', 'mn-offline-local', 'mn-seg-fallback', 'mn-429-no-local', 'mn-route-count', 'mn-localonly-draft', 'mn-notice-once', 'mn-recovery-keep', 'mn-input-same',
  'mn-warm-local', 'mn-localonly-summary', 'mn-recovery-local-keep', 'mn-recovery-engine-keep', 'mn-key-decrypt',
  'st-claude-cmd', 'ui-key-cleared', 'ui-localonly-final', 'gate-online',
];
// 0.7.0 U-1（設計書 D5）で、直しそのものが無くなったので外した変異（同意を見ない・同意と URL のキーが無い）
const IDS_1C_RETIRED = ['on-order-consent', 'on-consent-unknown', 'st-consent-ask', 'st-url-https'];
// 第1c回の各タスクの点検で、テストを足して殺した変異（計画の表の外。合流の申し送り）
const IDS_1C_REVIEW = [
  'ui-localonly-reset', 'ui-localonly-cloud', 'mn-status-cloud', 'mn-page-view',
  'on-redirect-up', 'sec-unreadable-set', 'sec-unreadable-remove', 'stt-403-auth', 'stt-413', 'cl-out-cap', 'cl-exit-nonzero', 'cl-auth-timeout',
  'mn-ask-no-decrypt', 'mn-announce-localonly', 'mn-localonly-oneway',
];
test('G3: 第1c回の変異が一覧にそろう（計画の「変異確認」の表と同じ id、と点検で足した id。0.7.0 U-1 で外した4つは無い）', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual([...IDS_1C, ...IDS_1C_REVIEW].filter((id) => !ids.has(id)), []);
  assert.deepStrictEqual(IDS_1C_RETIRED.filter((id) => ids.has(id)), []);
});

// 0.7.0 U-1・U-2（計画 docs/plans/2026-10-19-ui07.md の「変異確認」の表）
const IDS_U07 = ['u1-fixed-provider', 'u1-key-openai-only', 'u1-nokey-noprobe', 'u1-retired-keys', 'u1-ui-no-provider'];
test('G3: 0.7.0 U-1・U-2 の変異が一覧にそろう', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual(IDS_U07.filter((id) => !ids.has(id)), []);
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
  'lf-ui-install-shown', 'lf-ui-login-shown', 'lf-ui-disable', 'lf-msg-login-button', 'lf-key-invalid', 'lf-key-scope-retry', 'lf-key-scope-only',
  'lf-key-quota', 'lf-key-scope-msg', 'lf-key-silent', 'lf-key-no-hint', 'lf-key-waitcap', 'lf-key-ratelong', 'lf-key-msg-main', 'lf-ui-key-msg',
  'lf-ping-notfound', 'lf-status-timeout', 'lf-status-overloaded', 'lf-win-quote', 'lf-install-del-env', 'fx-hidden-important', 'fx-hidden-weak',
  'fx-live-pad', 'fx-side-ic', 'fx-side-ic-html', 'fx-pal-grey', 'fx-seg-index', 'fx-seg-index-stale', 'fx-seg-index-first', 'fx-cv', 'fx-cv-clip',
];
test('G3: 第1b回・第1b2回・Lane F と直しの変異が一覧にそろい、第1b2回で消した look-sel-line は無い', { timeout: 5000 }, () => {
  const ids = new Set(MUTANTS.map((m) => m.id));
  assert.deepStrictEqual([...IDS_1B, ...IDS_1B_REVIEW, ...IDS_1B2, ...IDS_1B_FIX].filter((id) => !ids.has(id)), []);
  assert.ok(!ids.has('look-sel-line'), '第1b2回で左の線をやめたのに look-sel-line が残っている');
});
