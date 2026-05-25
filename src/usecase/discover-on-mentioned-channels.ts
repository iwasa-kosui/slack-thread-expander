import { Result } from '@praha/byethrow';

import type { ChannelControlPort } from '../domain/channel-control-port.ts';
import type { ChannelDiscoveryOutcome, DiscoveredChannel } from '../domain/channel-discovery-outcome.ts';
import type { ChannelId } from '../domain/channel-id.ts';
import type { ChannelRegistryPort } from '../domain/channel-registry-port.ts';
import { ControlCommand } from '../domain/control-command.ts';
import type { LoggerPort } from '../domain/logger-port.ts';
import { SlackApiError } from '../domain/slack-api-error.ts';
import type { MentionMatch, SlackPort } from '../domain/slack-port.ts';
import { SlackTs } from '../domain/slack-ts.ts';
import type { UserId } from '../domain/user-id.ts';

export type DiscoverOnMentionedChannelsDeps = Readonly<{
  slack: SlackPort;
  channelRegistry: ChannelRegistryPort;
  channelControl: ChannelControlPort;
  logger: LoggerPort;
}>;

// `processControlCommands` の REPLY_ON と同等。auto-add 起点であることはログ側で示す。
const REPLY_ON = 'スレッド展開を ON にしました。今後の新規スレッド返信を対象に展開します。';

// 1 回の検索で 1 チャンネルに対し複数の `on` メンションが返ったとき、
// 最も古い ts を残し、コントロールカーソルをそこまで進める。
// こうすると後段の processControlCommands は同じ on メッセージを再処理しない。
const dedupeByChannelKeepingOldest = (
  matches: ReadonlyArray<MentionMatch>,
): ReadonlyArray<MentionMatch> => {
  const sorted = matches.slice().sort((a, b) => SlackTs.compareAsc(a.ts, b.ts));
  const seen = new Set<ChannelId>();
  const out: MentionMatch[] = [];
  for (const m of sorted) {
    if (seen.has(m.channel)) continue;
    seen.add(m.channel);
    out.push(m);
  }
  return out;
};

const isCandidate = (
  match: MentionMatch,
  selfUserId: UserId,
  known: ReadonlySet<ChannelId>,
): boolean => {
  // スレッド内メンションは対象外（コントロールコマンドの仕様と揃える）。
  if (match.threadTs != null) return false;
  // 既に TARGET_CHANNELS に登録済みなら processControlCommands に委ねる。
  if (known.has(match.channel)) return false;
  // `on` / `オン` のみを auto-add のトリガーとする。off / Unknown は無視。
  return ControlCommand.parse(match.text, selfUserId).kind === 'On';
};

const applyDiscovery = (
  deps: DiscoverOnMentionedChannelsDeps,
  match: MentionMatch,
): DiscoveredChannel => {
  const label = `[${match.channel}]`;
  deps.channelRegistry.add(match.channel);
  deps.channelControl.setEnabled(match.channel, true);
  // 同じ on メッセージを直後の processControlCommands で再処理させないよう
  // コントロールカーソルを当該 ts まで進めておく。
  deps.channelControl.setControlCursor(match.channel, match.ts);
  const replyRes = deps.slack.postMessage({
    channel: match.channel,
    text: REPLY_ON,
    threadTs: match.ts,
  });
  if (Result.isFailure(replyRes)) {
    deps.logger.warn(
      `${label} discovery: auto-added & enabled via mention ts=${match.ts}, but failed to reply: ${
        SlackApiError.format(replyRes.error)
      }`,
    );
  } else {
    deps.logger.info(
      `${label} discovery: auto-added & enabled via mention ts=${match.ts}`,
    );
  }
  return { channel: match.channel, ts: match.ts };
};

export const discoverOnMentionedChannels =
  (deps: DiscoverOnMentionedChannelsDeps) => (selfUserId: UserId | undefined): ChannelDiscoveryOutcome => {
    if (selfUserId == null) {
      deps.logger.warn(
        'SELF_USER_ID is not configured. Skipping channel discovery via mentions.',
      );
      return { kind: 'Skipped', reason: 'NoSelfUserId' };
    }

    const searched = deps.slack.searchMentions(selfUserId);
    if (Result.isFailure(searched)) {
      deps.logger.warn(
        `channel discovery: search.messages failed: ${SlackApiError.format(searched.error)}`,
      );
      return { kind: 'SearchFailed', error: searched.error };
    }

    const known = new Set(deps.channelRegistry.list());
    const candidates = searched.value.matches.filter((m) => isCandidate(m, selfUserId, known));
    const targets = dedupeByChannelKeepingOldest(candidates);

    const discovered = targets.map((m) => applyDiscovery(deps, m));
    return { kind: 'Processed', discovered };
  };
