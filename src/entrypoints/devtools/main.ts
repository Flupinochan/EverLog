/**
 * DevTools ページ。DevTools ウィンドウが開いている間だけ存在する。
 *
 * ここでの役割は配線のみ。実際のキャプチャ処理は `src/lib/capture.ts` にある。
 */

import { browser } from 'wxt/browser';
import { startNetworkCapture } from '@/lib/capture';
import { addLog, clearAll, getBody, getStats, queryLogs } from '@/lib/db';
import { sanitizeEntry } from '@/lib/sanitize';
import { loadSettings, watchSettings, type Settings } from '@/lib/settings';
import {
  DEFAULT_URL_FILTER,
  shouldCaptureUrl,
  type NetworkLogEntry,
  type UrlFilter,
} from '@/lib/network-log';

/** 記録が有効か。切り替えは `applySettings()`。 */
let recording = false;

/**
 * キャプチャ対象を絞る URL フィルタ。切り替えは `applySettings()`。
 *
 * `recording` と同じくモジュールスコープに置き、キャプチャ側へはこれを読む
 * クロージャを渡す。値で渡すと変更のたびに購読を張り直すことになる。
 */
let urlFilter: UrlFilter = DEFAULT_URL_FILTER;

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

  // 同じ理由で URL フィルタも取り直す。ボディの取得を待っている間にパターンが
  // 追加された場合、キャプチャ層の判定を通り抜けた 1 件が残ってしまう。
  if (!shouldCaptureUrl(entry.url, urlFilter)) return;

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
    undefined,
    (url) => shouldCaptureUrl(url, urlFilter),
  );
}

function stopCapturing(): void {
  stopCapture?.();
  stopCapture = null;
}

/**
 * 設定を反映する。設定が生きた値になる場所をここ 1 箇所に保つ。
 *
 * 記録が OFF のときはリスナー自体を外す。ハンドラ側で捨てる作りにすると、
 * 記録していない間も `getContent()` を呼んでボディを取りに行ってしまうため。
 *
 * URL フィルタは変数を差し替えるだけでよい。キャプチャ側にはこれを読む
 * クロージャを渡しているので、購読を張り直さずに次のリクエストから効く。
 */
function applySettings(settings: Settings): void {
  settingsApplied = true;
  recording = settings.recording;
  urlFilter = settings.urlFilter;

  if (settings.recording) startCapture();
  else stopCapturing();
}

/**
 * 初回の設定読み込み。`saveEntry()` はこれを待ってから記録の可否を判断する。
 *
 * 読み込み中に変更通知が届いていたら、そちらが新しいので上書きしない。
 */
const settingsReady = loadSettings(browser.storage.local).then((settings) => {
  if (settingsApplied) return;
  applySettings(settings);
});

// 設定を読み終える前から購読は張っておく。ここを待つと、ページの読み込み中に
// DevTools を開いた場合などに最初の数件を取りこぼす。記録が OFF だった場合は
// 上の読み込みが購読を外し、その間に拾った分は saveEntry() が捨てる。
startCapture();

// popup で切り替えたときに、DevTools を開き直さずに反映されるようにする
watchSettings(browser.storage, (settings) => {
  applySettings(settings);
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
