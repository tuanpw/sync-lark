import type { ParsedLarkFolderLink } from '@app/shared/types';

const ALLOWED_LARK_HOST_SUFFIXES = ['.larksuite.com', '.feishu.cn'];

function hasAllowedHostSuffix(hostname: string) {
  return ALLOWED_LARK_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

export function parseLarkFolderLink(sourceReference: string | null): ParsedLarkFolderLink | null {
  const trimmed = sourceReference?.trim();

  if (!trimmed) {
    return null;
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (!['https:', 'http:'].includes(url.protocol)) {
    return null;
  }

  if (!hasAllowedHostSuffix(url.hostname)) {
    return null;
  }

  const match = url.pathname.match(/^\/drive\/folder\/([A-Za-z0-9]+)\/?$/);

  if (!match) {
    return null;
  }

  return {
    workspaceDomain: url.hostname,
    resourceType: 'folder',
    folderToken: match[1],
    originalUrl: trimmed,
  };
}
