/**
 * 一覧（VIEW-01）。保存済みエントリを新しい順に並べる表示コンポーネント。
 * データ取得は行わず、props で受けた配列を描くだけにする。
 */

import type { StoredLog } from '@/lib/db';
import { classifyStatus, formatTimeOfDay, urlPath, type StatusClass } from '@/lib/panel-view';

interface Props {
  logs: StoredLog[];
  selectedId: number | null;
  onSelect: (log: StoredLog) => void;
  /** 初回読み込み中か（空表示との出し分けに使う） */
  loading: boolean;
}

const STATUS_COLOR: Record<StatusClass, string> = {
  success: 'text-emerald-600 dark:text-emerald-400',
  redirect: 'text-sky-600 dark:text-sky-400',
  'client-error': 'text-amber-600 dark:text-amber-400',
  'server-error': 'text-red-600 dark:text-red-400',
  unknown: 'text-zinc-400 dark:text-zinc-500',
};

const HEAD_CELL = 'sticky top-0 z-10 bg-zinc-100 px-2 py-1 text-left font-normal dark:bg-zinc-800';

export function LogTable({ logs, selectedId, onSelect, loading }: Props) {
  if (logs.length === 0) {
    return (
      <p className="p-4 text-xs text-zinc-500">
        {loading
          ? '読み込み中…'
          : '記録がありません。DevTools を開いた状態でページをリロードすると記録されます。'}
      </p>
    );
  }

  return (
    <table className="w-full border-collapse font-mono text-xs">
      <thead className="text-zinc-500 dark:text-zinc-400">
        <tr>
          <th className={`${HEAD_CELL} w-24`}>時刻</th>
          <th className={`${HEAD_CELL} w-20`}>メソッド</th>
          <th className={`${HEAD_CELL} w-20`}>ステータス</th>
          <th className={HEAD_CELL}>URL</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((log) => {
          const selected = log.id === selectedId;
          return (
            <tr
              key={log.id}
              onClick={() => onSelect(log)}
              className={
                selected
                  ? 'cursor-pointer bg-sky-100 dark:bg-sky-900/50'
                  : 'cursor-pointer odd:bg-zinc-50 hover:bg-zinc-100 dark:odd:bg-zinc-900 dark:hover:bg-zinc-800'
              }
            >
              <td className="px-2 py-0.5 text-zinc-500 dark:text-zinc-400">
                {formatTimeOfDay(log.ts)}
              </td>
              <td className="px-2 py-0.5">{log.method}</td>
              <td className={`px-2 py-0.5 ${STATUS_COLOR[classifyStatus(log.status)]}`}>
                {/* 0 は「レスポンスが返らなかった」を意味するのでコードとしては出さない */}
                {log.status === 0 ? '-' : log.status}
              </td>
              <td className="max-w-0 truncate px-2 py-0.5" title={log.url}>
                <span className="text-zinc-500 dark:text-zinc-400">{log.host}</span>
                <span>{urlPath(log.url)}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
