/**
 * 詳細表示のボディ取得。
 *
 * ボディは一覧では読まず、選択されたときに初めて個別取得する（仕様書 8.3）。
 * この方針を守る場所がここなので、一覧側からボディを触る経路を足さない。
 */

import { useEffect, useRef, useState } from 'react';
import type { StoredLog } from '@/lib/db';
import type { LogSource } from '@/lib/log-source';

export interface LogBodyResult {
  /** 保存されているボディ。未保存・未選択なら null */
  body: string | null;
  loading: boolean;
  error: string | null;
}

export function useLogBody(source: LogSource, log: StoredLog | null): LogBodyResult {
  const [body, setBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 選択を素早く切り替えたときに、前の応答で上書きしないための世代番号
  const requestId = useRef(0);
  const logId = log?.id ?? null;
  const bodyStatus = log?.bodyStatus ?? null;

  useEffect(() => {
    const id = ++requestId.current;
    setBody(null);
    setError(null);

    // 保存されていないことが分かっているものは取りに行かない（理由は詳細側で表示する）
    if (logId === null || bodyStatus !== 'stored') {
      setLoading(false);
      return;
    }

    setLoading(true);
    source
      .getBody(logId)
      .then((result) => {
        if (id !== requestId.current) return;
        setBody(result);
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [source, logId, bodyStatus]);

  return { body, loading, error };
}
