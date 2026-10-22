/*
 * engine-manifest.js — 取り込むエンジンとモデルのピン（版・URL・大きさ・SHA-256・置き場所）
 *
 * 取り込むものは、ここ1か所にだけ書く。ほかのコードはこの中身を読むだけで、書き換えない
 * （深く凍結してある）。自動更新は src/ を入れ替えるので、ピンを上げるのも更新で届く。
 *
 * 決まり:
 *  - URL は版を固定する。GitHub はリリースのタグ、Hugging Face は 40 桁の commit。
 *    latest・main・api.github.com は使わない（API は1つの IP から1時間に60回まで）。
 *  - dir と dest は `/` 区切りの英数字だけの相対パス。Windows のパスにするのは使う側（path.join）。
 *    置き場所の根元は %LOCALAPPDATA%\natsu\engine（engine-install.js が決める）。
 *  - エンジンの dir は版を含む。ピンを上げると置き場所も変わり、前の組を上書きしない。
 *  - zip の files は、zip の中で使うファイルの全部。大きさと SHA-256 は、展開したファイルのもの。
 *    ここに無いファイル（whisper の zip の試験用の exe など）は出さない。
 *  - 並びは取り込む順（文字起こしの組が先。済めば文字起こしが使える）。
 *  - ピンを変えるのはこのファイルだけ。変えた commit は、Windows の CI の engine-smoke が緑であること。
 *
 * 要約のモデルは、測る前の既定（Gemma 4 E4B-it Q4_K_M）。利用者の PC で3つを測って
 * 利用者が選ぶまで（計画の Q1）、リリースしない。替えるときは sum-model の行を差し替え、
 * test/engine-manifest.test.js の合計も直す。
 */
'use strict';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// whisper.cpp v1.9.5（commit d1be6fde11ac6e0407606b4e42fe72d34add8037）。資産は CI の仮リリースのタグ b5454 にある。
// zip の Release/ の中の 13 個（合計 11,850,240 バイト）。
const WHISPER_FILES = [
  { name: 'Release/whisper-server.exe', size: 726016, sha256: 'a97456e747f28e7bb09c1dac35f40d94404c5ecffa74aaaaa7a3753ea6543121' },
  { name: 'Release/whisper.dll', size: 1370112, sha256: '034396d75bb5720c1851674ff64a96192b58f6927b68d334ebd254ce6cad9674' },
  { name: 'Release/ggml.dll', size: 62464, sha256: '31fe18616d872af9b6134b47a6dff8072ae4ecbe5df0273f4f8dc36766c9db8e' },
  { name: 'Release/ggml-base.dll', size: 693248, sha256: 'bede0d6b2d387236ecd2b5dd676d51c8984b5b6e0ae461a12174e9c01345c5f0' },
  { name: 'Release/ggml-cpu-alderlake.dll', size: 1009664, sha256: 'd8f5c56ea490394eeae8b271650f2647aecd039a542d6df9e0140726e62a4603' },
  { name: 'Release/ggml-cpu-cannonlake.dll', size: 1049600, sha256: '74127b40abd4f595d9db6af0fa313a02e18ff42fc228bfa05281e7c788dd4507' },
  { name: 'Release/ggml-cpu-cascadelake.dll', size: 1061376, sha256: '4b11c427b844eeac87529af9a8d94b35aad2024666beb2a35e59fe3077e4b81e' },
  { name: 'Release/ggml-cpu-haswell.dll', size: 1010688, sha256: '1306b1014c8118d27234d8ddc0e66ced1f8c8476bf85071595fd182ea9b7263b' },
  { name: 'Release/ggml-cpu-icelake.dll', size: 1061376, sha256: '2b4dc4c66e7d8fe2807283816e9cf3b7f7d0556f59df34069871e37eab8aed40' },
  { name: 'Release/ggml-cpu-sandybridge.dll', size: 1026560, sha256: '04edbdebc01a1d421062a960881a4f34d520d99693999518243f332406444c6e' },
  { name: 'Release/ggml-cpu-skylakex.dll', size: 1049600, sha256: '1774714cf93621406ff35344b54715619a83242ae3e331e44d98a3b35ce801be' },
  { name: 'Release/ggml-cpu-sse42.dll', size: 862720, sha256: 'f060318772c4c2dbac312bbfff6ea700b85dbc502bb38585a7186d06d549301a' },
  { name: 'Release/ggml-cpu-x64.dll', size: 866816, sha256: '4b4b05caba40d4309b5d710ef74c59ba190516b8489f27bdb1ba11ae33c6e9d3' },
];

