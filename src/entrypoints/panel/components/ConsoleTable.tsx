/**
 * コンソール一覧。保存済みエントリを新しい順に並べる表示コンポーネント。
 * データ取得は行わず、props で受けた配列を描くだけにする（`LogTable` と同じ）。
 */

import type { StoredConsoleLog } from '@/lib/db';
import {
  classifyLevel,
  describeConsoleLevel,
  formatTimeOfDay,
  type LevelClass,
} from '@/lib/panel-view';

interface Props {
  logs: StoredConsoleLog[];
  selectedId: number | null;
  onSelect: (log: StoredConsoleLog) => void;
  /** 初回読み込み中か（空表示との出し分けに使う） */
  loading: boolean;
}

const LEVEL_COLOR: Record<LevelClass, string> = {
  error: 'text-red-600 dark:text-red-400',
  warn: 'text-amber-600 dark:text-amber-400',
  info: 'text-zinc-600 dark:text-zinc-300',
  debug: 'text-zinc-400 dark:text-zinc-500',
};

/** 行そのものの色。エラーは一覧を流し見しても目に留まる必要がある。 */
const ROW_TINT: Record<LevelClass, string> = {
  error: 'bg-red-50 hover:bg-red-100 dark:bg-red-950/40 dark:hover:bg-red-950/70',
  warn: 'bg-amber-50 hover:bg-amber-100 dark:bg-amber-950/40 dark:hover:bg-amber-950/70',
  info: 'odd:bg-zinc-50 hover:bg-zinc-100 dark:odd:bg-zinc-900 dark:hover:bg-zinc-800',
  debug: 'odd:bg-zinc-50 hover:bg-zinc-100 dark:odd:bg-zinc-900 dark:hover:bg-zinc-800',
};

const HEAD_CELL = 'sticky top-0 z-10 bg-zinc-100 px-2 py-1 text-left font-normal dark:bg-zinc-800';

export function ConsoleTable({ logs, selectedId, onSelect, loading }: Props) {
  if (logs.length === 0) {
    return (
      <p className="p-4 text-xs text-zinc-500">
        {loading
          ? '読み込み中…'
          : '記録がありません。ページを開き直すと、その時点から console 出力が記録されます。'}
      </p>
    );
  }

  return (
    <table className="w-full border-collapse font-mono text-xs">
      <thead className="text-zinc-500 dark:text-zinc-400">
        <tr>
          <th className={`${HEAD_CELL} w-24`}>時刻</th>
          <th className={`${HEAD_CELL} w-28`}>レベル</th>
          <th className={HEAD_CELL}>本文</th>
          <th className={`${HEAD_CELL} w-56`}>発生元</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((log) => {
          const level = classifyLevel(log.level);
          const selected = log.id === selectedId;
          return (
            <tr
              key={log.id}
              onClick={() => onSelect(log)}
              className={
                selected ? 'cursor-pointer bg-sky-100 dark:bg-sky-900/50' : `cursor-pointer ${ROW_TINT[level]}`
              }
            >
              <td className="px-2 py-0.5 text-zinc-500 dark:text-zinc-400">
                {formatTimeOfDay(log.ts)}
              </td>
              <td className={`px-2 py-0.5 ${LEVEL_COLOR[level]}`}>
                {describeConsoleLevel(log.level)}
              </td>
              {/* 本文は 1 行に収める。全文は詳細側で読む */}
              <td className="max-w-0 truncate px-2 py-0.5" title={log.text}>
                {log.text === '' ? (
                  <span className="text-zinc-400 dark:text-zinc-500">（本文なし）</span>
                ) : (
                  log.text
                )}
              </td>
              <td
                className="max-w-0 truncate px-2 py-0.5 text-zinc-500 dark:text-zinc-400"
                title={log.source ?? undefined}
              >
                {log.source ?? '-'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
