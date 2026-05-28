import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PubSubConsumerGroup } from '../../shared/pubsub-consumer.js';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { createMetrics } from '../../shared/metrics.js';
import { startHealthServer } from '../../shared/health.js';

const logger = createLogger('wikipedia-consumer');
const metrics = createMetrics('wikipedia');

class WikipediaConsumer {
  constructor() {
    this.wikiDir = join(config.outputDir, 'wiki');
    this.indexPath = join(this.wikiDir, '_index.json');
    this.articles = new Map();
    this.keywords = new Map();
    this.stats = { articles: 0, links: 0 };
  }

  init() {
    mkdirSync(join(this.wikiDir, 'skills'), { recursive: true });
    mkdirSync(join(this.wikiDir, 'topics'), { recursive: true });
    mkdirSync(join(this.wikiDir, 'code'), { recursive: true });
    mkdirSync(join(this.wikiDir, 'sessions'), { recursive: true });

    if (existsSync(this.indexPath)) {
      const data = JSON.parse(readFileSync(this.indexPath, 'utf-8'));
      for (const [k, v] of Object.entries(data.articles || {})) this.articles.set(k, v);
      for (const [k, v] of Object.entries(data.keywords || {})) this.keywords.set(k, v);
      logger.info('Loaded existing index', { articles: this.articles.size, keywords: this.keywords.size });
    }
  }

  saveIndex() {
    writeFileSync(this.indexPath, JSON.stringify({
      articles: Object.fromEntries(this.articles),
      keywords: Object.fromEntries(this.keywords),
      generatedAt: new Date().toISOString(),
    }, null, 2));
  }

  async handleSkillAnalyzed({ key, value }) {
    const skill = value;
    const skillId = skill.sourceId || skill.id || key;
    const analysis = skill.analysis || {};

    const article = this.buildSkillArticle(skill, analysis);
    const filePath = join(this.wikiDir, 'skills', `${skillId}.md`);
    writeFileSync(filePath, article);

    const entry = {
      id: skillId,
      title: skill.name || skillId,
      type: 'skill',
      path: `skills/${skillId}.md`,
      category: analysis.categories?.primary || 'uncategorized',
      keywords: (analysis.keywords || []).slice(0, 10).map(k => k.word || k),
      tags: skill.tags || [],
      platforms: skill.platforms || [],
    };

    this.articles.set(skillId, entry);

    for (const kw of entry.keywords) {
      const existing = this.keywords.get(kw) || [];
      if (!existing.includes(skillId)) {
        existing.push(skillId);
        this.keywords.set(kw, existing);
      }
    }

    this.stats.articles++;
    if (this.stats.articles % 50 === 0) this.saveIndex();

    logger.info(`Created skill article: ${skillId}`, { keywords: entry.keywords.length });
  }

