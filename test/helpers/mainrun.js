'use strict';
const { titleAt } = require('./titles');
// main.js を偽の Electron の上で実際に動かし、記録 → 区間 → 文字起こし → 議事録の保存までを通す。
// 1 回の実行で 1 つの場面だけを試す（main.js はモジュールの中に状態を持つので、場面ごとに
// 別のプロセスにする）。結果は最後の行に JSON で出す。使い方:
//   node test/helpers/mainrun.js <FAKE_MODE> [--test] [--test-during] [--silent] [--vad] [--segs=N]
//     FAKE_MODE     … fake-whisper.js の答え方（text / empty / prompt-empty / mixed / err200 / probe500 など）
//     --test        … 記録の前に設定の［起動テスト］（app:test）を呼ぶ
//     --test-during … 最初の区間を送った直後（文字起こしの最中）に［起動テスト］を呼ぶ
//     --silent      … 区間の音声を無音にする（既定は 220Hz の音）。0.9.1 Q-2 から --recover の下書きの音声と音声入力の音声にも効く
//     --blip        … 0.9.1 Q-2: 区間の音声を「--blip-sec 秒（既定 15）の無音の真ん中に 0.6 秒の小さな音（振幅 261。窓の RMS 約 -45 dBFS）」にする
//                     （短い小さな発言。区間全体の RMS は -55 dBFS より小さい）。--recover の下書きの音声と音声入力の音声（3 秒）にも効く
//     --vad         … VAD のモデル（偽物）をモデルの隣に置く（エンジンが --vad 付きで起動する）
//     --open-help=<JSON> … 0.9.2 I-1: 起動の後に app:open-help を引数の並びの並び（例 [[],["record/pause"]]）で順に呼び、out.openHelp・out.external（shell.openExternal の住所）を書いて終わる
//     --segs=N      … 送る区間の数（既定 2。1 つ目は 3 秒、2 つ目からは 2 秒）
//     --kotoba      … 偽のモデルの名前を kotoba-whisper のものにする（認識ヒントを渡さない場面）
//     --port=N      … 文字起こしエンジンのポート（並べて走らせるとき、呼ぶ側が重ならないように決めて渡す）
//     --discard-during … 最初の区間を送った直後に議事録を破棄する（返事を待つ間の破棄）
//     --discard-settled … --discard-during と組む。最初の区間が片付く（meeting:status の pending が 0）のを待ってから破棄する
//                        （第1d回 A-6 の点検: 止まりの見張りで控えた WAV が、破棄で消えるかを見る）
//     --after-retry … 議事録を写した後、会議の後の送り直し（認識に失敗した区間の待ち行列）が済むまで待ち、その後の区間・
//                     engine.log・要求を out.afterRetry（{ segments, engineLog, requests }）に写す（送り直しまで含めて数える場面）
//     --after-dict  … 記録の後で辞書を保存し、認識ヒントの状態を聞き直す
//     --sum         … 要約エンジン（helpers/fake-llama.js）も置く。要約は文字起こしに無い担当・期限を混ぜて返す
//     --sum-port=N  … 要約エンジンのポート（--port と同じく、呼ぶ側が重ならないように渡す）
//     --set-type-during=T … 要約の途中で会議タイプを T に手で選び直す（要約は 1.5 秒かかる）
//     --text=…      … 偽の文字起こしエンジンが返す文（既定は「本日の議題は進捗の確認です。区間N」）
//     --managed     … 詳細設定を空にし、取り込んだ組で文字起こしする（第0b回 設計 B）。engine-small の小さな組を本物の
//                     installZip・recordInstalled で %LOCALAPPDATA%（一時フォルダ）の natsu\engine に置き、main からは
//                     engineRoot（取り込める PC か）と MANIFEST だけを差し替える。取り込んだ exe の代わりに偽の whisper を起動する
//     --managed-tamper … --managed と同じ組の whisper.dll を、大きさを変えずに書き換える（照らしで合わず、起動しない。RF3）
//     --recover     … 前回落ちた会議の下書き（文字起こし待ちの区間 1 つと、その音声）を置いて起動し、復旧の文字起こしを待って終える
//                     （記録はしない。--managed と組み合わせると、照らし終えた後に復旧が動くかを見る）
//     --slow-ack=<cmd>:<ms> … main の db.call(<cmd>) の答えを、DB が書き終えた後、main に返す前に ms だけ止める（CI の直し:
//                     混んだ機械では、復旧のページが DB に入ってから main が recovery.json を書くまでに間が空く。その間に「待ち行列が無い」を
//                     「済んだ」と読まないことを見る）
//     --no-vc-runtime … --managed と組み合わせる。Visual C++ ランタイムが無い PC にする（RF4）。whenReady の後で System32 を
//                     空のフォルダに向け、Windows の外では process.platform を win32 と読ませる（main.js の engineRuntimeIssue は
//                     Windows でだけ DLL を読む）。記録はせず、engine:status・起動テスト・記録の開始の答えを見る。
//                     その後で System32 に 14.51 の DLL を置き（担当がランタイムを入れた）、起動し直さずに起動テストをもう一度押す
//     --verify-throws … --managed と組み合わせる。照らし（verifyCandidates）が例外を投げる。記録はしない
//     --repair      … --managed-tamper と組み合わせる。installed.json を同意済みにし、engine-small の偽のサーバーを開いたままにして、
//                     起動のときの照らしで壊れていた組を main が取り直し（fake-net の net.request で）、照らし直してから使うのを見る（Task 14）
//     （--sum-tamper は 0.10.0 LS-3（D59）で外した: 要約の組を取り込まない）
//     --retired-sum … 0.10.0 LS-4: 取り込みの置き場所（LOCALAPPDATA の下）に 0.9.x の形の要約の組（小さな表の llama-b11669 と gemma のモデル）を置き、
//                     engine-install.retireSum をその小さな表で呼ぶ。--idle のときは「要約のエンジンを消す」の記録が出るまで待ち、out.savedSettings を足す。
//                     --keep-user-data の2回目の起動では settings.json を置き直さない（retiredSumNotified を残す）
//     --no-engine=fetchable|unsupported … 詳細設定の文字起こしを空にし、何も取り込んでいない PC にする。fetchable は取り込める PC、
//                     unsupported は取り込めない PC（engineRoot だけを差し替える）。記録はしない
//                     （第1d2回 M-1: --relay・--offline・--signed-out・--dictate・--local-only と組んだときは記録しない早い分かれ道に入らず、
//                     議事録・音声入力の場面を回す。エンジンの子は起こさない。会議が始まらなかったら（start.ok が偽）、区間を送らずに
//                     start・notices・engineLog・spawns と中継の写し（sttOut）を出して終える）
//     --kill-main-after-kept … 第1d2回 M-2: --relay-seq と組む。区間が片付くたびに下書きを見て、音声を残した区間（kept）が書かれていたら
//                     main ごと落ちる（process.exit(3)。結果は出さない）。--keep-user-data と組んで、次の起動の復旧を見る
//     （第1d2回 M-2: --relay-seq の場面は、区間ごとに片付くまで待った時間（ミリ秒）を out.segWaitMs に順に残す。--relay の場面の
//     out.pages[].keys は DB の発言の欄の名前（区間ごと。ページに kept の印が入っていないかを見る））
//   第1d2回 M-3（戻ったら文字起こしする）: 60 秒ごとの見回り（setInterval の名前 retryKeptWhenBack）を拾い、待たずに呼べるようにする（keptTicks）
//     --back-after … 議事録を写した後、中継の答えを c に・net.isOnline() を true にして見回りを1回呼び、待ち行列と要約が済むのを待って
//                     out.afterBack（{ pages, engineLog, relayCalls, notices, claudeCalls, files }）に写す
//     --ticks-offline=<n> … 議事録を写した後、net.isOnline() を false にして見回りを n 回呼び、増えた記録と中継への要求を out.ticksOffline に
//     --extra-queue=localonly … 起動の前に、PC の中だけの会議の下書き（draft-<開始時刻>.json。文字起こし待ちの区間 1 つと、その WAV）を置く。
//                     起動の復旧がページと待ち行列（localOnly: true）を作る。名前は --recover の draft.json より前に並ぶ（先に復旧される）
//     --extra-queue-late=localonly … --idle と組む。起動の片付けが済んだ後に、PC の中だけの待ち行列（WAV 1つと recovery.json）と、そのページ
//                     （main の DB の客で meeting.recover）を置く
//     --kept-ticks=<n> … --idle と組む。起動の片付けの後（--extra-queue-late の後）に見回りを n 回呼び、待ち行列が落ち着くのを待つ
//     --relay-req-text=<c|e の並び> … 中継に届いた文字起こしの要求の i 番目の答えを i 文字目にする（relay-local の setReqText）
//     --login-after … 議事録を写した後、画面と同じ account:login でログインし、待ち行列が済むのを待って out.afterLogin
//                     （{ login, pages, engineLog, relayCalls, keptTicks（見回りを呼んだ数） }）に写す
//     （--idle の出力に engineLog・requests（偽の whisper の inference）・stt・relayCalls・files を足す）
//   第1d2回 M-4: --local-only-after=<n> … n 区間が片付いた後（n+1 区間目を送る前）に meeting:set-local-only を呼ぶ（out.localOnly に答え、
//     out.statusLocalOnly に押した後の meeting:status の localOnly・cloud、out.statusNeedsSetup に needsSetup）。--local-only も out.statusNeedsSetup を出す。
//     --back-after の out.afterBack に queues（segbuf の下の recovery.json ごとの { localOnly, items: 区間の数 }）を足す
//   第1d2回 M-5（音声入力の音声を残す）: --relay-seq は音声入力にも効く（i 回目の音声入力の音声を送る前に i 文字目）。音声入力の場面の出力に
//     overlayPhases（録音バーへ送った overlay:phase の順）と files を足す
//     --dictate-twice … 音声入力を2回続けて行う。--max-history=<n> … 置く設定の maxHistory を n にする
//     --dict-back … 音声入力の後、中継の答えを c にして見回りを1回呼び、out.dictBack（{ history, pastes, notices, files, engineLog }）に写す
//     --dict-delete・--dict-clear … 音声入力の後に、残した行を history:delete で消す（out.afterDelete）・history:clear で全部消す（out.afterClear）
//     --old-dictwait … 起動の前に 8 日前の名前の WAV を data/dictwait に置く。--done-dictwait … 起動の前に、文字の入った履歴の行（wait 無し）と
//     同じ id の名前の WAV を置く（--idle の出力に history を足した）
//     --fetch-consent … 第1d2回 M-1: --no-engine=fetchable と組む。取り込み先の installed.json を consent: true（組は無い）で置く
//                     （取り込みのボタンを押したが、まだ何も取り込めていない PC。「選んだ」人）
//   第1d2回 M-1〜M-5 の点検で足した:
//     --installed-unreadable … --no-engine=fetchable と組む。installed.json を読めない（ウイルス対策が掴んでいる）PC にする
//                     （engine-install の readInstalled が印 unreadable の空の記録を返す。jsonfile の待ちは通さない）
//     --local-only-at-retry=<n> … --relay-seq と組む。n 区間目（1 から）の答え方を中継の前で 800 ミリ秒止め（delay-stt）、その区間が中継で
//                     文字になって並べ直した最初の残した区間の要求を main が出したところで（2つ目の並べ直しは segChain で待っている）
//                     meeting:set-local-only を押す（out.localOnly）
//     --dict-back=delete … 見回りの文字起こしの要求を中継の前で止め、その間に残した行を history:delete で消してから、見回りの済むのを待つ
//     --dict-back=readonly … 見回りの間だけ history.json を読み取り専用にする（履歴を保存できない）
//     --wait-dictwait … 起動の前に、文字起こし待ちの履歴の行（wait あり）と同じ id の名前の WAV を data/dictwait に置く
//     --extra-queue-late=cloud … --extra-queue-late=localonly と同じ形で、PC の中だけでない待ち行列を置く
//                     （--idle --kept-ticks の見回りの前に、--relay-seq の1文字目の答え方にする）
//     --dict-rename-busy-once … 音声入力の音声を残す一時ファイル（.wav.tmp）の名前の変更を1回だけ EPERM にする（ウイルス対策が掴んだ）
//     --fetch       … 何も取り込んでいない取り込める PC で、設定の［エンジンを取り込む］（engine:fetch-start）を押す（第0b回 Task 14）。
//                     engine-small の小さな組を 127.0.0.1 の偽のサーバーから、Electron の net.request の偽物（fake-net）で取り込み、
//                     組がそろうたびに main が照らして切り替えるのを見る（文字起こしのモデルだけ、大きさの床 50MB を超える本物の中身）。
//                     main からは engineRoot・MANIFEST と、係の http の許し（requireHttps: false）・空きの測り方だけを差し替える
//     --crash       … --managed と組み合わせる。照らし終えた組で起動した文字起こしエンジンが、ウイルス対策に DLL を消されて
//                     0xC0000135（3221225781）で落ちる（Linux のプロセスはこの番号で終われないので、最初の起動だけ 'exit' を
//                     その番号で出す偽の子にし、その前に whisper.dll を消す）。同意済みで偽のサーバーを開いたままにし、
//                     main が照らし直して使うのをやめ、取り直してから使い直すのを見る（第0b回 Task 14・RF3）
//     --crash-ok    … --crash と同じ落ち方だが、ファイルはそのまま（照らし直して合う: ランタイムの案内のまま、組は使い続ける）
//     --slow-load   … 画面の読み込みを、起動のときの照らしが済むまで終えない（読み込み中に送った知らせは画面に届かない。
//                     main は読み終えてから送る: noticeMainWin）
//     --json-scene=名前 … 第1a回の保存の守りの場面（helpers/json-scenes.js）。readyResolve() の直後に分かれ、場面が済んだら出力して終える。
//                     - 場面の files（userData からの相対パス → 中身。関数なら { base, userData } を受け取る。
//                       base = { localServerExe, localModelPath, localPort, sumPort }）を、ふだんの settings.json の代わりに置く。
//                       prepare(userData) があれば置いた後に呼ぶ。env があれば main.js を読む前に process.env に入れる。
//                     - engine が無い場面は --no-engine=unsupported と同じ（取り込めない PC。エンジンは起こさない: 手のパスがあっても
//                       偽の子を返すだけ）。engine が真なら、手で設定した偽の whisper を本当に起こし、起動を待つ。
//                     - 部品の待ち（jsonfile の sleepSync）を何もしない関数にする（読み直しの約1秒・名前の変更のやり直しの約0.5秒を、
//                       場面ごとに待たない。待ちの長さは jsonfile.test.js が見る）。
//                     - faults（helpers/faulty-fs.js の rules）があれば、src/ の中のファイルが読む fs にだけ faultyFs(faults) を渡す。
//                     - dbDelayMs があれば、main の db.call（DB の客）の答えをその分だけ遅らせる（DB のプロセスの返事がさらに遅いとき）。
//                     - setTimeout に渡された retrySettingsRead・retryHistoryRead・retryDraftRecovery は走らせずに timers[名前] に入れる。
//                     - 画面の読み込みは --slow-load と同じで、窓が2つ（録音バー・本体）できた後に読み終える（起動の知らせは
//                       did-finish-load で送られる）。
//                     - act(ctx) を呼ぶ。ctx = { handlers, listeners, app, wins, power, timers, clearedTimers, shortcuts, store, jsonfile, electron, userData,
//                       read(rel), waitFor(cond, ms), sleep, toneWav(sec), out, launches, launchPlan, fakeKids }。fakeKids は engine の無い場面で
//                       main が起こそうとしたエンジンの偽の子（{ cmd, kills }。kill() を呼ばれた回数）。app・窓・power（powerMonitor）は on／once で受け口を覚え、
//                       emit(ev, …) で呼べる。窓は setPosition の値を getPosition で返し、作ったときに app の browser-window-created を
//                       出す。wins は作った順（createOverlay が先、createMainWindow が後）。read(rel) は無ければ null、あればバイト。
//                     - 出力（最後の行の JSON）: scene・notices（app:notice の文）・files（userData の下のファイルの相対パス。区切りは /。
//                       engine.log と segbuf の WAV も含む）・settingsText・historyText（無ければ null）・engineLog（時刻を落とした行）・
//                       spawns・themeSource・windows（作った窓の数）と、act が out に入れたもの（同じ名前なら act のもの）。
//                     - 第1b回 Task A-2: 場面の local（%LOCALAPPDATA%＝一時フォルダからの相対パス → 中身）を main.js を読む前に置き、
//                       displays（無ければ 1920×1080 が1つ）を偽の screen が返す。ctx に mainWin（本体の窓 = wins[1]）・
//                       readLocal(rel)・localAppData を足す。本体の窓は act が normal（getNormalBounds の値）・bounds（getBounds の値）・
//                       minimized を入れられ、webContents は on／once／emit で受け口を呼べる。出力に windowOpts（本体の窓を作ったときの
//                       x・y・width・height・minWidth・minHeight・backgroundColor）・maximizeCalls・zooms（setZoomFactor の値の順）・
//                       winStateText（<LOCALAPPDATA>/natsu/window-state.json の中身。無ければ null）・localFiles（区切りは /）を足す。
//                     - 第1b回 Task A-3: 録音バーの窓（wins[0]）の executeJavaScript は、main.js の PAUSE_ENSURE_ON・PAUSE_ENSURE_OFF と
//                       同じ文だけを受けて偽の録音バーで本物と同じに動く（場面の overlayPause: 'lost-once'・'late'）。ctx に releasePause()、
//                       出力に overlayJs（流された文の 'on'／'off' の順）・overlayPaused（偽の録音バーの状態）・balloons を足す。
//     --stt=<mode>  … 第1c回 A-4: オンラインの文字起こし。127.0.0.1 の偽の送り先（helpers/fake-stt.js）を mode の答え方で開き、
//                     secrets.json に偽の鍵（偽の safeStorage の暗号）を openai の名前で置く。0.7.0 U-1（設計書 D5）から送り先は OpenAI に
//                     固定なので、偽の Electron の net.request が https://api.openai.com/v1 を偽の送り先へ書き換える（out.netHosts に
//                     書き換える前の宛先のホストを残す）。mode が cert のときは、OpenAI への要求に
//                     net::ERR_CERT_AUTHORITY_INVALID を返す（makeFakeRequest の before。fake-stt の答え方は text）
//     --consent=ask|off … 前の版（0.6.0 まで）が書いた cloudTranscribe をその値で置く（--stt と組む。0.7.0 では読まれないことを見る）
//     --legacy-provider … 前の版が書いた送り先 sttProvider: 'custom'・sttBaseUrl: 偽の送り先・sttModel: 'whisper-large-v3' を置く（読まれないことを見る）
//     --key-for=<id> … 鍵を openai でなくその名前（groq・custom）で置く（ほかの送り先の鍵を OpenAI へ送らないことを見る）
//     --no-key      … secrets.json を置かない
//     --key-unreadable … 偽の safeStorage の decryptStringAsync が投げる（鍵のファイルはあるが復号できない）
//     --offline     … net.isOnline() が false
//   0.10.0 LS-2（D59・決めたこと 103〜105。要約は Claude Code だけ・要約待ち・つながったら自動で作る）
//     --summary-offline … Claude Code に届かない（net.isOnline() が false から始まる。--offline と同じ形で、文字起こしは手元）。
//                     届くかの覚え（online.js）は false の答えを覚えないので、戻したらすぐ届く
//     --summary-online-after=<ms> … --summary-offline と組む。議事録を写した後 ms 待って net.isOnline() を true にし、見回り（retryKeptWhenBack）を
//                     2回呼ぶ。それぞれの後の { pCalls（偽の claude の -p の数）, pages（議事録の場面のページの形） } を out.summaryBack に順に積む
//     --summary-reconnect … --summary-online-after と組む。続けて net.isOnline() を false にして見回りを1回、true に戻して見回りを1回呼び、
//                     その後の形を out.summaryBack に足す（つながり直し）
//     --local-only  … 記録を始めた後、最初の区間の前に［この会議は PC の中だけ］を押す（画面と同じ IPC の meeting:set-local-only。
//                     out.localOnly にその返事、out.statusLocalOnly に押した後の meeting:status の localOnly と cloud）。
//                     --recover と組むと、置く下書きに localOnly: true を書く
//     （議事録の場面では、記録を始めた直後の meeting:status の cloud をいつも out.statusCloud に入れる）
//     --dictate     … 議事録の代わりに音声入力を1回（ホットキー → audio:done）。out.history に履歴
//     --focus-main-during-dictation … 0.9.0 U-1（SP2・RF9）: --dictate と組む。本体の窓は前にない形で始め（--main-unfocused と同じ）、
//                     音声入力の録音中に本体の窓へ focus、続けて blur を送る。out.escape に globalShortcut の Escape の付け外しの順、
//                     out.escapeAt に録音の始め・focus の後・blur の後・終わりのそれぞれで Escape が付いていたか
//     --no-whisper  … 設定の whisper の実行ファイルを無いファイルにする
//     --no-whisper-after-start … 0.9.0 B-2（F14）: 議事録の記録を始めた直後に、偽のモデル（この場面が作ったもの）を消す（会議の途中で手元の
//                     エンジンが使えなくなった形。NATSU_E2E_MODEL の本物のモデルとは組めない: 消さずに止める）
//     --claude=<mode> … 第1c回 B-3: オンラインの要約。設定の claudeExe を偽の claude（helpers/fake-claude.js）に向け、FAKE_CLAUDE_MODE に
//                     mode を、FAKE_CLAUDE_LOG に記録のファイルを置く（spawn は偽の whisper と同じく node で台本を起こす）。
//                     mode が missing か、--claude が無ければ claudeExe を無いファイルに向ける（Claude Code が入っていない PC。PATH を探さない）。--stt と組むと、Anthropic へ
//                     届くかの確かめが偽の送り先に届いてオンラインになる（--stt が無ければ、確かめは fake-net の守りで死んで手元になる）
//     --claude-delay=<ms> … 0.10.0 LS-2: --claude=slow の偽の claude が -p に答えるまでの待ち（FAKE_CLAUDE_DELAY）
//     --claude-auth=<method> … 偽の claude の auth status が返す authMethod（FAKE_CLAUDE_AUTH。既定 claude.ai）
//     --set-type-live=<鍵|auto>[,…] … 0.11.0 M-4: 録音中（最初の区間の後）に meeting:set-type を呼ぶ（--live-memo=<文> があれば先に meeting:set-memo）
//     --quality=<all|on|off> … 0.11.0 Q-3: 設定 qualityScore。--resum-quality=<…> … 要約の後にその設定にして［要約を再生成］（out.qualityBefore・out.resum）
//     --resum-after-edit … 0.13.0 点検4: 要約の後に画面の役で行を1つ消して［要約を再生成］（out.editedBefore・out.resumEdit・out.editedAfter）
//     --legacy-general … 0.11.0 P-12: 要約の後、ページを前の版で手で一般・その他を選んだ形（meetingType 'general'・typeAuto 偽）にして［要約を再生成］（out.legacyGeneral）
//     --claude-stdin … 0.12.0 SP-4: 偽の claude の記録に標準入力の全文（stdinText）を書かせる（--claude と一緒に使う）
//     --sum-md=<名前> … 0.11.0 M-3: 偽の claude が返す要約の Markdown を test/fixtures/summaries/<名前>.md にする（--claude と一緒に使う）
//     --db-down     … 第2a1回 M-2b: 議事録の DB のプロセス（偽の utilityProcess の中の本物の server.js）の SQLite が trigram を持たない
//                     （helpers/no-trigram.js を子の中で先に読む）。自分の確かめが通らず、DB は「使えない」で起きる。場面の dbDown でも同じ
//   第2a1回 M-3（録音と DB のつなぎ）の旗。どの場面でも、main の客の頼み（call: 'call'・'ack'・'fail'、send: 'send'）と、下書きを書くたび
//   （'draft'。pageId と区間の数）・clearDraft（'clearDraft'）を順に out.trace へ残す（--draft-trace はその場面の印。中身は同じ）
//     --kill-db-during … 最初の区間が文字起こしされて下書きに書かれ、写しとして DB に届いたら、DB の子を思わず落ちたことにする（fork.crash）。
//                        録音は続ける（客が起こし直す）
//     --kill-main-during … 同じ所で main ごと落ちる（process.exit(3)。結果は出さない。DB の子も一緒に止まる）
//   0.12.0 SP-3a（計画 docs/plans/2026-10-22-120.md）: 2つの流れの議事録（偽の録音バーがマイクと相手の声の区間を4つ目つきで送る）
//     --two-streams=<名前かパス> … test/fixtures/streams/<名前>.json（か JSON のパス）の並びで、偽の時計を1こま（既定 100ms）ずつ進め、
//                     main が overlay:level-ask を送ったこま（main の askLevel の setInterval は拾って本物の時計では回さない）だけ
//                     { mic, sys, warn, vMic, vSys, segMic, segSys, sysOk } を答え、overlay:cut（その流れの今の番号）か区間の時計（最初は 20 秒・
//                     その後は main が言った長さ）で、その流れの区間を締めて { buffer, durationMs, final, meta: { src, seg, t0, last } } を送る。
//                     区間の WAV は声ありのこまが 220Hz の音（振幅 amp）・声なしのこまが quietAmp（既定 0）で、末尾の3つの標本 [3, -3, 番号] に
//                     文の番号を入れる（--relay=tagged の偽の OpenAI はその番号の文を返す）。最後に止め、両方の流れの最後を送る（後の方に final）。
//                     並びの欄: tick・mic・sys（「v40 -10」のような声あり v・なし - のこまの数の並び）・amp・quietAmp・texts（{ mic: [...], loopback: [...] }。
//                     流れごとの区間の順の文。無ければ区間ごとに違う文）・sysLostAt（ms。その時に相手の声の取り込みが切れる: 先に overlay:source
//                     false、その後に相手の声の区間を last で送る）・drift（区間ごとに長さを短く言う ms）・noT0（t0 を送らない）・
//                     pauseAt・pauseMs（一時停止）・sysBack（一時停止の再開で相手の声をまた取り込めた）・killAt（その時に最初の区間が DB に入るのを
//                     待って main ごと落ちる）・badMeta（最初の区間の4つ目を壊す）・badLevel（奇数のこまの答えを壊す）・say（[{ src: 'mic'|'loopback', at, text }]。
//                     その流れの区間のうち at を含む区間の文。texts より先）・silentText（{ mic: true } ならその流れの区間の文を全部空に）・
//                     sourceSays（false なら、相手の声の区間を送るのに overlay:source は取り込めなかったと言う: main の照らしを見る）
//                     lastOrder（'mic-first' なら止めた後にマイクの最後を先に送り、lastGapMs（既定 500）待ってから相手の声の最後を送る。点検の直し C1）・
//                     dropLast（'loopback' なら相手の声の最後を送らない: main の締めの待ちの見張りを見る。main の twoFinalWait の時計は 2 秒で回し、
//                     言った長さを out.two.finalWaitMs に書く）
//                     出力に two（{ asks, asksPaused, cuts, meetingLevel, quietAsked, sent: [{ src, seg, t0, durationMs, bytes, last, final }] }）を足す
//     --sys-lost-at=<ms> … 並びの sysLostAt と同じ（並びより先に効く）
//     --kill-main-at-begin … 録音を始めて、始めたときの写し（meeting.begin）が DB に届いたら、区間を1つも送らずに main ごと落ちる
//                        （process.exit(3)。発言の無い下書きと空の写しが残る。M-3 の点検で足した）
//     --purge-save-fail-once … 取り消しの控え（purge-pending.json）の最初の書き込みを1回だけ EPERM にする（ウイルス対策が掴んだ。M-3 の点検で足した）
//     --keep-draft-after-finalize … 締めの返事（meeting.finalize の ack）の後の最初の clearDraft で、下書きの unlinkSync を1回だけ EPERM にする
//                        （ウイルス対策が掴んだ。store.clearDraft は失敗を黙って飲むので、下書きが残る）
//     --keep-user-data=<フォルダ> … userData をこのフォルダにし、終わっても消さない（2回の起動で同じ userData を使う）。フォルダに data/ が
//                        もうあれば --recover は下書きを置かず、そこにある下書きを復旧させる（out.draftPageIdBefore にその pageId）
//     --set-title-during=T … 要約の途中（1.5 秒）に、画面と同じ口（ctx.appCall）で題名を T に直す。--set-title-after-sum=T は要約の後に直す
//     --secret-text  … 偽の文字起こしが「秘密の語を含む発言です区間N」を返す。--discard-during と組むと、その語が写しとして DB に届くまで
//                      待ってから取り消す（out.secretSeen）。どの議事録の場面でも、出力の dbHas に終わる前の natsu.db と -wal のバイトに
//                      その語（「秘密の語」）があったか
//     --kill-db-at-discard … --discard-during と組む。取り消す直前に DB の子を落とし、取り消しの返事を待たずに（起こし直す前に）終える
//     --idle         … 記録しない。起動の片付け（取り消しの残りの送り直し・下書きの復旧・meeting.settle）が済むのを待って、ページと dbHas を出す
//   第1d回 A-9（RL16・RF41）: 更新の再起動の守りの場面
//     --restart-during=meeting|dictation|finalizing|idle … 偽の app に relaunch（回数を out.relaunches、そのときの DB の客の状態を
//                        out.relaunchDb に残す）・exit（何もしない）・getAppPath（一時フォルダの下の書ける空のフォルダ）を足し、main の
//                        updater.apply（取り込み）を、回数を out.applyCalls に数えて { ok: true } を返すだけの偽物にする。
//                        meeting    … 議事録の最初の区間を送った直後（録音中）に app:restart（out.restart）と update:apply（out.apply）を呼ぶ。
//                                     録音はそのまま続けて締める（今の議事録の場面と同じ出力）
//                        dictation  … --dictate と組む。音声入力の録音中（out.restartRecording）と、音声が届いて文字起こし中
//                                     （out.restartProcessing）に app:restart、続けて update:apply（out.apply）を呼ぶ
//                        finalizing … 偽の DB（fake-utility の holdReply）が締めの返事（meeting.finalize）を止める。止めている間に
//                                     録音の状態（out.stateHeld）・app:restart（out.restartHeld）・update:apply（out.applyHeld）を見て、離して
//                                     要約の結果まで待ってから app:restart（out.restartAfter）を呼んで終える（out.pages・engineLog）
//                        idle       … 記録せずに update:apply（out.apply）と app:restart（out.restart）を呼んで終える
//                        closing    … （A-9 の点検）main の db.close を止めたまま app:restart を呼び、閉じている間に会議（meeting:toggle の答えを
//                                     out.startWhileClosing、会議のホットキーの後に会議中かを out.meetingWhileClosing）と音声入力のホットキー
//                                     （録音バーの overlay:start の回数を out.overlayStartsWhileClosing）を試す。離して out.restart まで待って終える
//   第1d回 A-2（RL10）: ログインの場面
//     --relay=<mode> … 本物の中継のコード（relay/）を 127.0.0.1 で動かす（helpers/relay-local.js。後ろの偽の OpenAI は fake-stt の mode）。
//                        偽の Electron の net.request が src/relay.js の RELAY_BASE を中継の口へ書き換え、書き換える前の道（/auth/start など）を
//                        順に覚える。場面の ctx に relay = { mail(local, domain), setFront(mode), db, calls() } を足す（codeFor は第1d回 W-6 で外した）
//                        （calls() は覚えた道の写し。setFront は relay-local の中継の前の答え方: '' ・'drop'・'html401'）
//     --no-store     … 偽の safeStorage の isAsyncEncryptionAvailable が false（暗号にできない PC。secrets.js は保存を断る）
//   第1d回 A-3（RL11）: 文字起こしを中継へ送る場面。--relay の議事録・音声入力・復旧の場面は、main を読む前にログインの種をまく
//   （A-11 から: 偽の Access が出した cookie を packCookies でまとめ、偽の safeStorage の暗号で secrets.json の relay に置く）。settings.json の
//   accountEmail にそのメールを書く。json の場面は scene.relaySeed のときだけ種をまく（access-ipc はログインしていない形から）
//     --relay=<mode> の mode は fake-stt の答え方（text・500・slow・429・429-long・quota・badjson・drop・drop-first）のほか、
//                        daily-cap（中継の DAILY_USER_SEC を 4）・daily-cap-all（DAILY_ALL_SEC を 4）・upstream-auth（偽の OpenAI が 401）・
//                        foreign401（中継の前が HTML の 401: setFront('html401')）・415（中継の前が文字起こしの口にだけ 415 not-wav）・
//                        cut-first（中継の前が最初の文字起こしの要求だけを返事せずに切る）・lag（第1d回 A-5: 中継の前が文字起こしの要求を
//                        300 ミリ秒止める。待ちが積もる背圧の場面）
//     --signed-out   … ログインの種をまかない（ログインしていない PC）
//     --revoked      … 種をまいた cookie の人を、main を読む前に偽の Access で取り消す（A-11 から。Access の前が 401: ログインが切れた PC）
//     --relay-down   … RELAY_BASE を、だれも聞いていない 127.0.0.1 の口へ書き換える（中継が落ちている・届かない）
//     --relay-cert   … RELAY_BASE への要求は net::ERR_CERT_AUTHORITY_INVALID で死ぬ（会社の通信の検査が証明書を差し替えた）
//     --key-for=<id> … --relay と組むと、前の版の鍵（groq・openai・custom）も secrets.json に置く（中継へ送らないことを見る）
//   第1d回 A-4（F11・K2）
//     --old-keys     … secrets.json に 0.7.0 までの鍵（groq・openai・custom。平文は json-scenes.js の OLD_KEY_TEXT）を足し、
//                        退けた控え secrets.json.broken-2026-10-01T00-00-00-000Z も置く（起動のときに purgeOld が消すことを見る）
//   第1d回 A-11（RL10・F20・F21・F22・F26・F27）: ログインは Cloudflare Access の窓。--relay はいつも relay-local の偽の Access の前を置き
//   （startRelayLocal({ access: true })）、種まきは札でなく cookie: main を読む前に偽の Access が出した CF_Authorization を relay.packCookies で
//   まとめ、偽の safeStorage の暗号で secrets.json の relay に置く（--revoked は種の人を偽の Access で取り消す: rl.revokeAt）。
//   偽の Electron に session.fromPartition を足す（名前ごとに helpers/fake-net.js の makeFakeSession。setPermissionRequestHandler・
//   setPermissionCheckHandler・on('will-download') を覚える。名前が persist: で始まれば、本物と同じく userData の下に Partitions のフォルダを作る）。
//   窓を作ると app の 'web-contents-created' を出し（security.install の守りが付く）、webContents.session はその partition の偽の session。
//   ログインの partition の窓（偽のログインの窓）は loadURL で、そのときの動き（--access-login・ctx.access.mode）のとおりに出来事を起こす:
//     ok        … Access のホストへのフォームの送り（will-navigate）と /auth/done への転送（will-redirect）を起こし、偽の Access がその人
//                 （r.mail('kaigi')）に出した CF_Authorization と、しまってはいけない cookie（CF_AppSession・親のドメインの CF_Authorization・
//                 ほかのホストの cookie）を partition に置いてから did-navigate（/auth/done・200）
//     denied    … 同じだが、cookie は会社のドメインでない人のもの（/v1/me が 403 denied）
//     nocookie  … cookie を置かずに did-navigate 200
//     denied403・notready … did-navigate が 403・503
//     failload  … did-fail-load（-130 ERR_PROXY_CONNECTION_FAILED・本体の枠）
//     wander    … 許していないホスト（https://evil.example/phish）への will-navigate（本体の枠）
//     other-team … natsu-test.cloudflareaccess.com への will-navigate（通るはず。窓をそのホストに留める）の後、other-team.cloudflareaccess.com への
//                 will-redirect（本体の枠。止めるはず。止めなければ窓を閉じる）。出力の窓ごとの otherTeamPrevented
//     cancel    … 利用者が窓を閉じる（'closed'）
//     hold      … 何も起こさない（ctx.access.close() で閉じるまで開いたまま）
//     unreadable … 窓の動きは ok のまま、偽の safeStorage の復号が ctx.access.allowDecrypt() まで失敗する（起動のときに復号できない: F26）
//   --relay-expired … 種の cookie の期限が切れている（起動で消して L3・B3: F19）、--old-token … 種が nt1_ の札（起動で消して記録1行）
//   出力に loginWins（作ったログインの窓ごとに { webPreferences, modal, parent, width, height, title, show, openHandler（新しい窓を頼んだ答え）,
//   accessFormAllowed, redirectAllowed, wanderPrevented, shown, closed }）・loginWin（最初の1つか null）・cookiesOnDisk（userData の下に Partitions が
//   あるか）・accessPerms（ログインの partition の権限の頼み・確かめ・ダウンロードの答え）を足す。ctx.access = { mode(m), wins(), close(), cookies(),
//   allowDecrypt(), mail, navProbe() }（navProbe は A-11 の点検: 本体の窓・録音バー・開いているログインの窓に、ログインの窓なら通す移動を起こし、通したかを返す）。ctx.relay.revoke() は偽の Access の取り消し、ctx.relay.block() は種の人を止めたメールにする
//   --relay の議事録・音声入力・復旧の場面の出力に、stt（中継の後ろの偽の OpenAI が受けた要求）・relayCalls（main が中継へ送った道の順）・
//   relayLog（中継の記録の行）・netHosts・secretsRaw・recoveryKept・decrypts・balloons を足す（--stt と同じ形）
//   ctx.relay に revoke()（A-11 から: 偽の Access で種の人を取り消す）・sttRequests()・seededMail・base（中継の口。場面から直に GET /auth/me を聞く）を、ctx に advanceClock(ms)（main の Date.now と
//   中継の試しの時計を ms だけ進める）を足す
//   ctx.setOnline(bool) … 偽の net.isOnline() の答えを場面の途中で変える（--offline の場面は false から始まる）
//   0.9.4 S-2（PC への要求の待ち時間）: 場面を起こす側が NATSU_TEST_LOCAL_TIME_SCALE（0〜1。待ち時間に掛ける）を渡す。
//     --seg-ms=<ミリ秒> … 議事録の区間の長さ（durationMs）をこの値にする（音声のバイトは今のまま）
//     --pace=<JSON> … 起動の前に data/local-pace.json を置く（model: "same" は偽のモデルの名前と大きさ、at: "now-<日>" は日数の前）
//   0.9.4 S-3（音声を失わない）:
//     --recover-again=<n> … 議事録を写した後（--after-retry の後）、設定の保存（settings:save。保留の復旧を引き直す）を n 回。そのたびに
//                     復旧の記録の行（止めました・保留）か待ち行列が無くなるのを 3 秒まで待ち、out.again に { pages, queue（recovery.json の中身）, wavs, requests（増えた要求の数）, log } を写す
//     --delete-pages-then-recover … その後、議事録を全部消して（page.delete）設定を保存し、out.afterDelete に { queue, wavs }
//     --skip-at-stop … 最後の区間を送った後、1 区間が文字になるのを待って meeting:skipPending（out.skip・out.skippedSegs）
//     --wait-queue-empty … 議事録を写した後、待ち行列が無くなるまで待ち、out.afterQueue に { pages, notices, chats（偽の llama の要求の数）, wavs }
//     --extra-queue=localonly3 … --extra-queue=localonly の形で、文字起こし待ちの区間 3 つ
//     out.chatsAtFinalize・out.summaryAtFinalize … 議事録の要約の欄が埋まった（か要約ができた）ときの偽の llama の要求の数と要約の欄。out.queueAfterRetry … --after-retry の後の待ち行列
//   第1d回 A-5（D16）: 区切りの長さの場面
//     --relay-seq=<並び> … 区間 i を送る前に、中継の答え方を並びの i 文字目にし（relay-local の setAnswer: c・n・5・l・u・a・e・L）、
//                        その区間が文字になるか失敗するまで（meeting:status の pending が 0）待ってから次を送る（区間と並びが1対1）。
//                        --relay が無ければ --relay=text と同じ。--segs が無ければ区間の数は並びの長さ
//     出力（議事録の場面と json の場面）に overlaySent（録音バーへ送った overlay:start の payload と overlay:segment-ms の値の、送った順）と
//     order（'overlay:start'・'overlay:segment-ms' と、中継へ送った要求 'relay <道>' の順）を足す。届くかの覚えの長さを縮めるのは、
//     main を起こす側が渡す試しだけの環境変数 NATSU_TEST_ONLINE_MEMO_SCALE（src/online.js）
//   第1d回 A-6（RL14・D17）: 文字起こしの状態の場面
//     出力（議事録の場面）に sttSeen（本体の窓へ送った meeting:update の stt の、前と違ったものだけの並び。会議の外の null は入れない）と sttAt（帯の符号 → その符号が
//     初めて帯になった meeting:update の区間 [{ id, text, failed, wav }]。wav はそのとき segbuf にその区間の WAV があるか）を足す
//     --retry-after=<n> … n 区間を送って片付いた後（n+1 区間目の答え方にしてから、送る前）に、画面と同じ IPC の meeting:retry を
//                        返事を待たずに2回続けて呼ぶ（out.retry に2つの返事）。並べ直した区間が片付く（pending 0）のを待ち、そのときの
//                        stt と区間（sttAt と同じ形）を out.retried に残してから、続きの区間を送る
//     --retry-at-stop … 最後の区間を送った直後（会議を止め、最後の区間を文字起こししている間）に meeting:retry を1回呼ぶ（out.retryAtStop に返事）。
//                        並べ直した区間は最後の区間の後ろに並ぶので、締めが［もう一度］の返事を待つかを見る（A-6 の点検で足した）
//     --relogin-after=<n> … n 区間を送って片付いた後に、画面と同じ IPC の account:login（偽のログインの窓は ok。第1d回 A-11 で
//                        account:start・account:verify から替えた）でログインし直す（out.relogin = { login }）。その直後の meeting:status の stt を out.reloginStt に残す
//   第1d回 A-8（RL15・D17）: 録音中のページが見えないときの Windows の知らせ。偽の Electron に Notification を足し、show() した
//   { title, body } を out.notifications に残す（議事録の場面）。本体の窓（wins[1]）は既定で見えていて前にあり（isVisible・isFocused が true）、
//   会議を始めた後に画面と同じ meeting:live-shown true を送る（録音中のタブを開いた画面と同じ）
//     --main-hidden    … 本体の窓が隠れている（isVisible が false。show() で見える）
//     --main-minimized … 本体の窓が最小化している（isMinimized が true。restore() で戻る）
//     --live-not-shown … 会議を始めた後に meeting:live-shown false を送る（窓は前でも、録音中のページを開いていない）
//     --no-notify      … Notification.isSupported() が false（出せない PC）
//     --click-notify   … 出した知らせを、出した直後に押す（click を起こす）
//     --reload-main    … meeting:live-shown true を送った後に、本体の窓の画面の読み込み直し（did-start-loading）を起こす
//     --main-unfocused … 本体の窓が見えていて最小化もしていないが、前にない（isFocused が false。ほかのアプリで作業している。focus() で前に）
//     --notify-throws  … 偽の Notification の show() が投げる（Windows の知らせが壊れていても、区間を落とさないことを見る）
//     出力に mainWinCalls（本体の窓の show・focus・restore の呼ばれた順。起動の後から）と showLive（本体の窓へ送った meeting:show-live の数）を足す
//   出力に足すもの（議事録の場面）: pages[].id・title・recovered、files（userData の下の相対パス）、dbStarts（DB の子を起こした回数）、trace
//   ctx.appCall(cmd, args) … 画面と同じ役 app の口（客の rendererPort() で作る偽の MessageChannelMain の口）で DB に頼む。書く命令には
//                      'a:' + randomUUID の tx を付ける。答えは result（失敗は Error に .code）。場面（act）にも渡す
//   第2a1回 M-2b: 偽の Electron の utilityProcess.fork と MessageChannelMain は helpers/fake-utility.js のもの（worker_threads の中で
//   本物の src/db/server.js が動き、<userData>/data/natsu.db に書く）。main の客（src/db/client.js の makeDbClient）を捕まえ、
//   場面は DB の用意（ready か down）を待ってから act を呼ぶ（場面の noDbWait なら待たない）。議事録の読み（ctx.store と、この台の store の listPages・getPage・
//   getTranscript）は helpers/dbpeek.js の読み取り専用の接続で natsu.db を見る（下書きなどほかの名前は本物の store のまま）。
//   ctx に dbMeta(key)（natsu.db の meta の値。無ければ undefined）・dbState()（客の state()）・dbCrash(code)（今の DB の子を思わず
//   落ちたことにする: fake-utility の fork.crash）・dbStarts()（DB の子を起こした回数）・mainSent()（本体の窓へ webContents.send した
//   channel の並び。読み込み中で届かなかったものも）を足す。本体の窓の webContents.postMessage
//   は出力の portsSent（{ win: 'main' | 'overlay', channel }）に残す。終わるときは客を閉じてから process.exit する（Windows で
//   一時フォルダの natsu.db を掴んだまま消さない）
//   第2a1回 M-4（移行の窓・毎日の控え）: 偽の Electron に dialog.showMessageBox を足す（場面の dialog: 無い = ［移す］、'quit' = ［今は移さずに
//   終える］、'hold' = ctx.answerDialog(i) まで答えない）。app.quit() は回数を数え、場面の quitEmits なら before-quit を出す。
//   setTimeout の checkDailySnapshot も timers に入れる（場面が自分で呼ぶ）。DB の用意を待つ場面は、main が用意の後に聞く起動の様子
//   （db.status）の返事も待ってから act を呼ぶ（その直後に送る知らせ D2〜D8 を出力に入れる）。ctx に dialogs()・answerDialog(i)・quitCalls()・trace()・
//   snapshotKinds()（snapshot.take を頼んだ kind の順）・mainState()（meeting:status から idle・meeting・meeting-finalizing）・overlayDone()
//   （録音バーの done の文の順）・mainProgress()（本体の窓へ送った meeting:progress の文の順）を足す。出力に dialogs・quitCalled・overlayDone・pages（{ id, title }。act が pages を入れたらそちら）を足す
//   0.7.0 の前の直し（第2a1回 M-4 の残り）: 偽の dialog.showMessageBoxSync（閉じる・終了の確かめ）は { message, detail, buttons } を
//   syncDialogs に順に残し、場面の closeAnswer（無ければ 1 = ［キャンセル］）を返す。ctx に syncDialogs()・powerBlocks()（省電力の抑止の
//   ['start', type, id]・['stop', id] の並び）を足す
//   main を読む前に、いつも process.env に ANTHROPIC_API_KEY と CLAUDE_CODE_OAUTH_TOKEN を置く（課金の変数が子に渡らないことを見る。RF25）。
//   出力に足すもの: claude（偽の claude の記録。無ければ []）・pages[].route・pages[].blocks（型と cites の数だけ）・pages[].citeStat
//   偽の Electron の net.request は、https://api.anthropic.com/ を偽の送り先の /anthropic へ書き換える（--stt と --claude を両方
//   付けたときだけ。--claude の無い場面は、要約の経路の確かめが fake-net の守りで死んで今どおり手元の llama になる。ほかの外の宛先は
//   書き換えず fake-net が死ぬ: 試験が外へ出たら赤）。Tray の displayBalloon は out.balloons に残す。
//   --stt のときの出力に足すもの: stt（偽の送り先の要求の一覧）・pages[].route・balloons・secretsRaw（secrets.json の中身）・
//   recoveryKept（segbuf の下に recovery.json と WAV が残っているか）・decrypts（偽の safeStorage で鍵を復号した回数）。--recover と組むと、復旧が済むか止まるのを待って同じ形で出す
//   0.9.0 B-2（BN2・F14）: オフラインの帯の見張り。main が setInterval に渡す名前 watchOffline の関数を拾い、本物の時計では回さない
//   （何もしない間隔を代わりに渡す: 場面の実際の時間で出し消しが揺れないため。clearInterval は数える）。出力の offlineWatch に
//   { started（拾った数）, cleared（その間隔を止めた数） }
//     --net-seq=<秒:on|off の並び> … 議事録の場面で、偽の時計（会議を始めた時刻 + 秒）を 1 秒ずつ進め、その秒の net.isOnline() の答えを並びの
//                        とおりにして（例 0:on,10:off,13:on。並びの間は前の値のまま）、拾った watchOffline をその偽の時刻で呼ぶ。区間 i は
//                        --net-seg-at の i 番目の秒（無ければ最初に off になる秒の 5 秒後から 5 秒ごと）に送り、片付く（pending 0）まで待つ。
//                        最後の区間は、並びの最後の秒の 12 秒後まで進めてから会議を止めて送る。--no-engine とも組める（記録を始める。
//                        始められなければ out.start を出して終える）。出力に netProblems（[秒, 帯の符号か null] の移り変わり。meeting:status の
//                        stt.problem）と netSegs（送った区間ごとに { s, problem }。片付いたときの帯の符号）を足す。議事録ができた後に
//                        watchOffline をもう1回呼ぶ（本物の間隔なら録音の後 1 秒以内に来る1回。録音していなければ見張りは自分で止まる）
//     --net-seg-at=<秒,秒> … --net-seq の区間を送る秒
//   0.9.0 レーン O（録音バー。計画 docs/plans/2026-10-20-090.md の O-1〜O-4。今の旗の動きは変えない）
//     --settings-json=<名前> … ふだんの settings.json に、json-scenes.js の PILL_SETTINGS[名前] を重ねて置く（前の版の録音バーの位置）。
//                        --keep-user-data のフォルダに settings.json がもうあれば置かない（2回目の起動）。out.settingsBefore に置いた値
//     --displays=<並び> … 偽の screen の画面（x,y,幅,高さ を ; で区切る。作業領域。画面の大きさは高さに 40 を足す）。場面の displays が先
//     --idle と組むと、出力に settings（終わりの settings.json の生の文字）・settingsGet（起動の直後に画面と同じ口で呼んだ settings:get）・
//     engineLog を足す
//     O-2: 録音（議事録か --dictate の音声入力）を始めた直後に、録音バーの画面と利用者の手の代わりをする（panelAct。旗が無ければ何もしない）
//     --panel-size=<w>x<h> … 録音バーの画面から overlay:size（{ w, h }）が来た形にする（--drag-steps が無ければ同じ大きさを2回）
//     --drag-to=<x>,<y> … 録音中に録音バーの窓の中心をその点へ動かし（move）、moved を送る（OS のドラッグの終わり）
//     --drag-steps   … --drag-to の動きを3回の move にし、2回目の後に --panel-size の大きさを送ってから moved
//     --cursor-to=<x>,<y> … 録音を始めた後に偽のカーソルをその点へ動かす（既定は 0,0）
//     出力に overlayBounds（録音バーの窓の setBounds の並び）・overlayForms（送った overlay:form）・overlaySent・panel（boundsAtStartList・afterSize・
//     duringDrag・afterMoved・slotAfter・settingsChanged・patched（本体の窓へ送った settings:patched の並び））を足す。録音バーの窓（wins[0]）は setBounds の大きさと位置を getSize・
//     getPosition・getBounds で返す（作ったときは作ったときの width・height）
//     O-4: --hide-panel … 録音の始めの後に録音バーから overlay:hide-panel を送り、panel.hide.afterHide（meeting:status の panelHidden・
//                        トレイの項目の名前・録音バーの窓の hide／show／showInactive と送った overlay:phase の並び）を写してから、画面から
//                        panel:show を送る（panel.hide.show・afterShow）
//          --hide-panel=error … 隠した後に録音バーからマイクのエラー（audio:error）を送り、panel.hide.afterError を写して終える（結果を出す）
//          --hide-panel=next  … 隠した後に音声入力を取り消して、もう一度ホットキーで始め、panel.hide.afterNext を写す（その後は今の流れ）
//          --hover-panel      … 縦の形の見張り（watchPanelHover。名前で拾う）を偽のカーソルで回す。panel.hover に、横の形の間（ドラッグの前に
//                        カーソルを窓の中へ）の { sent, intervals }・縦の形にした後の intervals・送った overlay:hover の並び（sent）・
//                        隠した後に送った並び（afterHide）・隠した後の見回りで見張りを止めたか（cleared）
//   0.9.1 Q-4（話し声が無いときに自動で止める。計画 docs/plans/2026-10-21-091.md）
//     --quiet-seq=<並び> … 議事録の場面で、, で区切った字を順に行う（今の区間の並びの代わり）。区間: s（2 秒の無音）・t（2 秒の音）・b（3 秒の --blip の音）。
//                        区間の長さ（durationMs。会議の時計）は --quiet-seg-ms（既定 60000）。:<字> で中継の答え方（--relay-seq と同じ字。既定 c）、*<n> でくり返し。
//                        区間はそれぞれ片付く（meeting:status の pending が 0）まで待つ。動き: k（画面と同じ meeting:keep-going。答えは out.keepGoing）・
//                        x（手で止める。最後の区間は空）・X（手で止める。最後の区間は 60 秒の無音）・P（一時停止して偽の時計を 20 分進めて再開）・
//                        d（破棄して、その場で出力して終える）・S（無音の区間を送り、文字起こしが済む前に一時停止する。分けるのは一時停止の間）・R（再開）。main が自分で止めたら（overlay:stop を送ったら）、最後の空の区間を送って並びを止める（out.quietStopAt）。
//                        出力に quietTrace（字ごとに { i, tok, asked（meeting:status の quiet があるか）, active, stopping }）・quietText（初めの quiet.text）・
//                        stopCalls（overlay:stop を送った数）・overlaySeq（送った overlay:phase と overlay:stop の順。stop は { stop: true }）・
//                        notifyClosed（偽の Notification の close() の数）・pageDur（議事録の durationSec と pauses）を足す
//     --auto-stop=off・--auto-stop-min=<n> … 置く settings.json の autoStopQuiet: false・autoStopMin: n
//   0.9.3 M-2〜M-5（会議の検出と音の波。計画 docs/plans/2026-10-22-093.md）
//     --mic-feed=<JSON> … 会議の検出の場面。NATSU_TEST_MIC_WATCH を立て（Windows の外でも main が見張りを起こす）、main が起こす見張りの PowerShell
//                        （-Command の中身に CapabilityAccessManager がある powershell.exe）は本当には起こさず偽の子を返す（stdout に場面が行を書く）。
//                        起動の後に JSON の手順を順に行い、出力して終える（記録の今の流れは回さない）。手順:
//                        ["line", 文]（今の見張りの stdout に1行）・["sleep", ms]・["clock", ms]（偽の時計を進める）・["exit", code]（今の見張りが落ちる）・
//                        ["start"]（画面と同じ meeting:toggle で議事録を始める）・["stop"]（止めて最後の空の区間を送り、idle に戻るのを待つ）・
//                        ["dictate"]（音声入力のホットキーで録音を始める）・["dictate-cancel"]（録音バーの取り消し）・["save", 足す設定]（settings:save）・
//                        ["ipc", 名前, ...引数]（handle なら待って答えを out.ipc に、on なら送るだけ）・["theme", dark]（偽の nativeTheme を変えて updated）・
//                        ["live", bool]（画面の meeting:live-shown）・["quit"]（before-quit と will-quit）・["snap", 名前]（その時の見張りの数などを out.snaps に）・
//                        （0.13.0 ED-5: snap に escape（Escape が全体のホットキーか）・["focus-main"]・["blur-main"]（本体の窓の focus・blur））・
//                        0.9.4 D-1: ["hotkey-meeting"]（会議のホットキー）・["tray-start"]（トレイの［議事録の記録を開始］）・["bar-stop"]（録音バーの［停止］）・["finish"]（止めた後の最後の空の区間を送り、idle に戻るのを待つ）。
//                        ["wait-show", n]（パネルの窓の showInactive が n 回になるまで待つ）・["cursor", x, y]（偽のカーソル）・["minimize"]（本体の窓を最小化して minimize）。
//                        snap には録音バーへ聞いた overlay:level-ask の数（asks）も入る（M-5）
//                        出力: micSpawns（見張りの引数）・micKills・restartDelays（setTimeout の restartMicWatch の ms。5ms 後に本当に呼ぶ）・nudge（パネルの窓の
//                        作ったときの opts・呼んだ関数の並び calls・送った sent）・mainWinCalls・mainSentAll（本体の窓へ送った [channel, 中身]）・engineLog・
//                        notices・settingsText・state（meeting:status の active）
//     --detect=off・--detect-mute=<id,…> … 置く settings.json の meetingDetect: false・meetingDetectMute
//     --dark … 偽の nativeTheme.shouldUseDarkColors を真で始める
//   0.12.1 LV-2〜LV-3（会議を出たら止める。計画 docs/plans/2026-10-24-121.md）
//     --leave=off … 置く settings.json の autoStopLeave: false（設定「会議を出たら自動で止める」がオフ）
//     --mic-feed の手順に足す: ["pause", bool]（画面と同じ meeting:set-paused。偽の録音バーが答える）・["click-notice", n]（n 番目に show() した偽の Notification を押す）・
//                        ["discard"]（画面と同じ meeting:discard）・["db-fail", cmd]（main の客の次の1回のその命令を断る。点検の直し 3）。snap に sentN（本体の窓へ送った数）・notes（偽の Notification の数）。出力に notifications（{ title, body, closed }）・
//                        notifyClosed・pageDur（ページごとの { id, durationSec, pauses }）を足す
//   0.13.0 RDY-1（録音の前のページ。計画 docs/plans/2026-10-24-130.md の第2部）
//     --mic-feed の snap に足す: drafts（下書きのファイルの名前）・draft（最初の下書きの { memo, meetingType }。無ければ null）・dbSent（main の客が
//                        送った・呼んだ DB の命令の名前。中身は入れない）・status（meeting:status の { active, prep }。prep の欄が無ければ 'none'）。
//                        出力に pageMemos（ページごとの { id, memo, meetingType }）を足す
//     --quiet-mic … --quiet-seq の場面でも偽の見張りを起こし、字 T（見張りに mic teams:1）・L（mic -）を足す（どちらも偽の時計を 2 秒進める。Ruling R2）
//   0.10.0 C-2（Claude デスクトップへの MCP の登録。計画 docs/plans/2026-10-20-100.md）
//     app.getPath('appData') は一時フォルダ（日本語と 𠮷）の AppData-Roaming。MCP の場面（--claude-config・--mcp-steps）だけ app.getAppPath() がリポジトリの根
//     --claude-config=<場面> … 起動の前に Claude デスクトップの設定ファイルを置く（none: フォルダだけ・plain: 好みの設定だけ・others: 好みの設定と
//                        ほかのサーバー2つと利用者の控え .bak・bom: others を BOM 付きで・broken: 途中で切れた JSON・array: []・other-natsu: 印の無い natsu・
//                        readonly: others を読み取り専用で・msix: %APPDATA% はフォルダだけで、%LOCALAPPDATA%\Packages\Claude_…\LocalCache\Roaming\Claude に others・noclaude: どちらのフォルダも無い）
//                        0.10.1 CD-2 で足した場面（%LOCALAPPDATA%\Claude-Data\claude_pzs8sxrjxfjjc = data・…\claude_zz9test0000aa = data2。Claude-Data の直の下に README.txt）:
//                        msix-only: 前の場所だけに others・data: 新しい場所に見本と、ほかの道具の控え .rea.backup。前の場所は印 .user-data-left.* だけ・
//                        data-msix: 新しい場所に見本（natsu 無し）・前の場所に others と今の NaTsu の natsu と印・data-two: data と data2 に見本・
//                        roaming-data: %APPDATA%\Claude に others と新しい場所に見本・data-broken: 新しい場所が壊れた JSON・前の場所に others・
//                        msix-broken: 新しい場所に見本・前の場所が壊れた JSON（見本は作った値で、JSON.stringify(v, null, 2)・終わりの改行なし）
//     --data-has-natsu … data-msix の新しい場所の見本にも今の NaTsu の natsu を置く（手で写した形）（0.10.1 CD-2）
//     --claude-race … NaTsu が Claude の設定ファイルを書いた直後に、preferences に鍵を1つ足して書き戻す（Claude が書き戻した形）（0.10.1 CD-2）
//     0.10.1 点検の直し: 場面 three（%APPDATA%\Claude と前の場所に others・新しい場所に見本）・--claude-fail-write=N（Claude の設定ファイルへの N 回目の書き込みを EBUSY）・
//                        --claude-fail-restore（NaTsu の戻しを EBUSY）・--claude-race-before（控えを写した直後・書く前に Claude が書く）・--claude-race-other（1つ目を書いた直後に
//                        前の場所の natsu を消す）・--claude-root=<フォルダ>（%APPDATA% と %LOCALAPPDATA% をその下に。2回目の起動では場面と、--keep-user-data の settings.json を置き直さない）・
//                        手順 ["claude-hide", 場所]・["claude-show", 場所]（Claude のフォルダを隠す・戻す）
//     0.10.1 2回目の点検の直し: 場面 data-link（新しい場所の子が %APPDATA%\Claude へのリンク。Windows はジャンクション）・stale-two（2つの場所に印のある古い natsu）・
//                        none-data（%APPDATA%\Claude はフォルダだけ）・--claude-race-before=N（N 番目の控えの後だけ）・--claude-future-bak・--claude-bak-exist・
//                        --claude-create-after-plan・--claude-race-plan=N・手順 ["claude-busy-reads", N]
//     0.10.1 3回目の点検の直し: 場面 stale-broken（古い natsu と壊れた JSON）・--claude-fail-restore-write（戻しの一時ファイルの書き込みを途中で EBUSY）
//     --mcp-gone  … 置く settings.json に、前に登録した印 mcpRegisteredFor（ファイル 1・版 0.9.4）を書く
//     --mcp-stale … 置く設定ファイルの mcpServers の頭に、場所の違う NaTsu の登録（印あり）を足す
//     --tasklist=<running|stopped|fail> … 偽の execFile が tasklist.exe に答える（動いている・動いていない・失敗）。呼んだ引数を out.tasklistCalls に
//                        （0.10.1 CD-3: 「fail,running,fail」のように並べると呼ばれるたびに順に答える。MCP の場面で旗が無ければ stopped）
//     --packaged・--protocol-default … app.isPackaged を真に・isDefaultProtocolClient を真に（LN-3。呼んだ口は out.protocolCalls）
//     --argv=<JSON> … main を読む前の process.argv（[execPath, ...JSON]。LN-4 のリンクで起こされた形）
//     --mcp-steps=<JSON> … 起動の後に手順を順に行い、出力して終える: ["status"]・["register"]・["unregister"]（mcp: の IPC。答えは out.ipc に）・
//                        ["files", 名前]（その時の設定ファイルを out.snaps に）・["sleep", ms]・["save", 足す設定]（画面と同じ settings:save）・["second-instance", argv]（2つ目の起動）・["ipc-raw", 名前, 引数]。出力: bootConfigs（0.10.1 CD-4: 手順の前の claudeConfigs）・claudeConfigs（roaming・msix・data・data2 ごとに text（BOM も含む）・
//                        backups（NaTsu の控えの名前）・backupTexts・others（ほかのファイルの名前）。フォルダが無ければ null）・notices・engineLog・settingsText・dataDir
// 画面へ送った知らせと進み具合は、送った順に out.seq へ残す。進み具合が初めて「使える」（whisperReady・sumReady）と
// 言ったときの engine:status を out.atReady に、壊れた知らせを送ったときの engine:status を out.atBroken に残す
// （画面はその知らせでエンジンの状態を聞き直すので、そのとき main の答えがもう新しいこと: 第0b回 Task 14・15）
// 本物のエンジンで試すときは NATSU_E2E_EXE・NATSU_E2E_MODEL・NATSU_E2E_WAVS（; 区切り）を渡す。
// 終わるときは、起動したエンジンを止め、一時フォルダを消す（npm test のたびに残さない）。

