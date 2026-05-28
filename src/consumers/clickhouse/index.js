import { createClient } from '@clickhouse/client';
import { PubSubConsumerGroup } from '../../shared/pubsub-consumer.js';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { createMetrics } from '../../shared/metrics.js';
import { startHealthServer } from '../../shared/health.js';

const logger = createLogger('clickhouse-consumer');
const metrics = createMetrics('clickhouse');

class ClickHouseConsumer {
  constructor() {
    this.client = createClient({
      url: config.clickhouse.url,
      username: config.clickhouse.user,
      password: config.clickhouse.password,
      database: config.clickhouse.database,
    });
    this.stats = { skills: 0, sessions: 0, entities: 0, dependencies: 0, tools: 0, files: 0 };
  }

  toArray(val) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string' && val.trim()) return val.split(',').map(s => s.trim()).filter(Boolean);
    return [];
  }

  async handleSkillAnalyzed({ key, value }) {
    const skill = value;
    const analysis = skill.analysis || {};

    await this.client.insert({
      table: 'skills',
      values: [{
        id: skill.sourceId || skill.id || key,
        name: skill.name || '',
        description: (skill.description || '').slice(0, 2000),
        category: analysis.categories?.primary || skill.category || 'uncategorized',
        secondary_category: analysis.categories?.secondary || null,
        tier: skill.tier || 'standard',
        risk: skill.risk || 'safe',
        author: skill.author || 'unknown',
        version: skill.version || '1.0.0',
        platforms: this.toArray(skill.platforms),
        tags: this.toArray(skill.tags),
        allowed_tools: this.toArray(skill.allowedTools),
        quality_score: analysis.qualityScore?.score || 0,
        quality_grade: skill.evaluation?.grade || 'F',
        complexity_level: analysis.complexity?.level || 'basic',
        body_length: skill.bodyLength || 0,
        heading_count: (skill.headings || []).length,
        code_block_count: (skill.codeBlocks || []).length,
        keywords: this.toArray((analysis.keywords || []).map(k => k.word || k)),
        source_collection: skill.sourceCollection || '',
      }],
      format: 'JSONEachRow',
    });

    this.stats.skills++;
    metrics.track('inserted', { itemId: skill.sourceId || skill.id || key, itemType: 'skill', project: skill.sourceCollection || '' });

    const entities = analysis.entities || {};
    const entityRows = [
      ...(Array.isArray(entities.technologies) ? entities.technologies : []).map(t => ({ skill_id: skill.sourceId || skill.id || key, entity_name: t, entity_type: 'technology' })),
      ...(Array.isArray(entities.tools) ? entities.tools : []).map(t => ({ skill_id: skill.sourceId || skill.id || key, entity_name: t, entity_type: 'tool' })),
      ...(Array.isArray(entities.platforms) ? entities.platforms : []).map(t => ({ skill_id: skill.sourceId || skill.id || key, entity_name: t, entity_type: 'platform' })),
      ...(Array.isArray(entities.concepts) ? entities.concepts : []).map(t => ({ skill_id: skill.sourceId || skill.id || key, entity_name: t, entity_type: 'concept' })),
    ];
    if (entityRows.length > 0) {
      try { await this.client.insert({ table: 'skill_entities', values: entityRows, format: 'JSONEachRow' }); } catch {}
    }

    logger.info(`Inserted skill ${skill.sourceId || skill.id || key}`, { total: this.stats.skills });
  }

  async handleSkillEntities({ key, value }) {
    const entities = Array.isArray(value) ? value : [value];

    const rows = entities.map(e => ({
      skill_id: e.skillId || key,
      entity_name: e.name,
      entity_type: e.type,
    }));

    if (rows.length > 0) {
      await this.client.insert({ table: 'skill_entities', values: rows, format: 'JSONEachRow' });
      this.stats.entities += rows.length;
    }
  }

  async handleSkillDependencies({ key, value }) {
    const deps = value.dependencies || [];
    const skillId = value.skillId || key;

    const rows = deps.map(d => ({
      skill_id: skillId,
      depends_on: d.skillId,
      dependency_type: d.type || 'depends_on',
      confidence: d.confidence || 0.5,
    }));

    if (rows.length > 0) {
      await this.client.insert({ table: 'skill_dependencies', values: rows, format: 'JSONEachRow' });
      this.stats.dependencies += rows.length;
    }
  }

  async handleSessionAnalyzed({ key, value }) {
    const session = value;
    const analysis = session.analysis || {};

    await this.client.insert({
      table: 'sessions',
      values: [{
        session_id: session.sessionId || session.sourceId || key,
        project: session.project || 'unknown',
        primary_category: analysis.categories?.primary || 'unknown',
        secondary_category: analysis.categories?.secondary || null,
        complexity_level: analysis.complexity?.level || 'simple',
        message_count: session.messageCount || 0,
        total_tokens: analysis.tokenUsage?.totalTokens || analysis.tokenUsage?.total || 0,
        input_tokens: analysis.tokenUsage?.totalInput || 0,
        output_tokens: analysis.tokenUsage?.totalOutput || 0,
        cache_hit_rate: analysis.tokenUsage?.cacheHitRate || 0,
        total_tool_calls: analysis.toolUsage?.totalToolCalls || 0,
        unique_tools: analysis.toolUsage?.uniqueTools || 0,
        files_accessed: (analysis.filesAccessed || []).length,
        duration_minutes: analysis.duration?.durationMinutes || analysis.duration?.minutes || 0,
        error_count: analysis.errors?.length || 0,
      }],
      format: 'JSONEachRow',
    });

    this.stats.sessions++;
    metrics.track('inserted', { itemId: session.sessionId || session.sourceId || key, itemType: 'session', project: session.project || '' });

    const tools = analysis.toolUsage?.tools || [];
    if (tools.length > 0) {
      const toolRows = tools.map(t => ({ session_id: session.sessionId || session.sourceId || key, tool_name: t.name, call_count: t.count || 1 }));
      try { await this.client.insert({ table: 'session_tools', values: toolRows, format: 'JSONEachRow' }); } catch {}
    }

    const files = analysis.toolUsage?.filesAccessed || [];
    if (files.length > 0) {
      const fileRows = files.slice(0, 50).map(f => ({ session_id: session.sessionId || session.sourceId || key, file_path: f.path, reads: f.reads || 0, writes: f.writes || 0, edits: f.edits || 0 }));
      try { await this.client.insert({ table: 'session_files', values: fileRows, format: 'JSONEachRow' }); } catch {}
    }

    logger.info(`Inserted session ${session.sessionId || session.sourceId || key}`, { total: this.stats.sessions });
  }

  async handleSessionTools({ key, value }) {
    const tools = Array.isArray(value) ? value : (value.tools || []);
    const sessionId = value.sessionId || key;

    const rows = tools.map(t => ({
      session_id: sessionId,
      tool_name: t.name || t.toolName,
      call_count: t.count || 1,
    }));

    if (rows.length > 0) {
      await this.client.insert({ table: 'session_tools', values: rows, format: 'JSONEachRow' });
      this.stats.tools += rows.length;
    }
  }

  async handleSessionFiles({ key, value }) {
    const files = Array.isArray(value) ? value : (value.files || []);
    const sessionId = value.sessionId || key;

    const rows = files.map(f => ({
      session_id: sessionId,
      file_path: f.path,
      reads: f.reads || 0,
      writes: f.writes || 0,
      edits: f.edits || 0,
    }));

    if (rows.length > 0) {
      await this.client.insert({ table: 'session_files', values: rows, format: 'JSONEachRow' });
      this.stats.files += rows.length;
    }
  }
}

async function main() {
  const consumer = new ClickHouseConsumer();
  const pubsub = new PubSubConsumerGroup('clickhouse-consumer-group', logger);

  pubsub
    .on(config.topics.skillsAnalyzed, (msg) => consumer.handleSkillAnalyzed(msg))
    .on(config.topics.sessionsAnalyzed, (msg) => consumer.handleSessionAnalyzed(msg));

  await pubsub.start();

  startHealthServer(3002, {
    clickhouse: async () => { await consumer.client.ping(); },
  });

  process.on('SIGINT', async () => {
    logger.info('Shutting down', consumer.stats);
    await consumer.client.close();
    await pubsub.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
