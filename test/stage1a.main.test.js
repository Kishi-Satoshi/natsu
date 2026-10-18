/*
 * stage1a.main.test.js — 第1a回の保存の守りを、main.js を偽の Electron の上で本当に動かして確かめる（helpers/mainrun.js の --json-scene）
 * 場面は1つずつ別のプロセス（main.js はモジュールの中に状態を持つ）。4 つずつ並べて走らせ、各テストは自分の場面だけを待つ。
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');
const SC = require('./helpers/json-scenes');

const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
// 場面は作業環境で 0.3〜1 秒。見張りは 20 秒（Windows の CI と変異確認の写しでは機械が混むため。「この回で足す決まり」）
const SCENE = { timeout: 20000 };
function run(scene) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [RUN, 'text', `--json-scene=${scene}`], { timeout: 19000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(`場面 ${scene} が失敗: ${err.message}\n${stderr}`)); return; }
      const last = stdout.trim().split('\n').pop();
      try { resolve(JSON.parse(last)); } catch (e) { reject(new Error(`場面 ${scene} の出力を読めない: ${last}\n${stderr}`)); }
    });
  });
}
const brokenOf = (r, base) => r.files.filter((f) => f.startsWith(`${base}.broken-`));
const ISO_BROKEN = (base) => new RegExp(`^${base.replace('.', '\\.')}\\.broken-\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-\\d{3}Z$`);
const label = (k) => require('../src/settings').SETTING_RULES[k].label;
// この回の知らせ（N1〜N17）だけを拾う（エンジンの案内など、ほかの知らせが混ざっても見誤らない）
const OURS = /^(設定の|設定を|音声入力の履歴|議事録のファイル|議事録の文字起こし|前回の会議の下書き|文字起こし待ちの記録)/;
const ours = (notices) => notices.flatMap((n) => String(n).split('　')).filter((n) => OURS.test(n));

// 4 つずつ並べる。変異確認（tools/mutate.js）は NATSU_SCENE_CONCURRENCY=1 で1つずつにする（写しを並べて回すので機械が混む）
describe('第1a回 保存の守り（main）', { concurrency: Number(process.env.NATSU_SCENE_CONCURRENCY) || 4 }, () => {
  test('今の利用者の設定（今の saveJson が書いた形）は、知らせも .broken- も書き戻しも無く、同じ値で読める', SCENE, async () => {
    const r = await run('plain');
    assert.deepStrictEqual(ours(r.notices), []);
    assert.deepStrictEqual(r.files.filter((f) => f.includes('.broken-')), []);
    assert.strictEqual(r.settingsText, JSON.stringify(SC.TYPICAL, null, 2), '起動しただけで settings.json を書き直した');
    for (const [k, v] of Object.entries(SC.TYPICAL)) assert.deepStrictEqual(r.got[k], v, k);
    assert.deepStrictEqual(r.history, SC.HISTORY);
  });

  test('RF23: BOM 付きの settings.json でも全部の値のまま読め、エンジンは手で設定した exe のまま起きる', SCENE, async () => {
    const r = await run('bom');
    assert.deepStrictEqual(ours(r.notices), []);
    assert.ok(r.spawns.length >= 1 && /fake-whisper\.js$/.test(r.spawns[0].cmd), JSON.stringify(r.spawns));
    assert.deepStrictEqual(r.files.filter((f) => f.includes('.broken-')), []);
  });

  test('RF23: UTF-16（PowerShell 5.1 の Out-File）の settings.json も読める', SCENE, async () => {
    const r = await run('utf16');
    assert.strictEqual(r.got.theme, 'dark');
    assert.strictEqual(r.got.micId, 'マイク');
    assert.deepStrictEqual(ours(r.notices), []);
  });

  test('JS6・P16: 一部だけ壊れた設定は、その項目だけ直し、元を写しで残して書き戻し、知らせを1回出す（値は記録に書かない）', SCENE, async () => {
    const r = await run('repair');
    const copies = brokenOf(r, 'settings.json');
    assert.strictEqual(copies.length, 1);
    assert.match(copies[0], ISO_BROKEN('settings.json'));
    const saved = JSON.parse(r.settingsText);
    assert.deepStrictEqual([saved.maxHistory, saved.pillPos, saved.theme, saved.futureKey], [500, 'bottom', 'dark', { a: 1 }]);
    const n = ours(r.notices);
    assert.strictEqual(n.length, 1);
    assert.ok(n[0].includes(label('maxHistory')) && n[0].includes(label('pillPos')) && n[0].includes(copies[0]), n[0]);
    assert.ok(r.engineLog.some((l) => /設定: 一部を既定に戻しました（pillPos: type、maxHistory: range）/.test(l)), r.engineLog.join('\n'));
    assert.ok(!r.engineLog.some((l) => /"pillPos"\s*:\s*5|pillPos: 5/.test(l)), '値を記録に書いた');
  });

  test('JS6・N8: オンとオフの欄の "false" の文字は、今までどおりオンのまま、知らせて真偽値で書き戻す', SCENE, async () => {
    const r = await run('falselike');
    assert.strictEqual(JSON.parse(r.settingsText).autoPaste, true);
    const n = ours(r.notices);
    assert.strictEqual(n.length, 1);
    assert.ok(n[0].includes(label('autoPaste')) && n[0].includes('"false"'), n[0]);
  });

  test('JS2・P16: 壊れた settings.json は名前を変えて退け、既定で起動し、退けた名前を知らせる', SCENE, async () => {
    const r = await run('broken-json');
    const moved = brokenOf(r, 'settings.json');
    assert.strictEqual(moved.length, 1);
    assert.strictEqual(r.settingsText, null);
    assert.strictEqual(r.got.theme, 'system');
    const n = ours(r.notices);
    assert.ok(n.length === 1 && n[0].startsWith('設定のファイルが壊れていたので') && n[0].includes(moved[0]), n.join('\n'));
  });

  test('JS1: ANSI（CP932）で日本語を書いた設定は、化けた文字で書き戻さず、退けて文字の形式の知らせを出す', SCENE, async () => {
    const r = await run('ansi');
    assert.strictEqual(brokenOf(r, 'settings.json').length, 1);
    assert.ok(ours(r.notices).some((n) => n.startsWith('設定のファイルの文字の形式')), r.notices.join('\n'));
  });

  test('JS2・P16: 壊れた history.json は退けて、空の履歴で始め、知らせる', SCENE, async () => {
    const r = await run('history-broken');
    assert.strictEqual(brokenOf(r, 'history.json').length, 1);
    assert.strictEqual(r.historyText, null);
    assert.deepStrictEqual(r.history, []);
    assert.ok(ours(r.notices).some((n) => n.startsWith('音声入力の履歴のファイルが壊れていたので')), r.notices.join('\n'));
  });

  test('JS6: 一部のキーだけの設定（mainrun と同じ形）は、無いキーが黙って既定で埋まるだけ（知らせも書き戻しも無い）', SCENE, async () => {
    const r = await run('partial');
    assert.deepStrictEqual(ours(r.notices), []);
    assert.deepStrictEqual(r.files.filter((f) => f.includes('.broken-')), []);
  });

  test('JS6・SEC1: settings:save は決まりのないキーを保存しない。ファイルにあった知らないキーと保存済みの sumCtx 32768 は残す', SCENE, async () => {
    const r = await run('allowlist');
    assert.strictEqual(r.saved.ok, true);
    const saved = JSON.parse(r.settingsText);
    assert.strictEqual(saved.theme, 'light');
    for (const k of ['evil', 'dataDir', 'constructor']) assert.ok(!Object.hasOwn(saved, k), k);
    assert.deepStrictEqual(saved.futureKey, { a: 1 });
    assert.strictEqual(saved.sumCtx, 32768);
  });

  // 計画の外で足した（履歴の形の確かめを押さえるテストが無かったため。配列でない履歴を持つと、次の口述の unshift で落ちる）
  test('JS2・P16: 配列でない history.json も壊れたものとして退け、空の履歴で始め、知らせる', SCENE, async () => {
    const r = await run('history-shape');
    assert.strictEqual(brokenOf(r, 'history.json').length, 1);
    assert.deepStrictEqual(r.history, []);
    assert.ok(ours(r.notices).some((n) => n.startsWith('音声入力の履歴のファイルが壊れていたので')), r.notices.join('\n'));
  });

  // 計画の外で足した（N10 を押さえるテストが無かったため）
  test('JS5・P16: 履歴の全消しを保存できなければ知らせ（N10）、画面には消した後の履歴を返し、ファイルは元のまま・一時ファイルも残さない', SCENE, async () => {
    const r = await run('history-save-fail');
    assert.deepStrictEqual(r.cleared, []);
    assert.deepStrictEqual(r.history, []);
    assert.strictEqual(r.historyText, JSON.stringify(SC.HISTORY, null, 2));
    assert.deepStrictEqual(r.files.filter((f) => f.endsWith('.tmp')), []);
    assert.ok(ours(r.notices).some((n) => n.startsWith('音声入力の履歴の変更を保存できませんでした')), r.notices.join('\n'));
  });

  // 第1a回 Task 2-3: 書けないとき・読めないとき
  test('JS5・F2: 設定を書けなくても、テーマまで当てて warning で返し、ファイルは元のまま。次の書き出しでやり直して書ける', SCENE, async () => {
    const r = await run('save-fail');
    assert.strictEqual(r.saved.ok, true);
    assert.strictEqual(r.saved.warning, '設定を保存できませんでした。次の変更のときにもう一度保存します');
    assert.strictEqual(r.themeAfterSave, 'light');
    assert.strictEqual(JSON.parse(r.textAfterSave).theme, 'dark', '書けなかったのにファイルが変わった');
    assert.ok(r.flushed.some((x) => x.name === 'settings.json' && x.ok));
    assert.strictEqual(JSON.parse(r.settingsText).theme, 'light');
  });

  test('P14: 読み取り専用の settings.json は「管理者が決めた設定」— その起動で1回だけ知らせ、書かず、画面の変更はその起動の間だけ効く', SCENE, async () => {
    const r = await run('readonly');
    assert.ok(r.first.warning && r.first.warning.startsWith('設定のファイルが読み取り専用になっているため'), r.first.warning);
    assert.strictEqual(r.second.warning, undefined, '2回目も知らせた');
    assert.strictEqual(r.settingsText, JSON.stringify(SC.TYPICAL, null, 2));
    assert.strictEqual(r.themeSource, 'dark');
    assert.deepStrictEqual(r.files.filter((f) => f.endsWith('.tmp')), []);
  });

  test('RF22・F4: 起動で読めなかった設定は、読めるまで書かない（保存でも書き出しの合図でも）。読み直せたら本当の値に切り替え、読めない間の変更は捨てる', SCENE, async () => {
    const r = await run('unreadable');
    assert.ok(ours(r.notices).some((n) => n.startsWith('設定のファイルをほかのプログラムが使っていて読めませんでした')), r.notices.join('\n'));
    assert.strictEqual(r.textWhileUnreadable, JSON.stringify(SC.TYPICAL, null, 2), '読めない間に既定で上書きした');
    assert.ok(r.saveWhileUnreadable.ok && r.saveWhileUnreadable.warning.startsWith('設定のファイルをほかのプログラムが使っていて'));
    assert.ok(r.flushWhileUnreadable.some((x) => x.name === 'settings.json' && x.ok === false));
    assert.strictEqual(r.retries, 1);
    assert.strictEqual(r.after.theme, 'dark');
    assert.strictEqual(r.themeAfter, 'dark');
    assert.strictEqual(r.textAfterReload, JSON.stringify(SC.TYPICAL, null, 2), '切り替えたときに読めない間の変更を書いた');
    assert.ok(ours(r.notices).some((n) => n.startsWith('設定のファイルを読めたので、保存してある設定に切り替えました')));
    assert.strictEqual(JSON.parse(r.textAfterSave).theme, 'light', '切り替えた後の保存が書かれない');
  });

  test('RF22: 読めなかった設定は、設定の画面を開いたとき（settings:get）にも読み直す', SCENE, async () => {
    const r = await run('unreadable-get');
    assert.strictEqual(r.got.theme, 'dark');
    assert.strictEqual(r.got.micId, 'mic-1');
  });

  test('RF22: 読めなかった履歴は、読めるまで書かず（全消しでもファイルは元のまま）、読み直せたらファイルの履歴が戻る', SCENE, async () => {
    const r = await run('history-unreadable');
    assert.ok(ours(r.notices).some((n) => n.startsWith('音声入力の履歴のファイルをほかのプログラムが使っていて')));
    assert.deepStrictEqual(r.cleared, []);
    assert.strictEqual(r.textWhileUnreadable, JSON.stringify(SC.HISTORY, null, 2));
    assert.deepStrictEqual(r.after.map((h) => h.id), ['h1']);
  });

  // 第1a回 Task 2-4: 録音バーの位置のまとめ書き・書き出しの合図・始めの片付け
  test('RF21・JS8: どの合図でも、受け口が返る前に録音バーの位置がファイルに書かれている（合図の前はまだ書かれていない）', SCENE, async () => {
    const r = await run('signals');
    assert.deepStrictEqual(r.signals.map((s) => s.ev), ['session-end', 'query-session-end', 'suspend', 'lock-screen', 'shutdown', 'hide', 'close', 'will-quit', 'before-quit']);
    r.signals.forEach((s, i) => {
      assert.deepStrictEqual(s.after, { x: 100 + i, y: 200 }, `${s.ev} で書き出していない`);
      assert.notDeepStrictEqual(s.before, s.after, `${s.ev}: 合図の前にもう書かれていた（確かめになっていない）`);
    });
  });

  test('JS7: 続けて動かした録音バーは、間隔の後に最後の位置だけを1回書く', SCENE, async () => {
    const r = await run('batched');
    assert.deepStrictEqual(r.right, SC.TYPICAL.pillCustom, '間隔を待たずに書いた');
    assert.deepStrictEqual(r.later, { x: 9, y: 10 });
  });

  test('JS4: 起動のときに、残った JSON の一時ファイルを消す（WAV の一時ファイルは残す）', SCENE, async () => {
    const r = await run('temps');
    assert.deepStrictEqual(r.files.filter((f) => /\.json(\.\d+-[0-9a-z]+)?\.tmp$/.test(f)), []);
    assert.ok(r.files.includes('data/segbuf/4102444800000/0001.wav.tmp'), r.files.join('\n'));
  });

  test('RF22・F4: 読めない間に動かした録音バーは、合図でも書かず、読み直せたら捨てる（読めた値が勝つ）', SCENE, async () => {
    const r = await run('unreadable-move');
    assert.strictEqual(r.textAfterSignal, JSON.stringify(SC.TYPICAL, null, 2), '読めない間に合図で書いた');
    assert.strictEqual(r.textLater, JSON.stringify(SC.TYPICAL, null, 2), '読み直した後に、読めない間の位置を書いた');
    assert.deepStrictEqual(r.after.pillCustom, SC.TYPICAL.pillCustom);
  });

  test('RF21: 実機の確かめ用に、まとめ書きの間隔を NATSU_TEST_BATCH_MS で長くでき、記録に残る', SCENE, async () => {
    const r = await run('batch-env');
    assert.ok(r.engineLog.some((l) => l.includes('まとめ書きの間隔: 60000ms（試し用）')), r.engineLog.join('\n'));
  });

  test('JS8: app.exit( は relaunchAndExit の中だけで、その前に書き出す。process の exit でも書き出す。窓ができたら session-end と query-session-end を付ける', { timeout: 5000 }, () => {
    const m = require('node:fs').readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8').replace(/^[ \t]*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.strictEqual((m.match(/app\.exit\(/g) || []).length, 1);
    const fn = m.slice(m.indexOf('function relaunchAndExit()'), m.indexOf('\n', m.indexOf('function relaunchAndExit()')));
    assert.ok(fn.indexOf('flushAllWriters()') >= 0 && fn.indexOf('flushAllWriters()') < fn.indexOf('app.relaunch()') && fn.indexOf('app.relaunch()') < fn.indexOf('app.exit(0)'), fn);
    assert.strictEqual((m.match(/relaunchAndExit\(\);/g) || []).length, 2);
    assert.match(m, /process\.on\('exit', flushAllWriters\)/);
    assert.match(m, /app\.on\('browser-window-created', \(_e, w\) => \{ w\.on\('session-end', flushAllWriters\); w\.on\('query-session-end', flushAllWriters\); \}\)/);
    for (const ev of ['suspend', 'lock-screen', 'shutdown']) assert.ok(m.includes(`powerMonitor.on('${ev}', flushAllWriters)`), ev);
  });
});
