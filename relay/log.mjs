// 中継の記録の1行（第1d回 RL7・F9）。中継の中で console を呼ぶのはこのファイルだけ。
// 残すのは決まった名前の欄だけで、値は数か、小文字・数字・ハイフンの短い符号だけ（ほかは捨てる）。
// メール・IP・札・確認コード・認識ヒント・文字起こしの文・例外の文は、どの欄に入れても残らない。
//   st（状態の番号）・r（結果の符号）・ms・sec・n・left・scope・v

const KEYS = ['st', 'r', 'ms', 'sec', 'n', 'left', 'scope', 'v'];
const WORD = /^[a-z0-9-]{1,32}$/;
const EV = /^[a-z0-9.-]{1,32}$/;

export function logEvent(ev, fields = {}) {
  const out = { ev: EV.test(String(ev)) ? String(ev) : 'event' };
  const f = fields && typeof fields === 'object' ? fields : {};
  for (const k of KEYS) {
    const v = f[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'string' && WORD.test(v)) out[k] = v;
  }
  console.log(JSON.stringify(out));
}
