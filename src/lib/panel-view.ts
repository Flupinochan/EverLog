/**
 * 閲覧 UI（DevTools パネル）の表示ロジック。
 *
 * DOM にも React にも Chrome API にも依存しない純粋関数だけを置く。パネル側の
 * コンポーネントは「ここで作った値を描画するだけ」に保つ。判定や整形をコンポーネントへ
 * 移すと、描画環境なしでは検証できなくなるため、この分離を崩さない。
 */

import type { LogFilter } from './db';
import type { BodyStatus } from './network-log';

/** フィルタ欄の入力値。すべて文字列で持ち、`buildFilter()` で `LogFilter` へ変換する。 */
export interface FilterForm {
  /** URL の部分一致 */
  urlIncludes: string;
  /** HTTP メソッド。空文字は「指定なし」 */
  method: string;
  /** ステータスコード。空文字は「指定なし」 */
  status: string;
  /** 期間の下限（`<input type="datetime-local">` の値） */
  from: string;
  /** 期間の上限（同上） */
  to: string;
  /** 検査中のタブのログだけに絞るか */
  onlyCurrentTab: boolean;
}

export const EMPTY_FILTER_FORM: FilterForm = {
  urlIncludes: '',
  method: '',
  status: '',
  from: '',
  to: '',
  onlyCurrentTab: false,
};

/** 一覧の 1 ページあたりの件数。「さらに読み込む」でこの数ずつ増やす。 */
export const PAGE_SIZE = 200;

/** メソッド選択の候補。 */
export const METHOD_OPTIONS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * `<input type="datetime-local">` の値（`2026-08-06T12:30`）を epoch ミリ秒にする。
 * 空文字・解釈できない値は `undefined`（＝条件なし）として扱う。
 *
 * オフセットを持たない日時文字列はローカル時刻として解釈される。利用者が入力した
 * 時刻はローカル時刻のつもりなので、この解釈のままでよい。
 */
export function parseDateTimeLocal(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 期間の上限を読む。`queryLogs()` の `to` は「含む」ため、入力の粒度いっぱいまで含める。
 *
 * `<input type="datetime-local">` は既定で分単位までしか入力できない。素直に解釈すると
 * 終端が `:00.000` になり、`12:31` を指定したとき 12:31:20 の記録が黙って外れる。
 * 秒が入力されている場合はその秒の終わり（`.999`）まで含める。
 */
export function parseRangeEnd(value: string): number | undefined {
  const parsed = parseDateTimeLocal(value);
  if (parsed === undefined) return undefined;
  const hasSeconds = /T\d{2}:\d{2}:\d{2}/.test(value.trim());
  return hasSeconds ? parsed + 999 : parsed + 59_999;
}

/** 数字だけからなる文字列をステータスコードとして読む。それ以外は `undefined`。 */
function parseStatus(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/**
 * 入力値を `queryLogs()` に渡す `LogFilter` へ変換する。
 *
 * 空欄と解釈できない値は条件そのものを積まない。誤入力で 0 件になるより、
 * 絞り込まずに見せるほうが調査中の挙動として穏当なため。
 *
 * @param currentTabId 検査中のタブ。`onlyCurrentTab` のときだけ使う
 */
export function buildFilter(form: FilterForm, currentTabId?: number): LogFilter {
  const filter: LogFilter = {};

  const urlIncludes = form.urlIncludes.trim();
  if (urlIncludes !== '') filter.urlIncludes = urlIncludes;

  const method = form.method.trim();
  if (method !== '') filter.method = method;

  const status = parseStatus(form.status);
  if (status !== undefined) filter.status = status;

  const from = parseDateTimeLocal(form.from);
  if (from !== undefined) filter.from = from;

  const to = parseRangeEnd(form.to);
  if (to !== undefined) filter.to = to;

  if (form.onlyCurrentTab && currentTabId !== undefined) filter.tabId = currentTabId;

  return filter;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/**
 * 記録時刻を `YYYY-MM-DD HH:mm:ss.SSS`（ローカル時刻）で表示する。
 *
 * `toLocaleString()` は環境ごとに区切りが変わり、同じログでも見え方が揃わないため使わない。
 */
export function formatTimestamp(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '-';
  const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}`;
  const hms = `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}`;
  return `${ymd} ${hms}.${pad(date.getMilliseconds(), 3)}`;
}

/** 一覧の時刻列で使う `HH:mm:ss.SSS`。日付は詳細側に出す。 */
export function formatTimeOfDay(ts: number): string {
  const formatted = formatTimestamp(ts);
  return formatted === '-' ? formatted : (formatted.split(' ')[1] ?? formatted);
}

/** 所要時間を表示用に丸める。1 秒以上は秒に切り替える。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** バイト数を人が読める単位にする。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(1);
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

/** JSON として整形表示してよい MIME タイプか（`application/problem+json` 等も含む）。 */
export function isJsonLike(mimeType: string): boolean {
  const type = mimeType.trim().toLowerCase();
  return type === 'application/json' || type === 'text/json' || type.endsWith('+json');
}

/**
 * ボディを表示用の文字列にする。JSON なら整形し、壊れていれば原文をそのまま返す。
 * 整形できたかどうかは表示の切り替えに使うため、真偽値も返す。
 */
export function formatBody(body: string, mimeType: string): { text: string; pretty: boolean } {
  const trimmed = body.trim();
  // MIME が JSON でなくても中身が JSON なら整形する（API が text/plain で返すことがある）
  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!isJsonLike(mimeType) && !looksLikeJson) return { text: body, pretty: false };

  try {
    return { text: JSON.stringify(JSON.parse(trimmed), null, 2), pretty: true };
  } catch {
    return { text: body, pretty: false };
  }
}

/**
 * ボディが保存されていない理由の説明。
 * `stored` は理由がないため空文字を返す。
 */
export function describeBodyStatus(status: BodyStatus): string {
  switch (status) {
    case 'stored':
      return '';
    case 'too_large':
      return 'サイズ上限を超えたため、ボディは保存されていません';
    case 'mime_excluded':
      return '対象外の MIME タイプのため、ボディは保存されていません';
    case 'fetch_failed':
      return 'ボディの取得に失敗しました（取得前にコンテキストが失われた可能性があります）';
  }
}

/** ヘッダーを名前順に並べた配列にする（表示順を安定させるため）。 */
export function sortHeaders(headers: Record<string, string>): Array<[string, string]> {
  return Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** ステータスコードの分類。表示の色分けに使う。 */
export type StatusClass = 'unknown' | 'success' | 'redirect' | 'client-error' | 'server-error';

export function classifyStatus(status: number): StatusClass {
  if (status >= 500) return 'server-error';
  if (status >= 400) return 'client-error';
  if (status >= 300) return 'redirect';
  if (status >= 200) return 'success';
  // 0 は「レスポンスが返らなかった」を意味する（中断・ネットワークエラー）
  return 'unknown';
}

/**
 * 2 つの取得結果が同じ並びかを ID だけで判定する。
 *
 * `logs` は追記専用で、保存後にメタデータが書き換わることはない。したがって ID の並びが
 * 同じなら内容も同じであり、自動更新のたびに新しい配列を state に入れて再描画を
 * 走らせる必要はない（開いている詳細のボディ整形まで巻き添えで再実行されるため）。
 */
export function hasSameLogs(
  a: ReadonlyArray<{ id: number }>,
  b: ReadonlyArray<{ id: number }>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((log, index) => log.id === b[index]?.id);
}

/** URL からパス以降を取り出す。パースできない URL はそのまま返す。 */
export function urlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
