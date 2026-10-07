import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import fs from 'node:fs';
import path from 'node:path';
import { DATA, HOME, config, log } from './config.ts';
import { busyKeys, isBusy, runBot, runClaudeCode, stop } from './agent.ts';
import { chunkMarkdown, mdToHtml } from './md.ts';
import { forget, readMemory, remember } from './memory.ts';
import * as scheduler from './scheduler.ts';
import { bots, schedules, state, workspaceOf, type ApprovalMode, type BotRecord } from './store.ts';
import { enableTemplate, getTemplate, listTemplates, parseParams, type EnableResult } from './templates.ts';
import { setUI, type Decision, type Dest, type Question, type UI } from './ui.ts';
import { startUsageMonitor } from './usage.ts';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s);
const rid = () => Math.random().toString(36).slice(2, 10);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm)$/i;
const AUDIO_EXT = /\.(mp3|m4a|wav|ogg)$/i;
const TEAM_TOPIC = '👥 Team';
const CODE_TOPIC = '🧑‍💻 Claude Code';

const HELP = `**ClaudeBot** — your always-on AI teammates, running on your Mac.

**Talking to bots**
In your team group every bot has its own thread — just chat there. In 👥 Team, the active bot answers, or address anyone with \`Name: message\`. The 🧑‍💻 Claude Code thread talks straight to Claude Code. Photos and files land in the bot's inbox.

**Team**
/bots — teammates and links to their threads
/agents — ready-made teammates you can switch on
/new Name | job | description — hire your own (gets its own thread)
/use Name — active bot for 👥 Team and DMs
/job Name | new job — change a bot's job
/fire Name — remove a teammate
/group A,B task — have teammates collaborate

**Control** (inside a bot's thread these apply to that bot)
/stop — stop what's running
/reset — fresh conversation (memories are kept)
/mode auto|ask|strict — approval level
/model sonnet|opus|default — model

**Memory, skills, schedules**
/memory · /remember fact · /forget text · /skills · /schedules

**Computer**
/code ~/path — Claude Code project for the 🧑‍💻 thread (\`/code new\` = fresh session)
/sessions — resume a Claude Code session (also ones from your terminal)
/browser url — open a page in the shared browser (e.g. to sign in)
/status — what's running
/setup — (in a group with Topics) create the team threads`;

const SETUP_GUIDE = `**Set up your team group** (one time, ~1 minute):
1. In Telegram: New Group → add this bot → name it e.g. "ClaudeBot HQ".
2. Group settings → **Topics** → turn on.
3. Group settings → Administrators → add this bot → enable **Manage Topics**.
4. Make sure "Remain anonymous" is **off** for you.
5. Send /setup in the group.`;

type Target = { chat_id: number; message_thread_id?: number };

