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
    // 権限は必要になったフェーズで追加する（保存層で storage / unlimitedStorage / alarms）。
    // debugger 権限は使わない（README 3.2）。
  },
});
