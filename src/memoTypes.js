'use strict';
// メモの型（0.11.0。計画 docs/plans/2026-10-22-110.md の「型の表（MT1 改）」。持ち主の答え D37〜D50・D80）。純粋（./meetingType と ./quality の採点の節の文だけを読む）。
// 型は会議の種類から決まる（D42: memoTypeOf）。型を別に選ぶ欄は無い。見出しはメモが空か手を付けていないときだけ入れる（isUntouchedMemo）。
// 見出しごとのヒントはメモの本文に入れず、画面がメモ欄の上の灰色の手引きに出す（listMemoTypes の headings）。

const mtype = require('./meetingType');
const quality = require('./quality');

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

// ---------------------------------------------------------------- 要約の書式（M-2。決めたこと 14〜16・19〜22）
// AI に渡す文と、写しを落とす文（minutes.dropTemplateEcho）は、doRunSummary が buildTemplate で1回作った同じ1つの文字列を使う。
// 決まりの文では語を「」で囲まず、行の終わりを（…）にしない（dropTemplateEcho の鍵になり、その語だけの本物の行が落ちる）。

const CLOSING_HEADINGS = Object.freeze(['決定事項', '持ち越し', 'ToDo（誰が・何を・いつまでに）', '抜け・重なりチェック']);
const ADVICE_HEAD = '次に気をつけること';
const CHECK_MAX = 3;
const UNCONFIRMED_HEAD = '未確認';
const MEMO_SUFFIX = '（メモより）';
const REPORT_HEAD = '報告の名前（議題ごとに1つ。報告が1本なら1つ）';

const CLOSING_TEMPLATE = `## 決定事項
（決まったこと・合意したこと。箇条書き）

## 持ち越し
（話したが決まらなかったこと。何が・なぜ決まらなかったか・次にいつ扱うか（言われた場合）。箇条書き。無ければこの見出しごと書かない。話されなかったことは書かない）

## ToDo（誰が・何を・いつまでに）
${mtype.ACTION_RULE}

## 抜け・重なりチェック
（1行目に、根拠が無く本文に出さなかった型の見出しを 未確認: の後に読点で並べる。その後に3件まで: 次の会議で聞くこと・同じ話が別の見出しに重なっていればその見出しの名前）`;

const ADVICE_TEMPLATE = `## ${ADVICE_HEAD}
（1〜2 行。次の会議で試せる進め方。会議を開いた人への助言として書く。人を評価しない・人の名前を挙げて責めない・個人的なことに触れない）`;

const MEMO_RULES = [
  '書き方の決まり（型の見出し）:',
  '- 型の見出しの中身は、行頭に - を付けた箇条書きで書く。',
  '- 文字起こしにもメモにも根拠の無い型の見出しは、推測で埋めずに見出しごと書かない。書かなかった見出しの名前は、抜け・重なりチェックの 未確認: の行に書く。',
  '- メモにだけあって文字起こしに無い内容は、行の終わりに （メモより） と付ける。メモと文字起こしが食い違うときは、両方を書く。',
  '- 時刻や発言の番号は書かない。',
  '- 会議メモの ■ の見出しは、この型の見出しと同じ。',
].join('\n');

const STAR_RULE = [
  '- 職務に関係しない個人的なこと（本籍・出生地・家族・健康・宗教・思想や信条など）は書かない。',
  '- 採用面接では、厚生労働省が示す就職差別につながるおそれのある 14 事項（本籍・出生地・家族・住宅や生活の環境・宗教・支持政党・人生観や生活信条・尊敬する人物・思想・社会運動・購読新聞や愛読書など）も、会話に出ても書かない。',
  '- 合否や総合評価は書かない。',
].join('\n');

// 0.10.x の main.js の OUTPUT_RULE を1文字も変えずに移した
// 節ごとに「なければ特になし」と書くと、小型モデルが条件を守り切れず実項目と「特になし」を両方並べてくる。ルールは全体で1回だけ言う
// （それでも混ざるので minutes.js の dropRedundantEmpty で後始末する）。装飾を禁じるのは、「**」が残ると出典の一致が薄まるため
const OUTPUT_RULE = '書き方のきまり:\n'
  + '- 該当する内容が本当に一つも無い見出しにだけ「特になし」と書く。'
  + '一つでも書くことがあれば「特になし」は書かない。\n'
  + '- 太字（**）や斜体などの装飾は使わない。素の文章で書く。\n'
  + '- 文体は報告文書として使える常体で書く。「です」「ます」は使わない。\n'
  // 3Bクラスは指示より例をまねる。会話体の文字起こしに引きずられて「です・ます」で書いてくるので、良い例と悪い例を1組だけ見せる。
  + '  良い例: 「結合テストは今週で完了。不具合22件のうち20件は修正済み。残り2件は来週対応。」\n'
  + '  悪い例: 「完了しました」「修正されました」「お願いします」「持ち越します」';

