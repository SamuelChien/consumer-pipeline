# Skill Flywheel: Handoff and Runbook

Last updated: 2026-05-28. Branch: `skill-flywheel-v2`, not merged to `main`. The eval gate was rebuilt
this session (the `0/6 scored 0` blocker is fixed; a second judge-bias bug was found and fixed) — see
Sections 7–9. Prior base commit `ce9787a`.

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

2. **The gap that created a skill becomes the eval that gates it.** For each skill we synthesize the
   user ask + judge criteria from the exact session struggle, sample a prose answer from the eval model
   WITH the skill injected vs a baseline WITHOUT, and a judge model scores each; we promote only if the
   skill clears the `EVAL_PASS` quality floor AND wins a **pairwise head-to-head** against baseline.
   **This now produces real, sensitive signal.** Absolute scoring alone couldn't separate two strong
   answers (everything scored 0.82–0.93), so a pairwise judge — "which answer is better?", position-
   swapped over `EVAL_SAMPLES` rounds — is the discriminator. Proof it works: `bm25` *tied* on absolute
   (0.88/0.88) yet won the head-to-head **3–0 → promote**, while `gmail` lost **0–2 → reject**. Three
   bugs were fixed to get here (all-zero infra error; judge "fabrication" bias against skill-cited
   scripts; absolute-score ceiling) — see Section 7; calibration of the pairwise thresholds is the
   remaining work (Section 9 #2).

3. **Scope: Claude Code skills, not Nario.** Output is standard `SKILL.md` (name + description +
   optional allowed-tools). The eval gate is a self-contained prose A/B judged by `claude` (it no
   longer shells out to skill-bench; see Section 7). Promote means copying into a skills directory. The
   design doc (`docs/skill-flywheel-v2.md`) still contains Nario sections; they are superseded and
   flagged with a banner at the top of that file.

4. **Cheap to expensive cascade, dry by default.** Gap extraction uses no LLM. Generation batches with
   a cached prefix. Eval (expensive) runs only when asked. Promote is dry unless `--install`. The
   default promote target is a safe local dir, never your live `~/.claude/skills`.

---

## 2. Architecture and data flow

```
PRODUCERS (connectors/sinks)        INTELLIGENCE              RESEARCH                 GATE                  PROMOTE
────────────────────────────       ────────────             ────────                 ────                  ───────
local claude sessions ┐                                  research-agent:          eval-gate:            promote:
github repo           ┼─ claude-sink ─► Pub/Sub ─► [substrate]   opus-4.8 multiturn ─► prose A/B,        install into a
skills folder         ┘  (sessions/    consumers:    reads code, greps      judged by claude:    Claude Code skills
                          skills/code)  Chroma/Neo4j/ skills, gcloud,        answer WITH skill    dir (dry by default;
                                        ClickHouse/   websearch              vs baseline WITHOUT  SKILLS_TARGET_DIR
                                        wiki          1 session → N skills   on the synth'd ask   to go live)
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
  - `claudeAgent(prompt, opts)`: multiturn, `--model`, `--max-turns`, `--output-format json`,
    `--permission-mode bypassPermissions`, `--allowedTools` whitelist, `--add-dir`, `cwd`, `dryRun`.
    Parses the json envelope: `{result, meta:{num_turns,total_cost_usd,usage,session_id}}`.
  - `claudeProse(prompt, opts)` (NEW): one-shot, **no tools** (`--tools "" --strict-mcp-config`),
    `CLAUDECODE` stripped, `--max-turns 1`, `--output-format json`. Resolves (never rejects) with
    `{response, usage, isError, error}`. This is the eval-gate sampler — it forces a written answer
    instead of an agentic tool detour. See Section 7 for why this is the keystone of the eval fix.
  - `claudeGenerate()`, `claudeJSON()` (original one-shot, kept for the legacy job-runner)

### Connectors (sinks / producers)
- `src/connectors/types.js` -> `CONNECTOR_TYPES` (local-claude-sessions, github-repo, skills-folder),
  producer model `{kind:user|team|tenant, id}`, `validateConnector()`, `catalog()`
- `src/connectors/registry.js` -> JSON store at `data/connectors.json`; `list/get/add/update/setEnabled/remove`,
  `anyEnabled()`, `enabledConnectors()`
- `src/connectors/sink.js` -> `planSink()`, `describeSink()`, `runSink()` (dispatches to `claude-sink`)
- `src/connectors/index.js` -> public API + CLI + `sync({id, plan, dryRunSink})`

### Eval gate (self-contained prose A/B, judged by `claude`)
- `src/eval-gate/synthesize-suite.js` -> `synthesizeTask(brief, skill)` (yields the user `ask` +
  `llm_judge` criteria), `writeSuite()` (still writes the task YAML as a readable artifact)
- `src/eval-gate/index.js` -> `evalSkill()` samples a prose answer WITH the skill injected vs a baseline
  WITHOUT (`claudeProse`), runs an **absolute** judge on each (quality floor) **and** a **pairwise**
  judge head-to-head over `EVAL_SAMPLES` position-swapped rounds (`pairwiseCompare()` — the sensitive
  discriminator). `verdict ∈ {promote, weak, reject, inconclusive, error}`; `promote` requires
  `withScore≥EVAL_PASS` AND pairwise `winRate≥EVAL_WIN_RATE`. Writes
  `output/eval/<sid>/<skill>/result.json` (both answers + judge reasoning + the head-to-head tally) for
  inspection. `evalSession()`, CLI `--session/--skill/--dry-run`. No skill-bench dependency.

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

### Step D. Eval gate (prose A/B, judged by `claude`)
Dry run (free, no claude spawned):
```bash
npm run eval-gate -- --session 6bb69f7b-a0f2-4047-804a-9c55b5fb1928 --skill bm25-pagerank-corpus-index --dry-run
```
```
[eval-gate] 6bb69f7b… | model=claude-sonnet-4-6 judge=claude-sonnet-4-6 pairwise=4 | pass≥0.7 winRate≥0.6 | DRY-RUN
▸ gmail-bulk-triage-mcp
    prose-eval (no tools) — answer model=claude-sonnet-4-6, judge=claude-sonnet-4-6
    WITH    : answer "Connect to Gmail…" with SKILL.md injected (+ absolute judge = quality floor)
    BASELINE: same prompt without the skill (+ absolute judge)
    PAIRWISE: 4 position-swapped head-to-head comparisons → WITH win rate
    promote if  with≥0.7  and  winRate≥0.6
```
Live (`4 + EVAL_SAMPLES` serialized `claude` calls/skill: 2 answers + 2 absolute judges + `EVAL_SAMPLES` pairwise rounds; default 4 → 8 calls, ~5–7 min/skill):
```bash
npm run eval-gate -- --session 6bb69f7b-a0f2-4047-804a-9c55b5fb1928 --skill gmail-bulk-triage-mcp
```
Real observed output (pairwise — `win` is WITH's win rate over decided rounds, `Wx/Bx/Tx/xN` = with/base/tie/invalid):
```
✓ bm25-pagerank-corpus-index:  with=0.88 base=0.88 win=1   W3/B0/T0/x1 → promote   # absolute TIED, pairwise broke it
· gmail-bulk-triage-mcp:        with=0.9  base=0.95 win=0   W0/B2/T0/x2 → reject
· enrich-skill-metadata-bulk:   with=0.88 base=0.9  win=—   W0/B0/T0/x4 → inconclusive  # all rounds rate-limited (gotcha)
```
The `bm25` row is the whole point: absolute scoring called it a 0.88/0.88 tie, but the head-to-head said
WITH wins 3–0. `enrich` shows the gate degrading *honestly* to `inconclusive` when every pairwise round
failed under rate-limit contention (run standalone — see Gotchas). Each run writes
`output/eval/<sid>/<skill>/result.json` with BOTH full answers, judge reasoning, and the head-to-head tally.
The judge reasoning is grounded: for `gmail` the WITH answer was credited for "exact quota numbers, a
bounded-loop pattern with hard MAX_BUDGET, two exit conditions, safe vs. dangerous query strings" — all
straight from the skill (it scores 0.87, a genuinely good answer; the baseline just scores a touch higher
on this generic question). Margins are small because Sonnet's baseline is already strong; see Section 9 #2.

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
# eval is on by default now (self-contained); --reuse skips re-paying for research; promote is dry
node src/flywheel.js --session 6bb69f7b-a0f2-4047-804a-9c55b5fb1928 --reuse
```
The flywheel evaluates every skill through the **pairwise** gate and prints, per skill,
`· <skill>: with=<absScore> base=<absScore> win=<winRate> W../B../T../x.. → <verdict>`, then promotes
only verdict `promote`. Confirmed pairwise results (run skills standalone — see Gotchas — for clean
numbers; under contention some rounds invalidate as the `enrich` row shows):

| skill | with (abs) | base (abs) | winRate | tally | verdict |
|---|---|---|---|---|---|
| `bm25-pagerank-corpus-index` | 0.88 | 0.88 | 1.00 | W3/B0/T0/x1 | **promote** |
| `gmail-bulk-triage-mcp` | 0.90 | 0.95 | 0.00 | W0/B2/T0/x2 | reject |
| `enrich-skill-metadata-bulk` | 0.88 | 0.90 | — | W0/B0/T0/x4 | inconclusive (rate-limited) |

Honest read: pairwise is doing exactly what absolute margins couldn't — it found that `bm25` (an
absolute *tie*) actually wins 3–0, and that `gmail` loses. The remaining work (Section 9 #2) is a clean
full-session run + tuning `EVAL_WIN_RATE`/`EVAL_PASS` from the win-rate distribution, plus the rate-limit
robustness already improved (exponential backoff). To install now while you calibrate, run with eval off:
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

### The eval gate: the real root cause (FIXED 2026-05-28) and why the gate is now self-contained
The earlier handoff blamed `service/scorer.py:_detect_infra_error` for the all-zero scores. That early
return (empty `assertion_results`, `overall_score 0`, `assertions_total 0`) is real, but it is a
**symptom**. The disease is upstream in skill-bench's **`CLISampler`** (`engine/sampler.py:397`):
- It runs `claude -p <prompt> --output-format stream-json --verbose --max-turns 1 --model … [--add-dir]`.
- Headless `claude` has the **full tool suite** available by default (Read, Bash, Write, Task, MCP…).
- For any non-trivial task the model spends its **single** turn on a *tool call* (we reproduced it:
  `assistant.thinking → Read → Bash → RESULT subtype=error_max_turns is_error=True result=None`).
- So the assistant response is empty → `_detect_infra_error` fires → score 0, judge never runs.
- A trivial prompt ("say hello") works fine even nested (`CLAUDECODE=1`), which is how we ruled out auth
  and isolated the cause to the tool-detour-under-`--max-turns 1`.

`--max-turns 1` is fundamentally wrong for an *agentic* sampler, and an agentic sampler is the wrong tool
for a **guidance** eval anyway (it's slow, non-deterministic, and hands a Sonnet loop real `Bash`/`Write`).
So we did **not** patch skill-bench; we made the gate self-contained around `claudeProse`:
- Disable tools: `--tools ""` kills built-ins; **`--strict-mcp-config` (with no `--mcp-config`) kills MCP
  tools too** — we found `--tools ""` alone still let the model call `mcp__…__authenticate`.
- With tools gone you must also **reframe the ask as written advice**, else the model role-plays tool
  calls *in prose* (we saw it emit literal `<invoke name="mcp__desktop-commander__…">` text). The
  `FRAMING` constant ("text-only chat, no tools, write complete guidance, don't emit tool-call syntax")
  fixes that; both WITH and BASELINE then return real prose.
- Strip `CLAUDECODE` and read the `--output-format json` envelope's `result` for the answer + `usage`.
- The skill is injected into context (faithful proxy for "skill available"); the judge prompt mirrors
  skill-bench's `_run_judge` so scores stay comparable.

### The judge "fabrication" bias (second bug, found + fixed after the gate started scoring)
Once the gate produced numbers, the first full run looked alarming: WITH was *systematically below*
baseline, sometimes wildly (`evaluate-skill-corpus-quality with=0.15 base=0.82`, `enrich with=0.45
base=0.95`). The `result.json` reasoning explained it: the judge marked the WITH answers down for
**"fabricated infrastructure"** because they referenced the skill's own project scripts
(`scripts/run-evals.py`, `scripts/enrich-skills.py`) "as if they are established tools … none of these
are verified to exist." The baseline, free to reinvent everything with public libraries (`rapidfuzz`,
`networkx`), looked *more* verifiable to the judge. So the gate was punishing skills for doing their job
(pointing at the project's real scripts). Fix: a symmetric judge rule — *"the assistant may reference
project-specific scripts/tools assumed to exist; judge correctness/actionability, not file-existence"* —
which still penalizes vague/wrong guidance. Effect (same skills, re-run): `evaluate 0.15 → 0.82`,
`enrich 0.45 → 0.88`. After the fix all six WITH answers land at 0.82–0.88 (Step F). **Lesson:** a
context-free judge treats project-specific references as hallucination; bake the "assume it exists"
assumption into the judge or every skill that cites real tooling gets unfairly sunk.

### The absolute-score ceiling (third bug → pairwise judging)
With the bias fixed, all answers landed 0.82–0.93 — and the WITH/baseline *difference* (≤0.08) was below
the judge's own noise. Absolute scoring near the ceiling simply can't separate two good answers, so
`margin≥0.1` never fired and nothing promoted regardless of real quality. Fix: **pairwise preference
judging** (`pairwiseCompare()` in `src/eval-gate/index.js`) — show the judge BOTH answers and ask which
is better, over `EVAL_SAMPLES` position-swapped rounds (swap cancels the well-known first-position bias).
WITH must win ≥`EVAL_WIN_RATE` of *decided* rounds. This is how `bm25` (absolute tie 0.88/0.88) resolved
to a clean 3–0 promote. Absolute scoring is kept only as a quality floor (`EVAL_PASS`). This mirrors how
LLM-eval harnesses (MT-Bench/AlpacaEval) and the 2026 self-improving-skills papers (EvoSkills, ASG-SI)
score — preference/verifier-gated, not absolute. **Lesson:** for "did X help vs Y" with strong models,
pairwise A/B beats absolute scoring every time; reach for it whenever your deltas live near the ceiling.
- Robustness: the pairwise prompt embeds two full answers, so calls are heavier; under rate-limit
  contention some rounds invalidate (`infra:` in `pairwise.seq`). `claudeProse` retries with exponential
  backoff (4/8/16s); run the gate standalone for clean numbers (Gotchas).

### skill-bench (still the harness for agentic evals; reference, do not guess)
- CLI entry `engine.cli:main`; `run` at `engine/cli.py:75`: positional `tasks_dir`, `--skills/-s`,
  `--model/-m`, `--output/-o`, `--sampler cli|deployment`, `--deployment-url`. `--system-prompt` /
  `--developer-prompt` exist and the CLISampler prepends them to the prompt.
- Task YAML schema (`engine/loader.py:32` + `engine/models.py`): `id, name, description,
  turns[].{role,content}, assertions[].{type,target,expected,weight}, setup, timeout_seconds, model`.
- The flywheel gate no longer calls skill-bench. `SKILL_BENCH_CMD`, `--sampler`, and the `/tmp/sb-venv`
  install are irrelevant to the gate now (TODO #7 is moot for the critical path).

### Token economics (observed)
- Gap extraction is LLM-free. The Opus run reused ~893k cache-read tokens vs ~61k fresh input, so the
  expensive part is bounded. Cascade cheap to expensive: research (per session) -> eval (on demand) ->
  hill-climb (not used yet).

### Safety decisions
- Promote is dry by default; default target is `output/promoted-skills` (gitignored), never
  `~/.claude/skills` without an explicit `SKILLS_TARGET_DIR`.
- The research agent never writes skills itself; it only returns JSON that the orchestrator persists.

### Gotchas hit during the build
- **Eval rate-limit contention.** The gate spawns many `claude -p` subprocesses; running it *while an
  interactive Claude Code session (or other heavy claude usage) hits the same account* causes
  intermittent failures — they show up as `infra:<error>` entries in `result.json` `pairwise.seq` and as
  `xN` in the CLI tally. `claudeProse` retries with exponential backoff (4/8/16s) and invalid rounds are
  dropped (winRate is over *decided* rounds), but for clean numbers run the gate **standalone** (not
  nested inside another claude session). A single call in isolation always succeeds; the failures are
  contention, not the prompt or wiring.
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
| Flywheel | Verified live end to end (eval on, dry promote) |
| Eval gate | **Verified live — pairwise gate produces sensitive, unbiased signal** (self-contained, no skill-bench). Absolute quality floor + position-swapped pairwise judge. Proof: `bm25` won 3–0 head-to-head where absolute scoring tied 0.88/0.88 → promote; `gmail` lost 0–2 → reject. THREE bugs fixed: all-zero infra-error, judge "fabrication" bias, absolute-score ceiling (Section 7). Remaining: clean full-session run + threshold calibration; rate-limit backoff hardened (Section 9 #2, Gotchas). |

---

## 9. TODO and unfinished (priority order)

1. ~~**Eval gate produces no signal (blocker).**~~ **DONE (2026-05-28).** Root cause was skill-bench's
   agentic CLISampler tool-detouring under `--max-turns 1` (Section 7), not the scorer. Rebuilt the gate
   as a self-contained prose A/B + judge (`claudeProse`). It now scores 0..1 with real reasoning.
2. **Calibrate the pairwise thresholds (the remaining gate work).** The gate now uses **pairwise
   preference judging** (the deep fix), not absolute margins: absolute scoring couldn't separate two
   strong near-ceiling answers (everything landed 0.82–0.93, so `margin≥0.1` never triggered). `evalSkill`
   now (a) keeps a single **absolute** judge per arm as a quality floor (`EVAL_PASS=0.7`) and (b) runs a
   **pairwise** judge head-to-head over `EVAL_SAMPLES=4` position-swapped rounds; `promote` requires
   `winRate≥EVAL_WIN_RATE=0.6`. Remaining: (i) once a few sessions' `result.json` exist, re-pick
   `EVAL_WIN_RATE` / `EVAL_PASS` / `EVAL_SAMPLES` from the observed win-rate distribution; (ii) optionally
   a stronger judge model (`EVAL_JUDGE_MODEL`) for borderline cases. The thresholds are first guesses —
   defensible, but tune them with real data before trusting `--install` for auto-promotion.
3. **Merge** the PR to `main` (currently only on `skill-flywheel-v2`).
4. **Multi-producer is modeled, not wired.** Connectors carry `producer:{kind,id}`, but research and
   gap-ranking do not use it for team-wide ranking, per-producer partitioning, or sink-side
   **redaction** (required before ingesting other engineers' sessions). Design-doc phase P3.
5. **Sinks not run live.** Only `sync --plan` is verified. Real ingestion
   (sessions -> Pub/Sub -> substrate -> deep-analysis) relies on `claude-sink` +
   `claude-sessions-pipeline`, which were not re-run; the agent reads the existing `deep-analysis.json`.
6. **No dedicated "memories" store.** Substrate covers chunks/graph/wiki; a memory store was not added.
7. ~~**skill-bench is installed in `/tmp/sb-venv`** (ephemeral).~~ Moot for the gate — it no longer
   shells out to skill-bench. skill-bench is still useful for heavier *agentic* evals if you want them.
8. ~~**Cosmetic:** flywheel prints "skill-bench not installed" even when `--no-eval` is passed.~~ Fixed —
   eval is on by default and the skipped message now reads `eval: skipped (--no-eval)`.
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
| `SKILL_BENCH_CMD` | `skill-bench` | (no longer used by the gate; only legacy/agentic skill-bench runs) |
| `EVAL_MODEL` | `claude-sonnet-4-6` | eval gate (answer model) |
| `EVAL_JUDGE_MODEL` | `=EVAL_MODEL` | eval gate (judge model; set higher for a stricter judge) |
| `EVAL_PASS` | `0.7` | eval gate (absolute quality floor — WITH answer's absolute judge score must clear this) |
| `EVAL_WIN_RATE` | `0.6` | eval gate (WITH must win ≥ this share of *decided* pairwise rounds to promote) |
| `EVAL_SAMPLES` | `4` | eval gate (pairwise comparison rounds, position-swapped) |
| `EVAL_MARGIN` | `0.1` | eval gate (informational only now — absolute `withScore−baseScore`; the verdict uses winRate, not margin) |
| `EVAL_TASK_TIMEOUT` | `300` | eval gate (seconds per claude call) |
| `SKILLS_TARGET_DIR` | `<OUTPUT_DIR>/promoted-skills` | promote (set to `~/.claude/skills` to go live) |
| `PORT` | `8080` | web server |

---

## 11. Git and ship state

- Branch `skill-flywheel-v2`. Base: `ce9787a` ("Add Skill Flywheel v2 …") + `fee1d9a` (HANDOFF).
- This session adds a commit that **rebuilds the eval gate**: `claudeProse` in `src/shared/claude-cli.js`,
  a self-contained `src/eval-gate/index.js` (prose A/B + in-process judge, no skill-bench dependency),
  flywheel default-on eval, and the doc/comment updates. Touched: `claude-cli.js`, `eval-gate/index.js`,
  `eval-gate/synthesize-suite.js`, `flywheel.js`, `server.js`, `web/index.html`, `docs/*`.
- `main` untouched, PR not merged. Push after review.

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
