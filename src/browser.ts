import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { DATA, HOME, ROOT, config, log, paths } from './config.ts';

// One long-lived Playwright MCP server drives a single persistent Chrome profile that every
// bot shares — the "shared computer". Sign in once (on the laptop) and all bots stay signed in.

let child: ChildProcess | null = null;
let stopping = false;

export function browserMcp(): McpServerConfig {
  return { type: 'http', url: `http://localhost:${config.browserPort}/mcp` };
}

// If the server was ever unreachable, Claude Code caches it as "needs auth" and hides its tools.
function clearNeedsAuthCache() {
  const file = path.join(HOME, '.claude', 'mcp-needs-auth-cache.json');
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cache.browser) {
      delete cache.browser;
      fs.writeFileSync(file, JSON.stringify(cache));
    }
  } catch {}
}

// Playwright's page snapshots include every input's value, so a password typed by fill_login
// would come back to the model in the next snapshot. Mask password inputs in its injected
// script. Idempotent; re-applied on every start because npm installs overwrite it.
const MASKS: [string, string][] = [
  ['result.children = [element.value];', 'result.children = [element.type === "password" && element.value ? "********" : element.value];'],
  ['return compositeString(element.value, element, options.collectElements);', 'return compositeString(element.type === "password" && element.value ? "********" : element.value, element, options.collectElements);'],
];

export let snapshotsMasked = false;

function maskPasswordsInSnapshots() {
  const file = path.join(ROOT, 'node_modules', 'playwright-core', 'lib', 'coreBundle.js');
  try {
    let src = fs.readFileSync(file, 'utf8');
    const before = src;
    for (const [from, to] of MASKS) src = src.replaceAll(from, to);
    if (src !== before) fs.writeFileSync(file, src);
    snapshotsMasked = MASKS.every(([, to]) => src.includes(to));
    if (!snapshotsMasked) log('[browser] WARNING: could not mask password values in snapshots (Playwright changed); fill_login is unsafe until fixed');
  } catch (e) {
    log('[browser] WARNING: password masking failed:', e);
  }
}

export function startBrowserServer() {
  clearNeedsAuthCache();
  maskPasswordsInSnapshots();
  fs.mkdirSync(paths.browserProfile, { recursive: true });
  fs.mkdirSync(paths.browserOutput, { recursive: true });
  // Local-only CDP port so the vault's fill_login can type secrets into the page without the
  // values passing through Playwright MCP tool results.
  const mcpConfig = path.join(DATA, 'browser', 'mcp-config.json');
  fs.writeFileSync(mcpConfig, JSON.stringify({
    browser: { launchOptions: { args: [`--remote-debugging-port=${config.browserCdpPort}`, '--remote-debugging-address=127.0.0.1'] } },
  }));
  const args = [
    path.join(ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js'),
    '--port', String(config.browserPort),
    '--host', 'localhost',
    '--browser', 'chrome',
    '--user-data-dir', paths.browserProfile,
    '--output-dir', paths.browserOutput,
    '--shared-browser-context',
    '--viewport-size', '1280,900',
    '--config', mcpConfig,
  ];
  if (config.browserHeadless) args.push('--headless');
  child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  process.once('exit', () => child?.kill());
  child.stderr?.on('data', (d) => {
    const s = String(d).trim();
    if (s && !/listening|Listening/.test(s)) log('[browser]', s.slice(0, 300));
  });
  child.on('exit', (code) => {
    child = null;
    if (stopping) return;
    log(`[browser] exited (${code}); restarting in 3s`);
    setTimeout(startBrowserServer, 3000);
  });
  log(`[browser] Playwright MCP on :${config.browserPort} (profile ${paths.browserProfile})`);
}

export function stopBrowserServer() {
  stopping = true;
  child?.kill();
}
