# ヘルプセンターのリリースノートのページ — 実装計画（2026-10-23）

> **この計画は「計画だけ」。** CLAUDE.md の決まりどおり、持ち主とのソクラテス式の問答で承認をもらうまで、実装（落ちるテストを含む）に入らない。問答で計画が変わったら直して、また問う。
> **2026-10-23:** 問い Q1〜Q9 に持ち主が答えた（どれも A。下の「問答の答え（2026-10-23）」）。
> **2026-10-24: 持ち主が承認した。** 計画に「作り始めてよい」、アイコンの見本（Q6。スクラッチパッドの `relnotes-icon/`）に「この見本でよい」。この計画のとおりに作る（タスク RN-0〜RN-7）。

## 問答の答え（2026-10-23）

この節がいちばん先に効き、次に下の初めの計画。

| # | 持ち主の答え | 決めた形 |
| --- | --- | --- |
| Q1 | A | 見出しは `## natsu-v0.10.0 （2026-10-23）`（版の後ろに半角の空白、全角の括弧）。空白はテストで守る（RNF1・`hrn-heading-space`） |
| Q2 | A（`.github/**` の直しと、先に載る小さな窓を受け入れる） | 日付のある節だけを出す。ヘルプは GitHub のリリースが公開された後に出し直す。直すワークフローは下の決めたこと F-18 の形（`release.yml` の公開の段の後に、help-deploy を workflow_dispatch で起こす段を1つ足す）。この計画ではワークフローを動かさない |
| Q3 | A | 記事と同じ枠（パンくず・左の目次・右の「このページの内容」に版の一覧） |
| Q4 | A | 狭い画面で版へ飛ぶ一覧は足さない（見出しだけ） |
| Q5 | A | リリースノートは検索の索引に入れない |
| Q6 | A | 今の8つと同じ作りの新しいアイコン `help/assets/icons/release.svg`。見本（明暗 × カードの大きさ・2倍）をスクラッチパッドの `relnotes-icon/` に作った。**持ち主が見本を OK と言うまで、アイコンは commit しない** |
| Q7 | A | カードは「リリースノート」／「NaTsu の版ごとの変更点（新しい版が上）」／「16 の版」 |
| Q8 | A | 頭の注は下書きの文（ただし R-RN1 で［更新］に直した） |
| Q9 | A | 左の目次の分類の後ろに「リリースノート」の行を1つ足す |

**Ruling R-RN2（変異の記号）:** 変異の id の頭を `rn-` から `hrn-` に変えた（RN-1 を作るときに分かった: `rn-` は 0.9.4 の変異（`rn-secs` など。`IDS_094`）が使っていて、`test/mutate.test.js` の「頭の変異はその一覧にある」の照らしがぶつかる）。

**Ruling R-RN1（言葉をアプリの名前に合わせた）:** 頭の注と計画の文の「アプリの［設定］→［アップデート］」を「アプリの［設定］→［更新］」に直した。アプリの設定の左の列の名前は「更新」（`src/renderer/app.html` の `setNavUpdate`）で、「アップデート」はその中のカードの見出し。リリースノートの文は RF51 の照らしの外だが、注はヘルプの側で書く文なので、画面の言葉に合わせる（調整役の指摘。持ち主には調整役から伝える）。

### 審査の回（2026-10-24。別の審査役の `ca1b0f2` の審査: 中 1・低 4・軽微 1。持ち主の答えは調整役から）

**Ruling R-RN3（A-1・A-2。持ち主の答え A: ヘルプの出し直しの失敗でリリースを赤にしない）:** help-deploy を起こす段を `installer` のジョブから出し、小さなジョブ `help-redeploy` にする。`needs: installer`、`if: success() && (github.event_name != 'workflow_dispatch' || inputs.publish)`（installer が通って公開したときだけ）、ジョブの `continue-on-error: true`、`permissions` は `actions: write` だけ（取り出しも npm も無し）。段は `gh workflow run help-deploy.yml --repo "$GITHUB_REPOSITORY" --ref main` で、失敗したら `::warning::` に「Actions → help-deploy → Run workflow（main）を押す」と出す。`installer` の `permissions` は `contents: write` だけに戻す。これで出し直しが失敗しても、installer の `failure()` の段（「draft のまま」）は走らず、一時ブランチの片付けも飛ばない。RN-6 のテストと変異をこの形に直す。

**Ruling R-RN4（A-3。公開前の確認の形を1か所に）:** 公開前の確認の4つの形を `tools/lib/help-public.js` に1つだけ置き、リリースノート（`help-relnotes.js`）と記事のテスト（`test/help-content.test.js`）の両方から使う。メールは最後が英字の TLD（`electron@44.9.0`・`@anthropic-ai/claude-code@2.0.1` は当たらない）。Windows のパスは大文字小文字を問わず（ドライブ名と Users を小文字で書いた人のパスも止める）、伏せ字の `C:\Users\<名前>\…`・`%…%`・`＜…＞` は通す（`tools/risk.js` と同じ）。

**Ruling R-RN5（A-4。ページの中で id を重ねない）:** 版の節の中の見出しの id には版の id を頭に付ける（`v0-10-0-s1`、`{#x}` は `v0-10-0-x`）。付けた後の id が版の id（`v…`）とぶつかれば作るのを止める。見出しの無い表の名前（表 1）も版ごとに「0.10.0 の表 1」にする。`checkPages` に「1つのページの中で id が重ならない」を足し、重なれば作るのを止める（記事にも効く）。

**Ruling R-RN6（A-5。R-RN1 の続き）:** README（更新の配布の節の2か所）と `release.yml` の頭の注の「[設定] → [アップデート]」を「[設定] → [更新]」に直す。出した版の `CHANGELOG.md` の本文は変えない（RN1）。

**Ruling R-RN7（B-1。持ち主の決定 HD4「48rem 未満で押す場所 44px」）:** 48rem 未満では、左の目次の分類の見出しの行と「リリースノート」の行（`.toc-h a`）も、記事の行と同じく押す場所を 44px にする（目次が少し長くなるのが失うもの）。3回目の指摘 1 の目次の並べ替えとフォーカスの決まりは変えない。写真を撮り直す。

**回の名前:** help-relnotes（ヘルプセンターのリリースノート）— タスク RN-0〜RN-7
**元にした枝:** `lane/help-dads` の `baadb2d`（ヘルプセンターの DADS の直し。別の審査役が審査している最中なので、その枝には commit しない）。作業の枝は `lane/help-relnotes`（worktree `/home/user/Listener-relnotes`）。main と `release/*` には push しない。
**版:** ヘルプセンターはアプリの版とは別に出す（`help/` はアプリに入らない: 設計書 D22・HC0）。だから版は上げない。`CHANGELOG.md` は見出しに日付を足す（中身の文は変えない）。

---

## 目的

NaTsu ヘルプセンターに「リリースノート」のページを1つ足し、各版で何が変わったかをヘルプの中で読めるようにする。中身は `CHANGELOG.md` から、ヘルプを作るときに自動で作る（手で別の文を書かない）。その文は、アプリの［設定］→［更新］に出る文（GitHub のリリース本文）とちょうど同じ。

## 持ち主の決定（2026-10-23。どれも勧めの案）

記号は **RN1〜RN4**（設計書の D の番号・HD の番号とぶつからないよう別の記号にした）。

