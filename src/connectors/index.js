#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { catalog } from './types.js';
import {
  list, get, add, setEnabled, remove, anyEnabled, enabledConnectors, STORE_PATH,
} from './registry.js';
import { runSink, describeSink } from './sink.js';

// Public API (consumed by the web interface in task #3)
export { catalog, list, get, add, setEnabled, remove, anyEnabled, enabledConnectors, runSink, describeSink };

/** Sync one connector by id, or all enabled ones. */
export async function sync({ id = null, plan = false, dryRunSink = false } = {}) {
  const targets = id ? [get(id)].filter(Boolean) : enabledConnectors();
  const results = [];
  for (const c of targets) {
    const res = await runSink(c, { plan, dryRunSink });
    results.push({ id: c.id, ...res });
  }
  return results;
}

// ───────────────────────── CLI ─────────────────────────

function parseConfig(pairs) {
  const cfg = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i > 0) cfg[p.slice(0, i)] = p.slice(i + 1);
  }
  return cfg;
}

function fmtConnector(c) {
  const flag = c.enabled ? '●' : '○';
  return `${flag} ${c.id}\n    type=${c.type} producer=${c.producer.kind}:${c.producer.id} status=${c.status}` +
    `${c.lastSync ? ` lastSync=${c.lastSync}` : ''}${c.lastError ? `\n    error: ${c.lastError}` : ''}`;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case 'catalog':
      for (const t of catalog()) {
        console.log(`• ${t.type} — ${t.label}\n    ${t.description}\n    default config: ${JSON.stringify(t.defaultConfig)}`);
      }
      break;

    case 'list': {
      const cs = list();
      console.log(`Connectors (${cs.length}) — store: ${STORE_PATH}`);
      if (!cs.length) console.log('  (none) — add one with: connectors add --type <type> --producer-kind user --producer-id <you>');
      cs.forEach((c) => console.log(fmtConnector(c)));
      if (!anyEnabled()) console.log('\n⚠ No connector enabled. Enable one before running the pipeline:\n  connectors enable <id>');
      break;
    }

    case 'add': {
      const flags = {};
      const config = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--type') flags.type = rest[++i];
        else if (rest[i] === '--producer-kind') flags.kind = rest[++i];
        else if (rest[i] === '--producer-id') flags.id = rest[++i];
        else if (rest[i] === '--config') config.push(rest[++i]);
      }
      const res = add({ type: flags.type, producer: { kind: flags.kind, id: flags.id }, config: parseConfig(config) });
      if (!res.ok) { console.error('✗ ' + res.errors.join('; ')); process.exit(1); }
      console.log(`✓ added ${res.connector.id} (disabled). Enable with: connectors enable ${res.connector.id}`);
      break;
    }

    case 'enable':
    case 'disable': {
      const res = setEnabled(rest[0], cmd === 'enable');
      if (!res.ok) { console.error('✗ ' + res.errors.join('; ')); process.exit(1); }
      console.log(`✓ ${rest[0]} ${cmd}d`);
      break;
    }

    case 'remove': {
      const res = remove(rest[0]);
      if (!res.ok) { console.error('✗ ' + res.errors.join('; ')); process.exit(1); }
      console.log(`✓ removed ${rest[0]}`);
      break;
    }

    case 'sync': {
      const id = rest.find((r) => !r.startsWith('--')) || null;
      const plan = rest.includes('--plan');
      const dryRunSink = rest.includes('--dry-run-sink');
      if (!id && !anyEnabled()) { console.error('✗ no enabled connectors. Enable one first.'); process.exit(1); }
      const results = await sync({ id, plan, dryRunSink });
      for (const r of results) {
        if (r.plan) { console.log(`▸ ${r.id}:`); r.plan.forEach((c) => console.log(`    ${c}`)); }
        else console.log(`${r.ok ? '✓' : '✗'} ${r.id}${r.error ? `: ${r.error}` : ''}`);
      }
      break;
    }

    default:
      console.log('Usage: connectors <catalog|list|add|enable|disable|remove|sync>');
      console.log('  add --type <t> --producer-kind <user|team|tenant> --producer-id <id> [--config k=v ...]');
      console.log('  sync [<id>] [--plan] [--dry-run-sink]');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
