#!/usr/bin/env node
// Eval gate: does a candidate skill's guidance measurably improve the model's
// WRITTEN answer to the gap that motivated it?
//
// For each skill we synthesize the user ask + judge criteria from the session
// struggle (synthesize-suite.js), then sample two prose answers from EVAL_MODEL:
//   WITH     — the SKILL.md is injected into context
//   BASELINE — no skill
// Two judge signals, because absolute scoring alone can't separate two strong
// near-ceiling answers (both land ~0.85): (1) an ABSOLUTE judge on each answer =
// a quality floor (WITH must clear EVAL_PASS); (2) a PAIRWISE judge that compares
// the two answers head-to-head over EVAL_SAMPLES position-swapped rounds = the
// sensitive "did the skill help" signal. Promote iff WITH clears the floor AND
// wins ≥ EVAL_WIN_RATE of the decided pairwise rounds.
//
// Sampling is prose-only with NO tools (see claudeProse): the model must produce
// guidance, not go agentic. The previous skill-bench CLI-sampler path let the
// model spend its one turn on a tool call, hit error_max_turns, and return an
// empty response — every run was flagged an infra error and scored 0. This path
// is self-contained (only needs `claude`), so it no longer depends on a
// skill-bench install. The synthesized task YAML is still written for inspection.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesizeTask, writeSuite } from './synthesize-suite.js';
import { claudeProse } from '../shared/claude-cli.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR ? path.resolve(process.env.OUTPUT_DIR) : path.resolve(process.cwd(), 'output');
const SKILLS_ROOT = path.join(OUTPUT_DIR, 'research-skills');
const EVAL_MODEL = process.env.EVAL_MODEL || 'claude-sonnet-4-6';
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL || EVAL_MODEL;
const EVAL_PASS = Number(process.env.EVAL_PASS || 0.7);    // candidate must clear this WITH the skill
const EVAL_MARGIN = Number(process.env.EVAL_MARGIN || 0.1); // and beat baseline by this much
const EVAL_SAMPLES = Math.max(2, Number(process.env.EVAL_SAMPLES || 4)); // pairwise comparison rounds (position-swapped) — see pairwiseCompare
const EVAL_WIN_RATE = Number(process.env.EVAL_WIN_RATE || 0.6); // WITH must win ≥ this share of *decided* pairwise rounds to promote
const ANSWER_TIMEOUT_MS = Number(process.env.EVAL_TASK_TIMEOUT || 300) * 1000;
const JUDGE_LOG_CHARS = 12000; // how much of the answer the judge sees

// Advisory framing: forces a written-guidance answer instead of agentic action.
// Without it (and with tools disabled) the model role-plays tool calls in prose.
const FRAMING = [
  "You are an expert engineer answering a colleague's question in a text-only chat.",
  'You have NO tools, NO filesystem, and cannot execute anything — you are only writing an answer.',
  'Provide complete, concrete written guidance the developer can follow themselves:',
  'real commands, flags, file paths, code snippets, and error handling.',
  'Do NOT attempt to perform actions, and do NOT emit any tool-call or function-call',
  'syntax — write a normal prose/markdown answer.',
].join(' ');

function answerPrompt(ask, skillContent) {
  const skillBlock = skillContent
    ? `You have the following SKILL available. Apply its guidance where relevant:\n\n<skill>\n${skillContent}\n</skill>\n\n`
    : '';
  return `${FRAMING}\n\n${skillBlock}Question:\n${ask}`;
}

