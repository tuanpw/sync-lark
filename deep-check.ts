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
    if (json.code !== 0) { console.error(`List failed (${json.code}): ${json.msg} for ${folderToken}`); return items; }
    for (const f of (json.data?.files ?? [])) items.push(f);
    pageToken = json.data?.has_more ? json.data.next_page_token : null;
  } while (pageToken);
  return items;
}

async function crawlAll(token: string) {
  const allItems: Array<{name: string; type: string; path: string; rootFolder: string}> = [];
  const folders: Array<{name: string; path: string; rootFolder: string}> = [];
  const queue = [{ token: FOLDER_TOKEN, path: '', root: '(root)' }];
  const allTypes = new Set<string>();

  while (queue.length > 0) {
    const task = queue.shift()!;
    await new Promise(r => setTimeout(r, 150));
    const children = await listFolder(task.token, token);
    for (const c of children) {
      const path = task.path ? `${task.path}/${c.name}` : c.name;
      const root = task.root === '(root)' ? c.name : task.root;
      allTypes.add(c.type);
      if (c.type === 'folder') {
        folders.push({ name: c.name, path, rootFolder: root });
        queue.push({ token: c.token, path, root });
      } else {
        allItems.push({ name: c.name, type: c.type, path, rootFolder: root });
      }
    }
  }
  return { allItems, folders, allTypes };
}

async function listMinioRootFolders() {
  const s3 = new S3Client({
    endpoint: MINIO_ENDPOINT, region: 'us-east-1',
    credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY },
    forcePathStyle: true,
  });
  // List with delimiter to get "folders"
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: MINIO_BUCKET, Prefix: `${TARGET_PREFIX}/`, Delimiter: '/', MaxKeys: 1000,
  }));
  const folders = (res.CommonPrefixes ?? []).map(p => p.Prefix!.replace(`${TARGET_PREFIX}/`, '').replace(/\/$/, ''));

  // Also count total files
  let total = 0;
  let ct: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: MINIO_BUCKET, Prefix: `${TARGET_PREFIX}/`, MaxKeys: 1000, ContinuationToken: ct }));
    total += (r.Contents?.length ?? 0);
    ct = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ct);

  return { folders, total };
}

async function main() {
  const token = await getToken();
  console.log('=== Deep check: Lark vs MinIO ===\n');

  const [lark, minio] = await Promise.all([crawlAll(token), listMinioRootFolders()]);

  console.log(`--- ALL Lark types found: ${[...lark.allTypes].sort().join(', ')} ---\n`);

  // Lark root folders
  const larkRootFolders = [...new Set(lark.folders.filter(f => f.rootFolder === f.name).map(f => f.name))].sort();
  console.log(`LARK root folders (${larkRootFolders.length}):`);
  larkRootFolders.forEach((f, i) => console.log(`  ${i+1}. ${f}`));

  console.log(`\nMINIO root folders (${minio.folders.length}):`);
  minio.folders.sort().forEach((f, i) => console.log(`  ${i+1}. ${f}`));

  // Find missing root folders
  const minioSet = new Set(minio.folders);
  const missingRoots = larkRootFolders.filter(f => !minioSet.has(f));
  console.log(`\nMISSING root folders in MinIO (${missingRoots.length}):`);
  missingRoots.forEach(f => console.log(`  - ${f}`));

  // Items per root folder
  console.log(`\n--- Items per root folder ---`);
  const larkByRoot: Record<string, Record<string, number>> = {};
  for (const item of lark.allItems) {
    const root = item.rootFolder;
    larkByRoot[root] ??= {};
    larkByRoot[root][item.type] = (larkByRoot[root][item.type] || 0) + 1;
  }
  for (const [root, types] of Object.entries(larkByRoot).sort()) {
    const total = Object.values(types).reduce((a, b) => a + b, 0);
    const detail = Object.entries(types).sort().map(([t, n]) => `${t}:${n}`).join(' ');
    console.log(`  ${root}: ${total} items (${detail})`);
  }

  // Total counts
  const totalByType: Record<string, number> = {};
  for (const item of lark.allItems) {
    totalByType[item.type] = (totalByType[item.type] || 0) + 1;
  }
  console.log(`\n--- Total Lark items by type ---`);
  for (const [type, count] of Object.entries(totalByType).sort()) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`  TOTAL: ${lark.allItems.length} items + ${lark.folders.length} folders`);
  console.log(`\nMinIO total files: ${minio.total}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
