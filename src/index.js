import { fork } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './shared/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = createLogger('orchestrator');

const CONSUMERS = [
  { name: 'chromadb', path: 'consumers/chromadb/index.js' },
  { name: 'clickhouse', path: 'consumers/clickhouse/index.js' },
  { name: 'wikipedia', path: 'consumers/wikipedia/index.js' },
  { name: 'graph', path: 'consumers/graph/index.js' },
  { name: 'skill-updater', path: 'consumers/skill-updater/index.js' },
  { name: 'eval', path: 'consumers/eval/index.js' },
];

const processes = new Map();

function startConsumer(consumer) {
  const fullPath = join(__dirname, consumer.path);
  const proc = fork(fullPath, [], { stdio: 'inherit' });

  proc.on('exit', (code, signal) => {
    logger.warn(`Consumer ${consumer.name} exited`, { code, signal });
    processes.delete(consumer.name);

    if (code !== 0 && !shuttingDown) {
      logger.info(`Restarting ${consumer.name} in 5s...`);
      setTimeout(() => startConsumer(consumer), 5000);
    }
  });

  proc.on('error', (err) => {
    logger.error(`Consumer ${consumer.name} error`, { error: err.message });
  });

  processes.set(consumer.name, proc);
  logger.info(`Started consumer: ${consumer.name} (pid: ${proc.pid})`);
}

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down all consumers...');

  for (const [name, proc] of processes) {
    logger.info(`Stopping ${name}...`);
    proc.kill('SIGINT');
  }

  setTimeout(() => {
    for (const [name, proc] of processes) {
      logger.warn(`Force killing ${name}`);
      proc.kill('SIGKILL');
    }
    process.exit(0);
  }, 10000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

logger.info('Starting consumer pipeline', { consumers: CONSUMERS.map(c => c.name) });

for (const consumer of CONSUMERS) {
  startConsumer(consumer);
}
