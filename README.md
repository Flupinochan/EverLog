# EverLog

Chrome DevToolsのNetworkログ (Request/Response) を永続保存し、後からURL等でフィルタして参照/出力可能にするChrome拡張機能

## なぜ作ったか

Chrome DevToolsのNetwork PanelのログはDevToolsを閉じると消えるため

## 主な機能

- Network Request/Responseの自動保存 (Chrome DevToolsを開いている場合のみ)
- Authorization/Cookie/Set-Cookie等の機密情報を破棄するサニタイズ
- ログ出力
- popupでの設定ON/OFF・ログ容量の表示・全削除

## 使い方

Chrome DevTools を閉じてから開き直しても、閉じる前のログが残っていることを確認

1. 任意のページでChrome DevToolsを開く
2. ページをリロードしてリクエストを発生させる
3. Chrome DevTools の `EverLog` パネルを開く
4. 拡張機能アイコンをクリックしてpopupを開く

## その他

コマンドやアーキテクチャは `CLAUDE.md` を参照すること
