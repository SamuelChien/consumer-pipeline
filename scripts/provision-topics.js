import { Kafka } from 'kafkajs';
import { config } from '../src/shared/config.js';
import { createLogger } from '../src/shared/logger.js';

const logger = createLogger('topic-provisioner');

const TOPICS = [
  { topic: 'sessions.raw', numPartitions: 3, replicationFactor: 1 },
  { topic: 'sessions.analyzed', numPartitions: 3, replicationFactor: 1 },
  { topic: 'sessions.tools', numPartitions: 1, replicationFactor: 1 },
  { topic: 'sessions.files', numPartitions: 1, replicationFactor: 1 },
  { topic: 'skills.raw', numPartitions: 3, replicationFactor: 1 },
  { topic: 'skills.analyzed', numPartitions: 3, replicationFactor: 1 },
  { topic: 'skills.entities', numPartitions: 1, replicationFactor: 1 },
  { topic: 'skills.dependencies', numPartitions: 1, replicationFactor: 1 },
];

async function main() {
  const kafka = new Kafka({
    clientId: 'topic-provisioner',
    brokers: config.kafka.brokers,
    ssl: config.kafka.ssl || false,
  });

  const admin = kafka.admin();
  await admin.connect();
  logger.info('Connected to Kafka', { brokers: config.kafka.brokers });

  const existing = await admin.listTopics();
  logger.info('Existing topics', { topics: existing });

  const toCreate = TOPICS.filter(t => !existing.includes(t.topic));

  if (toCreate.length === 0) {
    logger.info('All topics already exist');
  } else {
    logger.info('Creating topics', { topics: toCreate.map(t => t.topic) });
    await admin.createTopics({ topics: toCreate });
    logger.info('Topics created');
  }

  const afterTopics = await admin.listTopics();
  logger.info('Final topic list', { topics: afterTopics });

  await admin.disconnect();
}

main().catch((err) => {
  logger.error('Failed to provision topics', { error: err.message });
  process.exit(1);
});
