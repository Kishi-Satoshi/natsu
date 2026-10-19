// 窓ごとの数え（第1d回 RL4・RF33）。D1 の counters の表（key・win・n）に置く。
// どれも「先に数えてから比べる」: 1つの batch（トランザクション）で数えを1つ進め、進めた後の n を読む。
// 読んでから書く形にすると、同時の要求が読みと書きの間で入れ替わり、上限を越えるため。
//   hits(db, [{ key, windowSec, max }], now) → [{ ok, n, retryAfter }]（幾つかの数えを1つの batch で進める）
//   hit(db, key, { windowSec, max, now }) → { ok, n, retryAfter }（hits の1つ分）
//   release(db, key, { windowSec, now }) → 同じ窓の数えを1つ戻す（送れなかったメールの全体の通数。n は 0 より下げない）
// now は UNIX 秒。win は窓の始まりの UNIX 秒（窓の長さが違う数えでも「2 日より古い窓」を1つの文で片付けられる）。
// retryAfter は窓の終わりまでの秒（1 以上）。鍵にはメールも IP もそのまま書かない（呼ぶ側がハッシュにする）。

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
