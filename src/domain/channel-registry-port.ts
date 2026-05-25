import type { ChannelId } from './channel-id.ts';

// TARGET_CHANNELS の永続化を抽象化するポート。
// list() は呼び出し時点で永続化層から最新のスナップショットを返す。
// add() は既に登録済みのチャンネルに対しては no-op となる（冪等）。
// 排他制御は runTick 全体を覆う LockPort.tryRun に委ねており、
// この Port 自身は内部ロックを持たない。
export type ChannelRegistryPort = Readonly<{
  list: () => ReadonlyArray<ChannelId>;
  add: (channel: ChannelId) => void;
}>;
