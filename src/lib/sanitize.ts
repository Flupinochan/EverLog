/**
 * サニタイズ層。保存直前にエントリをここへ通し、機微情報を落とす。
 *
 * キャプチャ層ではなく保存層の手前に置くことで、将来キャプチャ方式を変更しても
 * 漏れが生じないようにする（CLAUDE.md の設計上の制約）。
 *
 * 正規表現ベースの除去は完全ではない。独自形式のトークンは検出できないため、
 * 機微な API はキャプチャ時の URL フィルタで採取対象から外す二段構えとする。
 */

import type { ConsoleLogEntry } from './console-log';
import type { NetworkLogEntry } from './network-log';

export const REDACTED = '[REDACTED]';

/** サニタイズ済みであることを型で表すエントリ。保存層はこの型のみを受け取る。 */
export interface SanitizedLogEntry extends NetworkLogEntry {
  /** 許可リストに載らず破棄したリクエストヘッダー名（値は保存しない） */
  droppedRequestHeaders: string[];
  /** 許可リストに載らず破棄したレスポンスヘッダー名（値は保存しない） */
  droppedResponseHeaders: string[];
}

/**
 * サニタイズ済みのコンソールエントリ。
 *
 * ネットワーク側と違い、落としたヘッダー名のような追加フィールドは持たない。
 * それでも別名の型にするのは、`addConsoleLog()` が受け取る型をこれに限ることで、
 * 素通しで保存する経路を型で塞ぐため（`SanitizedLogEntry` と同じ理由）。
 */
export interface SanitizedConsoleEntry extends ConsoleLogEntry {
  readonly sanitized: true;
}

export interface SanitizeOptions {
  /** 保存してよいリクエストヘッダー名（小文字） */
  allowedRequestHeaders: string[];
  /** 保存してよいレスポンスヘッダー名（小文字） */
  allowedResponseHeaders: string[];
  /** URL クエリ・ボディで値を伏せるキー */
  redactKeys: string[];
}

/**
 * 許可リスト。`authorization` / `cookie` / `set-cookie` は含めない。
 * 拒否リストではなく許可リストにすることで、`x-custom-auth` のような独自認証ヘッダーも
 * 自動的に落ちる。
 */
const DEFAULT_ALLOWED_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'content-length',
  'content-type',
  'host',
  'if-modified-since',
  'if-none-match',
  'origin',
  'pragma',
  'range',
  'referer',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'user-agent',
  'x-requested-with',
];

const DEFAULT_ALLOWED_RESPONSE_HEADERS = [
  'age',
  'cache-control',
  'content-disposition',
  'content-encoding',
  'content-language',
  'content-length',
  'content-type',
  'date',
  'etag',
  'expires',
  'last-modified',
  'location',
  'retry-after',
  'server',
  'vary',
  'x-request-id',
];

/**
 * 値を伏せるキー（ボディ内トークンと URL 内トークンの両方に適用）。
 *
 * `code` は OAuth 認可コードを想定して入れているが、商品コードやエラーコードでも
 * 使われるため誤検知が最も起きやすい。邪魔なら 1 行削れば外せる。
 */
const DEFAULT_REDACT_KEYS = [
  'access_token',
  'id_token',
  'refresh_token',
  'api_key',
  'token',
  'client_secret',
  'secret',
  'password',
  'passwd',
  'pwd',
  'session_id',
  'credentials',
  'auth',
  'code',
];

export const DEFAULT_SANITIZE_OPTIONS: SanitizeOptions = {
  allowedRequestHeaders: DEFAULT_ALLOWED_REQUEST_HEADERS,
  allowedResponseHeaders: DEFAULT_ALLOWED_RESPONSE_HEADERS,
  redactKeys: DEFAULT_REDACT_KEYS,
};

/**
 * `URLSearchParams` はブラケットをパーセントエンコードしてしまうため、
 * 組み直した URL では置換マーカーだけ元の表記に戻す。
 */
