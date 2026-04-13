/**
 * Fill gaps: compare Lark folder vs MinIO → download only missing files
 *
 * Usage:
 *   bun run fill-gaps.ts [folderToken] [targetPrefix]
 *   bun run fill-gaps.ts KU5Bfaa8QlVCqXdtkxvunrojsz5 Mockup
 *
 * Flow:
 * 1. Load existing keys from MinIO
 * 2. Crawl Lark folder (fast, concurrent)
 * 3. Diff → show missing files grouped by folder
 * 4. Download only missing files (20 concurrent)
 */

import { S3Client, HeadBucketCommand, CreateBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as XLSX from 'xlsx';

// ─── Config ───
const LARK_API_BASE = 'https://open.larksuite.com';
const APP_ID = process.env.LARK_APP_ID ?? '';
const APP_SECRET = process.env.LARK_APP_SECRET ?? '';
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'http://localhost:9000';
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'lark-import';
const FOLDER_TOKEN = process.argv[2] ?? 'BlSBfSXoNluKI0d21LWuB1r4srh';
const TARGET_PREFIX = process.argv[3] ?? 'Media';
const DRY_RUN = process.argv.includes('--dry-run');
const TRANSFER_CONCURRENCY = 5;
const BATCH_SIZE = 200;
const MAX_RETRIES = 10;
const EXPORT_FORMATS: Record<string, string> = {
  docx: 'docx', doc: 'docx', sheet: 'xlsx', bitable: 'xlsx', slides: 'pdf',
};
const SYNCABLE_TYPES = new Set(['file', ...Object.keys(EXPORT_FORMATS)]);

// ─── TokenManager ───
class TokenManager {
  private token = ''; private expiresAt = 0;
  async get(): Promise<string> {
    if (!this.token || Date.now() >= this.expiresAt) {
      const res = await fetch(`${LARK_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
      });
      const d = await res.json() as any;
      if (d.code !== 0) throw new Error(`Auth: ${d.msg}`);
      this.token = d.tenant_access_token;
      this.expiresAt = Date.now() + 90 * 60 * 1000;
    }
    return this.token;
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
      if (attempt <= 3) console.log(`   [retry ${attempt}/${MAX_RETRIES}] ${label}: ${msg.slice(0, 80)}`);
      await Bun.sleep(delay);
    }
  }
}

type FileEntry = { token: string; name: string; type: string; path: string; size: number };

// ─── List one folder (all pages, with retry) ───
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
      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${t}` } });
      const json = await res.json() as any;
      if (json.code !== 0) throw new Error(`List (${json.code}): ${json.msg}`);
      return json;
    }, `list ${folderToken.slice(0, 8)}`);
    for (const f of (data.data?.files ?? [])) children.push({ token: f.token, name: f.name, type: f.type, size: f.size ?? 0 });
    pageToken = data.data?.has_more ? data.data.next_page_token : null;
  } while (pageToken);
  return children;
}

// ─── Concurrent folder crawler ───
async function crawlAll(tm: TokenManager): Promise<FileEntry[]> {
  const allFiles: FileEntry[] = [];
  const folderQueue: Array<{ token: string; path: string }> = [{ token: FOLDER_TOKEN, path: '' }];
  let active = 0, scanned = 0;
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
        const children = await listOneFolder(task.token, tm);
        for (const c of children) {
          if (c.type === 'folder') {
            folderQueue.push({ token: c.token, path: `${task.path}${c.name}/` });
          } else if (SYNCABLE_TYPES.has(c.type)) {
            allFiles.push({ token: c.token, name: c.name, type: c.type, path: `${task.path}${c.name}`, size: c.size });
          }
        }
        scanned++;
        if (scanned % 100 === 0) console.log(`   [crawl] ${scanned} folders | ${allFiles.length} files | ${folderQueue.length} queued`);
      } catch (err: any) {
        console.error(`   [crawl ERR] ${task.path}: ${err.message?.slice(0, 80)}`);
        folderQueue.push(task); // re-queue
      } finally { active--; wake(); }
    }
  }

  await Promise.all(Array.from({ length: 5 }, () => worker()));
  console.log(`   [crawl] Done: ${scanned} folders, ${allFiles.length} files`);
  return allFiles;
}

