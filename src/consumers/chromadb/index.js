import { KafkaConsumerGroup } from '../../shared/kafka-consumer.js';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { startHealthServer } from '../../shared/health.js';

const logger = createLogger('chromadb-consumer');

class ChromaHTTPClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiBase = '/api/v2/tenants/default_tenant/databases/default_database';
  }

  async request(method, path, body) {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ChromaDB ${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async heartbeat() {
    return this.request('GET', '/api/v1/heartbeat');
  }

  async getOrCreateCollection(name) {
    const result = await this.request('POST', `${this.apiBase}/collections?get_or_create=true`, {
      name,
      metadata: { 'hnsw:space': 'cosine' },
      get_or_create: true,
    });
    return result.id;
  }

  async upsert(collectionId, ids, documents, metadatas) {
    await this.request('POST', `${this.apiBase}/collections/${collectionId}/upsert`, {
      ids,
      documents,
      metadatas,
    });
  }
}

class ChromaDBConsumer {
  constructor() {
    this.client = new ChromaHTTPClient(config.chromadb.url);
    this.skillCollectionId = null;
    this.sessionCollectionId = null;
    this.stats = { skillChunks: 0, sessionChunks: 0 };
  }

  async init() {
    this.skillCollectionId = await this.client.getOrCreateCollection(config.chromadb.collectionSkillChunks);
    this.sessionCollectionId = await this.client.getOrCreateCollection(config.chromadb.collectionSessionChunks);
    logger.info('ChromaDB collections initialized', {
      skills: this.skillCollectionId,
      sessions: this.sessionCollectionId,
    });
  }

  async handleSkillAnalyzed({ key, value }) {
    const skill = value;
    const skillId = skill.id || key;
    const doc = (skill.description || '') + '\n' + (skill.body || '').slice(0, 3000);
    if (!doc.trim()) return;

    const meta = {
      skillId,
      name: skill.name || skillId,
      category: skill.analysis?.categories?.primary || skill.category || 'uncategorized',
      tier: skill.tier || 'standard',
      tags: (skill.tags || []).slice(0, 5).join(','),
    };

    await this.client.upsert(this.skillCollectionId, [skillId], [doc], [meta]);
    this.stats.skillChunks++;

    if (this.stats.skillChunks % 50 === 0) {
      logger.info(`Skills indexed: ${this.stats.skillChunks}`);
    }
  }

  async handleSessionAnalyzed({ key, value }) {
    const session = value;
    const sessionId = session.sessionId || key;
    const analysis = session.analysis || {};

    const doc = [
      analysis.categories?.primary || '',
      (analysis.topics || []).map(t => t.topic).join(', '),
      (analysis.toolUsage?.tools || []).map(t => t.name).join(', '),
    ].filter(Boolean).join('. ');

    if (!doc) return;

    const meta = {
      sessionId,
      project: session.project || 'unknown',
      category: analysis.categories?.primary || 'unknown',
      complexity: analysis.complexity?.level || 'unknown',
    };

    await this.client.upsert(this.sessionCollectionId, [sessionId], [doc], [meta]);
    this.stats.sessionChunks++;

    if (this.stats.sessionChunks % 20 === 0) {
      logger.info(`Sessions indexed: ${this.stats.sessionChunks}`);
    }
  }
}

async function main() {
  const consumer = new ChromaDBConsumer();
  await consumer.init();

  const kafka = new KafkaConsumerGroup('chromadb-consumer-group', logger);

  kafka
    .on(config.topics.skillsAnalyzed, (msg) => consumer.handleSkillAnalyzed(msg))
    .on(config.topics.sessionsAnalyzed, (msg) => consumer.handleSessionAnalyzed(msg));

  await kafka.start();

  startHealthServer(3001, {
    chromadb: () => consumer.client.heartbeat(),
  });

  process.on('SIGINT', async () => {
    logger.info('Shutting down', consumer.stats);
    await kafka.stop();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
