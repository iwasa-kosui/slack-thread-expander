# `@thread-expander help` コマンド設計

## 背景

現状のコントロールコマンドは `on` / `off` のみで、利用者は README を参照しないとコマンド体系を把握できない。Slack 上でその場で使い方を確認できるよう、`@thread-expander help` で利用可能なコマンド一覧をスレッド返信する機能を追加する。

## 要件

- `@thread-expander help` または `@thread-expander ヘルプ` というメンション付きメッセージで反応する
- 反応スコープはチャンネル本流のみ。スレッド内メンションは無視する（既存の on/off と揃える）
- 登録済チャンネル（`TARGET_CHANNELS` に含まれる）でも未登録チャンネルでも `help` には応答する
- 未登録チャンネルで `help` を受け取っても `TARGET_CHANNELS` への自動追加・有効化は行わない
- 返信内容は利用可能なコマンド一覧（on / off / help）に絞る
- 同じ help メッセージへの二重返信が起きないこと

## 設計判断

### `Help` を `ControlCommand` の新バリアントとして追加する

既存の `On` / `Off` / `Unknown` / `NotForUs` と並列の Discriminated Union バリアントにする。`Unknown` の中で `if (rest === 'help')` のような特例にはしない。Discriminated Union のバリアントを増やすことで、後段の `switch` で網羅性チェック（`assertNever`）が効き、ハンドリング漏れがコンパイル時に検出される。

キーワードは `help` / `ヘルプ` 両方を認識する。これは `on` / `オン`、`off` / `オフ` の対称性に揃えるため。

### `Help` は状態を変えない

`On` は `setEnabled(true)`、`Off` は `setEnabled(false)` + `cursor.clear()` の副作用を持つが、`Help` は問い合わせ系の操作と位置付け、`channelControl` / `cursor` の状態には一切触れない。スレッド返信のみを行う。

### グローバル discovery cursor で未登録チャンネルの help 重複を防ぐ

`search.messages` は新しい順に最大 100 件返すため、未登録チャンネルで help に応答した後、次の tick で同じメッセージが再検出されると重複返信になる。`on` の場合は `TARGET_CHANNELS` に追加されることで以降 `known.has` から除外され自然に止まるが、`help` は追加しない設計のため別の仕組みが必要。

PropertiesService に `DISCOVERY_LAST_TS` キーで単一値を持ち、`discoverOnMentionedChannels` 起動時に取得・更新する。これ以前の ts のマッチは処理対象外。初回（未設定時）は `clock.nowSlackTs()` で初期化し、過去ログを遡及して取り込まないようにする（`processControlCommands` の `getControlCursor == null` 時と同じ思想）。

副次的に、既存の On 自動追加でも同 tick 内で複数の On が並んだ場合に最も古い 1 件のみ進む dedupe ロジックが機能していたが、tick をまたいで同じ On が再検出される可能性も discovery cursor で排除される。

## 変更点

### ドメイン層

`src/domain/control-command.ts`

```typescript
export type ControlCommand =
  | Readonly<{ kind: 'NotForUs' }>
  | Readonly<{ kind: 'On' }>
  | Readonly<{ kind: 'Off' }>
  | Readonly<{ kind: 'Help' }>
  | Readonly<{ kind: 'Unknown'; rest: string }>;

const HELP_KEYWORDS: ReadonlySet<string> = new Set(['help', 'ヘルプ']);
```

`src/domain/discovery-cursor-port.ts` (新規)

```typescript
export type DiscoveryCursorPort = Readonly<{
  get: () => SlackTs | undefined;
  set: (ts: SlackTs) => void;
}>;
```

`src/domain/channel-discovery-outcome.ts`

`DiscoveredChannel` を discriminated union に拡張し、自動追加と help 応答を区別する。

```typescript
export type DiscoveredChannel =
  | Readonly<{ kind: 'AutoAdded'; channel: ChannelId; ts: SlackTs }>
  | Readonly<{ kind: 'HelpReplied'; channel: ChannelId; ts: SlackTs }>;
```

`ChannelDiscoveryOutcome.addedCount` は `AutoAdded` のみカウントする実装に変える。

### アダプタ層

`src/adaptor/gas/gas-properties-discovery-cursor-store.ts` (新規)

PropertiesService をラップした単一値ストア。キー `DISCOVERY_LAST_TS`。

`src/handler/tick-handler.ts`

`discoverOnMentionedChannels` の deps 組み立てに `discoveryCursor` を追加。

### ユースケース層

`src/usecase/process-control-commands.ts`

- `REPLY_HELP` 定数を追加（コマンド一覧文面）
- `applyHelp(deps, label, channel, ts)` を追加。スレッド返信のみで状態は変えない
- `switch (command.kind)` に `case 'Help'` を追加
- `REPLY_UNKNOWN` の案内文に `help` を追記する

`src/usecase/discover-on-mentioned-channels.ts`

- `DiscoverOnMentionedChannelsDeps` に `discoveryCursor: DiscoveryCursorPort` を追加
- usecase 冒頭で `discoveryCursor.get()` を取得。`undefined` なら現在時刻で初期化して `Processed` (空配列) を返す
- `isCandidate` の判定を `'On' | 'Help'` に拡張し、cursor 以前の ts を除外
- `applyDiscovery` を `On` / `Help` で分岐する関数に分ける
  - `On`: 現行通り（add + enable + cursor 前進 + 返信）
  - `Help`: 返信のみ（registry / control 状態は変えない）
- マッチ処理後、対象になった ts の最大値で `discoveryCursor.set(...)`

### テスト

- `test/control-command.test.ts`: `help` / `ヘルプ` が `Help` にパースされる、メンションなしは `NotForUs`
- `test/process-control-commands.test.ts` (新規): Help 受信で postMessage がコマンド一覧で呼ばれ、`channelControl.setEnabled` / `cursor.clear` は呼ばれない
- `test/discover-on-mentioned-channels.test.ts`:
  - 未登録チャンネル + Help で registry に追加されず、postMessage のみ呼ばれる
  - discovery cursor が更新される
  - cursor より古いマッチは無視される
  - 初回（cursor 未設定）は現在時刻で初期化され、過去のマッチを処理しない

## やらないこと

- ヘルプ文面に現在の enabled 状態や GitHub リンクを含めること（最小スコープに絞るため）
- スレッド内 `help` への応答（既存 on/off と揃え、チャンネル本流のみ）
- `cleanupPosts` / `whoami` 等の管理者向け関数のヘルプ列挙（メンションコマンドではないため）
