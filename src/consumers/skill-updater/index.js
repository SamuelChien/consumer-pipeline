import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { KafkaConsumerGroup } from '../../shared/kafka-consumer.js';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('skill-updater-consumer');

class SkillUpdaterConsumer {
  constructor() {
    this.claude = new Anthropic();
    this.outputDir = join(config.outputDir, 'generated-skills');
    this.sessionBuffer = [];
    this.skillGaps = new Map();
    this.stats = { scripts: 0, fundamental: 0, orchestration: 0 };
  }

  init() {
    mkdirSync(join(this.outputDir, 'scripts'), { recursive: true });
    mkdirSync(join(this.outputDir, 'fundamental'), { recursive: true });
    mkdirSync(join(this.outputDir, 'orchestration'), { recursive: true });
    mkdirSync(join(this.outputDir, 'queue'), { recursive: true });
  }

  async handleSessionAnalyzed({ key, value }) {
    const session = value;
    const analysis = session.analysis || {};
    const sessionId = session.sessionId || key;

    this.sessionBuffer.push({
      sessionId,
      project: session.project,
      category: analysis.categories?.primary,
      topics: (analysis.topics || []).map(t => t.topic),
      tools: (analysis.toolUsage?.tools || []).map(t => t.name),
      files: (analysis.filesAccessed || []).slice(0, 10).map(f => f.path),
      commands: (analysis.commands?.topBinaries || []).map(c => c.binary),
      complexity: analysis.complexity?.level,
    });

    if (this.sessionBuffer.length >= 10) {
      await this.analyzeGapsAndGenerate();
      this.sessionBuffer = [];
    }
  }

  async handleSkillAnalyzed({ key, value }) {
    const skill = value;
    const analysis = skill.analysis || {};
    const qualityScore = analysis.qualityScore?.score || 0;

    if (qualityScore < 40) {
      this.skillGaps.set(skill.id || key, {
        skillId: skill.id || key,
        name: skill.name,
        category: analysis.categories?.primary,
        qualityScore,
        missingElements: this.identifyMissing(skill),
      });
    }
  }

  identifyMissing(skill) {
    const missing = [];
    if (!skill.description) missing.push('description');
    if (!(skill.headings || []).length) missing.push('headings');
    if (!(skill.codeBlocks || []).length) missing.push('code-examples');
    if (!(skill.tags || []).length) missing.push('tags');
    if ((skill.bodyLength || 0) < 500) missing.push('content-depth');
    if (!(skill.allowedTools || []).length) missing.push('tool-permissions');
    return missing;
  }

  async analyzeGapsAndGenerate() {
    const sessionSummary = this.sessionBuffer.map(s =>
      `- ${s.project}: ${s.category} session using ${s.tools.join(', ')} on topics ${s.topics.join(', ')}`
    ).join('\n');

    const existingGaps = [...this.skillGaps.values()].slice(0, 10);
    const gapsSummary = existingGaps.map(g =>
      `- ${g.name} (${g.category}): quality ${g.qualityScore}/100, missing: ${g.missingElements.join(', ')}`
    ).join('\n');

    try {
      const response = await this.claude.messages.create({
        model: config.claude.model,
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: `Analyze these recent Claude Code sessions and existing skill gaps to recommend new skills to create.

## Recent Sessions
${sessionSummary}

## Low-Quality Skills Needing Improvement
${gapsSummary}

Respond with a JSON object containing:
1. "scripts": Array of quick-use script skills (bash/CLI utilities). Each: {name, description, category, tools, body}
2. "fundamental": Array of foundational skills for common patterns. Each: {name, description, category, prerequisites, body}
3. "orchestration": Array of workflow orchestration skills that chain multiple skills. Each: {name, description, steps, triggers, body}

Focus on gaps where users needed skills that don't exist or are low quality. Generate 1-2 per category max.
Return valid JSON only.`,
        }],
      });

      const text = response.content[0]?.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn('No valid JSON in Claude response');
        return;
      }

      const recommendations = JSON.parse(jsonMatch[0]);
      await this.writeGeneratedSkills(recommendations);
    } catch (err) {
      logger.error('Claude analysis failed', { error: err.message });
    }
  }

  async writeGeneratedSkills(recommendations) {
    for (const script of (recommendations.scripts || [])) {
      const id = this.toSlug(script.name);
      const content = this.buildSkillMd(script, 'script');
      writeFileSync(join(this.outputDir, 'scripts', `${id}.md`), content);
      this.stats.scripts++;
      logger.info(`Generated script skill: ${id}`);
    }

    for (const fundamental of (recommendations.fundamental || [])) {
      const id = this.toSlug(fundamental.name);
      const content = this.buildSkillMd(fundamental, 'fundamental');
      writeFileSync(join(this.outputDir, 'fundamental', `${id}.md`), content);
      this.stats.fundamental++;
      logger.info(`Generated fundamental skill: ${id}`);
    }

    for (const orch of (recommendations.orchestration || [])) {
      const id = this.toSlug(orch.name);
      const content = this.buildSkillMd(orch, 'orchestration');
      writeFileSync(join(this.outputDir, 'orchestration', `${id}.md`), content);
      this.stats.orchestration++;
      logger.info(`Generated orchestration skill: ${id}`);
    }
  }

  toSlug(name) {
    return (name || 'unnamed')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  buildSkillMd(skill, type) {
    const lines = [];
    lines.push('---');
    lines.push(`name: ${skill.name}`);
    lines.push(`description: ${skill.description || ''}`);
    lines.push(`category: ${skill.category || type}`);
    lines.push(`tier: standard`);
    lines.push(`type: ${type}`);
    lines.push(`generated: true`);
    lines.push(`generated_at: ${new Date().toISOString()}`);
    if (skill.tools) lines.push(`allowed-tools: [${skill.tools.join(', ')}]`);
    if (skill.prerequisites) lines.push(`prerequisites: [${skill.prerequisites.join(', ')}]`);
    if (skill.triggers) lines.push(`triggers: [${skill.triggers.join(', ')}]`);
    lines.push('---');
    lines.push('');
    lines.push(`# ${skill.name}`);
    lines.push('');
    lines.push(skill.description || '');
    lines.push('');

    if (skill.steps) {
      lines.push('## Workflow Steps');
      lines.push('');
      for (const step of skill.steps) {
        lines.push(`1. ${step}`);
      }
      lines.push('');
    }

    if (skill.body) {
      lines.push('## Instructions');
      lines.push('');
      lines.push(skill.body);
    }

    return lines.join('\n');
  }
}

async function main() {
  const consumer = new SkillUpdaterConsumer();
  consumer.init();

  const kafka = new KafkaConsumerGroup('skill-updater-consumer-group', logger);

  kafka
    .on(config.topics.sessionsAnalyzed, (msg) => consumer.handleSessionAnalyzed(msg))
    .on(config.topics.skillsAnalyzed, (msg) => consumer.handleSkillAnalyzed(msg));

  await kafka.start();

  process.on('SIGINT', async () => {
    if (consumer.sessionBuffer.length > 0) {
      await consumer.analyzeGapsAndGenerate();
    }
    logger.info('Shutting down', consumer.stats);
    await kafka.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
