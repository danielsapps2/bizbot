# Ready-made agents

Each folder here is a teammate template. In Telegram, `/agents` lists them and `/enable <id>` switches one on. Enabling one:

- creates the bot, or updates a bot with the same name, and opens its thread in your team group
- copies its files (such as a `CLAUDE.md` playbook) into the bot's workspace
- adds its routines to `/schedules`

Running `/enable` again is safe: files you've edited are kept and routines aren't duplicated.

| Agent | Needs | Routines |
|---|---|---|
| `chief-of-staff` | nothing. It upgrades your default **Claude** bot | 8am standup, 8pm end of day, Monday 9:30 weekly review |
| `meter` | nothing | none; it watches usage in code every 10 min (no tokens) |
| `foreman` | works best with `chief-of-staff` (it reads the morning plan) | a pulse every 30 min, 8:30–19:30. Quiet, and skipped above 90% usage |
| `liaison` | `dir=` a project folder; `name=` to run several | none; it reports in the standup |
| `researcher` | nothing. Pairs well with `chief-of-staff` | none; other bots call it for sourced research memos |
| `devils-advocate` | works best with `researcher` | none; other bots call it to argue the opposite of a big decision |

Shared team docs (`GOALS.md`, `POLICY.md`, `standups/`) live in `data/ops/`. They're created the first time you enable `chief-of-staff`.

## Make your own

Create `agents/<id>/agent.json`:

```json
{
  "name": "Scout",
  "emoji": "🔭",
  "summary": "One line shown in /agents.",
  "job": "Research analyst: …",
  "description": "Extra standing instructions. Read your CLAUDE.md for how you work.",
  "model": "sonnet",
  "approvalMode": "ask",
  "params": [{ "key": "dir", "kind": "dir", "required": true, "description": "the project folder" }],
  "files": { "CLAUDE.md": "CLAUDE.md" },
  "opsFiles": { "GOALS.md": "GOALS.md" },
  "schedules": [
    { "name": "morning-scan", "when": "0 7 * * 1-5", "prompt": "…", "quiet": true, "maxUsage": 90 }
  ],
  "pairsWith": ["chief-of-staff"]
}
```

- **`files`** are copied into the bot's workspace. **`opsFiles`** go into the shared `data/ops/` folder. Either is skipped if the file already exists.
- A **`skills/<name>/SKILL.md`** folder next to `agent.json` is installed as Claude Code skills for the bot.
- **`schedules`** use 5-field cron or an ISO datetime and run in the user's timezone. With **`quiet`**, a run that replies `NO_UPDATE` sends nothing. **`maxUsage`** skips the run while the 5-hour or weekly limit is at or above that percentage.
- Text and copied files can use placeholders:
  - `{{WORKSPACE}}`: the bot's folder
  - `{{OPS_DIR}}`: the shared ops folder
  - `{{DATA}}`, `{{HOME}}`, `{{TZ}}` and `{{NAME}}`
  - each param in upper case (`{{DIR}}`); for `dir` params, also `{{DIR_SESSIONS}}` (where Claude Code keeps that project's transcripts)

Keep personal details (names, paths, account ids) out of templates. Put them in the bot's memory, or in `GOALS.md` after enabling.
