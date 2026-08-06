import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPTURE_OPTIONS,
  attachBody,
  buildLogEntry,
  byteLength,
  headersToRecord,
  matchesMimePatterns,
  parseMimeType,
  type CaptureContext,
  type HarLikeEntry,
  type NetworkLogEntry,
} from './network-log';

const ctx: CaptureContext = { tabId: 42, pageUrl: 'https://example.com/app', now: 1_700_000_000_000 };

function harEntry(overrides: Partial<HarLikeEntry> = {}): HarLikeEntry {
  return {
    startedDateTime: '2026-08-05T12:00:00.000Z',
    time: 123.4,
    request: {
      url: 'https://api.example.com/users',
      method: 'GET',
      headers: [{ name: 'Accept', value: 'application/json' }],
    },
    response: {
      status: 200,
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      content: { mimeType: 'application/json', size: 100 },
    },
    ...overrides,
  };
}

/** ボディ付きエントリの雛形。attachBody のテスト用。 */
function baseEntry(): NetworkLogEntry {
  return buildLogEntry(harEntry(), ctx).entry;
}

describe('parseMimeType', () => {
  it('パラメータを落として小文字化する', () => {
    expect(parseMimeType('application/json; charset=utf-8')).toBe('application/json');
    expect(parseMimeType('TEXT/HTML')).toBe('text/html');
    expect(parseMimeType('  application/xml  ')).toBe('application/xml');
  });

  it('未指定・空文字は空文字を返す', () => {
    expect(parseMimeType(undefined)).toBe('');
    expect(parseMimeType('')).toBe('');
  });
});

describe('matchesMimePatterns', () => {
  const patterns = DEFAULT_CAPTURE_OPTIONS.mimePatterns;

  it('完全一致で判定する', () => {
    expect(matchesMimePatterns('application/json', patterns)).toBe(true);
    expect(matchesMimePatterns('application/xml', patterns)).toBe(true);
  });

  it('末尾ワイルドカードで判定する', () => {
    expect(matchesMimePatterns('text/html', patterns)).toBe(true);
    expect(matchesMimePatterns('text/plain', patterns)).toBe(true);
  });

  it('対象外の MIME タイプは一致しない', () => {
    expect(matchesMimePatterns('image/png', patterns)).toBe(false);
    expect(matchesMimePatterns('video/mp4', patterns)).toBe(false);
    expect(matchesMimePatterns('application/javascript', patterns)).toBe(false);
  });

  it('MIME タイプが空なら一致しない', () => {
    expect(matchesMimePatterns('', patterns)).toBe(false);
  });

  it('全許可パターンに対応する', () => {
    expect(matchesMimePatterns('image/png', ['*/*'])).toBe(true);
    expect(matchesMimePatterns('image/png', ['*'])).toBe(true);
  });
});

describe('headersToRecord', () => {
  it('ヘッダー名を小文字に正規化する', () => {
    expect(headersToRecord([{ name: 'Content-Type', value: 'application/json' }])).toEqual({
      'content-type': 'application/json',
    });
  });

  it('同名ヘッダーを連結する', () => {
    const record = headersToRecord([
      { name: 'Set-Cookie', value: 'a=1' },
      { name: 'set-cookie', value: 'b=2' },
    ]);
    expect(record['set-cookie']).toBe('a=1, b=2');
  });

  it('未指定・空配列は空レコードを返す', () => {
    expect(headersToRecord(undefined)).toEqual({});
    expect(headersToRecord([])).toEqual({});
  });

  it('この層ではサニタイズしない（許可リストは保存層の責務）', () => {
    const record = headersToRecord([{ name: 'Authorization', value: 'Bearer token' }]);
    expect(record['authorization']).toBe('Bearer token');
  });
});

