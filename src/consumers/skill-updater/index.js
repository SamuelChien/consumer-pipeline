import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { PubSubConsumerGroup } from '../../shared/pubsub-consumer.js';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { createMetrics } from '../../shared/metrics.js';
import { startHealthServer } from '../../shared/health.js';
import { StoreClients } from '../../shared/store-clients.js';

const logger = createLogger('skill-updater-consumer');
const metrics = createMetrics('skill-updater');

class SkillUpdaterConsumer {
  constructor() {
    this.claude = new Anthropic();
    this.stores = new StoreClients();
    this.outputDir = join(config.outputDir, 'generated-skills');
    this.sessionBuffer = [];
    this.processedSkillIds = new Set();
    this.stats = { generated: 0, skipped: 0 };
  }

  async init() {
    mkdirSync(join(this.outputDir, 'scripts'), { recursive: true });
    mkdirSync(join(this.outputDir, 'fundamental'), { recursive: true });
    mkdirSync(join(this.outputDir, 'orchestration'), { recursive: true });
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
      tools: (analysis.toolUsage?.tools || []).map(t => t.name),
      commands: (analysis.commands?.topBinaries || []).map(c => c.binary),
      complexity: analysis.complexity?.level,
      tokenCount: analysis.tokenUsage?.totalTokens || 0,
    });

    if (this.sessionBuffer.length >= 10) {
      await this.createSkillsFromContext();
      this.sessionBuffer = [];
    }
  }

  async handleSkillAnalyzed({ key, value }) {
    this.processedSkillIds.add(value.id || key);
  }

  async createSkillsFromContext() {
    const gaps = await this.stores.getGapAnalysis();

    const sessionSummary = this.sessionBuffer.map(s =>
      `- ${s.project}: ${s.category} (${s.complexity}), tools: ${s.tools.join(', ')}, topics: ${s.topics.join(', ')}, tokens: ${s.tokenCount}`
    ).join('\n');

    const categoryBreakdown = (gaps.skillCategories || []).map(c =>
      `- ${c.category}: ${c.cnt} skills, avg quality: ${Math.round(c.avg_quality || 0)}/100`
    ).join('\n');

    const sessionDemand = (gaps.sessionTopics || []).map(t =>
      `- ${t.primary_category}: ${t.sessions} sessions, ${t.tokens} tokens used`
    ).join('\n');

    const lowQuality = (gaps.lowQualitySkills || []).map(s =>
      `- ${s.name} (${s.category}): quality ${s.quality_score}/100`
    ).join('\n');

    const orphanTopics = (gaps.orphanTopics || []).map(t => t.topic).join(', ');

    const hubSkills = (gaps.hubSkills || []).map(s =>
      `- ${s.id} (${s.category}): ${s.connections} connections`
    ).join('\n');

    const isolatedSkills = (gaps.isolatedSkills || []).slice(0, 10).map(s => s.id).join(', ');

    const prompt = `You are a skill architect for Claude Code. Analyze the data below from our skill intelligence pipeline and create NEW skills that fill real gaps.

## DATA FROM 4 STORES:

### 1. USER SESSION DEMAND (from ClickHouse — what users actually do)
${sessionDemand || 'No session data available'}

### 2. RECENT SESSIONS (raw Kafka — current user workflows)
${sessionSummary}

### 3. EXISTING SKILL COVERAGE (from ClickHouse — what we have)
${categoryBreakdown || 'No skill data available'}

### 4. LOW QUALITY SKILLS NEEDING REPLACEMENT (from ClickHouse)
${lowQuality || 'None found'}

### 5. GRAPH ANALYSIS (from Neo4j)
**Hub skills** (most connected — build on these):
${hubSkills || 'No graph data'}

**Isolated skills** (no connections — may need linking):
${isolatedSkills || 'None'}

**Orphan topics** (topics with no skills):
${orphanTopics || 'None'}

### 6. EXISTING SKILL COUNT: ${this.processedSkillIds.size}

## INSTRUCTIONS:
- Create skills that fill GAPS between what users DO (sessions) and what skills EXIST
- If a category has high session demand but low skill count/quality, prioritize it
- If orphan topics exist, create skills for them
- Do NOT duplicate existing skills (${this.processedSkillIds.size} already exist)
- Each skill must have: name, description, category, complete instructions body

Return JSON:
{
  "analysis": "2-3 sentence gap analysis explaining what's missing",
  "skills": [
    {
      "name": "skill-name",
      "type": "script|fundamental|orchestration",
      "description": "what this skill does",
      "category": "the category",
      "tags": ["tag1", "tag2"],
      "tools": ["Read", "Bash", "Edit"],
      "body": "Full SKILL.md content with ## sections, examples, and instructions"
    }
  ]
}

Generate 2-4 high-quality skills. Each body should be 500+ words with real, actionable instructions.`;

    try {
      const response = await this.claude.messages.create({
        model: config.claude.model,
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('No valid JSON in Claude response');
        return;
      }

      const result = JSON.parse(jsonMatch[0]);
      logger.info('Gap analysis', { analysis: result.analysis });

      for (const skill of (result.skills || [])) {
        const id = (skill.name || 'unnamed').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

        if (this.processedSkillIds.has(id)) {
          this.stats.skipped++;
          continue;
        }

        const typeDir = skill.type === 'orchestration' ? 'orchestration' : skill.type === 'fundamental' ? 'fundamental' : 'scripts';

        const content = [
          '---',
          `name: ${skill.name}`,
          `description: ${skill.description || ''}`,
          `category: ${skill.category || 'productivity'}`,
          `tags: [${(Array.isArray(skill.tags) ? skill.tags : []).join(', ')}]`,
          `allowed-tools: [${(skill.tools || []).join(', ')}]`,
          `tier: standard`,
          `type: ${skill.type || 'script'}`,
          `generated: true`,
          `generated_at: ${new Date().toISOString()}`,
          `generated_from: gap-analysis`,
          '---',
          '',
          skill.body || `# ${skill.name}\n\n${skill.description}`,
        ].join('\n');

        writeFileSync(join(this.outputDir, typeDir, `${id}.md`), content);
        this.stats.generated++;
        metrics.track('generated', { itemId: id, itemType: `skill-${skill.type}`, project: 'gap-analysis' });
        logger.info(`Generated ${skill.type} skill: ${id}`);
      }
    } catch (err) {
      logger.error('Skill generation failed', { error: err.message });
    }
  }
}

async function main() {
  const consumer = new SkillUpdaterConsumer();
  await consumer.init();

  const kafka = new PubSubConsumerGroup('skill-updater-consumer-group', logger);

  kafka
    .on(config.topics.sessionsAnalyzed, (msg) => consumer.handleSessionAnalyzed(msg))
    .on(config.topics.skillsAnalyzed, (msg) => consumer.handleSkillAnalyzed(msg));

  await kafka.start();
  startHealthServer(3005);

  process.on('SIGINT', async () => {
    if (consumer.sessionBuffer.length > 0) {
      await consumer.createSkillsFromContext();
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
