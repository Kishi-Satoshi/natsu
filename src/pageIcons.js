'use strict';
// ページのアイコン（0.17.0 IG-1。計画 docs/plans/2026-11-13-170.md の決めたこと 1・2・10・26 と付録の表）。純粋な部品で、画面にも写す。
// 値の形は 'ic:<名前>'（名前は元の絵のファイルの名前）。出どころ（デジタル庁か Material Symbols か）は値に入れず、この表に持つ。
// 名前（n）とよみ（y）は NaTsu が書いたもの（持ち主が 2026-11-14 に IQ13 で承認した付録の表のまま）。絵（path）は tools/page-icons.js が
// assets/page-icons/ の元の SVG から src/pageIconPaths.js に書く（手で直さない）。

// 選びの窓の分類（並びはこの順。10 個目の「矢印と操作」は IQ4 の答えで足した）
const ICON_CATS = Object.freeze([
  { key: 'doc', label: '書類と仕事' },
  { key: 'people', label: '人と会議' },
  { key: 'time', label: '予定と時間' },
  { key: 'chart', label: 'グラフと分析' },
  { key: 'money', label: 'お金と買い物' },
  { key: 'sign', label: '知らせと印' },
  { key: 'tool', label: '道具と機器' },
  { key: 'place', label: '場所と移動' },
  { key: 'life', label: '自然と暮らし' },
  { key: 'arrow', label: '矢印と操作' },
].map((c) => Object.freeze(c)));

// デジタル庁の「イラストレーション・アイコン素材」の線の絵（60。assets/page-icons/dg/<名前>_line.svg）。1行は「名前 日本語の名前 よみ」
const DG = {
  doc: `
certification_with_seal 書類 しょるい
application チェックした書類 ちぇっくしたしょるい
documents フォルダ ふぉるだ
fillable_card 記入 きにゅう
invoice 請求書 せいきゅうしょ
work 仕事 しごと
laws きまり きまり
stamp はんこ はんこ
certification 名札 なふだ
e_application 電子申請 でんししんせい
seal_certificate 証明書 しょうめいしょ
privacy_protection 個人情報 こじんじょうほう
`,
  people: `
me 人 ひと
family 人たち ひとたち
specialist 学ぶ人 まなぶひと
child 子ども こども
mother_and_child 親子 おやこ
fast_track 急ぐ人 いそぐひと
`,
  time: `
history 履歴 りれき
`,
  money: `
money お金 おかね
bank_account 口座 こうざ
income 収入 しゅうにゅう
expenditure 支出 ししゅつ
tax 税金 ぜいきん
pension 年金 ねんきん
`,
  sign: `
attention 注意 ちゅうい
complete 完了 かんりょう
help はてな はてな
information お知らせ おしらせ
notification ベル べる
public_offering 旗 はた
health ハート はーと
authentication 守り まもり
password パスワード ぱすわーど
transactions やりとり やりとり
`,
  tool: `
personal_computer パソコン ぱそこん
smartphone スマホ すまほ
printer プリンター ぷりんたー
inbox メール めーる
code_reader 二次元コード にじげんこーど
mailing 郵便受け ゆうびんうけ
`,
  place: `
house 家 いえ
itinerary 飛行機 ひこうき
municipality 役所 やくしょ
arrival 到着 とうちゃく
departure 出発 しゅっぱつ
luggage 荷物 にもつ
`,
  life: `
immunization 予防接種 よぼうせっしゅ
medicine 薬 くすり
`,
  arrow: `
add 足す たす
arrow_up 上向きの矢印 うわむきのやじるし
arrow_down 下向きの矢印 したむきのやじるし
arrow_left 左向きの矢印 ひだりむきのやじるし
arrow_right 右向きの矢印 みぎむきのやじるし
copy 写し うつし
download ダウンロード だうんろーど
menu メニュー めにゅー
new_window 新しい窓 あたらしいまど
search 虫めがね むしめがね
update 更新 こうしん
`,
};