| 番号 | 問い | 持ち主の答え | この計画での形 |
| --- | --- | --- | --- |
| RN1 | 中身はどこから | ヘルプを作るときに `CHANGELOG.md` から自動で作る。アプリの［設定］→［更新］と同じ文（手で別に書かない） | `tools/help-build.js` が `CHANGELOG.md` を読み、各版の節を help-md（記事と同じ厳しい変換）で HTML にする（決めたこと A・C） |
| RN2 | どこに置くか | 専用のページ1つ「リリースノート」。新しい版が上。ホームの分類のカードの格子に、新しいカードを1つ足して入る | `/release-notes/`。ホームのカードは格子の最後（決めたこと D・E） |
| RN3 | どの版を出すか | natsu-v0.1.0 から今の版まで全部。頭に「古い版には今は無い機能や名前（Groq・ポータブル版など）が出てくる」の短い注 | 16 版（0.1.0〜0.10.0）。頭の注は決めたこと D-2 |
| RN4 | 日付 | 各版に公開日を出す。`CHANGELOG.md` の見出しに日付を足し、過去の 16 版は GitHub のリリースの日付で埋める | 見出しの形は決めたこと B（問い Q1）。過去の日付は調べた結果 7 の表 |

## 方針

1. **中身は1か所（`CHANGELOG.md`）。** ヘルプのページはその写し。ヘルプのために文を書き換えたり足したりしない（RN1）。頭の注（RN3）と日付の出し方だけはヘルプの側で付ける。
2. **変換は記事と同じ help-md（RF52）。** 生の HTML は書けない・文字は全部逃がす・リンクは決まった形だけ。使えない書き方が `CHANGELOG.md` に入ったら、ヘルプを作るのを止める（黙って捨てたり、そのまま出したりしない）。止まったときはファイル名と行を出す。
3. **出していない版は出さない。** 版を上げる commit が main に入ってから、GitHub のリリースが公開されるまでに数時間ある（0.10.0 は版を上げる commit が 10:17 UTC、公開は 12:35 UTC）。その間に、まだ配っていない版をヘルプに出さない（決めたこと F・問い Q2）。
4. **アプリ（`src/`）は変えない。** アプリはリリース本文（`CHANGELOG.md` の節の中身）を GitHub から読んで文字のまま出す（`src/updater.js` の `notes`・`src/renderer/app.html` の `textContent`）。見出しの行は本文に入らないので、見出しに日付を足してもアプリの画面は変わらない。
5. **ヘルプの見た目は DADS の直し（lane/help-dads）のまま。** 色・輪・文字の大きさ（3回目の審査の直しの DADS の段を含む）・44px・`@media (hover: hover)`・強制カラーの決まりを、そのまま当てる。新しい色・新しい書体は足さない。
6. **CSP と出力の決まりは変えない。** `style=`・`on…=`・インラインの script を書かない（HF3・RF52）。`relay/help-gate.mjs` は変えない（新しいページは今の門の後ろにそのまま置ける）。
7. **npm の依存を足さない。** Markdown の変換は今の `tools/lib/help-md.js`。

**使うもの:** Node の `node:test`、今のテストの台（`test/helpers/simcss.js`・`simdom.js`・`help-tmp.js`）、`tools/help-build.js`・`tools/lib/help-md.js`・`tools/lib/help-page.js`・`tools/help-shots.js`・`tools/mutate.js`・`tools/risk.js`。作業環境の Playwright と Chromium（リポジトリの依存ではない）。DADS のスキルの `scripts/audit/audit.sh`（審査役が使う）。

**設計書:** `docs/plans/natsu-design.md` の「利用者が決めたこと（ヘルプセンター。2026-10-20）」の D22、「利用者が決めたこと（ヘルプセンターの DADS の直し。2026-10-23）」の HD1〜HD8、「回をまたぐ決まり」の「ヘルプセンター」（HC0・HC2）と「画面の使いやすさ」、「作り方」。ヘルプの計画 `docs/plans/2026-10-20-help.md`（R7・RF51・RF52・HF3）、DADS の直しの計画 `docs/plans/2026-10-23-help-dads.md`（3回目の審査の直しまで）。

**全体の決まり（設計書からそのまま。この計画に効くもの）:** npm の依存を足さない。公開前の確認（個人名・社名・会社のドメイン・個人のパスを残さない）。日付を推測で埋めない（過去の版の日付は GitHub のリリースの公開の時刻から取る）。設計書を行番号で指さない（見出しと記号で指す）。main への push とリリースは持ち主のはっきりした言葉があるときだけ。

## 持ち主の試作から参考にしたこと（2026-10-17 の試作を読み直した）

読んだもの: 試作の `db-server.js`（179 行）・`state-store.js`（81 行）・`main.js`（37 行）・`preload.js`（36 行）・`README.md`・`package.json`（どれも持ち主が渡したもの。今回の会話の添付で全部を読み直した）。試作の名前と値はそのまま持ち込まない。

1. **版を順に並べ、順が崩れていたら止める**（`db-server.js` の移行は、版の番号の順に1つずつ当て、途中で失敗したら戻して止める。版の番号は1か所で持つ）。→ `CHANGELOG.md` の見出しの版の並びを、作るときに確かめる。版は上から新しい順で、同じ版が2回出ない・番号が下がっていく・日付が上の版より新しくならない。崩れていたら作るのを止め、どの版の見出しかを出す（RN-2 のテスト）。
2. **受けるのは決まった形だけ。知らない形は名前を出して断る**（`db-server.js` の `handlers` と `Object.hasOwn`・「知らない命令」の断り）。→ 見出しの形は「`## natsu-v<版>`」か「`## natsu-v<版> （<日付>）`」の2つだけ。ほかの形（全角の括弧の前の空白が無い・日付の形が違う・`###` の見出し・生の HTML）は作るのを止め、`CHANGELOG.md` の行を出す。本文の書き方も help-md が受ける形だけ（決めたこと C）。
3. **項目ごとに検証器を持ち、外れた所の名前を記録する**（`state-store.js` の `SCHEMA` と、どの項目を戻したかの記録）。→ 版ごとに「見出しの形・日付・本文の変換」を別々に確かめ、止めるときはどの版のどの項目かを出す。ただし試作が外れた値を既定に戻して続けるのと違い、ここでは**止める**。ヘルプは公開するものなので、誤った日付や崩れた文を黙って出すより、CI と help-deploy で止まる方が安全なため（意図した違い）。
4. **起動のたびに必ず初めの値に戻す一時の項目を分けて持つ**（`state-store.js` の `EPHEMERAL`）。→ 「まだ出していない版」を、ふつうの版と分けて扱う（決めたこと F）。日付の無い節は「まだ出していない」とみなし、作るたびにページから外す（残しておかない）。
5. **履歴は足すだけで、前の行を書き換えない**（`db-server.js` の `op_log` と `state_history` は足すだけ）。→ 過去の版の節は、この計画では見出しに日付を足すだけで、本文を書き換えない。GitHub のリリース本文（アプリが読む文）も書き換えない。テストで「16 版の本文が、日付を足す前と1字も変わらない」ことを固める（RN-1）。
6. **書いた後に確かめる**（`db-server.js` の控えは、書いた後に読み取り専用で開いて `quick_check` で確かめる）。→ 作ったページの版の見出しの数が、`CHANGELOG.md` の日付のある節の数とちょうど同じこと、ページの中のリンクと飛び先が全部あること（今の `checkPages`）を、作った後に確かめる。
7. **仲介だけで、中身を持たない・外へ問い合わせない**（`main.js` は口を渡すだけでクエリを中継しない）。→ ヘルプを作るときも、ページを開くときも、GitHub の API を呼ばない。中身はリポジトリの `CHANGELOG.md` だけ（作るのが手元でも CI でも同じ結果。日付も `CHANGELOG.md` に書いたものだけを使う）。
8. **npm の依存を足さない**（試作の `README.md`・`package.json`: 依存は electron だけ）。→ Markdown の変換に新しいライブラリを入れない。
9. **関係しないもの:** SQLite・DB 専用のプロセス・MessagePort・全文検索の trigram・1 秒のまとめ書き・一時ファイルからの名前の替え。ヘルプのサイトは静的で、保存を持たない。

