import { mpAccountBatchSchema, parseMpAccountInputs, parseOr400 } from '~/server/utils/mp-account-api';
import { createHash } from 'node:crypto';
import { exportMpAccounts, upsertMpAccounts } from '~/server/utils/mp-account-registry';

const LOCAL_BROWSER_ORIGINS = new Set([
  'http://127.0.0.1:3001',
  'http://localhost:3001',
  'http://127.0.0.1:3002',
  'http://localhost:3002',
]);

function applyLocalCors(event: any) {
  const origin = getRequestHeader(event, 'origin');
  if (origin && LOCAL_BROWSER_ORIGINS.has(origin)) {
    setResponseHeader(event, 'access-control-allow-origin', origin);
    setResponseHeader(event, 'vary', 'Origin');
  }
  setResponseHeader(event, 'access-control-allow-methods', 'POST, OPTIONS');
  setResponseHeader(event, 'access-control-allow-headers', 'content-type');
}

export default defineEventHandler(async event => {
  applyLocalCors(event);
  if (event.node.req.method === 'OPTIONS') {
    setResponseStatus(event, 204);
    return null;
  }
  const payload = parseOr400(mpAccountBatchSchema, (await readBody(event)) || {});
  const { valid, invalidItems } = parseMpAccountInputs(payload.accounts, 'browser_import');
  const existing = new Set(exportMpAccounts().map(account => account.fakeid));
  // 浏览器发现的新账号先进入 disabled，完成凭据与 canary 验证后再 admission，避免误触发全量联网。
  const admissionSafe = valid.map(account =>
    existing.has(account.fakeid) ? account : { ...account, enabled: false }
  );
  const result = upsertMpAccounts(admissionSafe, { dryRun: payload.dryRun });
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([...new Set(valid.map(account => account.fakeid))].sort()))
    .digest('hex');
  return {
    ...result,
    received: payload.accounts.length,
    valid: valid.length,
    unique: new Set(valid.map(account => account.fakeid)).size,
    fingerprint,
    invalid: invalidItems.length,
    invalidItems: invalidItems.slice(0, 100),
  };
});
