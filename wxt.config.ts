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
    description:
      'DevTools で観測したネットワークリクエストとコンソール出力を記録し、後から参照できるようにする',
    // 記録トグル等の設定を chrome.storage.local に永続化する。
    // unlimitedStorage は宣言しない（自動削除が無い現状で上限を自ら管理していないため）。
    // alarms も不要（定期処理を持たない）。debugger は全タブに警告バーが出るうえ、
    // DevTools を開くとデタッチされるため、この拡張機能とは原理的に併用できない。
    //
    // host_permissions も書かない。コンソールの記録はコンテントスクリプトで行うが、
    // 宣言的なコンテントスクリプトは自身の matches で注入されるため、別途ホスト権限を
    // 要求する必要がない（インストール時の警告は matches 由来で出る）。
    // scripting も同じ理由で不要（実行時登録を使っていない）。
    permissions: ['storage'],
    // action キーは popup エントリポイントから WXT が自動生成するため書かない。
    // content_scripts も *.content.ts のエントリポイントから自動生成される。
  },
});
