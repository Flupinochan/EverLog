/**
 * Service Worker。コンソールログの保存を担う。
 *
 * **ネットワークログの保存はここに置かない。** そちらは DevTools ページが
 * IndexedDB を直接開く（CLAUDE.md の設計上の制約）。
 *
 * コンソールログだけは例外で、ここが唯一の保存経路になる。記録元のコンテントスクリプトは
 * ページのオリジンで動くため拡張機能の IndexedDB を開けず、受け皿が他に無いことによる。
 * Service Worker は落ちてよい。次のメッセージで起こされ、そこで開き直せばよい。
 */

import { browser } from 'wxt/browser';
import { isConsoleBatchMessage, normalizeCapturedEntry } from '@/lib/console-log';
import { addConsoleLogs } from '@/lib/db';
import { shouldCaptureUrl } from '@/lib/network-log';
import { sanitizeConsoleEntry } from '@/lib/sanitize';
import { loadSettings } from '@/lib/settings';

/**
 * 届いたコンソールエントリをサニタイズして保存する。
 *
 * `tabId` はここで `sender.tab.id` から載せる。ページ側は自分のタブ ID を知らず、
 * 知らせる手段も無い（`CapturedConsoleEntry` が `tabId` を持たないのはこのため）。
 *
 * 記録の可否をここでも読み直す。バッチが飛んでいる最中に記録を OFF にした分は、
 * ページ側の判定をすり抜けて届く。`devtools/main.ts` の `saveEntry()` と同じ二段構え。
 */
async function saveConsoleEntries(entries: readonly unknown[], tabId: number | undefined): Promise<void> {
  if (entries.length === 0) return;
  // タブが特定できない経路から届いたものは記録しない。タブで絞り込めないログは
  // 一覧で切り分けられず、出所も追えないため
  if (tabId === undefined) return;

  const settings = await loadSettings(browser.storage.local);
  if (!settings.consoleRecording) return;

  // ここが保存経路の信頼境界になる。エントリを運ぶ CustomEvent はページからも
  // 発火できるため、形を整えてからでないとサニタイズ層で例外になり、同じバッチの
  // 正しいエントリまで失う
  const sanitized = entries
    .map(normalizeCapturedEntry)
    .filter((entry) => entry !== null)
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
  // コンソールログの受け口。ブリッジ（`console-bridge.content.ts`）だけが送ってくる
  browser.runtime.onMessage.addListener((message, sender) => {
    if (!isConsoleBatchMessage(message)) return;
    // 保存の失敗を握りつぶさず、ここで必ず受け止める。投げっぱなしにすると
    // 想定外の形が届いたときに unhandled rejection になり、原因が追えない
    void saveConsoleEntries(message.entries, sender.tab?.id).catch((error: unknown) => {
      console.error('[EverLog] failed to handle console batch', error);
    });
    // 応答は返さない。送信側は結果を待っておらず、true を返して口を開けたままにすると
    // Service Worker が保存の間ずっと起きていることになる
  });
});
