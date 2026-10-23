/*
 * stage100.summary.retire.test.js — 0.10.0 Task LS-4（D59・決めたこと 107・108。計画 docs/plans/2026-10-20-100.md）:
 * 0.9.x で取り込んだ要約のエンジンとモデルを、管理しているフォルダのちょうどその名前と大きさのものだけ消す（engine-install.retireSum）。
 * 手の設定のパス・whisper・VAD・表に無い名前には触らない。使用中は残して次の呼び出しで消す。知らせは1回（main・mainrun の場面）。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const I = require('../src/engine-install');
const { execSceneSync, sceneTimeout } = require('./helpers/scene-slots');

const T = { timeout: 10000 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-消す𠮷-'));
// 試しの小さな表（本物の RETIRED と同じ形。数 GB のファイルを作らない）
const SMALL = Object.freeze({ dir: 'llama-b11669', files: Object.freeze([['llama-server.exe', 900], ['llama.dll', 2500], ['LICENSE-LLVM-OpenMP', 70]]),
  model: Object.freeze({ dest: 'models/gemma-4-E4B-it-Q4_K_M.gguf', size: 6000 }), ids: Object.freeze(['sum-engine', 'sum-model']) });
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// 0.9.x の形の置き場所: whisper の組・VAD・whisper のモデル・要約の組（llama のフォルダと gemma のモデル）・利用者のファイル・installed.json
function seed(root) {
  const put = (rel, n) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(n, 7)); return f; };
  const keep = {
    'whisper-1.9.5/whisper-server.exe': put('whisper-1.9.5/whisper-server.exe', 300),
    'models/ggml-silero-v6.2.0.bin': put('models/ggml-silero-v6.2.0.bin', 200),
    'models/ggml-large-v3-turbo-q5_0.bin': put('models/ggml-large-v3-turbo-q5_0.bin', 400),
    'llama-b11669/my-notes.txt': put('llama-b11669/my-notes.txt', 10),           // 表に無い名前（利用者のファイル）
  };
  for (const [n, size] of SMALL.files) put(`${SMALL.dir}/${n}`, size);
  put(SMALL.model.dest, SMALL.model.size);
  const inst = I.readInstalled(path.join(root, 'installed.json'));
  inst.consent = true;
  inst.items[sha('w')] = { id: 'whisper-engine', role: 'engine', place: 'whisper-1.9.5', size: 1, mtimeMs: 0, files: [] };
  inst.items[sha('s')] = { id: 'sum-engine', role: 'engine', place: SMALL.dir, size: 1, mtimeMs: 0, files: [] };
  inst.items[sha('m')] = { id: 'sum-model', role: 'model', place: SMALL.model.dest, size: SMALL.model.size, mtimeMs: 0 };
  I.writeInstalled(path.join(root, 'installed.json'), inst);
  const bytes = {};
  for (const [rel, f] of Object.entries(keep)) bytes[rel] = fs.readFileSync(f);
  return { keep, bytes };
}

test('決めたこと 107: 本物の表 RETIRED は 0.9.x の llama-b11669 の 23 個（合計 44,353,821 バイト）と gemma のモデル（4,977,171,584 バイト）', T, () => {
  const R = I.RETIRED;
  assert.strictEqual(R.dir, 'llama-b11669');
  assert.strictEqual(R.files.length, 23);
  assert.strictEqual(R.files.reduce((a, [, n]) => a + n, 0), 44353821);
  assert.ok(R.files.some(([n]) => n === 'llama-server.exe') && R.files.some(([n]) => n === 'LICENSE-LLVM-OpenMP'));
  assert.deepStrictEqual(R.model, { dest: 'models/gemma-4-E4B-it-Q4_K_M.gguf', size: 4977171584 });
  assert.ok(Object.isFrozen(R) && Object.isFrozen(R.files));
});

test('D59・決めたこと 107: 表の名前と大きさの要約のファイルだけを消し、空になったフォルダを消し、installed.json から sum の組を外し、消した大きさを返す。whisper・VAD・利用者のファイルは1バイトも変わらない', T, async () => {
  const root = path.join(tmp(), 'engine');
  const { keep, bytes } = seed(root);
  const r = await I.retireSum({ supported: true, root }, { table: SMALL });
  assert.strictEqual(r.left, 0);
  assert.strictEqual(r.bytes, 900 + 2500 + 70 + 6000);
  assert.strictEqual(r.removed.length, 4);
  for (const [n] of SMALL.files) assert.ok(!fs.existsSync(path.join(root, SMALL.dir, n)), n);
  assert.ok(!fs.existsSync(path.join(root, ...SMALL.model.dest.split('/'))), '要約のモデルが残った');
  for (const [rel, f] of Object.entries(keep)) assert.deepStrictEqual(fs.readFileSync(f), bytes[rel], `${rel} が変わった`);
  assert.ok(fs.existsSync(path.join(root, SMALL.dir)), '利用者のファイルのあるフォルダを消した');
  const inst = I.readInstalled(path.join(root, 'installed.json'));
  assert.deepStrictEqual(Object.values(inst.items).map((x) => x.id), ['whisper-engine'], 'installed.json に sum の組が残った');
  assert.strictEqual(inst.consent, true);
  // もう一度呼んでも何もしない（消すものが無い）
  const again = await I.retireSum({ supported: true, root }, { table: SMALL });
  assert.deepStrictEqual([again.removed.length, again.bytes, again.left], [0, 0, 0]);
});

test('決めたこと 107: 利用者のファイルが無ければ、空になった llama-b11669 のフォルダも消す。大きさが表と違うファイルは消さない', T, async () => {
  const root = path.join(tmp(), 'engine');
  seed(root);
  fs.rmSync(path.join(root, SMALL.dir, 'my-notes.txt'));
  fs.writeFileSync(path.join(root, SMALL.dir, 'llama.dll'), Buffer.alloc(2501, 1));   // 大きさが表と違う
  const r = await I.retireSum({ supported: true, root }, { table: SMALL });
  assert.ok(fs.existsSync(path.join(root, SMALL.dir, 'llama.dll')), '大きさの違うファイルを消した');
  assert.ok(fs.existsSync(path.join(root, SMALL.dir)));
  assert.strictEqual(r.left, 0);
  fs.rmSync(path.join(root, SMALL.dir, 'llama.dll'));
  await I.retireSum({ supported: true, root }, { table: SMALL });
  assert.ok(!fs.existsSync(path.join(root, SMALL.dir)), '空になったフォルダを消していない');
});

test('決めたこと 107: 手の設定のパス（管理しているフォルダの外の llama-server.exe と .gguf・管理しているフォルダの中を指したもの）は残る', T, async () => {
  const d = tmp(); const root = path.join(d, 'engine');
  seed(root);
  const outExe = path.join(d, 'llm', 'llama-server.exe'); const outModel = path.join(d, 'llm', 'gemma-4-E4B-it-Q4_K_M.gguf');
  fs.mkdirSync(path.dirname(outExe), { recursive: true });
  fs.writeFileSync(outExe, Buffer.alloc(900, 1)); fs.writeFileSync(outModel, Buffer.alloc(6000, 1));
  const inside = path.join(root, SMALL.dir, 'llama-server.exe');
  const r = await I.retireSum({ supported: true, root }, { table: SMALL, manual: [outExe, outModel, inside.toUpperCase()] });
  assert.ok(fs.existsSync(outExe) && fs.existsSync(outModel), '外の手の設定のファイルを消した');
  assert.ok(fs.existsSync(inside), '手の設定が指す管理しているフォルダの中のファイルを消した');
  assert.strictEqual(r.left, 0);
  assert.ok(!fs.existsSync(path.join(root, SMALL.dir, 'llama.dll')));
});

test('決めたこと 107: 使用中（unlink が EBUSY・EPERM）のファイルは残し、数を返す。次の呼び出しで消す。取り込めない PC は何もしない', T, async () => {
  const root = path.join(tmp(), 'engine');
  seed(root);
  let busy = true;
  const fake = { ...fs, promises: { ...fs.promises, unlink: async (f) => {
    if (busy && /llama\.dll$|\.gguf$/.test(f)) throw Object.assign(new Error('busy'), { code: /gguf$/.test(f) ? 'EPERM' : 'EBUSY' });
    return fs.promises.unlink(f);
  } } };
  const r = await I.retireSum({ supported: true, root }, { table: SMALL, fs: fake });
  assert.strictEqual(r.left, 2);
  assert.deepStrictEqual(r.codes, ['EBUSY', 'EPERM']);
  assert.ok(fs.existsSync(path.join(root, SMALL.dir, 'llama.dll')));
  assert.ok(Object.values(I.readInstalled(path.join(root, 'installed.json')).items).some((x) => x.id === 'sum-model'), '残したのに記録を外した');
  busy = false;
  const r2 = await I.retireSum({ supported: true, root }, { table: SMALL, fs: fake });
  assert.strictEqual(r2.left, 0);
  assert.strictEqual(r2.bytes, 2500 + 6000);
  assert.ok(!fs.existsSync(path.join(root, SMALL.dir, 'llama.dll')));
  assert.deepStrictEqual(await I.retireSum({ supported: false, root: null }, { table: SMALL }), { removed: [], bytes: 0, left: 0, codes: [] });
});

test('決めたこと 107: 片付け（cleanupOld）は要約の組の置き場所を消さない（消すのは retireSum だけ。知らせと使用中の扱いを1か所にする）', T, async () => {
  const root = path.join(tmp(), 'engine');
  seed(root);
  const { MANIFEST } = require('../src/engine-manifest');
  const r = await I.cleanupOld({ supported: true, root }, MANIFEST, I.readInstalled(path.join(root, 'installed.json')), { canDelete: () => true });
  assert.ok(!r.removed.includes(SMALL.dir) && !r.removed.includes(SMALL.model.dest), JSON.stringify(r));
  assert.ok(fs.existsSync(path.join(root, SMALL.dir, 'llama.dll')));
});

// ---------------------------------------------------------------- main（偽の Electron の上）
const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const runMain = (args) => JSON.parse(execSceneSync(process.execPath, [RUN, 'text', '--idle', ...args], { timeout: 25000, maxBuffer: 1 << 24, encoding: 'utf8' }).trim().split('\n').pop());
const NOTICE = /^要約用の AI は使わなくなったので、PC から消しました（約 \d+\.\d GB 空きました）。文字起こし用はそのままです。$/;
const textOf = (x) => (typeof x === 'string' ? x : (x && x.text) || '');

test('D59・決めたこと 108: 起動の後に1回消して知らせる（2回目の起動では知らせない）。消すものが無い PC には知らせない', { timeout: sceneTimeout(60000) }, () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-ud-'));
  try {
    const a = runMain(['--retired-sum', `--keep-user-data=${ud}`]);
    assert.strictEqual(a.notices.filter((n) => NOTICE.test(textOf(n))).length, 1, JSON.stringify(a.notices));
    assert.ok(a.engineLog.some((l) => /^要約のエンジンを消す: 消した 4・残り 0$/.test(l)), a.engineLog.join('\n'));
    assert.strictEqual(a.savedSettings.retiredSumNotified, true);
    const b = runMain(['--retired-sum', `--keep-user-data=${ud}`]);
    assert.strictEqual(b.notices.filter((n) => NOTICE.test(textOf(n))).length, 0, '2回目の起動でも知らせた');
    const c = runMain([]);
    assert.ok(!c.notices.some((n) => /要約用の AI/.test(textOf(n))), '消すものが無いのに知らせた');
  } finally { fs.rmSync(ud, { recursive: true, force: true }); }
});

// CI run 39924135937（7fe04b4）の test (windows-latest)・electron-smoke: 取り込める PC で消すものが無いのに retiredSumNotified を書き、
// 「起動だけで settings.json を書き換えない」（stage090 F12）が赤になった。消すものが無ければ何も書かない（毎回の起動で小さく探すだけ）
test('D59・決めたこと 108: 取り込める PC で消すものが無ければ、settings.json に印を書かず、知らせも記録も出さない', { timeout: sceneTimeout(60000) }, () => {
  const o = runMain(['--retired-sum=none']);
  assert.notStrictEqual(o.savedSettings.retiredSumNotified, true, '消すものが無いのに印を書いた（起動だけで settings.json を書き換える）');
  assert.ok(!o.notices.some((n) => /要約用の AI/.test(textOf(n))), JSON.stringify(o.notices));
  assert.ok(!o.engineLog.some((l) => l.startsWith('要約のエンジンを消す')), o.engineLog.join('\n'));
});
