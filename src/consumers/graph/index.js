import neo4j from 'neo4j-driver';
import { BM25 } from './bm25.js';
import { KafkaConsumerGroup } from '../../shared/kafka-consumer.js';
import { config } from '../../shared/config.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('graph-consumer');

class GraphConsumer {
  constructor() {
    this.driver = neo4j.driver(
      config.neo4j.uri,
      neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
    );
    this.bm25 = new BM25();
    this.stats = { nodes: 0, edges: 0, rankings: 0 };
  }

  async init() {
    const session = this.driver.session();
    try {
      await session.run('CREATE CONSTRAINT skill_id IF NOT EXISTS FOR (s:Skill) REQUIRE s.id IS UNIQUE');
      await session.run('CREATE CONSTRAINT article_id IF NOT EXISTS FOR (a:Article) REQUIRE a.id IS UNIQUE');
      await session.run('CREATE CONSTRAINT workflow_id IF NOT EXISTS FOR (w:Workflow) REQUIRE w.id IS UNIQUE');
      await session.run('CREATE CONSTRAINT keyword_name IF NOT EXISTS FOR (k:Keyword) REQUIRE k.name IS UNIQUE');
      await session.run('CREATE CONSTRAINT topic_name IF NOT EXISTS FOR (t:Topic) REQUIRE t.name IS UNIQUE');
      await session.run('CREATE INDEX skill_category IF NOT EXISTS FOR (s:Skill) ON (s.category)');
      await session.run('CREATE INDEX skill_rank IF NOT EXISTS FOR (s:Skill) ON (s.pageRank)');
      logger.info('Neo4j constraints and indexes created');
    } finally {
      await session.close();
    }
  }

  async handleSkillAnalyzed({ key, value }) {
    const skill = value;
    const skillId = skill.id || key;
    const analysis = skill.analysis || {};
    const session = this.driver.session();

    try {
      await session.run(`
        MERGE (s:Skill {id: $id})
        SET s.name = $name,
            s.category = $category,
            s.tier = $tier,
            s.qualityScore = $qualityScore,
            s.complexity = $complexity,
            s.bodyLength = $bodyLength,
            s.updatedAt = datetime()
      `, {
        id: skillId,
        name: skill.name || skillId,
        category: analysis.categories?.primary || 'uncategorized',
        tier: skill.tier || 'standard',
        qualityScore: neo4j.int(analysis.qualityScore?.score || 0),
        complexity: analysis.complexity?.level || 'basic',
        bodyLength: neo4j.int(skill.bodyLength || 0),
      });

      const keywords = (analysis.keywords || []).slice(0, 15);
      for (const kw of keywords) {
        const word = kw.word || kw;
        const count = kw.count || 1;
        await session.run(`
          MERGE (k:Keyword {name: $name})
          WITH k
          MATCH (s:Skill {id: $skillId})
          MERGE (s)-[r:HAS_KEYWORD]->(k)
          SET r.weight = $weight
        `, { name: word, skillId, weight: count });
        this.stats.edges++;
      }

      const tags = skill.tags || [];
      for (const tag of tags.slice(0, 20)) {
        await session.run(`
          MERGE (t:Topic {name: $name})
          WITH t
          MATCH (s:Skill {id: $skillId})
          MERGE (s)-[:ABOUT_TOPIC]->(t)
        `, { name: tag, skillId });
        this.stats.edges++;
      }

      if (analysis.dependencies?.length) {
        for (const dep of analysis.dependencies) {
          await session.run(`
            MATCH (a:Skill {id: $from})
            MERGE (b:Skill {id: $to})
            MERGE (a)-[r:DEPENDS_ON]->(b)
            SET r.confidence = $confidence, r.type = $type
          `, {
            from: skillId,
            to: dep.skillId,
            confidence: dep.confidence || 0.5,
            type: dep.type || 'depends_on',
          });
          this.stats.edges++;
        }
      }

      this.bm25.addDocument(skillId, [
        skill.name || '',
        skill.description || '',
        (skill.tags || []).join(' '),
        (keywords.map(k => k.word || k)).join(' '),
      ].join(' '));

      this.stats.nodes++;
      logger.info(`Graph: skill ${skillId}`, { edges: this.stats.edges });
    } finally {
      await session.close();
    }
  }

