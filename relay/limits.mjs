// 窓ごとの数え（第1d回 RL4・RF33）。D1 の counters の表（key・win・n）に置く。
// どれも「先に数えてから比べる」: 1つの batch（トランザクション）で数えを1つ進め、進めた後の n を読む。
// 読んでから書く形にすると、同時の要求が読みと書きの間で入れ替わり、上限を越えるため。
//   hits(db, [{ key, windowSec, max }], now) → [{ ok, n, retryAfter }]（幾つかの数えを1つの batch で進める）
//   hit(db, key, { windowSec, max, now }) → { ok, n, retryAfter }（hits の1つ分）
//   release(db, key, { windowSec, now }) → 同じ窓の数えを1つ戻す（送れなかったメールの全体の通数。n は 0 より下げない）
// now は UNIX 秒。win は窓の始まりの UNIX 秒（窓の長さが違う数えでも「2 日より古い窓」を1つの文で片付けられる）。
// retryAfter は窓の終わりまでの秒（1 以上）。鍵にはメールも IP もそのまま書かない（呼ぶ側がハッシュにする）。
//
// 音声の秒の数え（第1d回 W-4・RF34。同じ counters の表。鍵は 1人 a:u:<メールの sha256 の先頭 32 字>・全体 a:all）:
//   dayNumber(nowSec, offsetMin) → 日の番号（offsetMin 分ずらした日付。既定の 540 で日本の日付）
//   secondsToDayEnd(nowSec, offsetMin) → その日付の替わりまでの秒（1〜86400）
//   usage(db, key, day) → その日の秒（無ければ 0）
//   reserveUsage(db, { userKey, day, sec, userMax, allMax }) → { ok: true } | { ok: false, scope: 'user' | 'all' }
//     OpenAI へ送る前に、1人と全体の秒を1つの batch で足して読み、どちらかが上限を越えたら同じ秒を引いて断る（先に数えてから比べる。
//     同時の要求でも上限を越えない。両方越えれば 'user'）
//   refundUsage(db, { userKey, day, sec }) → OpenAI が 200 を返さなかった区間の秒を戻す（同じ日の行だけ。0 より下げない）
//   日の窓の win は「日の番号 × 86400」（日付の始まりを UTC の形で書いた秒）。今の日の win は今から 2 日の内にあるので、
//   /auth/start の「2 日より古い窓の片付け」がそのまま古い日の行を消す。

const COUNT_SQL = 'INSERT INTO counters (key, win, n) VALUES (?1, ?2, 1) ON CONFLICT (key) DO UPDATE SET '
  + 'n = CASE WHEN counters.win = excluded.win THEN counters.n + 1 ELSE 1 END, win = excluded.win';
const READ_SQL = 'SELECT n FROM counters WHERE key = ?1';

export const windowStart = (now, windowSec) => Math.floor(now / windowSec) * windowSec;

export async function hits(db, list, now) {
  const stmts = [];
  for (const { key, windowSec } of list) {
    const win = windowStart(now, windowSec);
    stmts.push(db.prepare(COUNT_SQL).bind(key, win), db.prepare(READ_SQL).bind(key));
  }
  const res = await db.batch(stmts);
  return list.map(({ windowSec, max }, i) => {
    const row = (res[i * 2 + 1].results || [])[0];
    const n = Number(row && row.n) || 0;
    const retryAfter = Math.max(1, windowStart(now, windowSec) + windowSec - now);
    return { ok: n <= max, n, retryAfter };
  });
}

export async function hit(db, key, { windowSec, max, now }) {
  return (await hits(db, [{ key, windowSec, max }], now))[0];
}

export async function release(db, key, { windowSec, now }) {
  await db.prepare('UPDATE counters SET n = n - 1 WHERE key = ?1 AND win = ?2 AND n > 0')
    .bind(key, windowStart(now, windowSec)).run();
}

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
