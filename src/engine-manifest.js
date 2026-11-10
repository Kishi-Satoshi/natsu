/*
 * engine-manifest.js — 取り込むエンジンとモデルのピン（版・URL・大きさ・SHA-256・置き場所）
 *
 * 取り込むものは、ここ1か所にだけ書く。ほかのコードはこの中身を読むだけで、書き換えない
 * （深く凍結してある）。自動更新は src/ を入れ替えるので、ピンを上げるのも更新で届く。
 *
 * 決まり:
 *  - URL は版を固定する。GitHub はリリースのタグ、Hugging Face は 40 桁の commit。
 *    GitHub は上流（ggml-org）の札か、このリポジトリの先行版の札（whisper-vulkan-<頭7桁>。アプリの更新の札 natsu-v でない）。
 *    latest・main・api.github.com は使わない（API は1つの IP から1時間に60回まで）。
 *  - dir と dest は `/` 区切りの英数字だけの相対パス。Windows のパスにするのは使う側（path.join）。
 *    置き場所の根元は %LOCALAPPDATA%\natsu\engine（engine-install.js が決める）。
 *  - エンジンの dir は版を含む。ピンを上げると置き場所も変わり、前の組を上書きしない。
 *  - zip の files は、zip の中で使うファイルの全部。大きさと SHA-256 は、展開したファイルのもの。
 *    ここに無いファイル（whisper の zip の試験用の exe など）は出さない。
 *  - 並びは取り込む順（文字起こしの組が先。済めば文字起こしが使える）。
 *  - ピンを変えるのはこのファイルだけ。変えた commit は、Windows の CI の engine-smoke が緑であること。
 *
 * 0.10.0 LS-3（D59）: 要約は利用者の Claude Code で作るので、要約のエンジンとモデルの組を外した（表は文字起こしの組だけ）。
 * 0.9.x で取り込んだ要約の組を消す表は src/engine-install.js の RETIRED（LS-4）。
 */
'use strict';

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

