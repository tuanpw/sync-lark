import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { apiRoutes } from './routes';
import { requestLogger } from './logging/request-logger';

const app = new Elysia()
  .use(cors())
  .use(requestLogger)
  .use(apiRoutes)
  .get('/health', () => ({
    status: 'ok',
    service: 'backend',
    timestamp: new Date().toISOString(),
  }));

app.listen(Number(process.env.BACKEND_PORT ?? 3001));

console.log(`backend listening on ${app.server?.hostname}:${app.server?.port}`);
