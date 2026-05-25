import type { UserId } from './user-id.ts';

export type ControlCommand =
  | Readonly<{ kind: 'NotForUs' }>
  | Readonly<{ kind: 'On' }>
  | Readonly<{ kind: 'Off' }>
  | Readonly<{ kind: 'Help' }>
  | Readonly<{ kind: 'Unknown'; rest: string }>;

const ON_KEYWORDS: ReadonlySet<string> = new Set(['on', 'オン']);
const OFF_KEYWORDS: ReadonlySet<string> = new Set(['off', 'オフ']);
const HELP_KEYWORDS: ReadonlySet<string> = new Set(['help', 'ヘルプ']);

const stripMentions = (text: string, userId: UserId): string => {
  const pattern = new RegExp(`<@${userId}(?:\\|[^>]*)?>`, 'g');
  return text.replace(pattern, ' ');
};

const isMentionedTo = (text: string, userId: UserId): boolean => {
  const pattern = new RegExp(`<@${userId}(?:\\|[^>]*)?>`);
  return pattern.test(text);
};

const parse = (text: string | undefined, userId: UserId): ControlCommand => {
  if (text == null) return { kind: 'NotForUs' };
  if (!isMentionedTo(text, userId)) return { kind: 'NotForUs' };
  const cleaned = stripMentions(text, userId).trim().toLowerCase();
  if (ON_KEYWORDS.has(cleaned)) return { kind: 'On' };
  if (OFF_KEYWORDS.has(cleaned)) return { kind: 'Off' };
  if (HELP_KEYWORDS.has(cleaned)) return { kind: 'Help' };
  return { kind: 'Unknown', rest: cleaned };
};

export const ControlCommand = {
  parse,
} as const;
