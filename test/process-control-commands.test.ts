import { Result } from '@praha/byethrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelControlPort } from '../src/domain/channel-control-port.ts';
import { ChannelId } from '../src/domain/channel-id.ts';
import type { ClockPort } from '../src/domain/clock-port.ts';
import type { CursorPort } from '../src/domain/cursor-port.ts';
import type { LoggerPort } from '../src/domain/logger-port.ts';
import type { RecentMessage, SlackPort } from '../src/domain/slack-port.ts';
import { SlackTs } from '../src/domain/slack-ts.ts';
import { UserId } from '../src/domain/user-id.ts';
import { processControlCommands } from '../src/usecase/process-control-commands.ts';

const userId = UserId.schema.parse('U0BOT');
const channel = ChannelId.schema.parse('C_MAIN');
const ts = (s: string) => SlackTs.schema.parse(s);
const initialCursor = ts('1700000000.000000');
const fixedNow = ts('1900000000.000000');

const userMessage = (overrides: Partial<RecentMessage>): RecentMessage => ({
  ts: ts('1700000100.000000'),
  text: undefined,
  user: UserId.schema.parse('U_USER'),
  botId: undefined,
  subtype: undefined,
  threadTs: undefined,
  ...overrides,
});

type Mocks = Readonly<{
  slack: SlackPort;
  cursor: CursorPort;
  channelControl: ChannelControlPort;
  clock: ClockPort;
  logger: LoggerPort;
  postMessage: ReturnType<typeof vi.fn>;
  getChannelRecentMessages: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
  setControlCursor: ReturnType<typeof vi.fn>;
  cursorClear: ReturnType<typeof vi.fn>;
}>;

const buildMocks = (
  options: {
    messages?: ReadonlyArray<RecentMessage>;
    controlCursor?: SlackTs | undefined;
    enabled?: boolean;
  } = {},
): Mocks => {
  const postMessage = vi.fn(() => Result.succeed(undefined));
  const getChannelRecentMessages = vi.fn(() => Result.succeed({ messages: options.messages ?? [], truncated: false }));
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
    getChannelRecentMessages,
    searchMentions: () => Result.succeed({ matches: [] }),
  };
  const cursorClear = vi.fn();
  const cursor: CursorPort = {
    get: () => undefined,
    set: vi.fn(),
    clear: cursorClear,
  };
  const setEnabled = vi.fn();
  const setControlCursor = vi.fn();
  const controlCursorValue: SlackTs | undefined = 'controlCursor' in options
    ? options.controlCursor
    : initialCursor;
  const channelControl: ChannelControlPort = {
    isEnabled: () => options.enabled ?? false,
    setEnabled,
    getControlCursor: () => controlCursorValue,
    setControlCursor,
  };
  const clock: ClockPort = { nowMs: () => 0, nowSlackTs: () => fixedNow };
  const logger: LoggerPort = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    slack,
    cursor,
    channelControl,
    clock,
    logger,
    postMessage,
    getChannelRecentMessages,
    setEnabled,
    setControlCursor,
    cursorClear,
  };
};

const run = (mocks: Mocks) =>
  processControlCommands({
    slack: mocks.slack,
    cursor: mocks.cursor,
    channelControl: mocks.channelControl,
    clock: mocks.clock,
    logger: mocks.logger,
  })([channel], userId);

describe('processControlCommands', () => {
  beforeEach(() => vi.clearAllMocks());

  it('selfUserId が undefined なら空配列を返し、何も呼ばない', () => {
    const mocks = buildMocks();
    const outcomes = processControlCommands({
      slack: mocks.slack,
      cursor: mocks.cursor,
      channelControl: mocks.channelControl,
      clock: mocks.clock,
      logger: mocks.logger,
    })([channel], undefined);
    expect(outcomes).toHaveLength(0);
    expect(mocks.getChannelRecentMessages).not.toHaveBeenCalled();
  });

  it('@bot help を受けたらコマンド一覧をスレッド返信し、状態は変えない', () => {
    const msg = userMessage({ ts: ts('1700000500.000000'), text: `<@${userId}> help` });
    const mocks = buildMocks({ messages: [msg] });

    const outcomes = run(mocks);

    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
    expect(mocks.postMessage).toHaveBeenCalledWith({
      channel,
      text: expect.stringContaining('利用可能なコマンド'),
      threadTs: ts('1700000500.000000'),
    });
    expect(mocks.setEnabled).not.toHaveBeenCalled();
    expect(mocks.cursorClear).not.toHaveBeenCalled();
    expect(mocks.setControlCursor).toHaveBeenCalledWith(channel, ts('1700000500.000000'));
    expect(outcomes[0]?.applied).toEqual([{ ts: ts('1700000500.000000'), kind: 'Help' }]);
    expect(outcomes[0]?.enabledAfter).toBe(false);
  });

  it('@bot ヘルプ も Help として扱う', () => {
    const msg = userMessage({ ts: ts('1700000600.000000'), text: `<@${userId}> ヘルプ` });
    const mocks = buildMocks({ messages: [msg] });

    run(mocks);

    expect(mocks.postMessage).toHaveBeenCalledWith({
      channel,
      text: expect.stringContaining('利用可能なコマンド'),
      threadTs: ts('1700000600.000000'),
    });
  });

  it('Unknown の案内文にも help が含まれる', () => {
    const msg = userMessage({ ts: ts('1700000700.000000'), text: `<@${userId}> please stop` });
    const mocks = buildMocks({ messages: [msg] });

    run(mocks);

    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
    const call = mocks.postMessage.mock.calls[0]?.[0];
    expect(call?.text).toContain('help');
  });

  it('controlCursor 未設定なら初期化のみ実施し help 応答もしない', () => {
    const msg = userMessage({ ts: ts('1700000500.000000'), text: `<@${userId}> help` });
    const mocks = buildMocks({ messages: [msg], controlCursor: undefined });

    const outcomes = run(mocks);

    expect(mocks.setControlCursor).toHaveBeenCalledWith(channel, fixedNow);
    expect(mocks.postMessage).not.toHaveBeenCalled();
    expect(outcomes[0]?.applied).toHaveLength(0);
  });
});