// Mirrors skill-bench service/scorer.py _run_judge (same shape so scores are comparable).
// The "assume referenced tooling exists" clause is critical and applied symmetrically to BOTH
// arms: without it the judge marks down any answer that points at project-specific scripts/skills
// as "fabricated infrastructure" — which systematically penalizes the WITH arm (the skill's whole
// job is to point at the project's real scripts) and favors a baseline that reinvents everything
// with public libraries. We judge correctness/actionability, not independent file-existence.
function judgePrompt(criteria, ask, answer) {
  const log = `USER: ${ask}\nASSISTANT: ${answer.slice(0, JUDGE_LOG_CHARS)}\n`;
  return `You are an evaluation judge. Score the following conversation on how well it accomplished the task.

EVALUATION CRITERIA:
${criteria}

CONVERSATION LOG:
${log}

Judging rules:
- The assistant may reference project-specific scripts, files, tools, or skills that are assumed to
  already exist in the developer's environment. Do NOT penalize the answer for referencing these or
  treat them as hallucinated — assume they exist and judge the correctness, specificity, and
  actionability of the guidance built around them.
- Reward concrete, correct, expert guidance (exact commands, flags, paths, parameters, error handling).
- Penalize vague, generic, or incorrect guidance.

Respond with JSON only: {"score": <float 0.0-1.0>, "reasoning": "<brief explanation>"}
Score 1.0 = perfectly accomplished, 0.0 = completely failed.`;
}

function parseJudge(text) {
  const m = text && text.match(/\{[\s\S]*\}/);
  if (!m) return { score: null, reasoning: `unparseable judge output: ${(text || '').slice(0, 160)}` };
  try {
    const d = JSON.parse(m[0]);
    const s = Number(d.score);
    if (!Number.isFinite(s)) return { score: null, reasoning: 'judge returned no numeric score' };
    return { score: Math.max(0, Math.min(1, s)), reasoning: String(d.reasoning || '').slice(0, 400) };
  } catch {
    return { score: null, reasoning: `bad judge JSON: ${m[0].slice(0, 160)}` };
  }
}

/** Sample one prose answer (optionally with the skill) and judge it once. */
async function sampleAndJudgeOnce({ ask, criteria, skillContent }) {
  const ans = await claudeProse(answerPrompt(ask, skillContent), { model: EVAL_MODEL, timeoutMs: ANSWER_TIMEOUT_MS });
  if (ans.isError || !ans.response.trim()) {
    return { score: null, answer: ans.response || '', reasoning: null, infraError: ans.error || 'empty_response' };
  }
  const j = await claudeProse(judgePrompt(criteria, ask, ans.response), { model: JUDGE_MODEL, maxTokens: 1500, timeoutMs: ANSWER_TIMEOUT_MS });
  if (j.isError || !j.response.trim()) {
    return { score: null, answer: ans.response, reasoning: null, infraError: `judge_${j.error || 'empty'}` };
  }
  const { score, reasoning } = parseJudge(j.response);
  return { score, answer: ans.response, reasoning, infraError: score == null ? 'judge_unparseable' : null };
}

// Pairwise preference judge. Absolute scoring can't separate two near-ceiling
// answers (everything lands 0.82–0.93), so margins are tiny and noise-dominated.
// A head-to-head "which answer is better" judge is far more sensitive to small
// skill lifts. We run it both ways (position-swapped) to cancel order bias.
function pairwisePrompt(criteria, ask, answerA, answerB) {
  return `You are an evaluation judge comparing TWO assistant answers to the same task. Decide which one BETTER satisfies the criteria; if they are genuinely equivalent, answer "tie".

TASK (what the user asked):
${ask}

EVALUATION CRITERIA:
${criteria}

Judging rules:
- Answers may reference project-specific scripts, files, tools, or skills assumed to exist in the developer's environment — do NOT penalize that or treat it as hallucinated; judge correctness, specificity, and actionability.
- Prefer the answer with more concrete, correct, expert guidance (exact commands, flags, paths, parameters, error handling). Ignore differences in length or formatting that don't affect usefulness.

ANSWER A:
${answerA.slice(0, JUDGE_LOG_CHARS)}

ANSWER B:
${answerB.slice(0, JUDGE_LOG_CHARS)}

Respond with JSON only: {"winner": "A" | "B" | "tie", "reasoning": "<brief explanation>"}`;
}