  buildSkillArticle(skill, analysis) {
    const lines = [];
    lines.push(`# ${skill.name || skill.id}`);
    lines.push('');

    if (skill.description) {
      lines.push(`> ${skill.description}`);
      lines.push('');
    }

    lines.push('## Overview');
    lines.push('');
    lines.push(`| Property | Value |`);
    lines.push(`|----------|-------|`);
    lines.push(`| Category | ${analysis.categories?.primary || 'N/A'} |`);
    lines.push(`| Tier | ${skill.tier || 'standard'} |`);
    lines.push(`| Complexity | ${analysis.complexity?.level || 'N/A'} |`);
    lines.push(`| Quality Score | ${analysis.qualityScore?.score || 0}/100 |`);
    lines.push(`| Platforms | ${(skill.platforms || []).join(', ') || 'universal'} |`);
    lines.push('');

    if (skill.tags?.length) {
      lines.push(`**Tags:** ${skill.tags.map(t => `\`${t}\``).join(' ')}`);
      lines.push('');
    }

    if (analysis.keywords?.length) {
      lines.push('## Keywords');
      lines.push('');
      const kwLinks = analysis.keywords.slice(0, 15).map(k => {
        const word = k.word || k;
        return `[[${word}]]`;
      });
      lines.push(kwLinks.join(' | '));
      lines.push('');
    }

    if (analysis.dependencies?.length) {
      lines.push('## Dependencies');
      lines.push('');
      for (const dep of analysis.dependencies) {
        lines.push(`- [[${dep.skillId}]] (${dep.type}, confidence: ${dep.confidence})`);
      }
      lines.push('');
    }

    const tools = Array.isArray(skill.allowedTools) ? skill.allowedTools : typeof skill.allowedTools === 'string' ? skill.allowedTools.split(',').map(s => s.trim()).filter(Boolean) : [];
    if (tools.length) {
      lines.push('## Tools');
      lines.push('');
      lines.push(tools.map(t => `\`${t}\``).join(', '));
      lines.push('');
    }

    lines.push('## Content');
    lines.push('');
    lines.push(skill.body || '*No content available*');

    return lines.join('\n');
  }

  async handleSessionAnalyzed({ key, value }) {
    const session = value;
    const sessionId = session.sessionId || session.sourceId || key;
    const analysis = session.analysis || {};
    const deep = session.deep || {};

    const article = this.buildSessionArticle(session, analysis, deep);
    const filePath = join(this.wikiDir, 'sessions', `${sessionId}.md`);
    writeFileSync(filePath, article);

    const keywords = [];
    for (const t of (analysis.topics || [])) keywords.push(t.topic);
    for (const c of (deep.connections?.relatedConcepts || [])) keywords.push(c);
    for (const s of (deep.fundamentalSkillsNeeded || [])) keywords.push(s.skill);
    if (deep.projectContext?.techStack) keywords.push(...deep.projectContext.techStack);

    const uniqueKeywords = [...new Set(keywords.map(k => k.toLowerCase()))];

    for (const topic of uniqueKeywords) {
      await this.ensureTopicArticle(topic);
    }

    const entry = {
      id: sessionId,
      title: deep.userGoal ? deep.userGoal.slice(0, 80) : `Session: ${session.project || 'unknown'}`,
      type: 'session',
      path: `sessions/${sessionId}.md`,
      category: analysis.categories?.primary || 'unknown',
      keywords: uniqueKeywords,
      project: session.project || 'unknown',
    };

    this.articles.set(sessionId, entry);

    for (const kw of uniqueKeywords) {
      const existing = this.keywords.get(kw) || [];
      if (!existing.includes(sessionId)) {
        existing.push(sessionId);
        this.keywords.set(kw, existing);
      }
    }

    this.stats.articles++;
    if (this.stats.articles % 50 === 0) this.saveIndex();

    logger.info(`Created session article: ${sessionId}`, { keywords: uniqueKeywords.length });
  }

  buildSessionArticle(session, analysis, deep) {
    const lines = [];
    const goal = deep.userGoal || `Session in ${session.project || 'unknown'}`;
    lines.push(`# ${goal}`);
    lines.push('');

    if (deep.whatTheyBuilt) {
      lines.push(`> ${deep.whatTheyBuilt}`);
      lines.push('');
    }

    lines.push('## Context');
    lines.push('');
    lines.push(`| | |`);
    lines.push(`|---|---|`);
    if (deep.projectContext?.projectName) lines.push(`| **Project** | ${deep.projectContext.projectName} |`);
    if (deep.projectContext?.projectType) lines.push(`| **Type** | ${deep.projectContext.projectType} |`);
    if (deep.projectContext?.stage) lines.push(`| **Stage** | ${deep.projectContext.stage} |`);
    lines.push(`| **Duration** | ${analysis.duration?.minutes?.toFixed(0) || 0} min |`);
    lines.push(`| **Messages** | ${session.messageCount || 0} |`);
    lines.push(`| **Tokens** | ${(analysis.tokenUsage?.totalTokens || 0).toLocaleString()} |`);
    lines.push(`| **Tool Calls** | ${analysis.toolUsage?.totalToolCalls || 0} |`);
    if (deep.sessionQuality?.outcome) lines.push(`| **Outcome** | ${deep.sessionQuality.outcome} |`);
    lines.push('');

    if (deep.projectContext?.techStack?.length) {
      lines.push('## Tech Stack');
      lines.push('');
      lines.push(deep.projectContext.techStack.map(t => `[[${t}]]`).join(' · '));
      lines.push('');
    }

    if (deep.problems?.length) {
      lines.push('## Problems Encountered');
      lines.push('');
      for (const p of deep.problems) {
        lines.push(`- **${p.severity}**: ${p.description}`);
        if (p.resolution) lines.push(`  - *Resolution:* ${p.resolution}`);
      }
      lines.push('');
    }

    if (deep.struggles?.length) {
      lines.push('## Struggles & Skill Gaps');
      lines.push('');
      for (const s of deep.struggles) {
        lines.push(`- **${s.area}**: ${s.evidence}`);
        if (s.skillGap) lines.push(`  - *Gap:* ${s.skillGap}`);
      }
      lines.push('');
    }

    if (deep.fundamentalSkillsNeeded?.length) {
      lines.push('## Skills Needed');
      lines.push('');
      for (const s of deep.fundamentalSkillsNeeded) {
        lines.push(`- [[${s.skill}]] (${s.category}, ${s.proficiencyLevel}) — ${s.reason}`);
      }
      lines.push('');
    }

    if (deep.orchestrationPattern) {
      lines.push('## Workflow Pattern');
      lines.push('');
      lines.push(`\`${deep.orchestrationPattern.workflow || ''}\``);
      lines.push('');
      if (deep.orchestrationPattern.steps?.length) {
        for (const step of deep.orchestrationPattern.steps) {
          lines.push(`1. ${step}`);
        }
        lines.push('');
      }
    }

    if (deep.connections?.relatedConcepts?.length) {
      lines.push('## Related Concepts');
      lines.push('');
      lines.push(deep.connections.relatedConcepts.map(c => `[[${c}]]`).join(' · '));
      lines.push('');
    }

    if (deep.connections?.nextSteps?.length) {
      lines.push('## Next Steps');
      lines.push('');
      for (const step of deep.connections.nextSteps) {
        lines.push(`- ${step}`);
      }
      lines.push('');
    }

    if (deep.sessionQuality?.keyInsight) {
      lines.push('## Key Insight');
      lines.push('');
      lines.push(`> ${deep.sessionQuality.keyInsight}`);
      lines.push('');
    }

    if (analysis.toolUsage?.tools?.length) {
      lines.push('## Tools Used');
      lines.push('');
      for (const t of analysis.toolUsage.tools.slice(0, 10)) {
        lines.push(`- \`${t.name}\` — ${t.count} calls`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  async ensureTopicArticle(topic) {
    const topicId = topic.replace(/[^a-z0-9\-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    const filePath = join(this.wikiDir, 'topics', `${topicId}.md`);

    if (existsSync(filePath)) return;

    const relatedArticles = this.keywords.get(topic) || [];
    const lines = [];
    lines.push(`# ${topic}`);
    lines.push('');
    lines.push(`Topic page for **${topic}**. This article aggregates skills, sessions, and code related to this topic.`);
    lines.push('');

    if (relatedArticles.length) {
      lines.push('## Related Articles');
      lines.push('');
      for (const articleId of relatedArticles.slice(0, 30)) {
        const article = this.articles.get(articleId);
        if (article) {
          lines.push(`- [[${articleId}]] — ${article.title} (${article.type})`);
        }
      }
      lines.push('');
    }

    lines.push('## See Also');
    lines.push('');
    lines.push('*This page is automatically updated as new skills and sessions are processed.*');

    writeFileSync(filePath, lines.join('\n'));
    logger.info(`Created topic article: ${topicId}`);
  }
}

async function main() {
  const consumer = new WikipediaConsumer();
  consumer.init();

  const pubsub = new PubSubConsumerGroup('wikipedia-consumer-group', logger);

  pubsub
    .on(config.topics.skillsAnalyzed, (msg) => consumer.handleSkillAnalyzed(msg))
    .on(config.topics.sessionsAnalyzed, (msg) => consumer.handleSessionAnalyzed(msg));

  await pubsub.start();
  startHealthServer(3003);

  process.on('SIGINT', async () => {
    consumer.saveIndex();
    logger.info('Shutting down', consumer.stats);
    await pubsub.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
