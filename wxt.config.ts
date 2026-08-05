import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'EverLog',
    description: 'DevTools で観測したネットワークリクエストを記録し、後から参照できるようにする',
    // 権限は必要になったフェーズで追加する（保存層で storage / unlimitedStorage / alarms）。
    // debugger 権限は使わない（README 3.2）。
  },
});
