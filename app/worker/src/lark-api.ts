const LARK_API_BASE = 'https://open.larksuite.com';

export type LarkFileEntry = {
  token: string;
  name: string;
  type: string;
  size: number;
  path: string;           // relative path preserving folder structure
  resolvedToken: string;  // target token after shortcut resolution
  resolvedType: string;   // target type after shortcut resolution
};

// Map Lark file types to export extension + MIME
const EXPORT_FORMAT: Record<string, { extension: string; mime: string }> = {
  doc: { extension: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  docx: { extension: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  sheet: { extension: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  bitable: { extension: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  slides: { extension: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  mindnote: { extension: 'pdf', mime: 'application/pdf' },
};

const NATIVE_TYPES = new Set(Object.keys(EXPORT_FORMAT));

// Token cache — auto-refresh before expiry
let cachedToken: { token: string; expiresAt: number } | null = null;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 min before expiry

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch(`${LARK_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = (await res.json()) as { code: number; msg: string; tenant_access_token: string; expire: number };
  if (data.code !== 0) throw new Error(`Lark auth failed: ${data.msg}`);
  // Cache with expiry (expire is in seconds)
  cachedToken = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  };
  console.log(`[lark-api] new tenant token, expires in ${data.expire ?? 7200}s`);
  return data.tenant_access_token;
}

export async function getAccessToken(): Promise<string> {
  // Return cached token if still valid
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return cachedToken.token;
  }

  // Prefer user token from backend (has access to user's own files)
  const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:3001/api';
  try {
    const res = await fetch(`${backendUrl}/auth/lark/access-token`);
    const data = (await res.json()) as { token: string | null };
    if (data.token) {
      return data.token;
    }
  } catch {
    // fall through to tenant token
  }

  // Fallback: tenant access token
  const appId = process.env.LARK_APP_ID ?? '';
  const appSecret = process.env.LARK_APP_SECRET ?? '';
  if (!appId || !appSecret) throw new Error('LARK_APP_ID and LARK_APP_SECRET are required');
  return getTenantAccessToken(appId, appSecret);
}

export async function listLarkFolderFiles(folderToken: string): Promise<LarkFileEntry[]> {
  const accessToken = await getAccessToken();
  const all: LarkFileEntry[] = [];
  let apiCalls = 0;

  async function listRecursive(token: string, pathPrefix: string) {
    let pageToken: string | null = null;

    do {
      // Rate-limit protection: pause briefly every 5 API calls
      if (apiCalls > 0 && apiCalls % 5 === 0) {
        await Bun.sleep(200);
      }
      apiCalls++;

      const url = new URL(`${LARK_API_BASE}/open-apis/drive/v1/files`);
      url.searchParams.set('folder_token', token);
      url.searchParams.set('page_size', '50');
      if (pageToken) url.searchParams.set('page_token', pageToken);

      const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${accessToken}` } });
      const data = (await res.json()) as {
        code: number; msg: string;
        data: {
          files: Array<{
            token: string; name: string; type: string; size?: number;
            shortcut_info?: { target_token: string; target_type: string };
          }>;
          has_more: boolean; next_page_token?: string;
        };
      };

      // Handle rate-limit (code 99991400 or HTTP 429)
      if (data.code === 99991400 || res.status === 429) {
        console.warn(`[lark-api] rate-limited at call #${apiCalls}, waiting 2s...`);
        await Bun.sleep(2000);
        continue; // retry same page
      }

      if (data.code !== 0) throw new Error(`Lark list files failed (code ${data.code}): ${data.msg}`);

      for (const f of data.data.files ?? []) {
        if (f.type === 'folder') {
          await listRecursive(f.token, `${pathPrefix}${f.name}/`);
          continue;
        }

        const resolvedToken = f.type === 'shortcut' ? (f.shortcut_info?.target_token ?? f.token) : f.token;
        const resolvedType = f.type === 'shortcut' ? (f.shortcut_info?.target_type ?? f.type) : f.type;
        const filePath = `${pathPrefix}${f.name}`;
        all.push({ token: f.token, name: f.name, type: f.type, size: f.size ?? 0, path: filePath, resolvedToken, resolvedType });
      }
      pageToken = data.data.has_more && data.data.next_page_token ? data.data.next_page_token : null;
    } while (pageToken);
  }

  await listRecursive(folderToken, '');
  console.log(`[lark-api] listed ${all.length} files across ${apiCalls} API calls`);
  return all;
}

