'use strict';
// 0.16.0 R121（f58b2bb の CI の mutate-2: 元のままの確かめが 600 秒で切られ、どのファイルが止まっていたかが記録に無かった）。
// node --test の報告の道具（--test-reporter に渡す）。ファイルが走り始めたとき・終わったときに1行ずつ、すぐに出す。
//   # natsu-file start <ファイル> <ms>
//   # natsu-file done <ファイル> <ms> <かかった ms>
// <ms> はこの道具が動き始めてからのミリ秒。<ファイル> は今の場所からの相対（/ 区切り）。
// node --test は終わったファイルの結果を「ファイルの名前の順」に溜めてから出す（前のファイルが終わるまで後ろのファイルの TAP は出ない）ので、
// TAP だけでは止まったファイルの名前が分からない。ファイルの頭の dequeue（走り始め）と complete（終わり）は溜めずにすぐ届く（Node 22・24）。
const path = require('path');

const fileOf = (d) => {
  if (!d || d.nesting !== 0 || typeof d.file !== 'string' || typeof d.name !== 'string') return null;
  return path.resolve(d.name) === path.resolve(d.file) ? d.file : null;   // ファイルそのものの印（名前がファイルのパス）
};
const rel = (f) => path.relative(process.cwd(), f).split(path.sep).join('/');

module.exports = async function* fileTimes(source) {
  const t0 = Date.now();
  const started = new Set();
  for await (const ev of source) {
    const f = fileOf(ev && ev.data);
    if (!f) continue;
    if (ev.type === 'test:dequeue' && !started.has(f)) {
      started.add(f);
      yield `# natsu-file start ${rel(f)} ${Date.now() - t0}\n`;
    } else if (ev.type === 'test:complete') {
      const d = ev.data.details && Number(ev.data.details.duration_ms);
      yield `# natsu-file done ${rel(f)} ${Date.now() - t0} ${Math.round(Number.isFinite(d) ? d : 0)}\n`;
    }
  }
};
