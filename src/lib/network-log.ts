/**
 * ネットワークログのデータモデルと、HAR エントリからの変換ロジック。
 *
 * このモジュールは Chrome の拡張機能 API に一切依存しない純粋関数のみで構成する。
 * DevTools 側の購読処理は `src/lib/capture.ts` に置く。
 */

/** ボディが保存されたか、されなかった場合はその理由（仕様書 6.4）。 */
export type BodyStatus = 'stored' | 'too_large' | 'mime_excluded' | 'fetch_failed';

/**
 * 保存対象のログエントリ（仕様書 7 章のデータモデル）。
 * 主キー `id` は保存層が採番するため、キャプチャ層では持たない。
 */
export interface NetworkLogEntry {
  /** 記録時刻（epoch ミリ秒） */
  ts: number;
  /** 記録元タブ */
  tabId: number;
  /** 記録時に開いていたページの URL */
  pageUrl: string;
  /** リクエスト URL */
  url: string;
  method: string;
  status: number;
  /** パラメータを除いたレスポンスの MIME タイプ */
  mimeType: string;
  /** 所要時間（ミリ秒） */
  timeMs: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  /** レスポンスボディ。取得しなかった／できなかった場合は null */
  body: string | null;
  /** ボディサイズ（バイト） */
  bodySize: number;
  bodyStatus: BodyStatus;
}

/** HAR のヘッダー要素。`@types/har-format` の `Header` と構造的に互換。 */
export interface HarLikeHeader {
  name: string;
  value: string;
}

/** HAR エントリのうち、キャプチャに必要な部分だけを表す入力型。 */
export interface HarLikeEntry {
  startedDateTime?: string;
  time?: number;
  request: {
    url: string;
    method: string;
    headers?: HarLikeHeader[];
  };
  response: {
    status: number;
    headers?: HarLikeHeader[];
    content?: {
      mimeType?: string;
      size?: number;
    };
    bodySize?: number;
  };
}

/** エントリに付与する、リクエスト自体からは得られない情報。 */
export interface CaptureContext {
  tabId: number;
  pageUrl: string;
  /** 記録時刻のフォールバック値。テストのために注入可能にしている */
  now?: number;
}

export interface CaptureOptions {
  /** ボディを取得する MIME タイプのパターン。`text/*` のワイルドカードを許可する */
  mimePatterns: string[];
  /** これを超えるボディは取得・保存しない（バイト） */
  maxBodyBytes: number;
}

/** 仕様書 8.1 の既定値。 */
export const DEFAULT_CAPTURE_OPTIONS: CaptureOptions = {
  mimePatterns: ['application/json', 'application/xml', 'text/*'],
  maxBodyBytes: 1024 * 1024,
};

/** `application/json; charset=utf-8` → `application/json`。 */
export function parseMimeType(raw: string | undefined): string {
  if (!raw) return '';
  const [type] = raw.split(';');
  return (type ?? '').trim().toLowerCase();
}

/**
 * MIME タイプが許可パターンのいずれかに一致するか。
 * `text/*` のような末尾ワイルドカードと、全許可（`*`）に対応する。
 */
export function matchesMimePatterns(mimeType: string, patterns: string[]): boolean {
  if (!mimeType) return false;
  return patterns.some((rawPattern) => {
    const pattern = rawPattern.trim().toLowerCase();
    if (pattern === '*' || pattern === '*/*') return true;
    if (pattern.endsWith('/*')) {
      return mimeType.startsWith(pattern.slice(0, -1));
    }
    return mimeType === pattern;
  });
}

/**
 * HAR のヘッダー配列をレコードに変換する。名前は小文字に正規化し、
 * 同名ヘッダーは `, ` で連結する。
 *
 * ここではサニタイズを行わない。ヘッダーの許可リストは保存層の責務であり、
 * サニタイズ処理を 1 箇所に集約するため（CLAUDE.md の設計上の制約）。
 */
export function headersToRecord(headers: HarLikeHeader[] | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const header of headers ?? []) {
    const name = header.name.trim().toLowerCase();
    if (!name) continue;
    const existing = record[name];
    record[name] = existing === undefined ? header.value : `${existing}, ${header.value}`;
  }
  return record;
}

