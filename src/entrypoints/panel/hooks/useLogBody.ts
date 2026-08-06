/**
 * 詳細表示のボディ取得。
 *
 * ボディは一覧では読まず、選択されたときに初めて個別取得する。
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

/** 取得済みの結果。どのログのものかを一緒に持つ。 */
interface Loaded {
  logId: number | null;
  body: string | null;
  error: string | null;
}

const NOTHING_LOADED: Loaded = { logId: null, body: null, error: null };

export function useLogBody(source: LogSource, log: StoredLog | null): LogBodyResult {
  const [loaded, setLoaded] = useState<Loaded>(NOTHING_LOADED);

  // 選択を素早く切り替えたときに、前の応答で上書きしないための世代番号
  const requestId = useRef(0);
  const logId = log?.id ?? null;
  const bodyStatus = log?.bodyStatus ?? null;

  useEffect(() => {
    const id = ++requestId.current;

    // 保存されていないことが分かっているものは取りに行かない（理由は詳細側で表示する）
    if (logId === null || bodyStatus !== 'stored') {
      setLoaded({ logId, body: null, error: null });
      return;
    }

    source
      .getBody(logId)
      .then((result) => {
        if (id !== requestId.current) return;
        setLoaded({ logId, body: result, error: null });
      })
      .catch((cause: unknown) => {
        if (id !== requestId.current) return;
        setLoaded({
          logId,
          body: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
  }, [source, logId, bodyStatus]);

  // 取得結果を state のクリアではなく描画時の突き合わせで捨てる。effect は描画の後に
  // 走るため、state を effect でクリアする作りだと、行を切り替えた直後の 1 フレームで
  // 「新しいエントリのヘッダー＋前のエントリのボディ」が表示されてしまう。
  if (loaded.logId !== logId) {
    return { body: null, loading: logId !== null && bodyStatus === 'stored', error: null };
  }
  return { body: loaded.body, loading: false, error: loaded.error };
}
