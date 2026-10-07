// The bridge between the agent core and whatever surface the user talks through (Telegram today).

export type Decision = 'allow' | 'deny' | 'always';

/** Where a message belongs: a bot slug (its own thread), 'team', or 'code'. */
export type Dest = string;

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export interface StatusHandle {
  step(line: string): void;
  done(summary: string): Promise<void>;
}

export interface UI {
  /** Send a Markdown message to the owner. */
  send(text: string, to?: Dest): Promise<void>;
  /** Send a local file path or URL (images are shown inline). */
  sendFile(pathOrUrl: string, caption?: string, to?: Dest): Promise<void>;
  /** Ask the owner to approve an action. Resolves 'deny' on timeout or abort. */
  approve(req: { who: string; title: string; detail: string; signal?: AbortSignal; to?: Dest }): Promise<Decision>;
  /** Ask the owner multiple-choice questions; returns question -> answer. */
  ask(req: { who: string; questions: Question[]; signal?: AbortSignal; to?: Dest }): Promise<Record<string, string>>;
  /** Approvals and questions still waiting for the owner. */
  pending(): { kind: 'approval' | 'question'; who: string; title: string; since: number }[];
  /** A live-updating "working…" message. */
  status(who: string, title: string, to?: Dest): StatusHandle;
}

let current: UI | null = null;

export function setUI(ui: UI) {
  current = ui;
}

export function ui(): UI {
  if (!current) throw new Error('UI not initialised');
  return current;
}
