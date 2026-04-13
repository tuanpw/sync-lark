import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import type {
  ImportSessionRecord,
  SyncAttempt,
  SyncLink,
  TransferJobRecord,
  TransferJobStatus,
} from '@app/shared/types';
import { parseLarkFolderLink } from './lark-link-parser';

// ─── Persistent data shape ───
type StoreData = {
  syncLinks: SyncLink[];
  importSessions: ImportSessionRecord[];
  transferJobs: TransferJobRecord[];
};

// ─── Log types (in-memory only, not persisted) ───
export type TransferLog = {
  id: string;
  sessionId: string;
  workerId: string;
  level: 'info' | 'error' | 'success' | 'warn';
  message: string;
  timestamp: string;
};

type WorkerEntry = {
  workerId: string;
  lastSeen: string;
  status: 'idle' | 'busy';
  currentSessionId: string | null;
  processedJobs: number;
};

const DATA_DIR = join(process.cwd(), 'data');
const STORE_PATH = join(DATA_DIR, 'store.json');

class PersistentStore {
  private data: StoreData;
  private workerRegistry = new Map<string, WorkerEntry>();
  private transferLogs: TransferLog[] = [];
  private logSubscribers: Array<{ sessionId: string; controller: ReadableStreamDefaultController }> = [];

  constructor() {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    this.data = this.loadFromDisk();
    console.log(`[store] loaded ${this.data.syncLinks.length} sync links, ${this.data.importSessions.length} sessions, ${this.data.transferJobs.length} jobs`);
  }

  private loadFromDisk(): StoreData {
    try {
      if (existsSync(STORE_PATH)) {
        const raw = readFileSync(STORE_PATH, 'utf-8');
        return JSON.parse(raw) as StoreData;
      }
    } catch (err) {
      console.error('[store] failed to load, starting fresh:', err);
    }
    return { syncLinks: [], importSessions: [], transferJobs: [] };
  }

