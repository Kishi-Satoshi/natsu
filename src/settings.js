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
 * - cloudTranscribe の壊れた値を ask に戻す決まりがあったが、0.7.0 U-1 で外した（下の段落）。
 * - 鍵（API キー）は設定に置かない（secrets.json に暗号でしまう。第1c回 Task A-3）。鍵らしい欄は
 *   表に無いので pickSavable が捨てる（表に無いキーを捨てる今の決まりのまま）。
 *
 * 0.7.0 U-1（設計書 D5・D7。計画 docs/plans/2026-10-19-ui07.md）で、送り先と同意の4つのキー（cloudTranscribe・sttProvider・
 * sttBaseUrl・sttModel）を表と既定から外した（31 のキー）。送り先は OpenAI に固定で、同意は登録の利用規約で取る。
 * 前の版が書いた値は「知らないキー」として読まず・直さず・消さない（0.6.0 に戻したときに前の選択が戻る）。画面からは保存させない。
 *
 * 第1d回 A-2（RL10）で、ログイン中のメールアドレス accountEmail を足した（32 のキー）。書くのは main のログインの IPC だけ
 * （settings:save は画面から来た値を使わない）。札（トークン）は設定に置かない（secrets.json に暗号でしまう）。
 *
 * 0.9.0 O-1（設計書 D25・RP1・RP2。計画 docs/plans/2026-10-20-090.md）で、録音バーの置き場所を8つの名前の pillSlot にし、
 * 前の表示位置 pillPos と前の自由な位置 pillCustom を表と既定から外した（31 のキー）。前の2つは 0.7.0 U-1 の4つのキーと同じく
 * 「前の版が書いた値」として読まず・直さず・消さない（0.8.0 に戻すと前の位置が戻る）。画面からは保存させない。readSettings は、
 * raw に正しい pillSlot が無いときだけ前の2つの読みを pillFrom で返し、main が起動で1回だけ一番近い置き場所に直す（migratePillSlot）。
 *
 * 0.9.1 Q-3（設計書 D29。計画 docs/plans/2026-10-21-091.md の決めたこと 12）で、話し声が無いときに自動で止めるかの autoStopQuiet（既定オン。
 * useBuiltinTerms と同じく「false でなければオン」）と、知らせるまでの分 autoStopMin（AUTO_STOP_CHOICES のどれか。既定 10。新しい kind pick）を足した（33 のキー）。
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

// 0.8.0 までの録音バーの表示位置（pillPos の値。0.9.0 は読み書きしない: 前の位置の直しの材料だけ）
const PILL_POSITIONS = ['bottom', 'top', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
// 0.9.0 O-1（RP1）: 録音バーの8つの置き場所（pillSlot の値）。middle-left・middle-right は縦の形（mainlib.slotForm）
const PILL_SLOTS = ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'];
// 前の表示位置 → 同じ意味の置き場所（RP2。0.8.0 の bottom は下の中央、left は左の真ん中）
const SLOT_FROM_POS = {
  bottom: 'bottom-center', top: 'top-center', left: 'middle-left', right: 'middle-right',
  'top-left': 'top-left', 'top-right': 'top-right', 'bottom-left': 'bottom-left', 'bottom-right': 'bottom-right',
};
const THEMES = ['system', 'light', 'dark'];
// 0.9.1 Q-3: 話し声が無いときに知らせるまでの分（止めるのはその 5 分後。画面の選ぶ欄の選択肢と同じ）
const AUTO_STOP_CHOICES = [5, 10, 15, 20, 30, 60];
// ログイン中のメールアドレスの形（第1d回 A-2。中継が受けるのと同じ「空白と @ の無い前 1〜64 字 @ 後ろ 1〜190 字」・全体で 254 字まで）
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const EMAIL_MAX = 254;
const isEmailShape = (v) => typeof v === 'string' && v.length <= EMAIL_MAX && EMAIL_RE.test(v);

// 既定の設定（第1a回まで main.js の DEFAULT_SETTINGS に書いていた 30 のキーと値に、第1c回の claudeExe を足した 31。
// 第1c回の送り先と同意の4つは 0.7.0 U-1 で外した。第1d回 A-2 で accountEmail を足して 32）。
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
    // 録音バーの置き場所（0.9.0 O-1。前の pillPos・pillCustom は既定に無い）
    pillSlot: 'bottom-center',
    autoPaste: true,
    removeFillers: true,
    soundFeedback: true,
    autoLaunch: false,
    // 外観（画面の配色。0.7.0 U-2 で設定のいちばん上の「外観」へ）。system は Windows の設定に追従する
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
    // 空なら Claude Code を探す（第1c回 Task B-1 の findClaude）
    claudeExe: '',
    // ログイン中のメールアドレス（第1d回 A-2。'' はログインしていない）。main のログインの IPC だけが書く
    accountEmail: '',
    // 話し声が無いときに自動で止める（0.9.1 Q-3）。知らせるまでの分（止めるのはその 5 分後）
    autoStopQuiet: true,
    autoStopMin: 10,
    // 会議の検出の通知（0.9.3 M-1）と、通知を出さないアプリ（MEET_APP_IDS の id の並び）
    meetingDetect: true,
    meetingDetectMute: [],
  };
}

