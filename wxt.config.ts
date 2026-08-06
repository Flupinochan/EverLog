import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  // 本番用コードは src/ 配下のみ。テストは tests/ に置き、ビルド対象から外す。
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  // Tailwind はビルド時に CSS へ展開されるため、拡張機能の CSP には影響しない。
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'EverLog',
    description: 'DevTools で観測したネットワークリクエストを記録し、後から参照できるようにする',
    // 記録トグル等の設定を chrome.storage.local に永続化する。
    // unlimitedStorage は宣言しない（自動削除が無い現状で上限を自ら管理していないため）。
    // alarms も不要（定期処理を持たない）。debugger は全タブに警告バーが出るため使わない。
    permissions: ['storage'],
    // action キーは popup エントリポイントから WXT が自動生成するため書かない。
  },
});