const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const FAKE = path.join(__dirname, 'fake-whisper.js');
const mode = process.argv[2] || 'text';
const flags = process.argv.slice(3);
const runTest = flags.includes('--test');
const testDuring = flags.includes('--test-during');
const silent = flags.includes('--silent');
const blip = flags.includes('--blip');   // 0.9.1 Q-2
const withVad = flags.includes('--vad');
const kotoba = flags.includes('--kotoba');
const fixedPort = Number((flags.find((f) => f.startsWith('--port=')) || '--port=0').slice(7)) || 0;
const discardDuring = flags.includes('--discard-during');
const discardSettled = flags.includes('--discard-settled');   // 第1d回 A-6 の点検
const afterDict = flags.includes('--after-dict');
const withSum = flags.includes('--sum');
const fixedSumPort = Number((flags.find((f) => f.startsWith('--sum-port=')) || '--sum-port=0').slice(11)) || 0;
const setTypeDuring = (flags.find((f) => f.startsWith('--set-type-during=')) || '').slice(18);
const WRITE_SETTLE_MS = 500;
const xyFlag = (v) => { if (!v) return null; const [x, y] = v.split(',').map(Number); return { x, y }; };   // 0.9.0 O-1: 設定のまとめ書き（main の BATCH_MS 350ms）が済むのを待つ長さ
const flagVal = (name) => { const f = flags.find((x) => x.startsWith(`${name}=`)); return f ? f.slice(name.length + 1) : ''; };
// 0.11.0 M-4: 録音中（最初の区間の後）に meeting:set-memo と meeting:set-type を呼ぶ（--set-type-live は , で区切って続けて選べる）
const setTypeLive = flagVal('--set-type-live') ? flagVal('--set-type-live').split(',') : [];
const liveMemo = flags.some((x) => x.startsWith('--live-memo=')) ? flagVal('--live-memo') : null;
// 第2a1回 M-3: 録音と DB のつなぎの場面
const killDbDuring = flags.includes('--kill-db-during');
const killMainDuring = flags.includes('--kill-main-during');
const killMainAtBegin = flags.includes('--kill-main-at-begin');
const purgeSaveFailOnce = flags.includes('--purge-save-fail-once');
const keepDraftAfterFinalize = flags.includes('--keep-draft-after-finalize');
const keepUserData = flagVal('--keep-user-data');
const retiredSumNone = flags.includes('--retired-sum=none');   // 0.10.0 LS-4 の CI の直し: 取り込める PC で、消すものが無い（0.9.x の要約の組を置かない）
const retiredSum = flags.includes('--retired-sum') || retiredSumNone;
const setTitleDuring = flagVal('--set-title-during');
const setTitleAfterSum = flagVal('--set-title-after-sum');
const secretText = flags.includes('--secret-text');
const killDbAtDiscard = flags.includes('--kill-db-at-discard');
const idleMode = flags.includes('--idle');
const restartDuring = flagVal('--restart-during');   // 第1d回 A-9
const relaySeq = flagVal('--relay-seq');   // 第1d回 A-5
// 0.9.4 S-2: 区間の長さ（会議の時計の durationMs。音声のバイトは今の 3 秒・2 秒のまま）と、この PC の速さの覚え（local-pace.json）
const segMsFlag = Number(flagVal('--seg-ms')) || 0;
const paceFlag = flagVal('--pace');
// 0.9.4 S-5: --clock-seq=<i>:<ミリ秒>,… … i 番目（0 から）の区間を送る前に main の時計（と中継の試しの時計）をその分だけ進める
const clockSeq = new Map((flagVal('--clock-seq') || '').split(',').filter(Boolean).map((x) => x.split(':').map(Number)));
// 0.9.4 S-3: 会議の後の文字起こしを引き直す・ページを消して引き直す・止めた後に後回しにする・待ち行列が無くなるまで待つ
const recoverAgainN = Number(flagVal('--recover-again')) || 0;
const deletePagesThenRecover = flags.includes('--delete-pages-then-recover');
const skipAtStop = flags.includes('--skip-at-stop');
const waitQueueEmpty = flags.includes('--wait-queue-empty');
// 0.9.0 B-2: オフラインの帯の場面（[秒, つながっているか] の並び・区間を送る秒）
const netSeq = flagVal('--net-seq') ? flagVal('--net-seq').split(',').map((x) => { const [sec, v] = x.split(':'); return [Number(sec), v === 'on']; }) : null;
const netSegAtFlag = flagVal('--net-seg-at') ? flagVal('--net-seg-at').split(',').map(Number) : null;
const retryAfterN = Number(flagVal('--retry-after')) || 0;   // 第1d回 A-6
const reloginAfterN = Number(flagVal('--relogin-after')) || 0;   // 第1d回 A-6
const retryAtStop = flags.includes('--retry-at-stop');   // 第1d回 A-6 の点検
const relayMode = flagVal('--relay') || (relaySeq ? 'text' : '');   // 第1d回 A-2
const noStore = flags.includes('--no-store');
// 第1d回 A-3（RL11）: 文字起こしを中継へ送る場面
const signedOut = flags.includes('--signed-out');
const revokedFlag = flags.includes('--revoked');
const relayDown = flags.includes('--relay-down');
const relayCert = flags.includes('--relay-cert');
const keyForFlag = flagVal('--key-for');
const oldKeys = flags.includes('--old-keys');   // 第1d回 A-4（F11・K2）
// 第1d回 A-11（RL10・F20・F21・F26・F27）: Cloudflare Access のログインの窓と、しまった cookie の場面
const accessLoginFlag = flagVal('--access-login');   // 偽のログインの窓の動き（ok・cancel・nocookie・denied・denied403・notready・failload・wander・other-team・hold）か unreadable
const relayExpired = flags.includes('--relay-expired');   // 種の cookie の期限が切れている
const oldToken = flags.includes('--old-token');   // 種が 0.8.0 の前の試しの札（nt1_）
const SEED_TTL_SEC = 30 * 24 * 3600;   // 種の cookie の長さ（Access の app のログインの長さの上限 1 か月。relay-day の 1 日進めても切れない）
// --relay の mode → 中継の前の答え方・中継の env・中継の後ろの偽の OpenAI の答え方
const RELAY_FRONT = { foreign401: 'html401', 415: 'not-wav', 'cut-first': 'cut-first', lag: 'lag-stt' };
const RELAY_ENV = { 'daily-cap': { DAILY_USER_SEC: '4' }, 'daily-cap-all': { DAILY_ALL_SEC: '4' } };
const RELAY_STT = { 'upstream-auth': '401' };
const relaySttMode = RELAY_STT[relayMode] || (RELAY_FRONT[relayMode] || RELAY_ENV[relayMode] ? 'text' : relayMode);
const UPDATE_URL = 'https://example.invalid/natsu-src-0.8.1.zip';   // 取り込みは偽物（out.applyCalls に数えるだけ）なので、どこへも行かない
const SECRET = '秘密の語';
const fakeText = flagVal('--text') || (secretText ? `${SECRET}を含む発言です` : '');
const FAKE_SUM = path.join(__dirname, 'fake-llama.js');
const blipSec = Number(flagVal('--blip-sec')) || 15;   // 0.9.1 Q-2
// 0.9.2 I-1: 起動の後に app:open-help を、この JSON の引数の並びの並びで順に呼び、答え（out.openHelp）と shell.openExternal の住所（out.external）を書いて終わる
const openHelpCalls = flagVal('--open-help') ? JSON.parse(flagVal('--open-help')) : null;
// 0.9.3 M-2〜M-5: 会議の検出の場面（頭の注釈）
const micSteps = flagVal('--mic-feed') ? JSON.parse(flagVal('--mic-feed')) : null;
if (micSteps) process.env.NATSU_TEST_MIC_WATCH = '1';
const detectFlag = flagVal('--detect');
const detectMuteFlag = flagVal('--detect-mute');
const leaveFlag = flagVal('--leave');   // 0.12.1 LV-2: --leave=off（置く settings.json の autoStopLeave: false）
const quietMic = flags.includes('--quiet-mic');   // 0.12.1 LV-3: --quiet-seq の場面でも偽の見張りを起こす（字 T・L）
if (quietMic) process.env.NATSU_TEST_MIC_WATCH = '1';
const darkFlag = flags.includes('--dark');
// 0.10.0 C-2: Claude デスクトップへの MCP の登録の場面（頭の注釈）
const claudeConfigFlag = flagVal('--claude-config');
const mcpGoneFlag = flags.includes('--mcp-gone');
const mcpStaleFlag = flags.includes('--mcp-stale');
const tasklistFlag = flagVal('--tasklist');
// 0.10.1 CD-2: --data-has-natsu（data-msix の新しい場所にも今の NaTsu の natsu）・--claude-race（NaTsu が書いた直後に Claude が書き戻した形）
const dataHasNatsuFlag = flags.includes('--data-has-natsu');
const claudeRaceFlag = flags.includes('--claude-race');
// 0.10.1 点検の直し（計画の Ruling R7〜R12）: 書く途中の失敗・戻しの失敗・計画の後の書き込み・書かなかったファイルへの書き込み・2回の起動で同じ場所
const claudeFailWrite = Number(flagVal('--claude-fail-write') || 0);   // Claude の設定ファイルへの N 回目の writeJsonFile を EBUSY にする（書かない）
const claudeFailRestore = flags.includes('--claude-fail-restore');     // NaTsu の戻し（.natsu-restore の一時ファイルの名前の変更）を EBUSY にする
// NaTsu の控えを写した直後（書く前）に、Claude が好みの設定を1つ足して書く。=N なら N 番目の控えの後だけ（2回目の点検の直し: 旗だけなら毎回）
const claudeRaceBeforeVal = flags.find((f) => f === '--claude-race-before' || f.startsWith('--claude-race-before='));
const claudeRaceBefore = Boolean(claudeRaceBeforeVal);
const claudeRaceBeforeNth = claudeRaceBeforeVal && claudeRaceBeforeVal.includes('=') ? Number(claudeRaceBeforeVal.split('=')[1]) : 0;
// 0.10.1 2回目の点検の直し（計画の Ruling R15〜R20）
const claudeFutureBak = flags.includes('--claude-future-bak');          // %APPDATA%\Claude に、今より後の時刻の名前の NaTsu の控えを3つ置く
const claudeBakExist = flags.includes('--claude-bak-exist');            // NaTsu の控えを写すたびに EEXIST（20 回続けて名前がある形）
const claudeCreateAfterPlan = flags.includes('--claude-create-after-plan'); // NaTsu が計画した後（無かったファイルを書く直前の確かめ）に、Claude が %APPDATA%\Claude の設定ファイルを作る
const claudeRacePlan = Number(flagVal('--claude-race-plan') || 0);
// 0.10.1 3回目の点検の直し（計画の Ruling R21）: NaTsu の戻しの一時ファイル（.natsu-restore-）への書き込みを、ファイルを作って途中まで書いてから EBUSY にする
const claudeFailRestoreWrite = flags.includes('--claude-fail-restore-write');     // J.isReadOnly の N 回目（計画の終わり）の直後に、Claude がそのファイルに好みの設定を1つ足して書く
const claudeRaceOther = flags.includes('--claude-race-other');         // NaTsu が1つ目のファイルを書いた直後に、前の場所（msix）の natsu を消す（ほかのプログラム）
const claudeRootFlag = flagVal('--claude-root');                       // %APPDATA% と %LOCALAPPDATA% をこのフォルダの下にし、2回目の起動では場面を置き直さない
const mcpSteps = flagVal('--mcp-steps') ? JSON.parse(flagVal('--mcp-steps')) : null;
const mcpScene = Boolean(claudeConfigFlag || mcpSteps);
// 0.10.1 CD-3: tasklist.exe への答えの並び（--tasklist=running・stopped・fail か「a,b,c」。MCP の場面で旗が無ければ stopped）
const tasklistPlan = String(tasklistFlag || (mcpScene ? 'stopped' : '')).split(',').filter(Boolean);
// 0.10.0 LN-3: --packaged（app.isPackaged が真）・--protocol-default（isDefaultProtocolClient が真）。呼んだ口を out.protocolCalls に
const packagedFlag = flags.includes('--packaged');
const protocolDefaultFlag = flags.includes('--protocol-default');
const protocolCalls = [];
// 0.10.0 LN-4: --argv=<JSON>（main を読む前の process.argv の後ろ。起動の引数にリンクを渡す形）
const argvFlag = flagVal('--argv') ? JSON.parse(flagVal('--argv')) : null;
// 0.9.1 Q-4: 話し声が無いときに自動で止める場面（頭の注釈）
const quietSeq = flagVal('--quiet-seq') ? flagVal('--quiet-seq').split(',').flatMap((t) => {
  const m = /^([stbkxXPdSRTL])(?::(.))?(?:\*(\d+))?$/.exec(t);
  if (!m) { process.stderr.write(`mainrun: --quiet-seq の ${t} が読めない\n`); process.exit(1); }
  return Array.from({ length: Number(m[3] || 1) }, () => ({ k: m[1], ans: m[2] || 'c', tok: t }));
}) : null;
const quietSegMs = Number(flagVal('--quiet-seg-ms')) || 60000;
const autoStopFlag = flagVal('--auto-stop');
const autoStopMinFlag = Number(flagVal('--auto-stop-min')) || 0;
const segCount = Number((flags.find((f) => f.startsWith('--segs=')) || `--segs=${relaySeq ? relaySeq.length : 2}`).slice(7)) || 2;
const managedMode = flags.includes('--managed') ? 'ok' : (flags.includes('--managed-tamper') ? 'tamper' : '');
const recoverMode = flags.includes('--recover');
const slowAck = (() => { const m = /^([\w.]+):(\d+)$/.exec(flagVal('--slow-ack') || ''); return m ? { cmd: m[1], ms: Number(m[2]) } : null; })();
const afterRetry = flags.includes('--after-retry');
const noVcRuntime = flags.includes('--no-vc-runtime');
const verifyThrows = flags.includes('--verify-throws');
const noEngine = (flags.find((f) => f.startsWith('--no-engine=')) || '').slice(12);
const fetchConsent = flags.includes('--fetch-consent');   // 第1d2回 M-1
const installedUnreadable = flags.includes('--installed-unreadable');   // 第1d2回 M-1 の点検
const killMainAfterKept = flags.includes('--kill-main-after-kept');   // 第1d2回 M-2
// 第1d2回 M-3
const backAfter = flags.includes('--back-after');
const ticksOffline = Number(flagVal('--ticks-offline')) || 0;
const extraQueue = flagVal('--extra-queue');
const extraQueueLate = flagVal('--extra-queue-late');
const keptTickN = Number(flagVal('--kept-ticks')) || 0;
const relayReqText = flagVal('--relay-req-text');
const loginAfter = flags.includes('--login-after');
const localOnlyAfterN = Number(flagVal('--local-only-after')) || 0;   // 第1d2回 M-4
const localOnlyAtRetryN = Number(flagVal('--local-only-at-retry')) || 0;   // 第1d2回 M-3・M-4 の点検
// 第1d2回 M-5（音声入力の音声を残す）
const dictateTwice = flags.includes('--dictate-twice');
const dictBack = flags.includes('--dict-back') || Boolean(flagVal('--dict-back'));
const dictBackMode = flagVal('--dict-back');   // 第1d2回 M-5 の点検: '' ・delete・readonly
const waitDictwait = flags.includes('--wait-dictwait');   // 第1d2回 M-5 の点検
const dictRenameBusyOnce = flags.includes('--dict-rename-busy-once');   // 第1d2回 M-5 の点検
const dictDelete = flags.includes('--dict-delete');
const dictClear = flags.includes('--dict-clear');
const oldDictwait = flags.includes('--old-dictwait');
const doneDictwait = flags.includes('--done-dictwait');
const maxHistoryFlag = flagVal('--max-history');
const fetchMode = flags.includes('--fetch');
const repairMode = flags.includes('--repair');
const crashMode = flags.includes('--crash') ? 'broken' : (flags.includes('--crash-ok') ? 'ok' : '');
const slowLoad = flags.includes('--slow-load');
// 第1c回 A-4: オンラインの文字起こしの場面
const sttMode = (flags.find((f) => f.startsWith('--stt=')) || '').slice(6);
const consentFlag = (flags.find((f) => f.startsWith('--consent=')) || '').slice(10);
const noKey = flags.includes('--no-key');
const legacyProvider = flags.includes('--legacy-provider');
const keyFor = (flags.find((f) => f.startsWith('--key-for=')) || '').slice(10) || 'openai';
const OPENAI_BASE = 'https://api.openai.com/v1';   // src/stt-cloud.js の PRESETS.openai.base（0.7.0 U-1 で固定の送り先）
const keyUnreadable = flags.includes('--key-unreadable');
const summaryOffline = flags.includes('--summary-offline');
const summaryOnlineAfter = flagVal('--summary-online-after') === undefined || flagVal('--summary-online-after') === '' ? -1 : Number(flagVal('--summary-online-after'));
const summaryReconnect = flags.includes('--summary-reconnect');
const offline = flags.includes('--offline') || summaryOffline;
const localOnlyFlag = flags.includes('--local-only');
const dictate = flags.includes('--dictate');
// 第1d2回 M-1: 何も取り込んでいない PC（--no-engine）を、議事録・音声入力の場面として回す（早い分かれ道に入らない）
const noEngineScene = Boolean(noEngine) && (Boolean(relayMode) || offline || signedOut || dictate || localOnlyFlag || flags.includes('--dictate-twice'));
const focusMainDuringDictation = flags.includes('--focus-main-during-dictation');   // 0.9.0 U-1（SP2・RF9）
const noWhisper = flags.includes('--no-whisper');
const noWhisperAfterStart = flags.includes('--no-whisper-after-start');   // 0.9.0 B-2
// 第1d回 A-8: Windows の知らせの場面
const mainHidden = flags.includes('--main-hidden');
const mainMinimized = flags.includes('--main-minimized');
const liveNotShown = flags.includes('--live-not-shown');
// 0.12.0 SP-3a: 2つの流れの議事録の並び（頭の注釈）
const twoStreamsFlag = flagVal('--two-streams');
const twoFx = twoStreamsFlag ? JSON.parse(fs.readFileSync(path.isAbsolute(twoStreamsFlag) ? twoStreamsFlag : path.join(__dirname, '..', 'fixtures', 'streams', `${twoStreamsFlag}.json`), 'utf8')) : null;
if (twoFx && flagVal('--sys-lost-at')) twoFx.sysLostAt = Number(flagVal('--sys-lost-at'));
const streamTexts = [];   // 偽の OpenAI（--relay=tagged）と偽の whisper（FAKE_TAG_FILE）が返す文（WAV の末尾の番号で引く）
const twoFinalWaitMs = [];   // 点検の直し C1: main の twoFinalWait が言った長さ
const tagFile = twoFx ? path.join(os.tmpdir(), `natsu-tags-${process.pid}.json`) : '';
if (tagFile) { process.env.FAKE_TAG_FILE = tagFile; fs.writeFileSync(tagFile, '[]'); process.on('exit', () => { try { fs.rmSync(tagFile, { force: true }); } catch (_) { /* 消えている */ } }); }
// 文の並びは別のファイルに書いてから名前を替える（その場で書き直すと、別のプロセスの偽の whisper が読んだときに空や途中のファイルを読み、
// 番号の文でなく既定の文を返す: CI run 40173107746 の ubuntu の SP-3b の場面。R31）。Windows で読まれている間に替えられなければ少し待って替え直す
let tagSeq = 0;
function writeTags() {
  const tmpTag = `${tagFile}.${++tagSeq}.tmp`;
  fs.writeFileSync(tmpTag, JSON.stringify(streamTexts));
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmpTag, tagFile); return; } catch (e) {
      if (i >= 50 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}
const streamTextOf = (wav) => {
  if (!wav || wav.length < 50) return null;
  const n = Math.floor((wav.length - 44) / 2);
  const at = (k) => wav.readInt16LE(44 + (n - k) * 2);
  return at(3) === 3 && at(2) === -3 && Object.hasOwn(streamTexts, at(1)) ? streamTexts[at(1)] : null;
};
const noNotify = flags.includes('--no-notify');
const clickNotify = flags.includes('--click-notify');
const reloadMain = flags.includes('--reload-main');
const mainUnfocused = flags.includes('--main-unfocused') || flags.includes('--focus-main-during-dictation');   // 第1d回 A-8 の点検で足した（0.9.0 U-1 の旗も前にない形で始める）
const notifyThrows = flags.includes('--notify-throws');     // 第1d回 A-8 の点検で足した
// 第1c回 B-3: オンラインの要約の場面（偽の claude）
const claudeMode = (flags.find((f) => f.startsWith('--claude=')) || '').slice(9);
const claudeAuth = (flags.find((f) => f.startsWith('--claude-auth=')) || '').slice(14);
const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const STT_KEY = 'gsk_test_0123456789';   // stage1c.main.test.js の KEY と同じ（どこにも漏れていないかを試験が探す）
const sceneName = (flags.find((f) => f.startsWith('--json-scene=')) || '').slice(13);
// 0.9.0 O-1: 置く settings.json の上に重ねる録音バーの前の位置（json-scenes の PILL_SETTINGS）と、偽の画面の並び
const settingsJsonName = flagVal('--settings-json');
const pillSettings = settingsJsonName ? require('./json-scenes').PILL_SETTINGS[settingsJsonName] : null;
if (settingsJsonName && !pillSettings) { process.stderr.write(`mainrun: --settings-json=${settingsJsonName} が json-scenes.js の PILL_SETTINGS に無い\n`); process.exit(1); }
const displaysFlag = flagVal('--displays') ? flagVal('--displays').split(';').map((t, i) => {
  const [x, y, width, height] = t.split(',').map(Number);
  return { id: i + 1, bounds: { x, y, width, height: height + 40 }, workArea: { x, y, width, height } };
}) : null;
// 0.9.0 O-2: 録音バーの大きさの知らせ・ドラッグ・カーソル
const panelSizeFlag = flagVal('--panel-size') ? (([w, h]) => ({ w, h }))(flagVal('--panel-size').split('x').map(Number)) : null;
// G-2（統合）: --panel-size-form=<h|v> … --panel-size の知らせに form を付ける（今の形でない形の古い大きさ）。--self-move … 録音の始めの後に、
// main が置いた所のまま録音バーの窓に move・moved を出し、置き直した数を panel.selfMove に（ドラッグでない move は数えない）
const panelSizeForm = flagVal('--panel-size-form') || '';
const selfMove = flags.includes('--self-move');
if (panelSizeFlag && panelSizeForm) panelSizeFlag.form = panelSizeForm;
const dragTo = xyFlag(flagVal('--drag-to'));
const dragSteps = flags.includes('--drag-steps');
const cursorTo = xyFlag(flagVal('--cursor-to'));
// 0.9.0 O-4: 録音バーを隠す・出し直す（頭の注釈）。--hide-panel だけなら 'show'
const hidePanelMode = flags.includes('--hide-panel') ? 'show' : flagVal('--hide-panel') || '';
const hoverPanel = flags.includes('--hover-panel');
const scene = sceneName ? require('./json-scenes')[sceneName] : null;
if (sceneName && (!scene || typeof scene !== 'object')) { process.stderr.write(`mainrun: 場面 ${sceneName} が json-scenes.js に無い\n`); process.exit(1); }
// 第2a1回 M-2b: 議事録の DB を使えない（SQLite が trigram を持たない）
const dbDown = flags.includes('--db-down') || Boolean(scene && scene.dbDown);
const { fakeFork, FakeChannel } = require('./fake-utility');
const dbpeek = require('./dbpeek');
const SCENE_TIMERS = new Set(['retrySettingsRead', 'retryHistoryRead', 'retryDraftRecovery', 'checkDailySnapshot']);
const serveSet = repairMode || Boolean(crashMode);   // engine-small の偽のサーバーを開いたままにし、同意済みにする
const REAL_PLATFORM = process.platform;
// --no-vc-runtime が main の中だけ空のフォルダに向ける環境の変数の、元の値。エンジン（子のプロセス）には元の値を渡す
// （本物のエンジンは本物の Windows の中で動く。Windows の node は SystemRoot が違うと Winsock を始められず code 134 で落ちる）
const REAL_WINENV = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
const childEnv = (env) => {
  const out = { ...(env || process.env) };
  for (const [k, v] of Object.entries(REAL_WINENV)) {
    for (const key of Object.keys(out)) if (key.toLowerCase() === k.toLowerCase()) delete out[key];   // Windows は大文字と小文字を区別しない
    if (v !== undefined) out[k] = v;
  }
  return out;
};
// 偽の claude は process.execPath で起こす。claude-cli は子の環境から ELECTRON_RUN_AS_NODE を外す（本物の claude に
// 渡さないため）ので、Electron の Node でテストを回すとき（ci.yml の electron-smoke）は戻す。戻さないと electron.exe が
// 偽の claude を Electron のアプリとして起こし、Windows では標準入力が届かない（D2 の stdinHasTranscript が false になる）
const fakeClaudeEnv = (env) => (process.versions.electron ? { ...childEnv(env), ELECTRON_RUN_AS_NODE: '1' } : childEnv(env));

// 偽のエンジン（子のプロセス）に渡す空いたポート。前は listen(0) で OS の一時ポート（Linux は 32768〜60999・Windows は 49152〜65535）を借りて
// すぐ返していたが、返した後・子が待ち受ける前に、同じ機械の外向きの接続（中継の偽物への要求など。並べて回すほかの場面も）が一時ポートとして
// そのポートを使うことがあり、偽のエンジンが EADDRINUSE で落ちた（CI run 39904812869 の ubuntu・stage094.main の S4・S5。0.9.4 の freePort の
// Ruling と同じ原因）。一時ポートの範囲の外（20000〜31999）から選び、待ち受けられることを確かめてから返す（Windows の予約された範囲は EACCES で飛ばす）
const PORT_LO = 20000;
const PORT_SPAN = 12000;
const tryPort = (port) => new Promise((resolve) => {
  const srv = net.createServer();
  srv.once('error', () => resolve(false));
  srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
});
const freePort = async () => {
  for (let i = 0; i < 200; i++) {
    const port = PORT_LO + Math.floor(Math.random() * PORT_SPAN);
    if (await tryPort(port)) return port;
  }
  throw new Error('mainrun: 空いたポートが見つからない');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 場面が「終わった」と言える条件を待つ上限。条件が揃えばすぐ進むので、通る場面は速いまま。上限は、負荷のある遅い機械
// （Windows の CI で、他の場面・他のテストのファイルと CPU を取り合う）でも届く長さにする。固定の短い上限（4 秒）では、
// 51MB の偽のモデルの取り込みと照らしが間に合わず、場面が途中の写しを返していた（文字起こしの組までしか取れていない）
const WAIT_MS = Number(process.env.NATSU_E2E_WAIT_MS || 60000);
const waitFor = async (cond, ms = WAIT_MS) => {
  const until = Date.now() + ms;
  while (Date.now() < until && !cond()) await sleep(20);
  return cond();
};
// on／once で受け口を覚え、emit(ev, …) で呼べる小さな受け手（偽の app・窓・powerMonitor）
function makeEmitter(target = {}) {
  const ls = {};
  const add = (ev, cb, once) => { (ls[ev] || (ls[ev] = [])).push({ cb, once }); return target; };
  target.on = (ev, cb) => add(ev, cb, false);
  target.once = (ev, cb) => add(ev, cb, true);
  target.removeListener = (ev, cb) => { ls[ev] = (ls[ev] || []).filter((x) => x.cb !== cb); return target; };
  target.off = target.removeListener;
  target.emit = (ev, ...a) => {
    const l = ls[ev] || [];
    ls[ev] = l.filter((x) => !x.once);
    for (const x of l) x.cb(...a);
    return l.length > 0;
  };
  target.listenerCount = (ev) => (ls[ev] || []).length;
  return target;
}

// 版（VS_FIXEDFILEINFO）だけを持つ DLL の偽物（main.js の vcRuntimeVersions が読む印 0xFEEF04BD と、その後の版）
function peWithVersion(a, b, c, d) {
  const x = Buffer.alloc(4096);
  x.writeUInt32LE(0xFEEF04BD, 1000); x.writeUInt32LE(0x00010000, 1004);
  x.writeUInt32LE(((a << 16) | b) >>> 0, 1008); x.writeUInt32LE(((c << 16) | d) >>> 0, 1012);
  return x;
}

// 220Hz の正弦波の WAV（16kHz・モノラル・16bit。amp=0 で無音）。区間になるには 4000 バイト以上が要る
function toneWav(sec, amp = 8000) {
  const n = 16000 * sec;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin(2 * Math.PI * 220 * i / 16000)), 44 + i * 2);
  return b;
}

