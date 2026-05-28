# Skill Flywheel: Handoff and Runbook

Last updated: 2026-05-28. Branch: `skill-flywheel-v2` (commit `ce9787a`, pushed, not merged to `main`).

This document is the single source of truth for what was built, how it works, how to run each
step (with real observed output), every code pointer, the learnings, and what is unfinished.

---

## 0. One-paragraph summary

This pipeline turns your **Claude Code sessions into new Claude Code skills**. A deterministic step
extracts a "brief" from a session (goal, gaps, struggles, scripts run, repos). A multi-turn
**Opus 4.8** Claude Code agent then researches (reads the real code, greps the skill library, runs
read-only `gcloud`, web-searches) and emits **multiple grounded skills** for that one session. An
optional **eval gate** (skill-bench) tests each skill, and **promote** installs the keepers into a
skills directory. Everything lives in `consumer-pipeline/`. It produces **Claude Code skills, not
Nario bundles** (that was an early wrong assumption, since corrected).

Flow: `connectors (sinks) -> session intelligence -> research agent -> eval gate -> promote`, with a web UI over all of it.

---

## 1. Core design ideas (the parts that matter)

1. **The research agent does real research.** The legacy generator was one shot:
   `claude -p --max-turns 1 --allowedTools none` (see the old code path in `src/server.js` `runJob()`
   and `src/shared/claude-cli.js` `claudeJSON`). The new agent (`claudeAgent()`) runs Claude Code as a
   genuine multi-turn agent, cd'd into the session's repo with the skill libraries added via `--add-dir`,
   allowed to Read / Grep / Glob / WebSearch / read-only Bash. It dedupes against existing skills, reads
   the actual code for real commands and paths, then returns a JSON array of skills. This is why output is
   specific, not generic.

