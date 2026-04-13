/**
 * Diagnostic script: test listing + downloading files from a specific Lark folder
 * Usage: bun run test-lark-download.ts
 */

const LARK_API_BASE = 'https://open.larksuite.com';
const APP_ID = process.env.LARK_APP_ID ?? '';
const APP_SECRET = process.env.LARK_APP_SECRET ?? '';
const FOLDER_TOKEN = 'ASfYf1dsOlHiIDd7IeXlOY29gld'; // from the shared link

async function getTenantToken(): Promise<string> {
  const res = await fetch(`${LARK_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await res.json() as any;
  console.log('[auth]', JSON.stringify(data, null, 2));
  if (data.code !== 0) throw new Error(`Auth failed: ${data.msg}`);
  return data.tenant_access_token;
}

async function listFiles(token: string) {
  const url = new URL(`${LARK_API_BASE}/open-apis/drive/v1/files`);
  url.searchParams.set('folder_token', FOLDER_TOKEN);
  url.searchParams.set('page_size', '50');

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json() as any;
  console.log('\n[list files] status:', res.status);
  console.log('[list files] response:', JSON.stringify(data, null, 2));
  return data.data?.files ?? [];
}

async function tryDownloadMedia(fileToken: string, accessToken: string, label: string) {
  console.log(`\n--- [${label}] Try /medias/${fileToken}/download ---`);
  const res = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/medias/${fileToken}/download`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  console.log(`  status: ${res.status}`);
  console.log(`  content-type: ${res.headers.get('content-type')}`);
  console.log(`  content-disposition: ${res.headers.get('content-disposition')}`);
  console.log(`  content-length: ${res.headers.get('content-length')}`);

  if (!res.ok) {
    const body = await res.text();
    console.log(`  ERROR body: ${body.slice(0, 500)}`);
    return false;
  }

  // Read a small chunk to verify it's actual file data
  const data = await res.arrayBuffer();
  const first16 = new Uint8Array(data.slice(0, 16));
  console.log(`  body size: ${data.byteLength} bytes`);
  console.log(`  first 16 bytes: [${Array.from(first16).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);

  // Check for common image magic bytes
  if (first16[0] === 0xFF && first16[1] === 0xD8) console.log('  -> JPEG detected');
  else if (first16[0] === 0x89 && first16[1] === 0x50) console.log('  -> PNG detected');
  else if (first16[0] === 0x47 && first16[1] === 0x49) console.log('  -> GIF detected');
  else if (first16[0] === 0x52 && first16[1] === 0x49) console.log('  -> WEBP/RIFF detected');
  else if (first16[0] === 0x7B) console.log('  -> JSON response (likely error)');
  else console.log('  -> Unknown format');

  return true;
}

async function tryDownloadFile(fileToken: string, accessToken: string, label: string) {
  // Alternative endpoint for Drive files
  console.log(`\n--- [${label}] Try /files/${fileToken}/download (alternative) ---`);
  const res = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/files/${fileToken}/download`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  console.log(`  status: ${res.status}`);
  console.log(`  content-type: ${res.headers.get('content-type')}`);
  console.log(`  content-disposition: ${res.headers.get('content-disposition')}`);

  if (!res.ok) {
    const body = await res.text();
    console.log(`  ERROR body: ${body.slice(0, 500)}`);
    return false;
  }

  const data = await res.arrayBuffer();
  const first16 = new Uint8Array(data.slice(0, 16));
  console.log(`  body size: ${data.byteLength} bytes`);
  console.log(`  first 16 bytes: [${Array.from(first16).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`);
  return true;
}

async function main() {
  console.log('=== Lark Download Diagnostic ===\n');

  if (!APP_ID || !APP_SECRET) {
    console.error('Set LARK_APP_ID and LARK_APP_SECRET env vars');
    process.exit(1);
  }

  const token = await getTenantToken();
  console.log('[auth] got tenant token:', token.slice(0, 10) + '...');

  const files = await listFiles(token);
  console.log(`\n[summary] Found ${files.length} files`);

  for (const f of files) {
    console.log(`\n========================================`);
    console.log(`File: ${f.name}`);
    console.log(`  token: ${f.token}`);
    console.log(`  type: ${f.type}`);
    console.log(`  size: ${f.size ?? 'unknown'}`);
    console.log(`========================================`);

    // Skip folders
    if (f.type === 'folder') {
      console.log('  (skipping folder)');
      continue;
    }

    // Skip native docs for this test
    const NATIVE = new Set(['doc', 'docx', 'sheet', 'bitable', 'slides', 'mindnote']);
    if (NATIVE.has(f.type)) {
      console.log('  (native doc — skipping for image test)');
      continue;
    }

    // Try both endpoints
    const mediaOk = await tryDownloadMedia(f.token, token, f.name);
    if (!mediaOk) {
      await tryDownloadFile(f.token, token, f.name);
    }
  }

  console.log('\n=== Done ===');
}

main().catch(console.error);
