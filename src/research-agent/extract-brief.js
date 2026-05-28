import fs from 'node:fs';
import path from 'node:path';

const DEV_ROOT = process.env.DEV_ROOT || '/Users/samuelchien/dev';

const DEFAULT_DEEP_ANALYSIS = path.join(
  DEV_ROOT,
  'claude-sessions-pipeline/output/deep-analysis.json',
);

/** Skill directories the research agent greps to find related/duplicate skills. */
export function skillDirs() {
  const fromEnv = process.env.SKILLS_DIRS;
  const candidates = fromEnv
    ? fromEnv.split(',').map((s) => s.trim())
    : [
        path.join(DEV_ROOT, 'mega-skills-directory/mega-skills-union'),
        path.join(DEV_ROOT, 'nario/.claude/dev-skills'),
      ];
  return candidates.filter((d) => d && fs.existsSync(d));
}

/** Load the deep-analysis sessions array (handles array or keyed object). */
export function loadSessions(file = process.env.DEEP_ANALYSIS_PATH || DEFAULT_DEEP_ANALYSIS) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(raw) ? raw : Object.values(raw);
}

/** A session is "real" if it has substance and a genuine goal. */
export function isRealSession(s) {
  const tokens = s?.shallow?.tokenUsage?.totalTokens ?? 0;
  const goal = s?.deep?.userGoal || '';
  if (tokens < 50) return false;
  if (!goal || /^(unknown|n\/a|placeholder|test)/i.test(goal)) return false;
  return true;
}

/** Map a session's touched repos to absolute dirs that exist on disk. */
export function resolveRepos(session, devRoot = DEV_ROOT) {
  const repos = session?.shallow?.repos || [];
  const names = repos
    .map((r) => (typeof r === 'string' ? r : r.path || r.name || r.repo || ''))
    .filter(Boolean);
  const dirs = [];
  for (const n of names) {
    const abs = path.isAbsolute(n) ? n : path.join(devRoot, path.basename(n));
    if (fs.existsSync(abs)) dirs.push(abs);
  }
  return [...new Set(dirs)];
}

const asList = (arr, map) => (Array.isArray(arr) ? arr.map(map).filter(Boolean) : []);

/**
 * Deterministic (no-LLM) extraction of everything the research agent needs:
 * what the user was trying to achieve, gaps/struggles (the learning), scripts
 * run, repos touched, topics. This is the cheap front-half of the pipeline.
 */
export function extractBrief(session, devRoot = DEV_ROOT) {
  const d = session.deep || {};
  const sh = session.shallow || {};

  return {
    sessionId: session.sessionId,
    project: session.project,
    outcome: d.sessionQuality?.outcome || sh.categories?.primary || 'unknown',
    complexity: sh.complexity?.level,

    // What they were trying to achieve
    userGoal: d.userGoal || '',
    whatTheyBuilt: d.whatTheyBuilt || '',
    projectName: d.projectContext?.projectName,
    projectType: d.projectContext?.projectType,
    techStack: d.projectContext?.techStack || [],

    // The learning: gaps, struggles, problems
    gaps: asList(d.fundamentalSkillsNeeded, (g) =>
      typeof g === 'string'
        ? { skill: g }
        : { skill: g.skill, category: g.category, reason: g.reason, urgency: g.urgency },
    ),
    struggles: asList(d.struggles, (s) => (typeof s === 'string' ? { description: s } : s)),
    problems: asList(d.problems, (p) =>
      typeof p === 'string' ? { description: p } : { description: p.description, severity: p.severity, resolved: p.resolved },
    ),
    orchestrationPattern: d.orchestrationPattern,

    // Scripts run / tools used (the "how")
    scriptsRun: asList(sh.commands?.topBinaries, (b) =>
      typeof b === 'string' ? b : `${b.binary} (${b.count})`,
    ),
    toolsUsed: asList(sh.toolUsage?.tools, (t) =>
      typeof t === 'string' ? t : `${t.name} (${t.count})`,
    ),
    topics: asList(sh.topics, (t) => (typeof t === 'string' ? t : t.topic)),
    filesAccessed: asList(sh.filesAccessed, (f) => (typeof f === 'string' ? f : f.path)).slice(0, 20),

    // Research targets
    repos: resolveRepos(session, devRoot),
  };
}
