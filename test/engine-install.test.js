/*
 * engine-install.test.js — エンジンとモデルの置き場所と取り込みの係 src/engine-install.js
 *
 * その1（Task 11）: 置き場所（%LOCALAPPDATA%\natsu\engine。Roaming には置かない）、並び、
 * installed.json の読み書き、何が済んでいるか（planInstall）、使える組（managedCandidates。
 * ピンを上げた後も、新しい組がそろうまで前の組を返す）、空き、画面へ渡す写し（statusOf）を、
 * 通信もフォルダ作りもせずに決める（第0b回 R7、RF13）。
 * その2（Task 12a）: zip から決めたファイルだけを <dir>.tmp に出して照らしてから置き（installZip）、
 * 記録を書き（recordInstalled）、使う前に exe と DLL を SHA-256 で照らす（verifyCandidates。RF3）。
 * その3（Task 12b）: 取り込みの係（makeRunner）。その4（Task 12c）: 切り替えた後で前の版だけを消し（cleanupOld。RF8）、
 * ライセンスの写し（writeNotices。MIT License の許諾の文は src/licenses/MIT.txt、Apache License 2.0 の全文は src/licenses/Apache-2.0.txt）を書く。
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
// 偽のサーバーを立ててファイルを書き換えるテストの見張り（止まったときだけ当たる。ふだんは 1 秒まで）。Windows の CI では、ほかのテストと
// 重なった時間帯に 5 秒を越えた（第1a回 合流、run 39104480319）。5 秒の見張りは速さの目安ではないので、子のプロセスを起こすテストと同じ 20 秒にする
const IO_WAIT = { timeout: 20000 };

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
test('planInstall: 記録と大きさ・更新時刻が合えば ready。ピンが変わった項目だけ update。触られたら changed。記録が無ければ missing', IO_WAIT, async () => {
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
test('managedCandidates: ピンを上げた後も、新しい組がそろうまで active の前の組のパスを返す。active が無ければ null', IO_WAIT, async () => {
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
test('statusOf: 取り込み直しの途中（update）でも、前の組があれば whisperReady は真。updateBytes は変わった項目だけ', IO_WAIT, async () => {
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
test('managedCandidates: 新しいピンで exe の名前が変わっても、前の組は記録の中の exe で返す。記録に exe が無ければ組にしない（RF13）', IO_WAIT, async () => {
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
test('statusOf: updateBytes は update の項目の残りだけ（.part で持っている分を引き、missing の項目は数えない）', IO_WAIT, async () => {
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
test('zip: 決めたファイルだけを <dir>.tmp に出して照らし、名前を変えて置く。zip は消す。ほかのファイルは出さない', IO_WAIT, async () => {
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
test('zip: 1 つでも SHA-256 が違えば何も置かず（.tmp を消し）、installed.json も変えない', IO_WAIT, async () => {
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
test('zip: 置く先のフォルダが既にあり、中身が同じなら使う（記録が消えても取り直さない）', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const root = path.join(tmp(), 'engine'); await putByHand(root, set, ['whisper-engine']);
    const zf = path.join(root, 'w.zip'); fs.writeFileSync(zf, set.bodies['whisper-engine']);
    const r = await I.installZip(set.manifest.items[0], zf, root);
    assert.strictEqual(r.dir, path.join(root, 'whisper-1.0.0'));
  } finally { await set.close(); }
});
test('zip: 置く先のフォルダが既にあり中身が違えば hash で断り、そのフォルダには触らない（動いているかもしれない）。zip は残す', IO_WAIT, async () => {
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
test('RF3: verifyCandidates は exe と DLL を SHA-256 で照らす。大きさと更新時刻が同じでも、中身の違う DLL の組は使わない', IO_WAIT, async () => {
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
test('RF3: verifyCandidates はモデルを大きさと更新時刻で照らす（数 GB を毎回読まない）。exe が消えていれば missing', IO_WAIT, async () => {
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
test('zip: <dir>.tmp から <dir> への名前の変更が EPERM で 2 回失敗、3 回目に通る。いつも EPERM なら locked で、何も置かず zip は残す', IO_WAIT, async () => {
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
test('recordInstalled: zip は展開したファイルごと、ファイルは置き場所の大きさと更新時刻を installed.json に書く（managedCandidates がそのまま使える）', IO_WAIT, async () => {
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

// ---------------------------------------------------------------- その3（Task 12b）: 取り込みの係（順・空き・待ち・一時停止・取り直し）
// 計画のテストのまま。各テストに { timeout: 5000 } だけ足した（係が止まらない誤りで npm test が終わらなくならないように。5 秒の決まり）
const homeOf = () => ({ supported: true, root: path.join(tmp(), 'engine') });
// depsOf は計画のとおり。ただし sleep（差し替えたものも）の呼ばれた数に上限をつけた（点検の指摘）。テストが done() を
// 待たずに落ちたときや、係が止まらない誤りのときに、閉じたサーバーへの試しと待ちが回り続けて node --test が終わらなく
// ならないように。上限を超えると sleep が投げ、係はそこで止まる（ふつうのテストは多くて数百回）
const SLEEP_LIMIT = 20000;
const depsOf = (set, home, o = {}) => {
  const d = { home, manifest: set.manifest, request: fakeRequest, sleep: async () => {}, now: () => 0,
    statfs: async () => ({ bavail: 1e9, bsize: 4096 }), fetchOpts: { requireHttps: false, headerTimeoutMs: 1000, stallMs: 300 }, ...o };
  const inner = d.sleep; let n = 0;
  return { ...d, sleep: async (ms) => { if (++n > SLEEP_LIMIT) throw new Error(`sleep が ${SLEEP_LIMIT} 回を超えた（係が止まらない）`); return inner(ms); } };
};
const ids = (set) => set.hits().map((h) => h.id);
// 標準の MIT License（https://opensource.org/license/mit の文。著作権の行を除く）。MIT.txt の語の並びと比べる
const MIT_STANDARD = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;
const MIT_SHA256 = '508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1';
test('start はすぐ返り、動いている仕事をもう一度始めない（2 回押しても二重にならない）', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const r = I.makeRunner(depsOf(set, homeOf()));
    const a = r.start({ user: true }); r.start({ user: true });
    assert.ok(a && a.ok && r.running());
    await r.done();
    assert.deepStrictEqual(ids(set), ['whisper-engine', 'whisper-vad', 'whisper-model', 'sum-engine', 'sum-model']);
    assert.strictEqual(r.status().state, 'ready');
  } finally { await set.close(); }
});
test('取り込む順: whisper のエンジン → VAD → モデル →（whisper が使える知らせ）→ llama → 要約のモデル', IO_WAIT, async () => {
  const seen = []; const set = await smallSet({ onHit: (id) => seen.push(id) });
  try {
    const r = I.makeRunner(depsOf(set, homeOf(), { onGroupReady: (g) => seen.push(`ready:${g}`) }));
    r.start({ user: true }); await r.done();
    assert.deepStrictEqual(seen, ['whisper-engine', 'whisper-vad', 'whisper-model', 'ready:whisper', 'sum-engine', 'sum-model', 'ready:sum']);
  } finally { await set.close(); }
});
test('空きが足りなければ、1 つも要求せずに space（余裕は 1GB から、足りない GB つき）。statfs が投げても続ける', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const r = I.makeRunner(depsOf(set, homeOf(), { statfs: async () => ({ bavail: 1, bsize: 1000 }) }));
    r.start({ user: true }); await r.done();
    assert.deepStrictEqual(ids(set), []);
    assert.strictEqual(r.status().error.code, 'space');
    assert.match(r.status().error.message, /あと 1\.1 GB/);
    const r2 = I.makeRunner(depsOf(set, homeOf(), { statfs: async () => { throw new Error('x'); } }));
    r2.start({ user: true }); await r2.done();
    assert.strictEqual(r2.status().state, 'ready');
  } finally { await set.close(); }
});
test('手で設定している組は飛ばす。all のときは全部取る（切り替えのため）', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const r = I.makeRunner(depsOf(set, homeOf(), { isManual: (g) => g === 'whisper' }));
    r.start({ user: true }); await r.done();
    assert.deepStrictEqual(ids(set), ['sum-engine', 'sum-model']);
    const r2 = I.makeRunner(depsOf(set, homeOf(), { isManual: () => true }));
    r2.start({ user: true, all: true }); await r2.done();
    assert.strictEqual(ids(set).length, 2 + 5);
  } finally { await set.close(); }
});
test('記録中（hold が真）は要求を出さずに held で待ち、終われば続ける', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    let holding = true; let polls = 0; const states = [];
    const r = I.makeRunner(depsOf(set, homeOf(), { hold: () => holding, onState: (s) => states.push(s.state),
      sleep: async () => { if (++polls === 3) { assert.deepStrictEqual(ids(set), []); holding = false; } } }));
    r.start({ user: true }); await r.done();
    assert.ok(states.includes('held') && states[states.length - 1] === 'ready', states.join(','));
  } finally { await set.close(); }
});
test('［一時停止］は userPaused を残し、次の起動の自動の開始は何もしない。終了のときの一時停止は残さない', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const home = homeOf(); let r;
    r = I.makeRunner(depsOf(set, home, { onGroupReady: () => r.pause('user') }));
    r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().state, 'paused');
    assert.strictEqual(I.readInstalled(path.join(home.root, 'installed.json')).userPaused, true);
    const n = ids(set).length;
    const again = I.makeRunner(depsOf(set, home)); again.start({ auto: true }); await again.done();
    assert.strictEqual(ids(set).length, n, '利用者が止めたのに自動で続けた');
    const home2 = homeOf(); let q;
    q = I.makeRunner(depsOf(set, home2, { onGroupReady: () => q.pause('quit') }));
    q.start({ user: true }); await q.done();
    assert.strictEqual(I.readInstalled(path.join(home2.root, 'installed.json')).userPaused, false);
  } finally { await set.close(); }
});
test('RF14: 回線が長く切れても（fetchFile の上限を何度も超えても）あきらめずに waiting で待ち、戻れば自分で終わる', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    set.setDown(true); let sleeps = 0; const states = [];
    const r = I.makeRunner(depsOf(set, homeOf(), { onState: (s) => states.push(s.state),
      sleep: async () => { if (++sleeps === 200) set.setDown(false); } }));
    r.start({ user: true }); await r.done();
    assert.ok(states.includes('waiting'), states.join(','));
    assert.strictEqual(r.status().state, 'ready');
    assert.ok(sleeps >= 200);
  } finally { await set.close(); }
});
test('待っても直らない失敗（404 の text/plain = gone）は止めて文を出す。後の項目は取らない', IO_WAIT, async () => {
  const set = await smallSet({ missing: ['whisper-vad'] });
  try {
    const r = I.makeRunner(depsOf(set, homeOf())); r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().error.code, 'gone');
    assert.match(r.status().error.message, /NaTsu の更新が必要/);
    assert.deepStrictEqual(ids(set), ['whisper-engine', 'whisper-vad']);
  } finally { await set.close(); }
});
test('RF3: 消えた exe は 1 回だけ取り直す。同じ起動の中でまた消えたら取らずに defender（パスつき）', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const home = homeOf(); const r = I.makeRunner(depsOf(set, home));
    r.start({ user: true }); await r.done();
    const exe = path.join(home.root, 'whisper-1.0.0', 'whisper-server.exe');
    fs.rmSync(exe); r.start({ repair: ['whisper-engine'] }); await r.done();
    assert.ok(fs.existsSync(exe)); assert.strictEqual(ids(set).filter((i) => i === 'whisper-engine').length, 2);
    fs.rmSync(exe); r.start({ repair: ['whisper-engine'] }); await r.done();
    assert.strictEqual(ids(set).filter((i) => i === 'whisper-engine').length, 2, '同じ起動の中で 2 回直した');
    assert.strictEqual(r.status().error.code, 'defender');
    assert.ok(r.status().error.message.includes('whisper-server.exe'));
  } finally { await set.close(); }
});
test('進み具合の写しは間引く（時計が進まなければ、最初と最後の 2 回だけ）', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const seen = [];
    const r = I.makeRunner(depsOf(set, homeOf(), { onProgress: (s) => seen.push(s.doneBytes) }));
    r.start({ user: true }); await r.done();
    assert.strictEqual(seen.length, 2, String(seen.length));
  } finally { await set.close(); }
});
test('RF13: 起動のときの自動の開始は、大きな取り込み直し（autoUpdateMaxBytes 超）を始めず update で待つ。押せば取る', IO_WAIT, async () => {
  const s1 = await smallSet(); const s2 = await smallSet({ gen: 2 });
  try {
    const home = homeOf();
    const a = I.makeRunner(depsOf(s1, home)); a.start({ user: true }); await a.done();
    I.setActive(home, s1.manifest, 'whisper'); I.setActive(home, s1.manifest, 'sum');
    const b = I.makeRunner(depsOf(s2, home, { autoUpdateMaxBytes: 1000 }));
    b.start({ auto: true }); await b.done();
    assert.deepStrictEqual(ids(s2), []); assert.strictEqual(b.status().state, 'update');
    b.start({ user: true }); await b.done();
    assert.deepStrictEqual(ids(s2), ['whisper-model', 'sum-engine']);
  } finally { await s1.close(); await s2.close(); }
});
test('使っている組の置き場所に、違う SHA-256 のファイルを置かない（place-in-use）', IO_WAIT, async () => {
  const s1 = await smallSet(); const s2 = await smallSet({ gen: 2, sameDest: true });
  try {
    const home = homeOf();
    const a = I.makeRunner(depsOf(s1, home)); a.start({ user: true }); await a.done();
    I.setActive(home, s1.manifest, 'whisper');
    const b = I.makeRunner(depsOf(s2, home)); b.start({ user: true }); await b.done();
    assert.strictEqual(b.status().error.code, 'place-in-use');
    assert.ok(!ids(s2).includes('whisper-model'));
  } finally { await s1.close(); await s2.close(); }
});
test('触られただけ（changed）のファイルは、取らずに照らし直して記録を書き直す', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const home = homeOf(); const r = I.makeRunner(depsOf(set, home)); r.start({ user: true }); await r.done();
    const n = ids(set).length;
    fs.utimesSync(path.join(home.root, 'models', 'w-model.bin'), new Date(), new Date(Date.now() + 60000));
    r.start({ user: true }); await r.done();
    assert.strictEqual(ids(set).length, n);
    assert.strictEqual(r.status().state, 'ready');
  } finally { await set.close(); }
});
test('残った .tmp と、今のピンに無い .part は消す。今のピンの .part からは Range で続ける', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const home = homeOf(); const dl = path.join(home.root, '.download'); fs.mkdirSync(dl, { recursive: true });
    fs.mkdirSync(path.join(home.root, 'whisper-0.9.tmp'));
    fs.writeFileSync(path.join(dl, `${'d'.repeat(64)}.part`), 'x');
    const m = set.manifest.items[2];
    fs.writeFileSync(path.join(dl, `${m.sha256}.part`), set.bodies[m.id].subarray(0, 10000));
    fs.writeFileSync(path.join(dl, `${m.sha256}.json`), JSON.stringify({ url: m.url, size: m.size, sha256: m.sha256, synced: 10000 }));
    const r = I.makeRunner(depsOf(set, home)); r.start({ user: true }); await r.done();
    assert.ok(!fs.existsSync(path.join(home.root, 'whisper-0.9.tmp')) && !fs.existsSync(path.join(dl, `${'d'.repeat(64)}.part`)));
    assert.strictEqual(set.hits().find((h) => h.id === 'whisper-model').range, 'bytes=10000-');
  } finally { await set.close(); }
});
test('setActive は今のピンのその組の SHA-256 を active に書く', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const home = homeOf(); const r = I.makeRunner(depsOf(set, home)); r.start({ user: true }); await r.done();
    I.setActive(home, set.manifest, 'whisper');
    assert.deepStrictEqual(I.readInstalled(path.join(home.root, 'installed.json')).active,
      { whisper: set.manifest.items.slice(0, 3).map((i) => i.sha256), sum: null });
  } finally { await set.close(); }
});
// ここから下は計画に無い、実装した人が足したテスト（計画の Interfaces に書いてあるが、計画のテストが押さえていない振る舞い）
test('2 回押しても仕事は 1 つ（done は同じ Promise・始めの知らせは 1 回）', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const states = [];
    const r = I.makeRunner(depsOf(set, homeOf(), { onState: (s) => states.push(s.state) }));
    r.start({ user: true }); const p1 = r.done(); r.start({ user: true }); const p2 = r.done();
    assert.strictEqual(p1, p2, '2 つ目の仕事を始めた');
    await r.done();
    assert.deepStrictEqual(states, ['running', 'ready']);
    assert.ok(!r.running());
  } finally { await set.close(); }
});
test('待っている間（waiting）: ［今すぐ試す］・切れていた回線の戻り・［一時停止］で、60 秒を待たずにすぐ動く', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    // ［今すぐ試す］（待っている間の start）: 待ちを切り上げて試す
    set.setDown(true); let sleeps = 0; let pressed = false; let r;
    r = I.makeRunner(depsOf(set, homeOf(), { sleep: async () => { sleeps++; },
      onState: (s) => { if (s.state === 'waiting' && !pressed) { pressed = true; set.setDown(false); r.start({ user: true }); } } }));
    r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().state, 'ready'); assert.ok(pressed && sleeps < 20, `待ちを切り上げない: ${sleeps}`);
    // isOnline が偽から真に戻ったら、すぐ続きから
    set.setDown(true); let n = 0;
    const r2 = I.makeRunner(depsOf(set, homeOf(), { sleep: async () => { if (++n === 7) set.setDown(false); }, isOnline: () => n >= 10 }));
    r2.start({ user: true }); await r2.done();
    assert.strictEqual(r2.status().state, 'ready'); assert.ok(n < 20, `回線が戻っても待ち続けた: ${n}`);
    // ［一時停止］: 待ちをやめて paused
    set.setDown(true); let m = 0; let q;
    q = I.makeRunner(depsOf(set, homeOf(), { sleep: async () => { m++; }, onState: (s) => { if (s.state === 'waiting') q.pause('user'); } }));
    q.start({ user: true }); await q.done();
    assert.strictEqual(q.status().state, 'paused'); assert.ok(m < 20, `止めても待ち続けた: ${m}`);
  } finally { await set.close(); }
});
test('Q14: downloading() は実際に取っている間（running）だけ真。回線を待つ（waiting）・記録中で止める（held）・一時停止や終わった後は偽（running() は待つ間も真）', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    // 記録中（held）
    let holding = true; let polls = 0; const a = []; let r;
    r = I.makeRunner(depsOf(set, homeOf(), { hold: () => holding, onState: (s) => a.push([s.state, r.downloading(), r.running()]),
      sleep: async () => { if (++polls === 3) holding = false; } }));
    r.start({ user: true }); await r.done();
    assert.deepStrictEqual(a, [['running', true, true], ['held', false, true], ['running', true, true], ['ready', false, false]]);
    assert.strictEqual(r.downloading(), false);
    // 回線を待つ（waiting）。待ちの後は自分で試し直して running に戻る（PC が起きた後も同じ: 時計の待ちが明ければ試す）
    set.setDown(true); let sleeps = 0; const b = []; let w;
    w = I.makeRunner(depsOf(set, homeOf(), { onState: (s) => b.push([s.state, w.downloading(), w.running()]),
      sleep: async () => { if (++sleeps === 150) set.setDown(false); } }));
    w.start({ user: true }); await w.done();
    assert.ok(b.some((x) => x[0] === 'waiting'), JSON.stringify(b));
    for (const [st, dl, run] of b) {
      assert.strictEqual(dl, st === 'running', `${st} で downloading() が ${dl}`);
      assert.strictEqual(run, st === 'running' || st === 'waiting', `${st} で running() が ${run}`);
    }
    assert.strictEqual(w.status().state, 'ready');
    // 待っている間の［一時停止］→ paused では偽
    set.setDown(true); const c = []; let q;
    q = I.makeRunner(depsOf(set, homeOf(), { sleep: async () => {}, onState: (s) => { c.push([s.state, q.downloading()]); if (s.state === 'waiting') q.pause('user'); } }));
    q.start({ user: true }); await q.done();
    assert.deepStrictEqual(c[c.length - 1], ['paused', false]);
    assert.ok(c.some((x) => x[0] === 'waiting' && x[1] === false));
  } finally { await set.close(); }
});
test('取り込みの途中で記録が始まったら、今の要求を止めて held で待ち、終われば続きから取る（バイトが来ない間も見張る）', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const E = require('../src/engine-fetch');
    // バイトが届いた時に見る
    let holding = false; let calls = 0; let abortedSeen = false; const states = [];
    const r = I.makeRunner(depsOf(set, homeOf(), { hold: () => holding, onState: (s) => states.push(s.state),
      sleep: async () => { holding = false; },
      fetchFile: async (pin, o) => {
        if (pin.id === 'whisper-model' && ++calls === 1) {
          o.onProgress({ done: 100, total: pin.size }); holding = true; o.onProgress({ done: 200, total: pin.size });
          abortedSeen = o.signal.aborted;
          throw Object.assign(new Error('x'), { code: 'cancelled' });
        }
        return E.fetchFile(pin, o);
      } }));
    r.start({ user: true }); await r.done();
    assert.ok(abortedSeen, '記録が始まっても要求を止めない'); assert.strictEqual(calls, 2);
    assert.deepStrictEqual(states, ['running', 'held', 'running', 'ready']);
    // バイトが来ない間（見出しを待っている間）も holdPollMs ごとに見る
    let h2 = false; let c2 = 0;
    const r2 = I.makeRunner(depsOf(set, homeOf(), { hold: () => h2, holdPollMs: 20, sleep: async () => { h2 = false; },
      fetchFile: (pin, o) => {
        if (pin.id !== 'whisper-vad' || ++c2 > 1) return E.fetchFile(pin, o);
        h2 = true;
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(Object.assign(new Error('見張りが動かない'), { code: 'gone' })), 2000);
          o.signal.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('x'), { code: 'cancelled' })); });
        });
      } }));
    r2.start({ user: true }); await r2.done();
    assert.strictEqual(r2.status().state, 'ready', JSON.stringify(r2.status().error)); assert.strictEqual(c2, 2);
  } finally { await set.close(); }
});
test('取り込みの途中の［一時停止］は今の要求を止め、また押せば続きから取る。止めている途中に押されたら止めない', IO_WAIT, async () => {
  const set = await smallSet({ onHit: (id) => { if (id === 'whisper-model' && hook) hook(); } });
  let hook = null;
  try {
    const home = homeOf(); const r = I.makeRunner(depsOf(set, home));
    hook = () => { hook = null; r.pause('user'); };
    r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().state, 'paused');
    assert.deepStrictEqual(ids(set), ['whisper-engine', 'whisper-vad', 'whisper-model']);
    r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().state, 'ready');
    assert.deepStrictEqual(ids(set), ['whisper-engine', 'whisper-vad', 'whisper-model', 'whisper-model', 'sum-engine', 'sum-model'], '止めた要求を取り終えてから止まった');
    assert.strictEqual(I.readInstalled(path.join(home.root, 'installed.json')).userPaused, false);
    const set2 = await smallSet({ onHit: (id) => { if (id === 'whisper-model' && hook2) hook2(); } });
    let hook2 = null;
    try {
      const home2 = homeOf(); const q = I.makeRunner(depsOf(set2, home2));
      hook2 = () => { hook2 = null; q.pause('user'); q.start({ user: true }); };
      q.start({ user: true }); await q.done();
      assert.strictEqual(q.status().state, 'ready');
      assert.strictEqual(I.readInstalled(path.join(home2.root, 'installed.json')).userPaused, false);
      assert.strictEqual(ids(set2).filter((i) => i === 'whisper-model').length, 2);
    } finally { await set2.close(); }
  } finally { await set.close(); }
});
test('installed.json を書けない（EPERM が続く）は locked の文。取り込めない PC では何もしない', IO_WAIT, async () => {
  const set = await smallSet();
  const orig = fs.renameSync;
  try {
    const r = I.makeRunner(depsOf(set, homeOf()));
    fs.renameSync = () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); };
    try { r.start({ user: true }); await r.done(); } finally { fs.renameSync = orig; }
    assert.strictEqual(r.status().error.code, 'locked');
    assert.match(r.status().error.message, /ほかのプログラムが使っています/);
    const u = I.makeRunner({ home: { supported: false, root: null }, manifest: MANIFEST, request: fakeRequest });
    const s = u.start({ user: true });
    assert.strictEqual(s.state, 'unsupported'); assert.ok(!u.running());
    await u.done();
  } finally { fs.renameSync = orig; await set.close(); }
});
// ここから下は点検で足したテスト（変異が緑のまま残ったところと、取り直しの 1 回の数え方）
test('一時停止中の取り直しは、その項目だけを取る。ほかの残りは取らず、そろっていない組の知らせも出さない', IO_WAIT, async () => {
  let hook = null;
  const set = await smallSet({ onHit: (id) => { if (id === 'whisper-model' && hook) hook(); } });
  try {
    const home = homeOf(); const r = I.makeRunner(depsOf(set, home));
    hook = () => { hook = null; r.pause('user'); };
    r.start({ user: true }); await r.done();
    const n0 = ids(set).length;
    fs.rmSync(path.join(home.root, 'whisper-1.0.0', 'whisper-server.exe'));
    const ready = []; const r2 = I.makeRunner(depsOf(set, home, { onGroupReady: (g) => ready.push(g) }));
    r2.start({ repair: ['whisper-engine'] }); await r2.done();
    assert.deepStrictEqual(ids(set).slice(n0), ['whisper-engine'], '一時停止中なのに、ほかの残りも取った');
    assert.deepStrictEqual(ready, [], 'そろっていない組を知らせた');
  } finally { await set.close(); }
});
test('触られて中身も違う（changed）ファイルは 1 回だけ取り直し、同じ起動の中でまた違えば defender', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const home = homeOf(); const r = I.makeRunner(depsOf(set, home)); r.start({ user: true }); await r.done();
    const f = path.join(home.root, 'models', 'w-model.bin');
    const spoil = () => { const b = fs.readFileSync(f); b[0] ^= 0xff; fs.writeFileSync(f, b); fs.utimesSync(f, new Date(), new Date(Date.now() + 60000)); };
    spoil(); r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().state, 'ready'); assert.strictEqual(ids(set).filter((i) => i === 'whisper-model').length, 2);
    spoil(); r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().error.code, 'defender'); assert.strictEqual(ids(set).filter((i) => i === 'whisper-model').length, 2);
  } finally { await set.close(); }
});
test('壊れた版のフォルダをどけられない（locked）ときは、取り直しの 1 回を使わない。次に押せば取り直す', IO_WAIT, async () => {
  const set = await smallSet();
  const orig = fs.promises.rename;
  try {
    const home = homeOf(); const r = I.makeRunner(depsOf(set, home));
    r.start({ user: true }); await r.done();
    const dir = path.join(home.root, 'whisper-1.0.0'); const exe = path.join(dir, 'whisper-server.exe');
    fs.rmSync(exe);
    fs.promises.rename = async (from, to) => { if (from === dir) throw Object.assign(new Error('x'), { code: 'EBUSY' }); return orig(from, to); };
    try { r.start({ repair: ['whisper-engine'] }); await r.done(); } finally { fs.promises.rename = orig; }
    assert.strictEqual(r.status().error.code, 'locked');
    r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().state, 'ready', JSON.stringify(r.status().error));
    assert.ok(fs.existsSync(exe)); assert.strictEqual(ids(set).filter((i) => i === 'whisper-engine').length, 2);
    // 置き終えた取り直しは 1 回に数える（同じ起動の中でまた消えたら defender）
    fs.rmSync(exe); r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().error.code, 'defender'); assert.strictEqual(ids(set).filter((i) => i === 'whisper-engine').length, 2);
  } finally { fs.promises.rename = orig; await set.close(); }
});
test('取り直しの途中で回線が切れても、記録が始まっても、一時停止しても、defender にせず取り直しを続ける', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const E = require('../src/engine-fetch');
    const home = homeOf(); let fail = null; let holding = false; let r;
    r = I.makeRunner(depsOf(set, home, { hold: () => holding, sleep: async () => { holding = false; },
      fetchFile: async (pin, o) => {
        if (fail && fail.id === pin.id) { const f = fail; fail = null; f.act(); }
        return E.fetchFile(pin, o);
      } }));
    r.start({ user: true }); await r.done();
    const cancelled = () => Object.assign(new Error('x'), { code: 'cancelled' });
    const spoil = (f) => { const b = fs.readFileSync(f); b[0] ^= 0xff; fs.writeFileSync(f, b); fs.utimesSync(f, new Date(), new Date(Date.now() + 60000)); };
    // zip: 消えた exe の取り直しの最初の要求が、待てば直る失敗（net）
    const exe = path.join(home.root, 'whisper-1.0.0', 'whisper-server.exe');
    fs.rmSync(exe);
    fail = { id: 'whisper-engine', act: () => { throw Object.assign(new Error('x'), { code: 'net' }); } };
    r.start({ repair: ['whisper-engine'] }); await r.done();
    assert.strictEqual(r.status().state, 'ready', JSON.stringify(r.status().error)); assert.ok(fs.existsSync(exe));
    // ファイル: 中身の違うモデルの取り直しの途中で記録が始まる
    const wm = path.join(home.root, 'models', 'w-model.bin');
    spoil(wm);
    fail = { id: 'whisper-model', act: () => { holding = true; throw cancelled(); } };
    r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().state, 'ready', JSON.stringify(r.status().error));
    assert.ok(fs.readFileSync(wm).equals(set.bodies['whisper-model']));
    // ファイル: 取り直しの途中の［一時停止］の後に、また押す
    const vad = path.join(home.root, 'models', 'vad.bin');
    spoil(vad);
    fail = { id: 'whisper-vad', act: () => { r.pause('user'); throw cancelled(); } };
    r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().state, 'paused');
    r.start({ user: true }); await r.done();
    assert.strictEqual(r.status().state, 'ready', JSON.stringify(r.status().error));
    assert.ok(fs.readFileSync(vad).equals(set.bodies['whisper-vad']));
  } finally { await set.close(); }
});
test('使っている組の置き場所と、大文字と小文字だけが違う置き場所にも置かない（Windows では同じファイル）', IO_WAIT, async () => {
  const s1 = await smallSet(); const s2 = await smallSet({ gen: 2, sameDest: true });
  try {
    const home = homeOf();
    const a = I.makeRunner(depsOf(s1, home)); a.start({ user: true }); await a.done();
    I.setActive(home, s1.manifest, 'whisper');
    const m2 = { ...s2.manifest, items: s2.manifest.items.map((i) => (i.id === 'whisper-model' ? { ...i, dest: 'models/W-Model.bin' } : i)) };
    const b = I.makeRunner(depsOf(s2, home, { manifest: m2 })); b.start({ user: true }); await b.done();
    assert.strictEqual(b.status().error.code, 'place-in-use');
    assert.ok(!ids(s2).includes('whisper-model'));
  } finally { await s1.close(); await s2.close(); }
});

// ---------------------------------------------------------------- その4（Task 12c）: 古い版の片付けと、ライセンスの写し
// 最初の3件は計画のテストのまま。各テストに { timeout: 5000 } だけ足した（5 秒の決まり）。その後の3件は足したもの
test('RF8: 切り替えた後だけ、記録にあって今のピンにも active にも無いもの（前の版）を消す。記録に無いフォルダには触らない', IO_WAIT, async () => {
  const s1 = await smallSet(); const s2 = await smallSet({ gen: 2 });
  try {
    const home = homeOf(); const ins = () => I.readInstalled(path.join(home.root, 'installed.json'));
    const a = I.makeRunner(depsOf(s1, home)); a.start({ user: true }); await a.done();
    I.setActive(home, s1.manifest, 'whisper'); I.setActive(home, s1.manifest, 'sum');
    const b = I.makeRunner(depsOf(s2, home)); b.start({ user: true }); await b.done();
    fs.mkdirSync(path.join(home.root, 'my-own'));
    const before = await I.cleanupOld(home, s2.manifest, ins(), { canDelete: () => true });
    assert.deepStrictEqual(before.removed, [], 'まだ前の組を使っているのに消した');
    I.setActive(home, s2.manifest, 'whisper'); I.setActive(home, s2.manifest, 'sum');
    const r = await I.cleanupOld(home, s2.manifest, ins(), { canDelete: () => true });
    assert.deepStrictEqual(r.removed.sort(), ['llama-b1', 'models/w-model.bin']);
    for (const p of ['whisper-1.0.0', 'llama-b2', 'models/vad.bin', 'models/w-model-2.bin', 'models/s-model.gguf', 'my-own']) assert.ok(fs.existsSync(path.join(home.root, p)), p);
    assert.ok(!Object.values(ins().items).some((x) => x.place === 'llama-b1'), '記録から外していない');
  } finally { await s1.close(); await s2.close(); }
});
test('RF8: canDelete が偽なら何も消さない。inUse のパスは残す', IO_WAIT, async () => {
  const s1 = await smallSet(); const s2 = await smallSet({ gen: 2 });
  try {
    const home = homeOf(); const ins = () => I.readInstalled(path.join(home.root, 'installed.json'));
    const a = I.makeRunner(depsOf(s1, home)); a.start({ user: true }); await a.done();
    const b = I.makeRunner(depsOf(s2, home)); b.start({ user: true }); await b.done();
    I.setActive(home, s2.manifest, 'whisper'); I.setActive(home, s2.manifest, 'sum');
    assert.deepStrictEqual((await I.cleanupOld(home, s2.manifest, ins(), { canDelete: () => false })).removed, []);
    const llama1 = path.join(home.root, 'llama-b1');
    const r = await I.cleanupOld(home, s2.manifest, ins(), { canDelete: () => true, inUse: (p) => p === llama1 });
    assert.deepStrictEqual(r.removed, ['models/w-model.bin']); assert.ok(fs.existsSync(llama1));
  } finally { await s1.close(); await s2.close(); }
});
test('THIRD-PARTY-NOTICES.txt に各項目の名前・版・URL・ライセンスの行を書く。Apache-2.0 の全文は1回だけ。3B のときだけ Qwen の一文', { timeout: 5000 }, () => {
  const home = homeOf(); fs.mkdirSync(home.root, { recursive: true });
  I.writeNotices(home, MANIFEST);
  const t = fs.readFileSync(path.join(home.root, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  for (const it of MANIFEST.items) for (const k of [it.label, it.version, it.url, it.license]) assert.ok(t.includes(k), `${it.id}: ${k}`);
  assert.ok(/^Apache-2\.0/.test(MANIFEST.items.find((i) => i.id === 'sum-model').license), '既定の要約のモデルが Apache-2.0 でない');
  assert.strictEqual(t.split('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION').length - 1, 1, 'Apache License 2.0 の全文が1回でない');
  assert.ok(!/Gemma Terms of Use/.test(t), 'Gemma 4 に Gemma 3 までの条件を書いた');
  assert.ok(!t.includes('Qwen RESEARCH LICENSE'));
  const m3 = { ...MANIFEST, items: MANIFEST.items.map((i) => (i.id === 'sum-model' ? { ...i, dest: 'models/Qwen2.5-3B-Instruct-Q4_K_M.gguf' } : i)) };
  I.writeNotices(home, m3);
  assert.ok(fs.readFileSync(path.join(home.root, 'THIRD-PARTY-NOTICES.txt'), 'utf8').includes('Qwen is licensed under the Qwen RESEARCH LICENSE AGREEMENT'));
});
test('src/licenses/Apache-2.0.txt は https://www.apache.org/licenses/LICENSE-2.0.txt の写しのまま（書き換えない）。写しの最後にそのまま足す。Apache-2.0 の項目が無ければ足さない', { timeout: 5000 }, () => {
  const crypto = require('node:crypto');
  const b = fs.readFileSync(path.join(__dirname, '..', 'src', 'licenses', 'Apache-2.0.txt'));
  assert.strictEqual(b.length, 11358);
  assert.strictEqual(crypto.createHash('sha256').update(b).digest('hex'), 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30');
  const home = homeOf(); const f = path.join(home.root, 'THIRD-PARTY-NOTICES.txt');
  assert.strictEqual(I.writeNotices(home, MANIFEST), f);
  const t = fs.readFileSync(f, 'utf8');
  assert.ok(t.endsWith(b.toString('utf8')), '全文をそのまま最後に足していない');
  assert.ok(t.includes('llama-b11669\\LICENSE-LLVM-OpenMP'), 'libomp のライセンスの全文の置き場所の行が無い');
  assert.deepStrictEqual(fs.readdirSync(home.root), ['THIRD-PARTY-NOTICES.txt'], '一時ファイルが残った');
  const mit = { ...MANIFEST, items: MANIFEST.items.filter((i) => !/^Apache-2\.0/.test(i.license)) };
  I.writeNotices(home, mit);
  const t2 = fs.readFileSync(f, 'utf8');
  assert.ok(!t2.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'), 'Apache-2.0 の項目が無いのに全文を足した');
  assert.ok(t2.includes('LICENSE-LLVM-OpenMP'));
  assert.strictEqual(I.writeNotices({ supported: false, root: null }, MANIFEST), null);
});
test('MIT の項目があれば、MIT License の許諾の文（src/licenses/MIT.txt）を1回だけ足す。著作権の行は項目ごと。Apache-2.0 の全文は最後のまま。MIT の項目が無ければ足さない', { timeout: 5000 }, () => {
  const crypto = require('node:crypto');
  const b = fs.readFileSync(path.join(__dirname, '..', 'src', 'licenses', 'MIT.txt'));
  const mitText = b.toString('utf8');
  // 標準の MIT License の文そのまま（著作権の行は入れない。著作権の行は項目ごとの「ライセンス」の行に書く）
  assert.strictEqual(crypto.createHash('sha256').update(b).digest('hex'), MIT_SHA256);
  assert.ok(!/^\s*Copyright/im.test(mitText), 'MIT.txt に著作権の行がある');
  const words = (x) => x.replace(/\s+/g, ' ').trim();
  assert.strictEqual(words(mitText), words(MIT_STANDARD), 'MIT.txt が標準の MIT License の文でない');
  const home = homeOf(); const f = path.join(home.root, 'THIRD-PARTY-NOTICES.txt');
  I.writeNotices(home, MANIFEST);
  const t = fs.readFileSync(f, 'utf8');
  assert.strictEqual(t.split('Permission is hereby granted, free of charge').length - 1, 1, 'MIT License の許諾の文が1回でない');
  assert.ok(t.includes(mitText), 'MIT.txt をそのまま足していない');
  const apache = fs.readFileSync(path.join(__dirname, '..', 'src', 'licenses', 'Apache-2.0.txt'), 'utf8');
  assert.ok(t.endsWith(apache) && t.indexOf(mitText) < t.indexOf(apache), 'Apache License 2.0 の全文が最後でない');
  const mits = MANIFEST.items.filter((i) => /^MIT/.test(i.license));
  assert.ok(mits.length >= 4);
  for (const it of mits) assert.ok(t.includes(`  ライセンス: ${it.license}`), `${it.id}: 著作権の行が無い`);
  assert.strictEqual(t.split('  ライセンスの全文: このファイルの後ろの MIT License').length - 1, mits.length, 'MIT の項目ごとの案内の行の数が違う');
  const noMit = { ...MANIFEST, items: MANIFEST.items.filter((i) => !/^MIT/.test(i.license)) };
  I.writeNotices(home, noMit);
  const t2 = fs.readFileSync(f, 'utf8');
  assert.ok(!t2.includes('Permission is hereby granted'), 'MIT の項目が無いのに許諾の文を足した');
  assert.ok(t2.endsWith(apache));
});
test('RF8: 今のピン・残す記録・installed.json などと同じ置き場所か、その親を指す古い記録は消さない。canDelete は消す前に毎回見る', IO_WAIT, async () => {
  const s1 = await smallSet(); const s2 = await smallSet({ gen: 2 });
  try {
    const home = homeOf(); const file = path.join(home.root, 'installed.json'); const ins = () => I.readInstalled(file);
    const a = I.makeRunner(depsOf(s1, home)); a.start({ user: true }); await a.done();
    const b = I.makeRunner(depsOf(s2, home)); b.start({ user: true }); await b.done();
    I.setActive(home, s2.manifest, 'whisper'); I.setActive(home, s2.manifest, 'sum');
    const odd = { ['a'.repeat(64)]: 'models/W-MODEL-2.bin', ['b'.repeat(64)]: 'models', ['c'.repeat(64)]: '../外', ['d'.repeat(64)]: 'installed.json', ['e'.repeat(64)]: '.download' };
    const inst = ins();
    for (const [s, place] of Object.entries(odd)) inst.items[s] = { id: 'whisper-model', role: 'model', place, size: 1, mtimeMs: 0 };
    I.writeInstalled(file, inst);
    let asked = 0;
    const r = await I.cleanupOld(home, s2.manifest, ins(), { canDelete: () => ++asked === 1 });
    assert.deepStrictEqual(r.removed, ['llama-b1'], '2 回目の canDelete が偽なのに消した');
    for (const p of ['models/w-model.bin', ...Object.values(odd)]) assert.ok(r.kept.includes(p), `kept に ${p} が無い`);
    for (const p of ['models/w-model.bin', 'models/w-model-2.bin', 'models/s-model.gguf', 'models/vad.bin', 'installed.json', 'whisper-1.0.0', 'llama-b2']) assert.ok(fs.existsSync(path.join(home.root, p)), p);
    const left = ins().items;
    for (const s of Object.keys(odd)) assert.ok(left[s], `消していない記録 ${odd[s]} を外した`);
    assert.ok(Object.values(left).some((x) => x.place === 'models/w-model.bin'), '消していない記録を外した');
    const r2 = await I.cleanupOld(home, s2.manifest, ins(), { canDelete: () => true });
    assert.deepStrictEqual(r2.removed, ['models/w-model.bin']);
    for (const p of ['models/w-model-2.bin', 'models/s-model.gguf', 'installed.json']) assert.ok(fs.existsSync(path.join(home.root, p)), p);
    assert.deepStrictEqual(await I.cleanupOld({ supported: false, root: null }, s2.manifest, ins(), { canDelete: () => true }), { removed: [], kept: [] });
  } finally { await s1.close(); await s2.close(); }
});
test('組がそろうたびに THIRD-PARTY-NOTICES.txt を書き直す。書けなくても取り込みは止めない', IO_WAIT, async () => {
  const set = await smallSet();
  try {
    const home = homeOf(); const f = path.join(home.root, 'THIRD-PARTY-NOTICES.txt');
    const r = I.makeRunner(depsOf(set, home)); r.start({ user: true }); await r.done();
    const t = fs.readFileSync(f, 'utf8');
    for (const it of set.manifest.items) assert.ok(t.includes(it.url), it.id);
    assert.ok(!t.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION'));
    const home2 = homeOf(); fs.mkdirSync(path.join(home2.root, 'THIRD-PARTY-NOTICES.txt'), { recursive: true });
    const lines = [];
    const q = I.makeRunner(depsOf(set, home2, { log: (s) => lines.push(s) })); q.start({ user: true }); await q.done();
    assert.strictEqual(q.status().state, 'ready', JSON.stringify(q.status().error));
    assert.ok(lines.some((s) => s.includes('ライセンスの写し')), lines.join('\n'));
  } finally { await set.close(); }
});

// ---------------------------------------------------------------- 0.9.4 S-7（決めたこと 21）: 軽いモデル（ALT_MODELS）の取り込みと片付けの除外
test('S14: cleanupOld は ALT_MODELS の記録とファイルを消さない（前の版の記録は今どおり消す）', { timeout: 5000 }, async () => {
  const { ALT_MODELS } = require('../src/engine-manifest');
  const home = homeOf();
  fs.mkdirSync(path.join(home.root, 'models'), { recursive: true });
  const alt = ALT_MODELS[0];
  fs.writeFileSync(path.join(home.root, 'models', 'ggml-medium-q5_0.bin'), 'x');
  fs.writeFileSync(path.join(home.root, 'models', 'old-model.bin'), 'x');
  const inst = { schema: 1, consent: true, userPaused: false, active: { whisper: null, sum: null }, items: {
    [alt.sha256]: { id: alt.id, role: 'model', place: alt.dest, size: alt.size, mtimeMs: 0 },
    ['a'.repeat(64)]: { id: 'whisper-model', role: 'model', place: 'models/old-model.bin', size: 1, mtimeMs: 0 },
  } };
  I.writeInstalled(path.join(home.root, 'installed.json'), inst);
  const r = await I.cleanupOld(home, MANIFEST, I.readInstalled(path.join(home.root, 'installed.json')), { canDelete: () => true });
  assert.deepStrictEqual(r.removed, ['models/old-model.bin']);
  assert.ok(fs.existsSync(path.join(home.root, 'models', 'ggml-medium-q5_0.bin')), '軽いモデルを消した');
  assert.ok(I.readInstalled(path.join(home.root, 'installed.json')).items[alt.sha256], '軽いモデルの記録を消した');
  assert.strictEqual(I.altModelFile(home, 'medium'), path.join(home.root, 'models', 'ggml-medium-q5_0.bin'));
  assert.strictEqual(I.altModelFile(home, 'large'), null);
  assert.strictEqual(I.altModelFile({ supported: false, root: null }, 'medium'), null);
});

test('軽いモデルの取り込み（installAlt）は置き場所に置いて記録し、SHA-256 が違えば置かない', IO_WAIT, async () => {
  const { startServers } = require('./helpers/range-server');
  const { fakeRequest } = require('./helpers/fake-net');
  const crypto = require('node:crypto');
  const body = crypto.randomBytes(200000);
  const s = await startServers({ body, script: [] });
  try {
    const pin = (sha) => ({ id: 'whisper-model-medium', group: 'whisper', kind: 'file', role: 'model', alt: 'medium', url: s.originUrl, size: body.length, sha256: sha, dest: 'models/ggml-medium-q5_0.bin' });
    const home = homeOf();
    const opts = { request: fakeRequest, sleep: async () => {}, requireHttps: false, headerTimeoutMs: 2000, stallMs: 300 };
    await assert.rejects(I.installAlt(home, pin('b'.repeat(64)), opts), (e) => e.code === 'hash');
    assert.ok(!fs.existsSync(path.join(home.root, 'models', 'ggml-medium-q5_0.bin')), 'SHA-256 の違うファイルを置いた');
    const good = crypto.createHash('sha256').update(body).digest('hex');
    const rec = await I.installAlt(home, pin(good), opts);
    assert.deepStrictEqual([rec.id, rec.place, rec.size], ['whisper-model-medium', 'models/ggml-medium-q5_0.bin', body.length]);
    assert.ok(fs.readFileSync(path.join(home.root, 'models', 'ggml-medium-q5_0.bin')).equals(body));
    assert.ok(I.readInstalled(path.join(home.root, 'installed.json')).items[good]);
  } finally { await s.close(); }
});
