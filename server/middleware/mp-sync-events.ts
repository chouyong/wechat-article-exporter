import { assertMpSyncAdmin } from '~/server/utils/mp-sync-admin-auth';
import { getSyncJob, listJobAccounts } from '~/server/utils/mp-sync-job-registry';

const EVENTS_PATH = /^\/api\/tools\/mp-sync\/([A-Za-z0-9_-]{1,128})\/events\/?(?:\?.*)?$/;

/**
 * Nitro 某些 node-server 产物无法命中嵌套动态 API 路由；为事件轮询保留
 * 一个精确 middleware fallback。只匹配 GET + 固定路径，避免吞掉其它控制面路由。
 */
export default defineEventHandler(event => {
  if (event.node.req.method !== 'GET') return;
  const match = String(event.node.req.url || '').match(EVENTS_PATH);
  if (!match) return;

  assertMpSyncAdmin(event);
  const id = match[1];
  const job = getSyncJob(id);
  if (!job) throw createError({ statusCode: 404, statusMessage: 'sync job not found' });
  return {
    events: [{ seq: 0, type: 'snapshot', at: new Date().toISOString(), job, accounts: listJobAccounts(id) }],
  };
});
