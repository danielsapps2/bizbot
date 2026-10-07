import { execFile, execFileSync } from 'node:child_process';
import { chromium, type Frame, type Locator } from 'playwright-core';
import { snapshotsMasked } from './browser.ts';
import { config, log } from './config.ts';

// 1Password sign-ins for the shared browser. Secrets never reach the model: a read-only
// service account (scoped to one vault) looks up the item, we check the item belongs to the
// site that's open, and type it straight into the page over CDP. Tools only ever return
// item titles, hostnames and which fields were filled.

export const KEYCHAIN_SERVICE = 'claudebot-1password';

type Login = { id: string; title: string; hosts: string[] };
type Field = 'username' | 'password' | 'otp';

let token: string | null = null;

function opToken(): string {
  if (token) return token;
  try {
    token = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(`1Password isn't connected: no service account token in the macOS Keychain (service "${KEYCHAIN_SERVICE}"). The user has to add it; see README "1Password".`);
  }
  return token;
}

function op(args: string[]): Promise<string> {
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin:/opt/homebrew/bin', HOME: process.env.HOME ?? '', OP_SERVICE_ACCOUNT_TOKEN: opToken() };
  return new Promise((resolve, reject) => {
    execFile('op', args, { env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`op ${args[0]} ${args[1] ?? ''} failed: ${String(stderr).trim().slice(0, 300) || err.message}`));
      else resolve(stdout);
    });
  });
}

const TWO_PART_TLDS = /\.(co|com|org|net|ac|gov)\.[a-z]{2}$/;

/** Registrable domain, e.g. app.example.com -> example.com, idmsa.apple.com -> apple.com. */
function site(host: string): string {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  return parts.slice(TWO_PART_TLDS.test(host) ? -3 : -2).join('.');
}

function hostOf(href: string): string | null {
  try { return new URL(/^[a-z]+:\/\//i.test(href) ? href : `https://${href}`).hostname; } catch { return null; }
}

export async function listLogins(): Promise<Login[]> {
  const items = JSON.parse(await op(['item', 'list', '--vault', config.opVault, '--categories', 'Login', '--format', 'json'])) as any[];
  return items.map((i) => ({
    id: i.id,
    title: i.title,
    hosts: (i.urls ?? []).map((u: any) => hostOf(u.href)).filter(Boolean),
  }));
}

async function findLogin(query: string): Promise<Login> {
  const all = await listLogins();
  const q = query.toLowerCase();
  const hits = all.filter((l) => l.id === query || l.title.toLowerCase() === q);
  const loose = hits.length ? hits : all.filter((l) => l.title.toLowerCase().includes(q) || l.hosts.some((h) => site(h) === site(q)));
  if (loose.length !== 1) {
    throw new Error(loose.length ? `"${query}" matches ${loose.length} logins (${loose.map((l) => l.title).join(', ')}); use the exact title.` : `No login "${query}" in the ${config.opVault} vault. Use list_logins.`);
  }
  return loose[0];
}

async function secretsOf(id: string) {
  const item = JSON.parse(await op(['item', 'get', id, '--vault', config.opVault, '--reveal', '--format', 'json']));
  const fields = (item.fields ?? []) as any[];
  return {
    username: fields.find((f) => f.purpose === 'USERNAME')?.value as string | undefined,
    password: fields.find((f) => f.purpose === 'PASSWORD')?.value as string | undefined,
    otp: fields.find((f) => f.type === 'OTP')?.totp as string | undefined,
  };
}

const SELECTORS: Record<Field, string> = {
  username: 'input[autocomplete~="username"], input[autocomplete~="email"], input[type="email"], input[name*="user" i], input[name*="email" i], input[name="login"], input[id*="user" i], input[id*="email" i], input[id="account_name_text_field"]',
  password: 'input[type="password"]',
  otp: 'input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="totp" i], input[name*="code" i], input[id*="otp" i], input[id*="code" i], input[inputmode="numeric"]',
};

async function visible(frames: Frame[], css: string): Promise<Locator[]> {
  const out: Locator[] = [];
  for (const f of frames) {
    if (!f.url().startsWith('http')) continue;
    const loc = f.locator(css).filter({ visible: true });
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) out.push(loc.nth(i));
  }
  return out;
}

/**
 * Fill a 1Password login into the open tab for that site. Every frame we type into must belong to
 * the same site as one of the item's URLs, so a page can't trick a bot into sending a password
 * to the wrong place.
 */
export async function fillLogin(query: string, fields: Field[], submit: boolean): Promise<string> {
  if (!snapshotsMasked) throw new Error('fill_login is disabled: password fields could not be masked in browser snapshots (see the ClaudeBot log). Ask the user to sign in instead.');
  const login = await findLogin(query);
  const sites = new Set(login.hosts.map(site));
  if (!sites.size) throw new Error(`Login "${login.title}" has no website URL in 1Password, so it can't be matched to a page. Add the site URL to the item.`);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.browserCdpPort}`);
  const secrets: string[] = [];
  try {
    const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => {
      const h = hostOf(p.url());
      return h && sites.has(site(h));
    });
    if (!pages.length) throw new Error(`No open tab on ${[...sites].join(' / ')}. Navigate to the sign-in page first.`);
    const page = pages[pages.length - 1];
    const frames = page.frames().filter((f) => {
      const h = hostOf(f.url());
      return h && sites.has(site(h));
    });

    const s = await secretsOf(login.id);
    secrets.push(...[s.username, s.password, s.otp].filter((v): v is string => !!v));
    const filled: string[] = [];
    let last: Locator | null = null;
    for (const field of fields) {
      const value = s[field];
      if (!value) { filled.push(`${field}: not in item`); continue; }
      const boxes = await visible(frames, SELECTORS[field]);
      const target = boxes[0];
      if (!target) { filled.push(`${field}: no field on page`); continue; }
      if (field === 'otp' && boxes.length > 1 && boxes.length >= value.length) {
        // Split one-character boxes: type into the first and let the page advance focus.
        await boxes[0].click();
        await page.keyboard.type(value, { delay: 40 });
      } else {
        await target.fill(value);
      }
      last = target;
      filled.push(`${field}: filled`);
    }
    if (submit && last) await last.press('Enter');
    const where = new URL(page.url());
    log(`[vault] ${login.title} -> ${where.host}${where.pathname} (${filled.join(', ')}${submit ? ', submitted' : ''})`);
    return `${login.title} on ${where.host}: ${filled.join(', ')}${submit && last ? '; pressed Enter' : ''}.`;
  } catch (e: any) {
    let msg = String(e?.message ?? e);
    for (const v of secrets) msg = msg.replaceAll(v, '•••');
    throw new Error(msg);
  } finally {
    // Disconnects only; the shared Chrome keeps running for the Playwright MCP server.
    await browser.close().catch(() => {});
  }
}
