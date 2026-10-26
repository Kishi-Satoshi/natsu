'use strict';
// 会議を出たかの判断（0.12.1 Task LV-1。計画 docs/plans/2026-10-24-121.md の決めたこと L1〜L9）。純粋（ファイルにも時計にも触れない）。
// 見張る会議のアプリ（W）がマイクを放したのを、会議の検出の見張りの3回続けての読み（2 秒ごと。約 6 秒）で見たら「出た」とみなして止める（問8・問9）。
// W に足すのは、録音中にそのアプリが2回続けてマイクを使っているのを見たとき（パネルから始めた録音は、パネルのアプリを初めから）。
// 2回までの放し・見張りの記録が読めない・読みが途切れた（10 秒より空いた）・一時停止・設定がオフでは止めない（分からないときは止めない側）。
// 時刻は出来事の now だけを使い、main は答えの act のとおりに記録し、止めるだけ（0.9.1 の quietStep・0.9.3 の nudgeStep と同じ形）。
// 持ち主の試作の「状態を、きっかけと一緒に移す」考え: 状態は wait（まだ会議のアプリを見ていない）と in（会議中）の2つと、放して見えた読みの数だけ。

const LEAVE_SEEN = 2;      // W に足すまでに続けて見る「使っている」読みの数（L3）
const LEAVE_GONE = 3;      // 止めるまでに続けて見る「放した」読みの数（L4・問9。約 6 秒）
const LEAVE_GAP_MS = 10000; // 「放した」読みの間がこれより空いたら、続けてと見ない（L6）
const LEAVE_IDS = Object.freeze(['teams', 'zoom', 'chrome', 'edge']);   // W にしてよい id（LQ5・LQ7。LQ12 で Webex・Slack を足しうる）

// apps: W にしてよい id の一覧（main は LEAVE_IDS を渡す）。first: パネルから始めたアプリの id か null。off: 設定がオフで始めた
function leaveInit({ apps = LEAVE_IDS, first = null, off = false } = {}) {
  const list = Array.isArray(apps) ? apps.filter((x) => typeof x === 'string') : [];
  const w = typeof first === 'string' && list.includes(first) ? [first] : [];
  return { phase: w.length ? 'in' : 'wait', apps: list, w, seen: {}, gone: 0, goneAt: null, lastAt: null, paused: false, on: off !== true, others: [] };
}

// 読みの項目 → [{ id, start }]（同じ id は先のもの）。形の悪い読み（items が配列でない・now が数でない・項目が { id, start } の文字でない）は null
function sampleItems(ev) {
  if (!Array.isArray(ev.items) || !Number.isFinite(ev.now)) return null;
  const out = [];
  for (const x of ev.items) {
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || typeof x.start !== 'string') return null;
    if (!out.some((y) => y.id === x.id)) out.push({ id: x.id, start: x.start });
  }
  return out;
}

// ev: { type: 'sample', items: [{ id, start }], now } | { type: 'lost', now } | { type: 'pause', on, now } | { type: 'setting', on, now }
//  → { st, act: '' | 'found' | 'blip' | 'reset' | 'stop', goneAt?（stop のとき）, others?（放した読みで見えた W に無い使いの 'id:start'。stop のとき） }
function leaveStep(st0, ev) {
  const st = JSON.parse(JSON.stringify(st0 || leaveInit()));
  const out = { st, act: '' };
  const e = ev && typeof ev === 'object' ? ev : { type: 'lost' };
  const wasGone = st.gone > 0;
  const backToZero = () => { st.gone = 0; st.goneAt = null; st.others = []; };
  // 一時停止・設定（L8・L9）: 止めた・切ったら数えを戻す（2回続けての「続けて」も切れる）
  if (e.type === 'pause' || e.type === 'setting') {
    if (e.type === 'pause') st.paused = e.on === true;
    else st.on = e.on !== false;
    if (st.paused || !st.on) {
      st.seen = {};
      backToZero();
      if (wasGone) out.act = 'reset';
    }
    return out;
  }
  const items = e.type === 'sample' ? sampleItems(e) : null;
  // データが無い（見張りの記録が読めない・見張りが落ちた・形の悪い読み）: 止めずに数え直す（L7）
  if (items === null) {
    st.seen = {};
    backToZero();
    if (wasGone) out.act = 'reset';
    return out;
  }
  const now = e.now;
  // 一時停止の間・設定がオフの間は数えない
  if (st.paused || !st.on) { st.seen = {}; backToZero(); return out; }
  const using = items.filter((x) => st.apps.includes(x.id));
  const seen = {};
  for (const x of using) seen[x.id] = (st.seen[x.id] || 0) + 1;
  st.seen = seen;
  const prevAt = st.lastAt;
  st.lastAt = now;
  const wUse = using.some((x) => st.w.includes(x.id));
  const released = st.w.length > 0 && !wUse;
  if (!released) {
    // W に足すのは「放した読み」でない読みだけ（R4）。W は録音の間は減らない
    for (const id of st.apps) if ((st.seen[id] || 0) >= LEAVE_SEEN && !st.w.includes(id)) st.w.push(id);
    if (st.phase === 'wait') {
      if (st.w.length) { st.phase = 'in'; out.act = 'found'; }
      return out;
    }
    // 短い放し（L5）: 放して見えたのが1回か2回で、また使っていた
    if (wasGone) { backToZero(); out.act = 'blip'; }
    return out;
  }
  // 放した読み（W のどれもマイクを使っていない）
  const others = items.filter((x) => !st.w.includes(x.id)).map((x) => `${x.id}:${x.start}`);
  if (!wasGone) {
    st.gone = 1; st.goneAt = now; st.others = others;
    return out;
  }
  // 読みが途切れた（PC が眠った・PowerShell が固まった）・時計が戻った: この読みを1回目として数え直す（L6）
  if (prevAt === null || now < prevAt || now - prevAt > LEAVE_GAP_MS) {
    st.gone = 1; st.goneAt = now; st.others = others;
    out.act = 'reset';
    return out;
  }
  for (const k of others) if (!st.others.includes(k)) st.others.push(k);
  if (st.gone + 1 >= LEAVE_GONE) {
    out.act = 'stop';
    out.goneAt = st.goneAt;
    out.others = st.others.slice();
    return out;
  }
  st.gone += 1;
  return out;
}

module.exports = { LEAVE_SEEN, LEAVE_GONE, LEAVE_GAP_MS, LEAVE_IDS, leaveInit, leaveStep };
