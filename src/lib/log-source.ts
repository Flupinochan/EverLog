/**
 * 閲覧 UI から見た保存層の入口。
 *
 * UI は `db.ts` を直接呼ばず、この型を通して読む。キャプチャ層が Chrome API を
 * 引数で受け取るのと同じ理由で、UI 側もデータ取得先を差し替えられる形にしておく
 * （Storybook や UI テストで実物の IndexedDB を用意せずに描画できるようにするため）。
 *
 * 読み取り専用であることに意味がある。UI から保存経路（`addLog()`）へは触れない。
 */

import { getBody, queryLogs, type LogFilter, type StoredLog } from './db';

export interface LogSource {
  /** 条件に合うログのメタデータを新しい順に返す。ボディは含まない */
  queryLogs(filter: LogFilter): Promise<StoredLog[]>;
  /** ログ ID に対応するボディを返す。保存されていなければ null */
  getBody(id: number): Promise<string | null>;
}

/** 本番で使う実装。IndexedDB をそのまま読む。 */
export const indexedDbLogSource: LogSource = {
  queryLogs,
  getBody,
};
