# CLAUDE.md

## 注意

`README.md` や `CLAUDE.md` は必要に応じて最新化してください

## プロジェクト概要

Chrome DevTools で観測したネットワークリクエスト／レスポンスを永続化し、後から URL 等でフィルタして参照・出力する Chrome 拡張機能（Manifest V3）。

詳細は仕様書（`network-log-extension-spec.md`）を参照。

## アーキテクチャ

```
devtools.ts（キャプチャ）
  └─ chrome.runtime.connect ─→ background.ts（サニタイズ → IndexedDB 保存 → 定期パージ）
panel.html / panel.ts（一覧・フィルタ・詳細表示）
popup.html / popup.ts（記録トグル・HAR 出力・設定）
```

DevTools ページは拡張機能 API の限られたサブセットしか使えないため、IndexedDB への書き込みは必ず Service Worker 側で行う。

## 設計上の制約（変更しないこと）

- **`chrome.debugger` は使わない。** 全タブに警告バーが出るため `chrome.devtools.network` 方式を採用している。`debugger` 権限を manifest に追加しない。
- **サニタイズは保存層の 1 箇所を必ず通す。** キャプチャ層で個別にサニタイズしない。
- **ヘッダーは許可リスト方式。** 拒否リストにしない（独自認証ヘッダーを取りこぼすため）。`authorization` / `cookie` / `set-cookie` は保存しない。
- **ログを外部送信しない。** 保存先はローカルの IndexedDB のみ。
- **`chrome.devtools.*` はコールバックのみ。** Promise を返さないため、共通の Promise ラッパー経由で呼ぶ。

## 開発コマンド

```powershell
bun install
bun run build
bun run typecheck
bun run test
```

## 動作確認手順

1. `chrome://extensions` を開き、デベロッパーモードを有効化
2. 「パッケージ化されていない拡張機能を読み込む」でビルド出力ディレクトリを選択
3. 任意のページで DevTools を開き、パネルタブから記録状態を確認
4. ページをリロードしてリクエストを発生させる（DevTools を開く前のリクエストは記録されない）

## コーディング方針

- TypeScript を使用し、`any` を避ける。
- レスポンスボディを扱うコードを変更したときは、`Authorization` ヘッダーと JWT が保存されないことを必ず確認する。
- 一覧取得時にボディをロードしない（詳細表示時に個別取得する）。
