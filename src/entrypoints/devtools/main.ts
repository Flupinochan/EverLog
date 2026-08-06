/**
 * DevTools ページ。DevTools ウィンドウが開いている間だけ存在する。
 *
 * ここでの役割は配線のみ。実際のキャプチャ処理は `src/lib/capture.ts` にある。
 */

import { browser } from 'wxt/browser';
import { startNetworkCapture } from '@/lib/capture';
import { addLog, clearAll, getBody, getStats, queryLogs } from '@/lib/db';
import { sanitizeEntry } from '@/lib/sanitize';
import { loadSettings, watchSettings } from '@/lib/settings';
import type { NetworkLogEntry } from '@/lib/network-log';

/** 記録が有効か。切り替えは `applyRecording()`。 */
let recording = false;

/**
 * キャプチャしたエントリをサニタイズして保存する。
 *
 * サニタイズを通すのはここ 1 箇所だけであり、`addLog()` が `SanitizedLogEntry` しか
 * 受け取らないため、素通しで保存する経路は型で塞がれている。
 */
async function saveEntry(entry: NetworkLogEntry): Promise<void> {
  // 記録の可否が確定するまで判断を保留する。DevTools を開いた直後は設定を読み終える
  // 前であり、ここで捨てると「記録は ON なのに開いた直後の数件だけ残らない」ことになる。
  await settingsReady;

  // 記録を OFF にした時点で `getContent()` の応答を待っていた分は、ここで捨てる。
  // 購読の解除だけでは、解除前に始まった 1 件が後から届いて保存されてしまう。
  if (!recording) return;

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

// ページ URL の追跡は記録状態に関わらず常に回す。記録を ON にした直後の 1 件目から
// 正しい pageUrl を載せるため。
void refreshPageUrl();
browser.devtools.network.onNavigated.addListener((url) => {
  pageUrl = url;
});

/** 購読中の場合はその解除関数。停止中は null。 */
let stopCapture: (() => void) | null = null;
/** 設定を一度でも反映したか。初回読み込みと変更通知の競合を避けるために持つ。 */
let settingsApplied = false;

function startCapture(): void {
  if (stopCapture !== null) return;
  stopCapture = startNetworkCapture(
    browser.devtools.network,
    () => ({ tabId: browser.devtools.inspectedWindow.tabId, pageUrl }),
    (entry) => void saveEntry(entry),
  );
}

function stopCapturing(): void {
  stopCapture?.();
  stopCapture = null;
}

/**
 * 記録状態を反映する。
 *
 * OFF のときはリスナー自体を外す。ハンドラ側で捨てる作りにすると、記録していない
 * 間も `getContent()` を呼んでボディを取りに行ってしまうため。
 */
function applyRecording(next: boolean): void {
  settingsApplied = true;
  recording = next;

  if (next) startCapture();
  else stopCapturing();
}

/**
 * 初回の設定読み込み。`saveEntry()` はこれを待ってから記録の可否を判断する。
 *
 * 読み込み中に変更通知が届いていたら、そちらが新しいので上書きしない。
 */
const settingsReady = loadSettings(browser.storage.local).then((settings) => {
  if (settingsApplied) return;
  applyRecording(settings.recording);
});

// 設定を読み終える前から購読は張っておく。ここを待つと、ページの読み込み中に
// DevTools を開いた場合などに最初の数件を取りこぼす。記録が OFF だった場合は
// 上の読み込みが購読を外し、その間に拾った分は saveEntry() が捨てる。
startCapture();

// popup で切り替えたときに、DevTools を開き直さずに反映されるようにする
watchSettings(browser.storage, (settings) => {
  applyRecording(settings.recording);
});

// 閲覧 UI を DevTools のパネルとして登録する。パネルのページは
// ビルド結果のルートに `panel.html` として出力される。
browser.devtools.panels.create('EverLog', '', 'panel.html');

// UI が無い段階の手動確認用。DevTools ウィンドウを undock して DevTools 自身の
// DevTools を開き、コンソールから everlog.queryLogs() などを呼ぶ。
(globalThis as typeof globalThis & { everlog?: unknown }).everlog = {
  queryLogs,
  getBody,
  getStats,
  clearAll,
};
