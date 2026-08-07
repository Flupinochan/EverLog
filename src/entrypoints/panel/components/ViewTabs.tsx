/**
 * `Network` / `Console` の切り替え。props を描くだけの表示コンポーネント。
 *
 * DevTools に別パネルを足すのではなくパネル内のタブにしている。DevTools の
 * タブバーを 2 つ占有せずに済み、期間やタブの絞り込みを両方で共有できるため。
 */

import type { PanelView } from '@/lib/panel-view';

interface Props {
  view: PanelView;
  onChange: (view: PanelView) => void;
}

const TABS: ReadonlyArray<{ value: PanelView; label: string }> = [
  { value: 'network', label: 'Network' },
  { value: 'console', label: 'Console' },
];

export function ViewTabs({ view, onChange }: Props) {
  return (
    <div
      role="tablist"
      className="flex shrink-0 items-center gap-1 border-b border-zinc-200 bg-zinc-50 px-2 pt-1 dark:border-zinc-700 dark:bg-zinc-800"
    >
      {TABS.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={view === tab.value}
          className={
            view === tab.value
              ? 'rounded-t border border-b-0 border-zinc-300 bg-white px-3 py-1 text-xs font-medium dark:border-zinc-600 dark:bg-zinc-900'
              : 'rounded-t border border-transparent px-3 py-1 text-xs text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-100'
          }
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
