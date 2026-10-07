import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { DATA, config, log } from './config.ts';
import { readJson, writeJson } from './store.ts';
import { ui } from './ui.ts';

// Claude plan usage (the numbers behind /usage): 5-hour session, weekly, and per-model weekly
// windows. Reading them costs no tokens, so the monitor polls in code and only messages the
// usage bot's thread when something worth knowing happens.

export type Window = { key: string; label: string; pct: number; resetsAt: string; hours: number };

const STATE_FILE = path.join(DATA, 'usage-state.json');
const SESSION_MILESTONES = [50, 75, 90, 95];
const WEEKLY_MILESTONES = [25, 50, 75, 90, 95];

export async function fetchUsage(): Promise<{ plan: string | null; windows: Window[] }> {
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  async function* idle() { await hold; }
  // A query that never sends a message: we only use its control channel, so it costs nothing.
  const q = query({ prompt: idle() as any, options: { settingSources: [], mcpServers: {}, persistSession: false } });
  try {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    const rl: any = u.rate_limits;
    if (!u.rate_limits_available || !rl) return { plan: u.subscription_type, windows: [] };
    const windows: Window[] = [];
    const add = (key: string, label: string, w: any, hours: number) => {
      if (w && typeof w.utilization === 'number' && w.resets_at) windows.push({ key, label, pct: w.utilization, resetsAt: w.resets_at, hours });
    };
    add('five_hour', '5-hour session', rl.five_hour, 5);
    add('seven_day', 'Weekly (all models)', rl.seven_day, 168);
    add('seven_day_opus', 'Weekly Opus', rl.seven_day_opus, 168);
    add('seven_day_sonnet', 'Weekly Sonnet', rl.seven_day_sonnet, 168);
    for (const m of rl.model_scoped ?? []) add(`model_${String(m.display_name).toLowerCase()}`, `Weekly ${m.display_name}`, m, 168);
    return { plan: u.subscription_type, windows };
  } finally {
    release();
    q.close();
  }
}

const fmt = (iso: string | number) =>
  new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));

/** Hours until a window hits 100% at its average pace so far, or null if it won't before reset. */
function runsOutAt(w: Window, now = Date.now()): number | null {
  const reset = Date.parse(w.resetsAt);
  const start = reset - w.hours * 3_600_000;
  const elapsed = now - start;
  if (w.pct <= 0 || elapsed < 3_600_000) return null;
  const at = start + elapsed * (100 / w.pct);
  return at < reset ? at : null;
}

export function describe(windows: Window[]): string {
  if (!windows.length) return 'Plan usage isn\'t available (not signed in with a Claude subscription?).';
  return windows.map((w) => {
    const out = runsOutAt(w);
    return `${bar(w.pct)} **${w.label}: ${Math.round(w.pct)}%** · resets ${fmt(w.resetsAt)}${out ? ` · ⚠️ at this pace, runs out ${fmt(out)}` : ''}`;
  }).join('\n');
}

const bar = (pct: number) => (pct >= 95 ? '🔴' : pct >= 75 ? '🟠' : pct >= 50 ? '🟡' : '🟢');

type Seen = { label: string; resetsAt: string; pct: number; peak: number; milestones: number[]; paceWarned?: boolean };

/** Compares a fresh reading with what we last saw and returns the alerts to send. */
export function diff(windows: Window[], seen: Record<string, Seen>, first: boolean): string[] {
  const alerts: string[] = [];
  for (const w of windows) {
    const prev = seen[w.key];
    const marks = w.hours > 5 ? WEEKLY_MILESTONES : SESSION_MILESTONES;
    const reached = marks.filter((m) => w.pct >= m);
    const newWindow = prev && Date.parse(w.resetsAt) - Date.parse(prev.resetsAt) > 30 * 60_000;
    if (!prev || newWindow) {
      // Session windows roll over every 5 hours; only worth a message if the last one got busy.
      if (newWindow && (w.hours > 5 || prev.peak >= 50)) {
        alerts.push(`🔄 **${w.label} reset.** It's at ${Math.round(w.pct)}% now (peaked at ${Math.round(prev.peak)}% last window). Next reset ${fmt(w.resetsAt)}.`);
      }
      // First sighting: absorb milestones already passed (the welcome message shows them).
      seen[w.key] = { label: w.label, resetsAt: w.resetsAt, pct: w.pct, peak: w.pct, milestones: newWindow ? [] : reached, paceWarned: first && !!runsOutAt(w) };
    }
    const s = seen[w.key];
    const fresh = reached.filter((m) => !s.milestones.includes(m));
    if (fresh.length) {
      const top = Math.max(...fresh);
      alerts.push(top >= 95
        ? `🚨 **Almost out: ${w.label} at ${Math.round(w.pct)}%.** Resets ${fmt(w.resetsAt)}. Bots will stop when it hits 100%.`
        : `${bar(w.pct)} **${w.label} passed ${top}%** (now ${Math.round(w.pct)}%). Resets ${fmt(w.resetsAt)}.`);
      s.milestones.push(...fresh);
    }
    const out = runsOutAt(w);
    if (w.hours > 5 && out && w.pct >= 50 && !s.paceWarned) {
      alerts.push(`⚠️ **${w.label} is on pace to run out ${fmt(out)}**, before it resets ${fmt(w.resetsAt)}. Consider lighter models or fewer scheduled runs until then.`);
      s.paceWarned = true;
    }
    s.pct = w.pct;
    s.peak = Math.max(s.peak, w.pct);
    s.resetsAt = w.resetsAt;
  }
  // A window that disappeared after its reset time (an idle session) has reset too.
  for (const [key, s] of Object.entries(seen)) {
    if (windows.some((w) => w.key === key) || Date.parse(s.resetsAt) > Date.now()) continue;
    if (key !== 'five_hour' || s.peak >= 50) alerts.push(`🔄 **${s.label} reset.** Back to 0% (peaked at ${Math.round(s.peak)}%).`);
    delete seen[key];
  }
  return alerts;
}

let timer: NodeJS.Timeout | null = null;

export function startUsageMonitor(botSlug: string) {
  if (timer) return;
  const check = async () => {
    try {
      const { windows } = await fetchUsage();
      if (!windows.length) return;
      const first = !fs.existsSync(STATE_FILE);
      const seen = readJson<Record<string, Seen>>(STATE_FILE, {});
      const alerts = diff(windows, seen, first);
      writeJson(STATE_FILE, seen);
      if (first) alerts.unshift(`📊 Usage monitor is on. I check every ${config.usageCheckMin} min and post here at milestones, when a limit is almost out, and when one resets.\n\n${describe(windows)}`);
      for (const a of alerts) await ui().send(a, botSlug);
    } catch (e) {
      log('[usage] check failed:', String((e as Error)?.message ?? e).slice(0, 300));
    }
  };
  setTimeout(check, 15_000);
  timer = setInterval(check, config.usageCheckMin * 60_000);
  log(`[usage] monitor every ${config.usageCheckMin} min → ${botSlug}`);
}
