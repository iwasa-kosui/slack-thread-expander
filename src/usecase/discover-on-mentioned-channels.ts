import { Result } from '@praha/byethrow';

import type { ChannelControlPort } from '../domain/channel-control-port.ts';
import type { ChannelDiscoveryOutcome, DiscoveredChannel } from '../domain/channel-discovery-outcome.ts';
import type { ChannelId } from '../domain/channel-id.ts';
import type { ChannelRegistryPort } from '../domain/channel-registry-port.ts';
import type { ClockPort } from '../domain/clock-port.ts';
import { ControlCommand } from '../domain/control-command.ts';
import type { DiscoveryCursorPort } from '../domain/discovery-cursor-port.ts';
import type { LoggerPort } from '../domain/logger-port.ts';
import { SlackApiError } from '../domain/slack-api-error.ts';
import type { MentionMatch, SlackPort } from '../domain/slack-port.ts';
import { SlackTs } from '../domain/slack-ts.ts';
import type { UserId } from '../domain/user-id.ts';
import { assertNever } from '../util/assert-never.ts';
import { REPLY_HELP } from './process-control-commands.ts';

export type DiscoverOnMentionedChannelsDeps = Readonly<{
  slack: SlackPort;
  channelRegistry: ChannelRegistryPort;
  channelControl: ChannelControlPort;
  discoveryCursor: DiscoveryCursorPort;
  clock: ClockPort;
  logger: LoggerPort;
}>;

// `processControlCommands` の REPLY_ON と同等。auto-add 起点であることはログ側で示す。
const REPLY_ON = 'スレッド展開を ON にしました。今後の新規スレッド返信を対象に展開します。';

type TriggerKind = 'On' | 'Help';

const triggerKindOf = (match: MentionMatch, selfUserId: UserId): TriggerKind | undefined => {
  const command = ControlCommand.parse(match.text, selfUserId);
  if (command.kind === 'On') return 'On';
  if (command.kind === 'Help') return 'Help';
  return undefined;
};

// 1 回の検索で 1 チャンネルに対し複数の `on` メンションが返ったとき、
// 最も古い ts を残し、後段の processControlCommands が同じ on を再処理しないよう
// コントロールカーソルをそこまで進める。Help は副作用が状態に届かないので
// dedupe 対象外（同 tick に複数件あっても全件返信する）。
const dedupeAutoAddByChannelKeepingOldest = (
  matches: ReadonlyArray<MentionMatch>,
  selfUserId: UserId,
): ReadonlyArray<MentionMatch> => {
  const sorted = matches.slice().sort((a, b) => SlackTs.compareAsc(a.ts, b.ts));
  const seen = new Set<ChannelId>();
  const out: MentionMatch[] = [];
  for (const m of sorted) {
    const kind = triggerKindOf(m, selfUserId);
    if (kind !== 'On') {
      out.push(m);
      continue;
    }
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
  cursor: SlackTs,
): boolean => {
  // スレッド内メンションは対象外（コントロールコマンドの仕様と揃える）。
  if (match.threadTs != null) return false;
  // 既に TARGET_CHANNELS に登録済みなら processControlCommands に委ねる。
  if (known.has(match.channel)) return false;
  // discovery cursor 以前のマッチは「処理済み」とみなして弾く。
  // 同じ help / on メッセージへの重複応答を防ぐカーソル。
  if (!SlackTs.isAfter(match.ts, cursor)) return false;
  return triggerKindOf(match, selfUserId) != null;
};

const applyAutoAdd = (deps: DiscoverOnMentionedChannelsDeps, match: MentionMatch): DiscoveredChannel => {
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
      `${label} discovery: auto-added & enabled via mention ts=${match.ts}, but failed to reply: ${SlackApiError.format(
        replyRes.error,
      )}`,
    );
  } else {
    deps.logger.info(`${label} discovery: auto-added & enabled via mention ts=${match.ts}`);
  }
  return { kind: 'AutoAdded', channel: match.channel, ts: match.ts };
};

const applyHelpReply = (deps: DiscoverOnMentionedChannelsDeps, match: MentionMatch): DiscoveredChannel => {
  const label = `[${match.channel}]`;
  const replyRes = deps.slack.postMessage({
    channel: match.channel,
    text: REPLY_HELP,
    threadTs: match.ts,
  });
  if (Result.isFailure(replyRes)) {
    deps.logger.warn(
      `${label} discovery: help replied to unregistered channel ts=${match.ts}, but failed to post: ${SlackApiError.format(
        replyRes.error,
      )}`,
    );
  } else {
    deps.logger.info(`${label} discovery: help replied to unregistered channel ts=${match.ts}`);
  }
  return { kind: 'HelpReplied', channel: match.channel, ts: match.ts };
};

const applyDiscovery = (
  deps: DiscoverOnMentionedChannelsDeps,
  match: MentionMatch,
  kind: TriggerKind,
): DiscoveredChannel => {
  switch (kind) {
    case 'On':
      return applyAutoAdd(deps, match);
    case 'Help':
      return applyHelpReply(deps, match);
    default:
      return assertNever(kind);
  }
};

export const discoverOnMentionedChannels =
  (deps: DiscoverOnMentionedChannelsDeps) =>
  (selfUserId: UserId | undefined): ChannelDiscoveryOutcome => {
    if (selfUserId == null) {
      deps.logger.warn('SELF_USER_ID is not configured. Skipping channel discovery via mentions.');
      return { kind: 'Skipped', reason: 'NoSelfUserId' };
    }

    // discovery cursor 未設定なら「今」で初期化し、過去のメンションを遡及しない。
    const existingCursor = deps.discoveryCursor.get();
    if (existingCursor == null) {
      const initial = deps.clock.nowSlackTs();
      deps.discoveryCursor.set(initial);
      deps.logger.info(`discovery: initial cursor set to ${initial}`);
      return { kind: 'Processed', discovered: [] };
    }

    const searched = deps.slack.searchMentions(selfUserId);
    if (Result.isFailure(searched)) {
      deps.logger.warn(`channel discovery: search.messages failed: ${SlackApiError.format(searched.error)}`);
      return { kind: 'SearchFailed', error: searched.error };
    }

    const known = new Set(deps.channelRegistry.list());
    const candidates = searched.value.matches.filter((m) => isCandidate(m, selfUserId, known, existingCursor));
    const targets = dedupeAutoAddByChannelKeepingOldest(candidates, selfUserId);

    const discovered = targets
      .map((m): DiscoveredChannel | undefined => {
        const kind = triggerKindOf(m, selfUserId);
        if (kind == null) return undefined;
        return applyDiscovery(deps, m, kind);
      })
      .filter((d): d is DiscoveredChannel => d != null);

    // 処理対象になった全マッチ (`candidates`) の最大 ts までカーソルを進める。
    // `targets` は dedupe で一部しか残らないため、candidates 全体から最大を取らないと
    // 「同 tick で dedupe された newer な On」が次 tick で再検出されてしまう。
    const maxSeen = candidates.reduce<SlackTs>((acc, m) => SlackTs.max(acc, m.ts), existingCursor);
    if (maxSeen !== existingCursor) {
      deps.discoveryCursor.set(maxSeen);
    }

    return { kind: 'Processed', discovered };
  };
