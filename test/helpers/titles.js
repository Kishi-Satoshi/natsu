/*
 * titles.js — テストの作り物の会議の題名（0.10.0 SH-2・D77・決めたこと 152。計画 docs/plans/2026-10-20-100.md）
 *   titleAt(isoOrDate) → 本物の NaTsu が新しい議事録に付けるのと同じ日付の形の題名（「2026/10/16 10:00 の議事録」）。
 *   形は src/mainlib.js の meetingTitleAt の1か所。時刻は日本の時刻（テストを回す機械の時間帯で題名が変わらないように）。
 *   題名の語に頼るテスト（題名で探す・題名から会議の種類を決める・題名に指示や制御の文字を入れる守り・題名を直す）は、利用者が付け直した
 *   題名として決めた題名を残し、「// 利用者が付け直した題名（D77。題名の語に頼るため）」の注を付ける（test/repo.test.js が字面で見る）。
 */
'use strict';
const { meetingTitleAt } = require('../../src/mainlib');

const JST_MIN = 540;
const titleAt = (isoOrDate) => meetingTitleAt(isoOrDate, JST_MIN);

module.exports = { titleAt, JST_MIN };
