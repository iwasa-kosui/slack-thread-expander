import type { SlackTs } from './slack-ts.ts';

// 未登録チャンネル向けメンション検出 (`discoverOnMentionedChannels`) の進捗カーソル。
// これより古い `search.messages` のマッチは「既に処理済み」とみなして無視する。
// チャンネル別ではなくグローバルな単一値（最後に検査した ts の最大値）。
export type DiscoveryCursorPort = Readonly<{
  get: () => SlackTs | undefined;
  set: (ts: SlackTs) => void;
}>;
