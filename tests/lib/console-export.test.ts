import { describe, expect, it } from 'vitest';
import {
  CONSOLE_EXPORT_VERSION,
  buildConsoleExport,
  consoleFileName,
  estimateConsoleExportBytes,
  toExportEntry,
} from '@/lib/console-export';
import type { StoredConsoleLog } from '@/lib/db';

function log(overrides: Partial<StoredConsoleLog> = {}): StoredConsoleLog {
  return {
    id: 1,
    ts: 1_700_000_000_000,
    tabId: 7,
    pageUrl: 'https://example.com/app',
    level: 'log',
    text: 'hello',
    args: ['hello'],
    source: 'https://example.com/a.js:1:2',
    stack: null,
    argsStatus: 'stored',
    sanitized: true,
    ...overrides,
  };
}

describe('toExportEntry', () => {
  it('保存時刻を ISO 文字列にする', () => {
    expect(toExportEntry(log({ ts: 0 })).time).toBe('1970-01-01T00:00:00.000Z');
  });

  it('壊れた時刻はエポックに寄せる（1 件で出力全体を失わない）', () => {
    expect(toExportEntry(log({ ts: Number.NaN })).time).toBe('1970-01-01T00:00:00.000Z');
  });

  it('保存層の主キーは載せない', () => {
    // 受け取った側では意味を持たない値であり、別の出力と突き合わせると誤解を招く
    expect(toExportEntry(log())).not.toHaveProperty('id');
  });

  it('調査に要る値は落とさない', () => {
    const entry = toExportEntry(
      log({ level: 'error', stack: 'Error: x', source: 'a.js:1:1', argsStatus: 'truncated' }),
    );

    expect(entry.level).toBe('error');
    expect(entry.stack).toBe('Error: x');
    expect(entry.source).toBe('a.js:1:1');
    expect(entry.argsStatus).toBe('truncated');
    expect(entry.tabId).toBe(7);
  });
});

describe('buildConsoleExport', () => {
  it('記録時刻の昇順に並べ替える', () => {
    // 一覧は新しい順に見せているが、ログは時系列で読むもの
    const result = buildConsoleExport(
      [log({ id: 1, ts: 300, text: '新' }), log({ id: 2, ts: 100, text: '古' })],
      '1.2.3',
    );

    expect(result.entries.map((entry) => entry.text)).toEqual(['古', '新']);
  });

  it('形式とバージョンを名乗る', () => {
    const result = buildConsoleExport([], '1.2.3', 0);

    expect(result.everlog.format).toBe('console-log');
    expect(result.everlog.version).toBe(CONSOLE_EXPORT_VERSION);
    expect(result.everlog.creator).toEqual({ name: 'EverLog', version: '1.2.3' });
    expect(result.everlog.exportedAt).toBe('1970-01-01T00:00:00.000Z');
  });

  it('サニタイズ済みであることを注記に残す', () => {
    expect(buildConsoleExport([], '1.0.0').everlog.comment).toContain('サニタイズ済み');
  });

  it('0 件でも壊れた形にはしない', () => {
    const result = buildConsoleExport([], '1.0.0');

    expect(result.entries).toEqual([]);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('入力の配列を書き換えない', () => {
    const logs = [log({ id: 1, ts: 300 }), log({ id: 2, ts: 100 })];

    buildConsoleExport(logs, '1.0.0');

    expect(logs.map((entry) => entry.id)).toEqual([1, 2]);
  });
});

describe('estimateConsoleExportBytes', () => {
  it('件数が増えれば大きくなる', () => {
    const one = estimateConsoleExportBytes([log()]);
    const two = estimateConsoleExportBytes([log(), log()]);

    expect(two).toBeGreaterThan(one);
  });

  it('本文・引数・スタックの長さを数える', () => {
    const small = estimateConsoleExportBytes([log({ text: 'a', args: [], stack: null })]);
    const large = estimateConsoleExportBytes([
      log({ text: 'a'.repeat(100), args: ['b'.repeat(50)], stack: 'c'.repeat(30) }),
    ]);

    expect(large - small).toBe(100 - 1 + 50 + 30);
  });

  it('0 件は 0', () => {
    expect(estimateConsoleExportBytes([])).toBe(0);
  });
});

describe('consoleFileName', () => {
  it('ローカル時刻で組む（画面の時刻表示と突き合わせられるように）', () => {
    const now = new Date(2026, 7, 6, 23, 45, 0).getTime();

    expect(consoleFileName(now)).toBe('everlog-console-20260806-234500.json');
  });

  it('壊れた時刻でもファイル名を作る', () => {
    expect(consoleFileName(Number.NaN)).toMatch(/^everlog-console-\d{8}-\d{6}\.json$/);
  });

  it('HAR の出力と名前が衝突しない', () => {
    expect(consoleFileName(Date.now())).toContain('-console-');
  });
});