// Material Symbols（Outlined・線の太さ 300）の絵（127。assets/page-icons/ms/<名前>_wght300_24px.svg）。デジタル庁に無い絵を補う
const MS = {
  doc: `
draft 白紙 はくし
article 記事 きじ
note_stack メモの束 めものたば
sticky_note_2 付せん ふせん
edit_note 書き込み かきこみ
checklist やること やること
task_alt 済み すみ
assignment 課題 かだい
inventory_2 箱 はこ
table_chart 表 ひょう
database データベース でーたべーす
view_kanban かんばん かんばん
format_list_bulleted 箇条書き かじょうがき
summarize まとめ まとめ
menu_book 開いた本 ひらいたほん
book 本 ほん
bookmark しおり しおり
label 札 ふだ
sell 値札 ねふだ
push_pin 画びょう がびょう
attach_file クリップ くりっぷ
link リンク りんく
translate 翻訳 ほんやく
dashboard ダッシュボード だっしゅぼーど
category 分類 ぶんるい
widgets 部品 ぶひん
extension 拡張 かくちょう
work_history 職歴 しょくれき
home_work 在宅勤務 ざいたくきんむ
quiz 問題 もんだい
feedback ご意見 ごいけん
`,
  people: `
mic マイク まいく
record_voice_over 話す人 はなすひと
groups 集まり あつまり
group 二人 ふたり
diversity_3 チーム ちーむ
handshake 握手 あくしゅ
forum 話し合い はなしあい
chat 吹き出し ふきだし
co_present 発表 はっぴょう
school 学校 がっこう
support_agent 窓口 まどぐち
badge 社員証 しゃいんしょう
waving_hand 手を振る てをふる
psychology 考える かんがえる
`,
  time: `
calendar_month カレンダー かれんだー
event 予定 よてい
event_repeat 繰り返しの予定 くりかえしのよてい
today 今日 きょう
date_range 期間 きかん
schedule 時計 とけい
alarm 目覚まし めざまし
timer タイマー たいまー
hourglass_empty 砂時計 すなどけい
`,
  chart: `
bar_chart 棒グラフ ぼうぐらふ
pie_chart 円グラフ えんぐらふ
trending_up 上向き うわむき
monitoring 推移 すいい
analytics 分析 ぶんせき
query_stats 調べる しらべる
insights 気づき きづき
science 実験 じっけん
`,
  money: `
payments 支払い しはらい
receipt_long レシート れしーと
shopping_cart 買い物かご かいものかご
storefront お店 おみせ
account_balance 銀行 ぎんこう
savings 貯金 ちょきん
credit_card カード かーど
calculate 電卓 でんたく
`,
  sign: `
star 星 ほし
thumb_up いいね いいね
verified 確認済み かくにんずみ
new_releases 新着 しんちゃく
emoji_events トロフィー とろふぃー
celebration お祝い おいわい
campaign 告知 こくち
flag_circle 目標 もくひょう
target 的 まと
lightbulb 電球 でんきゅう
tips_and_updates ひらめき ひらめき
auto_awesome きらめき きらめき
rocket_launch ロケット ろけっと
bolt いなずま いなずま
key 鍵 かぎ
`,
  tool: `
laptop_windows ノートパソコン のーとぱそこん
call 電話 でんわ
videocam ビデオ びでお
headphones ヘッドホン へっどほん
photo_camera カメラ かめら
send 送る おくる
inbox_text 受信箱 じゅしんばこ
image 画像 がぞう
movie 映画 えいが
music_note 音符 おんぷ
code コード こーど
terminal 端末 たんまつ
bug_report 不具合 ふぐあい
build 工具 こうぐ
construction 工事 こうじ
design_services デザイン でざいん
palette パレット ぱれっと
brush 筆 ふで
`,
  place: `
apartment ビル びる
corporate_fare 会社 かいしゃ
meeting_room 会議室 かいぎしつ
location_on 場所 ばしょ
map 地図 ちず
public 地球 ちきゅう
language 言語 げんご
directions_car 車 くるま
train 電車 でんしゃ
directions_bus バス ばす
directions_walk 歩く あるく
restaurant 食事 しょくじ
coffee コーヒー こーひー
local_hospital 病院 びょういん
`,
  life: `
eco 葉 は
park 木 き
local_florist 花 はな
pets 足あと あしあと
sunny 晴れ はれ
cloud 雲 くも
water_drop しずく しずく
recycling リサイクル りさいくる
sports_soccer サッカー さっかー
fitness_center 運動 うんどう
`,
};

// 画面の飾りだけに使う絵（選びの窓に出さない・ページのアイコンにできない: 決めたこと 23・26）。名前とよみは持たない（読み上げに出さない飾り）
const UI_ONLY = Object.freeze(['settings', 'delete', 'library_books']);

const rowsOf = (text) => String(text || '').trim().split('\n').filter(Boolean).map((line) => line.trim().split(/\s+/));
// [{ id, src, cat, n, y, en, ui? }]（窓の並びの順: 分類の順、分類の中はデジタル庁が先: 決めたこと 2。同じ名前は先に入れたデジタル庁の絵だけ）
const ICON_LIST = Object.freeze((() => {
  const out = [];
  const seen = new Set();
  const add = (src, cat, id, n, y, ui) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(Object.freeze({ id, src, cat, n, y, en: id.replace(/_/g, ' '), ...(ui ? { ui: true } : {}) }));
  };
  for (const c of ICON_CATS) {
    for (const [id, n, y] of rowsOf(DG[c.key])) add('dg', c.key, id, n, y);
    for (const [id, n, y] of rowsOf(MS[c.key])) add('ms', c.key, id, n, y);
  }
  for (const id of UI_ONLY) add('ms', null, id, '', '', true);
  return out;
})());

module.exports = { ICON_CATS, ICON_LIST };
