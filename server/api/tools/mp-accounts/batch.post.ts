import { mpAccountBatchSchema, parseMpAccountInputs, parseOr400 } from '~/server/utils/mp-account-api';
import { upsertMpAccounts } from '~/server/utils/mp-account-registry';

export default defineEventHandler(async event => {
  const payload = parseOr400(mpAccountBatchSchema, (await readBody(event)) || {});
  const { valid, invalidItems } = parseMpAccountInputs(payload.accounts, 'api');
  const result = upsertMpAccounts(valid, { dryRun: payload.dryRun });
  return { ...result, invalid: invalidItems.length, invalidItems: invalidItems.slice(0, 100) };
});
