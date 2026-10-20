// D1 の表の形 v2（第1d回 RL2。W-6 で v1 から変えた）。出す台本（tools/relay-deploy.js）が Worker を上げる前に、出すたびに流す。
// 何回流しても同じ（IF NOT EXISTS・IF EXISTS・ON CONFLICT）。途中で止まっても、次に全部を流せば同じ形になる（meta.schema は最後に書く）。
//   blocked_emails.email … 止めたメール（小文字）。管理者が D1 の画面で入れる（README の管理者の手順の SQL）。at は UNIX 秒
//   counters             … 1日の音声の秒の数え（鍵は 1人 a:u:<メールの sha256 の先頭 32 字>・全体 a:all。win は日の始まりの秒）
// v1 から v2 で消すもの: 自前のログインの login_codes（確認コードのハッシュ）と sessions（札のハッシュ。sessions_email の索引も表と
// いっしょに消える）、/auth/start の数え（s:・v:・mail）の行。1日の秒の数え（a:）と blocked_emails は残す。
// 「1.x で形を変えるときは足すだけ」の例外（0.8.0 の前で、消す表を使った Worker はまだ使われていない）。v1 の Worker へは戻さない。
// 注釈は SQL の中に書かない（D1 の問い合わせの API にそのまま渡すため）。

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocked_emails (email TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, win INTEGER NOT NULL, n INTEGER NOT NULL);
DROP TABLE IF EXISTS login_codes;
DROP TABLE IF EXISTS sessions;
DELETE FROM counters WHERE key NOT LIKE 'a:%';
INSERT INTO meta (key, value) VALUES ('schema', '${SCHEMA_VERSION}') ON CONFLICT (key) DO UPDATE SET value = excluded.value;
`;
