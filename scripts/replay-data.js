import { Kafka } from 'kafkajs';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../src/shared/config.js';
import { createLogger } from '../src/shared/logger.js';
import yaml from 'js-yaml';

const logger = createLogger('replay-data');

const SKILLS_DIR = process.env.SKILLS_DIR || '/Users/samuelchien/dev/mega-skills-directory/mega-skills-union';
const SESSIONS_OUTPUT = process.env.SESSIONS_OUTPUT || '/Users/samuelchien/dev/claude-sessions-pipeline/output';
const SKILLS_OUTPUT = process.env.SKILLS_OUTPUT || '/Users/samuelchien/dev/skills-intelligence-pipeline/output';
const MAX_SKILLS = parseInt(process.env.MAX_SKILLS || '0') || Infinity;
const MAX_SESSIONS = parseInt(process.env.MAX_SESSIONS || '0') || Infinity;

function parseSkillFile(filePath, dirName) {
  const content = readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  let frontmatter = {};
  let body = content;

  if (fmMatch) {
    try { frontmatter = yaml.load(fmMatch[1]) || {}; } catch {}
    body = fmMatch[2];
  }

  const headings = [];
  const codeBlocks = [];
  for (const line of body.split('\n')) {
    const hm = line.match(/^(#{1,6})\s+(.+)/);
    if (hm) headings.push({ level: hm[1].length, text: hm[2] });
  }
  for (const match of body.matchAll(/```(\w*)\n([\s\S]*?)```/g)) {
    codeBlocks.push({ language: match[1] || 'text', length: match[2].length });
  }

  return {
    id: dirName,
    slug: dirName,
    name: frontmatter.name || frontmatter.title || dirName,
    description: frontmatter.description || body.split('\n').find(l => l.trim() && !l.startsWith('#')) || '',
    tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : (frontmatter.tags ? [frontmatter.tags] : []),
    category: frontmatter.category || 'uncategorized',
    tier: frontmatter.tier || 'standard',
    author: frontmatter.author || 'unknown',
    platforms: Array.isArray(frontmatter.platforms) ? frontmatter.platforms : ['universal'],
    allowedTools: frontmatter['allowed-tools'] || frontmatter.allowedTools || [],
    risk: frontmatter.risk || 'safe',
    version: frontmatter.version || '1.0.0',
    source: frontmatter.source || '',
    body,
    bodyLength: body.length,
    headings,
    codeBlocks,
    links: [],
    supportingFiles: [],
    sourceCollection: 'mega-skills-union',
    rawFrontmatter: frontmatter,
    filePath,
    timestamp: Date.now(),
  };
}

function classifyCategory(text) {
  const categories = {
    security: ['security', 'vulnerability', 'exploit', 'penetration', 'firewall', 'encryption', 'auth', 'csrf', 'xss', 'injection'],
    testing: ['test', 'testing', 'jest', 'pytest', 'spec', 'assert', 'mock', 'coverage', 'e2e', 'unit-test'],
    devops: ['deploy', 'docker', 'kubernetes', 'k8s', 'ci/cd', 'pipeline', 'terraform', 'ansible', 'helm'],
    frontend: ['react', 'vue', 'angular', 'css', 'html', 'dom', 'component', 'ui', 'ux', 'tailwind'],
    backend: ['api', 'server', 'database', 'rest', 'graphql', 'microservice', 'endpoint', 'middleware'],
    ai_ml: ['ai', 'machine-learning', 'model', 'llm', 'prompt', 'embedding', 'neural', 'training', 'inference'],
    data: ['data', 'sql', 'etl', 'pipeline', 'analytics', 'warehouse', 'spark', 'kafka'],
    cloud: ['aws', 'gcp', 'azure', 'cloud', 'lambda', 'serverless', 's3', 'iam'],
    documentation: ['doc', 'readme', 'wiki', 'changelog', 'guide', 'tutorial'],
    productivity: ['workflow', 'automation', 'script', 'cli', 'tool', 'utility'],
    architecture: ['architecture', 'design-pattern', 'microservices', 'monolith', 'ddd', 'cqrs'],
    observability: ['monitoring', 'logging', 'tracing', 'metric', 'alert', 'dashboard', 'grafana'],
    mobile: ['ios', 'android', 'react-native', 'flutter', 'mobile', 'swift', 'kotlin'],
  };

  const lower = text.toLowerCase();
  let best = 'productivity';
  let bestScore = 0;
  for (const [cat, keywords] of Object.entries(categories)) {
    let score = 0;
    for (const kw of keywords) {
      if (lower.includes(kw)) score++;
    }
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  return best;
}

function extractKeywords(text) {
  const stops = new Set(['the','a','an','is','are','was','were','be','been','have','has','had','do','does','did','will','would','could','should','may','might','can','to','of','in','for','on','with','at','by','from','as','into','and','but','or','not','this','that','it','its','they','them','their','what','which','who','when','where','why','how','all','any','some','no','other','such','only','own','same','than','too','very','just','also','use','using','file','set']);
  const words = text.toLowerCase().replace(/[^a-z0-9\-]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stops.has(w));
  const freq = {};
  for (const w of words) freq[w] = (freq[w] || 0) + 1;
  return Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([word, count]) => ({ word, count }));
}

function analyzeSkill(skill) {
  const fullText = `${skill.name} ${skill.description} ${skill.body} ${skill.tags.join(' ')}`;
  const primary = classifyCategory(fullText);

  return {
    ...skill,
    analysis: {
      skillId: skill.id,
      sourceCollection: skill.sourceCollection,
      categories: { primary, secondary: null, confidence: 0.7 },
      entities: [
        ...skill.tags.map(t => ({ name: t, type: 'tag', id: t })),
        ...(Array.isArray(skill.allowedTools) ? skill.allowedTools : []).map(t => ({ name: t, type: 'tool', id: t })),
      ],
      dependencies: [],
      qualityScore: {
        score: Math.min(100, (skill.description ? 10 : 0) + (skill.headings.length >= 3 ? 10 : 0) + (skill.bodyLength > 2000 ? 15 : skill.bodyLength > 500 ? 8 : 0) + (skill.codeBlocks.length > 0 ? 15 : 0) + (skill.tags.length > 0 ? 5 : 0) + (Object.keys(skill.rawFrontmatter).length > 3 ? 15 : 0) + 15),
        checks: {},
      },
      complexity: {
        level: skill.bodyLength > 5000 ? 'advanced' : skill.bodyLength > 1500 ? 'intermediate' : 'basic',
        headingCount: skill.headings.length,
        codeBlockCount: skill.codeBlocks.length,
        fileCount: 0,
        estimatedWordCount: Math.round(skill.bodyLength / 5),
      },
      keywords: extractKeywords(fullText),
      fingerprint: { keywordSet: [], techSet: [], categorySet: [primary], hash: skill.id },
      analyzedAt: new Date().toISOString(),
    },
    processedAt: new Date().toISOString(),
  };
}

async function main() {
  const kafka = new Kafka({
    clientId: 'replay-producer',
    brokers: config.kafka.brokers,
    ssl: config.kafka.ssl || false,
  });

  const producer = kafka.producer();
  await producer.connect();
  logger.info('Connected to Kafka', { brokers: config.kafka.brokers });

  let skillCount = 0;
  let sessionCount = 0;

  // Replay skills
  if (existsSync(SKILLS_DIR)) {
    const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .slice(0, MAX_SKILLS);

    logger.info(`Found ${dirs.length} skill directories`);

    const batch = [];
    for (const dir of dirs) {
      const skillPath = join(SKILLS_DIR, dir.name, 'SKILL.md');
      if (!existsSync(skillPath)) continue;

      try {
        const skill = parseSkillFile(skillPath, dir.name);
        const analyzed = analyzeSkill(skill);
        analyzed.body = analyzed.body.slice(0, 5000);

        batch.push({
          topic: config.topics.skillsAnalyzed,
          messages: [{ key: analyzed.id, value: JSON.stringify(analyzed) }],
        });

        skillCount++;
        if (batch.length >= 50) {
          await producer.sendBatch({ topicMessages: batch.splice(0) });
          logger.info(`Produced ${skillCount} skills...`);
        }
      } catch (err) {
        // skip malformed skills silently
      }
    }

    if (batch.length > 0) {
      await producer.sendBatch({ topicMessages: batch });
    }
    logger.info(`Produced ${skillCount} skills total`);
  } else {
    logger.warn('Skills directory not found', { path: SKILLS_DIR });
  }

  // Replay sessions from deep-analysis.json
  const deepAnalysisPath = join(SESSIONS_OUTPUT, 'deep-analysis.json');
  if (existsSync(deepAnalysisPath)) {
    const sessions = JSON.parse(readFileSync(deepAnalysisPath, 'utf-8'));
    const toReplay = sessions.slice(0, MAX_SESSIONS);

    logger.info(`Found ${sessions.length} sessions, replaying ${toReplay.length}`);

    for (const session of toReplay) {
      const analyzed = {
        sessionId: session.sessionId,
        project: session.project,
        messageCount: session.messageCount,
        analysis: session.shallow || session.analysis || {},
        deep: session.deep || null,
        processedAt: new Date().toISOString(),
      };

      await producer.send({
        topic: config.topics.sessionsAnalyzed,
        messages: [{ key: session.sessionId, value: JSON.stringify(analyzed) }],
      });

      sessionCount++;
    }
    logger.info(`Produced ${sessionCount} sessions total`);
  } else {
    logger.warn('Sessions deep-analysis.json not found', { path: deepAnalysisPath });
  }

  logger.info('Replay complete', { skills: skillCount, sessions: sessionCount });
  await producer.disconnect();
}

main().catch((err) => {
  logger.error('Replay failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
