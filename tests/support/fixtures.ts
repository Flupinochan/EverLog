/**
 * テスト用のログの組み立て。
 *
 * 変換元は必ずサニタイズ層を通す。保存層が `SanitizedLogEntry` しか受け取らない以上、
 * 画面や出力に流れてくるのもサニタイズ済みの値だけであり、そこを揃えないとテストが
 * 実物からずれる（`tests/lib/db.test.ts` の `sanitized()` と同じ方針）。
 */

import type { StoredLog } from '@/lib/db';
import type { NetworkLogEntry } from '@/lib/network-log';
import { sanitizeEntry } from '@/lib/sanitize';

export function storedLog(overrides: Partial<NetworkLogEntry> = {}, id = 1): StoredLog {
  const entry: NetworkLogEntry = {
    ts: 1_700_000_000_000,
    tabId: 7,
    pageUrl: 'https://example.com/app',
    url: 'https://api.example.com/users',
    method: 'GET',
    status: 200,
    mimeType: 'application/json',
    timeMs: 12.5,
    requestHeaders: { accept: 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    body: null,
    bodySize: 0,
    bodyStatus: 'stored',
    ...overrides,
  };

  const { body: _body, ...rest } = sanitizeEntry(entry);
  let host = '';
  try {
    host = new URL(rest.url).host;
  } catch {
    host = '';
  }
  return { ...rest, id, host };
}
