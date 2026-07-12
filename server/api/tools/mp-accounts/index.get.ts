import { z } from 'zod';
import { parseOr400 } from '~/server/utils/mp-account-api';
import { listMpAccounts } from '~/server/utils/mp-account-registry';

const booleanQuery = z.enum(['true', 'false']).transform(value => value === 'true');
const starredQuery = z.enum(['true', 'false', 'unknown']).transform(value => {
  if (value === 'unknown') return null;
  return value === 'true';
});
const querySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(500).optional(),
  search: z.string().optional(),
  enabled: booleanQuery.optional(),
  starred: starredQuery.optional(),
  minPriority: z.coerce.number().int().optional(),
});

export default defineEventHandler(event => {
  const query = parseOr400(querySchema, getQuery(event));
  return listMpAccounts(query);
});
