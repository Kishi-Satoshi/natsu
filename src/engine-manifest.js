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
