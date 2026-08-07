# CLAUDE.md

## 注意

`README.md` や `CLAUDE.md` は必要に応じて最新化してよいですが、変更した場合は必ずユーザに伝えてください

体裁は既存のフォーマットと統一してください

## プロジェクト概要

Chrome DevToolsのNetworkログ (Request/Response) を永続保存し、後からURL等でフィルタして参照/出力可能にするChrome拡張機能

## アーキテクチャ

```bash
src/                     # 本番用コード
├── entrypoints/
│   ├── devtools/        # キャプチャ → サニタイズ → 保存 の配線、パネル登録
│   ├── background.ts    # Service Worker
│   ├── panel/           # 閲覧 UI（一覧・フィルタ・詳細表示・HAR 出力）
│   └── popup/            # 記録トグル・保存状況・全削除
└── lib/
    ├── network-log.ts   # データモデル + HAR → エントリ変換
    ├── capture.ts        # onRequestFinished 購読・getContent
    ├── sanitize.ts       # ヘッダー許可リスト・トークン除去
    ├── db.ts              # IndexedDB（保存・取得・集計・全削除）
    ├── settings.ts        # 設定の型・既定値・chrome.storage の読み書きと購読
    ├── log-source.ts      # 閲覧 UI から見た保存層の入口
    ├── panel-view.ts      # 閲覧 UI の表示ロジック（純粋関数）
    └── har.ts             # エントリ → HAR 1.2 変換（純粋関数）
tests/                   # テストコード
```

## 未実装

- キャプチャ時の URL 除外フィルタ (機微な API を採取対象から外す。閲覧側の URL フィルタは実装済み)
- 設定編集 UI (記録の ON/OFF 以外。MIME パターンやボディサイズ上限は変更できない)
- 保持期間や容量上限による自動削除

## 依存関係の追加

- 依存関係の追加 `bun add` は事前に必ず確認を取る
- 「何を・なぜ必要か」「標準機能や自前実装で代替できないか」を提示して判断を仰ぐ

## 開発時の注意

- `chrome.storage` を受け取る引数は `area` と名付ける
- テストは `vitest.config.ts` の `WxtVitest()` で自動 import・パスエイリアスが解決される
- `browser` のモックは `wxt/testing/fake-browser` の `fakeBrowser` を使う
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
