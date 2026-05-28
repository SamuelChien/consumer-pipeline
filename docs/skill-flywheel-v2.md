# Skill Flywheel v2 — Design Doc

**Status:** Draft for review
**Date:** 2026-05-28
**Scope:** `consumer-pipeline` + `skill-bench` + `nario` (+ `claude-sink` / `claude-sessions-pipeline`)
**One-line:** Turn the single-engineer, file-output skill pipeline into a multi-producer flywheel where a skill is promoted **only when it beats the incumbent on a behavioral benchmark synthesized from the failures that motivated it.**

> **⚠ SCOPE CORRECTION (2026-05-28):** This pipeline produces **Claude Code skills**, NOT Nario tenant bundles — the two are kept separate. The Nario-specific sections below (decision **D3**, **§6.6**, the promotion half of **§8**, slice **#5 = promoteVersion**) are **superseded**:
> - **Output schema** = standard Claude Code `SKILL.md` (`name` + `description` + optional `allowed-tools`). No `mutates`/`parameters_summary`/`cancel_safe_points`/`expected_duration_seconds`.
> - **Eval (#4)** = skill-bench **generic `--sampler cli`** (candidate skill mounted WITH vs baseline WITHOUT), not `nario_sampler`/`nario_production`.
> - **Promote (#5)** = **install into a Claude Code skills directory** (`SKILLS_TARGET_DIR`, e.g. `~/.claude/skills`), not Mongo `promoteVersion()`.
>
> Still valid: the multi-producer model (§9), failure-derived benchmark synthesis (§8 first half), the behavioral-gate-beats-text-rubric principle, and the cheap→expensive cascade. As-built code lives in `consumer-pipeline/src/{research-agent,connectors,eval-gate,promote}` + `src/server.js` + `src/web/`.

---

## 1. TL;DR

Today we have a *personal* flywheel: Samuel's Claude sessions → frequency-counted gaps → LLM-generated skills → a text-quality score → **files written to `nario/.claude/dev-skills/`**. It works, but it has three gates that don't talk to each other and it's hardwired to one machine and one target.

v2 makes two structural changes; everything else is plumbing:

1. **One gate, behavioral.** A candidate skill earns promotion only by beating the current skill on a `skill-bench` suite that is auto-built from the exact session transcripts where someone struggled. The gap that creates a skill becomes the eval that promotes it.
2. **The producer becomes multi-tenant, exactly like the consumer (Nario) already is.** Nario's bundle schema already has `owner: {kind:'tenant'|'user'|'team'}`. We tag ingested sessions with the same `producer` identity, add `'pipeline'` to the `edited_by` enum, and promote through the *real* Mongo registry — atomic versioning, history, rollback, audit — instead of writing loose files.

The payoff: one engineer's hard session becomes a skill the whole team (and, for tenant-facing skills, the runtime) inherits — gated by "does it actually work better than what we had."

---

## 2. Where we are today

### 2.1 The four moving parts

| Repo | Role | Key files |
|---|---|---|
| `claude-sink` + `claude-sessions-pipeline` | Ingest sessions → `output/deep-analysis.json` (`deep.fundamentalSkillsNeeded[]`, `deep.struggles[]`, `deep.problems[]`, `deep.orchestrationPattern`) → Pub/Sub | `claude-sink/dist/index.js`, `claude-sessions-pipeline/output/deep-analysis.json` |
| `consumer-pipeline` | 5-phase orchestrator + 6 Pub/Sub consumers (Chroma / ClickHouse / Neo4j / wiki / skill-updater / eval) | `scripts/pipeline-run.js`, `src/shared/claude-cli.js` (`claudeJSON()`), `src/consumers/*` |
| `skill-bench` | Behavioral eval harness: YAML tasks, multi-turn runner, 11 assertion types + LLM-judge, hill-climb, A/B compare, FastAPI service | `engine/{runner,sampler,scorer,models}.py`, `tasks/*.yaml`, `service/{app,worker}.py`, `engine/nario_sampler.py`, `evals/nario_production.py` |
| `nario` | Multi-tenant runtime + Mongo skill registry, atomic promote, test/dry-run gates | `lib/server/skill-bundles/{bundle-model,version-model,promote,edit-pipeline,load-bundles}.ts`, `lib/server/tenants/bundles.ts`, `.claude/dev-skills/ORCHESTRATION.md` |

### 2.2 Current end-to-end (`scripts/pipeline-run.js`)

```
INGEST   claude-sink → Pub/Sub (sink-sessions/skills/code-analyzed)
ANALYZE  read deep-analysis.json → gaps[skill] = freq count → 6 hardcoded themes → pipeline-context.json
GENERATE per theme, batch 3 gaps → claudeJSON() → output/generated-skills/{type}/{id}.md
EVAL     per skill, claudeJSON() scores 0–100 on 5 text dims → revise loop (≤10) → verdict
PROMOTE  score ≥ 70 → write nario/.claude/dev-skills/{id}/{SKILL.md,run.sh,evals,tests} + symlink
```

### 2.3 The core problem: three gates that don't talk

1. **consumer-pipeline Phase 4** scores the *skill text* (actionability, completeness, specificity…). It never runs the skill.
2. **skill-bench** measures whether the skill *actually works* on multi-turn tasks — but nothing routes candidates through it before they ship.
3. **Nario `promoteDraft`** (`edit-pipeline.ts`) gates on `TESTS_FAILED` / `DRY_RUN_FAILED` — binary structural checks, no eval score, no "beats baseline."

So "eval-gated promotion" is aspirational. Generated skills land as **disk files** that bypass both the behavioral eval *and* the atomic versioned registry.

### 2.4 Why it can't serve other engineers today

- **Single producer.** Paths, GCP project, and the one `deep-analysis.json` assume Samuel's laptop. No notion of *who* a session belongs to.
- **No privacy boundary.** Another engineer's sessions carry tenant creds and secrets; nothing redacts.
- **Gap ranking is machine-local frequency** — can't express "5 engineers hit this."
- **Promotion bypasses the registry** — no attribution, no rollback, no audit for generated skills.

---

## 3. Goals / Non-goals

**Goals**
- G1. A single, behavioral promotion contract: *beat the incumbent on a failure-derived suite.*
- G2. Multiple producers (engineers, the team, tenants) feed one flywheel; one engineer's session benefits all.
- G3. Generated skills flow through Nario's real atomic registry with full attribution/rollback.
- G4. Reusable beyond Nario via a thin `Target` adapter.
- G5. Cost scales sub-linearly with producer count (cheap→expensive gate cascade, caching).

**Non-goals (v2)**
- N1. Auto-promoting **mutating** skills without a human. Never in v2.
- N2. Replacing human-authored skills — the pipeline is one more author (`edited_by.kind = 'pipeline'`).
- N3. Real-time generation. The flywheel stays batch/scheduled.
- N4. Cross-org/public sharing of skills.

---

## 4. Key design decisions

**D1 — The gap becomes the eval, and the eval is behavioral.**
For each gap, synthesize a `skill-bench` suite from the transcripts that revealed it (§8). Candidate must beat the incumbent skill on that suite. This collapses the three gates into one.

**D2 — Producer = Nario's `owner` model, reused.**
`producer: {kind:'user'|'team'|'tenant', id}`. The engineer-side flywheel (sessions) and the tenant-side flywheel (the existing `dataflywheel-benchmark` skill mining prod LINE conversations) become the **same engine with different producer kinds**. "Other engineers" is just more `kind:'user'` producers.

**D3 — Promote through `promoteVersion()`, not the filesystem.**
A generated skill is a draft authored by `edited_by:{kind:'pipeline', identifier:<runId>}`, promoted atomically via the existing `parent_version_id` conditional update. Free history, rollback, audit, ACL.

**D4 — `Target` adapter isolates Nario.**
The pipeline core (ingest→gap→generate→eval) is target-agnostic. Nario implements `Target` with Mongo bundles + the skill-bench Nario sampler. A different engineer points it at a plain `.claude/skills/` git repo.

**D5 — Cheap→expensive gate cascade.**
text rubric (cheap pre-filter) → behavioral eval vs incumbent (expensive) → hill-climb (most expensive, margin cases only). Never spend the costly stage on candidates that die at the cheap one.

---

## 5. Target architecture

### 5.1 Data flow

```
PRODUCERS                    SUBSTRATE                SYNTHESIS + SINGLE GATE              TARGET (adapter)
─────────                    ─────────                ───────────────────────             ────────────────
user:alice  ─┐
user:bob    ─┤  sink+REDACT  deep-analysis      gap synthesis      generate    [text pre-filter]
team:eng    ─┼──────────────► (struggles, ────► (breadth×recency  ─► (batched, ─►  survivors ─┐
tenant:wonson┘  (dataflywheel  gaps, patterns)    ×frequency,        cached            │
                -benchmark)    partitioned by      dedup vs                            ▼
                               producer+shared)    incumbent)                  BEHAVIORAL EVAL (skill-bench)
                                                                               candidate vs incumbent on a suite
                                                                               AUTO-BUILT from the struggle
                                                                               transcripts behind the gap
                                                                                          │ margin ≥ M & no regression?
                                                                                          ▼ yes
                                                                               Target.promote()
                                                                               → promoteVersion() (atomic,
                                                                                 parent_version_id,
                                                                                 edited_by:pipeline)
                                                                               → test/dry-run gate
                                                                                          │
                                              mutates? ── yes ──► human approval (consult-user via LINE DM)
                                                          no + high margin ──► auto-promote
                                                                                          ▼
                                                                  available to ALL producers + tenant runtime
```

### 5.2 Component responsibilities

| Component | Owns | Reuses today |
|---|---|---|
| **Ingestor** | producer tagging, redaction, publish | `claude-sink`, `claude-sessions-pipeline` |
| **Substrate** | per-producer + shared knowledge stores | the 6 consumers (Chroma/ClickHouse/Neo4j/…) |
| **GapSynthesizer** | rank gaps team-wide, dedup vs incumbent behavior | `phaseAnalyze()` (extended) |
| **SkillGenerator** | LLM generation, cached prefix | `phaseGenerate()`, `claudeJSON()` |
| **BenchmarkSynthesizer** | struggle transcripts → `skill-bench` YAML suite | NEW; mirrors `dataflywheel-benchmark` |
| **EvalGate** | run candidate vs incumbent, compute margin | `skill-bench` `compare` / `POST /api/v1/jobs` |
| **Target** | fetch incumbent, promote, run eval | `nario` `promote.ts` / `nario_sampler.py` |

---

## 6. Schemas

### 6.1 `ProducerRef` (new — mirrors Nario `owner`)

```ts
interface ProducerRef {
  kind: 'user' | 'team' | 'tenant';
  id: string;            // 'alice' | 'nario-eng' | 'wonson'
}
```

### 6.2 Ingested session (extend `deep-analysis.json` entry)

```ts
interface AnalyzedSession {
  session_id: string;
  producer: ProducerRef;            // NEW
  redaction: {                      // NEW
    applied: boolean;
    rules_version: string;
    redacted_spans: number;         // count, for audit; never the values
  };
  deep: {
    userGoal: string;
    whatTheyBuilt: string;
    problems: string[];
    struggles: Struggle[];          // promoted to first-class (see 6.3)
    fundamentalSkillsNeeded: { skill: string; category: string; reason: string; urgency: 'low'|'med'|'high' }[];
    orchestrationPattern?: string;
    sessionQuality: { outcome: 'success'|'partial'|'fail' };
  };
  shallow: { tokenUsage: { totalTokens: number } };
}

interface Struggle {
  description: string;
  first_turn_idx: number;           // where it started
  resolved_turn_idx: number | null; // where the engineer got it working (ground truth)
  resolution_evidence?: string;     // final command / file / answer that worked
}
```

### 6.3 `Gap` (extend current frequency map)

```ts
interface Gap {
  skill: string;
  category: string;
  evidence_sessions: string[];               // session_ids
  producers: ProducerRef[];                  // who hit it — drives breadth
  score: {                                   // ranking, not an LLM call
    breadth: number;                         // distinct producers
    recency: number;                         // decay-weighted last-seen
    frequency: number;                       // total mentions
    composite: number;                       // breadth × recency × frequency
  };
  incumbent: { skill_id: string; version_number: number } | null;  // dedup target
  urgencies: string[];
}
```

### 6.4 `SkillCandidate`

```ts
interface SkillCandidate {
  candidate_id: string;
  gap: Gap;
  // Nario SKILL.md contract (from version-model.ts skills[])
  skill_id: string;
  dir: string;
  mutates: boolean;
  user_facing_description: string;
  parameters_summary: string;
  cancel_safe_points: 'transaction' | 'record' | 'turn';
  expected_duration_seconds: number;
  files: { relative_path: string; content: string; executable: boolean }[];
  prefilter: { text_score: number; passed: boolean };   // cheap gate
}
```

### 6.5 `EvalVerdict`

```ts
interface EvalVerdict {
  suite_id: string;
  candidate_score: number;       // 0..1 weighted (skill-bench scorer)
  incumbent_score: number | null;
  margin: number;                // candidate − incumbent (vs 0 if no incumbent)
  held_out: { candidate: number; incumbent: number | null };  // regression guard
  per_case: { case_id: string; candidate: number; incumbent: number | null }[];
  decision: 'auto_promote' | 'needs_human' | 'reject';
}
```

### 6.6 Nario registry changes (minimal)

- `skill_bundle_versions.edited_by.kind`: add `'pipeline'` to the existing enum `'admin'|'engineer'|'bootstrap'`.
- `skill_bundle_versions`: add optional `eval_summary` alongside `test_run_summary`:
  ```ts
  eval_summary?: {
    suite_id: string;
    candidate_score: number;
    incumbent_score: number | null;
    margin: number;
    skill_bench_job_id: string;   // link back to skill_bench.db
  }
  ```
- New feature flag (mirrors `mongoBundleEnabledForTenant`): `pipelinePromotionEnabledForBundle(bundle_id)` — per-bundle, default off, reversible.

No change to `promote.ts`'s atomic 3-step; the pipeline is just another caller.

---

## 7. Interfaces

> The pipeline is Node; `skill-bench` is Python. The eval boundary is the **existing** `skill-bench` HTTP service (`POST /api/v1/jobs`). Types below are illustrative contracts.

```ts
// Decouples the engine from Nario. One impl per target.
interface Target {
  // Current shipped skill for this skill_id, or null if none.
  fetchIncumbent(skillId: string): Promise<{ version_number: number; files: FileBlob[] } | null>;

  // Run candidate (and incumbent, if any) against the suite. Delegates to skill-bench.
  runBehavioralEval(suite: BenchmarkSuite, candidate: SkillCandidate,
                    incumbent?: FileBlob[]): Promise<EvalVerdict>;

  // Promote a winning candidate. Nario impl → promoteVersion(); git impl → open PR.
  promote(candidate: SkillCandidate, parentVersionId: string,
          verdict: EvalVerdict): Promise<{ ok: true; version_number: number } | { ok: false; reason: string }>;
}

interface BenchmarkSynthesizer {
  // Build a skill-bench suite from the struggle transcripts behind a gap.
  synthesize(gap: Gap, sessions: AnalyzedSession[]): Promise<BenchmarkSuite>;  // → tasks/*.yaml
}

interface PromotionPolicy {
  decide(candidate: SkillCandidate, verdict: EvalVerdict): EvalVerdict['decision'];
  // v2 rule: mutates → 'needs_human'; !mutates && margin ≥ M_high && no held-out regression → 'auto_promote'; else 'needs_human'/'reject'
}
```

`BenchmarkSuite` = a set of `skill-bench` `BenchmarkTask` YAMLs (`engine/models.py`): `turns`, `assertions` (file_exists, command_output_contains, response_contains, llm_judge, …), `setup`, `model`, `timeout_seconds`.

---

## 8. The single promotion gate (the heart)

**Failure-derived benchmark synthesis.** For a gap with `evidence_sessions`:

1. For each session, take the `Struggle` with a non-null `resolved_turn_idx`. The user request at `first_turn_idx` is the **task input**; the `resolution_evidence` at `resolved_turn_idx` is the **ground-truth success**.
2. Emit one `skill-bench` task per struggle:
   - `turns`: the user's original ask (optionally the multi-turn lead-up).
   - `assertions`: encode the resolution — `command_output_contains` / `file_exists` for concrete outcomes; `llm_judge` ("resolves X directly, without the trial-and-error the engineer needed") for fuzzy ones.
   - Hold out ~30% of cases as a regression set (never shown to generation/hill-climb).
3. The suite is the gap's contract. It is versioned next to the skill so future edits re-run it.

**Scoring vs incumbent.** Reuse `skill-bench compare`: mount candidate-skill vs incumbent-skill, run the same suite (CLI sampler for dev-skills; `nario_sampler` for tenant deployment). `margin = candidate − incumbent` (vs `0` when no incumbent exists).

**Decision (`PromotionPolicy`).**
- `mutates: true` → **always** `needs_human` (one-click approve via the existing **`consult-user`** skill → LINE DM + AskUserQuestion).
- `mutates: false` && `margin ≥ M_high` && no held-out regression → `auto_promote`.
- positive but small margin, or held-out regression → `needs_human`.
- `margin ≤ 0` → `reject` (optionally hand to `skill-bench climb` for one improvement round, then re-gate).

**Promotion.** `Target.promote()` builds a draft, runs Nario's existing test + dry-run gates, then `promoteVersion()` with `edited_by:{kind:'pipeline', identifier:runId}`, `change_summary` auto-written ("gap *X*: seen in N sessions across M producers; beat incumbent v{n} by Δ on suite {id}"), and `eval_summary` populated. `ConcurrentEditError` → rebase on fresh `current_version_id` and retry.

---

## 9. Multi-producer & privacy

- **Identity.** Every session tagged `producer` at ingest. Substrate partitions per-producer; gap synthesis reads a producer's own partition + the shared team pool.
- **Redaction is mandatory, at the sink, before anything is published.** Strip tenant DB creds, SSH keys, tokens, PII. Record only `redacted_spans` counts for audit — never values. A session that fails redaction validation is dropped, not published.
- **Ranking.** `composite = breadth × recency × frequency` — a gap 5 engineers hit outranks one Alice hit once.
- **ACL.** `edited_by:'pipeline'` is subject to the same bundle ACL as humans; it can only promote into bundles the run is authorized for.
- **Tenant producers** reuse the existing `dataflywheel-benchmark` skill (already read-only against prod Mongo, already emits Langfuse-compatible JSON) as the `kind:'tenant'` ingest path — no new prod access.

---

## 10. Token economics

Cost must scale sub-linearly as producers multiply:

- Gap detection stays **LLM-free** (deterministic extraction + ranking).
- Generation batches by theme with a **cached prefix** (skill-format spec + incumbent catalog are static → prompt-cache; only the gap payload varies).
- **Gate cascade:** text rubric (cheap) → behavioral eval (expensive, survivors only) → hill-climb (margin cases only).
- Eval runs against the **held-out** set; behavioral eval never touches candidates that fail the pre-filter.
- **Per-producer per-cycle token budget** so one chatty producer can't blow the run.

---

## 11. Migration path & sequencing

Each phase ships independently, is reversible (feature-flagged), and leaves the system working.

| Phase | Deliverable | Reversible via | Unblocks |
|---|---|---|---|
| **P0 — Baseline** | Instrument current promote: capture text-score vs a quick behavioral check on the last N generated skills. Define M_high, regression threshold from real data. | n/a (measurement) | evidence for thresholds |
| **P1 — The gate** | `BenchmarkSynthesizer` + `EvalGate` calling `skill-bench` `POST /api/v1/jobs`. Candidate vs incumbent margin computed. Still writes to dev-skills, but **annotated with `EvalVerdict`**. | flag `evalGateEnabled` | the contract |
| **P2 — Real registry** | `Target` (Nario impl) → `promoteVersion()` with `edited_by:'pipeline'`, `eval_summary`. Replaces `phasePromote()` file-writing for flagged bundles. | `pipelinePromotionEnabledForBundle` | rollback/audit/attribution |
| **P3 — Multi-producer** | producer tagging + redaction at sink; substrate partitioning; `composite` gap ranking. | flag `multiProducerEnabled` | **other engineers** |
| **P4 — Promotion policy** | `PromotionPolicy` + `consult-user` human-in-the-loop for mutating/borderline; auto-promote non-mutating high-margin. | policy config | autonomy |
| **P5 — Target adapter** | Extract `Target` interface from the working Nario impl; add a `git-repo` impl. Generalizes beyond Nario. | additive | framework reuse |

Sequencing rationale: the gate (P1) is the foundation — multi-producer without it just generates more ungated skills. The adapter (P5) is extracted *from* a working impl, not designed up front (one concrete impl + a second need first).

---

## 12. Metrics / success criteria

- **Promotion precision:** % of pipeline-promoted skills still live (not rolled back) after 30 days. Target ≥ 90%.
- **Margin honesty:** measured post-promotion behavioral score ≥ predicted within tolerance (guards overfitting).
- **Coverage:** % of top-ranked team gaps with a promoted skill within one cycle.
- **Cost:** output tokens **per promoted skill** (not per run) — must not rise as producers are added.
- **Flywheel latency:** session struggle → promoted skill, median.

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Benchmark gaming / overfit to the suite | 30% held-out cases; require generalization across ≥N cases; margin honesty metric |
| Auto-promoting a harmful mutating skill | `mutates:true` → **always** human; auto-promote only non-mutating |
| Cross-producer secret leakage | mandatory sink redaction; drop-on-fail; audit `redacted_spans` |
| `edited_by:'pipeline'` over-privileged | same bundle ACL as human editors |
| Synthesized suite is wrong (bad ground truth) | suites are reviewable artifacts; human can reject a suite, not just a skill |
| Cost blow-up with many producers | gate cascade + per-producer budget + cached prefixes |
| Two flywheels (engineer/tenant) diverge | one engine, `producer.kind` is the only difference; shared `Target` + gate |

---

## 14. Open questions

1. **M_high / regression thresholds** — derive from P0 data, or start conservative (e.g. margin ≥ 0.15, zero held-out regression) and loosen?
2. **Suite ownership** — does a synthesized suite live in `skill-bench/tasks/` (versioned in git) or in Mongo next to the bundle version? (Leaning: git for dev-skills, Mongo `eval_summary` link for tenant bundles.)
3. **Where does the pipeline run** for multi-producer — stays on a box reading local `~/.claude`, or a hosted ingest each engineer pushes to? (P3 decision.)
4. **`team` pool membership** — explicit roster, or derived from who's pushed sessions?
5. **Do tenant-producer skills auto-promote at all**, or always human given they touch prod tenants? (Likely always human in v2 → N1/P4.)

---

## Appendix A — Reused building blocks (don't reinvent)

- `dataflywheel-benchmark` (dev-skill): prod LINE → Langfuse-compatible eval JSON. **This is the tenant-side analog of §8** — the `kind:'tenant'` ingest path.
- `eval-prompts` (dev-skill): runs prompt evals against Langfuse. Pattern reference for the eval gate.
- `diagnose-tenant` / `nario-oncall`: tenant failure signal (Mongo + Langfuse / Axiom).
- `consult-user` (dev-skill): LINE DM + AskUserQuestion — the human-in-the-loop for P4.
- `skill-bundle-management` (dev-skill): pull/push/rollback bundles, flip flags — the manual counterpart of `Target.promote()`.
- `skill-bench` `compare` + `nario_sampler.py`: candidate-vs-incumbent A/B is already built.
