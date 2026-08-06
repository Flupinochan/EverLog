# CLAUDE.md

## 注意

`README.md` や `CLAUDE.md` は必要に応じて最新化してください

## プロジェクト概要

Chrome DevTools で観測したネットワークリクエスト／レスポンスを永続化し、後から URL 等でフィルタして参照・出力する Chrome 拡張機能（Manifest V3）。

詳細は仕様書（`README.md`）を参照。

ビルドには WXT を使う。`src/entrypoints/` 配下のファイル名から manifest が自動生成されるため、`manifest.json` は直接編集しない（権限等は `wxt.config.ts` で宣言する）。

## アーキテクチャ

```
src/entrypoints/devtools/main.ts（DevTools ページ・配線とパネル登録のみ）
  └─ src/lib/capture.ts（購読・getContent）
  │    └─ src/lib/network-log.ts（HAR → エントリ変換・純粋関数）
  ├─ src/lib/sanitize.ts（ヘッダー許可リスト・トークン除去）
  │    └─ src/lib/db.ts（IndexedDB 保存・取得）
  └─ src/lib/settings.ts（記録トグルの購読。OFF なら購読自体を外す）
src/entrypoints/background.ts（バッジ表示のみ。保存は担わない）
  └─ src/lib/settings.ts
src/entrypoints/panel/（一覧・フィルタ・詳細表示）
  ├─ App.tsx（フックと表示コンポーネントの接続のみ）
  ├─ components/（表示のみ。props を描くだけ）
  ├─ hooks/（データ取得。LogSource を引数で受け取る）
  └─ src/lib/panel-view.ts（フィルタ組み立て・整形の純粋関数）
       └─ src/lib/log-source.ts（読み取りの LogSource / 全削除の LogAdmin）
src/entrypoints/popup/（記録トグル・保存状況・全削除。HAR 出力と設定編集は未実装）
  ├─ App.tsx（フックと表示コンポーネントの接続のみ）
  ├─ components/（表示のみ。props を描くだけ）
  └─ hooks/（useSettings は chrome.storage、useStorageStats は LogSource を引数で受け取る）
```

**本番用コードは `src/`、テストは `tests/` に分ける。** `wxt.config.ts` の `srcDir: 'src'` によりビルド対象は `src/` 配下だけになり、`vitest.config.ts` の `include` は `tests/**/*.test.ts` だけを拾う。テストファイルを `src/` に置かない（ビルド対象に混ざる）。`tests/` は `src/` のディレクトリ構造をそのまま写す（`src/lib/db.ts` → `tests/lib/db.test.ts`）。

テストから本番用コードを参照するときは相対パスではなく `@/` エイリアスを使う（`@` は `src/` を指す）。

**保存に Service Worker を使わない。** DevTools ページは拡張機能のオリジンで動くため同じ IndexedDB を直接開けること、IndexedDB が複数コンテキストからの同時アクセスをトランザクションで直列化すること、サニタイズの集約は型で担保できることによる。Service Worker が唯一必須だった定期パージは要件から外した。Port の配線・メッセージの型定義・Service Worker の終了への耐性がまとめて不要になっている。この判断を覆す場合は README 4 章の検討を読むこと。`background.ts` が持つのはバッジ表示だけであり、ここにデータの読み書きを足さない。落ちてよく、次に起きたときに設定を読み直して描けばよい状態を保つ。

**コンテキスト間でメッセージを配らない。** DevTools ページ・popup・background は互いに送信せず、それぞれが `chrome.storage` と IndexedDB を直接読む。設定の変更は `watchSettings()`（`storage.onChanged`）で各自が受け取る。この形なので Service Worker の生存期間に依存しない。

**メタデータ（`logs`）とボディ（`bodies`）は別ストアに分ける。** 一覧取得でボディをロードしないための分割であり、統合しない。`queryLogs()` は `bodies` を一切読まない。

### 実装状況

- 実装済み：キャプチャ層（CAP-01 / 02 / 03 / 05 / 06 / 07）、サニタイズ層（SAN-01〜05）、保存層（保存・取得・ボディ取得・集計・全削除）、閲覧 UI（VIEW-01〜04）、popup（記録トグル POP-01・保存状況 POP-05・全削除）。DevTools ページで 3 層が繋がっており、記録されたログはパネルで一覧・絞り込み・詳細表示できる。
- 未実装：URL フィルタ（CAP-04）、HAR 出力（POP-02 / 03・`lib/har.ts`）、設定編集 UI（POP-04）、自動削除（保持期間・容量上限。STO-05）。

キャプチャ層は Chrome API を `startNetworkCapture()` の引数で受け取る。ブラウザなしでテストできる構造なので、この注入をやめない。設定層（`src/lib/settings.ts`）も同じで、`chrome.storage` を引数で受け取り自分では `browser` を import しない。

**記録の停止は購読の解除で行う**（`startNetworkCapture()` の戻り値を呼ぶ）。ハンドラ側で捨てる作りに変えない。記録していない間も `getContent()` を呼んでボディを取りに行くことになるため。加えて保存の直前にも記録状態を確認する（解除前に始まった 1 件が後から届くため）。

