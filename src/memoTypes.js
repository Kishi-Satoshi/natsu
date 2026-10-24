'use strict';
// メモの型（0.11.0。計画 docs/plans/2026-10-22-110.md の「型の表（MT1 改）」。持ち主の答え D37〜D50・D80）。純粋（ほかの部品を読まない。M-2 から ./meetingType を読む）。
// 型は会議の種類から決まる（D42: memoTypeOf）。型を別に選ぶ欄は無い。見出しはメモが空か手を付けていないときだけ入れる（isUntouchedMemo）。
// 見出しごとのヒントはメモの本文に入れず、画面がメモ欄の上の灰色の手引きに出す（listMemoTypes の headings）。

const deepFreeze = (o) => { Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v); }); return Object.freeze(o); };

// 見出しは { name, hint }。report の3つは「報告（議題）ごとに」の入れ子（group）で、報告が1本なら小見出しは1つ
const MEMO_TYPES = deepFreeze({
  points: {
    label: '会議の要点（論点整理）',
    headings: [
      { name: '目的', hint: '共有・相談・決定のどれのための会議か（冒頭で言われた場合）' },
      { name: '論点ごとの要点', hint: '発言の順でなく論点ごとに、出た意見と結論に至った理由' },
    ],
    rules: ['各論点は結論を先に書く（PREP）。', '誰の意見かを書き、事実と意見を分ける。'],
  },
  report: {
    label: '進捗・報告の確認（空・雨・傘）',
    headings: [
      { name: '前回の宿題の状況', hint: '済んだか・遅れているか' },
      { name: '事実（進捗・課題）', hint: 'いま起きていること', group: '報告（議題）ごとに' },
      { name: '見立て（原因・リスク）', hint: '発言者が言った原因やこれからの見通し', group: '報告（議題）ごとに' },
      { name: '打ち手の案', hint: '出た対策の案', group: '報告（議題）ごとに' },
    ],
    rules: ['見立ては発言者のものだけを書き、AI の解釈を書かない。', '遅れは理由と影響を一緒に書く。', '進捗率などの数字は話されたときだけ書く。', '決まった打ち手は締めの決定事項と ToDo に書く。'],
  },
  present: {
    label: 'プレゼン形式（要旨・質疑）',
    headings: [
      { name: '発表の要旨', hint: '何を伝えたか（結論を先に）' },
      { name: '質疑応答', hint: '質問と答えの組' },
      { name: '出た意見・懸念', hint: '聞き手の意見や気がかり' },
    ],
    rules: ['要旨は結論を先に書く。', '質問と答えは組にして書く。', '答えられなかった質問は締めの持ち越しに書く。'],
  },
  bantc: {
    label: '商談の確認（BANTC）',
    headings: [
      { name: '課題・要望（N）', hint: '先方の課題と求めていること' },
      { name: '時期（T）', hint: '導入・開始したい時期' },
      { name: '決め方・決裁者（A）', hint: '誰が決めるか・稟議の流れ' },
      { name: '予算（B）', hint: '金額や予算の枠' },
      { name: '競合・比較先（C）', hint: '他社の検討状況' },
    ],
    rules: ['先方の発言とこちらの推測を分ける。', '各行の頭に 確定 か 見込み を書き、その後に根拠になった言葉を短く書く。', '協業の話では、予算を費用の分担、決裁者を先方の決め方と読み替える。'],
  },
  grow: {
    label: '1on1の振り返り（GROW）',
    headings: [
      { name: 'テーマ・目標（G）', hint: '本人が取り上げたテーマや目指すこと' },
      { name: '現状と困りごと（R）', hint: 'いまの状況とつまずき' },
      { name: '選択肢・上司の助言（O）', hint: '検討した選択肢と助言' },
    ],
    rules: ['目標は本人が口にしたものだけを書く。', '振り返りの話は続けることと困ったことに分ける（KPT）。', '健康・家族・転職の話は書かない。', 'やること（W）は締めの ToDo に書く。'],
  },
  star: {
    label: '面接の確認（STAR）',
    headings: [
      { name: '経歴・スキル', hint: '本人が話した事実' },
      { name: '行動の具体例', hint: '状況・役割・行動・結果' },
      { name: '本人からの質問・懸念', hint: '本人から出た質問や気がかり' },
      { name: '条件', hint: '稼働開始時期・働き方など話した範囲' },
    ],
    rules: ['結果が話されなければ補わない。'],
  },
});
const MEMO_ORDER = Object.freeze(['points', 'report', 'present', 'bantc', 'grow', 'star']);
// 会議の種類 → 型（D42）。決まらない（''）・前の版の general・知らない種類は points（memoTypeOf）
const DEFAULT_MEMO = Object.freeze({
  standup: 'report', review: 'report', brainstorm: 'points',
  oneonone: 'grow', interview: 'star', sales: 'bantc', present: 'present',
});

function memoTypeOf(meetingType) {
  return typeof meetingType === 'string' && Object.hasOwn(DEFAULT_MEMO, meetingType) ? DEFAULT_MEMO[meetingType] : 'points';
}

// 雛形: 「■ 見出し」だけ（ヒントは入れない）。見出しの間に空の行1つ。知らない key は ''
function memoPreset(key) {
  const t = typeof key === 'string' && Object.hasOwn(MEMO_TYPES, key) ? MEMO_TYPES[key] : null;
  if (!t) return '';
  return `${t.headings.map((h) => `■ ${h.name}`).join('\n\n')}\n`;
}

// 行ごとに trim して空の行を除いた形（雛形と比べる）
const normLines = (text) => String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join('\n');

// 手を付けていないメモか（空白だけ・どれかの型の雛形・今のアジェンダの雛形 legacy と、行ごとに trim して空の行を除いて完全一致）
function isUntouchedMemo(memo, legacy = []) {
  const m = normLines(memo);
  if (!m) return true;
  for (const k of MEMO_ORDER) if (m === normLines(memoPreset(k))) return true;
  for (const a of Array.isArray(legacy) ? legacy : []) {
    const l = normLines(a);
    if (l && m === l) return true;
  }
  return false;
}

// 見出しを比べる形: NFKC・頭の ■ # * と空白・終わりの ** と（…）・空白を外す
function headingKey(text) {
  let t = String(text || '').normalize('NFKC').trim();
  t = t.replace(/^[■#*\s]+/, '').replace(/[*\s]+$/, '');
  t = t.replace(/\([^()]*\)$/, '');
  return t.replace(/\s+/g, '');
}

// memoEvidence に渡す雛形の行（{ agenda } の形。担当・期限の裏付けにしない）
function presetLines() {
  return MEMO_ORDER.map((k) => ({ agenda: memoPreset(k) }));
}

// 画面と IPC 用
function listMemoTypes() {
  return MEMO_ORDER.map((k) => ({
    key: k, label: MEMO_TYPES[k].label,
    headings: MEMO_TYPES[k].headings.map((h) => ({ ...h })),
    rules: [...MEMO_TYPES[k].rules], preset: memoPreset(k),
  }));
}

module.exports = {
  MEMO_TYPES, MEMO_ORDER, DEFAULT_MEMO, memoTypeOf, memoPreset, isUntouchedMemo, headingKey, presetLines, listMemoTypes,
};
