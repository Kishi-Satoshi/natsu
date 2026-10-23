/*
 * shots/pill-states.js — 録音バー（0.9.0 O-3・設計書 D25・RP9）を撮る画面の見本の表。純粋（Electron を読まない）。
 *
 * 撮る道具（tools/shots/screens.js・main.js）は、録音を始めずに見た目だけを撮る（マイクを開かない）。そのため、各状態の見た目を
 * 録音バーの DOM に直に当てる act（actFor）を作る。act が本物の録音バーとずれないよう、test/stage090.overlay.test.js が
 * 本物の録音バー（overlay.html を simrun で走らせたもの）を同じ状態にしたときの DOM と、act を当てた DOM を signature で比べる。
 *
 * 状態 × 形（横 h・縦 v）× 地（撮るときだけ体の地に塗る明るい・暗いデスクトップ。製品の体は透明）× 拡大率（100・150%）。
 */
'use strict';

const FORMS = ['h', 'v'];
const DESKS = { light: '#f3f3f3', dark: '#1f1f1f' };
const SCALES = [1, 1.5];
// 見本の音の大きさ（rec・dict は声あり。点の長さは overlay.html の levelDots と同じ計算: dotsFor）
const VOICE = 0.6;
// state: 名前。mode: 議事録 meeting・音声入力 dictation。phase: 段階（data-phase）。level: 点の音の大きさ。paused・warn: #pill の印。
// badge: 代替のマイクの角の点（0.9.4 P-1: 縦の形で相手の声を録れないときも）。msg: 一時的な文（形ごと。縦は overlay.html の upright と同じ縦向きの字: 0.9.0 見た目の直し）と kind。
// 0.9.4 P-1 で意図して変えた: 相手の声の印（spk）と完了の状態（done。✓ と「保存しました」を出さず薄く消える: 撮る形が無い）を外した
const STATES = [
  { state: 'rec', mode: 'meeting', phase: 'recording', level: VOICE },
  { state: 'silent', mode: 'meeting', phase: 'recording', level: 0 },
  { state: 'paused', mode: 'meeting', phase: 'recording', level: 0, paused: true },
  { state: 'proc', mode: 'meeting', phase: 'processing', level: 0, msg: { h: '議事録を作成中…', v: '作成中︙' }, kind: '' },
  { state: 'error', mode: 'meeting', phase: 'error', level: 0, msg: { h: '議事録を保存できませんでした', v: 'エラ︱' }, kind: 'err', title: { v: '議事録を保存できませんでした' } },
  { state: 'dict', mode: 'dictation', phase: 'recording', level: VOICE },
  { state: 'warn', mode: 'meeting', phase: 'recording', level: 0, warn: true, msg: { h: '音が入っていません', v: '音が入っていません' }, kind: 'warn' },
  { state: 'fallback', mode: 'meeting', phase: 'recording', level: VOICE, badge: true, msg: { h: '既定のマイクで録音中', v: '既定のマイクで録音中' }, kind: 'warn' },
  // 0.9.4 P-1（Q24・F4）: 相手の声を録れない文は録音中ずっと。縦の形は文の代わりに角の黄色い点と説明の文（title）
  { state: 'spk-ng', mode: 'meeting', phase: 'recording', level: VOICE, badge: { v: true }, msg: { h: '相手の声を録れません', v: '相手の声を録れません' }, kind: 'warn', title: { v: '相手の声を録れません' } },
  // 0.9.1 Q-5（計画 docs/plans/2026-10-21-091.md の決めたこと 10）: 話し声が無いので main が overlay:phase の recording の文で聞いた形（無音の警告の黄色い点のまま、文は赤の短い文）
  { state: 'quiet', mode: 'meeting', phase: 'recording', level: 0, warn: true, msg: { h: '会議は終わりましたか？', v: '会議は終わりましたか？' }, kind: 'err' },
];
const byState = Object.fromEntries(STATES.map((s) => [s.state, s]));
// 0.9.0 O-4（RP8）: 縦の形の × が出た形（カーソルが乗った記録中）を、暗い地・150% で1枚だけ撮る（モックの overlay-vertical-dark-hover-150）
const HOVER = { name: 'overlay-vertical-dark-hover-150', state: 'rec', form: 'v', desk: 'dark', scale: 1.5 };

