/*
 * stage151.gv.test.js — 0.15.1 PC の中の文字起こしを GPU 版に（計画 docs/plans/2026-11-04-151.md の「PC の中の文字起こしを GPU 版に」・Task GV-1〜GV-4。D126）
 * GV-1（F165・F167〜F173・F175）: ピン（GPU 版の組を同じ id で。上流の CPU 版を外す）・前から取り込んでいる PC の道（planInstall・statusOf・
 *       managedCandidates・cleanupOld・係）・候補の印（vulkan・runtime は同じ SHA-256 のピンの項目からだけ）・GPU で動いたかの見分け（gpuLogState。
 *       印の字は配る zip の書式: G15）・選び（gpuPlan）・印のファイルの形（normGpuState）・ドライバの鍵（driverKeyOf）・-ng（noGpuArgs）・記録の行（gpuLogLine）。
 * 題名や名前は作った物。実在の人名・社名は使わない。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const I = require('../src/engine-install');
const M = require('../src/mainlib');
const { MANIFEST, itemsOf, totalBytes } = require('../src/engine-manifest');
const { REPO, TAG_PATTERN } = require('../src/updater');

const T = { timeout: 20000 };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-GPU𠮷-'));
const ENG = () => MANIFEST.items.find((i) => i.id === 'whisper-engine');
const VAD = () => MANIFEST.items.find((i) => i.id === 'whisper-vad');
const MODEL = () => MANIFEST.items.find((i) => i.id === 'whisper-model');

// 0.15.0 までのピン（上流 whisper.cpp b5454 の CPU 版。0.15.1 GV-1 でピンから外した）。前から取り込んでいる PC の記録の形
const OLD_ENGINE = Object.freeze({
  sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb', size: 8928640, dir: 'whisper-1.9.5',
  files: [
    ['whisper-server.exe', 726016, 'a97456e747f28e7bb09c1dac35f40d94404c5ecffa74aaaaa7a3753ea6543121'],
    ['whisper.dll', 1370112, '034396d75bb5720c1851674ff64a96192b58f6927b68d334ebd254ce6cad9674'],
    ['ggml.dll', 62464, '31fe18616d872af9b6134b47a6dff8072ae4ecbe5df0273f4f8dc36766c9db8e'],
    ['ggml-base.dll', 693248, 'bede0d6b2d387236ecd2b5dd676d51c8984b5b6e0ae461a12174e9c01345c5f0'],
    ['ggml-cpu-x64.dll', 866816, '4b4b05caba40d4309b5d710ef74c59ba190516b8489f27bdb1ba11ae33c6e9d3'],
  ],
});
// G2: 配る zip（先行版 whisper-vulkan-d1be6fd）の中の 19 個から whisper-cli.exe を除いた 18 個（名前・大きさ・SHA-256。リリースの本文の表と同じ）
const GPU_FILES = [
  ['whisper-server.exe', 1064448, '5a49fed45dfb5fe1c6e3801f59fb090a323e7d606fbbcff1aa7fd62db3d781f4'],
  ['whisper.dll', 1930752, '1597ffce8a86f3c6c1cd81eb85d743e119237a25506e572fea7d238f8d1ac572'],
  ['ggml.dll', 178176, 'bc2cb5480322f9c6b35d78d6f473081be08fc346dfac647257a0086362ba45f1'],
  ['ggml-base.dll', 895488, 'bffe0d7771fafe32a0c9d309ac465f2ede0e8faf1aaf095725950a0386935932'],
  ['ggml-cpu-alderlake.dll', 1186304, '0b3f73e5772f4ec7df5f35b7ce04c56d3ee5990c4b70c6c46ad233a09568bbee'],
  ['ggml-cpu-cannonlake.dll', 1226752, '490f201c0beac11afa118c7a6fd58da06ce14ba386207a35634788e235766a0a'],
  ['ggml-cpu-cascadelake.dll', 1238016, '6cd120a64550390999eb2dc445145253c7320e83fa6b5d67a0656f3b788b2279'],
  ['ggml-cpu-haswell.dll', 1187328, '398f3059588e157d7f2ad8eedae255a91e9028b28be1b1915eddff567923384a'],
  ['ggml-cpu-icelake.dll', 1238016, 'a17635055ae03d7aeaac8967102e066ef2b1364d5e4b506f85af658bac2cc0f7'],
  ['ggml-cpu-sandybridge.dll', 1203200, '527fd298af02e6851e337162ce865e79413ebea8b86e49e00b9d824080756e72'],
  ['ggml-cpu-skylakex.dll', 1226752, '1dd10486c96c7c907bbeefc98cde4a2285bfbcce997f22c1a8e9cf762071e7e0'],
  ['ggml-cpu-sse42.dll', 1039872, 'b287ead5996a439c947b1ebc8b111ea18d7d6ccf9539abd4e9ce7db5bd7523ce'],
  ['ggml-cpu-x64.dll', 1044992, '04e0fc1fe4b223b047c705510fed8b09264189b1069388d814818b726093c450'],
  ['ggml-vulkan.dll', 45598208, 'b1229fe6f95d423e26c97bd3e4668744f03d90bec749976f4d0c6cfc2dec2d62'],
  ['vcomp140.dll', 212920, '95d4ce4a6802d1e18b5e0e1722cc30ea72ca7e033f83828f05c0b7b993fe7cbf'],
  ['LICENSE-whisper.cpp.txt', 1099, 'bcd8ec749126d45cb06737d0690295d73df4b6e7e194205bcf91190368f27285'],
  ['THIRD-PARTY-NOTICES.txt', 508, '7d269d19ae3481649e2da194313ef483553cdb9520f2bfdadf57a5f50d79eb92'],
  ['BUILD-INFO.txt', 588, '6f52d6867c04d1653af609e69613c3df6389478ebe392347af2e8dc1b3e94c35'],
];

// ---------------------------------------------------------------- ピン（決めたこと 42〜44・F169・F171）
test('GV-1・F169・F171: ピン（エンジンの項目を同じ id のまま GPU 版の組に。先行版の札は natsu-v の形でない。上流の CPU 版は無い）', () => {
  assert.deepStrictEqual(itemsOf('whisper').map((i) => i.id), ['whisper-engine', 'whisper-vad', 'whisper-model']);
  const e = ENG();
  assert.deepStrictEqual([e.group, e.kind, e.label, e.version, e.dir, e.strip, e.exe],
    ['whisper', 'zip', '文字起こしエンジン（whisper.cpp・Vulkan）', '1.9.5', 'whisper-1.9.5-vk', '', 'whisper-server.exe']);
  assert.strictEqual(e.url, `https://github.com/${REPO}/releases/download/whisper-vulkan-d1be6fd/whisper-vulkan-bin-x64-d1be6fd.zip`);
  assert.deepStrictEqual([e.size, e.sha256], [20440811, 'd3d6957113b179667eb770592a544ebc290518c30f29c7952b2b58e8f2614510']);
  assert.strictEqual(e.license, 'MIT（Copyright (c) 2023-2026 The ggml authors）。同梱の vcomp140.dll は Microsoft Visual C++ の再頒布できる部品');
  // GPU で動かせる組の印・Visual C++ ランタイムを使わない組の印は、エンジンの項目にだけある
  assert.ok(e.vulkan === true && e.runtime === 'bundled');
  for (const it of MANIFEST.items.filter((i) => i !== e)) assert.ok(!('vulkan' in it) && !('runtime' in it), it.id);
  // 札は whisper-vulkan- と頭 7 桁。アプリの更新の札（natsu-v）の形でなく、TAG_PATTERN に当たらない（F171）
  const tag = /\/releases\/download\/([^/]+)\//.exec(e.url)[1];
  assert.match(tag, /^whisper-vulkan-[0-9a-f]{7}$/);
  assert.ok(!tag.startsWith('natsu-v') && !TAG_PATTERN.test(tag), tag);
  assert.ok(!MANIFEST.items.some((i) => /ggml-org\/whisper\.cpp|whisper-bin-x64\.zip/.test(i.url)), '上流の CPU 版がピンに残っている');
  // files は 18（試験用の whisper-cli.exe を除く）。平ら（strip が空・名前に / が無い）
  assert.deepStrictEqual(e.files.map((f) => [f.name, f.size, f.sha256]), GPU_FILES);
  assert.ok(!e.files.some((f) => f.name === 'whisper-cli.exe' || f.name.includes('/')));
  assert.deepStrictEqual(e.files.filter((f) => /^ggml-cpu-.+\.dll$/.test(f.name)).length, 9);
  for (const n of ['whisper-server.exe', 'ggml-vulkan.dll', 'vcomp140.dll', 'LICENSE-whisper.cpp.txt']) assert.ok(e.files.some((f) => f.name === n), n);
  assert.strictEqual(totalBytes(e.files), 60473419);
  assert.strictEqual(totalBytes(), 595367104);
  assert.ok(Object.isFrozen(e) && Object.isFrozen(e.files[0]));
});

// ---------------------------------------------------------------- 前から取り込んでいる PC（決めたこと 45・48・F169・F170・F173・F175）
// 本物のピンの記録を、ファイルを置かずに statFn で見せる（recordMatches は大きさと更新時刻だけを見る）
function fakePc(root) {
  const stats = new Map();
  const put = (rel, size) => { stats.set(path.join(root, ...rel.split('/')), { size, mtimeMs: 1700000000000, isFile: () => true }); };
  const statFn = (p) => { const s = stats.get(p); if (!s) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return s; };
  const items = {};
  const engRec = (dir, size, files) => {
    for (const [n, s] of files) put(`${dir}/${n}`, s);
    return { id: 'whisper-engine', role: 'engine', place: dir, size, mtimeMs: 0,
      files: files.map(([name, s, sha256]) => ({ name, size: s, mtimeMs: 1700000000000, sha256 })) };
  };
  const fileRec = (it) => { put(it.dest, it.size); return { id: it.id, role: it.role, place: it.dest, size: it.size, mtimeMs: 1700000000000 }; };
  return {
    statFn, put,
    inst: (o = {}) => ({ schema: 1, consent: true, userPaused: false, items, active: { whisper: null }, ...o }),
    old: () => { items[OLD_ENGINE.sha256] = engRec(OLD_ENGINE.dir, OLD_ENGINE.size, OLD_ENGINE.files); },
    gpu: () => { items[ENG().sha256] = engRec(ENG().dir, ENG().size, GPU_FILES); },
    models: () => { items[VAD().sha256] = fileRec(VAD()); items[MODEL().sha256] = fileRec(MODEL()); },
  };
}
test('GV-1・F169・F170・F173・F175: 前から取り込んでいる PC（前のピンのエンジンの記録と今のピン）は、エンジンだけが update（約 20MB）。取る間は前の組で、印は付かない。そろうと今のピンの組に印', () => {
  const root = path.join(os.tmpdir(), 'natsu-無い𠮷', 'engine');
  const home = { supported: true, root };
  const pc = fakePc(root); pc.old(); pc.models();
  const inst = pc.inst({ active: { whisper: [OLD_ENGINE.sha256, VAD().sha256, MODEL().sha256] } });
  const plan = I.planInstall(MANIFEST, inst, pc.statFn, root);
  assert.deepStrictEqual(plan.map((p) => [p.id, p.state]), [['whisper-engine', 'update'], ['whisper-vad', 'ready'], ['whisper-model', 'ready']]);
  const cands = I.managedCandidates(home, MANIFEST, inst, pc.statFn);
  const c = cands.whisper;
  assert.ok(c && c.current === false, '前の組が候補にならない');
  assert.strictEqual(c.exe, path.join(root, 'whisper-1.9.5', 'whisper-server.exe'));
  // 前の組（上流の CPU 版）には今のピンの印を付けない（同じ id でも SHA-256 が違う: F173・F175）
  assert.strictEqual(c.vulkan, false);
  assert.strictEqual(c.runtime, '');
  const st = (p = plan) => I.statusOf({ home, manifest: MANIFEST, plan: p, candidates: cands, manual: { whisper: false }, installed: inst });
  const s = st();
  assert.deepStrictEqual([s.state, s.updateBytes, s.whisperReady, s.using.whisper, s.totalBytes], ['update', 20440811, true, 'previous', 595367104]);
  // 取り込みの途中（.part で 3MB 持っている）は残りだけ
  pc.put(`.download/${ENG().sha256}.part`, 3000000);
  assert.strictEqual(st(I.planInstall(MANIFEST, inst, pc.statFn, root)).updateBytes, 17440811);
  // GPU 版の組がそろうと、今のピンの組（current）で印が付く
  pc.gpu();
  const now = I.managedCandidates(home, MANIFEST, inst, pc.statFn).whisper;
  assert.ok(now && now.current === true);
  assert.deepStrictEqual([now.vulkan, now.runtime], [true, 'bundled']);
  assert.strictEqual(now.exe, path.join(root, 'whisper-1.9.5-vk', 'whisper-server.exe'));
  assert.strictEqual(now.checkFiles.length, 15, 'exe と DLL の 15 を照らす');
  assert.ok(!now.checkFiles.some((f) => /\.txt$/.test(f.file)));
  assert.deepStrictEqual(I.planInstall(MANIFEST, inst, pc.statFn, root).map((p) => p.state), ['ready', 'ready', 'ready']);
  // 同意していない PC（何も取り込んでいない）は今どおり missing と合計
  const none = fakePc(root);
  const ni = none.inst({ consent: false });
  const s0 = I.statusOf({ home, manifest: MANIFEST, plan: I.planInstall(MANIFEST, ni, none.statFn, root), candidates: I.managedCandidates(home, MANIFEST, ni, none.statFn),
    manual: { whisper: false }, installed: ni });
  assert.deepStrictEqual([s0.state, s0.totalBytes, s0.needBytes, s0.whisperReady], ['missing', 595367104, 595367104, false]);
});

// ---------------------------------------------------------------- 片付け（決めたこと 47・F169）
test('GV-1・F169: 片付け（GPU 版の組へ切り替えた後に前の CPU 版の置き場所を消す。GPU 版・モデル・gpu-state.json は残す。使っている間は消さない）', T, async () => {
  const root = path.join(tmp(), 'engine'); const home = { supported: true, root };
  const put = (rel, text = 'x') => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('whisper-1.9.5/whisper-server.exe'); put('whisper-1.9.5-vk/whisper-server.exe'); put('models/ggml-silero-v6.2.0.bin'); put('models/ggml-large-v3-turbo-q5_0.bin');
  put('gpu-state.json', '{"schema":1}');
  const file = path.join(root, 'installed.json');
  const inst = I.readInstalled(file);
  inst.consent = true;
  inst.items[OLD_ENGINE.sha256] = { id: 'whisper-engine', role: 'engine', place: 'whisper-1.9.5', size: 1, mtimeMs: 0, files: [{ name: 'whisper-server.exe', size: 1, mtimeMs: 0, sha256: 'a'.repeat(64) }] };
  inst.items[ENG().sha256] = { id: 'whisper-engine', role: 'engine', place: 'whisper-1.9.5-vk', size: 1, mtimeMs: 0, files: [{ name: 'whisper-server.exe', size: 1, mtimeMs: 0, sha256: 'b'.repeat(64) }] };
  inst.items[VAD().sha256] = { id: 'whisper-vad', role: 'vad', place: VAD().dest, size: 1, mtimeMs: 0 };
  inst.items[MODEL().sha256] = { id: 'whisper-model', role: 'model', place: MODEL().dest, size: 1, mtimeMs: 0 };
  // 壊れた記録が gpu-state.json を指していても、印のファイルは消さない
  inst.items['c'.repeat(64)] = { id: 'whisper-gpu-state', role: 'engine', place: 'gpu-state.json', size: 1, mtimeMs: 0 };
  inst.active = { whisper: [OLD_ENGINE.sha256, VAD().sha256, MODEL().sha256] };
  I.writeInstalled(file, inst);
  // 切り替える前（active が前の組）は何も消さない
  let r = await I.cleanupOld(home, MANIFEST, I.readInstalled(file), { canDelete: () => true });
  assert.ok(!r.removed.includes('whisper-1.9.5') && fs.existsSync(path.join(root, 'whisper-1.9.5')));
  I.setActive(home, MANIFEST, 'whisper');
  // 使っている間は消さない
  r = await I.cleanupOld(home, MANIFEST, I.readInstalled(file), { canDelete: () => true, inUse: (p) => p.includes('whisper-1.9.5') && !p.includes('-vk') });
  assert.ok(r.kept.includes('whisper-1.9.5') && fs.existsSync(path.join(root, 'whisper-1.9.5')));
  r = await I.cleanupOld(home, MANIFEST, I.readInstalled(file), { canDelete: () => true });
  assert.deepStrictEqual(r.removed, ['whisper-1.9.5']);
  assert.ok(r.kept.includes('gpu-state.json'), JSON.stringify(r));
  assert.ok(!fs.existsSync(path.join(root, 'whisper-1.9.5')));
  for (const rel of ['whisper-1.9.5-vk/whisper-server.exe', 'models/ggml-silero-v6.2.0.bin', 'models/ggml-large-v3-turbo-q5_0.bin', 'gpu-state.json']) {
    assert.ok(fs.existsSync(path.join(root, ...rel.split('/'))), rel);
  }
  assert.ok(!(OLD_ENGINE.sha256 in I.readInstalled(file).items));
});

// ---------------------------------------------------------------- 係（D21・RF13・決めたこと 45・F170）
test('GV-1・F170: 係（前から取り込んだ PC の起動の自動の開始はエンジンだけを取る（約 20MB は 100MB 以下）。同意なし・一時停止は何も取らない。記録中は待つ）', T, async () => {
  const setup = (flags) => {
    const root = path.join(tmp(), 'engine'); const home = { supported: true, root };
    const file = path.join(root, 'installed.json');
    const inst = I.readInstalled(file);
    Object.assign(inst, flags);
    inst.items[OLD_ENGINE.sha256] = { id: 'whisper-engine', role: 'engine', place: OLD_ENGINE.dir, size: OLD_ENGINE.size, mtimeMs: 0, files: [] };
    for (const it of [VAD(), MODEL()]) {
      const f = path.join(root, ...it.dest.split('/'));
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.closeSync(fs.openSync(f, 'w')); fs.truncateSync(f, it.size);   // 中身の無い（疎な）ファイル。大きさと更新時刻だけを記録と合わせる
      const s = fs.statSync(f);
      inst.items[it.sha256] = { id: it.id, role: it.role, place: it.dest, size: s.size, mtimeMs: s.mtimeMs };
    }
    inst.active = { whisper: [OLD_ENGINE.sha256, VAD().sha256, MODEL().sha256] };
    I.writeInstalled(file, inst);
    return home;
  };
  const runOf = (home, more = {}) => {
    const got = [];
    const r = I.makeRunner({ home, manifest: MANIFEST, request: () => { throw new Error('通信しない'); }, sleep: async () => {}, waitMs: 1,
      statfs: async () => ({ bavail: 1e6, bsize: 1e6 }),
      fetchFile: async (it) => { got.push(it.id); throw Object.assign(new Error('試験: ここで止める'), { code: 'gone' }); }, ...more });
    return { r, got };
  };
  const a = runOf(setup({ consent: true, userPaused: false }));
  assert.deepStrictEqual(I.planInstall(MANIFEST, I.readInstalled(path.join(a.r.status().root, 'installed.json')), fs.statSync, a.r.status().root).map((p) => p.state),
    ['update', 'ready', 'ready']);
  a.r.start({ auto: true }); await a.r.done();
  assert.deepStrictEqual(a.got, ['whisper-engine'], '前から取り込んだ PC の起動のときに GPU 版だけを取らない');
  for (const flags of [{ consent: false, userPaused: false }, { consent: true, userPaused: true }]) {
    const b = runOf(setup(flags));
    b.r.start({ auto: true }); await b.r.done();
    assert.deepStrictEqual(b.got, [], `取った: ${JSON.stringify(flags)}`);
  }
  // 記録中は要求を出さずに held で待ち、終われば取る
  let holding = true; let polls = 0; const states = [];
  const c = runOf(setup({ consent: true, userPaused: false }), {
    hold: () => holding, onState: (s) => states.push(s.state), holdPollMs: 1,
    sleep: async () => { if (++polls === 3) { assert.deepStrictEqual(c.got, []); holding = false; } } });
  c.r.start({ auto: true }); await c.r.done();
  assert.ok(states.includes('held'), states.join(','));
  assert.deepStrictEqual(c.got, ['whisper-engine']);
});

// ---------------------------------------------------------------- 見分け（決めたこと 50・G15・F165）
test('GV-1・F165: GPU_LOG_MARKS の書式の字は、配る zip の DLL の中の書式（G15）と同じ', () => {
  const K = M.GPU_LOG_MARKS;
  assert.ok(Object.isFrozen(K) && Object.isFrozen(K.formats) && Object.isFrozen(K.lost));
  assert.deepStrictEqual(K.formats, {
    'whisper.dll': ['whisper_backend_init_gpu', '%s: using %s backend', '%s: failed to initialize %s backend', '%s: no GPU found', '%s: use gpu    = %d'],
    'ggml-vulkan.dll': ['ggml_vulkan: %zu = %s (%s) | uma: %d', 'ggml_vulkan: device lost on %s', 'ErrorDeviceLost'],
  });
  assert.deepStrictEqual([K.using, K.failed, K.noGpu, K.lost, K.device, K.deviceEnd],
    ['whisper_backend_init_gpu: using Vulkan', 'whisper_backend_init_gpu: failed to initialize', 'whisper_backend_init_gpu: no GPU found',
      ['ggml_vulkan: device lost on', 'ErrorDeviceLost'], 'ggml_vulkan: ', ' | uma:']);
  assert.deepStrictEqual(M.GPU_WHY, ['none', 'init-failed', 'start-failed', 'lost', 'left-trying']);
});
test('GV-1・F165: gpuLogState の表（行の見本は G15 の書式から作る。落ちた行と失敗の行を先に見る。ほかの部品の failed to initialize は拾わない）', () => {
  const S = (lines) => M.gpuLogState(lines);
  const DEV = 'ggml_vulkan: 0 = Intel(R) Iris(R) Xe Graphics (Intel Corporation) | uma: 1 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 32768 | int dot: 1 | matrix cores: none';
  const USING = 'whisper_backend_init_gpu: using Vulkan0 backend';
  assert.deepStrictEqual(S(['ggml_vulkan: Found 1 Vulkan devices:', DEV, 'whisper_init_with_params_no_state: use gpu    = 1', USING]),
    { state: 'gpu', device: 'Intel(R) Iris(R) Xe Graphics' });
  assert.deepStrictEqual(S([USING]), { state: 'gpu', device: '' });
  assert.deepStrictEqual(S([`${USING}\r`]), { state: 'gpu', device: '' }, 'Windows の行の終わり');
  assert.strictEqual(S([DEV, USING, 'whisper_backend_init_gpu: failed to initialize Vulkan0 backend']).state, 'init-failed');
  assert.strictEqual(S([USING, 'ggml_vulkan: device lost on Vulkan0']).state, 'lost');
  assert.strictEqual(S([USING, 'ggml_vulkan: device lost on Vulkan0, likely caused by previous submission (nodes 3 to 9):']).state, 'lost');
  assert.strictEqual(S([USING, 'terminate called: vk::DeviceLostError: vk::Queue::submit: ErrorDeviceLost']).state, 'lost');
  assert.strictEqual(S(['whisper_backend_init_gpu: failed to initialize Vulkan0 backend', 'ggml_vulkan: device lost on Vulkan0']).state, 'lost');
  for (const lines of [['whisper_backend_init_gpu: no GPU found'], [], ['load_backend: loaded CPU backend from C:\\x\\ggml-cpu-haswell.dll'],
    ['whisper_backend_init_gpu: usi'], ['whisper_backend_init_gpu: using'], [''], [null, 3, {}], ['  whisper_backend_init_gpu: using Vulkan0 backend x'.slice(0, 20)]]) {
    assert.strictEqual(S(lines).state, 'none', JSON.stringify(lines));
  }
  for (const v of [null, undefined, 'whisper_backend_init_gpu: using Vulkan0 backend', 3, {}]) assert.strictEqual(S(v).state, 'none', String(v));
  // ほかの部品の行（ggml の backend の読み込み・VAD）は GPU の失敗と見ない
  assert.strictEqual(S([USING, 'ggml_backend_load_best: failed to initialize backend from C:\\x\\ggml-y.dll: ggml_backend_init returned NULL']).state, 'gpu');
  assert.strictEqual(S([USING, 'whisper_vad_init_with_params: failed to initialize VAD context']).state, 'gpu');
  // 装置の名前に括弧の無い形・名前に括弧のある形
  assert.strictEqual(S(['ggml_vulkan: 0 = AMD Radeon Graphics | uma: 1 | fp16: 1', USING]).device, 'AMD Radeon Graphics');
  assert.strictEqual(S(['ggml_vulkan: 0 = NVIDIA GeForce RTX 3050 (NVIDIA) | uma: 0', 'ggml_vulkan: 1 = Intel(R) UHD Graphics (Intel Corporation) | uma: 1', USING]).device,
    'NVIDIA GeForce RTX 3050');
  // 名前は whisper が使った装置（using Vulkan<番号>）の行から
  assert.strictEqual(S(['ggml_vulkan: 0 = NVIDIA GeForce RTX 3050 (NVIDIA) | uma: 0', 'ggml_vulkan: 1 = Intel(R) UHD Graphics (Intel Corporation) | uma: 1',
    'whisper_backend_init_gpu: using Vulkan1 backend']).device, 'Intel(R) UHD Graphics');
});

// ---------------------------------------------------------------- 選び（決めたこと 49・51・52・F167・F168・F173）
test('GV-1・F167・F168・F173: gpuPlan の表（GPU の形は Windows・取り込んだ組・vulkan の印・印無しのときだけ。印は同じ鍵にだけ効き、鍵が変われば試し直す）', () => {
  const ST = (o = {}) => ({ schema: 1, driver: '', bad: null, trying: null, ...o });
  const BAD = (why = 'none') => ({ why, code: null, at: '2026-11-09T01:02:03.000Z' });
  const P = (o = {}) => M.gpuPlan({ platform: 'win32', manual: false, vulkan: true, driver: 'Intel(R) Iris(R) Xe Graphics=32.0.101.7085', state: ST(), ...o });
  assert.deepStrictEqual(P(), { use: 'gpu', why: '', retry: false });
  assert.deepStrictEqual(P({ manual: true }), { use: 'plain', why: 'manual', retry: false });
  assert.deepStrictEqual(P({ vulkan: false }), { use: 'plain', why: 'no-set', retry: false });
  assert.deepStrictEqual(P({ platform: 'linux' }), { use: 'plain', why: 'platform', retry: false });
  assert.deepStrictEqual(P({ manual: true, state: ST({ trying: 'k' }) }), { use: 'plain', why: 'manual', retry: false }, '手のパスは印を見ない');
  const key = 'Intel(R) Iris(R) Xe Graphics=32.0.101.7085';
  for (const why of ['none', 'init-failed', 'start-failed', 'lost', 'left-trying']) {
    assert.deepStrictEqual(P({ state: ST({ driver: key, bad: BAD(why) }) }), { use: 'cpu', why, retry: false }, why);
  }
  assert.deepStrictEqual(P({ state: ST({ driver: 'Intel(R) Iris(R) Xe Graphics=31.0.101.5000', bad: BAD('lost') }) }), { use: 'gpu', why: '', retry: true });
  assert.deepStrictEqual(P({ state: ST({ driver: key }) }), { use: 'gpu', why: '', retry: false }, '印の無い同じ鍵');
  assert.deepStrictEqual(P({ state: ST({ trying: key }) }), { use: 'cpu', why: 'left-trying', retry: false });
  assert.deepStrictEqual(P({ state: ST({ trying: 'other', driver: 'x', bad: BAD('none') }) }), { use: 'cpu', why: 'left-trying', retry: false });
  // 鍵 unknown も1つの鍵として同じに扱う
  assert.deepStrictEqual(P({ driver: 'unknown', state: ST({ driver: 'unknown', bad: BAD('init-failed') }) }), { use: 'cpu', why: 'init-failed', retry: false });
  assert.deepStrictEqual(P({ driver: key, state: ST({ driver: 'unknown', bad: BAD('init-failed') }) }), { use: 'gpu', why: '', retry: true });
  assert.deepStrictEqual(P({ state: undefined }), { use: 'gpu', why: '', retry: false });
});

// ---------------------------------------------------------------- 印のファイルの形（決めたこと 51・F167）
test('GV-1・F167: normGpuState（項目ごとに照らし、形の悪い項目だけ既定に戻す。知らない理由の符号・長すぎる字・組でない bad。null・配列・違う schema は既定）', () => {
  const N = (raw) => M.normGpuState(raw);
  const DEF = { schema: 1, driver: '', bad: null, trying: null };
  const bad = { why: 'lost', code: 3221225477, at: '2026-11-09T01:02:03.000Z' };
  const good = { schema: 1, driver: 'GPU=1.2.3', bad, trying: null };
  assert.deepStrictEqual(N(good), { state: good, repaired: false });
  assert.deepStrictEqual(N({ ...good, bad: { ...bad, code: null }, trying: 'GPU=1.2.3' }), { state: { ...good, bad: { ...bad, code: null }, trying: 'GPU=1.2.3' }, repaired: false });
  assert.deepStrictEqual(N(null), { state: DEF, repaired: false });
  assert.deepStrictEqual(N(undefined), { state: DEF, repaired: false });
  for (const raw of [[], [good], 'x', 3, { ...good, schema: 2 }, { driver: 'GPU=1.2.3' }]) assert.deepStrictEqual(N(raw), { state: DEF, repaired: true }, JSON.stringify(raw));
  for (const why of ['files', 'LOST', '', 'manual', 'no-set']) {
    assert.deepStrictEqual(N({ ...good, bad: { ...bad, why } }), { state: { ...good, bad: null }, repaired: true }, why);
  }
  for (const b of ['lost', 3, [], { ...bad, code: 1.5 }, { ...bad, code: '1' }, { ...bad, at: 'きのう' }, { ...bad, at: 3 }, { ...bad, at: '2026-13-40T99:00:00.000Z' }]) {
    assert.deepStrictEqual(N({ ...good, bad: b }), { state: { ...good, bad: null }, repaired: true }, JSON.stringify(b));
  }
  assert.deepStrictEqual(N({ ...good, driver: 'x'.repeat(201) }), { state: { ...good, driver: '' }, repaired: true });
  assert.deepStrictEqual(N({ ...good, driver: 'x'.repeat(200) }).repaired, false);
  assert.deepStrictEqual(N({ ...good, driver: 3 }), { state: { ...good, driver: '' }, repaired: true });
  assert.deepStrictEqual(N({ ...good, trying: 'x'.repeat(201) }), { state: good, repaired: true });
  assert.deepStrictEqual(N({ ...good, trying: '' }), { state: good, repaired: true });
  assert.deepStrictEqual(N({ ...good, trying: 5 }), { state: good, repaired: true });
  assert.deepStrictEqual(N({ ...good, extra: 1 }), { state: good, repaired: false }, '知らない項目は読み捨てる');
});

// ---------------------------------------------------------------- ドライバの鍵（決めたこと 52）
test('GV-1: driverKeyOf（reg.exe query の答えから、表示アダプターの DriverDesc と DriverVersion の組を鍵にする。読めなければ unknown と 不明）', () => {
  const CLS = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
  const one = [`\r\n${CLS}\\0000\r\n    DriverDesc    REG_SZ    Intel(R) Iris(R) Xe Graphics\r\n`, `\r\nEnd of search: 1 match(es) found.\r\n`,
    `\r\n${CLS}\\0000\r\n    DriverVersion    REG_SZ    32.0.101.7085\r\n\r\nEnd of search: 1 match(es) found.\r\n`].join('');
  assert.deepStrictEqual(M.driverKeyOf(one), { key: 'Intel(R) Iris(R) Xe Graphics=32.0.101.7085', version: '32.0.101.7085' });
  const two = `${CLS}\\0000\n    DriverDesc    REG_SZ    Intel(R) UHD Graphics\n    DriverVersion    REG_SZ    31.0.101.2125\n\n`
    + `${CLS}\\0001\n    DriverDesc    REG_SZ    NVIDIA GeForce RTX 3050 Laptop GPU\n    DriverVersion    REG_SZ    32.0.15.6094\n`;
  assert.deepStrictEqual(M.driverKeyOf(two), { key: 'Intel(R) UHD Graphics=31.0.101.2125;NVIDIA GeForce RTX 3050 Laptop GPU=32.0.15.6094', version: '31.0.101.2125、32.0.15.6094' });
  assert.deepStrictEqual(M.driverKeyOf(`${CLS}\\0000\n    DriverDesc    REG_SZ    Microsoft Basic Display Adapter\n`), { key: 'Microsoft Basic Display Adapter=', version: '不明' });
  for (const t of ['', 'ERROR: The system was unable to find the specified registry key or value.', null, 3]) {
    assert.deepStrictEqual(M.driverKeyOf(t), { key: 'unknown', version: '不明' }, String(t));
  }
  const long = Array.from({ length: 9 }, (_, i) => `${CLS}\\000${i}\n    DriverDesc    REG_SZ    Virtual Display Adapter Number ${i}\n    DriverVersion    REG_SZ    10.0.${i}\n`).join('');
  const k = M.driverKeyOf(long).key;
  assert.ok(k.length <= 200 && k !== M.driverKeyOf(long.replace('10.0.8', '10.0.9')).key, k);
  assert.strictEqual(M.driverVersionOf('Intel(R) UHD Graphics=31.0.101.2125;NVIDIA GeForce RTX 3050 Laptop GPU=32.0.15.6094'), '31.0.101.2125、32.0.15.6094');
  assert.strictEqual(M.driverVersionOf('unknown'), '不明');
  assert.strictEqual(M.driverVersionOf(''), '不明');
});

// ---------------------------------------------------------------- -ng（決めたこと 49・F165）
test('GV-1・F165: noGpuArgs（今の引数の終わりに -ng を1つ足す。ほかの引数は1字も同じ。もう -ng があれば足さない。もとの配列を変えない）', () => {
  const args = ['-m', 'models\\m.bin', '--host', '127.0.0.1', '--port', '8178', '-t', '10', '-l', 'ja', '-sns', '--vad', '--vad-model', 'models\\vad.bin'];
  const before = args.slice();
  const out = M.noGpuArgs(args);
  assert.deepStrictEqual(out, [...before, '-ng']);
  assert.deepStrictEqual(args, before);
  assert.ok(out !== args);
  assert.deepStrictEqual(M.noGpuArgs([...before, '-ng']), [...before, '-ng']);
  assert.deepStrictEqual(M.noGpuArgs([]), ['-ng']);
});

// ---------------------------------------------------------------- 記録の行（決めたこと 55・F172）
test('GV-1・F172: gpuLogLine（決めたこと 55 の4つの形。理由の符号は決まった5つだけ。パスの形を書かない）', () => {
  const L = M.gpuLogLine;
  assert.strictEqual(L('gpu', { device: 'Intel(R) Iris(R) Xe Graphics', version: '32.0.101.7085' }), '文字起こしの計算: GPU（Intel(R) Iris(R) Xe Graphics・ドライバ 32.0.101.7085）');
  assert.strictEqual(L('switch', { why: 'none', version: '32.0.101.7085' }),
    '文字起こしの計算: CPU に切り替えました（理由 none・ドライバ 32.0.101.7085）。このドライバの版では次から CPU で動かします');
  assert.strictEqual(L('switch', { why: 'lost', version: '32.0.101.7085', code: 3221225477 }),
    '文字起こしの計算: CPU に切り替えました（理由 lost・ドライバ 32.0.101.7085・終了コード 3221225477）。このドライバの版では次から CPU で動かします');
  assert.strictEqual(L('marked', { why: 'init-failed' }), '文字起こしの計算: CPU（このドライバの版では前に GPU を使えませんでした: 理由 init-failed）');
  assert.strictEqual(L('driver', { prev: '31.0.101.5000', version: '32.0.101.7085' }),
    '文字起こしの計算: ドライバの版が変わったので、GPU をもう一度試します（31.0.101.5000 → 32.0.101.7085）');
  assert.strictEqual(L('switch', { why: 'start-failed' }), '文字起こしの計算: CPU に切り替えました（理由 start-failed・ドライバ 不明）。このドライバの版では次から CPU で動かします');
  for (const why of M.GPU_WHY) assert.ok(L('switch', { why, version: '1' }).includes(`理由 ${why}`), why);
  for (const why of ['files', 'manual', '', undefined, 'none; rm']) {
    assert.strictEqual(L('switch', { why, version: '1' }), '', String(why));
    assert.strictEqual(L('marked', { why }), '', String(why));
  }
  assert.strictEqual(L('other', { why: 'none' }), '');
  assert.strictEqual(L('switch', { why: 'lost', version: '1', code: 1.5 }), '文字起こしの計算: CPU に切り替えました（理由 lost・ドライバ 1）。このドライバの版では次から CPU で動かします');
  // どの行にもパスの形（\・/・:\）が無い。名前や版に混ざっても書かない
  const lines = [
    L('gpu', { device: 'C:\\Users\\試験𠮷\\AppData\\Local\\natsu\\engine\\whisper-1.9.5-vk', version: '/home/試験/x' }),
    L('switch', { why: 'lost', version: 'C:\\Windows\\System32', code: 1 }),
    L('driver', { prev: 'D:\\x', version: 'a/b' }),
    L('gpu', { device: 'GPU\r\n文字起こしの計算: GPU（偽）', version: '1' }),
  ];
  for (const l of lines) {
    assert.ok(l.startsWith('文字起こしの計算: '), l);
    assert.ok(!/[\\/]|:\\|[\r\n]/.test(l), l);
  }
  assert.strictEqual(L('gpu', { device: '', version: '' }), '文字起こしの計算: GPU（不明・ドライバ 不明）');
});
