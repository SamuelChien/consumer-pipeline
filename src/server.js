/**
 * Sink Job Server — configurable per-user ingestion pipeline.
 *
 * Each user/tenant defines a sink job (JSON config in sink-jobs/).
 * Jobs specify: what to ingest, how to process, where to output.
 *
 * Endpoints:
 *   GET  /health                    — server status
 *   GET  /jobs                      — list all sink jobs
 *   GET  /jobs/:id                  — get job config + last run
 *   POST /jobs/:id/run              — trigger a job
 *   POST /jobs/:id/ingest/sessions  — push session data into a job
 *   POST /jobs/:id/ingest/skills    — push skill data into a job
 *   GET  /jobs/:id/output/skills    — generated skills for job
 *   GET  /jobs/:id/output/graph     — skill graph for job
 *   GET  /jobs/:id/output/summary   — last run summary
 *   GET  /jobs/:id/output/eval      — eval results
 *   GET  /jobs/:id/output/context   — gap analysis context
 */
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { config } from './shared/config.js';
import { createLogger } from './shared/logger.js';
import * as connectors from './connectors/index.js';
import { researchSession, writeResult } from './research-agent/index.js';
import { loadSessions, isRealSession } from './research-agent/extract-brief.js';
import { evalSession } from './eval-gate/index.js';
import { promoteSkill, promoteSession } from './promote/index.js';

const logger = createLogger('server');
const PORT = process.env.PORT || 8080;
const JOBS_DIR = resolve(process.cwd(), 'sink-jobs');
const OUTPUT_BASE = resolve(config.outputDir);

// ============================================================================
// JOB REGISTRY
// ============================================================================
const jobs = new Map();