const ENCODED_REDACTED = encodeURIComponent(REDACTED);

function restoreRedactedMarker(url: string): string {
  return url.replaceAll(ENCODED_REDACTED, REDACTED);
}

/** JWT の形（`eyJ` で始まる 3 パート）。 */
const JWT_PATTERN = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/** `Bearer xxx` / `Basic xxx`。スキームは残して値だけ伏せる。 */
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*/gi;

/**
 * キー名を正規化する。`access_token` / `accessToken` / `access-token` を同一視するため、
 * 小文字化して区切り文字を落とす。
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

function createRedactKeySet(keys: string[]): Set<string> {
  return new Set(keys.map(normalizeKey));
}

function isRedactKey(key: string, redactKeys: Set<string>): boolean {
  return redactKeys.has(normalizeKey(key));
}

function looksLikeJwt(value: string): boolean {
  JWT_PATTERN.lastIndex = 0;
  return JWT_PATTERN.test(value);
}

/** `URLSearchParams` 内の該当キーを伏せる。置換したら true を返す。 */
function redactSearchParams(params: URLSearchParams, redactKeys: Set<string>): boolean {
  const entries = Array.from(params.entries());
  let changed = false;

  const redacted = entries.map<[string, string]>(([key, value]) => {
    if (value === '' || value === REDACTED) return [key, value];
    if (isRedactKey(key, redactKeys) || looksLikeJwt(value)) {
      changed = true;
      return [key, REDACTED];
    }
    return [key, value];
  });

  if (!changed) return false;

  // `params.set()` は同名キーの 2 つ目以降を削除してしまい、
  // `?token=a&token=b` が伏せ字化ではなく欠落になる。全消し → 再追加で
  // 重複と並び順をそのまま保つ。
  for (const [key] of entries) params.delete(key);
  for (const [key, value] of redacted) params.append(key, value);

  return true;
}

/**
 * URL からトークンを除去する。
 *
 * クエリに加え、OAuth implicit flow でトークンが載るフラグメントと、
 * URL 内の認証情報（`https://user:pass@host/`）も対象にする。
 * パスセグメントに埋め込まれた JWT（`/verify/eyJ...`）も対象にする。
 *
 * 何も置換しなかった場合は入力文字列をそのまま返す。URL は保存層のインデックス
 * キーでもあるため、エスケープ表現を不用意に変えない。
 */
export function sanitizeUrl(url: string, options: SanitizeOptions = DEFAULT_SANITIZE_OPTIONS): string {
  if (!url) return url;
  const redactKeys = createRedactKeySet(options.redactKeys);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // 相対 URL などパースできないものは正規表現でフォールバック処理する。
    // パス中の裸の JWT はキー＝値の形を取らないため、別途置換する。
    return redactQueryLikeString(url, redactKeys).replace(JWT_PATTERN, REDACTED);
  }

  let changed = false;

  if (parsed.password) {
    parsed.password = '';
    changed = true;
  }

  // パスセグメントの JWT（`/verify/eyJ...`）。クエリと違いキー名が無いので
  // 形で判定するしかない。
  const redactedPath = parsed.pathname.replace(JWT_PATTERN, REDACTED);
  if (redactedPath !== parsed.pathname) {
    parsed.pathname = redactedPath;
    changed = true;
  }

  if (redactSearchParams(parsed.searchParams, redactKeys)) {
    changed = true;
  }

  if (parsed.hash.length > 1) {
    const fragment = new URLSearchParams(parsed.hash.slice(1));
    if (redactSearchParams(fragment, redactKeys)) {
      parsed.hash = `#${fragment.toString()}`;
      changed = true;
    }
  }

  return changed ? restoreRedactedMarker(parsed.toString()) : url;
}

/**
 * `key=value` の並びを正規表現で伏せる。URL のパースに失敗したときのフォールバックと、
 * フォームエンコードされたボディの処理に使う。
 *
 * 値の文字クラスから引用符とバックスラッシュを除いているのは、JSON 文字列に URL が
 * 埋め込まれている場合（`{"cb":"https://x/?token=abc"}`）に閉じ引用符まで飲み込んで
 * JSON を壊さないようにするため。
 */
