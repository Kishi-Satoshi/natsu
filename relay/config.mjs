// 環境の値の読み方と既定（第1d回 RL2）。秘密の欄（OPENAI_API_KEY・RESEND_API_KEY・ALLOWED_EMAIL_DOMAINS・MAIL_FROM・STT_MODEL）は
// 利用者が Cloudflare の画面で入れる。会社のドメインはリポジトリに書かない。
// 試しの宛先（OPENAI_BASE・RESEND_BASE）は http://127.0.0.1:<port> の形のときだけ使い、ほかの値（無い・https・ほかのホスト）は
// 本物の固定の URL にする（本番で取り違えても、会社の鍵をほかのホストへ運ばない）。
// ready は秘密がそろったかだけ（値は出さない）。D1 の表があるか（db）は worker.mjs の /health が見る。
// 第1d回 W-5（Cloudflare Access）: TEAM_DOMAIN（https://<チームの名前>.cloudflareaccess.com の形のときだけ）・POLICY_AUD（64 字の16進の
// ときだけ）・ACCESS_CERTS_BASE（鍵の口の試しの宛先。http://127.0.0.1:<port> ちょうどのときだけ。ほかは TEAM_DOMAIN から鍵を読む）。
// ready.access は TEAM_DOMAIN と POLICY_AUD がそろったか。チームの名前はリポジトリに書かない（Worker の秘密の欄にだけ置く）。
// ready.mail は /auth/start（W-6 で消す）が自分の中で見るだけで、/health の ready には出さない。

const TEST_BASE = /^http:\/\/127\.0\.0\.1:\d{2,5}(\/[A-Za-z0-9/_-]*)?$/;
const MODEL = /^[a-z0-9][a-z0-9.-]{1,63}$/;
const TEAM_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUD_RE = /^[0-9a-f]{64}$/;
const CERTS_TEST_BASE = /^http:\/\/127\.0\.0\.1:\d{2,5}$/;
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export const DEFAULTS = Object.freeze({
  model: 'gpt-4o-transcribe',
  openaiBase: 'https://api.openai.com/v1',
  resendBase: 'https://api.resend.com',
  dailyUserSec: 14400,          // 1人 1日 4 時間
  dailyAllSec: 360000,          // 全体 1日 100 時間
  mailDailyMax: 90,             // 全体 1日 90 通（Resend の無料の 100 通の内）
  maxAudioBytes: 25 * 1024 * 1024 - 4096,   // OpenAI の 25MB の内（multipart の欄の分を残す）
  dayOffsetMin: 540,            // 日本の日付で数える
});

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const testBase = (v, real) => (typeof v === 'string' && TEST_BASE.test(v) ? v : real);

// 正の整数（max まで）のときだけそれ、ほかは既定
function posInt(v, def, max = Number.MAX_SAFE_INTEGER) {
  const s = text(v);
  if (!/^\d{1,15}$/.test(s)) return def;
  const n = Number(s);
  return n > 0 && n <= max ? n : def;
}

function offsetMin(v, def) {
  const s = text(v);
  if (!/^-?\d{1,4}$/.test(s)) return def;
  const n = Number(s);
  return n >= -720 && n <= 840 ? n : def;
}

export function readConfig(env = {}) {
  const e = env || {};
  const domains = new Set(text(e.ALLOWED_EMAIL_DOMAINS).split(',').map((d) => d.trim().toLowerCase()).filter((d) => DOMAIN.test(d)));
  const openaiKey = text(e.OPENAI_API_KEY);
  const resendKey = text(e.RESEND_API_KEY);
  const mailFrom = text(e.MAIL_FROM);
  const model = MODEL.test(text(e.STT_MODEL)) ? text(e.STT_MODEL) : DEFAULTS.model;
  const teamDomain = TEAM_RE.test(text(e.TEAM_DOMAIN)) ? text(e.TEAM_DOMAIN) : '';
  const policyAud = AUD_RE.test(text(e.POLICY_AUD)) ? text(e.POLICY_AUD) : '';
  const certsBase = teamDomain && typeof e.ACCESS_CERTS_BASE === 'string' && CERTS_TEST_BASE.test(e.ACCESS_CERTS_BASE) ? e.ACCESS_CERTS_BASE : teamDomain;
  return {
    domains,
    mailFrom,
    openaiKey,
    resendKey,
    model,
    teamDomain,
    policyAud,
    certsBase,
    openaiBase: testBase(e.OPENAI_BASE, DEFAULTS.openaiBase),
    resendBase: testBase(e.RESEND_BASE, DEFAULTS.resendBase),
    dailyUserSec: posInt(e.DAILY_USER_SEC, DEFAULTS.dailyUserSec),
    dailyAllSec: posInt(e.DAILY_ALL_SEC, DEFAULTS.dailyAllSec),
    mailDailyMax: posInt(e.MAIL_DAILY_MAX, DEFAULTS.mailDailyMax),
    maxAudioBytes: posInt(e.MAX_AUDIO_BYTES, DEFAULTS.maxAudioBytes, DEFAULTS.maxAudioBytes),
    dayOffsetMin: offsetMin(e.DAY_OFFSET_MIN, DEFAULTS.dayOffsetMin),
    ready: { openai: Boolean(openaiKey), mail: Boolean(resendKey && mailFrom), domains: domains.size > 0, access: Boolean(teamDomain && policyAud) },
  };
}
