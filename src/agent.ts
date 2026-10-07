import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { HOME, config, log } from './config.ts';
import { browserMcp } from './browser.ts';
import { logHistory, readMemory } from './memory.ts';
import { makeCanUseTool, prettyToolName } from './policy.ts';
import { bots, workspaceOf, type BotRecord } from './store.ts';
import { createBotServer } from './tools.ts';
import { ui } from './ui.ts';

export interface RunResult {
  text: string;
  error?: string;
  sessionId?: string;
}

// One run at a time per bot (or per Claude Code project); different bots run in parallel.
const locks = new Map<string, Promise<void>>();
const running = new Map<string, AbortController>();
/** What each bot / Claude Code project is doing right now, for team_status. */
const activity = new Map<string, { title: string; since: number }>();

export function currentActivity() {
  return new Map(activity);
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const tail = prev.then(() => new Promise<void>((r) => (release = r)));
  locks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

export const isBusy = (key: string) => running.has(key) || locks.has(key);

export function busyKeys() {
  return [...running.keys()];
}

/** Aborts the run for `key`, or every run when omitted. Returns the keys stopped. */
export function stop(key?: string) {
  const keys = key ? [key] : [...running.keys()];
  for (const k of keys) running.get(k)?.abort();
  return keys.filter((k) => running.has(k));
}

export function describeTool(name: string, input: Record<string, any>): string | null {
  const short = (s: unknown, n = 70) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  switch (name) {
    case 'WebSearch': return `🔎 ${short(input.query)}`;
    case 'WebFetch': try { return `🌐 ${new URL(input.url).host}`; } catch { return '🌐 fetching page'; }
    case 'Bash': return `💻 ${short(input.description || input.command)}`;
    case 'Read': return `📖 ${path.basename(String(input.file_path))}`;
    case 'Write': case 'Edit': case 'MultiEdit': return `✏️ ${path.basename(String(input.file_path))}`;
    case 'Glob': case 'Grep': return `🗂 searching files`;
    case 'Skill': return `🧩 skill: ${input.skill ?? input.name ?? ''}`;
    case 'Task': case 'Agent': return `👥 subagent: ${short(input.description)}`;
    case 'TodoWrite': case 'ToolSearch': case 'AskUserQuestion': return null;
    case 'mcp__browser__browser_navigate': return `🧭 ${short(input.url, 60)}`;
    case 'mcp__bot__ask_bot': return `💬 asking ${input.bot}`;
    case 'mcp__bot__claude_code': return `🧑‍💻 Claude Code in ${path.basename(String(input.project_dir))}`;
    case 'mcp__bot__generate_image': return `🎨 generating image`;
  }
  if (name.startsWith('mcp__browser__')) return `🖱 ${name.replace('mcp__browser__browser_', '')}`;
  if (name.startsWith('mcp__bot__')) return null;
  return `🔧 ${prettyToolName(name)}`;
}

function teamRoster(self: BotRecord) {
  const others = bots.all().filter((b) => b.slug !== self.slug);
  return others.length ? others.map((b) => `- ${b.name} — ${b.job}`).join('\n') : '(none yet — the user can add more with /new)';
}

function systemAppend(bot: BotRecord) {
  const ws = workspaceOf(bot.slug);
  const now = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: config.timezone });
  const images = config.falKey
    ? 'Use generate_image to create images; it sends them to the user automatically.'
    : 'To create images use the fal MCP tools (mcp__fal__*, e.g. recommend_model then run_model), download the result into your workspace with curl, then send_file it.';
  return `
# You are ${bot.name}
You are ${bot.name}, one of the user's AI teammates in ClaudeBot: a team of always-on agents running on the user's own Mac. You are like a colleague they can hand real work to.
Your job: ${bot.job}
${bot.description ? `About you: ${bot.description}\n` : ''}
Your teammates (use ask_bot to delegate or hand off work, list_bots for details):
${teamRoster(bot)}

# How you work
- You have the user's Mac: terminal, filesystem (home folder: ${HOME}), a real Chrome browser (mcp__browser__* tools; a persistent profile shared by all bots, so sites the user signed into stay signed in), the user's connectors (Gmail, Google Calendar, Google Drive and others via MCP; some load lazily via ToolSearch), and web search.
- Prefer connectors/APIs over driving the browser; use the browser for everything else. Don't mention connectors that need sign-in unless the task needs one.
- Finish the work, don't just describe it: produce the real deliverable (files, edits, drafts inside the real tool, booked events after approval), then report back briefly: what you did, the result, where it lives, anything that needs the user.
- The user reads your replies in Telegram on their phone or desktop. Be concise and scannable. Use simple Markdown only: **bold**, lists, \`code\`, links. No tables, no # headings.
- Your working folder is ${ws}. Put deliverables there unless told otherwise. Files the user sends you land in ${ws}/inbox.
- Use send_file to deliver images, PDFs, documents or screenshots the user should see. Use notify for a short progress update during long jobs.

# Approvals and control
- Before any irreversible or outward-facing action (sending email or messages, posting, publishing, purchasing, deleting data, accepting invites, submitting forms, changing production systems), call request_approval describing exactly what you will do, unless the user already explicitly told you to do that exact thing. Some tools also trigger automatic approval prompts; if a request is denied, do not retry it.
- To sign in to a site, open its login page and use fill_login with a login from list_logins (the user's ClaudeBot vault in 1Password). It types the secret into the page for you; you never see it. Never ask for, read, print or type passwords, 2FA codes or payment details yourself, and never try to read the vault any other way. If there's no login for the site, or it needs a phone/email approval, tell the user (notify) what to tap or to sign in on the laptop's Chrome window or with /browser <url>, then continue with what you can.
- If something is ambiguous and matters, use AskUserQuestion (the user gets buttons on their phone) rather than guessing.

# Memory, skills and schedules
- Use remember for durable facts: user preferences, people, accounts, decisions, and lessons about your role. Use recall to look up earlier conversations. Re-check live sources for facts that change.
- When you finish a multi-step workflow the user may want again, or they say "learn this", "remember how to do this" or "watch me", save it with save_skill: steps, decision rules, output format and approval points. Skills appear as /skills you can invoke with the Skill tool.
- Use schedule_task for recurring or future work ("every weekday at 8am…", "tomorrow at 3pm…"). The scheduled prompt runs later without the user watching, so make it self-contained.
- For substantial software work inside a code project, use claude_code: it runs a full Claude Code session in that directory and can resume earlier sessions.
- ${images}

Today is ${now} (timezone ${config.timezone}).

# What you know about the user
${readMemory('user') || '(nothing yet)'}

# Your own memory (role context, preferences, summaries of earlier work)
${readMemory('bot', bot.slug) || '(nothing yet)'}
`;
}

