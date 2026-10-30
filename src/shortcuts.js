'use strict';
// NaTsu の窓の中の近道の表（0.14.0 Task EK-5。計画 docs/plans/2026-10-26-140.md の決めたこと 38・U3・R70 (G4)）。純粋（何も読まない）。
// 設定の［一般］の「NaTsu の窓の中の近道」の表と、ヘルプの近道の表（EK-7）は、この表から作る・この表と照らす（1か所に）。
// 行は { keys（見せるキー。別のキーは「・」で区切る）, what（動き）, where（効く所）, codes（行の近道 keyAction が受けるキー。
// 「Ctrl+Shift+Digit7」の形の ev.code の組。keyAction の受けないキーは空） }。効く所ごとに続けて並べる（設定の表は効く所の見出しで区切る）。
// 全体の音声入力のキーは設定の［音声入力ホットキー］なので、この表に入れない（設定の表の下に一言）。Ctrl+Shift+N は入れない（BQ8: 0.15.0 で決める）。
// 画面（app.html）はこの表を写す（test/stage140.app.test.js が同じ行かを照らす）。

const SHORTCUTS = Object.freeze([
  { keys: 'Ctrl+W', what: '選んでいるタブを閉じる（窓は閉じません）', where: '窓のどこでも', codes: [] },
  { keys: 'Ctrl+Tab・Ctrl+Shift+Tab', what: '次・前のタブへ', where: '窓のどこでも', codes: [] },
  { keys: 'Ctrl+P', what: '検索の窓を開く', where: '窓のどこでも', codes: [] },
  { keys: 'Ctrl+Shift+P', what: '録音の一時停止・再開', where: '窓のどこでも', codes: [] },
  { keys: 'Ctrl+\\', what: 'サイドバーを畳む・出す', where: '窓のどこでも', codes: [] },
  { keys: 'Ctrl+Shift+L', what: 'ライトとダークを切り替える', where: '窓のどこでも', codes: [] },
  { keys: 'Ctrl+＋・Ctrl+－・Ctrl+0', what: '拡大・縮小・元の大きさ（200% まで）', where: '窓のどこでも', codes: [] },
  { keys: 'Esc', what: '設定を閉じる（設定の検索の欄に文字があるときは、文字を消す）', where: '設定', codes: [] },
  { keys: 'Ctrl+Z', what: '元に戻す', where: '要約の行を直しているとき', codes: [] },
  { keys: 'Ctrl+Shift+Z・Ctrl+Y', what: 'やり直す', where: '要約の行を直しているとき', codes: [] },
  { keys: 'Ctrl+B・Ctrl+I・Ctrl+U・Ctrl+Shift+S・Ctrl+E', what: '選んだ文字を太字・斜体・下線・取り消し線・コードにする（もう一度押すと外す）', where: '要約の行を直しているとき', codes: ['Ctrl+KeyB', 'Ctrl+KeyI', 'Ctrl+KeyU', 'Ctrl+Shift+KeyS', 'Ctrl+KeyE'] },
  { keys: 'Ctrl+K', what: '選んだ文字にリンクを付ける', where: '要約の行を直しているとき', codes: ['Ctrl+KeyK'] },
  { keys: 'Ctrl+Shift+H', what: '選んだ文字に、最後に使った色を付ける', where: '要約の行を直しているとき', codes: ['Ctrl+Shift+KeyH'] },
  { keys: 'Ctrl+Shift+V', what: '文字だけを貼り付ける（行や飾りに変えない）', where: '要約の行を直しているとき', codes: [] },
  { keys: 'Ctrl+Shift+0〜6', what: '行の型を変える（0 テキスト・1〜3 見出し1〜3・4 ToDo・5 箇条書き・6 番号付き）', where: '要約の行を直しているとき', codes: ['Ctrl+Shift+Digit0', 'Ctrl+Shift+Digit1', 'Ctrl+Shift+Digit2', 'Ctrl+Shift+Digit3', 'Ctrl+Shift+Digit4', 'Ctrl+Shift+Digit5', 'Ctrl+Shift+Digit6'] },
  { keys: 'Ctrl+D', what: '行を複製する', where: '要約の行を直しているとき', codes: ['Ctrl+KeyD'] },
  { keys: 'Ctrl+Shift+↑・Ctrl+Shift+↓', what: '行を上・下へ動かす', where: '要約の行を直しているとき', codes: ['Ctrl+Shift+ArrowUp', 'Ctrl+Shift+ArrowDown'] },
  { keys: 'Ctrl+/', what: '行のメニューを開く', where: '要約の行を直しているとき', codes: ['Ctrl+Slash'] },
  // 0.13.1 の近道（字下げ・開け閉め・トグル: G4）
  { keys: 'Tab', what: '行を上の行の中に入れる（字下げ）', where: '要約の行を直しているとき', codes: [] },
  { keys: 'Shift+Tab', what: '字下げを1段戻す', where: '要約の行を直しているとき', codes: [] },
  { keys: 'Ctrl+Enter', what: 'ToDo のチェックを付ける・外す。トグルを開く・閉じる', where: '要約の行を直しているとき', codes: ['Ctrl+Enter', 'Ctrl+NumpadEnter'] },
  { keys: 'Ctrl+Alt+T', what: 'ページのトグルをまとめて開く・閉じる', where: '要約の行を直しているとき', codes: ['Ctrl+Alt+KeyT'] },
  { keys: 'Ctrl+Shift+7', what: '行をトグルにする', where: '要約の行を直しているとき', codes: ['Ctrl+Shift+Digit7'] },
  // 0.14.0 の行の選び（E9）
  { keys: 'Esc', what: '行を選ぶ（もう一度押すと選びを外して ⠿ へ）', where: '要約の行を直しているとき', codes: [] },
  { keys: 'Ctrl+A', what: '行の文字を全部選ぶ（もう一度押すとその行を選び、さらにもう一度でページの行を全部選ぶ）', where: '要約の行を直しているとき', codes: [] },
  { keys: 'Shift+↑・Shift+↓', what: '選ぶ行を広げる・狭める', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Backspace・Delete', what: '選んだ行を消す', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Ctrl+C・Ctrl+X・Ctrl+V', what: '選んだ行を写す・切り取る・後ろに貼り付ける', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Ctrl+D', what: '選んだ行を複製する', where: '要約の行を選んでいるとき', codes: ['Ctrl+KeyD'] },
  { keys: 'Ctrl+Shift+↑・Ctrl+Shift+↓', what: '選んだ行を上・下へ動かす', where: '要約の行を選んでいるとき', codes: ['Ctrl+Shift+ArrowUp', 'Ctrl+Shift+ArrowDown'] },
  { keys: 'Ctrl+Shift+0〜7', what: '選んだ行の型をまとめて変える', where: '要約の行を選んでいるとき', codes: ['Ctrl+Shift+Digit0', 'Ctrl+Shift+Digit1', 'Ctrl+Shift+Digit2', 'Ctrl+Shift+Digit3', 'Ctrl+Shift+Digit4', 'Ctrl+Shift+Digit5', 'Ctrl+Shift+Digit6', 'Ctrl+Shift+Digit7'] },
  { keys: 'Ctrl+/', what: '選んだ行のメニューを開く（削除・複製・変換・色）', where: '要約の行を選んでいるとき', codes: ['Ctrl+Slash'] },
  { keys: 'Ctrl+A', what: 'ページの行を全部選ぶ', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Enter', what: '選んだ行の文に戻って直す', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Esc', what: '選びを外して ⠿ へ', where: '要約の行を選んでいるとき', codes: [] },
].map((r) => Object.freeze({ ...r, codes: Object.freeze(r.codes) })));

module.exports = { SHORTCUTS };
