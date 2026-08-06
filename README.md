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
| Service Worker 維持 | メッセージ流入中のみ維持（Port を開くだけでは維持されない） | デバッガーセッションが維持（Chrome 116〜） |
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
┌────────────────────────────────────┐
│ DevTools ウィンドウ                  │
│  ┌──────────────────────────────┐  │
│  │ devtools/main.ts              │  │  onRequestFinished → getContent()
│  │ （キャプチャ層）                │  │
│  └───────────┬──────────────────┘  │
│              │ sanitizeEntry()       │  ヘッダー許可リスト / トークン除去
│              ▼                       │
│  ┌──────────────────────────────┐  │
│  │ lib/db.ts（保存層）            │  │  IndexedDB 書き込み
│  └───────────┬──────────────────┘  │
│  ┌───────────┴──────────────────┐  │
│  │ panel（閲覧 UI）               │  │  一覧・フィルタ・詳細表示
│  └──────────────────────────────┘  │
└──────────────┬─────────────────────┘
               ▼
         ┌───────────┐        ┌──────────────┐
         │ IndexedDB │◄───────┤ popup         │  トグル・出力
         └───────────┘        └──────────────┘
```

**Service Worker は使わない。** DevTools ページは拡張機能のオリジンで動くため、そこから開く IndexedDB は他のコンテキストが開くものと同一である。現行の Chrome では DevTools ページから拡張機能 API も利用できる（[公式ドキュメント](https://developer.chrome.com/docs/extensions/how-to/devtools/extend-devtools)：「The DevTools page can directly access extensions APIs.」）。したがって保存を Service Worker に委ねる必然性はない。

Service Worker を経由しない判断は、以下の検討による。

1. **同時書き込みは問題にならない。** DevTools はタブごとに独立して開くため書き込み主体は複数になるが、IndexedDB は同一オリジンの複数コンテキストからのアクセスをトランザクションで直列化する。
2. **サニタイズの集約は型で担保する。** 保存関数が `SanitizedLogEntry` しか受け取らないため、未サニタイズのエントリを保存する経路はコンパイル時に塞がれる。書き込み口が 1 本であることに依存しない。
3. **Service Worker が唯一必須だったのは定期パージ（`chrome.alarms`）だが、これは要件から外した。** 5.3 を参照。

Service Worker を挟まないことで、Port の配線・メッセージの型定義・Service Worker の終了への耐性という 3 つの複雑さが不要になり、転送中のエントリを取りこぼす経路も消える。`background.ts` は現状なにもしない。

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

### 5.2 サニタイズ

保存直前に必ず 1 箇所を通過させる。採取層ではなく保存の手前に置くことで、将来キャプチャ方式を変更しても漏れが生じない。保存関数がサニタイズ済みの型しか受け取らないため、この通過はコンパイル時に強制される。

| ID | 機能 | 内容 |
| --- | --- | --- |
| SAN-01 | ヘッダー許可リスト | 保存してよいヘッダーのみを通す許可リスト方式とする。拒否リスト方式は独自認証ヘッダーを取りこぼすため採用しない |
| SAN-02 | ヘッダー名正規化 | 比較前に小文字化する（`Authorization` / `authorization` の双方が実際に出現するため） |
| SAN-03 | 除外対象ヘッダー | `authorization`、`cookie`、`set-cookie` を最低ラインとして許可リストに含めない |
| SAN-04 | ボディ内トークン除去 | `Bearer …` / `Basic …`、JWT、`access_token` / `id_token` / `refresh_token` 等を `[REDACTED]` に置換する |
| SAN-05 | URL 内トークン除去 | クエリパラメータ内の `access_token`、`id_token`、`api_key`、`token` 等を置換する。フラグメント、URL 内の認証情報（`https://user:pass@host/`）、およびパスセグメントに埋め込まれた JWT（`/verify/eyJ…`）も対象とする |

正規表現による除去は完全ではない。独自形式のトークンは検出できないため、機微な API は CAP-04 の段階で採取対象から除外する二段構えとする。

補足（実装時の決定）：

- 破棄したヘッダーは**名前だけ**を `droppedRequestHeaders` / `droppedResponseHeaders` に残す。「独自認証ヘッダーが付いていた」という事実自体が調査に有用なため。値は一切保持しない。
- 値を伏せるキーは上記に加えて `client_secret`、`secret`、`password`、`session_id`、`credentials`、`auth`、`code` も対象とする。キー名は小文字化と区切り文字の除去で正規化するため、`accessToken` / `access-token` のような表記ゆれも同一視する。
- URL はクエリだけでなく**フラグメント**（OAuth implicit flow）と URL 内の認証情報も対象にする。キーが未知でも値が JWT の形をしていれば置換する。
- URL は保存層の検索対象でもあるため、置換が発生しなかった URL は 1 文字も変形させない。
- ボディの置換は JSON を壊さないこと（置換後も `JSON.parse` できること）を条件とする。

