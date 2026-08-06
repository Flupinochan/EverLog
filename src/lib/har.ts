/**
 * 保存済みログを HAR (HTTP Archive) 1.2 へ変換する。
 *
 * `panel-view.ts` と同じく、DOM にも React にも Chrome API にも依存しない純粋関数だけを
 * 置く。ファイルとして落とす処理は `src/entrypoints/panel/download.ts` にあり、混ぜない。
 *
 * HAR にするのは、出力結果を Chrome DevTools の Network パネルへそのまま読み込み直せる
 * ため。独自形式にすると閲覧手段が EverLog 自身に限られる。
 *
 * 変換元の `StoredLog` は保存時にサニタイズ層を通っている。したがって出力にも認証ヘッダーや
 * Cookie は含まれず、URL・ボディ内のトークンは伏せ字のままになる。
 */

import type { StoredLog } from './db';

/** HAR のヘッダー・クエリ要素。 */
export interface HarNameValue {
  name: string;
  value: string;
}

/** HAR に載せきれない EverLog 固有の情報。`_` 始まりの独自フィールドとして持つ。 */
export interface EverLogExtension {
  tabId: number;
  pageUrl: string;
  bodyStatus: StoredLog['bodyStatus'];
  droppedRequestHeaders: string[];
  droppedResponseHeaders: string[];
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: HarNameValue[];
    headers: HarNameValue[];
    queryString: HarNameValue[];
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: HarNameValue[];
    headers: HarNameValue[];
    content: { size: number; mimeType: string; text?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  _everlog: EverLogExtension;
}

export interface HarArchive {
  log: {
    version: '1.2';
    creator: { name: string; version: string };
    pages: [];
    entries: HarEntry[];
    comment: string;
  };
}

/** 出力ファイルの MIME タイプ。 */
export const HAR_MIME_TYPE = 'application/json';

/**
 * 出力に添える注記。受け取った人が中身の性質を判断できるようにする。
 * 「ヘッダーが少ない」「値が伏せられている」のが欠損ではなく仕様だと分かる必要がある。
 */
export const HAR_COMMENT =
  'Exported by EverLog. サニタイズ済み: 認証ヘッダーと Cookie は保存時に破棄され、' +
  'URL・ボディ内のトークンは伏せ字になっています。リクエストボディは記録していません。';

/**
 * ヘッダーのレコードを HAR の配列へ戻す。`network-log.ts` の `headersToRecord()` の逆。
 *
 * 同名ヘッダーは `headersToRecord()` が `, ` で連結している。ここで分割し直すことはしない。
 * 値そのものに `, ` を含むヘッダー（`accept` や `cache-control` など）を誤って割ってしまい、
 * 元より壊れた結果になるため。連結されたまま 1 件として出す。
 *
 * 並べ替えもしない。レコードのキー順は記録時のヘッダー順のままであり、そちらが元の
 * 通信に近い。
 */
export function recordToHeaders(record: Record<string, string>): HarNameValue[] {
  return Object.entries(record).map(([name, value]) => ({ name, value }));
}

/**
 * URL から `request.queryString` を作る。
 *
 * パースできない URL では空配列を返し、例外を投げない（`db.ts` の `extractHost()` と同じ
 * 方針）。1 件の URL が壊れているだけで出力全体を失敗させない。
 */
export function queryStringFromUrl(url: string): HarNameValue[] {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

/**
 * 所要時間を HAR の `time` として使える値に丸める。
 * 負値・非有限（記録元が値を持たなかった場合）は 0 にする。
 */
function resolveTime(timeMs: number): number {
  return Number.isFinite(timeMs) && timeMs > 0 ? timeMs : 0;
}

/** `startedDateTime` を作る。時刻が壊れている場合はエポックにフォールバックする。 */
function toIsoString(ts: number): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/**
 * ログ 1 件を HAR エントリへ変換する。
 *
 * @param body 保存されていたボディ。無い場合は null（`content.text` を出さない）
 */
export function toHarEntry(log: StoredLog, body: string | null): HarEntry {
  const time = resolveTime(log.timeMs);

  const content: HarEntry['response']['content'] = {
    size: log.bodySize,
    mimeType: log.mimeType,
  };
  // 保存しているのはデコード済みの UTF-8 文字列なので `encoding` フィールドは付けない。
  // 付けると読み込み側が base64 として二重デコードを試みる。
  if (body !== null) content.text = body;

  return {
    startedDateTime: toIsoString(log.ts),
    time,
    request: {
      method: log.method,
      url: log.url,
      // HTTP バージョンは HAR エントリから取得していないため空にする。
      httpVersion: '',
      // サニタイズ層が `cookie` / `set-cookie` を許可リストから外しているため、
      // 復元できる Cookie は存在しない。常に空配列。
      cookies: [],
      headers: recordToHeaders(log.requestHeaders),
      queryString: queryStringFromUrl(log.url),
      // ヘッダーの生バイト数は保存していない。リクエストボディは記録していない。
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: log.status,
      statusText: '',
      httpVersion: '',
      cookies: [],
      headers: recordToHeaders(log.responseHeaders),
      content,
      redirectURL: log.responseHeaders.location ?? '',
      headersSize: -1,
      // 転送時の実バイト数（圧縮後）は保存していない。`content.size` とは別物なので
      // 代用せず、不明を意味する -1 を出す。
      bodySize: -1,
    },
    cache: {},
    // HAR は `time` が非負の timings の合計と一致することを求める。内訳は保存していない
    // ため、全体を `wait` として計上して整合させる。
    timings: { send: 0, wait: time, receive: 0 },
    _everlog: {
      tabId: log.tabId,
      pageUrl: log.pageUrl,
      bodyStatus: log.bodyStatus,
      droppedRequestHeaders: log.droppedRequestHeaders,
      droppedResponseHeaders: log.droppedResponseHeaders,
    },
  };
}

/**
 * ログの配列から HAR を組み立てる。
 *
 * @param bodies ログ ID → ボディ。載っていない ID はボディ無しとして扱う
 * @param creatorVersion 拡張機能のバージョン。`browser.runtime.getManifest()` を
 *   ここで読まないのは、このモジュールを Chrome API 非依存に保つため
 */
export function buildHar(
  logs: readonly StoredLog[],
  bodies: ReadonlyMap<number, string>,
  creatorVersion: string,
): HarArchive {
  return {
    log: {
      version: '1.2',
      creator: { name: 'EverLog', version: creatorVersion },
      // ページ単位のグルーピングは行わないため空。エントリ側にも `pageref` を出さない。
      pages: [],
      entries: logs.map((log) => toHarEntry(log, bodies.get(log.id) ?? null)),
      comment: HAR_COMMENT,
    },
  };
}

/**
 * エントリ 1 件あたりのメタデータの概算バイト数。
 * URL・ヘッダー・JSON の構造分をまとめて見積もる。厳密さは必要ない（後述）。
 */
const METADATA_BYTES_PER_ENTRY = 1024;

/**
 * 出力サイズの概算（バイト）。**確認を出すかどうかの判定にのみ使う。**
 *
 * `getStats()` と同じく、ボディを保存していないエントリの `bodySize` は数えない。
 * 実際に出力されないものを数えると、確認の文言が実物とかけ離れるため。
 *
 * JSON のエスケープで文字列は膨らむので、実サイズはこの値より大きくなる。正確な値が
 * 必要なら組み立て後の文字列長を見ればよく、その前段の判定にそこまでの精度は要らない。
 */
export function estimateExportBytes(logs: readonly StoredLog[]): number {
  let bytes = logs.length * METADATA_BYTES_PER_ENTRY;
  for (const log of logs) {
    if (log.bodyStatus === 'stored') bytes += log.bodySize;
  }
  return bytes;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/**
 * 出力ファイル名。`everlog-20260806-234500.har`。
 *
 * ローカル時刻で組む。パネルの時刻表示（`panel-view.ts` の `formatTimestamp()`）が
 * ローカル時刻であり、画面で見ていた時刻とファイル名を突き合わせられるようにするため。
 */
export function harFileName(now: number): string {
  const date = new Date(now);
  const base = Number.isNaN(date.getTime()) ? new Date(0) : date;
  const ymd = `${base.getFullYear()}${pad(base.getMonth() + 1, 2)}${pad(base.getDate(), 2)}`;
  const hms = `${pad(base.getHours(), 2)}${pad(base.getMinutes(), 2)}${pad(base.getSeconds(), 2)}`;
  return `everlog-${ymd}-${hms}.har`;
}
