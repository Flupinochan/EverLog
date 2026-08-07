/**
 * コンソール一覧データの取得。
 *
 * `useLogQuery.ts` と同じ作りにしてある（世代番号で古い応答を捨てる、走査中は
 * 自動更新を間引く、見えていない間は取りに行かない）。取得するストアと型だけが違う。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConsoleLogFilter, StoredConsoleLog } from '@/lib/db';
import type { LogSource } from '@/lib/log-source';
import { hasSameLogs } from '@/lib/panel-view';

export interface ConsoleQueryResult {
  logs: StoredConsoleLog[];
  /** 上限で打ち切られた続きがあるか */
  hasMore: boolean;
  /** まだ一度も結果を受け取っていない状態。「読み込み中」を出してよいのはこの間だけ */
  initialLoading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * @param source データ取得先。差し替え可能にしてある
 * @param filter 問い合わせ条件。呼び出し側で memo 化して渡す
 * @param limit 取得件数の上限
 * @param refreshIntervalMs 自動更新の間隔。null なら自動更新しない
 */
export function useConsoleQuery(
  source: LogSource,
  filter: ConsoleLogFilter,
  limit: number,
  refreshIntervalMs: number | null,
): ConsoleQueryResult {
  const [logs, setLogs] = useState<StoredConsoleLog[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const requestId = useRef(0);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    inFlight.current = true;
    try {
      // 上限より 1 件多く取り、続きがあるかを判定する
      const results = await source.queryConsoleLogs({ ...filter, limit: limit + 1 });
      if (id !== requestId.current) return;
      const page = results.slice(0, limit);
      // `consoleLogs` も追記専用なので、ID の並びが同じなら中身も同じ。
      // 配列の同一性を保って無駄な再描画を起こさない
      setLogs((prev) => (hasSameLogs(prev, page) ? prev : page));
      setHasMore(results.length > limit);
      setError(null);
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (id === requestId.current) {
        inFlight.current = false;
        setInitialLoading(false);
      }
    }
  }, [source, filter, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (refreshIntervalMs === null) return;

    const tick = () => {
      // 本文の部分一致はインデックスで表現できず、1 回の取得がストア全走査になりうる
      if (document.hidden || inFlight.current) return;
      void load();
    };

    const timer = setInterval(tick, refreshIntervalMs);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load, refreshIntervalMs]);

  const reload = useCallback(() => void load(), [load]);

  return { logs, hasMore, initialLoading, error, reload };
}
