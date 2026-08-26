import { assertMpSyncAdmin } from '~/server/utils/mp-sync-admin-auth';
import { cancelPendingAccounts, finalizeJob, getSyncJob, requestCancel } from '~/server/utils/mp-sync-job-registry';
import { getMpSyncRouteId } from '~/server/utils/mp-sync-route';
export default defineEventHandler(event => {
  assertMpSyncAdmin(event);
  const id = getMpSyncRouteId(event);
  if (!getSyncJob(id)) throw createError({ statusCode: 404, statusMessage: 'sync job not found' });
  const requested = requestCancel(id);
  if (requested.status === 'queued') {
    cancelPendingAccounts(id);
    return { job: finalizeJob(id) };
  }
  return { job: requested };
});
