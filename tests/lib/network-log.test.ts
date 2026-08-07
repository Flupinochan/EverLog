import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPTURE_OPTIONS,
  attachBody,
  buildLogEntry,
  byteLength,
  headersToRecord,
  matchesMimePatterns,
  matchesUrlPatterns,
  MAX_URL_PATTERNS,
  normalizeUrlFilter,
  parseMimeType,
  shouldCaptureUrl,
  type CaptureContext,
  type HarLikeEntry,
  type NetworkLogEntry,
} from '@/lib/network-log';

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

describe('matchesUrlPatterns', () => {
  const url = 'https://api.example.com/v1/oauth/token?client_id=abc';

  it('ワイルドカードを含まないパターンは URL の一部に一致すれば真を返す', () => {
    expect(matchesUrlPatterns(url, ['/oauth/'])).toBe(true);
    expect(matchesUrlPatterns(url, ['api.example.com'])).toBe(true);
  });

  it('一致しないパターンでは偽を返す', () => {
    expect(matchesUrlPatterns(url, ['/graphql'])).toBe(false);
  });

  it('* は / を跨いで任意の文字列に一致する', () => {
    expect(matchesUrlPatterns(url, ['https://api.example.com/*'])).toBe(true);
    expect(matchesUrlPatterns(url, ['example.com*token'])).toBe(true);
  });

  it('複数の * を含むパターンを左から順に照合する', () => {
    expect(matchesUrlPatterns(url, ['*v1*oauth*client_id*'])).toBe(true);
    // 順序が逆のものは一致しない
    expect(matchesUrlPatterns(url, ['*client_id*oauth*'])).toBe(false);
  });

  it('* だけのパターンはすべての URL に一致する', () => {
    expect(matchesUrlPatterns(url, ['*'])).toBe(true);
    expect(matchesUrlPatterns('', ['*'])).toBe(true);
  });

  it('大文字小文字は区別しない', () => {
    expect(matchesUrlPatterns(url, ['API.Example.COM'])).toBe(true);
    expect(matchesUrlPatterns('HTTPS://EXAMPLE.COM/A', ['example.com/a'])).toBe(true);
  });

  it('. や ? は正規表現ではなく文字そのものとして扱う', () => {
    expect(matchesUrlPatterns(url, ['api.example.com'])).toBe(true);
    expect(matchesUrlPatterns('https://apiXexample.com/', ['api.example.com'])).toBe(false);
    expect(matchesUrlPatterns(url, ['token?client_id='])).toBe(true);
  });

  it('空文字や空白だけのパターンは無視する', () => {
    expect(matchesUrlPatterns(url, [''])).toBe(false);
    expect(matchesUrlPatterns(url, ['   '])).toBe(false);
    expect(matchesUrlPatterns(url, ['', '/oauth/'])).toBe(true);
  });

  it('パターンの前後の空白は無視する', () => {
    expect(matchesUrlPatterns(url, ['  /oauth/  '])).toBe(true);
  });

  it('パターンが 1 つも無ければ一致しない', () => {
    expect(matchesUrlPatterns(url, [])).toBe(false);
  });
});

describe('shouldCaptureUrl', () => {
  const url = 'https://api.example.com/v1/oauth/token';

  it('deny では一致した URL を記録しない', () => {
    expect(shouldCaptureUrl(url, { mode: 'deny', patterns: ['*/oauth/*'] })).toBe(false);
  });

  it('deny では一致しない URL を記録する', () => {
    expect(shouldCaptureUrl(url, { mode: 'deny', patterns: ['*/graphql'] })).toBe(true);
  });

  it('allow では一致した URL だけ記録する', () => {
    expect(shouldCaptureUrl(url, { mode: 'allow', patterns: ['api.example.com'] })).toBe(true);
    expect(shouldCaptureUrl(url, { mode: 'allow', patterns: ['other.example.com'] })).toBe(false);
  });

  it('パターンが空なら allow でも deny でも記録する', () => {
    expect(shouldCaptureUrl(url, { mode: 'allow', patterns: [] })).toBe(true);
    expect(shouldCaptureUrl(url, { mode: 'deny', patterns: [] })).toBe(true);
  });

  it('空白だけのパターンしか無ければ記録する', () => {
    expect(shouldCaptureUrl(url, { mode: 'allow', patterns: ['', '  '] })).toBe(true);
    expect(shouldCaptureUrl(url, { mode: 'deny', patterns: ['', '  '] })).toBe(true);
  });
});

describe('normalizeUrlFilter', () => {
  it('未設定なら既定値を返す', () => {
    expect(normalizeUrlFilter(undefined)).toEqual({ mode: 'deny', patterns: [] });
    expect(normalizeUrlFilter(null)).toEqual({ mode: 'deny', patterns: [] });
    expect(normalizeUrlFilter('deny')).toEqual({ mode: 'deny', patterns: [] });
  });

  it('知らない mode は既定値に寄せる', () => {
    expect(normalizeUrlFilter({ mode: 'block', patterns: [] }).mode).toBe('deny');
    expect(normalizeUrlFilter({ mode: 'allow', patterns: [] }).mode).toBe('allow');
  });

  it('patterns が配列でなければ空にする', () => {
    expect(normalizeUrlFilter({ mode: 'allow', patterns: '*/oauth/*' }).patterns).toEqual([]);
  });

  it('文字列でない要素だけを落として残りは保持する', () => {
    expect(normalizeUrlFilter({ mode: 'deny', patterns: ['/a', 1, null, '/b'] }).patterns).toEqual([
      '/a',
      '/b',
    ]);
  });

  it('前後の空白を落とし、空文字のパターンは捨てる', () => {
    expect(normalizeUrlFilter({ mode: 'deny', patterns: ['  /a  ', '', '   '] }).patterns).toEqual([
      '/a',
    ]);
  });

  it('重複したパターンは 1 つにまとめる', () => {
    expect(normalizeUrlFilter({ mode: 'deny', patterns: ['/a', ' /a ', '/b'] }).patterns).toEqual([
      '/a',
      '/b',
    ]);
  });

  it('大文字小文字は保存時に潰さない', () => {
    expect(normalizeUrlFilter({ mode: 'deny', patterns: ['/API/Users'] }).patterns).toEqual([
      '/API/Users',
    ]);
  });

  it('上限を超えた分は切り捨てる', () => {
    const patterns = Array.from({ length: MAX_URL_PATTERNS + 10 }, (_, index) => `/p${index}`);

    expect(normalizeUrlFilter({ mode: 'deny', patterns }).patterns).toHaveLength(MAX_URL_PATTERNS);
  });

  it('呼ぶたびに新しい配列を返す（既定値を共有しない）', () => {
    const first = normalizeUrlFilter(undefined);
    first.patterns.push('/a');

    expect(normalizeUrlFilter(undefined).patterns).toEqual([]);
  });
});
