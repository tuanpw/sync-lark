import { Elysia } from 'elysia';
import { exchangeCode, getAuthUrl, getTokenStatus, getUserToken, clearToken } from '../lib/lark-oauth';

const LARK_API_BASE = 'https://open.larksuite.com';

async function probeLarkPermissions(token: string) {
  async function probe(name: string, fn: () => Promise<{ ok: boolean; detail?: string }>) {
    try {
      const result = await fn();
      return { name, granted: result.ok, detail: result.detail };
    } catch (e) {
      return { name, granted: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  // Test: list drive root
  const listRoot = probe('drive:drive (list files)', async () => {
    const r = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/files?folder_token=root&page_size=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = (await r.json()) as { code: number; msg?: string };
    return { ok: d.code === 0, detail: d.code !== 0 ? `code=${d.code} ${d.msg ?? ''}` : undefined };
  });

  // Test: download a file (pass a dummy token — 404 means auth OK, 403 means no permission)
  const downloadFile = probe('drive:file:readonly (download files)', async () => {
    const r = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/medias/__probe_token__/download`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    // 404 = auth fine, file not found — scope OK
    // 403 = forbidden — missing scope
    // 400 = bad token format — scope might be OK
    if (r.status === 403) return { ok: false, detail: 'HTTP 403 - scope not granted' };
    return { ok: true, detail: `HTTP ${r.status} (auth accepted)` };
  });

  // Test: export task (drive:export:readonly)
  const exportTask = probe('drive:export:readonly (export native docs)', async () => {
    const r = await fetch(`${LARK_API_BASE}/open-apis/drive/v1/export_tasks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_extension: 'docx', token: '__probe__', type: 'doc' }),
    });
    const d = (await r.json()) as { code: number; msg?: string };
    // 1069903 = file not found → auth OK
    // 403 / code=99991401 = no permission
    if (r.status === 403 || d.code === 99991401) return { ok: false, detail: `code=${d.code} ${d.msg ?? ''}` };
    return { ok: true, detail: `code=${d.code} (auth accepted)` };
  });

  // Test: get user info (authen scope)
  const userInfo = probe('user info (authen:userinfo:read)', async () => {
    const r = await fetch(`${LARK_API_BASE}/open-apis/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = (await r.json()) as { code: number; msg?: string; data?: { name?: string; email?: string } };
    return { ok: d.code === 0, detail: d.code === 0 ? `name=${d.data?.name}` : `code=${d.code} ${d.msg ?? ''}` };
  });

  return Promise.all([listRoot, downloadFile, exportTask, userInfo]);
}

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:3000';

export const authRoutes = new Elysia()
  // Return OAuth URL for frontend to redirect to
  .get('/auth/lark/url', ({ request }) => {
    const origin = request.headers.get('origin') ?? FRONTEND_URL;
    const redirectUri = `${new URL(request.url).origin}/api/auth/lark/callback`;
    return { url: getAuthUrl(redirectUri), redirectUri };
  })

  // Lark redirects here after user approves
  .get('/auth/lark/callback', async ({ query, request }) => {
    const code = query.code as string | undefined;
    const error = query.error as string | undefined;

    const origin = new URL(request.url).origin.replace(':3001', ':3000');

    if (error || !code) {
      return Response.redirect(`${origin}?auth=error&reason=${error ?? 'no_code'}`, 302);
    }

    try {
      await exchangeCode(code);
      return Response.redirect(`${origin}?auth=success`, 302);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      return Response.redirect(`${origin}?auth=error&reason=${encodeURIComponent(msg)}`, 302);
    }
  })

  // Status check
  .get('/auth/lark/status', () => getTokenStatus())

  // Worker calls this to get the best available token
  .get('/auth/lark/access-token', async () => {
    const token = await getUserToken();
    return { token };
  })

  // Check what permissions the current token actually has
  .get('/auth/lark/permissions', async () => {
    const token = await getUserToken();
    if (!token) return { connected: false, permissions: [] };

    const status = getTokenStatus() as { connected: boolean; scopes?: string[] };
    const permissions = await probeLarkPermissions(token);
    return {
      connected: true,
      grantedScopes: status.scopes ?? [],
      permissions,
    };
  })

  // Disconnect
  .post('/auth/lark/disconnect', () => {
    clearToken();
    return { ok: true };
  });
