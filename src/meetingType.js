/*
 * meetingType.js — 会議の種類（名前・説明・自動の判定の手がかり・選べる種類とプルダウンの群）
 *
 * 0.11.0 M-2（D42・P3）: 種類ごとの要約の書式（format）を外した。要約の書式は種類から決まるメモの型で、src/memoTypes.js の
 * buildTemplate の1か所で作る（締めの ToDo の節が ACTION_RULE を使い、そこがチェックボックス化と担当・期限の抽出の起点になる）。
 * アジェンダの雛形（agenda）は、前のページの手を付けていないメモを見分けるためと、担当・期限の裏付けから外すために残す。
 */
'use strict';

const ACTION_RULE = '（「- [ ] 内容（担当: ○○ / 期限: ○○）」の形式。'
  + '担当や期限が発言に無ければその項目は書かず、内容だけを記す）';

const TYPES = {
  standup: {
    label: '朝会・内部定例会',
    hint: '朝会・週次の定例など、各担当の報告が中心の社内の会議',
    agenda: '議題:\n・各担当の進捗報告\n・課題・相談ごと\n・決定事項の確認\n・次回までのアクション',
    keywords: ['朝会', '定例', '週次', 'デイリー', '日次', 'スタンドアップ', '進捗確認', '状況共有', 'レビュー会議'],
  },

  review: {
    label: '部会・報告会',
    hint: '月次部会や事業報告など、数値報告と方針決定を含む会議',
    agenda: '議題:\n・各チームの数値報告\n・全体への共有事項\n・審議・決定事項\n・アクションアイテム',
    keywords: ['部会', '報告会', '月次', '事業本部', '管理職会議', '経営', '本部報告'],
  },

  oneonone: {
    label: '1on1',
    hint: 'メンバーとの個別面談、キャリアの相談など',
    agenda: '話したいこと:\n・最近の調子・近況\n・困っていること\n・キャリア・今後のこと\n・会社・チームへの要望',
    // 同じ語を二度書くとその語だけ二重に加点され、他タイプの正当な一致に競り勝ってしまう。
    // 全角で入力されることがあるため「１ｏｎ１」も見る。
    keywords: ['1on1', '１ｏｎ１', '面談', 'キャリア', '打診', '個別', 'メンタリング', '評価面談', '就業状況'],
  },

  sales: {
    label: '商談',
    hint: '顧客・パートナーとの商談（協業の検討も）',
    agenda: '議題:\n・先方の状況・課題のヒアリング\n・こちらからの提案\n・価格・条件\n・次のステップ',
    keywords: ['商談', '協業', '提案', '見積', '契約', '再販', '価格', 'ベンダー選定', '紹介', 'ビジネス'],
  },

  interview: {
    label: '採用面接・事前面談',
    hint: '候補者の採用面接と、社内の人との事前面談（案件や異動の前）',
    agenda: '確認したいこと:\n・経歴・スキル\n・志望動機\n・条件面\n・候補者からの質問',
    keywords: ['面接', '顔合わせ', 'オンボーディング', '候補者', '選考', '入社', '採用面談', 'スキル確認', '事前面談'],
  },

  brainstorm: {
    label: 'ブレスト・意見交換',
    hint: 'アイデア出し、方針の議論、結論を急がない会議',
    agenda: 'テーマ:\n・アイデア出し\n・観点の整理\n・次に試すこと',
    keywords: ['ブレスト', '意見交換', 'アイデア', '検討会', 'ディスカッション', '壁打ち', '構想'],
  },

  // 0.11.0 M-1（D41・P4）: プレゼン形式。書式は M-2 で型の見出しに置き換える（それまでは一般・その他の書式）。アジェンダの雛形は作らない
  present: {
    label: 'プレゼン形式',
    hint: '提案や説明会など、発表と質疑が中心の会議',
    keywords: ['プレゼン', '発表', '説明会', 'デモ', '登壇', '提案発表'],
  },

  general: {
    label: '一般・その他',
    hint: '上記に当てはまらない会議',
    keywords: [],
  },
};

