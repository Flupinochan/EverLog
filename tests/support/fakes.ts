/**
 * UI テスト用のフェイク。
 *
 * `src/lib/log-source.ts` と `src/lib/settings.ts` が、保存層と `chrome.storage` を
 * インターフェース越しに受け取る形にしてあるため、実物の IndexedDB もブラウザも
 * 立ち上げずに画面を動かせる。その差し替え先をここにまとめる。
 */

import { vi } from 'vitest';
import type {
  ConsoleLogFilter,
  LogFilter,
  StorageStats,
  StoredConsoleLog,
  StoredLog,
} from '@/lib/db';
import type { LogAdmin, LogSource } from '@/lib/log-source';
import type {
  SettingsChangeListener,
  SettingsChangeSource,
  SettingsStorageArea,
} from '@/lib/settings';

export interface FakeLogSourceSeed {
  logs?: StoredLog[];
  consoleLogs?: StoredConsoleLog[];
  /** ログ ID → ボディ。載っていない ID は「保存されていない」扱いになる */
  bodies?: Map<number, string>;
  stats?: StorageStats;
}

/**
 * `LogSource` のフェイク。
 *
 * 絞り込み条件は解釈せず、`limit` による打ち切りだけを再現する。条件の解釈は
 * `@/lib/panel-view` の `buildFilter()` 側のテストが見ており、UI テストで見たいのは
 * 「どんな条件で問い合わせたか」だから（`vi.fn()` の呼び出し履歴で確認する）。
 */
export function createFakeLogSource(seed: FakeLogSourceSeed = {}) {
  const logs = seed.logs ?? [];
  const consoleLogs = seed.consoleLogs ?? [];
  const bodies = seed.bodies ?? new Map<number, string>();
  const stats: StorageStats = seed.stats ?? {
    count: logs.length,
    bodyBytes: 0,
    consoleCount: consoleLogs.length,
    consoleBytes: 0,
  };

  return {
    queryLogs: vi.fn((filter: LogFilter) =>
      Promise.resolve(filter.limit === undefined ? logs : logs.slice(0, filter.limit)),
    ),
    getBody: vi.fn((id: number) => Promise.resolve(bodies.get(id) ?? null)),
    getBodies: vi.fn((ids: readonly number[]) =>
      Promise.resolve(
        new Map(
          ids.flatMap((id): [number, string][] => {
            const body = bodies.get(id);
            return body === undefined ? [] : [[id, body]];
          }),
        ),
      ),
    ),
    queryConsoleLogs: vi.fn((filter: ConsoleLogFilter) =>
      Promise.resolve(filter.limit === undefined ? consoleLogs : consoleLogs.slice(0, filter.limit)),
    ),
    getStats: vi.fn(() => Promise.resolve(stats)),
  } satisfies LogSource;
}

export type FakeLogSource = ReturnType<typeof createFakeLogSource>;

/** `LogAdmin` のフェイク。全削除の呼び出しを記録するだけ。 */
export function createFakeLogAdmin() {
  return {
    clearAll: vi.fn(() => Promise.resolve()),
  } satisfies LogAdmin;
}

/**
 * `chrome.storage.local` のフェイク。設定層は storage を引数で受け取るため、
 * ブラウザを立ち上げずに読み書きを検証できる。
 */
export function createFakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const storage: SettingsStorageArea = {
    get: async (key) => (Object.hasOwn(data, key) ? { [key]: data[key] } : {}),
    set: async (items) => {
      Object.assign(data, items);
    },
  };
  return { storage, data };
}

/** テストから任意の変更通知を流せる `chrome.storage.onChanged` のフェイク。 */
export function createFakeChangeSource() {
  const listeners = new Set<SettingsChangeListener>();
  const source: SettingsChangeSource = {
    onChanged: {
      addListener: (listener) => {
        listeners.add(listener);
      },
      removeListener: (listener) => {
        listeners.delete(listener);
      },
    },
  };
  return {
    source,
    listenerCount: () => listeners.size,
    emit: (changes: Record<string, { newValue?: unknown }>, areaName = 'local') => {
      for (const listener of listeners) listener(changes, areaName);
    },
  };
}

/**
 * 保存と変更通知を繋いだ `chrome.storage` のフェイク。
 *
 * 実物は書いた側にも `onChanged` を配る。`useSettings` はその通知だけで表示を
 * 進める作りなので、繋がっていないと画面が保存結果に追従せず、実物とずれる。
 */
export function createFakeSettingsStorage(initial: Record<string, unknown> = {}) {
  const { storage, data } = createFakeStorage(initial);
  const { source, emit, listenerCount } = createFakeChangeSource();

  const area: SettingsStorageArea = {
    get: (key) => storage.get(key),
    set: async (items) => {
      await storage.set(items);
      emit(Object.fromEntries(Object.entries(items).map(([key, value]) => [key, { newValue: value }])));
    },
  };

  return { area, changes: source, data, emit, listenerCount };
}

/**
 * 解決の時点をテストから決められる Promise。
 *
 * 応答の前後関係（新しい条件の結果を古い応答が上書きしないか）を確かめるために使う。
 */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
