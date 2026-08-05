# ネットワークログ記録 Chrome 拡張機能 仕様書

| 項目 | 内容 |
| --- | --- |
| ドキュメント種別 | 技術仕様書 |
| バージョン | 0.1（ドラフト） |
| 最終更新 | 2026-08-06 |

---

## 1. 目的と背景

Chrome DevTools の Network パネルは、DevTools を閉じるとログが破棄される。Preserve log はページ遷移をまたいでログを残すオプションであり、DevTools ウィンドウの生存期間を超えて保持する機能ではない。HAR エクスポートは手動操作であり、自動保存・保持期間の設定に相当する UI は DevTools に存在しない。

本拡張機能は、DevTools で観測したネットワークリクエストとレスポンスボディを自動的に永続化し、後から URL 等で絞り込んで内容を参照・出力できるようにすることを目的とする。

### 想定利用シーン

- 断続的にしか再現しない API エラーの調査（発生時にはログが既に流れている）
- 数日前のリクエスト／レスポンスと現在の挙動を比較する
- 不具合報告に添付するネットワークログを、再現作業なしに切り出す

---

## 2. スコープ

### 対象とするもの

- DevTools が開いているタブのネットワークリクエストの記録
- レスポンスボディの取得と保存
- 保存データの一覧表示・フィルタ・詳細表示
- 保存データのファイル出力
- 機微情報のサニタイズ
- 保持期間を超えたデータの自動削除

### 対象としないもの

- DevTools を開いていない状態での記録（3章の方式決定を参照）
- リクエストの改変・ブロック・モック
- 拡張機能外部（サーバー等）へのログ送信
- Chrome 以外のブラウザ対応

---

## 3. 方式決定：ネットワークログの取得方法

