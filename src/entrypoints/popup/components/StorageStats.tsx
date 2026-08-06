/**
 * 保存状況の表示と全削除。props を描くだけの表示コンポーネント。
 *
 * 削除の確認段階も props で受け取る。この判断を自分で持つと、削除の流れが
 * 表示側とデータ側に分かれて追いにくくなるため。
 */

import type { StorageStats as Stats } from '@/lib/db';
import { formatBytes } from '@/lib/panel-view';

interface Props {
  stats: Stats | null;
  loading: boolean;
  error: string | null;
  /** 削除ボタンが確認待ちの状態か */
  confirming: boolean;
  /** 削除ボタン。1 回目で確認待ちに入り、2 回目で実行する */
  onClear: () => void;
  onCancelClear: () => void;
  clearing: boolean;
}

const BUTTON =
  'h-7 rounded border px-2.5 text-xs disabled:cursor-not-allowed disabled:opacity-50';

export function StorageStats({
  stats,
  loading,
  error,
  confirming,
  onClear,
  onCancelClear,
  clearing,
}: Props) {
  return (
    <section className="rounded border border-zinc-200 px-3 py-2.5 dark:border-zinc-700">
      <h2 className="text-xs font-medium text-zinc-500 dark:text-zinc-400">保存状況</h2>

      {error !== null ? (
        <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
          読み込みに失敗しました: {error}
        </p>
      ) : (
        <dl className="mt-1.5 flex items-baseline gap-4">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">件数</dt>
            <dd className="text-sm tabular-nums">
              {stats === null ? (loading ? '…' : '-') : `${stats.count} 件`}
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            {/* メタデータの容量は数えていないため、あくまで目安として出す */}
            <dt className="text-xs text-zinc-500 dark:text-zinc-400">ボディ（概算）</dt>
            <dd className="text-sm tabular-nums">
              {stats === null ? (loading ? '…' : '-') : formatBytes(stats.bodyBytes)}
            </dd>
          </div>
        </dl>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          className={
            confirming
              ? `${BUTTON} border-red-600 bg-red-600 text-white hover:bg-red-700`
              : `${BUTTON} border-zinc-300 bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600`
          }
          disabled={clearing || (stats !== null && stats.count === 0 && !confirming)}
          onClick={onClear}
        >
          {clearing ? '削除中…' : confirming ? '本当に削除する' : 'すべて削除'}
        </button>
        {confirming && !clearing && (
          <button
            type="button"
            className={`${BUTTON} border-zinc-300 bg-zinc-100 text-zinc-700 hover:bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600`}
            onClick={onCancelClear}
          >
            やめる
          </button>
        )}
      </div>

      {confirming && !clearing && (
        <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">
          保存済みのログをすべて削除します。元に戻せません。
        </p>
      )}
    </section>
  );
}
