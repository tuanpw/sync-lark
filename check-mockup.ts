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

async function getToken() {
  const res = await fetch(`${LARK_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  return ((await res.json()) as any).tenant_access_token;
}

async function listFolder(folderToken: string, token: string) {
  const items: any[] = [];
  let pt: string | null = null;
  do {
    const url = new URL(`${LARK_API_BASE}/open-apis/drive/v1/files`);
    url.searchParams.set('folder_token', folderToken);
    url.searchParams.set('page_size', '200');
    if (pt) url.searchParams.set('page_token', pt);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json() as any;
    if (json.code !== 0) { console.error(`ERR ${folderToken}: (${json.code}) ${json.msg}`); return items; }
    for (const f of (json.data?.files ?? [])) items.push(f);
    pt = json.data?.has_more ? json.data.next_page_token : null;
  } while (pt);
  return items;
}

async function crawlAll(token: string) {
  const allItems: any[] = [];
  const allFolders: string[] = [];
  const queue = [{ token: FOLDER_TOKEN, path: '' }];
  const allTypes = new Set<string>();
  let scanned = 0;
  while (queue.length > 0) {
    const task = queue.shift()!;
    await new Promise(r => setTimeout(r, 100));
    const children = await listFolder(task.token, token);
    scanned++;
    for (const c of children) {
      const path = task.path ? `${task.path}/${c.name}` : c.name;
      allTypes.add(c.type);
      if (c.type === 'folder') {
        allFolders.push(path);
        queue.push({ token: c.token, path });
      } else {
        allItems.push({ name: c.name, type: c.type, path });
      }
    }
    if (scanned % 100 === 0) console.log(`  Crawled ${scanned} folders, ${allItems.length} items...`);
  }
  return { allItems, allFolders, allTypes, scanned };
}

async function listMinio() {
  const s3 = new S3Client({ endpoint: MINIO_ENDPOINT, region: 'us-east-1', credentials: { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY }, forcePathStyle: true });
  const keys = new Set<string>();
  const folders = new Set<string>();
  let ct: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: MINIO_BUCKET, Prefix: `${TARGET_PREFIX}/`, MaxKeys: 1000, ContinuationToken: ct }));
    for (const obj of (r.Contents ?? [])) {
      if (obj.Key) {
        keys.add(obj.Key);
        // Extract root folder
        const parts = obj.Key.replace(`${TARGET_PREFIX}/`, '').split('/');
        if (parts.length > 1) folders.add(parts[0]);
      }
    }
    ct = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ct);
  return { keys, folders };
}

async function main() {
  const token = await getToken();
  console.log('=== Mockup folder: Lark vs MinIO ===\n');
  const [lark, minio] = await Promise.all([crawlAll(token), listMinio()]);

  console.log(`\nAll types found: ${[...lark.allTypes].sort().join(', ')}`);
  console.log(`Lark: ${lark.scanned} folders scanned, ${lark.allFolders.length} subfolders, ${lark.allItems.length} items`);
  console.log(`MinIO: ${minio.keys.size} files, ${minio.folders.size} root folders\n`);

  // Type breakdown
  const byType: Record<string, number> = {};
  for (const i of lark.allItems) byType[i.type] = (byType[i.type] || 0) + 1;
  console.log('--- Lark items by type ---');
  for (const [t, n] of Object.entries(byType).sort()) console.log(`  ${t}: ${n}`);

  // Root folders comparison
  const larkRoots = [...new Set(lark.allFolders.map(f => f.split('/')[0]))].sort();
  console.log(`\nLark root folders (${larkRoots.length}):`);
  larkRoots.forEach((f, i) => console.log(`  ${i+1}. ${f}`));
  console.log(`\nMinIO root folders (${minio.folders.size}):`);
  [...minio.folders].sort().forEach((f, i) => console.log(`  ${i+1}. ${f}`));

  const missingRoots = larkRoots.filter(f => !minio.folders.has(f));
  if (missingRoots.length) {
    console.log(`\nMISSING root folders: ${missingRoots.join(', ')}`);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
