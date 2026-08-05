/**
 * DevTools ページ。DevTools ウィンドウが開いている間だけ存在する。
 *
 * ここでの役割は配線のみ。実際のキャプチャ処理は `lib/capture.ts` にある。
 */

import { browser } from 'wxt/browser';
import { startNetworkCapture } from '@/lib/capture';
import type { NetworkLogEntry } from '@/lib/network-log';

/** メモリ上に保持するエントリ数の上限。 */
const MAX_BUFFERED_ENTRIES = 1000;

/**
 * 直近のエントリを保持するリングバッファ。
 *
 * 保存層はまだ無いため、キャプチャ結果はここに積むだけで外部へは出さない。
 * 次フェーズでは Service Worker への Port 送信に差し替える。
 */
const entries: NetworkLogEntry[] = [];

function bufferEntry(entry: NetworkLogEntry): void {
  entries.push(entry);
  if (entries.length > MAX_BUFFERED_ENTRIES) {
    entries.splice(0, entries.length - MAX_BUFFERED_ENTRIES);
  }
}

/**
 * 記録時に開いていたページの URL。
 * `inspectedWindow` は URL を直接持たないため、評価とナビゲーション通知で追跡する。
 */
let pageUrl = '';

/** コールバック形式の `inspectedWindow.eval()` を Promise でラップする。 */
function evalInInspectedWindow(expression: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      browser.devtools.inspectedWindow.eval<string>(expression, (result, exceptionInfo) => {
        resolve(exceptionInfo ? null : (result ?? null));
      });
    } catch {
      resolve(null);
    }
  });
}

async function refreshPageUrl(): Promise<void> {
  const url = await evalInInspectedWindow('location.href');
  if (url !== null) pageUrl = url;
}

void refreshPageUrl();
browser.devtools.network.onNavigated.addListener((url) => {
  pageUrl = url;
});

startNetworkCapture(
  browser.devtools.network,
  () => ({ tabId: browser.devtools.inspectedWindow.tabId, pageUrl }),
  bufferEntry,
);

// 保存層も UI も無い段階の手動確認用。DevTools ウィンドウを undock して
// DevTools 自身の DevTools を開き、このハンドルからバッファを覗く。
(globalThis as typeof globalThis & { everlogEntries?: NetworkLogEntry[] }).everlogEntries = entries;