describe('buildLogEntry', () => {
  it('HAR エントリの各フィールドを写し取る', () => {
    const { entry } = buildLogEntry(harEntry(), ctx);

    expect(entry).toMatchObject({
      ts: Date.parse('2026-08-05T12:00:00.000Z'),
      tabId: 42,
      pageUrl: 'https://example.com/app',
      url: 'https://api.example.com/users',
      method: 'GET',
      status: 200,
      mimeType: 'application/json',
      timeMs: 123.4,
      bodySize: 100,
      body: null,
    });
    expect(entry.requestHeaders).toEqual({ accept: 'application/json' });
    expect(entry.responseHeaders).toEqual({ 'content-type': 'application/json' });
  });

  it('JSON レスポンスはボディ取得の対象になる', () => {
    const { shouldFetchBody, entry } = buildLogEntry(harEntry(), ctx);
    expect(shouldFetchBody).toBe(true);
    expect(entry.bodyStatus).toBe('stored');
  });

  it('対象外の MIME タイプはボディを取得せず mime_excluded にする', () => {
    const { shouldFetchBody, entry } = buildLogEntry(
      harEntry({
        response: { status: 200, content: { mimeType: 'image/png', size: 5000 } },
      }),
      ctx,
    );

    expect(shouldFetchBody).toBe(false);
    expect(entry.bodyStatus).toBe('mime_excluded');
    expect(entry.body).toBeNull();
    expect(entry.bodySize).toBe(5000);
  });

  it('サイズ上限を超えるボディは取得せず too_large にする', () => {
    const { shouldFetchBody, entry } = buildLogEntry(
      harEntry({
        response: {
          status: 200,
          content: { mimeType: 'application/json', size: DEFAULT_CAPTURE_OPTIONS.maxBodyBytes + 1 },
        },
      }),
      ctx,
    );

    expect(shouldFetchBody).toBe(false);
    expect(entry.bodyStatus).toBe('too_large');
    expect(entry.body).toBeNull();
  });

  it('MIME 判定はサイズ判定より優先される', () => {
    const { entry } = buildLogEntry(
      harEntry({
        response: {
          status: 200,
          content: { mimeType: 'video/mp4', size: DEFAULT_CAPTURE_OPTIONS.maxBodyBytes + 1 },
        },
      }),
      ctx,
    );
    expect(entry.bodyStatus).toBe('mime_excluded');
  });

  it('オプションで上限と対象 MIME を差し替えられる', () => {
    const result = buildLogEntry(harEntry(), ctx, { mimePatterns: ['text/*'], maxBodyBytes: 10 });
    expect(result.entry.bodyStatus).toBe('mime_excluded');

    const sizeResult = buildLogEntry(harEntry(), ctx, {
      mimePatterns: ['application/json'],
      maxBodyBytes: 10,
    });
    expect(sizeResult.entry.bodyStatus).toBe('too_large');
  });

  it('startedDateTime が欠落・不正なら現在時刻にフォールバックする', () => {
    expect(buildLogEntry(harEntry({ startedDateTime: undefined }), ctx).entry.ts).toBe(ctx.now);
    expect(buildLogEntry(harEntry({ startedDateTime: 'not-a-date' }), ctx).entry.ts).toBe(ctx.now);
  });

  it('content.size が無い場合は bodySize を使う', () => {
    const { entry } = buildLogEntry(
      harEntry({
        response: { status: 200, content: { mimeType: 'application/json' }, bodySize: 321 },
      }),
      ctx,
    );
    expect(entry.bodySize).toBe(321);
  });

  it('サイズが不明（-1）なら 0 として扱う', () => {
    const { entry, shouldFetchBody } = buildLogEntry(
      harEntry({
        response: {
          status: 200,
          content: { mimeType: 'application/json', size: -1 },
          bodySize: -1,
        },
      }),
      ctx,
    );
    expect(entry.bodySize).toBe(0);
    // サイズ不明でも取得は試み、実バイト長は attachBody で確定させる
    expect(shouldFetchBody).toBe(true);
  });

  it('time が欠落していれば 0 にする', () => {
    expect(buildLogEntry(harEntry({ time: undefined }), ctx).entry.timeMs).toBe(0);
  });
});

describe('attachBody', () => {
  it('プレーンテキストのボディを保存する', () => {
    const result = attachBody(baseEntry(), '{"ok":true}', '');

    expect(result.body).toBe('{"ok":true}');
    expect(result.bodyStatus).toBe('stored');
    expect(result.bodySize).toBe(byteLength('{"ok":true}'));
  });

  it('base64 のボディをデコードする（マルチバイト文字を含む）', () => {
    const text = '{"message":"こんにちは"}';
    const encoded = Buffer.from(text, 'utf-8').toString('base64');

    const result = attachBody(baseEntry(), encoded, 'base64');

    expect(result.body).toBe(text);
    expect(result.bodyStatus).toBe('stored');
    expect(result.bodySize).toBe(byteLength(text));
  });

  it('ボディが取得できなかった場合は fetch_failed にする', () => {
    for (const content of [null, undefined]) {
      const result = attachBody(baseEntry(), content, '');
      expect(result.bodyStatus).toBe('fetch_failed');
      expect(result.body).toBeNull();
    }
  });

  it('base64 のデコードに失敗した場合は fetch_failed にする', () => {
    const result = attachBody(baseEntry(), '!!!not-base64!!!', 'base64');
    expect(result.bodyStatus).toBe('fetch_failed');
    expect(result.body).toBeNull();
  });

  it('実バイト長が上限を超えたらボディを捨てて too_large にする', () => {
    const oversized = 'a'.repeat(DEFAULT_CAPTURE_OPTIONS.maxBodyBytes + 1);

    const result = attachBody(baseEntry(), oversized, '');

    expect(result.bodyStatus).toBe('too_large');
    expect(result.body).toBeNull();
    expect(result.bodySize).toBe(oversized.length);
  });

  it('メタデータは維持したまま新しいエントリを返す（元を破壊しない）', () => {
    const entry = baseEntry();
    const result = attachBody(entry, 'body', '');

    expect(entry.body).toBeNull();
    expect(result).not.toBe(entry);
    expect(result.url).toBe(entry.url);
    expect(result.ts).toBe(entry.ts);
    expect(result.tabId).toBe(entry.tabId);
  });
});