## 調べた結果（`baadb2d`。ファイル:行）

**`CHANGELOG.md` を読んでいるもの（`## natsu-v` で探した）**
1. `.github/workflows/release.yml:163`〜`:185`（「リリース本文を組み立てる」）: `awk` が `$0 ~ "^## +" tag "([ \t]|$)"` の行を見つけ、次の `## ` の行の前までを本文にする。**タグの直後は空白（半角の空白・タブ）か行の終わりでないと当たらない。** 手元で試した: `## natsu-v0.10.0 （2026-10-23）` は本文が取れる。`## natsu-v0.10.0（2026-10-23）`（空白なし）は 0 行になり、本文はタグの注釈か既定の文「NaTsu natsu-v0.10.0」に落ちる（アプリの画面に変更点が出ない）。
2. `test/identity.test.js:90`〜`:93`（見出しは `^## natsu-v\d+\.\d+\.\d+$` だけ）、`:115`〜`:116`（今の版の節 `^## natsu-v<version>$`）、`:119`〜`:121`（先頭の見出しが `## natsu-v<version>` とちょうど同じ）、`:217`・`:240`〜`:241`・`:279`〜`:280`・`:296`〜`:297`（`indexOf('## natsu-v0.x.0')` で節を切る。前の一致なので日付を足しても当たる）、`:387`〜`:388`（`'\n## natsu-v0.9.0\n'` を含むか。日付を足すと当たらなくなる）。
3. `README.md:521`〜`:535`（リリース手順の 2「`CHANGELOG.md` に `## natsu-v0.1.0` の節を足して変更点を書く」）。
4. アプリ: `src/updater.js:299`（`notes: String(data.body || '').slice(0, 4000)`。GitHub のリリース本文）、`src/renderer/app.html:4747`〜`:4748`・`:4810`（`textContent` で文字のまま出す）。**`CHANGELOG.md` を直接は読まない。見出しの行は本文に入らない。**
5. ヘルプの記事の前置きの `sources:` に `CHANGELOG.md` を挙げている記事が6本（summary/how-summaries・settings/appearance・record/pause・record/status-line・find/search・find/delete-and-backups）。照らしの元（RF51 の `appLabelText`）ではない（`tools/lib/help-labels.js` が読むのは `src/` の `.html` と `.js` だけ）。
6. ほかに `## natsu-v` を探すもの: `tools/`・`src/`・ほかのワークフロー・`tools/risk.js` には無い。

**過去の版の日付**
7. 出どころ: **GitHub のリリースの公開の時刻（`published_at`）を日本の日付にしたもの**（`https://api.github.com/repos/Kishi-Satoshi/natsu/releases` を 2026-10-23 に読んだ。持ち主のリポジトリは公開なので認証なしで読める）。タグの commit の時刻（`git log -1 --format=%cI natsu-vX.Y.Z`）とも照らした。タグの commit は公開の 5 分〜2 時間 40 分前で、0.1.0 だけは UTC では前の日（2026-10-16 20:51 UTC＝日本の 10 月 17 日 05:51）。ヘルプの日付は日本の日付で出すので（記事の `updated` と同じ）、公開の時刻を日本の日付にした。古い `v0.8.0`〜`v0.11.3` のリリース（Listener の頃。タグの形が違う）は数えない。

   | 版 | 公開（UTC） | 日本の日付 |
   | --- | --- | --- |
   | natsu-v0.10.0 | 2026-10-23 12:35 | 2026-10-23 |
   | natsu-v0.9.4 | 2026-10-23 02:31 | 2026-10-23 |
   | natsu-v0.9.3 | 2026-10-22 13:42 | 2026-10-22 |
   | natsu-v0.9.2 | 2026-10-21 14:00 | 2026-10-21 |
   | natsu-v0.9.1 | 2026-10-21 05:42 | 2026-10-21 |
   | natsu-v0.9.0 | 2026-10-21 00:07 | 2026-10-21 |
   | natsu-v0.8.0 | 2026-10-20 10:53 | 2026-10-20 |
   | natsu-v0.7.0 | 2026-10-19 13:11 | 2026-10-19 |
   | natsu-v0.6.0 | 2026-10-19 01:32 | 2026-10-19 |
   | natsu-v0.5.0 | 2026-10-18 10:30 | 2026-10-18 |
   | natsu-v0.4.0 | 2026-10-18 07:04 | 2026-10-18 |
   | natsu-v0.3.0 | 2026-10-18 01:07 | 2026-10-18 |
   | natsu-v0.2.0 | 2026-10-18 00:09 | 2026-10-18 |
   | natsu-v0.1.2 | 2026-10-17 03:39 | 2026-10-17 |
   | natsu-v0.1.1 | 2026-10-17 01:41 | 2026-10-17 |
   | natsu-v0.1.0 | 2026-10-16 20:56 | 2026-10-17 |

8. **16 版のリリース本文は、今の `CHANGELOG.md` の節とちょうど同じ**（行末の空白をそろえて比べた。2026-10-23）。だから「アプリに出る文と同じ」（RN1）は、今は成り立っている。違うのは、`release.yml` の入力 `notes` で本文を手で渡したときだけ（今まで使っていない）。

**`CHANGELOG.md` の書き方（help-md で変換できるか）**
9. 使っている書き方: 段落・`- ` の箇条書き・その下の入れ子（`  1.` の番号つきと `  - `）・`**太字**`・`` `コード` ``・［…］・「…」。使っていない書き方: 見出し（`###`）・引用・表・コードの塊・生の HTML・`[文](住所)` のリンク・注意の枠・画像。住所は文の中の文字（`https://claude.ai/install.ps1` など。リンクにはならない）。
10. 今の help-md（`tools/lib/help-md.js` の `renderMarkdown`）で 16 版の節を1つずつ変換して試した: **16 版とも誤りなく変換できる**（入れ子の番号つきの箇条書き・コードの中の `"`・`|`・`%APPDATA%\…` も正しく逃がす）。
11. 公開前の確認: `CHANGELOG.md` には、チームのドメインの字面・64 字の16進・個人の Windows のパス・半角の @ のメールアドレスは無い（中継の住所 `natsu-relay.…workers.dev` は公開の住所で、ヘルプの計画の HC0 にも書いてある）。

