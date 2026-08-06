import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  loadSettings,
  normalizeSettings,
  saveSettings,
  watchSettings,
  type SettingsChangeListener,
  type SettingsChangeSource,
  type SettingsStorageArea,
} from '@/lib/settings';

/**
 * `chrome.storage.local` のフェイク。設定層は storage を引数で受け取るため、
 * ブラウザを立ち上げずに読み書きを検証できる。
 */
function createFakeStorage(initial: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { ...initial };
  const storage: SettingsStorageArea = {
    get: async (key) => (Object.hasOwn(data, key) ? { [key]: data[key] } : {}),
    set: async (items) => {
      Object.assign(data, items);
    },
  };
  return { storage, data };
}

/** テストから任意の変更通知を流せる `chrome.storage.onChanged` のフェイク。 */
function createFakeChangeSource() {
  const listeners = new Set<SettingsChangeListener>();
  const source: SettingsChangeSource = {
    onChanged: {
      addListener: (listener) => {
        listeners.add(listener);
      },
      removeListener: (listener) => {
        listeners.delete(listener);
      },
    },
  };
  return {
    source,
    listenerCount: () => listeners.size,
    emit: (changes: Record<string, { newValue?: unknown }>, areaName = 'local') => {
      for (const listener of listeners) listener(changes, areaName);
    },
  };
}

describe('normalizeSettings', () => {
  it('未設定なら既定値を返す', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it('null や配列・プリミティブでも既定値に落とす', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings('recording')).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('保存された値を読み取る', () => {
    expect(normalizeSettings({ recording: false })).toEqual({ recording: false });
  });

  it('型が違うフィールドは既定値で埋める', () => {
    expect(normalizeSettings({ recording: 'false' })).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ recording: 0 })).toEqual(DEFAULT_SETTINGS);
  });

  it('知らないキーは持ち越さない', () => {
    expect(normalizeSettings({ recording: false, legacyOption: 'x' })).toEqual({
      recording: false,
    });
  });

  it('既定値のオブジェクトを共有しない（呼び出し側の変更が漏れない）', () => {
    const first = normalizeSettings(undefined);
    first.recording = false;
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.recording).toBe(true);
  });
});

describe('loadSettings', () => {
  it('保存前は既定値を返す', async () => {
    const { storage } = createFakeStorage();
    await expect(loadSettings(storage)).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('保存済みの値を読む', async () => {
    const { storage } = createFakeStorage({ [SETTINGS_KEY]: { recording: false } });
    await expect(loadSettings(storage)).resolves.toEqual({ recording: false });
  });

  it('取得に失敗しても例外にせず既定値を返す', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const storage: SettingsStorageArea = {
      get: () => Promise.reject(new Error('storage unavailable')),
      set: async () => undefined,
    };

    await expect(loadSettings(storage)).resolves.toEqual(DEFAULT_SETTINGS);
    consoleError.mockRestore();
  });
});

describe('saveSettings', () => {
  it('書き込んだ値を読み戻せる', async () => {
    const { storage } = createFakeStorage();

    await expect(saveSettings(storage, { recording: false })).resolves.toEqual({
      recording: false,
    });
    await expect(loadSettings(storage)).resolves.toEqual({ recording: false });
  });

  it('設定は 1 つのキーにまとめて保存する', async () => {
    const { storage, data } = createFakeStorage();

    await saveSettings(storage, { recording: false });
    expect(Object.keys(data)).toEqual([SETTINGS_KEY]);
    expect(data[SETTINGS_KEY]).toEqual({ recording: false });
  });

  it('空の patch でも保存済みの値を壊さない', async () => {
    const { storage } = createFakeStorage({ [SETTINGS_KEY]: { recording: false } });

    await expect(saveSettings(storage, {})).resolves.toEqual({ recording: false });
  });

  it('書き込みの失敗は呼び出し側に伝える', async () => {
    const storage: SettingsStorageArea = {
      get: async () => ({}),
      set: () => Promise.reject(new Error('quota exceeded')),
    };

    await expect(saveSettings(storage, { recording: false })).rejects.toThrow('quota exceeded');
  });
});

describe('watchSettings', () => {
  it('local の settings 変更を通知する', () => {
    const { source, emit } = createFakeChangeSource();
    const onChange = vi.fn();

    watchSettings(source, onChange);
    emit({ [SETTINGS_KEY]: { newValue: { recording: false } } });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ recording: false });
  });

  it('別のエリア（sync / session）の変更は無視する', () => {
    const { source, emit } = createFakeChangeSource();
    const onChange = vi.fn();

    watchSettings(source, onChange);
    emit({ [SETTINGS_KEY]: { newValue: { recording: false } } }, 'sync');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('別のキーの変更は無視する', () => {
    const { source, emit } = createFakeChangeSource();
    const onChange = vi.fn();

    watchSettings(source, onChange);
    emit({ somethingElse: { newValue: 1 } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('設定が削除されたら既定値を通知する', () => {
    const { source, emit } = createFakeChangeSource();
    const onChange = vi.fn();

    watchSettings(source, onChange);
    emit({ [SETTINGS_KEY]: {} });

    expect(onChange).toHaveBeenCalledWith(DEFAULT_SETTINGS);
  });

  it('壊れた値が入っていても既定値に寄せて通知する', () => {
    const { source, emit } = createFakeChangeSource();
    const onChange = vi.fn();

    watchSettings(source, onChange);
    emit({ [SETTINGS_KEY]: { newValue: { recording: 'no' } } });

    expect(onChange).toHaveBeenCalledWith(DEFAULT_SETTINGS);
  });

  it('戻り値を呼ぶと購読を解除する', () => {
    const { source, emit, listenerCount } = createFakeChangeSource();
    const onChange = vi.fn();

    const stop = watchSettings(source, onChange);
    expect(listenerCount()).toBe(1);

    stop();
    expect(listenerCount()).toBe(0);

    emit({ [SETTINGS_KEY]: { newValue: { recording: false } } });
    expect(onChange).not.toHaveBeenCalled();
  });
});