// 0.9.1 Q-2: sec 秒の無音の真ん中に 0.6 秒の小さな音（振幅 261 の 220Hz。RMS 約 -45 dBFS）
function blipWav(sec) {
  const b = toneWav(sec, 0);
  const from = Math.round(16000 * (sec / 2 - 0.3));
  for (let i = from; i < from + 9600; i++) b.writeInt16LE(Math.round(261 * Math.sin(2 * Math.PI * 220 * i / 16000)), 44 + i * 2);
  return b;
}
// 旗（--silent・--blip）のとおりの音声。区間・音声入力・復旧の下書きが使う
function audioWav(sec) {
  if (blip) return blipWav(sec);
  return toneWav(sec, silent ? 0 : 8000);
}

// 何を聞かれても、それらしい値か自分自身を返す（使わない Electron の API を丸ごと受け流す）
function anyProxy() {
  const fn = function () {};
  return new Proxy(fn, {
    get(_t, k) {
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => '';
      if (k === 'isDestroyed' || k === 'isVisible') return () => false;
      return anyProxy();
    },
    apply() { return anyProxy(); },
    construct() { return anyProxy(); },
  });
}
const withFallback = (o) => new Proxy(o, { get: (t, k) => (k in t ? t[k] : anyProxy()) });

// 終わり方: 起動したエンジンを止め、一時フォルダを消す。process.exit の前に必ず通る
const kids = [];
let tmp = '';
process.on('exit', () => {
  for (const k of kids) { try { k.kill(); } catch (_) { /* noop */ } }
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* 消せなくても結果は出す */ } }
});