**ヘルプを作るところ**
12. `tools/help-build.js:24`〜`:71`（`loadSite`: `site.json` の鍵は `title・askNote・categories・featured` だけ。分類の鍵も決まった5つだけ）、`:170`〜`:181`（`searchIndex`: 記事だけを索引に入れる）、`:183`〜`:221`（`build`: 全部のページを組み立て、`checkPages` で中のリンクを確かめてから書く。`/open` のページは記事ではないので索引・一覧に入れていない）。
13. `tools/lib/help-page.js` の `pageHome`（分類のカードの格子 `.cats`。カードはアイコン・名前・説明・「N 件の記事」）、`pageArticle`（パンくず・属性の帯・本文・左の目次・「このページの内容」（`##` が3つ以上のとき。h2）・関連記事）。
14. `.github/workflows/help-deploy.yml:7`〜`:11`（main への push で `help/**`・`relay/help-gate.mjs` などが変わったときに出す）。**`CHANGELOG.md` は入っていない。** 取り出しは `actions/checkout@v4` の既定（最新の commit だけ・タグなし）。
15. `tools/help-shots.js:22`〜`:24`（撮るのはホーム・record・record/pc-only・start/tester-guide）と `test/help-build.test.js` の R7（`help/shots.json` の `pages` をちょうどこの4つと照らす）。
16. `DADS-PROTECT.md`: 守るものに `help/assets/icons/**`（分類のアイコン。自作の線の SVG）・`relay/**`・`.github/**`・`help/articles/**`。

## 決めたこと（理由つき。違う答えなら直す）

### A. 中身の取り方（RN1）

1. `tools/lib/help-relnotes.js`（新しいファイル）が `CHANGELOG.md` を読み、`## ` の行で節に分ける。頭の説明（最初の `## ` より前）は使わない。
2. 各節の本文を `renderMarkdown`（記事と同じ）で HTML にする。記事の飛び先・資産の照らしは「無い」として渡す（リリースノートから記事へのリンクは書けない。今の `CHANGELOG.md` にも無い）。
3. 本文は1字も足さない・削らない（`release.yml` と同じく前後の空行だけを落とす）。テストで「ページの各版の本文の文字（印を外したもの）が、`release.yml` の `awk` で取った本文と同じ」ことを固める（アプリの画面と同じ文、の守り）。

### B. 見出しの日付の形（RN4。問い Q1）

4. 勧め: **`## natsu-v0.10.0 （2026-10-23）`**（版の後ろに半角の空白、全角の括弧の中に `YYYY-MM-DD`）。
   - `release.yml` の `awk` は、タグの直後が空白なら当たる（調べた結果 1 で試した）。ワークフローを変えなくてよい（`.github/**` は守るもの）。
   - 見出しの行は本文に入らないので、アプリの画面・GitHub のリリース本文は変わらない。
   - `test/identity.test.js` の見出しの形の照らし（`:93`・`:116`・`:121`・`:387`）を、日付の付いた形も通す形に直す（RN-1）。
5. 作るときに受ける見出しの形は2つだけ: `## natsu-v<数>.<数>.<数>`（日付なし＝まだ出していない: 決めたこと F）と、上の日付つき。日付は実在する日（`2026-02-30` は止める）で、上の版より新しくない。ほかの形は止める（参考 2）。
6. `README.md` のリリース手順の 2 を「`CHANGELOG.md` に `## natsu-v<版> （<公開する日>）` の節を足して…」に直す（RN-1）。

### C. Markdown → HTML の安全（RF52）

7. 変換は記事と同じ help-md だけ。生の HTML・`javascript:` などのリンク・閉じていない `**`・`####` から下の見出しなど、help-md が受けない書き方が `CHANGELOG.md` に入ったら、**ヘルプを作るのを止める**（`HelpBuildError`。ファイル名 `CHANGELOG.md` と行を出す）。行は `CHANGELOG.md` の行（節の中の行に、節の頭の行を足して出す）。
8. 止まる場所: 手元の `npm test`（`test/help-*.test.js` が本物の `help/` と `CHANGELOG.md` で作る）・CI・help-deploy の「ヘルプのテスト」。**CI はリリースの前に回るので（`release.yml` が `ci.yml` を呼ぶ）、`CHANGELOG.md` の書き方の誤りはリリースも止める。** 気づくのはリリースの前の `npm test` で、出た後の版の本文は変わらない（参考 5）。
9. 版の節の中の見出し（`##`）は書けない（`## ` は節の区切り）。`###` も使わない（今の `CHANGELOG.md` に無い。help-md は受けるが、ページの見出しの順（h1 → 版の h2 → 節の中の h3）は崩れないので止めはしない）。

### D. ページの形と使いやすさ（RN2・RN3。問い Q3・Q4）

10. 住所は `/release-notes/`。題名「リリースノート」、`<title>` は「リリースノート — NaTsu ヘルプセンター」。`release-notes` は分類の id にも使えない名前として `loadSite` が止める（重なり防ぎ）。
11. 並び（勧め: 問い Q3 の A）: 記事のページと同じ枠（パンくず「ホーム › リリースノート」・左の目次・本文・右の「このページの内容」）。
    - h1「リリースノート」。その下に頭の注（RN3。Q8 の A・R-RN1）:「NaTsu の版ごとの変更点です（新しい版が上）。アプリの［設定］→［更新］に出る文と同じです。古い版の文には、今は無い機能や名前（Groq・ポータブル版 など）が出てきます。今の使い方は各分類の記事を見てください。」（Q8 の A。［更新］は R-RN1）
    - 版ごとに `<section aria-labelledby>` と h2「0.10.0」（`id="v0-10-0"`。記事の見出しの id の形 `[a-z0-9-]{1,40}` に合う）。h2 のすぐ下に公開日 `<p class="relnote-date"><time datetime="2026-10-23">2026 年 10 月 23 日</time></p>`（記事の最終更新日と同じ書き方。色は補足の灰色）。
    - 右の「このページの内容」に全部の版（16）を並べる。今の「このページの内容」は高さの上限が無いので、版が増えても切れないよう、左の目次と同じ決まり（`max-height`・`overflow-y: auto`・内の余白 6px と外へ戻す・`scroll-padding-block`。DF4 と3回目の指摘の学び）を当てる。広い画面（1100px より広い）だけに出るのは今のまま。
    - 狭い画面（1100px 以下）では右の列が無いので、版を飛ぶ手段は見出しだけ（問い Q4）。
    - 左の目次には分類の後ろに「リリースノート」の行を1つ足す（このページでは `aria-current="page"`）。狭い画面の［目次］と、3回目の指摘 1 の並びの直し（site.js が目次を［目次］の直後へ動かす）はそのまま効く。
12. 文字の大きさ・色・輪・下線・44px は DADS の直しのまま。新しい規則は「公開日の行」（`.relnote-date`: `.875rem`・`var(--muted)`）と「このページの内容」の高さの上限だけ。どちらも札を通す（色の一覧の照らしがそのまま効く）。
13. 見出しの順: h1 が1つ、版は h2、節の中に `###` があれば h3（飛ばない）。「このページの内容」の h2 は aside の中（今のまま）。
14. 検索（Q5 の A）: `search-index.json` に入れない。テストで「索引にリリースノートの版が1つも無い」ことを固める（`hrn-no-search`）。

### E. ホームのカード（RN2。問い Q6・Q7）

