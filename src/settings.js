/*
 * settings.js — 設定値の正規化
 *
 * 以前は settings:save のときだけ範囲に収めていたので、ディスク上の settings.json を
 * 手で壊した（ポートが文字列・範囲外）ときに、起動直後の値だけが正規化を
 * すり抜け、エンジンの起動待ちが TypeError で静かに失敗していた。
 * 読み込みと保存の両方がここを通る。Electron に依存しないので単体で検査できる。
 *
 * 第1a回（設計書 JS6・RF23）で、30 のキーそれぞれの決まりの表（SETTING_RULES）と、
 * 項目ごとの読み方（readSettings）、保存の許可の一覧（pickSavable）、既定（defaultSettings）を足した。
 * - 読み方: 無いキーは黙って既定で埋める。壊れた項目だけを直す。知らないキーは消さずに残す
 *   （古い版に戻したときに新しい版の設定が消えない）。dataDir は今どおり捨てる（REMOVED_KEYS）。
 * - 数の欄の直し方は今の normalizeSettings をそのまま芯に使う（'8080' は 8080、範囲の外は端）。
 * - maxHistory の壊れた値（負・小数・文字）は端に寄せず既定の 500 に戻す。-1 を 0 に寄せると、
 *   次の口述で履歴を 0 件に切り詰めて全部消してしまうため（F8）。0 は手で書いた人の値として残す。
 * - オンとオフの欄は今のコードの判定のまま真偽値に直す。useBuiltinTerms だけは
 *   「false でなければオン」（main.js の buildKey の settings.useBuiltinTerms !== false、
 *   mainlib.js の buildPromptParts の useBuiltinTerms !== false）、ほかは「値があればオン」。
 *   "false" のような文字は今もオンなので、オンのままにして知らせのための印（falseLike）を返す。
 *
 * 第1c回 Task C-1（OL7・RF30）で、オンラインの処理の5つのキーを足した（35 のキー）。
 * - cloudTranscribe の壊れた値は「送らない」側の ask に戻す（true や "yes" を on と読んで、黙って音声を送らない）。
 * - 鍵（API キー）は設定に置かない（secrets.json に暗号でしまう。第1c回 Task A-3）。鍵らしい欄は
 *   表に無いので pickSavable が捨てる（表に無いキーを捨てる今の決まりのまま）。
 */
'use strict';

// 外した設定キー。古い settings.json に残っていても読まず、書き戻さない（値のフォルダも開かない）
//   dataDir: データ保存先の変更（#29）。保存先は userData/data だけにした（第0a回 R6）
const REMOVED_KEYS = ['dataDir'];

// 整数に直して範囲に収める。数にならない値と 0 は既定へ（0 は打ち間違い）
function clampInt(v, min, max, fallback) {
  return Math.max(min, Math.min(max, parseInt(v, 10) || fallback));
}
// 0 を有効な値として受ける版（engineIdleMin の 0 = 「止めない」）。数にならない値だけ既定へ
function clampIntOrZero(v, min, max, fallback) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : Math.max(min, Math.min(max, n));
}

// raw: 既定値を重ねた後の設定。defaults: 壊れた値を戻す先（DEFAULT_SETTINGS）。
// 入力は書き換えず、新しいオブジェクトを返す。
function normalizeSettings(raw, defaults) {
  const s = { ...raw };
  const d = defaults || {};
  s.dictionary = Array.isArray(s.dictionary)
    ? s.dictionary.map((w) => String(w ?? '').trim()).filter(Boolean) : [];
  s.localPort = clampInt(s.localPort, 1024, 65535, d.localPort || 8990);
  s.sumPort = clampInt(s.sumPort, 1024, 65535, d.sumPort || 8991);
  s.localThreads = clampInt(s.localThreads, 1, 64, d.localThreads || 4);
  s.sumThreads = clampInt(s.sumThreads, 1, 64, d.sumThreads || 4);
  s.segmentSec = clampInt(s.segmentSec, 20, 300, d.segmentSec || 75);
  // 第3段（v0.11.0）で足した 2 つ。古い settings.json には無いので既定で埋める
  s.sumCtx = clampInt(s.sumCtx, 4096, 131072, d.sumCtx || 16384);              // 要約の文脈長（#41。既定は第0b回で 16384）
  s.engineIdleMin = clampIntOrZero(s.engineIdleMin, 0, 120, d.engineIdleMin ?? 10);   // 使われないエンジンを止めるまでの分（#58）
  for (const k of REMOVED_KEYS) delete s[k];
  return s;
}

