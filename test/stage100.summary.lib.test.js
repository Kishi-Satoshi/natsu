/*
 * stage100.summary.lib.test.js — 0.10.0 Task LS-1（D59・D63・D69。決めたこと 103〜105・110・111）: 要約の経路と要約待ちの純粋な部品。
 * 要約はいつも Claude Code（オフラインモードの会議も）。届かなければ要約待ち。要約の欄の鍵（summaryLock）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const O = require('../src/online');
const lib = require('../src/mainlib');

const T = { timeout: 5000 };

test('D59: decideSummary は届けば claude-code、届かなければ wait。localOnly を渡しても claude-code（オフラインモードの会議も Claude Code）。local を返さない', T, async () => {
  for (const localOnly of [false, true, undefined]) {
    assert.strictEqual((await O.decideSummary({ localOnly, up: async () => ({ up: true, why: 'ok' }) })).route, 'claude-code', String(localOnly));
    for (const why of ['offline', 'unreachable', 'timeout', 'x']) {
      const r = await O.decideSummary({ localOnly, up: async () => ({ up: false, why }) });
      assert.strictEqual(r.route, 'wait', `${localOnly} ${why}`);
    }
  }
});

test('決めたこと 103: 要約待ちの文は「要約待ち（つながったら作ります）」', T, () => {
  assert.strictEqual(lib.SUMMARY_WAIT_TEXT, '要約待ち（つながったら作ります）');
});

test('決めたこと 104: summaryRetryPick は summaryWait のページを古い順に1つ・tried の ID は選ばない・無ければ null', T, () => {
  const pages = [
    { id: 'p3', createdAt: '2026-10-03T00:00:00.000Z', summaryWait: true },
    { id: 'p1', createdAt: '2026-10-01T00:00:00.000Z', summaryWait: true },
    { id: 'p2', createdAt: '2026-10-02T00:00:00.000Z', summaryWait: false },
    { id: 'p0', createdAt: '2026-09-30T00:00:00.000Z' },
  ];
  assert.strictEqual(lib.summaryRetryPick(pages, { tried: new Set() }), 'p1');
  assert.strictEqual(lib.summaryRetryPick(pages, { tried: new Set(['p1']) }), 'p3');
  assert.strictEqual(lib.summaryRetryPick(pages, { tried: new Set(['p1', 'p3']) }), null);
  assert.strictEqual(lib.summaryRetryPick([], {}), null);
  assert.strictEqual(lib.summaryRetryPick(null, {}), null);
  const frozen = JSON.stringify(pages);
  lib.summaryRetryPick(pages, { tried: new Set() });
  assert.strictEqual(JSON.stringify(pages), frozen);
});

test('決めたこと 110: KEPT_SUMMARY_TEXT のどの文にも「要約も PC の中」「ローカル AI の準備」が無い（文字起こし待ちの wait はそのまま）', T, () => {
  for (const [k, v] of Object.entries(lib.KEPT_SUMMARY_TEXT)) {
    assert.ok(!v.includes('要約も PC の中') && !v.includes('ローカル AI の準備'), `${k}: ${v}`);
  }
  assert.strictEqual(lib.KEPT_SUMMARY_TEXT.wait, '文字起こし待ちの音声があります。文字起こしが済むと、自動で要約を作ります。');
});

const segs = (...texts) => texts.map((t, i) => ({ id: `s${i + 1}`, text: t }));
test('D63・D69・決めたこと 111: summaryLock の表（上から順に見て最初に当たった行。5 が 6 より先）。SUMMARY_LOCK_TEXT の文', T, () => {
  const L = (page, o = {}) => lib.summaryLock(page, { segments: segs('はい'), ...o });
  // 1 録音中（要約待ちでも）
  assert.strictEqual(L({ summaryWait: true }, { live: true }), 'live');
  // 2 作っている間
  assert.strictEqual(L({ blocks: [{ id: 'b1' }] }, { making: true }), 'making');
  // 3 要約待ち（要約があっても）
  assert.strictEqual(L({ summaryWait: true, blocks: [{ id: 'b1' }] }), 'wait');
  // 4 要約が一度できた（route.summary.at がある・ブロックがある）。後でブロックを全部消しても外れたまま
  assert.strictEqual(L({ blocks: [{ id: 'b1' }] }), '');
  assert.strictEqual(L({ blocks: [], route: { summary: { by: 'claude-code', at: '2026-10-21T00:00:00.000Z' } } }), '');
  // 5 断った・失敗した（summaryError があり要約待ちでない）。文字起こしが空でも 5 が先
  assert.strictEqual(L({ summaryError: 'ログインが切れています' }), '');
  assert.strictEqual(L({ summaryError: 'ログインが切れています' }, { segments: [] }), '');
  // 6 文字起こしが空（failed の発言だけも空）
  assert.strictEqual(L({}, { segments: [] }), 'empty');
  assert.strictEqual(L({}, { segments: [{ id: 's1', text: '', failed: true }, { id: 's2', text: '   ' }] }), 'empty');
  // 7 まだ作っていない
  assert.strictEqual(L({}), 'none');
  assert.strictEqual(L(null), 'none');
  assert.deepStrictEqual(Object.keys(lib.SUMMARY_LOCK_TEXT).sort(), ['empty', 'live', 'making', 'none', 'wait']);
  assert.strictEqual(lib.SUMMARY_LOCK_TEXT.wait, '要約待ち（つながったら作ります）。要約ができるまでは直せません。書きたいことはメモに書いてください。');
  assert.strictEqual(lib.SUMMARY_LOCK_TEXT.none, '［要約を生成］で要約を作ると、直せるようになります。書きたいことはメモに書いてください。');
});
