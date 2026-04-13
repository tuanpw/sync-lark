/**
 * Diagnostic: List ALL items in Lark folder tree (all types, not just 'file')
 */
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
  do {
    const url = new URL(`${LARK_API_BASE}/open-apis/drive/v1/files`);
    url.searchParams.set('folder_token', folderToken);
    url.searchParams.set('page_size', '200');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const json = await res.json() as any;
    if (json.code !== 0) throw new Error(`List failed (${json.code}): ${json.msg}`);
    for (const f of (json.data?.files ?? [])) {
      items.push({ token: f.token, name: f.name, type: f.type, size: f.size ?? 0 });
    }
    pageToken = json.data?.has_more ? json.data.next_page_token : null;
  } while (pageToken);
  return items;
}

type TreeItem = { token: string; name: string; type: string; size: number; path: string; children?: TreeItem[] };

async function buildTree(folderToken: string, token: string, path = ''): Promise<TreeItem[]> {
  const items = await listFolder(folderToken, token);
  const result: TreeItem[] = [];
  for (const item of items) {
    const fullPath = path ? `${path}/${item.name}` : item.name;
    const entry: TreeItem = { ...item, path: fullPath };
    if (item.type === 'folder') {
      entry.children = await buildTree(item.token, token, fullPath);
    }
    result.push(entry);
  }
  return result;
}

function printTree(items: TreeItem[], indent = 0) {
  for (const item of items) {
    const prefix = '  '.repeat(indent);
    const sizeStr = item.type !== 'folder' ? ` (${(item.size / 1024).toFixed(1)}KB)` : '';
    console.log(`${prefix}[${item.type}] ${item.name}${sizeStr}`);
    if (item.children) printTree(item.children, indent + 1);
  }
}

function countByType(items: TreeItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    counts[item.type] = (counts[item.type] || 0) + 1;
    if (item.children) {
      const sub = countByType(item.children);
      for (const [k, v] of Object.entries(sub)) counts[k] = (counts[k] || 0) + v;
    }
  }
  return counts;
}

async function main() {
  const token = await getToken();
  console.log('=== Scanning folder tree ===\n');
  const tree = await buildTree(FOLDER_TOKEN, token);
  printTree(tree);
  console.log('\n=== Summary ===');
  const counts = countByType(tree);
  for (const [type, count] of Object.entries(counts).sort()) {
    console.log(`  ${type}: ${count}`);
  }
  console.log(`  TOTAL: ${Object.values(counts).reduce((a, b) => a + b, 0)}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
