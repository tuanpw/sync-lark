/**
 * Lark Drive → MinIO — folder-by-folder sync (A→Z)
 *
 * Flow:
 * 1. Auth + MinIO setup
 * 2. List root folder → sort A-Z → for each subfolder:
 *    - Recursively scan all files (including nested subfolders)
 *    - Transfer immediately with concurrency
 *    - Print summary per folder
 * 3. Grand total summary
 *
 * Usage: bun run test-e2e.ts
 * Env: LARK_APP_ID, LARK_APP_SECRET, MINIO_ENDPOINT, MINIO_ROOT_USER, MINIO_ROOT_PASSWORD, MINIO_BUCKET
 */

import { S3Client, HeadBucketCommand, CreateBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

// ─── Config ───
const LARK_API_BASE = 'https://open.larksuite.com';
const APP_ID = process.env.LARK_APP_ID ?? '';
const APP_SECRET = process.env.LARK_APP_SECRET ?? '';
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'http://localhost:9000';
const MINIO_ACCESS_KEY = process.env.MINIO_ROOT_USER ?? 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_ROOT_PASSWORD ?? 'minioadmin';
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'lark-import';

const FOLDER_TOKEN = process.argv[2] ?? 'KU5Bfaa8QlVCqXdtkxvunrojsz5';
const TARGET_PREFIX = process.argv[3] ?? 'Mockups';

// ─── Tuning ───
const TRANSFER_CONCURRENCY = 20;
const MAX_RETRIES = 10;
const LARK_QPS = 50;

// ─── Export format mapping ───
const EXPORT_FORMATS: Record<string, string> = {
  docx: 'docx', doc: 'docx', sheet: 'xlsx', bitable: 'xlsx', slides: 'pdf',
};
const SYNCABLE_TYPES = new Set(['file', ...Object.keys(EXPORT_FORMATS)]);

// ─── Rate Limiter ───
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  constructor(private qps: number) { this.tokens = qps; this.lastRefill = Date.now(); }
  private refill() {
    const now = Date.now();
    this.tokens = Math.min(this.qps, this.tokens + ((now - this.lastRefill) / 1000) * this.qps);
    this.lastRefill = now;
  }
  async acquire() {
    this.refill();
    if (this.tokens >= 1) { this.tokens--; return; }
    const waitMs = ((1 - this.tokens) / this.qps) * 1000;
    await new Promise<void>(r => setTimeout(() => { this.refill(); this.tokens = Math.max(0, this.tokens - 1); r(); }, waitMs + 50));
  }
}
const rateLimiter = new RateLimiter(LARK_QPS);

async function larkFetch(url: string, init?: RequestInit): Promise<Response> {
  await rateLimiter.acquire();
  return fetch(url, init);
}

