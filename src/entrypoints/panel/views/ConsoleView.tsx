/**
 * Console タブの中身。`NetworkView` と同じ役割・同じ構成にしてある。
 *
 * 違いは 2 つだけ。絞り込みの条件（レベルと本文）と、詳細に本文取得の段が無いこと
 * （コンソールは 1 件のなかに本文まで入っている）。
 */

import { useCallback, useMemo, useState } from 'react';
import type { StoredConsoleLog } from '@/lib/db';
import type { LogSource } from '@/lib/log-source';
import {
  EMPTY_CONSOLE_FILTER_FORM,
  PAGE_SIZE,
  buildConsoleFilter,
  describeExportSize,
  type ConsoleFilterForm,
} from '@/lib/panel-view';
import { ConsoleDetail } from '../components/ConsoleDetail';
import { ConsoleFilterBar } from '../components/ConsoleFilterBar';
import { ConsoleTable } from '../components/ConsoleTable';
import { useConsoleExport } from '../hooks/useConsoleExport';
import { useConsoleQuery } from '../hooks/useConsoleQuery';

interface Props {
  source: LogSource;
  tabId: number | undefined;
  /** 拡張機能のバージョン。出力の `creator.version` に載せる */
  version: string;
  /** このタブが表示されているか。隠れている間は自動更新を止める */
  active: boolean;
  refreshIntervalMs: number;
}

export function ConsoleView({ source, tabId, version, active, refreshIntervalMs }: Props) {
  const [form, setForm] = useState<ConsoleFilterForm>(EMPTY_CONSOLE_FILTER_FORM);
  /** 実際に問い合わせている条件。入力のたびに DB を叩かないよう分けている */
  const [applied, setApplied] = useState<ConsoleFilterForm>(EMPTY_CONSOLE_FILTER_FORM);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selected, setSelected] = useState<StoredConsoleLog | null>(null);

  const filter = useMemo(() => buildConsoleFilter(applied, tabId), [applied, tabId]);

  const { logs, hasMore, initialLoading, error, reload } = useConsoleQuery(
    source,
    filter,
    limit,
    autoRefresh && active ? refreshIntervalMs : null,
  );

  const exportState = useConsoleExport(source, version);
  const { start: startExport, cancel: cancelExport } = exportState;

  const change = useCallback((patch: Partial<ConsoleFilterForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const apply = useCallback(() => {
    setApplied(form);
    setLimit(PAGE_SIZE);
    cancelExport();
  }, [form, cancelExport]);

  const reset = useCallback(() => {
    setForm(EMPTY_CONSOLE_FILTER_FORM);
    setApplied(EMPTY_CONSOLE_FILTER_FORM);
    setLimit(PAGE_SIZE);
    cancelExport();
  }, [cancelExport]);

  /**
   * 入力欄の内容をそのまま出力条件にする。
   *
   * `NetworkView` と同じ理由で `applied` を見ない。出力ボタンはフォームを送信せず
   * 押せるため、`適用` 前に押されると 1 つ前の条件で出てしまう。
   */
  const exportJson = useCallback(() => {
    apply();
    startExport(buildConsoleFilter(form, tabId));
  }, [apply, startExport, form, tabId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ConsoleFilterBar
        form={form}
        onChange={change}
        onApply={apply}
        onReset={reset}
        tabFilterAvailable={tabId !== undefined}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        onReload={reload}
        onExport={exportJson}
        exporting={exportState.exporting}
      />

      {error !== null && (
        <p className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          読み込みに失敗しました: {error}
        </p>
      )}

      {exportState.pending !== null && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <span>
            {describeExportSize(exportState.pending.count, exportState.pending.bytes)}{' '}
            を出力します。よろしいですか？
          </span>
          <button
            type="button"
            className="rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
            onClick={exportState.confirm}
          >
            出力する
          </button>
          <button
            type="button"
            className="rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
            onClick={exportState.cancel}
          >
            やめる
          </button>
        </div>
      )}

      {exportState.error !== null && (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          <span>出力できませんでした: {exportState.error}</span>
          <button
            type="button"
            className="rounded border border-red-300 px-2 py-0.5 hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900"
            onClick={exportState.dismissError}
          >
            閉じる
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            <ConsoleTable
              logs={logs}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
              loading={initialLoading}
            />
          </div>
          <footer className="flex items-center gap-2 border-t border-zinc-200 px-3 py-1 text-xs text-zinc-500 dark:border-zinc-700">
            <span>{logs.length} 件表示中</span>
            {hasMore && (
              <button
                type="button"
                className="rounded border border-zinc-300 px-2 py-0.5 hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
                onClick={() => setLimit((prev) => prev + PAGE_SIZE)}
              >
                さらに読み込む
              </button>
            )}
          </footer>
        </div>

        <ConsoleDetail log={selected} onClose={() => setSelected(null)} />
      </div>
    </div>
  );
}
