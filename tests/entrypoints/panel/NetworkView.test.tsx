// @vitest-environment jsdom

/**
 * Network タブの配線。フックと表示コンポーネントの繋ぎ方だけを見る。
 *
 * 条件の解釈（`buildFilter()`）や HAR の中身（`buildHar()`）は `tests/lib/` が見ており、
 * ここで確かめるのは「どの条件で・どの順に呼ぶか」に絞る。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogFilter } from '@/lib/db';
import { EXPORT_CONFIRM_BYTES } from '@/lib/panel-view';
import { NetworkView } from '@/entrypoints/panel/views/NetworkView';
import { createFakeLogSource, type FakeLogSource } from '../../support/fakes';
import { storedLog } from '../../support/fixtures';
import { render, screen, userEvent, waitFor } from '../../support/render';

// ファイルの書き出しは DOM と Blob の副作用しか無く、jsdom には `URL.createObjectURL`
// も無い。出力まで届いたかどうかだけ見たいので、ここで差し替える。
vi.mock('@/entrypoints/panel/download', () => ({
  downloadText: vi.fn(),
}));
const { downloadText } = await import('@/entrypoints/panel/download');

/** 自動更新が絡まないよう十分に長い間隔を渡す。 */
const NO_AUTO_REFRESH_MS = 60_000;

function renderView(source: FakeLogSource) {
  return render(
    <NetworkView
      source={source}
      tabId={7}
      version="1.2.3"
      active
      refreshIntervalMs={NO_AUTO_REFRESH_MS}
    />,
  );
}

/** 一覧の取得。`limit` を積むのは一覧側だけ。 */
function listFilters(source: FakeLogSource): LogFilter[] {
  return source.queryLogs.mock.calls.map(([filter]) => filter).filter((f) => f.limit !== undefined);
}

/** 出力の取得。表示の上限を渡さない（条件に一致する全件を出すため）。 */
function exportFilters(source: FakeLogSource): LogFilter[] {
  return source.queryLogs.mock.calls.map(([filter]) => filter).filter((f) => f.limit === undefined);
}

/** 初回の一覧取得が終わるまで待つ。 */
async function waitForFirstLoad(source: FakeLogSource) {
  await waitFor(() => expect(source.queryLogs).toHaveBeenCalled());
  await screen.findByText(/件表示中/);
}

beforeEach(() => {
  vi.mocked(downloadText).mockClear();
});

