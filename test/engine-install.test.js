/*
 * engine-install.test.js — エンジンとモデルの置き場所と取り込みの係 src/engine-install.js
 *
 * その1（Task 11）: 置き場所（%LOCALAPPDATA%\natsu\engine。Roaming には置かない）、並び、
 * installed.json の読み書き、何が済んでいるか（planInstall）、使える組（managedCandidates。
 * ピンを上げた後も、新しい組がそろうまで前の組を返す）、空き、画面へ渡す写し（statusOf）を、
 * 通信もフォルダ作りもせずに決める（第0b回 R7、RF13）。
 * 小さな偽のピンの組は test/helpers/engine-small.js。一時フォルダの名前には日本語と 𠮷。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const I = require('../src/engine-install');
const { MANIFEST } = require('../src/engine-manifest');
const { smallSet } = require('./helpers/engine-small');
const { listZip, readEntry } = require('../src/zipread');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-置場𠮷-'));
// 小さな組を、取り込みを通さずに手で置き、記録も書く（Task 12a〜12c でも使う）
async function putByHand(root, set, ids = set.manifest.items.map((i) => i.id)) {
  const inst = I.readInstalled(path.join(root, 'installed.json'));
  for (const it of set.manifest.items.filter((i) => ids.includes(i.id))) {
    if (it.kind === 'zip') {
      const z = set.bodies[it.id]; const files = [];
      for (const f of it.files) {
        const out = path.join(root, it.dir, f.name.slice(it.strip.length));
        fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, await readEntry(z, listZip(z).find((e) => e.name === f.name)));
        const st = fs.statSync(out); files.push({ name: f.name.slice(it.strip.length), size: st.size, mtimeMs: st.mtimeMs, sha256: f.sha256 });
      }
      inst.items[it.sha256] = { id: it.id, role: 'engine', place: it.dir, size: it.size, mtimeMs: 0, files };
    } else {
      const out = path.join(root, it.dest); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, set.bodies[it.id]);
      const st = fs.statSync(out); inst.items[it.sha256] = { id: it.id, role: it.role, place: it.dest, size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  I.writeInstalled(path.join(root, 'installed.json'), inst);
  return inst;
}
test('置き場所: %LOCALAPPDATA%\\natsu\\engine（Roaming には置かない）。Windows の x64 だけ', () => {
  const L = 'C:\\Users\\試験𠮷\\AppData\\Local';
  assert.deepStrictEqual(I.engineRoot({ LOCALAPPDATA: L, APPDATA: 'C:\\Users\\試験𠮷\\AppData\\Roaming' }, 'win32', 'x64'),
    { supported: true, root: `${L}\\natsu\\engine`, reason: '' });
  assert.strictEqual(I.engineRoot({ USERPROFILE: 'D:\\試験' }, 'win32', 'x64').root, 'D:\\試験\\AppData\\Local\\natsu\\engine');
  assert.strictEqual(I.engineRoot({ LOCALAPPDATA: L }, 'win32', 'arm64').supported, false);
  assert.strictEqual(I.engineRoot({}, 'win32', 'x64').supported, false);
  assert.strictEqual(I.engineRoot({ LOCALAPPDATA: L }, 'linux', 'x64').supported, false);
});
test('並び: エンジンは版ごとのフォルダ、モデルは models の下。whisper と llama を同じフォルダにしない', () => {
  const L = I.layout('C:\\e', MANIFEST, path.win32);
  assert.strictEqual(L.whisper.exe, 'C:\\e\\whisper-1.9.5\\whisper-server.exe');
  assert.strictEqual(L.whisper.model, 'C:\\e\\models\\ggml-large-v3-turbo-q5_0.bin');
  assert.strictEqual(L.whisper.vad, 'C:\\e\\models\\ggml-silero-v6.2.0.bin');
  assert.strictEqual(L.sum.exe, 'C:\\e\\llama-b11669\\llama-server.exe');
  assert.strictEqual(L.sum.model, 'C:\\e\\models\\gemma-4-E4B-it-Q4_K_M.gguf');
  assert.notStrictEqual(L.whisper.dir, L.sum.dir);
});
test('installed.json: 一時ファイル経由で書く。知らない schema は「入っていない」とし、ファイルは消さない', () => {
  const d = tmp(); const f = path.join(d, 'installed.json');
  assert.deepStrictEqual(I.readInstalled(f), { schema: 1, consent: false, userPaused: false, items: {}, active: { whisper: null, sum: null } });
  I.writeInstalled(f, { ...I.readInstalled(f), consent: true });
  assert.strictEqual(I.readInstalled(f).consent, true);
  assert.deepStrictEqual(fs.readdirSync(d), ['installed.json']);
  fs.writeFileSync(f, JSON.stringify({ schema: 99, items: { x: {} } }));
  assert.deepStrictEqual(I.readInstalled(f).items, {});
  assert.ok(fs.existsSync(f));
});
test('planInstall: 記録と大きさ・更新時刻が合えば ready。ピンが変わった項目だけ update。触られたら changed。記録が無ければ missing', async () => {
  const s1 = await smallSet(); const s2 = await smallSet({ gen: 2 });
  try {
    const root = path.join(tmp(), 'engine'); const inst = await putByHand(root, s1);
    const st = (m) => Object.fromEntries(I.planInstall(m, inst, fs.statSync, root).map((p) => [p.id, p.state]));
    assert.deepStrictEqual(st(s1.manifest), { 'whisper-engine': 'ready', 'whisper-vad': 'ready', 'whisper-model': 'ready', 'sum-engine': 'ready', 'sum-model': 'ready' });
    assert.deepStrictEqual(st(s2.manifest), { 'whisper-engine': 'ready', 'whisper-vad': 'ready', 'whisper-model': 'update', 'sum-engine': 'update', 'sum-model': 'ready' });
    fs.utimesSync(path.join(root, 'models/vad.bin'), new Date(), new Date(Date.now() + 60000));
    assert.strictEqual(st(s1.manifest)['whisper-vad'], 'changed');
    const none = I.planInstall(s1.manifest, I.readInstalled(path.join(tmp(), 'x.json')), fs.statSync, root);
    assert.ok(none.every((p) => p.state === 'missing'));
  } finally { await s1.close(); await s2.close(); }
});
test('managedCandidates: ピンを上げた後も、新しい組がそろうまで active の前の組のパスを返す。active が無ければ null', async () => {
  const s1 = await smallSet(); const s2 = await smallSet({ gen: 2 });
  try {
    const root = path.join(tmp(), 'engine'); const inst = await putByHand(root, s1);
    const home = { supported: true, root };
    const now = I.managedCandidates(home, s1.manifest, inst, fs.statSync);
    assert.strictEqual(now.whisper.current, true);
    assert.strictEqual(now.whisper.exe, path.join(root, 'whisper-1.0.0', 'whisper-server.exe'));
    assert.deepStrictEqual(now.whisper.checkFiles.map((f) => path.basename(f.file)), ['whisper-server.exe', 'whisper.dll', 'ggml.dll']);
    assert.deepStrictEqual(I.managedCandidates(home, s2.manifest, inst, fs.statSync), { whisper: null, sum: null }, 'active が無いのに前の組を返した');
    inst.active = { whisper: s1.manifest.items.slice(0, 3).map((i) => i.sha256), sum: s1.manifest.items.slice(3).map((i) => i.sha256) };
    const prev = I.managedCandidates(home, s2.manifest, inst, fs.statSync);
    assert.strictEqual(prev.whisper.current, false);
    assert.strictEqual(prev.whisper.model, path.join(root, 'models', 'w-model.bin'));
    assert.strictEqual(prev.sum.exe, path.join(root, 'llama-b1', 'llama-server.exe'));
  } finally { await s1.close(); await s2.close(); }
});
test('statusOf: 取り込み直しの途中（update）でも、前の組があれば whisperReady は真。updateBytes は変わった項目だけ', async () => {
  const s1 = await smallSet(); const s2 = await smallSet({ gen: 2 });
  try {
    const root = path.join(tmp(), 'engine'); const inst = await putByHand(root, s1);
    inst.active = { whisper: s1.manifest.items.slice(0, 3).map((i) => i.sha256), sum: s1.manifest.items.slice(3).map((i) => i.sha256) };
    const home = { supported: true, root };
    const s = I.statusOf({ home, manifest: s2.manifest, plan: I.planInstall(s2.manifest, inst, fs.statSync, root),
      candidates: I.managedCandidates(home, s2.manifest, inst, fs.statSync), manual: { whisper: false, sum: false }, installed: inst });
    assert.strictEqual(s.state, 'update');
    assert.ok(s.whisperReady && s.sumReady);
    assert.deepStrictEqual(s.using, { whisper: 'previous', sum: 'previous' });
    assert.strictEqual(s.updateBytes, s2.manifest.items[2].size + s2.manifest.items[3].size);
  } finally { await s1.close(); await s2.close(); }
});
test('managedCandidates と statusOf は、通信もフォルダ作りもしない（起動のときに安全）', () => {
  const d = tmp(); const root = path.join(d, 'まだ無い', 'engine'); const home = { supported: true, root };
  const inst = I.readInstalled(path.join(root, 'installed.json'));
  assert.deepStrictEqual(I.managedCandidates(home, MANIFEST, inst, fs.statSync), { whisper: null, sum: null });
  const s = I.statusOf({ home, manifest: MANIFEST, plan: I.planInstall(MANIFEST, inst, fs.statSync, root),
    candidates: { whisper: null, sum: null }, manual: { whisper: false, sum: false }, installed: inst });
  assert.strictEqual(s.state, 'missing'); assert.strictEqual(s.totalBytes, 5580564403); assert.strictEqual(s.whisperBytes, 583854933);
  assert.ok(!fs.existsSync(path.join(d, 'まだ無い')), 'フォルダを作った');
  for (const it of s.items) { assert.match(it.place, /^%LOCALAPPDATA%\\natsu\\engine\\/); assert.ok(it.sha256 && it.url && it.version && it.license, it.id); }
});
test('freeBytesOf: まだ無い置き場所は、いちばん近い有る親のフォルダで測る。失敗は null', async () => {
  const d = tmp(); const seen = [];
  const n = await I.freeBytesOf(path.join(d, 'a', 'b', 'engine'), async (p) => { seen.push(p); return { bavail: 10, bsize: 4096 }; });
  assert.strictEqual(n, 40960); assert.deepStrictEqual(seen, [d]);
  assert.strictEqual(await I.freeBytesOf(d, async () => { throw new Error('x'); }), null);
});
test('statusOf: 手で設定している組は manual。その組の項目は取り込みの対象に数えない', () => {
  const root = path.join(tmp(), 'engine'); const home = { supported: true, root };
  const inst = I.readInstalled(path.join(root, 'installed.json'));
  const s = I.statusOf({ home, manifest: MANIFEST, plan: I.planInstall(MANIFEST, inst, fs.statSync, root),
    candidates: { whisper: null, sum: null }, manual: { whisper: true, sum: false }, installed: inst });
  assert.deepStrictEqual(s.mode, { whisper: 'manual', sum: 'managed' });
  assert.strictEqual(s.needBytes, MANIFEST.items.filter((i) => i.group === 'sum').reduce((a, i) => a + i.size, 0));
});
