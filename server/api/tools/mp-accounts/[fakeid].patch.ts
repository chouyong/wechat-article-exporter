import { z } from 'zod';
import { parseOr400 } from '~/server/utils/mp-account-api';
import { patchMpAccount } from '~/server/utils/mp-account-registry';

const patchSchema = z
  .object({
    nickname: z.string().max(512).nullable().optional(),
    alias: z.string().max(512).nullable().optional(),
    avatar_url: z.string().max(4096).nullable().optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(-100000).max(100000).optional(),
    starred: z.boolean().nullable().optional(),
  })
  .refine(value => Object.keys(value).length > 0, { message: '至少提供一个可更新字段' });

export default defineEventHandler(async event => {
  const fakeid = (getRouterParam(event, 'fakeid') || '').trim();
  if (!fakeid) throw createError({ statusCode: 400, statusMessage: 'missing fakeid' });
  const patch = parseOr400(patchSchema, (await readBody(event)) || {});
  const account = patchMpAccount(fakeid, patch);
  if (!account) throw createError({ statusCode: 404, statusMessage: 'mp account not found' });
  return { ok: true, account };
});
