import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { KafkaConsumerGroup } from '../../shared/kafka-consumer.js';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { startHealthServer } from '../../shared/health.js';

const logger = createLogger('eval-consumer');

class EvalConsumer {
  constructor() {
    this.claude = new Anthropic();
    this.outputDir = join(config.outputDir, 'evals');
    this.sessionSkillMap = new Map();
    this.skillIndex = new Map();
    this.stats = { testCases: 0, suites: 0, triggerTests: 0 };
  }

  init() {
    mkdirSync(join(this.outputDir, 'test-cases'), { recursive: true });
    mkdirSync(join(this.outputDir, 'trigger-tests'), { recursive: true });
    mkdirSync(join(this.outputDir, 'suites'), { recursive: true });

    const indexPath = join(this.outputDir, '_eval-index.json');
    if (existsSync(indexPath)) {
      const data = JSON.parse(readFileSync(indexPath, 'utf-8'));
      for (const [k, v] of Object.entries(data.skillIndex || {})) this.skillIndex.set(k, v);
      logger.info('Loaded eval index', { skills: this.skillIndex.size });
    }
  }

  saveIndex() {
    writeFileSync(join(this.outputDir, '_eval-index.json'), JSON.stringify({
      skillIndex: Object.fromEntries(this.skillIndex),
      stats: this.stats,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  }

  async handleSessionAnalyzed({ key, value }) {
    const session = value;
    const sessionId = session.sessionId || key;
    const analysis = session.analysis || {};

    const context = {
      sessionId,
      project: session.project,
      category: analysis.categories?.primary,
      topics: (analysis.topics || []).map(t => t.topic),
      tools: (analysis.toolUsage?.tools || []).map(t => ({ name: t.name, count: t.count })),
      files: (analysis.filesAccessed || []).slice(0, 10),
      commands: (analysis.commands?.topBinaries || []).map(c => c.binary),
      complexity: analysis.complexity?.level,
      duration: analysis.duration?.minutes,
    };

    this.sessionSkillMap.set(sessionId, context);

    if (this.sessionSkillMap.size >= 5) {
      await this.generateTriggerTests();
      this.sessionSkillMap.clear();
    }
  }

  async handleSkillAnalyzed({ key, value }) {
    const skill = value;
    const skillId = skill.id || key;
    const analysis = skill.analysis || {};

    this.skillIndex.set(skillId, {
      name: skill.name,
      category: analysis.categories?.primary,
      tags: skill.tags || [],
      platforms: skill.platforms || [],
      tier: skill.tier,
    });

    await this.generateSkillTestCases(skill, analysis);
  }

  async generateSkillTestCases(skill, analysis) {
    const skillId = skill.id;

    try {
      const response = await this.claude.messages.create({
        model: config.claude.model,
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `Generate test cases for this Claude Code skill to verify it works correctly.

## Skill: ${skill.name}
- ID: ${skillId}
- Category: ${analysis.categories?.primary || 'unknown'}
- Description: ${(skill.description || '').slice(0, 500)}
- Tags: ${(skill.tags || []).join(', ')}
- Tools: ${(skill.allowedTools || []).join(', ')}
- Platforms: ${(skill.platforms || []).join(', ')}
- Tier: ${skill.tier || 'standard'}

## Skill Content (first 2000 chars)
${(skill.body || '').slice(0, 2000)}

Generate a JSON object with:
1. "testCases": Array of test cases, each with:
   - "name": descriptive test name
   - "input": the user message/prompt that should trigger this skill
   - "expectedBehavior": what the skill should do
   - "assertions": array of checkable assertions (tool calls made, output patterns, etc.)
   - "category": "functional" | "trigger" | "edge-case" | "negative"
2. "triggerPatterns": Array of user messages that SHOULD trigger this skill
3. "antiPatterns": Array of user messages that should NOT trigger this skill

Generate 3-5 test cases covering: happy path, edge cases, and trigger accuracy.
Return valid JSON only.`,
        }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const testData = JSON.parse(jsonMatch[0]);

      const testFile = {
        skillId,
        skillName: skill.name,
        category: analysis.categories?.primary,
        generatedAt: new Date().toISOString(),
        ...testData,
      };

      writeFileSync(
        join(this.outputDir, 'test-cases', `${skillId}.json`),
        JSON.stringify(testFile, null, 2)
      );

      this.stats.testCases += (testData.testCases || []).length;
      this.stats.suites++;

      if (this.stats.suites % 20 === 0) this.saveIndex();

      logger.info(`Generated tests for ${skillId}`, {
        cases: (testData.testCases || []).length,
        triggers: (testData.triggerPatterns || []).length,
      });
    } catch (err) {
      logger.error(`Test generation failed for ${skillId}`, { error: err.message });
    }
  }

  async generateTriggerTests() {
    const sessions = [...this.sessionSkillMap.values()];

    const sessionSummary = sessions.map(s =>
      `- Project: ${s.project}, Category: ${s.category}, Topics: ${s.topics.join(', ')}, Tools: ${s.tools.map(t => t.name).join(', ')}, Complexity: ${s.complexity}`
    ).join('\n');

    const availableSkills = [...this.skillIndex.entries()]
      .slice(0, 50)
      .map(([id, s]) => `- ${id}: ${s.name} (${s.category}, tags: ${s.tags.slice(0, 5).join(', ')})`)
      .join('\n');

    try {
      const response = await this.claude.messages.create({
        model: config.claude.model,
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `Based on these real Claude Code sessions, generate trigger test cases that verify the right skills get activated for the right use cases.

## Recent Sessions (real user workflows)
${sessionSummary}

## Available Skills (subset)
${availableSkills}

Generate a JSON object with:
1. "triggerTests": Array of tests, each with:
   - "userMessage": a realistic user prompt (based on session patterns)
   - "expectedSkills": array of skill IDs that should be triggered
   - "context": what project/situation this simulates
   - "priority": "high" | "medium" | "low"
2. "coverageGaps": Array of session patterns that have NO matching skill

Return valid JSON only.`,
        }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const triggerData = JSON.parse(jsonMatch[0]);

      const fileName = `trigger-batch-${Date.now()}.json`;
      writeFileSync(
        join(this.outputDir, 'trigger-tests', fileName),
        JSON.stringify({
          generatedAt: new Date().toISOString(),
          sessionCount: sessions.length,
          ...triggerData,
        }, null, 2)
      );

      this.stats.triggerTests += (triggerData.triggerTests || []).length;

      logger.info('Generated trigger tests', {
        tests: (triggerData.triggerTests || []).length,
        gaps: (triggerData.coverageGaps || []).length,
      });
    } catch (err) {
      logger.error('Trigger test generation failed', { error: err.message });
    }
  }
}

async function main() {
  const consumer = new EvalConsumer();
  consumer.init();

  const kafka = new KafkaConsumerGroup('eval-consumer-group', logger);

  kafka
    .on(config.topics.skillsAnalyzed, (msg) => consumer.handleSkillAnalyzed(msg))
    .on(config.topics.sessionsAnalyzed, (msg) => consumer.handleSessionAnalyzed(msg));

  await kafka.start();
  startHealthServer(3006);

  process.on('SIGINT', async () => {
    if (consumer.sessionSkillMap.size > 0) {
      await consumer.generateTriggerTests();
    }
    consumer.saveIndex();
    logger.info('Shutting down', consumer.stats);
    await kafka.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