### 5.3 保存（DevTools ページ）

| ID | 機能 | 内容 | 状態 |
| --- | --- | --- | --- |
| STO-01 | 保存先 | IndexedDB（DB 名 `everlog`）。`chrome.storage.local` は既定 10MB であり構造化検索もできないため採用しない | 実装済み |
| STO-02 | ストア構成 | メタデータの `logs` とボディの `bodies` に分ける。一覧取得でボディをロードしない（8.3）ための必須の分割 | 実装済み |
| STO-03 | インデックス | `logs` の `ts`（記録時刻）、`tabId`、`host` にインデックスを張る。取得は常に `ts` を降順に辿り、期間はインデックス範囲で絞る。URL 部分一致はインデックスで表現できないためカーソル内で判定する | 実装済み |
| STO-04 | 基本操作 | 保存 / 条件付き取得 / ボディ取得 / 全削除 | 実装済み |
| STO-05 | 自動パージ | 保持期間や容量上限による自動削除 | **未実装**。将来検討 |

`unlimitedStorage` は宣言しない。自動削除を持たない現状では上限を自ら管理していないため、既定クォータの範囲で運用する。`alarms` も不要（5.3 に定期処理が無いため）。

保存量が増えるのは DevTools を開いている間だけであり、自動削除を導入する場合も `chrome.alarms` ではなく書き込み経路や DevTools 起動時のチェックで実現できる（Service Worker を必要としない）。

### 5.4 閲覧 UI（DevTools パネル）

| ID | 機能 | 内容 | 状態 |
| --- | --- | --- | --- |
| VIEW-01 | 一覧表示 | 保存済みエントリを新しい順に表示する。列は時刻・メソッド・ステータス・URL | 実装済み |
| VIEW-02 | フィルタ | URL 部分一致、ステータスコード、HTTP メソッド、期間、タブで絞り込む | 実装済み |
| VIEW-03 | 詳細表示 | 選択したエントリのヘッダーとレスポンスボディを表示する。`Content-Type` が JSON の場合は整形表示する | 実装済み |
| VIEW-04 | ボディ状態の表示 | ボディが未取得の場合、その理由（サイズ超過・MIME 対象外・取得失敗）を表示する | 実装済み |

補足（実装時の決定）：

- 一覧は `limit` によるページングとし、既定 200 件・「さらに読み込む」で追加取得する。仮想スクロールは件数が問題になってから入れる（8.3）。
- 記録は DevTools を開いている間に増え続けるため、既定 2 秒間隔で再取得する（チェックボックスで停止できる）。「読み込み中」の表示は初回だけに限る。ポーリングのたびに出すと、0 件のときに表示が数秒おきに切り替わって落ち着かないため。
- フィルタは入力のたびではなく「適用」または Enter で確定する。数字でないステータスや解釈できない日時は、条件そのものを積まない（誤入力で 0 件になるより、絞り込まずに見せるほうが調査中は穏当なため）。
- ボディは行を選択したときに初めて `getBody()` で取得する。一覧では読まない（8.3）。
- 破棄したヘッダー名（`droppedRequestHeaders` / `droppedResponseHeaders`）も詳細に表示する。値は保存していないため名前だけを出す。
- 表示は `prefers-color-scheme` で light / dark を切り替える。パネルから DevTools のテーマ設定を読む安定した API が無いため、OS・ブラウザ側の設定に追従させる。

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

`getContent()` はコールバックを一度も呼ばないことがある（リクエストの元になったコンテキストが失われた場合など）。待ち時間に上限を設けないと await が永久に止まり、メタデータごとエントリを取りこぼす。このため取得には 10 秒（`GET_CONTENT_TIMEOUT_MS`）の上限を設け、時間切れも `fetch_failed` として扱う。

---

## 7. データモデル