export function getExportFormat(fileType: string): { extension: string; mime: string } | null {
  return EXPORT_FORMAT[fileType] ?? null;
}

export function isNativeType(fileType: string): boolean {
  return NATIVE_TYPES.has(fileType);
}

async function createExportTask(fileToken: string, fileType: string, extension: string, accessToken: string): Promise<string> {
  const res = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/export_tasks`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_extension: extension, token: fileToken, type: fileType }),
  });
  const data = (await res.json()) as { code: number; msg: string; data: { ticket: string } };
  if (data.code !== 0) throw new Error(`Lark export task failed: ${data.msg}`);
  return data.data.ticket;
}

async function pollExportTask(ticket: string, fileToken: string, accessToken: string): Promise<string> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const res = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/export_tasks/${ticket}?token=${fileToken}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = (await res.json()) as {
      code: number; msg: string;
      data: { result: { job_status: number; job_error_msg: string; file_token: string; file_name: string; file_size: number } };
    };
    if (data.code !== 0) throw new Error(`Lark export poll failed: ${data.msg}`);

    const { job_status, job_error_msg, file_token } = data.data.result;
    if (job_status === 0) return file_token; // success
    if (job_status >= 100) throw new Error(`Lark export failed: ${job_error_msg}`);

    await Bun.sleep(1000);
  }
  throw new Error('Lark export task timed out');
}

export async function downloadLarkFile(
  fileToken: string,
  fileType: string,
  resolvedToken?: string,
  resolvedType?: string,
): Promise<{ data: Uint8Array; fileName: string; mime: string }> {
  const dlToken = resolvedToken ?? fileToken;
  const dlType = resolvedType ?? fileType;

  // Always get fresh token (cached internally, auto-refreshes before expiry)
  const accessToken = await getAccessToken();

  if (isNativeType(dlType)) {
    // Native doc: export first
    const fmt = getExportFormat(dlType)!;
    const ticket = await createExportTask(dlToken, dlType, fmt.extension, accessToken);
    const exportedToken = await pollExportTask(ticket, dlToken, accessToken);

    const res = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/medias/${exportedToken}/download`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Lark download failed: ${res.status}`);

    const disposition = res.headers.get('content-disposition') ?? '';
    const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    const fileName = nameMatch ? decodeURIComponent(nameMatch[1]) : `export.${fmt.extension}`;

    return { data: new Uint8Array(await res.arrayBuffer()), fileName, mime: fmt.mime };
  } else {
    // Regular uploaded file in Drive — use /files/ endpoint (not /medias/)
    const res = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/files/${dlToken}/download`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      let body = '';
      try { body = await res.text(); } catch { /* ignore */ }
      // If token expired (99991663), force refresh and throw to trigger retry
      if (body.includes('99991663')) {
        cachedToken = null; // force refresh on next call
      }
      console.error(`[lark-api] download ${res.status} for token=${dlToken} type=${dlType}:`, body.slice(0, 300));
      throw new Error(`Lark download failed: ${res.status} — ${body.slice(0, 200)}`);
    }

    const disposition = res.headers.get('content-disposition') ?? '';
    const nameMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)/i);
    const fileName = nameMatch ? decodeURIComponent(nameMatch[1]) : dlToken;
    const mime = res.headers.get('content-type') ?? 'application/octet-stream';

    return { data: new Uint8Array(await res.arrayBuffer()), fileName, mime };
  }
}