2. **The gap that created a skill becomes the eval that gates it.** For each skill we synthesize a
   skill-bench task from the exact session struggle, then run the candidate skill WITH vs a baseline
   WITHOUT, and promote only if it helps. The idea is wired but the gate is not yet producing signal
   (see Section 9, TODO #1).

3. **Scope: Claude Code skills, not Nario.** Output is standard `SKILL.md` (name + description +
   optional allowed-tools). Eval uses skill-bench's generic CLI sampler. Promote means copying into a
   skills directory. The design doc (`docs/skill-flywheel-v2.md`) still contains Nario sections; they
   are superseded and flagged with a banner at the top of that file.

4. **Cheap to expensive cascade, dry by default.** Gap extraction uses no LLM. Generation batches with
   a cached prefix. Eval (expensive) runs only when asked. Promote is dry unless `--install`. The
   default promote target is a safe local dir, never your live `~/.claude/skills`.

---

## 2. Architecture and data flow

```
PRODUCERS (connectors/sinks)        INTELLIGENCE              RESEARCH                 GATE                  PROMOTE
────────────────────────────       ────────────             ────────                 ────                  ───────
local claude sessions ┐                                  research-agent:          eval-gate:            promote:
github repo           ┼─ claude-sink ─► Pub/Sub ─► [substrate]   opus-4.8 multiturn ─► skill-bench       install into a
skills folder         ┘  (sessions/    consumers:    reads code, greps      WITH skill vs        Claude Code skills
                          skills/code)  Chroma/Neo4j/ skills, gcloud,        baseline WITHOUT     dir (dry by default;
                                        ClickHouse/   websearch              on a task synth'd    SKILLS_TARGET_DIR
                                        wiki          1 session → N skills   from the struggle    to go live)
                                          │
                          claude-sessions-pipeline ─► deep-analysis.json (the research agent's actual input)
                                                              ▲
                          flywheel.js chains research → eval → promote in one command
                          server.js + web/index.html wrap everything in a browser UI
```

- The **substrate** (Chroma vectors/chunks, Neo4j graph/relationships, ClickHouse analytics, wiki
  context-articles) already existed as 6 Pub/Sub consumers under `src/consumers/`. That is the
  "chunks, vectors, graph, context articles" from the original artifact list. We did not modify it.
- The research agent's actual input is `deep-analysis.json`, produced by `claude-sessions-pipeline`.
  Fields it uses: `deep.userGoal`, `deep.whatTheyBuilt`, `deep.fundamentalSkillsNeeded[]`,
  `deep.struggles[]`, `deep.problems[]`, `deep.orchestrationPattern`, `shallow.commands.topBinaries`
  (scripts run), `shallow.toolUsage`, `shallow.repos[]`, `shallow.topics[]`.

---

## 3. Repositories and how they relate

All under `/Users/samuelchien/dev/`.

| Repo | Role | We |
|---|---|---|
| `consumer-pipeline` | Everything we built. The flywheel. | built |
| `claude-sink` | Ingestion CLI: `skills <dir>` / `sessions [dir]` / `code <dir>` to Pub/Sub. | read only |
| `claude-sessions-pipeline` | Produces `output/deep-analysis.json` (session intelligence). | read its output |
| `skill-bench` | Eval harness (Python, click CLI + FastAPI service). | read, installed in venv |
| `mega-skills-directory/mega-skills-union` | Skill library the agent greps for dedupe + relationships. | read by the agent |
| `nario` | NOT part of this pipeline. Deliberately decoupled. | not used |

---

## 4. Code map (every file we added or changed)

Base path: `/Users/samuelchien/dev/consumer-pipeline/`. For our files use the symbol pointers (stable
across edits); for skill-bench, line numbers are exact (read directly).

### Research agent (the keystone)
- `src/research-agent/schema.js`
  - `SKILL_OUTPUT_CONTRACT` (the exact JSON the agent must emit; standard Claude Code skill format)
  - `validateSkill()`, `normalizeSkill()`, `extractSkillArray()` (robust JSON extraction from agent text)
- `src/research-agent/extract-brief.js`
  - `loadSessions()`, `isRealSession()`, `resolveRepos()`, `skillDirs()`, `extractBrief()`
  - Deterministic, no LLM. Maps deep-analysis fields into the research brief.
- `src/research-agent/prompts.js`
  - `buildResearchPrompt(brief, {skillDirs})` (research plan + brief + output contract)
- `src/research-agent/index.js`
  - `researchSession(session, {dryRun, dirs})` -> `{brief, skills, rejected, meta}`
  - `writeResult(result, outRoot)` -> writes `output/research-skills/<sid>/<skill_id>/...` + `manifest.json`
  - CLI: `--session`, `--limit`, `--all`, `--dry-run`, `--out`
- `src/research-agent/README.md` (module usage)

### Agent runner
- `src/shared/claude-cli.js`
  - `claudeAgent(prompt, opts)` (NEW): multiturn, `--model`, `--max-turns`, `--output-format json`,
    `--permission-mode bypassPermissions`, `--allowedTools` whitelist, `--add-dir`, `cwd`, `dryRun`.
    Parses the json envelope: `{result, meta:{num_turns,total_cost_usd,usage,session_id}}`.
  - `claudeGenerate()`, `claudeJSON()` (original one-shot, kept for the legacy job-runner)

### Connectors (sinks / producers)
- `src/connectors/types.js` -> `CONNECTOR_TYPES` (local-claude-sessions, github-repo, skills-folder),
  producer model `{kind:user|team|tenant, id}`, `validateConnector()`, `catalog()`
- `src/connectors/registry.js` -> JSON store at `data/connectors.json`; `list/get/add/update/setEnabled/remove`,
  `anyEnabled()`, `enabledConnectors()`
- `src/connectors/sink.js` -> `planSink()`, `describeSink()`, `runSink()` (dispatches to `claude-sink`)
- `src/connectors/index.js` -> public API + CLI + `sync({id, plan, dryRunSink})`

### Eval gate
- `src/eval-gate/synthesize-suite.js` -> `synthesizeTask(brief, skill)` (skill-bench task: 1 user turn +
  one `llm_judge` assertion), `writeSuite()`
- `src/eval-gate/index.js` -> `evalSkill()` (candidate WITH vs baseline WITHOUT), `evalSession()`,
  `parseScore()`, CLI `--session/--skill/--dry-run`

### Promote
- `src/promote/index.js` -> `promoteSkill()`, `promoteSession()` (install into a skills dir; dry unless
  `install:true`; default target `output/promoted-skills`, override with `SKILLS_TARGET_DIR`), CLI

### One command
- `src/flywheel.js` -> chains research -> eval -> promote; `skillBenchAvailable()` auto-detects eval

### Web
- `src/server.js` -> extended the pre-existing job-server. New helpers: `sendHtml`, `renderUI`,
  `startResearch`, `listResearchSkills`, `readResearchSkillFile`. New routes: `GET /`,
  `/api/connectors*`, `/api/research*`, `/api/skills*`, `/api/eval`, `/api/promote`.
- `src/web/index.html` -> single-page UI (connectors with enable/disable + the "enable a sink" banner,
  run panel, skill browser with a SKILL.md viewer, per-skill "eval (dry)" and "install" buttons)

### Docs
- `docs/skill-flywheel-v2.md` -> design doc (Nario sections superseded; banner at top)
- `docs/HANDOFF.md` -> this file

Pre-existing, not ours: `src/consumers/*` (the substrate), `src/shared/{config,logger,metrics,health,
chunker,pubsub-consumer,store-clients}.js`, `src/index.js`, the legacy job-runner inside `server.js`.

---

## 5. Runbook: command + real output for each step

All commands from `/Users/samuelchien/dev/consumer-pipeline`.

### Step A. See what the agent would run (free, no Claude spawned)
```bash
npm run research:dry
# or: node src/research-agent/index.js --dry-run --limit 2
```
Observed output (trimmed):
```
[research-agent] 2 session(s) | model=claude-opus-4-8 | skillDirs=2 | DRY-RUN

── 6bb69f7b-a0f2-4047-804a-9c55b5fb1928 ──
   goal: Connect to Gmail to clean up promotional/junk emails, install 5,200+ skills ...
   gaps: 4 | struggles: 2 | repos: ...skills-intelligence-pipeline
   cwd: ~dev/skills-intelligence-pipeline
   cmd: /usr/local/bin/claude -p --model claude-opus-4-8 --max-turns 40 --output-format json
        --permission-mode bypassPermissions
        --allowedTools "Read Grep Glob WebSearch Bash(gcloud:*) Bash(cat:*) Bash(ls:*) Bash(rg:*) Bash(find:*)"
        --add-dir ~dev/mega-skills-directory/mega-skills-union --add-dir ~dev/nario/.claude/dev-skills
```

### Step B. Research one session live (Opus 4.8 multiturn)
```bash
npm run research                                  # first real session
# or: node src/research-agent/index.js --session <id>
```
Observed output:
```
   ✓ 6 skill(s) | turns=15 | $1.810
   → output/research-skills/6bb69f7b-a0f2-4047-804a-9c55b5fb1928
      • bm25-pagerank-corpus-index — Build and tune a BM25 + PageRank + IDF composite ...
      • enrich-skill-metadata-bulk [mutates] — ...
      • evaluate-skill-corpus-quality — ...
      • run-skills-intelligence-pipeline — ...
      • gmail-bulk-triage-mcp — ...
      • skills-at-scale-architecture — ...
```
Real run metrics from `manifest.json` `meta`:
```
num_turns: 15   total_cost_usd: 1.81
usage: input 60969, output 16646, cache_creation 102488, cache_read 892729   (heavy cache reuse)
```
Output artifacts written: `output/research-skills/<sid>/<skill_id>/SKILL.md` for each skill, plus
`output/research-skills/<sid>/manifest.json` (brief + meta + skills index + any rejected).

Example of the quality (excerpt of `bm25-pagerank-corpus-index/SKILL.md`). Note it pulled REAL
internals from the session's actual `build-index.py`:
```
| BM25 | 0.35 | text match on name/desc/tags/body |
BM25 uses k1=1.2, b=0.75 and field boosts name=3.0, tags=2.5, description=2.0, body=1.0 ...
Sanity gate: if graph_edges is ~0 or with_refs is near 0%, every PageRank score will be 0 ...
- ModuleNotFoundError: yaml -> pip3 install pyyaml.   (this was literally the session's error)
```

### Step C. Connectors (sinks)
```bash
npm run connectors catalog
npm run connectors -- add --type skills-folder --producer-kind user --producer-id samuel --config path=/Users/samuelchien/dev/mega-skills-directory/mega-skills-union
npm run connectors enable skills-folder--user-samuel
npm run connectors list
npm run connectors sync --plan
```
Observed `list` (note the gate when nothing is enabled):
```
○ local-claude-sessions--user-samuel   type=... producer=user:samuel status=idle
⚠ No connector enabled. Enable one before running the pipeline: connectors enable <id>
```
Observed `sync --plan` (emits the correct claude-sink commands, verified against its real CLI):
```
▸ local-claude-sessions--user-samuel:
    node ~dev/claude-sink/dist/index.js sessions /Users/samuelchien/.claude --pubsub blobfish-ai-429200
▸ skills-folder--user-samuel:
    node ~dev/claude-sink/dist/index.js skills ~dev/mega-skills-directory/mega-skills-union --pubsub blobfish-ai-429200
```

### Step D. Eval gate (dry, free)
```bash
npm run eval-gate -- --session 6bb69f7b-a0f2-4047-804a-9c55b5fb1928 --dry-run
```
Observed output (per skill it builds an isolated skills mount + a synthesized task, then prints the
two skill-bench commands):
```
▸ bm25-pagerank-corpus-index
    skill-bench run .../bm25-pagerank-corpus-index/tasks --skills .../bm25-pagerank-corpus-index/skills --model claude-sonnet-4-6 --output .../with --sampler cli
    skill-bench run .../bm25-pagerank-corpus-index/tasks --model claude-sonnet-4-6 --output .../baseline --sampler cli
```
The synthesized task YAML (valid skill-bench schema, written under `output/eval/<sid>/<skill>/tasks/`):
```yaml
id: gap-run-skills-intelligence-pipeline
turns:
  - role: user
    content: >-
      ... Specifically, help me with: Python scripting for data pipelines ... first-run
      pyyaml failure. I keep getting stuck on: Skills organization at scale.
assertions:
  - type: llm_judge
    target: >-
      Evaluate whether the assistant resolved the task ... Score 1.0 only if ... real
      commands/flags/paths and error handling ... NOT generic advice. ...
    weight: 1
```

### Step E. Promote (dry, then install)
```bash
npm run promote -- --session 6bb69f7b-a0f2-4047-804a-9c55b5fb1928            # dry plan
npm run promote -- --session 6bb69f7b-a0f2-4047-804a-9c55b5fb1928 --skill bm25-pagerank-corpus-index --install
```
Observed install:
```
✓ bm25-pagerank-corpus-index → output/promoted-skills/bm25-pagerank-corpus-index
```

### Step F. The whole thing, one command
```bash
# eval auto-detected; reuse skips re-paying for research; install copies passers
SKILL_BENCH_CMD=/tmp/sb-venv/bin/skill-bench npm run flywheel -- --session 6bb69f7b-a0f2-4047-804a-9c55b5fb1928 --reuse --install
```
Observed output (the honest result: eval scored everything 0, see Section 8):
```
[flywheel] 1 session(s) | research=opus-4.8 | eval=on | promote=INSTALL
══ 6bb69f7b-a0f2-4047-804a-9c55b5fb1928 ══
  research: reused 6 skill(s)
  eval: 0/6 pass
     · bm25-pagerank-corpus-index: with=0 base=0 margin=0 → reject
     · enrich-skill-metadata-bulk: with=0 base=0.05 margin=-0.05 → reject
     ...
     (none passed eval)
[flywheel] done — 6 skills, 0 installed, ~$0.00
```
With eval OFF (the working value path today), all 6 install:
```bash
node src/flywheel.js --session 6bb69f7b-a0f2-4047-804a-9c55b5fb1928 --reuse --no-eval --install
# [flywheel] done — 6 skills, 6 installed, ~$0.00
```

### Step G. Web UI
```bash
npm run serve        # http://localhost:8080  (PORT env to change)
```
Verified endpoints: `GET /` (UI), `GET /api/connectors`, `GET /api/skills`,
`GET /api/skills/:sid/:skillId`, `POST /api/research`, `GET /api/research/runs`,
`POST /api/eval`, `POST /api/promote`.

### Step H. Go live (make the skills real Claude Code skills)
```bash
SKILLS_TARGET_DIR=~/.claude/skills node src/flywheel.js --session <id> --reuse --no-eval --install
```
Be deliberate: this drops skills next to your 5000+ existing ones (watch name collisions).

---

## 6. The skills produced (from session 6bb69f7b)

| skill_id | what it does | mutates |
|---|---|---|
| `bm25-pagerank-corpus-index` | build/tune a BM25 + PageRank + IDF index over a markdown skill corpus | no |
| `enrich-skill-metadata-bulk` | backfill refs/categories/tags across a skill corpus | yes |
| `evaluate-skill-corpus-quality` | find low-quality stubs/duplicates at scale | no |
| `run-skills-intelligence-pipeline` | run + maintain the enrich+index pipeline (handles the pyyaml first-run failure) | yes |
| `gmail-bulk-triage-mcp` | bulk inbox triage via Gmail MCP with task-scoping | yes |
| `skills-at-scale-architecture` | progressive disclosure + metadata + discovery patterns | no |

These 6 were generated BEFORE the schema fix, so their frontmatter carries a few extra fields
(category/tags/refs/mutates). They are valid Claude Code skills. A fresh `npm run research` now emits
the cleaner name+description(+allowed-tools) form.

---

## 7. Learnings (deep, so nobody re-discovers these)

### Research agent
- Running Claude Code as a **multi-turn agent with tools** (not one-shot) is what produces grounded
  skills. Proof: the bm25 skill cited the real `build-index.py` constants and the session's real errors.
- `claudeAgent()` invocation: `-p --model claude-opus-4-8 --max-turns 40 --output-format json
  --permission-mode bypassPermissions --allowedTools "<read-only whitelist>" --add-dir <skill libs>`,
  with `cwd` set to the most specific repo. The agent is read-only; it returns a JSON array as its final
  message, and the orchestrator (not the agent) writes files. This keeps it safe and deterministic.
- `--permission-mode` valid values (from `claude --help`): `acceptEdits, auto, bypassPermissions,
  default, dontAsk, plan`. In headless `-p` mode the `--allowedTools` whitelist is the real guardrail.
- The json envelope from `--output-format json` carries `result`, `num_turns`, `total_cost_usd`,
  `usage` (incl. cache token counts). Use it for cost/observability.
- We prefer the most specific repo as `cwd` and keep the bare dev root out of `--add-dir` so the agent
  stays focused and cheap (`researchSession()` in `src/research-agent/index.js`).

### claude-sink (verified CLI, do not guess)
- `skill-bench`... no: `claude-sink` subcommands (from `claude-sink/src/cli.ts:22, 52, 84`):
  `skills <dir>`, `sessions [dir]` (default `~/.claude`), `code <dir>`; all take `--pubsub <project>`
  and `--dry-run`. Source dir is a positional argument.

### skill-bench (verified, and the eval gotcha)
- CLI entry `engine.cli:main`; `run` command at `engine/cli.py:75`: positional `tasks_dir`,
  `--skills/-s <dir>`, `--model/-m`, `--output/-o`, `--sampler cli|deployment`, `--deployment-url`.
- Task YAML schema (`engine/loader.py:32` + `engine/models.py`): `id, name, description,
  turns[].{role,content}, assertions[].{type,target,expected,weight}, setup, timeout_seconds, model`.
  For `llm_judge`, `target` is the judge prompt.
- There are TWO scorers. The CLI `run` path uses `service/scorer.py:score_conversation` (cli.py:148),
  NOT `engine/scorer.py:Scorer`. `compute_overall` (`engine/models.py:122`) DOES count the judge.
- **The eval failure root cause:** `service/scorer.py:_detect_infra_error` (line 136) returns early with
  EMPTY `assertion_results` and `judge_results` when the conversation has an error or an empty
  `assistant_response`. That early return yields `overall_score 0` and `assertions_total 0`, which is
  exactly the shape we saw in `output/eval/.../summary.json` (`{"avg_score":0,"tasks":[{"score":0,
  "assertions_passed":0,"assertions_total":0}]}`). So the local CLI sampler returned empty responses,
  every run was flagged an infra error, and the judge never ran. Not the skills, not our wiring.

### Token economics (observed)
- Gap extraction is LLM-free. The Opus run reused ~893k cache-read tokens vs ~61k fresh input, so the
  expensive part is bounded. Cascade cheap to expensive: research (per session) -> eval (on demand) ->
  hill-climb (not used yet).

### Safety decisions
- Promote is dry by default; default target is `output/promoted-skills` (gitignored), never
  `~/.claude/skills` without an explicit `SKILLS_TARGET_DIR`.
- The research agent never writes skills itself; it only returns JSON that the orchestrator persists.

### Gotchas hit during the build
- zsh: `grep --include=*.py` fails on "no matches"; quote it (`--include="*.py"`).
- The Read tool deduplicates on background task output files; use `tail` on the log path instead.
- `shallow.repos[]` often includes the bare dev root; we sort for the deepest repo as `cwd`.
- `output/` and `data/` are gitignored, so runtime artifacts and `connectors.json` are never committed.
- Scope lesson: do not assume the promotion target. This pipeline targets Claude Code skills; the early
  Nario assumption was wrong and had to be unwound (schema, eval sampler, promote).

---

## 8. Status: verified vs not

| Piece | Status |
|---|---|
| Research agent | Verified live (6 grounded skills, 15 turns, $1.81) |
| Connectors | Verified (catalog/add/enable/anyEnabled/sync --plan) |
| Web UI | Verified (all routes serve) |
| Promote | Verified live (6 installed) |
| Flywheel | Verified live end to end |
| Eval gate | Wiring verified; live run scored 0/6 due to skill-bench CLI sampler returning empty responses (infra-error path). No real signal yet. |

---

## 9. TODO and unfinished (priority order)

1. **Eval gate produces no signal (blocker).** Fix: add `--sampler deployment` + URL/env to
   `src/eval-gate/index.js` and point at the running skill-bench Cloud Run service (auto-proxied on
   `:8111`, project `narioai`), or debug the local CLI sampler's headless `claude` call. Until then,
   promotion cannot be gated.
2. **Calibrate thresholds** once eval works (`EVAL_PASS=0.8`, `EVAL_MARGIN=0.1` are guesses).
3. **Merge** the PR to `main` (currently only on `skill-flywheel-v2`).
4. **Multi-producer is modeled, not wired.** Connectors carry `producer:{kind,id}`, but research and
   gap-ranking do not use it for team-wide ranking, per-producer partitioning, or sink-side
   **redaction** (required before ingesting other engineers' sessions). Design-doc phase P3.
5. **Sinks not run live.** Only `sync --plan` is verified. Real ingestion
   (sessions -> Pub/Sub -> substrate -> deep-analysis) relies on `claude-sink` +
   `claude-sessions-pipeline`, which were not re-run; the agent reads the existing `deep-analysis.json`.
6. **No dedicated "memories" store.** Substrate covers chunks/graph/wiki; a memory store was not added.
7. **skill-bench is installed in `/tmp/sb-venv`** (ephemeral). Install properly or set `SKILL_BENCH_CMD`.
8. **Cosmetic:** flywheel prints "skill-bench not installed" even when `--no-eval` is passed.
9. **Refreshing the input** (re-running `claude-sessions-pipeline` to get new sessions) is a separate
   step not wired into `flywheel`.

---

## 10. Config reference (environment variables)

| Var | Default | Used by |
|---|---|---|
| `RESEARCH_MODEL` | `claude-opus-4-8` | research agent |
| `RESEARCH_MAX_TURNS` | `40` | research agent |
| `RESEARCH_ALLOWED_TOOLS` | read-only whitelist | research agent |
| `RESEARCH_PERMISSION_MODE` | `bypassPermissions` | research agent |
| `RESEARCH_TIMEOUT_MS` | `1200000` | research agent |
| `DEEP_ANALYSIS_PATH` | `<DEV_ROOT>/claude-sessions-pipeline/output/deep-analysis.json` | extract-brief |
| `SKILLS_DIRS` | mega-skills-union + nario dev-skills | extract-brief (libraries to grep) |
| `DEV_ROOT` | `/Users/samuelchien/dev` | repo resolution |
| `OUTPUT_DIR` | `./output` | all outputs |
| `CONNECTORS_FILE` | `./data/connectors.json` | connectors registry |
| `SINK_BIN` | `<DEV_ROOT>/claude-sink/dist/index.js` | connectors sink |
| `PROJECT_ID` | `blobfish-ai-429200` | connectors sink (Pub/Sub) |
| `CONNECTOR_CLONE_ROOT` | `<DEV_ROOT>/.connector-clones` | github-repo connector |
| `SKILL_BENCH_CMD` | `skill-bench` | eval gate |
| `EVAL_MODEL` | `claude-sonnet-4-6` | eval gate |
| `EVAL_PASS` | `0.8` | eval gate (candidate must clear) |
| `EVAL_MARGIN` | `0.1` | eval gate (must beat baseline by) |
| `EVAL_TASK_TIMEOUT` | `300` | eval gate (per task) |
| `SKILLS_TARGET_DIR` | `<OUTPUT_DIR>/promoted-skills` | promote (set to `~/.claude/skills` to go live) |
| `PORT` | `8080` | web server |

---

## 11. Git and ship state

- Branch `skill-flywheel-v2`, commit `ce9787a` ("Add Skill Flywheel v2 ..."), 42 files, +3823/-639.
- Pushed to `github.com/SamuelChien/consumer-pipeline`. `main` untouched. PR not merged.
- The commit also snapshots prior uncommitted pipeline work (a Kafka -> Pub/Sub migration of the
  consumers) that was already in the working tree.

---

## 12. Appendix: the two contracts

### Claude Code skill output contract (what the agent emits)
See `src/research-agent/schema.js` `SKILL_OUTPUT_CONTRACT`. A JSON array of objects:
`{skill_id, description, allowed_tools?, addresses_gap?, related_skills?, research_notes?,
files:[{relative_path:"SKILL.md", content, executable?}]}`. The SKILL.md frontmatter is just
`name` + `description` (+ optional `allowed-tools`).

### skill-bench task contract (what eval synthesizes)
See `src/eval-gate/synthesize-suite.js`. A YAML with `id, name, description, model, timeout_seconds,
turns[].{role,content}, assertions[].{type:llm_judge, target:<judge prompt>, weight}`.
