// @vitest-environment jsdom

/**
 * popup の配線。設定の保存と保存済みログの削除の段取りを見る。
 *
 * 文言の組み立て（`describeNetworkRecording()` など）と入力欄の解釈
 * （`parsePatternLines()`）は `tests/lib/popup-view.test.ts` が持つ。
 */

import { describe, expect, it } from 'vitest';
import { SETTINGS_KEY } from '@/lib/settings';
import { App } from '@/entrypoints/popup/App';
import {
  createFakeLogAdmin,
  createFakeLogSource,
  createFakeSettingsStorage,
} from '../../support/fakes';
import { render, screen, userEvent, waitFor } from '../../support/render';

/** 削除ボタンが押せるように、保存済みのログがある状態を既定にする。 */
function statsWith(count = 3, consoleCount = 5) {
  return { count, bodyBytes: 1024, consoleCount, consoleBytes: 256 };
}

function renderPopup(
  options: {
    stored?: Record<string, unknown>;
    source?: ReturnType<typeof createFakeLogSource>;
    admin?: ReturnType<typeof createFakeLogAdmin>;
  } = {},
) {
  const source = options.source ?? createFakeLogSource({ stats: statsWith() });
  const admin = options.admin ?? createFakeLogAdmin();
  const storage = createFakeSettingsStorage(options.stored);

  render(<App source={source} admin={admin} area={storage.area} changes={storage.changes} />);

  return { source, admin, storage };
}

/** 設定の読み込みが終わる（操作できるようになる）まで待つ。 */
async function waitForSettings() {
  const toggle = await screen.findByRole('checkbox', { name: /ネットワーク/ });
  await waitFor(() => expect((toggle as HTMLInputElement).disabled).toBe(false));
  return toggle;
}

