/**
 * 設定の読み書き。popup で `chrome.storage` に触れるのはこのフックだけに閉じる。
 *
 * 表示コンポーネントは props で受け取った値を描くだけにしておくと、Storybook や
 * UI テストから実物の storage なしで動かせる（panel の `hooks/` と同じ方針）。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  watchSettings,
  type Settings,
  type SettingsChangeSource,
  type SettingsStorageArea,
} from '@/lib/settings';

export interface SettingsResult {
  settings: Settings;
  /** まだ一度も読み終えていない状態。この間は操作させない */
  loading: boolean;
  error: string | null;
  update: (patch: Partial<Settings>) => void;
}

/**
 * @param area 設定の保存先（引数名は `storage` にしない。`src/lib/settings.ts` の注記を参照）
 * @param changes 変更通知の発行元。別の popup や設定の外部変更に追従するために購読する
 */
export function useSettings(
  area: SettingsStorageArea,
  changes: SettingsChangeSource,
): SettingsResult {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // 初回の読み込み中に変更通知が届くことがある。通知のほうが新しいので、
    // 後から解決した読み込み結果でそれを巻き戻さない。
    let applied = false;

    const apply = (next: Settings) => {
      if (!alive) return;
      applied = true;
      setSettings(next);
      setLoading(false);
    };

    // 書いた側にも通知が来る。update() で state を先に進めず通知だけで更新すれば、
    // 保存に失敗したときに表示だけ切り替わった状態にならない。
    const stop = watchSettings(changes, apply);

    void loadSettings(area).then((loaded) => {
      if (applied) return;
      apply(loaded);
    });

    return () => {
      alive = false;
      stop();
    };
  }, [area, changes]);

  const update = useCallback(
    (patch: Partial<Settings>) => {
      setError(null);
      void saveSettings(area, patch).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [area],
  );

  return { settings, loading, error, update };
}
