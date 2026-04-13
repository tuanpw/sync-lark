export type RequestAuditContext = {
  ip: string | null;
  forwardedFor: string | null;
  userAgent: string | null;
};

export function getClientIp(request: Request): string | null {
  const forwardedFor = request.headers.get('x-forwarded-for');
  const realIp = request.headers.get('x-real-ip');

  if (realIp) {
    return realIp;
  }

  if (forwardedFor) {
    return forwardedFor.split(',')[0]?.trim() ?? null;
  }

  return null;
}

export function getRequestContext(request: Request): RequestAuditContext {
  return {
    ip: getClientIp(request),
    forwardedFor: request.headers.get('x-forwarded-for'),
    userAgent: request.headers.get('user-agent'),
  };
}