function parsePairwise(text) {
  const m = text && text.match(/\{[\s\S]*\}/);
  if (!m) return { winner: null, reasoning: `unparseable: ${(text || '').slice(0, 120)}` };
  try {
    const d = JSON.parse(m[0]);
    const w = String(d.winner || '').trim().toUpperCase();
    const winner = w === 'A' ? 'A' : w === 'B' ? 'B' : /TIE/.test(w) ? 'tie' : null;
    return { winner, reasoning: String(d.reasoning || '').slice(0, 300) };
  } catch {
    return { winner: null, reasoning: `bad json: ${m[0].slice(0, 120)}` };
  }
}

/**
 * Head-to-head WITH vs BASELINE over `rounds`, alternating which answer is shown
 * first to cancel position bias. Returns the tally + WITH's win rate over the
 * *decided* (non-tie, non-error) rounds.
 */
async function pairwiseCompare({ ask, criteria, withAnswer, baseAnswer, rounds }) {
  let withWins = 0; let baseWins = 0; let ties = 0; let invalid = 0;
  const seq = [];
  for (let i = 0; i < rounds; i++) {
    const withIsA = i % 2 === 0; // alternate position each round
    const a = withIsA ? withAnswer : baseAnswer;
    const b = withIsA ? baseAnswer : withAnswer;
    const r = await claudeProse(pairwisePrompt(criteria, ask, a, b), { model: JUDGE_MODEL, maxTokens: 800, timeoutMs: ANSWER_TIMEOUT_MS });
    if (r.isError || !r.response.trim()) { invalid++; seq.push(`infra:${(r.error || 'empty').toString().slice(0, 40)}`); continue; }
    const { winner } = parsePairwise(r.response);
    if (winner == null) { invalid++; seq.push('unparsed'); continue; }
    if (winner === 'tie') { ties++; seq.push('tie'); continue; }
    const withWon = (winner === 'A') === withIsA; // map A/B back to WITH/BASE given the swap
    if (withWon) { withWins++; seq.push('with'); } else { baseWins++; seq.push('base'); }
  }
  const decided = withWins + baseWins;
  return {
    withWins, baseWins, ties, invalid, rounds,
    winRate: decided ? Number((withWins / decided).toFixed(3)) : null,
    seq,
  };
}

/**
 * Gate one candidate skill: WITH the skill vs baseline WITHOUT.
 * Promote if it clears EVAL_PASS and beats baseline by EVAL_MARGIN.
 */