function redactQueryLikeString(text: string, redactKeys: Set<string>): string {
  return text.replace(/([?&#]|^)([\w.\-[\]]+)=([^&#\s"'\\<>]*)/g, (match, prefix, key, value) => {
    if (!value || value === REDACTED) return match;
    if (isRedactKey(key, redactKeys) || looksLikeJwt(value)) {
      return `${prefix}${key}=${REDACTED}`;
    }
    return match;
  });
}

/**
 * 引用符の無いキーの `key: value`。
 *
 * コンソールの引数プレビュー（`{access_token: "..."}`）と、JavaScript のソースが
 * レスポンスとして返る場合（`{ apiKey: "..." }`）を拾う。JSON のようにキーが
 * 引用符で囲まれていないため、上の JSON 用のパターンでは当たらない。
 *
 * 直前の 1 文字を見るのは、URL のスキーム（`https://`）やスタックの行番号
 * （`a.js:12:34`）を巻き込まないため。`{` `,` `[` か空白の後ろに限る。
 */
const UNQUOTED_KEY_PATTERN = /([{,[\s]|^)([\w.$-]+)(\s*:\s*)("(?:[^"\\]|\\.)*"|[^\s,;{}[\]]+)/g;

/**
 * ボディからトークンを除去する。
 *
 * JSON として壊さないよう、キーと引用符を残して値だけを置換する。
 */
export function sanitizeBody(
  body: string | null,
  options: SanitizeOptions = DEFAULT_SANITIZE_OPTIONS,
): string | null {
  if (body === null || body === '') return body;
  const redactKeys = createRedactKeySet(options.redactKeys);

  // 1. JSON の文字列値（"access_token": "..."）
  let result = body.replace(
    /("([\w.-]+)"\s*:\s*)"(?:[^"\\]|\\.)*"/g,
    (match, prefix: string, key: string) =>
      isRedactKey(key, redactKeys) ? `${prefix}"${REDACTED}"` : match,
  );

  // 2. 引用符の無いキー（access_token: "..."）
  result = result.replace(
    UNQUOTED_KEY_PATTERN,
    (match, prefix: string, key: string, separator: string, value: string) => {
      if (!isRedactKey(key, redactKeys)) return match;
      // 値が引用符付きなら引用符ごと残す。囲みを外すと構造が変わって読めなくなる
      const replaced = value.startsWith('"') ? `"${REDACTED}"` : REDACTED;
      return `${prefix}${key}${separator}${replaced}`;
    },
  );

  // 3. フォームエンコード（access_token=...）と、文字列中に埋め込まれた URL のクエリ
  result = redactQueryLikeString(result, redactKeys);

  // 4. Bearer / Basic（スキームは残す）
  // スキームは正規表現の捕捉グループから取る。マッチ文字列を ' ' で切ると、
  // 区切りがタブや改行のとき indexOf が -1 を返してトークン末尾 1 文字だけが
  // 落ちた値（= ほぼ生のトークン）が保存されてしまう。
  result = result.replace(AUTH_SCHEME_PATTERN, (_match, scheme: string) => `${scheme} ${REDACTED}`);

  // 5. 上記に当てはまらない裸の JWT
  result = result.replace(JWT_PATTERN, REDACTED);

  return result;
}

/** URL を値に持つヘッダー。値そのものにトークンが載りうるため URL として処理する。 */
const URL_VALUED_HEADERS = new Set(['referer', 'location']);

/**
 * ヘッダーを許可リストで濾す。
 *
 * 落としたヘッダーは名前だけ返す。値は一切持ち回らない。
 */