// ─── TokenManager ───
class TokenManager {
  private token = '';
  private expiresAt = 0;
  async get(): Promise<string> {
    if (!this.token || Date.now() >= this.expiresAt) await this.refresh();
    return this.token;
  }
  private async refresh() {
    const res = await fetch(`${LARK_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
    });
    const data = await res.json() as any;
    if (data.code !== 0) throw new Error(`Auth failed: ${data.msg}`);
    this.token = data.tenant_access_token;
    this.expiresAt = Date.now() + 90 * 60 * 1000;
  }
}

// ─── Retry ───
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (err: any) {
      if (attempt >= MAX_RETRIES) throw err;
      const msg = err.message ?? '';
      if (msg.includes('Download 403')) throw err;
      const isRL = msg.includes('429') || msg.includes('99991400') || msg.includes('frequency');
      const delay = isRL ? 2000 * Math.pow(1.5, attempt) + Math.random() * 3000 : 1000 * attempt;
      if (attempt <= 3 || attempt % 3 === 0) console.log(`   [retry ${attempt}/${MAX_RETRIES}] ${label}: ${msg.slice(0, 80)} — ${(delay / 1000).toFixed(1)}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

type FileEntry = { token: string; name: string; type: string; path: string; size: number };

// ─── List one folder (all pages) ───
async function listOneFolder(folderToken: string, tm: TokenManager) {
  const children: Array<{ token: string; name: string; type: string; size: number }> = [];
  let pageToken: string | null = null;
  do {
    const url = new URL(`${LARK_API_BASE}/open-apis/drive/v1/files`);
    url.searchParams.set('folder_token', folderToken);
    url.searchParams.set('page_size', '200');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const data = await withRetry(async () => {
      const t = await tm.get();
      const res = await larkFetch(url.toString(), { headers: { Authorization: `Bearer ${t}` } });
      const json = await res.json() as any;
      if (json.code !== 0) throw new Error(`List (${json.code}): ${json.msg}`);
      return json;
    }, `list ${folderToken.slice(0, 8)}`);
    for (const f of (data.data?.files ?? [])) children.push({ token: f.token, name: f.name, type: f.type, size: f.size ?? 0 });
    pageToken = data.data?.has_more ? data.data.next_page_token : null;
  } while (pageToken);
  return children;
}

// ─── Recursively scan a folder → flat file list ───
async function scanFolderRecursive(folderToken: string, pathPrefix: string, tm: TokenManager): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  const children = await listOneFolder(folderToken, tm);

  const subfolders: Array<{ token: string; name: string }> = [];
  for (const c of children) {
    if (c.type === 'folder') {
      subfolders.push({ token: c.token, name: c.name });
    } else if (SYNCABLE_TYPES.has(c.type)) {
      files.push({ token: c.token, name: c.name, type: c.type, path: `${pathPrefix}${c.name}`, size: c.size });
    }
  }

  // Recurse into subfolders
  for (const sf of subfolders) {
    const subFiles = await scanFolderRecursive(sf.token, `${pathPrefix}${sf.name}/`, tm);
    files.push(...subFiles);
  }

  return files;
}

// ─── MinIO setup ───
function getS3() {
  return new S3Client({
    endpoint: MINIO_ENDPOINT, region: 'us-east-1',
    credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
    forcePathStyle: true,
  });
}

async function ensureBucket(s3: S3Client) {
  try { await s3.send(new HeadBucketCommand({ Bucket: MINIO_BUCKET })); }
  catch { await s3.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET })); }
}

async function loadExistingKeys(s3: S3Client, prefix: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let ct: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: MINIO_BUCKET, Prefix: prefix, MaxKeys: 1000, ContinuationToken: ct }));
    for (const o of (res.Contents ?? [])) if (o.Key) keys.add(o.Key);
    ct = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ct);
  return keys;
}

// ─── Build MinIO key ───
function buildKey(f: FileEntry): string {
  const ext = EXPORT_FORMATS[f.type];
  if (!ext) return `${TARGET_PREFIX}/${f.path}`;
  const hasExt = f.name.toLowerCase().endsWith(`.${ext}`);
  return `${TARGET_PREFIX}/${f.path}${hasExt ? '' : `.${ext}`}`;
}

// ─── Stream transfer: Lark → MinIO ───
async function streamTransfer(fileToken: string, fileName: string, key: string, tm: TokenManager, s3: S3Client) {
  const endpoints = [
    `${LARK_API_BASE}/open-apis/drive/v1/files/${fileToken}/download`,
    `${LARK_API_BASE}/open-apis/drive/v1/medias/${fileToken}/download`,
  ];
  return withRetry(async () => {
    const t = await tm.get();
    let lastErr = '';
    for (const url of endpoints) {
      const res = await larkFetch(url, { headers: { Authorization: `Bearer ${t}` } });
      if (res.ok) {
        const ct = res.headers.get('content-type') ?? 'application/octet-stream';
        await new Upload({ client: s3, params: { Bucket: MINIO_BUCKET, Key: key, Body: res.body!, ContentType: ct }, queueSize: 2, partSize: 10 * 1024 * 1024 }).done();
        return;
      }
      const body = await res.text().catch(() => '');
      lastErr = `Download ${res.status}: ${body.slice(0, 200)}`;
      // Rate limit → throw to trigger withRetry backoff (not fallback)
      if (body.includes('99991400') || body.includes('frequency') || res.status === 429) throw new Error(lastErr);
      // Not 403 → throw immediately
      if (res.status !== 403) throw new Error(lastErr);
    }
    throw new Error(lastErr);
  }, `dl ${fileName.slice(0, 40)}`);
}

