/**
 * コンソールログのデータモデルと、`console.*` の引数を保存用の文字列へ変換するロジック。
 *
 * `network-log.ts` と同じく、Chrome の拡張機能 API にも DOM にも一切依存しない純粋関数
 * のみで構成する。ページ側の購読処理は `src/entrypoints/console-main.content.ts` に置く。
 *
 * ここでの変換は**必ずページ側（MAIN world）で行う**。`console.log(obj)` に渡された
 * オブジェクトは呼び出し後も書き換わり続けるため、値を持ち回ってから直列化すると
 * 「ログに出した時点の状態」ではなくなる。関数・Symbol・DOM ノードのように
 * structured clone を通らない値があり、そもそも生のまま境界を越えられないという事情もある。
 */

/**
 * 記録するコンソールの種別。
 *
 * `console.*` のすべてを対象にはしない。`group` や `time` のような「表示の制御」は
 * 後から一覧で読む用途で意味を持たないため、値を伴うものだけを拾う。
 * `uncaught` と `unhandledrejection` は `console` 経由では来ないが、調査の役に立つ
 * 度合いが `error` と同じなのでレベルとして並べる。
 */
export type ConsoleLevel =
  | 'log'
  | 'info'
  | 'warn'
  | 'error'
  | 'debug'
  | 'trace'
  | 'assert'
  | 'uncaught'
  | 'unhandledrejection';

/** ラップ対象の `console` メソッド名。`ConsoleLevel` と同名にしてある。 */
export const CONSOLE_METHODS = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'assert',
] as const;

/** 引数がそのまま保存できたか、できなかった場合はその理由。 */
export type ArgsStatus = 'stored' | 'truncated' | 'unserializable';

/**
 * 保存対象のコンソールエントリ。
 *
 * 主キー `id` は保存層が採番するため持たない（`NetworkLogEntry` と同じ）。
 */
export interface ConsoleLogEntry {
  /** 記録時刻（epoch ミリ秒） */
  ts: number;
  /** 記録元タブ */
  tabId: number;
  /** 記録時に開いていたページ（iframe の場合はそのフレーム）の URL */
  pageUrl: string;
  level: ConsoleLevel;
  /**
   * 一覧表示と本文検索に使う 1 行。書式指定子を展開して引数を連結したもの。
   *
   * `args` から機械的に導けないため別に持つ。`%s` などの展開には生の引数が要り、
   * プレビュー済みの文字列からは復元できない。
   */
  text: string;
  /** 引数ごとのプレビュー。詳細表示で内訳を見せるために持つ */
  args: string[];
  /** 発生元（`url:line:col`）。取れなければ null */
  source: string | null;
  /** `error` や未捕捉例外のスタック。無ければ null */
  stack: string | null;
  argsStatus: ArgsStatus;
}

/**
 * ページ側で組み立てる部分。
 *
 * `tabId` はページからは知りようがないため載せない。background が
 * `sender.tab.id` から補う。型で分けておくと、ページ側が推測で埋める経路が塞がる。
 */
export type CapturedConsoleEntry = Omit<ConsoleLogEntry, 'tabId'>;

/** MAIN world とブリッジ（ISOLATED world）の間でやり取りするイベント名。 */
export const CONSOLE_ENTRY_EVENT = 'everlog:console-entry';
export const MAIN_READY_EVENT = 'everlog:main-ready';
export const BRIDGE_READY_EVENT = 'everlog:bridge-ready';
export const CAPTURE_STATE_EVENT = 'everlog:capture-state';

/** ブリッジ → background のメッセージ種別。 */
export const CONSOLE_BATCH_MESSAGE = 'everlog:console-batch';

/** ブリッジが background へ送るメッセージ。 */
export interface ConsoleBatchMessage {
  type: typeof CONSOLE_BATCH_MESSAGE;
  entries: CapturedConsoleEntry[];
}

