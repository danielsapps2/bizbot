import { Cron } from 'croner';
import { log } from './config.ts';
import { runBot } from './agent.ts';
import { bots, schedules, type Schedule } from './store.ts';
import { ui } from './ui.ts';
import { fetchUsage } from './usage.ts';

const jobs = new Map<string, Cron>();

const isOneShot = (when: string) => /^\d{4}-\d{2}-\d{2}/.test(when.trim());

/** Throws if `when` is not a valid cron expression / future datetime; returns the next run. */
export function validate(when: string, timezone: string): Date {
  const probe = new Cron(when.trim(), { timezone, paused: true });
  const next = probe.nextRun();
  probe.stop();
  if (!next) throw new Error(`"${when}" never runs (past date?)`);
  return next;
}

export function nextRun(s: Schedule): Date | null {
  return jobs.get(s.id)?.nextRun() ?? null;
}

export function register(s: Schedule) {
  unregister(s.id);
  if (!s.enabled) return;
  try {
    jobs.set(s.id, new Cron(s.when.trim(), { timezone: s.timezone, protect: true }, () => void fire(s.id)));
  } catch (e) {
    log(`[schedule] cannot register ${s.id}:`, e);
  }
}

export function unregister(id: string) {
  jobs.get(id)?.stop();
  jobs.delete(id);
}

export function loadAll() {
  for (const s of schedules.all()) register(s);
  log(`[schedule] ${jobs.size} active schedule(s)`);
}

export async function fire(id: string) {
  const s = schedules.all().find((x) => x.id === id);
  if (!s) return;
  const bot = bots.find(s.bot);
  if (!bot) return void ui().send(`⏰ Schedule **${s.name}** skipped: bot ${s.bot} no longer exists.`, 'team');
  if (s.maxUsage) {
    const high = await fetchUsage().then((u) => u.windows.find((w) => (w.key === 'five_hour' || w.key === 'seven_day') && w.pct >= s.maxUsage!)).catch(() => undefined);
    if (high) {
      log(`[schedule] skipping ${s.id} (${s.name}): ${high.label} at ${high.pct}%`);
      schedules.update(s.id, { lastRun: new Date().toISOString(), lastStatus: `skipped: ${high.label} ${Math.round(high.pct)}%` });
      return;
    }
  }
  log(`[schedule] firing ${s.id} (${s.name}) on ${bot.slug}`);
  const res = await runBot({
    slug: bot.slug,
    origin: 'schedule',
    title: `⏰ ${s.name}`,
    quiet: s.quiet,
    prompt: `[Scheduled task "${s.name}" (schedule id ${s.id}) is running automatically — the user is not watching live. Do the work and reply with the finished result for them.${s.quiet ? ' If nothing needs their attention, reply with exactly NO_UPDATE and nothing else.' : ''}]\n\n${s.prompt}`,
  });
  schedules.update(s.id, { lastRun: new Date().toISOString(), lastStatus: res.error ?? 'ok', ...(isOneShot(s.when) ? { enabled: false } : {}) });
  if (isOneShot(s.when)) unregister(s.id);
  if (s.quiet && !res.error && /^\s*NO_UPDATE\b/.test(res.text)) return;
  await ui().send(`⏰ **${s.name}** · ${bot.emoji} ${bot.name}\n\n${res.error ? `⚠️ ${res.error}\n\n` : ''}${res.text || '(no output)'}`, bot.slug);
}
