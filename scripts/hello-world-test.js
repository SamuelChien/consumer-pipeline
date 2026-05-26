import { Kafka } from 'kafkajs';
import { config } from '../src/shared/config.js';
import { createLogger } from '../src/shared/logger.js';

const logger = createLogger('hello-world-test');

const SKILL_ANALYZED = {
  id: 'hello-world-skill',
  name: 'Hello World Skill',
  slug: 'hello-world-skill',
  description: 'A test skill for validating the consumer pipeline',
  body: '# Hello World\n\nThis is a test skill.\n\n## Usage\n\nRun this skill when testing.\n\n## Examples\n\n```bash\necho "hello world"\n```\n',
  tags: ['testing', 'hello-world', 'validation'],
  category: 'testing',
  tier: 'standard',
  author: 'test-harness',
  platforms: ['universal'],
  allowedTools: ['Read', 'Bash'],
  risk: 'safe',
  version: '1.0.0',
  bodyLength: 150,
  headings: [{ level: 1, text: 'Hello World' }, { level: 2, text: 'Usage' }, { level: 2, text: 'Examples' }],
  codeBlocks: [{ language: 'bash', length: 20 }],
  links: [],
  sourceCollection: 'test',
  analysis: {
    categories: { primary: 'testing', secondary: 'documentation', confidence: 0.9 },
    entities: [
      { name: 'testing', type: 'tag', id: 'tag-testing' },
      { name: 'bash', type: 'tool', id: 'tool-bash' },
    ],
    dependencies: [
      { skillId: 'bash-scripting', type: 'depends_on', confidence: 0.7 },
    ],
    qualityScore: { score: 72, checks: {} },
    complexity: { level: 'basic', headingCount: 3, codeBlockCount: 1, fileCount: 0, estimatedWordCount: 30 },
    keywords: [
      { word: 'testing', count: 5 },
      { word: 'hello', count: 3 },
      { word: 'world', count: 3 },
      { word: 'validation', count: 2 },
    ],
    fingerprint: { keywordSet: ['testing', 'hello', 'world'], techSet: ['bash'], categorySet: ['testing'], hash: 'abc123' },
    analyzedAt: new Date().toISOString(),
  },
  evaluation: { totalScore: 72, grade: 'C', suggestions: ['Add more examples'] },
  processedAt: new Date().toISOString(),
};

const SESSION_ANALYZED = {
  sessionId: 'hello-world-session-001',
  project: 'consumer-pipeline-test',
  messageCount: 25,
  analysis: {
    duration: { seconds: 600, minutes: 10, firstMessage: new Date().toISOString(), lastMessage: new Date().toISOString() },
    tokenUsage: { totalInput: 15000, totalOutput: 10000, totalTokens: 25000, cacheCreation: 5000, cacheRead: 3000, cacheHitRate: 37.5 },
    toolUsage: {
      totalToolCalls: 20,
      uniqueTools: 4,
      tools: [
        { name: 'Read', count: 8 },
        { name: 'Edit', count: 5 },
        { name: 'Bash', count: 4 },
        { name: 'Write', count: 3 },
      ],
    },
    filesAccessed: [
      { path: 'src/index.js', reads: 3, writes: 1, edits: 2 },
      { path: 'package.json', reads: 2, writes: 1, edits: 0 },
      { path: 'README.md', reads: 1, writes: 1, edits: 0 },
    ],
    topics: [
      { topic: 'feature-development', score: 8 },
      { topic: 'testing', score: 5 },
      { topic: 'documentation', score: 3 },
    ],
    commands: {
      total: 4,
      uniqueBinaries: 3,
      topBinaries: [{ binary: 'npm', count: 2 }, { binary: 'git', count: 1 }, { binary: 'node', count: 1 }],
    },
    complexity: { level: 'moderate', messageCount: 25, toolCalls: 20, filesAccessed: 3, durationMinutes: 10 },
    categories: { primary: 'feature-development', secondary: 'testing' },
  },
};

const SESSION_TOOLS = {
  sessionId: 'hello-world-session-001',
  tools: [
    { name: 'Read', count: 8 },
    { name: 'Edit', count: 5 },
    { name: 'Bash', count: 4 },
    { name: 'Write', count: 3 },
  ],
};

const SESSION_FILES = {
  sessionId: 'hello-world-session-001',
  files: [
    { path: 'src/index.js', reads: 3, writes: 1, edits: 2 },
    { path: 'package.json', reads: 2, writes: 1, edits: 0 },
  ],
};

const SKILL_ENTITIES = {
  skillId: 'hello-world-skill',
  entities: [
    { name: 'testing', type: 'tag' },
    { name: 'bash', type: 'tool' },
    { name: 'validation', type: 'tag' },
  ],
};

const SKILL_DEPENDENCIES = {
  skillId: 'hello-world-skill',
  dependencies: [
    { skillId: 'bash-scripting', type: 'depends_on', confidence: 0.7 },
  ],
};

async function main() {
  const kafka = new Kafka({
    clientId: 'hello-world-producer',
    brokers: config.kafka.brokers,
    ssl: config.kafka.ssl || false,
  });

  const producer = kafka.producer();
  await producer.connect();
  logger.info('Producer connected', { brokers: config.kafka.brokers });

  const messages = [
    { topic: config.topics.skillsAnalyzed, key: 'hello-world-skill', value: SKILL_ANALYZED },
    { topic: config.topics.sessionsAnalyzed, key: 'hello-world-session-001', value: SESSION_ANALYZED },
    { topic: config.topics.sessionsTools, key: 'hello-world-session-001', value: SESSION_TOOLS },
    { topic: config.topics.sessionsFiles, key: 'hello-world-session-001', value: SESSION_FILES },
    { topic: config.topics.skillsEntities, key: 'hello-world-skill', value: SKILL_ENTITIES },
    { topic: config.topics.skillsDependencies, key: 'hello-world-skill', value: SKILL_DEPENDENCIES },
  ];

  for (const msg of messages) {
    await producer.send({
      topic: msg.topic,
      messages: [{ key: msg.key, value: JSON.stringify(msg.value) }],
    });
    logger.info(`Produced to ${msg.topic}`, { key: msg.key });
  }

  logger.info('All hello-world messages produced. Start consumers to verify consumption.');
  await producer.disconnect();
}

main().catch((err) => {
  logger.error('Failed', { error: err.message });
  process.exit(1);
});
