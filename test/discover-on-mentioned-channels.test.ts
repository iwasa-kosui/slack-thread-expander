import { Result } from '@praha/byethrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelControlPort } from '../src/domain/channel-control-port.ts';
import { ChannelId } from '../src/domain/channel-id.ts';
import type { ChannelRegistryPort } from '../src/domain/channel-registry-port.ts';
import type { LoggerPort } from '../src/domain/logger-port.ts';
import type { MentionMatch, SlackPort } from '../src/domain/slack-port.ts';
import { SlackTs } from '../src/domain/slack-ts.ts';
import { UserId } from '../src/domain/user-id.ts';
import { discoverOnMentionedChannels } from '../src/usecase/discover-on-mentioned-channels.ts';

const userId = UserId.schema.parse('U0BOT');
const channelA = ChannelId.schema.parse('C_NEW_A');
const channelB = ChannelId.schema.parse('C_NEW_B');
const channelKnown = ChannelId.schema.parse('C_KNOWN');

const ts = (s: string) => SlackTs.schema.parse(s);

const buildMatch = (overrides: Partial<MentionMatch>): MentionMatch => ({
  channel: channelA,
  ts: ts('1700000000.000100'),
  text: `<@${userId}> on`,
  threadTs: undefined,
  ...overrides,
});

type Mocks = Readonly<{
  slack: SlackPort;
  channelRegistry: ChannelRegistryPort;
  channelControl: ChannelControlPort;
  logger: LoggerPort;
  registryAdd: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  setControlCursor: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  searchMentions: ReturnType<typeof vi.fn>;
}>;

const buildMocks = (
  options: {
    known?: ReadonlyArray<ChannelId>;
    matches?: ReadonlyArray<MentionMatch>;
    searchFail?: boolean;
    postFail?: boolean;
  } = {},
): Mocks => {
  const knownChannels: ChannelId[] = [...(options.known ?? [])];
  const registryAdd = vi.fn((channel: ChannelId) => {
    if (!knownChannels.includes(channel)) knownChannels.push(channel);
  });
  const channelRegistry: ChannelRegistryPort = {
    list: () => knownChannels.slice(),
    add: registryAdd,
  };
  const setEnabled = vi.fn();
  const setControlCursor = vi.fn();
  const channelControl: ChannelControlPort = {
    isEnabled: () => false,
    setEnabled,
    getControlCursor: () => undefined,
    setControlCursor,
  };
  const postMessage = vi.fn(() =>
    options.postFail
      ? Result.fail({ kind: 'slack', error: 'not_in_channel' } as const)
      : Result.succeed(undefined)
  );
  const searchMentions = vi.fn(() =>
    options.searchFail
      ? Result.fail({ kind: 'slack', error: 'rate_limited' } as const)
      : Result.succeed({ matches: options.matches ?? [] })
  );
  const slack: SlackPort = {
    getChannelName: () => Result.succeed(undefined),
    searchMessages: () => Result.succeed({ matches: [], apiTotal: undefined }),
    getChannelTopLevelTs: () => Result.succeed({ topLevelTs: [], truncated: false }),
    postMessage,
    listChannelBotMessages: () => Result.succeed({ ts: [], truncated: false }),
    deleteMessage: () => Result.succeed(undefined),
    authTest: () =>
      Result.succeed({
        botId: undefined,
        userId: undefined,
        user: undefined,
        team: undefined,
        teamId: undefined,
        url: undefined,
      }),
    getChannelRecentMessages: () => Result.succeed({ messages: [], truncated: false }),
    searchMentions,
  };
  const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    slack,
    channelRegistry,
    channelControl,
    logger,
    registryAdd,
    setEnabled,
    setControlCursor,
    postMessage,
    searchMentions,
  };
};

const run = (mocks: Mocks, selfUserId = userId) =>
  discoverOnMentionedChannels({
    slack: mocks.slack,
    channelRegistry: mocks.channelRegistry,
    channelControl: mocks.channelControl,
    logger: mocks.logger,
  })(selfUserId);