const ORDER = ['standup', 'review', 'oneonone', 'sales', 'interview', 'brainstorm', 'present', 'general'];
// 0.11.0 M-1（D43・D44）: 画面の「会議の種類」で選べる種類とプルダウンの群（<optgroup>）。並びはこの1か所
const SELECTABLE = Object.freeze(['standup', 'review', 'brainstorm', 'oneonone', 'interview', 'sales', 'present']);
const GROUPS = Object.freeze([
  Object.freeze({ label: '社内の会議', keys: Object.freeze(['standup', 'review', 'brainstorm']) }),
  Object.freeze({ label: '人と話す', keys: Object.freeze(['oneonone', 'interview']) }),
  Object.freeze({ label: '社外と話す', keys: Object.freeze(['sales', 'present']) }),
]);
const isSelectable = (v) => typeof v === 'string' && SELECTABLE.includes(v);
// 選べる鍵でなければ ''（「決まらなかった」。前の版の general もここで読み替える: P12）
const normalizeType = (v) => (isSelectable(v) ? v : '');
// 人と話す会議（1on1・面談と採用面接・顔合わせ）。MCP の箇所の検索は、頼まれたときだけ探す（0.10.0 T-2b・D51・問い Q17）。後の打ち合わせの質も同じ1か所を使う
const PERSONAL_TYPES = Object.freeze(['oneonone', 'interview']);

/**
 * タイトルと本文の冒頭から会議タイプを推定する。
 * タイトルは人が付けた明示的なラベルなので重く、本文は補助として軽く見る。
 */
const BODY_ONLY_MIN = 5;

function detectType(title, transcriptHead) {
  const t = String(title || '');
  const body = String(transcriptHead || '').slice(0, 1200);
  const scores = [];

  for (const key of ORDER) {
    if (key === 'general') continue;
    let total = 0; let title_ = 0; let longest = 0;
    for (const kw of TYPES[key].keywords) {
      if (t.includes(kw)) {
        total += 3;                        // タイトル一致は強い根拠
        title_ += 3;
        longest = Math.max(longest, kw.length);
      }
      if (body.includes(kw)) total += 1;   // 本文一致は補助
    }
    if (total > 0) scores.push({ key, total, title: title_, longest });
  }
  if (scores.length === 0) return 'general';

  scores.sort((a, b) => (b.total - a.total)
    // 同点なら、より長い（＝具体的な）語で当たった方を採る。
    // 「採用面談」は interview の『採用面談』と oneonone の『面談』の両方に当たるが、
    // 長い方が書き手の意図に近い。
    || (b.longest - a.longest));

  const best = scores[0];
  // タイトルに手がかりがあればそれを信じる。
  // 本文だけの一致は「提案」「価格」のような一般語でも起きるため、
  // よほど数が揃わない限り型を決める根拠にはしない（誤った型を当てない）。
  if (best.title > 0) return best.key;
  if (best.total >= BODY_ONLY_MIN) return best.key;
  return 'general';
}

// 0.11.0 M-5（P14 (a)・決めたこと 13）: 題名と文字起こしで決まらない会議に使う、前の同じ曜日・時刻の会議の種類。
// rows は人が選んだ種類の会議 [{ createdAt, meetingType }]。過去 5 週・同じ曜日・開始が ±15 分の会議が2回以上あり、どれも同じ選べる種類なら
// その種類。ほかは ''（ばらばら・1回だけ・選べない種類）。曜日と時刻は PC の時計で見る
const SLOT_DAYS = 35;
const SLOT_MIN = 15;
function slotType(rows, createdAt) {
  const now = new Date(createdAt);
  if (!Array.isArray(rows) || Number.isNaN(now.getTime())) return '';
  const min = (d) => d.getHours() * 60 + d.getMinutes();
  const hit = rows.filter((r) => {
    const d = new Date(r && r.createdAt);
    if (Number.isNaN(d.getTime()) || d >= now || now - d > SLOT_DAYS * 86400000) return false;
    return d.getDay() === now.getDay() && Math.abs(min(d) - min(now)) <= SLOT_MIN;
  });
  if (hit.length < 2) return '';
  const t = hit[0].meetingType;
  return isSelectable(t) && hit.every((r) => r.meetingType === t) ? t : '';
}

function getLabel(type) {
  return (TYPES[type] || TYPES.general).label;
}
// タイプを選んだときにメモ欄へ入れるアジェンダの雛形。
// 一般・その他には無い（何を話すか決まっていない会議に雛形を押し付けない）。
function getAgenda(type) {
  return (TYPES[type] && TYPES[type].agenda) || '';
}
function listTypes() {
  return ORDER.map((k) => ({ key: k, label: TYPES[k].label, hint: TYPES[k].hint, agenda: TYPES[k].agenda || '' }));
}

module.exports = { TYPES, ORDER, SELECTABLE, GROUPS, PERSONAL_TYPES, ACTION_RULE, isSelectable, normalizeType, detectType, slotType, getLabel, getAgenda, listTypes };
