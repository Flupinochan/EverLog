/**
 * フィルタ欄（VIEW-02）。props で受けた値を描くだけの表示コンポーネント。
 * 条件の解釈は `@/lib/panel-view` の `buildFilter()` が担う。
 */

import { METHOD_OPTIONS, type FilterForm } from '@/lib/panel-view';

interface Props {
  form: FilterForm;
  onChange: (patch: Partial<FilterForm>) => void;
  /** 入力を確定して問い合わせる */
  onApply: () => void;
  onReset: () => void;
  /** 検査中のタブが分からない場合は「このタブのみ」を選べない */
  tabFilterAvailable: boolean;
  autoRefresh: boolean;
  onAutoRefreshChange: (enabled: boolean) => void;
  onReload: () => void;
}

const CONTROL =
  'h-6 rounded border border-zinc-300 bg-white px-1.5 text-xs text-zinc-900 ' +
  'focus:border-sky-500 focus:outline-none dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-100';

const BUTTON =
  'h-6 rounded border border-zinc-300 bg-zinc-100 px-2 text-xs text-zinc-700 ' +
  'hover:bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600';

export function FilterBar({
  form,
  onChange,
  onApply,
  onReset,
  tabFilterAvailable,
  autoRefresh,
  onAutoRefreshChange,
  onReload,
}: Props) {
  return (
    <form
      className="flex flex-wrap items-center gap-1.5 border-b border-zinc-200 bg-zinc-50 px-2 py-1.5 dark:border-zinc-700 dark:bg-zinc-800"
      onSubmit={(event) => {
        event.preventDefault();
        onApply();
      }}
    >
      <input
        type="search"
        className={`${CONTROL} w-56`}
        placeholder="URL に含まれる文字列"
        value={form.urlIncludes}
        onChange={(event) => onChange({ urlIncludes: event.target.value })}
      />
      <select
        className={CONTROL}
        value={form.method}
        onChange={(event) => onChange({ method: event.target.value })}
      >
        <option value="">メソッド</option>
        {METHOD_OPTIONS.map((method) => (
          <option key={method} value={method}>
            {method}
          </option>
        ))}
      </select>
      <input
        type="text"
        inputMode="numeric"
        className={`${CONTROL} w-20`}
        placeholder="ステータス"
        value={form.status}
        onChange={(event) => onChange({ status: event.target.value })}
      />
      <input
        type="datetime-local"
        className={CONTROL}
        value={form.from}
        onChange={(event) => onChange({ from: event.target.value })}
      />
      <span className="text-xs text-zinc-500">〜</span>
      <input
        type="datetime-local"
        className={CONTROL}
        value={form.to}
        onChange={(event) => onChange({ to: event.target.value })}
      />
      <label
        className="flex items-center gap-1 text-xs text-zinc-700 dark:text-zinc-300"
        title={tabFilterAvailable ? undefined : '検査中のタブを特定できません'}
      >
        <input
          type="checkbox"
          checked={form.onlyCurrentTab}
          disabled={!tabFilterAvailable}
          onChange={(event) => onChange({ onlyCurrentTab: event.target.checked })}
        />
        このタブのみ
      </label>

      <button type="submit" className={BUTTON}>
        適用
      </button>
      <button type="button" className={BUTTON} onClick={onReset}>
        クリア
      </button>

      <span className="ml-auto flex items-center gap-1.5">
        <label className="flex items-center gap-1 text-xs text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(event) => onAutoRefreshChange(event.target.checked)}
          />
          自動更新
        </label>
        <button type="button" className={BUTTON} onClick={onReload}>
          更新
        </button>
      </span>
    </form>
  );
}
