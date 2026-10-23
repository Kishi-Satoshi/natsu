/* mcp-config.test.js — 0.10.0 Task C-1（MR8・F2・RF61。計画 docs/plans/2026-10-20-100.md）: Claude デスクトップの設定に NaTsu の1項目を合わせる部品（純粋） */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const C = require('../src/mcp-config');

const T = { timeout: 5000 };
const ENTRY = C.serverEntry({ exe: 'C:\\Users\\u\\AppData\\Local\\Programs\\NaTsu\\NaTsu.exe', script: 'C:\\Users\\u\\AppData\\Local\\Programs\\NaTsu\\resources\\app\\src\\mcp\\server.js', dataDir: 'C:\\Users\\u\\AppData\\Roaming\\natsu\\data' });
const OTHERS = () => ({
  globalShortcut: 'Ctrl+Space',
  mcpServers: {
    filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\docs'] },
    memory: { command: 'node', args: ['mem.js'], env: { K: 'v' } },
  },
  theme: 'dark',
});

test('MR8: serverEntry は command・args・env（ELECTRON_RUN_AS_NODE・NATSU_MCP・NATSU_DATA_DIR）', T, () => {
  assert.deepStrictEqual(ENTRY, {
    command: 'C:\\Users\\u\\AppData\\Local\\Programs\\NaTsu\\NaTsu.exe',
    args: ['C:\\Users\\u\\AppData\\Local\\Programs\\NaTsu\\resources\\app\\src\\mcp\\server.js'],
    env: { ELECTRON_RUN_AS_NODE: '1', NATSU_MCP: '1', NATSU_DATA_DIR: 'C:\\Users\\u\\AppData\\Roaming\\natsu\\data' },
  });
  assert.strictEqual(C.ENTRY_NAME, 'natsu');
  assert.strictEqual(C.MARK, 'NATSU_MCP');
});

test('F2・RF61: mergeEntry は、ほかの鍵（好みの設定）・mcpServers のほかの項目・鍵の並びをそのままにし、natsu だけを足す。受けた物を書き換えない', T, () => {
  const cfg = OTHERS();
  const before = JSON.stringify(cfg);
  const r = C.mergeEntry(cfg, ENTRY);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(JSON.stringify(cfg), before, '受けた物を書き換えた');
  assert.deepStrictEqual(Object.keys(r.config), ['globalShortcut', 'mcpServers', 'theme']);
  assert.deepStrictEqual(Object.keys(r.config.mcpServers), ['filesystem', 'memory', 'natsu']);
  assert.deepStrictEqual(r.config.mcpServers.filesystem, cfg.mcpServers.filesystem);
  assert.deepStrictEqual(r.config.mcpServers.memory, cfg.mcpServers.memory);
  assert.deepStrictEqual(r.config.mcpServers.natsu, ENTRY);
  assert.strictEqual(r.config.theme, 'dark');
  // mcpServers が無い設定には鍵を足す
  const bare = C.mergeEntry({ theme: 'light' }, ENTRY);
  assert.deepStrictEqual(bare.config, { theme: 'light', mcpServers: { natsu: ENTRY } });
});

test('F2: 同じ中身なら changed が偽。印のある古い natsu は替える（stale）・並びはそのまま。印の無い natsu は other で config を変えない', T, () => {
  const same = C.mergeEntry(C.mergeEntry(OTHERS(), ENTRY).config, ENTRY);
  assert.deepStrictEqual([same.ok, same.changed], [true, false]);
  const old = OTHERS();
  old.mcpServers = { natsu: { ...ENTRY, command: 'D:\\old\\NaTsu.exe' }, ...old.mcpServers };
  const r = C.mergeEntry(old, ENTRY);
  assert.deepStrictEqual([r.ok, r.changed], [true, true]);
  assert.deepStrictEqual(Object.keys(r.config.mcpServers), ['natsu', 'filesystem', 'memory']);
  assert.strictEqual(r.config.mcpServers.natsu.command, ENTRY.command);
  const taken = OTHERS();
  taken.mcpServers.natsu = { command: 'other.exe', args: [] };
  const t = C.mergeEntry(taken, ENTRY);
  assert.deepStrictEqual(t, { ok: false, code: 'other' });
  assert.strictEqual(taken.mcpServers.natsu.command, 'other.exe');
});

test('F2: 根が配列・文字・null、mcpServers が配列や文字 → shape', T, () => {
  for (const bad of [[], 'x', null, 3, { mcpServers: [] }, { mcpServers: 'x' }, { mcpServers: null }]) {
    assert.deepStrictEqual(C.mergeEntry(bad, ENTRY), { ok: false, code: 'shape' }, JSON.stringify(bad));
    assert.strictEqual(C.entryState(bad, ENTRY), 'shape', JSON.stringify(bad));
    assert.deepStrictEqual(C.removeEntry(bad), { ok: false, code: 'shape' }, JSON.stringify(bad));
  }
});

