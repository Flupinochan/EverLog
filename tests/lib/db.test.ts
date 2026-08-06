import { beforeEach, describe, expect, it } from 'vitest';
import { addLog, clearAll, getBody, queryLogs } from '@/lib/db';
import { sanitizeEntry, type SanitizedLogEntry } from '@/lib/sanitize';
import type { NetworkLogEntry } from '@/lib/network-log';

/**
 * 保存対象は必ずサニタイズ層を通す。`addLog` が `SanitizedLogEntry` しか受け取らないため、
 * ここを通さずに組み立てた値は型エラーになる。
 */
function sanitized(overrides: Partial<NetworkLogEntry> = {}): SanitizedLogEntry {
  const entry: NetworkLogEntry = {
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
  return sanitizeEntry(entry);
}

beforeEach(async () => {
  await clearAll();
});

describe('addLog', () => {
  it('採番された ID を返す', async () => {
    const first = await addLog(sanitized());
    const second = await addLog(sanitized());

    expect(typeof first).toBe('number');
    expect(second).not.toBe(first);
  });

  it('メタデータを保存する', async () => {
    await addLog(
      sanitized({
        url: 'https://api.example.com/items?page=2',
        method: 'POST',
        status: 201,
        bodySize: 42,
      }),
    );

    const [log] = await queryLogs();

    expect(log).toMatchObject({
      url: 'https://api.example.com/items?page=2',
      method: 'POST',
      status: 201,
      bodySize: 42,
      tabId: 7,
    });
  });

  it('URL からホストを切り出して保存する', async () => {
    await addLog(sanitized({ url: 'https://api.example.com:8443/x' }));

    const [log] = await queryLogs();

    expect(log?.host).toBe('api.example.com:8443');
  });

  it('ボディを別ストアに保存する', async () => {
    const id = await addLog(sanitized({ body: '{"ok":true}', bodyStatus: 'stored' }));

    expect(await getBody(id)).toBe('{"ok":true}');
  });

  it('ボディが null のエントリではボディを作らない', async () => {
    const id = await addLog(sanitized({ body: null, bodyStatus: 'mime_excluded' }));

    expect(await getBody(id)).toBeNull();
  });

  it('サニタイズ結果を保存する（生の認証情報が DB に入らない）', async () => {
    const id = await addLog(
      sanitized({
        url: 'https://api.example.com/me?access_token=secret-token',
        requestHeaders: { authorization: 'Bearer secret-token' },
        body: '{"refresh_token":"secret-token"}',
      }),
    );

    const [log] = await queryLogs();

    expect(JSON.stringify(log)).not.toContain('secret-token');
    expect(await getBody(id)).not.toContain('secret-token');
  });
});

describe('queryLogs', () => {
  it('ボディを返さない（一覧取得でボディをロードしない）', async () => {
    await addLog(sanitized({ body: '{"large":"payload"}', bodyStatus: 'stored' }));

    const [log] = await queryLogs();

    expect(log).not.toHaveProperty('body');
    expect(JSON.stringify(log)).not.toContain('payload');
  });

  it('新しい順に返す', async () => {
    await addLog(sanitized({ ts: 100, url: 'https://a.test/1' }));
    await addLog(sanitized({ ts: 300, url: 'https://a.test/3' }));
    await addLog(sanitized({ ts: 200, url: 'https://a.test/2' }));

    const logs = await queryLogs();

    expect(logs.map((log) => log.ts)).toEqual([300, 200, 100]);
  });

  it('期間で絞り込む（境界値を含む）', async () => {
    await addLog(sanitized({ ts: 100 }));
    await addLog(sanitized({ ts: 200 }));
    await addLog(sanitized({ ts: 300 }));

    expect((await queryLogs({ from: 200, to: 300 })).map((log) => log.ts)).toEqual([300, 200]);
    expect((await queryLogs({ from: 200 })).map((log) => log.ts)).toEqual([300, 200]);
    expect((await queryLogs({ to: 200 })).map((log) => log.ts)).toEqual([200, 100]);
  });

  it('tabId で絞り込む', async () => {
    await addLog(sanitized({ tabId: 1 }));
    await addLog(sanitized({ tabId: 2 }));

    const logs = await queryLogs({ tabId: 2 });

    expect(logs).toHaveLength(1);
    expect(logs[0]?.tabId).toBe(2);
  });

  it('host で絞り込む', async () => {
    await addLog(sanitized({ url: 'https://a.test/x' }));
    await addLog(sanitized({ url: 'https://b.test/x' }));

    const logs = await queryLogs({ host: 'b.test' });

    expect(logs).toHaveLength(1);
    expect(logs[0]?.host).toBe('b.test');
  });

  it('method と status で絞り込む', async () => {
    await addLog(sanitized({ method: 'GET', status: 200 }));
    await addLog(sanitized({ method: 'POST', status: 500 }));

    expect(await queryLogs({ method: 'POST' })).toHaveLength(1);
    expect(await queryLogs({ status: 500 })).toHaveLength(1);
    expect(await queryLogs({ method: 'GET', status: 500 })).toHaveLength(0);
  });

  it('URL の部分一致で絞り込む（大文字小文字を無視）', async () => {
    await addLog(sanitized({ url: 'https://api.example.com/Users/42' }));
    await addLog(sanitized({ url: 'https://api.example.com/items' }));

    expect(await queryLogs({ urlIncludes: 'users' })).toHaveLength(1);
    expect(await queryLogs({ urlIncludes: 'USERS' })).toHaveLength(1);
    expect(await queryLogs({ urlIncludes: '/api/' })).toHaveLength(0);
  });

  it('複数条件を AND で扱う', async () => {
    await addLog(sanitized({ ts: 100, tabId: 1, url: 'https://a.test/users', status: 200 }));
    await addLog(sanitized({ ts: 200, tabId: 1, url: 'https://a.test/users', status: 500 }));
    await addLog(sanitized({ ts: 300, tabId: 2, url: 'https://a.test/users', status: 500 }));

    const logs = await queryLogs({ from: 150, tabId: 1, urlIncludes: 'users', status: 500 });

    expect(logs).toHaveLength(1);
    expect(logs[0]?.ts).toBe(200);
  });

  it('limit で打ち切り、新しい順の先頭から返す', async () => {
    await addLog(sanitized({ ts: 100 }));
    await addLog(sanitized({ ts: 200 }));
    await addLog(sanitized({ ts: 300 }));

    const logs = await queryLogs({ limit: 2 });

    expect(logs.map((log) => log.ts)).toEqual([300, 200]);
  });

  it('limit は絞り込みの後に効く', async () => {
    await addLog(sanitized({ ts: 100, status: 500 }));
    await addLog(sanitized({ ts: 200, status: 200 }));
    await addLog(sanitized({ ts: 300, status: 200 }));

    const logs = await queryLogs({ status: 500, limit: 2 });

    expect(logs.map((log) => log.ts)).toEqual([100]);
  });

  it('limit が 0 以下なら空配列を返す', async () => {
    await addLog(sanitized());

    expect(await queryLogs({ limit: 0 })).toEqual([]);
    expect(await queryLogs({ limit: -1 })).toEqual([]);
  });

  it('期間が逆転していても例外にせず空配列を返す', async () => {
    await addLog(sanitized({ ts: 200 }));

    expect(await queryLogs({ from: 300, to: 100 })).toEqual([]);
  });

  it('host の比較で大文字小文字を無視する', async () => {
    await addLog(sanitized({ url: 'https://API.Example.com/x' }));

    expect(await queryLogs({ host: 'API.Example.com' })).toHaveLength(1);
    expect(await queryLogs({ host: 'api.example.com' })).toHaveLength(1);
  });

  it('method の比較で大文字小文字を無視する', async () => {
    await addLog(sanitized({ method: 'POST' }));

    expect(await queryLogs({ method: 'post' })).toHaveLength(1);
    expect(await queryLogs({ method: 'POST' })).toHaveLength(1);
  });

  it('該当が無ければ空配列を返す', async () => {
    await addLog(sanitized());

    expect(await queryLogs({ tabId: 999 })).toEqual([]);
    expect(await queryLogs({ from: 9_999_999_999_999 })).toEqual([]);
  });
});

describe('getBody', () => {
  it('存在しない ID では null を返す', async () => {
    expect(await getBody(999_999)).toBeNull();
  });

  it('ログごとに対応するボディを返す', async () => {
    const first = await addLog(sanitized({ body: 'first', bodyStatus: 'stored' }));
    const second = await addLog(sanitized({ body: 'second', bodyStatus: 'stored' }));

    expect(await getBody(first)).toBe('first');
    expect(await getBody(second)).toBe('second');
  });
});

describe('clearAll', () => {
  it('メタデータとボディの両方を削除する', async () => {
    const id = await addLog(sanitized({ body: 'payload', bodyStatus: 'stored' }));

    await clearAll();

    expect(await queryLogs()).toEqual([]);
    expect(await getBody(id)).toBeNull();
  });
});
