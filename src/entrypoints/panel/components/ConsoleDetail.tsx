/**
 * コンソールの詳細表示。選択したエントリの本文・引数の内訳・スタックを見せる。
 *
 * ネットワーク側と違い、追加の取得を伴わない。本文も引数も一覧の 1 件に入っている
 * ため、`useLogBody` にあたるフックが要らない。
 */

import type { ReactNode } from 'react';
import type { StoredConsoleLog } from '@/lib/db';
import { describeArgsStatus, describeConsoleLevel, formatTimestamp } from '@/lib/panel-view';

interface Props {
  log: StoredConsoleLog | null;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-b border-zinc-200 px-3 py-2 dark:border-zinc-700">
      <h2 className="mb-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">{title}</h2>
      {children}
    </section>
  );
}

function Rows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-zinc-500 dark:text-zinc-400">{name}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ConsoleDetail({ log, onClose }: Props) {
  if (log === null) {
    return (
      <aside className="hidden w-2/5 min-w-80 shrink-0 items-center justify-center border-l border-zinc-200 p-4 text-xs text-zinc-500 md:flex dark:border-zinc-700">
        行を選択すると詳細を表示します
      </aside>
    );
  }

  const reason = describeArgsStatus(log.argsStatus);

  return (
    // 縦積み（DevTools を右にドックしたときなど狭い幅）での扱いは `LogDetail` と揃える
    <aside className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto border-t border-zinc-200 md:w-2/5 md:min-w-80 md:flex-none md:border-t-0 md:border-l dark:border-zinc-700">
      <header className="sticky top-0 z-10 flex items-start gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800">
        <span className="min-w-0 flex-1 font-mono text-xs break-all">
          [{describeConsoleLevel(log.level)}] {log.source ?? '発生元不明'}
        </span>
        <button
          type="button"
          className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          onClick={onClose}
          aria-label="詳細を閉じる"
        >
          ✕
        </button>
      </header>

      <Section title="本文">
        {log.text === '' ? (
          <p className="text-xs text-zinc-500">本文はありません</p>
        ) : (
          <pre className="max-h-64 overflow-auto rounded bg-zinc-50 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-zinc-800">
            {log.text}
          </pre>
        )}
        {/* 上限で削った場合は理由を残す（`describeBodyStatus()` と同じ扱い） */}
        {reason !== '' && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">{reason}</p>}
      </Section>

      <Section title="概要">
        <Rows
          rows={[
            ['時刻', formatTimestamp(log.ts)],
            ['レベル', log.level],
            ['発生元', log.source ?? '-'],
            ['ページ', log.pageUrl || '-'],
            ['タブ ID', String(log.tabId)],
          ]}
        />
      </Section>

      <Section title={`引数（${log.args.length} 個）`}>
        {log.args.length === 0 ? (
          <p className="text-xs text-zinc-500">なし</p>
        ) : (
          // 引数ごとに分けて出す。本文は連結済みなので、どこまでが 1 つの値かは
          // こちらでしか分からない
          <ol className="flex flex-col gap-1">
            {log.args.map((arg, index) => (
              <li key={index} className="flex gap-2">
                <span className="shrink-0 font-mono text-xs text-zinc-400 dark:text-zinc-500">
                  {index}
                </span>
                <pre className="min-w-0 flex-1 overflow-auto rounded bg-zinc-50 p-1.5 font-mono text-xs whitespace-pre-wrap dark:bg-zinc-800">
                  {arg}
                </pre>
              </li>
            ))}
          </ol>
        )}
      </Section>

      {log.stack !== null && (
        <Section title="スタック">
          <pre className="max-h-64 overflow-auto rounded bg-zinc-50 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-zinc-800">
            {log.stack}
          </pre>
        </Section>
      )}
    </aside>
  );
}