function loadJobs() {
  if (!existsSync(JOBS_DIR)) return;
  for (const f of readdirSync(JOBS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'))) {
    try {
      const cfg = JSON.parse(readFileSync(join(JOBS_DIR, f), 'utf8'));
      const job = {
        config: cfg,
        sessions: [],
        skills: [],
        running: false,
        lastRun: null,
      };

      // Load sessions from deepAnalysisFile if specified
      const sessionSource = cfg.sources?.find(s => s.type === 'claude-sessions');
      if (sessionSource?.deepAnalysisFile && existsSync(sessionSource.deepAnalysisFile)) {
        job.sessions = JSON.parse(readFileSync(sessionSource.deepAnalysisFile, 'utf8'));
        logger.info(`Job ${cfg.id}: loaded ${job.sessions.length} sessions from ${sessionSource.deepAnalysisFile}`);
      }

      // Load last run if exists
      const summaryPath = join(OUTPUT_BASE, cfg.id, 'pipeline-run-summary.json');
      if (existsSync(summaryPath)) {
        job.lastRun = JSON.parse(readFileSync(summaryPath, 'utf8'));
      }

      jobs.set(cfg.id, job);
      logger.info(`Job registered: ${cfg.id} (${cfg.enabled ? 'enabled' : 'disabled'})`);
    } catch (err) {
      logger.error(`Failed to load job ${f}: ${err.message}`);
    }
  }
}

// ============================================================================
// JOB RUNNER
// ============================================================================
async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  if (job.running) throw new Error(`Job already running: ${jobId}`);

  job.running = true;
  const cfg = job.config;
  const jobOutput = join(OUTPUT_BASE, cfg.id);
  mkdirSync(join(jobOutput, 'generated-skills/scripts'), { recursive: true });
  mkdirSync(join(jobOutput, 'generated-skills/fundamental'), { recursive: true });
  mkdirSync(join(jobOutput, 'generated-skills/orchestration'), { recursive: true });

  const { claudeJSON } = await import('./shared/claude-cli.js');

  try {
    // --- PHASE 1: ANALYZE ---
    logger.info(`[${jobId}] Phase 1: Analyzing ${job.sessions.length} sessions`);

    const sessions = job.sessions.filter(s => {
      const tokens = s.shallow?.tokenUsage?.totalTokens || 0;
      const goal = s.deep?.userGoal || '';
      return tokens > 50 && !goal.includes('did not specify') && !goal.includes('immediately exited');
    });

    const gaps = {};
    const problems = [];
    const outcomes = { successful: [], partial: [], failed: [] };

    for (const s of sessions) {
      const deep = s.deep || {};
      const outcome = deep.sessionQuality?.outcome || 'unknown';
      if (['successful', 'partial', 'failed'].includes(outcome)) {
        outcomes[outcome].push({
          goal: deep.userGoal || '',
          problems: deep.problems || [],
          struggles: deep.struggles || [],
          skillsNeeded: deep.fundamentalSkillsNeeded || [],
          tech: deep.projectContext?.techStack || [],
        });
      }
      for (const sk of (deep.fundamentalSkillsNeeded || [])) {
        const key = sk.skill;
        if (!gaps[key]) gaps[key] = { skill: sk.skill, category: sk.category, reasons: [], urgencies: [], sessions: 0 };
        gaps[key].sessions++;
        gaps[key].reasons.push(sk.reason);
        gaps[key].urgencies.push(sk.urgency);
      }
      for (const p of (deep.problems || [])) problems.push(p);
    }

    const gapList = Object.values(gaps).sort((a, b) => b.sessions - a.sessions);

    // Check existing skills
    const existingSkills = new Set();
    const outputCfg = cfg.outputs?.skills || {};
    if (outputCfg.target === 'nario-dev-skills' && outputCfg.narioDir) {
      const dir = join(outputCfg.narioDir, outputCfg.devSkillsPath || '.claude/dev-skills');
      if (existsSync(dir)) {
        for (const d of readdirSync(dir, { withFileTypes: true })) {
          if (d.isDirectory() && !d.name.startsWith('_')) existingSkills.add(d.name);
        }
      }
    }

    const context = { gapList, sessions: sessions.length, problems: problems.length, existingSkills: [...existingSkills] };
    writeFileSync(join(jobOutput, 'pipeline-context.json'), JSON.stringify(context, null, 2));
    logger.info(`[${jobId}] Phase 1 done: ${gapList.length} gaps, ${problems.length} problems`);

    // --- PHASE 2: GENERATE ---
    const genCfg = cfg.processors?.find(p => p.type === 'skill-generation')?.config || {};
    const maxGaps = genCfg.maxGapsPerRun || 12;
    const batchSize = genCfg.batchSize || 3;
    const topGaps = gapList.slice(0, maxGaps);
    let generated = [];

    logger.info(`[${jobId}] Phase 2: Generating from ${topGaps.length} gaps (batch=${batchSize})`);

    for (let i = 0; i < topGaps.length; i += batchSize) {
      const batch = topGaps.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      try {
        const result = await claudeJSON(`Skill architect for Claude Code. Create ${Math.min(3, batch.length)} skills.

GAPS:
${batch.map(g => `- ${g.skill} (${g.sessions}x, ${g.urgencies[0]}) — ${g.reasons[0].slice(0, 80)}`).join('\n')}

FAILURES:
${outcomes.failed.slice(0, 2).map(s => `- ${s.goal.slice(0, 80)}`).join('\n') || 'none'}

EXISTING: ${[...existingSkills].slice(0, 10).join(', ') || 'none'}

Each: name (kebab), type (script|fundamental|orchestration), description, category, tags, tools, addressesGaps, relatedSkills, context (1 sentence), body (100-150 words: ## Steps with real commands, ## Error handling).

JSON: { "skills": [...] }`, { timeoutMs: 300000 });

        for (const skill of (result.skills || [])) {
          const id = (skill.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
          if (existingSkills.has(id)) continue;
          skill.id = id;
          generated.push(skill);

          const typeDir = skill.type === 'orchestration' ? 'orchestration' : skill.type === 'fundamental' ? 'fundamental' : 'scripts';
          writeFileSync(join(jobOutput, 'generated-skills', typeDir, `${id}.md`), `---
name: ${skill.name}
description: "${(skill.description || '').replace(/"/g, '\\"')}"
category: ${skill.category || 'productivity'}
tags: [${(skill.tags || []).join(', ')}]
allowed-tools: [${(skill.tools || []).join(', ')}]
type: ${skill.type || 'script'}
addresses_gaps: [${(skill.addressesGaps || []).join(', ')}]
related_skills: [${(skill.relatedSkills || []).join(', ')}]
generated_at: ${new Date().toISOString()}
job: ${jobId}
---

## Context

${skill.context || ''}

${skill.body || `# ${skill.name}\n\n${skill.description}`}`);

          logger.info(`[${jobId}] Generated: ${id} (${skill.type})`);
        }
      } catch (err) {
        logger.error(`[${jobId}] Batch ${batchNum} failed: ${err.message.slice(0, 100)}`);
      }
    }

    logger.info(`[${jobId}] Phase 2 done: ${generated.length} skills`);

    // --- PHASE 3: EVAL ---
    const evalCfg = cfg.processors?.find(p => p.type === 'eval')?.config || {};
    const threshold = evalCfg.promoteThreshold || 70;
    const promoted = [];
    const evalResults = [];

    logger.info(`[${jobId}] Phase 3: Evaluating ${generated.length} skills (threshold=${threshold})`);

    for (const skill of generated) {
      try {
        const ev = await claudeJSON(`Rate this Claude Code dev-skill. A dev-skill is an internal helper (run.sh + SKILL.md) for developer workflows. Score 0-100:

- 80-100: Has real commands, real file paths, error handling, could ship now
- 60-79: Mostly actionable, minor gaps (missing edge case or incomplete step)
- 40-59: Concept is right but too vague or missing key steps
- 0-39: Generic advice, no real commands, wrong approach

Name: ${skill.name}
Description: ${skill.description}
Body:
${(skill.body || '').slice(0, 1000)}

JSON: { "overall": N, "verdict": "promote|revise|reject", "reason": "one sentence" }`, { timeoutMs: 60000 });

        evalResults.push({ id: skill.id, overall: ev.overall, verdict: ev.verdict, reason: ev.reason });

        if (ev.overall >= threshold) {
          promoted.push(skill);
          logger.info(`[${jobId}] PROMOTE: ${skill.id} (${ev.overall})`);
        } else {
          logger.info(`[${jobId}] ${ev.verdict}: ${skill.id} (${ev.overall})`);
        }
      } catch (err) {
        evalResults.push({ id: skill.id, overall: 0, verdict: 'error', reason: err.message.slice(0, 100) });
      }
    }

    writeFileSync(join(jobOutput, 'pipeline-eval-results.json'), JSON.stringify(evalResults, null, 2));

    // --- PHASE 4: PROMOTE ---
    const promotedIds = [];
    if (outputCfg.target === 'nario-dev-skills' && outputCfg.narioDir && promoted.length > 0) {
      const devDir = join(outputCfg.narioDir, outputCfg.devSkillsPath || '.claude/dev-skills');
      const linkDir = join(outputCfg.narioDir, outputCfg.symlinksPath || '.claude/skills');

      for (const skill of promoted) {
        const skillDir = join(devDir, skill.id);
        if (existsSync(skillDir)) continue;

        mkdirSync(join(skillDir, 'evals'), { recursive: true });
        mkdirSync(join(skillDir, 'tests'), { recursive: true });

        writeFileSync(join(skillDir, 'SKILL.md'), `---
name: ${skill.name}
description: |
  ${skill.description}
internal: true
allowed-tools: ${(skill.tools || ['Bash', 'Read']).join(', ')}
---

${skill.body || skill.description}`);

        writeFileSync(join(skillDir, 'run.sh'), `#!/usr/bin/env bash\nset -euo pipefail\necho "${skill.name}: implement from SKILL.md"\n`, { mode: 0o755 });
        writeFileSync(join(skillDir, 'evals/evals.json'), JSON.stringify({ triggers: (skill.addressesGaps || []).map(g => `Help me with ${g}`) }, null, 2));
        writeFileSync(join(skillDir, 'tests/run-tests.sh'), `#!/usr/bin/env bash\nset -euo pipefail\necho "PASS"\n`, { mode: 0o755 });

        const linkPath = join(linkDir, `${skill.id}.md`);
        if (!existsSync(linkPath)) {
          try { const { symlinkSync } = await import('fs'); symlinkSync(join(skillDir, 'SKILL.md'), linkPath); } catch {}
        }

        promotedIds.push(skill.id);
        logger.info(`[${jobId}] PROMOTED: ${skill.id} → ${skillDir}`);
      }
    }

    // --- WRITE GRAPH ---
    writeFileSync(join(jobOutput, 'skill-graph.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      job: jobId,
      skills: generated.map(s => ({ id: s.id, name: s.name, type: s.type, category: s.category, addressesGaps: s.addressesGaps, relatedSkills: s.relatedSkills })),
      edges: generated.flatMap(s => [
        ...(s.relatedSkills || []).map(r => ({ from: s.id, to: r, type: 'RELATED_TO' })),
        ...(s.addressesGaps || []).map(g => ({ from: s.id, to: g, type: 'ADDRESSES' })),
      ]),
    }, null, 2));

    // --- SUMMARY ---
    const summary = {
      runAt: new Date().toISOString(),
      job: jobId,
      sessions: sessions.length,
      gaps: gapList.length,
      generated: generated.length,
      evaluated: evalResults.length,
      promoted: promotedIds,
      totalPromoted: promotedIds.length,
      evalResults: evalResults.map(r => ({ id: r.id, overall: r.overall, verdict: r.verdict })),
    };
    writeFileSync(join(jobOutput, 'pipeline-run-summary.json'), JSON.stringify(summary, null, 2));

    job.lastRun = summary;
    job.running = false;
    logger.info(`[${jobId}] COMPLETE: ${generated.length} generated, ${promotedIds.length} promoted`);
    return summary;

  } catch (err) {
    job.running = false;
    throw err;
  }
}

// ============================================================================
// HTTP SERVER
// ============================================================================
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 50e6) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
  });
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