// llama.cpp b11669 = v0.7.0（commit 620d2225cc436ab0b001e3200e590e3b286ef9ab）。zip の根元の 23 個（合計 44,353,821 バイト）。
// libomp.dll のライセンスの写し（LICENSE-LLVM-OpenMP）も一緒に置く。
const LLAMA_FILES = [
  { name: 'llama-server.exe', size: 9216, sha256: '6a4635aeb35656153d4bfeeddf761d24ed84aada9c9108d580737cbed465141b' },
  { name: 'llama-server-impl.dll', size: 9259520, sha256: '24b1249ddd19e3ba3551804707dbe2f3c154c007542899ea8b16d69a94ab6597' },
  { name: 'llama-common.dll', size: 8037376, sha256: '9adf40bc08e99005699d6397bcacb72c3aced68c9db01f13b5bd31c6abc7b2b5' },
  { name: 'llama.dll', size: 3541504, sha256: 'aacb073c9c0d30090dd3e56f49772545452ccc4fd311efbfdb7d1bba7bbb0bda' },
  { name: 'mtmd.dll', size: 1847808, sha256: 'bd4a9dac32ba8b14cf95da3361495380ac556b34f48434ebe477ffef23f40bd1' },
  { name: 'ggml.dll', size: 78848, sha256: '2649a5d914934188cccbe2c58e4642d2d4408bcda0f7068d58390686bd7ea62f' },
  { name: 'ggml-base.dll', size: 803840, sha256: '0a259689ea3c105a8122159eb97fb53733f2531fadd3e9739689961cdab27600' },
  { name: 'libomp.dll', size: 768000, sha256: 'a12116ba72d1d6820407cf30be23da04ce79d6bb8a71a5ee71759c5a1faa6f1c' },
  { name: 'ggml-cpu-alderlake.dll', size: 1420288, sha256: '98b3bd12a84e848f57686f6d5f0969654ec79cda0c7636498933ea1063d14aa6' },
  { name: 'ggml-cpu-cannonlake.dll', size: 1598976, sha256: 'fef636daea23b26f935cf5983be9a29b79f0541cd148b9d64a32bc9ea0cec704' },
  { name: 'ggml-cpu-cascadelake.dll', size: 1583616, sha256: 'b32ee94fa0a366886cd03be48f80f1d8c1bbb338d71fc734a263753ec46aa8fd' },
  { name: 'ggml-cpu-cooperlake.dll', size: 1593344, sha256: 'e67357a558e71b834360b6f6d62abc6b9fe19930f6f7dd21ee0339e7b144306e' },
  { name: 'ggml-cpu-haswell.dll', size: 1425408, sha256: 'd33deb9bf3dd25427404f0f94a13c6b3da92b9b57b794199a9f354c3a327efb6' },
  { name: 'ggml-cpu-icelake.dll', size: 1590272, sha256: '41abb00a64bbf099c137cdb3b9547c7eb90bcd9c1d7b83238cbf10a74f97addd' },
  { name: 'ggml-cpu-ivybridge.dll', size: 1301504, sha256: 'd674c12b3f40d657b0989801699560e68247dbe9509823651b055ac3816ba37c' },
  { name: 'ggml-cpu-piledriver.dll', size: 1294336, sha256: 'bb5215c806397adf56e986f52aa0c75b04b3b5b33203a722f647254eae2b94b2' },
  { name: 'ggml-cpu-sandybridge.dll', size: 1291264, sha256: '55d5659b45afcbe7a1d7611ab1914d2888476fc3024933e4b82122cdc58d6fd5' },
  { name: 'ggml-cpu-sapphirerapids.dll', size: 1869824, sha256: '83af3cacf3bf32b98626791358f950da4b45a22af85bde63afe537fe51e60848' },
  { name: 'ggml-cpu-skylakex.dll', size: 1592320, sha256: '20722299dc5e4703056ff95b7ef329c223390ab87469c822721c1e67e4cc2a24' },
  { name: 'ggml-cpu-sse42.dll', size: 916992, sha256: '1c0fc615b6d97a79e58f33e8a7fb4e8de1834ad0f3f0e00e8943a4d416ddd242' },
  { name: 'ggml-cpu-x64.dll', size: 909824, sha256: '7c9df996db7fe98510571524e3e62dd267a4034350185014814418dbad3c25ea' },
  { name: 'ggml-cpu-zen4.dll', size: 1600000, sha256: '83ae254f6204670e9011e11db84786122567bde2fab07354e7c4827c18589ee1' },
  { name: 'LICENSE-LLVM-OpenMP', size: 19741, sha256: 'fdad1758a9e1f9d5a81e18879b3406772115edc92c24bfa36b70c654f325e8e4' },
];

