'use strict';
// wavprep.js — 会議の WAV を、文字起こしの比べに使う形（16kHz・モノラル・16 ビット）にする。
// 文字起こしの比べ（docs/plans/2026-10-27-stt-bench.md）の道具。アプリには組み込まない。
//
//   NaTsu.exe を Node として使う（ELECTRON_RUN_AS_NODE=1。bench-stt.ps1 が呼ぶ）:
//     wavprep.js <入力.wav> <出力のフォルダ> [--max-sec 600] [--chunk-sec 75]
//
// 出すもの（出力のフォルダの中）:
//   full.wav      … 頭から max-sec 秒まで（0 なら全部）を 16kHz・モノラル・16 ビットにしたもの
//   c001.wav …   … full.wav を chunk-sec 秒ずつに切ったもの（NaTsu の PC の文字起こしと同じ 75 秒）
//   meta.json     … 秒数と元の形（数だけ。ファイルの名前は書かない）
// 標準出力には meta.json と同じ中身を1行の JSON で出す。
//
// 読める WAV: PCM の 16・24・32 ビットの整数、32・64 ビットの小数（WAVE_FORMAT_EXTENSIBLE を含む）。
// チャンネルは平均してモノラルにし、窓をかけた sinc で 16kHz へ直す（48kHz・44.1kHz から下げるときに折り返しを入れない）。
// 依存なし（Node の fs と path だけ）。

const fs = require('fs');
const path = require('path');

const OUT_RATE = 16000;

function parseArgs(argv) {
  const pos = [];
  const opt = { maxSec: 600, chunkSec: 75 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max-sec') opt.maxSec = Number(argv[++i]);
    else if (a === '--chunk-sec') opt.chunkSec = Number(argv[++i]);
    else pos.push(a);
  }
  if (!Number.isFinite(opt.maxSec) || opt.maxSec < 0) throw new Error('--max-sec は 0 以上の数');
  if (!Number.isFinite(opt.chunkSec) || opt.chunkSec < 5) throw new Error('--chunk-sec は 5 以上の数');
  return { pos, opt };
}

// RIFF の頭を読み、fmt と data の場所を返す。読む量は頭の 1MB まで（data は後で少しずつ読む）
function readHeader(fd, fileSize) {
  const head = Buffer.alloc(Math.min(fileSize, 1 << 20));
  fs.readSync(fd, head, 0, head.length, 0);
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV ではありません（RIFF/WAVE の頭がありません）。サウンド レコーダーの録音形式を WAV にして録り直してください');
  }
  let p = 12;
  let fmt = null;
  while (p + 8 <= head.length) {
    const id = head.toString('ascii', p, p + 4);
    const size = head.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'fmt ') {
      let format = head.readUInt16LE(body);
      const channels = head.readUInt16LE(body + 2);
      const rate = head.readUInt32LE(body + 4);
      const blockAlign = head.readUInt16LE(body + 12);
      const bits = head.readUInt16LE(body + 14);
      if (format === 0xFFFE && size >= 40) format = head.readUInt16LE(body + 24);   // サブ形式の GUID の頭 2 バイト
      fmt = { format, channels, rate, blockAlign, bits };
    } else if (id === 'data') {
      if (!fmt) throw new Error('fmt の前に data があります');
      // 書きかけの WAV は大きさが 0 や 0xFFFFFFFF のことがある。そのときはファイルの終わりまで
      const left = fileSize - body;
      const bytes = size === 0 || size === 0xFFFFFFFF || size > left ? left : size;
      return { fmt, dataOffset: body, dataBytes: bytes - (bytes % fmt.blockAlign) };
    }
    p = body + size + (size % 2);
  }
  throw new Error('data が見つかりません');
}

function sampleReader(fmt) {
  const { format, bits } = fmt;
  if (format === 1 && bits === 16) return (b, o) => b.readInt16LE(o) / 32768;
  if (format === 1 && bits === 24) return (b, o) => b.readIntLE(o, 3) / 8388608;
  if (format === 1 && bits === 32) return (b, o) => b.readInt32LE(o) / 2147483648;
  if (format === 1 && bits === 8) return (b, o) => (b.readUInt8(o) - 128) / 128;
  if (format === 3 && bits === 32) return (b, o) => b.readFloatLE(o);
  if (format === 3 && bits === 64) return (b, o) => b.readDoubleLE(o);
  throw new Error(`この WAV の形は読めません（形式 ${format}・${bits} ビット）`);
}

