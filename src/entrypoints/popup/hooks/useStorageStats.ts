/**
 * 保存状況（件数・概算容量）の取得。popup でデータを読むのはこのフックだけに閉じる。
 */

import { useCallback, useEffect, useState } from 'react';
import type { StorageStats } from '@/lib/db';
import type { LogSource } from '@/lib/log-source';

export interface StorageStatsResult {
  stats: StorageStats | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * @param source データ取得先。差し替え可能にしてある（panel の `useLogQuery` と同じ）
 *
 * popup は開いている間しか生きないため、自動更新は持たない。記録が増えたかを見るには
 * 開き直すか、削除後の `reload()` で取り直す。
 */
export function useStorageStats(source: LogSource): StorageStatsResult {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);

    void source
      .getStats()
      .then((result) => {
        if (!alive) return;
        setStats(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [source, generation]);

  const reload = useCallback(() => {
    setGeneration((prev) => prev + 1);
  }, []);

  return { stats, loading, error, reload };
}
