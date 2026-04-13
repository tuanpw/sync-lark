const LARK_API_BASE = 'https://open.larksuite.com';
const APP_ID = process.env.LARK_APP_ID ?? '';
const APP_SECRET = process.env.LARK_APP_SECRET ?? '';
const FOLDER_TOKEN = 'LX7TfoIt0lpIkhd7uwfu1J8Eseb';

async function getToken() {
  const res = await fetch(`${LARK_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json() as any;
  if (data.code !== 0) throw new Error(`Auth failed: ${data.msg}`);
  return data.tenant_access_token;
}

async function listFolder(folderToken: string, token: string) {
  const items: any[] = [];
  let pageToken: string | null = null;
  let pageNum = 0;
  do {
    pageNum++;
    const url = new URL(`${LARK_API_BASE}/open-apis/drive/v1/files`);
    url.searchParams.set('folder_token', folderToken);
    url.searchParams.set('page_size', '200');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json() as any;
    console.log(`Page ${pageNum}: code=${json.code}, has_more=${json.data?.has_more}, files_count=${json.data?.files?.length ?? 0}`);
    if (json.code !== 0) throw new Error(`List failed (${json.code}): ${json.msg}`);
    for (const f of (json.data?.files ?? [])) {
      items.push(f);
    }
    pageToken = json.data?.has_more ? json.data.next_page_token : null;
  } while (pageToken);
  return items;
}

async function main() {
  const token = await getToken();
  console.log(`\n=== Root folder: ${FOLDER_TOKEN} ===\n`);
  const items = await listFolder(FOLDER_TOKEN, token);
  
  console.log(`\n--- ALL root-level items (${items.length} total) ---\n`);
  
  const folders = items.filter((i: any) => i.type === 'folder');
  const nonFolders = items.filter((i: any) => i.type !== 'folder');
  
  console.log(`FOLDERS (${folders.length}):`);
  folders.forEach((f: any, idx: number) => {
    console.log(`  ${idx + 1}. ${f.name} [token=${f.token}]`);
  });
  
  console.log(`\nFILES/DOCS (${nonFolders.length}):`);
  nonFolders.forEach((f: any, idx: number) => {
    console.log(`  ${idx + 1}. [${f.type}] ${f.name}`);
  });
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
