/**
 * MAIN world の記録を background へ中継するコンテントスクリプト（ISOLATED world）。
 *
 * MAIN world からは `chrome.runtime` に触れないため、この層が必要になる。
 * 併せて「記録してよいか」の判定もここで持つ。設定を読めるのは拡張機能の世界にいる
 * こちらだけであり、ページ側に設定を配ると差し替えられる余地を作ることになる。
 *
 * 保存はしない。コンテントスクリプトはページのオリジンで動くため、拡張機能の
 * IndexedDB を開けない。保存は background の役目。
 */

import { browser } from 'wxt/browser';
import {
  CAPTURE_STATE_EVENT,
  CONSOLE_BATCH_MESSAGE,
  CONSOLE_ENTRY_EVENT,
  BRIDGE_READY_EVENT,
  MAIN_READY_EVENT,
  normalizeConsoleLevel,
  type CapturedConsoleEntry,
  type ConsoleBatchMessage,
} from '@/lib/console-log';
import { DEFAULT_URL_FILTER, shouldCaptureUrl, type UrlFilter } from '@/lib/network-log';
import { loadSettings, watchSettings } from '@/lib/settings';

/**
 * まとめて送るまでの待ち時間と件数。
 *
 * 1 件ずつ送らない。`runtime.sendMessage` は 1 回ごとに Service Worker を起こすため、
 * ループ内の `console.log` がそのまま起床の連打になる。
 */
const FLUSH_INTERVAL_MS = 200;
const FLUSH_SIZE = 20;

function install(): void {
  let recording = true;
  let urlFilter: UrlFilter = DEFAULT_URL_FILTER;

  const buffer: CapturedConsoleEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  function notifyMain(enabled: boolean): void {
    window.dispatchEvent(
      new CustomEvent(CAPTURE_STATE_EVENT, { detail: JSON.stringify({ enabled }) }),
    );
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;

    const message: ConsoleBatchMessage = {
      type: CONSOLE_BATCH_MESSAGE,
      entries: buffer.splice(0),
    };

    try {
      // 応答は待たない。届いたかどうかで記録側の動きを変えないため。
      // 拡張機能の更新直後はコンテキストが無効になっていて例外になる（ページを
      // 読み込み直すまで復帰しない）ので、そこで止まらないよう握りつぶす
      void browser.runtime.sendMessage(message).catch(() => undefined);
    } catch {
      // 同上（同期的に投げる場合がある）
    }
  }

  function schedule(): void {
    if (buffer.length >= FLUSH_SIZE) {
      flush();
      return;
    }
    if (timer !== null) return;
    timer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }

  /** 受け取った JSON を最低限だけ検証して積む。 */
  function accept(payload: unknown): void {
    if (typeof payload !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;

    const entry = parsed as CapturedConsoleEntry;
    // ページから届く値なので、レベルだけは既知のものに寄せる。保存層の絞り込みが
    // 想定していない値で埋まるのを防ぐ
    buffer.push({ ...entry, level: normalizeConsoleLevel(entry.level) });
    schedule();
  }

  window.addEventListener(CONSOLE_ENTRY_EVENT, (event) => {
    // 記録の可否はここで見る。MAIN 側にも同じフラグを配っているが、設定が変わった
    // 直後の 1 件が通り抜けることがあるため、渡す側でもう一度確かめる
    if (!recording) return;
    if (!shouldCaptureUrl(location.href, urlFilter)) return;
    accept((event as CustomEvent<string>).detail);
  });

  // MAIN 側が後から立ち上がった場合の合図
  window.addEventListener(MAIN_READY_EVENT, () => {
    window.dispatchEvent(new CustomEvent(BRIDGE_READY_EVENT));
    notifyMain(recording);
  });

  function apply(settings: { consoleRecording: boolean; urlFilter: UrlFilter }): void {
    recording = settings.consoleRecording;
    urlFilter = settings.urlFilter;
    notifyMain(recording);
  }

  void loadSettings(browser.storage.local).then(apply);
  // popup で切り替えたときに、ページを読み込み直さずに反映されるようにする
  watchSettings(browser.storage, apply);

  // 溜まった分を残さず送る。`visibilitychange` ではなく `pagehide` を見るのは、
  // タブを閉じた場合とページ遷移の両方を拾うため
  window.addEventListener('pagehide', flush);

  // こちらが先に立ち上がった場合の合図。MAIN 側はこれを受けて溜めた分を流す
  window.dispatchEvent(new CustomEvent(BRIDGE_READY_EVENT));
}

export default defineContentScript({
  matches: ['*://*/*'],
  runAt: 'document_start',
  allFrames: true,
  main: install,
});
