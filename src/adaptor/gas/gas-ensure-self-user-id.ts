import { Result } from '@praha/byethrow';

import type { Config } from '../../domain/config.ts';
import type { LoggerPort } from '../../domain/logger-port.ts';
import { SlackApiError } from '../../domain/slack-api-error.ts';
import type { SlackPort } from '../../domain/slack-port.ts';

const KEY_SELF_USER_ID = 'SELF_USER_ID';

// Script Properties に SELF_USER_ID が未設定の場合、auth.test で自己取得して保存する。
// 取得失敗・user_id 不在のときは WARN を残して config をそのまま返す（致命的ではない）。
// 解決済の selfUserId は on/off メンション処理と未登録チャンネル自動追加の検出に使われる。
export const ensureSelfUserId = (
  slack: SlackPort,
  config: Config,
  logger: LoggerPort,
): Config => {
  if (config.selfUserId != null) return config;

  const auth = slack.authTest();
  if (Result.isFailure(auth)) {
    logger.warn(
      `failed to auto-resolve SELF_USER_ID via auth.test: ${SlackApiError.format(auth.error)}`,
    );
    return config;
  }

  const fetched = auth.value.userId;
  if (fetched == null) {
    logger.warn('auth.test did not return user_id; SELF_USER_ID remains unset');
    return config;
  }

  PropertiesService.getScriptProperties().setProperty(KEY_SELF_USER_ID, fetched);
  logger.info(`SELF_USER_ID auto-resolved and stored: ${fetched}`);
  return { ...config, selfUserId: fetched };
};
