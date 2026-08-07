import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SANITIZE_OPTIONS,
  REDACTED,
  sanitizeBody,
  sanitizeConsoleEntry,
  sanitizeEntry,
  sanitizeHeaders,
  sanitizeUrl,
} from '@/lib/sanitize';
import type { ConsoleLogEntry } from '@/lib/console-log';
import type { NetworkLogEntry } from '@/lib/network-log';

/** 実在の形に近い JWT（署名部分はダミー）。 */
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

function entry(overrides: Partial<NetworkLogEntry> = {}): NetworkLogEntry {
  return {
    ts: 1_700_000_000_000,
    tabId: 7,
    pageUrl: 'https://example.com/app',
    url: 'https://api.example.com/users',
    method: 'GET',
    status: 200,
    mimeType: 'application/json',
    timeMs: 12.5,
    requestHeaders: { 'content-type': 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    body: null,
    bodySize: 0,
    bodyStatus: 'stored',
    ...overrides,
  };
}

describe('sanitizeHeaders', () => {
  const allowed = DEFAULT_SANITIZE_OPTIONS.allowedRequestHeaders;

  it('authorization / cookie / set-cookie を落とす', () => {
    const result = sanitizeHeaders(
      {
        authorization: `Bearer ${JWT}`,
        cookie: 'session=abc123',
        'set-cookie': 'session=abc123; HttpOnly',
        'content-type': 'application/json',
      },
      allowed,
    );

    expect(result.headers).toEqual({ 'content-type': 'application/json' });
    expect(result.dropped).toEqual(['authorization', 'cookie', 'set-cookie']);
  });

  it('大文字のヘッダー名でも落とす（比較前に小文字化する）', () => {
    const result = sanitizeHeaders({ Authorization: `Bearer ${JWT}`, Cookie: 'a=1' }, allowed);

    expect(result.headers).toEqual({});
    expect(result.dropped).toEqual(['authorization', 'cookie']);
  });

  it('許可リストに無い独自ヘッダーを落とす（拒否リスト方式ではない）', () => {
    const result = sanitizeHeaders(
      { 'x-custom-auth': 'secret-value', 'x-api-key': 'key-value' },
      allowed,
    );

    expect(result.headers).toEqual({});
    expect(result.dropped).toEqual(['x-api-key', 'x-custom-auth']);
  });

  it('落としたヘッダーの値はどこにも残さない', () => {
    const result = sanitizeHeaders({ 'x-custom-auth': 'super-secret' }, allowed);

    expect(JSON.stringify(result)).not.toContain('super-secret');
  });

  it('許可ヘッダーは値ごと残す', () => {
    const headers = { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' };
    expect(sanitizeHeaders(headers, allowed).headers).toEqual(headers);
  });

  it('referer の値を URL としてサニタイズする', () => {
    const result = sanitizeHeaders(
      { referer: 'https://example.com/callback?access_token=secret-token' },
      allowed,
    );

    expect(result.headers['referer']).toBe(`https://example.com/callback?access_token=${REDACTED}`);
  });

  it('location の値を URL としてサニタイズする', () => {
    const result = sanitizeHeaders(
      { location: 'https://example.com/cb#id_token=secret-token' },
      DEFAULT_SANITIZE_OPTIONS.allowedResponseHeaders,
    );

    expect(result.headers['location']).not.toContain('secret-token');
  });

  it('落としたヘッダー名はソートして返す', () => {
    const result = sanitizeHeaders({ cookie: 'a', authorization: 'b', 'x-z': 'c' }, allowed);
    expect(result.dropped).toEqual(['authorization', 'cookie', 'x-z']);
  });
});

describe('sanitizeUrl', () => {
  it('クエリパラメータのトークンを伏せる', () => {
    expect(sanitizeUrl('https://api.example.com/me?access_token=secret&user=alice')).toBe(
      `https://api.example.com/me?access_token=${REDACTED}&user=alice`,
    );
  });

  it('api_key / token も伏せる', () => {
    expect(sanitizeUrl('https://api.example.com/x?api_key=k1&token=t1')).toBe(
      `https://api.example.com/x?api_key=${REDACTED}&token=${REDACTED}`,
    );
  });

  it('キーの表記ゆれ（camelCase / ハイフン）にも対応する', () => {
    expect(sanitizeUrl('https://api.example.com/x?accessToken=secret')).toContain(REDACTED);
    expect(sanitizeUrl('https://api.example.com/x?access-token=secret')).toContain(REDACTED);
    expect(sanitizeUrl('https://api.example.com/x?ACCESS_TOKEN=secret')).toContain(REDACTED);
  });

  it('フラグメント内のトークンを伏せる（OAuth implicit flow）', () => {
    const result = sanitizeUrl(
      'https://example.com/cb#access_token=secret&id_token=secret2&state=xyz',
    );

    expect(result).not.toContain('secret');
    expect(result).toContain('state=xyz');
  });

  it('URL 内の認証情報からパスワードを落とす', () => {
    const result = sanitizeUrl('https://user:hunter2@example.com/path');
    expect(result).not.toContain('hunter2');
  });

  it('キーが未知でも値が JWT なら伏せる', () => {
    const result = sanitizeUrl(`https://api.example.com/x?custom_param=${JWT}`);
    expect(result).toBe(`https://api.example.com/x?custom_param=${REDACTED}`);
  });

  it('トークンを含まない URL は 1 文字も変えない（インデックスキーを壊さない）', () => {
    const url = 'https://api.example.com/users/42?include=profile,settings&sort=-created_at';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('空の値は置換しない', () => {
    const url = 'https://api.example.com/x?token=';
    expect(sanitizeUrl(url)).toBe(url);
  });

  it('パースできない文字列でも例外を投げず、可能な範囲で伏せる', () => {
    expect(() => sanitizeUrl('not a url at all')).not.toThrow();
    expect(sanitizeUrl('/relative/path?access_token=secret')).toBe(
      `/relative/path?access_token=${REDACTED}`,
    );
  });

  it('パスセグメントに埋め込まれた JWT を伏せる（キー名が無くても形で判定する）', () => {
    const result = sanitizeUrl(`https://api.example.com/verify/${JWT}/status`);

    expect(result).toBe(`https://api.example.com/verify/${REDACTED}/status`);
    expect(result).not.toContain('eyJ');
  });

  it('相対 URL のパスに埋め込まれた JWT も伏せる', () => {
    expect(sanitizeUrl(`/verify/${JWT}`)).toBe(`/verify/${REDACTED}`);
  });

  it('同名キーが重複していても両方伏せる（2 つ目を消さない）', () => {
    const result = sanitizeUrl('https://api.example.com/x?token=aaa&keep=1&token=bbb');

    expect(result).toBe(`https://api.example.com/x?token=${REDACTED}&keep=1&token=${REDACTED}`);
  });

  it('伏せ字化しないキーの重複は並び順ごと保つ', () => {
    const result = sanitizeUrl('https://api.example.com/x?tag=a&tag=b&token=z');

    expect(result).toBe(`https://api.example.com/x?tag=a&tag=b&token=${REDACTED}`);
  });

  it('空文字はそのまま返す', () => {
    expect(sanitizeUrl('')).toBe('');
  });
});

describe('sanitizeBody', () => {
  it('JSON の access_token を伏せ、置換後も JSON として読める', () => {
    const body = JSON.stringify({ access_token: JWT, token_type: 'Bearer', expires_in: 3600 });

    const result = sanitizeBody(body);

    expect(result).not.toContain('eyJ');
    const parsed = JSON.parse(result as string) as Record<string, unknown>;
    expect(parsed['access_token']).toBe(REDACTED);
    expect(parsed['expires_in']).toBe(3600);
  });

  it('id_token / refresh_token も伏せる', () => {
    const body = JSON.stringify({ id_token: 'i1', refresh_token: 'r1', user: 'alice' });

    const parsed = JSON.parse(sanitizeBody(body) as string) as Record<string, unknown>;

    expect(parsed['id_token']).toBe(REDACTED);
    expect(parsed['refresh_token']).toBe(REDACTED);
    expect(parsed['user']).toBe('alice');
  });

  it('ネストした JSON 内のトークンも伏せる', () => {
    const body = JSON.stringify({ data: { credentials: { password: 'hunter2' } } });

    const result = sanitizeBody(body);

    expect(result).not.toContain('hunter2');
    expect(() => JSON.parse(result as string)).not.toThrow();
  });

  it('フォームエンコードされたボディのトークンを伏せる', () => {
    const result = sanitizeBody('grant_type=refresh_token&refresh_token=r1&client_secret=s1');

    expect(result).toContain('grant_type=refresh_token');
    expect(result).toContain(`refresh_token=${REDACTED}`);
    expect(result).toContain(`client_secret=${REDACTED}`);
    expect(result).not.toContain('=r1');
    expect(result).not.toContain('s1');
  });

  it('Bearer / Basic はスキームを残して値だけ伏せる', () => {
    const result = sanitizeBody(`{"note":"send Authorization: Bearer ${JWT} to the API"}`);

    expect(result).toContain('Bearer [REDACTED]');
    expect(result).not.toContain('eyJ');

    expect(sanitizeBody('Basic dXNlcjpwYXNzd29yZA==')).toBe(`Basic ${REDACTED}`);
  });

  it('スキームとトークンの区切りがタブや改行でも値を残さない', () => {
    // 区切りを ' ' 決め打ちで探すと、トークン末尾 1 文字だけが落ちた
    // ほぼ生の値が保存される
    for (const separator of ['\t', '\n', '  ', ' \t ']) {
      const result = sanitizeBody(`Bearer${separator}abcDEF123456789secret`);

      expect(result).toBe(`Bearer ${REDACTED}`);
      expect(result).not.toContain('secre');
    }
  });

  it('裸の JWT を伏せる', () => {
    const result = sanitizeBody(`the token is ${JWT} ok`);

    expect(result).toBe(`the token is ${REDACTED} ok`);
  });

  it('JSON 文字列に埋め込まれた URL のトークンを伏せても JSON を壊さない', () => {
    const body = JSON.stringify({
      callback: 'https://example.com/cb?code=auth-code&next=/home',
      ok: true,
    });

    const result = sanitizeBody(body);

    expect(result).not.toContain('auth-code');
    const parsed = JSON.parse(result as string) as Record<string, unknown>;
    expect(parsed['callback']).toBe(`https://example.com/cb?code=${REDACTED}&next=/home`);
    expect(parsed['ok']).toBe(true);
  });

  it('トークンを含まないボディは変化しない', () => {
    const body = JSON.stringify({ users: [{ id: 1, name: 'alice' }], total: 1 });
    expect(sanitizeBody(body)).toBe(body);
  });

  it('null と空文字はそのまま返す', () => {
    expect(sanitizeBody(null)).toBeNull();
    expect(sanitizeBody('')).toBe('');
  });
});

describe('sanitizeEntry', () => {
  it('url / pageUrl / ヘッダー / body をまとめて処理する', () => {
    const result = sanitizeEntry(
      entry({
        url: 'https://api.example.com/me?access_token=secret',
        pageUrl: 'https://example.com/cb#id_token=secret',
        requestHeaders: { authorization: `Bearer ${JWT}`, 'content-type': 'application/json' },
        responseHeaders: { 'set-cookie': 'session=abc', 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: 'r1' }),
      }),
    );

    expect(result.url).toBe(`https://api.example.com/me?access_token=${REDACTED}`);
    expect(result.pageUrl).not.toContain('secret');
    expect(result.requestHeaders).toEqual({ 'content-type': 'application/json' });
    expect(result.droppedRequestHeaders).toEqual(['authorization']);
    expect(result.responseHeaders).toEqual({ 'content-type': 'application/json' });
    expect(result.droppedResponseHeaders).toEqual(['set-cookie']);
    expect(result.body).not.toContain('r1');
  });

  it('メタデータは素通しする', () => {
    const original = entry({ bodySize: 123, bodyStatus: 'too_large' });

    const result = sanitizeEntry(original);

    expect(result).toMatchObject({
      ts: original.ts,
      tabId: original.tabId,
      method: original.method,
      status: original.status,
      mimeType: original.mimeType,
      timeMs: original.timeMs,
      bodySize: 123,
      bodyStatus: 'too_large',
    });
  });

  it('元のエントリを破壊しない', () => {
    const original = entry({ requestHeaders: { authorization: 'Bearer x' } });

    const result = sanitizeEntry(original);

    expect(original.requestHeaders).toEqual({ authorization: 'Bearer x' });
    expect(result).not.toBe(original);
  });

  // CLAUDE.md:「レスポンスボディを扱うコードを変更したときは、Authorization ヘッダーと
  // JWT が保存されないことを必ず確認する」を自動テスト化したもの。
  it('現実的な OAuth エントリを通しても、認証情報が一切残らない', () => {
    const result = sanitizeEntry(
      entry({
        url: `https://auth.example.com/token?client_secret=cs-super-secret&code=auth-code-1`,
        pageUrl: `https://example.com/callback#access_token=${JWT}&token_type=bearer`,
        requestHeaders: {
          authorization: `Bearer ${JWT}`,
          cookie: 'session=sess-super-secret',
          'x-api-key': 'key-super-secret',
          'content-type': 'application/x-www-form-urlencoded',
        },
        responseHeaders: {
          'set-cookie': 'refresh=refresh-super-secret; HttpOnly',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          access_token: JWT,
          refresh_token: 'refresh-super-secret',
          id_token: JWT,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      }),
    );

    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('eyJ');
    expect(serialized).not.toContain('Bearer eyJ');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('auth-code-1');

    // 調査に必要なメタデータは残っていること
    expect(result.status).toBe(200);
    expect(result.responseHeaders['content-type']).toBe('application/json');
    expect(result.droppedRequestHeaders).toContain('authorization');
    expect(result.droppedRequestHeaders).toContain('x-api-key');
    expect(JSON.parse(result.body as string)['expires_in']).toBe(3600);
  });
});

function consoleEntry(overrides: Partial<ConsoleLogEntry> = {}): ConsoleLogEntry {
  return {
    ts: 1_700_000_000_000,
    tabId: 7,
    pageUrl: 'https://example.com/app',
    level: 'log',
    text: 'hello',
    args: ['hello'],
    source: 'https://example.com/a.js:1:2',
    stack: null,
    argsStatus: 'stored',
    ...overrides,
  };
}

describe('sanitizeConsoleEntry', () => {
  it('本文のトークンを伏せる', () => {
    const result = sanitizeConsoleEntry(
      consoleEntry({
        text: `token=${JWT} を送った`,
        args: [`{"access_token": "${JWT}"}`],
      }),
    );

    expect(result.text).not.toContain('eyJ');
    expect(result.args[0]).not.toContain('eyJ');
    expect(result.args[0]).toContain(REDACTED);
  });

  it('プレビュー形式のオブジェクト内のトークンを伏せる', () => {
    // console の引数プレビューはキーが引用符で囲まれないため、JSON 用のパターンでは当たらない
    const result = sanitizeConsoleEntry(
      consoleEntry({ args: ['{access_token: "xyz-secret", user: "alice"}'] }),
    );

    expect(result.args[0]).toBe(`{access_token: "${REDACTED}", user: "alice"}`);
  });

  it('引数のうちトークンを含まないものはそのまま残す', () => {
    const result = sanitizeConsoleEntry(consoleEntry({ args: ['{a: 1}', 'password=hunter2'] }));

    expect(result.args[0]).toBe('{a: 1}');
    expect(result.args[1]).toBe(`password=${REDACTED}`);
  });

  it('pageUrl のフラグメントに載ったトークンを伏せる', () => {
    // OAuth の implicit flow 直後は console の記録でも同じ URL が載る
    const result = sanitizeConsoleEntry(
      consoleEntry({ pageUrl: 'https://example.com/cb#access_token=abc123&state=x' }),
    );

    expect(result.pageUrl).not.toContain('abc123');
    expect(result.pageUrl).toContain('state=x');
  });

  it('スタックに載った URL のトークンを伏せる', () => {
    const result = sanitizeConsoleEntry(
      consoleEntry({ stack: 'Error: x\n    at https://example.com/a.js?api_key=secret-1:1:2' }),
    );

    expect(result.stack).not.toContain('secret-1');
    expect(result.stack).toContain(REDACTED);
  });

  it('発生元はトークンを伏せつつ行・列番号を残す', () => {
    // 伏せ字の対象になる「値」に末尾の :1:2 まで含まれるため、切り離して処理している
    const result = sanitizeConsoleEntry(
      consoleEntry({ source: 'https://example.com/a.js?api_key=secret-1:1:2' }),
    );

    expect(result.source).toBe(`https://example.com/a.js?api_key=${REDACTED}:1:2`);
  });

  it('クエリを持たない発生元はそのまま残す', () => {
    const result = sanitizeConsoleEntry(consoleEntry({ source: 'https://example.com/a.js:12:34' }));

    expect(result.source).toBe('https://example.com/a.js:12:34');
  });

  it('引数が無いエントリでも形を保つ', () => {
    const result = sanitizeConsoleEntry(consoleEntry({ text: '', args: [], source: null }));

    expect(result.text).toBe('');
    expect(result.args).toEqual([]);
    expect(result.source).toBeNull();
    expect(result.stack).toBeNull();
  });

  it('調査に必要なメタデータは残す', () => {
    const result = sanitizeConsoleEntry(consoleEntry({ level: 'error', argsStatus: 'truncated' }));

    expect(result.level).toBe('error');
    expect(result.argsStatus).toBe('truncated');
    expect(result.ts).toBe(1_700_000_000_000);
    expect(result.tabId).toBe(7);
    expect(result.sanitized).toBe(true);
  });
});

describe('sanitizeBody（引用符の無いキー）', () => {
  it('JavaScript のオブジェクトリテラル形式でも伏せる', () => {
    expect(sanitizeBody('const config = { apiKey: "k-1", region: "jp" };')).toBe(
      `const config = { apiKey: "${REDACTED}", region: "jp" };`,
    );
  });

  it('引用符の無い値は対象にしない（JSON 側の扱いと揃える）', () => {
    // `"code": 404` を残すのに `code: 404` だけ伏せると一貫しない。`code` や `auth` は
    // 既定の伏せ字キーにあるため、数値まで対象にすると HTTP ステータスやエラーコードが
    // 読めなくなる
    const body = '{ error: { code: 404, message: "not found" } }';
    expect(sanitizeBody(body)).toBe(body);
  });

  it('引用符付きの文字列値なら伏せる', () => {
    expect(sanitizeBody('{ code: "auth-code-1", count: 3 }')).toBe(
      `{ code: "${REDACTED}", count: 3 }`,
    );
  });

  it('JSON でも引用符なしでも同じキーは同じ結果になる', () => {
    // 形式が違うだけで守られ方が変わらないこと
    expect(sanitizeBody('{"password": "hunter2"}')).toContain(REDACTED);
    expect(sanitizeBody('{password: "hunter2"}')).toContain(REDACTED);
    expect(sanitizeBody('{"password": 42}')).toBe('{"password": 42}');
    expect(sanitizeBody('{password: 42}')).toBe('{password: 42}');
  });

  it('URL のスキームやスタックの行番号を巻き込まない', () => {
    const stack = 'at foo (https://example.com/a.js:12:34)';
    expect(sanitizeBody(stack)).toBe(stack);
  });

  it('伏せ字の対象でないキーはそのまま残す', () => {
    const body = '{userId: 42, name: "alice"}';
    expect(sanitizeBody(body)).toBe(body);
  });

  it('引用符付きキーの JSON を二重に壊さない', () => {
    const body = JSON.stringify({ password: 'hunter2', user: 'alice' });

    const parsed = JSON.parse(sanitizeBody(body) as string) as Record<string, unknown>;

    expect(parsed['password']).toBe(REDACTED);
    expect(parsed['user']).toBe('alice');
  });
});
