'use strict';
// help-public.js — ヘルプに出す文の公開前の確認（G-21。help-relnotes の審査 A-3・Ruling R-RN4）
//
// 記事（test/help-content.test.js）とリリースノートの元（tools/lib/help-relnotes.js が CHANGELOG.md に当てる）の両方が、この1か所の形を使う。
// 伏せ字（<名前>・%USERNAME%・＜名前＞）のパスと、パッケージ@版（electron@44.9.0）は当たらない。

/** [正規表現, 何か] の一覧。1行ずつ当てる */
const PUBLIC = [
  [/(?<![\w-])[a-z0-9-]+\.cloudflareaccess\.com/i, 'チームのドメインの字面（<チームの名前> と書く）'],
  [/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i, '64 字の16進（AUD の見かけ）'],
  [/[A-Za-z]:\\{1,2}Users\\{1,2}(?![<%＜])/i, '個人の Windows のパス（伏せ字は <名前>・%USERNAME%）'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, '半角の @ のメール（＠ は全角で書く）'],
];

module.exports = { PUBLIC };
