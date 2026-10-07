import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './config.ts';

export type ApprovalMode = 'auto' | 'ask' | 'strict';
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export interface BotRecord {
  name: string;
  slug: string;
  emoji: string;
  job: string;
  description: string;
  model?: string;
  /** Reasoning effort for this bot's runs (unset = the model's default). */
  effort?: Effort;
  sessionId?: string;
  approvalMode: ApprovalMode;
  createdAt: string;
  /** Forum topic (thread) id in the team group. */
  topicId?: number;
  /** The agents/ template this bot was enabled from. */
  template?: string;
}

export interface Schedule {
  id: string;
  bot: string; // slug
  name: string;
  when: string; // cron expression or ISO datetime (one-shot)
  prompt: string;
  timezone: string;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  lastStatus?: string;
  /** Skip the run while the 5-hour or weekly Claude limit is at or above this %. */
  maxUsage?: number;
  /** No status message, and no result message when the bot replies NO_UPDATE. */
  quiet?: boolean;
}

export interface AppState {
  ownerId?: number;
  activeBot?: string;
  code?: { dir: string; sessionId?: string };
  /** Private Telegram group with topics: one thread per bot, plus Team and Claude Code threads. */
  group?: { chatId: number; teamTopicId?: number; codeTopicId?: number };
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'bot';

const EMOJIS = ['🤖', '🦉', '🦊', '🐙', '🦄', '🐝', '🦁', '🐬', '🦅', '🐢'];

// ---------- bots ----------

export const bots = {
  all(): BotRecord[] {
    return readJson<BotRecord[]>(paths.bots, []);
  },
  find(nameOrSlug: string): BotRecord | undefined {
    const q = nameOrSlug.trim().replace(/^@/, '').toLowerCase();
    return this.all().find((b) => b.slug === q || b.name.toLowerCase() === q);
  },
  save(list: BotRecord[]) {
    writeJson(paths.bots, list);
  },
  upsert(bot: BotRecord) {
    const list = this.all().filter((b) => b.slug !== bot.slug);
    list.push(bot);
    this.save(list);
    ensureBotDirs(bot.slug);
    return bot;
  },
  update(slug: string, patch: Partial<BotRecord>) {
    const list = this.all();
    const i = list.findIndex((b) => b.slug === slug);
    if (i < 0) return undefined;
    list[i] = { ...list[i], ...patch };
    this.save(list);
    return list[i];
  },
  remove(slug: string) {
    this.save(this.all().filter((b) => b.slug !== slug));
  },
  create(name: string, job: string, description = ''): BotRecord {
    const slug = slugify(name);
    const used = new Set(this.all().map((b) => b.emoji));
    return this.upsert({
      name: name.trim(),
      slug,
      emoji: EMOJIS.find((e) => !used.has(e)) ?? '🤖',
      job: job.trim(),
      description: description.trim(),
      model: config.defaultModel,
      approvalMode: 'ask',
      createdAt: new Date().toISOString(),
    });
  },
};

export function workspaceOf(slug: string) {
  return path.join(paths.botDir(slug), 'workspace');
}

export function ensureBotDirs(slug: string) {
  const ws = workspaceOf(slug);
  fs.mkdirSync(path.join(ws, '.claude', 'skills'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'inbox'), { recursive: true });
  const mem = path.join(paths.botDir(slug), 'memory.md');
  if (!fs.existsSync(mem)) fs.writeFileSync(mem, '');
}

// ---------- schedules ----------

export const schedules = {
  all(): Schedule[] {
    return readJson<Schedule[]>(paths.schedules, []);
  },
  save(list: Schedule[]) {
    writeJson(paths.schedules, list);
  },
  add(s: Omit<Schedule, 'id' | 'createdAt' | 'enabled'>): Schedule {
    const rec: Schedule = { ...s, id: Math.random().toString(36).slice(2, 8), enabled: true, createdAt: new Date().toISOString() };
    this.save([...this.all(), rec]);
    return rec;
  },
  update(id: string, patch: Partial<Schedule>) {
    this.save(this.all().map((s) => (s.id === id ? { ...s, ...patch } : s)));
  },
  remove(id: string) {
    const list = this.all();
    this.save(list.filter((s) => s.id !== id));
    return list.some((s) => s.id === id);
  },
};

// ---------- app state ----------

export const state = {
  get(): AppState {
    return readJson<AppState>(paths.state, {});
  },
  set(patch: Partial<AppState>) {
    writeJson(paths.state, { ...this.get(), ...patch });
  },
};
