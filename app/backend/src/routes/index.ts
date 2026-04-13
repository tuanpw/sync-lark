import { Elysia } from 'elysia';
import { importRoutes } from './imports';
import { workerRoutes } from './worker';
import { authRoutes } from './auth';

export const apiRoutes = new Elysia({ prefix: '/api' })
  .use(authRoutes)
  .use(importRoutes)
  .use(workerRoutes)
  .get('/overview', () => ({
    message: 'Lark → MinIO transfer platform',
  }));
