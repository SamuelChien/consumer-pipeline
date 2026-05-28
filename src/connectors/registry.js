import fs from 'node:fs';
import path from 'node:path';

import { CONNECTOR_TYPES, validateConnector } from './types.js';

const STORE = process.env.CONNECTORS_FILE
  || path.join(process.cwd(), 'data', 'connectors.json');

function nowISO() { return new Date().toISOString(); }

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE, 'utf8'));
  } catch {
    return { connectors: [] };
  }
}

function persist(state) {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(state, null, 2));
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function list() {
  return load().connectors;
}

export function get(id) {
  return load().connectors.find((c) => c.id === id) || null;
}

/** Is at least one connector enabled? Drives the web UI "enable a sink" prompt. */
export function anyEnabled() {
  return load().connectors.some((c) => c.enabled);
}

export function enabledConnectors() {
  return load().connectors.filter((c) => c.enabled);
}

/** Add a connector. Returns { ok, connector?, errors? }. Starts disabled. */
export function add({ type, producer, config }) {
  const merged = { ...CONNECTOR_TYPES[type]?.defaultConfig?.(), ...(config || {}) };
  const errors = validateConnector({ type, producer, config: merged });
  if (errors.length) return { ok: false, errors };

  const state = load();
  const id = `${type}--${slug(producer.kind)}-${slug(producer.id)}`;
  if (state.connectors.some((c) => c.id === id)) {
    return { ok: false, errors: [`connector already exists: ${id}`] };
  }
  const connector = {
    id,
    type,
    producer,
    config: merged,
    enabled: false,
    status: 'idle',
    lastSync: null,
    lastError: null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };
  state.connectors.push(connector);
  persist(state);
  return { ok: true, connector };
}

export function update(id, patch) {
  const state = load();
  const c = state.connectors.find((x) => x.id === id);
  if (!c) return { ok: false, errors: [`not found: ${id}`] };
  if (patch.config) patch.config = { ...c.config, ...patch.config };
  Object.assign(c, patch, { updatedAt: nowISO() });
  // re-validate if type-affecting fields changed
  const errors = validateConnector({ type: c.type, producer: c.producer, config: c.config });
  if (errors.length) return { ok: false, errors };
  persist(state);
  return { ok: true, connector: c };
}

export function setEnabled(id, enabled) {
  return update(id, { enabled: !!enabled });
}

export function remove(id) {
  const state = load();
  const before = state.connectors.length;
  state.connectors = state.connectors.filter((c) => c.id !== id);
  if (state.connectors.length === before) return { ok: false, errors: [`not found: ${id}`] };
  persist(state);
  return { ok: true };
}

/** Record the outcome of a sink run. */
export function recordSync(id, { status, error = null }) {
  return update(id, { status, lastError: error, lastSync: status === 'ok' ? nowISO() : undefined });
}

export const STORE_PATH = STORE;
