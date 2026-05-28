#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Promote = install a generated Claude Code skill into a skills DIRECTORY.
// NOT Nario. Default target is a safe local dir; point SKILLS_TARGET_DIR at
// ~/.claude/skills (or a skills repo) to make skills live.

const OUTPUT_DIR = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.resolve(process.cwd(), 'output');
const SKILLS_ROOT = path.join(OUTPUT_DIR, 'research-skills');
const DEFAULT_TARGET = process.env.SKILLS_TARGET_DIR
  ? path.resolve(process.env.SKILLS_TARGET_DIR)
  : path.join(OUTPUT_DIR, 'promoted-skills');

/**
 * Install one skill. With { install:false } (default) it only reports the plan.
 * @returns {{ok:boolean, plan?:object, installed?:string, error?:string}}
 */
export function promoteSkill({ sessionId, skillId, install = false, target = DEFAULT_TARGET, overwrite = false }) {
  const src = path.join(SKILLS_ROOT, sessionId, skillId);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) return { ok: false, error: `skill not found: ${src}` };
  const dest = path.join(target, skillId);
  const exists = fs.existsSync(dest);

  if (!install) return { ok: true, plan: { from: src, to: dest, exists, willOverwrite: exists && overwrite } };
  if (exists && !overwrite) return { ok: false, error: `already installed (use overwrite): ${dest}` };

  fs.mkdirSync(target, { recursive: true });
  if (exists) fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  return { ok: true, installed: dest };
}

/** Promote all skills in a session (optionally only ones an eval marked promote). */
export function promoteSession({ sessionId, install = false, target = DEFAULT_TARGET, only = null }) {
  const mp = path.join(SKILLS_ROOT, sessionId, 'manifest.json');
  if (!fs.existsSync(mp)) return { ok: false, error: 'no manifest' };
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const results = (m.skills || [])
    .filter((s) => !only || only.includes(s.skill_id))
    .map((s) => ({ skillId: s.skill_id, ...promoteSkill({ sessionId, skillId: s.skill_id, install, target }) }));
  return { ok: true, target, results };
}

// ───────── CLI ─────────
function main() {
  const argv = process.argv.slice(2);
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const sessionId = get('--session');
  const skillId = get('--skill');
  const target = get('--target') || DEFAULT_TARGET;
  const install = argv.includes('--install');
  if (!sessionId) { console.log('Usage: promote --session <id> [--skill <id>] [--install] [--target <dir>]'); return; }

  const res = skillId
    ? { results: [{ skillId, ...promoteSkill({ sessionId, skillId, install, target }) }], target }
    : promoteSession({ sessionId, install, target });

  if (res.error) { console.error('✗ ' + res.error); process.exit(1); }
  console.log(`[promote] target: ${res.target}${install ? '' : '  (dry — pass --install to copy)'}`);
  for (const r of res.results) {
    if (r.error) console.log(`✗ ${r.skillId}: ${r.error}`);
    else if (r.installed) console.log(`✓ ${r.skillId} → ${r.installed}`);
    else console.log(`▸ ${r.skillId}: ${r.plan.from}\n    → ${r.plan.to}${r.plan.exists ? ' (exists)' : ''}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
