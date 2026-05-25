import type { ChannelControlPort } from '../domain/channel-control-port.ts';
import { ChannelDiscoveryOutcome } from '../domain/channel-discovery-outcome.ts';
import type { ChannelRegistryPort } from '../domain/channel-registry-port.ts';
import { ChannelTickOutcome } from '../domain/channel-tick-outcome.ts';
import type { ClockPort } from '../domain/clock-port.ts';
import type { Config } from '../domain/config.ts';
import type { CursorPort } from '../domain/cursor-port.ts';
import type { LockPort } from '../domain/lock-port.ts';
import type { LoggerPort } from '../domain/logger-port.ts';
import { SlackApiError } from '../domain/slack-api-error.ts';
import type { SlackPort } from '../domain/slack-port.ts';
import { assertNever } from '../util/assert-never.ts';
import { discoverOnMentionedChannels } from './discover-on-mentioned-channels.ts';
import { expandChannel } from './expand-channel.ts';
import { processControlCommands } from './process-control-commands.ts';

export type RunTickDeps = Readonly<{
  slack: SlackPort;
  cursor: CursorPort;
  channelControl: ChannelControlPort;
  channelRegistry: ChannelRegistryPort;
  clock: ClockPort;
  lock: LockPort;
  logger: LoggerPort;
}>;

const formatOutcomeSummary = (outcome: ChannelTickOutcome): string => {
  switch (outcome.kind) {
    case 'Initialized':
      return `[${outcome.channel}] summary: initialized lastTs=${outcome.initialTs}`;
    case 'Disabled':
      return `[${outcome.channel}] summary: disabled (awaiting @bot on)`;
    case 'ChannelInfoFailed':
      return `[${outcome.channel}] summary: conversations.info failed - ${SlackApiError.format(outcome.error)}`;
    case 'ChannelNameMissing':
      return `[${outcome.channel}] summary: channel name missing`;
    case 'SearchFailed':
      return `[${outcome.channel} #${outcome.channelName}] summary: search.messages failed - ${
        SlackApiError.format(outcome.error)
      }`;
    case 'HistoryFailed':
      return `[${outcome.channel} #${outcome.channelName}] summary: conversations.history failed - ${
        SlackApiError.format(outcome.error)
      }`;
    case 'Processed':
      return `[${outcome.channel} #${outcome.channelName}] summary: fetched=${outcome.fetched} candidates=${outcome.candidates} expanded=${outcome.expanded} skippedOwn=${outcome.skippedOwn} skippedNoReply=${outcome.skippedNoReply} skippedBroadcast=${outcome.skippedBroadcast} errors=${outcome.errors.length}`;
    default:
      return assertNever(outcome);
  }
};

const formatDiscoverySummary = (outcome: ChannelDiscoveryOutcome): string => {
  switch (outcome.kind) {
    case 'Skipped':
      return `discovery: skipped (reason=${outcome.reason})`;
    case 'SearchFailed':
      return `discovery: search.messages failed - ${SlackApiError.format(outcome.error)}`;
    case 'Processed':
      return `discovery: added=${ChannelDiscoveryOutcome.addedCount(outcome)} channels=[${
        outcome.discovered.map((d) => d.channel).join(',')
      }]`;
    default:
      return assertNever(outcome);
  }
};

const sum = (
  outcomes: ReadonlyArray<ChannelTickOutcome>,
  pick: (o: ChannelTickOutcome) => number,
): number => outcomes.reduce((acc, o) => acc + pick(o), 0);

const runBody = (deps: RunTickDeps, config: Config): void => {
  const tickStartMs = deps.clock.nowMs();

  // 1) 未登録チャンネルでの `@bot on` メンションを拾い、TARGET_CHANNELS に追加する。
  // search.messages 失敗時は WARN を吐いて続行する（既存チャンネルの処理は止めない）。
  const discoveryOutcome = discoverOnMentionedChannels({
    slack: deps.slack,
    channelRegistry: deps.channelRegistry,
    channelControl: deps.channelControl,
    logger: deps.logger,
  })(config.selfUserId);
  deps.logger.info(formatDiscoverySummary(discoveryOutcome));

  // 2) discover で追加された分も含めて最新の TARGET_CHANNELS を取得する。
  const targetChannels = deps.channelRegistry.list();
  if (targetChannels.length === 0) {
    deps.logger.warn(
      'TARGET_CHANNELS is empty. Set channel IDs (comma-separated) in Script Properties.',
    );
    return;
  }
  deps.logger.info(
    `tick start: channels=[${targetChannels.join(',')}] selfBotId=${config.selfBotId ?? 'unset'} selfUserId=${
      config.selfUserId ?? 'unset'
    }`,
  );

  // 3) expand 前にコントロールコマンド (@bot on/off) を反映する。
  // off は LAST_TS を消し、その後 on にした時に再展開されないようにする。
  const controlOutcomes = processControlCommands({
    slack: deps.slack,
    cursor: deps.cursor,
    channelControl: deps.channelControl,
    clock: deps.clock,
    logger: deps.logger,
  })(targetChannels, config.selfUserId);
  const controlApplied = controlOutcomes.reduce((acc, o) => acc + o.applied.length, 0);
  if (controlApplied > 0) {
    deps.logger.info(`control commands applied: ${controlApplied}`);
  }

  // 4) スレッド返信を本流に展開する。
  const expand = expandChannel({
    slack: deps.slack,
    cursor: deps.cursor,
    channelControl: deps.channelControl,
    clock: deps.clock,
    logger: deps.logger,
  });

  const outcomes = targetChannels.map((channel) => {
    const outcome = expand(channel, config.selfBotId);
    deps.logger.info(formatOutcomeSummary(outcome));
    return outcome;
  });

  const totalFetched = sum(outcomes, ChannelTickOutcome.fetchedCount);
  const totalExpanded = sum(outcomes, ChannelTickOutcome.expandedCount);
  const totalErrors = sum(outcomes, ChannelTickOutcome.errorCount);
  const totalSkippedOwn = sum(outcomes, ChannelTickOutcome.skippedOwnCount);
  const totalSkippedNoReply = sum(outcomes, ChannelTickOutcome.skippedNoReplyCount);
  const totalSkippedBroadcast = sum(outcomes, ChannelTickOutcome.skippedBroadcastCount);
  const elapsedMs = deps.clock.nowMs() - tickStartMs;

  deps.logger.info(
    `tick end: channels=${targetChannels.length} fetched=${totalFetched} expanded=${totalExpanded} skippedOwn=${totalSkippedOwn} skippedNoReply=${totalSkippedNoReply} skippedBroadcast=${totalSkippedBroadcast} errors=${totalErrors} elapsedMs=${elapsedMs}`,
  );
};

export const runTick = (deps: RunTickDeps) => (config: Config): void => {
  const acquired = deps.lock.tryRun(() => runBody(deps, config));
  if (!acquired) {
    deps.logger.info('previous tick still running; skip');
  }
};
