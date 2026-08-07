/**
 * 保存層。IndexedDB へのログの読み書きを担う。
 *
 * DevTools ページから直接呼ぶ（Service Worker は経由しない）。DevTools ページも
 * 拡張機能のオリジンで動くため同じ DB を開けること、IndexedDB が複数コンテキストからの
 * 同時アクセスをトランザクションで直列化することによる。
 *
 * メタデータとボディを別ストアに分けているのは、一覧取得でボディをロードしないため。
 * `queryLogs()` は `bodies` ストアを一切触らない。
 */

import type { ConsoleLevel } from './console-log';
import type { SanitizedConsoleEntry, SanitizedLogEntry } from './sanitize';

const DB_NAME = 'everlog';
/**
 * スキーマのバージョン。
 *
 * 2 でコンソールログのストアを足した。`onupgradeneeded` は既存ストアを
 * `objectStoreNames.contains()` で避けるため、1 で保存したネットワークログは残る。
 */
const DB_VERSION = 2;
const LOG_STORE = 'logs';
const BODY_STORE = 'bodies';
const CONSOLE_STORE = 'consoleLogs';

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

/**
 * `consoleLogs` ストアに入る形。
 *
 * ネットワークログと違い本文を別ストアへ分けない。1 件が小さく、一覧でも本文の
 * 部分一致で絞り込むため、分けても読まずに済む場面が無いことによる。
 */
export type StoredConsoleLog = SanitizedConsoleEntry & {
  /** 主キー（自動採番） */
  id: number;
};

/** 採番前のコンソールエントリ。 */
type ConsoleRecord = Omit<StoredConsoleLog, 'id'>;

/** 期間の指定。ネットワークとコンソールで共通なので切り出してある。 */
export interface TimeRangeFilter {
  /** 記録時刻の下限（含む） */
  from?: number;
  /** 記録時刻の上限（含む） */
  to?: number;
}

export interface LogFilter extends TimeRangeFilter {
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

/** キャッシュしている接続を捨てる。次回の呼び出しで開き直す。 */
function invalidate(opening: Promise<IDBDatabase>): void {
  if (dbPromise === opening) dbPromise = null;
}

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise !== null) return dbPromise;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
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
      if (!db.objectStoreNames.contains(CONSOLE_STORE)) {
        const consoleLogs = db.createObjectStore(CONSOLE_STORE, {
          keyPath: 'id',
          autoIncrement: true,
        });
        consoleLogs.createIndex('ts', 'ts');
        consoleLogs.createIndex('tabId', 'tabId');
        consoleLogs.createIndex('level', 'level');
      }
    };

    // 他のコンテキスト（別タブの DevTools ページ）が古いバージョンの接続を保持していると
    // ここで待たされる。相手側の onversionchange が接続を閉じれば解消する。
    req.onblocked = () => {
      console.warn('[EverLog] IndexedDB upgrade is blocked by another open connection');
    };

    req.onsuccess = () => {
      const db = req.result;

      // 他のコンテキストがバージョンを上げようとしたら、こちらの接続を閉じて道を空ける。
      // 閉じた接続を掴み続けないよう、キャッシュも捨てて次回に開き直させる。
      db.onversionchange = () => {
        db.close();
        invalidate(opening);
      };
      // ブラウザ側の都合で強制的に閉じられた場合も同様
      db.onclose = () => invalidate(opening);

      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });

  dbPromise = opening;
  // 失敗したハンドルを掴み続けないよう、次回の呼び出しで開き直せるようにする
  opening.catch(() => invalidate(opening));

  return opening;
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
  // ホストは `new URL()` が小文字化し、メソッドは HAR が大文字で返す。呼び出し側に
  // その表記を要求しないよう、どちらも揃えてから比較する。
  if (filter.host !== undefined && log.host.toLowerCase() !== filter.host.toLowerCase()) {
    return false;
  }
  if (filter.method !== undefined && log.method.toUpperCase() !== filter.method.toUpperCase()) {
    return false;
  }
  if (filter.status !== undefined && log.status !== filter.status) return false;
  if (urlNeedle !== null && !log.url.toLowerCase().includes(urlNeedle)) return false;
  return true;
}