test('removeEntry は印のある natsu だけを消し、mcpServers の鍵は残す・印の無い natsu は消さない・受けた物を書き換えない', T, () => {
  const cfg = C.mergeEntry(OTHERS(), ENTRY).config;
  const before = JSON.stringify(cfg);
  const r = C.removeEntry(cfg);
  assert.deepStrictEqual([r.ok, r.changed], [true, true]);
  assert.strictEqual(JSON.stringify(cfg), before);
  assert.deepStrictEqual(Object.keys(r.config.mcpServers), ['filesystem', 'memory']);
  const only = C.removeEntry({ mcpServers: { natsu: ENTRY } });
  assert.deepStrictEqual(only.config, { mcpServers: {} });
  assert.deepStrictEqual(C.removeEntry({ theme: 'x' }), { ok: true, config: { theme: 'x' }, changed: false });
  const taken = { mcpServers: { natsu: { command: 'other.exe' } } };
  assert.deepStrictEqual(C.removeEntry(taken), { ok: false, code: 'other' });
});

test('entryState の表（none・same・stale（command・args・NATSU_DATA_DIR のどれが違っても）・other・shape）', T, () => {
  assert.strictEqual(C.entryState({}, ENTRY), 'none');
  assert.strictEqual(C.entryState({ mcpServers: {} }, ENTRY), 'none');
  assert.strictEqual(C.entryState({ mcpServers: { natsu: ENTRY } }, ENTRY), 'same');
  for (const change of [{ command: 'x.exe' }, { args: ['y.js'] }, { env: { ...ENTRY.env, NATSU_DATA_DIR: 'D:\\data' } }]) {
    assert.strictEqual(C.entryState({ mcpServers: { natsu: { ...ENTRY, ...change } } }, ENTRY), 'stale', JSON.stringify(change));
  }
  assert.strictEqual(C.entryState({ mcpServers: { natsu: { command: 'x' } } }, ENTRY), 'other');
  assert.strictEqual(C.entryState({ mcpServers: { natsu: { ...ENTRY, env: { NATSU_MCP: '0' } } } }, ENTRY), 'other');
  assert.strictEqual(C.entryState({ mcpServers: { natsu: 'x' } }, ENTRY), 'other');
});

test('configFiles: Claude のフォルダがあれば1つ目・Packages の下の Claude_ と Anthropic.Claude_ で LocalCache\\Roaming\\Claude があればそれも・どれも無ければ空', T, () => {
  const appData = path.join('/u', 'Roaming');
  const localAppData = path.join('/u', 'Local');
  const pk = path.join(localAppData, 'Packages');
  const have = new Set([path.join(appData, 'Claude'), path.join(pk, 'Claude_abc123', 'LocalCache', 'Roaming', 'Claude'), path.join(pk, 'Anthropic.Claude_x9', 'LocalCache', 'Roaming', 'Claude')]);
  const fsx = { exists: (p) => have.has(p), readdir: (d) => (d === pk ? ['Microsoft.Foo_1', 'Claude_abc123', 'Anthropic.Claude_x9', 'Claude_nofolder', 'NotClaude_1'] : []) };
  assert.deepStrictEqual(C.configFiles({ appData, localAppData, ...fsx }), [
    path.join(appData, 'Claude', 'claude_desktop_config.json'),
    path.join(pk, 'Claude_abc123', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'),
    path.join(pk, 'Anthropic.Claude_x9', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'),
  ]);
  assert.deepStrictEqual(C.configFiles({ appData, localAppData, exists: () => false, readdir: () => { throw new Error('ENOENT'); } }), []);
  assert.deepStrictEqual(C.configFiles({ appData: '', localAppData: '', exists: () => true, readdir: () => ['Claude_1'] }), []);
});

test('backupName の形（時刻の : と . を - に）と、NaTsu の控えは新しい3つ', T, () => {
  assert.strictEqual(C.backupName('C:\\x\\claude_desktop_config.json', new Date('2026-10-23T01:02:03.456Z')), 'C:\\x\\claude_desktop_config.json.natsu-2026-10-23T01-02-03-456Z.bak');
  assert.strictEqual(C.BACKUP_KEEP, 3);
  assert.ok(C.isNatsuBackup('claude_desktop_config.json', 'claude_desktop_config.json.natsu-2026-10-23T01-02-03-456Z.bak'));
  assert.ok(!C.isNatsuBackup('claude_desktop_config.json', 'claude_desktop_config.json.bak'));
  assert.ok(!C.isNatsuBackup('claude_desktop_config.json', 'other.json.natsu-2026-10-23T01-02-03-456Z.bak'));
});

test('D75・決めたこと 149: claudeRunningOf の表（tasklist の答え → 動いている・動いていない・分からない）', T, () => {
  assert.strictEqual(C.claudeRunningOf('"claude.exe","1234","Console","1","123,456 K"\r\n'), true);
  assert.strictEqual(C.claudeRunningOf('"Claude.exe","1234","Console","1","1 K"\r\n"claude.exe","99","Console","1","1 K"'), true);
  assert.strictEqual(C.claudeRunningOf('INFO: No tasks are running which match the specified criteria.\r\n'), false);
  assert.strictEqual(C.claudeRunningOf('情報: 指定された条件に一致するタスクは実行されていません。\r\n'), false);
  assert.strictEqual(C.claudeRunningOf('"claude-helper.exe","1","Console","1","1 K"'), false);
  for (const v of ['', '   ', null, undefined, 3]) assert.strictEqual(C.claudeRunningOf(v), null, String(v));
});
