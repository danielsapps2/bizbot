# ClaudeBot

Always-on AI teammates that do real work on your Mac, powered by **your own Claude subscription** and controlled from **Telegram** on your phone or desktop.

ClaudeBot is a self-hosted take on xAI's Grok Bot. Each teammate is a named Claude agent with a job, its own memory, workspace and skills, and its own thread in a private Telegram group. Under the hood every bot is headless Claude Code (via the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)), so bots get Claude Code's tools: terminal, files, web search, your MCP servers and claude.ai connectors. On top of that they get a shared browser, schedules, approvals and teamwork.

```
You (Telegram, phone or desktop)
  └─ private group with Topics
       ├─ 👥 Team             talk to anyone, watch bots hand work to each other
       ├─ 🧑‍💻 Claude Code      drive Claude Code in any project on the Mac
       ├─ 🤖 Claude           chief of staff
       ├─ 📊 Meter            usage alerts
       └─ …one thread per teammate
                 │
        your always-on Mac ── ClaudeBot (Node) ── Claude Agent SDK ── your Claude plan
                                   ├─ shared Chrome (Playwright MCP, sign-ins persist)
                                   ├─ schedules, memory, skills, approvals
                                   └─ your claude.ai connectors and MCP servers
```

## Features

| | |
|---|---|
| **Teammates** | `/new Name \| job` hires a bot. Each one has its own persistent session, memory, workspace, skills and Telegram thread. |
| **Ready-made agents** | `/agents` turns on prebuilt teammates and routines: a chief of staff with daily standups, a usage meter, a foreman and project liaisons. See [agents/](agents/). |
| **Real work on a real computer** | Terminal, filesystem, web search, and one shared Chrome profile so sites you sign into stay signed in for every bot. |
| **Your tools** | Your claude.ai connectors (Gmail, Calendar, Drive, …) and Claude Code MCP servers load automatically. |
| **Approvals** | Before sending, posting, deleting, deploying or spending, you get Approve / Deny buttons. `/mode auto\|ask\|strict` per bot. |
| **Questions** | When a bot needs a decision it asks with buttons instead of guessing. |
| **Schedules** | "Every weekday at 8am, brief me on…": cron or one-off times, managed with `/schedules`. |
| **Skills** | Do a task once, then say "save this as a skill". The bot can rerun it later or on a schedule. |
| **Teamwork** | Bots delegate to each other (`ask_bot`), and `/group A,B task` runs a collaboration. |
| **Claude Code remote** | `/code ~/project` drives Claude Code in a project. `/sessions` resumes a session you started in the terminal. |
| **Usage aware** | Plan-limit alerts, and routines that skip themselves when you're close to your limits. |
| **Optional** | 1Password logins typed straight into the browser (secrets never reach the model), and fal.ai image generation. |

## Requirements

