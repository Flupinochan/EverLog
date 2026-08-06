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
import { EMPTY_FILTER_FORM, PAGE_SIZE, buildFilter, type FilterForm } from '@/lib/panel-view';
import { FilterBar } from './components/FilterBar';
import { LogDetail } from './components/LogDetail';
import { LogTable } from './components/LogTable';
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

  const change = useCallback((patch: Partial<FilterForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const apply = useCallback(() => {
    setApplied(form);
    setLimit(PAGE_SIZE);
  }, [form]);

  const reset = useCallback(() => {
    setForm(EMPTY_FILTER_FORM);
    setApplied(EMPTY_FILTER_FORM);
    setLimit(PAGE_SIZE);
  }, []);

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
      />

      {error !== null && (
        <p className="border-b border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          読み込みに失敗しました: {error}
        </p>
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
