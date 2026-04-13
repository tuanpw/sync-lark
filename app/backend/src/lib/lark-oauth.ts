const LARK_API_BASE = 'https://open.larksuite.com';

type TokenEntry = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
  scopes: string[];  // granted OAuth scopes
};

// Lark OIDC endpoints use "message" field, other endpoints use "msg"
type OidcResponse = {
  code: number;
  msg?: string;
  message?: string;
  data?: { access_token: string; refresh_token: string; expires_in: number; token_type?: string; scope?: string };
  // Some Lark OIDC versions return flat (no data wrapper)
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

let stored: TokenEntry | null = null;

async function getAppAccessToken(): Promise<string> {
  const appId = process.env.LARK_APP_ID ?? '';
  const appSecret = process.env.LARK_APP_SECRET ?? '';
  const res = await fetch(`${LARK_API_BASE}/open-apis/auth/v3/app_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = (await res.json()) as { code: number; msg: string; app_access_token: string };
  if (data.code !== 0) throw new Error(`App access token failed: ${data.msg}`);
  return data.app_access_token;
}

function extractTokens(data: OidcResponse): { access_token: string; refresh_token: string; expires_in: number; scope: string } {
  // Nested under data
  if (data.data?.access_token) {
    return { access_token: data.data.access_token, refresh_token: data.data.refresh_token, expires_in: data.data.expires_in, scope: data.data.scope ?? '' };
  }
  // Flat response
  if (data.access_token) {
    return { access_token: data.access_token, refresh_token: data.refresh_token ?? '', expires_in: data.expires_in ?? 7200, scope: data.scope ?? '' };
  }
  throw new Error('Cannot extract tokens from response');
}

function errorMessage(data: OidcResponse): string {
  return data.message ?? data.msg ?? JSON.stringify(data);
}

export function getAuthUrl(redirectUri: string): string {
  const appId = process.env.LARK_APP_ID ?? '';
  const state = crypto.randomUUID();
  // User-level OAuth scopes for Drive access (colons must NOT be percent-encoded)
  const scope = 'drive:drive:readonly drive:drive';
  return `${LARK_API_BASE}/open-apis/authen/v1/authorize`
    + `?app_id=${encodeURIComponent(appId)}`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&scope=${scope.replace(/ /g, '%20')}`
    + `&state=${state}`;
}

export async function exchangeCode(code: string): Promise<void> {
  const appToken = await getAppAccessToken();
  const res = await fetch(`${LARK_API_BASE}/open-apis/authen/v1/oidc/access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${appToken}`,
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
  });

  const data = (await res.json()) as OidcResponse;
  console.log('[lark-oauth] exchange response code:', data.code, errorMessage(data));

  if (data.code !== 0) throw new Error(`OAuth exchange failed: ${errorMessage(data)}`);

  const tokens = extractTokens(data);
  stored = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
    scopes: tokens.scope ? tokens.scope.split(/[\s,]+/).filter(Boolean) : [],
  };

  console.log('[lark-oauth] user token stored, expires in', tokens.expires_in, 's, scopes:', stored.scopes);
}

async function refresh(): Promise<void> {
  if (!stored) return;

  const appToken = await getAppAccessToken();
  const res = await fetch(`${LARK_API_BASE}/open-apis/authen/v1/oidc/refresh_access_token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${appToken}`,
    },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: stored.refreshToken }),
  });

  const data = (await res.json()) as OidcResponse;
  console.log('[lark-oauth] refresh response code:', data.code, errorMessage(data));

  if (data.code !== 0) {
    stored = null;
    throw new Error(`OAuth refresh failed: ${errorMessage(data)}`);
  }

  const tokens = extractTokens(data);
  stored = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000 - 60_000,
    scopes: tokens.scope ? tokens.scope.split(/[\s,]+/).filter(Boolean) : (stored?.scopes ?? []),
  };

  console.log('[lark-oauth] token refreshed');
}

export async function getUserToken(): Promise<string | null> {
  if (!stored) return null;
  if (Date.now() >= stored.expiresAt) {
    try {
      await refresh();
    } catch {
      return null;
    }
  }
  return stored?.accessToken ?? null;
}

export function getTokenStatus() {
  if (!stored) return { connected: false };
  return {
    connected: true,
    expiresAt: new Date(stored.expiresAt).toISOString(),
    expired: Date.now() >= stored.expiresAt,
    scopes: stored.scopes,
  };
}

export function clearToken() {
  stored = null;
}