// ─── MinIO ───
const s3 = new S3Client({
  endpoint: MINIO_ENDPOINT, region: 'us-east-1',
  credentials: { accessKeyId: process.env.MINIO_ROOT_USER ?? '', secretAccessKey: process.env.MINIO_ROOT_PASSWORD ?? '' },
  forcePathStyle: true,
});

async function loadExistingKeys(prefix: string): Promise<Set<string>> {
  const keys = new Set<string>();
  let ct: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: MINIO_BUCKET, Prefix: prefix, MaxKeys: 1000, ContinuationToken: ct }));
    for (const o of (res.Contents ?? [])) if (o.Key) keys.add(o.Key);
    ct = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ct);
  return keys;
}

function buildKey(f: FileEntry): string {
  const ext = EXPORT_FORMATS[f.type];
  if (!ext) return `${TARGET_PREFIX}/${f.path}`;
  return `${TARGET_PREFIX}/${f.path}${f.name.toLowerCase().endsWith(`.${ext}`) ? '' : `.${ext}`}`;
}

// ─── Stream transfer ───
async function streamTransfer(f: FileEntry, key: string, tm: TokenManager) {
  const endpoints = [
    `${LARK_API_BASE}/open-apis/drive/v1/files/${f.token}/download`,
    `${LARK_API_BASE}/open-apis/drive/v1/medias/${f.token}/download`,
  ];
  return withRetry(async () => {
    const t = await tm.get();
    let lastErr = '';
    for (const url of endpoints) {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (res.ok) {
        const ct = res.headers.get('content-type') ?? 'application/octet-stream';
        await new Upload({ client: s3, params: { Bucket: MINIO_BUCKET, Key: key, Body: res.body!, ContentType: ct }, partSize: 10 * 1024 * 1024 }).done();
        return;
      }
      const body = await res.text().catch(() => '');
      lastErr = `Download ${res.status}: ${body.slice(0, 150)}`;
      if (body.includes('99991400') || body.includes('frequency') || res.status === 429) throw new Error(lastErr);
      if (res.status !== 403) throw new Error(lastErr);
    }
    throw new Error(lastErr);
  }, `dl ${f.name.slice(0, 40)}`);
}

