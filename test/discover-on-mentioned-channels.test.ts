import { Result } from '@praha/byethrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelControlPort } from '../src/domain/channel-control-port.ts';
import { ChannelId } from '../src/domain/channel-id.ts';
import type { ChannelRegistryPort } from '../src/domain/channel-registry-port.ts';
import type { ClockPort } from '../src/domain/clock-port.ts';
import type { DiscoveryCursorPort } from '../src/domain/discovery-cursor-port.ts';
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
const initialCursor = ts('1699999000.000000');
const fixedNow = ts('1900000000.000000');

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
  discoveryCursor: DiscoveryCursorPort;
  clock: ClockPort;
  logger: LoggerPort;
  registryAdd: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  setControlCursor: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  searchMentions: ReturnType<typeof vi.fn>;
  discoveryCursorGet: ReturnType<typeof vi.fn>;
  discoveryCursorSet: ReturnType<typeof vi.fn>;
}>;

const buildMocks = (
  options: {
    known?: ReadonlyArray<ChannelId>;
    matches?: ReadonlyArray<MentionMatch>;
    searchFail?: boolean;
    postFail?: boolean;
    cursor?: SlackTs | undefined;
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
  const cursorValue: SlackTs | undefined = 'cursor' in options ? options.cursor : initialCursor;
  const discoveryCursorGet = vi.fn(() => cursorValue);
  const discoveryCursorSet = vi.fn();
  const discoveryCursor: DiscoveryCursorPort = {
    get: discoveryCursorGet,
    set: discoveryCursorSet,
  };
  const clock: ClockPort = {
    nowMs: () => 0,
    nowSlackTs: () => fixedNow,
  };
  const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    slack,
    channelRegistry,
    channelControl,
    discoveryCursor,
    clock,
    logger,
    registryAdd,
    setEnabled,
    setControlCursor,
    postMessage,
    searchMentions,
    discoveryCursorGet,
    discoveryCursorSet,
  };
};

const run = (mocks: Mocks) =>
  discoverOnMentionedChannels({
    slack: mocks.slack,
    channelRegistry: mocks.channelRegistry,
    channelControl: mocks.channelControl,
    discoveryCursor: mocks.discoveryCursor,
    clock: mocks.clock,
    logger: mocks.logger,
  })(userId);

