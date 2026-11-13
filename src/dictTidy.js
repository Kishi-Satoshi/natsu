'use strict';
// つなぎ言葉の決まり（0.14.0 DQ-1 で口述の整えの部品として作った。計画 docs/plans/2026-10-26-140.md の決めたこと 45〜51・R45・R46）。
// 0.15.1 ND-1（D114・計画 docs/plans/2026-11-04-151.md の決めたこと 10）から、会議の区間の文のつなぎ言葉の決まり dropFillers だけ。
// 口述の整え（tidyRules・tidyGuard・linesToText・tidyBody）は音声入力と一緒に消した。ファイルの名前は変えない（前の版の変異 dq-filler-same・dq-meeting の file）。
//   dropFillers  … つなぎ言葉を除く決まり（0.13.x までの main.js の決まりを同じ字のまま移した。会議の区間の文もこれを通るので、答えは1文字も変えない）
//   LEAD_MARK    … 中継の整えの口（relay/tidy.mjs。0.15.0 までのアプリが呼ぶので変えない: WQ6）の頭の印の形の写し。アプリの中では使わない。
//                  中継の写しが同じ字であることを test/relay-tidy.test.js が照らすので残した（0.15.1 の R23）
// 通信もファイルも触らない。

// ---------------------------------------------------------------- つなぎ言葉（決めたこと 45。ただの「あの」「その」は除かない）
function dropFillers(text) {
  let t = text;
  const patterns = [
    /(?:えー+っ?と+|えっ?と+|ええと+|ええっと+)[、,。.\s]*/g,
    /(?:えー+|えぇ+ー*)[、,\s]*/g,
    /(?:あのー+|あのう+|そのー+|そのう+)[、,\s]*/g,
    /(?:うー+ん(?:と+)?|んー+と?)[、,\s]*/g,
    /\b(?:u+m+|u+h+|erm+|hm+)\b[,\s]*/gi,
  ];
  for (const p of patterns) t = t.replace(p, '');
  return t.replace(/、{2,}/g, '、').replace(/。{2,}/g, '。')
    .replace(/(^|。)、+/g, '$1').replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// 0.14.0 DQ-4 直し（R205）: 箇条書き・番号の行の頭の印。中継（relay/tidy.mjs）の LEAD_MARK と同じ字（test/relay-tidy.test.js）。0.15.1 からアプリの中では使わない（R23）
const LEAD_MARK = /^(?:[・•●]\s*|[-*+]\s+|[0-9０-９]{1,3}[.)．）](?![0-9０-９])\s*)+/;

module.exports = { dropFillers, LEAD_MARK };