const MANIFEST = deepFreeze({
  schema: 1,
  items: [
    {
      id: 'whisper-engine', group: 'whisper', kind: 'zip',
      label: '文字起こしエンジン（whisper.cpp）', version: '1.9.5',
      url: 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip',
      size: 8928640, sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
      dir: 'whisper-1.9.5', strip: 'Release/', exe: 'whisper-server.exe',
      files: WHISPER_FILES,
      license: 'MIT（Copyright (c) 2023-2026 The ggml authors）',
    },
    {
      id: 'whisper-vad', group: 'whisper', kind: 'file', role: 'vad',
      label: 'VAD のモデル（無音スキップ）', version: 'silero v6.2.0',
      url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',
      size: 885098, sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
      dest: 'models/ggml-silero-v6.2.0.bin',
      license: 'MIT（Copyright (c) 2020-present Silero Team）',
    },
    {
      id: 'whisper-model', group: 'whisper', kind: 'file', role: 'model',
      label: '文字起こしのモデル（large-v3-turbo）', version: 'large-v3-turbo q5_0',
      url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-large-v3-turbo-q5_0.bin',
      size: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
      dest: 'models/ggml-large-v3-turbo-q5_0.bin',
      license: 'MIT（Copyright (c) 2022 OpenAI）',
    },
    {
      // 画面とフォルダの版は b11669（v0.7.0 ではなく、ファイル名に合わせる）。
      id: 'sum-engine', group: 'sum', kind: 'zip',
      label: '要約エンジン（llama.cpp）', version: 'b11669',
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b11669/llama-b11669-bin-win-cpu-x64.zip',
      size: 19537886, sha256: '37b3efcf962847ca869745fd4ccf7f5e7e8dacfeff9fa3523b4ca8cdc66d632b',
      dir: 'llama-b11669', strip: '', exe: 'llama-server.exe',
      files: LLAMA_FILES,
      license: 'MIT（Copyright (c) 2023-2026 The ggml authors）。中の libomp.dll は Apache-2.0 WITH LLVM-exception（LICENSE-LLVM-OpenMP を見る）',
    },
    {
      // 測る前の既定。unsloth の GGUF（元は google/gemma-4-E4B-it）、commit は 2026-07-17 の更新。
      id: 'sum-model', group: 'sum', kind: 'file', role: 'model',
      label: '要約のモデル（Gemma 4 E4B）', version: 'E4B-it Q4_K_M',
      url: 'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/bfc15c382204943c3a8fff0c750b94ae2364d7a3/gemma-4-E4B-it-Q4_K_M.gguf',
      size: 4977171584, sha256: '85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87',
      dest: 'models/gemma-4-E4B-it-Q4_K_M.gguf',
      license: 'Apache-2.0（Gemma 4 E4B-it、Google DeepMind）',
    },
  ],
});

// 0.9.4 S-7（計画 docs/plans/2026-10-22-094.md の決めたこと 21・持ち主の答え Q7）: 追いつかない PC への軽い文字起こしのモデル。
// 取り込みの組（items）の外に置く（取り込む順・合計・group の照らしを変えない）。［ローカル AI の設定］の［軽いモデルを取り込む］だけが取り込み、
// 使うかは利用者が選ぶ（settings.localModelAlt）。URL は今のピンと同じ commit、大きさと SHA-256 はその commit の LFS の頭（2026-10-22 に読んだ）
const ALT_MODELS = deepFreeze([
  {
    id: 'whisper-model-medium', group: 'whisper', kind: 'file', role: 'model', alt: 'medium',
    label: '文字起こしの軽いモデル（medium）', version: 'medium q5_0',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-medium-q5_0.bin',
    size: 539212467, sha256: '19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',
    dest: 'models/ggml-medium-q5_0.bin',
    license: 'MIT（Copyright (c) 2022 OpenAI）',
  },
]);

/** group（'whisper' か 'sum'）の項目を、取り込む順で返す。 */
function itemsOf(group) {
  return MANIFEST.items.filter((i) => i.group === group);
}

/** 大きさの合計（項目でも、zip の files でも使える）。 */
function totalBytes(items = MANIFEST.items) {
  return items.reduce((a, i) => a + i.size, 0);
}

/** 画面の「取得元」の欄に出すホスト名。読めない URL は空の文字列。 */
function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

module.exports = { MANIFEST, ALT_MODELS, itemsOf, totalBytes, hostOf };
