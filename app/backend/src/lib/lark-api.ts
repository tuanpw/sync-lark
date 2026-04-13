const LARK_API_BASE = 'https://open.larksuite.com';

export type LarkFileEntry = {
  token: string;
  name: string;
  type: string;
  size: number;
};

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch(`${LARK_API_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });

  const data = (await res.json()) as { code: number; msg: string; tenant_access_token: string };

  if (data.code !== 0) {
    throw new Error(`Lark auth failed: ${data.msg}`);
  }

  return data.tenant_access_token;
}

async function listFolderPage(
  folderToken: string,
  accessToken: string,
  pageToken?: string,
): Promise<{ files: LarkFileEntry[]; nextPageToken: string | null }> {
  const url = new URL(`${LARK_API_BASE}/open-apis/drive/v1/files`);
  url.searchParams.set('folder_token', folderToken);
  url.searchParams.set('page_size', '50');
  if (pageToken) url.searchParams.set('page_token', pageToken);

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const data = (await res.json()) as {
    code: number;
    msg: string;
    data: {
      files: Array<{ token: string; name: string; type: string; size?: number }>;
      has_more: boolean;
      next_page_token?: string;
    };
  };

  // Handle rate-limit: retry after delay
  if (data.code === 99991400 || res.status === 429) {
    await new Promise(r => setTimeout(r, 2000));
    return listFolderPage(folderToken, accessToken, pageToken);
  }

  if (data.code !== 0) {
    throw new Error(`Lark list files failed (code ${data.code}): ${data.msg}`);
  }

  return {
    files: (data.data.files ?? []).map((f) => ({
      token: f.token,
      name: f.name,
      type: f.type,
      size: f.size ?? 0,
    })),
    nextPageToken: data.data.has_more && data.data.next_page_token ? data.data.next_page_token : null,
  };
}

export async function listLarkFolderFiles(folderToken: string): Promise<LarkFileEntry[]> {
  const appId = process.env.LARK_APP_ID;
  const appSecret = process.env.LARK_APP_SECRET;

  if (!appId || !appSecret) {
    throw new Error('LARK_APP_ID and LARK_APP_SECRET env vars are required');
  }

  const accessToken = await getTenantAccessToken(appId, appSecret);

  const all: LarkFileEntry[] = [];
  let apiCalls = 0;

  async function listRecursive(token: string, pathPrefix: string) {
    let pageToken: string | null = null;

    do {
      // Rate-limit protection: pause briefly every 5 API calls
      if (apiCalls > 0 && apiCalls % 5 === 0) {
        await new Promise(r => setTimeout(r, 200));
      }
      apiCalls++;

      const page = await listFolderPage(token, accessToken, pageToken ?? undefined);

      for (const f of page.files) {
        if (f.type === 'folder') {
          await listRecursive(f.token, `${pathPrefix}${f.name}/`);
        } else {
          all.push({ ...f, name: `${pathPrefix}${f.name}` });
        }
      }

      pageToken = page.nextPageToken;
    } while (pageToken);
  }

  await listRecursive(folderToken, '');
  return all;
}