function readOutputFile(jobId, filename) {
  const p = join(OUTPUT_BASE, jobId, filename);
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  return null;
}

// ============================================================================
// FLYWHEEL v2: web UI + connectors + research runs + skill browsing
// ============================================================================
const RESEARCH_OUT = process.env.OUTPUT_DIR ? resolve(process.env.OUTPUT_DIR) : resolve(process.cwd(), 'output');
const SKILLS_ROOT = join(RESEARCH_OUT, 'research-skills');
const researchRuns = new Map();
const evalResultsCache = new Map();
let runSeq = 0;

function sendHtml(res, html, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(html);
}
function renderUI() {
  return readFileSync(new URL('./web/index.html', import.meta.url), 'utf8');
}

/** Kick off a research run in the background; track status in memory. */
function startResearch({ limit = 1, sessionId = null, dryRun = false } = {}) {
  const id = `run-${Date.now()}-${++runSeq}`;
  const run = { id, status: 'running', startedAt: new Date().toISOString(), dryRun, sessions: 0, skills: 0, cost: 0, results: [] };
  researchRuns.set(id, run);
  (async () => {
    try {
      const all = loadSessions().filter(isRealSession);
      const sessions = sessionId ? all.filter((s) => s.sessionId === sessionId) : all.slice(0, limit);
      run.sessions = sessions.length;
      for (const s of sessions) {
        const r = await researchSession(s, { dryRun });
        run.skills += r.skills?.length || 0;
        run.cost += r.meta?.total_cost_usd || 0;
        if (!dryRun) writeResult(r, RESEARCH_OUT);
        run.results.push({ sessionId: r.sessionId, skills: (r.skills || []).map((x) => x.skill_id), rejected: r.rejected?.length || 0 });
        logger.info(`[research] ${r.sessionId}: ${r.skills?.length || 0} skills`);
      }
      run.status = 'done';
    } catch (e) {
      run.status = 'error';
      run.error = e.message;
    }
    run.finishedAt = new Date().toISOString();
  })();
  return run;
}

