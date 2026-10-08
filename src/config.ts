import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

export const DATA = process.env.BIZBOT_DATA || process.env.CLAUDEBOT_DATA || path.join(ROOT, 'data');
export const HOME = os.homedir();

function num(v: string | undefined): number | undefined {
  const n = Number(v);
  return v && Number.isFinite(n) ? n : undefined;
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  ownerId: num(process.env.TELEGRAM_OWNER_ID),
  timezone: process.env.TZ_NAME || Intl.DateTimeFormat().resolvedOptions().timeZone,
  defaultModel: process.env.DEFAULT_MODEL || undefined,
  browserPort: num(process.env.BROWSER_PORT) ?? 8931,
  browserHeadless: process.env.BROWSER_HEADLESS === '1',
  browserCdpPort: num(process.env.BROWSER_CDP_PORT) ?? 9223,
  opVault: process.env.OP_VAULT || 'BizBot',
  // Claude Code sessions (claude_code tool, /code) do the coding and hard work.
  codeModel: process.env.CODE_MODEL || 'claude-opus-5-5',
  codeEffort: (process.env.CODE_EFFORT || 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  usageBot: process.env.USAGE_BOT || 'meter',
  usageCheckMin: num(process.env.USAGE_CHECK_MIN) ?? 10,
  nightlyCommand: process.env.NIGHTLY_COMMAND || '',
  nightlyAt: process.env.NIGHTLY_AT || '02:15',
  falKey: process.env.FAL_KEY || '',
  falImageModel: process.env.FAL_IMAGE_MODEL || 'fal-ai/flux/dev',
  approvalTimeoutMs: (num(process.env.APPROVAL_TIMEOUT_MIN) ?? 60) * 60_000,
};

export const paths = {
  bots: path.join(DATA, 'bots.json'),
  schedules: path.join(DATA, 'schedules.json'),
  state: path.join(DATA, 'state.json'),
  userMemory: path.join(DATA, 'memory', 'user.md'),
  botDir: (slug: string) => path.join(DATA, 'bots', slug),
  browserProfile: path.join(DATA, 'browser', 'profile'),
  browserOutput: path.join(DATA, 'browser', 'output'),
};

export function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}
