import { describe, expect, it, vi } from 'vitest';
import {
  GET_CONTENT_TIMEOUT_MS,
  getContentAsync,
  startNetworkCapture,
  type CapturedRequest,
  type NetworkCaptureApi,
} from '@/lib/capture';
import type { CaptureContext, HarLikeEntry, NetworkLogEntry } from '@/lib/network-log';

/** テストからリスナーを任意に発火できる `onRequestFinished` のフェイク。 */
function createFakeApi() {
  const listeners = new Set<(request: CapturedRequest) => void>();
  const api: NetworkCaptureApi = {
    onRequestFinished: {
      addListener: (listener) => {
        listeners.add(listener);
      },
      removeListener: (listener) => {
        listeners.delete(listener);
      },
    },
  };
  return {
    api,
    listenerCount: () => listeners.size,
    emit: (request: CapturedRequest) => {
      for (const listener of listeners) listener(request);
    },
  };
}

interface FakeRequestOptions {
  mimeType?: string;
  size?: number;
  /** getContent がコールバックに渡す値。null を渡すと取得失敗を模す */
  content?: string | null;
  encoding?: string;
  /** getContent が同期例外を投げる */
  throws?: boolean;
  /** getContent がコールバックを一度も呼ばない（応答が返らないケース） */
  neverCallsBack?: boolean;
  /** getContent が呼ばれた回数を記録する */
  onGetContent?: () => void;
}

function createFakeRequest(options: FakeRequestOptions = {}): CapturedRequest {
  const entry: HarLikeEntry = {
    startedDateTime: '2026-08-05T12:00:00.000Z',
    time: 10,
    request: {
      url: 'https://api.example.com/items',
      method: 'POST',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
    },
    response: {
      status: 201,
      headers: [{ name: 'Content-Type', value: options.mimeType ?? 'application/json' }],
      content: { mimeType: options.mimeType ?? 'application/json', size: options.size ?? 20 },
    },
  };

  return {
    ...entry,
    getContent(callback) {
      options.onGetContent?.();
      if (options.throws) throw new Error('getContent failed');
      if (options.neverCallsBack) return;
      // Chrome の実 API と同様、コールバックは非同期に呼ばれる想定
      queueMicrotask(() => {
        callback(options.content as string, options.encoding ?? '');
      });
    },
  };
}

const context: CaptureContext = {
  tabId: 7,
  pageUrl: 'https://example.com/page',
  now: 1_700_000_000_000,
};

/** handler が呼ばれるまで待つ。 */
function captureOnce(
  api: NetworkCaptureApi,
  emit: () => void,
): Promise<NetworkLogEntry> {
  return new Promise((resolve) => {
    const stop = startNetworkCapture(api, () => context, (entry) => {
      stop();
      resolve(entry);
    });
    emit();
  });
}

