import { assertMpSyncAdmin } from '~/server/utils/mp-sync-admin-auth';
import { getSyncJob } from '~/server/utils/mp-sync-job-registry';
import { retryFailedJob } from '~/server/utils/mp-sync-runner';
import { getMpSyncRouteId } from '~/server/utils/mp-sync-route';
export default defineEventHandler(async event => {
  assertMpSyncAdmin(event);
  const id = getMpSyncRouteId(event);
  if (!getSyncJob(id)) throw createError({ statusCode: 404, statusMessage: 'sync job not found' });
  const authKey = getRequestHeader(event, 'x-auth-key') || getCookie(event, 'auth-key');
  if (!authKey) throw createError({ statusCode: 401, statusMessage: 'auth-key required' });
  const result = await retryFailedJob(id, {
    fetchPage: (await import('~/server/utils/mp-appmsgpublish-fetcher')).createAppmsgpublishPageFetcher({ authKey }),
    retry: { maxAttempts: 3 },
    timeoutMs: 30000,
  });
  return result;
});
