import { createError } from 'h3';
import { z } from 'zod';
import type { MpAccountSource, MpAccountUpsertInput } from '~/server/utils/mp-account-registry';

/**
 * 用 zod schema 校验输入；失败时抛出 HTTP 400（而非让 ZodError 冒泡成 500）。
 * mp-accounts 各端点统一走此函数，保证「输入非法 → 400」的契约。
 */
export function parseOr400<T>(schema: z.ZodType<T>, data: unknown): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      statusMessage: parsed.error.issues.map(issue => issue.message).join('; '),
    });
  }
  return parsed.data;
}

const sourceSchema = z.enum(['browser_import', 'manual', 'api', 'auto_detect']);

export const mpAccountInputSchema = z.object({
  fakeid: z.string().trim().min(1).max(256),
  nickname: z.string().max(512).nullable().optional(),
  alias: z.string().max(512).nullable().optional(),
  avatar_url: z.string().max(4096).nullable().optional(),
  round_head_img: z.string().max(4096).nullable().optional(),
  enabled: z.boolean().optional(),
  priority: z.number().int().min(-100000).max(100000).optional(),
  starred: z.boolean().nullable().optional(),
  source: sourceSchema.optional(),
  reported_total_count: z.number().int().nonnegative().nullable().optional(),
  total_count: z.number().int().nonnegative().nullable().optional(),
  last_article_time: z.number().int().nonnegative().nullable().optional(),
  last_synced_at: z.string().datetime({ offset: true }).nullable().optional(),
  last_update_time: z.number().int().nonnegative().nullable().optional(),
});

export const mpAccountBatchSchema = z.object({
  accounts: z.array(z.unknown()).max(5000),
  dryRun: z.boolean().default(false),
});

export function parseMpAccountInputs(accounts: unknown[], defaultSource: MpAccountSource) {
  const valid: MpAccountUpsertInput[] = [];
  const invalidItems: Array<{ index: number; reason: string }> = [];
  accounts.forEach((account, index) => {
    const parsed = mpAccountInputSchema.safeParse(account);
    if (parsed.success) valid.push({ ...parsed.data, source: parsed.data.source ?? defaultSource });
    else invalidItems.push({ index, reason: parsed.error.issues.map(issue => issue.message).join('; ') });
  });
  return { valid, invalidItems };
}
