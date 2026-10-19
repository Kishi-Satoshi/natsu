// 確認コードのメールを Resend で送る（第1d回 RL3・RF37）。社名は入れない。
//   sendCode(cfg, { to, code }) → { ok: true } | { ok: false, st }（st は Resend の状態の番号。届かない・時間切れは 0）
// 宛先は cfg.resendBase（本番は https://api.resend.com。試しは 127.0.0.1 だけ: config.mjs）。
// Idempotency-Key は sha256hex(to + code) の先頭 32 字（同じ宛先と同じコードの二重の送りを Resend が1通にする）。
// 答えの本文は読まずに捨てる（Resend の誤りの文に宛先が入りうるので、記録にも答えにも写さない）。

import { sha256hex } from './http.mjs';

const TIMEOUT_MS = 10000;

export const SUBJECT = 'NaTsu の確認コード';
export const bodyText = (code) => `NaTsu の確認コードは ${code} です。10 分の間だけ使えます。`
  + '心当たりが無いときは、このメールを消してください（だれかがメールアドレスを打ち間違えた可能性があります）。';

export async function sendCode(cfg, { to, code }) {
  let res;
  try {
    res = await fetch(cfg.resendBase + '/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: 'Bearer ' + cfg.resendKey,
        'content-type': 'application/json',
        'idempotency-key': (await sha256hex(to + code)).slice(0, 32),
      },
      body: JSON.stringify({ from: cfg.mailFrom, to: [to], subject: SUBJECT, text: bodyText(code) }),
    });
  } catch (_) {
    return { ok: false, st: 0 };   // 届かない・切れた・時間切れ・転送された。例外の文は写さない
  }
  try { if (res.body) await res.body.cancel(); } catch (_) { /* 捨てるだけ */ }
  return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, st: res.status };
}