function listResearchSkills() {
  if (!existsSync(SKILLS_ROOT)) return [];
  const out = [];
  for (const d of readdirSync(SKILLS_ROOT, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const mp = join(SKILLS_ROOT, d.name, 'manifest.json');
    if (!existsSync(mp)) continue;
    try {
      const m = JSON.parse(readFileSync(mp, 'utf8'));
      out.push({
        sessionId: d.name,
        goal: m.brief?.userGoal,
        generatedAt: m.generatedAt,
        cost: m.meta?.total_cost_usd,
        turns: m.meta?.num_turns,
        skills: (m.skills || []).map((s) => ({ skill_id: s.skill_id, mutates: s.mutates, addresses_gap: s.addresses_gap, related_skills: s.related_skills })),
      });
    } catch { /* skip bad manifest */ }
  }
  return out.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
}

function readResearchSkillFile(sessionId, skillId) {
  const p = join(SKILLS_ROOT, sessionId, skillId, 'SKILL.md');
  if (!resolve(p).startsWith(resolve(SKILLS_ROOT))) return null; // path traversal guard
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    if (url.pathname === '/health') {
      return json(res, {
        status: 'ok',
        jobs: [...jobs.entries()].map(([id, j]) => ({
          id, enabled: j.config.enabled, sessions: j.sessions.length, running: j.running, lastRun: j.lastRun?.runAt || null, lastPromoted: j.lastRun?.totalPromoted || 0,
        })),
      });
    }

    if (url.pathname === '/jobs' && req.method === 'GET') {
      return json(res, [...jobs.entries()].map(([id, j]) => ({
        id, name: j.config.name, enabled: j.config.enabled, sessions: j.sessions.length,
        sources: j.config.sources?.map(s => s.type) || [],
        running: j.running, lastRun: j.lastRun?.runAt || null, lastPromoted: j.lastRun?.totalPromoted || 0,
      })));
    }

    // /jobs/:id/...
    if (parts[0] === 'jobs' && parts[1]) {
      const jobId = parts[1];
      const job = jobs.get(jobId);
      if (!job) return json(res, { error: `Job not found: ${jobId}` }, 404);

      const sub = parts.slice(2).join('/');

      if (!sub && req.method === 'GET') {
        return json(res, { config: job.config, sessions: job.sessions.length, running: job.running, lastRun: job.lastRun });
      }

      if (sub === 'run' && req.method === 'POST') {
        if (job.running) return json(res, { error: 'Already running' }, 409);
        runJob(jobId).catch(err => logger.error(`[${jobId}] Pipeline failed: ${err.message}`));
        return json(res, { status: 'started', sessions: job.sessions.length });
      }

      if (sub === 'ingest/sessions' && req.method === 'POST') {
        const data = await parseBody(req);
        const items = Array.isArray(data) ? data : [data];
        const existing = new Set(job.sessions.map(s => s.sessionId));
        let added = 0;
        for (const s of items) { if (!existing.has(s.sessionId)) { job.sessions.push(s); existing.add(s.sessionId); added++; } }
        logger.info(`[${jobId}] Ingested ${added} sessions`);
        return json(res, { ingested: added, total: job.sessions.length });
      }

      if (sub === 'ingest/skills' && req.method === 'POST') {
        const data = await parseBody(req);
        const items = Array.isArray(data) ? data : [data];
        job.skills.push(...items);
        return json(res, { ingested: items.length, total: job.skills.length });
      }

      if (sub === 'output/skills') { const d = readOutputFile(jobId, 'pipeline-eval-results.json'); return d ? json(res, d) : json(res, { error: 'No results yet' }, 404); }
      if (sub === 'output/graph') { const d = readOutputFile(jobId, 'skill-graph.json'); return d ? json(res, d) : json(res, { error: 'No graph yet' }, 404); }
      if (sub === 'output/summary') { const d = readOutputFile(jobId, 'pipeline-run-summary.json'); return d ? json(res, d) : json(res, { error: 'No summary yet' }, 404); }
      if (sub === 'output/eval') { const d = readOutputFile(jobId, 'pipeline-eval-results.json'); return d ? json(res, d) : json(res, { error: 'No eval yet' }, 404); }
      if (sub === 'output/context') { const d = readOutputFile(jobId, 'pipeline-context.json'); return d ? json(res, d) : json(res, { error: 'No context yet' }, 404); }
    }

    // ---- Web UI ----
    if (url.pathname === '/' && req.method === 'GET') return sendHtml(res, renderUI());

    // ---- Connectors (sinks) ----
    if (url.pathname === '/api/connectors' && req.method === 'GET') {
      return json(res, { catalog: connectors.catalog(), connectors: connectors.list(), anyEnabled: connectors.anyEnabled() });
    }
    if (url.pathname === '/api/connectors' && req.method === 'POST') {
      const b = await parseBody(req);
      const r = connectors.add({ type: b.type, producer: { kind: b.producerKind, id: b.producerId }, config: b.config || {} });
      return json(res, r, r.ok ? 200 : 400);
    }
    if (parts[0] === 'api' && parts[1] === 'connectors' && parts[2]) {
      const cid = decodeURIComponent(parts[2]);
      const action = parts[3];
      if (action === 'enable' && req.method === 'POST') return json(res, connectors.setEnabled(cid, true));
      if (action === 'disable' && req.method === 'POST') return json(res, connectors.setEnabled(cid, false));
      if (action === 'sync' && req.method === 'POST') {
        const b = await parseBody(req).catch(() => ({}));
        return json(res, await connectors.sync({ id: cid, plan: b.plan !== false, dryRunSink: !!b.dryRunSink }));
      }
      if (!action && req.method === 'DELETE') return json(res, connectors.remove(cid));
    }

    // ---- Research runs ----
    if (url.pathname === '/api/research' && req.method === 'POST') {
      const b = await parseBody(req).catch(() => ({}));
      return json(res, startResearch(b), 202);
    }
    if (url.pathname === '/api/research/runs' && req.method === 'GET') {
      return json(res, [...researchRuns.values()]);
    }

    // ---- Generated skills ----
    if (url.pathname === '/api/skills' && req.method === 'GET') return json(res, listResearchSkills());
    if (parts[0] === 'api' && parts[1] === 'skills' && parts[2] && parts[3]) {
      const content = readResearchSkillFile(decodeURIComponent(parts[2]), decodeURIComponent(parts[3]));
      return content != null ? json(res, { content }) : json(res, { error: 'not found' }, 404);
    }

    // ---- Eval gate (skill-bench, Claude Code) ----
    if (url.pathname === '/api/eval' && req.method === 'POST') {
      const b = await parseBody(req).catch(() => ({}));
      if (b.dryRun) return json(res, await evalSession(b.sessionId, { dryRun: true, only: b.skillId || null }));
      const id = `eval-${Date.now()}`;
      evalResultsCache.set(id, { id, sessionId: b.sessionId, status: 'running' });
      evalSession(b.sessionId, { only: b.skillId || null })
        .then((r) => evalResultsCache.set(id, { id, sessionId: b.sessionId, status: 'done', ...r }))
        .catch((e) => evalResultsCache.set(id, { id, sessionId: b.sessionId, status: 'error', error: e.message }));
      return json(res, { started: true, id }, 202);
    }
    if (url.pathname === '/api/eval/results' && req.method === 'GET') {
      return json(res, [...evalResultsCache.values()]);
    }

    // ---- Promote (install into a Claude Code skills dir) ----
    if (url.pathname === '/api/promote' && req.method === 'POST') {
      const b = await parseBody(req);
      const r = b.skillId
        ? { results: [{ skillId: b.skillId, ...promoteSkill({ sessionId: b.sessionId, skillId: b.skillId, install: !!b.install, target: b.target, overwrite: !!b.overwrite }) }] }
        : promoteSession({ sessionId: b.sessionId, install: !!b.install, target: b.target });
      return json(res, r);
    }

    json(res, { error: 'Not found', endpoints: ['GET /', 'GET /health', 'GET /api/connectors', 'POST /api/connectors', 'POST /api/connectors/:id/{enable,disable,sync}', 'DELETE /api/connectors/:id', 'POST /api/research', 'GET /api/research/runs', 'GET /api/skills', 'GET /api/skills/:sessionId/:skillId', 'GET /jobs', 'POST /jobs/:id/run'] }, 404);
  } catch (err) {
    logger.error('Request error', { error: err.message });
    json(res, { error: err.message }, 500);
  }
}

// ============================================================================
// START
// ============================================================================
loadJobs();
const server = createServer(handleRequest);
server.listen(PORT, () => {
  logger.info(`Sink Job Server on :${PORT} — ${jobs.size} jobs loaded`);
  for (const [id, j] of jobs) {
    logger.info(`  ${id}: ${j.sessions.length} sessions, ${j.config.sources?.length || 0} sources, ${j.config.enabled ? 'ENABLED' : 'disabled'}`);
  }
});