Chrome 拡張機能でレスポンスボディを取得できる API は 2 つのみである。`chrome.webRequest` および `declarativeNetRequest` にはレスポンスボディを読む機能がなく、実装要望も未対応のままである（[crbug 41174207](https://issues.chromium.org/issues/41174207)）。

### 3.1 比較

| 観点 | ① DevTools 拡張<br>`chrome.devtools.network` | ② `chrome.debugger`（CDP） |
| --- | --- | --- |
| ボディ取得 API | `getContent()` | `Network.getResponseBody` |
| DevTools を開く必要 | 必須 | 不要 |
| DevTools との併用 | 前提 | 不可（開くと `onDetach: canceled_by_user`） |
| 警告バー | 出ない | 全 attach タブに常時表示 |
| 必要な権限 | `devtools_page`（強い警告なし） | `debugger`（強い警告あり） |
| 採取範囲 | DevTools を開いたタブのみ | 全タブ・常時 |
| 取りこぼし | DevTools を開く前のリクエスト | attach 前のリクエスト |
| コード形式 | コールバックのみ | Promise 対応 |
| データ形式 | HAR エントリ形式 | CDP 生イベント |
| Service Worker 維持 | Port 経由のメッセージ流入で維持 | デバッガーセッションが維持（Chrome 116〜） |
| タブ管理コード | 不要 | 必要（attach / detach の管理） |
| 実装難度 | 低 | 高 |

### 3.2 決定

**① DevTools 拡張方式（`chrome.devtools.network`）を採用する。**

採用理由：

- ②は全タブに「拡張機能がこのブラウザのデバッグを開始しました」という警告バーが常時表示され、日常利用に耐えない。回避には Chrome の起動フラグまたは企業ポリシーによる強制インストールが必要になる。
- ②は対象タブで DevTools を開くとブラウザ側がデバッグセッションを終了させるため、開発作業と両立しない。
- ①は `debugger` 権限が不要となり、インストール時のユーザー警告が大幅に軽くなる。Web Store 申請時の用途説明も不要になる。
- 実運用上、記録が必要なのは開発・調査作業中のログであり、DevTools を開いている時間帯とほぼ一致する。

採用に伴う前提：

- 記録対象は「DevTools を開いたタブ」に限定される。DevTools を開く前に発生したリクエストは取得できないため、記録したい場合は DevTools を開いた状態でリロードする運用となる。
- タブへの attach / detach 管理は不要。DevTools ウィンドウごとに DevTools ページのインスタンスが自動生成される。

---

## 4. アーキテクチャ

```
┌──────────────────────────┐
│ DevTools ウィンドウ        │
│  ┌────────────────────┐  │
│  │ devtools.js         │  │  onRequestFinished → getContent()
│  │ （キャプチャ層）      │  │
│  └─────────┬──────────┘  │
│  ┌─────────┴──────────┐  │
│  │ panel.html/js       │  │  一覧・フィルタ・詳細表示
│  │ （閲覧 UI）          │  │
│  └────────────────────┘  │
└───────────┬──────────────┘
            │ chrome.runtime.connect（Port）
            ▼
┌──────────────────────────┐
│ Service Worker            │
│  サニタイズ層             │  ヘッダー許可リスト / トークン除去
│  保存層                   │  IndexedDB 書き込み
│  パージ層                 │  chrome.alarms による定期削除
└───────────┬──────────────┘
            │
            ▼
      ┌───────────┐        ┌──────────────┐
      │ IndexedDB │◄───────┤ popup.html    │  トグル・出力・全削除
      └───────────┘        └──────────────┘
```

DevTools ページは大半の拡張機能 API を直接利用できず、コンテンツスクリプトと同等の限られたサブセットしか持たない。IndexedDB や `chrome.storage` への書き込みは Service Worker 側で行い、両者はメッセージパッシングで通信する。この 3 層構成は本方式における必須の制約である。

---

## 5. 機能要件

### 5.1 キャプチャ（devtools.js）

| ID | 機能 | 内容 |
| --- | --- | --- |
| CAP-01 | リクエスト捕捉 | `chrome.devtools.network.onRequestFinished` で完了したリクエストを捕捉する |
| CAP-02 | ボディ取得 | `getContent()` でレスポンスボディを取得する。API はコールバック形式のため Promise ラッパーを用意する |
| CAP-03 | 記録 ON/OFF | 記録の有効・無効を切り替える。状態は `chrome.storage.local` に永続化し、ブラウザ再起動後も維持する |
| CAP-04 | URL フィルタ | 設定した URL パターンに一致するリクエストのみ記録する（採取時点で除外し、保存量を抑える） |
| CAP-05 | MIME タイプフィルタ | JSON・テキスト系のみボディを保存する。画像・動画・フォント等はメタデータのみ記録する |
| CAP-06 | サイズ上限 | 設定値を超えるボディは保存せず、メタデータに超過フラグを立てる |
| CAP-07 | タブ情報の付与 | `chrome.devtools.inspectedWindow.tabId` を各エントリに付与する |

### 5.2 サニタイズ（Service Worker）

保存直前に必ず 1 箇所を通過させる。採取層ではなく保存層に置くことで、将来キャプチャ方式を変更しても漏れが生じない。

| ID | 機能 | 内容 |
| --- | --- | --- |
| SAN-01 | ヘッダー許可リスト | 保存してよいヘッダーのみを通す許可リスト方式とする。拒否リスト方式は独自認証ヘッダーを取りこぼすため採用しない |
| SAN-02 | ヘッダー名正規化 | 比較前に小文字化する（`Authorization` / `authorization` の双方が実際に出現するため） |
| SAN-03 | 除外対象ヘッダー | `authorization`、`cookie`、`set-cookie` を最低ラインとして許可リストに含めない |
| SAN-04 | ボディ内トークン除去 | `Bearer …`、JWT、`access_token` / `id_token` / `refresh_token` を `[REDACTED]` に置換する |
| SAN-05 | URL 内トークン除去 | クエリパラメータ内の `access_token`、`id_token`、`api_key`、`token` 等を置換する |

正規表現による除去は完全ではない。独自形式のトークンは検出できないため、機微な API は CAP-04 の段階で採取対象から除外する二段構えとする。

### 5.3 保存（Service Worker）

| ID | 機能 | 内容 |
| --- | --- | --- |
| STO-01 | 保存先 | IndexedDB。`unlimitedStorage` 権限を宣言する。`chrome.storage.local` は既定 10MB であり構造化検索もできないため採用しない |
| STO-02 | インデックス | `ts`（記録時刻）、`url`、`tabId` にインデックスを張る |
| STO-03 | 自動パージ | `chrome.alarms` で 1 時間ごとに起動し、`ts` が 7 日より古いエントリを削除する |
| STO-04 | 手動削除 | 全件削除および表示中のフィルタ結果の削除を提供する |

### 5.4 閲覧 UI（DevTools パネル）

| ID | 機能 | 内容 |
| --- | --- | --- |
| VIEW-01 | 一覧表示 | 保存済みエントリを新しい順に表示する。列は時刻・メソッド・ステータス・URL |
| VIEW-02 | フィルタ | URL 部分一致、ステータスコード、HTTP メソッド、期間、タブで絞り込む |
| VIEW-03 | 詳細表示 | 選択したエントリのヘッダーとレスポンスボディを表示する。`Content-Type` が JSON の場合は整形表示する |
| VIEW-04 | ボディ状態の表示 | ボディが未取得の場合、その理由（サイズ超過・MIME 対象外・取得失敗）を表示する |

### 5.5 出力・設定（popup.html）

| ID | 機能 | 内容 |
| --- | --- | --- |
| POP-01 | 記録トグル | 記録の ON/OFF を切り替える。`chrome.action.setBadgeText` で稼働状態をアイコンに表示する |
| POP-02 | 出力ボタン | 保存済みログを HAR ファイルとして書き出す |
| POP-03 | 出力範囲 | 全件、または期間・URL パターンを指定して出力する |
| POP-04 | 設定 | URL フィルタ、MIME フィルタ、ボディサイズ上限、保持日数を編集する |
| POP-05 | 保存状況 | 保存件数と概算使用容量を表示する |

---

## 6. 保留事項の決定

議論中に未決だった 4 点について、以下のとおり決定する。

### 6.1 閲覧 UI の配置

**DevTools パネル（`chrome.devtools.panels.create`）に配置する。popup は記録トグル・出力・設定のみとする。**

popup は表示領域が狭く、一覧・フィルタ・ボディ表示を収めるには不足する。また、利用者は記録時点で既に DevTools を開いているため、同一ウィンドウ内で完結する動線が自然である。

### 6.2 出力形式

**HAR 1.2 形式とする。**

既存の HAR ビューアや DevTools の Network パネルへインポートして閲覧できるため、拡張機能側に高機能なビューアを実装する必要がなくなる。`chrome.devtools.network` が返すデータが元々 HAR エントリ形式であるため、変換コストも小さい。

なお、出力される HAR はサニタイズ済みであり、`Cookie` / `Set-Cookie` / `Authorization` を含まない。これは Chrome 130 以降の DevTools が既定で行う HAR サニタイズと同じ方針である。

### 6.3 複数タブの扱い

**単一のストアに保存し、`tabId` とページ URL をエントリに付与する。閲覧時にタブ単位でフィルタできるようにする。**

DevTools はタブごとに独立して開くため、DevTools ページも複数同時に存在しうる。ストアを分けると横断検索ができなくなるため、保存は一元化し、絞り込みで対応する。

### 6.4 ボディ取得失敗時の方針

**メタデータのみ保存し、`bodyStatus` フィールドに理由を記録する。**

「リクエストは発生したがボディが残っていない」という事実自体が調査上の情報となるため、破棄しない。`bodyStatus` は `stored` / `too_large` / `mime_excluded` / `fetch_failed` のいずれかとする。

---

## 7. データモデル

IndexedDB オブジェクトストア `logs`（キー：自動採番）

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `id` | number | 主キー（自動採番） |
| `ts` | number | 記録時刻（epoch ミリ秒）。インデックス対象 |
| `tabId` | number | 記録元タブ。インデックス対象 |
| `pageUrl` | string | 記録時に開いていたページの URL |
| `url` | string | リクエスト URL（サニタイズ済み）。インデックス対象 |
| `method` | string | HTTP メソッド |
| `status` | number | ステータスコード |
| `mimeType` | string | レスポンスの MIME タイプ |
| `timeMs` | number | 所要時間 |
| `requestHeaders` | object | 許可リスト通過後のリクエストヘッダー |
| `responseHeaders` | object | 許可リスト通過後のレスポンスヘッダー |
| `body` | string \| null | サニタイズ済みレスポンスボディ |
| `bodySize` | number | 元のボディサイズ（バイト） |
| `bodyStatus` | string | `stored` / `too_large` / `mime_excluded` / `fetch_failed` |

---

## 8. 非機能要件

### 8.1 容量

- 保持期間は既定 7 日。設定で変更可能とする。
- ボディサイズ上限は既定 1MB。
- MIME フィルタの既定値は `application/json`、`text/*`、`application/xml` とする。
- popup に概算使用容量を表示し、肥大化を利用者が把握できるようにする。

### 8.2 セキュリティ

- ログは拡張機能のローカルストレージにのみ保存し、外部送信は一切行わない。
- サニタイズは保存前に実施し、生の認証情報が IndexedDB に書き込まれないようにする。
- HAR 出力にも同じサニタイズ結果を用いる。
- 記録が有効であることをバッジ表示で常時明示する。

### 8.3 パフォーマンス

- Port 経由のメッセージ流入により Service Worker のアイドルタイマーがリセットされるため、記録中の Service Worker 終了は考慮不要。
- 一覧表示は仮想スクロールまたはページングとし、数万件でも操作性を維持する。
- ボディは一覧取得時にはロードせず、詳細表示時に個別取得する。

---

## 9. 既知の制約

| 制約 | 内容 |
| --- | --- |
| DevTools 依存 | DevTools ウィンドウが閉じるとキャプチャは停止する。DevTools ページは DevTools ウィンドウの生存期間中のみ存在する |
| 開く前の取りこぼし | DevTools を開く前に発生したリクエストは取得できない |
| Promise 非対応 | `chrome.devtools.*` はコールバックのみで Promise を返さない |
| ボディ取得失敗 | `getContent()` は常に成功するとは限らない。失敗時は 6.4 の方針に従う |
| トークン除去の限界 | 正規表現ベースのため、独自形式の認証情報は検出できない |

---

## 10. ファイル構成

ビルドには WXT を用いる。`entrypoints/` 配下の配置から manifest が自動生成されるため、`manifest.json` は成果物であり、リポジトリには置かない。

```
/
├── wxt.config.ts          # manifest の宣言（権限等）
├── vitest.config.ts
├── entrypoints/
│   ├── devtools/
│   │   ├── index.html     # devtools_page として登録される
│   │   └── main.ts        # キャプチャ層の配線
│   ├── background.ts      # Service Worker（サニタイズ・保存・パージ）
│   ├── panel/             # 閲覧 UI（未実装）
│   └── popup/             # トグル・出力・設定（未実装）
└── lib/
    ├── network-log.ts     # データモデル + HAR → エントリ変換（純粋関数）
    ├── capture.ts         # onRequestFinished 購読・getContent
    ├── db.ts              # IndexedDB ラッパー（未実装）
    ├── sanitize.ts        # ヘッダー許可リスト・トークン除去（未実装）
    └── har.ts             # HAR 1.2 変換（未実装）
```

### manifest（骨子）

`wxt.config.ts` で以下を宣言する（キャプチャ層のみの現時点では追加権限は不要で、`devtools_page` と `background` は WXT が自動生成する）。

```ts
manifest: {
  name: 'EverLog',
  permissions: ['storage', 'unlimitedStorage', 'alarms'],
}
```

`debugger` 権限および `host_permissions` は不要である。

---

## 11. 実装フェーズ

| フェーズ | 内容 | 完了条件 |
| --- | --- | --- |
| 1 | キャプチャ層と保存層の疎通 | DevTools を開いた状態でリクエストが IndexedDB に保存される |
| 2 | サニタイズ層 | `Authorization` ヘッダーとボディ内トークンが保存されないことを確認できる |
| 3 | 閲覧 UI | パネルで一覧・フィルタ・詳細表示ができる |
| 4 | popup（トグル・出力） | HAR を書き出し、DevTools にインポートして閲覧できる |
| 5 | パージと設定 | 7 日経過分が自動削除され、設定値が反映される |

---

## 12. 参考資料

- [chrome.devtools.network — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/devtools/network)
- [Extend DevTools — Chrome for Developers](https://developer.chrome.com/docs/extensions/how-to/devtools/extend-devtools)
- [chrome.debugger — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [chrome.storage — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/storage)
- [chrome.alarms — Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- [Service worker lifecycle — Chrome for Developers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- [Network features reference — Chrome DevTools](https://developer.chrome.com/docs/devtools/network/reference)
- [What's new in DevTools, Chrome 130](https://developer.chrome.com/blog/new-in-devtools-130)
