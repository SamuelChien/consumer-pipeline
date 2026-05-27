import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { PubSubConsumerGroup } from '../../shared/pubsub-consumer.js';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { createMetrics } from '../../shared/metrics.js';
import { startHealthServer } from '../../shared/health.js';
import { StoreClients } from '../../shared/store-clients.js';

const logger = createLogger('eval-consumer');
const metrics = createMetrics('eval');

class EvalConsumer {
  constructor() {
    this.claude = new Anthropic();
    this.stores = new StoreClients();
    this.outputDir = join(config.outputDir, 'evals');
    this.sessionBuffer = [];
    this.skillIndex = new Map();
    this.stats = { testCases: 0, triggerTests: 0 };
  }

  async init() {
    mkdirSync(join(this.outputDir, 'test-cases'), { recursive: true });
    mkdirSync(join(this.outputDir, 'trigger-tests'), { recursive: true });
    await this.stores.init();
    logger.info('Store clients initialized');
  }

  async handleSessionAnalyzed({ key, value }) {
    const session = value;
    const analysis = session.analysis || {};

    this.sessionBuffer.push({
      sessionId: session.sessionId || session.sourceId || key,
      project: session.project,
      category: analysis.categories?.primary,
      topics: (analysis.topics || []).map(t => t.topic),
      tools: (analysis.toolUsage?.tools || []).map(t => ({ name: t.name, count: t.count })),
      complexity: analysis.complexity?.level,
    });

    if (this.sessionBuffer.length >= 5) {
      await this.generateTriggerTests();
      this.sessionBuffer = [];
    }
  }

  async handleSkillAnalyzed({ key, value }) {
    const skill = value;
    const skillId = skill.sourceId || skill.id || key;
    const analysis = skill.analysis || {};

    this.skillIndex.set(skillId, {
      name: skill.name,
      category: analysis.categories?.primary,
      tags: skill.tags || [],
      tier: skill.tier,
    });

    await this.generateSkillTestCases(skill, analysis);
  }

  async generateSkillTestCases(skill, analysis) {
    const skillId = skill.id;

    const relatedSkills = await this.stores.queryNeo4j(`
      MATCH (s:Skill {id: $id})-[:ABOUT_TOPIC]->(t:Topic)<-[:ABOUT_TOPIC]-(other:Skill)
      WHERE other.id <> $id
      RETURN other.id as id, other.category as category, count(t) as shared
      ORDER BY shared DESC LIMIT 5
    `, { id: skillId });

    const relatedContext = relatedSkills.length
      ? `Related skills (from Neo4j graph): ${relatedSkills.map(r => `${r.id} (${r.category}, ${r.shared} shared topics)`).join(', ')}`
      : '';

    try {
      const response = await this.claude.messages.create({
        model: config.claude.model,
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `Generate test cases for this Claude Code skill.

## Skill: ${skill.name}
- ID: ${skillId}
- Category: ${analysis.categories?.primary || 'unknown'}
- Description: ${(skill.description || '').slice(0, 500)}
- Tags: ${(Array.isArray(skill.tags) ? skill.tags : []).join(', ')}
- Tools: ${(Array.isArray(skill.allowedTools) ? skill.allowedTools : []).join(', ')}
- Platforms: ${(skill.platforms || []).join(', ')}
${relatedContext}

## Skill Content (first 1500 chars)
${(skill.body || '').slice(0, 1500)}

Generate JSON:
{
  "testCases": [{ "name": "...", "input": "user message that should trigger this", "expectedBehavior": "what should happen", "assertions": ["check1", "check2"], "category": "functional|trigger|edge-case|negative" }],
  "triggerPatterns": ["user message 1", "user message 2"],
  "antiPatterns": ["message that should NOT trigger this"]
}

Generate 3-5 test cases. Return valid JSON only.`,
        }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const testData = JSON.parse(jsonMatch[0]);

      writeFileSync(
        join(this.outputDir, 'test-cases', `${skillId}.json`),
        JSON.stringify({ skillId, skillName: skill.name, category: analysis.categories?.primary, generatedAt: new Date().toISOString(), relatedSkills: relatedSkills.map(r => r.id), ...testData }, null, 2)
      );

      this.stats.testCases += (testData.testCases || []).length;
      metrics.track('generated', { itemId: skillId, itemType: 'test-case', project: analysis.categories?.primary || '' });
      logger.info(`Generated tests for ${skillId}`, { cases: (testData.testCases || []).length });
    } catch (err) {
      logger.error(`Test generation failed for ${skillId}`, { error: err.message });
    }
  }

  async generateTriggerTests() {
    const sessions = this.sessionBuffer;

    const sessionDemand = await this.stores.queryClickHouse(`
      SELECT primary_category, count() as cnt FROM consumer.sessions GROUP BY primary_category ORDER BY cnt DESC LIMIT 10
    `);

    const sessionSummary = sessions.map(s =>
      `- ${s.project}: ${s.category}, topics: ${s.topics.join(', ')}, tools: ${s.tools.map(t => t.name).join(', ')}`
    ).join('\n');

    const demandContext = (sessionDemand || []).map(d =>
      `- ${d.primary_category}: ${d.cnt} sessions`
    ).join('\n');

    const skillSample = [...this.skillIndex.entries()].slice(0, 30)
      .map(([id, s]) => `- ${id}: ${s.name} (${s.category})`)
      .join('\n');

    try {
      const response = await this.claude.messages.create({
        model: config.claude.model,
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `Based on real user sessions and session demand data, generate trigger tests that verify skills activate correctly.

## Session Demand (from ClickHouse analytics)
${demandContext || 'No data'}

## Recent Sessions
${sessionSummary}

## Available Skills (${this.skillIndex.size} total, showing 30)
${skillSample}

Generate JSON:
{
  "triggerTests": [{ "userMessage": "realistic prompt", "expectedSkills": ["skill-id"], "context": "what this simulates", "priority": "high|medium|low" }],
  "coverageGaps": ["pattern that has NO matching skill"]
}
Return valid JSON only.`,
        }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return;

      const data = JSON.parse(jsonMatch[0]);

      writeFileSync(
        join(this.outputDir, 'trigger-tests', `batch-${Date.now()}.json`),
        JSON.stringify({ generatedAt: new Date().toISOString(), sessionCount: sessions.length, skillCount: this.skillIndex.size, ...data }, null, 2)
      );

      this.stats.triggerTests += (data.triggerTests || []).length;
      metrics.track('generated', { itemId: `batch-${Date.now()}`, itemType: 'trigger-test' });

      if (data.coverageGaps?.length) {
        logger.info('Coverage gaps found', { gaps: data.coverageGaps });
      }
    } catch (err) {
      logger.error('Trigger test generation failed', { error: err.message });
    }
  }
}

async function main() {
  const consumer = new EvalConsumer();
  await consumer.init();

  const kafka = new PubSubConsumerGroup('eval-consumer-group', logger);

  kafka
    .on(config.topics.skillsAnalyzed, (msg) => consumer.handleSkillAnalyzed(msg))
    .on(config.topics.sessionsAnalyzed, (msg) => consumer.handleSessionAnalyzed(msg));

  await kafka.start();
  startHealthServer(3006);

  process.on('SIGINT', async () => {
    if (consumer.sessionBuffer.length > 0) {
      await consumer.generateTriggerTests();
    }
    await consumer.stores.close();
    logger.info('Shutting down', consumer.stats);
    await kafka.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
