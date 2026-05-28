#!/usr/bin/env node
// One command: session -> research (opus 4.8 multi-turn) -> eval (skill-bench) -> promote.
// Eval auto-skips if skill-bench isn't installed. Promote is dry unless --install.
//
//   npm run flywheel -- --limit 2                 research 2 sessions, eval if available, dry promote
//   npm run flywheel -- --session <id> --reuse    reuse existing skills, eval + promote
//   npm run flywheel -- --limit 1 --install       install passers into SKILLS_TARGET_DIR
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadSessions, isRealSession } from './research-agent/extract-brief.js';
import { researchSession, writeResult } from './research-agent/index.js';
import { evalSession } from './eval-gate/index.js';
import { promoteSkill } from './promote/index.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.resolve(process.cwd(), 'output');
const SKILLS_ROOT = path.join(OUTPUT_DIR, 'research-skills');

function skillBenchAvailable() {
  const cmd = process.env.SKILL_BENCH_CMD;
  const probe = cmd ? `command -v ${cmd} || test -x ${cmd}` : 'command -v skill-bench';
  try { return spawnSync('sh', ['-c', probe], { stdio: 'ignore' }).status === 0; } catch { return false; }
}

function parseArgs(argv) {
  const a = { limit: 1, session: null, reuse: false, eval: null, install: false, target: undefined, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--limit') a.limit = Number(argv[++i]);
    else if (t === '--session') a.session = argv[++i];
    else if (t === '--reuse') a.reuse = true;
    else if (t === '--eval') a.eval = true;
    else if (t === '--no-eval') a.eval = false;
    else if (t === '--install') a.install = true;
    else if (t === '--target') a.target = argv[++i];
    else if (t === '--dry-run') a.dryRun = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evalEnabled = args.eval === null ? skillBenchAvailable() : args.eval;
  const all = loadSessions().filter(isRealSession);
  const sessions = args.session ? all.filter((s) => s.sessionId === args.session) : all.slice(0, args.limit);

  console.log(`[flywheel] ${sessions.length} session(s) | research=opus-4.8 | eval=${evalEnabled ? 'on' : 'off'} | promote=${args.install ? 'INSTALL' : 'dry'}${args.dryRun ? ' | DRY-RUN' : ''}`);
  if (!sessions.length) { console.log('  no matching sessions'); return; }

  let totalCost = 0; let totalSkills = 0; let totalPromoted = 0;

  for (const session of sessions) {
    const sid = session.sessionId;
    const manifestPath = path.join(SKILLS_ROOT, sid, 'manifest.json');
    console.log(`\n══ ${sid} ══`);

    // 1. RESEARCH (or reuse)
    let skills;
    if (args.reuse && fs.existsSync(manifestPath)) {
      skills = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).skills || [];
      console.log(`  research: reused ${skills.length} skill(s)`);
    } else if (args.dryRun) {
      const r = await researchSession(session, { dryRun: true });
      console.log(`  research (dry): ${r.plan.command.slice(0, 90)}…`);
      continue;
    } else {
      const r = await researchSession(session);
      writeResult(r, OUTPUT_DIR);
      skills = r.skills;
      totalCost += r.meta?.total_cost_usd || 0;
      console.log(`  research: ${skills.length} skill(s) | ${r.meta?.num_turns ?? '?'} turns | $${(r.meta?.total_cost_usd || 0).toFixed(2)}`);
    }
    totalSkills += skills.length;
    if (!skills.length) { console.log('  (no skills)'); continue; }

    // 2. EVAL (skill-bench candidate WITH vs baseline WITHOUT)
    const verdicts = {};
    if (evalEnabled) {
      const ev = await evalSession(sid, {});
      for (const r of (ev.results || [])) verdicts[r.skillId] = r;
      const passed = Object.values(verdicts).filter((v) => v.verdict === 'promote').length;
      console.log(`  eval: ${passed}/${skills.length} pass`);
      for (const v of Object.values(verdicts)) {
        if (v.error) console.log(`     ✗ ${v.skillId}: ${v.error}`);
        else console.log(`     ${v.verdict === 'promote' ? '✓' : '·'} ${v.skillId}: with=${v.withScore} base=${v.baseScore} margin=${v.margin} → ${v.verdict}`);
      }
    } else {
      console.log('  eval: skipped (skill-bench not installed) — promoting all generated');
    }

    // 3. PROMOTE
    const toPromote = evalEnabled ? skills.filter((s) => verdicts[s.skill_id]?.verdict === 'promote') : skills;
    for (const s of toPromote) {
      const r = promoteSkill({ sessionId: sid, skillId: s.skill_id, install: args.install, target: args.target, overwrite: true });
      if (args.install) console.log(`     ${r.installed ? '⬆ installed' : '✗ ' + r.error} ${s.skill_id}${r.installed ? ' → ' + r.installed : ''}`);
      else console.log(`     ▸ would install ${s.skill_id} → ${r.plan?.to}`);
      if (r.installed || (!args.install && r.ok)) totalPromoted++;
    }
    if (evalEnabled && !toPromote.length) console.log('     (none passed eval)');
  }

  console.log(`\n[flywheel] done — ${totalSkills} skills, ${totalPromoted} ${args.install ? 'installed' : 'promotable'}, ~$${totalCost.toFixed(2)}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
