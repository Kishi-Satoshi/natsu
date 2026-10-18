'use strict';
// 意図した移動の台帳（第1b回 N2・F9）。ゲート（tools/risk.js）の「枠からの離脱」は、離脱の組（同じ枠を失った id の集まり）のうち
//   ファイルが file と同じ・失った枠の名札の並びが lost と同じ・組の id が全部 ids に入る
// ものだけを WARN「意図した移動」にする。それ以外の離脱は今までどおり BLOCK。
// 行を足す・広げるときは test/gate.test.js の「台帳の中身」の行も同じ commit で直す（点検で必ず目に入るように）。
module.exports = [
  { file: 'src/renderer/app.html', lost: ['section#tabNotes.tab.active', 'div.notes'],
    ids: ['mtToggleBtn', 'mtDiscardBtn', 'searchBox', 'fltAll', 'fltActions', 'fltFull', 'plist'],
    why: '第1b回 N2: サイドバーを議事録のタブの外へ出して常設にする（tools/hedit.js move --allow-reparent。設計書「壊さないための注意」）' },
];
