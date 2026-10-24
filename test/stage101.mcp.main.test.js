/*
 * stage101.mcp.main.test.js — 0.10.1 の main の MCP の登録の場面（計画 docs/plans/2026-10-23-101.md の Task CD-2〜CD-4）
 * 新しい Store 版の設定の場所（%LOCALAPPDATA%\Claude-Data\claude_<符号>）にも書く・見つけた全部にそろったときだけ same・書いた後に中身を確かめる・
 * 場所の種類の数を記録する（CD-2）。場面は helpers/mainrun.js を別のプロセスで回す（一時フォルダの %APPDATA% と %LOCALAPPDATA% に置く。
 * 本物の利用者の Claude の設定には触れない）。
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
const placeLog = (o) => o.engineLog.filter((l) => /Claude デスクトップの設定ファイルの場所/.test(l));
const entryOf = (o) => ({ command: process.execPath, args: [SERVER], env: { ELECTRON_RUN_AS_NODE: '1', NATSU_MCP: '1', NATSU_DATA_DIR: o.dataDir } });
const STOP = '--tasklist=stopped';
const keysDeep = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v).map((k) => [k, keysDeep(v[k])]) : null);
const withoutNatsu = (cfg) => { const c = JSON.parse(JSON.stringify(cfg)); delete c.mcpServers.natsu; return c; };

test('0.10.1 CD-2: msix-only（前の Store 版の場所だけ）→ 状態 none・登録で前の場所に入り same・場所の1行は Packages 1', S, async () => {
  const o = await run([['status'], ['register'], ['status']], '--claude-config=msix-only', STOP);
  assert.deepStrictEqual(ipcOf(o, 'mcp:status').map((s) => [s.desktop.state, s.desktop.files]), [['none', 1], ['same', 1]]);
  assert.deepStrictEqual(parse(o.claudeConfigs.msix.text).mcpServers.natsu, entryOf(o));
  assert.deepStrictEqual([o.claudeConfigs.roaming, o.claudeConfigs.data], [null, null], 'ほかの場所のフォルダを作った');
  assert.deepStrictEqual(placeLog(o), ['Claude デスクトップの設定ファイルの場所: Roaming 0・Claude-Data 0・Packages 1']);
  assert.deepStrictEqual(mcpLog(o), ['MCP の登録: 足した（ファイル 1・控え 1）']);
});

test('0.10.1 CD-2: data（新しい場所と、印だけの前の場所）→ 新しい場所の最後に natsu・ほかの鍵と並びはそのまま・控え1つ・ほかの道具の控えは残る。外すと元のバイトにちょうど戻る', S, async () => {
  const o = await run([['files', 'before'], ['status'], ['register'], ['files', 'on'], ['unregister']], '--claude-config=data', STOP);
  assert.deepStrictEqual(ipcOf(o, 'mcp:status').map((s) => [s.desktop.state, s.desktop.files]), [['none', 2]]);
  assert.strictEqual(ipcOf(o, 'mcp:register')[0].ok, true);
  const was = parse(o.snaps.before.data.text);
  const on = parse(o.snaps.on.data.text);
  assert.deepStrictEqual(Object.keys(on.mcpServers), ['sample-tool', 'natsu']);
  assert.deepStrictEqual(on.mcpServers.natsu, entryOf(o));
  assert.deepStrictEqual(withoutNatsu(on), was, 'natsu のほかの鍵と値が変わった');
  assert.deepStrictEqual(keysDeep(withoutNatsu(on)), keysDeep(was), '鍵の並びが変わった');
  assert.strictEqual(on.preferences.userDataOutsidePackageAnswer, true);
  const bk = o.snaps.on.data.backups;
  assert.strictEqual(bk.length, 1, JSON.stringify(bk));
  assert.strictEqual(o.snaps.on.data.backupTexts[bk[0]], o.snaps.before.data.text, '控えが元のバイトのままでない');
  // ほかの道具の控えは消さない・名前を変えない
  assert.ok(o.claudeConfigs.data.others.includes('claude_desktop_config.json.rea.backup'), JSON.stringify(o.claudeConfigs.data.others));
  // 印だけの前の場所には、0.10.0 のまま natsu だけのファイルができる（決めたこと 12）
  assert.deepStrictEqual(parse(o.snaps.on.msix.text), { mcpServers: { natsu: entryOf(o) } });
  assert.ok(o.claudeConfigs.msix.others.includes('.user-data-left.claude_pzs8sxrjxfjjc'));
  // 外すと、新しい場所のファイルは置いた見本とちょうど同じバイトに戻る（BOM なし・終わりの改行なし）
  assert.strictEqual(o.claudeConfigs.data.text, o.snaps.before.data.text, '外した後のバイトが元と違う');
  assert.ok(!o.claudeConfigs.data.text.endsWith('\n') && !o.claudeConfigs.data.text.startsWith('﻿'));
  assert.deepStrictEqual(placeLog(o), ['Claude デスクトップの設定ファイルの場所: Roaming 0・Claude-Data 1・Packages 1', 'Claude デスクトップの設定ファイルの場所: Roaming 0・Claude-Data 1・Packages 1']);
  // 4回登録し直しても NaTsu の控えは新しい3つ・ほかの道具の控えは残る
  const k = await run([['register'], ['unregister'], ['register'], ['unregister'], ['register'], ['unregister'], ['register']], '--claude-config=data', STOP);
  assert.strictEqual(k.claudeConfigs.data.backups.length, 3, JSON.stringify(k.claudeConfigs.data.backups));
  assert.ok(k.claudeConfigs.data.others.includes('claude_desktop_config.json.rea.backup'));
});

test('0.10.1 CD-2: data-msix（持ち主の PC の 0.10.0 の後の形）→ 状態 none（files 2）。登録で新しい場所に入り、前の場所は1バイトも変わらず控えも増えない。手で写した形（--data-has-natsu）は same', S, async () => {
  const o = await run([['files', 'before'], ['status'], ['register'], ['status']], '--claude-config=data-msix', STOP);
  assert.deepStrictEqual(ipcOf(o, 'mcp:status').map((s) => [s.desktop.state, s.desktop.files]), [['none', 2], ['same', 2]]);
  assert.deepStrictEqual(parse(o.claudeConfigs.data.text).mcpServers.natsu, entryOf(o));
  assert.strictEqual(o.claudeConfigs.msix.text, o.snaps.before.msix.text, '前の場所が変わった');
  assert.deepStrictEqual([o.claudeConfigs.data.backups.length, o.claudeConfigs.msix.backups.length], [1, 0]);
  assert.deepStrictEqual(mcpLog(o), ['MCP の登録: 足した（ファイル 2・控え 1）']);
  assert.deepStrictEqual(JSON.parse(o.settingsText).mcpRegisteredFor, { files: 2, version: PKG.version });
  const h = await run([['status']], '--claude-config=data-msix', '--data-has-natsu', STOP);
  assert.deepStrictEqual(ipcOf(h, 'mcp:status')[0].desktop.state, 'same');
});

test('0.10.1 CD-2: data-two（Claude-Data に2つ）→ 両方に入り、外すと両方から消える。roaming-data → 両方に入り、場所の1行は Roaming 1・Claude-Data 1', S, async () => {
  const o = await run([['register'], ['files', 'on'], ['unregister']], '--claude-config=data-two', STOP);
  assert.deepStrictEqual(parse(o.snaps.on.data.text).mcpServers.natsu, entryOf(o));
  assert.deepStrictEqual(parse(o.snaps.on.data2.text).mcpServers.natsu, entryOf(o));
  assert.ok(!('natsu' in parse(o.claudeConfigs.data.text).mcpServers) && !('natsu' in parse(o.claudeConfigs.data2.text).mcpServers));
  assert.deepStrictEqual(placeLog(o)[0], 'Claude デスクトップの設定ファイルの場所: Roaming 0・Claude-Data 2・Packages 0');
  const r = await run([['register']], '--claude-config=roaming-data', STOP);
  assert.deepStrictEqual(parse(r.claudeConfigs.roaming.text).mcpServers.natsu, entryOf(r));
  assert.deepStrictEqual(parse(r.claudeConfigs.data.text).mcpServers.natsu, entryOf(r));
  assert.deepStrictEqual(placeLog(r), ['Claude デスクトップの設定ファイルの場所: Roaming 1・Claude-Data 1・Packages 0']);
});

test('0.10.1 CD-2: data-broken・msix-broken（どちらかの場所が壊れた JSON）→ どのファイルも1バイトも変わらず、控えも作らず、状態と断った符号が broken。登録の印を書かない', S, async () => {
  for (const scene of ['data-broken', 'msix-broken']) {
    const o = await run([['files', 'before'], ['status'], ['register'], ['unregister']], `--claude-config=${scene}`, STOP);
    assert.strictEqual(ipcOf(o, 'mcp:status')[0].desktop.state, 'broken', scene);
    assert.deepStrictEqual([ipcOf(o, 'mcp:register')[0].ok, ipcOf(o, 'mcp:register')[0].code], [false, 'broken'], scene);
    assert.strictEqual(ipcOf(o, 'mcp:unregister')[0].ok, false, scene);
    for (const k of ['data', 'msix']) {
      assert.strictEqual(o.claudeConfigs[k].text, o.snaps.before[k].text, `${scene}: ${k} が変わった`);
      assert.deepStrictEqual(o.claudeConfigs[k].backups, [], `${scene}: ${k} に控えを作った`);
    }
    assert.ok(!('mcpRegisteredFor' in JSON.parse(o.settingsText)), scene);
    assert.ok(mcpLog(o).includes('MCP の登録: 断った（broken）（ファイル 2・控え 0）'), `${scene}: ${mcpLog(o).join('\n')}`);
  }
});

test('0.10.1 CD-2: --claude-race（書いた直後に Claude が書き戻した）→ 登録も外すも busy で断り、登録の印を書かない。控えは書く前の元のバイト', S, async () => {
  const o = await run([['files', 'before'], ['register']], '--claude-config=data', '--claude-race', STOP);
  const r = ipcOf(o, 'mcp:register')[0];
  assert.deepStrictEqual([r.ok, r.code], [false, 'busy'], JSON.stringify(r));
  assert.ok(!('mcpRegisteredFor' in JSON.parse(o.settingsText)), '確かめで違ったのに登録の印を書いた');
  const bk = o.claudeConfigs.data.backups;
  assert.strictEqual(bk.length, 1);
  assert.strictEqual(o.claudeConfigs.data.backupTexts[bk[0]], o.snaps.before.data.text);
  assert.ok(mcpLog(o).includes('MCP の登録: 断った（busy）（ファイル 2・控え 1）'), mcpLog(o).join('\n'));
  const u = await run([['unregister']], '--claude-config=data-msix', '--data-has-natsu', '--claude-race', STOP);
  assert.deepStrictEqual([ipcOf(u, 'mcp:unregister')[0].ok, ipcOf(u, 'mcp:unregister')[0].code], [false, 'busy']);
});

test('0.10.1 CD-2・決めたこと 13: 場所の1行はちょうど決まった形で、記録と答えにパス・符号・フォルダの名前が無い。状態を聞くだけでは場所の1行を書かない', S, async () => {
  const o = await run([['status'], ['register'], ['unregister']], '--claude-config=data-two', STOP);
  for (const l of placeLog(o)) assert.match(l, /^(起動のとき: )?Claude デスクトップの設定ファイルの場所: Roaming \d+・Claude-Data \d+・Packages \d+$/, l);
  const all = JSON.stringify(o.engineLog) + JSON.stringify(o.ipc);
  for (const bad of ['pzs8sxrjxfjjc', 'zz9test', 'Claude-Data\\\\', 'Claude-Data/', 'claude_desktop_config', '日本語']) assert.ok(!all.includes(bad), `記録か答えに ${bad}`);
  const q = await run([['status'], ['status']], '--claude-config=data-two', STOP);
  assert.deepStrictEqual(placeLog(q), []);
});

// ---------------------------------------------------------------- 0.10.1 Task CD-3（D84・D85・Ruling R1）: Claude デスクトップが動いている間は書かない
const tlArgs = ['/FI', 'IMAGENAME eq claude.exe', '/NH', '/FO', 'CSV'];

test('0.10.1 CD-3・D84: 動いている（--tasklist=running）→ 登録も外すも running で断り、ファイルは1バイトも変わらず、控えも場所の1行も無い。外すときも tasklist を決まった引数で1回見る', S, async () => {
  const o = await run([['files', 'before'], ['register'], ['unregister']], '--claude-config=others', '--mcp-stale', '--tasklist=running');
  const r = ipcOf(o, 'mcp:register')[0];
  const u = ipcOf(o, 'mcp:unregister')[0];
  assert.deepStrictEqual([r.ok, r.code, r.running], [false, 'running', true], JSON.stringify(r));
  assert.deepStrictEqual([u.ok, u.code, u.running], [false, 'running', true], JSON.stringify(u));
  assert.strictEqual(o.claudeConfigs.roaming.text, o.snaps.before.roaming.text, '動いているのに書いた');
  assert.deepStrictEqual(o.claudeConfigs.roaming.backups, []);
  assert.deepStrictEqual(placeLog(o), []);
  assert.deepStrictEqual(mcpLog(o), ['MCP の登録: 断った（running）（ファイル 1・控え 0）', 'MCP の登録: 断った（running）（ファイル 1・控え 0）']);
  assert.strictEqual(o.tasklistCalls.length, 2);
  for (const c of o.tasklistCalls) assert.deepStrictEqual([c.cmd, c.args], ['tasklist.exe', tlArgs]);
  // 動いていない → 今どおり書ける。見つけた場所が無い → tasklist を見ずに noclaude
  const s = await run([['register']], '--claude-config=others', STOP);
  assert.strictEqual(ipcOf(s, 'mcp:register')[0].ok, true);
  const n = await run([['register'], ['unregister']], '--claude-config=noclaude', '--tasklist=running');
  assert.deepStrictEqual(ipcOf(n, 'mcp:register')[0].code, 'noclaude');
  assert.deepStrictEqual(ipcOf(n, 'mcp:unregister')[0].code, 'noclaude');
  assert.deepStrictEqual(n.tasklistCalls, []);
});

test('0.10.1 CD-3・D85: 分からない（--tasklist=fail）→ 1回目は unknown で断り、続けて2回目（間に状態を聞いても）で書く（unverified）。記録に確かめの1行', S, async () => {
  const o = await run([['files', 'before'], ['register'], ['files', 'first'], ['status'], ['register'], ['status']], '--claude-config=others', '--tasklist=fail');
  const [r1, r2] = ipcOf(o, 'mcp:register');
  assert.deepStrictEqual([r1.ok, r1.code, r1.running], [false, 'unknown', null], JSON.stringify(r1));
  assert.strictEqual(o.snaps.first.roaming.text, o.snaps.before.roaming.text, '1回目で書いた');
  assert.deepStrictEqual([r2.ok, r2.state, r2.running, r2.unverified], [true, 'same', null, true], JSON.stringify(r2));
  assert.deepStrictEqual(parse(o.claudeConfigs.roaming.text).mcpServers.natsu, entryOf(o));
  assert.strictEqual(o.claudeConfigs.roaming.backups.length, 1);
  assert.strictEqual(ipcOf(o, 'mcp:status')[1].desktop.state, 'same');
  const lines = o.engineLog.filter((l) => /^MCP|Claude デスクトップの/.test(l));
  assert.deepStrictEqual(lines, ['MCP の登録: 断った（unknown）（ファイル 1・控え 0）', 'Claude デスクトップの確かめ: 動いているか分からないまま、2回目の押しで書きます',
    'Claude デスクトップの設定ファイルの場所: Roaming 1・Claude-Data 0・Packages 0', 'MCP の登録: 足した（ファイル 1・控え 1）']);
  // 外すも同じ（2回目で外し、unverified）
  const u = await run([['register'], ['unregister'], ['unregister']], '--claude-config=others', '--tasklist=stopped,fail,fail');
  const [u1, u2] = ipcOf(u, 'mcp:unregister');
  assert.deepStrictEqual([u1.code, u2.ok, u2.unverified], ['unknown', true, true]);
  assert.ok(!('natsu' in parse(u.claudeConfigs.roaming.text).mcpServers));
});

test('0.10.1 CD-3・R1: 続けてでないときは書かない（違うボタン・2回目に動いていると分かった・間に別の押しがあった）', S, async () => {
  const a = await run([['files', 'before'], ['register'], ['unregister']], '--claude-config=others', '--tasklist=fail');
  assert.deepStrictEqual(ipcOf(a, 'mcp:register')[0].code, 'unknown');
  assert.deepStrictEqual(ipcOf(a, 'mcp:unregister')[0].code, 'unknown', '違うボタンを2回目とみなした');
  assert.strictEqual(a.claudeConfigs.roaming.text, a.snaps.before.roaming.text);
  const b = await run([['register'], ['register'], ['register']], '--claude-config=others', '--tasklist=fail,running,fail');
  assert.deepStrictEqual(ipcOf(b, 'mcp:register').map((r) => r.code), ['unknown', 'running', 'unknown'], '動いていると分かった後の押しを2回目とみなした');
  assert.ok(!('natsu' in parse(b.claudeConfigs.roaming.text).mcpServers));
  const c = await run([['register'], ['unregister'], ['register']], '--claude-config=others', '--tasklist=fail,stopped,fail');
  assert.deepStrictEqual(ipcOf(c, 'mcp:register').map((r) => r.code), ['unknown', 'unknown'], '間に押しがあったのに2回目とみなした');
  assert.deepStrictEqual(ipcOf(c, 'mcp:unregister')[0], { ok: true, state: 'none', running: false });
});