// 録音バーの表示位置。app.html の #pillPos の選択肢と同じ
const PILL_POSITIONS = ['bottom', 'top', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
const THEMES = ['system', 'light', 'dark'];
// 第1c回: オンラインの文字起こしの同意（ask = まだ聞いていない＝送らない）と送り先
const CLOUD_CONSENTS = ['ask', 'on', 'off'];
const STT_PROVIDERS = ['groq', 'openai', 'custom'];

// 既定の設定（第1a回まで main.js の DEFAULT_SETTINGS に書いていた 30 のキーと値に、第1c回の5つを足した 35）。
// スレッド数は CPU の数から 2 を引いた数（4 より少なくしない）
function defaultSettings(cpuCount) {
  const threads = Math.max(4, cpuCount - 2);
  return {
    localServerExe: '',
    localModelPath: '',
    localPort: 8990,
    localThreads: threads,
    vadModelPath: '',
    useVad: true,
    suppressNst: true,
    sumServerExe: '',
    sumModelPath: '',
    sumPort: 8991,
    sumThreads: threads,
    language: 'ja',
    hotkey: 'Control+Shift+Space',
    meetingHotkey: 'Alt+M',
    micId: '',
    pillPos: 'bottom',
    pillCustom: null,
    autoPaste: true,
    removeFillers: true,
    soundFeedback: true,
    autoLaunch: false,
    // 画面の配色。system は Windows の設定に追従する
    theme: 'system',
    // ウィンドウを閉じたときにタスクトレイへ残すか。既定は残さない＝そのまま終了。
    stayInTray: false,
    dictionary: [],
    // 業務日本語の既定語彙をエンジンへ渡すか。dictionary の既定を非空にすると、
    // 既に [] を保存済みの環境には既定値が届かないので、別のキーで持つ。
    useBuiltinTerms: true,
    // 議事録のときだけ、パソコンから出ている音（Web会議の相手の声）も録る。
    // 既定は false。同席者の声を残すかどうかは、その場で人が決めること。
    useSystemAudio: false,
    maxHistory: 500,
    segmentSec: 75,
    // 要約エンジン（llama-server）の文脈長（-c）。統合プロンプトがこれに収まらないときは
    // 要点メモを 2 段で畳む（#41。generateMinutes）
    // 既定は 16384（第0b回 Task 16）。長い会議も分けて要約し（CHUNK 5500 字）、要点メモを畳む（foldNotes）ので、
    // 実際の一番長いプロンプトは約 6,000〜12,000 トークン。16384 から出力の上限 3000 と余白 256 を引いた
    // 13,128 トークンに収まる。保存済みの値（今までの PC の 32768 など）は書き換えない
    sumCtx: 16384,
    // 使われないエンジンを止めるまでの分。0 = 止めない（#58。releaseIdleEngines）
    engineIdleMin: 10,
    // 第1c回（OL7）: オンラインのときの文字起こし。既定は ask（同意を聞くまでは送らない＝手元の whisper）
    cloudTranscribe: 'ask',
    // 送り先（groq は無料枠。openai・custom を選べる）。custom のときだけ sttBaseUrl を使う
    sttProvider: 'groq',
    sttBaseUrl: '',
    // 空なら送り先ごとの既定のモデル
    sttModel: '',
    // 空なら Claude Code を探す（第1c回 Task B-1 の findClaude）
    claudeExe: '',
  };
}

// 35 のキーの決まり。label は設定の画面の言葉（知らせに出す名前。キーの名前は画面に出さない）。
// kind ごとの直し方は下の FIX。ここに無いキーは既定にも保存の許可の一覧にも入れない（テストが一致を見る）
//   int:      normalizeSettings が整数に直して範囲に収める（範囲は normalizeSettings の中だけに書く）
//   history:  0〜10000 の整数。10000 を越えたら 10000、それ以外の壊れた値は既定（0 に寄せない。F8）
//   string:   文字列。違えば ''
//   language: auto か英小文字 2〜3 字。違えば 'ja'
//   hotkey:   空でない文字列（本当の確かめは今どおり登録で）。違えば既定
//   enum:     values のどれか。違えば既定（形が違うときの why は typeWhy があればそれ。theme は計画の表のとおり enum だけ）
//   point:    null か、x・y が有限の数の { x, y }。違えば null
//   bool:     真偽値。今の判定で直す（notFalse は「false でなければオン」、ほかは「値があればオン」）
//   words:    normalizeSettings が文字の並びに整える。配列でなければ []
//   url:      空か、https:// で始まる 2048 字までの URL（http は 127.0.0.1・localhost だけ）。違えば ''
//   model:    空か、英数字と . _ : / - の 100 字まで（送り先のモデルの名前）。違えば ''
//   exe:      文字列。.cmd・.bat・.ps1 で終われば ''（shell を通さないと起こせないので使わない。F12。大小を問わない）。
//             string の kind は全部のパスの欄が共有するので、この決まりは claudeExe の exe にだけ入れる
const SETTING_RULES = {
  localServerExe: { label: 'whisper-server.exe のパス', kind: 'string' },
  localModelPath: { label: '文字起こしのモデルファイルのパス', kind: 'string' },
  localPort: { label: '文字起こしのポート', kind: 'int' },
  localThreads: { label: '文字起こしのスレッド数', kind: 'int' },
  vadModelPath: { label: 'VADモデルのパス', kind: 'string' },
  useVad: { label: 'VAD（無音スキップ）を使う', kind: 'bool' },
  suppressNst: { label: '非発話トークンを抑制する', kind: 'bool' },
  sumServerExe: { label: 'llama-server.exe のパス', kind: 'string' },
  sumModelPath: { label: '要約のモデルファイルのパス', kind: 'string' },
  sumPort: { label: '要約のポート', kind: 'int' },
  sumThreads: { label: '要約のスレッド数', kind: 'int' },
  language: { label: '認識言語', kind: 'language' },
  hotkey: { label: '音声入力ホットキー', kind: 'hotkey' },
  meetingHotkey: { label: '議事録ホットキー', kind: 'hotkey' },
  micId: { label: '使用するマイク', kind: 'string' },
  pillPos: { label: '録音バーの表示位置', kind: 'enum', values: PILL_POSITIONS },
  pillCustom: { label: '録音バーを動かした位置', kind: 'point' },
  autoPaste: { label: '文字起こし後、カーソル位置へ自動貼り付け', kind: 'bool' },
  removeFillers: { label: 'フィラー除去', kind: 'bool' },
  soundFeedback: { label: '効果音', kind: 'bool' },
  autoLaunch: { label: 'Windowsサインイン時に自動起動', kind: 'bool' },
  theme: { label: '画面の配色', kind: 'enum', values: THEMES, typeWhy: 'enum' },
  stayInTray: { label: 'ウィンドウを閉じてもタスクトレイに残す', kind: 'bool' },
  dictionary: { label: 'ユーザー辞書', kind: 'words' },
  useBuiltinTerms: { label: '業務でよく使う言葉のヒントも渡す', kind: 'bool', notFalse: true },
  useSystemAudio: { label: '議事録で相手の声も録る', kind: 'bool' },
  maxHistory: { label: '音声入力の履歴の件数', kind: 'history', max: 10000 },
  segmentSec: { label: '議事録の文字起こし間隔（秒）', kind: 'int' },
  sumCtx: { label: '要約の文脈長', kind: 'int' },
  engineIdleMin: { label: '使わないエンジンを止めるまで（分）', kind: 'int' },
  // 第1c回（OL7）
  cloudTranscribe: { label: 'オンラインの文字起こし', kind: 'enum', values: CLOUD_CONSENTS, typeWhy: 'enum' },
  sttProvider: { label: '文字起こしの送り先', kind: 'enum', values: STT_PROVIDERS, typeWhy: 'enum' },
  sttBaseUrl: { label: '送り先の URL（そのほか）', kind: 'url', max: 2048 },
  sttModel: { label: '送り先のモデル', kind: 'model' },
  claudeExe: { label: 'Claude Code の場所', kind: 'exe' },
};
const SETTING_KEYS = Object.keys(SETTING_RULES);

// 数の文字も数として受ける（'300' は 300）。数にならなければ NaN
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}
const FALSE_LIKE = /^(false|0|off|no)$/i;

