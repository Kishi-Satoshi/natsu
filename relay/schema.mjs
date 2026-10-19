// D1 の表の形 v1（第1d回 RL2）。出す台本（tools/relay-deploy.js）が出すたびに流す。何回流しても同じ（IF NOT EXISTS）。
// 1.x で形を変えるときは足すだけにする（SCHEMA_VERSION を上げ、CREATE … IF NOT EXISTS と ALTER TABLE ADD COLUMN を足す）。
//   login_codes.email     … 小文字に揃えたメール
//   login_codes.code_hash … sha256hex(email + ':' + code)。コードそのものは持たない
//   login_codes.expires_at・created_at … UNIX 秒
//   sessions.token_hash   … sha256hex(札)。札そのものは持たない
//   sessions.idp          … 'email'（後で 'microsoft' を足す）
//   sessions.expires_at   … 最初から 180 日。revoked_at は取り消した時刻（NULL なら生きている）
//   counters              … 窓ごとの数え（鍵にはメールと IP のハッシュだけ）
// 注釈は SQL の中に書かない（D1 の問い合わせの API にそのまま渡すため）。

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS login_codes (
  email TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  idp TEXT NOT NULL DEFAULT 'email',
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_email ON sessions (email);
CREATE TABLE IF NOT EXISTS blocked_emails (email TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, win INTEGER NOT NULL, n INTEGER NOT NULL);
INSERT INTO meta (key, value) VALUES ('schema', '${SCHEMA_VERSION}') ON CONFLICT (key) DO UPDATE SET value = excluded.value;
`;
