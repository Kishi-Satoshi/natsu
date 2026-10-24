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
  // 点検の直し（Ruling R11）で意図して変えた: 何も変えない押しは tasklist を見ないので、外すと書き換わる形（印のある古い natsu: --mcp-stale）で見る
  const a = await run([['files', 'before'], ['register'], ['unregister']], '--claude-config=others', '--mcp-stale', '--tasklist=fail');
  assert.deepStrictEqual(ipcOf(a, 'mcp:register')[0].code, 'unknown');
  assert.deepStrictEqual(ipcOf(a, 'mcp:unregister')[0].code, 'unknown', '違うボタンを2回目とみなした');
  assert.strictEqual(a.claudeConfigs.roaming.text, a.snaps.before.roaming.text);
  const b = await run([['register'], ['register'], ['register']], '--claude-config=others', '--tasklist=fail,running,fail');
  assert.deepStrictEqual(ipcOf(b, 'mcp:register').map((r) => r.code), ['unknown', 'running', 'unknown'], '動いていると分かった後の押しを2回目とみなした');
  assert.ok(!('natsu' in parse(b.claudeConfigs.roaming.text).mcpServers));
  // 点検の直し（Ruling R11）で意図して変えた: 何も変えない押し（natsu の無い［登録を外す］）は tasklist を見ない（running は null）が、押しとして1回目の印を消す
  const c = await run([['register'], ['unregister'], ['register']], '--claude-config=others', '--tasklist=fail');
  assert.deepStrictEqual(ipcOf(c, 'mcp:register').map((r) => r.code), ['unknown', 'unknown'], '間に押しがあったのに2回目とみなした');
  assert.deepStrictEqual(ipcOf(c, 'mcp:unregister')[0], { ok: true, state: 'none', running: null });
  assert.strictEqual(c.tasklistCalls.length, 2, '何も変えない押しで tasklist を見た');
});

// ---------------------------------------------------------------- 0.10.1 Task CD-4（D83・D86）: 起動のときに黙って登録し直す
const GONE = 'Claude デスクトップへの登録が消えています。［設定を開く］で［登録し直す］を押してください。';
const STALE = 'NaTsu の置き場所が変わったため、Claude から議事録を読めなくなっています。設定の「要約」で［登録し直す］を押してください。';
const RN4 = 'Claude との連携の登録を直します。Claude デスクトップを終了してから［登録し直す］を押してください（タスクトレイのアイコンからも終了してください）。';
const mcpNotices = (o) => o.notices.filter((n) => n && typeof n === 'object' && [GONE, STALE, RN4].includes(n.text));

test('0.10.1 CD-4・D83: 前に登録した人の新しい場所に無い（data-msix --mcp-gone）・動いていない → 起動のときに黙って新しい場所に書き、知らせを出さない。前の場所は変わらない', S, async () => {
  const o = await run([['files', 'boot'], ['status']], '--claude-config=data-msix', '--mcp-gone', STOP);
  assert.deepStrictEqual(parse(o.snaps.boot.data.text).mcpServers.natsu, entryOf(o), '起動のときに書き直さなかった');
  assert.deepStrictEqual(o.snaps.boot.data.backups.length, 1);
  assert.deepStrictEqual(o.snaps.boot.msix.backups, [], '前の場所を書き換えた');
  assert.deepStrictEqual(mcpNotices(o), [], '黙って書き直したのに知らせた');
  assert.deepStrictEqual(ipcOf(o, 'mcp:status')[0].desktop.state, 'same');
  assert.deepStrictEqual(placeLog(o), ['起動のとき: Claude デスクトップの設定ファイルの場所: Roaming 0・Claude-Data 1・Packages 1']);
  assert.deepStrictEqual(mcpLog(o), ['MCP の登録: 足した（ファイル 2・控え 1）']);
  assert.deepStrictEqual(JSON.parse(o.settingsText).mcpRegisteredFor, { files: 2, version: PKG.version });
  assert.strictEqual(o.tasklistCalls.length, 2, '起動の確かめで tasklist を1回・状態で1回');
  // 場所が古い（印のある古い natsu）も黙って直す
  const st = await run([], '--claude-config=others', '--mcp-stale', '--mcp-gone', STOP);
  assert.deepStrictEqual(parse(st.claudeConfigs.roaming.text).mcpServers.natsu, entryOf(st));
  assert.deepStrictEqual(mcpNotices(st), []);
  assert.deepStrictEqual(mcpLog(st), ['MCP の登録: 直した（ファイル 1・控え 1）']);
});

