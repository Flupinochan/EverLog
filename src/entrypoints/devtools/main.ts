/**
 * DevTools ページ。DevTools ウィンドウが開いている間だけ存在する。
 *
 * ここでの役割は配線のみ。実際のキャプチャ処理は `src/lib/capture.ts` にある。
 */

import { browser } from 'wxt/browser';
import { startNetworkCapture } from '@/lib/capture';
import { addLog, clearAll, getBody, queryLogs } from '@/lib/db';
import { sanitizeEntry } from '@/lib/sanitize';
import type { NetworkLogEntry } from '@/lib/network-log';

/**
 * キャプチャしたエントリをサニタイズして保存する。
 *
 * サニタイズを通すのはここ 1 箇所だけであり、`addLog()` が `SanitizedLogEntry` しか
 * 受け取らないため、素通しで保存する経路は型で塞がれている。
 */
async function saveEntry(entry: NetworkLogEntry): Promise<void> {
  const sanitized = sanitizeEntry(entry);
  try {
    await addLog(sanitized);
  } catch (error) {
    // 1 件の保存失敗でキャプチャ全体を止めない。
    // 出力する URL はサニタイズ後のものに限る（生の URL にはトークンが載りうるため）
    console.error('[EverLog] failed to save entry', sanitized.url, error);
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
  (entry) => void saveEntry(entry),
);

// UI が無い段階の手動確認用。DevTools ウィンドウを undock して DevTools 自身の
// DevTools を開き、コンソールから everlog.queryLogs() などを呼ぶ。
(globalThis as typeof globalThis & { everlog?: unknown }).everlog = {
  queryLogs,
  getBody,
  clearAll,
};
