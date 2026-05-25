import { assertNever } from '../util/assert-never.ts';
import type { ChannelId } from './channel-id.ts';
import type { SlackApiError } from './slack-api-error.ts';
import type { SlackTs } from './slack-ts.ts';

export type DiscoveredChannel = Readonly<{
  channel: ChannelId;
  ts: SlackTs;
}>;

export type ChannelDiscoveryOutcome =
  | Readonly<{ kind: 'Skipped'; reason: 'NoSelfUserId' }>
  | Readonly<{ kind: 'SearchFailed'; error: SlackApiError }>
  | Readonly<{ kind: 'Processed'; discovered: ReadonlyArray<DiscoveredChannel> }>;

const addedCount = (outcome: ChannelDiscoveryOutcome): number => {
  switch (outcome.kind) {
    case 'Skipped':
    case 'SearchFailed':
      return 0;
    case 'Processed':
      return outcome.discovered.length;
    default:
      return assertNever(outcome);
  }
};

export const ChannelDiscoveryOutcome = {
  addedCount,
} as const;
