import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { PubSubConsumerGroup } from '../../shared/pubsub-consumer.js';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { createMetrics } from '../../shared/metrics.js';
import { startHealthServer } from '../../shared/health.js';

const logger = createLogger('wikipedia-consumer');
const metrics = createMetrics('wikipedia');

class WikipediaConsumer {
  constructor() {
    this.claude = new Anthropic();
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
    const skillId = skill.id || key;
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

    if (skill.allowedTools?.length) {
      lines.push('## Tools');
      lines.push('');
      lines.push(skill.allowedTools.map(t => `\`${t}\``).join(', '));
      lines.push('');
    }

    lines.push('## Content');
    lines.push('');
    lines.push(skill.body || '*No content available*');

    return lines.join('\n');
  }

  async handleSessionAnalyzed({ key, value }) {
    const session = value;
    const sessionId = session.sessionId || key;
    const analysis = session.analysis || {};

    const article = this.buildSessionArticle(session, analysis);
    const filePath = join(this.wikiDir, 'sessions', `${sessionId}.md`);
    writeFileSync(filePath, article);

    const topics = (analysis.topics || []).map(t => t.topic);

    for (const topic of topics) {
      await this.ensureTopicArticle(topic);
    }

    const entry = {
      id: sessionId,
      title: `Session: ${session.project || 'unknown'} (${analysis.categories?.primary || 'unknown'})`,
      type: 'session',
      path: `sessions/${sessionId}.md`,
      category: analysis.categories?.primary || 'unknown',
      keywords: topics,
      project: session.project || 'unknown',
    };

    this.articles.set(sessionId, entry);

    for (const topic of topics) {
      const existing = this.keywords.get(topic) || [];
      if (!existing.includes(sessionId)) {
        existing.push(sessionId);
        this.keywords.set(topic, existing);
      }
    }

    this.stats.articles++;
    if (this.stats.articles % 50 === 0) this.saveIndex();

    logger.info(`Created session article: ${sessionId}`, { topics: topics.length });
  }

  buildSessionArticle(session, analysis) {
    const lines = [];
    lines.push(`# Session: ${session.project || 'Unknown Project'}`);
    lines.push('');

    lines.push('## Summary');
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Project | ${session.project || 'N/A'} |`);
    lines.push(`| Category | ${analysis.categories?.primary || 'N/A'} |`);
    lines.push(`| Complexity | ${analysis.complexity?.level || 'N/A'} |`);
    lines.push(`| Duration | ${analysis.duration?.minutes?.toFixed(1) || 0} min |`);
    lines.push(`| Messages | ${session.messageCount || 0} |`);
    lines.push(`| Total Tokens | ${analysis.tokenUsage?.totalTokens?.toLocaleString() || 0} |`);
    lines.push(`| Tool Calls | ${analysis.toolUsage?.totalToolCalls || 0} |`);
    lines.push('');

    if (analysis.topics?.length) {
      lines.push('## Topics');
      lines.push('');
      for (const t of analysis.topics) {
        lines.push(`- [[${t.topic}]] (score: ${t.score})`);
      }
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

    if (analysis.filesAccessed?.length) {
      lines.push('## Files Accessed');
      lines.push('');
      for (const f of analysis.filesAccessed.slice(0, 20)) {
        lines.push(`- \`${f.path}\` (R:${f.reads} W:${f.writes} E:${f.edits})`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  async ensureTopicArticle(topic) {
    const topicId = topic.replace(/\s+/g, '-').toLowerCase();
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

  const kafka = new PubSubConsumerGroup('wikipedia-consumer-group', logger);

  kafka
    .on(config.topics.skillsAnalyzed, (msg) => consumer.handleSkillAnalyzed(msg))
    .on(config.topics.sessionsAnalyzed, (msg) => consumer.handleSessionAnalyzed(msg));

  await kafka.start();
  startHealthServer(3003);

  process.on('SIGINT', async () => {
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
