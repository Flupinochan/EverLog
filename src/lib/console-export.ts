/**
 * 保存済みのコンソールログを出力用の JSON へ変換する。
 *
 * `har.ts` と同じく、DOM にも React にも Chrome API にも依存しない純粋関数だけを置く。
 * ファイルとして落とす処理は `src/entrypoints/panel/download.ts` にあり、混ぜない。
 *
 * HAR には載せない。HAR はネットワークの記録形式であり、コンソール出力を置く場所が
 * 仕様上どこにも無い。`_` 始まりの独自フィールドに押し込むこともできるが、そうすると
 * 「HAR として読める」という HAR 出力の利点を、読み手が知らない拡張に賭けることになる。
 * 別ファイルの JSON なら、受け取った側は素直に読める。
 *
 * 変換元の `StoredConsoleLog` は保存時にサニタイズ層を通っている。したがって出力にも
 * 本文中のトークンは伏せ字のまま載る。
 */

import type { StoredConsoleLog } from './db';

/** 出力ファイルの MIME タイプ。 */
export const CONSOLE_EXPORT_MIME_TYPE = 'application/json';

/**
 * 出力形式のバージョン。
 *
 * 読み手が形の違いを判別できるようにするために持つ。HAR の `version: '1.2'` と同じ役割で、
 * 独自形式である以上こちらで名乗るしかない。
 */
export const CONSOLE_EXPORT_VERSION = 1;

/**
 * 出力に添える注記。受け取った人が中身の性質を判断できるようにする。
 * 「一部が伏せ字になっている」「件数が飛んでいることがある」のが欠損ではなく仕様だと
 * 分かる必要がある。
 */
export const CONSOLE_EXPORT_COMMENT =
  'Exported by EverLog. サニタイズ済み: 本文中のトークンは伏せ字になっています。' +
  '短時間に大量の出力があった場合は上限で間引かれ、その旨のログが挟まります。';

/** 出力する 1 件。保存時の主キーは載せない（受け取った側で意味を持たないため）。 */
export interface ConsoleExportEntry {
  /** 記録時刻（ISO 8601） */
  time: string;
  level: StoredConsoleLog['level'];
  text: string;
  args: string[];
  tabId: number;
  pageUrl: string;
  source: string | null;
  stack: string | null;
  argsStatus: StoredConsoleLog['argsStatus'];
}

export interface ConsoleExport {
  everlog: {
    format: 'console-log';
    version: typeof CONSOLE_EXPORT_VERSION;
    creator: { name: string; version: string };
    exportedAt: string;
    comment: string;
  };
  entries: ConsoleExportEntry[];
}

/** 時刻を ISO 文字列にする。壊れている場合はエポックにフォールバックする。 */
function toIsoString(ts: number): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

export function toExportEntry(log: StoredConsoleLog): ConsoleExportEntry {
  return {
    time: toIsoString(log.ts),
    level: log.level,
    text: log.text,
    args: log.args,
    tabId: log.tabId,
    pageUrl: log.pageUrl,
    source: log.source,
    stack: log.stack,
    argsStatus: log.argsStatus,
  };
}

/**
 * ログの配列から出力用のオブジェクトを組み立てる。
 *
 * @param creatorVersion 拡張機能のバージョン。`browser.runtime.getManifest()` を
 *   ここで読まないのは、このモジュールを Chrome API 非依存に保つため（`har.ts` と同じ）
 * @param now 出力時刻。テストのために注入可能にしている
 */
export function buildConsoleExport(
  logs: readonly StoredConsoleLog[],
  creatorVersion: string,
  now: number = Date.now(),
): ConsoleExport {
  return {
    everlog: {
      format: 'console-log',
      version: CONSOLE_EXPORT_VERSION,
      creator: { name: 'EverLog', version: creatorVersion },
      exportedAt: toIsoString(now),
      comment: CONSOLE_EXPORT_COMMENT,
    },
    // 記録時刻の昇順に並べ替える。一覧は新しい順に見せているが、ログは時系列で読む
    // ものであり、そのまま出すと逆順のファイルになる（`buildHar()` と同じ理由）
    entries: [...logs].sort((a, b) => a.ts - b.ts).map(toExportEntry),
  };
}

/**
 * エントリ 1 件あたりの固定分の概算バイト数。
 * 時刻・レベル・URL・JSON の構造分をまとめて見積もる。
 */
const METADATA_BYTES_PER_ENTRY = 256;

/**
 * 出力サイズの概算（バイト）。**確認を出すかどうかの判定にのみ使う。**
 *
 * `estimateExportBytes()` と同じ方針で、厳密さは要らない。文字数をそのまま
 * バイト数と見なしているため、日本語を多く含むログでは実サイズのほうが大きくなる。
 */
export function estimateConsoleExportBytes(logs: readonly StoredConsoleLog[]): number {
  let bytes = logs.length * METADATA_BYTES_PER_ENTRY;
  for (const log of logs) {
    bytes += log.text.length;
    bytes += log.stack?.length ?? 0;
    for (const arg of log.args) bytes += arg.length;
  }
  return bytes;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}

/**
 * 出力ファイル名。`everlog-console-20260806-234500.json`。
 *
 * `harFileName()` と同じくローカル時刻で組む。画面で見ていた時刻とファイル名を
 * 突き合わせられるようにするため。
 */
export function consoleFileName(now: number): string {
  const date = new Date(now);
  const base = Number.isNaN(date.getTime()) ? new Date(0) : date;
  const ymd = `${base.getFullYear()}${pad(base.getMonth() + 1, 2)}${pad(base.getDate(), 2)}`;
  const hms = `${pad(base.getHours(), 2)}${pad(base.getMinutes(), 2)}${pad(base.getSeconds(), 2)}`;
  return `everlog-console-${ymd}-${hms}.json`;
}
