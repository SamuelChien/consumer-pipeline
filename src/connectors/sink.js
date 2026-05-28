import path from 'node:path';
import { spawn } from 'node:child_process';

import { CONNECTOR_TYPES } from './types.js';
import { recordSync } from './registry.js';

const DEV_ROOT = process.env.DEV_ROOT || '/Users/samuelchien/dev';
const SINK_BIN = process.env.SINK_BIN || path.join(DEV_ROOT, 'claude-sink/dist/index.js');
const PROJECT_ID = process.env.PROJECT_ID || 'blobfish-ai-429200';
const CLONE_ROOT = process.env.CONNECTOR_CLONE_ROOT || path.join(DEV_ROOT, '.connector-clones');

// claude-sink CLI (verified from claude-sink/src/cli.ts):
//   skills   <dir>  --pubsub <project> [--dry-run] [--limit] [--force]
//   sessions [dir]  --pubsub <project> [--dry-run] [--since] [--project]
//   code     <dir>  --pubsub <project> [--dry-run] [--exclude] [--limit]

/** Build the ordered shell steps that sink a connector. No execution. */
export function planSink(connector, { dryRunSink = false } = {}) {
  const def = CONNECTOR_TYPES[connector.type];
  if (!def) return { steps: [], error: `unknown type ${connector.type}` };
  const cfg = connector.config || {};
  const pubsub = ['--pubsub', PROJECT_ID];
  const sinkDry = dryRunSink ? ['--dry-run'] : [];
  const steps = [];

  if (connector.type === 'local-claude-sessions') {
    steps.push({ cmd: 'node', args: [SINK_BIN, 'sessions', cfg.sessionsPath, ...pubsub, ...sinkDry] });
  } else if (connector.type === 'skills-folder') {
    steps.push({ cmd: 'node', args: [SINK_BIN, 'skills', cfg.path, ...pubsub, ...sinkDry] });
  } else if (connector.type === 'github-repo') {
    const [owner, name] = cfg.repo.split('/');
    const cloneDir = cfg.cloneDir || path.join(CLONE_ROOT, `${owner}-${name}`);
    const token = cfg.tokenEnv && process.env[cfg.tokenEnv];
    const url = token
      ? `https://x-access-token:${token}@github.com/${cfg.repo}.git`
      : `https://github.com/${cfg.repo}.git`;
    steps.push({
      cmd: 'bash', args: ['-c',
        `if [ -d ${JSON.stringify(cloneDir)}/.git ]; then git -C ${JSON.stringify(cloneDir)} pull --ff-only; ` +
        `else git clone --depth 1 -b ${cfg.branch || 'main'} ${JSON.stringify(url)} ${JSON.stringify(cloneDir)}; fi`],
      redact: token ? token : null,
    });
    steps.push({ cmd: 'node', args: [SINK_BIN, 'code', cloneDir, ...pubsub, ...sinkDry] });
  }
  return { steps, sinkKind: def.sinkKind };
}

function renderStep(step) {
  let s = `${step.cmd} ${step.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;
  if (step.redact) s = s.split(step.redact).join('***');
  return s;
}

/** Plan a connector sink as printable command strings (secrets redacted). */
export function describeSink(connector, opts) {
  const { steps, error } = planSink(connector, opts);
  if (error) return { error };
  return { commands: steps.map(renderStep) };
}

function runStep(step) {
  return new Promise((resolve, reject) => {
    const proc = spawn(step.cmd, step.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (code) => (code === 0 ? resolve({ out, err }) : reject(new Error(`${renderStep(step)} exited ${code}: ${(err || out).slice(0, 400)}`))));
    proc.on('error', (e) => reject(new Error(`spawn failed: ${e.message}`)));
  });
}

/**
 * Execute a connector's sink. With { plan:true } returns the commands without running.
 * Records status on the connector (status: 'syncing' -> 'ok'|'error').
 */
export async function runSink(connector, { plan = false, dryRunSink = false } = {}) {
  const planned = planSink(connector, { dryRunSink });
  if (planned.error) return { ok: false, error: planned.error };
  if (plan) return { ok: true, plan: planned.steps.map(renderStep) };

  recordSync(connector.id, { status: 'syncing' });
  try {
    for (const step of planned.steps) await runStep(step);
    recordSync(connector.id, { status: 'ok' });
    return { ok: true };
  } catch (e) {
    recordSync(connector.id, { status: 'error', error: e.message });
    return { ok: false, error: e.message };
  }
}