15. ホームの分類の格子の最後に、カードを1つ足す: 名前「リリースノート」、説明「NaTsu の版ごとの変更点（新しい版が上）」、件数の行は「16 の版」（版の数は作るときに数える）。リンク先は `/release-notes/`。
16. `site.json` に `releaseNotes: { title, description, icon }` の鍵を1つ足す（分類ではないので `categories` に入れない。`loadSite` の決まった鍵の照らしを、この鍵だけ足して直す）。無ければページもカードも作らない（テスト用の小さな `site.json` は今のまま通る）。
17. アイコン（Q6 の A）: `help/assets/icons/**` は `DADS-PROTECT.md` の守るもの。今の8つと同じ作り（`viewBox="0 0 24 24"`・`fill="none"`・`stroke="currentColor"`・線 1.5・丸い端と角・`aria-hidden="true"`・`focusable="false"`・`script` も外の住所も無い）の新しい `help/assets/icons/release.svg` を1つ足す（今の8つは変えない）。形は「札（タグ）に横線2本と、札の穴の丸」（版の札＝リリースの印）。見本はスクラッチパッドの `relnotes-icon/`（明暗 × カードの大きさ 20px・2倍の 40px、ほかの8つと並べたもの）。**持ち主が見本を OK と言うまで commit しない。** 違う形がよければ、見本を作り直す。

### F. まだ出していない版（問い Q2）

18. Q2 の A: **日付のある節だけを出す。** 日付（公開する日）は、今のリリースの手順どおり版を上げる commit で見出しに書く。help-deploy は `CHANGELOG.md` の変化では走らせない（`paths` に入れない）。**GitHub のリリースが公開された後に、help-deploy を起こす。**
    - **直すワークフロー（提案。RN-6 で作る。`.github/**` は守るもの・持ち主が Q2 で受け入れた）:** `.github/workflows/release.yml` の `installer` のジョブの「公開する（draft を解いて latest にする）」の段の**後ろ**に、同じ `if`（`github.event_name != 'workflow_dispatch' || inputs.publish`）を付けた段を1つ足す: `gh workflow run help-deploy.yml --repo "$GITHUB_REPOSITORY" --ref main`（`GH_TOKEN: ${{ github.token }}`）。`installer` のジョブの `permissions` に `actions: write` を足す（workflow_dispatch を起こすのに要る。ほかの権限は今のまま）。`help-deploy.yml` は変えない（`workflow_dispatch` はもうある。`paths` に `CHANGELOG.md` を足さない）。
    - この形にした理由: (1) `gh release edit --draft=false` は `GITHUB_TOKEN` で行うので、help-deploy に `release: published` の引き金を足しても起きない（`GITHUB_TOKEN` が起こした事象は、`workflow_dispatch` と `repository_dispatch` のほかは新しい run を作らない）。(2) help-deploy に `workflow_run`（release の完了）を足す形は、Run workflow で publish を外して下書きのまま止めたときにも走り、まだ出していない版を載せてしまう。公開の段と同じ `if` の段から起こせば、公開したときだけ走る。(3) help-deploy は main の最新を取り出して作るので、版を上げた commit（日付つきの見出し）がそのまま載る。help-deploy の環境 `relay` は main だけ（`--ref main`）。
    - 起きる順: 版を上げる commit を main に入れる（help-deploy は走らない）→ `release/natsu-v<版>` を push → `release.yml` の CI・draft・exe の添付・公開 → 公開の直後の段が help-deploy を起こす → ヘルプに新しい版が載る。
    - テスト（RN-6）: `release.yml` の `installer` のジョブで、help-deploy を起こす段が公開の段の後ろにあり、`if` が公開の段と同じで、`--ref main`。ジョブの `permissions` に `actions: write`。`help-deploy.yml` の `paths` に `CHANGELOG.md` が無い（`test/helpers/yml.js` で読む字面のテスト）。この計画ではワークフローを動かさない（Run workflow も押さない）。
    - 失うもの（持ち主が受け入れた）: 版を上げる commit から公開までの数時間に、別の `help/**` の直しが main に入ると、その時点で新しい版が先に載る。リリースが日をまたいで遅れたら、日付を直す commit が要る。`CHANGELOG.md` の文だけを直したとき（リリースなし）は、次にヘルプが出るまで（ほかの直しか Run workflow）ヘルプに載らない。
19. ヘルプを作るときは時計を見ない（同じ元なら同じバイト: 今の H-3 のテスト）。「未来の日付は出さない」は時計で決めず、F の 18 の流れで決める。

### G. RF51（記事とアプリの言葉の照らし）

20. **リリースノートには RF51 を当てない。** 古い版は、今は無いボタンの名前（［この会議は PC の中だけ］・Groq の鍵の欄など）をそのまま書いている。書き換えないのが RN1 の決まりなので、照らすと必ず赤になる。照らしの元（`help-labels.js`）は `help/articles/**` だけを読むので、今のままで当たらない。テストで「リリースノートの文は照らしの対象に入らない」ことを固め（間違って入れると全部赤になるのを防ぐ）、頭の注（RN3）で読む人に知らせる。
21. 公開前の確認（チームのドメイン・64 字の16進・個人のパス・メールアドレス）は `CHANGELOG.md` にも当てる（ヘルプに出るものになるため）。記事は `test/help-content.test.js` とゲート（`tools/risk.js`）が見ているが、`CHANGELOG.md` はどちらも見ていないので、**ヘルプを作るとき（`help-relnotes.js`）に同じ形を照らし、当たれば止める**（RN-5。テストは写しに字面を入れて止まること）。

### H. 写真と出し方

22. `tools/help-shots.js` の撮るページに `/release-notes/` を足す（4 → 5 ページ × 明暗 × 1280・390。`help/shots.json` の `pages` と R7 のテストも直す）。
23. 出し方: この枝は `lane/help-dads` の上に作った。`lane/help-dads` が審査の直しで進んだら、この枝へ merge する（merge の commit。rebase・force-push はしない）。main へは、持ち主が見比べの紙を見て、はっきり「main に入れてよい」と言ったときに、`lane/help-dads` と一緒に1回で入れる（`lane/help-relnotes` を merge すれば両方入る）。main に入ると help-deploy がすぐヘルプを出し直す。

## Review Focus（テストの無い、起きそうな失敗。どれもこの計画のタスクでテストを持つ）

| 記号 | 起きそうな失敗 | 防ぎ方（テスト） | タスク |
| --- | --- | --- | --- |
| RNF1 | **見出しに日付を足したら、リリース本文が取れなくなる**（`release.yml` の `awk` は空白の無い全角の括弧で当たらない。アプリの画面に変更点が出ず「NaTsu natsu-v…」だけになる） | `release.yml` の本文の取り方の `awk` を、テストの中で `CHANGELOG.md` の全部の版に当て、16 版とも本文が取れて GitHub に出た本文と同じ長さ（行の数）であること。見出しの形の照らし（全角の括弧の前に半角の空白） | RN-1 |
| RNF2 | **まだ出していない版がヘルプに出る**（版を上げる commit が main に入った時点で載る） | 日付の無い節はページに出ない（simdom で数える）。help-deploy の `paths` に `CHANGELOG.md` が無く、リリースの後に走る形（ワークフローの字面のテスト） | RN-2・RN-6 |
| RNF3 | **`CHANGELOG.md` の書き方で、ヘルプに生の HTML や危ないリンクが出る** | 生の HTML・`javascript:` のリンク・閉じていない `**` を入れた写しで、作るのが `HelpBuildError` で止まり、行が `CHANGELOG.md` の行。出力の HTML に `style=`・`on…=`・`<script` が無い（今の HF3 の照らしをリリースノートにも当てる） | RN-2 |
| RNF4 | **ヘルプの文がアプリの文とずれる**（ヘルプの側で文を足す・削る・並べ替える） | ページの各版の本文の文字が `awk` で取った本文と同じ。版の数・並びが `CHANGELOG.md` の日付のある節と同じ | RN-2 |
| RNF5 | **版が増えると「このページの内容」が窓より高くなり、下の版に行けない・輪が切れる** | 「このページの内容」の高さの上限・送れる・内の余白 6px・`scroll-padding-block`（CSS の照らし）。見比べの紙で 30 版の見本も撮る | RN-4 |

