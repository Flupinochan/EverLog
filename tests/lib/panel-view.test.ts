import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTER_FORM,
  buildFilter,
  EXPORT_CONFIRM_BYTES,
  EXPORT_MAX_BYTES,
  classifyStatus,
  describeBodyStatus,
  describeExportSize,
  formatBody,
  formatBytes,
  formatDuration,
  formatTimeOfDay,
  formatTimestamp,
  hasSameLogs,
  isJsonLike,
  parseDateTimeLocal,
  parseRangeEnd,
  sortHeaders,
  urlPath,
} from '@/lib/panel-view';

describe('parseDateTimeLocal', () => {
  it('datetime-local の値をローカル時刻として読む', () => {
    // 実行環境のタイムゾーンに依存しないよう、ローカル時刻から作った Date と突き合わせる
    expect(parseDateTimeLocal('2026-08-06T12:30')).toBe(new Date(2026, 7, 6, 12, 30).getTime());
  });

  it('空文字と解釈できない値は undefined', () => {
    expect(parseDateTimeLocal('')).toBeUndefined();
    expect(parseDateTimeLocal('   ')).toBeUndefined();
    expect(parseDateTimeLocal('きのう')).toBeUndefined();
  });
});

describe('buildFilter', () => {
  it('空の入力からは条件を作らない', () => {
    expect(buildFilter(EMPTY_FILTER_FORM, 42)).toEqual({});
  });

  it('入力された条件だけを積む', () => {
    const filter = buildFilter({
      ...EMPTY_FILTER_FORM,
      urlIncludes: '  /api/users  ',
      method: 'POST',
      status: '404',
    });
    expect(filter).toEqual({ urlIncludes: '/api/users', method: 'POST', status: 404 });
  });

  it('ステータスが数字でなければ条件にしない', () => {
    // 誤入力で 0 件になるより、絞り込まずに見せる
    expect(buildFilter({ ...EMPTY_FILTER_FORM, status: '4xx' })).toEqual({});
    expect(buildFilter({ ...EMPTY_FILTER_FORM, status: '-1' })).toEqual({});
  });

  it('期間を epoch ミリ秒に変換する', () => {
    const filter = buildFilter({
      ...EMPTY_FILTER_FORM,
      from: '2026-08-06T00:00',
      to: '2026-08-06T23:59',
    });
    expect(filter.from).toBe(new Date(2026, 7, 6, 0, 0).getTime());
    // 上限は指定した分の終わりまで含める（分単位入力で秒が切り捨てられないように）
    expect(filter.to).toBe(new Date(2026, 7, 6, 23, 59, 59, 999).getTime());
  });

  it('onlyCurrentTab のときだけ tabId を積む', () => {
    expect(buildFilter({ ...EMPTY_FILTER_FORM, onlyCurrentTab: true }, 7)).toEqual({ tabId: 7 });
    expect(buildFilter({ ...EMPTY_FILTER_FORM, onlyCurrentTab: false }, 7)).toEqual({});
  });

  it('tabId が不明なら onlyCurrentTab でも積まない', () => {
    // 全件が消えるより、絞り込まないほうがまし
    expect(buildFilter({ ...EMPTY_FILTER_FORM, onlyCurrentTab: true }, undefined)).toEqual({});
  });
});

describe('parseRangeEnd', () => {
  it('分までの入力はその分の終わりまで含める', () => {
    // 12:31 を上限に選んだとき 12:31:20 の記録が黙って外れないこと
    expect(parseRangeEnd('2026-08-06T12:31')).toBe(new Date(2026, 7, 6, 12, 31, 59, 999).getTime());
  });

  it('秒まで入力された場合はその秒の終わりまで', () => {
    expect(parseRangeEnd('2026-08-06T12:31:20')).toBe(
      new Date(2026, 7, 6, 12, 31, 20, 999).getTime(),
    );
  });

  it('空文字と解釈できない値は undefined', () => {
    expect(parseRangeEnd('')).toBeUndefined();
    expect(parseRangeEnd('あした')).toBeUndefined();
  });
});

describe('hasSameLogs', () => {
  it('ID の並びが同じなら true', () => {
    expect(hasSameLogs([{ id: 3 }, { id: 2 }], [{ id: 3 }, { id: 2 }])).toBe(true);
    expect(hasSameLogs([], [])).toBe(true);
  });

  it('件数や並びが違えば false', () => {
    expect(hasSameLogs([{ id: 3 }], [{ id: 3 }, { id: 2 }])).toBe(false);
    expect(hasSameLogs([{ id: 2 }, { id: 3 }], [{ id: 3 }, { id: 2 }])).toBe(false);
    expect(hasSameLogs([{ id: 4 }], [{ id: 5 }])).toBe(false);
  });
});

describe('formatTimestamp', () => {
  it('ローカル時刻をミリ秒まで固定書式で表示する', () => {
    const ts = new Date(2026, 0, 2, 3, 4, 5, 67).getTime();
    expect(formatTimestamp(ts)).toBe('2026-01-02 03:04:05.067');
  });

  it('不正な値はハイフン', () => {
    expect(formatTimestamp(Number.NaN)).toBe('-');
  });
});

