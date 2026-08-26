import { assertMpSyncAdmin } from '~/server/utils/mp-sync-admin-auth';
import { listSyncJobs } from '~/server/utils/mp-sync-job-registry';
export default defineEventHandler(event => {
  assertMpSyncAdmin(event);
  const query = getQuery(event);
  const status = typeof query.status === 'string' ? query.status : undefined;
  return { jobs: listSyncJobs({ status: status as never, limit: Number(query.limit) || 50 }) };
});