  private saveToDisk() {
    try {
      writeFileSync(STORE_PATH, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[store] failed to save:', err);
    }
  }

  // ─── Sync Links ───

  listSyncLinks(): SyncLink[] {
    return this.data.syncLinks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSyncLink(id: string): SyncLink | null {
    return this.data.syncLinks.find(s => s.id === id) ?? null;
  }

  getSyncLinkByToken(folderToken: string): SyncLink | null {
    return this.data.syncLinks.find(s => s.folderToken === folderToken) ?? null;
  }

  findOrCreateSyncLink(larkUrl: string, targetPrefix: string): SyncLink {
    const parsed = parseLarkFolderLink(larkUrl);
    if (!parsed) throw new Error('Invalid Lark folder link');

    let existing = this.data.syncLinks.find(s => s.folderToken === parsed.folderToken);
    if (existing) {
      existing.updatedAt = new Date().toISOString();
      this.saveToDisk();
      return existing;
    }

    const link: SyncLink = {
      id: `sl_${crypto.randomUUID().slice(0, 12)}`,
      larkUrl,
      folderToken: parsed.folderToken,
      targetPrefix,
      attempts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.data.syncLinks.push(link);
    this.saveToDisk();
    return link;
  }

  addSyncAttempt(syncLinkId: string, attempt: SyncAttempt) {
    const link = this.data.syncLinks.find(s => s.id === syncLinkId);
    if (!link) return;
    link.attempts.push(attempt);
    link.updatedAt = new Date().toISOString();
    this.saveToDisk();
  }

  updateSyncAttempt(syncLinkId: string, attemptId: string, update: Partial<SyncAttempt>) {
    const link = this.data.syncLinks.find(s => s.id === syncLinkId);
    if (!link) return;
    const attempt = link.attempts.find(a => a.id === attemptId);
    if (!attempt) return;
    Object.assign(attempt, update);
    link.updatedAt = new Date().toISOString();
    this.saveToDisk();
  }

  // ─── Import Sessions ───

  listImportSessions(): ImportSessionRecord[] {
    return this.data.importSessions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getImportSession(id: string): ImportSessionRecord | null {
    return this.data.importSessions.find(s => s.id === id) ?? null;
  }

  createImport(larkUrl: string, targetFolderName: string): { session: ImportSessionRecord; syncLink: SyncLink } {
    const parsed = parseLarkFolderLink(larkUrl);
    if (!parsed) throw new Error('Invalid Lark folder link');

    const now = new Date().toISOString();
    const defaultFolder = targetFolderName?.trim() || now.slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const syncLink = this.findOrCreateSyncLink(larkUrl, defaultFolder);

    const session: ImportSessionRecord = {
      id: `imp_${crypto.randomUUID().slice(0, 12)}`,
      syncLinkId: syncLink.id,
      sourceReference: larkUrl,
      sourceFolderToken: parsed.folderToken,
      targetFolderName: defaultFolder,
      status: 'queued',
      totalFiles: 0,
      queuedFiles: 0,
      runningFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      totalBytes: 0,
      transferredBytes: 0,
      createdAt: now,
      updatedAt: now,
    };

    this.data.importSessions.unshift(session);
    this.saveToDisk();
    return { session, syncLink };
  }

  updateSession(id: string, update: Partial<ImportSessionRecord>) {
    const session = this.data.importSessions.find(s => s.id === id);
    if (!session) return null;
    Object.assign(session, update, { updatedAt: new Date().toISOString() });
    this.saveToDisk();
    return session;
  }

  retryFailed(importSessionId: string) {
    const session = this.getImportSession(importSessionId);
    if (!session) return { accepted: false, reason: 'not_found' };
    session.status = 'queued';
    session.queuedFiles += session.failedFiles;
    session.failedFiles = 0;
    session.updatedAt = new Date().toISOString();
    this.saveToDisk();
    return { accepted: true, action: 'retry_failed' };
  }

  cancelImport(importSessionId: string) {
    const session = this.getImportSession(importSessionId);
    if (!session) return { accepted: false, reason: 'not_found' };
    session.status = 'cancelled';
    session.updatedAt = new Date().toISOString();
    this.saveToDisk();
    return { accepted: true, action: 'cancel' };
  }

  // ─── Transfer Jobs ───

  listTransferJobs(importSessionId: string): TransferJobRecord[] {
    return this.data.transferJobs.filter(j => j.importSessionId === importSessionId);
  }

  addTransferJob(data: {
    importSessionId: string;
    fileName: string;
    fileSize: number;
    sourceFileId: string;
    sourcePath: string;
    targetBucket: string;
    targetObjectKey: string;
  }): TransferJobRecord {
    const now = new Date().toISOString();
    const job: TransferJobRecord = {
      id: `job_${crypto.randomUUID().slice(0, 12)}`,
      importSessionId: data.importSessionId,
      status: 'queued',
      sourceFileId: data.sourceFileId,
      sourcePath: data.sourcePath,
      fileName: data.fileName,
      fileSize: data.fileSize,
      targetBucket: data.targetBucket,
      targetObjectKey: data.targetObjectKey,
      workerId: null,
      bytesTransferred: 0,
      retryCount: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    this.data.transferJobs.push(job);

    // Update session counters
    const session = this.getImportSession(data.importSessionId);
    if (session) {
      const sessionJobs = this.data.transferJobs.filter(j => j.importSessionId === data.importSessionId);
      session.totalFiles = sessionJobs.length;
      session.queuedFiles = sessionJobs.filter(j => j.status === 'queued').length;
      session.totalBytes = sessionJobs.reduce((sum, j) => sum + j.fileSize, 0);
      session.updatedAt = now;
    }

    this.saveToDisk();
    return job;
  }

  updateJobProgress(jobId: string, workerId: string, status: TransferJobStatus, bytesTransferred: number, lastError?: string) {
    const job = this.data.transferJobs.find(j => j.id === jobId);
    if (!job) return { ok: false };

    const prevStatus = job.status;
    job.status = status;
    job.workerId = workerId;
    job.bytesTransferred = bytesTransferred;
    if (lastError !== undefined) job.lastError = lastError;
    job.updatedAt = new Date().toISOString();

    const session = this.data.importSessions.find(s => s.id === job.importSessionId);
    if (session) {
      if (prevStatus === 'queued' && (status === 'downloading' || status === 'uploading')) {
        session.queuedFiles = Math.max(0, session.queuedFiles - 1);
        session.runningFiles++;
      } else if (status === 'completed' && prevStatus !== 'completed') {
        session.completedFiles++;
        session.runningFiles = Math.max(0, session.runningFiles - 1);
      } else if (status === 'failed' && prevStatus !== 'failed') {
        session.failedFiles++;
        session.runningFiles = Math.max(0, session.runningFiles - 1);
      }

      session.transferredBytes = this.data.transferJobs
        .filter(j => j.importSessionId === session.id)
        .reduce((sum, j) => sum + j.bytesTransferred, 0);

      const done = session.completedFiles + session.failedFiles;
      if (done >= session.totalFiles && session.totalFiles > 0 && session.status === 'running') {
        session.status = session.failedFiles > 0 ? 'partial_failed' : 'completed';
      }

      session.updatedAt = new Date().toISOString();
    }

    this.saveToDisk();
    return { ok: true };
  }

  // ─── Worker registry (in-memory) ───

  registerHeartbeat(workerId: string, status: 'idle' | 'busy', currentSessionId: string | null, processedJobs: number) {
    this.workerRegistry.set(workerId, {
      workerId,
      lastSeen: new Date().toISOString(),
      status,
      currentSessionId,
      processedJobs,
    });
  }

  getWorkerStatus() {
    return Array.from(this.workerRegistry.values());
  }

  // ─── Log streaming (in-memory) ───

  addLog(log: Omit<TransferLog, 'id'>): TransferLog {
    const entry = { ...log, id: `log_${crypto.randomUUID().slice(0, 8)}` };
    this.transferLogs.push(entry);
    if (this.transferLogs.length > 5000) {
      this.transferLogs = this.transferLogs.slice(-5000);
    }
    this.notifyLogSubscribers(entry);
    return entry;
  }

  getLogsBySession(sessionId: string, after?: string): TransferLog[] {
    let logs = this.transferLogs.filter(l => l.sessionId === sessionId);
    if (after) {
      const idx = logs.findIndex(l => l.id === after);
      if (idx >= 0) logs = logs.slice(idx + 1);
    }
    return logs;
  }

  subscribeToLogs(sessionId: string, controller: ReadableStreamDefaultController) {
    this.logSubscribers.push({ sessionId, controller });
  }

  unsubscribeFromLogs(controller: ReadableStreamDefaultController) {
    this.logSubscribers = this.logSubscribers.filter(s => s.controller !== controller);
  }

  private notifyLogSubscribers(log: TransferLog) {
    for (const sub of this.logSubscribers) {
      if (sub.sessionId === log.sessionId) {
        try { sub.controller.enqueue(`data: ${JSON.stringify(log)}\n\n`); } catch { /* disconnected */ }
      }
    }
  }
}

export const store = new PersistentStore();