/** メッセージが自分たちのものか、形で確かめる。 */
export function isConsoleBatchMessage(message: unknown): message is ConsoleBatchMessage {
  if (typeof message !== 'object' || message === null) return false;
  const source = message as Record<string, unknown>;
  return source.type === CONSOLE_BATCH_MESSAGE && Array.isArray(source.entries);
}

export interface ConsolePreviewOptions {
  /** これより深いネストは中身を出さない */
  maxDepth: number;
  /** 文字列 1 つの上限（文字数） */
  maxStringLength: number;
  /** プレビューを作る引数の個数 */
  maxArgs: number;
  /** 配列で列挙する要素数 */
  maxArrayItems: number;
  /** オブジェクトで列挙するキー数 */
  maxObjectKeys: number;
  /** `text` と `args` を合わせた 1 件あたりの上限（文字数） */
  maxEntryChars: number;
}

/**
 * 上限の既定値。
 *
 * バイト数ではなく文字数で数える。ここでの上限は「際限なく膨らませない」ための歯止めで
 * あり、`TextEncoder` を全引数に通すコストに見合う精度は要らない。ネットワークの
 * `maxBodyBytes` がバイト数なのは、HAR が申告するサイズと突き合わせるためで事情が違う。
 */
export const DEFAULT_CONSOLE_PREVIEW_OPTIONS: ConsolePreviewOptions = {
  maxDepth: 4,
  maxStringLength: 8192,
  maxArgs: 10,
  maxArrayItems: 100,
  maxObjectKeys: 100,
  maxEntryChars: 32 * 1024,
};

/** 読めなかった値の表記。getter が投げた場合など。 */
const UNREADABLE = '[取得できません]';

interface PreviewContext {
  options: ConsolePreviewOptions;
  /**
   * いま辿っている経路上のオブジェクト。循環の検出に使う。
   *
   * 経路から抜けるときに必ず取り除く。到達済みの集合として持つと、同じオブジェクトが
   * 兄弟として 2 回現れただけで `[Circular]` になり、循環でないものを循環と呼んでしまう。
   */
  seen: Set<object>;
  /** 上限で何かを削ったか */
  truncated: boolean;
}

/** `Object.prototype.toString` の分類。別 realm の値でも効く。 */
function typeTag(value: object): string {
  return Object.prototype.toString.call(value);
}

/**
 * `instanceof` は使わない。iframe や別の realm から来た値では原型が異なり、
 * `Error` でも `Date` でも判定が外れるため、形か `toString` の分類で見る。
 */
function looksLikeError(value: object): boolean {
  const source = value as Record<string, unknown>;
  return (
    typeTag(value) === '[object Error]' ||
    (typeof source.message === 'string' && typeof source.stack === 'string')
  );
}

/** DOM ノードか。`Node` を参照せず形で判定し、このモジュールを DOM 非依存に保つ。 */
function looksLikeDomNode(value: object): boolean {
  const source = value as Record<string, unknown>;
  return typeof source.nodeType === 'number' && typeof source.nodeName === 'string';
}

function truncateString(value: string, ctx: PreviewContext): string {
  const max = ctx.options.maxStringLength;
  if (value.length <= max) return value;
  ctx.truncated = true;
  return `${value.slice(0, max)}…(${value.length - max} 文字省略)`;
}

/**
 * 読めなかったことを表す印。
 *
 * `UNREADABLE` の文字列を返さない。プレビューを通ると引用符が付き、
 * 「値が文字列 `"[取得できません]"` だった」と読めてしまうため。
 */
const UNREADABLE_VALUE = Symbol('everlog.unreadable');

/** プロパティを読む。getter が投げても直列化全体を落とさない。 */
function readProperty(target: object, key: string): unknown {
  try {
    return (target as Record<string, unknown>)[key];
  } catch {
    return UNREADABLE_VALUE;
  }
}

function previewFunction(value: unknown): string {
  try {
    const name = (value as { name?: unknown }).name;
    return typeof name === 'string' && name !== ''
      ? `[Function: ${name}]`
      : '[Function (anonymous)]';
  } catch {
    return '[Function]';
  }
}

