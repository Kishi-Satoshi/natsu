'use strict';
// 意図した移動の台帳（第1b回 N2・F9）。ゲート（tools/risk.js）の「枠からの離脱」は、離脱の組（同じ枠を失った id の集まり）のうち
//   ファイルが file と同じ・失った枠の名札の並びが lost と同じ・組の id が全部 ids に入る
// ものだけを WARN「意図した移動」にする。それ以外の離脱は今までどおり BLOCK。
// 行を足す・広げるときは test/gate.test.js の「台帳の中身」の行も同じ commit で直す（点検で必ず目に入るように）。
module.exports = [
  { file: 'src/renderer/app.html', lost: ['section#tabNotes.tab.active', 'div.notes'],
    ids: ['mtToggleBtn', 'mtDiscardBtn', 'searchBox', 'fltAll', 'fltActions', 'fltFull', 'plist'],
    why: '第1b回 N2: サイドバーを議事録のタブの外へ出して常設にする（tools/hedit.js move --allow-reparent。設計書「壊さないための注意」）' },
  { file: 'src/renderer/app.html', lost: ['aside#side.side'],
    ids: ['searchBox', 'fltAll', 'fltActions', 'fltFull'],
    why: '第1b2回: 検索の欄と絞り込みを検索の窓へ移す（tools/hedit.js move --allow-reparent）' },
  { file: 'src/renderer/app.html', lost: ['section#tabNotes.tab.active', 'div.notes', 'div#pageWrap.page', 'div.phead', 'div.pcol'],
    ids: ['pActs', 'pMore', 'pMenu'],
    why: '第1b2回: ページの操作を上の帯へ移す' },
  { file: 'src/renderer/app.html', lost: ['section#tabNotes.tab.active', 'div.notes', 'aside.side'],
    ids: ['searchBox', 'fltAll', 'fltActions', 'fltFull'],
    why: '第1b2回: 検索の欄と絞り込みを検索の窓へ移すのを natsu-v0.5.0 から1つの差分で見たときの形（リリースのゲート）' },
  { file: 'src/renderer/app.html', lost: ['section#tabNotes.tab.active', 'div.notes', 'div#pageWrap.page', 'div.phead'],
    ids: ['pActs'],
    why: '第1b2回: ページの操作を上の帯へ移すのを natsu-v0.5.0 から1つの差分で見たときの形（リリースのゲート）' },
  { file: 'src/renderer/app.html', lost: ['div.app', 'div.col'],
    ids: ['tabSettings', 'appearanceCard', 'appearanceTitle', 'themeSel', 'accountCard', 'accountTitle', 'accountOut', 'accountSignIn', 'accountIn',
      'accountWho', 'accountLogout', 'accountMsg', 'verNow', 'chkUpdBtn', 'applyUpdBtn', 'updMsg', 'updNotes', 'hotkey', 'hotkeyWarn',
      'meetingHotkey', 'meetingHotkeyWarn', 'pillPos', 'micSelect', 'micReloadBtn', 'useSystemAudio', 'spkField', 'spkNow', 'spkReloadBtn',
      'spkSettingsBtn', 'language', 'autoPaste', 'removeFillers', 'soundFeedback', 'autoLaunch', 'stayInTray', 'dictionary', 'dictWarn',
      'useBuiltinTerms', 'claudeState', 'claudeTest', 'claudeLogin', 'claudeInstall', 'claudeHelp', 'claudeExe', 'onlineMsg', 'engineState',
      'testBtn', 'testMsg', 'testSumMsg', 'engineNote', 'engineFetch', 'engineFetchSummary', 'engineFetchBar', 'engineFetchBtn', 'engineFetchPause',
      'engineFetchSwitch', 'engineDirBtn', 'engineFetchCopy', 'engineFetchMsg', 'engineFetchList', 'engineFetchRows', 'engineAdv', 'localServerExe',
      'pickExeBtn', 'localModelPath', 'pickModelBtn', 'localThreads', 'localPort', 'useVad', 'vadState', 'vadModelPath', 'pickVadBtn', 'suppressNst',
      'sumServerExe', 'pickSumExeBtn', 'sumModelPath', 'pickSumModelBtn', 'sumThreads', 'sumPort', 'sumCtx', 'testSumBtn', 'segmentSec',
      'engineIdleMin', 'saveMsg', 'openDataBtn'],
    why: '0.9.0 U-1（SP1・設計書 D24）: 設定の section（#tabSettings。中身は動かさない）を、<main> から体の直の子の設定のポップアップ（#settingsModal > .setbox）へ移す（tools/hedit.js move --allow-reparent）' },
];
