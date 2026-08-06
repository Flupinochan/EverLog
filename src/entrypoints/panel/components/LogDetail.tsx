/**
 * 詳細表示。選択したエントリのヘッダーとボディを見せる。
 *
 * ボディの取得は行わず、props で受け取る。取得は `useLogBody` の責務。
 */

import { useMemo, type ReactNode } from 'react';
import type { StoredLog } from '@/lib/db';
import {
  describeBodyStatus,
  formatBody,
  formatBytes,
  formatDuration,
  formatTimestamp,
  sortHeaders,
} from '@/lib/panel-view';

interface Props {
  log: StoredLog | null;
  /** 保存されているボディ。未取得・未保存なら null */
  body: string | null;
  bodyLoading: boolean;
  bodyError: string | null;
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
  if (rows.length === 0) {
    return <p className="text-xs text-zinc-500">なし</p>;
  }
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
      {rows.map(([name, value]) => (
        <div key={name} className="contents">
          <dt className="text-zinc-500 dark:text-zinc-400">{name}</dt>
          <dd className="break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LogDetail({ log, body, bodyLoading, bodyError, onClose }: Props) {
  if (log === null) {
    return (
      <aside className="hidden w-2/5 min-w-80 shrink-0 items-center justify-center border-l border-zinc-200 p-4 text-xs text-zinc-500 md:flex dark:border-zinc-700">
        行を選択すると詳細を表示します
      </aside>
    );
  }

  const reason = describeBodyStatus(log.bodyStatus);
  const hasDropped =
    log.droppedRequestHeaders.length > 0 || log.droppedResponseHeaders.length > 0;

  return (
    // 縦積み（DevTools を右にドックしたときなど狭い幅）では高さを分け合って自前で
    // スクロールさせる。shrink-0 のままだと body の overflow:hidden に切られて
    // ボディまで辿り着けない。
    <aside className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto border-t border-zinc-200 md:w-2/5 md:min-w-80 md:flex-none md:border-t-0 md:border-l dark:border-zinc-700">
      <header className="sticky top-0 z-10 flex items-start gap-2 border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800">
        <span className="min-w-0 flex-1 font-mono text-xs break-all">{log.url}</span>
        <button
          type="button"
          className="shrink-0 text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
          onClick={onClose}
          aria-label="詳細を閉じる"
        >
          ✕
        </button>
      </header>

      <Section title="概要">
        <Rows
          rows={[
            ['時刻', formatTimestamp(log.ts)],
            ['メソッド', log.method],
            ['ステータス', log.status === 0 ? '- (レスポンスなし)' : String(log.status)],
            ['MIME', log.mimeType || '-'],
            ['サイズ', formatBytes(log.bodySize)],
            ['所要時間', formatDuration(log.timeMs)],
            ['ホスト', log.host || '-'],
            ['ページ', log.pageUrl || '-'],
            ['タブ ID', String(log.tabId)],
          ]}
        />
      </Section>

      <Section title="リクエストヘッダー">
        <Rows rows={sortHeaders(log.requestHeaders)} />
      </Section>

      <Section title="レスポンスヘッダー">
        <Rows rows={sortHeaders(log.responseHeaders)} />
      </Section>

      {hasDropped && (
        <Section title="保存しなかったヘッダー">
          {/* 値は保存していない。「独自認証ヘッダーが付いていた」事実だけを残す。
              同名でも request と response では意味が違うため、行を分けて出す */}
          <Rows
            rows={[
              ...(log.droppedRequestHeaders.length > 0
                ? ([['リクエスト', log.droppedRequestHeaders.join(', ')]] as Array<[string, string]>)
                : []),
              ...(log.droppedResponseHeaders.length > 0
                ? ([['レスポンス', log.droppedResponseHeaders.join(', ')]] as Array<
                    [string, string]
                  >)
                : []),
            ]}
          />
        </Section>
      )}

      <Section title="レスポンスボディ">
        <BodyView
          body={body}
          loading={bodyLoading}
          error={bodyError}
          reason={reason}
          mimeType={log.mimeType}
        />
      </Section>
    </aside>
  );
}

function BodyView({
  body,
  loading,
  error,
  reason,
  mimeType,
}: {
  body: string | null;
  loading: boolean;
  error: string | null;
  /** ボディが保存されていない理由。保存済みなら空文字 */
  reason: string;
  mimeType: string;
}) {
  // 整形は最大 1MB の JSON.parse + stringify になる。自動更新のたびに
  // やり直さないよう、ボディが変わったときだけ計算する。
  const { text, pretty } = useMemo(
    () => (body === null ? { text: '', pretty: false } : formatBody(body, mimeType)),
    [body, mimeType],
  );

  if (loading) return <p className="text-xs text-zinc-500">読み込み中…</p>;
  if (error !== null) {
    return <p className="text-xs text-red-600 dark:text-red-400">読み込みに失敗しました: {error}</p>;
  }
  // 保存されなかった理由は破棄せず表示する
  if (reason !== '') return <p className="text-xs text-zinc-500">{reason}</p>;
  if (body === null) {
    return <p className="text-xs text-zinc-500">ボディは保存されていません</p>;
  }

  return (
    <>
      {pretty && <p className="mb-1 text-xs text-zinc-500">JSON として整形して表示しています</p>}
      <pre className="max-h-96 overflow-auto rounded bg-zinc-50 p-2 font-mono text-xs whitespace-pre-wrap dark:bg-zinc-800">
        {text}
      </pre>
    </>
  );
}
