/**
 * 拡張機能の設定。`chrome.storage.local` に永続化する（仕様書 CAP-03）。
 *
 * このモジュールは `chrome.storage` を引数で受け取り、自分では `browser` を import
 * しない。キャプチャ層が Chrome API を `startNetworkCapture()` の引数で受け取るのと
 * 同じ理由で、ブラウザなしでテストできる状態を保つため。
 *
 * 設定は DevTools ページ（記録の可否）・popup（操作）・background（バッジ表示）の
 * 3 つのコンテキストから読まれる。値を配るのではなく各自が `storage` を読み、
 * 変更は `watchSettings()` で受け取る。コンテキスト間のメッセージ配線を持たないため、
 * Service Worker の生存期間に依存しない。
 */

/** 保存する設定の全体。 */
export interface Settings {
  /** 記録の ON/OFF（CAP-03） */
  recording: boolean;
}

/**
 * 既定値。記録は ON で始める。
 *
 * 「気づいたときには既にログが流れている」場面を救うのがこの拡張機能の目的であり、
 * 既定で止まっていると目的を果たせないため。
 */
export const DEFAULT_SETTINGS: Settings = { recording: true };

/**
 * `chrome.storage.local` 内のキー。設定は項目ごとに分けず 1 つのオブジェクトで持つ。
 * 分けると読み書きの往復と変更購読が項目数だけ増えるため。
 */
export const SETTINGS_KEY = 'settings';

/** `chrome.storage.local` のうち、設定の読み書きで使う部分。 */
export interface SettingsStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export type SettingsChangeListener = (
  changes: Record<string, { newValue?: unknown; oldValue?: unknown }>,
  areaName: string,
) => void;

/**
 * `chrome.storage` のうち、変更購読で使う部分。
 *
 * エリア個別の `storage.local.onChanged` ではなく `storage.onChanged`（areaName 付き）
 * を使う。前者は対応していない環境があるため。
 */
export interface SettingsChangeSource {
  onChanged: {
    addListener(listener: SettingsChangeListener): void;
    removeListener(listener: SettingsChangeListener): void;
  };
}

/**
 * 保存されていた値を妥当な `Settings` に整える。純粋関数。
 *
 * 未設定・型違い・拡張機能の更新で形が変わった値をすべてここで既定値に寄せる。
 * 設定を読む経路は必ずここを通すため、呼び出し側は欠けたフィールドを気にしなくてよい。
 */
export function normalizeSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };

  const source = raw as Record<string, unknown>;
  return {
    recording:
      typeof source.recording === 'boolean' ? source.recording : DEFAULT_SETTINGS.recording,
  };
}

/**
 * 設定を読む。取得に失敗しても例外にせず既定値を返す。
 *
 * 設定が読めないことを理由に記録やバッジ表示が止まるより、既定値で動いたほうが
 * 実害が小さいため。
 */
export async function loadSettings(storage: SettingsStorageArea): Promise<Settings> {
  try {
    const stored = await storage.get(SETTINGS_KEY);
    return normalizeSettings(stored[SETTINGS_KEY]);
  } catch (error) {
    console.error('[EverLog] failed to load settings', error);
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * 設定の一部を書き換え、確定した全体を返す。
 *
 * 書き込みの失敗は握りつぶさない。UI 側で「切り替えたつもりが切り替わっていない」
 * 状態になるのを避けるため、呼び出し側に伝える。
 */
export async function saveSettings(
  storage: SettingsStorageArea,
  patch: Partial<Settings>,
): Promise<Settings> {
  const current = await loadSettings(storage);
  const next = normalizeSettings({ ...current, ...patch });
  await storage.set({ [SETTINGS_KEY]: next });
  return next;
}

/**
 * 設定の変更を購読する。戻り値を呼ぶと解除する。
 *
 * 自分が書いた変更でも通知が来る。書いた側でも state を戻さず通知で更新すれば、
 * 複数の popup / DevTools ページが同時に開いていても表示が揃う。
 */
export function watchSettings(
  source: SettingsChangeSource,
  onChange: (settings: Settings) => void,
): () => void {
  const listener: SettingsChangeListener = (changes, areaName) => {
    if (areaName !== 'local') return;
    if (!Object.hasOwn(changes, SETTINGS_KEY)) return;
    // 設定ごと削除された場合は newValue が無い。normalizeSettings が既定値に寄せる
    onChange(normalizeSettings(changes[SETTINGS_KEY]?.newValue));
  };

  source.onChanged.addListener(listener);
  return () => {
    source.onChanged.removeListener(listener);
  };
}