// ─── Export native doc ───
async function exportAndDownload(f: FileEntry, ext: string, tm: TokenManager): Promise<{ data: Uint8Array; contentType: string }> {
  const ticket = await withRetry(async () => {
    const t = await tm.get();
    const res = await larkFetch(`${LARK_API_BASE}/open-apis/drive/v1/export_tasks`, {
      method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_extension: ext, token: f.token, type: f.type }),
    });
    const json = await res.json() as any;
    if (json.code !== 0) throw new Error(`Export create (${json.code}): ${json.msg}`);
    return json.data.ticket;
  }, `export ${f.name.slice(0, 30)}`);

  for (let i = 0; i < 90; i++) {
    const t = await tm.get();
    const res = await larkFetch(`${LARK_API_BASE}/open-apis/drive/v1/export_tasks/${ticket}?token=${f.token}`, { headers: { Authorization: `Bearer ${t}` } });
    const json = await res.json() as any;
    if (json.code === 99991400 || json.msg?.includes('frequency')) { await Bun.sleep(3000 + Math.random() * 2000); continue; }
    if (json.code !== 0) throw new Error(`Export poll (${json.code}): ${json.msg}`);
    const status = json.data?.result?.job_status;
    if (status === 0) {
      const eft = json.data.result.file_token;
      return withRetry(async () => {
        const dt = await tm.get();
        const dr = await larkFetch(`${LARK_API_BASE}/open-apis/drive/v1/export_tasks/file/${eft}/download`, { headers: { Authorization: `Bearer ${dt}` } });
        if (!dr.ok) throw new Error(`Export dl ${dr.status}`);
        return { data: new Uint8Array(await dr.arrayBuffer()), contentType: dr.headers.get('content-type') ?? 'application/octet-stream' };
      }, `export-dl ${f.name.slice(0, 30)}`);
    }
    if (status !== 1 && status !== 2) throw new Error(`Export failed (${status})`);
    await Bun.sleep(2500 + Math.random() * 1500);
  }
  throw new Error('Export timeout');
}

async function uploadToMinio(s3: S3Client, key: string, data: Uint8Array, ct: string) {
  await new Upload({ client: s3, params: { Bucket: MINIO_BUCKET, Key: key, Body: Buffer.from(data), ContentType: ct }, partSize: 10 * 1024 * 1024 }).done();
}

