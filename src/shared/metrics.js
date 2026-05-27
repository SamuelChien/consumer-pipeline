import { config } from './config.js';

const CLICKHOUSE_URL = config.clickhouse.url;
const CLICKHOUSE_USER = config.clickhouse.user;
const CLICKHOUSE_PASSWORD = config.clickhouse.password;

class MetricsReporter {
  constructor(consumerName) {
    this.consumer = consumerName;
    this.buffer = [];
    this.flushInterval = setInterval(() => this.flush(), 5000);
    this.counters = { processed: 0, errors: 0 };
  }

  track(eventType, { itemId = '', itemType = '', project = '', count = 1, durationMs = 0, error = '' } = {}) {
    this.buffer.push({ consumer: this.consumer, event_type: eventType, item_id: itemId, item_type: itemType, project, count, duration_ms: durationMs, error });
    if (error) this.counters.errors++;
    else this.counters.processed += count;
  }

  async flush() {
    if (this.buffer.length === 0) return;
    const rows = this.buffer.splice(0);
    try {
      const body = rows.map(r => JSON.stringify(r)).join('\n');
      await fetch(`${CLICKHOUSE_URL}/?user=${CLICKHOUSE_USER}&password=${CLICKHOUSE_PASSWORD}&query=INSERT+INTO+consumer.consumer_metrics+FORMAT+JSONEachRow`, {
        method: 'POST',
        body,
      });
    } catch {}

    try {
      const status = JSON.stringify({
        consumer: this.consumer,
        status: 'running',
        messages_processed: this.counters.processed,
        errors: this.counters.errors,
      });
      await fetch(`${CLICKHOUSE_URL}/?user=${CLICKHOUSE_USER}&password=${CLICKHOUSE_PASSWORD}&query=INSERT+INTO+consumer.consumer_status+FORMAT+JSONEachRow`, {
        method: 'POST',
        body: status,
      });
    } catch {}
  }

  async stop() {
    clearInterval(this.flushInterval);
    await this.flush();
  }
}

export function createMetrics(consumerName) {
  return new MetricsReporter(consumerName);
}