// 0.15.1 GV-1（D126）: NaTsu の CI が whisper.cpp v1.9.5（commit d1be6fde11ac6e0407606b4e42fe72d34add8037）を Vulkan 付きで作った先行版の組。
// GPU を使えないときは whisper が同じ組のまま CPU で計算する（NaTsu は -ng を足さない）（0.15.1 GV-2b で直した注釈）。
// 資産はこのリポジトリの先行版のタグ whisper-vulkan-d1be6fd にある（latest にしない・アプリの更新の札 natsu-v の形でない）。zip の中は平ら（strip が空）で 19 個。試験用の whisper-cli.exe を除く 18 個（合計 60,473,419 バイト）。
// Visual C++ ランタイムは使わない（C/C++ の実行の部品は中に持ち、OpenMP の vcomp140.dll を同梱。vulkan-1.dll は GPU のドライバの物を使う）。
// 0.15.0 までの上流の CPU 版（タグ b5454 の whisper-bin-x64.zip）はピンから外した（前から取り込んだ PC は同じ id の「新しい版」として取り直す）。
const WHISPER_FILES = [
  { name: 'whisper-server.exe', size: 1064448, sha256: '5a49fed45dfb5fe1c6e3801f59fb090a323e7d606fbbcff1aa7fd62db3d781f4' },
  { name: 'whisper.dll', size: 1930752, sha256: '1597ffce8a86f3c6c1cd81eb85d743e119237a25506e572fea7d238f8d1ac572' },
  { name: 'ggml.dll', size: 178176, sha256: 'bc2cb5480322f9c6b35d78d6f473081be08fc346dfac647257a0086362ba45f1' },
  { name: 'ggml-base.dll', size: 895488, sha256: 'bffe0d7771fafe32a0c9d309ac465f2ede0e8faf1aaf095725950a0386935932' },
  { name: 'ggml-cpu-alderlake.dll', size: 1186304, sha256: '0b3f73e5772f4ec7df5f35b7ce04c56d3ee5990c4b70c6c46ad233a09568bbee' },
  { name: 'ggml-cpu-cannonlake.dll', size: 1226752, sha256: '490f201c0beac11afa118c7a6fd58da06ce14ba386207a35634788e235766a0a' },
  { name: 'ggml-cpu-cascadelake.dll', size: 1238016, sha256: '6cd120a64550390999eb2dc445145253c7320e83fa6b5d67a0656f3b788b2279' },
  { name: 'ggml-cpu-haswell.dll', size: 1187328, sha256: '398f3059588e157d7f2ad8eedae255a91e9028b28be1b1915eddff567923384a' },
  { name: 'ggml-cpu-icelake.dll', size: 1238016, sha256: 'a17635055ae03d7aeaac8967102e066ef2b1364d5e4b506f85af658bac2cc0f7' },
  { name: 'ggml-cpu-sandybridge.dll', size: 1203200, sha256: '527fd298af02e6851e337162ce865e79413ebea8b86e49e00b9d824080756e72' },
  { name: 'ggml-cpu-skylakex.dll', size: 1226752, sha256: '1dd10486c96c7c907bbeefc98cde4a2285bfbcce997f22c1a8e9cf762071e7e0' },
  { name: 'ggml-cpu-sse42.dll', size: 1039872, sha256: 'b287ead5996a439c947b1ebc8b111ea18d7d6ccf9539abd4e9ce7db5bd7523ce' },
  { name: 'ggml-cpu-x64.dll', size: 1044992, sha256: '04e0fc1fe4b223b047c705510fed8b09264189b1069388d814818b726093c450' },
  { name: 'ggml-vulkan.dll', size: 45598208, sha256: 'b1229fe6f95d423e26c97bd3e4668744f03d90bec749976f4d0c6cfc2dec2d62' },
  { name: 'vcomp140.dll', size: 212920, sha256: '95d4ce4a6802d1e18b5e0e1722cc30ea72ca7e033f83828f05c0b7b993fe7cbf' },
  { name: 'LICENSE-whisper.cpp.txt', size: 1099, sha256: 'bcd8ec749126d45cb06737d0690295d73df4b6e7e194205bcf91190368f27285' },
  { name: 'THIRD-PARTY-NOTICES.txt', size: 508, sha256: '7d269d19ae3481649e2da194313ef483553cdb9520f2bfdadf57a5f50d79eb92' },
  { name: 'BUILD-INFO.txt', size: 588, sha256: '6f52d6867c04d1653af609e69613c3df6389478ebe392347af2e8dc1b3e94c35' },
];

const MANIFEST = deepFreeze({
  schema: 1,
  items: [
    {
      // id は 0.15.0 までと同じ（前から取り込んだ PC は「新しい版」になり、取る間は前の組を使う: RF13）
      id: 'whisper-engine', group: 'whisper', kind: 'zip',
      label: '文字起こしエンジン（whisper.cpp・Vulkan）', version: '1.9.5',
      url: 'https://github.com/Kishi-Satoshi/natsu/releases/download/whisper-vulkan-d1be6fd/whisper-vulkan-bin-x64-d1be6fd.zip',
      size: 20440811, sha256: 'd3d6957113b179667eb770592a544ebc290518c30f29c7952b2b58e8f2614510',
      dir: 'whisper-1.9.5-vk', strip: '', exe: 'whisper-server.exe',
      files: WHISPER_FILES,
      // vulkan: GPU で動かせる組の印（main が GPU の形を試す）。runtime: Visual C++ ランタイムを使わない組の印（照らさない）
      vulkan: true, runtime: 'bundled',
      license: 'MIT（Copyright (c) 2023-2026 The ggml authors）。同梱の vcomp140.dll は Microsoft Visual C++ の再頒布できる部品',
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
  ],
});

/** group（今は 'whisper' だけ）の項目を、取り込む順で返す。知らない組は []。 */
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

module.exports = { MANIFEST, itemsOf, totalBytes, hostOf };
