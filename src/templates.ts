import fs from 'node:fs';
import path from 'node:path';
import { DATA, HOME, ROOT, config } from './config.ts';
import * as scheduler from './scheduler.ts';
import { bots, ensureBotDirs, schedules, slugify, workspaceOf, type ApprovalMode, type BotRecord, type Schedule } from './store.ts';

// Ready-made teammates in agents/<id>/agent.json that a user can switch on with /agents.
// Text fields and copied files may use {{PLACEHOLDERS}}: WORKSPACE, OPS_DIR, DATA, HOME, TZ,
// plus any declared param in upper case (e.g. {{PROJECT_DIR}}).

export const AGENTS_DIR = path.join(ROOT, 'agents');
export const OPS_DIR = path.join(DATA, 'ops');

export interface TemplateParam {
  key: string;
  description: string;
  required?: boolean;
  kind?: 'dir' | 'text';
}

export interface AgentTemplate {
  id: string;
  name: string;
  emoji?: string;
  summary: string;
  job: string;
  description?: string;
  model?: string;
  approvalMode?: ApprovalMode;
  params?: TemplateParam[];
  /** Files copied into the bot's workspace: { "dest in workspace": "source in template dir" }. */
  files?: Record<string, string>;
  /** Files copied into the shared ops folder (only if missing): { "dest": "source" }. */
  opsFiles?: Record<string, string>;
  schedules?: (Pick<Schedule, 'name' | 'when' | 'prompt'> & Partial<Pick<Schedule, 'quiet' | 'maxUsage'>>)[];
  /** Posts plan-usage alerts to this bot's thread. */
  usageMonitor?: boolean;
  /** Other templates this one works best with (shown as a hint). */
  pairsWith?: string[];
}

export function listTemplates(): AgentTemplate[] {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR)
    .filter((d) => fs.existsSync(path.join(AGENTS_DIR, d, 'agent.json')))
    .map((d) => ({ ...JSON.parse(fs.readFileSync(path.join(AGENTS_DIR, d, 'agent.json'), 'utf8')), id: d }) as AgentTemplate)
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getTemplate(id: string) {
  const q = id.trim().toLowerCase();
  return listTemplates().find((t) => t.id === q || t.name.toLowerCase() === q);
}

/** Parses `key=value key2=some value` (values run until the next ` key=`). */
export function parseParams(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)=([\s\S]*?)(?=\s+\w+=|$)/g;
  for (const m of s.matchAll(re)) out[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
  return out;
}

const fill = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);

export interface EnableResult {
  bot: BotRecord;
  created: boolean;
  files: string[];
  schedules: Schedule[];
  notes: string[];
}

export function enableTemplate(t: AgentTemplate, raw: Record<string, string>): EnableResult {
  const params: Record<string, string> = {};
  for (const p of t.params ?? []) {
    let v = raw[p.key.toLowerCase()];
    if (!v) {
      if (p.required) throw new Error(`Missing ${p.key.toLowerCase()}= (${p.description})`);
      continue;
    }
    if (p.kind === 'dir') {
      v = path.resolve(v.replace(/^~(?=$|\/)/, HOME));
      if (!fs.existsSync(v)) throw new Error(`Folder not found: ${v}`);
    }
    params[p.key.toUpperCase()] = v;
    // Where Claude Code keeps that folder's session transcripts.
    if (p.kind === 'dir') params[`${p.key.toUpperCase()}_SESSIONS`] = path.join(HOME, '.claude', 'projects', v.replace(/[^a-zA-Z0-9]/g, '-'));
  }

  const name = raw.name?.trim() || t.name;
  if (!/^[\w-]{2,24}$/.test(name)) throw new Error('Use a short one-word name (letters, numbers, - or _).');
  const slug = slugify(name);
  const vars: Record<string, string> = { ...params, NAME: name, WORKSPACE: workspaceOf(slug), OPS_DIR, DATA, HOME, TZ: config.timezone };

  const existing = bots.find(slug);
  const created = !existing;
  const base = existing ?? bots.create(name, fill(t.job, vars), fill(t.description ?? '', vars));
  const bot = bots.update(base.slug, {
    job: fill(t.job, vars),
    description: fill(t.description ?? '', vars),
    template: t.id,
    ...(created && t.emoji ? { emoji: t.emoji } : {}),
    ...(created && t.model ? { model: t.model } : {}),
    ...(created && t.approvalMode ? { approvalMode: t.approvalMode } : {}),
  })!;
  ensureBotDirs(bot.slug);

  const tdir = path.join(AGENTS_DIR, t.id);
  const files: string[] = [];
  const notes: string[] = [];
  const copy = (destRoot: string, map: Record<string, string> | undefined, overwrite: boolean) => {
    for (const [dest, src] of Object.entries(map ?? {})) {
      const to = path.join(destRoot, dest);
      if (fs.existsSync(to) && !overwrite) {
        notes.push(`kept your existing ${path.relative(DATA, to)}`);
        continue;
      }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, fill(fs.readFileSync(path.join(tdir, src), 'utf8'), vars));
      files.push(path.relative(DATA, to));
    }
  };
  copy(workspaceOf(bot.slug), t.files, false);
  copy(OPS_DIR, t.opsFiles, false);

  const skillsSrc = path.join(tdir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const s of fs.readdirSync(skillsSrc)) {
      const from = path.join(skillsSrc, s, 'SKILL.md');
      if (!fs.existsSync(from)) continue;
      const to = path.join(workspaceOf(bot.slug), '.claude', 'skills', s, 'SKILL.md');
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, fill(fs.readFileSync(from, 'utf8'), vars));
      files.push(`skill: ${s}`);
    }
  }

  const added: Schedule[] = [];
  for (const s of t.schedules ?? []) {
    if (schedules.all().some((x) => x.bot === bot.slug && x.name === s.name)) continue;
    const rec = schedules.add({ bot: bot.slug, name: s.name, when: s.when, prompt: fill(s.prompt, vars), timezone: config.timezone, ...(s.quiet ? { quiet: true } : {}), ...(s.maxUsage ? { maxUsage: s.maxUsage } : {}) });
    scheduler.register(rec);
    added.push(rec);
  }
  return { bot, created, files, schedules: added, notes };
}