export async function evalSkill({ sessionId, skillId, brief, addressesGap, dryRun = false }) {
  const skillFile = path.join(SKILLS_ROOT, sessionId, skillId, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return { skillId, error: 'skill not found' };

  const task = synthesizeTask(brief, { skill_id: skillId, addresses_gap: addressesGap });
  const ask = task.turns[0].content;
  const criteria = task.assertions[0].target;

  const work = path.join(OUTPUT_DIR, 'eval', sessionId, skillId);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  writeSuite([task], path.join(work, 'tasks')); // human-readable artifact

  if (dryRun) {
    const oneLine = ask.replace(/\s+/g, ' ').slice(0, 64);
    return {
      skillId,
      dryRun: true,
      commands: [
        `prose-eval (no tools) — answer model=${EVAL_MODEL}, judge=${JUDGE_MODEL}`,
        `WITH    : answer "${oneLine}…" with SKILL.md injected (+ absolute judge = quality floor)`,
        `BASELINE: same prompt without the skill (+ absolute judge)`,
        `PAIRWISE: ${EVAL_SAMPLES} position-swapped head-to-head comparisons → WITH win rate`,
        `promote if  with≥${EVAL_PASS}  and  winRate≥${EVAL_WIN_RATE}`,
      ],
    };
  }

  const skillContent = fs.readFileSync(skillFile, 'utf8');
  // One answer per arm + an absolute judge (the quality floor) — also yields the
  // two answers the pairwise judge then compares head-to-head.
  const withR = await sampleAndJudgeOnce({ ask, criteria, skillContent });
  const baseR = await sampleAndJudgeOnce({ ask, criteria, skillContent: null });

  const withScore = withR.score;
  const baseScore = baseR.score;
  const margin = (withScore != null && baseScore != null) ? Number((withScore - baseScore).toFixed(3)) : null;

  // Pairwise: the sensitive discriminator. Needs both answers to exist.
  let pairwise = null;
  if (withR.answer.trim() && baseR.answer.trim()) {
    pairwise = await pairwiseCompare({ ask, criteria, withAnswer: withR.answer, baseAnswer: baseR.answer, rounds: EVAL_SAMPLES });
  }
  const winRate = pairwise?.winRate ?? null;

  let verdict;
  if (withScore == null || !withR.answer.trim() || !baseR.answer.trim()) verdict = 'error'; // couldn't sample/score
  else if (winRate == null) verdict = 'inconclusive';                 // every pairwise round tied or errored
  else if (withScore >= EVAL_PASS && winRate >= EVAL_WIN_RATE) verdict = 'promote';
  else if (winRate > 0.5) verdict = 'weak';                           // preferred, but under the bar
  else verdict = 'reject';

  // Persist everything so a human can see WHY (answers + judge reasoning + the head-to-head tally).
  fs.writeFileSync(path.join(work, 'result.json'), JSON.stringify({
    skillId, sessionId, model: EVAL_MODEL, judgeModel: JUDGE_MODEL,
    pass: EVAL_PASS, winRateThreshold: EVAL_WIN_RATE, pairwiseRounds: EVAL_SAMPLES,
    ask, criteria, withScore, baseScore, margin, winRate, verdict, pairwise,
    with: { score: withScore, reasoning: withR.reasoning, infraError: withR.infraError, answer: withR.answer },
    baseline: { score: baseScore, reasoning: baseR.reasoning, infraError: baseR.infraError, answer: baseR.answer },
  }, null, 2));

  const out = { skillId, withScore, baseScore, margin, winRate, verdict };
  if (pairwise) out.tally = `W${pairwise.withWins}/B${pairwise.baseWins}/T${pairwise.ties}${pairwise.invalid ? `/x${pairwise.invalid}` : ''}`;
  if (withR.infraError || baseR.infraError) out.note = `with:${withR.infraError || 'ok'} base:${baseR.infraError || 'ok'}`;
  return out;
}

/** Eval every skill in a session's manifest. */
export async function evalSession(sessionId, { dryRun = false, only = null } = {}) {
  const mp = path.join(SKILLS_ROOT, sessionId, 'manifest.json');
  if (!fs.existsSync(mp)) return { sessionId, error: 'no manifest' };
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const skills = (m.skills || []).filter((s) => !only || s.skill_id === only);
  const results = [];
  for (const s of skills) {
    results.push(await evalSkill({ sessionId, skillId: s.skill_id, brief: m.brief, addressesGap: s.addresses_gap, dryRun }));
  }
  return { sessionId, results };
}

// ───────── CLI ─────────
async function main() {
  const argv = process.argv.slice(2);
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const sessionId = get('--session');
  const only = get('--skill') || null;
  const dryRun = argv.includes('--dry-run');
  if (!sessionId) { console.log('Usage: eval-gate --session <id> [--skill <id>] [--dry-run]'); return; }

  const res = await evalSession(sessionId, { dryRun, only });
  if (res.error) { console.error('✗ ' + res.error); process.exit(1); }
  console.log(`[eval-gate] ${sessionId} | model=${EVAL_MODEL} judge=${JUDGE_MODEL} pairwise=${EVAL_SAMPLES} | pass≥${EVAL_PASS} winRate≥${EVAL_WIN_RATE}${dryRun ? ' | DRY-RUN' : ''}`);
  for (const r of res.results) {
    if (r.dryRun) { console.log(`▸ ${r.skillId}`); r.commands.forEach((c) => console.log(`    ${c}`)); }
    else if (r.error) console.log(`✗ ${r.skillId}: ${r.error}`);
    else {
      const icon = r.verdict === 'promote' ? '✓' : '·';
      console.log(`${icon} ${r.skillId}: with=${r.withScore} base=${r.baseScore} win=${r.winRate} ${r.tally || ''} → ${r.verdict}${r.note ? `  (${r.note})` : ''}`);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