## ファイルの地図

| ファイル | 変えること | タスク |
| --- | --- | --- |
| `CHANGELOG.md` | 16 版の見出しに日付（本文は変えない）。頭の説明の見出しの例 | RN-1 |
| `test/identity.test.js` | 見出しの形の照らし（日付つき）・本文が変わらないこと・`awk` で本文が取れること | RN-1 |
| `README.md` | リリース手順の 2 | RN-1 |
| `tools/lib/help-relnotes.js`（新） | `CHANGELOG.md` を節に分け、形を確かめ、help-md で変換する | RN-2 |
| `tools/help-build.js` | `site.json` の `releaseNotes` の鍵・リリースノートのページ・（Q5 が B なら）索引 | RN-2・RN-3 |
| `tools/lib/help-page.js` | `pageRelnotes`・ホームのカード・左の目次の行 | RN-3 |
| `help/site.json` | `releaseNotes` | RN-3 |
| `help/assets/icons/release.svg`（新。Q6 が A のとき） | 線のアイコン | RN-3 |
| `help/assets/help.css` | `.relnote-date`・「このページの内容」の高さの上限 | RN-4 |
| `test/help-relnotes.test.js`（新） | 節の分け方・見出しの形・日付・並び・変換の止め方・まだ出していない版・ページの形 | RN-2〜RN-4 |
| `test/help-build.test.js`・`test/help-site.test.js`・`test/help-search.test.js` | ホームのカード・`site.json` の形・索引（Q5） | RN-3 |
| `test/help-content.test.js` | RF51 の照らしにリリースノートが入らないこと | RN-5 |
| `.github/workflows/help-deploy.yml`・`.github/workflows/release.yml`（Q2 が A のとき。守るもの） | リリースの後にヘルプを出し直す | RN-6 |
| `tools/help-shots.js`・`help/shots.json` | 撮るページに `/release-notes/` | RN-7 |
| `tools/mutants.js`・`test/mutate.test.js` | `hrn-*` の変異と `IDS_HELP_RELNOTES`（この計画の「変異確認」の表とちょうど同じ） | 各タスク |
| `docs/plans/natsu-design.md` | 「利用者が決めたこと（ヘルプセンターのリリースノート。2026-10-23）」の RN1〜RN4、HC0 に一言 | RN-0 |

## タスク（どれも落ちるテストから。各 commit の前に `npm test` が `# fail 0`・`# skipped 0`、`node tools/risk.js --staged` が `BLOCK 0`。push は `lane/help-relnotes` へ早送りで、CI が Linux と Windows で緑）

5手: ①落ちるテストを書く → ②正しい理由で落ちるのを見る → ③最小の直し → ④通るのを見る → ⑤commit（平易な日本語のメッセージ）。変異はタスクごとに `tools/mutants.js` と下の表と `IDS_HELP_RELNOTES` に足し、`node tools/mutate.js --only …` で殺されるのを見る。

- **RN-0（設計書）:** 設計書に RN1〜RN4 と、問答の答えを書く。HC0 に「リリースノートのページ（`CHANGELOG.md` から作る）」を一言。テスト: 設計書に RN1〜RN4 の行があること（字面）。
- **RN-1（RN4・RNF1）:** `test/identity.test.js` を、日付つきの見出しを通し、日付の形・実在の日・新しい順を確かめる形に直す。`release.yml` の `awk` をテストの中で 16 版に当て、本文が取れることと、日付を足す前の本文と1字も変わらないこと（足す前の本文の SHA-256 を版ごとに base64url でテストに書く。16進の 64 字はゲートが AUD の見かけとして止めるため）。②今の見出しには日付が無いので赤 → ③16 版の見出しに日付（調べた結果 7 の表）・README → ④緑。
- **RN-2（RN1・RNF2〜RNF4）:** `tools/lib/help-relnotes.js` の節の分け方と形の照らし（決めたこと A・B-5・C・F）。テストは本物の `CHANGELOG.md` と、崩した写し（順の逆・同じ版・日付の形・空白の無い括弧・生の HTML・`javascript:`）。
- **RN-3（RN2・RN3）:** ページとホームのカードと左の目次の行。`site.json` の `releaseNotes`。アイコン（Q6）。索引（Q5）。テストは simdom で h1・注・版の h2 と id・公開日の `time`・並び・カードのリンクと件数・目次の `aria-current`。
- **RN-4（RNF5）:** CSS（公開日の行・「このページの内容」の高さの上限と送れる箱の決まり）。help-shots.js で `help/shots.json` を書き直す（R7 の Ruling は help-dads と同じ）。
- **RN-5（G）:** 作るときの公開前の確認（`CHANGELOG.md`）。RF51 の照らしに入らないことのテスト。
- **RN-6（F。Q2 が A のとき）:** help-deploy をリリースの後にも走らせ、`CHANGELOG.md` を `paths` に入れない。テストはワークフローの字面（`test/helpers/yml.js` で読む）。
- **RN-7:** 写真（help-shots.js の5ページ）と、見比べの紙と、別の審査役の審査。

## 変異確認（直しを1つ戻すと、どのテストが赤になるか。作るタスクで `tools/mutants.js` と `IDS_HELP_RELNOTES` に移す）

