/**
 * 一覧データの取得。パネルでデータ取得を行うのはこのフックだけに閉じる。
 *
 * 表示コンポーネントは props で受け取った配列を描くだけにしておくと、
 * Storybook や UI テストからは同じコンポーネントを実データなしで動かせる。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogFilter, StoredLog } from '@/lib/db';
import type { LogSource } from '@/lib/log-source';

export interface LogQueryResult {
  logs: StoredLog[];
  /** 上限で打ち切られた続きがあるか */
  hasMore: boolean;
  /**
   * まだ一度も結果を受け取っていない状態。
   *
   * 「読み込み中」を出してよいのはこの間だけにする。自動更新のたびに立てると、
   * 記録が 0 件のとき表示が数秒おきに切り替わって落ち着かないため。
   */
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
export function useLogQuery(
  source: LogSource,
  filter: LogFilter,
  limit: number,
  refreshIntervalMs: number | null,
): LogQueryResult {
  const [logs, setLogs] = useState<StoredLog[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 条件を変えた直後に古い応答が届いても、それで上書きしないための世代番号
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const id = ++requestId.current;
    try {
      // 上限より 1 件多く取り、続きがあるかを判定する
      const results = await source.queryLogs({ ...filter, limit: limit + 1 });
      if (id !== requestId.current) return;
      setLogs(results.slice(0, limit));
      setHasMore(results.length > limit);
      setError(null);
    } catch (cause) {
      if (id !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (id === requestId.current) setInitialLoading(false);
    }
  }, [source, filter, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (refreshIntervalMs === null) return;
    const timer = setInterval(() => void load(), refreshIntervalMs);
    return () => clearInterval(timer);
  }, [load, refreshIntervalMs]);

  const reload = useCallback(() => void load(), [load]);

  return { logs, hasMore, initialLoading, error, reload };
}
