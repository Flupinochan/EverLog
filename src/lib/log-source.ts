/**
 * 閲覧 UI から見た保存層の入口。
 *
 * UI は `db.ts` を直接呼ばず、この型を通して読む。キャプチャ層が Chrome API を
 * 引数で受け取るのと同じ理由で、UI 側もデータ取得先を差し替えられる形にしておく
 * （Storybook や UI テストで実物の IndexedDB を用意せずに描画できるようにするため）。
 *
 * 読み取り専用であることに意味がある。UI から保存経路（`addLog()`）へは触れない。
 */

import {
  clearAll,
  getBodies,
  getBody,
  getStats,
  queryLogs,
  type LogFilter,
  type StorageStats,
  type StoredLog,
} from './db';

export interface LogSource {
  /** 条件に合うログのメタデータを新しい順に返す。ボディは含まない */
  queryLogs(filter: LogFilter): Promise<StoredLog[]>;
  /** ログ ID に対応するボディを返す。保存されていなければ null */
  getBody(id: number): Promise<string | null>;
  /** 複数のボディをまとめて返す。保存されていない ID は載らない（HAR 出力用） */
  getBodies(ids: readonly number[]): Promise<Map<number, string>>;
  /** 保存件数とボディサイズの合計を返す（popup の保存状況表示用） */
  getStats(): Promise<StorageStats>;
}

/** 本番で使う実装。IndexedDB をそのまま読む。 */
export const indexedDbLogSource: LogSource = {
  queryLogs,
  getBody,
  getBodies,
  getStats,
};

/**
 * 保存データに対する破壊的な操作。`LogSource` とは別に置く。
 *
 * 読み取りと同じ入口にまとめると「UI からは読むだけ」という区別が消える。全削除を
 * 持つ画面（popup）だけがこちらを受け取り、一覧や詳細（panel）は `LogSource` しか
 * 知らない状態を保つ。なお `addLog()` はここにも載せない。保存経路はサニタイズ層を
 * 通る DevTools ページだけが持つ。
 */
export interface LogAdmin {
  /** 保存済みのログをすべて削除する */
  clearAll(): Promise<void>;
}

/** 本番で使う実装。 */
export const indexedDbLogAdmin: LogAdmin = {
  clearAll,
};