// 31 のキーの決まり（0.9.0 O-1 で pillPos・pillCustom を外して pillSlot を足した）。label は設定の画面の言葉（知らせに出す名前。キーの名前は画面に出さない）。
// kind ごとの直し方は下の FIX。ここに無いキーは既定にも保存の許可の一覧にも入れない（テストが一致を見る）
//   int:      normalizeSettings が整数に直して範囲に収める（範囲は normalizeSettings の中だけに書く）
//   history:  0〜10000 の整数。10000 を越えたら 10000、それ以外の壊れた値は既定（0 に寄せない。F8）
//   string:   文字列。違えば ''
//   language: auto か英小文字 2〜3 字。違えば 'ja'
//   hotkey:   空でない文字列（本当の確かめは今どおり登録で）。違えば既定
//   enum:     values のどれか。違えば既定（形が違うときの why は typeWhy があればそれ。theme は計画の表のとおり enum だけ）
//   bool:     真偽値。今の判定で直す（notFalse は「false でなければオン」、ほかは「値があればオン」）
//   words:    normalizeSettings が文字の並びに整える。配列でなければ []
//   exe:      文字列。.cmd・.bat・.ps1 で終われば ''（shell を通さないと起こせないので使わない。F12。大小を問わない）。
//             string の kind は全部のパスの欄が共有するので、この決まりは claudeExe の exe にだけ入れる
//   email:    '' か、メールアドレスの形（isEmailShape）の文字列。違えば ''（ログインしていない形）。文字でなければ why は type
//   apps:     MEET_APP_IDS の id の並び（0.9.3 M-1）。配列でなければ []。一覧に無い id・重なり・文字でないものを落とす（落としたら why は type）
//   pick:     values のどれかの数（数の文字も数として受け、直した印 type）。違えば既定（範囲の端に寄せない: 選ぶ欄に無い値を作らない）
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
  pillSlot: { label: '録音バーの置き場所', kind: 'enum', values: PILL_SLOTS },
  autoPaste: { label: '文字起こし後、カーソル位置へ自動貼り付け', kind: 'bool' },
  removeFillers: { label: 'フィラー除去', kind: 'bool' },
  soundFeedback: { label: '効果音', kind: 'bool' },
  autoLaunch: { label: 'Windowsサインイン時に自動起動', kind: 'bool' },
  theme: { label: '外観', kind: 'enum', values: THEMES, typeWhy: 'enum' },
  stayInTray: { label: 'ウィンドウを閉じてもタスクトレイに残す', kind: 'bool' },
  dictionary: { label: 'ユーザー辞書', kind: 'words' },
  useBuiltinTerms: { label: '業務でよく使う言葉のヒントも渡す', kind: 'bool', notFalse: true },
  useSystemAudio: { label: '議事録で相手の声も録る', kind: 'bool' },
  maxHistory: { label: '音声入力の履歴の件数', kind: 'history', max: 10000 },
  segmentSec: { label: '議事録の文字起こし間隔（秒）', kind: 'int' },
  sumCtx: { label: '要約の文脈長', kind: 'int' },
  engineIdleMin: { label: '使わないエンジンを止めるまで（分）', kind: 'int' },
  // 第1c回（OL7）
  claudeExe: { label: 'Claude Code の場所', kind: 'exe' },
  // 第1d回 A-2（RL10）
  accountEmail: { label: 'ログイン中のメールアドレス', kind: 'email' },
  // 0.9.1 Q-3（D29）
  autoStopQuiet: { label: '話し声が無いときに自動で止める', kind: 'bool', notFalse: true },
  autoStopMin: { label: '知らせるまでの時間', kind: 'pick', values: AUTO_STOP_CHOICES },
  // 0.9.3 M-1（会議の検出）
  meetingDetect: { label: '会議の検出の通知', kind: 'bool', notFalse: true },
  meetingDetectMute: { label: '通知を出さないアプリ', kind: 'apps' },
};
const SETTING_KEYS = Object.keys(SETTING_RULES);
// 会議の検出の一覧の id（src/mainlib.js の MEET_APPS と同じ並び。settings.js は mainlib を読まないので写しを持つ: test/stage093.lib が照らす）
const MEET_APP_IDS = Object.freeze(['teams', 'zoom', 'webex', 'slack', 'chrome', 'edge', 'firefox']);

