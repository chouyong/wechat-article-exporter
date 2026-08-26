import { timingSafeEqual } from 'node:crypto';
import type { H3Event } from 'h3';

function equalSecret(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function isMpSyncAdminAuthorized(expected: string | undefined, supplied: string | undefined): boolean {
  const normalizedExpected = expected?.trim() || '';
  const normalizedSupplied = supplied?.trim() || '';
  return !!normalizedExpected && !!normalizedSupplied && equalSecret(normalizedSupplied, normalizedExpected);
}

/** 控制面默认拒绝开放；生产必须显式配置 MP_SYNC_ADMIN_TOKEN。 */
export function assertMpSyncAdmin(event: H3Event) {
  const expected = process.env.MP_SYNC_ADMIN_TOKEN;
  const supplied = getRequestHeader(event, 'x-mp-sync-admin-token');
  if (!isMpSyncAdminAuthorized(expected, supplied)) {
    throw createError({ statusCode: 503, statusMessage: 'mp sync control plane is not configured' });
  }
}
