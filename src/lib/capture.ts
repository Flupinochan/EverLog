/**
 * DevTools のネットワークイベントを購読し、ログエントリを組み立てて引き渡す層。
 *
 * `chrome.devtools.network` を引数で受け取る設計にしているため、テストでは
 * フェイクを注入してブラウザなしで駆動できる。
 */

import {
  DEFAULT_CAPTURE_OPTIONS,
  attachBody,
  buildLogEntry,
  type CaptureContext,
  type CaptureOptions,
  type HarLikeEntry,
  type NetworkLogEntry,
} from './network-log';

/**
 * `chrome.devtools.network.Request` のうち、キャプチャで使う部分。
 *
 * `getContent()` は Promise を返さないため（CLAUDE.md の制約）、
 * コールバック形式のシグネチャのみを要求する。
 */
export interface CapturedRequest extends HarLikeEntry {
  getContent(callback: (content: string, encoding: string) => void): void;
}

export type RequestFinishedListener = (request: CapturedRequest) => void;

/** `chrome.devtools.network` のうち、キャプチャで使う部分。 */
export interface NetworkCaptureApi {
  onRequestFinished: {
    addListener(listener: RequestFinishedListener): void;
    removeListener(listener: RequestFinishedListener): void;
  };
}

export interface GetContentResult {
  content: string | null;
  encoding: string;
}

/**
 * `getContent()` の応答を待つ上限（ミリ秒）。
 *
 * `getContent()` はコールバックを一度も呼ばないことがある（リクエストの元になった
 * コンテキストが失われた場合など）。上限が無いと await が永久に止まり、
 * メタデータごとエントリを取りこぼす。仕様書 6.4 は取得失敗でもメタデータは
 * 残すと定めているため、時間切れは失敗として扱う。
 */
export const GET_CONTENT_TIMEOUT_MS = 10_000;

/**
 * コールバック形式の `getContent()` を Promise でラップする。
 *
 * 取得失敗は例外にせず `content: null` として返し、呼び出し側で
 * `bodyStatus: 'fetch_failed'` に落とす（エントリ自体は捨てない）。
 * コールバックが呼ばれない場合も `timeoutMs` 経過で同じ扱いにする。
 */
export function getContentAsync(
  request: CapturedRequest,
  timeoutMs: number = GET_CONTENT_TIMEOUT_MS,
): Promise<GetContentResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => settle({ content: null, encoding: '' }), timeoutMs);

    function settle(result: GetContentResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    try {
      request.getContent((content, encoding) => {
        settle({ content: content ?? null, encoding: encoding ?? '' });
      });
    } catch {
      settle({ content: null, encoding: '' });
    }
  });
}

/**
 * ネットワークリクエストの記録を開始する。
 *
 * @param api DevTools のネットワーク API
 * @param getContext エントリに付与する tabId / pageUrl を返す関数。ページ遷移で
 *   pageUrl が変わるため、リクエストごとに呼ぶ
 * @param handler 組み立て済みエントリの引き渡し先。次フェーズではここを
 *   保存層への送信に差し替える
 * @returns 記録を停止する関数
 */
export function startNetworkCapture(
  api: NetworkCaptureApi,
  getContext: () => CaptureContext,
  handler: (entry: NetworkLogEntry) => void,
  options: CaptureOptions = DEFAULT_CAPTURE_OPTIONS,
): () => void {
  const listener: RequestFinishedListener = (request) => {
    void handleRequestFinished(request, getContext(), handler, options);
  };

  api.onRequestFinished.addListener(listener);
  return () => {
    api.onRequestFinished.removeListener(listener);
  };
}

async function handleRequestFinished(
  request: CapturedRequest,
  ctx: CaptureContext,
  handler: (entry: NetworkLogEntry) => void,
  options: CaptureOptions,
): Promise<void> {
  const { entry, shouldFetchBody } = buildLogEntry(request, ctx, options);

  if (!shouldFetchBody) {
    handler(entry);
    return;
  }

  const { content, encoding } = await getContentAsync(request);
  handler(attachBody(entry, content, encoding, options));
}
