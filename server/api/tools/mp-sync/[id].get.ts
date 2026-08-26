import { assertMpSyncAdmin } from '~/server/utils/mp-sync-admin-auth';
import { getSyncJob, listJobAccounts } from '~/server/utils/mp-sync-job-registry';
import { getMpSyncRouteId } from '~/server/utils/mp-sync-route';
export default defineEventHandler(event => {
  assertMpSyncAdmin(event);
  const id = getMpSyncRouteId(event);
  const job = getSyncJob(id);
  if (!job) throw createError({ statusCode: 404, statusMessage: 'sync job not found' });
  return { job, accounts: listJobAccounts(id) };
});
