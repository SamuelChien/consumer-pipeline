const isGKE = process.env.KUBERNETES_SERVICE_HOST;

export const config = {
  topics: {
    skillsAnalyzed: process.env.TOPIC_SKILLS_ANALYZED || 'sink-skills-analyzed',
    sessionsAnalyzed: process.env.TOPIC_SESSIONS_ANALYZED || 'sink-sessions-analyzed',
    codeAnalyzed: process.env.TOPIC_CODE_ANALYZED || 'sink-code-analyzed',
    skillsRaw: process.env.TOPIC_SKILLS_RAW || 'sink-skills',
    sessionsRaw: process.env.TOPIC_SESSIONS_RAW || 'sink-sessions',
    codeRaw: process.env.TOPIC_CODE_RAW || 'sink-code',
  },

  chromadb: {
    url: process.env.CHROMADB_URL || (isGKE ? 'http://chromadb-service:8000' : 'http://localhost:8100'),
    collectionSkillChunks: 'skill_chunks',
    collectionSessionChunks: 'session_chunks',
    collectionCodeChunks: 'code_chunks',
  },

  clickhouse: {
    url: process.env.CLICKHOUSE_URL || (isGKE ? 'http://clickhouse-service:8123' : 'http://localhost:8123'),
    user: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || 'consumer123',
    database: process.env.CLICKHOUSE_DB || 'consumer',
  },

  neo4j: {
    uri: process.env.NEO4J_URI || (isGKE ? 'bolt://neo4j-service:7687' : 'bolt://localhost:7687'),
    user: process.env.NEO4J_USER || 'neo4j',
    password: process.env.NEO4J_PASSWORD || 'consumer123',
  },

  claude: {
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
  },

  gcp: {
    projectId: process.env.PROJECT_ID || 'blobfish-ai-429200',
    region: process.env.REGION || 'us-central1',
  },

  outputDir: process.env.OUTPUT_DIR || './output',
};
