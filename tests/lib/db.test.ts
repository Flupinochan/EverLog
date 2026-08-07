import { beforeEach, describe, expect, it } from 'vitest';
import {
  addConsoleLog,
  addConsoleLogs,
  addLog,
  clearAll,
  getBodies,
  getBody,
  getStats,
  queryConsoleLogs,
  queryLogs,
} from '@/lib/db';
import {
  sanitizeConsoleEntry,
  sanitizeEntry,
  type SanitizedConsoleEntry,
  type SanitizedLogEntry,
} from '@/lib/sanitize';
import type { ConsoleLogEntry } from '@/lib/console-log';
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

describe('getBodies', () => {
  it('複数のボディを 1 度にまとめて返す', async () => {
    const first = await addLog(sanitized({ body: 'first', bodyStatus: 'stored' }));
    const second = await addLog(sanitized({ body: 'second', bodyStatus: 'stored' }));

    const bodies = await getBodies([first, second]);

    expect(bodies.get(first)).toBe('first');
    expect(bodies.get(second)).toBe('second');
    expect(bodies.size).toBe(2);
  });

  it('保存されていない ID は載せない', async () => {
    const stored = await addLog(sanitized({ body: 'kept', bodyStatus: 'stored' }));
    const withoutBody = await addLog(sanitized({ body: null, bodyStatus: 'mime_excluded' }));

    const bodies = await getBodies([stored, withoutBody, 999_999]);

    expect(bodies.size).toBe(1);
    expect(bodies.has(withoutBody)).toBe(false);
    expect(bodies.has(999_999)).toBe(false);
  });

  it('空配列では空の Map を返す', async () => {
    expect((await getBodies([])).size).toBe(0);
  });

  it('getBody を件数分呼ぶのと同じ結果になる', async () => {
    const ids = [
      await addLog(sanitized({ body: 'a', bodyStatus: 'stored' })),
      await addLog(sanitized({ body: null, bodyStatus: 'fetch_failed' })),
      await addLog(sanitized({ body: 'c', bodyStatus: 'stored' })),
    ];

    const bulk = await getBodies(ids);

    for (const id of ids) {
      expect(bulk.get(id) ?? null).toBe(await getBody(id));
    }
  });
});

