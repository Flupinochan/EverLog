# EverLog

Chrome DevToolsのNetworkログ (Request/Response) とConsoleログを永続保存し、後からURL等でフィルタして参照/出力可能にするChrome拡張機能

## なぜ作ったか

Chrome DevToolsのNetwork PanelとConsoleのログはDevToolsを閉じると消えるため

## 主な機能

- Network Request/Responseの自動保存 (Chrome DevToolsを開いている場合のみ)
- Consoleログの自動保存 (Chrome DevToolsを閉じていても記録される)
- Authorization/Cookie/Set-Cookie等の機密情報を破棄するサニタイズ
- キャプチャ時のURLフィルタ (ワイルドカード`*`で指定。機微なAPIを記録対象から外す`除外`と、対象を絞る`限定`の2モード)
- HAR形式でのNetworkログ出力 (Chrome DevToolsのNetwork Panelに読み込み直せる)
- JSON形式でのConsoleログ出力
- popupでの記録ON/OFF (NetworkとConsoleで個別)・URLフィルタ設定・ログ容量の表示・全削除

## 使い方

Chrome DevTools を閉じてから開き直しても、閉じる前のログが残っていることを確認

1. 任意のページでChrome DevToolsを開く
2. ページをリロードしてリクエストとConsole出力を発生させる
3. Chrome DevTools の `EverLog` パネルを開き、`Network` / `Console` のタブを切り替える
4. URL・本文・レベル等で絞り込み、`HAR 出力` / `Console 出力` で該当する全件をファイルとして保存 (表示中の件数ではない)
5. 拡張機能アイコンをクリックしてpopupを開き、記録のON/OFFやURLフィルタを設定 (フィルタは以降の記録にのみ効き、保存済みのログは消えない)

Consoleログはコンテントスクリプトが差し込まれた後の出力から記録される。拡張機能をインストール/更新した直後に開いていたタブは、リロードするまで記録されない

## その他

コマンドやアーキテクチャは `CLAUDE.md` を参照すること

## NetworkログとConsoleログの違い

DevTools拡張のAPIにはconsoleを購読する口が無い (`chrome.devtools.network.onRequestFinished` に相当するものが無く、`chrome.debugger` はDevToolsを開くとデタッチされるため併用できない)。そのためConsoleログはMAIN worldのコンテントスクリプトで `console.*` を差し替えて記録しており、Networkログとは性質がかなり異なる

### キャプチャ〜保存

| | Networkログ | Consoleログ |
|---|---|---|
| 取得元 | `chrome.devtools.network.onRequestFinished` | ページの `console.*` をMAIN worldで差し替え + `window.onerror` / `unhandledrejection` |
| 配線 | DevToolsページ → sanitize → IndexedDB (直接) | MAIN world → CustomEvent → ISOLATED world → `runtime.sendMessage` → background → sanitize → IndexedDB |
| 記録できる条件 | Chrome DevToolsを開いている間だけ (DevToolsページが消えると購読も消える) | Chrome DevToolsを閉じていても記録できる (コンテントスクリプトはタブに常駐) |
| 記録のON/OFF | `settings.recording`。OFFでリスナーごと外す | `settings.consoleRecording`。OFFでMAIN world側の直列化ごと止める |
| 取得の完全性 | Chrome DevToolsが見たものと同一 | ページscriptの呼び出しのみ。ブラウザ生成メッセージ (リソース読み込み失敗・CSP違反・非推奨警告) は拾えない |
| 取りこぼす場面 | Chrome DevToolsを開く前のリクエスト | コンテントスクリプトが差し込まれる前に読み込まれていたタブ (リロードが要る) |
| tabIdの出所 | `devtools.inspectedWindow.tabId` | background側の `sender.tab.id` |
| pageUrlの出所 | `inspectedWindow.eval('location.href')` + `onNavigated` | コンテントスクリプトの `location.href` (iframeごとに正しい値) |
| 1件の中身 | `ts` / `tabId` / `pageUrl` / `url` / `method` / `status` / `mimeType` / `timeMs` / 両ヘッダー / `body` / `bodySize` / `bodyStatus` | `ts` / `tabId` / `pageUrl` / `level` / `text` / `args[]` / `source` (`url:line:col`) / `stack` / `argsStatus` |
| 重い部分の扱い | ボディを別ストア (`bodies`) へ分離。`queryLogs()` は触らない | 引数プレビューはメタデータに同梱 (1件が小さいため分離しない)。上限で切り詰め、理由を `argsStatus` に残す |
| 量の抑え方 | MIMEパターン + `maxBodyBytes` (1MB) | 深さ・文字数の上限 + レート制限 (既定は10秒あたり500件。打ち切りは「n件を省略しました」のログを1件挟んで残す) |
| 直列化の難所 | 無し (`getContent()` が文字列を返す) | MAIN world側で完結させる必要がある。循環参照・DOMノード・関数はstructured cloneを通らず、オブジェクトは後から変化するため呼び出し時点でスナップショットする |
| サニタイズ | `sanitizeEntry()` (ヘッダー許可リスト + URL/ボディのトークン除去) | `sanitizeConsoleEntry()`。`sanitizeBody()` を `text` / `args` / `stack` に、`sanitizeUrl()` を `pageUrl` / `source` に流用。ヘッダーが無いため許可リストは不要 |
| キャプチャ時のURLフィルタ | `shouldCaptureUrl()` をリクエストURLに適用 | 同じ関数をpageUrlに適用 (consoleにリクエストURLが無いため意味が変わる) |
| 保存ストア | `logs` + `bodies` | `consoleLogs` (`ts` / `tabId` / `level` インデックス) |
| 保存に失敗した場合 | 1件だけ捨てて記録は継続 | 同じ。ただしその `console.error` 自身を拾わない再入ガードを持つ |

### 閲覧・出力

| | Networkログ | Consoleログ |
|---|---|---|
| 一覧の並び | `ts` インデックスの降順 | 同じ |
| 絞り込み | 期間/タブ/URL部分一致/メソッド/ステータス | 期間/タブ/レベル/本文部分一致/ページURL部分一致 |
| 一覧で重い値を読むか | 読まない (ボディは選択時に `getBody()`) | 読む (1件が小さいため分離しない) |
| 出力形式 | HAR 1.2 (`everlog-<日時>.har`)。Chrome DevToolsのNetwork Panelに読み戻せる | 独自のJSON (`everlog-console-<日時>.json`)。HARにconsoleを置く場所が無いため別形式にしている |
| 出力の実装 | `lib/har.ts` (純粋関数) + `useHarExport` + `downloadText()` | `lib/console-export.ts` + `useConsoleExport` + 同じ `downloadText()` |
| 出力規模の確認 | `EXPORT_CONFIRM_BYTES` / `EXPORT_MAX_BYTES` で確認・拒否 | 同じ仕組みを共有 |
| popupの保存状況 | 件数 + ボディ合計バイト | 件数 + 本文合計バイト |
| 全削除 | `clearAll()` で両方をまとめて削除 | 同左 |

### 権限

インストール時に要求するAPI権限は `storage` のみ。Consoleログの記録に使うコンテントスクリプトは宣言的に登録しており、自身の `matches` で注入されるため `host_permissions` も `scripting` も要らない (ただしインストール時の警告は `matches` 由来で表示される)