// 頭（前の空白を除いた最初の字）が「【」の行の頭に全角の空白を1つ入れる（メモや文字起こしの文で、頼みの文の境を偽れなくする: 決めたこと 16）
function fenceLines(text) {
  return String(text || '').split('\n').map((l) => (/^\s*【/.test(l) ? `　${l}` : l)).join('\n');
}

// 型の見出しの書式（A）
function typeSection(key) {
  const t = MEMO_TYPES[key];
  const out = [];
  let inGroup = false;
  for (const h of t.headings) {
    if (h.group && !inGroup) { out.push(`## ${REPORT_HEAD}`); inGroup = true; }
    out.push(`${h.group ? '###' : '##'} ${h.name}\n（${h.hint}）`);
  }
  return out.join('\n\n');
}

// 型の見出しの名前（軸 5 で数える。report は前回の宿題と報告ごとの3つ）
function sectionsOf(meetingType) {
  return MEMO_TYPES[memoTypeOf(meetingType)].headings.map((h) => h.name);
}

// 要約の書式: 型の見出しとヒント → 型と共通の決まり（star は STAR_RULE も）→ 締め → 次に気をつけること →（点を付けるときだけ採点の節: Q-1）→ OUTPUT_RULE
function buildTemplate({ meetingType, score = false } = {}) {
  const key = memoTypeOf(meetingType);
  const rules = [MEMO_RULES, ...MEMO_TYPES[key].rules.map((r) => `- ${r}`)];
  if (key === 'star') rules.push(STAR_RULE);
  const parts = [typeSection(key), rules.join('\n'), CLOSING_TEMPLATE, ADVICE_TEMPLATE];
  if (score) parts.push(quality.SCORE_TEMPLATE);   // 0.11.0 Q-1: 点を付けるときだけ採点の節
  parts.push(OUTPUT_RULE);
  return parts.join('\n\n');
}

// ---------------------------------------------------------------- 印と畳み（M-3。決めたこと 17・18・22・23）
// 根拠の無い見出しを AI が書いてきたときに畳む語（行頭の - と **・「見出しの名前:」・行末の（…）を外して完全一致）
const EMPTY_LINE = /^(?:未確認|言及なし|会議内で言及なし|話されていない|特に(?:は)?なし|なし|該当なし)(?:\s*(?:──|—|–|-|:)\s*(?:会議内で)?言及なし)?$/;
const MEMO_END = /[（(]メモより[）)]\s*$/;
const key = (t) => headingKey(t);

// 畳む語だけの行か（見出しの名前 head の「見出しの名前:」を外して見る）
function emptyLine(text, head) {
  let t = String(text || '').normalize('NFKC').trim().replace(/^\*+|\*+$/g, '').trim();
  const m = t.match(/^(.{1,40}?)\s*[:：]\s*(.*)$/);
  if (m && key(m[1]) === key(head)) t = m[2].trim();
  for (let i = 0; i < 3; i++) t = t.replace(/\s*\([^()]*\)\s*$/, '').trim();
  t = t.replace(/[。.]$/, '').trim();
  return EMPTY_LINE.test(t);
}

