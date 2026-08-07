import { describe, expect, it } from 'vitest';
import { MAX_URL_PATTERNS } from '@/lib/network-log';
import {
  describeUrlFilterCount,
  describeUrlFilterMode,
  exceedsPatternLimit,
  formatPatternLines,
  hasUnsavedPatterns,
  parsePatternLines,
  urlFilterNotice,
} from '@/lib/popup-view';

describe('parsePatternLines', () => {
  it('1 行 1 パターンとして読み取る', () => {
    expect(parsePatternLines('*/oauth/*\nhttps://api.example.com/*')).toEqual([
      '*/oauth/*',
      'https://api.example.com/*',
    ]);
  });

  it('空行と前後の空白を落とす', () => {
    expect(parsePatternLines('  /a  \n\n\n  /b\n   \n')).toEqual(['/a', '/b']);
  });

  it('CRLF 改行でも分割する', () => {
    expect(parsePatternLines('/a\r\n/b')).toEqual(['/a', '/b']);
  });

  it('重複したパターンは 1 つにまとめる', () => {
    expect(parsePatternLines('/a\n /a \n/b')).toEqual(['/a', '/b']);
  });

  it('空文字からは空配列を返す', () => {
    expect(parsePatternLines('')).toEqual([]);
    expect(parsePatternLines('   \n  ')).toEqual([]);
  });

  it('上限を超えても切り捨てない（UI が超過を検出できるようにするため）', () => {
    const text = Array.from({ length: MAX_URL_PATTERNS + 5 }, (_, i) => `/p${i}`).join('\n');

    expect(parsePatternLines(text)).toHaveLength(MAX_URL_PATTERNS + 5);
  });
});

describe('formatPatternLines', () => {
  it('改行区切りの文字列に戻す', () => {
    expect(formatPatternLines(['/a', '/b'])).toBe('/a\n/b');
    expect(formatPatternLines([])).toBe('');
  });

  it('parse と format を往復しても内容が変わらない', () => {
    const patterns = ['*/oauth/*', 'https://api.example.com/*'];

    expect(parsePatternLines(formatPatternLines(patterns))).toEqual(patterns);
  });
});

describe('hasUnsavedPatterns', () => {
  it('保存済みの値と同じなら未保存と見なさない', () => {
    expect(hasUnsavedPatterns('/a\n/b', ['/a', '/b'])).toBe(false);
  });

  it('空行や重複だけの違いは未保存と見なさない', () => {
    expect(hasUnsavedPatterns('/a\n\n /b \n/a\n', ['/a', '/b'])).toBe(false);
  });

  it('パターンが増えれば未保存と見なす', () => {
    expect(hasUnsavedPatterns('/a\n/b\n/c', ['/a', '/b'])).toBe(true);
  });

  it('パターンの並びが変われば未保存と見なす', () => {
    expect(hasUnsavedPatterns('/b\n/a', ['/a', '/b'])).toBe(true);
  });

  it('すべて消せば未保存と見なす', () => {
    expect(hasUnsavedPatterns('', ['/a'])).toBe(true);
  });
});

describe('describeUrlFilterMode', () => {
  it('モードごとの説明を返す', () => {
    expect(describeUrlFilterMode('allow')).toContain('だけ記録');
    expect(describeUrlFilterMode('deny')).toContain('記録しません');
  });
});

describe('describeUrlFilterCount', () => {
  it('件数を表示する', () => {
    expect(describeUrlFilterCount(0)).toBe('パターンなし');
    expect(describeUrlFilterCount(3)).toBe('3 件のパターン');
  });
});

describe('exceedsPatternLimit', () => {
  it('上限ちょうどは超過と見なさない', () => {
    expect(exceedsPatternLimit(new Array<string>(MAX_URL_PATTERNS).fill('/a'))).toBe(false);
  });

  it('上限を 1 件でも超えれば真を返す', () => {
    expect(exceedsPatternLimit(new Array<string>(MAX_URL_PATTERNS + 1).fill('/a'))).toBe(true);
  });
});

describe('urlFilterNotice', () => {
  it('allow でパターンが空ならすべて記録すると伝える', () => {
    expect(urlFilterNotice('allow', [])).toContain('すべてのリクエストを記録');
  });

  it('deny でパターンが空なら何も言わない', () => {
    expect(urlFilterNotice('deny', [])).toBeNull();
  });

  it('deny に * があればすべて除外されると伝える', () => {
    expect(urlFilterNotice('deny', ['*'])).toContain('記録されません');
  });

  it('allow の * は全件記録なので警告しない', () => {
    expect(urlFilterNotice('allow', ['*'])).toBeNull();
  });

  it('上限を超えていればその旨を返す', () => {
    const patterns = new Array<string>(MAX_URL_PATTERNS + 1).fill('/a');

    expect(urlFilterNotice('deny', patterns)).toContain(`${MAX_URL_PATTERNS} 件まで`);
  });

  it('通常の設定では何も言わない', () => {
    expect(urlFilterNotice('deny', ['*/oauth/*'])).toBeNull();
    expect(urlFilterNotice('allow', ['api.example.com'])).toBeNull();
  });
});
