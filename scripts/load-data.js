import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { PubSub } from '@google-cloud/pubsub';
import { config } from '../src/shared/config.js';
import { createLogger } from '../src/shared/logger.js';

const logger = createLogger('data-loader');
const SKILLS_FILE = process.env.SKILLS_FILE || '/data/skills.jsonl';
const SESSIONS_FILE = process.env.SESSIONS_FILE || '/data/sessions.jsonl';
const BATCH_SIZE = 50;

async function loadFile(topic, filePath, label) {
  const rl = createInterface({ input: createReadStream(filePath) });
  let batch = [];
  let count = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    const key = obj.id || obj.sessionId || `msg-${count}`;

    batch.push(topic.publishMessage({
      data: Buffer.from(line),
      attributes: { sourceId: key },
    }));
    count++;

    if (batch.length >= BATCH_SIZE) {
      await Promise.all(batch);
      batch = [];
      if (count % 500 === 0) logger.info(`${label}: ${count} published`);
    }
  }

  if (batch.length > 0) await Promise.all(batch);
  logger.info(`${label}: ${count} total published`);
  return count;
}

async function main() {
  const pubsub = new PubSub({ projectId: config.gcp.projectId });
  logger.info('Connected to Pub/Sub', { projectId: config.gcp.projectId });

  const skillsTopic = pubsub.topic(config.topics.skillsAnalyzed);
  const sessionsTopic = pubsub.topic(config.topics.sessionsAnalyzed);

  let skills = 0, sessions = 0;
  try { skills = await loadFile(skillsTopic, SKILLS_FILE, 'Skills'); } catch (e) { logger.error('Skills load failed', { error: e.message }); }
  try { sessions = await loadFile(sessionsTopic, SESSIONS_FILE, 'Sessions'); } catch (e) { logger.error('Sessions load failed', { error: e.message }); }

  logger.info('Load complete', { skills, sessions });
}

main().catch(e => { logger.error('Fatal', { error: e.message }); process.exit(1); });
