import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// WxtVitest がテスト内で WXT の自動 import・パスエイリアス・browser グローバルを解決する。
// fake-indexeddb/auto は Node 上に indexedDB グローバルを生やす（保存層のテスト用）。
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // テストは tests/ 配下のみ。src/ には本番用コードだけを置く。
    // .tsx も拾う（panel / popup の UI テストが増えたときに黙って
    // スキップされ、それでも緑になるのを防ぐ）。
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['fake-indexeddb/auto'],
  },
});
