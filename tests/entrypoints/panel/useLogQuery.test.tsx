// @vitest-environment jsdom

/**
 * 一覧データの取得フック。
 *
 * 見るのは取得の段取り（応答の前後関係・自動更新の間引き）。絞り込み条件の意味は
 * `tests/lib/panel-view.test.ts` と `tests/lib/db.test.ts` が持つ。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogFilter, StoredLog } from '@/lib/db';
import { useLogQuery } from '@/entrypoints/panel/hooks/useLogQuery';
import { createFakeLogSource, deferred } from '../../support/fakes';
import { storedLog } from '../../support/fixtures';
import { act, renderHook, waitFor } from '../../support/render';

const FILTER: LogFilter = {};

/** `document.hidden` を差し替える。jsdom の既定は「見えている」。 */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

afterEach(() => {
  vi.useRealTimers();
  // 次のテストへ持ち越さないよう、jsdom 既定の getter に戻す
  delete (document as unknown as Record<string, unknown>).hidden;
});

describe('useLogQuery', () => {
  it('上限より 1 件多く取り、超えた分は表示せず続きがあることにする', async () => {
    const source = createFakeLogSource({
      logs: [storedLog({}, 1), storedLog({}, 2), storedLog({}, 3)],
    });

    const { result } = renderHook(() => useLogQuery(source, FILTER, 2, null));

    await waitFor(() => expect(result.current.initialLoading).toBe(false));
    expect(source.queryLogs).toHaveBeenCalledWith({ limit: 3 });
    expect(result.current.logs).toHaveLength(2);
    expect(result.current.hasMore).toBe(true);
  });

  it('読み込み中の表示は最初の結果までにする', async () => {
    const source = createFakeLogSource();
    const first = deferred<StoredLog[]>();
    source.queryLogs.mockReturnValueOnce(first.promise);

    const { result } = renderHook(() => useLogQuery(source, FILTER, 10, null));
    expect(result.current.initialLoading).toBe(true);

    await act(async () => {
      first.resolve([]);
    });
    expect(result.current.initialLoading).toBe(false);
  });

  it('遅れて届いた古い条件の結果で新しい結果を上書きしない', async () => {
    const source = createFakeLogSource();
    const stale = deferred<StoredLog[]>();
    const fresh = deferred<StoredLog[]>();
    source.queryLogs.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);

    const freshLogs = [storedLog({ url: 'https://api.example.com/fresh' }, 2)];
    const { result, rerender } = renderHook(
      ({ filter }: { filter: LogFilter }) => useLogQuery(source, filter, 10, null),
      { initialProps: { filter: { urlIncludes: 'old' } } },
    );

    rerender({ filter: { urlIncludes: 'new' } });

    await act(async () => {
      fresh.resolve(freshLogs);
    });
    await act(async () => {
      stale.resolve([storedLog({ url: 'https://api.example.com/stale' }, 1)]);
    });

    expect(result.current.logs).toEqual(freshLogs);
  });

  it('前の走査が終わるまで自動更新の次を始めない', async () => {
    vi.useFakeTimers();
    const source = createFakeLogSource();
    const inFlight = deferred<StoredLog[]>();
    source.queryLogs.mockReturnValueOnce(inFlight.promise);

    renderHook(() => useLogQuery(source, FILTER, 10, 1000));
    expect(source.queryLogs).toHaveBeenCalledTimes(1);

    // 走査中は何度 tick が来ても積み増さない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(source.queryLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      inFlight.resolve([]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(source.queryLogs).toHaveBeenCalledTimes(2);
  });

  it('見えていない間は自動更新で取りに行かない', async () => {
    vi.useFakeTimers();
    const source = createFakeLogSource();
    renderHook(() => useLogQuery(source, FILTER, 10, 1000));
    // タイマーを差し替えている間は `waitFor` が進まないため、act で解決を流す
    await act(async () => {});

    setHidden(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(source.queryLogs).toHaveBeenCalledTimes(1);

    // 再び見えたら次の tick を待たずに追いつく
    setHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(source.queryLogs).toHaveBeenCalledTimes(2);
  });

  it('自動更新を止めるとタイマーを張らない', async () => {
    vi.useFakeTimers();
    const source = createFakeLogSource();
    renderHook(() => useLogQuery(source, FILTER, 10, null));
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(source.queryLogs).toHaveBeenCalledTimes(1);
  });

  it('中身が変わらなければ配列を作り直さない（再描画を起こさないため）', async () => {
    const source = createFakeLogSource({ logs: [storedLog({}, 1)] });
    const { result } = renderHook(() => useLogQuery(source, FILTER, 10, null));
    await waitFor(() => expect(result.current.logs).toHaveLength(1));

    const before = result.current.logs;
    await act(async () => {
      result.current.reload();
    });

    expect(result.current.logs).toBe(before);
  });

  it('手動更新は走査中でも間引かない', async () => {
    const source = createFakeLogSource();
    const inFlight = deferred<StoredLog[]>();
    source.queryLogs.mockReturnValueOnce(inFlight.promise);

    const { result } = renderHook(() => useLogQuery(source, FILTER, 10, null));
    expect(source.queryLogs).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.reload();
    });
    expect(source.queryLogs).toHaveBeenCalledTimes(2);

    inFlight.resolve([]);
  });

  it('失敗の理由を伝え、次に成功したら消す', async () => {
    const source = createFakeLogSource({ logs: [storedLog({}, 1)] });
    source.queryLogs.mockRejectedValueOnce(new Error('database closed'));

    const { result } = renderHook(() => useLogQuery(source, FILTER, 10, null));
    await waitFor(() => expect(result.current.error).toBe('database closed'));

    await act(async () => {
      result.current.reload();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.logs).toHaveLength(1);
  });
});
