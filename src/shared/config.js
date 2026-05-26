export const config = {
  kafka: {
    brokers: (process.env.KAFKA_BROKERS || 'localhost:9092').split(','),
    clientId: 'consumer-pipeline',
  },

  topics: {
    sessionsRaw: process.env.TOPIC_SESSIONS_RAW || 'sessions.raw',
    sessionsAnalyzed: process.env.TOPIC_SESSIONS_ANALYZED || 'sessions.analyzed',
    sessionsTools: process.env.TOPIC_SESSIONS_TOOLS || 'sessions.tools',
    sessionsFiles: process.env.TOPIC_SESSIONS_FILES || 'sessions.files',
    skillsRaw: process.env.TOPIC_SKILLS_RAW || 'skills.raw',
    skillsAnalyzed: process.env.TOPIC_SKILLS_ANALYZED || 'skills.analyzed',
    skillsEntities: process.env.TOPIC_SKILLS_ENTITIES || 'skills.entities',
    skillsDependencies: process.env.TOPIC_SKILLS_DEPENDENCIES || 'skills.dependencies',
  },

  chromadb: {
    url: process.env.CHROMADB_URL || 'http://localhost:8000',
    collectionSkillChunks: 'skill_chunks',
    collectionSessionChunks: 'session_chunks',
  },

  clickhouse: {
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    user: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || 'consumer123',
    database: process.env.CLICKHOUSE_DB || 'consumer',
  },

  neo4j: {
    uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'consumer123',
  },

  claude: {
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
  },

  skillsDir: process.env.SKILLS_DIR || null,
  outputDir: process.env.OUTPUT_DIR || './output',
};
