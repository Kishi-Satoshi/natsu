/*
 * engine-install.test.js — エンジンとモデルの置き場所と取り込みの係 src/engine-install.js
 *
 * その1（Task 11）: 置き場所（%LOCALAPPDATA%\natsu\engine。Roaming には置かない）、並び、
 * installed.json の読み書き、何が済んでいるか（planInstall）、使える組（managedCandidates。
 * ピンを上げた後も、新しい組がそろうまで前の組を返す）、空き、画面へ渡す写し（statusOf）を、
 * 通信もフォルダ作りもせずに決める（第0b回 R7、RF13）。
 * その2（Task 12a）: zip から決めたファイルだけを <dir>.tmp に出して照らしてから置き（installZip）、
 * 記録を書き（recordInstalled）、使う前に exe と DLL を SHA-256 で照らす（verifyCandidates。RF3）。
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
const { fakeRequest } = require('./helpers/fake-net');
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
test('installed.json: 名前の変更で失敗しても前の記録はそのまま', () => {
  const d = tmp(); const f = path.join(d, 'installed.json');
  I.writeInstalled(f, { ...I.readInstalled(f), consent: true });
  const orig = fs.renameSync; fs.renameSync = () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); };
  try { assert.throws(() => I.writeInstalled(f, { ...I.readInstalled(f), consent: false })); } finally { fs.renameSync = orig; }
  assert.strictEqual(I.readInstalled(f).consent, true);
  assert.deepStrictEqual(fs.readdirSync(d), ['installed.json']);
});
test('installed.json: 名前の変更が EPERM・EBUSY なら少し待って試し直す（ウイルス対策が掴んでいるとき）。ほかの失敗はすぐ投げる', () => {
  const d = tmp(); const f = path.join(d, 'installed.json'); const orig = fs.renameSync;
  let n = 0;
  fs.renameSync = (a, b) => { n++; if (n <= 2) throw Object.assign(new Error('x'), { code: n === 1 ? 'EPERM' : 'EBUSY' }); return orig(a, b); };
  try { I.writeInstalled(f, { ...I.readInstalled(f), consent: true }); } finally { fs.renameSync = orig; }
  assert.strictEqual(n, 3); assert.strictEqual(I.readInstalled(f).consent, true);
  let m = 0;
  fs.renameSync = () => { m++; throw Object.assign(new Error('x'), { code: 'EIO' }); };
  try { assert.throws(() => I.writeInstalled(f, { ...I.readInstalled(f), consent: false }), { code: 'EIO' }); } finally { fs.renameSync = orig; }
  assert.strictEqual(m, 1);
  assert.strictEqual(I.readInstalled(f).consent, true);
  assert.deepStrictEqual(fs.readdirSync(d), ['installed.json']);
});
test('managedCandidates: 新しいピンで exe の名前が変わっても、前の組は記録の中の exe で返す。記録に exe が無ければ組にしない（RF13）', async () => {
  const s1 = await smallSet();
  try {
    const root = path.join(tmp(), 'engine'); const inst = await putByHand(root, s1); const home = { supported: true, root };
    inst.active = { whisper: s1.manifest.items.slice(0, 3).map((i) => i.sha256), sum: s1.manifest.items.slice(3).map((i) => i.sha256) };
    const m2 = { ...s1.manifest, items: s1.manifest.items.map((i) => (i.id === 'whisper-engine' ? { ...i, sha256: 'd'.repeat(64), dir: 'whisper-2.0.0', exe: 'whisper-srv.exe' } : i)) };
    const c = I.managedCandidates(home, m2, inst, fs.statSync);
    assert.ok(c.whisper, '前の組を返さない'); assert.strictEqual(c.whisper.current, false);
    assert.strictEqual(c.whisper.exe, path.join(root, 'whisper-1.0.0', 'whisper-server.exe'));
    assert.ok(c.sum && c.sum.current);
    const rec = inst.items[s1.manifest.items[0].sha256];
    rec.files = rec.files.filter((f) => !/\.exe$/i.test(f.name));
    assert.strictEqual(I.managedCandidates(home, m2, inst, fs.statSync).whisper, null);
  } finally { await s1.close(); }
});
test('statusOf: updateBytes は update の項目の残りだけ（.part で持っている分を引き、missing の項目は数えない）', async () => {
  const s1 = await smallSet(); const s2 = await smallSet({ gen: 2 });
  try {
    const root = path.join(tmp(), 'engine'); const inst = await putByHand(root, s1); const home = { supported: true, root };
    delete inst.items[s1.manifest.items[1].sha256];   // VAD の記録が無い → missing
    const m = s2.manifest.items; const held = 1234;
    fs.mkdirSync(path.join(root, '.download'), { recursive: true });
    fs.writeFileSync(path.join(root, '.download', `${m[2].sha256}.part`), Buffer.alloc(held));
    const plan = I.planInstall(s2.manifest, inst, fs.statSync, root);
    assert.deepStrictEqual(plan.map((p) => [p.id, p.state, p.held]), [['whisper-engine', 'ready', 0], ['whisper-vad', 'missing', 0],
      ['whisper-model', 'update', held], ['sum-engine', 'update', 0], ['sum-model', 'ready', 0]]);
    const s = I.statusOf({ home, manifest: s2.manifest, plan, candidates: I.managedCandidates(home, s2.manifest, inst, fs.statSync),
      manual: { whisper: false, sum: false }, installed: inst });
    assert.strictEqual(s.updateBytes, m[2].size - held + m[3].size);
    assert.strictEqual(s.needBytes, m[1].size + m[2].size - held + m[3].size);
  } finally { await s1.close(); await s2.close(); }
});

// ---------------------------------------------------------------- その2（Task 12a）: zip の展開・記録・照らし
test('zip: 決めたファイルだけを <dir>.tmp に出して照らし、名前を変えて置く。zip は消す。ほかのファイルは出さない', async () => {
  const set = await smallSet();
  try {
    const root = path.join(tmp(), 'engine'); const it = set.manifest.items[0];
    fs.mkdirSync(root, { recursive: true }); const zf = path.join(root, 'w.zip'); fs.writeFileSync(zf, set.bodies[it.id]);
    const r = await I.installZip(it, zf, root);
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'whisper-1.0.0')).sort(), ['ggml.dll', 'whisper-server.exe', 'whisper.dll']);
    assert.ok(!fs.existsSync(zf) && !fs.existsSync(path.join(root, 'whisper-1.0.0.tmp')));
    assert.deepStrictEqual(r.files.map((f) => f.sha256), it.files.map((f) => f.sha256));
  } finally { await set.close(); }
});
test('zip: 1 つでも SHA-256 が違えば何も置かず（.tmp を消し）、installed.json も変えない', async () => {
  const set = await smallSet();
  try {
    const root = path.join(tmp(), 'engine'); const it0 = set.manifest.items[0];
    const it = { ...it0, files: it0.files.map((f, i) => (i === 1 ? { ...f, sha256: 'c'.repeat(64) } : f)) };
    fs.mkdirSync(root, { recursive: true }); const zf = path.join(root, 'w.zip'); fs.writeFileSync(zf, set.bodies[it0.id]);
    await assert.rejects(I.installZip(it, zf, root), { code: 'hash' });
    assert.ok(!fs.existsSync(path.join(root, 'whisper-1.0.0')) && !fs.existsSync(path.join(root, 'whisper-1.0.0.tmp')));
    assert.ok(!fs.existsSync(path.join(root, 'installed.json')));
  } finally { await set.close(); }
});
test('zip: 置く先のフォルダが既にあり、中身が同じなら使う（記録が消えても取り直さない）', async () => {
  const set = await smallSet();
  try {
    const root = path.join(tmp(), 'engine'); await putByHand(root, set, ['whisper-engine']);
    const zf = path.join(root, 'w.zip'); fs.writeFileSync(zf, set.bodies['whisper-engine']);
    const r = await I.installZip(set.manifest.items[0], zf, root);
    assert.strictEqual(r.dir, path.join(root, 'whisper-1.0.0'));
  } finally { await set.close(); }
});
test('zip: 置く先のフォルダが既にあり中身が違えば hash で断り、そのフォルダには触らない（動いているかもしれない）。zip は残す', async () => {
  const set = await smallSet();
  try {
    const root = path.join(tmp(), 'engine'); await putByHand(root, set, ['whisper-engine']);
    const dll = path.join(root, 'whisper-1.0.0', 'whisper.dll'); const b = fs.readFileSync(dll); b[0] ^= 0xff; fs.writeFileSync(dll, b);
    const zf = path.join(root, 'w.zip'); fs.writeFileSync(zf, set.bodies['whisper-engine']);
    await assert.rejects(I.installZip(set.manifest.items[0], zf, root), { code: 'hash' });
    assert.deepStrictEqual(fs.readFileSync(dll), b, 'フォルダを入れ替えた');
    assert.ok(fs.existsSync(zf) && !fs.existsSync(path.join(root, 'whisper-1.0.0.tmp')));
  } finally { await set.close(); }
});
test('RF3: verifyCandidates は exe と DLL を SHA-256 で照らす。大きさと更新時刻が同じでも、中身の違う DLL の組は使わない', async () => {
  const set = await smallSet();
  try {
    const root = path.join(tmp(), 'engine'); const inst = await putByHand(root, set); const home = { supported: true, root };
    const c = I.managedCandidates(home, set.manifest, inst, fs.statSync);
    const ok = await I.verifyCandidates(c);
    assert.ok(ok.whisper && ok.sum); assert.deepStrictEqual(ok.bad, []);
    const dll = path.join(root, 'whisper-1.0.0', 'whisper.dll'); const st = fs.statSync(dll);
    const b = fs.readFileSync(dll); b[0] ^= 0xff; fs.writeFileSync(dll, b); fs.utimesSync(dll, st.atime, st.mtime);   // 同じ大きさ・同じ更新時刻
    const ng = await I.verifyCandidates(c);
    assert.strictEqual(ng.whisper, null); assert.ok(ng.sum);
    assert.deepStrictEqual(ng.bad, [{ group: 'whisper', file: dll, why: 'changed' }]);
  } finally { await set.close(); }
});
test('RF3: verifyCandidates はモデルを大きさと更新時刻で照らす（数 GB を毎回読まない）。exe が消えていれば missing', async () => {
  const set = await smallSet();
  try {
    const root = path.join(tmp(), 'engine'); const inst = await putByHand(root, set); const home = { supported: true, root };
    const c = I.managedCandidates(home, set.manifest, inst, fs.statSync);
    let hashed = [];
    await I.verifyCandidates(c, { hash: async (f) => { hashed.push(path.basename(f)); return I.sha256File(f); } });
    assert.ok(!hashed.some((f) => /\.(bin|gguf)$/.test(f)), `モデルを読んだ: ${hashed}`);
    fs.utimesSync(path.join(root, 'models', 's-model.gguf'), new Date(), new Date(Date.now() + 60000));
    fs.rmSync(path.join(root, 'whisper-1.0.0', 'whisper-server.exe'));
    const r = await I.verifyCandidates(c);
    assert.deepStrictEqual([r.whisper, r.sum], [null, null]);
    assert.deepStrictEqual(r.bad.map((b) => [b.group, path.basename(b.file), b.why]),
      [['whisper', 'whisper-server.exe', 'missing'], ['sum', 's-model.gguf', 'changed']]);
  } finally { await set.close(); }
});
test('zip: <dir>.tmp から <dir> への名前の変更が EPERM で 2 回失敗、3 回目に通る。いつも EPERM なら locked で、何も置かず zip は残す', async () => {
  const set = await smallSet();
  try {
    const it = set.manifest.items[0]; const waits = [];
    const sleep = async (ms) => { waits.push(ms); };
    const root = path.join(tmp(), 'engine'); fs.mkdirSync(root, { recursive: true });
    const zf = path.join(root, 'w.zip'); fs.writeFileSync(zf, set.bodies[it.id]);
    let n = 0;
    const rename = async (a, b) => { if (++n <= 2) throw Object.assign(new Error('x'), { code: 'EPERM' }); return fs.promises.rename(a, b); };
    const r = await I.installZip(it, zf, root, { rename, sleep });
    assert.strictEqual(n, 3); assert.strictEqual(waits.length, 2); assert.ok(waits[0] >= 300 && waits[1] > waits[0], `待ち: ${waits}`);
    assert.strictEqual(r.dir, path.join(root, 'whisper-1.0.0'));
    const root2 = path.join(tmp(), 'engine'); fs.mkdirSync(root2, { recursive: true });
    const zf2 = path.join(root2, 'w.zip'); fs.writeFileSync(zf2, set.bodies[it.id]);
    let m = 0;
    await assert.rejects(I.installZip(it, zf2, root2, { rename: async () => { m++; throw Object.assign(new Error('x'), { code: 'EBUSY' }); }, sleep }), { code: 'locked' });
    assert.strictEqual(m, 10);
    assert.ok(!fs.existsSync(path.join(root2, 'whisper-1.0.0')) && !fs.existsSync(path.join(root2, 'whisper-1.0.0.tmp')));
    assert.ok(fs.existsSync(zf2), 'zip を消した（取り直しになる）');
  } finally { await set.close(); }
});
test('recordInstalled: zip は展開したファイルごと、ファイルは置き場所の大きさと更新時刻を installed.json に書く（managedCandidates がそのまま使える）', async () => {
  const set = await smallSet();
  try {
    const root = path.join(tmp(), 'engine'); const home = { supported: true, root };
    const inst0 = await putByHand(root, set);
    fs.rmSync(path.join(root, 'installed.json'));
    for (const it of set.manifest.items) {
      const info = it.kind === 'zip' ? { dir: path.join(root, it.dir), files: inst0.items[it.sha256].files } : { file: path.join(root, it.dest) };
      I.recordInstalled(home, it, info);
    }
    const inst = I.readInstalled(path.join(root, 'installed.json'));
    assert.deepStrictEqual(inst.items, inst0.items);
    assert.deepStrictEqual(fs.readdirSync(root).filter((f) => /\.tmp$/.test(f)), []);
    const c = I.managedCandidates(home, set.manifest, inst, fs.statSync);
    assert.ok(c.whisper && c.whisper.current && c.sum && c.sum.current);
  } finally { await set.close(); }
});
