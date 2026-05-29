import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

// Synthesize an eval task from the session struggle that motivated a skill.
// The object shape matches skill-bench/engine/loader.py + models.py
//   (turns[].{role,content}, assertions[].{type,target,weight}; target = judge prompt)
// so it stays a valid skill-bench task YAML, but the gate (eval-gate/index.js) now also reads
// turns[0].content (the user ask) and assertions[0].target (the judge criteria) directly.

const EVAL_MODEL = process.env.EVAL_MODEL || 'claude-sonnet-4-6';
const TASK_TIMEOUT = Number(process.env.EVAL_TASK_TIMEOUT || 300);

/** Reconstruct the user ask the skill is supposed to handle. */
function reconstructAsk(brief, gap, struggle) {
  const goal = brief.userGoal ? `${brief.userGoal}\n\n` : '';
  const s = struggle ? ` I keep getting stuck on: ${struggle}.` : '';
  return `${goal}Specifically, help me with: ${gap}.${s}`;
}

/** @param {object} brief  @param {{skill_id:string, addresses_gap?:string}} skill */
export function synthesizeTask(brief, skill) {
  const gap = skill.addresses_gap || brief.gaps?.[0]?.skill || brief.userGoal || skill.skill_id;
  const struggle = brief.struggles?.[0]?.description || brief.struggles?.[0]?.area
    || brief.problems?.[0]?.description || '';
  const ask = reconstructAsk(brief, gap, struggle);

  const judge = [
    `Evaluate whether the assistant resolved the task: "${gap}".`,
    'Score 1.0 only if the response gives concrete, correct, expert steps a developer could follow to a working result',
    '(real commands/flags/paths and error handling) — NOT generic advice.',
    struggle ? `It must specifically overcome this struggle: "${struggle}".` : '',
    'Score 0.0 for vague or wrong guidance.',
  ].filter(Boolean).join(' ');

  return {
    id: `gap-${skill.skill_id}`,
    name: `${skill.skill_id}: ${gap}`.slice(0, 120),
    description: `Auto-synthesized from session ${brief.sessionId} to gate skill ${skill.skill_id}`,
    model: EVAL_MODEL,
    timeout_seconds: TASK_TIMEOUT,
    turns: [{ role: 'user', content: ask }],
    assertions: [{ type: 'llm_judge', target: judge, weight: 1.0 }],
  };
}

/** Write tasks as <id>.yaml into dir; returns dir. */
export function writeSuite(tasks, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const t of tasks) fs.writeFileSync(path.join(dir, `${t.id}.yaml`), yaml.dump(t));
  return dir;
}
