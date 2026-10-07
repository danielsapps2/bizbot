// Markdown → Telegram HTML, plus chunking under Telegram's 4096-char limit.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function mdToHtml(md: string): string {
  const held: string[] = [];
  const hold = (html: string) => `\u0000${held.push(html) - 1}\u0000`;
  let s = md.replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_, code: string) => hold(`<pre>${esc(code.replace(/\n$/, ''))}</pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, c: string) => hold(`<code>${esc(c)}</code>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, u: string) => hold(`<a href="${esc(u)}">${esc(t)}</a>`));
  s = esc(s);
  s = s.replace(/^\s*#{1,6}\s+(.+)$/gm, '<b>$1</b>');
  s = s.replace(/^(\s*)[-*+]\s+/gm, '$1• ');
  s = s.replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*\|?\s*$/gm, '');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => held[Number(i)]);
}

/** Splits Markdown into chunks ≤ max chars on line boundaries, keeping code fences balanced. */
export function chunkMarkdown(md: string, max = 3500): string[] {
  const out: string[] = [];
  let cur = '';
  let inFence = false;
  const flush = () => {
    if (!cur.trim()) return;
    out.push(inFence ? cur + '\n```' : cur);
    cur = inFence ? '```\n' : '';
  };
  for (let line of md.split('\n')) {
    while (line.length > max) {
      if (cur) flush();
      cur += line.slice(0, max);
      line = line.slice(max);
      flush();
    }
    if (cur.length + line.length + 1 > max) flush();
    cur += (cur && !cur.endsWith('\n') ? '\n' : '') + line;
    if (/^\s*```/.test(line)) inFence = !inFence;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