/** 文字列の UTF-8 バイト長。 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * ボディサイズを決定する。`content.size` を優先し、不明（欠落または負値）なら
 * `bodySize` を見る。どちらも不明なら 0 を返す（この場合は取得後の実バイト長で判定する）。
 */
function resolveBodySize(entry: HarLikeEntry): number {
  const contentSize = entry.response.content?.size;
  if (typeof contentSize === 'number' && contentSize >= 0) return contentSize;
  const bodySize = entry.response.bodySize;
  if (typeof bodySize === 'number' && bodySize >= 0) return bodySize;
  return 0;
}

/** `startedDateTime` をパースする。欠落・不正なら現在時刻にフォールバックする。 */
function resolveTimestamp(entry: HarLikeEntry, now: number): number {
  if (!entry.startedDateTime) return now;
  const parsed = Date.parse(entry.startedDateTime);
  return Number.isNaN(parsed) ? now : parsed;
}

export interface BuiltLogEntry {
  entry: NetworkLogEntry;
  /** ボディを `getContent()` で取りに行くべきか */
  shouldFetchBody: boolean;
}

/**
 * HAR エントリからログエントリを組み立て、ボディを取得すべきかを判定する。
 *
 * `shouldFetchBody` が false のとき、`bodyStatus` にはその理由が入る。
 * true のときは暫定的に `stored` が入るので、`attachBody()` で確定させる。
 */
export function buildLogEntry(
  harEntry: HarLikeEntry,
  ctx: CaptureContext,
  options: CaptureOptions = DEFAULT_CAPTURE_OPTIONS,
): BuiltLogEntry {
  const now = ctx.now ?? Date.now();
  const mimeType = parseMimeType(harEntry.response.content?.mimeType);
  const bodySize = resolveBodySize(harEntry);

  const entry: NetworkLogEntry = {
    ts: resolveTimestamp(harEntry, now),
    tabId: ctx.tabId,
    pageUrl: ctx.pageUrl,
    url: harEntry.request.url,
    method: harEntry.request.method,
    status: harEntry.response.status,
    mimeType,
    timeMs: harEntry.time ?? 0,
    requestHeaders: headersToRecord(harEntry.request.headers),
    responseHeaders: headersToRecord(harEntry.response.headers),
    body: null,
    bodySize,
    bodyStatus: 'stored',
  };

  if (!matchesMimePatterns(mimeType, options.mimePatterns)) {
    return { entry: { ...entry, bodyStatus: 'mime_excluded' }, shouldFetchBody: false };
  }
  if (bodySize > options.maxBodyBytes) {
    return { entry: { ...entry, bodyStatus: 'too_large' }, shouldFetchBody: false };
  }
  return { entry, shouldFetchBody: true };
}

/** base64 を UTF-8 文字列としてデコードする。失敗時は null を返す。 */
function decodeBase64(encoded: string): string | null {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * `getContent()` の結果をエントリに反映して `bodyStatus` を確定させる。
 *
 * ボディが得られなくてもエントリ自体は捨てない（仕様書 6.4）。
 */
export function attachBody(
  entry: NetworkLogEntry,
  content: string | null | undefined,
  encoding: string | null | undefined,
  options: CaptureOptions = DEFAULT_CAPTURE_OPTIONS,
): NetworkLogEntry {
  if (typeof content !== 'string') {
    return { ...entry, body: null, bodyStatus: 'fetch_failed' };
  }

  const decoded = encoding === 'base64' ? decodeBase64(content) : content;
  if (decoded === null) {
    return { ...entry, body: null, bodyStatus: 'fetch_failed' };
  }

  // HAR がサイズを申告していないケースがあるため、実バイト長で上限を再判定する。
  const actualSize = byteLength(decoded);
  if (actualSize > options.maxBodyBytes) {
    return { ...entry, body: null, bodySize: actualSize, bodyStatus: 'too_large' };
  }

  return { ...entry, body: decoded, bodySize: actualSize, bodyStatus: 'stored' };
}