- **macOS** on a machine that stays on. The core runs anywhere Node does, but the background service, keep-awake and Keychain integration are macOS-only.
- **Node.js 22.18+** (runs the TypeScript directly; no build step).
- **Claude Code**, [installed](https://code.claude.com/docs/en/setup) and signed in with your Claude Pro or Max plan (`claude`, then `/login`).
- **Google Chrome** for the shared browser.
- **Telegram** on your phone and/or desktop.

## Install

```bash
git clone https://github.com/danielsapps2/claudebot.git
cd claudebot
npm install
cp .env.example .env
```

1. **Create your Telegram bot.** In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and put the token in `.env` as `TELEGRAM_BOT_TOKEN`.
2. **Start it:** `npm start`.
3. **Pair it with your account.** The terminal (and `data/PAIRING_CODE.txt`) shows a code. Send `/pair <code>` to your bot. From then on it ignores everyone else.
4. **Create your team group.** In Telegram, create a group and add your bot. Turn on **Topics**. Make the bot an admin with **Manage Topics**, and check that "Remain anonymous" is off for you. Then send `/setup` in the group. You get a thread per bot, plus 👥 Team and 🧑‍💻 Claude Code.
5. **Add teammates:** `/agents` (ready-made) or `/new Name | job | description` (your own).
6. **Make it always-on:** stop the foreground run and `npm run service:install`. It starts at login, restarts on crashes and keeps the Mac awake while plugged in. Closing a MacBook's lid still sleeps it unless an external display is attached, or you run `sudo pmset -a disablesleep 1` (undo with `0`).

Then just talk to your bots in their threads.

## Ready-made agents

| | Agent | What it does |
|---|---|---|
| 🤖 | `chief-of-staff` | Upgrades your default Claude bot. It runs an 8am standup and an 8pm end-of-day check-in across the team, plus a Monday weekly review, all against your goals in `data/ops/GOALS.md`. Ask it to "interview me about my goals" to set them up. |
| 📊 | `meter` | Watches your Claude plan limits (5-hour, weekly, per-model). It posts alerts at milestones, near limits and resets, and advises how to stretch usage. Checking usage costs no tokens. |
| 🐙 | `foreman` | Every 30 min during the day it nudges idle bots to their next step from the morning plan. It stays quiet unless something needs you, and skips itself when usage is high. |
| 🧭 | `liaison` | Your eyes and ears on one code project: activity, progress, blockers, and work briefed in through Claude Code. `/enable liaison dir=~/code/my-app name=Atlas`. Enable one per project. |

Enable them from `/agents` in Telegram. To write your own, see [agents/README.md](agents/README.md).

## Everyday use

- Chat in a bot's thread to work with that bot. Its approvals, questions and scheduled results show up there too.
- In 👥 Team, the active bot answers, or use `Scout: find …` to address one. `/group A,B task` runs a collaboration there.
- In 🧑‍💻 Claude Code, pick a project with `/code ~/path`. `/sessions` resumes one from your terminal.
- Inside a bot's thread, `/reset`, `/mode`, `/model`, `/memory`, `/schedules` and `/stop` apply to that bot.
- Send photos or files. They land in the bot's `inbox/` folder.
- To sign in to a site once for all bots, send `/browser https://mail.google.com` and log in on the Chrome window on the Mac.
- `/help` lists every command.

Without a group, everything also works in a direct chat with your bot. Switch bots there with `/use`.

## Approvals and safety

Bots run with your user account's access to your Mac, so ClaudeBot gates risky actions:

- **`ask`** (default): asks before destructive shell commands, sending or posting through connectors, deploying, editing sensitive dotfiles, and anything involving money.
- **`auto`**: only asks for money, `sudo`, force-pushes and mass deletion.
- **`strict`**: asks for nearly everything.

On top of that, bots are told to call `request_approval` before any outward-facing action, and unanswered approvals are denied after `APPROVAL_TIMEOUT_MIN`. Only the paired Telegram account can talk to the bot. In a group, messages from other members are ignored.

## 1Password (optional)

Bots can sign in to sites themselves with logins from one dedicated 1Password vault. The `fill_login` tool reads an item using a read-only service account and types it straight into the open tab over a local CDP port (`BROWSER_CDP_PORT`, default 9223). Secrets never go to the model:

- tool results only name the item and say which fields were filled
- password inputs show as `********` in browser snapshots (ClaudeBot patches Playwright at startup)
- a login is typed only into a tab and frame on the same site as one of the item's URLs
- the `op` CLI and the Keychain token are blocked from bots' Bash

Setup:

1. Install the CLI: `brew install --cask 1password-cli`.
2. In 1Password, create a vault named `ClaudeBot` (or set `OP_VAULT`). Copy in only the logins bots should use. Each one needs its website URL, and it can include a one-time password.
3. Create a service account with **read** access to that vault only: 1Password.com → Developer → Directory → Service Accounts.
4. Store its token in the Keychain. The command prompts for the token, so it stays out of your shell history:
   `security add-generic-password -s claudebot-1password -a service-account -w`
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

Everything ClaudeBot stores (bots, memories, workspaces, schedules, the browser profile) lives in `data/`, which is git-ignored. Back it up if you care about your bots' memories.

## Using your Claude subscription

ClaudeBot runs the official, unmodified Claude Code through the Agent SDK, signed in with your own account. It never reads or stores your Claude credentials. Anthropic's [terms for Claude Code](https://code.claude.com/docs/en/legal-and-compliance) allow subscription sign-in for ordinary, individual use. So run ClaudeBot for yourself on your own machine with your own account. Don't share your bot with other people or offer it as a service. Always-on routines use your plan's limits like any other Claude Code use; the `meter` agent helps keep an eye on that. If you'd rather pay per use, set `ANTHROPIC_API_KEY` in `.env` and the SDK uses that instead.

## Commands

`npm start` (foreground) · `npm run service:install` · `npm run service:restart` · `npm run service:uninstall` · `npm run logs` · `npm run typecheck`

## Layout

```
agents/           ready-made teammates (templates) you can /enable
src/index.ts      boot: default bot, browser server, Telegram, schedules, usage monitor
src/agent.ts      runs a bot (Agent SDK query) and Claude Code sessions
src/tools.ts      bot tools: memory, approvals, files, handoffs, skills, schedules, claude_code, usage, logins, images
src/templates.ts  installs agents/ templates
src/policy.ts     what needs approval
src/telegram.ts   the remote control (DMs and the Topics group)
src/scheduler.ts  cron jobs
src/usage.ts      Claude plan usage monitor
src/vault.ts      1Password sign-ins
data/             your bots, memories, workspaces, schedules, browser profile (git-ignored)
```

## License

MIT. Not affiliated with Anthropic, xAI or Telegram.