describe('startNetworkCapture', () => {
  it('リクエスト完了時に組み立て済みエントリを handler へ渡す', async () => {
    const fake = createFakeApi();
    const request = createFakeRequest({ content: '{"id":1}' });

    const entry = await captureOnce(fake.api, () => fake.emit(request));

    expect(entry).toMatchObject({
      tabId: 7,
      pageUrl: 'https://example.com/page',
      url: 'https://api.example.com/items',
      method: 'POST',
      status: 201,
      mimeType: 'application/json',
      body: '{"id":1}',
      bodyStatus: 'stored',
    });
  });

  it('base64 エンコードされたボディをデコードして渡す', async () => {
    const fake = createFakeApi();
    const request = createFakeRequest({
      content: Buffer.from('{"ok":true}', 'utf-8').toString('base64'),
      encoding: 'base64',
    });

    const entry = await captureOnce(fake.api, () => fake.emit(request));

    expect(entry.body).toBe('{"ok":true}');
    expect(entry.bodyStatus).toBe('stored');
  });

  it('対象外の MIME タイプでは getContent を呼ばない', async () => {
    const fake = createFakeApi();
    const onGetContent = vi.fn();
    const request = createFakeRequest({ mimeType: 'image/png', onGetContent });

    const entry = await captureOnce(fake.api, () => fake.emit(request));

    expect(onGetContent).not.toHaveBeenCalled();
    expect(entry.bodyStatus).toBe('mime_excluded');
    expect(entry.body).toBeNull();
  });

  it('サイズ上限を超える場合も getContent を呼ばない', async () => {
    const fake = createFakeApi();
    const onGetContent = vi.fn();
    const request = createFakeRequest({ size: 10 * 1024 * 1024, onGetContent });

    const entry = await captureOnce(fake.api, () => fake.emit(request));

    expect(onGetContent).not.toHaveBeenCalled();
    expect(entry.bodyStatus).toBe('too_large');
  });

  it('getContent が失敗してもエントリは捨てずに fetch_failed で渡す', async () => {
    const fake = createFakeApi();
    const request = createFakeRequest({ content: null });

    const entry = await captureOnce(fake.api, () => fake.emit(request));

    expect(entry.bodyStatus).toBe('fetch_failed');
    expect(entry.body).toBeNull();
    expect(entry.url).toBe('https://api.example.com/items');
  });

  it('getContent が同期例外を投げても fetch_failed で渡す', async () => {
    const fake = createFakeApi();
    const request = createFakeRequest({ throws: true });

    const entry = await captureOnce(fake.api, () => fake.emit(request));

    expect(entry.bodyStatus).toBe('fetch_failed');
  });

  it('getContent がコールバックを呼ばないままでも、時間切れで fetch_failed として渡す', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeApi();
      const request = createFakeRequest({ neverCallsBack: true });

      const pending = captureOnce(fake.api, () => fake.emit(request));
      await vi.advanceTimersByTimeAsync(GET_CONTENT_TIMEOUT_MS);
      const entry = await pending;

      // メタデータは残す。エントリごと取りこぼさない
      expect(entry.bodyStatus).toBe('fetch_failed');
      expect(entry.body).toBeNull();
      expect(entry.url).toBe('https://api.example.com/items');
      expect(entry.status).toBe(201);
    } finally {
      vi.useRealTimers();
    }
  });

  it('リクエストごとに context を取り直す（ページ遷移に追従する）', async () => {
    const fake = createFakeApi();
    const entries: NetworkLogEntry[] = [];
    let pageUrl = 'https://example.com/first';

    const stop = startNetworkCapture(
      fake.api,
      () => ({ tabId: 7, pageUrl }),
      (entry) => entries.push(entry),
    );

    fake.emit(createFakeRequest({ content: 'a' }));
    await vi.waitFor(() => expect(entries).toHaveLength(1));

    pageUrl = 'https://example.com/second';
    fake.emit(createFakeRequest({ content: 'b' }));
    await vi.waitFor(() => expect(entries).toHaveLength(2));

    stop();

    expect(entries[0]?.pageUrl).toBe('https://example.com/first');
    expect(entries[1]?.pageUrl).toBe('https://example.com/second');
  });

  it('停止関数を呼ぶとリスナーが解除され、以降は handler が呼ばれない', async () => {
    const fake = createFakeApi();
    const handler = vi.fn();

    const stop = startNetworkCapture(fake.api, () => context, handler);
    expect(fake.listenerCount()).toBe(1);

    stop();
    expect(fake.listenerCount()).toBe(0);

    fake.emit(createFakeRequest({ content: '{}' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('getContentAsync', () => {
  it('コールバックが呼ばれなければ時間切れで content: null に解決する', async () => {
    const request = createFakeRequest({ neverCallsBack: true });

    await expect(getContentAsync(request, 5)).resolves.toEqual({ content: null, encoding: '' });
  });

  it('コールバックが呼ばれれば時間切れを待たずに解決する', async () => {
    const request = createFakeRequest({ content: '{"ok":true}', encoding: '' });

    await expect(getContentAsync(request, GET_CONTENT_TIMEOUT_MS)).resolves.toEqual({
      content: '{"ok":true}',
      encoding: '',
    });
  });

  it('時間切れ後にコールバックが遅れて呼ばれても二重解決しない', async () => {
    let late: ((content: string, encoding: string) => void) | undefined;
    const request: CapturedRequest = {
      ...createFakeRequest(),
      getContent(callback) {
        late = callback;
      },
    };

    const result = await getContentAsync(request, 5);
    expect(result.content).toBeNull();

    expect(() => late?.('{"late":true}', '')).not.toThrow();
  });
});
