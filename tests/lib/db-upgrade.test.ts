import { describe, expect, it } from 'vitest';
import { closeDatabase, getStats, queryConsoleLogs, queryLogs } from '@/lib/db';

/**
 * スキーマ更新（v1 → v2）の検証。
 *
 * `db.ts` は接続をモジュール内にキャッシュするため、このテストは他のテストと同じ
 * ファイルに置けない。先に v1 の DB を作っておく必要があり、`db.ts` を一度でも
 * 使うとその時点で v2 に上がってしまう。ファイルを分けると `fake-indexeddb` も
 * モジュールの状態も新しいまま始められる。
 */

/** v1 のスキーマを生の IndexedDB で作り、ログを 1 件入れておく。 */
function seedVersion1(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('everlog', 1);

    request.onupgradeneeded = () => {
      const db = request.result;
      const logs = db.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
      logs.createIndex('ts', 'ts');
      logs.createIndex('tabId', 'tabId');
      logs.createIndex('host', 'host');
      db.createObjectStore('bodies', { keyPath: 'logId' });
    };

    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['logs', 'bodies'], 'readwrite');
      tx.objectStore('logs').add({
        ts: 1_700_000_000_000,
        tabId: 7,
        pageUrl: 'https://example.com/app',
        url: 'https://api.example.com/v1',
        host: 'api.example.com',
        method: 'GET',
        status: 200,
        mimeType: 'application/json',
        timeMs: 10,
        requestHeaders: {},
        responseHeaders: {},
        bodySize: 4,
        bodyStatus: 'stored',
        droppedRequestHeaders: [],
        droppedResponseHeaders: [],
      });
      tx.objectStore('bodies').add({ logId: 1, body: 'kept' });

      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error ?? new Error('seed failed'));
    };
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
}

describe('v1 から v2 への更新', () => {
  it('v1 で保存したネットワークログを失わず、コンソールのストアが使えるようになる', async () => {
    await seedVersion1();

    // ここで初めて db.ts が開く。DB_VERSION が 2 なので onupgradeneeded が走る
    const logs = await queryLogs();

    expect(logs).toHaveLength(1);
    expect(logs[0]?.url).toBe('https://api.example.com/v1');

    // 新しいストアは空の状態で使える（例外にならない）
    expect(await queryConsoleLogs()).toEqual([]);

    const stats = await getStats();
    expect(stats.count).toBe(1);
    expect(stats.consoleCount).toBe(0);

    closeDatabase();
  });
});
