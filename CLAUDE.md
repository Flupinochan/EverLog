# CLAUDE.md

## 注意

`README.md` や `CLAUDE.md` は必要に応じて最新化してください

## プロジェクト概要

Chrome DevTools で観測したネットワークリクエスト／レスポンスを永続化し、後から URL 等でフィルタして参照・出力する Chrome 拡張機能（Manifest V3）。

詳細は仕様書（`README.md`）を参照。

ビルドには WXT を使う。`entrypoints/` 配下のファイル名から manifest が自動生成されるため、`manifest.json` は直接編集しない（権限等は `wxt.config.ts` で宣言する）。

## アーキテクチャ

```
entrypoints/devtools/main.ts（DevTools ページ・配線のみ）
  └─ lib/capture.ts（購読・getContent）
  │    └─ lib/network-log.ts（HAR → エントリ変換・純粋関数）
  └─ lib/sanitize.ts（ヘッダー許可リスト・トークン除去）
       └─ lib/db.ts（IndexedDB 保存・取得）
entrypoints/background.ts（現状なにもしない）
entrypoints/panel/（一覧・フィルタ・詳細表示）
entrypoints/popup/（記録トグル・HAR 出力・設定）
```

**保存に Service Worker を使わない。** DevTools ページは拡張機能のオリジンで動くため同じ IndexedDB を直接開けること、IndexedDB が複数コンテキストからの同時アクセスをトランザクションで直列化すること、サニタイズの集約は型で担保できることによる。Service Worker が唯一必須だった定期パージは要件から外した。Port の配線・メッセージの型定義・Service Worker の終了への耐性がまとめて不要になっている。この判断を覆す場合は README 4 章の検討を読むこと。

**メタデータ（`logs`）とボディ（`bodies`）は別ストアに分ける。** 一覧取得でボディをロードしないための分割であり、統合しない。`queryLogs()` は `bodies` を一切読まない。

### 実装状況

- 実装済み：キャプチャ層（CAP-01 / 02 / 05 / 06 / 07）、サニタイズ層（SAN-01〜05）、保存層（保存・取得・ボディ取得・全削除）。DevTools ページで 3 層が繋がっており、ログは実際に永続化される。
- 未実装：記録トグル（CAP-03）、URL フィルタ（CAP-04）、自動削除（保持期間・容量上限）、UI、HAR 変換。

キャプチャ層は Chrome API を `startNetworkCapture()` の引数で受け取る。ブラウザなしでテストできる構造なので、この注入をやめない。

`addLog()` は `sanitizeEntry()` の戻り値である `SanitizedLogEntry` のみを受け取る。未サニタイズの `NetworkLogEntry` を保存する経路を型で塞ぐためであり、この型の区別をなくさない。

## 設計上の制約（変更しないこと）

- **`chrome.debugger` は使わない。** 全タブに警告バーが出るため `chrome.devtools.network` 方式を採用している。`debugger` 権限を manifest に追加しない。
- **サニタイズは保存層の 1 箇所を必ず通す。** キャプチャ層で個別にサニタイズしない。
- **ヘッダーは許可リスト方式。** 拒否リストにしない（独自認証ヘッダーを取りこぼすため）。`authorization` / `cookie` / `set-cookie` は保存しない。
- **ログを外部送信しない。** 保存先はローカルの IndexedDB のみ。
- **`chrome.devtools.*` はコールバックのみ。** Promise を返さないため、共通の Promise ラッパー経由で呼ぶ。

## 依存関係の追加

- **外部ライブラリ・依存関係を勝手に追加しない。** `dependencies` / `devDependencies` への追加（`bun add` の実行）は、事前に必ず確認を取ること。テスト用・開発用のパッケージも例外ではない。
- 追加が必要だと考えた場合は、インストールせずに「何を・なぜ必要か」「標準機能や自前実装で代替できないか」を提示して判断を仰ぐ。
- 標準 API や自前の薄いラッパーで済むものは、依存を増やさずそちらを選ぶ。

## 開発コマンド

```powershell
bun install
bun run build      # WXT ビルド（出力: .output/chrome-mv3）
bun run typecheck  # tsc --noEmit
bun run test       # Vitest（1 回実行）
bun run test:watch
```

テストは Vitest を使う。`vitest.config.ts` で `WxtVitest()` を有効化しているため、テスト内でも WXT の自動 import・パスエイリアス・`browser` グローバルが解決される。`browser` API のモックが必要な場合は `wxt/testing/fake-browser` の `fakeBrowser` を使う（`@webext-core/fake-browser` は wxt の依存として同梱されている）。

## 動作確認手順

1. `chrome://extensions` を開き、デベロッパーモードを有効化
2. 「パッケージ化されていない拡張機能を読み込む」で `.output/chrome-mv3` を選択
3. 任意のページで DevTools を開く
4. ページをリロードしてリクエストを発生させる（DevTools を開く前のリクエストは記録されない）

閲覧 UI ができるまでは、DevTools ウィンドウを別ウィンドウに切り離し（undock）、DevTools 自身に対して DevTools を開いて（`Ctrl+Shift+I`）、コンソールから確認する。

```js
await everlog.queryLogs()                        // 新しい順に取得（ボディは含まない）
await everlog.queryLogs({ urlIncludes: 'api' })  // 絞り込み
await everlog.getBody(1)                         // ボディを個別取得
await everlog.clearAll()                         // 全削除
```

**DevTools を一度閉じてから開き直しても、閉じる前のログが残っていること**が本拡張機能の目的そのものなので、動作確認では必ずこれを見る。

## コーディング方針

- TypeScript を使用し、`any` を避ける。
- レスポンスボディを扱うコードを変更したときは、`Authorization` ヘッダーと JWT が保存されないことを必ず確認する。
- 一覧取得時にボディをロードしない（詳細表示時に個別取得する）。