function previewDomNode(value: object): string {
  const source = value as Record<string, unknown>;
  const name = typeof source.nodeName === 'string' ? source.nodeName.toLowerCase() : 'node';
  const id = typeof source.id === 'string' && source.id !== '' ? `#${source.id}` : '';
  const className =
    typeof source.className === 'string' && source.className.trim() !== ''
      ? `.${source.className.trim().split(/\s+/).join('.')}`
      : '';
  return `<${name}${id}${className}>`;
}

function previewError(value: object): string {
  const source = value as Record<string, unknown>;
  const name = typeof source.name === 'string' ? source.name : 'Error';
  const message = typeof source.message === 'string' ? source.message : '';
  return message === '' ? name : `${name}: ${message}`;
}

/** 深さ上限に当たったときの表記。中身を出さずに種別だけ残す。 */
function depthPlaceholder(value: object, ctx: PreviewContext): string {
  ctx.truncated = true;
  if (Array.isArray(value)) return '[Array]';
  const tag = typeTag(value);
  const name = tag.slice('[object '.length, -1);
  return `[${name}]`;
}

function joinItems(items: string[], total: number, max: number): string {
  if (total <= max) return items.join(', ');
  return [...items, `…他 ${total - max} 件`].join(', ');
}

function previewArray(value: unknown[], ctx: PreviewContext, depth: number): string {
  const max = ctx.options.maxArrayItems;
  if (value.length > max) ctx.truncated = true;
  const items = value.slice(0, max).map((item) => preview(item, ctx, depth + 1));
  return `[${joinItems(items, value.length, max)}]`;
}

function previewIterable(value: object, ctx: PreviewContext, depth: number, label: string): string {
  const max = ctx.options.maxArrayItems;
  const items: string[] = [];
  let total = 0;

  try {
    // Map / Set は形が違うだけで、上限の当て方は配列と同じにする
    const entries =
      label === 'Map'
        ? [...(value as Map<unknown, unknown>).entries()]
        : [...(value as Set<unknown>).values()];
    total = entries.length;
    for (const entry of entries.slice(0, max)) {
      items.push(
        label === 'Map'
          ? `${preview((entry as [unknown, unknown])[0], ctx, depth + 1)} => ${preview((entry as [unknown, unknown])[1], ctx, depth + 1)}`
          : preview(entry, ctx, depth + 1),
      );
    }
  } catch {
    return `${label} ${UNREADABLE}`;
  }

  if (total > max) ctx.truncated = true;
  return `${label}(${total}) {${joinItems(items, total, max)}}`;
}

function previewPlainObject(value: object, ctx: PreviewContext, depth: number): string {
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    return UNREADABLE;
  }

  const max = ctx.options.maxObjectKeys;
  if (keys.length > max) ctx.truncated = true;

  const items = keys.slice(0, max).map((key) => {
    const raw = readProperty(value, key);
    return `${key}: ${raw === UNREADABLE_VALUE ? UNREADABLE : preview(raw, ctx, depth + 1)}`;
  });

  // コンストラクタ名を頭に出す。`{}` だけでは何のオブジェクトか分からないため
  const tag = typeTag(value);
  const prefix = tag === '[object Object]' ? '' : `${tag.slice('[object '.length, -1)} `;
  return `${prefix}{${joinItems(items, keys.length, max)}}`;
}

function previewObject(value: object, ctx: PreviewContext, depth: number): string {
  if (ctx.seen.has(value)) return '[Circular]';
  if (looksLikeDomNode(value)) return previewDomNode(value);
  if (looksLikeError(value)) return previewError(value);

  const tag = typeTag(value);
  if (tag === '[object Date]') {
    try {
      return (value as Date).toISOString();
    } catch {
      return 'Invalid Date';
    }
  }
  if (tag === '[object RegExp]') return String(value);

  if (depth >= ctx.options.maxDepth) return depthPlaceholder(value, ctx);

  ctx.seen.add(value);
  try {
    if (Array.isArray(value)) return previewArray(value, ctx, depth);
    if (tag === '[object Map]') return previewIterable(value, ctx, depth, 'Map');
    if (tag === '[object Set]') return previewIterable(value, ctx, depth, 'Set');
    return previewPlainObject(value, ctx, depth);
  } finally {
    // 経路から抜けたら外す。外し忘れると兄弟の重複を循環と誤判定する
    ctx.seen.delete(value);
  }
}

