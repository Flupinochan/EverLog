// @vitest-environment jsdom

/**
 * 一覧の表示コンポーネント。props を描くだけなので、データ取得なしで動かせる。
 */

import { describe, expect, it, vi } from 'vitest';
import { LogTable } from '@/entrypoints/panel/components/LogTable';
import { render, screen, userEvent, within } from '../../support/render';
import { storedLog } from '../../support/fixtures';

/** 見出し行を除いたデータ行。 */
function bodyRows(): HTMLElement[] {
  const [, ...rows] = screen.getAllByRole('row');
  return rows;
}

/** 行のステータス列（時刻・メソッドに続く 3 列目）。 */
function statusCell(rowIndex: number): HTMLElement {
  const row = bodyRows()[rowIndex] as HTMLElement;
  return within(row).getAllByRole('cell')[2] as HTMLElement;
}

describe('LogTable', () => {
  it('読み込み中は記録が無いことを断定しない', () => {
    render(<LogTable logs={[]} selectedId={null} onSelect={vi.fn()} loading />);

    expect(screen.getByText('読み込み中…')).not.toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('読み込み後に 0 件なら記録の取り方を案内する', () => {
    render(<LogTable logs={[]} selectedId={null} onSelect={vi.fn()} loading={false} />);

    expect(screen.getByText(/記録がありません/)).not.toBeNull();
  });

  it('渡された順のまま 1 件 1 行で描く', () => {
    const logs = [
      storedLog({ url: 'https://api.example.com/users', method: 'GET' }, 1),
      storedLog({ url: 'https://api.example.com/items?page=2', method: 'POST' }, 2),
    ];

    render(<LogTable logs={logs} selectedId={null} onSelect={vi.fn()} loading={false} />);

    const rows = bodyRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('GET');
    expect(rows[0]?.textContent).toContain('api.example.com/users');
    expect(rows[1]?.textContent).toContain('POST');
    // クエリ文字列も残す（同じパスへの別条件を見分けられるようにするため）
    expect(rows[1]?.textContent).toContain('/items?page=2');
  });

  it('ステータス 0 はコードとして出さない（レスポンスが返らなかったため）', () => {
    const logs = [storedLog({ status: 0 }, 1), storedLog({ status: 404 }, 2)];

    render(<LogTable logs={logs} selectedId={null} onSelect={vi.fn()} loading={false} />);

    // 行全体ではなくステータス列だけを見る（時刻にも数字が出るため）
    expect(statusCell(0).textContent).toBe('-');
    expect(statusCell(1).textContent).toBe('404');
  });

  it('URL 全体はホバーで読めるようにしておく（一覧では省略されるため）', () => {
    const url = 'https://api.example.com/very/long/path/that/gets/truncated?page=2';
    render(
      <LogTable logs={[storedLog({ url }, 1)]} selectedId={null} onSelect={vi.fn()} loading={false} />,
    );

    expect(screen.getByTitle(url)).not.toBeNull();
  });

  it('行を押すとそのログを渡す', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const logs = [storedLog({}, 1), storedLog({ url: 'https://api.example.com/items' }, 2)];

    render(<LogTable logs={logs} selectedId={null} onSelect={onSelect} loading={false} />);
    await user.click(bodyRows()[1] as HTMLElement);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(logs[1]);
  });
});
