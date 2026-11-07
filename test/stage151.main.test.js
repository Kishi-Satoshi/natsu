/*
 * stage151.main.test.js — 0.15.1 の main の場面（計画 docs/plans/2026-11-04-151.md の Task ND-2）
 * 偽の Electron の上で main.js を本当に動かして確かめる（helpers/mainrun.js の --mic-feed）。
 * ND-2（D114・F147〜F150・F152〜F154・F156）: main から音声入力をなくす。登録する全体のキーは議事録のキーだけ・Esc を全体のホットキーにしない・
 *       前の音声入力の履歴（history.json）と残した音声（data/dictwait）を読まない・書かない・消さない・退けない・音声入力の IPC が無い・
 *       録音バーを起こすのは会議だけ・トレイの項目とツールチップ・会議の録音中の守りは今のまま・会議と分け合う部品（つなぎ言葉の除き・［コピー］の常駐の口）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const sceneRun = (args, timeout = 30000) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01' }, maxBuffer: 1 << 24, timeout },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const mic = (steps, ...flags) => sceneRun(['text', `--mic-feed=${JSON.stringify(steps)}`, ...flags]);
const ipcOf = (o, ch) => o.ipc.filter(([c]) => c === ch).map(([, r]) => r);
const T = { timeout: sceneTimeout(30000) };
const OLD = { hotkey: 'Control+Shift+Space', autoPaste: false, aiTidy: false, maxHistory: 300 };
const OLD_KEYS = Object.keys(OLD);
const ML = (s) => [['line', s], ['clock', 2000]];
const STT = '/v1/audio/transcriptions';

// ---------------------------------------------------------------- F147・WQ5: 全体のキー
test('ND-2・F147・WQ5: 登録する全体のキーはちょうど議事録のキーだけ（前の設定に音声入力のキーがあっても Ctrl+Shift+Space も Escape も登録しない）。設定で議事録のキーを Ctrl+Alt+M に変えると、そのキーだけが登録される', T, async () => {
  const o = await mic([['sleep', 200], ['snap', 'boot'], ['save', { meetingHotkey: 'Control+Alt+M' }, OLD_KEYS], ['snap', 'saved']], '--old-settings');
  assert.deepStrictEqual(o.snaps.boot.keys, ['Alt+M'], JSON.stringify(o.registerLog));
  assert.deepStrictEqual(o.snaps.saved.keys, ['Control+Alt+M'], JSON.stringify(o.registerLog));
  assert.ok(!o.registerLog.includes('Control+Shift+Space') && !o.registerLog.includes('Escape'), JSON.stringify(o.registerLog));
  assert.deepStrictEqual([...new Set(o.registerLog)].sort(), ['Alt+M', 'Control+Alt+M'], JSON.stringify(o.registerLog));
});

test('ND-2・F147: 議事録のキー Alt+M をほかのアプリが使っていると、画面の状態の文・記録・トレイの注記がそれを言う（音声入力の側は出ない）', T, async () => {
  const o = await mic([['sleep', 200], ['ipc', 'hotkey:state'], ['snap', 'boot']], '--old-settings', '--refuse-keys=Alt+M');
  const [st] = ipcOf(o, 'hotkey:state');
  assert.strictEqual(st.message, '議事録のホットキー Alt+M は他のアプリが使用中のため登録できていません', JSON.stringify(st));
  assert.deepStrictEqual(st.failed, ['議事録'], JSON.stringify(st));
  assert.ok(o.engineLog.includes('ホットキー: 議事録のホットキー Alt+M は他のアプリが使用中のため登録できていません'), o.engineLog.join('\n'));
  assert.deepStrictEqual(o.snaps.boot.tray.filter(([l]) => /^ホットキー/.test(l)), [['ホットキー （Alt+M は登録できず）', false]], JSON.stringify(o.snaps.boot.tray));
  assert.deepStrictEqual(o.snaps.boot.keys, [], JSON.stringify(o.registerLog));
  assert.ok(!o.registerLog.includes('Control+Shift+Space'), JSON.stringify(o.registerLog));
  assert.ok(!/音声入力/.test(JSON.stringify([st, o.snaps.boot.tray, o.snaps.boot.tip])), JSON.stringify([st, o.snaps.boot]));
});

// ---------------------------------------------------------------- F151: 前の設定のキー
test('ND-2・F151: 前の設定の4つのキー（hotkey・autoPaste・aiTidy・maxHistory）は、画面から設定を1つ保存しても同じ値でファイルに残る', T, async () => {
  const o = await mic([['sleep', 200], ['save', { theme: 'dark' }, OLD_KEYS], ['ipc', 'settings:get']], '--old-settings');
  assert.strictEqual(ipcOf(o, 'save')[0].ok, true, JSON.stringify(o.ipc));
  const file = JSON.parse(o.settingsText);
  assert.strictEqual(file.theme, 'dark', '前提: 保存した');
  for (const k of OLD_KEYS) assert.deepStrictEqual(file[k], OLD[k], `${k}: ${o.settingsText}`);
  // settings:get は今どおり settings をそのまま返す（4つのキーも渡るが、画面は読まず、保存で送らない: 0.7.0 U-1 の前のキーと同じ）
  const [got] = ipcOf(o, 'settings:get');
  for (const k of OLD_KEYS) assert.deepStrictEqual(got[k], OLD[k], `${k}: ${JSON.stringify(got)}`);
});

// ---------------------------------------------------------------- F152: 利用者のファイル
for (const [name, flags] of [['正しい 500 件の履歴と残した音声 3 つ', ['--history-file=ok', '--dictwait=3']], ['壊れた JSON の履歴', ['--history-file=broken']]]) {
  test(`ND-2・F152（${name}）: 起動 → 見回り3回 → 会議（区間2つ）→ 締め → 終わりの書き出しの間、history.json と data/dictwait の WAV のバイト・更新の時刻・名前が同じで、退けたファイルができない。知らせと記録に履歴の文が無く、見回りは音声入力の音声を送らない`, { timeout: sceneTimeout(60000) }, async () => {
    const o = await mic([['sleep', 200], ['snap', 'b'], ['tick'], ['tick'], ['tick'], ['snap', 't'], ['start'], ['seg', 2], ['seg', 2], ['stop'], ['session-end'], ['quit']], '--relay=text', ...flags);
    assert.ok(o.userKeepBefore && o.userKeepBefore.history, '前提: 履歴のファイルを置いた');
    if (flags.includes('--dictwait=3')) assert.strictEqual(Object.keys(o.userKeepBefore.dictwait).length, 3, '前提: 残した音声を3つ置いた');
    assert.deepStrictEqual(o.userKeep, o.userKeepBefore, '利用者の前の音声入力のファイルが変わった');
    assert.deepStrictEqual(o.userKeep.historyNames, ['history.json'], '退けたファイルができた');
    assert.ok(o.pageFinal.length >= 1, '前提: 会議を締めた');
    assert.ok(!o.notices.some((n) => /履歴/.test(n)), JSON.stringify(o.notices));
    assert.ok(!o.engineLog.some((l) => /音声入力|history|dictwait/.test(l)), o.engineLog.join('\n'));
    assert.deepStrictEqual(o.relayCalls.slice(o.snaps.b.relayN, o.snaps.t.relayN).filter((p) => p === STT), [], `見回りが音声入力の音声を送った: ${o.relayCalls}`);
  });
}

// ---------------------------------------------------------------- 決めたこと 12・F156: IPC
test('ND-2・決めたこと 12・F156: 音声入力の IPC は無い。録音バーの窓から audio:done と overlay:cancel-request を送っても、クリップボード・常駐の口・ファイル・知らせ・状態のどれも変わらない', T, async () => {
  const o = await mic([['sleep', 200], ['snap', 'b'], ['ipc-from', 'overlay', 'audio:done', { buffer: Array.from({ length: 64 }, () => 0), durationMs: 3000 }], ['sleep', 300],
    ['ipc-from', 'overlay', 'overlay:cancel-request'], ['ipc-from', 'main', 'overlay:cancel-request'], ['sleep', 100], ['snap', 'a']], '--paster-log', '--history-file=ok', '--dictwait=1');
  for (const ch of ['history:get', 'history:delete', 'history:clear', 'app:toggle-recording', 'dictation:cancel']) assert.ok(!o.handles.includes(ch), `ipcMain.handle('${ch}') がある`);
  for (const ch of ['audio:done', 'dictation:where-answer', 'overlay:cancel-request']) assert.ok(!o.ons.includes(ch), `ipcMain.on('${ch}') がある`);
  assert.ok(o.handles.includes('clipboard:copy') && o.ons.includes('overlay:confirm'), '前提: 会議と［コピー］の口はある');
  assert.deepStrictEqual([o.clipWrites, o.pasterLines, o.notices], [[], [], []], JSON.stringify([o.clipWrites, o.pasterLines, o.notices]));
  assert.deepStrictEqual(o.userKeep, o.userKeepBefore);
  assert.strictEqual(o.snaps.a.sentN, o.snaps.b.sentN, '本体の窓へ何か送った');
  assert.deepStrictEqual([o.snaps.a.active, o.snaps.a.tip], [false, o.snaps.b.tip], '状態が変わった');
  assert.ok(!o.overlayPhases.length, JSON.stringify(o.overlayPhases));
});

// ---------------------------------------------------------------- F156: 録音バーは会議だけ
test('ND-2・F156: 録音バーを起こすのは会議だけ（画面のボタン・会議のホットキー・トレイ・オフラインモード・録音の前のページ・会議の検出のパネルのどこから始めても overlay:start の mode は meeting）。中継の整えの口へ何も送らない', { timeout: sceneTimeout(90000) }, async () => {
  const scenes = [
    [[['sleep', 200], ['start'], ['seg', 2], ['stop'], ['hotkey-meeting'], ['stop'], ['tray-start'], ['stop']], '--relay=text'],
    [[['sleep', 200], ['ipc', 'meeting:start', { pcOnly: true }], ['stop']]],
    [[['sleep', 200], ['ipc', 'meeting:prepare'], ['ipc', 'meeting:start', {}], ['seg', 2], ['stop']], '--relay=text'],
    [[...ML('mic teams:1'), ...ML('mic teams:1'), ['wait-show', 1], ['ipc', 'nudge:start', {}], ['sleep', 100], ['stop']]],
  ];
  for (const [steps, ...flags] of scenes) {
    const o = await mic(steps, ...flags);
    const starts = o.overlaySent.filter((p) => p && typeof p === 'object');
    assert.ok(starts.length >= 1, `前提: 録音バーを起こした: ${JSON.stringify(steps)}`);
    assert.deepStrictEqual(starts.map((p) => p.mode), starts.map(() => 'meeting'), JSON.stringify(starts));
    assert.ok(!o.relayCalls.includes('/v1/text/tidy'), JSON.stringify(o.relayCalls));
    if (o.tidy) assert.deepStrictEqual(o.tidy.requests, [], '中継の整えの口へ送った');
  }
});

// ---------------------------------------------------------------- F149・RF9: Esc
test('ND-2・F149・RF9: 起動 → 会議 → 本体の窓のフォーカスの出し入れ3回 → 締め → 待機 の間、Escape を全体のホットキーに1回も登録しない', T, async () => {
  const fb = [['focus-main'], ['snap', 'f'], ['blur-main'], ['snap', 'bl']];
  const o = await mic([['sleep', 200], ['snap', 'boot'], ['start'], ['snap', 'rec'], ...fb, ...fb, ...fb, ['seg', 2], ['stop'], ['snap', 'idle']], '--main-unfocused');
  for (const k of ['boot', 'rec', 'f', 'bl', 'idle']) assert.strictEqual(o.snaps[k].escape, false, `${k}: Escape が付いている`);
  assert.ok(!o.registerLog.includes('Escape'), JSON.stringify(o.registerLog));
  assert.deepStrictEqual(o.escapeLog, []);
});

// ---------------------------------------------------------------- F150・決めたこと 8: トレイ
test('ND-2・F150・決めたこと 8: トレイの項目とツールチップ（待機は［議事録の記録を開始］から・会議の録音中・作成中）。どの項目にも「音声入力」が無く、「文字起こし」で始まる物も無い', T, async () => {
  const o = await mic([['sleep', 200], ['snap', 'idle'], ['start'], ['seg', 2], ['snap', 'rec'], ['ipc', 'meeting:toggle'], ['snap', 'fin'], ['finish'], ['snap', 'after']]);
  const names = (k) => o.snaps[k].tray.map(([l]) => l);
  const on = (k, l) => (o.snaps[k].tray.find(([x]) => x === l) || [])[1];
  assert.deepStrictEqual(names('idle'), ['議事録の記録を開始', 'ノートを開く', '更新を確認', 'エンジンを停止（メモリを解放）', '終了'], JSON.stringify(o.snaps.idle.tray));
  assert.strictEqual(on('idle', '議事録の記録を開始'), true);
  assert.strictEqual(on('idle', '更新を確認'), true);
  assert.strictEqual(o.snaps.idle.tip, 'NaTsu — Alt+M: 議事録');
  assert.deepStrictEqual(names('rec'), ['■ 議事録を終了して作成', '議事録を破棄', 'ノートを開く', '更新を確認', 'エンジンを停止（メモリを解放）', '終了'], JSON.stringify(o.snaps.rec.tray));
  assert.strictEqual(on('rec', '更新を確認'), false);
  assert.strictEqual(o.snaps.rec.tip, 'NaTsu — 議事録を記録中');
  assert.deepStrictEqual(o.snaps.fin.tray[0], ['議事録を作成中…', false], JSON.stringify(o.snaps.fin.tray));
  assert.ok(!names('fin').includes('議事録の記録を開始'), JSON.stringify(o.snaps.fin.tray));
  assert.strictEqual(o.snaps.fin.tip, 'NaTsu — 処理中');
  assert.deepStrictEqual(names('after'), names('idle'));
  assert.strictEqual(o.snaps.after.tip, 'NaTsu — Alt+M: 議事録');
  // 0.15.1 ND-1（点検の軽い指摘 M4・計画の R29）: トレイのアイコンは会議の録音中だけ録音の印（作成中と待機は待機のアイコン）
  // （Windows は .ico、ほかは .png を読む）
  assert.deepStrictEqual(['idle', 'rec', 'fin', 'after'].map((k) => o.snaps[k].icon.replace(/\.(png|ico)$/, '')), ['tray', 'tray-rec', 'tray', 'tray']);
  for (const k of ['idle', 'rec', 'fin', 'after']) {
    assert.ok(!names(k).some((l) => /音声入力/.test(l) || /^文字起こし/.test(l)), JSON.stringify(o.snaps[k].tray));
    assert.ok(!/音声入力/.test(o.snaps[k].tip), o.snaps[k].tip);
  }
});

// ---------------------------------------------------------------- F148: 会議の録音中の守り
test('ND-2・F148: 会議の録音中は［更新して再起動］を断り（recording）・眠らせず・エンジンの設定の保存を鍵で留め・トレイの［更新を確認］を押せず・閉じるボタンで確かめる', T, async () => {
  const o = await mic([['sleep', 200], ['snap', 'idle'], ['start'], ['seg', 2], ['ipc', 'app:restart'], ['save', { localPort: 18999 }], ['snap', 'rec'], ['close-main'], ['snap', 'closed'], ['stop']]);
  assert.deepStrictEqual(ipcOf(o, 'app:restart').map((r) => [r.ok, r.code]), [[false, 'recording']], JSON.stringify(o.ipc));
  assert.strictEqual(o.snaps.idle.powerOn, false, '前提: 待機は眠らせてよい');
  assert.strictEqual(o.snaps.rec.powerOn, true, '会議の録音中に眠らせない印が無い');
  const [sv] = ipcOf(o, 'save');
  assert.ok(sv.warning, `エンジンの設定を鍵で留めていない: ${JSON.stringify(sv)}`);
  assert.notStrictEqual(JSON.parse(o.settingsText).localPort, 18999, o.settingsText);
  assert.ok(o.snaps.rec.tray.some(([l, en]) => l === '更新を確認' && en === false), JSON.stringify(o.snaps.rec.tray));
  assert.deepStrictEqual(o.closes, [1], '閉じるボタンを止めていない');
  assert.strictEqual(o.snaps.closed.dialogsN, o.snaps.rec.dialogsN + 1, '閉じるときの確かめが出ていない');
});

// ---------------------------------------------------------------- F153: 会議と分け合う部品
test('ND-2・F153: 会議の区間の文のつなぎ言葉は今どおり除く（設定「フィラー除去」。dictTidy.dropFillers）', T, async () => {
  const o = await mic([['sleep', 200], ['start'], ['seg', 2], ['stop']], '--relay=text', '--relay-text=えーと、本日の議題は予算です。');
  const segs = o.pageSegs.flat().filter(Boolean);
  assert.ok(segs.some((t) => t.includes('本日の議題は予算です。')), JSON.stringify(o.pageSegs));
  assert.ok(!segs.some((t) => t.includes('えーと')), JSON.stringify(o.pageSegs));
});

test('ND-2・F153: 画面の［コピー］は今どおり Windows の常駐の PowerShell に copy の命令を送る（Win+V の履歴に入れない印。clipboard:copy → copyPrivate）', T, async () => {
  const o = await mic([['sleep', 200], ['copy', '写す文']], '--paster-log');
  assert.deepStrictEqual(ipcOf(o, 'copy'), [true]);
  assert.deepStrictEqual(o.pasterLines, [`copy ${Buffer.from('写す文', 'utf8').toString('base64')}\n`], JSON.stringify(o.pasterLines));
  assert.ok(!o.pasterLines.some((l) => /^(fg|paste)\b/.test(l)), JSON.stringify(o.pasterLines));
});