function preview(value: unknown, ctx: PreviewContext, depth: number): string {
  switch (typeof value) {
    case 'string':
      // 最上位の文字列はそのまま出す（`console.log('hi')` は `hi` と表示されるため）。
      // ネストした文字列は引用符を付ける。`{a: 1}` と `{a: '1'}` を見分けるため
      return depth === 0
        ? truncateString(value, ctx)
        : JSON.stringify(truncateString(value, ctx));
    case 'number':
      // `-0` は `String()` が `0` にしてしまう。数値の調査では区別が要る
      return Object.is(value, -0) ? '-0' : String(value);
    case 'boolean':
      return String(value);
    case 'undefined':
      return 'undefined';
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return String(value);
    case 'function':
      return previewFunction(value);
  }
  if (value === null) return 'null';
  return previewObject(value as object, ctx, depth);
}

/**
 * 値 1 つをプレビュー文字列にする。
 *
 * 例外を投げない。1 つの引数が読めないだけでエントリごと失うより、その引数だけ
 * `[取得できません]` として残すほうが調査の役に立つ。
 */
export function previewValue(
  value: unknown,
  options: ConsolePreviewOptions = DEFAULT_CONSOLE_PREVIEW_OPTIONS,
): { text: string; truncated: boolean } {
  const ctx: PreviewContext = { options, seen: new Set(), truncated: false };
  try {
    return { text: preview(value, ctx, 0), truncated: ctx.truncated };
  } catch {
    return { text: UNREADABLE, truncated: ctx.truncated };
  }
}

/** 書式指定子として解釈する文字。`%c`（スタイル）は値を消費して出力しない。 */
const FORMAT_PATTERN = /%([sdifoOjc%])/g;

function formatNumber(value: unknown, integer: boolean): string {
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'symbol') return 'NaN';
  const parsed = Number(value);
  if (Number.isNaN(parsed)) return 'NaN';
  return integer ? String(Math.trunc(parsed)) : String(parsed);
}

/**
 * 第 1 引数の書式指定子を展開する。展開に使わなかった引数は呼び出し側が末尾に足す。
 *
 * DevTools のコンソールと同じ表示に寄せるために実装する。展開しないと
 * `console.log('%s 件', 3)` が `%s 件 3` と保存され、元の 1 行が読み取れなくなる。
 *
 * @returns 展開後の文字列と、消費した引数の個数
 */
export function applyFormat(
  template: string,
  rest: readonly unknown[],
  options: ConsolePreviewOptions = DEFAULT_CONSOLE_PREVIEW_OPTIONS,
): { text: string; consumed: number } {
  let consumed = 0;

  const text = template.replace(FORMAT_PATTERN, (match, specifier: string) => {
    if (specifier === '%') return '%';
    // 引数が尽きたら指定子をそのまま残す。勝手に `undefined` を埋めない
    if (consumed >= rest.length) return match;

    const value = rest[consumed];
    consumed += 1;

    switch (specifier) {
      case 's':
        // 文字列もプレビューを通す。最上位の文字列は引用符が付かず、長さの上限だけが効く
        return previewValue(value, options).text;
      case 'd':
      case 'i':
        return formatNumber(value, true);
      case 'f':
        return formatNumber(value, false);
      case 'c':
        // スタイル指定。値は消費するが出力しない（保存対象は文字列であり CSS は意味を持たない）
        return '';
      default:
        return previewValue(value, options).text;
    }
  });

  return { text, consumed };
}

