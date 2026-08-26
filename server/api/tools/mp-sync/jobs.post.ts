import { z } from 'zod';
import { parseOr400 } from '~/server/utils/mp-account-api';
import { listMpAccounts } from '~/server/utils/mp-account-registry';
import { assertMpSyncAdmin } from '~/server/utils/mp-sync-admin-auth';
import { createSyncJob, getSyncJob } from '~/server/utils/mp-sync-job-registry';
import { startMpSyncJob } from '~/server/utils/mp-sync-production';

const schema = z.object({
  idempotencyKey: z.string().min(1).max(200).optional(),
  fakeids: z.array(z.string().min(1)).max(500).optional(),
  dryRun: z.boolean().optional(),
});
export default defineEventHandler(async event => {
  assertMpSyncAdmin(event);
  const body = parseOr400(schema, (await readBody(event)) || {});
  const authKey = getRequestHeader(event, 'x-auth-key') || getCookie(event, 'auth-key');
  if (!authKey) throw createError({ statusCode: 401, statusMessage: 'auth-key required' });
  const rows = listMpAccounts({ enabled: true, page: 1, pageSize: 500 }).items;
  const selected = body.fakeids ? rows.filter(a => body.fakeids!.includes(a.fakeid)) : rows;
  const job = createSyncJob({
    mode: 'incremental',
    idempotencyKey: body.idempotencyKey,
    accounts: selected.map(a => ({ fakeid: a.fakeid, priority: a.priority, sinceTime: a.last_article_time ?? 0 })),
  });
  if (body.dryRun) return { job, dryRun: true, selected: selected.length };
  if (getSyncJob(job.id)?.status === 'queued')
    void startMpSyncJob(job.id, authKey).catch(error => console.error('mp sync job failed', error));
  return { job, dryRun: false, selected: selected.length };
});