test('0.10.1 CD-4・D86: 動いている・分からないときは書かずに RN4 が1回（gone・stale の知らせは出ない）。起動ごとに tasklist は1回', S, async () => {
  for (const tl of ['--tasklist=running', '--tasklist=fail']) {
    const o = await run([['files', 'boot']], '--claude-config=data-msix', '--mcp-gone', tl);
    assert.ok(!('natsu' in parse(o.snaps.boot.data.text).mcpServers), `${tl}: 動いているのに書いた`);
    assert.deepStrictEqual(o.snaps.boot.data.backups, []);
    assert.deepStrictEqual(mcpNotices(o), [{ text: RN4, action: 'settings-summary' }], tl);
    assert.strictEqual(o.tasklistCalls.length, 1, tl);
    assert.deepStrictEqual(placeLog(o), [], tl);
  }
  const s2 = await run([], '--claude-config=others', '--mcp-stale', '--mcp-gone', '--tasklist=running');
  assert.deepStrictEqual(mcpNotices(s2), [{ text: RN4, action: 'settings-summary' }]);
});

test('0.10.1 CD-4: 登録したことの無い人・外した人には書かず、知らせず、tasklist も見ない', S, async () => {
  const o = await run([['files', 'boot']], '--claude-config=data-msix', STOP);
  assert.ok(!('natsu' in parse(o.snaps.boot.data.text).mcpServers), '登録していない人に書いた');
  assert.deepStrictEqual([mcpNotices(o), o.tasklistCalls], [[], []]);
});

test('0.10.1 CD-4: 書けないファイルがある（msix-broken・other-natsu）・書いてみて確かめで違った（--claude-race）→ 書き直さず、今の知らせ（gone）。RN4 ではない', S, async () => {
  const b = await run([['files', 'boot']], '--claude-config=msix-broken', '--mcp-gone', STOP);
  assert.ok(!('natsu' in parse(b.snaps.boot.data.text).mcpServers));
  assert.deepStrictEqual(b.snaps.boot.data.backups, []);
  assert.deepStrictEqual(b.tasklistCalls, [], '書けないのに tasklist を見た');
  assert.deepStrictEqual(mcpNotices(b), [{ text: GONE, action: 'settings-summary' }]);
  const t = await run([['files', 'boot']], '--claude-config=other-natsu', '--mcp-gone', STOP);
  assert.strictEqual(parse(t.snaps.boot.roaming.text).mcpServers.natsu.command, 'other.exe', '別の natsu を奪った');
  assert.deepStrictEqual(t.tasklistCalls, []);
  const r = await run([], '--claude-config=data-msix', '--mcp-gone', '--claude-race', STOP);
  assert.deepStrictEqual(mcpNotices(r), [{ text: GONE, action: 'settings-summary' }]);
  assert.deepStrictEqual(JSON.parse(r.settingsText).mcpRegisteredFor, { files: 1, version: '0.9.4' }, '確かめで違ったのに登録の印を書き換えた');
});

// ---------------------------------------------------------------- 0.10.1 点検の直し（2026-10-24。計画の Ruling R7〜R12）
const fs = require('node:fs');
const os = require('node:os');
const UNRESTORED = (n) => `Claude デスクトップの設定ファイルを元に戻せませんでした: ${n} 件`;
const texts = (snap) => Object.fromEntries(['roaming', 'data', 'msix'].map((k) => [k, snap[k] && snap[k].text]));
const bkCount = (snap) => Object.fromEntries(['roaming', 'data', 'msix'].map((k) => [k, snap[k] ? snap[k].backups.length : null]));

test('0.10.1 点検の直し R7: 登録で1つ目のファイルが書けない → どのファイルも元のバイトのまま、後のファイルには触れない（控えも作らない）', S, async () => {
  const o = await run([['files', 'before'], ['register']], '--claude-config=three', '--claude-fail-write=1', STOP);
  const r = ipcOf(o, 'mcp:register')[0];
  assert.deepStrictEqual([r.ok, r.code, r.unrestored], [false, 'busy', undefined], JSON.stringify(r));
  assert.deepStrictEqual(texts(o.claudeConfigs), texts(o.snaps.before));
  assert.deepStrictEqual(bkCount(o.claudeConfigs), { roaming: 1, data: 0, msix: 0 }, '失敗の後のファイルに触れた');
  assert.ok(!('mcpRegisteredFor' in JSON.parse(o.settingsText)));
  assert.ok(mcpLog(o).includes('MCP の登録: 断った（busy）（ファイル 3・控え 1）'), mcpLog(o).join('\n'));
});