| id | 当てるファイル | 戻す直し | 赤になるテスト |
| --- | --- | --- | --- |
| hrn-heading-space | `CHANGELOG.md` | 0.10.0 の見出しの全角の括弧の前の空白を消す（`release.yml` が本文を取れない） | `test/identity.test.js` |
| hrn-body-same | `CHANGELOG.md` | 過去の版の本文の1字を変える（出た本文と食い違う） | `test/identity.test.js` |
| hrn-order | `tools/lib/help-relnotes.js` | 版の並びの照らしを外す | `test/help-relnotes.test.js` |
| hrn-date-real | `tools/lib/help-relnotes.js` | 実在の日の照らしを外す（`2026-02-30` を通す） | `test/help-relnotes.test.js` |
| hrn-undated | `tools/lib/help-relnotes.js` | 日付の無い節（まだ出していない版）も出す | `test/help-relnotes.test.js` |
| hrn-render | `tools/lib/help-relnotes.js` | 本文を help-md でなく逃がしだけで出す（Markdown の誤りで止まらない） | `test/help-relnotes.test.js` |
| hrn-line | `tools/lib/help-relnotes.js` | 止めたときの行を節の中の行のまま出す（`CHANGELOG.md` の行でない） | `test/help-relnotes.test.js` |
| hrn-page-date | `tools/lib/help-page.js` | 版の h2 の下の公開日を出さない | `test/help-relnotes.test.js` |
| hrn-home-card | `tools/lib/help-page.js` | ホームのリリースノートのカードを出さない | `test/help-build.test.js` |
| hrn-onpage-scroll | `help/assets/help.css` | 「このページの内容」の高さの上限を消す | `test/help-build.test.js` |
| hrn-no-labels | `tools/lib/help-labels.js` | 照らしの元に `CHANGELOG.md` を混ぜる | `test/help-content.test.js` |
| hrn-public-check | `tools/lib/help-relnotes.js` | 作るときの公開前の確認を外す（`CHANGELOG.md` に会社のドメインや 64 字の16進が入ってもヘルプに出る） | `test/help-relnotes.test.js` |
| hrn-no-search | `tools/help-build.js` | 索引にリリースノートの版を入れる（Q5 の A に反する） | `test/help-search.test.js` |
| hrn-deploy-after-release | `.github/workflows/release.yml` | 公開の後に help-deploy を起こす段を消す（ヘルプに新しい版が載らない） | `test/help-relnotes.test.js` |
| hrn-deploy-paths | `.github/workflows/help-deploy.yml` | `paths` に `CHANGELOG.md` を足す（版を上げた時点で、公開の前にヘルプに載る） | `test/help-relnotes.test.js` |
| hrn-toc-row | `tools/lib/help-page.js` | 左の目次の「リリースノート」の行を出さない（Q9 の A） | `test/help-relnotes.test.js` |
| hrn-redeploy-continue | `.github/workflows/release.yml` | help-redeploy のジョブの continue-on-error を消す（出し直しの失敗でリリースが赤になる。R-RN3） | `test/help-relnotes.test.js` |
| hrn-redeploy-if | `.github/workflows/release.yml` | help-redeploy の if を always() にする（公開しないときにも出し直す。R-RN3） | `test/help-relnotes.test.js` |
| hrn-installer-actions | `.github/workflows/release.yml` | installer の権限に actions: write を戻す（A-2。R-RN3） | `test/help-relnotes.test.js` |
| hrn-email-tld | `tools/lib/help-public.js` | メールの形の TLD を英字に限らない（electron@44.9.0 で止まる。R-RN4） | `test/help-relnotes.test.js` |
| hrn-path-case | `tools/lib/help-public.js` | Windows のパスの形の大文字小文字を区別する（c:\users\… が通る。R-RN4） | `test/help-relnotes.test.js` |
| hrn-path-placeholder | `tools/lib/help-public.js` | 伏せ字のパス（<名前>・%…%・＜…＞）も止める（R-RN4） | `test/help-relnotes.test.js` |
| hrn-id-prefix | `tools/lib/help-relnotes.js` | 版の節の見出しの id に版の id を付けない（ページの中で s1 が重なる。R-RN5） | `test/help-relnotes.test.js` |
| hrn-table-prefix | `tools/lib/help-relnotes.js` | 見出しの無い表の名前に版を付けない（「表 1」が重なる。R-RN5） | `test/help-relnotes.test.js` |
| hrn-dup-id | `tools/help-build.js` | checkPages の「ページの中で id が重ならない」を外す（R-RN5） | `test/help-build.test.js` |
| hrn-toc-h-44 | `help/assets/help.css` | 48rem 未満の .toc-h a の 44px を消す（R-RN7。CSS なので pattern B-1） | `test/help-build.test.js` |

（表と `IDS_HELP_RELNOTES` はちょうど同じにし、`test/mutate.test.js` が照らす: help-dads の `IDS_HELP_DADS` と同じ形。）

## ゲート

- 各 commit の前: `npm test` が `# fail 0`・`# skipped 0`、`node tools/risk.js --staged` が `BLOCK 0`。
- `lane/help-relnotes` に push して、CI（Linux と Windows）が緑。
- アプリ（`src/`）・`tools/shots` の基準の画像・`overlay.html` の差分は 0。版は上げない。
- 変異確認: 表の全部が決めたテストで赤、戻せば緑。
- 別の審査役の審査（DADS のスキルの審査役。作り手は自分で合格と言わない）: 致命的 0・重要 0 が目安。審査の道具（`audit.sh`）は CSP の下で動かないので、CSP の見出しだけを外した同じサイトに当て、CSP は門と同じ見出しのサイトで別に確かめる（help-dads の記録と同じ）。
- main への merge は、持ち主が見比べの紙を見て、はっきり「main に入れてよい」と言ったときだけ（`lane/help-dads` と一緒）。merge するとすぐ help-deploy がヘルプを出し直す。

## 見比べの紙（前と後）

- 前＝`lane/help-dads` の先（リリースノートの無いヘルプ）、後＝この枝の先。同じ道具・同じ時に手元で作り、門と同じ見出し（CSP あり）で出して撮る。
- 載せるもの: ホーム（カードが1つ増える）・リリースノートのページ（明暗 × 1280・375・320、ページ全体）・「このページの内容」（1280）・左の目次の新しい行・狭い画面の［目次］・Tab で版の見出しの間を進む様子・強制カラー・文字 200%。30 版の見本（`CHANGELOG.md` の写しを増やしたもの）で「このページの内容」が送れること。
- アプリの［設定］→［更新］の文と、ページの各版の文が同じであることの照らしの表（16 版、`awk` で取った本文と、ページの本文の文字の長さ）。
- 写真は commit しない（help-dads の Q13 と同じ）。紙はスクラッチパッドの `review-relnotes/`。

## 実機で見てもらうこと（main に入って help-deploy が出した後）

1. 会社の PC でヘルプのホームを開き、「リリースノート」のカードから入れるか。新しい版が上か。日付が合っているか。
2. 0.10.0 の文が、アプリの［設定］→［更新］に出る文と同じか。
3. 次のリリースのとき、公開の前にヘルプに新しい版が出ていないか（Q2 の形どおりか）。

## 自己点検（writing-plans の5項目。2026-10-23）

1. **持ち主の決定を覆っているか:** RN1（決めたこと A・RN-2 の本文の照らし）・RN2（D・E・RN-3）・RN3（D の注・16 版）・RN4（B・調べた結果 7・RN-1）。
2. **手順の抜け:** 見出しの形を変える前に `release.yml` の取り方を試した（調べた結果 1）。`identity.test.js` と `README.md` の直し。まだ出していない版（F）。アイコンは守るもの（Q6）。`.github/**` も守るもの（Q2）。写真の R7。help-dads と一緒に出す順（H-23）。
3. **名前と形の食い違い:** 住所 `/release-notes/`・`site.json` の鍵 `releaseNotes`・版の id `v0-10-0`・クラス `.relnote-date`・変異 `hrn-*`・`IDS_HELP_RELNOTES`・決定 RN1〜RN4・Review Focus RNF1〜RNF5（ほかの計画の D・HD・RF・DF と重ならない）。
4. **Review Focus:** RNF1〜RNF5 のどれもテストを持つタスクと変異の行がある（RNF1: hrn-heading-space・hrn-body-same、RNF2: hrn-undated、RNF3: hrn-render・hrn-line、RNF4: hrn-order・hrn-page-date、RNF5: hrn-onpage-scroll）。
5. **大きさの釣り合い:** 新しいファイル2つ（`help-relnotes.js` とそのテスト）、`help-build.js`・`help-page.js` に数十行、CSS に数行、`CHANGELOG.md` は 16 行。ワークフローの直し（Q2）が一番の外への影響。