export interface FormattedConsoleArgs {
  text: string;
  args: string[];
  argsStatus: ArgsStatus;
}

/** `text` と `args` の合計が上限に収まるよう、末尾から削る。 */
function capEntry(
  text: string,
  args: string[],
  options: ConsolePreviewOptions,
): FormattedConsoleArgs | null {
  const max = options.maxEntryChars;
  const total = text.length + args.reduce((sum, arg) => sum + arg.length, 0);
  if (total <= max) return null;

  // `text` は一覧表示と検索に使う唯一の値なので最後まで残す。先に内訳を削る
  const capped: string[] = [];
  let used = Math.min(text.length, max);
  for (const arg of args) {
    // 入らない 1 つで打ち切らない。大きい引数が 1 つ混ざっただけで、その後ろの
    // 小さな引数まで巻き添えで消える
    if (used + arg.length > max) continue;
    capped.push(arg);
    used += arg.length;
  }

  return {
    text: text.length > max ? `${text.slice(0, max)}…(${text.length - max} 文字省略)` : text,
    args: capped,
    argsStatus: 'truncated',
  };
}

/**
 * `console.*` の引数を保存用の形へ変換する。
 *
 * `text` は書式指定子を展開して連結した 1 行、`args` は引数ごとの内訳。
 * 上限に当たった場合は `argsStatus` に理由を残す（`bodyStatus` と同じ作法）。
 */
export function formatConsoleArgs(
  rawArgs: readonly unknown[],
  options: ConsolePreviewOptions = DEFAULT_CONSOLE_PREVIEW_OPTIONS,
): FormattedConsoleArgs {
  try {
    const limited = rawArgs.slice(0, options.maxArgs);
    const dropped = rawArgs.length - limited.length;

    const previews = limited.map((value) => previewValue(value, options));
    const args = previews.map((result) => result.text);
    const truncated = dropped > 0 || previews.some((result) => result.truncated);

    // 第 1 引数が文字列のときだけ書式指定子を解釈する。DevTools と同じ条件
    let text: string;
    if (typeof limited[0] === 'string') {
      // テンプレートは生の値ではなくプレビュー（＝ `args[0]`）を使う。生のまま渡すと
      // ここだけが長さの上限を通らず、巨大な第 1 引数がそのまま `text` に載る。
      // その結果 `capEntry()` の予算を食い尽くし、引数の内訳が丸ごと落ちる
      const template = args[0] ?? '';
      const formatted = applyFormat(template, limited.slice(1), options);
      const remaining = args.slice(1 + formatted.consumed);
      text = [formatted.text, ...remaining].join(' ');
    } else {
      text = args.join(' ');
    }

    if (dropped > 0) text = `${text} …他 ${dropped} 個の引数`;

    const capped = capEntry(text, args, options);
    if (capped !== null) return capped;

    return { text, args, argsStatus: truncated ? 'truncated' : 'stored' };
  } catch {
    // ここまで来るのは直列化そのものが壊れた場合だけ。エントリは捨てず、
    // 「記録は起きたが中身が残せなかった」ことを残す
    return { text: '[直列化できませんでした]', args: [], argsStatus: 'unserializable' };
  }
}

/** 拡張機能自身のフレーム。発生元の特定では読み飛ばす。 */
const EXTENSION_FRAME = 'chrome-extension://';

/** `at foo (https://example.com/a.js:1:2)` から `https://example.com/a.js:1:2` を取る。 */
const FRAME_PATTERN = /\(?([^\s()]+:\d+:\d+)\)?\s*$/;

/**
 * スタックから発生元（`url:line:col`）を取り出す。取れなければ null。
 *
 * 1 行目はメッセージ本文なので飛ばし、拡張機能自身のフレームも飛ばす。
 * こちらが差し込んだラッパーが発生元として記録されると、元の呼び出し位置が分からなくなる。
 */