// ─── Transfer a list of files with concurrency ───
async function transferFiles(files: FileEntry[], tm: TokenManager, s3: S3Client, existingKeys: Set<string>) {
  let ok = 0, fail = 0, skipped = 0, exported = 0;
  const errors: Array<{ path: string; error: string }> = [];
  const t0 = Date.now();
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= files.length) break;
      const f = files[i];
      const key = buildKey(f);

      if (existingKeys.has(key)) { skipped++; continue; }

      try {
        if (f.type === 'file') {
          await streamTransfer(f.token, f.path, key, tm, s3);
        } else {
          const ext = EXPORT_FORMATS[f.type]!;
          const { data, contentType } = await exportAndDownload(f, ext, tm);
          await uploadToMinio(s3, key, data, contentType);
          exported++;
        }
        ok++;
        existingKeys.add(key); // mark as done
      } catch (err: any) {
        fail++;
        errors.push({ path: f.path, error: err.message?.slice(0, 80) ?? '' });
        console.error(`   [FAIL] ${f.path}: ${err.message?.slice(0, 80)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(TRANSFER_CONCURRENCY, files.length) }, () => worker()));
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  return { ok, fail, skipped, exported, errors, elapsed };
}

// ─── Main ───
async function main() {
  const t0 = Date.now();
  console.log('═'.repeat(60));
  console.log('  Lark → MinIO (folder-by-folder, A→Z)');
  console.log(`  Root:        ${FOLDER_TOKEN}`);
  console.log(`  Target:      ${TARGET_PREFIX}/`);
  console.log(`  Concurrency: ${TRANSFER_CONCURRENCY} | QPS: ${LARK_QPS} | Retries: ${MAX_RETRIES}`);
  console.log('═'.repeat(60));

  if (!APP_ID || !APP_SECRET) { console.error('Missing LARK_APP_ID / LARK_APP_SECRET'); process.exit(1); }

  // ── Step 1: Auth + MinIO ──
  console.log('\n[1] Auth + MinIO setup...');
  const tm = new TokenManager();
  const s3 = getS3();
  await tm.get();
  await ensureBucket(s3);
  const existingKeys = await loadExistingKeys(s3, `${TARGET_PREFIX}/`);
  console.log(`[1] OK — ${existingKeys.size} existing files on MinIO\n`);

  // ── Step 2: List root folder → sort A-Z ──
  console.log('[2] Listing root folder...');
  const rootChildren = await listOneFolder(FOLDER_TOKEN, tm);

  const topFolders = rootChildren.filter(c => c.type === 'folder').sort((a, b) => a.name.localeCompare(b.name));
  const topFiles = rootChildren.filter(c => c.type !== 'folder' && SYNCABLE_TYPES.has(c.type));

  console.log(`[2] Found ${topFolders.length} folders + ${topFiles.length} files at root (sorted A→Z)\n`);

  // ── Grand totals ──
  let grandOk = 0, grandFail = 0, grandSkip = 0, grandExported = 0;
  const allErrors: Array<{ path: string; error: string }> = [];
  let foldersDone = 0;

  // ── Transfer root-level files first ──
  if (topFiles.length > 0) {
    const rootFileEntries: FileEntry[] = topFiles.map(f => ({ token: f.token, name: f.name, type: f.type, path: f.name, size: f.size }));
    console.log(`── [root files] ${rootFileEntries.length} files ──`);
    const r = await transferFiles(rootFileEntries, tm, s3, existingKeys);
    grandOk += r.ok; grandFail += r.fail; grandSkip += r.skipped; grandExported += r.exported;
    allErrors.push(...r.errors);
    console.log(`   OK: ${r.ok} | Fail: ${r.fail} | Skip: ${r.skipped} | ${r.elapsed}s\n`);
  }

  // ── Process each top-level folder A→Z ──
  for (const folder of topFolders) {
    foldersDone++;
    const prefix = `${folder.name}/`;
    console.log(`── [${foldersDone}/${topFolders.length}] ${folder.name} ──`);

    // Scan recursively
    let files: FileEntry[];
    try {
      files = await scanFolderRecursive(folder.token, prefix, tm);
    } catch (err: any) {
      console.error(`   [SCAN ERR] ${err.message?.slice(0, 100)}`);
      continue;
    }

    if (files.length === 0) {
      console.log('   (empty)\n');
      continue;
    }

    // Count already done
    const newFiles = files.filter(f => !existingKeys.has(buildKey(f)));
    console.log(`   ${files.length} files found (${newFiles.length} new, ${files.length - newFiles.length} skip)`);

    if (newFiles.length === 0) {
      grandSkip += files.length;
      console.log(`   All done — skipped\n`);
      continue;
    }

    // Transfer
    const r = await transferFiles(files, tm, s3, existingKeys);
    grandOk += r.ok; grandFail += r.fail; grandSkip += r.skipped; grandExported += r.exported;
    allErrors.push(...r.errors);

    const totalDone = grandOk + grandFail + grandSkip;
    console.log(`   OK: ${r.ok} | Fail: ${r.fail} | Skip: ${r.skipped} | ${r.elapsed}s`);
    console.log(`   Progress: ${foldersDone}/${topFolders.length} folders | Total: ${totalDone} files\n`);
  }

  // ── Step 3: Summary ──
  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log('═'.repeat(60));
  console.log(`  DONE — ${totalElapsed}s`);
  console.log('═'.repeat(60));
  console.log(`  Folders: ${topFolders.length}`);
  console.log(`  OK: ${grandOk} (${grandExported} exported) | Failed: ${grandFail} | Skipped: ${grandSkip}`);
  console.log(`  Total: ${grandOk + grandFail + grandSkip}`);

  if (allErrors.length > 0) {
    console.log(`\n  Failed files (${allErrors.length}):`);
    for (const e of allErrors) console.log(`    - ${e.path}: ${e.error}`);
  }

  console.log(`\n  MinIO: ${MINIO_ENDPOINT.replace(':9000', ':9001')} → "${MINIO_BUCKET}" → "${TARGET_PREFIX}/"`);
}

main().catch(err => { console.error('\nFATAL:', err); process.exit(1); });
