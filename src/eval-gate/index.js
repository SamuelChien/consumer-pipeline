#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { synthesizeTask, writeSuite } from './synthesize-suite.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.resolve(process.cwd(), 'output');
const SKILLS_ROOT = path.join(OUTPUT_DIR, 'research-skills');
const SKILL_BENCH = process.env.SKILL_BENCH_CMD || 'skill-bench';
const EVAL_MODEL = process.env.EVAL_MODEL || 'claude-sonnet-4-6';
const EVAL_PASS = Number(process.env.EVAL_PASS || 0.8);   // candidate must clear this WITH the skill
const EVAL_MARGIN = Number(process.env.EVAL_MARGIN || 0.1); // and beat baseline by this much

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function renderCmd(argv) {
  return argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

function run(argv) {
  return new Promise((resolve, reject) => {
    const proc = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`${argv[0]} exited ${c}: ${(err || out).slice(0, 400)}`))));
    proc.on('error', (e) => reject(new Error(`spawn ${argv[0]} failed: ${e.message} (set SKILL_BENCH_CMD)`)));
  });
}

/** Read an average 0..1 score from a skill-bench output dir. */
function parseScore(dir) {
  for (const f of ['summary.json', 'results.json']) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      const v = d.avg_score ?? d.average ?? d.overall ?? d.score
        ?? (Array.isArray(d.results) ? mean(d.results.map((r) => r.overall_score ?? r.score).filter((x) => typeof x === 'number')) : null)
        ?? (Array.isArray(d.tasks) ? mean(d.tasks.map((r) => r.score ?? r.overall_score).filter((x) => typeof x === 'number')) : null);
      if (typeof v === 'number') return v;
    } catch { /* keep trying */ }
  }
  return null;
}

/**
 * Gate one candidate skill: run the synthesized task WITH the skill mounted vs
 * baseline (no skill). Promote if it clears EVAL_PASS and beats baseline by EVAL_MARGIN.
 */
export async function evalSkill({ sessionId, skillId, brief, addressesGap, dryRun = false }) {
  const skillDir = path.join(SKILLS_ROOT, sessionId, skillId);
  if (!fs.existsSync(path.join(skillDir, 'SKILL.md'))) return { skillId, error: 'skill not found' };

  const work = path.join(OUTPUT_DIR, 'eval', sessionId, skillId);
  const mount = path.join(work, 'skills');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(mount, { recursive: true });
  fs.cpSync(skillDir, path.join(mount, skillId), { recursive: true });

  const task = synthesizeTask(brief, { skill_id: skillId, addresses_gap: addressesGap });
  const tasksDir = writeSuite([task], path.join(work, 'tasks'));

  const outWith = path.join(work, 'with');
  const outBase = path.join(work, 'baseline');
  const cmdWith = [SKILL_BENCH, 'run', tasksDir, '--skills', mount, '--model', EVAL_MODEL, '--output', outWith, '--sampler', 'cli'];
  const cmdBase = [SKILL_BENCH, 'run', tasksDir, '--model', EVAL_MODEL, '--output', outBase, '--sampler', 'cli'];

  if (dryRun) return { skillId, dryRun: true, commands: [renderCmd(cmdWith), renderCmd(cmdBase)] };

  await run(cmdWith);
  await run(cmdBase);
  const withScore = parseScore(outWith);
  const baseScore = parseScore(outBase);
  const margin = (withScore ?? 0) - (baseScore ?? 0);
  let verdict = 'reject';
  if (withScore != null && withScore >= EVAL_PASS && margin >= EVAL_MARGIN) verdict = 'promote';
  else if (margin > 0) verdict = 'weak';
  return { skillId, withScore, baseScore, margin: Number(margin.toFixed(3)), verdict };
}

/** Eval every skill in a session's manifest. */
export async function evalSession(sessionId, { dryRun = false, only = null } = {}) {
  const mp = path.join(SKILLS_ROOT, sessionId, 'manifest.json');
  if (!fs.existsSync(mp)) return { sessionId, error: 'no manifest' };
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const skills = (m.skills || []).filter((s) => !only || s.skill_id === only);
  const results = [];
  for (const s of skills) {
    results.push(await evalSkill({ sessionId, skillId: s.skill_id, brief: m.brief, addressesGap: s.addresses_gap, dryRun }));
  }
  return { sessionId, results };
}

// ───────── CLI ─────────
async function main() {
  const argv = process.argv.slice(2);
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const sessionId = get('--session');
  const only = get('--skill') || null;
  const dryRun = argv.includes('--dry-run');
  if (!sessionId) { console.log('Usage: eval-gate --session <id> [--skill <id>] [--dry-run]'); return; }

  const res = await evalSession(sessionId, { dryRun, only });
  if (res.error) { console.error('✗ ' + res.error); process.exit(1); }
  console.log(`[eval-gate] ${sessionId} | pass≥${EVAL_PASS} margin≥${EVAL_MARGIN}${dryRun ? ' | DRY-RUN' : ''}`);
  for (const r of res.results) {
    if (r.dryRun) { console.log(`▸ ${r.skillId}`); r.commands.forEach((c) => console.log(`    ${c}`)); }
    else if (r.error) console.log(`✗ ${r.skillId}: ${r.error}`);
    else console.log(`${r.verdict === 'promote' ? '✓' : '·'} ${r.skillId}: with=${r.withScore} base=${r.baseScore} margin=${r.margin} → ${r.verdict}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
