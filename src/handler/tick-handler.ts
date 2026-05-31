import { Result } from '@praha/byethrow';

import { loadGasBootstrap } from '../adaptor/gas/gas-bootstrap.ts';
import { GasClock } from '../adaptor/gas/gas-clock.ts';
import { GasConsoleLogger } from '../adaptor/gas/gas-console-logger.ts';
import { ensureSelfBotId } from '../adaptor/gas/gas-ensure-self-bot-id.ts';
import { ensureSelfUserId } from '../adaptor/gas/gas-ensure-self-user-id.ts';
import { GasLockService } from '../adaptor/gas/gas-lock-service.ts';
import { GasPropertiesChannelControlStore } from '../adaptor/gas/gas-properties-channel-control-store.ts';
import { GasPropertiesChannelRegistryStore } from '../adaptor/gas/gas-properties-channel-registry-store.ts';
import { GasPropertiesCursorStore } from '../adaptor/gas/gas-properties-cursor-store.ts';
import { GasPropertiesDiscoveryCursorStore } from '../adaptor/gas/gas-properties-discovery-cursor-store.ts';
import { SlackHttpClient } from '../adaptor/slack/slack-http-client.ts';
import { ConfigError } from '../domain/config-error.ts';
import { runTick } from '../usecase/run-tick.ts';

export const tickHandler = (): void => {
  const logger = GasConsoleLogger.create();
  const bootRes = loadGasBootstrap();
  if (Result.isFailure(bootRes)) {
    logger.error(`failed to load config: ${ConfigError.format(bootRes.error)}`);
    return;
  }
  const { slackCredentials, config } = bootRes.value;
  const slack = SlackHttpClient.create(slackCredentials);
  const resolvedConfig = ensureSelfUserId(slack, ensureSelfBotId(slack, config, logger), logger);
  const cursor = GasPropertiesCursorStore.create();
  const channelControl = GasPropertiesChannelControlStore.create();
  const channelRegistry = GasPropertiesChannelRegistryStore.create(logger);
  const discoveryCursor = GasPropertiesDiscoveryCursorStore.create();
  const clock = GasClock.create();
  const lock = GasLockService.create();
  runTick({
    slack,
    cursor,
    channelControl,
    channelRegistry,
    discoveryCursor,
    clock,
    lock,
    logger,
  })(resolvedConfig);
};