(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natsu-e2e-'));
  // userData は日本語と 𠮷 の名前（利用者名が日本語の PC と同じ。計画の決まり）。偽のエンジンの置き場（engine）は英数字のまま
  // （whisper は英数字以外のパスを読めない: RF1。main はそのとき起動しない）
  // --keep-user-data: 呼び手のフォルダ（日本語と 𠮷 の名前）を使い、終わっても消さない。data/ がもうあれば前の起動の続き
  const userData = keepUserData || path.join(tmp, 'userData-日本語𠮷');
  fs.mkdirSync(userData, { recursive: true });
  const reuseData = Boolean(keepUserData) && fs.existsSync(path.join(userData, 'data'));
  // 前の起動が残した下書き（data/draft*.json）。今の中身を返す（無い・読めないなら null）
  const draftNames = () => { try { return fs.readdirSync(path.join(userData, 'data')).filter((n) => /^draft.*\.json$/.test(n)).sort(); } catch (_) { return []; } };
  const currentDraft = () => {
    for (const n of draftNames()) {
      try { const d = JSON.parse(fs.readFileSync(path.join(userData, 'data', n), 'utf8')); if (d && typeof d === 'object') return d; } catch (_) { /* 書きかけ・読めない */ }
    }
    return null;
  };
  const draftBefore = reuseData ? currentDraft() : null;
  const engDir = path.join(tmp, 'engine');
  fs.mkdirSync(engDir);
  // 偽の文字起こしの送り先（--stt）。終わるときに閉じなくても、process.exit で消える
  const fakeStt = sttMode ? await require('./fake-stt').startFakeStt({ mode: sttMode === 'cert' ? 'text' : sttMode, key: STT_KEY }) : null;
  // 0.10.0 LS-2: --claude があって --stt も --relay も無い場面（手元の文字起こしの場面）も、Anthropic へ届くかの確かめが届くように、
  // 届くかの確かめだけに答える偽の送り先を置く（要約は Claude Code だけになったので、要約を作る場面は Claude Code に届く形が要る）
  const claudeReach = claudeMode && !sttMode && !relayMode ? await require('./fake-stt').startFakeStt({ mode: 'text', key: STT_KEY }) : null;
  const fakeEnc = (s) => Buffer.from(`ENC1:${Buffer.from(s, 'utf8').toString('hex')}`);
  // 本物の中継のコードを 127.0.0.1 で（--relay。第1d回 A-2）。終わるときに閉じなくても、process.exit で消える
  const relayLocal = relayMode ? await require('./relay-local').startRelayLocal({ stt: { mode: relaySttMode, ...(relayMode === 'tagged' ? { textOf: streamTextOf } : {}) }, env: RELAY_ENV[relayMode] || {}, access: true }) : null;
  const { RELAY_BASE, ACCESS_PARTITION, LOGIN_URL, packCookies } = require(path.join(ROOT, 'src', 'relay.js'));
  const RELAY_HOST = new URL(RELAY_BASE).hostname;
  // rl.cookieFor の形（cookies.set に渡す形）→ cookies.get が返す形（packCookies が読む）
  const jarShape = (c) => ({ name: c.name, value: c.value, domain: RELAY_HOST, hostOnly: true, path: '/', secure: c.secure, httpOnly: c.httpOnly,
    sameSite: c.sameSite, expirationDate: c.expirationDate });
  const relayPaths = [];   // 中継へ送った要求の道（書き換える前の RELAY_BASE の後ろ。/auth/start など）
  // 第1d回 A-3・A-11: ログインの種まき（main を読む前に、偽の Access がその人に出した cookie を packCookies でまとめてしまう）。
  // main からの要求ではないので relayPaths に数えない
  let seededMail = '';
  const seedKeys = {};
  if (relayLocal && !signedOut && (!scene || scene.relaySeed)) {
    seededMail = require('./relay-run').mail('kaigi');
    if (oldToken) seedKeys.relay = fakeEnc(`nt1_${'A'.repeat(43)}`).toString('base64');
    else {
      const c = await relayLocal.cookieFor(seededMail, { ttlSec: relayExpired ? -60 : SEED_TTL_SEC });
      const pack = packCookies([jarShape(c)], { exp: c.expirationDate });
      if (!pack) throw new Error('mainrun: cookie の種まきに失敗');
      seedKeys.relay = fakeEnc(pack).toString('base64');
    }
    if (revokedFlag) relayLocal.revokeAt(seededMail);
  }
  if (fakeStt && !noKey) seedKeys[keyFor] = fakeEnc(STT_KEY).toString('base64');
  if (relayLocal && keyForFlag) seedKeys[keyForFlag] = fakeEnc(STT_KEY).toString('base64');
  // --old-keys: 0.7.0 までの鍵（groq・openai・custom）と、前の鍵の暗号の文字が残る退けた控え secrets.json.broken-* を置く
  if (oldKeys) {
    const { OLD_KEY_TEXT } = require('./json-scenes');
    for (const [id, k] of Object.entries(OLD_KEY_TEXT)) seedKeys[id] = fakeEnc(k).toString('base64');
    fs.writeFileSync(path.join(userData, 'secrets.json.broken-2026-10-01T00-00-00-000Z'), `{"schema":1,"keys":{"openai":"${seedKeys.openai}"`);
  }
  if (Object.keys(seedKeys).length) fs.writeFileSync(path.join(userData, 'secrets.json'), JSON.stringify({ schema: 1, keys: seedKeys }));
  if (relayLocal && RELAY_FRONT[relayMode]) relayLocal.setFront(RELAY_FRONT[relayMode]);
  if (relayLocal && relayReqText) relayLocal.setReqText(relayReqText);   // 第1d2回 M-3
  // --relay-down: RELAY_BASE をだれも聞いていない口へ（書き換えの先）
  const relayTarget = relayLocal ? (relayDown ? `http://127.0.0.1:${await freePort()}` : relayLocal.base) : '';
  // 偽のモデル。中身は見られず、大きさの床（50MB）だけを超えればよい。残りは疎にして場所を取らない。
  // 先頭だけは実際に書く（全部が疎だと blocks が 0 になり、OneDrive のプレースホルダと見なされる）
  let model = process.env.NATSU_E2E_MODEL;
  if (!model) {
    model = path.join(engDir, kotoba ? 'ggml-kotoba-whisper-v2.0-q5_0.bin' : 'ggml-fake.bin');
    const fd = fs.openSync(model, 'w');
    fs.writeSync(fd, Buffer.alloc(8192, 1));
    fs.ftruncateSync(fd, 51 * 1024 * 1024);
    fs.closeSync(fd);
  }
  if (withVad) fs.writeFileSync(path.join(path.dirname(model), 'ggml-silero-v6.2.0.bin'), Buffer.alloc(1024, 1));
  // 0.9.4 S-2: --pace=<JSON> … 起動の前に <userData>/data/local-pace.json を置く。model が "same" なら偽のモデルの名前と大きさにする
  // （at が "now-<日>" なら今からその日数の前の時刻にする）
  if (paceFlag) {
    const pace = JSON.parse(paceFlag);
    if (pace.model === 'same') pace.model = { name: path.basename(model), size: fs.statSync(model).size };
    if (typeof pace.at === 'string' && /^now-\d+$/.test(pace.at)) pace.at = Date.now() - Number(pace.at.slice(4)) * 24 * 3600 * 1000;
    fs.mkdirSync(path.join(userData, 'data'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'data', 'local-pace.json'), JSON.stringify(pace));
  }
  const exe = process.env.NATSU_E2E_EXE || FAKE;
  // 偽の claude（--claude）。記録は1行ずつの JSON
  const claudeLog = path.join(tmp, 'claude.log');
  // --claude が無い場面（と missing）は無いファイルに向ける。PATH の上の本物の claude を探さないため（計画の決まり）。
  // 経路が誤って Claude Code へ行っても、時間切れで待たずに「見つからない」ですぐ赤になる
  const claudeExe = claudeMode && claudeMode !== 'missing' ? FAKE_CLAUDE : path.join(tmp, 'no-such-claude.exe');
  if (claudeMode) {
    process.env.FAKE_CLAUDE_MODE = claudeMode;
    if (flagVal('--claude-delay')) process.env.FAKE_CLAUDE_DELAY = flagVal('--claude-delay');   // 0.10.0 LS-2: --claude=slow の待ち（ミリ秒）
    process.env.FAKE_CLAUDE_LOG = claudeLog;
    process.env.FAKE_CLAUDE_EXPECT = fakeText || '本日の議題は進捗の確認です';
    // 手元の1回の要約と同じ指示文（mainlib.buildClaudeInput。F9）を標準入力で受けたか
    process.env.FAKE_CLAUDE_EXPECT_ASK = '上記から、次の構成のMarkdown議事録を作成してください。';
    if (claudeAuth) process.env.FAKE_CLAUDE_AUTH = claudeAuth;
    if (flags.includes('--claude-stdin')) process.env.FAKE_CLAUDE_STDIN = '1';   // 0.12.0 SP-4: 偽の claude の記録に標準入力の全文（stdinText）
    // 0.11.0 M-3: --sum-md=<名前> … 偽の claude が返す要約を test/fixtures/summaries/<名前>.md にする
    if (flagVal('--sum-md')) process.env.FAKE_CLAUDE_MD = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'summaries', `${flagVal('--sum-md')}.md`), 'utf8');
  }
  // 課金の変数（子に渡らないことを偽の claude の記録の envKeys で見る。大小の混ざった名前は claude-cli.test.js が見る）
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'o';
  const flog = path.join(tmp, 'fake.log');
  fs.writeFileSync(flog, '');
  process.env.FAKE_MODE = mode;
  process.env.FAKE_LOG = flog;
  const localPort = fixedPort || await freePort();
  const sumPort = fixedSumPort || await freePort();
  if (fakeText) process.env.FAKE_TEXT = fakeText;
  // 偽の要約モデル。大きさの床（300MB）だけを超えればよい（残りは疎）
  let sumModel = '';
  if (withSum) {
    sumModel = path.join(engDir, 'fake-sum.gguf');
    const fd = fs.openSync(sumModel, 'w');
    fs.writeSync(fd, Buffer.alloc(8192, 1));
    fs.ftruncateSync(fd, 301 * 1024 * 1024);
    fs.closeSync(fd);
    if (setTypeDuring || setTitleDuring) process.env.FAKE_SUM_DELAY = '1500';
  }
  // 取り込んだ組（--managed）。置き場所は main と同じ LOCALAPPDATA の下（日本語と 𠮷 の名前。RF1）
  const localAppData = path.join(claudeRootFlag || tmp, 'LocalAppData-取込𠮷');
  // 0.10.0 C-2: %APPDATA%（app.getPath('appData')）と Claude デスクトップの設定ファイル（--claude-config。頭の注釈）
  const appDataDir = path.join(claudeRootFlag || tmp, 'AppData-Roaming-設定𠮷');
  // 0.10.1 点検の直し: --claude-root の2回目の起動では、置いた場面のファイルをそのまま使う（印 .scene-placed）
  const claudeScenePlaced = Boolean(claudeRootFlag) && fs.existsSync(path.join(claudeRootFlag, '.scene-placed'));
  fs.mkdirSync(appDataDir, { recursive: true });
  const CLAUDE_CONFIG = 'claude_desktop_config.json';
  // 0.10.1 CD-2: data・data2 は新しい Store 版の場所（%LOCALAPPDATA%\Claude-Data\claude_<符号>。data2 の符号は作ったもの）
  const claudeDataRoot = path.join(localAppData, 'Claude-Data');
  const claudeDirs = {
    roaming: path.join(appDataDir, 'Claude'), msix: path.join(localAppData, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache', 'Roaming', 'Claude'),
    data: path.join(claudeDataRoot, 'claude_pzs8sxrjxfjjc'), data2: path.join(claudeDataRoot, 'claude_zz9test0000aa'),
  };
  // 0.10.1 CD-2 の場面（頭の注釈）。今の NaTsu の登録（main の mcpPaths と同じ形）・新しい場所の形の見本（作った値。JSON.stringify(v, null, 2)・終わりの改行なし）
  const NEW_CLAUDE_SCENES = new Set(['msix-only', 'data', 'data-msix', 'data-two', 'roaming-data', 'data-broken', 'msix-broken', 'three', 'data-link', 'stale-two', 'none-data', 'stale-broken']);
  if (claudeScenePlaced) {
    // 2回目の起動（--claude-root）: 何も置かない
  } else if (claudeConfigFlag && NEW_CLAUDE_SCENES.has(claudeConfigFlag)) {
    const OTHERS = {
      globalShortcut: 'Ctrl+Space',
      mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\docs'] }, memory: { command: 'node', args: ['mem.js'], env: { K: 'v' } } },
      theme: 'dark',
    };
    const natsuNow = { command: process.execPath, args: [path.join(ROOT, 'src', 'mcp', 'server.js')], env: { ELECTRON_RUN_AS_NODE: '1', NATSU_MCP: '1', NATSU_DATA_DIR: path.join(userData, 'data') } };
    const sample = (withNatsu) => ({
      mcpServers: { 'sample-tool': { command: 'node', args: ['tool.js'] }, ...(withNatsu ? { natsu: natsuNow } : {}) },
      sampleFolder: 'C:\\見本\\𠮷',
      preferences: {
        menuBarEnabled: true, sidebarMode: 'wide', allowedOrigins: [], trustedFolders: ['C:\\見本'],
        folderGrants: { '00000000-0000-4000-8000-000000000001': { path: 'C:\\見本', ok: true }, '00000000-0000-4000-8000-000000000002': { path: 'D:\\作業', ok: false } },
        paneWidth: 320, nudgeSeen: false, userDataOutsidePackageAnswer: true,
        nested: { 'starred.sessions': {}, 'mode.00000000-0000-4000-8000-000000000003': 'auto', count: 3 },
      },
    });
    const put = (dir, name, body) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), body); };
    const js = (v) => JSON.stringify(v, null, 2);
    const LEFT = '.user-data-left.claude_pzs8sxrjxfjjc';
    const BROKEN = '{\n  "mcpServers": {\n    "filesystem": {';
    const sc = claudeConfigFlag;
    if (sc === 'data' || sc === 'data-two' || sc === 'data-msix' || sc === 'msix-broken' || sc === 'roaming-data' || sc === 'three' || sc === 'none-data') {
      fs.mkdirSync(claudeDataRoot, { recursive: true });
      fs.writeFileSync(path.join(claudeDataRoot, 'README.txt'), 'sample');
      put(claudeDirs.data, CLAUDE_CONFIG, js(sample(sc === 'data-msix' && dataHasNatsuFlag)));
    }
    if (sc === 'data') {
      fs.writeFileSync(path.join(claudeDirs.data, `${CLAUDE_CONFIG}.rea.backup`), '{"ほかの道具の控え": true}');
      put(claudeDirs.msix, LEFT, '');
    }
    if (sc === 'data-two') put(claudeDirs.data2, CLAUDE_CONFIG, js(sample(false)));
    if (sc === 'data-msix') { put(claudeDirs.msix, CLAUDE_CONFIG, js({ ...OTHERS, mcpServers: { ...OTHERS.mcpServers, natsu: natsuNow } })); put(claudeDirs.msix, LEFT, ''); }
    if (sc === 'msix-only') put(claudeDirs.msix, CLAUDE_CONFIG, js(OTHERS));
    if (sc === 'roaming-data') put(claudeDirs.roaming, CLAUDE_CONFIG, js(OTHERS));
    if (sc === 'data-broken') { put(claudeDirs.data, CLAUDE_CONFIG, BROKEN); put(claudeDirs.msix, CLAUDE_CONFIG, js(OTHERS)); }
    if (sc === 'msix-broken') put(claudeDirs.msix, CLAUDE_CONFIG, BROKEN);
    // 0.10.1 点検の直し: 3つの場所（%APPDATA%\Claude・新しい場所・前の場所）。書く順は roaming → data → msix
    if (sc === 'three') { put(claudeDirs.roaming, CLAUDE_CONFIG, js(OTHERS)); put(claudeDirs.msix, CLAUDE_CONFIG, js(OTHERS)); }
    // 0.10.1 2回目の点検の直し: data-link（新しい場所の子が %APPDATA%\Claude へのリンク。Windows はジャンクション）・stale-two（%APPDATA%\Claude と前の場所の両方に
    // 印のある古い natsu）・none-data（%APPDATA%\Claude はフォルダだけ・新しい場所に見本）
    if (sc === 'data-link') {
      put(claudeDirs.roaming, CLAUDE_CONFIG, js(OTHERS));
      fs.mkdirSync(claudeDataRoot, { recursive: true });
      fs.symlinkSync(claudeDirs.roaming, claudeDirs.data, 'junction');
    }
    // 0.10.1 3回目の点検の直し: stale-broken（%APPDATA%\Claude に印のある古い natsu・前の場所が壊れた JSON。悪い方は broken）
    if (sc === 'stale-broken') {
      const oldNatsu = { command: 'D:\\old\\NaTsu.exe', args: ['D:\\old\\resources\\app\\src\\mcp\\server.js'], env: { ELECTRON_RUN_AS_NODE: '1', NATSU_MCP: '1', NATSU_DATA_DIR: 'D:\\old\\data' } };
      put(claudeDirs.roaming, CLAUDE_CONFIG, js({ ...OTHERS, mcpServers: { natsu: oldNatsu, ...OTHERS.mcpServers } }));
      put(claudeDirs.msix, CLAUDE_CONFIG, BROKEN);
    }
    if (sc === 'stale-two') {
      const oldNatsu = { command: 'D:\\old\\NaTsu.exe', args: ['D:\\old\\resources\\app\\src\\mcp\\server.js'], env: { ELECTRON_RUN_AS_NODE: '1', NATSU_MCP: '1', NATSU_DATA_DIR: 'D:\\old\\data' } };
      put(claudeDirs.roaming, CLAUDE_CONFIG, js({ ...OTHERS, mcpServers: { natsu: oldNatsu, ...OTHERS.mcpServers } }));
      put(claudeDirs.msix, CLAUDE_CONFIG, js({ ...OTHERS, mcpServers: { natsu: oldNatsu, ...OTHERS.mcpServers } }));
    }
    if (sc === 'none-data') fs.mkdirSync(claudeDirs.roaming, { recursive: true });
    if (claudeFutureBak) for (const d of ['01', '02', '03']) put(claudeDirs.roaming, `${CLAUDE_CONFIG}.natsu-2099-01-${d}T00-00-00-000Z.bak`, '{"未来の控え": true}');
  } else if (claudeConfigFlag) {
    const OTHERS = {
      globalShortcut: 'Ctrl+Space',
      mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\docs'] }, memory: { command: 'node', args: ['mem.js'], env: { K: 'v' } } },
      theme: 'dark',
    };
    const withStale = (cfg) => (mcpStaleFlag
      ? { ...cfg, mcpServers: { natsu: { command: 'D:\\old\\NaTsu.exe', args: ['D:\\old\\resources\\app\\src\\mcp\\server.js'], env: { ELECTRON_RUN_AS_NODE: '1', NATSU_MCP: '1', NATSU_DATA_DIR: 'D:\\old\\data' } }, ...cfg.mcpServers } }
      : cfg);
    const text = (v) => JSON.stringify(withStale(v), null, 2);
    const BODIES = {
      none: null,
      plain: JSON.stringify({ theme: 'light' }, null, 2),
      others: text(OTHERS),
      bom: `\uFEFF${text(OTHERS)}`,
      broken: '{\n  "mcpServers": {\n    "filesystem": {',
      array: '[]',
      'other-natsu': text({ ...OTHERS, mcpServers: { ...OTHERS.mcpServers, natsu: { command: 'other.exe', args: [] } } }),
      readonly: text(OTHERS),
      msix: null,
    };
    if (claudeConfigFlag !== 'noclaude') {
      if (!Object.hasOwn(BODIES, claudeConfigFlag)) { process.stderr.write(`mainrun: --claude-config=${claudeConfigFlag} が読めない\n`); process.exit(1); }
      fs.mkdirSync(claudeDirs.roaming, { recursive: true });
      const body = BODIES[claudeConfigFlag];
      const file = path.join(claudeDirs.roaming, CLAUDE_CONFIG);
      if (body !== null) fs.writeFileSync(file, body);
      if (claudeConfigFlag === 'others') fs.writeFileSync(`${file}.bak`, '{"利用者の控え": true}');
      if (claudeConfigFlag === 'readonly') fs.chmodSync(file, 0o444);
      if (claudeConfigFlag === 'msix') {
        fs.mkdirSync(claudeDirs.msix, { recursive: true });
        fs.writeFileSync(path.join(claudeDirs.msix, CLAUDE_CONFIG), text(OTHERS));
      }
    }
  }
  if (claudeRootFlag && !claudeScenePlaced) { fs.mkdirSync(claudeRootFlag, { recursive: true }); fs.writeFileSync(path.join(claudeRootFlag, '.scene-placed'), ''); }
  // その時の設定ファイル（場所ごと。フォルダが無ければ null）
  const claudeConfigsNow = () => Object.fromEntries(Object.entries(claudeDirs).map(([k, dir]) => {
    if (!fs.existsSync(dir)) return [k, null];
    const names = fs.readdirSync(dir).sort();
    const isBk = (n) => n.startsWith(`${CLAUDE_CONFIG}.natsu-`) && n.endsWith('.bak');
    const backups = names.filter(isBk);
    const read = (n) => { try { return fs.readFileSync(path.join(dir, n), 'utf8'); } catch (_) { return null; } };
    return [k, { text: read(CLAUDE_CONFIG), backups, backupTexts: Object.fromEntries(backups.map((n) => [n, read(n)])), others: names.filter((n) => n !== CLAUDE_CONFIG && !isBk(n)) }];
  }));
  let managedExe = '';
  let managedRoot = '';
  let managedMods = null;
  let fetchSet = null;   // 開いたままの engine-small の偽のサーバー（--fetch・--repair）
  let verifyCalls = 0;   // 取り込んだ組の照らし（verifyCandidates）の回数
  if (managedMode) {
    const I = require(path.join(ROOT, 'src', 'engine-install.js'));
    const realManifest = require(path.join(ROOT, 'src', 'engine-manifest.js'));
    const { smallSet } = require('./engine-small');
    const set = await smallSet();
    if (serveSet) fetchSet = set;   // 取り直しを見る: 偽のサーバーは終わるまで開いておく
    else await set.close();   // 通信はしない（中身だけ使う）
    // 文字起こしのモデルは大きさの床（50MB）を超える疎のファイル（モデルは大きさと更新時刻で照らすので中身は見ない）。
    // VAD は本物の名前にして、モデルの隣の自動の発見（resolveVadModel）が取り込んだ models の中で効くかを見る
    const items = set.manifest.items.map((it) => {
      if (it.id === 'whisper-model') return { ...it, size: 51 * 1024 * 1024 };
      if (it.id === 'whisper-vad') return { ...it, dest: 'models/ggml-silero-v6.2.0.bin' };
      return it;
    });
    managedRoot = path.join(localAppData, 'natsu', 'engine');
    const home = { supported: true, root: managedRoot, reason: '' };
    // 組は文字起こしだけ（0.10.0 LS-3 で要約の組を外した）
    for (const it of items.filter((i) => i.group === 'whisper')) {
      if (it.kind === 'zip') {
        const zip = path.join(tmp, `${it.id}.zip`);
        fs.writeFileSync(zip, set.bodies[it.id]);
        I.recordInstalled(home, it, await I.installZip(it, zip, managedRoot));
        continue;
      }
      const out = path.join(managedRoot, ...it.dest.split('/'));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      if (it.id === 'whisper-model') {
        const fd = fs.openSync(out, 'w');
        fs.writeSync(fd, Buffer.alloc(8192, 1));
        fs.ftruncateSync(fd, it.size);
        fs.closeSync(fd);
      } else {
        fs.writeFileSync(out, set.bodies[it.id]);
      }
      I.recordInstalled(home, it, { file: out });
    }
    managedExe = path.join(managedRoot, 'whisper-1.0.0', 'whisper-server.exe');
    const tamper = (dir, name) => {
      const dll = path.join(managedRoot, dir, name);
      fs.writeFileSync(dll, Buffer.alloc(fs.statSync(dll).size, 7));   // 大きさは同じ・中身だけ違う
      // 記録の更新時刻も今のファイルに合わせる（大きさと更新時刻では見分けられない。SHA-256 の照らしだけが見つける）
      const instFile = path.join(managedRoot, 'installed.json');
      const inst = I.readInstalled(instFile);
      for (const rec of Object.values(inst.items)) {
        for (const f of rec.files || []) if (f.name === name) f.mtimeMs = fs.statSync(dll).mtimeMs;
      }
      I.writeInstalled(instFile, inst);
    };
    if (managedMode === 'tamper') tamper('whisper-1.0.0', 'whisper.dll');
    if (serveSet) {
      // 利用者は前に［エンジンを取り込む］を押している（同意済み）
      const instFile = path.join(managedRoot, 'installed.json');
      I.writeInstalled(instFile, { ...I.readInstalled(instFile), consent: true });
    }
    // --managed --recover: 第2a1回 M-4 から、起動の復旧の文字起こしは起動の片付け（DB の用意）の後に回り、照らしは片付けを
    // STARTUP_DB_WAIT_MS（3 秒）まで待ってから始まる。DB の用意がそれより遅いと、照らしが先に終わって「確かめています」の保留を
    // 通らない（CI run 39240983508 の Windows）。照らしを、復旧が保留になったと engine.log に出るまで（15 秒まで）待たせ、場面を決まった順にする
    const holdVerifyForRecover = async () => {
      if (!recoverMode) return;
      const elog = path.join(userData, 'engine.log');
      await waitFor(() => { try { return fs.readFileSync(elog, 'utf8').includes('復旧の文字起こしを保留'); } catch (_) { return false; } }, 15000);
    };
    managedMods = {
      install: { ...I, engineRoot: () => home,
        verifyCandidates: verifyThrows ? async () => { verifyCalls += 1; throw new Error('照らしの試験の失敗𠮷'); }
          : async (...a) => { verifyCalls += 1; await holdVerifyForRecover(); return I.verifyCandidates(...a); },
        ...(serveSet ? { makeRunner: (deps) => I.makeRunner({ ...deps, fetchOpts: { requireHttps: false }, statfs: async () => ({ bavail: 1e6, bsize: 1e6 }) }) } : {}) },
      manifest: { ...realManifest, MANIFEST: Object.freeze({ schema: 1, items }) },
    };
  }
  // 0.10.0 LS-4（--retired-sum）: 0.9.x の要約の組（小さな表）を置き、retireSum をその表で呼ぶ
  if (retiredSum && !managedMods) {
    const I = require(path.join(ROOT, 'src', 'engine-install.js'));
    const home = { supported: true, root: path.join(localAppData, 'natsu', 'engine'), reason: '' };
    const SMALL_RETIRED = { dir: 'llama-b11669', files: [['llama-server.exe', 900], ['llama.dll', 2500], ['LICENSE-LLVM-OpenMP', 70]],
      model: { dest: 'models/gemma-4-E4B-it-Q4_K_M.gguf', size: 6000 }, ids: ['sum-engine', 'sum-model'] };
    if (!retiredSumNone) for (const [n, size] of SMALL_RETIRED.files) { const f = path.join(home.root, SMALL_RETIRED.dir, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, Buffer.alloc(size, 7)); }
    if (!retiredSumNone) { const mf = path.join(home.root, ...SMALL_RETIRED.model.dest.split('/')); fs.mkdirSync(path.dirname(mf), { recursive: true }); fs.writeFileSync(mf, Buffer.alloc(SMALL_RETIRED.model.size, 7)); }
    managedMods = { install: { ...I, engineRoot: () => home, retireSum: (h, o) => I.retireSum(h, { ...o, table: SMALL_RETIRED }) },
      manifest: require(path.join(ROOT, 'src', 'engine-manifest.js')) };
  }
  // 何も取り込んでいない PC（取り込める・取り込めない）。置き場所だけを決め、フォルダは作らない
  if (noEngine || (scene && !scene.engine)) {
    const I = require(path.join(ROOT, 'src', 'engine-install.js'));
    const home = noEngine === 'fetchable' ? { supported: true, root: path.join(localAppData, 'natsu', 'engine'), reason: '' }
      : I.engineRoot({}, 'linux', 'x64');
    managedMods = { install: { ...I, engineRoot: () => home }, manifest: require(path.join(ROOT, 'src', 'engine-manifest.js')) };
    // 第1d2回 M-1 の点検: installed.json を読めない（掴まれている）PC。readInstalled と同じ形（印 unreadable の空の記録）を返す
    if (installedUnreadable) managedMods.install.readInstalled = (f) => Object.defineProperty(I.readInstalled(path.join(f, '..', 'なし𠮷.json')), 'unreadable', { value: true });
    // 第1d2回 M-1: 取り込みのボタンを押した（同意）が、まだ何も取り込めていない
    if (fetchConsent && home.supported) {
      const instFile = I.layout(home.root, managedMods.manifest.MANIFEST).installed;
      fs.mkdirSync(path.dirname(instFile), { recursive: true });
      I.writeInstalled(instFile, { ...I.readInstalled(instFile), consent: true });
    }
  }
  // 取り込みを押す PC（--fetch）。置き場所だけを決め、フォルダは作らない（作るのは main の取り込みの係）。
  // 偽のサーバーは終わるまで開いておく
  let fetchManifest = null;
  if (fetchMode) {
    const I = require(path.join(ROOT, 'src', 'engine-install.js'));
    const realManifest = require(path.join(ROOT, 'src', 'engine-manifest.js'));
    const { smallSet } = require('./engine-small');
    fetchSet = await smallSet();
    // 文字起こしのモデルは大きさの床（50MB）を超える中身にする（取り込んだ後の engineCheck を通り、エンジンが起動する）
    const big = Buffer.alloc(51 * 1024 * 1024, 1);
    fetchSet.bodies['whisper-model'] = big;
    const items = fetchSet.manifest.items.map((it) => (it.id === 'whisper-model'
      ? { ...it, size: big.length, sha256: require('crypto').createHash('sha256').update(big).digest('hex') } : it));
    fetchManifest = Object.freeze({ schema: 1, items });
    managedRoot = path.join(localAppData, 'natsu', 'engine');
    managedExe = path.join(managedRoot, 'whisper-1.0.0', 'whisper-server.exe');
    const home = { supported: true, root: managedRoot, reason: '' };
    managedMods = {
      install: { ...I, engineRoot: () => home,
        makeRunner: (deps) => I.makeRunner({ ...deps, fetchOpts: { requireHttps: false }, statfs: async () => ({ bavail: 1e6, bsize: 1e6 }) }) },
      manifest: { ...realManifest, MANIFEST: fetchManifest },
    };
  }
  // 前回落ちた会議の下書き（main は起動のときに復旧ページを作り、残った音声を文字起こしし直す）
  // 第1d2回 M-5: 残した音声入力の WAV（8 日前の名前）・文字の入った同じ id の行がある WAV（保存した後・消す前に落ちた）
  if (oldDictwait || doneDictwait || waitDictwait) {
    const dw = path.join(userData, 'data', 'dictwait');
    fs.mkdirSync(dw, { recursive: true });
    if (oldDictwait) fs.writeFileSync(path.join(dw, `${Date.now() - 8 * 86400000}-hold8days.wav`), toneWav(1));
    if (doneDictwait) {
      const at = Date.now() - 60000;
      fs.writeFileSync(path.join(dw, `${at}-hdone1.wav`), toneWav(1));
      fs.writeFileSync(path.join(userData, 'history.json'), JSON.stringify([{ id: 'hdone1', text: '保存した後に落ちた音声入力の文', raw: '保存した後に落ちた音声入力の文',
        createdAt: new Date(at).toISOString(), durationSec: 1, procMs: 10, chars: 15 }]));
    }
    if (waitDictwait) {
      const at = Date.now() - 60000;
      fs.writeFileSync(path.join(dw, `${at}-hwait1.wav`), toneWav(1));
      fs.writeFileSync(path.join(userData, 'history.json'), JSON.stringify([{ id: 'hwait1', text: '（文字起こし待ち: 音声は残してあります）', raw: '',
        createdAt: new Date(at).toISOString(), durationSec: 1, procMs: 0, chars: 0, wait: `${at}-hwait1.wav` }]));
    }
  }
  // 第1d2回 M-3: PC の中だけの会議の下書き（--recover の draft.json より前の名前・前の時刻のフォルダ）
  if (extraQueue === 'localonly') {
    const startedAt = Date.now() - 900000;
    const wav = path.join(userData, 'data', 'segbuf', String(startedAt), '0001.wav');
    fs.mkdirSync(path.dirname(wav), { recursive: true });
    fs.writeFileSync(wav, toneWav(3));
    fs.writeFileSync(path.join(userData, 'data', `draft-${startedAt}.json`), JSON.stringify({ startedAt, memo: '', offsetMs: 3000, savedAt: startedAt + 3000,
      segments: [{ id: 's1', atMs: 0, durationMs: 3000, pending: true, wav, text: '' }], localOnly: true }));
  }
  if (extraQueue === 'localonly3') {   // 0.9.4 S-3
    const startedAt = Date.now() - 900000;
    const segs = [1, 2, 3].map((i) => {
      const wav = path.join(userData, 'data', 'segbuf', String(startedAt), `000${i}.wav`);
      fs.mkdirSync(path.dirname(wav), { recursive: true });
      fs.writeFileSync(wav, toneWav(3));
      return { id: `s${i}`, atMs: (i - 1) * 3000, durationMs: 3000, pending: true, wav, text: '' };
    });
    fs.writeFileSync(path.join(userData, 'data', `draft-${startedAt}.json`), JSON.stringify({ startedAt, memo: '', offsetMs: 9000, savedAt: startedAt + 9000, segments: segs, localOnly: true }));
  }
  if (recoverMode && !reuseData) {
    const startedAt = Date.now() - 600000;
    const wav = path.join(userData, 'data', 'segbuf', String(startedAt), '0001.wav');
    fs.mkdirSync(path.dirname(wav), { recursive: true });
    fs.writeFileSync(wav, audioWav(3));
    fs.writeFileSync(path.join(userData, 'data', 'draft.json'), JSON.stringify({ startedAt, memo: '', offsetMs: 3000, savedAt: startedAt + 3000,
      segments: [{ id: 's1', atMs: 0, durationMs: 3000, pending: true, wav, text: '' }], ...(localOnlyFlag ? { localOnly: true } : {}) }));
  }
  if (scene) {
    // 場面のファイルを、ふだんの settings.json の代わりに置く
    const base = { localServerExe: exe, localModelPath: model, localPort, sumPort, claudeExe };   // claudeExe: 0.10.0 LS-2（--claude の偽の claude か無いファイル）
    for (const [rel, body] of Object.entries(scene.files || {})) {
      const file = path.join(userData, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof body === 'function' ? body({ base, userData }) : body);
    }
    // 第1b回 Task A-2: %LOCALAPPDATA%（一時フォルダ）に置くもの（画面の覚え書きなど）
    for (const [rel, body] of Object.entries(scene.local || {})) {
      const file = path.join(localAppData, ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    if (typeof scene.prepare === 'function') scene.prepare(userData);
    for (const [k, v] of Object.entries(scene.env || {})) process.env[k] = String(v);
    // 第1d回 A-3: 種をまいた場面は、ログイン中のメールを settings.json にも書く（main がログインしたときと同じ形）
    if (seededMail) {
      const f = path.join(userData, 'settings.json');
      const cur = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
      fs.writeFileSync(f, JSON.stringify({ ...cur, accountEmail: seededMail }));
    }
  } else if (!((pillSettings || retiredSum || claudeScenePlaced) && keepUserData && fs.existsSync(path.join(userData, 'settings.json')))) {
    fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
      ...(managedMode || noEngine || fetchMode ? {} : { localServerExe: exe, localModelPath: model }), localPort, sumPort, autoLaunch: false,
      ...(withSum ? { sumServerExe: FAKE_SUM, sumModelPath: sumModel } : {}),
      ...((fakeStt || relayLocal) && consentFlag ? { cloudTranscribe: consentFlag } : {}),
      ...((fakeStt || relayLocal) && legacyProvider ? { sttProvider: 'custom', sttBaseUrl: (fakeStt || relayLocal.stt).base, sttModel: 'whisper-large-v3' } : {}),
      ...(seededMail ? { accountEmail: seededMail } : {}),
      ...(noWhisper ? { localServerExe: path.join(tmp, 'no-such-whisper-server.exe') } : {}),
      ...(maxHistoryFlag ? { maxHistory: Number(maxHistoryFlag) } : {}),   // 第1d2回 M-5
      ...(autoStopFlag === 'off' ? { autoStopQuiet: false } : {}),   // 0.9.1 Q-4
      ...(flagVal('--quality') ? { qualityScore: flagVal('--quality') } : {}),   // 0.11.0 Q-3
      ...(autoStopMinFlag ? { autoStopMin: autoStopMinFlag } : {}),
      ...(detectFlag === 'off' ? { meetingDetect: false } : {}),   // 0.9.3 M-2
      ...(detectMuteFlag ? { meetingDetectMute: detectMuteFlag.split(',') } : {}),
      ...(leaveFlag === 'off' ? { autoStopLeave: false } : {}),   // 0.12.1 LV-2
      ...(mcpGoneFlag ? { mcpRegisteredFor: { files: 1, version: '0.9.4' } } : {}),   // 0.10.0 C-2
      claudeExe,
      ...(pillSettings || {}),
    }));
  }
  const settingsBefore = pillSettings ? JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')) : null;

  const handlers = {}, listeners = {}, sent = [];
  // 第1d回 A-5: 録音バーへ送った区切りの長さ（overlay:start の payload と overlay:segment-ms の値）と、それと中継への要求の順
  const overlaySent = [];
  // 0.9.0 O-2: 録音バーの窓の setBounds の並びと、送った overlay:form。偽のカーソルの点
  const overlayBounds = [];
  const overlayForms = [];
  // 0.9.0 O-4: 録音バーの窓の hide／show／showInactive と送った overlay:phase の並び（panelCalls）・送った overlay:hover（hoverSent）・トレイの項目
  const panelCalls = [];
  const hoverSent = [];
  let trayItems = [];
  let cursorAt = { x: 0, y: 0 };
  const order = [];
  // 第1d回 A-6: meeting:update の stt の、前と違ったものだけの並びと、帯の符号ごとの初めのときの区間（WAV が残っているか）
  const sttSeen = [];
  const sttAt = {};
  const segWavExists = (id) => {
    const root = path.join(userData, 'data', 'segbuf');
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch (_) { return false; }
    return dirs.some((d) => fs.existsSync(path.join(root, d, `${String(id).slice(1)}.wav`)));
  };
  const segSnap = (segs) => (Array.isArray(segs) ? segs : []).map((x) => ({ id: x.id, text: x.text, failed: Boolean(x.failed), wav: segWavExists(x.id) }));
  const watchStt = (p) => {
    if (!p || typeof p !== 'object' || !p.stt || typeof p.stt !== 'object') return;   // 会議の外（stt: null）は並べない
    const j = JSON.stringify(p.stt);
    if (sttSeen.length && JSON.stringify(sttSeen[sttSeen.length - 1]) === j) return;
    sttSeen.push(JSON.parse(j));
    const code = p.stt && p.stt.problem ? p.stt.problem.code : '';
    if (code && !(code in sttAt)) sttAt[code] = segSnap(p.segments);
  };
  const shortcuts = {};   // globalShortcut.register の受け口（キー → 関数）。場面がホットキーを押す
  const registered = new Set();   // 0.9.0 U-1: 今登録している鍵（globalShortcut.isRegistered の答え）
  const escapeLog = [];           // 0.9.0 U-1: Escape の付け外しの順（'register'・'unregister'）
  // 画面へ送った知らせと進み具合の順。進み具合が初めて組を「使える」と言ったとき・壊れた知らせを送ったときの engine:status
  const seq = [];
  const atReady = {};
  let atBroken = null;
  const watch = (ch, p) => {
    if (ch === 'app:notice') {
      seq.push({ notice: p });
      if (atBroken === null && /ファイルが消えたか変わっていました/.test(p) && handlers['engine:status']) atBroken = handlers['engine:status']().whisper;
    }
    if (ch === 'engine:fetch-progress' && p && typeof p === 'object') {
      seq.push({ state: p.state, w: Boolean(p.whisperReady), checking: p.checking });   // 0.10.0 LS-3 で要約の組（sumReady）を外した
      for (const [g, k] of [['whisper', 'whisperReady']]) {
        if (p[k] && !(g in atReady) && handlers['engine:status']) atReady[g] = handlers['engine:status']()[g];
      }
    }
  };
  // 知らせ re を送った後に、組 key（w = whisperReady・s = sumReady）を「使える」と言う進み具合の写しが届いたか。main は
  // 切り替えて知らせた後で、空きの測り（非同期）を挟んでからこの写しを送るので、知らせだけを見て終えると写しを取り逃がす
  const switchedAfter = (re, key) => {
    const at = seq.findIndex((x) => x.notice && re.test(x.notice));
    return at >= 0 && seq.slice(at + 1).some((x) => !x.notice && x[key]);
  };
  // 画面の読み込み（--slow-load のときだけ、finishLoad まで読み込み中）。読み込み中に送ったものは画面に届かない（lost）
  let loading = slowLoad || Boolean(scene);
  const loadWaiters = [];
  const lost = [];
  const finishLoad = () => { loading = false; for (const cb of loadWaiters.splice(0)) cb(); };
  const wins = [];   // 作った窓の順（createOverlay が先、createMainWindow が後）
  const appEvents = makeEmitter();
  const zooms = [];   // setZoomFactor の値の順（第1b回 Task A-2）
  const portsSent = [];   // webContents.postMessage の窓と channel（第2a1回 M-2b）
  const utilFork = fakeFork({
    ...(dbDown ? { preload: path.join(__dirname, 'no-trigram.js') } : {}),
    ...(restartDuring === 'finalizing' ? { holdReply: 'meeting.finalize' } : {}),   // 第1d回 A-9: 締めの返事を場面が離すまで止める
  });   // 偽の utilityProcess.fork（場面が dbCrash で子を落とす）
  const mainWinCalls = [];   // 第1d回 A-8: 本体の窓の show・focus・restore の順
  // 0.9.3 M-2〜M-5: 会議の検出の見張りの偽の子（起こした引数・止めた数）・パネルの窓・本体の窓へ送った [channel, 中身]・起こし直しの時計の ms
  const micSpawns = [];
  const micKids = [];
  let micKills = 0;
  const nudgeWins = [];
  const mainSentAll = [];
  const restartDelays = [];
  const notifications = [];   // 第1d回 A-8: 偽の Notification の show() の { title, body }
  let notifyClosed = 0;       // 0.9.1 Q-4: 偽の Notification の close() の数
  // 偽の Electron の Notification（第1d回 A-8）。on('click') の受け口を覚え、--click-notify なら show() の直後に押す
  const noticeObjs = [];   // 0.12.1 LV-3: show() した偽の Notification（["click-notice", n] で n 番目を押す）
  class FakeNotification {
    static isSupported() { return !noNotify; }
    constructor(o) { makeEmitter(this); this.o = o || {}; }
    show() {
      if (notifyThrows) throw new Error('偽の知らせが壊れている');
      notifications.push({ title: this.o.title, body: this.o.body });
      noticeObjs.push(this);
      if (clickNotify) setTimeout(() => this.emit('click', {}), 0);
    }
    close() { notifyClosed += 1; this.closed = true; }
  }
  const mainSent = [];   // 本体の窓（wins[1]）の webContents.send の channel（読み込み中で届かなかったものも。第2a1回 M-2b の db:lost）
  // 第1b回 Task A-3: 録音バー（wins[0]）の［一時停止］の真似。main.js の2つの定数（PAUSE_ENSURE_ON・PAUSE_ENSURE_OFF）と同じ文だけを受け、
  // 本物の録音バーと同じく文が見る印のとおりに押す（'on' は止まっていなければ止める、'off' は止まっていれば再開する。同じなら何もしない）。
  // 状態が変わったときだけ、次の番で overlay:pause を返す。場面の overlayPause が 'lost-once' なら最初の1回は何もしない（眠る前に
  // 届かなかった）。'late' なら最初の1回は偽の録音バーの状態だけ変え、返事は場面が ctx.releasePause() を呼ぶまで出さない。
  // ほかの文（window.__koeStart など）は今どおり断る（main は IPC へ落ちる）
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const constOf = (name) => { const mm = mainSrc.match(new RegExp(`const ${name} = (".*");`)); return mm ? JSON.parse(mm[1]) : null; };
  const PAUSE_ON = constOf('PAUSE_ENSURE_ON');
  const PAUSE_OFF = constOf('PAUSE_ENSURE_OFF');
  const overlayMode = (scene && scene.overlayPause) || '';
  const overlayJs = [];
  let overlayPaused = false;
  let overlayCalls = 0;
  let heldPause = null;
  const replyPause = (paused) => setImmediate(() => { if (listeners['overlay:pause']) listeners['overlay:pause'](null, { paused }); });
  const releasePause = () => { if (heldPause) { const p = heldPause; heldPause = null; replyPause(p.paused); } };
  const overlayExec = (win, code) => {
    if (win !== wins[0] || typeof code !== 'string' || (code !== PAUSE_ON && code !== PAUSE_OFF)) return Promise.reject(new Error('no renderer'));
    overlayJs.push(code === PAUSE_ON ? 'on' : 'off');
    overlayCalls += 1;
    if (overlayCalls === 1 && overlayMode === 'lost-once') return Promise.resolve();
    // 文が見る印のとおりに押す（文が印を見ないで押すだけなら、本物と同じく押すたびに切り替わる: 変異 mp-suspend-ensure を赤にする）
    const press = /!p\.classList\.contains\('paused'\)\)/.test(code) ? !overlayPaused
      : (/p\.classList\.contains\('paused'\)\)/.test(code) ? overlayPaused : true);
    if (press) {
      overlayPaused = !overlayPaused;
      if (overlayCalls === 1 && overlayMode === 'late') heldPause = { paused: overlayPaused };
      else replyPause(overlayPaused);
    }
    return Promise.resolve();
  };
  // 第1d回 A-11: 偽の session（partition ごと。fake-net の makeFakeSession に、権限の受け口・will-download・clearStorageData の記録を足す）。
  // 名前が persist: で始まれば、本物と同じく userData の下に Partitions のフォルダを作る（cookie をディスクに置く形を試験が見つける）
  const { makeFakeSession } = require('./fake-net');
  const fakeSessions = new Map();
  const defaultSes = anyProxy();
  const fromPartition = (name) => {
    const key = String(name);
    if (fakeSessions.has(key)) return fakeSessions.get(key);
    if (key.startsWith('persist:')) fs.mkdirSync(path.join(userData, 'Partitions', key.slice(8) || 'x'), { recursive: true });
    const ses = makeEmitter(makeFakeSession());
    ses.perm = {};
    ses.setPermissionRequestHandler = (f) => { ses.perm.req = f; };
    ses.setPermissionCheckHandler = (f) => { ses.perm.check = f; };
    const clear = ses.clearStorageData;
    ses.clears = [];
    ses.clearStorageData = async (o) => { ses.clears.push(o === undefined ? 'all' : ((o && o.storages) || []).join(',')); return clear(); };
    fakeSessions.set(key, ses);
    return ses;
  };
  // ログインの partition の権限の頼み・確かめ・ダウンロードの答え（main が守りを付けたか）
  const accessPerms = () => {
    const ses = fakeSessions.get(ACCESS_PARTITION);
    if (!ses) return null;
    let req = null;
    try { if (ses.perm.req) ses.perm.req(null, 'media', (g) => { req = g; }, { mediaTypes: ['audio'] }); } catch (_) { req = 'threw'; }
    let check = null;
    try { check = ses.perm.check ? ses.perm.check(null, 'media', '', { mediaType: 'audio' }) : null; } catch (_) { check = 'threw'; }
    let downloadPrevented = false;
    ses.emit('will-download', { preventDefault() { downloadPrevented = true; } });
    return { req, check, downloadPrevented };
  };
  // 偽のログインの窓（ログインの partition の BrowserWindow）。動きは loginMode（--access-login・ctx.access.mode）
  let loginMode = accessLoginFlag && accessLoginFlag !== 'unreadable' ? accessLoginFlag : 'ok';
  const loginRecs = [];
  const loginWinsList = [];
  const loginMail = () => seededMail || require('./relay-run').mail('kaigi');
  const fireNav = (wc, kind, url, isMainFrame = true) => {
    const ev = { url, isMainFrame, prevented: false, preventDefault() { ev.prevented = true; } };
    wc.emit(kind, ev);
    return !ev.prevented;
  };
  // 第1d回 A-11 の点検（F25）: 本体の窓（wins[1]）・録音バー（wins[0]）・開いているログインの窓の webContents に、ログインの窓なら通す移動
  // （中継の /auth/done と Access のログインの画面。本体の枠と中の枠）を起こし、通したか（true）を窓ごとの並びで返す（will-redirect は
  // 起こさない: 全体の守りは移動の始まりを止めるので、ほかの窓に転送は来ない）。
  // 本体の窓と録音バーは main の isLoginContents が偽で、全体の「必ず止める」のまま（全部 false）であること
  const NAV_PROBE = [['will-navigate', 'relay', true], ['will-navigate', 'access', true], ['will-frame-navigate', 'access', true],
    ['will-frame-navigate', 'access', false]];
  const navProbe = () => {
    const url = (k) => (k === 'relay' ? LOGIN_URL : 'https://natsu-test.cloudflareaccess.com/cdn-cgi/access/login/natsu');
    const probe = (wc) => (wc ? NAV_PROBE.map(([kind, k, main]) => fireNav(wc, kind, url(k), main)) : null);
    const lw = loginWinsList.filter((x) => !x.destroyed).pop();
    return { overlay: probe(wins[0] && wins[0].webContents), main: probe(wins[1] && wins[1].webContents), login: probe(lw && lw.webContents) };
  };
  async function runLogin(win, rec, mode) {
    if (win.destroyed) return;
    const wc = win.webContents;
    rec.openHandler = typeof wc.openHandler === 'function' ? wc.openHandler({ url: 'https://evil.example/popup' }) : null;
    win.emit('ready-to-show');
    const nav = (code) => wc.emit('did-navigate', {}, LOGIN_URL, code, '');
    if (mode === 'hold') return;
    if (mode === 'cancel') { win.close(); return; }
    if (mode === 'wander') { rec.wanderPrevented = !fireNav(wc, 'will-navigate', 'https://evil.example/phish'); return; }
    // 第1d回 A-11 の点検: 最初に着いた Access のホスト（natsu-test）に窓を留める。そこからほかのチームの Access へ転送されたら止める。
    // 止めなければ（留めていない）窓を利用者が閉じた形にする（場面が待ち続けない。答えは cancel になり、試験が赤になる）
    if (mode === 'other-team') {
      rec.accessFormAllowed = fireNav(wc, 'will-navigate', 'https://natsu-test.cloudflareaccess.com/cdn-cgi/access/login/natsu');
      rec.otherTeamPrevented = !fireNav(wc, 'will-redirect', 'https://other-team.cloudflareaccess.com/cdn-cgi/access/login/natsu');
      if (!rec.otherTeamPrevented && !win.destroyed) win.close();
      return;
    }
    if (mode === 'failload') { wc.emit('did-fail-load', {}, -130, 'ERR_PROXY_CONNECTION_FAILED', LOGIN_URL, true); return; }
    if (mode === 'denied403') { nav(403); return; }
    if (mode === 'notready') { nav(503); return; }
    if (mode === 'nocookie') { nav(200); return; }
    // ok・denied: Cloudflare のログインの画面へのフォームの送りと、/auth/done への転送（どちらも守りが通すはず）
    rec.accessFormAllowed = fireNav(wc, 'will-navigate', 'https://natsu-test.cloudflareaccess.com/cdn-cgi/access/login/natsu');
    rec.redirectAllowed = fireNav(wc, 'will-redirect', LOGIN_URL);
    const ses = wc.session;
    const mail = mode === 'denied' ? require('./relay-run').mail('kaigi', 'other.example') : loginMail();
    await ses.cookies.set(await relayLocal.cookieFor(mail, { ttlSec: SEED_TTL_SEC }));
    // しまってはいけない cookie（Access の CSRF 用・親のドメイン・ほかのホスト）
    await ses.cookies.set({ url: RELAY_BASE, name: 'CF_AppSession', value: 'app-session-cookie', secure: true, httpOnly: true, sameSite: 'no_restriction' });
    await ses.cookies.set({ url: `https://${RELAY_HOST.split('.').slice(1).join('.')}/`, domain: RELAY_HOST.split('.').slice(1).join('.'), name: 'CF_Authorization', value: 'parent-domain-cookie', secure: true, sameSite: 'no_restriction' });
    await ses.cookies.set({ url: 'https://other.example/', name: 'CF_Authorization', value: 'other-host-cookie', secure: true, sameSite: 'no_restriction' });
    if (!win.destroyed) nav(200);
  }
  function makeLoginWin(win) {
    const o = win.opts;
    const rec = { webPreferences: { ...(o.webPreferences || {}) }, modal: o.modal, parent: o.parent && o.parent === wins[1] ? 'main' : (o.parent ? 'other' : 'none'),
      width: o.width, height: o.height, title: o.title, show: o.show, openHandler: null, accessFormAllowed: null, redirectAllowed: null,
      wanderPrevented: null, otherTeamPrevented: null, shown: false, focused: 0, closed: false };
    loginRecs.push(rec);
    loginWinsList.push(win);
    win.destroyed = false;
    win.isDestroyed = () => win.destroyed;
    win.show = () => { rec.shown = true; };
    win.focus = () => { rec.focused += 1; };
    win.close = () => { if (win.destroyed) return; win.destroyed = true; rec.closed = true; setImmediate(() => win.emit('closed')); };
    win.loadURL = (url) => {
      rec.url = String(url);
      const mode = loginMode;
      setTimeout(() => { runLogin(win, rec, mode).catch((e) => { rec.error = String((e && e.message) || e); }); }, 0);
      return Promise.resolve();
    };
  }
  let maximizeCalls = 0;
  class Win {
    constructor(opts) {
      makeEmitter(this);
      this.opts = opts || {};
      this.pos = [0, 0];
      this.normal = null;      // 場面が入れる getNormalBounds の値（無ければ作ったときの値）
      this.bounds = null;      // 場面が入れる getBounds の値（無ければ今までの固定の値）
      this.maximized = false;
      this.minimized = false;
      this.zoom = 1;
      // 受け口つきの webContents（on／once／emit）。読み込み中の once('did-finish-load') は今までどおり読み終えたときに呼ぶ
      const wc = makeEmitter({
        send: (ch, p) => {
          if (wins.indexOf(this) === 0 && (ch === 'overlay:start' || ch === 'overlay:segment-ms')) { overlaySent.push(p); order.push(ch); }
          if (wins.indexOf(this) === 0 && ch === 'overlay:form') overlayForms.push(p);
          if (wins.indexOf(this) === 0 && ch === 'overlay:phase') panelCalls.push(`phase:${p && p.phase}`);
          if (wins.indexOf(this) === 0 && ch === 'overlay:hover') hoverSent.push(p);
          if (wins.indexOf(this) === 1 && ch === 'meeting:update') watchStt(p);
          if (wins.indexOf(this) >= 2 && this.nudge) this.nudge.sent.push([ch, p]);   // 0.9.3 M-3: パネルの窓へ送ったもの
          if (wins.indexOf(this) === 1) mainSentAll.push([ch, p]);
          if (wins.indexOf(this) === 1) mainSent.push(ch); if (loading) { lost.push([ch, p]); return; } sent.push([ch, p]); watch(ch, p); },
        isLoading: () => loading,
        setWindowOpenHandler(f) { wc.openHandler = f; }, executeJavaScript: (code) => overlayExec(this, code),
        setZoomFactor: (z) => { zooms.push(z); this.zoom = z; },
        // 第2a1回 M-2b: DB の口を渡した窓と channel（口はこの台では誰も使わない）
        postMessage: (ch) => { portsSent.push({ win: wins.indexOf(this) === 0 ? 'overlay' : 'main', channel: ch }); },
        getZoomFactor: () => this.zoom,
      });
      // 第1d回 A-11: webContents の session（ログインの窓はその partition の偽の session。ほかは既定の session）
      const part = this.opts.webPreferences && typeof this.opts.webPreferences.partition === 'string' ? this.opts.webPreferences.partition : '';
      wc.session = part ? fromPartition(part) : defaultSes;
      const emitterOnce = wc.once;
      wc.once = (ev, cb) => { if (ev === 'did-finish-load' && loading) { loadWaiters.push(cb); return wc; } return emitterOnce(ev, cb); };
      this.webContents = withFallback(wc);
    }
    isDestroyed() { return false; }
    // 第1d回 A-8: 本体の窓（wins[1]）だけ --main-hidden で隠れ、--main-minimized で最小化した形で始まる。show・focus・restore は順に覚える
    isVisible() { return !(this.isMain() && mainHidden && !this.shown); }
    isFocused() { return !(this.isMain() && mainUnfocused && !this.focused); }
    isMinimized() { return this.minimized || (this.isMain() && mainMinimized && !this.restored); }
    isMain() { return wins.indexOf(this) === 1; }
    show() { this.rec('show'); if (this.isMain()) { this.shown = true; mainWinCalls.push('show'); } else if (this.isOverlay()) panelCalls.push('show'); }
    // 0.9.0 O-4: 録音バーの窓の出し隠しを順に覚える（本体の窓は今までどおり何もしない）
    showInactive() { this.rec('showInactive'); if (this.isOverlay()) panelCalls.push('showInactive'); }
    hide() { this.rec('hide'); if (this.isOverlay()) panelCalls.push('hide'); }
    focus() { this.rec('focus'); if (this.isMain()) { this.focused = true; mainWinCalls.push('focus'); } }
    // 0.9.3 M-3: 3つ目からの窓（パネル）の呼び出しを順に覚える（ログインの窓は数えない）
    rec(name, arg) { if (this.nudge) this.nudge.calls.push(arg === undefined ? name : [name, arg]); }
    setContentProtection(on) { this.rec('setContentProtection', on); }
    setAlwaysOnTop(on, level) { this.rec('setAlwaysOnTop', [on, level || '']); }
    isVisibleNudge() { return Boolean(this.nudgeVisible); }
    restore() { if (this.isMain()) { this.restored = true; mainWinCalls.push('restore'); } }
    isMaximized() { return this.maximized; }
    maximize() { maximizeCalls += 1; this.maximized = true; }
    // 0.9.0 O-2: 録音バーの窓（wins[0]）だけ、作ったときの大きさと setBounds の大きさを返す（本体の窓は今までどおり）
    getSize() { return this.isOverlay() ? this.panelSize() : [316, 72]; }
    setPosition(x, y) { this.pos = [x, y]; }
    getPosition() { return this.pos.slice(); }
    getBounds() {
      if (this.bounds) return { ...this.bounds };
      if (this.isOverlay()) { const [width, height] = this.panelSize(); return { x: this.pos[0], y: this.pos[1], width, height }; }
      return { x: 0, y: 0, width: 316, height: 72 };
    }
    isOverlay() { return wins.indexOf(this) === 0; }
    panelSize() { return this.size ? this.size.slice() : [this.opts.width || 316, this.opts.height || 72]; }
    setBounds(b) {
      if (this.nudge) { this.rec('setBounds', { x: b.x, y: b.y, width: b.width, height: b.height }); this.nb = { ...b }; }
      if (!this.isOverlay()) return;
      overlayBounds.push({ x: b.x, y: b.y, width: b.width, height: b.height });
      this.pos = [b.x, b.y];
      this.size = [b.width, b.height];
    }
    getNormalBounds() {
      if (this.normal) return { ...this.normal };
      const o = this.opts;
      return { x: Number.isFinite(o.x) ? o.x : 0, y: Number.isFinite(o.y) ? o.y : 0, width: o.width || 800, height: o.height || 600 };
    }
  }
  for (const m of ['setVisibleOnAllWorkspaces', 'loadFile',
    'setIgnoreMouseEvents', 'setSkipTaskbar', 'close',
    'destroy', 'setMenuBarVisibility', 'removeMenu', 'moveTop', 'setBackgroundColor', 'setTitle', 'setIcon']) {
    Win.prototype[m] = function () {};
  }
  // 作った窓を順に覚え、app の browser-window-created を出す（main が窓ごとに受け口を付ける所を確かめる）
  class TrackedWin extends Win {
    constructor(...a) {
      super(...a);
      wins.push(this);
      if (this.opts.webPreferences && this.opts.webPreferences.partition === ACCESS_PARTITION) makeLoginWin(this);
      else if (wins.length >= 3) { this.nudge = { opts: JSON.parse(JSON.stringify(this.opts)), calls: [], sent: [] }; nudgeWins.push(this); }   // 0.9.3 M-3
      appEvents.emit('browser-window-created', {}, this);
      appEvents.emit('web-contents-created', {}, this.webContents);   // 第1d回 A-11: security.install の守りを付ける
    }
  }
  let readyResolve;
  const ready = new Promise((r) => { readyResolve = r; });
  let ipcReady;
  const ipcReadyP = new Promise((r) => { ipcReady = r; });
  // 省電力の抑止（取り込み中は眠らせない: 第0b回 Task 14）と、［取り込み先を開く］の記録
  const power = [];
  let powerId = 0;
  const opened = [];
  const external = [];   // 0.9.2 I-1: shell.openExternal に渡した住所
  const powerMonitor = withFallback(makeEmitter());
  // トレイ（第1c回 A-4: displayBalloon の文を残す。ほかの呼び出しは今までどおり受け流す）
  const balloons = [];
  class FakeTray {
    constructor() {
      return withFallback(makeEmitter({
        displayBalloon: (o) => { balloons.push(String((o && o.content) || '')); },
        // 0.9.0 O-4: 今のトレイの項目（Menu.buildFromTemplate の偽物が項目をそのまま持つ）
        setContextMenu: (menu) => { trayItems = menu && Array.isArray(menu.items) ? menu.items : []; },
      }));
    }
  }
  // 偽の safeStorage（secrets.test.js の偽物と同じ形。暗号の代わりに印を付けた hex）。復号の回数は out.decrypts に残す
  // （同意が ask・［PC の中だけ］では鍵を復号しない。Linux・macOS では復号でキーリングの確かめが出ることがある）
  let decrypts = 0;
  let decryptBlocked = accessLoginFlag === 'unreadable';   // 第1d回 A-11（F26）: ctx.access.allowDecrypt() まで復号できない
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => !noStore,
    getSelectedStorageBackend: () => 'gnome_libsecret',
    encryptStringAsync: async (str) => fakeEnc(str),
    decryptStringAsync: async (b) => {
      decrypts += 1;
      if (keyUnreadable || decryptBlocked) throw Object.assign(new Error('safeStorage: 一時的に使えない（試験）'), { code: 'ERR_TEST_UNAVAILABLE' });
      return { result: Buffer.from(String(b).slice(5), 'hex').toString('utf8'), shouldReEncrypt: false };
    },
  };
  // 外の宛先の書き換え: Anthropic へ届くかの確かめだけを偽の送り先へ（ほかは書き換えず、127.0.0.1 でなければ fake-net が死ぬ）。
  // 偽の claude を置く場面（--claude）だけ。--stt だけの場面（第1c回 A-4）で書き換えると、要約が Claude Code の道へ行き、
  // PATH の上の claude を探してしまう（起こすのは mainrun の spawn が止めるが、返事の来ない子を待って場面が時間切れになる）
  // 0.7.0 U-1: OpenAI（固定の送り先）への要求は、偽の送り先（--stt）か、場面が setOpenAiBase で決めた 127.0.0.1 の口へ書き換える。
  // 書き換える前の宛先のホストは out.netHosts に残す（前の版の「そのほか」の URL へ直に送っていないことを見る）
  let openAiBase = fakeStt ? fakeStt.base : '';
  // 第1d回 A-3: main の時計（Date.now）を場面が進める分（ctx.advanceClock）。中継の試しの時計も同じだけ進める
  const realDateNow = Date.now;
  let clockOffset = 0;
  const advanceClock = (ms) => {
    clockOffset += ms;
    Date.now = () => realDateNow() + clockOffset;
    if (relayLocal) relayLocal.clock.advance(ms);
  };
  // 0.9.4 CI-1: --real-now=<ミリ秒> … 本当の時刻をその時刻とみなす（main と中継の試しの時計をその分だけずらす。日付の変わり目の近くで走らせた形を試す）
  const realNowFlag = Number(flagVal('--real-now'));
  if (Number.isFinite(realNowFlag) && realNowFlag > 0) advanceClock(realNowFlag - realDateNow());
  // 0.9.4 CI-1: 時計を進める場面（json-scenes の noonJst: true）は、時計の始まりをその日の日本時間の正午にする（11 分・1 日を進めても日付の変わり目の近くに来ない）
  if (scene && scene.noonJst === true) {
    const jst = new Date(Date.now() + 9 * 3600 * 1000);
    advanceClock(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), 3, 0, 0) - Date.now());
  }
  let netUp = !offline;   // 偽の net.isOnline() の答え（場面の ctx.setOnline で変えられる）
  const netHosts = [];
  const rewrite = (u) => {
    const s = String(u);
    try { netHosts.push(new URL(s).host); } catch (_) { netHosts.push(''); }
    if (relayLocal && s.startsWith(`${RELAY_BASE}/`)) { relayPaths.push(s.slice(RELAY_BASE.length)); order.push(`relay ${s.slice(RELAY_BASE.length)}`); return relayTarget + s.slice(RELAY_BASE.length); }
    if (openAiBase && s.startsWith(`${OPENAI_BASE}/`)) return `${openAiBase}${s.slice(OPENAI_BASE.length)}`;
    const anth = fakeStt || (relayLocal && relayLocal.stt) || claudeReach;   // 第1d回 A-3: --relay の場面は中継の後ろの偽の OpenAI の /anthropic
    return anth && claudeMode && s.startsWith('https://api.anthropic.com/') ? anth.url('/anthropic') : u;
  };
  // --stt=cert: OpenAI への要求は、証明書が差し替えられたときの失敗で死ぬ（会社の通信の検査。RF26）。
  // --relay-cert（第1d回 A-3・RF36）: 中継（RELAY_BASE）への要求が同じ失敗で死ぬ
  const certFor = sttMode === 'cert' ? `${OPENAI_BASE}/` : (relayCert ? `${RELAY_BASE}/` : '');
  const before = certFor ? (_n, o) => (o && String(o.url).startsWith(certFor) ? { error: 'net::ERR_CERT_AUTHORITY_INVALID' } : null) : null;
  // 偽の screen（第1b回 Task A-2）。並びは場面の displays（既定は 1920×1080 が1つ。作業領域は下のタスクバーを除いた 1920×1040）
  const displays = (scene && scene.displays) || displaysFlag || [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  const inRect = (p, r) => p && p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
  const screen = {
    getAllDisplays: () => displays.map((d) => JSON.parse(JSON.stringify(d))),
    getPrimaryDisplay: () => JSON.parse(JSON.stringify(displays[0])),
    getDisplayNearestPoint: (p) => JSON.parse(JSON.stringify(displays.find((d) => inRect(p, d.bounds)) || displays[0])),
    getCursorScreenPoint: () => ({ ...cursorAt }),
  };
  // 第2a1回 M-4: 偽の dialog.showMessageBox（移行の窓 D0）。出した窓の { message, detail, buttons, defaultId, cancelId } を dialogs に順に残し、
  // 場面の dialog が 'quit' なら 2 番目（［今は移さずに終える］）、'hold' なら ctx.answerDialog(i) まで答えず、それ以外（無い）なら
  // 1 番目（［移す］）を押す（JSON のページを置く今の場面は、そのまま移されてから動く）。ほかの dialog の関数は今どおり何でも返す
  const dialogs = [];
  const heldDialogs = [];
  const syncDialogs = [];
  const dialog = withFallback({
    showMessageBox: (...a) => {
      const o = a.find((x) => x && typeof x === 'object' && Array.isArray(x.buttons)) || a[a.length - 1] || {};
      dialogs.push({ message: String(o.message || ''), detail: String(o.detail || ''), buttons: Array.isArray(o.buttons) ? o.buttons.slice() : [], defaultId: o.defaultId, cancelId: o.cancelId });
      const pick = scene ? scene.dialog : undefined;
      if (pick === 'hold') return new Promise((resolve) => { heldDialogs.push(resolve); });
      return Promise.resolve({ response: pick === 'quit' ? 1 : 0, checkboxChecked: false });
    },
    showMessageBoxSync: (...a) => {
      const o = a.find((x) => x && typeof x === 'object' && Array.isArray(x.buttons)) || {};
      syncDialogs.push({ message: String(o.message || ''), detail: String(o.detail || ''), buttons: Array.isArray(o.buttons) ? o.buttons.slice() : [] });
      return scene && Number.isInteger(scene.closeAnswer) ? scene.closeAnswer : 1;
    },
  });
  const answerDialog = (i) => { const r = heldDialogs.shift(); if (r) r({ response: i, checkboxChecked: false }); return Boolean(r); };
  // app.quit() の呼ばれた回数（第2a1回 M-4）。場面の quitEmits なら本物と同じく before-quit を出す（main は DB を閉じてから app.quit() をもう一度呼ぶ）
  let quitCalls = 0;
  // 第1d回 A-9: 再起動（relaunch）の回数と、そのときの DB の客の状態（閉じてから再起動したか）。取り込み（updater.apply）の回数
  let relaunches = 0;
  const relaunchDb = [];
  let applyCalls = 0;
  let releaseClose = null;   // --restart-during=closing: 止めている main の db.close を始める
  const restartApp = restartDuring ? {
    relaunch() { relaunches += 1; relaunchDb.push(dbClient ? dbClient.state() : 'none'); },
    exit() {},
    getAppPath() { const d = path.join(tmp, 'アプリ𠮷'); fs.mkdirSync(d, { recursive: true }); return d; },
  } : {};
  // 0.9.3 M-3: 偽の nativeTheme（--dark で暗い。場面の ["theme", dark] で変えて updated を出す）
  const nativeTheme = makeEmitter({ shouldUseDarkColors: darkFlag, themeSource: 'system' });
  // 第1d2回 M-1: 偽のクリップボード。書いた文字を順に覚える（音声入力の文字を貼り付けに回したか。out.pastes）
  const clipWrites = [];
  let clipText = '';
  const clipboard = withFallback({ writeText: (t) => { clipText = String(t); clipWrites.push(clipText); }, readText: () => clipText });
  const electron = withFallback({
    screen,
    dialog,
    clipboard,
    app: withFallback(Object.assign(appEvents, {
      getPath: (name) => (name === 'appData' ? appDataDir : userData), whenReady: () => ready, requestSingleInstanceLock: () => true,   // 0.10.0 C-2: appData
      getVersion: () => require(path.join(ROOT, 'package.json')).version, isPackaged: packagedFlag,   // 0.10.0 LN-3: --packaged
      isDefaultProtocolClient: (...a) => { protocolCalls.push(['isDefaultProtocolClient', ...a]); return protocolDefaultFlag; },
      setAsDefaultProtocolClient: (...a) => { protocolCalls.push(['setAsDefaultProtocolClient', ...a]); return true; },
      quit() { quitCalls += 1; if (scene && scene.quitEmits) appEvents.emit('before-quit', { preventDefault() {} }); },
      setLoginItemSettings() {}, getLoginItemSettings: () => ({}), setAppUserModelId() {}, getName: () => 'natsu',
      ...(mcpScene ? { getAppPath: () => ROOT } : {}),   // 0.10.0 C-2: MCP の場面だけ（src/mcp/server.js の場所）
      ...restartApp,
    })),
    BrowserWindow: TrackedWin,
    session: withFallback({ defaultSession: defaultSes, fromPartition }),   // 第1d回 A-11
    powerMonitor,
    // engine:status を付けたら（setupIpc）、その同じ手番が済んだ直後のマイクロタスクで ipcReady を解く（第2a1回 M-2b。起動は復旧の
    // DB の書き込みを待ってから setupIpc に来るので、ready からマイクロタスクを数えるだけでは届かない）
    ipcMain: { handle: (ch, f) => { handlers[ch] = f; if (ch === 'engine:status') queueMicrotask(ipcReady); }, on: (ch, f) => { listeners[ch] = f; }, removeHandler() {} },
    // 0.9.0 U-1: 登録している鍵を覚え（isRegistered が答える）、Escape の付け外しを out.escape に順に残す（--focus-main-during-dictation）
    globalShortcut: {
      register: (acc, cb) => { shortcuts[acc] = cb; registered.add(acc); if (acc === 'Escape') escapeLog.push('register'); return true; },
      unregister: (acc) => { if (registered.delete(acc) && acc === 'Escape') escapeLog.push('unregister'); },
      unregisterAll: () => { if (registered.has('Escape')) escapeLog.push('unregister'); registered.clear(); },
      isRegistered: (acc) => registered.has(acc),
    },
    nativeTheme,
    // 取り込みの通信は Electron の net.request（第0b回 RF2）。テストでは同じ振る舞いの偽物（127.0.0.1 の偽のサーバーへ）
    net: { request: require('./fake-net').makeFakeRequest({ before, rewrite }), isOnline: () => netUp },
    Tray: FakeTray,
    Menu: { buildFromTemplate: (items) => ({ items }) },   // 0.9.0 O-4: トレイの項目を読めるように
    safeStorage,
    powerSaveBlocker: { start: (type) => { powerId += 1; power.push(['start', type, powerId]); return powerId; }, stop: (id) => { power.push(['stop', id]); }, isStarted: () => false },
    shell: withFallback({ openPath: (p) => { opened.push(p); return Promise.resolve(''); }, openExternal: (u) => { external.push(String(u)); return Promise.resolve(); } }),
    // 第2a1回 M-2b: 議事録の DB のプロセス（worker_threads の中の本物の server.js）と口
    utilityProcess: { fork: utilFork },
    MessageChannelMain: FakeChannel,
    Notification: FakeNotification,
  });
  // エンジンの spawn だけを本物にする（.js なら node で起動）。それ以外（貼り付け用の PowerShell など）は起動しない
  const realSpawn = cp.spawn;
  const spawns = [];   // エンジンの起動（実行ファイル・引数・作業フォルダ）
  const fakeKids = [];   // エンジンを持たない場面で返した偽の子（{ cmd, kills }。第2a1回 M-1: 終了でエンジンを止めたかを見る）
  // 第1b回の続き Lane F-c・F-d: scene.claude の場面で main が起こす powershell.exe -EncodedCommand（見える窓を開く隠した PowerShell）は本当には起こさず、
  // launches に { cmd, args, exe（環境の NATSU_CLAUDE_EXE）, shell, windowsHide, ansiKeys（課金の変数の名前） } で覚え、
  // launchPlan の先頭の終わりの番号（無ければ 0）で 20ms 後に閉じる偽の子を返す（act が launchPlan に積む）
  const launches = [];
  const launchPlan = [];
  let crashed = false;  // --crash・--crash-ok: 最初の起動だけ 0xC0000135 で落とした
  const tasklistCalls = [];   // 0.10.0 C-2: --tasklist で答えた tasklist.exe の呼び出し
  const childProcess = {
    ...cp,
    spawn(cmd, args, opts) {
      // 0.9.3 M-2: 会議の検出の見張り（本当には起こさない。場面が stdout に行を書く）
      if ((micSteps || quietMic) && /(^|[\\/])powershell\.exe$/i.test(String(cmd)) && Array.isArray(args) && String(args[args.length - 1]).includes('CapabilityAccessManager')) {
        const EventEmitter = require('events');
        const p = new EventEmitter();
        p.stdin = null; p.stdout = new EventEmitter(); p.stderr = null;
        p.kill = () => { micKills += 1; setTimeout(() => p.emit('exit', null, 'SIGTERM'), 1); };
        micSpawns.push({ cmd: String(cmd), args: args.slice(), opts: { windowsHide: Boolean(opts && opts.windowsHide) } });
        micKids.push(p);
        return p;
      }
      if (scene && scene.claude && cmd === FAKE_CLAUDE) {
        // 偽の claude を使う場面（scene.claude。設定の［Claude Code を確かめる］）: 偽の claude を node で起こす
        const k = realSpawn(process.execPath, [FAKE_CLAUDE, ...args], { ...opts, env: fakeClaudeEnv(opts && opts.env) });
        kids.push(k);
        return k;
      }
      // 窓を開く PowerShell だけ（-EncodedCommand）。Windows で起動のときに起こす貼り付けの常駐 PowerShell（-Command）は今までどおり下の偽の子
      if (scene && scene.claude && /(^|[\\/])powershell\.exe$/i.test(String(cmd)) && Array.isArray(args) && args.includes('-EncodedCommand')) {
        const env = (opts && opts.env) || {};
        launches.push({ cmd, args, exe: env.NATSU_CLAUDE_EXE || '', shell: opts && opts.shell, windowsHide: opts && opts.windowsHide,
          billingKeys: Object.keys(env).filter((k) => /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_)/i.test(k)) });
        const EventEmitter = require('events');
        const p = new EventEmitter();
        p.pid = 4242; p.stdin = { on: () => {}, end: () => {} }; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
        const code = launchPlan.length ? launchPlan.shift() : 0;
        setTimeout(() => p.emit('close', code), 20);
        return p;
      }
      if (scene && scene.claude && cmd === path.join(userData, 'bin', 'claude.exe')) {
        // 見える窓の場面の claude.exe（中身は空のファイル。findClaude と窓の組み立てが claude.exe を求める）: 偽の claude を node で起こす
        const k = realSpawn(process.execPath, [FAKE_CLAUDE, ...args], { ...opts, env: fakeClaudeEnv(opts && opts.env) });
        kids.push(k);
        return k;
      }
      if (scene && scene.claude && cmd === path.join(userData, 'claude-noexec.exe')) {
        // 場所のファイルはあるが起こせない（実行できない中身）。本当に起こそうとして 'error' を受ける
        const k = realSpawn(cmd, args, opts);
        kids.push(k);
        return k;
      }
      if (scene && !scene.engine && !(claudeMode && cmd === FAKE_CLAUDE)) {   // 0.10.0 LS-2: --claude の偽の claude は下で起こす
        // エンジンを持たない場面: 手のパスが設定にあっても起こさない（偽の子を返す）。起こそうとした実行ファイルと止めた回数を fakeKids に残す
        const EventEmitter = require('events');
        const p = new EventEmitter();
        const rec = { cmd: String(cmd), kills: 0 };
        fakeKids.push(rec);
        p.stdin = null; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => { rec.kills += 1; };
        return p;
      }
      if (crashMode && !crashed && managedExe && cmd === managedExe) {
        // 照らし終えた後で、ウイルス対策が DLL を消した（--crash）。起動した exe は DLL が見つからず 0xC0000135 で落ちる
        crashed = true;
        spawns.push({ cmd, args, cwd: (opts && opts.cwd) || '', crash: true });
        if (crashMode === 'broken') fs.rmSync(path.join(managedRoot, 'whisper-1.0.0', 'whisper.dll'));
        const EventEmitter = require('events');
        const p = new EventEmitter();
        p.stdin = null; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
        setTimeout(() => p.emit('exit', 3221225781, null), 30);
        return p;
      }
      if (claudeMode && cmd === FAKE_CLAUDE) {
        // 偽の claude を node で起こす（env は main が課金の変数を外したもの。Windows の SystemRoot だけ元に戻す）
        const k = realSpawn(process.execPath, [FAKE_CLAUDE, ...args], { ...opts, env: fakeClaudeEnv(opts && opts.env) });
        kids.push(k);
        return k;
      }
      if (cmd === exe || (withSum && cmd === FAKE_SUM) || (managedExe && cmd === managedExe)) {
        spawns.push({ cmd, args, cwd: (opts && opts.cwd) || '' });
        // 取り込んだ exe（中身は試験のバイト列）の代わりに、偽の whisper を node で起動する
        const js = managedExe && cmd === managedExe ? FAKE : cmd;
        const o = { ...opts, env: childEnv(opts && opts.env) };
        const k = /\.js$/i.test(js) ? realSpawn(process.execPath, [js, ...args], o) : realSpawn(js, args, o);
        kids.push(k);
        return k;
      }
      const EventEmitter = require('events');
      const p = new EventEmitter();
      p.stdin = null; p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
      return p;
    },
    execFile(_cmd, _args, _opts, cb) {
      const done = typeof _opts === 'function' ? _opts : cb;
      // 0.10.0 C-2: --tasklist のときは tasklist.exe に答える（頭の注釈）。0.10.1 CD-3 で意図して変えた: MCP の場面では旗が無ければ stopped。
      // 「a,b,c」なら呼ばれるたびに順に答え、尽きたら最後の答えのまま
      if (tasklistPlan.length && /(^|[\\/])tasklist\.exe$/i.test(String(_cmd))) {
        tasklistCalls.push({ cmd: _cmd, args: _args, opts: typeof _opts === 'function' ? null : _opts });
        const kind = tasklistPlan[Math.min(tasklistCalls.length - 1, tasklistPlan.length - 1)];
        const answer = kind === 'running' ? '"claude.exe","1234","Console","1","123,456 K"\r\n' : 'INFO: No tasks are running which match the specified criteria.\r\n';
        if (done) setImmediate(() => (kind === 'fail' ? done(new Error('tasklist failed')) : done(null, answer, '')));
        return anyProxy();
      }
      if (done) setImmediate(() => done(new Error('not in test')));
      return anyProxy();
    },
  };
  // 第1d回 A-9 の点検: main が起こした子（エンジン・貼り付けなど）の kill() の回数を数える（断った再起動が何も止めないことを見る）
  let killCalls = 0;
  const spawnInner = childProcess.spawn;
  childProcess.spawn = (...a) => {
    const k = spawnInner(...a);
    if (k && typeof k.kill === 'function') {
      const kill = k.kill;
      k.kill = function (...x) { killCalls += 1; return kill.apply(this, x); };
    }
    return k;
  };
  // いま動いているエンジンの子（本物の node の子で、まだ終わっていない）の数
  const liveEngines = () => kids.filter((k) => k.exitCode === null && k.signalCode === null).length;
  // 断った後に本体の窓の閉じるボタンを押す（quitting が立ったままなら確かめを飛ばして閉じる: closeConfirm）。
  // 返すのは preventDefault の回数と、出た確かめの文（偽の showMessageBoxSync は［キャンセル］を返す）
  const pressClose = () => {
    let prevented = 0;
    const asked0 = syncDialogs.length;
    wins[1].emit('close', { preventDefault() { prevented += 1; } });
    return { prevented, asked: syncDialogs.slice(asked0).map((d) => d.message) };
  };
  const orig = Module._load;
  let dbClient = null;   // main の客（第2a1回 M-2b）
  const trace = [];   // 第2a1回 M-3: 客の頼みと下書きの書き消しの順（out.trace）
  // 0.10.1 CD-2: --claude-race。NaTsu が Claude デスクトップの設定ファイルを書いた直後に、Claude が好みの設定を1つ足して書き戻した形にする
  // 0.10.1 2回目の点検の直し: 手順 claude-busy-reads で決めた回数だけ、Claude の設定ファイルの readFileSync を EBUSY にする
  const claudeBusyReads = { left: 0 };
  {
    const origRead = fs.readFileSync;
    fs.readFileSync = function readBusy(p, ...rest) {
      if (claudeBusyReads.left > 0 && path.basename(String(p)) === 'claude_desktop_config.json') {
        claudeBusyReads.left -= 1;
        const e = new Error('EBUSY: 場面が読みを止めた'); e.code = 'EBUSY'; throw e;
      }
      return origRead.call(this, p, ...rest);
    };
  }
  // 0.10.1 点検の直し: --claude-fail-write=N（N 回目を EBUSY）・--claude-race-other（1つ目を書いた直後に前の場所の natsu を消す）も同じ包みで
  if (claudeRaceFlag || claudeFailWrite || claudeRaceOther) {
    const Jm = require(path.join(ROOT, 'src', 'jsonfile.js'));
    const origWrite = Jm.writeJsonFile;
    let claudeWrites = 0;
    let otherDone = false;
    Jm.writeJsonFile = function writeRaced(file, value, opts) {
      const isClaude = path.basename(String(file)) === 'claude_desktop_config.json';
      if (isClaude) {
        claudeWrites += 1;
        if (claudeWrites === claudeFailWrite) { const e = new Error('EBUSY: 場面が書き込みを止めた'); e.code = 'EBUSY'; throw e; }
      }
      const r = origWrite.call(this, file, value, opts);
      if (isClaude && claudeRaceFlag) {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        v.preferences = { ...(v.preferences || {}), raceWrittenByClaude: true };
        fs.writeFileSync(file, JSON.stringify(v, null, 2));
      }
      if (isClaude && claudeRaceOther && !otherDone) {
        otherDone = true;
        const other = path.join(claudeDirs.msix, 'claude_desktop_config.json');
        if (path.resolve(String(file)) !== path.resolve(other) && fs.existsSync(other)) {
          const v = JSON.parse(fs.readFileSync(other, 'utf8'));
          if (v.mcpServers) delete v.mcpServers.natsu;
          fs.writeFileSync(other, JSON.stringify(v, null, 2));
        }
      }
      return r;
    };
  }
  // 0.10.1 点検の直し: --claude-race-before（控えを写した直後に Claude が書く）・--claude-fail-restore（NaTsu の戻しの名前の変更を EBUSY に）
  if (claudeRaceBefore || claudeBakExist) {
    const origCopy = fs.copyFileSync;
    let bakCopies = 0;
    fs.copyFileSync = function copyRaced(src, dest, ...rest) {
      const isBak = /claude_desktop_config\.json\.natsu-.*\.bak$/.test(String(dest));
      if (isBak && claudeBakExist) { const e = new Error('EEXIST: 場面が名前をふさいだ'); e.code = 'EEXIST'; throw e; }
      const r = origCopy.call(this, src, dest, ...rest);
      if (isBak) bakCopies += 1;
      if (isBak && claudeRaceBefore && (!claudeRaceBeforeNth || bakCopies === claudeRaceBeforeNth)) {
        const v = JSON.parse(fs.readFileSync(src, 'utf8'));
        v.preferences = { ...(v.preferences || {}), raceBeforeNaTsu: true };
        fs.writeFileSync(src, JSON.stringify(v, null, 2));
      }
      return r;
    };
  }
  if (claudeCreateAfterPlan) {
    const origExists = fs.existsSync;
    let created = false;
    const target = path.join(claudeDirs.roaming, 'claude_desktop_config.json');
    fs.existsSync = function existsCreating(p) {
      if (!created && path.resolve(String(p)) === path.resolve(target)) { created = true; fs.writeFileSync(target, '{\n  "createdByClaude": true\n}'); }
      return origExists.call(this, p);
    };
  }
  if (claudeRacePlan) {
    const Jm = require(path.join(ROOT, 'src', 'jsonfile.js'));
    const origRo = Jm.isReadOnly;
    let roCalls = 0;
    Jm.isReadOnly = function isReadOnlyRaced(file, ...rest) {
      const r = origRo.call(this, file, ...rest);
      if (path.basename(String(file)) === 'claude_desktop_config.json') {
        roCalls += 1;
        if (roCalls === claudeRacePlan) {
          const v = JSON.parse(fs.readFileSync(file, 'utf8'));
          v.preferences = { ...(v.preferences || {}), raceAfterPlan: true };
          fs.writeFileSync(file, JSON.stringify(v, null, 2));
        }
      }
      return r;
    };
  }
  if (claudeFailRestoreWrite) {
    const origWrite = fs.writeFileSync;
    fs.writeFileSync = function writeFailing(p, data, ...rest) {
      if (String(p).includes('.natsu-restore')) { origWrite.call(this, p, '{"途中'); const e = new Error('EBUSY: 場面が戻しの書き込みを止めた'); e.code = 'EBUSY'; throw e; }
      return origWrite.call(this, p, data, ...rest);
    };
  }
  if (claudeFailRestore) {
    const origRename = fs.renameSync;
    fs.renameSync = function renameFailing(src, dest) {
      if (String(src).includes('.natsu-restore')) { const e = new Error('EBUSY: 場面が戻しを止めた'); e.code = 'EBUSY'; throw e; }
      return origRename.call(this, src, dest);
    };
  }
  const MAIN = path.join(ROOT, 'src', 'main.js');
  const SRC = path.join(ROOT, 'src') + path.sep;
  // 場面の faults: src/ の中のファイル（main・store・jsonfile など）が読む fs にだけ効く
  const sceneFs = scene && scene.faults ? require('./faulty-fs').faultyFs(scene.faults) : null;
  Module._load = function (req, ...rest) {
    if (req === 'electron') return electron;
    if (req === 'child_process') return childProcess;
    if (sceneFs && (req === 'fs' || req === 'node:fs') && rest[0] && typeof rest[0].filename === 'string' && rest[0].filename.startsWith(SRC)) return sceneFs;
    // main の客（第2a1回 M-2b）を捕まえる（場面は DB の用意を待ってから act を呼ぶ・終わるときに閉じる）。場面の dbDelayMs は、main の
    // db.call の答えを毎回その分だけ遅らせる（DB のプロセスの返事がさらに遅いときの待ち方を見る。第2a1回 M-1 の before-quit）
    if (req === './db/client' && rest[0] && rest[0].filename === MAIN) {
      const mod = orig.call(this, req, ...rest);
      return { ...mod, makeDbClient: (...a) => {
        const c = mod.makeDbClient(...a);
        dbClient = c;
        const delayMs = scene && scene.dbDelayMs ? scene.dbDelayMs : 0;
        // 答えを受けた印（ack）は、main の await が先へ進む前に残る（下書きを消したのが返事の後かを順で見る）
        const call = async (cmd, args, o) => {
          if (delayMs) await sleep(delayMs);
          trace.push({ kind: 'call', cmd, ...(cmd === 'snapshot.take' && args ? { snap: args.kind } : {}) });
          try {
            const r = await c.call(cmd, args, o);
            if (slowAck && slowAck.cmd === cmd) await sleep(slowAck.ms);   // --slow-ack: DB は書き終えた・main はまだ答えを受けていない
            trace.push({ kind: 'ack', cmd });
            return r;
          } catch (e) {
            trace.push({ kind: 'fail', cmd, code: (e && e.code) || '' });
            throw e;
          }
        };
        // 第1d回 A-9 の点検（--restart-during=closing）: main の db.close は、場面が releaseClose() を呼ぶまで閉じ始めない
        const close = restartDuring === 'closing' ? (o) => new Promise((r) => { releaseClose = () => r(c.close(o)); }) : c.close;
        return { ...c, call, close, send: (cmd, args) => { trace.push({ kind: 'send', cmd }); return c.send(cmd, args); } };
      } };
    }
    // 第1d回 A-9: 取り込みは数えるだけ（本当には取りに行かない・アプリのフォルダを書き換えない）
    if (restartDuring && req === './updater' && rest[0] && rest[0].filename === MAIN) {
      const mod = orig.call(this, req, ...rest);
      return { ...mod, apply: async () => { applyCalls += 1; return { ok: true }; } };
    }
    if (managedMods && rest[0] && rest[0].filename === MAIN) {
      if (req === './engine-install') return managedMods.install;
      if (req === './engine-manifest') return managedMods.manifest;
    }
    return orig.call(this, req, ...rest);
  };

  // 取り込んだエンジンの置き場所（%LOCALAPPDATA%\natsu\engine）は main.js を読んだときに決まるので、その前に一時フォルダへ向ける。
  // Windows の CI で本当のプロファイルの natsu\engine を見ない（フォルダは作らない。main も作らない）。
  // この場面の settings.json は手のパスを持つので、文字起こしは手の設定の道を通る
  process.env.LOCALAPPDATA = localAppData;
  // 60 秒ごとの見回り（releaseIdleEngines）を拾い、待たずに呼べるようにする（本物の setInterval にも渡す）
  const ticks = [];
  // 0.9.0 O-4: 録音バーのカーソルの見張り（watchPanelHover）を始めた数と、それを止めた（clearInterval）か。場面は関数を偽のカーソルで直に呼ぶ
  const hoverIntervals = [];
  const hoverHandles = new Set();
  let hoverCleared = 0;
  let hoverFn = null;
  const realSetInterval = global.setInterval;
  const keptTicks = [];   // 第1d2回 M-3: 文字起こし待ちの見回り（retryKeptWhenBack）
  // 0.9.0 B-2: オフラインの帯の見張り（watchOffline）も拾う。本物の時計では回さず（何もしない間隔を渡す）、場面（--net-seq）が偽の時刻で呼ぶ
  const offTicks = [];
  const offHandles = new Set();
  let offCleared = 0;
  const realClearInterval = global.clearInterval;
  const askLevels = new Map();   // 0.12.0 SP-3a: 2つの流れの場面では main の askLevel を本物の時計で回さず、場面がこまごとに呼ぶ
  global.setInterval = function (fn, ms, ...a) {
    if (twoFx && fn && fn.name === 'askLevel') {
      const h = realSetInterval.call(this, () => {}, ms);
      askLevels.set(h, fn);
      return h;
    }
    if (fn && fn.name === 'watchOffline') {
      offTicks.push(fn);
      const h = realSetInterval.call(this, () => {}, ms);
      offHandles.add(h);
      return h;
    }
    if (fn && fn.name === 'releaseIdleEngines') ticks.push(fn);
    if (fn && fn.name === 'retryKeptWhenBack') keptTicks.push(fn);
    const h = realSetInterval.call(this, fn, ms, ...a);
    if (fn && fn.name === 'watchPanelHover') { hoverIntervals.push(ms); hoverHandles.add(h); hoverFn = fn; }   // 0.9.0 O-4
    return h;
  };
  global.clearInterval = function (h) {
    askLevels.delete(h);
    if (offHandles.delete(h)) offCleared++;
    if (hoverHandles.delete(h)) hoverCleared += 1;
    return realClearInterval.call(this, h);
  };
  let keptTicksCalled = 0;
  const keptTick = async () => { keptTicksCalled += 1; for (const t of keptTicks) await t(); };
  // 0.9.3 M-2: 会議の検出の見張りの起こし直し（restartMicWatch）は、ms を覚えて 5ms 後に本当に呼ぶ（30 秒・2 分・10 分を待たない）
  if (micSteps) {
    const st0 = global.setTimeout;
    global.setTimeout = function (fn, ms, ...a) {
      if (fn && fn.name === 'restartMicWatch') { restartDelays.push(ms); return st0.call(this, fn, 5, ...a); }
      return st0.call(this, fn, ms, ...a);
    };
  }
  const jsonfile = require(path.join(ROOT, 'src', 'jsonfile.js'));
  const timers = {};
  const clearedTimers = {};   // 場面の時計のうち clearTimeout で止められた数（名前ごと）。待っている数 = timers[名前].length - clearedTimers[名前]
  if (scene) {
    // 部品の待ちを縮める（読み直しの約1秒・名前の変更のやり直しの約0.5秒を待たない）
    jsonfile.sleepSync = () => {};
    // 読み直しなどの時計は走らせずに覚える（場面が自分で呼ぶ）
    const realSetTimeout = global.setTimeout;
    global.setTimeout = function (fn, ms, ...a) {
      if (fn && SCENE_TIMERS.has(fn.name)) {
        (timers[fn.name] || (timers[fn.name] = [])).push(fn);
        return { unref() { return this; }, ref() { return this; }, hasRef: () => false, sceneTimer: fn.name, cleared: false };
      }
      return realSetTimeout.call(this, fn, ms, ...a);
    };
    const realClearTimeout = global.clearTimeout;
    global.clearTimeout = function (h) {
      if (h && h.sceneTimer) {
        if (!h.cleared) { h.cleared = true; clearedTimers[h.sceneTimer] = (clearedTimers[h.sceneTimer] || 0) + 1; }
        return undefined;
      }
      return realClearTimeout.call(this, h);
    };
  }
  // 点検の直し C1: 2つの流れの会議の締めの待ちの見張り（main の twoFinalWait。60 秒）は、言った長さを覚えて 2 秒で回す（場面の最後の2つの間 lastGapMs より長く）
  if (twoFx) {
    const st1 = global.setTimeout;
    global.setTimeout = function (fn, ms, ...a) {
      if (fn && fn.name === 'twoFinalWait') { twoFinalWaitMs.push(ms); return st1.call(this, fn, 2000, ...a); }
      return st1.call(this, fn, ms, ...a);
    };
  }
  if (argvFlag) process.argv = [process.execPath, ...argvFlag];   // 0.10.0 LN-4: 起動の引数（フラグは読み終えている）
  require(path.join(ROOT, 'src', 'main.js'));
  // 議事録の読みは natsu.db を読み取り専用で見る（第2a1回 M-2b。main は議事録を DB のプロセスに書き、元の JSON の索引を読まない）。
  // 読むたびに開いて閉じる（DB のプロセスが閉じた後・戻した後でも今のファイルを見る。掴んだままにしない）。下書きなどは本物の store
  const realStore = require(path.join(ROOT, 'src', 'store.js'));
  const dataDir = path.join(userData, 'data');
  // 用意の前（表を作る前・移行の途中）と使えない DB（表の無いファイル）は「まだ何も無い」。用意ができた後の失敗はそのまま投げる
  const peekDb = (fn, none) => {
    if (!fs.existsSync(path.join(dataDir, 'natsu.db'))) return none;
    try {
      const h = dbpeek.open(dataDir);
      try { return fn(h); } finally { h.close(); }
    } catch (e) {
      if (['ready', 'read-only'].includes(dbState())) throw e;
      return none;
    }
  };
  const dbView = {
    listPages: () => peekDb((h) => h.listPages(), []),
    getPage: (id) => peekDb((h) => h.getPage(id), null),
    getTranscript: (id) => peekDb((h) => h.getTranscript(id), []),
    rawPage: (id) => peekDb((h) => h.rawPage(id), null),   // 0.11.0 Q-3: DB の行の attrs（DB が作る欄 qualityView が書かれていないか）
  };
  const store = new Proxy(realStore, { get: (t, k) => (Object.hasOwn(dbView, k) ? dbView[k] : t[k]) });
  const dbMeta = (key) => peekDb((h) => h.meta(key), undefined);
  const dbState = () => (dbClient ? dbClient.state() : 'none');
  // 終わるときは DB の客を閉じてから（子の close でチェックポイントして natsu.db を離す）。結果はもう書いてある
  const exitClean = async (code) => {
    try { if (dbClient) await dbClient.close({ timeoutMs: 2000 }); } catch (_) { /* 閉じられなくても終える */ }
    // 0.13.0（ED-7 の全体のテストの赤で見つけた: 0.12.0 の SP-3a・F25 の出力の JSON が 120155 文字目で切れた）: 管（pipe）の標準出力は書き切れない分を
    // 後で書くので、書き終わる前に process.exit すると、親が混んで読むのが遅いときに出力が切れる。先に書いた分が出たのを待ってから終える
    await new Promise((r) => process.stdout.write('', () => r()));
    process.exit(code);
  };
  // 第2a1回 M-3: 下書きを書くたび・消すたびを trace に残す（main は store.writeDraft・store.clearDraft を呼ぶたびに引く）。
  // --keep-draft-after-finalize: 締めの返事の後の最初の clearDraft だけ、下書きの unlinkSync を EPERM にする
  {
    const writeDraft = realStore.writeDraft;
    realStore.writeDraft = function (d, ...a) {
      trace.push({ kind: 'draft', pageId: d && d.pageId, segs: d && Array.isArray(d.segments) ? d.segments.length : 0 });
      return writeDraft.call(this, d, ...a);
    };
    const clearDraft = realStore.clearDraft;
    let eperm = keepDraftAfterFinalize;
    // --purge-save-fail-once: 取り消しの控えの最初の書き込み（一時ファイルを開くところ）を1回だけ EPERM にする
    if (purgeSaveFailOnce) {
      const open = fs.openSync;
      let failed = false;
      fs.openSync = function (f, ...r) {
        if (!failed && r[0] === 'wx' && path.basename(String(f)).startsWith('purge-pending.json')) {   // 読み（readFileSync も openSync を通る）は止めない
          failed = true;
          trace.push({ kind: 'purgeSaveFail' });
          throw Object.assign(new Error('EPERM: operation not permitted, open (試験)'), { code: 'EPERM' });
        }
        return open.call(this, f, ...r);
      };
    }
    realStore.clearDraft = function (name, ...a) {
      trace.push({ kind: 'clearDraft', name });
      if (!eperm || !trace.some((t) => t.kind === 'ack' && t.cmd === 'meeting.finalize')) return clearDraft.call(this, name, ...a);
      eperm = false;
      const unlink = fs.unlinkSync;
      fs.unlinkSync = function (f, ...r) {
        if (path.basename(String(f)) === (name || 'draft.json')) throw Object.assign(new Error('EPERM: operation not permitted, unlink (試験)'), { code: 'EPERM' });
        return unlink.call(this, f, ...r);
      };
      try { return clearDraft.call(this, name, ...a); } finally { fs.unlinkSync = unlink; }
    };
  }
  // 画面と同じ役 app の口（第2a1回 M-3。客の rendererPort() が作る偽の MessageChannelMain の口）。main はもう画面のページの口を中継しない
  const DBC = require(path.join(ROOT, 'src', 'db', 'commands.js'));
  let appPort = null;
  let appSeq = 0;
  const appWait = new Map();
  const appCall = (cmd, args = {}) => new Promise((resolve, reject) => {
    if (!appPort) {
      const p = dbClient ? dbClient.rendererPort() : null;
      if (!p) { reject(Object.assign(new Error('db-down'), { code: 'db-down' })); return; }
      appPort = p;
      p.on('message', (ev) => {
        const m = ev ? ev.data : null;
        const w = m && appWait.get(m.id);
        if (!w) return;
        appWait.delete(m.id);
        if (m.ok === true) w.resolve(m.result);
        else w.reject(Object.assign(new Error(String(m.code)), { code: m.code }));
      });
      p.on('close', () => {
        if (appPort === p) appPort = null;
        for (const [id, w] of [...appWait]) { appWait.delete(id); w.reject(Object.assign(new Error('retry'), { code: 'retry' })); }
      });
      p.start();
    }
    appSeq += 1;
    const req = { id: appSeq, cmd, args };
    if (Object.hasOwn(DBC.COMMANDS, cmd) && DBC.COMMANDS[cmd].write) req.tx = `a:${require('crypto').randomUUID()}`;
    appWait.set(appSeq, { resolve, reject });
    appPort.postMessage(req);
  });
  // userData の下のファイルの相対パス（区切りは /）
  const listFiles = (root) => {
    const files = [];
    const walk = (dir, rel) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else files.push(r);
      }
    };
    walk(root, '');
    return files.sort();
  };
  // natsu.db と -wal のバイトに text（UTF-8）があるか。接続は開かない（DB のプロセスのチェックポイントを起こさない）
  const dbBytesHave = (text) => {
    const needle = Buffer.from(String(text), 'utf8');
    const f = path.join(dataDir, 'natsu.db');
    return [f, `${f}-wal`].some((x) => { try { return fs.readFileSync(x).indexOf(needle) >= 0; } catch (_) { return false; } });
  };
  // 今の下書きの文字起こしの済んだ区間（want を含む）が、写しとして DB に届いたか
  const settledInDb = (want = '') => {
    const d = currentDraft();
    const seg = d && Array.isArray(d.segments) ? d.segments.find((x) => x && !x.pending && x.text && x.text.includes(want)) : null;
    if (!seg || typeof d.pageId !== 'string') return false;
    return peekDb((h) => h.getTranscript(d.pageId).some((x) => x.id === seg.id && x.text === seg.text), false);
  };
  const finalizeFailed = () => trace.some((t) => t.kind === 'fail' && t.cmd === 'meeting.finalize');
  // 議事録の場面の出力に足すもの（第2a1回 M-3）
  const m3Out = (o) => {
    o.files = listFiles(userData);
    o.loginWins = loginRecs.slice();   // 第1d回 A-11
    o.cookiesOnDisk = fs.existsSync(path.join(userData, 'Partitions'));
    o.dbStarts = utilFork.starts();
    o.trace = trace.slice();
    o.dbHas = { [SECRET]: dbBytesHave(SECRET) };   // 秘密の語（--secret-text の語）が natsu.db か -wal に残っているか
    if (draftBefore) o.draftPageIdBefore = draftBefore.pageId || null;
    return o;
  };
  readyResolve();
  const out = { mode };
  const readUser = (rel) => { try { return fs.readFileSync(path.join(userData, ...rel.split('/'))); } catch (_) { return null; } };
  const engineLogLines = () => {
    const t = readUser('engine.log');
    return t ? t.toString('utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
  };
  if (scene) {
    // 窓が2つ（録音バー・本体）できるのを待ってから、画面の読み込みを終える（起動の知らせは did-finish-load で送られる）
    if (!await waitFor(() => wins.length >= 2, 15000)) throw new Error(`場面 ${sceneName}: 窓ができない（whenReady の途中で止まった）`);
    finishLoad();
    // 議事録の DB の用意（ready・read-only か、使えない down）を待つ（第2a1回 M-2b。起動の移行と取り込みが済んでから act）
    if (!scene.noDbWait && !await waitFor(() => !['none', 'starting', 'migrating'].includes(dbState()), 15000)) throw new Error(`場面 ${sceneName}: 議事録の DB の用意ができない（${dbState()}）`);
    // 用意ができたら、main が最初の用意の後に聞く起動の様子（db.status。知らせ D2〜D8 の材料）の返事を待つ（第2a1回 M-4。知らせは返事の直後に送る）
    if (!scene.noDbWait && ['ready', 'read-only'].includes(dbState())) {
      await waitFor(() => trace.some((t) => (t.kind === 'ack' || t.kind === 'fail') && t.cmd === 'db.status'), 5000);
      await sleep(10);
    }
    // engine: 'lazy'（第1d回 A-3）は起動の先読みを待たない（ログインした PC は起動のときに whisper を起こさない。手元に落ちた区間で起こす）
    if (scene.engine && scene.engine !== 'lazy') await waitFor(() => spawns.length > 0, 15000);
    const actOut = {};
    const readLocal = (rel) => { try { return fs.readFileSync(path.join(localAppData, ...rel.split('/'))); } catch (_) { return null; } };
    if (typeof scene.act === 'function') {
      await scene.act({ handlers, listeners, app: electron.app, wins, mainWin: wins[1], power: powerMonitor, timers, clearedTimers, shortcuts, store, jsonfile, electron, userData,
        localAppData, read: readUser, readLocal, waitFor, sleep, toneWav, releasePause, out: actOut, launches, launchPlan, fakeKids, dbMeta, dbState,
        claudeCalls: () => (fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),   // 0.10.0 LS-2
        dbCrash: (code) => utilFork.crash(code), dbStarts: () => utilFork.starts(), mainSent: () => mainSent.slice(), appCall,
        dialogs: () => dialogs.slice(), answerDialog, quitCalls: () => quitCalls, trace: () => trace.slice(),
        syncDialogs: () => syncDialogs.slice(), powerBlocks: () => power.slice(),
        snapshotKinds: () => trace.filter((t) => t.kind === 'call' && t.cmd === 'snapshot.take').map((t) => t.snap),
        mainState: () => { const st = handlers['meeting:status'] ? handlers['meeting:status']() : null; return !st ? 'none' : !st.active ? 'idle' : st.finalizing ? 'meeting-finalizing' : 'meeting'; },
        overlayDone: () => sent.filter(([ch, p]) => ch === 'overlay:phase' && p && p.phase === 'done').map(([, p]) => p.message),
        // 0.9.4 P-1: データベースを待つ文は録音バーでなく本体の窓の知らせ（app:notice）で出す
        mainNotices: () => sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p),
        mainProgress: () => sent.filter(([ch]) => ch === 'meeting:progress').map(([, p]) => (p ? p.message : undefined)),
        setOnline: (on) => { netUp = Boolean(on); },
        relay: relayLocal ? { mail: require('./relay-run').mail, setFront: (m) => relayLocal.setFront(m), db: relayLocal.db,
          calls: () => relayPaths.slice(), seededMail, base: relayLocal.base, sttRequests: () => relayLocal.stt.requests.slice(), logs: () => relayLocal.logs.slice(),
          // 第1d回 A-11: 取り消しは偽の Access で（Zero Trust の Revoke）。block は種の人を止めたメールにする（中継は 403 denied）
          revoke: async () => { relayLocal.revokeAt(loginMail()); },
          block: () => relayLocal.db.prepare('INSERT OR IGNORE INTO blocked_emails (email, at) VALUES (?1, ?2)').bind(loginMail(), 0).run() } : null,
        access: { mode: (m) => { loginMode = m; }, wins: () => loginRecs.map((r) => ({ ...r })), close: () => { const w = loginWinsList.filter((x) => !x.destroyed).pop(); if (w) w.close(); },
          cookies: async () => { const ses = fakeSessions.get(ACCESS_PARTITION); return ses ? ses.cookies.get({}) : []; },
          clears: () => { const ses = fakeSessions.get(ACCESS_PARTITION); return ses ? ses.clears.slice() : []; },
          allowDecrypt: () => { decryptBlocked = false; }, mail: () => loginMail(), perms: accessPerms, navProbe },
        advanceClock });
    }
    const files = listFiles(userData);
    const localFiles = [];
    {
      const walkLocal = (dir, rel) => {
        let ents = [];
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const e of ents) {
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walkLocal(path.join(dir, e.name), r);
          else localFiles.push(r);
        }
      };
      walkLocal(localAppData, '');
    }
    const text = (rel) => { const b = readUser(rel); return b ? b.toString('utf8') : null; };
    const mainOpts = (wins[1] && wins[1].opts) || {};
    const winStateBuf = readLocal('natsu/window-state.json');
    const result = {
      scene: sceneName,
      notices: sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p),
      files,
      settingsText: text('settings.json'),
      historyText: text('history.json'),
      engineLog: engineLogLines(),
      spawns: spawns.slice(),
      themeSource: electron.nativeTheme.themeSource,
      windows: wins.length,
      windowOpts: Object.fromEntries(['x', 'y', 'width', 'height', 'minWidth', 'minHeight', 'backgroundColor'].map((k) => [k, mainOpts[k]])),
      maximizeCalls,
      zooms: zooms.slice(),
      winStateText: winStateBuf ? winStateBuf.toString('utf8') : null,
      localFiles: localFiles.sort(),
      overlayJs: overlayJs.slice(),
      overlayPaused,
      balloons: balloons.slice(),
      portsSent: portsSent.slice(),
      dialogs: dialogs.slice(),
      quitCalled: quitCalls > 0,
      overlayDone: sent.filter(([ch, p]) => ch === 'overlay:phase' && p && p.phase === 'done').map(([, p]) => p.message),
      pages: dbView.listPages().map((p) => ({ id: p.id, title: p.title })),
      overlaySent: overlaySent.slice(),
      order: order.slice(),
      loginWins: loginRecs.slice(),
      loginWin: loginRecs[0] || null,
      cookiesOnDisk: fs.existsSync(path.join(userData, 'Partitions')),
      accessPerms: accessPerms(),
      ...actOut,
    };
    process.stdout.write(`\n${JSON.stringify(result)}\n`);
    await exitClean(0);
  }
  if (fetchMode) {
    await waitFor(() => handlers['engine:fetch-start']);
    out.managedRoot = managedRoot;
    out.manifestShas = { whisper: fetchManifest.items.filter((i) => i.group === 'whisper').map((i) => i.sha256) };   // 0.10.0 LS-3 で要約の組を外した
    // 起動のときの照らし（何も取り込んでいないので候補は無い）が済み、画面へ今の写しを送るのを待ってから押す
    await waitFor(() => sent.some(([ch]) => ch === 'engine:fetch-progress'));
    out.statusBefore = handlers['engine:status']();
    out.fetchStart = await handlers['engine:fetch-start']({}, {});
    // 取り込みの途中で記録を始めようとする（文字起こしの組はまだ。未設定の文に「取り込み中」）
    out.startDuring = await handlers['meeting:toggle']();
    // 組（0.10.0 LS-3 から文字起こしだけ）がそろって切り替わり、係が止まって（省電力の抑止を外して）、文字起こしエンジンが起動し、
    // 切り替えた後の写し（組を「使える」と言う進み具合）が届くのを待つ
    await waitFor(() => switchedAfter(/^文字起こしが使えるようになりました。/, 'w') && power.some(([k]) => k === 'stop') && spawns.length);
    await sleep(100);
    out.seq = seq;
    out.atReady = atReady;
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    out.progress = sent.filter(([ch]) => ch === 'engine:fetch-progress').map(([, p]) => p && p.state);
    out.lastProgress = sent.filter(([ch]) => ch === 'engine:fetch-progress').map(([, p]) => p).pop() || null;
    out.power = power.slice();
    out.spawns = spawns.slice();
    out.engineStatus = handlers['engine:status']();
    out.engineFetchStatus = await handlers['engine:fetch-status']();
    out.installed = JSON.parse(fs.readFileSync(path.join(managedRoot, 'installed.json'), 'utf8'));
    out.hits = fetchSet.hits().map((h) => h.id);
    out.pause = await handlers['engine:fetch-pause']();
    out.openDir = await handlers['engine:open-dir']();
    out.opened = opened.slice();
    out.savedSettings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    const elog = path.join(userData, 'engine.log');
    out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
    await fetchSet.close();
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  if (managedMode) {
    // 照らしは本物のファイルの読み（イベントループを回す）。受け口を付けた手番の直後のマイクロタスクの今は、まだ照らし終えていない
    await ipcReadyP;
    out.statusChecking = handlers['engine:status']();
    out.spawnsBeforeVerify = spawns.length;
    out.managedRoot = managedRoot;
    if (noVcRuntime) {
      // whenReady（トレイ・貼り付け・窓）は今の OS のまま済んだ。照らし終える前に、ランタイムの無い Windows にする
      const winDir = path.join(tmp, 'Windows-空𠮷');
      fs.mkdirSync(winDir);   // System32 は作らない（DLL は exe のフォルダにも System32 にも無い）
      process.env.SystemRoot = winDir;
      process.env.windir = winDir;
      if (process.platform !== 'win32') Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    }
    // 起動のときの照らしの途中に、60 秒ごとの見回り（releaseIdleEngines）が来る。照らしの結果を待ち、二重に照らさない（Task 14）
    out.ticksDuringCheck = ticks.length;
    for (const t of ticks) t();
    // 照らし終えるのを待つ
    await waitFor(() => !/確かめています/.test(handlers['engine:status']().whisper));
    // --slow-load: 画面の読み込みはここで終わる（読み込み中に送った分は lost。main が読み終えるのを待って送る分は、ここで届く）
    out.lostWhileLoading = lost.map(([ch, p]) => (ch === 'app:notice' ? p : ch));
    finishLoad();
  }
  if (crashMode) {
    // 文字起こしエンジンが 0xC0000135 で落ちた後（--crash・--crash-ok）
    const elogFile = path.join(userData, 'engine.log');
    const elog = () => (fs.existsSync(elogFile) ? fs.readFileSync(elogFile, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : []);
    const noticed = (re) => sent.some(([ch, p]) => ch === 'app:notice' && re.test(p));
    if (crashMode === 'broken') {
      // 照らし直して使うのをやめ、取り直し、照らし直してから使い直す。切り替えた後の写しまで待つ（0.10.0 LS-3 で要約の組を外した）
      await waitFor(() => noticed(/^文字起こしが使えるようになりました。/) && switchedAfter(/^文字起こしが使えるようになりました。/, 'w') && spawns.length >= 2);
      await sleep(100);
    } else {
      // 照らし直して合う: 組は使い続け、［起動テスト］で起動し直せる
      await waitFor(() => elog().some((l) => l.includes('落ちた後に取り込んだファイルを照らし直しました')));
      await sleep(100);
      out.engineStatusAfterCrash = handlers['engine:status']();
      out.fetchStatusAfterCrash = await handlers['engine:fetch-status']();
      out.testAfterCrash = await handlers['app:test']();
    }
    out.seq = seq;
    out.atBroken = atBroken;
    out.atReady = atReady;
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    out.hits = fetchSet.hits().map((h) => h.id);
    out.spawns = spawns.slice();
    out.verifyCalls = verifyCalls;
    out.engineStatus = handlers['engine:status']();
    out.engineFetchStatus = await handlers['engine:fetch-status']();
    out.engineLog = elog();
    await fetchSet.close();
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  await waitFor(() => handlers['meeting:toggle']);
  // 0.9.0 O-1: 起動の直後に画面と同じ口で読む設定（前の位置の直しが、画面の最初の settings:get より前に済んでいるか: F18）
  const settingsGetAtStart = pillSettings ? await handlers['settings:get']() : null;
  // 第2a1回 M-3: 画面と同じ役 app の口で読む（main はもう page:get を中継しない）。DB を使えなければ null
  const pageRouteText = async (id) => { let r = null; try { r = await appCall('page.get', { id }); } catch (_) { r = null; } return r && r.page ? r.page.routeText : null; };
  // ページの形（議事録の場面の出力。第2a1回 M-3 で id・title・recovered を足した）
  const pageOut = async (p) => {
    const page = store.getPage(p.id);
    return {
      id: p.id, title: page.title, recovered: Boolean(page.recovered),
      summaryError: page.summaryError, summaryWait: page.summaryWait === true,
      segments: store.getTranscript(p.id).map((s) => ({ text: s.text, failed: Boolean(s.failed) })),
      meetingType: page.meetingType, typeAuto: page.typeAuto, actionStat: page.actionStat,
      route: page.route, routeText: await pageRouteText(p.id), citeStat: page.citeStat || null,
      blocks: (page.blocks || []).map((b) => ({ type: b.type, cites: Array.isArray(b.cites) ? b.cites.length : 0 })),
      todos: (page.blocks || []).filter((b) => b.type === 'todo').map((b) => ({ text: b.text, assignee: b.assignee || '', due: b.due || '', dueRaw: b.dueRaw || '' })),
      // 0.11.0 M-3: 要約のブロックの文と印（足すだけ。上の blocks の形は変えない）
      sumBlocks: (page.blocks || []).map((b) => ({ type: b.type, text: b.text, mark: b.mark, unconfirmed: b.unconfirmed, citeState: b.citeState, cites: Array.isArray(b.cites) ? b.cites.length : 0, ...(b.level !== undefined ? { level: b.level } : {}) })),   // 0.13.0 ED-3: 見出しの段
      autoType: page.autoType, autoSlot: page.autoSlot, quality: page.quality, stateLog: page.stateLog, memo: page.memo,
      // 0.11.0 Q-3: 画面の役で読んだ qualityView（DB が作る欄）・DB の行に qualityView が書かれていないか
      viewQuality: await (async () => { try { const g = await appCall('page.get', { id: p.id }); return g && g.page ? g.page.qualityView : undefined; } catch (_) { return undefined; } })(),
      rawHasQualityView: (() => { const raw = store.rawPage(p.id); return Boolean(raw && Object.hasOwn(raw, 'qualityView')); })(),
      // 0.12.0 SP-3a: 発言の時刻・長さ・入口（DB の extra）と、ページの長さ・止めていた時間の印
      segs: store.getTranscript(p.id).map((s) => ({ id: s.id, atMs: s.atMs, durationMs: s.durationMs, text: s.text, src: s.src, parts: s.parts, failed: Boolean(s.failed) })),
      durationSec: page.durationSec, pauses: page.pauses || [],
    };
  };
  if (idleMode) {
    // 記録しない。起動の片付け（取り消しの残り → 下書きの復旧 → meeting.settle）が済むのを待つ
    await waitFor(() => trace.some((t) => (t.kind === 'ack' || t.kind === 'fail') && t.cmd === 'meeting.settle'), 15000);
    await sleep(100);
    // 第1d2回 M-3: 起動の片付けの後に、PC の中だけの待ち行列とそのページを置く
    if (extraQueueLate === 'localonly' || extraQueueLate === 'cloud') {
      const lateLocal = extraQueueLate === 'localonly';
      const startedAt = Date.now() - 300000;
      const dir = path.join(userData, 'data', 'segbuf', String(startedAt));
      fs.mkdirSync(dir, { recursive: true });
      const wav = path.join(dir, '1.wav');
      fs.writeFileSync(wav, toneWav(3));
      const pageId = `plate${startedAt}`;
      await dbClient.call('meeting.recover', { pageId, segments: [{ id: 's1', atMs: 0, durationMs: 3000, text: '（復旧中: 文字起こし待ち）', failed: true }],
        page: { title: `${titleAt(startedAt)}（復旧）`, date: '2026-10-20', durationSec: 3, memo: '', blocks: [], createdAt: new Date(startedAt).toISOString(), recovered: true,
          route: { stt: { cloud: 0, local: 0, provider: 'openai' }, localOnly: lateLocal }, summaryError: '' } });
      fs.writeFileSync(path.join(dir, 'recovery.json'), JSON.stringify({ pageId, items: [{ id: 's1', wav, durationMs: 3000 }], retry: false, localOnly: lateLocal }));
    }
    if (keptTickN) {
      // 待ち行列が落ち着く（クラウドで送れる待ち行列の区間が文字になる）まで待つ（PC の中だけの区間は残る）。起動の復旧が回っている間の
      // 見回りは何もしないので、見回りの前にも待つ
      // （--extra-queue-late=cloud のページは、見回りが送れない形にした場面なので待たない。見回りは済むまで await する）
      const settledCloud = () => store.listPages().every((p) => { const pg = store.getPage(p.id); return (pg.route && pg.route.localOnly) || (extraQueueLate === 'cloud' && p.id.startsWith('plate')) || store.getTranscript(p.id).every((x) => !x.failed); });
      await waitFor(settledCloud, 5000);
      await sleep(100);
      if (relaySeq) await relayLocal.setAnswer(relaySeq[0]);   // 第1d2回 M-3 の点検: 見回りの前の中継の答え方
      // 点検の直し（2026-10-25。R35）: 見回りは起動の復旧が回っている間は何もしない（engine.log の「文字起こし待ち: 見回り（…・running）」）。
      // 決まった時間（100ms）待つだけだと、CI の機械が混んだときに見回りが2回とも空振りし、F2 の「保留の行は1行」を見張る変異 op-hold-log-once が
      // 生き残った（CI run 40184873051 の mutate-3）。空振りした見回りは数えず、少し待って呼び直す（見回りの「なぜ」は変わったときだけ書かれるので、
      // 最後の見回りの行が running なら今も回っている）
      const lastWatch = () => { const l = engineLogLines().filter((x) => x.startsWith('文字起こし待ち: 見回り（')); return l.length ? l[l.length - 1] : ''; };
      for (let k = 0; k < keptTickN; k++) {
        for (let t = 0; t < 50; t++) { await keptTick(); if (!/・running）$/.test(lastWatch())) break; await sleep(100); }
      }
      await waitFor(settledCloud, 5000);
      await sleep(200);
    }
    out.pages = await Promise.all(store.listPages().map(pageOut));
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    out.engineLog = engineLogLines();
    out.requests = fs.readFileSync(flog, 'utf8').split('\n').filter((l) => l.startsWith('inference'));
    if (relayLocal) { out.stt = relayLocal.stt.requests.slice(); out.relayCalls = relayPaths.slice(); }
    out.history = handlers['history:get']();   // 第1d2回 M-5
    if (retiredSum) {   // 0.10.0 LS-4
      await waitFor(() => engineLogLines().some((l) => l.startsWith('要約のエンジンを消す')) || readUser('settings.json').toString('utf8').includes('"retiredSumNotified": true'), 10000).catch(() => {});
      await sleep(WRITE_SETTLE_MS);
      out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
      out.engineLog = engineLogLines();
      out.savedSettings = JSON.parse(readUser('settings.json').toString('utf8'));
    }
    if (pillSettings) {
      await sleep(WRITE_SETTLE_MS);   // まとめ書き（350ms）が済んでから写す
      const t = readUser('settings.json');
      Object.assign(out, { settings: t ? t.toString('utf8') : null, settingsBefore, settingsGet: settingsGetAtStart, engineLog: engineLogLines() });
    }
    process.stdout.write(`\n${JSON.stringify(m3Out(out))}\n`);
    await exitClean(0);
  }
  // 第1c回 A-4 の出力（--stt のとき）。segbuf の下に recovery.json と WAV が残っているか
  const segbufLeft = () => {
    const root = path.join(userData, 'data', 'segbuf');
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch (_) { return { queue: false, wav: false }; }
    let queue = false; let wav = false;
    for (const d of dirs) {
      let names = [];
      try { names = fs.readdirSync(path.join(root, d)); } catch (_) { continue; }
      if (names.includes('recovery.json')) queue = true;
      if (names.some((n) => /\.wav$/i.test(n))) wav = true;
    }
    return { queue, wav };
  };
  const claudeLines = () => {
    const t = fs.existsSync(claudeLog) ? fs.readFileSync(claudeLog) : null;
    return t ? t.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  const elogLines = () => { const t = readUser('engine.log'); return t ? t.toString('utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : []; };
  // 0.9.4 S-3: 待ち行列（recovery.json）・区間の WAV・偽の whisper の区間の要求・偽の llama の要求の数・議事録の写し
  const queueFilesNow = () => listFiles(userData).filter((f) => /^data\/segbuf\/[^/]+\/recovery\.json$/.test(f));
  const queueNow = () => queueFilesNow().map((f) => { try { return JSON.parse(readUser(f).toString('utf8')); } catch (_) { return null; } });
  const segWavFiles = () => listFiles(userData).filter((f) => /^data\/segbuf\/.*\.wav$/i.test(f));
  const segRequests = () => fs.readFileSync(flog, 'utf8').split('\n').filter((l) => l.startsWith('inference') && !/probe=true/.test(l)).length;
  // 作った要約の数（0.10.0 LS-2 で意図して直した: 要約は Claude Code だけなので、偽の llama の要求に偽の claude の -p を足して数える）
  const chatCount = () => fs.readFileSync(flog, 'utf8').split('\n').filter((l) => l.startsWith('chat #')).length + claudeLines().filter((c) => c.kind === 'p').length;
  // 0.10.0 LS-2: main が画面へ送る summary:running（走っている要約のページ）の最後が空 = 要約の走りが一度は始まって終わった
  const summaryRunDone = () => { const r = sent.filter(([ch]) => ch === 'summary:running'); return r.length > 0 && Array.isArray(r[r.length - 1][1]) && r[r.length - 1][1].length === 0; };
  const snapPages = () => store.listPages().map((p) => ({ id: p.id, summaryError: store.getPage(p.id).summaryError,
    segments: store.getTranscript(p.id).map((x) => ({ text: x.text, failed: Boolean(x.failed) })) }));
  // 引き金を1回引き、復旧の記録の行（止めました・保留）か待ち行列が無くなるのを 3 秒まで待つ（何も起きない引き金は 3 秒で写す）
  const recoverOnce = async (pull) => {
    const log0 = elogLines().length;
    const req0 = segRequests();
    await pull();
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      if (elogLines().slice(log0).some((l) => /^復旧の文字起こしを(止めました|保留)/.test(l)) || !queueFilesNow().length) break;
      await sleep(50);
    }
    await sleep(200);
    return { pages: snapPages(), queue: queueNow(), wavs: segWavFiles(), requests: segRequests() - req0, log: elogLines().slice(log0) };
  };
  // 画面に渡る経路の行（page:get の返事の routeText）と、最後の page:updated で送った routeText（第1c回 C-3）
  // 第2a1回 M-1（ST1）: ページの口は async（中身は await db.call）。答えを待ってから見る
  const lastUpdatedRouteText = () => {
    const u = sent.filter(([ch]) => ch === 'page:updated').pop();
    return u && u[1] && u[1].page ? u[1].page.routeText : null;
  };
  const sttOut = async () => {
    if (!fakeStt && !relayLocal) return;
    out.stt = (fakeStt || relayLocal.stt).requests.slice();
    if (relayLocal) {
      out.relayCalls = relayPaths.slice();
      out.relayLog = relayLocal.logs.slice();
      // 第1d回 A-11: 中継の口（偽の Access の前）が受けた要求の形（線の上の Cookie に CF_Authorization があるか・Authorization の見出し・X-Requested-With）
      out.relayWire = relayLocal.received.map((x) => ({ path: x.path, cookie: /(?:^|;\s*)CF_Authorization=/.test(String(x.headers.cookie || '')),
        authorization: 'authorization' in x.headers, xrw: String(x.headers['x-requested-with'] || '') }));
      out.loginWins = loginRecs.slice();
    }
    out.netHosts = netHosts.slice();
    out.balloons = balloons.slice();
    out.decrypts = decrypts;
    const sec = readUser('secrets.json');
    out.secretsRaw = sec ? sec.toString('utf8') : null;
    const left = segbufLeft();
    out.recoveryKept = left.queue && left.wav;
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    out.engineLog = elogLines();
    out.spawns = spawns.slice();
    out.savedSettings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
    out.pages = await Promise.all(store.listPages().map(async (p) => {
      const page = store.getPage(p.id);
      return {
        summaryError: page.summaryError, route: page.route, routeText: await pageRouteText(p.id),
        segments: store.getTranscript(p.id).map((x) => ({ text: x.text, failed: Boolean(x.failed) })),
        keys: store.getTranscript(p.id).map((x) => Object.keys(x).sort()),   // 第1d2回 M-2
      };
    }));
  };
  // 送り直し（復旧の待ち行列）が済むか、残して止まるまで待つ（--stt・--after-retry のとき）
  const recoverySettled = () => elogLines().some((l) => /復旧の文字起こしを(保留|止めました)/.test(l)) || !segbufLeft().queue;
  if (recoverMode && (fakeStt || relayLocal)) {
    const recovered = () => { const p = store.listPages()[0]; return p ? store.getTranscript(p.id) : []; };
    // 済んだ（成功した区間がある・待ち行列が片付いた）か、残して止まった（保留・止めました）まで
    // CI の直し（run 39583796615 の Windows の OL2）: 復旧のページは DB に入った後、main が答えを受けてから下書きを消し、同じ手番で recovery.json を
    // 書く。下書きが残っている間の「待ち行列が無い」は「まだ書いていない」なので、済んだと読まない（下書きの復旧に失敗したら、そこで終わり）
    const draftTaken = () => !draftNames().length || elogLines().some((l) => /^下書き（.+）の復旧に失敗/.test(l));
    await waitFor(() => store.listPages().length > 0 && draftTaken() && (recovered().some((x) => !x.failed) || recoverySettled()));
    await sleep(100);
    await sttOut();
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  // 0.9.0 O-2: 録音を始めた直後の録音バーの画面と利用者の手（旗が無ければ何もしない。頭の注釈の --panel-size ほか）
  const panelAct = async () => {
    out.overlayBounds = overlayBounds;
    out.overlayForms = overlayForms;
    if (!out.overlaySent) out.overlaySent = overlaySent;   // 音声入力の場面の出力にも録音の始めの合図を入れる
    if (!(panelSizeFlag || dragTo || cursorTo || hidePanelMode || hoverPanel || selfMove)) return;
    const ov = wins[0];
    const p = { boundsAtStartList: overlayBounds.slice() };
    out.panel = p;
    // 0.9.0 O-4: 横の形の間にカーソルを窓の中へ（見張りを始めていない・送らないことを見る）
    const centerOfPanel = () => { const b = ov.getBounds(); return { x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) }; };
    if (hoverPanel) {
      cursorAt = centerOfPanel();
      if (hoverFn) hoverFn();
      await sleep(200);
      p.hover = { horizontal: { sent: hoverSent.slice(), intervals: hoverIntervals.length } };
      cursorAt = { x: 0, y: 0 };
    }
    const settingsNow = () => { const b = readUser('settings.json'); return b ? b.toString('utf8') : null; };
    const sendSize = () => listeners['overlay:size']({}, { ...panelSizeFlag });
    await sleep(120);   // main が自分で置いた直後（80ms）の move は数えないので、録音の始めの置き直しから間を置く
    if (cursorTo) cursorAt = { ...cursorTo };
    if (dragTo) {
      const before = settingsNow();
      const [w, h] = ov.getSize();
      const [x0, y0] = ov.getPosition();
      const x1 = Math.round(dragTo.x - w / 2); const y1 = Math.round(dragTo.y - h / 2);
      const n0 = overlayBounds.length;
      const steps = dragSteps ? 3 : 1;
      for (let i = 1; i <= steps; i++) {
        ov.setPosition(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps));
        ov.emit('move');
        if (dragSteps && i === 2 && panelSizeFlag) sendSize();
      }
      p.duringDrag = overlayBounds.length - n0;
      ov.emit('moved');
      p.afterMoved = overlayBounds.slice(n0);
      await sleep(WRITE_SETTLE_MS);   // まとめ書き（350ms）の後に読む
      p.settingsChanged = settingsNow() !== before;
      try { p.slotAfter = JSON.parse(settingsNow()).pillSlot; } catch (_) { p.slotAfter = null; }
      // 本体の画面へ送った置き場所の知らせ（O-2・O-4 の点検の直し: 画面の欄を今の値にする。読み込み中で届かなかったものも数える）
      p.patched = [...lost, ...sent].filter(([ch]) => ch === 'settings:patched').map(([, x]) => x);
    }
    if (selfMove) {
      const before = settingsNow();
      const n0 = overlayBounds.length;
      ov.emit('move');
      ov.emit('moved');
      await sleep(WRITE_SETTLE_MS);
      p.selfMove = overlayBounds.length - n0;
      p.settingsChanged = settingsNow() !== before;
    }
    if (panelSizeFlag && !dragSteps) {
      const n0 = overlayBounds.length;
      sendSize();
      sendSize();
      p.afterSize = overlayBounds.slice(n0);
    }
    // 0.9.0 O-4: 縦の形にした後のカーソルの出入りと、隠した後（見張りが止まる）
    if (hoverPanel) {
      const hv = p.hover;
      hv.intervals = hoverIntervals.length;
      const n0 = hoverSent.length;
      const tick = () => { if (hoverFn) hoverFn(); };
      cursorAt = centerOfPanel(); tick(); tick();
      cursorAt = { x: 5, y: 5 }; tick(); tick();
      hv.sent = hoverSent.slice(n0);
      const cleared0 = hoverCleared;
      listeners['overlay:hide-panel']({});
      cursorAt = centerOfPanel(); tick(); await sleep(300);
      cursorAt = { x: 5, y: 5 }; tick();
      hv.afterHide = hoverSent.slice(n0);
      hv.cleared = hoverCleared > cleared0;
    }
    // 0.9.0 O-4: 隠す・出し直す（頭の注釈の --hide-panel）
    if (hidePanelMode) {
      const trayLabels = () => trayItems.filter((i) => i && i.label).map((i) => i.label);
      const snap = () => ({ panelHidden: handlers['meeting:status']().panelHidden, tray: trayLabels(), calls: panelCalls.slice() });
      const h = {};
      p.hide = h;
      listeners['overlay:hide-panel']({});
      h.afterHide = snap();
      if (hidePanelMode === 'show') {
        h.show = await handlers['panel:show']({});
        h.afterShow = snap();
      } else if (hidePanelMode === 'error') {
        listeners['audio:error']({}, { message: 'マイクが見つかりません' });
        await sleep(50);
        h.afterError = snap();
        process.stdout.write(`\n${JSON.stringify(out)}\n`);
        await exitClean(0);
      } else if (hidePanelMode === 'next') {
        listeners['overlay:cancel-request']({});
        await sleep(20);
        h.afterCancel = snap();   // G-2（統合）: 録音していない間の meeting:status の panelHidden
        shortcuts[(await handlers['settings:get']()).hotkey]();
        await sleep(20);
        h.afterNext = snap();
      }
    }
  };
  if (dictate || dictateTwice) {
    // 音声入力を1回（--dictate-twice は2回）: ホットキー → 録音 → 音声が届く → 文字起こし → 履歴
    const hk = (await handlers['settings:get']()).hotkey;
    if (!shortcuts[hk]) throw new Error(`音声入力のホットキー ${hk} が登録されていない`);
    // 第1d2回 M-5: 録音バーの終わりの合図（done・error）の数。1回ずつ、その合図か履歴が増えるのを待つ
    const endPhases = () => sent.filter(([ch, p]) => ch === 'overlay:phase' && p && (p.phase === 'done' || p.phase === 'error')).length;
    for (let r = 0; r < (dictateTwice ? 2 : 1); r++) {
      const phases0 = endPhases();
      const hist0 = (handlers['history:get']() || []).length;
      shortcuts[hk]();
      // 第1d2回 M-1: 録音バーへ送った overlay:start の数（音声入力を始めなかったら 0。そのときは音声を送らず、履歴を待たずに終える）
      out.overlayStarts = sent.filter(([ch]) => ch === 'overlay:start').length;
      if (!out.overlayStarts) {
        await sleep(100);
        out.history = handlers['history:get']();
        out.pastes = clipWrites.slice();
        await sttOut();
        out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
        out.engineLog = elogLines();
        out.spawns = spawns.slice();
        process.stdout.write(`\n${JSON.stringify(out)}\n`);
        await exitClean(0);
      }
      if (r === 0) await panelAct();   // 0.9.0 O-2: 録音を始めた直後の録音バーの画面と利用者の手（1回目の音声入力だけ）
      // 0.9.0 U-1（SP2・RF9）: 録音中に本体の窓へ focus、続けて blur（偽の窓の isFocused を合わせてから事象を出す）。1回目の音声入力だけ
      if (focusMainDuringDictation && r === 0) {
        const mw = wins[1];
        out.escapeAt = { start: registered.has('Escape') };
        mw.focused = true; mw.emit('focus'); out.escapeAt.focus = registered.has('Escape');
        mw.focused = false; mw.emit('blur'); out.escapeAt.blur = registered.has('Escape');
      }
      // 第1d回 A-9: 音声入力の録音中に再起動を頼む
      // 断る前後で子の kill() を数える（out.killsAtRefusal）。そのとき動いていたエンジンの数は out.enginesAtRefusal
      const kills0 = killCalls;
      if (restartDuring === 'dictation') {
        await waitFor(() => liveEngines() > 0, 5000);   // 音声入力の始めに先読みしたエンジンが起きるまで（止めたら見えるように）
        out.enginesAtRefusal = liveEngines();
        out.restartRecording = await handlers['app:restart']();
      }
      if (relaySeq) await relayLocal.setAnswer(relaySeq[r] || 'c');   // 第1d2回 M-5: この音声入力の中継の答え方
      // 第1d2回 M-5 の点検: 音声を残す一時ファイルの名前の変更を1回だけ EPERM にする
      if (dictRenameBusyOnce && r === 0) {
        const rename = fs.renameSync;
        fs.renameSync = function (a, b, ...rest) {
          if (/[\\/]dictwait[\\/][^\\/]+\.wav\.tmp$/.test(String(a))) {
            fs.renameSync = rename;
            out.dictRenameBusy = (out.dictRenameBusy || 0) + 1;
            throw Object.assign(new Error('EPERM: operation not permitted, rename (試験)'), { code: 'EPERM' });
          }
          return rename.call(this, a, b, ...rest);
        };
      }
      listeners['audio:done']({}, { buffer: new Uint8Array(audioWav(3)), durationMs: 3000 });
      // 第1d回 A-9: 音声が届いて文字起こし中（handleDictationAudio は最初の await の前に processing にする）に再起動と取り込みを頼む
      if (restartDuring === 'dictation') {
        out.restartProcessing = await handlers['app:restart']();
        out.apply = await handlers['update:apply']({}, UPDATE_URL);
        out.killsAtRefusal = killCalls - kills0;
      }
      await waitFor(() => (handlers['history:get']() || []).length > hist0 || endPhases() > phases0, 15000);
      await sleep(100);
    }
    out.history = JSON.parse(JSON.stringify(handlers['history:get']()));   // 写し（後の見回りが同じ行を書き換える）
    out.pastes = clipWrites.slice();   // 第1d2回 M-1
    out.overlayPhases = sent.filter(([ch]) => ch === 'overlay:phase').map(([, p]) => p);   // 第1d2回 M-5
    out.files = listFiles(userData);
    out.engineLog = elogLines();   // 0.9.4 S-2
    if (focusMainDuringDictation) { out.escape = escapeLog.slice(); out.escapeAt.end = registered.has('Escape'); }
    if (restartDuring) Object.assign(out, { relaunches, relaunchDb, applyCalls });
    await sttOut();
    // 第1d2回 M-5: 残した音声入力の行を消す・全部消す
    if (dictDelete) {
      const row = (handlers['history:get']() || []).find((h) => h && h.wait);
      out.afterDelete = { history: row ? await handlers['history:delete']({}, row.id) : null, files: listFiles(userData) };
    }
    if (dictClear) out.afterClear = { history: await handlers['history:clear']({}), files: listFiles(userData) };
    // 第1d2回 M-5: 中継の答えを c にして見回りを1回呼び、残した音声入力が片付くのを待つ
    if (dictBack) {
      await relayLocal.setAnswer('c');
      netUp = true;
      const histFile = path.join(userData, 'history.json');
      if (dictBackMode === 'readonly') fs.chmodSync(histFile, 0o444);   // 第1d2回 M-5 の点検: 履歴を保存できない
      if (dictBackMode === 'delete') {
        // 第1d2回 M-5 の点検: 見回りの文字起こしの要求を中継の前で止め、その間に残した行を消す
        relayLocal.setFront('delay-stt');
        const sttSent = () => relayPaths.filter((x) => x === '/v1/audio/transcriptions').length;
        const n0 = sttSent();
        const row = (handlers['history:get']() || []).find((h) => h && h.wait);
        const tick = keptTick();
        await waitFor(() => sttSent() > n0, 5000);
        out.deletedDuring = { id: row ? row.id : null, history: row ? (await handlers['history:delete']({}, row.id)).length : null };
        await tick;
      } else await keptTick();
      if (dictBackMode === 'readonly') fs.chmodSync(histFile, 0o644);
      const waits = () => listFiles(userData).filter((f) => /^data\/dictwait\/.+\.wav$/.test(f)).length;
      if (!dictBackMode) await waitFor(() => waits() === 0, 5000);
      await sleep(100);
      out.dictBack = { history: handlers['history:get'](), pastes: clipWrites.slice(), notices: sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p),
        files: listFiles(userData), engineLog: elogLines() };
    }
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  if (recoverMode) {
    // 復旧の文字起こしが済むのを待つ
    const recovered = () => { const p = store.listPages()[0]; return p ? store.getTranscript(p.id) : []; };
    // 下書きが片付く（復旧の頼みの返事が来た）まで待つ（第2a1回 M-3: 締め済みのページの下書きは知らせずに片付ける）
    // 上限は 15 秒（下書きが残ったときに、呼び手の見張り（25 秒）より前に結果を出して、テストの確かめの文で赤にする: M-3 の点検）
    await waitFor(() => recovered().some((x) => !x.failed) && !draftNames().length, 15000);
    out.recovered = recovered().map((x) => ({ text: x.text, failed: Boolean(x.failed) }));
    out.pages = await Promise.all(store.listPages().map(pageOut));
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    m3Out(out);
    out.spawns = spawns;
    const elog = path.join(userData, 'engine.log');
    out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  if (repairMode) {
    // 壊れていた組の取り直しと、照らし直した後の切り替えと、切り替えた後の写しを待つ（0.10.0 LS-3 で要約の組を外した）
    await waitFor(() => switchedAfter(/^文字起こしが使えるようになりました。/, 'w') && spawns.length);
    await sleep(100);
    out.seq = seq;
    out.atReady = atReady;
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    out.hits = fetchSet.hits().map((h) => h.id);
    out.spawns = spawns.slice();
    out.engineStatus = handlers['engine:status']();
    out.engineFetchStatus = await handlers['engine:fetch-status']();
    const elog = path.join(userData, 'engine.log');
    out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
    await fetchSet.close();
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  if (managedMode === 'tamper' || noVcRuntime || verifyThrows || (noEngine && !noEngineScene && !netSeq)) {
    // 使えない組は使わない。記録も始めない（区間を送らずに終える）
    await sleep(300);
    out.engineStatus = handlers['engine:status']();
    out.engineFetchStatus = await handlers['engine:fetch-status']();
    out.start = await handlers['meeting:toggle']();
    out.test = await handlers['app:test']();
    out.spawns = spawns.slice();
    await sleep(100);
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);   // 第1d2回 M-1: 始めた会議の知らせ（「未設定」の語が無いか）
    if (managedMode === 'tamper') {
      // 60 秒ごとの見回りを 2 回呼ぶ。壊れた組は、取り直されるか触られるまで照らし直さない（Task 14）
      out.noticesBeforeTicks = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
      out.verifyCallsBeforeTicks = verifyCalls;
      out.ticks = ticks.length;
      for (let k = 0; k < 2; k++) { for (const t of ticks) t(); await sleep(150); }
      out.verifyCallsAfterTicks = verifyCalls;
      out.noticesAfterTicks = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
      out.spawnsAfterTicks = spawns.slice();
    }
    if (noVcRuntime) {
      // 情報システムの担当がランタイムを入れた（System32 に 14.51 の DLL を置く）。NaTsu を起動し直さずに［起動テスト］を押す
      const s32 = path.join(process.env.SystemRoot, 'System32');
      fs.mkdirSync(s32);
      for (const d of ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll', 'vcomp140.dll']) fs.writeFileSync(path.join(s32, d), peWithVersion(14, 51, 36247, 0));
      out.engineStatusBeforeRetest = handlers['engine:status']();
      out.testAfterInstall = await handlers['app:test']();
      out.engineStatusAfterInstall = handlers['engine:status']();
      out.spawnsAfterInstall = spawns.slice();
    }
    // 終わりの片付け（一時フォルダを消す）は今の OS のままで行う
    Object.defineProperty(process, 'platform', { value: REAL_PLATFORM, configurable: true });
    const elog = path.join(userData, 'engine.log');
    out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  if (runTest) out.test = await handlers['app:test']();
  // 0.10.0 C-2: Claude デスクトップへの MCP の登録の場面（--mcp-steps。頭の注釈）。手順を順に行い、出力して終える
  if (mcpSteps) {
    await sleep(50);
    out.bootConfigs = claudeConfigsNow();   // 0.10.1 CD-4: 起動の後（手順の前）の設定ファイル
    out.ipc = [];
    out.snaps = {};
    const CH = { status: 'mcp:status', register: 'mcp:register', unregister: 'mcp:unregister' };
    for (const step of mcpSteps) {
      const [k, ...a] = step;
      if (Object.hasOwn(CH, k)) out.ipc.push([CH[k], handlers[CH[k]] ? await handlers[CH[k]]({}) : 'no-such-channel']);
      else if (k === 'files') out.snaps[a[0]] = claudeConfigsNow();
      // 0.10.1 点検の直し: Claude のフォルダを隠す・戻す（見つけた場所が無い noclaude の押しを作る）
      else if (k === 'claude-hide') fs.renameSync(claudeDirs[a[0]], `${claudeDirs[a[0]]}.hidden`);
      // 0.10.1 2回目の点検の直し: 次の N 回の Claude の設定ファイルの読み（readFileSync）を EBUSY にする（先に見る読みだけが掴まれた形）
      else if (k === 'claude-busy-reads') claudeBusyReads.left = a[0];
      else if (k === 'claude-show') fs.renameSync(`${claudeDirs[a[0]]}.hidden`, claudeDirs[a[0]]);
      else if (k === 'save') { const st = await handlers['settings:get'](); out.ipc.push(['settings:save', await handlers['settings:save']({}, { ...st, ...a[0] })]); await sleep(WRITE_SETTLE_MS); }
      else if (k === 'sleep') await sleep(a[0]);
      // 0.10.0 LN-4: 2つ目の起動（Windows がリンクで NaTsu を起こした）と、引数の付いた IPC
      else if (k === 'second-instance') { appEvents.emit('second-instance', {}, a[0], ''); await sleep(20); }
      else if (k === 'ipc-raw') out.ipc.push([a[0], handlers[a[0]] ? await handlers[a[0]]({}, a[1]) : 'no-such-channel']);
      else throw new Error(`mainrun: --mcp-steps の手順 ${k} が読めない`);
    }
    await sleep(30);
    Object.assign(out, {
      claudeConfigs: claudeConfigsNow(), notices: sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p), engineLog: elogLines(),
      settingsText: (readUser('settings.json') || '').toString('utf8'), dataDir: path.join(userData, 'data'), tasklistCalls, protocolCalls,
      mainSent: sent.filter(([ch]) => ch === 'page:open-link'), mainWinCalls: mainWinCalls.slice(),
    });
    for (const dir of Object.values(claudeDirs)) { try { for (const n of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, n), 0o644); } catch (_) { /* 無ければ飛ばす */ } }
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  // 0.9.2 I-1: 場面 open-help（ヘルプセンターを開く口。記録しない）
  if (openHelpCalls) {
    out.openHelp = [];
    for (const args of openHelpCalls) out.openHelp.push(await handlers['app:open-help']({}, ...args));
    await sleep(50);
    out.external = external.slice();
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }

  // 0.9.3 M-2〜M-5: 会議の検出の場面（--mic-feed。頭の注釈）。手順を順に行い、出力して終える
  if (micSteps) {
    await sleep(30);
    out.ipc = [];
    out.snaps = {};
    const lastKid = () => micKids[micKids.length - 1];
    const isActive = () => Boolean(handlers['meeting:status']().active);
    const overlayAsks = () => sent.filter(([ch]) => ch === 'overlay:level-ask').length;   // 0.9.3 M-5: 録音バーへ聞いた数
    for (const step of micSteps) {
      const [k, ...a] = step;
      if (k === 'line') { const kid = lastKid(); if (kid) kid.stdout.emit('data', Buffer.from(`${a[0]}\n`)); await sleep(15); }
      else if (k === 'sleep') await sleep(a[0]);
      else if (k === 'clock') advanceClock(a[0]);
      else if (k === 'exit') { const kid = lastKid(); if (kid) kid.emit('exit', a[0] === undefined ? 1 : a[0], null); await sleep(30); }
      else if (k === 'start') { out.ipc.push(['start', await handlers['meeting:toggle']()]); await sleep(30); }
      else if (k === 'stop') {
        out.ipc.push(['stop', await handlers['meeting:toggle']()]);
        listeners['audio:segment']({}, { buffer: new Uint8Array(0), durationMs: 0, final: true });
        await waitFor(() => !isActive(), 15000);
        await sleep(50);
      } else if (k === 'dictate') { const st = await handlers['settings:get'](); shortcuts[st.hotkey](); await sleep(30); }
      // 0.9.4 D-1: 会議のホットキー（始める・止める）・トレイの［議事録の記録を開始］・録音バーの［停止］（overlay:confirm）
      else if (k === 'hotkey-meeting') { const st = await handlers['settings:get'](); await shortcuts[st.meetingHotkey](); await sleep(30); }
      else if (k === 'tray-start') { const it = trayItems.find((i) => i && i.label === '議事録の記録を開始'); if (it) it.click(); await sleep(30); }
      else if (k === 'bar-stop') { listeners['overlay:confirm']({}); await sleep(30); }
      else if (k === 'finish') { listeners['audio:segment']({}, { buffer: new Uint8Array(0), durationMs: 0, final: true }); await waitFor(() => !isActive(), 15000); await sleep(50); }
      else if (k === 'dictate-cancel') { listeners['overlay:cancel-request']({}); await sleep(30); }
      else if (k === 'save') { const st = await handlers['settings:get'](); out.ipc.push(['save', await handlers['settings:save']({}, { ...st, ...a[0] })]); await sleep(30); }
      else if (k === 'ipc') {
        const [ch, ...args] = a;
        if (handlers[ch]) out.ipc.push([ch, await handlers[ch]({}, ...args)]);
        else if (listeners[ch]) { listeners[ch]({}, ...args); out.ipc.push([ch, 'sent']); }
        else out.ipc.push([ch, 'no-such-channel']);
        await sleep(30);
      } else if (k === 'theme') { nativeTheme.shouldUseDarkColors = Boolean(a[0]); nativeTheme.emit('updated'); await sleep(15); }
      else if (k === 'live') { listeners['meeting:live-shown']({}, Boolean(a[0])); await sleep(15); }
      else if (k === 'cursor') cursorAt = { x: a[0], y: a[1] };
      else if (k === 'quit') { appEvents.emit('before-quit', { preventDefault() {} }); appEvents.emit('will-quit', {}); await sleep(30); }
      else if (k === 'wait-show') await waitFor(() => nudgeWins.length > 0 && nudgeWins[0].nudge.calls.filter((c) => c === 'showInactive').length >= a[0], 5000);
      else if (k === 'minimize') { wins[1].minimized = true; wins[1].emit('minimize'); await sleep(15); }
      else if (k === 'snap') {
        out.snaps[a[0]] = { spawns: micSpawns.length, kills: micKills, active: isActive(), nudgeCalls: nudgeWins.length ? nudgeWins[0].nudge.calls.length : 0, asks: overlayAsks(), sentN: mainSentAll.length, notes: notifications.length };
        // 0.13.0 RDY-1: 下書きのファイルの名前と最初の下書きのメモと種類・DB へ送った命令の名前（中身は入れない）・meeting:status の active と prep
        const drafts = store.draftFiles();
        const d0 = drafts.length ? store.readDraftFile(drafts[0]) : null;
        const dv = d0 && d0.state === 'ok' && d0.value ? d0.value : null;
        const st = handlers['meeting:status']();
        Object.assign(out.snaps[a[0]], { drafts, draft: dv ? { memo: dv.memo, meetingType: dv.meetingType === undefined ? null : dv.meetingType } : null,
          dbSent: trace.filter((t) => t.kind === 'call' || t.kind === 'send').map((t) => t.cmd), status: { active: Boolean(st.active), prep: st.prep === undefined ? 'none' : st.prep } });
        // 0.13.0 ED-5（RF9・決めたこと 32）: その時に Escape が全体のホットキーに付いているか
        out.snaps[a[0]].escape = registered.has('Escape');
      }
      // 0.13.0 ED-5（RF9）: 本体の窓へ focus・窓から blur（偽の窓の isFocused を合わせてから事象を出す。--main-unfocused と組む）
      else if (k === 'focus-main' || k === 'blur-main') { const mw = wins[1]; mw.focused = k === 'focus-main'; mw.emit(k === 'focus-main' ? 'focus' : 'blur'); await sleep(15); }
      // 0.12.1 LV-3: 一時停止（画面と同じ meeting:set-paused。偽の録音バーが答える）・n 番目の偽の Windows の知らせを押す
      else if (k === 'pause') { out.ipc.push(['pause', await handlers['meeting:set-paused']({}, Boolean(a[0]))]); await sleep(40); }
      else if (k === 'click-notice') { const n = noticeObjs[a[0]]; if (n) n.emit('click', {}); await sleep(30); }
      else if (k === 'discard') { out.ipc.push(['discard', await handlers['meeting:discard']()]); await sleep(30); }
      // 0.12.1 点検の直し 3: main の客の次の1回のその命令（cmd）を断る（締めの後の pages.list が投げた形）
      else if (k === 'db-fail') { const c = dbClient; const call = c.call; c.call = function (cmd, ...rest) { if (cmd === a[0]) { c.call = call; return Promise.reject(Object.assign(new Error('偽の失敗'), { code: 'test' })); } return call.call(this, cmd, ...rest); }; }
      else throw new Error(`mainrun: --mic-feed の手順 ${k} が読めない`);
    }
    await sleep(30);
    Object.assign(out, {
      micSpawns, micKills, restartDelays, nudge: nudgeWins.length ? nudgeWins[0].nudge : null, nudgeWindows: nudgeWins.length,
      mainWinCalls: mainWinCalls.slice(), mainSentAll: mainSentAll.filter(([ch]) => !/^(db:|update:)/.test(ch)), engineLog: elogLines(),
      notices: sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p), settingsText: (readUser('settings.json') || '').toString('utf8'),
      // 0.10.0 K-1: 議事録のページの経過（stateLog）
      pageStateLogs: store.listPages().map((p) => ({ id: p.id, stateLog: (store.getPage(p.id) || {}).stateLog || null })),
      active: isActive(), status: handlers['meeting:status'](), overlayAsks: overlayAsks(),
      // 0.12.1 LV-3: 偽の Windows の知らせ（閉じたか）・議事録の所要時間と一時停止の印
      notifications: noticeObjs.map((n) => ({ title: n.o.title, body: n.o.body, closed: Boolean(n.closed) })), notifyClosed,
      pageDur: store.listPages().map((p) => { const pg = store.getPage(p.id) || {}; return { id: p.id, durationSec: pg.durationSec, pauses: pg.pauses || [] }; }),
      // 0.13.0 RDY-1: 議事録のページのメモと種類
      pageMemos: store.listPages().map((p) => { const pg = store.getPage(p.id) || {}; return { id: p.id, memo: pg.memo, meetingType: pg.meetingType === undefined ? null : pg.meetingType }; }),
    });
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  // 第1d回 A-9: 何もしていないときの取り込みと再起動（記録しない）
  if (restartDuring === 'idle') {
    await sleep(100);
    out.apply = await handlers['update:apply']({}, UPDATE_URL);
    out.restart = await handlers['app:restart']();
    Object.assign(out, { relaunches, relaunchDb, applyCalls, engineLog: elogLines() });
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  // 第1d回 A-9 の点検: 再起動を受けて DB を閉じている間（最大 DB_CLOSE_MS）に、会議（画面のボタン・ホットキー）と音声入力を始めようとする。
  // 始まると relaunch で録音が切れるので、始めないこと（out.startWhileClosing・meetingWhileClosing・overlayStartsWhileClosing）を見る
  if (restartDuring === 'closing') {
    await sleep(100);
    const restartP = handlers['app:restart']();
    await waitFor(() => releaseClose !== null, 5000);
    out.closeHeld = releaseClose !== null;
    const overlayStarts = () => sent.filter(([ch]) => ch === 'overlay:start').length;
    const o0 = overlayStarts();
    out.startWhileClosing = await handlers['meeting:toggle']();
    const st = await handlers['settings:get']();
    if (shortcuts[st.meetingHotkey]) await shortcuts[st.meetingHotkey]();
    out.meetingWhileClosing = Boolean(handlers['meeting:status']().active);
    if (shortcuts[st.hotkey]) shortcuts[st.hotkey]();
    out.overlayStartsWhileClosing = overlayStarts() - o0;
    out.hotkeysFound = Boolean(shortcuts[st.meetingHotkey]) && Boolean(shortcuts[st.hotkey]);
    if (releaseClose) releaseClose();
    out.restart = await restartP;
    Object.assign(out, { relaunches, relaunchDb, applyCalls, engineLog: elogLines() });
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  // 第1d回 A-9: 議事録の締めの返事（meeting.finalize）を偽の DB が止めている間に、再起動と取り込みを頼む。離した後にもう一度頼む
  if (restartDuring === 'finalizing') {
    out.start = await handlers['meeting:toggle']();
    listeners['audio:segment']({}, { buffer: new Uint8Array(toneWav(3)), durationMs: 3000, final: false });
    await sleep(50);
    out.stop = await handlers['meeting:toggle']();
    listeners['audio:segment']({}, { buffer: new Uint8Array(toneWav(2)), durationMs: 2000, final: true });
    await waitFor(() => trace.some((t) => t.kind === 'call' && t.cmd === 'meeting.finalize'), 15000);
    await sleep(100);   // 頼みが偽の DB に届いて、返事が止まっている
    const st = handlers['meeting:status']();
    out.stateHeld = !st.active ? 'idle' : st.finalizing ? 'meeting-finalizing' : 'meeting';
    out.restartHeld = await handlers['app:restart']();
    out.applyHeld = await handlers['update:apply']({}, UPDATE_URL);
    out.heldAcked = trace.some((t) => t.kind === 'ack' && t.cmd === 'meeting.finalize');   // 止めている間に返事が来ていない（場面の前提）
    utilFork.release();
    // 締めの返事（DB を閉じてしまったなら断り）が来るまで待つ
    await waitFor(() => trace.some((t) => (t.kind === 'ack' || t.kind === 'fail') && t.cmd === 'meeting.finalize'), 15000);
    // 要約（エンジンの無いこの場面では、すぐ理由を書いて終わる）まで待つ。要約中は summary で断るため。締めが断られたら待たない
    await waitFor(() => { const p = store.listPages()[0]; const page = p && store.getPage(p.id); return finalizeFailed() || Boolean(page && ((page.blocks && page.blocks.length) || page.summaryError || summaryRunDone())); }, 15000);
    await sleep(200);
    out.pages = (await Promise.all(store.listPages().map(pageOut))).map((p) => ({ id: p.id, segments: p.segments }));
    out.restartAfter = await handlers['app:restart']();
    Object.assign(out, { relaunches, relaunchDb, applyCalls, engineLog: elogLines() });
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }

  const wavs = process.env.NATSU_E2E_WAVS
    ? process.env.NATSU_E2E_WAVS.split(';').map((f) => ({ buf: fs.readFileSync(f), ms: Math.round((fs.statSync(f).size - 44) / 32) }))
    : Array.from({ length: segCount }, (_, i) => (blip ? { buf: blipWav(blipSec), ms: blipSec * 1000 } : { buf: toneWav(i ? 2 : 3, silent ? 0 : 8000), ms: segMsFlag || (i ? 2000 : 3000) }));
  // 0.9.4 の版を上げる commit で足した（CI run 39874347478 の test (ubuntu-latest) の D21）: 0.9.4 P-1 で「議事録は準備ができしだい作ります」（DB の用意を
  // 待つ文）を録音バーでなく本体の窓の知らせにしたので、DB の用意の前に会議を始めて止めると知らせの数が時間の具合で変わる。場面（scene）と同じく、
  // 始める前に DB の用意（ready・read-only か down）を待つ（--no-db-wait なら待たない。DB の用意の前の会議を試す場合）
  if (!flags.includes('--no-db-wait')) await waitFor(() => !['none', 'starting', 'migrating'].includes(dbState()), 15000);
  out.start = await handlers['meeting:toggle']();
  // 0.9.0 B-2（--no-whisper-after-start）: 始めた直後に偽のモデルを消す（engineValid(whisperEng) が偽になる）
  if (noWhisperAfterStart) {
    if (process.env.NATSU_E2E_MODEL) throw new Error('--no-whisper-after-start は NATSU_E2E_MODEL と組めない（本物のモデルを消さない）');
    fs.rmSync(model, { force: true });
  }
  await panelAct();
  // 第1d回 A-8: 画面は会議が始まると録音中のタブを開き、main へ知らせる（--live-not-shown は開いていない形）
  if (listeners['meeting:live-shown']) listeners['meeting:live-shown']({}, !liveNotShown);
  if (reloadMain) wins[1].webContents.emit('did-start-loading');
  out.statusCloud = handlers['meeting:status']().cloud;   // C-3: 会議の状態の「クラウドで処理する PC か」（0.7.0 U-1 から: OpenAI の鍵があるときだけ true）
  // 第1d2回 M-1: 何も取り込んでいない PC の場面で会議が始まらなかった。区間を送らずに出して終える（ページを待たない）
  if (noEngineScene && !(out.start && out.start.ok)) {
    await sleep(100);
    await sttOut();
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    out.engineLog = elogLines();
    out.spawns = spawns.slice();
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  if (killMainAtBegin) {
    // 始めたときの写し（下書きの pageId の行）が DB に届くまで待ち、区間を送らずに main ごと落ちる。結果は出さない
    await waitFor(() => { const d = currentDraft(); return Boolean(d && typeof d.pageId === 'string' && peekDb((h) => h.getPage(d.pageId), null)); }, 15000);
    process.exit(3);
  }
  // 0.9.0 B-2（--net-seq）: 偽の時計を 1 秒ずつ進め、net.isOnline() の答えを並びのとおりにして watchOffline を呼ぶ
  const netT0 = Date.now();
  let netSec = 0;
  const netProblems = [];
  const netSegs = [];
  const netValueAt = (sec) => { let v = true; for (const [t, on] of netSeq || []) if (t <= sec) v = on; return v; };
  const netNote = (sec) => {
    const st = handlers['meeting:status']();
    const code = st && st.stt && st.stt.problem ? st.stt.problem.code : null;
    if (!netProblems.length || netProblems[netProblems.length - 1][1] !== code) netProblems.push([sec, code]);
    return code;
  };
  const netRunTo = (until) => {
    for (; netSec <= until; netSec++) {
      netUp = netValueAt(netSec);
      for (const f of offTicks) f(netT0 + netSec * 1000);
      netNote(netSec);
    }
  };
  const netEnd = netSeq ? netSeq[netSeq.length - 1][0] + 12 : 0;
  const firstOff = netSeq ? (netSeq.find(([, on]) => !on) || [0])[0] : 0;
  const netSegAt = (i) => (netSegAtFlag && Number.isFinite(netSegAtFlag[i]) ? netSegAtFlag[i] : firstOff + 5 + 5 * i);
  if (netSeq && !(out.start && out.start.ok)) {
    out.engineLog = elogLines();
    out.netProblems = netProblems;
    out.netSegs = netSegs;
    out.sttSeen = sttSeen.slice();
    out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
    out.notifications = notifications.slice();
    out.offlineWatch = { started: offTicks.length, cleared: offCleared };
    process.stdout.write(`\n${JSON.stringify(out)}\n`);
    await exitClean(0);
  }
  if (localOnlyFlag) {
    out.localOnly = await handlers['meeting:set-local-only']({}, true);
    const st = handlers['meeting:status']();
    out.statusLocalOnly = { localOnly: st.localOnly, cloud: st.cloud };
    out.statusNeedsSetup = st.needsSetup;   // 第1d2回 M-4
    // 下書き（draft.json）にも印が書かれたか（落ちて復旧した会議の送り直しも手元にするため）
    try { out.draftLocalOnly = JSON.parse(readUser('data/draft.json').toString('utf8')).localOnly; } catch (_) { out.draftLocalOnly = null; }
  }
  // 0.9.1 Q-4（--quiet-seq）: 字を順に行う（今の区間の並びの代わり）
  if (quietSeq) {
    const stopsSent = () => sent.filter(([ch]) => ch === 'overlay:stop').length;
    const settled = async () => { await sleep(30); await waitFor(() => handlers['meeting:status']().pending === 0, 15000); await sleep(30); };
    const sendSeg = (buf, final) => listeners['audio:segment']({}, { buffer: new Uint8Array(buf), durationMs: quietSegMs, final });
    const bufOf = (k) => (k === 's' ? toneWav(2, 0) : k === 'b' ? blipWav(3) : toneWav(2));
    out.quietTrace = [];
    let stopped = false;
    for (let i = 0; i < quietSeq.length && !stopped; i++) {
      const { k, ans, tok } = quietSeq[i];
      if ('stb'.includes(k)) {
        if (relayLocal) await relayLocal.setAnswer(ans);
        const s0 = stopsSent();
        sendSeg(bufOf(k), false);
        await settled();
        if (stopsSent() > s0) {
          // main が自分で止めた: 録音バーの代わりに最後の空の区間を送る
          out.quietStopAt = i;
          stopped = true;
          listeners['audio:segment']({}, { buffer: new Uint8Array(0), durationMs: 0, final: true });
        }
      } else if (k === 'T' || k === 'L') {
        // 0.12.1 LV-3（--quiet-mic。R2）: 偽の見張りに1行（T は mic teams:1・L は mic -）を書いて偽の時計を 2 秒進める。main が自分で止めたら、
        // 偽の時計を 10 分進めてから（0.9.1 がもう一度止めようとしないことを見る）最後の空の区間を送る
        const s0 = stopsSent();
        const kid = micKids[micKids.length - 1];
        if (kid) kid.stdout.emit('data', Buffer.from(`${k === 'T' ? 'mic teams:1' : 'mic -'}\n`));
        advanceClock(2000);
        await sleep(20);
        if (stopsSent() > s0) {
          out.quietStopAt = i;
          stopped = true;
          advanceClock(600000);
          await sleep(20);
          listeners['audio:segment']({}, { buffer: new Uint8Array(0), durationMs: 0, final: true });
        }
      } else if (k === 'S') {
        sendSeg(toneWav(2, 0), false);
        listeners['overlay:pause']({}, { paused: true });   // 区間を分ける前（segChain の次の番）に一時停止にする
        await settled();
        if (stopsSent() > 0 && !out.quietStopAt) out.quietStopAt = i;
      } else if (k === 'R') {
        listeners['overlay:pause']({}, { paused: false });
        await sleep(30);
      } else if (k === 'k') {
        out.keepGoing = await handlers['meeting:keep-going']();
      } else if (k === 'P') {
        listeners['overlay:pause']({}, { paused: true });
        await sleep(30);
        advanceClock(20 * 60000);
        listeners['overlay:pause']({}, { paused: false });
        await sleep(30);
      } else if (k === 'x' || k === 'X') {
        out.stop = await handlers['meeting:toggle']();
        stopped = true;
        if (relayLocal) await relayLocal.setAnswer('c');
        if (k === 'X') sendSeg(toneWav(2, 0), true);
        else listeners['audio:segment']({}, { buffer: new Uint8Array(0), durationMs: 0, final: true });
        await sleep(100);
      } else if (k === 'd') {
        out.seqAtDiscard = sent.filter(([ch]) => ch === 'overlay:phase' || ch === 'overlay:stop').length;
        out.discard = await handlers['meeting:discard']();
        await sleep(3500);   // 録音バーへの送り直し（3 秒）が残っていないことを見る
        Object.assign(out, { notifications: notifications.slice(), notifyClosed, engineLog: elogLines(),
          overlaySeq: sent.filter(([ch]) => ch === 'overlay:phase' || ch === 'overlay:stop').map(([ch, p]) => (ch === 'overlay:stop' ? { stop: true } : p)) });
        const st0 = handlers['meeting:status']();
        out.quietTrace.push({ i, tok, asked: Boolean(st0.quiet), active: Boolean(st0.active), stopping: Boolean(st0.stopping) });
        process.stdout.write(`\n${JSON.stringify(out)}\n`);
        await exitClean(0);
      }
      const st = handlers['meeting:status']();
      if (st.quiet && !out.quietText) out.quietText = st.quiet.text;
      out.quietTrace.push({ i, tok, asked: Boolean(st.quiet), active: Boolean(st.active), stopping: Boolean(st.stopping) });
    }
    if (!stopped) {
      out.stop = await handlers['meeting:toggle']();
      listeners['audio:segment']({}, { buffer: new Uint8Array(0), durationMs: 0, final: true });
    }
    wavs.length = 0;   // 今の区間の並びは回さない
  }
  // 0.12.0 SP-3a（--two-streams）: 偽の録音バーが2つの流れの区間を送る（頭の注釈）
  if (twoFx) {
    await runTwoStreams();
    wavs.length = 0;   // 今の区間の並びは回さない
  }
  async function runTwoStreams() {
    const fx = twoFx;
    const tick = Number(fx.tick) || 100;
    const runs = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).flatMap((tok) => {
      const mm = /^([v-])(\d+)$/.exec(tok);
      if (!mm) throw new Error(`mainrun: --two-streams の並び ${tok} が読めない`);
      return Array(Number(mm[2])).fill(mm[1] === 'v');
    });
    const frames = { mic: runs(fx.mic), loopback: runs(fx.sys) };
    const total = Math.max(frames.mic.length, frames.loopback.length);
    const amp = Number.isFinite(fx.amp) ? fx.amp : 8000;
    const quietAmp = Number(fx.quietAmp) || 0;
    const drift = Number(fx.drift) || 0;
    const lanes = { mic: { seg: 0, fr: [], t0: 0, first: true, src: 'mic', n: 0 }, loopback: { seg: 0, fr: [], t0: 0, first: true, src: 'loopback', n: 0 } };
    let sysAlive = fx.sysOk !== false;
    let sim = 0;
    let finalSent = false;
    let bad = Boolean(fx.badMeta);
    const two = { asks: 0, asksPaused: 0, cuts: 0, meetingLevel: 0, quietAsked: false, sent: [], finalWaitMs: twoFinalWaitMs };
    out.two = two;
    const segMsNow = () => { for (let k = overlaySent.length - 1; k >= 0; k--) { const pv = overlaySent[k]; if (typeof pv === 'number') return pv; if (pv && pv.segmentSec) return pv.segmentSec * 1000; } return 15000; };
    const wavOf = (fr, idx) => {
      const per = Math.round(16 * tick);
      const n = Math.max(fr.length * per, 3);
      const b = Buffer.alloc(44 + n * 2);
      b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'ascii');
      b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
      b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
      b.write('data', 36, 'ascii'); b.writeUInt32LE(n * 2, 40);
      for (let k = 0; k < fr.length * per; k++) {
        const a = fr[Math.floor(k / per)] ? amp : quietAmp;
        if (a) b.writeInt16LE(Math.round(a * Math.sin((2 * Math.PI * 220 * k) / 16000)), 44 + k * 2);
      }
      b.writeInt16LE(3, 44 + (n - 3) * 2); b.writeInt16LE(-3, 44 + (n - 2) * 2); b.writeInt16LE(idx, 44 + (n - 1) * 2);
      return b;
    };
    const textFor = (key, k, L) => {
      if (fx.silentText && fx.silentText[key]) return '';
      const said = (fx.say || []).find((x) => x.src === key && x.at >= L.t0 && x.at < L.t0 + L.fr.length * tick);
      if (said) return said.text;
      const list = fx.texts && Array.isArray(fx.texts[key]) ? fx.texts[key] : null;
      if (list && typeof list[k] === 'string') return list[k];
      if (fx.sentences) return key === 'mic' ? `わたしから一つ目の${k + 1}を話します。二つ目に予定を決めます。三つ目に担当を決めます。` : `そちら側の${k + 1}番を聞かせてください。工程も教えてください。`;
      // 流れごとに違う言い回し（既定の文どうしが回り込みに見えない: 文字の3つ組がほとんど重ならない）
      return key === 'mic' ? `わたしから${['見積', '在庫', '納期', '契約', '採用', '予算', '品質', '体制'][k % 8]}をご説明します${k + 1}`
        : `そちら側で${['売上', '工程', '発注', '保守', '研修', '広報', '設計', '監査'][k % 8]}はどうお考えでしょう${k + 1}`;
    };
    const send = (key, { last = false } = {}) => {
      const L = lanes[key];
      const fr = L.fr;
      const idx = streamTexts.push(textFor(key, L.n, L)) - 1;
      writeTags();
      L.n += 1;
      const buf = fr.length ? wavOf(fr, idx) : Buffer.alloc(0);
      const durationMs = Math.max(0, fr.length * tick - (fr.length ? drift : 0));
      const other = lanes[key === 'mic' ? 'loopback' : 'mic'];
      if (last) L.done = true;
      const final = last && Boolean(other.done) && !finalSent;
      if (final) finalSent = true;
      const voiced = fr.some(Boolean);
      const meta = bad && voiced ? { src: 'mic', seg: -5, t0: 'x', last: 'no' } : { src: key === 'loopback' ? 'loopback' : L.src, seg: L.seg, t0: fx.noT0 ? null : L.t0, last };
      if (voiced) bad = false;   // 壊すのは声のある最初の区間（無音の区間は1本の道でも除かれて行にならない）
      two.sent.push({ src: meta.src, seg: L.seg, t0: L.t0, durationMs, bytes: buf.length, last, final });
      listeners['audio:segment']({}, { buffer: new Uint8Array(buf), durationMs, final, meta });
      L.seg += 1; L.t0 = sim; L.fr = []; L.first = false;
      if (key === 'mic') L.src = sysAlive ? 'mic' : '';
    };
    const answer = (k) => (fx.badLevel && k % 2 ? [{ mic: 'x', sys: -1, warn: '', vMic: 1e9, vSys: 0, segMic: 1.5, segSys: -7, sysOk: 'yes' }, null, 'x', { mic: 0.1 }][k % 4 === 1 ? 0 : (k % 8 === 3 ? 1 : 3)] : {
      mic: 0.1, sys: sysAlive ? 0.1 : 0, warn: '',
      vMic: frames.mic[k] ? 0.2 : 0, vSys: sysAlive && frames.loopback[k] ? 0.2 : 0,
      segMic: lanes.mic.seg, segSys: sysAlive ? lanes.loopback.seg : -1, sysOk: sysAlive });
    lanes.loopback.done = !sysAlive;
    // PC の側の場面は、偽の whisper が口を開くまで待ってから録り始める（偽の時計は本物より速く進むので、起動の前に区間が届いてしまう）
    if (!relayMode) {
      const up = () => new Promise((r) => { const q = require('http').get({ host: '127.0.0.1', port: localPort, path: '/health', timeout: 500 }, (res) => { res.resume(); r(res.statusCode === 200); }); q.on('error', () => r(false)); q.on('timeout', () => { q.destroy(); r(false); }); });
      for (let i = 0; i < 100 && !(await up()); i++) await sleep(50);
      await sleep(1000);   // main の起動の見張り（/health を間を置いて聞く）が済むまで。偽の時計を進めると、その見張りの期限が先に切れる
    }
    listeners['overlay:source']({}, { systemAudio: fx.sourceSays === false ? false : sysAlive, wanted: true });
    await sleep(10);
    for (let k = 0; k < total; k++) {
      if (fx.pauseAt && sim === fx.pauseAt) {
        // 一時停止: 両方の流れの区間を締めて送り（最後ではない）、止めていた間は時計だけ進める。再開で両方の流れが新しい区間を始める
        send('mic'); if (sysAlive) send('loopback');
        listeners['overlay:pause']({}, { paused: true });
        await sleep(30);
        { const p0 = sent.length; for (const f of [...askLevels.values()]) f(); two.asksPaused += sent.slice(p0).filter(([ch]) => ch === 'overlay:level-ask').length; }
        advanceClock(Number(fx.pauseMs) || 0);
        listeners['overlay:pause']({}, { paused: false });
        if (fx.sysBack && !sysAlive) { sysAlive = true; lanes.loopback.done = false; lanes.mic.src = 'mic'; }
        listeners['overlay:source']({}, { systemAudio: sysAlive, wanted: true });   // 再開の openStream は取り込みの有無を言い直す
        await sleep(30);
        lanes.mic.t0 = sim; lanes.loopback.t0 = sim;
      }
      advanceClock(tick);
      sim += tick;
      lanes.mic.fr.push(Boolean(frames.mic[k]));
      if (sysAlive) lanes.loopback.fr.push(Boolean(frames.loopback[k]));
      const s0 = sent.length;
      for (const f of [...askLevels.values()]) f();
      const now = sent.slice(s0);
      if (now.some(([ch]) => ch === 'overlay:level-ask')) { two.asks += 1; listeners['overlay:level']({}, answer(k)); }
      const after = sent.slice(s0);
      two.meetingLevel += after.filter(([ch]) => ch === 'meeting:level').length;
      for (const [ch, pv] of after) {
        if (ch !== 'overlay:cut' || !pv) continue;
        const L = lanes[pv.src];
        if (!L || L.seg !== pv.seg || (pv.src === 'loopback' && !sysAlive)) continue;
        two.cuts += 1;
        send(pv.src);
      }
      for (const key of ['mic', 'loopback']) {
        if (key === 'loopback' && !sysAlive) continue;
        if (lanes[key].fr.length * tick >= (lanes[key].first ? 20000 : segMsNow())) send(key);
      }
      if (fx.sysLostAt && sim === fx.sysLostAt && sysAlive) {
        sysAlive = false;
        listeners['overlay:source']({}, { systemAudio: false, wanted: true });   // 知らせが先に届き、相手の声の最後の区間は後から届く（A16）
        send('loopback', { last: true });
      }
      if (fx.killAt && sim === fx.killAt) {
        out.firstInDb = await waitFor(() => settledInDb(), 15000);
        process.exit(3);
      }
      if (k % 50 === 0 && handlers['meeting:status']().quiet) two.quietAsked = true;
      if (k % 4 === 0) await new Promise((r) => setImmediate(r));
    }
    if (handlers['meeting:status']().quiet) two.quietAsked = true;
    await sleep(50);
    out.stop = await handlers['meeting:toggle']();
    // 点検の直し C1（決めたこと 130 の改め）: 最後の2つの届く順と間（録音バーの2つの録音は別々に止まる）。後に送った方に final
    if (fx.lastOrder === 'mic-first') {
      send('mic', { last: true });
      await sleep(Number(fx.lastGapMs) || 500);
      if (sysAlive && fx.dropLast !== 'loopback') send('loopback', { last: true });
    } else {
      if (sysAlive && fx.dropLast !== 'loopback') send('loopback', { last: true });
      send('mic', { last: true });
    }
  }
  for (let i = 0; i < wavs.length; i++) {
    // 取り消す場面（--discard-during）は最初の区間の後で取り消すので、止めない（--segs=1 でも録音中のまま取り消す）
    const last = i === wavs.length - 1 && !discardDuring;
    // 第1d回 A-6: n 区間の後にログインし直す（区間を待たずに帯 login が消えるか）
    if (reloginAfterN && i === reloginAfterN) {
      relayLocal.clock.advance(61000);   // 取り消した人は 1 分ほどログインし直せない（Access）。偽の Access は取り消した時より後に出した cookie を通す
      out.relogin = { login: await handlers['account:login']({}) };
      out.reloginStt = handlers['meeting:status']().stt;
    }
    // 第1d2回 M-4: n 区間が片付いた後に［この会議は PC の中だけ］を押す
    if (localOnlyAfterN && i === localOnlyAfterN) {
      out.localOnly = await handlers['meeting:set-local-only']({}, true);
      const st = handlers['meeting:status']();
      out.statusLocalOnly = { localOnly: st.localOnly, cloud: st.cloud };
      out.statusNeedsSetup = st.needsSetup;
    }
    if (clockSeq.has(i)) advanceClock(clockSeq.get(i));   // 0.9.4 S-5
    if (relaySeq) await relayLocal.setAnswer(relaySeq[i] || 'c');   // 第1d回 A-5: この区間の中継の答え方
    // 第1d2回 M-3・M-4 の点検: この区間の答えを止め、文字になって並べ直した最初の要求を main が出したら［この会議は PC の中だけ］を押す
    const atRetry = localOnlyAtRetryN && i === localOnlyAtRetryN - 1;
    const sttSentNow = () => relayPaths.filter((x) => x === '/v1/audio/transcriptions').length;
    const sttSent0 = sttSentNow();
    if (atRetry) relayLocal.setFront('delay-stt');
    if (netSeq) netRunTo(last ? Math.max(netEnd, netSec) : netSegAt(i));   // 0.9.0 B-2: この区間を送る秒まで（最後は並びの後まで）進める
    // 第1d回 A-6: n 区間の後（この区間の答え方にしてから）に［もう一度］を返事を待たずに2回
    if (retryAfterN && i === retryAfterN) {
      const r1 = handlers['meeting:retry']();
      const r2 = handlers['meeting:retry']();
      out.retry = [await r1, await r2];
      await sleep(50);
      await waitFor(() => handlers['meeting:status']().pending === 0, 15000);
      const st = handlers['meeting:status']();
      out.retried = { stt: st.stt, segments: segSnap(st.segments) };
    }
    if (last) out.stop = await handlers['meeting:toggle']();
    listeners['audio:segment']({}, { buffer: new Uint8Array(wavs[i].buf), durationMs: wavs[i].ms, final: last });
    if (last && skipAtStop) {   // 0.9.4 S-3: 1 区間が文字になったら、残りを後回しにする
      await waitFor(() => (handlers['meeting:status']().segments || []).some((x) => !x.pending && !x.failed), 10000);
      out.skip = await handlers['meeting:skipPending']();
      // 締めは裏で進む（meeting は先に空になる）ので、後回しにした直後の下書きの区間を写す
      const d = currentDraft();
      out.skippedSegs = (d && Array.isArray(d.segments) ? d.segments : []).filter((x) => x && x.failed).map((x) => ({ id: x.id, text: x.text, failed: true, wav: Boolean(x.wav && fs.existsSync(x.wav)) }));
    }
    if (last && retryAtStop) out.retryAtStop = await handlers['meeting:retry']();
    if (atRetry) {
      await waitFor(() => sttSentNow() >= sttSent0 + 2, 5000);   // この区間と、並べ直した1つ目
      out.localOnly = await handlers['meeting:set-local-only']({}, true);
      out.sttSentAtLocalOnly = sttSentNow() - sttSent0;
    }
    await sleep(50);
    if (relaySeq) {
      const t0 = Date.now();
      await waitFor(() => handlers['meeting:status']().pending === 0, 15000);   // 文字になるか失敗するまで（区間と並びが1対1）
      (out.segWaitMs || (out.segWaitMs = [])).push(Date.now() - t0);   // 第1d2回 M-2
      // 第1d2回 M-2: 音声を残した区間が下書きに書かれたら、main ごと落ちる（結果は出さない）
      if (killMainAfterKept) { const d = currentDraft(); if (d && Array.isArray(d.segments) && d.segments.some((x) => x && x.kept)) process.exit(3); }
    }
    if (netSeq && !last) {
      // 0.9.0 B-2: その秒のつながり方のまま、区間が片付くまで待ち、そのときの帯を残す
      await waitFor(() => handlers['meeting:status']().pending === 0, 15000);
      netSegs.push({ s: netSec - 1, problem: netNote(netSec - 1) });
    }
    if (i === 0 && liveMemo !== null) out.liveMemo = await handlers['meeting:set-memo']({}, liveMemo);
    if (i === 0 && setTypeLive.length) { out.setTypeLive = []; for (const k of setTypeLive) out.setTypeLive.push(await handlers['meeting:set-type']({}, k)); out.liveStatusType = handlers['meeting:status']().meetingType; }
    if (i === 0 && testDuring) out.testDuring = await handlers['app:test']();
    // 第1d回 A-9: 会議の録音中に再起動と取り込みを頼む（断られて、録音はそのまま続く）
    if (i === 0 && restartDuring === 'meeting') {
      // 断る前後で子の kill() を数え（out.killsAtRefusal）、そのときエンジンが動いていたか（out.enginesAtRefusal）を残す。
      // 断った後も録音中の閉じるボタンは確かめで止まるか（quitting を立てていないか。out.closeAfterRefusal）
      const kills0 = killCalls;
      out.enginesAtRefusal = liveEngines();
      out.restart = await handlers['app:restart']();
      out.apply = await handlers['update:apply']({}, UPDATE_URL);
      out.killsAtRefusal = killCalls - kills0;
      out.closeAfterRefusal = pressClose();
    }
    if (i === 0 && (killDbDuring || killMainDuring)) {
      // 最初の区間が文字起こしされて下書きに書かれ、写しとして DB に届いてから落とす
      out.firstInDb = await waitFor(() => settledInDb(), 15000);
      if (killMainDuring) process.exit(3);   // main ごと（DB の子も一緒に止まる）。結果は出さない
      utilFork.crash(1);
    }
    if (i === 0 && discardDuring) {
      if (secretText) out.secretSeen = await waitFor(() => settledInDb(SECRET), 15000);
      else if (discardSettled) out.settledBeforeDiscard = await waitFor(() => handlers['meeting:status']().pending === 0, 15000);
      else await sleep(300);
      if (killDbAtDiscard) utilFork.crash(1);   // 取り消しの頼みは起こし直しを待つ。その前に終える
      out.discard = await handlers['meeting:discard']();
      break;
    }
  }
  // 破棄の後にやり直しが送られないことを、返事が来るまで待って確かめる。秘密の語の場面は、DB の取り消し（purge）の返事まで待つ
  if (discardDuring && !killDbAtDiscard) {
    if (secretText) await waitFor(() => trace.some((t) => (t.kind === 'ack' || t.kind === 'fail') && t.cmd === 'meeting.discard'), 10000);
    else await sleep(3000);
  }
  const deadline = Date.now() + (discardDuring ? 0 : Number(process.env.NATSU_E2E_WAIT_MS || 60000));
  // 締めが DB に断られた（--db-down）ら、ページを待たない（下書きに残る）
  while (Date.now() < deadline && !store.listPages().length && !finalizeFailed()) await sleep(50);
  // 要約の途中で会議タイプ・題名を手で直す（画面と同じ役 app の口。第2a1回 M-3 から main は中継しない）
  if ((setTypeDuring || setTitleDuring) && store.listPages().length) {
    await sleep(300);
    const id = store.listPages()[0].id;
    if (setTypeDuring) out.setType = await appCall('page.setType', { id, type: setTypeDuring });
    if (setTitleDuring) out.setTitle = await appCall('page.setTitle', { id, title: setTitleDuring });
  }
  // 要約まで済むのを待つ: 要約のブロックができるか、要約欄に理由が書かれるまで
  // （新しいページは summaryError を空で持っているので、空かどうかでは決められない）
  while (Date.now() < deadline) {
    const p = store.listPages()[0];
    const page = p && store.getPage(p.id);
    if (page && ((page.blocks && page.blocks.length) || page.summaryError)) break;
    if (page && summaryRunDone()) break;   // 0.10.0 LS-2: 文字起こしが空のページは要約の欄に理由を書かない（要約の走りが終わったかで見る）
    if (!p && finalizeFailed()) break;
    await sleep(50);
  }
  {   // 0.9.4 S-3: 要約の欄が埋まったときの要約の数
    const p0 = store.listPages()[0];
    out.chatsAtFinalize = chatCount();
    out.summaryAtFinalize = p0 ? store.getPage(p0.id).summaryError : null;
  }
  await sleep(200);
  // 0.11.0 Q-3: 要約の後に打ち合わせの質の設定を替えて［要約を再生成］（--resum-quality=<all|on|off>）
  if (flagVal('--resum-quality') && store.listPages().length) {
    out.qualityBefore = (store.getPage(store.listPages()[0].id) || {}).quality;
    await handlers['settings:save']({}, { qualityScore: flagVal('--resum-quality') });
    out.resum = await handlers['page:summarize']({}, store.listPages()[0].id);
  }
  // 0.13.0 点検4（2026-10-26 の持ち主の答え）: 要約の後に画面の役で行を1つ消し（ページの印 summaryEdited が付く）、［要約を再生成］すると印が消える（--resum-after-edit）
  if (flags.includes('--resum-after-edit') && store.listPages().length) {
    const id = store.listPages()[0].id;
    const pg = (await appCall('page.get', { id })).page;
    await appCall('block.remove', { pageId: id, blockId: pg.blocks[pg.blocks.length - 1].id });
    out.editedBefore = (await appCall('page.get', { id })).page.summaryEdited;
    out.resumEdit = await handlers['page:summarize']({}, id);
    out.editedAfter = (await appCall('page.get', { id })).page.summaryEdited;
  }
  // 0.11.0 P-12（R4）: 前の版で手で一般・その他を選んだページにして（page.put で attrs を書く）、［要約を再生成］（--legacy-general）
  if (flags.includes('--legacy-general') && store.listPages().length) {
    const id = store.listPages()[0].id;
    const cur = await dbClient.call('page.get', { id });
    const pg = cur && cur.page ? cur.page : cur;
    const { rev, ...rest } = pg;
    await dbClient.call('page.put', { page: { ...rest, meetingType: 'general', typeAuto: false }, baseRev: rev });
    const before = store.getPage(id) || {};
    out.legacyGeneral = { before: { meetingType: before.meetingType, typeAuto: before.typeAuto } };
    out.legacyGeneral.resum = await handlers['page:summarize']({}, id);
  }
  // 要約の直後の page:updated の qualityView（0.11.0 Q-3）
  { const u = sent.filter(([ch]) => ch === 'page:updated').pop(); out.updatedQualityView = u && u[1] && u[1].page ? u[1].page.qualityView : undefined; }
  // 要約の後に画面で題名を直す（--set-title-after-sum）
  if (setTitleAfterSum && store.listPages().length) out.setTitleAfter = await appCall('page.setTitle', { id: store.listPages()[0].id, title: setTitleAfterSum });
  const pages = await Promise.all(store.listPages().map(pageOut));
  out.pages = pages;
  out.updatedRouteText = lastUpdatedRouteText();
  // 文字起こしの行を直したときの返事（segment:update）も経路の行を持つか（画面はその返事で curPage を差し替える）。
  // 要約まで済んだ --claude=ok の場面だけ、1つ目の行を同じ文で直す（失敗の印を外すので、ほかの場面では触らない）
  if (claudeMode === 'ok' && store.listPages().length) {
    const pid = store.listPages()[0].id;
    const sg = store.getTranscript(pid)[0];
    const r = sg ? await appCall('segment.update', { pageId: pid, segId: sg.id, patch: { text: sg.text } }) : null;
    out.segUpdateRouteText = r && r.page ? r.page.routeText : null;
  }
  // 0.10.0 LS-2: つながったら見回りで要約待ちのページを作る（--summary-online-after・--summary-reconnect）
  if (summaryOffline && summaryOnlineAfter >= 0) {
    const snapBack = async () => ({ pCalls: claudeLines().filter((c) => c.kind === 'p').length, pages: await Promise.all(store.listPages().map(pageOut)) });
    await sleep(summaryOnlineAfter);
    out.summaryBack = [];
    netUp = true;
    await keptTick(); await sleep(200); out.summaryBack.push(await snapBack());
    await keptTick(); await sleep(200); out.summaryBack.push(await snapBack());
    if (summaryReconnect) {
      netUp = false;
      await keptTick();
      netUp = true;
      await keptTick(); await sleep(200); out.summaryBack.push(await snapBack());
    }
  }
  out.claude = claudeLines();
  out.notices = sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p);
  out.overlaySent = overlaySent.slice();
  out.cutsSent = sent.filter(([ch]) => ch === 'overlay:cut').length;   // 0.12.0 SP-3a
  out.order = order.slice();
  out.sttSeen = sttSeen.slice();
  out.sttAt = sttAt;
  // 0.9.0 B-2: 会議が終わった後の見張りの1回（本物の間隔なら 1 秒以内に来る）。録音していなければ自分で止まる
  if (netSeq) { for (const f of offTicks) f(netT0 + (netSec + 1) * 1000); Object.assign(out, { netProblems, netSegs }); }
  out.offlineWatch = { started: offTicks.length, cleared: offCleared };
  out.notifications = notifications.slice();
  out.notifyClosed = notifyClosed;   // 0.9.1 Q-4
  if (quietSeq) {
    out.stopCalls = sent.filter(([ch]) => ch === 'overlay:stop').length;
    out.overlaySeq = sent.filter(([ch]) => ch === 'overlay:phase' || ch === 'overlay:stop').map(([ch, p]) => (ch === 'overlay:stop' ? { stop: true } : p));
    const p0 = store.listPages()[0];
    const pg = p0 && store.getPage(p0.id);
    out.pageDur = pg ? { durationSec: pg.durationSec, pauses: pg.pauses || [], stateLog: pg.stateLog || null } : null;   // 0.10.0 K-1: 経過も
  }
  out.mainWinCalls = mainWinCalls.slice();
  out.showLive = mainSent.filter((ch) => ch === 'meeting:show-live').length;
  const elog = path.join(userData, 'engine.log');
  out.engineLog = fs.existsSync(elog) ? fs.readFileSync(elog, 'utf8').split('\n').filter(Boolean).map((l) => l.replace(/^\[[^\]]+\] /, '')) : [];
  out.requests = fs.readFileSync(flog, 'utf8').split('\n').filter((l) => l.startsWith('inference'));
  out.spawnArgs = (fs.readFileSync(flog, 'utf8').split('\n').find((l) => l.startsWith('spawn ')) || '').slice(6);
  { const t = readUser('data/local-pace.json'); out.paceFile = t ? t.toString('utf8') : null; }   // 0.9.4 S-4: この PC の速さの覚え
  out.promptInfo = await handlers['prompt:info']();
  out.engineStatus = await handlers['engine:status']();
  out.engineFetchStatus = handlers['engine:fetch-status'] ? await handlers['engine:fetch-status']() : null;   // 第0b回 Task 13
  out.spawns = spawns;
  out.seq = seq;
  out.atReady = atReady;
  out.savedSettings = JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8'));
  if (afterDict) {
    out.saved = await handlers['settings:save']({}, { dictionary: ['検収'] });
    out.promptInfoAfterDict = await handlers['prompt:info']();
  }
  if (afterRetry) {
    await waitFor(recoverySettled, 15000);
    await sleep(100);
    const p = store.listPages()[0];
    out.afterRetry = {
      segments: p ? store.getTranscript(p.id).map((x) => ({ text: x.text, failed: Boolean(x.failed), parts: x.parts, src: x.src })) : [],   // 0.12.0 SP-3b: parts・src
      engineLog: elogLines(),
      requests: fs.readFileSync(flog, 'utf8').split('\n').filter((l) => l.startsWith('inference')),
    };
    out.queueAfterRetry = queueNow();   // 0.9.4 S-3
  }
  // 0.9.4 S-3: 設定の保存で会議の後の文字起こしを引き直す
  if (recoverAgainN) {
    out.again = [];
    for (let k = 0; k < recoverAgainN; k++) out.again.push(await recoverOnce(() => handlers['settings:save']({}, {})));
  }
  if (deletePagesThenRecover) {
    for (const p of store.listPages()) await appCall('page.delete', { id: p.id });
    const r = await recoverOnce(() => handlers['settings:save']({}, {}));
    out.afterDelete = { queue: r.queue, wavs: r.wavs };
  }
  if (waitQueueEmpty) {
    await waitFor(() => !queueFilesNow().length, 15000);
    // 待ち行列の後の自動の要約（要約の欄が文字起こし待ちの文から替わり、ブロックか理由が入る）まで
    const WAIT_RE = /文字起こし待ちの音声があります。/;
    await waitFor(() => store.listPages().every((p) => { const pg = store.getPage(p.id); return !WAIT_RE.test(pg.summaryError || '') && ((pg.blocks || []).length > 0 || pg.summaryError); }), 10000).catch(() => {});
    await waitFor(() => chatCount() > (out.chatsAtFinalize || 0), 1500);   // 待ち行列の後に要約を作ったか（作らない場面は 1.5 秒見る）
    await sleep(300);
    out.afterQueue = { pages: snapPages(), notices: sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p), chats: chatCount(), wavs: segWavFiles(), log: elogLines() };
  }
  if (fakeStt || relayLocal) {
    // 会議の後の送り直し（失敗した区間の待ち行列）が済むか、残して止まるまで待ってから写す
    await waitFor(recoverySettled, 15000);
    await sleep(100);
    const pagesBefore = out.pages;
    await sttOut();
    // 今までの欄（要約・会議タイプなど）も残す
    out.pages = out.pages.map((p, i) => ({ ...(pagesBefore[i] || {}), ...p }));
  }
  if (restartDuring) Object.assign(out, { relaunches, relaunchDb, applyCalls });
  // 第1d2回 M-3: 写した後の見回り・戻り・ログイン
  const pagesNow = () => store.listPages().map((p) => {
    const page = store.getPage(p.id);
    return { id: p.id, summaryError: page.summaryError, blocks: (page.blocks || []).length,
      segments: store.getTranscript(p.id).map((x) => ({ text: x.text, failed: Boolean(x.failed) })) };
  });
  const S3_RE = /^(この会議は PC の中だけです。)?文字起こし待ちの音声があります。/;
  if (ticksOffline) {
    netUp = false;
    const log0 = elogLines().length;
    const rel0 = relayPaths.length;
    for (let k = 0; k < ticksOffline; k++) await keptTick();
    await sleep(200);
    out.ticksOffline = { ticks: keptTicksCalled, logAdded: elogLines().slice(log0), relayAdded: relayPaths.slice(rel0) };
  }
  if (backAfter) {
    await relayLocal.setAnswer('c');
    netUp = true;
    await keptTick();
    // 待ち行列が片付いたら、要約の欄が S3 から替わり、要約が済む（ブロックか理由）まで待つ。見回りは文字起こしを待って返すので、
    // 待ち行列が残っていれば（PC の中だけの待ち行列は送らない）待たない
    if (!segbufLeft().queue) await waitFor(() => pagesNow().every((p) => !S3_RE.test(p.summaryError || '') && (p.blocks > 0 || p.summaryError)), 10000);
    await sleep(200);
    out.afterBack = { pages: pagesNow(), engineLog: elogLines(), relayCalls: relayPaths.slice(), notices: sent.filter(([ch]) => ch === 'app:notice').map(([, p]) => p),
      claudeCalls: claudeLines().filter((c) => c.kind === 'p').length, files: listFiles(userData),
      queues: listFiles(userData).filter((f) => /^data\/segbuf\/[^/]+\/recovery\.json$/.test(f)).map((f) => {
        const j = JSON.parse(readUser(f).toString('utf8'));
        return { localOnly: j.localOnly === true, items: Array.isArray(j.items) ? j.items.length : 0 };
      }) };
  }
  if (loginAfter) {
    const login = await handlers['account:login']({});
    await waitFor(() => !segbufLeft().queue && pagesNow().every((p) => p.segments.every((x) => !x.failed)), 10000);
    await sleep(200);
    out.afterLogin = { login, pages: pagesNow(), engineLog: elogLines(), relayCalls: relayPaths.slice(), keptTicks: keptTicksCalled };
  }
  process.stdout.write(`\n${JSON.stringify(m3Out(out))}\n`);
  await exitClean(0);
})().catch((e) => { process.stderr.write(`mainrun: ${e.stack || e}\n`); process.exit(1); });