export function sanitizeHeaders(
  headers: Record<string, string>,
  allowed: string[],
  options: SanitizeOptions = DEFAULT_SANITIZE_OPTIONS,
): { headers: Record<string, string>; dropped: string[] } {
  const allowedSet = new Set(allowed.map((name) => name.toLowerCase()));
  const sanitized: Record<string, string> = {};
  const dropped: string[] = [];

  for (const [rawName, value] of Object.entries(headers)) {
    // キャプチャ層で正規化済みだが、この層の判定を他層の実装に依存させない
    const name = rawName.toLowerCase();
    if (!allowedSet.has(name)) {
      dropped.push(name);
      continue;
    }
    sanitized[name] = URL_VALUED_HEADERS.has(name) ? sanitizeUrl(value, options) : value;
  }

  return { headers: sanitized, dropped: dropped.sort() };
}

/** `https://example.com/a.js:12:34` の末尾の行・列番号。 */
const SOURCE_LOCATION_PATTERN = /^(.*?)(:\d+:\d+)$/;

/**
 * 発生元（`url:line:col`）をサニタイズする。
 *
 * 行・列番号を切り離してから URL を処理する。`?api_key=secret` のようなクエリを
 * 持つ URL では、伏せ字の対象になる「値」に末尾の `:12:34` まで含まれてしまい、
 * そのまま通すと発生位置が消える。トークンは伏せたうえで位置は残す。
 */
function sanitizeSourceLocation(source: string, options: SanitizeOptions): string {
  const matched = SOURCE_LOCATION_PATTERN.exec(source);
  if (matched === null) return sanitizeUrl(source, options);
  return `${sanitizeUrl(matched[1] ?? '', options)}${matched[2] ?? ''}`;
}

/**
 * コンソールエントリをサニタイズする。保存層はこの関数の戻り値だけを受け取る。
 *
 * ヘッダーが無いため許可リストは使わず、文字列の中身だけを見る。console には
 * `console.log('token', token)` のようにトークンがそのまま出ることが珍しくないため、
 * 本文（`text` と `args`）は必ず `sanitizeBody()` に通す。
 *
 * `stack` も本文として扱う。スタックの各行には URL が載り、その URL のクエリに
 * トークンが含まれうるため。ここでは行・列番号まで伏せ字に飲まれることがあるが、
 * 発生位置は `source` に残るので、スタック側は多めに伏せるほうへ倒す。
 */
export function sanitizeConsoleEntry(
  entry: ConsoleLogEntry,
  options: SanitizeOptions = DEFAULT_SANITIZE_OPTIONS,
): SanitizedConsoleEntry {
  return {
    ...entry,
    pageUrl: sanitizeUrl(entry.pageUrl, options),
    // 空文字は `sanitizeBody()` がそのまま返すため、引数の無いログでも形が変わらない
    text: sanitizeBody(entry.text, options) ?? '',
    args: entry.args.map((arg) => sanitizeBody(arg, options) ?? ''),
    source: entry.source === null ? null : sanitizeSourceLocation(entry.source, options),
    stack: sanitizeBody(entry.stack, options),
    sanitized: true,
  };
}

/**
 * エントリ全体をサニタイズする。保存層はこの関数の戻り値だけを受け取る。
 *
 * `pageUrl` も対象にする。OAuth リダイレクト直後のページ URL には
 * フラグメントにトークンが載っているため。
 */
export function sanitizeEntry(
  entry: NetworkLogEntry,
  options: SanitizeOptions = DEFAULT_SANITIZE_OPTIONS,
): SanitizedLogEntry {
  const request = sanitizeHeaders(entry.requestHeaders, options.allowedRequestHeaders, options);
  const response = sanitizeHeaders(entry.responseHeaders, options.allowedResponseHeaders, options);

  return {
    ...entry,
    url: sanitizeUrl(entry.url, options),
    pageUrl: sanitizeUrl(entry.pageUrl, options),
    requestHeaders: request.headers,
    responseHeaders: response.headers,
    droppedRequestHeaders: request.dropped,
    droppedResponseHeaders: response.dropped,
    body: sanitizeBody(entry.body, options),
  };
}
