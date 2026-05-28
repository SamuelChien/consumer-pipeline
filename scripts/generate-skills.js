import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { claudeJSON } from '../src/shared/claude-cli.js';
import { createLogger } from '../src/shared/logger.js';

const logger = createLogger('skill-generator');
const OUTPUT = join(process.cwd(), 'output', 'generated-skills');
const CONTEXT_FILE = '/tmp/full-context.json';

mkdirSync(join(OUTPUT, 'scripts'), { recursive: true });
mkdirSync(join(OUTPUT, 'fundamental'), { recursive: true });
mkdirSync(join(OUTPUT, 'orchestration'), { recursive: true });

const ctx = JSON.parse(readFileSync(CONTEXT_FILE, 'utf8'));

function buildThemePrompt(themeName, themeGaps) {
  const failedSessions = ctx.sessionsByOutcome.failed
    .filter(s => {
      const text = [s.goal, s.built, ...s.tech, ...s.tools, ...s.concepts].join(' ').toLowerCase();
      return themeGaps.some(g => text.includes(g.skill.toLowerCase().split(' ')[0]));
    })
    .slice(0, 8);

  const partialSessions = ctx.sessionsByOutcome.partial
    .filter(s => {
      const text = [s.goal, ...s.tech, ...s.concepts].join(' ').toLowerCase();
      return themeGaps.some(g => text.includes(g.skill.toLowerCase().split(' ')[0]));
    })
    .slice(0, 5);

  const successSessions = ctx.sessionsByOutcome.successful
    .filter(s => {
      const text = [s.goal, ...s.tech, ...s.concepts].join(' ').toLowerCase();
      return themeGaps.some(g => text.includes(g.skill.toLowerCase().split(' ')[0]));
    })
    .slice(0, 3);

  const relatedProblems = ctx.allProblems
    .filter(p => themeGaps.some(g => (p.description + ' ' + (p.resolution || '')).toLowerCase().includes(g.skill.toLowerCase().split(' ')[0])))
    .slice(0, 15);

  const relatedStruggles = ctx.allStruggles
    .filter(st => themeGaps.some(g => (st.area + ' ' + st.evidence).toLowerCase().includes(g.skill.toLowerCase().split(' ')[0])))
    .slice(0, 10);

  const relatedAutomation = ctx.allAutomation
    .filter(a => themeGaps.some(g => a.toLowerCase().includes(g.skill.toLowerCase().split(' ')[0])))
    .slice(0, 10);

  return `You are a Claude Code skill architect. Create production-quality skills for the "${themeName}" theme.

## CONTEXT: REAL USER DATA FROM ${ctx.summary.totalSessions} CLAUDE CODE SESSIONS

### SKILL GAPS IN THIS THEME (${themeGaps.length} identified)
${themeGaps.map(g => `- **${g.skill}** (${g.category}, ${g.sessions} sessions, urgency: ${g.urgencies.join('/')})
  Reasons: ${g.reasons.join(' | ')}`).join('\n')}

### FAILED SESSIONS (what went wrong — skills should prevent this)
${failedSessions.map(s => `- Goal: ${s.goal.slice(0, 150)}
  Problems: ${s.problems.map(p => `[${p.severity}] ${p.description}${p.resolution ? ' → ' + p.resolution : ''}`).join('; ')}
  Insight: ${s.insight}`).join('\n') || 'None matched'}

### PARTIAL SESSIONS (skills could have helped complete these)
${partialSessions.map(s => `- Goal: ${s.goal.slice(0, 150)}
  Missing: ${s.struggles.map(st => st.area).join(', ')}
  Needed: ${s.skillsNeeded.map(sk => sk.skill).join(', ')}`).join('\n') || 'None matched'}

### SUCCESSFUL SESSIONS (patterns to encode as skills)
${successSessions.map(s => `- Goal: ${s.goal.slice(0, 150)}
  Workflow: ${s.workflow}
  Tech: ${s.tech.join(', ')}`).join('\n') || 'None matched'}

### PROBLEMS ENCOUNTERED (${relatedProblems.length})
${relatedProblems.map(p => `- [${p.severity}] ${p.description}${p.resolution ? ' → ' + p.resolution : ''}`).join('\n') || 'None'}

### STRUGGLES (${relatedStruggles.length})
${relatedStruggles.map(st => `- ${st.area}: ${st.evidence} (Gap: ${st.skillGap})`).join('\n') || 'None'}

### AUTOMATION OPPORTUNITIES
${relatedAutomation.map(a => `- ${a}`).join('\n') || 'None'}

## INSTRUCTIONS

Create ${Math.min(5, Math.max(2, themeGaps.length))} skills. Each skill MUST:
1. Directly address one or more gaps listed above
2. Include specific steps that would have prevented the failed sessions
3. Reference the real tech stack (${[...new Set(failedSessions.concat(partialSessions).flatMap(s => s.tech))].slice(0, 10).join(', ')})
4. Have a complete body with ## sections, examples, and actionable instructions

For EACH skill, also provide:
- **addressesGaps**: which gaps from the list above it covers
- **preventsFailures**: which failure patterns it would prevent
- **relatedSkills**: other skills it connects to (from any theme)
- **prerequisites**: what the user should know first
- **context**: a 2-3 sentence explanation of why this skill matters for THIS user

Return JSON:
{
  "skills": [
    {
      "name": "skill-name-kebab-case",
      "type": "script|fundamental|orchestration",
      "description": "one line",
      "category": "the category",
      "tags": ["tag1", "tag2"],
      "tools": ["Read", "Bash", "Edit"],
      "addressesGaps": ["gap1", "gap2"],
      "preventsFailures": ["failure pattern 1"],
      "relatedSkills": ["other-skill-1", "other-skill-2"],
      "prerequisites": ["prereq 1"],
      "context": "Why this matters for this user...",
      "body": "Full skill content with ## sections, code examples, step-by-step instructions. 800+ words."
    }
  ]
}`;
}

