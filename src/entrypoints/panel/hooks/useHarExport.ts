/**
 * HAR 出力の進行管理。
 *
 * `App.tsx` は「状態を持って配る」以上の処理を持たない方針なので、非同期の段取りは
 * ここに閉じる。変換そのものは `@/lib/har`、ファイル化は `../download` にあり、
 * このフックは 3 つを順に呼ぶだけに保つ。
 */

import { useCallback, useRef, useState } from 'react';
import type { LogFilter, StoredLog } from '@/lib/db';
import { HAR_MIME_TYPE, buildHar, estimateExportBytes, harFileName, type HarArchive } from '@/lib/har';
import type { LogSource } from '@/lib/log-source';
import { EXPORT_CONFIRM_BYTES, EXPORT_MAX_BYTES, describeExportSize } from '@/lib/panel-view';
import { downloadText } from '../download';

/** 確認待ちになっている出力の規模。 */
export interface PendingExport {
  count: number;
  /** 概算バイト数 */
  bytes: number;
}

export interface HarExportResult {
  exporting: boolean;
  /** 規模が大きく確認待ちの状態。null なら確認は不要 */
  pending: PendingExport | null;
  error: string | null;
  /**
   * 出力を始める。条件は呼び出し側が押された時点のものを渡す。
   *
   * フックに条件を持たせず引数で受けるのは、一覧の表示条件（確定済み）と出力条件が
   * ずれるのを防ぐため。押した瞬間の入力欄の内容で出す。
   */
  start: (filter: LogFilter) => void;
  /** 確認に同意して続行する */
  confirm: () => void;
  /** 確認を取り消す。条件が変わったときは呼び出し側から呼ぶ */
  cancel: () => void;
  dismissError: () => void;
}

/**
 * JSON へ変換する。文字列長の上限に当たった場合は原因の分かるメッセージに差し替える。
 *
 * `RangeError: Invalid string length` のままでは、利用者にとって何をすればよいか
 * 分からないため。
 */
function stringifyHar(har: HarArchive): string {
  try {
    return JSON.stringify(har);
  } catch (cause) {
    if (cause instanceof RangeError) {
      throw new Error('出力が大きすぎて JSON に変換できませんでした。期間や URL で絞り込んでください');
    }
    throw cause;
  }
}

/**
 * @param source データ取得先
 * @param creatorVersion HAR の `creator.version` に載せる拡張機能のバージョン
 */
export function useHarExport(source: LogSource, creatorVersion: string): HarExportResult {
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState<PendingExport | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 確認待ちの間、取得済みのログを保持する。同意後に問い合わせ直さないため */
  const pendingLogs = useRef<StoredLog[] | null>(null);
  // 走査中かどうかと、応答が今の実行のものかを見る。useLogQuery と同じ作り
  const busy = useRef(false);
  const runId = useRef(0);

  /** ボディを集めて HAR を組み立て、ファイルとして落とす。 */
  const write = useCallback(
    async (logs: StoredLog[]) => {
      // ボディを持たないエントリの ID は問い合わせない。無いものを数千件探しに行かない
      const ids = logs.filter((log) => log.bodyStatus === 'stored').map((log) => log.id);
      const bodies = await source.getBodies(ids);
      const har = buildHar(logs, bodies, creatorVersion);
      downloadText(stringifyHar(har), harFileName(Date.now()), HAR_MIME_TYPE);
    },
    [source, creatorVersion],
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
    (filter: LogFilter) => {
      pendingLogs.current = null;
      setPending(null);

      runTask(async () => {
        // 表示用の上限は渡さない。画面が 200 件ずつしか読んでいなくても、条件に一致する
        // 全件を出す。「絞ってから出す」ためのフィルタなので、そこで打ち切らない
        const logs = await source.queryLogs(filter);

        if (logs.length === 0) {
          setError('条件に一致するログがありません');
          return;
        }

        const bytes = estimateExportBytes(logs);
        if (bytes > EXPORT_MAX_BYTES) {
          setError(
            `${describeExportSize(logs.length, bytes)} は大きすぎて出力できません。期間や URL で絞り込んでください`,
          );
          return;
        }
        if (bytes > EXPORT_CONFIRM_BYTES) {
          pendingLogs.current = logs;
          setPending({ count: logs.length, bytes });
          return;
        }

        await write(logs);
      });
    },
    [runTask, source, write],
  );

  const confirm = useCallback(() => {
    const logs = pendingLogs.current;
    if (logs === null) return;
    pendingLogs.current = null;
    setPending(null);
    runTask(() => write(logs));
  }, [runTask, write]);

  const cancel = useCallback(() => {
    pendingLogs.current = null;
    setPending(null);
  }, []);

  const dismissError = useCallback(() => setError(null), []);

  return { exporting, pending, error, start, confirm, cancel, dismissError };
}
