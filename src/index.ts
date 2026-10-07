import { config, log } from './config.ts';
import { startBrowserServer, stopBrowserServer } from './browser.ts';
import * as scheduler from './scheduler.ts';
import { bots, ensureBotDirs, state } from './store.ts';
import { getTemplate } from './templates.ts';
import { startTelegram } from './telegram.ts';
import { startUsageMonitor } from './usage.ts';

// The SDK spawns Claude Code; make sure a parent Claude Code session's env doesn't leak in.
for (const k of Object.keys(process.env)) if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_')) delete process.env[k];

if (!config.telegramToken) {
  console.error('ClaudeBot needs a Telegram bot token.\n  1. In Telegram, message @BotFather, send /newbot and copy the token.\n  2. cp .env.example .env and set TELEGRAM_BOT_TOKEN=<token>\n  3. npm start');
  process.exit(1);
}

if (!bots.all().length) {
  const b = bots.create(
    'Claude',
    'Chief of staff and general assistant: research, email, calendar, files, browsing and coding. Delegates to specialist teammates when that helps.',
  );
  state.set({ activeBot: b.slug });
  log('[setup] created default bot "Claude"');
}
for (const b of bots.all()) ensureBotDirs(b.slug);

startBrowserServer();
const telegram = startTelegram();
scheduler.loadAll();
const meter = bots.find(config.usageBot) ?? bots.all().find((b) => b.template && getTemplate(b.template)?.usageMonitor);
if (meter) startUsageMonitor(meter.slug);
log(`[claudebot] up · timezone ${config.timezone} · ${bots.all().length} bot(s)`);
void telegram.notifyOwner('🟢 ClaudeBot is online.').catch(() => {});

function shutdown(sig: string) {
  log(`[claudebot] ${sig} — shutting down`);
  stopBrowserServer();
  void telegram.stop();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => log('[claudebot] unhandled rejection', e));