describe('discoverOnMentionedChannels', () => {
  beforeEach(() => vi.clearAllMocks());

  it('selfUserId が undefined なら Skipped を返し、search.messages は呼ばれない', () => {
    const mocks = buildMocks();
    const outcome = discoverOnMentionedChannels({
      slack: mocks.slack,
      channelRegistry: mocks.channelRegistry,
      channelControl: mocks.channelControl,
      logger: mocks.logger,
    })(undefined);
    expect(outcome.kind).toBe('Skipped');
    if (outcome.kind === 'Skipped') {
      expect(outcome.reason).toBe('NoSelfUserId');
    }
    expect(mocks.searchMentions).not.toHaveBeenCalled();
    expect(mocks.registryAdd).not.toHaveBeenCalled();
  });

  it('search.messages 失敗時は SearchFailed を返し registry は変更しない', () => {
    const mocks = buildMocks({ searchFail: true });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('SearchFailed');
    expect(mocks.registryAdd).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('未登録チャンネルでの @bot on を検出し registry 追加・有効化・カーソル設定・返信を行う', () => {
    const match = buildMatch({ ts: ts('1700000100.000000') });
    const mocks = buildMocks({ matches: [match] });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered).toEqual([{ channel: channelA, ts: ts('1700000100.000000') }]);
    }
    expect(mocks.registryAdd).toHaveBeenCalledWith(channelA);
    expect(mocks.setEnabled).toHaveBeenCalledWith(channelA, true);
    expect(mocks.setControlCursor).toHaveBeenCalledWith(channelA, ts('1700000100.000000'));
    expect(mocks.postMessage).toHaveBeenCalledWith({
      channel: channelA,
      text: expect.stringContaining('ON'),
      threadTs: ts('1700000100.000000'),
    });
  });

  it('既に登録済みのチャンネルは無視する', () => {
    const match = buildMatch({ channel: channelKnown });
    const mocks = buildMocks({ known: [channelKnown], matches: [match] });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered).toHaveLength(0);
    }
    expect(mocks.registryAdd).not.toHaveBeenCalled();
    expect(mocks.setEnabled).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('スレッド内のメンションは無視する', () => {
    const match = buildMatch({ threadTs: ts('1700000050.000000') });
    const mocks = buildMocks({ matches: [match] });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered).toHaveLength(0);
    }
    expect(mocks.registryAdd).not.toHaveBeenCalled();
  });

  it('on 以外のコマンド（off / Unknown / メンションのみ）は無視する', () => {
    const off = buildMatch({ ts: ts('1700000100.000000'), text: `<@${userId}> off` });
    const unknown = buildMatch({
      channel: channelB,
      ts: ts('1700000110.000000'),
      text: `<@${userId}> please stop`,
    });
    const mocks = buildMocks({ matches: [off, unknown] });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered).toHaveLength(0);
    }
    expect(mocks.registryAdd).not.toHaveBeenCalled();
  });

  it('同じチャンネルに複数の on があれば最古の ts でカーソルを進める', () => {
    const older = buildMatch({ ts: ts('1700000100.000000') });
    const newer = buildMatch({ ts: ts('1700000200.000000') });
    const mocks = buildMocks({ matches: [newer, older] });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered).toEqual([{ channel: channelA, ts: ts('1700000100.000000') }]);
    }
    expect(mocks.registryAdd).toHaveBeenCalledTimes(1);
    expect(mocks.setControlCursor).toHaveBeenCalledWith(channelA, ts('1700000100.000000'));
    expect(mocks.postMessage).toHaveBeenCalledOnce();
    expect(mocks.postMessage).toHaveBeenCalledWith({
      channel: channelA,
      text: expect.any(String),
      threadTs: ts('1700000100.000000'),
    });
  });

  it('複数の未登録チャンネルでの on を一括処理する', () => {
    const a = buildMatch({ channel: channelA, ts: ts('1700000100.000000') });
    const b = buildMatch({ channel: channelB, ts: ts('1700000200.000000') });
    const mocks = buildMocks({ matches: [a, b] });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered.map((d) => d.channel)).toEqual([channelA, channelB]);
    }
    expect(mocks.registryAdd).toHaveBeenCalledTimes(2);
    expect(mocks.setEnabled).toHaveBeenCalledTimes(2);
    expect(mocks.postMessage).toHaveBeenCalledTimes(2);
  });

  it('postMessage 失敗時でも registry 追加・有効化は維持し、WARN を残す', () => {
    const match = buildMatch({ ts: ts('1700000100.000000') });
    const mocks = buildMocks({ matches: [match], postFail: true });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered).toHaveLength(1);
    }
    expect(mocks.registryAdd).toHaveBeenCalledWith(channelA);
    expect(mocks.setEnabled).toHaveBeenCalledWith(channelA, true);
    expect(mocks.logger.warn).toHaveBeenCalled();
  });
});
