import path from 'node:path';
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { HOME } from './config.ts';
import type { ApprovalMode } from './store.ts';
import { ui, type Question } from './ui.ts';

/** Tools that never need approval (read-only or our own bookkeeping tools). */
export const SAFE_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'ToolSearch', 'Skill',
  'Task', 'Agent', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'NotebookRead',
  'mcp__bot__remember', 'mcp__bot__recall', 'mcp__bot__notify', 'mcp__bot__send_file',
  'mcp__bot__request_approval', 'mcp__bot__list_schedules', 'mcp__bot__list_bots',
];

// Never without a human, in any mode.
const HARD_BASH = /\bsudo\b|\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME)(\s|$)|\bmkfs\b|\bdd\s+if=|git\s+push\s+.*--force|\bshutdown\b|\breboot\b|security\s+(delete|dump-keychain|find-(generic|internet)-password\s+.*-[wg]\b)|bizbot-1password|OP_SERVICE_ACCOUNT_TOKEN|(^|[;&|(\s])op\s+(item|read|inject|run|document|vault|signin|account|whoami|user|group|service-account|connect)\b/;
const HARD_MCP = /(purchase|buy|pay|transfer|checkout|delete_project|delete_branch|delete_postgres|delete_storage|revoke|rotate)/i;

// Outward-facing or destructive: asked in 'ask' mode.
const RISKY_BASH = /\b(rm|rmdir|kill|killall|pkill|launchctl|diskutil|chmod|chown|crontab|osascript|trash)\b|git\s+(push|reset\s+--hard|clean|branch\s+-D|rebase)|npm\s+publish|\bvercel\b.*(--prod|\bdeploy\b|\brm\b|\bremove\b)|gh\s+(pr\s+(merge|create|close)|release|repo\s+(delete|create)|issue\s+(create|close))|curl\b.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|\s-d\s|-F\s)|brew\s+(uninstall|remove)|>\s*~\/\.|\bmv\s+\S+\s+\/(?!tmp)/;
const RISKY_MCP = /(send|reply|forward|delete|trash|remove|create|update|publish|post|deploy|share|merge|apply_migration|execute_sql|run_sql|pause|restore|spam|respond_to_event|upload)/i;
const READONLY_BASH = /^\s*(ls|pwd|cat|head|tail|wc|grep|rg|find|which|echo|date|cal|whoami|uname|df|du|ps|top -l|env|printenv|file|stat|git\s+(status|log|diff|show|branch|remote)|node\s+-v|npm\s+(ls|view)|sw_vers|open\s+-R)\b/;

function bashRisk(cmd: string, mode: ApprovalMode): string | null {
  if (HARD_BASH.test(cmd)) return 'potentially destructive command';
  if (mode === 'auto') return null;
  if (RISKY_BASH.test(cmd)) return 'destructive or outward-facing command';
  if (mode === 'strict' && !READONLY_BASH.test(cmd)) return 'command (strict mode)';
  return null;
}

function writeRisk(file: string, ws: string, mode: ApprovalMode): string | null {
  const p = path.resolve(file);
  if (mode === 'auto') return null;
  if (!p.startsWith(HOME + path.sep) && !p.startsWith('/tmp') && !p.startsWith('/private/tmp')) return 'writes outside your home folder';
  if (/\/\.(ssh|aws|gnupg|zshrc|bashrc|zprofile|profile|gitconfig)/.test(p) || p.includes(`${HOME}/.claude/settings`)) return 'edits a sensitive config file';
  if (mode === 'strict' && !p.startsWith(ws)) return 'writes outside the bot workspace (strict mode)';
  return null;
}

/** Returns a reason string if the call needs a human, else null. */
export function needsApproval(toolName: string, input: Record<string, any>, mode: ApprovalMode, ws: string): string | null {
  if (SAFE_TOOLS.includes(toolName)) return null;
  if (toolName === 'Bash') return bashRisk(String(input.command ?? ''), mode);
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(toolName)) return writeRisk(String(input.file_path ?? input.notebook_path ?? ''), ws, mode);
  if (toolName.startsWith('mcp__')) {
    const action = toolName.split('__').slice(2).join('__');
    if (toolName.startsWith('mcp__bot__') || toolName.startsWith('mcp__fal__')) return null;
    if (HARD_MCP.test(action)) return 'money or irreversible deletion';
    if (mode === 'auto') return null;
    if (toolName.startsWith('mcp__browser__')) {
      return mode === 'strict' && /(click|type|fill|select|press|drag|upload|evaluate)/.test(action) ? 'browser interaction (strict mode)' : null;
    }
    if (RISKY_MCP.test(action)) return 'changes data in a connected app';
    return null;
  }
  return mode === 'strict' ? 'tool use (strict mode)' : null;
}

export function summarizeInput(toolName: string, input: Record<string, any>): string {
  if (toolName === 'Bash') return String(input.command);
  if (input.file_path) return `${input.file_path}${input.content ? `\n\n${String(input.content).slice(0, 600)}` : ''}${input.new_string ? `\n\n→ ${String(input.new_string).slice(0, 600)}` : ''}`;
  return JSON.stringify(input, null, 1).slice(0, 1200);
}

export function prettyToolName(toolName: string) {
  return toolName.replace(/^mcp__/, '').replace(/__/g, ' › ').replace(/^claude_ai_/, '');
}

/** Builds the SDK permission callback: approvals + AskUserQuestion over the UI. */
export function makeCanUseTool(opts: { who: string; mode: () => ApprovalMode; workspace: string; to?: string }): CanUseTool {
  const alwaysAllowed = new Set<string>();
  return async (toolName, input, { signal }) => {
    if (toolName === 'AskUserQuestion') {
      const questions = (input.questions ?? []) as Question[];
      const answers = await ui().ask({ who: opts.who, questions, signal, to: opts.to });
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }
    const reason = alwaysAllowed.has(toolName) ? null : needsApproval(toolName, input, opts.mode(), opts.workspace);
    if (!reason) return { behavior: 'allow', updatedInput: input };
    const decision = await ui().approve({
      who: opts.who,
      title: `${prettyToolName(toolName)} — ${reason}`,
      detail: summarizeInput(toolName, input),
      signal,
      to: opts.to,
    });
    if (decision === 'always') alwaysAllowed.add(toolName);
    if (decision === 'deny') {
      return { behavior: 'deny', message: 'The user declined this action (or did not respond in time). Do not retry it; continue without it or report back.' };
    }
    return { behavior: 'allow', updatedInput: input };
  };
}