/** `from` / `to` から `ts` インデックス用の範囲を作る。 */
function buildTimeRange(filter: TimeRangeFilter): IDBKeyRange | null {
  const { from, to } = filter;
  if (from !== undefined && to !== undefined) return IDBKeyRange.bound(from, to);
  if (from !== undefined) return IDBKeyRange.lowerBound(from);
  if (to !== undefined) return IDBKeyRange.upperBound(to);
  return null;
}

/**
 * `ts` インデックスを新しい順に辿り、条件に合うレコードを集める。
 *
 * 期間だけをインデックスの範囲で絞り、残りは `matches` に委ねる。部分一致のような
 * 条件はインデックスで表現できないため、カーソル内で判定するしかない。
 *
 * ネットワークとコンソールで共通化してある。両者は絞り込み条件こそ違うが、
 * 「`ts` 降順に辿って上限で打ち切る」という骨格は同じであり、片方だけ直して
 * もう片方の並び順や打ち切りがずれるのを防ぐ。
 */
async function queryByTime<T>(
  storeName: string,
  filter: TimeRangeFilter & { limit?: number },
  matches: (record: T) => boolean,
): Promise<T[]> {
  const limit = filter.limit;
  if (limit !== undefined && limit <= 0) return [];
  // 逆転した期間は該当なし。`IDBKeyRange.bound()` は from > to で例外を投げるため先に弾く
  if (filter.from !== undefined && filter.to !== undefined && filter.from > filter.to) return [];

  const db = await openDatabase();
  const tx = db.transaction(storeName, 'readonly');
  const cursorRequest = tx
    .objectStore(storeName)
    .index('ts')
    .openCursor(buildTimeRange(filter), 'prev');

  return new Promise<T[]>((resolve, reject) => {
    const results: T[] = [];

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor === null) {
        resolve(results);
        return;
      }

      const record = cursor.value as T;
      if (matches(record)) {
        results.push(record);
        if (limit !== undefined && results.length >= limit) {
          resolve(results);
          return;
        }
      }
      cursor.continue();
    };

    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error(`Failed to read ${storeName}`));
  });
}

/**
 * 条件に合うログのメタデータを新しい順に返す。**ボディはロードしない。**
 *
 * `ts` インデックスを降順に辿るため並び順は常に保証される。
 */
export function queryLogs(filter: LogFilter = {}): Promise<StoredLog[]> {
  const urlNeedle = filter.urlIncludes?.toLowerCase() ?? null;
  return queryByTime<StoredLog>(LOG_STORE, filter, (log) =>
    matchesFilter(log, filter, urlNeedle),
  );
}

/** コンソールログの絞り込み条件。 */
export interface ConsoleLogFilter extends TimeRangeFilter {
  tabId?: number;
  /** 対象のレベル。未指定・空配列ならレベルで絞らない */
  levels?: readonly ConsoleLevel[];
  /** 本文の部分一致（大文字小文字を無視） */
  textIncludes?: string;
  /** ページ URL の部分一致（大文字小文字を無視） */
  pageUrlIncludes?: string;
  /** 取得件数の上限。未指定なら無制限 */
  limit?: number;
}

function matchesConsoleFilter(
  log: StoredConsoleLog,
  filter: ConsoleLogFilter,
  textNeedle: string | null,
  pageUrlNeedle: string | null,
): boolean {
  if (filter.tabId !== undefined && log.tabId !== filter.tabId) return false;
  // 空配列は「絞らない」。レベルのチェックを全部外した状態で 0 件になると、
  // 絞り込んだつもりのない利用者にはログが消えたように見える
  if (filter.levels !== undefined && filter.levels.length > 0) {
    if (!filter.levels.includes(log.level)) return false;
  }
  if (textNeedle !== null && !log.text.toLowerCase().includes(textNeedle)) return false;
  if (pageUrlNeedle !== null && !log.pageUrl.toLowerCase().includes(pageUrlNeedle)) return false;
  return true;
}