test('0.10.1 点検の直し R7: 登録で真ん中のファイルが書けない → 先に書いたファイルを控えから元のバイトに戻し、後のファイルには触れない。外すときも同じ（印は残る）', S, async () => {
  const o = await run([['files', 'before'], ['register']], '--claude-config=three', '--claude-fail-write=2', STOP);
  assert.deepStrictEqual([ipcOf(o, 'mcp:register')[0].ok, ipcOf(o, 'mcp:register')[0].code], [false, 'busy']);
  assert.deepStrictEqual(texts(o.claudeConfigs), texts(o.snaps.before), '先に書いたファイルを戻さなかった');
  assert.deepStrictEqual(bkCount(o.claudeConfigs), { roaming: 1, data: 1, msix: 0 });
  assert.deepStrictEqual(o.engineLog.filter((l) => l.startsWith('Claude デスクトップの設定ファイルを元に')), []);
  // 外す: 登録（書き込み 3 回）の後の5回目（外すの2つ目）を失敗させる
  const u = await run([['register'], ['files', 'on'], ['unregister'], ['status']], '--claude-config=three', '--claude-fail-write=5', STOP);
  assert.deepStrictEqual([ipcOf(u, 'mcp:unregister')[0].ok, ipcOf(u, 'mcp:unregister')[0].code], [false, 'busy']);
  assert.deepStrictEqual(texts(u.claudeConfigs), texts(u.snaps.on), '外すのが途中で失敗したのに、ファイルがばらばら');
  assert.deepStrictEqual(JSON.parse(u.settingsText).mcpRegisteredFor, { files: 3, version: PKG.version }, '何も変わらなかったのに印を消した');
  assert.strictEqual(ipcOf(u, 'mcp:status')[0].desktop.state, 'same');
});

test('0.10.1 点検の直し R7・R8: 戻しも失敗 → 答えに unrestored・数だけの記録。外すのが一部でも効いたら印を消し、［登録を外す］を出せる（hasEntry）', S, async () => {
  const o = await run([['register']], '--claude-config=three', '--claude-fail-write=2', '--claude-fail-restore', STOP);
  const r = ipcOf(o, 'mcp:register')[0];
  assert.deepStrictEqual([r.ok, r.code, r.unrestored], [false, 'busy', 1], JSON.stringify(r));
  assert.ok(o.engineLog.includes(UNRESTORED(1)), o.engineLog.filter((l) => /Claude|MCP/.test(l)).join('\n'));
  assert.deepStrictEqual(parse(o.claudeConfigs.roaming.text).mcpServers.natsu, entryOf(o), '戻せなかったファイルの中身が違う');
  const u = await run([['register'], ['unregister'], ['status']], '--claude-config=three', '--claude-fail-write=5', '--claude-fail-restore', STOP);
  assert.deepStrictEqual([ipcOf(u, 'mcp:unregister')[0].code, ipcOf(u, 'mcp:unregister')[0].unrestored], ['busy', 1]);
  assert.ok(!('natsu' in parse(u.claudeConfigs.roaming.text).mcpServers), '1つ目から外れていない');
  assert.ok('natsu' in parse(u.claudeConfigs.data.text).mcpServers);
  assert.ok(!('mcpRegisteredFor' in JSON.parse(u.settingsText)), '外すのが一部効いたのに登録の印が残った（次の起動で書き戻す）');
  const st = ipcOf(u, 'mcp:status')[0].desktop;
  assert.deepStrictEqual([st.state, st.hasEntry], ['none', true], JSON.stringify(st));
  // 確かめで違った（書いた後に Claude が書いた）外すも、ファイルは変わったので印を消す
  const k = await run([['unregister']], '--claude-config=data-msix', '--data-has-natsu', '--mcp-gone', '--claude-race', STOP);
  assert.strictEqual(ipcOf(k, 'mcp:unregister')[0].code, 'busy');
  assert.ok(!('mcpRegisteredFor' in JSON.parse(k.settingsText)), '確かめで違った外すの後に印が残った');
});

test('0.10.1 点検の直し R8: 外した人（登録して外した後）・外すのが一部だけ効いた人の次の起動では、黙って書き戻さない（2回の起動で同じ場所）', S, async (t) => {
  const mk = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `natsu-連携𠮷-${name}-`)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
  for (const [scene, first] of [['others', [['register'], ['unregister']]], ['three', [['register'], ['unregister']]]]) {
    const root = mk(scene);
    const ud = path.join(mk(`${scene}-ud`), 'userData-日本語𠮷');
    const extra = scene === 'three' ? ['--claude-fail-write=5', '--claude-fail-restore'] : [];
    const a = await run(first, `--claude-config=${scene}`, `--claude-root=${root}`, `--keep-user-data=${ud}`, STOP, ...extra);
    assert.ok(!('mcpRegisteredFor' in JSON.parse(a.settingsText)), `${scene}: 外した後に印が残った`);
    const b = await run([], `--claude-config=${scene}`, `--claude-root=${root}`, `--keep-user-data=${ud}`, STOP);
    assert.deepStrictEqual(texts(b.claudeConfigs), texts(a.claudeConfigs), `${scene}: 起動のときに書き戻した`);
    assert.deepStrictEqual(b.tasklistCalls, [], `${scene}: 起動のときに書き直しを試した`);
    assert.deepStrictEqual(mcpNotices(b), [], scene);
  }
});

