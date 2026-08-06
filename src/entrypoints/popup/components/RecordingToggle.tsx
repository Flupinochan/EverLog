/**
 * 記録の ON/OFF（CAP-03 / POP-01）。props を描くだけの表示コンポーネント。
 *
 * バッジ表示は background が設定の変更を購読して行うため、ここでは触らない。
 */

interface Props {
  recording: boolean;
  /** 設定を読み終えるまでは操作させない */
  disabled: boolean;
  onChange: (recording: boolean) => void;
}

export function RecordingToggle({ recording, disabled, onChange }: Props) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 rounded border border-zinc-200 bg-zinc-50 px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-800">
      <input
        type="checkbox"
        className="h-4 w-4 accent-red-600"
        checked={recording}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="flex flex-col">
        <span className="text-sm font-medium">
          {recording ? '記録中' : '記録を停止中'}
        </span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {recording
            ? 'DevTools を開いているタブのリクエストを保存します'
            : '新しいリクエストは保存されません'}
        </span>
      </span>
    </label>
  );
}
