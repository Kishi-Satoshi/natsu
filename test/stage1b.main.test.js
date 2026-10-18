/*
 * stage1b.main.test.js — 第1b回の main（画面の覚え書き・拡大・一時停止・スリープ）を、main.js を偽の Electron の上で本当に動かして確かめる
 * 場面は helpers/json-scenes.js の ws-*（helpers/mainrun.js の --json-scene）。1つずつ別のプロセスで、4 つずつ並べて走らせる。
 */
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFile } = require('node:child_process');

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
const ws = (r) => (r.winStateText == null ? null : JSON.parse(r.winStateText));

describe('第1b回 画面の覚え書き（main）', { concurrency: Number(process.env.NATSU_SCENE_CONCURRENCY) || 4 }, () => {
  test('N6: 覚え書きが無ければ今と同じ 1120×780（位置なし＝真ん中）・820×560 の下限・100%。地色は N1 の地', SCENE, async () => {
    const r = await run('ws-none');
    assert.deepStrictEqual([r.windowOpts.width, r.windowOpts.height, r.windowOpts.x, r.windowOpts.y], [1120, 780, undefined, undefined]);
    assert.deepStrictEqual([r.windowOpts.minWidth, r.windowOpts.minHeight], [820, 560]);
    assert.ok(['#ffffff', '#191919'].includes(String(r.windowOpts.backgroundColor).toLowerCase()), r.windowOpts.backgroundColor);
    assert.deepStrictEqual(r.ui, { sidebar: { width: 260, collapsed: false }, tabs: { open: [], active: '' } });
    assert.strictEqual(r.winStateText, null, '起動しただけで書いた');
  });

  test('N6・F7: 大きさ・最大化・拡大・サイドバー・タブが戻る。無いページと録音中のページのタブは外し、engine.log には数だけ', SCENE, async () => {
    const r = await run('ws-restore');
    assert.deepStrictEqual([r.windowOpts.x, r.windowOpts.y, r.windowOpts.width, r.windowOpts.height], [100, 80, 1200, 800]);
    assert.strictEqual(r.maximizeCalls, 1);
    assert.deepStrictEqual(r.zooms, [1.5], '読み込みの後に覚えた倍率を当てていない');
    assert.deepStrictEqual(r.ui.sidebar, { width: 300, collapsed: true });
    assert.deepStrictEqual(r.ui.tabs, { open: ['page:pkeep1', 'dictation'], active: 'dictation' });
    assert.ok(r.engineLog.some((l) => /画面の覚え書き: 無いページのタブを 2 個外した/.test(l)), r.engineLog.join('\n'));
    assert.ok(!r.engineLog.some((l) => l.includes('pgone')), 'engine.log にページの id を書いた');
  });

  test('N6・F1: 外した画面の上の位置は使わず、既定の大きさで真ん中', SCENE, async () => {
    const r = await run('ws-offscreen');
    assert.deepStrictEqual([r.windowOpts.x, r.windowOpts.y, r.windowOpts.width, r.windowOpts.height], [undefined, undefined, 1120, 780]);
  });

  test('N6・F2: 最小化中に動いても、覚えるのは元の位置と大きさ（-32000 を書かない）', SCENE, async () => {
    const r = await run('ws-minimized');
    assert.deepStrictEqual(ws(r).bounds, { x: 300, y: 200, width: 1000, height: 700 });
  });

  test('RF21・JS7・JS8: 窓を続けて動かしても書き込みはまとめ、書き出しの合図（suspend）の受け口が返る前に最後の位置が書かれている', SCENE, async () => {
    const r = await run('ws-batch');
    assert.strictEqual(r.before, null, '間隔の前に書いた（まとめていない）');
    assert.deepStrictEqual(ws({ winStateText: r.after }).bounds, { x: 420, y: 330, width: 1200, height: 800 });
    assert.ok(r.localFiles.includes('natsu/window-state.json'), r.localFiles.join(','));
    assert.ok(!r.files.includes('window-state.json'), 'Roaming（userData）に書いた');
  });

  test('N6・F4: Ctrl+＋／－／0・JIS の Ctrl+；・テンキー・ホイールで段を動かし、近道は preventDefault でメニューに渡さない。200% で止まり、終わりに覚える', SCENE, async () => {
    const r = await run('ws-zoom');
    assert.deepStrictEqual(r.zooms.slice(0, 6), [1.1, 1.25, 1.5, 1.25, 1, 1.1]);
    assert.deepStrictEqual(r.prevented, ['=', '=', ';', '-', '0', '+'], '拡大でないキー（p）まで止めたか、拡大のキーを止めていない');
    assert.strictEqual(r.zooms[r.zooms.length - 1], 2, '200% を越えた');
    assert.strictEqual(ws(r).zoom, 2);
  });

  test('F3・RF22: 読めない覚え書きには、窓を動かしても画面から頼まれても書かない（書き出しの合図の後も1バイトも変わらない）', SCENE, async () => {
    const r = await run('ws-unreadable');
    assert.strictEqual(r.winStateText, r.localBefore, '読めなかったファイルを上書きした');
    assert.ok(r.engineLog.some((l) => /画面の覚え書き: 読めないので、この起動では書かない（EBUSY）/.test(l)));
  });

  test('F3・JS2・P16: 壊れた覚え書きは退けて既定で開き、知らせ W1 を1回。作り直せるファイルなので古い控えは3つまで', SCENE, async () => {
    const r = await run('ws-broken');
    const broken = r.localFiles.filter((f) => f.startsWith('natsu/window-state.json.broken-'));
    assert.strictEqual(broken.length, 3, broken.join(','));
    assert.strictEqual(r.notices.filter((n) => n.includes('画面の覚え書き（窓の大きさ・開いていたタブ）のファイルが壊れていたため')).length, 1);
    assert.deepStrictEqual([r.windowOpts.width, r.windowOpts.height], [1120, 780]);
  });

  test('N6: 画面から来た覚え書きは照らしてから書く（幅を寄せる・録音中のタブと形の悪い鍵を捨てる）', SCENE, async () => {
    const r = await run('ws-ui-set');
    assert.deepStrictEqual(ws(r).sidebar, { width: 480, collapsed: false });
    assert.deepStrictEqual(ws(r).tabs, { open: ['settings'], active: 'settings' });
  });
});