// sttBaseUrl に使える URL か。https のほかは、手元の試し用に http の 127.0.0.1・localhost だけ。
// 文字の頭と、URL として読んだ結果の両方で見る（http://localhost.example のような名前を通さない）
function isSttBaseUrl(v, max) {
  if (v.length > max) return false;
  let u;
  try { u = new URL(v); } catch { return false; }
  if (/^https:\/\//.test(v)) return u.protocol === 'https:' && u.hostname !== '';
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(v)
    && u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
}
const MODEL_RE = /^[A-Za-z0-9._:\/-]{1,100}$/;
// Windows は名前の後ろの空白と . を無視して開くので（claude.cmd. は claude.cmd）、それも外して見る
const SHELL_ONLY_RE = /\.(cmd|bat|ps1)[\s.]*$/i;

// kind ごとの直し方。(v: 書かれていた値, ctx) → { value, why }（why が null なら直していない）
//   ctx.norm: normalizeSettings を通した値（int・words の芯）、ctx.def: 既定、ctx.rule: 決まり
const FIX = {
  int(v, { norm }) {
    if (String(v) === String(norm)) return { value: norm, why: null };
    return { value: norm, why: Number.isFinite(toNumber(v)) ? 'range' : 'type' };
  },
  history(v, { def, rule }) {
    const n = toNumber(v);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return { value: def, why: 'type' };
    if (n > rule.max) return { value: rule.max, why: 'range' };
    if (n < 0) return { value: def, why: 'range' };   // 0 に寄せない（F8）
    return { value: n, why: null };
  },
  string(v) {
    return typeof v === 'string' ? { value: v, why: null } : { value: '', why: 'type' };
  },
  language(v) {
    return typeof v === 'string' && /^(auto|[a-z]{2,3})$/.test(v) ? { value: v, why: null } : { value: 'ja', why: 'enum' };
  },
  hotkey(v, { def }) {
    if (typeof v !== 'string') return { value: def, why: 'type' };
    return v.trim() ? { value: v, why: null } : { value: def, why: 'empty' };
  },
  enum(v, { def, rule }) {
    if (typeof v !== 'string') return { value: def, why: rule.typeWhy || 'type' };
    return rule.values.includes(v) ? { value: v, why: null } : { value: def, why: 'enum' };
  },
  point(v) {
    if (v === null) return { value: null, why: null };
    const ok = isSettingsShape(v) && Number.isFinite(v.x) && Number.isFinite(v.y);   // Number.isFinite は数の型だけ真
    return ok ? { value: { x: v.x, y: v.y }, why: null } : { value: null, why: 'type' };
  },
  bool(v, { rule }) {
    if (typeof v === 'boolean') return { value: v, why: null };
    return { value: rule.notFalse ? v !== false : Boolean(v), why: 'type' };
  },
  words(v, { norm }) {
    return { value: norm, why: Array.isArray(v) ? null : 'type' };
  },
  url(v, { rule }) {
    if (typeof v !== 'string') return { value: '', why: 'type' };
    return v === '' || isSttBaseUrl(v, rule.max) ? { value: v, why: null } : { value: '', why: 'enum' };
  },
  model(v) {
    if (typeof v !== 'string') return { value: '', why: 'type' };
    return v === '' || MODEL_RE.test(v) ? { value: v, why: null } : { value: '', why: 'enum' };
  },
  exe(v) {
    if (typeof v !== 'string') return { value: '', why: 'type' };
    return SHELL_ONLY_RE.test(v) ? { value: '', why: 'enum' } : { value: v, why: null };
  },
};

// raw: settings.json から読んだ普通のオブジェクト（形の確かめは呼び手が isSettingsShape で済ませる）。
// defaults: 既定（defaultSettings の結果）。raw も defaults も書き換えない。
// → { settings, repaired: [{ key, why }], falseLike: [{ key, raw }] }
//   repaired にはオンとオフの欄を真偽値に直したものも入る（記録にキーの名前を書くため）
function readSettings(raw, defaults) {
  const d = defaults || {};
  const norm = normalizeSettings({ ...d, ...raw }, d);   // 知らないキーは残り、REMOVED_KEYS は消える
  const settings = { ...norm };
  const repaired = [];
  const falseLike = [];
  for (const key of SETTING_KEYS) {
    const rule = SETTING_RULES[key];
    if (!Object.hasOwn(raw, key) || raw[key] === undefined) {
      // 無いキーは黙って既定（int・words は normalizeSettings が既定から整えた値）
      settings[key] = (rule.kind === 'int' || rule.kind === 'words') ? norm[key] : cloneDefault(d[key]);
      continue;
    }
    const v = raw[key];
    const { value, why } = FIX[rule.kind](v, { norm: norm[key], def: cloneDefault(d[key]), rule });
    settings[key] = value;
    if (why) repaired.push({ key, why });
    if (rule.kind === 'bool' && typeof v === 'string' && FALSE_LIKE.test(v.trim())) falseLike.push({ key, raw: v });
  }
  return { settings, repaired, falseLike };
}

// 既定の値を、呼び手が書き換えても既定に響かない形で返す（pillCustom・dictionary のため）
function cloneDefault(v) {
  if (Array.isArray(v)) return [...v];
  if (v && typeof v === 'object') return { ...v };
  return v;
}

// 普通のオブジェクトか（null・配列・文字・数は偽）
function isSettingsShape(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

// 保存の許可の一覧。画面から来た next の自分の欄のうち、決まりのあるキーだけを返す
// （Object.hasOwn で引くので __proto__・constructor は通らない。dataDir も決まりが無いので通らない）
function pickSavable(next) {
  const out = {};
  if (!isSettingsShape(next)) return out;
  for (const key of SETTING_KEYS) if (Object.hasOwn(next, key)) out[key] = next[key];
  return out;
}

module.exports = {
  normalizeSettings, REMOVED_KEYS, PILL_POSITIONS, defaultSettings, SETTING_RULES, SETTING_KEYS,
  readSettings, pickSavable, isSettingsShape,
};
