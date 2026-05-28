// SkillCandidate schema — STANDARD CLAUDE CODE skill format.
// A Claude Code skill is a directory with a SKILL.md whose frontmatter is just
// `name` + `description` (+ optional `allowed-tools`). This pipeline produces
// Claude Code skills — NOT Nario tenant bundles. Do not mix the two.
//
// The research agent emits a JSON ARRAY of these (one session -> many skills).

/**
 * @typedef {Object} SkillFile
 * @property {string} relative_path  e.g. "SKILL.md", "scripts/run.sh"
 * @property {string} content
 * @property {boolean} [executable]
 *
 * @typedef {Object} SkillCandidate
 * @property {string} skill_id           kebab-case slug (== SKILL.md `name`)
 * @property {string} description        trigger-first "when to use + what it does"
 * @property {string[]} [allowed_tools]  optional Claude Code tool allowlist
 * @property {string} [addresses_gap]    which gap/capability this covers
 * @property {string[]} [related_skills] existing skill_ids found during research
 * @property {string} [research_notes]   what the agent found that grounds this
 * @property {SkillFile[]} files         must include a SKILL.md
 */

/** Validate a single Claude Code skill candidate. Returns { ok, errors[] }. */
export function validateSkill(s) {
  const errors = [];
  if (!s || typeof s !== 'object') return { ok: false, errors: ['not an object'] };

  const reqStr = (k) => {
    if (typeof s[k] !== 'string' || !s[k].trim()) errors.push(`missing/empty ${k}`);
  };
  reqStr('skill_id');
  reqStr('description');

  if (s.skill_id && !/^[a-z0-9][a-z0-9-]*$/.test(s.skill_id)) {
    errors.push('skill_id must be kebab-case ([a-z0-9-])');
  }
  if (s.allowed_tools && !Array.isArray(s.allowed_tools)) errors.push('allowed_tools must be an array');

  if (!Array.isArray(s.files) || s.files.length === 0) {
    errors.push('files[] required (at least a SKILL.md)');
  } else {
    for (const f of s.files) {
      if (!f || typeof f.relative_path !== 'string' || typeof f.content !== 'string') {
        errors.push('each file needs string relative_path + content');
      }
    }
    if (!s.files.some((f) => /(^|\/)SKILL\.md$/.test(f.relative_path || ''))) {
      errors.push('files[] must include a SKILL.md');
    }
  }
  return { ok: errors.length === 0, errors };
}

/** Apply safe defaults so a slightly-underspecified skill still validates. */
export function normalizeSkill(s) {
  return {
    allowed_tools: [],
    related_skills: [],
    research_notes: '',
    ...s,
  };
}

/**
 * Robustly pull a JSON array of skills out of agent free-text.
 * Handles: bare array, { "skills": [...] }, fenced code, trailing prose.
 */
export function extractSkillArray(text) {
  if (!text || typeof text !== 'string') return [];
  const tryParse = (str) => {
    try { return JSON.parse(str); } catch { return undefined; }
  };

  let parsed = tryParse(text.trim());
  if (parsed === undefined) {
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) parsed = tryParse(fence[1].trim());
  }
  if (parsed === undefined) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end > start) {
      parsed = tryParse(text.slice(start, end + 1));
      if (parsed === undefined) {
        const cleaned = text.slice(start, end + 1).replace(/,\s*]/g, ']').replace(/,\s*}/g, '}');
        parsed = tryParse(cleaned);
      }
    }
  }
  if (parsed === undefined) {
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s !== -1 && e > s) parsed = tryParse(text.slice(s, e + 1));
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.skills)) return parsed.skills;
  if (parsed && typeof parsed === 'object') return [parsed];
  return [];
}

/** The exact output contract injected into the agent prompt. */
export const SKILL_OUTPUT_CONTRACT = `
Your FINAL message must be ONLY a JSON array (no prose, no markdown fences) of CLAUDE CODE skill objects.
One session yields MULTIPLE skills — emit every distinct, reusable capability you found.

Each skill object:
{
  "skill_id": "kebab-case-slug",
  "description": "Third-person, trigger-first: when Claude should use this and what it does. e.g. 'Use when the user wants to ... . Does X by ...'. <= 1024 chars.",
  "allowed_tools": ["Bash", "Read"],          // optional
  "addresses_gap": "the gap/struggle this resolves",
  "related_skills": ["existing-skill-id-you-found"],
  "research_notes": "What you read/ran that grounds this (real files, commands, findings).",
  "files": [
    {
      "relative_path": "SKILL.md",
      "content": "---\\nname: kebab-case-slug\\ndescription: <same trigger-first description>\\nallowed-tools: Bash, Read\\n---\\n\\n# Title\\n\\n## When to use\\n...\\n\\n## Steps\\n1. real command with real flags\\n...\\n\\n## Errors\\n..."
    }
  ]
}

This is a STANDARD CLAUDE CODE skill: SKILL.md frontmatter is just name + description (+ optional allowed-tools).
Do NOT add tenant/bundle fields (mutates, parameters_summary, cancel_safe_points, expected_duration_seconds).

Rules:
- Ground every skill in what you actually found (real file paths, real CLI commands, real error handling). No generic filler.
- Do NOT duplicate an existing skill you found — extend it or reference it via related_skills.
- Extra files (helper scripts) go in files[] with "executable": true.
`.trim();
