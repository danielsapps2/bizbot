import fs from 'node:fs';
import path from 'node:path';
import { DATA, log } from './config.ts';

// One line per bot / Claude Code run with its token usage, so we can see who spends the plan's
// limits and what model changes save. The SDK's own cost figure guesses at the default model's
// rate for models it doesn't know yet, so we estimate from tokens with our own price table.

const FILE = path.join(DATA, 'usage-log.jsonl');

/** List $ per 1M tokens: input, cache read, cache write, output. Haiku 5.5's >100K-token tier is ignored. */
const PRICES: Record<string, [number, number, number, number]> = {
  'claude-fable-5-1': [10, 1, 12.5, 50],
  'claude-opus-5-5': [4, 0.2, 5, 20],
  'claude-sonnet-5-5': [2, 0.2, 2.5, 10],
  'claude-haiku-5-5': [0.1, 0.01, 0.125, 0.5],
  'claude-haiku-4-5': [1, 0.1, 1.25, 5],
};

function priceFor(model: string) {
  const key = Object.keys(PRICES).find((k) => model.startsWith(k));
  return key ? PRICES[key] : undefined;
}

type ModelTokens = { input: number; cacheRead: number; cacheWrite: number; output: number; estUsd: number | null };
export type RunRecord = { t: string; who: string; origin: string; title: string; effort?: string; secs: number; ok: boolean; models: Record<string, ModelTokens> };

export function recordRun(r: Omit<RunRecord, 't' | 'models'>, modelUsage: Record<string, any> | undefined) {
  const models: Record<string, ModelTokens> = {};
  for (const [model, u] of Object.entries(modelUsage ?? {})) {
    const p = priceFor(u.canonicalModel ?? model);
    const t = { input: u.inputTokens ?? 0, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0, output: u.outputTokens ?? 0 };
    const estUsd = p ? (t.input * p[0] + t.cacheRead * p[1] + t.cacheWrite * p[2] + t.output * p[3]) / 1e6 : null;
    models[u.canonicalModel ?? model] = { ...t, estUsd };
  }
  try {
    fs.appendFileSync(FILE, JSON.stringify({ t: new Date().toISOString(), ...r, models }) + '\n');
  } catch (e) {
    log('[usagelog] write failed:', e);
  }
}

/** Totals per bot and model over the last `days` days, biggest spender first. */
export function usageReport(days: number): string {
  if (!fs.existsSync(FILE)) return 'No runs logged yet.';
  const since = Date.now() - days * 86_400_000;
  const rows = new Map<string, { runs: number; tokens: number; output: number; usd: number; unknown: boolean }>();
  let total = 0;
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let r: RunRecord;
    try { r = JSON.parse(line); } catch { continue; }
    if (Date.parse(r.t) < since) continue;
    for (const [model, u] of Object.entries(r.models)) {
      const key = `${r.who} · ${model}${r.effort ? ` (${r.effort})` : ''}`;
      const row = rows.get(key) ?? { runs: 0, tokens: 0, output: 0, usd: 0, unknown: false };
      row.runs++;
      row.tokens += u.input + u.cacheRead + u.cacheWrite + u.output;
      row.output += u.output;
      if (u.estUsd == null) row.unknown = true;
      else { row.usd += u.estUsd; total += u.estUsd; }
      rows.set(key, row);
    }
  }
  if (!rows.size) return `No runs in the last ${days} day(s).`;
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);
  const lines = [...rows.entries()].sort((a, b) => b[1].usd - a[1].usd).map(([key, r]) =>
    `- ${key}: ${r.runs} runs, ${k(r.tokens)} tokens (${k(r.output)} out), ~$${r.usd.toFixed(2)}${r.unknown ? ' + unpriced model' : ''}${total ? ` (${Math.round((r.usd / total) * 100)}%)` : ''}`);
  return `Last ${days} day(s), API-list-price estimate (relative weight, not your plan's exact %):\n${lines.join('\n')}\nTotal ~$${total.toFixed(2)}`;
}
