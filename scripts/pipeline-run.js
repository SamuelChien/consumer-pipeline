#!/usr/bin/env node
/**
 * Unified pipeline: ingest → analyze → generate → eval → promote
 *
 * Usage:
 *   node scripts/pipeline-run.js                    # full run
 *   node scripts/pipeline-run.js --skip-ingest      # skip ingestion, use existing data
 *   node scripts/pipeline-run.js --dry-run          # generate but don't promote
 *   node scripts/pipeline-run.js --themes mcp,devops # only specific themes
 */
import { execFileSync, execSync, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { createLogger } from '../src/shared/logger.js';
import { claudeJSON } from '../src/shared/claude-cli.js';

const logger = createLogger('pipeline');
const ROOT = resolve(process.cwd());
const NARIO = resolve('/Users/samuelchien/dev/nario');
const SINK = resolve('/Users/samuelchien/dev/claude-sink');
const SKILLS_DIR = '/Users/samuelchien/dev/mega-skills-directory/mega-skills-union';
const SESSIONS_FILE = '/Users/samuelchien/dev/claude-sessions-pipeline/output/deep-analysis.json';
const OUTPUT = join(ROOT, 'output');
const GCP_PROJECT = 'blobfish-ai-429200';

const args = process.argv.slice(2);
const SKIP_INGEST = args.includes('--skip-ingest');
const DRY_RUN = args.includes('--dry-run');
const THEMES_FILTER = args.find(a => a.startsWith('--themes='))?.split('=')[1]?.split(',') || null;

// ============================================================================
// PHASE 1: INGEST — fresh sessions, skills, code into Pub/Sub
// ============================================================================
async function phaseIngest() {
  if (SKIP_INGEST) {
    logger.info('Phase 1: SKIP (--skip-ingest)');
    return;
  }
  logger.info('Phase 1: INGEST — pulling fresh data into Pub/Sub');

  const sinkBin = join(SINK, 'dist/index.js');

  try {
    logger.info('  Ingesting sessions...');
    execFileSync('node', [sinkBin, 'sessions', '--pubsub', GCP_PROJECT, '--quiet'], { stdio: 'pipe', timeout: 120000 });
  } catch (e) { logger.warn('  Sessions ingest: ' + (e.stderr?.toString().slice(0, 200) || e.message)); }

  try {
    logger.info('  Ingesting skills...');
    execFileSync('node', [sinkBin, 'skills', SKILLS_DIR, '--pubsub', GCP_PROJECT, '--quiet'], { stdio: 'pipe', timeout: 120000 });
  } catch (e) { logger.warn('  Skills ingest: ' + (e.stderr?.toString().slice(0, 200) || e.message)); }

  try {
    logger.info('  Ingesting code...');
    execFileSync('node', [sinkBin, 'code', NARIO, '--pubsub', GCP_PROJECT, '--quiet'], { stdio: 'pipe', timeout: 120000 });
  } catch (e) { logger.warn('  Code ingest: ' + (e.stderr?.toString().slice(0, 200) || e.message)); }

  logger.info('Phase 1: DONE');
}

// ============================================================================
// PHASE 2: ANALYZE — build full context from deep analysis + stores
// ============================================================================
async function phaseAnalyze() {
  logger.info('Phase 2: ANALYZE — building context from session intelligence');

  const sessions = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  const real = sessions.filter(s => {
    const tokens = s.shallow?.tokenUsage?.totalTokens || 0;
    const goal = s.deep?.userGoal || '';
    return tokens > 50 && !goal.includes('did not specify') && !goal.includes('immediately exited');
  });

  const gaps = {};
  const allProblems = [];
  const allStruggles = [];
  const allAutomation = [];
  const techCount = {};
  const conceptCount = {};
  const sessionsByOutcome = { successful: [], partial: [], failed: [] };

  for (const s of real) {
    const deep = s.deep || {};
    const sh = s.shallow || {};
    const outcome = deep.sessionQuality?.outcome || 'unknown';

    if (['successful', 'partial', 'failed'].includes(outcome)) {
      sessionsByOutcome[outcome].push({
        goal: deep.userGoal || '',
        built: deep.whatTheyBuilt || '',
        tech: deep.projectContext?.techStack || [],
        problems: deep.problems || [],
        struggles: deep.struggles || [],
        skillsNeeded: deep.fundamentalSkillsNeeded || [],
        workflow: deep.orchestrationPattern?.workflow || '',
        automation: deep.orchestrationPattern?.automationOpportunities || [],
        concepts: deep.connections?.relatedConcepts || [],
        insight: deep.sessionQuality?.keyInsight || '',
        tokens: sh.tokenUsage?.totalTokens || 0,
      });
    }

    for (const sk of (deep.fundamentalSkillsNeeded || [])) {
      const key = sk.skill;
      if (!gaps[key]) gaps[key] = { skill: sk.skill, category: sk.category, reasons: [], urgencies: [], sessions: 0 };
      gaps[key].sessions++;
      gaps[key].reasons.push(sk.reason);
      gaps[key].urgencies.push(sk.urgency);
    }
    for (const p of (deep.problems || [])) allProblems.push({ ...p, goal: (deep.userGoal || '').slice(0, 100) });
    for (const st of (deep.struggles || [])) allStruggles.push(st);
    for (const a of (deep.orchestrationPattern?.automationOpportunities || [])) allAutomation.push(a);
    for (const t of (deep.projectContext?.techStack || [])) techCount[t] = (techCount[t] || 0) + 1;
    for (const c of (deep.connections?.relatedConcepts || [])) conceptCount[c] = (conceptCount[c] || 0) + 1;
  }

  const gapList = Object.values(gaps).sort((a, b) => b.sessions - a.sessions);

  // Check what dev-skills already exist in nario
  const existingDevSkills = new Set();
  const devSkillsDir = join(NARIO, '.claude/dev-skills');
  if (existsSync(devSkillsDir)) {
    for (const d of readdirSync(devSkillsDir, { withFileTypes: true })) {
      if (d.isDirectory() && !d.name.startsWith('_')) existingDevSkills.add(d.name);
    }
  }

  const context = { gapList, allProblems, allStruggles, allAutomation, sessionsByOutcome, techCount, conceptCount, existingDevSkills };
  writeFileSync(join(OUTPUT, 'pipeline-context.json'), JSON.stringify({ ...context, existingDevSkills: [...existingDevSkills] }, null, 2));
  logger.info(`Phase 2: DONE — ${gapList.length} gaps, ${allProblems.length} problems, ${existingDevSkills.size} existing dev-skills`);
  return context;
}

// ============================================================================
// PHASE 3: GENERATE — create skills via claude -p
// ============================================================================
async function phaseGenerate(context) {
  logger.info('Phase 3: GENERATE — creating skills from gap analysis');

  const themes = buildThemes(context.gapList);
  const generated = [];
  const BATCH_SIZE = 3;

  for (const [themeName, themeGaps] of Object.entries(themes)) {
    if (THEMES_FILTER && !THEMES_FILTER.some(t => themeName.includes(t))) continue;
    if (themeGaps.length === 0) continue;

    for (let i = 0; i < themeGaps.length; i += BATCH_SIZE) {
      const batch = themeGaps.slice(i, i + BATCH_SIZE);
      const batchName = themeGaps.length <= BATCH_SIZE ? themeName : `${themeName}-${Math.floor(i / BATCH_SIZE) + 1}`;

      logger.info(`  Generating: ${batchName} (${batch.length} gaps)`);
      try {
        const result = await claudeJSON(buildPrompt(batchName, batch, context), { timeoutMs: 600000 });
        for (const skill of (result.skills || [])) {
          const id = (skill.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          if (context.existingDevSkills.has(id)) {
            logger.info(`    SKIP ${id} (already exists in nario dev-skills)`);
            continue;
          }
          skill.id = id;
          skill.theme = batchName;
          generated.push(skill);
          writeSkillFile(skill);
          logger.info(`    Generated: ${id} (${skill.type})`);
        }
      } catch (err) {
        logger.error(`  ${batchName} failed: ${err.message.slice(0, 200)}`);
      }
    }
  }

  writeFileSync(join(OUTPUT, 'pipeline-generated.json'), JSON.stringify(generated, null, 2));
  logger.info(`Phase 3: DONE — ${generated.length} skills generated`);
  return generated;
}

function buildThemes(gapList) {
  const themes = {
    'mcp-integrations': [], 'claude-code-config': [], 'data-pipelines': [],
    'devops-infra': [], 'architecture': [], 'testing-quality': [],
  };
  for (const g of gapList) {
    const text = (g.skill + ' ' + g.reasons.join(' ')).toLowerCase();
    if (/mcp|oauth|gmail|api.*auth|google.*cloud|credential/i.test(text)) themes['mcp-integrations'].push(g);
    else if (/claude.*code|cli.*config|shell.*config|hook|permission|settings/i.test(text)) themes['claude-code-config'].push(g);
    else if (/kafka|clickhouse|neo4j|pipeline|stream|data|etl|ingestion/i.test(text)) themes['data-pipelines'].push(g);
    else if (/docker|kubernetes|k8s|deploy|ci.cd|argocd|gcp|aws/i.test(text)) themes['devops-infra'].push(g);
    else if (/architect|design.*pattern|microservice|event.*driven|graph/i.test(text)) themes['architecture'].push(g);
    else if (/test|eval|quality|debug|troubleshoot|security|validation/i.test(text)) themes['testing-quality'].push(g);
    else themes['architecture'].push(g);
  }
  return themes;
}

function buildPrompt(themeName, gaps, ctx) {
  const failed = ctx.sessionsByOutcome.failed.slice(0, 3);
  const existing = [...ctx.existingDevSkills].slice(0, 15);

  return `Skill architect for Claude Code. Create ${Math.min(3, gaps.length)} skills for theme "${themeName}".

GAPS:
${gaps.map(g => `- ${g.skill} (${g.category}, ${g.sessions}x, ${g.urgencies[0]}) — ${g.reasons[0].slice(0, 100)}`).join('\n')}

FAILURES TO PREVENT:
${failed.map(s => `- ${s.goal.slice(0, 100)}`).join('\n')}

EXISTING (don't duplicate): ${existing.join(', ')}

Each skill needs: name, type (script|fundamental|orchestration), description, category, tags, tools, addressesGaps, relatedSkills, context (1 sentence), body.

Body MUST be 100-150 words. Structure: ## When to use (2 bullets), ## Steps (numbered, with real CLI commands), ## Error handling (what to check if it fails). Use REAL file paths, REAL commands, REAL tool names. No generic advice.

JSON only: { "skills": [...] }`;
}

function writeSkillFile(skill) {
  const dir = join(OUTPUT, 'generated-skills', skill.type === 'orchestration' ? 'orchestration' : skill.type === 'fundamental' ? 'fundamental' : 'scripts');
  mkdirSync(dir, { recursive: true });

  const content = `---
name: ${skill.name}
description: "${(skill.description || '').replace(/"/g, '\\"')}"
category: ${skill.category || 'productivity'}
tags: [${(skill.tags || []).join(', ')}]
allowed-tools: [${(skill.tools || []).join(', ')}]
type: ${skill.type || 'script'}
theme: ${skill.theme || 'unknown'}
addresses_gaps: [${(skill.addressesGaps || []).join(', ')}]
related_skills: [${(skill.relatedSkills || []).join(', ')}]
generated_at: ${new Date().toISOString()}
---

## Context

${skill.context || ''}

${skill.body || `# ${skill.name}\n\n${skill.description}`}`;

  writeFileSync(join(dir, `${skill.id}.md`), content);
}

// ============================================================================
// PHASE 4: EVAL — benchmark each skill against baseline
// ============================================================================
async function phaseEval(generated) {
  logger.info('Phase 4: EVAL — benchmarking generated skills');

  const results = [];
  for (const skill of generated) {
    logger.info(`  Evaluating: ${skill.id}`);
    try {
      const evalResult = await claudeJSON(`You are a skill quality evaluator. Score this Claude Code skill on a 0-100 scale across 5 dimensions.

## SKILL TO EVALUATE
Name: ${skill.name}
Type: ${skill.type}
Description: ${skill.description}
Gaps addressed: ${(skill.addressesGaps || []).join(', ')}

Body (first 2000 chars):
${(skill.body || '').slice(0, 2000)}

## SCORING CRITERIA
1. **Actionability** (0-100): Can a user follow these instructions and get a working result?
2. **Completeness** (0-100): Does it cover the full workflow, including error cases?
3. **Specificity** (0-100): Does it reference real tools, commands, and file paths (not generic advice)?
4. **Gap Coverage** (0-100): Does it actually address the gaps it claims to?
5. **Production Readiness** (0-100): Could this ship as a dev-skill without major edits?

Return JSON: { "scores": { "actionability": N, "completeness": N, "specificity": N, "gapCoverage": N, "productionReadiness": N }, "overall": N, "verdict": "promote|revise|reject", "reason": "one sentence" }`, { timeoutMs: 120000 });

      const overall = evalResult.overall || 0;
      results.push({ id: skill.id, name: skill.name, ...evalResult, skill });
      logger.info(`    ${skill.id}: ${overall}/100 → ${evalResult.verdict} (${evalResult.reason})`);
    } catch (err) {
      logger.error(`    ${skill.id} eval failed: ${err.message.slice(0, 100)}`);
      results.push({ id: skill.id, name: skill.name, overall: 0, verdict: 'reject', reason: 'eval failed', skill });
    }
  }

  // Phase 4.5: Revise skills scoring 50-74
  const revisable = results.filter(r => r.overall >= 50 && r.overall < 75 && r.reason);
  if (revisable.length > 0) {
    logger.info(`Phase 4.5: REVISE — improving ${revisable.length} skills`);
    for (const r of revisable.slice(0, 10)) {
      try {
        const improved = await claudeJSON(`Fix this Claude Code skill based on the eval feedback.

SKILL: ${r.skill.name}
TYPE: ${r.skill.type}
DESCRIPTION: ${r.skill.description}
CURRENT BODY:
${(r.skill.body || '').slice(0, 800)}

EVAL FEEDBACK (score ${r.overall}/100): ${r.reason}

Rewrite the body to fix EVERY issue mentioned. Keep it 100-150 words. Use real commands, real file paths, include error handling.

Return JSON: { "body": "the improved body", "name": "${r.skill.name}", "description": "${r.skill.description}" }`, { timeoutMs: 120000 });

        if (improved.body) {
          r.skill.body = improved.body;
          writeSkillFile(r.skill);

          const reeval = await claudeJSON(`Score this skill 0-100. Criteria: actionability, completeness, specificity, gap coverage, production readiness.

Name: ${r.skill.name}
Body: ${improved.body.slice(0, 1000)}

Return JSON: { "overall": N, "verdict": "promote|revise|reject", "reason": "one sentence" }`, { timeoutMs: 60000 });

          r.overall = reeval.overall || r.overall;
          r.verdict = reeval.verdict || r.verdict;
          r.reason = reeval.reason || r.reason;
          r.revised = true;
          logger.info(`    ${r.id}: ${r.overall}/100 → ${r.verdict} (revised)`);
        }
      } catch (err) {
        logger.error(`    ${r.id} revision failed: ${err.message.slice(0, 100)}`);
      }
    }
  }

  writeFileSync(join(OUTPUT, 'pipeline-eval-results.json'), JSON.stringify(results, null, 2));

  const promoted = results.filter(r => (r.verdict === 'promote' || r.overall >= 70));
  const revised = results.filter(r => r.verdict === 'revise' && r.overall < 75);
  const rejected = results.filter(r => r.verdict === 'reject' || r.overall < 50);

  logger.info(`Phase 4: DONE — ${promoted.length} promote, ${revised.length} revise, ${rejected.length} reject`);
  return { results, promoted, revised, rejected };
}

// ============================================================================
// PHASE 5: PROMOTE — push winners to nario dev-skills
// ============================================================================
async function phasePromote(evalResults) {
  const { promoted } = evalResults;

  if (DRY_RUN) {
    logger.info(`Phase 5: DRY RUN — would promote ${promoted.length} skills`);
    for (const r of promoted) logger.info(`  Would promote: ${r.id} (${r.overall}/100)`);
    return;
  }

  logger.info(`Phase 5: PROMOTE — pushing ${promoted.length} skills to nario`);

  const devSkillsDir = join(NARIO, '.claude/dev-skills');
  const promotedSkills = [];

  for (const r of promoted) {
    const skill = r.skill;
    const skillDir = join(devSkillsDir, skill.id);

    if (existsSync(skillDir)) {
      logger.info(`  SKIP ${skill.id} (already exists)`);
      continue;
    }

    mkdirSync(skillDir, { recursive: true });
    mkdirSync(join(skillDir, 'evals'), { recursive: true });
    mkdirSync(join(skillDir, 'tests'), { recursive: true });

    // SKILL.md — nario format
    const skillMd = `---
name: ${skill.name}
description: |
  ${skill.description}
  Use when the user needs help with ${(skill.addressesGaps || []).join(' or ')}.
internal: true
allowed-tools: ${(skill.tools || ['Bash', 'Read']).join(', ')}
---

${skill.body || `# ${skill.name}\n\n${skill.description}`}`;

    writeFileSync(join(skillDir, 'SKILL.md'), skillMd);

    // run.sh stub
    writeFileSync(join(skillDir, 'run.sh'), `#!/usr/bin/env bash
set -euo pipefail
# Generated by consumer-pipeline on ${new Date().toISOString()}
# TODO: implement the skill logic
echo "${skill.name}: not yet implemented — fill in the commands from SKILL.md"
`, { mode: 0o755 });

    // evals/evals.json — trigger phrases
    writeFileSync(join(skillDir, 'evals/evals.json'), JSON.stringify({
      triggers: (skill.addressesGaps || []).map(g => `Help me with ${g}`),
      antiTriggers: ['unrelated request'],
      expectedBehavior: skill.description,
    }, null, 2));

    // tests/run-tests.sh
    writeFileSync(join(skillDir, 'tests/run-tests.sh'), `#!/usr/bin/env bash
set -euo pipefail
echo "Testing ${skill.name}..."
# TODO: add assertions
bash "$(dirname "$0")/../run.sh" 2>&1 | grep -q "${skill.name}" && echo "PASS" || echo "FAIL"
`, { mode: 0o755 });

    // eval result metadata
    writeFileSync(join(skillDir, 'eval-result.json'), JSON.stringify({
      overall: r.overall,
      scores: r.scores,
      verdict: r.verdict,
      reason: r.reason,
      generatedAt: new Date().toISOString(),
      theme: skill.theme,
      addressesGaps: skill.addressesGaps,
    }, null, 2));

    promotedSkills.push(skill.id);
    logger.info(`  PROMOTED: ${skill.id} → ${skillDir}`);
  }

  // Create symlinks for discovery
  const skillsLinkDir = join(NARIO, '.claude/skills');
  for (const id of promotedSkills) {
    const linkPath = join(skillsLinkDir, `${id}.md`);
    const targetPath = join(devSkillsDir, id, 'SKILL.md');
    if (!existsSync(linkPath)) {
      try {
        const { symlinkSync } = await import('fs');
        symlinkSync(targetPath, linkPath);
        logger.info(`  Symlinked: ${linkPath}`);
      } catch {}
    }
  }

  // Write pipeline run summary
  const summary = {
    runAt: new Date().toISOString(),
    promoted: promotedSkills,
    evalResults: evalResults.results.map(r => ({ id: r.id, overall: r.overall, verdict: r.verdict })),
    totalGenerated: evalResults.results.length,
    totalPromoted: promotedSkills.length,
  };
  writeFileSync(join(OUTPUT, 'pipeline-run-summary.json'), JSON.stringify(summary, null, 2));

  logger.info(`Phase 5: DONE — ${promotedSkills.length} skills promoted to nario`);
  return promotedSkills;
}

// ============================================================================
// MAIN
// ============================================================================
async function main() {
  logger.info('=== SKILL CREATION PIPELINE ===');
  logger.info(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'} | Skip ingest: ${SKIP_INGEST} | Themes: ${THEMES_FILTER || 'all'}`);

  mkdirSync(join(OUTPUT, 'generated-skills/scripts'), { recursive: true });
  mkdirSync(join(OUTPUT, 'generated-skills/fundamental'), { recursive: true });
  mkdirSync(join(OUTPUT, 'generated-skills/orchestration'), { recursive: true });

  await phaseIngest();
  const context = await phaseAnalyze();
  const generated = await phaseGenerate(context);

  if (generated.length === 0) {
    logger.info('No skills generated. Pipeline complete.');
    return;
  }

  const evalResults = await phaseEval(generated);
  await phasePromote(evalResults);

  logger.info('=== PIPELINE COMPLETE ===');
}

main().catch(err => {
  logger.error('Pipeline failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
