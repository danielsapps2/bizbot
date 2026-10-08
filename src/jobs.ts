import { spawn } from 'node:child_process';
import { config, log } from './config.ts';

// Optional nightly shell job (for example a backup). It runs inside BizBot's own process, which already has
// the macOS file access it needs, and costs no Claude usage. Set NIGHTLY_COMMAND (and NIGHTLY_AT as HH:MM,
// default 02:15) in .env; leave NIGHTLY_COMMAND empty to turn it off.

export function startNightlyJob(onFailure: (msg: string) => void): void {
  const command = config.nightlyCommand;
  if (!command) return;
  const [hh, mm] = config.nightlyAt.split(':').map((n) => Number(n));
  let lastRunDay = '';
  const tick = () => {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: config.timezone }));
    const day = now.toDateString();
    if (day === lastRunDay || now.getHours() !== hh || now.getMinutes() < mm) return;
    lastRunDay = day;
    log(`[nightly] running: ${command}`);
    const p = spawn('/bin/bash', ['-c', command], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      log(`[nightly] exit ${code}`);
      if (code !== 0) onFailure(`⚠️ Nightly job failed (exit ${code}): ${err.trim().slice(-300)}`);
    });
  };
  setInterval(tick, 60_000);
  log(`[nightly] scheduled daily at ${config.nightlyAt} ${config.timezone}`);
}
