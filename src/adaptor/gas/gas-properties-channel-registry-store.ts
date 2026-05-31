import { ChannelId } from '../../domain/channel-id.ts';
import type { ChannelRegistryPort } from '../../domain/channel-registry-port.ts';
import type { LoggerPort } from '../../domain/logger-port.ts';

const KEY_TARGET_CHANNELS = 'TARGET_CHANNELS';

const splitTokens = (raw: string): ReadonlyArray<string> =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const dedupe = (channels: ReadonlyArray<ChannelId>): ReadonlyArray<ChannelId> => {
  const seen = new Set<ChannelId>();
  const out: ChannelId[] = [];
  for (const c of channels) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
};

export const GasPropertiesChannelRegistryStore = {
  create: (logger: LoggerPort): ChannelRegistryPort => {
    const readChannels = (): ReadonlyArray<ChannelId> => {
      const raw = PropertiesService.getScriptProperties().getProperty(KEY_TARGET_CHANNELS) ?? '';
      const tokens = splitTokens(raw);
      const parsed: ChannelId[] = [];
      for (const token of tokens) {
        const res = ChannelId.parse(token);
        if (res.success) {
          parsed.push(res.data);
        } else {
          logger.warn(`channel registry: skipping invalid TARGET_CHANNELS entry "${token}": ${res.error.message}`);
        }
      }
      return dedupe(parsed);
    };

    const writeChannels = (channels: ReadonlyArray<ChannelId>): void => {
      PropertiesService.getScriptProperties().setProperty(KEY_TARGET_CHANNELS, channels.join(','));
    };

    return {
      list: () => readChannels(),
      add: (channel) => {
        const current = readChannels();
        if (current.includes(channel)) return;
        writeChannels([...current, channel]);
      },
    };
  },
} as const;
