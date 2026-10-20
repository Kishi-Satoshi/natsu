// 音声の秒の数え（第1d回 W-4・RF34）。D1 の counters の表（key・win・n）に置く。鍵は 1人 a:u:<メールの sha256 の先頭 32 字>・全体 a:all。
// 「先に数えてから比べる」: 1つの batch（トランザクション）で秒を足し、足した後の値を読む。読んでから書く形にすると、
// 同時の要求が読みと書きの間で入れ替わり、上限を越えるため。鍵にはメールをそのまま書かない（呼ぶ側がハッシュにする）。
//   dayNumber(nowSec, offsetMin) → 日の番号（offsetMin 分ずらした日付。既定の 540 で日本の日付）
//   secondsToDayEnd(nowSec, offsetMin) → その日付の替わりまでの秒（1〜86400）
//   usage(db, key, day) → その日の秒（無ければ 0）
//   reserveUsage(db, { userKey, day, sec, userMax, allMax }) → { ok: true } | { ok: false, scope: 'user' | 'all' }
//     OpenAI へ送る前に、1人と全体の秒を1つの batch で足して読み、どちらかが上限を越えたら同じ秒を引いて断る（先に数えてから比べる。
//     同時の要求でも上限を越えない。両方越えれば 'user'）。同じ batch で、2 日より前の日（win < (day − 2) × 86400）の行を片付ける
//     （第1d回 W-6。前は /auth/start が「2 日より古い窓」を片付けていた。消す行が無ければ D1 の書きは増えない）
//   refundUsage(db, { userKey, day, sec }) → OpenAI が 200 を返さなかった区間の秒を戻す（同じ日の行だけ。0 より下げない）
//   日の窓の win は「日の番号 × 86400」（日付の始まりを UTC の形で書いた秒）。
// 第1d回 W-6 で、/auth/start と /auth/verify の窓の数え（hits・hit・windowStart・release）を消した（使う所が無い）。

const READ_SQL = 'SELECT n FROM counters WHERE key = ?1';

const DAY = 86400;
export const ALL_USAGE_KEY = 'a:all';

export const dayNumber = (nowSec, offsetMin) => Math.floor((nowSec + offsetMin * 60) / DAY);

export const secondsToDayEnd = (nowSec, offsetMin) => (dayNumber(nowSec, offsetMin) + 1) * DAY - (nowSec + offsetMin * 60);

const ADD_SQL = 'INSERT INTO counters (key, win, n) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET '
  + 'n = CASE WHEN counters.win = excluded.win THEN counters.n + excluded.n ELSE excluded.n END, win = excluded.win';
const SUB_SQL = 'UPDATE counters SET n = MAX(0, n - ?3) WHERE key = ?1 AND win = ?2';
const nOf = (r) => Number(((r && r.results) || [])[0]?.n) || 0;

export async function usage(db, key, day) {
  return Number(await db.prepare('SELECT n FROM counters WHERE key = ?1 AND win = ?2').bind(key, day * DAY).first('n')) || 0;
}

export async function reserveUsage(db, { userKey, day, sec, userMax, allMax }) {
  const win = day * DAY;
  const res = await db.batch([
    db.prepare(ADD_SQL).bind(userKey, win, sec),
    db.prepare(ADD_SQL).bind(ALL_USAGE_KEY, win, sec),
    db.prepare(READ_SQL).bind(userKey),
    db.prepare(READ_SQL).bind(ALL_USAGE_KEY),
    db.prepare('DELETE FROM counters WHERE win < ?1').bind((day - 2) * DAY),
  ]);
  const user = nOf(res[2]);
  const all = nOf(res[3]);
  if (user <= userMax && all <= allMax) return { ok: true };
  await refundUsage(db, { userKey, day, sec });
  return { ok: false, scope: user > userMax ? 'user' : 'all' };
}

export async function refundUsage(db, { userKey, day, sec }) {
  const win = day * DAY;
  await db.batch([db.prepare(SUB_SQL).bind(userKey, win, sec), db.prepare(SUB_SQL).bind(ALL_USAGE_KEY, win, sec)]);
}