**DevTools ページの起動時は、設定を読み終える前から購読を張る。** 設定の読み込みを待ってから購読すると、ページの読み込み中に DevTools を開いた場合に最初の数件を取りこぼす。この間に拾った分は `saveEntry()` が初回読み込みの完了（`settingsReady`）を待ってから可否を判断する。この順序を入れ替えない。

`addLog()` は `sanitizeEntry()` の戻り値である `SanitizedLogEntry` のみを受け取る。未サニタイズの `NetworkLogEntry` を保存する経路を型で塞ぐためであり、この型の区別をなくさない。

### UI（panel / popup）の層分け

**表示・データ取得・ロジックを混ぜない。** 後から Playwright / Storybook を差し込めるようにするための分離であり、まとめない。panel と popup の両方に同じ分け方を適用する。

- `components/` は props を描くだけ。`db.ts` を import しない（型の import は可）。
- データ取得は `hooks/` に閉じる。フックは `LogSource`（`src/lib/log-source.ts`）や `chrome.storage` を引数で受け取り、差し替えれば実物の IndexedDB・storage なしで描画できる。キャプチャ層と同じ注入方針。
- 絞り込み条件の組み立てと整形は `src/lib/panel-view.ts` の純粋関数に置く。テストはここに書く（DOM 環境は未導入）。

**保存層への入口は読み取り（`LogSource`）と破壊的操作（`LogAdmin`）に分ける。** 全削除を持つ popup だけが後者を受け取り、panel は `LogSource` しか知らない。`addLog()` はどちらにも載せない（保存経路はサニタイズ層を通る DevTools ページだけが持つ）。

スタイリングは Tailwind CSS v4。設定ファイルは持たず、各エントリポイントの `style.css` の `@import 'tailwindcss'` と `wxt.config.ts` の Vite プラグイン登録だけで動く。配色は `prefers-color-scheme` に追従させ、`dark:` を当てたときはネイティブ部品用に `color-scheme` も切り替える。

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

**`storage` という名前の変数・引数・props を作らない。** WXT の自動 import が `wxt/utils/storage` を差し込む対象であり、引数で影を作っていても実際に取り込まれてバンドルに載る（約 9KB が background・popup・DevTools の 3 つに乗る。実測で `background.js` が 1.37KB → 10.01KB）。`chrome.storage` を受け取る引数は `area` と名付ける。同じ理由で `browser` / `defineBackground` など WXT が自動 import する名前も避ける。ビルド出力のサイズが不自然に増えたときはこれを疑う。

テストは Vitest を使う。`vitest.config.ts` で `WxtVitest()` を有効化しているため、テスト内でも WXT の自動 import・パスエイリアス・`browser` グローバルが解決される。`browser` API のモックが必要な場合は `wxt/testing/fake-browser` の `fakeBrowser` を使う（`@webext-core/fake-browser` は wxt の依存として同梱されている）。

## CI

`.github/workflows/ci.yml` が `main` への push と全 Pull Request で `bun run typecheck` → `bun run test` → `bun run build` を実行する。ローカルでこの 3 つが通ることを push 前に確認する。CI は依存のインストールに `bun ci`（= `bun install --frozen-lockfile`）を使うため、依存を変更したときは `bun.lock` も必ずコミットする。

**GitHub Actions の Action は commit SHA で固定する。** タグは付け替え可能で上流の乗っ取りがそのまま CI に流れ込むため、`uses:` にタグやブランチを書かない。末尾に `# v7.0.1` のようなバージョンコメントを付け、更新時は `git ls-remote --tags <repo>` で SHA を取り直してコメントも合わせる。`permissions` はワークフロー既定で `contents: read` に絞る。

## 動作確認手順

1. `chrome://extensions` を開き、デベロッパーモードを有効化
2. 「パッケージ化されていない拡張機能を読み込む」で `.output/chrome-mv3` を選択
3. 任意のページで DevTools を開く
4. ページをリロードしてリクエストを発生させる（DevTools を開く前のリクエストは記録されない）
5. DevTools の「EverLog」パネルを開き、一覧・絞り込み・詳細表示を確認する
6. 拡張機能アイコンをクリックして popup を開き、記録トグル・保存件数・概算容量・全削除を確認する

記録トグルを変更したときは **DevTools を開き直さずに**反映されること（OFF でリロードしても増えない、ON に戻すと再開する）と、バッジが追従することを見る。バッジは popup ではなく Service Worker が更新するため、ブラウザを再起動しても状態が残る。

保存層を直接叩きたい場合は、DevTools ウィンドウを別ウィンドウに切り離し（undock）、DevTools 自身に対して DevTools を開いて（`Ctrl+Shift+I`）、コンソールから確認する。

```js
await everlog.queryLogs()                        // 新しい順に取得（ボディは含まない）
await everlog.queryLogs({ urlIncludes: 'api' })  // 絞り込み
await everlog.getBody(1)                         // ボディを個別取得
await everlog.getStats()                         // 件数とボディサイズ合計
await everlog.clearAll()                         // 全削除
```

**DevTools を一度閉じてから開き直しても、閉じる前のログが残っていること**が本拡張機能の目的そのものなので、動作確認では必ずこれを見る。

## コーディング方針

- TypeScript を使用し、`any` を避ける。
- レスポンスボディを扱うコードを変更したときは、`Authorization` ヘッダーと JWT が保存されないことを必ず確認する。
- 一覧取得時にボディをロードしない（詳細表示時に個別取得する）。