export function startTelegram() {
  if (!config.telegramToken) throw new Error('TELEGRAM_BOT_TOKEN is missing — add it to .env');
  const tg = new Bot(config.telegramToken);
  let ownerId = config.ownerId ?? state.get().ownerId;
  const pairingFile = path.join(DATA, 'PAIRING_CODE.txt');
  const pairingCode = ownerId ? null : String(Math.floor(100000 + Math.random() * 900000));
  if (pairingCode) {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(pairingFile, pairingCode);
    log(`[telegram] not paired yet — send "/pair ${pairingCode}" to your bot`);
  }

  const owner = () => {
    if (!ownerId) throw new Error('Not paired with a Telegram user yet');
    return ownerId;
  };

  // ---------- destinations (DM or group threads) ----------

  const group = () => state.get().group;

  function target(to?: Dest): Target {
    const g = group();
    if (!g || to === 'dm') return { chat_id: owner() };
    if (to === 'code') return { chat_id: g.chatId, message_thread_id: g.codeTopicId };
    const b = to && to !== 'team' ? bots.find(to) : undefined;
    if (b?.topicId) return { chat_id: g.chatId, message_thread_id: b.topicId };
    return { chat_id: g.chatId, message_thread_id: g.teamTopicId };
  }

  const threadKey = (t: Target) => `${t.chat_id}:${t.message_thread_id ?? 0}`;

  function topicLink(threadId?: number) {
    const g = group();
    return g && threadId ? `https://t.me/c/${String(g.chatId).replace(/^-100/, '')}/${threadId}` : undefined;
  }

  /** Creates the forum topic for a destination if it's missing (or `force` to recreate). */
  async function ensureTopic(to: Dest, force = false): Promise<number | undefined> {
    const g = group();
    if (!g) return undefined;
    if (to === 'team' || to === 'code') {
      const key = to === 'team' ? 'teamTopicId' : 'codeTopicId';
      if (g[key] && !force) return g[key];
      const t = await tg.api.createForumTopic(g.chatId, to === 'team' ? TEAM_TOPIC : CODE_TOPIC);
      state.set({ group: { ...g, [key]: t.message_thread_id } });
      return t.message_thread_id;
    }
    const b = bots.find(to);
    if (!b) return undefined;
    if (b.topicId && !force) return b.topicId;
    const t = await tg.api.createForumTopic(g.chatId, `${b.emoji} ${b.name}`);
    bots.update(b.slug, { topicId: t.message_thread_id });
    await sendMd(`This is ${b.emoji} **${b.name}**'s thread — ${b.job}\nTalk here to work with ${b.name}. Approvals, questions and scheduled results for ${b.name} show up here too.`, b.slug);
    return t.message_thread_id;
  }

  // ---------- sending ----------

  async function sendHtml(html: string, to?: Dest, extra: Record<string, unknown> = {}, retried = false): Promise<{ message_id: number; chat_id: number }> {
    // Bots hired outside /new (e.g. by another bot) get their thread on first message.
    if (to && !['team', 'code', 'dm'].includes(to) && group() && bots.find(to) && !bots.find(to)!.topicId) await ensureTopic(to).catch(() => {});
    const t = target(to);
    const opts = { message_thread_id: t.message_thread_id, link_preview_options: { is_disabled: true }, ...extra };
    try {
      const m = await tg.api.sendMessage(t.chat_id, html, { parse_mode: 'HTML', ...opts });
      return { message_id: m.message_id, chat_id: t.chat_id };
    } catch (e: any) {
      const desc = String(e?.description ?? e);
      if (/thread not found|topic.*(closed|deleted)|TOPIC_CLOSED|TOPIC_DELETED/i.test(desc) && !retried && to && to !== 'dm') {
        await ensureTopic(to, true);
        return sendHtml(html, to, extra, true);
      }
      if (!/can't parse|parse entities/i.test(desc)) throw e;
      const m = await tg.api.sendMessage(t.chat_id, html.replace(/<[^>]+>/g, ''), opts);
      return { message_id: m.message_id, chat_id: t.chat_id };
    }
  }

  async function sendMd(md: string, to?: Dest) {
    for (const part of chunkMarkdown(md.trim() || '(empty)')) await sendHtml(mdToHtml(part), to);
  }

  // ---------- approvals & questions ----------

  type Sent = { msgId?: number; chatId?: number };
  const approvals = new Map<string, Sent & { resolve: (d: Decision) => void; html: string; who: string; title: string; since: number }>();
  const questions = new Map<string, Sent & { q: Question; selected: Set<number>; resolve: (a: string) => void; html: string; thread: string; who: string; since: number }>();

  function waitFor<T>(signal: AbortSignal | undefined, fallback: T, register: (resolve: (v: T) => void) => void, onTimeout: () => void): Promise<T> {
    return new Promise<T>((resolve) => {
      let settled = false;
      const done = (v: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      const timer = setTimeout(() => {
        onTimeout();
        done(fallback);
      }, config.approvalTimeoutMs);
      signal?.addEventListener('abort', () => done(fallback), { once: true });
      register(done);
    });
  }

  const ui: UI = {
    send: sendMd,

    async sendFile(p, caption, to) {
      const t = target(to);
      const file = p.startsWith('http') ? p : new InputFile(p);
      const opts = { message_thread_id: t.message_thread_id, ...(caption ? { caption: clip(caption, 1000) } : {}) };
      const big = !p.startsWith('http') && fs.statSync(p).size > 10 * 1024 * 1024;
      if (IMAGE_EXT.test(p) && !big) await tg.api.sendPhoto(t.chat_id, file, opts);
      else if (VIDEO_EXT.test(p)) await tg.api.sendVideo(t.chat_id, file, opts);
      else if (AUDIO_EXT.test(p)) await tg.api.sendAudio(t.chat_id, file, opts);
      else await tg.api.sendDocument(t.chat_id, file, opts);
    },

    async approve({ who, title, detail, signal, to }) {
      const id = rid();
      const html = `🔐 <b>${esc(who)}</b> needs your OK\n<b>${esc(title)}</b>\n<pre>${esc(clip(detail, 2500))}</pre>`;
      const kb = new InlineKeyboard().text('✅ Approve', `ap:${id}:allow`).text('❌ Deny', `ap:${id}:deny`).row().text('✅ Allow for rest of this task', `ap:${id}:always`);
      return waitFor<Decision>(signal, 'deny', (resolve) => {
        approvals.set(id, { resolve, html, who, title, since: Date.now() });
        void sendHtml(html, to, { reply_markup: kb }).then((m) => {
          const a = approvals.get(id);
          if (a) Object.assign(a, { msgId: m.message_id, chatId: m.chat_id });
        });
      }, () => settleApproval(id, 'deny', '⌛ timed out'));
    },

    async ask({ who, questions: qs, signal, to }) {
      const answers: Record<string, string> = {};
      for (const q of qs) {
        const id = rid();
        const opts = q.options.map((o) => `• <b>${esc(o.label)}</b>${o.description ? ` — ${esc(o.description)}` : ''}`).join('\n');
        const html = `❓ <b>${esc(who)}</b> asks:\n<b>${esc(q.question)}</b>\n${opts}\n<i>Tap ${q.multiSelect ? 'one or more, then Done' : 'an option'}, or reply here with your own answer.</i>`;
        answers[q.question] = await waitFor<string>(signal, '(no answer — use your best judgment)', (resolve) => {
          questions.set(id, { q, selected: new Set(), resolve, html, thread: threadKey(target(to)), who, since: Date.now() });
          void sendHtml(html, to, { reply_markup: questionKeyboard(id) }).then((m) => {
            const e = questions.get(id);
            if (e) Object.assign(e, { msgId: m.message_id, chatId: m.chat_id });
          });
        }, () => settleQuestion(id, '(no answer — use your best judgment)'));
      }
      return answers;
    },

    pending() {
      return [
        ...[...approvals.values()].map((a) => ({ kind: 'approval' as const, who: a.who, title: a.title, since: a.since })),
        ...[...questions.values()].map((q) => ({ kind: 'question' as const, who: q.who, title: q.q.question, since: q.since })),
      ];
    },

    status(who, title, to) {
      const t = target(to);
      const lines: string[] = [];
      let msg: { message_id: number; chat_id: number } | undefined;
      let timer: NodeJS.Timeout | undefined;
      let closed = false;
      const render = () => `⏳ <b>${esc(who)}</b> — ${esc(title)}…${lines.length ? '\n' + lines.slice(-8).map((l) => esc(l)).join('\n') : ''}`;
      const sent = sendHtml(render(), to, { disable_notification: true }).then((m) => (msg = m)).catch(() => undefined);
      const typing = setInterval(() => void tg.api.sendChatAction(t.chat_id, 'typing', { message_thread_id: t.message_thread_id }).catch(() => {}), 4500);
      const flush = async () => {
        timer = undefined;
        if (closed) return;
        await sent;
        if (msg) await tg.api.editMessageText(msg.chat_id, msg.message_id, render(), { parse_mode: 'HTML' }).catch(() => {});
      };
      return {
        step(line) {
          lines.push(line);
          if (!timer) timer = setTimeout(() => void flush(), 2000);
        },
        async done(summary) {
          closed = true;
          clearInterval(typing);
          clearTimeout(timer);
          await sent;
          if (msg) await tg.api.editMessageText(msg.chat_id, msg.message_id, `<b>${esc(who)}</b> · ${esc(title)} · ${esc(summary)}`, { parse_mode: 'HTML' }).catch(() => {});
        },
      };
    },
  };
  setUI(ui);

  function settleApproval(id: string, d: Decision, label: string) {
    const a = approvals.get(id);
    if (!a) return;
    approvals.delete(id);
    a.resolve(d);
    if (a.msgId && a.chatId) void tg.api.editMessageText(a.chatId, a.msgId, `${a.html}\n→ ${label}`, { parse_mode: 'HTML' }).catch(() => {});
  }

  function questionKeyboard(id: string) {
    const e = questions.get(id);
    const kb = new InlineKeyboard();
    if (!e) return kb;
    e.q.options.forEach((o, i) => kb.text(`${e.selected.has(i) ? '✔️ ' : ''}${clip(o.label, 40)}`, `q:${id}:${i}`).row());
    if (e.q.multiSelect) kb.text('Done ➡️', `qd:${id}`);
    return kb;
  }

  function settleQuestion(id: string, answer: string) {
    const e = questions.get(id);
    if (!e) return;
    questions.delete(id);
    e.resolve(answer);
    if (e.msgId && e.chatId) void tg.api.editMessageText(e.chatId, e.msgId, `${e.html}\n→ <b>${esc(answer)}</b>`, { parse_mode: 'HTML' }).catch(() => {});
  }

  // ---------- auth ----------

  tg.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!ownerId) {
      const text = ctx.message?.text?.trim() ?? '';
      if (pairingCode && ctx.chat?.type === 'private' && text === `/pair ${pairingCode}` && uid) {
        ownerId = uid;
        state.set({ ownerId: uid });
        fs.rmSync(pairingFile, { force: true });
        log(`[telegram] paired with user ${uid}`);
        await ctx.reply(`✅ Paired! This bot now only listens to you.\n\nNext, give every teammate its own thread:\n\n${SETUP_GUIDE.replace(/\*/g, '')}`);
      } else if (ctx.message && ctx.chat?.type === 'private') {
        await ctx.reply('🔒 This bot is not paired yet. Send /pair <code> using the code shown on the laptop (data/PAIRING_CODE.txt).');
      }
      return;
    }
    if (uid !== ownerId) return; // ignore everyone else
    const isSetup = /^\/setup(@\w+)?\b/.test(ctx.message?.text ?? '');
    if (ctx.chat?.type !== 'private' && ctx.chat?.id !== group()?.chatId && !isSetup) return;
    await next();
  });

  // ---------- where did a message come from? ----------

  /** The destination matching the thread a message was sent in. */
  function here(ctx: Context): Dest {
    if (ctx.chat?.type === 'private') return 'dm';
    const msg = ctx.message ?? ctx.callbackQuery?.message;
    const tid = msg && 'is_topic_message' in msg && msg.is_topic_message ? msg.message_thread_id : undefined;
    const g = group();
    if (tid && tid === g?.codeTopicId) return 'code';
    const b = tid ? bots.all().find((x) => x.topicId === tid) : undefined;
    return b ? b.slug : 'team';
  }

  const activeBot = (): BotRecord => bots.find(state.get().activeBot ?? '') ?? bots.all()[0];
  const label = (b: BotRecord) => `${b.emoji} ${b.name}`;

  /** Bot named in `arg`, else the bot whose thread this is, else the active bot. */
  function botFor(ctx: Context, arg = ''): BotRecord | undefined {
    if (arg.trim()) return bots.find(arg.trim());
    const h = here(ctx);
    return bots.find(h) ?? activeBot();
  }

  const say = (ctx: Context, md: string) => sendMd(md, here(ctx));
  const sayHtml = (ctx: Context, html: string, extra: Record<string, unknown> = {}) => sendHtml(html, here(ctx), extra);

  // ---------- running bots ----------

  async function deliver(bot: BotRecord, prompt: string, to: Dest) {
    const res = await runBot({ slug: bot.slug, prompt, origin: 'user', to });
    if (res.error === 'stopped') return;
    const header = to === bot.slug ? '' : `${label(bot)}\n\n`;
    await sendMd(`${header}${res.error ? `⚠️ ${res.error}\n\n` : ''}${res.text || (res.error ? '' : '(no reply)')}`, to);
  }

  function dispatchToBot(bot: BotRecord, prompt: string, to: Dest) {
    if (isBusy(bot.slug)) void sendHtml(`📥 Queued for ${esc(label(bot))} — finishing another task first. (/stop ${esc(bot.name)} to cancel it)`, to);
    void deliver(bot, prompt, to).catch((e) => sendMd(`⚠️ ${String(e?.message ?? e)}`, to));
  }

  async function codeTurn(task: string, to: Dest) {
    const st = state.get();
    if (!st.code) return void sendMd('No project selected. Send `/code ~/path/to/project` first.', to);
    const res = await runClaudeCode({ dir: st.code.dir, task, sessionId: st.code.sessionId, to });
    if (res.sessionId) state.set({ code: { dir: st.code.dir, sessionId: res.sessionId } });
    if (res.error === 'stopped') return;
    await sendMd(`🧑‍💻 **Claude Code** · ${path.basename(st.code.dir)}\n\n${res.error ? `⚠️ ${res.error}\n\n` : ''}${res.text || ''}`, to);
  }

  /** Routes a user message: pending question in this thread → Claude Code thread → bot thread → Team/DM. */
  function route(ctx: Context, text: string, attachments: string[] = []) {
    const h = here(ctx);
    const key = threadKey(target(h));
    const pending = [...questions.entries()].reverse().find(([, e]) => e.thread === key);
    if (pending && !attachments.length) return settleQuestion(pending[0], text);

    const note = attachments.length ? `\n\n[The user attached: ${attachments.join(', ')}]` : '';
    const fail = (e: any) => sendMd(`⚠️ ${String(e?.message ?? e)}`, h);
    if (h === 'code' || (h === 'dm' && state.get().code && !group())) return void codeTurn(text + note, h).catch(fail);

    const threadBot = bots.find(h);
    if (threadBot) return dispatchToBot(threadBot, text + note, h);

    let bot = activeBot();
    let body = text;
    const m = text.match(/^@?([\w-]+)\s*[:,]\s+([\s\S]+)$/) ?? text.match(/^@([\w-]+)\s+([\s\S]+)$/);
    if (m && bots.find(m[1])) {
      bot = bots.find(m[1])!;
      body = m[2];
    }
    dispatchToBot(bot, body + note, h);
  }

  async function download(fileId: string, name: string, slug: string) {
    const f = await tg.api.getFile(fileId);
    const res = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`);
    const dest = path.join(workspaceOf(slug), 'inbox', `${Date.now()}-${name.replace(/[^\w.-]+/g, '_')}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    return dest;
  }

  // ---------- setup ----------

  tg.command('setup', async (ctx) => {
    if (ctx.chat.type === 'private') return void say(ctx, SETUP_GUIDE);
    const chat = await ctx.api.getChat(ctx.chat.id);
    if (!('is_forum' in chat && chat.is_forum)) return void ctx.reply('Turn on Topics first: group settings → Topics. Then send /setup again.');
    const me = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
    if (me.status !== 'administrator' || !me.can_manage_topics) return void ctx.reply('Make me an admin with the "Manage Topics" permission, then send /setup again.');
    const prev = group();
    if (prev?.chatId !== ctx.chat.id) {
      state.set({ group: { chatId: ctx.chat.id } });
      for (const b of bots.all()) bots.update(b.slug, { topicId: undefined });
    }
    await ensureTopic('team');
    await ensureTopic('code');
    for (const b of bots.all()) await ensureTopic(b.slug);
    await sendMd(`👥 **Team thread** — talk to the active bot (${label(activeBot())}) or anyone with \`Name: message\`. Handoffs between bots and group tasks (/group) show up here.`, 'team');
    await sendMd(`🧑‍💻 **Claude Code thread** — messages here go straight to Claude Code. Pick a project with \`/code ~/Documents/myproject\`, or /sessions to resume one from your terminal.`, 'code');
    await ctx.reply(`✅ Team group ready: a thread for each bot, plus 👥 Team and 🧑‍💻 Claude Code. New hires (/new) get their own thread automatically.`);
    log(`[telegram] team group set up: ${ctx.chat.id}`);
  });

  // ---------- commands ----------

  tg.command(['start', 'help'], (ctx) => say(ctx, HELP + (group() ? '' : `\n\n${SETUP_GUIDE}`)));

  tg.command('bots', async (ctx) => {
    const act = activeBot();
    const kb = new InlineKeyboard();
    const lines = bots.all().map((b) => {
      const link = topicLink(b.topicId);
      if (link) kb.url(`${label(b)} →`, link).row();
      else kb.text(`${b.slug === act.slug ? '● ' : ''}${label(b)}`, `use:${b.slug}`).row();
      return `${b.slug === act.slug ? '▶️' : '▫️'} <b>${esc(label(b))}</b>${isBusy(b.slug) ? ' (working)' : ''}\n   ${esc(b.job)}\n   <i>approvals: ${b.approvalMode} · model: ${esc(b.model ?? 'default')}</i>`;
    });
    await sayHtml(ctx, `<b>Your team</b> (▶️ = active in Team/DMs)\n\n${lines.join('\n\n')}\n\n${group() ? 'Tap to jump to a thread.' : 'Tap to switch.'} /new to hire.`, { reply_markup: kb });
  });

  tg.command('new', async (ctx) => {
    const [name, job, ...desc] = ctx.match.split('|').map((s) => s.trim());
    if (!name || !job) return void say(ctx, 'Usage: `/new Name | job | optional description`\nExample: `/new Scout | Research analyst: competitive and market research | Cites sources, writes crisp briefs`');
    if (!/^[\w-]{2,24}$/.test(name)) return void say(ctx, 'Use a short one-word name (letters, numbers, - or _).');
    const exists = bots.find(name);
    const b = exists ? bots.update(exists.slug, { job, description: desc.join(' | ') })! : bots.create(name, job, desc.join(' | '));
    if (!group()) state.set({ activeBot: b.slug });
    const tid = await ensureTopic(b.slug).catch(() => undefined);
    const link = topicLink(tid);
    await say(ctx, `${exists ? 'Updated' : 'Hired'} ${label(b)} — ${b.job}\n${link ? `Their thread: ${link}` : 'Now active. Say hi, or give them their first task.'}`);
  });

  async function enableAndReport(ctx: Context, id: string, args: string) {
    const t = getTemplate(id);
    if (!t) return void say(ctx, `No agent template "${id}". /agents to list them.`);
    let r: EnableResult;
    try {
      r = enableTemplate(t, parseParams(args));
    } catch (e: any) {
      return void say(ctx, `⚠️ ${e.message}\nUsage: \`/enable ${t.id}${(t.params ?? []).map((p) => ` ${p.key}=…`).join('')} [name=…]\``);
    }
    if (t.usageMonitor) startUsageMonitor(r.bot.slug);
    const tid = await ensureTopic(r.bot.slug).catch(() => undefined);
    const link = topicLink(tid ?? bots.find(r.bot.slug)?.topicId);
    const lines = [`${r.created ? 'Enabled' : 'Updated'} ${label(r.bot)} — ${t.summary}`];
    if (r.files.length) lines.push(`📄 Added: ${r.files.join(', ')}`);
    for (const s of r.schedules) lines.push(`⏰ ${s.name} — \`${s.when}\` (${s.timezone})`);
    if (r.notes.length) lines.push(`(${r.notes.join('; ')})`);
    if (link) lines.push(`Thread: ${link}`);
    const pairs = (t.pairsWith ?? []).filter((p) => !bots.all().some((b) => b.template === p) && getTemplate(p));
    if (pairs.length) lines.push(`\nWorks well with: ${pairs.map((p) => `/enable ${p}`).join(', ')}`);
    if (t.opsFiles) lines.push(`\nNext: tell ${r.bot.name} "interview me about my goals" so the routines know what to work towards.`);
    if (r.schedules.length) lines.push('Pause or delete routines any time with /schedules.');
    await say(ctx, lines.join('\n'));
  }

  tg.command('agents', async (ctx) => {
    const list = listTemplates();
    if (!list.length) return void say(ctx, 'No agent templates found in the agents/ folder.');
    const kb = new InlineKeyboard();
    const lines = list.map((t) => {
      const on = bots.all().filter((b) => b.template === t.id);
      const needs = (t.params ?? []).filter((p) => p.required);
      if (!on.length && !needs.length) kb.text(`Enable ${t.emoji ?? '🤖'} ${t.name}`, `tpl:${t.id}`).row();
      const status = on.length ? `✅ on (${on.map((b) => b.name).join(', ')})` : '▫️ off';
      return `<b>${esc(`${t.emoji ?? '🤖'} ${t.name}`)}</b> · <code>${t.id}</code> · ${status}\n${esc(t.summary)}${needs.length ? `\n<i>/enable ${t.id} ${needs.map((p) => `${p.key}=…`).join(' ')}</i>` : ''}`;
    });
    await sayHtml(ctx, `<b>Ready-made teammates</b>\n\n${lines.join('\n\n')}\n\nTap to enable, or <code>/enable id [name=…]</code>.`, { reply_markup: kb });
  });

  tg.command('enable', async (ctx) => {
    const [id, ...rest] = ctx.match.trim().split(/\s+/);
    if (!id) return void say(ctx, 'Usage: `/enable meter` or `/enable liaison dir=~/Documents/my-app name=Atlas`. /agents lists them.');
    await enableAndReport(ctx, id, rest.join(' '));
  });

  tg.command('use', async (ctx) => {
    const b = bots.find(ctx.match);
    if (!b) return void say(ctx, 'No such bot. /bots to list.');
    state.set({ activeBot: b.slug, ...(group() ? {} : { code: undefined }) });
    await say(ctx, `Active bot is now ${label(b)}.`);
  });

  tg.command('job', async (ctx) => {
    const [name, job] = ctx.match.split('|').map((s) => s.trim());
    const b = name ? bots.find(name) : undefined;
    if (!b || !job) return void say(ctx, 'Usage: `/job Name | new job description`');
    bots.update(b.slug, { job });
    await say(ctx, `${label(b)}'s job is now: ${job}`);
  });

  tg.command('fire', async (ctx) => {
    const b = bots.find(ctx.match);
    if (!b) return void say(ctx, 'Usage: `/fire Name`');
    await sayHtml(ctx, `Remove <b>${esc(label(b))}</b>? Their thread is closed; memory and workspace stay on disk in data/bots/${b.slug}.`, {
      reply_markup: new InlineKeyboard().text('Yes, remove', `fire:${b.slug}`).text('Cancel', 'noop'),
    });
  });

  tg.command('stop', async (ctx) => {
    const arg = ctx.match.trim();
    const h = here(ctx);
    const key = arg === 'all' ? undefined : arg ? bots.find(arg)?.slug : bots.find(h)?.slug ?? (h === 'code' && state.get().code ? `code:${state.get().code!.dir}` : undefined);
    const stopped = stop(key);
    for (const id of approvals.keys()) if (!key) settleApproval(id, 'deny', '🛑 stopped');
    for (const id of questions.keys()) if (!key) settleQuestion(id, '(stopped)');
    await say(ctx, stopped.length ? `🛑 Stopped: ${stopped.join(', ')}` : 'Nothing was running.');
  });

  tg.command('reset', async (ctx) => {
    const b = botFor(ctx, ctx.match);
    if (!b) return;
    if (!b.sessionId) return void say(ctx, `${label(b)} is already on a fresh conversation.`);
    await say(ctx, `Wrapping up ${label(b)}'s conversation — saving what matters to memory…`);
    const res = await runBot({
      slug: b.slug,
      origin: 'system',
      title: 'saving memories',
      to: here(ctx),
      prompt: 'We are about to start a fresh conversation. Use the remember tool to save any durable facts, preferences, decisions or unfinished work from this conversation that are not already in memory (skip trivia). Then reply "ok".',
    });
    bots.update(b.slug, { sessionId: undefined });
    await say(ctx, `🧹 ${label(b)} starts fresh${res.error ? ` (memory save failed: ${res.error})` : ''}. Memories and skills are kept.`);
  });

  tg.command('mode', async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const modes = ['auto', 'ask', 'strict'];
    const mode = parts.find((p) => modes.includes(p)) as ApprovalMode | undefined;
    const target = botFor(ctx, parts.find((p) => !modes.includes(p)) ?? '');
    if (!target) return void say(ctx, 'No such bot.');
    if (!mode) {
      return void say(ctx, `${label(target)} approval mode: **${target.approvalMode}**\n\n• **auto** — only money, force-pushes, sudo and mass deletion need approval\n• **ask** — also sending, posting, deleting, deploying and editing sensitive files (default)\n• **strict** — nearly every action needs approval\n\nUsage: \`/mode ask\` or \`/mode Name strict\``);
    }
    bots.update(target.slug, { approvalMode: mode });
    await say(ctx, `${label(target)} approval mode → **${mode}**`);
  });

  tg.command('model', async (ctx) => {
    const parts = ctx.match.trim().split(/\s+/).filter(Boolean);
    const named = parts.length === 2 ? bots.find(parts[0]) : undefined;
    const b = named ?? botFor(ctx);
    const m = named ? parts[1] : parts[0];
    if (!b) return;
    if (!m) return void say(ctx, `${label(b)} uses model: **${b.model ?? 'default (your Claude Code setting)'}**\nUsage: \`/model sonnet\`, \`/model opus\`, \`/model haiku\`, \`/model default\` (or \`/model Name sonnet\`)`);
    bots.update(b.slug, { model: m === 'default' ? undefined : m });
    await say(ctx, `${label(b)} model → **${m}**`);
  });

  tg.command('memory', async (ctx) => {
    const b = botFor(ctx, ctx.match);
    await say(ctx, `**About you** (shared by all bots)\n${readMemory('user') || '(empty)'}\n\n**${b?.name}'s memory**\n${b ? readMemory('bot', b.slug) || '(empty)' : ''}`);
  });

  tg.command('remember', async (ctx) => {
    if (!ctx.match.trim()) return void say(ctx, 'Usage: `/remember I prefer bullet-point summaries`');
    remember('user', ctx.match.trim());
    await say(ctx, '🧠 Saved for all bots.');
  });

  tg.command('forget', async (ctx) => {
    const q = ctx.match.trim();
    if (!q) return void say(ctx, 'Usage: `/forget text` — deletes memory lines containing that text.');
    let n = forget('user', q);
    for (const b of bots.all()) n += forget('bot', q, b.slug);
    await say(ctx, `🧽 Removed ${n} memory line(s).`);
  });

  tg.command('skills', async (ctx) => {
    const one = ctx.match.trim() ? botFor(ctx, ctx.match) : bots.find(here(ctx));
    const list = (one ? [one] : bots.all()).map((b) => {
      const dir = path.join(workspaceOf(b.slug), '.claude', 'skills');
      const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, 'SKILL.md'))) : [];
      return `**${label(b)}**: ${names.length ? names.join(', ') : '(none yet)'}`;
    });
    await say(ctx, `${list.join('\n')}\n\nTeach a skill: do a task with a bot, then say "save this as a skill". Or describe a routine step by step and say "learn this".`);
  });

  tg.command('schedules', async (ctx) => {
    const threadBot = bots.find(here(ctx));
    const list = schedules.all().filter((s) => !threadBot || s.bot === threadBot.slug);
    if (!list.length) return void say(ctx, 'No schedules yet. Ask a bot, e.g. "every weekday at 8am send me a brief of AI news".');
    for (const s of list) {
      const next = scheduler.nextRun(s);
      const kb = new InlineKeyboard().text('▶️ Run now', `sch:run:${s.id}`).text(s.enabled ? '⏸ Pause' : '▶️ Resume', `sch:toggle:${s.id}`).text('🗑', `sch:del:${s.id}`);
      await sayHtml(ctx, `⏰ <b>${esc(s.name)}</b> · ${esc(bots.find(s.bot)?.name ?? s.bot)}\n<code>${esc(s.when)}</code> ${esc(s.timezone)}${s.enabled ? '' : ' · <i>paused</i>'}\nnext: ${next ? esc(next.toLocaleString('en-US', { timeZone: s.timezone, dateStyle: 'medium', timeStyle: 'short' })) : '—'} · last: ${esc(s.lastRun?.slice(0, 16).replace('T', ' ') ?? 'never')}${s.lastStatus && s.lastStatus !== 'ok' ? ` (${esc(s.lastStatus)})` : ''}\n<i>${esc(clip(s.prompt, 300))}</i>`, { reply_markup: kb });
    }
  });

  tg.command('group', async (ctx) => {
    const m = ctx.match.match(/^([\w-]+(?:\s*,\s*[\w-]+)+)\s+([\s\S]+)$/);
    const members = m ? m[1].split(',').map((n) => bots.find(n)) : [];
    if (!m || members.some((b) => !b) || members.length < 2 || members.length > 6) {
      return void say(ctx, 'Usage: `/group Scout,Writer research our top 3 competitors and draft a one-page brief`\n(2–6 existing bots; the first one leads.)');
    }
    const [lead, ...rest] = members as BotRecord[];
    const to: Dest = group() ? 'team' : here(ctx);
    if (group() && here(ctx) !== 'team') await say(ctx, `👥 Group task started in the Team thread${topicLink(group()?.teamTopicId) ? `: ${topicLink(group()?.teamTopicId)}` : ''}`);
    await sendMd(`👥 **Group task** — ${members.map((b) => label(b!)).join(', ')} (lead: ${lead.name})\n${m[2]}`, to);
    dispatchToBot(lead, `[Group task] You are leading this task with teammates ${rest.map((b) => `${b.name} (${b.job})`).join(', ')}. Split the work sensibly, delegate parts with ask_bot (give them full context), combine their results, and deliver the finished result.\n\nTask: ${m[2]}`, to);
  });

  tg.command('code', async (ctx) => {
    const arg = ctx.match.trim();
    const st = state.get();
    const inGroup = !!group();
    const where = inGroup ? 'Messages in the 🧑‍💻 Claude Code thread' : 'Your messages';
    if (!arg) return void say(ctx, st.code ? `🧑‍💻 Project: \`${st.code.dir}\`${st.code.sessionId ? ' (continuing session)' : ''}\n${where} go straight to Claude Code. \`/code new\` for a fresh session, /sessions to resume another${inGroup ? '' : ', `/code off` to exit'}.` : 'Usage: `/code ~/Documents/myproject` — talk directly to Claude Code in that folder.');
    if (arg === 'off') {
      state.set({ code: undefined });
      return void say(ctx, inGroup ? 'Cleared the Claude Code project.' : `Left code mode. Back to ${label(activeBot())}.`);
    }
    if (arg === 'new' && st.code) {
      state.set({ code: { dir: st.code.dir } });
      return void say(ctx, 'Fresh Claude Code session. Send your task.');
    }
    const dir = path.resolve(arg.replace(/^~(?=$|\/)/, HOME));
    if (!fs.existsSync(dir)) return void say(ctx, `Not found: \`${dir}\``);
    state.set({ code: { dir } });
    const link = inGroup ? topicLink(group()?.codeTopicId) : undefined;
    await say(ctx, `🧑‍💻 Claude Code project: \`${dir}\`\n${where} now go to Claude Code there (with that project's CLAUDE.md and skills).${link ? `\nThread: ${link}` : ''} /sessions to resume an earlier session${inGroup ? '' : ', `/code off` to exit'}.`);
  });

  let sessionPick: { id: string; dir: string }[] = [];
  tg.command('sessions', async (ctx) => {
    const st = state.get();
    const list = await listSessions({ dir: st.code?.dir, limit: 8 });
    if (!list.length) return void say(ctx, 'No Claude Code sessions found.');
    sessionPick = list.map((s) => ({ id: s.sessionId, dir: s.cwd ?? st.code?.dir ?? HOME }));
    const kb = new InlineKeyboard();
    list.forEach((s, i) => kb.text(`${i + 1}. ${clip(s.customTitle || s.summary || s.firstPrompt || s.sessionId, 34)}`, `ses:${i}`).row());
    await sayHtml(ctx, `<b>Recent Claude Code sessions</b>${st.code ? ` in ${esc(path.basename(st.code.dir))}` : ''}\n${list.map((s, i) => `${i + 1}. ${esc(clip(s.customTitle || s.summary || '', 80))} — <i>${esc(path.basename(s.cwd ?? ''))}, ${new Date(s.lastModified).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' })}</i>`).join('\n')}\n\nTap one to continue it from here.`, { reply_markup: kb });
  });

  tg.command('browser', async (ctx) => {
    const url = ctx.match.trim();
    if (!url) return void say(ctx, 'Usage: `/browser https://mail.google.com` — opens it in the shared Chrome window on the laptop, e.g. so you can sign in once for all bots.');
    const b = botFor(ctx)!;
    dispatchToBot(b, `Open ${url} in the browser (browser_navigate) and leave it there — the user wants to sign in or look at it on the laptop. Take a screenshot and send_file it, then reply in one line.`, here(ctx));
  });

  tg.command('status', async (ctx) => {
    const busy = busyKeys();
    const st = state.get();
    await say(ctx, `**ClaudeBot** is up ${Math.round(process.uptime() / 60)} min\nActive: ${label(activeBot())}${st.code ? ` · Claude Code project \`${st.code.dir}\`` : ''}\nWorking now: ${busy.length ? busy.join(', ') : 'nothing'}\nBots: ${bots.all().length} · schedules: ${schedules.all().filter((s) => s.enabled).length} active\nPending approvals: ${approvals.size}\nTeam group: ${group() ? 'connected' : 'not set up (/setup)'}`);
  });

  tg.command('pair', (ctx) => ctx.reply('Already paired ✅'));

  // ---------- buttons ----------

  tg.on('callback_query:data', async (ctx) => {
    const [kind, a, b] = ctx.callbackQuery.data.split(':');
    await ctx.answerCallbackQuery().catch(() => {});
    if (kind === 'ap') settleApproval(a, b as Decision, b === 'deny' ? '❌ denied' : b === 'always' ? '✅ allowed for this task' : '✅ approved');
    else if (kind === 'q') {
      const e = questions.get(a);
      if (!e) return;
      const i = Number(b);
      if (!e.q.multiSelect) return settleQuestion(a, e.q.options[i].label);
      e.selected.has(i) ? e.selected.delete(i) : e.selected.add(i);
      if (e.msgId && e.chatId) await ctx.api.editMessageReplyMarkup(e.chatId, e.msgId, { reply_markup: questionKeyboard(a) }).catch(() => {});
    } else if (kind === 'qd') {
      const e = questions.get(a);
      if (e) settleQuestion(a, [...e.selected].map((i) => e.q.options[i].label).join(', ') || '(none)');
    } else if (kind === 'tpl') {
      await enableAndReport(ctx, a, '');
    } else if (kind === 'use') {
      const bot = bots.find(a);
      if (bot) {
        state.set({ activeBot: bot.slug, ...(group() ? {} : { code: undefined }) });
        await say(ctx, `Active bot is now ${label(bot)}.`);
      }
    } else if (kind === 'fire') {
      const bot = bots.find(a);
      if (!bot) return;
      if (bots.all().length === 1) return void say(ctx, "You can't remove your last bot.");
      const g = group();
      if (g && bot.topicId) await ctx.api.closeForumTopic(g.chatId, bot.topicId).catch(() => {});
      bots.remove(bot.slug);
      for (const s of schedules.all().filter((s) => s.bot === bot.slug)) {
        scheduler.unregister(s.id);
        schedules.remove(s.id);
      }
      if (state.get().activeBot === bot.slug) state.set({ activeBot: bots.all()[0].slug });
      await say(ctx, `${label(bot)} removed.`);
    } else if (kind === 'sch') {
      const s = schedules.all().find((x) => x.id === b);
      if (!s) return void say(ctx, 'That schedule no longer exists.');
      if (a === 'run') void scheduler.fire(s.id);
      else if (a === 'toggle') {
        schedules.update(s.id, { enabled: !s.enabled });
        scheduler.register({ ...s, enabled: !s.enabled });
        await say(ctx, `⏰ ${s.name} ${s.enabled ? 'paused' : 'resumed'}.`);
      } else if (a === 'del') {
        scheduler.unregister(s.id);
        schedules.remove(s.id);
        await say(ctx, `🗑 Deleted schedule ${s.name}.`);
      }
    } else if (kind === 'ses') {
      const pick = sessionPick[Number(a)];
      if (!pick) return;
      state.set({ code: { dir: pick.dir, sessionId: pick.id } });
      const where = group() ? `the 🧑‍💻 Claude Code thread${topicLink(group()?.codeTopicId) ? ` (${topicLink(group()?.codeTopicId)})` : ''}` : 'here';
      await say(ctx, `🧑‍💻 Continuing that session in \`${pick.dir}\`. Send your next message in ${where}. (Avoid typing into the same session in the terminal at the same time.)`);
    }
  });

  // ---------- messages ----------

  tg.on('message:text', (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return void say(ctx, 'Unknown command. /help');
    route(ctx, text);
  });

  tg.on(['message:photo', 'message:document', 'message:video'], async (ctx) => {
    const msg = ctx.message;
    const h = here(ctx);
    const slug = bots.find(h)?.slug ?? activeBot().slug;
    let file: string;
    if (msg.photo) file = await download(msg.photo[msg.photo.length - 1].file_id, 'photo.jpg', slug);
    else if (msg.document) file = await download(msg.document.file_id, msg.document.file_name ?? 'file', slug);
    else file = await download(msg.video!.file_id, msg.video!.file_name ?? 'video.mp4', slug);
    route(ctx, msg.caption?.trim() || 'I sent you this file — take a look.', [file]);
  });

  tg.on(['message:voice', 'message:audio'], (ctx) =>
    say(ctx, "🎙 Voice notes aren't transcribed yet — use your keyboard's dictation (the mic key) instead."),
  );

  tg.catch((err) => log('[telegram] error', err.error));

  const commands = [
    { command: 'bots', description: 'Your team — jump to threads' },
    { command: 'agents', description: 'Ready-made teammates to enable' },
    { command: 'new', description: 'Hire a teammate: Name | job | description' },
    { command: 'stop', description: 'Stop what is running' },
    { command: 'reset', description: 'Fresh conversation (keeps memory)' },
    { command: 'schedules', description: 'Scheduled tasks' },
    { command: 'skills', description: 'Learned routines' },
    { command: 'memory', description: 'What the bots remember' },
    { command: 'code', description: 'Pick the Claude Code project' },
    { command: 'sessions', description: 'Resume a Claude Code session' },
    { command: 'group', description: 'Bots collaborate: A,B task' },
    { command: 'mode', description: 'Approval level: auto | ask | strict' },
    { command: 'model', description: 'Model for this bot' },
    { command: 'browser', description: 'Open a page in the shared browser' },
    { command: 'status', description: "What's running" },
    { command: 'setup', description: 'Create team threads (in a group)' },
    { command: 'help', description: 'How to use ClaudeBot' },
  ];
  void tg.api.setMyCommands(commands).catch(() => {});
  void tg.api.setMyCommands(commands, { scope: { type: 'all_group_chats' } }).catch(() => {});

  void tg.start({
    drop_pending_updates: false,
    allowed_updates: ['message', 'callback_query'],
    onStart: (me) => log(`[telegram] @${me.username} online`),
  }).catch((e) => {
    log(`[telegram] could not connect: ${String(e?.description ?? e?.message ?? e)}. Check TELEGRAM_BOT_TOKEN in .env.`);
    process.exit(1);
  });
  return {
    stop: () => tg.stop(),
    notifyOwner: (md: string) => (ownerId ? sendMd(md, 'team') : Promise.resolve()),
  };
}
