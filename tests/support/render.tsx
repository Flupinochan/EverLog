/**
 * UI テストからの描画。`@testing-library/react` をここ経由で使う。
 *
 * `vitest.config.ts` は `globals: true` を使っていないため、RTL の自動 cleanup が
 * 働かない（グローバルの `afterEach` が無いと登録されない）。このモジュールを
 * import した時点で登録し、テスト側がテストごとの後始末を書かずに済むようにする。
 *
 * グローバルの `setupFiles` ではなくモジュールに寄せているのは、node 環境で動く
 * `tests/lib/` に react-dom を読み込ませないため。
 */

import { cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';

afterEach(cleanup);

export * from '@testing-library/react';
export { userEvent };
