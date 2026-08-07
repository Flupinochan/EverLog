/**
 * コンソールログ出力の進行管理。
 *
 * `useHarExport.ts` と同じ段取り（条件で全件を引く → 規模を見て確認 → 変換 →
 * ファイル化）にしてある。変換は `@/lib/console-export`、ファイル化は `../download`
 * にあり、このフックは 3 つを順に呼ぶだけに保つ。
 *
 * ネットワーク側と違い、本文を集める段が無い。コンソールは 1 件のなかに本文まで
 * 入っているため、`getBodies()` に相当する問い合わせが要らない。
 */

import { useCallback, useRef, useState } from 'react';
import {
  CONSOLE_EXPORT_MIME_TYPE,
  buildConsoleExport,
  consoleFileName,
  estimateConsoleExportBytes,
  type ConsoleExport,
} from '@/lib/console-export';
import type { ConsoleLogFilter, StoredConsoleLog } from '@/lib/db';
import type { LogSource } from '@/lib/log-source';
import { EXPORT_CONFIRM_BYTES, EXPORT_MAX_BYTES, describeExportSize } from '@/lib/panel-view';
import { downloadText } from '../download';
import type { PendingExport } from './useHarExport';

export interface ConsoleExportResult {
  exporting: boolean;
  /** 規模が大きく確認待ちの状態。null なら確認は不要 */
  pending: PendingExport | null;
  error: string | null;
  /** 出力を始める。条件は呼び出し側が押された時点のものを渡す */
  start: (filter: ConsoleLogFilter) => void;
  confirm: () => void;
  cancel: () => void;
  dismissError: () => void;
}

/** JSON へ変換する。文字列長の上限に当たった場合は原因の分かるメッセージに差し替える。 */
function stringifyExport(data: ConsoleExport): string {
  try {
    return JSON.stringify(data);
  } catch (cause) {
    if (cause instanceof RangeError) {
      throw new Error(
        '出力が大きすぎて JSON に変換できませんでした。期間やレベルで絞り込んでください',
      );
    }
    throw cause;
  }
}

/**
 * @param source データ取得先
 * @param creatorVersion 出力に載せる拡張機能のバージョン
 */
export function useConsoleExport(source: LogSource, creatorVersion: string): ConsoleExportResult {
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState<PendingExport | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 確認待ちの間、取得済みのログを保持する。同意後に問い合わせ直さないため */
  const pendingLogs = useRef<StoredConsoleLog[] | null>(null);
  const busy = useRef(false);
  const runId = useRef(0);

  const write = useCallback(
    (logs: StoredConsoleLog[]) => {
      const data = buildConsoleExport(logs, creatorVersion);
      downloadText(stringifyExport(data), consoleFileName(Date.now()), CONSOLE_EXPORT_MIME_TYPE);
    },
    [creatorVersion],
  );

  /** 実行中フラグとエラー表示の面倒を 1 箇所にまとめる。 */
  const runTask = useCallback((task: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    const id = ++runId.current;
    setExporting(true);
    setError(null);

    void task()
      .catch((cause: unknown) => {
        if (id !== runId.current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (id !== runId.current) return;
        busy.current = false;
        setExporting(false);
      });
  }, []);

  const start = useCallback(
    (filter: ConsoleLogFilter) => {
      pendingLogs.current = null;
      setPending(null);

      runTask(async () => {
        // 表示用の上限は渡さない。画面が 200 件ずつしか読んでいなくても、条件に一致する
        // 全件を出す（HAR 出力と同じ方針）
        const logs = await source.queryConsoleLogs(filter);

        if (logs.length === 0) {
          setError('条件に一致するログがありません');
          return;
        }

        const bytes = estimateConsoleExportBytes(logs);
        if (bytes > EXPORT_MAX_BYTES) {
          setError(
            `${describeExportSize(logs.length, bytes)} は大きすぎて出力できません。期間やレベルで絞り込んでください`,
          );
          return;
        }
        if (bytes > EXPORT_CONFIRM_BYTES) {
          pendingLogs.current = logs;
          setPending({ count: logs.length, bytes });
          return;
        }

        write(logs);
      });
    },
    [runTask, source, write],
  );

  const confirm = useCallback(() => {
    const logs = pendingLogs.current;
    if (logs === null) return;
    pendingLogs.current = null;
    setPending(null);
    runTask(async () => write(logs));
  }, [runTask, write]);

  const cancel = useCallback(() => {
    pendingLogs.current = null;
    setPending(null);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return { exporting, pending, error, start, confirm, cancel, dismissError };
}
