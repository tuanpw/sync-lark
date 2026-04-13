import { Elysia } from 'elysia';
import { getRequestContext } from './request-context';

export const requestLogger = new Elysia({ name: 'request-logger' }).onBeforeHandle(
  ({ request }) => {
    const context = getRequestContext(request);

    console.info(
      JSON.stringify({
        type: 'request_log',
        method: request.method,
        path: new URL(request.url).pathname,
        ...context,
        timestamp: new Date().toISOString(),
      }),
    );
  },
);
