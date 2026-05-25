# slack-thread-expander (GAS)

[eagletmt/slack-thread-expander](https://github.com/eagletmt/slack-thread-expander) を Google Apps Script に移植した実装。
スレッド返信を「Also send to channel」なしでチャンネル本流に展開する。

元実装は Slack Socket Mode で即時にスレッド返信を検出して permalink を投稿していたが、
GAS は WebSocket を扱えないため、**1 分毎の時間トリガーで `search.messages` をポーリングする方式** に切り替えている。

`conversations.history` ではスレッド返信本体（`Also send to channel` なし）は取得できないため、
User Token で `search.messages` を呼び、レスポンス中の `permalink` を Bot Token から投稿する 2 トークン構成。
検索インデックスの反映遅延があるため、投稿〜展開までの遅延は最大 1 分 + 数秒〜数十秒程度を見込む。

## デプロイ手順

デプロイはローカルから `pnpm deploy` を叩く。CI からの自動デプロイは行っていない。

### 1. clasp 認証と Apps Script プロジェクト作成 (初回のみ)

```bash
pnpm install
pnpm exec clasp login --no-localhost   # 認証後 ~/.clasprc.json が生成される
pnpm exec clasp create \
  --type standalone \
  --title "slack-thread-expander" \
  --rootDir ./dist                     # .clasp.json が生成される
```

`.clasp.json` はリポジトリ直下に作られる (`.clasp.json.example` を参照)。

### 2. Slack App をセットアップ

1. <https://api.slack.com/apps> で **Create New App > From an app manifest** を選ぶ
2. ワークスペースを選択し、`app_manifest.yml` の内容を貼り付けて作成
3. **OAuth & Permissions** 画面で「Install to Workspace」を押す
   - `Bot User OAuth Token` (`xoxb-...`) を控える
   - `User OAuth Token` (`xoxp-...`) を控える（`search.messages` 用）
4. 対象チャンネルそれぞれに Bot を invite する: `/invite @thread-expander`
5. User Token の所有ユーザーも対象チャンネル全てに参加していること（参加していないチャンネルは検索結果に出ない）

### 3. デプロイ

```bash
pnpm deploy   # = pnpm build && pnpm clasp:push
```

### 4. Script Properties を設定

GAS Editor の **プロジェクト設定 > スクリプト プロパティ** から登録:

| キー               | 値                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`  | Bot User OAuth Token (`xoxb-...`) — `chat.postMessage` の投稿用                                                                               |
| `SLACK_USER_TOKEN` | User OAuth Token (`xoxp-...`) — `search.messages` / `conversations.info` / `conversations.history` 用                                         |
| `TARGET_CHANNELS`  | 監視対象のチャンネル ID をカンマ区切り (例: `C0123ABC,C0456DEF`)。空のまま起動して、新規チャンネルで `@thread-expander on` させて増やしても可 |
| `SELF_BOT_ID`      | Bot 自身が投稿した permalink を二重展開しないためのガード。**未設定なら起動時に `auth.test` で自己取得して保存する**                          |
| `SELF_USER_ID`     | on/off メンションと未登録チャンネル自動追加で必要な Bot User ID (`U...`)。GAS Editor で `whoami` を実行してログから取得する                   |

### 5. トリガーを登録

GAS Editor で関数 `installTrigger` を 1 度だけ手動実行すると、
`main` を 1 分毎に呼ぶ時間トリガーがセットされる。
解除するときは `uninstallTrigger` を実行する。

### 動作確認

GAS Editor から `main` を手動実行し、実行ログでチャンネルごとの `fetched=N expanded=N` を確認する。
初回実行時は `last_ts` を「現在時刻」で初期化するだけで、過去のスレッドは遡及しない。

## チャンネル単位の on/off 制御

各チャンネルでの展開動作は、Bot へのメンションで切り替えられる。
時間トリガーで通常の expand 処理を回す前に、各 `TARGET_CHANNELS` の本流（トップレベル）メッセージを
`conversations.history` で取得し、`@thread-expander on` などのメンションを検出してチャンネル状態に反映する。

### 動作仕様

- `TARGET_CHANNELS` に含まれているだけでは展開は始まらない。各チャンネルで明示的に `on` メンションが必要 (**デフォルト disabled**)
- 認識するキーワード（大文字小文字は無視）
  - 有効化: `on` / `オン`
  - 無効化: `off` / `オフ`
  - ヘルプ表示: `help` / `ヘルプ`
- それ以外のテキストでメンションされた場合は「コマンドを認識できませんでした」とスレッド返信する
- on/off 反映時には、対象メッセージにスレッド返信で結果通知を返す
- `help` を受け取ると利用可能なコマンド一覧をスレッド返信する（チャンネルの有効/無効状態には影響しない）
- **`off` を受け付けた時点で `LAST_TS_<channel>` を削除する**。これにより再度 `on` にした際、その時点より新しい投稿のみが展開対象となる
- コントロールコマンドの検出スコープは **チャンネル本流のみ**（スレッド内のメンションは検出しない）

### 前提

- `SELF_USER_ID` を Script Properties に設定すること（メンションテキスト `<@U...>` のマッチングに必要）
- `SELF_BOT_ID` は未設定でも起動時に `auth.test` で自動取得・保存される（手動で `whoami` を叩く必要はない）
- 既に運用中で本機能を導入する場合、移行期間中は各チャンネルで一度 `@thread-expander on` を投げる必要がある

## 新規チャンネルでの自動追加

`TARGET_CHANNELS` にまだ登録されていないチャンネルで `@thread-expander on` を受信したとき、
そのチャンネルを `TARGET_CHANNELS` に **自動追加して有効化** する。これにより、新規チャンネルで運用を始める際に
Script Properties を手で書き換える必要がなくなる。

### 動作仕様

- 1 分毎の tick で `search.messages` を `<@SELF_USER_ID>` クエリで叩き、自身宛のメンションを横断検索する
- 検出結果のうち以下を満たすメッセージを自動追加の対象とする
  - チャンネル本流（スレッド内のメンションは無視）
  - `TARGET_CHANNELS` にまだ含まれていないチャンネル
  - `ControlCommand.parse` で `On` と判定されるテキスト (`on` / `オン`)
- 対象を見つけたら、`TARGET_CHANNELS` への追記・`setEnabled(true)`・コントロールカーソルの前進・スレッド返信を行う
- 未登録チャンネルで `@thread-expander help` を受け取った場合は、`TARGET_CHANNELS` に追加せずコマンド一覧のみスレッド返信する
- `off` / Unknown メンションは未登録チャンネルでは無視する（明示的に `on` するまで参加しない）
- `search.messages` 失敗時は警告ログを残して既存チャンネルの処理を続行する
- 重複応答を防ぐためグローバルな discovery カーソル (`DISCOVERY_LAST_TS`) を保持する。初回起動時は「今」で初期化されるため、過去のメンションは遡及して取り込まない

### 前提

- `SELF_USER_ID` が必須（未設定なら自動追加は無効）
- 検出対象になるためには User Token の所有ユーザーが当該チャンネルに参加していること（`search.messages` は User Token のスコープ内のみ返す）
- Bot 自身を当該チャンネルに招待しておくこと（招待されていないと自動追加直後のスレッド返信は失敗するが、追加自体は記録され、招待後の tick から自然に動き出す）

## Bot 自身の ID を確認する

通常運用では `SELF_BOT_ID` は起動時に自動取得されるため設定不要。
手動で値を確認したい場合は `whoami` 関数を提供する。
GAS Editor で `whoami` を 1 度実行すると、Bot Token に対する `auth.test` の結果が
実行ログに `SELF_BOT_ID: B0xxxxxxx` の形で出る。

## 過去投稿の一括削除

Bot がこれまで `TARGET_CHANNELS` に投稿したメッセージを一括削除する `cleanupPosts` 関数を提供する。
チャンネルの履歴を整理したい・運用方針を変えて投稿し直したいといったケースで使う。

### 前提

- `SELF_BOT_ID` が必要（未設定なら起動時の `auth.test` 自動取得で解決される。それでも取得失敗した場合は何もせず警告ログだけを残す）
- Bot が対象チャンネルにまだ参加していること（チャンネルから外れていると履歴を取得できない）
- 必要スコープは既存の `chat:write`（自分の投稿の削除は同スコープで可能）

### 実行方法

GAS Editor で関数 `cleanupPosts` を手動実行する。時間トリガーには登録しない。
実行ログには `cleanup end: channels=N scanned=M deleted=K failed=F` の形でサマリが出る。

挙動の特性:

- 対象チャンネルは `TARGET_CHANNELS`、削除対象は `bot_id === SELF_BOT_ID` のメッセージのみ
- 履歴のページングは安全側に上限を設定しており、1 回で削除しきれなかった場合は `truncated` をログ出力する。再度 `cleanupPosts` を実行すれば続きから削除できる
- `LAST_TS_<channel>`（次回展開のカーソル）は **意図的に変更しない**。削除後に未展開のメッセージを遡って展開し直したい場合は、Script Properties からカーソル値を手動で削除する

## 元実装との差分

| 観点           | 元実装 (Rust)                     | 本実装 (GAS)                                                       |
| -------------- | --------------------------------- | ------------------------------------------------------------------ |
| 通信方式       | Socket Mode (WebSocket)           | 時間トリガー + `search.messages`                                   |
| 遅延           | 即時                              | 最大 1 分 + 検索インデックス反映遅延                               |
| 必要トークン   | App-Level Token + Bot OAuth Token | Bot OAuth Token + User OAuth Token                                 |
| 対象チャンネル | Bot が参加した全チャンネル        | `TARGET_CHANNELS` に明示 (User も参加必須)。`@bot on` で自動追加可 |
| 状態管理       | なし (イベント駆動)               | チャンネル別 `LAST_TS_<channel>`                                   |
| デプロイ       | バイナリ常駐                      | ローカルから `pnpm deploy` (`clasp push`)                          |

## 開発コマンド

```bash
pnpm tsc        # 型チェック
pnpm test       # vitest
pnpm lint:fix   # eslint
pnpm format     # dprint
pnpm build      # esbuild で dist/Code.js を生成
pnpm clasp:push # ビルド済 dist を GAS へプッシュ
pnpm deploy     # build + clasp:push
```
