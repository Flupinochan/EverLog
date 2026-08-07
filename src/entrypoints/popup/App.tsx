/**
 * popup の画面全体。フック（データ取得）と表示コンポーネントを繋ぐ層。
 *
 * panel と同じく、ここには「状態を持って配る」以上の処理を置かない。
 * 記録トグル・URL フィルタ・保存状況を扱う。HAR 出力はパネル側にある。
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
import { formatPatternLines, hasUnsavedPatterns, parsePatternLines } from '@/lib/popup-view';
import type { UrlFilterMode } from '@/lib/network-log';
import { RecordingToggle } from './components/RecordingToggle';
import { StorageStats } from './components/StorageStats';
import { UrlFilterEditor } from './components/UrlFilterEditor';
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

  /**
   * URL パターンの編集中の内容。null は「編集していない」を表す。
   *
   * null の間は保存済みの値をそのまま映すため、初回の読み込み完了も、別の popup や
   * 外部からの変更も、追従の処理を書かずに反映される。`update()` は state を先に
   * 進めない設計なので、確定後に null へ戻すと正規化済みの値が入力欄に現れる。
   */
  const [patternDraft, setPatternDraft] = useState<string | null>(null);
  const savedPatterns = settings.urlFilter.patterns;
  const patternValue = patternDraft ?? formatPatternLines(savedPatterns);

  /**
   * 入力欄の内容を保存する。
   *
   * `urlFilter` の patch は置換なので `mode` も一緒に渡す必要があるが、`settings` の
   * `mode` は storage の往復を経ていない古い値でありうる。ラジオを押した直後に適用すると
   * 切り替えたばかりのモードを巻き戻してしまうため、保存直前の値から組み立てる。
   *
   * 編集内容を手放すのは保存できたときだけ。失敗したら入力欄をそのまま残し、
   * エラー表示を見てやり直せるようにする。
   */
  const applyPatterns = useCallback(() => {
    const patterns = parsePatternLines(patternValue);
    void update((current) => ({ urlFilter: { mode: current.urlFilter.mode, patterns } })).then(
      (saved) => {
        if (saved) setPatternDraft(null);
      },
    );
  }, [patternValue, update]);

  const changeMode = useCallback(
    (mode: UrlFilterMode) => {
      // 編集中の入力欄は残す。モードの切り替えで打ちかけの内容を捨てない
      void update((current) => ({ urlFilter: { mode, patterns: current.urlFilter.patterns } }));
    },
    [update],
  );

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
        onChange={(recording) => void update({ recording })}
      />
      <UrlFilterEditor
        mode={settings.urlFilter.mode}
        onModeChange={changeMode}
        value={patternValue}
        onValueChange={setPatternDraft}
        onApply={applyPatterns}
        onRevert={() => setPatternDraft(null)}
        dirty={patternDraft !== null && hasUnsavedPatterns(patternDraft, savedPatterns)}
        disabled={settingsLoading}
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