// ─── Export native doc ───
async function exportTransfer(f: FileEntry, key: string, tm: TokenManager) {
  const ext = EXPORT_FORMATS[f.type]!;
  const ticket = await withRetry(async () => {
    const t = await tm.get();
    const res = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/export_tasks`, {
      method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_extension: ext, token: f.token, type: f.type }),
    });
    const json = await res.json() as any;
    if (json.code !== 0) throw new Error(`Export (${json.code}): ${json.msg}`);
    return json.data.ticket;
  }, `export ${f.name.slice(0, 30)}`);

  for (let i = 0; i < 90; i++) {
    const t = await tm.get();
    const res = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/export_tasks/${ticket}?token=${f.token}`, { headers: { Authorization: `Bearer ${t}` } });
    const json = await res.json() as any;
    if (json.code === 99991400) { await Bun.sleep(3000); continue; }
    if (json.code !== 0) throw new Error(`Poll (${json.code}): ${json.msg}`);
    if (json.data?.result?.job_status === 0) {
      const eft = json.data.result.file_token;
      return withRetry(async () => {
        const dt = await tm.get();
        const dr = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/export_tasks/file/${eft}/download`, { headers: { Authorization: `Bearer ${dt}` }, signal: AbortSignal.timeout(10 * 60 * 1000) });
        if (!dr.ok) throw new Error(`Export dl ${dr.status}`);
        const data = new Uint8Array(await dr.arrayBuffer());
        const ct = dr.headers.get('content-type') ?? 'application/octet-stream';
        await new Upload({ client: s3, params: { Bucket: MINIO_BUCKET, Key: key, Body: Buffer.from(data), ContentType: ct }, partSize: 10 * 1024 * 1024 }).done();
      }, `export-dl ${f.name.slice(0, 30)}`);
    }
    if (json.data?.result?.job_status >= 100) throw new Error(`Export failed`);
    await Bun.sleep(2500);
  }
  throw new Error('Export timeout');
}

// ─── Main ───
async function main() {
  const t0 = Date.now();
  console.log('═'.repeat(60));
  console.log('  Fill Gaps: Lark → MinIO (missing files only)');
  console.log(`  Lark:   ${FOLDER_TOKEN}`);
  console.log(`  MinIO:  ${TARGET_PREFIX}/`);
  console.log(`  Mode:   ${DRY_RUN ? 'DRY RUN (no download)' : `Transfer (${TRANSFER_CONCURRENCY} concurrent)`}`);
  console.log('═'.repeat(60));

  const tm = new TokenManager();

  // ── Step 1: Load MinIO keys ──
  console.log('\n[1] Loading existing files from MinIO...');
  try { await s3.send(new HeadBucketCommand({ Bucket: MINIO_BUCKET })); } catch { await s3.send(new CreateBucketCommand({ Bucket: MINIO_BUCKET })); }
  const existingKeys = await loadExistingKeys(`${TARGET_PREFIX}/`);
  console.log(`[1] MinIO has ${existingKeys.size} files\n`);

  // ── Step 2: Crawl Lark ──
  console.log('[2] Crawling Lark folder (recursive)...');
  const larkFiles = await crawlAll(tm);
  console.log(`[2] Lark has ${larkFiles.length} files\n`);

  // ── Step 3: Diff ──
  const missing: FileEntry[] = [];
  for (const f of larkFiles) {
    const key = buildKey(f);
    if (!existingKeys.has(key)) missing.push(f);
  }

  // Group missing by parent folder
  const byFolder = new Map<string, FileEntry[]>();
  for (const f of missing) {
    const parts = f.path.split('/');
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder)!.push(f);
  }

  console.log('[3] Diff result:');
  console.log(`    Lark total:  ${larkFiles.length}`);
  console.log(`    MinIO has:   ${existingKeys.size}`);
  console.log(`    Missing:     ${missing.length}`);
  console.log(`    Folders affected: ${byFolder.size}`);

  if (missing.length === 0) {
    console.log('\n    All files synced! Nothing to do.');
    return;
  }

  // Show missing by folder (sorted)
  const sortedFolders = [...byFolder.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  console.log(`\n    Missing files by folder:`);
  for (const [folder, files] of sortedFolders.slice(0, 30)) {
    console.log(`      ${folder}/ — ${files.length} missing`);
    for (const f of files.slice(0, 3)) console.log(`        - ${f.name}`);
    if (files.length > 3) console.log(`        ... +${files.length - 3} more`);
  }
  if (sortedFolders.length > 30) console.log(`      ... +${sortedFolders.length - 30} more folders`);

  if (DRY_RUN) {
    // Build Lark URL from file type + token
    const LARK_DOMAIN = 'https://printway.sg.larksuite.com';
    const TYPE_URL_MAP: Record<string, string> = {
      file: 'file', docx: 'docx', doc: 'docx', sheet: 'sheets', bitable: 'base', slides: 'slides',
    };
    const larkUrl = (f: FileEntry) => {
      const seg = TYPE_URL_MAP[f.type] ?? 'file';
      return `${LARK_DOMAIN}/${seg}/${f.token}`;
    };

    // Export missing files list to Excel
    const rows = missing.map(f => ({
      'File Name': f.name,
      'Path': f.path,
      'Lark URL': larkUrl(f),
      'MinIO Key': buildKey(f),
      'Type': f.type,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);

    // Add hyperlinks to Lark URL column (column C, starting row 2)
    for (let i = 0; i < missing.length; i++) {
      const cell = ws[XLSX.utils.encode_cell({ r: i + 1, c: 2 })];
      if (cell) cell.l = { Target: larkUrl(missing[i]) };
    }

    // Auto-fit column widths (cap at 80 to avoid overly wide columns)
    ws['!cols'] = Object.keys(rows[0] ?? {}).map(key => ({
      wch: Math.min(80, Math.max(key.length, ...rows.map(r => String((r as any)[key] ?? '').length))),
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Missing Files');
    const filename = `fill-gaps-${TARGET_PREFIX}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, filename);
    console.log(`\n    DRY RUN — exported ${missing.length} missing files to ${filename}`);
    console.log('    Remove --dry-run to sync.');
    return;
  }

  // ── Step 4: Download missing (in batches to avoid OOM) ──
  console.log(`\n[4] Downloading ${missing.length} missing files (${TRANSFER_CONCURRENCY} concurrent, batch ${BATCH_SIZE})...\n`);

  let ok = 0, fail = 0;
  const errors: Array<{ path: string; error: string }> = [];
  const transferStart = Date.now();

  for (let batchStart = 0; batchStart < missing.length; batchStart += BATCH_SIZE) {
    const batch = missing.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(missing.length / BATCH_SIZE);
    console.log(`\n   ── Batch ${batchNum}/${totalBatches} (${batch.length} files) ──`);

    let idx = 0;
    async function worker() {
      while (true) {
        const i = idx++;
        if (i >= batch.length) break;
        const globalIdx = batchStart + i;
        const f = batch[i];
        const key = buildKey(f);

        try {
          const sizeMB = (f.size / 1024 / 1024).toFixed(1);
          console.log(`   [dl ${globalIdx + 1}/${missing.length}] ${f.name.slice(0, 50)} (${sizeMB}MB)`);
          if (f.type === 'file') {
            await streamTransfer(f, key, tm);
          } else {
            await exportTransfer(f, key, tm);
          }
          ok++;
          if (ok % 50 === 0) {
            const elapsed = (Date.now() - transferStart) / 1000;
            const pct = ((ok + fail) / missing.length * 100).toFixed(0);
            console.log(`   [fill] ${ok} OK | ${fail} fail | ${pct}% | ${(ok / elapsed).toFixed(1)}/s`);
          }
        } catch (err: any) {
          fail++;
          errors.push({ path: f.path, error: err.message?.slice(0, 80) ?? '' });
          console.error(`   [FAIL] ${f.path}: ${err.message?.slice(0, 80)}`);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(TRANSFER_CONCURRENCY, batch.length) }, () => worker()));

    // Let GC reclaim connections between batches
    const elapsed = ((Date.now() - transferStart) / 1000).toFixed(0);
    console.log(`   [batch ${batchNum} done] ${ok} OK | ${fail} fail | ${elapsed}s elapsed`);
    if (batchStart + BATCH_SIZE < missing.length) {
      console.log(`   [pause 5s for GC...]`);
      await Bun.sleep(5000);
    }
  }

  // ── Summary ──
  const totalElapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  DONE — ${totalElapsed}s`);
  console.log('═'.repeat(60));
  console.log(`  Was missing:  ${missing.length}`);
  console.log(`  Filled:       ${ok}`);
  console.log(`  Still failed: ${fail}`);

  if (errors.length > 0) {
    console.log(`\n  Failed files (${errors.length}):`);
    for (const e of errors) console.log(`    - ${e.path}: ${e.error}`);
  }

  // Verify
  const afterKeys = await loadExistingKeys(`${TARGET_PREFIX}/`);
  console.log(`\n  MinIO before: ${existingKeys.size} → after: ${afterKeys.size}`);
  console.log(`  Lark total: ${larkFiles.length} | MinIO total: ${afterKeys.size} | Gap: ${larkFiles.length - afterKeys.size}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