export function parseStackTop(stack: string | null | undefined): string | null {
  if (typeof stack !== 'string' || stack === '') return null;

  for (const line of stack.split('\n').slice(1)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.includes(EXTENSION_FRAME)) continue;
    const matched = FRAME_PATTERN.exec(trimmed);
    if (matched !== null) return matched[1] ?? null;
  }
  return null;
}

/** 文字列でなければ既定値に寄せる。 */
function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** 文字列でなければ null に寄せる。 */
function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * ページから届いた値を妥当な `CapturedConsoleEntry` に整える。純粋関数。
 *
 * **保存経路の入口では必ずこれを通す。** エントリを運ぶ CustomEvent はページからも
 * 発火でき、`args` が配列でないといった壊れた形が届きうる。素通しすると
 * サニタイズ層が型を前提にしているところで例外になり、同じバッチに載っていた
 * 正しいエントリまで巻き添えで失う。
 *
 * 形が違うフィールドは既定値へ寄せ、エントリ自体は捨てない。記録が起きた事実は
 * 残すという方針（`attachBody()` がボディを取れなくてもエントリを残すのと同じ）。
 */
export function normalizeCapturedEntry(raw: unknown): CapturedConsoleEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;

  const source = raw as Record<string, unknown>;
  const ts = typeof source.ts === 'number' && Number.isFinite(source.ts) ? source.ts : Date.now();

  const args = Array.isArray(source.args)
    ? source.args.filter((arg): arg is string => typeof arg === 'string')
    : [];

  return {
    ts,
    pageUrl: asString(source.pageUrl),
    level: normalizeConsoleLevel(source.level),
    text: asString(source.text),
    args,
    source: asNullableString(source.source),
    stack: asNullableString(source.stack),
    argsStatus:
      source.argsStatus === 'truncated' || source.argsStatus === 'unserializable'
        ? source.argsStatus
        : 'stored',
  };
}

/** 保存されていた値を妥当な `ConsoleLevel` に整える。知らない値は `log` に寄せる。 */
export function normalizeConsoleLevel(raw: unknown): ConsoleLevel {
  switch (raw) {
    case 'log':
    case 'info':
    case 'warn':
    case 'error':
    case 'debug':
    case 'trace':
    case 'assert':
    case 'uncaught':
    case 'unhandledrejection':
      return raw;
    default:
      return 'log';
  }
}

/**
 * 単位時間あたりの記録件数を制限する。
 *
 * ループ内の `console.log` は一瞬で数万件に達しうる。上限が無いと IndexedDB への
 * 書き込みが詰まり、ページの動作まで巻き込んで遅くする。捨てた件数は数えておき、
 * 呼び出し側が「n 件省略」として 1 件だけ残せるようにする。
 */
export interface RateLimiter {
  /** 1 件通してよいか。false なら捨てる */
  allow(now: number): boolean;
  /** 前回の呼び出し以降に捨てた件数を返し、数え直しに戻す */
  takeDropped(): number;
}

export const DEFAULT_RATE_LIMIT = { max: 500, windowMs: 10_000 };

export function createRateLimiter(
  max: number = DEFAULT_RATE_LIMIT.max,
  windowMs: number = DEFAULT_RATE_LIMIT.windowMs,
): RateLimiter {
  let windowStart = 0;
  let count = 0;
  let dropped = 0;

  return {
    allow(now) {
      // 固定窓で数える。滑走窓にすると記録すべき時刻の配列を持つことになり、
      // 抑制したいはずの大量発生時にその配列自体が重くなる
      if (now - windowStart >= windowMs) {
        windowStart = now;
        count = 0;
      }
      if (count >= max) {
        dropped += 1;
        return false;
      }
      count += 1;
      return true;
    },
    takeDropped() {
      const value = dropped;
      dropped = 0;
      return value;
    },
  };
}

/** 省略したことを伝えるエントリの本文。 */
export function describeDroppedEntries(count: number): string {
  return `[EverLog] 出力が多いため ${count} 件を省略しました`;
}
