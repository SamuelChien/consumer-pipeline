import { SKILL_OUTPUT_CONTRACT } from './schema.js';

const bullet = (arr, fmt = (x) => x) =>
  (arr && arr.length ? arr.map((x) => `  - ${fmt(x)}`).join('\n') : '  - (none)');

/**
 * Build the brief that drives the multi-turn Opus research agent.
 * The agent has Read/Grep/Glob/WebSearch + read-only Bash(gcloud) and operates
 * in the session's primary repo (cwd) with skill dirs added.
 */
export function buildResearchPrompt(brief, { skillDirs = [] } = {}) {
  const g = brief.gaps || [];
  const s = brief.struggles || [];

  return `You are a skill-synthesis RESEARCH AGENT. Your job: study ONE Claude Code session,
research deeply with your tools, then write MULTIPLE reusable skills that would have
made that session faster — and would help the next engineer who hits the same wall.

You are running as claude-opus-4-8 with real tools. Do NOT guess — investigate.

============================ SESSION BRIEF ============================
Session: ${brief.sessionId}  (project: ${brief.project}, outcome: ${brief.outcome})
Goal: ${brief.userGoal}
What they built: ${brief.whatTheyBuilt}
Project: ${brief.projectName || '?'} [${brief.projectType || '?'}]  tech: ${(brief.techStack || []).join(', ') || '?'}

Gaps (skills they lacked):
${bullet(g, (x) => `${x.skill}${x.category ? ` [${x.category}]` : ''}${x.reason ? ` — ${x.reason}` : ''}${x.urgency ? ` (${x.urgency})` : ''}`)}

Struggles / problems (the learning):
${bullet([...s, ...(brief.problems || [])], (x) => x.description || JSON.stringify(x))}

Scripts run: ${(brief.scriptsRun || []).join(', ') || '(none)'}
Tools used: ${(brief.toolsUsed || []).join(', ') || '(none)'}
Topics: ${(brief.topics || []).join(', ') || '(none)'}
Repos touched (you are CD'd into the first; others are --add-dir'd): ${(brief.repos || []).join(', ') || '(none)'}
Skill libraries available to grep: ${skillDirs.join(', ') || '(none)'}

============================ RESEARCH PLAN ============================
Use your tools. A good run does ALL of these before writing anything:

1. DEDUPE: Grep/Glob the skill libraries above for skills that already cover each
   gap. Read the closest matches. If one exists, EXTEND or reference it (related_skills)
   — do not re-create it.
2. GROUND IN CODE: Read the actual code in the repos for the goal/struggles. Capture
   REAL file paths, function names, commands, and the error handling that was needed.
3. UNDERSTAND THE SYSTEM: If infra/architecture is involved (GCP, Cloud Run, Pub/Sub,
   Mongo, k8s), run read-only \`gcloud\`/\`cat\` to confirm how it's actually wired.
4. RESEARCH UNKNOWNS: WebSearch any tool/API/error you're unsure about so steps are correct.
5. SYNTHESIZE: Turn each distinct capability into its own skill. One session -> several
   skills (e.g. a fundamental "how to X", an orchestration "when to chain X→Y→Z", and a
   concrete "run this exact command for Z").

============================ OUTPUT CONTRACT ============================
${SKILL_OUTPUT_CONTRACT}

Begin researching now. Remember: your FINAL message is ONLY the JSON array.`;
}
