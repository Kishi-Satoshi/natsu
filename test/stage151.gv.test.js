/*
 * stage151.gv.test.js — 0.15.1 PC の中の文字起こしを GPU 版に（計画 docs/plans/2026-11-04-151.md の「PC の中の文字起こしを GPU 版に」・Task GV-1〜GV-4。D126）
 * GV-1（F165・F169〜F173・F175）: ピン（GPU 版の組を同じ id で。上流の CPU 版を外す）・前から取り込んでいる PC の道（planInstall・statusOf・
 *       managedCandidates・cleanupOld・係）・候補の印（vulkan・runtime は同じ SHA-256 のピンの項目からだけ）・GPU で動いたかの見分け（gpuLogState。
 *       印の字は配る zip の書式: G15）・記録の行（gpuLogLine）。
 * GV-2b（第9版。F165・F166・F169・F172・F173・F177）: CPU の形（-ng）への切り替え・試している印・ドライバの版ごとの印を外し、取り込んだ GPU 版の組を
 *       いつも今の引数のまま起こす。GPU で動いたかは engine.log の「文字起こしの計算:」の1行だけ。落ちた・起きないは今の「エンジンが起きない」と同じ。
 *       第8版の形を守っていたテスト 9（GV-1「gpuPlan の表」「normGpuState」「driverKeyOf」「noGpuArgs」・GV-2「黙って CPU で動く GPU の形…」
 *       「会議の途中で GPU の形が落ちる…」「-ng でも起きない」「試している印が残っている起動」「ドライバの版が変わった起動」）は GV-2b で消した。
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
test('GV-1・F169: 片付け（GPU 版の組へ切り替えた後に前の CPU 版の置き場所を消す。GPU 版・モデルは残す。使っている間は消さない）', T, async () => {
  const root = path.join(tmp(), 'engine'); const home = { supported: true, root };
  const put = (rel, text = 'x') => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  put('whisper-1.9.5/whisper-server.exe'); put('whisper-1.9.5-vk/whisper-server.exe'); put('models/ggml-silero-v6.2.0.bin'); put('models/ggml-large-v3-turbo-q5_0.bin');
  const file = path.join(root, 'installed.json');
  const inst = I.readInstalled(file);
  inst.consent = true;
  inst.items[OLD_ENGINE.sha256] = { id: 'whisper-engine', role: 'engine', place: 'whisper-1.9.5', size: 1, mtimeMs: 0, files: [{ name: 'whisper-server.exe', size: 1, mtimeMs: 0, sha256: 'a'.repeat(64) }] };
  inst.items[ENG().sha256] = { id: 'whisper-engine', role: 'engine', place: 'whisper-1.9.5-vk', size: 1, mtimeMs: 0, files: [{ name: 'whisper-server.exe', size: 1, mtimeMs: 0, sha256: 'b'.repeat(64) }] };
  inst.items[VAD().sha256] = { id: 'whisper-vad', role: 'vad', place: VAD().dest, size: 1, mtimeMs: 0 };
  inst.items[MODEL().sha256] = { id: 'whisper-model', role: 'model', place: MODEL().dest, size: 1, mtimeMs: 0 };
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
  assert.ok(!fs.existsSync(path.join(root, 'whisper-1.9.5')));
  for (const rel of ['whisper-1.9.5-vk/whisper-server.exe', 'models/ggml-silero-v6.2.0.bin', 'models/ggml-large-v3-turbo-q5_0.bin']) {
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
  assert.deepStrictEqual(M.GPU_WHY, ['none', 'init-failed', 'lost']);   // 0.15.1 GV-2b（第9版）で意図して変えた: 符号は3つ
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

// ---------------------------------------------------------------- 記録の行（決めたこと 55・F172。0.15.1 GV-2b（第9版）で意図して変えた: 2つの形・3つの符号）
test('GV-1・F172: gpuLogLine（決めたこと 55 の2つの形。理由の符号は決まった3つだけ。パスの形とドライバの版を書かない）', () => {
  const L = M.gpuLogLine;
  assert.strictEqual(L('gpu', { device: 'Intel(R) Iris(R) Xe Graphics' }), '文字起こしの計算: GPU（Intel(R) Iris(R) Xe Graphics）');
  assert.strictEqual(L('cpu', { why: 'none' }), '文字起こしの計算: CPU（GPU を使えませんでした: 理由 none）');
  assert.strictEqual(L('cpu', { why: 'init-failed' }), '文字起こしの計算: CPU（GPU を使えませんでした: 理由 init-failed）');
  assert.strictEqual(L('cpu', { why: 'lost' }), '文字起こしの計算: CPU（GPU を使えませんでした: 理由 lost）');
  for (const why of M.GPU_WHY) assert.strictEqual(L('cpu', { why }), `文字起こしの計算: CPU（GPU を使えませんでした: 理由 ${why}）`, why);
  for (const why of ['start-failed', 'left-trying', 'files', 'manual', '', undefined, 'none; rm', 'gpu']) assert.strictEqual(L('cpu', { why }), '', String(why));
  for (const kind of ['switch', 'marked', 'driver', 'other', '', undefined]) assert.strictEqual(L(kind, { why: 'none', device: 'x' }), '', String(kind));
  // 版の項目を渡しても書かない（第9版でドライバの版を外した）
  assert.strictEqual(L('gpu', { device: 'GPU', version: '32.0.101.7085' }), '文字起こしの計算: GPU（GPU）');
  assert.strictEqual(L('gpu', { device: '' }), '文字起こしの計算: GPU（不明）');
  assert.strictEqual(L('gpu'), '文字起こしの計算: GPU（不明）');
  assert.strictEqual(L('cpu'), '');
  // どの行にもパスの形（\・/・:\）と行を割る字が無い。名前に混ざっても書かない
  const lines = [
    L('gpu', { device: 'C:\\Users\\試験𠮷\\AppData\\Local\\natsu\\engine\\whisper-1.9.5-vk' }),
    L('gpu', { device: '/home/試験/x' }),
    L('gpu', { device: 'GPU\r\n文字起こしの計算: GPU（偽）' }),
    L('cpu', { why: 'lost', device: 'C:\\x' }),
  ];
  for (const l of lines) {
    assert.ok(l.startsWith('文字起こしの計算: '), l);
    assert.ok(!/[\\/]|:\\|[\r\n]/.test(l) && !l.includes('ドライバ'), l);
  }
});

// ---------------------------------------------------------------- 落ちたときの案内（決めたこと 54・K17・VR20・F177）
test('GV-2b・F177: engineExitHint の表（取り込んだ GPU 版の組（bundled）はランタイムを言わない。印が無ければ今と1字も同じ）', () => {
  const H = M.engineExitHint;
  const B = { bundled: true };
  assert.strictEqual(H(3221225781, 500, B), 'エンジンのファイルが見つからないため起動できませんでした。');
  assert.strictEqual(H(3221225785, 500, B), '');
  assert.strictEqual(H(3221225477, 3000, B), '');
  assert.strictEqual(H(3221225477, 60000, B), '');
  assert.strictEqual(H(3221225501, 0, B), H(3221225501, 0));
  assert.strictEqual(H(3221226505, 0, B), H(3221226505, 0));
  assert.match(H(3221225501, 0, B), /CPU/);
  assert.match(H(3221226505, 0, B), /異常終了/);
  assert.strictEqual(H(1, 0, B), '');
  assert.strictEqual(H(null, 0, B), '');
  for (const [code, ms] of [[3221225781, 500], [3221225785, 500], [3221225477, 3000], [3221225477, 60000], [3221225501, 0], [3221226505, 0], [1, 0]]) {
    assert.ok(!/Visual C\+\+|ランタイム/.test(H(code, ms, B)), `${code}: ${H(code, ms, B)}`);
  }
  // 印が無い（前の組・手のパス）は今の文（engine-main.test.js の表と同じ値）
  for (const o of [undefined, {}, { bundled: false }, null, { bundled: 'yes' }]) {
    assert.strictEqual(H(3221225781, 500, o), '必要な部品（Microsoft Visual C++ ランタイム）か、エンジンのファイルが見つからないため起動できませんでした。', JSON.stringify(o));
    assert.strictEqual(H(3221225785, 500, o), 'Microsoft Visual C++ ランタイムが古い可能性があります。', JSON.stringify(o));
    assert.strictEqual(H(3221225477, 3000, o), 'Microsoft Visual C++ ランタイムが古い可能性があります。', JSON.stringify(o));
    assert.strictEqual(H(3221225477, 60000, o), '', JSON.stringify(o));
  }
});

// ---------------------------------------------------------------- GV-2b（main の場面。mainrun と偽の whisper の GPU の型: F165・F166・F169・F170・F172・F173・F175・F177）
const { execScene } = require('./helpers/scene-slots');
const RUN = path.join(__dirname, 'helpers', 'mainrun.js');
const runG = (args, env = {}) => new Promise((resolve, reject) => {
  execScene(process.execPath, [RUN, ...args], { env: { ...process.env, NATSU_TEST_STT_SLEEP_SCALE: '0.01', ...env }, maxBuffer: 1 << 25, timeout: 90000 },
    (err, stdout, stderr) => {
      if (err) { reject(new Error(`mainrun ${args.join(' ')} が失敗: ${err.message}\n${stderr}`)); return; }
      resolve(JSON.parse(stdout.trim().split('\n').pop()));
    });
});
const G = ['text', '--managed', '--gpu-set'];
const B = ['text', '--managed', '--win32'];   // 印の無いピン（今の組）。同じ偽の whisper の型で「今のエンジンが落ちた・起きない」を作る
const SCENES = {
  base: () => runG([...B, '--segs=5']),
  gpu: () => runG([...G, '--segs=5'], { FAKE_GPU: 'gpu' }),
  none: () => runG([...G], { FAKE_GPU: 'none' }),
  initFailed: () => runG([...G], { FAKE_GPU: 'init-failed' }),
  devices: () => runG([...G], { FAKE_GPU: 'gpu-devices:60' }),
  lost: () => runG([...G, '--segs=3', '--seg-settle', '--after-retry'], { FAKE_GPU: 'lost-after:2' }),
  baseLost: () => runG([...B, '--segs=3', '--seg-settle', '--after-retry'], { FAKE_GPU: 'lost-after:2' }),
  // 起動の先読みと会議の始めの先読みが片付いてから次へ進む（--warm-settle。起こした数を時刻で変えない: R51）
  down: () => runG([...G, '--segs=2', '--offline', '--warm-settle'], { FAKE_GPU: 'exit-before-ready' }),
  baseDown: () => runG([...B, '--segs=2', '--offline', '--warm-settle'], { FAKE_GPU: 'exit-before-ready' }),
  // 1つ目は中継・2つ目から中継が届かず PC へ（GPU 版が起きない）→ つながると見回りが中継で文字にする（届かない覚えは試しの尺度で短く）
  downBack: () => runG([...G, '--segs=3', '--relay-seq=cnn', '--back-after', '--back-settle'], { FAKE_GPU: 'exit-before-ready', NATSU_TEST_ONLINE_MEMO_SCALE: '0.001' }),
  crashOk: () => runG([...G, '--crash-ok']),
  oldYes: () => runG(['text', '--managed', '--old-set'], { FAKE_GPU: 'gpu' }),
  oldNone: () => runG(['text', '--managed', '--old-set', '--old-consent=none'], { FAKE_GPU: 'gpu' }),
  oldPaused: () => runG(['text', '--managed', '--old-set', '--old-consent=paused'], { FAKE_GPU: 'gpu' }),
  rtGpu: () => runG([...G, '--no-vc-runtime'], { FAKE_GPU: 'gpu' }),
  rtOld: () => runG(['text', '--managed', '--old-set', '--no-vc-runtime'], { FAKE_GPU: 'gpu' }),
  manualWin: () => runG(['text', '--win32'], { FAKE_GPU: 'none' }),
};
const memo = {};
const scene = (k) => (memo[k] || (memo[k] = SCENES[k]()));
const ST = { timeout: 180000 };
const calc = (r) => r.engineLog.filter((l) => l.startsWith('文字起こしの計算:'));
const GPU_LINE = '文字起こしの計算: GPU（Intel(R) Iris(R) Xe Graphics）';
const CPU_LINE = (why) => `文字起こしの計算: CPU（GPU を使えませんでした: 理由 ${why}）`;
const masked = (args) => args.map((a, i) => (args[i - 1] === '--port' ? '<port>' : a));
const segsOf = (r) => r.pages[0].segments.map((x) => [x.text, Boolean(x.failed)]);
const codes = (r) => (r.sttSeen || []).map((s) => (s && s.problem ? s.problem.code : null)).filter((c, i, a) => i === 0 || a[i - 1] !== c);
const RECHECK = '落ちた後に取り込んだファイルを照らし直しました';
// 起こした exe・作業フォルダ・引数が、印の無い今の組の起こし方と同じ（置き場所の名前だけが違う）。-ng が無い
const sameArgs = (r, b, k) => {
  assert.ok(r.spawns.length >= 1, `${k}: ${JSON.stringify(r.spawns)}`);
  for (const s of r.spawns) {
    assert.ok(!s.args.includes('-ng'), `${k}: -ng を足した ${JSON.stringify(s.args)}`);
    assert.deepStrictEqual(masked(s.args), masked(b.spawns[0].args), `${k}: 引数が今の起こし方と違う`);
    assert.strictEqual(path.basename(s.cwd), 'whisper-1.0.0-vk', k);
    assert.strictEqual(path.dirname(s.cmd), s.cwd, k);
  }
};

test('GV-2b・F165・F173: GPU で動く（今と同じ exe の作業フォルダと引数で起こし、記録に GPU の1行。ドライバの版の字が無い・gpu-state.json を作らない）', ST, async () => {
  const [r, b] = await Promise.all([scene('gpu'), scene('base')]);
  assert.strictEqual(r.spawns.length, 1, JSON.stringify(r.spawns));
  sameArgs(r, b, 'gpu');
  assert.deepStrictEqual(calc(r), [GPU_LINE]);
  assert.ok(!r.engineLog.some((l) => /ドライバ/.test(l)), JSON.stringify(calc(r)));
  assert.ok(Array.isArray(r.engineRootFiles) && r.engineRootFiles.includes('installed.json') && !r.engineRootFiles.includes('gpu-state.json'), JSON.stringify(r.engineRootFiles));
  assert.ok(r.served.length >= 5 && r.served.every((l) => l.startsWith('served ng=false')), JSON.stringify(r.served));
  assert.ok(segsOf(r).length === 5 && segsOf(r).every(([t, f]) => t && !f), JSON.stringify(segsOf(r)));
});
test('GV-2b・F165: GPU を使えない PC（none・init-failed）は止めずにそのまま使う（起こすのは1回・-ng が無い・記録に CPU の1行・知らせと帯は GPU で動く場面と同じ）', ST, async () => {
  const [g, b] = await Promise.all([scene('gpu'), scene('base')]);
  for (const [k, why] of [['none', 'none'], ['initFailed', 'init-failed']]) {
    const r = await scene(k);
    assert.strictEqual(r.spawns.length, 1, `${k}: ${JSON.stringify(r.spawns)}`);
    sameArgs(r, b, k);
    assert.deepStrictEqual(calc(r), [CPU_LINE(why)], k);
    assert.ok(r.served.length >= 2 && r.served.every((l) => l.startsWith('served ng=false')), `${k}: ${JSON.stringify(r.served)}`);
    assert.ok(segsOf(r).length === 2 && segsOf(r).every(([t, f]) => t && !f), `${k}: ${JSON.stringify(segsOf(r))}`);
    assert.deepStrictEqual(r.notices, g.notices, `${k}: 知らせが違う`);
    assert.deepStrictEqual(codes(r), codes(g), `${k}: 帯が違う`);
  }
});
test('GV-2b・F165: 装置の行が多くても GPU の行を落とさない（装置の行 60 → 記録は GPU の1行）', ST, async () => {
  const r = await scene('devices');
  assert.strictEqual(r.spawns.length, 1, JSON.stringify(r.spawns));
  assert.deepStrictEqual(calc(r), [GPU_LINE]);
});
test('GV-2b・F166・F177: 会議の途中で GPU 版が落ちる（その区間は音声を残して文字起こし待ち・次の区間は同じ exe を同じ引数で起こし直して文字になる・照らし直さない・知らせと帯は今のエンジンが落ちたときと同じ）', ST, async () => {
  const [r, base, b] = await Promise.all([scene('lost'), scene('baseLost'), scene('base')]);
  assert.strictEqual(r.spawns.length, 2, JSON.stringify(r.spawns));
  sameArgs(r, b, 'lost');
  assert.ok(r.served.every((l) => l.startsWith('served ng=false')), JSON.stringify(r.served));
  // 2 番目の区間は今の送り直し1回の後の失敗（音声を残す）。区間の数は落ちない
  assert.ok(r.engineLog.some((l) => l.startsWith('手元の文字起こしの失敗: s2')), JSON.stringify(r.engineLog.filter((l) => /失敗/.test(l))));
  assert.ok(r.engineLog.some((l) => l.startsWith('文字起こしエンジンが終了しました (code 9)')), JSON.stringify(r.engineLog));
  assert.strictEqual(r.pages[0].segments.length, 3, JSON.stringify(segsOf(r)));
  assert.deepStrictEqual([segsOf(r)[0][1], segsOf(r)[2][1]], [false, false], JSON.stringify(segsOf(r)));
  assert.ok(r.afterRetry.segments.length === 3 && r.afterRetry.segments.every((x) => x.text && !x.failed), JSON.stringify(r.afterRetry.segments));
  // 印を付けない・照らし直さない・取り直さない（0xC0000135 でない終了コード）。記録は準備ができるたびに GPU の1行（「文字起こしの計算:」の落ちた形は無い）
  assert.ok(!r.engineLog.some((l) => l.includes(RECHECK)), JSON.stringify(r.engineLog));
  assert.ok(!r.engineLog.some((l) => l.startsWith('取り込んだエンジンの取り直しを頼みます')), JSON.stringify(r.engineLog));
  assert.deepStrictEqual(calc(r), [GPU_LINE, GPU_LINE]);
  // 知らせと帯は、印の無い今の組が同じ所で落ちたときと同じ
  assert.deepStrictEqual(r.notices, base.notices, '知らせが今のエンジンが落ちたときと違う');
  assert.deepStrictEqual(codes(r), codes(base), '帯が今のエンジンが落ちたときと違う');
  assert.deepStrictEqual(segsOf(r).map(([t, f]) => [t.replace(/区間\d+/, ''), f]), segsOf(base).map(([t, f]) => [t.replace(/区間\d+/, ''), f]), '区間の文が今と違う');
});
test('GV-2b・F166: 起きない GPU 版（区間は音声を残して文字起こし待ち・帯は今の engine-down・起こすのは頼みごとに1回・-ng が無い。つながると中継で文字になる）', ST, async () => {
  const [r, base] = await Promise.all([scene('down'), scene('baseDown')]);
  assert.ok(r.spawns.length >= 1 && r.spawns.every((s) => !s.args.includes('-ng') && path.basename(s.cwd) === 'whisper-1.0.0-vk'), JSON.stringify(r.spawns));
  // 頼み（区間・復旧の待ち行列ごとの ensureEngineReady と、起動と会議の始めの先読みの 2）ごとにちょうど1回。同じ待ちの中で起こし直さない・自分で回り続けない（G17・VR24・決めたこと 54）
  // rv52 の重要 1（R51）で意図して変えた: 「頼みの数 + 2 を越えない」は、先読みが最初の区間の待ちと重なるかで数が 3 か 4 になり、準備の前に落ちたら
  // 同じ待ちの中で1回起こし直す回帰を半分ほどしか捕まえなかった。--warm-settle で先読みを1つずつ片付けてから進め、数をちょうどで見る（変異 gv-ready-once）
  const asksOf = (x) => x.engineLog.filter((l) => /^文字起こしの経路: (区間|復旧) s\d+ → local/.test(l) || l.startsWith('文字起こし待ち: 始めた')).length + 2;
  for (const [k, x] of [['down', r], ['baseDown', base]]) {
    assert.deepStrictEqual(x.warmSpawns, [1, 2], `${k}: 先読みで起こした数（起動の先読みの後・会議の始めの先読みの後）`);
    assert.strictEqual(asksOf(x), 5, `${k}: 頼みの数（区間 2・文字起こし待ち 1・先読み 2）: ${JSON.stringify(x.engineLog)}`);
    assert.strictEqual(x.spawns.length, asksOf(x), `${k}: 起こした数が頼みの数と違う（同じ待ちの中で起こし直した）`);
  }
  assert.ok(r.sttAt['engine-down'], JSON.stringify(r.sttSeen));
  assert.deepStrictEqual(codes(r), codes(base), '帯が今のエンジンが起きないときと違う');
  assert.deepStrictEqual(r.notices, base.notices, '知らせが今のエンジンが起きないときと違う');
  assert.deepStrictEqual(segsOf(r), segsOf(base), '区間の文が今と違う');
  assert.ok(segsOf(r).length === 2 && segsOf(r).every(([, f]) => f), JSON.stringify(segsOf(r)));
  assert.deepStrictEqual(calc(r), [], '準備の前に落ちたのに「文字起こしの計算:」の行を書いた');
  assert.ok(!r.engineLog.some((l) => l.includes(RECHECK)), JSON.stringify(r.engineLog));
  // つながると、残した区間が中継で文字になる（区間の数が落ちない）
  const k = await scene('downBack');
  assert.ok(k.spawns.length >= 1 && k.spawns.every((s) => !s.args.includes('-ng')), JSON.stringify(k.spawns));
  assert.deepStrictEqual(k.pages[0].segments.map((x) => x.failed), [false, true, true], '前提: 2つ目と3つ目が文字起こし待ちに残っていない');
  assert.ok(k.afterBack.pages[0].segments.length === 3 && k.afterBack.pages[0].segments.every((x) => x.text && !x.failed), JSON.stringify(k.afterBack.pages[0].segments));
});
test('GV-2b・F177: 0xC0000135 で落ちて照らし直して合う（GPU 版の組）: 記録は「…（合っています）」・知らせも取り直しも無い・組を使い続ける・案内にランタイムの字が無い', ST, async () => {
  const r = await scene('crashOk');
  const exe = path.join(r.managedRoot, 'whisper-1.0.0-vk', 'whisper-server.exe');
  assert.ok(r.engineLog.includes('文字起こしエンジン: 落ちた後に取り込んだファイルを照らし直しました（合っています）'), JSON.stringify(r.engineLog));
  assert.ok(!r.engineLog.some((l) => /Visual C\+\+/.test(l)), JSON.stringify(r.engineLog));
  const exit = r.engineLog.find((l) => l.startsWith('文字起こしエンジンが終了しました (code 3221225781)'));
  assert.ok(exit && exit.endsWith('。エンジンのファイルが見つからないため起動できませんでした。'), JSON.stringify(r.engineLog));
  assert.deepStrictEqual(r.notices, []);
  assert.deepStrictEqual(r.hits, [], '合っているのに取り直した');
  assert.ok(!r.engineLog.some((l) => l.startsWith('取り込んだエンジンの取り直しを頼みます')), JSON.stringify(r.engineLog));
  assert.deepStrictEqual([r.fetchStatusAfterCrash.using.whisper, r.fetchStatusAfterCrash.whisperReady], ['current', true]);
  assert.deepStrictEqual([r.testAfterCrash.ok, r.testAfterCrash.error], [true, undefined], JSON.stringify(r.testAfterCrash));
  assert.deepStrictEqual(r.spawns.map((x) => [x.cmd, Boolean(x.crash)]), [[exe, true], [exe, false]]);
});
test('GV-2b・F169・F170・F173: 前から取り込んだ PC（記録中は係が待ち、前の組が今の引数で答え、記録の行を書かない。手が空いたら GPU 版の組で起こし直して1行。片付けで前の置き場所が消える。同意なし・一時停止は取らない）', ST, async () => {
  const r = await scene('oldYes');
  assert.deepStrictEqual(r.hitsAtStop, [], '記録中に取った');
  assert.deepStrictEqual(r.calcAtStop, [], '前の組で「文字起こしの計算:」の行を書いた');
  const firstVk = r.oldSet.spawns.findIndex((x) => x.dir === 'whisper-1.0.0-vk');
  assert.ok(firstVk > 0, JSON.stringify(r.oldSet.spawns));
  assert.ok(r.oldSet.spawns.slice(0, firstVk).every((x) => x.dir === 'whisper-1.0.0' && !x.ng), JSON.stringify(r.oldSet.spawns));
  assert.ok(r.oldSet.spawns.every((x) => !x.ng), JSON.stringify(r.oldSet.spawns));
  assert.ok(segsOf(r).every(([t, f]) => t && !f));
  assert.deepStrictEqual(r.oldSet.hits, ['whisper-engine']);
  assert.deepStrictEqual([r.oldSet.oldDir, r.oldSet.newDir], [false, true]);
  assert.deepStrictEqual(r.oldSet.engineLog.filter((l) => l.startsWith('文字起こしの計算:')), [GPU_LINE]);
  for (const k of ['oldNone', 'oldPaused']) {
    const o = await scene(k);
    assert.deepStrictEqual(o.oldSet.hits, [], k);
    assert.ok(o.oldSet.spawns.length >= 1 && o.oldSet.spawns.every((x) => x.dir === 'whisper-1.0.0' && !x.ng), k);
    assert.strictEqual(o.oldSet.oldDir, true, k);
    assert.deepStrictEqual(calc(o), [], k);
  }
});
test('GV-2・F175: ランタイムの無い PC（GPU 版の組は起きて案内を出さない・前の組は今どおり止めて同じ案内）', ST, async () => {
  const r = await scene('rtGpu');
  assert.deepStrictEqual([r.start.ok, r.test.ok], [true, true], JSON.stringify([r.start, r.test]));
  assert.strictEqual(r.engineFetchStatus.runtime, null);
  assert.strictEqual(r.engineStatus.whisper, '');
  assert.ok(!r.engineLog.some((l) => /Visual C\+\+ ランタイム/.test(l)), JSON.stringify(r.engineLog.filter((l) => /ランタイム/.test(l))));
  assert.ok(r.spawns.length >= 1 && r.spawns.every((x) => path.basename(x.cwd) === 'whisper-1.0.0-vk'));
  const o = await scene('rtOld');
  const msg = M.vcRuntimeIssue({}, { whisper: true }).message;
  assert.strictEqual(o.engineStatus.whisper, msg);
  assert.deepStrictEqual([o.start.ok, o.start.error], [false, msg]);
  assert.deepStrictEqual(o.spawns, [], 'ランタイムの無い PC で前の組を起動した');
});
test('GV-2b・F173: 変わらない人（詳細設定のパス・印の無いピン）は -ng を足さず、「文字起こしの計算:」の行を書かない', ST, async () => {
  for (const k of ['base', 'manualWin']) {
    const r = await scene(k);
    assert.ok(r.spawns.length >= 1 && r.spawns.every((x) => !x.args.includes('-ng')), `${k}: ${JSON.stringify(r.spawns)}`);
    assert.deepStrictEqual(calc(r), [], k);
  }
});
test('GV-2b・F172: 記録の行（新しい行にパスの形・利用者名・ドライバの版が無く、準備ができるたびに1行。会議の区間 5 で行は1つ）', ST, async () => {
  for (const k of ['gpu', 'none', 'initFailed', 'devices', 'lost', 'oldYes']) {
    const r = await scene(k);
    const ls = k === 'oldYes' ? r.oldSet.engineLog.filter((l) => l.startsWith('文字起こしの計算:')) : calc(r);
    assert.ok(ls.length >= 1, k);
    for (const l of ls) {
      assert.ok(!/[\\/]|:\\/.test(l) && !/日本語𠮷|取込𠮷|ドライバ/.test(l), `${k}: ${l}`);
      assert.ok(l === GPU_LINE || M.GPU_WHY.some((w) => l === CPU_LINE(w)), `${k}: ${l}`);
    }
  }
  assert.strictEqual(calc(await scene('gpu')).length, 1, '会議の区間 5 で行は1つ');
});
test('GV-2b・F173: 外したもの（CPU の形・試している印・ドライバの版ごとの印・reg.exe の字がコードに無い）', () => {
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  for (const n of ['gpuPlan', 'normGpuState', 'driverKeyOf', 'driverVersionOf', 'noGpuArgs']) assert.ok(!(n in M), `mainlib が ${n} を書き出している`);
  const main = read('src', 'main.js');
  for (const w of ['reg.exe', 'gpu-state.json', "'-ng'", 'gpuFallBack', 'gpuTrying', 'gpuDecide']) assert.ok(!main.includes(w), `src/main.js に ${w}`);
  assert.ok(!/SPECIAL_PLACES = \[[^\]]*gpu-state\.json/.test(read('src', 'engine-install.js')), 'SPECIAL_PLACES に gpu-state.json');
  assert.ok(!read('tools', 'engine-smoke.js').includes('noGpuArgs'), 'engine-smoke に noGpuArgs');
  assert.ok(!read('src', 'mainlib.js').includes('gpu-state.json') && !read('src', 'engine-manifest.js').includes('-ng で起こす'), '注釈に CPU の形が残っている');
});

// ---------------------------------------------------------------- GV-3（engine-smoke は Windows の CI でだけ回る。ここでは確かめる中身を文字で固定する）
// 0.15.1 GV-2b（第9版・VR21）で意図して直した: 形は今の引数の1つだけ。whisper_backend_init_gpu: で始まる行を見る
test('GV-3・F165: engine-smoke は GPU 版の組を今の引数で1回起こし、whisper_backend_init_gpu の行・見分けの答え・use gpu の値・DLL の中の書式の字（GPU_LOG_MARKS）を見る', () => {
  const s = fs.readFileSync(path.join(__dirname, '..', 'tools', 'engine-smoke.js'), 'utf8');
  const st = s.slice(s.indexOf('async function start()'));
  const body = st.slice(0, st.indexOf('\n}'));
  assert.ok(/rs\.push\(report\(await smokeGpuMarks\(/.test(body), 'start() で DLL の中の書式の字を見ていない');
  assert.strictEqual((body.match(/await smokeWhisper\(/g) || []).length, 1, 'start() で起こす形が1つでない');
  assert.ok(/await smokeWhisper\(placed\)/.test(body), 'start() で GPU 版の組を起こしていない');
  assert.ok(s.includes('GPU_LOG_MARKS.formats') && s.includes('gpuLogState('), '見分け・書式をアプリの部品で作っていない');
  assert.ok(!s.includes('noGpuArgs') && !/'ng'/.test(s) && !s.includes('PORT.ng'), '-ng の形が残っている');
  const fn = s.slice(s.indexOf('async function smokeWhisper('), s.indexOf('async function smokeGpuMarks('));
  assert.ok(fn.includes('GPU_LOG_MARKS.using') && fn.includes('GPU_LOG_MARKS.noGpu') && fn.includes('GPU_LOG_MARKS.failed'), 'whisper_backend_init_gpu の行を GPU_LOG_MARKS の字で見ていない');
  assert.ok(fn.includes("['none', 'gpu'].includes(") && fn.includes("use gpu    = ") && fn.includes("!== '1'"), '見分けの答えと use gpu の値を見ていない');
  assert.ok(fn.includes('形の結果: GPU 版の組（今の引数）・見分け ') && fn.includes('・whisper_backend_init_gpu の行 '), '形の結果の1行の形が違う');
});
