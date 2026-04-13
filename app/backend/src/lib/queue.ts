import { Queue } from 'bullmq';

const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);

export const transferQueue = new Queue('lark-transfer', {
  connection: {
    host: REDIS_HOST,
    port: REDIS_PORT,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 500, 5000),
  },
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: { count: 100 },
    removeOnFail: { count: 100 },
  },
});

transferQueue.on('error', (err) => {
  // Suppress noisy connection errors — BullMQ auto-reconnects
  if (!String(err.message).includes('ECONNREFUSED')) {
    console.error('[queue] error:', err.message);
  }
});

console.log(`[queue] BullMQ queue "lark-transfer" → redis://${REDIS_HOST}:${REDIS_PORT}`);
