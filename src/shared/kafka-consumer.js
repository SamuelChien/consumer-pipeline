import { Kafka } from 'kafkajs';
import { config } from './config.js';

export class KafkaConsumerGroup {
  constructor(groupId, logger) {
    const kafkaConfig = {
      clientId: config.kafka.clientId,
      brokers: config.kafka.brokers,
      retry: { retries: 5, initialRetryTime: 1000 },
    };

    if (config.kafka.ssl) {
      kafkaConfig.ssl = true;
    }

    this.kafka = new Kafka(kafkaConfig);
    this.consumer = this.kafka.consumer({
      groupId,
      maxBytes: 1048576,
      maxBytesPerPartition: 524288,
    });
    this.logger = logger;
    this.handlers = new Map();

    logger.info('Kafka config', {
      brokers: config.kafka.brokers,
      ssl: config.kafka.ssl,
      groupId,
    });
  }

  on(topic, handler) {
    this.handlers.set(topic, handler);
    return this;
  }

  async start() {
    await this.consumer.connect();
    this.logger.info('Kafka consumer connected');

    for (const topic of this.handlers.keys()) {
      await this.consumer.subscribe({ topic, fromBeginning: process.env.KAFKA_FROM_BEGINNING === 'true' });
      this.logger.info(`Subscribed to ${topic}`);
    }

    await this.consumer.run({
      eachBatchAutoResolve: true,
      eachBatch: async ({ batch, resolveOffset, heartbeat }) => {
        for (const message of batch.messages) {
          const handler = this.handlers.get(batch.topic);
          if (!handler) continue;

          try {
            const value = JSON.parse(message.value.toString());
            const key = message.key?.toString();
            await handler({ key, value, partition: batch.partition, topic: batch.topic });
          } catch (err) {
            this.logger.error(`Error processing message from ${batch.topic}`, {
              error: err.message,
              partition: batch.partition,
              offset: message.offset,
            });
          }
          resolveOffset(message.offset);
          await heartbeat();
        }
      },
    });

    this.logger.info('Consumer running');
  }

  async stop() {
    await this.consumer.disconnect();
    this.logger.info('Consumer disconnected');
  }
}
