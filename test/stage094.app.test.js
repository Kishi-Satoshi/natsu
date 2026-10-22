/*
 * stage094.app.test.js — 0.9.4 の本体の画面（計画 docs/plans/2026-10-22-094.md）。最小 DOM（helpers/simrun.js）の上で app.html の <script> を本当に走らせる。
 *  S-3: ［文字起こしを後回しにして要約］（前の［文字起こしを打ち切って要約］。id liveSkipBtn のまま）と確かめの文
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/simrun.js');

const ROOT = path.join(__dirname, '..');
const APP = path.join(ROOT, 'src', 'renderer', 'app.html');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
const T = { timeout: 5000 };
const 作成中 = (extra) => Object.assign({ active: true, finalizing: true, stopping: true, pending: 3, etaSec: 150, skipped: 0, micFallback: false, startedAt: Date.now() - 60000, stoppedAt: Date.now(), segments: [] }, extra);

test('S-3: 打ち切りのボタンは『文字起こしを後回しにして要約』・確かめの文・id liveSkipBtn のまま。後回しにした数の行', T, async () => {
  let st = 作成中();
  const l = await load(APP, { preloadSrc: PRELOAD, returns: { meetingStatus: () => st, meetingSkipPending: () => ({ ok: true, skipped: 3 }) } });
  l.fire('onMeetingUpdate', st);
  await l.drain();
  const btn = l.document.getElementById('liveSkipBtn');
  assert.ok(btn && !btn.hidden);
  assert.strictEqual(btn.textContent, '文字起こしを後回しにして要約');
  const asked = [];
  l.window.confirm = (m) => { asked.push(m); return true; };
  st = 作成中({ pending: 0, etaSec: null, skipped: 3 });
  btn.dispatchEvent({ type: 'click' });
  await l.drain();
  assert.deepStrictEqual(asked, ['残っている文字起こしを後回しにして、今ある分で議事録を作ります。残りの音声は消さずに残し、後で文字起こしします。よろしいですか？']);
  assert.strictEqual(l.called('meetingSkipPending').length, 1);
  assert.strictEqual(l.document.getElementById('liveSkipped').textContent, '3 区間の文字起こしを後回しにしました（音声は残してあります）');
  const html = fs.readFileSync(APP, 'utf8');
  assert.ok(!html.includes('打ち切って要約') && !html.includes('打ち切った区間の発言は議事録に入りません'), '前の名前と文が残っている');
});