// AI の答えのブロックに印を付ける（受けた配列を書き換えない写しを返す）→ { blocks, dropped（捨てたチェックの数）, folded（未確認にまとめた見出しの数） }
//   見出しに直す（「■ 見出し」・型か締めか助言の見出しと同じ名前だけの段落）→ 根拠の無い型の見出しを畳む・話されなかった持ち越しを落とす
//   → 抜け・重なりチェックの行に check（頭が未確認の1行は unconfirmed）・3 件まで → 次に気をつけることの行に advice → 終わりが（メモより）の行に memo
//   → 印のある行は citeState manual・cites 空（cite.js が照合せず、出典の数の分母にも入らない）
function markBlocks(blocks, { meetingType } = {}) {
  const typeKeys = new Map(sectionsOf(meetingType).map((n) => [key(n), n]));
  const known = new Map([...typeKeys, ...CLOSING_HEADINGS.map((n) => [key(n), n]), [key(ADVICE_HEAD), ADVICE_HEAD]]);
  const CARRY = key('持ち越し');
  const CHECK = key('抜け・重なりチェック');
  const ADVICE = key(ADVICE_HEAD);
  const REPORT = key(REPORT_HEAD);
  // 1. 写しと見出しに直す
  const list = [];
  for (const src of Array.isArray(blocks) ? blocks : []) {
    const b = { ...src, cites: Array.isArray(src.cites) ? [...src.cites] : [] };
    const t = String(b.text || '').trim();
    if (b.type !== 'heading' && b.type !== 'todo' && (/^■/.test(t) || b.type === 'paragraph') && known.has(key(t))) {
      b.type = 'heading';
      b.text = known.get(key(t));
    }
    if (b.type === 'heading' && key(b.text) === REPORT) continue;   // 報告の名前の説明の見出しの写し（R8）
    list.push(b);
  }
  // 2. 節に分ける
  const sections = [];
  let cur = { head: null, items: [] };
  for (const b of list) {
    if (b.type === 'heading') { sections.push(cur); cur = { head: b, items: [] }; } else cur.items.push(b);
  }
  sections.push(cur);
  const foldedNames = [];
  const kept = [];
  sections.forEach((sec, si) => {
    const k = sec.head ? key(sec.head.text) : '';
    // 0.11.0 点検の直し 2（R25）: 行の無い型の見出しの次が小見出し（型・締め・助言の見出しでない見出し）なら、中身は小見出しの下にあるので畳まない
    const next = sections[si + 1];
    const hasSub = !sec.items.length && Boolean(next && next.head) && !known.has(key(next.head.text));
    if (sec.head && typeKeys.has(k) && !hasSub && sec.items.every((b) => b.type !== 'todo' && emptyLine(b.text, sec.head.text))) {
      foldedNames.push(typeKeys.get(k));
      return;
    }
    if (sec.head && k === CARRY && sec.items.every((b) => b.type !== 'todo' && emptyLine(b.text, sec.head.text))) return;
    kept.push(sec);
  });
  // 3. 畳んだ見出しを未確認の1行へ（無ければ抜け・重なりチェックの節を次に気をつけることの前に作る）
  // 0.11.0 点検の直し 1（R24）: AI の「未確認: なし」（畳む語だけの未確認の行）は、畳んだ見出しがあれば置き換え、無ければ行ごと落とす
  //（チェックの節がそれで空になれば節も落とす）。足すと「未確認: なし、予算（B）」になる
  const isEmptyUnconf = (b) => b.type !== 'heading' && /^未確認/.test(String(b.text || '').normalize('NFKC').replace(/^\*+/, '').trim()) && emptyLine(b.text, UNCONFIRMED_HEAD);
  {
    const ci = kept.findIndex((x) => x.head && key(x.head.text) === CHECK);
    if (ci >= 0 && !foldedNames.length) {
      kept[ci].items = kept[ci].items.filter((b) => !isEmptyUnconf(b));
      if (!kept[ci].items.length) kept.splice(ci, 1);
    }
  }
  if (foldedNames.length) {
    let check = kept.find((x) => x.head && key(x.head.text) === CHECK);
    if (!check) {
      check = { head: { id: newBlockId(), type: 'heading', text: '抜け・重なりチェック', cites: [] }, items: [] };
      const at = kept.findIndex((x) => x.head && key(x.head.text) === ADVICE);
      if (at < 0) kept.push(check); else kept.splice(at, 0, check);
    }
    const u = check.items.find((b) => /^未確認/.test(String(b.text || '').trim()) || isEmptyUnconf(b));
    if (u && isEmptyUnconf(u)) {
      u.text = `${UNCONFIRMED_HEAD}: ${foldedNames.join('、')}`;
    } else if (u) {
      const have = String(u.text);
      const add = foldedNames.filter((n) => !have.includes(n));
      if (add.length) u.text = `${have.replace(/[、,\s]+$/, '')}、${add.join('、')}`;
    } else {
      check.items.unshift({ id: newBlockId(), type: 'bullet', text: `${UNCONFIRMED_HEAD}: ${foldedNames.join('、')}`, cites: [] });
    }
  }
  // 4. 印
  let dropped = 0;
  const out = [];
  for (const sec of kept) {
    const k = sec.head ? key(sec.head.text) : '';
    if (sec.head) out.push(sec.head);
    let checks = 0;
    for (const b of sec.items) {
      if (k === CHECK && b.type !== 'heading') {
        if (/^未確認/.test(String(b.text || '').trim())) b.unconfirmed = true;
        else if (++checks > CHECK_MAX) { dropped++; continue; }
        b.mark = 'check';
      } else if (k === ADVICE && b.type !== 'heading') {
        b.mark = 'advice';
      } else if (MEMO_END.test(String(b.text || ''))) {
        b.mark = 'memo';
      }
      if (b.mark) { b.citeState = 'manual'; b.cites = []; }
      out.push(b);
    }
  }
  return { blocks: out, dropped, folded: foldedNames.length };
}

