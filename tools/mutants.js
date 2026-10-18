'use strict';
// 変異の一覧（第1a回 G3）。tools/mutate.js が1つずつリポジトリの写しに当て、tests が赤になる（殺せる）かを見る。
// 各回の計画の「変異確認」の表（直しを1つ戻すと、どのテストが赤になるか）を、ここに足していく。
//   id    … 名前（重ならない）
//   file  … 当てるファイル（リポジトリの根からの相対）
//   from  … 今のファイルにちょうど1回ある文字（0 回や2回以上なら「古い」で NG）
//   to    … 置き換える文字（直しを戻した形）
//   tests … 赤になるはずのテストのファイル
//   why   … 守っているもの

module.exports = [
  { id: 'cite-min-chars', file: 'src/cite.js', from: 'return normalize(text).length >= MIN_CITE_CHARS;', to: 'return normalize(text).length > MIN_CITE_CHARS;',
    tests: ['test/cite.test.js', 'test/pipeline.test.js'], why: '出典の照合の対象にする短さの境（6 字ちょうどの行も照合する）' },
  { id: 'cite-max-per-line', file: 'src/cite.js', from: 'const MAX_CITES_PER_LINE = 4;', to: 'const MAX_CITES_PER_LINE = 5;', tests: ['test/cite.test.js', 'test/pipeline.test.js'], why: '要点1行の出典の上限' },
  { id: 'store-search-max', file: 'src/store.js', from: 'const SEARCH_TEXT_MAX = 20000;', to: 'const SEARCH_TEXT_MAX = 4000;', tests: ['test/store.test.js', 'test/stage3.store.test.js'], why: '長い要約の後半も検索に出す（#44）' },
  { id: 'main-memo-max', file: 'src/main.js', from: 'const MEMO_MAX = 1500;', to: 'const MEMO_MAX = 15000;', tests: ['test/limits.test.js'], why: 'メモが文脈を食い潰さない上限（今のテストでは生き残るので、この Task で limits.test.js を足す）' },
  { id: 'lib-estimate-tokens', file: 'src/mainlib.js', from: "  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 2.5);", to: "  return Math.ceil(Buffer.byteLength(String(text ?? ''), 'utf8') / 5);", tests: ['test/main.test.js', 'test/stage3.main.test.js'], why: '分割要約の長さの見積もり' },
  { id: 'lib-fold-notes', file: 'src/mainlib.js', from: '    if (cur.length && used + t > budget) { out.push(cur); cur = []; used = 0; }', to: '    if (cur.length && used + t >= budget * 2) { out.push(cur); cur = []; used = 0; }', tests: ['test/main.test.js', 'test/stage3.main.test.js'], why: '要点メモを畳む分け目（#41）' },
];
