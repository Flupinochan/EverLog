import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// WxtVitest がテスト内で WXT の自動 import・パスエイリアス・browser グローバルを解決する。
export default defineConfig({
  plugins: [WxtVitest()],
});