async function generateTheme(themeName, themeGaps) {
  if (themeGaps.length === 0) return [];
  logger.info(`Generating skills for theme: ${themeName} (${themeGaps.length} gaps)`);

  const prompt = buildThemePrompt(themeName, themeGaps);

  try {
    const result = await claudeJSON(prompt, { timeoutMs: 600000 });
    const skills = result.skills || [];
    logger.info(`${themeName}: generated ${skills.length} skills`);

    for (const skill of skills) {
      const id = (skill.name || 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const typeDir = skill.type === 'orchestration' ? 'orchestration' : skill.type === 'fundamental' ? 'fundamental' : 'scripts';

      const frontmatter = [
        '---',
        `name: ${skill.name}`,
        `description: "${(skill.description || '').replace(/"/g, '\\"')}"`,
        `category: ${skill.category || 'productivity'}`,
        `tags: [${(skill.tags || []).join(', ')}]`,
        `allowed-tools: [${(skill.tools || []).join(', ')}]`,
        `tier: standard`,
        `type: ${skill.type || 'script'}`,
        `generated: true`,
        `generated_at: ${new Date().toISOString()}`,
        `generated_from: session-intelligence`,
        `theme: ${themeName}`,
        `addresses_gaps: [${(skill.addressesGaps || []).join(', ')}]`,
        `prevents_failures: [${(skill.preventsFailures || []).join(', ')}]`,
        `related_skills: [${(skill.relatedSkills || []).join(', ')}]`,
        `prerequisites: [${(skill.prerequisites || []).join(', ')}]`,
        '---',
      ].join('\n');

      const contextSection = skill.context ? `\n## Context\n\n${skill.context}\n` : '';
      const content = `${frontmatter}\n${contextSection}\n${skill.body || `# ${skill.name}\n\n${skill.description}`}`;

      writeFileSync(join(OUTPUT, typeDir, `${id}.md`), content);
      logger.info(`  Wrote: ${typeDir}/${id}.md`);

      // Write per-skill context file
      const ctxDir = join(process.cwd(), 'output', 'skill-context');
      mkdirSync(ctxDir, { recursive: true });
      writeFileSync(join(ctxDir, `${id}.json`), JSON.stringify({
        id,
        name: skill.name,
        type: skill.type,
        category: skill.category,
        theme: themeName,
        description: skill.description,
        addressesGaps: skill.addressesGaps || [],
        preventsFailures: skill.preventsFailures || [],
        relatedSkills: skill.relatedSkills || [],
        prerequisites: skill.prerequisites || [],
        context: skill.context || '',
        tags: skill.tags || [],
        tools: skill.tools || [],
      }, null, 2));
    }

    return skills.map(s => ({
      id: (s.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      ...s,
      theme: themeName,
    }));
  } catch (err) {
    logger.error(`${themeName} generation failed: ${err.message}`);
    return [];
  }
}

async function main() {
  const themes = ctx.themes;
  const allGenerated = [];
  const BATCH_SIZE = 8;

  for (const [themeName, themeGaps] of Object.entries(themes)) {
    if (themeGaps.length <= BATCH_SIZE) {
      const skills = await generateTheme(themeName, themeGaps);
      allGenerated.push(...skills);
    } else {
      for (let i = 0; i < themeGaps.length; i += BATCH_SIZE) {
        const batch = themeGaps.slice(i, i + BATCH_SIZE);
        const batchName = `${themeName}-batch-${Math.floor(i / BATCH_SIZE) + 1}`;
        logger.info(`Splitting ${themeName}: batch ${Math.floor(i / BATCH_SIZE) + 1} (${batch.length} gaps)`);
        const skills = await generateTheme(batchName, batch);
        allGenerated.push(...skills);
      }
    }
  }

  // Write graph mapping
  const graphPath = join(process.cwd(), 'output', 'skill-graph.json');
  writeFileSync(graphPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalSkills: allGenerated.length,
    themes: Object.fromEntries(Object.entries(themes).map(([k,v]) => [k, v.length])),
    skills: allGenerated.map(s => ({
      id: s.id,
      name: s.name,
      type: s.type,
      theme: s.theme,
      category: s.category,
      addressesGaps: s.addressesGaps || [],
      relatedSkills: s.relatedSkills || [],
      prerequisites: s.prerequisites || [],
      preventsFailures: s.preventsFailures || [],
    })),
    edges: allGenerated.flatMap(s => [
      ...(s.relatedSkills || []).map(r => ({ from: s.id, to: r, type: 'RELATED_TO' })),
      ...(s.prerequisites || []).map(p => ({ from: s.id, to: p, type: 'REQUIRES' })),
      ...(s.addressesGaps || []).map(g => ({ from: s.id, to: g, type: 'ADDRESSES' })),
    ]),
  }, null, 2));

  logger.info(`Done. Generated ${allGenerated.length} skills across ${Object.keys(themes).length} themes`);
  logger.info(`Graph: ${graphPath}`);
}

main().catch(err => { logger.error('Fatal', { error: err.message }); process.exit(1); });
