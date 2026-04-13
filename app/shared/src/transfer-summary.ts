export const transferPipelineSummary = {
  mode: 'batch',
  backend: 'bun-elysia',
  frontend: 'next-shadcn-ready',
  worker: 'streaming-multipart-checkpoint',
  storage: 'minio',
  checkpointStore: 'postgres',
  queue: 'bullmq-compatible',
  logging: 'structured-and-audit-ip-aware',
  sourceModes: ['oauth', 'managed', 'shared_link'],
} as const;
