import type { BotId } from './bot-id.ts';
import type { UserId } from './user-id.ts';

// targetChannels は ChannelRegistryPort 経由で tick ごとに最新を読み直すため、
// ここには含めない。起動時に変わらない値のみを保持する。
export type Config = Readonly<{
  selfBotId: BotId | undefined;
  selfUserId: UserId | undefined;
}>;