IndexedDB オブジェクトストア `logs`（キー：自動採番）

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `id` | number | 主キー（自動採番） |
| `ts` | number | 記録時刻（epoch ミリ秒）。インデックス対象 |
| `tabId` | number | 記録元タブ。インデックス対象 |
| `pageUrl` | string | 記録時に開いていたページの URL（サニタイズ済み） |
| `url` | string | リクエスト URL（サニタイズ済み） |
| `host` | string | `url` から切り出したホスト。インデックス対象。パースできない場合は空文字 |
| `method` | string | HTTP メソッド |
| `status` | number | ステータスコード |
| `mimeType` | string | レスポンスの MIME タイプ |
| `timeMs` | number | 所要時間 |
| `requestHeaders` | object | 許可リスト通過後のリクエストヘッダー |
| `responseHeaders` | object | 許可リスト通過後のレスポンスヘッダー |
| `droppedRequestHeaders` | string[] | 許可リストに載らず破棄したリクエストヘッダー名（値は保存しない） |
| `droppedResponseHeaders` | string[] | 許可リストに載らず破棄したレスポンスヘッダー名（値は保存しない） |
| `bodySize` | number | 元のボディサイズ（バイト） |
| `bodyStatus` | string | `stored` / `too_large` / `mime_excluded` / `fetch_failed` |

ボディは `logs` に含めず、オブジェクトストア `bodies`（キー：`logId`）に分けて保存する。

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `logId` | number | 対応する `logs` の `id` |
| `body` | string | サニタイズ済みレスポンスボディ |

ボディを取得できなかったエントリ（`bodyStatus` が `stored` 以外）は `bodies` に行を持たない。一覧取得（`queryLogs`）は `bodies` を一切読まない。

---

## 8. 非機能要件

### 8.1 容量

- ボディサイズ上限は既定 1MB。
- MIME フィルタの既定値は `application/json`、`text/*`、`application/xml` とする。
- 保持期間および容量上限による自動削除は**未実装**（STO-05）。保存量が増えるのは DevTools を開いている間だけである点を前提に、当面は手動の全削除で運用する。
- popup に概算使用容量を表示し、肥大化を利用者が把握できるようにする。

### 8.2 セキュリティ

- ログは拡張機能のローカルストレージにのみ保存し、外部送信は一切行わない。
- サニタイズは保存前に実施し、生の認証情報が IndexedDB に書き込まれないようにする。
- HAR 出力にも同じサニタイズ結果を用いる。
- 記録が有効であることをバッジ表示で常時明示する。

### 8.3 パフォーマンス

- **ボディは一覧取得時にはロードせず、詳細表示時に個別取得する。** これを実際に成立させるため、ボディは `logs` とは別のストアに置く（7 章）。この分割が、URL 部分一致のような走査を伴う絞り込みを実用速度に保つ前提にもなっている。
- 絞り込みは `ts` インデックスの範囲で対象を狭めてから、残りの条件をカーソル内で判定する。
- 一覧表示は仮想スクロールまたはページングとし、数万件でも操作性を維持する。
- 保存を Service Worker に置かないため、Service Worker の生存期間（Chrome 114 以降、Port を開いているだけではアイドルタイマーはリセットされない）は保存層の設計に影響しない。将来 Service Worker で処理を行う場合はこの点を考慮する。

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

ビルドには WXT を用いる。`src/entrypoints/` 配下の配置から manifest が自動生成されるため、`manifest.json` は成果物であり、リポジトリには置かない。

本番用コードは `src/`、テストは `tests/` に置き、フォルダで分離する。`wxt.config.ts` の `srcDir: 'src'` によってビルド対象は `src/` 配下に限定され、テストコードが拡張機能の成果物に混入しない。`tests/` は `src/` のディレクトリ構造をそのまま写す。

```
/
├── .github/workflows/ci.yml   # typecheck / test / build（10.2）
├── wxt.config.ts              # srcDir と manifest の宣言（権限等）
├── vitest.config.ts           # include: tests/**/*.test.ts
├── src/                       # 本番用コード（ビルド対象）
│   ├── entrypoints/
│   │   ├── devtools/
│   │   │   ├── index.html     # devtools_page として登録される
│   │   │   └── main.ts        # キャプチャ → サニタイズ → 保存 の配線 + パネル登録
│   │   ├── background.ts      # Service Worker（現状なにもしない）
│   │   ├── panel/             # 閲覧 UI（React）
│   │   │   ├── index.html     # panel.html として出力される
│   │   │   ├── main.tsx       # マウントのみ
│   │   │   ├── style.css      # Tailwind の読み込みと最小限の全体指定
│   │   │   ├── App.tsx        # フックと表示コンポーネントの接続
│   │   │   ├── components/    # 表示のみ（FilterBar / LogTable / LogDetail）
│   │   │   └── hooks/         # データ取得（useLogQuery / useLogBody）
│   │   └── popup/             # トグル・出力・設定（未実装）
│   └── lib/
│       ├── network-log.ts     # データモデル + HAR → エントリ変換（純粋関数）
│       ├── capture.ts         # onRequestFinished 購読・getContent
│       ├── sanitize.ts        # ヘッダー許可リスト・トークン除去
│       ├── db.ts              # IndexedDB（保存・取得・全削除）
│       ├── log-source.ts      # 閲覧 UI から見た保存層の入口（読み取り専用）
│       ├── panel-view.ts      # 閲覧 UI の表示ロジック（純粋関数）
│       └── har.ts             # HAR 1.2 変換（未実装）
└── tests/                     # テストコード（ビルド対象外）
    └── lib/
        ├── network-log.test.ts
        ├── capture.test.ts
        ├── sanitize.test.ts
        ├── db.test.ts
        └── panel-view.test.ts
```

