/**
 * Service Worker。バッジ表示と、コンソールログの保存を担う。
 *
 * 記録が有効であることを常時明示する。popup を開いていない間も
 * 設定の変更に追従させたいが、popup は閉じるとコンテキストごと消えるため、
 * ここで購読する。
 *
 * **ネットワークログの保存はここに置かない。** そちらは DevTools ページが
 * IndexedDB を直接開く（CLAUDE.md の設計上の制約）。
 *
 * コンソールログだけは例外で、ここが唯一の保存経路になる。記録元のコンテントスクリプトは
 * ページのオリジンで動くため拡張機能の IndexedDB を開けず、受け皿が他に無いことによる。
 * Service Worker は落ちてよい。次のメッセージで起こされ、そこで開き直せばよい。
 */

import { browser } from 'wxt/browser';
import { isConsoleBatchMessage, type CapturedConsoleEntry } from '@/lib/console-log';
import { addConsoleLogs } from '@/lib/db';
import { shouldCaptureUrl } from '@/lib/network-log';
import { sanitizeConsoleEntry } from '@/lib/sanitize';
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

/**
 * 届いたコンソールエントリをサニタイズして保存する。
 *
 * `tabId` はここで `sender.tab.id` から載せる。ページ側は自分のタブ ID を知らず、
 * 知らせる手段も無い（`CapturedConsoleEntry` が `tabId` を持たないのはこのため）。
 *
 * 記録の可否をここでも読み直す。バッチが飛んでいる最中に記録を OFF にした分は、
 * ページ側の判定をすり抜けて届く。`devtools/main.ts` の `saveEntry()` と同じ二段構え。
 */
async function saveConsoleEntries(
  entries: readonly CapturedConsoleEntry[],
  tabId: number | undefined,
): Promise<void> {
  if (entries.length === 0) return;
  // タブが特定できない経路から届いたものは記録しない。タブで絞り込めないログは
  // 一覧で切り分けられず、出所も追えないため
  if (tabId === undefined) return;

  const settings = await loadSettings(browser.storage.local);
  if (!settings.consoleRecording) return;

  const sanitized = entries
    .filter((entry) => shouldCaptureUrl(entry.pageUrl, settings.urlFilter))
    .map((entry) => sanitizeConsoleEntry({ ...entry, tabId }));

  if (sanitized.length === 0) return;

  try {
    await addConsoleLogs(sanitized);
  } catch (error) {
    // 1 バッチの保存失敗で記録全体を止めない。出力する URL はサニタイズ後のものに限る
    console.error('[EverLog] failed to save console entries', sanitized[0]?.pageUrl, error);
  }
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

  // コンソールログの受け口。ブリッジ（`console-bridge.content.ts`）だけが送ってくる
  browser.runtime.onMessage.addListener((message, sender) => {
    if (!isConsoleBatchMessage(message)) return;
    void saveConsoleEntries(message.entries, sender.tab?.id);
    // 応答は返さない。送信側は結果を待っておらず、true を返して口を開けたままにすると
    // Service Worker が保存の間ずっと起きていることになる
  });
});