export interface RunOptions {
  slug: string;
  prompt: string;
  origin: 'user' | 'schedule' | 'bot' | 'system';
  /** Bots already waiting on this call chain (loop protection for ask_bot). */
  chain?: string[];
  title?: string;
  /** Run in a throwaway session instead of the bot's main conversation. */
  ephemeral?: boolean;
  /** Where status, approvals and questions go (default: the bot's own thread). */
  to?: string;
  /** No live status message (for frequent background check-ins). */
  quiet?: boolean;
}

export function runBot(o: RunOptions): Promise<RunResult> {
  return withLock(o.slug, () => execute(o));
}

async function execute(o: RunOptions, retried = false): Promise<RunResult> {
  const bot = bots.find(o.slug);
  if (!bot) return { text: '', error: `No bot named ${o.slug}` };
  const ws = workspaceOf(bot.slug);
  const who = `${bot.emoji} ${bot.name}`;
  const ac = new AbortController();
  running.set(bot.slug, ac);
  activity.set(bot.slug, { title: o.title ?? `${o.origin} request`, since: Date.now() });
  const to = o.to ?? bot.slug;
  const status = o.quiet ? { step() {}, async done() {} } : ui().status(who, o.title ?? 'working', to);
  const started = Date.now();
  let steps = 0;
  let text = '';
  let error: string | undefined;
  let sessionId = o.ephemeral ? undefined : bot.sessionId;

  const options: Options = {
    cwd: ws,
    additionalDirectories: [HOME],
    resume: sessionId,
    model: bot.model,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(bot) },
    settingSources: ['user', 'project'],
    skills: 'all',
    mcpServers: { bot: createBotServer(bot, o.chain ?? [], to), browser: browserMcp() },
    permissionMode: 'default',
    canUseTool: makeCanUseTool({ who, workspace: ws, to, mode: () => bots.find(bot.slug)?.approvalMode ?? 'ask' }),
    abortController: ac,
    persistSession: !o.ephemeral,
    stderr: (d) => { if (/error/i.test(d)) log(`[${bot.slug}]`, d.trim().slice(0, 500)); },
  };

  try {
    for await (const m of query({ prompt: o.prompt, options })) {
      if (m.type === 'system' && m.subtype === 'init') {
        sessionId = m.session_id;
        if (!o.ephemeral) bots.update(bot.slug, { sessionId });
      } else if (m.type === 'assistant') {
        for (const block of m.message.content as any[]) {
          if (block.type === 'tool_use') {
            steps++;
            const line = describeTool(block.name, block.input ?? {});
            if (line) status.step(line);
          }
        }
      } else if (m.type === 'result') {
        if (m.subtype === 'success') text = m.result;
        else error = `${m.subtype}${'errors' in m && m.errors?.length ? `: ${m.errors.join('; ')}` : ''}`;
      }
    }
  } catch (e: any) {
    error = ac.signal.aborted ? 'stopped' : String(e?.message ?? e);
  } finally {
    running.delete(bot.slug);
    activity.delete(bot.slug);
  }

  // A stale/missing session: start a fresh conversation once.
  if (error && !retried && sessionId && /no conversation found|session.*not found/i.test(error)) {
    bots.update(bot.slug, { sessionId: undefined });
    await status.done('↻ starting a fresh session');
    return execute(o, true);
  }

  const secs = Math.round((Date.now() - started) / 1000);
  const dur = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
  await status.done(error ? `⚠️ ${error === 'stopped' ? 'stopped' : 'error'} · ${dur}` : `✅ done · ${steps} step${steps === 1 ? '' : 's'} · ${dur}`);
  logHistory(bot.slug, o.origin, o.prompt);
  if (text) logHistory(bot.slug, 'assistant', text);
  if (error) log(`[${bot.slug}] run error:`, error);
  return { text, error, sessionId };
}