describe('popup App', () => {
  it('記録トグルの切り替えを保存し、保存された値で表示を更新する', async () => {
    const user = userEvent.setup();
    const { storage } = renderPopup();
    const toggle = await waitForSettings();

    await user.click(toggle);

    await waitFor(() =>
      expect(storage.data[SETTINGS_KEY]).toMatchObject({ recording: false, consoleRecording: true }),
    );
    expect(await screen.findByText('ネットワークの記録を停止中')).not.toBeNull();
  });

  it('ネットワークとコンソールの記録は別々に切り替える', async () => {
    const user = userEvent.setup();
    const { storage } = renderPopup();
    await waitForSettings();

    await user.click(screen.getByRole('checkbox', { name: /コンソール/ }));

    await waitFor(() =>
      expect(storage.data[SETTINGS_KEY]).toMatchObject({ recording: true, consoleRecording: false }),
    );
  });

  it('別の popup や外部からの設定変更に追従する', async () => {
    const { storage } = renderPopup();
    await waitForSettings();

    storage.emit({ [SETTINGS_KEY]: { newValue: { recording: false, consoleRecording: true } } });

    expect(await screen.findByText('ネットワークの記録を停止中')).not.toBeNull();
  });

  it('URL パターンは適用したときだけ保存し、保存できたら下書きを手放す', async () => {
    const user = userEvent.setup();
    const { storage } = renderPopup();
    await waitForSettings();

    const textarea = screen.getByRole('textbox');
    // 空行と重複を混ぜる。保存されるのは畳んだ結果
    await user.type(textarea, '*/oauth/*\n\n*/oauth/*\n/token ');
    expect(storage.data[SETTINGS_KEY]).toBeUndefined();

    await user.click(screen.getByRole('button', { name: '適用' }));

    await waitFor(() =>
      expect(storage.data[SETTINGS_KEY]).toMatchObject({
        urlFilter: { mode: 'deny', patterns: ['*/oauth/*', '/token'] },
      }),
    );
    // 下書きを手放したので、入力欄には保存された（正規化済みの）値が出る
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('*/oauth/*\n/token'));
    expect(screen.queryByText('未保存の変更があります')).toBeNull();
  });

  it('保存に失敗したら入力内容を残したまま理由を出す', async () => {
    const user = userEvent.setup();
    const source = createFakeLogSource({ stats: statsWith() });
    const admin = createFakeLogAdmin();
    const storage = createFakeSettingsStorage();
    const failing = {
      get: storage.area.get,
      set: () => Promise.reject(new Error('quota exceeded')),
    };

    render(<App source={source} admin={admin} area={failing} changes={storage.changes} />);
    await waitForSettings();

    const textarea = screen.getByRole('textbox');
    await user.type(textarea, '*/oauth/*');
    await user.click(screen.getByRole('button', { name: '適用' }));

    expect(await screen.findByText('設定を保存できませんでした: quota exceeded')).not.toBeNull();
    expect((textarea as HTMLTextAreaElement).value).toBe('*/oauth/*');
    expect(screen.getByText('未保存の変更があります')).not.toBeNull();
  });

  it('取り消しで編集中の内容を捨てて保存済みの値に戻す', async () => {
    const user = userEvent.setup();
    renderPopup({ stored: { [SETTINGS_KEY]: { urlFilter: { mode: 'deny', patterns: ['/a'] } } } });
    await waitForSettings();

    const textarea = screen.getByRole('textbox');
    await waitFor(() => expect((textarea as HTMLTextAreaElement).value).toBe('/a'));

    await user.type(textarea, '\n/b');
    await user.click(screen.getByRole('button', { name: '取り消し' }));

    expect((textarea as HTMLTextAreaElement).value).toBe('/a');
  });

  it('全削除は 2 回押させる（押し間違いで消さないため）', async () => {
    const user = userEvent.setup();
    const { admin } = renderPopup();
    await waitForSettings();

    await user.click(await screen.findByRole('button', { name: 'すべて削除' }));

    expect(admin.clearAll).not.toHaveBeenCalled();
    expect(screen.getByText(/元に戻せません/)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: '本当に削除する' }));

    await waitFor(() => expect(admin.clearAll).toHaveBeenCalledTimes(1));
  });

  it('削除後に保存状況を取り直す', async () => {
    const user = userEvent.setup();
    const { admin, source } = renderPopup();
    await waitForSettings();
    await waitFor(() => expect(source.getStats).toHaveBeenCalledTimes(1));

    await user.click(await screen.findByRole('button', { name: 'すべて削除' }));
    await user.click(screen.getByRole('button', { name: '本当に削除する' }));

    await waitFor(() => expect(admin.clearAll).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(source.getStats).toHaveBeenCalledTimes(2));
  });

  it('確認をやめれば削除しない', async () => {
    const user = userEvent.setup();
    const { admin } = renderPopup();
    await waitForSettings();

    await user.click(await screen.findByRole('button', { name: 'すべて削除' }));
    await user.click(screen.getByRole('button', { name: 'やめる' }));

    expect(admin.clearAll).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'すべて削除' })).not.toBeNull();
  });

  it('削除に失敗したら理由を出し、確認待ちを解く', async () => {
    const user = userEvent.setup();
    const admin = createFakeLogAdmin();
    admin.clearAll.mockRejectedValueOnce(new Error('database closed'));
    renderPopup({ admin });
    await waitForSettings();

    await user.click(await screen.findByRole('button', { name: 'すべて削除' }));
    await user.click(screen.getByRole('button', { name: '本当に削除する' }));

    expect(await screen.findByText('削除に失敗しました: database closed')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'すべて削除' })).not.toBeNull();
  });

  it('保存済みが 0 件なら削除ボタンを押せない', async () => {
    const source = createFakeLogSource({ stats: statsWith(0, 0) });
    renderPopup({ source });
    await waitForSettings();

    const button = await screen.findByRole('button', { name: 'すべて削除' });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
  });

  it('保存状況の読み込みに失敗したら理由を出す', async () => {
    const source = createFakeLogSource();
    source.getStats.mockRejectedValue(new Error('database closed'));
    renderPopup({ source });

    expect(await screen.findByText('読み込みに失敗しました: database closed')).not.toBeNull();
  });
});
