# EverLog

Chrome DevToolsのNetworkログ (Request/Response) を永続保存し、後からURL等でフィルタして参照/出力可能にするChrome拡張機能

## なぜ作ったか

Chrome DevToolsのNetwork PanelのログはDevToolsを閉じると消えるため

## 主な機能

- Network Request/Responseの自動保存 (Chrome DevToolsを開いている場合のみ)
- Authorization/Cookie/Set-Cookie等の機密情報を破棄するサニタイズ
- HAR形式でのログ出力 (Chrome DevToolsのNetwork Panelに読み込み直せる)
- popupでの設定ON/OFF・ログ容量の表示・全削除

## 使い方

Chrome DevTools を閉じてから開き直しても、閉じる前のログが残っていることを確認

1. 任意のページでChrome DevToolsを開く
2. ページをリロードしてリクエストを発生させる
3. Chrome DevTools の `EverLog` パネルを開く
4. URL等で絞り込み、`HAR 出力` で該当する全件をHARファイルとして保存 (表示中の件数ではない)
5. 拡張機能アイコンをクリックしてpopupを開く

## その他

コマンドやアーキテクチャは `CLAUDE.md` を参照すること
