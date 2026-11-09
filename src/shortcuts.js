'use strict';
// NaTsu の窓の中の近道の表（0.14.0 Task EK-5。計画 docs/plans/2026-10-26-140.md の決めたこと 38・U3・R70 (G4)）。純粋（何も読まない）。
// 設定の［一般］の「NaTsu の窓の中の近道」の表と、ヘルプの近道の表（EK-7）は、この表から作る・この表と照らす（1か所に）。
// 行は { keys（見せるキー。別のキーは「・」で区切る）, what（動き）, where（効く所）, codes（行の近道 keyAction が受けるキー。
// 「Ctrl+Shift+Digit7」の形の ev.code の組。keyAction の受けないキーは空） }。効く所ごとに続けて並べる（設定の表は効く所の見出しで区切る）。
// 全体の音声入力のキーは設定の［音声入力ホットキー］なので、この表に入れない（設定の表の下に一言）。
// 0.15.0 PH-5（計画 docs/plans/2026-11-03-150.md の決めたこと 20・26・28・BQ7 (a)）: Ctrl+Shift+N（新しいページの選び）・Ctrl+Shift+U（親のページへ）と、サイドバーのページの一覧のキーの行を足した。
// 0.16.0 DV-1（計画 docs/plans/2026-11-04-160.md の決めたこと 51）: データベースの表のセルを選んでいるときのキーの行を足した。
// 0.16.0 DV-4（2026-11-09 の持ち主の承認・R90）: 同じ所の Ctrl+C・Ctrl+V・Ctrl+Shift+V（DV-2 で作ったキー）と Space（行のページを開く）の行を足した。
// 0.16.0 R96（2026-11-09 の持ち主の答え「足す…（おすすめ）」）: ビューのタブを選んでいるときの ←・→・Home・End の行を足した。
// 画面（app.html）はこの表を写す（test/stage140.app.test.js が同じ行かを照らす）。

const SHORTCUTS = Object.freeze([
  { keys: 'Ctrl+W', what: '選んでいるタブを閉じる（窓は閉じません）', where: '窓のどこでも', codes: [] },
  { keys: 'Ctrl+Tab・Ctrl+Shift+Tab', what: '次・前のタブへ', where: '窓のどこでも', codes: [] },
  { keys: 'Ctrl+P', what: '検索の窓を開く', where: '窓のどこでも', codes: [] },
  { keys: 'Ctrl+Shift+N', what: '新しいページを作る（白紙のページか議事録を選ぶ）', where: '窓のどこでも', codes: [] },
  { keys: 'Ctrl+Shift+U', what: '開いているページの親のページへ（いちばん上のページでは何もしない）', where: '窓のどこでも', codes: [] },
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
  { keys: '↑・↓', what: '選ぶ行を替える', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Shift+↑・Shift+↓', what: '選ぶ行を広げる・狭める', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Backspace・Delete', what: '選んだ行を消す', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Ctrl+C・Ctrl+X・Ctrl+V', what: '選んだ行を写す・切り取る・後ろに貼り付ける', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Ctrl+D', what: '選んだ行を複製する', where: '要約の行を選んでいるとき', codes: ['Ctrl+KeyD'] },
  { keys: 'Ctrl+Shift+↑・Ctrl+Shift+↓', what: '選んだ行を上・下へ動かす', where: '要約の行を選んでいるとき', codes: ['Ctrl+Shift+ArrowUp', 'Ctrl+Shift+ArrowDown'] },
  { keys: 'Ctrl+Shift+0〜7', what: '選んだ行の型をまとめて変える', where: '要約の行を選んでいるとき', codes: ['Ctrl+Shift+Digit0', 'Ctrl+Shift+Digit1', 'Ctrl+Shift+Digit2', 'Ctrl+Shift+Digit3', 'Ctrl+Shift+Digit4', 'Ctrl+Shift+Digit5', 'Ctrl+Shift+Digit6', 'Ctrl+Shift+Digit7'] },
  { keys: 'Ctrl+/', what: '選んだ行のメニューを開く（削除・複製・変換・色）', where: '要約の行を選んでいるとき', codes: ['Ctrl+Slash'] },
  { keys: 'Ctrl+A', what: 'ページの行を全部選ぶ', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Ctrl+Z', what: '元に戻す', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Ctrl+Shift+Z・Ctrl+Y', what: 'やり直す', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Enter', what: '選んだ行の文に戻って直す', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Tab', what: '選びを外して、欄の外の次の部品へ', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Shift+Tab', what: '選びを外して、［AI 要約］のタブへ', where: '要約の行を選んでいるとき', codes: [] },
  { keys: 'Esc', what: '選びを外して ⠿ へ', where: '要約の行を選んでいるとき', codes: [] },
  // 0.15.0 のサイドバーのページの一覧（木の決まり: 決めたこと 20）
  { keys: '↑・↓', what: '見えているページの行を上・下へ移る', where: 'サイドバーのページの一覧', codes: [] },
  { keys: '→', what: '行を開く（開いていれば最初の中のページへ）', where: 'サイドバーのページの一覧', codes: [] },
  { keys: '←', what: '行を閉じる（閉じていれば親のページへ）', where: 'サイドバーのページの一覧', codes: [] },
  { keys: 'Home・End', what: '最初・最後の行へ', where: 'サイドバーのページの一覧', codes: [] },
  { keys: 'Enter', what: 'ページを今のタブで開く', where: 'サイドバーのページの一覧', codes: [] },
  { keys: 'Ctrl+Enter', what: 'ページを新しいタブで開く', where: 'サイドバーのページの一覧', codes: [] },
  { keys: 'Shift+F10', what: '行のメニューを開く（中にページを作る・移動先・新しいタブで開く・削除）', where: 'サイドバーのページの一覧', codes: [] },
  // 0.16.0 DV-1 のデータベースの表（決めたこと 51）
  { keys: '↑・↓・←・→', what: 'セルを移る', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  { keys: 'Tab・Shift+Tab', what: '右・左のセルへ', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  { keys: 'Home・End', what: '行の頭・末のセルへ', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  { keys: 'Ctrl+Home・Ctrl+End', what: '表の頭・末のセルへ', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  { keys: 'Enter', what: 'セルを書く（書いている間は Enter で決める）', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  { keys: 'Esc', what: 'セルの選びをやめる（書いている間は、書いた文字を捨てる）', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  { keys: 'Delete・Backspace', what: '選んだセルを空にする（書けるセルだけ）', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  { keys: 'Ctrl+C', what: '選んだセルの値を写す', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  { keys: 'Ctrl+V・Ctrl+Shift+V', what: '選んだセルに貼る（何行何列かは右下へ埋める）', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  { keys: 'Space', what: '行のページを開く', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  { keys: 'Ctrl+Z', what: '元に戻す', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  { keys: 'Ctrl+Shift+Z・Ctrl+Y', what: 'やり直す', where: 'データベースの表のセルを選んでいるとき', codes: [] },
  // 0.16.0 R96（2026-11-09 の持ち主の答え）: データベースのビューのタブのキー（DV-3 直しの R89 (F6) で作ったキー）
  { keys: '←・→', what: 'となりのビューへ（端では反対の端へ）', where: 'ビューのタブを選んでいるとき', codes: [] },
  { keys: 'Home・End', what: '最初・最後のビューへ', where: 'ビューのタブを選んでいるとき', codes: [] },
].map((r) => Object.freeze({ ...r, codes: Object.freeze(r.codes) })));

module.exports = { SHORTCUTS };
