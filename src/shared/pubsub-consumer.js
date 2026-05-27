import { PubSub } from '@google-cloud/pubsub';
import { config } from './config.js';

export class PubSubConsumerGroup {
  constructor(groupId, logger) {
    this.projectId = config.gcp.projectId;
    this.client = new PubSub({ projectId: this.projectId });
    this.groupId = groupId;
    this.logger = logger;
    this.handlers = new Map();
    this.subscriptions = [];

    logger.info('Pub/Sub config', { projectId: this.projectId, groupId });
  }

  on(topic, handler) {
    this.handlers.set(topic, handler);
    return this;
  }

  async start() {
    for (const [topic, handler] of this.handlers) {
      const subName = `${topic}-${this.groupId}`;

      try {
        const [subExists] = await this.client.subscription(subName).exists();
        if (!subExists) {
          const [topicExists] = await this.client.topic(topic).exists();
          if (!topicExists) {
            await this.client.createTopic(topic);
            this.logger.info(`Created topic: ${topic}`);
          }
          await this.client.createSubscription(topic, subName, {
            ackDeadlineSeconds: 60,
            messageRetentionDuration: { seconds: 604800 },
          });
          this.logger.info(`Created subscription: ${subName}`);
        }
      } catch (err) {
        this.logger.warn(`Subscription setup for ${subName}: ${err.message}`);
      }

      const subscription = this.client.subscription(subName, {
        flowControl: { maxMessages: 20 },
      });

      subscription.on('message', async (message) => {
        try {
          const value = JSON.parse(message.data.toString());
          const key = message.attributes?.sourceId || value.sourceId || value.id || '';
          await handler({ key, value, topic });
          message.ack();
        } catch (err) {
          this.logger.error(`Error processing message from ${topic}`, {
            error: err.message,
            messageId: message.id,
          });
          message.nack();
        }
      });

      subscription.on('error', (err) => {
        this.logger.error(`Subscription error on ${subName}`, { error: err.message });
      });

      this.subscriptions.push(subscription);
      this.logger.info(`Subscribed to ${topic} via ${subName}`);
    }

    this.logger.info('Consumer running');
  }

  async stop() {
    for (const sub of this.subscriptions) {
      sub.removeAllListeners();
      await sub.close();
    }
    await this.client.close();
    this.logger.info('Consumer disconnected');
  }
}
