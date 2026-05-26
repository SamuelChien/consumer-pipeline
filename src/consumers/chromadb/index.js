import { ChromaClient } from 'chromadb';
import { KafkaConsumerGroup } from '../../shared/kafka-consumer.js';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';
import { chunkByHeadings, chunkText } from '../../shared/chunker.js';
import { startHealthServer } from '../../shared/health.js';

const logger = createLogger('chromadb-consumer');

class ChromaDBConsumer {
  constructor() {
    this.client = new ChromaClient({ path: config.chromadb.url });
    this.skillCollection = null;
    this.sessionCollection = null;
    this.stats = { skillChunks: 0, sessionChunks: 0 };
  }

  async init() {
    this.skillCollection = await this.client.getOrCreateCollection({
      name: config.chromadb.collectionSkillChunks,
      metadata: { 'hnsw:space': 'cosine' },
    });

    this.sessionCollection = await this.client.getOrCreateCollection({
      name: config.chromadb.collectionSessionChunks,
      metadata: { 'hnsw:space': 'cosine' },
    });

    logger.info('ChromaDB collections initialized');
  }

  async handleSkillAnalyzed({ key, value }) {
    const skill = value;
    const skillId = skill.id || key;

    const chunks = chunkByHeadings(skill.body || '', {
      skillId,
      name: skill.name,
      category: skill.analysis?.categories?.primary || skill.category || 'uncategorized',
      tier: skill.tier || 'standard',
      platforms: (skill.platforms || []).join(','),
      qualityScore: String(skill.analysis?.qualityScore?.score || 0),
      tags: (skill.tags || []).join(','),
    });

    if (chunks.length === 0) return;

    const ids = chunks.map((_, i) => `${skillId}::chunk-${i}`);
    const documents = chunks.map(c => c.text);
    const metadatas = chunks.map(c => c.metadata);

    await this.skillCollection.upsert({ ids, documents, metadatas });
    this.stats.skillChunks += chunks.length;

    logger.info(`Indexed skill ${skillId}`, { chunks: chunks.length, total: this.stats.skillChunks });
  }

  async handleSessionAnalyzed({ key, value }) {
    const session = value;
    const sessionId = session.sessionId || key;

    const textParts = [];
    if (session.analysis?.topics?.length) {
      textParts.push(`Topics: ${session.analysis.topics.map(t => t.topic).join(', ')}`);
    }
    if (session.analysis?.categories) {
      textParts.push(`Category: ${session.analysis.categories.primary}`);
    }
    if (session.analysis?.toolUsage?.tools?.length) {
      textParts.push(`Tools used: ${session.analysis.toolUsage.tools.map(t => `${t.name}(${t.count})`).join(', ')}`);
    }
    if (session.analysis?.filesAccessed?.length) {
      textParts.push(`Files: ${session.analysis.filesAccessed.slice(0, 20).map(f => f.path).join(', ')}`);
    }
    if (session.analysis?.commands?.topBinaries?.length) {
      textParts.push(`Commands: ${session.analysis.commands.topBinaries.map(c => c.binary).join(', ')}`);
    }

    const summary = textParts.join('\n');
    if (!summary) return;

    const chunks = chunkText(summary, {
      sessionId,
      project: session.project || 'unknown',
      category: session.analysis?.categories?.primary || 'unknown',
      complexity: session.analysis?.complexity?.level || 'unknown',
      durationMinutes: String(session.analysis?.duration?.minutes || 0),
      totalTokens: String(session.analysis?.tokenUsage?.totalTokens || 0),
    });

    const ids = chunks.map((_, i) => `${sessionId}::chunk-${i}`);
    const documents = chunks.map(c => c.text);
    const metadatas = chunks.map(c => c.metadata);

    await this.sessionCollection.upsert({ ids, documents, metadatas });
    this.stats.sessionChunks += chunks.length;

    logger.info(`Indexed session ${sessionId}`, { chunks: chunks.length, total: this.stats.sessionChunks });
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