test('0.10.1 点検の直し R9: 書く直前に Claude が書いた（計画の後に中身が変わった）→ busy で断り、Claude の書いた中身を上書きしない', S, async () => {
  const o = await run([['register']], '--claude-config=data', '--claude-race-before', STOP);
  assert.deepStrictEqual([ipcOf(o, 'mcp:register')[0].ok, ipcOf(o, 'mcp:register')[0].code], [false, 'busy']);
  const d = parse(o.claudeConfigs.data.text);
  assert.strictEqual(d.preferences.raceBeforeNaTsu, true, 'Claude が書いた中身を消した');
  assert.ok(!('natsu' in d.mcpServers));
  assert.strictEqual(o.claudeConfigs.msix.text, null, '後のファイル（前の場所）に書いた');
  // 3つの場所: 2つ目で見つかれば、先に書いた1つ目を戻す
  const t3 = await run([['files', 'before'], ['register']], '--claude-config=three', '--claude-race-before', STOP);
  assert.strictEqual(ipcOf(t3, 'mcp:register')[0].code, 'busy');
  assert.ok(!('natsu' in parse(t3.claudeConfigs.msix.text).mcpServers));
});

test('0.10.1 点検の直し R10: 書かなかったファイル（もう same）を、書く間にほかのプログラムが書き換えた → busy', S, async () => {
  const o = await run([['register']], '--claude-config=data-msix', '--claude-race-other', STOP);
  assert.deepStrictEqual([ipcOf(o, 'mcp:register')[0].ok, ipcOf(o, 'mcp:register')[0].code], [false, 'busy'], JSON.stringify(ipcOf(o, 'mcp:register')[0]));
});

test('0.10.1 点検の直し R10: 起動のときの書き直しが確かめで断られ、古い（stale）場所があれば mcpStale の知らせ（gone ではない）', S, async () => {
  const o = await run([], '--claude-config=others', '--mcp-stale', '--mcp-gone', '--claude-race', STOP);
  assert.deepStrictEqual(mcpNotices(o), [{ text: STALE, action: 'settings-summary' }]);
});

test('0.10.1 点検の直し R10: 見つけた場所が無い（noclaude）の押しでも、1回目の印を消す', S, async () => {
  const o = await run([['register'], ['claude-hide', 'roaming'], ['register'], ['claude-show', 'roaming'], ['register']], '--claude-config=others', '--tasklist=fail');
  assert.deepStrictEqual(ipcOf(o, 'mcp:register').map((r) => r.code), ['unknown', 'noclaude', 'unknown'], 'noclaude の後の押しを2回目とみなした');
  assert.ok(!('natsu' in parse(o.claudeConfigs.roaming.text).mcpServers));
});

test('0.10.1 点検の直し R11: 壊れた・別の natsu のファイルがあれば、tasklist を見ずにその理由で断る（Claude の終了を頼まない）。何も変えない押しも tasklist を見ない', S, async () => {
  for (const [scene, code] of [['data-broken', 'broken'], ['other-natsu', 'other']]) {
    const o = await run([['register']], `--claude-config=${scene}`, '--tasklist=running');
    assert.strictEqual(ipcOf(o, 'mcp:register')[0].code, code, scene);
    assert.deepStrictEqual(o.tasklistCalls, [], `${scene}: tasklist を見た`);
  }
  const n = await run([['register'], ['register']], '--claude-config=others', '--tasklist=stopped,running');
  assert.deepStrictEqual(ipcOf(n, 'mcp:register').map((r) => r.ok), [true, true]);
  assert.strictEqual(n.tasklistCalls.length, 1);
});

test('0.10.1 点検の直し R7: 戻すとき、書いた後にほかのプログラムが書き換えたファイルは戻さない（その中身を消さない）・戻せなかった数に数える', S, async () => {
  const o = await run([['register']], '--claude-config=three', '--claude-fail-write=2', '--claude-race', STOP);
  const r = ipcOf(o, 'mcp:register')[0];
  assert.deepStrictEqual([r.code, r.unrestored], ['busy', 1], JSON.stringify(r));
  assert.strictEqual(parse(o.claudeConfigs.roaming.text).preferences.raceWrittenByClaude, true, 'ほかのプログラムが書いた中身を戻しで消した');
});
