#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { claudeAgent } from '../shared/claude-cli.js';
import {
  loadSessions, extractBrief, isRealSession, skillDirs,
} from './extract-brief.js';
import { buildResearchPrompt } from './prompts.js';
import { extractSkillArray, validateSkill, normalizeSkill } from './schema.js';

const DEV_ROOT = process.env.DEV_ROOT || '/Users/samuelchien/dev';
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(process.cwd(), 'output');

/**
 * Research ONE session into multiple validated skills.
 * @returns {Promise<{sessionId, brief, skills, rejected, meta, dryRun?}>}
 */
export async function researchSession(session, { dryRun = false, dirs = skillDirs() } = {}) {
  const brief = extractBrief(session);
  const prompt = buildResearchPrompt(brief, { skillDirs: dirs });

  // Prefer the most specific repo as cwd; keep the bare DEV_ROOT out of the
  // research surface so the agent stays focused (and cheaper).
  const existing = brief.repos.filter((r) => fs.existsSync(r));
  const specific = existing
    .filter((r) => path.resolve(r) !== path.resolve(DEV_ROOT))
    .sort((a, b) => b.length - a.length);
  const cwd = specific[0] || existing[0] || DEV_ROOT;
  const addDirs = [...new Set([...dirs, ...existing])].filter(
    (d) => path.resolve(d) !== path.resolve(cwd) && path.resolve(d) !== path.resolve(DEV_ROOT),
  );

  if (dryRun) {
    const res = await claudeAgent(prompt, { cwd, addDirs, dryRun: true });
    return { sessionId: brief.sessionId, brief, skills: [], rejected: [], meta: {}, dryRun: true, plan: res };
  }

  const res = await claudeAgent(prompt, { cwd, addDirs });
  const raw = extractSkillArray(res.result);

  const skills = [];
  const rejected = [];
  for (const candidate of raw) {
    const s = normalizeSkill(candidate);
    const v = validateSkill(s);
    if (v.ok) skills.push(s);
    else rejected.push({ skill_id: s.skill_id || '(unknown)', errors: v.errors });
  }
  return { sessionId: brief.sessionId, brief, skills, rejected, meta: res.meta || {} };
}

/** Persist a session's skills to OUTPUT_DIR/research-skills/<sessionId>/ */
export function writeResult(result, outRoot) {
  const base = path.join(outRoot, 'research-skills', result.sessionId);
  fs.mkdirSync(base, { recursive: true });
  for (const skill of result.skills) {
    const dir = path.join(base, skill.skill_id);
    for (const f of skill.files) {
      const fp = path.join(dir, f.relative_path);
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, f.content);
      if (f.executable) fs.chmodSync(fp, 0o755);
    }
  }
  const manifest = {
    sessionId: result.sessionId,
    generatedAt: new Date().toISOString(),
    brief: result.brief,
    meta: result.meta,
    skills: result.skills.map((s) => ({
      skill_id: s.skill_id,
      mutates: s.mutates,
      addresses_gap: s.addresses_gap,
      related_skills: s.related_skills,
      files: s.files.map((f) => f.relative_path),
    })),
    rejected: result.rejected,
  };
  fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return base;
}

function parseArgs(argv) {
  const a = { limit: 1, dryRun: false, all: false, session: null, out: OUTPUT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run') a.dryRun = true;
    else if (t === '--all') a.all = true;
    else if (t === '--session') a.session = argv[++i];
    else if (t === '--limit') a.limit = Number(argv[++i]);
    else if (t === '--out') a.out = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dirs = skillDirs();
  const all = loadSessions();

  let sessions = all.filter(isRealSession);
  if (args.session) sessions = sessions.filter((s) => s.sessionId === args.session);
  if (!args.all && !args.session) sessions = sessions.slice(0, args.limit);

  console.log(`[research-agent] ${sessions.length} session(s) | model=${process.env.RESEARCH_MODEL || 'claude-opus-4-8'} | skillDirs=${dirs.length}${args.dryRun ? ' | DRY-RUN' : ''}`);
  if (!sessions.length) {
    console.log('[research-agent] no matching real sessions. Check DEEP_ANALYSIS_PATH / --session id.');
    return;
  }

  let totalSkills = 0;
  let totalCost = 0;
  for (const session of sessions) {
    const brief = extractBrief(session);
    console.log(`\n── ${brief.sessionId} ──\n   goal: ${(brief.userGoal || '').slice(0, 100)}\n   gaps: ${brief.gaps.length} | struggles: ${brief.struggles.length} | repos: ${brief.repos.join(', ') || '(none)'}`);

    if (args.dryRun) {
      const r = await researchSession(session, { dryRun: true, dirs });
      console.log(`   cwd: ${r.plan.cwd}`);
      console.log(`   cmd: ${r.plan.command}`);
      continue;
    }

    try {
      const result = await researchSession(session, { dirs });
      const dest = writeResult(result, args.out);
      totalSkills += result.skills.length;
      totalCost += result.meta?.total_cost_usd || 0;
      console.log(`   ✓ ${result.skills.length} skill(s)${result.rejected.length ? `, ${result.rejected.length} rejected` : ''} | turns=${result.meta?.num_turns ?? '?'} | $${(result.meta?.total_cost_usd ?? 0).toFixed(3)}`);
      console.log(`   → ${dest}`);
      result.skills.forEach((s) => console.log(`      • ${s.skill_id}${s.mutates ? ' [mutates]' : ''} — ${(s.user_facing_description || '').slice(0, 70)}`));
      result.rejected.forEach((r) => console.log(`      ✗ ${r.skill_id}: ${r.errors.join('; ')}`));
    } catch (err) {
      console.error(`   ✗ failed: ${err.message}`);
    }
  }

  if (!args.dryRun) {
    console.log(`\n[research-agent] done: ${totalSkills} skill(s) from ${sessions.length} session(s) | ~$${totalCost.toFixed(2)}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
