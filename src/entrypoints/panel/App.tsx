/**
 * パネルの画面全体。フック（データ取得）と表示コンポーネントを繋ぐ層。
 *
 * ここには「状態を持って配る」以上の処理を置かない。条件の解釈と整形は
 * `@/lib/panel-view`、取得は `hooks/` にあり、この 3 つを混ぜない。
 */

import { useCallback, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import type { StoredLog } from '@/lib/db';
import { indexedDbLogSource, type LogSource } from '@/lib/log-source';
import {
  EMPTY_FILTER_FORM,
  PAGE_SIZE,
  buildFilter,
  describeExportSize,
  type FilterForm,
} from '@/lib/panel-view';
import { FilterBar } from './components/FilterBar';
import { LogDetail } from './components/LogDetail';
import { LogTable } from './components/LogTable';
import { useHarExport } from './hooks/useHarExport';
import { useLogBody } from './hooks/useLogBody';
import { useLogQuery } from './hooks/useLogQuery';

/** 自動更新の間隔。DevTools を開いたまま記録が増えるため、既定で追従させる。 */
const AUTO_REFRESH_INTERVAL_MS = 2000;

/** 検査中のタブ。パネルからも `chrome.devtools.*` を参照できる。 */
function inspectedTabId(): number | undefined {
  try {
    return browser.devtools?.inspectedWindow?.tabId;
  } catch {
    return undefined;
  }
}

/** 出力する HAR の `creator.version` に載せる値。読めない場合も出力自体は止めない。 */
function extensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

interface Props {
  /** データ取得先。既定は IndexedDB（差し替えは Storybook・UI テスト用） */
  source?: LogSource;
  tabId?: number;
}

export function App({ source = indexedDbLogSource, tabId }: Props = {}) {
  const [form, setForm] = useState<FilterForm>(EMPTY_FILTER_FORM);
  /** 実際に問い合わせている条件。入力のたびに DB を叩かないよう分けている */
  const [applied, setApplied] = useState<FilterForm>(EMPTY_FILTER_FORM);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [selected, setSelected] = useState<StoredLog | null>(null);

  const currentTabId = useMemo(() => tabId ?? inspectedTabId(), [tabId]);
  const filter = useMemo(() => buildFilter(applied, currentTabId), [applied, currentTabId]);

  const { logs, hasMore, initialLoading, error, reload } = useLogQuery(
    source,
    filter,
    limit,
    autoRefresh ? AUTO_REFRESH_INTERVAL_MS : null,
  );
  const { body, loading: bodyLoading, error: bodyError } = useLogBody(source, selected);

  const version = useMemo(() => extensionVersion(), []);
  const exportState = useHarExport(source, version);
  const { start: startExport, cancel: cancelExport } = exportState;

  const change = useCallback((patch: Partial<FilterForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const apply = useCallback(() => {
    setApplied(form);
    setLimit(PAGE_SIZE);
    // 条件が変われば確認待ちの出力は的外れになる。同意しても古い条件の結果が出てしまう
    cancelExport();
  }, [form, cancelExport]);

  const reset = useCallback(() => {
    setForm(EMPTY_FILTER_FORM);
    setApplied(EMPTY_FILTER_FORM);
    setLimit(PAGE_SIZE);
    cancelExport();
  }, [cancelExport]);

  /**
   * 入力欄の内容をそのまま出力条件にする。
   *
   * 出力ボタンは `type="button"` でフォームを送信しないため、`適用` を押さずに押される。
   * `applied` を見ると「絞り込んだつもりの条件」ではなく 1 つ前の条件で出てしまうので、
   * 押された時点の `form` から条件を作り、同時に一覧の表示条件も揃える。
   */
  const exportHar = useCallback(() => {
    apply();
    startExport(buildFilter(form, currentTabId));
  }, [apply, startExport, form, currentTabId]);

  return (
    <div className="flex h-screen flex-col bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <FilterBar
        form={form}
        onChange={change}
        onApply={apply}
        onReset={reset}
        tabFilterAvailable={currentTabId !== undefined}
        autoRefresh={autoRefresh}
        onAutoRefreshChange={setAutoRefresh}
        onReload={reload}
        onExport={exportHar}
        exporting={exportState.exporting}
      />

      {error !== null && (
        <p className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          読み込みに失敗しました: {error}
        </p>
      )}

      {/* 規模が大きいときだけ出る確認。window.confirm() は DevTools パネル内で
          挙動が安定しないため、popup の全削除と同じくインラインで確認する */}
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
            <LogTable
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

        <LogDetail
          log={selected}
          body={body}
          bodyLoading={bodyLoading}
          bodyError={bodyError}
          onClose={() => setSelected(null)}
        />
      </div>
    </div>
  );
}
