import { Result } from '@praha/byethrow';

import type { Config } from '../../domain/config.ts';
import type { LoggerPort } from '../../domain/logger-port.ts';
import { SlackApiError } from '../../domain/slack-api-error.ts';
import type { SlackPort } from '../../domain/slack-port.ts';

const KEY_SELF_BOT_ID = 'SELF_BOT_ID';

// Script Properties に SELF_BOT_ID が未設定の場合、auth.test で自己取得して保存する。
// 取得失敗・bot_id 不在のときは WARN を残して config をそのまま返す（致命的ではない）。
// 解決済の selfBotId は expand の skippedOwn 判定や cleanup の対象判定に使われる。
export const ensureSelfBotId = (slack: SlackPort, config: Config, logger: LoggerPort): Config => {
  if (config.selfBotId != null) return config;

  const auth = slack.authTest();
  if (Result.isFailure(auth)) {
    logger.warn(`failed to auto-resolve SELF_BOT_ID via auth.test: ${SlackApiError.format(auth.error)}`);
    return config;
  }

  const fetched = auth.value.botId;
  if (fetched == null) {
    logger.warn('auth.test did not return bot_id; SELF_BOT_ID remains unset');
    return config;
  }

  PropertiesService.getScriptProperties().setProperty(KEY_SELF_BOT_ID, fetched);
  logger.info(`SELF_BOT_ID auto-resolved and stored: ${fetched}`);
  return { ...config, selfBotId: fetched };
};
