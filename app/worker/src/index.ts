import { Worker as BullWorker } from 'bullmq';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { listLarkFolderFiles, downloadLarkFileStream, type LarkFileEntry } from './lark-api';
import { ensureBucket, uploadStream } from './minio-client';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001/api';
const REDIS_HOST = process.env.REDIS_HOST ?? 'localhost';
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'lark-import';
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'http://localhost:9000';
const WORKER_ID = `worker_${crypto.randomUUID().slice(0, 8)}`;
const CONCURRENCY = 5;
const MAX_RETRIES = 5;
const HEARTBEAT_INTERVAL_MS = 4000;

let processedJobs = 0;
let currentSessionId: string | null = null;

// ─── S3 client for listing existing keys ───
const s3 = new S3Client({
  endpoint: MINIO_ENDPOINT,
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.MINIO_ROOT_USER ?? 'minioadmin',
    secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? 'minioadmin',
  },
  forcePathStyle: true,
});

// ─── Backend API helpers ───
async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json() as Promise<T>;
}

async function patch(path: string, body: unknown): Promise<void> {
  await fetch(`${BACKEND_URL}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function updateJob(jobId: string, status: string, bytesTransferred: number, extra?: { lastError?: string; fileSize?: number }) {
  await patch(`/worker/jobs/${jobId}`, {
    workerId: WORKER_ID,
    status,
    bytesTransferred,
    ...extra,
  });
}

async function sendHeartbeat() {
  await post('/worker/heartbeat', {
    workerId: WORKER_ID,
    status: currentSessionId ? 'busy' : 'idle',
    currentSessionId,
    processedJobs,
  });
}

// ─── Load existing keys from MinIO ───
async function loadExistingKeys(prefix: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let ct: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: MINIO_BUCKET,
      Prefix: prefix,
      MaxKeys: 1000,
      ContinuationToken: ct,
    }));
    for (const o of (res.Contents ?? [])) if (o.Key) keys.add(o.Key);
    ct = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ct);
  return keys;
}

// ─── Single file transfer with retry ───
async function transferFile(
  jobId: string,
  file: LarkFileEntry,
  objectKey: string,
): Promise<{ status: string; size: number }> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await updateJob(jobId, 'downloading', 0);

      // Stream download → stream upload (no full file in RAM)
      const { stream, contentLength, mime } = await downloadLarkFileStream(
        file.token, file.type, file.resolvedToken, file.resolvedType,
      );

      // Update fileSize with actual content-length from download
      const actualSize = contentLength || file.size;
      if (actualSize > 0) {
        await updateJob(jobId, 'uploading', 0, { fileSize: actualSize });
      } else {
        await updateJob(jobId, 'uploading', 0);
      }

      // Stream directly to MinIO
      let uploaded = 0;
      await uploadStream(MINIO_BUCKET, objectKey, stream, mime, (loaded) => {
        uploaded = loaded;
        updateJob(jobId, 'uploading', uploaded).catch(() => {});
      });

      await updateJob(jobId, 'completed', uploaded || actualSize, { fileSize: uploaded || actualSize });
      processedJobs++;
      console.log(`  [OK] ${file.path} (${(uploaded / 1024 / 1024).toFixed(1)}MB)`);
      return { status: 'OK', size: uploaded || actualSize };
    } catch (err: any) {
      const msg = err.message?.slice(0, 150) ?? '';

      // 403 = permission denied → skip retry immediately
      if (msg.includes('403') || msg.includes('permission') || msg.includes('forbidden')) {
        console.log(`  [SKIP] ${file.path}: 403 — no retry`);
        await updateJob(jobId, 'failed', 0, { lastError: msg });
        return { status: `FAILED: ${msg}`, size: 0 };
      }

      if (attempt < MAX_RETRIES) {
        const isRL = msg.includes('429') || msg.includes('99991400') || msg.includes('frequency');
        const delay = isRL ? 2000 * Math.pow(1.5, attempt) + Math.random() * 3000 : 1000 * attempt;
        console.log(`  [retry ${attempt}/${MAX_RETRIES}] ${file.name}: ${msg}`);
        await Bun.sleep(delay);
      } else {
        console.log(`  [FAIL] ${file.path}: ${msg}`);
        await updateJob(jobId, 'failed', 0, { lastError: msg });
        return { status: `FAILED: ${msg}`, size: 0 };
      }
    }
  }
  return { status: 'FAILED: exhausted retries', size: 0 };
}

// ─── Process a sync session (fill-gaps logic) ───
async function processSession(jobData: {
  sessionId: string;
  syncLinkId: string;
  folderToken: string;
  targetFolderName: string;
  larkUrl: string;
}) {
  const { sessionId, syncLinkId, folderToken, targetFolderName } = jobData;
  currentSessionId = sessionId;
  const t0 = Date.now();

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  Session: ${sessionId}`);
  console.log(`  Lark: ${folderToken}`);
  console.log(`  Target: ${targetFolderName}/`);
  console.log(`${'='.repeat(60)}`);

  // Mark session running
  await patch(`/worker/sessions/${sessionId}`, { status: 'running' });

  // Step 1: Load existing MinIO keys
  console.log('\n[1] Loading existing files from MinIO...');
  const existingKeys = await loadExistingKeys(`${targetFolderName}/`);
  console.log(`[1] MinIO has ${existingKeys.size} files`);

  // Step 2: Crawl Lark folder
  console.log('\n[2] Crawling Lark folder...');
  let larkFiles: LarkFileEntry[];
  try {
    larkFiles = await listLarkFolderFiles(folderToken);
  } catch (err: any) {
    console.error(`[2] FAILED to list: ${err.message}`);
    await patch(`/worker/sessions/${sessionId}`, { status: 'failed' });
    currentSessionId = null;
    return;
  }
  console.log(`[2] Lark has ${larkFiles.length} files`);

  // Step 3: Diff → find missing
  const missing: LarkFileEntry[] = [];
  for (const f of larkFiles) {
    const key = `${targetFolderName}/${f.path}`;
    if (!existingKeys.has(key)) missing.push(f);
  }

  console.log(`\n[3] Diff: Lark=${larkFiles.length} MinIO=${existingKeys.size} Missing=${missing.length}`);

  // Create sync attempt record
  const attemptId = `att_${crypto.randomUUID().slice(0, 12)}`;
  const syncLinkRes = await fetch(`${BACKEND_URL}/sync-links/${syncLinkId}`);
  const syncLinkData = await syncLinkRes.json() as any;
  const attemptNumber = (syncLinkData?.item?.attempts?.length ?? 0) + 1;

  await post('/worker/sync-attempts', {
    syncLinkId,
    attempt: {
      id: attemptId,
      sessionId,
      attemptNumber,
      larkTotal: larkFiles.length,
      minioBeforeSync: existingKeys.size,
      minioAfterSync: existingKeys.size,
      missing: missing.length,
      synced: 0,
      failed: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      status: 'running',
    },
  });

  if (missing.length === 0) {
    console.log('\n  All files already synced! Nothing to do.');
    await patch(`/worker/sessions/${sessionId}`, {
      status: 'completed',
      totalFiles: larkFiles.length,
      completedFiles: larkFiles.length,
    });
    await patch(`/worker/sync-attempts/${syncLinkId}/${attemptId}`, {
      minioAfterSync: existingKeys.size,
      synced: 0,
      failed: 0,
      completedAt: new Date().toISOString(),
      status: 'completed',
    });
    currentSessionId = null;
    return;
  }

  // Update session with totals
  await patch(`/worker/sessions/${sessionId}`, {
    totalFiles: missing.length,
    queuedFiles: missing.length,
    totalBytes: missing.reduce((sum, f) => sum + f.size, 0),
  });

  // Step 4: Create jobs for missing files
  console.log(`\n[4] Creating ${missing.length} transfer jobs...`);
  const jobs: Array<{ jobId: string; file: LarkFileEntry }> = [];
  for (const file of missing) {
    const result = await post<{ job: { id: string } }>('/worker/jobs', {
      importSessionId: sessionId,
      fileName: file.name,
      fileSize: file.size,
      sourceFileId: file.token,
      sourcePath: file.path,
      targetBucket: MINIO_BUCKET,
      targetObjectKey: `${targetFolderName}/${file.path}`,
    });
    jobs.push({ jobId: result.job.id, file });
  }

  // Step 5: Transfer with concurrency (fill-gaps style)
  console.log(`\n[5] Transferring ${missing.length} files (concurrency=${CONCURRENCY})...\n`);

  let ok = 0;
  let fail = 0;
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= jobs.length) break;
      const { jobId, file } = jobs[i];
      const objectKey = `${targetFolderName}/${file.path}`;
      const result = await transferFile(jobId, file, objectKey);
      if (result.status === 'OK') ok++;
      else fail++;

      if ((ok + fail) % 20 === 0) {
        const pct = ((ok + fail) / missing.length * 100).toFixed(0);
        console.log(`  [progress] ${ok} OK | ${fail} fail | ${pct}%`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, () => worker()));

  // Step 6: Verify final state
  const afterKeys = await loadExistingKeys(`${targetFolderName}/`);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  DONE — ${elapsed}s`);
  console.log(`  Missing: ${missing.length} | Synced: ${ok} | Failed: ${fail}`);
  console.log(`  MinIO before: ${existingKeys.size} → after: ${afterKeys.size}`);
  console.log(`${'='.repeat(60)}\n`);

  // Update sync attempt
  await patch(`/worker/sync-attempts/${syncLinkId}/${attemptId}`, {
    minioAfterSync: afterKeys.size,
    synced: ok,
    failed: fail,
    completedAt: new Date().toISOString(),
    status: fail > 0 ? 'partial_failed' : 'completed',
  });

  currentSessionId = null;
}

// ─── Heartbeat loop ───
async function heartbeatLoop() {
  while (true) {
    try { await sendHeartbeat(); } catch { /* backend may not be ready */ }
    await Bun.sleep(HEARTBEAT_INTERVAL_MS);
  }
}

// ─── Boot ───
console.log(`[${WORKER_ID}] booting — backend=${BACKEND_URL} redis=${REDIS_HOST}:${REDIS_PORT} bucket=${MINIO_BUCKET}`);
await ensureBucket(MINIO_BUCKET);
console.log(`[${WORKER_ID}] MinIO bucket "${MINIO_BUCKET}" ready`);

// BullMQ worker
const bullWorker = new BullWorker('lark-transfer', async (job) => {
  console.log(`[${WORKER_ID}] received job ${job.id} from BullMQ`);
  await processSession(job.data);
}, {
  connection: { host: REDIS_HOST, port: REDIS_PORT },
  concurrency: 3,  // 3 sessions in parallel per worker
});

bullWorker.on('completed', (job) => {
  console.log(`[${WORKER_ID}] job ${job.id} completed`);
});

bullWorker.on('failed', (job, err) => {
  console.error(`[${WORKER_ID}] job ${job?.id} failed:`, err.message);
});

console.log(`[${WORKER_ID}] BullMQ worker listening on queue "lark-transfer"\n`);

// Start heartbeat
heartbeatLoop();
