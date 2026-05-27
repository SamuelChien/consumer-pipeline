import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { Kafka } from 'kafkajs';
import { config } from '../src/shared/config.js';
import { createLogger } from '../src/shared/logger.js';

const logger = createLogger('data-loader');
const SKILLS_FILE = process.env.SKILLS_FILE || '/data/skills.jsonl';
const SESSIONS_FILE = process.env.SESSIONS_FILE || '/data/sessions.jsonl';
const BATCH_SIZE = 50;

async function loadFile(producer, filePath, topic, label) {
  const rl = createInterface({ input: createReadStream(filePath) });
  let batch = [];
  let count = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    const key = obj.id || obj.sessionId || `msg-${count}`;
    batch.push({ key, value: line });
    count++;

    if (batch.length >= BATCH_SIZE) {
      await producer.send({ topic, messages: batch });
      batch = [];
      if (count % 500 === 0) logger.info(`${label}: ${count} produced`);
    }
  }

  if (batch.length > 0) {
    await producer.send({ topic, messages: batch });
  }

  logger.info(`${label}: ${count} total produced to ${topic}`);
  return count;
}

async function main() {
  const kafka = new Kafka({
    clientId: 'data-loader',
    brokers: config.kafka.brokers,
    ssl: config.kafka.ssl || false,
  });

  const producer = kafka.producer();
  await producer.connect();
  logger.info('Connected', { brokers: config.kafka.brokers });

  let skills = 0, sessions = 0;
  try { skills = await loadFile(producer, SKILLS_FILE, config.topics.skillsAnalyzed, 'Skills'); } catch (e) { logger.error('Skills load failed', { error: e.message }); }
  try { sessions = await loadFile(producer, SESSIONS_FILE, config.topics.sessionsAnalyzed, 'Sessions'); } catch (e) { logger.error('Sessions load failed', { error: e.message }); }

  logger.info('Load complete', { skills, sessions });
  await producer.disconnect();
}

main().catch(e => { logger.error('Fatal', { error: e.message }); process.exit(1); });