// 窓をかけた sinc で inRate → OUT_RATE。入力は少しずつ push し、出力は Int16 の配列に足していく
function makeResampler(inRate) {
  const ratio = inRate / OUT_RATE;                 // 出力1つで進む入力の数
  const fc = Math.min(1, OUT_RATE / inRate) * 0.92; // 切る周波数（入力のナイキストを 1 とした割合）
  const half = Math.ceil(16 / fc);                 // 片側の幅（入力の数）
  let buf = new Float32Array(0);
  let bufStart = 0;                                // buf[0] の入力の番号
  let n = 0;                                       // 次に作る出力の番号
  const out = [];
  let outLen = 0;
  let cur = new Int16Array(1 << 16);
  let curLen = 0;
  const emit = (v) => {
    const s = Math.max(-1, Math.min(1, v));
    cur[curLen++] = Math.round(s * 32767);
    if (curLen === cur.length) { out.push(cur); outLen += curLen; cur = new Int16Array(1 << 16); curLen = 0; }
  };
  // 窓をかけた sinc を表にしておく（1 あたり 256 点。間は直線で補う）。三角関数を毎回呼ぶと 10 分の音声で十数秒かかる
  const RES = 256;
  const table = new Float32Array((half + 2) * RES + 2);
  for (let j = 0; j < table.length; j++) {
    const x = j / RES;
    const w = x >= half + 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * x / (half + 1));   // ハンの窓
    const a = Math.PI * fc * x;
    table[j] = x === 0 ? fc : fc * (Math.sin(a) / a) * w;
  }
  const kernel = (x) => {
    const u = Math.abs(x) * RES;
    const j = Math.floor(u);
    const f = u - j;
    return table[j] + (table[j + 1] - table[j]) * f;
  };
  function run(final) {
    const end = bufStart + buf.length;
    for (;;) {
      const t = n * ratio;
      const c = Math.floor(t);
      if (!final && c + half >= end) break;
      if (t >= end) break;
      if (inRate === OUT_RATE) {
        emit(buf[c - bufStart]);
      } else {
        let acc = 0;
        let wsum = 0;
        for (let i = c - half + 1; i <= c + half; i++) {
          if (i < 0 || i >= end || i < bufStart) continue;
          const k = kernel(i - t);
          acc += buf[i - bufStart] * k;
          wsum += k;
        }
        emit(wsum !== 0 ? acc / wsum : 0);   // 重みの和で割る（端でも音の大きさを変えない）
      }
      n++;
    }
    // 使い終わった頭を捨てる（次に要るのは floor(n*ratio) - half から）
    const keepFrom = Math.max(bufStart, Math.floor(n * ratio) - half);
    if (keepFrom > bufStart) { buf = buf.slice(keepFrom - bufStart); bufStart = keepFrom; }
  }
  return {
    push(block) {
      const nb = new Float32Array(buf.length + block.length);
      nb.set(buf, 0); nb.set(block, buf.length);
      buf = nb;
      run(false);
    },
    finish() {
      run(true);
      const all = new Int16Array(outLen + curLen);
      let o = 0;
      for (const a of out) { all.set(a, o); o += a.length; }
      all.set(cur.subarray(0, curLen), o);
      return all;
    },
  };
}

function wavBytes(samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(OUT_RATE, 24); b.writeUInt32LE(OUT_RATE * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2).copy(b, 44);
  return b;
}

function prepare(input, outDir, opt) {
  const fd = fs.openSync(input, 'r');
  let samples;
  let fmt;
  try {
    const size = fs.fstatSync(fd).size;
    const h = readHeader(fd, size);
    fmt = h.fmt;
    if (!fmt.channels || !fmt.rate || !fmt.blockAlign) throw new Error('fmt の中身が壊れています');
    const read = sampleReader(fmt);
    const bytesPer = fmt.bits / 8;
    let want = h.dataBytes;
    if (opt.maxSec > 0) want = Math.min(want, Math.floor(opt.maxSec * fmt.rate) * fmt.blockAlign);
    const rs = makeResampler(fmt.rate);
    const frames = 1 << 16;
    const raw = Buffer.alloc(frames * fmt.blockAlign);
    let done = 0;
    while (done < want) {
      const len = Math.min(raw.length, want - done);
      const got = fs.readSync(fd, raw, 0, len, h.dataOffset + done);
      if (got <= 0) break;
      const nf = Math.floor(got / fmt.blockAlign);
      const mono = new Float32Array(nf);
      for (let f = 0; f < nf; f++) {
        let s = 0;
        const base = f * fmt.blockAlign;
        for (let ch = 0; ch < fmt.channels; ch++) s += read(raw, base + ch * bytesPer);
        mono[f] = s / fmt.channels;
      }
      rs.push(mono);
      done += nf * fmt.blockAlign;
      if (nf === 0) break;
    }
    samples = rs.finish();
  } finally {
    fs.closeSync(fd);
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) if (/^(full|c\d{3})\.wav$/.test(f)) fs.unlinkSync(path.join(outDir, f));
  fs.writeFileSync(path.join(outDir, 'full.wav'), wavBytes(samples));
  const per = Math.round(opt.chunkSec * OUT_RATE);
  let chunks = 0;
  for (let i = 0; i < samples.length; i += per) {
    chunks++;
    fs.writeFileSync(path.join(outDir, `c${String(chunks).padStart(3, '0')}.wav`), wavBytes(samples.subarray(i, Math.min(samples.length, i + per))));
  }
  let peak = 0;
  let sq = 0;
  for (let i = 0; i < samples.length; i++) { const v = Math.abs(samples[i]); if (v > peak) peak = v; sq += v * v; }
  const rms = samples.length ? Math.sqrt(sq / samples.length) / 32768 : 0;
  const meta = {
    sec: Math.round((samples.length / OUT_RATE) * 10) / 10,
    chunks, chunkSec: opt.chunkSec,
    inRate: fmt.rate, inChannels: fmt.channels, inBits: fmt.bits, inFormat: fmt.format,
    peakDbfs: peak ? Math.round(20 * Math.log10(peak / 32768) * 10) / 10 : null,
    rmsDbfs: rms ? Math.round(20 * Math.log10(rms) * 10) / 10 : null,
  };
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 1) + '\n');
  return meta;
}

module.exports = { prepare, readHeader, makeResampler, wavBytes, OUT_RATE };

if (require.main === module) {
  try {
    const { pos, opt } = parseArgs(process.argv.slice(2));
    if (pos.length !== 2) { console.error('使い方: wavprep.js <入力.wav> <出力のフォルダ> [--max-sec 600] [--chunk-sec 75]'); process.exit(2); }
    console.log(JSON.stringify(prepare(pos[0], pos[1], opt)));
  } catch (e) {
    console.error(`WAV を直せませんでした: ${e.message}`);
    process.exit(1);
  }
}
