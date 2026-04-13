import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const LARK_API_BASE = 'https://open.larksuite.com';
const APP_ID = process.env.LARK_APP_ID ?? '';
const APP_SECRET = process.env.LARK_APP_SECRET ?? '';
const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT ?? 'http://localhost:9000';
const MINIO_ACCESS_KEY = process.env.MINIO_ROOT_USER ?? 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_ROOT_PASSWORD ?? 'minioadmin';
const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'lark-import';
const FOLDER_TOKEN = 'KU5Bfaa8QlVCqXdtkxvunrojsz5';
const TARGET_PREFIX = 'Mockup';
const EXPORT_FORMATS: Record<string, string> = { docx: 'docx', doc: 'docx', sheet: 'xlsx', bitable: 'xlsx', slides: 'pdf' };
const SYNCABLE = new Set(['file', ...Object.keys(EXPORT_FORMATS)]);

async function getToken() {
  const r = await fetch(`${LARK_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  return ((await r.json()) as any).tenant_access_token;
}

async function listFolder(ft: string, tk: string) {
  const items: any[] = [];
  let pt: string | null = null;
  do {
    const url = new URL(`${LARK_API_BASE}/open-apis/drive/v1/files`);
    url.searchParams.set('folder_token', ft);
    url.searchParams.set('page_size', '200');
    if (pt) url.searchParams.set('page_token', pt);
    const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${tk}` } });
    const j = await r.json() as any;
    if (j.code === 99991400) { await new Promise(r => setTimeout(r, 3000)); continue; }
    if (j.code !== 0) { console.error(`ERR ${ft}: ${j.msg}`); return items; }
    for (const f of (j.data?.files ?? [])) items.push(f);
    pt = j.data?.has_more ? j.data.next_page_token : null;
  } while (pt);
  return items;
}

async function crawl(tk: string) {
  const all: Array<{name: string; type: string; path: string}> = [];
  const q = [{ token: FOLDER_TOKEN, path: '' }];
  let sc = 0;
  while (q.length > 0) {
    const t = q.shift()!;
    await new Promise(r => setTimeout(r, 120));
    const ch = await listFolder(t.token, tk);
    sc++;
    for (const c of ch) {
      const p = t.path ? `${t.path}/${c.name}` : c.name;
      if (c.type === 'folder') q.push({ token: c.token, path: p });
      else if (SYNCABLE.has(c.type)) all.push({ name: c.name, type: c.type, path: p });
    }
    if (sc % 200 === 0) console.log(`  crawled ${sc} folders, ${all.length} items, ${q.length} queued...`);
  }
  return { items: all, folders: sc };
}

function buildKey(name: string, type: string, path: string) {
  const ext = EXPORT_FORMATS[type];
  if (!ext) return `${TARGET_PREFIX}/${path}`;
  return `${TARGET_PREFIX}/${path}${name.toLowerCase().endsWith(`.${ext}`) ? '' : `.${ext}`}`;
}

async function getMinioKeys() {
  const s3 = new S3Client({ endpoint: MINIO_ENDPOINT, region: 'us-east-1', credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY }, forcePathStyle: true });
  const keys = new Set<string>();
  let ct: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: MINIO_BUCKET, Prefix: `${TARGET_PREFIX}/`, MaxKeys: 1000, ContinuationToken: ct }));
    for (const o of (r.Contents ?? [])) if (o.Key) keys.add(o.Key);
    ct = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ct);
  return keys;
}

async function main() {
  console.log('Scanning Lark + MinIO...\n');
  const tk = await getToken();
  const [lark, minio] = await Promise.all([crawl(tk), getMinioKeys()]);

  let present = 0, missing = 0;
  const missingByType: Record<string, number> = {};
  const presentByType: Record<string, number> = {};
  const missingByRoot: Record<string, number> = {};

  for (const item of lark.items) {
    const key = buildKey(item.name, item.type, item.path);
    if (minio.has(key)) {
      present++;
      presentByType[item.type] = (presentByType[item.type] || 0) + 1;
    } else {
      missing++;
      missingByType[item.type] = (missingByType[item.type] || 0) + 1;
      const root = item.path.split('/')[0];
      missingByRoot[root] = (missingByRoot[root] || 0) + 1;
    }
  }

  console.log(`\n========== SYNC STATUS ==========`);
  console.log(`Lark total: ${lark.items.length} items in ${lark.folders} folders`);
  console.log(`MinIO total: ${minio.size} files`);
  console.log(`\nMatched (already synced): ${present}`);
  console.log(`Missing (need to sync):  ${missing}`);
  console.log(`Coverage: ${(present / lark.items.length * 100).toFixed(1)}%`);

  console.log(`\n--- Already synced by type ---`);
  for (const [t, n] of Object.entries(presentByType).sort()) console.log(`  ${t}: ${n}`);

  console.log(`\n--- Missing by type ---`);
  for (const [t, n] of Object.entries(missingByType).sort()) console.log(`  ${t}: ${n}`);

  // Top 20 missing root folders
  const sorted = Object.entries(missingByRoot).sort((a, b) => b[1] - a[1]);
  console.log(`\n--- Top 30 missing root folders ---`);
  for (const [root, count] of sorted.slice(0, 30)) console.log(`  ${root}: ${count} missing`);
  if (sorted.length > 30) console.log(`  ... and ${sorted.length - 30} more folders with missing files`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