### 10.1 閲覧 UI の層分け

パネルは **表示（`components/`）／データ取得（`hooks/`）／ロジック（`lib/panel-view.ts`）** の 3 層に分ける。

- **表示コンポーネントは props で受けた値を描くだけ**とし、自分では取得も判定もしない。`db.ts` を import しない。
- **データ取得はフックに閉じる。** フックは `LogSource`（`lib/log-source.ts`）を引数で受け取るため、差し替えれば実物の IndexedDB なしで描画できる。キャプチャ層が Chrome API を引数で受け取るのと同じ考え方。
- **絞り込み条件の組み立てと整形は `lib/panel-view.ts` の純粋関数**に置く。描画環境なしでテストできる状態を保つため、この判定をコンポーネントへ移さない。

現時点で UI テスト（Playwright / Storybook）は導入していないが、後から差し込めるようにこの分離を先に済ませてある。

スタイリングは Tailwind CSS v4 を使う。設定ファイルは持たず、`src/entrypoints/panel/style.css` の `@import 'tailwindcss'` と `wxt.config.ts` の Vite プラグイン登録だけで完結する。ビルド時に CSS へ展開されるため、拡張機能の CSP には影響しない。

テストから本番用コードを参照するときは `@/` エイリアスを使う（`@` は `src/` を指す）。`tests/lib/db.test.ts` からは `import { addLog } from '@/lib/db'` と書く。`WxtVitest()` プラグインが WXT の生成した tsconfig からこのエイリアスを解決するため、Vitest 側に追加設定は要らない。

### 10.2 CI

`.github/workflows/ci.yml` が `main` への push・全 Pull Request・手動実行（`workflow_dispatch`）で以下を順に実行する。いずれかが失敗すればジョブが落ちる。

| ステップ | コマンド | 目的 |
| --- | --- | --- |
| Install | `bun ci` | `bun.lock` どおりに固定インストール（`bun install --frozen-lockfile` と同じ。postinstall の `wxt prepare` が `.wxt/` の型とエイリアスを生成する） |
| Typecheck | `bun run typecheck` | `tsc --noEmit` |
| Test | `bun run test` | Vitest（`tests/` 配下） |
| Build | `bun run build` | WXT ビルドが通ることの確認 |

同一ブランチで新しい push があった場合、`concurrency` により実行中のジョブはキャンセルされる。

**Action は commit SHA で固定する。** `actions/checkout@v7` のようなタグ参照は、タグが同じ名前のまま別のコミットへ付け替えられるため、上流が乗っ取られた場合にそのコードがそのまま CI で実行される。SHA は付け替えられないので、固定すれば取得内容が変わらない。可読性のために `# v7.0.1` のようなバージョンコメントを末尾に付け、更新時は `git ls-remote --tags <repo>` で SHA を取り直してコメントも合わせる。

`permissions: contents: read` をワークフロー既定として宣言する。これを省くとリポジトリ設定次第で `GITHUB_TOKEN` に write 権限が付くため、明示的に絞る。

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

| フェーズ | 内容 | 完了条件 | 状態 |
| --- | --- | --- | --- |
| 1 | キャプチャ層と保存層の疎通 | DevTools を開いた状態でリクエストが IndexedDB に保存される | 完了 |
| 2 | サニタイズ層 | `Authorization` ヘッダーとボディ内トークンが保存されないことを確認できる | 完了 |
| 3 | 閲覧 UI | パネルで一覧・フィルタ・詳細表示ができる | 完了 |
| 4 | popup（トグル・出力） | HAR を書き出し、DevTools にインポートして閲覧できる | 未着手（CAP-03 / POP-01〜05・`lib/har.ts`） |
| 5 | パージと設定 | 7 日経過分が自動削除され、設定値が反映される | 未着手（CAP-04 / STO-05） |

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
