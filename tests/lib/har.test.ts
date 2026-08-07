import { describe, expect, it } from 'vitest';
import type { StoredLog } from '@/lib/db';
import {
  HAR_COMMENT,
  buildHar,
  estimateExportBytes,
  harFileName,
  queryStringFromUrl,
  recordToHeaders,
  toHarEntry,
} from '@/lib/har';
import type { NetworkLogEntry } from '@/lib/network-log';
import { sanitizeEntry } from '@/lib/sanitize';

/**
 * 変換元は必ずサニタイズ層を通す。保存層が `SanitizedLogEntry` しか受け取らない以上、
 * 出力に流れてくるのもサニタイズ済みの値だけであり、そこを揃えないとテストが実物から
 * ずれる（`tests/lib/db.test.ts` の `sanitized()` と同じ方針）。
 */
function storedLog(overrides: Partial<NetworkLogEntry> = {}, id = 1): StoredLog {
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

describe('recordToHeaders', () => {
  it('レコードを HAR のヘッダー配列にする', () => {
    expect(recordToHeaders({ accept: 'application/json', host: 'api.example.com' })).toEqual([
      { name: 'accept', value: 'application/json' },
      { name: 'host', value: 'api.example.com' },
    ]);
  });

  it('連結された同名ヘッダーを分割し直さない', () => {
    // 値そのものに `, ` を含むヘッダーを誤って割らないため、連結のまま 1 件で出す
    expect(recordToHeaders({ accept: 'text/html, application/xhtml+xml' })).toEqual([
      { name: 'accept', value: 'text/html, application/xhtml+xml' },
    ]);
  });

  it('空のレコードは空配列になる', () => {
    expect(recordToHeaders({})).toEqual([]);
  });
});

describe('queryStringFromUrl', () => {
  it('クエリを名前と値の配列にする', () => {
    expect(queryStringFromUrl('https://api.example.com/users?page=2&sort=name')).toEqual([
      { name: 'page', value: '2' },
      { name: 'sort', value: 'name' },
    ]);
  });

  it('クエリが無ければ空配列', () => {
    expect(queryStringFromUrl('https://api.example.com/users')).toEqual([]);
  });

  it('パースできない URL でも例外を投げず空配列を返す', () => {
    expect(queryStringFromUrl('not a url')).toEqual([]);
  });
});

describe('toHarEntry', () => {
  it('メタデータを HAR のフィールドに移す', () => {
    const entry = toHarEntry(
      storedLog({ url: 'https://api.example.com/users', method: 'POST', status: 201 }),
      null,
    );

    expect(entry.request.method).toBe('POST');
    expect(entry.request.url).toBe('https://api.example.com/users');
    expect(entry.response.status).toBe(201);
    expect(entry.startedDateTime).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it('ボディがあれば content.text に載せる', () => {
    const entry = toHarEntry(storedLog(), '{"ok":true}');

    expect(entry.response.content.text).toBe('{"ok":true}');
    expect(entry.response.content.mimeType).toBe('application/json');
  });

  it('content.size を出力する text の実バイト長にする', () => {
    // `bodySize` はサニタイズ前の長さ。伏せ字が入ると `text` と食い違うため測り直す
    const entry = toHarEntry(storedLog({ bodySize: 9_999 }), '{"ok":true}');

    expect(entry.response.content.size).toBe(11);
  });

  it('マルチバイトの text をバイト長で数える', () => {
    const entry = toHarEntry(storedLog(), 'あい');

    expect(entry.response.content.size).toBe(6);
  });

  it('ボディが無ければ content.text を出さず、記録時のサイズを残す', () => {
    const entry = toHarEntry(storedLog({ bodyStatus: 'mime_excluded', bodySize: 4_096 }), null);

    expect(entry.response.content).not.toHaveProperty('text');
    expect(entry.response.content.size).toBe(4_096);
  });

  it('base64 と誤解されないよう encoding を付けない', () => {
    // 保存しているのはデコード済みの UTF-8 文字列。encoding があると二重デコードされる
    const entry = toHarEntry(storedLog(), 'こんにちは');

    expect(entry.response.content).not.toHaveProperty('encoding');
  });

  it('ボディが保存されなかった理由を _everlog に残す', () => {
    const entry = toHarEntry(storedLog({ bodyStatus: 'too_large', bodySize: 9_999_999 }), null);

    expect(entry._everlog.bodyStatus).toBe('too_large');
  });

  it('記録元のタブとページ URL を _everlog に残す', () => {
    const entry = toHarEntry(storedLog({ tabId: 42, pageUrl: 'https://example.com/app' }), null);

    expect(entry._everlog.tabId).toBe(42);
    expect(entry._everlog.pageUrl).toBe('https://example.com/app');
  });

  it('破棄したヘッダー名を _everlog に残す', () => {
    const entry = toHarEntry(
      storedLog({ requestHeaders: { authorization: 'Bearer abc', accept: 'application/json' } }),
      null,
    );

    expect(entry._everlog.droppedRequestHeaders).toContain('authorization');
    // 破棄したヘッダーは HAR 側の headers には出ない
    expect(entry.request.headers.map((header) => header.name)).not.toContain('authorization');
  });

  it('timings の合計が time と一致する', () => {
    const entry = toHarEntry(storedLog({ timeMs: 250 }), null);
    const { send, wait, receive } = entry.timings;

    expect(send + wait + receive).toBe(entry.time);
    expect(entry.time).toBe(250);
  });

  it('所要時間が負なら time と wait を 0 にする', () => {
    const entry = toHarEntry(storedLog({ timeMs: -1 }), null);

    expect(entry.time).toBe(0);
    expect(entry.timings.wait).toBe(0);
  });

  it('所要時間が NaN なら time と wait を 0 にする', () => {
    const entry = toHarEntry(storedLog({ timeMs: Number.NaN }), null);

    expect(entry.time).toBe(0);
    expect(entry.timings.wait).toBe(0);
  });

  it('サニタイズ済みの URL から queryString を作る', () => {
    const entry = toHarEntry(storedLog({ url: 'https://api.example.com/x?token=abc&page=2' }), null);

    // 伏せ字は伏せ字のまま queryString に出る（出力から生トークンが復活しない）
    expect(entry.request.queryString).toEqual([
      { name: 'token', value: '[REDACTED]' },
      { name: 'page', value: '2' },
    ]);
  });

  it('パースできない URL でも例外を投げず queryString を空にする', () => {
    const entry = toHarEntry(storedLog({ url: 'chrome-extension' }), null);

    expect(entry.request.queryString).toEqual([]);
    expect(entry.request.url).toBe('chrome-extension');
  });

  it('redirectURL を location ヘッダーから入れる', () => {
    const entry = toHarEntry(
      storedLog({ status: 302, responseHeaders: { location: 'https://example.com/next' } }),
      null,
    );

    expect(entry.response.redirectURL).toBe('https://example.com/next');
  });

  it('location が無ければ redirectURL は空文字', () => {
    expect(toHarEntry(storedLog(), null).response.redirectURL).toBe('');
  });

  it('Cookie は常に空配列', () => {
    // サニタイズ層が cookie / set-cookie を許可リストから外しているため復元できない
    const entry = toHarEntry(
      storedLog({
        requestHeaders: { cookie: 'session=abc' },
        responseHeaders: { 'set-cookie': 'session=abc' },
      }),
      null,
    );

    expect(entry.request.cookies).toEqual([]);
    expect(entry.response.cookies).toEqual([]);
  });

  it('保存していないサイズには -1 を入れる', () => {
    const entry = toHarEntry(storedLog(), null);

    expect(entry.request.headersSize).toBe(-1);
    expect(entry.request.bodySize).toBe(-1);
    expect(entry.response.headersSize).toBe(-1);
    expect(entry.response.bodySize).toBe(-1);
  });

  it('記録時刻が壊れていてもエポックにフォールバックする', () => {
    const entry = toHarEntry(storedLog({ ts: Number.NaN }), null);

    expect(entry.startedDateTime).toBe(new Date(0).toISOString());
  });
});

describe('buildHar', () => {
  it('HAR 1.2 の骨格を作る', () => {
    const har = buildHar([storedLog()], new Map(), '1.2.3');

    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual({ name: 'EverLog', version: '1.2.3' });
    expect(har.log.pages).toEqual([]);
    expect(har.log.comment).toBe(HAR_COMMENT);
  });

  it('ログ ID に対応するボディを割り当てる', () => {
    const logs = [storedLog({}, 1), storedLog({}, 2)];
    const har = buildHar(logs, new Map([[2, '{"id":2}']]), '0.0.0');

    expect(har.log.entries[0]?.response.content).not.toHaveProperty('text');
    expect(har.log.entries[1]?.response.content.text).toBe('{"id":2}');
  });

  it('0 件でも妥当な HAR になる', () => {
    const har = buildHar([], new Map(), '0.0.0');

    expect(har.log.entries).toEqual([]);
    expect(har.log.version).toBe('1.2');
  });

  it('記録時刻の昇順に並べ替える', () => {
    // 一覧は新しい順に渡ってくる。HAR は時系列で読むものなので出力時に直す
    const logs = [
      storedLog({ url: 'https://new.example.com/', ts: 3_000 }, 2),
      storedLog({ url: 'https://old.example.com/', ts: 1_000 }, 1),
    ];
    const har = buildHar(logs, new Map(), '0.0.0');

    expect(har.log.entries.map((entry) => entry.request.url)).toEqual([
      'https://old.example.com/',
      'https://new.example.com/',
    ]);
  });

  it('並べ替えても ID とボディの対応が崩れない', () => {
    const logs = [storedLog({ ts: 3_000 }, 2), storedLog({ ts: 1_000 }, 1)];
    const har = buildHar(logs, new Map([[1, 'old body']]), '0.0.0');

    expect(har.log.entries[0]?.response.content.text).toBe('old body');
    expect(har.log.entries[1]?.response.content).not.toHaveProperty('text');
  });

  it('引数の配列を書き換えない', () => {
    const logs = [storedLog({ ts: 3_000 }, 2), storedLog({ ts: 1_000 }, 1)];
    buildHar(logs, new Map(), '0.0.0');

    expect(logs.map((log) => log.id)).toEqual([2, 1]);
  });

  it('JSON にできる（循環参照や undefined を含まない）', () => {
    const har = buildHar([storedLog({ bodySize: 5 })], new Map([[1, 'hello']]), '0.0.0');
    const round = JSON.parse(JSON.stringify(har)) as typeof har;

    expect(round.log.entries[0]?.response.content.text).toBe('hello');
  });
});

describe('estimateExportBytes', () => {
  it('保存済みボディのサイズを積む', () => {
    const bytes = estimateExportBytes([storedLog({ bodySize: 1_000_000 })]);

    expect(bytes).toBeGreaterThan(1_000_000);
  });

  it('保存していないボディのサイズは数えない', () => {
    // 元のレスポンスが大きくても、出力されるのはメタデータだけ
    const excluded = estimateExportBytes([
      storedLog({ bodyStatus: 'too_large', bodySize: 100_000_000 }),
    ]);
    const empty = estimateExportBytes([storedLog({ bodyStatus: 'mime_excluded', bodySize: 0 })]);

    expect(excluded).toBe(empty);
  });

  it('0 件なら 0', () => {
    expect(estimateExportBytes([])).toBe(0);
  });

  it('件数に応じて増える', () => {
    const one = estimateExportBytes([storedLog({ bodySize: 0 })]);
    const two = estimateExportBytes([storedLog({ bodySize: 0 }), storedLog({ bodySize: 0 })]);

    expect(two).toBe(one * 2);
  });
});

describe('harFileName', () => {
  it('ローカル時刻で everlog-YYYYMMDD-HHmmss.har を作る', () => {
    // ローカル時刻で組むため、タイムゾーンに依存しないよう組み立てた時刻で比較する
    const now = new Date(2026, 7, 6, 23, 45, 0).getTime();

    expect(harFileName(now)).toBe('everlog-20260806-234500.har');
  });

  it('1 桁の月日・時分秒をゼロ埋めする', () => {
    const now = new Date(2026, 0, 2, 3, 4, 5).getTime();

    expect(harFileName(now)).toBe('everlog-20260102-030405.har');
  });

  it('時刻が壊れていても名前を作れる', () => {
    expect(harFileName(Number.NaN)).toMatch(/^everlog-\d{8}-\d{6}\.har$/);
  });
});
