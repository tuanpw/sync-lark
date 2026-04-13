import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const LARK_API_BASE = 'https://open.larksuite.com';
const APP_ID = process.env.LARK_APP_ID ?? '';
const APP_SECRET = process.env.LARK_APP_SECRET ?? '';
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'http://localhost:9000';
const MINIO_ACCESS_KEY = process.env.MINIO_ROOT_USER ?? 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_ROOT_PASSWORD ?? 'minioadmin';
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'lark-import';
const FOLDER_TOKEN = 'LX7TfoIt0lpIkhd7uwfu1J8Eseb';
const TARGET_PREFIX = 'IT-DOCS';

const EXPORT_FORMATS: Record<string, string> = { docx: 'docx', doc: 'docx', sheet: 'xlsx', bitable: 'xlsx', slides: 'pdf' };

async function getToken() {
  const res = await fetch(`${LARK_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json() as any;
  return data.tenant_access_token;
}

async function listFolder(folderToken: string, token: string) {
  const items: any[] = [];
  let pageToken: string | null = null;
  do {
    const url = new URL(`${LARK_API_BASE}/open-apis/drive/v1/files`);
    url.searchParams.set('folder_token', folderToken);
    url.searchParams.set('page_size', '200');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json() as any;
    if (json.code !== 0) { console.error(`List failed: ${json.msg}`); return items; }
    for (const f of (json.data?.files ?? [])) items.push(f);
    pageToken = json.data?.has_more ? json.data.next_page_token : null;
  } while (pageToken);
  return items;
}

// Crawl all files from Lark
async function crawlAll(token: string) {
  const allItems: Array<{name: string; type: string; path: string; token: string}> = [];
  const queue = [{ token: FOLDER_TOKEN, path: '' }];
  let folderCount = 0;

  while (queue.length > 0) {
    const task = queue.shift()!;
    const children = await listFolder(task.token, token);
    folderCount++;
    for (const c of children) {
      const path = task.path ? `${task.path}/${c.name}` : c.name;
      if (c.type === 'folder') {
        queue.push({ token: c.token, path });
      } else {
        allItems.push({ name: c.name, type: c.type, path, token: c.token });
      }
    }
    if (folderCount % 30 === 0) console.log(`  Crawled ${folderCount} folders...`);
    // Small delay to avoid rate limit
    await new Promise(r => setTimeout(r, 200));
  }
  return { allItems, folderCount };
}

// List all MinIO keys
async function listMinioKeys() {
  const s3 = new S3Client({
    endpoint: MINIO_ENDPOINT, region: 'us-east-1',
    credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
    forcePathStyle: true,
  });
  const keys = new Set<string>();
  let ct: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: MINIO_BUCKET, Prefix: `${TARGET_PREFIX}/`, MaxKeys: 1000, ContinuationToken: ct }));
    for (const obj of (res.Contents ?? [])) if (obj.Key) keys.add(obj.Key);
    ct = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ct);
  return keys;
}

function buildKey(name: string, type: string, path: string): string {
  const ext = EXPORT_FORMATS[type];
  if (!ext) return `${TARGET_PREFIX}/${path}`;
  const hasExt = name.toLowerCase().endsWith(`.${ext}`);
  return `${TARGET_PREFIX}/${path}${hasExt ? '' : `.${ext}`}`;
}

async function main() {
  console.log('=== Comparing Lark vs MinIO ===\n');

  const token = await getToken();

  // Parallel: crawl Lark + list MinIO
  const [larkResult, minioKeys] = await Promise.all([
    crawlAll(token),
    listMinioKeys(),
  ]);

  console.log(`\nLark: ${larkResult.allItems.length} items in ${larkResult.folderCount} folders`);
  console.log(`MinIO: ${minioKeys.size} files\n`);

  // Find missing items
  const missing: Array<{path: string; type: string; key: string}> = [];
  const present: Array<{path: string; type: string}> = [];

  for (const item of larkResult.allItems) {
    const key = buildKey(item.name, item.type, item.path);
    if (minioKeys.has(key)) {
      present.push({ path: item.path, type: item.type });
    } else {
      missing.push({ path: item.path, type: item.type, key });
    }
  }

  console.log(`=== Present in MinIO: ${present.length} ===`);
  console.log(`=== MISSING from MinIO: ${missing.length} ===\n`);

  // Group missing by type
  const missingByType: Record<string, string[]> = {};
  for (const m of missing) {
    (missingByType[m.type] ??= []).push(m.path);
  }
  for (const [type, paths] of Object.entries(missingByType).sort()) {
    console.log(`[${type}] Missing ${paths.length}:`);
    for (const p of paths.slice(0, 10)) console.log(`  - ${p}`);
    if (paths.length > 10) console.log(`  ... and ${paths.length - 10} more`);
    console.log();
  }

  // Group missing by root folder
  console.log(`=== Missing by root folder ===`);
  const missingByRoot: Record<string, number> = {};
  for (const m of missing) {
    const root = m.path.split('/')[0];
    missingByRoot[root] = (missingByRoot[root] || 0) + 1;
  }
  for (const [root, count] of Object.entries(missingByRoot).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${root}: ${count} missing`);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
