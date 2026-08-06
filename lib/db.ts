/**
 * 保存層。IndexedDB へのログの読み書きを担う。
 *
 * DevTools ページから直接呼ぶ（Service Worker は経由しない）。DevTools ページも
 * 拡張機能のオリジンで動くため同じ DB を開けること、IndexedDB が複数コンテキストからの
 * 同時アクセスをトランザクションで直列化することによる。
 *
 * メタデータとボディを別ストアに分けているのは、一覧取得でボディをロードしないため
 * （仕様書 8.3）。`queryLogs()` は `bodies` ストアを一切触らない。
 */

import type { SanitizedLogEntry } from './sanitize';

const DB_NAME = 'everlog';
const DB_VERSION = 1;
const LOG_STORE = 'logs';
const BODY_STORE = 'bodies';

/** `logs` ストアに入る形。ボディは持たない。 */
export type StoredLog = Omit<SanitizedLogEntry, 'body'> & {
  /** 主キー（自動採番） */
  id: number;
  /** リクエスト URL のホスト。パースできない場合は空文字 */
  host: string;
};

/** 採番前のメタデータ。 */
type LogRecord = Omit<StoredLog, 'id'>;

interface BodyRecord {
  logId: number;
  body: string;
}

export interface LogFilter {
  /** 記録時刻の下限（含む） */
  from?: number;
  /** 記録時刻の上限（含む） */
  to?: number;
  tabId?: number;
  host?: string;
  /** URL の部分一致（大文字小文字を無視） */
  urlIncludes?: string;
  method?: string;
  status?: number;
  /** 取得件数の上限。未指定なら無制限 */
  limit?: number;
}

/** `IDBRequest` を Promise でラップする。 */
function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** トランザクションの完了を待つ。 */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(LOG_STORE)) {
        const logs = db.createObjectStore(LOG_STORE, { keyPath: 'id', autoIncrement: true });
        logs.createIndex('ts', 'ts');
        logs.createIndex('tabId', 'tabId');
        logs.createIndex('host', 'host');
      }
      if (!db.objectStoreNames.contains(BODY_STORE)) {
        db.createObjectStore(BODY_STORE, { keyPath: 'logId' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });

  // 失敗したハンドルを掴み続けないよう、次回の呼び出しで開き直せるようにする
  dbPromise.catch(() => {
    dbPromise = null;
  });

  return dbPromise;
}

/** 接続を閉じる。主にテストで使う。 */
export function closeDatabase(): void {
  const pending = dbPromise;
  dbPromise = null;
  if (pending === null) return;
  void pending.then((db) => db.close()).catch(() => undefined);
}

/** URL からホストを取り出す。パースできなければ空文字。 */
function extractHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

/**
 * サニタイズ済みエントリを 1 件保存し、採番された ID を返す。
 *
 * 引数の型を `SanitizedLogEntry` に限ることで、未サニタイズのエントリを保存する経路を
 * 型で塞いでいる。メタデータとボディは同一トランザクションで書くため、「メタデータだけ
 * 残ってボディが無い」状態は発生しない。
 */
export async function addLog(entry: SanitizedLogEntry): Promise<number> {
  const db = await openDatabase();
  const { body, ...rest } = entry;
  const record: LogRecord = { ...rest, host: extractHost(entry.url) };

  const tx = db.transaction([LOG_STORE, BODY_STORE], 'readwrite');
  const id = (await request(tx.objectStore(LOG_STORE).add(record))) as number;
  if (body !== null) {
    const bodyRecord: BodyRecord = { logId: id, body };
    tx.objectStore(BODY_STORE).add(bodyRecord);
  }
  await txDone(tx);

  return id;
}

function matchesFilter(log: StoredLog, filter: LogFilter, urlNeedle: string | null): boolean {
  if (filter.tabId !== undefined && log.tabId !== filter.tabId) return false;
  if (filter.host !== undefined && log.host !== filter.host) return false;
  if (filter.method !== undefined && log.method !== filter.method) return false;
  if (filter.status !== undefined && log.status !== filter.status) return false;
  if (urlNeedle !== null && !log.url.toLowerCase().includes(urlNeedle)) return false;
  return true;
}

/** `from` / `to` から `ts` インデックス用の範囲を作る。 */
function buildTimeRange(filter: LogFilter): IDBKeyRange | null {
  const { from, to } = filter;
  if (from !== undefined && to !== undefined) return IDBKeyRange.bound(from, to);
  if (from !== undefined) return IDBKeyRange.lowerBound(from);
  if (to !== undefined) return IDBKeyRange.upperBound(to);
  return null;
}

/**
 * 条件に合うログのメタデータを新しい順に返す。**ボディはロードしない。**
 *
 * `ts` インデックスを降順に辿るため並び順は常に保証される。期間はインデックスの範囲で
 * 絞り、残りの条件はカーソル内で判定する（URL 部分一致はインデックスで表現できないため）。
 */
export async function queryLogs(filter: LogFilter = {}): Promise<StoredLog[]> {
  const db = await openDatabase();
  const urlNeedle = filter.urlIncludes?.toLowerCase() ?? null;
  const limit = filter.limit;

  const tx = db.transaction(LOG_STORE, 'readonly');
  const cursorRequest = tx
    .objectStore(LOG_STORE)
    .index('ts')
    .openCursor(buildTimeRange(filter), 'prev');

  return new Promise<StoredLog[]>((resolve, reject) => {
    const results: StoredLog[] = [];

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor === null) {
        resolve(results);
        return;
      }

      const log = cursor.value as StoredLog;
      if (matchesFilter(log, filter, urlNeedle)) {
        results.push(log);
        if (limit !== undefined && results.length >= limit) {
          resolve(results);
          return;
        }
      }
      cursor.continue();
    };

    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error('Failed to read logs'));
  });
}

/** ログ ID からボディを取り出す。保存されていなければ null。 */
export async function getBody(id: number): Promise<string | null> {
  const db = await openDatabase();
  const tx = db.transaction(BODY_STORE, 'readonly');
  const record = (await request(tx.objectStore(BODY_STORE).get(id))) as BodyRecord | undefined;
  return record?.body ?? null;
}

/** 保存済みのログをすべて削除する。 */
export async function clearAll(): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([LOG_STORE, BODY_STORE], 'readwrite');
  tx.objectStore(LOG_STORE).clear();
  tx.objectStore(BODY_STORE).clear();
  await txDone(tx);
}
