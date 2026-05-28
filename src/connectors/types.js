import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// A connector is a PRODUCER's source (see docs/skill-flywheel-v2.md §9).
// Enabling a connector = enabling a sink that feeds the pipeline.
// producer: { kind: 'user'|'team'|'tenant', id } — mirrors Nario's bundle `owner`.

export const PRODUCER_KINDS = ['user', 'team', 'tenant'];

export const CONNECTOR_TYPES = {
  'local-claude-sessions': {
    label: 'Local Claude Sessions',
    description: 'Sink Claude Code session transcripts from this machine (→ sessions-analyzed).',
    sinkKind: 'sessions',
    // claude-sink `sessions [dir]` expects the .claude dir (it finds projects/ itself).
    defaultConfig: () => ({ sessionsPath: path.join(os.homedir(), '.claude') }),
    validate(cfg) {
      const errors = [];
      if (!cfg.sessionsPath) errors.push('sessionsPath required');
      else if (!fs.existsSync(cfg.sessionsPath)) errors.push(`sessionsPath not found: ${cfg.sessionsPath}`);
      return errors;
    },
    source: (cfg) => cfg.sessionsPath,
  },

  'github-repo': {
    label: 'GitHub Repository',
    description: 'Sink a GitHub repo so the agent can ground skills in real code (→ code-analyzed).',
    sinkKind: 'code',
    defaultConfig: () => ({ repo: '', branch: 'main', tokenEnv: 'GITHUB_TOKEN', cloneDir: '' }),
    validate(cfg) {
      const errors = [];
      if (!/^[^/\s]+\/[^/\s]+$/.test(cfg.repo || '')) errors.push('repo must be "owner/name"');
      return errors;
    },
    source: (cfg) => cfg.repo,
  },

  'skills-folder': {
    label: 'Skills Folder',
    description: 'Sink a local skills directory for dedupe + relationship mining (→ skills-analyzed).',
    sinkKind: 'skills',
    defaultConfig: () => ({ path: '' }),
    validate(cfg) {
      const errors = [];
      if (!cfg.path) errors.push('path required');
      else if (!fs.existsSync(cfg.path)) errors.push(`path not found: ${cfg.path}`);
      return errors;
    },
    source: (cfg) => cfg.path,
  },
};

export function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(CONNECTOR_TYPES, type);
}

/** Validate a producer ref. Returns string[] of errors. */
export function validateProducer(p) {
  const errors = [];
  if (!p || typeof p !== 'object') return ['producer required'];
  if (!PRODUCER_KINDS.includes(p.kind)) errors.push(`producer.kind must be ${PRODUCER_KINDS.join('|')}`);
  if (!p.id || typeof p.id !== 'string') errors.push('producer.id required');
  return errors;
}

/** Full validation for a new/updated connector. Returns string[] of errors. */
export function validateConnector({ type, producer, config }) {
  const errors = [];
  if (!isKnownType(type)) {
    errors.push(`unknown connector type: ${type} (known: ${Object.keys(CONNECTOR_TYPES).join(', ')})`);
    return errors;
  }
  errors.push(...validateProducer(producer));
  errors.push(...CONNECTOR_TYPES[type].validate(config || {}));
  return errors;
}

/** Public, UI-friendly catalog of connector types. */
export function catalog() {
  return Object.entries(CONNECTOR_TYPES).map(([type, def]) => ({
    type,
    label: def.label,
    description: def.description,
    sinkKind: def.sinkKind,
    defaultConfig: def.defaultConfig(),
  }));
}