**まだ確かめていないこと:** 版が 30 を越えたときのページの重さ（今は本文 約 2 万字。問題になる大きさではない見込み）。Safari・Mac は見られない（ほかと同じ）。

## 作り手が決めたこと（持ち主に聞かずに決めた。違えば直す）

- 過去の日付の出どころは GitHub のリリースの公開の時刻（`published_at`）を日本の日付にしたもの（タグの commit の時刻ではない。0.1.0 で日付が違う）。
- 住所 `/release-notes/`、題名「リリースノート」、版の見出しは「0.10.0」（`natsu-v` を付けない。アプリの画面の版の書き方と同じ）、公開日は「2026 年 10 月 23 日」（記事の最終更新日と同じ書き方）。
- ページの枠は記事と同じ（パンくず・左の目次・右の「このページの内容」）。ページの区切りは版ごとの `section`。
- 頭の説明の節（`# 変更履歴` と最初の `## ` の前の文）はページに出さない（リポジトリの読み方の説明なので）。
- 本文から記事へのリンクは書けない（今の `CHANGELOG.md` にも無い）。
- RF51 は当てない・公開前の確認は当てる（決めたこと G）。
- 写真の組に `/release-notes/` を足す（R7）。
- 新しい色・書体・JS は足さない（「このページの内容」の高さの上限は CSS だけ）。

## 利用者に確かめること（選択式。先頭が勧め。答えが来るまでは勧めの案で計画を書いてある）

**2026-10-23: Q1〜Q9 は全部 A で答えが出た（上の「問答の答え（2026-10-23）」）。下は問いの記録として残す。**

**大事なもの**

- **Q1 見出しの日付の形**
  - A（勧め）**`## natsu-v0.10.0 （2026-10-23）`**（版の後ろに半角の空白、全角の括弧）。理由: `release.yml` を変えずに本文が取れる（試した）。見出しの行は本文に入らないので、アプリの画面と GitHub のリリース本文は変わらない。GitHub で `CHANGELOG.md` を見ても版の横に日付が出る。失うもの: 全角の括弧の前に半角の空白という、日本語の書き方としては少し変わった形。空白を消すとリリース本文が取れなくなる（テストで止める）。
  - B 見出しは今のまま、その下の行に `公開日: 2026-10-23`。失うもの: その行がリリース本文に入り、アプリの［設定］→［更新］の文の頭に「公開日: …」が出る（過去の 16 版は GitHub の本文と食い違う）。
  - C `## natsu-v0.10.0（2026-10-23）`（空白なし）にし、`release.yml` の `awk` を直す。失うもの: リリースのワークフロー（`.github/**`。守るもの）を直す。直し忘れるとリリースの本文が空になる。
- **Q2 まだ出していない版を出さない方法**
  - A（勧め）**版を上げる commit で見出しに「公開する日」を書く。help-deploy は `CHANGELOG.md` の変化では走らせず、リリースが公開された後に走らせる**（`release.yml` の最後の段か、help-deploy の `workflow_run`）。日付の無い節は出さない。理由: リリースの手順は今のまま（main への push は増えない）で、ふつうは公開の後にだけ新しい版が載る。失うもの: `.github/**`（守るもの）を直す。版を上げてから公開までの数時間に、別のヘルプの直しが main に入ると、その時点で新しい版が先に載る。リリースが日をまたいだら日付を直す commit が要る。
  - B リリースが公開された後に、日付を足す commit を main に入れる（日付の無い節は出さない）。理由: 先に載ることが無い。失うもの: リリースのたびに main への push が1回増える（持ち主のはっきりした言葉が要る）。忘れると新しい版がヘルプに出ないまま。
  - C help-deploy がタグ（`natsu-v<版>`）のある版だけを出す（取り出しでタグも取る）。理由: いちばん確か。失うもの: ワークフローとヘルプを作る道具の両方を直し、手元でヘルプを作るときもタグが要る。下書きのリリースの間にタグができるかは確かめていない。
- **Q5 リリースノートを検索に入れるか**
  - A（勧め）**入れない。** 理由: 古い版の文には今は無い名前（Groq・ポータブル版・［この会議は PC の中だけ］）があり、今の言葉で探した人に古い版が出て迷わせる。検索は「使い方の記事」を探すためのもの。リリースノートはホームのカードと左の目次から入れ、ページの中はブラウザの検索（Ctrl＋F）で探せる。失うもの: 「0.9.3 で何が変わった」を検索の箱からは探せない。
  - B 版ごとに1件として入れ、点は記事より低くする（記事が先に出る）。失うもの: 古い名前で探すと古い版が出る（記事が無い言葉では、古い版だけが出る）。
  - C ページ全体を1件として入れる。失うもの: どの版に書いてあるか分からない。
- **Q6 ホームのカードのアイコン**（`help/assets/icons/**` は守るもの）
  - A（勧め）**今の8つと同じ作りの線のアイコンを1つ新しく足す**（`release.svg`。今の8つは変えない。形は見本で見せてから決める）。失うもの: 守るフォルダにファイルが1つ増える。
  - B アイコン無しのカード。失うもの: 格子の中でこのカードだけ形が違う。
  - C 今のアイコン（例: はじめにの旗）を使い回す。失うもの: 同じアイコンが2つになり、分類と見分けにくい。

**小さいもの**

- **Q3 ページの枠**: A（勧め）**記事と同じ枠**（パンくず・左の目次・右の「このページの内容」に版の一覧）。理由: ほかのページと同じ動きで迷わない。失うもの: 本文の幅が記事と同じ約 720px。／B `/open` や 404 のような1段のページ（左の目次なし。頭に版の一覧のリンク）。失うもの: 左の目次でほかの記事へ移れない。
- **Q4 狭い画面で版へ飛ぶ手段**: A（勧め）**見出しだけ（足さない）**。理由: 1100px 以下は右の列が無いのは記事と同じ。新しい版が上なので、たいていは上を読むだけ。失うもの: 古い版へは長く送る。／B 頭に版の一覧（リンク 16 個）を足す。失うもの: ページの頭が長くなり、1280px では右の列と同じものが2つ出る。
- **Q7 カードの言葉**: A（勧め）名前「リリースノート」、説明「NaTsu の版ごとの変更点（新しい版が上）」、件数「16 の版」。／B 件数の行を出さない。／C 言葉を教えてもらう。
- **Q8 頭の注の文**（決めたこと D-11 の文）: A（勧め）この文で置く。／B 足す・削る所を教えてもらう。
- **Q9 左の目次の行**: A（勧め）分類の後ろに「リリースノート」の行を1つ足す。失うもの: 目次が1行長くなる。／B 足さない（ホームのカードからだけ入る）。失うもの: 記事のページからリリースノートへ1回で行けない。

## 大きさ

RN-0〜RN-7。中心は RN-2・RN-3（新しいファイル2つと、ページの組み立て）。`CHANGELOG.md` は 16 行の見出しの直しだけ。ワークフローの直し（Q2 の A）は小さいが、守るものなので持ち主の答えの後に作る。
