/**
 * URL フィルタの編集。props を描くだけの表示コンポーネント。
 *
 * 文字列とパターン配列の変換や文言の組み立ては `@/lib/popup-view` が担う。
 */

import {
  describeUrlFilterCount,
  describeUrlFilterMode,
  exceedsPatternLimit,
  parsePatternLines,
  urlFilterNotice,
} from '@/lib/popup-view';
import type { UrlFilterMode } from '@/lib/network-log';

interface Props {
  mode: UrlFilterMode;
  onModeChange: (mode: UrlFilterMode) => void;
  /** 入力欄の表示値。1 行 1 パターン */
  value: string;
  onValueChange: (text: string) => void;
  /** 入力欄の内容を設定に反映する */
  onApply: () => void;
  /** 編集を捨てて保存済みの値に戻す */
  onRevert: () => void;
  /** 保存済みの値と入力欄の内容が食い違っているか */
  dirty: boolean;
  /** 設定を読み終えるまでは操作させない */
  disabled: boolean;
}

const TEXTAREA =
  'w-full resize-y rounded border border-zinc-300 bg-white px-1.5 py-1 font-mono text-xs ' +
  'text-zinc-900 focus:border-sky-500 focus:outline-none ' +
  'dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100';

const BUTTON =
  'h-6 rounded border border-zinc-300 bg-zinc-100 px-2 text-xs text-zinc-700 ' +
  'hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50 ' +
  'dark:border-zinc-600 dark:bg-zinc-700 dark:text-zinc-100 dark:hover:bg-zinc-600';

const MODE_OPTIONS: { mode: UrlFilterMode; label: string }[] = [
  { mode: 'deny', label: '除外' },
  { mode: 'allow', label: '限定' },
];

export function UrlFilterEditor({
  mode,
  onModeChange,
  value,
  onValueChange,
  onApply,
  onRevert,
  dirty,
  disabled,
}: Props) {
  const patterns = parsePatternLines(value);
  const notice = urlFilterNotice(mode, patterns);
  // 上限を超えたまま保存すると超過分が黙って捨てられるため、確定させない
  const applicable = dirty && !exceedsPatternLimit(patterns);

  return (
    <section className="flex flex-col gap-1.5 rounded border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-800">
      <h2 className="text-xs font-medium text-zinc-500 dark:text-zinc-400">URL フィルタ</h2>

      <div className="flex items-center gap-3">
        {MODE_OPTIONS.map((option) => (
          <label key={option.mode} className="flex cursor-pointer items-center gap-1 text-sm">
            <input
              type="radio"
              name="url-filter-mode"
              className="h-3.5 w-3.5 accent-red-600"
              checked={mode === option.mode}
              disabled={disabled}
              onChange={() => onModeChange(option.mode)}
            />
            {option.label}
          </label>
        ))}
      </div>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{describeUrlFilterMode(mode)}</p>

      <textarea
        rows={4}
        wrap="off"
        className={TEXTAREA}
        placeholder={'1 行に 1 パターン\n*/oauth/*\nhttps://api.example.com/*'}
        value={value}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
      />

      <div className="flex items-center gap-1.5">
        <button type="button" className={BUTTON} disabled={disabled || !applicable} onClick={onApply}>
          適用
        </button>
        {dirty && (
          <button type="button" className={BUTTON} disabled={disabled} onClick={onRevert}>
            取り消し
          </button>
        )}
        <span className="ml-auto text-xs text-zinc-500 dark:text-zinc-400">
          {dirty ? '未保存の変更があります' : describeUrlFilterCount(patterns.length)}
        </span>
      </div>

      {notice !== null && (
        <p className="text-xs text-amber-700 dark:text-amber-400">{notice}</p>
      )}
    </section>
  );
}