  async handleSessionAnalyzed({ key, value }) {
    const sessionData = value;
    const sessionId = sessionData.sessionId || key;
    const analysis = sessionData.analysis || {};
    const session = this.driver.session();

    try {
      await session.run(`
        MERGE (a:Article {id: $id})
        SET a.type = 'session',
            a.project = $project,
            a.category = $category,
            a.complexity = $complexity,
            a.tokenCount = $tokens,
            a.updatedAt = datetime()
      `, {
        id: sessionId,
        project: sessionData.project || 'unknown',
        category: analysis.categories?.primary || 'unknown',
        complexity: analysis.complexity?.level || 'simple',
        tokens: neo4j.int(analysis.tokenUsage?.totalTokens || 0),
      });

      const topics = analysis.topics || [];
      for (const t of topics) {
        await session.run(`
          MERGE (topic:Topic {name: $name})
          WITH topic
          MATCH (a:Article {id: $articleId})
          MERGE (a)-[r:ABOUT_TOPIC]->(topic)
          SET r.score = $score
        `, { name: t.topic, articleId: sessionId, score: t.score || 0 });
        this.stats.edges++;
      }

      const tools = analysis.toolUsage?.tools || [];
      for (const tool of tools.slice(0, 10)) {
        await session.run(`
          MERGE (t:Tool {name: $name})
          WITH t
          MATCH (a:Article {id: $articleId})
          MERGE (a)-[r:USED_TOOL]->(t)
          SET r.count = $count
        `, { name: tool.name, articleId: sessionId, count: neo4j.int(tool.count) });
        this.stats.edges++;
      }

      this.bm25.addDocument(sessionId, [
        sessionData.project || '',
        analysis.categories?.primary || '',
        topics.map(t => t.topic).join(' '),
        tools.map(t => t.name).join(' '),
      ].join(' '));

      this.stats.nodes++;
    } finally {
      await session.close();
    }
  }

  async computePageRank() {
    const session = this.driver.session();
    try {
      const result = await session.run(`
        MATCH (s:Skill)
        OPTIONAL MATCH (s)-[:DEPENDS_ON]->(dep:Skill)
        OPTIONAL MATCH (other:Skill)-[:DEPENDS_ON]->(s)
        RETURN s.id as id,
               count(DISTINCT dep) as outDegree,
               count(DISTINCT other) as inDegree
      `);

      const scores = new Map();
      const dampingFactor = 0.85;
      const iterations = 20;
      const nodes = result.records.map(r => ({
        id: r.get('id'),
        inDegree: r.get('inDegree').toNumber(),
        outDegree: r.get('outDegree').toNumber(),
      }));

      const n = nodes.length;
      if (n === 0) return;

      for (const node of nodes) {
        scores.set(node.id, 1 / n);
      }

      for (let i = 0; i < iterations; i++) {
        const newScores = new Map();
        for (const node of nodes) {
          const incomingRank = node.inDegree > 0
            ? (dampingFactor * node.inDegree) / n
            : 0;
          newScores.set(node.id, (1 - dampingFactor) / n + incomingRank);
        }
        for (const [id, score] of newScores) scores.set(id, score);
      }

      for (const [id, score] of scores) {
        await session.run(
          'MATCH (s:Skill {id: $id}) SET s.pageRank = $rank',
          { id, rank: score }
        );
        this.stats.rankings++;
      }

      logger.info(`PageRank computed for ${scores.size} nodes`);
    } finally {
      await session.close();
    }
  }

  async connectSimilarSkills() {
    const session = this.driver.session();
    try {
      await session.run(`
        MATCH (a:Skill)-[:HAS_KEYWORD]->(k:Keyword)<-[:HAS_KEYWORD]-(b:Skill)
        WHERE a.id < b.id
        WITH a, b, count(k) as sharedKeywords
        WHERE sharedKeywords >= 3
        MERGE (a)-[r:SIMILAR_TO]-(b)
        SET r.sharedKeywords = sharedKeywords,
            r.score = toFloat(sharedKeywords) / 10.0
      `);

      await session.run(`
        MATCH (a:Skill)-[:ABOUT_TOPIC]->(t:Topic)<-[:ABOUT_TOPIC]-(b:Skill)
        WHERE a.id < b.id
        WITH a, b, count(t) as sharedTopics
        WHERE sharedTopics >= 2
        MERGE (a)-[r:RELATED_TO]-(b)
        SET r.sharedTopics = sharedTopics
      `);

      const skillArticles = await session.run(`
        MATCH (s:Skill)-[:ABOUT_TOPIC]->(t:Topic)<-[:ABOUT_TOPIC]-(a:Article)
        WITH s, a, count(t) as overlap
        WHERE overlap >= 1
        MERGE (s)-[r:RELEVANT_TO]->(a)
        SET r.topicOverlap = overlap
        RETURN count(r) as connections
      `);

      const connections = skillArticles.records[0]?.get('connections')?.toNumber() || 0;
      logger.info(`Connected similar skills and articles`, { connections });
    } finally {
      await session.close();
    }
  }

  async runRankingPass() {
    await this.computePageRank();
    await this.connectSimilarSkills();
    logger.info('Ranking pass complete', this.stats);
  }
}

async function main() {
  const consumer = new GraphConsumer();
  await consumer.init();

  const kafka = new KafkaConsumerGroup('graph-consumer-group', logger);

  kafka
    .on(config.topics.skillsAnalyzed, (msg) => consumer.handleSkillAnalyzed(msg))
    .on(config.topics.sessionsAnalyzed, (msg) => consumer.handleSessionAnalyzed(msg));

  await kafka.start();

  setInterval(() => consumer.runRankingPass(), 5 * 60 * 1000);

  process.on('SIGINT', async () => {
    await consumer.runRankingPass();
    await consumer.driver.close();
    await kafka.stop();
    logger.info('Shutting down', consumer.stats);
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message });
  process.exit(1);
});
