# BizBot

**Run your business with an AI team.** BizBot gives you a company of always-on Claude agents. Each one has a role: chief of staff, operations, research, a lead per project. They work on your Mac, run the daily rhythm of a real business, and report to you on **Telegram**. It's powered by **your own Claude subscription**.

You're the founder. Every morning your chief of staff runs a standup with the team and sends you the plan. During the day a foreman keeps work moving and only pings you for decisions, sign-offs and blockers. Every evening you get an honest end-of-day report, and every Monday a review against your goals. Anything outward-facing (emails, posts, deploys, spending) waits for your Approve button.

Under the hood every teammate is headless Claude Code (via the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)). So they get Claude Code's tools (terminal, files, web search, your MCP servers and claude.ai connectors) plus a shared browser, memory, schedules, approvals and teamwork. BizBot started as a self-hosted take on xAI's Grok Bot.

```
You, the founder (Telegram on phone or desktop)
  └─ your company HQ: a private group with Topics
       ├─ 👥 Team             company channel: talk to anyone, watch handoffs
       ├─ 🤖 Claude           chief of staff: standups, reviews, delegation
       ├─ 🐙 Foreman          operations: keeps work moving all day
       ├─ 📊 Meter            budget: your Claude usage
       ├─ 🧭 Atlas            project lead for ~/code/my-app
       ├─ 🧑‍💻 Claude Code      direct line to Claude Code in any project
       └─ …one thread per hire
                 │
        your always-on Mac ── BizBot (Node) ── Claude Agent SDK ── your Claude plan
                                   ├─ shared Chrome (Playwright MCP, sign-ins persist)
                                   ├─ goals, policy, standups (data/ops)
                                   ├─ schedules, memory, skills, approvals
                                   └─ your claude.ai connectors and MCP servers
```

## Features

| | |
|---|---|
| **An org chart, not a chatbot** | `/new Name \| job` hires for a role. Each hire has its own persistent session, memory, workspace, skills and Telegram thread. |
| **A company starter kit** | `/agents` switches on a ready-made team: a chief of staff with the daily and weekly rhythm, an operations foreman, a usage budget keeper and project leads. See [agents/](agents/). |
| **Goals and policy** | `GOALS.md` says what the company is working towards. `POLICY.md` says what the team may do on its own and what needs you. Every routine works from both. |
| **Real work on a real computer** | Terminal, filesystem, web search, and one shared Chrome profile so sites you sign into stay signed in for every teammate. |
| **Your tools** | Your claude.ai connectors (Gmail, Calendar, Drive, …) and Claude Code MCP servers load automatically. |
| **Sign-offs** | Before sending, posting, deleting, deploying or spending, you get Approve / Deny buttons. `/mode auto\|ask\|strict` per teammate. |
| **Questions** | When a teammate needs a decision, it asks with buttons instead of guessing. |
| **Schedules** | "Every weekday at 8am, brief me on…": cron or one-off times, managed with `/schedules`. |
| **Playbooks** | Do a task once, then say "save this as a skill". The teammate can rerun it later or on a schedule. |
| **Teamwork** | Teammates delegate to each other (`ask_bot`), and `/group A,B task` runs a collaboration. |
| **Engineering on tap** | `/code ~/project` drives Claude Code in a project. `/sessions` resumes a session you started in the terminal. |
| **Budget aware** | Plan-limit alerts, and routines that skip themselves when you're close to your Claude limits. |
| **Optional** | 1Password logins typed straight into the browser (secrets never reach the model), and fal.ai image generation. |

## Requirements

