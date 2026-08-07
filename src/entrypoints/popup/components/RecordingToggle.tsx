/**
 * 記録の ON/OFF。props を描くだけの表示コンポーネント。
 *
 * バッジ表示は background が設定の変更を購読して行うため、ここでは触らない。
 *
 * ネットワークとコンソールで同じものを使い回す。文言は `popup-view.ts` の
 * `describeNetworkRecording()` / `describeConsoleRecording()` が作るため、
 * このコンポーネントは自分がどちらの記録を表しているかを知らない。
 */

import type { RecordingLabel } from '@/lib/popup-view';

interface Props {
  recording: boolean;
  label: RecordingLabel;
  /** 設定を読み終えるまでは操作させない */
  disabled: boolean;
  onChange: (recording: boolean) => void;
}

export function RecordingToggle({ recording, label, disabled, onChange }: Props) {
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
        <span className="text-sm font-medium">{label.title}</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{label.detail}</span>
      </span>
    </label>
  );
}