describe('getStats', () => {
  it('保存前は 0 件・0 バイト', async () => {
    expect(await getStats()).toEqual({ count: 0, bodyBytes: 0, consoleCount: 0, consoleBytes: 0 });
  });

  it('保存したボディのサイズを合計する', async () => {
    await addLog(sanitized({ body: 'a', bodySize: 100, bodyStatus: 'stored' }));
    await addLog(sanitized({ body: 'b', bodySize: 250, bodyStatus: 'stored' }));

    expect(await getStats()).toEqual({ count: 2, bodyBytes: 350, consoleCount: 0, consoleBytes: 0 });
  });

  it('ボディを保存していないエントリは件数だけ数える', async () => {
    // 元のレスポンスは大きくても保存していないため、容量には数えない
    await addLog(sanitized({ body: null, bodySize: 9_000, bodyStatus: 'too_large' }));
    await addLog(sanitized({ body: null, bodySize: 500, bodyStatus: 'mime_excluded' }));
    await addLog(sanitized({ body: null, bodySize: 300, bodyStatus: 'fetch_failed' }));
    await addLog(sanitized({ body: 'kept', bodySize: 40, bodyStatus: 'stored' }));

    expect(await getStats()).toEqual({ count: 4, bodyBytes: 40, consoleCount: 0, consoleBytes: 0 });
  });

  it('全削除の後は 0 に戻る', async () => {
    await addLog(sanitized({ body: 'payload', bodySize: 7, bodyStatus: 'stored' }));

    await clearAll();

    expect(await getStats()).toEqual({ count: 0, bodyBytes: 0, consoleCount: 0, consoleBytes: 0 });
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

/**
 * コンソール側も保存前にサニタイズ層を通す。`addConsoleLog` が
 * `SanitizedConsoleEntry` しか受け取らないため、通さずに組み立てた値は型エラーになる。
 */
function sanitizedConsole(overrides: Partial<ConsoleLogEntry> = {}): SanitizedConsoleEntry {
  const entry: ConsoleLogEntry = {
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
  return sanitizeConsoleEntry(entry);
}

describe('addConsoleLog', () => {
  it('採番された ID を返す', async () => {
    const first = await addConsoleLog(sanitizedConsole());
    const second = await addConsoleLog(sanitizedConsole());

    expect(typeof first).toBe('number');
    expect(second).not.toBe(first);
  });

  it('保存した内容をそのまま読み戻せる', async () => {
    await addConsoleLog(
      sanitizedConsole({ level: 'error', text: '壊れた', args: ['壊れた', '{a: 1}'] }),
    );

    const [log] = await queryConsoleLogs();

    expect(log?.level).toBe('error');
    expect(log?.text).toBe('壊れた');
    expect(log?.args).toEqual(['壊れた', '{a: 1}']);
  });
});

describe('addConsoleLogs', () => {
  it('まとめて保存して件数を返す', async () => {
    const saved = await addConsoleLogs([
      sanitizedConsole({ text: 'a' }),
      sanitizedConsole({ text: 'b' }),
    ]);

    expect(saved).toBe(2);
    expect(await queryConsoleLogs()).toHaveLength(2);
  });

  it('空配列では何も書かない', async () => {
    expect(await addConsoleLogs([])).toBe(0);
    expect(await queryConsoleLogs()).toHaveLength(0);
  });
});

describe('queryConsoleLogs', () => {
  it('新しい順に返す', async () => {
    await addConsoleLog(sanitizedConsole({ ts: 100, text: '古い' }));
    await addConsoleLog(sanitizedConsole({ ts: 300, text: '新しい' }));
    await addConsoleLog(sanitizedConsole({ ts: 200, text: '中間' }));

    expect((await queryConsoleLogs()).map((log) => log.text)).toEqual([
      '新しい',
      '中間',
      '古い',
    ]);
  });

  it('レベルで絞る', async () => {
    await addConsoleLog(sanitizedConsole({ level: 'log' }));
    await addConsoleLog(sanitizedConsole({ level: 'error' }));
    await addConsoleLog(sanitizedConsole({ level: 'warn' }));

    const results = await queryConsoleLogs({ levels: ['error', 'warn'] });

    expect(results.map((log) => log.level).sort()).toEqual(['error', 'warn']);
  });

  it('レベルの指定が空配列なら絞らない', async () => {
    // チェックを全部外した状態で 0 件になると、ログが消えたように見えるため
    await addConsoleLog(sanitizedConsole({ level: 'log' }));
    await addConsoleLog(sanitizedConsole({ level: 'error' }));

    expect(await queryConsoleLogs({ levels: [] })).toHaveLength(2);
  });

  it('本文の部分一致で絞る（大文字小文字を無視）', async () => {
    await addConsoleLog(sanitizedConsole({ text: 'Fetch failed' }));
    await addConsoleLog(sanitizedConsole({ text: '正常' }));

    expect(await queryConsoleLogs({ textIncludes: 'fetch' })).toHaveLength(1);
  });

  it('ページ URL の部分一致で絞る', async () => {
    await addConsoleLog(sanitizedConsole({ pageUrl: 'https://a.example.com/x' }));
    await addConsoleLog(sanitizedConsole({ pageUrl: 'https://b.example.com/y' }));

    expect(await queryConsoleLogs({ pageUrlIncludes: 'a.example' })).toHaveLength(1);
  });

  it('タブと期間で絞る', async () => {
    await addConsoleLog(sanitizedConsole({ ts: 100, tabId: 1 }));
    await addConsoleLog(sanitizedConsole({ ts: 200, tabId: 2 }));
    await addConsoleLog(sanitizedConsole({ ts: 300, tabId: 1 }));

    expect(await queryConsoleLogs({ tabId: 1 })).toHaveLength(2);
    expect(await queryConsoleLogs({ from: 200 })).toHaveLength(2);
    expect(await queryConsoleLogs({ from: 150, to: 250 })).toHaveLength(1);
  });

  it('逆転した期間は 0 件（例外を投げない）', async () => {
    await addConsoleLog(sanitizedConsole({ ts: 200 }));

    expect(await queryConsoleLogs({ from: 300, to: 100 })).toEqual([]);
  });

  it('上限で打ち切る', async () => {
    for (const ts of [100, 200, 300]) await addConsoleLog(sanitizedConsole({ ts }));

    expect(await queryConsoleLogs({ limit: 2 })).toHaveLength(2);
    expect(await queryConsoleLogs({ limit: 0 })).toEqual([]);
  });
});

describe('getStats（コンソール）', () => {
  it('件数と本文の文字数を数える', async () => {
    await addConsoleLog(sanitizedConsole({ text: 'abc', args: ['de'] }));
    await addConsoleLog(sanitizedConsole({ text: 'f', args: [] }));

    const stats = await getStats();

    expect(stats.consoleCount).toBe(2);
    expect(stats.consoleBytes).toBe(6);
  });

  it('ネットワークログとは別に数える', async () => {
    await addLog(sanitized({ body: 'x', bodySize: 10, bodyStatus: 'stored' }));
    await addConsoleLog(sanitizedConsole({ text: 'y', args: [] }));

    const stats = await getStats();

    expect(stats.count).toBe(1);
    expect(stats.bodyBytes).toBe(10);
    expect(stats.consoleCount).toBe(1);
  });
});

describe('clearAll', () => {
  it('ネットワークとコンソールの両方を消す', async () => {
    await addLog(sanitized());
    await addConsoleLog(sanitizedConsole());

    await clearAll();

    expect(await queryLogs()).toEqual([]);
    expect(await queryConsoleLogs()).toEqual([]);
  });
});
