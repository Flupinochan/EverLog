# CLAUDE.md

## 注意

`README.md` や `CLAUDE.md` は必要に応じて最新化してよいですが、変更した場合は必ずユーザに伝えてください

体裁は既存のフォーマットと統一してください

## プロジェクト概要

Chrome DevToolsのNetworkログ (Request/Response) とConsoleログを永続保存し、後からURL等でフィルタして参照/出力可能にするChrome拡張機能

## アーキテクチャ

```bash
src/                          # 本番用コード
├── entrypoints/
│   ├── devtools/             # Network のキャプチャ → サニタイズ → 保存 の配線、パネル登録
│   ├── console-main.content.ts    # MAIN world で console.* を差し替える
│   ├── console-bridge.content.ts  # ISOLATED world。設定を読み、background へ中継する
│   ├── background.ts         # Service Worker（Console ログの保存）
│   ├── panel/                # 閲覧 UI
│   │   ├── views/            # Network / Console それぞれの配線
│   │   ├── components/       # 表示のみ
│   │   └── hooks/            # データ取得と出力の進行管理
│   └── popup/                # 記録トグル・URL フィルタ・保存状況・全削除
└── lib/
    ├── network-log.ts        # データモデル + HAR → エントリ変換 + URL/MIME パターン判定
    ├── console-log.ts        # データモデル + 引数の直列化・書式指定子・レート制限
    ├── capture.ts            # onRequestFinished 購読・getContent
    ├── sanitize.ts           # ヘッダー許可リスト・トークン除去（両方の入口）
    ├── db.ts                 # IndexedDB（保存・取得・集計・全削除）
    ├── settings.ts           # 設定の型・既定値・chrome.storage の読み書きと購読
    ├── log-source.ts         # 閲覧 UI から見た保存層の入口
    ├── panel-view.ts         # 閲覧 UI の表示ロジック（純粋関数）
    ├── popup-view.ts         # popup の表示ロジック（純粋関数）
    ├── har.ts                # Network エントリ → HAR 1.2 変換（純粋関数）
    └── console-export.ts     # Console エントリ → 出力 JSON 変換（純粋関数）
tests/                        # テストコード
```

## 設計上の制約

- 保存経路は必ずサニタイズ層を通す。`addLog()` / `addConsoleLog()` はサニタイズ済みの型しか
  受け取らないため、素通しの保存は型で塞がれている
- **Network ログの保存を background に置かない。** DevTools ページが IndexedDB を直接開く
- **Console ログの保存は background にしかない。** 記録元のコンテントスクリプトはページの
  オリジンで動くため拡張機能の IndexedDB を開けず、受け皿が他に無いことによる
- `lib/` の各モジュールは Chrome API に依存しない。必要なものは引数で受け取る
  (`console-main.content.ts` は MAIN world で動くため、そこで使う `console-log.ts` は
  DOM にも依存しない)

## 未実装

- 設定編集 UI (記録の ON/OFF と URL フィルタ以外。MIME パターン・ボディサイズ上限・
  Console のレート制限や直列化の上限は変更できない)
- 保持期間や容量上限による自動削除 (件数が出やすい Console 側で先に問題になる見込み)

## 依存関係の追加

- 依存関係の追加 `bun add` は事前に必ず確認を取る
- 「何を・なぜ必要か」「標準機能や自前実装で代替できないか」を提示して判断を仰ぐ

## 開発時の注意

- `chrome.storage` を受け取る引数は `area` と名付ける
- テストは `vitest.config.ts` の `WxtVitest()` で自動 import・パスエイリアスが解決される
- `browser` のモックは `wxt/testing/fake-browser` の `fakeBrowser` を使う
- `db.ts` のスキーマを変えるときは `DB_VERSION` を上げ、`onupgradeneeded` の
  `objectStoreNames.contains()` ガードを崩さない（既存のデータを消さないため）。
  更新の検証は `tests/lib/db-upgrade.test.ts` に置く（接続がキャッシュされるため別ファイルに分ける）
- `typecheck` → `test` → `build` を実行し動作確認をすること

## コマンド

```bash
# 初回
bun install

# 開発 (拡張機能がインストールされたChromeが起動)
bun run dev

# ビルド (.output/chrome-mv3に出力)
bun run build 
```
