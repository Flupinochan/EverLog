# EverLog

Chrome DevToolsのNetworkログ (Request/Response) を永続保存し、後からURL等でフィルタして参照/出力可能にするChrome拡張機能

## なぜ作ったか

Chrome DevToolsのNetwork PanelのログはDevToolsを閉じると消えるため

## 主な機能

- Network Request/Responseの自動保存 (Chrome DevToolsを開いている場合のみ)
- Authorization/Cookie/Set-Cookie等の機密情報を破棄するサニタイズ
- キャプチャ時のURLフィルタ (ワイルドカード`*`で指定。機微なAPIを記録対象から外す`除外`と、対象を絞る`限定`の2モード)
- HAR形式でのログ出力 (Chrome DevToolsのNetwork Panelに読み込み直せる)
- popupでの記録ON/OFF・URLフィルタ設定・ログ容量の表示・全削除

## 使い方

Chrome DevTools を閉じてから開き直しても、閉じる前のログが残っていることを確認

1. 任意のページでChrome DevToolsを開く
2. ページをリロードしてリクエストを発生させる
3. Chrome DevTools の `EverLog` パネルを開く
4. URL等で絞り込み、`HAR 出力` で該当する全件をHARファイルとして保存 (表示中の件数ではない)
5. 拡張機能アイコンをクリックしてpopupを開き、記録のON/OFFやURLフィルタを設定 (フィルタは以降のリクエストにのみ効き、保存済みのログは消えない)

## その他

コマンドやアーキテクチャは `CLAUDE.md` を参照すること

## Consoleログ対応の検討 (未実装)

Consoleログも同様に永続保存/ダウンロードする場合の、Networkログとの違い

DevTools拡張のAPIにはconsoleを購読する口が無いため (`chrome.devtools.network.onRequestFinished` に相当するものが無い)、MAIN worldのコンテントスクリプトで `console.*` を差し替える方式を前提とする

### キャプチャ〜保存

| | Networkログ (既存) | Consoleログ (未実装) |
|---|---|---|
| 取得元 | `chrome.devtools.network.onRequestFinished` | ページの `console.*` をMAIN worldで差し替え + `window.onerror` / `unhandledrejection` |
| 配線 | DevToolsページ → sanitize → IndexedDB (直接) | MAIN world → CustomEvent → ISOLATED world → `runtime.sendMessage` → background → sanitize → IndexedDB |
| 記録できる条件 | Chrome DevToolsを開いている間だけ (DevToolsページが消えると購読も消える) | Chrome DevToolsを閉じていても記録できる (コンテントスクリプトはタブに常駐) |
| 必要な権限 | `storage` のみ | `storage` + `scripting` + `optional_host_permissions: ['<all_urls>']`。インストール時の警告は出さず、popupでONにした時だけ権限ダイアログを出す |
| 記録のON/OFF | `settings.recording`。OFFでリスナーごと外す | `settings.consoleRecording` (新規)。OFFで `unregisterContentScripts` |
| 取得の完全性 | Chrome DevToolsが見たものと同一 | ページscriptの呼び出しのみ。ブラウザ生成メッセージ (リソース読み込み失敗・CSP違反・非推奨警告) は拾えない |
| 取りこぼす場面 | Chrome DevToolsを開く前のリクエスト | 権限の許可前/スクリプトの登録前に読み込まれていたタブ (リロードが要る) |
| tabIdの出所 | `devtools.inspectedWindow.tabId` | background側の `sender.tab.id` |
| pageUrlの出所 | `inspectedWindow.eval('location.href')` + `onNavigated` | コンテントスクリプトの `location.href` (iframeごとに正しい値) |
| 1件の中身 | `ts` / `tabId` / `pageUrl` / `url` / `method` / `status` / `mimeType` / `timeMs` / 両ヘッダー / `body` / `bodySize` / `bodyStatus` | `ts` / `tabId` / `pageUrl` / `level` / `text` / `args[]` / `source` (`url:line:col`) / `stack` / `argsStatus` |
| 重い部分の扱い | ボディを別ストア (`bodies`) へ分離。`queryLogs()` は触らない | 引数プレビューはメタデータに同梱 (1件が小さいため分離しない)。上限で切り詰め、理由を `argsStatus` に残す |
| 量の抑え方 | MIMEパターン + `maxBodyBytes` (1MB) | 深さ・文字数の上限 + レート制限 (暴走ログ対策。打ち切りは「n件省略」マーカーで残す) |
| 直列化の難所 | 無し (`getContent()` が文字列を返す) | MAIN world側で完結させる必要がある。循環参照・DOMノード・関数はstructured cloneを通らず、オブジェクトは後から変化するため呼び出し時点でスナップショットする |
| サニタイズ | `sanitizeEntry()` (ヘッダー許可リスト + URL/ボディのトークン除去) | `sanitizeBody()` を `text` / `args` に、`sanitizeUrl()` を `pageUrl` / `source` に流用。ヘッダーが無いため許可リストは不要 |
| キャプチャ時のURLフィルタ | `shouldCaptureUrl()` をリクエストURLに適用 | 同じ関数をpageUrlに適用 (consoleにリクエストURLが無いため意味が変わる) |
| 保存ストア | `logs` + `bodies` | `consoleLogs` (`ts` / `tabId` / `level` インデックス) を追加し、`DB_VERSION` を2へ |
| 保存に失敗した場合 | 1件だけ捨てて記録は継続 | 同じ。ただしその `console.error` 自身を拾わない再入ガードが要る |

### 閲覧・出力

| | Networkログ (既存) | Consoleログ (未実装) |
|---|---|---|
| 一覧の並び | `ts` インデックスの降順 | 同じ |
| 絞り込み | 期間/タブ/ホスト/URL部分一致/メソッド/ステータス | 期間/タブ/レベル/メッセージ部分一致/pageUrl部分一致 |
| 一覧で重い値を読むか | 読まない (ボディは選択時に `getBody()`) | 読む (1件が小さいため分離しない) |
| 出力形式 | HAR 1.2 (Chrome DevToolsのNetwork Panelに読み戻せる) | HARに居場所が無いため独自のJSON (`everlog-console-<ts>.json`)。1ファイルに寄せる場合はHARの拡張規約に従い `log._console` に載せる手もある |
| 出力の実装 | `lib/har.ts` (純粋関数) + `useHarExport` + `downloadText()` | `lib/console-export.ts` + 同型のフック。`downloadText()` はそのまま再利用 |
| 出力規模の確認 | `EXPORT_CONFIRM_BYTES` / `EXPORT_MAX_BYTES` で確認・拒否 | 同じ仕組みを流用 |
| popupの保存状況 | 件数 + ボディ合計バイト | 件数 + テキスト合計バイトを別行で表示 |
| 全削除 | `clearAll()` | 同じトランザクションで `consoleLogs` も消す |

### 変わらないもの

- 保存の入口は必ずサニタイズ層を通す (型で素通しを塞ぐ設計をconsole側にも同じ形で作る)
- 設定は `chrome.storage.local` の1オブジェクトに持ち、変更は `watchSettings()` で各コンテキストが受け取る
- 保持期間や容量上限による自動削除はどちらも未実装 (件数が出やすいconsole側で先に問題になる見込み)