/**
 * 条件に合うコンソールログを新しい順に返す。
 *
 * 本文も一緒に返る。ネットワークログのようにボディを別ストアへ逃がしていないため、
 * 一覧の取得と詳細の取得を分ける必要がない。
 */
export function queryConsoleLogs(filter: ConsoleLogFilter = {}): Promise<StoredConsoleLog[]> {
  const textNeedle = filter.textIncludes?.toLowerCase() ?? null;
  const pageUrlNeedle = filter.pageUrlIncludes?.toLowerCase() ?? null;
  return queryByTime<StoredConsoleLog>(CONSOLE_STORE, filter, (log) =>
    matchesConsoleFilter(log, filter, textNeedle, pageUrlNeedle),
  );
}

/**
 * サニタイズ済みのコンソールエントリを 1 件保存し、採番された ID を返す。
 *
 * 引数の型を `SanitizedConsoleEntry` に限ることで、未サニタイズのエントリを保存する
 * 経路を型で塞いでいる（`addLog()` と同じ）。
 */
export async function addConsoleLog(entry: SanitizedConsoleEntry): Promise<number> {
  const db = await openDatabase();
  const record: ConsoleRecord = { ...entry };

  const tx = db.transaction(CONSOLE_STORE, 'readwrite');
  const id = (await request(tx.objectStore(CONSOLE_STORE).add(record))) as number;
  await txDone(tx);

  return id;
}

/**
 * 複数のコンソールエントリをまとめて保存する。
 *
 * ページ側からはバッチで届くため、件数分トランザクションを開かずに 1 つで済ませる。
 * 1 件でも失敗すればトランザクションごと巻き戻る。バッチは同じフレームの連続した
 * 出力なので、一部だけ残って歯抜けになるより、まとめて失敗したほうが分かりやすい。
 */
export async function addConsoleLogs(entries: readonly SanitizedConsoleEntry[]): Promise<number> {
  if (entries.length === 0) return 0;

  const db = await openDatabase();
  const tx = db.transaction(CONSOLE_STORE, 'readwrite');
  const store = tx.objectStore(CONSOLE_STORE);
  for (const entry of entries) {
    store.add({ ...entry } satisfies ConsoleRecord);
  }
  await txDone(tx);

  return entries.length;
}

/** 保存状況の概算。 */
export interface StorageStats {
  /** 保存済みネットワークログの件数 */
  count: number;
  /**
   * 保存されたボディのサイズ合計（バイト）。
   *
   * **概算である。** メタデータ自体の容量と IndexedDB のオーバーヘッドは含まない。
   * ボディを保存していないエントリ（`too_large` / `mime_excluded` / `fetch_failed`）の
   * `bodySize` も含めない。元のレスポンスは大きくても、こちらは保存していないため。
   */
  bodyBytes: number;
  /** 保存済みコンソールログの件数 */
  consoleCount: number;
  /**
   * コンソールログの本文の合計（バイト）。
   *
   * こちらも概算。`text` と `args` の文字数を UTF-8 のバイト数に換算せず、
   * 文字数をそのまま足す（`console-log.ts` の上限と同じ数え方）。
   */
  consoleBytes: number;
}

/** 1 つのストアをカーソルで走査して集計する。 */
function reduceStore<T, A>(
  db: IDBDatabase,
  storeName: string,
  initial: A,
  step: (accumulator: A, record: T) => A,
): Promise<A> {
  const tx = db.transaction(storeName, 'readonly');
  const cursorRequest = tx.objectStore(storeName).openCursor();

  return new Promise<A>((resolve, reject) => {
    let accumulator = initial;

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor === null) {
        resolve(accumulator);
        return;
      }
      accumulator = step(accumulator, cursor.value as T);
      cursor.continue();
    };

    cursorRequest.onerror = () =>
      reject(cursorRequest.error ?? new Error(`Failed to read ${storeName}`));
  });
}