describe('discoverOnMentionedChannels', () => {
  beforeEach(() => vi.clearAllMocks());

  it('selfUserId が undefined なら Skipped を返し、search.messages は呼ばれない', () => {
    const mocks = buildMocks();
    const outcome = discoverOnMentionedChannels({
      slack: mocks.slack,
      channelRegistry: mocks.channelRegistry,
      channelControl: mocks.channelControl,
      discoveryCursor: mocks.discoveryCursor,
      clock: mocks.clock,
      logger: mocks.logger,
    })(undefined);
    expect(outcome.kind).toBe('Skipped');
    if (outcome.kind === 'Skipped') {
      expect(outcome.reason).toBe('NoSelfUserId');
    }
    expect(mocks.searchMentions).not.toHaveBeenCalled();
    expect(mocks.registryAdd).not.toHaveBeenCalled();
    expect(mocks.discoveryCursorSet).not.toHaveBeenCalled();
  });

  it('discovery cursor 未設定なら現在時刻で初期化し、search.messages は呼ばずに空の Processed を返す', () => {
    const match = buildMatch({ ts: ts('1700000100.000000') });
    const mocks = buildMocks({ matches: [match], cursor: undefined });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered).toHaveLength(0);
    }
    expect(mocks.discoveryCursorSet).toHaveBeenCalledWith(fixedNow);
    expect(mocks.searchMentions).not.toHaveBeenCalled();
    expect(mocks.registryAdd).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
  });

  it('search.messages 失敗時は SearchFailed を返し registry は変更しない', () => {
    const mocks = buildMocks({ searchFail: true });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('SearchFailed');
    expect(mocks.registryAdd).not.toHaveBeenCalled();
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(mocks.discoveryCursorSet).not.toHaveBeenCalled();
  });

  it('未登録チャンネルでの @bot on を検出し registry 追加・有効化・カーソル設定・返信を行う', () => {
    const match = buildMatch({ ts: ts('1700000100.000000') });
    const mocks = buildMocks({ matches: [match] });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered).toEqual([
        { kind: 'AutoAdded', channel: channelA, ts: ts('1700000100.000000') },
      ]);
    }
    expect(mocks.registryAdd).toHaveBeenCalledWith(channelA);
    expect(mocks.setEnabled).toHaveBeenCalledWith(channelA, true);
    expect(mocks.setControlCursor).toHaveBeenCalledWith(channelA, ts('1700000100.000000'));
    expect(mocks.postMessage).toHaveBeenCalledWith({
      channel: channelA,
      text: expect.stringContaining('ON'),
      threadTs: ts('1700000100.000000'),
    });
    expect(mocks.discoveryCursorSet).toHaveBeenCalledWith(ts('1700000100.000000'));
  });

  it('未登録チャンネルでの @bot help は registry に追加せず案内のみスレッド返信する', () => {
    const match = buildMatch({
      ts: ts('1700000200.000000'),
      text: `<@${userId}> help`,
    });
    const mocks = buildMocks({ matches: [match] });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered).toEqual([
        { kind: 'HelpReplied', channel: channelA, ts: ts('1700000200.000000') },
      ]);
    }
    expect(mocks.registryAdd).not.toHaveBeenCalled();
    expect(mocks.setEnabled).not.toHaveBeenCalled();
    expect(mocks.setControlCursor).not.toHaveBeenCalled();
    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
    expect(mocks.postMessage).toHaveBeenCalledWith({
      channel: channelA,
      text: expect.stringContaining('利用可能なコマンド'),
      threadTs: ts('1700000200.000000'),
    });
    expect(mocks.discoveryCursorSet).toHaveBeenCalledWith(ts('1700000200.000000'));
  });

  it('discovery cursor 以前のマッチは無視する', () => {
    const stale = buildMatch({ ts: ts('1699998000.000000') });
    const fresh = buildMatch({
      channel: channelB,
      ts: ts('1700000300.000000'),
      text: `<@${userId}> help`,
    });
    const mocks = buildMocks({ matches: [stale, fresh] });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered).toEqual([
        { kind: 'HelpReplied', channel: channelB, ts: ts('1700000300.000000') },
      ]);
    }
    expect(mocks.registryAdd).not.toHaveBeenCalled();
    expect(mocks.discoveryCursorSet).toHaveBeenCalledWith(ts('1700000300.000000'));
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

  it('off / Unknown / メンションのみは無視する', () => {
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
      expect(outcome.discovered).toEqual([
        { kind: 'AutoAdded', channel: channelA, ts: ts('1700000100.000000') },
      ]);
    }
    expect(mocks.registryAdd).toHaveBeenCalledTimes(1);
    expect(mocks.setControlCursor).toHaveBeenCalledWith(channelA, ts('1700000100.000000'));
    expect(mocks.postMessage).toHaveBeenCalledOnce();
    // discovery cursor は dedupe で除外された newer も含めた最大値まで進める
    expect(mocks.discoveryCursorSet).toHaveBeenCalledWith(ts('1700000200.000000'));
  });

  it('複数の未登録チャンネルでの on を一括処理する', () => {
    const a = buildMatch({ channel: channelA, ts: ts('1700000100.000000') });
    const b = buildMatch({ channel: channelB, ts: ts('1700000200.000000') });
    const mocks = buildMocks({ matches: [a, b] });
    const outcome = run(mocks);
    expect(outcome.kind).toBe('Processed');
    if (outcome.kind === 'Processed') {
      expect(outcome.discovered.map((d) => d.channel)).toEqual([channelA, channelB]);
      expect(outcome.discovered.every((d) => d.kind === 'AutoAdded')).toBe(true);
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