describe('NetworkView', () => {
  it('入力しただけでは問い合わせず、適用で条件を反映する', async () => {
    const user = userEvent.setup();
    const source = createFakeLogSource({ logs: [storedLog()] });
    renderView(source);
    await waitForFirstLoad(source);

    await user.type(screen.getByPlaceholderText('URL に含まれる文字列'), 'users');
    expect(listFilters(source)).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '適用' }));

    await waitFor(() => expect(listFilters(source)).toHaveLength(2));
    expect(listFilters(source)[1]).toMatchObject({ urlIncludes: 'users' });
  });

  it('クリアで入力欄と問い合わせ条件を空に戻す', async () => {
    const user = userEvent.setup();
    const source = createFakeLogSource({ logs: [storedLog()] });
    renderView(source);
    await waitForFirstLoad(source);

    const urlInput = screen.getByPlaceholderText('URL に含まれる文字列');
    await user.type(urlInput, 'users');
    await user.click(screen.getByRole('button', { name: '適用' }));
    await waitFor(() => expect(listFilters(source)).toHaveLength(2));

    await user.click(screen.getByRole('button', { name: 'クリア' }));

    expect((urlInput as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(listFilters(source)).toHaveLength(3));
    expect(listFilters(source)[2]).toEqual({ limit: 201 });
  });

  it('出力は適用を押していなくても入力欄の内容を条件にする', async () => {
    const user = userEvent.setup();
    const source = createFakeLogSource({ logs: [storedLog()] });
    renderView(source);
    await waitForFirstLoad(source);

    // 「絞り込んだつもり」で出力を押す。適用を経ていない入力欄の内容で出す
    await user.type(screen.getByPlaceholderText('URL に含まれる文字列'), 'users');
    await user.click(screen.getByRole('button', { name: 'HAR 出力' }));

    await waitFor(() => expect(exportFilters(source)).toHaveLength(1));
    expect(exportFilters(source)[0]).toEqual({ urlIncludes: 'users' });
    await waitFor(() => expect(downloadText).toHaveBeenCalledTimes(1));
  });

  it('出力を押したら一覧の表示条件も同じ条件に揃える', async () => {
    const user = userEvent.setup();
    const source = createFakeLogSource({ logs: [storedLog()] });
    renderView(source);
    await waitForFirstLoad(source);

    await user.type(screen.getByPlaceholderText('URL に含まれる文字列'), 'users');
    await user.click(screen.getByRole('button', { name: 'HAR 出力' }));

    await waitFor(() => expect(listFilters(source)).toHaveLength(2));
    expect(listFilters(source)[1]).toMatchObject({ urlIncludes: 'users' });
  });

  it('タブを絞る指定は検査中のタブ ID を条件に載せる', async () => {
    const user = userEvent.setup();
    const source = createFakeLogSource({ logs: [storedLog()] });
    renderView(source);
    await waitForFirstLoad(source);

    await user.click(screen.getByRole('checkbox', { name: 'このタブのみ' }));
    await user.click(screen.getByRole('button', { name: '適用' }));

    await waitFor(() => expect(listFilters(source)).toHaveLength(2));
    expect(listFilters(source)[1]).toMatchObject({ tabId: 7 });
  });

  it('規模が大きい出力は確認を挟んでから書き出す', async () => {
    const user = userEvent.setup();
    const source = createFakeLogSource({
      logs: [storedLog({ bodySize: EXPORT_CONFIRM_BYTES + 1, bodyStatus: 'stored' })],
    });
    renderView(source);
    await waitForFirstLoad(source);

    await user.click(screen.getByRole('button', { name: 'HAR 出力' }));

    expect(await screen.findByText(/を出力します。よろしいですか？/)).not.toBeNull();
    expect(downloadText).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '出力する' }));

    await waitFor(() => expect(downloadText).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/よろしいですか？/)).toBeNull();
  });

  it('確認をやめれば書き出さない', async () => {
    const user = userEvent.setup();
    const source = createFakeLogSource({
      logs: [storedLog({ bodySize: EXPORT_CONFIRM_BYTES + 1, bodyStatus: 'stored' })],
    });
    renderView(source);
    await waitForFirstLoad(source);

    await user.click(screen.getByRole('button', { name: 'HAR 出力' }));
    await screen.findByText(/よろしいですか？/);
    await user.click(screen.getByRole('button', { name: 'やめる' }));

    expect(screen.queryByText(/よろしいですか？/)).toBeNull();
    expect(downloadText).not.toHaveBeenCalled();
  });

  it('条件を変えたら確認待ちの出力を取り消す（古い条件のまま出さないため）', async () => {
    const user = userEvent.setup();
    const source = createFakeLogSource({
      logs: [storedLog({ bodySize: EXPORT_CONFIRM_BYTES + 1, bodyStatus: 'stored' })],
    });
    renderView(source);
    await waitForFirstLoad(source);

    await user.click(screen.getByRole('button', { name: 'HAR 出力' }));
    await screen.findByText(/よろしいですか？/);

    await user.type(screen.getByPlaceholderText('URL に含まれる文字列'), 'users');
    await user.click(screen.getByRole('button', { name: '適用' }));

    await waitFor(() => expect(screen.queryByText(/よろしいですか？/)).toBeNull());
    expect(downloadText).not.toHaveBeenCalled();
  });

  it('一致するログが無ければ出力せずに理由を出す', async () => {
    const user = userEvent.setup();
    const source = createFakeLogSource({ logs: [] });
    renderView(source);
    await waitForFirstLoad(source);

    await user.click(screen.getByRole('button', { name: 'HAR 出力' }));

    expect(await screen.findByText('出力できませんでした: 条件に一致するログがありません')).not.toBeNull();
    expect(downloadText).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByText(/出力できませんでした/)).toBeNull();
  });

  it('読み込みに失敗したら理由を出す', async () => {
    const source = createFakeLogSource();
    source.queryLogs.mockRejectedValue(new Error('database closed'));
    renderView(source);

    expect(await screen.findByText('読み込みに失敗しました: database closed')).not.toBeNull();
  });
});
