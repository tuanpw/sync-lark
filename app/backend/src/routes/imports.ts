import { Elysia } from 'elysia';
import type { CreateImportRequest } from '@app/shared/types';
import { store } from '../lib/store';
import { transferQueue } from '../lib/queue';
import { parseLarkFolderLink } from '../lib/lark-link-parser';

export const importRoutes = new Elysia()
  .get('/imports', () => ({
    items: store.listImportSessions(),
  }))
  .get('/imports/:id', ({ params }) => ({
    item: store.getImportSession(params.id),
  }))
  .get('/imports/:id/jobs', ({ params }) => ({
    items: store.listTransferJobs(params.id),
  }))

  // ─── Sync links (history per Lark URL) ───
  .get('/sync-links', () => ({
    items: store.listSyncLinks(),
  }))
  .get('/sync-links/:id', ({ params }) => ({
    item: store.getSyncLink(params.id),
  }))

  // ─── Create import: parse link, create session, push to BullMQ ───
  .post('/imports', async ({ body }) => {
    const payload = (body ?? {}) as Partial<CreateImportRequest>;
    const larkUrl = payload.larkUrl?.trim();
    if (!larkUrl) throw new Error('larkUrl is required');

    const parsed = parseLarkFolderLink(larkUrl);
    if (!parsed) throw new Error('Invalid Lark folder link. Expected: https://<workspace>.larksuite.com/drive/folder/<token>');

    const targetFolderName = payload.targetFolderName?.trim() || parsed.folderToken;
    const { session, syncLink } = store.createImport(larkUrl, targetFolderName);

    // Push to BullMQ
    await transferQueue.add('sync-session', {
      sessionId: session.id,
      syncLinkId: syncLink.id,
      folderToken: parsed.folderToken,
      targetFolderName: session.targetFolderName,
      larkUrl,
    }, {
      jobId: session.id,
    });

    console.log(`[import] created session ${session.id} → BullMQ job queued`);

    return { item: session, syncLink };
  })

  .post('/imports/:id/retry-failed', async ({ params }) => {
    const result = store.retryFailed(params.id);
    if (result.accepted) {
      const session = store.getImportSession(params.id);
      if (session) {
        await transferQueue.add('sync-session', {
          sessionId: session.id,
          syncLinkId: session.syncLinkId,
          folderToken: session.sourceFolderToken,
          targetFolderName: session.targetFolderName,
          larkUrl: session.sourceReference,
          retryFailed: true,
        }, {
          jobId: `${session.id}_retry_${Date.now()}`,
        });
      }
    }
    return result;
  })

  .post('/imports/:id/cancel', ({ params }) => store.cancelImport(params.id));