// ---------------------------------------------------------------- 画面の並び（V-2。D48・F26・決めたこと 27）
// 並べ替えは画面だけ（保存の順は変えない）。画面（app.html）に同じ VIEW_HEADS と orderForView・savedIndexForDrop の写しがあり、repo が同じ表で照らす
const VIEW_HEADS = deepFreeze({
  closing: CLOSING_HEADINGS.slice(0, 3),   // 決定事項・持ち越し・ToDo（この順で頭に）
  check: CLOSING_HEADINGS[3],
  advice: ADVICE_HEAD,
  type: [...new Set(MEMO_ORDER.flatMap((k) => MEMO_TYPES[k].headings.map((h) => h.name)))],
});
// blocks（保存の順）→ 画面の順の保存の番号の並び。節は見出しから次の見出しの前まで（見出しの前の行は型の節）。
// 締めの3つ → 型の見出しの節 → 抜け・重なりチェック → 次に気をつけること → それ以外の節（人が足した見出しなど）。節の中と同じ組の節の間は保存の順。
// 知らない見出しは、保存の順で締め・チェック・助言のどれかより前にあれば型の節（報告の名前など）、後ろなら「それ以外」（R17）。
// 型の見出しの無い前の版の要約は、締めの見出しが無ければ保存の順のまま
function orderForView(blocks, heads = VIEW_HEADS) {
  const k = (t) => String(t || '').normalize('NFKC').trim().replace(/^[■#*\s]+/, '').replace(/[*\s]+$/, '').replace(/\([^()]*\)$/, '').replace(/\s+/g, '');
  const closing = heads.closing.map(k);
  const types = new Set(heads.type.map(k));
  const CHECK = k(heads.check); const ADVICE = k(heads.advice);
  const list = Array.isArray(blocks) ? blocks : [];
  const secs = [];
  let cur = { rank: 3, idx: [] };
  let pastClose = false;
  list.forEach((b, i) => {
    if (b && b.type === 'heading') {
      secs.push(cur);
      const key = k(b.text);
      let rank;
      if (closing.includes(key)) rank = closing.indexOf(key);
      else if (key === CHECK) rank = 4;
      else if (key === ADVICE) rank = 5;
      else rank = !pastClose || types.has(key) ? 3 : 6;
      if (rank !== 3 && rank !== 6) pastClose = true;
      cur = { rank, idx: [i] };
    } else cur.idx.push(i);
  });
  secs.push(cur);
  return secs.map((x, n) => ({ ...x, n })).sort((a, b) => (a.rank - b.rank) || (a.n - b.n)).flatMap((x) => x.idx);
}
// つまみで落とした所 → block.move の toIndex。order は動かす行を除いた画面の順の保存の番号（動かす行を抜いた後の番号）、viewIdx は落とした所。
// 落とした所の次の行の保存の番号。最後（か後ろ）なら最後の行の保存の番号＋1、行が無ければ 0
function savedIndexForDrop(order, viewIdx) {
  const o = Array.isArray(order) ? order : [];
  if (!o.length) return 0;
  const i = Math.max(0, Math.trunc(Number(viewIdx) || 0));
  return i < o.length ? o[i] : o[o.length - 1] + 1;
}

// 作ったブロックの ID（store.newId と同じ形の b<数と英字>。純粋な部品なので乱数だけで作る）
function newBlockId() {
  return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

module.exports = {
  MEMO_TYPES, MEMO_ORDER, DEFAULT_MEMO, memoTypeOf, memoPreset, isUntouchedMemo, headingKey, presetLines, listMemoTypes,
  VIEW_HEADS, orderForView, savedIndexForDrop,
  CLOSING_HEADINGS, CLOSING_TEMPLATE, ADVICE_HEAD, ADVICE_TEMPLATE, MEMO_RULES, STAR_RULE, OUTPUT_RULE, CHECK_MAX, UNCONFIRMED_HEAD, MEMO_SUFFIX, REPORT_HEAD,
  fenceLines, sectionsOf, buildTemplate, markBlocks,
};
