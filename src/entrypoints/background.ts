/**
 * Service Worker。役割はバッジ表示だけに限る。
 *
 * 記録が有効であることを常時明示する（仕様書 8.2 / POP-01）。popup を開いていない間も
 * 設定の変更に追従させたいが、popup は閉じるとコンテキストごと消えるため、
 * ここで購読する。
 *
 * **保存はここに置かない。** ログの読み書きは DevTools ページと popup が IndexedDB を
 * 直接開く（CLAUDE.md の設計上の制約）。この Service Worker は落ちてよく、
 * 次に起きたときに設定を読み直してバッジを描けばよい。
 */

import { browser } from 'wxt/browser';
import { loadSettings, watchSettings } from '@/lib/settings';

/** 記録中に出すバッジ。数文字しか入らないため短く。 */
const BADGE_TEXT = 'REC';
const BADGE_COLOR = '#dc2626';

async function applyBadge(recording: boolean): Promise<void> {
  try {
    await browser.action.setBadgeText({ text: recording ? BADGE_TEXT : '' });
    if (recording) {
      await browser.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
    }
  } catch (error) {
    console.error('[EverLog] failed to update badge', error);
  }
}

async function refreshBadge(): Promise<void> {
  const settings = await loadSettings(browser.storage.local);
  await applyBadge(settings.recording);
}

export default defineBackground(() => {
  // Service Worker は起動のたびにこの本体を実行する。アイドルで終了した後に
  // 起こされた場合もここを通るため、まず現在の設定でバッジを描き直す。
  void refreshBadge();

  // ブラウザ起動直後と、インストール・更新直後。上の 1 行で足りることが多いが、
  // バッジは表示が消えても気づきにくいので取りこぼしを潰しておく。
  browser.runtime.onStartup.addListener(() => void refreshBadge());
  browser.runtime.onInstalled.addListener(() => void refreshBadge());

  watchSettings(browser.storage, (settings) => {
    void applyBadge(settings.recording);
  });
});