// 数の文字も数として受ける（'300' は 300）。数にならなければ NaN
function toNumber(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}
const FALSE_LIKE = /^(false|0|off|no)$/i;

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
  bool(v, { rule }) {
    if (typeof v === 'boolean') return { value: v, why: null };
    return { value: rule.notFalse ? v !== false : Boolean(v), why: 'type' };
  },
  words(v, { norm }) {
    return { value: norm, why: Array.isArray(v) ? null : 'type' };
  },
  exe(v) {
    if (typeof v !== 'string') return { value: '', why: 'type' };
    return SHELL_ONLY_RE.test(v) ? { value: '', why: 'enum' } : { value: v, why: null };
  },
  email(v) {
    if (typeof v !== 'string') return { value: '', why: 'type' };
    return v === '' || isEmailShape(v) ? { value: v, why: null } : { value: '', why: 'enum' };
  },
  apps(v) {
    if (!Array.isArray(v)) return { value: [], why: 'type' };
    const out = [];
    for (const x of v) if (typeof x === 'string' && MEET_APP_IDS.includes(x) && !out.includes(x)) out.push(x);
    return { value: out, why: out.length === v.length ? null : 'type' };
  },
  pick(v, { def, rule }) {
    if (typeof v !== 'number' && typeof v !== 'string') return { value: def, why: 'type' };
    const n = toNumber(v);
    if (!Number.isFinite(n)) return { value: def, why: 'type' };
    if (!rule.values.includes(n)) return { value: def, why: 'enum' };
    return { value: n, why: typeof v === 'number' ? null : 'type' };
  },
};

// raw: settings.json から読んだ普通のオブジェクト（形の確かめは呼び手が isSettingsShape で済ませる）。
// defaults: 既定（defaultSettings の結果）。raw も defaults も書き換えない。
// → { settings, repaired: [{ key, why }], falseLike: [{ key, raw }], pillFrom }
//   repaired にはオンとオフの欄を真偽値に直したものも入る（記録にキーの名前を書くため）
//   pillFrom（0.9.0 O-1・RP2）: raw に正しい pillSlot が無いときだけ { point, pos }（前の版の pillCustom と pillPos の読み。
//   point は x・y が有限の数なら { x, y }、pos は同じ意味の置き場所の名前。どちらも無ければ null）。正しい pillSlot があれば null
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
  const slotOk = typeof raw.pillSlot === 'string' && PILL_SLOTS.includes(raw.pillSlot);
  return { settings, repaired, falseLike, pillFrom: slotOk ? null : legacyPill(raw) };
}

// 前の版の録音バーの位置（pillCustom・pillPos）の読み。どちらも読むだけで、settings には触らない（RP2）
function legacyPill(raw) {
  const c = raw.pillCustom;
  const point = isSettingsShape(c) && Number.isFinite(c.x) && Number.isFinite(c.y) ? { x: c.x, y: c.y } : null;   // Number.isFinite は数の型だけ真
  const pos = typeof raw.pillPos === 'string' && Object.hasOwn(SLOT_FROM_POS, raw.pillPos) ? SLOT_FROM_POS[raw.pillPos] : null;
  return { point, pos };
}

// 既定の値を、呼び手が書き換えても既定に響かない形で返す（dictionary のため）
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
  normalizeSettings, REMOVED_KEYS, PILL_POSITIONS, PILL_SLOTS, SLOT_FROM_POS, AUTO_STOP_CHOICES, MEET_APP_IDS, defaultSettings, SETTING_RULES, SETTING_KEYS,
  readSettings, pickSavable, isSettingsShape, isEmailShape,
};
