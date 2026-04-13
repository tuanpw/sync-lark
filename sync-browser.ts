/**
 * Browser-based Lark → MinIO sync (bypasses API rate limits)
 *
 * Step 1: bun run get-cookies.ts    → login in Chrome, saves cookies.json
 * Step 2: bun run sync-browser.ts <folderUrl> [targetPrefix]  → sync using saved cookies
 *
 * Usage:
 *   bun run sync-browser.ts "https://printway.sg.larksuite.com/drive/folder/KU5Bfaa8QlVCqXdtkxvunrojsz5" Mockup
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { S3Client, HeadBucketCommand, CreateBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

// ─── Config ───
const FOLDER_URL = process.argv[2] ?? '';
const TARGET_PREFIX = process.argv[3] ?? 'sync-' + new Date().toISOString().slice(0, 10);
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'http://localhost:9000';
const MINIO_ACCESS_KEY = process.env.MINIO_ROOT_USER ?? 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_ROOT_PASSWORD ?? 'minioadmin';
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'lark-import';
const DOWNLOAD_CONCURRENCY = parseInt(process.env.DL_CONCURRENCY ?? '10', 10);
const LIST_CONCURRENCY = parseInt(process.env.LIST_CONCURRENCY ?? '3', 10);

// Parse folder URL
function parseFolderUrl(url: string) {
  const m = url.match(/https?:\/\/([^/]+)\/drive\/folder\/([^?/]+)/);
  if (!m) throw new Error(`Invalid Lark folder URL: ${url}`);
  return { host: m[1], folderToken: m[2], apiBase: `https://${m[1]}` };
}

// ─── MinIO setup ───
const s3 = new S3Client({
  endpoint: MINIO_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
  forcePathStyle: true,
});

async function ensureBucket() {
  try { await s3.send(new HeadBucketCommand({ Bucket: MINIO_BUCKET })); }
  catch { await s3.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET })); }
}

async function loadExistingKeys(prefix: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: MINIO_BUCKET, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token,
    }));
    for (const o of res.Contents ?? []) if (o.Key) keys.add(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

// ─── AsyncQueue ───
class AsyncQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(v: T | null) => void> = [];
  private _closed = false;
  push(item: T) { const w = this.waiters.shift(); if (w) w(item); else this.buffer.push(item); }
  async pop(): Promise<T | null> {
    if (this.buffer.length > 0) return this.buffer.shift()!;
    if (this._closed) return null;
    return new Promise<T | null>(r => this.waiters.push(r));
  }
  close() { this._closed = true; for (const w of this.waiters) w(null); this.waiters = []; }
}

type FileEntry = { token: string; name: string; type: string; path: string };

// ─── Cookies for download, Open API (tenant token) for listing ───
let cookieHeader = '';

const LARK_APP_ID = process.env.LARK_APP_ID ?? '';
const LARK_APP_SECRET = process.env.LARK_APP_SECRET ?? '';

// Tenant token for listing (Open API)
let tenantToken = '';
let tenantTokenExpiry = 0;

async function getTenantToken(): Promise<string> {
  if (tenantToken && Date.now() < tenantTokenExpiry - 5 * 60 * 1000) return tenantToken;
  const res = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: LARK_APP_ID, app_secret: LARK_APP_SECRET }),
  });
  const data = await res.json() as any;
  if (data.code !== 0) throw new Error(`Auth: ${data.msg}`);
  tenantToken = data.tenant_access_token;
  tenantTokenExpiry = Date.now() + (data.expire ?? 7200) * 1000;
  console.log('[auth] tenant token refreshed');
  return tenantToken;
}

// List folder via Open API (tenant token) with full retry
async function listFolder(folderToken: string): Promise<Array<{ token: string; name: string; type: string }>> {
  const all: Array<{ token: string; name: string; type: string }> = [];
  let pageToken: string | null = null;
  do {
    const url = new URL('https://open.larksuite.com/open-apis/drive/v1/files');
    url.searchParams.set('folder_token', folderToken);
    url.searchParams.set('page_size', '200');
    if (pageToken) url.searchParams.set('page_token', pageToken);

    let success = false;
    for (let attempt = 1; attempt <= 10; attempt++) {
      const token = await getTenantToken();
      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json() as any;

      // Rate limit or frequency limit → wait and retry
      if (data.code === 99991400 || res.status === 429 || (data.msg ?? '').includes('frequency')) {
        await Bun.sleep(2000 * attempt + Math.random() * 2000);
        continue;
      }
      // Token expired → force refresh and retry
      if (data.code === 99991668 || data.code === 99991663) {
        tenantToken = ''; tenantTokenExpiry = 0;
        await Bun.sleep(1000);
        continue;
      }
      if (data.code !== 0) {
        if (attempt < 10) { await Bun.sleep(2000); continue; }
        throw new Error(`List (${data.code}): ${data.msg}`);
      }

      for (const f of data.data?.files ?? []) {
        all.push({ token: f.token, name: f.name, type: f.type });
      }
      pageToken = data.data?.has_more ? data.data.next_page_token : null;
      success = true;
      break;
    }
    if (!success) throw new Error(`List folder ${folderToken} failed after 10 retries`);
  } while (pageToken);
  return all;
}

// ─── Crawler ───
async function startCrawler(host: string, rootToken: string, fileQueue: AsyncQueue<FileEntry>) {
  const folderQueue: Array<{ token: string; path: string; retries?: number }> = [{ token: rootToken, path: '' }];
  let active = 0, scanned = 0, fileCount = 0;
  let waiters: Array<() => void> = [];
  const wake = () => { waiters.splice(0).forEach(r => r()); };

  async function worker() {
    while (true) {
      const task = folderQueue.shift();
      if (!task) {
        if (active === 0 && folderQueue.length === 0) return;
        await new Promise<void>(r => waiters.push(r));
        continue;
      }
      active++;
      try {
        const children = await listFolder(task.token);
        for (const c of children) {
          if (c.type === 'folder') {
            folderQueue.push({ token: c.token, path: `${task.path}${c.name}/` });
          } else {
            fileCount++;
            fileQueue.push({ token: c.token, name: c.name, type: c.type, path: `${task.path}${c.name}` });
          }
        }
        scanned++;
        if (scanned % 20 === 0 || scanned <= 3) {
          console.log(`[crawl] ${scanned} folders | ${fileCount} files | ${folderQueue.length} queued`);
        }
      } catch (err: any) {
        console.error(`[crawl ERR] ${task.path}: ${err.message?.slice(0, 100)}`);
        // Re-queue failed folder for retry (max 3 times)
        const retries = (task.retries ?? 0) + 1;
        if (retries <= 3) {
          folderQueue.push({ ...task, retries });
        } else {
          console.error(`[crawl SKIP] ${task.path} after ${retries} retries`);
        }
      } finally {
        active--;
        wake();
      }
    }
  }

  const t0 = Date.now();
  await Promise.all(Array.from({ length: LIST_CONCURRENCY }, () => worker()));
  fileQueue.close();
  console.log(`[crawl] Done: ${scanned} folders, ${fileCount} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { scanned, fileCount };
}

// ─── Download via browser CDN URL ───
async function downloadAndUpload(host: string, f: FileEntry, key: string) {
  // Lark file download URL (browser-style, uses cookies)
  const downloadUrl = `https://${host}/space/api/box/stream/download/all/${f.token}/?synced_block_host_token=&synced_block_host_type=`;

  const res = await fetch(downloadUrl, {
    headers: {
      'Cookie': cookieHeader,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': `https://${host}/drive/folder/`,
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    // Fallback: try open API endpoint with cookies
    const fallbackUrl = `https://open.larksuite.com/open-apis/drive/v1/files/${f.token}/download`;
    const res2 = await fetch(fallbackUrl, {
      headers: { 'Cookie': cookieHeader },
    });
    if (!res2.ok) throw new Error(`Download ${res.status}/${res2.status}`);
    const ct = res2.headers.get('content-type') ?? 'application/octet-stream';
    const upload = new Upload({
      client: s3,
      params: { Bucket: MINIO_BUCKET, Key: key, Body: res2.body!, ContentType: ct },
      partSize: 10 * 1024 * 1024,
    });
    await upload.done();
    return;
  }

  const ct = res.headers.get('content-type') ?? 'application/octet-stream';
  const upload = new Upload({
    client: s3,
    params: { Bucket: MINIO_BUCKET, Key: key, Body: res.body!, ContentType: ct },
    partSize: 10 * 1024 * 1024,
  });
  await upload.done();
}

// ─── Transfer workers ───
async function startTransfers(host: string, fileQueue: AsyncQueue<FileEntry>, existingKeys: Set<string>) {
  let ok = 0, fail = 0, skipped = 0;
  const errors: Array<{ path: string; error: string }> = [];
  const t0 = Date.now();

  async function worker() {
    while (true) {
      const f = await fileQueue.pop();
      if (!f) return;

      const key = `${TARGET_PREFIX}/${f.path}`;
      if (existingKeys.has(key)) { skipped++; continue; }

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await downloadAndUpload(host, f, key);
          ok++;
          if (ok % 20 === 0 || ok <= 3) {
            const elapsed = (Date.now() - t0) / 1000;
            console.log(`[transfer] ${ok} OK | ${fail} fail | ${skipped} skip | ${(ok / elapsed).toFixed(1)}/s`);
          }
          break;
        } catch (err: any) {
          if (attempt === 3) {
            fail++;
            errors.push({ path: f.path, error: err.message?.slice(0, 80) ?? '' });
            console.error(`[FAIL] ${f.path}: ${err.message?.slice(0, 80)}`);
          } else {
            await Bun.sleep(attempt * 1000);
          }
        }
      }
    }
  }

  await Promise.all(Array.from({ length: DOWNLOAD_CONCURRENCY }, () => worker()));
  return { ok, fail, skipped, errors };
}

// ─── Main ───
async function main() {
  if (!FOLDER_URL) {
    console.error('Usage: bun run sync-browser.ts <folderUrl> [targetPrefix]');
    console.error('Example: bun run sync-browser.ts "https://printway.sg.larksuite.com/drive/folder/KU5Bfaa8QlVCqXdtkxvunrojsz5" Mockup');
    process.exit(1);
  }

  const { host, folderToken } = parseFolderUrl(FOLDER_URL);
  console.log('═'.repeat(60));
  console.log('  Lark → MinIO (Browser-based, no API rate limit)');
  console.log(`  Folder:      ${folderToken}`);
  console.log(`  Target:      ${TARGET_PREFIX}/`);
  console.log(`  Concurrency: crawl=${LIST_CONCURRENCY} download=${DOWNLOAD_CONCURRENCY}`);
  console.log('═'.repeat(60));

  // Step 1: Load cookies from cookies.json (created by get-cookies.ts)
  const cookiesFile = join(import.meta.dir ?? process.cwd(), '..', '..', 'cookies.json').replace(/\\/g, '/');
  const cookiesPath = existsSync('cookies.json') ? 'cookies.json' : cookiesFile;

  if (!existsSync(cookiesPath)) {
    console.error('\n[step 1] cookies.json not found!');
    console.error('         Run first: bun run get-cookies.ts');
    console.error('         Login in Chrome, press Enter, then run this script again.');
    process.exit(1);
  }

  const savedCookies = JSON.parse(readFileSync(cookiesPath, 'utf-8'));
  cookieHeader = savedCookies.map((c: any) => `${c.name}=${c.value}`).join('; ');
  console.log(`[step 1] Loaded ${savedCookies.length} cookies from ${cookiesPath}\n`);

  // Step 2: Setup MinIO
  await ensureBucket();
  const existingKeys = await loadExistingKeys(`${TARGET_PREFIX}/`);
  console.log(`[step 2] MinIO ready, ${existingKeys.size} existing files\n`);

  // Step 3: Pipeline — crawl + transfer
  const fileQueue = new AsyncQueue<FileEntry>();
  const t0 = Date.now();

  const [crawlResult, transferResult] = await Promise.all([
    startCrawler(host, folderToken, fileQueue),
    startTransfers(host, fileQueue, existingKeys),
  ]);

  // Summary
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  DONE — ${elapsed}s`);
  console.log(`${'═'.repeat(60)}`);
  console.log(`  Folders: ${crawlResult.scanned} | Files found: ${crawlResult.fileCount}`);
  console.log(`  OK: ${transferResult.ok} | Failed: ${transferResult.fail} | Skipped: ${transferResult.skipped}`);

  if (transferResult.errors.length > 0) {
    console.log(`\n  Failed files:`);
    for (const e of transferResult.errors) console.log(`    - ${e.path}: ${e.error}`);
  }

  console.log(`\n  MinIO: ${MINIO_ENDPOINT.replace(':9000', ':9001')} → "${MINIO_BUCKET}" → "${TARGET_PREFIX}/"`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