- **macOS** on a machine that stays on. The core runs anywhere Node does, but the background service, keep-awake and Keychain integration are macOS-only.
- **Node.js 22.18+** (runs the TypeScript directly; no build step).
- **Claude Code**, [installed](https://code.claude.com/docs/en/setup) and signed in with your Claude Pro or Max plan (`claude`, then `/login`).
- **Google Chrome** for the shared browser.
- **Telegram** on your phone and/or desktop.

## Install

```bash
git clone https://github.com/danielsapps2/bizbot.git
cd bizbot
npm install
cp .env.example .env
```

1. **Create your Telegram bot.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and put the token in `.env` as `TELEGRAM_BOT_TOKEN`.
2. **Start it:** `npm start`.
3. **Pair it with your account.** The terminal (and `data/PAIRING_CODE.txt`) shows a code. Send `/pair <code>` to your bot. From then on it ignores everyone else.
4. **Create your team group.** In Telegram, create a group and add your bot. Turn on **Topics**. Make the bot an admin with **Manage Topics**, and check that "Remain anonymous" is off for you. Then send `/setup` in the group. You get a thread per bot, plus 👥 Team and 🧑‍💻 Claude Code.
5. **Staff your company:** `/agents` for the starter team, then `/new Name | job | description` for any role you need. Tell your chief of staff "interview me about my goals" to set up `GOALS.md`.
6. **Make it always-on:** stop the foreground run and `npm run service:install`. It starts at login, restarts on crashes and keeps the Mac awake while plugged in. Closing a MacBook's lid still sleeps it unless an external display is attached, or you run `sudo pmset -a disablesleep 1` (undo with `0`).

Then just talk to your bots in their threads.

## Your starting team

| | Agent | Role |
|---|---|---|
| 🤖 | `chief-of-staff` | Upgrades your default Claude bot. It runs an 8am standup and an 8pm end-of-day check-in across the team, plus a Monday weekly review, all against your goals in `data/ops/GOALS.md`. Ask it to "interview me about my goals" to set them up. |
| 📊 | `meter` | Watches your Claude plan limits (5-hour, weekly, per-model). It posts alerts at milestones, near limits and resets, and advises how to stretch usage. Checking usage costs no tokens. |
| 🐙 | `foreman` | Every 30 min during the day it nudges idle bots to their next step from the morning plan. It stays quiet unless something needs you, and skips itself when usage is high. |
| 🧭 | `liaison` | Your eyes and ears on one code project: activity, progress, blockers, and work briefed in through Claude Code. `/enable liaison dir=~/code/my-app name=Atlas`. Enable one per project. |

Enable them from `/agents` in Telegram. Then hire for whatever your business needs, for example `/new Scout | Market researcher: competitors, pricing, customer interviews`, `/new Quill | Marketing: content calendar, posts and newsletters (drafts only)` or `/new Ledger | Bookkeeping: track revenue and costs in a spreadsheet`. To package a role as a reusable template, see [agents/README.md](agents/README.md).

## Everyday use

- Chat in a bot's thread to work with that bot. Its approvals, questions and scheduled results show up there too.
- In 👥 Team, the active bot answers, or use `Scout: find …` to address one. `/group A,B task` runs a collaboration there.
- In 🧑‍💻 Claude Code, pick a project with `/code ~/path`. `/sessions` resumes one from your terminal.
- Inside a bot's thread, `/reset`, `/mode`, `/model`, `/memory`, `/schedules` and `/stop` apply to that bot.
- `/model` sets a bot's model and reasoning effort, for example `/model haiku low`, `/model Scout sonnet medium` or `/model opus high`. `/model haiku` means the current Haiku. A good split: a strong model at high effort for coding and hard tasks, Sonnet for judgment-heavy agentic work, Haiku for routine chat.
- Claude Code sessions (the `claude_code` tool and `/code`) run on `CODE_MODEL` at `CODE_EFFORT`, Opus at high by default, whatever model the bot itself uses.
- Send photos or files. They land in the bot's `inbox/` folder.
- To sign in to a site once for all bots, send `/browser https://mail.google.com` and log in on the Chrome window on the Mac.
- `/help` lists every command.

Without a group, everything also works in a direct chat with your bot. Switch bots there with `/use`.

## Approvals and safety

Bots run with your user account's access to your Mac, so BizBot gates risky actions:

- **`ask`** (default): asks before destructive shell commands, sending or posting through connectors, deploying, editing sensitive dotfiles, and anything involving money.
- **`auto`**: only asks for money, `sudo`, force-pushes and mass deletion.
- **`strict`**: asks for nearly everything.

On top of that, bots are told to call `request_approval` before any outward-facing action, and unanswered approvals are denied after `APPROVAL_TIMEOUT_MIN`. Only the paired Telegram account can talk to the bot. In a group, messages from other members are ignored.

## 1Password (optional)

Bots can sign in to sites themselves with logins from one dedicated 1Password vault. The `fill_login` tool reads an item using a read-only service account and types it straight into the open tab over a local CDP port (`BROWSER_CDP_PORT`, default 9223). Secrets never go to the model:

- tool results only name the item and say which fields were filled
- password inputs show as `********` in browser snapshots (BizBot patches Playwright at startup)
- a login is typed only into a tab and frame on the same site as one of the item's URLs
- the `op` CLI and the Keychain token are blocked from bots' Bash

Setup:

1. Install the CLI: `brew install --cask 1password-cli`.
2. In 1Password, create a vault named `BizBot` (or set `OP_VAULT`). Copy in only the logins bots should use. Each one needs its website URL, and it can include a one-time password.
3. Create a service account with **read** access to that vault only: 1Password.com → Developer → Directory → Service Accounts.
4. Store its token in the Keychain. The command prompts for the token, so it stays out of your shell history:
   `security add-generic-password -s bizbot-1password -a service-account -w`
5. Run `npm run service:restart`.

## Configuration

Settings live in `.env` (see [.env.example](.env.example)). The main ones:

| Variable | Default | |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | required |
| `TELEGRAM_OWNER_ID` | — | skip pairing by setting your Telegram user id |
| `DEFAULT_MODEL` | your Claude Code default | model for newly hired bots (`sonnet`, `opus`, `haiku`) |
| `TZ_NAME` | system timezone | timezone for schedules |
| `FAL_KEY` | — | enables the built-in `generate_image` tool |
| `BROWSER_HEADLESS` | off | `1` hides the shared Chrome window |
| `APPROVAL_TIMEOUT_MIN` | 60 | unanswered approvals are denied after this long |

Everything BizBot stores (bots, memories, workspaces, schedules, the browser profile) lives in `data/`, which is git-ignored. Back it up if you care about your bots' memories.

## Using your Claude subscription

BizBot runs the official, unmodified Claude Code through the Agent SDK, signed in with your own account. It never reads or stores your Claude credentials. Anthropic's [terms for Claude Code](https://code.claude.com/docs/en/legal-and-compliance) allow subscription sign-in for ordinary, individual use. So run BizBot for yourself on your own machine with your own account. Don't share your bot with other people or offer it as a service. Always-on routines use your plan's limits like any other Claude Code use; the `meter` agent helps keep an eye on that. If you'd rather pay per use, set `ANTHROPIC_API_KEY` in `.env` and the SDK uses that instead.

## Commands

`npm start` (foreground) · `npm run service:install` · `npm run service:restart` · `npm run service:uninstall` · `npm run logs` · `npm run typecheck`

## Layout

```
agents/           ready-made teammates (templates) you can /enable
src/index.ts      boot: default bot, browser server, Telegram, schedules, usage monitor
src/agent.ts      runs a bot (Agent SDK query) and Claude Code sessions
src/tools.ts      bot tools: memory, approvals, files, handoffs, skills, schedules, claude_code, usage, usage_report, team_status, logins, images
src/templates.ts  installs agents/ templates
src/policy.ts     what needs approval
src/telegram.ts   the remote control (DMs and the Topics group)
src/scheduler.ts  cron jobs
src/usage.ts      Claude plan usage monitor
src/usagelog.ts   per-run token log and the usage_report tool (who spends the plan, and what a model change saves)
src/vault.ts      1Password sign-ins
data/             your bots, memories, workspaces, schedules, browser profile (git-ignored)
```

## License

MIT. Not affiliated with Anthropic, xAI or Telegram.