describe('formatTimeOfDay', () => {
  it('日付を落として時刻だけ返す', () => {
    const ts = new Date(2026, 0, 2, 3, 4, 5, 67).getTime();
    expect(formatTimeOfDay(ts)).toBe('03:04:05.067');
  });

  it('不正な値はハイフン', () => {
    expect(formatTimeOfDay(Number.NaN)).toBe('-');
  });
});

describe('formatDuration', () => {
  it('1 秒未満はミリ秒', () => {
    expect(formatDuration(0)).toBe('0 ms');
    expect(formatDuration(123.4)).toBe('123 ms');
  });

  it('1 秒以上は秒', () => {
    expect(formatDuration(1234)).toBe('1.23 s');
  });

  it('負値や非数はハイフン', () => {
    expect(formatDuration(-1)).toBe('-');
    expect(formatDuration(Number.NaN)).toBe('-');
  });
});

describe('formatBytes', () => {
  it('単位を繰り上げる', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1024 * 1024 * 3)).toBe('3.0 MB');
  });

  it('負値はハイフン', () => {
    expect(formatBytes(-1)).toBe('-');
  });
});

describe('describeExportSize', () => {
  it('件数を区切り、サイズを単位付きで並べる', () => {
    expect(describeExportSize(1234, 1024 * 1024 * 52)).toBe('1,234 件 / 約 52.0 MB');
  });

  it('0 件でも文言を作れる', () => {
    expect(describeExportSize(0, 0)).toBe('0 件 / 約 0 B');
  });
});

describe('出力サイズの閾値', () => {
  it('確認を挟む閾値は 50 MB', () => {
    expect(EXPORT_CONFIRM_BYTES).toBe(50 * 1024 * 1024);
  });

  it('出力を諦める上限は 500 MB', () => {
    expect(EXPORT_MAX_BYTES).toBe(500 * 1024 * 1024);
  });

  it('上限は確認の閾値より大きい', () => {
    // 逆転すると確認バーが出る余地が無くなり、常に拒否だけになる
    expect(EXPORT_MAX_BYTES).toBeGreaterThan(EXPORT_CONFIRM_BYTES);
  });
});

describe('isJsonLike', () => {
  it('JSON 系の MIME を判定する', () => {
    expect(isJsonLike('application/json')).toBe(true);
    expect(isJsonLike('APPLICATION/JSON')).toBe(true);
    expect(isJsonLike('application/problem+json')).toBe(true);
    expect(isJsonLike('text/html')).toBe(false);
    expect(isJsonLike('')).toBe(false);
  });
});

describe('formatBody', () => {
  it('JSON を整形する', () => {
    const { text, pretty } = formatBody('{"a":1}', 'application/json');
    expect(pretty).toBe(true);
    expect(text).toBe('{\n  "a": 1\n}');
  });

  it('MIME が JSON でなくても中身が JSON なら整形する', () => {
    // API が text/plain で JSON を返すことがある
    expect(formatBody('[1,2]', 'text/plain').pretty).toBe(true);
  });

  it('壊れた JSON は原文のまま返す', () => {
    const body = '{"a":';
    expect(formatBody(body, 'application/json')).toEqual({ text: body, pretty: false });
  });

  it('JSON でないボディは加工しない', () => {
    const body = '<html>\n  <body>hi</body>\n</html>';
    expect(formatBody(body, 'text/html')).toEqual({ text: body, pretty: false });
  });
});

describe('describeBodyStatus', () => {
  it('stored は理由なし', () => {
    expect(describeBodyStatus('stored')).toBe('');
  });

  it('保存されなかった理由を返す', () => {
    expect(describeBodyStatus('too_large')).not.toBe('');
    expect(describeBodyStatus('mime_excluded')).not.toBe('');
    expect(describeBodyStatus('fetch_failed')).not.toBe('');
  });
});

describe('sortHeaders', () => {
  it('名前順に並べる', () => {
    expect(sortHeaders({ 'content-type': 'application/json', accept: '*/*' })).toEqual([
      ['accept', '*/*'],
      ['content-type', 'application/json'],
    ]);
  });

  it('空のヘッダーは空配列', () => {
    expect(sortHeaders({})).toEqual([]);
  });
});

describe('classifyStatus', () => {
  it('ステータスを分類する', () => {
    expect(classifyStatus(200)).toBe('success');
    expect(classifyStatus(302)).toBe('redirect');
    expect(classifyStatus(404)).toBe('client-error');
    expect(classifyStatus(503)).toBe('server-error');
  });

  it('レスポンスが返らなかった 0 は unknown', () => {
    expect(classifyStatus(0)).toBe('unknown');
  });
});

describe('urlPath', () => {
  it('ホストを省いてパス以降を返す', () => {
    expect(urlPath('https://example.com/api/users?page=2')).toBe('/api/users?page=2');
  });

  it('パースできない URL はそのまま', () => {
    expect(urlPath('not a url')).toBe('not a url');
  });
});
