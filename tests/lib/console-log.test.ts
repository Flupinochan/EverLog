import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONSOLE_PREVIEW_OPTIONS,
  applyFormat,
  createRateLimiter,
  formatConsoleArgs,
  isConsoleBatchMessage,
  normalizeConsoleLevel,
  parseStackTop,
  previewValue,
  type ConsolePreviewOptions,
} from '@/lib/console-log';

/** 上限の効き方を見たいテストのために、既定より小さい値へ差し替える。 */
function options(overrides: Partial<ConsolePreviewOptions> = {}): ConsolePreviewOptions {
  return { ...DEFAULT_CONSOLE_PREVIEW_OPTIONS, ...overrides };
}

describe('previewValue', () => {
  it('プリミティブをそのまま出す', () => {
    expect(previewValue('hi').text).toBe('hi');
    expect(previewValue(42).text).toBe('42');
    expect(previewValue(true).text).toBe('true');
    expect(previewValue(null).text).toBe('null');
    expect(previewValue(undefined).text).toBe('undefined');
    expect(previewValue(10n).text).toBe('10n');
  });

  it('-0 を 0 と区別する', () => {
    expect(previewValue(-0).text).toBe('-0');
    expect(previewValue(0).text).toBe('0');
  });

  it('ネストした文字列には引用符を付ける', () => {
    // `{a: 1}` と `{a: '1'}` を見分けられる必要がある
    expect(previewValue({ a: '1' }).text).toBe('{a: "1"}');
    expect(previewValue({ a: 1 }).text).toBe('{a: 1}');
  });

  it('循環参照を [Circular] にする', () => {
    const value: Record<string, unknown> = { name: 'root' };
    value.self = value;

    expect(previewValue(value).text).toBe('{name: "root", self: [Circular]}');
  });

  it('同じオブジェクトが兄弟として現れても循環とは呼ばない', () => {
    const shared = { id: 1 };

    expect(previewValue({ a: shared, b: shared }).text).toBe('{a: {id: 1}, b: {id: 1}}');
  });

  it('深さの上限を超えたら種別だけ残す', () => {
    const value = { a: { b: { c: { d: { e: 1 } } } } };
    const result = previewValue(value, options({ maxDepth: 2 }));

    expect(result.text).toBe('{a: {b: [Object]}}');
    expect(result.truncated).toBe(true);
  });

  it('配列の要素数を上限で打ち切る', () => {
    const result = previewValue([1, 2, 3, 4, 5], options({ maxArrayItems: 2 }));

    expect(result.text).toBe('[1, 2, …他 3 件]');
    expect(result.truncated).toBe(true);
  });

  it('長い文字列を切り詰めて省略した文字数を残す', () => {
    const result = previewValue('a'.repeat(20), options({ maxStringLength: 5 }));

    expect(result.text).toBe('aaaaa…(15 文字省略)');
    expect(result.truncated).toBe(true);
  });

  it('Error を name: message にする', () => {
    expect(previewValue(new TypeError('壊れた')).text).toBe('TypeError: 壊れた');
  });

  it('別 realm の Error でも形で判定する', () => {
    // iframe から来た値は instanceof が外れる。message と stack の形だけで判定している
    const foreign = { name: 'RangeError', message: 'out', stack: 'RangeError: out\n  at x' };

    expect(previewValue(foreign).text).toBe('RangeError: out');
  });

  it('DOM ノードをタグの形で出す', () => {
    // Node に依存せず形で判定するため、テストも同じ形のオブジェクトで足りる
    const node = { nodeType: 1, nodeName: 'DIV', id: 'app', className: 'a b' };

    expect(previewValue(node).text).toBe('<div#app.a.b>');
  });

  it('関数を名前つきで出す', () => {
    expect(previewValue(function named() {}).text).toBe('[Function: named]');
    expect(previewValue(() => {}).text).toBe('[Function (anonymous)]');
  });

  it('Map と Set を件数つきで出す', () => {
    expect(previewValue(new Map([['a', 1]])).text).toBe('Map(1) {"a" => 1}');
    expect(previewValue(new Set([1, 2])).text).toBe('Set(2) {1, 2}');
  });

  it('例外を投げる getter があっても全体を落とさない', () => {
    const value = {
      ok: 1,
      get broken(): never {
        throw new Error('読めない');
      },
    };

    expect(previewValue(value).text).toBe('{ok: 1, broken: [取得できません]}');
  });

  it('Date を ISO 文字列にする', () => {
    expect(previewValue(new Date(0)).text).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('applyFormat', () => {
  it('%s と %d を展開して消費数を返す', () => {
    const result = applyFormat('%s は %d 件', ['りんご', 3]);

    expect(result.text).toBe('りんご は 3 件');
    expect(result.consumed).toBe(2);
  });

  it('%d は整数へ丸める', () => {
    expect(applyFormat('%d', [3.9]).text).toBe('3');
    expect(applyFormat('%f', [3.5]).text).toBe('3.5');
    expect(applyFormat('%d', ['abc']).text).toBe('NaN');
  });

  it('%c はスタイルなので引数を消費して何も出さない', () => {
    const result = applyFormat('%cあか', ['color: red']);

    expect(result.text).toBe('あか');
    expect(result.consumed).toBe(1);
  });

  it('%% はリテラルの % にする（引数を消費しない）', () => {
    const result = applyFormat('100%% 完了', []);

    expect(result.text).toBe('100% 完了');
    expect(result.consumed).toBe(0);
  });

  it('引数が足りない指定子はそのまま残す', () => {
    // 勝手に undefined を埋めると、元の出力に無い文字列を保存することになる
    const result = applyFormat('%s と %s', ['あ']);

    expect(result.text).toBe('あ と %s');
    expect(result.consumed).toBe(1);
  });

  it('%o はプレビューを埋める', () => {
    expect(applyFormat('%o', [{ a: 1 }]).text).toBe('{a: 1}');
  });
});

describe('formatConsoleArgs', () => {
  it('第 1 引数が文字列なら書式指定子を展開する', () => {
    const result = formatConsoleArgs(['%s 件', 3]);

    expect(result.text).toBe('3 件');
    expect(result.args).toEqual(['%s 件', '3']);
    expect(result.argsStatus).toBe('stored');
  });

  it('展開に使わなかった引数を末尾へ連結する', () => {
    const result = formatConsoleArgs(['%s:', 'ラベル', { a: 1 }]);

    expect(result.text).toBe('ラベル: {a: 1}');
  });

  it('第 1 引数が文字列でなければ書式は解釈せず連結する', () => {
    const result = formatConsoleArgs([{ a: 1 }, '%s']);

    expect(result.text).toBe('{a: 1} %s');
  });

  it('引数の個数が上限を超えたら残数を添えて truncated にする', () => {
    const result = formatConsoleArgs([1, 2, 3, 4], options({ maxArgs: 2 }));

    expect(result.text).toBe('1 2 …他 2 個の引数');
    expect(result.args).toEqual(['1', '2']);
    expect(result.argsStatus).toBe('truncated');
  });

  it('1 件あたりの上限を超えたら内訳から削る', () => {
    const result = formatConsoleArgs(
      ['x'.repeat(40), 'y'.repeat(40)],
      options({ maxEntryChars: 50, maxStringLength: 100 }),
    );

    expect(result.argsStatus).toBe('truncated');
    // text は一覧と検索で使う唯一の値なので残り、内訳のほうが先に落ちる
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.args.length).toBeLessThan(2);
  });

  it('引数が無ければ空文字になる', () => {
    const result = formatConsoleArgs([]);

    expect(result.text).toBe('');
    expect(result.args).toEqual([]);
    expect(result.argsStatus).toBe('stored');
  });
});

describe('parseStackTop', () => {
  it('先頭のフレームから url:line:col を取る', () => {
    const stack = ['Error: x', '    at foo (https://example.com/a.js:12:34)', '    at bar'].join(
      '\n',
    );

    expect(parseStackTop(stack)).toBe('https://example.com/a.js:12:34');
  });

  it('関数名の無いフレームも読む', () => {
    const stack = ['Error: x', '    at https://example.com/a.js:1:2'].join('\n');

    expect(parseStackTop(stack)).toBe('https://example.com/a.js:1:2');
  });

  it('拡張機能自身のフレームは読み飛ばす', () => {
    // ラッパーが発生元として記録されると、元の呼び出し位置が分からなくなる
    const stack = [
      'Error: x',
      '    at wrap (chrome-extension://abc/content-scripts/console.js:1:1)',
      '    at page (https://example.com/a.js:9:9)',
    ].join('\n');

    expect(parseStackTop(stack)).toBe('https://example.com/a.js:9:9');
  });

  it('読めない場合は null', () => {
    expect(parseStackTop(undefined)).toBeNull();
    expect(parseStackTop('')).toBeNull();
    expect(parseStackTop('Error: x')).toBeNull();
  });
});

describe('normalizeConsoleLevel', () => {
  it('知っているレベルはそのまま返す', () => {
    expect(normalizeConsoleLevel('warn')).toBe('warn');
    expect(normalizeConsoleLevel('unhandledrejection')).toBe('unhandledrejection');
  });

  it('知らない値は log に寄せる', () => {
    expect(normalizeConsoleLevel('table')).toBe('log');
    expect(normalizeConsoleLevel(undefined)).toBe('log');
  });
});

describe('createRateLimiter', () => {
  it('窓のなかで上限を超えた分を捨てる', () => {
    const limiter = createRateLimiter(2, 1000);

    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(10)).toBe(true);
    expect(limiter.allow(20)).toBe(false);
    expect(limiter.takeDropped()).toBe(1);
  });

  it('窓が変わったら数え直す', () => {
    const limiter = createRateLimiter(1, 1000);

    expect(limiter.allow(0)).toBe(true);
    expect(limiter.allow(500)).toBe(false);
    expect(limiter.allow(1000)).toBe(true);
  });

  it('takeDropped は読むたびに 0 へ戻す', () => {
    const limiter = createRateLimiter(0, 1000);

    limiter.allow(0);
    limiter.allow(0);

    expect(limiter.takeDropped()).toBe(2);
    expect(limiter.takeDropped()).toBe(0);
  });
});

describe('isConsoleBatchMessage', () => {
  it('形の合うメッセージだけ受け入れる', () => {
    expect(isConsoleBatchMessage({ type: 'everlog:console-batch', entries: [] })).toBe(true);
    expect(isConsoleBatchMessage({ type: 'everlog:console-batch' })).toBe(false);
    expect(isConsoleBatchMessage({ type: 'other', entries: [] })).toBe(false);
    expect(isConsoleBatchMessage(null)).toBe(false);
    expect(isConsoleBatchMessage('everlog:console-batch')).toBe(false);
  });
});