/** Runs a full Claude Code session inside a project directory (the user's normal Claude Code setup). */
export function runClaudeCode(o: { dir: string; task: string; sessionId?: string; continueLast?: boolean; to?: string }): Promise<RunResult> {
  const dir = path.resolve(o.dir.replace(/^~(?=$|\/)/, HOME));
  const key = `code:${dir}`;
  return withLock(key, async () => {
    if (!fs.existsSync(dir)) return { text: '', error: `Directory not found: ${dir}` };
    const who = `🧑‍💻 Claude Code · ${path.basename(dir)}`;
    const ac = new AbortController();
    running.set(key, ac);
    activity.set(key, { title: o.task.slice(0, 120), since: Date.now() });
    const to = o.to ?? 'code';
    const status = ui().status(who, 'working', to);
    let steps = 0;
    let text = '';
    let error: string | undefined;
    let sessionId = o.sessionId;
    try {
      for await (const m of query({
        prompt: o.task,
        options: {
          cwd: dir,
          resume: o.sessionId,
          continue: !o.sessionId && o.continueLast,
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: 'You are being driven remotely from the user\'s phone/desktop via Telegram. Work autonomously, then reply with a concise summary (no tables). Use AskUserQuestion if you genuinely need a decision.',
          },
          permissionMode: 'default',
          canUseTool: makeCanUseTool({ who, workspace: dir, to, mode: () => 'ask' }),
          mcpServers: { browser: browserMcp() },
          abortController: ac,
        },
      })) {
        if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
        else if (m.type === 'assistant') {
          for (const block of m.message.content as any[]) {
            if (block.type === 'tool_use') {
              steps++;
              const line = describeTool(block.name, block.input ?? {});
              if (line) status.step(line);
            }
          }
        } else if (m.type === 'result') {
          if (m.subtype === 'success') text = m.result;
          else error = m.subtype;
        }
      }
    } catch (e: any) {
      error = ac.signal.aborted ? 'stopped' : String(e?.message ?? e);
    } finally {
      running.delete(key);
      activity.delete(key);
    }
    await status.done(error ? `⚠️ ${error}` : `✅ done · ${steps} steps`);
    return { text, error, sessionId };
  });
}
