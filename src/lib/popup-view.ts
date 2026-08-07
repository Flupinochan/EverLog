/**
 * popup の表示ロジック。
 *
 * DOM にも React にも Chrome API にも依存しない純粋関数だけを置く（`panel-view.ts`
 * と同じ方針）。popup のコンポーネントは「ここで作った値を描画するだけ」に保つ。
 */

import { MAX_URL_PATTERNS, matchesUrlPatterns, type UrlFilterMode } from './network-log';

/**
 * 「すべてに一致するか」を試すための URL。共通部分がほとんど無い 2 つを選ぶ。
 *
 * 任意のパターンが全 URL に一致するかを厳密に判定することはできないため、両方に
 * 当たったものを事実上の全一致と見なす。`*` や `**` はもちろん、`/` や `*​/*` や `.`
 * のような「絞ったつもり」のパターンも拾える。多めに警告しても実害は無い。
 */
const CATCH_ALL_PROBES = ['https://example.com/', 'http://192.0.2.1/b?c=d'];

/** 事実上すべての URL に一致するパターンか。判定は `matchesUrlPatterns` に委ねる。 */
function isCatchAllPattern(pattern: string): boolean {
  return CATCH_ALL_PROBES.every((probe) => matchesUrlPatterns(probe, [pattern]));
}

/**
 * 入力欄の 1 行 1 パターンを配列にする。空行と前後の空白、重複は落とす。
 *
 * 件数の切り捨ては行わない。`normalizeUrlFilter()` は上限を超えた分を黙って
 * 捨てるが、ここで同じことをすると UI が超過に気づけず、警告も保存の抑止も
 * できなくなるため。
 */
export function parsePatternLines(text: string): string[] {
  const patterns: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const pattern = line.trim();
    if (pattern === '' || patterns.includes(pattern)) continue;
    patterns.push(pattern);
  }
  return patterns;
}

/** 配列を入力欄の文字列に戻す。 */
export function formatPatternLines(patterns: string[]): string {
  return patterns.join('\n');
}

/**
 * 入力欄に未保存の変更があるか。
 *
 * 生の文字列ではなく畳んだ結果どうしを比べる。末尾の空行や重複を足しただけで
 * 「未保存」と言われても、利用者には保存すべきものが見えないため。
 */
export function hasUnsavedPatterns(text: string, saved: string[]): boolean {
  const parsed = parsePatternLines(text);
  if (parsed.length !== saved.length) return true;
  return parsed.some((pattern, index) => pattern !== saved[index]);
}

/** 保持できる件数を超えているか。超えている間は保存させない。 */
export function exceedsPatternLimit(patterns: string[]): boolean {
  return patterns.length > MAX_URL_PATTERNS;
}

/** 記録トグルに出す見出しと補足。 */
export interface RecordingLabel {
  title: string;
  detail: string;
}

/**
 * ネットワークログの記録状態の説明。
 *
 * 「DevTools を開いているタブだけ」と明示する。この制約は API 側の事情であって
 * 利用者には見えないため、書いておかないと「記録中なのに残らない」と映る。
 */
export function describeNetworkRecording(recording: boolean): RecordingLabel {
  return recording
    ? { title: 'ネットワークを記録中', detail: 'DevTools を開いているタブのリクエストを保存します' }
    : { title: 'ネットワークの記録を停止中', detail: '新しいリクエストは保存されません' };
}

/**
 * コンソールログの記録状態の説明。
 *
 * ネットワークと違い DevTools を開いていなくても記録される。同じ「記録中」でも
 * 範囲が違うので、それぞれの文言で書き分ける。
 */
export function describeConsoleRecording(recording: boolean): RecordingLabel {
  return recording
    ? {
        title: 'コンソールを記録中',
        detail: 'DevTools を開いていなくても、ページの console 出力を保存します',
      }
    : { title: 'コンソールの記録を停止中', detail: '新しい console 出力は保存されません' };
}

/** モードの意味を 1 行で説明する。 */
export function describeUrlFilterMode(mode: UrlFilterMode): string {
  return mode === 'allow'
    ? 'パターンに一致した URL だけ記録します'
    : 'パターンに一致した URL は記録しません';
}

/** 現在のパターン件数の表示。 */
export function describeUrlFilterCount(count: number): string {
  return count === 0 ? 'パターンなし' : `${count} 件のパターン`;
}

/**
 * 設定の組み合わせが分かりにくい結果になるときの注意文言。無ければ null。
 *
 * 「限定にしたのに全部記録される」「除外のつもりで全部消える」は挙動としては
 * 仕様どおりでも、画面に出ていないと不具合に見えるため明示する。
 */
export function urlFilterNotice(mode: UrlFilterMode, patterns: string[]): string | null {
  if (exceedsPatternLimit(patterns)) {
    return `パターンは ${MAX_URL_PATTERNS} 件までです（現在 ${patterns.length} 件）`;
  }
  if (patterns.length === 0) {
    return mode === 'allow'
      ? 'パターンが空のため、すべてのリクエストを記録します'
      : null;
  }
  if (mode === 'deny' && patterns.some(isCatchAllPattern)) {
    return 'すべての URL に一致するパターンがあるため、何も記録されません';
  }
  return null;
}
