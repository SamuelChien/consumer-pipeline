# research-agent

The keystone of Skill Flywheel v2 (see `../../docs/skill-flywheel-v2.md`).

**Input:** one Claude Code session (from `deep-analysis.json`).
**Output:** multiple validated skills, grounded in real code/skills/infra.

Unlike the legacy one-shot generator (`claude -p --max-turns 1 --allowedTools none`),
this runs **claude-opus-4-8 as a multi-turn Claude Code agent with tools** so it
actually researches before writing: greps the skill libraries to dedupe, reads the
repos the session touched, runs read-only `gcloud` to understand infra, and
web-searches unknowns.

## Flow

```
session ──► extractBrief()        deterministic, no LLM
        │     goal / what-built / gaps / struggles / scripts run / repos / topics
        ▼
        buildResearchPrompt()     inject brief + research plan + output contract
        ▼
        claudeAgent()             opus-4.8, multi-turn, cwd=most-specific repo,
        │                          --add-dir skill libraries, read-only tools
        ▼
        extractSkillArray()       parse the final JSON array
        ▼
        validateSkill()           Nario SKILL.md contract (§6.4 of the doc)
        ▼
        output/research-skills/<sessionId>/<skill_id>/...  + manifest.json
```

## Usage

```bash
# See exactly what would run — no Claude spawned, $0
npm run research:dry

# Research the first real session into skills
npm run research

# A specific session / N sessions / all of them
node src/research-agent/index.js --session <sessionId>
node src/research-agent/index.js --limit 5
node src/research-agent/index.js --all
```

## Config (env)

| Var | Default | Purpose |
|---|---|---|
| `RESEARCH_MODEL` | `claude-opus-4-8` | agent model |
| `RESEARCH_MAX_TURNS` | `40` | agent turn budget |
| `RESEARCH_ALLOWED_TOOLS` | `Read Grep Glob WebSearch Bash(gcloud:*) Bash(cat:*) Bash(ls:*) Bash(rg:*) Bash(find:*)` | read-only research toolset |
| `RESEARCH_PERMISSION_MODE` | `bypassPermissions` | headless, no prompts |
| `RESEARCH_TIMEOUT_MS` | `1200000` | per-session cap (20 min) |
| `DEEP_ANALYSIS_PATH` | `<DEV_ROOT>/claude-sessions-pipeline/output/deep-analysis.json` | session input |
| `SKILLS_DIRS` | mega-skills-union + nario dev-skills | libraries to grep/dedupe |
| `DEV_ROOT` | `/Users/samuelchien/dev` | repo resolution root |
| `OUTPUT_DIR` | `./output` | where skills are written |

## Next in the flywheel

Generated skills are candidates. They still flow through:
- **Eval gate** — behavioral eval vs incumbent (task #4).
- **Promotion** — Nario registry, `edited_by: pipeline` (task #5).

The agent is **read-only** during research; it never writes skills itself — the
orchestrator persists the validated JSON it returns.
