/**
 * パネルの画面全体。
 *
 * ここが持つ状態は「どちらのタブを見ているか」だけにする。一覧・詳細・出力の配線は
 * `views/` の 2 つに分かれており、この層は表示するものを選ぶだけに保つ。
 */

import { useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { indexedDbLogSource, type LogSource } from '@/lib/log-source';
import type { PanelView } from '@/lib/panel-view';
import { ViewTabs } from './components/ViewTabs';
import { ConsoleView } from './views/ConsoleView';
import { NetworkView } from './views/NetworkView';

/** 自動更新の間隔。DevTools を開いたまま記録が増えるため、既定で追従させる。 */
const AUTO_REFRESH_INTERVAL_MS = 2000;

/** 検査中のタブ。パネルからも `chrome.devtools.*` を参照できる。 */
function inspectedTabId(): number | undefined {
  try {
    return browser.devtools?.inspectedWindow?.tabId;
  } catch {
    return undefined;
  }
}

/** 出力に載せる `creator.version` の値。読めない場合も出力自体は止めない。 */
function extensionVersion(): string {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return '0.0.0';
  }
}

interface Props {
  /** データ取得先。既定は IndexedDB（差し替えは Storybook・UI テスト用） */
  source?: LogSource;
  tabId?: number;
}

export function App({ source = indexedDbLogSource, tabId }: Props = {}) {
  const [view, setView] = useState<PanelView>('network');

  const currentTabId = useMemo(() => tabId ?? inspectedTabId(), [tabId]);
  const version = useMemo(() => extensionVersion(), []);

  return (
    <div className="flex h-screen flex-col bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100">
      <ViewTabs view={view} onChange={setView} />

      {/*
        隠れているほうもマウントしたままにする。アンマウントすると、タブを戻したときに
        入力していた絞り込み条件と開いていた詳細が消える。走査の負荷は `active` を
        渡して自動更新を止めることで抑える。
      */}
      <div className={view === 'network' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <NetworkView
          source={source}
          tabId={currentTabId}
          version={version}
          active={view === 'network'}
          refreshIntervalMs={AUTO_REFRESH_INTERVAL_MS}
        />
      </div>
      <div className={view === 'console' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <ConsoleView
          source={source}
          tabId={currentTabId}
          version={version}
          active={view === 'console'}
          refreshIntervalMs={AUTO_REFRESH_INTERVAL_MS}
        />
      </div>
    </div>
  );
}
