import type { DiscoveryCursorPort } from '../../domain/discovery-cursor-port.ts';
import { SlackTs } from '../../domain/slack-ts.ts';

const KEY = 'DISCOVERY_LAST_TS';

export const GasPropertiesDiscoveryCursorStore = {
  create: (): DiscoveryCursorPort => ({
    get: () => {
      const raw = PropertiesService.getScriptProperties().getProperty(KEY);
      if (raw == null) return undefined;
      const parsed = SlackTs.parse(raw);
      return parsed.success ? parsed.data : undefined;
    },
    set: (ts) => {
      PropertiesService.getScriptProperties().setProperty(KEY, ts);
    },
  }),
} as const;
