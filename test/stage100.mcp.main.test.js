/*
 * stage100.mcp.main.test.js — 0.10.0 の main の MCP の登録の場面（計画 docs/plans/2026-10-20-100.md の Task C-2。MR8・F2・F4・RF61・RF63・D75・D76）
 * Claude デスクトップの設定ファイル（claude_desktop_config.json）へ NaTsu の1項目を足す・外す・起動の後に確かめる。
 * 場面は helpers/mainrun.js を別のプロセスで回す（--claude-config=<場面> で一時フォルダ（日本語と 𠮷）の %APPDATA% と %LOCALAPPDATA% に
 * 設定ファイルを置き、--mcp-steps の手順で IPC を呼ぶ）。本物の利用者の Claude の設定には触れない。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execScene, sceneTimeout } = require('./helpers/scene-slots');

const ROOT = path.join(__dirname, '..');
const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const PKG = require('../package.json');
const SERVER = path.join(ROOT, 'src', 'mcp', 'server.js');
const S = { timeout: sceneTimeout(30000) };
const run = (steps, ...flags) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, 'text', `--mcp-steps=${JSON.stringify(steps)}`, ...flags], { env: { ...process.env }, maxBuffer: 1 << 24, timeout: 30000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const parse = (text) => JSON.parse(text.replace(/^﻿/, ''));
const ipcOf = (o, ch) => o.ipc.filter(([c]) => c === ch).map(([, r]) => r);
const mcpLog = (o) => o.engineLog.filter((l) => l.startsWith('MCP'));
const STALE_TEXT = 'NaTsu の置き場所が変わったため、Claude から議事録を読めなくなっています。設定の「要約」で［登録し直す］を押してください。';
const GONE_TEXT = 'Claude デスクトップへの登録が消えています。［設定を開く］で［登録し直す］を押してください。';
const mcpNotices = (o) => o.notices.filter((n) => n && typeof n === 'object' && (n.text === STALE_TEXT || n.text === GONE_TEXT));
const entryOf = (o) => ({ command: process.execPath, args: [SERVER], env: { ELECTRON_RUN_AS_NODE: '1', NATSU_MCP: '1', NATSU_DATA_DIR: o.dataDir } });

test('MR8: none（Claude のフォルダだけある）→ 登録で mcpServers.natsu に command（process.execPath）・args（アプリの src/mcp/server.js）・env（3つ）が入り、控えは作らない。状態は none から same・設定に登録の数と版', S, async () => {
  const o = await run([['status'], ['register'], ['status']], '--claude-config=none');
  const [before, after] = ipcOf(o, 'mcp:status');
  assert.deepStrictEqual([before.desktop.state, before.desktop.files], ['none', 1], JSON.stringify(before));
  const r = ipcOf(o, 'mcp:register')[0];
  assert.deepStrictEqual([r.ok, r.state], [true, 'same'], JSON.stringify(r));
  const cfg = parse(o.claudeConfigs.roaming.text);
  assert.deepStrictEqual(cfg, { mcpServers: { natsu: entryOf(o) } });
  assert.ok(path.isAbsolute(o.dataDir) && o.dataDir.endsWith(path.join('userData-日本語𠮷', 'data')), o.dataDir);
  assert.deepStrictEqual(o.claudeConfigs.roaming.backups, []);
  assert.strictEqual(after.desktop.state, 'same');
  assert.deepStrictEqual(JSON.parse(o.settingsText).mcpRegisteredFor, { files: 1, version: PKG.version });
  assert.deepStrictEqual(mcpLog(o), ['MCP の登録: 足した（ファイル 1・控え 0）']);
  assert.deepStrictEqual(mcpNotices(o), [], '前に登録していない PC で知らせた');  // 登録の印は main だけが書く: 画面の設定の保存（ほかの欄を変える・印を消そうとする）でも残る
  const k = await run([['register'], ['save', { theme: 'dark', mcpRegisteredFor: null }]], '--claude-config=none');
  const saved = JSON.parse(k.settingsText);
  assert.deepStrictEqual([saved.theme, saved.mcpRegisteredFor], ['dark', { files: 1, version: PKG.version }]);
});

test('MR8・RF61: others → ほかのサーバー2つと好みの設定が同じ値・同じ鍵の並びで残り、natsu は最後。控えが1つ（元のバイトのまま）。plain（mcpServers の無い設定）には鍵を足す', S, async () => {
  const o = await run([['files', 'before'], ['register']], '--claude-config=others');
  const was = parse(o.snaps.before.roaming.text);
  const cfg = parse(o.claudeConfigs.roaming.text);
  assert.deepStrictEqual(Object.keys(cfg), ['globalShortcut', 'mcpServers', 'theme']);
  assert.deepStrictEqual(Object.keys(cfg.mcpServers), ['filesystem', 'memory', 'natsu']);
  assert.deepStrictEqual(cfg.mcpServers.filesystem, was.mcpServers.filesystem);
  assert.deepStrictEqual(cfg.mcpServers.memory, was.mcpServers.memory);
  assert.deepStrictEqual([cfg.globalShortcut, cfg.theme], [was.globalShortcut, was.theme]);
  assert.deepStrictEqual(cfg.mcpServers.natsu, entryOf(o));
  const bk = o.claudeConfigs.roaming.backups;
  assert.strictEqual(bk.length, 1, JSON.stringify(bk));
  assert.match(bk[0], /^claude_desktop_config\.json\.natsu-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$/);
  assert.strictEqual(o.claudeConfigs.roaming.backupTexts[bk[0]], o.snaps.before.roaming.text, '控えが元のバイトのままでない');
  assert.ok(o.claudeConfigs.roaming.others.includes('claude_desktop_config.json.bak'), '利用者の控えが消えた');
  assert.deepStrictEqual(mcpLog(o), ['MCP の登録: 足した（ファイル 1・控え 1）']);
  const p = await run([['register']], '--claude-config=plain');
  const pc = parse(p.claudeConfigs.roaming.text);
  assert.deepStrictEqual(Object.keys(pc), ['theme', 'mcpServers']);
  assert.deepStrictEqual(pc.mcpServers, { natsu: entryOf(p) });
});

test('MR8: bom（BOM 付きの UTF-8）→ 読めて登録でき、書いた後は BOM なし（控えは BOM 付きの元のまま）', S, async () => {
  const o = await run([['files', 'before'], ['status'], ['register']], '--claude-config=bom');
  assert.ok(o.snaps.before.roaming.text.startsWith('﻿'));
  assert.strictEqual(ipcOf(o, 'mcp:status')[0].desktop.state, 'none');
  assert.deepStrictEqual(ipcOf(o, 'mcp:register')[0].ok, true);
  assert.ok(!o.claudeConfigs.roaming.text.startsWith('﻿'), '書いた後に BOM が残った');
  assert.deepStrictEqual(Object.keys(parse(o.claudeConfigs.roaming.text).mcpServers), ['filesystem', 'memory', 'natsu']);
  const bk = o.claudeConfigs.roaming.backups;
  assert.strictEqual(o.claudeConfigs.roaming.backupTexts[bk[0]], o.snaps.before.roaming.text);
});

test('F2: broken・array・other-natsu・readonly は、どのファイルも1バイトも変わらず、控えも作らず、状態と断った符号が broken・broken・other・readonly。設定に登録の印を書かない', S, async () => {
  for (const [scene, code] of [['broken', 'broken'], ['array', 'broken'], ['other-natsu', 'other'], ['readonly', 'readonly']]) {
    const o = await run([['files', 'before'], ['status'], ['register'], ['unregister']], `--claude-config=${scene}`);
    assert.strictEqual(ipcOf(o, 'mcp:status')[0].desktop.state, code, scene);
    const r = ipcOf(o, 'mcp:register')[0];
    assert.deepStrictEqual([r.ok, r.code], [false, code], `${scene}: ${JSON.stringify(r)}`);
    if (scene !== 'readonly') assert.deepStrictEqual(ipcOf(o, 'mcp:unregister')[0].ok, false, scene);
    assert.strictEqual(o.claudeConfigs.roaming.text, o.snaps.before.roaming.text, `${scene}: ファイルが変わった`);
    assert.deepStrictEqual(o.claudeConfigs.roaming.backups, [], `${scene}: 控えを作った`);
    assert.ok(!('mcpRegisteredFor' in JSON.parse(o.settingsText)), scene);
    assert.ok(mcpLog(o).includes(`MCP の登録: 断った（${code}）（ファイル 1・控え 0）`), `${scene}: ${mcpLog(o).join('\n')}`);
  }
});

test('MR8: msix（%APPDATA% と Microsoft Store 版の場所）→ 2つのファイルの両方に入る。noclaude → 状態 noclaude・登録は断り、Claude のフォルダを作らない', S, async () => {
  const o = await run([['status'], ['register'], ['status']], '--claude-config=msix');
  assert.deepStrictEqual(ipcOf(o, 'mcp:status').map((s) => [s.desktop.state, s.desktop.files]), [['none', 2], ['same', 2]]);
  assert.deepStrictEqual(parse(o.claudeConfigs.roaming.text).mcpServers.natsu, entryOf(o));
  assert.deepStrictEqual(parse(o.claudeConfigs.msix.text).mcpServers.natsu, entryOf(o));
  assert.deepStrictEqual(JSON.parse(o.settingsText).mcpRegisteredFor, { files: 2, version: PKG.version });
  assert.deepStrictEqual(mcpLog(o), ['MCP の登録: 足した（ファイル 2・控え 1）']);
  const n = await run([['status'], ['register']], '--claude-config=noclaude');
  assert.deepStrictEqual([ipcOf(n, 'mcp:status')[0].desktop.state, ipcOf(n, 'mcp:status')[0].desktop.files], ['noclaude', 0]);
  assert.deepStrictEqual(ipcOf(n, 'mcp:register')[0], { ok: false, state: 'noclaude', code: 'noclaude', running: null });
  assert.deepStrictEqual([n.claudeConfigs.roaming, n.claudeConfigs.msix], [null, null], 'Claude のフォルダを作った');
  assert.ok(!('mcpRegisteredFor' in JSON.parse(n.settingsText)));
});

// 0.10.1 CD-4 で意図して変えた（持ち主の答え D83・D86。0.10.0 の決めたこと 151 を変えた）: Claude デスクトップが動いていなければ起動のときに黙って書き直す
// （stage101.mcp.main の CD-4 のテスト）。動いていれば書かずに RN4（mcpFix）が1回。この確かめは「起動のときは動いていて、その後に終了した」形（tasklist の答えの並び）にした
const FIX_TEXT = 'Claude との連携の登録を直します。Claude デスクトップを終了してから［登録し直す］を押してください（タスクトレイのアイコンからも終了してください）。';
test('D76・決めたこと 151（0.10.1 D83・D86 で意図して変えた）: --mcp-gone（前に登録したのに項目が無い）・起動のときに Claude デスクトップが動いている → 書かずに知らせ RN4 が1回（［設定を開く］で要約）・状態 gone・終了した後に登録し直すと same。前に登録していない PC では知らせない', S, async () => {
  const o = await run([['status'], ['register'], ['status']], '--claude-config=others', '--mcp-gone', '--tasklist=running,stopped');
  assert.deepStrictEqual(o.notices.filter((n) => n && typeof n === 'object' && [GONE_TEXT, STALE_TEXT, FIX_TEXT].includes(n.text)), [{ text: FIX_TEXT, action: 'settings-summary' }]);
  assert.deepStrictEqual(ipcOf(o, 'mcp:status').map((s) => s.desktop.state), ['gone', 'same']);
  assert.strictEqual(ipcOf(o, 'mcp:register')[0].ok, true);
  const quiet = await run([['status']], '--claude-config=others');
  assert.deepStrictEqual(mcpNotices(quiet), []);
  assert.strictEqual(ipcOf(quiet, 'mcp:status')[0].desktop.state, 'none');
});

test('D76: --mcp-stale（場所の違う NaTsu の登録）→ 起動の後に知らせ mcpStale が1回・状態 stale・登録し直すと same（その場所で替え、控えが1つ）', S, async () => {
  const o = await run([['status'], ['register'], ['status']], '--claude-config=others', '--mcp-stale');
  assert.deepStrictEqual(mcpNotices(o), [{ text: STALE_TEXT, action: 'settings-summary' }]);
  assert.deepStrictEqual(ipcOf(o, 'mcp:status').map((s) => s.desktop.state), ['stale', 'same']);
  const cfg = parse(o.claudeConfigs.roaming.text);
  assert.deepStrictEqual(Object.keys(cfg.mcpServers), ['natsu', 'filesystem', 'memory']);
  assert.deepStrictEqual(cfg.mcpServers.natsu, entryOf(o));
  assert.strictEqual(o.claudeConfigs.roaming.backups.length, 1);
  assert.deepStrictEqual(mcpLog(o), ['MCP の登録: 直した（ファイル 1・控え 1）']);
});

test('登録を外すと natsu だけが消え、控えが1つ増え、登録の印を消す（外した後は gone と言わない）。4回登録し直しても NaTsu の控えは新しい3つ・利用者の控えは残る', S, async () => {
  const o = await run([['register'], ['unregister'], ['files', 'off'], ['status'], ['register'], ['unregister'], ['register'], ['unregister'], ['register'], ['status']], '--claude-config=others');
  const off = parse(o.snaps.off.roaming.text);
  assert.deepStrictEqual(Object.keys(off.mcpServers), ['filesystem', 'memory']);
  assert.strictEqual(o.snaps.off.roaming.backups.length, 2);
  // 0.10.1 CD-3 で意図して変えた: 外すときも tasklist を見て、答えに running を添える（D84）
  assert.deepStrictEqual(ipcOf(o, 'mcp:unregister')[0], { ok: true, state: 'none', running: false });
  assert.deepStrictEqual(ipcOf(o, 'mcp:status').map((s) => s.desktop.state), ['none', 'same']);
  const bk = o.claudeConfigs.roaming.backups;
  assert.strictEqual(bk.length, 3, JSON.stringify(bk));
  assert.strictEqual(new Set(bk).size, 3);
  assert.ok(o.claudeConfigs.roaming.others.includes('claude_desktop_config.json.bak'), '利用者の控えが消えた');
  assert.ok(mcpLog(o).includes('MCP の登録: 外した（ファイル 1・控え 1）'), mcpLog(o).join('\n'));
  const u = await run([['register'], ['unregister']], '--claude-config=others', '--mcp-gone');
  assert.ok(!('mcpRegisteredFor' in JSON.parse(u.settingsText)), '外したのに登録の印が残った');
  // 同じ中身なら書かない（控えも作らない）
  const same = await run([['register'], ['register']], '--claude-config=others');
  assert.strictEqual(same.claudeConfigs.roaming.backups.length, 1);
  assert.deepStrictEqual(mcpLog(same), ['MCP の登録: 足した（ファイル 1・控え 1）', 'MCP の登録: 変えなかった（ファイル 1・控え 0）']);
});

test('決めたこと 26・方針 7: engine.log の MCP の行と画面への答えに、パス・設定の中身・ファイルの名前が無い', S, async () => {
  const o = await run([['status'], ['register'], ['unregister'], ['register']], '--claude-config=msix', '--mcp-stale');
  const lines = mcpLog(o);
  assert.ok(lines.length >= 3, lines.join('\n'));
  for (const l of lines) {
    assert.match(l, /^MCP の登録: (足した|直した|外した|変えなかった|断った（[a-z]+）)（ファイル \d+・控え \d+）$/, l);
  }
  const answers = JSON.stringify(o.ipc);
  for (const bad of ['claude_desktop_config', 'mcpServers', 'filesystem', 'server.js', '日本語', 'natsu-', ':\\\\', '/']) assert.ok(!answers.includes(bad), `答えに ${bad}: ${answers}`);
});

// 0.10.1 CD-3 で意図して変えた（持ち主の答え D84。0.10.0 の決めたこと 149 の「動いていても登録は止めない」を逆にした）: 動いていれば running で断り、ファイルを変えない
test('D75・決めたこと 149（0.10.1 D84 で意図して変えた）: 状態と登録の答えに、Claude デスクトップが動いているか（tasklist.exe を決まった引数で・シェルを通さない）。動いていれば登録を断る。見られなければ null', S, async () => {
  const on = await run([['files', 'before'], ['status'], ['register']], '--claude-config=none', '--tasklist=running');
  assert.strictEqual(ipcOf(on, 'mcp:status')[0].desktop.running, true);
  assert.strictEqual(ipcOf(on, 'mcp:register')[0].running, true);
  assert.deepStrictEqual([ipcOf(on, 'mcp:register')[0].ok, ipcOf(on, 'mcp:register')[0].code], [false, 'running'], '動いているのに登録した');
  assert.deepStrictEqual(on.claudeConfigs.roaming, on.snaps.before.roaming, '動いているのにファイルを変えた');
  assert.deepStrictEqual(mcpLog(on), ['MCP の登録: 断った（running）（ファイル 1・控え 0）']);
  assert.ok(on.tasklistCalls.length >= 2);
  for (const c of on.tasklistCalls) {
    assert.deepStrictEqual([c.cmd, c.args], ['tasklist.exe', ['/FI', 'IMAGENAME eq claude.exe', '/NH', '/FO', 'CSV']]);
    assert.ok(!c.opts || c.opts.shell !== true, 'シェルを通した');
    assert.strictEqual(c.opts && c.opts.windowsHide, true);
  }
  const off = await run([['status']], '--claude-config=none', '--tasklist=stopped');
  assert.strictEqual(ipcOf(off, 'mcp:status')[0].desktop.running, false);
  const unknown = await run([['status']], '--claude-config=none', '--tasklist=fail');
  assert.strictEqual(ipcOf(unknown, 'mcp:status')[0].desktop.running, null);
  // 起動の後の確かめでは tasklist を見ない（読むだけ）
  const boot = await run([], '--claude-config=others', '--mcp-stale', '--tasklist=running');
  assert.deepStrictEqual(boot.tasklistCalls, []);
});
