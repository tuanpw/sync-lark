import { Elysia } from 'elysia';
import type { TransferJobStatus } from '@app/shared/types';
import { store } from '../lib/store';

export const workerRoutes = new Elysia()
  .get('/worker/status', () => ({
    workers: store.getWorkerStatus(),
  }))

  .post('/worker/heartbeat', ({ body }) => {
    const payload = (body ?? {}) as {
      workerId?: string;
      status?: 'idle' | 'busy';
      currentSessionId?: string | null;
      processedJobs?: number;
    };
    store.registerHeartbeat(
      payload.workerId ?? 'worker_unknown',
      payload.status ?? 'idle',
      payload.currentSessionId ?? null,
      payload.processedJobs ?? 0,
    );
    return { ok: true };
  })

  .post('/worker/jobs', ({ body }) => {
    const payload = (body ?? {}) as {
      importSessionId: string;
      fileName: string;
      fileSize: number;
      sourceFileId: string;
      sourcePath: string;
      targetBucket: string;
      targetObjectKey: string;
    };
    const job = store.addTransferJob(payload);
    return { job };
  })

  .patch('/worker/jobs/:id', ({ body, params }) => {
    const payload = (body ?? {}) as {
      workerId: string;
      status: TransferJobStatus;
      bytesTransferred: number;
      lastError?: string;
    };
    return store.updateJobProgress(params.id, payload.workerId, payload.status, payload.bytesTransferred, payload.lastError);
  })

  // ─── Session updates from worker ───
  .patch('/worker/sessions/:id', ({ body, params }) => {
    const payload = (body ?? {}) as Record<string, unknown>;
    return { item: store.updateSession(params.id, payload as any) };
  })

  // ─── Sync attempt tracking ───
  .post('/worker/sync-attempts', ({ body }) => {
    const payload = (body ?? {}) as { syncLinkId: string; attempt: any };
    store.addSyncAttempt(payload.syncLinkId, payload.attempt);
    return { ok: true };
  })

  .patch('/worker/sync-attempts/:syncLinkId/:attemptId', ({ body, params }) => {
    const payload = (body ?? {}) as Record<string, unknown>;
    store.updateSyncAttempt(params.syncLinkId, params.attemptId, payload as any);
    return { ok: true };
  })

  // ─── Log streaming ───
  .post('/worker/logs', ({ body }) => {
    const { sessionId, workerId, level, message, timestamp } = body as {
      sessionId: string;
      workerId: string;
      level?: 'info' | 'error' | 'success' | 'warn';
      message: string;
      timestamp?: string;
    };
    const log = store.addLog({
      sessionId,
      workerId,
      level: level ?? 'info',
      message,
      timestamp: timestamp ?? new Date().toISOString(),
    });
    return { ok: true, id: log.id };
  })

  .get('/worker/logs/:sessionId', ({ params, query }) => {
    const after = (query as Record<string, string | undefined>).after;
    return { logs: store.getLogsBySession(params.sessionId, after) };
  })

  .get('/worker/logs/:sessionId/stream', ({ params }) => {
    const sessionId = params.sessionId;
    const stream = new ReadableStream({
      start(controller) {
        const existing = store.getLogsBySession(sessionId);
        for (const log of existing) {
          controller.enqueue(`data: ${JSON.stringify(log)}\n\n`);
        }
        store.subscribeToLogs(sessionId, controller);
      },
      cancel(controller) {
        store.unsubscribeFromLogs(controller);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  });