// overlay.html の levelBars と同じ（0.9.4 W-1: 無音は 4px が5つ、声は5本がそれぞれ揺れる）。撮る画面は時刻 0 の形（揺れの1つの瞬間）
const { levelBars } = require('../../src/mainlib');
function dotsFor(level, paused) {
  if (paused) return [4, 4, 4, 4, 4];
  return levelBars(level, 0);
}

/** 撮る画面の名前（形 → 地 → 拡大率 → 状態の順。撮る道具は形・地・拡大率の組ごとに窓を1つ開いて状態を替える） */
function screenNames() {
  const out = [];
  for (const form of FORMS) for (const desk of Object.keys(DESKS)) for (const scale of SCALES) for (const s of STATES) {
    out.push(`overlay-${form}-${desk}-${s.state}-${Math.round(scale * 100)}`);
  }
  out.push(HOVER.name);
  return out;
}

/**
 * 状態を録音バーの DOM に当てる文（executeJavaScript で流す）。当てるものは毎回全部決め直す（同じ窓で状態を替えて撮る）。
 * 時間は決まった見本（12:34）。撮るときだけ体の地にデスクトップの色を塗る（製品の体は透明）
 */
function actFor(state, form, desk, hover = false) {
  const s = byState[state];
  if (!s) throw new Error(`pill-states: 状態 ${state} が無い`);
  const d = {
    form, phase: s.phase, meeting: s.mode === 'meeting', paused: Boolean(s.paused), warn: Boolean(s.warn),
    dots: dotsFor(s.level, s.paused), badge: s.badge && typeof s.badge === 'object' ? Boolean(s.badge[form]) : Boolean(s.badge),
    msg: s.msg ? s.msg[form] : '', kind: s.msg ? s.kind : '', title: s.title && s.title[form] ? s.title[form] : '',
    desk: DESKS[desk] || '', hover: Boolean(hover),
  };
  return `(() => {
  const d = ${JSON.stringify(d)};
  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); el.hidden = !on; };
  if (d.desk) document.body.style.background = d.desk;
  const p = $('pill');
  p.dataset.form = d.form;
  p.dataset.phase = d.phase;
  for (const [c, on] of [['visible', true], ['meeting', d.meeting], ['paused', d.paused], ['warn', d.warn], ['hover', d.hover]]) p.classList.toggle(c, on);
  show($('hideBtn'), d.form === 'v');
  if (d.title) p.setAttribute('title', d.title); else p.removeAttribute('title');
  Array.from($('lv').children).forEach((el, i) => el.style.setProperty('--l', d.dots[i] + 'px'));
  show($('micBadge'), d.badge);
  $('timer').textContent = '12:34';
  const m = $('status');
  m.textContent = d.msg;
  for (const c of ['warn', 'err', 'ok']) m.classList.toggle(c, Boolean(d.msg) && d.kind === c);
  show($('pauseBtn'), d.meeting);
  show($('ngBtn'), !d.meeting);
  return 1;
})()`;
}

/** 録音バーの DOM の見える所の要約（test/stage090.overlay.test.js が本物と act を比べる）。時間は比べない */
function signature(doc) {
  const $ = (id) => doc.getElementById(id);
  const p = $('pill');
  const m = $('status');
  const hidden = (el) => el.hidden === true;
  return {
    form: p.dataset.form, phase: p.dataset.phase,
    classes: ['visible', 'meeting', 'paused', 'warn', 'hover'].filter((c) => p.classList.contains(c)),
    title: p.getAttribute('title') || '',
    // 0.9.4 W-1 で意図して変えた: 声の点は時刻で揺れる（本物と見本で同じ瞬間にならない）ので、同じ 4px の点か揺れている（voice）かで比べる。
    // 高さの式は test/stage094.wave が mainlib・overlay.html・見本の3つで同じことを見る
    dots: ((d) => (d.every((x) => x === '4px') ? d : 'voice'))(Array.from($('lv').children).map((i) => i.style.getPropertyValue('--l'))),
    badge: !hidden($('micBadge')),
    msg: m.textContent, kind: ['warn', 'err', 'ok'].find((c) => m.classList.contains(c)) || '',
    pauseShown: !hidden($('pauseBtn')), ngShown: !hidden($('ngBtn')), hideShown: !hidden($('hideBtn')),
  };
}

module.exports = { FORMS, DESKS, SCALES, STATES, HOVER, byState, dotsFor, screenNames, actFor, signature };
