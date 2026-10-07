import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.ts';
import { currentActivity, runBot, runClaudeCode } from './agent.ts';
import { recall, remember } from './memory.ts';
import * as scheduler from './scheduler.ts';
import { bots, schedules, slugify, workspaceOf, type BotRecord } from './store.ts';
import { ui } from './ui.ts';
import { describe, fetchUsage } from './usage.ts';
import { fillLogin, listLogins } from './vault.ts';

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);

/** The in-process MCP server ("bot") that gives a teammate its ClaudeBot-specific abilities. */
export function createBotServer(bot: BotRecord, chain: string[], to: string = bot.slug) {
  const who = `${bot.emoji} ${bot.name}`;
  const ws = workspaceOf(bot.slug);

  const tools = [
    tool('remember', 'Save a durable fact to memory. about="user" for facts/preferences about the user (shared with all bots); about="self" for your own role context, lessons and work summaries.', {
      fact: z.string().describe('One self-contained sentence'),
      about: z.enum(['user', 'self']),
    }, async (a) => {
      remember(a.about === 'user' ? 'user' : 'bot', a.fact, bot.slug);
      return ok('Saved.');
    }),

    tool('recall', 'Search memories and past conversations (keyword search).', {
      query: z.string(),
      all_bots: z.boolean().optional().describe('Also search teammates\' conversations'),
    }, async (a) => {
      const hits = recall(a.query, a.all_bots ? bots.all().map((b) => b.slug) : [bot.slug]);
      return ok(hits.length ? hits.map((h) => `[${h.where}${h.t ? ' ' + h.t.slice(0, 16) : ''}] ${h.text}`).join('\n\n') : 'No matches.');
    }),

    tool('notify', 'Send the user a short message right now (progress update, heads-up, or a request to sign in somewhere). Your final reply is delivered automatically — do not duplicate it here.', {
      message: z.string(),
    }, async (a) => {
      await ui().send(`${who}: ${a.message}`, to);
      return ok('Sent.');
    }),

    tool('send_file', 'Send a file (local path or https URL) to the user in Telegram. Images are shown inline.', {
      path_or_url: z.string(),
      caption: z.string().optional(),
    }, async (a) => {
      const p = a.path_or_url.startsWith('http') ? a.path_or_url : path.resolve(ws, a.path_or_url);
      if (!p.startsWith('http') && !fs.existsSync(p)) return fail(`File not found: ${p}`);
      await ui().sendFile(p, a.caption, to);
      return ok('Sent.');
    }),

    tool('request_approval', 'Ask the user to approve an action before you do it (sending, posting, purchasing, deleting, submitting…). Blocks until they answer. Returns APPROVED or DENIED.', {
      action: z.string().describe('Short description of exactly what you will do'),
      details: z.string().describe('The full content/target, e.g. the email text and recipients'),
    }, async (a, extra: any) => {
      const d = await ui().approve({ who, title: a.action, detail: a.details, signal: extra?.signal, to });
      return ok(d === 'deny' ? 'DENIED — do not do this. Continue without it or report back.' : 'APPROVED — go ahead.');
    }),

    tool('list_bots', 'List all teammates with their jobs.', {}, async () =>
      ok(bots.all().map((b) => `${b.name} (${b.slug}) — ${b.job}${b.description ? ` · ${b.description}` : ''}`).join('\n')),
    ),

    tool('ask_bot', 'Send a message to a teammate and wait for their reply. Use it to delegate a sub-task, hand off ownership, or get their input. They keep their own memory and context.', {
      bot: z.string().describe('Teammate name'),
      message: z.string().describe('Self-contained request with all the context they need'),
    }, async (a) => {
      const target = bots.find(a.bot);
      if (!target) return fail(`No teammate named ${a.bot}. Use list_bots.`);
      if (target.slug === bot.slug) return fail('That is you.');
      if ([...chain, bot.slug].includes(target.slug)) return fail(`${target.name} is already waiting on this conversation chain; asking them would deadlock. Do it yourself or answer from context.`);
      await ui().send(`💬 ${bot.name} → ${target.name}: ${clip(a.message, 500)}`, 'team');
      const res = await runBot({
        slug: target.slug,
        origin: 'bot',
        chain: [...chain, bot.slug],
        title: `task from ${bot.name}`,
        prompt: `[Message from your teammate ${bot.name} (${bot.job})]\n\n${a.message}\n\n(Your reply is returned to ${bot.name} directly. Do the work, then reply with the result.)`,
      });
      await ui().send(`💬 ${target.name} → ${bot.name}: ${clip(res.text || res.error || '(no reply)', 700)}`, 'team');
      return res.error ? fail(`${target.name} hit an error: ${res.error}\n${res.text}`) : ok(res.text);
    }),

    tool('save_skill', 'Save a reusable workflow ("routine") as a skill you can run again later or on a schedule. Write clear steps, decision rules, output format and where approval is needed.', {
      name: z.string().describe('kebab-case, e.g. daily-news-brief'),
      description: z.string().describe('When to use this skill (one or two sentences)'),
      instructions: z.string().describe('Markdown body: steps, rules, output format, approval points'),
      share_with: z.array(z.string()).optional().describe('Other teammates who should also get this skill'),
    }, async (a) => {
      const slug = slugify(a.name);
      const targets = [bot, ...(a.share_with ?? []).map((n) => bots.find(n)).filter((b): b is BotRecord => !!b)];
      for (const t of targets) {
        const dir = path.join(workspaceOf(t.slug), '.claude', 'skills', slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: ${a.description.replace(/\n/g, ' ')}\n---\n\n${a.instructions}\n`);
      }
      await ui().send(`🧩 ${bot.name} learned a new skill: **${slug}**${targets.length > 1 ? ` (shared with ${targets.slice(1).map((t) => t.name).join(', ')})` : ''}`, to);
      return ok(`Saved skill "${slug}". It is available from your next turn as the /${slug} skill.`);
    }),

    tool('schedule_task', 'Schedule work to run automatically. `when` is a 5-field cron expression (e.g. "0 8 * * 1-5" = weekdays 8:00) or an ISO datetime for a one-off (e.g. "2026-10-08T15:00:00"). The prompt runs later with nobody watching, so make it self-contained.', {
      name: z.string(),
      when: z.string(),
      prompt: z.string(),
      bot: z.string().optional().describe('Teammate that should run it (default: you)'),
      timezone: z.string().optional().describe(`IANA timezone (default ${config.timezone})`),
      max_usage: z.number().min(1).max(100).optional().describe('Skip runs while the 5-hour or weekly Claude limit is at or above this %'),
      quiet: z.boolean().optional().describe('For frequent check-ins: no status message, and no result message when the run replies NO_UPDATE'),
    }, async (a) => {
      const target = a.bot ? bots.find(a.bot) : bot;
      if (!target) return fail(`No teammate named ${a.bot}`);
      const timezone = a.timezone ?? config.timezone;
      let next: Date;
      try {
        next = scheduler.validate(a.when, timezone);
      } catch (e: any) {
        return fail(`Invalid schedule: ${e.message}`);
      }
      const s = schedules.add({ bot: target.slug, name: a.name, when: a.when.trim(), prompt: a.prompt, timezone, ...(a.max_usage ? { maxUsage: a.max_usage } : {}), ...(a.quiet ? { quiet: true } : {}) });
      scheduler.register(s);
      const nextStr = next.toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
      return ok(`Scheduled "${s.name}" (id ${s.id}) for ${target.name}. Next run: ${nextStr} ${timezone}.`);
    }),

    tool('list_schedules', 'List scheduled tasks.', {}, async () => {
      const list = schedules.all();
      return ok(list.length ? list.map((s) => `${s.id} · ${s.name} · ${s.bot} · ${s.when} ${s.timezone}${s.enabled ? '' : ' (disabled)'} · last: ${s.lastRun ?? 'never'}\n  ${clip(s.prompt, 200)}`).join('\n') : 'No schedules.');
    }),

    tool('cancel_schedule', 'Delete a scheduled task by id.', { id: z.string() }, async (a) => {
      scheduler.unregister(a.id);
      return schedules.remove(a.id) ? ok('Cancelled.') : fail('No schedule with that id.');
    }),

    tool('claude_code', 'Run a full Claude Code agent session inside a project directory on this Mac (with that project\'s CLAUDE.md, skills and settings). Use for real software work: building features, fixing bugs, running tests. Returns its summary and a session_id you can pass back to continue the same session.', {
      project_dir: z.string().describe('Absolute path or ~/…'),
      task: z.string().describe('Complete instructions for the coding session'),
      session_id: z.string().optional().describe('Resume a specific earlier session'),
      continue_last: z.boolean().optional().describe('Continue the most recent session in that directory'),
    }, async (a) => {
      const res = await runClaudeCode({ dir: a.project_dir, task: a.task, sessionId: a.session_id, continueLast: a.continue_last, to });
      return res.error ? fail(`Claude Code error: ${res.error}\n${res.text}`) : ok(`${res.text}\n\n(session_id: ${res.sessionId})`);
    }),

    tool('team_status', 'Live team status (no tokens): which bots and Claude Code projects are working right now and on what, which are idle, approvals/questions waiting on the user, and recent schedule runs. Never ask_bot a busy bot; it would block until it finishes.', {}, async () => {
      const now = Date.now();
      const ago = (t: number) => `${Math.round((now - t) / 60_000)} min`;
      const act = currentActivity();
      const lines = ['Bots:'];
      for (const b of bots.all()) {
        const a = act.get(b.slug);
        lines.push(`- ${b.emoji} ${b.name}: ${a ? `BUSY for ${ago(a.since)}: ${clip(a.title, 120)}` : 'idle'}`);
      }
      const code = [...act.entries()].filter(([k]) => k.startsWith('code:'));
      lines.push('Claude Code sessions running:', ...(code.length ? code.map(([k, a]) => `- ${k.slice(5)} for ${ago(a.since)}: ${clip(a.title, 120)}`) : ['- none']));
      const pend = ui().pending();
      lines.push('Waiting on the user:', ...(pend.length ? pend.map((p) => `- ${p.kind} from ${p.who}, waiting ${ago(p.since)}: ${clip(p.title, 140)}`) : ['- nothing']));
      const today = new Date().toISOString().slice(0, 10);
      const ran = schedules.all().filter((s) => s.lastRun?.startsWith(today));
      lines.push('Schedules run today (UTC date):', ...(ran.length ? ran.map((s) => `- ${s.name} (${s.bot}) at ${s.lastRun!.slice(11, 16)} UTC: ${s.lastStatus ?? '?'}`) : ['- none']));
      return ok(lines.join('\n'));
    }),

    tool('claude_usage', 'Current Claude plan usage: the 5-hour session, weekly and per-model weekly limits, % used, reset times and whether the current pace runs out before reset. Costs no tokens.', {}, async () => {
      try {
        const u = await fetchUsage();
        return ok(`Plan: ${u.plan ?? 'unknown'}\n${describe(u.windows)}\n\nRaw: ${JSON.stringify(u.windows)}`);
      } catch (e: any) { return fail(`Couldn't read usage: ${e.message}`); }
    }),

    tool('list_logins', `List the sign-ins bots may use (titles and websites only, never secrets) from the user's "${config.opVault}" 1Password vault.`, {}, async () => {
      try {
        const logins = await listLogins();
        return ok(logins.length ? logins.map((l) => `${l.title} · ${l.hosts.join(', ') || 'no URL'}`).join('\n') : `The ${config.opVault} vault has no logins yet.`);
      } catch (e: any) { return fail(e.message); }
    }),

    tool('fill_login', 'Sign in on the open browser tab with a login from 1Password. Navigate to the sign-in page first. The secret is typed straight into the page and never shown to you; it only works on the site the login belongs to. Multi-step sign-ins: call once per step (e.g. fields=["username"], click Next, then fields=["password"]). For 2FA, fields=["otp"] fills the item\'s authenticator code; phone or email approvals still go to the user.', {
      login: z.string().describe('Login title from list_logins (or the site, e.g. "github.com")'),
      fields: z.array(z.enum(['username', 'password', 'otp'])).optional().describe('Default ["username","password"]'),
      submit: z.boolean().optional().describe('Press Enter in the last field filled'),
    }, async (a) => {
      try { return ok(await fillLogin(a.login, a.fields ?? ['username', 'password'], a.submit ?? false)); } catch (e: any) { return fail(e.message); }
    }),
  ];

  if (config.falKey) {
    tools.push(tool('generate_image', 'Generate images with fal.ai. Saves them to your workspace and sends them to the user.', {
      prompt: z.string(),
      image_size: z.enum(['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9']).optional(),
      num_images: z.number().int().min(1).max(4).optional(),
    }, async (a) => {
      const r = await fetch(`https://fal.run/${config.falImageModel}`, {
        method: 'POST',
        headers: { Authorization: `Key ${config.falKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: a.prompt, image_size: a.image_size ?? 'landscape_4_3', num_images: a.num_images ?? 1 }),
      });
      if (!r.ok) return fail(`fal error ${r.status}: ${clip(await r.text(), 500)}`);
      const data = (await r.json()) as { images?: { url: string }[] };
      const dir = path.join(ws, 'images');
      fs.mkdirSync(dir, { recursive: true });
      const saved: string[] = [];
      for (const [i, img] of (data.images ?? []).entries()) {
        const buf = Buffer.from(await (await fetch(img.url)).arrayBuffer());
        const file = path.join(dir, `${Date.now()}-${i}.png`);
        fs.writeFileSync(file, buf);
        saved.push(file);
        await ui().sendFile(file, clip(a.prompt, 200), to);
      }
      return ok(`Generated and sent ${saved.length} image(s):\n${saved.join('\n')}`);
    }) as any);
  }

  return createSdkMcpServer({ name: 'bot', version: '1.0.0', tools });
}
