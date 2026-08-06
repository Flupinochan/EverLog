/**
 * popup の画面全体。フック（データ取得）と表示コンポーネントを繋ぐ層。
 *
 * panel と同じく、ここには「状態を持って配る」以上の処理を置かない。
 * 記録トグルと保存状況のみを扱う。HAR 出力と設定の編集は未実装。
 */

import { useCallback, useState } from 'react';
import { browser } from 'wxt/browser';
import {
  indexedDbLogAdmin,
  indexedDbLogSource,
  type LogAdmin,
  type LogSource,
} from '@/lib/log-source';
import type { SettingsChangeSource, SettingsStorageArea } from '@/lib/settings';
import { RecordingToggle } from './components/RecordingToggle';
import { StorageStats } from './components/StorageStats';
import { useSettings } from './hooks/useSettings';
import { useStorageStats } from './hooks/useStorageStats';

interface Props {
  /** 差し替えは Storybook・UI テスト用。既定は実物の IndexedDB / chrome.storage */
  source?: LogSource;
  admin?: LogAdmin;
  /** 設定の保存先。名前を `storage` にしない（`src/lib/settings.ts` の注記を参照） */
  area?: SettingsStorageArea;
  changes?: SettingsChangeSource;
}

export function App({
  source = indexedDbLogSource,
  admin = indexedDbLogAdmin,
  area = browser.storage.local,
  changes = browser.storage,
}: Props = {}) {
  const { settings, loading: settingsLoading, error: settingsError, update } = useSettings(
    area,
    changes,
  );
  const { stats, loading: statsLoading, error: statsError, reload } = useStorageStats(source);

  /** 全削除の確認待ちか。押し間違いで消えないよう 2 段階にする */
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);

  const clear = useCallback(() => {
    if (!confirming) {
      setConfirming(true);
      return;
    }

    setClearing(true);
    setClearError(null);
    void admin
      .clearAll()
      .catch((cause: unknown) => {
        setClearError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        setClearing(false);
        setConfirming(false);
        reload();
      });
  }, [admin, confirming, reload]);

  return (
    <div className="flex w-72 flex-col gap-2.5 bg-white p-3 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <header className="flex items-baseline justify-between">
        <h1 className="text-sm font-semibold">EverLog</h1>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          一覧は DevTools のパネルから
        </span>
      </header>

      <RecordingToggle
        recording={settings.recording}
        disabled={settingsLoading}
        onChange={(recording) => update({ recording })}
      />
      {settingsError !== null && (
        <p className="text-xs text-red-600 dark:text-red-400">
          設定を保存できませんでした: {settingsError}
        </p>
      )}

      <StorageStats
        stats={stats}
        loading={statsLoading}
        error={statsError}
        confirming={confirming}
        onClear={clear}
        onCancelClear={() => setConfirming(false)}
        clearing={clearing}
      />
      {clearError !== null && (
        <p className="text-xs text-red-600 dark:text-red-400">
          削除に失敗しました: {clearError}
        </p>
      )}
    </div>
  );
}