/**
 * 保存件数とサイズの合計を返す。
 *
 * `bodies` ストアは開かない。サイズは `logs` の `bodySize` から積めるため、
 * 集計のためにボディ本体をロードしない。
 *
 * `navigator.storage.estimate()` は使わない。あれは拡張機能オリジン全体の値であり、
 * EverLog が保存したログの量とは一致しないため。
 */
export async function getStats(): Promise<StorageStats> {
  const db = await openDatabase();

  // 2 つのストアを別々に走査する。1 つのトランザクションにまとめても
  // カーソルは順に回すことになり、片方の失敗でもう片方まで失う面だけが増える
  const network = await reduceStore<StoredLog, { count: number; bodyBytes: number }>(
    db,
    LOG_STORE,
    { count: 0, bodyBytes: 0 },
    (acc, log) => ({
      count: acc.count + 1,
      bodyBytes: acc.bodyBytes + (log.bodyStatus === 'stored' ? log.bodySize : 0),
    }),
  );

  // 変数名を `console` にしない。この関数のなかでグローバルの `console` が
  // 隠れてしまい、後から診断ログを 1 行足したときに黙って壊れる
  const consoleLogs = await reduceStore<StoredConsoleLog, { count: number; bytes: number }>(
    db,
    CONSOLE_STORE,
    { count: 0, bytes: 0 },
    (acc, log) => ({
      count: acc.count + 1,
      bytes: acc.bytes + log.text.length + log.args.reduce((sum, arg) => sum + arg.length, 0),
    }),
  );

  return {
    count: network.count,
    bodyBytes: network.bodyBytes,
    consoleCount: consoleLogs.count,
    consoleBytes: consoleLogs.bytes,
  };
}

/** ログ ID からボディを取り出す。保存されていなければ null。 */
export async function getBody(id: number): Promise<string | null> {
  const db = await openDatabase();
  const tx = db.transaction(BODY_STORE, 'readonly');
  const record = (await request(tx.objectStore(BODY_STORE).get(id))) as BodyRecord | undefined;
  return record?.body ?? null;
}

/**
 * 複数のログ ID に対応するボディをまとめて取り出す。保存されていない ID は載せない。
 *
 * `getBody()` を件数分呼ぶのと結果は同じだが、こちらは 1 つのトランザクションで済ませる。
 * HAR 出力はフィルタ該当の全件が対象で数千件になりうるため、その回数だけトランザクションを
 * 開くのは避ける。1 件ずつ読む詳細表示は引き続き `getBody()` を使う。
 */
export async function getBodies(ids: readonly number[]): Promise<Map<number, string>> {
  const bodies = new Map<number, string>();
  if (ids.length === 0) return bodies;

  const db = await openDatabase();
  const tx = db.transaction(BODY_STORE, 'readonly');
  const store = tx.objectStore(BODY_STORE);

  // すべての取得要求を同じトランザクションに投げてから待つ。1 件ずつ await すると
  // その間にトランザクションが自動で閉じる（要求が途切れた時点で完了扱いになるため）。
  const records = await Promise.all(
    ids.map((id) => request(store.get(id)) as Promise<BodyRecord | undefined>),
  );

  for (const record of records) {
    if (record !== undefined) bodies.set(record.logId, record.body);
  }
  return bodies;
}

/**
 * 保存済みのログをすべて削除する。ネットワークとコンソールの両方が対象。
 *
 * 同じトランザクションで消す。片方だけ消えた状態を作らないため。
 */
export async function clearAll(): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction([LOG_STORE, BODY_STORE, CONSOLE_STORE], 'readwrite');
  tx.objectStore(LOG_STORE).clear();
  tx.objectStore(BODY_STORE).clear();
  tx.objectStore(CONSOLE_STORE).clear();
  await txDone(tx);
}
