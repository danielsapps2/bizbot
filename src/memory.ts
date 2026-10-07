import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.ts';

const botMemoryFile = (slug: string) => path.join(paths.botDir(slug), 'memory.md');
const historyFile = (slug: string) => path.join(paths.botDir(slug), 'history.jsonl');

function read(file: string) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

export function readMemory(scope: 'user' | 'bot', slug?: string) {
  return read(scope === 'user' ? paths.userMemory : botMemoryFile(slug!)).trim();
}

export function remember(scope: 'user' | 'bot', fact: string, slug?: string) {
  const file = scope === 'user' ? paths.userMemory : botMemoryFile(slug!);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(file, `- (${day}) ${fact.replace(/\s+/g, ' ').trim()}\n`);
}

/** Removes memory lines containing `match` (case-insensitive). Returns removed count. */
export function forget(scope: 'user' | 'bot', match: string, slug?: string) {
  const file = scope === 'user' ? paths.userMemory : botMemoryFile(slug!);
  const lines = read(file).split('\n');
  const keep = lines.filter((l) => !l.toLowerCase().includes(match.toLowerCase()));
  fs.writeFileSync(file, keep.join('\n'));
  return lines.length - keep.length;
}

export function logHistory(slug: string, role: string, text: string) {
  fs.mkdirSync(paths.botDir(slug), { recursive: true });
  fs.appendFileSync(historyFile(slug), JSON.stringify({ t: new Date().toISOString(), role, text }) + '\n');
}

/** Keyword search over memories and conversation history of one or all bots. */
export function recall(query: string, slugs: string[], limit = 12) {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const hits: { score: number; t: string; where: string; text: string }[] = [];
  const score = (s: string) => {
    const l = s.toLowerCase();
    return terms.reduce((n, t) => n + (l.includes(t) ? 1 : 0), 0);
  };
  for (const line of readMemory('user').split('\n')) {
    const sc = score(line);
    if (sc) hits.push({ score: sc + 0.5, t: '', where: 'user memory', text: line });
  }
  for (const slug of slugs) {
    for (const line of readMemory('bot', slug).split('\n')) {
      const sc = score(line);
      if (sc) hits.push({ score: sc + 0.5, t: '', where: `${slug} memory`, text: line });
    }
    for (const raw of read(historyFile(slug)).split('\n')) {
      if (!raw) continue;
      const e = JSON.parse(raw) as { t: string; role: string; text: string };
      const sc = score(e.text);
      if (sc) hits.push({ score: sc, t: e.t, where: `${slug} chat (${e.role})`, text: e.text.slice(0, 600) });
    }
  }
  hits.sort((a, b) => b.score - a.score || b.t.localeCompare(a.t));
  return hits.slice(0, limit);
}
