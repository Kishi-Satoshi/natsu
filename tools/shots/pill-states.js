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
// spk: 相手の声の印（'' は出さない）。badge: 代替のマイクの角の点。msg: 一時的な文（形ごと）と kind
const STATES = [
  { state: 'rec', mode: 'meeting', phase: 'recording', level: VOICE, spk: 'on' },
  { state: 'silent', mode: 'meeting', phase: 'recording', level: 0, spk: 'idle' },
  { state: 'paused', mode: 'meeting', phase: 'recording', level: 0, spk: 'idle', paused: true },
  { state: 'proc', mode: 'meeting', phase: 'processing', level: 0, spk: '', msg: { h: '議事録を作成中…', v: '作成中…' }, kind: '' },
  { state: 'done', mode: 'meeting', phase: 'done', level: 0, spk: '', msg: { h: '議事録を保存しました', v: '保存しました' }, kind: 'ok' },
  { state: 'error', mode: 'meeting', phase: 'error', level: 0, spk: '', msg: { h: '議事録を保存できませんでした', v: 'エラー' }, kind: 'err', title: { v: '議事録を保存できませんでした' } },
  { state: 'dict', mode: 'dictation', phase: 'recording', level: VOICE, spk: '' },
  { state: 'warn', mode: 'meeting', phase: 'recording', level: 0, spk: '', warn: true, msg: { h: '音が入っていません', v: '音が入っていません' }, kind: 'warn' },
  { state: 'fallback', mode: 'meeting', phase: 'recording', level: VOICE, spk: '', badge: true, msg: { h: '既定のマイクで録音中', v: '既定のマイクで録音中' }, kind: 'warn' },
  { state: 'spk-ng', mode: 'meeting', phase: 'recording', level: VOICE, spk: 'ng', msg: { h: '相手の声を録れません', v: '相手の声を録れません' }, kind: 'warn' },
];
const byState = Object.fromEntries(STATES.map((s) => [s.state, s]));

// overlay.html の levelDots と同じ（無音は 4px が5つ、声は左ほど早く伸びて 16px まで）
const DOT_W = [1, 0.85, 0.7, 0.55, 0.4];
function dotsFor(level, paused) {
  if (paused || !(level > 0.02)) return [4, 4, 4, 4, 4];
  return DOT_W.map((w) => Math.round(4 + 12 * Math.min(1, level * 1.6 * w)));
}

/** 撮る画面の名前（形 → 地 → 拡大率 → 状態の順。撮る道具は形・地・拡大率の組ごとに窓を1つ開いて状態を替える） */
function screenNames() {
  const out = [];
  for (const form of FORMS) for (const desk of Object.keys(DESKS)) for (const scale of SCALES) for (const s of STATES) {
    out.push(`overlay-${form}-${desk}-${s.state}-${Math.round(scale * 100)}`);
  }
  return out;
}

/**
 * 状態を録音バーの DOM に当てる文（executeJavaScript で流す）。当てるものは毎回全部決め直す（同じ窓で状態を替えて撮る）。
 * 時間は決まった見本（12:34）。撮るときだけ体の地にデスクトップの色を塗る（製品の体は透明）
 */
function actFor(state, form, desk) {
  const s = byState[state];
  if (!s) throw new Error(`pill-states: 状態 ${state} が無い`);
  const d = {
    form, phase: s.phase, meeting: s.mode === 'meeting', paused: Boolean(s.paused), warn: Boolean(s.warn),
    dots: dotsFor(s.level, s.paused), spk: s.spk, badge: Boolean(s.badge),
    msg: s.msg ? s.msg[form] : '', kind: s.msg ? s.kind : '', title: s.title && s.title[form] ? s.title[form] : '',
    desk: DESKS[desk] || '',
  };
  return `(() => {
  const d = ${JSON.stringify(d)};
  const $ = (id) => document.getElementById(id);
  const show = (el, on) => { if (on) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); el.hidden = !on; };
  if (d.desk) document.body.style.background = d.desk;
  const p = $('pill');
  p.dataset.form = d.form;
  p.dataset.phase = d.phase;
  for (const [c, on] of [['visible', true], ['meeting', d.meeting], ['paused', d.paused], ['warn', d.warn]]) p.classList.toggle(c, on);
  if (d.title) p.setAttribute('title', d.title); else p.removeAttribute('title');
  Array.from($('lv').children).forEach((el, i) => el.style.setProperty('--l', d.dots[i] + 'px'));
  const spk = $('spk');
  show(spk, Boolean(d.spk));
  for (const c of ['on', 'idle', 'ng']) spk.classList.toggle(c, d.spk === c);
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
  const spk = $('spk');
  const m = $('status');
  const hidden = (el) => el.hidden === true;
  return {
    form: p.dataset.form, phase: p.dataset.phase,
    classes: ['visible', 'meeting', 'paused', 'warn'].filter((c) => p.classList.contains(c)),
    title: p.getAttribute('title') || '',
    dots: Array.from($('lv').children).map((i) => i.style.getPropertyValue('--l')),
    spk: hidden(spk) ? '' : (['on', 'idle', 'ng'].find((c) => spk.classList.contains(c)) || ''),
    badge: !hidden($('micBadge')),
    msg: m.textContent, kind: ['warn', 'err', 'ok'].find((c) => m.classList.contains(c)) || '',
    pauseShown: !hidden($('pauseBtn')), ngShown: !hidden($('ngBtn')),
  };
}

module.exports = { FORMS, DESKS, SCALES, STATES, byState, dotsFor, screenNames, actFor, signature };
