export type ImportSessionStatus =
  | 'queued'
  | 'running'
  | 'partial_failed'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TransferJobStatus =
  | 'pending'
  | 'queued'
  | 'downloading'
  | 'uploading'
  | 'completed'
  | 'failed';

export type ParsedLarkFolderLink = {
  workspaceDomain: string;
  resourceType: 'folder';
  folderToken: string;
  originalUrl: string;
};

// ─── Sync attempt: one run of fill-gaps for a specific link ───
export type SyncAttempt = {
  id: string;
  sessionId: string;            // links to ImportSessionRecord
  attemptNumber: number;        // 1st, 2nd, 3rd...
  larkTotal: number;            // total files found on Lark
  minioBeforeSync: number;      // files in MinIO before this attempt
  minioAfterSync: number;       // files in MinIO after this attempt
  missing: number;              // files that were missing (larkTotal - minioBeforeSync)
  synced: number;               // files successfully synced this attempt
  failed: number;               // files that failed this attempt
  startedAt: string;
  completedAt: string | null;
  status: 'running' | 'completed' | 'partial_failed' | 'failed';
};

// ─── Sync link: tracks all attempts for a given Lark link ───
export type SyncLink = {
  id: string;
  larkUrl: string;              // original Lark URL
  folderToken: string;          // parsed folder token
  targetPrefix: string;         // MinIO target prefix
  attempts: SyncAttempt[];
  createdAt: string;
  updatedAt: string;
};

export type ImportSessionRecord = {
  id: string;
  syncLinkId: string;           // which SyncLink this belongs to
  sourceReference: string;      // original Lark URL
  sourceFolderToken: string;
  targetFolderName: string;
  status: ImportSessionStatus;
  totalFiles: number;
  queuedFiles: number;
  runningFiles: number;
  completedFiles: number;
  failedFiles: number;
  totalBytes: number;
  transferredBytes: number;
  createdAt: string;
  updatedAt: string;
};

export type TransferJobRecord = {
  id: string;
  importSessionId: string;
  status: TransferJobStatus;
  sourceFileId: string;
  sourcePath: string;
  fileName: string;
  fileSize: number;
  targetBucket: string;
  targetObjectKey: string;
  workerId: string | null;
  bytesTransferred: number;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

// ─── API contracts ───
export type CreateImportRequest = {
  larkUrl: string;
  targetFolderName?: string | null;
};

export type CreateImportResponse = {
  item: ImportSessionRecord;
  syncLink: SyncLink;
};

export type ListImportsResponse = {
  items: ImportSessionRecord[];
};

export type ListSyncLinksResponse = {
  items: SyncLink[];
};

export type GetSyncLinkResponse = {
  item: SyncLink | null;
};
